//! Streamable HTTP transport: every JSON-RPC message is a POST; the response
//! is either one JSON document or an SSE stream carrying the response.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::rpc::{
    cancelled_params, classify, is_tools_changed, reply_to_request, Incoming, Transport,
};
use super::{McpError, McpResult};
use crate::provider::sse::sse_events;

const SESSION_HEADER: &str = "mcp-session-id";
const PROTOCOL_HEADER: &str = "mcp-protocol-version";

pub(crate) struct HttpTransport {
    client: reqwest::Client,
    url: String,
    headers: HeaderMap,
    session_id: Mutex<Option<String>>,
    protocol_version: Mutex<Option<String>>,
    next_id: AtomicU64,
    tools_changed: Arc<AtomicBool>,
}

impl HttpTransport {
    pub(crate) fn new(
        url: &str,
        headers: &BTreeMap<String, String>,
        tools_changed: Arc<AtomicBool>,
    ) -> McpResult<Self> {
        let mut map = HeaderMap::new();
        for (k, v) in headers {
            let name = HeaderName::from_bytes(k.as_bytes())
                .map_err(|e| McpError::Transport(format!("bad header name `{k}`: {e}")))?;
            let mut value = HeaderValue::from_str(v)
                .map_err(|e| McpError::Transport(format!("bad header value for `{k}`: {e}")))?;
            value.set_sensitive(true);
            map.insert(name, value);
        }
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| McpError::Transport(e.to_string()))?;
        Ok(Self {
            client,
            url: url.to_string(),
            headers: map,
            session_id: Mutex::new(None),
            protocol_version: Mutex::new(None),
            next_id: AtomicU64::new(1),
            tools_changed,
        })
    }

    fn builder(&self) -> reqwest::RequestBuilder {
        let mut rb = self
            .client
            .post(&self.url)
            .headers(self.headers.clone())
            .header(ACCEPT, "application/json, text/event-stream")
            .header(CONTENT_TYPE, "application/json");
        if let Some(sid) = self.session_id.lock().unwrap().as_ref() {
            rb = rb.header(SESSION_HEADER, sid);
        }
        if let Some(v) = self.protocol_version.lock().unwrap().as_ref() {
            rb = rb.header(PROTOCOL_HEADER, v);
        }
        rb
    }

    fn capture_session(&self, resp: &reqwest::Response) {
        if let Some(sid) = resp
            .headers()
            .get(SESSION_HEADER)
            .and_then(|v| v.to_str().ok())
        {
            *self.session_id.lock().unwrap() = Some(sid.to_string());
        }
    }

    async fn post(&self, msg: &Value) -> McpResult<reqwest::Response> {
        let body = serde_json::to_vec(msg).map_err(|e| McpError::Protocol(e.to_string()))?;
        let resp = self
            .builder()
            .body(body)
            .send()
            .await
            .map_err(|e| McpError::Transport(format!("http request failed: {e}")))?;
        self.capture_session(&resp);
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let snippet: String = text.chars().take(500).collect();
            return Err(McpError::Transport(format!("http {status}: {snippet}")));
        }
        Ok(resp)
    }

    /// Handle one incoming message; returns the outcome if it answers `id`.
    async fn handle(&self, msg: &Value, id: u64) -> Option<McpResult<Value>> {
        match classify(msg)? {
            Incoming::Response {
                id: Some(rid),
                outcome,
            } if rid == id => Some(outcome),
            Incoming::Request { id: rid, method } => {
                let _ = self.post(&reply_to_request(rid, &method)).await;
                None
            }
            Incoming::Notification { method } => {
                if is_tools_changed(&method) {
                    self.tools_changed.store(true, Ordering::SeqCst);
                }
                None
            }
            _ => None,
        }
    }

    async fn do_request(&self, id: u64, msg: Value) -> McpResult<Value> {
        let resp = self.post(&msg).await?;
        let is_sse = resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("text/event-stream"));
        if is_sse {
            // Share the bounded, pull-driven provider parser. Do not expand an
            // entire network chunk into an unbounded event batch.
            let mut stream = Box::pin(sse_events(resp));
            while let Some(event) = stream.next().await {
                let event = event.map_err(|error| McpError::Transport(error.to_string()))?;
                if let Some(outcome) = self.handle_event(&event.data, id).await {
                    return outcome;
                }
            }
            return Err(McpError::Closed);
        }
        let text = resp
            .text()
            .await
            .map_err(|e| McpError::Transport(format!("read body failed: {e}")))?;
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| McpError::Protocol(format!("invalid JSON response: {e}")))?;
        let items = match value {
            Value::Array(items) => items,
            other => vec![other],
        };
        for item in &items {
            if let Some(outcome) = self.handle(item, id).await {
                return outcome;
            }
        }
        Err(McpError::Protocol(
            "response did not contain a reply".into(),
        ))
    }

    async fn handle_event(&self, data: &str, id: u64) -> Option<McpResult<Value>> {
        let msg: Value = serde_json::from_str(data).ok()?;
        match msg {
            Value::Array(items) => {
                for item in &items {
                    if let Some(outcome) = self.handle(item, id).await {
                        return Some(outcome);
                    }
                }
                None
            }
            other => self.handle(&other, id).await,
        }
    }
}

#[async_trait]
impl Transport for HttpTransport {
    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: Option<&CancellationToken>,
    ) -> McpResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let cancelled = async {
            match cancel {
                Some(token) => token.cancelled().await,
                None => std::future::pending().await,
            }
        };
        let failure = tokio::select! {
            r = self.do_request(id, msg) => return r,
            _ = tokio::time::sleep(timeout) => McpError::Timeout(timeout),
            _ = cancelled => McpError::Cancelled,
        };
        let reason = match failure {
            McpError::Timeout(_) => "timeout",
            _ => "cancelled by client",
        };
        // Cancellation acknowledgement is best effort. A stalled server must
        // not turn an already cancelled/timed-out request into an infinite wait.
        let _ = tokio::time::timeout(
            Duration::from_millis(250),
            self.notify("notifications/cancelled", cancelled_params(id, reason)),
        )
        .await;
        Err(failure)
    }

    async fn notify(&self, method: &str, params: Value) -> McpResult<()> {
        let msg = json!({"jsonrpc": "2.0", "method": method, "params": params});
        self.post(&msg).await.map(|_| ())
    }

    fn set_protocol_version(&self, version: &str) {
        *self.protocol_version.lock().unwrap() = Some(version.to_string());
    }

    async fn shutdown(&self) {
        let sid = self.session_id.lock().unwrap().take();
        if let Some(sid) = sid {
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                self.client
                    .delete(&self.url)
                    .headers(self.headers.clone())
                    .header(SESSION_HEADER, sid)
                    .send(),
            )
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::client::{McpClient, McpOptions};
    use crate::mcp::config::McpServerConfig;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    type Seen = Arc<Mutex<Vec<(Value, Option<String>, Option<String>)>>>;

    async fn read_request(sock: &mut tokio::net::TcpStream) -> (String, Value) {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = sock.read(&mut chunk).await.unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..pos]).to_string();
                let len = head
                    .lines()
                    .find_map(|l| {
                        let l = l.to_ascii_lowercase();
                        l.strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                while buf.len() < pos + 4 + len {
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                let body =
                    serde_json::from_slice(&buf[pos + 4..pos + 4 + len]).unwrap_or(Value::Null);
                return (head, body);
            }
        }
        (String::new(), Value::Null)
    }

    fn header(head: &str, name: &str) -> Option<String> {
        head.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case(name).then(|| v.trim().to_string())
        })
    }

    async fn serve(listener: TcpListener, seen: Seen) {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let (head, body) = read_request(&mut sock).await;
            seen.lock().unwrap().push((
                body.clone(),
                header(&head, "mcp-session-id"),
                header(&head, "x-test"),
            ));
            let id = body["id"].clone();
            let resp = match body["method"].as_str() {
                Some("initialize") => {
                    let b = json!({"jsonrpc":"2.0","id":id,"result":{
                        "protocolVersion":"2025-03-26","serverInfo":{"name":"h"}}})
                    .to_string();
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nmcp-session-id: sess-1\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{b}",
                        b.len()
                    )
                }
                Some("tools/list") => {
                    // SSE: a notification first, then a server ping, then the response.
                    let events = format!(
                        "data: {}\n\ndata: {}\n\nevent: message\ndata: {}\n\n",
                        json!({"jsonrpc":"2.0","method":"notifications/tools/list_changed"}),
                        json!({"jsonrpc":"2.0","id":"s1","method":"ping"}),
                        json!({"jsonrpc":"2.0","id":id,"result":{"tools":[{"name":"t1"}]}}),
                    );
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{events}"
                    )
                }
                Some("tools/call") => {
                    let b = json!({"jsonrpc":"2.0","id":id,"result":{
                        "content":[{"type":"text","text":"http-ok"}]}})
                    .to_string();
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{b}",
                        b.len()
                    )
                }
                _ => {
                    "HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".into()
                }
            };
            sock.write_all(resp.as_bytes()).await.unwrap();
            let _ = sock.shutdown().await;
        }
    }

    #[tokio::test]
    async fn json_and_sse_responses() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Seen = Arc::default();
        let server = tokio::spawn(serve(listener, seen.clone()));

        let mut config = McpServerConfig::http(format!("http://{addr}/mcp"));
        if let crate::mcp::McpTransportConfig::Http { headers, .. } = &mut config.transport {
            headers.insert("X-Test".into(), "yes".into());
        }
        let client = McpClient::connect(&config, McpOptions::default())
            .await
            .unwrap();
        assert_eq!(client.protocol_version(), "2025-03-26");
        let tools = client.list_tools().await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "t1");
        let res = client.call_tool("t1", json!({}), None).await.unwrap();
        assert_eq!(res["content"][0]["text"], "http-ok");

        let seen_now = seen.lock().unwrap().clone();
        // initialize has no session; later requests echo it and custom headers.
        assert_eq!(seen_now[0].1, None);
        assert!(seen_now
            .iter()
            .skip(1)
            .all(|s| s.1.as_deref() == Some("sess-1")));
        assert!(seen_now.iter().all(|s| s.2.as_deref() == Some("yes")));
        // The server ping inside the SSE stream was answered via POST.
        assert!(seen_now
            .iter()
            .any(|s| s.0["id"] == "s1" && s.0["result"] == json!({})));
        assert!(client.tools_changed() || tools.len() == 1);
        client.shutdown().await;
        server.abort();
    }

    #[tokio::test]
    async fn http_error_status_is_reported() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let _ = read_request(&mut sock).await;
            sock.write_all(
                b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 2\r\nconnection: close\r\n\r\nno",
            )
            .await
            .unwrap();
        });
        let config = McpServerConfig::http(format!("http://{addr}/mcp"));
        let err = McpClient::connect(&config, McpOptions::default())
            .await
            .err()
            .expect("must fail");
        assert!(err.to_string().contains("401"));
        server.abort();
    }

    #[tokio::test]
    async fn oversized_sse_line_fails_through_real_http_without_echoing_payload() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let _ = read_request(&mut sock).await;
            sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\ndata: sk-private-fixture-")
                .await.unwrap();
            let body = vec![b'x'; 256 * 1024];
            let _ = sock.write_all(&body).await;
            let _ = sock.shutdown().await;
        });
        let transport = HttpTransport::new(
            &format!("http://{addr}/mcp"),
            &BTreeMap::new(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let error = tokio::time::timeout(
            Duration::from_secs(5),
            transport.do_request(1, json!({"jsonrpc":"2.0","id":1,"method":"probe"})),
        )
        .await
        .expect("bounded test duration")
        .unwrap_err();
        assert!(matches!(error, McpError::Transport(_)));
        let message = error.to_string();
        assert!(message.to_ascii_lowercase().contains("limit"), "{message}");
        assert!(!message.contains("sk-private-fixture"));
        server.abort();
    }

    #[tokio::test]
    async fn cancelling_partial_sse_drops_request_and_sends_notification() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (ready, accepted) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut streaming, _) = listener.accept().await.unwrap();
            let _ = read_request(&mut streaming).await;
            streaming.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\ndata: partial")
                .await.unwrap();
            let _ = ready.send(());
            // Cancellation uses a second POST while the first response is open.
            let (mut notification, _) = listener.accept().await.unwrap();
            let (_, body) = read_request(&mut notification).await;
            assert_eq!(body["method"], "notifications/cancelled");
            notification
                .write_all(
                    b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            let _ = notification.shutdown().await;
            let mut byte = [0u8; 1];
            let closed = streaming.read(&mut byte).await;
            assert!(
                matches!(closed, Ok(0) | Err(_)),
                "stream connection was retained"
            );
        });
        let transport = HttpTransport::new(
            &format!("http://{addr}/mcp"),
            &BTreeMap::new(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let cancel = CancellationToken::new();
        let request_cancel = cancel.clone();
        let request = tokio::spawn(async move {
            transport
                .request(
                    "probe",
                    json!({}),
                    Duration::from_secs(10),
                    Some(&request_cancel),
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), accepted)
            .await
            .unwrap()
            .unwrap();
        cancel.cancel();
        let error = tokio::time::timeout(Duration::from_secs(5), request)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(matches!(error, McpError::Cancelled));
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn stalled_cancel_notification_cannot_block_cancelled_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (ready, accepted) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut streaming, _) = listener.accept().await.unwrap();
            let _ = read_request(&mut streaming).await;
            streaming.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\ndata: partial")
                .await.unwrap();
            ready.send(()).unwrap();
            let (mut notification, _) = listener.accept().await.unwrap();
            let (_, body) = read_request(&mut notification).await;
            assert_eq!(body["method"], "notifications/cancelled");
            // Deliberately never reply. Client must release this connection.
            let mut byte = [0u8; 1];
            assert!(matches!(notification.read(&mut byte).await, Ok(0) | Err(_)));
        });
        let transport = HttpTransport::new(
            &format!("http://{addr}/mcp"),
            &BTreeMap::new(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        let request = tokio::spawn(async move {
            transport
                .request("probe", json!({}), Duration::from_secs(10), Some(&cancel))
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), accepted)
            .await
            .unwrap()
            .unwrap();
        trigger.cancel();
        let error = tokio::time::timeout(Duration::from_secs(2), request)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(matches!(error, McpError::Cancelled));
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }
}
