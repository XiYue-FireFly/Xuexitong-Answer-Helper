use studypilot_rust_host_poc::geometry::{
    CssRect, CssRegion, crop_rect, physical_regions, physical_rounded_regions,
};
use studypilot_rust_host_poc::policy::{FixtureTarget, is_bundled_ui};
use tauri::Url;

#[test]
fn fixture_override_rejects_network_and_authority_confusion() {
    for value in [
        "https://example.com/guest.html",
        "http://localhost.example.com/guest.html",
        "http://user:password@127.0.0.1:9200/guest.html",
        "file:///C:/guest.html",
        "http://127.0.0.2/guest.html",
        "http://0.0.0.0/guest.html",
    ] {
        assert!(
            FixtureTarget::from_override(Some(value)).is_err(),
            "{value}"
        );
    }
    let target = FixtureTarget::from_override(Some("http://127.0.0.1:9200/guest.html"))
        .expect("loopback fixture is valid");
    assert!(target.allows(&Url::parse("http://127.0.0.1:9200/guest.html").expect("URL")));
    assert!(!target.allows(&Url::parse("http://127.0.0.1:9201/guest.html").expect("URL")));
    assert!(!target.allows(&Url::parse("http://127.0.0.1:9200/other.html").expect("URL")));
}

#[test]
fn ui_identity_requires_the_bundled_ui_document() {
    assert!(is_bundled_ui(
        &Url::parse("http://tauri.localhost/ui.html").expect("URL")
    ));
    assert!(is_bundled_ui(
        &Url::parse("tauri://localhost/ui.html").expect("URL")
    ));
    assert!(!is_bundled_ui(
        &Url::parse("http://tauri.localhost/guest.html").expect("URL")
    ));
    assert!(!is_bundled_ui(
        &Url::parse("http://localhost/ui.html").expect("URL")
    ));
    assert!(!is_bundled_ui(
        &Url::parse("https://tauri.localhost.evil/ui.html").expect("URL")
    ));
}

#[test]
fn regions_round_outwards_and_clip_at_physical_viewport() {
    let regions = physical_regions(
        &[CssRect {
            x: 10.2,
            y: -2.0,
            width: 20.1,
            height: 12.2,
        }],
        1.5,
        (100, 80),
    )
    .expect("valid region");
    assert_eq!(regions[0], [15, 0, 46, 16]);
    assert!(
        physical_regions(
            &[CssRect {
                x: f64::NAN,
                y: 0.0,
                width: 1.0,
                height: 1.0
            }],
            1.0,
            (100, 80)
        )
        .is_err()
    );
    assert!(physical_regions(&[], 0.0, (100, 80)).is_err());
}

#[test]
fn crop_uses_actual_bitmap_ratio_and_intersection() {
    let region = CssRect {
        x: -10.0,
        y: 40.0,
        width: 110.0,
        height: 80.0,
    };
    let viewport = CssRect {
        x: 0.0,
        y: 20.0,
        width: 200.0,
        height: 100.0,
    };
    let (pixels, bounds) = crop_rect(region, viewport, (300, 150)).expect("intersection");
    assert_eq!(pixels, [0, 30, 150, 120]);
    assert_eq!(
        bounds,
        CssRect {
            x: 0.0,
            y: 40.0,
            width: 100.0,
            height: 80.0
        }
    );
    assert!(crop_rect(CssRect { x: 250.0, ..region }, viewport, (300, 150)).is_err());
}

#[test]
fn rounded_regions_keep_each_shape_radius_after_offscreen_filtering() -> Result<(), String> {
    let regions = physical_rounded_regions(
        &[
            CssRegion {
                rect: CssRect {
                    x: -100.0,
                    y: 0.0,
                    width: 20.0,
                    height: 20.0,
                },
                radii: Some([[2.0, 2.0]; 4]),
            },
            CssRegion {
                rect: CssRect {
                    x: 10.0,
                    y: 20.0,
                    width: 300.0,
                    height: 60.0,
                },
                radii: Some([[9999.0, 9999.0]; 4]),
            },
            CssRegion {
                rect: CssRect {
                    x: 0.0,
                    y: 0.0,
                    width: 500.0,
                    height: 40.0,
                },
                radii: Some([[0.0, 0.0]; 4]),
            },
        ],
        1.5,
        (1000, 800),
    )?;
    assert_eq!(regions.len(), 2);
    assert_eq!(regions[0].radii, [[45, 45]; 4]);
    assert_eq!(regions[1].radii, [[0, 0]; 4]);
    Ok(())
}

#[test]
fn partially_offscreen_capsules_preserve_original_corners_before_clipping() -> Result<(), String> {
    let regions = physical_rounded_regions(
        &[CssRegion {
            rect: CssRect {
                x: -20.0,
                y: 30.0,
                width: 100.0,
                height: 40.0,
            },
            radii: Some([[20.0, 20.0]; 4]),
        }],
        2.0,
        (400, 300),
    )?;
    assert_eq!(regions[0].bounds, [-40, 60, 160, 140]);
    assert_eq!(regions[0].clip, [0, 60, 160, 140]);
    assert_eq!(regions[0].radii, [[40, 40]; 4]);
    Ok(())
}

#[test]
fn four_elliptical_corners_follow_css_overlap_and_legacy_defaults() -> Result<(), String> {
    let rect = CssRect {
        x: 0.0,
        y: 0.0,
        width: 100.0,
        height: 40.0,
    };
    let region = CssRegion {
        rect,
        radii: Some([[80.0, 40.0], [20.0, 40.0], [20.0, 20.0], [80.0, 20.0]]),
    };
    let radii = region.normalized_radii()?;
    let expected = [
        [80.0 * 2.0 / 3.0, 40.0 * 2.0 / 3.0],
        [20.0 * 2.0 / 3.0, 40.0 * 2.0 / 3.0],
        [20.0 * 2.0 / 3.0, 20.0 * 2.0 / 3.0],
        [80.0 * 2.0 / 3.0, 20.0 * 2.0 / 3.0],
    ];
    for (actual, expected) in radii.iter().flatten().zip(expected.iter().flatten()) {
        assert!((actual - expected).abs() < 1e-9);
    }
    let legacy: CssRegion =
        serde_json::from_value(serde_json::json!({"x":0,"y":0,"width":100,"height":40}))
            .map_err(|error| error.to_string())?;
    assert_eq!(legacy.normalized_radii()?, [[12.0; 2]; 4]);
    assert!(
        CssRegion {
            rect,
            radii: Some([[f64::NAN, 2.0]; 4])
        }
        .normalized_radii()
        .is_err()
    );
    Ok(())
}
