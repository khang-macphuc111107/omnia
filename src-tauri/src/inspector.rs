//! Local request inspector: in-memory, per-session ring buffers of the raw
//! (redacted) provider exchanges plus local counters. Nothing here is written
//! to disk or sent anywhere; logs vanish when the app exits.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use omnia_harness::provider::record::{Exchange, LogStats, RequestLog};
use serde::{Deserialize, Serialize};

use crate::error::{NativeError, NativeResult};

fn registry() -> &'static Mutex<HashMap<String, Arc<RequestLog>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<RequestLog>>>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

/// The session's log, created on first use.
pub(crate) fn log_for_session(session_id: &str) -> Arc<RequestLog> {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    Arc::clone(map.entry(session_id.to_owned()).or_default())
}

/// Drops a deleted session's log.
pub(crate) fn forget_session(session_id: &str) {
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(session_id);
}

fn existing_log(session_id: &str) -> Option<Arc<RequestLog>> {
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(session_id)
        .cloned()
}

fn require_session_id(value: &str) -> NativeResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 200 || value.chars().any(char::is_control) {
        return Err(NativeError::invalid("sessionId", "is invalid"));
    }
    Ok(value.to_owned())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectorSessionRequest {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectorGetRequest {
    pub session_id: String,
    pub id: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorSummary {
    pub id: u64,
    pub started_at_ms: u64,
    pub provider: String,
    pub model: String,
    pub status: Option<u16>,
    pub duration_ms: Option<u64>,
    pub request_bytes: usize,
    pub response_bytes: usize,
    pub error: Option<String>,
    pub complete: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorList {
    pub exchanges: Vec<InspectorSummary>,
    pub stats: LogStats,
}

fn summarize(exchange: &Exchange) -> InspectorSummary {
    InspectorSummary {
        id: exchange.id,
        started_at_ms: exchange.started_at_ms,
        provider: exchange.provider.clone(),
        model: exchange.model.clone(),
        status: exchange.status,
        duration_ms: exchange.duration_ms,
        request_bytes: exchange.request_bytes,
        response_bytes: exchange.response_bytes,
        error: exchange.error.clone(),
        complete: exchange.complete,
    }
}

fn list_for(log: Option<Arc<RequestLog>>) -> InspectorList {
    match log {
        Some(log) => InspectorList {
            // Newest first.
            exchanges: log.list().iter().rev().map(summarize).collect(),
            stats: log.stats(),
        },
        None => InspectorList {
            exchanges: Vec::new(),
            stats: LogStats::default(),
        },
    }
}

#[tauri::command]
pub async fn agent_inspector_list(request: InspectorSessionRequest) -> NativeResult<InspectorList> {
    let id = require_session_id(&request.session_id)?;
    Ok(list_for(existing_log(&id)))
}

#[tauri::command]
pub async fn agent_inspector_get(request: InspectorGetRequest) -> NativeResult<Exchange> {
    let id = require_session_id(&request.session_id)?;
    existing_log(&id)
        .and_then(|log| log.get(request.id))
        .ok_or_else(|| {
            NativeError::new(
                "inspector_exchange_missing",
                "That request is no longer in the log",
            )
        })
}

#[tauri::command]
pub async fn agent_inspector_clear(request: InspectorSessionRequest) -> NativeResult<()> {
    let id = require_session_id(&request.session_id)?;
    if let Some(log) = existing_log(&id) {
        log.clear();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lists_newest_first_and_clears() {
        let log = log_for_session("inspector-test-session");
        for i in 0..3 {
            let mut h = log.begin("anthropic", "m", "http://h?key=abc", &[], &json!({"i": i}));
            h.set_response(200, &[]);
            h.finish();
        }
        log.note_retry();
        let list = list_for(existing_log("inspector-test-session"));
        let ids: Vec<u64> = list.exchanges.iter().map(|e| e.id).collect();
        assert_eq!(ids, [3, 2, 1]);
        assert_eq!((list.stats.requests, list.stats.retries), (3, 1));
        log.clear();
        assert!(list_for(existing_log("inspector-test-session"))
            .exchanges
            .is_empty());
        assert!(list_for(existing_log("never-seen")).exchanges.is_empty());
    }
}
