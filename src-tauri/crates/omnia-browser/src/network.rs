//! Network capture for the downloader: a bounded ring of requests assembled
//! from the `Network.*` event stream, plus replay-spec construction.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

use crate::cdp::CdpEvent;

pub const DEFAULT_CAPACITY: usize = 2000;

pub type Headers = Vec<(String, String)>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedRequest {
    pub request_id: String,
    pub url: String,
    pub method: String,
    pub resource_type: String,
    pub request_headers: Headers,
    pub status: Option<u16>,
    pub mime_type: Option<String>,
    pub response_headers: Headers,
    pub content_length: Option<u64>,
    pub from_cache: bool,
    /// Wall-clock seconds since the epoch when the request was issued.
    pub timestamp: f64,
    pub frame_url: Option<String>,
    pub tab_id: Option<String>,
    pub finished: bool,
    pub error: Option<String>,
}

/// Everything the downloader needs to re-fetch with the same auth context.
/// Mirrors the download crate's `RequestSpec`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpec {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub cookies: Option<String>,
    pub referer: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct NetworkFilter {
    /// Case-insensitive substring of the URL.
    pub url_contains: Option<String>,
    /// Case-insensitive resource type, e.g. `media`, `document`, `xhr`/`fetch`.
    pub resource_type: Option<String>,
    /// Case-insensitive substring of the MIME type.
    pub mime_contains: Option<String>,
    pub tab_id: Option<String>,
    /// Most recent N matches (chronological order).
    pub limit: Option<usize>,
}

struct Entry {
    req: CapturedRequest,
    session_id: Option<String>,
    extra_request: bool,
    extra_response: bool,
}

impl Entry {
    fn new(id: &str, session_id: Option<&str>, tab_id: Option<&str>) -> Self {
        Self {
            req: CapturedRequest {
                request_id: id.to_string(),
                tab_id: tab_id.map(str::to_string),
                ..Default::default()
            },
            session_id: session_id.map(str::to_string),
            extra_request: false,
            extra_response: false,
        }
    }
}

#[derive(Default)]
struct Ring {
    order: VecDeque<String>,
    map: HashMap<String, Entry>,
    redirects: u64,
}

pub struct NetworkStore {
    capacity: usize,
    ring: Mutex<Ring>,
    tx: broadcast::Sender<CapturedRequest>,
}

/// CDP header object to pairs; multi-valued headers (joined by `\n`) are split.
pub fn headers_from_json(value: &Value) -> Headers {
    let mut out = Vec::new();
    if let Some(map) = value.as_object() {
        for (name, v) in map {
            let text = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            for part in text.split('\n') {
                out.push((name.clone(), part.to_string()));
            }
        }
    }
    out
}

pub fn header<'a>(headers: &'a Headers, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

impl NetworkStore {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(512);
        Self {
            capacity: capacity.max(1),
            ring: Mutex::new(Ring::default()),
            tx,
        }
    }

    fn ring(&self) -> MutexGuard<'_, Ring> {
        self.ring.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Receives each request once its response headers arrive (or it fails).
    pub fn subscribe(&self) -> broadcast::Receiver<CapturedRequest> {
        self.tx.subscribe()
    }

    pub fn len(&self) -> usize {
        self.ring().map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&self) {
        let mut ring = self.ring();
        ring.order.clear();
        ring.map.clear();
    }

    pub fn get(&self, request_id: &str) -> Option<CapturedRequest> {
        self.ring().map.get(request_id).map(|e| e.req.clone())
    }

    /// CDP session that observed the request (needed for `getResponseBody`).
    pub fn session_of(&self, request_id: &str) -> Option<String> {
        self.ring()
            .map
            .get(request_id)
            .and_then(|e| e.session_id.clone())
    }

    pub fn list(&self, filter: &NetworkFilter) -> Vec<CapturedRequest> {
        let ring = self.ring();
        let url = filter.url_contains.as_ref().map(|s| s.to_lowercase());
        let kind = filter.resource_type.as_ref().map(|s| s.to_lowercase());
        let mime = filter.mime_contains.as_ref().map(|s| s.to_lowercase());
        let mut out: Vec<CapturedRequest> = ring
            .order
            .iter()
            .filter_map(|key| ring.map.get(key))
            .map(|e| &e.req)
            .filter(|r| {
                url.as_ref()
                    .is_none_or(|u| r.url.to_lowercase().contains(u))
            })
            .filter(|r| {
                kind.as_ref()
                    .is_none_or(|k| r.resource_type.to_lowercase() == *k)
            })
            .filter(|r| {
                mime.as_ref().is_none_or(|m| {
                    r.mime_type
                        .as_ref()
                        .is_some_and(|t| t.to_lowercase().contains(m))
                })
            })
            .filter(|r| {
                filter
                    .tab_id
                    .as_ref()
                    .is_none_or(|t| r.tab_id.as_deref() == Some(t))
            })
            .cloned()
            .collect();
        if let Some(limit) = filter.limit {
            if out.len() > limit {
                out.drain(..out.len() - limit);
            }
        }
        out
    }

    fn entry<'a>(
        &self,
        ring: &'a mut Ring,
        id: &str,
        session_id: Option<&str>,
        tab_id: Option<&str>,
    ) -> &'a mut Entry {
        if !ring.map.contains_key(id) {
            ring.map
                .insert(id.to_string(), Entry::new(id, session_id, tab_id));
            ring.order.push_back(id.to_string());
            while ring.order.len() > self.capacity {
                if let Some(old) = ring.order.pop_front() {
                    ring.map.remove(&old);
                }
            }
        }
        ring.map.get_mut(id).expect("entry just inserted")
    }

    /// Folds one CDP event into the ring. Non-network events are ignored.
    pub fn handle_event(&self, event: &CdpEvent, tab_id: Option<&str>) {
        if !event.method.starts_with("Network.") {
            return;
        }
        let p = &event.params;
        let Some(id) = p.get("requestId").and_then(Value::as_str) else {
            return;
        };
        let session = event.session_id.as_deref();
        let mut publish = None;
        {
            let mut ring = self.ring();
            match event.method.as_str() {
                "Network.requestWillBeSent" => {
                    if let Some(redirect) = p.get("redirectResponse").filter(|v| v.is_object()) {
                        // Same requestId continues after a redirect: archive the previous hop.
                        if let Some(mut previous) = ring.map.remove(id) {
                            apply_response(&mut previous, redirect);
                            previous.req.finished = true;
                            ring.redirects += 1;
                            let key = format!("{id}#r{}", ring.redirects);
                            previous.req.request_id = key.clone();
                            if let Some(slot) = ring.order.iter_mut().find(|k| k.as_str() == id) {
                                *slot = key.clone();
                            }
                            publish = Some(previous.req.clone());
                            ring.map.insert(key, previous);
                        }
                    }
                    let entry = self.entry(&mut ring, id, session, tab_id);
                    let request = &p["request"];
                    entry.req.url = request["url"].as_str().unwrap_or_default().to_string();
                    entry.req.method = request["method"].as_str().unwrap_or("GET").to_string();
                    entry.req.resource_type = p
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("Other")
                        .to_string();
                    entry.req.timestamp = p
                        .get("wallTime")
                        .and_then(Value::as_f64)
                        .or_else(|| p.get("timestamp").and_then(Value::as_f64))
                        .unwrap_or(0.0);
                    entry.req.frame_url = p
                        .get("documentURL")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    if entry.session_id.is_none() {
                        entry.session_id = session.map(str::to_string);
                    }
                    if entry.req.tab_id.is_none() {
                        entry.req.tab_id = tab_id.map(str::to_string);
                    }
                    if !entry.extra_request || entry.req.request_headers.is_empty() {
                        entry.req.request_headers = headers_from_json(&request["headers"]);
                    } else if entry.extra_request {
                        // Keep the real headers (with Cookie) from the extra-info event.
                    }
                    entry.req.status = None;
                    entry.req.finished = false;
                    entry.extra_response = false;
                }
                "Network.requestWillBeSentExtraInfo" => {
                    let entry = self.entry(&mut ring, id, session, tab_id);
                    entry.req.request_headers = headers_from_json(&p["headers"]);
                    entry.extra_request = true;
                }
                "Network.responseReceived" => {
                    let entry = self.entry(&mut ring, id, session, tab_id);
                    apply_response(entry, &p["response"]);
                    if entry.req.resource_type.is_empty() || entry.req.resource_type == "Other" {
                        if let Some(t) = p.get("type").and_then(Value::as_str) {
                            entry.req.resource_type = t.to_string();
                        }
                    }
                    publish = Some(entry.req.clone());
                }
                "Network.responseReceivedExtraInfo" => {
                    let entry = self.entry(&mut ring, id, session, tab_id);
                    entry.req.response_headers = headers_from_json(&p["headers"]);
                    entry.extra_response = true;
                    if entry.req.status.is_none() {
                        entry.req.status = p
                            .get("statusCode")
                            .and_then(Value::as_u64)
                            .map(|s| s as u16);
                    }
                    if entry.req.content_length.is_none() {
                        entry.req.content_length =
                            header(&entry.req.response_headers, "content-length")
                                .and_then(|v| v.trim().parse().ok());
                    }
                }
                "Network.requestServedFromCache" => {
                    self.entry(&mut ring, id, session, tab_id).req.from_cache = true;
                }
                "Network.loadingFinished" => {
                    let entry = self.entry(&mut ring, id, session, tab_id);
                    entry.req.finished = true;
                    if entry.req.content_length.is_none() {
                        entry.req.content_length = p
                            .get("encodedDataLength")
                            .and_then(Value::as_f64)
                            .filter(|n| *n > 0.0)
                            .map(|n| n as u64);
                    }
                }
                "Network.loadingFailed" => {
                    let entry = self.entry(&mut ring, id, session, tab_id);
                    entry.req.finished = true;
                    entry.req.error = Some(
                        p.get("errorText")
                            .and_then(Value::as_str)
                            .unwrap_or("failed")
                            .to_string(),
                    );
                    publish = Some(entry.req.clone());
                }
                _ => {}
            }
        }
        if let Some(req) = publish {
            let _ = self.tx.send(req);
        }
    }
}

fn apply_response(entry: &mut Entry, response: &Value) {
    entry.req.status = response
        .get("status")
        .and_then(Value::as_f64)
        .map(|s| s as u16);
    entry.req.mime_type = response
        .get("mimeType")
        .and_then(Value::as_str)
        .map(str::to_string);
    if !entry.extra_response {
        entry.req.response_headers = headers_from_json(&response["headers"]);
    }
    entry.req.from_cache = entry.req.from_cache
        || response["fromDiskCache"].as_bool().unwrap_or(false)
        || response["fromPrefetchCache"].as_bool().unwrap_or(false);
    entry.req.content_length = header(&entry.req.response_headers, "content-length")
        .and_then(|v| v.trim().parse().ok())
        .or(entry.req.content_length);
}

/// Headers the downloader must not (or need not) replay verbatim.
fn skip_replay_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with(':')
        || matches!(
            lower.as_str(),
            "host"
                | "connection"
                | "content-length"
                | "accept-encoding"
                | "range"
                | "if-range"
                | "if-none-match"
                | "if-modified-since"
                | "cookie"
                | "referer"
                | "user-agent"
                | "origin"
        )
}

/// Assembles the replay spec for a captured request. `api_cookies` (from
/// `Network.getCookies`) is only used when the request headers carry no Cookie.
pub fn build_replay_spec(
    request: &CapturedRequest,
    api_cookies: Option<&[(String, String)]>,
) -> RequestSpec {
    let cookies = header(&request.request_headers, "cookie")
        .map(str::to_string)
        .filter(|c| !c.trim().is_empty())
        .or_else(|| {
            api_cookies.filter(|c| !c.is_empty()).map(|c| {
                c.iter()
                    .map(|(n, v)| format!("{n}={v}"))
                    .collect::<Vec<_>>()
                    .join("; ")
            })
        });
    RequestSpec {
        url: request.url.clone(),
        method: if request.method.is_empty() {
            "GET".into()
        } else {
            request.method.clone()
        },
        headers: request
            .request_headers
            .iter()
            .filter(|(n, _)| !skip_replay_header(n))
            .cloned()
            .collect(),
        cookies,
        referer: header(&request.request_headers, "referer")
            .map(str::to_string)
            .or_else(|| request.frame_url.clone()),
        user_agent: header(&request.request_headers, "user-agent").map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(method: &str, params: Value) -> CdpEvent {
        CdpEvent {
            method: method.into(),
            params,
            session_id: Some("S1".into()),
        }
    }

    #[test]
    fn merges_events_into_one_request() {
        let store = NetworkStore::new(10);
        let mut rx = store.subscribe();
        // Extra info may arrive before requestWillBeSent.
        store.handle_event(
            &ev(
                "Network.requestWillBeSentExtraInfo",
                json!({"requestId": "1.1", "headers": {"Cookie": "sid=abc", "Referer": "https://site/page", "User-Agent": "UA/1"}}),
            ),
            Some("T1"),
        );
        store.handle_event(
            &ev(
                "Network.requestWillBeSent",
                json!({"requestId": "1.1", "type": "Media", "wallTime": 1700000000.5, "documentURL": "https://site/page",
                       "request": {"url": "https://cdn/v.mp4", "method": "GET", "headers": {"Accept": "*/*"}}}),
            ),
            Some("T1"),
        );
        store.handle_event(
            &ev(
                "Network.responseReceived",
                json!({"requestId": "1.1", "type": "Media", "response": {"url": "https://cdn/v.mp4", "status": 200,
                       "mimeType": "video/mp4", "headers": {"Content-Length": "1234", "Set-Cookie": "a=1\nb=2"}}}),
            ),
            Some("T1"),
        );
        store.handle_event(
            &ev(
                "Network.loadingFinished",
                json!({"requestId": "1.1", "encodedDataLength": 999.0}),
            ),
            Some("T1"),
        );
        let req = store.get("1.1").unwrap();
        assert_eq!(req.url, "https://cdn/v.mp4");
        assert_eq!(req.resource_type, "Media");
        assert_eq!(header(&req.request_headers, "cookie"), Some("sid=abc"));
        assert_eq!(req.status, Some(200));
        assert_eq!(req.mime_type.as_deref(), Some("video/mp4"));
        assert_eq!(req.content_length, Some(1234));
        assert_eq!(req.tab_id.as_deref(), Some("T1"));
        assert!(req.finished);
        assert_eq!(
            req.response_headers
                .iter()
                .filter(|(n, _)| n == "Set-Cookie")
                .count(),
            2
        );
        assert_eq!(store.session_of("1.1").as_deref(), Some("S1"));
        let published = rx.try_recv().unwrap();
        assert_eq!(published.status, Some(200));
    }

    #[test]
    fn redirects_are_archived_under_new_keys() {
        let store = NetworkStore::new(10);
        store.handle_event(
            &ev("Network.requestWillBeSent", json!({"requestId": "2.1", "request": {"url": "http://a/", "method": "GET", "headers": {}}})),
            None,
        );
        store.handle_event(
            &ev("Network.requestWillBeSent", json!({"requestId": "2.1",
                "redirectResponse": {"status": 302, "mimeType": "text/html", "headers": {"Location": "http://b/"}},
                "request": {"url": "http://b/", "method": "GET", "headers": {}}})),
            None,
        );
        assert_eq!(store.len(), 2);
        let all = store.list(&NetworkFilter::default());
        assert_eq!(all[0].url, "http://a/");
        assert_eq!(all[0].status, Some(302));
        assert_eq!(all[1].url, "http://b/");
        assert_eq!(all[1].request_id, "2.1");
    }

    #[test]
    fn ring_is_bounded_and_filterable() {
        let store = NetworkStore::new(3);
        for i in 0..5 {
            store.handle_event(
                &ev("Network.requestWillBeSent", json!({"requestId": format!("r{i}"), "type": if i % 2 == 0 {"XHR"} else {"Media"},
                    "request": {"url": format!("https://x/{i}"), "method": "GET", "headers": {}}})),
                None,
            );
        }
        assert_eq!(store.len(), 3);
        assert!(store.get("r0").is_none());
        let media = store.list(&NetworkFilter {
            resource_type: Some("media".into()),
            ..Default::default()
        });
        assert_eq!(media.len(), 1);
        assert_eq!(media[0].url, "https://x/3");
        let last = store.list(&NetworkFilter {
            limit: Some(1),
            ..Default::default()
        });
        assert_eq!(last[0].request_id, "r4");
    }

    #[test]
    fn failed_requests_record_error() {
        let store = NetworkStore::new(3);
        store.handle_event(
            &ev("Network.requestWillBeSent", json!({"requestId": "f", "request": {"url": "https://x", "method": "GET", "headers": {}}})),
            None,
        );
        store.handle_event(
            &ev(
                "Network.loadingFailed",
                json!({"requestId": "f", "errorText": "net::ERR_ABORTED"}),
            ),
            None,
        );
        assert_eq!(
            store.get("f").unwrap().error.as_deref(),
            Some("net::ERR_ABORTED")
        );
    }

    fn sample(headers: Headers) -> CapturedRequest {
        CapturedRequest {
            request_id: "x".into(),
            url: "https://cdn/file.zip".into(),
            method: "GET".into(),
            request_headers: headers,
            frame_url: Some("https://site/page".into()),
            ..Default::default()
        }
    }

    #[test]
    fn replay_spec_uses_header_cookie_and_strips_noise() {
        let req = sample(vec![
            ("Cookie".into(), "sid=abc".into()),
            ("Referer".into(), "https://site/ref".into()),
            ("User-Agent".into(), "UA/1".into()),
            ("Accept".into(), "*/*".into()),
            ("Accept-Encoding".into(), "gzip".into()),
            ("Range".into(), "bytes=0-".into()),
            (":authority".into(), "cdn".into()),
            ("X-Token".into(), "t".into()),
        ]);
        let spec = build_replay_spec(&req, Some(&[("other".into(), "1".into())]));
        assert_eq!(spec.cookies.as_deref(), Some("sid=abc"));
        assert_eq!(spec.referer.as_deref(), Some("https://site/ref"));
        assert_eq!(spec.user_agent.as_deref(), Some("UA/1"));
        assert_eq!(
            spec.headers,
            vec![
                ("Accept".into(), "*/*".into()),
                ("X-Token".into(), "t".into())
            ]
        );
        let json = serde_json::to_value(&spec).unwrap();
        assert!(json.get("userAgent").is_some());
    }

    #[test]
    fn replay_spec_falls_back_to_api_cookies_and_frame_referer() {
        let req = sample(vec![("Accept".into(), "*/*".into())]);
        let spec = build_replay_spec(
            &req,
            Some(&[("a".into(), "1".into()), ("b".into(), "2".into())]),
        );
        assert_eq!(spec.cookies.as_deref(), Some("a=1; b=2"));
        assert_eq!(spec.referer.as_deref(), Some("https://site/page"));
        assert_eq!(build_replay_spec(&req, None).cookies, None);
    }
}
