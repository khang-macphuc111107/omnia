//! Steer #27B Omnia Studio Executable `/super-plan` & `/super-run` Workflow Routes
//! and Unified 18-Crate Capability Registry (`/api/v5/super/*`).
//!
//! Invariants enforced:
//! - Lossless `serde_json::Map` merge on `.agents/super/engine_state.json` (with
//!   read fallback from `.agents/super/state.json`) so `omnia-harness`, `omnia-cli`,
//!   `omnia-studio`, and `agy-fast` never clobber sibling fields.
//! - Zero-Nerf (`Z-01..Z-11`): `ApprovalMode::Yolo` default, `tokenBudget: null`,
//!   `EgressPolicy` unrestricted, `EffortLevel::Max`, `ADDITIVE_INTAKE` steers
//!   (never dropping unfinished queue items or capping budgets).
//! - Prefix-0 KV-cache invariance: dynamic capability/workflow directives append
//!   only to user prompt tail.
//! - Safe read-only MCP & plugin skill auto-discovery via dynamic `USERPROFILE` / `HOME`
//!   (never hardcoding usernames, skipping `google_credentials`, never reading `.pb`/cookies).

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use omnia_agent::git_forensics::run_git;
use omnia_agent::path_guard::ensure_within_workspace;
use omnia_agent::plugin::{builtin_deferred_semantic_tools, PluginRegistry};
use omnia_agent::{ApprovalMode, HarnessBackendId, ManagedSpawnRequest, WireApiMode};
use omnia_core::{now_epoch_ms, uuid_v4, SecretRedactor};
use omnia_harness::artifact_os::{
    append_proceed_decision_jsonl, merge_engine_state_lossless, read_engine_state_map,
    sync_global_lessons, validate_no_proto_pollution, ArtifactKind,
};
use omnia_harness::research_vault::atomic_write_with_retry;
use omnia_harness::steer_queue::{SteerItem, SteerMode};
use serde_json::{json, Map, Value};

use crate::http::{HttpRequest, HttpResponse};
use crate::routes_computer_v5::computer_status_summary;
use crate::routes_legacy::StudioState;
use crate::telemetry::is_reparse_or_symlink;

const WORKSPACE_CRATES: [&str; 18] = [
    "omnia-winsqlite",
    "omnia-core",
    "omnia-storage",
    "omnia-routing",
    "omnia-graph",
    "omnia-harness",
    "omnia-connector-gateway",
    "omnia-workspace-ops",
    "omnia-media-capture",
    "omnia-remote-control",
    "omnia-runtime",
    "omnia-studio",
    "omnia-native",
    "omnia-agent",
    "omnia-cli",
    "omnia-downloader",
    "omnia-notebook",
    "omnia-computer",
];

const WORKFLOW_MODES: [&str; 2] = ["/super-plan", "/super-run"];

const UNIFIED_LANES: [&str; 13] = [
    "swarm-32",
    "boost",
    "teamwork",
    "goal-persistence",
    "learn-3way",
    "auto-proceed",
    "deep-think",
    "deep-research",
    "computer-use",
    "browser-cdp",
    "atelier-notebook",
    "omnidrive-pro",
    "network-lab",
];

const DEFAULT_REQUIRED_AUDIT_STREAK: usize = 3;
const MAX_PLUGIN_SKILL_FILES: usize = 128;
const MAX_SKILL_SCAN_DEPTH: usize = 4;

/// Returns `true` when `path` belongs to the Steer #27B `/api/v5/super/*` surface.
#[must_use]
pub fn is_known_route(path: &str) -> bool {
    matches!(
        path,
        "/api/v5/super/status"
            | "/api/v5/super/capabilities"
            | "/api/v5/super/plan"
            | "/api/v5/super/run"
            | "/api/v5/super/cancel"
            | "/api/v5/super/proceed"
            | "/api/v5/super/record-audit"
            | "/api/v5/super/complete"
    )
}

/// Dispatches all `/api/v5/super/*` endpoints.
pub async fn dispatch(state: &Arc<StudioState>, req: &HttpRequest) -> Option<HttpResponse> {
    if !is_known_route(req.path.as_str()) {
        return None;
    }

    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/v5/super/status") => Some(handle_super_status(state)),
        ("GET", "/api/v5/super/capabilities") => Some(handle_super_capabilities(state)),
        ("POST", "/api/v5/super/plan") => Some(handle_super_plan(state, req).await),
        ("POST", "/api/v5/super/run") => Some(handle_super_run(state, req).await),
        ("POST", "/api/v5/super/cancel") => Some(handle_super_cancel(state, req)),
        ("GET", "/api/v5/super/proceed") => Some(handle_super_proceed_get(state)),
        ("POST", "/api/v5/super/proceed") => Some(handle_super_proceed_post(state, req)),
        ("POST", "/api/v5/super/record-audit") => Some(handle_super_record_audit(state, req)),
        ("POST", "/api/v5/super/complete") => Some(handle_super_complete(state, req)),
        _ => Some(HttpResponse::error(
            405,
            "method_not_allowed",
            "HTTP method not allowed for v5 super route.",
        )),
    }
}

fn parse_obj(req: &HttpRequest) -> Result<Map<String, Value>, HttpResponse> {
    if req.body.is_empty() {
        return Ok(Map::new());
    }
    let obj = req.json_object()?;
    if let Err(err) = validate_no_proto_pollution(&Value::Object(obj.clone())) {
        return Err(HttpResponse::error(400, "invalid_super_payload", &err));
    }
    Ok(obj)
}

fn str_field<'a>(obj: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| {
        obj.get(*k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    })
}

fn bool_field(obj: &Map<String, Value>, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|k| obj.get(*k).and_then(Value::as_bool))
}

fn str_vec_field(obj: &Map<String, Value>, keys: &[&str]) -> Vec<String> {
    for k in keys {
        if let Some(arr) = obj.get(*k).and_then(Value::as_array) {
            return arr
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string)
                .collect();
        }
        if let Some(single) = obj
            .get(*k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return vec![single.to_string()];
        }
    }
    Vec::new()
}

fn normalize_proceed_policy(raw: &str) -> Result<&'static str, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "off" | "false" | "0" | "disabled" | "no" => Ok("off"),
        "standard" | "recommended" | "recommended-only" | "safe" => Ok("standard"),
        "full" | "on" | "true" | "1" | "enabled" | "yes" | "auto" => Ok("full"),
        other => Err(format!(
            "invalid proceed policy `{other}` (expected: off | standard | full)"
        )),
    }
}

fn parse_backend(raw: Option<&str>) -> HarnessBackendId {
    match raw
        .map(str::trim)
        .unwrap_or("omni-super")
        .to_ascii_lowercase()
        .as_str()
    {
        "claude-acp" => HarnessBackendId::ClaudeAcp,
        "codex-acp" => HarnessBackendId::CodexAcp,
        "goose-acp" => HarnessBackendId::GooseAcp,
        "agy-acp" => HarnessBackendId::AgyAcp,
        "omp-rpc" | "omp-acp" => HarnessBackendId::OmpRpc,
        _ => HarnessBackendId::OmniSuper,
    }
}

fn parse_wire_api(raw: Option<&str>) -> WireApiMode {
    match raw
        .map(str::trim)
        .unwrap_or("auto")
        .to_ascii_lowercase()
        .as_str()
    {
        "chat" | "openai-completions" => WireApiMode::Chat,
        "responses" => WireApiMode::Responses,
        "responses-ws" | "responses_ws" | "ws" => WireApiMode::ResponsesWs,
        "messages" | "anthropic" => WireApiMode::Messages,
        "gemini" => WireApiMode::Gemini,
        _ => WireApiMode::Auto,
    }
}

fn parse_approval_mode(raw: Option<&str>) -> ApprovalMode {
    match raw
        .map(str::trim)
        .unwrap_or("yolo")
        .to_ascii_lowercase()
        .as_str()
    {
        "plan" | "read-only" | "readonly" => ApprovalMode::Plan,
        "write" | "auto-workspace" | "workspace" => ApprovalMode::Write,
        "always-ask" | "ask" => ApprovalMode::AlwaysAsk,
        "cached" | "always-ask-cached" => ApprovalMode::AlwaysAskCached,
        _ => ApprovalMode::Yolo,
    }
}

fn resolve_home_dir() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

fn normalize_engine_snapshot(state: &StudioState, raw: Map<String, Value>) -> Value {
    let mut engine = raw;
    let mode = engine
        .get("mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("idle")
        .to_string();
    let phase = engine
        .get("lifecyclePhase")
        .or_else(|| engine.get("phase"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(match mode.as_str() {
            "super_plan" => "planning",
            "super_run" => "executing",
            "complete" => "complete",
            "cancelled" => "cancelled",
            _ => "idle",
        })
        .to_string();
    let active = engine
        .get("active")
        .and_then(Value::as_bool)
        .unwrap_or(matches!(mode.as_str(), "super_plan" | "super_run"));
    let proceed_raw = engine
        .get("autoProceed")
        .and_then(Value::as_str)
        .unwrap_or_else(|| if mode == "super_run" { "full" } else { "off" });
    let auto_proceed = normalize_proceed_policy(proceed_raw).unwrap_or("off");
    let goal_persistence = engine
        .get("goalPersistence")
        .or_else(|| engine.get("stopHookPersistence"))
        .and_then(Value::as_bool)
        .unwrap_or(mode == "super_run" && active);
    let approval_mode = engine
        .get("approvalMode")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("yolo")
        .to_string();
    let active_goal = engine
        .get("activeGoal")
        .or_else(|| engine.get("goalSummary"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(SecretRedactor::redact);
    let audit_streak = engine
        .get("auditStreak")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let required_audit_streak = engine
        .get("requiredAuditStreak")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_REQUIRED_AUDIT_STREAK as u64)
        .max(1) as usize;
    let audit_rounds = engine
        .get("auditRounds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let waves = engine
        .get("waves")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tool_proof_counts = engine
        .get("toolProofCounts")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let run_id = engine.get("runId").cloned().unwrap_or(Value::Null);

    engine.insert("tokenBudget".to_string(), Value::Null);

    let super_state = state.artifact_os.super_state().unwrap_or_default();
    let steers: Vec<Value> = state.steer.items().iter().map(SteerItem::to_json).collect();
    let running_sessions = state.harness.list_running();

    json!({
        "ok": true,
        "state": "online",
        "mode": mode,
        "phase": phase,
        "lifecyclePhase": phase,
        "active": active,
        "runId": run_id,
        "autoProceed": auto_proceed,
        "autoProceedEnabled": auto_proceed != "off",
        "goalPersistence": goal_persistence,
        "approvalMode": approval_mode,
        "tokenBudget": Value::Null,
        "activeGoal": active_goal,
        "auditStreak": audit_streak,
        "requiredAuditStreak": required_audit_streak,
        "auditRounds": audit_rounds,
        "waves": waves,
        "toolProofCounts": tool_proof_counts,
        "openTodos": super_state.open_todos,
        "verifiedDodGates": super_state.verified_dod_gates,
        "totalDodGates": super_state.total_dod_gates,
        "steers": steers,
        "activeSteerBacklogCount": state.steer.active_backlog_count(),
        "runningSessions": running_sessions.len(),
        "superState": super_state,
        "engineStatePath": ".agents/super/engine_state.json",
        "engineState": Value::Object(engine),
    })
}

fn handle_super_status(state: &Arc<StudioState>) -> HttpResponse {
    let raw = read_engine_state_map(&state.config.workspace_root);
    HttpResponse::ok(normalize_engine_snapshot(state, raw))
}

/// Builds the full Unified 18-Crate Capability Registry JSON returned by
/// `GET /api/v5/super/capabilities` and embedded in `/super/{plan,run}` envelopes.
#[must_use]
pub fn build_unified_capabilities(state: &StudioState) -> Value {
    let registry = PluginRegistry::with_default_pillars();
    let core_and_pillar_tools = registry.active_tools_with_deferred(true, true);
    let deferred_semantic = builtin_deferred_semantic_tools();
    let cordis_tools = state.cordis_plugins.active_tools();

    let mut tool_map: BTreeMap<String, Value> = BTreeMap::new();
    for spec in core_and_pillar_tools {
        tool_map.insert(
            spec.name.clone(),
            json!({
                "name": spec.name,
                "description": spec.description,
                "readOnly": spec.read_only,
                "tier": "core_or_pillar",
            }),
        );
    }
    for spec in deferred_semantic {
        tool_map.insert(
            spec.name.clone(),
            json!({
                "name": spec.name,
                "description": spec.description,
                "readOnly": spec.read_only,
                "tier": "deferred_semantic",
            }),
        );
    }
    for (name, def) in cordis_tools {
        tool_map.insert(
            name.clone(),
            json!({
                "name": name,
                "description": def.description,
                "readOnly": def.read_only,
                "tier": "cordis_plugin",
            }),
        );
    }
    let agent_tools: Vec<Value> = tool_map.into_values().collect();
    let computer_summary = computer_status_summary();
    let computer_count = computer_summary
        .get("toolCount")
        .and_then(Value::as_u64)
        .unwrap_or(21) as usize;

    let ws_skills = state.skills.list_skills().unwrap_or_default();
    let vault_entries = state.skills.cold_vault_entries();
    let doctor = state.skills.doctor();
    let plugin_skills = discover_plugin_skills_metadata();
    let ws_skill_items: Vec<Value> = ws_skills
        .iter()
        .map(|s| {
            json!({
                "name": s.name,
                "category": s.category,
                "description": s.description,
                "has5PhaseHeaders": s.has_5phase_headers,
                "source": "workspace",
            })
        })
        .collect();
    let vault_sample: Vec<Value> = vault_entries
        .iter()
        .take(32)
        .map(|e| {
            json!({
                "slug": e.slug,
                "categoryId": e.category_id,
                "category": e.category,
                "focus": e.focus,
            })
        })
        .collect();

    let (discovered_mcp, skipped_auth_gated) =
        discover_mcp_configs_safe(&state.config.workspace_root);
    let connected_mcp = state.mcp.list_servers();
    let agy_fast_available = detect_agy_fast_available();

    let _ = state.cordis_plugins.discover(None);
    let cordis_list: Vec<Value> = state
        .cordis_plugins
        .list()
        .into_iter()
        .map(|p| {
            json!({
                "id": p.manifest.id,
                "name": p.manifest.name,
                "version": p.manifest.version,
                "status": p.status,
                "toolCount": p.manifest.tools.len(),
                "hookCount": p.manifest.hooks.len(),
            })
        })
        .collect();
    let harness_plugins = state.harness.list_plugins();
    let backends = state.harness.list_backends(None);

    let mut flat_mcp_servers: Vec<Value> = Vec::new();
    for srv in &connected_mcp {
        if let Ok(mut v) = serde_json::to_value(srv) {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("source".to_string(), json!("connected"));
            }
            flat_mcp_servers.push(v);
        }
    }
    for entry in &discovered_mcp {
        flat_mcp_servers.push(entry.clone());
    }
    flat_mcp_servers.push(json!({
        "name": "agy-fast",
        "transport": "stdio",
        "command": "agy-fast",
        "args": ["--mcp"],
        "available": agy_fast_available,
        "source": "local_plugin",
    }));

    let mut flat_plugins: Vec<Value> = Vec::new();
    for hp in &harness_plugins {
        if let Ok(mut v) = serde_json::to_value(hp) {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("kind".to_string(), json!("harness_pillar"));
            }
            flat_plugins.push(v);
        }
    }
    for cp in &cordis_list {
        let mut v = cp.clone();
        if let Some(obj) = v.as_object_mut() {
            obj.insert("kind".to_string(), json!("cordis_plugin"));
        }
        flat_plugins.push(v);
    }

    let total_skill_count = ws_skills.len() + vault_entries.len() + plugin_skills.len();

    json!({
        "ok": true,
        "state": "online",
        "crates": WORKSPACE_CRATES.len(),
        "crateCount": WORKSPACE_CRATES.len(),
        "detectedWorkspaceCrates": state.crate_count,
        "crateNames": WORKSPACE_CRATES,
        "agentTools": agent_tools.len(),
        "agentToolCount": agent_tools.len(),
        "agentToolSpecs": agent_tools,
        "computerTools": computer_count,
        "computerToolCount": computer_count,
        "computerToolSpecs": computer_summary.get("tools").cloned().unwrap_or_else(|| json!([])),
        "totalToolCount": agent_tools.len() + computer_count,
        "skills": {
            "totalCount": total_skill_count,
            "workspaceCount": ws_skills.len(),
            "workspace": ws_skill_items,
            "coldVaultCount": vault_entries.len(),
            "coldVaultCategories": 100,
            "coldVaultSample": vault_sample,
            "m2vEnabled": state.skills.has_m2v_engine(),
            "pluginSkillCount": plugin_skills.len(),
            "pluginSkills": plugin_skills,
            "doctor": doctor,
        },
        "mcpServers": flat_mcp_servers,
        "mcpSummary": {
            "connected": connected_mcp,
            "connectedCount": connected_mcp.len(),
            "discovered": discovered_mcp,
            "discoveredCount": discovered_mcp.len(),
            "skippedAuthGatedCount": skipped_auth_gated,
            "agyFastMcp": {
                "name": "agy-fast",
                "transport": "stdio",
                "command": "agy-fast",
                "args": ["--mcp"],
                "available": agy_fast_available,
            },
        },
        "plugins": flat_plugins,
        "pluginSummary": {
            "harness": harness_plugins,
            "cordis": cordis_list,
            "agyFastAvailable": agy_fast_available,
        },
        "agyFast": if agy_fast_available { "available" } else { "bridged" },
        "backends": backends,
        "workflows": WORKFLOW_MODES,
        "lanes": UNIFIED_LANES,
        "invariants": {
            "approvalMode": "yolo",
            "tokenBudget": Value::Null,
            "egress": "unrestricted",
            "effort": "max",
            "drmSupported": false,
            "maxConcurrentSubagents": 32,
            "additiveSteerIntake": true,
        },
    })
}

fn handle_super_capabilities(state: &Arc<StudioState>) -> HttpResponse {
    HttpResponse::ok(build_unified_capabilities(state))
}

fn parse_frontmatter_skill_summary(raw: &str, fallback_slug: &str) -> (String, String) {
    let cleaned = raw.strip_prefix('\u{FEFF}').unwrap_or(raw);
    let mut lines = cleaned.lines();
    let mut name = fallback_slug.to_string();
    let mut desc = String::new();
    if lines.next().is_some_and(|l| l.trim() == "---") {
        for line in lines.take(40) {
            let t = line.trim();
            if t == "---" {
                break;
            }
            if let Some(rest) = t.strip_prefix("name:") {
                let candidate = rest.trim().trim_matches('"').trim_matches('\'');
                if !candidate.is_empty() {
                    name = SecretRedactor::redact(candidate);
                }
            } else if let Some(rest) = t.strip_prefix("description:") {
                let candidate = rest.trim().trim_matches('"').trim_matches('\'');
                if !candidate.is_empty() {
                    desc = SecretRedactor::redact(candidate);
                }
            }
        }
    }
    if desc.is_empty() {
        desc = cleaned
            .lines()
            .find(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with("---") && !t.starts_with('#')
            })
            .map(SecretRedactor::redact)
            .unwrap_or_default();
    }
    (name, desc)
}

fn scan_skill_dir_bounded(
    dir: &Path,
    source_tag: &str,
    depth: usize,
    seen: &mut BTreeSet<String>,
    out: &mut Vec<Value>,
) {
    if depth > MAX_SKILL_SCAN_DEPTH || out.len() >= MAX_PLUGIN_SKILL_FILES || !dir.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_PLUGIN_SKILL_FILES {
            break;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if is_reparse_or_symlink(&meta) {
            continue;
        }
        let fname = entry.file_name().to_string_lossy().into_owned();
        if meta.is_dir() {
            if matches!(
                fname.to_ascii_lowercase().as_str(),
                "node_modules" | ".git" | "target" | "auth" | "cookies"
            ) {
                continue;
            }
            scan_skill_dir_bounded(&path, source_tag, depth + 1, seen, out);
        } else if meta.is_file()
            && fname.eq_ignore_ascii_case("SKILL.md")
            && meta.len() <= 256 * 1024
        {
            let slug = path
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "plugin-skill".to_string());
            let dedup_key = format!("{source_tag}:{slug}");
            if !seen.insert(dedup_key) {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(&path) {
                let (name, description) = parse_frontmatter_skill_summary(&raw, &slug);
                out.push(json!({
                    "name": name,
                    "slug": slug,
                    "description": description,
                    "source": source_tag,
                }));
            }
        }
    }
}

fn discover_plugin_skills_metadata() -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    let Some(home) = resolve_home_dir() else {
        return out;
    };
    let user_skills = home.join(".gemini").join("config").join("skills");
    scan_skill_dir_bounded(&user_skills, "user_config_skill", 0, &mut seen, &mut out);
    let user_plugins = home.join(".gemini").join("antigravity").join("plugins");
    scan_skill_dir_bounded(&user_plugins, "antigravity_plugin", 0, &mut seen, &mut out);
    out
}

fn detect_agy_fast_available() -> bool {
    let candidates = if cfg!(windows) {
        ["agy-fast.exe", "agy-fast"]
    } else {
        ["agy-fast", "agy-fast.exe"]
    };
    if let Some(path_os) = env::var_os("PATH") {
        for dir in env::split_paths(&path_os) {
            for bin in candidates {
                if dir.join(bin).is_file() {
                    return true;
                }
            }
        }
    }
    if let Some(home) = resolve_home_dir() {
        let plugins_dir = home.join(".gemini").join("antigravity").join("plugins");
        if find_binary_bounded(&plugins_dir, &candidates, 0) {
            return true;
        }
    }
    false
}

fn find_binary_bounded(dir: &Path, names: &[&str], depth: usize) -> bool {
    if depth > 3 || !dir.is_dir() {
        return false;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if is_reparse_or_symlink(&meta) {
            continue;
        }
        if meta.is_file() {
            let fname = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if names.iter().any(|n| fname == *n) {
                return true;
            }
        } else if meta.is_dir() && find_binary_bounded(&path, names, depth + 1) {
            return true;
        }
    }
    false
}

fn sanitize_mcp_server_entry(name: &str, cfg: &Value, source_label: &str) -> Result<Value, bool> {
    let Some(obj) = cfg.as_object() else {
        return Err(false);
    };
    if obj
        .get("authProviderType")
        .or_else(|| obj.get("auth_provider_type"))
        .and_then(Value::as_str)
        .is_some_and(|s| s.eq_ignore_ascii_case("google_credentials"))
    {
        return Err(true);
    }
    let enabled = !obj
        .get("disabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && obj.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let transport = if let Some(t) = obj.get("type").and_then(Value::as_str) {
        t.trim().to_ascii_lowercase()
    } else if obj.get("command").is_some() {
        "stdio".to_string()
    } else if obj.get("url").is_some() {
        "http".to_string()
    } else {
        "unknown".to_string()
    };
    let command = obj
        .get("command")
        .and_then(Value::as_str)
        .map(SecretRedactor::redact);
    let args: Vec<String> = obj
        .get("args")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(SecretRedactor::redact)
                .collect()
        })
        .unwrap_or_default();
    let url = obj
        .get("url")
        .and_then(Value::as_str)
        .map(SecretRedactor::redact);
    let env_keys: Vec<String> = obj
        .get("env")
        .and_then(Value::as_object)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();

    Ok(json!({
        "name": SecretRedactor::redact(name),
        "source": source_label,
        "transport": transport,
        "enabled": enabled,
        "command": command,
        "args": args,
        "url": url,
        "envKeys": env_keys,
    }))
}

fn discover_mcp_configs_safe(workspace: &Path) -> (Vec<Value>, usize) {
    let home = resolve_home_dir();
    discover_mcp_configs_safe_with_home(workspace, home.as_deref())
}

fn discover_mcp_configs_safe_with_home(
    workspace: &Path,
    home: Option<&Path>,
) -> (Vec<Value>, usize) {
    let mut sources: Vec<(PathBuf, &'static str)> = vec![
        (workspace.join(".mcp.json"), "workspace:.mcp.json"),
        (
            workspace.join(".omnia").join("mcp_config.json"),
            "workspace:.omnia/mcp_config.json",
        ),
    ];
    if let Some(home) = home {
        sources.push((
            home.join(".gemini").join("config").join("mcp_config.json"),
            "user:~/.gemini/config/mcp_config.json",
        ));
    }

    let mut discovered = Vec::new();
    let mut skipped_auth_gated = 0usize;
    let mut seen_names = BTreeSet::new();

    for (path, label) in sources {
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() || is_reparse_or_symlink(&meta) || meta.len() > 512 * 1024 {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) =
            serde_json::from_str::<Value>(raw.strip_prefix('\u{FEFF}').unwrap_or(&raw))
        else {
            continue;
        };
        if let Some(servers_obj) = parsed
            .get("mcpServers")
            .or_else(|| parsed.get("servers"))
            .and_then(Value::as_object)
        {
            for (srv_name, cfg) in servers_obj {
                match sanitize_mcp_server_entry(srv_name, cfg, label) {
                    Ok(entry) => {
                        if seen_names.insert(srv_name.to_string()) {
                            discovered.push(entry);
                        }
                    }
                    Err(true) => skipped_auth_gated += 1,
                    Err(false) => {}
                }
            }
        } else if let Some(servers_arr) = parsed.get("servers").and_then(Value::as_array) {
            for cfg in servers_arr {
                let srv_name = cfg
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unnamed-mcp");
                match sanitize_mcp_server_entry(srv_name, cfg, label) {
                    Ok(entry) => {
                        if seen_names.insert(srv_name.to_string()) {
                            discovered.push(entry);
                        }
                    }
                    Err(true) => skipped_auth_gated += 1,
                    Err(false) => {}
                }
            }
        }
    }

    (discovered, skipped_auth_gated)
}

fn ensure_super_artifacts(
    state: &StudioState,
    goal_title: &str,
    mode: &str,
    run_id: &str,
    sync_to_disk: bool,
) -> Vec<Value> {
    let clean_goal = if goal_title.trim().is_empty() {
        format!("Omnia {mode} workflow ({run_id})")
    } else {
        SecretRedactor::redact(goal_title.trim())
    };
    let slug_base = format!(
        "super-{}",
        clean_goal
            .chars()
            .take(36)
            .map(|c| if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            })
            .collect::<String>()
            .trim_matches('-')
    );
    let slug = if slug_base.len() <= 6 {
        format!("super-{run_id}")
    } else {
        slug_base
    };

    let kinds = [
        (ArtifactKind::Goal, "Super Goal", "active"),
        (ArtifactKind::Spec, "Super Specification", "active"),
        (
            ArtifactKind::Blueprint,
            "Super Architecture Blueprint",
            "active",
        ),
        (ArtifactKind::Plan, "Super Execution Plan", "active"),
        (ArtifactKind::Dod, "Super Definition of Done Gate", "open"),
    ];

    let mut summary = Vec::new();
    for (kind, label, default_status) in kinds {
        let existing = state
            .artifact_os
            .list_artifacts(Some(kind), None)
            .unwrap_or_default();
        if let Some(first) = existing.first() {
            summary.push(json!({
                "kind": kind.as_str(),
                "id": first.id,
                "status": first.status,
                "scaffolded": false,
            }));
            continue;
        }
        let body = format!(
            "## {label}\n\n- **Run ID**: `{run_id}`\n- **Workflow Mode**: `{mode}`\n- **Target**: {clean_goal}\n- **Token Budget**: `null`\n"
        );
        if let Ok(art) = state.artifact_os.upsert_artifact(
            kind,
            &slug,
            &clean_goal,
            default_status,
            "project",
            &body,
            json!({ "runId": run_id, "mode": mode, "tokenBudget": Value::Null }),
            None,
            sync_to_disk,
        ) {
            summary.push(json!({
                "kind": kind.as_str(),
                "id": art.id,
                "status": art.status,
                "scaffolded": true,
            }));
        }
    }

    let todos = state
        .artifact_os
        .list_artifacts(Some(ArtifactKind::Todo), None)
        .unwrap_or_default();
    if todos.is_empty() && !goal_title.trim().is_empty() {
        if let Ok(todo_art) = state.artifact_os.upsert_artifact(
            ArtifactKind::Todo,
            &format!("{slug}-task"),
            &clean_goal,
            "pending",
            "project",
            &format!("Execute `{mode}` deliverable for: {clean_goal}\n"),
            json!({ "runId": run_id, "mode": mode }),
            None,
            sync_to_disk,
        ) {
            summary.push(json!({
                "kind": ArtifactKind::Todo.as_str(),
                "id": todo_art.id,
                "status": todo_art.status,
                "scaffolded": true,
            }));
        }
    }

    summary
}

fn append_steer_queue_md_if_applicable(
    workspace: &Path,
    steer_text: &str,
    run_id: &str,
    force_create: bool,
) {
    let md_path = workspace
        .join("docs")
        .join("workspace")
        .join("STEER_QUEUE.md");
    if !md_path.exists() && !force_create {
        return;
    }
    let clean_text = SecretRedactor::redact(steer_text.trim()).replace(['\r', '\n'], " ");
    let mut existing = fs::read_to_string(&md_path)
        .unwrap_or_else(|_| "# Steer Queue (ADDITIVE_INTAKE, token_budget = NULL)\n\n".to_string())
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    if !existing.is_empty() && !existing.ends_with('\n') {
        existing.push('\n');
    }
    let ts = Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
    existing.push_str(&format!(
        "- [{ts}] (`{run_id}`, `ADDITIVE_INTAKE`, `token_budget: NULL`) {clean_text}\n"
    ));
    let _ = atomic_write_with_retry(&md_path, existing.as_bytes());
}

fn build_super_sink(
    state: Arc<StudioState>,
    session_id: String,
) -> Arc<dyn Fn(Value) + Send + Sync> {
    Arc::new(move |ev: Value| {
        let kind = ev
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("harness_event")
            .to_string();
        state
            .event_feed
            .publish("super", &kind, Some(&session_id), ev.clone());
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
        }
    })
}

struct SuperTurnSpec<'a> {
    mode: &'a str,
    auto_proceed: &'a str,
    goal_persistence: bool,
    approval_mode: ApprovalMode,
    prompt: Option<&'a str>,
}

async fn maybe_dispatch_live_super_turn(
    state: &Arc<StudioState>,
    obj: &Map<String, Value>,
    spec: SuperTurnSpec<'_>,
    capabilities: &Value,
) -> Result<Value, HttpResponse> {
    let explicit_dispatch = bool_field(obj, &["dispatch", "executeLive", "execute_live"]);
    let Some(raw_prompt) = spec.prompt.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(json!({
            "attempted": false,
            "dispatched": false,
            "status": "hydrated_no_prompt",
        }));
    };
    if explicit_dispatch == Some(false) {
        return Ok(json!({
            "attempted": false,
            "dispatched": false,
            "status": "hydrated_dispatch_skipped",
        }));
    }

    let clean_cwd = if let Some(cwd_rel) = str_field(obj, &["cwd"]) {
        match ensure_within_workspace(&state.config.workspace_root, cwd_rel) {
            Ok(p) => p,
            Err(e) => return Err(HttpResponse::error(403, "invalid_cwd", &e.to_string())),
        }
    } else {
        state.config.workspace_root.clone()
    };

    let session_id = str_field(obj, &["sessionId", "tabId", "conversationId"])
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("super_{}", uuid_v4()));

    let roles = state.ops.list_model_roles().unwrap_or_default();
    let main_role = roles
        .into_iter()
        .find(|r| r.scope.eq_ignore_ascii_case("main"));
    let provider = str_field(obj, &["provider", "providerId"])
        .map(ToString::to_string)
        .or_else(|| main_role.as_ref().map(|r| r.provider_id.clone()));
    let model_id = str_field(obj, &["model", "modelId"])
        .map(ToString::to_string)
        .or_else(|| main_role.as_ref().map(|r| r.model_id.clone()));
    let thinking_level = str_field(obj, &["thinking", "effort", "thinkingLevel"])
        .map(ToString::to_string)
        .or_else(|| main_role.as_ref().map(|r| r.effort.clone()));

    let crates_n = capabilities["crateCount"].as_u64().unwrap_or(18);
    let agent_tools_n = capabilities["agentToolCount"].as_u64().unwrap_or(0);
    let comp_tools_n = capabilities["computerToolCount"].as_u64().unwrap_or(21);
    let skills_n = capabilities["skills"]["totalCount"].as_u64().unwrap_or(0);

    let hydrated_prompt = format!(
        "{}\n\n<omnia_super_workflow mode=\"{}\" auto_proceed=\"{}\" goal_persistence=\"{}\" approval_mode=\"yolo\" token_budget=\"null\" crates=\"{}\" agent_tools=\"{}\" computer_tools=\"{}\" skills=\"{}\" />\n",
        SecretRedactor::redact(raw_prompt),
        spec.mode,
        spec.auto_proceed,
        spec.goal_persistence,
        crates_n,
        agent_tools_n,
        comp_tools_n,
        skills_n,
    );

    if state
        .sessions
        .get_session(&session_id)
        .ok()
        .flatten()
        .is_none()
    {
        let title: String = raw_prompt.chars().take(64).collect();
        let _ = state.sessions.upsert_session(
            &session_id,
            if title.is_empty() {
                "Super Workflow"
            } else {
                &title
            },
            model_id.as_deref().unwrap_or("auto"),
            thinking_level.as_deref().unwrap_or("max"),
            now_epoch_ms(),
        );
    }
    let _ = state.sessions.append_message(
        &session_id,
        "user",
        raw_prompt,
        &json!({ "mode": spec.mode, "autoProceed": spec.auto_proceed, "goalPersistence": spec.goal_persistence })
            .to_string(),
        now_epoch_ms(),
    );

    let requested_key = str_field(obj, &["sessionKey"]).map(ToString::to_string);
    let existing_key = match requested_key {
        Some(sk) if state.harness.owns_session(&sk) => Some(sk),
        _ => state
            .harness
            .list_running()
            .into_iter()
            .find(|s| s.tab_id == session_id)
            .map(|s| s.session_key),
    };

    let session_key = match existing_key {
        Some(sk) => sk,
        None => {
            let max_turns = obj
                .get("maxTurns")
                .and_then(Value::as_u64)
                .map(|n| n.clamp(1, 128) as u32)
                .unwrap_or(if spec.goal_persistence { 64 } else { 32 });
            let spawn_req = ManagedSpawnRequest {
                tab_id: session_id.clone(),
                cwd: clean_cwd,
                backend: parse_backend(str_field(obj, &["backend"])),
                approval_mode: spec.approval_mode,
                workspace_trusted: true,
                permission_rules: Vec::new(),
                provider,
                model_id,
                thinking_level,
                wire_api: parse_wire_api(str_field(obj, &["wireApi"])),
                config_dir: None,
                max_turns,
            };
            let sink = build_super_sink(Arc::clone(state), session_id.clone());
            match state.harness.spawn_session(spawn_req, sink).await {
                Ok((sk, _, _)) => sk,
                Err(err) => {
                    return Ok(json!({
                        "attempted": true,
                        "dispatched": false,
                        "sessionId": session_id,
                        "status": "standby_unconfigured",
                        "reason": SecretRedactor::redact(&err.to_string()),
                    }));
                }
            }
        }
    };

    match state
        .harness
        .send_prompt(&session_key, &hydrated_prompt)
        .await
    {
        Ok(ack) => Ok(json!({
            "attempted": true,
            "dispatched": true,
            "sessionId": session_id,
            "sessionKey": session_key,
            "status": "dispatched",
            "ack": ack,
        })),
        Err(err) => Ok(json!({
            "attempted": true,
            "dispatched": false,
            "sessionId": session_id,
            "sessionKey": session_key,
            "status": "dispatch_error",
            "reason": SecretRedactor::redact(&err.to_string()),
        })),
    }
}

async fn handle_super_plan(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };

    let prompt = str_field(&obj, &["prompt", "message", "text", "query"]);
    let goal = str_field(&obj, &["goal", "title", "goalSummary"]).or(prompt);
    let run_id = str_field(&obj, &["runId"])
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("splan-{}", &uuid_v4()[..12]));
    let sync_to_disk = bool_field(&obj, &["syncToDisk", "sync_to_disk"]).unwrap_or(false);
    let now_ms = now_epoch_ms();
    let approval = parse_approval_mode(str_field(&obj, &["approvalMode", "approval_mode"]));

    let mut patch = json!({
        "schema": "omnia.super-engine-state.v1",
        "active": true,
        "mode": "super_plan",
        "phase": "planning",
        "lifecyclePhase": "planning",
        "autoProceed": "off",
        "autoProceedEnabled": false,
        "goalPersistence": false,
        "stopHookPersistence": false,
        "askQuestionAllowed": true,
        "codingAllowed": true,
        "approvalMode": "yolo",
        "tokenBudget": Value::Null,
        "runId": run_id,
        "updatedAt": Utc::now().format("%Y-%m-%d %H:%M:%S +00:00").to_string(),
        "updatedEpoch": now_ms / 1000,
    });
    if let Some(g) = goal {
        let clean = SecretRedactor::redact(g);
        patch["activeGoal"] = Value::String(clean.clone());
        patch["goalSummary"] = Value::String(clean);
    }

    let merged = match merge_engine_state_lossless(&state.config.workspace_root, patch) {
        Ok(v) => v,
        Err(err) => return HttpResponse::error(500, "engine_state_merge_failed", &err),
    };
    let _ = state
        .artifact_os
        .update_super_state(json!({ "phase": "planning" }), false);

    let scaffolded = ensure_super_artifacts(
        state,
        goal.unwrap_or("Omnia /super-plan session"),
        "super_plan",
        &run_id,
        sync_to_disk,
    );
    let capabilities = build_unified_capabilities(state);
    let live_dispatch = match maybe_dispatch_live_super_turn(
        state,
        &obj,
        SuperTurnSpec {
            mode: "super_plan",
            auto_proceed: "off",
            goal_persistence: false,
            approval_mode: approval,
            prompt,
        },
        &capabilities,
    )
    .await
    {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    state.event_feed.publish(
        "super",
        "super_plan_activated",
        Some(&run_id),
        json!({
            "runId": run_id,
            "mode": "super_plan",
            "autoProceed": "off",
            "goalPersistence": false,
            "tokenBudget": Value::Null,
        }),
    );

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "runId": run_id,
        "workflow": "/super-plan",
        "mode": "super_plan",
        "phase": "planning",
        "autoProceed": "off",
        "autoProceedEnabled": false,
        "goalPersistence": false,
        "askQuestionAllowed": true,
        "codingAllowed": true,
        "approvalMode": "yolo",
        "tokenBudget": Value::Null,
        "activeGoal": merged.get("activeGoal").cloned().unwrap_or(Value::Null),
        "scaffoldedArtifacts": scaffolded,
        "liveDispatch": live_dispatch,
        "engineState": merged,
        "capabilities": capabilities,
    }))
}

async fn handle_super_run(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };

    let prior = read_engine_state_map(&state.config.workspace_root);
    let was_active_run = prior.get("active").and_then(Value::as_bool) == Some(true)
        && prior.get("mode").and_then(Value::as_str) == Some("super_run");

    let prompt = str_field(&obj, &["prompt", "message", "text", "query"]);
    let goal = str_field(&obj, &["goal", "title", "goalSummary"]).or(prompt);
    let run_id = str_field(&obj, &["runId"])
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("srun-{}", &uuid_v4()[..12]));
    let sync_to_disk = bool_field(&obj, &["syncToDisk", "sync_to_disk"]).unwrap_or(false);
    let now_ms = now_epoch_ms();

    let mut new_steers = str_vec_field(&obj, &["steers", "steer"]);
    let append_steer = bool_field(&obj, &["appendSteer", "append_steer"]).unwrap_or(false);
    if (append_steer || was_active_run) && prompt.is_some() {
        if let Some(p) = prompt {
            if !new_steers.iter().any(|s| s == p) {
                new_steers.push(p.to_string());
            }
        }
    }

    let mut recorded_steers = Vec::new();
    for steer_text in new_steers {
        let item = state
            .steer
            .enqueue(&steer_text, SteerMode::AdditiveIntake, Some(now_ms));
        let _ = state.ops.upsert_steer_item(
            &item.id,
            &item.text,
            item.mode.as_str(),
            item.status.as_str(),
            item.created_at_ms,
        );
        append_steer_queue_md_if_applicable(
            &state.config.workspace_root,
            &item.text,
            &run_id,
            sync_to_disk,
        );
        recorded_steers.push(item.to_json());
    }

    let mut patch = json!({
        "schema": "omnia.super-engine-state.v1",
        "active": true,
        "mode": "super_run",
        "phase": "executing",
        "lifecyclePhase": "executing",
        "autoProceed": "full",
        "autoProceedEnabled": true,
        "goalPersistence": true,
        "stopHookPersistence": true,
        "askQuestionAllowed": false,
        "codingAllowed": true,
        "approvalMode": "yolo",
        "tokenBudget": Value::Null,
        "runId": run_id,
        "activeLanes": UNIFIED_LANES,
        "updatedAt": Utc::now().format("%Y-%m-%d %H:%M:%S +00:00").to_string(),
        "updatedEpoch": now_ms / 1000,
    });
    if let Some(g) = goal {
        let clean = SecretRedactor::redact(g);
        patch["activeGoal"] = Value::String(clean.clone());
        patch["goalSummary"] = Value::String(clean);
    }

    let merged = match merge_engine_state_lossless(&state.config.workspace_root, patch) {
        Ok(v) => v,
        Err(err) => return HttpResponse::error(500, "engine_state_merge_failed", &err),
    };
    let _ = state
        .artifact_os
        .update_super_state(json!({ "phase": "executing" }), false);

    let scaffolded = ensure_super_artifacts(
        state,
        goal.unwrap_or("Omnia /super-run autonomous goal"),
        "super_run",
        &run_id,
        sync_to_disk,
    );
    let capabilities = build_unified_capabilities(state);
    let live_dispatch = match maybe_dispatch_live_super_turn(
        state,
        &obj,
        SuperTurnSpec {
            mode: "super_run",
            auto_proceed: "full",
            goal_persistence: true,
            approval_mode: ApprovalMode::Yolo,
            prompt,
        },
        &capabilities,
    )
    .await
    {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    state.event_feed.publish(
        "super",
        "super_run_activated",
        Some(&run_id),
        json!({
            "runId": run_id,
            "mode": "super_run",
            "autoProceed": "full",
            "goalPersistence": true,
            "approvalMode": "yolo",
            "tokenBudget": Value::Null,
            "recordedSteers": recorded_steers.len(),
        }),
    );

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "runId": run_id,
        "workflow": "/super-run",
        "mode": "super_run",
        "phase": "executing",
        "autoProceed": "full",
        "autoProceedEnabled": true,
        "goalPersistence": true,
        "approvalMode": "yolo",
        "tokenBudget": Value::Null,
        "activeGoal": merged.get("activeGoal").cloned().unwrap_or(Value::Null),
        "laneContract": {
            "lanes": UNIFIED_LANES,
            "maxConcurrentSubagents": 32,
            "additiveSteerIntake": true,
            "requiredAuditStreak": merged.get("requiredAuditStreak").and_then(Value::as_u64).unwrap_or(3),
            "prefixZeroInvariant": true,
        },
        "recordedSteers": recorded_steers,
        "steers": state.steer.items().iter().map(SteerItem::to_json).collect::<Vec<Value>>(),
        "scaffoldedArtifacts": scaffolded,
        "liveDispatch": live_dispatch,
        "engineState": merged,
        "capabilities": capabilities,
    }))
}

fn handle_super_cancel(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };

    let target_session = str_field(&obj, &["sessionKey", "sessionId", "tabId"]);
    let mut aborted_sessions = Vec::new();
    for running in state.harness.list_running() {
        let should_abort = target_session
            .map(|t| running.session_key == t || running.tab_id == t)
            .unwrap_or(true);
        if should_abort {
            state.harness.abort_session(&running.session_key);
            aborted_sessions.push(running.session_key);
        }
    }

    let reason = str_field(&obj, &["reason"]).unwrap_or("user_cancelled");
    let clean_reason = SecretRedactor::redact(reason);
    let now_ms = now_epoch_ms();
    let patch = json!({
        "active": false,
        "mode": "cancelled",
        "phase": "cancelled",
        "lifecyclePhase": "cancelled",
        "goalPersistence": false,
        "stopHookPersistence": false,
        "completeMarker": "GOAL_CANCELLED",
        "cancelReason": clean_reason,
        "tokenBudget": Value::Null,
        "updatedAt": Utc::now().format("%Y-%m-%d %H:%M:%S +00:00").to_string(),
        "updatedEpoch": now_ms / 1000,
    });

    let merged = match merge_engine_state_lossless(&state.config.workspace_root, patch) {
        Ok(v) => v,
        Err(err) => return HttpResponse::error(500, "engine_state_merge_failed", &err),
    };
    let _ = state
        .artifact_os
        .update_super_state(json!({ "phase": "cancelled" }), false);

    state.event_feed.publish(
        "super",
        "goal_cancelled",
        None,
        json!({
            "status": "cancelled",
            "marker": "<!-- GOAL_CANCELLED -->",
            "reason": clean_reason,
            "abortedSessions": aborted_sessions,
        }),
    );

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "status": "cancelled",
        "mode": "cancelled",
        "marker": "<!-- GOAL_CANCELLED -->",
        "goalPersistence": false,
        "abortedSessions": aborted_sessions,
        "tokenBudget": Value::Null,
        "engineState": merged,
    }))
}

fn read_recent_proceed_decisions(workspace: &Path) -> (usize, Vec<Value>) {
    let path = workspace
        .join(".agents")
        .join("super")
        .join("proceed-decisions.jsonl");
    let Ok(raw) = fs::read_to_string(&path) else {
        return (0, Vec::new());
    };
    let parsed: Vec<Value> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect();
    let total = parsed.len();
    let tail_start = total.saturating_sub(25);
    (total, parsed[tail_start..].to_vec())
}

fn handle_super_proceed_get(state: &Arc<StudioState>) -> HttpResponse {
    let map = read_engine_state_map(&state.config.workspace_root);
    let raw_policy = map
        .get("autoProceed")
        .and_then(Value::as_str)
        .unwrap_or("off");
    let policy = normalize_proceed_policy(raw_policy).unwrap_or("off");
    let (decisions_count, recent_decisions) =
        read_recent_proceed_decisions(&state.config.workspace_root);

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "policy": policy,
        "autoProceed": policy,
        "enabled": policy != "off",
        "decisionsCount": decisions_count,
        "recentDecisions": recent_decisions,
        "tokenBudget": Value::Null,
    }))
}

fn handle_super_proceed_post(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(raw_policy) = str_field(&obj, &["policy", "autoProceed", "mode", "value"]) else {
        return HttpResponse::error(
            400,
            "missing_proceed_policy",
            "Field 'policy' (off | standard | full) is required.",
        );
    };
    let policy = match normalize_proceed_policy(raw_policy) {
        Ok(p) => p,
        Err(err) => return HttpResponse::error(400, "invalid_proceed_policy", &err),
    };

    let prev = read_engine_state_map(&state.config.workspace_root);
    let prev_policy = prev
        .get("autoProceed")
        .and_then(Value::as_str)
        .and_then(|s| normalize_proceed_policy(s).ok())
        .unwrap_or("off");
    let now_ms = now_epoch_ms();
    let reason = str_field(&obj, &["reason", "note"]).unwrap_or("studio_proceed_update");
    let clean_reason = SecretRedactor::redact(reason);

    let patch = json!({
        "autoProceed": policy,
        "autoProceedEnabled": policy != "off",
        "tokenBudget": Value::Null,
        "updatedAt": Utc::now().format("%Y-%m-%d %H:%M:%S +00:00").to_string(),
        "updatedEpoch": now_ms / 1000,
    });
    let merged = match merge_engine_state_lossless(&state.config.workspace_root, patch) {
        Ok(v) => v,
        Err(err) => return HttpResponse::error(500, "engine_state_merge_failed", &err),
    };

    let entry = json!({
        "timestamp": Utc::now().to_rfc3339(),
        "epochMs": now_ms,
        "action": "set_policy",
        "previousPolicy": prev_policy,
        "policy": policy,
        "reason": clean_reason,
        "source": "omnia-studio",
    });
    if let Err(err) = append_proceed_decision_jsonl(&state.config.workspace_root, entry.clone()) {
        return HttpResponse::error(500, "proceed_audit_log_failed", &err);
    }
    let (decisions_count, recent_decisions) =
        read_recent_proceed_decisions(&state.config.workspace_root);

    state.event_feed.publish(
        "super",
        "auto_proceed_updated",
        None,
        json!({ "policy": policy, "previousPolicy": prev_policy }),
    );

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "policy": policy,
        "previousPolicy": prev_policy,
        "autoProceed": policy,
        "enabled": policy != "off",
        "decisionsCount": decisions_count,
        "recentDecisions": recent_decisions,
        "engineState": merged,
        "tokenBudget": Value::Null,
    }))
}

fn resolve_frozen_git_shas(workspace: &Path) -> (String, String) {
    let commit = run_git(workspace, &["rev-parse", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "workspace-uncommitted".to_string());
    let tree = run_git(workspace, &["rev-parse", "HEAD^{tree}"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "workspace-tree-snapshot".to_string());
    (commit, tree)
}

fn count_distinct_clean_reviewers(
    rounds: &[Value],
    commit_sha: &str,
    tree_sha: &str,
) -> Vec<String> {
    let mut reviewers = Vec::new();
    let mut seen = BTreeSet::new();
    for round in rounds.iter().rev() {
        let r_commit = round.get("commitSha").and_then(Value::as_str).unwrap_or("");
        let r_tree = round.get("treeSha").and_then(Value::as_str).unwrap_or("");
        let passed = round
            .get("passed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let errors = round.get("errors").and_then(Value::as_u64).unwrap_or(0);
        let findings = round
            .get("findingsCount")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if r_commit != commit_sha || r_tree != tree_sha || !passed || errors > 0 || findings > 0 {
            break;
        }
        if let Some(rev) = round
            .get("reviewer")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let key = rev.to_ascii_lowercase();
            if seen.insert(key) {
                reviewers.push(rev.to_string());
            }
        }
    }
    reviewers.reverse();
    reviewers
}

fn handle_super_record_audit(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(reviewer_raw) = str_field(&obj, &["reviewer", "auditor", "agent"]) else {
        return HttpResponse::error(
            400,
            "missing_reviewer",
            "Field 'reviewer' is required to record a cleanroom audit round.",
        );
    };
    let reviewer = SecretRedactor::redact(reviewer_raw);

    let errors = obj.get("errors").and_then(Value::as_u64).unwrap_or(0);
    let warnings = obj.get("warnings").and_then(Value::as_u64).unwrap_or(0);
    let findings_count = obj
        .get("findingsCount")
        .or_else(|| obj.get("findings_count"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let passed = obj
        .get("passed")
        .and_then(Value::as_bool)
        .unwrap_or(errors == 0 && findings_count == 0);
    let clean_pass = passed && errors == 0 && findings_count == 0;

    let (default_commit, default_tree) = resolve_frozen_git_shas(&state.config.workspace_root);
    let commit_sha = str_field(&obj, &["commitSha", "commit_sha"])
        .map(ToString::to_string)
        .unwrap_or(default_commit);
    let tree_sha = str_field(&obj, &["treeSha", "tree_sha"])
        .map(ToString::to_string)
        .unwrap_or(default_tree);

    let existing = read_engine_state_map(&state.config.workspace_root);
    let mut rounds = existing
        .get("auditRounds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let required_streak = existing
        .get("requiredAuditStreak")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_REQUIRED_AUDIT_STREAK as u64)
        .max(1) as usize;

    let prior_distinct = count_distinct_clean_reviewers(&rounds, &commit_sha, &tree_sha);
    if clean_pass
        && prior_distinct
            .iter()
            .any(|r| r.eq_ignore_ascii_case(&reviewer))
    {
        return HttpResponse::error(
            400,
            "duplicate_reviewer_for_frozen_sha",
            "Distinct reviewers are required for consecutive cleanroom audits on the same frozen commit/tree SHA.",
        );
    }

    let next_num = existing
        .get("totalAuditRoundsLogged")
        .and_then(Value::as_u64)
        .unwrap_or(rounds.len() as u64)
        .saturating_add(1);
    let round_id = str_field(&obj, &["roundId", "round_id"])
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("AUD-R{next_num:03}"));
    let now_ms = now_epoch_ms();
    let summary = str_field(&obj, &["summary", "note"])
        .map(SecretRedactor::redact)
        .unwrap_or_else(|| {
            if clean_pass {
                format!("Cleanroom audit zero-finding PASS on frozen snapshot {commit_sha}")
            } else {
                format!("Audit round failed ({errors} errors, {findings_count} findings)")
            }
        });
    let ts = Utc::now().format("%Y-%m-%d %H:%M:%S +00:00").to_string();
    let new_streak = if clean_pass {
        prior_distinct.len() + 1
    } else {
        0
    };

    let round_obj = json!({
        "roundId": round_id,
        "reviewer": reviewer,
        "commitSha": commit_sha,
        "treeSha": tree_sha,
        "passed": clean_pass,
        "errors": errors,
        "warnings": warnings,
        "findingsCount": findings_count,
        "summary": summary,
        "timestamp": ts,
    });
    rounds.push(round_obj.clone());

    let log_path = state
        .config
        .workspace_root
        .join(".agents")
        .join("super")
        .join("audit_rounds.jsonl");
    let jsonl_entry = json!({
        "accepted": true,
        "clean_pass": clean_pass,
        "commit_sha": commit_sha,
        "epoch": now_ms / 1000,
        "errors": errors,
        "findings_count": findings_count,
        "passed": clean_pass,
        "rejection_reason": Value::Null,
        "reviewer": reviewer,
        "round_id": round_id,
        "streak_after": new_streak,
        "summary": summary,
        "timestamp": ts,
        "tree_sha": tree_sha,
        "warnings": warnings,
    });
    if let Ok(line) = serde_json::to_string(&jsonl_entry) {
        let mut content = fs::read_to_string(&log_path)
            .unwrap_or_default()
            .replace("\r\n", "\n")
            .replace('\r', "\n");
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&line);
        content.push('\n');
        let _ = atomic_write_with_retry(&log_path, content.as_bytes());
    }

    let patch = json!({
        "auditRounds": rounds,
        "auditStreak": new_streak,
        "requiredAuditStreak": required_streak,
        "totalAuditRoundsLogged": next_num,
        "tokenBudget": Value::Null,
        "updatedAt": ts,
        "updatedEpoch": now_ms / 1000,
    });
    let merged = match merge_engine_state_lossless(&state.config.workspace_root, patch) {
        Ok(v) => v,
        Err(err) => return HttpResponse::error(500, "engine_state_merge_failed", &err),
    };

    state.event_feed.publish(
        "super",
        "audit_round_recorded",
        Some(&round_id),
        json!({
            "roundId": round_id,
            "reviewer": reviewer,
            "cleanPass": clean_pass,
            "auditStreak": new_streak,
            "requiredAuditStreak": required_streak,
        }),
    );

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "cleanPass": clean_pass,
        "round": round_obj,
        "auditStreak": new_streak,
        "requiredAuditStreak": required_streak,
        "streakMet": new_streak >= required_streak,
        "engineState": merged,
        "tokenBudget": Value::Null,
    }))
}

fn handle_super_complete(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let check_only = bool_field(&obj, &["checkOnly", "check_only", "dryRun"]).unwrap_or(false);
    let sync_lessons = bool_field(&obj, &["syncLessons", "sync_lessons", "syncGlobalLessons"])
        .unwrap_or(state.config.db_path.is_some());

    let engine = read_engine_state_map(&state.config.workspace_root);
    let super_state = state.artifact_os.super_state().unwrap_or_default();
    let open_steers = state.steer.active_backlog_count();
    let required_streak = engine
        .get("requiredAuditStreak")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_REQUIRED_AUDIT_STREAK as u64)
        .max(1) as usize;
    let rounds = engine
        .get("auditRounds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let (latest_commit, latest_tree) = rounds
        .last()
        .and_then(|r| {
            let c = r.get("commitSha").and_then(Value::as_str)?;
            let t = r.get("treeSha").and_then(Value::as_str)?;
            Some((c.to_string(), t.to_string()))
        })
        .unwrap_or_else(|| resolve_frozen_git_shas(&state.config.workspace_root));

    let distinct_clean_reviewers =
        count_distinct_clean_reviewers(&rounds, &latest_commit, &latest_tree);
    let reported_streak = engine
        .get("auditStreak")
        .and_then(Value::as_u64)
        .unwrap_or(distinct_clean_reviewers.len() as u64) as usize;
    let effective_streak = reported_streak.min(distinct_clean_reviewers.len());

    let dod_ok = super_state.total_dod_gates == 0
        || super_state.verified_dod_gates >= super_state.total_dod_gates;

    let mut blocking_gates = Vec::new();
    if super_state.open_todos > 0 {
        blocking_gates.push("open_todos");
    }
    if open_steers > 0 {
        blocking_gates.push("steer_queue_unfinished");
    }
    if !dod_ok {
        blocking_gates.push("dod_gates_unverified");
    }
    if effective_streak < required_streak {
        blocking_gates.push("cleanroom_audit_streak");
    }

    let gates_summary = json!({
        "openTodos": super_state.open_todos,
        "openSteers": open_steers,
        "verifiedDodGates": super_state.verified_dod_gates,
        "totalDodGates": super_state.total_dod_gates,
        "dodPassed": dod_ok,
        "auditStreak": effective_streak,
        "requiredAuditStreak": required_streak,
        "distinctCleanReviewers": distinct_clean_reviewers,
        "frozenCommitSha": latest_commit,
        "frozenTreeSha": latest_tree,
    });

    if !blocking_gates.is_empty() {
        return HttpResponse::ok(json!({
            "ok": false,
            "state": "online",
            "completed": false,
            "gatePassed": false,
            "marker": Value::Null,
            "blockingGates": blocking_gates,
            "gates": gates_summary,
            "tokenBudget": Value::Null,
        }));
    }

    let lessons_sync = if !check_only && sync_lessons {
        sync_global_lessons(&state.config.workspace_root)
            .ok()
            .map(|rep| SecretRedactor::redact_json(&rep))
    } else {
        None
    };

    let engine_out = if check_only {
        Value::Object(engine)
    } else {
        let now_ms = now_epoch_ms();
        let patch = json!({
            "active": false,
            "mode": "complete",
            "phase": "complete",
            "lifecyclePhase": "complete",
            "goalPersistence": false,
            "stopHookPersistence": false,
            "completeMarker": "GOAL_COMPLETE",
            "tokenBudget": Value::Null,
            "updatedAt": Utc::now().format("%Y-%m-%d %H:%M:%S +00:00").to_string(),
            "updatedEpoch": now_ms / 1000,
        });
        match merge_engine_state_lossless(&state.config.workspace_root, patch) {
            Ok(v) => {
                let _ = state
                    .artifact_os
                    .update_super_state(json!({ "phase": "complete" }), false);
                state.event_feed.publish(
                    "super",
                    "goal_complete",
                    None,
                    json!({
                        "marker": "<!-- GOAL_COMPLETE -->",
                        "auditStreak": effective_streak,
                    }),
                );
                v
            }
            Err(err) => return HttpResponse::error(500, "engine_state_merge_failed", &err),
        }
    };

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "completed": !check_only,
        "gatePassed": true,
        "marker": "<!-- GOAL_COMPLETE -->",
        "blockingGates": [],
        "gates": gates_summary,
        "lessonsSync": lessons_sync,
        "engineState": engine_out,
        "tokenBudget": Value::Null,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::StudioConfig;
    use omnia_harness::artifact_os::engine_state_path;

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

    fn make_test_state() -> (Arc<StudioState>, PathBuf) {
        let mut cfg = StudioConfig::default();
        let tmp = std::env::temp_dir().join(format!(
            "omnia-studio-super-test-{}",
            omnia_core::uuid_v4_simple()
        ));
        let ws = tmp.join("ws");
        let rb = tmp.join("rb");
        let _ = fs::create_dir_all(&ws);
        let _ = fs::create_dir_all(&rb);
        cfg.workspace_root = ws.clone();
        cfg.rollback_root = rb;
        cfg.db_path = None;
        cfg.runtime_url = None;
        (
            Arc::new(StudioState::new(cfg).expect("build test StudioState")),
            tmp,
        )
    }

    #[tokio::test]
    async fn lossless_engine_state_preserves_agy_fast_fields_across_plan_run_proceed_cancel() {
        let (state, tmp) = make_test_state();
        let ws = state.config.workspace_root.clone();
        let super_dir = ws.join(".agents").join("super");
        fs::create_dir_all(&super_dir).unwrap();

        let seed = json!({
            "schemaVersion": 7,
            "waves": [{ "wave": 2, "status": "verified" }],
            "auditStreak": 2,
            "toolProofCounts": { "runChecks": 4, "totalCalls": 9 },
            "activePlanConvs": ["conv-plan-1"],
            "activeRunConvs": ["conv-run-1"],
            "customHostNote": "preserve-me"
        });
        fs::write(
            engine_state_path(&ws),
            format!("{}\n", serde_json::to_string_pretty(&seed).unwrap()),
        )
        .unwrap();

        // /api/v5/super/status & /api/v5/super/capabilities return 200 OK
        let st_resp = dispatch(
            &state,
            &make_req("GET", "/api/v5/super/status", Value::Null),
        )
        .await
        .unwrap();
        assert_eq!(st_resp.status, 200);
        let st_json: Value = serde_json::from_slice(&st_resp.body).unwrap();
        assert_eq!(st_json["tokenBudget"], Value::Null);
        assert_eq!(st_json["engineState"]["schemaVersion"], 7);

        let cap_resp = dispatch(
            &state,
            &make_req("GET", "/api/v5/super/capabilities", Value::Null),
        )
        .await
        .unwrap();
        assert_eq!(cap_resp.status, 200);
        let cap_json: Value = serde_json::from_slice(&cap_resp.body).unwrap();
        assert_eq!(cap_json["crates"], 18);
        assert_eq!(cap_json["computerTools"], 21);
        assert!(cap_json["agentToolCount"].as_u64().unwrap() >= 7);
        assert_eq!(cap_json["invariants"]["approvalMode"], "yolo");
        assert_eq!(cap_json["invariants"]["tokenBudget"], Value::Null);

        // /api/v5/super/plan preserves foreign fields while enforcing plan defaults
        let plan_resp = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/super/plan",
                json!({ "prompt": "Design unified super workflow", "dispatch": false }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(plan_resp.status, 200);
        let plan_json: Value = serde_json::from_slice(&plan_resp.body).unwrap();
        assert_eq!(plan_json["mode"], "super_plan");
        assert_eq!(plan_json["autoProceed"], "off");
        assert_eq!(plan_json["goalPersistence"], false);
        assert_eq!(plan_json["tokenBudget"], Value::Null);
        assert_eq!(plan_json["engineState"]["schemaVersion"], 7);
        assert_eq!(
            plan_json["engineState"]["activePlanConvs"][0],
            "conv-plan-1"
        );
        assert_eq!(plan_json["engineState"]["toolProofCounts"]["runChecks"], 4);

        // /api/v5/super/proceed switches to standard and logs proceed-decisions.jsonl
        let proc_post = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/super/proceed",
                json!({ "policy": "standard", "reason": "interactive review" }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(proc_post.status, 200);
        let proc_get = dispatch(
            &state,
            &make_req("GET", "/api/v5/super/proceed", Value::Null),
        )
        .await
        .unwrap();
        let proc_json: Value = serde_json::from_slice(&proc_get.body).unwrap();
        assert_eq!(proc_json["policy"], "standard");
        assert_eq!(proc_json["enabled"], true);
        assert_eq!(proc_json["decisionsCount"], 1);

        // /api/v5/super/run activates YOLO + goalPersistence + ADDITIVE_INTAKE steer queue
        let run_resp = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/super/run",
                json!({
                    "goal": "Execute autonomous super goal",
                    "steer": "Add additive follow-up check",
                    "syncToDisk": true,
                    "dispatch": false
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(run_resp.status, 200);
        let run_json: Value = serde_json::from_slice(&run_resp.body).unwrap();
        assert_eq!(run_json["mode"], "super_run");
        assert_eq!(run_json["autoProceed"], "full");
        assert_eq!(run_json["goalPersistence"], true);
        assert_eq!(run_json["approvalMode"], "yolo");
        assert_eq!(run_json["tokenBudget"], Value::Null);
        assert_eq!(run_json["engineState"]["customHostNote"], "preserve-me");
        assert_eq!(run_json["engineState"]["waves"][0]["wave"], 2);
        let steer_md = fs::read_to_string(ws.join("docs/workspace/STEER_QUEUE.md")).unwrap();
        assert!(steer_md.contains("ADDITIVE_INTAKE"));
        assert!(steer_md.contains("Add additive follow-up check"));

        // /api/v5/super/cancel emits GOAL_CANCELLED cleanly
        let cancel_resp = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/super/cancel",
                json!({ "reason": "test abort" }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(cancel_resp.status, 200);
        let cancel_json: Value = serde_json::from_slice(&cancel_resp.body).unwrap();
        assert_eq!(cancel_json["status"], "cancelled");
        assert_eq!(cancel_json["marker"], "<!-- GOAL_CANCELLED -->");
        assert_eq!(cancel_json["goalPersistence"], false);

        let _ = fs::remove_dir_all(tmp);
    }

    #[tokio::test]
    async fn record_audit_enforces_distinct_reviewers_and_complete_gate_requires_3x_streak() {
        let (state, tmp) = make_test_state();
        let ws = state.config.workspace_root.clone();
        fs::create_dir_all(ws.join(".agents").join("super")).unwrap();

        let commit = "1111111111111111111111111111111111111111";
        let tree = "2222222222222222222222222222222222222222";

        let r1 = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/super/record-audit",
                json!({ "reviewer": "verifier-a", "commitSha": commit, "treeSha": tree, "passed": true }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(r1.status, 200);

        // Same reviewer on same frozen SHA must be rejected
        let dup = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/super/record-audit",
                json!({ "reviewer": "verifier-a", "commitSha": commit, "treeSha": tree, "passed": true }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(dup.status, 400);

        // Complete fails before 3 distinct reviewers
        let blocked = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/super/complete",
                json!({ "syncLessons": false }),
            ),
        )
        .await
        .unwrap();
        let blocked_json: Value = serde_json::from_slice(&blocked.body).unwrap();
        assert_eq!(blocked_json["completed"], false);
        assert!(blocked_json["blockingGates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g == "cleanroom_audit_streak"));

        for rev in ["verifier-b", "verifier-c"] {
            let ok_r = dispatch(
                &state,
                &make_req(
                    "POST",
                    "/api/v5/super/record-audit",
                    json!({ "reviewer": rev, "commitSha": commit, "treeSha": tree, "passed": true }),
                ),
            )
            .await
            .unwrap();
            assert_eq!(ok_r.status, 200);
        }

        let done = dispatch(
            &state,
            &make_req(
                "POST",
                "/api/v5/super/complete",
                json!({ "syncLessons": false }),
            ),
        )
        .await
        .unwrap();
        let done_json: Value = serde_json::from_slice(&done.body).unwrap();
        assert_eq!(done_json["ok"], true);
        assert_eq!(done_json["completed"], true);
        assert_eq!(done_json["marker"], "<!-- GOAL_COMPLETE -->");

        let _ = fs::remove_dir_all(tmp);
    }

    #[test]
    fn mcp_discovery_skips_google_credentials_and_redacts_secrets() {
        let (_state, tmp) = make_test_state();
        let ws = tmp.join("ws");
        let mcp_json = json!({
            "mcpServers": {
                "google-private": {
                    "type": "http",
                    "url": "https://example.invalid/mcp",
                    "authProviderType": "google_credentials"
                },
                "omnia-local": {
                    "type": "stdio",
                    "command": "omnia",
                    "args": ["--mcp"],
                    "env": { "DUMMY_ENV": "dummy-placeholder-value" }
                }
            }
        });
        fs::write(ws.join(".mcp.json"), mcp_json.to_string()).unwrap();

        let (found, skipped) = discover_mcp_configs_safe_with_home(&ws, Some(&tmp));
        assert_eq!(skipped, 1);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["name"], "omnia-local");
        assert_eq!(found[0]["envKeys"][0], "DUMMY_ENV");

        let _ = fs::remove_dir_all(tmp);
    }
}
