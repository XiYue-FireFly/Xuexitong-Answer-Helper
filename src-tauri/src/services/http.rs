use reqwest::{Client, Url, header};
use serde_json::{Value, json};
use std::time::Duration;

/// Streaming bytes are forwarded without parsing JSON, SSE records, or answers.
/// LEGACY-AI-UTF8-001: preserve valid characters split across network chunks.
#[derive(Default)]
struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    fn push(&mut self, bytes: &[u8], finished: bool) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();
        let mut offset = 0;
        while offset < self.pending.len() {
            match std::str::from_utf8(&self.pending[offset..]) {
                Ok(valid) => {
                    output.push_str(valid);
                    offset = self.pending.len();
                }
                Err(error) => {
                    let valid_end = offset + error.valid_up_to();
                    output.push_str(&String::from_utf8_lossy(&self.pending[offset..valid_end]));
                    offset = valid_end;
                    match error.error_len() {
                        Some(length) => {
                            output.push('\u{fffd}');
                            offset += length;
                        }
                        None if finished => {
                            output.push('\u{fffd}');
                            offset = self.pending.len();
                        }
                        None => break,
                    }
                }
            }
        }
        self.pending.drain(..offset);
        output
    }
}

fn failure(error: &str) -> Value {
    json!({ "success": false, "error": error })
}

fn timeout_ms(payload: &Value) -> u64 {
    let value = payload
        .get("timeoutMs")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n != 0.0)
        .unwrap_or(60_000.0);
    value.clamp(5_000.0, 120_000.0) as u64
}

fn http_error(error: &reqwest::Error, reading: bool) -> Value {
    if error.is_timeout() {
        return failure("AI 接口请求超时。");
    }
    // reqwest errors may contain credential-bearing URLs. Do not expose them.
    failure(if reading {
        "响应读取失败：网络连接中断。"
    } else {
        "AI 接口请求失败。"
    })
}

/// Send one legacy AI request. A failed emitter cancels the response stream.
/// The callback must route only to the owning UI; it must never log headers/body.
pub async fn ai_chat<F>(payload: Value, mut chunk_callback: F) -> Value
where
    F: FnMut(Value) -> Result<(), String>,
{
    let base_url = payload
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let base_url = base_url.strip_suffix('/').unwrap_or(base_url);
    let Ok(url) = Url::parse(&format!("{base_url}/chat/completions")) else {
        return failure("AI Base URL 非法。");
    };
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return failure("AI Base URL 非法。");
    }
    let duration = Duration::from_millis(timeout_ms(&payload));
    let client = match Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(duration)
        .read_timeout(duration)
        .build()
    {
        Ok(client) => client,
        Err(_) => return failure("AI 请求发起失败。"),
    };
    let body = payload
        .get("body")
        .filter(|value| !value.is_null() && **value != Value::Bool(false))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let body = match serde_json::to_vec(&body) {
        Ok(body) => body,
        Err(_) => return failure("AI 请求发起失败。"),
    };
    let mut headers = header::HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(
        header::USER_AGENT,
        header::HeaderValue::from_static("StudyPilot Rust Host"),
    );
    if let Some(custom) = payload.get("headers").and_then(Value::as_object) {
        for (name, value) in custom {
            let (Ok(name), Some(value)) = (
                header::HeaderName::from_bytes(name.as_bytes()),
                value.as_str(),
            ) else {
                return failure("AI 请求发起失败。");
            };
            let Ok(value) = header::HeaderValue::from_str(value) else {
                return failure("AI 请求发起失败。");
            };
            headers.insert(name, value);
        }
    }
    let mut response = match client.post(url).headers(headers).body(body).send().await {
        Ok(response) => response,
        Err(error) => return http_error(&error, false),
    };
    let status = response.status().as_u16();
    let success = response.status().is_success();
    let streaming = payload
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let sse = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/event-stream"));
    let request_id = payload
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut decoder = Utf8Decoder::default();
    let mut collected = String::new();
    loop {
        let bytes = match response.chunk().await {
            Ok(Some(bytes)) => bytes,
            Ok(None) => break,
            Err(error) => return http_error(&error, true),
        };
        let decoded = decoder.push(&bytes, false);
        if success && streaming && sse {
            if !decoded.is_empty()
                && chunk_callback(json!({ "requestId": request_id, "chunk": decoded })).is_err()
            {
                return failure("AI 请求已取消。");
            }
        } else {
            collected.push_str(&decoded);
        }
    }
    let tail = decoder.push(&[], true);
    if success && streaming && sse {
        if !tail.is_empty()
            && chunk_callback(json!({ "requestId": request_id, "chunk": tail })).is_err()
        {
            return failure("AI 请求已取消。");
        }
        json!({ "success": true, "statusCode": status, "streamed": true })
    } else if !success {
        collected.push_str(&tail);
        json!({ "success": false, "statusCode": status, "error": format!("接口返回 {status}：{}", collected.chars().take(800).collect::<String>()) })
    } else {
        collected.push_str(&tail);
        let mut result = json!({ "success": true, "statusCode": status, "text": collected });
        if streaming {
            result["json"] = Value::Bool(true);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::{Utf8Decoder, ai_chat, timeout_ms};
    use serde_json::{Value, json};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;

    fn fixture(
        status: u16,
        content_type: &str,
        chunks: Vec<Vec<u8>>,
    ) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("fixture bind");
        let url = format!(
            "http://{}/v1",
            listener.local_addr().expect("fixture address")
        );
        let content_type = content_type.to_string();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("fixture connection");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("read timeout");
            let mut request = Vec::new();
            let mut byte = [0; 1];
            while !request.ends_with(b"\r\n\r\n") {
                assert_eq!(stream.read(&mut byte).expect("request header"), 1);
                request.push(byte[0]);
            }
            let header = String::from_utf8_lossy(&request).to_string();
            let length = header
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|value| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            let mut body = vec![0; length];
            stream.read_exact(&mut body).expect("request body");
            request.extend(body);
            write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").expect("response header");
            for chunk in chunks {
                if write!(stream, "{:x}\r\n", chunk.len())
                    .and_then(|()| stream.write_all(&chunk))
                    .and_then(|()| stream.write_all(b"\r\n"))
                    .and_then(|()| stream.flush())
                    .is_err()
                {
                    break;
                }
                thread::sleep(Duration::from_millis(3));
            }
            let _ = stream.write_all(b"0\r\n\r\n");
            String::from_utf8(request).expect("fixture ASCII/UTF8 request")
        });
        (url, worker)
    }

    #[test]
    fn json_success_http_failure_and_headers_keep_the_legacy_contract() {
        tauri::async_runtime::block_on(async {
            let (url, worker) =
                fixture(200, "application/json", vec![b"{\"choices\":[]}".to_vec()]);
            let mut chunks = Vec::new();
            let result = ai_chat(json!({ "baseUrl": url, "stream":true, "headers":{"Authorization":"Bearer fixture-only"}, "body":{"model":"fixture","messages":[]} }), |chunk| {chunks.push(chunk); Ok(())}).await;
            assert_eq!(
                result,
                json!({"success":true,"statusCode":200,"text":"{\"choices\":[]}","json":true})
            );
            assert!(chunks.is_empty());
            let request = worker.join().expect("fixture server");
            assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
            assert!(
                request
                    .to_lowercase()
                    .contains("authorization: bearer fixture-only")
            );
            assert!(request.ends_with("{\"messages\":[],\"model\":\"fixture\"}"));
            let (url, worker) = fixture(503, "text/plain", vec![b"unavailable".to_vec()]);
            assert_eq!(
                ai_chat(json!({"baseUrl":url}), |_| Ok(())).await,
                json!({"success":false,"statusCode":503,"error":"接口返回 503：unavailable"})
            );
            worker.join().expect("failure fixture");
            assert_eq!(
                ai_chat(json!({"baseUrl":"file:///secret"}), |_| Ok(())).await["error"],
                "AI Base URL 非法。"
            );
        });
    }

    #[test]
    fn sse_preserves_utf8_records_and_emitter_cancellation_is_explicit() {
        tauri::async_runtime::block_on(async {
            let text = "data: {\"answer\":\"中文🙂\"}\n\ndata: [DONE]\n\n";
            let (url, worker) = fixture(
                200,
                "text/event-stream",
                text.as_bytes().chunks(1).map(Vec::from).collect(),
            );
            let mut chunks = Vec::<Value>::new();
            let result = ai_chat(
                json!({"baseUrl":url,"stream":true,"requestId":"fixture-one"}),
                |chunk| {
                    chunks.push(chunk);
                    Ok(())
                },
            )
            .await;
            assert_eq!(
                result,
                json!({"success":true,"statusCode":200,"streamed":true})
            );
            assert!(
                chunks
                    .iter()
                    .all(|chunk| chunk["requestId"] == "fixture-one")
            );
            assert_eq!(
                chunks
                    .iter()
                    .map(|chunk| chunk["chunk"].as_str().expect("chunk"))
                    .collect::<String>(),
                text
            );
            worker.join().expect("SSE fixture");
            let (url, worker) = fixture(
                200,
                "text/event-stream",
                vec![b"data: first\n\n".to_vec(), b"data: last\n\n".to_vec()],
            );
            let cancelled = ai_chat(json!({"baseUrl":url,"stream":true}), |_| {
                Err("sender destroyed".into())
            })
            .await;
            assert_eq!(cancelled["error"], "AI 请求已取消。");
            worker.join().expect("cancelled fixture");
        });
    }

    #[test]
    fn timeout_uses_legacy_clamp() {
        assert_eq!(timeout_ms(&json!({})), 60_000);
        assert_eq!(timeout_ms(&json!({"timeoutMs":1})), 5_000);
        assert_eq!(timeout_ms(&json!({"timeoutMs":500_000})), 120_000);
        assert_eq!(timeout_ms(&json!({"timeoutMs":0})), 60_000);
    }

    #[test]
    fn valid_utf8_survives_every_network_boundary() {
        let source = "data: {\"answer\":\"中文🙂\"}\n\ndata: [DONE]\n\n";
        for boundary in 0..=source.len() {
            let mut decoder = Utf8Decoder::default();
            let decoded = decoder.push(&source.as_bytes()[..boundary], false)
                + &decoder.push(&source.as_bytes()[boundary..], true);
            assert_eq!(decoded, source, "split at byte {boundary}");
        }
    }

    #[test]
    fn malformed_and_incomplete_utf8_has_bounded_pending_state() {
        let mut decoder = Utf8Decoder::default();
        assert_eq!(decoder.push(&[0xe4], false), "");
        assert_eq!(decoder.push(&[0xb8, 0xad, 0xff, 0xe4], false), "中�");
        assert_eq!(decoder.push(&[], true), "�");
        assert!(decoder.pending.is_empty());
    }
}
