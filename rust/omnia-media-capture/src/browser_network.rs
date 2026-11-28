//! CDP network capture ring (`2000` entries), redirect hop archival, console/dialog rings,
//! URL credential/query redaction, and authenticated download `replay_spec()` synthesis.

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use url::Url;

/// Maximum retained network requests in [`NetworkRing`].
pub const NETWORK_RING_CAPACITY: usize = 2_000;
/// Maximum retained console/exception entries in [`ConsoleRing`].
pub const CONSOLE_RING_CAPACITY: usize = 500;
/// Maximum retained JS dialog records per tab.
pub const DIALOG_RING_CAPACITY: usize = 100;

/// Automatic response policy for browser JS `alert`/`confirm`/`prompt`/`beforeunload` dialogs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DialogPolicy {
    /// Accepts `alert` and `beforeunload`; dismisses `confirm` and `prompt` (zero hang).
    #[default]
    Auto,
    /// Accepts every JS dialog.
    AcceptAll,
    /// Dismisses every JS dialog.
    DismissAll,
}

impl DialogPolicy {
    /// Returns `(accept, prompt_text)` for a CDP `Page.javascriptDialogOpening` dialog type.
    #[must_use]
    pub fn decide(self, dialog_type: &str) -> (bool, Option<&'static str>) {
        match self {
            Self::AcceptAll => (true, None),
            Self::DismissAll => (false, None),
            Self::Auto => match dialog_type {
                "alert" | "beforeunload" => (true, None),
                _ => (false, None),
            },
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::AcceptAll => "accept_all",
            Self::DismissAll => "dismiss_all",
        }
    }
}

/// Recorded browser JavaScript dialog handled automatically by the CDP supervisor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogRecord {
    pub dialog_type: String,
    pub message: String,
    pub accepted: bool,
}

impl DialogRecord {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "dialog_type": self.dialog_type,
            "message": self.message,
            "accepted": self.accepted,
        })
    }
}

/// Captured browser console message, page exception, or browser log entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsoleEntry {
    pub level: String,
    pub text: String,
    pub source: Option<String>,
    pub line: Option<u64>,
}

impl ConsoleEntry {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "level": self.level,
            "text": self.text,
            "source": self.source,
            "line": self.line,
        })
    }
}

/// Bounded ring buffer of browser console messages and uncaught exceptions.
#[derive(Debug, Clone)]
pub struct ConsoleRing {
    entries: VecDeque<ConsoleEntry>,
    capacity: usize,
}

impl Default for ConsoleRing {
    fn default() -> Self {
        Self::new(CONSOLE_RING_CAPACITY)
    }
}

impl ConsoleRing {
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: VecDeque::with_capacity(capacity.min(CONSOLE_RING_CAPACITY)),
            capacity: capacity.max(1),
        }
    }

    pub fn push(&mut self, entry: ConsoleEntry) {
        if self.entries.len() >= self.capacity {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }

    /// Ingests a `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, or `Log.entryAdded` event.
    pub fn ingest_cdp_event(&mut self, method: &str, params: &Value) {
        match method {
            "Runtime.consoleAPICalled" => {
                let level = params
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("log")
                    .to_string();
                let text = params
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|args| {
                        args.iter()
                            .map(format_remote_object)
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .unwrap_or_default();
                let frame = params
                    .pointer("/stackTrace/callFrames/0")
                    .and_then(Value::as_object);
                let source = frame
                    .and_then(|f| f.get("url"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(redact_url);
                let line = frame
                    .and_then(|f| f.get("lineNumber"))
                    .and_then(Value::as_u64)
                    .map(|l| l + 1);
                self.push(ConsoleEntry {
                    level,
                    text,
                    source,
                    line,
                });
            }
            "Runtime.exceptionThrown" => {
                let detail = params.get("exceptionDetails").unwrap_or(params);
                let desc = detail
                    .pointer("/exception/description")
                    .and_then(Value::as_str)
                    .or_else(|| detail.get("text").and_then(Value::as_str))
                    .unwrap_or("uncaught exception")
                    .to_string();
                let source = detail
                    .get("url")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(redact_url);
                let line = detail
                    .get("lineNumber")
                    .and_then(Value::as_u64)
                    .map(|l| l + 1);
                self.push(ConsoleEntry {
                    level: "error".to_string(),
                    text: desc,
                    source,
                    line,
                });
            }
            "Log.entryAdded" => {
                let entry = params.get("entry").unwrap_or(params);
                let level = entry
                    .get("level")
                    .and_then(Value::as_str)
                    .unwrap_or("info")
                    .to_string();
                let text = entry
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let source = entry
                    .get("url")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(redact_url);
                let line = entry.get("lineNumber").and_then(Value::as_u64);
                self.push(ConsoleEntry {
                    level,
                    text,
                    source,
                    line,
                });
            }
            _ => {}
        }
    }

    #[must_use]
    pub fn entries(&self) -> Vec<ConsoleEntry> {
        self.entries.iter().cloned().collect()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

fn format_remote_object(val: &Value) -> String {
    if let Some(v) = val.get("value") {
        if let Some(s) = v.as_str() {
            return s.to_string();
        }
        return v.to_string();
    }
    if let Some(desc) = val.get("description").and_then(Value::as_str) {
        return desc.to_string();
    }
    if let Some(unser) = val.get("unserializableValue").and_then(Value::as_str) {
        return unser.to_string();
    }
    val.get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

/// Strips embedded credentials (`user:pass@`), query strings, and fragments from a URL
/// so persisted logs, summaries, and UI telemetry never leak signed tokens or secrets.
#[must_use]
pub fn redact_url(raw: &str) -> String {
    let trimmed = raw.trim();
    match Url::parse(trimmed) {
        Ok(mut parsed) => {
            let _ = parsed.set_username("");
            let _ = parsed.set_password(None);
            parsed.set_query(None);
            parsed.set_fragment(None);
            parsed.to_string()
        }
        Err(_) => trimmed
            .split(['?', '#'])
            .next()
            .unwrap_or(trimmed)
            .to_string(),
    }
}

/// Returns `true` when an HTTP header name is secret-bearing and must be redacted from logs/JSON.
#[must_use]
pub fn is_sensitive_header_name(name: &str) -> bool {
    let low = name.trim().to_ascii_lowercase();
    matches!(
        low.as_str(),
        "authorization"
            | "proxy-authorization"
            | "cookie"
            | "set-cookie"
            | "x-api-key"
            | "x-auth-token"
            | "x-csrf-token"
            | "x-xsrf-token"
            | "api-key"
    ) || low.contains("token")
        || low.contains("secret")
        || low.contains("password")
}

/// Returns `true` for hop-by-hop, framing, pseudo (`:*`), or range headers that must NOT be
/// forwarded verbatim into a standalone HTTP replay downloader.
#[must_use]
pub fn is_non_replayable_header(name: &str) -> bool {
    let low = name.trim().to_ascii_lowercase();
    low.is_empty()
        || low.starts_with(':')
        || matches!(
            low.as_str(),
            "host"
                | "connection"
                | "keep-alive"
                | "proxy-connection"
                | "transfer-encoding"
                | "content-length"
                | "upgrade"
                | "te"
                | "trailer"
                | "range"
                | "if-range"
                | "accept-encoding"
        )
}

/// Single captured CDP network request/response record.
#[derive(Debug, Clone, PartialEq)]
pub struct NetworkEntry {
    pub request_id: String,
    pub url: String,
    pub method: String,
    pub resource_type: String,
    pub status: Option<u16>,
    pub status_text: Option<String>,
    pub mime_type: Option<String>,
    pub encoded_data_length: Option<u64>,
    pub failed_error: Option<String>,
    pub finished: bool,
    pub request_headers: Vec<(String, String)>,
    pub response_headers: Vec<(String, String)>,
    pub redirect_hop: u32,
}

impl NetworkEntry {
    /// Secret-free JSON summary safe for UI inspection, agent tool output, and logs.
    #[must_use]
    pub fn to_redacted_json(&self) -> Value {
        let redact_header_val = |k: &str, v: &str| -> String {
            if is_sensitive_header_name(k) {
                "[REDACTED]".to_string()
            } else if k.eq_ignore_ascii_case("referer") || k.eq_ignore_ascii_case("location") {
                redact_url(v)
            } else {
                v.to_string()
            }
        };
        let req_headers: Vec<Value> = self
            .request_headers
            .iter()
            .map(|(k, v)| json!([k, redact_header_val(k, v)]))
            .collect();
        let resp_headers: Vec<Value> = self
            .response_headers
            .iter()
            .map(|(k, v)| json!([k, redact_header_val(k, v)]))
            .collect();
        json!({
            "request_id": self.request_id,
            "url": redact_url(&self.url),
            "method": self.method,
            "resource_type": self.resource_type,
            "status": self.status,
            "status_text": self.status_text,
            "mime_type": self.mime_type,
            "encoded_data_length": self.encoded_data_length,
            "failed_error": self.failed_error,
            "finished": self.finished,
            "redirect_hop": self.redirect_hop,
            "request_headers": req_headers,
            "response_headers": resp_headers,
        })
    }
}

/// Authenticated download replay specification produced by [`NetworkRing::replay_spec`].
///
/// Sensitive credentials (`cookies`, `headers`, raw signed `url`) live strictly in memory for
/// handoff into `omnia-downloader`; call [`Self::to_redacted_json`] for logs or UI display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayRequestSpec {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub cookies: Option<String>,
    pub referer: Option<String>,
    pub user_agent: Option<String>,
}

impl ReplayRequestSpec {
    /// Secret-free summary safe for diagnostics, logs, and UI display.
    #[must_use]
    pub fn to_redacted_json(&self) -> Value {
        let safe_headers: Vec<Value> = self
            .headers
            .iter()
            .map(|(k, v)| {
                let sv = if is_sensitive_header_name(k) {
                    "[REDACTED]"
                } else {
                    v.as_str()
                };
                json!([k, sv])
            })
            .collect();
        json!({
            "url": redact_url(&self.url),
            "method": self.method,
            "header_count": self.headers.len(),
            "headers": safe_headers,
            "has_cookies": self.cookies.as_ref().is_some_and(|c| !c.is_empty()),
            "referer": self.referer.as_deref().map(redact_url),
            "user_agent": self.user_agent,
        })
    }
}

/// Optional filter for querying [`NetworkRing`].
#[derive(Debug, Clone, Default)]
pub struct NetworkFilter {
    pub url_contains: Option<String>,
    pub resource_type: Option<String>,
    pub status: Option<u16>,
    pub failed_only: bool,
    pub limit: Option<usize>,
}

/// Bounded `2000`-entry CDP network capture ring merging `ExtraInfo` headers and archiving redirects.
#[derive(Debug, Clone)]
pub struct NetworkRing {
    order: VecDeque<String>,
    entries: HashMap<String, NetworkEntry>,
    /// Tracks redirect hop count for an active `requestId`.
    redirect_counts: HashMap<String, u32>,
    /// Pending `requestWillBeSentExtraInfo` headers received before `requestWillBeSent`.
    pending_extra_req: HashMap<String, Vec<(String, String)>>,
    capacity: usize,
}

impl Default for NetworkRing {
    fn default() -> Self {
        Self::new(NETWORK_RING_CAPACITY)
    }
}

impl NetworkRing {
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        let cap = capacity.max(1);
        Self {
            order: VecDeque::with_capacity(cap.min(NETWORK_RING_CAPACITY)),
            entries: HashMap::new(),
            redirect_counts: HashMap::new(),
            pending_extra_req: HashMap::new(),
            capacity: cap,
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn clear(&mut self) {
        self.order.clear();
        self.entries.clear();
        self.redirect_counts.clear();
        self.pending_extra_req.clear();
    }

    fn insert_entry(&mut self, entry: NetworkEntry) {
        let id = entry.request_id.clone();
        if !self.entries.contains_key(&id) {
            while self.order.len() >= self.capacity {
                if let Some(oldest) = self.order.pop_front() {
                    self.entries.remove(&oldest);
                    self.redirect_counts.remove(&oldest);
                    self.pending_extra_req.remove(&oldest);
                }
            }
            self.order.push_back(id.clone());
        }
        self.entries.insert(id, entry);
    }

    /// Processes CDP `Network.*` events (`requestWillBeSent`, `*ExtraInfo`, `responseReceived`,
    /// `loadingFinished`, `loadingFailed`).
    pub fn ingest_cdp_event(&mut self, method: &str, params: &Value) {
        let Some(req_id) = params.get("requestId").and_then(Value::as_str) else {
            return;
        };
        match method {
            "Network.requestWillBeSent" => {
                // If this event carries a `redirectResponse`, archive the previous hop under `{id}#r{n}`!
                if let Some(redir_resp) = params.get("redirectResponse").filter(|v| v.is_object()) {
                    if let Some(mut prev) = self.entries.remove(req_id) {
                        if let Some(pos) = self.order.iter().position(|id| id == req_id) {
                            self.order.remove(pos);
                        }
                        let hop = {
                            let c = self.redirect_counts.entry(req_id.to_string()).or_insert(0);
                            *c += 1;
                            *c
                        };
                        prev.status = redir_resp
                            .get("status")
                            .and_then(Value::as_u64)
                            .map(|s| s as u16);
                        prev.status_text = redir_resp
                            .get("statusText")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        prev.mime_type = redir_resp
                            .get("mimeType")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        merge_headers(
                            &mut prev.response_headers,
                            parse_headers_obj(redir_resp.get("headers")),
                        );
                        prev.finished = true;
                        let archived_id = format!("{req_id}#r{hop}");
                        prev.request_id = archived_id;
                        prev.redirect_hop = hop;
                        self.insert_entry(prev);
                    }
                }

                let req = params.get("request").unwrap_or(&Value::Null);
                let url = req
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let http_method = req
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or("GET")
                    .to_string();
                let resource_type = params
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("Other")
                    .to_string();
                let mut request_headers = parse_headers_obj(req.get("headers"));
                if let Some(extra) = self.pending_extra_req.remove(req_id) {
                    merge_headers(&mut request_headers, extra);
                }
                let hop = self.redirect_counts.get(req_id).copied().unwrap_or(0);
                self.insert_entry(NetworkEntry {
                    request_id: req_id.to_string(),
                    url,
                    method: http_method,
                    resource_type,
                    status: None,
                    status_text: None,
                    mime_type: None,
                    encoded_data_length: None,
                    failed_error: None,
                    finished: false,
                    request_headers,
                    response_headers: Vec::new(),
                    redirect_hop: hop,
                });
            }
            "Network.requestWillBeSentExtraInfo" => {
                let extra = parse_headers_obj(params.get("headers"));
                if let Some(entry) = self.entries.get_mut(req_id) {
                    merge_headers(&mut entry.request_headers, extra);
                } else {
                    self.pending_extra_req.insert(req_id.to_string(), extra);
                }
            }
            "Network.responseReceived" => {
                let resp = params.get("response").unwrap_or(&Value::Null);
                if let Some(entry) = self.entries.get_mut(req_id) {
                    entry.status = resp.get("status").and_then(Value::as_u64).map(|s| s as u16);
                    entry.status_text = resp
                        .get("statusText")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    entry.mime_type = resp
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    if let Some(rt) = params.get("type").and_then(Value::as_str) {
                        if !rt.is_empty() {
                            entry.resource_type = rt.to_string();
                        }
                    }
                    merge_headers(
                        &mut entry.response_headers,
                        parse_headers_obj(resp.get("headers")),
                    );
                }
            }
            "Network.responseReceivedExtraInfo" => {
                if let Some(entry) = self.entries.get_mut(req_id) {
                    if let Some(sc) = params.get("statusCode").and_then(Value::as_u64) {
                        entry.status = Some(sc as u16);
                    }
                    merge_headers(
                        &mut entry.response_headers,
                        parse_headers_obj(params.get("headers")),
                    );
                }
            }
            "Network.loadingFinished" => {
                if let Some(entry) = self.entries.get_mut(req_id) {
                    entry.finished = true;
                    entry.encoded_data_length = params
                        .get("encodedDataLength")
                        .and_then(Value::as_f64)
                        .map(|n| n.max(0.0) as u64);
                }
            }
            "Network.loadingFailed" => {
                if let Some(entry) = self.entries.get_mut(req_id) {
                    entry.finished = true;
                    entry.failed_error = params
                        .get("errorText")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| Some("request failed".to_string()));
                }
            }
            _ => {}
        }
    }

    #[must_use]
    pub fn get(&self, request_id: &str) -> Option<&NetworkEntry> {
        self.entries.get(request_id)
    }

    /// Returns entries in chronological order matching `filter`.
    #[must_use]
    pub fn query(&self, filter: &NetworkFilter) -> Vec<NetworkEntry> {
        let needle = filter
            .url_contains
            .as_deref()
            .map(str::to_ascii_lowercase);
        let rtype = filter
            .resource_type
            .as_deref()
            .map(str::to_ascii_lowercase);
        let mut matched: Vec<NetworkEntry> = self
            .order
            .iter()
            .filter_map(|id| self.entries.get(id))
            .filter(|e| {
                if let Some(ref n) = needle {
                    if !e.url.to_ascii_lowercase().contains(n) {
                        return false;
                    }
                }
                if let Some(ref rt) = rtype {
                    if !e.resource_type.eq_ignore_ascii_case(rt) {
                        return false;
                    }
                }
                if let Some(st) = filter.status {
                    if e.status != Some(st) {
                        return false;
                    }
                }
                !(filter.failed_only
                    && e.failed_error.is_none()
                    && e.status.is_none_or(|s| s < 400))
            })
            .cloned()
            .collect();
        if let Some(lim) = filter.limit {
            if matched.len() > lim {
                let start = matched.len() - lim;
                matched = matched.split_off(start);
            }
        }
        matched
    }

    /// Builds a clean [`ReplayRequestSpec`] from a captured `request_id` for authorized download
    /// replay, stripping hop-by-hop/pseudo/range headers and falling back to `fallback_cookie_header`
    /// (typically from `Network.getCookies`) when `ExtraInfo` had no `Cookie` header.
    pub fn replay_spec(
        &self,
        request_id: &str,
        fallback_cookie_header: Option<&str>,
    ) -> Result<ReplayRequestSpec, String> {
        let entry = self
            .entries
            .get(request_id)
            .ok_or_else(|| format!("network request `{request_id}` not found in ring"))?;
        let mut headers = Vec::new();
        let mut cookies: Option<String> = None;
        let mut referer: Option<String> = None;
        let mut user_agent: Option<String> = None;

        for (k, v) in &entry.request_headers {
            let low = k.trim().to_ascii_lowercase();
            if is_non_replayable_header(&low) {
                continue;
            }
            match low.as_str() {
                "cookie" => cookies = Some(v.clone()),
                "referer" => referer = Some(v.clone()),
                "user-agent" => user_agent = Some(v.clone()),
                _ => headers.push((k.clone(), v.clone())),
            }
        }

        if cookies.is_none() {
            if let Some(fb) = fallback_cookie_header.map(str::trim).filter(|s| !s.is_empty()) {
                cookies = Some(fb.to_string());
            }
        }

        Ok(ReplayRequestSpec {
            url: entry.url.clone(),
            method: entry.method.clone(),
            headers,
            cookies,
            referer,
            user_agent,
        })
    }
}

fn parse_headers_obj(val: Option<&Value>) -> Vec<(String, String)> {
    let Some(obj) = val.and_then(Value::as_object) else {
        return Vec::new();
    };
    obj.iter()
        .filter_map(|(k, v)| {
            let s = match v {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                _ => return None,
            };
            Some((k.clone(), s))
        })
        .collect()
}

fn merge_headers(dst: &mut Vec<(String, String)>, incoming: Vec<(String, String)>) {
    for (k, v) in incoming {
        if let Some(slot) = dst.iter_mut().find(|(ek, _)| ek.eq_ignore_ascii_case(&k)) {
            slot.1 = v;
        } else {
            dst.push((k, v));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_url_strips_userinfo_query_and_fragment() {
        let raw = "https://dummy_user:dummy_pass@cdn.example.test/media/clip.mp4?token=fake_sig_123&expires=999#frag";
        assert_eq!(redact_url(raw), "https://cdn.example.test/media/clip.mp4");
        assert_eq!(
            redact_url("http://127.0.0.1:8787/api/health?foo=bar"),
            "http://127.0.0.1:8787/api/health"
        );
    }

    #[test]
    fn network_ring_merges_extra_info_archives_redirects_and_redacts_json() {
        let mut ring = NetworkRing::new(4);
        ring.ingest_cdp_event(
            "Network.requestWillBeSent",
            &json!({
                "requestId": "req-1",
                "type": "Media",
                "request": {
                    "url": "https://cdn.example.test/start?sig=dummy_sig_a",
                    "method": "GET",
                    "headers": {
                        "User-Agent": "OmniaFixture/1.0",
                        "Referer": "https://app.example.test/watch?k=dummy_ref_tok",
                        "Range": "bytes=0-1023",
                        "Host": "cdn.example.test",
                        ":authority": "cdn.example.test",
                        "X-Custom-Mode": "hd"
                    }
                }
            }),
        );
        ring.ingest_cdp_event(
            "Network.requestWillBeSentExtraInfo",
            &json!({
                "requestId": "req-1",
                "headers": {
                    "Cookie": "sid=dummy_cookie_value",
                    "Authorization": "Bearer dummy_bearer_token"
                }
            }),
        );
        // Simulate 302 redirect archiving req-1 -> req-1#r1
        ring.ingest_cdp_event(
            "Network.requestWillBeSent",
            &json!({
                "requestId": "req-1",
                "type": "Media",
                "redirectResponse": {
                    "status": 302,
                    "statusText": "Found",
                    "headers": { "Location": "https://edge.example.test/final.mp4" }
                },
                "request": {
                    "url": "https://edge.example.test/final.mp4?token=dummy_edge_tok",
                    "method": "GET",
                    "headers": {
                        "User-Agent": "OmniaFixture/1.0",
                        "Accept": "*/*",
                        "Connection": "keep-alive",
                        "Range": "bytes=0-99"
                    }
                }
            }),
        );
        ring.ingest_cdp_event(
            "Network.responseReceived",
            &json!({
                "requestId": "req-1",
                "type": "Media",
                "response": {
                    "status": 200,
                    "statusText": "OK",
                    "mimeType": "video/mp4",
                    "headers": { "Set-Cookie": "edge=dummy_edge_cookie" }
                }
            }),
        );
        ring.ingest_cdp_event(
            "Network.loadingFinished",
            &json!({ "requestId": "req-1", "encodedDataLength": 1048576.0 }),
        );

        assert_eq!(ring.len(), 2);
        assert_eq!(ring.query(&NetworkFilter::default()).len(), 2);
        let hop = ring.get("req-1#r1").expect("archived redirect hop");
        assert_eq!(hop.status, Some(302));
        assert!(hop.finished);

        // Redacted JSON must NEVER leak cookies, bearer tokens, or query signatures.
        let hop_json = hop.to_redacted_json().to_string();
        assert!(!hop_json.contains("dummy_cookie_value"));
        assert!(!hop_json.contains("dummy_bearer_token"));
        assert!(!hop_json.contains("dummy_sig_a"));
        assert!(!hop_json.contains("dummy_ref_tok"));
        assert!(hop_json.contains("[REDACTED]"));

        // Replay spec strips hop-by-hop/pseudo/range headers and uses fallback cookie when absent.
        let spec = ring
            .replay_spec("req-1", Some("fallback=dummy_fallback_cookie"))
            .expect("replay spec");
        assert_eq!(
            spec.url,
            "https://edge.example.test/final.mp4?token=dummy_edge_tok"
        );
        assert_eq!(spec.cookies.as_deref(), Some("fallback=dummy_fallback_cookie"));
        assert_eq!(spec.user_agent.as_deref(), Some("OmniaFixture/1.0"));
        assert!(spec
            .headers
            .iter()
            .all(|(k, _)| !k.eq_ignore_ascii_case("range")
                && !k.eq_ignore_ascii_case("connection")
                && !k.starts_with(':')));

        let spec_json = spec.to_redacted_json().to_string();
        assert!(!spec_json.contains("dummy_fallback_cookie"));
        assert!(!spec_json.contains("dummy_edge_tok"));
        assert_eq!(spec.to_redacted_json()["has_cookies"], json!(true));
    }

    #[test]
    fn network_ring_enforces_capacity_eviction() {
        let mut ring = NetworkRing::new(3);
        for i in 0..5 {
            ring.ingest_cdp_event(
                "Network.requestWillBeSent",
                &json!({
                    "requestId": format!("r{i}"),
                    "request": { "url": format!("https://example.test/{i}"), "method": "GET" }
                }),
            );
        }
        assert_eq!(ring.len(), 3);
        assert!(ring.get("r0").is_none());
        assert!(ring.get("r1").is_none());
        assert!(ring.get("r4").is_some());
    }

    #[test]
    fn dialog_policy_and_console_ring_behave_deterministically() {
        assert!(DialogPolicy::Auto.decide("alert").0);
        assert!(DialogPolicy::Auto.decide("beforeunload").0);
        assert!(!DialogPolicy::Auto.decide("confirm").0);
        assert!(DialogPolicy::AcceptAll.decide("prompt").0);
        assert!(!DialogPolicy::DismissAll.decide("alert").0);

        let mut console = ConsoleRing::new(2);
        console.ingest_cdp_event(
            "Runtime.consoleAPICalled",
            &json!({
                "type": "warning",
                "args": [{ "value": "hello" }, { "value": 42 }],
                "stackTrace": { "callFrames": [{ "url": "https://example.test/app.js?tok=dummy_console_tok", "lineNumber": 9 }] }
            }),
        );
        console.ingest_cdp_event(
            "Runtime.exceptionThrown",
            &json!({
                "exceptionDetails": {
                    "text": "Uncaught",
                    "url": "https://example.test/app.js?tok=dummy_console_tok",
                    "lineNumber": 12,
                    "exception": { "description": "TypeError: boom" }
                }
            }),
        );
        let items = console.entries();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].text, "hello 42");
        assert_eq!(items[0].source.as_deref(), Some("https://example.test/app.js"));
        assert_eq!(items[0].line, Some(10));
        assert_eq!(items[1].level, "error");
        assert_eq!(items[1].text, "TypeError: boom");
    }
}
