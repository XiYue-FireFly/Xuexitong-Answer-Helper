use serde_json::{Value, json};
use std::{io::Write, path::Path, sync::Mutex};
static WRITE: Mutex<()> = Mutex::new(());
pub fn append(root: &Path, payload: Value) -> Result<Value, String> {
    let _guard = WRITE.lock().map_err(|_| "Diagnostics unavailable")?;
    let directory = root.join("rust-host-preview");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let file = directory.join("diagnostics.jsonl");
    if let Ok(meta) = std::fs::symlink_metadata(&file)
        && (!meta.is_file() || meta.file_type().is_symlink())
    {
        return Err("Invalid diagnostics file".into());
    }
    let mut safe = json!({"timestamp":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_millis(),"level":payload["level"].as_str().unwrap_or("info"),"source":payload["source"].as_str().unwrap_or("rust-host")});
    let message = payload["message"].as_str().unwrap_or("");
    let redacted = message
        .split_whitespace()
        .map(|part| {
            if part.starts_with("sk-")
                || part.starts_with("ghp_")
                || part.to_ascii_lowercase().contains("authorization")
                || part.contains("api_key=")
            {
                "[redacted]"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    safe["message"] = redacted.chars().take(4000).collect::<String>().into();
    let line = serde_json::to_string(&safe).map_err(|e| e.to_string())? + "\n";
    std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(file)
        .and_then(|mut file| file.write_all(line.as_bytes()))
        .map_err(|e| e.to_string())?;
    Ok(Value::Null)
}
pub fn recent(root: &Path, limit: usize) -> Result<Value, String> {
    let file = root.join("rust-host-preview/diagnostics.jsonl");
    let text = match std::fs::read_to_string(&file) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.to_string()),
    };
    let entries: Vec<_> = text
        .lines()
        .rev()
        .take(limit.clamp(1, 300))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect();
    Ok(json!({"success":true,"path":file,"entries":entries}))
}
