use serde::{Deserialize, Serialize};

pub const MAX_EDGE: u32 = 8192;
pub const MAX_PIXELS: u64 = 33_554_432;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl CssRect {
    pub fn validate(self) -> Result<Self, String> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|n| !n.is_finite())
            || self.width <= 0.0
            || self.height <= 0.0
            || self.width > f64::from(MAX_EDGE)
            || self.height > f64::from(MAX_EDGE)
        {
            return Err("Invalid or oversized CSS rectangle".into());
        }
        Ok(self)
    }
}

/// Clockwise top-left, top-right, bottom-right, bottom-left elliptical radii.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct CssRegion {
    #[serde(flatten)]
    pub rect: CssRect,
    /// Old POC clients did not send radii and retain their 12 CSS px corners.
    #[serde(default)]
    pub radii: Option<[[f64; 2]; 4]>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PhysicalRegion {
    /// Unclipped element bounds: clipping must not create new rounded corners.
    pub bounds: [i32; 4],
    pub clip: [i32; 4],
    pub radii: [[i32; 2]; 4],
}

impl CssRegion {
    pub fn normalized_radii(self) -> Result<[[f64; 2]; 4], String> {
        self.rect.validate()?;
        let mut radii = self.radii.unwrap_or([[12.0; 2]; 4]);
        if radii
            .iter()
            .flatten()
            .any(|radius| !radius.is_finite() || *radius < 0.0)
        {
            return Err("Invalid native corner radius".into());
        }
        for radius in &mut radii {
            if radius[0] == 0.0 || radius[1] == 0.0 {
                *radius = [0.0; 2];
            }
        }
        // CSS Backgrounds: all radii share the smallest overlap reduction.
        let mut factor = 1.0f64;
        for (extent, first, second) in [
            (self.rect.width, radii[0][0], radii[1][0]),
            (self.rect.width, radii[3][0], radii[2][0]),
            (self.rect.height, radii[0][1], radii[3][1]),
            (self.rect.height, radii[1][1], radii[2][1]),
        ] {
            // Divide separately to avoid overflow from large valid CSS radii.
            let sum = first / extent + second / extent;
            if sum > 1.0 {
                factor = factor.min(1.0 / sum);
            }
        }
        for radius in &mut radii {
            radius[0] *= factor;
            radius[1] *= factor;
        }
        Ok(radii)
    }
}

/// Keep shape and radii together when offscreen elements are filtered. Build the
/// original rounded shape first, then intersect it with its clipped rectangle.
pub fn physical_rounded_regions(
    regions: &[CssRegion],
    scale: f64,
    viewport: (u32, u32),
) -> Result<Vec<PhysicalRegion>, String> {
    physical_regions(&[], scale, viewport)?;
    if regions.len() > 32 {
        return Err("Too many native input regions".into());
    }
    let mut result = Vec::with_capacity(regions.len());
    for region in regions {
        let radii = region.normalized_radii()?;
        let rect = region.rect;
        let raw = [
            rect.x * scale,
            rect.y * scale,
            (rect.x + rect.width) * scale,
            (rect.y + rect.height) * scale,
        ];
        if raw[2] <= 0.0
            || raw[3] <= 0.0
            || raw[0] >= f64::from(viewport.0)
            || raw[1] >= f64::from(viewport.1)
        {
            continue;
        }
        let bounds = [
            raw[0].floor() as i32,
            raw[1].floor() as i32,
            raw[2].ceil() as i32,
            raw[3].ceil() as i32,
        ];
        let clip = [
            bounds[0].max(0),
            bounds[1].max(0),
            bounds[2].min(viewport.0 as i32),
            bounds[3].min(viewport.1 as i32),
        ];
        if clip[2] <= clip[0] || clip[3] <= clip[1] {
            continue;
        }
        let mut physical = radii.map(|radius| radius.map(|value| (value * scale).round() as i32));
        let mut factor = 1.0f64;
        for (extent, first, second) in [
            (bounds[2] - bounds[0], physical[0][0], physical[1][0]),
            (bounds[2] - bounds[0], physical[3][0], physical[2][0]),
            (bounds[3] - bounds[1], physical[0][1], physical[3][1]),
            (bounds[3] - bounds[1], physical[1][1], physical[2][1]),
        ] {
            if first + second > extent {
                factor = factor.min(f64::from(extent) / f64::from(first + second));
            }
        }
        for radius in &mut physical {
            radius[0] = (f64::from(radius[0]) * factor).floor() as i32;
            radius[1] = (f64::from(radius[1]) * factor).floor() as i32;
        }
        result.push(PhysicalRegion {
            bounds,
            clip,
            radii: physical,
        });
    }
    Ok(result)
}

pub fn validate_bitmap((width, height): (u32, u32)) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > MAX_EDGE
        || height > MAX_EDGE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err("Guest viewport exceeds the POC capture budget".into());
    }
    Ok(())
}

/// Outward rounding leaves every visible UI pixel inside its native input island.
pub fn physical_regions(
    rectangles: &[CssRect],
    scale: f64,
    viewport: (u32, u32),
) -> Result<Vec<[i32; 4]>, String> {
    if !scale.is_finite() || !(0.5..=8.0).contains(&scale) || rectangles.len() > 32 {
        return Err("Invalid scale or too many input regions".into());
    }
    validate_bitmap(viewport)?;
    let mut result = Vec::with_capacity(rectangles.len());
    for rectangle in rectangles {
        let r = rectangle.validate()?;
        let left = (r.x * scale).floor().clamp(0.0, f64::from(viewport.0)) as i32;
        let top = (r.y * scale).floor().clamp(0.0, f64::from(viewport.1)) as i32;
        let right = ((r.x + r.width) * scale)
            .ceil()
            .clamp(0.0, f64::from(viewport.0)) as i32;
        let bottom = ((r.y + r.height) * scale)
            .ceil()
            .clamp(0.0, f64::from(viewport.1)) as i32;
        if right > left && bottom > top {
            result.push([left, top, right, bottom]);
        }
    }
    Ok(result)
}

/// Convert a UI region into this guest bitmap's coordinates, never desktop pixels.
pub fn crop_rect(
    region: CssRect,
    viewport: CssRect,
    bitmap: (u32, u32),
) -> Result<([u32; 4], CssRect), String> {
    let region = region.validate()?;
    let viewport = viewport.validate()?;
    validate_bitmap(bitmap)?;
    let left = region.x.max(viewport.x);
    let top = region.y.max(viewport.y);
    let right = (region.x + region.width).min(viewport.x + viewport.width);
    let bottom = (region.y + region.height).min(viewport.y + viewport.height);
    if right <= left || bottom <= top {
        return Err("Capture region does not intersect the guest".into());
    }
    let sx = f64::from(bitmap.0) / viewport.width;
    let sy = f64::from(bitmap.1) / viewport.height;
    let x = ((left - viewport.x) * sx)
        .floor()
        .clamp(0.0, f64::from(bitmap.0)) as u32;
    let y = ((top - viewport.y) * sy)
        .floor()
        .clamp(0.0, f64::from(bitmap.1)) as u32;
    let end_x = ((right - viewport.x) * sx)
        .ceil()
        .clamp(0.0, f64::from(bitmap.0)) as u32;
    let end_y = ((bottom - viewport.y) * sy)
        .ceil()
        .clamp(0.0, f64::from(bitmap.1)) as u32;
    if end_x <= x || end_y <= y {
        return Err("Empty capture region".into());
    }
    Ok((
        [x, y, end_x - x, end_y - y],
        CssRect {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        },
    ))
}
