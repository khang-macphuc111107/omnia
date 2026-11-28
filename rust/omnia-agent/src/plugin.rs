//! DeepSeek `dsh` Cordis-inspired Composable Reversible Plugin Registry.
//!
//! Each of the 8 Super-Harness pillars is packaged as a reversible `HarnessPlugin`:
//! - Contributes typed `ToolSpec` declarations (canonicalized alphabetically by `cache_guard`).
//! - Contributes pre-turn / post-turn hooks and Turn-1 user context transforms.
//! - Supports live toggle (`enable` / `disable`) and atomic `snapshot()` / `rollback()`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessPluginInfo {
    pub id: String,
    pub name: String,
    pub pillar: String,
    pub description: String,
    pub enabled: bool,
    pub tool_names: Vec<String>,
    pub reversible: bool,
    pub load_order: u32,
}

#[derive(Debug, Default)]
pub struct TurnHookContext {
    pub turn_index: u32,
    pub last_tool_errors: u32,
    pub injected_notes: Vec<String>,
}

pub trait HarnessPlugin: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn pillar(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn load_order(&self) -> u32;
    fn default_enabled(&self) -> bool {
        true
    }
    fn tools(&self) -> Vec<ToolSpec> {
        Vec::new()
    }
    fn on_before_turn(&self, _ctx: &mut TurnHookContext) {}
    fn on_after_turn(&self, _ctx: &mut TurnHookContext) {}
    fn transform_turn1_context(&self, _workspace: &Path, _sections: &mut Vec<String>) {}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginRegistrySnapshot {
    enabled_states: BTreeMap<String, bool>,
}

#[derive(Clone)]
struct RegisteredPlugin {
    plugin: Arc<dyn HarnessPlugin>,
    enabled: bool,
}

#[derive(Clone)]
pub struct PluginRegistry {
    plugins: Vec<RegisteredPlugin>,
}

impl Default for PluginRegistry {
    fn default() -> Self {
        Self::with_default_pillars()
    }
}

impl PluginRegistry {
    pub fn empty() -> Self {
        Self {
            plugins: Vec::new(),
        }
    }

    /// Construct the default 8-in-1 Super-Harness Cordis plugin registry matching `IPC_CONTRACT.md` §10.2.
    pub fn with_default_pillars() -> Self {
        let mut reg = Self::empty();
        reg.register(Arc::new(ApplyPatchPlugin));
        reg.register(Arc::new(EditFilePlugin));
        reg.register(Arc::new(MerkleIndexPlugin));
        reg.register(Arc::new(GraphLocatorPlugin));
        reg.register(Arc::new(LakeviewCompressPlugin));
        reg.register(Arc::new(EmptyThinkingRecoveryPlugin));
        reg.register(Arc::new(SelfVerifyGatePlugin));
        reg.register(Arc::new(HostToolsLazyPlugin));
        reg
    }

    pub fn register(&mut self, plugin: Arc<dyn HarnessPlugin>) {
        let enabled = plugin.default_enabled();
        self.plugins.retain(|p| p.plugin.id() != plugin.id());
        self.plugins.push(RegisteredPlugin { plugin, enabled });
        self.plugins
            .sort_by_key(|p| (p.plugin.load_order(), p.plugin.id()));
    }

    pub fn is_enabled(&self, plugin_id: &str) -> bool {
        self.plugins
            .iter()
            .find(|p| p.plugin.id() == plugin_id)
            .map(|p| p.enabled)
            .unwrap_or(false)
    }

    /// Reversible enable/disable toggle (Cordis disposable semantics).
    pub fn toggle(
        &mut self,
        plugin_id: &str,
        enabled: bool,
    ) -> anyhow::Result<Vec<HarnessPluginInfo>> {
        let entry = self
            .plugins
            .iter_mut()
            .find(|p| p.plugin.id() == plugin_id)
            .ok_or_else(|| anyhow::anyhow!("unknown harness plugin: {plugin_id}"))?;
        entry.enabled = enabled;
        Ok(self.list_info())
    }

    pub fn snapshot(&self) -> PluginRegistrySnapshot {
        let enabled_states = self
            .plugins
            .iter()
            .map(|p| (p.plugin.id().to_string(), p.enabled))
            .collect();
        PluginRegistrySnapshot { enabled_states }
    }

    pub fn rollback(&mut self, snap: &PluginRegistrySnapshot) {
        for p in &mut self.plugins {
            if let Some(&prev) = snap.enabled_states.get(p.plugin.id()) {
                p.enabled = prev;
            }
        }
    }

    pub fn list_info(&self) -> Vec<HarnessPluginInfo> {
        self.plugins
            .iter()
            .map(|p| HarnessPluginInfo {
                id: p.plugin.id().to_string(),
                name: p.plugin.name().to_string(),
                pillar: p.plugin.pillar().to_string(),
                description: p.plugin.description().to_string(),
                enabled: p.enabled,
                tool_names: p.plugin.tools().into_iter().map(|t| t.name).collect(),
                reversible: true,
                load_order: p.plugin.load_order(),
            })
            .collect()
    }

    /// Assemble the complete active tool list:
    /// always-on core primitives (`read_file`, `write_file`, `search_code`, `shell`)
    /// plus enabled plugin tools (`edit_file`, `apply_patch`, `workspace_map`, optional
    /// `load_skill` / `omni_*`), sorted alphabetically by name for byte-deterministic caching.
    pub fn active_tools(&self, has_workspace_skills: bool) -> Vec<ToolSpec> {
        self.active_tools_with_deferred(has_workspace_skills, false)
    }

    /// Assemble active tool list plus the 2 KV-cache-invariant deferred meta-tools
    /// (`discover_tools`, `invoke_extension_tool`) ONLY when `has_deferred_extensions == true` (D7).
    pub fn active_tools_with_deferred(
        &self,
        has_workspace_skills: bool,
        has_deferred_extensions: bool,
    ) -> Vec<ToolSpec> {
        let mut by_name: BTreeMap<String, ToolSpec> = BTreeMap::new();
        for t in core_base_tools() {
            by_name.insert(t.name.clone(), t);
        }
        for reg in &self.plugins {
            if !reg.enabled {
                continue;
            }
            for t in reg.plugin.tools() {
                if t.name == "load_skill" && !has_workspace_skills {
                    continue;
                }
                by_name.insert(t.name.clone(), t);
            }
        }
        if has_deferred_extensions {
            for t in DeferredToolRegistry::meta_tools() {
                by_name.insert(t.name.clone(), t);
            }
        }
        by_name.into_values().collect()
    }

    pub fn run_before_turn(&self, ctx: &mut TurnHookContext) {
        for reg in &self.plugins {
            if reg.enabled {
                reg.plugin.on_before_turn(ctx);
            }
        }
    }

    pub fn run_after_turn(&self, ctx: &mut TurnHookContext) {
        for reg in &self.plugins {
            if reg.enabled {
                reg.plugin.on_after_turn(ctx);
            }
        }
    }

    pub fn run_turn1_transforms(&self, workspace: &Path, sections: &mut Vec<String>) {
        for reg in &self.plugins {
            if reg.enabled {
                reg.plugin.transform_turn1_context(workspace, sections);
            }
        }
    }
}

/// Core Goose-lean always-on primitives (4 tools); plugins add `edit_file`, `apply_patch`,
/// and `workspace_map` to form the 7-tool compact default surface (~1,220 tokens total with prompt).
pub fn core_base_tools() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "read_file".into(),
            description: "Read file (`path`, optional `start_line`/`end_line`/`symbol`) or batch <=8 files (`paths`). Emits `line:hash| code`.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File or dir path" },
                    "paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Batch <=8 file paths"
                    },
                    "symbol": { "type": "string", "description": "Jump to AST symbol span" },
                    "start_line": { "type": "integer", "description": "1-based start" },
                    "end_line": { "type": "integer", "description": "1-based end" }
                },
                "additionalProperties": false
            }),
            read_only: true,
        },
        ToolSpec {
            name: "write_file".into(),
            description: "Create/overwrite workspace file atomically.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path" },
                    "content": { "type": "string", "description": "Full content" }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }),
            read_only: false,
        },
        ToolSpec {
            name: "search_code".into(),
            description: "Hybrid BM25F+Trigram+SIMD search returning `path:line:hash: code`.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Pattern, symbol, or terms" },
                    "path": { "type": "string", "description": "Subpath filter" },
                    "mode": { "type": "string", "enum": ["regex", "literal", "hybrid", "symbol"], "description": "Mode" },
                    "literal": { "type": "boolean", "description": "Literal match" },
                    "case_sensitive": { "type": "boolean", "description": "Case-sensitive" },
                    "context_lines": { "type": "integer", "description": "Context 0..3" },
                    "max_matches": { "type": "integer", "description": "Max hits (60)" }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            read_only: true,
        },
        ToolSpec {
            name: "shell".into(),
            description: "Run supervised workspace command (tests, builds, git).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command" },
                    "timeout_secs": { "type": "integer", "description": "Timeout (60, max 180)" },
                    "shell": { "type": "string", "enum": ["auto", "bash", "pwsh", "powershell", "cmd"], "description": "Shell" }
                },
                "required": ["command"],
                "additionalProperties": false
            }),
            read_only: false,
        },
    ]
}

// ============================================================================
// 8 Built-in Cordis Pillars (Exact IDs aligned with IPC_CONTRACT.md §10.2)
// ============================================================================

struct ApplyPatchPlugin;
impl HarnessPlugin for ApplyPatchPlugin {
    fn id(&self) -> &'static str {
        "apply_patch"
    }
    fn name(&self) -> &'static str {
        "Codex Atomic Patcher"
    }
    fn pillar(&self) -> &'static str {
        "OpenAI Codex"
    }
    fn description(&self) -> &'static str {
        "Atomic multi-file unified patch engine (`*** Begin Patch`, Hashline `@@ line:hash`, Tier-3 Histogram fallback) with dry-run rollback."
    }
    fn load_order(&self) -> u32 {
        10
    }
    fn tools(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "apply_patch".into(),
            description: "Atomic Codex multi-file patch (`*** Begin Patch`, Update/Add/Delete/Move, `@@` or `@@ line:hash`, `*** End Patch`).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "patch": { "type": "string", "description": "Codex patch payload" }
                },
                "required": ["patch"],
                "additionalProperties": false
            }),
            read_only: false,
        }]
    }
}

struct EditFilePlugin;
impl HarnessPlugin for EditFilePlugin {
    fn id(&self) -> &'static str {
        "edit_file"
    }
    fn name(&self) -> &'static str {
        "Hashline + 3-Tier Histogram Edit"
    }
    fn pillar(&self) -> &'static str {
        "Claude Code + Hashline + Cursor"
    }
    fn description(&self) -> &'static str {
        "Content-addressed Hashline splice (`start_anchor`/`end_anchor`) + 3-tier exact/indent/Histogram edit with (mtime, blake3) Pre-Read Guard."
    }
    fn load_order(&self) -> u32 {
        20
    }
    fn tools(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "edit_file".into(),
            description: "Edit pre-read file via Hashline (`start_anchor`/`end_anchor`), syntactic `symbol` block, or `old_string` -> `new_string`.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path" },
                    "old_string": { "type": "string", "description": "Text to replace" },
                    "new_string": { "type": "string", "description": "Replacement text" },
                    "start_anchor": { "type": "string", "description": "Start `line:hash` e.g. 42:a3f" },
                    "end_anchor": { "type": "string", "description": "End `line:hash`" },
                    "symbol": { "type": "string", "description": "AST symbol name for BlockDiff replacement" },
                    "replace_all": { "type": "boolean", "description": "Replace all" }
                },
                "required": ["path", "new_string"],
                "additionalProperties": false
            }),
            read_only: false,
        }]
    }
}

struct MerkleIndexPlugin;
impl HarnessPlugin for MerkleIndexPlugin {
    fn id(&self) -> &'static str {
        "merkle_index"
    }
    fn name(&self) -> &'static str {
        "BLAKE3 SIMD Merkle Indexer"
    }
    fn pillar(&self) -> &'static str {
        "Cursor + BLAKE3"
    }
    fn description(&self) -> &'static str {
        "SIMD BLAKE3 dirty-path Merkle indexer + SQLite WAL persistence (<1 ms warm refresh)."
    }
    fn load_order(&self) -> u32 {
        30
    }
}

struct GraphLocatorPlugin;
impl HarnessPlugin for GraphLocatorPlugin {
    fn id(&self) -> &'static str {
        "graph_locator"
    }
    fn name(&self) -> &'static str {
        "tree-sitter AST & PPR GraphLocator"
    }
    fn pillar(&self) -> &'static str {
        "LocAgent + Trae + Aider PPR"
    }
    fn description(&self) -> &'static str {
        "Multi-language tree-sitter AST symbol table, 4-relation CSR graph (import/inherits/call/cochange), and Personalized PageRank RepoMap."
    }
    fn load_order(&self) -> u32 {
        40
    }
    fn tools(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "workspace_map".into(),
            description:
                "Query PageRank AST RepoMap by subpath, query, or `focus_symbol` ego-graph.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "subpath": { "type": "string", "description": "Subdir filter" },
                    "query": { "type": "string", "description": "Path/symbol filter" },
                    "focus_symbol": { "type": "string", "description": "Ego-graph symbol" },
                    "hops": { "type": "integer", "description": "Hops 1..2" },
                    "max_files": { "type": "integer", "description": "Max files (40)" }
                },
                "additionalProperties": false
            }),
            read_only: true,
        }]
    }
}

struct LakeviewCompressPlugin;
impl HarnessPlugin for LakeviewCompressPlugin {
    fn id(&self) -> &'static str {
        "lakeview_compress"
    }
    fn name(&self) -> &'static str {
        "Epoch Observation Masker & Semantic Loop Guard"
    }
    fn pillar(&self) -> &'static str {
        "ACON + FoldAgent + Trae"
    }
    fn description(&self) -> &'static str {
        "KV-cache-safe hysteresis epoch observation masking (44k->24k) + semantic error-fingerprint loop guard."
    }
    fn load_order(&self) -> u32 {
        50
    }
}

struct EmptyThinkingRecoveryPlugin;
impl HarnessPlugin for EmptyThinkingRecoveryPlugin {
    fn id(&self) -> &'static str {
        "empty_thinking_recovery"
    }
    fn name(&self) -> &'static str {
        "Split-Budget SSE Resilience & Recovery"
    }
    fn pillar(&self) -> &'static str {
        "OMP + Frontier Transport"
    }
    fn description(&self) -> &'static str {
        "Split-budget HTTP/SSE stall watchdogs with fresh-socket retries, truncated-EOF recovery, and 2-stage empty-thinking auto-recovery."
    }
    fn load_order(&self) -> u32 {
        60
    }
}

struct SelfVerifyGatePlugin;
impl HarnessPlugin for SelfVerifyGatePlugin {
    fn id(&self) -> &'static str {
        "self_verify_gate"
    }
    fn name(&self) -> &'static str {
        "Self-Verify Gate & Progressive Skills"
    }
    fn pillar(&self) -> &'static str {
        "Google Antigravity"
    }
    fn description(&self) -> &'static str {
        "Requires running tests/verifiers before final completion and exposes progressive `.agents/skills/*/SKILL.md` loading via `load_skill`."
    }
    fn load_order(&self) -> u32 {
        70
    }
    fn tools(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "load_skill".into(),
            description:
                "Load full instructions from a workspace progressive SKILL.md by skill name.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Skill name listed in workspace context" }
                },
                "required": ["name"],
                "additionalProperties": false
            }),
            read_only: true,
        }]
    }
}

struct HostToolsLazyPlugin;
impl HarnessPlugin for HostToolsLazyPlugin {
    fn id(&self) -> &'static str {
        "host_tools_lazy"
    }
    fn name(&self) -> &'static str {
        "Lazy Cockpit Host Tools"
    }
    fn pillar(&self) -> &'static str {
        "OMP Cockpit"
    }
    fn description(&self) -> &'static str {
        "Exposes native SQLite Kanban, Inbox, Markdown KB, Scheduler, and GitHub Watch tools on demand (off by default to keep coding prompts lean)."
    }
    fn load_order(&self) -> u32 {
        80
    }
    fn default_enabled(&self) -> bool {
        false
    }
    fn tools(&self) -> Vec<ToolSpec> {
        vec![
            ToolSpec {
                name: "omni_kanban_list".into(),
                description: "List workspace Kanban task cards from the local Omnia store.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "status": { "type": "string", "description": "Optional status filter" }
                    },
                    "additionalProperties": false
                }),
                read_only: true,
            },
            ToolSpec {
                name: "omni_kb_search".into(),
                description: "Search local Omnia knowledge base notes.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Search query" }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }),
                read_only: true,
            },
        ]
    }
}

/// Built-in KV-invariant deferred semantic & graph tools registered into `DeferredToolRegistry`
/// so Tier-0 core schemas stay lean (`7` tools) while semantic LSP & k-hop graph tools are
/// immediately discoverable and executable via `discover_tools` / `invoke_extension_tool`!
pub fn builtin_deferred_semantic_tools() -> Vec<ToolSpec> {
    let mut specs = vec![
        ToolSpec {
            name: "lsp_query".into(),
            description: "Lazy on-demand LSP semantic query (`definition`, `references`, `diagnostics`, `hover`, `symbols`, `rename`) with Tree-sitter AST fallback (0ms startup cost).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["definition", "references", "diagnostics", "hover", "symbols", "rename"] },
                    "path": { "type": "string", "description": "Workspace-relative file path" },
                    "line": { "type": "integer", "description": "1-based line number" },
                    "character": { "type": "integer", "description": "0-based UTF-16 column" },
                    "symbol": { "type": "string", "description": "Optional symbol name hint" },
                    "new_name": { "type": "string", "description": "Replacement identifier name (required for rename)" }
                },
                "required": ["action", "path"],
                "additionalProperties": false
            }),
            read_only: true,
        },
        ToolSpec {
            name: "graph_traverse".into(),
            description: "LocAgent k-hop heterogeneous code graph traversal starting from a file path or symbol name.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "seed": { "type": "string", "description": "Workspace-relative file path or symbol name" },
                    "hops": { "type": "integer", "description": "Traversal hops (1..3, default 2)" }
                },
                "required": ["seed"],
                "additionalProperties": false
            }),
            read_only: true,
        },
        ToolSpec {
            name: "search_entity".into(),
            description: "LocAgent structured CST entity search returning exact symbol definitions, line spans, and signatures.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Symbol or qualified name query" },
                    "limit": { "type": "integer", "description": "Max results (1..50, default 15)" }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            read_only: true,
        },
        ToolSpec {
            name: "ast_grep".into(),
            description: "Structural Tree-sitter AST pattern search across 9 languages (`$VAR` and `$$$REST` metavariables).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Structural AST pattern with optional $VAR / $$$REST captures" },
                    "path": { "type": "string", "description": "Optional workspace-relative file or directory" },
                    "lang": { "type": "string", "description": "Language: rust, python, js, ts, tsx, go, c, cpp, json" },
                    "limit": { "type": "integer", "description": "Max matches (default 50)" }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
            read_only: true,
        },
        ToolSpec {
            name: "ast_edit".into(),
            description: "Syntax-verified Tree-sitter structural AST search-and-rewrite across files (dry_run supported).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Workspace-relative file path" },
                    "pattern": { "type": "string", "description": "AST match pattern with $VAR / $$$REST" },
                    "rewrite": { "type": "string", "description": "Replacement template substituting $VAR / $$$REST" },
                    "lang": { "type": "string", "description": "Optional language override" },
                    "dry_run": { "type": "boolean", "description": "Preview rewrite without writing disk" }
                },
                "required": ["path", "pattern", "rewrite"],
                "additionalProperties": false
            }),
            read_only: false,
        },
        ToolSpec {
            name: "pty_exec".into(),
            description: "Persistent ConPTY interactive shell or Python REPL session manager (create, exec, write, read, resize, list, kill).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["create", "exec", "write", "read", "resize", "list", "kill"] },
                    "session_id": { "type": "string", "description": "Target PTY session ID" },
                    "kind": { "type": "string", "enum": ["shell", "python_repl"], "description": "Session kind for create" },
                    "input": { "type": "string", "description": "Command/code or raw text to write" },
                    "cols": { "type": "integer" },
                    "rows": { "type": "integer" },
                    "timeout_ms": { "type": "integer" }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
            read_only: false,
        },
        ToolSpec {
            name: "dap".into(),
            description: "Debug Adapter Protocol client (`debugpy`, `lldb-dap`, `dlv`): launch, attach, set_breakpoints, continue, next, step_in, step_out, stack_trace, scopes, variables, evaluate, terminate, list.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["launch", "attach", "set_breakpoints", "continue", "next", "step_in", "step_out", "stack_trace", "scopes", "variables", "evaluate", "summary", "list", "terminate"] },
                    "session_id": { "type": "string" },
                    "adapter": { "type": "string", "description": "debugpy | lldb-dap | dlv" },
                    "program": { "type": "string", "description": "Target script or executable path" },
                    "args": { "type": "array", "items": { "type": "string" } },
                    "pid": { "type": "integer" },
                    "port": { "type": "integer" },
                    "file": { "type": "string" },
                    "lines": { "type": "array", "items": { "type": "integer" } },
                    "thread_id": { "type": "integer" },
                    "frame_id": { "type": "integer" },
                    "variables_reference": { "type": "integer" },
                    "expression": { "type": "string" }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
            read_only: false,
        },
        ToolSpec {
            name: "web_fetch".into(),
            description: "SSRF-safe HTTP(S) fetch extracting heading-preserving Markdown, canonical URL, metadata, BLAKE3 digest, and honest [BLOCKED_BY_CHALLENGE]/[AUTH_REQUIRED] status (zero bypass).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Public http:// or https:// URL" },
                    "raw": { "type": "boolean" },
                    "structured": { "type": "boolean", "description": "Return StructuredWebFetch metadata envelope" },
                    "max_chars": { "type": "integer" }
                },
                "required": ["url"],
                "additionalProperties": false
            }),
            read_only: true,
        },
        ToolSpec {
            name: "web_search".into(),
            description: "Multi-backend parallel web & academic search (Tavily/Exa/Brave/DDG-HTML/Wikipedia + arXiv/OpenAlex/EuropePMC) with site/date filters and query-wave fanout.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Single search query" },
                    "queries": { "type": "array", "items": { "type": "string" }, "description": "Optional <=6 parallel search wave queries" },
                    "scope": { "type": "string", "enum": ["web", "academic", "all"], "description": "Search scope (default web)" },
                    "site": { "type": "string", "description": "Optional domain filter (e.g. docs.rs)" },
                    "published_after": { "type": "string", "description": "Optional YYYY-MM-DD lower bound" },
                    "published_before": { "type": "string", "description": "Optional YYYY-MM-DD upper bound" },
                    "limit": { "type": "integer" }
                },
                "additionalProperties": false
            }),
            read_only: true,
        },
        ToolSpec {
            name: "deep_research".into(),
            description: "Persistent Local+Global Research RAG Vault ([S###]/[G###] citations), active multi-wave web+academic search, full URL extraction, 5-level evidence claim verification, structured result-set tables, and full 'Sources (Searched, Viewed & Extracted)' ledger.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["status", "search_wave", "fetch_ingest", "ingest", "query_rag", "record_claim", "sources_ledger", "extract_table", "pin_source", "export_dossier"] },
                    "query": { "type": "string" },
                    "queries": { "type": "array", "items": { "type": "string" } },
                    "scope": { "type": "string", "enum": ["web", "academic", "all"] },
                    "site": { "type": "string" },
                    "published_after": { "type": "string" },
                    "published_before": { "type": "string" },
                    "urls": { "type": "array", "items": { "type": "string" } },
                    "url": { "type": "string" },
                    "title": { "type": "string" },
                    "content": { "type": "string" },
                    "tier": { "type": "string", "enum": ["local", "global", "both"] },
                    "session_id": { "type": "string" },
                    "claim_text": { "type": "string" },
                    "citations": { "type": "array", "items": { "type": "string" } },
                    "grade": { "type": "string", "enum": ["verified", "corroborated", "single_source", "conflict", "unverified_gap"] },
                    "citation_id": { "type": "string" },
                    "result_set_id": { "type": "string" },
                    "columns": { "type": "array", "items": { "type": "string" } },
                    "format": { "type": "string", "enum": ["markdown", "json"] },
                    "auto_fetch": { "type": "boolean" },
                    "limit": { "type": "integer" },
                    "top_k": { "type": "integer" }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
            read_only: false,
        },
        ToolSpec {
            name: "deep_think".into(),
            description: "Persisted 5-stage Deep Think engine: invariant framing, >=3 distinct hypothesis branches (baseline/sota/contrarian), executable falsification receipt linking, cross-model red-team critique, epistemic calibration, and 6-state conclusion.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["start", "branch", "falsify", "redteam", "conclude", "status", "list"] },
                    "session_id": { "type": "string" },
                    "problem": { "type": "string" },
                    "invariants": { "type": "array", "items": { "type": "string" } },
                    "assumptions": { "type": "array", "items": { "type": "string" } },
                    "effort": { "type": "string" },
                    "kind": { "type": "string", "enum": ["baseline", "sota", "contrarian", "custom"] },
                    "title": { "type": "string" },
                    "summary": { "type": "string" },
                    "complexity": { "type": "string" },
                    "failure_modes": { "type": "array", "items": { "type": "string" } },
                    "blast_radius": { "type": "string" },
                    "branch_id": { "type": "string" },
                    "command": { "type": "string" },
                    "passed": { "type": "boolean" },
                    "evidence": { "type": "string" },
                    "challenger_model": { "type": "string" },
                    "critique": { "type": "string" },
                    "severity": { "type": "string" },
                    "winner_branch_id": { "type": "string" },
                    "epistemic_band": { "type": "string", "enum": ["verified", "corroborated", "inferred", "hypothesis", "unknown"] },
                    "synthesis": { "type": "string" },
                    "citations": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
            read_only: false,
        },
        ToolSpec {
            name: "workspace_lifecycle".into(),
            description: "Proactive 12-Artifact Engineering OS (Goal, Spec, Blueprint, Plan, Todo, Progress, DoD, Checkpoint, Handoff preserving AGENT_NOTES, Memory, Lessons, Skills) with cross-linking, 6-state receipts, 2-tier Auto-Learn, Gap Radar, and .agents/super/state.json tracking.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["status", "list", "upsert", "link", "todo", "dod", "handoff", "learn", "lessons", "gap_radar", "super_state"] },
                    "kind": { "type": "string", "enum": ["goal", "spec", "blueprint", "plan", "todo", "progress", "dod", "checkpoint", "handoff", "memory", "lesson", "skill"] },
                    "id": { "type": "string" },
                    "title": { "type": "string" },
                    "content": { "type": "string" },
                    "status": { "type": "string" },
                    "from_id": { "type": "string" },
                    "to_id": { "type": "string" },
                    "relation": { "type": "string", "enum": ["satisfies", "blocks", "derived_from", "supersedes", "learned_from", "cites", "tracks"] },
                    "gate_id": { "type": "string" },
                    "verified": { "type": "boolean" },
                    "evidence_receipt": { "type": "string" },
                    "scope": { "type": "string", "enum": ["project", "global", "both"] },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "query": { "type": "string" },
                    "project_to_disk": { "type": "boolean" },
                    "wave": { "type": "integer" },
                    "strikes": { "type": "integer" },
                    "phase": { "type": "string" },
                    "summary": { "type": "string" }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
            read_only: false,
        },
        ToolSpec {
            name: "skill_codify".into(),
            description: "Crystallize verified workflows/lessons into atomic SKILL.md packages enforcing 'Use when...' triggers, semantic overlap deduplication, <=110 tok frontmatter, <=3500 tok body, and 5-phase/6-state receipts.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["codify", "doctor"] },
                    "slug": { "type": "string" },
                    "description": { "type": "string" },
                    "category": { "type": "string" },
                    "body": { "type": "string" },
                    "canonical_artifacts": { "type": "array", "items": { "type": "string" } },
                    "dependencies": { "type": "array", "items": { "type": "string" } },
                    "overwrite": { "type": "boolean" }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
            read_only: false,
        },
        ToolSpec {
            name: "verify_artifact".into(),
            description: "Deterministic Phase-3 machine verifier checking UTF-8, zero BOM, Unix LF, zero control bytes, SHA-256 digest, zero secrets, <5k token ceiling, inline citation integrity, and optional WCAG 2.1 contrast ratio.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Optional workspace-relative file path to verify" },
                    "content": { "type": "string", "description": "Optional inline text to verify" },
                    "known_citations": { "type": "array", "items": { "type": "string" } },
                    "fg_hex": { "type": "string", "description": "Optional #RRGGBB foreground for WCAG contrast check" },
                    "bg_hex": { "type": "string", "description": "Optional #RRGGBB background for WCAG contrast check" }
                },
                "additionalProperties": false
            }),
            read_only: true,
        },
        ToolSpec {
            name: "omni_skills".into(),
            description: "Bilingual VN-EN BM25+Levenshtein skill router across active skills & 1,001-entry Zero-Bloat Cold Vault, 4-stage Execution DAG composer, 24 pre-wired pipelines, and SHA-256 skill doctor.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["route", "vault", "dag", "pipelines", "doctor"] },
                    "query": { "type": "string" },
                    "limit": { "type": "integer" }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
            read_only: true,
        },
        ToolSpec {
            name: "browser".into(),
            description: "Isolated WebSocket CDP browser automation (never touches Thorium) with SVG virtual cursor overlay.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["launch", "navigate", "click", "type", "eval", "screenshot", "close"] },
                    "session_id": { "type": "string" },
                    "url": { "type": "string" },
                    "headless": { "type": "boolean" },
                    "selector": { "type": "string" },
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "text": { "type": "string" },
                    "expression": { "type": "string" }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
            read_only: false,
        },
        ToolSpec {
            name: "mcp_call".into(),
            description: "Search or invoke live MCP 2026-07-28 tools, poll async tasks, or cancel MCP tasks.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["search", "call", "task_get", "task_cancel", "list_servers"] },
                    "query": { "type": "string" },
                    "tool": { "type": "string" },
                    "server": { "type": "string" },
                    "task_id": { "type": "string" },
                    "arguments": { "type": "object" },
                    "limit": { "type": "integer" }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
            read_only: false,
        },
        ToolSpec {
            name: "mcp_manage".into(),
            description: "Connect, refresh, disconnect, or inspect MCP 2026-07-28 servers (stdio, Streamable HTTP, SSE, OAuth2 PKCE/CIMD).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["connect", "disconnect", "refresh", "list"] },
                    "name": { "type": "string" },
                    "config": { "type": "object" }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
            read_only: false,
        },
        ToolSpec {
            name: "recipe_run".into(),
            description: "List or render Goose-compatible YAML recipes from `.omnia/recipes/` or inline YAML.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "render"] },
                    "path": { "type": "string" },
                    "yaml": { "type": "string" },
                    "params": { "type": "object" }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
            read_only: false,
        },
        ToolSpec {
            name: "plugin_manage".into(),
            description: "Manage Cordis dynamic reversible plugins + Creator Mode scaffold, toggle, rollback, and fault quarantine.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "discover", "create", "enable", "disable", "rollback"] },
                    "id": { "type": "string" },
                    "name": { "type": "string" },
                    "description": { "type": "string" },
                    "tool_name": { "type": "string" },
                    "command": { "type": "string" }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
            read_only: false,
        },
    ];
    specs.extend(crate::memory_engine::memory_tool_specs());
    specs.extend(crate::swarm_runtime::swarm_tool_specs());
    specs.extend(crate::test_time_scaling::test_time_scaling_tool_specs());
    specs.push(crate::builtin_stem::stem_verify_tool_spec());
    specs
}

/// KV-Cache-Invariant Deferred Extension / MCP Tool Registry (`Tool Attention`, `arXiv:2604.21816`, D7).
///
/// Instead of injecting 50–160 extension/MCP schemas into the top-level `tools[]` array
/// (which bloats per-turn cost by 15k–60k tokens AND busts KV prefix caching if mutated),
/// this registry exposes ONLY 2 static meta-tools (`discover_tools` + `invoke_extension_tool`)
/// whenever deferred extension tools > 0, returning schemas inside normal `tool_result`s!
#[derive(Clone, Default)]
pub struct DeferredToolRegistry {
    tools: BTreeMap<String, ToolSpec>,
}

impl DeferredToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, spec: ToolSpec) {
        self.tools.insert(spec.name.clone(), spec);
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    pub fn get(&self, name: &str) -> Option<&ToolSpec> {
        self.tools.get(name)
    }

    /// Search deferred extension tools by code-aware keyword relevance and return top `k <= 10` schemas.
    pub fn discover(&self, query: &str, limit: usize) -> Vec<ToolSpec> {
        let cap = limit.clamp(1, 10);
        let q_tokens = crate::search::tokenize_code(query);
        if q_tokens.is_empty() {
            return self.tools.values().take(cap).cloned().collect();
        }

        let mut scored: Vec<(f64, &ToolSpec)> = self
            .tools
            .values()
            .filter_map(|spec| {
                let name_toks = crate::search::tokenize_code(&spec.name);
                let desc_toks = crate::search::tokenize_code(&spec.description);
                let mut score = 0.0f64;
                for qt in &q_tokens {
                    if spec.name.eq_ignore_ascii_case(qt) {
                        score += 6.0;
                    }
                    if name_toks.iter().any(|t| t == qt || t.contains(qt.as_str())) {
                        score += 3.0;
                    }
                    if desc_toks.iter().any(|t| t == qt || t.contains(qt.as_str())) {
                        score += 1.0;
                    }
                }
                if score > 0.0 {
                    Some((score, spec))
                } else {
                    None
                }
            })
            .collect();

        scored.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
        scored
            .into_iter()
            .take(cap)
            .map(|(_, s)| s.clone())
            .collect()
    }

    /// Tiny static meta-tools (~240 tokens fixed) registered ONLY when deferred tools > 0.
    pub fn meta_tools() -> Vec<ToolSpec> {
        vec![
            ToolSpec {
                name: "discover_tools".into(),
                description: "Search deferred MCP/host extension tools by keyword and return up to 10 compact schemas.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Capability or tool keyword" },
                        "limit": { "type": "integer", "description": "Max tools (1..10, default 5)" }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }),
                read_only: true,
            },
            ToolSpec {
                name: "invoke_extension_tool".into(),
                description: "Invoke a discovered deferred MCP/host extension tool by name with JSON arguments.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Discovered extension tool name" },
                        "arguments": { "type": "object", "description": "Tool JSON arguments" }
                    },
                    "required": ["name", "arguments"],
                    "additionalProperties": false
                }),
                read_only: false,
            },
            ToolSpec {
                name: "run_code".into(),
                description: "Execute confined JS batch orchestration (`tools.read_file`, `tools.search_code`, `tools.edit_file`, `tools.lsp_query`, `tools.mcp.*`) in sandboxed PTC Code Mode to cut N+1 round-trips.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "code": { "type": "string", "description": "ECMAScript source invoking tools.* / tools.mcp.* helpers and returning a JSON value" },
                        "max_parallel_sub_calls": { "type": "integer", "description": "Parallel subcall budget (1..16, default 8)" },
                        "timeout_ms": { "type": "integer", "description": "Execution timeout ms (default 15000)" }
                    },
                    "required": ["code"],
                    "additionalProperties": false
                }),
                read_only: false,
            },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_registry_has_8_pillars_and_7_compact_coding_tools() {
        let reg = PluginRegistry::with_default_pillars();
        let infos = reg.list_info();
        assert_eq!(infos.len(), 8);
        assert!(reg.is_enabled("apply_patch"));
        assert!(reg.is_enabled("edit_file"));
        assert!(!reg.is_enabled("host_tools_lazy"));

        let tools = reg.active_tools(false);
        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "apply_patch",
                "edit_file",
                "read_file",
                "search_code",
                "shell",
                "workspace_map",
                "write_file"
            ]
        );

        // When skills exist in workspace, load_skill is progressively exposed
        let tools_with_skills = reg.active_tools(true);
        assert!(tools_with_skills.iter().any(|t| t.name == "load_skill"));
    }

    #[test]
    fn cordis_plugin_toggle_and_reversible_rollback() {
        let mut reg = PluginRegistry::with_default_pillars();
        let snap = reg.snapshot();

        reg.toggle("apply_patch", false).unwrap();
        reg.toggle("host_tools_lazy", true).unwrap();
        assert!(!reg.is_enabled("apply_patch"));
        assert!(reg.is_enabled("host_tools_lazy"));
        assert!(!reg
            .active_tools(false)
            .iter()
            .any(|t| t.name == "apply_patch"));
        assert!(reg
            .active_tools(false)
            .iter()
            .any(|t| t.name == "omni_kanban_list"));

        // Rollback cleanly restores original exact state
        reg.rollback(&snap);
        assert!(reg.is_enabled("apply_patch"));
        assert!(!reg.is_enabled("host_tools_lazy"));
        assert_eq!(reg.active_tools(false).len(), 7);
    }

    #[test]
    fn deferred_tool_registry_keeps_token0_tools_prefix_immutable_across_discover_and_invoke() {
        use crate::cache_guard::{canonicalize_openai_tools, PrefixCacheGuard, BASE_SYSTEM_PROMPT};

        let mut deferred = DeferredToolRegistry::new();
        for i in 0..40 {
            deferred.register(ToolSpec {
                name: format!("mcp_server_tool_{i:02}"),
                description: format!("External MCP tool #{i} for database analytics"),
                parameters: json!({ "type": "object", "properties": {} }),
                read_only: true,
            });
        }
        deferred.register(ToolSpec {
            name: "omni_kanban_create".into(),
            description: "Create a Kanban task card on the local SQLite board".into(),
            parameters: json!({ "type": "object", "properties": { "title": { "type": "string" } } }),
            read_only: false,
        });

        let reg = PluginRegistry::with_default_pillars();
        let active_t1 = canonicalize_openai_tools(&reg.active_tools_with_deferred(false, true));
        // Only 7 core + 3 meta-tools = 10 tools total (NOT 48 bloated schemas!)
        assert_eq!(active_t1.len(), 10);
        let mut guard = PrefixCacheGuard::new(Some("d7".into()), BASE_SYSTEM_PROMPT, &active_t1);

        // Discovering Kanban tools returns the matching schema via tool_result without mutating Token-0 tools[]!
        let hits = deferred.discover("kanban task card", 5);
        assert!(!hits.is_empty());
        assert_eq!(hits[0].name, "omni_kanban_create");

        let active_t2 = canonicalize_openai_tools(&reg.active_tools_with_deferred(false, true));
        assert!(
            guard.verify_turn_prefix(BASE_SYSTEM_PROMPT, &active_t2),
            "Token-0 tools[] prefix must stay 100% byte-identical across discover & invoke!"
        );
    }

    #[test]
    fn builtin_deferred_registry_discovers_steer18_20_research_think_lifecycle_and_skills_tools() {
        let mut deferred = DeferredToolRegistry::new();
        for spec in builtin_deferred_semantic_tools() {
            deferred.register(spec);
        }
        assert!(deferred.discover("deep research citations rag", 5).iter().any(|t| t.name == "deep_research"));
        assert!(deferred.discover("deep think hypothesis redteam", 5).iter().any(|t| t.name == "deep_think"));
        assert!(deferred.discover("workspace lifecycle goal spec blueprint handoff", 5).iter().any(|t| t.name == "workspace_lifecycle"));
        assert!(deferred.discover("skill codify doctor", 5).iter().any(|t| t.name == "skill_codify"));
        assert!(deferred.discover("verify artifact wcag secrets", 5).iter().any(|t| t.name == "verify_artifact"));
        assert!(deferred.discover("omni skills vault dag pipelines", 5).iter().any(|t| t.name == "omni_skills"));
    }
}
