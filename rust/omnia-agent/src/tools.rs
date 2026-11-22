//! Compact 7-Tool Execution Engine + Progressive Skills + Lazy Host Tools + Security Gate.
//!
//! Security invariants enforced on EVERY call:
//! - Every file path is validated with `crate::path_guard::ensure_within_workspace`.
//! - Every file, patch, and shell action is evaluated against `crate::permissions::PermissionsEngine`
//!   (Global + Workspace Allow/Deny globs + Untrusted Workspace Gate; Deny ALWAYS wins).
//! - Every `shell` command runs inside a Win32 Job Object (`spawn_supervised_command`) with
//!   closed stdin, concurrent stdout/stderr draining, hard timeout, and guaranteed 0 orphans.

use crate::checkpoint::TurnCheckpointStore;
use crate::context::WorkspaceContextBundle;
use crate::edit::{
    edit_file_by_hashline, edit_file_by_symbol_block, edit_file_guarded, format_hashline,
    line_hash_tag, run_fast_compiler_syntax_check, FileReadTracker,
};
use crate::graph_locator::{verify_syntax_delta, WorkspaceGraphIndex};
use crate::lakeview::offload_large_observation;
use crate::lsp::LazyLspManager;
use crate::patch::{apply_codex_patch, parse_codex_patch, FilePatchOp};
use crate::plugin::{builtin_deferred_semantic_tools, DeferredToolRegistry};
use crate::sanitizer::{atomic_write_bom_free, format_fail_fast_error, sanitize_untrusted_text};
use crate::search::SearchMode;
use aho_corasick::AhoCorasickBuilder;
use anyhow::{bail, Context, Result};
use crate::path_guard::{ensure_within_workspace, sanitize_windows_path};
use crate::permissions::{ApprovalMode, PermissionDecision, PermissionRule, PermissionsEngine};
use crate::supervisor::spawn_supervised_command;
use crate::agent_store::AgentStore;
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_READ_LINES_DEFAULT: usize = 400;
const MAX_READ_CHARS: usize = 32_000;
const MAX_BATCH_READ_FILES: usize = 8;
const MAX_SHELL_OUTPUT_CHARS: usize = 14_000;
const SHELL_COMPACT_MIN_CHARS: usize = 1_800;

/// Optional interactive approval callback used when `PermissionsEngine` returns `Ask`.
pub type InteractiveApprover = Arc<
    dyn Fn(String, String) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
        + Send
        + Sync,
>;

/// Pluggable async callback for external MCP / Studio host extension tools registered in `DeferredToolRegistry`.
pub type ExtensionToolHandler = Arc<
    dyn Fn(String, Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>>
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
        let mut deferred = DeferredToolRegistry::new();
        for spec in builtin_deferred_semantic_tools() {
            deferred.register(spec);
        }
        Self {
            session_key,
            lsp_manager: LazyLspManager::new(clean_root.clone()),
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
                | "omni_kanban_list"
                | "omni_kb_search"
        )
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
        let is_host = tool_name.starts_with("omni_");
        let res = match tool_name {
            "read_file" => self.exec_read_file(args).await,
            "edit_file" => self.exec_edit_file(args).await,
            "apply_patch" => self.exec_apply_patch(args).await,
            "write_file" => self.exec_write_file(args).await,
            "search_code" => self.exec_search_code(args).await,
            "workspace_map" => self.exec_workspace_map(args).await,
            "shell" => self.exec_shell(args).await,
            "load_skill" => self.exec_load_skill(args).await,
            "discover_tools" => self.exec_discover_tools(args).await,
            "invoke_extension_tool" => self.exec_invoke_extension_tool(args).await,
            other if other.starts_with("omni_") => self.exec_host_tool(other, args).await,
            unknown => Err(anyhow::anyhow!(
                "{}",
                format_fail_fast_error(
                    "unknown tool",
                    "tool_name",
                    unknown,
                    "Use one of the active workspace tools or discover_tools"
                )
            )),
        };
        let duration_ms = t0.elapsed().as_millis() as u64;
        match res {
            Ok(content) => ToolExecOutput {
                content,
                is_error: false,
                is_host_tool: is_host,
                duration_ms,
            },
            Err(err) => ToolExecOutput {
                content: format!("Error: {err}"),
                is_error: true,
                is_host_tool: is_host,
                duration_ms,
            },
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
            text.strip_suffix('\n').unwrap_or(&text).split('\n').collect()
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
                        &format!(
                            "Use start_line/end_line or one of: [{}]",
                            avail.join(", ")
                        )
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
                let mut remaining_budget = MAX_READ_CHARS;
                let mut ok_count = 0usize;
                let mut err_count = 0usize;
                let count = rels.len();

                for (i, rel) in rels.iter().enumerate() {
                    let files_left = (count - i).max(1);
                    let file_budget = (remaining_budget / files_left).clamp(1_024, MAX_READ_CHARS);
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

        let rel = args
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
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
        } else if let Some(compiler_diag) =
            run_fast_compiler_syntax_check(&self.workspace_root, &abs)
        {
            msg.push('\n');
            msg.push_str(&compiler_diag);
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
        if tainted && ask_targets.is_empty() && matches!(self.approval_mode, ApprovalMode::Yolo | ApprovalMode::Write) {
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
        self.read_tracker.record_read(&abs, clean_content.as_bytes());

        // D1: Zero-cost post-write AST & config syntax verification
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
        let literal = args.get("literal").and_then(|v| v.as_bool()).unwrap_or(false);
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
        let cancel_flag = Arc::clone(&self.cancel_flag);

        let res = tokio::task::spawn_blocking(move || {
            run_supervised_shell(&cwd, &cmd_str, &shell_choice, timeout_secs, &cancel_flag)
        })
        .await?;

        match res {
            Ok(out) => {
                let sanitized = self.sanitize_and_track_taint(&out, "shell");
                let (bounded, _spill) =
                    offload_large_observation(&self.session_key, "shell", &sanitized, 6_144);
                Ok(bounded)
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
            .map(|n| (n as usize).clamp(1, 5))
            .unwrap_or(5);
        let hits = self.deferred_tools.discover(query, limit);
        if hits.is_empty() {
            return Ok(format!(
                "No deferred extension tools matched '{query}' (total deferred: {}).",
                self.deferred_tools.len()
            ));
        }
        Ok(serde_json::to_string_pretty(&hits)?)
    }

    async fn exec_invoke_extension_tool(&self, args: &Value) -> Result<String> {
        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .context("invoke_extension_tool requires string parameter 'name'")?;
        let ext_args = args
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));

        match name {
            "lsp_query" => {
                let action = ext_args
                    .get("action")
                    .or_else(|| ext_args.get("operation"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("references");
                let rel_path = ext_args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .context("lsp_query requires string parameter 'path'")?;
                let abs = ensure_within_workspace(&self.workspace_root, rel_path)?;
                self.authorize("read", &abs.to_string_lossy()).await?;
                let line = ext_args.get("line").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
                let ch = ext_args
                    .get("character")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                let sym = ext_args.get("symbol").and_then(|v| v.as_str());
                let res = self
                    .lsp_manager
                    .query(action, rel_path, line, ch, sym, &self.graph_index)
                    .await;
                return Ok(serde_json::to_string_pretty(&res)?);
            }
            "graph_traverse" => {
                let seed = ext_args
                    .get("seed")
                    .and_then(|v| v.as_str())
                    .context("graph_traverse requires string parameter 'seed'")?;
                let hops = ext_args.get("hops").and_then(|v| v.as_u64()).unwrap_or(2) as usize;
                let rep = {
                    let mut g = self.graph_index.lock().unwrap();
                    let _ = g.refresh();
                    g.traverse_graph(seed, hops)
                };
                return Ok(serde_json::to_string_pretty(&rep)?);
            }
            "search_entity" => {
                let query = ext_args
                    .get("query")
                    .and_then(|v| v.as_str())
                    .context("search_entity requires string parameter 'query'")?;
                let limit = ext_args
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(15) as usize;
                let hits = {
                    let mut g = self.graph_index.lock().unwrap();
                    let _ = g.refresh();
                    g.search_entity(query, limit)
                };
                return Ok(serde_json::to_string_pretty(&hits)?);
            }
            _ => {}
        }

        self.authorize("extension", name).await?;
        if name.starts_with("omni_") {
            return self.exec_host_tool(name, &ext_args).await;
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
        if let Some(ref handler) = self.extension_handler {
            return handler(name.to_string(), ext_args).await;
        }
        Ok(serde_json::to_string_pretty(&json!({
            "status": "deferred_tool_registered_without_external_handler",
            "tool": name,
            "availableBuiltinExtensions": ["lsp_query", "graph_traverse", "search_entity"]
        }))?)
    }

    async fn exec_host_tool(&self, tool_name: &str, args: &Value) -> Result<String> {
        if let Some(ref handler) = self.extension_handler {
            return handler(tool_name.to_string(), args.clone()).await;
        }
        Ok(serde_json::to_string_pretty(&json!({
            "tool": tool_name,
            "workspace": self.workspace_root.to_string_lossy(),
            "args": args,
            "status": "ok"
        }))?)
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
                let prog = if def.to_string_lossy().to_ascii_lowercase().ends_with("bash.exe") {
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

    let (mut child, supervisor) =
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
    let compacted = compact_shell_output(command, &scrubbed, exit_code, Some(&std::env::temp_dir()));
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
        if t.starts_with("===") && (t.contains("FAILURES") || t.contains("ERRORS") || t.contains("short test summary")) {
            in_fail_section = true;
        }
        if !in_fail_section {
            let is_pass_line = (t.contains(" PASSED") && !t.contains("FAILED") && !t.contains("ERROR"))
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

    let flush_lock = |out: &mut Vec<String>, skipping: &mut bool, adds: &mut usize, dels: &mut usize| {
        if *skipping {
            out.push(format!("[lockfile diff omitted: +{} / -{} lines]", *adds, *dels));
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
        let mut res = vec![format!("[... {omitted} package install progress lines omitted ...]")];
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
            let final_seg = line
                .split('\r')
                .rev()
                .find(|s| !s.is_empty())
                .unwrap_or("");
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

    let omitted = tail_start.saturating_sub(head_end);
    if diag_excerpt.is_empty() {
        format!(
            "{}\n... [omitted {omitted} chars of middle output] ...\n{}",
            &text[..head_end],
            &text[tail_start..]
        )
    } else {
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
        let r_rm = rt
            .execute("shell", &json!({ "command": "rm -rf /" }))
            .await;
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
            .execute("shell", &json!({ "command": "echo SUPER_HARNESS_SHELL_OK" }))
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
        assert!(!r1.is_error, "shell should succeed after 1 approval: {}", r1.content);
        assert_eq!(prompt_count.load(Ordering::SeqCst), 1);

        // Security Fix #4b: global Allow rule on "bash" allows "shell" with 0 additional prompts
        let r2 = rt
            .execute("shell", &json!({ "command": "echo ALLOW_ALIAS_OK" }))
            .await;
        assert!(!r2.is_error, "bash allow rule must allow shell: {}", r2.content);
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
        assert!(!r3.is_error, "untrusted apply_patch should succeed after user approves: {}", r3.content);
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
            .execute(
                "read_file",
                &json!({ "paths": ["a.py", ".env", "b.py"] }),
            )
            .await;
        assert!(!out.is_error, "batch read with valid files should succeed: {}", out.content);
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
        assert!(!ed.is_error, "edit after batch read should pass Pre-Read Guard: {}", ed.content);
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
        let pr = rt
            .execute("apply_patch", &json!({ "patch": patch }))
            .await;
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
            big.push_str(&format!("verbose build header log line {i:03} padding padding padding\n"));
        }
        big.push_str("Traceback (most recent call last):\n  File \"pkg/app.py\", line 42\nAssertionError: expected 99 got 1\n");
        for i in 0..200 {
            big.push_str(&format!("noisy filler output line {i:03} padding padding padding padding\n"));
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
            raw.push_str(&format!("tests/test_suite.py::test_ok_{i:02} PASSED [ {:>2}%]\n", i));
        }
        raw.push_str("tests/test_suite.py::test_bad FAILED [100%]\n");
        raw.push_str("=================================== FAILURES ===================================\n");
        raw.push_str("def test_bad():\n>   assert 1 == 2\nE   AssertionError: assert 1 == 2\n");
        raw.push_str("=========================== short test summary info ============================\n");
        raw.push_str("FAILED tests/test_suite.py::test_bad - AssertionError: assert 1 == 2\n");
        raw.push_str("========================= 1 failed, 60 passed in 0.4s ==========================\n");
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
            .execute("read_file", &json!({ "path": "big.py", "symbol": "func_080" }))
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
            .execute("discover_tools", &json!({ "query": "symbol graph lsp", "limit": 5 }))
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
        assert!(!inv_lsp.is_error, "lsp_query deferred tool failed: {}", inv_lsp.content);
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

        let _ = rt.execute("read_file", &json!({ "path": "math_ops.py" })).await;
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
        assert!(!edited.is_error, "symbol BlockDiff edit failed: {}", edited.content);
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
        let out = rt.execute("read_file", &json!({ "path": "huge.log" })).await;
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
        assert!(!sh.is_error, "non-zero exit must not be a tool failure: {}", sh.content);
        assert!(sh.content.starts_with("exit_code: 3"), "{}", sh.content);

        // GPT/Gemini-style alias arguments, editing a file that was never read_file'd
        let ed = rt
            .execute(
                "edit_file",
                &json!({ "file_path": "cfg.py", "old_text": "RATE = 0.10", "new_text": "RATE = 0.15" }),
            )
            .await;
        assert!(!ed.is_error, "alias edit failed: {}", ed.content);
        assert_eq!(fs::read_to_string(tmp.join("cfg.py")).unwrap(), "RATE = 0.15\n");
        let _ = fs::remove_dir_all(&tmp);
    }
}
