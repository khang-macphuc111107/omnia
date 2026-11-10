//! Chrome DevTools Protocol client: JSON-RPC over a single WebSocket.
//!
//! One reader task dispatches responses to pending callers and fans events out
//! on a `broadcast` channel. When the socket dies every pending call fails with
//! [`BrowserError::Closed`] and [`CdpClient::closed`] resolves.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::error::{BrowserError, Result};

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const EVENT_CAPACITY: usize = 8192;
const MAX_MESSAGE: usize = 256 * 1024 * 1024;

/// A protocol event (a message without an `id`).
#[derive(Debug, Clone)]
pub struct CdpEvent {
    pub method: String,
    pub params: Value,
    pub session_id: Option<String>,
}

type PendingMap = HashMap<u64, oneshot::Sender<Result<Value>>>;

struct Inner {
    out: mpsc::UnboundedSender<Message>,
    pending: Mutex<PendingMap>,
    next_id: AtomicU64,
    events: broadcast::Sender<CdpEvent>,
    closed: CancellationToken,
    timeout_ms: AtomicU64,
}

/// Removes local response bookkeeping even when the caller drops its future.
/// A command already sent to Chrome may still execute and reply afterwards.
struct PendingCall<'a> {
    inner: &'a Inner,
    id: u64,
}

impl Drop for PendingCall<'_> {
    fn drop(&mut self) {
        self.inner.lock_pending().remove(&self.id);
    }
}

impl Inner {
    fn lock_pending(&self) -> std::sync::MutexGuard<'_, PendingMap> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Marks the connection dead and fails every in-flight call.
    fn shutdown(&self) {
        self.closed.cancel();
        let drained: Vec<_> = self.lock_pending().drain().collect();
        for (_, tx) in drained {
            let _ = tx.send(Err(BrowserError::Closed));
        }
    }

    fn dispatch(&self, text: &str) {
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            return;
        };
        if let Some(id) = value.get("id").and_then(Value::as_u64) {
            let tx = self.lock_pending().remove(&id);
            if let Some(tx) = tx {
                let result = match value.get("error") {
                    Some(error) => {
                        let message = error.get("message").and_then(Value::as_str).unwrap_or("");
                        Err(BrowserError::Cdp {
                            code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                            message: match error.get("data").and_then(Value::as_str) {
                                Some(data) => format!("{message} ({data})"),
                                None => message.to_string(),
                            },
                        })
                    }
                    None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(result);
            }
        } else if let Some(method) = value.get("method").and_then(Value::as_str) {
            let _ = self.events.send(CdpEvent {
                method: method.to_string(),
                params: value.get("params").cloned().unwrap_or(Value::Null),
                session_id: value
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.closed.cancel();
    }
}

/// Cheaply cloneable handle to one CDP connection.
#[derive(Clone)]
pub struct CdpClient {
    inner: Arc<Inner>,
}

impl CdpClient {
    /// Connects to a `ws://` DevTools endpoint.
    pub async fn connect(ws_url: &str) -> Result<Self> {
        let ws_url = crate::safety::local_endpoint(ws_url, true)?.to_string();
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        let (stream, _) =
            tokio_tungstenite::connect_async_with_config(&ws_url, Some(config), false)
                .await
                .map_err(|e| BrowserError::Ws(e.to_string()))?;
        let (mut sink, mut source) = stream.split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let inner = Arc::new(Inner {
            out,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            events,
            closed: CancellationToken::new(),
            timeout_ms: AtomicU64::new(DEFAULT_TIMEOUT.as_millis() as u64),
        });

        let weak: Weak<Inner> = Arc::downgrade(&inner);
        let closed = inner.closed.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = closed.cancelled() => break,
                    msg = out_rx.recv() => match msg {
                        Some(msg) => {
                            if sink.send(msg).await.is_err() { break; }
                        }
                        None => break,
                    }
                }
            }
            let _ = sink.close().await;
            if let Some(inner) = weak.upgrade() {
                inner.shutdown();
            }
        });

        let weak = Arc::downgrade(&inner);
        let closed = inner.closed.clone();
        tokio::spawn(async move {
            loop {
                let next = tokio::select! {
                    _ = closed.cancelled() => break,
                    next = source.next() => next,
                };
                match next {
                    Some(Ok(Message::Text(text))) => match weak.upgrade() {
                        Some(inner) => inner.dispatch(text.as_str()),
                        None => break,
                    },
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                }
            }
            if let Some(inner) = weak.upgrade() {
                inner.shutdown();
            }
        });

        Ok(Self { inner })
    }

    pub fn set_default_timeout(&self, timeout: Duration) {
        self.inner
            .timeout_ms
            .store(timeout.as_millis() as u64, Ordering::Relaxed);
    }

    pub fn default_timeout(&self) -> Duration {
        Duration::from_millis(self.inner.timeout_ms.load(Ordering::Relaxed))
    }

    /// Sends a command with the default timeout.
    pub async fn send(
        &self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<Value> {
        self.send_with_timeout(method, params, session_id, self.default_timeout())
            .await
    }

    pub async fn send_with_timeout(
        &self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
        timeout: Duration,
    ) -> Result<Value> {
        let inner = &self.inner;
        if inner.closed.is_cancelled() {
            return Err(BrowserError::Closed);
        }
        let id = inner.next_id.fetch_add(1, Ordering::Relaxed);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session_id {
            message["sessionId"] = Value::String(session.to_string());
        }
        let (tx, rx) = oneshot::channel();
        inner.lock_pending().insert(id, tx);
        let _pending = PendingCall { inner, id };
        if inner.closed.is_cancelled() {
            return Err(BrowserError::Closed);
        }
        if inner
            .out
            .send(Message::Text(message.to_string().into()))
            .is_err()
        {
            return Err(BrowserError::Closed);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(BrowserError::Closed),
            Err(_) => Err(BrowserError::Timeout(method.to_string())),
        }
    }

    /// Subscribes to all events (every session). Slow consumers see `Lagged`.
    pub fn subscribe(&self) -> broadcast::Receiver<CdpEvent> {
        self.inner.events.subscribe()
    }

    /// Resolves once the connection is gone.
    pub async fn closed(&self) {
        self.inner.closed.cancelled().await;
    }

    pub fn is_closed(&self) -> bool {
        self.inner.closed.is_cancelled()
    }

    /// Closes the socket and fails pending calls.
    pub fn close(&self) {
        self.inner.shutdown();
    }

    /// Number of calls waiting for a response (diagnostics/tests).
    pub fn pending_count(&self) -> usize {
        self.inner.lock_pending().len()
    }

    /// Waits on `rx` for the next event matching `pred`; errors on timeout or close.
    pub async fn wait_event(
        &self,
        mut rx: broadcast::Receiver<CdpEvent>,
        timeout: Duration,
        mut pred: impl FnMut(&CdpEvent) -> bool,
    ) -> Result<CdpEvent> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            tokio::select! {
                _ = self.inner.closed.cancelled() => return Err(BrowserError::Closed),
                r = tokio::time::timeout(remaining, rx.recv()) => match r {
                    Err(_) => return Err(BrowserError::Timeout("wait_event".into())),
                    Ok(Ok(event)) => if pred(&event) { return Ok(event); },
                    Ok(Err(broadcast::error::RecvError::Lagged(_))) => {}
                    Ok(Err(broadcast::error::RecvError::Closed)) => return Err(BrowserError::Closed),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    type Ws = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

    /// Accepts one connection and runs `handler` over it.
    async fn fake_server<F, Fut>(handler: F) -> String
    where
        F: FnOnce(Ws) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            handler(ws).await;
        });
        format!("ws://{addr}")
    }

    fn text(v: Value) -> Message {
        Message::Text(v.to_string().into())
    }

    async fn read_json(ws: &mut Ws) -> Option<Value> {
        loop {
            match ws.next().await? {
                Ok(Message::Text(t)) => return serde_json::from_str(t.as_str()).ok(),
                Ok(Message::Close(_)) | Err(_) => return None,
                _ => {}
            }
        }
    }

    #[tokio::test]
    async fn matches_out_of_order_responses_and_events() {
        let url = fake_server(|mut ws| async move {
            let a = read_json(&mut ws).await.unwrap();
            let b = read_json(&mut ws).await.unwrap();
            ws.send(text(
                json!({"method":"Page.loadEventFired","params":{"t":1},"sessionId":"S1"}),
            ))
            .await
            .unwrap();
            ws.send(text(
                json!({"id": b["id"], "result": {"echo": b["params"]["n"]}}),
            ))
            .await
            .unwrap();
            ws.send(text(
                json!({"id": a["id"], "result": {"echo": a["params"]["n"], "sid": a["sessionId"]}}),
            ))
            .await
            .unwrap();
            let _ = read_json(&mut ws).await;
        })
        .await;
        let client = CdpClient::connect(&url).await.unwrap();
        let mut events = client.subscribe();
        let (r1, r2) = tokio::join!(client.send("A.one", json!({"n": 1}), Some("S9")), async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            client.send("A.two", json!({"n": 2}), None).await
        });
        let r1 = r1.unwrap();
        assert_eq!(r1["echo"], 1);
        assert_eq!(r1["sid"], "S9");
        assert_eq!(r2.unwrap()["echo"], 2);
        let ev = events.recv().await.unwrap();
        assert_eq!(ev.method, "Page.loadEventFired");
        assert_eq!(ev.session_id.as_deref(), Some("S1"));
        assert_eq!(ev.params["t"], 1);
        assert_eq!(client.pending_count(), 0);
    }

    #[tokio::test]
    async fn maps_protocol_errors() {
        let url = fake_server(|mut ws| async move {
            let a = read_json(&mut ws).await.unwrap();
            ws.send(text(
                json!({"id": a["id"], "error": {"code": -32000, "message": "No node"}}),
            ))
            .await
            .unwrap();
            let _ = read_json(&mut ws).await;
        })
        .await;
        let client = CdpClient::connect(&url).await.unwrap();
        match client.send("DOM.x", json!({}), None).await {
            Err(BrowserError::Cdp { code, message }) => {
                assert_eq!(code, -32000);
                assert_eq!(message, "No node");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn times_out_and_cleans_pending() {
        let url =
            fake_server(|mut ws| async move { while read_json(&mut ws).await.is_some() {} }).await;
        let client = CdpClient::connect(&url).await.unwrap();
        let result = client
            .send_with_timeout("Slow.call", json!({}), None, Duration::from_millis(80))
            .await;
        assert!(matches!(result, Err(BrowserError::Timeout(m)) if m == "Slow.call"));
        assert_eq!(client.pending_count(), 0);
    }

    #[tokio::test]
    async fn cancelled_request_removes_only_its_pending_entry() {
        let (requests_seen_tx, requests_seen_rx) = oneshot::channel();
        let (reply_tx, reply_rx) = oneshot::channel();
        let url = fake_server(move |mut ws| async move {
            let requests = [
                read_json(&mut ws).await.unwrap(),
                read_json(&mut ws).await.unwrap(),
            ];
            let _ = requests_seen_tx.send(());
            if reply_rx.await.is_err() {
                return;
            }
            // The abandoned request can still produce a late response. It
            // must not consume the other caller's response or close the socket.
            for request in requests {
                ws.send(text(
                    json!({"id": request["id"], "result": {"method": request["method"]}}),
                ))
                .await
                .unwrap();
            }
            let _ = read_json(&mut ws).await;
        })
        .await;
        let client = CdpClient::connect(&url).await.unwrap();
        let abandoned = {
            let client = client.clone();
            tokio::spawn(async move { client.send("Abandoned.call", json!({}), None).await })
        };
        let healthy = {
            let client = client.clone();
            tokio::spawn(async move { client.send("Healthy.call", json!({}), None).await })
        };
        tokio::time::timeout(Duration::from_secs(2), requests_seen_rx)
            .await
            .expect("requests reach the fake server")
            .unwrap();
        assert_eq!(client.pending_count(), 2);

        abandoned.abort();
        assert!(abandoned.await.unwrap_err().is_cancelled());
        assert_eq!(
            client.pending_count(),
            1,
            "an aborted call must release its pending entry"
        );

        reply_tx.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), healthy)
            .await
            .expect("the remaining request still completes")
            .unwrap()
            .unwrap();
        assert_eq!(result["method"], "Healthy.call");
        assert_eq!(client.pending_count(), 0);
        assert!(!client.is_closed());
        client.close();
    }

    #[tokio::test]
    async fn caller_timeout_cleans_pending_before_the_cdp_timeout() {
        let url =
            fake_server(|mut ws| async move { while read_json(&mut ws).await.is_some() {} }).await;
        let client = CdpClient::connect(&url).await.unwrap();
        let result = tokio::time::timeout(
            Duration::from_millis(50),
            client.send("Caller.timedOut", json!({}), None),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(
            client.pending_count(),
            0,
            "dropping a request must remove it immediately"
        );
        assert!(!client.is_closed());
        client.close();
    }

    #[tokio::test]
    async fn disconnect_fails_pending_and_resolves_closed() {
        let url = fake_server(|mut ws| async move {
            let _ = read_json(&mut ws).await;
            drop(ws);
        })
        .await;
        let client = CdpClient::connect(&url).await.unwrap();
        let result = client.send("Never.answered", json!({}), None).await;
        assert!(matches!(result, Err(BrowserError::Closed)), "{result:?}");
        tokio::time::timeout(Duration::from_secs(2), client.closed())
            .await
            .expect("closed() resolves");
        assert!(client.is_closed());
        assert!(matches!(
            client.send("After.close", json!({}), None).await,
            Err(BrowserError::Closed)
        ));
    }
}
