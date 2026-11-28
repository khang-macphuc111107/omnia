//! Lightweight stdio JSON-RPC 2.0 MCP Server (`omnia --mcp` / `omnia mcp`).
//!
//! Exposes 4 high-value Omnia tools with zero extra Cargo dependencies:
//! 1. `omni_search_skills` — bilingual BM25 + read-only 1,001 Cold Vault skill search
//! 2. `omni_load_skill` — bounded (`< 15.5 KB` / `MAX_PAYLOAD_BYTES = 15_500`) skill loader
//! 3. `graphify_query` — Tree-sitter CST symbol search & k-hop graph traversal
//! 4. `rag_search` — Local+Global `[S###]`/`[G###]` ResearchVault hybrid RAG query

use anyhow::{Context, Result};
use omnia_agent::{
    default_omnia_data_dir, redact_secrets, sanitize_windows_path, WorkspaceGraphIndex,
};
use omnia_harness::research_vault::{ResearchVault, VaultTier};
use omnia_harness::skill_registry::{resolve_skill_alias, SkillRegistry};
use serde_json::{json, Value};
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// Strict `< 15.5 KB` payload ceiling for `omni_load_skill` and MCP text responses.
pub const MAX_PAYLOAD_BYTES: usize = 15_500;
const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

pub struct McpServerContext {
    pub workspace: PathBuf,
    skills: SkillRegistry,
    graph: Option<WorkspaceGraphIndex>,
    vault_global_dir: PathBuf,
    vault_override: Option<ResearchVault>,
}

impl McpServerContext {
    #[must_use]
    pub fn new(workspace: &Path) -> Self {
        let clean_ws = sanitize_windows_path(workspace);
        let skills = SkillRegistry::new();
        if skills.load_from_workspace(&clean_ws).is_err() {
            let fallback_dir = clean_ws.join(".agents").join("skills");
            if fallback_dir.is_dir() {
                let _ = skills.load_from_directory(&fallback_dir);
            }
        }
        let _ = skills.load_default_cold_vault();
        Self {
            workspace: clean_ws,
            skills,
            graph: None,
            vault_global_dir: default_omnia_data_dir().join("research-vault"),
            vault_override: None,
        }
    }

    #[cfg(test)]
    pub fn with_test_vault(workspace: &Path, vault: ResearchVault) -> Self {
        let mut ctx = Self::new(workspace);
        ctx.vault_override = Some(vault);
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

#[must_use]
pub fn mcp_tool_definitions() -> Value {
    json!([
        {
            "name": "omni_search_skills",
            "description": "Search Omnia active workspace skills and the read-only Cold Vault catalog using bilingual VN-EN BM25 ranking.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query (English or Vietnamese)." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 25, "default": 8 },
                    "includeVault": { "type": "boolean", "default": true }
                },
                "required": ["query"]
            }
        },
        {
            "name": "omni_load_skill",
            "description": "Load a skill SKILL.md or Cold Vault specification by slug/name, strictly bounded below 15.5 KB.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "slug": { "type": "string", "description": "Skill slug or alias." },
                    "name": { "type": "string", "description": "Alias for slug." }
                }
            }
        },
        {
            "name": "graphify_query",
            "description": "Query the workspace Tree-sitter CST symbol index and traverse k-hop code dependency relationships.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Symbol name, file path, or keyword." },
                    "entity": { "type": "string", "description": "Optional explicit entity/file seed for graph traversal." },
                    "hops": { "type": "integer", "minimum": 1, "maximum": 3, "default": 2 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 30, "default": 10 }
                }
            }
        },
        {
            "name": "rag_search",
            "description": "Search the persistent Local and Global Omnia ResearchVault RAG index with [S###]/[G###] citations.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "RAG search query." },
                    "tier": { "type": "string", "enum": ["local", "global", "both"], "default": "both" },
                    "topK": { "type": "integer", "minimum": 1, "maximum": 25, "default": 8 }
                },
                "required": ["query"]
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

    let res = ctx.skills.search_with_vault(query, limit, include_vault);
    let rendered = serde_json::to_string_pretty(&res).unwrap_or_else(|_| "{}".to_string());
    tool_ok_text(&rendered)
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
    let canonical = resolve_skill_alias(raw_slug);

    if let Ok(skills) = ctx.skills.list_skills() {
        if let Some(meta) = skills.iter().find(|s| {
            s.name.eq_ignore_ascii_case(raw_slug) || s.name.eq_ignore_ascii_case(canonical)
        }) {
            let direct = PathBuf::from(&meta.path);
            let joined = ctx.workspace.join(&meta.path);
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

    let vault = ctx.skills.cold_vault_entries();
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

    let ws_display = ctx.workspace.display().to_string();
    let idx = match ctx.ensure_graph() {
        Ok(i) => i,
        Err(e) => return tool_err_text(&format!("WorkspaceGraphIndex refresh failed: {e}")),
    };
    let hits = idx.search_entity(&query, limit);
    let traversal = idx.traverse_graph(&seed, hops);
    let payload = json!({
        "ok": true,
        "workspace": ws_display,
        "query": query,
        "seed": seed,
        "hops": hops,
        "symbolCount": idx.symbol_count(),
        "entityHits": hits,
        "traversal": traversal,
    });
    let rendered = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string());
    tool_ok_text(&rendered)
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

    let hits = if let Some(ref vault) = ctx.vault_override {
        vault.query_rag(query, tier_filter, top_k)
    } else {
        match ResearchVault::open(&ctx.workspace, Some(&ctx.vault_global_dir)) {
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
                "query": query,
                "tier": tier_label,
                "count": list.len(),
                "hits": list,
            });
            let rendered =
                serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string());
            tool_ok_text(&rendered)
        }
        Err(e) => tool_err_text(&format!("rag_search failed: {e}")),
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
        "initialize" => jsonrpc_ok(
            req_id,
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {
                    "tools": { "listChanged": false }
                },
                "serverInfo": {
                    "name": "omnia-mcp",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        ),
        "ping" => jsonrpc_ok(req_id, json!({})),
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
    use std::env;

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
    fn mcp_server_lists_4_tools_and_enforces_15_5kb_skill_ceiling() {
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
                "# MCP\nOmnia exposes omni_search_skills, omni_load_skill, graphify_query, and rag_search.",
                "text/markdown",
                Some(200),
                "omnia mcp tools",
            )
            .unwrap();

        let mut ctx = McpServerContext::with_test_vault(&ws, vault);

        // 1. initialize + tools/list
        let init = handle_jsonrpc_message(
            &mut ctx,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        )
        .unwrap();
        assert_eq!(init["result"]["serverInfo"]["name"], json!("omnia-mcp"));

        let list = handle_jsonrpc_message(
            &mut ctx,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        )
        .unwrap();
        let names: Vec<&str> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                "omni_search_skills",
                "omni_load_skill",
                "graphify_query",
                "rag_search"
            ]
        );

        // 2. omni_search_skills
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

        // 3. omni_load_skill bounded strictly <= 15_500 bytes (< 15.5 KB)
        let loaded = handle_jsonrpc_message(
            &mut ctx,
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"omni_load_skill","arguments":{"slug":"huge-demo-skill"}}}"#,
        )
        .unwrap();
        assert_eq!(loaded["result"]["isError"], json!(false));
        assert_eq!(loaded["result"]["truncated"], json!(true));
        let text = loaded["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.len() <= MAX_PAYLOAD_BYTES);

        // 4. graphify_query
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

        // 5. rag_search
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

        // 6. Notification produces no response
        assert!(handle_jsonrpc_message(
            &mut ctx,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        )
        .is_none());

        let _ = fs::remove_dir_all(&ws);
    }
}
