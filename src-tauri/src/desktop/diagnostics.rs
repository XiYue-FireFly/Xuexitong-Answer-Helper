use serde_json::{Map, Value, json};
use std::{io::Write, path::Path, sync::Mutex};

static WRITE: Mutex<()> = Mutex::new(());

fn sanitize_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = tauri::Url::parse(trimmed).ok()?;
    match parsed.scheme() {
        "about" => Some(format!("about:{}", parsed.path())),
        "http" | "https" => {
            let host = parsed.host_str()?;
            let port = parsed
                .port()
                .map(|value| format!(":{value}"))
                .unwrap_or_default();
            let path = parsed.path();
            let sanitized = format!("{}://{}{}{}", parsed.scheme(), host, port, path);
            Some(sanitized.chars().take(240).collect())
        }
        _ => None,
    }
}

fn sanitize_text(raw: &str, max_len: usize) -> String {
    let mut parts = Vec::new();
    let mut redact_next = false;
    for part in raw.split_whitespace() {
        let lower = part.to_ascii_lowercase();
        if redact_next {
            parts.push("[redacted]".to_string());
            redact_next = false;
            continue;
        }
        if lower == "bearer" || lower == "basic" {
            parts.push("[redacted]".to_string());
            redact_next = true;
            continue;
        }
        if lower.starts_with("http://") || lower.starts_with("https://") {
            let trimmed = part.trim_end_matches(|ch: char| ",.;:)]}\"'".contains(ch));
            if let Some(clean_url) = sanitize_url(trimmed) {
                parts.push(clean_url);
                continue;
            }
        }
        if part.starts_with("sk-")
            || part.starts_with("ghp_")
            || lower.contains("authorization")
            || lower.contains("cookie")
            || lower.contains("api_key=")
            || lower.contains("apikey=")
            || lower.contains("token=")
            || lower.contains("password")
            || lower.contains("passwd")
            || lower.contains("secret=")
            || lower.contains("session=")
        {
            parts.push("[redacted]".to_string());
        } else {
            parts.push(part.to_string());
        }
    }
    parts.join(" ").chars().take(max_len).collect()
}

fn sanitize_details(details: &Value) -> Option<Value> {
    let object = details.as_object()?;
    let mut out = Map::new();
    const URL_KEYS: &[&str] = &["url", "requestUrl", "tabUrl", "selectedUrl", "sourceUrl"];
    const TEXT_KEYS: &[&str] = &[
        "stage",
        "phase",
        "code",
        "statusText",
        "method",
        "tabId",
        "reason",
        "kind",
        "name",
    ];
    const NUMBER_KEYS: &[&str] = &["status", "statusCode", "errorCode", "frameId", "guestId"];
    const BOOL_KEYS: &[&str] = &["clickable", "isMainFrame", "ok", "loading"];

    for key in URL_KEYS {
        if let Some(raw) = object.get(*key).and_then(Value::as_str)
            && let Some(clean) = sanitize_url(raw)
        {
            out.insert((*key).to_string(), Value::String(clean));
        }
    }
    for key in TEXT_KEYS {
        if let Some(raw) = object.get(*key).and_then(Value::as_str) {
            let clean = sanitize_text(raw, 160);
            if !clean.is_empty() {
                out.insert((*key).to_string(), Value::String(clean));
            }
        }
    }
    for key in NUMBER_KEYS {
        if let Some(value) = object.get(*key)
            && value.is_number()
        {
            out.insert((*key).to_string(), value.clone());
        }
    }
    for key in BOOL_KEYS {
        if let Some(value) = object.get(*key).and_then(Value::as_bool) {
            out.insert((*key).to_string(), Value::Bool(value));
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

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
    let mut safe = json!({
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis(),
        "level": sanitize_text(payload["level"].as_str().unwrap_or("info"), 32),
        "source": sanitize_text(payload["source"].as_str().unwrap_or("rust-host"), 96),
    });
    let message = payload["message"].as_str().unwrap_or("");
    safe["message"] = sanitize_text(message, 4000).into();
    if let Some(clean_url) = payload["url"].as_str().and_then(sanitize_url) {
        safe["url"] = clean_url.into();
    }
    if let Some(clean_details) = sanitize_details(&payload["details"]) {
        safe["details"] = clean_details;
    }
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

#[cfg(test)]
mod tests {
    use super::{append, recent, sanitize_text, sanitize_url};
    use serde_json::json;

    #[test]
    fn sanitize_url_strips_query_fragment_and_userinfo() {
        assert_eq!(
            sanitize_url(
                "https://user:pass@passport2.chaoxing.com:443/fanyalogin?fid=-1&token=secret#frag"
            )
            .as_deref(),
            Some("https://passport2.chaoxing.com/fanyalogin")
        );
        assert_eq!(
            sanitize_url("http://127.0.0.1:8080/entry?session=abc").as_deref(),
            Some("http://127.0.0.1:8080/entry")
        );
        assert_eq!(
            sanitize_url("about:blank#popup-1").as_deref(),
            Some("about:blank")
        );
        assert_eq!(sanitize_url("javascript:alert(1)"), None);
        assert_eq!(sanitize_url("file:///C:/secret.txt"), None);
    }

    #[test]
    fn append_preserves_sanitized_details_and_redacts_secrets() -> Result<(), String> {
        let dir = std::env::temp_dir().join(format!(
            "studypilot-diag-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        append(
            &dir,
            json!({
                "level": "error",
                "source": "webview:fetch-failed",
                "message": "Failed to fetch https://i.chaoxing.com/base?ticket=secret123 Bearer myjwt sk-12345 cookie=abc",
                "url": "https://passport2.chaoxing.com/login?refer=secret&token=xyz#hash",
                "details": {
                    "requestUrl": "https://i.chaoxing.com/api/ping?uid=999&token=secret",
                    "tabUrl": "https://i.chaoxing.com/base?t=123",
                    "status": 401,
                    "stage": "login-redirect",
                    "code": "ERR_ABORTED",
                    "tabId": "tab-2",
                    "cookie": "SHOULD_NOT_APPEAR",
                    "password": "SHOULD_NOT_APPEAR",
                    "courseParams": { "raw": "SHOULD_NOT_APPEAR" }
                }
            }),
        )?;
        let out = recent(&dir, 10)?;
        let _ = std::fs::remove_dir_all(&dir);
        let entry = &out["entries"][0];
        let raw = serde_json::to_string(entry).map_err(|e| e.to_string())?;
        for forbidden in [
            "secret123",
            "myjwt",
            "sk-12345",
            "ticket=",
            "token=",
            "uid=999",
            "SHOULD_NOT_APPEAR",
            "#hash",
        ] {
            assert!(!raw.contains(forbidden), "leaked {forbidden} in {raw}");
        }
        assert_eq!(entry["url"], "https://passport2.chaoxing.com/login");
        assert_eq!(
            entry["details"]["requestUrl"],
            "https://i.chaoxing.com/api/ping"
        );
        assert_eq!(entry["details"]["tabUrl"], "https://i.chaoxing.com/base");
        assert_eq!(entry["details"]["status"], 401);
        assert_eq!(entry["details"]["stage"], "login-redirect");
        assert_eq!(entry["details"]["code"], "ERR_ABORTED");
        assert_eq!(entry["details"]["tabId"], "tab-2");
        assert!(sanitize_text("Authorization: secret", 100).contains("[redacted]"));
        Ok(())
    }
}
