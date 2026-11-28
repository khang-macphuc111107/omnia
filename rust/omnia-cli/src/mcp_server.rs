//! Lightweight stdio JSON-RPC 2.0 MCP Server (`omnia --mcp` / `omnia mcp`).
//!
//! Ready for global Antigravity registration (`~/.gemini/config/mcp_config.json`):
//! - Negotiates MCP protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`
//! - Handles `roots/list` cleanly
//! - Accepts optional per-call `cwd` on EVERY tool (falling back to startup workspace)
//! - Exposes 8 compact (`<= 800 B` schema each, `< 15.5 KB` bounded output) tools with zero extra crates:
//!   1. `omni_search_skills`
//!   2. `omni_load_skill`
//!   3. `graphify_query`
//!   4. `rag_search`
//!   5. `omnia_super_engine`
//!   6. `omnia_deep_think`
//!   7. `omnia_net_lab`
//!   8. `omnia_studio_bridge` (loopback HTTP bridge to `omnia-studio`, zero binary bloat)

use crate::super_cmds::{
    activate_super_plan, activate_super_run, build_cli_unified_capabilities,
    build_custom_endpoint_target, complete_super_workflow, discover_cross_host_lessons_path,
    engine_state_path, global_lessons_path, probe_custom_dns_resolver, read_engine_state,
    record_super_audit, run_bounded_traceroute_cli, run_global_radar_snapshot, set_auto_proceed,
    sync_lessons_to_paths, AutoProceedMode, GLOBAL_LESSONS_MAX_ENTRIES,
};
use anyhow::{bail, Context, Result};
use omnia_agent::{
    default_omnia_data_dir, redact_secrets, sanitize_windows_path, WorkspaceGraphIndex,
};
use omnia_harness::artifact_os::{ArtifactOs, LessonRecord};
use omnia_harness::deep_think::{BranchKind, DeepThinkEngine, EpistemicBand, ThinkBranch};
use omnia_harness::research_vault::{ResearchVault, VaultTier};
use omnia_harness::skill_registry::{resolve_skill_alias, SkillRegistry};
use omnia_workspace_ops::net_diag::{
    default_upstream_targets, inspect_dns_and_benchmark, inspect_network_identity,
    inspect_proxy_tls_and_endpoints, run_speedtest_streaming, DnsBenchOptions, NetDiagOptions,
    SpeedtestConfig,
};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

/// Strict `< 15.5 KB` payload ceiling for `omni_load_skill` and MCP text responses.
pub const MAX_PAYLOAD_BYTES: usize = 15_500;
/// Supported MCP protocol versions (newest first).
pub const SUPPORTED_MCP_PROTOCOLS: &[&str] = &[
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
];
const DEFAULT_MCP_PROTOCOL_VERSION: &str = "2025-03-26";
const DEFAULT_STUDIO_URL: &str = "http://127.0.0.1:8787";
const MAX_STUDIO_HTTP_BYTES: usize = 256 * 1024;

pub struct McpServerContext {
    pub workspace: PathBuf,
    skills: SkillRegistry,
    graph: Option<WorkspaceGraphIndex>,
    vault_global_dir: PathBuf,
    vault_override: Option<ResearchVault>,
    deep_think_override: Option<DeepThinkEngine>,
}

fn load_skills_for_workspace(workspace: &Path) -> SkillRegistry {
    let skills = SkillRegistry::new();
    if skills.load_from_workspace(workspace).is_err() {
        let fallback_dir = workspace.join(".agents").join("skills");
        if fallback_dir.is_dir() {
            let _ = skills.load_from_directory(&fallback_dir);
        }
    }
    let _ = skills.load_default_cold_vault();
    skills
}

impl McpServerContext {
    #[must_use]
    pub fn new(workspace: &Path) -> Self {
        let clean_ws = sanitize_windows_path(workspace);
        let skills = load_skills_for_workspace(&clean_ws);
        Self {
            workspace: clean_ws,
            skills,
            graph: None,
            vault_global_dir: default_omnia_data_dir().join("research-vault"),
            vault_override: None,
            deep_think_override: None,
        }
    }

    #[cfg(test)]
    pub fn with_test_vault(workspace: &Path, vault: ResearchVault) -> Self {
        let mut ctx = Self::new(workspace);
        ctx.vault_override = Some(vault);
        ctx.deep_think_override = DeepThinkEngine::open_in_memory().ok();
        ctx
    }

    fn ensure_graph(&mut self) -> Result<&WorkspaceGraphIndex> {
        if self.graph.is_none() {
            let mut idx = WorkspaceGraphIndex::new(&self.workspace);
            idx.refresh()?;
            self.graph = Some(idx);
        }
        Ok(self.graph.as_ref().expect("graph initialized"))
    }
}

/// Resolves per-call `cwd` (or `workspace`) argument, falling back to `ctx.workspace`.
#[must_use]
pub fn resolve_call_workspace(ctx: &McpServerContext, args: &Value) -> PathBuf {
    args.get("cwd")
        .or_else(|| args.get("workspace"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|raw| sanitize_windows_path(Path::new(raw)))
        .unwrap_or_else(|| ctx.workspace.clone())
}

/// Negotiates MCP protocol version against [`SUPPORTED_MCP_PROTOCOLS`].
#[must_use]
pub fn negotiate_protocol_version(requested: Option<&str>) -> &'static str {
    if let Some(req) = requested.map(str::trim) {
        for &supported in SUPPORTED_MCP_PROTOCOLS {
            if supported == req {
                return supported;
            }
        }
    }
    DEFAULT_MCP_PROTOCOL_VERSION
}

fn path_to_file_uri(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if normalized.starts_with('/') {
        format!("file://{normalized}")
    } else {
        format!("file:///{normalized}")
    }
}

/// UTF-8 char-boundary safe truncation guaranteeing `output.len() <= max_bytes`.
#[must_use]
pub fn truncate_utf8_bytes(text: &str, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }
    const NOTICE: &str = "\n\n[truncated to stay under 15.5 KB safe MCP ceiling]";
    let budget = max_bytes.saturating_sub(NOTICE.len());
    let mut end = 0usize;
    for (idx, ch) in text.char_indices() {
        let next = idx + ch.len_utf8();
        if next > budget {
            break;
        }
        end = next;
    }
    let mut out = String::with_capacity(end + NOTICE.len());
    out.push_str(&text[..end]);
    out.push_str(NOTICE);
    (out, true)
}

/// Returns the 8 compact Omnia MCP tool schemas (every tool strictly `<= 800 B` serialized).
#[must_use]
pub fn mcp_tool_definitions() -> Value {
    json!([
        {
            "name": "omni_search_skills",
            "description": "Search Omnia workspace skills and Cold Vault via VN-EN BM25.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "cwd": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 25 },
                    "includeVault": { "type": "boolean" }
                },
                "required": ["query"]
            }
        },
        {
            "name": "omni_load_skill",
            "description": "Load skill SKILL.md or Cold Vault entry (<15.5 KB ceiling).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "slug": { "type": "string" },
                    "name": { "type": "string" },
                    "cwd": { "type": "string" }
                }
            }
        },
        {
            "name": "graphify_query",
            "description": "Query Tree-sitter CST symbols and k-hop code graph.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "entity": { "type": "string" },
                    "cwd": { "type": "string" },
                    "hops": { "type": "integer", "minimum": 1, "maximum": 3 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 30 }
                }
            }
        },
        {
            "name": "rag_search",
            "description": "Search Local+Global ResearchVault RAG with [S###]/[G###] citations.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "cwd": { "type": "string" },
                    "tier": { "type": "string", "enum": ["local", "global", "both"] },
                    "topK": { "type": "integer", "minimum": 1, "maximum": 25 }
                },
                "required": ["query"]
            }
        },
        {
            "name": "omnia_super_engine",
            "description": "Control lossless super workflows, capabilities, proceed, learn, and audits.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["status", "plan", "run", "capabilities", "learn", "proceed", "record_audit", "complete"]
                    },
                    "cwd": { "type": "string" },
                    "prompt": { "type": "string" },
                    "data": { "type": "object" }
                },
                "required": ["action"]
            }
        },
        {
            "name": "omnia_deep_think",
            "description": "Create or inspect Deep Think multi-hypothesis falsification sessions.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cwd": { "type": "string" },
                    "prompt": { "type": "string" },
                    "hypotheses": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["prompt"]
            }
        },
        {
            "name": "omnia_net_lab",
            "description": "Run native Rust network snapshot, speedtest, 6-region radar, or traceroute.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["snapshot", "speedtest", "radar", "traceroute"]
                    },
                    "cwd": { "type": "string" },
                    "target": { "type": "string" },
                    "profile": { "type": "string" },
                    "customDns": { "type": "string" }
                },
                "required": ["action"]
            }
        },
        {
            "name": "omnia_studio_bridge",
            "description": "Bridge local loopback omnia-studio for computer use, notebook, downloader, or arena.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["capabilities", "computer_status", "computer_dispatch", "notebook", "downloader", "arena"]
                    },
                    "cwd": { "type": "string" },
                    "studioUrl": { "type": "string" },
                    "payload": { "type": "object" }
                },
                "required": ["action"]
            }
        }
    ])
}

fn tool_ok_text(text: &str) -> Value {
    let safe = redact_secrets(text);
    let (bounded, truncated) = truncate_utf8_bytes(&safe, MAX_PAYLOAD_BYTES);
    json!({
        "content": [{ "type": "text", "text": bounded }],
        "isError": false,
        "truncated": truncated,
        "bytes": bounded.len()
    })
}

fn tool_ok_json(val: &Value) -> Value {
    let rendered = serde_json::to_string_pretty(val).unwrap_or_else(|_| "{}".to_string());
    tool_ok_text(&rendered)
}

fn tool_err_text(msg: &str) -> Value {
    let safe = redact_secrets(msg);
    let (bounded, _) = truncate_utf8_bytes(&safe, MAX_PAYLOAD_BYTES);
    json!({
        "content": [{ "type": "text", "text": bounded }],
        "isError": true
    })
}

fn exec_omni_search_skills(ctx: &McpServerContext, args: &Value) -> Value {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if query.is_empty() {
        return tool_err_text("omni_search_skills requires a non-empty `query` string.");
    }
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, 25))
        .unwrap_or(8);
    let include_vault = args
        .get("includeVault")
        .or_else(|| args.get("include_vault"))
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let call_ws = resolve_call_workspace(ctx, args);
    let res = if call_ws == ctx.workspace {
        ctx.skills.search_with_vault(query, limit, include_vault)
    } else {
        let reg = load_skills_for_workspace(&call_ws);
        reg.search_with_vault(query, limit, include_vault)
    };
    tool_ok_json(&res)
}

fn load_skill_from_registry(reg: &SkillRegistry, workspace: &Path, raw_slug: &str) -> Value {
    let canonical = resolve_skill_alias(raw_slug);

    if let Ok(skills) = reg.list_skills() {
        if let Some(meta) = skills.iter().find(|s| {
            s.name.eq_ignore_ascii_case(raw_slug) || s.name.eq_ignore_ascii_case(canonical)
        }) {
            let direct = PathBuf::from(&meta.path);
            let joined = workspace.join(&meta.path);
            let resolved = if direct.is_file() {
                direct
            } else if direct.join("SKILL.md").is_file() {
                direct.join("SKILL.md")
            } else if joined.is_file() {
                joined
            } else {
                joined.join("SKILL.md")
            };
            let body = match fs::read_to_string(&resolved) {
                Ok(content) => content.replace("\r\n", "\n"),
                Err(e) => {
                    return tool_err_text(&format!(
                        "Failed to read SKILL.md for `{}` ({}): {e}",
                        meta.name,
                        resolved.display()
                    ));
                }
            };
            let header = format!(
                "# Skill: {} (active | sha256:{})\nPath: {}\n\n",
                meta.name,
                &meta.sha256[..meta.sha256.len().min(16)],
                meta.path
            );
            let combined = format!("{header}{body}");
            return tool_ok_text(&combined);
        }
    }

    let vault = reg.cold_vault_entries();
    if let Some(entry) = vault.into_iter().find(|e| {
        e.slug.eq_ignore_ascii_case(raw_slug) || e.slug.eq_ignore_ascii_case(canonical)
    }) {
        let mut body = format!(
            "# Cold Vault Skill: {}\n- Category: {} ({})\n- Focus: {}\n- Source: {}\n- Artifacts: {}\n",
            entry.slug,
            entry.category,
            entry.category_id,
            entry.focus,
            entry.source,
            if entry.canonical_artifacts.is_empty() {
                "none".to_string()
            } else {
                entry.canonical_artifacts.join(", ")
            }
        );
        if let Some(ref p) = entry.path {
            let disk = PathBuf::from(p);
            if let Ok(raw) = fs::read_to_string(&disk) {
                body.push('\n');
                body.push_str(&raw.replace("\r\n", "\n"));
            }
        }
        return tool_ok_text(&body);
    }

    tool_err_text(&format!(
        "Skill `{raw_slug}` not found in active skills or Cold Vault."
    ))
}

fn exec_omni_load_skill(ctx: &McpServerContext, args: &Value) -> Value {
    let raw_slug = args
        .get("slug")
        .or_else(|| args.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if raw_slug.is_empty() {
        return tool_err_text("omni_load_skill requires `slug` (or `name`).");
    }
    let call_ws = resolve_call_workspace(ctx, args);
    if call_ws == ctx.workspace {
        load_skill_from_registry(&ctx.skills, &call_ws, raw_slug)
    } else {
        let reg = load_skills_for_workspace(&call_ws);
        load_skill_from_registry(&reg, &call_ws, raw_slug)
    }
}

fn exec_graphify_query(ctx: &mut McpServerContext, args: &Value) -> Value {
    let query = args
        .get("query")
        .or_else(|| args.get("entity"))
        .or_else(|| args.get("seed"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if query.is_empty() {
        return tool_err_text("graphify_query requires a non-empty `query` or `entity` string.");
    }
    let seed = args
        .get("entity")
        .or_else(|| args.get("seed"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&query)
        .to_string();
    let hops = args
        .get("hops")
        .or_else(|| args.get("maxDepth"))
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, 3))
        .unwrap_or(2);
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, 30))
        .unwrap_or(10);

    let call_ws = resolve_call_workspace(ctx, args);
    let ws_display = call_ws.display().to_string();
    let payload = if call_ws == ctx.workspace {
        let idx = match ctx.ensure_graph() {
            Ok(i) => i,
            Err(e) => return tool_err_text(&format!("WorkspaceGraphIndex refresh failed: {e}")),
        };
        json!({
            "ok": true,
            "workspace": ws_display,
            "query": query,
            "seed": seed,
            "hops": hops,
            "symbolCount": idx.symbol_count(),
            "entityHits": idx.search_entity(&query, limit),
            "traversal": idx.traverse_graph(&seed, hops),
        })
    } else {
        let mut idx = WorkspaceGraphIndex::new(&call_ws);
        if let Err(e) = idx.refresh() {
            return tool_err_text(&format!("WorkspaceGraphIndex refresh failed: {e}"));
        }
        json!({
            "ok": true,
            "workspace": ws_display,
            "query": query,
            "seed": seed,
            "hops": hops,
            "symbolCount": idx.symbol_count(),
            "entityHits": idx.search_entity(&query, limit),
            "traversal": idx.traverse_graph(&seed, hops),
        })
    };
    tool_ok_json(&payload)
}

fn exec_rag_search(ctx: &McpServerContext, args: &Value) -> Value {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if query.is_empty() {
        return tool_err_text("rag_search requires a non-empty `query` string.");
    }
    let tier_filter = args
        .get("tier")
        .and_then(Value::as_str)
        .map(str::trim)
        .and_then(|t| match t.to_ascii_lowercase().as_str() {
            "local" => Some(VaultTier::Local),
            "global" => Some(VaultTier::Global),
            _ => None,
        });
    let top_k = args
        .get("topK")
        .or_else(|| args.get("top_k"))
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, 25))
        .unwrap_or(8);

    let call_ws = resolve_call_workspace(ctx, args);
    let hits = if call_ws == ctx.workspace {
        if let Some(ref vault) = ctx.vault_override {
            vault.query_rag(query, tier_filter, top_k)
        } else {
            match ResearchVault::open(&call_ws, Some(&ctx.vault_global_dir)) {
                Ok(vault) => vault.query_rag(query, tier_filter, top_k),
                Err(e) => Err(e),
            }
        }
    } else {
        match ResearchVault::open(&call_ws, Some(&ctx.vault_global_dir)) {
            Ok(vault) => vault.query_rag(query, tier_filter, top_k),
            Err(e) => Err(e),
        }
    };

    match hits {
        Ok(list) => {
            let tier_label = match tier_filter {
                Some(VaultTier::Local) => "local",
                Some(VaultTier::Global) => "global",
                None => "both",
            };
            let payload = json!({
                "ok": true,
                "workspace": call_ws.display().to_string(),
                "query": query,
                "tier": tier_label,
                "count": list.len(),
                "hits": list,
            });
            tool_ok_json(&payload)
        }
        Err(e) => tool_err_text(&format!("rag_search failed: {e}")),
    }
}

fn open_mcp_artifact_os(workspace: &Path) -> Option<ArtifactOs> {
    let mem_dir = default_omnia_data_dir().join("memory");
    let db_path = mem_dir.join("omnia_artifact_os.db");
    ArtifactOs::open(workspace, &db_path, Some(&mem_dir))
        .or_else(|_| ArtifactOs::open_in_memory(workspace))
        .ok()
}

fn exec_omnia_super_engine(ctx: &McpServerContext, args: &Value) -> Value {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("status")
        .to_ascii_lowercase();
    let call_ws = resolve_call_workspace(ctx, args);
    let prompt = args
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let data = args.get("data").cloned().unwrap_or_else(|| json!({}));

    match action.as_str() {
        "status" => {
            let state = read_engine_state(&call_ws);
            let path = engine_state_path(&call_ws);
            tool_ok_json(&json!({
                "ok": true,
                "workspace": call_ws.display().to_string(),
                "statePath": path.display().to_string(),
                "exists": path.is_file(),
                "state": state,
            }))
        }
        "capabilities" => {
            let caps = build_cli_unified_capabilities(&call_ws);
            tool_ok_json(&caps)
        }
        "plan" => {
            let os = open_mcp_artifact_os(&call_ws);
            match activate_super_plan(&call_ws, prompt, os.as_ref()) {
                Ok((state, path, caps)) => tool_ok_json(&json!({
                    "ok": true,
                    "workflow": "/super-plan",
                    "statePath": path.display().to_string(),
                    "state": state,
                    "capabilities": caps,
                })),
                Err(e) => tool_err_text(&format!("omnia_super_engine plan failed: {e}")),
            }
        }
        "run" => {
            let os = open_mcp_artifact_os(&call_ws);
            match activate_super_run(&call_ws, prompt, os.as_ref()) {
                Ok((state, path, caps)) => tool_ok_json(&json!({
                    "ok": true,
                    "workflow": "/super-run",
                    "statePath": path.display().to_string(),
                    "state": state,
                    "capabilities": caps,
                })),
                Err(e) => tool_err_text(&format!("omnia_super_engine run failed: {e}")),
            }
        }
        "proceed" => {
            let mode_str = data
                .get("mode")
                .and_then(Value::as_str)
                .or(prompt)
                .unwrap_or("status");
            if mode_str.eq_ignore_ascii_case("status") {
                let state = read_engine_state(&call_ws);
                return tool_ok_json(&json!({
                    "ok": true,
                    "workspace": call_ws.display().to_string(),
                    "autoProceed": state.auto_proceed.as_str(),
                    "policy": state.auto_proceed.policy_label(),
                    "enabled": state.auto_proceed_enabled,
                    "tokenBudget": Value::Null,
                }));
            }
            match AutoProceedMode::try_parse(mode_str)
                .and_then(|m| set_auto_proceed(&call_ws, m))
            {
                Ok((state, path)) => tool_ok_json(&json!({
                    "ok": true,
                    "statePath": path.display().to_string(),
                    "state": state,
                })),
                Err(e) => tool_err_text(&format!("omnia_super_engine proceed failed: {e}")),
            }
        }
        "learn" => {
            let Some(os) = open_mcp_artifact_os(&call_ws) else {
                return tool_err_text("ArtifactOs unavailable for omnia_super_engine learn.");
            };
            let op = data
                .get("op")
                .and_then(Value::as_str)
                .unwrap_or(if prompt.is_some() { "add" } else { "sync" });
            if op.eq_ignore_ascii_case("add") {
                let title = data
                    .get("title")
                    .and_then(Value::as_str)
                    .or(prompt)
                    .unwrap_or("")
                    .trim();
                if title.is_empty() {
                    return tool_err_text("omnia_super_engine learn(add) requires prompt or data.title.");
                }
                let scope = data
                    .get("scope")
                    .and_then(Value::as_str)
                    .unwrap_or("global");
                let cause = data
                    .get("rootCause")
                    .and_then(Value::as_str)
                    .unwrap_or(title);
                let inv = data
                    .get("invariant")
                    .and_then(Value::as_str)
                    .unwrap_or(title);
                let rec = LessonRecord {
                    id: format!("lsn-{}", &omnia_core::uuid_v4()[..8]),
                    scope: scope.to_string(),
                    title: title.to_string(),
                    symptom: cause.to_string(),
                    root_cause: cause.to_string(),
                    invariant: inv.to_string(),
                    anti_pattern: String::new(),
                    verify_cmd: data
                        .get("verifyCmd")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    tags: vec!["mcp".into(), scope.into()],
                    provenance_sha: String::new(),
                    promoted_skill_slug: None,
                    overlap_warning: None,
                    created_at_ms: omnia_core::now_epoch_ms(),
                };
                match os.capture_lesson(rec, false) {
                    Ok(saved) => {
                        let global_path = global_lessons_path();
                        let cross = discover_cross_host_lessons_path();
                        let sync_rep = sync_lessons_to_paths(
                            &os,
                            &call_ws,
                            &global_path,
                            cross.as_deref(),
                        )
                        .unwrap_or_else(|_| json!({ "cap": GLOBAL_LESSONS_MAX_ENTRIES }));
                        tool_ok_json(&json!({
                            "ok": true,
                            "lesson": saved,
                            "sync": sync_rep,
                        }))
                    }
                    Err(e) => tool_err_text(&format!("learn add failed: {e}")),
                }
            } else {
                let global_path = global_lessons_path();
                let cross = discover_cross_host_lessons_path();
                match sync_lessons_to_paths(&os, &call_ws, &global_path, cross.as_deref()) {
                    Ok(rep) => tool_ok_json(&rep),
                    Err(e) => tool_err_text(&format!("learn sync failed: {e}")),
                }
            }
        }
        "record_audit" => {
            let reviewer = data
                .get("reviewer")
                .and_then(Value::as_str)
                .unwrap_or("mcp-verifier");
            let frozen_sha = data
                .get("frozenSha")
                .or_else(|| data.get("sha"))
                .and_then(Value::as_str)
                .or(prompt)
                .unwrap_or("");
            let findings = data.get("findings").and_then(Value::as_u64).unwrap_or(0);
            let notes = data
                .get("notes")
                .and_then(Value::as_str)
                .or(prompt)
                .unwrap_or("");
            match record_super_audit(&call_ws, reviewer, frozen_sha, findings, notes) {
                Ok(rep) => tool_ok_json(&rep),
                Err(e) => tool_err_text(&format!("record_audit failed: {e}")),
            }
        }
        "complete" => {
            let status = data
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            let force = data
                .get("force")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let reason = data
                .get("reason")
                .and_then(Value::as_str)
                .or(prompt)
                .unwrap_or("");
            let os = open_mcp_artifact_os(&call_ws);
            match complete_super_workflow(&call_ws, status, reason, force, os.as_ref()) {
                Ok(rep) => tool_ok_json(&rep),
                Err(e) => tool_err_text(&format!("complete failed: {e}")),
            }
        }
        other => tool_err_text(&format!(
            "Unknown omnia_super_engine action `{other}` (expected: status|plan|run|capabilities|learn|proceed|record_audit|complete)."
        )),
    }
}

fn exec_omnia_deep_think(ctx: &McpServerContext, args: &Value) -> Value {
    let prompt = args
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if prompt.is_empty() {
        return tool_err_text("omnia_deep_think requires a non-empty `prompt`.");
    }
    let call_ws = resolve_call_workspace(ctx, args);
    let hypotheses: Vec<String> = args
        .get("hypotheses")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .take(6)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();

    let owned_eng: Option<DeepThinkEngine> = if ctx.deep_think_override.is_some() {
        None
    } else {
        let db_path = default_omnia_data_dir()
            .join("memory")
            .join("omnia_deep_think.db");
        DeepThinkEngine::open(&db_path)
            .or_else(|_| DeepThinkEngine::open_in_memory())
            .ok()
    };
    let Some(eng) = ctx.deep_think_override.as_ref().or(owned_eng.as_ref()) else {
        return tool_err_text("DeepThinkEngine could not be opened.");
    };

    let session_tag = format!(
        "mcp:{}",
        call_ws
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("workspace")
    );
    let mut sess = match eng.start_session(&session_tag, prompt, Vec::new(), Vec::new(), "max") {
        Ok(s) => s,
        Err(e) => return tool_err_text(&format!("DeepThink start_session failed: {e}")),
    };

    let branch_specs: Vec<(BranchKind, String, String)> = if hypotheses.is_empty() {
        vec![
            (
                BranchKind::Baseline,
                "Baseline Architecture".into(),
                format!("Minimal-change incremental solution for: {prompt}"),
            ),
            (
                BranchKind::Sota,
                "SOTA Zero-Bloat Path".into(),
                format!("Optimal invariants + falsifiable receipt design for: {prompt}"),
            ),
            (
                BranchKind::Contrarian,
                "Contrarian Stress Case".into(),
                format!("Challenge core assumptions & failure modes for: {prompt}"),
            ),
        ]
    } else {
        hypotheses
            .into_iter()
            .enumerate()
            .map(|(idx, h)| {
                let kind = match idx {
                    0 => BranchKind::Baseline,
                    1 => BranchKind::Sota,
                    _ => BranchKind::Contrarian,
                };
                (kind, format!("Hypothesis {}", idx + 1), h)
            })
            .collect()
    };

    for (idx, (kind, title, hyp)) in branch_specs.into_iter().enumerate() {
        let br = ThinkBranch {
            branch_id: format!("br_{}", idx + 1),
            kind,
            title,
            hypothesis: hyp,
            complexity: "O(N)".into(),
            failure_modes: Vec::new(),
            blast_radius: "localized".into(),
            citations: Vec::new(),
            epistemic_band: EpistemicBand::Hypothesis,
            falsification_cmd: None,
            falsification_passed: None,
            falsification_receipt: None,
            score_bps: 7_500,
            rejected_reason: None,
        };
        if let Ok(updated) = eng.add_branch(&sess.think_id, br) {
            sess = updated;
        }
    }

    tool_ok_json(&json!({
        "ok": true,
        "workspace": call_ws.display().to_string(),
        "session": sess,
    }))
}

fn exec_omnia_net_lab(ctx: &McpServerContext, args: &Value) -> Value {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("snapshot")
        .to_ascii_lowercase();
    let call_ws = resolve_call_workspace(ctx, args);
    let target = args
        .get("target")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let profile = args
        .get("profile")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("quick");
    let custom_dns = args
        .get("customDns")
        .or_else(|| args.get("custom_dns"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    match action.as_str() {
        "snapshot" => {
            let offline = profile.eq_ignore_ascii_case("offline");
            let identity = inspect_network_identity(&NetDiagOptions {
                probe_public_ip: !offline,
                timeout_ms: 2_500,
                force_refresh: true,
            });
            let dns = inspect_dns_and_benchmark(&DnsBenchOptions {
                run_benchmark: !offline,
                public_ipv4_hint: identity.public_ipv4.clone(),
                custom_dns_ip: custom_dns.map(ToString::to_string),
                ..DnsBenchOptions::default()
            });
            let custom_dns_result = custom_dns.map(|ip| {
                probe_custom_dns_resolver(ip, "example.com", 3, 1_000)
                    .unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }))
            });
            let mut targets = if !offline {
                default_upstream_targets()
            } else {
                Vec::new()
            };
            let mut custom_host_error: Option<String> = None;
            if let Some(host) = target {
                match build_custom_endpoint_target(host) {
                    Ok(ep) => targets.push(ep),
                    Err(e) => custom_host_error = Some(e.to_string()),
                }
            }
            let proxy_tls = inspect_proxy_tls_and_endpoints(&targets, !offline && !targets.is_empty());
            tool_ok_json(&json!({
                "ok": true,
                "workspace": call_ws.display().to_string(),
                "offline": offline,
                "identity": identity,
                "dns": dns,
                "customDns": custom_dns_result,
                "customHostError": custom_host_error,
                "proxyTls": proxy_tls,
            }))
        }
        "speedtest" => {
            let mut cfg = SpeedtestConfig::for_profile(profile);
            if profile.eq_ignore_ascii_case("single") || profile.eq_ignore_ascii_case("single-stream")
            {
                cfg.stream_mode = "single".to_string();
                cfg.multi_streams = 1;
            }
            if let Some(override_url) = target.filter(|u| u.starts_with("http://127.0.0.1:")) {
                cfg.base_url_override = Some(override_url.to_string());
            }
            let cancel = Arc::new(AtomicBool::new(false));
            let run_id = format!("mcp-st-{}", &omnia_core::uuid_v4()[..8]);
            let res = run_speedtest_streaming(&run_id, &cfg, cancel, |_| {});
            tool_ok_json(&json!({
                "ok": true,
                "workspace": call_ws.display().to_string(),
                "result": res,
            }))
        }
        "radar" => {
            let rep = run_global_radar_snapshot(2_000);
            tool_ok_json(&json!({
                "ok": true,
                "workspace": call_ws.display().to_string(),
                "radar": rep,
            }))
        }
        "traceroute" => {
            let host = target.unwrap_or("1.1.1.1");
            match run_bounded_traceroute_cli(host, 12) {
                Ok(rep) => tool_ok_json(&json!({
                    "ok": true,
                    "workspace": call_ws.display().to_string(),
                    "traceroute": rep,
                })),
                Err(e) => tool_err_text(&format!("traceroute rejected: {e}")),
            }
        }
        other => tool_err_text(&format!(
            "Unknown omnia_net_lab action `{other}` (expected: snapshot|speedtest|radar|traceroute)."
        )),
    }
}

/// Strictly parses a loopback-only HTTP URL (`http://127.0.0.1:<port>`, `http://localhost:<port>`,
/// or `http://[::1]:<port>`) to guarantee zero SSRF in `omnia_studio_bridge`.
fn parse_loopback_studio_addr(raw_url: &str) -> Result<(SocketAddr, String, String)> {
    let trimmed = raw_url.trim().trim_end_matches('/');
    let Some(rest) = trimmed.strip_prefix("http://") else {
        bail!("studioUrl must use loopback http:// (got `{trimmed}`)");
    };
    if rest.contains('/') || rest.contains('@') || rest.contains('?') || rest.contains('#') {
        bail!("studioUrl must be scheme://loopback-host:port with no path or credentials");
    }
    let (host_str, port_str) = if let Some(after_bracket) = rest.strip_prefix("[::1]:") {
        ("[::1]", after_bracket)
    } else if let Some((h, p)) = rest.rsplit_once(':') {
        (h, p)
    } else {
        (rest, "8787")
    };
    let port: u16 = port_str
        .parse()
        .with_context(|| format!("invalid loopback port `{port_str}`"))?;
    if port == 0 {
        bail!("studioUrl port must be non-zero");
    }
    let (ip, host_hdr) = match host_str.to_ascii_lowercase().as_str() {
        "127.0.0.1" => (IpAddr::V4(Ipv4Addr::LOCALHOST), format!("127.0.0.1:{port}")),
        "localhost" => (IpAddr::V4(Ipv4Addr::LOCALHOST), format!("localhost:{port}")),
        "[::1]" => (IpAddr::V6(Ipv6Addr::LOCALHOST), format!("[::1]:{port}")),
        other => bail!("studioUrl host `{other}` rejected (loopback 127.0.0.1 / localhost / [::1] only)"),
    };
    Ok((
        SocketAddr::new(ip, port),
        host_hdr,
        format!("http://{host_str}:{port}"),
    ))
}

fn decode_chunked_body(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < raw.len() {
        let Some(rel_end) = raw[pos..].windows(2).position(|w| w == b"\r\n") else {
            break;
        };
        let len_hex = std::str::from_utf8(&raw[pos..pos + rel_end])
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        let Ok(chunk_len) = usize::from_str_radix(len_hex, 16) else {
            break;
        };
        pos += rel_end + 2;
        if chunk_len == 0 {
            break;
        }
        let end = (pos + chunk_len).min(raw.len());
        out.extend_from_slice(&raw[pos..end]);
        pos = (end + 2).min(raw.len());
    }
    out
}

fn loopback_http_request(
    addr: SocketAddr,
    host_header: &str,
    method: &str,
    path: &str,
    body_json: Option<&str>,
) -> Result<(u16, Value)> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(8)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));

    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host_header}\r\nAccept: application/json\r\nConnection: close\r\n"
    );
    if let Some(body) = body_json {
        req.push_str("Content-Type: application/json\r\n");
        req.push_str(&format!("Content-Length: {}\r\n\r\n{}", body.len(), body));
    } else {
        req.push_str("\r\n");
    }
    stream.write_all(req.as_bytes())?;
    stream.flush()?;

    let mut raw = Vec::new();
    let mut limited = stream.take(MAX_STUDIO_HTTP_BYTES as u64);
    limited.read_to_end(&mut raw)?;

    let split_idx = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .context("malformed HTTP response from omnia-studio")?;
    let headers_str = String::from_utf8_lossy(&raw[..split_idx]);
    let status: u16 = headers_str
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(500);
    let is_chunked = headers_str
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked");
    let raw_body = &raw[split_idx + 4..];
    let body_bytes = if is_chunked {
        decode_chunked_body(raw_body)
    } else {
        raw_body.to_vec()
    };
    let body_text = String::from_utf8_lossy(&body_bytes);
    let parsed = serde_json::from_str::<Value>(&body_text)
        .unwrap_or_else(|_| json!({ "raw": body_text.trim() }));
    Ok((status, parsed))
}

fn exec_omnia_studio_bridge(ctx: &McpServerContext, args: &Value) -> Value {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("capabilities")
        .to_ascii_lowercase();
    let call_ws = resolve_call_workspace(ctx, args);
    let studio_url_raw = args
        .get("studioUrl")
        .or_else(|| args.get("studio_url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .or_else(|| env::var("OMNIA_STUDIO_URL").ok().filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| DEFAULT_STUDIO_URL.to_string());

    let (addr, host_hdr, canonical_url) = match parse_loopback_studio_addr(&studio_url_raw) {
        Ok(parsed) => parsed,
        Err(e) => return tool_err_text(&format!("omnia_studio_bridge rejected studioUrl: {e}")),
    };

    let payload = args.get("payload").cloned().unwrap_or_else(|| json!({}));
    let has_payload_keys = payload.as_object().is_some_and(|m| !m.is_empty());

    let (method, endpoint, req_body) = match action.as_str() {
        "capabilities" => ("GET", "/api/v5/super/capabilities", None),
        "computer_status" => ("GET", "/api/v5/computer/status", None),
        "computer_dispatch" => (
            "POST",
            "/api/v5/computer/dispatch",
            Some(serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string())),
        ),
        "notebook" => {
            if has_payload_keys {
                (
                    "POST",
                    "/api/notebooks/grounded-prompt",
                    Some(serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string())),
                )
            } else {
                ("GET", "/api/notebooks", None)
            }
        }
        "downloader" => {
            if payload.get("url").is_some() {
                (
                    "POST",
                    "/api/downloads/start",
                    Some(serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string())),
                )
            } else {
                ("GET", "/api/downloads/list", None)
            }
        }
        "arena" => {
            if has_payload_keys {
                (
                    "POST",
                    "/api/v5/arena/compare",
                    Some(serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string())),
                )
            } else {
                ("GET", "/api/v5/arena/runs", None)
            }
        }
        other => {
            return tool_err_text(&format!(
                "Unknown omnia_studio_bridge action `{other}` (expected: capabilities|computer_status|computer_dispatch|notebook|downloader|arena)."
            ));
        }
    };

    match loopback_http_request(addr, &host_hdr, method, endpoint, req_body.as_deref()) {
        Ok((status, response)) => tool_ok_json(&json!({
            "ok": (200..300).contains(&status),
            "studioRunning": true,
            "studioUrl": canonical_url,
            "workspace": call_ws.display().to_string(),
            "action": action,
            "method": method,
            "endpoint": endpoint,
            "httpStatus": status,
            "response": response,
        })),
        Err(e) => tool_ok_json(&json!({
            "ok": false,
            "studioRunning": false,
            "studioUrl": canonical_url,
            "workspace": call_ws.display().to_string(),
            "action": action,
            "method": method,
            "endpoint": endpoint,
            "error": redact_secrets(&e.to_string()),
            "hint": format!(
                "omnia-studio is not running at {canonical_url}. Start omnia-studio.exe (or pass studioUrl) to use Computer Use, Notebook, OmniDrive, and Studio Arena without bloating omnia.exe."
            ),
        })),
    }
}

fn jsonrpc_ok(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

fn jsonrpc_err(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": redact_secrets(message)
        }
    })
}

/// Processes a single JSON-RPC 2.0 request/notification payload and returns an optional response.
pub fn handle_jsonrpc_message(ctx: &mut McpServerContext, raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let req: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => return Some(jsonrpc_err(Value::Null, -32700, &format!("Parse error: {e}"))),
    };
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

    // Notifications carry no `id` and must not emit a response.
    let req_id = id?;

    let resp = match method {
        "initialize" => {
            let requested = params.get("protocolVersion").and_then(Value::as_str);
            let negotiated = negotiate_protocol_version(requested);
            jsonrpc_ok(
                req_id,
                json!({
                    "protocolVersion": negotiated,
                    "capabilities": {
                        "tools": { "listChanged": false },
                        "roots": { "listChanged": false }
                    },
                    "serverInfo": {
                        "name": "omnia-mcp",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
        }
        "ping" => jsonrpc_ok(req_id, json!({})),
        "roots/list" => {
            let ws_name = ctx
                .workspace
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("workspace");
            jsonrpc_ok(
                req_id,
                json!({
                    "roots": [
                        {
                            "uri": path_to_file_uri(&ctx.workspace),
                            "name": ws_name
                        }
                    ]
                }),
            )
        }
        "tools/list" => jsonrpc_ok(req_id, json!({ "tools": mcp_tool_definitions() })),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(jsonrpc_err(
                    req_id,
                    -32602,
                    "tools/call requires params.name",
                ));
            };
            let tool_args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let tool_res = match name {
                "omni_search_skills" => exec_omni_search_skills(ctx, &tool_args),
                "omni_load_skill" => exec_omni_load_skill(ctx, &tool_args),
                "graphify_query" => exec_graphify_query(ctx, &tool_args),
                "rag_search" => exec_rag_search(ctx, &tool_args),
                "omnia_super_engine" => exec_omnia_super_engine(ctx, &tool_args),
                "omnia_deep_think" => exec_omnia_deep_think(ctx, &tool_args),
                "omnia_net_lab" => exec_omnia_net_lab(ctx, &tool_args),
                "omnia_studio_bridge" => exec_omnia_studio_bridge(ctx, &tool_args),
                other => {
                    return Some(jsonrpc_err(
                        req_id,
                        -32602,
                        &format!("Unknown MCP tool `{other}`"),
                    ));
                }
            };
            jsonrpc_ok(req_id, tool_res)
        }
        "shutdown" => jsonrpc_ok(req_id, json!({})),
        other => jsonrpc_err(req_id, -32601, &format!("Method not found: {other}")),
    };
    Some(resp)
}

/// Reads either newline-delimited JSON-RPC or `Content-Length:` framed JSON-RPC messages.
fn read_next_message<R: BufRead>(reader: &mut R) -> Result<Option<(String, bool)>> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(len_str) = trimmed
            .strip_prefix("Content-Length:")
            .or_else(|| trimmed.strip_prefix("content-length:"))
        {
            let content_len: usize = len_str
                .trim()
                .parse()
                .context("invalid Content-Length header in MCP framing")?;
            // Consume remaining headers until blank line.
            loop {
                line.clear();
                let hn = reader.read_line(&mut line)?;
                if hn == 0 || line.trim().is_empty() {
                    break;
                }
            }
            let capped = content_len.min(4 * 1024 * 1024);
            let mut buf = vec![0u8; capped];
            reader.read_exact(&mut buf)?;
            return Ok(Some((String::from_utf8_lossy(&buf).into_owned(), true)));
        }
        return Ok(Some((trimmed.to_string(), false)));
    }
}

pub fn run_mcp_stdio_loop<R: BufRead, W: Write>(
    ctx: &mut McpServerContext,
    mut reader: R,
    mut writer: W,
) -> Result<()> {
    while let Some((payload, use_content_length)) = read_next_message(&mut reader)? {
        if let Some(resp) = handle_jsonrpc_message(ctx, &payload) {
            let body = serde_json::to_string(&resp)?;
            if use_content_length {
                write!(writer, "Content-Length: {}\r\n\r\n{}", body.len(), body)?;
            } else {
                writeln!(writer, "{body}")?;
            }
            writer.flush()?;
        }
    }
    Ok(())
}

pub fn run_mcp_stdio_server(workspace: &Path) -> Result<()> {
    let mut ctx = McpServerContext::new(workspace);
    let stdin = io::stdin();
    let stdout = io::stdout();
    let reader = BufReader::new(stdin.lock());
    let writer = stdout.lock();
    run_mcp_stdio_loop(&mut ctx, reader, writer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn temp_workspace(tag: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!(
            "omnia_mcp_test_{}_{}_{}",
            tag,
            std::process::id(),
            &omnia_core::uuid_v4()[..8]
        ));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn mcp_server_lists_8_compact_tools_negotiates_protocol_and_enforces_ceilings() {
        let ws = temp_workspace("skills");
        let skill_dir = ws.join(".agents").join("skills").join("huge-demo-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        let huge_body = format!(
            "---\nname: huge-demo-skill\ndescription: Demo skill for MCP truncation gate\n---\n# Huge Skill\n{}",
            "Rust UTF-8 tiếng Việt line.\n".repeat(1200)
        );
        fs::write(skill_dir.join("SKILL.md"), huge_body).unwrap();
        fs::write(
            ws.join("sample.rs"),
            "pub fn alpha_router_check(x: u32) -> u32 { x + 1 }\n",
        )
        .unwrap();

        let vault = ResearchVault::open_in_memory().unwrap();
        vault
            .ingest_document(
                VaultTier::Local,
                "https://docs.example.test/mcp-rag",
                None,
                Some("Omnia MCP Spec"),
                "# MCP\nOmnia exposes 8 compact tools including omni_search_skills and omnia_super_engine.",
                "text/markdown",
                Some(200),
                "omnia mcp tools",
            )
            .unwrap();

        let mut ctx = McpServerContext::with_test_vault(&ws, vault);

        // 1. Protocol negotiation across all 4 supported versions + roots/list
        for ver in SUPPORTED_MCP_PROTOCOLS {
            let msg = json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": ver }
            });
            let init = handle_jsonrpc_message(&mut ctx, &msg.to_string()).unwrap();
            assert_eq!(init["result"]["protocolVersion"], json!(ver));
            assert_eq!(init["result"]["serverInfo"]["name"], json!("omnia-mcp"));
        }

        let roots = handle_jsonrpc_message(
            &mut ctx,
            r#"{"jsonrpc":"2.0","id":10,"method":"roots/list"}"#,
        )
        .unwrap();
        let root_uri = roots["result"]["roots"][0]["uri"].as_str().unwrap();
        assert!(root_uri.starts_with("file:///"));

        // 2. tools/list: exactly 8 tools, EVERY schema <= 800 B and accepting `cwd`!
        let list = handle_jsonrpc_message(
            &mut ctx,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        )
        .unwrap();
        let tools = list["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 8);
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert_eq!(
            names,
            vec![
                "omni_search_skills",
                "omni_load_skill",
                "graphify_query",
                "rag_search",
                "omnia_super_engine",
                "omnia_deep_think",
                "omnia_net_lab",
                "omnia_studio_bridge"
            ]
        );
        for tool in tools {
            let serialized = serde_json::to_string(tool).unwrap();
            assert!(
                serialized.len() <= 800,
                "MCP tool `{}` schema exceeded 800 B ceiling ({} B)",
                tool["name"].as_str().unwrap_or("-"),
                serialized.len()
            );
            assert!(
                tool["inputSchema"]["properties"]["cwd"].is_object(),
                "MCP tool `{}` must accept optional `cwd`",
                tool["name"].as_str().unwrap_or("-")
            );
        }

        // 3. omni_search_skills & omni_load_skill (< 15.5 KB)
        let search = handle_jsonrpc_message(
            &mut ctx,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"omni_search_skills","arguments":{"query":"huge-demo-skill"}}}"#,
        )
        .unwrap();
        assert_eq!(search["result"]["isError"], json!(false));
        assert!(search["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("huge-demo-skill"));

        let loaded = handle_jsonrpc_message(
            &mut ctx,
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"omni_load_skill","arguments":{"slug":"huge-demo-skill"}}}"#,
        )
        .unwrap();
        assert_eq!(loaded["result"]["isError"], json!(false));
        assert_eq!(loaded["result"]["truncated"], json!(true));
        let text = loaded["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.len() <= MAX_PAYLOAD_BYTES);

        // 4. graphify_query & rag_search
        let graph = handle_jsonrpc_message(
            &mut ctx,
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"graphify_query","arguments":{"query":"alpha_router_check"}}}"#,
        )
        .unwrap();
        assert_eq!(graph["result"]["isError"], json!(false));
        assert!(graph["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("alpha_router_check"));

        let rag = handle_jsonrpc_message(
            &mut ctx,
            r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"rag_search","arguments":{"query":"omnia mcp tools","tier":"local"}}}"#,
        )
        .unwrap();
        assert_eq!(rag["result"]["isError"], json!(false));
        assert!(rag["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("S001"));

        // 5. Notification produces no response
        assert!(handle_jsonrpc_message(
            &mut ctx,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        )
        .is_none());

        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn mcp_per_call_cwd_super_engine_deep_think_net_lab_and_studio_bridge_work() {
        let ws_a = temp_workspace("cwd_a");
        let ws_b = temp_workspace("cwd_b");
        fs::write(
            ws_b.join("beta.rs"),
            "pub fn beta_isolated_symbol() -> bool { true }\n",
        )
        .unwrap();

        let vault = ResearchVault::open_in_memory().unwrap();
        let mut ctx = McpServerContext::with_test_vault(&ws_a, vault);

        // Per-call cwd routes graphify_query to ws_b cleanly while ctx.workspace remains ws_a.
        let g_req = json!({
            "jsonrpc": "2.0",
            "id": 20,
            "method": "tools/call",
            "params": {
                "name": "graphify_query",
                "arguments": { "query": "beta_isolated_symbol", "cwd": ws_b.display().to_string() }
            }
        });
        let g_resp = handle_jsonrpc_message(&mut ctx, &g_req.to_string()).unwrap();
        assert_eq!(g_resp["result"]["isError"], json!(false));
        assert!(g_resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("beta_isolated_symbol"));

        // omnia_super_engine plan + capabilities + record_audit on ws_b via per-call cwd
        let plan_req = json!({
            "jsonrpc": "2.0",
            "id": 21,
            "method": "tools/call",
            "params": {
                "name": "omnia_super_engine",
                "arguments": {
                    "action": "plan",
                    "cwd": ws_b.display().to_string(),
                    "prompt": "Design Wave 3"
                }
            }
        });
        let plan_resp = handle_jsonrpc_message(&mut ctx, &plan_req.to_string()).unwrap();
        assert_eq!(plan_resp["result"]["isError"], json!(false));
        assert!(plan_resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("super_plan"));
        assert!(engine_state_path(&ws_b).is_file());

        // omnia_deep_think with explicit hypotheses
        let think_req = json!({
            "jsonrpc": "2.0",
            "id": 22,
            "method": "tools/call",
            "params": {
                "name": "omnia_deep_think",
                "arguments": {
                    "cwd": ws_b.display().to_string(),
                    "prompt": "Compare SQLite WAL vs flat JSON",
                    "hypotheses": ["SQLite WAL", "Flat JSON"]
                }
            }
        });
        let think_resp = handle_jsonrpc_message(&mut ctx, &think_req.to_string()).unwrap();
        assert_eq!(think_resp["result"]["isError"], json!(false));
        assert!(think_resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("SQLite WAL"));

        // omnia_net_lab offline snapshot works deterministically
        let net_req = json!({
            "jsonrpc": "2.0",
            "id": 23,
            "method": "tools/call",
            "params": {
                "name": "omnia_net_lab",
                "arguments": {
                    "action": "snapshot",
                    "profile": "offline",
                    "cwd": ws_b.display().to_string()
                }
            }
        });
        let net_resp = handle_jsonrpc_message(&mut ctx, &net_req.to_string()).unwrap();
        assert_eq!(net_resp["result"]["isError"], json!(false));
        assert!(net_resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("\"offline\": true"));

        // omnia_studio_bridge rejects non-loopback URLs (SSRF guard)
        let ssrf_req = json!({
            "jsonrpc": "2.0",
            "id": 24,
            "method": "tools/call",
            "params": {
                "name": "omnia_studio_bridge",
                "arguments": {
                    "action": "computer_status",
                    "studioUrl": "http://example.test:4188"
                }
            }
        });
        let ssrf_resp = handle_jsonrpc_message(&mut ctx, &ssrf_req.to_string()).unwrap();
        assert_eq!(ssrf_resp["result"]["isError"], json!(true));

        // omnia_studio_bridge talks cleanly to a live loopback mock listener
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server_thread = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let body = r#"{"ok":true,"toolCount":21,"mode":"yolo"}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        let bridge_req = json!({
            "jsonrpc": "2.0",
            "id": 25,
            "method": "tools/call",
            "params": {
                "name": "omnia_studio_bridge",
                "arguments": {
                    "action": "computer_status",
                    "studioUrl": format!("http://127.0.0.1:{port}")
                }
            }
        });
        let bridge_resp = handle_jsonrpc_message(&mut ctx, &bridge_req.to_string()).unwrap();
        server_thread.join().unwrap();
        assert_eq!(bridge_resp["result"]["isError"], json!(false));
        let btxt = bridge_resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(btxt.contains("\"studioRunning\": true"));
        assert!(btxt.contains("\"toolCount\": 21"));

        let _ = fs::remove_dir_all(&ws_a);
        let _ = fs::remove_dir_all(&ws_b);
    }
}
