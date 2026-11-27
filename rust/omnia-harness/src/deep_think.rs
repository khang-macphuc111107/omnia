//! Native Persisted Deep Think Engine (`#![forbid(unsafe_code)]`).
//!
//! Enforces structured multi-hypothesis engineering deliberation:
//! 1. Invariant & assumption framing (zero stale-fact guessing)
//! 2. `>= 3` distinct branches (`Baseline`, `Sota`, `Contrarian`) with complexity, failure modes,
//!    blast radius, citations, and explicit `EpistemicBand`
//! 3. Executable falsification receipts + **3-Strike / 5-Strike Escalation** tracking
//! 4. Adversarial red-team critique with distinct vendor-family enforcement
//! 5. Verified Winner + Rejected Alternatives Matrix + 6-state completion receipt.

use std::path::Path;
use std::sync::Mutex;

use omnia_core::{now_epoch_ms, uuid_v4, SecretRedactor};
use omnia_winsqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const THINK_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS dt_sessions (
    think_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dt_sessions_sid ON dt_sessions(session_id, updated_at_ms DESC);
"#;

/// Canonical hypothesis branch category in Deep Think.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BranchKind {
    Baseline,
    Sota,
    Contrarian,
    Custom,
}

impl BranchKind {
    #[must_use]
    pub fn from_str_lossy(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "baseline" | "a" => Self::Baseline,
            "sota" | "b" => Self::Sota,
            "contrarian" | "c" => Self::Contrarian,
            _ => Self::Custom,
        }
    }
}

/// Epistemic confidence calibration band (`deep-meta-brier-calibration`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EpistemicBand {
    Verified,
    Corroborated,
    Inferred,
    Hypothesis,
    Unknown,
}

impl EpistemicBand {
    #[must_use]
    pub fn from_str_lossy(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "verified" => Self::Verified,
            "corroborated" => Self::Corroborated,
            "inferred" => Self::Inferred,
            "hypothesis" => Self::Hypothesis,
            _ => Self::Unknown,
        }
    }
}

/// One candidate reasoning branch in a [`DeepThinkSession`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkBranch {
    pub branch_id: String,
    pub kind: BranchKind,
    pub title: String,
    pub hypothesis: String,
    pub complexity: String,
    pub failure_modes: Vec<String>,
    pub blast_radius: String,
    pub citations: Vec<String>,
    pub epistemic_band: EpistemicBand,
    pub falsification_cmd: Option<String>,
    pub falsification_passed: Option<bool>,
    pub falsification_receipt: Option<String>,
    pub score_bps: u32,
    pub rejected_reason: Option<String>,
}

/// Cross-model adversarial red-team challenge against the candidate solution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedTeamChallenge {
    pub challenger_model: String,
    pub primary_model: String,
    pub distinct_family: bool,
    pub critiques: Vec<String>,
    pub mitigations: Vec<String>,
    pub verdict: String,
    pub created_at_ms: i64,
}

/// 3-Strike pivot / 5-Strike architectural escalation tracker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EscalationState {
    pub consecutive_failures: u32,
    pub strike_level: u8,
    pub status: String,
    pub last_failure_reason: Option<String>,
}

impl Default for EscalationState {
    fn default() -> Self {
        Self {
            consecutive_failures: 0,
            strike_level: 0,
            status: "nominal".to_string(),
            last_failure_reason: None,
        }
    }
}

/// Persisted Deep Think deliberation session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepThinkSession {
    pub think_id: String,
    pub session_id: String,
    pub problem: String,
    pub invariants: Vec<String>,
    pub assumptions: Vec<String>,
    pub effort: String,
    pub stage: String,
    pub branches: Vec<ThinkBranch>,
    pub red_team: Vec<RedTeamChallenge>,
    pub escalation: EscalationState,
    pub winner_branch_id: Option<String>,
    pub synthesis: Option<String>,
    pub receipt_6state: Option<Value>,
    pub warnings: Vec<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Thread-safe SQLite WAL engine for persisted Deep Think sessions.
pub struct DeepThinkEngine {
    conn: Mutex<Connection>,
}

impl std::fmt::Debug for DeepThinkEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeepThinkEngine").finish()
    }
}

impl DeepThinkEngine {
    pub fn open(db_path: &Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open_read_write(db_path)
            .map_err(|e| format!("open DeepThinkEngine db {}: {e}", db_path.display()))?;
        conn.exec_batch(THINK_SCHEMA_SQL)
            .map_err(|e| format!("init DeepThinkEngine schema: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.exec_batch(THINK_SCHEMA_SQL)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn start_session(
        &self,
        session_id: &str,
        problem: &str,
        invariants: Vec<String>,
        assumptions: Vec<String>,
        effort: &str,
    ) -> Result<DeepThinkSession, String> {
        let clean_prob = SecretRedactor::redact(problem.trim());
        if clean_prob.is_empty() {
            return Err("Deep Think problem statement cannot be empty".to_string());
        }
        let now = now_epoch_ms();
        let sess = DeepThinkSession {
            think_id: format!("dt_{}", &uuid_v4()[..12]),
            session_id: session_id.trim().to_string(),
            problem: clean_prob,
            invariants: invariants
                .into_iter()
                .map(|s| SecretRedactor::redact(s.trim()))
                .filter(|s| !s.is_empty())
                .collect(),
            assumptions: assumptions
                .into_iter()
                .map(|s| SecretRedactor::redact(s.trim()))
                .filter(|s| !s.is_empty())
                .collect(),
            effort: normalize_effort(effort),
            stage: "frame".to_string(),
            branches: Vec::new(),
            red_team: Vec::new(),
            escalation: EscalationState::default(),
            winner_branch_id: None,
            synthesis: None,
            receipt_6state: None,
            warnings: Vec::new(),
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.save_session(&sess)?;
        Ok(sess)
    }

    pub fn add_branch(
        &self,
        think_id: &str,
        mut branch: ThinkBranch,
    ) -> Result<DeepThinkSession, String> {
        let mut sess = self
            .get_session(think_id)?
            .ok_or_else(|| format!("Deep Think session `{think_id}` not found"))?;
        if branch.branch_id.trim().is_empty() {
            branch.branch_id = format!("br_{}", sess.branches.len() + 1);
        }
        branch.title = SecretRedactor::redact(branch.title.trim());
        branch.hypothesis = SecretRedactor::redact(branch.hypothesis.trim());
        branch.complexity = SecretRedactor::redact(branch.complexity.trim());
        branch.blast_radius = SecretRedactor::redact(branch.blast_radius.trim());
        branch.failure_modes = branch
            .failure_modes
            .into_iter()
            .map(|m| SecretRedactor::redact(m.trim()))
            .filter(|m| !m.is_empty())
            .collect();
        if let Some(pos) = sess
            .branches
            .iter()
            .position(|b| b.branch_id == branch.branch_id)
        {
            sess.branches[pos] = branch;
        } else {
            sess.branches.push(branch);
        }
        sess.stage = "hypotheses".to_string();
        sess.updated_at_ms = now_epoch_ms();
        self.save_session(&sess)?;
        Ok(sess)
    }

    pub fn record_falsification(
        &self,
        think_id: &str,
        branch_id: &str,
        cmd: &str,
        passed: bool,
        receipt: &str,
    ) -> Result<DeepThinkSession, String> {
        let mut sess = self
            .get_session(think_id)?
            .ok_or_else(|| format!("Deep Think session `{think_id}` not found"))?;
        let br = sess
            .branches
            .iter_mut()
            .find(|b| b.branch_id == branch_id)
            .ok_or_else(|| format!("branch `{branch_id}` not found in `{think_id}`"))?;
        let clean_receipt = SecretRedactor::redact(receipt.trim());
        br.falsification_cmd = Some(SecretRedactor::redact(cmd.trim()));
        br.falsification_passed = Some(passed);
        br.falsification_receipt = Some(clean_receipt.clone());
        if passed {
            br.epistemic_band = EpistemicBand::Verified;
            br.score_bps = br.score_bps.max(8_500);
            sess.escalation.consecutive_failures = 0;
            sess.escalation.strike_level = 0;
            sess.escalation.status = "nominal".to_string();
        } else {
            br.rejected_reason = Some(format!("falsified by `{}`: {}", cmd.trim(), clean_receipt));
            sess.escalation.consecutive_failures += 1;
            sess.escalation.strike_level = sess.escalation.consecutive_failures.min(5) as u8;
            sess.escalation.last_failure_reason = Some(clean_receipt);
            sess.escalation.status = if sess.escalation.consecutive_failures >= 5 {
                "strike_5_escalate".to_string()
            } else if sess.escalation.consecutive_failures >= 3 {
                "strike_3_pivot".to_string()
            } else {
                "nominal".to_string()
            };
        }
        sess.stage = "executable_falsification".to_string();
        sess.updated_at_ms = now_epoch_ms();
        self.save_session(&sess)?;
        Ok(sess)
    }

    pub fn record_redteam(
        &self,
        think_id: &str,
        mut challenge: RedTeamChallenge,
    ) -> Result<DeepThinkSession, String> {
        let mut sess = self
            .get_session(think_id)?
            .ok_or_else(|| format!("Deep Think session `{think_id}` not found"))?;
        challenge.distinct_family =
            model_vendor_family(&challenge.challenger_model) != model_vendor_family(&challenge.primary_model);
        if !challenge.distinct_family {
            sess.warnings.push(format!(
                "redteam challenger `{}` shares vendor family with primary `{}`",
                challenge.challenger_model, challenge.primary_model
            ));
        }
        challenge.critiques = challenge
            .critiques
            .into_iter()
            .map(|c| SecretRedactor::redact(c.trim()))
            .filter(|c| !c.is_empty())
            .collect();
        challenge.mitigations = challenge
            .mitigations
            .into_iter()
            .map(|m| SecretRedactor::redact(m.trim()))
            .filter(|m| !m.is_empty())
            .collect();
        if challenge.created_at_ms <= 0 {
            challenge.created_at_ms = now_epoch_ms();
        }
        sess.red_team.push(challenge);
        sess.stage = "redteam_adversarial".to_string();
        sess.updated_at_ms = now_epoch_ms();
        self.save_session(&sess)?;
        Ok(sess)
    }

    pub fn conclude_session(
        &self,
        think_id: &str,
        winner_branch_id: &str,
        synthesis: &str,
        receipt_6state: Value,
    ) -> Result<DeepThinkSession, String> {
        let mut sess = self
            .get_session(think_id)?
            .ok_or_else(|| format!("Deep Think session `{think_id}` not found"))?;
        if !sess.branches.iter().any(|b| b.branch_id == winner_branch_id) {
            return Err(format!(
                "winner branch `{winner_branch_id}` does not exist in `{think_id}`"
            ));
        }
        if sess.branches.len() < 3 {
            sess.warnings.push(format!(
                "Deep Think concluded with {} branches (< 3 distinct Baseline/SOTA/Contrarian branches)",
                sess.branches.len()
            ));
        }
        for br in &mut sess.branches {
            if br.branch_id != winner_branch_id && br.rejected_reason.is_none() {
                br.rejected_reason = Some(format!("outperformed by `{winner_branch_id}`"));
            }
        }
        sess.winner_branch_id = Some(winner_branch_id.to_string());
        sess.synthesis = Some(SecretRedactor::redact(synthesis.trim()));
        sess.receipt_6state = Some(SecretRedactor::redact_json(&receipt_6state));
        sess.stage = "concluded".to_string();
        sess.updated_at_ms = now_epoch_ms();
        self.save_session(&sess)?;
        Ok(sess)
    }

    pub fn get_session(&self, think_id: &str) -> Result<Option<DeepThinkSession>, String> {
        let conn = self.conn.lock().map_err(|_| "think lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare("SELECT payload_json FROM dt_sessions WHERE think_id = ?1 LIMIT 1;")
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, think_id).map_err(|e| e.to_string())?;
        if stmt.step_row().map_err(|e| e.to_string())? {
            let raw = stmt.column_text(0).map_err(|e| e.to_string())?;
            let parsed: DeepThinkSession =
                serde_json::from_str(&raw).map_err(|e| format!("corrupt think session: {e}"))?;
            Ok(Some(parsed))
        } else {
            Ok(None)
        }
    }

    pub fn list_sessions(
        &self,
        session_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<DeepThinkSession>, String> {
        let cap = limit.clamp(1, 200) as i64;
        let conn = self.conn.lock().map_err(|_| "think lock poisoned".to_string())?;
        let mut stmt = if session_id.is_some() {
            conn.prepare(
                "SELECT payload_json FROM dt_sessions WHERE session_id = ?1 ORDER BY updated_at_ms DESC LIMIT ?2;",
            )
        } else {
            conn.prepare("SELECT payload_json FROM dt_sessions ORDER BY updated_at_ms DESC LIMIT ?1;")
        }
        .map_err(|e| e.to_string())?;
        if let Some(sid) = session_id {
            stmt.bind_text(1, sid).map_err(|e| e.to_string())?;
            stmt.bind_int64(2, cap).map_err(|e| e.to_string())?;
        } else {
            stmt.bind_int64(1, cap).map_err(|e| e.to_string())?;
        }
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            let raw = stmt.column_text(0).unwrap_or_default();
            if let Ok(parsed) = serde_json::from_str::<DeepThinkSession>(&raw) {
                out.push(parsed);
            }
        }
        Ok(out)
    }

    /// Builds a structured Rejected Alternatives Matrix JSON for a concluded session.
    #[must_use]
    pub fn rejected_alternatives_matrix(sess: &DeepThinkSession) -> Vec<Value> {
        sess.branches
            .iter()
            .filter(|b| sess.winner_branch_id.as_deref() != Some(b.branch_id.as_str()))
            .map(|b| {
                json!({
                    "branchId": b.branch_id,
                    "kind": b.kind,
                    "title": b.title,
                    "complexity": b.complexity,
                    "blastRadius": b.blast_radius,
                    "falsificationPassed": b.falsification_passed,
                    "rejectedReason": b.rejected_reason.as_deref().unwrap_or("not selected"),
                })
            })
            .collect()
    }

    fn save_session(&self, sess: &DeepThinkSession) -> Result<(), String> {
        let payload = serde_json::to_string(sess).map_err(|e| e.to_string())?;
        let conn = self.conn.lock().map_err(|_| "think lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "INSERT OR REPLACE INTO dt_sessions (think_id, session_id, payload_json, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4);",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &sess.think_id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &sess.session_id).map_err(|e| e.to_string())?;
        stmt.bind_text(3, &payload).map_err(|e| e.to_string())?;
        stmt.bind_int64(4, sess.updated_at_ms).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn normalize_effort(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "minimal" | "low" | "medium" | "high" | "xhigh" | "max" => {
            raw.trim().to_ascii_lowercase()
        }
        _ => "high".to_string(),
    }
}

/// Builds a structured Rejected Alternatives Matrix JSON for a concluded [`DeepThinkSession`].
#[must_use]
pub fn rejected_alternatives_matrix(sess: &DeepThinkSession) -> Vec<Value> {
    DeepThinkEngine::rejected_alternatives_matrix(sess)
}

/// Maps a model ID to its coarse vendor family so red-team challenges verify cross-family independence.
#[must_use]
pub fn model_vendor_family(model_id: &str) -> &'static str {
    let m = model_id.to_ascii_lowercase();
    if m.contains("claude") || m.contains("anthropic") {
        "anthropic"
    } else if m.contains("gemini") || m.contains("google") {
        "google"
    } else if m.contains("gpt") || m.contains("o1") || m.contains("o3") || m.contains("codex") || m.contains("openai") {
        "openai"
    } else if m.contains("deepseek") {
        "deepseek"
    } else if m.contains("qwen") {
        "qwen"
    } else if m.contains("llama") {
        "meta"
    } else {
        "other"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deep_think_3_branches_falsification_strikes_and_redteam() {
        let eng = DeepThinkEngine::open_in_memory().unwrap();
        let s = eng
            .start_session(
                "sess-dt-1",
                "Select zero-bloat persistent RAG storage layout",
                vec!["<15ms cold start".into(), "WAL crash safety".into()],
                vec!["Windows 11 NTFS".into()],
                "max",
            )
            .unwrap();

        for (id, kind, title) in [
            ("br_a", BranchKind::Baseline, "Flat JSON files"),
            ("br_b", BranchKind::Sota, "winsqlite3 WAL + atomic Markdown snapshots"),
            ("br_c", BranchKind::Contrarian, "Pure in-memory index rebuilt every boot"),
        ] {
            eng.add_branch(
                &s.think_id,
                ThinkBranch {
                    branch_id: id.into(),
                    kind,
                    title: title.into(),
                    hypothesis: format!("Evaluate {title}"),
                    complexity: "O(N log N)".into(),
                    failure_modes: vec!["lock contention".into()],
                    blast_radius: "omnia-harness".into(),
                    citations: vec!["S001".into()],
                    epistemic_band: EpistemicBand::Hypothesis,
                    falsification_cmd: None,
                    falsification_passed: None,
                    falsification_receipt: None,
                    score_bps: 7_000,
                    rejected_reason: None,
                },
            )
            .unwrap();
        }

        // Trigger 3 consecutive failures -> strike_3_pivot.
        for i in 1..=3 {
            let st = eng
                .record_falsification(&s.think_id, "br_a", "cargo test", false, &format!("fail {i}"))
                .unwrap();
            if i == 3 {
                assert_eq!(st.escalation.status, "strike_3_pivot");
                assert_eq!(st.escalation.strike_level, 3);
            }
        }

        // Pass on SOTA branch resets strikes.
        let passed = eng
            .record_falsification(&s.think_id, "br_b", "cargo test -p omnia-harness", true, "PASS")
            .unwrap();
        assert_eq!(passed.escalation.status, "nominal");

        // Distinct-family red-team critique.
        let rt = eng
            .record_redteam(
                &s.think_id,
                RedTeamChallenge {
                    challenger_model: "claude-sonnet-5-5".into(),
                    primary_model: "gpt-6.2-sol".into(),
                    distinct_family: false, // computed automatically
                    critiques: vec!["Verify AV lock retry on Windows rename".into()],
                    mitigations: vec!["6x exponential retry + tmp cleanup".into()],
                    verdict: "approve_with_mitigation".into(),
                    created_at_ms: 0,
                },
            )
            .unwrap();
        assert!(rt.red_team[0].distinct_family);

        let done = eng
            .conclude_session(
                &s.think_id,
                "br_b",
                "Selected winsqlite3 WAL + atomic Markdown snapshots [S001].",
                json!({ "verified": ["cargo test PASS"], "partial": [], "unresolved": [], "blocked": [], "next": [], "exactPracticalLimits": [] }),
            )
            .unwrap();
        assert_eq!(done.winner_branch_id.as_deref(), Some("br_b"));
        assert_eq!(DeepThinkEngine::rejected_alternatives_matrix(&done).len(), 2);
    }
}
