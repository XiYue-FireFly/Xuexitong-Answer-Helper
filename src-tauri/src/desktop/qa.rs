//! Debug-build-only local fixture routing. Release binaries exclude this module.
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
use tauri::Url;
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT, ICoreWebView2, ICoreWebView2Environment,
    },
    WebResourceRequestedEventHandler,
};
use windows::{
    Win32::{
        Foundation::HGLOBAL,
        System::Com::{CoTaskMemFree, STREAM_SEEK_SET, StructuredStorage::CreateStreamOnHGlobal},
    },
    core::{HSTRING, PWSTR},
};
static ROUTES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
pub fn route(host: &str, html: &str) -> Result<(), String> {
    if !matches!(
        host,
        "chat.deepseek.com" | "www.doubao.com" | "www.qianwen.com"
    ) || html.len() > 256 * 1024
    {
        return Err("Invalid debug AI fixture".into());
    }
    ROUTES
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Fixture lock unavailable")?
        .insert(host.into(), html.into());
    Ok(())
}
pub fn install(
    core: &ICoreWebView2,
    environment: ICoreWebView2Environment,
) -> windows::core::Result<()> {
    unsafe {
        core.AddWebResourceRequestedFilter(
            &HSTRING::from("https://*/*"),
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
        )?;
        let mut token = 0;
        core.add_WebResourceRequested(
            &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let request = args.Request()?;
                    let mut raw = PWSTR::null();
                    request.Uri(&mut raw)?;
                    let url = raw.to_string();
                    CoTaskMemFree(Some(raw.0.cast()));
                    if let Ok(url) = url
                        && let Ok(url) = Url::parse(&url)
                    {
                        let html = ROUTES
                            .get_or_init(Default::default)
                            .lock()
                            .ok()
                            .and_then(|map| map.get(url.host_str().unwrap_or("")).cloned());
                        if let Some(html) = html {
                            let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)?;
                            stream
                                .Write(html.as_ptr().cast(), html.len() as u32, None)
                                .ok()?;
                            stream.Seek(0, STREAM_SEEK_SET, None)?;
                            let response = environment.CreateWebResourceResponse(
                                &stream,
                                200,
                                &HSTRING::from("OK"),
                                &HSTRING::from("Content-Type: text/html; charset=utf-8\r\n"),
                            )?;
                            args.SetResponse(&response)?;
                        }
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}
