use super::{
    frames, native,
    state::{CreateRequest, DesktopState, Evaluation, Guest, Snapshot},
};
use serde_json::{Value, json};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, Webview, WebviewBuilder, WebviewUrl};
use uuid::Uuid;

use std::sync::Arc;

const PAGE_FACTORY: &str = include_str!("../../../dist-rust-bridge/page-bridge.js");
pub fn view(app: &AppHandle, guest: &Guest) -> Result<Webview, String> {
    app.get_webview(&guest.label)
        .ok_or_else(|| "网页已关闭。".into())
}
pub fn emit(app: &AppHandle, guest: &Guest, event: &str, properties: Value) {
    let _=app.emit_to("ui","browser:event",json!({"instanceId":guest.instance,"guestId":guest.snapshot.guest_id,
        "documentGeneration":guest.snapshot.document_generation,"event":event,"snapshot":guest.snapshot,"properties":properties}));
}
fn message(app: &AppHandle, id: u32, document: frames::BoundDocument, value: Value) {
    let state = app.state::<DesktopState>();
    let Ok(guest) = state.get(id) else {
        return;
    };
    if value["protocol"] != "studypilot-rust-page-v1"
        || value["documentGeneration"].as_u64() != Some(document.generation)
        || value["documentToken"].as_str() != Some(document.document_token.as_str())
    {
        return;
    }
    if value["kind"] == "evaluation-result" {
        let Some(token) = value["requestToken"].as_str() else {
            return;
        };
        let Ok(mut registry) = state.registry.lock() else {
            return;
        };
        if !registry.pending.get(token).is_some_and(|request| {
            request.guest == id
                && request.frame == document.frame_id
                && request.generation == document.generation
        }) {
            return;
        }
        if let Some(request) = registry.pending.remove(token) {
            let payload = &value["payload"];
            let result = if payload["status"] == "fulfilled" {
                Ok(json!({"protocol":"studypilot-rust-evaluation-v1","value":payload["value"]}))
            } else {
                Err(payload["error"]["message"]
                    .as_str()
                    .unwrap_or("网页执行失败或已取消。")
                    .to_string())
            };
            let _ = request.sender.send(result);
        }
    } else if value["kind"] == "event" {
        let Some(channel) = value["channel"].as_str() else {
            return;
        };
        if ![
            "studypilot:web-document",
            "studypilot:question-result",
            "studypilot:apply-answer-result",
            "studypilot:snapshot-result",
            "studypilot:execute-result",
            "studypilot:exam-next-question-result",
            "studypilot:error-log",
            "studypilot:click-debug",
            "studypilot:open-tab",
        ]
        .contains(&channel)
        {
            return;
        }
        if !super::frame_requests::handle_message(
            app,
            &guest,
            &document,
            channel,
            &value["payload"],
        ) {
            emit(
                app,
                &guest,
                "ipc-message",
                json!({"channel":channel,"args":value["payload"]}),
            );
        }
    }
}
pub(super) fn register(
    app: &AppHandle,
    request: CreateRequest,
    label: Option<String>,
) -> Result<Guest, String> {
    let state = app.state::<DesktopState>();
    {
        let mut registry = state
            .registry
            .lock()
            .map_err(|_| "Browser registry unavailable")?;
        if state
            .shutdown_started
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err("Browser is closing".into());
        }
        registry.next = registry
            .next
            .checked_add(1)
            .ok_or("Browser id budget exhausted")?;
        let id = registry.next;
        let guest = Guest {
            instance: request.instance_id,
            label: label.unwrap_or_else(|| format!("site-{id}")),
            hook: format!("__sp_{}", Uuid::new_v4().simple()),
            snapshot: Snapshot {
                guest_id: id,
                url: request.url,
                title: String::new(),
                can_go_back: false,
                can_go_forward: false,
                loading: true,
                document_generation: 0,
            },
            bounds: request.bounds,
            active: request.active,
            bridge_ready: false,
            page_ready: false,
        };
        registry.guests.insert(id, guest.clone());
        Ok(guest)
    }
}

pub(super) fn page_load(
    lifecycle: &AppHandle,
    webview: &Webview,
    id: u32,
    event: PageLoadEvent,
    url: &tauri::Url,
) {
    let state = lifecycle.state::<DesktopState>();
    let started = matches!(event, PageLoadEvent::Started);
    let current = {
        let Ok(mut registry) = state.registry.lock() else {
            return;
        };
        if started {
            let tokens: Vec<_> = registry
                .pending
                .iter()
                .filter(|(_, entry)| entry.guest == id)
                .map(|(token, _)| token.clone())
                .collect();
            for token in tokens {
                if let Some(entry) = registry.pending.remove(&token) {
                    let _ = entry.sender.send(Err("网页文档已改变。".into()));
                }
            }
        }
        let Some(guest) = registry.guests.get_mut(&id) else {
            return;
        };
        guest.page_ready = !started;
        guest.snapshot.loading = started || !guest.bridge_ready;
        guest.snapshot.url = url.to_string();
        guest.clone()
    };
    if started {
        emit(
            lifecycle,
            &current,
            "did-start-navigation",
            json!({"isMainFrame":true}),
        );
        emit(lifecycle, &current, "did-start-loading", json!({}));
    } else {
        let _ = native::refresh_history(webview, id);
        emit(
            lifecycle,
            &current,
            "did-navigate",
            json!({"isMainFrame":true}),
        );
        if current.bridge_ready {
            emit(lifecycle, &current, "dom-ready", json!({}));
            emit(lifecycle, &current, "did-stop-loading", json!({}));
        }
        let update = lifecycle.clone();
        let label = current.label.clone();
        let expected = current.snapshot.document_generation;
        let _ =
            webview.eval_with_callback("({title:document.title,url:location.href})", move |text| {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    let state = update.state::<DesktopState>();
                    let Ok(mut registry) = state.registry.lock() else {
                        return;
                    };
                    if let Some(guest) = registry.guests.values_mut().find(|guest| {
                        guest.label == label && guest.snapshot.document_generation == expected
                    }) {
                        guest.snapshot.title = value["title"].as_str().unwrap_or("").into();
                        let snapshot = guest.clone();
                        drop(registry);
                        emit(
                            &update,
                            &snapshot,
                            "page-title-updated",
                            json!({"title":snapshot.snapshot.title}),
                        );
                    }
                }
            });
    }
}

pub(super) fn install_bridge(
    app: &AppHandle,
    core: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    id: u32,
) -> Result<(), String> {
    let events = app.clone();
    frames::install(
        core,
        id,
        PAGE_FACTORY,
        Arc::new(move |event| match event {
            frames::BoundEvent::Message { document, value } => {
                message(&events, id, document, value)
            }
            frames::BoundEvent::BlockedNavigation { document, target } => {
                let app = events.clone();
                let state = app.state::<DesktopState>();
                if let Ok(mut registry) = state.registry.lock()
                    && let Some(guest) = registry.guests.get_mut(&id)
                {
                    guest.snapshot.url = document.source.clone();
                }
                let lease_stamp = super::media::source_lease_stamp(id);
                let ui_generation = state
                    .ui_generation
                    .load(std::sync::atomic::Ordering::Acquire);
                tauri::async_runtime::spawn(async move {
                    let Ok(guest) = app.state::<DesktopState>().get(id) else {
                        return;
                    };
                    if lease_stamp.is_empty()
                        || super::media::source_lease_stamp(id) != lease_stamp
                        || app
                            .state::<DesktopState>()
                            .ui_generation
                            .load(std::sync::atomic::Ordering::Acquire)
                            != ui_generation
                    {
                        return;
                    }
                    let template: Value = match serde_json::from_str(include_str!(
                        "../../../dist-rust-navigation/navigation-intent-template.json"
                    )) {
                        Ok(value) => value,
                        Err(_) => return,
                    };
                    let code = format!(
                        "{}{}{}",
                        template["head"].as_str().unwrap_or(""),
                        json!(target),
                        template["tail"].as_str().unwrap_or("")
                    );
                    if let Ok(result) = evaluate_document(&app, guest, document, code).await
                        && result["value"]["value"] == true
                        && super::media::source_lease_stamp(id) == lease_stamp
                        && app
                            .state::<DesktopState>()
                            .ui_generation
                            .load(std::sync::atomic::Ordering::Acquire)
                            == ui_generation
                    {
                        let _ = app.emit_to("ui", "browser:open-tab", json!({"url":target}));
                    }
                });
            }
            frames::BoundEvent::Started(document) => {
                if document.frame_id == 0 {
                    super::media::invalidate_source(id);
                }
                super::frame_requests::invalidate(id, &document);
                if document.frame_id == 0 {
                    let state = events.state::<DesktopState>();
                    let current = {
                        let Ok(mut registry) = state.registry.lock() else {
                            return;
                        };
                        let Some(guest) = registry.guests.get_mut(&id) else {
                            return;
                        };
                        guest.snapshot.document_generation = document.generation;
                        guest.snapshot.url = document.source;
                        guest.hook = document.hook;
                        guest.bridge_ready = false;
                        guest.page_ready = false;
                        guest.snapshot.loading = true;
                        guest.clone()
                    };
                    emit(
                        &events,
                        &current,
                        "did-start-navigation",
                        json!({"isMainFrame":true}),
                    );
                    emit(&events, &current, "did-start-loading", json!({}));
                }
            }
            frames::BoundEvent::Ready(document) => {
                if let Ok(current) = events.state::<DesktopState>().get(id) {
                    super::frame_requests::ready(&events, &current, document.clone());
                }
                if document.frame_id == 0 {
                    let state = events.state::<DesktopState>();
                    let current = {
                        let Ok(mut registry) = state.registry.lock() else {
                            return;
                        };
                        let Some(guest) = registry.guests.get_mut(&id) else {
                            return;
                        };
                        guest.snapshot.document_generation = document.generation;
                        guest.bridge_ready = true;
                        guest.snapshot.loading = !guest.page_ready;
                        guest.snapshot.url = document.source;
                        guest.hook = document.hook;
                        guest.clone()
                    };
                    if current.page_ready {
                        emit(&events, &current, "dom-ready", json!({}));
                        emit(&events, &current, "did-stop-loading", json!({}));
                    }
                }
            }
            frames::BoundEvent::LocationChanged(document) => {
                super::frame_requests::invalidate(id, &document);
                if let Ok(current) = events.state::<DesktopState>().get(id) {
                    super::frame_requests::ready(&events, &current, document.clone());
                }
                if document.frame_id == 0 {
                    let state = events.state::<DesktopState>();
                    let current = {
                        let Ok(mut registry) = state.registry.lock() else {
                            return;
                        };
                        let Some(guest) = registry.guests.get_mut(&id) else {
                            return;
                        };
                        guest.snapshot.url = document.source;
                        guest.clone()
                    };
                    emit(
                        &events,
                        &current,
                        "did-navigate-in-page",
                        json!({"isMainFrame":true}),
                    );
                }
            }
            frames::BoundEvent::Destroyed(document) => {
                super::frame_requests::invalidate(id, &document);
                let state = events.state::<DesktopState>();
                if let Ok(mut registry) = state.registry.lock() {
                    let tokens: Vec<_> = registry
                        .pending
                        .iter()
                        .filter(|(_, entry)| {
                            entry.guest == id && entry.generation == document.generation
                        })
                        .map(|(key, _)| key.clone())
                        .collect();
                    for token in tokens {
                        if let Some(entry) = registry.pending.remove(&token) {
                            let _ = entry.sender.send(Err("网页框架已关闭。".into()));
                        }
                    }
                }
            }
            frames::BoundEvent::Error { frame_id, message } => {
                eprintln!("Browser frame {frame_id} bridge: {message}");
            }
        }),
    )?;
    Ok(())
}

pub async fn create(app: &AppHandle, request: CreateRequest) -> Result<Value, String> {
    request.bounds.validate()?;
    if request.instance_id.len() > 180 || !request.instance_id.starts_with("rust-guest-") {
        return Err("Invalid browser instance".into());
    }
    let url = tauri::Url::parse(&request.url).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https" | "about") {
        return Err("网页地址协议不受支持。".into());
    }
    if let Some(key) = request.url.strip_prefix(super::popups::TAB_PREFIX) {
        return super::popups::adopt(app, key, &request);
    }
    let state = app.state::<DesktopState>();
    let guest = register(app, request, None)?;
    let id = guest.snapshot.guest_id;
    let lifecycle = app.clone();
    let navigate = app.clone();
    let popup = app.clone();
    let root = app
        .get_window("desktop")
        .ok_or("Desktop window unavailable")?;
    let result = root.add_child(
        WebviewBuilder::new(
            &guest.label,
            WebviewUrl::External(tauri::Url::parse("about:blank").map_err(|e| e.to_string())?),
        )
        .data_directory(state.data.join("sites"))
        .on_navigation(move |url| {
            if !matches!(url.scheme(), "http" | "https" | "about") {
                return false;
            }
            if super::media::source_leased(id) {
                return true;
            }
            let state = navigate.state::<DesktopState>();
            if let Ok(mut registry) = state.registry.lock()
                && let Some(guest) = registry.guests.get_mut(&id)
            {
                guest.snapshot.url = url.to_string();
            }
            true
        })
        .on_new_window(move |url, features| super::popups::open(&popup, url, features, id))
        .on_page_load(move |webview, payload| {
            page_load(&lifecycle, &webview, id, payload.event(), payload.url());
        }),
        tauri::LogicalPosition::new(guest.bounds.x, guest.bounds.y),
        tauri::LogicalSize::new(guest.bounds.width.max(1.0), guest.bounds.height.max(1.0)),
    );
    let webview = match result {
        Ok(view) => view,
        Err(error) => {
            if let Ok(mut registry) = state.registry.lock() {
                registry.guests.remove(&id);
            }
            return Err(error.to_string());
        }
    };
    let handler_app = app.clone();
    let target = url.clone();
    let target_view = webview.clone();
    let (installed, receiver) = crate::pending::channel();
    let setup: Result<(), String> = async {
        webview
            .with_webview(move |platform| {
                let result = (|| -> Result<(), String> {
                    super::raise_ui(&handler_app)?;
                    unsafe {
                        let core = platform
                            .controller()
                            .CoreWebView2()
                            .map_err(|e| e.to_string())?;
                        #[cfg(debug_assertions)]
                        super::qa::install(&core, platform.environment())
                            .map_err(|e| e.to_string())?;
                        install_bridge(&handler_app, core, id)?;
                    }
                    target_view.navigate(target).map_err(|e| e.to_string())?;
                    Ok(())
                })();
                crate::pending::send(&installed, result);
            })
            .map_err(|e| e.to_string())?;
        crate::pending::receive(receiver).await?;
        Ok(())
    }
    .await;
    if let Err(error) = setup {
        if let Ok(mut registry) = state.registry.lock() {
            registry.guests.remove(&id);
        }
        let cleanup = app.clone();
        let label = guest.label.clone();
        let _ = app.run_on_main_thread(move || {
            frames::remove(id);
            if let Some(view) = cleanup.get_webview(&label) {
                let _ = view.close();
            }
        });
        return Err(error);
    }
    if !guest.active {
        webview.hide().map_err(|e| e.to_string())?;
    }
    let snapshot = state.get(id)?.snapshot;
    serde_json::to_value(snapshot).map_err(|e| e.to_string())
}

pub(super) async fn persist_sessions(app: &AppHandle) -> Result<(), String> {
    let guests: Vec<_> = app
        .state::<DesktopState>()
        .registry
        .lock()
        .map_err(|_| "Browser registry unavailable")?
        .guests
        .values()
        .cloned()
        .collect();
    let mut first_error = None;
    for guest in guests {
        let Ok(view) = view(app, &guest) else {
            continue;
        };
        if let Err(error) = native::persist_session_cookies(&view).await {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

pub(super) fn close_views(app: &AppHandle) -> Result<(), String> {
    let guests: Vec<_> = app
        .state::<DesktopState>()
        .registry
        .lock()
        .map_err(|_| "Browser registry unavailable")?
        .guests
        .values()
        .cloned()
        .collect();
    for guest in guests {
        frames::remove(guest.snapshot.guest_id);
        if let Some(window) = app.get_webview_window(&guest.label) {
            let _ = window.destroy();
        } else if let Some(view) = app.get_webview(&guest.label) {
            let _ = view.close();
        }
    }
    Ok(())
}

pub async fn evaluate(app: &AppHandle, guest: Guest, code: String) -> Result<Value, String> {
    let document = bound_document(app, &guest).await?;
    evaluate_document(app, guest, document, code).await
}
pub async fn documents(
    app: &AppHandle,
    guest: &Guest,
) -> Result<Vec<frames::BoundDocument>, String> {
    let (reply, receiver) = crate::pending::channel();
    let id = guest.snapshot.guest_id;
    view(app, guest)?
        .with_webview(move |_| crate::pending::send(&reply, Ok(frames::documents(id))))
        .map_err(|e| e.to_string())?;
    crate::pending::receive(receiver).await
}
pub async fn evaluate_document(
    app: &AppHandle,
    guest: Guest,
    document: frames::BoundDocument,
    code: String,
) -> Result<Value, String> {
    if code.len() > 8 * 1024 * 1024 {
        return Err("网页脚本超出传输上限。".into());
    }
    let token = Uuid::new_v4().to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let state = app.state::<DesktopState>();
    state
        .registry
        .lock()
        .map_err(|_| "Browser registry unavailable")?
        .pending
        .insert(
            token.clone(),
            Evaluation {
                guest: guest.snapshot.guest_id,
                frame: document.frame_id,
                generation: document.generation,
                sender,
            },
        );
    let metadata = json!({"kind":"evaluate","documentGeneration":document.generation,"requestToken":token,"script":code,"deadline":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_millis()+15000});
    let wrapped = format!(
        "window[{}]({},()=>{{return ({});}})",
        json!(document.hook),
        metadata,
        code
    );
    let accepted = bound_script(app, &guest, document, wrapped).await;
    if !matches!(accepted, Ok(Value::Bool(true))) {
        state
            .registry
            .lock()
            .map_err(|_| "Browser registry unavailable")?
            .pending
            .remove(&token);
        return Err(format!("页面执行桥拒绝操作：{accepted:?}"));
    }
    match tokio::time::timeout(std::time::Duration::from_secs(16), receiver).await {
        Ok(Ok(value)) => value,
        _ => {
            state
                .registry
                .lock()
                .map_err(|_| "Browser registry unavailable")?
                .pending
                .remove(&token);
            Err("网页执行超时或已取消。".into())
        }
    }
}
pub async fn action(app: &AppHandle, payload: Value) -> Result<Value, String> {
    let id = payload["guestId"].as_u64().ok_or("Missing guestId")? as u32;
    let state = app.state::<DesktopState>();
    let guest = state.validate(
        id,
        payload["instanceId"].as_str().ok_or("Missing instanceId")?,
        payload["documentGeneration"].as_u64(),
    )?;
    let webview = view(app, &guest)?;
    let args = payload["args"].as_array().cloned().unwrap_or_default();
    let arg = args.first().cloned().unwrap_or(Value::Null);
    match payload["action"].as_str().unwrap_or("") {
        "executeJavaScript" => {
            evaluate(app, guest, arg.as_str().ok_or("Missing script")?.into()).await
        }
        "send" => {
            let channel = arg.as_str().ok_or("Missing channel")?;
            if ![
                "studypilot:snapshot",
                "studypilot:web-document-request",
                "studypilot:web-cancel-operation",
                "studypilot:extract-question",
                "studypilot:execute-plan",
                "studypilot:apply-answer",
                "studypilot:exam-next-question",
            ]
            .contains(&channel)
            {
                return Err("Unknown page channel".into());
            }
            if super::frame_requests::send(app, &guest, channel, args[1..].to_vec()).await? {
                return Ok(Value::Null);
            }
            let document = bound_document(app, &guest).await?;
            let code = format!(
                "window[{}]({})",
                json!(document.hook),
                json!({"kind":"ipc","documentGeneration":document.generation,"channel":channel,"args":&args[1..]})
            );
            if bound_script(app, &guest, document, code).await? != Value::Bool(true) {
                return Err("页面桥拒绝请求。".into());
            }
            Ok(Value::Null)
        }
        "loadURL" => {
            let url =
                tauri::Url::parse(arg.as_str().ok_or("Missing URL")?).map_err(|e| e.to_string())?;
            if !matches!(url.scheme(), "http" | "https" | "about") {
                return Err("Unsupported navigation URL".into());
            }
            webview.navigate(url).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "reload" => {
            webview.reload().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "stop" => {
            native::cdp(&webview, "Page.stopLoading", json!({})).await?;
            Ok(Value::Null)
        }
        "goBack" | "goForward" => {
            evaluate(
                app,
                guest,
                if payload["action"] == "goBack" {
                    "history.back()"
                } else {
                    "history.forward()"
                }
                .into(),
            )
            .await
        }
        "focus" => {
            native::focus(&webview).await?;
            Ok(Value::Null)
        }
        "sendInputEvent" => {
            if arg["keyCode"] != "Enter" {
                return Err("Unsupported native input key".into());
            }
            native::key_event(
                &webview,
                id,
                guest.snapshot.document_generation,
                arg["type"] == "keyDown",
            )
            .await?;
            Ok(Value::Null)
        }
        _ => Err("Unknown browser action".into()),
    }
}
pub async fn layout(app: &AppHandle, payload: Value) -> Result<Value, String> {
    let id = payload["guestId"].as_u64().ok_or("Missing guestId")? as u32;
    let state = app.state::<DesktopState>();
    let old = state.validate(
        id,
        payload["instanceId"].as_str().ok_or("Missing instanceId")?,
        None,
    )?;
    let bounds: crate::geometry::CssRect =
        serde_json::from_value(payload["bounds"].clone()).map_err(|e| e.to_string())?;
    bounds.validate()?;
    let active = payload["active"].as_bool().unwrap_or(false);
    let webview = view(app, &old)?;
    if let Some(window) = app.get_webview_window(&old.label) {
        super::popups::layout(&window, bounds, active)?;
    } else {
        webview
            .set_bounds(tauri::Rect {
                position: tauri::LogicalPosition::new(bounds.x, bounds.y).into(),
                size: tauri::LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)).into(),
            })
            .map_err(|e| e.to_string())?;
        if active {
            webview.show()
        } else {
            webview.hide()
        }
        .map_err(|e| e.to_string())?;
        if active {
            let main = app.clone();
            let (reply, receiver) = crate::pending::channel();
            app.run_on_main_thread(move || crate::pending::send(&reply, super::raise_ui(&main)))
                .map_err(|e| e.to_string())?;
            crate::pending::receive(receiver).await?;
        }
    }
    if let Ok(mut registry) = state.registry.lock()
        && let Some(guest) = registry.guests.get_mut(&id)
    {
        if guest.bounds != bounds || guest.active != active {
            state
                .layout_generation
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        }
        guest.bounds = bounds;
        guest.active = active;
    }
    Ok(Value::Null)
}
pub async fn destroy(app: &AppHandle, payload: Value) -> Result<Value, String> {
    let id = payload["guestId"].as_u64().ok_or("Missing guestId")? as u32;
    let state = app.state::<DesktopState>();
    let guest = state.validate(
        id,
        payload["instanceId"].as_str().ok_or("Missing instanceId")?,
        None,
    )?;
    if super::media::guest_leased(id) {
        return Err("答题任务仍在使用该标签页。".into());
    }
    super::media::invalidate_guest(id);
    super::frame_requests::remove(id);
    if let Ok(mut registry) = state.registry.lock() {
        registry.guests.remove(&id);
        let tokens: Vec<_> = registry
            .pending
            .iter()
            .filter(|(_, entry)| entry.guest == id)
            .map(|(key, _)| key.clone())
            .collect();
        for token in tokens {
            if let Some(entry) = registry.pending.remove(&token) {
                let _ = entry.sender.send(Err("网页已关闭。".into()));
            }
        }
    }
    let webview = view(app, &guest)?;
    let (reply, receiver) = crate::pending::channel();
    app.run_on_main_thread(move || {
        frames::remove(id);
        crate::pending::send(&reply, Ok(()));
    })
    .map_err(|e| e.to_string())?;
    crate::pending::receive(receiver).await?;
    if let Some(window) = app.get_webview_window(&guest.label) {
        window.destroy().map_err(|e| e.to_string())?;
    } else {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(Value::Null)
}

async fn bound_document(app: &AppHandle, guest: &Guest) -> Result<frames::BoundDocument, String> {
    let (reply, receiver) = crate::pending::channel();
    let id = guest.snapshot.guest_id;
    view(app, guest)?
        .with_webview(move |_| {
            crate::pending::send(
                &reply,
                frames::main_frame(id).ok_or_else(|| "网页执行桥尚未就绪。".to_string()),
            );
        })
        .map_err(|e| e.to_string())?;
    crate::pending::receive(receiver).await
}
async fn bound_script(
    app: &AppHandle,
    guest: &Guest,
    document: frames::BoundDocument,
    code: String,
) -> Result<Value, String> {
    let (reply, receiver) = crate::pending::channel();
    let error_reply = Arc::clone(&reply);
    let id = guest.snapshot.guest_id;
    view(app, guest)?
        .with_webview(move |_| {
            if let Err(error) = frames::dispatch(
                id,
                document.frame_id,
                document.generation,
                &code,
                Box::new(move |result| crate::pending::send(&reply, result)),
            ) {
                crate::pending::send(&error_reply, Err(error));
            }
        })
        .map_err(|e| e.to_string())?;
    crate::pending::receive(receiver).await
}
