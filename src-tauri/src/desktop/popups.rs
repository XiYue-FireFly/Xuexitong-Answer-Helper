use super::{
    browser, frames, navigation_policy,
    state::{CreateRequest, DesktopState, Guest, Registry},
};
use crate::geometry::CssRect;
use serde_json::{Value, json};
use std::{
    sync::{Mutex, atomic::Ordering},
    time::Duration,
};
use tauri::webview::{NewWindowFeatures, NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use windows::Win32::UI::WindowsAndMessaging::{SWP_NOACTIVATE, SWP_SHOWWINDOW, SetWindowPos};

// This local placeholder connects a React tab to one particular WebView. It is
// consumed by browser:create and is never sent to the site.
pub(super) const TAB_PREFIX: &str = "about:blank#";

struct ClaimedPopup {
    id: u32,
    label: String,
}

fn claim_popup(registry: &mut Registry, key: &str) -> Result<ClaimedPopup, String> {
    let id = registry
        .popups
        .remove(key)
        .ok_or("Popup is no longer available")?;
    let guest = registry.guests.get(&id).ok_or("Popup was closed")?;
    if guest.instance != key {
        return Err("Popup is no longer available".into());
    }
    Ok(ClaimedPopup {
        id,
        label: guest.label.clone(),
    })
}

fn commit_popup_adoption(
    registry: &mut Registry,
    id: u32,
    key: &str,
    request: &CreateRequest,
) -> Result<(Guest, Value), String> {
    let guest = registry.guests.get_mut(&id).ok_or("Popup was closed")?;
    if guest.instance != key {
        return Err("Popup is no longer available".into());
    }
    let snapshot = serde_json::to_value(&guest.snapshot).map_err(|e| e.to_string())?;
    guest.instance = request.instance_id.clone();
    guest.bounds = request.bounds;
    guest.active = request.active;
    Ok((guest.clone(), snapshot))
}

fn purge_popup_registry(registry: &mut Registry, id: u32, key: &str) {
    registry.popups.remove(key);
    registry.guests.remove(&id);
    let tokens: Vec<_> = registry
        .pending
        .iter()
        .filter(|(_, entry)| entry.guest == id)
        .map(|(token, _)| token.clone())
        .collect();
    for token in tokens {
        if let Some(entry) = registry.pending.remove(&token) {
            let _ = entry.sender.send(Err("网页已关闭。".into()));
        }
    }
}

fn should_expire_popup(registry: &Registry, id: u32, key: &str) -> bool {
    registry
        .guests
        .get(&id)
        .is_some_and(|guest| guest.instance == key)
}

fn adopt_with_ops<W, GetWindow, LayoutFn, DestroyFn, CleanupFn>(
    registry_mutex: &Mutex<Registry>,
    key: &str,
    request: &CreateRequest,
    get_window: GetWindow,
    apply_layout: LayoutFn,
    destroy_window: DestroyFn,
    cleanup_guest: CleanupFn,
) -> Result<(Guest, Value), String>
where
    GetWindow: FnOnce(&str) -> Option<W>,
    LayoutFn: FnOnce(&W, CssRect, bool) -> Result<(), String>,
    DestroyFn: FnOnce(&W) -> bool,
    CleanupFn: FnOnce(u32),
{
    let claimed = {
        let mut registry = registry_mutex
            .lock()
            .map_err(|_| "Browser registry unavailable")?;
        claim_popup(&mut registry, key)?
    };
    let Some(window) = get_window(&claimed.label) else {
        if let Ok(mut registry) = registry_mutex.lock() {
            purge_popup_registry(&mut registry, claimed.id, key);
        }
        cleanup_guest(claimed.id);
        return Err("Popup window unavailable".into());
    };
    if let Err(error) = apply_layout(&window, request.bounds, request.active) {
        if destroy_window(&window) {
            if let Ok(mut registry) = registry_mutex.lock() {
                purge_popup_registry(&mut registry, claimed.id, key);
            }
            cleanup_guest(claimed.id);
        }
        return Err(error);
    }
    let committed = {
        let mut registry = registry_mutex
            .lock()
            .map_err(|_| "Browser registry unavailable")?;
        commit_popup_adoption(&mut registry, claimed.id, key, request)
    };
    if committed.is_err() {
        let _ = destroy_window(&window);
    }
    committed
}

pub(super) fn layout(window: &WebviewWindow, bounds: CssRect, active: bool) -> Result<(), String> {
    if !active {
        return window.hide().map_err(|e| e.to_string());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let ui = window
        .app_handle()
        .get_webview_window("ui")
        .ok_or("Missing controls")?;
    // Place the content behind the shaped UI sibling so dock and modal input
    // stays with the controls. Coordinates are relative to desktop's client.
    unsafe {
        SetWindowPos(
            window.hwnd().map_err(|e| e.to_string())?,
            Some(ui.hwnd().map_err(|e| e.to_string())?),
            (bounds.x * scale).round() as i32,
            (bounds.y * scale).round() as i32,
            (bounds.width * scale).round().max(1.0) as i32,
            (bounds.height * scale).round().max(1.0) as i32,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
        .map_err(|e| e.to_string())
    }
}

pub(super) fn adopt(app: &AppHandle, key: &str, request: &CreateRequest) -> Result<Value, String> {
    let state = app.state::<DesktopState>();
    let (guest, snapshot) = adopt_with_ops(
        &state.registry,
        key,
        request,
        |label| app.get_webview_window(label),
        layout,
        |window| {
            if window.destroy().is_ok() {
                true
            } else {
                let retry = window.clone();
                let _ = app.run_on_main_thread(move || {
                    let _ = retry.destroy();
                });
                false
            }
        },
        |id| {
            super::frame_requests::remove(id);
            super::media::invalidate_guest(id);
            let _ = app.run_on_main_thread(move || {
                frames::remove(id);
            });
        },
    )?;
    browser::emit(app, &guest, "did-navigate", json!({"isMainFrame":true}));
    if !guest.snapshot.loading {
        browser::emit(app, &guest, "dom-ready", json!({}));
        browser::emit(app, &guest, "did-stop-loading", json!({}));
    }
    Ok(snapshot)
}

pub fn open(
    app: &AppHandle,
    url: tauri::Url,
    features: NewWindowFeatures,
    opener_id: u32,
) -> NewWindowResponse<tauri::Wry> {
    let create = || -> Result<WebviewWindow, String> {
        let state = app.state::<DesktopState>();
        let opener = state.get(opener_id)?;
        if (!matches!(url.scheme(), "http" | "https") && url.as_str() != "about:blank")
            || navigation_policy::classify(url.as_str())?.drop
        {
            return Err("Popup target was denied".into());
        }
        let generation = state.ui_generation.load(Ordering::Acquire);
        let key = format!("popup-{}", uuid::Uuid::new_v4().simple());
        let root = app.get_window("desktop").ok_or("Missing desktop")?;
        if state
            .registry
            .lock()
            .map_err(|_| "Browser registry unavailable")?
            .guests
            .values()
            .filter(|g| g.instance.starts_with("popup-"))
            .count()
            >= 8
        {
            return Err("Too many pending popups".into());
        }
        let guest = browser::register(
            app,
            CreateRequest {
                instance_id: key.clone(),
                url: "about:blank".into(),
                bounds: opener.bounds,
                active: false,
            },
            Some(key.clone()),
        )?;
        let id = guest.snapshot.guest_id;
        let events = app.clone();
        let identity = key.clone();
        let nested = app.clone();
        let result = WebviewWindowBuilder::new(
            app,
            &key,
            WebviewUrl::External(tauri::Url::parse("about:blank").map_err(|e| e.to_string())?),
        )
        .window_features(features)
        .parent_raw(root.hwnd().map_err(|e| e.to_string())?)
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about"))
        .on_new_window(move |url, features| open(&nested, url, features, id))
        .on_page_load(move |window, payload| {
            browser::page_load(&events, window.as_ref(), id, payload.event(), payload.url());
            if !matches!(payload.event(), PageLoadEvent::Finished)
                || payload.url().as_str() == "about:blank"
            {
                return;
            }
            let state = events.state::<DesktopState>();
            if !state.get(id).is_ok_and(|guest| guest.instance == identity) {
                return;
            }
            let valid = state.ui_generation.load(Ordering::Acquire) == generation
                && state
                    .get(opener_id)
                    .is_ok_and(|g| g.instance == opener.instance);
            let policy = navigation_policy::classify(payload.url().as_str());
            if !valid || !policy.as_ref().is_ok_and(|p| !p.block && !p.drop) {
                let _ = window.close();
                return;
            }
            if policy.is_ok_and(|p| p.incomplete) {
                return;
            }
            if let Ok(mut registry) = state.registry.lock()
                && registry.popups.insert(identity.clone(), id).is_none()
            {
                drop(registry);
                let _ = events.emit_to(
                    "ui",
                    "browser:open-tab",
                    json!({"url":format!("{TAB_PREFIX}{identity}"),"title":"新标签页"}),
                );
            }
        })
        .build();
        let window = match result {
            Ok(w) => w,
            Err(e) => {
                if let Ok(mut r) = state.registry.lock() {
                    r.guests.remove(&id);
                }
                return Err(e.to_string());
            }
        };
        let cleanup = app.clone();
        let label = key.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                frames::remove(id);
                super::frame_requests::remove(id);
                super::media::invalidate_guest(id);
                if let Ok(mut registry) = cleanup.state::<DesktopState>().registry.lock() {
                    purge_popup_registry(&mut registry, id, &label);
                }
            }
        });
        // The callback runs on the WebView STA before Wry completes its new
        // window deferral: subscribe before the original POST can begin.
        let app_handle = app.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        window
            .with_webview(move |platform| {
                let result = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|e| e.to_string())
                    .and_then(|core| browser::install_bridge(&app_handle, core, id));
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        if let Err(error) = rx.recv().map_err(|e| e.to_string())? {
            let _ = window.destroy();
            return Err(error);
        }
        let pending = window.clone();
        let lookup = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(45)).await;
            let _ = lookup.run_on_main_thread(move || {
                let expired = pending
                    .state::<DesktopState>()
                    .registry
                    .lock()
                    .is_ok_and(|registry| should_expire_popup(&registry, id, &key));
                if expired {
                    let _ = pending.destroy();
                }
            });
        });
        Ok(window)
    };
    match create() {
        Ok(window) => NewWindowResponse::Create { window },
        Err(_) => NewWindowResponse::Deny,
    }
}

#[cfg(test)]
mod tests {
    use super::{adopt_with_ops, purge_popup_registry, should_expire_popup};
    use crate::desktop::state::{CreateRequest, Evaluation, Guest, Registry, Snapshot};
    use crate::geometry::CssRect;
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
    };

    fn sample_bounds() -> CssRect {
        CssRect {
            x: 0.0,
            y: 98.0,
            width: 1280.0,
            height: 752.0,
        }
    }

    fn seed_popup(
        key: &str,
    ) -> (
        Mutex<Registry>,
        tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>>,
    ) {
        let mut registry = Registry::default();
        let id = 7;
        registry.next = id;
        registry.popups.insert(key.to_string(), id);
        registry.guests.insert(
            id,
            Guest {
                instance: key.to_string(),
                label: key.to_string(),
                hook: "__sp_test".into(),
                snapshot: Snapshot {
                    guest_id: id,
                    url: "https://example.test/home".into(),
                    title: "Signed in".into(),
                    can_go_back: false,
                    can_go_forward: false,
                    loading: false,
                    document_generation: 2,
                },
                bounds: sample_bounds(),
                active: false,
                bridge_ready: true,
                page_ready: true,
            },
        );
        let (tx, rx) = tokio::sync::oneshot::channel();
        registry.pending.insert(
            "eval-1".into(),
            Evaluation {
                guest: id,
                frame: 0,
                generation: 2,
                sender: tx,
            },
        );
        (Mutex::new(registry), rx)
    }

    fn sample_request(key: &str) -> CreateRequest {
        CreateRequest {
            instance_id: "rust-guest-adopted-1".into(),
            url: format!("about:blank#{key}"),
            bounds: CssRect {
                x: 12.0,
                y: 110.0,
                width: 1024.0,
                height: 640.0,
            },
            active: true,
        }
    }

    #[test]
    fn adopt_commits_instance_and_disarms_expiry_after_layout_succeeds() -> Result<(), String> {
        let key = "popup-happy";
        let (registry, _rx) = seed_popup(key);
        let request = sample_request(key);
        let destroyed = AtomicBool::new(false);
        let cleaned = AtomicU32::new(0);

        let (guest, snapshot) = adopt_with_ops(
            &registry,
            key,
            &request,
            |label| Some(label.to_string()),
            |_, bounds, active| {
                assert_eq!(bounds, request.bounds);
                assert!(active);
                Ok(())
            },
            |_| {
                destroyed.store(true, Ordering::SeqCst);
                true
            },
            |id| {
                cleaned.store(id, Ordering::SeqCst);
            },
        )?;

        assert!(!destroyed.load(Ordering::SeqCst));
        assert_eq!(cleaned.load(Ordering::SeqCst), 0);
        assert_eq!(guest.instance, "rust-guest-adopted-1");
        assert_eq!(guest.bounds, request.bounds);
        assert!(guest.active);
        assert_eq!(snapshot["guestId"], 7);
        assert_eq!(snapshot["url"], "https://example.test/home");

        let guard = registry.lock().unwrap();
        assert!(!guard.popups.contains_key(key));
        assert!(!should_expire_popup(&guard, 7, key));
        drop(guard);

        let replay = adopt_with_ops(
            &registry,
            key,
            &request,
            |label| Some(label.to_string()),
            |_, _, _| Ok(()),
            |_| true,
            |_| {},
        );
        assert_eq!(
            replay.err().as_deref(),
            Some("Popup is no longer available")
        );
        Ok(())
    }

    #[test]
    fn adopt_destroys_and_purges_unadopted_popup_when_layout_fails() {
        let key = "popup-layout-fail";
        let (registry, mut rx) = seed_popup(key);
        let request = sample_request(key);
        let destroyed = AtomicBool::new(false);
        let cleaned = AtomicU32::new(0);

        let result = adopt_with_ops(
            &registry,
            key,
            &request,
            |label| Some(label.to_string()),
            |_, _, _| Err("Missing controls".into()),
            |_| {
                destroyed.store(true, Ordering::SeqCst);
                true
            },
            |id| {
                cleaned.store(id, Ordering::SeqCst);
            },
        );

        assert_eq!(result.err().as_deref(), Some("Missing controls"));
        assert!(destroyed.load(Ordering::SeqCst));
        assert_eq!(cleaned.load(Ordering::SeqCst), 7);
        assert_eq!(
            rx.try_recv().ok().and_then(Result::err).as_deref(),
            Some("网页已关闭。")
        );

        let guard = registry.lock().unwrap();
        assert!(!guard.popups.contains_key(key));
        assert!(!guard.guests.contains_key(&7));
        assert!(guard.pending.is_empty());
        assert!(!should_expire_popup(&guard, 7, key));
    }

    #[test]
    fn adopt_preserves_expiry_guard_when_layout_and_immediate_destroy_fail() {
        let key = "popup-destroy-fail";
        let (registry, _rx) = seed_popup(key);
        let request = sample_request(key);
        let destroyed_attempted = AtomicBool::new(false);
        let cleaned = AtomicU32::new(0);

        let result = adopt_with_ops(
            &registry,
            key,
            &request,
            |label| Some(label.to_string()),
            |_, _, _| Err("SetWindowPos failed".into()),
            |_| {
                destroyed_attempted.store(true, Ordering::SeqCst);
                false
            },
            |id| {
                cleaned.store(id, Ordering::SeqCst);
            },
        );

        assert_eq!(result.err().as_deref(), Some("SetWindowPos failed"));
        assert!(destroyed_attempted.load(Ordering::SeqCst));
        assert_eq!(cleaned.load(Ordering::SeqCst), 0);

        let guard = registry.lock().unwrap();
        assert!(!guard.popups.contains_key(key));
        assert_eq!(guard.guests.get(&7).map(|g| g.instance.as_str()), Some(key));
        assert!(should_expire_popup(&guard, 7, key));
    }

    #[test]
    fn adopt_purges_guest_when_popup_window_is_missing() {
        let key = "popup-missing-window";
        let (registry, mut rx) = seed_popup(key);
        let request = sample_request(key);
        let cleaned = AtomicU32::new(0);

        let result = adopt_with_ops::<String, _, _, _, _>(
            &registry,
            key,
            &request,
            |_| None,
            |_, _, _| Ok(()),
            |_| true,
            |id| {
                cleaned.store(id, Ordering::SeqCst);
            },
        );

        assert_eq!(result.err().as_deref(), Some("Popup window unavailable"));
        assert_eq!(cleaned.load(Ordering::SeqCst), 7);
        assert_eq!(
            rx.try_recv().ok().and_then(Result::err).as_deref(),
            Some("网页已关闭。")
        );
        let guard = registry.lock().unwrap();
        assert!(!guard.popups.contains_key(key));
        assert!(!guard.guests.contains_key(&7));
    }

    #[test]
    fn adopt_rejects_and_destroys_if_popup_disappears_before_commit() {
        let key = "popup-raced";
        let (registry, _rx) = seed_popup(key);
        let request = sample_request(key);
        let destroyed = AtomicBool::new(false);

        let result = adopt_with_ops(
            &registry,
            key,
            &request,
            |label| Some(label.to_string()),
            |_, _, _| {
                let mut guard = registry.lock().unwrap();
                purge_popup_registry(&mut guard, 7, key);
                Ok(())
            },
            |_| {
                destroyed.store(true, Ordering::SeqCst);
                true
            },
            |_| {},
        );

        assert_eq!(result.err().as_deref(), Some("Popup was closed"));
        assert!(destroyed.load(Ordering::SeqCst));
    }
}
