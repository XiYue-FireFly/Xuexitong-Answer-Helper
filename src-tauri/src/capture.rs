use crate::{
    geometry::{CssRect, crop_rect, validate_bitmap},
    pending::{self, Permit},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::sync::{Arc, atomic::AtomicBool};
use tauri::WebviewWindow;
use webview2_com::{
    CapturePreviewCompletedHandler,
    Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
};
use windows::Win32::{
    Foundation::HGLOBAL,
    System::Com::{
        IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET,
        StructuredStorage::CreateStreamOnHGlobal,
    },
};

const MAX_PNG_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize)]
pub struct CaptureRequest {
    pub region: CssRect,
    pub viewport: CssRect,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureReply {
    pub data_url: String,
    pub bounds: CssRect,
    pub sampled_size: [u32; 2],
    pub layout_epoch: u64,
    pub document_generation: u64,
    pub elapsed_ms: u128,
}

pub(crate) unsafe fn read_png(stream: &IStream) -> windows::core::Result<Vec<u8>> {
    let mut stat = STATSTG::default();
    unsafe {
        stream.Stat(&mut stat, STATFLAG_NONAME)?;
        if stat.cbSize == 0 || stat.cbSize > MAX_PNG_BYTES {
            return Err(windows::core::Error::new(
                windows::core::HRESULT(0x80070057u32 as i32),
                "Invalid capture stream size",
            ));
        }
        let mut bytes = vec![0u8; stat.cbSize as usize];
        stream.Seek(0, STREAM_SEEK_SET, None)?;
        let mut read = 0u32;
        stream
            .Read(
                bytes.as_mut_ptr().cast(),
                bytes.len() as u32,
                Some(&mut read),
            )
            .ok()?;
        if u64::from(read) != stat.cbSize {
            return Err(windows::core::Error::new(
                windows::core::HRESULT(0x80004005u32 as i32),
                "Incomplete capture stream",
            ));
        }
        Ok(bytes)
    }
}

pub async fn guest_png(guest: &WebviewWindow, busy: &Arc<AtomicBool>) -> Result<Vec<u8>, String> {
    let size = guest.inner_size().map_err(|e| e.to_string())?;
    validate_bitmap((size.width, size.height))?;
    if !guest.is_visible().map_err(|e| e.to_string())?
        || guest.is_minimized().map_err(|e| e.to_string())?
    {
        return Err("Capture is paused while the guest is hidden or minimized".into());
    }
    let permit = Permit::acquire(busy)?;
    let (reply, receiver) = pending::channel();
    guest
        .with_webview(move |platform| {
            let on_error = Arc::clone(&reply);
            let result = (|| -> windows::core::Result<()> {
                unsafe {
                    let core = platform.controller().CoreWebView2()?;
                    let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)?;
                    let retained = stream.clone();
                    let callback =
                        CapturePreviewCompletedHandler::create(Box::new(move |status| {
                            let _permit = permit;
                            let result = status
                                .and_then(|()| read_png(&retained))
                                .map_err(|e| e.to_string());
                            pending::send(&reply, result);
                            Ok(())
                        }));
                    core.CapturePreview(
                        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                        &stream,
                        &callback,
                    )?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                pending::send(&on_error, Err(error.to_string()));
            }
        })
        .map_err(|e| e.to_string())?;
    pending::receive(receiver).await
}

pub fn bounded_sample(
    png: Vec<u8>,
    request: CaptureRequest,
) -> Result<(String, CssRect, [u32; 2]), String> {
    let mut reader = ImageReader::with_format(Cursor::new(png), ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(160 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|e| format!("Could not decode guest PNG: {e}"))?;
    let (rect, bounds) = crop_rect(
        request.region,
        request.viewport,
        (image.width(), image.height()),
    )?;
    let sampled = image
        .crop_imm(rect[0], rect[1], rect[2], rect[3])
        .thumbnail(1200, 1200);
    let size = [sampled.width(), sampled.height()];
    let mut encoded = Cursor::new(Vec::new());
    sampled
        .write_to(&mut encoded, ImageFormat::Png)
        .map_err(|e| format!("Could not encode guest sample: {e}"))?;
    let encoded = encoded.into_inner();
    if encoded.len() > 8 * 1024 * 1024 {
        return Err("Sampled PNG exceeds the POC response budget".into());
    }
    Ok((
        format!("data:image/png;base64,{}", STANDARD.encode(encoded)),
        bounds,
        size,
    ))
}
