//! Legacy `/api/*` Flagship Studio routes & shared `StudioState` backed by Omnia Rust crates.

use crate::config::StudioConfig;
use crate::history::{handle_history, handle_history_messages};
use crate::embedded_ui::load_v5_ui_asset;
use crate::event_feed::EventFeed;
use crate::http::{serve_static_asset, HttpRequest, HttpResponse};
use crate::ops_store::OpsStore;
use crate::routes_observatory_v5::ObservatoryState;
use crate::routes_studio_v5::BrowserCdpState;
use crate::terminal_hub::TerminalHub;
use crate::ws_hub::prepare_websocket_upgrade;
use omnia_agent::dynamic_plugins::CordisPluginManager;
use omnia_agent::hooks::HookRegistry;
use omnia_agent::mcp_client::McpManager;
use omnia_agent::memory_engine::MemoryEngine;
use omnia_agent::{read_models_config, AgentStore, DapManager, SuperHarnessManager};
use crate::routes_capabilities::{
    dispatch_capability_route, ConnectorConfigRecord, RemoteControlState,
};
use crate::routes_downloads::{dispatch_download_route, is_known_download_route};
use crate::routes_notebooks::dispatch_notebook_route;
use crate::routes_research_lifecycle_v5;
use crate::runtime_proxy::RuntimeProxy;
use crate::telemetry::{
    count_rust_files, discover_crate_count, is_reparse_or_symlink, query_current_binary_bytes,
    detect_rustc_version, query_working_set_bytes,
};
use omnia_core::{now_epoch_ms, SecretRedactor};
use omnia_downloader::{
    validate_safe_local_path, CaptureBundle, DownloadConfig, DownloadManager, SchedulerConfig,
    SitePolicyRegistry,
};
use omnia_graph::{
    AgentGraphError, GraphifyEdge, GraphifyEntity, GraphifyIndex, PeerMeshGraph,
    TraversalDirection,
};
use omnia_harness::{
    artifact_os::ArtifactOs,
    composer_model::ComposerModel,
    deep_think::DeepThinkEngine,
    memory_graph::{MemoryEntry, MemoryError, MemoryGraph, MemoryTier},
    proactive_rag::ProactiveRag,
    research_vault::ResearchVault,
    rich_composer::{symbol_palette, DocumentAnchor, RichComposer, TextStyle},
    skill_registry::SkillRegistry,
    steer_queue::{SteerMode, SteerQueue},
};
use omnia_notebook::NotebookEngine;
use omnia_routing::{
    CandidateResourceState, CandidateScoreBreakdown, CandidateSnapshot, CircuitState,
    DynamicProviderRouter, ModelCapabilities, PrivacyTier, QuotaState,
    RouteCandidate, RouteDecisionReceipt, RouteRequestPolicy, TaskRisk,
};
use omnia_storage::{
    is_valid_studio_session_id, SessionCursor, SessionMessageRecord, SessionStore,
};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

const MAX_SKILL_CONTENT_CHARS: usize = 1024;
const SKILL_PROJECTION_PREFIX: &str = "kdense-";

/// Shared application state backing `omnia-studio.exe`.
pub struct StudioState {
    pub config: StudioConfig,
    pub runtime_proxy: RuntimeProxy,
    pub sessions: SessionStore,
    pub router: DynamicProviderRouter,
    pub peer_mesh: PeerMeshGraph,
    pub graphify: GraphifyIndex,
    pub memory: MemoryGraph,
    pub rag: ProactiveRag,
    pub skills: SkillRegistry,
    pub steer: SteerQueue,
    pub composer: Mutex<RichComposer>,
    pub connectors: Mutex<Vec<ConnectorConfigRecord>>,
    pub remote: Mutex<RemoteControlState>,
    pub downloads: Arc<DownloadManager>,
    pub downloads_staging_dir: PathBuf,
    pub download_scheduler_config: Mutex<SchedulerConfig>,
    pub download_site_policies: Mutex<SitePolicyRegistry>,
    pub captured_bundles: Mutex<Vec<CaptureBundle>>,
    pub notebooks: Arc<NotebookEngine>,
    pub research_vault: Arc<ResearchVault>,
    pub deep_think: Arc<DeepThinkEngine>,
    pub artifact_os: Arc<ArtifactOs>,
    pub event_feed: Arc<EventFeed>,
    pub ops: Arc<OpsStore>,
    pub terminals: Arc<TerminalHub>,
    pub harness: Arc<SuperHarnessManager>,
    pub memory_engine: Arc<MemoryEngine>,
    pub browser: Arc<tokio::sync::Mutex<BrowserCdpState>>,
    pub mcp: Arc<McpManager>,
    pub hooks: Arc<HookRegistry>,
    pub cordis_plugins: Arc<CordisPluginManager>,
    pub dap: Arc<DapManager>,
    pub observatory: Arc<ObservatoryState>,
    pub lease_owner_id: String,
    pub lease_epoch: AtomicI64,
    pub rust_files: usize,
    pub crate_count: usize,
    pub binary_bytes: u64,
    pub pid: u32,
}

impl Drop for StudioState {
    fn drop(&mut self) {
        let epoch = self.lease_epoch.load(Ordering::Relaxed);
        if epoch > 0 {
            let _ = self
                .sessions
                .release_lease_fenced(&self.lease_owner_id, i64::from(self.pid), epoch);
        } else {
            let _ = self.sessions.release_lease(&self.lease_owner_id);
        }
    }
}

impl StudioState {
    /// Initializes all native Rust subsystems cleanly from `config` (zero fake seeded state).
    pub fn new(config: StudioConfig) -> Result<Self, String> {
        let runtime_proxy = RuntimeProxy::new(config.runtime_timeout)?;

        let sessions = match config.db_path.as_ref() {
            Some(db_path) => {
                if let Some(parent) = db_path.parent() {
                    if !parent.as_os_str().is_empty() {
                        fs::create_dir_all(parent).map_err(|err| {
                            format!(
                                "Failed creating SQLite DB directory '{}': {err}",
                                parent.display()
                            )
                        })?;
                    }
                }
                SessionStore::open(db_path)
                    .map_err(|err| format!("Failed opening SQLite SessionStore: {err}"))?
            }
            None => SessionStore::open_in_memory()
                .map_err(|err| format!("Failed opening in-memory SessionStore: {err}"))?,
        };

        let ops = match config.db_path.as_ref() {
            Some(db_path) => OpsStore::open(&db_path.with_file_name("studio_ops.db"))?,
            None => OpsStore::open_in_memory()?,
        };
        let agent_store = match config.db_path.as_ref() {
            Some(db_path) => AgentStore::open(&db_path.with_file_name("studio_agent.db"))
                .map_err(|e| format!("Failed opening AgentStore: {e}"))?,
            None => AgentStore::open_in_memory()
                .map_err(|e| format!("Failed opening in-memory AgentStore: {e}"))?,
        };
        let memory_engine = match config.db_path.as_ref() {
            Some(db_path) => MemoryEngine::open(
                db_path.with_file_name("studio_memory.db"),
                Some(agent_store.clone()),
            )
            .map_err(|e| format!("Failed opening MemoryEngine: {e}"))?,
            None => MemoryEngine::open_in_memory()
                .map_err(|e| format!("Failed opening in-memory MemoryEngine: {e}"))?,
        };

        let pid = std::process::id();
        let now = now_epoch_ms();
        let lease_owner_id = format!("studio-server-{pid}-{}", &omnia_core::uuid_v4()[..8]);
        let lease_epoch = sessions
            .acquire_lease_record(&lease_owner_id, i64::from(pid), 60_000, now)
            .ok()
            .flatten()
            .map_or(0, |rec| rec.lease_epoch);

        let is_default_external =
            config.rollback_root == Path::new(crate::config::DEFAULT_ROLLBACK_ROOT);
        let research_vault = Arc::new(match config.db_path.as_ref() {
            Some(db_path) => {
                if is_default_external {
                    ResearchVault::open(&config.workspace_root, None)
                } else {
                    let vault_dir = db_path.with_file_name("research-vault");
                    ResearchVault::open(&config.workspace_root, Some(&vault_dir))
                }
                .map_err(|e| format!("Failed opening ResearchVault: {e}"))?
            }
            None => ResearchVault::open_in_memory()
                .map_err(|e| format!("Failed opening in-memory ResearchVault: {e}"))?,
        });
        let deep_think = Arc::new(match config.db_path.as_ref() {
            Some(db_path) => {
                let dt_path = if is_default_external {
                    PathBuf::from(r"D:\OmniaData\memory\omnia_deep_think.db")
                } else {
                    db_path.with_file_name("omnia_deep_think.db")
                };
                DeepThinkEngine::open(&dt_path)
                    .map_err(|e| format!("Failed opening DeepThinkEngine: {e}"))?
            }
            None => DeepThinkEngine::open_in_memory()
                .map_err(|e| format!("Failed opening in-memory DeepThinkEngine: {e}"))?,
        });
        let artifact_os = Arc::new(match config.db_path.as_ref() {
            Some(db_path) => {
                if is_default_external {
                    ArtifactOs::open(
                        &config.workspace_root,
                        Path::new(r"D:\OmniaData\memory\omnia_artifact_os.db"),
                        None,
                    )
                } else {
                    let ao_path = db_path.with_file_name("omnia_artifact_os.db");
                    let mem_dir = db_path.with_file_name("memory");
                    ArtifactOs::open(&config.workspace_root, &ao_path, Some(&mem_dir))
                }
                .map_err(|e| format!("Failed opening ArtifactOs: {e}"))?
            }
            None => ArtifactOs::open_in_memory(&config.workspace_root)
                .map_err(|e| format!("Failed opening in-memory ArtifactOs: {e}"))?,
        });

        let router = match config.db_path.as_ref() {
            Some(db_path) => DynamicProviderRouter::open_sqlite(
                db_path.with_file_name("studio_router.db"),
                now,
            )
            .unwrap_or_else(|_| {
                DynamicProviderRouter::open_in_memory_sqlite(now)
                    .unwrap_or_else(|_| DynamicProviderRouter::new())
            }),
            None => DynamicProviderRouter::open_in_memory_sqlite(now)
                .unwrap_or_else(|_| DynamicProviderRouter::new()),
        };
        register_configured_router_candidates(&router);

        let peer_mesh = PeerMeshGraph::new(4);

        let graphify = GraphifyIndex::new();
        let _ = graphify.index_workspace(&config.workspace_root);

        let memory = MemoryGraph::new();
        let _ = artifact_os.hydrate_memory_graph_from_db(&memory);

        let rag = ProactiveRag::from_workspace(&config.workspace_root);
        rag.index_memory_graph(&memory);
        let skills = load_flagship_skills(&config);

        let steer = SteerQueue::new();
        if let Ok(saved_steer) = ops.list_persisted_steer_items() {
            for (_id, text, mode_raw, status_raw, created_ms) in saved_steer {
                let mode = match mode_raw.to_ascii_uppercase().as_str() {
                    "BOUNDARY_CORRECTION" => SteerMode::BoundaryCorrection,
                    "EXPLICIT_STOP_OR_REPLACE" => SteerMode::ExplicitStopOrReplace,
                    _ => SteerMode::AdditiveIntake,
                };
                let item = steer.enqueue(&text, mode, Some(created_ms));
                let target_status = match status_raw.to_ascii_lowercase().as_str() {
                    "in_progress" => Some(omnia_harness::steer_queue::SteerStatus::InProgress),
                    "completed" => Some(omnia_harness::steer_queue::SteerStatus::Completed),
                    "cancelled" => Some(omnia_harness::steer_queue::SteerStatus::Cancelled),
                    "superseded" => Some(omnia_harness::steer_queue::SteerStatus::Superseded),
                    _ => None,
                };
                if let Some(st) = target_status {
                    let _ = steer.mark_status(&item.id, st);
                }
            }
        }

        let event_feed = Arc::new(EventFeed::new());
        let ops = Arc::new(ops);
        let terminals = Arc::new(TerminalHub::new(&config.workspace_root));
        let harness = Arc::new(SuperHarnessManager::new(agent_store));
        let memory_engine = Arc::new(memory_engine);
        let browser = Arc::new(tokio::sync::Mutex::new(BrowserCdpState::default()));
        let mcp = Arc::new(McpManager::new(&config.workspace_root));
        let hooks = Arc::new(
            HookRegistry::load_from_workspace(&config.workspace_root)
                .unwrap_or_else(|_| HookRegistry::new(&config.workspace_root)),
        );
        let cordis_plugins = CordisPluginManager::new(&config.workspace_root);
        let _ = cordis_plugins.discover(Some(&hooks));
        let cordis_plugins = Arc::new(cordis_plugins);
        let dap = Arc::new(DapManager::new(&config.workspace_root));
        let observatory = Arc::new(ObservatoryState::new());

        let composer = Mutex::new(RichComposer::new());
        let connectors = Mutex::new(crate::routes_capabilities::default_connector_configs());
        let remote = Mutex::new(RemoteControlState::default());

        let downloads_db_path = validate_safe_local_path(
            &config.downloads_db_path(),
            Some(&config.workspace_root),
        )
        .map_err(|err| format!("Invalid downloader DB path (must be outside workspace): {err}"))?;
        if let Some(parent) = downloads_db_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|err| {
                    format!(
                        "Failed creating downloader DB directory '{}': {err}",
                        parent.display()
                    )
                })?;
            }
        }
        let downloads_staging_dir = validate_safe_local_path(
            &config.downloads_staging_dir(),
            Some(&config.workspace_root),
        )
        .map_err(|err| {
            format!("Invalid external downloads staging directory (must be outside workspace): {err}")
        })?;
        fs::create_dir_all(&downloads_staging_dir).map_err(|err| {
            format!(
                "Failed creating external downloads staging directory '{}': {err}",
                downloads_staging_dir.display()
            )
        })?;
        let downloads = Arc::new(
            DownloadManager::open(
                &downloads_db_path,
                Some(&config.workspace_root),
                DownloadConfig::default(),
            )
            .map_err(|err| format!("Failed opening DownloadManager WAL store: {err}"))?,
        );

        let notebooks_db_path = validate_safe_local_path(
            &config.notebooks_db_path(),
            Some(&config.workspace_root),
        )
        .map_err(|err| format!("Invalid notebook DB path (must be outside workspace): {err}"))?;
        if let Some(parent) = notebooks_db_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|err| {
                    format!(
                        "Failed creating notebook DB directory '{}': {err}",
                        parent.display()
                    )
                })?;
            }
        }
        let notebooks = Arc::new(
            NotebookEngine::open(&notebooks_db_path)
                .map_err(|err| format!("Failed opening NotebookEngine WAL store: {err}"))?,
        );

        let rust_files = count_rust_files(&config.workspace_root);
        let crate_count = discover_crate_count(&config.workspace_root);
        let binary_bytes = query_current_binary_bytes();

        Ok(Self {
            config,
            runtime_proxy,
            sessions,
            router,
            peer_mesh,
            graphify,
            memory,
            rag,
            skills,
            steer,
            composer,
            connectors,
            remote,
            downloads,
            downloads_staging_dir,
            download_scheduler_config: Mutex::new(SchedulerConfig::default()),
            download_site_policies: Mutex::new(SitePolicyRegistry::new()),
            captured_bundles: Mutex::new(Vec::new()),
            notebooks,
            research_vault,
            deep_think,
            artifact_os,
            event_feed,
            ops,
            terminals,
            harness,
            memory_engine,
            browser,
            mcp,
            hooks,
            cordis_plugins,
            dap,
            observatory,
            lease_owner_id,
            lease_epoch: AtomicI64::new(lease_epoch),
            rust_files,
            crate_count,
            binary_bytes,
            pid,
        })
    }
}

fn provider_key_configured(key_spec: &str) -> bool {
    let trimmed = key_spec.trim();
    !trimmed.is_empty()
        && (std::env::var(trimmed).ok().is_some_and(|v| !v.trim().is_empty())
            || !trimmed
                .chars()
                .all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit()))
}

fn register_configured_router_candidates(router: &DynamicProviderRouter) {
    let providers = read_models_config(None)
        .ok()
        .map(|cfg| cfg.providers)
        .unwrap_or_default();
    for (priority, prov) in providers.iter().enumerate() {
        let provider_id = &prov.id;
        let cred_present = omnia_core::credentials::CredentialStore::resolve_secret(&format!(
            "omnia:provider:{provider_id}"
        ))
        .ok()
        .flatten()
        .is_some();
        let has_cred = cred_present || provider_key_configured(&prov.api_key);

        for (m_idx, model) in prov.models.iter().enumerate() {
            let mut caps = ModelCapabilities::standard_candidate();
            caps.supports_reasoning = model.thinking.is_some();
            let cand = RouteCandidate {
                candidate_id: format!("{provider_id}:{}", model.id),
                provider_id: provider_id.clone(),
                model_id: model.id.clone(),
                auth_boundary: "default".to_string(),
                region: "configured".to_string(),
                privacy_tier: PrivacyTier::Public,
                capabilities: caps,
                context_limit_tokens: model.context_window,
                max_output_tokens: model.max_tokens,
                quality_tier: 3,
                pricing_version: "models.yml".to_string(),
                input_cost_per_million_microunits: None,
                output_cost_per_million_microunits: None,
                credential_present: has_cred,
                enabled: true,
                route_priority: ((priority * 20) + m_idx + 10) as i32,
                supported_roles: Vec::new(),
            };
            let state = CandidateResourceState {
                quota: QuotaState::default(),
                circuit: CircuitState::Closed,
                ..CandidateResourceState::default()
            };
            let _ = router.upsert_candidate(cand, state);
        }
    }
}

/// Top-level HTTP route dispatcher for Flagship Studio static UI and `/api/*`.
pub async fn dispatch_request(state: Arc<StudioState>, req: HttpRequest) -> HttpResponse {
    if let Some(v5_resp) = crate::routes_studio_v5::dispatch_v5_route(&state, &req).await {
        return v5_resp;
    }
    if let Some(rl_resp) = routes_research_lifecycle_v5::dispatch(&state, &req).await {
        return rl_resp;
    }
    if let Some(dl_resp) = dispatch_download_route(&state, &req).await {
        return dl_resp;
    }
    if let Some(nb_resp) = dispatch_notebook_route(&state, &req).await {
        return nb_resp;
    }
    if let Some(cap_resp) = dispatch_capability_route(&state, &req).await {
        return cap_resp;
    }

    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/health") => handle_health(&state).await,
        ("GET", "/api/capabilities") => handle_capabilities(&state),
        ("GET", "/api/overview") => handle_overview(&state).await,

        ("GET", "/api/runtime/status") => {
            state
                .runtime_proxy
                .handle_runtime_status(state.config.runtime_url.as_deref())
                .await
        }
        ("GET", "/api/providers") => {
            state
                .runtime_proxy
                .handle_providers(state.config.runtime_url.as_deref())
                .await
        }
        ("GET", "/api/models") => {
            state
                .runtime_proxy
                .handle_models(state.config.runtime_url.as_deref())
                .await
        }
        ("POST", "/api/chat") | ("POST", "/api/chat/completions") => {
            state
                .runtime_proxy
                .handle_chat(state.config.runtime_url.as_deref(), &req)
                .await
        }
        ("GET", "/api/hardware/nvidia") => {
            state
                .runtime_proxy
                .handle_nvidia_hardware(state.config.runtime_url.as_deref(), &req)
                .await
        }

        ("GET", "/api/graph") => handle_graph(&state),
        ("GET", "/api/graph/peers") => handle_graph_peers(&state),
        ("POST", "/api/graph/send") => handle_graph_send(&state, &req),
        ("GET", "/api/graph/traverse") => handle_graph_traverse(&state, &req),
        ("GET", "/api/graph/code") => handle_graph_code(&state, &req),

        ("GET", "/api/router/state") => handle_router_state(&state),
        ("POST", "/api/router/decide") | ("POST", "/api/route") => {
            handle_router_decide(&state, &req)
        }

        ("GET", "/api/memory") => handle_memory_list(&state),
        ("POST", "/api/memory/upsert") => handle_memory_upsert(&state, &req),
        ("POST", "/api/memory/erase") => handle_memory_erase(&state, &req),

        ("POST", "/api/rag/plan") | ("POST", "/api/rag/query") => handle_rag(&state, &req),

        ("GET", "/api/skills") => handle_skills_search(&state, &req),
        ("GET", "/api/skills/content") => handle_skill_content(&state, &req),

        ("GET", "/api/composer/templates") => handle_composer_templates(&state),
        ("POST", "/api/composer/preview") => handle_composer_preview(&state, &req),

        ("GET", "/api/steer") => handle_steer_list(&state),
        ("POST", "/api/steer/enqueue") => handle_steer_enqueue(&state, &req),

        ("GET", "/api/sessions") => handle_sessions_list(&state, &req),
        ("POST", "/api/sessions/create") => handle_sessions_create(&state, &req),
        ("GET", "/api/sessions/messages") => handle_sessions_messages_get(&state, &req),
        ("POST", "/api/sessions/messages") => handle_sessions_messages_post(&state, &req),
        ("GET", path)
            if path.starts_with("/api/sessions/")
                && !matches!(
                    path,
                    "/api/sessions/create" | "/api/sessions/messages"
                ) =>
        {
            handle_session_detail(&state, path)
        }

        ("GET", "/api/history") => handle_history(&state.config, &req),
        ("GET", "/api/history/messages") => handle_history_messages(&state.config, &req),

        ("GET", "/ws") => prepare_websocket_upgrade(Arc::clone(&state), req),
        ("GET", path) if !path.starts_with("/api/") => {
            let using_default_ui_root = state.config.ui_root == state.config.workspace_root.join("ui");
            if using_default_ui_root {
                if let Some((bytes, mime)) = load_v5_ui_asset(&state.config.workspace_root, path) {
                    return HttpResponse::bytes(200, mime, bytes);
                }
            }
            serve_static_asset(&state.config.ui_root, path)
        }
        (_, path) if path.starts_with("/api/") => {
            if crate::routes_studio_v5::is_known_v5_route(path)
                || crate::routes_observatory_v5::is_known_route(path)
                || crate::routes_atelier_drive_v5::is_known_route(path)
                || routes_research_lifecycle_v5::is_known_route(path)
                || is_known_download_route(path)
                || matches!(
                path,
                "/api/health"
                    | "/api/capabilities"
                    | "/api/overview"
                    | "/api/runtime/status"
                    | "/api/providers"
                    | "/api/models"
                    | "/api/chat"
                    | "/api/hardware/nvidia"
                    | "/api/graph"
                    | "/api/graph/peers"
                    | "/api/graph/send"
                    | "/api/graph/traverse"
                    | "/api/graph/code"
                    | "/api/router/state"
                    | "/api/router/decide"
                    | "/api/route"
                    | "/api/memory"
                    | "/api/memory/upsert"
                    | "/api/memory/erase"
                    | "/api/rag/plan"
                    | "/api/rag/query"
                    | "/api/skills"
                    | "/api/skills/content"
                    | "/api/composer/templates"
                    | "/api/composer/preview"
                    | "/api/steer"
                    | "/api/steer/enqueue"
                    | "/api/sessions"
                    | "/api/sessions/create"
                    | "/api/sessions/messages"
                    | "/api/history"
                    | "/api/history/messages"
            ) {
                HttpResponse::error(
                    405,
                    "method_not_allowed",
                    "HTTP method not allowed for route.",
                )
            } else {
                HttpResponse::error(404, "not_found", "API route not found.")
            }
        }
        _ => HttpResponse::error(405, "method_not_allowed", "HTTP method not allowed."),
    }
}

async fn handle_health(state: &StudioState) -> HttpResponse {
    let working_set_bytes = query_working_set_bytes();
    let skill_count = state.skills.list_skills().map(|v| v.len()).unwrap_or(0);
    let peer_count = state.peer_mesh.agents().map(|v| v.len()).unwrap_or(0);
    let rust_runtime = if state.config.runtime_url.is_some() {
        "configured"
    } else {
        "standalone"
    };

    let workspace_root =
        omnia_agent::path_guard::strip_verbatim_prefix(&state.config.workspace_root)
            .to_string_lossy()
            .into_owned();

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "demoMode": false,
        "workspaceRoot": workspace_root,
        "engine": "Omnia Full Native Rust",
        "compiler": detect_rustc_version(),
        "crateCount": state.crate_count,
        "rustFiles": state.rust_files,
        "httpStack": "tokio+rust-http",
        "sqliteBackend": "winsqlite3.dll",
        "rustRuntime": rust_runtime,
        "pid": state.pid,
        "workingSetBytes": working_set_bytes,
        "binaryBytes": state.binary_bytes,
        "skillCount": skill_count,
        "peerCount": peer_count,
        "tokenBudget": Value::Null,
    }))
}

fn handle_capabilities(state: &StudioState) -> HttpResponse {
    let listener = format!("http://{}", state.config.bind_addr());
    let capabilities = json!([
        { "id": "health", "enabled": true, "endpoint": "/api/health" },
        { "id": "overview", "enabled": true, "endpoint": "/api/overview" },
        { "id": "sessions", "enabled": true, "endpoint": "/api/sessions", "backend": "winsqlite3" },
        { "id": "history", "enabled": true, "endpoint": "/api/history", "schema": "omnia.history-manifest.v2" },
        { "id": "graph", "enabled": true, "endpoint": "/api/graph", "mode": "all_to_all_duplex" },
        { "id": "graphify", "enabled": true, "endpoint": "/api/graph/code", "directions": ["forward", "reverse", "both"] },
        { "id": "routing", "enabled": true, "endpoint": "/api/router/decide", "tokenBudget": Value::Null },
        { "id": "memory", "enabled": true, "endpoint": "/api/memory", "erasureReceipts": true },
        { "id": "rag", "enabled": true, "endpoint": "/api/rag/query" },
        { "id": "skills", "enabled": true, "endpoint": "/api/skills" },
        { "id": "composer", "enabled": true, "endpoint": "/api/composer/templates" },
        { "id": "steer", "enabled": true, "endpoint": "/api/steer", "invariant": "ADDITIVE_INTAKE_NO_CAP" },
        { "id": "runtime_proxy", "enabled": state.config.runtime_url.is_some(), "timeoutMs": state.config.runtime_timeout.as_millis() as u64 },
        { "id": "workspace_ops", "enabled": true, "endpoint": "/api/workspace/tree" },
        { "id": "connector_gateway", "enabled": true, "endpoint": "/api/connectors/status" },
        { "id": "media_capture", "enabled": true, "endpoint": "/api/media/capabilities" },
        { "id": "remote_control", "enabled": true, "endpoint": "/api/remote/status" },
        { "id": "observatory_v5", "enabled": true, "endpoint": "/api/v5/network/overview" },
    ]);

    HttpResponse::ok(json!({
        "ok": true,
        "schema": "omnia.capabilities.v1",
        "listener": listener,
        "capabilities": capabilities,
    }))
}

async fn handle_overview(state: &StudioState) -> HttpResponse {
    let runtime = state
        .runtime_proxy
        .probe_overview_runtime(state.config.runtime_url.as_deref())
        .await;
    let session_count = state
        .sessions
        .list_sessions_page(250, None)
        .map(|p| p.items.len())
        .unwrap_or(0);
    let peer_count = state.peer_mesh.agents().map(|v| v.len()).unwrap_or(0);
    let skill_count = state.skills.list_skills().map(|v| v.len()).unwrap_or(0);
    let steer_count = state.steer.active_backlog_count();
    let candidate_count = state
        .router
        .snapshots(now_epoch_ms())
        .map(|v| v.len())
        .unwrap_or(0);
    let overall_state = if runtime.get("ok").and_then(Value::as_bool) == Some(true) {
        "online"
    } else {
        "degraded"
    };

    HttpResponse::ok(json!({
        "ok": true,
        "state": overall_state,
        "engine": "Omnia Full Native Rust",
        "tokenBudget": Value::Null,
        "studio": {
            "sessions": session_count,
            "peers": peer_count,
            "skills": skill_count,
            "activeSteerItems": steer_count,
            "routerCandidates": candidate_count,
            "crateCount": state.crate_count,
            "rustFiles": state.rust_files,
        },
        "runtime": runtime,
    }))
}

fn handle_graph(state: &StudioState) -> HttpResponse {
    let now = now_epoch_ms();
    let agents = state.peer_mesh.agents().unwrap_or_default();
    let edges = state.peer_mesh.all_edges().unwrap_or_default();
    let messages = state.peer_mesh.all_messages().unwrap_or_default();
    let convergence = state.peer_mesh.convergence_status(now, 300_000).ok();

    let graphify_nodes: Vec<Value> = state
        .graphify
        .entities()
        .unwrap_or_default()
        .into_iter()
        .take(120)
        .map(|e| {
            json!({
                "id": e.id,
                "kind": e.kind.as_str(),
                "label": e.label,
                "source_path": e.source_path,
                "sourcePath": e.source_path,
                "symbol_span": e.symbol_span,
                "symbolSpan": e.symbol_span,
            })
        })
        .collect();
    let graphify_edges: Vec<Value> = state
        .graphify
        .edges()
        .unwrap_or_default()
        .into_iter()
        .take(240)
        .map(|edge| serialize_graphify_edge(&edge))
        .collect();

    let links: Vec<Value> = edges
        .iter()
        .map(|edge| {
            let bidirectional = edges
                .iter()
                .any(|rev| rev.from_id == edge.to_id && rev.to_id == edge.from_id);
            json!({
                "from": edge.from_id,
                "to": edge.to_id,
                "from_id": edge.from_id,
                "to_id": edge.to_id,
                "duplex": bidirectional,
                "bidirectional": bidirectional,
                "channel": edge.channel_label,
            })
        })
        .collect();

    let serialized_messages: Vec<Value> = messages.into_iter().map(|m| m.to_json()).collect();

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "nodes": agents.into_iter().map(|a| a.to_json()).collect::<Vec<_>>(),
        "links": links,
        "messages": serialized_messages,
        "graphifyNodes": graphify_nodes,
        "graphifyEdges": graphify_edges,
        "convergence": convergence.map(|c| c.to_json()),
    }))
}

fn handle_graph_peers(state: &StudioState) -> HttpResponse {
    let now = now_epoch_ms();
    let nodes = state.peer_mesh.agents().unwrap_or_default();
    let links = state.peer_mesh.all_edges().unwrap_or_default();
    let messages = state.peer_mesh.all_messages().unwrap_or_default();
    let convergence = state.peer_mesh.convergence_status(now, 300_000).ok();

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "peerCount": nodes.len(),
        "edgeCount": links.len(),
        "messageCount": messages.len(),
        "nodes": nodes.into_iter().map(|a| a.to_json()).collect::<Vec<_>>(),
        "links": links.iter().map(|e| {
            let bidirectional = links
                .iter()
                .any(|rev| rev.from_id == e.to_id && rev.to_id == e.from_id);
            json!({
                "from": e.from_id,
                "to": e.to_id,
                "bidirectional": bidirectional,
                "channel": e.channel_label,
            })
        }).collect::<Vec<_>>(),
        "messages": messages.into_iter().map(|m| m.to_json()).collect::<Vec<_>>(),
        "convergence": convergence.map(|c| c.to_json()),
    }))
}

fn handle_graph_send(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let body = match req.json_object() {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    let from = body
        .get("from")
        .or_else(|| body.get("fromId"))
        .or_else(|| body.get("from_id"))
        .and_then(Value::as_str)
        .unwrap_or("coordinator")
        .trim();
    let to = body
        .get("to")
        .or_else(|| body.get("toId"))
        .or_else(|| body.get("to_id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let topic = body
        .get("topic")
        .and_then(Value::as_str)
        .unwrap_or("peer-message")
        .trim();
    let payload_text = body
        .get("payload")
        .or_else(|| body.get("text"))
        .or_else(|| body.get("message"))
        .or_else(|| body.get("body"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let is_broadcast = body
        .get("broadcast")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || to == "@all";
    let max_hops = body
        .get("maxHops")
        .or_else(|| body.get("max_hops"))
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok());
    let epoch = body.get("epoch").and_then(Value::as_u64);
    let in_reply_to = body
        .get("inReplyToSeq")
        .or_else(|| body.get("in_reply_to_seq"))
        .and_then(Value::as_u64);

    if from.is_empty()
        || payload_text.is_empty()
        || (!is_broadcast && to.is_empty() && in_reply_to.is_none())
    {
        return HttpResponse::error(
            400,
            "invalid_peer_message",
            "Peer message requires non-empty 'from', 'payload', and either 'to' or 'broadcast: true'.",
        );
    }

    let now = now_epoch_ms();
    let result = if let Some(seq) = in_reply_to {
        state
            .peer_mesh
            .reply(from, seq, topic, payload_text, Some(now))
    } else if is_broadcast {
        state
            .peer_mesh
            .broadcast(from, topic, payload_text, max_hops, Some(now))
    } else {
        state
            .peer_mesh
            .send_peer(from, to, topic, payload_text, epoch, max_hops, Some(now))
    };

    match result {
        Ok(msg) => {
            let messages: Vec<Value> = state
                .peer_mesh
                .all_messages()
                .unwrap_or_default()
                .into_iter()
                .map(|m| m.to_json())
                .collect();
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "message": msg.to_json(),
                "deliveredRecipients": msg.recipients,
                "messages": messages,
            }))
        }
        Err(err) => agent_graph_error_response(err),
    }
}

fn handle_graph_traverse(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let raw_entity = req.query_param("entity").unwrap_or_default();
    let entity_trim = raw_entity.trim();
    if entity_trim.is_empty() {
        return HttpResponse::error(
            400,
            "entity_required",
            "Query parameter 'entity' is required for Graphify traversal.",
        );
    }

    let dir_str = req
        .query_param("direction")
        .unwrap_or_else(|| "both".to_string());
    let direction = match parse_traversal_direction(&dir_str) {
        Some(d) => d,
        None => {
            return HttpResponse::error(
                400,
                "invalid_direction",
                "direction must be forward, reverse, or both.",
            )
        }
    };
    let max_depth = req
        .query_param("maxDepth")
        .or_else(|| req.query_param("max_depth"))
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(3)
        .clamp(1, 8);
    let include_ambiguous = req
        .query_param("includeAmbiguous")
        .or_else(|| req.query_param("include_ambiguous"))
        .map(|s| matches!(s.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);

    let resolved_id = resolve_graphify_entity_id(&state.graphify, entity_trim);
    match state
        .graphify
        .traverse(&resolved_id, direction, max_depth, include_ambiguous)
    {
        Ok(res) => {
            let visited_ids: Vec<String> =
                res.visited_entities.iter().map(|e| e.id.clone()).collect();
            let visited_entities: Vec<Value> = res
                .visited_entities
                .iter()
                .map(GraphifyEntity::to_json)
                .collect();
            let edges: Vec<Value> = res
                .traversed_edges
                .iter()
                .map(serialize_graphify_edge)
                .collect();
            let quarantined: Vec<Value> = res
                .quarantined_ambiguous
                .iter()
                .map(serialize_graphify_edge)
                .collect();

            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "entity": res.start_id,
                "direction": dir_str.to_ascii_lowercase(),
                "maxDepth": res.max_depth,
                "visited": visited_ids,
                "visitedEntities": visited_entities,
                "edges": edges,
                "quarantinedAmbiguous": quarantined,
                "detectedCycles": res.detected_cycles,
            }))
        }
        Err(err) => agent_graph_error_response(err),
    }
}

fn handle_graph_code(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let query_entity = req
        .query_param("entity")
        .unwrap_or_default()
        .trim()
        .to_string();
    let dir_str = req
        .query_param("direction")
        .unwrap_or_else(|| "both".to_string());
    let direction = match parse_traversal_direction(&dir_str) {
        Some(d) => d,
        None => {
            return HttpResponse::error(
                400,
                "invalid_direction",
                "direction must be forward, reverse, or both.",
            )
        }
    };
    let dir_label = match direction {
        TraversalDirection::Forward => "forward",
        TraversalDirection::Reverse => "reverse",
        TraversalDirection::Both => "both",
    };
    let max_depth = req
        .query_param("max_depth")
        .or_else(|| req.query_param("maxDepth"))
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(3)
        .clamp(1, 6);

    let all_entities = state.graphify.entities().unwrap_or_default();
    let all_edges = state.graphify.edges().unwrap_or_default();

    let matches: Vec<Value> = if query_entity.is_empty() {
        all_entities
            .iter()
            .take(25)
            .map(GraphifyEntity::to_json)
            .collect()
    } else {
        let needle = query_entity.to_ascii_lowercase();
        all_entities
            .iter()
            .filter(|e| {
                e.id.to_ascii_lowercase().contains(&needle)
                    || e.label.to_ascii_lowercase().contains(&needle)
                    || e.source_path.to_ascii_lowercase().contains(&needle)
            })
            .take(50)
            .map(GraphifyEntity::to_json)
            .collect()
    };

    let target_id = if !query_entity.is_empty() {
        Some(resolve_graphify_entity_id(&state.graphify, &query_entity))
    } else {
        all_entities.first().map(|e| e.id.clone())
    };

    if let Some(start_id) = target_id {
        if let Ok(res) = state
            .graphify
            .traverse(&start_id, direction, max_depth, true)
        {
            return HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "entity": res.start_id,
                "direction": dir_label,
                "maxDepth": max_depth,
                "nodes": res.visited_entities.iter().map(GraphifyEntity::to_json).collect::<Vec<_>>(),
                "edges": res.traversed_edges.iter().map(serialize_graphify_edge).collect::<Vec<_>>(),
                "matches": matches,
                "summary": {
                    "totalEntities": all_entities.len(),
                    "totalEdges": all_edges.len(),
                    "visitedCount": res.visited_entities.len(),
                    "traversedEdges": res.traversed_edges.len(),
                },
            }));
        }
    }

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "entity": if query_entity.is_empty() { Value::Null } else { Value::String(query_entity) },
        "direction": dir_label,
        "maxDepth": max_depth,
        "nodes": all_entities.iter().take(60).map(GraphifyEntity::to_json).collect::<Vec<_>>(),
        "edges": all_edges.iter().take(120).map(serialize_graphify_edge).collect::<Vec<_>>(),
        "matches": matches,
        "summary": {
            "totalEntities": all_entities.len(),
            "totalEdges": all_edges.len(),
            "visitedCount": 0,
            "traversedEdges": 0,
        },
    }))
}

fn handle_router_state(state: &StudioState) -> HttpResponse {
    let now = now_epoch_ms();
    let snapshots = state.router.snapshots(now).unwrap_or_default();
    let receipts = state.router.decision_receipts().unwrap_or_default();
    let outcomes = state.router.outcome_receipts().unwrap_or_default();

    let candidates: Vec<Value> = snapshots
        .iter()
        .map(format_router_candidate_for_ui)
        .collect();
    let recent_receipts: Vec<Value> = receipts
        .iter()
        .rev()
        .take(25)
        .map(format_router_receipt_for_ui)
        .collect();
    let outcome_json: Vec<Value> = outcomes
        .iter()
        .rev()
        .take(25)
        .map(|o| o.to_json())
        .collect();

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "tokenBudget": Value::Null,
        "candidates": candidates,
        "recentReceipts": recent_receipts,
        "outcomeReceipts": outcome_json,
    }))
}

pub fn handle_router_decide_public(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    handle_router_decide(state, req)
}

fn handle_router_decide(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let body = if req.body.is_empty() {
        serde_json::Map::new()
    } else {
        match req.json_object() {
            Ok(b) => b,
            Err(resp) => return resp,
        }
    };

    let now = now_epoch_ms();

    // 1. Validate `simulate` BEFORE any circuit or router mutation (`AUD-09`).
    let simulate = match body.get("simulate") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => {
            return HttpResponse::error(
                400,
                "invalid_simulate",
                "Field 'simulate' must be a boolean.",
            );
        }
    };

    let trip_id = body
        .get("tripCandidate")
        .or_else(|| body.get("trip_candidate"))
        .or_else(|| body.get("trip_provider"))
        .or_else(|| body.get("tripProvider"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let reset_id = body
        .get("resetCandidate")
        .or_else(|| body.get("reset_candidate"))
        .or_else(|| body.get("reset_provider"))
        .or_else(|| body.get("resetProvider"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if simulate && (trip_id.is_some() || reset_id.is_some()) {
        return HttpResponse::error(
            400,
            "simulation_cannot_change_circuit",
            "Side-effect-free simulation cannot trip or reset provider circuits.",
        );
    }

    // 2. Validate `estimatedTokens` (`64..=1_000_000` integer) BEFORE any circuit mutation.
    let raw_est_val = body
        .get("estimatedTokens")
        .or_else(|| body.get("estimatedInputTokens"))
        .or_else(|| body.get("token_estimate"))
        .or_else(|| body.get("tokenEstimate"));
    let validated_estimated_tokens = if let Some(val) = raw_est_val {
        match val.as_i64() {
            Some(n) if (64..=1_000_000).contains(&n) => Some(n as u64),
            _ => {
                return HttpResponse::json(
                    400,
                    json!({
                        "ok": false,
                        "state": "error",
                        "code": "invalid_estimated_tokens",
                        "error": "invalid_estimated_tokens",
                        "field": "estimatedTokens",
                        "detail": "Field 'estimatedTokens' must be an integer between 64 and 1000000.",
                        "message": "Field 'estimatedTokens' must be an integer between 64 and 1000000.",
                    }),
                );
            }
        }
    } else {
        None
    };

    // 3. Apply explicit circuit mutations only after input validation passes and `!simulate`.
    if let Some(trip_id) = trip_id {
        if let Err(err) = state.router.trip_circuit(trip_id, now, Some(60_000)) {
            return HttpResponse::error(404, "unknown_candidate", &err.to_string());
        }
        let prov = trip_id.split(':').next().unwrap_or(trip_id);
        let _ = state.ops.record_router_event(
            trip_id,
            prov,
            "trip",
            "router_decide_manual_trip",
            "Open",
        );
        state.event_feed.publish(
            "router",
            "circuit_tripped",
            None,
            json!({ "candidateId": trip_id, "circuit": "Open" }),
        );
    }

    if let Some(reset_id) = reset_id {
        if let Err(err) = state.router.reset_circuit(reset_id) {
            return HttpResponse::error(404, "unknown_candidate", &err.to_string());
        }
        let prov = reset_id.split(':').next().unwrap_or(reset_id);
        let _ = state.ops.record_router_event(
            reset_id,
            prov,
            "reset",
            "router_decide_manual_reset",
            "Closed",
        );
        state.event_feed.publish(
            "router",
            "circuit_reset",
            None,
            json!({ "candidateId": reset_id, "circuit": "Closed" }),
        );
    }

    let mut policy = RouteRequestPolicy {
        token_budget: None,
        now_epoch_ms: Some(now),
        ..RouteRequestPolicy::default()
    };
    if let Some(req_id) = body
        .get("requestId")
        .or_else(|| body.get("request_id"))
        .and_then(Value::as_str)
    {
        if !req_id.trim().is_empty() {
            policy.request_id = req_id.trim().to_string();
        }
    }
    if let Some(idem) = body
        .get("idempotencyKey")
        .or_else(|| body.get("idempotency_key"))
        .and_then(Value::as_str)
    {
        if !idem.trim().is_empty() {
            policy.idempotency_key = idem.trim().to_string();
        }
    }
    if let Some(tier_raw) = body
        .get("privacyTier")
        .or_else(|| body.get("minimumPrivacyTier"))
        .or_else(|| body.get("privacy_boundary"))
        .or_else(|| body.get("privacyBoundary"))
        .and_then(Value::as_str)
    {
        policy.minimum_privacy_tier = parse_privacy_tier(tier_raw);
    }
    if let Some(risk_raw) = body
        .get("taskRisk")
        .or_else(|| body.get("task_risk"))
        .or_else(|| body.get("task_class"))
        .or_else(|| body.get("taskClass"))
        .and_then(Value::as_str)
    {
        policy.task_risk = parse_task_risk(risk_raw);
    }
    if let Some(est_tok) = validated_estimated_tokens {
        policy.estimated_input_tokens = est_tok;
        policy.estimated_output_tokens = body
            .get("estimatedOutputTokens")
            .or_else(|| body.get("estimated_output_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
    }
    if body
        .get("requireStreaming")
        .or_else(|| body.get("streaming"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        policy.required_capabilities.supports_streaming = true;
    }
    if body
        .get("requireVision")
        .or_else(|| body.get("vision"))
        .and_then(Value::as_bool)
        == Some(true)
        || body.get("task_class").and_then(Value::as_str) == Some("vision")
        || body.get("taskClass").and_then(Value::as_str) == Some("vision")
    {
        policy.required_capabilities.supports_vision = true;
    }
    if let Some(excl) = body.get("excludedCandidates").and_then(Value::as_array) {
        policy.excluded_candidate_ids = excl
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
    }

    if simulate {
        return match state.router.simulate_route(&policy) {
            Ok(decision) => {
                let candidates: Vec<Value> = state
                    .router
                    .snapshots(now)
                    .unwrap_or_default()
                    .iter()
                    .map(format_router_candidate_for_ui)
                    .collect();
                let mut ui_receipt = format_router_receipt_for_ui(&decision.receipt);
                if let Value::Object(ref mut map) = ui_receipt {
                    map.insert("simulated".to_string(), json!(true));
                    map.insert("sequenceId".to_string(), json!(0));
                    map.insert("reservationId".to_string(), Value::Null);
                    map.insert("reservedTokens".to_string(), json!(0));
                }
                let decision_status = if decision.allowed {
                    "SIMULATED_DETERMINISTIC"
                } else {
                    "FENCED_NO_ELIGIBLE_ROUTE"
                };

                HttpResponse::ok(json!({
                    "ok": true,
                    "state": "online",
                    "mode": "SIMULATED_DETERMINISTIC",
                    "simulated": true,
                    "allowed": decision.allowed,
                    "status": "SIMULATED_DETERMINISTIC",
                    "decisionStatus": decision_status,
                    "tokenBudget": Value::Null,
                    "selectedCandidateId": decision.receipt.selected_candidate_id,
                    "reservation": Value::Null,
                    "receipt": ui_receipt,
                    "rawDecision": decision.to_json(),
                    "candidates": candidates,
                }))
            }
            Err(err) => HttpResponse::error(400, "router_simulation_failed", &err.to_string()),
        };
    }

    match state.router.decide_and_reserve(&policy) {
        Ok(decision) => {
            let candidates: Vec<Value> = state
                .router
                .snapshots(now)
                .unwrap_or_default()
                .iter()
                .map(format_router_candidate_for_ui)
                .collect();
            let ui_receipt = format_router_receipt_for_ui(&decision.receipt);
            let status_label = if decision.allowed { "ROUTED" } else { "FENCED" };

            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "simulated": false,
                "allowed": decision.allowed,
                "status": status_label,
                "tokenBudget": Value::Null,
                "selectedCandidateId": decision.receipt.selected_candidate_id,
                "reservation": decision.reservation.as_ref().map(|r| r.to_json()),
                "receipt": ui_receipt,
                "rawDecision": decision.to_json(),
                "candidates": candidates,
            }))
        }
        Err(err) => HttpResponse::error(400, "router_decision_failed", &err.to_string()),
    }
}

fn handle_memory_list(state: &StudioState) -> HttpResponse {
    let entries: Vec<Value> = state
        .memory
        .list_entries()
        .unwrap_or_default()
        .iter()
        .map(format_memory_entry_for_ui)
        .collect();
    let erasures: Vec<Value> = state
        .memory
        .erasure_receipts()
        .unwrap_or_default()
        .iter()
        .map(format_erasure_receipt_for_ui)
        .collect();

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "entries": entries,
        "erasures": erasures,
    }))
}

fn handle_memory_upsert(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let body = match req.json_object() {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let ns = body
        .get("namespace")
        .or_else(|| body.get("namespace_path"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let key = body.get("key").and_then(Value::as_str).unwrap_or("").trim();
    let content = body
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let tier = match body
        .get("tier")
        .and_then(Value::as_str)
        .unwrap_or("Durable")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "working" => MemoryTier::Working,
        _ => MemoryTier::Durable,
    };
    let links: Vec<String> = body
        .get("links")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    if content.is_empty() {
        return HttpResponse::error(
            400,
            "memory_empty_content",
            "Memory content cannot be empty.",
        );
    }

    match state
        .memory
        .upsert(ns, key, tier, content, &links, Some(now_epoch_ms()))
    {
        Ok(entry) => {
            state.rag.index_memory_graph(&state.memory);
            let _ = state.artifact_os.sync_memory_graph_to_db(&state.memory);
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "entry": format_memory_entry_for_ui(&entry),
            }))
        }
        Err(err) => memory_error_response(err),
    }
}

fn handle_memory_erase(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let body = match req.json_object() {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    let (ns, key) = if let Some(id) = body.get("id").and_then(Value::as_str).map(str::trim) {
        if let Some((split_ns, split_key)) = id.rsplit_once('/') {
            (split_ns.to_string(), split_key.to_string())
        } else {
            let fallback_ns = body
                .get("namespace")
                .or_else(|| body.get("namespace_path"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            (fallback_ns, id.to_string())
        }
    } else {
        let raw_ns = body
            .get("namespace")
            .or_else(|| body.get("namespace_path"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let raw_key = body
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        (raw_ns, raw_key)
    };

    if ns.is_empty() || key.is_empty() {
        return HttpResponse::error(
            400,
            "memory_target_required",
            "Specify 'id' (namespace/key) or both 'namespace' and 'key' to erase.",
        );
    }

    match state.memory.erase(&ns, &key, Some(now_epoch_ms())) {
        Ok(receipt) => {
            state.rag.index_memory_graph(&state.memory);
            let _ = state.artifact_os.sync_memory_graph_to_db(&state.memory);
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "erased": true,
                "receipt": format_erasure_receipt_for_ui(&receipt),
            }))
        }
        Err(err) => memory_error_response(err),
    }
}

fn handle_rag(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let body = match req.json_object() {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let query = body
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if query.is_empty() {
        return HttpResponse::error(
            400,
            "rag_query_required",
            "RAG query string cannot be empty.",
        );
    }
    let max_citations = body
        .get("maxCitations")
        .or_else(|| body.get("max_citations"))
        .and_then(Value::as_u64)
        .map(|v| (v as usize).clamp(1, 20))
        .unwrap_or(5);

    let result = state.rag.plan_and_retrieve(query, max_citations);
    let uncertainty = f64::from(result.uncertainty_score_bps) / 10_000.0;
    let sub_queries: Vec<Value> = result.sub_queries.iter().map(|s| s.to_json()).collect();
    let cited_sources: Vec<Value> = result.cited_sources.iter().map(|c| c.to_json()).collect();
    let unused_sources: Vec<Value> = result.unused_sources.iter().map(|u| u.to_json()).collect();
    let triggers: Vec<String> = result
        .sub_queries
        .iter()
        .map(|s| s.intent.clone())
        .collect();

    HttpResponse::ok(SecretRedactor::redact_json(&json!({
        "ok": true,
        "state": "online",
        "query": result.query,
        "language": result.language,
        "uncertainty": uncertainty,
        "uncertaintyScore": uncertainty,
        "uncertaintyScoreBps": result.uncertainty_score_bps,
        "shouldRetrieve": result.should_retrieve,
        "triggers": triggers,
        "subQueries": sub_queries,
        "citedSources": cited_sources,
        "unusedSources": unused_sources,
        "hits": cited_sources,
        "answer": result.synthesis,
    })))
}

fn handle_skills_search(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let query = req.query_param("q").unwrap_or_default();
    let trimmed = query.trim();

    if trimmed.is_empty() {
        let skills = state.skills.list_skills().unwrap_or_default();
        let items: Vec<Value> = skills
            .iter()
            .map(|meta| {
                let is_proj = meta.name.starts_with(SKILL_PROJECTION_PREFIX);
                json!({
                    "name": meta.name,
                    "description": meta.description,
                    "path": meta.path,
                    "openai_interface": meta.openai_interface.as_ref().map(|o| o.to_json()),
                    "category": if is_proj { "K-Dense Research Projection" } else { "Omnia Curated Skill" },
                    "admitted": !is_proj,
                    "score": Value::Null,
                })
            })
            .collect();
        return HttpResponse::ok(json!({
            "ok": true,
            "state": "online",
            "query": "",
            "total": items.len(),
            "skills": items,
        }));
    }

    let matches = state.skills.search(trimmed, 50).unwrap_or_default();
    let items: Vec<Value> = matches
        .iter()
        .map(|m| {
            let is_proj = m.skill.name.starts_with(SKILL_PROJECTION_PREFIX);
            json!({
                "name": m.skill.name,
                "description": m.skill.description,
                "path": m.skill.path,
                "openai_interface": m.skill.openai_interface.as_ref().map(|o| o.to_json()),
                "category": if is_proj { "K-Dense Research Projection" } else { "Omnia Curated Skill" },
                "admitted": !is_proj,
                "score": (m.score * 100.0).round() / 100.0,
                "matchedTerms": m.matched_terms,
            })
        })
        .collect();

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "query": trimmed,
        "total": items.len(),
        "skills": items,
    }))
}

fn handle_skill_content(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let name = req.query_param("name").unwrap_or_default();
    let clean_name = name.trim();
    if clean_name.is_empty()
        || clean_name.contains("..")
        || clean_name.contains('/')
        || clean_name.contains('\\')
    {
        return HttpResponse::error(400, "invalid_skill_name", "Skill name is invalid.");
    }

    let Ok(skills) = state.skills.list_skills() else {
        return HttpResponse::error(500, "skill_registry_error", "Skill registry unavailable.");
    };
    let Some(meta) = skills.into_iter().find(|s| s.name == clean_name) else {
        return HttpResponse::error(404, "skill_not_found", "Requested skill was not found.");
    };

    let skill_dir = Path::new(&meta.path);
    let skill_md = skill_dir.join("SKILL.md");
    let Ok(md_meta) = fs::symlink_metadata(&skill_md) else {
        return HttpResponse::error(404, "skill_file_missing", "SKILL.md file not accessible.");
    };
    if is_reparse_or_symlink(&md_meta) || !md_meta.is_file() {
        return HttpResponse::error(403, "forbidden_path", "Symlink/reparse SKILL.md rejected.");
    }
    let Ok(raw) = fs::read_to_string(&skill_md) else {
        return HttpResponse::error(500, "skill_read_failed", "Failed reading SKILL.md.");
    };
    let bounded = omnia_core::truncate_utf8_codepoints(&raw, MAX_SKILL_CONTENT_CHARS);

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "name": meta.name,
        "description": meta.description,
        "path": meta.path,
        "maxChars": MAX_SKILL_CONTENT_CHARS,
        "truncated": raw.chars().count() > MAX_SKILL_CONTENT_CHARS,
        "content": SecretRedactor::redact(&bounded),
    }))
}

fn handle_composer_templates(state: &StudioState) -> HttpResponse {
    let templates: Vec<Value> = ComposerModel::templates()
        .iter()
        .map(omnia_harness::composer_model::SymbolTemplate::to_json)
        .collect();
    let palette: Vec<Value> = symbol_palette().iter().map(|s| s.to_json()).collect();
    let readiness = state
        .composer
        .lock()
        .map(|c| json!(c.evaluate_send_readiness().ready))
        .unwrap_or(json!(true));

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "templates": templates,
        "paletteCount": palette.len(),
        "ready": readiness,
    }))
}

fn handle_composer_preview(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let body = match req.json_object() {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let text = body
        .get("text")
        .or_else(|| body.get("draft"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let template_id = body
        .get("templateId")
        .or_else(|| body.get("insertTemplateId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut composer_model = ComposerModel::new();
    composer_model.set_draft(text, text.chars().count());
    let mut inserted_template = false;
    if let Some(tpl) = template_id {
        inserted_template = composer_model.insert_template_at_caret(tpl);
    }

    let mut rich = match state.composer.lock() {
        Ok(guard) => RichComposer::from_json_value_or_fresh(&guard),
        Err(_) => RichComposer::new(),
    };
    rich.set_plain_text(composer_model.draft_text());
    if let Some(tpl) = template_id {
        if !inserted_template {
            let _ = rich.insert_symbol_at_caret(tpl);
        }
    }
    if body.get("inlineMath").and_then(Value::as_bool) == Some(true) {
        rich.set_caret(DocumentAnchor {
            node_index: 0,
            codepoint_offset: composer_model.draft_text().chars().count(),
        });
        rich.insert_text("", TextStyle::default());
    }

    let preview = rich.render_live_preview();
    let readiness = rich.evaluate_send_readiness();

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "draftText": composer_model.draft_text(),
        "insertedTemplate": inserted_template,
        "markdownText": SecretRedactor::redact(&preview.markdown_text),
        "mathExpressions": preview.math_expressions,
        "attachmentBadges": preview.attachment_badges,
        "ready": readiness.ready,
        "blockingReasons": readiness.blocking_reasons,
    }))
}

fn handle_steer_list(state: &StudioState) -> HttpResponse {
    let items: Vec<Value> = state
        .steer
        .items()
        .iter()
        .map(omnia_harness::steer_queue::SteerItem::to_json)
        .collect();
    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "tokenBudget": state.steer.token_budget(),
        "invariant": "ADDITIVE_INTAKE_NO_CAP",
        "items": items,
    }))
}

fn handle_steer_enqueue(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let body = match req.json_object() {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let text = body
        .get("text")
        .or_else(|| body.get("prompt"))
        .or_else(|| body.get("message"))
        .or_else(|| body.get("body"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if text.is_empty() {
        return HttpResponse::error(
            400,
            "steer_text_required",
            "Steer item text cannot be empty.",
        );
    }
    let mode = match body
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("ADDITIVE_INTAKE")
        .trim()
        .to_ascii_uppercase()
        .as_str()
    {
        "BOUNDARY_CORRECTION" | "CORRECTION" => SteerMode::BoundaryCorrection,
        "EXPLICIT_STOP_OR_REPLACE" | "REPLACE" => SteerMode::ExplicitStopOrReplace,
        _ => SteerMode::AdditiveIntake,
    };

    let item = state.steer.enqueue(text, mode, Some(now_epoch_ms()));
    let _ = state.ops.upsert_steer_item(
        &item.id,
        &item.text,
        item.mode.as_str(),
        item.status.as_str(),
        item.created_at_ms,
    );
    let items: Vec<Value> = state
        .steer
        .items()
        .iter()
        .map(omnia_harness::steer_queue::SteerItem::to_json)
        .collect();

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "tokenBudget": state.steer.token_budget(),
        "invariant": "ADDITIVE_INTAKE_NO_CAP",
        "item": item.to_json(),
        "items": items,
    }))
}

fn percent_decode_segment(raw: &str) -> Result<String, &'static str> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("Truncated percent-encoding in session ID.");
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                .map_err(|_| "Invalid percent-encoding.")?;
            let val = u8::from_str_radix(hex, 16)
                .map_err(|_| "Invalid hex digits in percent-encoding.")?;
            out.push(val);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "Decoded session ID is not valid UTF-8.")
}

fn ensure_studio_lease_current(state: &StudioState, now: i64) -> Result<i64, HttpResponse> {
    let current_epoch = state.lease_epoch.load(Ordering::Acquire);
    if state.config.db_path.is_none() {
        return Ok(current_epoch.max(1));
    }
    let pid_i64 = i64::from(state.pid);
    if current_epoch > 0 {
        match state
            .sessions
            .heartbeat_fenced(&state.lease_owner_id, pid_i64, current_epoch, 60_000, now)
        {
            Ok(true) => return Ok(current_epoch),
            Ok(false) => {}
            Err(err) => {
                return Err(HttpResponse::error(
                    500,
                    "session_lease_error",
                    &err.to_string(),
                ));
            }
        }
    }
    match state
        .sessions
        .acquire_lease_record(&state.lease_owner_id, pid_i64, 60_000, now)
    {
        Ok(Some(rec)) => {
            state.lease_epoch.store(rec.lease_epoch, Ordering::Release);
            Ok(rec.lease_epoch)
        }
        Ok(None) => Err(HttpResponse::error(
            503,
            "studio_lease_lost",
            "Cooperative SQLite session lease is held by another active Studio owner.",
        )),
        Err(err) => Err(HttpResponse::error(
            500,
            "session_lease_error",
            &err.to_string(),
        )),
    }
}

fn handle_session_detail(state: &StudioState, path: &str) -> HttpResponse {
    let raw_seg = path.strip_prefix("/api/sessions/").unwrap_or("");
    if raw_seg.is_empty() || raw_seg.contains('/') {
        return HttpResponse::error(
            400,
            "invalid_session_id",
            "Session ID path segment is invalid.",
        );
    }
    let decoded = match percent_decode_segment(raw_seg) {
        Ok(s) => s,
        Err(msg) => return HttpResponse::error(400, "invalid_session_id", msg),
    };
    if !is_valid_studio_session_id(&decoded) {
        return HttpResponse::error(
            400,
            "invalid_session_id",
            "Session ID must be 1..=128 safe UTF-8 bytes without traversal or separator characters.",
        );
    }
    match state.sessions.get_session(&decoded) {
        Ok(Some(s)) => HttpResponse::ok(json!({
            "ok": true,
            "state": "online",
            "session": {
                "id": s.id,
                "title": s.title,
                "modelId": s.model_id,
                "model_id": s.model_id,
                "effort": s.effort,
                "revision": s.revision,
                "createdAtMs": s.created_at_ms,
                "updatedAtMs": s.updated_at_ms,
            },
        })),
        Ok(None) => HttpResponse::error(404, "session_not_found", "Session not found."),
        Err(err) => HttpResponse::error(500, "session_store_error", &err.to_string()),
    }
}

fn handle_sessions_list(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let limit = match req.query_param("limit") {
        None => 50usize,
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
                return HttpResponse::error(
                    400,
                    "invalid_session_limit",
                    "Query parameter 'limit' must be an integer between 1 and 250.",
                );
            }
            match trimmed.parse::<usize>() {
                Ok(n) if (1..=250).contains(&n) => n,
                _ => {
                    return HttpResponse::error(
                        400,
                        "invalid_session_limit",
                        "Query parameter 'limit' must be between 1 and 250.",
                    );
                }
            }
        }
    };

    let cursor = if let Some(raw_cursor) = req.query_param("cursor") {
        let trimmed = raw_cursor.trim();
        if trimmed.is_empty() {
            return HttpResponse::error(
                400,
                "invalid_session_cursor",
                "Query parameter 'cursor' cannot be empty.",
            );
        }
        match SessionCursor::decode(trimmed) {
            Ok(c) => Some(c),
            Err(err) => {
                return HttpResponse::error(400, "invalid_session_cursor", &err.to_string());
            }
        }
    } else {
        let raw_ts = req
            .query_param("cursorUpdatedAtMs")
            .or_else(|| req.query_param("cursor_updated_at_ms"));
        let raw_id = req
            .query_param("cursorId")
            .or_else(|| req.query_param("cursor_id"));
        match (raw_ts, raw_id) {
            (None, None) => None,
            (Some(ts_s), Some(id_s)) => {
                let Ok(ts) = ts_s.trim().parse::<i64>() else {
                    return HttpResponse::error(
                        400,
                        "invalid_session_cursor",
                        "Query parameter 'cursorUpdatedAtMs' must be a valid integer.",
                    );
                };
                let id_clean = id_s.trim().to_string();
                if !is_valid_studio_session_id(&id_clean) {
                    return HttpResponse::error(
                        400,
                        "invalid_session_cursor",
                        "Query parameter 'cursorId' is invalid.",
                    );
                }
                Some(SessionCursor {
                    updated_at_ms: ts,
                    id: id_clean,
                })
            }
            _ => {
                return HttpResponse::error(
                    400,
                    "invalid_session_cursor",
                    "Both 'cursorUpdatedAtMs' and 'cursorId' must be supplied together.",
                );
            }
        }
    };

    let page = match state.sessions.list_sessions_page(limit, cursor.as_ref()) {
        Ok(p) => p,
        Err(err) => return HttpResponse::error(500, "session_store_error", &err.to_string()),
    };
    let lease = state
        .sessions
        .active_lease(now_epoch_ms())
        .ok()
        .flatten()
        .map(|l| {
            json!({
                "leaseName": l.lease_name,
                "ownerId": l.owner_id,
                "pid": l.pid,
                "acquiredAtMs": l.acquired_at_ms,
                "heartbeatAtMs": l.heartbeat_at_ms,
                "expiresAtMs": l.expires_at_ms,
                "leaseEpoch": l.lease_epoch,
            })
        });

    let sessions: Vec<Value> = page
        .items
        .into_iter()
        .map(|s| {
            json!({
                "id": s.id,
                "title": s.title,
                "modelId": s.model_id,
                "model_id": s.model_id,
                "effort": s.effort,
                "revision": s.revision,
                "createdAtMs": s.created_at_ms,
                "updatedAtMs": s.updated_at_ms,
            })
        })
        .collect();

    let next_cursor_token = page.next_cursor.as_ref().map(SessionCursor::encode);
    let next_cursor_obj = page
        .next_cursor
        .map(|c| json!({ "updatedAtMs": c.updated_at_ms, "id": c.id }));

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "sessions": sessions,
        "totalCount": page.total_count,
        "hasMore": page.has_more,
        "nextCursor": next_cursor_obj,
        "nextCursorToken": next_cursor_token,
        "activeLease": lease,
    }))
}

fn handle_sessions_create(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let body = match req.json_object() {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let now = now_epoch_ms();
    let epoch = match ensure_studio_lease_current(state, now) {
        Ok(ep) => ep,
        Err(resp) => return resp,
    };
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if title.is_empty() {
        return HttpResponse::error(400, "session_create_failed", "Session title cannot be empty.");
    }
    let model_id = body
        .get("modelId")
        .or_else(|| body.get("model_id"))
        .or_else(|| body.get("model"))
        .and_then(Value::as_str)
        .unwrap_or("gpt-5.4-codex")
        .trim();
    let effort = body
        .get("effort")
        .and_then(Value::as_str)
        .unwrap_or("max")
        .trim();
    let custom_id = body
        .get("id")
        .or_else(|| body.get("customId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let created = if state.config.db_path.is_some() {
        match state.sessions.create_session_if_lease_current(
            title,
            model_id,
            effort,
            now,
            &state.lease_owner_id,
            i64::from(state.pid),
            epoch,
            custom_id,
        ) {
            Ok(Some(rec)) => rec,
            Ok(None) => {
                return HttpResponse::error(
                    503,
                    "studio_lease_lost",
                    "Cooperative SQLite session lease was lost before session creation committed.",
                );
            }
            Err(err) => {
                return HttpResponse::error(400, "session_create_failed", &err.to_string());
            }
        }
    } else {
        match state
            .sessions
            .create_session(title, model_id, effort, now, custom_id)
        {
            Ok(rec) => rec,
            Err(err) => {
                return HttpResponse::error(400, "session_create_failed", &err.to_string());
            }
        }
    };

    let sessions: Vec<Value> = state
        .sessions
        .list_sessions_page(50, None)
        .map(|p| {
            p.items
                .into_iter()
                .map(|s| {
                    json!({
                        "id": s.id,
                        "title": s.title,
                        "modelId": s.model_id,
                        "effort": s.effort,
                        "revision": s.revision,
                        "createdAtMs": s.created_at_ms,
                        "updatedAtMs": s.updated_at_ms,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    HttpResponse::ok(json!({
        "ok": true,
        "state": "online",
        "session": {
            "id": created.id,
            "title": created.title,
            "modelId": created.model_id,
            "effort": created.effort,
            "revision": created.revision,
            "createdAtMs": created.created_at_ms,
            "updatedAtMs": created.updated_at_ms,
        },
        "sessions": sessions,
    }))
}

fn handle_sessions_messages_get(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let session_id = req
        .query_param("session_id")
        .or_else(|| req.query_param("sessionId"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if session_id.is_empty() {
        return HttpResponse::error(
            400,
            "session_id_required",
            "Query parameter 'session_id' is required.",
        );
    }
    let since_seq = req
        .query_param("since_seq")
        .or_else(|| req.query_param("sinceSeq"))
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);

    match state.sessions.get_session(&session_id) {
        Ok(None) => return HttpResponse::error(404, "session_not_found", "Session not found."),
        Err(err) => return HttpResponse::error(500, "session_store_error", &err.to_string()),
        Ok(Some(_)) => {}
    }

    match state.sessions.list_messages(&session_id, since_seq) {
        Ok(msgs) => HttpResponse::ok(json!({
            "ok": true,
            "state": "online",
            "sessionId": session_id,
            "messages": msgs.into_iter().map(serialize_session_message).collect::<Vec<_>>(),
        })),
        Err(err) => HttpResponse::error(500, "session_store_error", &err.to_string()),
    }
}

fn handle_sessions_messages_post(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let body = match req.json_object() {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let session_id = body
        .get("sessionId")
        .or_else(|| body.get("session_id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let role = body
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("user")
        .trim();
    let content = body.get("content").and_then(Value::as_str).unwrap_or("");
    let meta_str = body
        .get("metadata")
        .map(|v| v.to_string())
        .unwrap_or_else(|| "{}".to_string());

    if session_id.is_empty() || content.trim().is_empty() {
        return HttpResponse::error(
            400,
            "invalid_message_payload",
            "sessionId and non-empty content are required.",
        );
    }

    let now = now_epoch_ms();
    if let Err(resp) = ensure_studio_lease_current(state, now) {
        return resp;
    }
    let redacted_content = SecretRedactor::redact(content);
    match state.sessions.append_message(
        session_id,
        role,
        &redacted_content,
        &meta_str,
        now,
    ) {
        Ok(msg) => {
            let messages = state
                .sessions
                .list_messages(session_id, 0)
                .unwrap_or_default()
                .into_iter()
                .map(serialize_session_message)
                .collect::<Vec<_>>();
            HttpResponse::ok(json!({
                "ok": true,
                "state": "online",
                "message": serialize_session_message(msg),
                "messages": messages,
            }))
        }
        Err(err) => {
            let status = if err.to_string().contains("not found") {
                404
            } else {
                400
            };
            HttpResponse::error(status, "session_message_failed", &err.to_string())
        }
    }
}

trait RichComposerCloneCompat {
    fn from_json_value_or_fresh(existing: &RichComposer) -> RichComposer;
}

impl RichComposerCloneCompat for RichComposer {
    fn from_json_value_or_fresh(_existing: &RichComposer) -> RichComposer {
        RichComposer::new()
    }
}

fn serialize_session_message(m: SessionMessageRecord) -> Value {
    let meta_json: Value = serde_json::from_str(&m.metadata_json).unwrap_or_else(|_| json!({}));
    json!({
        "id": m.id,
        "sessionId": m.session_id,
        "seq": m.seq,
        "role": m.role,
        "content": m.content,
        "metadata": meta_json,
        "createdAtMs": m.created_at_ms,
    })
}

fn serialize_graphify_edge(edge: &GraphifyEdge) -> Value {
    json!({
        "from": edge.from_id,
        "to": edge.to_id,
        "from_id": edge.from_id,
        "to_id": edge.to_id,
        "relation": edge.relation,
        "provenance": edge.provenance.as_str(),
        "confidenceBps": edge.confidence_bps,
        "confidence_bps": edge.confidence_bps,
        "sourceLocator": edge.source_locator,
        "source_locator": edge.source_locator,
    })
}

fn format_router_candidate_for_ui(snap: &CandidateSnapshot) -> Value {
    let quota_str = match snap.state.quota {
        omnia_routing::QuotaState::Known { .. } => "Known",
        omnia_routing::QuotaState::Stale { .. } => "Stale",
        omnia_routing::QuotaState::Contradictory { .. } => "Contradictory",
        omnia_routing::QuotaState::Unknown { .. } => "Unknown",
    };
    let remaining_tokens = match snap.state.quota {
        omnia_routing::QuotaState::Known {
            remaining_tokens, ..
        } => Some(remaining_tokens),
        omnia_routing::QuotaState::Stale {
            last_known_remaining_tokens,
            ..
        } => Some(last_known_remaining_tokens),
        _ => None,
    };
    let circuit_str = match snap.state.circuit {
        CircuitState::Closed => "Closed",
        CircuitState::Open { .. } => "Open",
        CircuitState::HalfOpen { .. } => "HalfOpen",
    };
    let err_rate = if snap.state.total_calls > 0 {
        let fails = snap
            .state
            .total_calls
            .saturating_sub(snap.state.success_count);
        fails as f64 / snap.state.total_calls as f64
    } else {
        0.0
    };
    let ewma = snap.state.ewma_latency_ms.map(|v| v.round() as u64);

    json!({
        "id": snap.candidate.candidate_id,
        "candidateId": snap.candidate.candidate_id,
        "providerId": snap.candidate.provider_id,
        "modelId": snap.candidate.model_id,
        "privacyTier": snap.candidate.privacy_tier.as_str(),
        "circuit": circuit_str,
        "quotaState": quota_str,
        "remainingTokens": remaining_tokens,
        "reserveTokens": snap.state.reserved_tokens,
        "concurrentReservations": snap.state.reserved_requests,
        "ewmaMs": ewma,
        "p95Ms": snap.state.latency_percentile(95).map(|v| v.round() as u64),
        "errorRate": err_rate,
        "candidate": snap.candidate.to_json(),
        "state": snap.state.to_json(),
    })
}

fn format_router_receipt_for_ui(receipt: &RouteDecisionReceipt) -> Value {
    let scores: Vec<Value> = receipt
        .candidate_scores
        .iter()
        .map(format_score_for_ui)
        .collect();
    json!({
        "receiptId": receipt.decision_id,
        "decisionId": receipt.decision_id,
        "requestId": receipt.request_id,
        "policyHash": receipt.policy_hash,
        "decidedAtMs": receipt.decided_at_ms,
        "allowed": receipt.allowed,
        "selectedCandidateId": receipt.selected_candidate_id,
        "reservationId": receipt.reservation_id,
        "fencingToken": receipt.fencing_token,
        "denyReason": receipt.deny_reason,
        "tokenBudget": receipt.token_budget,
        "scores": scores,
        "candidateScores": receipt.candidate_scores.iter().map(CandidateScoreBreakdown::to_json).collect::<Vec<_>>(),
    })
}

fn format_score_for_ui(score: &CandidateScoreBreakdown) -> Value {
    let cap = if score.eligible {
        ((score.capability_fit_bps.max(0) as u64) / 100).min(100)
    } else {
        0
    };
    let priv_score = if score.eligible {
        ((score.privacy_fit_bps.max(0) as u64) / 100).min(100)
    } else {
        0
    };
    let quota_score = if score.eligible {
        ((score.budget_headroom_bps.max(0) as u64) / 100).min(100)
    } else {
        0
    };
    let lat_score = if score.eligible {
        ((score.latency_health_bps.max(0) as u64) / 100).min(100)
    } else {
        0
    };
    let rel_score = if score.eligible {
        ((score.reliability_bps.max(0) as u64) / 100).min(100)
    } else {
        0
    };
    json!({
        "candidateId": score.candidate_id,
        "eligible": score.eligible,
        "totalScore": ((score.total_score_bps.max(0) as u64) / 100).min(100),
        "totalScoreBps": score.total_score_bps,
        "capabilityScore": cap,
        "privacyScore": priv_score,
        "quotaScore": quota_score,
        "latencyScore": lat_score,
        "reliabilityScore": rel_score,
        "rejectedReason": if score.eligible { Value::Null } else { json!(score.rejection_reason) },
        "raw": score.to_json(),
    })
}

fn format_memory_entry_for_ui(entry: &MemoryEntry) -> Value {
    let clean_content = SecretRedactor::redact(&entry.content);
    json!({
        "id": entry.id,
        "namespace": entry.namespace_path,
        "namespace_path": entry.namespace_path,
        "key": entry.key,
        "tier": entry.tier.as_str(),
        "content": clean_content,
        "contentSha256": entry.sha256_hex,
        "sha256_hex": entry.sha256_hex,
        "version": entry.version,
        "updatedAtMs": entry.updated_at_ms,
        "links": entry.links,
    })
}

fn format_erasure_receipt_for_ui(rc: &omnia_harness::memory_graph::ErasureReceipt) -> Value {
    json!({
        "receiptId": rc.receipt_id,
        "receipt_id": rc.receipt_id,
        "namespace": rc.namespace_path,
        "namespace_path": rc.namespace_path,
        "key": rc.key,
        "previousDigestSha256": rc.erased_sha256,
        "erased_sha256": rc.erased_sha256,
        "erasedAtMs": rc.erased_at_ms,
        "removedEdges": rc.removed_edges,
        "verifiedPlaintextFree": rc.verified_plaintext_free,
        "verified_plaintext_free": rc.verified_plaintext_free,
    })
}

fn parse_traversal_direction(raw: &str) -> Option<TraversalDirection> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "forward" => Some(TraversalDirection::Forward),
        "reverse" => Some(TraversalDirection::Reverse),
        "both" => Some(TraversalDirection::Both),
        _ => None,
    }
}

fn resolve_graphify_entity_id(graphify: &GraphifyIndex, candidate: &str) -> String {
    if let Ok(Some(exact)) = graphify.entity(candidate) {
        return exact.id;
    }
    if let Ok(entities) = graphify.entities() {
        let needle = candidate.to_ascii_lowercase();
        if let Some(m) = entities
            .iter()
            .find(|e| e.id.eq_ignore_ascii_case(candidate))
        {
            return m.id.clone();
        }
        if let Some(m) = entities
            .iter()
            .find(|e| e.label.eq_ignore_ascii_case(candidate))
        {
            return m.id.clone();
        }
        if let Some(m) = entities.iter().find(|e| {
            e.id.to_ascii_lowercase().contains(&needle)
                || e.label.to_ascii_lowercase().contains(&needle)
        }) {
            return m.id.clone();
        }
    }
    candidate.to_string()
}

fn parse_privacy_tier(raw: &str) -> PrivacyTier {
    match raw.trim().to_ascii_lowercase().as_str() {
        "local_only" | "strict_local" | "strict_local_zero_retention" | "localonly" => {
            PrivacyTier::LocalOnly
        }
        "private_vpc" | "privatevpc" => PrivacyTier::PrivateVpc,
        "zero_data_retention"
        | "enterprise_zdr"
        | "enterprise_redacted"
        | "zerodataretention"
        | "zdr" => PrivacyTier::ZeroDataRetention,
        _ => PrivacyTier::Public,
    }
}

fn parse_task_risk(raw: &str) -> TaskRisk {
    match raw.trim().to_ascii_lowercase().as_str() {
        "low" | "fast" => TaskRisk::Low,
        "high" | "reasoning" => TaskRisk::High,
        "critical" => TaskRisk::Critical,
        _ => TaskRisk::Standard,
    }
}

fn agent_graph_error_response(err: AgentGraphError) -> HttpResponse {
    match err {
        AgentGraphError::UnknownEntity(_) | AgentGraphError::UnknownAgent(_) => {
            HttpResponse::error(404, "entity_not_found", &err.to_string())
        }
        AgentGraphError::InactiveAgent(_) => {
            HttpResponse::error(409, "peer_policy_rejected", &err.to_string())
        }
        other => {
            let msg = other.to_string();
            if msg.to_ascii_lowercase().contains("disjoint") {
                HttpResponse::error(409, "peer_policy_rejected", &msg)
            } else {
                HttpResponse::error(400, "graph_error", &msg)
            }
        }
    }
}

fn memory_error_response(err: MemoryError) -> HttpResponse {
    match err {
        MemoryError::NotFound { .. } => {
            HttpResponse::error(404, "memory_not_found", &err.to_string())
        }
        MemoryError::InvalidNamespace(_) | MemoryError::InvalidKey(_) => {
            HttpResponse::error(400, "invalid_memory_target", &err.to_string())
        }
        MemoryError::InternalLockPoisoned => {
            HttpResponse::error(500, "memory_lock_poisoned", &err.to_string())
        }
    }
}

fn load_flagship_skills(config: &StudioConfig) -> SkillRegistry {
    let registry = SkillRegistry::new();
    let loaded = registry
        .load_from_workspace(&config.workspace_root)
        .map(|r| r.loaded)
        .unwrap_or(0);
    if loaded == 0 && config.skills_root.is_dir() {
        let _ = registry.load_from_directory(&config.skills_root);
    }
    let _ = registry.load_default_cold_vault();
    registry
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn make_test_state() -> Arc<StudioState> {
        let mut cfg = StudioConfig::default();
        let tmp = std::env::temp_dir().join(format!(
            "omnia-studio-legacy-test-{}",
            omnia_core::uuid_v4_simple()
        ));
        let ws = tmp.join("ws");
        let rb = tmp.join("rb");
        let _ = fs::create_dir_all(&ws);
        let _ = fs::create_dir_all(&rb);
        cfg.workspace_root = ws;
        cfg.rollback_root = rb;
        cfg.db_path = None;
        cfg.runtime_url = None;
        let state = StudioState::new(cfg).expect("StudioState::new");
        let cand = RouteCandidate {
            candidate_id: "fixture:model-alpha".to_string(),
            provider_id: "fixture".to_string(),
            model_id: "model-alpha".to_string(),
            auth_boundary: "default".to_string(),
            region: "local".to_string(),
            privacy_tier: PrivacyTier::Public,
            capabilities: ModelCapabilities::standard_candidate(),
            context_limit_tokens: 128_000,
            max_output_tokens: 8_192,
            quality_tier: 3,
            pricing_version: "fixture".to_string(),
            input_cost_per_million_microunits: Some(1_000),
            output_cost_per_million_microunits: Some(2_000),
            credential_present: true,
            enabled: true,
            route_priority: 10,
            supported_roles: Vec::new(),
        };
        let st = CandidateResourceState {
            quota: QuotaState::Known {
                remaining_tokens: 500_000,
                remaining_requests: 100,
                window_capacity_tokens: 500_000,
                window_duration_ms: 60_000,
                window_reset_at_ms: Some(now_epoch_ms() + 60_000),
                freshness_timestamp_ms: Some(now_epoch_ms()),
                max_staleness_ms: 600_000,
            },
            ..CandidateResourceState::default()
        };
        let _ = state.router.upsert_candidate(cand, st);
        Arc::new(state)
    }

    fn make_req(method: &str, path: &str, query: &str, body: Value) -> HttpRequest {
        HttpRequest {
            method: method.to_string(),
            target: if query.is_empty() {
                path.to_string()
            } else {
                format!("{path}?{query}")
            },
            path: path.to_string(),
            query: query.to_string(),
            headers: BTreeMap::new(),
            cookie_header_count: 0,
            body: if method == "GET" {
                Vec::new()
            } else {
                serde_json::to_vec(&body).unwrap_or_default()
            },
        }
    }

    #[tokio::test]
    async fn aud09_router_simulate_is_side_effect_free_and_validates_before_mutation() {
        let state = make_test_state();

        // 1. Invalid estimatedTokens rejected BEFORE tripCandidate mutates circuit!
        let bad_tok = handle_router_decide(
            &state,
            &make_req(
                "POST",
                "/api/router/decide",
                "",
                json!({
                    "tripCandidate": "fixture:model-alpha",
                    "estimatedTokens": 10
                }),
            ),
        );
        assert_eq!(bad_tok.status, 400);
        let bad_json: Value = serde_json::from_slice(&bad_tok.body).unwrap();
        assert_eq!(bad_json["code"], "invalid_estimated_tokens");
        assert_eq!(bad_json["field"], "estimatedTokens");
        // Verify candidate circuit remained Closed (no mutation occurred before validation!).
        let snaps = state.router.snapshots(now_epoch_ms()).unwrap();
        let alpha = snaps
            .iter()
            .find(|s| s.candidate.candidate_id == "fixture:model-alpha")
            .unwrap();
        assert!(matches!(alpha.state.circuit, CircuitState::Closed));

        // 2. simulate + tripCandidate rejected with 400 simulation_cannot_change_circuit.
        let sim_trip = handle_router_decide(
            &state,
            &make_req(
                "POST",
                "/api/router/decide",
                "",
                json!({
                    "simulate": true,
                    "tripCandidate": "fixture:model-alpha",
                    "estimatedTokens": 1024
                }),
            ),
        );
        assert_eq!(sim_trip.status, 400);
        assert_eq!(
            serde_json::from_slice::<Value>(&sim_trip.body).unwrap()["code"],
            "simulation_cannot_change_circuit"
        );

        // 3. Repeated simulate: true calls consume zero quota/concurrency & zero receipts.
        let before_receipts = state.router.decision_receipts().unwrap().len();
        for _ in 0..3 {
            let sim = handle_router_decide(
                &state,
                &make_req(
                    "POST",
                    "/api/router/decide",
                    "",
                    json!({
                        "simulate": true,
                        "estimatedTokens": 2048,
                        "privacyTier": "public"
                    }),
                ),
            );
            assert_eq!(sim.status, 200);
            let sj: Value = serde_json::from_slice(&sim.body).unwrap();
            assert_eq!(sj["status"], "SIMULATED_DETERMINISTIC");
            assert_eq!(sj["simulated"], true);
            assert!(sj["reservation"].is_null());
            assert_eq!(sj["receipt"]["simulated"], true);
            assert_eq!(sj["receipt"]["reservedTokens"], 0);
        }
        let after_receipts = state.router.decision_receipts().unwrap().len();
        assert_eq!(before_receipts, after_receipts);
        let after_alpha = state
            .router
            .snapshots(now_epoch_ms())
            .unwrap()
            .into_iter()
            .find(|s| s.candidate.candidate_id == "fixture:model-alpha")
            .unwrap();
        assert_eq!(after_alpha.state.reserved_tokens, 0);
        assert_eq!(after_alpha.state.reserved_requests, 0);
    }

    #[tokio::test]
    async fn pr1_session_pagination_cursor_detail_and_health_demo_mode_false() {
        let state = make_test_state();

        let health = handle_health(&state).await;
        assert_eq!(health.status, 200);
        let hj: Value = serde_json::from_slice(&health.body).unwrap();
        assert_eq!(hj["demoMode"], false);

        // Invalid limit and cursor rejected with 400.
        assert_eq!(
            handle_sessions_list(&state, &make_req("GET", "/api/sessions", "limit=0", Value::Null))
                .status,
            400
        );
        assert_eq!(
            handle_sessions_list(&state, &make_req("GET", "/api/sessions", "limit=abc", Value::Null))
                .status,
            400
        );
        assert_eq!(
            handle_sessions_list(
                &state,
                &make_req("GET", "/api/sessions", "cursor=bad-cursor", Value::Null)
            )
            .status,
            400
        );

        // Create 3 sessions and page using hex cursor + inspect detail route.
        for idx in 1..=3 {
            let _ = state.sessions.create_session(
                &format!("Session {idx}"),
                "gpt-5.4-codex",
                "high",
                1_700_000_000_000 + idx * 1000,
                Some(&format!("sess-{idx}")),
            );
        }
        let p1 = handle_sessions_list(
            &state,
            &make_req("GET", "/api/sessions", "limit=2", Value::Null),
        );
        assert_eq!(p1.status, 200);
        let p1j: Value = serde_json::from_slice(&p1.body).unwrap();
        assert_eq!(p1j["totalCount"], 3);
        assert_eq!(p1j["hasMore"], true);
        let tok = p1j["nextCursorToken"].as_str().unwrap();

        let p2 = handle_sessions_list(
            &state,
            &make_req("GET", "/api/sessions", &format!("limit=2&cursor={tok}"), Value::Null),
        );
        assert_eq!(p2.status, 200);
        let p2j: Value = serde_json::from_slice(&p2.body).unwrap();
        assert_eq!(p2j["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(p2j["hasMore"], false);

        // Detail endpoint: valid, 404, and invalid traversal rejected with 400.
        assert_eq!(handle_session_detail(&state, "/api/sessions/sess-1").status, 200);
        assert_eq!(handle_session_detail(&state, "/api/sessions/missing-id").status, 404);
        assert_eq!(
            handle_session_detail(&state, "/api/sessions/..%2Fetc").status,
            400
        );
    }
}
