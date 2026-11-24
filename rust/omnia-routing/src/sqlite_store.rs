//! Native `omnia-winsqlite` WAL persistence for `DynamicProviderRouter` quota,
//! circuit-breaker, latency sample, model-proven/lock, probe counter, and role-binding state.

use crate::model_roles::ModelRole;
use crate::{CandidateResourceState, RouteCandidate, RoutingError};
use omnia_winsqlite::{Connection, StepStatus};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

const ROUTER_SCHEMA_SQL: &str = r"
CREATE TABLE IF NOT EXISTS router_candidates (
    candidate_id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    candidate_json TEXT NOT NULL,
    state_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS router_role_bindings (
    role TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    model_spec TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS router_probe_counters (
    probe_key TEXT PRIMARY KEY,
    count INTEGER NOT NULL
);
";

/// Thread-safe WAL SQLite store backing `DynamicProviderRouter` across process restarts.
#[derive(Clone, Debug)]
pub struct RouterSqliteStore {
    conn: Arc<Mutex<Connection>>,
}

impl RouterSqliteStore {
    /// Open or create `<db_path>` in WAL mode and bootstrap routing tables.
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self, RoutingError> {
        let path = db_path.as_ref();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|e| {
                    RoutingError::InvalidState(format!(
                        "failed to create router db dir {}: {e}",
                        parent.display()
                    ))
                })?;
            }
        }
        let conn = Connection::open_read_write(path).map_err(|e| {
            RoutingError::InvalidState(format!(
                "failed to open router sqlite db {}: {e}",
                path.display()
            ))
        })?;
        conn.exec_batch(ROUTER_SCHEMA_SQL).map_err(|e| {
            RoutingError::InvalidState(format!("failed to init router schema: {e}"))
        })?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Open an isolated in-memory WAL-compatible SQLite database (for tests).
    pub fn open_in_memory() -> Result<Self, RoutingError> {
        let conn = Connection::open_in_memory().map_err(|e| {
            RoutingError::InvalidState(format!("failed to open in-memory router sqlite: {e}"))
        })?;
        conn.exec_batch(ROUTER_SCHEMA_SQL).map_err(|e| {
            RoutingError::InvalidState(format!("failed to init in-memory router schema: {e}"))
        })?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Persist or update a candidate definition and its real runtime resource state.
    pub fn save_candidate(
        &self,
        candidate: &RouteCandidate,
        state: &CandidateResourceState,
        updated_at_ms: i64,
    ) -> Result<(), RoutingError> {
        let cand_json = serde_json::to_string(candidate).map_err(|e| {
            RoutingError::InvalidPolicy(format!("serialize RouteCandidate failed: {e}"))
        })?;
        let state_json = serde_json::to_string(state).map_err(|e| {
            RoutingError::InvalidPolicy(format!("serialize CandidateResourceState failed: {e}"))
        })?;

        let conn = self
            .conn
            .lock()
            .map_err(|_| RoutingError::InvalidState("router sqlite lock poisoned".into()))?;
        let mut stmt = conn
            .prepare(
                "INSERT INTO router_candidates
                    (candidate_id, provider_id, model_id, candidate_json, state_json, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(candidate_id) DO UPDATE SET
                    provider_id = excluded.provider_id,
                    model_id = excluded.model_id,
                    candidate_json = excluded.candidate_json,
                    state_json = excluded.state_json,
                    updated_at_ms = excluded.updated_at_ms",
            )
            .map_err(|e| RoutingError::InvalidState(format!("prepare save_candidate: {e}")))?;
        stmt.bind_text(1, &candidate.candidate_id)
            .and_then(|()| stmt.bind_text(2, &candidate.provider_id))
            .and_then(|()| stmt.bind_text(3, &candidate.model_id))
            .and_then(|()| stmt.bind_text(4, &cand_json))
            .and_then(|()| stmt.bind_text(5, &state_json))
            .and_then(|()| stmt.bind_int64(6, updated_at_ms))
            .map_err(|e| RoutingError::InvalidState(format!("bind save_candidate: {e}")))?;
        while matches!(stmt.step(), Ok(StepStatus::Row)) {}
        Ok(())
    }

    /// Load all persisted `(RouteCandidate, CandidateResourceState)` entries sorted deterministically.
    pub fn load_all_candidates(
        &self,
    ) -> Result<Vec<(RouteCandidate, CandidateResourceState)>, RoutingError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| RoutingError::InvalidState("router sqlite lock poisoned".into()))?;
        let mut stmt = conn
            .prepare(
                "SELECT candidate_json, state_json FROM router_candidates ORDER BY candidate_id ASC",
            )
            .map_err(|e| RoutingError::InvalidState(format!("prepare load_candidates: {e}")))?;
        let mut out = Vec::new();
        while matches!(
            stmt.step()
                .map_err(|e| RoutingError::InvalidState(format!("step load_candidates: {e}")))?,
            StepStatus::Row
        ) {
            let c_raw = stmt
                .column_text(0)
                .map_err(|e| RoutingError::InvalidState(format!("read candidate_json: {e}")))?;
            let s_raw = stmt
                .column_text(1)
                .map_err(|e| RoutingError::InvalidState(format!("read state_json: {e}")))?;
            let cand: RouteCandidate = serde_json::from_str(&c_raw).map_err(|e| {
                RoutingError::InvalidState(format!("decode RouteCandidate from sqlite: {e}"))
            })?;
            let state: CandidateResourceState = serde_json::from_str(&s_raw).map_err(|e| {
                RoutingError::InvalidState(format!(
                    "decode CandidateResourceState from sqlite: {e}"
                ))
            })?;
            out.push((cand, state));
        }
        Ok(out)
    }

    /// Persist a functional role binding (`main`, `architect`, `fast`, `advisor`, `verifier`, `fast_apply`).
    pub fn save_role_binding(
        &self,
        role: ModelRole,
        candidate_id: &str,
        model_spec: &str,
        updated_at_ms: i64,
    ) -> Result<(), RoutingError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| RoutingError::InvalidState("router sqlite lock poisoned".into()))?;
        let mut stmt = conn
            .prepare(
                "INSERT INTO router_role_bindings (role, candidate_id, model_spec, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(role) DO UPDATE SET
                    candidate_id = excluded.candidate_id,
                    model_spec = excluded.model_spec,
                    updated_at_ms = excluded.updated_at_ms",
            )
            .map_err(|e| RoutingError::InvalidState(format!("prepare save_role_binding: {e}")))?;
        stmt.bind_text(1, role.as_str())
            .and_then(|()| stmt.bind_text(2, candidate_id))
            .and_then(|()| stmt.bind_text(3, model_spec))
            .and_then(|()| stmt.bind_int64(4, updated_at_ms))
            .map_err(|e| RoutingError::InvalidState(format!("bind save_role_binding: {e}")))?;
        while matches!(stmt.step(), Ok(StepStatus::Row)) {}
        Ok(())
    }

    /// Load all persisted role bindings.
    pub fn load_role_bindings(
        &self,
    ) -> Result<BTreeMap<ModelRole, (String, String)>, RoutingError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| RoutingError::InvalidState("router sqlite lock poisoned".into()))?;
        let mut stmt = conn
            .prepare("SELECT role, candidate_id, model_spec FROM router_role_bindings")
            .map_err(|e| RoutingError::InvalidState(format!("prepare load_roles: {e}")))?;
        let mut out = BTreeMap::new();
        while matches!(
            stmt.step()
                .map_err(|e| RoutingError::InvalidState(format!("step load_roles: {e}")))?,
            StepStatus::Row
        ) {
            let role_str = stmt
                .column_text(0)
                .map_err(|e| RoutingError::InvalidState(format!("read role: {e}")))?;
            let cid = stmt
                .column_text(1)
                .map_err(|e| RoutingError::InvalidState(format!("read candidate_id: {e}")))?;
            let spec = stmt
                .column_text(2)
                .map_err(|e| RoutingError::InvalidState(format!("read model_spec: {e}")))?;
            if let Ok(role) = role_str.parse::<ModelRole>() {
                out.insert(role, (cid, spec));
            }
        }
        Ok(out)
    }

    /// Save a single probe counter `(tier + model_key) -> picks`.
    pub fn save_probe_counter(&self, probe_key: &str, count: u64) -> Result<(), RoutingError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| RoutingError::InvalidState("router sqlite lock poisoned".into()))?;
        let mut stmt = conn
            .prepare(
                "INSERT INTO router_probe_counters (probe_key, count)
                 VALUES (?1, ?2)
                 ON CONFLICT(probe_key) DO UPDATE SET count = excluded.count",
            )
            .map_err(|e| RoutingError::InvalidState(format!("prepare save_probe: {e}")))?;
        stmt.bind_text(1, probe_key)
            .and_then(|()| stmt.bind_int64(2, count as i64))
            .map_err(|e| RoutingError::InvalidState(format!("bind save_probe: {e}")))?;
        while matches!(stmt.step(), Ok(StepStatus::Row)) {}
        Ok(())
    }

    /// Load all persisted 1-in-4 probe counters.
    pub fn load_probe_counters(&self) -> Result<BTreeMap<String, u64>, RoutingError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| RoutingError::InvalidState("router sqlite lock poisoned".into()))?;
        let mut stmt = conn
            .prepare("SELECT probe_key, count FROM router_probe_counters")
            .map_err(|e| RoutingError::InvalidState(format!("prepare load_probes: {e}")))?;
        let mut out = BTreeMap::new();
        while matches!(
            stmt.step()
                .map_err(|e| RoutingError::InvalidState(format!("step load_probes: {e}")))?,
            StepStatus::Row
        ) {
            let key = stmt
                .column_text(0)
                .map_err(|e| RoutingError::InvalidState(format!("read probe_key: {e}")))?;
            let count = stmt
                .column_int64(1)
                .map_err(|e| RoutingError::InvalidState(format!("read count: {e}")))?
                .max(0) as u64;
            if !key.is_empty() {
                out.insert(key, count);
            }
        }
        Ok(out)
    }
}
