fn main() {
    // Application commands otherwise bypass the app permission manifest by default.
    let result = tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "poc_info",
            "poc_layout",
            "poc_capture",
            "poc_probe",
            "poc_enter",
            "poc_focus",
            "desktop_host",
        ]),
    ));
    if let Err(error) = result {
        eprintln!("R1 POC build configuration failed: {error}");
        std::process::exit(1);
    }
}
