pub mod geometry;
pub mod policy;
pub mod services;

#[cfg(windows)]
mod desktop;
#[cfg(windows)]
pub use desktop::run as run_desktop;

#[cfg(windows)]
mod capture;
#[cfg(windows)]
mod composition;
#[cfg(windows)]
mod input;
#[cfg(windows)]
mod pending;
#[cfg(windows)]
mod state;

#[cfg(windows)]
mod host {
    use crate::{
        capture::{self, CaptureReply, CaptureRequest},
        composition::{self, LayoutReply, LayoutRequest},
        input, pending,
        policy::{FixtureTarget, is_bundled_ui},
        state::PocState,
    };
    use serde::Deserialize;
    use serde_json::{Value, json};
    use std::time::Instant;
    use tauri::webview::{NewWindowResponse, PageLoadEvent};
    use tauri::{
        AppHandle, Manager, State, Webview, WebviewWindow, WebviewWindowBuilder, WindowEvent,
    };

    fn require_ui(caller: &Webview) -> Result<(), String> {
        let url = caller.url().map_err(|e| e.to_string())?;
        if caller.label() != "ui" || !is_bundled_ui(&url) {
            return Err("Only the bundled POC UI may call host commands".into());
        }
        // Frame isolation is also enforced by CSP frame-src 'none'. A top-level
        // Webview label/URL check must never be mistaken for iframe identity.
        Ok(())
    }

    fn guest(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
        app.get_webview_window(label)
            .ok_or_else(|| format!("POC guest {label} is unavailable"))
    }

    async fn eval_json(window: &WebviewWindow, script: &'static str) -> Result<Value, String> {
        let (reply, receiver) = pending::channel();
        window
            .eval_with_callback(script, move |value| {
                let result = if value.len() > 64 * 1024 {
                    Err("POC probe response exceeds its budget".into())
                } else {
                    serde_json::from_str(&value).map_err(|e| format!("Invalid POC probe JSON: {e}"))
                };
                pending::send(&reply, result);
            })
            .map_err(|e| e.to_string())?;
        pending::receive(receiver).await
    }

    const PROBE: &str = r#"(() => {
        try {
            const s = window.pocFixtureState;
            if (!s) return { ok: false, error: 'The selected document is not the R1 fixture' };
            return { ok: true, clicks: s.clicks, scrollY: window.scrollY,
                submissions: s.submissions, trustedEnters: s.trustedEnters,
                untrustedEnters: s.untrustedEnters, ticks: s.ticks,
                lastEvent: s.lastEvent, permission: s.permission,
                lastPointer: s.lastPointer, drops: s.drops,
                guestViewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
                background: !!window.__POC_BACKGROUND__, focused: document.hasFocus(),
                editorText: document.querySelector('[data-poc-editor]')?.value || '' };
        } catch (error) { return { ok: false, error: String(error) }; }
    })()"#;

    const FOCUS_EDITOR: &str = r#"(() => {
        try {
            const editor = document.querySelector('[data-poc-editor]');
            if (!editor) return { ok: false, error: 'R1 fixture editor is missing' };
            editor.focus({ preventScroll: true });
            return { ok: true };
        } catch (error) { return { ok: false, error: String(error) }; }
    })()"#;

    async fn probe(app: &AppHandle, state: &PocState, label: &str) -> Result<Value, String> {
        let generation = state.ready_generation(label)?;
        let window = guest(app, label)?;
        let url = window.url().map_err(|e| e.to_string())?;
        if !state.fixture.allows(&url) {
            return Err("Guest left the fixed POC fixture URL".into());
        }
        let value = eval_json(&window, PROBE).await?;
        state.check_generation(label, generation)?;
        if value.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err("The selected document did not answer the R1 fixture probe".into());
        }
        Ok(value)
    }

    #[derive(Clone, Copy, Deserialize)]
    #[serde(rename_all = "lowercase")]
    enum ProbeTarget {
        Guest,
        Background,
    }

    impl ProbeTarget {
        fn label(self) -> &'static str {
            match self {
                Self::Guest => "guest",
                Self::Background => "background",
            }
        }
    }

    #[tauri::command]
    async fn poc_info(caller: Webview, state: State<'_, PocState>) -> Result<Value, String> {
        require_ui(&caller)?;
        Ok(json!({
            "host": "rust-tauri-webview2-r1-poc", "fixture": state.fixture.description(),
            "guest": state.document("guest").ok(), "background": state.document("background").ok(),
            "layoutEpoch": state.epoch(), "runtimeVerified": false,
        }))
    }

    #[tauri::command]
    async fn poc_layout(
        caller: Webview,
        app: AppHandle,
        request: LayoutRequest,
    ) -> Result<LayoutReply, String> {
        require_ui(&caller)?;
        let ui = app
            .get_webview_window("ui")
            .ok_or("POC UI is unavailable")?;
        composition::apply_regions(ui, request).await
    }

    #[tauri::command]
    async fn poc_probe(
        caller: Webview,
        app: AppHandle,
        state: State<'_, PocState>,
        target: Option<ProbeTarget>,
    ) -> Result<Value, String> {
        require_ui(&caller)?;
        probe(&app, &state, target.unwrap_or(ProbeTarget::Guest).label()).await
    }

    #[tauri::command]
    async fn poc_capture(
        caller: Webview,
        app: AppHandle,
        state: State<'_, PocState>,
        request: CaptureRequest,
    ) -> Result<CaptureReply, String> {
        require_ui(&caller)?;
        let started = Instant::now();
        let generation = state.ready_generation("guest")?;
        let layout_epoch = state.epoch();
        let window = guest(&app, "guest")?;
        if window.is_minimized().map_err(|error| error.to_string())?
            || !window.is_visible().map_err(|error| error.to_string())?
        {
            return Err("Capture is paused while the guest is hidden or minimized".into());
        }
        if !state
            .fixture
            .allows(&window.url().map_err(|e| e.to_string())?)
        {
            return Err("Guest left the fixed POC fixture URL".into());
        }
        let viewport = request.viewport.validate()?;
        request.region.validate()?;
        let size = window.inner_size().map_err(|e| e.to_string())?;
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        if viewport.x.abs() > 1.0
            || viewport.y.abs() > 1.0
            || (viewport.width * scale - f64::from(size.width)).abs() > 3.0
            || (viewport.height * scale - f64::from(size.height)).abs() > 3.0
        {
            return Err(
                "UI and guest viewport geometry changed; retry after layout settles".into(),
            );
        }
        let png = capture::guest_png(&window, &state.capture_busy).await?;
        state.check_generation("guest", generation)?;
        if state.epoch() != layout_epoch {
            return Err("Layout changed during guest capture".into());
        }
        let (data_url, bounds, sampled_size) =
            tauri::async_runtime::spawn_blocking(move || capture::bounded_sample(png, request))
                .await
                .map_err(|e| format!("Guest sample worker stopped: {e}"))??;
        state.check_generation("guest", generation)?;
        if state.epoch() != layout_epoch {
            return Err("Layout changed during guest sampling".into());
        }
        Ok(CaptureReply {
            data_url,
            bounds,
            sampled_size,
            layout_epoch,
            document_generation: generation,
            elapsed_ms: started.elapsed().as_millis(),
        })
    }

    #[tauri::command]
    async fn poc_enter(
        caller: Webview,
        app: AppHandle,
        state: State<'_, PocState>,
    ) -> Result<Value, String> {
        require_ui(&caller)?;
        let _transaction = state
            .input_transaction
            .try_lock()
            .map_err(|_| "A guest input transaction is already in progress")?;
        let generation = state.ready_generation("guest")?;
        let before = probe(&app, &state, "guest").await?;
        let window = guest(&app, "guest")?;
        let focused = eval_json(&window, FOCUS_EDITOR).await?;
        if focused.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err("Could not select the R1 fixture editor".into());
        }
        state.check_generation("guest", generation)?;
        input::send_enter(&window, &state.input_busy, generation).await?;
        state.check_generation("guest", generation)?;
        let after = probe(&app, &state, "guest").await?;
        let expected = before
            .get("submissions")
            .and_then(Value::as_u64)
            .and_then(|value| value.checked_add(1))
            .ok_or("Invalid R1 fixture counter")?;
        if after.get("submissions").and_then(Value::as_u64) != Some(expected)
            || after.pointer("/lastEvent/trusted").and_then(Value::as_bool) != Some(true)
        {
            return Err("Guest did not observe exactly one trusted Enter submission".into());
        }
        Ok(json!({ "before": before, "after": after, "trustedEnter": true }))
    }

    #[tauri::command]
    async fn poc_focus(
        caller: Webview,
        app: AppHandle,
        state: State<'_, PocState>,
    ) -> Result<(), String> {
        require_ui(&caller)?;
        let _transaction = state
            .input_transaction
            .try_lock()
            .map_err(|_| "A guest input transaction is already in progress")?;
        state.ready_generation("guest")?;
        let window = guest(&app, "guest")?;
        input::focus_guest(&window).await?;
        let result = eval_json(&window, FOCUS_EDITOR).await?;
        if result.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err("R1 fixture editor was not found".into());
        }
        Ok(())
    }

    pub fn run() -> tauri::Result<()> {
        tauri::Builder::default()
            .setup(|app| {
                let override_value = std::env::var("STUDYPILOT_POC_URL").ok();
                let fixture = FixtureTarget::from_override(override_value.as_deref())
                    .map_err(std::io::Error::other)?;
                app.manage(PocState::new(fixture.clone()));
                let guest_policy = fixture.clone();
                let guest = WebviewWindowBuilder::new(app, "guest", fixture.webview_url())
                    .title("StudyPilot R1 POC · local guest fixture")
                    .inner_size(1200.0, 800.0)
                    .min_inner_size(760.0, 560.0)
                    .on_navigation(move |url| guest_policy.allows(url))
                    .on_new_window(|_, _| NewWindowResponse::Deny)
                    .on_page_load(|window, payload| {
                        if let Err(error) = window
                            .state::<PocState>()
                            .page_load("guest", matches!(payload.event(), PageLoadEvent::Finished))
                        {
                            eprintln!("R1 guest lifecycle: {error}");
                        }
                    })
                    .build()?;
                let background_policy = fixture.clone();
                WebviewWindowBuilder::new(app, "background", fixture.webview_url())
                    .title("R1 POC background guest")
                    .visible(false)
                    .skip_taskbar(true)
                    .initialization_script("window.__POC_BACKGROUND__ = true;")
                    .on_navigation(move |url| background_policy.allows(url))
                    .on_new_window(|_, _| NewWindowResponse::Deny)
                    .on_page_load(|window, payload| {
                        if let Err(error) = window.state::<PocState>().page_load(
                            "background",
                            matches!(payload.event(), PageLoadEvent::Finished),
                        ) {
                            eprintln!("R1 background lifecycle: {error}");
                        }
                    })
                    .build()?;
                WebviewWindowBuilder::new(app, "ui", tauri::WebviewUrl::App("ui.html".into()))
                    .title("R1 trusted UI overlay")
                    .owner(&guest)?
                    .inner_size(1200.0, 800.0)
                    .transparent(true)
                    .decorations(false)
                    .shadow(false)
                    .skip_taskbar(true)
                    .focused(false)
                    .visible(false)
                    .on_navigation(is_bundled_ui)
                    .on_new_window(|_, _| NewWindowResponse::Deny)
                    .build()?;
                composition::sync_owned_overlay(app.handle()).map_err(std::io::Error::other)?;
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                poc_info,
                poc_layout,
                poc_capture,
                poc_probe,
                poc_enter,
                poc_focus
            ])
            .on_window_event(|window, event| {
                if window.label() == "guest" {
                    match event {
                        WindowEvent::Moved(_)
                        | WindowEvent::Resized(_)
                        | WindowEvent::ScaleFactorChanged { .. } => {
                            if let Err(error) = composition::sync_owned_overlay(window.app_handle())
                            {
                                eprintln!("R1 overlay geometry: {error}");
                            }
                        }
                        WindowEvent::Destroyed => window.app_handle().exit(0),
                        _ => {}
                    }
                } else if window.label() == "ui"
                    && matches!(event, WindowEvent::CloseRequested { .. })
                    && let Some(guest) = window.app_handle().get_webview_window("guest")
                    && let Err(error) = guest.close()
                {
                    eprintln!("R1 close: {error}");
                }
            })
            .run(tauri::generate_context!())
    }
}

#[cfg(windows)]
pub use host::run;
