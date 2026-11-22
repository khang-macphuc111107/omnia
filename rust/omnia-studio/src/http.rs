//! Async Tokio HTTP/1.1 loopback server, AdGuard header/request-line parser, CORS, and static UI server.

use crate::telemetry::is_reparse_or_symlink;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::path::{Component, Path};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::OwnedReadHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time;
use url::{form_urlencoded, Host, Url};

/// Maximum accepted HTTP request head size (128 KiB handles large AdGuard cookie injections cleanly).
pub const MAX_HEADER_BYTES: usize = 128 * 1024;
/// Maximum accepted HTTP request body size (4 MiB).
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
/// Idle read timeout per client socket.
const CLIENT_READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Maximum static file size served from `ui_root`.
const MAX_STATIC_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// Parsed HTTP/1.x request passed to route handlers.
#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: String,
    pub target: String,
    pub path: String,
    pub query: String,
    pub headers: BTreeMap<String, String>,
    pub cookie_header_count: usize,
    pub body: Vec<u8>,
}

impl HttpRequest {
    /// Looks up a header case-insensitively.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }

    /// Parses URL query parameters as owned `(key, value)` pairs.
    #[must_use]
    pub fn query_params(&self) -> Vec<(String, String)> {
        if self.query.is_empty() {
            return Vec::new();
        }
        form_urlencoded::parse(self.query.as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    }

    /// Returns the first decoded value matching `key` in the query string.
    #[must_use]
    pub fn query_param(&self, key: &str) -> Option<String> {
        self.query_params()
            .into_iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }

    /// Parses the request body as a JSON object (`400` error on non-JSON or non-object).
    pub fn json_object(&self) -> Result<serde_json::Map<String, Value>, HttpResponse> {
        let parsed: Value = serde_json::from_slice(&self.body).map_err(|_| {
            HttpResponse::error(400, "invalid_json", "Request body must be valid JSON.")
        })?;
        match parsed {
            Value::Object(map) => Ok(map),
            _ => Err(HttpResponse::error(
                400,
                "invalid_json_object",
                "Request body must be a JSON object.",
            )),
        }
    }
}

/// Streaming HTTP body forwarded as chunked HTTP/1.1 without full-body buffering.
#[derive(Debug)]
pub enum StreamBody {
    /// Upstream `reqwest::Response` byte stream (used for `/api/chat` SSE pass-through).
    UpstreamProxy {
        upstream: reqwest::Response,
        chunk_timeout: Duration,
        max_bytes: usize,
    },
    /// Internal server-sent event stream pushed from an async producer task.
    EventStream {
        receiver: mpsc::Receiver<Vec<u8>>,
        keepalive_interval: Duration,
    },
}

/// HTTP response written back to the TCP client.
#[derive(Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub content_type: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub stream_body: Option<Box<StreamBody>>,
}

impl HttpResponse {
    /// Constructs a JSON `200 OK` response.
    #[must_use]
    pub fn ok(value: Value) -> Self {
        Self::json(200, value)
    }

    /// Constructs a JSON response with an explicit HTTP status code.
    #[must_use]
    pub fn json(status: u16, value: Value) -> Self {
        let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec());
        Self {
            status,
            content_type: "application/json; charset=utf-8".to_string(),
            headers: Vec::new(),
            body,
            stream_body: None,
        }
    }

    /// Constructs a consistent JSON error payload (`ok: false`, `state: "error"` / `"blocked"`).
    #[must_use]
    pub fn error(status: u16, code: &str, detail: &str) -> Self {
        let state = if status == 403 { "blocked" } else { "error" };
        Self::json(
            status,
            json!({
                "ok": false,
                "state": state,
                "code": code,
                "error": code,
                "detail": detail,
                "message": detail,
            }),
        )
    }

    /// Constructs an empty-body response (for example `204 No Content`).
    #[must_use]
    pub fn empty(status: u16) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8".to_string(),
            headers: Vec::new(),
            body: Vec::new(),
            stream_body: None,
        }
    }

    /// Constructs a binary/text response with explicit MIME type.
    #[must_use]
    pub fn bytes(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status,
            content_type: content_type.to_string(),
            headers: Vec::new(),
            body,
            stream_body: None,
        }
    }

    /// Constructs a zero-buffer chunked streaming response (used for SSE pass-through).
    #[must_use]
    pub fn stream(
        status: u16,
        content_type: &str,
        upstream: reqwest::Response,
        chunk_timeout: Duration,
        max_bytes: usize,
    ) -> Self {
        Self {
            status,
            content_type: content_type.to_string(),
            headers: Vec::new(),
            body: Vec::new(),
            stream_body: Some(Box::new(StreamBody::UpstreamProxy {
                upstream,
                chunk_timeout,
                max_bytes,
            })),
        }
    }

    /// Constructs a server-sent events (SSE) chunked stream backed by an async `mpsc::Receiver`.
    #[must_use]
    pub fn sse_channel(
        receiver: mpsc::Receiver<Vec<u8>>,
        keepalive_interval: Duration,
    ) -> Self {
        Self {
            status: 200,
            content_type: "text/event-stream; charset=utf-8".to_string(),
            headers: Vec::new(),
            body: Vec::new(),
            stream_body: Some(Box::new(StreamBody::EventStream {
                receiver,
                keepalive_interval,
            })),
        }
    }
}

/// Running loopback Studio HTTP server instance.
pub struct StudioServer {
    addr: SocketAddr,
    shutdown_tx: watch::Sender<bool>,
    accept_handle: JoinHandle<()>,
}

impl StudioServer {
    /// Binds `bind_addr` on loopback and starts serving requests with `dispatcher`.
    pub async fn bind_and_serve<S, F, Fut>(
        bind_addr: &str,
        state: Arc<S>,
        dispatcher: F,
    ) -> Result<Self, String>
    where
        S: Send + Sync + 'static,
        F: Fn(Arc<S>, HttpRequest) -> Fut + Send + Sync + Clone + 'static,
        Fut: Future<Output = HttpResponse> + Send + 'static,
    {
        let listener = TcpListener::bind(bind_addr)
            .await
            .map_err(|err| format!("Failed to bind Studio listener on {bind_addr}: {err}"))?;
        let addr = listener
            .local_addr()
            .map_err(|err| format!("Failed to inspect local Studio listener address: {err}"))?;
        if !addr.ip().is_loopback() {
            return Err(format!(
                "Refusing non-loopback bound Studio socket address '{}'.",
                addr.ip()
            ));
        }

        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let accept_handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    changed = shutdown_rx.changed() => {
                        if changed.is_err() || *shutdown_rx.borrow() {
                            break;
                        }
                    }
                    accepted = listener.accept() => {
                        match accepted {
                            Ok((stream, _peer)) => {
                                let conn_state = Arc::clone(&state);
                                let conn_dispatch = dispatcher.clone();
                                tokio::spawn(async move {
                                    let _ = serve_connection(stream, conn_state, conn_dispatch).await;
                                });
                            }
                            Err(_) => {
                                time::sleep(Duration::from_millis(10)).await;
                            }
                        }
                    }
                }
            }
        });

        Ok(Self {
            addr,
            shutdown_tx,
            accept_handle,
        })
    }

    /// Returns the actual bound TCP port (helpful when bound on `:0`).
    #[must_use]
    pub const fn bound_port(&self) -> u16 {
        self.addr.port()
    }

    /// Returns the bound socket address.
    #[must_use]
    pub const fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// Returns the `http://...` loopback base URL for this server.
    #[must_use]
    pub fn base_url(&self) -> String {
        if self.addr.is_ipv6() {
            format!("http://[{}]:{}", self.addr.ip(), self.addr.port())
        } else {
            format!("http://{}:{}", self.addr.ip(), self.addr.port())
        }
    }

    /// Signals the accept loop to stop and awaits shutdown completion.
    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(true);
        let _ = self.accept_handle.await;
    }
}

/// Validates a `Host` header against loopback-only hostnames (`127.0.0.1`, `localhost`, `[::1]`).
#[must_use]
pub fn is_allowed_loopback_host(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > 256
        || has_control_or_space(trimmed)
        || trimmed.contains('@')
    {
        return false;
    }
    let host_part = if let Some(rest) = trimmed.strip_prefix('[') {
        let Some((inner, tail)) = rest.split_once(']') else {
            return false;
        };
        if !tail.is_empty() {
            let Some(port) = tail.strip_prefix(':') else {
                return false;
            };
            if !is_valid_port_str(port) {
                return false;
            }
        }
        inner
    } else if let Some((h, port)) = trimmed.split_once(':') {
        if h.contains(':') {
            return trimmed == "::1";
        }
        if !is_valid_port_str(port) {
            return false;
        }
        h
    } else {
        trimmed
    };

    host_part.eq_ignore_ascii_case("127.0.0.1")
        || host_part.eq_ignore_ascii_case("localhost")
        || host_part == "::1"
}

/// Validates an HTTP `Origin` header (`""` allowed for direct/CLI requests; `"null"` rejected).
#[must_use]
pub fn is_allowed_loopback_origin(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return true;
    }
    if trimmed.eq_ignore_ascii_case("null") || has_control_or_space(trimmed) {
        return false;
    }
    if trimmed.contains('?') || trimmed.contains('#') || trimmed.contains('@') {
        return false;
    }
    let Ok(parsed) = Url::parse(trimmed) else {
        return false;
    };
    if parsed.scheme() != "http" || !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    if parsed.path() != "/" {
        return false;
    }
    // Reject explicit trailing slash (`http://localhost/`) that diverges from browser Origin format.
    if let Some(after_scheme) = trimmed.strip_prefix("http://") {
        if after_scheme.contains('/') {
            return false;
        }
    }
    match parsed.host() {
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// Serves a static UI asset strictly contained inside `ui_root` with MIME & reparse guards.
#[must_use]
pub fn serve_static_asset(ui_root: &Path, request_path: &str) -> HttpResponse {
    let lower = request_path.to_ascii_lowercase();
    if request_path.contains('\0')
        || request_path.contains('\\')
        || request_path.contains("..")
        || lower.contains("%2e")
        || lower.contains("%2f")
        || lower.contains("%5c")
    {
        return HttpResponse::error(
            403,
            "forbidden_path",
            "Static asset path traversal rejected.",
        );
    }

    let rel_str = match request_path {
        "/" | "/index.html" => "index.html",
        other => {
            let trimmed = other.trim_start_matches('/');
            if !(trimmed.starts_with("styles/")
                || trimmed.starts_with("app/")
                || trimmed.starts_with("assets/")
                || trimmed == "favicon.ico")
            {
                return HttpResponse::error(404, "not_found", "Static asset route not found.");
            }
            trimmed
        }
    };

    let Ok(root_meta) = std::fs::symlink_metadata(ui_root) else {
        return HttpResponse::error(
            503,
            "ui_root_unavailable",
            "Studio UI root directory missing.",
        );
    };
    if is_reparse_or_symlink(&root_meta) || !root_meta.is_dir() {
        return HttpResponse::error(403, "forbidden_path", "Studio UI root rejected.");
    }
    let Ok(canonical_root) = std::fs::canonicalize(ui_root) else {
        return HttpResponse::error(503, "ui_root_unavailable", "Studio UI root unreadable.");
    };

    let mut cursor = canonical_root.clone();
    for comp in Path::new(rel_str).components() {
        match comp {
            Component::Normal(seg) => {
                cursor.push(seg);
                let Ok(meta) = std::fs::symlink_metadata(&cursor) else {
                    return HttpResponse::error(
                        404,
                        "not_found",
                        "Requested static asset does not exist.",
                    );
                };
                if is_reparse_or_symlink(&meta) {
                    return HttpResponse::error(
                        403,
                        "forbidden_path",
                        "Symlink or reparse point rejected.",
                    );
                }
            }
            _ => {
                return HttpResponse::error(403, "forbidden_path", "Illegal path component.");
            }
        }
    }

    let Ok(canonical_target) = std::fs::canonicalize(&cursor) else {
        return HttpResponse::error(404, "not_found", "Requested static asset does not exist.");
    };
    if !canonical_target.starts_with(&canonical_root) {
        return HttpResponse::error(403, "forbidden_path", "Resolved asset escapes UI root.");
    }
    let Ok(file_meta) = std::fs::symlink_metadata(&canonical_target) else {
        return HttpResponse::error(404, "not_found", "Requested static asset does not exist.");
    };
    if is_reparse_or_symlink(&file_meta)
        || !file_meta.is_file()
        || file_meta.len() > MAX_STATIC_FILE_BYTES
    {
        return HttpResponse::error(
            403,
            "forbidden_path",
            "Requested asset is not a readable regular file.",
        );
    }

    match std::fs::read(&canonical_target) {
        Ok(bytes) => HttpResponse::bytes(200, mime_type_for_path(&canonical_target), bytes),
        Err(_) => HttpResponse::error(500, "static_read_failed", "Failed reading static UI asset."),
    }
}

/// Parses an HTTP/1.x request head block (tolerating multi-space request lines and 15+ repeated
/// `Cookie:` headers) plus any residual already-buffered body bytes.
pub fn parse_http_head_and_remainder(
    raw: &[u8],
) -> Result<(HttpRequest, Option<usize>, bool, Vec<u8>), HttpResponse> {
    let Some(header_end_pos) = find_header_end(raw) else {
        return Err(HttpResponse::error(
            400,
            "malformed_http_request",
            "Missing CRLFCRLF HTTP header terminator.",
        ));
    };
    if header_end_pos + 4 > MAX_HEADER_BYTES {
        return Err(HttpResponse::error(
            431,
            "headers_too_large",
            "HTTP header block exceeds maximum byte budget.",
        ));
    }

    let head_bytes = &raw[..header_end_pos];
    let remainder = raw[header_end_pos + 4..].to_vec();
    let head_str = std::str::from_utf8(head_bytes).map_err(|_| {
        HttpResponse::error(
            400,
            "invalid_utf8_headers",
            "HTTP headers must be valid UTF-8.",
        )
    })?;

    let mut lines = head_str.split("\r\n");
    let req_line = lines.next().ok_or_else(|| {
        HttpResponse::error(
            400,
            "malformed_request_line",
            "HTTP request line is missing.",
        )
    })?;

    // `split_whitespace` handles AdGuard-rewritten request lines like `GET  /api/health  HTTP/1.1`.
    let mut parts = req_line.split_whitespace();
    let method = parts.next().ok_or_else(|| {
        HttpResponse::error(400, "malformed_request_line", "Missing HTTP method.")
    })?;
    let target = parts.next().ok_or_else(|| {
        HttpResponse::error(
            400,
            "malformed_request_line",
            "Missing HTTP request target.",
        )
    })?;
    let version = parts.next().ok_or_else(|| {
        HttpResponse::error(400, "malformed_request_line", "Missing HTTP version.")
    })?;
    if parts.next().is_some() || !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return Err(HttpResponse::error(
            400,
            "malformed_request_line",
            "Unsupported HTTP version or unexpected request-line tokens.",
        ));
    }
    if method.is_empty() || !method.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(HttpResponse::error(
            400,
            "invalid_method",
            "HTTP method token is invalid.",
        ));
    }
    if !target.starts_with('/') || target.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return Err(HttpResponse::error(
            400,
            "invalid_target",
            "HTTP request target must be origin-form without control characters.",
        ));
    }

    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let mut headers: BTreeMap<String, String> = BTreeMap::new();
    let mut content_length: Option<usize> = None;
    let mut is_chunked = false;
    let mut cookie_header_count = 0usize;

    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((raw_name, raw_val)) = line.split_once(':') else {
            return Err(HttpResponse::error(
                400,
                "malformed_header",
                "HTTP header line lacks colon separator.",
            ));
        };
        let name = raw_name.trim().to_ascii_lowercase();
        if name.is_empty() || !name.bytes().all(is_valid_header_name_byte) {
            return Err(HttpResponse::error(
                400,
                "invalid_header_name",
                "HTTP header name contains invalid characters.",
            ));
        }
        let val = raw_val.trim();
        if val.bytes().any(|b| (b < 0x20 && b != b'\t') || b == 0x7f) {
            return Err(HttpResponse::error(
                400,
                "invalid_header_value",
                "HTTP header value contains control characters.",
            ));
        }

        if name == "content-length" {
            let parsed = val.parse::<usize>().map_err(|_| {
                HttpResponse::error(
                    400,
                    "invalid_content_length",
                    "Invalid Content-Length header.",
                )
            })?;
            if let Some(prev) = content_length {
                if prev != parsed {
                    return Err(HttpResponse::error(
                        400,
                        "conflicting_content_length",
                        "Conflicting Content-Length headers are forbidden.",
                    ));
                }
            } else {
                content_length = Some(parsed);
            }
        } else if name == "transfer-encoding" && val.to_ascii_lowercase().contains("chunked") {
            is_chunked = true;
        }

        if name == "cookie" {
            cookie_header_count += 1;
            headers
                .entry(name)
                .and_modify(|existing| {
                    if !existing.is_empty() && !val.is_empty() {
                        existing.push_str("; ");
                    }
                    existing.push_str(val);
                })
                .or_insert_with(|| val.to_string());
        } else {
            headers
                .entry(name)
                .and_modify(|existing| {
                    if !existing.is_empty() && !val.is_empty() {
                        existing.push_str(", ");
                    }
                    existing.push_str(val);
                })
                .or_insert_with(|| val.to_string());
        }
    }

    if is_chunked && content_length.is_some() {
        return Err(HttpResponse::error(
            400,
            "ambiguous_framing",
            "Content-Length combined with Transfer-Encoding: chunked is forbidden.",
        ));
    }
    if let Some(len) = content_length {
        if len > MAX_BODY_BYTES {
            return Err(HttpResponse::error(
                413,
                "payload_too_large",
                "Request body exceeds 4 MiB maximum limit.",
            ));
        }
    }
    if version == "HTTP/1.1" && !headers.contains_key("host") {
        return Err(HttpResponse::error(
            400,
            "missing_host",
            "HTTP/1.1 request must include a Host header.",
        ));
    }
    if let Some(host) = headers.get("host") {
        if !is_allowed_loopback_host(host) {
            return Err(HttpResponse::error(
                403,
                "forbidden_host",
                "Non-loopback Host header rejected.",
            ));
        }
    }
    if let Some(origin) = headers.get("origin") {
        if !is_allowed_loopback_origin(origin) {
            return Err(HttpResponse::error(
                403,
                "forbidden_origin",
                "Origin header outside loopback allowlist rejected.",
            ));
        }
    }
    if let Some(fetch_site) = headers.get("sec-fetch-site") {
        if !is_allowed_fetch_site(fetch_site) {
            return Err(HttpResponse::error(
                403,
                "forbidden_cross_site",
                "Cross-site browser request rejected by Sec-Fetch-Site guard.",
            ));
        }
    }

    let req = HttpRequest {
        method: method.to_string(),
        target: target.to_string(),
        path: path.to_string(),
        query: query.to_string(),
        headers,
        cookie_header_count,
        body: Vec::new(),
    };
    Ok((req, content_length, is_chunked, remainder))
}

async fn read_http_request<R>(stream: &mut R) -> Result<HttpRequest, HttpResponse>
where
    R: AsyncRead + Unpin,
{
    let mut buffer = Vec::with_capacity(8192);
    let mut chunk = [0_u8; 4096];

    loop {
        if let Some(_pos) = find_header_end(&buffer) {
            break;
        }
        if buffer.len() >= MAX_HEADER_BYTES {
            return Err(HttpResponse::error(
                431,
                "headers_too_large",
                "HTTP header block exceeds maximum byte budget.",
            ));
        }
        let read = match time::timeout(CLIENT_READ_TIMEOUT, stream.read(&mut chunk)).await {
            Ok(Ok(n)) => n,
            Ok(Err(_)) => {
                return Err(HttpResponse::error(
                    400,
                    "connection_read_failed",
                    "Failed reading HTTP request from client socket.",
                ))
            }
            Err(_) => {
                return Err(HttpResponse::error(
                    408,
                    "request_timeout",
                    "Timed out waiting for complete HTTP request headers.",
                ))
            }
        };
        if read == 0 {
            return Err(HttpResponse::error(
                400,
                "empty_request",
                "Client closed connection before completing HTTP headers.",
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
    }

    let (mut req, content_length, is_chunked, mut remainder) =
        parse_http_head_and_remainder(&buffer)?;

    if is_chunked {
        req.body = read_chunked_body(stream, remainder).await?;
    } else if let Some(expected_len) = content_length {
        while remainder.len() < expected_len {
            let remaining = expected_len - remainder.len();
            let mut body_chunk = vec![0_u8; remaining.min(16 * 1024)];
            let read = match time::timeout(CLIENT_READ_TIMEOUT, stream.read(&mut body_chunk)).await
            {
                Ok(Ok(n)) => n,
                Ok(Err(_)) | Err(_) => {
                    return Err(HttpResponse::error(
                        400,
                        "incomplete_body",
                        "Failed reading full HTTP request body.",
                    ))
                }
            };
            if read == 0 {
                return Err(HttpResponse::error(
                    400,
                    "incomplete_body",
                    "Client closed connection before sending full Content-Length.",
                ));
            }
            remainder.extend_from_slice(&body_chunk[..read]);
        }
        remainder.truncate(expected_len);
        req.body = remainder;
    }

    Ok(req)
}

async fn read_chunked_body<R>(stream: &mut R, mut buf: Vec<u8>) -> Result<Vec<u8>, HttpResponse>
where
    R: AsyncRead + Unpin,
{
    let mut out = Vec::new();
    let mut cursor = 0usize;
    let mut tmp = [0_u8; 4096];

    loop {
        let line_end = loop {
            if let Some(rel) = buf[cursor..].windows(2).position(|w| w == b"\r\n") {
                break cursor + rel;
            }
            if buf.len() > MAX_BODY_BYTES + MAX_HEADER_BYTES {
                return Err(HttpResponse::error(
                    413,
                    "payload_too_large",
                    "Chunked body exceeded size limit.",
                ));
            }
            let n = time::timeout(CLIENT_READ_TIMEOUT, stream.read(&mut tmp))
                .await
                .map_err(|_| HttpResponse::error(408, "request_timeout", "Chunk read timeout."))?
                .map_err(|_| HttpResponse::error(400, "incomplete_body", "Chunk read failed."))?;
            if n == 0 {
                return Err(HttpResponse::error(
                    400,
                    "incomplete_body",
                    "Unexpected EOF in chunked body.",
                ));
            }
            buf.extend_from_slice(&tmp[..n]);
        };

        let size_line = std::str::from_utf8(&buf[cursor..line_end])
            .map_err(|_| HttpResponse::error(400, "invalid_chunk", "Invalid chunk size UTF-8."))?;
        let hex_part = size_line.split(';').next().unwrap_or("").trim();
        let chunk_len = usize::from_str_radix(hex_part, 16)
            .map_err(|_| HttpResponse::error(400, "invalid_chunk", "Malformed chunk length."))?;
        cursor = line_end + 2;

        if chunk_len == 0 {
            return Ok(out);
        }
        if out.len().saturating_add(chunk_len) > MAX_BODY_BYTES {
            return Err(HttpResponse::error(
                413,
                "payload_too_large",
                "Chunked body exceeded 4 MiB limit.",
            ));
        }

        while buf.len() < cursor + chunk_len + 2 {
            let n = time::timeout(CLIENT_READ_TIMEOUT, stream.read(&mut tmp))
                .await
                .map_err(|_| HttpResponse::error(408, "request_timeout", "Chunk data timeout."))?
                .map_err(|_| HttpResponse::error(400, "incomplete_body", "Chunk data failed."))?;
            if n == 0 {
                return Err(HttpResponse::error(
                    400,
                    "incomplete_body",
                    "Unexpected EOF inside HTTP chunk payload.",
                ));
            }
            buf.extend_from_slice(&tmp[..n]);
        }
        out.extend_from_slice(&buf[cursor..cursor + chunk_len]);
        if &buf[cursor + chunk_len..cursor + chunk_len + 2] != b"\r\n" {
            return Err(HttpResponse::error(
                400,
                "invalid_chunk",
                "Missing CRLF after HTTP chunk payload.",
            ));
        }
        cursor += chunk_len + 2;
    }
}

async fn serve_connection<S, F, Fut>(
    mut stream: TcpStream,
    state: Arc<S>,
    dispatcher: F,
) -> io::Result<()>
where
    S: Send + Sync + 'static,
    F: Fn(Arc<S>, HttpRequest) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = HttpResponse> + Send + 'static,
{
    let req_result = read_http_request(&mut stream).await;
    let (mut response, req_origin) = match req_result {
        Ok(req) => {
            let origin = req.header("origin").map(ToOwned::to_owned);
            let resp = if req.method == "OPTIONS" {
                let mut r = HttpResponse::empty(204);
                r.headers.push((
                    "Access-Control-Allow-Methods".to_string(),
                    "GET, POST, OPTIONS".to_string(),
                ));
                r.headers.push((
                    "Access-Control-Allow-Headers".to_string(),
                    "Content-Type".to_string(),
                ));
                r
            } else {
                dispatcher(state, req).await
            };
            (resp, origin)
        }
        Err(err_resp) => (err_resp, None),
    };

    if let Some(origin) = req_origin.as_deref() {
        if is_allowed_loopback_origin(origin) && !origin.trim().is_empty() {
            response.headers.push((
                "Access-Control-Allow-Origin".to_string(),
                origin.trim().to_string(),
            ));
            response
                .headers
                .push(("Vary".to_string(), "Origin".to_string()));
        }
    }

    if let Some(stream_body) = response.stream_body.take() {
        return write_streaming_http_response(stream, &response, *stream_body).await;
    }

    write_http_response(&mut stream, &response).await
}

/// Validates a `Sec-Fetch-Site` browser header (`cross-site` is always blocked with HTTP 403).
#[must_use]
pub fn is_allowed_fetch_site(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return true;
    }
    if has_control_or_space(trimmed) {
        return false;
    }
    trimmed
        .split(',')
        .map(str::trim)
        .all(|token| !token.eq_ignore_ascii_case("cross-site"))
}

async fn wait_for_client_disconnect(reader: &mut OwnedReadHalf) -> io::Result<()> {
    let mut buf = [0_u8; 512];
    loop {
        reader.readable().await?;
        match reader.try_read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(_) => continue,
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => continue,
            Err(err) => return Err(err),
        }
    }
}

async fn write_streaming_http_response(
    stream: TcpStream,
    response: &HttpResponse,
    stream_body: StreamBody,
) -> io::Result<()> {
    let (mut reader, mut writer) = stream.into_split();
    let reason = status_reason(response.status);
    let mut head = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\n",
        response.status, response.content_type,
    );
    for (name, value) in &response.headers {
        let safe_name = name.replace(['\r', '\n'], "");
        let safe_val = value.replace(['\r', '\n'], "");
        head.push_str(&format!("{safe_name}: {safe_val}\r\n"));
    }
    head.push_str("\r\n");

    writer.write_all(head.as_bytes()).await?;
    writer.flush().await?;

    let client_disconnect = wait_for_client_disconnect(&mut reader);
    tokio::pin!(client_disconnect);

    match stream_body {
        StreamBody::UpstreamProxy {
            upstream,
            chunk_timeout,
            max_bytes,
        } => {
            let mut total_bytes = 0usize;
            let mut upstream = upstream.bytes_stream();
            loop {
                let next = tokio::select! {
                    disc = &mut client_disconnect => {
                        return disc.and_then(|_| {
                            Err(io::Error::new(
                                io::ErrorKind::BrokenPipe,
                                "studio SSE client disconnected",
                            ))
                        });
                    }
                    item = time::timeout(chunk_timeout, upstream.next()) => item,
                };

                let chunk = match next {
                    Ok(Some(Ok(bytes))) => bytes,
                    Ok(None) => break,
                    Ok(Some(Err(_))) => {
                        return Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "upstream SSE stream terminated unexpectedly",
                        ));
                    }
                    Err(_) => {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "upstream SSE chunk timed out",
                        ));
                    }
                };
                if chunk.is_empty() {
                    continue;
                }
                total_bytes = total_bytes.saturating_add(chunk.len());
                if total_bytes > max_bytes {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "upstream SSE stream exceeded max byte limit",
                    ));
                }
                let frame_head = format!("{:X}\r\n", chunk.len());
                writer.write_all(frame_head.as_bytes()).await?;
                writer.write_all(&chunk).await?;
                writer.write_all(b"\r\n").await?;
                writer.flush().await?;
            }
        }
        StreamBody::EventStream {
            mut receiver,
            keepalive_interval,
        } => {
            let ping_frame = b"8\r\n: ping\n\n\r\n";
            loop {
                tokio::select! {
                    _ = &mut client_disconnect => {
                        return Ok(());
                    }
                    maybe_chunk = receiver.recv() => {
                        match maybe_chunk {
                            Some(chunk) if !chunk.is_empty() => {
                                let frame_head = format!("{:X}\r\n", chunk.len());
                                writer.write_all(frame_head.as_bytes()).await?;
                                writer.write_all(&chunk).await?;
                                writer.write_all(b"\r\n").await?;
                                writer.flush().await?;
                            }
                            Some(_) => continue,
                            None => break,
                        }
                    }
                    _ = time::sleep(keepalive_interval) => {
                        writer.write_all(ping_frame).await?;
                        writer.flush().await?;
                    }
                }
            }
        }
    }

    writer.write_all(b"0\r\n\r\n").await?;
    writer.flush().await
}

async fn write_http_response(stream: &mut TcpStream, response: &HttpResponse) -> io::Result<()> {
    let reason = status_reason(response.status);
    let mut head = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n",
        response.status,
        response.content_type,
        response.body.len(),
    );
    for (name, value) in &response.headers {
        let safe_name = name.replace(['\r', '\n'], "");
        let safe_val = value.replace(['\r', '\n'], "");
        head.push_str(&format!("{safe_name}: {safe_val}\r\n"));
    }
    head.push_str("\r\n");

    stream.write_all(head.as_bytes()).await?;
    if !response.body.is_empty() {
        stream.write_all(&response.body).await?;
    }
    stream.flush().await
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn is_valid_header_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')
}

fn has_control_or_space(s: &str) -> bool {
    s.bytes().any(|b| b <= 0x20 || b == 0x7f)
}

fn is_valid_port_str(port: &str) -> bool {
    !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) && port.parse::<u16>().is_ok()
}

fn mime_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") => "application/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("txt") | Some("md") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

const fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "OK",
    }
}
