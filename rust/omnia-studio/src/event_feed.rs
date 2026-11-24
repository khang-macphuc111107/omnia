//! Single-encode AG-UI SSE `EventFeed` (OpenCode `event-feed.ts` pattern) with bounded replay
//! ring buffer (`Last-Event-ID`), non-blocking fan-out, and multiplexed `/ws` broadcast.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use omnia_core::{now_epoch_ms, SecretRedactor};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

const MAX_REPLAY_EVENTS: usize = 512;
const SUBSCRIBER_QUEUE_CAP: usize = 256;
const WS_BROADCAST_CAP: usize = 1024;

/// Structured event published through [`EventFeed`] to both AG-UI SSE and `/ws`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedEvent {
    pub seq: u64,
    pub channel: String,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub payload: Value,
    pub timestamp_ms: i64,
    #[serde(skip)]
    pub encoded_sse: Arc<Vec<u8>>,
}

/// OpenCode-style single-encode event fan-out bus supporting SSE replay & `/ws` broadcast.
#[derive(Debug)]
pub struct EventFeed {
    next_seq: AtomicU64,
    replay: Mutex<VecDeque<FeedEvent>>,
    sse_subscribers: Mutex<Vec<mpsc::Sender<Vec<u8>>>>,
    ws_tx: broadcast::Sender<FeedEvent>,
}

impl Default for EventFeed {
    fn default() -> Self {
        Self::new()
    }
}

impl EventFeed {
    #[must_use]
    pub fn new() -> Self {
        let (ws_tx, _) = broadcast::channel(WS_BROADCAST_CAP);
        Self {
            next_seq: AtomicU64::new(1),
            replay: Mutex::new(VecDeque::with_capacity(MAX_REPLAY_EVENTS)),
            sse_subscribers: Mutex::new(Vec::new()),
            ws_tx,
        }
    }

    /// Current head sequence number (`0` before first event).
    #[must_use]
    pub fn head_seq(&self) -> u64 {
        self.next_seq.load(Ordering::Relaxed).saturating_sub(1)
    }

    /// Encodes `payload` ONCE (secret-redacted), pushes into replay buffer, and fans out
    /// cleanly to bounded SSE & WebSocket subscribers without blocking the producer.
    pub fn publish(
        &self,
        channel: &str,
        event_type: &str,
        session_id: Option<&str>,
        payload: Value,
    ) -> u64 {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let redacted_payload = SecretRedactor::redact_json(&payload);
        let ts = now_epoch_ms();
        let envelope = json!({
            "seq": seq,
            "channel": channel,
            "event": event_type,
            "sessionId": session_id,
            "payload": redacted_payload,
            "timestampMs": ts,
        });
        let data_line = serde_json::to_string(&envelope).unwrap_or_else(|_| "{}".to_string());
        let sse_text = format!("id: {seq}\nevent: {event_type}\ndata: {data_line}\n\n");
        let encoded_sse = Arc::new(sse_text.into_bytes());

        let feed_ev = FeedEvent {
            seq,
            channel: channel.to_string(),
            event: event_type.to_string(),
            session_id: session_id.map(ToString::to_string),
            payload: redacted_payload,
            timestamp_ms: ts,
            encoded_sse: Arc::clone(&encoded_sse),
        };

        if let Ok(mut replay) = self.replay.lock() {
            if replay.len() >= MAX_REPLAY_EVENTS {
                replay.pop_front();
            }
            replay.push_back(feed_ev.clone());
        }

        if let Ok(mut subs) = self.sse_subscribers.lock() {
            subs.retain(|tx| match tx.try_send((*encoded_sse).clone()) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(_)) => true,
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            });
        }

        let _ = self.ws_tx.send(feed_ev);
        seq
    }

    /// Subscribes an SSE client, replaying buffered events with `seq > since_seq` upfront.
    #[must_use]
    pub fn subscribe_sse(&self, since_seq: Option<u64>) -> mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = mpsc::channel(SUBSCRIBER_QUEUE_CAP);
        if let Some(after) = since_seq {
            if let Ok(replay) = self.replay.lock() {
                for ev in replay.iter() {
                    if ev.seq > after {
                        let _ = tx.try_send((*ev.encoded_sse).clone());
                    }
                }
            }
        }
        if let Ok(mut subs) = self.sse_subscribers.lock() {
            subs.push(tx);
        }
        rx
    }

    /// Subscribes a multiplexed `/ws` connection to all emitted events.
    #[must_use]
    pub fn subscribe_ws(&self) -> broadcast::Receiver<FeedEvent> {
        self.ws_tx.subscribe()
    }

    /// Returns bounded recent events (`seq > since_seq`) for initial hydration.
    #[must_use]
    pub fn recent(&self, since_seq: u64, limit: usize) -> Vec<Value> {
        let max_items = limit.clamp(1, MAX_REPLAY_EVENTS);
        let Ok(replay) = self.replay.lock() else {
            return Vec::new();
        };
        replay
            .iter()
            .filter(|ev| ev.seq > since_seq)
            .rev()
            .take(max_items)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|ev| {
                json!({
                    "seq": ev.seq,
                    "channel": ev.channel,
                    "event": ev.event,
                    "sessionId": ev.session_id,
                    "payload": ev.payload,
                    "timestampMs": ev.timestamp_ms,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_feed_single_encode_fans_out_and_replays_by_seq() {
        let feed = EventFeed::new();
        let mut sse1 = feed.subscribe_sse(None);
        let mut ws_rx = feed.subscribe_ws();

        let s1 = feed.publish("agent", "token_delta", Some("sess-1"), json!({ "text": "hello" }));
        let s2 = feed.publish("agent", "turn_end", Some("sess-1"), json!({ "turn": 1 }));
        assert_eq!(s1, 1);
        assert_eq!(s2, 2);

        let chunk1 = String::from_utf8(sse1.try_recv().expect("sse chunk 1")).unwrap();
        assert!(chunk1.contains("id: 1\nevent: token_delta\n"));
        assert!(chunk1.contains("\"hello\""));
        let ws1 = ws_rx.try_recv().expect("ws ev 1");
        assert_eq!(ws1.seq, 1);

        // Late subscriber asking for replay since seq 1 receives only seq 2
        let mut sse2 = feed.subscribe_sse(Some(1));
        let replayed = String::from_utf8(sse2.try_recv().expect("replayed seq 2")).unwrap();
        assert!(replayed.contains("id: 2\nevent: turn_end\n"));
        assert!(sse2.try_recv().is_err());
    }
}
