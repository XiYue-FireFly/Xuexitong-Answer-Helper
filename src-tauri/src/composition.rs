use crate::{
    geometry::{CssRect, CssRegion, PhysicalRegion, physical_rounded_regions},
    pending,
    state::PocState,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, WebviewWindow};
use windows::Win32::Graphics::Gdi::{
    CombineRgn, CreateEllipticRgn, CreateRectRgn, DeleteObject, HGDIOBJ, HRGN, RGN_AND, RGN_DIFF,
    RGN_OR, SetWindowRgn,
};
use windows::Win32::UI::WindowsAndMessaging::{
    SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos, ShowWindow,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutRequest {
    pub revision: u64,
    #[serde(default)]
    pub document_generation: Option<u64>,
    pub blocked: bool,
    pub regions: Vec<CssRegion>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutReply {
    pub layout_epoch: u64,
    pub revision: u64,
    pub physical_size: [u32; 2],
    pub scale_factor: f64,
}

struct Region(HRGN);

impl Region {
    fn checked(handle: HRGN) -> Result<Self, String> {
        if handle.0.is_null() {
            return Err("Could not allocate native input region".into());
        }
        Ok(Self(handle))
    }
}

impl Drop for Region {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(self.0.0));
        }
    }
}

fn layout_update_allowed(
    actual: Option<u64>,
    requested: Option<u64>,
    applied: u64,
    revision: u64,
    last: u64,
) -> Result<bool, String> {
    if let Some(actual) = actual {
        if requested != Some(actual) {
            return Err("Native UI layout belongs to an expired document".into());
        }
        if applied != actual {
            return Ok(true);
        }
    }
    Ok(revision > last)
}

/// Win32 has only uniform RoundRect regions. Subtract each corner's outside
/// ellipse independently to preserve the four actual CSS elliptical corners.
fn rounded_region(region: PhysicalRegion, offset: (i32, i32)) -> Result<Region, String> {
    let [left, top, right, bottom] = region.bounds;
    let [left, top, right, bottom] = [
        left + offset.0,
        top + offset.1,
        right + offset.0,
        bottom + offset.1,
    ];
    unsafe {
        let shape = Region::checked(CreateRectRgn(left, top, right, bottom))?;
        for (corner, [rx, ry]) in region.radii.into_iter().enumerate() {
            if rx == 0 || ry == 0 {
                continue;
            }
            let x = if corner == 0 || corner == 3 {
                left
            } else {
                right - 2 * rx
            };
            let y = if corner < 2 { top } else { bottom - 2 * ry };
            let ellipse = Region::checked(CreateEllipticRgn(x, y, x + 2 * rx, y + 2 * ry))?;
            let box_x = if corner == 0 || corner == 3 {
                left
            } else {
                right - rx
            };
            let box_y = if corner < 2 { top } else { bottom - ry };
            let outside = Region::checked(CreateRectRgn(box_x, box_y, box_x + rx, box_y + ry))?;
            if CombineRgn(Some(outside.0), Some(outside.0), Some(ellipse.0), RGN_DIFF).0 == 0
                || CombineRgn(Some(shape.0), Some(shape.0), Some(outside.0), RGN_DIFF).0 == 0
            {
                return Err("Could not construct native corner regions".into());
            }
        }
        let [l, t, r, b] = region.clip;
        let clip = Region::checked(CreateRectRgn(
            l + offset.0,
            t + offset.1,
            r + offset.0,
            b + offset.1,
        ))?;
        if CombineRgn(Some(shape.0), Some(shape.0), Some(clip.0), RGN_AND).0 == 0 {
            return Err("Could not clip native input region".into());
        }
        Ok(shape)
    }
}

/// Tauri's show() uses SW_SHOW on Windows, which may activate this overlay.
/// Creation-time focused(false) does not protect later show/restore calls.
fn show_without_activation(ui: &WebviewWindow) -> Result<(), String> {
    if !ui.is_visible().map_err(|error| error.to_string())? {
        unsafe {
            // The return value reports prior visibility, not operation failure.
            let _ = ShowWindow(
                ui.hwnd().map_err(|error| error.to_string())?,
                SW_SHOWNOACTIVATE,
            );
        }
    }
    Ok(())
}

/// Called by Tauri's native window callback, which already runs on the GUI STA.
pub fn sync_owned_overlay(app: &AppHandle) -> Result<(), String> {
    let Some(guest) = app.get_webview_window("guest") else {
        return Ok(());
    };
    let Some(ui) = app.get_webview_window("ui") else {
        return Ok(());
    };
    let minimized = guest.is_minimized().map_err(|e| e.to_string())?;
    if minimized {
        ui.hide().map_err(|e| e.to_string())?;
        return Ok(());
    }
    // inner_position is the client origin in physical SCREEN coordinates.
    let origin = guest.inner_position().map_err(|e| e.to_string())?;
    let size = guest.inner_size().map_err(|e| e.to_string())?;
    if size.width == 0 || size.height == 0 {
        return Ok(());
    }
    unsafe {
        SetWindowPos(
            ui.hwnd().map_err(|e| e.to_string())?,
            None,
            origin.x,
            origin.y,
            size.width as i32,
            size.height as i32,
            SWP_NOACTIVATE | SWP_NOZORDER,
        )
        .map_err(|e| e.to_string())?;
    }
    let state = app.state::<PocState>();
    state.invalidate_layout();
    if state.region_revision.load(Ordering::Acquire) > 0 {
        show_without_activation(&ui)?;
    }
    Ok(())
}

pub async fn apply_regions(
    ui: WebviewWindow,
    request: LayoutRequest,
) -> Result<LayoutReply, String> {
    if request.revision == 0 || request.regions.len() > 32 {
        return Err("Invalid POC layout revision or region count".into());
    }
    // Reject malformed data even when a blocked layout does not need the islands.
    for region in &request.regions {
        region.normalized_radii()?;
    }
    let (reply, receiver) = pending::channel();
    let native_ui = ui.clone();
    ui.run_on_main_thread(move || {
        let result = (|| {
            let state = native_ui.state::<PocState>();
            let actual_generation = native_ui
                .try_state::<crate::desktop::state::DesktopState>()
                .map(|desktop| desktop.ui_generation.load(Ordering::Acquire));
            let scale = native_ui.scale_factor().map_err(|e| e.to_string())?;
            let size = native_ui.inner_size().map_err(|e| e.to_string())?;
            let revision = state.region_revision.load(Ordering::Acquire);
            let applied = state.region_document_generation.load(Ordering::Acquire);
            if layout_update_allowed(
                actual_generation,
                request.document_generation,
                applied,
                request.revision,
                revision,
            )? {
                let full = [CssRegion {
                    rect: CssRect {
                        x: 0.0,
                        y: 0.0,
                        width: f64::from(size.width) / scale,
                        height: f64::from(size.height) / scale,
                    },
                    radii: Some([[0.0; 2]; 4]),
                }];
                let rectangles = physical_rounded_regions(
                    if request.blocked {
                        &full
                    } else {
                        &request.regions
                    },
                    scale,
                    (size.width, size.height),
                )?;
                // SetWindowRgn uses WINDOW-relative pixels, including non-client area.
                let client = native_ui.inner_position().map_err(|e| e.to_string())?;
                let outer = native_ui.outer_position().map_err(|e| e.to_string())?;
                let offset = (client.x - outer.x, client.y - outer.y);
                unsafe {
                    let combined = Region::checked(CreateRectRgn(0, 0, 0, 0))?;
                    for rectangle in rectangles {
                        let shape = rounded_region(rectangle, offset)?;
                        if CombineRgn(Some(combined.0), Some(combined.0), Some(shape.0), RGN_OR).0
                            == 0
                        {
                            return Err("Could not combine native input regions".into());
                        }
                    }
                    if SetWindowRgn(
                        native_ui.hwnd().map_err(|e| e.to_string())?,
                        Some(combined.0),
                        true,
                    ) == 0
                    {
                        return Err("SetWindowRgn failed".into());
                    }
                    // The OS owns this final HRGN after a successful call.
                    std::mem::forget(combined);
                }
                state
                    .region_revision
                    .store(request.revision, Ordering::Release);
                if let Some(generation) = actual_generation {
                    state
                        .region_document_generation
                        .store(generation, Ordering::Release);
                }
                state.invalidate_layout();
                if let Some(guest) = native_ui.app_handle().get_webview_window("guest")
                    && !guest.is_minimized().map_err(|e| e.to_string())?
                {
                    show_without_activation(&native_ui)?;
                }
                if let Some(desktop) = native_ui.app_handle().get_window("desktop")
                    && !desktop.is_minimized().map_err(|e| e.to_string())?
                {
                    show_without_activation(&native_ui)?;
                }
            }
            Ok(LayoutReply {
                layout_epoch: state.epoch(),
                revision: state.region_revision.load(Ordering::Acquire),
                physical_size: [size.width, size.height],
                scale_factor: scale,
            })
        })();
        pending::send(&reply, result);
    })
    .map_err(|e| e.to_string())?;
    pending::receive(receiver).await
}

#[cfg(test)]
mod tests {
    use super::{LayoutRequest, rounded_region};
    use crate::geometry::{CssRect, CssRegion, physical_rounded_regions};
    use windows::Win32::Graphics::Gdi::PtInRegion;

    #[test]
    fn reloaded_ui_applies_revision_one_and_rejects_old_documents_even_with_higher_revisions()
    -> Result<(), String> {
        assert!(super::layout_update_allowed(Some(4), Some(4), 3, 1, 900)?);
        assert!(super::layout_update_allowed(Some(4), Some(3), 4, 901, 1).is_err());
        assert!(!super::layout_update_allowed(Some(4), Some(4), 4, 1, 1)?);
        assert!(super::layout_update_allowed(Some(4), None, 4, 2, 1).is_err());
        assert!(super::layout_update_allowed(None, None, 0, 2, 1)?);
        Ok(())
    }

    #[test]
    fn native_capsule_has_no_rectangular_corner_shelf_and_keeps_square_bars() -> Result<(), String>
    {
        let physical = physical_rounded_regions(
            &[
                CssRegion {
                    rect: CssRect {
                        x: 0.0,
                        y: 0.0,
                        width: 600.0,
                        height: 60.0,
                    },
                    radii: Some([[30.0, 30.0]; 4]),
                },
                CssRegion {
                    rect: CssRect {
                        x: 0.0,
                        y: 0.0,
                        width: 600.0,
                        height: 60.0,
                    },
                    radii: Some([[0.0, 0.0]; 4]),
                },
            ],
            1.0,
            (800, 600),
        )?;
        let capsule = rounded_region(physical[0], (0, 0))?;
        let square = rounded_region(physical[1], (0, 0))?;
        unsafe {
            assert!(!PtInRegion(capsule.0, 3, 3).as_bool());
            assert!(PtInRegion(capsule.0, 300, 3).as_bool());
            assert!(PtInRegion(square.0, 3, 3).as_bool());
        }
        Ok(())
    }
    #[test]
    fn offscreen_capsule_is_clipped_without_rounding_a_new_corner() -> Result<(), String> {
        let physical = physical_rounded_regions(
            &[CssRegion {
                rect: CssRect {
                    x: -30.0,
                    y: 0.0,
                    width: 100.0,
                    height: 60.0,
                },
                radii: Some([[30.0, 30.0]; 4]),
            }],
            1.0,
            (200, 200),
        )?;
        let shape = rounded_region(physical[0], (0, 0))?;
        unsafe {
            assert!(PtInRegion(shape.0, 0, 3).as_bool());
            assert!(!PtInRegion(shape.0, -1, 30).as_bool());
            assert!(!PtInRegion(shape.0, 68, 3).as_bool());
        }
        Ok(())
    }
    #[test]
    fn blocked_and_legacy_layout_payloads_remain_compatible() -> Result<(), String> {
        let request:LayoutRequest=serde_json::from_value(serde_json::json!({"revision":1,"blocked":true,"regions":[{"x":0,"y":0,"width":100,"height":60}]})).map_err(|error|error.to_string())?;
        assert!(request.blocked);
        assert_eq!(request.regions[0].normalized_radii()?, [[12.0; 2]; 4]);
        Ok(())
    }
}
