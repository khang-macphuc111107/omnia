//! Steer #27B Native Computer Use HTTP Bridge Routes (`/api/v5/computer/*`).
//!
//! Exposes all 21 pure-Rust Windows UIA / PrintWindow / WinRT OCR / SendInput
//! tools from `omnia-computer` under `ComputerPolicy::unrestricted_default()`
//! (Steer #22 YOLO default while unconditionally preserving OS/UAC/own-process
//! safety boundaries, PID-reuse guards, and global `KillSwitch`).

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use omnia_computer::safety::{hard_blocked_apps, ComputerPolicy};
use omnia_computer::tools::{ComputerTools, ContentBlock, ToolContext, ToolEffect};
use omnia_computer::{ComputerConfig, ComputerError};
use omnia_core::{now_epoch_ms, SecretRedactor};
use omnia_harness::artifact_os::validate_no_proto_pollution;
use serde_json::{json, Value};

use crate::http::{HttpRequest, HttpResponse};
use crate::routes_legacy::StudioState;

const DEFAULT_DISPATCH_TIMEOUT_MS: u64 = 15_000;
const MIN_DISPATCH_TIMEOUT_MS: u64 = 100;
const MAX_DISPATCH_TIMEOUT_MS: u64 = 30_000;

static SHARED_COMPUTER_TOOLS: OnceLock<Arc<ComputerTools>> = OnceLock::new();

fn shared_tools() -> &'static Arc<ComputerTools> {
    SHARED_COMPUTER_TOOLS.get_or_init(|| Arc::new(ComputerTools::new(ComputerConfig::default())))
}

/// Returns `true` when `path` belongs to the Steer #27B `/api/v5/computer/*` surface.
#[must_use]
pub fn is_known_route(path: &str) -> bool {
    matches!(
        path,
        "/api/v5/computer/status"
            | "/api/v5/computer/dispatch"
            | "/api/v5/computer/kill"
            | "/api/v5/computer/reset"
    )
}

/// Builds the status & 21-tool inventory JSON payload for `GET /api/v5/computer/status`
/// and `/api/v5/super/capabilities`.
#[must_use]
pub fn computer_status_summary() -> Value {
    build_status_payload(shared_tools())
}

fn build_status_payload(tools: &ComputerTools) -> Value {
    let specs = tools.specs();
    let policy = tools.computer().safety().policy();
    let kill_triggered = tools.computer().kill_switch().is_triggered();
    let unrestricted = policy == ComputerPolicy::unrestricted_default();
    let foreground_count = specs
        .iter()
        .filter(|s| !s.name.starts_with("computer_window_"))
        .count();
    let background_count = specs.len().saturating_sub(foreground_count);

    let approval_str = if unrestricted { "yolo" } else { "custom" };
    json!({
        "ok": true,
        "state": "online",
        "available": cfg!(windows),
        "platformSupported": cfg!(windows),
        "approvalMode": approval_str,
        "policy": approval_str,
        "unrestrictedDefault": unrestricted,
        "killSwitchTriggered": kill_triggered,
        "killSwitchEngaged": kill_triggered,
        "killSwitch": {
            "triggered": kill_triggered,
        },
        "dpiAware": cfg!(windows),
        "uiaReady": cfg!(windows),
        "ocrReady": cfg!(windows),
        "dpiUiaReady": cfg!(windows),
        "readiness": {
            "dpiAware": "per-monitor-v2",
            "uiaReady": cfg!(windows),
            "ocrEngine": if cfg!(windows) { "Windows.Media.Ocr" } else { "unsupported" },
            "backgroundWindowControl": cfg!(windows),
        },
        "policyConfig": {
            "approvalMode": approval_str,
            "unrestrictedDefault": unrestricted,
            "allowedApps": policy.allowed_apps,
            "blockedApps": policy.blocked_apps,
            "hardBlockedApps": hard_blocked_apps(),
            "maxActionsPerMinute": policy.max_actions_per_minute,
            "requireProcessCreateTime": policy.require_process_create_time,
        },
        "toolCount": specs.len(),
        "foregroundCount": foreground_count,
        "backgroundCount": background_count,
        "tools": specs,
    })
}

/// Dispatches `/api/v5/computer/*` routes cleanly.
pub async fn dispatch(state: &Arc<StudioState>, req: &HttpRequest) -> Option<HttpResponse> {
    if !is_known_route(req.path.as_str()) {
        return None;
    }

    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/v5/computer/status") => {
            Some(HttpResponse::ok(build_status_payload(shared_tools())))
        }
        ("POST", "/api/v5/computer/dispatch") => {
            Some(dispatch_with_tools(state, shared_tools(), req).await)
        }
        ("POST", "/api/v5/computer/kill") => Some(handle_kill(state, shared_tools())),
        ("POST", "/api/v5/computer/reset") => Some(handle_reset(state, shared_tools())),
        _ => Some(HttpResponse::error(
            405,
            "method_not_allowed",
            "HTTP method not allowed for v5 computer route.",
        )),
    }
}

fn handle_kill(state: &Arc<StudioState>, tools: &ComputerTools) -> HttpResponse {
    tools.computer().kill_switch().trigger();
    state.event_feed.publish(
        "computer",
        "kill_switch_triggered",
        None,
        json!({ "killSwitchTriggered": true, "timestampMs": now_epoch_ms() }),
    );
    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "killSwitchTriggered": true,
    }))
}

fn handle_reset(state: &Arc<StudioState>, tools: &ComputerTools) -> HttpResponse {
    tools.computer().kill_switch().reset();
    state.event_feed.publish(
        "computer",
        "kill_switch_reset",
        None,
        json!({ "killSwitchTriggered": false, "timestampMs": now_epoch_ms() }),
    );
    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "killSwitchTriggered": false,
    }))
}

async fn dispatch_with_tools(
    state: &Arc<StudioState>,
    tools: &ComputerTools,
    req: &HttpRequest,
) -> HttpResponse {
    let obj = if req.body.is_empty() {
        serde_json::Map::new()
    } else {
        match req.json_object() {
            Ok(m) => m,
            Err(resp) => return resp,
        }
    };

    if let Err(err) = validate_no_proto_pollution(&Value::Object(obj.clone())) {
        return HttpResponse::error(400, "invalid_computer_payload", &err);
    }

    let tool_name = ["tool", "name", "toolName", "tool_name"]
        .iter()
        .find_map(|k| {
            obj.get(*k)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        });
    let Some(tool_name) = tool_name else {
        return HttpResponse::error(
            400,
            "missing_tool",
            "Field 'tool' (or 'name') is required for computer dispatch.",
        );
    };

    let Some(spec) = tools.spec(tool_name) else {
        return HttpResponse::error(
            400,
            "unknown_computer_tool",
            &format!(
                "Unknown computer tool `{}`.",
                SecretRedactor::redact(tool_name)
            ),
        );
    };

    let arguments = match obj
        .get("arguments")
        .or_else(|| obj.get("args"))
        .or_else(|| obj.get("input"))
        .or_else(|| obj.get("params"))
    {
        None | Some(Value::Null) => Value::Object(serde_json::Map::new()),
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(_) => {
            return HttpResponse::error(
                400,
                "invalid_arguments",
                "Field 'arguments' must be a JSON object when provided.",
            );
        }
    };

    let timeout_ms = obj
        .get("timeoutMs")
        .or_else(|| obj.get("timeout_ms"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_DISPATCH_TIMEOUT_MS)
        .clamp(MIN_DISPATCH_TIMEOUT_MS, MAX_DISPATCH_TIMEOUT_MS);

    if tools.computer().kill_switch().is_triggered() {
        return HttpResponse::error(
            423,
            "kill_switch_engaged",
            "Computer-use kill switch is engaged; reset kill switch before dispatching.",
        );
    }

    let ctx = ToolContext::default();
    let call_res = tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        tools.call(&spec.name, &ctx, arguments),
    )
    .await;

    match call_res {
        Err(_) => HttpResponse::error(
            408,
            "computer_dispatch_timeout",
            &format!(
                "Computer tool `{}` timed out after {timeout_ms} ms.",
                spec.name
            ),
        ),
        Ok(Err(ComputerError::Killed)) => HttpResponse::error(
            423,
            "kill_switch_engaged",
            "Computer-use kill switch is engaged; reset kill switch before dispatching.",
        ),
        Ok(Err(ComputerError::Cancelled)) => HttpResponse::error(
            408,
            "computer_dispatch_cancelled",
            "Computer tool execution was cancelled.",
        ),
        Ok(Err(err)) => HttpResponse::error(
            400,
            "computer_dispatch_failed",
            &SecretRedactor::redact(&err.to_string()),
        ),
        Ok(Ok(output)) => {
            let mut text_parts = Vec::new();
            let mut safe_blocks = Vec::with_capacity(output.content.len());
            for block in output.content {
                match block {
                    ContentBlock::Text { text } => {
                        let safe = SecretRedactor::redact(&text);
                        if !safe.is_empty() {
                            text_parts.push(safe.clone());
                        }
                        safe_blocks.push(json!({
                            "type": "text",
                            "text": safe,
                        }));
                    }
                    ContentBlock::Image { media_type, data } => {
                        safe_blocks.push(json!({
                            "type": "image",
                            "media_type": media_type,
                            "data": data,
                        }));
                    }
                }
            }

            let text_summary = text_parts.join("\n");
            let effect_str = match spec.effect {
                ToolEffect::ReadOnly => "read_only",
                ToolEffect::ComputerControl => "computer_control",
            };

            state.event_feed.publish(
                "computer",
                "tool_dispatched",
                Some(&spec.name),
                json!({
                    "tool": spec.name,
                    "effect": effect_str,
                    "isError": output.is_error,
                    "timestampMs": now_epoch_ms(),
                }),
            );

            HttpResponse::ok(json!({
                "ok": !output.is_error,
                "state": "online",
                "tool": spec.name,
                "effect": effect_str,
                "isError": output.is_error,
                "textSummary": text_summary,
                "content": safe_blocks,
                "approvalMode": "yolo",
                "unrestrictedDefault": tools.computer().safety().policy() == ComputerPolicy::unrestricted_default(),
                "killSwitchTriggered": tools.computer().kill_switch().is_triggered(),
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::StudioConfig;
    use std::collections::BTreeMap;

    fn make_req(method: &str, path: &str, body: Value) -> HttpRequest {
        HttpRequest {
            method: method.to_string(),
            target: path.to_string(),
            path: path.to_string(),
            query: String::new(),
            headers: BTreeMap::new(),
            cookie_header_count: 0,
            body: if method == "GET" {
                Vec::new()
            } else {
                serde_json::to_vec(&body).unwrap_or_default()
            },
        }
    }

    fn make_test_state() -> Arc<StudioState> {
        let mut cfg = StudioConfig::default();
        let tmp = std::env::temp_dir().join(format!(
            "omnia-studio-computer-test-{}",
            omnia_core::uuid_v4_simple()
        ));
        let ws = tmp.join("ws");
        let rb = tmp.join("rb");
        let _ = std::fs::create_dir_all(&ws);
        let _ = std::fs::create_dir_all(&rb);
        cfg.workspace_root = ws;
        cfg.rollback_root = rb;
        cfg.db_path = None;
        cfg.runtime_url = None;
        Arc::new(StudioState::new(cfg).expect("build test StudioState"))
    }

    #[tokio::test]
    async fn computer_status_lists_all_21_tools_with_yolo_default() {
        let state = make_test_state();
        let req = make_req("GET", "/api/v5/computer/status", Value::Null);
        let resp = dispatch(&state, &req).await.expect("route matched");
        assert_eq!(resp.status, 200);
        let payload: Value = serde_json::from_slice(&resp.body).unwrap();
        assert_eq!(payload["ok"], true);
        assert_eq!(payload["approvalMode"], "yolo");
        assert_eq!(payload["unrestrictedDefault"], true);
        assert_eq!(payload["killSwitchTriggered"], false);
        assert_eq!(payload["toolCount"], 21);
        assert_eq!(payload["foregroundCount"], 14);
        assert_eq!(payload["backgroundCount"], 7);
        assert_eq!(payload["tools"].as_array().unwrap().len(), 21);
    }

    #[tokio::test]
    async fn computer_routes_enforce_405_on_wrong_method() {
        let state = make_test_state();
        let bad_status = dispatch(
            &state,
            &make_req("POST", "/api/v5/computer/status", json!({})),
        )
        .await
        .expect("matched");
        assert_eq!(bad_status.status, 405);

        let bad_dispatch = dispatch(
            &state,
            &make_req("GET", "/api/v5/computer/dispatch", Value::Null),
        )
        .await
        .expect("matched");
        assert_eq!(bad_dispatch.status, 405);
    }

    #[tokio::test]
    async fn computer_dispatch_validates_inputs_and_respects_kill_switch() {
        let state = make_test_state();
        let tools = ComputerTools::new(ComputerConfig::default());

        let missing = dispatch_with_tools(
            &state,
            &tools,
            &make_req("POST", "/api/v5/computer/dispatch", json!({})),
        )
        .await;
        assert_eq!(missing.status, 400);

        let unknown = dispatch_with_tools(
            &state,
            &tools,
            &make_req(
                "POST",
                "/api/v5/computer/dispatch",
                json!({ "tool": "computer_nonexistent" }),
            ),
        )
        .await;
        assert_eq!(unknown.status, 400);

        let proto = dispatch_with_tools(
            &state,
            &tools,
            &make_req(
                "POST",
                "/api/v5/computer/dispatch",
                json!({ "tool": "computer_windows", "__proto__": { "polluted": true } }),
            ),
        )
        .await;
        assert_eq!(proto.status, 400);

        tools.computer().kill_switch().trigger();
        let killed = dispatch_with_tools(
            &state,
            &tools,
            &make_req(
                "POST",
                "/api/v5/computer/dispatch",
                json!({ "tool": "computer_windows", "arguments": {} }),
            ),
        )
        .await;
        assert_eq!(killed.status, 423);

        tools.computer().kill_switch().reset();
        assert!(!tools.computer().kill_switch().is_triggered());
    }
}
