//! Shared Super-Workflow Engine State (`.agents/super/engine_state.json`),
//! Unified Capability Registry, Additive Steer Queue logging, and
//! 2-Tier Global Lessons Mirror (`D:\OmniaData\memory\global_lessons.md`) used by
//! `omnia super-plan`, `omnia super-run`, `omnia super capabilities`, `omnia learn`,
//! `omnia proceed`, `omnia --mcp`, and TUI `/super-plan`, `/super-run`, `/auto-proceed`,
//! and `/learn --global`.

use anyhow::{bail, Result};
use omnia_agent::{default_omnia_data_dir, redact_secrets, PluginRegistry};
use omnia_harness::artifact_os::{ArtifactKind, ArtifactOs, LessonRecord};
use omnia_harness::research_vault::atomic_write_with_retry;
use omnia_harness::skill_registry::SkillRegistry;
use omnia_workspace_ops::hardware::collect_host_system_snapshot;
use omnia_workspace_ops::net_diag::{
    build_dns_a_query, parse_dns_a_response, percentile, rfc3550_jitter_ms, EndpointProbeTarget,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

pub const GLOBAL_LESSONS_MAX_ENTRIES: usize = 100;
pub const ENGINE_STATE_SCHEMA: &str = "omnia.super-engine-state.v1";

pub const OMNIA_WORKSPACE_CRATES: &[&str] = &[
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
    "omnia-agent",
    "omnia-downloader",
    "omnia-notebook",
    "omnia-computer",
    "omnia-cli",
    "omnia-runtime",
    "omnia-studio",
    "omnia-native",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutoProceedMode {
    #[default]
    Off,
    #[serde(alias = "standard", alias = "recommended")]
    RecommendedOnly,
    Full,
}

impl AutoProceedMode {
    pub fn try_parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "off" | "false" | "0" | "disabled" | "no" => Ok(Self::Off),
            "recommended-only" | "recommended" | "standard" | "safe" => Ok(Self::RecommendedOnly),
            "full" | "on" | "true" | "1" | "enabled" | "yes" | "auto" => Ok(Self::Full),
            other => bail!(
                "invalid proceed mode '{other}' (expected: status | on | off | standard | recommended-only | full)"
            ),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::RecommendedOnly => "recommended-only",
            Self::Full => "full",
        }
    }

    #[must_use]
    pub const fn policy_label(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::RecommendedOnly => "standard",
            Self::Full => "full",
        }
    }

    #[must_use]
    pub const fn is_enabled(self) -> bool {
        !matches!(self, Self::Off)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperEngineState {
    pub schema: String,
    pub mode: String,
    pub auto_proceed: AutoProceedMode,
    pub auto_proceed_enabled: bool,
    #[serde(default)]
    pub goal_persistence: bool,
    pub active_goal: Option<String>,
    /// Uncapped token budget invariant (`Z-07`): always serialized as `null`.
    pub token_budget: Option<u64>,
    #[serde(default)]
    pub audit_streak: u32,
    #[serde(default)]
    pub active_run_id: Option<String>,
    pub updated_at_ms: i64,
}

impl Default for SuperEngineState {
    fn default() -> Self {
        Self {
            schema: ENGINE_STATE_SCHEMA.to_string(),
            mode: "idle".to_string(),
            auto_proceed: AutoProceedMode::Off,
            auto_proceed_enabled: false,
            goal_persistence: false,
            active_goal: None,
            token_budget: None,
            audit_streak: 0,
            active_run_id: None,
            updated_at_ms: 0,
        }
    }
}

#[must_use]
pub fn engine_state_path(workspace: &Path) -> PathBuf {
    workspace
        .join(".agents")
        .join("super")
        .join("engine_state.json")
}

#[must_use]
pub fn legacy_engine_state_path(workspace: &Path) -> PathBuf {
    workspace.join(".agents").join("super").join("state.json")
}

#[must_use]
pub fn proceed_decisions_path(workspace: &Path) -> PathBuf {
    workspace
        .join(".agents")
        .join("super")
        .join("proceed-decisions.jsonl")
}

#[must_use]
pub fn project_lessons_path(workspace: &Path) -> PathBuf {
    workspace.join(".agents").join("memory").join("lessons.md")
}

#[must_use]
pub fn global_lessons_path() -> PathBuf {
    default_omnia_data_dir()
        .join("memory")
        .join("global_lessons.md")
}

fn user_home_dir() -> Option<PathBuf> {
    env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Dynamically resolves the user-home global lessons mirror without hardcoding any username.
#[must_use]
pub fn discover_cross_host_lessons_path() -> Option<PathBuf> {
    let home = user_home_dir()?;
    let path = home
        .join(".gemini")
        .join("config")
        .join("skills")
        .join("global-lessons")
        .join("references")
        .join("lessons.md");
    if path.parent().is_some_and(Path::is_dir) {
        Some(path)
    } else {
        None
    }
}

/// Reads `.agents/super/engine_state.json` (with read fallback to legacy `.agents/super/state.json`)
/// as a raw JSON object so foreign cross-host keys (e.g. `agy-fast` fields) are never dropped.
#[must_use]
pub fn read_engine_state_map(workspace: &Path) -> Map<String, Value> {
    let primary = engine_state_path(workspace);
    let legacy = legacy_engine_state_path(workspace);
    let raw_opt = fs::read_to_string(&primary)
        .ok()
        .or_else(|| fs::read_to_string(&legacy).ok());
    raw_opt
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| match v {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

fn extract_audit_streak_count(map: &Map<String, Value>) -> u32 {
    match map.get("auditStreak") {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0).min(u64::from(u32::MAX)) as u32,
        Some(Value::Object(obj)) => obj
            .get("count")
            .or_else(|| obj.get("streak"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(u64::from(u32::MAX)) as u32,
        _ => 0,
    }
}

#[must_use]
pub fn read_engine_state(workspace: &Path) -> SuperEngineState {
    let map = read_engine_state_map(workspace);
    let schema = map
        .get("schema")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(ENGINE_STATE_SCHEMA)
        .to_string();
    let mode = map
        .get("mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("idle")
        .to_string();
    let auto_proceed = map
        .get("autoProceed")
        .and_then(Value::as_str)
        .and_then(|s| AutoProceedMode::try_parse(s).ok())
        .unwrap_or_else(|| {
            if map
                .get("autoProceedEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                AutoProceedMode::Full
            } else {
                AutoProceedMode::Off
            }
        });
    let goal_persistence = map
        .get("goalPersistence")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| mode.eq_ignore_ascii_case("super_run"));
    let active_goal = map
        .get("activeGoal")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let active_run_id = map
        .get("activeRunId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let updated_at_ms = map
        .get("updatedAtMs")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let audit_streak = extract_audit_streak_count(&map);

    SuperEngineState {
        schema,
        mode,
        auto_proceed,
        auto_proceed_enabled: auto_proceed.is_enabled(),
        goal_persistence,
        active_goal,
        token_budget: None,
        audit_streak,
        active_run_id,
        updated_at_ms,
    }
}

fn write_engine_state_map(workspace: &Path, map: &Map<String, Value>) -> Result<PathBuf> {
    let path = engine_state_path(workspace);
    let mut text = serde_json::to_string_pretty(&Value::Object(map.clone()))?;
    text = text.replace("\r\n", "\n");
    if !text.ends_with('\n') {
        text.push('\n');
    }
    atomic_write_with_retry(&path, text.as_bytes()).map_err(|e| anyhow::anyhow!(e))?;
    Ok(path)
}

/// Losslessly merges Omnia's `SuperEngineState` fields into `.agents/super/engine_state.json`,
/// preserving all existing foreign keys (`schemaVersion`, `waves`, `auditStreak`,
/// `toolProofCounts`, `activePlanConvs`, `activeRunConvs`, etc.) untouched.
pub fn write_engine_state(workspace: &Path, state: &mut SuperEngineState) -> Result<PathBuf> {
    state.schema = ENGINE_STATE_SCHEMA.to_string();
    state.auto_proceed_enabled = state.auto_proceed.is_enabled();
    state.token_budget = None;
    state.updated_at_ms = omnia_core::now_epoch_ms();
    if let Some(ref goal) = state.active_goal {
        let cleaned = redact_secrets(goal.trim());
        state.active_goal = if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        };
    }

    let mut merged = read_engine_state_map(workspace);
    merged.insert("schema".into(), Value::String(state.schema.clone()));
    merged.insert("mode".into(), Value::String(state.mode.clone()));
    merged.insert(
        "autoProceed".into(),
        Value::String(state.auto_proceed.as_str().to_string()),
    );
    merged.insert(
        "autoProceedEnabled".into(),
        Value::Bool(state.auto_proceed_enabled),
    );
    merged.insert(
        "goalPersistence".into(),
        Value::Bool(state.goal_persistence),
    );
    merged.insert(
        "activeGoal".into(),
        state
            .active_goal
            .as_ref()
            .map_or(Value::Null, |g| Value::String(g.clone())),
    );
    merged.insert("tokenBudget".into(), Value::Null);
    merged.insert("updatedAtMs".into(), json!(state.updated_at_ms));
    if let Some(ref rid) = state.active_run_id {
        merged.insert("activeRunId".into(), Value::String(rid.clone()));
    }
    state.audit_streak = extract_audit_streak_count(&merged);

    write_engine_state_map(workspace, &merged)
}

pub fn append_proceed_decision(
    workspace: &Path,
    mode: AutoProceedMode,
    decision: &str,
    reason: &str,
) -> Result<PathBuf> {
    let path = proceed_decisions_path(workspace);
    let entry = json!({
        "timestampMs": omnia_core::now_epoch_ms(),
        "mode": mode.as_str(),
        "policy": mode.policy_label(),
        "decision": redact_secrets(decision.trim()),
        "reason": redact_secrets(reason.trim()),
        "tokenBudget": Value::Null,
    });
    let mut existing = fs::read_to_string(&path)
        .unwrap_or_default()
        .replace("\r\n", "\n");
    if !existing.is_empty() && !existing.ends_with('\n') {
        existing.push('\n');
    }
    existing.push_str(&serde_json::to_string(&entry)?);
    existing.push('\n');
    atomic_write_with_retry(&path, existing.as_bytes()).map_err(|e| anyhow::anyhow!(e))?;
    Ok(path)
}

pub fn set_auto_proceed(
    workspace: &Path,
    mode: AutoProceedMode,
) -> Result<(SuperEngineState, PathBuf)> {
    let mut state = read_engine_state(workspace);
    state.auto_proceed = mode;
    let path = write_engine_state(workspace, &mut state)?;
    let _ = append_proceed_decision(workspace, mode, "policy_updated", "updated via omnia");
    Ok((state, path))
}

#[allow(dead_code)]
pub fn set_super_workflow_mode(
    workspace: &Path,
    mode: &str,
    goal: Option<&str>,
    os: Option<&ArtifactOs>,
) -> Result<(SuperEngineState, PathBuf)> {
    let mut state = read_engine_state(workspace);
    state.mode = mode.trim().to_string();
    if let Some(g) = goal.map(str::trim).filter(|s| !s.is_empty()) {
        state.active_goal = Some(redact_secrets(g));
    }
    let path = write_engine_state(workspace, &mut state)?;
    if let Some(aos) = os {
        let _ = aos.update_super_state(json!({ "phase": state.mode }), false);
    }
    Ok((state, path))
}

/// Appends a non-empty steer item as `ADDITIVE_INTAKE` without dropping prior entries.
pub fn append_additive_steer(workspace: &Path, steer_text: &str, source: &str) -> Result<PathBuf> {
    let clean = redact_secrets(steer_text.trim());
    if clean.is_empty() {
        bail!("steer text must be non-empty");
    }
    let docs_steer = workspace
        .join("docs")
        .join("workspace")
        .join("STEER_QUEUE.md");
    let target = if docs_steer.is_file() {
        docs_steer
    } else {
        workspace
            .join(".agents")
            .join("super")
            .join("STEER_QUEUE.md")
    };
    let mut content = fs::read_to_string(&target)
        .unwrap_or_else(|_| "# Super Steer Queue (`ADDITIVE_INTAKE`)\n".to_string())
        .replace("\r\n", "\n");
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    let ts = omnia_core::now_epoch_ms();
    let one_line = clean.replace('\n', " ");
    content.push_str(&format!(
        "- `{ts}` | `ADDITIVE_INTAKE` | source=`{source}` | tokenBudget=`null` | {one_line}\n"
    ));
    atomic_write_with_retry(&target, content.as_bytes()).map_err(|e| anyhow::anyhow!(e))?;
    Ok(target)
}

fn scaffold_super_artifacts(os: &ArtifactOs, goal: Option<&str>, mode: &str) -> usize {
    let mut created = 0usize;
    let goal_title = goal
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Active Omnia Super Workflow Goal");
    let defaults = [
        (
            ArtifactKind::Goal,
            "super_goal",
            goal_title,
            format!("# Goal\n\n- Workflow: `{mode}`\n- Objective: {}\n- Token Budget: `null` (uncapped)\n", redact_secrets(goal_title)),
        ),
        (
            ArtifactKind::Spec,
            "super_spec",
            "Acceptance Spec",
            "# Spec\n\n- AC-1: Complete all requirements with verified receipts.\n- AC-2: Zero regressions, pure UTF-8 LF, zero secrets.\n".to_string(),
        ),
        (
            ArtifactKind::Plan,
            "super_plan",
            "Execution Plan",
            format!("# Execution Plan\n\n1. Hydrate full context & capabilities (`{mode}`).\n2. Execute disjoint parallel waves.\n3. Verify runtime + 3x cleanroom audit streak.\n"),
        ),
        (
            ArtifactKind::Dod,
            "super_dod",
            "Definition of Done",
            "# Definition of Done\n\n- [ ] Build & unit/integration tests pass.\n- [ ] Hygiene & secret scan clean (0 findings).\n- [ ] 3x consecutive zero-finding audits recorded.\n".to_string(),
        ),
    ];
    for (kind, slug, title, body) in defaults {
        let existing = os.list_artifacts(Some(kind), None).unwrap_or_default();
        if existing.is_empty()
            && os
                .upsert_artifact(
                    kind,
                    slug,
                    title,
                    "active",
                    "project",
                    &body,
                    json!({ "workflow": mode }),
                    None,
                    false,
                )
                .is_ok()
        {
            created += 1;
        }
    }
    created
}

/// Activates `/super-plan`: sets `mode = "super_plan"`, `autoProceed = Off`,
/// `goalPersistence = false`, `tokenBudget = null`, scaffolds missing `ArtifactOs`
/// artifacts, and returns `(state, path, capabilities)`.
pub fn activate_super_plan(
    workspace: &Path,
    goal: Option<&str>,
    os: Option<&ArtifactOs>,
) -> Result<(SuperEngineState, PathBuf, Value)> {
    let mut state = read_engine_state(workspace);
    state.mode = "super_plan".to_string();
    state.auto_proceed = AutoProceedMode::Off;
    state.auto_proceed_enabled = false;
    state.goal_persistence = false;
    state.token_budget = None;
    state.active_run_id = Some(format!("splan-{}", &omnia_core::uuid_v4()[..8]));
    if let Some(g) = goal.map(str::trim).filter(|s| !s.is_empty()) {
        state.active_goal = Some(redact_secrets(g));
    }
    let path = write_engine_state(workspace, &mut state)?;
    let _ = append_proceed_decision(
        workspace,
        AutoProceedMode::Off,
        "super_plan_activated",
        "interactive planning mode (autoProceed=off, goalPersistence=false)",
    );
    let mut scaffolded = 0usize;
    if let Some(aos) = os {
        let _ = aos.update_super_state(json!({ "phase": "super_plan" }), false);
        scaffolded = scaffold_super_artifacts(aos, state.active_goal.as_deref(), "super_plan");
    }
    let mut caps = build_cli_unified_capabilities(workspace);
    if let Some(obj) = caps.as_object_mut() {
        obj.insert("scaffoldedArtifacts".into(), json!(scaffolded));
    }
    Ok((state, path, caps))
}

/// Activates `/super-run`: sets `mode = "super_run"`, `autoProceed = Full`,
/// `goalPersistence = true`, `approvalMode = Yolo`, `tokenBudget = null`,
/// appends additive steer if prompt/goal supplied, scaffolds missing `ArtifactOs`
/// artifacts, and returns `(state, path, capabilities)`.
pub fn activate_super_run(
    workspace: &Path,
    goal: Option<&str>,
    os: Option<&ArtifactOs>,
) -> Result<(SuperEngineState, PathBuf, Value)> {
    let mut state = read_engine_state(workspace);
    state.mode = "super_run".to_string();
    state.auto_proceed = AutoProceedMode::Full;
    state.auto_proceed_enabled = true;
    state.goal_persistence = true;
    state.token_budget = None;
    state.active_run_id = Some(format!("srun-{}", &omnia_core::uuid_v4()[..8]));
    let mut steer_path: Option<PathBuf> = None;
    if let Some(g) = goal.map(str::trim).filter(|s| !s.is_empty()) {
        let clean = redact_secrets(g);
        state.active_goal = Some(clean.clone());
        steer_path = append_additive_steer(workspace, &clean, "super_run").ok();
    }
    let path = write_engine_state(workspace, &mut state)?;
    let _ = append_proceed_decision(
        workspace,
        AutoProceedMode::Full,
        "super_run_activated",
        "autonomous goal-persistent execution (autoProceed=full, ApprovalMode=yolo, tokenBudget=null)",
    );
    let mut scaffolded = 0usize;
    if let Some(aos) = os {
        let _ = aos.update_super_state(json!({ "phase": "super_run" }), false);
        scaffolded = scaffold_super_artifacts(aos, state.active_goal.as_deref(), "super_run");
    }
    let mut caps = build_cli_unified_capabilities(workspace);
    if let Some(obj) = caps.as_object_mut() {
        obj.insert("scaffoldedArtifacts".into(), json!(scaffolded));
        if let Some(sp) = steer_path {
            obj.insert("steerQueuePath".into(), json!(sp.display().to_string()));
        }
    }
    Ok((state, path, caps))
}

/// Records an independent cleanroom audit pass in `.agents/super/engine_state.json`
/// without dropping any foreign cross-host keys.
pub fn record_super_audit(
    workspace: &Path,
    reviewer: &str,
    frozen_sha: &str,
    findings: u64,
    notes: &str,
) -> Result<Value> {
    let reviewer_clean = redact_secrets(reviewer.trim());
    let sha_clean = redact_secrets(frozen_sha.trim());
    if reviewer_clean.is_empty() || sha_clean.is_empty() {
        bail!("record_audit requires non-empty reviewer and frozenSha");
    }

    let mut merged = read_engine_state_map(workspace);
    let prev_obj = merged
        .get("auditStreak")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let prev_sha = prev_obj
        .get("frozenSha")
        .and_then(Value::as_str)
        .unwrap_or("");
    let prev_count = extract_audit_streak_count(&merged);
    let mut reviewers: Vec<String> = if prev_sha == sha_clean {
        prev_obj
            .get("reviewers")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let next_count = if findings > 0 {
        reviewers.clear();
        0
    } else if prev_sha == sha_clean {
        if !reviewers.iter().any(|r| r.eq_ignore_ascii_case(&reviewer_clean)) {
            reviewers.push(reviewer_clean.clone());
        }
        reviewers.len() as u32
    } else {
        reviewers = vec![reviewer_clean.clone()];
        1
    };
    let effective_count = if findings > 0 {
        0
    } else if prev_sha == sha_clean {
        next_count.max(prev_count)
    } else {
        1
    };

    let mut history = merged
        .get("cleanroomAudits")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let entry = json!({
        "timestampMs": omnia_core::now_epoch_ms(),
        "reviewer": reviewer_clean,
        "frozenSha": sha_clean,
        "findings": findings,
        "notes": redact_secrets(notes.trim()),
        "passed": findings == 0,
    });
    history.push(entry.clone());
    if history.len() > 50 {
        let drain = history.len() - 50;
        history.drain(..drain);
    }

    let mut streak_obj = prev_obj;
    streak_obj.insert("count".into(), json!(effective_count));
    streak_obj.insert("required".into(), json!(3));
    streak_obj.insert("frozenSha".into(), json!(sha_clean));
    streak_obj.insert("reviewers".into(), json!(reviewers));
    streak_obj.insert("passed".into(), json!(effective_count >= 3));
    streak_obj.insert("updatedAtMs".into(), json!(omnia_core::now_epoch_ms()));

    merged.insert("auditStreak".into(), Value::Object(streak_obj.clone()));
    merged.insert("cleanroomAudits".into(), Value::Array(history));
    merged.insert("tokenBudget".into(), Value::Null);
    merged.insert("updatedAtMs".into(), json!(omnia_core::now_epoch_ms()));

    let path = write_engine_state_map(workspace, &merged)?;
    Ok(json!({
        "ok": true,
        "path": path.display().to_string(),
        "entry": entry,
        "auditStreak": Value::Object(streak_obj),
    }))
}

/// Evaluates completion gates and marks the active super workflow completed or cancelled.
pub fn complete_super_workflow(
    workspace: &Path,
    status: &str,
    reason: &str,
    force: bool,
    os: Option<&ArtifactOs>,
) -> Result<Value> {
    let cancelled = status.eq_ignore_ascii_case("cancelled")
        || status.eq_ignore_ascii_case("cancel")
        || status.eq_ignore_ascii_case("aborted");
    let mut state = read_engine_state(workspace);

    if cancelled {
        state.mode = "cancelled".to_string();
        state.goal_persistence = false;
        let path = write_engine_state(workspace, &mut state)?;
        if let Some(aos) = os {
            let _ = aos.update_super_state(json!({ "phase": "cancelled" }), false);
        }
        return Ok(json!({
            "ok": true,
            "status": "cancelled",
            "marker": "<!-- GOAL_CANCELLED -->",
            "reason": redact_secrets(reason.trim()),
            "path": path.display().to_string(),
            "state": state,
        }));
    }

    let (open_todos, unverified_dod) = if let Some(aos) = os {
        match aos.super_state() {
            Ok(st) => (
                st.open_todos,
                st.total_dod_gates.saturating_sub(st.verified_dod_gates),
            ),
            Err(_) => (0, 0),
        }
    } else {
        (0, 0)
    };

    if !force && (open_todos > 0 || unverified_dod > 0 || state.audit_streak < 3) {
        return Ok(json!({
            "ok": false,
            "blocked": true,
            "status": "gates_open",
            "openTodos": open_todos,
            "unverifiedDod": unverified_dod,
            "auditStreak": state.audit_streak,
            "requiredAuditStreak": 3,
            "hint": "Close open todos, verify DoD receipts, and record 3x cleanroom audits (or pass force=true / status=cancelled).",
            "state": state,
        }));
    }

    state.mode = "completed".to_string();
    state.goal_persistence = false;
    let path = write_engine_state(workspace, &mut state)?;
    let mut lessons_sync = Value::Null;
    if let Some(aos) = os {
        let _ = aos.update_super_state(json!({ "phase": "completed" }), false);
        let global_path = global_lessons_path();
        let cross = discover_cross_host_lessons_path();
        if let Ok(rep) = sync_lessons_to_paths(aos, workspace, &global_path, cross.as_deref()) {
            lessons_sync = rep;
        }
    }
    Ok(json!({
        "ok": true,
        "status": "completed",
        "marker": "<!-- GOAL_COMPLETE -->",
        "reason": redact_secrets(reason.trim()),
        "path": path.display().to_string(),
        "lessonsSync": lessons_sync,
        "state": state,
    }))
}

/// Safe read-only discovery of local workspace and user MCP configs (strictly skipping
/// `authProviderType == "google_credentials"` and never reading OAuth/cookie secrets).
fn discover_safe_mcp_servers(workspace: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut candidates = vec![
        workspace.join(".mcp.json"),
        workspace.join(".omnia").join("mcp_config.json"),
    ];
    if let Some(home) = user_home_dir() {
        candidates.push(home.join(".gemini").join("config").join("mcp_config.json"));
    }

    for cfg_path in candidates {
        let Ok(raw) = fs::read_to_string(&cfg_path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(servers) = parsed.get("mcpServers").and_then(Value::as_object) else {
            continue;
        };
        for (name, entry) in servers {
            let auth_type = entry
                .get("authProviderType")
                .and_then(Value::as_str)
                .unwrap_or("");
            if auth_type.eq_ignore_ascii_case("google_credentials") {
                continue;
            }
            if !seen.insert(name.to_ascii_lowercase()) {
                continue;
            }
            let transport = if entry.get("command").and_then(Value::as_str).is_some() {
                "stdio"
            } else if entry.get("serverUrl").or_else(|| entry.get("url")).is_some() {
                "http"
            } else {
                "unknown"
            };
            let disabled = entry
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            out.push(json!({
                "name": name,
                "transport": transport,
                "disabled": disabled,
                "source": cfg_path.file_name().and_then(|s| s.to_str()).unwrap_or("mcp_config.json"),
            }));
        }
    }

    if !seen.contains("agy-fast") {
        if let Some(home) = user_home_dir() {
            let plugin_root = home
                .join(".gemini")
                .join("antigravity")
                .join("plugins")
                .join("installed");
            let agy_candidates = [
                plugin_root.join("agy-fast").join("bin").join("agy-fast.exe"),
                home.join(".gemini")
                    .join("config")
                    .join("bin")
                    .join("agy-fast.exe"),
            ];
            if agy_candidates.iter().any(|p| p.is_file()) {
                out.push(json!({
                    "name": "agy-fast",
                    "transport": "stdio",
                    "disabled": false,
                    "source": "local-plugin-binary",
                }));
            }
        }
    }

    out
}

/// Builds the full Unified Capability Registry inventory for `omnia super capabilities`,
/// TUI `/super-plan`/`/super-run`, and MCP `omnia_super_engine(action="capabilities")`.
#[must_use]
pub fn build_cli_unified_capabilities(workspace: &Path) -> Value {
    let state = read_engine_state(workspace);
    let plugins = PluginRegistry::with_default_pillars();
    let plugin_names: Vec<String> = plugins.list_info().into_iter().map(|p| p.id).collect();

    let skills = SkillRegistry::new();
    let _ = skills.load_from_workspace(workspace);
    let _ = skills.load_default_cold_vault();
    let doc = skills.doctor();
    let active_skill_names: Vec<String> = skills
        .list_skills()
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.name)
        .collect();
    let mcp_servers = discover_safe_mcp_servers(workspace);
    let agy_fast_present = mcp_servers
        .iter()
        .any(|s| s["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case("agy-fast")));

    json!({
        "ok": true,
        "schema": "omnia.unified-capabilities.v1",
        "version": env!("CARGO_PKG_VERSION"),
        "workspace": workspace.display().to_string(),
        "crates": {
            "count": OMNIA_WORKSPACE_CRATES.len(),
            "names": OMNIA_WORKSPACE_CRATES,
        },
        "workflows": ["/super-plan", "/super-run"],
        "lanes": [
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
            "network-lab"
        ],
        "cliSubcommands": [
            "tui",
            "run",
            "super-plan",
            "super-run",
            "super",
            "net",
            "speedtest",
            "research",
            "think",
            "rag",
            "lifecycle",
            "skills",
            "learn",
            "proceed",
            "arena",
            "rewind",
            "--mcp",
            "--acp",
            "--acp-http"
        ],
        "mcpTools": [
            "omni_search_skills",
            "omni_load_skill",
            "graphify_query",
            "rag_search",
            "omnia_super_engine",
            "omnia_deep_think",
            "omnia_net_lab",
            "omnia_studio_bridge"
        ],
        "studioBridgeRoutes": [
            "/api/v5/super/status",
            "/api/v5/super/capabilities",
            "/api/v5/super/plan",
            "/api/v5/super/run",
            "/api/v5/super/proceed",
            "/api/v5/computer/status",
            "/api/v5/computer/dispatch",
            "/api/v5/network/snapshot",
            "/api/v5/network/radar",
            "/api/v5/network/traceroute",
            "/api/v5/network/monitor"
        ],
        "skills": {
            "activeCount": doc.total_skills,
            "coldVaultCount": doc.cold_vault_count,
            "startupTokensEst": doc.startup_tokens_est,
            "merkleSha256": doc.merkle_root_sha256,
            "activeNames": active_skill_names,
        },
        "plugins": {
            "count": plugin_names.len(),
            "ids": plugin_names,
        },
        "mcpServers": mcp_servers,
        "agyFastBridge": {
            "detected": agy_fast_present,
            "sharedStateFile": ".agents/super/engine_state.json",
            "losslessMerge": true,
        },
        "zeroNerfInvariants": {
            "approvalModeDefault": "yolo",
            "tokenBudget": Value::Null,
            "effortDefault": "max",
            "egressPolicy": "unrestricted",
            "drmSupported": false,
        },
        "superState": state,
    })
}

/// Builds a compact Prefix-0-safe dynamic user-tail capability manifest for `/super-plan`
/// and `/super-run` prompt dispatch.
#[must_use]
pub fn format_super_capability_manifest(caps: &Value, mode: &str) -> String {
    let crates_n = caps["crates"]["count"].as_u64().unwrap_or(18);
    let active_skills = caps["skills"]["activeCount"].as_u64().unwrap_or(0);
    let vault_skills = caps["skills"]["coldVaultCount"].as_u64().unwrap_or(0);
    let plugins_n = caps["plugins"]["count"].as_u64().unwrap_or(0);
    let mcp_n = caps["mcpServers"].as_array().map_or(0, Vec::len);
    let agy = caps["agyFastBridge"]["detected"].as_bool().unwrap_or(false);
    let is_run = mode.eq_ignore_ascii_case("super_run");
    let mode_rules = if is_run {
        "mode=super_run | autoProceed=full | goalPersistence=true | approval=yolo | tokenBudget=null | additiveSteer=ADDITIVE_INTAKE | require 3x cleanroom audits + global /learn sync before <!-- GOAL_COMPLETE -->"
    } else {
        "mode=super_plan | autoProceed=off | goalPersistence=false | tokenBudget=null | hydrate context + persist Goal/Spec/Blueprint/Plan/DoD via ArtifactOs | ask clarifications if needed"
    };
    format!(
        "[OMNIA SUPER CAPABILITY MANIFEST]\n{mode_rules}\nInventory: {crates_n} crates | 8 MCP tools | {active_skills} active + {vault_skills} Cold Vault skills | {plugins_n} plugins | {mcp_n} local MCP configs | agy-fast bridge={agy}\nLanes: swarm-32, boost, teamwork, goal-persistence, learn-3way, auto-proceed, deep-think, deep-research, computer-use(studio-bridge), browser-cdp, atelier-notebook, omnidrive-pro, network-lab."
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMarkdownLesson {
    pub title: String,
    pub id: Option<String>,
    pub root_cause: String,
    pub invariant: String,
    pub verify_cmd: String,
}

/// Parses `## <title> (\`<id>\`)` sections from a Markdown lessons ledger.
#[must_use]
pub fn parse_lessons_from_markdown(md: &str) -> Vec<ParsedMarkdownLesson> {
    let mut out = Vec::new();
    let mut current: Option<ParsedMarkdownLesson> = None;

    for raw_line in md.replace("\r\n", "\n").lines() {
        let line = raw_line.trim();
        if let Some(rest) = line.strip_prefix("## ") {
            if let Some(prev) = current.take().filter(|p| !p.title.is_empty()) {
                out.push(prev);
            }
            let (title, id) = split_heading_and_id(rest.trim());
            current = Some(ParsedMarkdownLesson {
                title,
                id,
                root_cause: String::new(),
                invariant: String::new(),
                verify_cmd: String::new(),
            });
            continue;
        }
        let Some(ref mut cur) = current else {
            continue;
        };
        if let Some(v) = line.strip_prefix("- **Root Cause**:") {
            cur.root_cause = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("- **Invariant**:") {
            cur.invariant = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("- **Verify**:") {
            cur.verify_cmd = v.trim().trim_matches('`').to_string();
        }
    }
    if let Some(prev) = current.take().filter(|p| !p.title.is_empty()) {
        out.push(prev);
    }
    out
}

fn split_heading_and_id(heading: &str) -> (String, Option<String>) {
    if let Some(idx) = heading.rfind(" (`") {
        let tail = &heading[idx + 3..];
        if let Some(end) = tail.strip_suffix("`)") {
            let title = heading[..idx].trim().to_string();
            let id = end.trim().to_string();
            if !title.is_empty() && !id.is_empty() {
                return (title, Some(id));
            }
        }
    }
    (heading.to_string(), None)
}

fn normalize_lesson_key(title: &str) -> String {
    title
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Atomically mirrors verified lessons into a pure UTF-8 LF Markdown ledger,
/// redacting secrets, deduplicating by normalized title, and capping at `cap` entries.
pub fn mirror_lessons_markdown(
    path: &Path,
    header: &str,
    lessons: &[LessonRecord],
    cap: usize,
) -> Result<usize> {
    let limit = cap.clamp(1, 500);
    let mut seen: HashSet<String> = HashSet::new();
    let mut merged: Vec<ParsedMarkdownLesson> = Vec::new();

    for l in lessons {
        let title = redact_secrets(l.title.trim());
        let key = normalize_lesson_key(&title);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        let root_cause = redact_secrets(if l.root_cause.trim().is_empty() {
            l.title.trim()
        } else {
            l.root_cause.trim()
        });
        let invariant = redact_secrets(if l.invariant.trim().is_empty() {
            l.title.trim()
        } else {
            l.invariant.trim()
        });
        let verify_cmd = redact_secrets(l.verify_cmd.trim());
        merged.push(ParsedMarkdownLesson {
            title,
            id: Some(l.id.clone()),
            root_cause,
            invariant,
            verify_cmd,
        });
        if merged.len() >= limit {
            break;
        }
    }

    if let Some(existing_md) = (merged.len() < limit)
        .then(|| fs::read_to_string(path).ok())
        .flatten()
    {
        for ex in parse_lessons_from_markdown(&existing_md) {
            let title = redact_secrets(ex.title.trim());
            let key = normalize_lesson_key(&title);
            if key.is_empty() || !seen.insert(key) {
                continue;
            }
            merged.push(ParsedMarkdownLesson {
                title,
                id: ex.id,
                root_cause: redact_secrets(ex.root_cause.trim()),
                invariant: redact_secrets(ex.invariant.trim()),
                verify_cmd: redact_secrets(ex.verify_cmd.trim()),
            });
            if merged.len() >= limit {
                break;
            }
        }
    }

    let mut out = format!("# {header}\n");
    for item in &merged {
        if let Some(ref id) = item.id {
            out.push_str(&format!("\n## {} (`{}`)\n", item.title, id));
        } else {
            out.push_str(&format!("\n## {}\n", item.title));
        }
        let rc = if item.root_cause.is_empty() {
            item.title.as_str()
        } else {
            item.root_cause.as_str()
        };
        let inv = if item.invariant.is_empty() {
            item.title.as_str()
        } else {
            item.invariant.as_str()
        };
        out.push_str(&format!("- **Root Cause**: {rc}\n"));
        out.push_str(&format!("- **Invariant**: {inv}\n"));
        if !item.verify_cmd.is_empty() {
            out.push_str(&format!("- **Verify**: `{}`\n", item.verify_cmd));
        }
    }
    let clean_lf = out.replace("\r\n", "\n").replace('\r', "\n");
    atomic_write_with_retry(path, clean_lf.as_bytes()).map_err(|e| anyhow::anyhow!(e))?;
    Ok(merged.len())
}

/// Bidirectionally synchronizes lessons between `ArtifactOs`, workspace `.agents/memory/lessons.md`,
/// `global_lessons.md`, and an optional cross-host mirror file.
pub fn sync_lessons_to_paths(
    os: &ArtifactOs,
    workspace: &Path,
    global_path: &Path,
    cross_host_mirror: Option<&Path>,
) -> Result<Value> {
    let existing = os.list_lessons(None).map_err(|e| anyhow::anyhow!(e))?;
    let mut known_keys: HashSet<String> = existing
        .iter()
        .map(|l| normalize_lesson_key(&l.title))
        .collect();

    let proj_path = project_lessons_path(workspace);
    let mut imported_from_disk = 0usize;

    for (src_path, scope) in [(proj_path.as_path(), "project"), (global_path, "global")] {
        if let Ok(raw) = fs::read_to_string(src_path) {
            for parsed in parse_lessons_from_markdown(&raw) {
                let key = normalize_lesson_key(&parsed.title);
                if key.is_empty() || !known_keys.insert(key) {
                    continue;
                }
                let invariant = if parsed.invariant.trim().is_empty() {
                    parsed.title.clone()
                } else {
                    parsed.invariant.clone()
                };
                let root_cause = if parsed.root_cause.trim().is_empty() {
                    parsed.title.clone()
                } else {
                    parsed.root_cause.clone()
                };
                let rec = LessonRecord {
                    id: parsed.id.unwrap_or_default(),
                    scope: scope.to_string(),
                    title: parsed.title,
                    symptom: root_cause.clone(),
                    root_cause,
                    invariant,
                    anti_pattern: String::new(),
                    verify_cmd: parsed.verify_cmd,
                    tags: vec!["synced".to_string()],
                    provenance_sha: String::new(),
                    promoted_skill_slug: None,
                    overlap_warning: None,
                    created_at_ms: 0,
                };
                if os.capture_lesson(rec, false).is_ok() {
                    imported_from_disk += 1;
                }
            }
        }
    }

    let all_lessons = os.list_lessons(None).map_err(|e| anyhow::anyhow!(e))?;
    let global_lessons: Vec<LessonRecord> = all_lessons
        .iter()
        .filter(|l| l.scope == "global")
        .cloned()
        .collect();
    let project_lessons: Vec<LessonRecord> = all_lessons
        .iter()
        .filter(|l| l.scope != "global")
        .cloned()
        .collect();

    let global_written = mirror_lessons_markdown(
        global_path,
        "Omnia Global Lessons",
        &global_lessons,
        GLOBAL_LESSONS_MAX_ENTRIES,
    )?;
    let project_written = if !project_lessons.is_empty() || proj_path.is_file() {
        mirror_lessons_markdown(
            &proj_path,
            "Workspace Lessons",
            &project_lessons,
            GLOBAL_LESSONS_MAX_ENTRIES,
        )?
    } else {
        0
    };
    let cross_host_written =
        if let Some(ch_path) = cross_host_mirror.filter(|p| !global_lessons.is_empty() || p.is_file())
        {
            mirror_lessons_markdown(
                ch_path,
                "Omnia Global Lessons",
                &global_lessons,
                GLOBAL_LESSONS_MAX_ENTRIES,
            )?
        } else {
            0
        };

    Ok(json!({
        "ok": true,
        "totalLessons": all_lessons.len(),
        "projectLessons": project_lessons.len(),
        "globalLessons": global_lessons.len(),
        "importedFromDisk": imported_from_disk,
        "globalMirrorPath": global_path.display().to_string(),
        "globalMirrorCount": global_written,
        "projectMirrorPath": proj_path.display().to_string(),
        "projectMirrorCount": project_written,
        "crossHostMirrorCount": cross_host_written,
        "cap": GLOBAL_LESSONS_MAX_ENTRIES,
    }))
}

// =========================================================================
// Shared Steer #28 Zero-Bloat Network Lab Helpers (CLI + TUI + MCP)
// =========================================================================

fn is_private_or_loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || (o[0] == 100 && (64..=127).contains(&o[1]))
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
        }
    }
}

/// Validates a hostname or IP literal for network diagnostics (strict allowlist, zero shell chars).
pub fn validate_safe_net_target(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 253 {
        bail!("network target must be 1..=253 characters");
    }
    if trimmed.starts_with('-') || trimmed.ends_with('-') {
        bail!("network target must not start or end with '-'");
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
    {
        bail!("network target contains disallowed characters");
    }
    if trimmed.contains("..") {
        bail!("network target contains invalid '..' sequence");
    }
    Ok(trimmed.to_string())
}

/// Builds an SSRF-checked [`EndpointProbeTarget`] from a user-provided custom host or HTTPS URL.
pub fn build_custom_endpoint_target(raw: &str) -> Result<EndpointProbeTarget> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        bail!("custom host must be non-empty");
    }
    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let authority = without_scheme.split('/').next().unwrap_or("").trim();
    if authority.contains('@') {
        bail!("custom host must not include credentials");
    }
    let host_only = if authority.starts_with('[') {
        authority
            .trim_start_matches('[')
            .split(']')
            .next()
            .unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    let clean_host = validate_safe_net_target(host_only)?;
    let lower = clean_host.to_ascii_lowercase();
    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
    {
        bail!("custom host `{clean_host}` rejected by SSRF guard (local hostname)");
    }
    if let Ok(ip) = clean_host.parse::<IpAddr>() {
        if is_private_or_loopback_ip(ip) {
            bail!("custom host `{clean_host}` rejected by SSRF guard (private/loopback IP)");
        }
    }
    let url = if trimmed.starts_with("https://") {
        trimmed.to_string()
    } else if trimmed.starts_with("http://") {
        bail!("custom host probe requires HTTPS (or bare public hostname)");
    } else {
        format!("https://{clean_host}/")
    };
    Ok(EndpointProbeTarget {
        id: "custom-host".to_string(),
        label: format!("Custom ({clean_host})"),
        url,
    })
}

/// Benchmarks an explicit DNS IPv4/IPv6 resolver using RFC 1035 UDP wire queries.
pub fn probe_custom_dns_resolver(
    dns_ip: &str,
    domain: &str,
    trials: usize,
    timeout_ms: u64,
) -> Result<Value> {
    let ip: IpAddr = dns_ip
        .trim()
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid --custom-dns IP address `{dns_ip}`"))?;
    let clean_domain = validate_safe_net_target(domain)?;
    let target = SocketAddr::new(ip, 53);
    let bind_addr = if ip.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    };
    let count = trials.clamp(1, 8);
    let dur = Duration::from_millis(timeout_ms.clamp(250, 3_000));
    let mut samples = Vec::new();
    let mut failures = 0usize;
    let mut resolved_ip: Option<String> = None;

    for i in 0..count {
        let tx_id = 0x5100u16.wrapping_add(i as u16);
        let packet = build_dns_a_query(&clean_domain, tx_id);
        let sock = match UdpSocket::bind(bind_addr) {
            Ok(s) => s,
            Err(_) => {
                failures += 1;
                continue;
            }
        };
        let _ = sock.set_read_timeout(Some(dur));
        let _ = sock.set_write_timeout(Some(dur));
        let t0 = Instant::now();
        if sock.send_to(&packet, target).is_err() {
            failures += 1;
            continue;
        }
        let mut buf = [0u8; 512];
        match sock.recv_from(&mut buf) {
            Ok((n, _)) => {
                let elapsed = (t0.elapsed().as_secs_f64() * 1000.0 * 100.0).round() / 100.0;
                if let Some(ans) = parse_dns_a_response(&buf[..n], tx_id) {
                    samples.push(elapsed);
                    if resolved_ip.is_none() {
                        resolved_ip = Some(ans);
                    }
                } else {
                    failures += 1;
                }
            }
            Err(_) => {
                failures += 1;
            }
        }
    }

    let failure_rate_pct = ((failures as f64 / count as f64) * 100.0 * 10.0).round() / 10.0;
    Ok(json!({
        "name": "Custom DNS",
        "server": ip.to_string(),
        "domain": clean_domain,
        "status": if samples.is_empty() { "UNAVAILABLE" } else { "LIVE" },
        "minMs": samples.iter().copied().reduce(f64::min),
        "p50Ms": percentile(&samples, 50.0),
        "p95Ms": percentile(&samples, 95.0),
        "maxMs": samples.iter().copied().reduce(f64::max),
        "jitterMs": rfc3550_jitter_ms(&samples),
        "failureRatePct": failure_rate_pct,
        "samplesMs": samples,
        "resolvedIp": resolved_ip,
    }))
}

#[derive(Debug, Clone, Copy)]
struct RadarRegionSpec {
    id: &'static str,
    region: &'static str,
    host: &'static str,
    port: u16,
}

const RADAR_REGIONS: &[RadarRegionSpec] = &[
    RadarRegionSpec {
        id: "us-east",
        region: "US-East",
        host: "s3.us-east-1.amazonaws.com",
        port: 443,
    },
    RadarRegionSpec {
        id: "us-west",
        region: "US-West",
        host: "s3.us-west-2.amazonaws.com",
        port: 443,
    },
    RadarRegionSpec {
        id: "eu-central",
        region: "EU-Central",
        host: "s3.eu-central-1.amazonaws.com",
        port: 443,
    },
    RadarRegionSpec {
        id: "asia-sg",
        region: "Asia-SG",
        host: "s3.ap-southeast-1.amazonaws.com",
        port: 443,
    },
    RadarRegionSpec {
        id: "asia-jp",
        region: "Asia-JP",
        host: "s3.ap-northeast-1.amazonaws.com",
        port: 443,
    },
    RadarRegionSpec {
        id: "oceania",
        region: "Oceania",
        host: "s3.ap-southeast-2.amazonaws.com",
        port: 443,
    },
];

/// Bounded concurrent 6-region global TCP/HTTPS latency radar (pure stdlib, zero crates).
#[must_use]
pub fn run_global_radar_snapshot(timeout_ms: u64) -> Value {
    let dur = Duration::from_millis(timeout_ms.clamp(400, 3_500));
    let started = Instant::now();
    let results: Vec<Value> = std::thread::scope(|scope| {
        let handles: Vec<_> = RADAR_REGIONS
            .iter()
            .map(|spec| {
                scope.spawn(move || {
                    let addr_opt = (spec.host, spec.port)
                        .to_socket_addrs()
                        .ok()
                        .and_then(|mut it| it.next());
                    let Some(addr) = addr_opt else {
                        return json!({
                            "id": spec.id,
                            "region": spec.region,
                            "host": spec.host,
                            "status": "dns_error",
                            "rttMs": Value::Null,
                        });
                    };
                    let t0 = Instant::now();
                    match TcpStream::connect_timeout(&addr, dur) {
                        Ok(_) => {
                            let rtt = (t0.elapsed().as_secs_f64() * 1000.0 * 10.0).round() / 10.0;
                            json!({
                                "id": spec.id,
                                "region": spec.region,
                                "host": spec.host,
                                "resolvedIp": addr.ip().to_string(),
                                "status": "ok",
                                "rttMs": rtt,
                            })
                        }
                        Err(e) => json!({
                            "id": spec.id,
                            "region": spec.region,
                            "host": spec.host,
                            "resolvedIp": addr.ip().to_string(),
                            "status": "timeout",
                            "rttMs": Value::Null,
                            "error": e.to_string(),
                        }),
                    }
                })
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .collect()
    });

    let fastest = results
        .iter()
        .filter_map(|r| Some((r["region"].as_str()?, r["rttMs"].as_f64()?)))
        .min_by(|a, b| a.1.total_cmp(&b.1));

    json!({
        "ok": true,
        "regionCount": results.len(),
        "elapsedMs": started.elapsed().as_millis() as u64,
        "fastestRegion": fastest.map(|(r, _)| r),
        "fastestRttMs": fastest.map(|(_, ms)| ms),
        "regions": results,
        "observedAtMs": omnia_core::now_epoch_ms(),
    })
}

/// Parses Windows `tracert -d` / POSIX `traceroute -n` lines into structured hop JSON records.
#[must_use]
pub fn parse_tracert_output(raw: &str) -> Vec<Value> {
    let mut hops = Vec::new();
    for line in raw.replace("\r\n", "\n").lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let tokens: Vec<&str> = trimmed.split_whitespace().collect();
        let Some(hop_num) = tokens.first().and_then(|t| t.parse::<u8>().ok()) else {
            continue;
        };
        if hop_num == 0 || hop_num > 64 {
            continue;
        }
        let mut rtts: Vec<f64> = Vec::new();
        let mut ip: Option<String> = None;
        let mut i = 1usize;
        while i < tokens.len() {
            let tok = tokens[i];
            if tok == "ms" {
                i += 1;
                continue;
            }
            if let Some(num_str) = tok.strip_prefix('<') {
                if let Ok(v) = num_str.parse::<f64>() {
                    rtts.push(v);
                    i += 1;
                    continue;
                }
            }
            if let Ok(v) = tok.parse::<f64>() {
                if tokens.get(i + 1).is_some_and(|n| *n == "ms") {
                    rtts.push(v);
                    i += 2;
                    continue;
                }
            }
            let cleaned_ip = tok.trim_matches(|c| c == '[' || c == ']' || c == '(' || c == ')');
            if cleaned_ip.parse::<IpAddr>().is_ok() {
                ip = Some(cleaned_ip.to_string());
            }
            i += 1;
        }
        let avg_ms = if rtts.is_empty() {
            None
        } else {
            let sum: f64 = rtts.iter().sum();
            Some(((sum / rtts.len() as f64) * 10.0).round() / 10.0)
        };
        let status = if ip.is_some() { "ok" } else { "timeout" };
        hops.push(json!({
            "hop": hop_num,
            "ip": ip,
            "rttsMs": rtts,
            "avgMs": avg_ms,
            "status": status,
        }));
    }
    hops
}

/// Runs a bounded, strictly validated traceroute (`max_hops <= 12`, ZERO shell invocation).
pub fn run_bounded_traceroute_cli(target: &str, max_hops: u8) -> Result<Value> {
    let clean = validate_safe_net_target(target)?;
    let bounded_hops = max_hops.clamp(1, 12);
    let hops_str = bounded_hops.to_string();
    let started = Instant::now();

    #[cfg(windows)]
    let output = Command::new("tracert")
        .args(["-d", "-h", &hops_str, "-w", "1000", &clean])
        .output();
    #[cfg(not(windows))]
    let output = Command::new("traceroute")
        .args(["-n", "-m", &hops_str, "-w", "1", &clean])
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let hops = parse_tracert_output(&stdout);
            Ok(json!({
                "ok": true,
                "target": clean,
                "maxHops": bounded_hops,
                "hopCount": hops.len(),
                "elapsedMs": started.elapsed().as_millis() as u64,
                "hops": hops,
                "observedAtMs": omnia_core::now_epoch_ms(),
            }))
        }
        Err(e) => Ok(json!({
            "ok": false,
            "target": clean,
            "maxHops": bounded_hops,
            "hopCount": 0,
            "hops": [],
            "error": redact_secrets(&e.to_string()),
            "observedAtMs": omnia_core::now_epoch_ms(),
        })),
    }
}

/// Samples a single passive monitor point (TCP RTT to target + host CPU/RAM/Omnia RSS).
#[must_use]
pub fn sample_passive_monitor_point(target_host: &str, timeout_ms: u64) -> Value {
    let dur = Duration::from_millis(timeout_ms.clamp(300, 2_500));
    let host = validate_safe_net_target(target_host).unwrap_or_else(|_| "1.1.1.1".to_string());
    let addr_opt = (host.as_str(), 443u16)
        .to_socket_addrs()
        .ok()
        .and_then(|mut it| it.next());
    let rtt_ms = addr_opt.and_then(|addr| {
        let t0 = Instant::now();
        TcpStream::connect_timeout(&addr, dur)
            .ok()
            .map(|_| (t0.elapsed().as_secs_f64() * 1000.0 * 10.0).round() / 10.0)
    });
    let snap = collect_host_system_snapshot();
    json!({
        "timestampMs": omnia_core::now_epoch_ms(),
        "target": host,
        "rttMs": rtt_ms,
        "lossPct": if rtt_ms.is_some() { 0.0 } else { 100.0 },
        "cpuLoadPct": snap.cpu_load_pct.unwrap_or(0.0),
        "omniaRssBytes": snap.total_omnia_rss_bytes,
        "listeningPorts": snap.listening_ports.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir_for(tag: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!(
            "omnia_cli_super_{}_{}_{}",
            tag,
            std::process::id(),
            &omnia_core::uuid_v4()[..8]
        ));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn proceed_engine_state_roundtrips_modes_and_keeps_token_budget_null() {
        let ws = temp_dir_for("proceed");
        let initial = read_engine_state(&ws);
        assert_eq!(initial.auto_proceed, AutoProceedMode::Off);
        assert!(!initial.auto_proceed_enabled);
        assert!(initial.token_budget.is_none());

        let (st1, path1) = set_auto_proceed(&ws, AutoProceedMode::RecommendedOnly).unwrap();
        assert_eq!(st1.auto_proceed, AutoProceedMode::RecommendedOnly);
        assert!(st1.auto_proceed_enabled);
        assert!(st1.token_budget.is_none());
        assert!(path1.ends_with(Path::new(".agents").join("super").join("engine_state.json")));

        let raw = fs::read_to_string(&path1).unwrap();
        assert!(!raw.contains('\r'), "engine_state.json must be pure Unix LF");
        assert!(raw.contains("\"tokenBudget\": null"));

        let (st2, _) = set_super_workflow_mode(&ws, "super_plan", Some("Ship Wave 2"), None).unwrap();
        assert_eq!(st2.mode, "super_plan");
        assert_eq!(st2.active_goal.as_deref(), Some("Ship Wave 2"));
        assert_eq!(st2.auto_proceed, AutoProceedMode::RecommendedOnly);

        let (st3, _) = set_auto_proceed(&ws, AutoProceedMode::try_parse("on").unwrap()).unwrap();
        assert_eq!(st3.auto_proceed, AutoProceedMode::Full);
        assert_eq!(
            AutoProceedMode::try_parse("standard").unwrap(),
            AutoProceedMode::RecommendedOnly
        );
        assert!(AutoProceedMode::try_parse("invalid-mode").is_err());

        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn engine_state_lossless_merge_preserves_agy_fast_fields_and_legacy_fallback() {
        let ws = temp_dir_for("lossless");
        let legacy_path = legacy_engine_state_path(&ws);
        fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        let agy_payload = json!({
            "schemaVersion": "2.4.0",
            "waves": [{ "id": "W1", "status": "done" }],
            "auditStreak": { "count": 2, "frozenSha": "abc1234", "reviewers": ["r1", "r2"] },
            "toolProofCounts": { "cargo_test": 4 },
            "activePlanConvs": ["conv-plan-1"],
            "activeRunConvs": ["conv-run-1"],
            "autoProceed": "standard"
        });
        fs::write(
            &legacy_path,
            format!("{}\n", serde_json::to_string_pretty(&agy_payload).unwrap()),
        )
        .unwrap();

        // Fallback reads legacy state.json seamlessly.
        let loaded = read_engine_state(&ws);
        assert_eq!(loaded.auto_proceed, AutoProceedMode::RecommendedOnly);
        assert_eq!(loaded.audit_streak, 2);
        assert!(loaded.token_budget.is_none());

        // Activating /super-run merges into engine_state.json without dropping any foreign keys.
        let os = ArtifactOs::open_in_memory(&ws).unwrap();
        let (run_st, primary_path, caps) =
            activate_super_run(&ws, Some("Deliver Steer 27B+28B"), Some(&os)).unwrap();
        assert_eq!(run_st.mode, "super_run");
        assert_eq!(run_st.auto_proceed, AutoProceedMode::Full);
        assert!(run_st.goal_persistence);
        assert!(run_st.token_budget.is_none());
        assert_eq!(caps["crates"]["count"], json!(18));

        let disk: Value = serde_json::from_str(&fs::read_to_string(&primary_path).unwrap()).unwrap();
        assert_eq!(disk["schemaVersion"], json!("2.4.0"));
        assert_eq!(disk["waves"][0]["id"], json!("W1"));
        assert_eq!(disk["toolProofCounts"]["cargo_test"], json!(4));
        assert_eq!(disk["activePlanConvs"][0], json!("conv-plan-1"));
        assert_eq!(disk["activeRunConvs"][0], json!("conv-run-1"));
        assert_eq!(disk["auditStreak"]["count"], json!(2));
        assert_eq!(disk["goalPersistence"], json!(true));
        assert!(disk["tokenBudget"].is_null());

        // Recording 3rd audit increments streak and preserves foreign keys.
        let audit_res =
            record_super_audit(&ws, "r3", "abc1234", 0, "cleanroom verified").unwrap();
        assert_eq!(audit_res["auditStreak"]["count"], json!(3));
        assert_eq!(audit_res["auditStreak"]["passed"], json!(true));

        // Activating /super-plan flips autoProceed=off, goalPersistence=false, still preserving agy-fast keys.
        let (plan_st, _, plan_caps) =
            activate_super_plan(&ws, Some("Plan Next Wave"), Some(&os)).unwrap();
        assert_eq!(plan_st.mode, "super_plan");
        assert_eq!(plan_st.auto_proceed, AutoProceedMode::Off);
        assert!(!plan_st.goal_persistence);
        let manifest = format_super_capability_manifest(&plan_caps, "super_plan");
        assert!(manifest.contains("18 crates"));
        assert!(manifest.contains("goalPersistence=false"));

        let disk_after: Value =
            serde_json::from_str(&fs::read_to_string(&primary_path).unwrap()).unwrap();
        assert_eq!(disk_after["schemaVersion"], json!("2.4.0"));
        assert_eq!(disk_after["toolProofCounts"]["cargo_test"], json!(4));
        assert!(disk_after["tokenBudget"].is_null());

        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn global_lessons_sync_dedups_redacts_and_caps_at_100() {
        let ws = temp_dir_for("lessons");
        let global_md = ws.join("global_lessons.md");
        let os = ArtifactOs::open_in_memory(&ws).unwrap();

        let rec = LessonRecord {
            id: "lsn-demo-1".into(),
            scope: "global".into(),
            title: "Guard MSVC delayload".into(),
            symptom: "Crash with sk-dummy-1234567890abcdef1234567890".into(),
            root_cause: "Dual casing WS2_32.dll".into(),
            invariant: "Never delayload ws2_32.dll".into(),
            anti_pattern: String::new(),
            verify_cmd: "cargo check".into(),
            tags: vec!["msvc".into()],
            provenance_sha: String::new(),
            promoted_skill_slug: None,
            overlap_warning: None,
            created_at_ms: 0,
        };
        os.capture_lesson(rec, false).unwrap();

        // Pre-seed disk file with an extra entry and a duplicate entry.
        fs::write(
            &global_md,
            "# Omnia Global Lessons\n\n## Guard MSVC delayload (`lsn-dup`)\n- **Root Cause**: dup\n- **Invariant**: dup\n\n## Imported Disk Lesson (`lsn-disk-1`)\n- **Root Cause**: disk cause\n- **Invariant**: disk invariant\n",
        )
        .unwrap();

        let rep = sync_lessons_to_paths(&os, &ws, &global_md, None).unwrap();
        assert_eq!(rep["ok"], json!(true));
        assert_eq!(rep["importedFromDisk"], json!(1));
        assert_eq!(rep["globalMirrorCount"], json!(2));

        let md = fs::read_to_string(&global_md).unwrap();
        assert!(!md.contains('\r'));
        assert!(md.contains("Guard MSVC delayload"));
        assert!(md.contains("Imported Disk Lesson"));
        assert!(!md.contains("sk-dummy-1234567890abcdef1234567890"));

        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn net_target_validator_ssrf_guard_and_tracert_parser_work() {
        assert_eq!(validate_safe_net_target("1.1.1.1").unwrap(), "1.1.1.1");
        assert_eq!(
            validate_safe_net_target("api.example.com").unwrap(),
            "api.example.com"
        );
        assert!(validate_safe_net_target("1.1.1.1 & calc.exe").is_err());
        assert!(validate_safe_net_target("-h").is_err());
        assert!(validate_safe_net_target("..").is_err());

        assert!(build_custom_endpoint_target("127.0.0.1").is_err());
        assert!(build_custom_endpoint_target("http://169.254.169.254").is_err());
        assert!(build_custom_endpoint_target("localhost").is_err());
        assert!(build_custom_endpoint_target("http://example.com").is_err());
        let ok_ep = build_custom_endpoint_target("example.com").unwrap();
        assert_eq!(ok_ep.url, "https://example.com/");

        let sample = "\nTracing route to 1.1.1.1 over a maximum of 12 hops\n\n  1    <1 ms     1 ms     1 ms  192.0.2.1\n  2     *        *        *     Request timed out.\n  3    12 ms    14 ms    13 ms  1.1.1.1\n";
        let hops = parse_tracert_output(sample);
        assert_eq!(hops.len(), 3);
        assert_eq!(hops[0]["hop"], json!(1));
        assert_eq!(hops[0]["ip"], json!("192.0.2.1"));
        assert_eq!(hops[0]["status"], json!("ok"));
        assert_eq!(hops[1]["hop"], json!(2));
        assert_eq!(hops[1]["status"], json!("timeout"));
        assert_eq!(hops[2]["hop"], json!(3));
        assert_eq!(hops[2]["ip"], json!("1.1.1.1"));
        assert_eq!(hops[2]["avgMs"], json!(13.0));
    }
}
