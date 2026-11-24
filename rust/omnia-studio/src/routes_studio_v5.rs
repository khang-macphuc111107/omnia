//! Omnia Studio v5 unified HTTP/SSE routes (`#![deny(unsafe_code)]`):
//! - Single-encode AG-UI SSE `EventFeed` (`/api/events`, `/api/events/recent`)
//! - Unified `SuperHarnessManager` chat/agent orchestration (`/api/chat/*`, `/api/agent/*`, `/api/sessions/{delete,rename,fork,rewind,compact}`)
//! - Multimodal attachments (`SessionStore` SHA-256 blobs) & Chat-surface `Quote + BTW`
//! - Dual-Scope `Main`/`Subagent` model+effort roles & Windows Credential Manager (`/api/models/config`, `/api/credentials*`)
//! - IDE Workspace (`files/*`, `workspace/write`, `git/*`, `ide/lsp`, ConPTY `/api/terminal/*` & `/api/pty/*`)
//! - Isolated Browser CDP (`/api/browser/*`, `/api/media/browser/*`) — live Thorium strictly blocked
//! - Extensions & Knowledge & Telemetry (`/api/mcp/*`, `/api/hooks*`, `/api/recipes*`, `/api/plugins/cordis*`, `/api/dap/*`, `/api/memory/*`, `/api/kb/*`, `/api/pastes/*`, `/api/kanban/*`, `/api/inbox`, `/api/routines`, `/api/stats/*`, `/api/traces`, `/api/benchmarks/scoreboard`, `/api/management/*`).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use omnia_agent::dynamic_plugins::{DynamicPluginManifest, DynamicPluginToolDef};
use omnia_agent::git_forensics::run_git;
use omnia_agent::hooks::{HookEvent, HookSpec};
use omnia_agent::memory_engine::{RecallQuery, RetainItemInput};
use omnia_agent::path_guard::ensure_within_workspace;
use omnia_agent::recipes::{discover_recipes, validate_and_render_recipe};
use omnia_agent::{
    read_models_config, ApprovalMode, HarnessBackendId, ManagedSpawnRequest, WireApiMode,
};
use omnia_core::credentials::CredentialStore;
use omnia_core::{base64_decode, base64_encode, now_epoch_ms, sha256_hex, uuid_v4, SecretRedactor};
use omnia_graph::AgentRole;
use omnia_harness::{MemoryKind, MemoryProvenance, MemoryScope, MemoryTier, SteerMode};
use omnia_media_capture::browser_ws::{
    is_forbidden_live_browser_path, launch_isolated_browser, CdpSession, IsolatedBrowserHandle,
    IsolatedBrowserLaunchOptions,
};
use omnia_routing::model_roles::{EffortLevel, ModelRole};
use omnia_routing::{
    CandidateResourceState, CircuitState, ModelCapabilities, PrivacyTier, QuotaState,
    RouteCandidate,
};
use omnia_storage::AttachmentPlacement;
use omnia_workspace_ops::fs_ops::{read_text_file, write_atomic, LineEndingPolicy, WriteOptions};
use serde_json::{json, Value};

use crate::http::{HttpRequest, HttpResponse};
use crate::mgmt_proxy::{build_benchmark_scoreboard, handle_management_route};
use crate::ops_store::{OpsStore, UsageTraceInput};
use crate::routes_legacy::StudioState;
use crate::telemetry::is_reparse_or_symlink;

const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_WORKSPACE_TREE_ENTRIES: usize = 600;
const SSE_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

/// Holds the active isolated Playwright/CDP browser handle & session (never touching live Thorium).
#[derive(Default)]
pub struct BrowserCdpState {
    pub handle: Option<IsolatedBrowserHandle>,
    pub session: Option<Arc<CdpSession>>,
    pub last_url: Option<String>,
    pub ws_url: Option<String>,
}

/// Returns `true` when `path` belongs to the Studio v5 route surface (used for `405` dispatch).
#[must_use]
pub fn is_known_v5_route(path: &str) -> bool {
    if path == "/api/management" || path.starts_with("/api/management/") {
        return true;
    }
    matches!(
        path,
        "/api/events"
            | "/api/events/recent"
            | "/api/chat/stream"
            | "/api/chat/stop"
            | "/api/chat/steer"
            | "/api/chat/queue"
            | "/api/agent/spawn"
            | "/api/agent/prompt"
            | "/api/agent/confirm"
            | "/api/agent/abort"
            | "/api/agent/mode"
            | "/api/agent/sessions"
            | "/api/agent/backends"
            | "/api/agent/cache"
            | "/api/sessions/delete"
            | "/api/sessions/rename"
            | "/api/sessions/fork"
            | "/api/sessions/rewind"
            | "/api/sessions/compact"
            | "/api/sessions/btw/create"
            | "/api/sessions/btw/append"
            | "/api/sessions/btw/list"
            | "/api/graph/peers"
            | "/api/router/candidates"
            | "/api/attachments/upload"
            | "/api/attachments/get"
            | "/api/models/config"
            | "/api/credentials"
            | "/api/credentials/delete"
            | "/api/files/tree"
            | "/api/files/read"
            | "/api/files/write"
            | "/api/workspace/write"
            | "/api/git/status"
            | "/api/git/diff"
            | "/api/ide/lsp"
            | "/api/terminal/create"
            | "/api/terminal/list"
            | "/api/terminal/resize"
            | "/api/terminal/input"
            | "/api/terminal/kill"
            | "/api/terminal/scrollback"
            | "/api/pty/create"
            | "/api/pty/list"
            | "/api/pty/resize"
            | "/api/pty/input"
            | "/api/pty/kill"
            | "/api/pty/scrollback"
            | "/api/browser/launch"
            | "/api/browser/status"
            | "/api/browser/navigate"
            | "/api/browser/click"
            | "/api/browser/type"
            | "/api/browser/screenshot"
            | "/api/browser/snapshot"
            | "/api/browser/close"
            | "/api/media/browser/launch"
            | "/api/media/browser/status"
            | "/api/media/browser/navigate"
            | "/api/media/browser/click"
            | "/api/media/browser/type"
            | "/api/media/browser/screenshot"
            | "/api/media/browser/snapshot"
            | "/api/media/browser/close"
            | "/api/mcp/servers"
            | "/api/mcp/servers/disconnect"
            | "/api/mcp/tools/search"
            | "/api/mcp/tools/call"
            | "/api/mcp/tasks"
            | "/api/hooks"
            | "/api/hooks/toggle"
            | "/api/recipes"
            | "/api/recipes/render"
            | "/api/plugins/cordis"
            | "/api/plugins/cordis/toggle"
            | "/api/plugins/cordis/rollback"
            | "/api/dap/sessions"
            | "/api/dap/launch"
            | "/api/dap/terminate"
            | "/api/memory/retain"
            | "/api/memory/recall"
            | "/api/memory/reflect"
            | "/api/kb/notes"
            | "/api/kb/search"
            | "/api/pastes"
            | "/api/pastes/get"
            | "/api/kanban/tasks"
            | "/api/kanban/status"
            | "/api/inbox"
            | "/api/routines"
            | "/api/stats/overview"
            | "/api/stats/spotlight"
            | "/api/traces"
            | "/api/benchmarks/scoreboard"
    )
}

/// Dispatches Studio v5 HTTP routes cleanly; returns `None` if route belongs to legacy/notebooks/downloads.
pub async fn dispatch_v5_route(state: &Arc<StudioState>, req: &HttpRequest) -> Option<HttpResponse> {
    if req.path == "/api/management" || req.path.starts_with("/api/management/") {
        return Some(handle_management_route(req).await);
    }

    if let Some(resp) = crate::routes_atelier_drive_v5::dispatch(state, req).await {
        return Some(resp);
    }

    match (req.method.as_str(), req.path.as_str()) {
        // 1. AG-UI EventFeed (SSE + hydration)
        ("GET", "/api/events") => Some(handle_events_sse(state, req)),
        ("GET", "/api/events/recent") => Some(handle_events_recent(state, req)),

        // 2. Unified Agent / Chat / Steering / Modes / Sessions / Multimodal
        ("POST", "/api/chat/stream") | ("POST", "/api/agent/prompt") => {
            Some(handle_agent_prompt(state, req).await)
        }
        ("POST", "/api/chat/stop") | ("POST", "/api/agent/abort") => {
            Some(handle_agent_abort(state, req).await)
        }
        ("POST", "/api/chat/steer") => Some(handle_chat_steer(state, req, false)),
        ("POST", "/api/chat/queue") => Some(handle_chat_steer(state, req, true)),
        ("POST", "/api/agent/spawn") => Some(handle_agent_spawn(state, req).await),
        ("POST", "/api/agent/confirm") => Some(handle_agent_confirm(state, req)),
        ("GET", "/api/agent/mode") => Some(handle_agent_mode_get(state, req)),
        ("POST", "/api/agent/mode") => Some(handle_agent_mode_set(state, req)),
        ("GET", "/api/agent/sessions") => Some(handle_agent_sessions(state)),
        ("GET", "/api/agent/backends") => Some(handle_agent_backends(state)),
        ("GET", "/api/agent/cache") => Some(handle_agent_cache(state, req)),

        ("POST", "/api/sessions/delete") => Some(handle_sessions_delete(state, req)),
        ("POST", "/api/sessions/rename") => Some(handle_sessions_rename(state, req)),
        ("POST", "/api/sessions/fork") => Some(handle_sessions_fork(state, req)),
        ("POST", "/api/sessions/rewind") => Some(handle_sessions_rewind(state, req).await),
        ("POST", "/api/sessions/compact") => Some(handle_sessions_compact(state, req).await),

        ("POST", "/api/sessions/btw/create") => Some(handle_chat_btw_create(state, req)),
        ("POST", "/api/sessions/btw/append") => Some(handle_chat_btw_append(state, req)),
        ("GET", "/api/sessions/btw/list") => Some(handle_chat_btw_list(state, req)),

        // Intercept chat-surface BTW calls routed through /api/btw/* when surface=="chat"
        ("POST", "/api/btw/create") if body_has_chat_surface(req) => {
            Some(handle_chat_btw_create(state, req))
        }
        ("POST", "/api/btw/append") if body_has_chat_btw_id(req) => {
            Some(handle_chat_btw_append(state, req))
        }
        ("GET", "/api/btw/list") if query_param_val(req, "surface").as_deref() == Some("chat") => {
            Some(handle_chat_btw_list(state, req))
        }

        ("POST", "/api/graph/peers") => Some(handle_graph_peers_register(state, req)),
        ("POST", "/api/router/candidates") => Some(handle_router_candidate_upsert(state, req)),
        ("POST", "/api/attachments/upload") => Some(handle_attachment_upload(state, req)),
        ("GET", "/api/attachments/get") => Some(handle_attachment_get(state, req)),

        // 3. Dual-Scope Model Roles & CredMan
        ("GET", "/api/models/config") => Some(handle_models_config_get(state)),
        ("POST", "/api/models/config") => Some(handle_models_config_set(state, req)),
        ("GET", "/api/credentials") => Some(handle_credentials_list()),
        ("POST", "/api/credentials") => Some(handle_credentials_set(req)),
        ("POST", "/api/credentials/delete") => Some(handle_credentials_delete(req)),

        // 4. IDE Workspace, Git, LSP, ConPTY Terminal
        ("GET", "/api/files/tree") => Some(handle_files_tree(state, req)),
        ("GET", "/api/files/read") => Some(handle_files_read(state, req)),
        ("POST", "/api/files/write") | ("POST", "/api/workspace/write") => {
            Some(handle_files_write(state, req))
        }
        ("GET", "/api/git/status") => Some(handle_git_status(state)),
        ("GET", "/api/git/diff") => Some(handle_git_diff(state, req)),
        ("GET", "/api/ide/lsp") | ("POST", "/api/ide/lsp") => Some(handle_ide_lsp(state, req)),

        ("POST", "/api/terminal/create") | ("POST", "/api/pty/create") => {
            Some(handle_terminal_create(state, req))
        }
        ("GET", "/api/terminal/list") | ("GET", "/api/pty/list") => {
            Some(handle_terminal_list(state))
        }
        ("POST", "/api/terminal/resize") | ("POST", "/api/pty/resize") => {
            Some(handle_terminal_resize(state, req))
        }
        ("POST", "/api/terminal/input") | ("POST", "/api/pty/input") => {
            Some(handle_terminal_input(state, req).await)
        }
        ("POST", "/api/terminal/kill") | ("POST", "/api/pty/kill") => {
            Some(handle_terminal_kill(state, req))
        }
        ("GET", "/api/terminal/scrollback") | ("GET", "/api/pty/scrollback") => {
            Some(handle_terminal_scrollback(state, req))
        }

        // 5. Isolated Browser CDP
        ("POST", "/api/browser/launch") | ("POST", "/api/media/browser/launch") => {
            Some(handle_browser_launch(state, req).await)
        }
        ("GET", "/api/browser/status") | ("GET", "/api/media/browser/status") => {
            Some(handle_browser_status(state).await)
        }
        ("POST", "/api/browser/navigate") | ("POST", "/api/media/browser/navigate") => {
            Some(handle_browser_navigate(state, req).await)
        }
        ("POST", "/api/browser/click") | ("POST", "/api/media/browser/click") => {
            Some(handle_browser_click(state, req).await)
        }
        ("POST", "/api/browser/type") | ("POST", "/api/media/browser/type") => {
            Some(handle_browser_type(state, req).await)
        }
        ("GET", "/api/browser/screenshot")
        | ("POST", "/api/browser/screenshot")
        | ("GET", "/api/media/browser/screenshot")
        | ("POST", "/api/media/browser/screenshot") => {
            Some(handle_browser_screenshot(state).await)
        }
        ("GET", "/api/browser/snapshot")
        | ("POST", "/api/browser/snapshot")
        | ("GET", "/api/media/browser/snapshot")
        | ("POST", "/api/media/browser/snapshot") => {
            Some(handle_browser_snapshot(state).await)
        }
        ("POST", "/api/browser/close") | ("POST", "/api/media/browser/close") => {
            Some(handle_browser_close(state).await)
        }

        // 6. Extensions: MCP / Hooks / Recipes / Cordis / DAP
        ("GET", "/api/mcp/servers") => Some(handle_mcp_list(state)),
        ("POST", "/api/mcp/servers") => Some(handle_mcp_connect(state, req).await),
        ("POST", "/api/mcp/servers/disconnect") => Some(handle_mcp_disconnect(state, req).await),
        ("GET", "/api/mcp/tools/search") => Some(handle_mcp_tools_search(state, req)),
        ("POST", "/api/mcp/tools/call") => Some(handle_mcp_tools_call(state, req).await),
        ("GET", "/api/mcp/tasks") | ("POST", "/api/mcp/tasks") => {
            Some(handle_mcp_tasks(state, req).await)
        }

        ("GET", "/api/hooks") => Some(handle_hooks_list(state)),
        ("POST", "/api/hooks") => Some(handle_hooks_register(state, req)),
        ("POST", "/api/hooks/toggle") => Some(handle_hooks_toggle(state, req)),

        ("GET", "/api/recipes") => Some(handle_recipes_list(state)),
        ("POST", "/api/recipes/render") => Some(handle_recipes_render(state, req)),

        ("GET", "/api/plugins/cordis") => Some(handle_cordis_list(state)),
        ("POST", "/api/plugins/cordis") => Some(handle_cordis_create(state, req)),
        ("POST", "/api/plugins/cordis/toggle") => Some(handle_cordis_toggle(state, req)),
        ("POST", "/api/plugins/cordis/rollback") => Some(handle_cordis_rollback(state, req)),

        ("GET", "/api/dap/sessions") => Some(handle_dap_list(state)),
        ("POST", "/api/dap/launch") => Some(handle_dap_launch(state, req).await),
        ("POST", "/api/dap/terminate") => Some(handle_dap_terminate(state, req).await),

        // 7. Memory Engine & Knowledge Workspace (`omp-omni` KB / Pastes / Kanban / Inbox / Routines)
        ("POST", "/api/memory/retain") => Some(handle_memory_retain(state, req)),
        ("POST", "/api/memory/recall") | ("GET", "/api/memory/recall") => {
            Some(handle_memory_recall(state, req))
        }
        ("POST", "/api/memory/reflect") => Some(handle_memory_reflect(state, req)),

        ("GET", "/api/kb/notes") | ("GET", "/api/kb/search") => Some(handle_kb_search(state, req)),
        ("POST", "/api/kb/notes") => Some(handle_kb_upsert(state, req)),
        ("GET", "/api/pastes") => Some(handle_pastes_list(state)),
        ("POST", "/api/pastes") => Some(handle_pastes_create(state, req)),
        ("GET", "/api/pastes/get") => Some(handle_pastes_get(state, req)),
        ("GET", "/api/kanban/tasks") => Some(handle_kanban_list(state)),
        ("POST", "/api/kanban/tasks") => Some(handle_kanban_create(state, req)),
        ("POST", "/api/kanban/status") => Some(handle_kanban_status(state, req)),
        ("GET", "/api/inbox") => Some(handle_inbox_list(state)),
        ("POST", "/api/inbox") => Some(handle_inbox_add(state, req)),
        ("GET", "/api/routines") => Some(handle_routines_list(state)),
        ("POST", "/api/routines") => Some(handle_routines_upsert(state, req)),

        // 8. Telemetry, Traces, Scoreboard
        ("GET", "/api/stats/overview") | ("GET", "/api/stats/spotlight") => {
            Some(handle_stats_overview(state))
        }
        ("GET", "/api/traces") => Some(handle_traces_list(state, req)),
        ("GET", "/api/benchmarks/scoreboard") => Some(handle_benchmarks_scoreboard(state)),

        _ => None,
    }
}

fn parse_json_body(req: &HttpRequest) -> Result<Value, HttpResponse> {
    if req.body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice::<Value>(&req.body)
        .map_err(|e| HttpResponse::error(400, "invalid_json", &format!("Invalid JSON body: {e}")))
}

fn query_param_val(req: &HttpRequest, name: &str) -> Option<String> {
    req.query_params()
        .into_iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v)
        .filter(|v| !v.is_empty())
}

fn non_empty_str<'a>(val: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| val.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn body_has_chat_surface(req: &HttpRequest) -> bool {
    serde_json::from_slice::<Value>(&req.body)
        .ok()
        .is_some_and(|v| non_empty_str(&v, &["surface"]) == Some("chat"))
}

fn body_has_chat_btw_id(req: &HttpRequest) -> bool {
    serde_json::from_slice::<Value>(&req.body).ok().is_some_and(|v| {
        non_empty_str(&v, &["surface"]) == Some("chat")
            || non_empty_str(&v, &["btwId", "threadId"])
                .is_some_and(|id| id.starts_with("cbtw_"))
    })
}

// =========================================================================
// 1. AG-UI EventFeed
// =========================================================================

fn handle_events_sse(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let since = req
        .header("last-event-id")
        .or_else(|| req.header("Last-Event-ID"))
        .and_then(|s| s.trim().parse::<u64>().ok())
        .or_else(|| query_param_val(req, "since").and_then(|s| s.parse::<u64>().ok()));
    let rx = state.event_feed.subscribe_sse(since);
    HttpResponse::sse_channel(rx, SSE_KEEPALIVE_INTERVAL)
}

fn handle_events_recent(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let since = query_param_val(req, "since")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let limit = query_param_val(req, "limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(100);
    HttpResponse::ok(json!({
        "ok": true,
        "headSeq": state.event_feed.head_seq(),
        "events": state.event_feed.recent(since, limit),
    }))
}

// =========================================================================
// 2. Unified Agent / Chat / Sessions / Attachments / Chat-BTW
// =========================================================================

async fn handle_agent_spawn(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let clean_cwd = if let Some(cwd_rel) = non_empty_str(&body, &["cwd"]) {
        match ensure_within_workspace(&state.config.workspace_root, cwd_rel) {
            Ok(p) => p,
            Err(e) => return HttpResponse::error(403, "invalid_cwd", &e.to_string()),
        }
    } else {
        state.config.workspace_root.clone()
    };

    let tab_id = non_empty_str(&body, &["sessionId", "tabId"])
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("sess_{}", uuid_v4()));
    let backend = parse_backend_id(non_empty_str(&body, &["backend"]));
    let approval_mode = parse_approval_mode(non_empty_str(&body, &["approvalMode", "mode"]));
    let wire_api = parse_wire_api(non_empty_str(&body, &["wireApi"]));
    let role_override = resolve_role_override(&state.ops, non_empty_str(&body, &["role"]).unwrap_or("main"));
    let provider = non_empty_str(&body, &["provider", "providerId"])
        .map(ToString::to_string)
        .or(role_override.0);
    let model_id = non_empty_str(&body, &["model", "modelId"])
        .map(ToString::to_string)
        .or(role_override.1);
    let thinking_level = non_empty_str(&body, &["thinking", "effort", "thinkingLevel"])
        .map(ToString::to_string)
        .or(role_override.2);
    let max_turns = body
        .get("maxTurns")
        .and_then(Value::as_u64)
        .map(|n| n.clamp(1, 64) as u32)
        .unwrap_or(16);

    let sink = build_harness_sink(Arc::clone(state), tab_id.clone());
    let spawn_req = ManagedSpawnRequest {
        tab_id: tab_id.clone(),
        cwd: clean_cwd,
        backend,
        approval_mode,
        workspace_trusted: body
            .get("workspaceTrusted")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        permission_rules: Vec::new(),
        provider,
        model_id,
        thinking_level,
        wire_api,
        config_dir: None,
        max_turns,
    };

    match state.harness.spawn_session(spawn_req, sink).await {
        Ok((session_key, pid, init_state)) => {
            state.event_feed.publish(
                "agent",
                "session_spawned",
                Some(&tab_id),
                json!({
                    "sessionKey": session_key,
                    "sessionId": tab_id,
                    "pid": pid,
                    "state": init_state,
                }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "sessionKey": session_key,
                "sessionId": tab_id,
                "pid": pid,
                "state": init_state,
            }))
        }
        Err(e) => {
            let detail = SecretRedactor::redact(&e.to_string());
            let status = if is_provider_config_error(&detail) { 503 } else { 400 };
            HttpResponse::error(status, "agent_spawn_failed", &detail)
        }
    }
}

async fn handle_agent_prompt(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let prompt_raw = non_empty_str(&body, &["prompt", "message", "text", "content"]);
    let Some(prompt_raw) = prompt_raw else {
        return HttpResponse::error(400, "missing_prompt", "Field 'prompt' or 'message' is required.");
    };

    let session_id = non_empty_str(&body, &["sessionId", "tabId"])
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("sess_{}", uuid_v4()));
    let mode = non_empty_str(&body, &["mode"]).unwrap_or("builder").to_ascii_lowercase();
    let _ = state.ops.set_session_mode(
        &session_id,
        &mode,
        &state.config.workspace_root.to_string_lossy(),
    );

    // Run `UserPromptSubmit` lifecycle hooks (`exit 2` = hard deterministic block).
    let hook_outcome = state
        .hooks
        .dispatch(
            HookEvent::UserPromptSubmit,
            Some(&session_id),
            json!({
                "sessionId": session_id,
                "mode": mode,
                "prompt": prompt_raw,
            }),
        )
        .await;
    if hook_outcome.blocked {
        return HttpResponse::error(
            403,
            "hook_blocked",
            hook_outcome
                .block_reason
                .as_deref()
                .unwrap_or("Blocked by UserPromptSubmit hook."),
        );
    }
    let effective_prompt = hook_outcome
        .revised_input
        .as_ref()
        .and_then(|v| v.as_str().or_else(|| v.get("prompt").and_then(Value::as_str)))
        .unwrap_or(prompt_raw)
        .to_string();

    // Ensure session exists in SQLite SessionStore and persist user turn.
    let role_override = resolve_role_override(&state.ops, "main");
    let chosen_model = non_empty_str(&body, &["model", "modelId"])
        .map(ToString::to_string)
        .or(role_override.1.clone())
        .unwrap_or_else(|| "auto".to_string());
    let chosen_effort = non_empty_str(&body, &["thinking", "effort", "thinkingLevel"])
        .map(ToString::to_string)
        .or(role_override.2.clone())
        .unwrap_or_else(|| "high".to_string());
    if state.sessions.get_session(&session_id).ok().flatten().is_none() {
        let title = effective_prompt.chars().take(64).collect::<String>();
        let _ = state.sessions.upsert_session(
            &session_id,
            if title.is_empty() { "New Studio Session" } else { &title },
            &chosen_model,
            &chosen_effort,
            now_epoch_ms(),
        );
    }

    // Wire real multimodal attachments from SQLite blob store if `attachmentIds` are provided.
    let mut prompt_with_attachments = effective_prompt.clone();
    let mut attached_refs: Vec<Value> = Vec::new();
    if let Some(ids) = body.get("attachmentIds").and_then(Value::as_array) {
        let existing = state
            .sessions
            .list_session_attachments(&session_id)
            .unwrap_or_default();
        for id_val in ids {
            let Some(aid) = id_val.as_str() else { continue };
            if let Some(meta) = existing.iter().find(|a| a.id == aid) {
                let mut entry = json!({
                    "id": meta.id,
                    "filename": meta.filename,
                    "mimeType": meta.mime_type,
                    "sha256": meta.sha256,
                    "byteLen": meta.byte_len,
                });
                if let Ok(Some(bytes)) = state.sessions.read_blob(&meta.sha256) {
                    if meta.mime_type.starts_with("text/")
                        || meta.mime_type == "application/json"
                    {
                        let preview = String::from_utf8_lossy(&bytes);
                        let clipped: String = preview.chars().take(4_000).collect();
                        prompt_with_attachments.push_str(&format!(
                            "\n\n[Attached File: {} ({})]\n{}\n",
                            meta.filename, meta.mime_type, clipped
                        ));
                    } else if meta.mime_type.starts_with("image/") {
                        entry["dataBase64"] = Value::String(base64_encode(&bytes));
                        prompt_with_attachments.push_str(&format!(
                            "\n\n[Attached Image: {} ({}, {} bytes, sha256={})]\n",
                            meta.filename, meta.mime_type, bytes.len(), meta.sha256
                        ));
                    } else {
                        prompt_with_attachments.push_str(&format!(
                            "\n\n[Attached Binary/Document: {} ({}, {} bytes, sha256={})]\n",
                            meta.filename, meta.mime_type, bytes.len(), meta.sha256
                        ));
                    }
                }
                attached_refs.push(entry);
            }
        }
    }

    let _ = state.sessions.append_message(
        &session_id,
        "user",
        &effective_prompt,
        &json!({
            "mode": mode,
            "attachments": attached_refs,
        })
        .to_string(),
        now_epoch_ms(),
    );
    let since_seq = state.event_feed.publish(
        "agent",
        "user_message",
        Some(&session_id),
        json!({
            "sessionId": session_id,
            "mode": mode,
            "content": effective_prompt,
            "attachments": attached_refs,
        }),
    );

    // Reuse existing managed session if caller passed `sessionKey` or matching `tabId`.
    let requested_key = non_empty_str(&body, &["sessionKey"]).map(ToString::to_string);
    let session_key = match requested_key {
        Some(sk) if state.harness.owns_session(&sk) => sk,
        _ => {
            let existing_sk = state
                .harness
                .list_running()
                .into_iter()
                .find(|s| s.tab_id == session_id)
                .map(|s| s.session_key);
            match existing_sk {
                Some(sk) => sk,
                None => {
                    let approval_mode = match mode.as_str() {
                        "chat" => ApprovalMode::Plan,
                        "solo" => ApprovalMode::Yolo,
                        _ => parse_approval_mode(non_empty_str(&body, &["approvalMode"])),
                    };
                    let sink = build_harness_sink(Arc::clone(state), session_id.clone());
                    let spawn_req = ManagedSpawnRequest {
                        tab_id: session_id.clone(),
                        cwd: state.config.workspace_root.clone(),
                        backend: parse_backend_id(non_empty_str(&body, &["backend"])),
                        approval_mode,
                        workspace_trusted: true,
                        permission_rules: Vec::new(),
                        provider: non_empty_str(&body, &["provider", "providerId"])
                            .map(ToString::to_string)
                            .or(role_override.0),
                        model_id: non_empty_str(&body, &["model", "modelId"])
                            .map(ToString::to_string)
                            .or(role_override.1),
                        thinking_level: non_empty_str(&body, &["thinking", "effort", "thinkingLevel"])
                            .map(ToString::to_string)
                            .or(role_override.2),
                        wire_api: parse_wire_api(non_empty_str(&body, &["wireApi"])),
                        config_dir: None,
                        max_turns: if mode == "solo" { 32 } else { 16 },
                    };
                    match state.harness.spawn_session(spawn_req, sink).await {
                        Ok((sk, _, _)) => sk,
                        Err(e) => {
                            let detail = SecretRedactor::redact(&e.to_string());
                            state.event_feed.publish(
                                "agent",
                                "error",
                                Some(&session_id),
                                json!({ "code": "provider_unconfigured", "message": detail }),
                            );
                            let status = if is_provider_config_error(&detail) { 503 } else { 400 };
                            return HttpResponse::error(status, "provider_unconfigured", &detail);
                        }
                    }
                }
            }
        }
    };

    let wants_sse = req
        .header("accept")
        .is_some_and(|a| a.to_ascii_lowercase().contains("text/event-stream"))
        || body.get("stream").and_then(Value::as_bool) == Some(true);
    let sse_rx = wants_sse.then(|| state.event_feed.subscribe_sse(Some(since_seq.saturating_sub(1))));

    match state
        .harness
        .send_prompt(&session_key, &prompt_with_attachments)
        .await
    {
        Ok(ack) => {
            if let Some(rx) = sse_rx {
                HttpResponse::sse_channel(rx, SSE_KEEPALIVE_INTERVAL)
            } else {
                HttpResponse::ok(json!({
                    "ok": true,
                    "accepted": true,
                    "sessionId": session_id,
                    "sessionKey": session_key,
                    "mode": mode,
                    "sinceSeq": since_seq,
                    "ack": ack,
                }))
            }
        }
        Err(e) => {
            let detail = SecretRedactor::redact(&e.to_string());
            HttpResponse::error(400, "prompt_dispatch_failed", &detail)
        }
    }
}

async fn handle_agent_abort(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = parse_json_body(req).unwrap_or_else(|_| json!({}));
    let Some(key) = resolve_managed_session_key(state, &body) else {
        return HttpResponse::error(404, "session_not_found", "No active managed agent session matched.");
    };
    state.harness.abort_session(&key);
    state.event_feed.publish(
        "agent",
        "session_aborted",
        state.harness.get_session_tab_id(&key).as_deref(),
        json!({ "sessionKey": key, "aborted": true }),
    );
    HttpResponse::ok(json!({ "ok": true, "sessionKey": key, "aborted": true }))
}

fn handle_agent_confirm(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(key) = resolve_managed_session_key(state, &body) else {
        return HttpResponse::error(404, "session_not_found", "No active managed agent session matched.");
    };
    let Some(req_id) = non_empty_str(&body, &["requestId", "id"]) else {
        return HttpResponse::error(400, "missing_request_id", "Field 'requestId' is required.");
    };
    let approved = body
        .get("approved")
        .or_else(|| body.get("allow"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    match state.harness.respond_confirm(&key, req_id, approved) {
        Ok(()) => {
            state.event_feed.publish(
                "agent",
                "permission_response",
                state.harness.get_session_tab_id(&key).as_deref(),
                json!({ "sessionKey": key, "requestId": req_id, "approved": approved, "delivered": true }),
            );
            HttpResponse::ok(json!({ "ok": true, "sessionKey": key, "requestId": req_id, "approved": approved }))
        }
        Err(e) => HttpResponse::error(400, "permission_response_failed", &e.to_string()),
    }
}

fn handle_agent_mode_get(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let sid = query_param_val(req, "sessionId").unwrap_or_else(|| "default".to_string());
    let mode = state
        .ops
        .get_session_mode(&sid)
        .unwrap_or_else(|_| "builder".to_string());
    HttpResponse::ok(json!({ "ok": true, "sessionId": sid, "mode": mode }))
}

fn handle_agent_mode_set(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let sid = non_empty_str(&body, &["sessionId"]).unwrap_or("default");
    let raw_mode = non_empty_str(&body, &["mode"]).unwrap_or("builder");
    match state
        .ops
        .set_session_mode(sid, raw_mode, &state.config.workspace_root.to_string_lossy())
    {
        Ok(mode) => {
            state.event_feed.publish(
                "agent",
                "mode_changed",
                Some(sid),
                json!({ "sessionId": sid, "mode": mode }),
            );
            HttpResponse::ok(json!({ "ok": true, "sessionId": sid, "mode": mode }))
        }
        Err(e) => HttpResponse::error(400, "invalid_mode", &e),
    }
}

fn handle_agent_sessions(state: &Arc<StudioState>) -> HttpResponse {
    let running = state.harness.list_running();
    HttpResponse::ok(json!({ "ok": true, "sessions": running }))
}

fn handle_agent_backends(state: &Arc<StudioState>) -> HttpResponse {
    let backends = state.harness.list_backends(None);
    HttpResponse::ok(json!({ "ok": true, "backends": backends }))
}

fn handle_agent_cache(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let key = query_param_val(req, "sessionKey");
    let stats = state.harness.cache_stats(key.as_deref());
    HttpResponse::ok(json!({ "ok": true, "cacheStats": stats }))
}

fn handle_chat_steer(state: &Arc<StudioState>, req: &HttpRequest, queued: bool) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(prompt) = non_empty_str(&body, &["prompt", "message", "text", "content"]) else {
        return HttpResponse::error(400, "missing_prompt", "Field 'prompt' is required.");
    };
    let sid = non_empty_str(&body, &["sessionId"]).map(ToString::to_string);
    let item = state.steer.enqueue(prompt, SteerMode::AdditiveIntake, None);
    let event_name = if queued { "queue_enqueued" } else { "steer_enqueued" };
    state.event_feed.publish(
        "agent",
        event_name,
        sid.as_deref(),
        json!({
            "mode": if queued { "queue" } else { "steer" },
            "item": item,
        }),
    );
    HttpResponse::ok(json!({
        "ok": true,
        "mode": if queued { "queue" } else { "steer" },
        "tokenBudget": Value::Null,
        "item": item,
    }))
}

fn handle_sessions_delete(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(sid) = non_empty_str(&body, &["sessionId", "id"]) else {
        return HttpResponse::error(400, "missing_session_id", "Field 'sessionId' is required.");
    };
    match state.sessions.delete_session(sid) {
        Ok(deleted) => {
            if deleted {
                state.event_feed.publish(
                    "agent",
                    "session_deleted",
                    Some(sid),
                    json!({ "sessionId": sid }),
                );
            }
            HttpResponse::ok(json!({ "ok": true, "deleted": deleted, "sessionId": sid }))
        }
        Err(e) => HttpResponse::error(500, "session_delete_failed", &e.to_string()),
    }
}

fn handle_sessions_rename(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(sid) = non_empty_str(&body, &["sessionId", "id"]) else {
        return HttpResponse::error(400, "missing_session_id", "Field 'sessionId' is required.");
    };
    let Some(title) = non_empty_str(&body, &["title", "name"]) else {
        return HttpResponse::error(400, "missing_title", "Field 'title' is required.");
    };
    let existing = state.sessions.get_session(sid).ok().flatten();
    let (model_id, effort) = match existing {
        Some(rec) => (rec.model_id, rec.effort),
        None => {
            return HttpResponse::error(404, "session_not_found", "Session does not exist.")
        }
    };
    match state
        .sessions
        .upsert_session(sid, title, &model_id, &effort, now_epoch_ms())
    {
        Ok(rec) => {
            state.event_feed.publish(
                "agent",
                "session_renamed",
                Some(sid),
                json!({ "sessionId": sid, "title": rec.title }),
            );
            HttpResponse::ok(json!({ "ok": true, "sessionId": rec.id, "title": rec.title }))
        }
        Err(e) => HttpResponse::error(500, "session_rename_failed", &e.to_string()),
    }
}

fn handle_sessions_fork(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(source_id) = non_empty_str(&body, &["sessionId", "sourceSessionId", "id"]) else {
        return HttpResponse::error(400, "missing_session_id", "Field 'sessionId' is required.");
    };
    let Ok(Some(src)) = state.sessions.get_session(source_id) else {
        return HttpResponse::error(404, "session_not_found", "Source session not found.");
    };
    let new_id = non_empty_str(&body, &["newSessionId"])
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("sess_{}", uuid_v4()));
    let new_title = non_empty_str(&body, &["title"])
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("{} (Fork)", src.title));

    if let Err(e) = state
        .sessions
        .upsert_session(&new_id, &new_title, &src.model_id, &src.effort, now_epoch_ms())
    {
        return HttpResponse::error(500, "session_fork_failed", &e.to_string());
    }
    let up_to_seq = body.get("upToSeq").and_then(Value::as_i64);
    let mut copied = 0usize;
    if let Ok(msgs) = state.sessions.list_messages(source_id, 0) {
        for m in msgs {
            if let Some(cap) = up_to_seq {
                if m.seq > cap {
                    continue;
                }
            }
            if state
                .sessions
                .append_message(&new_id, &m.role, &m.content, &m.metadata_json, now_epoch_ms())
                .is_ok()
            {
                copied += 1;
            }
        }
    }
    state.event_feed.publish(
        "agent",
        "session_forked",
        Some(&new_id),
        json!({ "sourceSessionId": source_id, "sessionId": new_id, "copiedMessages": copied }),
    );
    HttpResponse::ok(json!({
        "ok": true,
        "sourceSessionId": source_id,
        "sessionId": new_id,
        "title": new_title,
        "copiedMessages": copied,
    }))
}

async fn handle_sessions_rewind(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(key) = resolve_managed_session_key(state, &body) else {
        return HttpResponse::error(404, "session_not_found", "Active managed session not found for rewind.");
    };
    let turn = body.get("turn").and_then(Value::as_u64).unwrap_or(0) as u32;
    match state.harness.rewind_to_turn(&key, turn).await {
        Ok(report) => {
            state.event_feed.publish(
                "agent",
                "session_rewound",
                state.harness.get_session_tab_id(&key).as_deref(),
                json!({ "sessionKey": key, "turn": turn, "report": report }),
            );
            HttpResponse::ok(json!({ "ok": true, "sessionKey": key, "turn": turn, "report": report }))
        }
        Err(e) => HttpResponse::error(400, "rewind_failed", &e.to_string()),
    }
}

async fn handle_sessions_compact(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(key) = resolve_managed_session_key(state, &body) else {
        return HttpResponse::error(404, "session_not_found", "Active managed session not found for compact.");
    };
    let note = non_empty_str(&body, &["note", "instructions"]);
    match state.harness.compact_session(&key).await {
        Ok(report) => {
            state.event_feed.publish(
                "agent",
                "session_compacted",
                state.harness.get_session_tab_id(&key).as_deref(),
                json!({ "sessionKey": key, "note": note, "report": report }),
            );
            HttpResponse::ok(json!({ "ok": true, "sessionKey": key, "note": note, "report": report }))
        }
        Err(e) => HttpResponse::error(400, "compact_failed", &e.to_string()),
    }
}

fn handle_chat_btw_create(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let sid = non_empty_str(&body, &["sessionId"]).unwrap_or("default");
    let message_id = non_empty_str(&body, &["messageId", "sourceMessageId", "anchorTurnId"]).unwrap_or("");
    let quote_text = non_empty_str(&body, &["quoteText", "quote", "selectedText"]).unwrap_or("");
    let question = non_empty_str(&body, &["question", "prompt"]).unwrap_or("");
    let quote_val = json!({ "text": quote_text });
    match state.ops.create_chat_btw(sid, message_id, &quote_val, question) {
        Ok(thread) => {
            state.event_feed.publish("agent", "chat_btw_created", Some(sid), thread.clone());
            HttpResponse::ok(json!({ "ok": true, "surface": "chat", "thread": thread }))
        }
        Err(e) => HttpResponse::error(400, "chat_btw_create_failed", &e),
    }
}

fn handle_chat_btw_append(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(btw_id) = non_empty_str(&body, &["btwId", "threadId", "id"]) else {
        return HttpResponse::error(400, "missing_btw_id", "Field 'btwId' is required.");
    };
    let role = non_empty_str(&body, &["role"]).unwrap_or("user");
    let Some(content) = non_empty_str(&body, &["content", "message", "text"]) else {
        return HttpResponse::error(400, "missing_content", "Field 'content' is required.");
    };
    match state.ops.append_chat_btw(btw_id, role, content) {
        Ok(thread) => HttpResponse::ok(json!({ "ok": true, "surface": "chat", "thread": thread })),
        Err(e) => HttpResponse::error(404, "chat_btw_append_failed", &e),
    }
}

fn handle_chat_btw_list(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let sid = query_param_val(req, "sessionId").unwrap_or_else(|| "default".to_string());
    match state.ops.list_chat_btw(&sid) {
        Ok(threads) => HttpResponse::ok(json!({ "ok": true, "surface": "chat", "threads": threads })),
        Err(e) => HttpResponse::error(500, "chat_btw_list_failed", &e),
    }
}

fn handle_attachment_upload(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let session_id = non_empty_str(&body, &["sessionId"])
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("sess_{}", uuid_v4()));
    let message_id = non_empty_str(&body, &["messageId"])
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("msg_{}", uuid_v4()));
    let placement_raw = non_empty_str(&body, &["placement"]).unwrap_or("tray");
    let Ok(placement) = AttachmentPlacement::parse(placement_raw) else {
        return HttpResponse::error(400, "invalid_placement", "Placement must be 'inline' or 'tray'.");
    };
    let filename = non_empty_str(&body, &["filename", "name"]).unwrap_or("attachment.bin");
    let mime_type = non_empty_str(&body, &["mimeType", "mediaType"]).unwrap_or("application/octet-stream");
    let Some(b64) = non_empty_str(&body, &["dataBase64", "base64", "data"]) else {
        return HttpResponse::error(400, "missing_attachment_data", "Field 'dataBase64' is required.");
    };
    let Ok(raw_bytes) = base64_decode(b64) else {
        return HttpResponse::error(400, "invalid_base64", "Attachment payload is not valid base64.");
    };
    if raw_bytes.len() > MAX_ATTACHMENT_BYTES {
        return HttpResponse::error(413, "attachment_too_large", "Attachment exceeds 10 MiB limit.");
    }

    if state.sessions.get_session(&session_id).ok().flatten().is_none() {
        let _ = state.sessions.upsert_session(
            &session_id,
            "Attachment Session",
            "auto",
            "high",
            now_epoch_ms(),
        );
    }

    match state.sessions.store_attachment(
        &session_id,
        &message_id,
        placement,
        filename,
        mime_type,
        &raw_bytes,
        now_epoch_ms(),
    ) {
        Ok(att) => {
            let payload = json!({
                "id": att.id,
                "sessionId": att.session_id,
                "messageId": att.message_id,
                "placement": att.placement.as_str(),
                "filename": att.filename,
                "mimeType": att.mime_type,
                "sha256": att.sha256,
                "byteLen": att.byte_len,
                "createdAtMs": att.created_at_ms,
                "uniqueBlobCount": state.sessions.unique_blob_count().unwrap_or(0),
            });
            state
                .event_feed
                .publish("agent", "attachment_uploaded", Some(&session_id), payload.clone());
            HttpResponse::ok(json!({ "ok": true, "attachment": payload }))
        }
        Err(e) => HttpResponse::error(500, "attachment_store_failed", &e.to_string()),
    }
}

fn handle_attachment_get(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    if let Some(sha) = query_param_val(req, "sha256") {
        return match state.sessions.read_blob(&sha) {
            Ok(Some(bytes)) => HttpResponse::ok(json!({
                "ok": true,
                "sha256": sha,
                "byteLen": bytes.len(),
                "dataBase64": base64_encode(&bytes),
            })),
            Ok(None) => HttpResponse::error(404, "blob_not_found", "Attachment blob not found."),
            Err(e) => HttpResponse::error(500, "blob_read_failed", &e.to_string()),
        };
    }
    let Some(sid) = query_param_val(req, "sessionId") else {
        return HttpResponse::error(400, "missing_query", "Provide 'sessionId' or 'sha256'.");
    };
    match state.sessions.list_session_attachments(&sid) {
        Ok(items) => {
            let list: Vec<Value> = items
                .into_iter()
                .map(|a| {
                    json!({
                        "id": a.id,
                        "sessionId": a.session_id,
                        "messageId": a.message_id,
                        "placement": a.placement.as_str(),
                        "filename": a.filename,
                        "mimeType": a.mime_type,
                        "sha256": a.sha256,
                        "byteLen": a.byte_len,
                        "createdAtMs": a.created_at_ms,
                    })
                })
                .collect();
            HttpResponse::ok(json!({ "ok": true, "sessionId": sid, "attachments": list }))
        }
        Err(e) => HttpResponse::error(500, "attachment_list_failed", &e.to_string()),
    }
}

// =========================================================================
// 3. Dual-Scope Model Roles & Windows Credential Manager
// =========================================================================

fn handle_models_config_get(state: &Arc<StudioState>) -> HttpResponse {
    let roles = state.ops.list_model_roles().unwrap_or_default();
    let providers_cfg = read_models_config(None)
        .ok()
        .map(|cfg| cfg.providers)
        .unwrap_or_default();
    let providers: Vec<Value> = providers_cfg
        .iter()
        .map(|p| {
            let models: Vec<Value> = p
                .models
                .iter()
                .map(|m| {
                    json!({
                        "id": m.id,
                        "name": m.name,
                        "contextWindow": m.context_window,
                        "maxTokens": m.max_tokens,
                        "reasoning": m.thinking.is_some(),
                    })
                })
                .collect();
            let k = p.api_key.trim();
            let configured_in_env = !k.is_empty()
                && (std::env::var(k).ok().is_some_and(|v| !v.trim().is_empty())
                    || !k
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit()));
            json!({
                "providerId": p.id,
                "baseUrl": p.base_url,
                "api": p.api,
                "configuredInEnv": configured_in_env,
                "models": models,
            })
        })
        .collect();
    HttpResponse::ok(json!({
        "ok": true,
        "roles": roles,
        "providers": providers,
    }))
}

fn handle_models_config_set(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let scope_raw = non_empty_str(&body, &["scope", "role"]).unwrap_or("main");
    let norm_scope = if scope_raw.eq_ignore_ascii_case("subagent") {
        "subagent".to_string()
    } else if let Ok(r) = scope_raw.parse::<ModelRole>() {
        r.as_str().to_string()
    } else {
        return HttpResponse::error(400, "invalid_model_scope", "Unsupported model scope/role.");
    };
    let Some(provider_id) = non_empty_str(&body, &["providerId", "provider"]) else {
        return HttpResponse::error(400, "missing_provider_id", "Field 'providerId' is required.");
    };
    let Some(model_id) = non_empty_str(&body, &["modelId", "model"]) else {
        return HttpResponse::error(400, "missing_model_id", "Field 'modelId' is required.");
    };
    let effort_raw = non_empty_str(&body, &["effort", "thinkingLevel"]).unwrap_or("high");
    let effort = match effort_raw.parse::<EffortLevel>() {
        Ok(lvl) => lvl.as_str().to_string(),
        Err(_) => effort_raw.to_ascii_lowercase(),
    };

    match state
        .ops
        .set_model_role(&norm_scope, provider_id, model_id, &effort)
    {
        Ok(saved) => {
            state.event_feed.publish(
                "router",
                "models_config_updated",
                None,
                json!({ "role": saved }),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "role": saved,
                "roles": state.ops.list_model_roles().unwrap_or_default(),
            }))
        }
        Err(e) => HttpResponse::error(500, "model_role_save_failed", &e),
    }
}

fn handle_credentials_list() -> HttpResponse {
    match CredentialStore::list_masked() {
        Ok(items) => {
            let list: Vec<Value> = items
                .into_iter()
                .map(|c| {
                    json!({
                        "target": c.target,
                        "kind": c.kind,
                        "label": c.label,
                        "maskedHint": c.masked_hint,
                        "updatedAtMs": c.updated_at_ms,
                    })
                })
                .collect();
            HttpResponse::ok(json!({ "ok": true, "credentials": list }))
        }
        Err(e) => HttpResponse::error(500, "credentials_list_failed", &e.to_string()),
    }
}

fn handle_credentials_set(req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(target) = non_empty_str(&body, &["target", "provider", "keyName"]) else {
        return HttpResponse::error(400, "missing_target", "Field 'target' is required.");
    };
    let Some(secret) = non_empty_str(&body, &["secret", "apiKey", "value"]) else {
        return HttpResponse::error(400, "missing_secret", "Field 'secret' is required.");
    };
    let kind = non_empty_str(&body, &["kind"]).unwrap_or("api_key");
    let label = non_empty_str(&body, &["label"]).unwrap_or(target);
    match CredentialStore::set_secret(target, kind, label, secret) {
        Ok(masked) => HttpResponse::ok(json!({
            "ok": true,
            "credential": {
                "target": masked.target,
                "kind": masked.kind,
                "label": masked.label,
                "maskedHint": masked.masked_hint,
                "updatedAtMs": masked.updated_at_ms,
            }
        })),
        Err(e) => HttpResponse::error(400, "credential_store_failed", &e.to_string()),
    }
}

fn handle_credentials_delete(req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(target) = non_empty_str(&body, &["target", "provider", "keyName"]) else {
        return HttpResponse::error(400, "missing_target", "Field 'target' is required.");
    };
    match CredentialStore::delete_secret(target) {
        Ok(deleted) => HttpResponse::ok(json!({ "ok": true, "target": target, "deleted": deleted })),
        Err(e) => HttpResponse::error(400, "credential_delete_failed", &e.to_string()),
    }
}

// =========================================================================
// 4. IDE Workspace, Git, LSP & Real ConPTY Terminals
// =========================================================================

fn handle_files_tree(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let rel = query_param_val(req, "path").unwrap_or_default();
    let max_depth = query_param_val(req, "depth")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(4)
        .clamp(1, 8);
    let safe_dir = if rel.trim().is_empty() {
        state.config.workspace_root.clone()
    } else {
        match ensure_within_workspace(&state.config.workspace_root, &rel) {
            Ok(p) if p.is_dir() => p,
            Ok(_) => return HttpResponse::error(400, "not_a_directory", "Requested tree path is not a directory."),
            Err(e) => return HttpResponse::error(403, "workspace_boundary_denied", &e.to_string()),
        }
    };

    let mut entries = Vec::new();
    let mut stack = vec![(safe_dir, 0usize)];
    let canon_ws = fs::canonicalize(&state.config.workspace_root)
        .unwrap_or_else(|_| state.config.workspace_root.clone());

    while let Some((dir, depth)) = stack.pop() {
        if entries.len() >= MAX_WORKSPACE_TREE_ENTRIES {
            break;
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let mut children: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        children.sort();
        for p in children {
            if entries.len() >= MAX_WORKSPACE_TREE_ENTRIES {
                break;
            }
            let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if matches!(name, ".git" | "target" | "build" | "node_modules" | "__pycache__") {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(&p) else { continue };
            if is_reparse_or_symlink(&meta) {
                continue;
            }
            let Ok(canon) = fs::canonicalize(&p) else { continue };
            if !canon.starts_with(&canon_ws) {
                continue;
            }
            let rel_path = canon
                .strip_prefix(&canon_ws)
                .unwrap_or(&canon)
                .to_string_lossy()
                .replace('\\', "/");
            let is_dir = meta.is_dir();
            entries.push(json!({
                "path": rel_path,
                "name": name,
                "kind": if is_dir { "dir" } else { "file" },
                "bytes": if is_dir { 0 } else { meta.len() },
                "depth": depth,
            }));
            if is_dir && depth < max_depth {
                stack.push((canon, depth + 1));
            }
        }
    }

    HttpResponse::ok(json!({
        "ok": true,
        "workspaceRoot": state.config.workspace_root.to_string_lossy(),
        "truncated": entries.len() >= MAX_WORKSPACE_TREE_ENTRIES,
        "entries": entries,
    }))
}

fn handle_files_read(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let Some(rel) = query_param_val(req, "path") else {
        return HttpResponse::error(400, "missing_path", "Query param 'path' is required.");
    };
    let safe_path = match ensure_within_workspace(&state.config.workspace_root, &rel) {
        Ok(p) => p,
        Err(e) => return HttpResponse::error(403, "workspace_boundary_denied", &e.to_string()),
    };
    match read_text_file(
        &state.config.workspace_root,
        &safe_path,
        LineEndingPolicy::NormalizeToLf,
    ) {
        Ok(res) => HttpResponse::ok(json!({
            "ok": true,
            "path": res.relative_path,
            "sha256": res.sha256,
            "bytes": res.byte_len,
            "content": res.content,
        })),
        Err(e) => HttpResponse::error(400, "file_read_failed", &e.to_string()),
    }
}

fn handle_files_write(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(rel) = non_empty_str(&body, &["path", "filePath"]) else {
        return HttpResponse::error(400, "missing_path", "Field 'path' is required.");
    };
    let Some(content) = body.get("content").and_then(Value::as_str) else {
        return HttpResponse::error(400, "missing_content", "Field 'content' is required.");
    };
    let safe_target = match ensure_within_workspace(&state.config.workspace_root, rel) {
        Ok(p) => p,
        Err(e) => return HttpResponse::error(403, "workspace_boundary_denied", &e.to_string()),
    };
    if let Some(expected) = non_empty_str(&body, &["expectedSha256"]) {
        if let Ok(existing) = read_text_file(
            &state.config.workspace_root,
            &safe_target,
            LineEndingPolicy::NormalizeToLf,
        ) {
            if !existing.sha256.eq_ignore_ascii_case(expected) {
                return HttpResponse::error(
                    409,
                    "sha256_mismatch",
                    "File content changed since last read.",
                );
            }
        }
    }
    let ensure_nl = body
        .get("ensureTrailingNewline")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let final_content = if ensure_nl && !content.ends_with('\n') {
        format!("{content}\n")
    } else {
        content.to_string()
    };
    let opts = WriteOptions {
        line_ending_policy: LineEndingPolicy::NormalizeToLf,
        create_parents: true,
        rollback_dir: Some(state.config.rollback_root.clone()),
        diff_context_lines: 3,
    };
    match write_atomic(&state.config.workspace_root, &safe_target, &final_content, &opts) {
        Ok(receipt) => {
            state.event_feed.publish(
                "workspace",
                "file_written",
                None,
                json!({ "path": rel, "receipt": receipt }),
            );
            HttpResponse::ok(json!({ "ok": true, "path": rel, "receipt": receipt }))
        }
        Err(e) => HttpResponse::error(400, "file_write_failed", &e.to_string()),
    }
}

fn handle_git_status(state: &Arc<StudioState>) -> HttpResponse {
    match run_git(&state.config.workspace_root, &["status", "--porcelain=v1", "-b"]) {
        Ok(out) => {
            let mut branch = String::new();
            let mut files = Vec::new();
            for line in out.lines() {
                if let Some(b) = line.strip_prefix("## ") {
                    branch = b.to_string();
                } else if line.len() >= 4 {
                    files.push(json!({
                        "status": &line[..2],
                        "path": line[3..].trim(),
                    }));
                }
            }
            HttpResponse::ok(json!({
                "ok": true,
                "isGitRepo": true,
                "branch": branch,
                "files": files,
            }))
        }
        Err(e) => HttpResponse::ok(json!({
            "ok": true,
            "isGitRepo": false,
            "branch": "",
            "files": [],
            "note": e.to_string(),
        })),
    }
}

fn handle_git_diff(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let staged = query_param_val(req, "staged").as_deref() == Some("1");
    let file = query_param_val(req, "path");
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    if let Some(ref p) = file {
        args.push("--");
        args.push(p.as_str());
    }
    match run_git(&state.config.workspace_root, &args) {
        Ok(diff) => HttpResponse::ok(json!({
            "ok": true,
            "isGitRepo": true,
            "staged": staged,
            "diff": diff,
        })),
        Err(e) => {
            let msg = e.to_string();
            if msg.to_ascii_lowercase().contains("not a git repository") {
                HttpResponse::ok(json!({
                    "ok": true,
                    "isGitRepo": false,
                    "staged": staged,
                    "diff": "",
                    "note": msg,
                }))
            } else {
                HttpResponse::error(400, "git_diff_failed", &msg)
            }
        }
    }
}

fn handle_ide_lsp(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = serde_json::from_slice::<Value>(&req.body).unwrap_or_else(|_| json!({}));
    let query = query_param_val(req, "query")
        .or_else(|| non_empty_str(&body, &["query", "symbol"]).map(ToString::to_string))
        .unwrap_or_default();
    let max_nodes = query_param_val(req, "limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(60)
        .clamp(10, 200);

    match state.harness.graph_map(&state.config.workspace_root, max_nodes) {
        Ok(map) => {
            let q_lower = query.to_ascii_lowercase();
            let mut symbols = Vec::new();
            for node in &map.nodes {
                for sym in &node.symbols {
                    if symbols.len() >= max_nodes {
                        break;
                    }
                    if q_lower.is_empty()
                        || sym.to_ascii_lowercase().contains(&q_lower)
                        || node.path.to_ascii_lowercase().contains(&q_lower)
                    {
                        symbols.push(json!({
                            "name": sym,
                            "kind": node.language,
                            "file": node.path,
                            "line": 1,
                        }));
                    }
                }
                if node.symbols.is_empty()
                    && symbols.len() < max_nodes
                    && (q_lower.is_empty() || node.path.to_ascii_lowercase().contains(&q_lower))
                {
                    symbols.push(json!({
                        "name": node.path,
                        "kind": node.language,
                        "file": node.path,
                        "line": 1,
                    }));
                }
            }
            HttpResponse::ok(json!({
                "ok": true,
                "query": query,
                "symbolCount": symbols.len(),
                "symbols": symbols,
            }))
        }
        Err(e) => HttpResponse::error(500, "lsp_query_failed", &e.to_string()),
    }
}

fn handle_terminal_create(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let cwd = if let Some(cwd_rel) = non_empty_str(&body, &["cwd"]) {
        match ensure_within_workspace(&state.config.workspace_root, cwd_rel) {
            Ok(p) => p,
            Err(e) => return HttpResponse::error(403, "workspace_boundary_denied", &e.to_string()),
        }
    } else {
        state.config.workspace_root.clone()
    };
    let shell = non_empty_str(&body, &["shell", "program"]);
    let cols = body.get("cols").and_then(Value::as_u64).unwrap_or(120) as u16;
    let rows = body.get("rows").and_then(Value::as_u64).unwrap_or(32) as u16;
    match state.terminals.create_session(&cwd, shell, cols, rows) {
        Ok(info) => {
            state.event_feed.publish(
                "pty",
                "pty_created",
                Some(&info.pty_id),
                serde_json::to_value(&info).unwrap_or_else(|_| json!({})),
            );
            HttpResponse::ok(json!({ "ok": true, "terminal": info }))
        }
        Err(e) => HttpResponse::error(400, "terminal_create_failed", &e),
    }
}

fn handle_terminal_list(state: &Arc<StudioState>) -> HttpResponse {
    let list = state.terminals.list();
    HttpResponse::ok(json!({ "ok": true, "terminals": list }))
}

fn handle_terminal_resize(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(pty_id) = non_empty_str(&body, &["ptyId", "id"]) else {
        return HttpResponse::error(400, "missing_pty_id", "Field 'ptyId' is required.");
    };
    let cols = body.get("cols").and_then(Value::as_u64).unwrap_or(120) as u16;
    let rows = body.get("rows").and_then(Value::as_u64).unwrap_or(32) as u16;
    match state.terminals.resize(pty_id, cols, rows) {
        Ok(info) => HttpResponse::ok(json!({ "ok": true, "terminal": info })),
        Err(e) => HttpResponse::error(404, "terminal_resize_failed", &e),
    }
}

async fn handle_terminal_input(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(pty_id) = non_empty_str(&body, &["ptyId", "id"]) else {
        return HttpResponse::error(400, "missing_pty_id", "Field 'ptyId' is required.");
    };
    let Some(data) = body.get("data").or_else(|| body.get("input")).and_then(Value::as_str) else {
        return HttpResponse::error(400, "missing_input", "Field 'data' is required.");
    };
    match state.terminals.write_input(pty_id, data.as_bytes().to_vec()).await {
        Ok(()) => HttpResponse::ok(json!({ "ok": true, "ptyId": pty_id, "bytes": data.len() })),
        Err(e) => HttpResponse::error(404, "terminal_input_failed", &e),
    }
}

fn handle_terminal_kill(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(pty_id) = non_empty_str(&body, &["ptyId", "id"]) else {
        return HttpResponse::error(400, "missing_pty_id", "Field 'ptyId' is required.");
    };
    match state.terminals.kill(pty_id) {
        Ok(killed) => {
            if killed {
                state.event_feed.publish(
                    "pty",
                    "pty_killed",
                    Some(pty_id),
                    json!({ "ptyId": pty_id }),
                );
            }
            HttpResponse::ok(json!({ "ok": true, "ptyId": pty_id, "killed": killed }))
        }
        Err(e) => HttpResponse::error(500, "terminal_kill_failed", &e),
    }
}

fn handle_terminal_scrollback(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let Some(pty_id) = query_param_val(req, "ptyId").or_else(|| query_param_val(req, "id")) else {
        return HttpResponse::error(400, "missing_pty_id", "Query param 'ptyId' is required.");
    };
    let max_bytes = query_param_val(req, "maxBytes")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(65_536);
    match state.terminals.read_scrollback(&pty_id, max_bytes) {
        Ok(output) => HttpResponse::ok(json!({ "ok": true, "ptyId": pty_id, "output": output })),
        Err(e) => HttpResponse::error(404, "terminal_not_found", &e),
    }
}

// =========================================================================
// 5. Isolated Browser CDP (Thorium & live profiles strictly blocked)
// =========================================================================

async fn handle_browser_launch(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if let Some(bin) = non_empty_str(&body, &["executablePath", "browserPath"]) {
        if is_forbidden_live_browser_path(Path::new(bin)) {
            return HttpResponse::error(
                403,
                "forbidden_live_browser",
                "Refusing live Thorium or default user browser profile.",
            );
        }
    }
    if let Some(profile) = non_empty_str(&body, &["userDataDir", "profileDir"]) {
        if is_forbidden_live_browser_path(Path::new(profile)) {
            return HttpResponse::error(
                403,
                "forbidden_live_browser",
                "Refusing live Thorium or default user profile directory.",
            );
        }
    }

    let opts = IsolatedBrowserLaunchOptions {
        browser_bin: non_empty_str(&body, &["executablePath", "browserPath"])
            .map(ToString::to_string),
        initial_url: non_empty_str(&body, &["url", "startUrl"]).map(ToString::to_string),
        headless: body.get("headless").and_then(Value::as_bool).unwrap_or(true),
        temp_root: non_empty_str(&body, &["userDataDir", "profileDir"]).map(PathBuf::from),
        ..Default::default()
    };

    match launch_isolated_browser(opts).await {
        Ok(handle) => {
            let ws_url = handle.ws_browser_url.clone();
            let cdp_session = match CdpSession::connect(&ws_url).await {
                Ok(sess) => {
                    let _ = sess.inject_virtual_cursor_overlay().await;
                    Some(sess)
                }
                Err(_) => None,
            };
            let mut guard = state.browser.lock().await;
            let status_json = json!({
                "ok": true,
                "isolated": true,
                "pid": handle.pid,
                "wsUrl": ws_url,
                "httpUrl": handle.http_url,
                "profileDir": handle.user_data_dir.to_string_lossy(),
                "cdpConnected": cdp_session.is_some(),
            });
            guard.ws_url = Some(handle.ws_browser_url.clone());
            guard.handle = Some(handle);
            guard.session = cdp_session;
            state
                .event_feed
                .publish("browser", "browser_launched", None, status_json.clone());
            HttpResponse::ok(status_json)
        }
        Err(e) => HttpResponse::error(403, "isolated_browser_launch_failed", &e.to_string()),
    }
}

async fn handle_browser_status(state: &Arc<StudioState>) -> HttpResponse {
    let guard = state.browser.lock().await;
    let running = guard.handle.is_some() && guard.session.is_some();
    HttpResponse::ok(json!({
        "ok": true,
        "running": running,
        "isolated": true,
        "wsUrl": guard.ws_url,
        "lastUrl": guard.last_url,
        "pid": guard.handle.as_ref().map(|h| h.pid),
    }))
}

async fn handle_browser_navigate(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(url) = non_empty_str(&body, &["url"]) else {
        return HttpResponse::error(400, "missing_url", "Field 'url' is required.");
    };
    let mut guard = state.browser.lock().await;
    let Some(sess) = guard.session.clone() else {
        return HttpResponse::error(409, "browser_not_running", "Launch isolated browser first.");
    };
    match sess.navigate(url).await {
        Ok(nav) => {
            let _ = sess.inject_virtual_cursor_overlay().await;
            guard.last_url = Some(url.to_string());
            state
                .event_feed
                .publish("browser", "browser_navigated", None, json!({ "url": url, "nav": nav }));
            HttpResponse::ok(json!({ "ok": true, "url": url, "nav": nav }))
        }
        Err(e) => HttpResponse::error(500, "browser_navigate_failed", &e),
    }
}

async fn handle_browser_click(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let guard = state.browser.lock().await;
    let Some(sess) = guard.session.clone() else {
        return HttpResponse::error(409, "browser_not_running", "Launch isolated browser first.");
    };
    let outcome = if let Some(sel) = non_empty_str(&body, &["selector"]) {
        sess.click_selector(sel).await
    } else if let (Some(x), Some(y)) = (
        body.get("x").and_then(Value::as_f64),
        body.get("y").and_then(Value::as_f64),
    ) {
        sess.click_at(x, y, None)
            .await
            .map(|res| json!({ "x": x, "y": y, "click": res }))
    } else {
        return HttpResponse::error(400, "missing_target", "Provide 'selector' or ('x', 'y').");
    };
    match outcome {
        Ok(res) => HttpResponse::ok(json!({ "ok": true, "result": res })),
        Err(e) => HttpResponse::error(500, "browser_click_failed", &e),
    }
}

async fn handle_browser_type(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(text) = body.get("text").and_then(Value::as_str) else {
        return HttpResponse::error(400, "missing_text", "Field 'text' is required.");
    };
    let guard = state.browser.lock().await;
    let Some(sess) = guard.session.clone() else {
        return HttpResponse::error(409, "browser_not_running", "Launch isolated browser first.");
    };
    match sess.type_text(text).await {
        Ok(res) => HttpResponse::ok(json!({ "ok": true, "typedLen": text.len(), "result": res })),
        Err(e) => HttpResponse::error(500, "browser_type_failed", &e),
    }
}

async fn handle_browser_screenshot(state: &Arc<StudioState>) -> HttpResponse {
    let guard = state.browser.lock().await;
    let Some(sess) = guard.session.clone() else {
        return HttpResponse::error(409, "browser_not_running", "Launch isolated browser first.");
    };
    match sess.screenshot_png_base64().await {
        Ok(png_b64) => HttpResponse::ok(json!({
            "ok": true,
            "mimeType": "image/png",
            "pngBase64": png_b64,
            "sha256": sha256_hex(png_b64.as_bytes()),
        })),
        Err(e) => HttpResponse::error(500, "browser_screenshot_failed", &e),
    }
}

async fn handle_browser_snapshot(state: &Arc<StudioState>) -> HttpResponse {
    let guard = state.browser.lock().await;
    let Some(sess) = guard.session.clone() else {
        return HttpResponse::error(409, "browser_not_running", "Launch isolated browser first.");
    };
    match sess.snapshot_dom_summary().await {
        Ok(summary) => HttpResponse::ok(json!({ "ok": true, "snapshot": summary })),
        Err(e) => HttpResponse::error(500, "browser_snapshot_failed", &e),
    }
}

async fn handle_browser_close(state: &Arc<StudioState>) -> HttpResponse {
    let mut guard = state.browser.lock().await;
    if let Some(sess) = guard.session.take() {
        let _ = sess.close().await;
    }
    let had_handle = guard.handle.take().is_some();
    guard.ws_url = None;
    guard.last_url = None;
    state
        .event_feed
        .publish("browser", "browser_closed", None, json!({ "closed": had_handle }));
    HttpResponse::ok(json!({ "ok": true, "closed": had_handle }))
}

// =========================================================================
// 6. Extensions: MCP / Hooks / Recipes / Cordis / DAP
// =========================================================================

fn handle_mcp_list(state: &Arc<StudioState>) -> HttpResponse {
    HttpResponse::ok(json!({ "ok": true, "servers": state.mcp.list_servers() }))
}

async fn handle_mcp_connect(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let cfg: omnia_agent::mcp_client::McpServerConfig = match serde_json::from_value(body) {
        Ok(c) => c,
        Err(e) => return HttpResponse::error(400, "invalid_mcp_config", &e.to_string()),
    };
    match state.mcp.connect_server(cfg).await {
        Ok(st) => {
            state.event_feed.publish(
                "mcp",
                "mcp_server_connected",
                None,
                serde_json::to_value(&st).unwrap_or_else(|_| json!({})),
            );
            HttpResponse::ok(json!({ "ok": true, "server": st }))
        }
        Err(e) => HttpResponse::error(502, "mcp_connect_failed", &SecretRedactor::redact(&e.to_string())),
    }
}

async fn handle_mcp_disconnect(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(name) = non_empty_str(&body, &["name", "server"]) else {
        return HttpResponse::error(400, "missing_server_name", "Field 'name' is required.");
    };
    let removed = state.mcp.disconnect_server(name).await;
    HttpResponse::ok(json!({ "ok": true, "name": name, "disconnected": removed }))
}

fn handle_mcp_tools_search(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let query = query_param_val(req, "query").unwrap_or_default();
    let limit = query_param_val(req, "limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(20)
        .clamp(1, 100);
    let tools = state.mcp.search_tools(&query, limit);
    HttpResponse::ok(json!({ "ok": true, "query": query, "tools": tools }))
}

async fn handle_mcp_tools_call(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(target) = non_empty_str(&body, &["tool", "server", "name"]) else {
        return HttpResponse::error(400, "missing_tool_name", "Field 'tool' or 'server' is required.");
    };
    let explicit_tool = non_empty_str(&body, &["explicitTool"]);
    let args = body.get("arguments").cloned().unwrap_or_else(|| json!({}));
    match state.mcp.call_tool(target, explicit_tool, args).await {
        Ok(res) => HttpResponse::ok(json!({ "ok": true, "result": res })),
        Err(e) => HttpResponse::error(400, "mcp_tool_call_failed", &SecretRedactor::redact(&e.to_string())),
    }
}

async fn handle_mcp_tasks(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = serde_json::from_slice::<Value>(&req.body).unwrap_or_else(|_| json!({}));
    let server = query_param_val(req, "server")
        .or_else(|| non_empty_str(&body, &["server"]).map(ToString::to_string));
    let task_id = query_param_val(req, "taskId")
        .or_else(|| non_empty_str(&body, &["taskId"]).map(ToString::to_string));
    let (Some(srv), Some(tid)) = (server, task_id) else {
        return HttpResponse::error(400, "missing_task_params", "Provide 'server' and 'taskId'.");
    };
    let res = if non_empty_str(&body, &["action"]) == Some("cancel") {
        state.mcp.cancel_task(&srv, &tid).await
    } else {
        state.mcp.get_task(&srv, &tid).await
    };
    match res {
        Ok(st) => HttpResponse::ok(json!({ "ok": true, "task": st })),
        Err(e) => HttpResponse::error(400, "mcp_task_failed", &e.to_string()),
    }
}

fn handle_hooks_list(state: &Arc<StudioState>) -> HttpResponse {
    let events: Vec<&'static str> = HookEvent::ALL.iter().map(|e| e.as_str()).collect();
    HttpResponse::ok(json!({
        "ok": true,
        "events": events,
        "hooks": state.hooks.list(),
    }))
}

fn handle_hooks_register(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let spec: HookSpec = match serde_json::from_value(body) {
        Ok(s) => s,
        Err(e) => return HttpResponse::error(400, "invalid_hook_spec", &e.to_string()),
    };
    state.hooks.register_command(spec.clone());
    HttpResponse::ok(json!({ "ok": true, "hook": spec }))
}

fn handle_hooks_toggle(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(id) = non_empty_str(&body, &["id"]) else {
        return HttpResponse::error(400, "missing_hook_id", "Field 'id' is required.");
    };
    let enabled = body.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let updated = state.hooks.set_enabled(id, enabled);
    HttpResponse::ok(json!({ "ok": updated, "id": id, "enabled": enabled }))
}

fn handle_recipes_list(state: &Arc<StudioState>) -> HttpResponse {
    let recipes = discover_recipes(&state.config.workspace_root);
    HttpResponse::ok(json!({ "ok": true, "recipes": recipes }))
}

fn handle_recipes_render(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(title) = non_empty_str(&body, &["title", "name"]) else {
        return HttpResponse::error(400, "missing_recipe_title", "Field 'title' is required.");
    };
    let recipes = discover_recipes(&state.config.workspace_root);
    let Some(spec) = recipes.into_iter().find(|r| r.title == title) else {
        return HttpResponse::error(404, "recipe_not_found", "Recipe not found in workspace.");
    };
    let params: HashMap<String, String> = body
        .get("params")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    match validate_and_render_recipe(&spec, &params) {
        Ok(rendered) => HttpResponse::ok(json!({ "ok": true, "rendered": rendered })),
        Err(e) => HttpResponse::error(400, "recipe_render_failed", &e.to_string()),
    }
}

fn handle_cordis_list(state: &Arc<StudioState>) -> HttpResponse {
    let _ = state.cordis_plugins.discover(Some(&state.hooks));
    HttpResponse::ok(json!({ "ok": true, "plugins": state.cordis_plugins.list() }))
}

fn handle_cordis_create(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if body.get("manifest").is_some() {
        let manifest: DynamicPluginManifest = match serde_json::from_value(body["manifest"].clone()) {
            Ok(m) => m,
            Err(e) => return HttpResponse::error(400, "invalid_plugin_manifest", &e.to_string()),
        };
        let dir = state
            .config
            .workspace_root
            .join(".omnia")
            .join("plugins")
            .join(&manifest.id);
        return match state
            .cordis_plugins
            .register_manifest(manifest, dir, Some(&state.hooks))
        {
            Ok(p) => HttpResponse::ok(json!({ "ok": true, "plugin": p })),
            Err(e) => HttpResponse::error(400, "cordis_register_failed", &e.to_string()),
        };
    }

    let Some(id) = non_empty_str(&body, &["id"]) else {
        return HttpResponse::error(400, "missing_plugin_id", "Field 'id' is required.");
    };
    let name = non_empty_str(&body, &["name"]).unwrap_or(id);
    let desc = non_empty_str(&body, &["description"]).unwrap_or("");
    let tool: Option<DynamicPluginToolDef> = body
        .get("tool")
        .and_then(|t| serde_json::from_value(t.clone()).ok());
    let hook: Option<HookSpec> = body
        .get("hook")
        .and_then(|h| serde_json::from_value(h.clone()).ok());
    match state
        .cordis_plugins
        .create_scaffold(id, name, desc, tool, hook, Some(&state.hooks))
    {
        Ok(plugin) => HttpResponse::ok(json!({ "ok": true, "plugin": plugin })),
        Err(e) => HttpResponse::error(400, "cordis_create_failed", &e.to_string()),
    }
}

fn handle_cordis_toggle(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(id) = non_empty_str(&body, &["id"]) else {
        return HttpResponse::error(400, "missing_plugin_id", "Field 'id' is required.");
    };
    let enabled = body.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    match state
        .cordis_plugins
        .set_enabled(id, enabled, Some(&state.hooks))
    {
        Ok(p) => HttpResponse::ok(json!({ "ok": true, "plugin": p })),
        Err(e) => HttpResponse::error(400, "cordis_toggle_failed", &e.to_string()),
    }
}

fn handle_cordis_rollback(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(id) = non_empty_str(&body, &["id"]) else {
        return HttpResponse::error(400, "missing_plugin_id", "Field 'id' is required.");
    };
    match state.cordis_plugins.rollback(id, Some(&state.hooks)) {
        Ok(p) => HttpResponse::ok(json!({ "ok": true, "plugin": p })),
        Err(e) => HttpResponse::error(400, "cordis_rollback_failed", &e.to_string()),
    }
}

fn handle_dap_list(state: &Arc<StudioState>) -> HttpResponse {
    HttpResponse::ok(json!({ "ok": true, "sessions": state.dap.list_sessions() }))
}

async fn handle_dap_launch(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let launch_req: omnia_agent::dap::DapLaunchRequest = match serde_json::from_value(body) {
        Ok(r) => r,
        Err(e) => return HttpResponse::error(400, "invalid_dap_launch", &e.to_string()),
    };
    match state.dap.launch(launch_req).await {
        Ok(sum) => HttpResponse::ok(json!({ "ok": true, "session": sum })),
        Err(e) => HttpResponse::error(400, "dap_launch_failed", &e.to_string()),
    }
}

async fn handle_dap_terminate(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(id) = non_empty_str(&body, &["sessionId", "id"]) else {
        return HttpResponse::error(400, "missing_session_id", "Field 'sessionId' is required.");
    };
    let stopped = state.dap.terminate(id).await;
    HttpResponse::ok(json!({ "ok": true, "sessionId": id, "terminated": stopped }))
}

// =========================================================================
// 7. Memory Engine & `omp-omni` KB / Pastes / Kanban / Inbox / Routines
// =========================================================================

fn handle_memory_retain(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(key) = non_empty_str(&body, &["key"]) else {
        return HttpResponse::error(400, "missing_key", "Field 'key' is required.");
    };
    let Some(content) = non_empty_str(&body, &["content", "value", "text"]) else {
        return HttpResponse::error(400, "missing_content", "Field 'content' is required.");
    };
    let bank_id = non_empty_str(&body, &["bankId"]).unwrap_or("studio");
    let tags: Vec<String> = body
        .get("tags")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(ToString::to_string).collect())
        .unwrap_or_default();
    let links: Vec<String> = body
        .get("links")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(ToString::to_string).collect())
        .unwrap_or_default();
    let input = RetainItemInput {
        namespace_path: non_empty_str(&body, &["namespace"])
            .unwrap_or("studio/notes")
            .to_string(),
        key: key.to_string(),
        content: content.to_string(),
        context: non_empty_str(&body, &["contextNote", "context"]).map(ToString::to_string),
        tier: MemoryTier::Durable,
        kind: MemoryKind::WorldFact,
        scope: MemoryScope::Project,
        provenance: MemoryProvenance::VerifiedUser,
        importance_bps: body
            .get("importanceBps")
            .and_then(Value::as_u64)
            .unwrap_or(7500) as u32,
        tags,
        links,
        now_ms: Some(now_epoch_ms()),
    };
    match state.memory_engine.retain(bank_id, input) {
        Ok(rec) => HttpResponse::ok(json!({ "ok": true, "record": rec, "key": key })),
        Err(e) => HttpResponse::error(400, "memory_retain_failed", &e.to_string()),
    }
}

fn handle_memory_recall(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = serde_json::from_slice::<Value>(&req.body).unwrap_or_else(|_| json!({}));
    let query_text = query_param_val(req, "query")
        .or_else(|| non_empty_str(&body, &["query"]).map(ToString::to_string))
        .unwrap_or_default();
    let limit = query_param_val(req, "limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(12);
    let query = RecallQuery {
        query: query_text,
        bank_id: Some(non_empty_str(&body, &["bankId"]).unwrap_or("studio").to_string()),
        scope_project_tag: non_empty_str(&body, &["projectTag"]).map(ToString::to_string),
        as_of_ms: None,
        include_tainted: false,
        include_cross_sessions: true,
        max_results: limit,
        max_chars: 4_000,
    };
    match state.memory_engine.recall(&query) {
        Ok(res) => HttpResponse::ok(json!({ "ok": true, "recall": res })),
        Err(e) => HttpResponse::error(500, "memory_recall_failed", &e.to_string()),
    }
}

fn handle_memory_reflect(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = serde_json::from_slice::<Value>(&req.body).unwrap_or_else(|_| json!({}));
    let bank = non_empty_str(&body, &["bankId"]).unwrap_or("studio");
    let topic = non_empty_str(&body, &["topic", "query"]).unwrap_or("");
    match state.memory_engine.reflect(bank, topic, None) {
        Ok(res) => HttpResponse::ok(json!({ "ok": true, "reflect": res })),
        Err(e) => HttpResponse::error(500, "memory_reflect_failed", &e.to_string()),
    }
}

fn handle_kb_search(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let q = query_param_val(req, "query");
    match state.ops.search_kb_notes(q.as_deref()) {
        Ok(notes) => HttpResponse::ok(json!({ "ok": true, "notes": notes })),
        Err(e) => HttpResponse::error(500, "kb_search_failed", &e),
    }
}

fn handle_kb_upsert(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(title) = non_empty_str(&body, &["title"]) else {
        return HttpResponse::error(400, "missing_title", "Field 'title' is required.");
    };
    let content = body.get("content").and_then(Value::as_str).unwrap_or("");
    let slug = non_empty_str(&body, &["slug", "id"])
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            let cleaned: String = title
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() {
                        c.to_ascii_lowercase()
                    } else {
                        '-'
                    }
                })
                .collect();
            let trimmed = cleaned.trim_matches('-').to_string();
            if trimmed.is_empty() {
                format!("note-{}", uuid_v4())
            } else {
                trimmed
            }
        });
    let tags: Vec<String> = body
        .get("tags")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(ToString::to_string).collect())
        .unwrap_or_default();
    match state.ops.upsert_kb_note(&slug, title, content, &tags) {
        Ok(note) => HttpResponse::ok(json!({ "ok": true, "note": note })),
        Err(e) => HttpResponse::error(400, "kb_upsert_failed", &e),
    }
}

fn handle_pastes_list(state: &Arc<StudioState>) -> HttpResponse {
    match state.ops.list_pastes() {
        Ok(pastes) => HttpResponse::ok(json!({ "ok": true, "pastes": pastes })),
        Err(e) => HttpResponse::error(500, "pastes_list_failed", &e),
    }
}

fn handle_pastes_create(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(content) = body.get("content").and_then(Value::as_str) else {
        return HttpResponse::error(400, "missing_content", "Field 'content' is required.");
    };
    let title = non_empty_str(&body, &["title"]).unwrap_or("Snippet");
    let lang = non_empty_str(&body, &["language", "lang"]).unwrap_or("text");
    match state.ops.create_paste(title, lang, content) {
        Ok(paste) => HttpResponse::ok(json!({ "ok": true, "paste": paste })),
        Err(e) => HttpResponse::error(400, "paste_create_failed", &e),
    }
}

fn handle_pastes_get(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let Some(id) = query_param_val(req, "id").or_else(|| query_param_val(req, "pasteId")) else {
        return HttpResponse::error(400, "missing_id", "Query param 'id' is required.");
    };
    match state.ops.get_paste(&id) {
        Ok(Some(p)) => HttpResponse::ok(json!({ "ok": true, "paste": p })),
        Ok(None) => HttpResponse::error(404, "paste_not_found", "Paste not found."),
        Err(e) => HttpResponse::error(500, "paste_get_failed", &e),
    }
}

fn handle_kanban_list(state: &Arc<StudioState>) -> HttpResponse {
    match state.ops.list_kanban_tasks() {
        Ok(tasks) => HttpResponse::ok(json!({ "ok": true, "tasks": tasks })),
        Err(e) => HttpResponse::error(500, "kanban_list_failed", &e),
    }
}

fn handle_kanban_create(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(title) = non_empty_str(&body, &["title"]) else {
        return HttpResponse::error(400, "missing_title", "Field 'title' is required.");
    };
    let desc = body.get("description").and_then(Value::as_str).unwrap_or("");
    let status = non_empty_str(&body, &["status"]).unwrap_or("todo");
    let priority = match body.get("priority") {
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_ascii_lowercase(),
        Some(Value::Number(n)) => match n.as_i64().unwrap_or(2) {
            ..=1 => "high".to_string(),
            2 => "medium".to_string(),
            _ => "low".to_string(),
        },
        _ => "medium".to_string(),
    };
    let tags: Vec<String> = body
        .get("tags")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(ToString::to_string).collect())
        .unwrap_or_default();
    let session_id = non_empty_str(&body, &["sessionId"]);
    match state
        .ops
        .create_kanban_task(title, desc, status, &priority, &tags, session_id)
    {
        Ok(task) => HttpResponse::ok(json!({ "ok": true, "task": task })),
        Err(e) => HttpResponse::error(400, "kanban_create_failed", &e),
    }
}

fn handle_kanban_status(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(id) = non_empty_str(&body, &["id", "taskId"]) else {
        return HttpResponse::error(400, "missing_task_id", "Field 'id' is required.");
    };
    let Some(status) = non_empty_str(&body, &["status"]) else {
        return HttpResponse::error(400, "missing_status", "Field 'status' is required.");
    };
    match state.ops.update_kanban_status(id, status) {
        Ok(updated) => HttpResponse::ok(json!({ "ok": updated, "id": id, "status": status })),
        Err(e) => HttpResponse::error(400, "kanban_status_failed", &e),
    }
}

fn handle_inbox_list(state: &Arc<StudioState>) -> HttpResponse {
    match state.ops.list_inbox_items() {
        Ok(items) => HttpResponse::ok(json!({ "ok": true, "items": items })),
        Err(e) => HttpResponse::error(500, "inbox_list_failed", &e),
    }
}

fn handle_inbox_add(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(content) = non_empty_str(&body, &["content", "title", "text"]) else {
        return HttpResponse::error(400, "missing_content", "Field 'content' is required.");
    };
    let source = non_empty_str(&body, &["source"]).unwrap_or("studio");
    match state.ops.add_inbox_item(content, source) {
        Ok(item) => HttpResponse::ok(json!({ "ok": true, "item": item })),
        Err(e) => HttpResponse::error(400, "inbox_add_failed", &e),
    }
}

fn handle_routines_list(state: &Arc<StudioState>) -> HttpResponse {
    match state.ops.list_routines() {
        Ok(routines) => HttpResponse::ok(json!({ "ok": true, "routines": routines })),
        Err(e) => HttpResponse::error(500, "routines_list_failed", &e),
    }
}

fn handle_routines_upsert(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(name) = non_empty_str(&body, &["name"]) else {
        return HttpResponse::error(400, "missing_name", "Field 'name' is required.");
    };
    let cron_expr = non_empty_str(&body, &["cronExpr", "cron", "scheduleExpr"]).unwrap_or("0 * * * *");
    let Some(prompt) = non_empty_str(&body, &["prompt"]) else {
        return HttpResponse::error(400, "missing_prompt", "Field 'prompt' is required.");
    };
    let workspace_path = state.config.workspace_root.to_string_lossy().to_string();
    let isolation_mode = non_empty_str(&body, &["isolationMode", "isolation"]).unwrap_or("worktree");
    let model_spec = non_empty_str(&body, &["modelSpec", "model"]);
    match state.ops.upsert_routine(
        name,
        prompt,
        &workspace_path,
        cron_expr,
        isolation_mode,
        model_spec,
    ) {
        Ok(routine) => HttpResponse::ok(json!({ "ok": true, "routine": routine })),
        Err(e) => HttpResponse::error(400, "routine_upsert_failed", &e),
    }
}

// =========================================================================
// 8. Telemetry, Traces, Scoreboard
// =========================================================================

fn handle_stats_overview(state: &Arc<StudioState>) -> HttpResponse {
    match state.ops.stats_snapshot() {
        Ok(snap) => {
            let unique_blobs = state.sessions.unique_blob_count().unwrap_or(0);
            HttpResponse::ok(json!({
                "ok": true,
                "stats": snap,
                "uniqueAttachmentBlobs": unique_blobs,
            }))
        }
        Err(e) => HttpResponse::error(500, "stats_failed", &e),
    }
}

fn handle_traces_list(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let limit = query_param_val(req, "limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(50);
    match state.ops.list_traces(limit) {
        Ok(traces) => HttpResponse::ok(json!({ "ok": true, "traces": traces })),
        Err(e) => HttpResponse::error(500, "traces_list_failed", &e),
    }
}

fn handle_benchmarks_scoreboard(state: &Arc<StudioState>) -> HttpResponse {
    HttpResponse::ok(build_benchmark_scoreboard(
        &state.config.workspace_root,
        &state.ops,
    ))
}

// =========================================================================
// Internal Helpers
// =========================================================================

fn build_harness_sink(state: Arc<StudioState>, session_id: String) -> Arc<dyn Fn(Value) + Send + Sync> {
    Arc::new(move |ev: Value| {
        let kind = ev
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("harness_event")
            .to_string();
        state
            .event_feed
            .publish("agent", &kind, Some(&session_id), ev.clone());

        if kind == "prompt_result" {
            if let Some(msg) = ev.get("assistantText").and_then(Value::as_str) {
                let _ = state.sessions.append_message(
                    &session_id,
                    "assistant",
                    msg,
                    &ev.to_string(),
                    now_epoch_ms(),
                );
            }
            let _ = state.ops.record_trace(&UsageTraceInput {
                session_id: session_id.clone(),
                provider_id: ev
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or("omnia-agent")
                    .to_string(),
                model_id: ev
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or("auto")
                    .to_string(),
                surface: "chat".to_string(),
                input_tokens: ev.get("inputTokens").and_then(Value::as_i64).unwrap_or(0),
                output_tokens: ev.get("outputTokens").and_then(Value::as_i64).unwrap_or(0),
                cache_read_tokens: ev.get("cacheReadTokens").and_then(Value::as_i64).unwrap_or(0),
                cache_write_tokens: ev.get("cacheWriteTokens").and_then(Value::as_i64).unwrap_or(0),
                cost_usd: ev.get("totalCostUsd").and_then(Value::as_f64).unwrap_or(0.0),
                duration_ms: ev.get("durationMs").and_then(Value::as_i64).unwrap_or(0),
                ttft_ms: ev.get("ttftMs").and_then(Value::as_i64),
                tokens_per_second: ev.get("tokensPerSecond").and_then(Value::as_f64).unwrap_or(0.0),
                is_error: ev.get("error").is_some_and(|e| !e.is_null()),
                error_note: ev
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                saved_tokens: ev.get("savedTokens").and_then(Value::as_i64).unwrap_or(0),
            });
        }
    })
}

fn handle_graph_peers_register(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let mut registered_ids = Vec::new();
    let specs: Vec<Value> = if let Some(arr) = body.get("peers").and_then(Value::as_array) {
        arr.clone()
    } else {
        vec![body.clone()]
    };
    for item in specs {
        let Some(id) = non_empty_str(&item, &["id", "agentId"]) else {
            return HttpResponse::error(400, "missing_peer_id", "Peer 'id' is required.");
        };
        let role = match non_empty_str(&item, &["role"]).unwrap_or("worker").to_ascii_lowercase().as_str() {
            "coordinator" => AgentRole::Coordinator,
            "verifier" => AgentRole::Verifier,
            "specialist" => AgentRole::Specialist,
            _ => AgentRole::Worker,
        };
        let owned: Vec<String> = item
            .get("ownedPaths")
            .or_else(|| item.get("owned"))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(ToString::to_string).collect())
            .unwrap_or_default();
        let excluded: Vec<String> = item
            .get("excludedPaths")
            .or_else(|| item.get("excluded"))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(ToString::to_string).collect())
            .unwrap_or_default();
        if let Err(e) = state.peer_mesh.register_agent(id, role, owned, excluded) {
            return HttpResponse::error(400, "peer_register_failed", &e.to_string());
        }
        registered_ids.push(id.to_string());
    }
    if registered_ids.len() >= 2 {
        let refs: Vec<&str> = registered_ids.iter().map(String::as_str).collect();
        let _ = state.peer_mesh.connect_all_to_all(&refs, "duplex-mesh");
    }
    let all_peers = state.peer_mesh.agents().unwrap_or_default();
    if all_peers.len() >= 2 && registered_ids.len() == 1 {
        let all_ids: Vec<String> = all_peers.iter().map(|p| p.id.clone()).collect();
        let refs: Vec<&str> = all_ids.iter().map(String::as_str).collect();
        let _ = state.peer_mesh.connect_all_to_all(&refs, "duplex-mesh");
    }
    state.event_feed.publish(
        "swarm",
        "peers_updated",
        None,
        json!({ "peerCount": all_peers.len(), "registered": registered_ids }),
    );
    HttpResponse::ok(json!({
        "ok": true,
        "registered": registered_ids,
        "peerCount": all_peers.len(),
    }))
}

fn handle_router_candidate_upsert(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let body = match parse_json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(candidate_id) = non_empty_str(&body, &["candidateId", "id"]) else {
        return HttpResponse::error(400, "missing_candidate_id", "Field 'candidateId' is required.");
    };
    let provider_id = non_empty_str(&body, &["providerId", "provider"]).unwrap_or("custom");
    let model_id = non_empty_str(&body, &["modelId", "model"]).unwrap_or("default");
    let privacy = match non_empty_str(&body, &["privacyTier"]).unwrap_or("public").to_ascii_lowercase().as_str() {
        "local_only" | "localonly" => PrivacyTier::LocalOnly,
        "zero_data_retention" | "zdr" => PrivacyTier::ZeroDataRetention,
        _ => PrivacyTier::Public,
    };
    let mut caps = ModelCapabilities::standard_candidate();
    caps.supports_vision = body.get("supportsVision").and_then(Value::as_bool).unwrap_or(false);
    let cand = RouteCandidate {
        candidate_id: candidate_id.to_string(),
        provider_id: provider_id.to_string(),
        model_id: model_id.to_string(),
        auth_boundary: "default".to_string(),
        region: non_empty_str(&body, &["region"]).unwrap_or("local").to_string(),
        privacy_tier: privacy,
        capabilities: caps,
        context_limit_tokens: body.get("contextLimitTokens").and_then(Value::as_u64).unwrap_or(128_000),
        max_output_tokens: body.get("maxOutputTokens").and_then(Value::as_u64).unwrap_or(16_384),
        quality_tier: body.get("qualityTier").and_then(Value::as_i64).unwrap_or(3) as i32,
        pricing_version: "configured".to_string(),
        input_cost_per_million_microunits: body.get("inputCostPerMillion").and_then(Value::as_i64),
        output_cost_per_million_microunits: body.get("outputCostPerMillion").and_then(Value::as_i64),
        credential_present: body.get("credentialPresent").and_then(Value::as_bool).unwrap_or(true),
        enabled: body.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        route_priority: body.get("routePriority").and_then(Value::as_i64).unwrap_or(10) as i32,
        supported_roles: Vec::new(),
    };
    let rs = CandidateResourceState {
        quota: QuotaState::default(),
        circuit: CircuitState::Closed,
        ..CandidateResourceState::default()
    };
    if let Err(e) = state.router.upsert_candidate(cand, rs) {
        return HttpResponse::error(400, "candidate_upsert_failed", &e.to_string());
    }
    state.event_feed.publish(
        "router",
        "candidate_upserted",
        None,
        json!({ "candidateId": candidate_id }),
    );
    HttpResponse::ok(json!({ "ok": true, "candidateId": candidate_id }))
}

fn resolve_role_override(
    ops: &OpsStore,
    role: &str,
) -> (Option<String>, Option<String>, Option<String>) {
    let roles = ops.list_model_roles().unwrap_or_default();
    if let Some(found) = roles.into_iter().find(|r| r.scope.eq_ignore_ascii_case(role)) {
        return (
            Some(found.provider_id),
            Some(found.model_id),
            Some(found.effort),
        );
    }
    (None, None, None)
}

fn resolve_managed_session_key(state: &StudioState, body: &Value) -> Option<String> {
    if let Some(sk) = non_empty_str(body, &["sessionKey"]) {
        if state.harness.owns_session(sk) {
            return Some(sk.to_string());
        }
    }
    let sid = non_empty_str(body, &["sessionId", "tabId"])?;
    state
        .harness
        .list_running()
        .into_iter()
        .find(|s| s.tab_id == sid || s.session_key == sid)
        .map(|s| s.session_key)
}

fn parse_backend_id(raw: Option<&str>) -> HarnessBackendId {
    match raw.map(str::trim).unwrap_or("omni-super").to_ascii_lowercase().as_str() {
        "claude-acp" => HarnessBackendId::ClaudeAcp,
        "codex-acp" => HarnessBackendId::CodexAcp,
        "goose-acp" => HarnessBackendId::GooseAcp,
        "agy-acp" => HarnessBackendId::AgyAcp,
        "omp-rpc" | "omp-acp" => HarnessBackendId::OmpRpc,
        _ => HarnessBackendId::OmniSuper,
    }
}

fn parse_approval_mode(raw: Option<&str>) -> ApprovalMode {
    match raw.map(str::trim).unwrap_or("ask").to_ascii_lowercase().as_str() {
        "plan" | "read-only" | "readonly" | "chat" => ApprovalMode::Plan,
        "yolo" | "auto-yolo" | "solo" => ApprovalMode::Yolo,
        "write" | "auto-workspace" | "workspace" => ApprovalMode::Write,
        "cached" | "always-ask-cached" => ApprovalMode::AlwaysAskCached,
        _ => ApprovalMode::AlwaysAsk,
    }
}

fn parse_wire_api(raw: Option<&str>) -> WireApiMode {
    match raw.map(str::trim).unwrap_or("auto").to_ascii_lowercase().as_str() {
        "chat" | "openai-completions" => WireApiMode::Chat,
        "responses" => WireApiMode::Responses,
        "responses-ws" | "responses_ws" | "ws" => WireApiMode::ResponsesWs,
        "messages" | "anthropic" => WireApiMode::Messages,
        "gemini" => WireApiMode::Gemini,
        _ => WireApiMode::Auto,
    }
}

fn is_provider_config_error(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("api key")
        || lower.contains("provider")
        || lower.contains("models.yml")
        || lower.contains("unconfigured")
        || lower.contains("credential")
}
