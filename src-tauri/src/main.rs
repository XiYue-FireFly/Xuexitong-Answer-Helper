#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    let result = if std::env::args().any(|arg| arg == "--poc") {
        studypilot_rust_host_poc::run()
    } else {
        studypilot_rust_host_poc::run_desktop()
    };
    if let Err(error) = result {
        eprintln!("R1 Rust host POC failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The R1 host POC supports Windows x64 only.");
    std::process::exit(1);
}
