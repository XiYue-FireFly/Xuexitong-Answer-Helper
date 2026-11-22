mod browser;
mod diagnostics;
pub mod frame_requests;
pub mod frames;
mod media;
mod native;
mod navigation_policy;
mod popups;
#[cfg(debug_assertions)]
mod qa;
pub mod state;
use crate::{composition, geometry::CssRect, services::http};
use serde_json::{Value, json};
use state::DesktopState;
use tauri::{
    AppHandle, Emitter, Manager, Webview, WebviewWindowBuilder, WindowBuilder, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const GLASS_CAPTURE_BLEED_CSS_PX: f64 = 24.0;

/// Expand a UI-space glass capture region by optical bleed on all four sides
/// (matching Electron `glass-region.ts` `bleed = 24` and Android `gutter = 24 * density`),
/// translated into guest-local CSS coordinates and safely clamped to `guest_bounds`.
fn glass_capture_local_region(
    region: CssRect,
    guest_bounds: CssRect,
    bleed: f64,
) -> Result<CssRect, String> {
    let region = region.validate()?;
    let guest_bounds = guest_bounds.validate()?;
    if !bleed.is_finite() || bleed < 0.0 {
        return Err("Invalid glass capture bleed".into());
    }
    let left = (region.x - guest_bounds.x - bleed).max(0.0);
    let top = (region.y - guest_bounds.y - bleed).max(0.0);
    let right = (region.x - guest_bounds.x + region.width + bleed).min(guest_bounds.width);
    let bottom = (region.y - guest_bounds.y + region.height + bleed).min(guest_bounds.height);
    if right <= left || bottom <= top {
        return Err("Capture region does not intersect the guest".into());
    }
    CssRect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    }
    .validate()
}

fn local_ui(url: &tauri::Url) -> bool {
    url.path() == "/rust-index.html"
        && url.host_str() == Some("tauri.localhost")
        && matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
}
fn sync_ui(app: &AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<DesktopState>() {
        state
            .layout_generation
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    }
    let Some(owner) = app.get_window("desktop") else {
        return Ok(());
    };
    let Some(ui) = app.get_webview_window("ui") else {
        return Ok(());
    };
    if owner.is_minimized().map_err(|e| e.to_string())? {
        return Ok(());
    }
    let size = owner.inner_size().map_err(|e| e.to_string())?;
    if size.width == 0 || size.height == 0 {
        return Ok(());
    }
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::SetWindowPos(
            ui.hwnd().map_err(|e| e.to_string())?,
            None,
            0,
            0,
            size.width as i32,
            size.height as i32,
            windows::Win32::UI::WindowsAndMessaging::SWP_NOACTIVATE
                | windows::Win32::UI::WindowsAndMessaging::SWP_NOZORDER,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Keep the shaped UI above its site siblings, without changing geometry or focus.
fn raise_ui(app: &AppHandle) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetTopWindow, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos,
    };
    let owner = app
        .get_window("desktop")
        .ok_or("Desktop window unavailable")?;
    let ui = app.get_webview_window("ui").ok_or("UI unavailable")?;
    let owner = owner.hwnd().map_err(|e| e.to_string())?;
    let ui = ui.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        if GetTopWindow(Some(owner)).ok() != Some(ui) {
            SetWindowPos(
                ui,
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn shutdown(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    if state
        .shutdown_started
        .swap(true, std::sync::atomic::Ordering::AcqRel)
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if !matches!(
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                browser::persist_sessions(&app)
            )
            .await,
            Ok(Ok(()))
        ) {
            eprintln!("Website session could not be saved during shutdown");
        }
        let closing = app.clone();
        if app
            .run_on_main_thread(move || {
                let _ = browser::close_views(&closing);
                closing.exit(0);
            })
            .is_err()
        {
            app.exit(0);
        }
    });
}
#[tauri::command]
async fn desktop_host(
    caller: Webview,
    app: AppHandle,
    command: String,
    payload: Value,
) -> Result<Value, String> {
    if caller.label() != "ui" || !local_ui(&caller.url().map_err(|e| e.to_string())?) {
        return Err("Only bundled desktop UI can invoke host commands".into());
    }
    let state = app.state::<DesktopState>();
    match command.as_str() {
        #[cfg(debug_assertions)]
        "test:install-ai-fixture" => {
            qa::route(
                payload["host"].as_str().ok_or("Missing fixture host")?,
                payload["html"].as_str().ok_or("Missing fixture HTML")?,
            )?;
            Ok(Value::Null)
        }
        "browser:create" => {
            browser::create(
                &app,
                serde_json::from_value(payload).map_err(|e| e.to_string())?,
            )
            .await
        }
        "browser:action" => browser::action(&app, payload).await,
        "media:lease" | "web-ai:lease-task" => media::lease(&app, payload).await,
        "media:read" | "web-ai:read-question-media" => media::read(&app, payload).await,
        "media:release" | "web-ai:release-task" => {
            media::release(&app, payload.as_str().ok_or("Missing task session")?.into()).await
        }
        "browser:frame-evaluate" => {
            let guest = state.get(payload["guestId"].as_u64().ok_or("Missing guestId")? as u32)?;
            let id = payload["frameId"].as_u64().ok_or("Missing frameId")?;
            let document = browser::documents(&app, &guest)
                .await?
                .into_iter()
                .find(|document| document.frame_id == id && document.ready)
                .ok_or("Frame unavailable")?;
            browser::evaluate_document(
                &app,
                guest,
                document,
                payload["code"]
                    .as_str()
                    .ok_or("Missing script")?
                    .to_string(),
            )
            .await
        }
        "browser:debug" => {
            let id = payload["guestId"].as_u64().ok_or("Missing guestId")? as u32;
            let guest = state.get(id)?;
            let (reply, receiver) = crate::pending::channel();
            browser::view(&app, &guest)?
                .with_webview(move |_| {
                    crate::pending::send(&reply, Ok(frames::diagnostics(id)));
                })
                .map_err(|e| e.to_string())?;
            let frames = crate::pending::receive(receiver).await?;
            let probe=native::script(&browser::view(&app,&guest)?,"({hooks:Object.getOwnPropertyNames(window).filter(name=>name.startsWith('__sp_')),transport:typeof window.chrome?.webview?.postMessage})".into()).await?;
            Ok(json!({"frames":frames,"probe":probe}))
        }
        "browser:update-layout" => browser::layout(&app, payload).await,
        "browser:destroy" => browser::destroy(&app, payload).await,
        "ui:layout-context" => Ok(
            json!({"documentGeneration":state.ui_generation.load(std::sync::atomic::Ordering::Acquire)}),
        ),
        "ui:layout" => {
            let ui = app.get_webview_window("ui").ok_or("UI unavailable")?;
            let request: composition::LayoutRequest =
                serde_json::from_value(payload).map_err(|e| e.to_string())?;
            serde_json::to_value(composition::apply_regions(ui, request).await?)
                .map_err(|e| e.to_string())
        }
        "settings:get" => state
            .storage
            .lock()
            .map_err(|_| "Storage unavailable")?
            .get_settings(),
        "settings:set" => state
            .storage
            .lock()
            .map_err(|_| "Storage unavailable")?
            .set_settings(payload),
        "profile:stage" => serde_json::to_value(crate::services::migration::stage_import(
            &state.data,
            &payload,
        )?)
        .map_err(|e| e.to_string()),
        "profile:commit" => {
            let mut selected_storage = state.storage.lock().map_err(|_| "Storage unavailable")?;
            let token = payload["token"]
                .as_str()
                .ok_or("Missing staged profile token")?;
            let result = crate::services::migration::commit_import(&state.data, token)?;
            let next = crate::services::storage::PreviewStorage::new_with_defaults(
                result.profile_root.clone(),
                state::defaults()?,
            )?;
            let marker = state.data.join("active-profile-token.json");
            if let Ok(metadata) = std::fs::symlink_metadata(&marker)
                && (metadata.file_type().is_symlink() || !metadata.is_file())
            {
                return Err("Invalid profile marker".into());
            }
            let temporary = state
                .data
                .join(format!(".profile-token-{}", uuid::Uuid::new_v4()));
            let marker_bytes = serde_json::to_vec(token).map_err(|e| e.to_string())?;
            {
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)
                    .map_err(|e| e.to_string())?;
                file.write_all(&marker_bytes)
                    .and_then(|()| file.sync_all())
                    .map_err(|e| e.to_string())?;
            }
            if let Err(error) = crate::services::storage::atomic_replace(&temporary, &marker) {
                let _ = std::fs::remove_file(&temporary);
                return Err(error);
            }
            *selected_storage = next;
            Ok(
                json!({"token":token,"localStorage":result.local_storage,"guestLogin":result.guest_login}),
            )
        }
        "profile:startup" => {
            let _selected_storage = state.storage.lock().map_err(|_| "Storage unavailable")?;
            match state::selected_profile(&state.data)? {
                Some(result) => {
                    let file = state.data.join("active-profile-token.json");
                    let token: Value =
                        serde_json::from_slice(&std::fs::read(file).map_err(|e| e.to_string())?)
                            .map_err(|e| e.to_string())?;
                    Ok(json!({"token":token,"localStorage":result.local_storage}))
                }
                None => Ok(Value::Null),
            }
        }
        "settings:get-webview-preload" => Ok(json!("rust-host://bundled-page-bridge")),
        "window:minimize" => {
            app.get_window("desktop")
                .ok_or("Window unavailable")?
                .minimize()
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "window:start-drag" => {
            app.get_window("desktop")
                .ok_or("Window unavailable")?
                .start_dragging()
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "window:maximize" => {
            let window = app.get_window("desktop").ok_or("Window unavailable")?;
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
            .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "window:close" => {
            shutdown(&app);
            Ok(Value::Null)
        }
        "window:set-titlebar-theme" => {
            let theme = if payload == "light" {
                tauri::Theme::Light
            } else {
                tauri::Theme::Dark
            };
            app.get_window("desktop")
                .ok_or("Window unavailable")?
                .set_theme(Some(theme))
                .map_err(|e| e.to_string())?;
            Ok(json!({"success":true}))
        }
        "app:notify" => {
            app.notification()
                .builder()
                .title(payload["title"].as_str().unwrap_or("学习助手"))
                .body(payload["body"].as_str().unwrap_or(""))
                .show()
                .map_err(|e| e.to_string())?;
            Ok(json!({"success":true}))
        }
        "app:open-url" => {
            let url = payload.as_str().ok_or("Missing external URL")?;
            let parsed = tauri::Url::parse(url).map_err(|_| "Invalid external URL")?;
            if !matches!(parsed.scheme(), "http" | "https" | "mailto" | "tel") {
                return Err("External URL scheme rejected".into());
            }
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(json!({"success":true}))
        }
        "ai:chat" => {
            let generation = state
                .ui_generation
                .load(std::sync::atomic::Ordering::Acquire);
            let events = app.clone();
            let request = http::ai_chat(payload, move |chunk| {
                let state = events.state::<DesktopState>();
                if state
                    .ui_generation
                    .load(std::sync::atomic::Ordering::Acquire)
                    != generation
                    || events.get_webview("ui").is_none()
                {
                    return Err("UI document closed".into());
                }
                events
                    .emit_to("ui", "ai:chat-chunk", chunk)
                    .map_err(|e| e.to_string())
            });
            tokio::pin!(request);
            let result = loop {
                tokio::select! {value=&mut request=>break value,_=tokio::time::sleep(std::time::Duration::from_millis(100))=>{if state.ui_generation.load(std::sync::atomic::Ordering::Acquire)!=generation||app.get_webview("ui").is_none(){break json!({"success":false,"error":"调用页面已关闭，请求已取消。"});}}}
            };
            Ok(result)
        }
        "transport:http" => {
            let url = payload["url"].as_str().ok_or("Missing HTTP URL")?;
            let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid HTTP URL")?;
            if !matches!(parsed.scheme(), "http" | "https")
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err("Unsupported HTTP URL".into());
            }
            let timeout = std::time::Duration::from_millis(
                payload["timeoutMs"]
                    .as_u64()
                    .unwrap_or(20000)
                    .clamp(1000, 120000),
            );
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(timeout)
                .read_timeout(timeout)
                .build()
                .map_err(|_| "HTTP transport unavailable")?;
            let method =
                reqwest::Method::from_bytes(payload["method"].as_str().unwrap_or("GET").as_bytes())
                    .map_err(|_| "Invalid HTTP method")?;
            let mut request = client.request(method, parsed);
            if let Some(headers) = payload["headers"].as_object() {
                for (name, value) in headers {
                    if let Some(value) = value.as_str() {
                        request = request.header(name, value);
                    }
                }
            }
            if !payload["body"].is_null() {
                let body: Vec<u8> = serde_json::from_value(payload["body"].clone())
                    .map_err(|_| "Invalid HTTP body")?;
                if body.len() > 32 * 1024 * 1024 {
                    return Err("HTTP body exceeds budget".into());
                }
                request = request.body(body);
            }
            let mut response = request.send().await.map_err(|error| {
                if error.is_timeout() {
                    "接口请求超时。"
                } else {
                    "HTTP request failed"
                }
            })?;
            let status = response.status();
            let headers: serde_json::Map<String, Value> = response
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| (name.to_string(), json!(value)))
                })
                .collect();
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| {
                if error.is_timeout() {
                    "接口请求超时。"
                } else {
                    "HTTP response interrupted"
                }
            })? {
                if bytes.len() + chunk.len() > 32 * 1024 * 1024 {
                    return Err("HTTP response exceeds budget".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(
                json!({"statusCode":status.as_u16(),"statusMessage":status.canonical_reason().unwrap_or(""),"headers":headers,"bytes":bytes}),
            )
        }
        "glass:capture" => {
            let id = payload["guestId"].as_u64().ok_or("Missing guestId")? as u32;
            let guest = state.get(id)?;
            if !guest.active {
                return Err("Only current guest may be captured".into());
            }
            if app
                .get_window("desktop")
                .ok_or("Window unavailable")?
                .is_minimized()
                .map_err(|e| e.to_string())?
            {
                return Ok(json!({}));
            }
            let region: CssRect =
                serde_json::from_value(payload["region"].clone()).map_err(|e| e.to_string())?;
            let local =
                glass_capture_local_region(region, guest.bounds, GLASS_CAPTURE_BLEED_CSS_PX)?;
            let png = native::png(&browser::view(&app, &guest)?).await?;
            if state.get(id)?.snapshot.document_generation != guest.snapshot.document_generation {
                return Ok(json!({}));
            }
            let request = crate::capture::CaptureRequest {
                region: local,
                viewport: CssRect {
                    x: 0.0,
                    y: 0.0,
                    width: guest.bounds.width,
                    height: guest.bounds.height,
                },
            };
            let (url, mut bounds, _) = tauri::async_runtime::spawn_blocking(move || {
                crate::capture::bounded_sample(png, request)
            })
            .await
            .map_err(|e| e.to_string())??;
            bounds.x += guest.bounds.x;
            bounds.y += guest.bounds.y;
            Ok(json!({"dataUrl":url,"bounds":bounds}))
        }
        "browser:screenshot" => {
            let ui = app.get_webview("ui").ok_or("UI unavailable")?;
            let png = native::png(&ui).await?;
            let size = ui.bounds().map_err(|e| e.to_string())?;
            let scale = ui.window().scale_factor().map_err(|e| e.to_string())?;
            let viewport = CssRect {
                x: 0.0,
                y: 0.0,
                width: size.size.to_logical::<f64>(scale).width,
                height: size.size.to_logical::<f64>(scale).height,
            };
            let region = if payload.is_null() {
                viewport
            } else {
                serde_json::from_value(payload).map_err(|e| e.to_string())?
            };
            let (image, _, _) = crate::capture::bounded_sample(
                png,
                crate::capture::CaptureRequest { region, viewport },
            )?;
            Ok(json!({"success":true,"image":image}))
        }
        "session:get-webview-state" => Ok(
            json!({"success":true,"partition":"persist:studypilot-sites","persistent":true,"storagePath":state.data.join("sites")}),
        ),
        "session:clear-webview-login" => {
            let guests: Vec<_> = state
                .registry
                .lock()
                .map_err(|_| "Registry unavailable")?
                .guests
                .values()
                .cloned()
                .collect();
            if guests
                .iter()
                .any(|guest| media::guest_leased(guest.snapshot.guest_id))
            {
                return Err("请先停止答题任务再清理登录。".into());
            }
            for guest in guests {
                let view = browser::view(&app, &guest)?;
                view.clear_all_browsing_data().map_err(|e| e.to_string())?;
            }
            Ok(json!({"success":true}))
        }
        "diagnostics:get-recent-error-logs" => {
            diagnostics::recent(&state.data, payload.as_u64().unwrap_or(80) as usize)
        }
        "diagnostics:get-error-log-path" => Ok(json!(
            state.data.join("rust-host-preview/diagnostics.jsonl")
        )),
        "system:log" | "diagnostics:error-log" => diagnostics::append(&state.data, payload),
        "automation:snapshot" => {
            Ok(json!({"success":true,"message":"Forwarding snapshot request to webview container"}))
        }
        "automation:execute-plan" => Ok(json!({"success":true,"payload":payload})),
        "app:check-update" => Err("Rust 预览尚未接入更新通道。".into()),
        "browser:open-internal-tab" => {
            app.emit_to("ui", "browser:open-tab", json!({"url":payload}))
                .map_err(|e| e.to_string())?;
            Ok(json!({"success":true}))
        }
        "browser:navigate" => Ok(json!({"success":true,"url":payload})),
        _ => Err(format!(
            "Rust preview host has not implemented command {command}"
        )),
    }
}

const UI_LAYOUT: &str = include_str!("ui-layout.js");
pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let root = if let Some(directory) = std::env::var_os("STUDYPILOT_RUST_PREVIEW_DATA") {
                let path = std::path::PathBuf::from(directory);
                if !path.is_absolute() {
                    return Err(
                        std::io::Error::other("Preview data override must be absolute").into(),
                    );
                }
                path
            } else {
                app.path().app_local_data_dir()?
            };
            app.manage(DesktopState::new(root.clone()).map_err(std::io::Error::other)?);
            // The existing region implementation uses only these counters in desktop mode.
            app.manage(crate::state::PocState::new(
                crate::policy::FixtureTarget::Bundled,
            ));
            let window = WindowBuilder::new(app, "desktop")
                .title("WISP RS")
                .decorations(false)
                .inner_size(1280.0, 850.0)
                .min_inner_size(700.0, 540.0)
                .build()?;
            let owner = window.hwnd()?;
            WebviewWindowBuilder::new(app, "ui", tauri::WebviewUrl::App("rust-index.html".into()))
                .title("WISP RS")
                .parent_raw(owner)
                .resizable(false)
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .data_directory(root.join("interface"))
                .initialization_script(UI_LAYOUT)
                .on_navigation(local_ui)
                .on_page_load(|view, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                        view.state::<DesktopState>()
                            .ui_generation
                            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                        media::invalidate_ui(view.app_handle());
                    }
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            sync_ui(app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![desktop_host])
        .on_window_event(|window, event| {
            if window.label() == "ui" && matches!(event, WindowEvent::Destroyed) {
                media::invalidate_ui(window.app_handle());
            }
            if window.label() == "desktop" {
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        shutdown(window.app_handle());
                    }
                    WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                        let _ = sync_ui(window.app_handle());
                    }
                    WindowEvent::Destroyed => window.app_handle().exit(0),
                    _ => {}
                }
            }
        })
        .run(tauri::generate_context!())
}

#[cfg(test)]
mod tests {
    use super::{GLASS_CAPTURE_BLEED_CSS_PX, glass_capture_local_region};
    use crate::geometry::{CssRect, crop_rect};

    fn sample_guest_bounds() -> CssRect {
        CssRect {
            x: 0.0,
            y: 98.0,
            width: 1280.0,
            height: 752.0,
        }
    }

    #[test]
    fn glass_capture_expands_middle_region_by_24px_bleed_on_all_sides() -> Result<(), String> {
        let guest = sample_guest_bounds();
        let region = CssRect {
            x: 340.0,
            y: 690.0,
            width: 600.0,
            height: 56.0,
        };
        let local = glass_capture_local_region(region, guest, GLASS_CAPTURE_BLEED_CSS_PX)?;
        assert_eq!(
            local,
            CssRect {
                x: 316.0,
                y: 568.0,
                width: 648.0,
                height: 104.0,
            }
        );
        let viewport = CssRect {
            x: 0.0,
            y: 0.0,
            width: guest.width,
            height: guest.height,
        };
        let (pixels, bounds) = crop_rect(local, viewport, (1280, 752))?;
        assert_eq!(pixels, [316, 568, 648, 104]);
        assert_eq!(bounds, local);
        Ok(())
    }

    #[test]
    fn glass_capture_clamps_safely_at_all_four_edges_without_negative_or_zero_bounds()
    -> Result<(), String> {
        let guest = sample_guest_bounds();
        let viewport = CssRect {
            x: 0.0,
            y: 0.0,
            width: guest.width,
            height: guest.height,
        };

        // Top-left edge
        let top_left = glass_capture_local_region(
            CssRect {
                x: 4.0,
                y: 104.0,
                width: 62.0,
                height: 300.0,
            },
            guest,
            GLASS_CAPTURE_BLEED_CSS_PX,
        )?;
        assert_eq!(top_left.x, 0.0);
        assert_eq!(top_left.y, 0.0);
        assert_eq!(top_left.width, 90.0);
        assert_eq!(top_left.height, 330.0);
        let (tl_px, tl_bounds) = crop_rect(top_left, viewport, (1280, 752))?;
        assert!(tl_px[2] > 0 && tl_px[3] > 0);
        assert!(tl_bounds.x >= 0.0 && tl_bounds.y >= 0.0);

        // Bottom-right edge
        let bottom_right = glass_capture_local_region(
            CssRect {
                x: 1210.0,
                y: 780.0,
                width: 62.0,
                height: 62.0,
            },
            guest,
            GLASS_CAPTURE_BLEED_CSS_PX,
        )?;
        assert_eq!(bottom_right.x, 1186.0);
        assert_eq!(bottom_right.y, 658.0);
        assert_eq!(bottom_right.x + bottom_right.width, guest.width);
        assert_eq!(bottom_right.y + bottom_right.height, guest.height);
        let (br_px, br_bounds) = crop_rect(bottom_right, viewport, (1280, 752))?;
        assert_eq!(br_px, [1186, 658, 94, 94]);
        assert!(br_bounds.width > 0.0 && br_bounds.height > 0.0);

        // Near-full viewport region touching all four edges
        let full = glass_capture_local_region(
            CssRect {
                x: 8.0,
                y: 106.0,
                width: 1264.0,
                height: 736.0,
            },
            guest,
            GLASS_CAPTURE_BLEED_CSS_PX,
        )?;
        assert_eq!(
            full,
            CssRect {
                x: 0.0,
                y: 0.0,
                width: guest.width,
                height: guest.height,
            }
        );
        Ok(())
    }

    #[test]
    fn glass_capture_uses_css_bleed_with_offset_guest_and_scaled_bitmap() -> Result<(), String> {
        let guest = CssRect {
            x: 100.0,
            y: 200.0,
            width: 600.0,
            height: 400.0,
        };
        let local = glass_capture_local_region(
            CssRect {
                x: 150.0,
                y: 250.0,
                width: 100.0,
                height: 80.0,
            },
            guest,
            GLASS_CAPTURE_BLEED_CSS_PX,
        )?;
        assert_eq!(
            local,
            CssRect {
                x: 26.0,
                y: 26.0,
                width: 148.0,
                height: 128.0
            }
        );
        let (pixels, bounds) = crop_rect(
            local,
            CssRect {
                x: 0.0,
                y: 0.0,
                width: guest.width,
                height: guest.height,
            },
            (1200, 800),
        )?;
        assert_eq!(pixels, [52, 52, 296, 256]);
        assert_eq!(bounds, local);
        assert_eq!((bounds.x + guest.x, bounds.y + guest.y), (126.0, 226.0));
        Ok(())
    }

    #[test]
    fn glass_capture_rejects_non_intersecting_or_invalid_regions() {
        let guest = sample_guest_bounds();
        assert!(
            glass_capture_local_region(
                CssRect {
                    x: 1400.0,
                    y: 200.0,
                    width: 60.0,
                    height: 60.0,
                },
                guest,
                GLASS_CAPTURE_BLEED_CSS_PX,
            )
            .is_err()
        );
        assert!(
            glass_capture_local_region(
                CssRect {
                    x: 100.0,
                    y: 200.0,
                    width: 0.0,
                    height: 60.0,
                },
                guest,
                GLASS_CAPTURE_BLEED_CSS_PX,
            )
            .is_err()
        );
    }
}
