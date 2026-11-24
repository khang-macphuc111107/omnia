//! Compact 7-Tool Execution Engine + Progressive Skills + Lazy Host Tools + Security Gate.
//!
//! Security invariants enforced on EVERY call:
//! - Every file path is validated with `crate::path_guard::ensure_within_workspace`.
//! - Every file, patch, and shell action is evaluated against `crate::permissions::PermissionsEngine`
//!   (Global + Workspace Allow/Deny globs + Untrusted Workspace Gate; Deny ALWAYS wins).
//! - Every `shell` command runs inside a Win32 Job Object (`spawn_supervised_command`) with
//!   closed stdin, concurrent stdout/stderr draining, hard timeout, and guaranteed 0 orphans.

use crate::agent_store::AgentStore;
use crate::ast_edit::{ast_edit_source, ast_grep_path, AstLang, AstRewriteOp};
use crate::checkpoint::TurnCheckpointStore;
use crate::context::WorkspaceContextBundle;
use crate::dap::{DapAttachRequest, DapInitialBreakpoint, DapLaunchRequest, DapManager};
use crate::dynamic_plugins::{CordisPluginManager, DynamicPluginToolDef};
use crate::edit::{
    edit_file_by_hashline, edit_file_by_symbol_block, edit_file_guarded, format_hashline,
    line_hash_tag, run_fast_compiler_syntax_check, FileReadTracker,
};
use crate::graph_locator::{verify_syntax_delta, WorkspaceGraphIndex};
use crate::hooks::{HookEvent, HookRegistry};
use crate::lsp::LazyLspManager;
use crate::mcp_client::{McpManager, McpServerConfig};
use crate::memory_engine::{dispatch_memory_tool_json, MemoryEngine};
use crate::output_compressor::compress_tool_output;
use crate::patch::{apply_codex_patch, parse_codex_patch, FilePatchOp};
use crate::path_guard::{ensure_within_workspace, sanitize_windows_path};
use crate::permissions::{ApprovalMode, PermissionDecision, PermissionRule, PermissionsEngine};
use crate::plugin::{builtin_deferred_semantic_tools, DeferredToolRegistry, ToolSpec};
use crate::ptc::{run_code_sandbox, PtcInnerToolOutput, PtcRunRequest, PtcToolInvoker};
use crate::pty_session::{PtyCreateRequest, PtyKind, PtyManager};
use crate::recipes::{discover_recipes, parse_recipe_yaml, validate_and_render_recipe};
use crate::sanitizer::{atomic_write_bom_free, format_fail_fast_error, sanitize_untrusted_text};
use crate::search::SearchMode;
use crate::supervisor::spawn_supervised_command;
use crate::swarm_runtime::{dispatch_swarm_tool_json, SwarmRuntime};
use crate::test_time_scaling::{dispatch_test_scale_tool_json, TestTimeScalingConfig};
use crate::web_tools::{web_fetch, web_search, BrowserToolManager};
use aho_corasick::AhoCorasickBuilder;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_READ_LINES_DEFAULT: usize = 400;
const MAX_READ_CHARS: usize = 20_000;
const MAX_BATCH_READ_CHARS: usize = 56_000;
const MIN_BATCH_FILE_READ_CHARS: usize = 8_000;
const MAX_BATCH_READ_FILES: usize = 8;
const MAX_SHELL_OUTPUT_CHARS: usize = 20_000;
const MAX_TOOL_OUTPUT_CHARS: usize = 20_000;
const SHELL_COMPACT_MIN_CHARS: usize = 1_800;

/// Optional interactive approval callback used when `PermissionsEngine` returns `Ask`.
pub type InteractiveApprover = Arc<
    dyn Fn(String, String) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
        + Send
        + Sync,
>;

/// Pluggable async callback for external MCP / Studio host extension tools registered in `DeferredToolRegistry`.
pub type ExtensionToolHandler = Arc<
    dyn Fn(
            String,
            Value,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>>
        + Send
        + Sync,
>;

#[derive(Debug, Clone)]
pub struct ToolExecOutput {
    pub content: String,
    pub is_error: bool,
    pub is_host_tool: bool,
    pub duration_ms: u64,
}

#[derive(Clone)]
pub struct ToolRuntime {
    pub session_key: String,
    pub workspace_root: PathBuf,
    pub approval_mode: ApprovalMode,
    pub workspace_trusted: bool,
    pub permission_rules: Vec<PermissionRule>,
    pub read_tracker: FileReadTracker,
    pub graph_index: Arc<Mutex<WorkspaceGraphIndex>>,
    pub context_bundle: Arc<WorkspaceContextBundle>,
    pub db: Option<AgentStore>,
    pub approver: Option<InteractiveApprover>,
    pub cancel_flag: Arc<AtomicBool>,
    /// D6 CaMeL/ARGUS provenance taint flag: escalates subsequent `shell`/`write`/`edit`/`patch`
    /// from `Yolo`/`Write` -> `AlwaysAsk` if prompt-injection or Unicode tag smuggling was detected!
    pub tainted_by_injection_signal: Arc<AtomicBool>,
    /// D2 BLAKE3 + deflate copy-on-write turn checkpoint store (never writes inside user workspace).
    pub checkpoint_store: Arc<Mutex<TurnCheckpointStore>>,
    /// D7 KV-cache-invariant deferred MCP/extension tool registry (populated with semantic LSP/graph tools).
    pub deferred_tools: Arc<DeferredToolRegistry>,
    /// Lazy On-Demand LSP coordinator (`0 ms` cold start).
    pub lsp_manager: LazyLspManager,
    /// Optional host/MCP extension dispatcher.
    pub extension_handler: Option<ExtensionToolHandler>,
    /// Current active turn index stamped by `NativeSuperEngine`.
    pub current_turn: Arc<AtomicU32>,
    /// MCP 2026-07-28 client manager (stdio zero-flash, HTTP/SSE, OAuth PKCE/CIMD, tasks, search).
    pub mcp_manager: Arc<McpManager>,
    /// Persistent ConPTY interactive shell + Python REPL manager.
    pub pty_manager: Arc<PtyManager>,
    /// Debug Adapter Protocol client (`debugpy`, `lldb-dap`, `dlv`).
    pub dap_manager: Arc<DapManager>,
    /// Isolated WebSocket CDP browser manager (never touches Thorium).
    pub browser_manager: Arc<BrowserToolManager>,
    /// 25-event lifecycle hook registry (`exit 2` deterministic block).
    pub hook_registry: Arc<HookRegistry>,
    /// Cordis dynamic reversible plugin + Creator Mode manager.
    pub dynamic_plugins: Arc<CordisPluginManager>,
    /// Hindsight/Graphiti/HippoRAG/ACE memory engine.
    pub memory: Option<Arc<MemoryEngine>>,
    /// Bidirectional all-to-all peer-mesh swarm & advisor watchdog runtime.
    pub swarm: Arc<SwarmRuntime>,
    /// Test-time scaling configuration.
    pub tts_config: TestTimeScalingConfig,
    /// Explicit per-tool handlers registered via `register_deferred_tool`.
    pub deferred_handlers: Arc<Mutex<HashMap<String, ExtensionToolHandler>>>,
    /// Dynamic read-only flag overrides for deferred tools.
    pub read_only_overrides: Arc<Mutex<HashSet<String>>>,
}

impl ToolRuntime {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        workspace_root: PathBuf,
        approval_mode: ApprovalMode,
        workspace_trusted: bool,
        permission_rules: Vec<PermissionRule>,
        graph_index: Arc<Mutex<WorkspaceGraphIndex>>,
        context_bundle: Arc<WorkspaceContextBundle>,
        db: Option<AgentStore>,
        approver: Option<InteractiveApprover>,
        cancel_flag: Arc<AtomicBool>,
    ) -> Self {
        let session_key = format!("rt-{}", uuid::Uuid::new_v4());
        Self::new_with_session(
            session_key,
            workspace_root,
            approval_mode,
            workspace_trusted,
            permission_rules,
            graph_index,
            context_bundle,
            db,
            approver,
            cancel_flag,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new_with_session(
        session_key: String,
        workspace_root: PathBuf,
        approval_mode: ApprovalMode,
        workspace_trusted: bool,
        permission_rules: Vec<PermissionRule>,
        graph_index: Arc<Mutex<WorkspaceGraphIndex>>,
        context_bundle: Arc<WorkspaceContextBundle>,
        db: Option<AgentStore>,
        approver: Option<InteractiveApprover>,
        cancel_flag: Arc<AtomicBool>,
    ) -> Self {
        let clean_root = sanitize_windows_path(&workspace_root);
        let cp_store = TurnCheckpointStore::new(session_key.clone(), db.clone());
        let hook_registry = Arc::new(
            HookRegistry::load_from_workspace(&clean_root)
                .unwrap_or_else(|_| HookRegistry::new(&clean_root)),
        );
        let dynamic_plugins = Arc::new(CordisPluginManager::new(&clean_root));
        let _ = dynamic_plugins.discover(Some(&hook_registry));

        let mut deferred = DeferredToolRegistry::new();
        for spec in builtin_deferred_semantic_tools() {
            deferred.register(spec);
        }
        let mut ro_overrides = HashSet::new();
        for (tool_name, def) in dynamic_plugins.active_tools() {
            if def.read_only {
                ro_overrides.insert(tool_name.clone());
            }
            deferred.register(ToolSpec {
                name: tool_name,
                description: def.description,
                parameters: def.parameters,
                read_only: def.read_only,
            });
        }
        let memory = if cfg!(test) && db.is_none() {
            MemoryEngine::open_in_memory().ok().map(Arc::new)
        } else {
            MemoryEngine::open_default(db.clone())
                .or_else(|_| MemoryEngine::open_in_memory())
                .ok()
                .map(Arc::new)
        };
        let swarm = Arc::new(SwarmRuntime::new(6, memory.clone()));

        Self {
            session_key,
            lsp_manager: LazyLspManager::new(clean_root.clone()),
            mcp_manager: Arc::new(McpManager::new(&clean_root)),
            pty_manager: Arc::new(PtyManager::new(&clean_root)),
            dap_manager: Arc::new(DapManager::new(&clean_root)),
            browser_manager: Arc::new(BrowserToolManager::new()),
            hook_registry,
            dynamic_plugins,
            memory,
            swarm,
            tts_config: TestTimeScalingConfig::default(),
            workspace_root: clean_root,
            approval_mode,
            workspace_trusted,
            permission_rules,
            read_tracker: FileReadTracker::new(),
            graph_index,
            context_bundle,
            db,
            approver,
            cancel_flag,
            tainted_by_injection_signal: Arc::new(AtomicBool::new(false)),
            checkpoint_store: Arc::new(Mutex::new(cp_store)),
            deferred_tools: Arc::new(deferred),
            extension_handler: None,
            current_turn: Arc::new(AtomicU32::new(1)),
            deferred_handlers: Arc::new(Mutex::new(HashMap::new())),
            read_only_overrides: Arc::new(Mutex::new(ro_overrides)),
        }
    }

    /// Registers a live deferred extension tool schema + executable async handler.
    pub fn register_deferred_tool(
        &mut self,
        spec: ToolSpec,
        read_only: bool,
        handler: ExtensionToolHandler,
    ) {
        let name = spec.name.clone();
        Arc::make_mut(&mut self.deferred_tools).register(spec);
        self.deferred_handlers.lock().unwrap().insert(name.clone(), handler);
        if read_only {
            self.read_only_overrides.lock().unwrap().insert(name);
        }
    }

    pub fn is_read_only_tool(name: &str) -> bool {
        matches!(
            name,
            "read_file"
                | "search_code"
                | "workspace_map"
                | "load_skill"
                | "discover_tools"
                | "lsp_query"
                | "graph_traverse"
                | "search_entity"
                | "ast_grep"
                | "web_fetch"
                | "web_search"
                | "memory_recall"
                | "swarm_read"
                | "advisor_check"
                | "omni_kanban_list"
                | "omni_kb_search"
        )
    }

    #[must_use]
    pub fn is_tool_read_only(&self, name: &str) -> bool {
        Self::is_read_only_tool(name) || self.read_only_overrides.lock().unwrap().contains(name)
    }

    fn format_post_edit_diagnostics(&self, abs: &Path, run_compiler_check: bool) -> Option<String> {
        let mut notes = Vec::new();
        if run_compiler_check {
            if let Some(compiler_diag) = run_fast_compiler_syntax_check(&self.workspace_root, abs) {
                notes.push(compiler_diag);
            }
        }
        let diags = self.lsp_manager.diagnostics_for_file(abs, 200);
        for d in diags.into_iter().take(12) {
            notes.push(format!(
                "[{}] {}:{}:{}: {}",
                d.source.as_deref().unwrap_or(&d.severity),
                d.severity,
                d.line,
                d.column,
                d.message
            ));
        }
        if notes.is_empty() {
            None
        } else {
            Some(notes.join("\n"))
        }
    }

    fn sanitize_and_track_taint(&self, raw: &str, label: &str) -> String {
        let rep = sanitize_untrusted_text(raw, label);
        if rep.tainted {
            self.tainted_by_injection_signal
                .store(true, Ordering::Relaxed);
        }
        rep.cleaned
    }

    pub async fn authorize(&self, perm_tool: &str, target: &str) -> Result<()> {
        self.authorize_any(&[perm_tool], target).await
    }

    /// Unified multi-alias permission evaluation:
    /// - Deny ALWAYS wins across every alias.
    /// - D6 Provenance Taint Escalation (`CaMeL`/`ARGUS`): if tainted by indirect prompt-injection,
    ///   subsequent `shell`/`bash`/`write`/`edit`/`patch` actions escalate `Yolo`/`Write` -> `AlwaysAsk`!
    /// - Allow wins if ANY alias evaluates to Allow (and none Deny).
    /// - Ask prompts the interactive `approver` AT MOST ONCE.
    pub async fn authorize_any(&self, perm_tools: &[&str], target: &str) -> Result<()> {
        let primary = perm_tools.first().copied().unwrap_or("tool");
        let is_privileged = perm_tools.iter().any(|a| {
            matches!(
                a.to_ascii_lowercase().as_str(),
                "bash" | "shell" | "write" | "edit" | "patch" | "extension"
            )
        });
        let tainted = self.tainted_by_injection_signal.load(Ordering::Relaxed);
        let effective_mode = if tainted
            && is_privileged
            && matches!(self.approval_mode, ApprovalMode::Yolo | ApprovalMode::Write)
        {
            ApprovalMode::AlwaysAsk
        } else {
            self.approval_mode
        };

        let mut any_allow = false;
        let mut ask_reason = String::new();

        for &alias in perm_tools {
            let eval = PermissionsEngine::evaluate(
                &self.permission_rules,
                self.workspace_trusted,
                alias,
                target,
                effective_mode,
            );
            match eval.decision {
                PermissionDecision::Deny => {
                    bail!("Permission denied ({alias}): {}", eval.reason);
                }
                PermissionDecision::Allow => {
                    any_allow = true;
                }
                PermissionDecision::Ask => {
                    if ask_reason.is_empty() {
                        ask_reason = if tainted && effective_mode != self.approval_mode {
                            format!(
                                "Provenance taint escalated {:?} -> AlwaysAsk after prompt-injection/Unicode-tag signal ({})",
                                self.approval_mode, eval.reason
                            )
                        } else {
                            eval.reason
                        };
                    }
                }
            }
        }

        if any_allow {
            return Ok(());
        }

        if let Some(ref cb) = self.approver {
            let approved = cb(primary.to_string(), target.to_string()).await;
            if approved {
                Ok(())
            } else {
                bail!("User denied {primary} on '{target}'")
            }
        } else {
            bail!("Action requires interactive approval ({primary} on '{target}'): {ask_reason}")
        }
    }

    pub fn authorize_sync_non_interactive(&self, perm_tool: &str, target: &str) -> Result<()> {
        let eval = PermissionsEngine::evaluate(
            &self.permission_rules,
            self.workspace_trusted,
            perm_tool,
            target,
            self.approval_mode,
        );
        match eval.decision {
            PermissionDecision::Allow => Ok(()),
            PermissionDecision::Deny => bail!("Permission denied ({perm_tool}): {}", eval.reason),
            PermissionDecision::Ask => bail!(
                "Action requires approval ({perm_tool} on '{target}'): {}",
                eval.reason
            ),
        }
    }

    pub async fn execute(&self, tool_name: &str, args: &Value) -> ToolExecOutput {
        let t0 = Instant::now();
        let is_host = tool_name.starts_with("omni_") || tool_name.starts_with("mcp__");
        let (pre, effective_args) = match self.run_pre_tool_hook(tool_name, args, is_host, t0).await {
            Ok(pair) => pair,
            Err(blocked_out) => return blocked_out,
        };
        let res = if tool_name == "run_code" {
            self.exec_run_code(&effective_args).await
        } else {
            self.dispatch_non_ptc_tool(tool_name, &effective_args).await
        };
        self.finish_hooked_exec(tool_name, is_host, t0, pre, effective_args, res)
            .await
    }

    async fn execute_non_ptc(&self, tool_name: &str, args: &Value) -> ToolExecOutput {
        let t0 = Instant::now();
        let is_host = tool_name.starts_with("omni_") || tool_name.starts_with("mcp__");
        let (pre, effective_args) = match self.run_pre_tool_hook(tool_name, args, is_host, t0).await {
            Ok(pair) => pair,
            Err(blocked_out) => return blocked_out,
        };
        let res = if tool_name == "run_code" {
            Err(anyhow::anyhow!("recursive run_code inside PTC sandbox is forbidden"))
        } else {
            self.dispatch_non_ptc_tool(tool_name, &effective_args).await
        };
        self.finish_hooked_exec(tool_name, is_host, t0, pre, effective_args, res)
            .await
    }

    async fn run_pre_tool_hook(
        &self,
        tool_name: &str,
        args: &Value,
        is_host: bool,
        t0: Instant,
    ) -> std::result::Result<(crate::hooks::HookDispatchOutcome, Value), ToolExecOutput> {
        let pre = self
            .hook_registry
            .dispatch(
                HookEvent::PreToolUse,
                Some(tool_name),
                json!({ "tool": tool_name, "arguments": args }),
            )
            .await;
        if pre.blocked {
            return Err(ToolExecOutput {
                content: format!(
                    "Error: blocked by PreToolUse hook ({}): {}",
                    pre.blocking_hook_id.as_deref().unwrap_or("hook"),
                    pre.block_reason
                        .clone()
                        .unwrap_or_else(|| "deterministic exit 2 block".into())
                ),
                is_error: true,
                is_host_tool: is_host,
                duration_ms: t0.elapsed().as_millis() as u64,
            });
        }
        let effective_args = pre
            .revised_input
            .as_ref()
            .and_then(|v| v.get("arguments").cloned().or_else(|| Some(v.clone())))
            .unwrap_or_else(|| args.clone());
        Ok((pre, effective_args))
    }

    async fn finish_hooked_exec(
        &self,
        tool_name: &str,
        is_host: bool,
        t0: Instant,
        pre: crate::hooks::HookDispatchOutcome,
        effective_args: Value,
        res: Result<String>,
    ) -> ToolExecOutput {
        let duration_ms = t0.elapsed().as_millis() as u64;
        match res {
            Ok(mut content) => {
                let post = self
                    .hook_registry
                    .dispatch(
                        HookEvent::PostToolUse,
                        Some(tool_name),
                        json!({
                            "tool": tool_name,
                            "arguments": effective_args,
                            "duration_ms": duration_ms
                        }),
                    )
                    .await;
                let mut ctx_notes = pre.additional_context;
                ctx_notes.extend(post.additional_context);
                if !ctx_notes.is_empty() {
                    content.push_str("\n[hooks] ");
                    content.push_str(&ctx_notes.join(" | "));
                }
                let out_cap = if (tool_name == "read_file"
                    && effective_args.get("paths").and_then(Value::as_array).is_some())
                    || (tool_name == "run_code"
                        && effective_args
                            .get("code")
                            .and_then(Value::as_str)
                            .is_some_and(|c| c.contains("read_file") || c.contains("parallel(")))
                {
                    MAX_BATCH_READ_CHARS
                } else {
                    MAX_TOOL_OUTPUT_CHARS
                };
                ToolExecOutput {
                    content: cap_output_traceback_preserving(&content, out_cap),
                    is_error: false,
                    is_host_tool: is_host,
                    duration_ms,
                }
            }
            Err(err) => {
                let _ = self
                    .hook_registry
                    .dispatch(
                        HookEvent::PostToolUseFailure,
                        Some(tool_name),
                        json!({
                            "tool": tool_name,
                            "error": err.to_string(),
                            "duration_ms": duration_ms
                        }),
                    )
                    .await;
                ToolExecOutput {
                    content: format!("Error: {err}"),
                    is_error: true,
                    is_host_tool: is_host,
                    duration_ms,
                }
            }
        }
    }

    async fn dispatch_non_ptc_tool(&self, tool_name: &str, args: &Value) -> Result<String> {
        match tool_name {
            "invoke_extension_tool" => self.exec_invoke_extension_tool(args).await,
            _ => self.dispatch_leaf_tool(tool_name, args).await,
        }
    }

    async fn dispatch_leaf_tool(&self, tool_name: &str, args: &Value) -> Result<String> {
        match tool_name {
            "read_file" => self.exec_read_file(args).await,
            "edit_file" => self.exec_edit_file(args).await,
            "apply_patch" | "patch_file" => self.exec_apply_patch(args).await,
            "write_file" => self.exec_write_file(args).await,
            "search_code" => self.exec_search_code(args).await,
            "workspace_map" => self.exec_workspace_map(args).await,
            "shell" => self.exec_shell(args).await,
            "load_skill" => self.exec_load_skill(args).await,
            "discover_tools" => self.exec_discover_tools(args).await,
            "lsp_query" => self.exec_lsp_query(args).await,
            "graph_traverse" => self.exec_graph_traverse(args),
            "search_entity" => self.exec_search_entity(args),
            "ast_grep" => self.exec_ast_grep(args).await,
            "ast_edit" => self.exec_ast_edit(args).await,
            "pty_exec" => self.exec_pty_exec(args).await,
            "dap" => self.exec_dap(args).await,
            "web_fetch" => self.exec_web_fetch(args).await,
            "web_search" => self.exec_web_search(args).await,
            "browser" => self.exec_browser(args).await,
            "mcp_call" => self.exec_mcp_call(args).await,
            "mcp_manage" => self.exec_mcp_manage(args).await,
            "recipe_run" => self.exec_recipe_run(args).await,
            "plugin_manage" => self.exec_plugin_manage(args).await,
            "memory_recall" | "memory_retain" | "memory_reflect" | "memory_edit" => {
                let mem = self
                    .memory
                    .as_ref()
                    .context("memory engine unavailable")?;
                dispatch_memory_tool_json(mem, &self.workspace_root, tool_name, args)
            }
            "swarm_register" | "swarm_message" | "swarm_read" | "auto_parallel_plan"
            | "advisor_check" => dispatch_swarm_tool_json(&self.swarm, tool_name, args),
            "test_scale_run" => dispatch_test_scale_tool_json(&self.tts_config, args),
            other => {
                let handler_opt = self.deferred_handlers.lock().unwrap().get(other).cloned();
                if let Some(h) = handler_opt {
                    self.authorize("extension", other).await?;
                    return h(other.to_owned(), args.clone()).await;
                }
                if other.starts_with("mcp__") || other.starts_with("omni_") {
                    return self.exec_host_tool(other, args).await;
                }
                if let Some((_, def)) = self
                    .dynamic_plugins
                    .active_tools()
                    .into_iter()
                    .find(|(n, _)| n == other)
                {
                    return self.exec_dynamic_plugin_tool(other, &def, args).await;
                }
                Err(anyhow::anyhow!(
                    "{}",
                    format_fail_fast_error(
                        "unknown tool",
                        "tool_name",
                        other,
                        "Use one of the active workspace tools, run_code, or discover_tools"
                    )
                ))
            }
        }
    }

    async fn read_single_file_formatted(
        &self,
        rel: &str,
        start_opt: Option<usize>,
        end_opt: Option<usize>,
        symbol_opt: Option<&str>,
        char_budget: usize,
    ) -> Result<String> {
        let abs = ensure_within_workspace(&self.workspace_root, rel)?;
        self.authorize("read", &abs.to_string_lossy()).await?;

        if abs.is_dir() {
            let mut items = Vec::new();
            for entry in fs::read_dir(&abs)?.flatten() {
                let mut name = entry.file_name().to_string_lossy().into_owned();
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    name.push('/');
                }
                items.push(name);
            }
            items.sort();
            return Ok(format!(
                "Directory '{rel}' ({} entries):\n{}",
                items.len(),
                items.join("\n")
            ));
        }

        const MAX_READ_FILE_BYTES: u64 = 4 * 1024 * 1024;
        let file_meta = fs::metadata(&abs).with_context(|| {
            format_fail_fast_error(
                "failed to stat file",
                "path",
                rel,
                "Verify path exists via workspace_map or search_code",
            )
        })?;
        if file_meta.len() > MAX_READ_FILE_BYTES {
            bail!(
                "{}",
                format_fail_fast_error(
                    "file exceeds 4 MiB read_file safety cap",
                    "path",
                    &format!("{rel} ({} bytes)", file_meta.len()),
                    "Inspect targeted slices using search_code or bounded shell head/tail"
                )
            );
        }

        let raw_bytes = fs::read(&abs).with_context(|| {
            format_fail_fast_error(
                "failed to read file",
                "path",
                rel,
                "Verify path exists via workspace_map or search_code",
            )
        })?;
        if raw_bytes.iter().take(4096).any(|&b| b == 0) {
            bail!(
                "{}",
                format_fail_fast_error(
                    "binary file cannot be read as UTF-8 text",
                    "path",
                    &format!("{rel} ({} bytes)", raw_bytes.len()),
                    "Inspect binary metadata via shell instead of read_file"
                )
            );
        }
        // Record full file hash for Claude Code Pre-Read Guard
        self.read_tracker.record_read(&abs, &raw_bytes);

        let text = String::from_utf8_lossy(&raw_bytes).replace("\r\n", "\n");
        let lines: Vec<&str> = if text.is_empty() {
            Vec::new()
        } else {
            text.strip_suffix('\n')
                .unwrap_or(&text)
                .split('\n')
                .collect()
        };
        let total = lines.len();

        let rel_norm = abs
            .strip_prefix(&self.workspace_root)
            .unwrap_or(&abs)
            .to_string_lossy()
            .replace('\\', "/");

        // D5: Symbol-targeted AST span jump (`read_file(path, symbol="...")`)
        let (eff_start_opt, eff_end_opt, symbol_banner) = if let Some(sym_q) = symbol_opt {
            let mut g = self.graph_index.lock().unwrap();
            let _ = g.refresh();
            if let Some(sym) = g.find_symbol_span(&rel_norm, sym_q).cloned() {
                let s1 = (sym.start_line as usize).saturating_sub(2).max(1);
                let e1 = ((sym.end_line as usize) + 2).min(total.max(1));
                (
                    Some(s1),
                    Some(e1),
                    Some(format!(
                        "[symbol: {} ({}) L{}-L{}]\n",
                        sym.qualified_name,
                        sym.kind.label(),
                        sym.start_line,
                        sym.end_line
                    )),
                )
            } else {
                let avail: Vec<String> = g
                    .parsed_asts()
                    .get(&rel_norm)
                    .map(|a| {
                        a.symbols
                            .iter()
                            .take(12)
                            .map(|s| s.qualified_name.clone())
                            .collect()
                    })
                    .unwrap_or_default();
                bail!(
                    "{}",
                    format_fail_fast_error(
                        "AST symbol not found in file",
                        "symbol",
                        &format!("{sym_q} in {rel}"),
                        &format!("Use start_line/end_line or one of: [{}]", avail.join(", "))
                    )
                );
            }
        } else {
            (start_opt, end_opt, None)
        };

        // D5: cAST AST-boundary snap + skeleton auto-outline on unbounded oversized reads (>400 lines)
        let unbounded_oversized =
            eff_start_opt.is_none() && eff_end_opt.is_none() && total > MAX_READ_LINES_DEFAULT;
        let start_1 = eff_start_opt.map(|n| n.max(1)).unwrap_or(1);
        let default_end = if unbounded_oversized {
            let mut g = self.graph_index.lock().unwrap();
            if g.parsed_asts().is_empty() {
                let _ = g.refresh();
            }
            g.snap_line_to_ast_boundary(&rel_norm, 260, total)
        } else {
            (start_1 + MAX_READ_LINES_DEFAULT - 1).min(total)
        };
        let end_1 = eff_end_opt.map(|n| n.min(total)).unwrap_or(default_end);

        if start_1 > total && total > 0 {
            bail!(
                "{}",
                format_fail_fast_error(
                    "start_line exceeds file length",
                    "start_line",
                    &format!("{start_1} (file has {total} lines)"),
                    &format!("Pass start_line <= {total}")
                )
            );
        }

        let mut out = symbol_banner.unwrap_or_default();
        let mut shown_end = start_1.saturating_sub(1);
        let mut char_budget_hit = false;

        if !lines.is_empty() && start_1 <= end_1 {
            for idx in (start_1 - 1)..end_1 {
                let prev = if idx > 0 { lines[idx - 1].trim() } else { "" };
                let curr = lines[idx].trim();
                let next = if idx + 1 < total {
                    lines[idx + 1].trim()
                } else {
                    ""
                };
                let tag = line_hash_tag(prev, curr, next);
                let line_str = format!("{}\n", format_hashline(idx + 1, &tag, lines[idx]));
                if out.len() + line_str.len() > char_budget && !out.is_empty() {
                    char_budget_hit = true;
                    break;
                }
                out.push_str(&line_str);
                shown_end = idx + 1;
            }
        }

        if shown_end < total || start_1 > 1 || char_budget_hit {
            out.push_str(&format!(
                "[file: {rel} | showing lines {start_1}..{shown_end} of {total}]"
            ));
            if unbounded_oversized && shown_end < total {
                let g = self.graph_index.lock().unwrap();
                if let Some(skel) = g.render_ast_skeleton_after(&rel_norm, shown_end, total) {
                    out.push('\n');
                    out.push_str(skel.trim_end());
                }
            }
        }

        // D6: Strip invisible Unicode Tag/Bidi smuggling & track provenance taint!
        Ok(self.sanitize_and_track_taint(&out, &rel_norm))
    }

    async fn exec_read_file(&self, args: &Value) -> Result<String> {
        if let Some(paths_arr) = args.get("paths").and_then(|v| v.as_array()) {
            let mut rels: Vec<&str> = paths_arr
                .iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect();
            if !rels.is_empty() {
                let overflow = rels.len().saturating_sub(MAX_BATCH_READ_FILES);
                rels.truncate(MAX_BATCH_READ_FILES);
                let mut sections = Vec::with_capacity(rels.len());
                let mut remaining_budget = MAX_BATCH_READ_CHARS;
                let mut ok_count = 0usize;
                let mut err_count = 0usize;
                let count = rels.len();

                for (i, rel) in rels.iter().enumerate() {
                    let files_left = (count - i).max(1);
                    let file_budget = (remaining_budget / files_left)
                        .clamp(MIN_BATCH_FILE_READ_CHARS, MAX_READ_CHARS);
                    match self
                        .read_single_file_formatted(rel, None, None, None, file_budget)
                        .await
                    {
                        Ok(body) => {
                            ok_count += 1;
                            remaining_budget = remaining_budget.saturating_sub(body.len());
                            sections.push(format!("=== {rel} ===\n{}", body.trim_end()));
                        }
                        Err(e) => {
                            err_count += 1;
                            sections.push(format!("=== [ERROR] {rel} ===\n{e}"));
                        }
                    }
                }
                if overflow > 0 {
                    sections.push(format!(
                        "[note: capped batch read at {MAX_BATCH_READ_FILES} files; {overflow} extra path(s) omitted]"
                    ));
                }
                if ok_count == 0 && err_count > 0 {
                    bail!("{}", sections.join("\n\n"));
                }
                return Ok(sections.join("\n\n"));
            }
        }

        let rel = args.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
            anyhow::anyhow!(
                "{}",
                format_fail_fast_error(
                    "missing required file path",
                    "path",
                    "missing",
                    "Provide string `path` or array `paths`"
                )
            )
        })?;
        let start_opt = args
            .get("start_line")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize);
        let end_opt = args
            .get("end_line")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize);
        let symbol_opt = args
            .get("symbol")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        self.read_single_file_formatted(rel, start_opt, end_opt, symbol_opt, MAX_READ_CHARS)
            .await
    }

    async fn exec_edit_file(&self, args: &Value) -> Result<String> {
        // Accept common search/replace argument aliases emitted by GPT/Gemini/Claude families.
        let str_arg = |keys: &[&str]| -> Option<&str> {
            keys.iter()
                .find_map(|k| args.get(*k).and_then(|v| v.as_str()))
        };
        let rel = str_arg(&["path", "file_path", "filepath", "file", "filename"])
            .context("edit_file requires string parameter 'path'")?;
        let new_str = str_arg(&[
            "new_string",
            "new_text",
            "new_str",
            "newText",
            "replacement",
            "replace",
        ])
        .context("edit_file requires string parameter 'new_string'")?;
        let start_anchor = str_arg(&["start_anchor", "anchor"])
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let end_anchor = str_arg(&["end_anchor"])
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let abs = ensure_within_workspace(&self.workspace_root, rel)?;
        self.authorize("edit", &abs.to_string_lossy()).await?;

        // D2: Capture Copy-on-Write BLAKE3 pre-mutation checkpoint
        let turn = self.current_turn.load(Ordering::Relaxed);
        self.checkpoint_store
            .lock()
            .unwrap()
            .record_pre_mutation(turn, rel, &abs);

        let symbol_block = args
            .get("symbol")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let res = if let Some(sa) = start_anchor {
            edit_file_by_hashline(
                &self.workspace_root,
                rel,
                sa,
                end_anchor,
                new_str,
                &self.read_tracker,
            )?
        } else if let Some(sym_name) = symbol_block {
            let span = {
                let mut g = self.graph_index.lock().unwrap();
                let _ = g.refresh();
                g.find_symbol_span(rel, sym_name)
                    .map(|s| (s.start_line as usize, s.end_line as usize))
            };
            let (s_line, e_line) = span.ok_or_else(|| {
                anyhow::anyhow!(
                    "{}",
                    format_fail_fast_error(
                        "symbol not found in file for syntactic block edit",
                        "symbol",
                        sym_name,
                        "Inspect exact symbol names via workspace_map or read_file"
                    )
                )
            })?;
            edit_file_by_symbol_block(
                &self.workspace_root,
                rel,
                sym_name,
                s_line,
                e_line,
                new_str,
                &self.read_tracker,
            )?
        } else {
            let old_str = str_arg(&[
                "old_string",
                "old_text",
                "old_str",
                "oldText",
                "search",
                "find",
            ])
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "{}",
                    format_fail_fast_error(
                        "edit_file requires start_anchor, symbol, or old_string",
                        "old_string",
                        "missing",
                        "Pass `start_anchor` (e.g. '42:a3f'), `symbol`, or exact `old_string`"
                    )
                )
            })?;
            let replace_all = args
                .get("replace_all")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            edit_file_guarded(
                &self.workspace_root,
                rel,
                old_str,
                new_str,
                replace_all,
                &self.read_tracker,
            )?
        };

        let mut msg = format!(
            "Edited '{}' ({} replacement(s), mode={}, lines {}..{}).",
            res.path, res.replacements, res.match_mode, res.line_start, res.line_end
        );
        if !res.diff_preview.is_empty() {
            msg.push('\n');
            msg.push_str(&res.diff_preview);
        }
        if !res.syntax_diagnostics.is_empty() {
            msg.push('\n');
            msg.push_str(&res.syntax_diagnostics.join("\n"));
        }
        if let Some(live_diag) =
            self.format_post_edit_diagnostics(&abs, res.syntax_diagnostics.is_empty())
        {
            msg.push('\n');
            msg.push_str(&live_diag);
        }
        Ok(msg)
    }

    async fn exec_apply_patch(&self, args: &Value) -> Result<String> {
        let patch_text = args
            .get("patch")
            .and_then(|v| v.as_str())
            .context("apply_patch requires string parameter 'patch'")?;

        // Phase 1: Parse & validate ALL touched paths for workspace containment + Deny rules BEFORE prompting!
        let ops = parse_codex_patch(patch_text)?;
        let mut touched_rel: Vec<String> = Vec::new();
        let mut ask_targets: Vec<String> = Vec::new();

        for op in &ops {
            let paths: Vec<&str> = match op {
                FilePatchOp::Add { path, .. } | FilePatchOp::Delete { path } => {
                    vec![path.as_str()]
                }
                FilePatchOp::Update { path, move_to, .. } => {
                    let mut v = vec![path.as_str()];
                    if let Some(dst) = move_to.as_deref() {
                        v.push(dst);
                    }
                    v
                }
            };
            for rel in paths {
                let abs = ensure_within_workspace(&self.workspace_root, rel)?;
                let target_str = abs.to_string_lossy().into_owned();
                let mut file_allowed = false;
                for alias in ["patch", "write"] {
                    let eval = PermissionsEngine::evaluate(
                        &self.permission_rules,
                        self.workspace_trusted,
                        alias,
                        &target_str,
                        self.approval_mode,
                    );
                    match eval.decision {
                        PermissionDecision::Deny => {
                            bail!("Permission denied ({alias}) on '{rel}': {}", eval.reason);
                        }
                        PermissionDecision::Allow => {
                            file_allowed = true;
                        }
                        PermissionDecision::Ask => {}
                    }
                }
                if !file_allowed && !ask_targets.iter().any(|p| p == rel) {
                    ask_targets.push(rel.to_string());
                }
                if !touched_rel.iter().any(|p| p == rel) {
                    touched_rel.push(rel.to_string());
                }
            }
        }

        // Phase 2: If any file requires Ask (AlwaysAsk, untrusted workspace, or D6 provenance taint), prompt ONCE
        let tainted = self.tainted_by_injection_signal.load(Ordering::Relaxed);
        if tainted
            && ask_targets.is_empty()
            && matches!(self.approval_mode, ApprovalMode::Yolo | ApprovalMode::Write)
        {
            ask_targets = touched_rel.clone();
        }
        if !ask_targets.is_empty() {
            let summary_target = ask_targets.join(", ");
            if let Some(ref cb) = self.approver {
                let approved = cb("apply_patch".to_string(), summary_target.clone()).await;
                if !approved {
                    bail!("User denied apply_patch on [{summary_target}]");
                }
            } else {
                bail!("Action requires interactive approval (apply_patch on [{summary_target}])");
            }
        }

        // D2: Snapshot all pre-mutation files before applying patch
        let turn = self.current_turn.load(Ordering::Relaxed);
        {
            let mut cp = self.checkpoint_store.lock().unwrap();
            for rel in &touched_rel {
                if let Ok(abs) = ensure_within_workspace(&self.workspace_root, rel) {
                    cp.record_pre_mutation(turn, rel, &abs);
                }
            }
        }

        // Phase 3: Apply atomically while STILL enforcing every Deny rule in the inner callback
        let rules = &self.permission_rules;
        let trusted = self.workspace_trusted;
        let report = apply_codex_patch(&self.workspace_root, patch_text, |tool, abs| {
            let target_str = abs.to_string_lossy();
            for alias in [tool, "write"] {
                let eval = PermissionsEngine::evaluate(
                    rules,
                    trusted,
                    alias,
                    &target_str,
                    ApprovalMode::Yolo,
                );
                if eval.decision == PermissionDecision::Deny {
                    bail!("Permission denied ({alias}): {}", eval.reason);
                }
            }
            Ok(())
        })?;

        // Refresh read_tracker for updated/added files so follow-up edit_file works seamlessly
        for p in &report.touched_paths {
            if p.exists() {
                self.read_tracker.refresh_from_disk(p);
            }
        }

        let mut summary = String::from("Patch applied atomically:");
        if !report.added.is_empty() {
            summary.push_str(&format!("\n  added: {}", report.added.join(", ")));
        }
        if !report.updated.is_empty() {
            summary.push_str(&format!("\n  updated: {}", report.updated.join(", ")));
        }
        if !report.moved.is_empty() {
            let mv: Vec<String> = report
                .moved
                .iter()
                .map(|(a, b)| format!("{a} -> {b}"))
                .collect();
            summary.push_str(&format!("\n  moved: {}", mv.join(", ")));
        }
        if !report.deleted.is_empty() {
            summary.push_str(&format!("\n  deleted: {}", report.deleted.join(", ")));
        }
        if !report.diff_preview.is_empty() {
            summary.push('\n');
            summary.push_str(&report.diff_preview);
        }
        if !report.syntax_diagnostics.is_empty() {
            summary.push('\n');
            summary.push_str(&report.syntax_diagnostics.join("\n"));
        }
        for p in &report.touched_paths {
            if p.exists() {
                if let Some(live_diag) =
                    self.format_post_edit_diagnostics(p, report.syntax_diagnostics.is_empty())
                {
                    summary.push('\n');
                    summary.push_str(&live_diag);
                }
            }
        }
        Ok(summary)
    }

    async fn exec_write_file(&self, args: &Value) -> Result<String> {
        let rel = args
            .get("path")
            .and_then(|v| v.as_str())
            .context("write_file requires string parameter 'path'")?;
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .context("write_file requires string parameter 'content'")?;

        let abs = ensure_within_workspace(&self.workspace_root, rel)?;
        self.authorize("write", &abs.to_string_lossy()).await?;

        // D2: Pre-mutation checkpoint + read prior text for D1 delta syntax verification & D8 BOM preservation
        let turn = self.current_turn.load(Ordering::Relaxed);
        self.checkpoint_store
            .lock()
            .unwrap()
            .record_pre_mutation(turn, rel, &abs);
        let before_text = fs::read_to_string(&abs).unwrap_or_default();
        let had_bom = before_text.starts_with('\u{FEFF}');

        // D8: BOM-free atomic temp-file-then-rename write
        atomic_write_bom_free(&abs, content, had_bom)
            .with_context(|| format!("failed to write '{rel}'"))?;
        let clean_content = if had_bom {
            content
        } else {
            content.strip_prefix('\u{FEFF}').unwrap_or(content)
        };
        self.read_tracker
            .record_read(&abs, clean_content.as_bytes());

        // D1: Zero-cost post-write AST, compiler & live LSP syntax verification
        let diags = verify_syntax_delta(rel, &before_text, clean_content, None).format_lines();
        let mut msg = format!(
            "Wrote '{}' ({} bytes, {} lines).",
            rel,
            clean_content.len(),
            clean_content.lines().count()
        );
        if !diags.is_empty() {
            msg.push('\n');
            msg.push_str(&diags.join("\n"));
        }
        if let Some(live_diag) = self.format_post_edit_diagnostics(&abs, diags.is_empty()) {
            msg.push('\n');
            msg.push_str(&live_diag);
        }
        Ok(msg)
    }

    async fn exec_search_code(&self, args: &Value) -> Result<String> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .context("search_code requires string parameter 'query'")?
            .to_string();
        if query.trim().is_empty() {
            bail!("search_code query must not be empty");
        }
        let literal = args
            .get("literal")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let mode = SearchMode::parse(args.get("mode").and_then(|v| v.as_str()), literal, &query);
        let case_sensitive = args
            .get("case_sensitive")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let context_lines = args
            .get("context_lines")
            .and_then(|v| v.as_u64())
            .map(|n| (n as usize).min(3))
            .unwrap_or(0);
        let max_matches = args
            .get("max_matches")
            .and_then(|v| v.as_u64())
            .map(|n| (n as usize).clamp(1, 200))
            .unwrap_or(60);

        let subpath = if let Some(sub) = args
            .get("path")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let abs = ensure_within_workspace(&self.workspace_root, sub)?;
            self.authorize("grep", &abs.to_string_lossy()).await?;
            let rel = abs
                .strip_prefix(&self.workspace_root)
                .unwrap_or(&abs)
                .to_string_lossy()
                .replace('\\', "/");
            if rel.is_empty() {
                None
            } else {
                Some(rel)
            }
        } else {
            self.authorize("grep", &self.workspace_root.to_string_lossy())
                .await?;
            None
        };

        let graph = Arc::clone(&self.graph_index);
        let rules = self.permission_rules.clone();
        let trusted = self.workspace_trusted;
        let approval = self.approval_mode;
        let out = tokio::task::spawn_blocking(move || -> Result<String> {
            let mut g = graph.lock().unwrap();
            let _ = g.refresh()?;
            let res = g.search(
                &query,
                mode,
                subpath.as_deref(),
                case_sensitive,
                context_lines,
                max_matches,
                &rules,
                trusted,
                approval,
            )?;
            Ok(res.formatted)
        })
        .await??;

        Ok(self.sanitize_and_track_taint(&out, "search_code"))
    }

    async fn exec_workspace_map(&self, args: &Value) -> Result<String> {
        let validated_subpath = if let Some(raw_sub) = args
            .get("subpath")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let abs = ensure_within_workspace(&self.workspace_root, raw_sub)?;
            self.authorize("ls", &abs.to_string_lossy()).await?;
            let rel = abs
                .strip_prefix(&self.workspace_root)
                .unwrap_or(&abs)
                .to_string_lossy()
                .replace('\\', "/");
            if rel.is_empty() {
                None
            } else {
                Some(rel)
            }
        } else {
            self.authorize("ls", &self.workspace_root.to_string_lossy())
                .await?;
            None
        };
        let query = args.get("query").and_then(|v| v.as_str()).map(String::from);
        let focus_symbol = args
            .get("focus_symbol")
            .and_then(|v| v.as_str())
            .map(String::from);
        let hops = args
            .get("hops")
            .and_then(|v| v.as_u64())
            .map(|n| (n as usize).clamp(1, 2))
            .unwrap_or(1);
        let max_files = args
            .get("max_files")
            .and_then(|v| v.as_u64())
            .map(|n| (n as usize).clamp(5, 120))
            .unwrap_or(40);

        let graph = Arc::clone(&self.graph_index);
        let outline = tokio::task::spawn_blocking(move || -> Result<String> {
            let mut g = graph.lock().unwrap();
            let _ = g.refresh()?;
            let map = g.build_map_focused(
                validated_subpath.as_deref(),
                query.as_deref(),
                focus_symbol.as_deref(),
                hops,
                max_files,
            );
            Ok(map.outline_text)
        })
        .await??;

        Ok(outline)
    }

    async fn exec_shell(&self, args: &Value) -> Result<String> {
        let command = args
            .get("command")
            .and_then(|v| v.as_str())
            .context("shell requires string parameter 'command'")?;
        if command.trim().is_empty() {
            bail!("shell command must not be empty");
        }
        let timeout_secs = args
            .get("timeout_secs")
            .and_then(|v| v.as_u64())
            .map(|n| n.clamp(1, 180))
            .unwrap_or(60);
        let shell_choice = args
            .get("shell")
            .and_then(|v| v.as_str())
            .unwrap_or("auto")
            .to_string();

        // Unified alias authorization: Deny on EITHER "bash" or "shell" blocks; Allow on EITHER allows;
        // Ask prompts the user AT MOST ONCE!
        self.authorize_any(&["bash", "shell"], command).await?;

        let cwd = self.workspace_root.clone();
        let cmd_str = command.to_string();
        let cmd_for_run = cmd_str.clone();
        let cancel_flag = Arc::clone(&self.cancel_flag);

        let res = tokio::task::spawn_blocking(move || {
            run_supervised_shell(&cwd, &cmd_for_run, &shell_choice, timeout_secs, &cancel_flag)
        })
        .await?;

        match res {
            Ok(out) => {
                let maybe_compressed = if out.len() > SHELL_COMPACT_MIN_CHARS {
                    let comp = compress_tool_output(&cmd_str, &out, "", None, None);
                    if let Some(first_line) = out.lines().next().filter(|l| l.starts_with("exit_code:")) {
                        if !comp.content.starts_with("exit_code:") {
                            format!("{first_line}\n{}", comp.content)
                        } else {
                            comp.content
                        }
                    } else {
                        comp.content
                    }
                } else {
                    out
                };
                Ok(self.sanitize_and_track_taint(&maybe_compressed, "shell"))
            }
            Err(e) => {
                let cleaned = self.sanitize_and_track_taint(&e.to_string(), "shell");
                bail!("{cleaned}")
            }
        }
    }

    async fn exec_load_skill(&self, args: &Value) -> Result<String> {
        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .context("load_skill requires string parameter 'name'")?;
        self.context_bundle.load_skill_body(name)
    }

    async fn exec_discover_tools(&self, args: &Value) -> Result<String> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .context("discover_tools requires string parameter 'query'")?;
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| (n as usize).clamp(1, 10))
            .unwrap_or(5);
        let hits = self.deferred_tools.discover(query, limit);
        let mcp_hits = self.mcp_manager.search_tools(query, limit);
        if hits.is_empty() && mcp_hits.is_empty() {
            return Ok(format!(
                "No deferred extension tools matched '{query}' (total deferred: {}).",
                self.deferred_tools.len()
            ));
        }
        if mcp_hits.is_empty() {
            return Ok(serde_json::to_string_pretty(&hits)?);
        }
        Ok(serde_json::to_string_pretty(&json!({
            "builtin_deferred": hits,
            "mcp_tools": mcp_hits,
        }))?)
    }

    async fn exec_invoke_extension_tool(&self, args: &Value) -> Result<String> {
        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .context("invoke_extension_tool requires string parameter 'name'")?;
        if name == "invoke_extension_tool" || name == "discover_tools" || name == "run_code" {
            bail!("meta-tool `{name}` cannot be nested inside invoke_extension_tool");
        }
        let ext_args = args.get("arguments").cloned().unwrap_or_else(|| json!({}));

        let known_builtin = matches!(
            name,
            "lsp_query"
                | "graph_traverse"
                | "search_entity"
                | "ast_grep"
                | "ast_edit"
                | "pty_exec"
                | "dap"
                | "web_fetch"
                | "web_search"
                | "browser"
                | "mcp_call"
                | "mcp_manage"
                | "recipe_run"
                | "plugin_manage"
                | "memory_recall"
                | "memory_retain"
                | "memory_reflect"
                | "memory_edit"
                | "swarm_register"
                | "swarm_message"
                | "swarm_read"
                | "auto_parallel_plan"
                | "advisor_check"
                | "test_scale_run"
        );
        if known_builtin {
            return self.dispatch_leaf_tool(name, &ext_args).await;
        }
        let handler_opt = self.deferred_handlers.lock().unwrap().get(name).cloned();
        if let Some(h) = handler_opt {
            self.authorize("extension", name).await?;
            return h(name.to_string(), ext_args).await;
        }
        if name.starts_with("mcp__") || name.starts_with("omni_") {
            self.authorize("extension", name).await?;
            return self.exec_host_tool(name, &ext_args).await;
        }
        if let Some((_, def)) = self
            .dynamic_plugins
            .active_tools()
            .into_iter()
            .find(|(n, _)| n == name)
        {
            return self.exec_dynamic_plugin_tool(name, &def, &ext_args).await;
        }
        if self.deferred_tools.get(name).is_none() {
            bail!(
                "{}",
                format_fail_fast_error(
                    "unknown deferred extension tool",
                    "name",
                    name,
                    "Call discover_tools(query=...) first to inspect registered extension tool names"
                )
            );
        }
        self.authorize("extension", name).await?;
        if let Some(ref handler) = self.extension_handler {
            return handler(name.to_string(), ext_args).await;
        }
        bail!("deferred tool `{name}` has no registered executable handler (fail-closed)")
    }

    async fn exec_run_code(&self, args: &Value) -> Result<String> {
        let code = args
            .get("code")
            .and_then(Value::as_str)
            .context("run_code requires string parameter 'code'")?;
        self.authorize("extension", "run_code").await?;

        let req = PtcRunRequest {
            code: code.to_owned(),
            language: args
                .get("language")
                .and_then(Value::as_str)
                .map(str::to_owned),
            timeout_ms: args.get("timeout_ms").and_then(Value::as_u64),
            max_parallel_sub_calls: args
                .get("max_parallel_sub_calls")
                .and_then(Value::as_u64)
                .map(|n| n as usize),
        };
        let rt = self.clone();
        let invoker: PtcToolInvoker = Arc::new(move |tool_name, tool_args| {
            let rt = rt.clone();
            Box::pin(async move {
                if tool_name == "run_code" {
                    return PtcInnerToolOutput {
                        content: "recursive run_code inside PTC sandbox is forbidden".into(),
                        is_error: true,
                        duration_ms: 0,
                    };
                }
                let out = rt.execute_non_ptc(&tool_name, &tool_args).await;
                PtcInnerToolOutput {
                    content: out.content,
                    is_error: out.is_error,
                    duration_ms: out.duration_ms,
                }
            })
        });
        let res = run_code_sandbox(req, invoker).await?;
        let serialized = serde_json::to_string_pretty(&res)?;
        if !res.ok {
            bail!("{serialized}");
        }
        Ok(serialized)
    }

    async fn exec_lsp_query(&self, args: &Value) -> Result<String> {
        let action = args
            .get("action")
            .or_else(|| args.get("operation"))
            .and_then(Value::as_str)
            .unwrap_or("references");
        let rel_path = args
            .get("path")
            .and_then(Value::as_str)
            .context("lsp_query requires string parameter 'path'")?;
        let abs = ensure_within_workspace(&self.workspace_root, rel_path)?;
        let line = args.get("line").and_then(Value::as_u64).unwrap_or(1) as u32;
        let ch = args.get("character").and_then(Value::as_u64).unwrap_or(0) as u32;
        if action == "rename" {
            self.authorize("write", &abs.to_string_lossy()).await?;
            let new_name = args
                .get("new_name")
                .and_then(Value::as_str)
                .context("lsp_query rename requires string parameter 'new_name'")?
                .to_owned();
            let apply = args.get("apply").and_then(Value::as_bool).unwrap_or(true);
            let mgr = self.lsp_manager.clone();
            let rel_owned = rel_path.to_owned();
            let outcome = tokio::task::spawn_blocking(move || {
                mgr.rename_symbol(
                    &rel_owned,
                    line.max(1) as usize,
                    (ch as usize).saturating_add(1),
                    &new_name,
                    apply,
                )
            })
            .await??;
            if outcome.edits_applied > 0 {
                for mf in &outcome.files_modified {
                    if let Ok(mabs) = ensure_within_workspace(&self.workspace_root, mf) {
                        self.read_tracker.refresh_from_disk(&mabs);
                    }
                }
            }
            return Ok(serde_json::to_string_pretty(&outcome)?);
        }

        self.authorize("read", &abs.to_string_lossy()).await?;
        let sym = args.get("symbol").and_then(Value::as_str);
        let res = self
            .lsp_manager
            .query(action, rel_path, line, ch, sym, &self.graph_index)
            .await;
        Ok(serde_json::to_string_pretty(&res)?)
    }

    fn exec_graph_traverse(&self, args: &Value) -> Result<String> {
        let seed = args
            .get("seed")
            .and_then(Value::as_str)
            .context("graph_traverse requires string parameter 'seed'")?;
        let hops = args.get("hops").and_then(Value::as_u64).unwrap_or(2) as usize;
        let rep = {
            let mut g = self.graph_index.lock().unwrap();
            let _ = g.refresh();
            g.traverse_graph(seed, hops)
        };
        Ok(serde_json::to_string_pretty(&rep)?)
    }

    fn exec_search_entity(&self, args: &Value) -> Result<String> {
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .context("search_entity requires string parameter 'query'")?;
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(15) as usize;
        let hits = {
            let mut g = self.graph_index.lock().unwrap();
            let _ = g.refresh();
            g.search_entity(query, limit)
        };
        Ok(serde_json::to_string_pretty(&hits)?)
    }

    async fn exec_ast_grep(&self, args: &Value) -> Result<String> {
        let pattern = args
            .get("pattern")
            .and_then(Value::as_str)
            .context("ast_grep requires string parameter 'pattern'")?
            .to_owned();
        let lang = args
            .get("lang")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
        let target_abs = if let Some(rel) = args.get("path").and_then(Value::as_str) {
            let abs = ensure_within_workspace(&self.workspace_root, rel)?;
            self.authorize("read", &abs.to_string_lossy()).await?;
            Some(abs)
        } else {
            self.authorize("read", &self.workspace_root.to_string_lossy())
                .await?;
            None
        };
        let root = self.workspace_root.clone();
        let hits = tokio::task::spawn_blocking(move || {
            ast_grep_path(&root, target_abs.as_deref(), lang.as_deref(), &pattern, limit)
        })
        .await??;
        Ok(serde_json::to_string_pretty(&hits)?)
    }

    async fn exec_ast_edit(&self, args: &Value) -> Result<String> {
        let rel = args
            .get("path")
            .and_then(Value::as_str)
            .context("ast_edit requires string parameter 'path'")?;
        let pattern = args
            .get("pattern")
            .and_then(Value::as_str)
            .context("ast_edit requires string parameter 'pattern'")?;
        let rewrite = args
            .get("rewrite")
            .and_then(Value::as_str)
            .context("ast_edit requires string parameter 'rewrite'")?;
        let dry_run = args.get("dry_run").and_then(Value::as_bool).unwrap_or(false);

        let abs = ensure_within_workspace(&self.workspace_root, rel)?;
        if dry_run {
            self.authorize("read", &abs.to_string_lossy()).await?;
        } else {
            self.authorize("write", &abs.to_string_lossy()).await?;
        }
        let lang = args
            .get("lang")
            .and_then(Value::as_str)
            .and_then(AstLang::from_name)
            .or_else(|| AstLang::from_path(&abs))
            .ok_or_else(|| anyhow::anyhow!("unable to determine AST language for `{rel}`"))?;
        let before = fs::read_to_string(&abs)
            .with_context(|| format!("failed reading `{rel}` for ast_edit"))?;
        let had_bom = before.starts_with('\u{FEFF}');
        let (updated, receipt) = ast_edit_source(
            lang,
            &before,
            rel,
            &[AstRewriteOp {
                pat: pattern.to_owned(),
                out: rewrite.to_owned(),
            }],
        )?;
        let mut live_diag: Option<String> = None;
        if !dry_run && receipt.replacements > 0 {
            let turn = self.current_turn.load(Ordering::Relaxed);
            self.checkpoint_store
                .lock()
                .unwrap()
                .record_pre_mutation(turn, rel, &abs);
            atomic_write_bom_free(&abs, &updated, had_bom)?;
            self.read_tracker.record_read(&abs, updated.as_bytes());
            live_diag = self.format_post_edit_diagnostics(&abs, true);
        }
        Ok(serde_json::to_string_pretty(&json!({
            "dry_run": dry_run,
            "receipt": receipt,
            "diagnostics": live_diag,
        }))?)
    }

    async fn exec_pty_exec(&self, args: &Value) -> Result<String> {
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .context("pty_exec requires string parameter 'action'")?;
        match action {
            "list" => {
                self.authorize("ls", &self.workspace_root.to_string_lossy())
                    .await?;
                Ok(serde_json::to_string_pretty(&self.pty_manager.list())?)
            }
            "create" => {
                self.authorize_any(&["bash", "shell"], "pty:create").await?;
                let kind = match args.get("kind").and_then(Value::as_str).unwrap_or("shell") {
                    "python_repl" | "python" => PtyKind::PythonRepl,
                    "custom" => PtyKind::Custom,
                    _ => PtyKind::Shell,
                };
                let req = PtyCreateRequest {
                    kind,
                    command: args
                        .get("command")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    args: args
                        .get("args")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default(),
                    cwd: args.get("cwd").and_then(Value::as_str).map(str::to_owned),
                    cols: args.get("cols").and_then(Value::as_u64).unwrap_or(120) as u16,
                    rows: args.get("rows").and_then(Value::as_u64).unwrap_or(36) as u16,
                };
                let info = self.pty_manager.create(req)?;
                Ok(serde_json::to_string_pretty(&info)?)
            }
            "exec" => {
                let sid = args
                    .get("session_id")
                    .and_then(Value::as_str)
                    .context("pty_exec exec requires 'session_id'")?;
                let input = args
                    .get("input")
                    .and_then(Value::as_str)
                    .context("pty_exec exec requires 'input'")?;
                self.authorize_any(&["bash", "shell"], input).await?;
                let timeout_ms = args
                    .get("timeout_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(15_000);
                let mut res = self.pty_manager.exec_and_wait(sid, input, timeout_ms).await?;
                if res.output.len() > SHELL_COMPACT_MIN_CHARS {
                    res.output =
                        compress_tool_output("pty_exec", &res.output, "", res.exit_code, None)
                            .content;
                }
                res.output = self.sanitize_and_track_taint(&res.output, "pty_exec");
                Ok(serde_json::to_string_pretty(&res)?)
            }
            "write" => {
                let sid = args
                    .get("session_id")
                    .and_then(Value::as_str)
                    .context("pty_exec write requires 'session_id'")?;
                let input = args
                    .get("input")
                    .and_then(Value::as_str)
                    .context("pty_exec write requires 'input'")?;
                self.authorize_any(&["bash", "shell"], input).await?;
                self.pty_manager.write(sid, input.as_bytes())?;
                Ok(serde_json::to_string_pretty(&json!({ "ok": true, "session_id": sid }))?)
            }
            "read" => {
                let sid = args
                    .get("session_id")
                    .and_then(Value::as_str)
                    .context("pty_exec read requires 'session_id'")?;
                self.authorize("read", sid).await?;
                let max_bytes = args
                    .get("max_bytes")
                    .and_then(Value::as_u64)
                    .unwrap_or(65_536) as usize;
                let txt = self.pty_manager.read_scrollback(sid, max_bytes)?;
                Ok(self.sanitize_and_track_taint(&txt, "pty_read"))
            }
            "resize" => {
                let sid = args
                    .get("session_id")
                    .and_then(Value::as_str)
                    .context("pty_exec resize requires 'session_id'")?;
                let cols = args.get("cols").and_then(Value::as_u64).unwrap_or(120) as u16;
                let rows = args.get("rows").and_then(Value::as_u64).unwrap_or(36) as u16;
                self.pty_manager.resize(sid, cols, rows)?;
                Ok(serde_json::to_string_pretty(
                    &json!({ "ok": true, "session_id": sid, "cols": cols, "rows": rows }),
                )?)
            }
            "kill" => {
                let sid = args
                    .get("session_id")
                    .and_then(Value::as_str)
                    .context("pty_exec kill requires 'session_id'")?;
                let killed = self.pty_manager.kill(sid);
                Ok(serde_json::to_string_pretty(
                    &json!({ "killed": killed, "session_id": sid }),
                )?)
            }
            other => bail!("unsupported pty_exec action `{other}`"),
        }
    }

    async fn exec_dap(&self, args: &Value) -> Result<String> {
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .context("dap requires string parameter 'action'")?;
        self.authorize("extension", &format!("dap:{action}")).await?;
        let sid_opt = args.get("session_id").and_then(Value::as_str);
        match action {
            "list" => Ok(serde_json::to_string_pretty(&self.dap_manager.list_sessions())?),
            "launch" => {
                let adapter = args
                    .get("adapter")
                    .and_then(Value::as_str)
                    .context("dap launch requires 'adapter'")?
                    .to_owned();
                let program = args
                    .get("program")
                    .and_then(Value::as_str)
                    .context("dap launch requires 'program'")?
                    .to_owned();
                let req = DapLaunchRequest {
                    adapter,
                    program,
                    args: args
                        .get("args")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default(),
                    cwd: args.get("cwd").and_then(Value::as_str).map(str::to_owned),
                    env: HashMap::new(),
                    stop_on_entry: args
                        .get("stop_on_entry")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    adapter_command: None,
                    breakpoints: Vec::new(),
                };
                let summary = self.dap_manager.launch(req).await?;
                Ok(serde_json::to_string_pretty(&summary)?)
            }
            "attach" => {
                let adapter = args
                    .get("adapter")
                    .and_then(Value::as_str)
                    .context("dap attach requires 'adapter'")?
                    .to_owned();
                let req = DapAttachRequest {
                    adapter,
                    pid: args.get("pid").and_then(Value::as_u64).map(|n| n as u32),
                    host: args.get("host").and_then(Value::as_str).map(str::to_owned),
                    port: args.get("port").and_then(Value::as_u64).map(|n| n as u16),
                    cwd: args.get("cwd").and_then(Value::as_str).map(str::to_owned),
                    adapter_command: None,
                };
                let summary = self.dap_manager.attach(req).await?;
                Ok(serde_json::to_string_pretty(&summary)?)
            }
            "set_breakpoints" => {
                let sid = sid_opt.context("dap set_breakpoints requires 'session_id'")?;
                let file = args
                    .get("file")
                    .and_then(Value::as_str)
                    .context("dap set_breakpoints requires 'file'")?;
                let abs = ensure_within_workspace(&self.workspace_root, file)?;
                let lines = args
                    .get("lines")
                    .and_then(Value::as_array)
                    .context("dap set_breakpoints requires 'lines' array")?;
                let bps: Vec<DapInitialBreakpoint> = lines
                    .iter()
                    .filter_map(Value::as_u64)
                    .map(|ln| DapInitialBreakpoint {
                        file: abs.to_string_lossy().into_owned(),
                        line: ln as u32,
                        condition: None,
                    })
                    .collect();
                let res = self
                    .dap_manager
                    .set_breakpoints(sid, &abs.to_string_lossy(), &bps)
                    .await?;
                Ok(serde_json::to_string_pretty(&res)?)
            }
            "continue" => {
                let sid = sid_opt.context("dap continue requires 'session_id'")?;
                let tid = args.get("thread_id").and_then(Value::as_i64);
                Ok(serde_json::to_string_pretty(
                    &self.dap_manager.continue_exec(sid, tid).await?,
                )?)
            }
            "next" => {
                let sid = sid_opt.context("dap next requires 'session_id'")?;
                let tid = args.get("thread_id").and_then(Value::as_i64);
                Ok(serde_json::to_string_pretty(
                    &self.dap_manager.step_over(sid, tid).await?,
                )?)
            }
            "step_in" => {
                let sid = sid_opt.context("dap step_in requires 'session_id'")?;
                let tid = args.get("thread_id").and_then(Value::as_i64);
                Ok(serde_json::to_string_pretty(
                    &self.dap_manager.step_in(sid, tid).await?,
                )?)
            }
            "step_out" => {
                let sid = sid_opt.context("dap step_out requires 'session_id'")?;
                let tid = args.get("thread_id").and_then(Value::as_i64);
                Ok(serde_json::to_string_pretty(
                    &self.dap_manager.step_out(sid, tid).await?,
                )?)
            }
            "stack_trace" => {
                let sid = sid_opt.context("dap stack_trace requires 'session_id'")?;
                let tid = args.get("thread_id").and_then(Value::as_i64);
                Ok(serde_json::to_string_pretty(
                    &self.dap_manager.stack_trace(sid, tid, 20).await?,
                )?)
            }
            "scopes" => {
                let sid = sid_opt.context("dap scopes requires 'session_id'")?;
                let fid = args
                    .get("frame_id")
                    .and_then(Value::as_i64)
                    .context("dap scopes requires 'frame_id'")?;
                Ok(serde_json::to_string_pretty(
                    &self.dap_manager.scopes(sid, fid).await?,
                )?)
            }
            "variables" => {
                let sid = sid_opt.context("dap variables requires 'session_id'")?;
                let vref = args
                    .get("variables_reference")
                    .and_then(Value::as_i64)
                    .context("dap variables requires 'variables_reference'")?;
                Ok(serde_json::to_string_pretty(
                    &self.dap_manager.variables(sid, vref).await?,
                )?)
            }
            "evaluate" => {
                let sid = sid_opt.context("dap evaluate requires 'session_id'")?;
                let expr = args
                    .get("expression")
                    .and_then(Value::as_str)
                    .context("dap evaluate requires 'expression'")?;
                let fid = args.get("frame_id").and_then(Value::as_i64);
                Ok(serde_json::to_string_pretty(
                    &self.dap_manager.evaluate(sid, expr, fid, None).await?,
                )?)
            }
            "summary" => {
                let sid = sid_opt.context("dap summary requires 'session_id'")?;
                Ok(serde_json::to_string_pretty(
                    &self.dap_manager.summary(sid)?,
                )?)
            }
            "terminate" => {
                let sid = sid_opt.context("dap terminate requires 'session_id'")?;
                let ok = self.dap_manager.terminate(sid).await;
                Ok(serde_json::to_string_pretty(&json!({ "terminated": ok, "session_id": sid }))?)
            }
            other => bail!("unsupported dap action `{other}`"),
        }
    }

    async fn exec_web_fetch(&self, args: &Value) -> Result<String> {
        let url = args
            .get("url")
            .and_then(Value::as_str)
            .context("web_fetch requires string parameter 'url'")?;
        self.authorize("web_fetch", url).await?;
        let raw = args.get("raw").and_then(Value::as_bool).unwrap_or(false);
        let max_chars = args
            .get("max_chars")
            .and_then(Value::as_u64)
            .unwrap_or(16_000) as usize;
        let out = web_fetch(url, raw, max_chars).await?;
        let serialized = serde_json::to_string_pretty(&out)?;
        Ok(self.sanitize_and_track_taint(&serialized, "web_fetch"))
    }

    async fn exec_web_search(&self, args: &Value) -> Result<String> {
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .context("web_search requires string parameter 'query'")?;
        self.authorize("web_search", query).await?;
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(8) as usize;
        let out = web_search(query, limit).await?;
        let serialized = serde_json::to_string_pretty(&out)?;
        Ok(self.sanitize_and_track_taint(&serialized, "web_search"))
    }

    async fn exec_browser(&self, args: &Value) -> Result<String> {
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .context("browser requires string parameter 'action'")?;
        self.authorize("browser", action).await?;
        let sid_opt = args.get("session_id").and_then(Value::as_str);
        match action {
            "launch" => {
                let headless = args
                    .get("headless")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let url = args.get("url").and_then(Value::as_str).map(str::to_owned);
                Ok(serde_json::to_string_pretty(
                    &self.browser_manager.launch(headless, url).await?,
                )?)
            }
            "navigate" => {
                let sid = sid_opt.context("browser navigate requires 'session_id'")?;
                let url = args
                    .get("url")
                    .and_then(Value::as_str)
                    .context("browser navigate requires 'url'")?;
                let res = self.browser_manager.navigate(sid, url).await?;
                Ok(self.sanitize_and_track_taint(&serde_json::to_string_pretty(&res)?, "browser"))
            }
            "click" => {
                let sid = sid_opt.context("browser click requires 'session_id'")?;
                let selector = args.get("selector").and_then(Value::as_str);
                let x = args.get("x").and_then(Value::as_f64);
                let y = args.get("y").and_then(Value::as_f64);
                Ok(serde_json::to_string_pretty(
                    &self.browser_manager.click(sid, selector, x, y).await?,
                )?)
            }
            "type" => {
                let sid = sid_opt.context("browser type requires 'session_id'")?;
                let text = args
                    .get("text")
                    .and_then(Value::as_str)
                    .context("browser type requires 'text'")?;
                Ok(serde_json::to_string_pretty(
                    &self.browser_manager.type_text(sid, text).await?,
                )?)
            }
            "eval" => {
                let sid = sid_opt.context("browser eval requires 'session_id'")?;
                let expr = args
                    .get("expression")
                    .and_then(Value::as_str)
                    .context("browser eval requires 'expression'")?;
                let res = self.browser_manager.eval_js(sid, expr).await?;
                Ok(self.sanitize_and_track_taint(&serde_json::to_string_pretty(&res)?, "browser"))
            }
            "screenshot" => {
                let sid = sid_opt.context("browser screenshot requires 'session_id'")?;
                let b64 = self.browser_manager.screenshot(sid).await?;
                Ok(serde_json::to_string_pretty(&json!({
                    "session_id": sid,
                    "mime_type": "image/png",
                    "png_base64": b64,
                }))?)
            }
            "close" => {
                let sid = sid_opt.context("browser close requires 'session_id'")?;
                let closed = self.browser_manager.close(sid).await;
                Ok(serde_json::to_string_pretty(
                    &json!({ "closed": closed, "session_id": sid }),
                )?)
            }
            other => bail!("unsupported browser action `{other}`"),
        }
    }

    async fn exec_mcp_call(&self, args: &Value) -> Result<String> {
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_else(|| {
                if args.get("tool").is_some() {
                    "call"
                } else {
                    "search"
                }
            });
        match action {
            "search" => {
                let q = args.get("query").and_then(Value::as_str).unwrap_or("");
                let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(10) as usize;
                Ok(serde_json::to_string_pretty(
                    &self.mcp_manager.search_tools(q, limit),
                )?)
            }
            "list_servers" => Ok(serde_json::to_string_pretty(&self.mcp_manager.list_servers())?),
            "task_get" => {
                let srv = args
                    .get("server")
                    .and_then(Value::as_str)
                    .context("mcp_call task_get requires 'server'")?;
                let tid = args
                    .get("task_id")
                    .and_then(Value::as_str)
                    .context("mcp_call task_get requires 'task_id'")?;
                self.authorize("extension", srv).await?;
                Ok(serde_json::to_string_pretty(
                    &self.mcp_manager.get_task(srv, tid).await?,
                )?)
            }
            "task_cancel" => {
                let srv = args
                    .get("server")
                    .and_then(Value::as_str)
                    .context("mcp_call task_cancel requires 'server'")?;
                let tid = args
                    .get("task_id")
                    .and_then(Value::as_str)
                    .context("mcp_call task_cancel requires 'task_id'")?;
                self.authorize("extension", srv).await?;
                Ok(serde_json::to_string_pretty(
                    &self.mcp_manager.cancel_task(srv, tid).await?,
                )?)
            }
            "call" => {
                let tool = args
                    .get("tool")
                    .and_then(Value::as_str)
                    .context("mcp_call call requires 'tool'")?;
                let server = args.get("server").and_then(Value::as_str);
                let server_tool = args.get("server_tool").and_then(Value::as_str);
                let call_args = args.get("arguments").cloned().unwrap_or_else(|| json!({}));
                let (target, explicit) = if let Some(st) = server_tool {
                    (tool, Some(st))
                } else if let Some(srv) = server {
                    (srv, Some(tool))
                } else {
                    (tool, None)
                };
                self.authorize("extension", target).await?;
                let res = self.mcp_manager.call_tool(target, explicit, call_args).await?;
                let out = serde_json::to_string_pretty(&res)?;
                Ok(self.sanitize_and_track_taint(&out, "mcp_call"))
            }
            other => bail!("unsupported mcp_call action `{other}`"),
        }
    }

    async fn exec_mcp_manage(&self, args: &Value) -> Result<String> {
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .context("mcp_manage requires string parameter 'action'")?;
        self.authorize("extension", &format!("mcp_manage:{action}"))
            .await?;
        match action {
            "list" => Ok(serde_json::to_string_pretty(&self.mcp_manager.list_servers())?),
            "connect" => {
                let mut cfg_val = args
                    .get("config")
                    .cloned()
                    .context("mcp_manage connect requires 'config' object")?;
                if cfg_val.get("type").is_none() && cfg_val.get("command").is_some() {
                    cfg_val["type"] = json!("stdio");
                }
                let cfg: McpServerConfig = serde_json::from_value(cfg_val)?;
                let status = self.mcp_manager.connect_server(cfg).await?;
                Ok(serde_json::to_string_pretty(&status)?)
            }
            "disconnect" => {
                let name = args
                    .get("name")
                    .and_then(Value::as_str)
                    .context("mcp_manage disconnect requires 'name'")?;
                let removed = self.mcp_manager.disconnect_server(name).await;
                Ok(serde_json::to_string_pretty(
                    &json!({ "disconnected": removed, "name": name }),
                )?)
            }
            "refresh" => {
                let name = args
                    .get("name")
                    .and_then(Value::as_str)
                    .context("mcp_manage refresh requires 'name'")?;
                let count = self.mcp_manager.refresh_tools(name).await?;
                Ok(serde_json::to_string_pretty(
                    &json!({ "name": name, "tools_count": count }),
                )?)
            }
            other => bail!("unsupported mcp_manage action `{other}`"),
        }
    }

    async fn exec_recipe_run(&self, args: &Value) -> Result<String> {
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .context("recipe_run requires string parameter 'action'")?;
        self.authorize("read", &self.workspace_root.to_string_lossy())
            .await?;
        match action {
            "list" => {
                let list = discover_recipes(&self.workspace_root);
                Ok(serde_json::to_string_pretty(&list)?)
            }
            "render" => {
                let spec = if let Some(yaml) = args.get("yaml").and_then(Value::as_str) {
                    parse_recipe_yaml(yaml, None)?
                } else if let Some(rel) = args.get("path").and_then(Value::as_str) {
                    let abs = ensure_within_workspace(&self.workspace_root, rel)?;
                    let raw = fs::read_to_string(&abs)?;
                    parse_recipe_yaml(&raw, Some(abs))?
                } else {
                    bail!("recipe_run render requires 'yaml' or 'path'");
                };
                let supplied: HashMap<String, String> = args
                    .get("params")
                    .and_then(Value::as_object)
                    .map(|m| {
                        m.iter()
                            .filter_map(|(k, v)| {
                                v.as_str().map(|s| (k.clone(), s.to_owned())).or_else(|| {
                                    Some((k.clone(), v.to_string()))
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let rendered = validate_and_render_recipe(&spec, &supplied)?;
                Ok(serde_json::to_string_pretty(&rendered)?)
            }
            other => bail!("unsupported recipe_run action `{other}`"),
        }
    }

    async fn exec_plugin_manage(&self, args: &Value) -> Result<String> {
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .context("plugin_manage requires string parameter 'action'")?;
        self.authorize("extension", &format!("plugin_manage:{action}"))
            .await?;
        match action {
            "list" => Ok(serde_json::to_string_pretty(&self.dynamic_plugins.list())?),
            "discover" => {
                let found = self.dynamic_plugins.discover(Some(&self.hook_registry))?;
                Ok(serde_json::to_string_pretty(&found)?)
            }
            "create" => {
                let id = args
                    .get("id")
                    .and_then(Value::as_str)
                    .context("plugin_manage create requires 'id'")?;
                let name = args.get("name").and_then(Value::as_str).unwrap_or(id);
                let desc = args
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("Omnia Cordis dynamic plugin");
                let tool = match (
                    args.get("tool_name").and_then(Value::as_str),
                    args.get("command").and_then(Value::as_str),
                ) {
                    (Some(tn), Some(cmd)) => Some(DynamicPluginToolDef {
                        name: tn.to_owned(),
                        description: desc.to_owned(),
                        parameters: json!({"type": "object", "additionalProperties": true}),
                        command: cmd.to_owned(),
                        read_only: false,
                        timeout_ms: 15_000,
                    }),
                    _ => None,
                };
                let state = self.dynamic_plugins.create_scaffold(
                    id,
                    name,
                    desc,
                    tool,
                    None,
                    Some(&self.hook_registry),
                )?;
                Ok(serde_json::to_string_pretty(&state)?)
            }
            "enable" | "disable" => {
                let id = args
                    .get("id")
                    .and_then(Value::as_str)
                    .context("plugin_manage enable/disable requires 'id'")?;
                let state = self.dynamic_plugins.set_enabled(
                    id,
                    action == "enable",
                    Some(&self.hook_registry),
                )?;
                Ok(serde_json::to_string_pretty(&state)?)
            }
            "rollback" => {
                let id = args
                    .get("id")
                    .and_then(Value::as_str)
                    .context("plugin_manage rollback requires 'id'")?;
                let state = self
                    .dynamic_plugins
                    .rollback(id, Some(&self.hook_registry))?;
                Ok(serde_json::to_string_pretty(&state)?)
            }
            other => bail!("unsupported plugin_manage action `{other}`"),
        }
    }

    async fn exec_dynamic_plugin_tool(
        &self,
        tool_name: &str,
        def: &DynamicPluginToolDef,
        args: &Value,
    ) -> Result<String> {
        self.authorize("extension", tool_name).await?;
        let plugin_id = self
            .dynamic_plugins
            .list()
            .into_iter()
            .find(|p| p.manifest.tools.iter().any(|t| t.name == tool_name))
            .map(|p| p.manifest.id);

        let cwd = self.workspace_root.clone();
        let command = def.command.clone();
        let payload = serde_json::to_vec(args)?;
        let timeout_secs = (def.timeout_ms / 1000).clamp(1, 120);
        let cancel_flag = Arc::clone(&self.cancel_flag);
        let run_res = tokio::task::spawn_blocking(move || -> Result<String> {
            use std::io::Write;
            let mut cmd = build_shell_command("auto", &command);
            cmd.current_dir(&cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let (mut child, _sup) = spawn_supervised_command(&mut cmd)?;
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(&payload);
            }
            let deadline = Instant::now() + Duration::from_secs(timeout_secs);
            loop {
                if cancel_flag.load(Ordering::Relaxed) {
                    let _ = child.kill();
                    bail!("plugin execution cancelled");
                }
                if let Some(status) = child.try_wait()? {
                    let mut out = String::new();
                    let mut err = String::new();
                    if let Some(mut r) = child.stdout.take() {
                        let _ = r.read_to_string(&mut out);
                    }
                    if let Some(mut r) = child.stderr.take() {
                        let _ = r.read_to_string(&mut err);
                    }
                    if !status.success() {
                        bail!(
                            "dynamic plugin exited {}: {}",
                            status.code().unwrap_or(-1),
                            err.trim()
                        );
                    }
                    return Ok(out);
                }
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    bail!("dynamic plugin timed out after {timeout_secs}s");
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        })
        .await?;

        match (&plugin_id, &run_res) {
            (Some(pid), Ok(_)) => self.dynamic_plugins.record_success(pid),
            (Some(pid), Err(e)) => {
                let _ = self.dynamic_plugins.record_fault(
                    pid,
                    &e.to_string(),
                    Some(&self.hook_registry),
                );
            }
            _ => {}
        }
        run_res.map(|s| self.sanitize_and_track_taint(&s, tool_name))
    }

    async fn exec_host_tool(&self, tool_name: &str, args: &Value) -> Result<String> {
        if let Some(ref handler) = self.extension_handler {
            return handler(tool_name.to_string(), args.clone()).await;
        }
        if tool_name.starts_with("mcp__") {
            let res = self
                .mcp_manager
                .call_tool(tool_name, None, args.clone())
                .await?;
            return Ok(serde_json::to_string_pretty(&res)?);
        }
        anyhow::bail!(
            "host/extension tool `{tool_name}` has no registered live MCP or extension handler (fail-closed)"
        )
    }
}

/// Detect the fastest, highest-compatibility shell available on this host.
pub fn detect_default_shell() -> (&'static str, PathBuf) {
    #[cfg(windows)]
    {
        // Prefer Git Bash (POSIX syntax + 3x faster startup than pwsh + inherits Windows PATH cleanly!)
        for cand in [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files\Git\usr\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ] {
            let p = PathBuf::from(cand);
            if p.is_file() {
                return ("Git Bash (POSIX)", p);
            }
        }
        if let Ok(p) = which::which("pwsh") {
            return ("PowerShell 7 (pwsh)", p);
        }
        if let Ok(p) = which::which("powershell") {
            return ("Windows PowerShell", p);
        }
        ("cmd.exe", PathBuf::from("cmd.exe"))
    }
    #[cfg(not(windows))]
    {
        if Path::new("/bin/bash").is_file() {
            ("bash", PathBuf::from("/bin/bash"))
        } else {
            ("sh", PathBuf::from("/bin/sh"))
        }
    }
}

fn build_shell_command(shell_choice: &str, command: &str) -> Command {
    #[cfg(windows)]
    {
        match shell_choice {
            "cmd" => {
                let mut c = Command::new("cmd.exe");
                c.args(["/d", "/c", command]);
                c
            }
            "powershell" => {
                let mut c = Command::new("powershell.exe");
                c.args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    command,
                ]);
                c
            }
            "pwsh" => {
                let prog = which::which("pwsh").unwrap_or_else(|_| PathBuf::from("powershell.exe"));
                let mut c = Command::new(prog);
                c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
                c
            }
            "bash" => {
                let (_, def) = detect_default_shell();
                let prog = if def
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with("bash.exe")
                {
                    def
                } else {
                    PathBuf::from(r"C:\Program Files\Git\bin\bash.exe")
                };
                let mut c = Command::new(prog);
                c.args(["-c", command]);
                c
            }
            _ => {
                let (label, prog) = detect_default_shell();
                let mut c = Command::new(&prog);
                if label.contains("Bash") {
                    c.args(["-c", command]);
                } else if label.contains("PowerShell") {
                    c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
                } else {
                    c.args(["/d", "/c", command]);
                }
                c
            }
        }
    }
    #[cfg(not(windows))]
    {
        let prog = if shell_choice == "bash" && Path::new("/bin/bash").is_file() {
            "/bin/bash"
        } else {
            "/bin/sh"
        };
        let mut c = Command::new(prog);
        c.args(["-c", command]);
        c
    }
}

fn run_supervised_shell(
    cwd: &Path,
    command: &str,
    shell_choice: &str,
    timeout_secs: u64,
    cancel_flag: &AtomicBool,
) -> Result<String> {
    let mut cmd = build_shell_command(shell_choice, command);
    cmd.current_dir(cwd)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("MSYS_NO_PATHCONV", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("TERM", "dumb")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let (mut child, mut supervisor) =
        spawn_supervised_command(&mut cmd).context("failed to spawn supervised shell command")?;

    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();

    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut r) = out_pipe {
            let _ = r.take(512 * 1024).read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut r) = err_pipe {
            let _ = r.take(256 * 1024).read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    });

    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let mut timed_out = false;
    let mut cancelled = false;
    let exit_code: i32;
    let mut poll_ms = 1u64;

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            supervisor.kill_tree();
            let _ = child.kill();
            let _ = child.wait();
            exit_code = -2;
            break;
        }
        match child.try_wait() {
            Ok(Some(st)) => {
                exit_code = st.code().unwrap_or(-1);
                break;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    supervisor.kill_tree();
                    let _ = child.kill();
                    let _ = child.wait();
                    exit_code = -1;
                    break;
                }
                std::thread::sleep(Duration::from_millis(poll_ms));
                poll_ms = match poll_ms {
                    1 => 2,
                    2 => 5,
                    5 => 15,
                    _ => 15,
                };
            }
            Err(_) => {
                exit_code = -1;
                break;
            }
        }
    }

    // Explicitly close Job Object to guarantee ZERO surviving grandchildren!
    supervisor.kill_tree();

    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();

    let mut combined = String::new();
    if !stdout.is_empty() {
        combined.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str("[stderr]\n");
        combined.push_str(&stderr);
    }
    let scrubbed = scrub_shell_output(&combined);
    let compacted =
        compact_shell_output(command, &scrubbed, exit_code, Some(&std::env::temp_dir()));
    let capped = cap_output_traceback_preserving(&compacted, MAX_SHELL_OUTPUT_CHARS);

    if cancelled {
        bail!("Command cancelled by user.\n{capped}");
    }
    if timed_out {
        bail!("Command timed out after {timeout_secs}s (process tree killed).\n{capped}");
    }
    if exit_code < 0 {
        bail!("Command failed to run (exit_code {exit_code}).\n{capped}");
    }
    if exit_code != 0 {
        // Non-zero exit (e.g. failing tests) is valid command OUTPUT, not a tool failure.
        return Ok(format!(
            "exit_code: {exit_code}\nCommand exited with code {exit_code}.\n{capped}"
        ));
    }

    if capped.trim().is_empty() {
        Ok(json!({ "exitCode": 0, "output": "(no output)" }).to_string())
    } else {
        Ok(format!("exit_code: 0\n{capped}"))
    }
}

/// Command-aware `rtk`-style shell output micro-compactor (D3, `arXiv:2604.04979` / `rtk-ai/rtk`).
///
/// - Leaves short outputs (`<= 1,800` chars) 100% verbatim.
/// - Compacts noisy boilerplate from `cargo`, `pytest`/`unittest`/`jest`/`vitest`/`bun test`,
///   `git diff` lockfiles, and `pip`/`uv`/`npm`/`bun` install while preserving 100% of errors,
///   tracebacks, warnings, and test summaries!
/// - Writes lossless raw spill log ONLY to system temp dir (NEVER inside user workspace!) when
///   compaction saves `> 1,500` chars.
pub fn compact_shell_output(
    command: &str,
    scrubbed: &str,
    _exit_code: i32,
    spill_dir: Option<&Path>,
) -> String {
    if scrubbed.len() <= SHELL_COMPACT_MIN_CHARS {
        return scrubbed.to_string();
    }

    let cmd_low = command.to_ascii_lowercase();
    let compacted = if cmd_low.contains("cargo ")
        && (cmd_low.contains("test")
            || cmd_low.contains("check")
            || cmd_low.contains("build")
            || cmd_low.contains("clippy"))
    {
        compact_cargo_output(scrubbed)
    } else if cmd_low.contains("pytest")
        || cmd_low.contains("unittest")
        || cmd_low.contains("jest")
        || cmd_low.contains("vitest")
        || cmd_low.contains("bun test")
    {
        compact_test_runner_output(scrubbed)
    } else if cmd_low.contains("git diff") || cmd_low.contains("git show") {
        compact_git_diff_lockfiles(scrubbed)
    } else if (cmd_low.contains("pip ")
        || cmd_low.contains("uv ")
        || cmd_low.contains("npm ")
        || cmd_low.contains("bun "))
        && (cmd_low.contains("install") || cmd_low.contains("add") || cmd_low.contains("sync"))
    {
        compact_pkg_install_output(scrubbed)
    } else {
        return scrubbed.to_string();
    };

    if compacted.len() >= scrubbed.len() {
        return scrubbed.to_string();
    }

    let saved = scrubbed.len() - compacted.len();
    if saved > 1_500 {
        let pct = (saved as f64 / scrubbed.len().max(1) as f64) * 100.0;
        if let Some(dir) = spill_dir {
            let spill_path = dir.join(format!("omni_shell_{}.log", uuid::Uuid::new_v4().simple()));
            let redacted = crate::sanitizer::redact_secrets(scrubbed);
            if fs::write(&spill_path, redacted.as_bytes()).is_ok() {
                return format!(
                    "{compacted}\n[Compacted {} -> {} chars (-{pct:.0}%); raw log: {}]",
                    scrubbed.len(),
                    compacted.len(),
                    spill_path.display()
                );
            }
        }
        return format!(
            "{compacted}\n[Compacted {} -> {} chars (-{pct:.0}%)]",
            scrubbed.len(),
            compacted.len()
        );
    }

    compacted
}

fn compact_cargo_output(text: &str) -> String {
    let mut out = Vec::new();
    let mut dropped_compile = 0usize;
    let mut passed_tests = 0usize;
    let mut in_failure_block = false;

    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("failures:") || t.starts_with("---- ") {
            in_failure_block = true;
        } else if t.starts_with("test result:") {
            in_failure_block = false;
        }
        if !in_failure_block {
            if t.starts_with("Compiling ")
                || t.starts_with("Downloading ")
                || t.starts_with("Downloaded ")
                || t.starts_with("Updating ")
                || t.starts_with("Fresh ")
                || t.starts_with("Locking ")
                || t.starts_with("Checking ")
            {
                dropped_compile += 1;
                continue;
            }
            if t.starts_with("test ") && t.ends_with(" ... ok") {
                passed_tests += 1;
                continue;
            }
        }
        out.push(line.to_string());
    }

    let mut header = Vec::new();
    if dropped_compile > 0 {
        header.push(format!(
            "[... {dropped_compile} cargo build/compile lines omitted ...]"
        ));
    }
    if passed_tests > 0 {
        header.push(format!("[... {passed_tests} passing tests omitted ...]"));
    }
    header.extend(out);
    header.join("\n")
}

fn compact_test_runner_output(text: &str) -> String {
    let mut out = Vec::new();
    let mut passed_lines = 0usize;
    let mut in_fail_section = false;

    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("===")
            && (t.contains("FAILURES") || t.contains("ERRORS") || t.contains("short test summary"))
        {
            in_fail_section = true;
        }
        if !in_fail_section {
            let is_pass_line =
                (t.contains(" PASSED") && !t.contains("FAILED") && !t.contains("ERROR"))
                    || (t.starts_with('✓') || t.starts_with("PASS "))
                    || (t.ends_with(" ... ok") && !t.contains("FAIL"));
            if is_pass_line {
                passed_lines += 1;
                continue;
            }
        }
        out.push(line.to_string());
    }

    if passed_lines > 0 {
        let mut res = vec![format!(
            "[... {passed_lines} passing test lines omitted ...]"
        )];
        res.extend(out);
        res.join("\n")
    } else {
        out.join("\n")
    }
}

fn compact_git_diff_lockfiles(text: &str) -> String {
    let is_lockfile = |header: &str| -> bool {
        header.contains("Cargo.lock")
            || header.contains("package-lock.json")
            || header.contains("bun.lock")
            || header.contains("pnpm-lock.yaml")
            || header.contains("yarn.lock")
    };

    let mut out = Vec::new();
    let mut skipping_lock = false;
    let mut lock_adds = 0usize;
    let mut lock_dels = 0usize;

    let flush_lock =
        |out: &mut Vec<String>, skipping: &mut bool, adds: &mut usize, dels: &mut usize| {
            if *skipping {
                out.push(format!(
                    "[lockfile diff omitted: +{} / -{} lines]",
                    *adds, *dels
                ));
                *skipping = false;
                *adds = 0;
                *dels = 0;
            }
        };

    for line in text.lines() {
        if line.starts_with("diff --git ") {
            flush_lock(&mut out, &mut skipping_lock, &mut lock_adds, &mut lock_dels);
            out.push(line.to_string());
            if is_lockfile(line) {
                skipping_lock = true;
            }
            continue;
        }
        if skipping_lock {
            if line.starts_with('+') && !line.starts_with("+++") {
                lock_adds += 1;
            } else if line.starts_with('-') && !line.starts_with("---") {
                lock_dels += 1;
            }
            continue;
        }
        out.push(line.to_string());
    }
    flush_lock(&mut out, &mut skipping_lock, &mut lock_adds, &mut lock_dels);
    out.join("\n")
}

fn compact_pkg_install_output(text: &str) -> String {
    let mut out = Vec::new();
    let mut omitted = 0usize;
    for line in text.lines() {
        let t = line.trim();
        let low = t.to_ascii_lowercase();
        let noisy = low.starts_with("requirement already satisfied:")
            || low.starts_with("collecting ")
            || low.starts_with("using cached ")
            || low.starts_with("downloading ")
            || low.starts_with("resolved ")
            || low.starts_with("installed ");
        let important = low.contains("error") || low.contains("warn") || low.contains("fail");
        if noisy && !important {
            omitted += 1;
            continue;
        }
        out.push(line.to_string());
    }
    if omitted > 0 {
        let mut res = vec![format!(
            "[... {omitted} package install progress lines omitted ...]"
        )];
        res.extend(out);
        res.join("\n")
    } else {
        out.join("\n")
    }
}

/// Strip ANSI CSI/OSC escape codes, collapse `\r` progress-bar overwrites,
/// and dedupe consecutive identical runs (`>= 4` identical lines -> `[repeated N×]`).
pub fn scrub_shell_output(raw: &str) -> String {
    // 1. Strip ANSI CSI (`\x1b[...`) and OSC (`\x1b]...(\x07|\x1b\\)`)
    let mut no_ansi = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            if i + 1 < bytes.len() && bytes[i + 1] == b'[' {
                // CSI: ESC [ params intermediate final (0x40..=0x7E)
                i += 2;
                while i < bytes.len() && !(0x40..=0x7E).contains(&bytes[i]) {
                    i += 1;
                }
                if i < bytes.len() {
                    i += 1;
                }
                continue;
            } else if i + 1 < bytes.len() && bytes[i + 1] == b']' {
                // OSC: ESC ] ... (BEL or ESC \)
                i += 2;
                while i < bytes.len() {
                    if bytes[i] == 0x07 {
                        i += 1;
                        break;
                    }
                    if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
                continue;
            }
        }
        // Push UTF-8 char safely
        let ch = raw[i..].chars().next().unwrap_or('\u{FFFD}');
        no_ansi.push(ch);
        i += ch.len_utf8();
    }

    // 2. Normalize CRLF -> LF first, then collapse bare `\r` progress bar overwrites per line
    let lf = no_ansi.replace("\r\n", "\n");
    let mut collapsed_lines: Vec<&str> = Vec::new();
    for line in lf.split('\n') {
        if line.contains('\r') {
            let final_seg = line.split('\r').rev().find(|s| !s.is_empty()).unwrap_or("");
            collapsed_lines.push(final_seg);
        } else {
            collapsed_lines.push(line);
        }
    }

    // 3. Dedupe consecutive identical lines (`>= 4` -> keep first + `[repeated N×]`)
    let mut out = String::with_capacity(lf.len());
    let mut idx = 0usize;
    while idx < collapsed_lines.len() {
        let cur = collapsed_lines[idx];
        let mut run = 1usize;
        while idx + run < collapsed_lines.len() && collapsed_lines[idx + run] == cur {
            run += 1;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        if run >= 4 && !cur.trim().is_empty() {
            out.push_str(cur);
            out.push_str(&format!("\n... [repeated {run}×]"));
        } else {
            for k in 0..run {
                if k > 0 {
                    out.push('\n');
                }
                out.push_str(cur);
            }
        }
        idx += run;
    }
    out
}

/// Traceback-preserving shell output cap: keeps head 30%, middle diagnostic blocks
/// (`Traceback`, `Error:`, `FAILED`, `AssertionError`, `error[E`, `Exception`, `panicked at`) up to 25%,
/// and tail 45% (where pytest/unittest/jest/cargo summaries appear).
pub fn cap_output_traceback_preserving(text: &str, max_chars: usize) -> String {
    if text.len() <= max_chars {
        return text.to_string();
    }
    static DIAG_AC: OnceLock<aho_corasick::AhoCorasick> = OnceLock::new();
    let ac = DIAG_AC.get_or_init(|| {
        AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .build([
                "traceback",
                "error:",
                "failed",
                "assertionerror",
                "error[e",
                "exception",
                "panicked at",
                "modulenotfounderror",
                "importerror",
                "syntaxerror",
                "typeerror",
            ])
            .unwrap()
    });

    let head_budget = max_chars * 30 / 100;
    let diag_budget = max_chars * 25 / 100;
    let tail_budget = max_chars * 42 / 100;

    let head_end = text.floor_char_boundary(head_budget);
    let tail_start = text.ceil_char_boundary(text.len().saturating_sub(tail_budget));

    let middle = if tail_start > head_end {
        &text[head_end..tail_start]
    } else {
        ""
    };

    let mut diag_excerpt = String::new();
    if !middle.is_empty() && diag_budget > 0 {
        let mid_lines: Vec<&str> = middle.lines().collect();
        let mut include = vec![false; mid_lines.len()];
        for (idx, line) in mid_lines.iter().enumerate() {
            if ac.is_match(line) {
                let lo = idx.saturating_sub(1);
                let hi = (idx + 3).min(mid_lines.len());
                for slot in &mut include[lo..hi] {
                    *slot = true;
                }
            }
        }
        for (idx, line) in mid_lines.iter().enumerate() {
            if include[idx] {
                if diag_excerpt.len() + line.len() + 1 > diag_budget {
                    break;
                }
                if !diag_excerpt.is_empty() {
                    diag_excerpt.push('\n');
                }
                diag_excerpt.push_str(line);
            }
        }
    }

    if diag_excerpt.is_empty() {
        let head_full = text.floor_char_boundary(max_chars * 40 / 100);
        let tail_full = text.ceil_char_boundary(text.len().saturating_sub(max_chars * 57 / 100));
        if tail_full <= head_full {
            return text.to_owned();
        }
        let omitted_full = tail_full.saturating_sub(head_full);
        format!(
            "{}\n... [omitted {omitted_full} chars of middle output] ...\n{}",
            &text[..head_full],
            &text[tail_full..]
        )
    } else {
        let omitted = tail_start.saturating_sub(head_end);
        format!(
            "{}\n... [omitted {omitted} chars; preserved diagnostics] ...\n{}\n... [tail] ...\n{}",
            &text[..head_end],
            diag_excerpt,
            &text[tail_start..]
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn enforces_workspace_containment_and_deny_rules_across_tools() {
        let tmp = std::env::temp_dir().join(format!("omni_tools_sec_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("ok.txt"), "hello world\n").unwrap();
        fs::write(tmp.join(".env"), "SECRET=123\n").unwrap();

        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&tmp)));
        let ctx = Arc::new(WorkspaceContextBundle::discover(&tmp));
        let rt = ToolRuntime::new(
            tmp.clone(),
            ApprovalMode::Yolo,
            true,
            PermissionsEngine::default_rules(),
            graph,
            ctx,
            None,
            None,
            Arc::new(AtomicBool::new(false)),
        );

        // 1. Path traversal blocked
        let r_esc = rt
            .execute("read_file", &json!({ "path": "../outside.txt" }))
            .await;
        assert!(r_esc.is_error);

        // 2. Deny rule blocks .env even in YOLO mode!
        let r_env = rt.execute("read_file", &json!({ "path": ".env" })).await;
        assert!(r_env.is_error);
        assert!(r_env.content.contains("Permission denied"));

        // 3. Deny rule blocks `rm -rf /` in shell even in YOLO mode!
        let r_rm = rt.execute("shell", &json!({ "command": "rm -rf /" })).await;
        assert!(r_rm.is_error);
        assert!(r_rm.content.contains("Permission denied"));

        // 4. Normal read_file + search_code + workspace_map succeed
        let r_ok = rt.execute("read_file", &json!({ "path": "ok.txt" })).await;
        assert!(!r_ok.is_error);
        assert!(r_ok.content.contains("hello world"));

        let r_search = rt
            .execute("search_code", &json!({ "query": "hello" }))
            .await;
        assert!(!r_search.is_error);
        assert!(r_search.content.contains("ok.txt:1"));

        // 5. Supervised shell execution works cleanly and returns stdout
        let r_sh = rt
            .execute(
                "shell",
                &json!({ "command": "echo SUPER_HARNESS_SHELL_OK" }),
            )
            .await;
        assert!(!r_sh.is_error, "shell failed: {}", r_sh.content);
        assert!(r_sh.content.contains("SUPER_HARNESS_SHELL_OK"));

        // 6. Security Fix #1: search_code must NEVER leak lines from `.env` or `*id_rsa*`
        fs::write(tmp.join("id_rsa"), "PRIVATE_KEY_TOP_SECRET\n").unwrap();
        let r_leak_env = rt
            .execute("search_code", &json!({ "query": "SECRET" }))
            .await;
        assert!(!r_leak_env.is_error);
        assert!(
            !r_leak_env.content.contains("SECRET=123")
                && !r_leak_env.content.contains("PRIVATE_KEY_TOP_SECRET"),
            "search_code leaked denied secret file: {}",
            r_leak_env.content
        );

        // 7. Security Fix #2: workspace_map rejects traversal in `subpath`
        let r_map_esc = rt
            .execute("workspace_map", &json!({ "subpath": "../outside" }))
            .await;
        assert!(
            r_map_esc.is_error,
            "workspace_map must reject traversal subpath"
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn shell_alias_auth_prompts_once_and_patch_untrusted_approval_works() {
        use crate::permissions::{PermissionAction, PermissionScope};
        use std::sync::atomic::AtomicUsize;

        let tmp = std::env::temp_dir().join(format!("omni_tools_auth_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("a.txt"), "old\n").unwrap();

        let prompt_count = Arc::new(AtomicUsize::new(0));
        let pc_cb = Arc::clone(&prompt_count);
        let approver: InteractiveApprover = Arc::new(move |_tool, _target| {
            let pc = Arc::clone(&pc_cb);
            Box::pin(async move {
                pc.fetch_add(1, Ordering::SeqCst);
                true
            })
        });

        let mut rules = PermissionsEngine::default_rules();
        rules.push(PermissionRule {
            id: "allow-echo-bash".into(),
            scope: PermissionScope::Global,
            workspace_id: None,
            action: PermissionAction::Allow,
            tool: "bash".into(),
            match_pattern: "echo ALLOW_ALIAS*".into(),
            note: "allow echo".into(),
        });

        // Untrusted workspace with AlwaysAsk + interactive approver
        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&tmp)));
        let ctx = Arc::new(WorkspaceContextBundle::discover(&tmp));
        let rt = ToolRuntime::new(
            tmp.clone(),
            ApprovalMode::AlwaysAsk,
            false, // untrusted workspace!
            rules,
            graph,
            ctx,
            None,
            Some(approver),
            Arc::new(AtomicBool::new(false)),
        );

        // Security Fix #4a: shell prompts EXACTLY ONCE (not twice for bash+shell)
        let r1 = rt
            .execute("shell", &json!({ "command": "echo ONCE_TEST" }))
            .await;
        assert!(
            !r1.is_error,
            "shell should succeed after 1 approval: {}",
            r1.content
        );
        assert_eq!(prompt_count.load(Ordering::SeqCst), 1);

        // Security Fix #4b: global Allow rule on "bash" allows "shell" with 0 additional prompts
        let r2 = rt
            .execute("shell", &json!({ "command": "echo ALLOW_ALIAS_OK" }))
            .await;
        assert!(
            !r2.is_error,
            "bash allow rule must allow shell: {}",
            r2.content
        );
        assert_eq!(prompt_count.load(Ordering::SeqCst), 1);

        // Security Fix #5a: apply_patch in UNTRUSTED workspace succeeds with 1 approval
        let ok_patch = "\
*** Begin Patch
*** Update File: a.txt
@@
-old
+new
*** End Patch";
        let r3 = rt
            .execute("apply_patch", &json!({ "patch": ok_patch }))
            .await;
        assert!(
            !r3.is_error,
            "untrusted apply_patch should succeed after user approves: {}",
            r3.content
        );
        assert_eq!(prompt_count.load(Ordering::SeqCst), 2);
        assert_eq!(fs::read_to_string(tmp.join("a.txt")).unwrap(), "new\n");

        // Security Fix #5b: apply_patch touching `.env` is HARD-DENIED BEFORE prompting!
        let env_patch = "\
*** Begin Patch
*** Add File: .env
+SECRET=1
*** End Patch";
        let r4 = rt
            .execute("apply_patch", &json!({ "patch": env_patch }))
            .await;
        assert!(r4.is_error);
        assert!(r4.content.contains("Permission denied"));
        assert_eq!(
            prompt_count.load(Ordering::SeqCst),
            2,
            "hard-denied .env patch must NEVER prompt user"
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn batch_read_file_reads_multiple_files_respecting_deny_rules_and_char_budget() {
        let tmp = std::env::temp_dir().join(format!("omni_tools_batch_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("a.py"), "def alpha():\n    return 1\n").unwrap();
        fs::write(tmp.join("b.py"), "def beta():\n    return 2\n").unwrap();
        fs::write(tmp.join(".env"), "TOP_SECRET=do_not_leak\n").unwrap();

        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&tmp)));
        let ctx = Arc::new(WorkspaceContextBundle::discover(&tmp));
        let rt = ToolRuntime::new(
            tmp.clone(),
            ApprovalMode::Yolo,
            true,
            PermissionsEngine::default_rules(),
            graph,
            ctx,
            None,
            None,
            Arc::new(AtomicBool::new(false)),
        );

        let out = rt
            .execute("read_file", &json!({ "paths": ["a.py", ".env", "b.py"] }))
            .await;
        assert!(
            !out.is_error,
            "batch read with valid files should succeed: {}",
            out.content
        );
        assert!(out.content.contains("=== a.py ==="));
        assert!(out.content.contains("=== b.py ==="));
        assert!(out.content.contains("def alpha():"));
        assert!(out.content.contains("def beta():"));
        assert!(out.content.contains("Permission denied"));
        assert!(
            !out.content.contains("TOP_SECRET"),
            "batch read_file must NEVER leak denied .env content!"
        );
        // Hashline anchor format check (`   1:xxx| def alpha():`)
        assert!(out.content.contains("| def alpha():"));

        // Verify read_tracker registered BOTH a.py and b.py so edit_file works immediately!
        let ed = rt
            .execute(
                "edit_file",
                &json!({
                    "path": "b.py",
                    "old_string": "return 2",
                    "new_string": "return 22"
                }),
            )
            .await;
        assert!(
            !ed.is_error,
            "edit after batch read should pass Pre-Read Guard: {}",
            ed.content
        );
        assert!(ed.content.contains("+") && ed.content.contains("return 22"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn edit_and_patch_return_compact_unified_diff_with_fresh_hashlines() {
        let tmp = std::env::temp_dir().join(format!("omni_tools_diff_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("calc.py"), "def add(a, b):\n    return a - b\n").unwrap();

        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&tmp)));
        let ctx = Arc::new(WorkspaceContextBundle::discover(&tmp));
        let rt = ToolRuntime::new(
            tmp.clone(),
            ApprovalMode::Yolo,
            true,
            PermissionsEngine::default_rules(),
            graph,
            ctx,
            None,
            None,
            Arc::new(AtomicBool::new(false)),
        );

        // Read to get Hashline anchor for line 2
        let r = rt.execute("read_file", &json!({ "path": "calc.py" })).await;
        assert!(!r.is_error);
        let line2 = r.content.lines().nth(1).unwrap();
        let anchor2 = line2.split('|').next().unwrap().trim().to_string();

        // Mode 1 Hashline splice edit!
        let ed = rt
            .execute(
                "edit_file",
                &json!({
                    "path": "calc.py",
                    "start_anchor": anchor2,
                    "new_string": "    return a + b"
                }),
            )
            .await;
        assert!(!ed.is_error, "hashline edit failed: {}", ed.content);
        assert!(ed.content.contains("mode=hashline_exact"));
        assert!(ed.content.contains("-   2:") || ed.content.contains("return a - b"));
        assert!(ed.content.contains("return a + b"));

        // Patch also emits compact unified diff
        let patch = "\
*** Begin Patch
*** Update File: calc.py
@@
 def add(a, b):
-    return a + b
+    return int(a + b)
*** End Patch";
        let pr = rt.execute("apply_patch", &json!({ "patch": patch })).await;
        assert!(!pr.is_error, "patch failed: {}", pr.content);
        assert!(pr.content.contains("--- calc.py"));
        assert!(pr.content.contains("+   2:"));
        assert!(pr.content.contains("return int(a + b)"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn shell_scrubber_strips_ansi_collapses_cr_progress_and_preserves_traceback() {
        let ansi_and_progress = "\x1b[32mPASS\x1b[0m\nLoading 10%\rLoading 50%\rLoading 100%\ndup line\ndup line\ndup line\ndup line\ndup line\ndone";
        let scrubbed = scrub_shell_output(ansi_and_progress);
        assert!(!scrubbed.contains("\x1b[32m"));
        assert!(scrubbed.contains("PASS"));
        assert!(!scrubbed.contains("Loading 10%"));
        assert!(scrubbed.contains("Loading 100%"));
        assert!(scrubbed.contains("[repeated 5×]"));

        // Large output with traceback buried in the middle
        let mut big = String::new();
        for i in 0..120 {
            big.push_str(&format!(
                "verbose build header log line {i:03} padding padding padding\n"
            ));
        }
        big.push_str("Traceback (most recent call last):\n  File \"pkg/app.py\", line 42\nAssertionError: expected 99 got 1\n");
        for i in 0..200 {
            big.push_str(&format!(
                "noisy filler output line {i:03} padding padding padding padding\n"
            ));
        }
        big.push_str("SUMMARY: 1 failed, 12 passed in 0.42s\n");

        let capped = cap_output_traceback_preserving(&big, 2_400);
        assert!(capped.len() <= 2_800);
        assert!(capped.contains("Traceback (most recent call last):"));
        assert!(capped.contains("AssertionError: expected 99 got 1"));
        assert!(capped.contains("SUMMARY: 1 failed, 12 passed"));
    }

    #[test]
    fn cargo_compactor_drops_compiling_and_passing_tests_while_preserving_full_failure_stdout() {
        let mut raw = String::new();
        for i in 0..50 {
            raw.push_str(&format!("   Compiling crate_{i:02} v0.1.0\n"));
        }
        for i in 0..40 {
            raw.push_str(&format!("test mod_a::test_case_{i:02} ... ok\n"));
        }
        raw.push_str("test mod_a::test_broken ... FAILED\n\nfailures:\n\n---- mod_a::test_broken stdout ----\nthread 'mod_a::test_broken' panicked at src/lib.rs:42: assertion left == right failed\n\nfailures:\n    mod_a::test_broken\n\ntest result: FAILED. 40 passed; 1 failed; 0 ignored;\n");
        let tmp = std::env::temp_dir().join(format!("omni_spill_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let comp = compact_shell_output("cargo test --workspace", &raw, 101, Some(&tmp));
        assert!(comp.len() < raw.len() / 2);
        assert!(comp.contains("50 cargo build/compile lines omitted"));
        assert!(comp.contains("40 passing tests omitted"));
        assert!(comp.contains("---- mod_a::test_broken stdout ----"));
        assert!(comp.contains("assertion left == right failed"));
        assert!(comp.contains("test result: FAILED. 40 passed; 1 failed"));
        assert!(comp.contains("raw log:"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn pytest_compactor_preserves_full_traceback_and_short_summary_while_collapsing_passed() {
        let mut raw = String::new();
        for i in 0..60 {
            raw.push_str(&format!(
                "tests/test_suite.py::test_ok_{i:02} PASSED [ {:>2}%]\n",
                i
            ));
        }
        raw.push_str("tests/test_suite.py::test_bad FAILED [100%]\n");
        raw.push_str(
            "=================================== FAILURES ===================================\n",
        );
        raw.push_str("def test_bad():\n>   assert 1 == 2\nE   AssertionError: assert 1 == 2\n");
        raw.push_str(
            "=========================== short test summary info ============================\n",
        );
        raw.push_str("FAILED tests/test_suite.py::test_bad - AssertionError: assert 1 == 2\n");
        raw.push_str(
            "========================= 1 failed, 60 passed in 0.4s ==========================\n",
        );
        let comp = compact_shell_output("pytest -v", &raw, 1, None);
        assert!(comp.contains("60 passing test lines omitted"));
        assert!(comp.contains("AssertionError: assert 1 == 2"));
        assert!(comp.contains("1 failed, 60 passed"));
    }

    #[test]
    fn git_diff_compactor_elides_lockfile_hunks_and_keeps_source_hunks_verbatim() {
        let mut raw = String::from("diff --git a/Cargo.lock b/Cargo.lock\nindex 111..222 100644\n--- a/Cargo.lock\n+++ b/Cargo.lock\n");
        for i in 0..80 {
            raw.push_str(&format!("+name = \"dep_{i:02}\"\n-name = \"old_{i:02}\"\n"));
        }
        raw.push_str("diff --git a/src/app.rs b/src/app.rs\n--- a/src/app.rs\n+++ b/src/app.rs\n@@ -1,2 +1,2 @@\n-let x = 1;\n+let x = 2;\n");
        let comp = compact_shell_output("git diff", &raw, 0, None);
        assert!(comp.contains("[lockfile diff omitted: +80 / -80 lines]"));
        assert!(comp.contains("+let x = 2;"));
        assert!(!comp.contains("dep_50"));
    }

    #[tokio::test]
    async fn read_file_by_symbol_and_oversized_cast_outline_work() {
        let tmp = std::env::temp_dir().join(format!("omni_cast_read_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let mut big_py = String::new();
        for i in 0..90 {
            big_py.push_str(&format!(
                "def func_{i:03}(x):\n    y = x + {i}\n    z = y * 2\n    return z\n\n"
            ));
        }
        // 90 * 5 = 450 lines (> 400 default!)
        fs::write(tmp.join("big.py"), &big_py).unwrap();

        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&tmp)));
        graph.lock().unwrap().refresh().unwrap();
        let ctx = Arc::new(WorkspaceContextBundle::discover(&tmp));
        let rt = ToolRuntime::new(
            tmp.clone(),
            ApprovalMode::Yolo,
            true,
            PermissionsEngine::default_rules(),
            graph,
            ctx,
            None,
            None,
            Arc::new(AtomicBool::new(false)),
        );

        // 1. Symbol jump goes straight to func_080 with Hashlines!
        let r_sym = rt
            .execute(
                "read_file",
                &json!({ "path": "big.py", "symbol": "func_080" }),
            )
            .await;
        assert!(!r_sym.is_error, "symbol read failed: {}", r_sym.content);
        assert!(r_sym.content.contains("[symbol: func_080"));
        assert!(r_sym.content.contains("def func_080(x):"));
        assert!(r_sym.content.contains("|     return z"));

        // 2. Unbounded read of 450-line file snaps cleanly near L260 and appends AST outline of remaining symbols!
        let r_big = rt.execute("read_file", &json!({ "path": "big.py" })).await;
        assert!(!r_big.is_error);
        assert!(
            r_big.content.contains("[AST Outline for truncated L"),
            "oversized read must append cAST skeleton outline: {}",
            r_big.content
        );
        assert!(r_big.content.contains("func_080"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn unicode_tag_smuggling_is_stripped_and_escalates_subsequent_shell_to_ask() {
        let tmp = std::env::temp_dir().join(format!("omni_taint_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let evil = format!("x = 1\n# {}\n", "\u{E0049}\u{E0047}\u{E004E}");
        fs::write(tmp.join("sneaky.py"), evil).unwrap();

        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&tmp)));
        let ctx = Arc::new(WorkspaceContextBundle::discover(&tmp));
        // YOLO mode with NO interactive approver: normally shell runs allowed,
        // BUT once tainted by Unicode tag smuggling, YOLO escalates to Ask (blocking unapproved shell)!
        let rt = ToolRuntime::new(
            tmp.clone(),
            ApprovalMode::Yolo,
            true,
            PermissionsEngine::default_rules(),
            graph,
            ctx,
            None,
            None,
            Arc::new(AtomicBool::new(false)),
        );

        let r_read = rt
            .execute("read_file", &json!({ "path": "sneaky.py" }))
            .await;
        assert!(!r_read.is_error);
        assert!(!r_read.content.contains('\u{E0049}'));
        assert!(r_read.content.contains("<untrusted_workspace_data"));
        assert!(rt.tainted_by_injection_signal.load(Ordering::Relaxed));

        let r_shell = rt
            .execute("shell", &json!({ "command": "echo HIJACKED" }))
            .await;
        assert!(
            r_shell.is_error && r_shell.content.contains("Provenance taint escalated"),
            "tainted session must escalate YOLO shell to Ask: {}",
            r_shell.content
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn deferred_tool_registry_discovers_and_invokes_builtin_lsp_and_graph_tools() {
        let tmp = std::env::temp_dir().join(format!("omni_deferred_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("billing.py"),
            "def calculate_tax(amount):\n    return amount * 0.1\n",
        )
        .unwrap();

        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&tmp)));
        graph.lock().unwrap().refresh().unwrap();
        let ctx = Arc::new(WorkspaceContextBundle::discover(&tmp));
        let rt = ToolRuntime::new(
            tmp.clone(),
            ApprovalMode::Yolo,
            true,
            PermissionsEngine::default_rules(),
            graph,
            ctx,
            None,
            None,
            Arc::new(AtomicBool::new(false)),
        );

        let disc = rt
            .execute(
                "discover_tools",
                &json!({ "query": "symbol graph lsp", "limit": 5 }),
            )
            .await;
        assert!(!disc.is_error, "discover_tools failed: {}", disc.content);
        assert!(disc.content.contains("search_entity"));
        assert!(disc.content.contains("graph_traverse"));
        assert!(disc.content.contains("lsp_query"));

        let inv_entity = rt
            .execute(
                "invoke_extension_tool",
                &json!({ "name": "search_entity", "arguments": { "query": "calculate_tax" } }),
            )
            .await;
        assert!(
            !inv_entity.is_error,
            "search_entity deferred tool failed: {}",
            inv_entity.content
        );
        assert!(inv_entity.content.contains("billing.py"));

        let inv_lsp = rt
            .execute(
                "invoke_extension_tool",
                &json!({
                    "name": "lsp_query",
                    "arguments": { "operation": "document_symbols", "path": "billing.py" }
                }),
            )
            .await;
        assert!(
            !inv_lsp.is_error,
            "lsp_query deferred tool failed: {}",
            inv_lsp.content
        );
        assert!(inv_lsp.content.contains("calculate_tax"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn edit_file_supports_tree_sitter_symbol_block_diff() {
        let tmp = std::env::temp_dir().join(format!("omni_sym_edit_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("math_ops.py"),
            "def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b\n",
        )
        .unwrap();

        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&tmp)));
        graph.lock().unwrap().refresh().unwrap();
        let ctx = Arc::new(WorkspaceContextBundle::discover(&tmp));
        let rt = ToolRuntime::new(
            tmp.clone(),
            ApprovalMode::Yolo,
            true,
            PermissionsEngine::default_rules(),
            graph,
            ctx,
            None,
            None,
            Arc::new(AtomicBool::new(false)),
        );

        let _ = rt
            .execute("read_file", &json!({ "path": "math_ops.py" }))
            .await;
        let edited = rt
            .execute(
                "edit_file",
                &json!({
                    "path": "math_ops.py",
                    "symbol": "mul",
                    "new_string": "def mul(a, b):\n    return (a * b) + 1"
                }),
            )
            .await;
        assert!(
            !edited.is_error,
            "symbol BlockDiff edit failed: {}",
            edited.content
        );
        assert!(edited.content.contains("block_diff(mul"));
        assert!(fs::read_to_string(tmp.join("math_ops.py"))
            .unwrap()
            .contains("(a * b) + 1"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn read_file_rejects_files_over_4mib_before_loading_into_ram() {
        let tmp = std::env::temp_dir().join(format!("omni_big_read_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let big_path = tmp.join("huge.log");
        let f = fs::File::create(&big_path).unwrap();
        f.set_len(4 * 1024 * 1024 + 64).unwrap();
        drop(f);

        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&tmp)));
        let ctx = Arc::new(WorkspaceContextBundle::discover(&tmp));
        let rt = ToolRuntime::new(
            tmp.clone(),
            ApprovalMode::Yolo,
            true,
            PermissionsEngine::default_rules(),
            graph,
            ctx,
            None,
            None,
            Arc::new(AtomicBool::new(false)),
        );
        let out = rt
            .execute("read_file", &json!({ "path": "huge.log" }))
            .await;
        assert!(
            out.is_error && out.content.contains("4 MiB"),
            "read_file must reject >4 MiB file upfront: {}",
            out.content
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn shell_nonzero_exit_is_output_not_tool_error_and_edit_accepts_arg_aliases() {
        let tmp = std::env::temp_dir().join(format!("omni_shell_alias_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("cfg.py"), "RATE = 0.10\n").unwrap();
        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&tmp)));
        let ctx = Arc::new(WorkspaceContextBundle::discover(&tmp));
        let rt = ToolRuntime::new(
            tmp.clone(),
            ApprovalMode::Yolo,
            true,
            PermissionsEngine::default_rules(),
            graph,
            ctx,
            None,
            None,
            Arc::new(AtomicBool::new(false)),
        );

        let sh = rt.execute("shell", &json!({ "command": "exit 3" })).await;
        assert!(
            !sh.is_error,
            "non-zero exit must not be a tool failure: {}",
            sh.content
        );
        assert!(sh.content.starts_with("exit_code: 3"), "{}", sh.content);

        // GPT/Gemini-style alias arguments, editing a file that was never read_file'd
        let ed = rt
            .execute(
                "edit_file",
                &json!({ "file_path": "cfg.py", "old_text": "RATE = 0.10", "new_text": "RATE = 0.15" }),
            )
            .await;
        assert!(!ed.is_error, "alias edit failed: {}", ed.content);
        assert_eq!(
            fs::read_to_string(tmp.join("cfg.py")).unwrap(),
            "RATE = 0.15\n"
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn ptc_run_code_hooks_exit2_block_ast_edit_and_fail_closed_host_tools() {
        let tmp = std::env::temp_dir().join(format!("omni_v5_tools_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("sample.rs"), "pub fn old_add(x: i32) -> i32 { x + 1 }\n").unwrap();

        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&tmp)));
        let ctx = Arc::new(WorkspaceContextBundle::discover(&tmp));
        let mut rt = ToolRuntime::new(
            tmp.clone(),
            ApprovalMode::Yolo,
            true,
            PermissionsEngine::default_rules(),
            graph,
            ctx,
            None,
            None,
            Arc::new(AtomicBool::new(false)),
        );

        // 1. Registered deferred handler executes cleanly via both direct & invoke_extension_tool.
        rt.register_deferred_tool(
            ToolSpec {
                name: "omni_custom_probe".into(),
                description: "Custom probe tool".into(),
                parameters: json!({"type": "object"}),
                read_only: true,
            },
            true,
            Arc::new(|_n, a| {
                Box::pin(async move { Ok(json!({"echo": a["msg"]}).to_string()) })
            }),
        );
        let ext = rt
            .execute(
                "invoke_extension_tool",
                &json!({ "name": "omni_custom_probe", "arguments": { "msg": "hi" } }),
            )
            .await;
        assert!(!ext.is_error && ext.content.contains("hi"), "{}", ext.content);

        // 2. Unregistered omni_* host tool fails closed instead of returning fake ok.
        let fake = rt.execute("omni_kanban_create", &json!({})).await;
        assert!(fake.is_error, "unregistered omni_* must fail closed: {}", fake.content);

        // 3. PTC run_code batches read_file + ast_grep & isolates OS globals.
        let ptc_out = rt
            .execute(
                "run_code",
                &json!({
                    "code": r#"
                        const batch = tools.parallel([
                            ["read_file", { path: "sample.rs" }],
                            ["ast_grep", { pattern: "pub fn $NAME", path: "sample.rs" }]
                        ]);
                        return {
                            batchLen: batch.length,
                            ok0: batch[0].ok,
                            ok1: batch[1].ok,
                            hasProcess: typeof process !== "undefined"
                        };
                    "#
                }),
            )
            .await;
        assert!(!ptc_out.is_error, "ptc failed: {}", ptc_out.content);
        let parsed: Value = serde_json::from_str(&ptc_out.content).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["value"]["batchLen"], 2);
        assert_eq!(parsed["value"]["ok0"], true);
        assert_eq!(parsed["value"]["hasProcess"], false);

        // 4. PreToolUse inline exit-2 deterministic block rejects write_file cleanly.
        rt.hook_registry.register_inline(
            "deny_secret_write",
            HookEvent::PreToolUse,
            Some("write_file".to_owned()),
            Arc::new(|_ev, payload| {
                let is_blocked = payload["arguments"]["path"]
                    .as_str()
                    .unwrap_or("")
                    .contains("blocked");
                crate::hooks::InlineHookDecision {
                    block: is_blocked,
                    reason: is_blocked.then(|| "blocked by deterministic policy".to_owned()),
                    ..Default::default()
                }
            }),
        );
        let blocked = rt
            .execute(
                "write_file",
                &json!({ "path": "blocked.txt", "content": "nope" }),
            )
            .await;
        assert!(blocked.is_error && blocked.content.contains("PreToolUse"), "{}", blocked.content);
        assert!(!tmp.join("blocked.txt").exists());

        // 5. Deferred tools are discoverable via discover_tools (<=10) & run ast_edit cleanly.
        let disc = rt
            .execute("discover_tools", &json!({ "query": "ast_edit syntax rewrite" }))
            .await;
        assert!(!disc.is_error && disc.content.contains("ast_edit"), "{}", disc.content);

        let ast_res = rt
            .execute(
                "ast_edit",
                &json!({
                    "path": "sample.rs",
                    "pattern": "$A + 1",
                    "rewrite": "$A + 2"
                }),
            )
            .await;
        assert!(!ast_res.is_error, "ast_edit failed: {}", ast_res.content);
        assert!(
            fs::read_to_string(tmp.join("sample.rs"))
                .unwrap()
                .contains("x + 2"),
            "sample.rs should be rewritten"
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn batch_read_file_preserves_full_medium_files_within_batch_budget() {
        let tmp = std::env::temp_dir().join(format!("omni_batch_read_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let mut paths = Vec::new();
        for idx in 0..6 {
            let rel = format!("mod_{idx}.py");
            let mut body = String::new();
            for line_i in 1..=180 {
                body.push_str(&format!("def fn_{idx}_{line_i}(x): return x + {line_i}\n"));
            }
            body.push_str(&format!("SENTINEL_END_{idx} = True\n"));
            fs::write(tmp.join(&rel), &body).unwrap();
            paths.push(rel);
        }

        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&tmp)));
        let ctx = Arc::new(WorkspaceContextBundle::discover(&tmp));
        let rt = ToolRuntime::new(
            tmp.clone(),
            ApprovalMode::Yolo,
            true,
            PermissionsEngine::default_rules(),
            graph,
            ctx,
            None,
            None,
            Arc::new(AtomicBool::new(false)),
        );
        let out = rt.execute("read_file", &json!({ "paths": paths })).await;
        assert!(!out.is_error, "batch read failed: {}", out.content);
        for idx in 0..6 {
            assert!(
                out.content.contains(&format!("SENTINEL_END_{idx}")),
                "batch read truncated file {idx} prematurely"
            );
        }
        let _ = fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn ptc_sdk_exposes_shell_apply_patch_workspace_map_and_propagates_errors() {
        let tmp = std::env::temp_dir().join(format!("omni_ptc_sdk_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("hello.py"), "VAL = 1\n").unwrap();

        let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&tmp)));
        let ctx = Arc::new(WorkspaceContextBundle::discover(&tmp));
        let rt = ToolRuntime::new(
            tmp.clone(),
            ApprovalMode::Yolo,
            true,
            PermissionsEngine::default_rules(),
            graph,
            ctx,
            None,
            None,
            Arc::new(AtomicBool::new(false)),
        );

        let ok = rt
            .execute(
                "run_code",
                &json!({
                    "code": r#"
                        const map = tools.workspace_map({ query: "hello" });
                        const sh1 = tools.run_shell("echo PTC_SHELL_OK");
                        const sh2 = tools.shell({ command: "echo PTC_SHELL2_OK" });
                        const patched = tools.apply_patch("*** Begin Patch\n*** Update File: hello.py\n@@\n-VAL = 1\n+VAL = 2\n*** End Patch\n");
                        return {
                            hasMap: typeof map === "string" && map.includes("hello.py"),
                            hasSh1: typeof sh1 === "string" && sh1.includes("PTC_SHELL_OK"),
                            hasSh2: typeof sh2 === "string" && sh2.includes("PTC_SHELL2_OK"),
                            patched: typeof patched === "string" && patched.includes("updated: hello.py")
                        };
                    "#
                }),
            )
            .await;
        assert!(!ok.is_error, "ptc shell/apply_patch/workspace_map failed: {}", ok.content);
        let v: Value = serde_json::from_str(&ok.content).unwrap();
        assert_eq!(v["value"]["hasMap"], true);
        assert_eq!(v["value"]["hasSh1"], true);
        assert_eq!(v["value"]["hasSh2"], true);
        assert_eq!(v["value"]["patched"], true);
        assert_eq!(fs::read_to_string(tmp.join("hello.py")).unwrap(), "VAL = 2\n");

        // Uncaught JS exception / tool failure (`!res.ok`) must set `is_error = true`!
        let err = rt
            .execute(
                "run_code",
                &json!({ "code": r#"throw new Error("boom_ptc_err");"# }),
            )
            .await;
        assert!(err.is_error, "!res.ok must propagate as is_error=true: {}", err.content);
        assert!(err.content.contains("boom_ptc_err"), "{}", err.content);

        // #194: Clean outputs without diagnostics redistribute unused 25% diag_budget cleanly.
        let clean_30k = "x".repeat(30_000);
        let capped_clean = cap_output_traceback_preserving(&clean_30k, 20_000);
        assert!(
            capped_clean.len() >= 19_000,
            "clean 30k output under 20k cap should keep >=19k chars, got {}",
            capped_clean.len()
        );

        let _ = fs::remove_dir_all(&tmp);
    }
}
