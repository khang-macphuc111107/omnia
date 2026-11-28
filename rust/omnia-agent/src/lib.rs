//! `omnia-agent`: Full Native Rust SOTA v4 Autonomous Coding Agent Engine for Omnia.
//!
//! Pure-native Rust super-harness (`omnia-winsqlite` WAL, zero Bun/Tauri/rusqlite) combining:
//! - Token-Progress SSE Watchdog + Pre-TTFT Bounded Hedging + Rust BAML SAP JSON Repair
//! - Multi-Dialect Native Wire Routing (`auto|chat|responses|messages|gemini`)
//! - Strict 4-Tier Prefix-0 KV-Cache Engine + Context-Scaled Lakeview + Factory Anchored Summary
//! - Adaptive Multi-Mode Edit Engine (Hashline v2 + Tree-sitter `BlockDiff` + `apply_patch` +
//!   post-edit AST & fast targeted compiler checks)
//! - LocAgent Heterogeneous Code Graph (`tree-sitter 0.25` 5-grammar CST + CSR PPR) + Lazy LSP
//! - `PASTE`-lite Speculative Read-Only Pool + Anti-Termination-Lag (`FAIL -> PASS`) +
//!   Ring-Buffer Oscillation Detector + BLAKE3/Deflate Atomic `/rewind` + Win32 Job Objects

pub mod acp;
mod acp_history;
pub mod acp_http;
pub mod acp_proto;
pub mod agent_store;
pub mod ast_edit;
pub mod builtin_stem;
pub mod cache_guard;
pub mod checkpoint;
pub mod context;
pub mod dap;
pub mod dynamic_plugins;
pub mod edit;
pub mod engine;
pub mod eval_scripted;
pub mod git_forensics;
pub mod graph_locator;
pub mod hooks;
pub mod lakeview;
pub mod lsp;
pub mod mcp_client;
pub mod memory_engine;
pub mod merkle;
pub mod office_reader;
pub mod output_compressor;
pub mod patch;
pub mod path_guard;
pub mod permissions;
pub mod plugin;
pub mod ptc;
pub mod pty_session;
pub mod recipes;
pub mod sanitizer;
pub mod sap_json;
pub mod search;
pub mod super_orchestrator;
pub mod supervisor;
pub mod swarm_runtime;
pub mod test_time_scaling;
pub mod tools;
pub mod trajectory;
pub mod web_tools;

/// Crate identity string for diagnostics and startup checks.
pub const CRATE_NAME: &str = "omnia-agent";

pub use acp::{
    detect_all_backends, run_acp_eval, AcpClient, AcpEvent, AcpLaunchConfig, HarnessBackendId,
    HarnessBackendInfo,
};
pub use acp_http::run_acp_http_server;
pub use agent_store::{
    default_omnia_data_dir, read_models_config, AgentStore, CachedAstRow, CachedMerkleRow,
    ModelCost, ModelEntryConfig, PlaybookEntry, ProviderConfig,
};
pub use builtin_stem::{
    analyze_redos, check_syntax_balance, dispatch_stem_verify, eval_math_expr,
    has_unsafe_redos_construct, solve_boolean_sat, solve_matrix, solve_ode_rk4, solve_root,
    stem_verify_tool_spec, validate_and_next_cron, verify_claims, BooleanSatResult, ClaimSource,
    ClaimVerificationReport, CronReport, MatrixResult, OdeRk4Result, RedosReport, RootResult,
    SyntaxBalanceReport,
};
pub use cache_guard::{
    blake3_hex, canonicalize_json, canonicalize_openai_tools, sha256_hex, HarnessCacheStats,
    PrefixCacheGuard, BASE_SYSTEM_PROMPT,
};
pub use checkpoint::{
    canonical_path_identity, parse_test_pass_counts, CompactionRebaseOutcome,
    CompactionTimelineEntry, PartialRollbackReport, PendingConversationRewind,
    RecoveryArchiveEntry, TestOutcomeTransition, TestPassCounts, TurnCheckpoint,
    TurnCheckpointStore,
};
pub use context::{DiscoveredRule, SkillMetadata, WorkspaceContextBundle};
pub use dap::DapManager;
pub use edit::{
    edit_file_by_hashline, edit_file_by_symbol_block, edit_file_guarded, line_hash_tag,
    run_fast_compiler_syntax_check, EditFileResult, FileReadSnapshot, FileReadTracker,
    ModelEditAffinity,
};
pub use engine::{
    resolve_model_endpoint, run_super_eval, HarnessEventSink, HarnessStreamEvent,
    NativeSuperEngine, PromptRunSummary, ResolvedModelEndpoint, StreamBudgetConfig,
    SuperEvalOptions, SuperEvalReport, WireApiMode,
};
pub use graph_locator::{
    verify_syntax_delta, AstSymbol, EntitySearchHit, GraphEdgeInfo, GraphNodeInfo,
    GraphTraversalReport, HarnessGraphMap, ParsedFileAst, SymbolKind, SyntaxCheckReport,
    SyntaxDiagnostic, WorkspaceGraphIndex,
};
pub use lakeview::{
    compress_stale_tool_results, offload_large_observation, AnchoredSummary, EpochMaskingState,
    ErrorKind, HarnessMessage, LakeviewCompressionReport, OscillationAlert, OscillationDetector,
    RepetitionLoopGuard, SemanticLoopGuard, ToolCallRecord,
};
pub use lsp::{LazyLspManager, LspLanguage, LspLocation, LspQueryResult};
pub use mcp_client::{
    detect_local_agy_fast_binary, discover_mcp_configs_with_home,
    discover_workspace_and_local_mcp_configs, DiscoveredMcpServer, McpDiscoveryReport,
};
pub use memory_engine::{MemoryEngine, RecallQuery, RecallResponse, RetainItemInput};
pub use merkle::{HarnessMerkleStatus, MerkleFileEntry, MerkleIndex, MerkleRefreshDelta};
pub use office_reader::{
    extract_document_text, extract_document_text_with_limit, is_supported_document_extension,
    OFFICE_MAX_UNCOMPRESSED_BYTES,
};
pub use output_compressor::{
    compress_text_output, compress_tool_output, strip_ansi_and_progress, CompressedOutput,
    CompressionStats, OutputCompressor, OutputCompressorConfig,
};
pub use patch::{apply_codex_patch, parse_codex_patch, ApplyPatchReport, FilePatchOp, PatchHunk};
pub use path_guard::{
    ensure_within_workspace, resolve_tool_path, sanitize_windows_path, strip_verbatim_prefix,
    validate_workspace_dir,
};
pub use permissions::{
    ApprovalMode, PermissionAction, PermissionDecision, PermissionEvalResult, PermissionRule,
    PermissionScope, PermissionsEngine,
};
pub use plugin::{
    builtin_deferred_semantic_tools, DeferredToolRegistry, HarnessPlugin, HarnessPluginInfo,
    PluginRegistry, PluginRegistrySnapshot, ToolSpec, TurnHookContext,
};
pub use sanitizer::{
    atomic_write_bom_free, atomic_write_bytes, format_fail_fast_error, redact_secrets,
    sanitize_untrusted_text, SanitizeReport,
};
pub use sap_json::{repair_tool_json, SapRepairResult};
pub use search::{HybridSearchIndex, SearchMode, SearchOutcome, SearchQueryOptions};
pub use super_orchestrator::{
    build_unified_capability_registry, AutoProceedPolicy, BoostEscalationDecision,
    CleanroomAuditRecord, GoalExitEvaluation, SuperActivationReceipt, SuperMode,
    SuperOrchestrator, GOAL_CANCELLED_MARKER, GOAL_COMPLETE_MARKER, OMNIA_WORKSPACE_CRATES,
    SUPER_BOOST_RCA_STRIKE_THRESHOLD, SUPER_MAX_ZERO_PROGRESS_STRIKES,
    SUPER_REQUIRED_AUDIT_STREAK, SUPER_WORKFLOW_LANES, WORKSPACE_CRATE_COUNT,
};
pub use supervisor::{
    pid_is_alive, process_tree_rss_bytes, spawn_supervised_command, strip_provider_secrets,
    strip_provider_secrets_tokio, ProcessSupervisor,
};
pub use swarm_runtime::{AdvisorEmissionGuard, AutoresearchSession, SwarmRuntime, WorktreeManager};
pub use test_time_scaling::{
    run_best_of_n, run_mcts_tree_search, run_tex_cross_validation, TestTimeScalingConfig,
};
pub use tools::{
    builtin_deferred_18crate_tools, compact_shell_output, detect_default_shell,
    ExtensionToolHandler, FileMutationLocks, InteractiveApprover, ToolExecOutput, ToolRuntime,
};
pub use trajectory::{TrajectoryEvent, TrajectoryRecorder};

use anyhow::{bail, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

/// Computes a compact 3-hex-char XXH3 Hashline tag for a single source line.
#[must_use]
pub fn hashline_tag3(line: &str) -> String {
    let h = xxhash_rust::xxh3::xxh3_64(line.trim_end_matches('\r').as_bytes());
    format!("{:03x}", (h & 0x0fff) as u16)
}

/// Unified running-session snapshot returned by `SuperHarnessManager`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperRunningSessionInfo {
    pub session_key: String,
    pub tab_id: String,
    pub cwd: String,
    pub pid: u32,
    pub rss_bytes: u64,
    pub is_streaming: bool,
    pub waiting_for_user: bool,
    pub waiting_reason: Option<String>,
    pub model_label: Option<String>,
    pub session_file: Option<String>,
    pub started_at: i64,
    pub backend: HarnessBackendId,
}

pub struct ManagedSpawnRequest {
    pub tab_id: String,
    pub cwd: PathBuf,
    pub backend: HarnessBackendId,
    pub approval_mode: ApprovalMode,
    pub workspace_trusted: bool,
    pub permission_rules: Vec<PermissionRule>,
    pub provider: Option<String>,
    pub model_id: Option<String>,
    pub thinking_level: Option<String>,
    pub wire_api: WireApiMode,
    pub config_dir: Option<PathBuf>,
    pub max_turns: u32,
}

enum SessionDriver {
    Native(Arc<AsyncMutex<NativeSuperEngine>>),
    Acp(Arc<AcpClient>),
}

struct ManagedSession {
    session_key: String,
    tab_id: String,
    cwd: PathBuf,
    backend: HarnessBackendId,
    started_at: i64,
    max_turns: u32,
    model_label: Arc<Mutex<Option<String>>>,
    is_streaming: Arc<AtomicBool>,
    waiting_for_user: Arc<AtomicBool>,
    waiting_reason: Arc<Mutex<Option<String>>>,
    cancel_flag: Arc<AtomicBool>,
    pending_confirm: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    cache_stats: Arc<Mutex<HarnessCacheStats>>,
    driver: SessionDriver,
    sink: Arc<dyn Fn(Value) + Send + Sync>,
}

/// Top-level host manager for native `omnia-agent` sessions, ACP bridges,
/// incremental Merkle/Graph caches, atomic `/rewind`, and live Cordis plugins.
#[derive(Clone)]
pub struct SuperHarnessManager {
    db: AgentStore,
    plugins: Arc<RwLock<PluginRegistry>>,
    graphs: Arc<Mutex<HashMap<PathBuf, Arc<Mutex<WorkspaceGraphIndex>>>>>,
    sessions: Arc<Mutex<HashMap<String, Arc<ManagedSession>>>>,
    last_active_session: Arc<Mutex<Option<String>>>,
}

impl SuperHarnessManager {
    #[must_use]
    pub fn new(db: AgentStore) -> Self {
        Self {
            db,
            plugins: Arc::new(RwLock::new(PluginRegistry::with_default_pillars())),
            graphs: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            last_active_session: Arc::new(Mutex::new(None)),
        }
    }

    #[must_use]
    pub fn list_backends(&self, omp_override: Option<&Path>) -> Vec<HarnessBackendInfo> {
        detect_all_backends(omp_override)
    }

    #[must_use]
    pub fn list_plugins(&self) -> Vec<HarnessPluginInfo> {
        self.plugins.read().unwrap().list_info()
    }

    pub fn toggle_plugin(&self, plugin_id: &str, enabled: bool) -> Result<Vec<HarnessPluginInfo>> {
        self.plugins.write().unwrap().toggle(plugin_id, enabled)
    }

    #[must_use]
    pub fn plugin_registry_snapshot(&self) -> PluginRegistry {
        self.plugins.read().unwrap().clone()
    }

    fn get_or_create_graph(&self, workspace_path: &Path) -> Arc<Mutex<WorkspaceGraphIndex>> {
        let clean = sanitize_windows_path(workspace_path);
        let mut map = self.graphs.lock().unwrap();
        let db = self.db.clone();
        map.entry(clean.clone())
            .or_insert_with(|| {
                Arc::new(Mutex::new(WorkspaceGraphIndex::with_options(
                    &clean,
                    PermissionsEngine::default_rules(),
                    Some(db),
                )))
            })
            .clone()
    }

    pub fn merkle_status(
        &self,
        workspace_path: &Path,
        force_refresh: bool,
    ) -> Result<HarnessMerkleStatus> {
        let graph = self.get_or_create_graph(workspace_path);
        let mut g = graph.lock().unwrap();
        if force_refresh || g.merkle().files().is_empty() {
            let _ = g.refresh()?;
        }
        Ok(g.merkle().status(g.symbol_count()))
    }

    pub fn graph_map(&self, workspace_path: &Path, max_nodes: usize) -> Result<HarnessGraphMap> {
        let graph = self.get_or_create_graph(workspace_path);
        let mut g = graph.lock().unwrap();
        let _ = g.refresh()?;
        Ok(g.build_map(None, None, max_nodes.clamp(10, 200)))
    }

    #[must_use]
    pub fn cache_stats(&self, session_key: Option<&str>) -> HarnessCacheStats {
        let lookup_key = session_key
            .map(String::from)
            .or_else(|| self.last_active_session.lock().unwrap().clone());

        if let Some(sk) = lookup_key {
            if let Some(sess) = self.sessions.lock().unwrap().get(&sk) {
                return sess.cache_stats.lock().unwrap().clone();
            }
        }

        let reg = self.plugins.read().unwrap();
        let sys = if reg.is_enabled("self_verify_gate") {
            BASE_SYSTEM_PROMPT
        } else {
            cache_guard::BASE_SYSTEM_PROMPT_NO_VERIFY
        };
        let tools = canonicalize_openai_tools(&reg.active_tools_with_deferred(false, true));
        PrefixCacheGuard::new(None, sys, &tools).snapshot()
    }

    #[must_use]
    pub fn owns_session(&self, session_key: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(session_key)
    }

    #[must_use]
    pub fn get_session_tab_id(&self, session_key: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap()
            .get(session_key)
            .map(|s| s.tab_id.clone())
    }

    /// Spawn a native `omnia-agent` or external `*-acp` interactive session.
    pub async fn spawn_session(
        &self,
        req: ManagedSpawnRequest,
        event_sink: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> Result<(String, u32, Value)> {
        let clean_cwd = sanitize_windows_path(&req.cwd);
        if !clean_cwd.exists() {
            bail!(
                "workspace directory does not exist: {}",
                clean_cwd.display()
            );
        }

        let session_key = uuid::Uuid::new_v4().to_string();
        let model_spec = match (&req.provider, &req.model_id) {
            (Some(p), Some(m)) if !p.trim().is_empty() && !m.trim().is_empty() => {
                format!("{p}/{m}")
            }
            (_, Some(m)) if !m.trim().is_empty() => m.clone(),
            _ => "htmustc-claude/claude-sonnet-5-5".to_string(),
        };

        let pending_confirm: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let waiting_for_user = Arc::new(AtomicBool::new(false));
        let waiting_reason = Arc::new(Mutex::new(None::<String>));
        let cancel_flag = Arc::new(AtomicBool::new(false));

        let (driver, pid, initial_state, initial_cache, model_label_str) = if req.backend
            == HarnessBackendId::OmniSuper
        {
            let endpoint =
                resolve_model_endpoint(&model_spec, req.config_dir.as_deref(), None, None)?;
            let model_lbl = format!("{}/{}", endpoint.provider_id, endpoint.model_id);
            let graph = self.get_or_create_graph(&clean_cwd);
            {
                let mut g = graph.lock().unwrap();
                let _ = g.refresh();
            }

            let sk_ap = session_key.clone();
            let sink_ap = Arc::clone(&event_sink);
            let pending_ap = Arc::clone(&pending_confirm);
            let waiting_ap = Arc::clone(&waiting_for_user);
            let reason_ap = Arc::clone(&waiting_reason);
            let approver: InteractiveApprover = Arc::new(move |tool: String, target: String| {
                let sk = sk_ap.clone();
                let sink = Arc::clone(&sink_ap);
                let pending = Arc::clone(&pending_ap);
                let waiting = Arc::clone(&waiting_ap);
                let reason = Arc::clone(&reason_ap);
                Box::pin(async move {
                    let req_id = format!("perm-{}", uuid::Uuid::new_v4());
                    let (tx, rx) = oneshot::channel();
                    pending.lock().unwrap().insert(req_id.clone(), tx);
                    waiting.store(true, Ordering::Relaxed);
                    let msg = format!("Allow `{tool}` on `{target}`?");
                    *reason.lock().unwrap() = Some(msg.clone());
                    sink(json!({
                        "kind": "extension_ui_request",
                        "sessionKey": sk,
                        "request": {
                            "id": req_id,
                            "method": "confirm",
                            "title": format!("Permission: {tool}"),
                            "message": msg
                        }
                    }));
                    let ok = tokio::time::timeout(Duration::from_secs(120), rx)
                        .await
                        .ok()
                        .and_then(|r| r.ok())
                        .unwrap_or(false);
                    waiting.store(false, Ordering::Relaxed);
                    *reason.lock().unwrap() = None;
                    ok
                })
            });

            let mut engine = NativeSuperEngine::new(
                session_key.clone(),
                clean_cwd.clone(),
                endpoint.clone(),
                req.thinking_level.clone(),
                req.approval_mode,
                req.workspace_trusted,
                req.permission_rules,
                self.plugin_registry_snapshot(),
                graph,
                Some(self.db.clone()),
                Some(approver),
                Arc::clone(&cancel_flag),
                None,
            )?;
            engine.wire_api_mode = req.wire_api;
            let snap = engine.cache_guard.snapshot();
            let init_state = json!({
                "backend": "omnia-agent",
                "wireDialect": engine.active_wire_dialect(),
                "model": {
                    "provider": endpoint.provider_id,
                    "id": endpoint.model_id,
                    "contextWindow": endpoint.context_window,
                    "maxTokens": endpoint.max_tokens
                },
                "thinkingLevel": req.thinking_level.clone().unwrap_or_else(|| "max".into()),
                "prefixStable": snap.prefix_stable,
                "estimatedBasePromptTokens": snap.estimated_base_prompt_tokens
            });
            (
                SessionDriver::Native(Arc::new(AsyncMutex::new(engine))),
                std::process::id(),
                init_state,
                snap,
                model_lbl,
            )
        } else if req.backend.is_acp() {
            let ep =
                resolve_model_endpoint(&model_spec, req.config_dir.as_deref(), None, None).ok();
            let cfg = AcpLaunchConfig::resolve(
                req.backend,
                None,
                &clean_cwd,
                Some(&model_spec),
                ep.as_ref().map(|e| e.base_url.as_str()),
                ep.as_ref().map(|e| e.api_key.as_str()),
                req.approval_mode,
                req.workspace_trusted,
                req.permission_rules,
            )?;
            let sk_acp = session_key.clone();
            let sink_acp = Arc::clone(&event_sink);
            let acp_sink: acp::AcpEventSink = Arc::new(move |ev| match ev {
                AcpEvent::TextDelta(t) => sink_acp(json!({
                    "kind": "delta_batch",
                    "sessionKey": sk_acp,
                    "messageId": "acp-msg",
                    "textDelta": t,
                    "thinkingDelta": "",
                    "timestampMs": Utc::now().timestamp_millis()
                })),
                AcpEvent::ThinkingDelta(t) => sink_acp(json!({
                    "kind": "delta_batch",
                    "sessionKey": sk_acp,
                    "messageId": "acp-msg",
                    "textDelta": "",
                    "thinkingDelta": t,
                    "timestampMs": Utc::now().timestamp_millis()
                })),
                AcpEvent::ToolCallStart { id, name } => sink_acp(json!({
                    "kind": "rpc_event",
                    "sessionKey": sk_acp,
                    "eventType": "tool_execution_start",
                    "payload": { "toolCallId": id, "toolName": name }
                })),
                AcpEvent::ToolCallEnd { id, name, is_error } => sink_acp(json!({
                    "kind": "rpc_event",
                    "sessionKey": sk_acp,
                    "eventType": "tool_execution_end",
                    "payload": { "toolCallId": id, "toolName": name, "isError": is_error }
                })),
                AcpEvent::ProcessExit {
                    exit_code,
                    stderr_tail,
                } => sink_acp(json!({
                    "kind": "process_exit",
                    "sessionKey": sk_acp,
                    "exitCode": exit_code,
                    "stderrTail": stderr_tail
                })),
                AcpEvent::RawUpdate(v) => sink_acp(json!({
                    "kind": "rpc_event",
                    "sessionKey": sk_acp,
                    "eventType": "acp_update",
                    "payload": v
                })),
            });

            let client = AcpClient::spawn_and_initialize(cfg, acp_sink).await?;
            let pid = client.pid;
            let init_state = json!({
                "backend": req.backend.as_str(),
                "acpSessionId": client.acp_session_id,
                "agentInfo": client.agent_info,
                "model": { "id": model_spec }
            });
            let snap = self.cache_stats(None);
            (
                SessionDriver::Acp(Arc::new(client)),
                pid,
                init_state,
                snap,
                model_spec.clone(),
            )
        } else {
            bail!("unsupported backend {:?}", req.backend);
        };

        let managed = Arc::new(ManagedSession {
            session_key: session_key.clone(),
            tab_id: req.tab_id,
            cwd: clean_cwd,
            backend: req.backend,
            started_at: Utc::now().timestamp(),
            max_turns: req.max_turns.clamp(1, 120),
            model_label: Arc::new(Mutex::new(Some(model_label_str))),
            is_streaming: Arc::new(AtomicBool::new(false)),
            waiting_for_user,
            waiting_reason,
            cancel_flag,
            pending_confirm,
            cache_stats: Arc::new(Mutex::new(initial_cache)),
            driver,
            sink: Arc::clone(&event_sink),
        });

        self.sessions
            .lock()
            .unwrap()
            .insert(session_key.clone(), managed);
        *self.last_active_session.lock().unwrap() = Some(session_key.clone());

        event_sink(json!({
            "kind": "ready",
            "sessionKey": session_key,
            "protocolVersion": 2
        }));

        Ok((session_key, pid, initial_state))
    }

    pub async fn send_prompt(&self, session_key: &str, message: &str) -> Result<Value> {
        let sess = self
            .sessions
            .lock()
            .unwrap()
            .get(session_key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("unknown omnia-agent session: {session_key}"))?;

        *self.last_active_session.lock().unwrap() = Some(session_key.to_string());
        sess.cancel_flag.store(false, Ordering::Relaxed);
        sess.is_streaming.store(true, Ordering::Relaxed);

        let prompt_str = message.to_string();
        let req_id = format!("agent-{}", uuid::Uuid::new_v4());
        let req_id_ret = req_id.clone();

        tokio::spawn(async move {
            let sk = sess.session_key.clone();
            let sink = Arc::clone(&sess.sink);
            let cache_cell = Arc::clone(&sess.cache_stats);
            let backend_str = sess.backend.as_str();

            let outcome: Result<(String, Option<String>)> = match &sess.driver {
                SessionDriver::Native(eng_mtx) => {
                    let sk_ev = sk.clone();
                    let sink_ev = Arc::clone(&sink);
                    let cache_ev = Arc::clone(&cache_cell);
                    let h_sink: HarnessEventSink = Arc::new(move |ev| match ev {
                        HarnessStreamEvent::DeltaBatch {
                            message_id,
                            text_delta,
                            thinking_delta,
                        } => sink_ev(json!({
                            "kind": "delta_batch",
                            "sessionKey": sk_ev,
                            "messageId": message_id,
                            "textDelta": text_delta,
                            "thinkingDelta": thinking_delta,
                            "timestampMs": Utc::now().timestamp_millis()
                        })),
                        HarnessStreamEvent::TurnStart { turn } => sink_ev(json!({
                            "kind": "rpc_event",
                            "sessionKey": sk_ev,
                            "eventType": "turn_start",
                            "payload": { "turn": turn }
                        })),
                        HarnessStreamEvent::TurnEnd { turn } => sink_ev(json!({
                            "kind": "rpc_event",
                            "sessionKey": sk_ev,
                            "eventType": "turn_end",
                            "payload": { "turn": turn }
                        })),
                        HarnessStreamEvent::ToolStart {
                            tool_call_id,
                            tool_name,
                            arguments,
                        } => sink_ev(json!({
                            "kind": "rpc_event",
                            "sessionKey": sk_ev,
                            "eventType": "tool_execution_start",
                            "payload": {
                                "toolCallId": tool_call_id,
                                "toolName": tool_name,
                                "args": arguments
                            }
                        })),
                        HarnessStreamEvent::ToolEnd {
                            tool_call_id,
                            tool_name,
                            output,
                            is_error,
                            duration_ms,
                        } => sink_ev(json!({
                            "kind": "rpc_event",
                            "sessionKey": sk_ev,
                            "eventType": "tool_execution_end",
                            "payload": {
                                "toolCallId": tool_call_id,
                                "toolName": tool_name,
                                "isError": is_error,
                                "durationMs": duration_ms,
                                "result": { "content": [{ "type": "text", "text": output }] }
                            }
                        })),
                        HarnessStreamEvent::AutoRecovery { attempt, reason } => sink_ev(json!({
                            "kind": "auto_recovery",
                            "sessionKey": sk_ev,
                            "attempt": attempt,
                            "reason": reason
                        })),
                        HarnessStreamEvent::Metrics {
                            tokens_per_second,
                            context_tokens,
                            context_window,
                            context_percent,
                            total_cost_usd,
                        } => sink_ev(json!({
                            "kind": "metrics",
                            "sessionKey": sk_ev,
                            "tokensPerSecond": tokens_per_second,
                            "contextTokens": context_tokens,
                            "contextWindow": context_window,
                            "contextPercent": context_percent,
                            "totalCostUsd": total_cost_usd
                        })),
                        HarnessStreamEvent::Telemetry {
                            cache_stats,
                            merkle_root,
                            merkle_refresh_ms,
                            lakeview_compressions,
                            turn_count,
                            tool_call_count,
                            tool_error_count,
                        } => {
                            *cache_ev.lock().unwrap() = cache_stats.clone();
                            sink_ev(json!({
                                "kind": "harness_telemetry",
                                "sessionKey": sk_ev,
                                "backend": backend_str,
                                "cacheStats": cache_stats,
                                "merkleRoot": merkle_root,
                                "merkleRefreshMs": merkle_refresh_ms,
                                "lakeviewCompressions": lakeview_compressions,
                                "turnCount": turn_count,
                                "toolCallCount": tool_call_count,
                                "toolErrorCount": tool_error_count
                            }));
                        }
                    });

                    let mut eng = eng_mtx.lock().await;
                    match eng
                        .run_prompt(&prompt_str, sess.max_turns, 300, Some(h_sink))
                        .await
                    {
                        Ok(sum) => {
                            *cache_cell.lock().unwrap() = sum.cache_stats;
                            Ok((sum.status, sum.error))
                        }
                        Err(e) => Err(e),
                    }
                }
                SessionDriver::Acp(client) => {
                    match client.prompt(&prompt_str, Duration::from_secs(300)).await {
                        Ok(_) => Ok(("completed".into(), None)),
                        Err(e) => Err(e),
                    }
                }
            };

            sess.is_streaming.store(false, Ordering::Relaxed);
            match outcome {
                Ok((st, err)) => {
                    sink(json!({
                        "kind": "prompt_result",
                        "sessionKey": sk,
                        "requestId": req_id,
                        "status": st,
                        "sessionSettled": true,
                        "error": err.map(|m| json!({ "message": m }))
                    }));
                }
                Err(e) => {
                    sink(json!({
                        "kind": "prompt_result",
                        "sessionKey": sk,
                        "requestId": req_id,
                        "status": "error",
                        "sessionSettled": true,
                        "error": { "message": e.to_string() }
                    }));
                }
            }
            sink(json!({ "kind": "session_settled", "sessionKey": sk }));
        });

        Ok(json!({ "accepted": true, "requestId": req_id_ret }))
    }

    /// Atomic `/rewind` exposed on `SuperHarnessManager` for Wave 3 Studio & CLI wiring.
    pub async fn rewind_to_turn(&self, session_key: &str, target_turn: u32) -> Result<Vec<String>> {
        let sess = self
            .sessions
            .lock()
            .unwrap()
            .get(session_key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("unknown session: {session_key}"))?;
        if let SessionDriver::Native(ref eng_mtx) = sess.driver {
            let mut eng = eng_mtx.lock().await;
            return eng.rewind_to_turn(target_turn);
        }
        bail!("rewind_to_turn is supported only on native omnia-agent sessions")
    }

    pub fn respond_confirm(
        &self,
        session_key: &str,
        request_id: &str,
        confirmed: bool,
    ) -> Result<()> {
        let sess = self
            .sessions
            .lock()
            .unwrap()
            .get(session_key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("unknown session: {session_key}"))?;
        if let Some(tx) = sess.pending_confirm.lock().unwrap().remove(request_id) {
            let _ = tx.send(confirmed);
        }
        Ok(())
    }

    pub fn abort_session(&self, session_key: &str) {
        if let Some(sess) = self.sessions.lock().unwrap().get(session_key).cloned() {
            sess.cancel_flag.store(true, Ordering::Relaxed);
            if let SessionDriver::Acp(ref client) = sess.driver {
                client.cancel();
            }
        }
    }

    pub async fn set_model(
        &self,
        session_key: &str,
        provider: &str,
        model_id: &str,
        thinking_level: Option<String>,
    ) -> Result<Value> {
        let sess = self
            .sessions
            .lock()
            .unwrap()
            .get(session_key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("unknown session: {session_key}"))?;
        let spec = if provider.trim().is_empty() {
            model_id.to_string()
        } else {
            format!("{provider}/{model_id}")
        };
        if let SessionDriver::Native(ref eng_mtx) = sess.driver {
            let ep = resolve_model_endpoint(&spec, None, None, None)?;
            let mut eng = eng_mtx.lock().await;
            eng.endpoint = ep.clone();
            eng.epoch_masker = EpochMaskingState::for_context_window(ep.context_window);
            eng.edit_affinity = ModelEditAffinity::for_model(&ep.model_id);
            if thinking_level.is_some() {
                eng.thinking_level = thinking_level;
            }
            *sess.model_label.lock().unwrap() = Some(format!("{}/{}", ep.provider_id, ep.model_id));
            return Ok(json!({
                "provider": ep.provider_id,
                "modelId": ep.model_id,
                "contextWindow": ep.context_window,
                "wireDialect": eng.active_wire_dialect()
            }));
        }
        *sess.model_label.lock().unwrap() = Some(spec.clone());
        Ok(json!({ "model": spec }))
    }

    pub async fn set_thinking(&self, session_key: &str, level: &str) -> Result<()> {
        let sess = self
            .sessions
            .lock()
            .unwrap()
            .get(session_key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("unknown session: {session_key}"))?;
        if let SessionDriver::Native(ref eng_mtx) = sess.driver {
            let mut eng = eng_mtx.lock().await;
            eng.thinking_level = Some(level.to_string());
        }
        Ok(())
    }

    pub async fn get_state(&self, session_key: &str) -> Result<Value> {
        let sess = self
            .sessions
            .lock()
            .unwrap()
            .get(session_key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("unknown session: {session_key}"))?;
        let stats = sess.cache_stats.lock().unwrap().clone();
        Ok(json!({
            "sessionKey": sess.session_key,
            "backend": sess.backend.as_str(),
            "cwd": sess.cwd.to_string_lossy(),
            "isStreaming": sess.is_streaming.load(Ordering::Relaxed),
            "model": sess.model_label.lock().unwrap().clone(),
            "cacheStats": stats
        }))
    }

    pub async fn get_messages(&self, session_key: &str) -> Result<Value> {
        let sess = self
            .sessions
            .lock()
            .unwrap()
            .get(session_key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("unknown session: {session_key}"))?;
        if let SessionDriver::Native(ref eng_mtx) = sess.driver {
            let eng = eng_mtx.lock().await;
            let visible: Vec<&HarnessMessage> =
                eng.messages.iter().filter(|m| m.role != "system").collect();
            return Ok(serde_json::to_value(&visible)?);
        }
        Ok(json!([]))
    }

    pub async fn compact_session(&self, session_key: &str) -> Result<Value> {
        let sess = self
            .sessions
            .lock()
            .unwrap()
            .get(session_key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("unknown session: {session_key}"))?;
        if let SessionDriver::Native(ref eng_mtx) = sess.driver {
            let mut eng = eng_mtx.lock().await;
            let cur = eng.total_turns + 2;
            let rep = compress_stale_tool_results(&mut eng.messages, cur, 600, 1);
            eng.cache_guard.lakeview_compressions += rep.compressed_count;
            eng.cache_guard.lakeview_chars_saved += rep.chars_saved;
            let snap = eng.cache_guard.snapshot();
            *sess.cache_stats.lock().unwrap() = snap.clone();
            return Ok(json!({
                "compacted": true,
                "compressedCount": rep.compressed_count,
                "charsSaved": rep.chars_saved,
                "cacheStats": snap
            }));
        }
        Ok(json!({
            "compacted": false,
            "reason": "manual compaction is native to omnia-agent sessions"
        }))
    }

    pub fn stop_session(&self, session_key: &str) {
        if let Some(sess) = self.sessions.lock().unwrap().remove(session_key) {
            sess.cancel_flag.store(true, Ordering::Relaxed);
            if let SessionDriver::Acp(ref client) = sess.driver {
                client.kill();
            }
        }
    }

    pub fn stop_all(&self) {
        let all: Vec<Arc<ManagedSession>> = self
            .sessions
            .lock()
            .unwrap()
            .drain()
            .map(|(_, v)| v)
            .collect();
        for sess in all {
            sess.cancel_flag.store(true, Ordering::Relaxed);
            if let SessionDriver::Acp(ref client) = sess.driver {
                client.kill();
            }
        }
    }

    #[must_use]
    pub fn list_running(&self) -> Vec<SuperRunningSessionInfo> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .values()
            .map(|s| {
                let (pid, rss) = match &s.driver {
                    SessionDriver::Native(_) => {
                        let p = std::process::id();
                        (p, process_tree_rss_bytes(p))
                    }
                    SessionDriver::Acp(c) => (c.pid, c.rss_bytes()),
                };
                SuperRunningSessionInfo {
                    session_key: s.session_key.clone(),
                    tab_id: s.tab_id.clone(),
                    cwd: s.cwd.to_string_lossy().into_owned(),
                    pid,
                    rss_bytes: rss,
                    is_streaming: s.is_streaming.load(Ordering::Relaxed),
                    waiting_for_user: s.waiting_for_user.load(Ordering::Relaxed),
                    waiting_reason: s.waiting_reason.lock().unwrap().clone(),
                    model_label: s.model_label.lock().unwrap().clone(),
                    session_file: None,
                    started_at: s.started_at,
                    backend: s.backend,
                }
            })
            .collect()
    }
}

/// Run an ACP JSON-RPC 2.0 stdio server (`omnia --acp`) backed by `NativeSuperEngine`.
///
/// Reads stdin on a dedicated reader thread into an async channel and dispatches
/// `session/prompt` concurrently so `session/cancel` sets `cancel_flag` immediately
/// while a prompt turn is in flight. Defaults to `ApprovalMode::Yolo`
/// (`workspace_trusted: true`, full-freedom auto-approve) unless the client
/// explicitly sets a strict approval mode (`AlwaysAsk` / `Plan`) or env override.
pub async fn run_acp_stdio_server(
    default_model: Option<String>,
    default_base_url: Option<String>,
    default_api_key: Option<String>,
) -> Result<()> {
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let emit_arc = Arc::clone(&stdout);
    let emit = move |frame: Value| {
        if let Ok(mut out) = emit_arc.lock() {
            let _ = writeln!(out, "{frame}");
            let _ = out.flush();
        }
    };

    let (line_tx, mut line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line_res in stdin.lock().lines() {
            match line_res {
                Ok(l) => {
                    if line_tx.send(l).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let mut state = acp_http::new_acp_state(default_model, default_base_url, default_api_key);
    // Defaults to `ApprovalMode::Yolo` (`workspace_trusted: true`, auto-approve);
    // when a client explicitly requests a strict approval mode (`AlwaysAsk` / `Plan`),
    // engine `Ask` decisions still round-trip via ACP `session/request_permission`.
    state.secret_key = None;
    state.stdio_replay = true;
    let stdout_for_perm = Arc::clone(&stdout);
    state.perm_emitter = Some(Arc::new(move |frame: Value| -> bool {
        if let Ok(mut out) = stdout_for_perm.lock() {
            let _ = writeln!(out, "{frame}");
            let _ = out.flush();
            return true;
        }
        false
    }));
    let state = Arc::new(state);

    while let Some(line) = line_rx.recv().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let is_prompt = matches!(
            req.get("method").and_then(Value::as_str),
            Some("session/prompt" | "session/load")
        );
        if is_prompt {
            // Run the turn on a task so `session/cancel` and permission responses
            // keep being dispatched while it is in flight.
            let st = Arc::clone(&state);
            let emit_task = emit.clone();
            tokio::spawn(async move {
                let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
                let reply = acp_http::dispatch_rpc(req, &st, Some(tx)).await;
                while let Some(frame) = rx.recv().await {
                    emit_task(frame);
                }
                if let Some(frame) = reply {
                    emit_task(frame);
                }
            });
            continue;
        }
        if let Some(reply) = acp_http::dispatch_rpc(req, &state, None).await {
            emit(reply);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_hash_primitives_and_v4_defaults_work() {
        let digest = blake3_hex(b"omnia-agent");
        assert_eq!(digest.len(), 64);
        assert_eq!(hashline_tag3("fn main() {}").len(), 3);
        assert_eq!(
            ModelEditAffinity::for_model("deepseek-v4"),
            ModelEditAffinity::UnifiedDiffPatch
        );
        assert_eq!(
            ModelEditAffinity::for_model("claude-sonnet-5-5"),
            ModelEditAffinity::HashlineV2
        );
        assert_eq!(
            WireApiMode::Auto.resolve_api_kind("claude-sonnet-5-5", "openai-completions"),
            "anthropic-messages"
        );
        assert_eq!(
            WireApiMode::Auto.resolve_api_kind("gemini-3.8-flash", "openai-completions"),
            "openai-completions"
        );
        assert_eq!(
            WireApiMode::Auto.resolve_api_kind("deepseek-v4-pro", "openai-completions"),
            "openai-completions"
        );
        assert_eq!(
            WireApiMode::Auto.resolve_api_kind("glm-5", "openai-completions"),
            "openai-completions"
        );
        assert_eq!(
            WireApiMode::Auto.resolve_api_kind("kimi-k3", "openai-completions"),
            "openai-completions"
        );
        assert_eq!(
            WireApiMode::Auto.resolve_api_kind("qwen3-coder", "openai-completions"),
            "openai-completions"
        );
        assert_eq!(
            WireApiMode::Auto.resolve_api_kind("gpt-6.2-sol", "openai-completions"),
            "openai-responses"
        );
        assert_eq!(
            WireApiMode::Responses.resolve_api_kind("gpt-6.2-sol", "openai-completions"),
            "openai-responses"
        );
        let em_1m = EpochMaskingState::for_context_window(1_000_000);
        assert_eq!(em_1m.soft_watermark_chars, 280_000);
        let em_128k = EpochMaskingState::for_context_window(128_000);
        assert_eq!(em_128k.soft_watermark_chars, 230_400);
    }

    #[tokio::test]
    async fn super_harness_manager_exposes_rewind_to_turn() {
        let tmp = std::env::temp_dir().join(format!("omni_mgr_rw_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let target = tmp.join("state.txt");
        std::fs::write(&target, "before\n").unwrap();

        let mgr = SuperHarnessManager::new(AgentStore::open_in_memory().unwrap());
        let (session_key, _pid, _state) = mgr
            .spawn_session(
                ManagedSpawnRequest {
                    tab_id: "tab-1".into(),
                    cwd: tmp.clone(),
                    backend: HarnessBackendId::OmniSuper,
                    approval_mode: ApprovalMode::Yolo,
                    workspace_trusted: true,
                    permission_rules: PermissionsEngine::default_rules(),
                    provider: Some("mock".into()),
                    model_id: Some("mock-model".into()),
                    thinking_level: None,
                    wire_api: WireApiMode::Chat,
                    config_dir: None,
                    max_turns: 4,
                },
                Arc::new(|_| {}),
            )
            .await
            .unwrap();
        {
            let sess = mgr
                .sessions
                .lock()
                .unwrap()
                .get(&session_key)
                .cloned()
                .unwrap();
            if let SessionDriver::Native(ref eng_mtx) = sess.driver {
                let eng = eng_mtx.lock().await;
                eng.tool_runtime
                    .checkpoint_store
                    .lock()
                    .unwrap()
                    .record_pre_mutation(2, "state.txt", &target);
                std::fs::write(&target, "after\n").unwrap();
            }
        }
        let restored = mgr.rewind_to_turn(&session_key, 1).await.unwrap();
        assert_eq!(restored, vec!["state.txt".to_string()]);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "before\n");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
