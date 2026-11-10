//! Tauri surface for the agent harness: session CRUD, sending/steering/
//! interrupting runs, and answering approval requests. Every agent event is
//! emitted on `omnia-agent` as `{ sessionId, event }`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use dashmap::DashMap;
use omnia_harness::agent::{Agent, AgentEvent, ApprovalDecision, Approver, EventSink, SteerQueue};
use omnia_harness::hooks::HookRunner;
use omnia_harness::mcp::{McpManager, McpServerStatus};
use omnia_harness::run_control::{ActiveRun, ChannelApprover};

#[path = "harness_permissions.rs"]
mod perms;
#[path = "harness_trust.rs"]
mod trust;
#[cfg(test)]
use omnia_harness::agent::AgentConfig;
use omnia_harness::permission::{PermissionMode, PermissionPolicy};
use omnia_harness::prompt::SystemPromptConfig;
use omnia_harness::skills::{self, SkillTool};
use omnia_harness::subagent::{self, TaskTool};
use omnia_harness::user_input::{
    AskUserTool, PendingQuestion, QuestionBroker, QuestionError, QuestionReceipt,
};
use omnia_harness::{
    tools, Block, CheckpointStore, HarnessError, Message, RestoreReport, ToolContext, ToolRegistry,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;
use trust::ConfigSnapshot;

use crate::error::{NativeError, NativeResult};
use crate::harness_store::{AgentSessionSummary, HarnessStore, SessionScope};
use crate::prompt_presets::PromptPreset;
use crate::provider_gateway::harness_provider;
use crate::state::AppState;
#[cfg(test)]
use omnia_harness::CheckpointScope;
use omnia_session_store::run_coordinator::RunCoordinator;
use omnia_session_store::run_events::{publish_run_event, RunEventState};
use omnia_session_store::run_execution::{execute_prepared_run, PreparedRunExecution};
#[cfg(test)]
use omnia_session_store::run_execution::{
    observed_spend, persist_run_snapshot, record_observed_spend,
};
use omnia_session_store::session_preparation::prepare_session_config;

pub const AGENT_EVENT: &str = "omnia-agent";
const MAX_TITLE_CHARS: usize = 60;

pub struct HarnessHub {
    runtime: RunCoordinator<ActiveRun>,
    pub(crate) services: Arc<crate::agent_services::AgentServices>,
    /// Per-session file checkpoints live in `<root>/<session_id>`.
    checkpoint_root: PathBuf,
    /// Private app-owned working roots for projectless sessions. These roots
    /// are never supplied by the user and are not project membership markers.
    projectless_root: PathBuf,
    /// One set of MCP server connections per workspace folder, started on
    /// the first run there and shared by every session in it.
    mcp: Arc<Mutex<HashMap<PathBuf, (String, McpManager)>>>,
    presets: crate::prompt_presets::PresetStore,
    /// User-level (global) permission rules.
    rules: perms::RuleStore,
    /// Fan-out of every `run_finished` event, sent after the run is removed
    /// from `runs`. Lets non-renderer callers (the MCP server) await a run.
    finished: tokio::sync::broadcast::Sender<RunFinished>,
}

/// Completion notice for one agent run.
#[derive(Debug, Clone)]
pub(crate) struct RunFinished {
    pub session_id: String,
    /// The persisted `run_finished` event (`status`, optional `message`).
    pub event: Value,
}

impl HarnessHub {
    pub(crate) fn require_service_session(&self, id: &str) -> NativeResult<()> {
        require_service_session(self.runtime.store(), &self.projectless_root, id)
    }
    /// Validated workspace folder of a session (used by the review pane).
    pub(crate) fn session_workspace(&self, session_id: &str) -> NativeResult<PathBuf> {
        let id = require_id(session_id, "sessionId")?;
        session_workspace(&self.runtime.store().summary(&id)?, &self.projectless_root)
    }
    /// Whether an agent run is currently active in this session.
    pub(crate) fn run_active(&self, session_id: &str) -> bool {
        // A poisoned registry cannot establish idle; fail closed for bool callers.
        self.runtime
            .runs()
            .contains_key(session_id.trim())
            .unwrap_or(true)
    }
    pub fn open(app_data_dir: &Path) -> NativeResult<Self> {
        Ok(Self {
            runtime: RunCoordinator::from_store(HarnessStore::open(
                &app_data_dir.join("harness.sqlite3"),
            )?),
            services: Arc::new(crate::agent_services::AgentServices::new(app_data_dir)),
            checkpoint_root: app_data_dir.join("harness_checkpoints"),
            projectless_root: app_data_dir.join("projectless_sessions"),
            mcp: Arc::new(Mutex::new(HashMap::new())),
            presets: crate::prompt_presets::PresetStore::new(app_data_dir),
            rules: perms::RuleStore::new(app_data_dir),
            finished: tokio::sync::broadcast::channel(64).0,
        })
    }

    /// Subscribes to run completions. Subscribe *before* starting a run to
    /// be certain not to miss its completion.
    pub(crate) fn subscribe_finished(&self) -> tokio::sync::broadcast::Receiver<RunFinished> {
        self.finished.subscribe()
    }

    pub(crate) fn store(&self) -> &HarnessStore {
        self.runtime.store()
    }

    pub(crate) fn presets(&self) -> &crate::prompt_presets::PresetStore {
        &self.presets
    }

    /// Holds the lifecycle lock (so no run can start) and fails while any run is active.
    pub(crate) fn idle_guard(&self) -> NativeResult<std::sync::MutexGuard<'_, ()>> {
        let guard = self.runtime.lock_lifecycle()?;
        if !self.runtime.runs().is_empty()? {
            return Err(NativeError::new(
                "agent_run_active",
                "Interrupt all running agents before exporting or importing data",
            ));
        }
        Ok(guard)
    }
}

fn require_service_session(
    store: &HarnessStore,
    projectless_root: &Path,
    id: &str,
) -> NativeResult<()> {
    let id = require_id(id, "sessionId")?;
    let cwd = session_workspace(&store.summary(&id)?, projectless_root)?;
    ConfigSnapshot::capture(&cwd, omnia_home().as_deref())?.require_trust(store)
}

/// `~/.omnia`: user-level hooks, MCP servers, skills and agents.
pub(crate) fn omnia_home() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".omnia"))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// User-level directories for `kind` (`skills`, `agents`), Omnia's own first;
/// `~/.claude/<kind>` is read too so existing definitions carry over.
///
/// Codex skills are an explicit compatibility surface.  They are considered
/// only for `skills`, and are appended after the existing Omnia and Claude
/// roots so a project skill, Omnia skill, or Claude skill with the same name
/// wins deterministically.  `OMNIA_CODEX_SKILLS_DIR` is the preferred
/// opt-in override; `CODEX_HOME/skills` and the conventional
/// `~/.codex/skills` path are fallbacks.  Relative configured roots are
/// rejected rather than interpreted against an implicit working directory.
fn user_dirs(kind: &str) -> Vec<PathBuf> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let mut dirs = vec![
        home.join(".omnia").join(kind),
        home.join(".claude").join(kind),
    ];
    if kind == "skills" {
        if let Some(codex) = codex_skills_dir(&home) {
            dirs.push(codex);
        }
    }
    dirs
}

fn codex_skills_dir(home: &Path) -> Option<PathBuf> {
    configured_codex_skills_dir(
        home,
        std::env::var_os("OMNIA_CODEX_SKILLS_DIR"),
        std::env::var_os("CODEX_HOME"),
    )
}

/// Resolve the Codex root without ever interpreting a relative environment
/// value against the process working directory.  Keeping the raw values as
/// parameters also makes the precedence and fail-closed behavior testable
/// without mutating process-global environment variables.
fn configured_codex_skills_dir(
    home: &Path,
    explicit_root: Option<std::ffi::OsString>,
    codex_home: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    if let Some(raw) = explicit_root {
        let configured = PathBuf::from(raw);
        return configured.is_absolute().then_some(configured);
    }
    if let Some(raw) = codex_home {
        let configured = PathBuf::from(raw);
        return configured.is_absolute().then(|| configured.join("skills"));
    }
    home.is_absolute()
        .then(|| home.join(".codex").join("skills"))
}

/// Plugin-contributed directories (`skills`, `agents`, `commands`) of the
/// plugins that may be used right now.
fn plugin_dirs_of(plugins: &[omnia_harness::plugins::Plugin], kind: &str) -> Vec<PathBuf> {
    omnia_harness::plugins::plugin_dirs(plugins, kind)
}

/// Active plugins for `cwd` without requiring a valid/trusted configuration
/// (an unreadable configuration simply contributes nothing).
fn session_plugins(cwd: &Path, store: &HarnessStore) -> Vec<omnia_harness::plugins::Plugin> {
    ConfigSnapshot::capture(cwd, omnia_home().as_deref())
        .map(|snapshot| snapshot.active_plugins(store))
        .unwrap_or_default()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSystemPromptPreviewRequest {
    pub session_id: String,
}

#[tauri::command]
pub fn agent_system_prompt_preview(
    hub: State<'_, HarnessHub>,
    request: AgentSystemPromptPreviewRequest,
) -> NativeResult<String> {
    let id = require_id(&request.session_id, "sessionId")?;
    let summary = hub.runtime.store().summary(&id)?;
    let cwd = session_workspace(&summary, &hub.projectless_root)?;
    let plugins = session_plugins(&cwd, hub.runtime.store());
    let skills = skills::discover_skills_with_plugins(
        &cwd,
        &user_dirs("skills"),
        &plugin_dirs_of(&plugins, "skills"),
    );
    Ok(prepare_session_config(
        &summary,
        &cwd,
        omnia_home().as_deref(),
        summary.permission_mode == PermissionMode::Plan,
        &skills,
    )
    .system
    .unwrap_or_default())
}

#[tauri::command]
pub fn agent_prompt_presets_list(hub: State<'_, HarnessHub>) -> NativeResult<Vec<PromptPreset>> {
    hub.presets.list()
}

#[derive(Debug, Deserialize)]
pub struct AgentPromptPresetSaveRequest {
    pub preset: PromptPreset,
}

#[tauri::command]
pub fn agent_prompt_preset_save(
    hub: State<'_, HarnessHub>,
    request: AgentPromptPresetSaveRequest,
) -> NativeResult<Vec<PromptPreset>> {
    hub.presets.save(request.preset)
}

#[derive(Debug, Deserialize)]
pub struct AgentPromptPresetDeleteRequest {
    pub id: String,
}

#[tauri::command]
pub fn agent_prompt_preset_delete(
    hub: State<'_, HarnessHub>,
    request: AgentPromptPresetDeleteRequest,
) -> NativeResult<Vec<PromptPreset>> {
    hub.presets.delete(&request.id)
}

async fn mcp_for(
    servers: &Mutex<HashMap<PathBuf, (String, McpManager)>>,
    snapshot: &ConfigSnapshot,
    store: &HarnessStore,
) -> NativeResult<McpManager> {
    // This applies even to status/reload and cached connections, never just send.
    snapshot.require_trust(store)?;
    let (_, configs) = snapshot.configurations(store)?;
    let mut servers = servers.lock().await;
    if let Some((key, manager)) = servers.get(&snapshot.cwd) {
        if key == snapshot.cache_key() {
            let manager = manager.clone();
            drop(servers);
            manager.refresh_if_changed().await;
            return Ok(manager);
        }
    }
    if let Some((_, previous)) = servers.remove(&snapshot.cwd) {
        previous.shutdown().await;
    }
    let manager = McpManager::start_all(configs).await;
    // A trust revocation during startup must not expose new tools.
    if let Err(error) = snapshot.require_trust(store) {
        manager.shutdown().await;
        return Err(error);
    }
    servers.insert(
        snapshot.cwd.clone(),
        (snapshot.cache_key().to_owned(), manager.clone()),
    );
    Ok(manager)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventPayload<'a> {
    session_id: &'a str,
    event: &'a Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    sequence: Option<i64>,
}

fn emit(app: &AppHandle, session_id: &str, event: Value) {
    let _ = app.emit(
        AGENT_EVENT,
        EventPayload {
            session_id,
            event: &event,
            sequence: None,
        },
    );
}

fn persist_emit(store: &HarnessStore, app: &AppHandle, id: &str, event: Value) -> NativeResult<()> {
    omnia_session_store::event_publisher::publish_event(store, id, event, |published| {
        // Notification is advisory. A missed wakeup is recovered from the
        // durable journal; the shared publisher commits before this callback.
        app.emit(
            AGENT_EVENT,
            EventPayload {
                session_id: &published.session_id,
                event: &published.event,
                sequence: Some(published.sequence),
            },
        )
        .is_ok()
    })
    .map(|_| ())
}

/// EventSink cannot return errors, so a failed journal write cancels the run.
/// Check that token again at the actual tool boundary, including filesystem
/// tools that otherwise need not observe cancellation themselves.
struct JournalGatedTool(Arc<dyn omnia_harness::Tool>);
#[async_trait]
impl omnia_harness::Tool for JournalGatedTool {
    fn spec(&self) -> omnia_harness::ToolSpec {
        self.0.spec()
    }
    fn effect(&self) -> omnia_harness::EffectClass {
        self.0.effect()
    }
    fn describe(&self, input: &Value) -> String {
        self.0.describe(input)
    }
    async fn call(
        &self,
        ctx: &ToolContext,
        input: Value,
    ) -> omnia_harness::HarnessResult<omnia_harness::ToolOutput> {
        if ctx.cancel.is_cancelled() {
            return Err(HarnessError::Cancelled);
        }
        self.0.call(ctx, input).await
    }
}
fn gate_registry(registry: &mut ToolRegistry) {
    let names: Vec<_> = registry.names().map(str::to_owned).collect();
    for name in names {
        if let Some(tool) = registry.get(&name) {
            registry.register(Arc::new(JournalGatedTool(tool)));
        }
    }
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

pub(crate) fn require_id(value: &str, field: &'static str) -> NativeResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 200 || value.chars().any(char::is_control) {
        return Err(NativeError::invalid(field, "is invalid"));
    }
    Ok(value.to_owned())
}

pub(crate) fn validate_cwd(cwd: &str) -> NativeResult<PathBuf> {
    let path = PathBuf::from(cwd.trim());
    if !path.is_absolute() || !path.is_dir() {
        return Err(NativeError::invalid(
            "cwd",
            "must be an existing absolute folder",
        ));
    }
    dunce::canonicalize(path).map_err(|error| NativeError::invalid("cwd", error.to_string()))
}

/// Resolve projectless execution from app ownership and session identity rather
/// than trusting the exported `cwd` field. This also rebases imported sessions
/// onto this installation and keeps an arbitrary persisted path from granting
/// project access merely by being labelled projectless.
fn session_workspace(
    summary: &AgentSessionSummary,
    projectless_root: &Path,
) -> NativeResult<PathBuf> {
    match summary.scope {
        SessionScope::Project => validate_cwd(&summary.cwd),
        SessionScope::Projectless => projectless_workspace(projectless_root, &summary.id),
    }
}

fn projectless_workspace(root: &Path, id: &str) -> NativeResult<PathBuf> {
    if id.is_empty()
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err(NativeError::invalid(
            "sessionId",
            "is not a plain path segment",
        ));
    }
    let storage_error = |error: std::io::Error| {
        NativeError::new(
            "projectless_storage_failed",
            format!("Cannot prepare the private projectless scratch root: {error}"),
        )
    };
    std::fs::create_dir_all(root).map_err(storage_error)?;
    let expected_root = root.parent().zip(root.file_name()).ok_or_else(|| {
        NativeError::new(
            "projectless_storage_failed",
            "The app scratch root has no parent directory",
        )
    })?;
    let expected_root = dunce::canonicalize(expected_root.0)
        .map_err(storage_error)?
        .join(expected_root.1);
    let root = dunce::canonicalize(root).map_err(storage_error)?;
    if root != expected_root {
        return Err(NativeError::new(
            "projectless_storage_failed",
            "The app scratch root resolves through a link outside its expected location",
        ));
    }
    let workspace = root.join(id);
    std::fs::create_dir_all(&workspace).map_err(storage_error)?;
    let workspace = dunce::canonicalize(workspace).map_err(storage_error)?;
    if workspace.parent() != Some(root.as_path()) {
        return Err(NativeError::new(
            "projectless_storage_failed",
            "The projectless scratch root resolves outside Omnia app storage",
        ));
    }
    Ok(workspace)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionCreateRequest {
    #[serde(default)]
    pub cwd: String,
    pub profile_id: String,
    pub model: String,
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub fallback_models: Vec<String>,
    #[serde(default)]
    pub token_budget: Option<u64>,
    #[serde(default)]
    pub system_prompt: Option<SystemPromptConfig>,
}

/// An override with no text is no override.
fn normalize_system_prompt(config: Option<SystemPromptConfig>) -> Option<SystemPromptConfig> {
    config.filter(|config| !config.text.trim().is_empty())
}

/// Trims, drops blanks and duplicates (and the primary model), keeps order.
fn normalize_fallback_models(models: Vec<String>, primary: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for model in models {
        let model = model.trim().to_owned();
        if !model.is_empty() && model != primary && !out.contains(&model) && out.len() < 8 {
            out.push(model);
        }
    }
    out
}

#[tauri::command]
pub fn agent_session_create(
    hub: State<'_, HarnessHub>,
    request: AgentSessionCreateRequest,
) -> NativeResult<AgentSessionSummary> {
    create_session(&hub, request)
}

/// Shared by the Tauri command and the MCP server.
pub(crate) fn create_session(
    hub: &HarnessHub,
    request: AgentSessionCreateRequest,
) -> NativeResult<AgentSessionSummary> {
    let model = require_id(&request.model, "model")?;
    let profile_id = require_id(&request.profile_id, "profileId")?;
    let projectless = request.cwd.trim().is_empty();
    let id = uuid::Uuid::new_v4().to_string();
    let (scope, cwd) = if projectless {
        let cwd = projectless_workspace(&hub.projectless_root, &id)?;
        (SessionScope::Projectless, cwd)
    } else {
        (SessionScope::Project, validate_cwd(&request.cwd)?)
    };
    let now = now_ms();
    let summary = AgentSessionSummary {
        id,
        title: request.title.unwrap_or_default().trim().to_owned(),
        scope,
        cwd: cwd.to_string_lossy().into_owned(),
        profile_id,
        fallback_models: normalize_fallback_models(request.fallback_models, &model),
        token_budget: request.token_budget.filter(|budget| *budget > 0),
        tokens_used: 0,
        system_prompt: normalize_system_prompt(request.system_prompt),
        model,
        permission_mode: request.permission_mode.unwrap_or_default(),
        rules: Vec::new(),
        reasoning_effort: request.reasoning_effort,
        parent_id: None,
        settings_revision: 1,
        message_count: 0,
        created_at_ms: now,
        updated_at_ms: now,
    };
    hub.runtime.store().save_summary(&summary)?;
    Ok(summary)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionListItem {
    #[serde(flatten)]
    pub summary: AgentSessionSummary,
    pub running: bool,
}

#[tauri::command]
pub fn agent_session_list(hub: State<'_, HarnessHub>) -> NativeResult<Vec<AgentSessionListItem>> {
    list_sessions(&hub)
}

pub(crate) fn list_sessions(hub: &HarnessHub) -> NativeResult<Vec<AgentSessionListItem>> {
    hub.runtime
        .store()
        .list()?
        .into_iter()
        .map(|summary| {
            Ok(AgentSessionListItem {
                running: hub.runtime.runs().contains_key(&summary.id)?,
                summary,
            })
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRef {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionDetail {
    pub summary: AgentSessionSummary,
    pub messages: Vec<Message>,
    pub running: bool,
    /// Only currently live senders are answerable. Historical journal requests
    /// stay auditable but are never revived after a process restart.
    pub pending_questions: Vec<PendingQuestion>,
    #[serde(flatten)]
    pub replay: crate::harness_store::RunReplay,
}

#[tauri::command]
pub fn agent_session_read(
    hub: State<'_, HarnessHub>,
    request: AgentSessionRef,
) -> NativeResult<AgentSessionDetail> {
    read_session(&hub, request)
}

pub(crate) fn read_session(
    hub: &HarnessHub,
    request: AgentSessionRef,
) -> NativeResult<AgentSessionDetail> {
    let id = require_id(&request.session_id, "sessionId")?;
    let (summary, messages, replay) = hub.runtime.store().read_snapshot(&id)?;
    Ok(AgentSessionDetail {
        summary,
        messages,
        replay,
        running: hub.runtime.runs().contains_key(&id)?,
        pending_questions: hub
            .runtime
            .runs()
            .get(&id)?
            .map(|run| run.questions.pending())
            .unwrap_or_default(),
    })
}

#[tauri::command]
pub fn agent_session_delete(
    hub: State<'_, HarnessHub>,
    request: AgentSessionRef,
) -> NativeResult<()> {
    let id = require_id(&request.session_id, "sessionId")?;
    let _lifecycle = hub.runtime.lock_lifecycle()?;
    if let Some(run) = hub.runtime.runs().get(&id)? {
        run.cancel.cancel();
        run.approvals.clear();
        // Session deletion is a terminal run boundary too. Resolve live
        // question senders before deleting the journal row so a waiting tool
        // cannot publish a late request or remain blocked after its session
        // disappears. Keep the run reachable until this durable close
        // succeeds; otherwise a journal failure would strand a cancelled run
        // while the session still exists.
        run.questions
            .close("session_deleted")
            .map_err(question_error)?;
        drop(run);
        hub.runtime.runs().retire(&id)?;
    }
    hub.services.retire(&id);
    crate::inspector::forget_session(&id);
    hub.runtime.store().delete(&id)?;
    // Best effort: leftover checkpoint data is orphaned, not harmful.
    if let Ok(dir) = hub.checkpoint_dir(&id) {
        let _ = CheckpointStore::destroy(&dir);
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionUpdateRequest {
    pub session_id: String,
    /// Optional CAS token for user-authored per-session settings. Omitting it
    /// keeps backwards compatibility for older clients while native clients
    /// always send the revision returned in the last session snapshot.
    #[serde(default)]
    pub expected_settings_revision: Option<u64>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
    /// `Some(None)` clears it; absent leaves it unchanged.
    #[serde(default, deserialize_with = "deserialize_some")]
    pub reasoning_effort: Option<Option<String>>,
    #[serde(default)]
    pub fallback_models: Option<Vec<String>>,
    /// `Some(None)` clears the budget; absent leaves it unchanged.
    #[serde(default, deserialize_with = "deserialize_some")]
    pub token_budget: Option<Option<u64>>,
    /// `Some(None)` clears the override; absent leaves it unchanged.
    #[serde(default, deserialize_with = "deserialize_some")]
    pub system_prompt: Option<Option<SystemPromptConfig>>,
}

fn deserialize_some<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// Model and provider changes apply from the next run; the permission mode
/// applies immediately, including to a run in progress.
#[tauri::command]
pub async fn agent_session_update(
    hub: State<'_, HarnessHub>,
    request: AgentSessionUpdateRequest,
) -> NativeResult<AgentSessionSummary> {
    let id = require_id(&request.session_id, "sessionId")?;
    let profile = request
        .profile_id
        .as_deref()
        .map(|v| require_id(v, "profileId"))
        .transpose()?;
    let model = request
        .model
        .as_deref()
        .map(|v| require_id(v, "model"))
        .transpose()?;
    let summary = hub.runtime.store().update_summary_cas(
        &id,
        request.expected_settings_revision,
        |summary| {
            if let Some(title) = request.title {
                summary.title = title.trim().chars().take(200).collect();
            }
            if let Some(profile) = profile {
                summary.profile_id = profile;
            }
            if let Some(model) = model {
                summary.model = model;
            }
            if let Some(effort) = request.reasoning_effort {
                summary.reasoning_effort = effort;
            }
            if let Some(mode) = request.permission_mode {
                summary.permission_mode = mode;
            }
            if let Some(models) = request.fallback_models {
                summary.fallback_models = normalize_fallback_models(models, &summary.model);
            } else {
                let primary = summary.model.clone();
                summary.fallback_models.retain(|model| *model != primary);
            }
            if let Some(budget) = request.token_budget {
                summary.token_budget = budget.filter(|budget| *budget > 0);
            }
            if let Some(config) = request.system_prompt {
                summary.system_prompt = normalize_system_prompt(config);
            }
            summary.updated_at_ms = now_ms();
        },
    )?;
    if let Some(mode) = request.permission_mode {
        if let Some(run) = hub.runtime.runs().get(&id)? {
            run.policy.lock().await.mode = mode;
        }
    }
    Ok(summary)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentImage {
    pub media_type: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSendRequest {
    pub session_id: String,
    pub text: String,
    #[serde(default)]
    pub images: Vec<AgentImage>,
}

#[tauri::command]
pub async fn agent_send(
    app: AppHandle,
    state: State<'_, AppState>,
    hub: State<'_, HarnessHub>,
    request: AgentSendRequest,
) -> NativeResult<()> {
    send_message(&app, &state, &hub, request).await
}

/// Starts a run; shared by the Tauri command and the MCP server. Returns as
/// soon as the run is registered; completion is announced on
/// `HarnessHub::subscribe_finished`.
pub(crate) async fn send_message(
    app: &AppHandle,
    state: &AppState,
    hub: &HarnessHub,
    request: AgentSendRequest,
) -> NativeResult<()> {
    let app = app.clone();
    let id = require_id(&request.session_id, "sessionId")?;
    let checkpoint_dir = hub.checkpoint_dir(&id)?;
    if request.text.trim().is_empty() && request.images.is_empty() {
        return Err(NativeError::invalid("text", "is empty"));
    }
    let summary = hub.runtime.store().summary(&id)?;
    let cwd = session_workspace(&summary, &hub.projectless_root)?;
    let snapshot = ConfigSnapshot::capture(&cwd, omnia_home().as_deref())?;
    let (hook_config, _) = snapshot.configurations(hub.runtime.store())?;
    let plugins = snapshot.active_plugins(hub.runtime.store());

    let mut content: Vec<Block> = request
        .images
        .into_iter()
        .map(|image| Block::Image {
            media_type: image.media_type,
            data: image.data,
        })
        .collect();
    if !request.text.trim().is_empty() {
        content.push(Block::text(expand_custom_command(
            &cwd,
            &request.text,
            &plugins,
        )));
    }

    // Global and trusted project rules first, then this session's own.
    let mut rules = hub.rules.list()?;
    rules.extend(snapshot.honored_permission_rules(hub.runtime.store())?);
    let base_len = rules.len();
    rules.extend(summary.rules.iter().cloned());
    let policy = Arc::new(Mutex::new(PermissionPolicy {
        mode: summary.permission_mode,
        rules,
    }));
    let approvals = Arc::new(DashMap::new());
    let queued = Arc::new(DashMap::new());
    let batch = Arc::new(DashMap::new());
    let ctx = {
        let mut ctx = ToolContext::new(&cwd);
        ctx.session_id = id.clone();
        ctx
    };
    let questions = {
        let app = app.clone();
        let session_id = id.clone();
        let store = Arc::clone(hub.runtime.store());
        let cancel = ctx.cancel.clone();
        Arc::new(QuestionBroker::new(
            id.clone(),
            format!("run_{}", uuid::Uuid::new_v4().simple()),
            ctx.cancel.clone(),
            Arc::new(move |event| {
                persist_emit(&store, &app, &session_id, event).map_err(|error| {
                    cancel.cancel();
                    error.to_string()
                })
            }),
        ))
    };
    let run = Arc::new(ActiveRun {
        cwd: cwd.clone(),
        cancel: ctx.cancel.clone(),
        steer: SteerQueue::default(),
        policy: Arc::clone(&policy),
        approvals: Arc::clone(&approvals),
        questions,
        queued: Arc::clone(&queued),
        batch: Arc::clone(&batch),
        base_len: std::sync::atomic::AtomicUsize::new(base_len),
    });
    // The shared Rust owner serializes snapshot/replay admission with host
    // rewind/deletion. No framework handle or provider dispatch enters it.
    let admission = hub.runtime.admit(&id, Arc::clone(&run))?;
    let (mut initial_history, run_ticket) = (admission.history, admission.ticket);

    let provider = match harness_provider(
        state,
        &summary.profile_id,
        Some(crate::inspector::log_for_session(&id)),
    )
    .await
    {
        Ok(provider) => provider,
        Err(error) => {
            hub.runtime.runs().remove_current(&run_ticket)?;
            return Err(error);
        }
    };

    let prepare = (|| -> NativeResult<()> {
        hub.runtime.store().update_summary(&id, |summary| {
            if summary.title.is_empty() {
                summary.title = request.text.trim().chars().take(MAX_TITLE_CHARS).collect();
            }
        })?;
        // Journal event + running status are committed in one transaction.
        persist_emit(
            hub.runtime.store(),
            &app,
            &id,
            json!({"type":"run_started", "runId":run.questions.run_id()}),
        )
    })();
    if let Err(error) = prepare {
        hub.runtime.runs().remove_current(&run_ticket)?;
        return Err(error);
    }
    let event_state = Arc::new(RunEventState::default());
    let events: Arc<dyn EventSink> = {
        let app = app.clone();
        let id = id.clone();
        let store = Arc::clone(hub.runtime.store());
        let cancel = ctx.cancel.clone();
        let event_state = Arc::clone(&event_state);
        let approvals = Arc::clone(&approvals);
        let request_log = crate::inspector::log_for_session(&id);
        Arc::new(move |event: AgentEvent| {
            match &event {
                AgentEvent::Retrying { .. } => request_log.note_retry(),
                AgentEvent::ModelFallback { .. } => request_log.note_fallback(),
                _ => {}
            }
            // Shared Rust processing preserves accounting, sender-readiness
            // filtering and cancel-on-journal-failure before host notification.
            if let Err(error) = publish_run_event(
                &event,
                &event_state,
                &cancel,
                |id| approvals.contains_key(id),
                |value| persist_emit(&store, &app, &id, value),
            ) {
                emit(
                    &app,
                    &id,
                    json!({"type":"error", "message":error.to_string()}),
                );
            }
        })
    };
    let approver: Arc<dyn Approver> = Arc::new(ChannelApprover {
        approvals,
        queued,
        batch,
        events: Arc::clone(&events),
        cancel: ctx.cancel.clone(),
    });
    let store = Arc::clone(hub.runtime.store());
    let runs = Arc::clone(hub.runtime.runs());
    let finished_tx = hub.finished.clone();
    let mcp_servers = Arc::clone(&hub.mcp);
    let services = Arc::clone(&hub.services);
    let projectless_root = hub.projectless_root.clone();
    let prompt_text = request.text;
    tauri::async_runtime::spawn(async move {
        let execution = async {
            let hooks = (!hook_config.is_empty())
                .then(|| Arc::new(HookRunner::new(hook_config, id.clone())));
            let skills = skills::discover_skills_with_plugins(
                &cwd,
                &user_dirs("skills"),
                &plugin_dirs_of(&plugins, "skills"),
            );
            let mcp = mcp_for(&mcp_servers, &snapshot, &store).await?;
            snapshot.require_trust(&store)?;
            if ctx.cancel.is_cancelled() {
                return Err(NativeError::new(
                    "agent_cancelled",
                    "Run interrupted before startup",
                ));
            }

            let plan_mode = policy.lock().await.mode == PermissionMode::Plan;
            let mut registry: ToolRegistry = tools::builtin_registry();
            registry.register(Arc::new(AskUserTool::new(Arc::clone(&run.questions))));
            let service_guard: crate::agent_services::ServiceGuard = {
                let store = Arc::clone(&store);
                let id = id.clone();
                let projectless_root = projectless_root.clone();
                Arc::new(move || require_service_session(&store, &projectless_root, &id))
            };
            crate::agent_services::register(
                &mut registry,
                services.session(&id)?,
                Arc::clone(&service_guard),
            );
            for tool in mcp.tools() {
                registry.register(tool);
            }
            // Planning controls use the same typed native backend as the MCP
            // adapter.  This is an in-process call: no loopback HTTP hop and no
            // second goal database writer.  Read tools remain read-only; mutations
            // are classified as workspace writes and therefore pass through the
            // normal permission/approval gate below.
            crate::goal_tools::register(
                &mut registry,
                Arc::new(crate::mcp_server::TauriBackend { app: app.clone() }),
                service_guard.clone(),
            );
            omnia_harness::memory::register(&mut registry, omnia_home());
            // Resolve the same immutable config bytes that passed the workspace
            // trust boundary; a later file edit must not change LSP executables.
            omnia_harness::lsp::register_snapshot(
                &mut registry,
                omnia_home(),
                &cwd,
                snapshot.lsp_specs(&store)?,
            );
            let config =
                prepare_session_config(&summary, &cwd, omnia_home().as_deref(), plan_mode, &skills);
            if !skills.is_empty() {
                registry.register(Arc::new(SkillTool::new(skills)));
            }
            gate_registry(&mut registry);
            let task = TaskTool {
                provider: Arc::clone(&provider),
                config: config.clone(),
                tools: registry.clone(),
                policy: Arc::clone(&policy),
                approver: Arc::clone(&approver),
                events: Arc::clone(&events),
                agents: subagent::discover_agents_with_plugins(
                    &cwd,
                    &user_dirs("agents"),
                    &plugin_dirs_of(&plugins, "agents"),
                ),
                hooks: hooks.clone(),
                current_depth: 0,
                max_depth: omnia_harness::subagent::DEFAULT_MAX_SUBAGENT_DEPTH,
            };
            registry.register(Arc::new(JournalGatedTool(Arc::new(task))));
            // Only Plan mode can hand a plan over; subagents (cloned above) cannot.
            omnia_harness::plan::register_for_mode(&mut registry, policy.lock().await.mode);

            let agent = Agent {
                provider,
                tools: registry,
                policy,
                approver,
                events,
                steer: run.steer.clone(),
                config,
                hooks,
            };
            execute_prepared_run(PreparedRunExecution {
                store: &store,
                session_id: &id,
                agent,
                ctx: ctx.clone(),
                history: &mut initial_history,
                content,
                prompt_text: &prompt_text,
                checkpoint_dir: &checkpoint_dir,
                base_rules: &run.base_len,
                run_tokens: &event_state.run_tokens,
                plan_presented: &event_state.plan_presented,
                persistence_error: &event_state.persistence_error,
            })
            .await
        }
        .await;
        let finished = execution.unwrap_or_else(
            |error| json!({"type":"run_finished", "status":"failed", "message":error.to_string()}),
        );
        let finished = match run.questions.close("run_finished") {
            Ok(()) => finished,
            Err(error) => {
                json!({"type":"run_finished", "status":"failed", "message":error.to_string()})
            }
        };
        let finished_event = finished.clone();
        if let Err(error) = persist_emit(&store, &app, &id, finished) {
            emit(
                &app,
                &id,
                json!({"type":"error", "message":error.to_string()}),
            );
            eprintln!("Agent run persistence failed: {error}");
        }
        if let Err(error) = runs.remove_current(&run_ticket) {
            emit(
                &app,
                &id,
                json!({"type":"error", "message":error.to_string()}),
            );
        }
        // No receivers is the normal case (renderer-only runs).
        let _ = finished_tx.send(RunFinished {
            session_id: id.clone(),
            event: finished_event,
        });
    });
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSteerRequest {
    pub session_id: String,
    pub text: String,
}

/// Queues a message for the running agent; it is delivered at the next safe
/// point (after the current tool batch). Fails if nothing is running so the
/// renderer can fall back to `agent_send`.
#[tauri::command]
pub fn agent_steer(hub: State<'_, HarnessHub>, request: AgentSteerRequest) -> NativeResult<()> {
    let id = require_id(&request.session_id, "sessionId")?;
    let run = hub
        .runtime
        .runs()
        .get(&id)?
        .ok_or_else(|| NativeError::new("agent_not_running", "The agent is not running"))?;
    if request.text.trim().is_empty() {
        return Err(NativeError::invalid("text", "is empty"));
    }
    run.steer.push(request.text);
    Ok(())
}

#[tauri::command]
pub fn agent_interrupt(hub: State<'_, HarnessHub>, request: AgentSessionRef) -> NativeResult<()> {
    interrupt_session(&hub, request)
}

pub(crate) fn interrupt_session(hub: &HarnessHub, request: AgentSessionRef) -> NativeResult<()> {
    let id = require_id(&request.session_id, "sessionId")?;
    if let Some(run) = hub.runtime.runs().get(&id)? {
        run.cancel.cancel();
        run.approvals.clear();
        let result = run.questions.close("run_interrupted");
        hub.services.stop_session_computer(&id);
        return result.map_err(question_error);
    }
    hub.services.stop_session_computer(&id);
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentUserInputRequest {
    pub session_id: String,
    pub request_id: String,
    /// Optional for compatibility with older clean-room clients. Request UUIDs
    /// remain scoped to the current run even when this field is omitted.
    #[serde(default)]
    pub run_id: Option<String>,
    /// The outer option distinguishes an omitted field from an explicit JSON
    /// `null`: null is the deliberate user-cancel acknowledgement, while an
    /// omitted answer is malformed and must never be interpreted as cancel.
    #[serde(deserialize_with = "deserialize_some")]
    pub answer: Option<Option<String>>,
}

fn question_error(error: QuestionError) -> NativeError {
    let code = match &error {
        QuestionError::Invalid(_) => "user_input_invalid",
        QuestionError::NotPending => "user_input_not_pending",
        QuestionError::WrongRun => "user_input_wrong_run",
        QuestionError::Closed => "agent_not_running",
        QuestionError::Journal(_) => "harness_storage_failed",
    };
    NativeError::new(code, error.to_string())
}

#[tauri::command]
pub fn agent_user_input(
    hub: State<'_, HarnessHub>,
    request: AgentUserInputRequest,
) -> NativeResult<QuestionReceipt> {
    let id = require_id(&request.session_id, "sessionId")?;
    let request_id = require_id(&request.request_id, "requestId")?;
    let run = hub.runtime.runs().get(&id)?.ok_or_else(|| {
        NativeError::new(
            "agent_not_running",
            "That run is no longer active; historical questions cannot be answered",
        )
    })?;
    let answer = request.answer.ok_or_else(|| {
        NativeError::new(
            "user_input_invalid",
            "answer is required; use null to explicitly cancel the question",
        )
    })?;
    run.questions
        .answer(&request_id, request.run_id.as_deref(), answer)
        .map_err(question_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApprovalDecideRequest {
    pub session_id: String,
    pub tool_use_id: String,
    pub decision: ApprovalDecision,
}

#[tauri::command]
pub fn agent_approval_decide(
    app: AppHandle,
    hub: State<'_, HarnessHub>,
    request: AgentApprovalDecideRequest,
) -> NativeResult<()> {
    let id = require_id(&request.session_id, "sessionId")?;
    let run = hub
        .runtime
        .runs()
        .get(&id)?
        .ok_or_else(|| NativeError::new("agent_not_running", "The agent is not running"))?;
    let (_, sender) = run.approvals.remove(&request.tool_use_id).ok_or_else(|| {
        NativeError::new("approval_not_pending", "That approval is no longer pending")
    })?;
    if let Err(error) = persist_emit(
        hub.runtime.store(),
        &app,
        &id,
        json!({"type":"approval_decided", "id":request.tool_use_id, "decision":request.decision}),
    ) {
        run.cancel.cancel();
        return Err(error);
    }
    sender.send(request.decision).map_err(|_| {
        NativeError::new(
            "approval_not_pending",
            "The run no longer accepts this approval",
        )
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApprovalDecideAllRequest {
    pub session_id: String,
    /// The approval currently shown; everything queued behind it gets the same answer.
    pub tool_use_id: String,
    pub decision: ApprovalDecision,
}

/// "Allow all pending" / "Deny all pending": answers the shown approval and
/// every approval queued behind it in the same turn with one decision. The
/// agent still asks them one at a time in queue order, so ordering, deny
/// rules and hooks are exactly as if each had been answered by hand.
#[tauri::command]
pub fn agent_approval_decide_all(
    app: AppHandle,
    hub: State<'_, HarnessHub>,
    request: AgentApprovalDecideAllRequest,
) -> NativeResult<()> {
    if !matches!(
        request.decision,
        ApprovalDecision::AllowOnce | ApprovalDecision::Deny { .. }
    ) {
        return Err(NativeError::invalid(
            "decision",
            "a batch decision must be allow_once or deny",
        ));
    }
    let id = require_id(&request.session_id, "sessionId")?;
    let run = hub
        .runtime
        .runs()
        .get(&id)?
        .ok_or_else(|| NativeError::new("agent_not_running", "The agent is not running"))?;
    let behind = run
        .queued
        .get(&request.tool_use_id)
        .map(|ids| ids.clone())
        .ok_or_else(|| {
            NativeError::new("approval_not_pending", "That approval is no longer pending")
        })?;
    // Record the answers before releasing the shown approval so the next
    // request in the queue finds its decision waiting.
    for next in &behind {
        run.batch.insert(next.clone(), request.decision.clone());
    }
    let (_, sender) = run.approvals.remove(&request.tool_use_id).ok_or_else(|| {
        for next in &behind {
            run.batch.remove(next);
        }
        NativeError::new("approval_not_pending", "That approval is no longer pending")
    })?;
    if let Err(error) = persist_emit(
        hub.runtime.store(),
        &app,
        &id,
        json!({"type":"approval_decided", "id":request.tool_use_id, "decision":request.decision}),
    ) {
        run.cancel.cancel();
        return Err(error);
    }
    sender.send(request.decision).map_err(|_| {
        NativeError::new(
            "approval_not_pending",
            "The run no longer accepts this approval",
        )
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionRulesRequest {
    #[serde(default)]
    pub session_id: Option<String>,
    /// Workspace folder when no session is given (project rules).
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRulesListing {
    pub path: String,
    pub exists: bool,
    /// Project rules apply only while the workspace's configuration is trusted.
    pub trusted: bool,
    pub error: Option<String>,
    pub rules: Vec<omnia_harness::permission::PermissionRule>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRulesListing {
    pub global: Vec<omnia_harness::permission::PermissionRule>,
    /// `None` when no workspace was given.
    pub project: Option<ProjectRulesListing>,
    /// `None` when no session was given.
    pub session: Option<Vec<omnia_harness::permission::PermissionRule>>,
    pub mode: Option<PermissionMode>,
}

/// Resolves the session and/or workspace a rules request is about.
fn rules_target(
    hub: &HarnessHub,
    session_id: &Option<String>,
    cwd: &Option<String>,
) -> NativeResult<(Option<String>, Option<PathBuf>)> {
    let session = session_id
        .as_deref()
        .map(|v| require_id(v, "sessionId"))
        .transpose()?;
    let workspace = match (&session, cwd) {
        (Some(id), _) => Some(hub.session_workspace(id)?),
        (None, Some(cwd)) => Some(validate_cwd(cwd)?),
        (None, None) => None,
    };
    Ok((session, workspace))
}

async fn session_rules_now(
    hub: &HarnessHub,
    id: &str,
) -> NativeResult<Vec<omnia_harness::permission::PermissionRule>> {
    if let Some(run) = hub.runtime.runs().get(id)? {
        let base = run.base_len.load(std::sync::atomic::Ordering::SeqCst);
        return Ok(run
            .policy
            .lock()
            .await
            .rules
            .iter()
            .skip(base)
            .cloned()
            .collect());
    }
    Ok(hub.runtime.store().summary(id)?.rules)
}

fn project_listing(hub: &HarnessHub, cwd: &Path) -> NativeResult<ProjectRulesListing> {
    let project = ConfigSnapshot::capture(cwd, omnia_home().as_deref())?
        .project_permission_rules(hub.runtime.store());
    Ok(ProjectRulesListing {
        path: project.path,
        exists: project.exists,
        trusted: project.trusted,
        error: project.error,
        rules: project.rules,
    })
}

async fn rules_listing(
    hub: &HarnessHub,
    session: &Option<String>,
    workspace: &Option<PathBuf>,
) -> NativeResult<PermissionRulesListing> {
    Ok(PermissionRulesListing {
        global: hub.rules.list()?,
        project: workspace
            .as_deref()
            .map(|cwd| project_listing(hub, cwd))
            .transpose()?,
        session: match session {
            Some(id) => Some(session_rules_now(hub, id).await?),
            None => None,
        },
        mode: match session {
            Some(id) => Some(hub.runtime.store().summary(id)?.permission_mode),
            None => None,
        },
    })
}

/// Every rule the user has, by scope, for the Permission rules manager.
#[tauri::command]
pub async fn agent_permission_rules_list(
    hub: State<'_, HarnessHub>,
    request: AgentPermissionRulesRequest,
) -> NativeResult<PermissionRulesListing> {
    let (session, workspace) = rules_target(&hub, &request.session_id, &request.cwd)?;
    rules_listing(&hub, &session, &workspace).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionRulesSetRequest {
    pub scope: perms::RuleScope,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// The scope's complete rule list, in order.
    pub rules: Vec<omnia_harness::permission::PermissionRule>,
}

/// Recomputes the global + project part of every active run's rules so edits
/// apply immediately, to runs already in progress too. The session part is kept.
async fn refresh_active_runs(hub: &HarnessHub, only_cwd: Option<&Path>) -> NativeResult<()> {
    let runs: Vec<Arc<ActiveRun>> = hub
        .runtime
        .runs()
        .snapshot()?
        .into_iter()
        .filter(|run| only_cwd.map_or(true, |cwd| run.cwd == cwd))
        .collect();
    for run in runs {
        let base = (|| -> NativeResult<Vec<_>> {
            let mut rules = hub.rules.list()?;
            let snapshot = ConfigSnapshot::capture(&run.cwd, omnia_home().as_deref())?;
            rules.extend(snapshot.honored_permission_rules(hub.runtime.store())?);
            Ok(rules)
        })();
        // An unreadable file leaves the run's current rules in place.
        let Ok(base) = base else { continue };
        let mut policy = run.policy.lock().await;
        let old = run.base_len.load(std::sync::atomic::Ordering::SeqCst);
        let session: Vec<_> = policy.rules.iter().skip(old).cloned().collect();
        run.base_len
            .store(base.len(), std::sync::atomic::Ordering::SeqCst);
        policy.rules = base;
        policy.rules.extend(session);
    }
    Ok(())
}

/// Replaces one scope's rules. Global and project edits take effect in runs
/// already in progress. Editing a project's rules from here re-trusts the
/// workspace only if it was trusted just before (the user made the edit).
#[tauri::command]
pub async fn agent_permission_rules_set(
    hub: State<'_, HarnessHub>,
    request: AgentPermissionRulesSetRequest,
) -> NativeResult<PermissionRulesListing> {
    let (session, workspace) = rules_target(&hub, &request.session_id, &request.cwd)?;
    perms::validate_rules(&request.rules)?;
    match request.scope {
        perms::RuleScope::Global => {
            hub.rules.replace(request.rules)?;
            refresh_active_runs(&hub, None).await?;
        }
        perms::RuleScope::Project => {
            let cwd = workspace.clone().ok_or_else(|| {
                NativeError::invalid("cwd", "a workspace is required for project rules")
            })?;
            let before = ConfigSnapshot::capture(&cwd, omnia_home().as_deref())?;
            let was_trusted = before.status(hub.runtime.store())?.trusted;
            perms::write_project_rules(&cwd, &request.rules)?;
            if was_trusted {
                let after = ConfigSnapshot::capture(&cwd, omnia_home().as_deref())?
                    .status(hub.runtime.store())?;
                hub.runtime
                    .store()
                    .set_workspace_trust(&after.cwd, Some(after.fingerprint.as_str()))?;
            }
            refresh_active_runs(&hub, Some(&cwd)).await?;
        }
        perms::RuleScope::Session => {
            let id = session.clone().ok_or_else(|| {
                NativeError::invalid("sessionId", "a session is required for session rules")
            })?;
            hub.runtime
                .store()
                .update_summary(&id, |summary| summary.rules = request.rules.clone())?;
            if let Some(run) = hub.runtime.runs().get(&id)? {
                let mut policy = run.policy.lock().await;
                let base = run
                    .base_len
                    .load(std::sync::atomic::Ordering::SeqCst)
                    .min(policy.rules.len());
                policy.rules.truncate(base);
                policy.rules.extend(request.rules.iter().cloned());
            }
        }
    }
    rules_listing(&hub, &session, &workspace).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionRulesTestRequest {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Mode to evaluate in when no session is given (default ask-writes).
    #[serde(default)]
    pub mode: Option<PermissionMode>,
    pub tool: String,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub effect: Option<omnia_harness::EffectClass>,
}

/// "Would this call be allowed?" against the saved rules (untrusted project
/// rules are not applied, exactly as in a real run).
#[tauri::command]
pub async fn agent_permission_rules_test(
    hub: State<'_, HarnessHub>,
    request: AgentPermissionRulesTestRequest,
) -> NativeResult<perms::TestOutcome> {
    let tool = require_id(&request.tool, "tool")?;
    let (session, workspace) = rules_target(&hub, &request.session_id, &request.cwd)?;
    let listing = rules_listing(&hub, &session, &workspace).await?;
    let project: Vec<_> = match &listing.project {
        Some(project) if project.trusted && project.error.is_none() => project.rules.clone(),
        _ => Vec::new(),
    };
    let session_rules = listing.session.clone().unwrap_or_default();
    let layers: [(perms::RuleScope, &[_]); 3] = [
        (perms::RuleScope::Global, &listing.global),
        (perms::RuleScope::Project, &project),
        (perms::RuleScope::Session, &session_rules),
    ];
    let mode = listing.mode.or(request.mode).unwrap_or_default();
    Ok(perms::test_call(
        mode,
        &layers,
        &tool,
        &request.input,
        request.effect,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRewindRequest {
    pub session_id: String,
    /// Number of messages to keep.
    pub keep: usize,
    /// Also restore files changed by the discarded turns (default false).
    #[serde(default)]
    pub restore_files: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRewindResult {
    #[serde(flatten)]
    pub detail: AgentSessionDetail,
    /// Present only when `restoreFiles` was requested.
    pub file_restore: Option<RestoreReport>,
    /// Nonfatal preservation notice after a conversation-only recovery rewind.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint_recovery_notice: Option<String>,
}

#[tauri::command]
pub fn agent_rewind(
    hub: State<'_, HarnessHub>,
    request: AgentRewindRequest,
) -> NativeResult<AgentRewindResult> {
    let id = require_id(&request.session_id, "sessionId")?;
    hub.rewind(&id, request.keep, request.restore_files)
}

impl HarnessHub {
    /// `<checkpoint_root>/<id>`; the id must be a plain path segment.
    fn checkpoint_dir(&self, id: &str) -> NativeResult<PathBuf> {
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(NativeError::invalid("sessionId", "is invalid"));
        }
        Ok(self.checkpoint_root.join(id))
    }

    fn rewind(
        &self,
        id: &str,
        keep: usize,
        restore_files: bool,
    ) -> NativeResult<AgentRewindResult> {
        let _lifecycle = self.runtime.lock_lifecycle()?;
        if self.runtime.runs().contains_key(id)? {
            return Err(NativeError::new(
                "agent_run_active",
                "Interrupt the agent before rewinding",
            ));
        }
        let dir = self.checkpoint_dir(id)?;
        self.runtime.store().summary(id)?; // unknown sessions are an error, not an empty rewind
        let mut messages = self.runtime.store().messages(id)?;
        let keep = omnia_harness::compact::rewind_boundary(&messages, keep);
        let mut checkpoint_recovery_notice = None;
        let mut conversation_checkpoints = None;
        let file_restore = if restore_files {
            let checkpoints = CheckpointStore::open(&dir).map_err(|error| {
                NativeError::new(
                    "checkpoint_store_failed",
                    format!("Cannot open file checkpoints: {error}"),
                )
            })?;
            checkpoints
                .prepare_restore(&messages, keep)
                .map_err(|error| NativeError::retryable("checkpoint_store_failed", error))?;
            let report = checkpoints.restore(keep);
            if !report.failed.is_empty() {
                return Err(NativeError::retryable(
                    "checkpoint_restore_failed",
                    format!(
                        "Conversation was kept because file rewind did not finish. Some files may already have been restored. Fix the checkpoint errors and retry: {}",
                        report.failed.join("; ")
                    ),
                ));
            }
            Some(report)
        } else {
            // Conversation-only: stale records would shadow the next turns.
            if dir.exists() {
                let checkpoints = CheckpointStore::open(&dir).map_err(|error| {
                    NativeError::retryable(
                        "checkpoint_store_failed",
                        format!("Conversation was kept because file checkpoints could not be opened: {error}"),
                    )
                })?;
                checkpoint_recovery_notice = checkpoints
                    .prepare_conversation_rewind(&messages, keep)
                    .map_err(|error| NativeError::retryable(
                        "checkpoint_store_failed",
                        format!("Conversation was kept because file checkpoints could not be updated: {error}"),
                    ))?;
                conversation_checkpoints = Some(checkpoints);
            }
            None
        };
        messages.truncate(keep);
        self.runtime.store().write_messages(id, &messages, 0)?;
        if let Some(checkpoints) = conversation_checkpoints {
            checkpoints.confirm_history(&messages).map_err(|error| {
                NativeError::retryable(
                    "checkpoint_store_failed",
                    format!("Conversation rewind was saved, but its checkpoint confirmation needs recovery: {error}"),
                )
            })?;
        }
        Ok(AgentRewindResult {
            detail: AgentSessionDetail {
                summary: self.runtime.store().summary(id)?,
                messages,
                running: false,
                pending_questions: Vec::new(),
                replay: self.runtime.store().replay(id)?,
            },
            file_restore,
            checkpoint_recovery_notice,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentForkRequest {
    pub session_id: String,
    /// Messages to copy; all when absent.
    #[serde(default)]
    pub keep: Option<usize>,
}

#[tauri::command]
pub fn agent_fork(
    hub: State<'_, HarnessHub>,
    request: AgentForkRequest,
) -> NativeResult<AgentSessionSummary> {
    fork_session(&hub, request)
}

fn fork_session(hub: &HarnessHub, request: AgentForkRequest) -> NativeResult<AgentSessionSummary> {
    let id = require_id(&request.session_id, "sessionId")?;
    let source = hub.runtime.store().summary(&id)?;
    let mut messages = hub.runtime.store().messages(&id)?;
    if let Some(keep) = request.keep {
        messages.truncate(keep);
    }
    let now = now_ms();
    let fork_id = uuid::Uuid::new_v4().to_string();
    let cwd = match source.scope {
        SessionScope::Project => source.cwd.clone(),
        SessionScope::Projectless => projectless_workspace(&hub.projectless_root, &fork_id)?
            .to_string_lossy()
            .into_owned(),
    };
    let fork = AgentSessionSummary {
        id: fork_id,
        cwd,
        title: format!("{} (fork)", source.title).trim().to_owned(),
        parent_id: Some(source.id.clone()),
        tokens_used: 0,
        settings_revision: 1,
        message_count: messages.len(),
        created_at_ms: now,
        updated_at_ms: now,
        ..source
    };
    hub.runtime.store().save_summary(&fork)?;
    hub.runtime.store().write_messages(&fork.id, &messages, 0)?;
    Ok(fork)
}

#[cfg(test)]
mod tests {
    use super::*;
    use omnia_harness::agent::ApprovalRequest;
    use tokio::sync::oneshot;

    #[test]
    fn borrowed_event_payload_preserves_wire_shape() {
        let event = json!({"type":"text_delta", "text":"native Rust"});
        let sequenced = serde_json::to_value(EventPayload {
            session_id: "session_fixture",
            event: &event,
            sequence: Some(42),
        })
        .unwrap();
        assert_eq!(
            sequenced,
            json!({"sessionId":"session_fixture","event":event,"sequence":42})
        );
        let advisory = serde_json::to_value(EventPayload {
            session_id: "session_fixture",
            event: &event,
            sequence: None,
        })
        .unwrap();
        assert_eq!(
            advisory,
            json!({"sessionId":"session_fixture","event":event})
        );
    }

    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn codex_skill_root_resolution_is_explicit_and_fail_closed() {
        // Resolution is lexical; no directory needs to exist for this test.
        let home = std::env::temp_dir().join("omnia-codex-root-resolution");
        let explicit = home.join("selected-codex-skills");
        let codex_home = home.join("codex-home");

        assert_eq!(
            configured_codex_skills_dir(
                &home,
                Some(explicit.clone().into_os_string()),
                Some(codex_home.clone().into_os_string()),
            ),
            Some(explicit),
            "the explicit Omnia override must win over CODEX_HOME",
        );
        assert_eq!(
            configured_codex_skills_dir(&home, None, Some(codex_home.clone().into_os_string()),),
            Some(codex_home.join("skills")),
        );
        assert_eq!(
            configured_codex_skills_dir(&home, None, None),
            Some(home.join(".codex").join("skills")),
        );
        assert_eq!(
            configured_codex_skills_dir(
                &home,
                Some("relative/skills".into()),
                Some(codex_home.into_os_string()),
            ),
            None,
            "a relative explicit root must not silently resolve against cwd",
        );
        assert_eq!(
            configured_codex_skills_dir(&home, Some("".into()), None),
            None,
            "an explicitly empty override disables the compatibility root",
        );
        assert_eq!(
            configured_codex_skills_dir(&home, None, Some("relative/codex".into())),
            None,
        );
        assert_eq!(
            configured_codex_skills_dir(Path::new("relative-home"), None, None),
            None,
        );
    }

    fn create_request(cwd: &str) -> AgentSessionCreateRequest {
        serde_json::from_value(json!({
            "cwd": cwd,
            "profileId": "configured-profile",
            "model": "configured-model",
            "reasoningEffort": "high",
            "title": "Projectless research"
        }))
        .unwrap()
    }

    fn registry_test_run(session_id: &str) -> Arc<ActiveRun> {
        let cancel = omnia_harness::CancellationToken::new();
        Arc::new(ActiveRun {
            cwd: PathBuf::new(),
            questions: Arc::new(QuestionBroker::new(
                session_id.to_owned(),
                format!("run_{}", uuid::Uuid::new_v4().simple()),
                cancel.clone(),
                Arc::new(|_| Ok(())),
            )),
            cancel,
            steer: SteerQueue::default(),
            policy: Arc::new(Mutex::new(PermissionPolicy::new(PermissionMode::AskWrites))),
            approvals: Arc::new(DashMap::new()),
            queued: Arc::new(DashMap::new()),
            batch: Arc::new(DashMap::new()),
            base_len: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    #[test]
    fn host_cleanup_ticket_preserves_successor_and_interrupt_targets_current_run() {
        let temporary = std::env::temp_dir();
        let root = temporary.join(format!("omnia-host-registry-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let hub = HarnessHub::open(&root).unwrap();
        let session = create_session(&hub, create_request("")).unwrap();
        let old_run = registry_test_run(&session.id);
        let old = hub
            .runtime
            .admit(&session.id, Arc::clone(&old_run))
            .unwrap()
            .ticket;
        assert_eq!(
            hub.runtime
                .admit(&session.id, registry_test_run(&session.id))
                .err()
                .unwrap()
                .code,
            "agent_run_active"
        );
        assert!(hub.run_active(&session.id));
        assert!(list_sessions(&hub).unwrap()[0].running);
        hub.runtime.runs().retire(&session.id).unwrap();
        let successor = registry_test_run(&session.id);
        let current = hub
            .runtime
            .admit(&session.id, Arc::clone(&successor))
            .unwrap()
            .ticket;
        assert!(!hub.runtime.runs().remove_current(&old).unwrap());
        assert!(Arc::ptr_eq(
            &hub.runtime.runs().get(&session.id).unwrap().unwrap(),
            &successor
        ));
        interrupt_session(
            &hub,
            AgentSessionRef {
                session_id: session.id.clone(),
            },
        )
        .unwrap();
        assert!(successor.cancel.is_cancelled());
        assert!(!old_run.cancel.is_cancelled());
        assert!(hub.runtime.runs().remove_current(&current).unwrap());
        assert!(!hub.run_active(&session.id));
        assert!(!list_sessions(&hub).unwrap()[0].running);
        drop(hub);
        assert_eq!(root.parent(), Some(temporary.as_path()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn projectless_create_uses_distinct_private_roots_and_persists_scope_on_restart() {
        let root = std::env::temp_dir().join(format!("omnia-projectless-{}", uuid::Uuid::new_v4()));
        // HarnessHub::open receives the app-data directory and owns the
        // SQLite file at `<app-data>/harness.sqlite3`. Only direct
        // HarnessStore::open calls below receive the SQLite file itself.
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let (first_id, first_cwd) = {
            let hub = HarnessHub::open(&data).unwrap();
            let first = create_session(&hub, create_request("")).unwrap();
            let second = create_session(&hub, create_request("  ")).unwrap();
            assert_eq!(first.scope, SessionScope::Projectless);
            assert_eq!(second.scope, SessionScope::Projectless);
            assert_ne!(first.cwd, second.cwd);
            assert_eq!(first.reasoning_effort.as_deref(), Some("high"));
            assert_eq!(first.permission_mode, PermissionMode::AskWrites);
            assert!(Path::new(&first.cwd).is_dir());
            assert!(Path::new(&first.cwd)
                .starts_with(dunce::canonicalize(data.join("projectless_sessions")).unwrap()));
            std::fs::write(Path::new(&first.cwd).join("draft.txt"), "durable scratch").unwrap();
            (first.id, first.cwd)
        };
        let hub = HarnessHub::open(&data).unwrap();
        let restored = hub.runtime.store().summary(&first_id).unwrap();
        assert_eq!(restored.scope, SessionScope::Projectless);
        assert_eq!(restored.cwd, first_cwd);
        assert_eq!(
            std::fs::read_to_string(Path::new(&restored.cwd).join("draft.txt")).unwrap(),
            "durable scratch"
        );
        assert_eq!(
            list_sessions(&hub)
                .unwrap()
                .iter()
                .filter(|item| item.summary.scope == SessionScope::Projectless)
                .count(),
            2
        );
        drop(hub);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn omitted_cwd_is_projectless_but_explicit_invalid_project_path_is_rejected() {
        let request: AgentSessionCreateRequest = serde_json::from_value(json!({
            "profileId": "configured-profile", "model": "configured-model"
        }))
        .unwrap();
        assert!(request.cwd.is_empty());
        let root = std::env::temp_dir().join(format!(
            "omnia-projectless-validation-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let hub = HarnessHub::open(&root).unwrap();
        assert_eq!(
            create_session(&hub, request).unwrap().scope,
            SessionScope::Projectless
        );
        assert!(create_session(&hub, create_request("relative/project")).is_err());
        assert_eq!(hub.runtime.store().list().unwrap().len(), 1);
        drop(hub);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn projectless_storage_failure_does_not_save_a_session() {
        let root =
            std::env::temp_dir().join(format!("omnia-projectless-denied-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let hub = HarnessHub::open(&root).unwrap();
        std::fs::write(
            root.join("projectless_sessions"),
            "blocks directory creation",
        )
        .unwrap();
        let error = create_session(&hub, create_request("")).unwrap_err();
        assert_eq!(error.code, "projectless_storage_failed");
        assert!(hub.runtime.store().list().unwrap().is_empty());
        drop(hub);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_model_does_not_allocate_a_projectless_root() {
        let root =
            std::env::temp_dir().join(format!("omnia-projectless-input-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let hub = HarnessHub::open(&root).unwrap();
        let mut request = create_request("");
        request.model.clear();
        assert!(create_session(&hub, request).is_err());
        assert!(!root.join("projectless_sessions").exists());
        assert!(hub.runtime.store().list().unwrap().is_empty());
        drop(hub);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn projectless_runtime_workspace_never_uses_an_arbitrary_persisted_cwd() {
        let root =
            std::env::temp_dir().join(format!("omnia-projectless-scope-{}", uuid::Uuid::new_v4()));
        let data = root.join("data");
        let arbitrary = root.join("arbitrary-user-folder");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&arbitrary).unwrap();
        let hub = HarnessHub::open(&data).unwrap();
        let session = create_session(&hub, create_request("")).unwrap();
        hub.runtime
            .store()
            .update_summary(&session.id, |summary| {
                summary.cwd = arbitrary.to_string_lossy().into_owned()
            })
            .unwrap();
        let workspace = hub.session_workspace(&session.id).unwrap();
        assert_ne!(workspace, dunce::canonicalize(arbitrary).unwrap());
        assert!(
            workspace.starts_with(dunce::canonicalize(data.join("projectless_sessions")).unwrap())
        );
        drop(hub);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn projectless_fork_keeps_scope_but_allocates_a_separate_scratch_root() {
        let root =
            std::env::temp_dir().join(format!("omnia-projectless-fork-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let hub = HarnessHub::open(&root).unwrap();
        let original = create_session(&hub, create_request("")).unwrap();
        let fork = fork_session(
            &hub,
            AgentForkRequest {
                session_id: original.id.clone(),
                keep: None,
            },
        )
        .unwrap();
        assert_eq!(fork.scope, SessionScope::Projectless);
        assert_eq!(fork.parent_id.as_deref(), Some(original.id.as_str()));
        assert_ne!(fork.cwd, original.cwd);
        assert!(Path::new(&fork.cwd).is_dir());
        assert_eq!(
            read_session(
                &hub,
                AgentSessionRef {
                    session_id: fork.id.clone()
                }
            )
            .unwrap()
            .summary
            .scope,
            SessionScope::Projectless
        );
        drop(hub);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn projectless_workspace_rejects_path_traversal_before_creating_storage() {
        let root = std::env::temp_dir().join(format!(
            "omnia-projectless-traversal-{}",
            uuid::Uuid::new_v4()
        ));
        let error = projectless_workspace(&root, "../outside").unwrap_err();
        assert_eq!(error.code, "invalid_input");
        assert!(!root.exists());
    }

    #[test]
    fn user_input_requires_explicit_answer_and_keeps_null_as_cancel() {
        let omitted = serde_json::from_value::<AgentUserInputRequest>(json!({
            "sessionId": "session-a",
            "requestId": "question-a"
        }));
        assert!(
            omitted.is_err(),
            "missing answer must not become an implicit cancel"
        );

        let cancelled = serde_json::from_value::<AgentUserInputRequest>(json!({
            "sessionId": "session-a",
            "requestId": "question-a",
            "answer": null
        }))
        .unwrap();
        assert_eq!(cancelled.answer, Some(None));

        let answered = serde_json::from_value::<AgentUserInputRequest>(json!({
            "sessionId": "session-a",
            "requestId": "question-a",
            "runId": "run-a",
            "answer": "Workspace"
        }))
        .unwrap();
        assert_eq!(answered.answer, Some(Some("Workspace".into())));
        assert_eq!(answered.run_id.as_deref(), Some("run-a"));

        let extra = serde_json::from_value::<AgentUserInputRequest>(json!({
            "sessionId": "session-a",
            "requestId": "question-a",
            "answer": null,
            "unexpected": true
        }));
        assert!(extra.is_err(), "unknown request fields must be rejected");
    }

    #[tokio::test]
    async fn user_input_request_and_resolution_are_durable_store_events() {
        let (root, hub, _) = rewind_failure_fixture();
        let store = Arc::clone(hub.runtime.store());
        let broker = QuestionBroker::new(
            "s1".into(),
            "run-a".into(),
            omnia_harness::CancellationToken::new(),
            Arc::new(move |event| {
                store
                    .append_event("s1", &event)
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            }),
        );
        let input = omnia_harness::user_input::QuestionInput {
            prompt: "Choose a scope".into(),
            options: vec!["Workspace".into(), "File".into()],
            recommended: vec!["Workspace".into()],
        };
        let (pending, receiver) = broker.begin("tool-a", input).unwrap();
        broker
            .answer(&pending.id, Some("run-a"), Some("File".into()))
            .unwrap();
        assert_eq!(receiver.await.unwrap(), Some("File".into()));

        let replay = hub.runtime.store().replay("s1").unwrap();
        assert_eq!(replay.events.len(), 2);
        assert_eq!(replay.events[0].event["type"], "ask_user");
        assert_eq!(replay.events[1].event["type"], "ask_user_resolved");
        assert_eq!(replay.events[1].event["status"], "answered");
        assert_eq!(replay.events[1].event["answer"], "File");
        // HarnessHub::open stores the SQLite database at
        // `<app_data_dir>/harness.sqlite3`; reopening the app-data directory
        // itself asks SQLite to treat a directory as a database file and
        // produces the misleading `harness_storage_failed` fixture failure.
        let data = root.join("data/harness.sqlite3");
        drop(broker);
        drop(hub);
        let reopened = HarnessStore::open(&data).unwrap();
        let reloaded = reopened.replay("s1").unwrap();
        assert_eq!(reloaded.events.len(), 2);
        assert_eq!(reloaded.events[1].event["requestId"], pending.id);
        drop(reopened);
        let _ = std::fs::remove_dir_all(root);
    }

    struct RealChildUsageProvider {
        mode: u8,
        calls: Arc<AtomicUsize>,
    }
    #[async_trait]
    impl omnia_harness::Provider for RealChildUsageProvider {
        fn id(&self) -> &str {
            "real-child-usage"
        }
        async fn stream(
            &self,
            _: omnia_harness::ProviderRequest,
        ) -> omnia_harness::HarnessResult<omnia_harness::ProviderStream> {
            use futures_util::StreamExt;
            use omnia_harness::{StopReason, StreamEvent, Usage};
            self.calls.fetch_add(1, Ordering::SeqCst);
            let events = futures_util::stream::iter([
                Ok(StreamEvent::ThinkingDelta {
                    text: "private thinking delta".into(),
                }),
                Ok(StreamEvent::TextDelta {
                    text: "child final report".into(),
                }),
                Ok(StreamEvent::Usage {
                    usage: Usage {
                        input_tokens: 30,
                        output_tokens: 10,
                        ..Usage::default()
                    },
                }),
            ]);
            let tail: omnia_harness::ProviderStream = match self.mode {
                0 => Box::pin(futures_util::stream::iter([Ok(StreamEvent::Stop {
                    reason: StopReason::EndTurn,
                })])),
                1 => Box::pin(futures_util::stream::once(async {
                    Err(HarnessError::Provider {
                        status: Some(503),
                        message: "after child usage".into(),
                        retryable: true,
                    })
                })),
                _ => Box::pin(futures_util::stream::pending()),
            };
            Ok(Box::pin(events.chain(tail)))
        }
    }

    #[tokio::test]
    async fn observed_real_task_child_usage_reaches_ledger_and_durable_parent_for_success_error_and_cancel(
    ) {
        use omnia_harness::{StreamEvent, Tool};
        use std::sync::atomic::AtomicU64;
        for mode in 0..3 {
            let (root, hub, _) = rewind_failure_fixture();
            hub.runtime
                .store()
                .update_summary("s1", |summary| summary.tokens_used = 60)
                .unwrap();
            let mut ctx = ToolContext::new(&root);
            ctx.tool_use_id = "real-parent-task".into();
            ctx.token_budget = Some(omnia_harness::TokenBudgetLedger::new(Some(100), 60));
            let total = Arc::new(AtomicU64::new(0));
            let log = Arc::new(std::sync::Mutex::new(Vec::<AgentEvent>::new()));
            let calls = Arc::new(AtomicUsize::new(0));
            let cancel = ctx.cancel.clone();
            let sink_total = total.clone();
            let sink_log = log.clone();
            let task = TaskTool {
                provider: Arc::new(RealChildUsageProvider {
                    mode,
                    calls: calls.clone(),
                }),
                config: AgentConfig {
                    model: "test".into(),
                    compact_threshold: 0.0,
                    max_retries: 3,
                    fallback_models: vec!["backup".into()],
                    ..AgentConfig::default()
                },
                tools: ToolRegistry::default(),
                policy: Arc::new(Mutex::new(PermissionPolicy::new(PermissionMode::Full))),
                approver: Arc::new(omnia_harness::agent::AutoApprove),
                events: Arc::new(move |event: AgentEvent| {
                    let observed = observed_spend(&event);
                    record_observed_spend(&sink_total, &event);
                    sink_log.lock().unwrap().push(event);
                    if mode == 2 && observed != 0 {
                        cancel.cancel();
                    }
                }),
                agents: subagent::builtin_agents(),
                hooks: None,
                current_depth: 0,
                max_depth: omnia_harness::subagent::DEFAULT_MAX_SUBAGENT_DEPTH,
            };
            let result = task
                .call(
                    &ctx,
                    json!({"description":"usage fixture", "prompt":"report"}),
                )
                .await;
            match mode {
                0 => assert!(!result.unwrap().is_error),
                1 => assert!(result.unwrap().is_error),
                _ => assert!(matches!(result, Err(HarnessError::Cancelled))),
            }
            assert_eq!(
                calls.load(Ordering::SeqCst),
                1,
                "child usage prevents retry/fallback"
            );
            assert_eq!(ctx.token_budget.as_ref().unwrap().snapshot().used, 100);
            assert_eq!(total.load(Ordering::SeqCst), 40);
            let events = log.lock().unwrap();
            assert_eq!(events.iter().filter(|event| matches!(event,
                AgentEvent::Subagent { parent_id, event } if parent_id == "real-parent-task"
                && matches!(event.as_ref(), AgentEvent::Stream { event: StreamEvent::Usage { .. } }))).count(), 1);
            assert!(!events.iter().any(|event| matches!(event,
                AgentEvent::Subagent { event, .. } if matches!(event.as_ref(),
                    AgentEvent::Stream { event } if !matches!(event, StreamEvent::Usage { .. })))));
            drop(events);
            let history = hub.runtime.store().messages("s1").unwrap();
            persist_run_snapshot(hub.runtime.store(), "s1", &history, Vec::new(), &total).unwrap();
            assert_eq!(total.load(Ordering::SeqCst), 0);
            assert_eq!(hub.runtime.store().summary("s1").unwrap().tokens_used, 100);
            drop(hub);
            let reopened = HarnessHub::open(&root.join("data")).unwrap();
            let used = reopened.store().summary("s1").unwrap().tokens_used;
            assert!(matches!(
                omnia_harness::TokenBudgetLedger::new(Some(100), used).admit(),
                Err(HarnessError::BudgetExceeded {
                    used: 100,
                    budget: 100
                })
            ));
            drop(reopened);
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn observed_snapshot_storage_failure_preserves_spend_and_retry_never_charges_twice() {
        use std::sync::atomic::AtomicU64;
        for fail_summary in [false, true] {
            let (root, hub, _) = rewind_failure_fixture();
            hub.runtime
                .store()
                .update_summary("s1", |summary| summary.tokens_used = 60)
                .unwrap();
            let connection = rusqlite::Connection::open(root.join("data/harness.sqlite3")).unwrap();
            connection.execute_batch(if fail_summary {
                "CREATE TRIGGER reject_snapshot BEFORE UPDATE ON agent_sessions BEGIN SELECT RAISE(FAIL, 'summary fixture'); END;"
            } else {
                "CREATE TRIGGER reject_snapshot BEFORE INSERT ON agent_messages BEGIN SELECT RAISE(FAIL, 'message fixture'); END;"
            }).unwrap();
            let history = hub.runtime.store().messages("s1").unwrap();
            let total = AtomicU64::new(40);
            for _ in 0..2 {
                let error =
                    persist_run_snapshot(hub.runtime.store(), "s1", &history, Vec::new(), &total)
                        .unwrap_err();
                assert!(error.message.contains(if fail_summary {
                    "spend could not be saved"
                } else {
                    "spend was saved"
                }));
                assert_eq!(
                    hub.runtime.store().summary("s1").unwrap().tokens_used,
                    if fail_summary { 60 } else { 100 }
                );
                assert_eq!(
                    total.load(Ordering::SeqCst),
                    if fail_summary { 40 } else { 0 }
                );
                assert_eq!(
                    hub.runtime.store().messages("s1").unwrap().len(),
                    history.len()
                );
            }
            connection
                .execute_batch("DROP TRIGGER reject_snapshot;")
                .unwrap();
            persist_run_snapshot(hub.runtime.store(), "s1", &history, Vec::new(), &total).unwrap();
            assert_eq!(hub.runtime.store().summary("s1").unwrap().tokens_used, 100);
            assert_eq!(total.load(Ordering::SeqCst), 0);
            drop(connection);
            drop(hub);
            let reopened = HarnessHub::open(&root.join("data")).unwrap();
            assert_eq!(reopened.store().summary("s1").unwrap().tokens_used, 100);
            drop(reopened);
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn observed_spend_counts_stream_deltas_recursively_without_completed_double_count() {
        use omnia_harness::{StopReason, StreamEvent, Usage};
        use std::sync::atomic::{AtomicU64, Ordering};
        let usage = Usage {
            input_tokens: 30,
            output_tokens: 10,
            ..Usage::default()
        };
        let stream = AgentEvent::Stream {
            event: StreamEvent::Usage { usage },
        };
        let total = AtomicU64::new(60);
        record_observed_spend(&total, &stream);
        record_observed_spend(
            &total,
            &AgentEvent::TurnCompleted {
                turn: 1,
                usage,
                stop: StopReason::EndTurn,
                duration_ms: None,
                ttft_ms: None,
            },
        );
        assert_eq!(total.load(Ordering::SeqCst), 100);
        record_observed_spend(
            &total,
            &AgentEvent::Subagent {
                parent_id: "outer".into(),
                event: Box::new(AgentEvent::Subagent {
                    parent_id: "inner".into(),
                    event: Box::new(stream),
                }),
            },
        );
        assert_eq!(total.load(Ordering::SeqCst), 140);
        record_observed_spend(
            &total,
            &AgentEvent::Error {
                message: "failed after usage".into(),
            },
        );
        assert_eq!(total.load(Ordering::SeqCst), 140);
        // A failed/interrupted run persists this same total; there is no
        // successful-turn fallback that could omit or duplicate observed spend.
        let mut persisted_session = 500u64;
        persisted_session = persisted_session.saturating_add(total.load(Ordering::SeqCst));
        assert_eq!(persisted_session, 640);
        let resumed = omnia_harness::TokenBudgetLedger::new(Some(640), persisted_session);
        assert!(matches!(
            resumed.admit(),
            Err(HarnessError::BudgetExceeded {
                used: 640,
                budget: 640
            })
        ));
    }

    #[test]
    fn observed_spend_saturates_delta_and_session_run_totals() {
        use omnia_harness::{StreamEvent, Usage};
        use std::sync::atomic::{AtomicU64, Ordering};
        let total = AtomicU64::new(u64::MAX - 1);
        let event = AgentEvent::Stream {
            event: StreamEvent::Usage {
                usage: Usage {
                    input_tokens: u64::MAX,
                    output_tokens: u64::MAX,
                    ..Usage::default()
                },
            },
        };
        record_observed_spend(&total, &event);
        assert_eq!(total.load(Ordering::SeqCst), u64::MAX);
        record_observed_spend(&total, &event);
        assert_eq!(total.load(Ordering::SeqCst), u64::MAX);
    }

    #[test]
    fn observed_failed_run_spend_persists_and_seeds_resumed_budget() {
        use omnia_harness::{StreamEvent, Usage};
        use std::sync::atomic::{AtomicU64, Ordering};
        let (root, hub, _) = rewind_failure_fixture();
        hub.runtime
            .store()
            .update_summary("s1", |summary| summary.tokens_used = 60)
            .unwrap();
        let total = AtomicU64::new(0);
        record_observed_spend(
            &total,
            &AgentEvent::Subagent {
                parent_id: "failed-child".into(),
                event: Box::new(AgentEvent::Stream {
                    event: StreamEvent::Usage {
                        usage: Usage {
                            input_tokens: 30,
                            output_tokens: 10,
                            ..Usage::default()
                        },
                    },
                }),
            },
        );
        record_observed_spend(
            &total,
            &AgentEvent::Error {
                message: "interrupted after usage".into(),
            },
        );
        let spent = total.load(Ordering::SeqCst);
        hub.runtime
            .store()
            .update_summary("s1", |summary| {
                summary.tokens_used = summary.tokens_used.saturating_add(spent)
            })
            .unwrap();
        drop(hub);
        let reopened = HarnessHub::open(&root.join("data")).unwrap();
        let used = reopened.store().summary("s1").unwrap().tokens_used;
        assert_eq!(used, 100);
        let resumed = omnia_harness::TokenBudgetLedger::new(Some(100), used);
        assert!(matches!(
            resumed.admit(),
            Err(HarnessError::BudgetExceeded {
                used: 100,
                budget: 100
            })
        ));
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rewind_ambiguous_history_preserves_archives_and_allows_safe_continuation() {
        for legacy in [true, false] {
            let (root, hub, file) = rewind_failure_fixture();
            let dir = hub.checkpoint_dir("s1").unwrap();
            let manifest_path = dir.join("manifest.json");
            if legacy {
                // The old pre-push length can name an assistant after a merged
                // user prompt. Preserve its exact bytes instead of guessing.
                let manifest: Value =
                    serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
                let record = manifest["checkpoints"]
                    .as_object()
                    .unwrap()
                    .values()
                    .next()
                    .unwrap()
                    .clone();
                std::fs::write(
                    &manifest_path,
                    serde_json::to_vec(&json!({"checkpoints": {"3": record}})).unwrap(),
                )
                .unwrap();
            } else {
                // A crash can persist a steer boundary ahead of SQLite.
                let checkpoints = CheckpointStore::open(&dir).unwrap();
                checkpoints.begin_boundary(8).unwrap();
            }
            let original = std::fs::read(&manifest_path).unwrap();
            let current_bytes = std::fs::read(&file).unwrap();
            assert!(hub.rewind("s1", 0, true).is_err());
            assert_eq!(std::fs::read(&manifest_path).unwrap(), original);
            assert_eq!(hub.runtime.store().messages("s1").unwrap().len(), 4);
            assert_eq!(std::fs::read(&file).unwrap(), current_bytes);

            let result = hub.rewind("s1", 2, false).unwrap();
            assert!(result
                .checkpoint_recovery_notice
                .as_deref()
                .is_some_and(|note| note.contains("preserved")));
            assert_eq!(result.detail.messages.len(), 2);
            let backups: Vec<_> = std::fs::read_dir(dir.join("recovery"))
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect();
            assert_eq!(backups.len(), 1);
            assert_eq!(std::fs::read(&backups[0]).unwrap(), original);
            assert!(hub.rewind("s1", 0, true).is_err());

            // A fresh durable boundary can track later edits without granting
            // the quarantined records a guessed position in the new history.
            let mut history = hub.runtime.store().messages("s1").unwrap();
            history.push(Message::user("later turn"));
            history.push(Message::assistant(vec![Block::text("later reply")]));
            hub.runtime
                .store()
                .write_messages("s1", &history, 0)
                .unwrap();
            let checkpoints = Arc::new(CheckpointStore::open(&dir).unwrap());
            let scope = CheckpointScope::begin(checkpoints.clone(), &history, 2).unwrap();
            assert!(scope.recovery_note().is_some());
            checkpoints.record_before(scope.key(), &file).unwrap();
            std::fs::write(&file, "newer tracked edit").unwrap();
            drop(scope);
            drop(checkpoints);
            let restored = hub.rewind("s1", 2, true).unwrap();
            assert!(restored.file_restore.unwrap().failed.is_empty());
            assert_eq!(std::fs::read(&file).unwrap(), current_bytes);
            assert_eq!(std::fs::read(&backups[0]).unwrap(), original);
            assert!(hub.rewind("s1", 0, true).is_err());
            hub.rewind("s1", 0, false).unwrap();
            assert_eq!(std::fs::read(&backups[0]).unwrap(), original);
            drop(hub);
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    struct CountingTool(Arc<AtomicUsize>);
    #[async_trait]
    impl omnia_harness::Tool for CountingTool {
        fn spec(&self) -> omnia_harness::ToolSpec {
            omnia_harness::ToolSpec {
                name: "count".into(),
                description: "fixture".into(),
                input_schema: json!({"type":"object"}),
            }
        }
        fn effect(&self) -> omnia_harness::EffectClass {
            omnia_harness::EffectClass::WriteWorkspace
        }
        async fn call(
            &self,
            _: &ToolContext,
            _: Value,
        ) -> omnia_harness::HarnessResult<omnia_harness::ToolOutput> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(omnia_harness::ToolOutput::text("called"))
        }
    }

    fn rewind_failure_fixture() -> (PathBuf, HarnessHub, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("omnia-rewind-errors-{}", uuid::Uuid::new_v4()));
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(root.join("data")).unwrap();
        let hub = HarnessHub::open(&root.join("data")).unwrap();
        let now = now_ms();
        hub.runtime
            .store()
            .save_summary(&AgentSessionSummary {
                id: "s1".into(),
                title: "t".into(),
                scope: SessionScope::Project,
                cwd: work.to_string_lossy().into_owned(),
                profile_id: "p".into(),
                model: "m".into(),
                permission_mode: PermissionMode::Full,
                rules: Vec::new(),
                reasoning_effort: None,
                fallback_models: Vec::new(),
                token_budget: None,
                tokens_used: 0,
                system_prompt: None,
                parent_id: None,
                settings_revision: 1,
                message_count: 0,
                created_at_ms: now,
                updated_at_ms: now,
            })
            .unwrap();
        let msg = |role, text: &str| Message {
            role,
            content: vec![Block::text(text)],
        };
        hub.runtime
            .store()
            .write_messages(
                "s1",
                &[
                    msg(omnia_harness::Role::User, "one"),
                    msg(omnia_harness::Role::Assistant, "a"),
                    msg(omnia_harness::Role::User, "two"),
                    msg(omnia_harness::Role::Assistant, "b"),
                ],
                0,
            )
            .unwrap();
        let file = work.join("f.txt");
        std::fs::write(&file, "old").unwrap();
        let checkpoints = CheckpointStore::open(hub.checkpoint_dir("s1").unwrap()).unwrap();
        checkpoints
            .prepare_history(&hub.runtime.store().messages("s1").unwrap())
            .unwrap();
        let key = checkpoints.begin_boundary(2).unwrap();
        checkpoints.record_before(key, &file).unwrap();
        std::fs::write(&file, "new").unwrap();
        (root, hub, file)
    }

    #[test]
    fn rewind_keeps_conversation_when_checkpoint_manifest_cannot_be_saved() {
        for restore_files in [false, true] {
            let (root, hub, file) = rewind_failure_fixture();
            let dir = hub.checkpoint_dir("s1").unwrap();
            let expected_ids = CheckpointStore::open(&dir).unwrap().checkpoint_ids();
            assert_eq!(expected_ids.len(), 1);
            let blocker = dir.join("manifest.tmp");
            std::fs::create_dir(&blocker).unwrap();

            let error = hub
                .rewind("s1", 2, restore_files)
                .expect_err("rewind must report checkpoint persistence failure");
            assert_eq!(
                error.code,
                if restore_files {
                    "checkpoint_restore_failed"
                } else {
                    "checkpoint_store_failed"
                }
            );
            assert!(error.message.contains("Conversation was kept"));
            assert_eq!(hub.runtime.store().messages("s1").unwrap().len(), 4);
            assert_eq!(hub.runtime.store().summary("s1").unwrap().message_count, 4);
            let checkpoints = CheckpointStore::open(&dir).unwrap();
            assert_eq!(checkpoints.checkpoint_ids(), expected_ids);
            assert_eq!(std::fs::read_dir(dir.join("blobs")).unwrap().count(), 1);
            assert_eq!(
                std::fs::read_to_string(&file).unwrap(),
                if restore_files { "old" } else { "new" }
            );
            drop(checkpoints);

            std::fs::remove_dir(blocker).unwrap();
            let retried = hub.rewind("s1", 2, restore_files).unwrap();
            assert_eq!(retried.detail.messages.len(), 2);
            assert!(CheckpointStore::open(&dir)
                .unwrap()
                .checkpoint_ids()
                .is_empty());
            drop(hub);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn rewind_keeps_conversation_when_checkpoint_store_cannot_open() {
        let (root, hub, file) = rewind_failure_fixture();
        let dir = hub.checkpoint_dir("s1").unwrap();
        std::fs::rename(dir.join("blobs"), dir.join("saved-blobs")).unwrap();
        std::fs::write(dir.join("blobs"), "blocker").unwrap();

        let error = hub
            .rewind("s1", 2, false)
            .expect_err("rewind must report checkpoint open failure");
        assert_eq!(error.code, "checkpoint_store_failed");
        assert_eq!(hub.runtime.store().messages("s1").unwrap().len(), 4);
        assert_eq!(hub.runtime.store().summary("s1").unwrap().message_count, 4);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");

        std::fs::remove_file(dir.join("blobs")).unwrap();
        std::fs::rename(dir.join("saved-blobs"), dir.join("blobs")).unwrap();
        let retried = hub.rewind("s1", 2, false).unwrap();
        assert_eq!(retried.detail.messages.len(), 2);
        assert!(CheckpointStore::open(&dir)
            .unwrap()
            .checkpoint_ids()
            .is_empty());
        drop(hub);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rewind_keeps_conversation_after_partial_file_restore_failure() {
        let (root, hub, file) = rewind_failure_fixture();
        let dir = hub.checkpoint_dir("s1").unwrap();
        let other = file.with_file_name("other.txt");
        std::fs::write(&other, "other old").unwrap();
        let checkpoints = CheckpointStore::open(&dir).unwrap();
        let key = checkpoints.checkpoint_ids()[0];
        checkpoints.record_before(key, &other).unwrap();
        std::fs::write(&other, "other new").unwrap();
        drop(checkpoints);
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();

        let error = hub
            .rewind("s1", 2, true)
            .expect_err("rewind must report partial restore failure");
        assert_eq!(error.code, "checkpoint_restore_failed");
        assert!(error.message.contains("Conversation was kept"));
        assert!(error
            .message
            .contains("Some files may already have been restored"));
        assert_eq!(hub.runtime.store().messages("s1").unwrap().len(), 4);
        assert_eq!(hub.runtime.store().summary("s1").unwrap().message_count, 4);
        assert_eq!(std::fs::read_to_string(&other).unwrap(), "other old");
        assert_eq!(
            CheckpointStore::open(&dir).unwrap().checkpoint_ids(),
            vec![key]
        );

        std::fs::remove_dir(&file).unwrap();
        let retried = hub.rewind("s1", 2, true).unwrap();
        assert_eq!(retried.detail.messages.len(), 2);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "old");
        assert!(CheckpointStore::open(&dir)
            .unwrap()
            .checkpoint_ids()
            .is_empty());
        drop(hub);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rewind_can_restore_files_and_conversation_only_forgets_records() {
        let root = std::env::temp_dir().join(format!("omnia-rewind-{}", uuid::Uuid::new_v4()));
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(root.join("data")).unwrap();
        let hub = HarnessHub::open(&root.join("data")).unwrap();
        let now = now_ms();
        hub.runtime
            .store()
            .save_summary(&AgentSessionSummary {
                id: "s1".into(),
                title: "t".into(),
                scope: SessionScope::Project,
                cwd: work.to_string_lossy().into_owned(),
                profile_id: "p".into(),
                model: "m".into(),
                permission_mode: PermissionMode::Full,
                rules: Vec::new(),
                reasoning_effort: None,
                fallback_models: Vec::new(),
                token_budget: None,
                tokens_used: 0,
                system_prompt: None,
                parent_id: None,
                settings_revision: 1,
                message_count: 0,
                created_at_ms: now,
                updated_at_ms: now,
            })
            .unwrap();
        let msg = |role, text: &str| Message {
            role,
            content: vec![Block::text(text)],
        };
        let history = vec![
            msg(omnia_harness::Role::User, "one"),
            msg(omnia_harness::Role::Assistant, "a"),
            msg(omnia_harness::Role::User, "two"),
            msg(omnia_harness::Role::Assistant, "b"),
        ];
        hub.runtime
            .store()
            .write_messages("s1", &history, 0)
            .unwrap();

        let file = work.join("f.txt");
        std::fs::write(&file, "old").unwrap();
        let checkpoints = CheckpointStore::open(hub.checkpoint_dir("s1").unwrap()).unwrap();
        checkpoints
            .prepare_history(&hub.runtime.store().messages("s1").unwrap())
            .unwrap();
        let key = checkpoints.begin_boundary(2).unwrap();
        checkpoints.record_before(key, &file).unwrap();
        std::fs::write(&file, "new").unwrap();
        drop(checkpoints);

        // Conversation only: files stay, and the stale record is forgotten.
        let result = hub.rewind("s1", 2, false).unwrap();
        assert!(result.file_restore.is_none());
        assert_eq!(result.detail.messages.len(), 2);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
        let again = hub.rewind("s1", 0, true).unwrap();
        assert!(again.file_restore.unwrap().restored.is_empty());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");

        // With files: rewind to before the second turn restores the file.
        hub.runtime
            .store()
            .write_messages("s1", &history, 0)
            .unwrap();
        let checkpoints = CheckpointStore::open(hub.checkpoint_dir("s1").unwrap()).unwrap();
        checkpoints
            .prepare_history(&hub.runtime.store().messages("s1").unwrap())
            .unwrap();
        let key = checkpoints.begin_boundary(2).unwrap();
        checkpoints.record_before(key, &file).unwrap();
        std::fs::write(&file, "newer").unwrap();
        drop(checkpoints);
        let result = hub.rewind("s1", 2, true).unwrap();
        let report = result.file_restore.unwrap();
        assert_eq!(report.restored.len(), 1);
        assert!(report.untracked_note.contains("shell"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
        assert_eq!(result.detail.messages.len(), 2);

        assert!(hub.rewind("../evil", 0, true).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn approval_is_answerable_as_soon_as_it_is_published() {
        let approvals: Arc<DashMap<String, oneshot::Sender<ApprovalDecision>>> =
            Arc::new(DashMap::new());
        let channels = Arc::clone(&approvals);
        let events: Arc<dyn EventSink> = Arc::new(move |event: AgentEvent| {
            if let AgentEvent::ApprovalRequested { request } = event {
                let (_, sender) = channels
                    .remove(&request.tool_use_id)
                    .expect("sender installed before request");
                sender.send(ApprovalDecision::AllowOnce).unwrap();
            }
        });
        let approver = ChannelApprover {
            approvals: Arc::clone(&approvals),
            queued: Arc::default(),
            batch: Arc::default(),
            events,
            cancel: omnia_harness::CancellationToken::new(),
        };
        let decision = approver
            .request(ApprovalRequest {
                tool_use_id: "fixture-call".into(),
                tool: "fixture-tool".into(),
                input: json!({}),
                summary: "fixture".into(),
                ordinal: 1,
                total: 1,
                remaining: Vec::new(),
            })
            .await;
        assert_eq!(decision, ApprovalDecision::AllowOnce);
        assert!(approvals.is_empty());
    }

    #[tokio::test]
    async fn journal_failure_cancellation_blocks_tool_side_effect() {
        let calls = Arc::new(AtomicUsize::new(0));
        let tool = JournalGatedTool(Arc::new(CountingTool(Arc::clone(&calls))));
        let ctx = ToolContext::new(".");
        ctx.cancel.cancel();
        use omnia_harness::Tool;
        assert!(matches!(
            tool.call(&ctx, json!({})).await,
            Err(HarnessError::Cancelled)
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

/// Native folder picker for choosing a session's working directory.
#[tauri::command]
pub async fn agent_pick_folder(app: AppHandle) -> NativeResult<Option<String>> {
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("Choose a folder for the agent to work in")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|_| {
        NativeError::new(
            "unsupported_folder_reference",
            "The selected folder cannot be represented as a local path",
        )
    })?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTrustRequest {
    pub cwd: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTrustSetRequest {
    pub cwd: String,
    pub fingerprint: String,
    pub trusted: bool,
}

#[tauri::command]
pub fn agent_workspace_trust_status(
    hub: State<'_, HarnessHub>,
    request: WorkspaceTrustRequest,
) -> NativeResult<trust::WorkspaceTrust> {
    ConfigSnapshot::capture(&validate_cwd(&request.cwd)?, omnia_home().as_deref())?
        .status(hub.runtime.store())
}

#[tauri::command]
pub async fn agent_workspace_trust_set(
    hub: State<'_, HarnessHub>,
    request: WorkspaceTrustSetRequest,
) -> NativeResult<trust::WorkspaceTrust> {
    let cwd = validate_cwd(&request.cwd)?;
    let snapshot = ConfigSnapshot::capture(&cwd, omnia_home().as_deref())?;
    let status = snapshot.status(hub.runtime.store())?;
    if request.trusted && status.fingerprint != request.fingerprint {
        return Err(NativeError::new(
            "workspace_config_changed",
            "Configuration changed since review; review its new fingerprint",
        ));
    }
    hub.runtime.store().set_workspace_trust(
        &status.cwd,
        request.trusted.then_some(status.fingerprint.as_str()),
    )?;
    if !request.trusted {
        for session in hub.runtime.store().list()? {
            if session_workspace(&session, &hub.projectless_root).is_ok_and(|path| path == cwd) {
                hub.services.retire(&session.id);
            }
        }
        for run in hub.runtime.runs().snapshot()? {
            if run.cwd == cwd {
                run.cancel.cancel();
                run.approvals.clear();
            }
        }
        if let Some((_, manager)) = hub.mcp.lock().await.remove(&cwd) {
            manager.shutdown().await;
        }
    }
    snapshot.status(hub.runtime.store())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpRequest {
    pub session_id: String,
}

/// Passive installed-connector evidence; never starts a process or tests login.
#[tauri::command]
pub fn agent_plugin_connection_receipts(
    hub: State<'_, HarnessHub>,
    request: AgentMcpRequest,
) -> NativeResult<Vec<crate::plugin_connections::PluginConnectionReceipt>> {
    let id = require_id(&request.session_id, "sessionId")?;
    let cwd = hub.session_workspace(&id)?;
    ConfigSnapshot::capture(&cwd, omnia_home().as_deref())?
        .plugin_connection_receipts(hub.runtime.store())
}

/// Passive connection state. This command never starts or refreshes a process.
#[tauri::command]
pub async fn agent_mcp_status(
    hub: State<'_, HarnessHub>,
    request: AgentMcpRequest,
) -> NativeResult<Vec<McpServerStatus>> {
    let id = require_id(&request.session_id, "sessionId")?;
    let cwd = hub.session_workspace(&id)?;
    let snapshot = ConfigSnapshot::capture(&cwd, omnia_home().as_deref())?;
    snapshot.require_trust(hub.runtime.store())?;
    let servers = hub.mcp.lock().await;
    Ok(servers
        .get(&cwd)
        .filter(|(key, _)| key == snapshot.cache_key())
        .map(|(_, manager)| manager.status())
        .unwrap_or_default())
}

/// Disconnects and restarts the session folder's MCP servers, re-reading
/// their config files.
#[tauri::command]
pub async fn agent_mcp_reload(
    hub: State<'_, HarnessHub>,
    request: AgentMcpRequest,
) -> NativeResult<Vec<McpServerStatus>> {
    let id = require_id(&request.session_id, "sessionId")?;
    let cwd = hub.session_workspace(&id)?;
    let previous = hub.mcp.lock().await.remove(&cwd);
    if let Some((_, previous)) = previous {
        previous.shutdown().await;
    }
    let snapshot = ConfigSnapshot::capture(&cwd, omnia_home().as_deref())?;
    Ok(mcp_for(&hub.mcp, &snapshot, hub.runtime.store())
        .await?
        .status())
}

// ---- custom slash commands -------------------------------------------------

/// Expands `/name args` when `name` is a discovered custom command; otherwise
/// returns the text unchanged.
fn expand_custom_command(
    cwd: &Path,
    text: &str,
    plugins: &[omnia_harness::plugins::Plugin],
) -> String {
    if !text.trim_start().starts_with('/') {
        return text.to_owned();
    }
    let commands = omnia_harness::commands::discover_commands_with_plugins(
        cwd,
        &user_dirs("commands"),
        &plugin_dirs_of(plugins, "commands"),
    );
    omnia_harness::commands::expand(text, &commands).unwrap_or_else(|| text.to_owned())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandInfo {
    pub name: String,
    pub description: String,
    pub argument_hint: String,
}

#[tauri::command]
pub fn agent_commands_list(
    hub: State<'_, HarnessHub>,
    request: AgentMcpRequest,
) -> NativeResult<Vec<AgentCommandInfo>> {
    let id = require_id(&request.session_id, "sessionId")?;
    let cwd = hub.session_workspace(&id)?;
    let plugins = session_plugins(&cwd, hub.runtime.store());
    Ok(omnia_harness::commands::discover_commands_with_plugins(
        &cwd,
        &user_dirs("commands"),
        &plugin_dirs_of(&plugins, "commands"),
    )
    .into_iter()
    .map(|command| AgentCommandInfo {
        name: command.name,
        description: command.description,
        argument_hint: command.argument_hint,
    })
    .collect())
}

// ---- skills and subagent catalog ------------------------------------------

/// Renderer-safe projection of a discovered `SKILL.md`. The full body remains
/// available only through the harness `skill` tool, so listing capabilities
/// does not inject a large prompt or expose instructions unnecessarily.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillInfo {
    pub name: String,
    pub description: String,
    pub source: skills::SkillSource,
    pub path: String,
    pub directory: String,
}

/// Renderer-safe projection of a discovered subagent definition. The prompt
/// is intentionally omitted: it is composed into the child context only when
/// the `task` tool starts that role.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinitionInfo {
    pub name: String,
    pub description: String,
    pub tools: Option<Vec<String>>,
    pub model: Option<String>,
    pub read_only: bool,
}

/// Lists the skills visible to a session after applying the same project,
/// user, plugin and trust precedence used by an actual agent run.
#[tauri::command]
pub fn agent_skills_list(
    hub: State<'_, HarnessHub>,
    request: AgentMcpRequest,
) -> NativeResult<Vec<AgentSkillInfo>> {
    let id = require_id(&request.session_id, "sessionId")?;
    let cwd = hub.session_workspace(&id)?;
    let plugins = session_plugins(&cwd, hub.runtime.store());
    Ok(skills::discover_skills_with_plugins(
        &cwd,
        &user_dirs("skills"),
        &plugin_dirs_of(&plugins, "skills"),
    )
    .into_iter()
    .map(|skill| AgentSkillInfo {
        name: skill.name,
        description: skill.description,
        source: skill.source,
        path: skill.path.to_string_lossy().into_owned(),
        directory: skill.dir.to_string_lossy().into_owned(),
    })
    .collect())
}

/// Lists the subagent roles available to the session. The same precedence and
/// plugin filtering as `task` are used, so the list is an honest preview of
/// what the next run can delegate to.
#[tauri::command]
pub fn agent_agents_list(
    hub: State<'_, HarnessHub>,
    request: AgentMcpRequest,
) -> NativeResult<Vec<AgentDefinitionInfo>> {
    let id = require_id(&request.session_id, "sessionId")?;
    let cwd = hub.session_workspace(&id)?;
    let plugins = session_plugins(&cwd, hub.runtime.store());
    Ok(subagent::discover_agents_with_plugins(
        &cwd,
        &user_dirs("agents"),
        &plugin_dirs_of(&plugins, "agents"),
    )
    .into_iter()
    .map(|agent| AgentDefinitionInfo {
        name: agent.name,
        description: agent.description,
        tools: agent.tools,
        model: agent.model,
        read_only: agent.read_only,
    })
    .collect())
}

// ---- @mention workspace file search ----------------------------------------

const WORKSPACE_WALK_CAP: usize = 20_000;
const WORKSPACE_DEFAULT_LIMIT: usize = 50;
const WORKSPACE_MAX_LIMIT: usize = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceFilesRequest {
    pub session_id: String,
    pub query: String,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub path: String,
    pub is_dir: bool,
}

/// Lower is better; `None` means the path does not match. Basename matches
/// outrank path-only matches, and within a tier prefix beats substring beats
/// subsequence. `query` must already be lowercase.
fn rank_workspace_path(path: &str, query: &str) -> Option<u32> {
    if query.is_empty() {
        return Some(0);
    }
    let lower = path.trim_end_matches('/').to_lowercase();
    let base = lower.rsplit('/').next().unwrap_or(&lower);
    if base == query {
        return Some(0);
    }
    if base.starts_with(query) {
        return Some(1);
    }
    if base.contains(query) {
        return Some(2);
    }
    if lower.contains(query) {
        return Some(3);
    }
    let mut chars = query.chars();
    let mut want = chars.next();
    for c in base.chars() {
        if Some(c) == want {
            want = chars.next();
        }
    }
    if want.is_none() {
        return Some(4);
    }
    None
}

fn search_workspace(root: &Path, query: &str, limit: usize) -> Vec<WorkspaceEntry> {
    let query = query
        .trim()
        .trim_start_matches("./")
        .replace(std::path::MAIN_SEPARATOR, "/")
        .to_lowercase();
    let mut scored: Vec<(u32, usize, WorkspaceEntry)> = Vec::new();
    let walker = ignore::WalkBuilder::new(root).follow_links(false).build();
    for (seen, entry) in walker.flatten().enumerate() {
        if seen >= WORKSPACE_WALK_CAP {
            break;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        let mut path = relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        if path.is_empty() {
            continue;
        }
        let is_dir = entry.file_type().is_some_and(|kind| kind.is_dir());
        if is_dir {
            path.push('/');
        }
        if let Some(score) = rank_workspace_path(&path, &query) {
            scored.push((score, path.len(), WorkspaceEntry { path, is_dir }));
        }
    }
    scored.sort_by(|a, b| (a.0, a.1, &a.2.path).cmp(&(b.0, b.1, &b.2.path)));
    scored.into_iter().take(limit).map(|item| item.2).collect()
}

#[tauri::command]
pub async fn agent_workspace_files(
    hub: State<'_, HarnessHub>,
    request: AgentWorkspaceFilesRequest,
) -> NativeResult<Vec<WorkspaceEntry>> {
    let id = require_id(&request.session_id, "sessionId")?;
    let cwd = hub.session_workspace(&id)?;
    let limit = request
        .limit
        .unwrap_or(WORKSPACE_DEFAULT_LIMIT)
        .clamp(1, WORKSPACE_MAX_LIMIT);
    let query = request.query;
    tokio::task::spawn_blocking(move || search_workspace(&cwd, &query, limit))
        .await
        .map_err(|error| NativeError::new("agent_workspace_search_failed", error.to_string()))
}
