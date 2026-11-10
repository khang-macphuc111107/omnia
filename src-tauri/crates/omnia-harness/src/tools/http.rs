//! http_request: general-purpose HTTP client tool.

use std::collections::BTreeMap;
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use super::web::{validate_url, USER_AGENT};
use super::{finish, parse_input};
use crate::{EffectClass, HarnessResult, Tool, ToolContext, ToolOutput, ToolSpec};

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 300;
const DEFAULT_MAX_BYTES: usize = 200_000;
const HARD_MAX_BYTES: usize = 5 * 1024 * 1024;

pub struct HttpRequestTool;

#[derive(Deserialize)]
struct Args {
    method: String,
    url: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body: Option<String>,
    timeout_secs: Option<u64>,
    max_bytes: Option<usize>,
}

#[async_trait]
impl Tool for HttpRequestTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "http_request".into(),
            description: "Send an HTTP request (GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS) and \
return the status line, response headers and body. Redirects are not followed (the 3xx status and \
Location header are returned). Text bodies are shown up to `max_bytes`; non-UTF-8 bodies are \
summarised by size. Use for APIs; use web_fetch to read web pages as text."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "method": {"type": "string", "description": "HTTP method."},
                    "url": {"type": "string", "description": "http:// or https:// URL."},
                    "headers": {"type": "object", "additionalProperties": {"type": "string"}, "description": "Request headers."},
                    "body": {"type": "string", "description": "Request body (text)."},
                    "timeout_secs": {"type": "integer", "minimum": 1, "maximum": 300, "description": "Timeout in seconds (default 30)."},
                    "max_bytes": {"type": "integer", "minimum": 1, "description": "Maximum response body bytes to return (default 200000, max 5 MB)."}
                },
                "required": ["method", "url"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::Network
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "{} {}",
            input["method"].as_str().unwrap_or("?").to_ascii_uppercase(),
            input["url"].as_str().unwrap_or("?")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        tokio::select! {
            result = request(input) => finish(result),
            _ = ctx.cancel.cancelled() => Err(super::cancelled()),
        }
    }
}

async fn request(input: Value) -> Result<ToolOutput, String> {
    let args: Args = parse_input(input)?;
    let url = validate_url(&args.url)?;
    let method = reqwest::Method::from_bytes(args.method.trim().to_ascii_uppercase().as_bytes())
        .map_err(|_| format!("invalid HTTP method `{}`", args.method))?;
    if !matches!(
        method.as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) {
        return Err(format!("unsupported HTTP method `{method}`"));
    }
    let timeout = args
        .timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(1, MAX_TIMEOUT_SECS);
    let max_bytes = args
        .max_bytes
        .unwrap_or(DEFAULT_MAX_BYTES)
        .clamp(1, HARD_MAX_BYTES);
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|error| format!("cannot build HTTP client: {error}"))?;
    let mut builder = client
        .request(method, url)
        .timeout(Duration::from_secs(timeout));
    for (name, value) in &args.headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("invalid header name `{name}`"))?;
        let value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|_| format!("invalid value for header `{name}`"))?;
        builder = builder.header(name, value);
    }
    if let Some(body) = args.body {
        builder = builder.body(body);
    }
    let mut response = builder
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    let status = response.status();
    let mut out = format!(
        "HTTP {} {}\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("")
    );
    for (name, value) in response.headers() {
        out.push_str(&format!(
            "{}: {}\n",
            name,
            String::from_utf8_lossy(value.as_bytes())
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    let mut body: Vec<u8> = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("failed reading body: {error}"))?
    {
        body.extend_from_slice(&chunk);
        if body.len() > max_bytes {
            body.truncate(max_bytes);
            truncated = true;
            break;
        }
    }
    out.push('\n');
    let text = match std::str::from_utf8(&body) {
        Ok(text) => Some(text),
        // A cut-off multi-byte character at the truncation point is fine.
        Err(error) if truncated && error.error_len().is_none() => {
            std::str::from_utf8(&body[..error.valid_up_to()]).ok()
        }
        Err(_) => None,
    };
    match text {
        Some(text) => out.push_str(text),
        None => out.push_str(&format!(
            "[binary body not shown: {}{} bytes, content-type {content_type}]",
            if truncated { "at least " } else { "" },
            body.len()
        )),
    }
    if truncated && text.is_some() {
        out.push_str(&format!("\n[body truncated at {max_bytes} bytes]"));
    }
    Ok(ToolOutput::text(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Block;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn text(out: &ToolOutput) -> String {
        match &out.content[0] {
            Block::Text { text } => text.clone(),
            other => panic!("not text: {other:?}"),
        }
    }

    /// Serves `/echo` (request echoed back), `/bin` (non-UTF-8) and `/big`.
    async fn server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let (head_end, content_len) = loop {
                        let n = sock.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buf[..i]).to_ascii_lowercase();
                            let len = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:"))
                                .and_then(|v| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            break (i + 4, len);
                        }
                    };
                    while buf.len() < head_end + content_len {
                        let n = sock.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let path = String::from_utf8_lossy(&buf)
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("")
                        .to_string();
                    let (ctype, body): (&str, Vec<u8>) = match path.as_str() {
                        "/bin" => ("application/octet-stream", vec![0xff, 0xfe, 0x00, 0x80]),
                        "/big" => ("text/plain", vec![b'a'; 1000]),
                        _ => ("text/plain", buf.clone()),
                    };
                    let head = format!(
                        "HTTP/1.1 201 Created\r\ncontent-type: {ctype}\r\nx-test: yes\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(&body).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        format!("http://{addr}")
    }

    fn ctx() -> ToolContext {
        ToolContext::new(".")
    }

    #[tokio::test]
    async fn get_with_headers() {
        let base = server().await;
        let out = HttpRequestTool
            .call(
                &ctx(),
                json!({"method": "get", "url": format!("{base}/echo"), "headers": {"X-Custom": "hello"}}),
            )
            .await
            .unwrap();
        let t = text(&out);
        assert!(!out.is_error, "{t}");
        assert!(t.starts_with("HTTP 201 Created"), "{t}");
        assert!(t.contains("x-test: yes"));
        assert!(t.contains("GET /echo HTTP/1.1"));
        assert!(t.to_ascii_lowercase().contains("x-custom: hello"));
    }

    #[tokio::test]
    async fn post_body() {
        let base = server().await;
        let out = HttpRequestTool
            .call(
                &ctx(),
                json!({"method": "POST", "url": format!("{base}/echo"), "body": "{\"a\":1}", "headers": {"Content-Type": "application/json"}}),
            )
            .await
            .unwrap();
        let t = text(&out);
        assert!(t.contains("POST /echo HTTP/1.1"), "{t}");
        assert!(t.ends_with("{\"a\":1}"), "{t}");
    }

    #[tokio::test]
    async fn binary_and_truncation_and_errors() {
        let base = server().await;
        let out = HttpRequestTool
            .call(
                &ctx(),
                json!({"method": "GET", "url": format!("{base}/bin")}),
            )
            .await
            .unwrap();
        let t = text(&out);
        assert!(t.contains("binary body not shown: 4 bytes"), "{t}");
        let out = HttpRequestTool
            .call(
                &ctx(),
                json!({"method": "GET", "url": format!("{base}/big"), "max_bytes": 100}),
            )
            .await
            .unwrap();
        let t = text(&out);
        assert!(t.contains("body truncated at 100 bytes"), "{t}");
        assert!(t.contains(&"a".repeat(100)) && !t.contains(&"a".repeat(101)));
        for bad in [
            json!({"method": "GET", "url": "file:///etc/passwd"}),
            json!({"method": "TRACE", "url": format!("{base}/")}),
            json!({"method": "GET", "url": format!("{base}/"), "headers": {"bad name": "x"}}),
        ] {
            assert!(HttpRequestTool.call(&ctx(), bad).await.unwrap().is_error);
        }
    }
}
