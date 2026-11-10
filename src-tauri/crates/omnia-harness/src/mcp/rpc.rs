//! JSON-RPC message classification shared by both transports.

use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::{McpError, McpResult};

pub(crate) enum Incoming {
    Response {
        id: Option<u64>,
        outcome: McpResult<Value>,
    },
    /// Server -> client request; must be answered.
    Request {
        id: Value,
        method: String,
    },
    Notification {
        method: String,
    },
}

fn parse_id(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

pub(crate) fn classify(msg: &Value) -> Option<Incoming> {
    let obj = msg.as_object()?;
    if let Some(method) = obj.get("method").and_then(Value::as_str) {
        return Some(match obj.get("id") {
            Some(id) if !id.is_null() => Incoming::Request {
                id: id.clone(),
                method: method.to_string(),
            },
            _ => Incoming::Notification {
                method: method.to_string(),
            },
        });
    }
    let id = obj.get("id")?;
    if !obj.contains_key("result") && !obj.contains_key("error") {
        return None;
    }
    let outcome = match obj.get("error") {
        Some(error) if !error.is_null() => Err(McpError::Rpc {
            code: error.get("code").and_then(Value::as_i64).unwrap_or(-32000),
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string(),
        }),
        _ => Ok(obj.get("result").cloned().unwrap_or(Value::Null)),
    };
    Some(Incoming::Response {
        id: parse_id(id),
        outcome,
    })
}

/// Minimal answer to a server->client request: `ping` succeeds, everything
/// else is "method not found".
pub(crate) fn reply_to_request(id: Value, method: &str) -> Value {
    if method == "ping" {
        json!({"jsonrpc": "2.0", "id": id, "result": {}})
    } else {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": -32601, "message": format!("method not found: {method}")}
        })
    }
}

pub(crate) fn is_tools_changed(method: &str) -> bool {
    method == "notifications/tools/list_changed"
}

pub(crate) fn cancelled_params(id: u64, reason: &str) -> Value {
    json!({"requestId": id, "reason": reason})
}

#[async_trait]
pub(crate) trait Transport: Send + Sync {
    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: Option<&CancellationToken>,
    ) -> McpResult<Value>;
    async fn notify(&self, method: &str, params: Value) -> McpResult<()>;
    fn set_protocol_version(&self, _version: &str) {}
    /// Extra context for error messages (e.g. stderr tail).
    fn diagnostics(&self) -> Option<String> {
        None
    }
    async fn shutdown(&self);
}
