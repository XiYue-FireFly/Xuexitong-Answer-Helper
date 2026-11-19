use crate::{
    pending::{self, Operation, Permit},
    state::PocState,
};
use std::sync::{Arc, atomic::AtomicBool};
use tauri::{Manager, WebviewWindow};
use webview2_com::{
    CallDevToolsProtocolMethodCompletedHandler,
    Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
};
use windows::core::{HSTRING, w};

const KEY_DOWN: &str = r#"{"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"nativeVirtualKeyCode":13,"text":"\r","unmodifiedText":"\r"}"#;
const KEY_UP: &str = r#"{"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"nativeVirtualKeyCode":13}"#;

/// CDP targets this guest's browser input pipeline. It never injects OS-wide keys.
pub async fn send_enter(
    guest: &WebviewWindow,
    busy: &Arc<AtomicBool>,
    expected_generation: u64,
) -> Result<(), String> {
    let permit = Permit::acquire(busy)?;
    let operation = Operation::new();
    let dispatch_operation = operation.clone();
    let native_guest = guest.clone();
    let (reply, receiver) = pending::channel();
    guest
        .with_webview(move |platform| {
            let on_error = Arc::clone(&reply);
            let result = (|| -> Result<(), String> {
                // This closure can sit in the main-thread queue beyond the
                // consumer's timeout. Validate where the side effect starts.
                dispatch_operation.check()?;
                let state = native_guest.state::<PocState>();
                state.check_generation("guest", expected_generation)?;
                if !state
                    .fixture
                    .allows(&native_guest.url().map_err(|error| error.to_string())?)
                {
                    return Err("Guest left the fixed POC fixture URL".into());
                }
                unsafe {
                    let core = platform
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| error.to_string())?;
                    let key_up_core = core.clone();
                    let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                        move |status, _| {
                            let down_error = status
                                .err()
                                .map(|error| format!("Guest keyDown failed: {error}"));
                            let immediate = Arc::clone(&reply);
                            let key_up = CallDevToolsProtocolMethodCompletedHandler::create(
                                Box::new(move |status, _| {
                                    let _permit = permit;
                                    let result = status
                                        .map_err(|error| format!("Guest keyUp failed: {error}"))
                                        .and(match down_error {
                                            Some(error) => Err(error),
                                            None => Ok(()),
                                        });
                                    pending::send(&reply, result);
                                    Ok(())
                                }),
                            );
                            // Once keyDown was submitted, keyUp is cleanup and
                            // MUST run even after timeout/cancellation/navigation.
                            if let Err(error) = key_up_core.CallDevToolsProtocolMethod(
                                w!("Input.dispatchKeyEvent"),
                                &HSTRING::from(KEY_UP),
                                &key_up,
                            ) {
                                pending::send(
                                    &immediate,
                                    Err(format!("Could not dispatch guest keyUp: {error}")),
                                );
                            }
                            Ok(())
                        },
                    ));
                    dispatch_operation.check()?;
                    state.check_generation("guest", expected_generation)?;
                    core.CallDevToolsProtocolMethod(
                        w!("Input.dispatchKeyEvent"),
                        &HSTRING::from(KEY_DOWN),
                        &callback,
                    )
                    .map_err(|error| error.to_string())?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                pending::send(&on_error, Err(error));
            }
        })
        .map_err(|e| e.to_string())?;
    pending::receive_guarded(receiver, operation).await
}

/// Only the explicit user-facing focus button borrows native focus.
pub async fn focus_guest(guest: &WebviewWindow) -> Result<(), String> {
    guest.set_focus().map_err(|e| e.to_string())?;
    let (reply, receiver) = pending::channel();
    guest
        .with_webview(move |platform| {
            let result = unsafe {
                platform
                    .controller()
                    .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
            }
            .map_err(|e| e.to_string());
            pending::send(&reply, result);
        })
        .map_err(|e| e.to_string())?;
    pending::receive(receiver).await
}
