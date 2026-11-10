//! Native admission contract for Omnia's bounded supervisor/PM/worker topology.
//!
//! This module deliberately stops at an authoritative validation boundary.  It
//! does not spawn providers or processes.  A future SQLite adapter can persist
//! the accepted snapshot and lease records without changing the invariants
//! exercised here.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OrchestrationRole {
    Supervisor,
    ProjectManager,
    Worker,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AgentAdmission {
    pub agent_id: String,
    pub role: OrchestrationRole,
    pub goal_id: String,
    pub run_id: String,
    pub parent_id: Option<String>,
    pub lane: Option<String>,
    pub ownership: Vec<String>,
    pub stop_condition: String,
    pub lease_id: String,
    pub lease_expires_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TieredAdmissionRequest {
    pub goal_id: String,
    pub run_id: String,
    pub expected_version: u64,
    pub worker_quota: usize,
    pub agents: Vec<AgentAdmission>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TieredAdmissionReceipt {
    pub goal_id: String,
    pub run_id: String,
    pub version: u64,
    pub supervisor_id: String,
    pub project_manager_ids: Vec<String>,
    pub worker_count: usize,
    pub lease_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseState {
    Active,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionError {
    Invalid(&'static str),
    Conflict(&'static str),
    QuotaExceeded,
}

#[derive(Debug, Default)]
pub struct TieredOrchestrator {
    version: u64,
    admitted: Option<TieredAdmissionReceipt>,
    leases: HashMap<String, i64>,
}

impl TieredOrchestrator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn admit(
        &mut self,
        request: TieredAdmissionRequest,
        now_ms: i64,
    ) -> Result<TieredAdmissionReceipt, AdmissionError> {
        if request.expected_version != self.version {
            return Err(AdmissionError::Conflict("stale-version"));
        }
        let validated = validate_admission(&request, now_ms)?;
        let next_version = self.version + 1;
        let receipt = TieredAdmissionReceipt {
            goal_id: request.goal_id,
            run_id: request.run_id,
            version: next_version,
            supervisor_id: validated.supervisor_id,
            project_manager_ids: validated.project_manager_ids,
            worker_count: validated.worker_count,
            lease_ids: request
                .agents
                .iter()
                .map(|agent| agent.lease_id.clone())
                .collect(),
        };
        self.leases = request
            .agents
            .into_iter()
            .map(|agent| (agent.lease_id, agent.lease_expires_at_ms))
            .collect();
        self.version = next_version;
        self.admitted = Some(receipt.clone());
        Ok(receipt)
    }

    pub fn validate(
        request: &TieredAdmissionRequest,
        now_ms: i64,
    ) -> Result<ValidatedAdmission, AdmissionError> {
        validate_admission(request, now_ms)
    }

    pub fn lease_state(&self, lease_id: &str, now_ms: i64) -> Option<LeaseState> {
        self.leases.get(lease_id).map(|expires| {
            if *expires > now_ms {
                LeaseState::Active
            } else {
                LeaseState::Expired
            }
        })
    }

    pub fn heartbeat(
        &mut self,
        lease_id: &str,
        expected_version: u64,
        expires_at_ms: i64,
    ) -> Result<(), AdmissionError> {
        if expected_version != self.version {
            return Err(AdmissionError::Conflict("stale-version"));
        }
        if expires_at_ms <= 0 {
            return Err(AdmissionError::Invalid("lease-expiry-required"));
        }
        let current = self
            .leases
            .get_mut(lease_id)
            .ok_or(AdmissionError::Invalid("unknown-lease"))?;
        *current = expires_at_ms;
        Ok(())
    }

    pub fn receipt(&self) -> Option<&TieredAdmissionReceipt> {
        self.admitted.as_ref()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedAdmission {
    pub supervisor_id: String,
    pub project_manager_ids: Vec<String>,
    pub worker_count: usize,
}

/// Ownership names are logical paths relative to one admitted workspace, not
/// arbitrary OS paths or glob patterns. Restrict to portable ASCII components
/// so case folding is deterministic on every host. Physical file identity
/// (junctions, symlinks, hard links and short names) still needs a native check
/// before a dispatcher grants filesystem write authority.
fn ownership_key(path: &str) -> Result<String, AdmissionError> {
    if path.is_empty() || path.len() > 4096 || !path.is_ascii() {
        return Err(AdmissionError::Invalid("invalid-ownership-path"));
    }
    let key = path.replace('\\', "/").to_ascii_lowercase();
    for component in key.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.ends_with(['.', ' '])
            || component
                .bytes()
                .any(|byte| byte < 32 || byte == 127 || b"<>:\"|?*".contains(&byte))
        {
            return Err(AdmissionError::Invalid("invalid-ownership-path"));
        }
        let stem = component.split('.').next().unwrap_or_default();
        if matches!(stem, "con" | "prn" | "aux" | "nul")
            || (stem.len() == 4
                && (stem.starts_with("com") || stem.starts_with("lpt"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(AdmissionError::Invalid("invalid-ownership-path"));
        }
    }
    Ok(key)
}

fn insert_ownership(ownership: &mut BTreeSet<String>, key: String) -> Result<(), AdmissionError> {
    // An ancestor is not necessarily the immediate lexical predecessor:
    // "src/file-a" can sit between "src" and "src/file-z".
    let child_prefix = format!("{key}/");
    if ownership.contains(&key)
        || key
            .match_indices('/')
            .any(|(index, _)| ownership.contains(&key[..index]))
        || ownership
            .range(child_prefix.clone()..)
            .next()
            .is_some_and(|next| next.starts_with(&child_prefix))
    {
        return Err(AdmissionError::Conflict("overlapping-worker-ownership"));
    }
    ownership.insert(key);
    Ok(())
}

pub fn validate_admission(
    request: &TieredAdmissionRequest,
    now_ms: i64,
) -> Result<ValidatedAdmission, AdmissionError> {
    if request.goal_id.is_empty()
        || request.run_id.is_empty()
        || request.goal_id.len() > 512
        || request.run_id.len() > 512
        || now_ms <= 0
        || request.expected_version >= i64::MAX as u64
    {
        return Err(AdmissionError::Invalid("goal-and-run-required"));
    }
    if request.worker_quota == 0 || request.worker_quota > 1000 || request.agents.len() > 1004 {
        return Err(AdmissionError::Invalid("worker-quota-required"));
    }
    let mut ids = HashSet::new();
    let mut lease_ids = HashSet::new();
    let mut supervisors = Vec::new();
    let mut pms = Vec::new();
    let mut workers = Vec::new();
    let mut lanes = HashSet::new();
    let mut ownership = BTreeSet::new();
    let mut ownership_bytes = 0usize;
    let mut ownership_count = 0usize;
    for agent in &request.agents {
        if agent.agent_id.is_empty()
            || agent.lease_id.is_empty()
            || agent.stop_condition.is_empty()
            || agent.agent_id.len() > 512
            || agent.lease_id.len() > 512
            || agent.stop_condition.len() > 2048
            || agent.ownership.is_empty()
            || agent.ownership.len() > 256
        {
            return Err(AdmissionError::Invalid(
                "agent-identity-lease-stop-required",
            ));
        }
        if !ids.insert(agent.agent_id.as_str()) {
            return Err(AdmissionError::Conflict("duplicate-agent-id"));
        }
        if !lease_ids.insert(agent.lease_id.as_str()) {
            return Err(AdmissionError::Conflict("duplicate-lease-id"));
        }
        if agent.goal_id != request.goal_id || agent.run_id != request.run_id {
            return Err(AdmissionError::Invalid("scope-mismatch"));
        }
        if agent.lease_expires_at_ms <= now_ms {
            return Err(AdmissionError::Invalid("expired-lease"));
        }
        match agent.role {
            OrchestrationRole::Supervisor => {
                if agent.parent_id.is_some() {
                    return Err(AdmissionError::Invalid("supervisor-parent-forbidden"));
                }
                supervisors.push(agent)
            }
            OrchestrationRole::ProjectManager => {
                let lane = agent
                    .lane
                    .as_deref()
                    .filter(|lane| {
                        !lane.trim().is_empty()
                            && lane.len() <= 128
                            && !lane.chars().any(char::is_control)
                    })
                    .ok_or(AdmissionError::Invalid("pm-lane-required"))?;
                if !lanes.insert(lane) {
                    return Err(AdmissionError::Conflict("overlapping-pm-lane"));
                }
                pms.push(agent);
            }
            OrchestrationRole::Worker => workers.push(agent),
        }
        for path in &agent.ownership {
            ownership_bytes = ownership_bytes.saturating_add(path.len());
            ownership_count += 1;
            if ownership_bytes > 1024 * 1024 || ownership_count > 8192 {
                return Err(AdmissionError::Invalid("ownership-budget-exceeded"));
            }
            insert_ownership(&mut ownership, ownership_key(path)?)?;
        }
    }
    if supervisors.len() != 1 {
        return Err(AdmissionError::Invalid("exactly-one-supervisor-required"));
    }
    if pms.is_empty() || pms.len() > 3 {
        return Err(AdmissionError::Invalid("one-to-three-pms-required"));
    }
    if workers.len() > request.worker_quota {
        return Err(AdmissionError::QuotaExceeded);
    }
    let supervisor_id = supervisors[0].agent_id.clone();
    for pm in &pms {
        if pm.parent_id.as_deref() != Some(supervisor_id.as_str()) {
            return Err(AdmissionError::Invalid("pm-parent-must-be-supervisor"));
        }
    }
    for worker in &workers {
        let parent = worker
            .parent_id
            .as_deref()
            .ok_or(AdmissionError::Invalid("worker-parent-required"))?;
        if !pms.iter().any(|pm| pm.agent_id == parent) {
            return Err(AdmissionError::Invalid("worker-parent-must-be-pm"));
        }
    }
    Ok(ValidatedAdmission {
        supervisor_id,
        project_manager_ids: pms.iter().map(|pm| pm.agent_id.clone()).collect(),
        worker_count: workers.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(
        id: &str,
        role: OrchestrationRole,
        parent: Option<&str>,
        lane: Option<&str>,
        path: &str,
    ) -> AgentAdmission {
        AgentAdmission {
            agent_id: id.into(),
            role,
            goal_id: "g".into(),
            run_id: "r".into(),
            parent_id: parent.map(str::to_owned),
            lane: lane.map(str::to_owned),
            ownership: vec![path.into()],
            stop_condition: "terminal".into(),
            lease_id: format!("lease-{id}"),
            lease_expires_at_ms: 100,
        }
    }

    fn request(agents: Vec<AgentAdmission>) -> TieredAdmissionRequest {
        TieredAdmissionRequest {
            goal_id: "g".into(),
            run_id: "r".into(),
            expected_version: 0,
            worker_quota: 41,
            agents,
        }
    }

    #[test]
    fn admits_one_supervisor_three_pms_and_workers() {
        let mut all = vec![agent(
            "s",
            OrchestrationRole::Supervisor,
            None,
            None,
            "control",
        )];
        for (id, lane) in [("p1", "ui"), ("p2", "native"), ("p3", "verify")] {
            all.push(agent(
                id,
                OrchestrationRole::ProjectManager,
                Some("s"),
                Some(lane),
                id,
            ));
        }
        for i in 0..41 {
            all.push(agent(
                &format!("w{i}"),
                OrchestrationRole::Worker,
                Some("p1"),
                None,
                &format!("worker-{i}"),
            ));
        }
        let mut orchestrator = TieredOrchestrator::new();
        let receipt = orchestrator.admit(request(all), 1).unwrap();
        assert_eq!(receipt.worker_count, 41);
        assert_eq!(
            orchestrator.lease_state("lease-w0", 1),
            Some(LeaseState::Active)
        );
    }

    #[test]
    fn rejects_duplicate_lane_and_stale_heartbeat() {
        let agents = vec![
            agent("s", OrchestrationRole::Supervisor, None, None, "control"),
            agent(
                "p1",
                OrchestrationRole::ProjectManager,
                Some("s"),
                Some("same"),
                "p1",
            ),
            agent(
                "p2",
                OrchestrationRole::ProjectManager,
                Some("s"),
                Some("same"),
                "p2",
            ),
        ];
        let mut orchestrator = TieredOrchestrator::new();
        assert_eq!(
            orchestrator.admit(request(agents), 1),
            Err(AdmissionError::Conflict("overlapping-pm-lane"))
        );
        let mut ok = vec![
            agent("s", OrchestrationRole::Supervisor, None, None, "control"),
            agent(
                "p1",
                OrchestrationRole::ProjectManager,
                Some("s"),
                Some("one"),
                "p1",
            ),
            agent("w", OrchestrationRole::Worker, Some("p1"), None, "worker"),
        ];
        let _ = orchestrator
            .admit(request(std::mem::take(&mut ok)), 1)
            .unwrap();
        assert_eq!(
            orchestrator.heartbeat("lease-w", 0, 300),
            Err(AdmissionError::Conflict("stale-version"))
        );
    }

    fn ownership_request(first: &str, second: &str) -> TieredAdmissionRequest {
        request(vec![
            agent("s", OrchestrationRole::Supervisor, None, None, first),
            agent(
                "p",
                OrchestrationRole::ProjectManager,
                Some("s"),
                Some("native"),
                second,
            ),
        ])
    }

    #[test]
    fn tiered_ownership_rejects_windows_alias_and_ancestor_conflicts() {
        for (first, second) in [
            ("src/native", "SRC\\Native"),
            ("src", "src/native/file.rs"),
            ("src/native/file.rs", "SRC"),
            ("src/native", "src/native/file.rs"),
        ] {
            assert_eq!(
                validate_admission(&ownership_request(first, second), 1),
                Err(AdmissionError::Conflict("overlapping-worker-ownership")),
                "{first} / {second}"
            );
        }
    }

    #[test]
    fn tiered_ownership_allows_distinct_component_prefixes() {
        for (first, second) in [
            ("src", "src-other"),
            ("src/a", "src/ab"),
            ("src/a/file.rs", "src/b/file.rs"),
        ] {
            assert!(validate_admission(&ownership_request(first, second), 1).is_ok());
        }
    }

    #[test]
    fn tiered_ownership_rejects_ambiguous_or_unportable_names() {
        for path in [
            "",
            "/",
            "\\\\server\\share",
            "C:\\src",
            "C:src",
            "./src",
            "src/../native",
            "src//native",
            "src/",
            "src.",
            "src ",
            "src/*",
            "src/file:stream",
            "src/\0file",
            "src/\u{7f}",
            "src/é",
            "con",
            "NUL.txt",
            "src/COM1.rs",
            "src/lpt9",
        ] {
            assert!(
                validate_admission(&ownership_request(path, "other"), 1).is_err(),
                "{path:?}"
            );
        }
    }

    #[test]
    fn tiered_ownership_requires_a_scope_and_bounded_lane() {
        let mut req = ownership_request("control", "native");
        req.agents[1].ownership.clear();
        assert!(validate_admission(&req, 1).is_err());
        req.agents[1].ownership.push("native".into());
        for lane in [" ".to_owned(), "x".repeat(129), "native\nlane".to_owned()] {
            req.agents[1].lane = Some(lane);
            assert_eq!(
                validate_admission(&req, 1),
                Err(AdmissionError::Invalid("pm-lane-required"))
            );
        }
    }

    #[test]
    fn tiered_ownership_collision_does_not_mutate_orchestrator() {
        let mut orchestrator = TieredOrchestrator::new();
        assert!(orchestrator
            .admit(ownership_request("src", "src/file"), 1)
            .is_err());
        assert_eq!(orchestrator.version(), 0);
        assert!(orchestrator.receipt().is_none());
        assert!(orchestrator.lease_state("lease-s", 1).is_none());
    }

    #[test]
    fn tiered_ownership_bounds_aggregate_input() {
        let mut req = ownership_request("control", "native");
        for (index, agent) in req.agents.iter_mut().enumerate() {
            agent.ownership = (0..256)
                .map(|item| format!("a{index}-{item}-{}", "x".repeat(2200)))
                .collect();
        }
        assert_eq!(
            validate_admission(&req, 1),
            Err(AdmissionError::Invalid("ownership-budget-exceeded"))
        );
    }
}
