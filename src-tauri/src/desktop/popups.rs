use super::{navigation_policy, state::DesktopState};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tauri::webview::{NewWindowFeatures, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
struct Permit;
impl Permit {
    fn acquire() -> Option<Self> {
        let mut value = ACTIVE.load(Ordering::Acquire);
        loop {
            if value >= 8 {
                return None;
            }
            match ACTIVE.compare_exchange_weak(
                value,
                value + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(Self),
                Err(actual) => value = actual,
            }
        }
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Native window ownership preserves the original POST/opener operation. Never
/// convert a form or about:blank popup into a guessed GET navigation.
pub fn open(
    app: &AppHandle,
    url: tauri::Url,
    features: NewWindowFeatures,
    opener_id: u32,
) -> NewWindowResponse<tauri::Wry> {
    let state = app.state::<DesktopState>();
    let Ok(opener) = state.get(opener_id) else {
        return NewWindowResponse::Deny;
    };
    let ui_generation = state.ui_generation.load(Ordering::Acquire);
    let opener_instance = opener.instance;
    let Ok(policy) = navigation_policy::classify(url.as_str()) else {
        return NewWindowResponse::Deny;
    };
    if policy.drop {
        return NewWindowResponse::Deny;
    }
    if url.as_str() != "about:blank" && !policy.block && !policy.incomplete {
        let _ = app.emit_to(
            "ui",
            "browser:open-tab",
            serde_json::json!({"url":url.as_str()}),
        );
        return NewWindowResponse::Deny;
    }
    let Some(permit) = Permit::acquire() else {
        return NewWindowResponse::Deny;
    };
    let permit = Arc::new(std::sync::Mutex::new(Some(permit)));
    let label = format!("popup-{}", uuid::Uuid::new_v4().simple());
    let events = app.clone();
    let closed = Arc::new(AtomicBool::new(false));
    let done = Arc::clone(&closed);
    let lease_app = app.clone();
    let lease_instance = opener_instance.clone();
    let builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External(tauri::Url::parse("about:blank").unwrap_or_else(|_| url.clone())),
    )
    .window_features(features)
    .visible(false)
    .skip_taskbar(true)
    .on_navigation(|target| matches!(target.scheme(), "http" | "https" | "about"))
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_page_load(move |window, payload| {
        let state = events.state::<DesktopState>();
        let valid = state.ui_generation.load(Ordering::Acquire) == ui_generation
            && state
                .get(opener_id)
                .is_ok_and(|guest| guest.instance == opener_instance);
        if !valid {
            done.store(true, Ordering::Release);
            let _ = window.close();
            return;
        }
        if !matches!(payload.event(), PageLoadEvent::Finished) || done.load(Ordering::Acquire) {
            return;
        }
        let target = payload.url();
        let Ok(policy) = navigation_policy::classify(target.as_str()) else {
            return;
        };
        if target.as_str() == "about:blank" || policy.incomplete {
            return;
        }
        if !policy.block && !policy.drop {
            let _ = events.emit_to(
                "ui",
                "browser:open-tab",
                serde_json::json!({"url":target.as_str()}),
            );
        }
        if !done.swap(true, Ordering::AcqRel) {
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(2500)).await;
                let _ = window.close();
            });
        }
    });
    match builder.build() {
        Ok(window) => {
            let release = Arc::clone(&permit);
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed)
                    && let Ok(mut value) = release.lock()
                {
                    value.take();
                }
            });
            let timeout = window.clone();
            tauri::async_runtime::spawn(async move {
                for _ in 0..90 {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    let state = lease_app.state::<DesktopState>();
                    if state.ui_generation.load(Ordering::Acquire) != ui_generation
                        || !state
                            .get(opener_id)
                            .is_ok_and(|guest| guest.instance == lease_instance)
                    {
                        break;
                    }
                    if closed.load(Ordering::Acquire) {
                        return;
                    }
                }
                if !closed.swap(true, Ordering::AcqRel) {
                    let _ = timeout.close();
                }
                if let Ok(mut value) = permit.lock() {
                    value.take();
                }
            });
            NewWindowResponse::Create { window }
        }
        Err(error) => {
            eprintln!("Native popup creation failed: {error}");
            NewWindowResponse::Deny
        }
    }
}
