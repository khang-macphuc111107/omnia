//! Optional in-memory recorder of raw provider exchanges (request/response
//! inspector). Nothing is persisted or transmitted; secrets are redacted
//! before an exchange is stored.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

/// Exchanges retained per log (ring buffer).
pub const MAX_EXCHANGES: usize = 50;
/// Per-field cap for stored request and response bodies.
pub const MAX_BODY_BYTES: usize = 256 * 1024;
pub const REDACTED: &str = "[REDACTED]";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HeaderEntry {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exchange {
    pub id: u64,
    pub started_at_ms: u64,
    pub provider: String,
    pub model: String,
    pub url: String,
    pub request_headers: Vec<HeaderEntry>,
    pub request_body: String,
    pub request_bytes: usize,
    pub request_truncated: bool,
    pub status: Option<u16>,
    pub response_headers: Vec<HeaderEntry>,
    pub response_body: String,
    pub response_bytes: usize,
    pub response_truncated: bool,
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<u64>,
    pub error: Option<String>,
    pub complete: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStats {
    pub requests: u64,
    pub errors: u64,
    pub retries: u64,
    pub fallbacks: u64,
    pub completed: u64,
    pub average_latency_ms: u64,
}

#[derive(Default)]
struct Inner {
    exchanges: VecDeque<Exchange>,
    stats: LogStats,
    total_latency_ms: u64,
}

/// Ring buffer of the most recent exchanges plus local counters.
#[derive(Default)]
pub struct RequestLog {
    inner: Mutex<Inner>,
    next_id: AtomicU64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// True for header / query-parameter names that may carry credentials.
pub fn is_sensitive_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        "authorization",
        "cookie",
        "key",
        "token",
        "secret",
        "password",
        "signature",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

pub fn redact_headers<'a>(
    headers: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Vec<HeaderEntry> {
    headers
        .into_iter()
        .map(|(name, value)| HeaderEntry {
            name: name.to_owned(),
            value: if is_sensitive_name(name) {
                REDACTED.to_owned()
            } else {
                value.to_owned()
            },
        })
        .collect()
}

/// Remove userinfo and redact secret-looking query values (`key=`, `token=`...).
pub fn redact_url(url: &str) -> String {
    let head = url.split('#').next().unwrap_or(url);
    let (base, query) = match head.split_once('?') {
        Some((b, q)) => (b, Some(q)),
        None => (head, None),
    };
    let mut base = base.to_owned();
    if let Some(scheme_end) = base.find("://") {
        let rest_start = scheme_end + 3;
        let authority_end = base[rest_start..]
            .find('/')
            .map(|i| rest_start + i)
            .unwrap_or(base.len());
        if let Some(at) = base[rest_start..authority_end].rfind('@') {
            base.replace_range(rest_start..rest_start + at + 1, "");
        }
    }
    match query {
        None | Some("") => base,
        Some(query) => {
            let parts: Vec<String> = query
                .split('&')
                .map(|pair| match pair.split_once('=') {
                    Some((name, _)) if is_sensitive_name(name) => format!("{name}={REDACTED}"),
                    _ => pair.to_owned(),
                })
                .collect();
            format!("{base}?{}", parts.join("&"))
        }
    }
}

/// Truncate to at most `max` bytes on a char boundary; returns (text, truncated).
pub fn truncate_text(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_owned(), false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}

impl RequestLog {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Start recording one request. The returned handle finalizes on drop.
    pub fn begin(
        self: &Arc<Self>,
        provider: &str,
        model: &str,
        url: &str,
        headers: &[(String, String)],
        body: &Value,
    ) -> ExchangeHandle {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let raw_body = serde_json::to_string(body).unwrap_or_default();
        let request_bytes = raw_body.len();
        let (request_body, request_truncated) = truncate_text(&raw_body, MAX_BODY_BYTES);
        let exchange = Exchange {
            id,
            started_at_ms: now_ms(),
            provider: provider.to_owned(),
            model: model.to_owned(),
            url: redact_url(url),
            request_headers: redact_headers(headers.iter().map(|(k, v)| (k.as_str(), v.as_str()))),
            request_body,
            request_bytes,
            request_truncated,
            status: None,
            response_headers: Vec::new(),
            response_body: String::new(),
            response_bytes: 0,
            response_truncated: false,
            duration_ms: None,
            ttft_ms: None,
            error: None,
            complete: false,
        };
        {
            let mut inner = self.lock();
            inner.stats.requests += 1;
            inner.exchanges.push_back(exchange);
            while inner.exchanges.len() > MAX_EXCHANGES {
                inner.exchanges.pop_front();
            }
        }
        ExchangeHandle {
            log: Arc::clone(self),
            id,
            started: Instant::now(),
            ttft_ms: None,
            status: None,
            headers: Vec::new(),
            body: Vec::new(),
            body_bytes: 0,
            error: None,
            finished: false,
        }
    }

    pub fn list(&self) -> Vec<Exchange> {
        self.lock().exchanges.iter().cloned().collect()
    }

    pub fn get(&self, id: u64) -> Option<Exchange> {
        self.lock().exchanges.iter().find(|e| e.id == id).cloned()
    }

    pub fn clear(&self) {
        let mut inner = self.lock();
        inner.exchanges.clear();
        inner.stats = LogStats::default();
        inner.total_latency_ms = 0;
    }

    pub fn stats(&self) -> LogStats {
        self.lock().stats.clone()
    }

    pub fn note_retry(&self) {
        self.lock().stats.retries += 1;
    }

    pub fn note_fallback(&self) {
        self.lock().stats.fallbacks += 1;
    }
}

/// Attached to an adapter to record its exchanges.
#[derive(Clone)]
pub struct Recorder {
    pub log: Arc<RequestLog>,
}

/// In-flight exchange; written to the log when finished or dropped.
pub struct ExchangeHandle {
    log: Arc<RequestLog>,
    id: u64,
    started: Instant,
    ttft_ms: Option<u64>,
    status: Option<u16>,
    headers: Vec<HeaderEntry>,
    body: Vec<u8>,
    body_bytes: usize,
    error: Option<String>,
    finished: bool,
}

impl ExchangeHandle {
    pub fn set_response(&mut self, status: u16, headers: &[(String, String)]) {
        self.status = Some(status);
        self.headers = redact_headers(headers.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        // Visible while a stream is still running, not only once it ends.
        let mut inner = self.log.lock();
        if let Some(e) = inner.exchanges.iter_mut().find(|e| e.id == self.id) {
            e.status = Some(status);
            e.response_headers = self.headers.clone();
        }
    }

    pub fn push_chunk(&mut self, chunk: &[u8]) {
        if self.ttft_ms.is_none() {
            let elapsed = self.started.elapsed().as_millis() as u64;
            self.ttft_ms = Some(elapsed);
            let mut inner = self.log.lock();
            if let Some(e) = inner.exchanges.iter_mut().find(|e| e.id == self.id) {
                e.ttft_ms = Some(elapsed);
            }
        }
        self.body_bytes += chunk.len();
        let room = MAX_BODY_BYTES.saturating_sub(self.body.len());
        self.body.extend_from_slice(&chunk[..chunk.len().min(room)]);
    }

    pub fn fail(&mut self, message: impl Into<String>) {
        if self.error.is_none() {
            self.error = Some(message.into());
        }
    }

    pub fn finish(mut self) {
        self.commit();
    }

    fn commit(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        let duration = self.started.elapsed().as_millis() as u64;
        let text = String::from_utf8_lossy(&self.body);
        let (body, cut) = truncate_text(&text, MAX_BODY_BYTES);
        let failed = self.error.is_some() || self.status.is_some_and(|s| s >= 400);
        let mut inner = self.log.lock();
        inner.stats.completed += 1;
        inner.total_latency_ms += duration;
        inner.stats.average_latency_ms = inner.total_latency_ms / inner.stats.completed;
        if failed {
            inner.stats.errors += 1;
        }
        if let Some(e) = inner.exchanges.iter_mut().find(|e| e.id == self.id) {
            e.status = self.status;
            e.response_headers = std::mem::take(&mut self.headers);
            e.response_body = body;
            e.response_bytes = self.body_bytes;
            e.response_truncated = cut || self.body_bytes > MAX_BODY_BYTES;
            e.duration_ms = Some(duration);
            if e.ttft_ms.is_none() {
                e.ttft_ms = self.ttft_ms;
            }
            e.error = self.error.take();
            e.complete = true;
        }
    }
}

impl Drop for ExchangeHandle {
    fn drop(&mut self) {
        self.commit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn headers_with_credentials_are_redacted() {
        let out = redact_headers([
            ("Authorization", "Bearer sk-abc"),
            ("x-api-key", "k"),
            ("api-key", "k"),
            ("Cookie", "a=b"),
            ("X-Auth-Token", "t"),
            ("anthropic-version", "2023-06-01"),
        ]);
        let values: Vec<&str> = out.iter().map(|h| h.value.as_str()).collect();
        assert_eq!(
            values,
            [
                REDACTED,
                REDACTED,
                REDACTED,
                REDACTED,
                REDACTED,
                "2023-06-01"
            ]
        );
    }

    #[test]
    fn url_secrets_and_userinfo_are_removed() {
        assert_eq!(
            redact_url("https://u:p@h.example/v1beta/m:stream?alt=sse&key=AIzaSECRET"),
            "https://h.example/v1beta/m:stream?alt=sse&key=[REDACTED]"
        );
        assert_eq!(redact_url("http://h/v1/messages"), "http://h/v1/messages");
    }

    #[test]
    fn truncation_respects_char_boundaries() {
        let (t, cut) = truncate_text("a\u{e9}", 2);
        assert_eq!(t, "a");
        assert!(cut);
        assert_eq!(truncate_text("abc", 3), ("abc".to_owned(), false));
    }

    #[test]
    fn ring_buffer_keeps_last_fifty_and_counts() {
        let log = RequestLog::new();
        for i in 0..55 {
            let mut h = log.begin("p", "m", "http://h", &[], &json!({"i": i}));
            h.set_response(if i == 54 { 500 } else { 200 }, &[]);
            h.push_chunk(b"data: x\n\n");
            h.finish();
        }
        let list = log.list();
        assert_eq!(list.len(), MAX_EXCHANGES);
        assert_eq!(list[0].id, 6);
        let stats = log.stats();
        assert_eq!((stats.requests, stats.errors, stats.completed), (55, 1, 55));
        assert_eq!(log.get(55).unwrap().response_body, "data: x\n\n");
        log.clear();
        assert!(log.list().is_empty());
    }

    #[test]
    fn large_response_is_capped_and_drop_finalizes() {
        let log = RequestLog::new();
        {
            let mut h = log.begin("p", "m", "http://h", &[], &json!({}));
            h.push_chunk(&vec![b'a'; MAX_BODY_BYTES]);
            h.push_chunk(&[b'b'; 10]);
            h.fail("boom");
        }
        let e = log.get(1).unwrap();
        assert_eq!(e.response_body.len(), MAX_BODY_BYTES);
        assert!(e.response_truncated);
        assert_eq!(e.response_bytes, MAX_BODY_BYTES + 10);
        assert_eq!(e.error.as_deref(), Some("boom"));
        assert_eq!(log.stats().errors, 1);
    }

    #[test]
    fn first_chunk_records_ttft_ms() {
        let log = RequestLog::new();
        let mut h = log.begin("p", "m", "http://h", &[], &json!({}));
        let initial = log.get(1).unwrap();
        assert!(initial.ttft_ms.is_none());
        h.push_chunk(b"first chunk");
        let after_chunk = log.get(1).unwrap();
        assert!(after_chunk.ttft_ms.is_some());
        h.push_chunk(b"second chunk");
        h.finish();
        let final_e = log.get(1).unwrap();
        assert_eq!(final_e.ttft_ms, after_chunk.ttft_ms);
    }
}

#[cfg(test)]
mod server_tests {
    use super::*;
    use crate::provider::anthropic::AnthropicProvider;
    use crate::provider::{Provider, ProviderConfig, ProviderRequest};
    use futures_util::StreamExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn serve(response: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 16 * 1024];
            let _ = socket.read(&mut buf).await;
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        format!("http://{addr}")
    }

    fn provider(base: String, log: &Arc<RequestLog>) -> AnthropicProvider {
        AnthropicProvider::new(ProviderConfig {
            base_url: base,
            api_key: Some("sk-ant-supersecret".into()),
            bearer_auth: false,
            extra_headers: vec![],
        })
        .with_recorder(Arc::clone(log))
    }

    fn request() -> ProviderRequest {
        ProviderRequest {
            model: "claude-x".into(),
            ..ProviderRequest::default()
        }
    }

    #[tokio::test]
    async fn records_streaming_exchange_with_redacted_key() {
        let sse = "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
        let response: &'static str = Box::leak(
            format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nset-cookie: s=1\r\nconnection: close\r\n\r\n{sse}"
            )
            .into_boxed_str(),
        );
        let log = RequestLog::new();
        let p = provider(serve(response).await, &log);
        let mut stream = p.stream(request()).await.unwrap();
        while stream.next().await.is_some() {}
        drop(stream);
        let e = log.get(1).unwrap();
        assert_eq!(e.status, Some(200));
        assert!(e.complete && e.error.is_none());
        assert!(e.response_body.contains("message_stop"));
        assert!(e.request_body.contains("claude-x"));
        let dump = serde_json::to_string(&e).unwrap();
        assert!(!dump.contains("supersecret"));
        let key = e
            .request_headers
            .iter()
            .find(|h| h.name == "x-api-key")
            .unwrap();
        assert_eq!(key.value, REDACTED);
        let cookie = e
            .response_headers
            .iter()
            .find(|h| h.name == "set-cookie")
            .unwrap();
        assert_eq!(cookie.value, REDACTED);
    }

    #[tokio::test]
    async fn records_http_error() {
        let response = "HTTP/1.1 500 Internal Server Error\r\ncontent-length: 4\r\nconnection: close\r\n\r\noops";
        let log = RequestLog::new();
        let p = provider(serve(response).await, &log);
        assert!(p.stream(request()).await.is_err());
        let e = log.get(1).unwrap();
        assert_eq!(e.status, Some(500));
        assert_eq!(e.response_body, "oops");
        assert!(e.error.is_some());
        assert_eq!(log.stats().errors, 1);
    }
}
