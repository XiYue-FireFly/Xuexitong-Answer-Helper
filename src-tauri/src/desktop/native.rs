use crate::{desktop::state::DesktopState, pending};
use serde_json::Value;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{Manager, Webview};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, oneshot},
    time::Instant,
};
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CapturePreviewCompletedHandler};
use windows::Win32::{Foundation::HGLOBAL, System::Com::StructuredStorage::CreateStreamOnHGlobal};
use windows::core::HSTRING;

const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);

/// FIFO asynchronous admission shared by live glass and image capture. The
/// permit belongs to the native callback, rather than its awaiting consumer.
pub struct CaptureGate {
    semaphore: Arc<Semaphore>,
}

impl Default for CaptureGate {
    fn default() -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(1)),
        }
    }
}
impl CaptureGate {
    pub fn new() -> Self {
        Self::default()
    }

    async fn acquire(&self, operation: &CaptureOperation) -> Result<OwnedSemaphorePermit, String> {
        operation.check()?;
        let permit = tokio::time::timeout_at(
            operation.deadline,
            Arc::clone(&self.semaphore).acquire_owned(),
        )
        .await
        .map_err(|_| {
            "Native capture timed out while waiting for the previous callback".to_string()
        })?
        .map_err(|_| "Native capture queue is unavailable".to_string())?;
        operation.check()?;
        Ok(permit)
    }
}

#[derive(Clone)]
struct CaptureOperation {
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
}

impl CaptureOperation {
    fn new(timeout: Duration) -> Self {
        Self {
            deadline: Instant::now() + timeout,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            return Err("Native capture was cancelled or expired before dispatch".into());
        }
        Ok(())
    }
}

/// Dropping a queued/awaiting png future cancels dispatch but never drops the
/// permit already handed to WebView2. Only its callback/destruction can do that.
struct CaptureWaiter(CaptureOperation);
impl Drop for CaptureWaiter {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::Release);
    }
}

async fn capture_reply<T>(
    receiver: oneshot::Receiver<Result<T, String>>,
    operation: &CaptureOperation,
) -> Result<T, String> {
    tokio::time::timeout_at(operation.deadline, receiver)
        .await
        .map_err(|_| "Native capture callback timed out".to_string())?
        .map_err(|_| "Native capture was cancelled".to_string())?
}

pub async fn cdp(view: &Webview, method: &str, params: Value) -> Result<(), String> {
    let (reply, receiver) = pending::channel();
    let method = HSTRING::from(method);
    let params = HSTRING::from(params.to_string());
    view.with_webview(move |platform| {
        let failure = Arc::clone(&reply);
        let result = (|| -> windows::core::Result<()> {
            unsafe {
                let core = platform.controller().CoreWebView2()?;
                let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |status, _| {
                        pending::send(&reply, status.map_err(|e| e.to_string()));
                        Ok(())
                    },
                ));
                core.CallDevToolsProtocolMethod(&method, &params, &callback)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            pending::send(&failure, Err(error.to_string()));
        }
    })
    .map_err(|e| e.to_string())?;
    pending::receive(receiver).await
}
pub async fn key_event(view: &Webview, id: u32, generation: u64, down: bool) -> Result<(), String> {
    let operation = crate::pending::Operation::new();
    let guard = operation.clone();
    let target = view.clone();
    let (reply, receiver) = pending::channel();
    view.with_webview(move|platform|{let failure=Arc::clone(&reply);let result=(||->Result<(),String>{
        guard.check()?;let state=target.state::<DesktopState>();let guest=state.get(id)?;
        if guest.snapshot.document_generation!=generation{return Err("网页文档已改变，已拒绝发送按键。".into());}
        unsafe{
            let hwnd=windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow();let mut pid=0;windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd,Some(&mut pid));
            if pid!=std::process::id(){return Err("应用不在前台，已拒绝全局按键。".into());}
            let core=platform.controller().CoreWebView2().map_err(|e|e.to_string())?;
            let mut payload=serde_json::json!({"type":if down{"keyDown"}else{"keyUp"},"key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"nativeVirtualKeyCode":13});if down{payload["text"]="\r".into();payload["unmodifiedText"]="\r".into();}
            let callback=CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move|status,_|{pending::send(&reply,status.map_err(|e|e.to_string()));Ok(())}));
            guard.check()?;core.CallDevToolsProtocolMethod(&HSTRING::from("Input.dispatchKeyEvent"),&HSTRING::from(payload.to_string()),&callback).map_err(|e|e.to_string())?;
        }Ok(())})();if let Err(error)=result{pending::send(&failure,Err(error));}}).map_err(|e|e.to_string())?;
    pending::receive_guarded(receiver, operation).await
}
pub async fn script(view: &Webview, code: String) -> Result<Value, String> {
    let (reply, receiver) = pending::channel();
    view.eval_with_callback(code, move |value| {
        pending::send(
            &reply,
            serde_json::from_str(&value).map_err(|e| e.to_string()),
        )
    })
    .map_err(|e| e.to_string())?;
    pending::receive(receiver).await
}
pub async fn png(view: &Webview) -> Result<Vec<u8>, String> {
    let state = view.state::<DesktopState>();
    let operation = CaptureOperation::new(CAPTURE_TIMEOUT);
    let _waiter = CaptureWaiter(operation.clone());
    let permit = state.capture_gate.acquire(&operation).await?;
    let dispatch = operation.clone();
    let (reply, receiver) = pending::channel();
    view.with_webview(move |platform| {
        let failure = Arc::clone(&reply);
        let result = (|| -> Result<(), String> {
            dispatch.check()?;
            unsafe {
                let core = platform
                    .controller()
                    .CoreWebView2()
                    .map_err(|error| error.to_string())?;
                let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)
                    .map_err(|error| error.to_string())?;
                let retained = stream.clone();
                let callback = CapturePreviewCompletedHandler::create(Box::new(move |status| {
                    let _permit = permit;
                    let result = status
                        .and_then(|()| crate::capture::read_png(&retained))
                        .map_err(|e| e.to_string());
                    pending::send(&reply, result);
                    Ok(())
                }));
                // with_webview may wait in the GUI queue after the consumer
                // timed out. Expired requests must not start a late capture.
                dispatch.check()?;
                core.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,
                    &callback,
                )
                .map_err(|error| error.to_string())?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            pending::send(&failure, Err(error));
        }
    })
    .map_err(|e| e.to_string())?;
    capture_reply(receiver, &operation).await
}
pub async fn focus(view: &Webview) -> Result<(), String> {
    view.set_focus().map_err(|e| e.to_string())
}
pub fn refresh_history(view: &Webview, id: u32) -> Result<(), String> {
    let app = view.app_handle().clone();
    view.with_webview(move |platform| unsafe {
        if let Ok(core) = platform.controller().CoreWebView2() {
            let mut back = windows::core::BOOL::default();
            let mut forward = windows::core::BOOL::default();
            if core.CanGoBack(&mut back).is_ok() && core.CanGoForward(&mut forward).is_ok() {
                let state = app.state::<DesktopState>();
                let current = {
                    let Ok(mut registry) = state.registry.lock() else {
                        return;
                    };
                    let Some(guest) = registry.guests.get_mut(&id) else {
                        return;
                    };
                    guest.snapshot.can_go_back = back.as_bool();
                    guest.snapshot.can_go_forward = forward.as_bool();
                    guest.clone()
                };
                super::browser::emit(
                    &app,
                    &current,
                    "page-title-updated",
                    serde_json::json!({"title":current.snapshot.title}),
                );
            }
        }
    })
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{CaptureGate, CaptureOperation, CaptureWaiter, capture_reply};
    use std::{
        future::{Future, poll_fn},
        pin::Pin,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        task::Poll,
        time::Duration,
    };
    use tokio::sync::oneshot;

    async fn assert_queued<F: Future>(mut future: Pin<&mut F>) {
        poll_fn(|context| {
            assert!(
                future.as_mut().poll(context).is_pending(),
                "capture must wait asynchronously for its native predecessor"
            );
            Poll::Ready(())
        })
        .await;
    }

    #[test]
    fn concurrent_glass_and_media_captures_wait_in_fifo_order() -> Result<(), String> {
        tauri::async_runtime::block_on(async {
            let gate = CaptureGate::new();
            let first_operation = CaptureOperation::new(Duration::from_secs(5));
            let first_callback = gate.acquire(&first_operation).await?;
            let second_operation = CaptureOperation::new(Duration::from_secs(5));
            let third_operation = CaptureOperation::new(Duration::from_secs(5));
            let mut media = Box::pin(gate.acquire(&second_operation));
            let mut next_glass = Box::pin(gate.acquire(&third_operation));
            assert_queued(media.as_mut()).await;
            assert_queued(next_glass.as_mut()).await;
            drop(first_callback);
            let media_callback = media.await?;
            assert_queued(next_glass.as_mut()).await;
            drop(media_callback);
            let last_callback = next_glass.await?;
            assert_eq!(gate.semaphore.available_permits(), 0);
            drop(last_callback);
            assert_eq!(gate.semaphore.available_permits(), 1);
            Ok(())
        })
    }

    #[test]
    fn cancelling_a_queued_waiter_does_not_block_or_open_an_active_capture() -> Result<(), String> {
        tauri::async_runtime::block_on(async {
            let gate = CaptureGate::new();
            let active_operation = CaptureOperation::new(Duration::from_secs(5));
            let active_callback = gate.acquire(&active_operation).await?;
            let cancelled_operation = CaptureOperation::new(Duration::from_secs(5));
            let cancellation = CaptureWaiter(cancelled_operation.clone());
            let mut cancelled = Box::pin(gate.acquire(&cancelled_operation));
            assert_queued(cancelled.as_mut()).await;
            let following_operation = CaptureOperation::new(Duration::from_secs(5));
            let mut following = Box::pin(gate.acquire(&following_operation));
            assert_queued(following.as_mut()).await;
            drop(cancelled);
            drop(cancellation);
            assert!(cancelled_operation.check().is_err());
            assert_eq!(gate.semaphore.available_permits(), 0);
            assert_queued(following.as_mut()).await;
            drop(active_callback);
            drop(following.await?);
            assert_eq!(gate.semaphore.available_permits(), 1);
            Ok(())
        })
    }

    #[test]
    fn consumer_timeout_keeps_the_gate_closed_until_the_real_callback_finishes()
    -> Result<(), String> {
        tauri::async_runtime::block_on(async {
            let gate = CaptureGate::new();
            let operation = CaptureOperation::new(Duration::from_millis(20));
            let waiter = CaptureWaiter(operation.clone());
            let permit = gate.acquire(&operation).await?;
            let (sender, receiver) = oneshot::channel::<Result<Vec<u8>, String>>();
            let callback = move || {
                let _permit = permit;
                let _ = sender.send(Ok(vec![1, 2, 3]));
            };
            assert!(capture_reply(receiver, &operation).await.is_err());
            drop(waiter);
            let next_operation = CaptureOperation::new(Duration::from_secs(5));
            let mut next = Box::pin(gate.acquire(&next_operation));
            assert_queued(next.as_mut()).await;
            assert_eq!(gate.semaphore.available_permits(), 0);
            callback();
            drop(next.await?);
            assert_eq!(gate.semaphore.available_permits(), 1);
            Ok(())
        })
    }

    #[test]
    fn cancelled_gui_dispatch_and_failed_callback_cleanup_release_their_permits()
    -> Result<(), String> {
        tauri::async_runtime::block_on(async {
            let gate = CaptureGate::new();
            let operation = CaptureOperation::new(Duration::from_secs(5));
            let waiter = CaptureWaiter(operation.clone());
            let permit = gate.acquire(&operation).await?;
            let started = Arc::new(AtomicBool::new(false));
            let observed = Arc::clone(&started);
            let dispatch = move || {
                let _permit = permit;
                operation.check()?;
                observed.store(true, Ordering::Release);
                Ok::<(), String>(())
            };
            drop(waiter);
            assert!(dispatch().is_err());
            assert!(!started.load(Ordering::Acquire));
            let next_operation = CaptureOperation::new(Duration::from_secs(5));
            let native_permit = gate.acquire(&next_operation).await?;
            // The same cleanup runs when native setup/CapturePreview fails and
            // releases its callback without invoking it.
            let abandoned_callback = move || {
                drop(native_permit);
            };
            assert_eq!(gate.semaphore.available_permits(), 0);
            drop(abandoned_callback);
            assert_eq!(gate.semaphore.available_permits(), 1);
            Ok(())
        })
    }
}
