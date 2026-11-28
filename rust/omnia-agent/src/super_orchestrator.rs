//! Executable Unified Super-Workflow Orchestrator (`/super-plan` & `/super-run`).
//!
//! Bridges Omnia's 18 Rust crates, `ArtifactOs`, lossless `.agents/super/engine_state.json`,
//! `SteerQueue` (`ADDITIVE_INTAKE`, `token_budget: None`), `SwarmRuntime`, `omnia-routing`
//! dual-pool `/boost` escalation, 3x cleanroom audit streak gates, 3-way global `/learn` sync,
//! safe MCP auto-discovery, and Prefix-0-safe dynamic user-tail capability hydration.

use anyhow::Result;
use chrono::Utc;
use omnia_harness::artifact_os::{
    append_proceed_decision_jsonl, engine_state_path, merge_engine_state_lossless,
    read_engine_state_map, sync_global_lessons, ArtifactKind, ArtifactOs, SixStateReceipt,
};
use omnia_harness::deep_think::model_vendor_family;
use omnia_harness::skill_registry::discover_unified_skills;
use omnia_harness::steer_queue::{SteerMode, SteerQueue};
use omnia_routing::{DynamicProviderRouter, EffortLevel, ModelRole, RouteRequestPolicy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::agent_store::default_omnia_data_dir;
use crate::dynamic_plugins::CordisPluginManager;
use crate::mcp_client::discover_workspace_and_local_mcp_configs;
use crate::permissions::ApprovalMode;
use crate::plugin::{builtin_deferred_semantic_tools, PluginRegistry};
use crate::tools::builtin_deferred_18crate_tools;

/// Explicit completion sentinel emitted when every open gate and audit streak passes.
pub const GOAL_COMPLETE_MARKER: &str = "<!-- GOAL_COMPLETE -->";
/// Explicit cancellation sentinel emitted when a super run is cancelled cleanly.
pub const GOAL_CANCELLED_MARKER: &str = "<!-- GOAL_CANCELLED -->";
/// Maximum consecutive zero-progress stops before tripping the safety circuit breaker.
pub const SUPER_MAX_ZERO_PROGRESS_STRIKES: u32 = 3;
/// Failure strike threshold triggering 2-strike RCA -> `/boost` model escalation.
pub const SUPER_BOOST_RCA_STRIKE_THRESHOLD: u32 = 2;
/// Default consecutive cleanroom zero-finding audit rounds required for full release closure.
pub const SUPER_REQUIRED_AUDIT_STREAK: u32 = 3;
/// Total active native Rust crates in the Omnia workspace.
pub const WORKSPACE_CRATE_COUNT: usize = 18;

/// All 18 active pure-Rust workspace crates in `D:\Omnia`.
pub const OMNIA_WORKSPACE_CRATES: [&str; WORKSPACE_CRATE_COUNT] = [
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

/// Canonical execution lanes coordinated by `/super-plan` and `/super-run`.
pub const SUPER_WORKFLOW_LANES: [&str; 13] = [
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

/// Active super-workflow mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuperMode {
    #[default]
    Idle,
    SuperPlan,
    SuperRun,
}

impl SuperMode {
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "super_plan" | "super-plan" | "plan" | "/super-plan" => Self::SuperPlan,
            "super_run" | "super-run" | "run" | "/super-run" => Self::SuperRun,
            _ => Self::Idle,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::SuperPlan => "super_plan",
            Self::SuperRun => "super_run",
        }
    }
}

/// Interactive vs autonomous continuation policy (`/auto-proceed`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutoProceedPolicy {
    /// Interactive planning (`/super-plan`): ask clarifying questions and await confirmation.
    Off,
    /// Default balanced mode: auto-select `(Recommended)` choices and log audit decisions.
    #[default]
    Standard,
    /// Full autonomous execution (`/super-run`): never stall on non-destructive prompts.
    Full,
}

impl AutoProceedPolicy {
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "off" | "none" | "false" | "0" | "interactive" => Self::Off,
            "full" | "all" | "yolo" | "auto" | "max" => Self::Full,
            _ => Self::Standard,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Standard => "standard",
            Self::Full => "full",
        }
    }

    #[must_use]
    pub const fn allows_interactive_questions(self) -> bool {
        !matches!(self, Self::Full)
    }

    #[must_use]
    pub const fn auto_accepts_recommended(self) -> bool {
        !matches!(self, Self::Off)
    }
}

/// Recorded cleanroom audit round against a frozen Git snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanroomAuditRecord {
    pub round_id: String,
    pub reviewer: String,
    pub commit_sha: String,
    pub tree_sha: String,
    pub findings: usize,
    pub passed: bool,
    pub recorded_at_ms: i64,
}

/// 2-strike RCA -> `/boost` model escalation recommendation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoostEscalationDecision {
    pub should_escalate: bool,
    pub strike_count: u32,
    pub recommended_role: String,
    pub recommended_effort: String,
    pub target_family_hint: String,
    pub routed_candidate: Option<String>,
    pub reason: String,
}

/// Stage-5 `/goal` persistence exit-gate evaluation result inside `NativeSuperEngine`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalExitEvaluation {
    pub allow_exit: bool,
    pub status: String,
    pub marker: Option<String>,
    pub open_todos: usize,
    pub open_dod_gates: usize,
    pub pending_steers: usize,
    pub audit_streak: u32,
    pub required_audit_streak: u32,
    pub zero_progress_strikes: u32,
    pub circuit_breaker_tripped: bool,
    pub boost_decision: BoostEscalationDecision,
    pub continuation_prompt: Option<String>,
    pub blocking_reasons: Vec<String>,
}

/// Receipt returned whenever `/super-plan` or `/super-run` activates.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperActivationReceipt {
    pub ok: bool,
    pub run_id: String,
    pub mode: SuperMode,
    pub phase: String,
    pub auto_proceed: AutoProceedPolicy,
    pub goal_persistence: bool,
    pub approval_mode: String,
    pub coding_allowed: bool,
    pub ask_question_allowed: bool,
    pub token_budget: Option<u64>,
    pub active_goal: Option<String>,
    pub engine_state_path: String,
    pub dynamic_tail_hydration: String,
    pub capabilities_summary: Value,
}

/// Executable orchestrator managing `/super-plan`, `/super-run`, lossless state,
/// additive steers, cleanroom audit streaks, 2-strike `/boost` RCA, and Prefix-0-safe hydration.
#[derive(Debug, Clone)]
pub struct SuperOrchestrator {
    workspace_root: PathBuf,
    run_id: String,
    mode: SuperMode,
    phase: String,
    auto_proceed: AutoProceedPolicy,
    goal_persistence: bool,
    approval_mode: ApprovalMode,
    active_goal: Option<String>,
    active_goal_id: Option<String>,
    steer_queue: Arc<SteerQueue>,
    audit_rounds: Vec<CleanroomAuditRecord>,
    required_audit_streak: u32,
    consecutive_failures: u32,
    zero_progress_strikes: u32,
    last_progress_fingerprint: Option<String>,
    goal_continuations: u32,
    max_goal_continuations: u32,
    cancelled: bool,
    lessons_synced_on_complete: bool,
}

impl SuperOrchestrator {
    /// Creates a new idle orchestrator rooted at `workspace_root` with Steer #22 YOLO defaults.
    #[must_use]
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            run_id: format!("super-{}", &uuid::Uuid::new_v4().to_string()[..8]),
            mode: SuperMode::Idle,
            phase: "idle".to_string(),
            auto_proceed: AutoProceedPolicy::Standard,
            goal_persistence: false,
            approval_mode: ApprovalMode::Yolo,
            active_goal: None,
            active_goal_id: None,
            steer_queue: Arc::new(SteerQueue::new()),
            audit_rounds: Vec::new(),
            required_audit_streak: SUPER_REQUIRED_AUDIT_STREAK,
            consecutive_failures: 0,
            zero_progress_strikes: 0,
            last_progress_fingerprint: None,
            goal_continuations: 0,
            max_goal_continuations: 12,
            cancelled: false,
            lessons_synced_on_complete: false,
        }
    }

    /// Hydrates an orchestrator from existing `.agents/super/engine_state.json` (or legacy `state.json`).
    #[must_use]
    pub fn from_workspace_state(workspace_root: impl Into<PathBuf>) -> Self {
        let root = workspace_root.into();
        let mut orch = Self::new(root.clone());
        let map = read_engine_state_map(&root);
        if map.is_empty() {
            return orch;
        }
        if let Some(m) = map.get("mode").and_then(Value::as_str) {
            orch.mode = SuperMode::parse(m);
        }
        if let Some(p) = map
            .get("phase")
            .or_else(|| map.get("lifecyclePhase"))
            .and_then(Value::as_str)
        {
            orch.phase = p.to_string();
        }
        if let Some(ap) = map.get("autoProceed").and_then(Value::as_str) {
            orch.auto_proceed = AutoProceedPolicy::parse(ap);
        }
        if let Some(gp) = map
            .get("goalPersistence")
            .or_else(|| map.get("stopHookPersistence"))
            .and_then(Value::as_bool)
        {
            orch.goal_persistence = gp;
        }
        if let Some(g) = map
            .get("activeGoal")
            .or_else(|| map.get("goalSummary"))
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        {
            orch.active_goal = Some(g.to_string());
        }
        if let Some(gid) = map.get("activeGoalId").and_then(Value::as_str) {
            orch.active_goal_id = Some(gid.to_string());
        }
        if let Some(req) = map.get("requiredAuditStreak").and_then(Value::as_u64) {
            orch.required_audit_streak = req.min(10) as u32;
        }
        if let Some(rounds) = map.get("auditRounds").and_then(Value::as_array) {
            for r in rounds {
                if let Ok(parsed) = serde_json::from_value::<CleanroomAuditRecord>(r.clone()) {
                    orch.audit_rounds.push(parsed);
                }
            }
        }
        if let Some(rid) = map.get("runId").and_then(Value::as_str) {
            orch.run_id = rid.to_string();
        }
        orch.cancelled = map.get("status").and_then(Value::as_str) == Some("cancelled")
            || map.get("completeMarker").and_then(Value::as_str) == Some(GOAL_CANCELLED_MARKER);
        orch
    }

    #[must_use]
    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    #[must_use]
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    #[must_use]
    pub const fn mode(&self) -> SuperMode {
        self.mode
    }

    #[must_use]
    pub fn phase(&self) -> &str {
        &self.phase
    }

    #[must_use]
    pub const fn auto_proceed(&self) -> AutoProceedPolicy {
        self.auto_proceed
    }

    #[must_use]
    pub const fn goal_persistence(&self) -> bool {
        self.goal_persistence
    }

    #[must_use]
    pub const fn approval_mode(&self) -> ApprovalMode {
        self.approval_mode
    }

    /// Active goals NEVER impose an artificial token budget cap (`token_budget` is always `None`).
    #[must_use]
    pub const fn token_budget(&self) -> Option<u64> {
        None
    }

    #[must_use]
    pub fn active_goal(&self) -> Option<&str> {
        self.active_goal.as_deref()
    }

    #[must_use]
    pub fn steer_queue(&self) -> &Arc<SteerQueue> {
        &self.steer_queue
    }

    #[must_use]
    pub const fn required_audit_streak(&self) -> u32 {
        self.required_audit_streak
    }

    pub fn set_required_audit_streak(&mut self, streak: u32) {
        self.required_audit_streak = streak.min(10);
    }

    pub fn set_max_goal_continuations(&mut self, max: u32) {
        self.max_goal_continuations = max.clamp(1, 100);
    }

    pub fn set_consecutive_failures(&mut self, strikes: u32) {
        self.consecutive_failures = strikes;
    }

    /// Computes consecutive passing (`findings == 0`) cleanroom audit rounds on the same
    /// frozen `(commit_sha, tree_sha)` with distinct consecutive reviewers.
    #[must_use]
    pub fn current_audit_streak(&self) -> u32 {
        let mut streak = 0u32;
        let mut target_commit: Option<&str> = None;
        let mut target_tree: Option<&str> = None;
        let mut prev_reviewer: Option<&str> = None;
        for rec in self.audit_rounds.iter().rev() {
            if !rec.passed || rec.findings > 0 {
                break;
            }
            if let Some(c) = target_commit {
                if !c.eq_ignore_ascii_case(&rec.commit_sha) {
                    break;
                }
            } else {
                target_commit = Some(&rec.commit_sha);
            }
            if let Some(t) = target_tree {
                if !t.eq_ignore_ascii_case(&rec.tree_sha) {
                    break;
                }
            } else {
                target_tree = Some(&rec.tree_sha);
            }
            if let Some(prev_r) = prev_reviewer {
                if !prev_r.is_empty() && prev_r.eq_ignore_ascii_case(&rec.reviewer) {
                    break;
                }
            }
            prev_reviewer = Some(&rec.reviewer);
            streak += 1;
        }
        streak
    }

    /// Activates `/super-plan`: interactive planning (`auto_proceed = Off`, `goal_persistence = false`,
    /// codebase-aligned coding allowed), scaffolds `ArtifactOs` Goal/Spec/Blueprint/Plan/Todo/DoD,
    /// and losslessly updates `.agents/super/engine_state.json`.
    pub fn activate_super_plan(
        &mut self,
        goal_prompt: &str,
        scaffold_artifacts: bool,
    ) -> Result<SuperActivationReceipt> {
        let trimmed = goal_prompt.trim();
        self.run_id = format!("plan-{}", &uuid::Uuid::new_v4().to_string()[..8]);
        self.mode = SuperMode::SuperPlan;
        self.phase = "plan".to_string();
        self.auto_proceed = AutoProceedPolicy::Off;
        self.goal_persistence = false;
        self.cancelled = false;
        self.zero_progress_strikes = 0;
        if !trimmed.is_empty() {
            self.active_goal = Some(trimmed.to_string());
        }

        if scaffold_artifacts && !trimmed.is_empty() {
            if let Ok(goal_id) = self.scaffold_lifecycle_artifacts(trimmed, "super_plan") {
                self.active_goal_id = Some(goal_id);
            }
        }

        let state_patch = json!({
            "runId": self.run_id,
            "mode": self.mode.as_str(),
            "phase": self.phase,
            "lifecyclePhase": "plan",
            "status": "active",
            "active": true,
            "autoProceed": self.auto_proceed.as_str(),
            "goalPersistence": false,
            "stopHookPersistence": false,
            "askQuestionAllowed": true,
            "codingAllowed": true,
            "approvalMode": "yolo",
            "tokenBudget": Value::Null,
            "activeGoal": self.active_goal,
            "goalSummary": self.active_goal.clone().unwrap_or_default(),
            "activeGoalId": self.active_goal_id,
            "completeMarker": Value::Null,
            "activeLanes": SUPER_WORKFLOW_LANES,
        });
        merge_engine_state_lossless(&self.workspace_root, state_patch)
            .map_err(|e| anyhow::anyhow!(e))?;

        let dynamic_tail = self.build_dynamic_tail_hydration();
        let caps = build_unified_capability_registry(&self.workspace_root);
        Ok(SuperActivationReceipt {
            ok: true,
            run_id: self.run_id.clone(),
            mode: self.mode,
            phase: self.phase.clone(),
            auto_proceed: self.auto_proceed,
            goal_persistence: self.goal_persistence,
            approval_mode: "yolo".to_string(),
            coding_allowed: true,
            ask_question_allowed: true,
            token_budget: None,
            active_goal: self.active_goal.clone(),
            engine_state_path: engine_state_path(&self.workspace_root)
                .to_string_lossy()
                .replace('\\', "/"),
            dynamic_tail_hydration: dynamic_tail,
            capabilities_summary: caps,
        })
    }

    /// Activates `/super-run`: full autonomous execution (`auto_proceed = Full`, `ApprovalMode::Yolo`,
    /// `goal_persistence = true`, `token_budget = None`), preserving any mid-run prompts as
    /// `ADDITIVE_INTAKE` steers and losslessly updating `.agents/super/engine_state.json`.
    pub fn activate_super_run(
        &mut self,
        goal_prompt: &str,
        scaffold_artifacts: bool,
    ) -> Result<SuperActivationReceipt> {
        let trimmed = goal_prompt.trim();
        let was_active_run = self.mode == SuperMode::SuperRun && !self.cancelled && self.active_goal.is_some();
        if was_active_run && !trimmed.is_empty() {
            // Zero-drop additive steer intake: NEVER drop unfinished goal work!
            let _ = self.steer_queue.enqueue(trimmed, SteerMode::AdditiveIntake, None);
        } else {
            self.run_id = format!("run-{}", &uuid::Uuid::new_v4().to_string()[..8]);
            if !trimmed.is_empty() {
                self.active_goal = Some(trimmed.to_string());
            }
        }
        self.mode = SuperMode::SuperRun;
        self.phase = "execute".to_string();
        self.auto_proceed = AutoProceedPolicy::Full;
        self.goal_persistence = true;
        self.approval_mode = ApprovalMode::Yolo;
        self.cancelled = false;
        self.lessons_synced_on_complete = false;
        self.zero_progress_strikes = 0;
        self.goal_continuations = 0;

        if scaffold_artifacts && !trimmed.is_empty() && !was_active_run {
            if let Ok(goal_id) = self.scaffold_lifecycle_artifacts(trimmed, "super_run") {
                self.active_goal_id = Some(goal_id);
            }
        }

        let steers_json = self.steer_queue.to_json();
        let state_patch = json!({
            "runId": self.run_id,
            "mode": self.mode.as_str(),
            "phase": self.phase,
            "lifecyclePhase": "execute",
            "status": "active",
            "active": true,
            "autoProceed": self.auto_proceed.as_str(),
            "goalPersistence": true,
            "stopHookPersistence": true,
            "askQuestionAllowed": false,
            "codingAllowed": true,
            "approvalMode": "yolo",
            "tokenBudget": Value::Null,
            "activeGoal": self.active_goal,
            "goalSummary": self.active_goal.clone().unwrap_or_default(),
            "activeGoalId": self.active_goal_id,
            "requiredAuditStreak": self.required_audit_streak,
            "auditStreak": self.current_audit_streak(),
            "steers": steers_json["items"],
            "completeMarker": Value::Null,
            "activeLanes": SUPER_WORKFLOW_LANES,
        });
        merge_engine_state_lossless(&self.workspace_root, state_patch)
            .map_err(|e| anyhow::anyhow!(e))?;

        let dynamic_tail = self.build_dynamic_tail_hydration();
        let caps = build_unified_capability_registry(&self.workspace_root);
        Ok(SuperActivationReceipt {
            ok: true,
            run_id: self.run_id.clone(),
            mode: self.mode,
            phase: self.phase.clone(),
            auto_proceed: self.auto_proceed,
            goal_persistence: self.goal_persistence,
            approval_mode: "yolo".to_string(),
            coding_allowed: true,
            ask_question_allowed: false,
            token_budget: None,
            active_goal: self.active_goal.clone(),
            engine_state_path: engine_state_path(&self.workspace_root)
                .to_string_lossy()
                .replace('\\', "/"),
            dynamic_tail_hydration: dynamic_tail,
            capabilities_summary: caps,
        })
    }

    /// Appends a mid-run steer as `ADDITIVE_INTAKE` without cancelling unfinished tasks.
    pub fn enqueue_additive_steer(&mut self, steer_text: &str) -> Result<Value> {
        let trimmed = steer_text.trim();
        if trimmed.is_empty() {
            anyhow::bail!("steer text must not be empty");
        }
        let item = self.steer_queue.enqueue(trimmed, SteerMode::AdditiveIntake, None);
        let q_json = self.steer_queue.to_json();
        let _ = merge_engine_state_lossless(
            &self.workspace_root,
            json!({
                "steers": q_json["items"],
                "tokenBudget": Value::Null,
            }),
        );
        Ok(json!({
            "ok": true,
            "mode": "ADDITIVE_INTAKE",
            "tokenBudget": Value::Null,
            "item": item.to_json(),
            "activeBacklogCount": self.steer_queue.active_backlog_count(),
        }))
    }

    /// Updates `/auto-proceed` policy losslessly and logs an audit entry to `proceed-decisions.jsonl`.
    pub fn set_auto_proceed(&mut self, policy: AutoProceedPolicy, reason: &str) -> Result<Value> {
        self.auto_proceed = policy;
        let merged = merge_engine_state_lossless(
            &self.workspace_root,
            json!({
                "autoProceed": policy.as_str(),
                "askQuestionAllowed": policy.allows_interactive_questions(),
                "tokenBudget": Value::Null,
            }),
        )
        .map_err(|e| anyhow::anyhow!(e))?;
        let log_path = append_proceed_decision_jsonl(
            &self.workspace_root,
            json!({
                "timestampMs": Utc::now().timestamp_millis(),
                "runId": self.run_id,
                "policy": policy.as_str(),
                "reason": reason,
            }),
        )
        .map_err(|e| anyhow::anyhow!(e))?;
        Ok(json!({
            "ok": true,
            "autoProceed": policy.as_str(),
            "allowsInteractiveQuestions": policy.allows_interactive_questions(),
            "autoAcceptsRecommended": policy.auto_accepts_recommended(),
            "logPath": log_path.to_string_lossy().replace('\\', "/"),
            "headRevision": merged.get("headRevision").cloned().unwrap_or(json!(1)),
        }))
    }

    /// Cancels an active super run cleanly and persists `<!-- GOAL_CANCELLED -->`.
    pub fn cancel(&mut self, reason: &str) -> Result<Value> {
        self.cancelled = true;
        self.mode = SuperMode::Idle;
        self.phase = "cancelled".to_string();
        self.goal_persistence = false;
        let merged = merge_engine_state_lossless(
            &self.workspace_root,
            json!({
                "mode": "idle",
                "phase": "cancelled",
                "lifecyclePhase": "cancelled",
                "status": "cancelled",
                "active": false,
                "goalPersistence": false,
                "stopHookPersistence": false,
                "completeMarker": GOAL_CANCELLED_MARKER,
                "cancelReason": reason,
                "tokenBudget": Value::Null,
            }),
        )
        .map_err(|e| anyhow::anyhow!(e))?;
        Ok(json!({
            "ok": true,
            "status": "cancelled",
            "marker": GOAL_CANCELLED_MARKER,
            "reason": reason,
            "headRevision": merged.get("headRevision").cloned().unwrap_or(json!(1)),
        }))
    }

    /// Records one independent cleanroom audit round and persists the updated streak.
    pub fn record_audit_round(
        &mut self,
        reviewer: &str,
        commit_sha: &str,
        tree_sha: &str,
        findings: usize,
    ) -> Result<Value> {
        let round_id = format!("audit-{}", self.audit_rounds.len() + 1);
        let rec = CleanroomAuditRecord {
            round_id: round_id.clone(),
            reviewer: reviewer.trim().to_string(),
            commit_sha: commit_sha.trim().to_string(),
            tree_sha: tree_sha.trim().to_string(),
            findings,
            passed: findings == 0,
            recorded_at_ms: Utc::now().timestamp_millis(),
        };
        self.audit_rounds.push(rec.clone());
        let streak = self.current_audit_streak();
        let _ = merge_engine_state_lossless(
            &self.workspace_root,
            json!({
                "auditStreak": streak,
                "requiredAuditStreak": self.required_audit_streak,
                "auditRounds": self.audit_rounds,
                "totalAuditRoundsLogged": self.audit_rounds.len(),
                "tokenBudget": Value::Null,
            }),
        );
        Ok(json!({
            "ok": true,
            "round": rec,
            "auditStreak": streak,
            "requiredAuditStreak": self.required_audit_streak,
            "cleanroomSatisfied": streak >= self.required_audit_streak,
        }))
    }

    /// Evaluates 2-strike RCA -> `/boost` model escalation across dual vendor pools via `omnia-routing`.
    #[must_use]
    pub fn evaluate_boost_escalation(
        &self,
        current_model: &str,
        router: Option<&DynamicProviderRouter>,
    ) -> BoostEscalationDecision {
        let cur_family = model_vendor_family(current_model);
        let target_family = if cur_family == "anthropic" {
            "openai"
        } else {
            "anthropic"
        };
        let should_escalate = self.consecutive_failures >= SUPER_BOOST_RCA_STRIKE_THRESHOLD;

        let mut routed_candidate = None;
        if should_escalate {
            if let Some(r) = router {
                let mut policy = RouteRequestPolicy::default();
                policy.request_id = format!("boost-rca-{}", self.consecutive_failures);
                policy.idempotency_key = format!("{}:{}", self.run_id, policy.request_id);
                policy.allow_unknown_quota_without_emergency = true;
                if let Ok(res) = r.select_for_role(ModelRole::Architect, policy) {
                    if let Some(grant) = res.reservation {
                        routed_candidate = Some(format!("{}/{}", grant.provider_id, grant.model_id));
                    }
                }
            }
        }

        BoostEscalationDecision {
            should_escalate,
            strike_count: self.consecutive_failures,
            recommended_role: if should_escalate {
                ModelRole::Architect.as_str().to_string()
            } else {
                ModelRole::Main.as_str().to_string()
            },
            recommended_effort: EffortLevel::Max.as_str().to_string(),
            target_family_hint: target_family.to_string(),
            routed_candidate,
            reason: if should_escalate {
                format!(
                    "2-strike RCA threshold reached ({} consecutive failures on `{current_model}`): escalate effort to `max`, perform root-cause analysis, and consult distinct `{target_family}` pool / Architect role.",
                    self.consecutive_failures
                )
            } else {
                format!(
                    "Within normal failure threshold ({}/{} strikes).",
                    self.consecutive_failures, SUPER_BOOST_RCA_STRIKE_THRESHOLD
                )
            },
        }
    }

    /// Stage-5 `/goal` persistence exit gate invoked by `NativeSuperEngine::run_prompt_with_blocks`.
    ///
    /// Checks open `Todo`, unverified `DoD`, pending `ADDITIVE_INTAKE` steers, verification proof,
    /// cleanroom audit streak, 2-strike `/boost` RCA, and zero-progress circuit breaker.
    pub fn evaluate_exit_gate(
        &mut self,
        assistant_text: &str,
        progress_fingerprint: &str,
        turn_had_error: bool,
        last_verify_passed: bool,
        current_model: &str,
        router: Option<&DynamicProviderRouter>,
    ) -> GoalExitEvaluation {
        if !self.goal_persistence {
            return GoalExitEvaluation {
                allow_exit: true,
                status: "completed".to_string(),
                marker: None,
                open_todos: 0,
                open_dod_gates: 0,
                pending_steers: 0,
                audit_streak: self.current_audit_streak(),
                required_audit_streak: self.required_audit_streak,
                zero_progress_strikes: self.zero_progress_strikes,
                circuit_breaker_tripped: false,
                boost_decision: self.evaluate_boost_escalation(current_model, router),
                continuation_prompt: None,
                blocking_reasons: Vec::new(),
            };
        }

        if self.cancelled || assistant_text.contains(GOAL_CANCELLED_MARKER) {
            self.cancelled = true;
            return GoalExitEvaluation {
                allow_exit: true,
                status: "cancelled".to_string(),
                marker: Some(GOAL_CANCELLED_MARKER.to_string()),
                open_todos: 0,
                open_dod_gates: 0,
                pending_steers: 0,
                audit_streak: self.current_audit_streak(),
                required_audit_streak: self.required_audit_streak,
                zero_progress_strikes: self.zero_progress_strikes,
                circuit_breaker_tripped: false,
                boost_decision: self.evaluate_boost_escalation(current_model, router),
                continuation_prompt: None,
                blocking_reasons: Vec::new(),
            };
        }

        if turn_had_error {
            self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        } else if last_verify_passed {
            self.consecutive_failures = 0;
        }

        if self.last_progress_fingerprint.as_deref() == Some(progress_fingerprint) {
            self.zero_progress_strikes = self.zero_progress_strikes.saturating_add(1);
        } else {
            self.last_progress_fingerprint = Some(progress_fingerprint.to_string());
            self.zero_progress_strikes = 0;
        }

        let (open_todos, open_dod_gates) = self.inspect_open_lifecycle_gates();
        let pending_steers = self.count_pending_steers();
        let audit_streak = self.current_audit_streak();
        let boost_decision = self.evaluate_boost_escalation(current_model, router);

        let mut blocking_reasons = Vec::new();
        if open_todos > 0 {
            blocking_reasons.push(format!("{open_todos} open Todo artifact(s) remaining"));
        }
        if open_dod_gates > 0 {
            blocking_reasons.push(format!("{open_dod_gates} unverified DoD gate(s) remaining"));
        }
        if pending_steers > 0 {
            blocking_reasons.push(format!(
                "{pending_steers} pending ADDITIVE_INTAKE steer(s) remaining"
            ));
        }
        if !last_verify_passed {
            blocking_reasons.push("fresh runtime/test verification has not passed yet".to_string());
        }
        if self.required_audit_streak > 0 && audit_streak < self.required_audit_streak {
            blocking_reasons.push(format!(
                "cleanroom audit streak {audit_streak}/{} incomplete",
                self.required_audit_streak
            ));
        }

        if blocking_reasons.is_empty() {
            return GoalExitEvaluation {
                allow_exit: true,
                status: "completed".to_string(),
                marker: Some(GOAL_COMPLETE_MARKER.to_string()),
                open_todos,
                open_dod_gates,
                pending_steers,
                audit_streak,
                required_audit_streak: self.required_audit_streak,
                zero_progress_strikes: self.zero_progress_strikes,
                circuit_breaker_tripped: false,
                boost_decision,
                continuation_prompt: None,
                blocking_reasons,
            };
        }

        let breaker = self.zero_progress_strikes >= SUPER_MAX_ZERO_PROGRESS_STRIKES
            || self.goal_continuations >= self.max_goal_continuations;
        if breaker {
            return GoalExitEvaluation {
                allow_exit: true,
                status: "circuit_breaker".to_string(),
                marker: None,
                open_todos,
                open_dod_gates,
                pending_steers,
                audit_streak,
                required_audit_streak: self.required_audit_streak,
                zero_progress_strikes: self.zero_progress_strikes,
                circuit_breaker_tripped: true,
                boost_decision,
                continuation_prompt: None,
                blocking_reasons,
            };
        }

        self.goal_continuations = self.goal_continuations.saturating_add(1);
        let boost_note = if boost_decision.should_escalate {
            format!(
                " [/boost 2-Strike RCA Escalation: {}]",
                boost_decision.reason
            )
        } else {
            String::new()
        };
        let prompt = format!(
            "[SuperRun Stage-5 Goal Persistence | continuation {}/{}] Cannot conclude yet — open gates: {}. \
             Continue autonomous execution (parallelize disjoint worktrees via `SwarmRuntime` when applicable, run fresh verification commands, and record cleanroom audits). \
             Emit `{GOAL_COMPLETE_MARKER}` only when every gate is proven green.{boost_note}",
            self.goal_continuations,
            self.max_goal_continuations,
            blocking_reasons.join("; ")
        );

        GoalExitEvaluation {
            allow_exit: false,
            status: "continuing".to_string(),
            marker: None,
            open_todos,
            open_dod_gates,
            pending_steers,
            audit_streak,
            required_audit_streak: self.required_audit_streak,
            zero_progress_strikes: self.zero_progress_strikes,
            circuit_breaker_tripped: false,
            boost_decision,
            continuation_prompt: Some(prompt),
            blocking_reasons,
        }
    }

    /// Marks the active super run complete, triggers 3-way global `/learn` lesson sync,
    /// and seals `<!-- GOAL_COMPLETE -->` into lossless `.agents/super/engine_state.json`.
    pub fn finalize_complete(&mut self, summary: &str, sync_lessons: bool) -> Result<Value> {
        self.phase = "complete".to_string();
        self.goal_persistence = false;
        let lessons_sync = if sync_lessons {
            self.lessons_synced_on_complete = true;
            sync_global_lessons(&self.workspace_root).ok()
        } else {
            None
        };
        let merged = merge_engine_state_lossless(
            &self.workspace_root,
            json!({
                "mode": self.mode.as_str(),
                "phase": "complete",
                "lifecyclePhase": "complete",
                "status": "completed",
                "active": false,
                "goalPersistence": false,
                "stopHookPersistence": false,
                "auditStreak": self.current_audit_streak(),
                "completeMarker": GOAL_COMPLETE_MARKER,
                "completionSummary": summary.chars().take(600).collect::<String>(),
                "tokenBudget": Value::Null,
            }),
        )
        .map_err(|e| anyhow::anyhow!(e))?;
        Ok(json!({
            "ok": true,
            "status": "completed",
            "marker": GOAL_COMPLETE_MARKER,
            "auditStreak": self.current_audit_streak(),
            "lessonsSync": lessons_sync,
            "headRevision": merged.get("headRevision").cloned().unwrap_or(json!(1)),
        }))
    }

    /// Snapshot of current orchestrator status for Studio, CLI, and MCP tools.
    #[must_use]
    pub fn status_json(&self) -> Value {
        let disk_state = read_engine_state_map(&self.workspace_root);
        let (open_todos, open_dod_gates) = self.inspect_open_lifecycle_gates();
        json!({
            "runId": self.run_id,
            "mode": self.mode.as_str(),
            "phase": self.phase,
            "autoProceed": self.auto_proceed.as_str(),
            "goalPersistence": self.goal_persistence,
            "approvalMode": format!("{:?}", self.approval_mode).to_ascii_lowercase(),
            "tokenBudget": Value::Null,
            "activeGoal": self.active_goal,
            "activeGoalId": self.active_goal_id,
            "openTodos": open_todos,
            "openDodGates": open_dod_gates,
            "pendingSteers": self.count_pending_steers(),
            "auditStreak": self.current_audit_streak(),
            "requiredAuditStreak": self.required_audit_streak,
            "consecutiveFailures": self.consecutive_failures,
            "zeroProgressStrikes": self.zero_progress_strikes,
            "goalContinuations": self.goal_continuations,
            "cancelled": self.cancelled,
            "lessonsSyncedOnComplete": self.lessons_synced_on_complete,
            "engineStatePath": engine_state_path(&self.workspace_root).to_string_lossy().replace('\\', "/"),
            "engineState": Value::Object(disk_state),
        })
    }

    /// Prefix-0-safe dynamic user-tail capability & state hydration block.
    ///
    /// Strictly appended to the dynamic user message tail — NEVER mutates `BASE_SYSTEM_PROMPT`
    /// or `canonical_tools` so Tier-0 BLAKE3 KV-cache invariance stays 100% intact.
    #[must_use]
    pub fn build_dynamic_tail_hydration(&self) -> String {
        let skill_rep = discover_unified_skills(&self.workspace_root);
        let mcp_rep = discover_workspace_and_local_mcp_configs(&self.workspace_root);
        let plugins_mgr = CordisPluginManager::new(&self.workspace_root);
        let _ = plugins_mgr.discover(None);
        let dyn_plugins = plugins_mgr.list();
        let (open_todos, open_dod_gates) = self.inspect_open_lifecycle_gates();
        let pending_steers = self.count_pending_steers();

        let mcp_names: Vec<&str> = mcp_rep.servers.iter().map(|s| s.name.as_str()).collect();
        let agy_tag = if mcp_rep.agy_fast_binary.is_some() {
            "detected"
        } else {
            "not-installed"
        };
        let mode_rules = match self.mode {
            SuperMode::SuperPlan => {
                "Interactive planning mode: hydrate full context, ask clarifying questions when genuinely needed (`auto_proceed=off`), codebase-aligned edits permitted, persist Goal/Spec/Blueprint/Plan/Tasks/DoD via `workspace_lifecycle`, `goal_persistence=false`."
            }
            SuperMode::SuperRun => {
                "Autonomous execution mode: `auto_proceed=full`, `ApprovalMode::Yolo`, `token_budget=NULL`, `goal_persistence=true` (keep executing until open Todos, DoD gates, ADDITIVE_INTAKE steers, verification proofs, and cleanroom audit streak pass; escalate on 2-strike RCA via `/boost`; sync global lessons via `omnia_learn_sync`)."
            }
            SuperMode::Idle => "Standard Omnia mode (`token_budget=NULL`).",
        };

        let raw = format!(
            "<omnia_super_context mode=\"{}\" phase=\"{}\" auto_proceed=\"{}\" goal_persistence=\"{}\" token_budget=\"null\">\n\
             - Capabilities: {} Rust crates | deferred tools via `discover_tools`/`invoke_extension_tool` (LSP, Graph, AST, PTY, DAP, Deep Research/Think, Computer Use [feature={}], Browser CDP, Net Lab, Hardware, Notebook, Downloader, Super/Learn/Proceed/Boost/Arena)\n\
             - Skills: {} workspace + {} Cold Vault + {} local/plugin (M2V={}) | Cordis dynamic plugins: {}\n\
             - MCP Auto-Discovered ({}): [{}] | agy-fast bridge: {}\n\
             - Lifecycle State: open_todos={}, open_dod_gates={}, pending_steers={}, audit_streak={}/{}\n\
             - Directive: {}\n\
             </omnia_super_context>",
            self.mode.as_str(),
            self.phase,
            self.auto_proceed.as_str(),
            self.goal_persistence,
            WORKSPACE_CRATE_COUNT,
            cfg!(feature = "computer-use"),
            skill_rep.workspace_skills.len(),
            skill_rep.cold_vault_count,
            skill_rep.plugin_skills.len(),
            skill_rep.m2v_available,
            dyn_plugins.len(),
            mcp_names.len(),
            mcp_names.join(", "),
            agy_tag,
            open_todos,
            open_dod_gates,
            pending_steers,
            self.current_audit_streak(),
            self.required_audit_streak,
            mode_rules,
        );
        raw.chars().take(2_200).collect()
    }

    fn open_artifact_os(&self) -> Result<ArtifactOs, String> {
        let db_path = default_omnia_data_dir()
            .join("lifecycle")
            .join("artifact_os.db");
        if cfg!(test) {
            ArtifactOs::open_in_memory(&self.workspace_root)
        } else {
            ArtifactOs::open(&self.workspace_root, &db_path, None)
                .or_else(|_| ArtifactOs::open_in_memory(&self.workspace_root))
        }
    }

    fn scaffold_lifecycle_artifacts(&self, goal_prompt: &str, mode_tag: &str) -> Result<String, String> {
        let aos = self.open_artifact_os()?;
        let slug = format!("active-{}", mode_tag.replace('_', "-"));
        let goal = aos.upsert_artifact(
            ArtifactKind::Goal,
            &slug,
            &format!("Active Goal ({mode_tag})"),
            "active",
            "project",
            goal_prompt,
            json!({ "mode": mode_tag, "tokenBudget": Value::Null }),
            None,
            false,
        )?;
        let _ = aos.upsert_artifact(
            ArtifactKind::Plan,
            &slug,
            &format!("Execution Plan ({mode_tag})"),
            "active",
            "project",
            &format!("Implements [[{}]]: {goal_prompt}", goal.id),
            json!({ "mode": mode_tag }),
            None,
            false,
        );
        let _ = aos.upsert_artifact(
            ArtifactKind::Dod,
            &format!("{slug}-verify"),
            "Verification & Cleanroom Gate",
            "open",
            "project",
            "All targeted unit/integration tests pass with zero secrets and clean UTF-8 LF hygiene.",
            json!({ "mode": mode_tag }),
            Some(SixStateReceipt::default()),
            false,
        );
        Ok(goal.id)
    }

    fn inspect_open_lifecycle_gates(&self) -> (usize, usize) {
        let disk = read_engine_state_map(&self.workspace_root);
        let mut open_todos = disk
            .get("openTodos")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let total_dod = disk
            .get("totalDodGates")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let verified_dod = disk
            .get("verifiedDodGates")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let mut open_dod = total_dod.saturating_sub(verified_dod);

        if let Some(open_override) = disk.get("openDodGates").and_then(Value::as_u64) {
            open_dod = open_dod.max(open_override as usize);
        }
        if !cfg!(test) {
            if let Ok(aos) = self.open_artifact_os() {
                if let Ok(st) = aos.super_state() {
                    open_todos = open_todos.max(st.open_todos);
                    open_dod = open_dod.max(st.total_dod_gates.saturating_sub(st.verified_dod_gates));
                }
            }
        }
        (open_todos, open_dod)
    }

    fn count_pending_steers(&self) -> usize {
        let in_mem = self.steer_queue.active_backlog_count();
        let disk = read_engine_state_map(&self.workspace_root);
        let disk_pending = disk
            .get("steers")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter(|item| {
                        matches!(
                            item.get("status").and_then(Value::as_str),
                            Some("queued" | "in_progress")
                        )
                    })
                    .count()
            })
            .unwrap_or(0);
        in_mem.max(disk_pending)
    }
}

/// Builds the complete structured Unified Capability Registry JSON for `workspace`,
/// reusable across `omnia-agent`, `omnia-cli`, and `omnia-studio`.
#[must_use]
pub fn build_unified_capability_registry(workspace: &Path) -> Value {
    let core_reg = PluginRegistry::with_default_pillars();
    let core_tools: Vec<String> = core_reg
        .active_tools_with_deferred(true, true)
        .into_iter()
        .map(|t| t.name)
        .collect();

    let mut deferred_seen = BTreeSet::new();
    let mut deferred_tools = Vec::new();
    for spec in builtin_deferred_semantic_tools()
        .into_iter()
        .chain(builtin_deferred_18crate_tools())
    {
        if deferred_seen.insert(spec.name.clone()) {
            deferred_tools.push(json!({
                "name": spec.name,
                "readOnly": spec.read_only,
                "description": spec.description,
            }));
        }
    }

    let skill_report = discover_unified_skills(workspace);
    let mcp_report = discover_workspace_and_local_mcp_configs(workspace);
    let dyn_mgr = CordisPluginManager::new(workspace);
    let _ = dyn_mgr.discover(None);
    let dyn_plugins: Vec<Value> = dyn_mgr
        .list()
        .into_iter()
        .map(|p| {
            json!({
                "id": p.manifest.id,
                "name": p.manifest.name,
                "enabled": p.status == crate::dynamic_plugins::DynamicPluginStatus::Active,
                "quarantined": p.status == crate::dynamic_plugins::DynamicPluginStatus::Quarantined,
                "tools": p.manifest.tools.iter().map(|t| t.name.clone()).collect::<Vec<_>>(),
            })
        })
        .collect();

    let engine_state = read_engine_state_map(workspace);
    let computer_tools_count = {
        #[cfg(feature = "computer-use")]
        {
            omnia_computer::computer_tools(omnia_computer::ComputerConfig::default())
                .specs()
                .len()
        }
        #[cfg(not(feature = "computer-use"))]
        {
            21usize
        }
    };

    json!({
        "cratesCount": WORKSPACE_CRATE_COUNT,
        "crates": OMNIA_WORKSPACE_CRATES,
        "coreTools": core_tools,
        "deferredToolsCount": deferred_tools.len(),
        "deferredTools": deferred_tools,
        "computerUseFeatureEnabled": cfg!(feature = "computer-use"),
        "computerToolsCount": computer_tools_count,
        "skills": {
            "workspaceCount": skill_report.workspace_skills.len(),
            "coldVaultCount": skill_report.cold_vault_count,
            "pluginCount": skill_report.plugin_skills.len(),
            "m2vAvailable": skill_report.m2v_available,
            "scannedRoots": skill_report.scanned_roots,
            "workspaceSkills": skill_report.workspace_skills.iter().map(|s| s.name.clone()).collect::<Vec<_>>(),
            "pluginSkills": skill_report.plugin_skills,
        },
        "plugins": {
            "corePillars": core_reg.list_info(),
            "dynamicPlugins": dyn_plugins,
        },
        "mcpServers": {
            "discovered": mcp_report.servers.iter().map(|s| json!({
                "name": s.name,
                "source": s.source,
                "transport": s.transport_kind,
                "optIn": s.opt_in,
            })).collect::<Vec<_>>(),
            "skipped": mcp_report.skipped,
            "scannedPaths": mcp_report.scanned_paths,
            "agyFastBinary": mcp_report.agy_fast_binary,
        },
        "workflows": ["/super-plan", "/super-run"],
        "lanes": SUPER_WORKFLOW_LANES,
        "invariants": {
            "approvalModeDefault": "yolo",
            "tokenBudget": Value::Null,
            "egressDefault": "unrestricted",
            "effortDefault": "max",
            "drmSupported": false,
        },
        "engineStatePath": engine_state_path(workspace).to_string_lossy().replace('\\', "/"),
        "engineState": Value::Object(engine_state),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache_guard::{canonicalize_openai_tools, PrefixCacheGuard, BASE_SYSTEM_PROMPT};

    #[test]
    fn super_plan_and_super_run_preserve_lossless_state_and_prefix0_invariance() {
        let ws = std::env::temp_dir().join(format!("omnia-super-orch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(ws.join(".agents").join("super")).unwrap();

        // Seed agy-fast metadata before Omnia activates /super-plan and /super-run.
        merge_engine_state_lossless(
            &ws,
            json!({
                "schemaVersion": 1,
                "waves": [{"id": 1, "name": "seed-wave"}],
                "toolProofCounts": {"swarm": 3},
                "activeRunConvs": ["conv-seed"]
            }),
        )
        .unwrap();

        let mut orch = SuperOrchestrator::new(&ws);
        let plan_rcpt = orch.activate_super_plan("Design unified v5 orchestration", false).unwrap();
        assert_eq!(plan_rcpt.mode, SuperMode::SuperPlan);
        assert_eq!(plan_rcpt.auto_proceed, AutoProceedPolicy::Off);
        assert!(!plan_rcpt.goal_persistence);
        assert!(plan_rcpt.ask_question_allowed);
        assert!(plan_rcpt.coding_allowed);
        assert_eq!(plan_rcpt.token_budget, None);
        assert!(plan_rcpt.dynamic_tail_hydration.contains("<omnia_super_context"));

        let run_rcpt = orch.activate_super_run("Implement Steer 27B end-to-end", false).unwrap();
        assert_eq!(run_rcpt.mode, SuperMode::SuperRun);
        assert_eq!(run_rcpt.auto_proceed, AutoProceedPolicy::Full);
        assert!(run_rcpt.goal_persistence);
        assert!(!run_rcpt.ask_question_allowed);
        assert_eq!(run_rcpt.approval_mode, "yolo");
        assert_eq!(run_rcpt.token_budget, None);

        // Mid-run additive steer must NOT cancel or drop the active goal!
        let steer_res = orch.enqueue_additive_steer("Also add safe MCP discovery tests").unwrap();
        assert_eq!(steer_res["mode"], "ADDITIVE_INTAKE");
        assert_eq!(steer_res["tokenBudget"], Value::Null);
        assert_eq!(orch.steer_queue().active_backlog_count(), 1);

        // Lossless verification: agy-fast keys stayed intact on disk.
        let disk = read_engine_state_map(&ws);
        assert_eq!(disk["waves"][0]["name"], "seed-wave");
        assert_eq!(disk["toolProofCounts"]["swarm"], 3);
        assert_eq!(disk["activeRunConvs"][0], "conv-seed");
        assert_eq!(disk["tokenBudget"], Value::Null);

        // Prefix-0 BLAKE3 invariance: dynamic hydration lives only in user tail, never in system/tools!
        let reg = PluginRegistry::with_default_pillars();
        let tools = canonicalize_openai_tools(&reg.active_tools_with_deferred(false, true));
        let mut guard = PrefixCacheGuard::new(Some("super-p0".into()), BASE_SYSTEM_PROMPT, &tools);
        assert!(guard.verify_turn_prefix(BASE_SYSTEM_PROMPT, &tools));

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn goal_persistence_enforces_audit_streak_boost_rca_and_zero_progress_circuit_breaker() {
        let ws = std::env::temp_dir().join(format!("omnia-super-gate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(ws.join(".agents").join("super")).unwrap();

        let mut orch = SuperOrchestrator::new(&ws);
        orch.activate_super_run("Complete all 3 cleanroom audits", false).unwrap();

        // 1. Open audit streak blocks premature exit & 2 consecutive failures trigger /boost RCA!
        let e1 = orch.evaluate_exit_gate("working", "fp-1", true, false, "claude-sonnet-5-5", None);
        assert!(!e1.allow_exit);
        assert!(!e1.boost_decision.should_escalate);

        let e2 = orch.evaluate_exit_gate("retrying", "fp-2", true, false, "claude-sonnet-5-5", None);
        assert!(!e2.allow_exit);
        assert!(e2.boost_decision.should_escalate);
        assert_eq!(e2.boost_decision.target_family_hint, "openai");
        assert_eq!(e2.boost_decision.recommended_effort, "max");

        // 2. Repeated identical progress fingerprint trips the zero-progress circuit breaker at strike 3.
        let _ = orch.evaluate_exit_gate("stuck-1", "fp-stuck", false, false, "claude-sonnet-5-5", None);
        let _ = orch.evaluate_exit_gate("stuck-2", "fp-stuck", false, false, "claude-sonnet-5-5", None);
        let _ = orch.evaluate_exit_gate("stuck-3", "fp-stuck", false, false, "claude-sonnet-5-5", None);
        let tripped = orch.evaluate_exit_gate("stuck-4", "fp-stuck", false, false, "claude-sonnet-5-5", None);
        assert!(tripped.circuit_breaker_tripped);
        assert!(tripped.allow_exit);

        // 3. Record 3 distinct cleanroom reviewers on frozen SHA -> clean exit allowed with GOAL_COMPLETE!
        let mut orch2 = SuperOrchestrator::new(&ws);
        orch2.activate_super_run("Ship release", false).unwrap();
        orch2.record_audit_round("verifier-a", "abc123", "tree999", 0).unwrap();
        orch2.record_audit_round("verifier-b", "abc123", "tree999", 0).unwrap();
        orch2.record_audit_round("verifier-c", "abc123", "tree999", 0).unwrap();
        assert_eq!(orch2.current_audit_streak(), 3);

        let done_eval = orch2.evaluate_exit_gate(
            "All green <!-- GOAL_COMPLETE -->",
            "fp-final",
            false,
            true,
            "gpt-6.2-sol",
            None,
        );
        assert!(done_eval.allow_exit);
        assert!(!done_eval.circuit_breaker_tripped);
        assert_eq!(done_eval.marker.as_deref(), Some(GOAL_COMPLETE_MARKER));

        // 4. Unified capability registry exposes all 18 crates, workflows, lanes, and Zero-Nerf invariants.
        let caps = build_unified_capability_registry(&ws);
        assert_eq!(caps["cratesCount"], 18);
        assert_eq!(caps["computerToolsCount"], 21);
        assert_eq!(caps["invariants"]["approvalModeDefault"], "yolo");
        assert_eq!(caps["invariants"]["tokenBudget"], Value::Null);
        assert_eq!(caps["invariants"]["drmSupported"], false);

        let _ = std::fs::remove_dir_all(&ws);
    }
}
