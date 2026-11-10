//! SQLite journal for bounded supervisor/PM/worker admissions.
//!
//! This is intentionally a persistence seam, not a dispatcher.  It records an
//! accepted immutable snapshot and its leases so a future scheduler can recover
//! the last admission without treating a renderer or in-memory projection as
//! authoritative.

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{error::Error, fmt};

use crate::tiered_orchestration::{
    validate_admission, AdmissionError, OrchestrationRole, TieredAdmissionReceipt,
    TieredAdmissionRequest,
};

#[derive(Debug)]
pub enum TieredStoreError {
    Sqlite(rusqlite::Error),
    StaleVersion,
    PayloadConflict,
    Integrity(&'static str),
    Admission(AdmissionError),
}

impl fmt::Display for TieredStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(error) => write!(f, "sqlite: {error}"),
            Self::StaleVersion => f.write_str("stale-version"),
            Self::PayloadConflict => f.write_str("duplicate admission payload"),
            Self::Integrity(reason) => write!(f, "tiered integrity: {reason}"),
            Self::Admission(error) => write!(f, "admission rejected: {error:?}"),
        }
    }
}

impl Error for TieredStoreError {}

impl From<rusqlite::Error> for TieredStoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

pub struct TieredOrchestrationStore<'a> {
    connection: &'a Connection,
}

impl<'a> TieredOrchestrationStore<'a> {
    /// Production connections are provisioned only by Storage's versioned
    /// migration, never by an opportunistic command-time CREATE TABLE.
    pub fn from_migrated(connection: &'a Connection) -> Self {
        Self { connection }
    }

    #[cfg(test)]
    pub fn open(connection: &'a Connection) -> Result<Self, TieredStoreError> {
        let store = Self { connection };
        store.ensure_schema()?;
        Ok(store)
    }

    #[cfg(test)]
    pub fn ensure_schema(&self) -> Result<(), TieredStoreError> {
        self.connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS tiered_orchestration_heads (
                goal_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                version INTEGER NOT NULL,
                snapshot_hash TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                PRIMARY KEY (goal_id, run_id, version)
            );
            CREATE TABLE IF NOT EXISTS tiered_orchestration_current (
                goal_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                version INTEGER NOT NULL,
                snapshot_hash TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                PRIMARY KEY (goal_id, run_id)
            );
            CREATE TABLE IF NOT EXISTS tiered_orchestration_agents (
                goal_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                version INTEGER NOT NULL,
                agent_id TEXT NOT NULL,
                role TEXT NOT NULL,
                parent_id TEXT,
                lane TEXT,
                ownership_json TEXT NOT NULL,
                stop_condition TEXT NOT NULL,
                lease_id TEXT NOT NULL,
                lease_expires_at_ms INTEGER NOT NULL,
                PRIMARY KEY (goal_id, run_id, version, agent_id),
                UNIQUE (goal_id, run_id, version, lease_id)
            );
            CREATE TRIGGER IF NOT EXISTS tiered_heads_immutable_update
            BEFORE UPDATE ON tiered_orchestration_heads
            BEGIN SELECT RAISE(ABORT, 'tiered-heads-immutable'); END;
            CREATE TRIGGER IF NOT EXISTS tiered_heads_immutable_delete
            BEFORE DELETE ON tiered_orchestration_heads
            BEGIN SELECT RAISE(ABORT, 'tiered-heads-immutable'); END;
            CREATE TRIGGER IF NOT EXISTS tiered_current_immutable_delete
            BEFORE DELETE ON tiered_orchestration_current
            BEGIN SELECT RAISE(ABORT, 'tiered-current-delete-forbidden'); END;
            CREATE TRIGGER IF NOT EXISTS tiered_agents_immutable_update
            BEFORE UPDATE ON tiered_orchestration_agents
            BEGIN SELECT RAISE(ABORT, 'tiered-agents-immutable'); END;
            CREATE TRIGGER IF NOT EXISTS tiered_agents_immutable_delete
            BEFORE DELETE ON tiered_orchestration_agents
            BEGIN SELECT RAISE(ABORT, 'tiered-agents-immutable'); END;",
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn admit(
        &self,
        request: &TieredAdmissionRequest,
        now_ms: i64,
    ) -> Result<TieredAdmissionReceipt, TieredStoreError> {
        self.admit_with_guard(request, now_ms, |_| Ok(()))
    }

    /// Check authoritative owning records under the same write transaction as
    /// admission, so a scope check cannot race a second connection's mutation.
    pub fn admit_with_guard(
        &self,
        request: &TieredAdmissionRequest,
        now_ms: i64,
        guard: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<(), TieredStoreError>,
    ) -> Result<TieredAdmissionReceipt, TieredStoreError> {
        if now_ms <= 0 {
            return Err(TieredStoreError::Admission(AdmissionError::Invalid(
                "admission-time-required",
            )));
        }
        let transaction = rusqlite::Transaction::new_unchecked(
            self.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        guard(&transaction)?;
        let current: i64 = transaction
            .query_row(
                "SELECT version FROM tiered_orchestration_current
                 WHERE goal_id=?1 AND run_id=?2",
                params![request.goal_id, request.run_id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        if current < 0 || current == i64::MAX {
            return Err(TieredStoreError::Integrity("invalid-current-version"));
        }
        if request.expected_version != current as u64 {
            return Err(TieredStoreError::StaleVersion);
        }
        let version = current + 1;
        let mut validation_request = request.clone();
        validation_request.expected_version = current as u64;
        let validated =
            validate_admission(&validation_request, now_ms).map_err(TieredStoreError::Admission)?;
        let payload = serde_json::to_vec(request).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let hash = format!("{:x}", Sha256::digest(payload));
        transaction.execute(
            "INSERT INTO tiered_orchestration_heads
             (goal_id,run_id,version,snapshot_hash,created_at_ms)
             VALUES (?1,?2,?3,?4,?5)",
            params![request.goal_id, request.run_id, version, hash, now_ms],
        )?;
        transaction.execute(
            "INSERT INTO tiered_orchestration_current
             (goal_id,run_id,version,snapshot_hash,created_at_ms)
             VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(goal_id,run_id) DO UPDATE SET
               version=excluded.version,
               snapshot_hash=excluded.snapshot_hash,
               created_at_ms=excluded.created_at_ms",
            params![request.goal_id, request.run_id, version, hash, now_ms],
        )?;
        for agent in &request.agents {
            let role = match agent.role {
                OrchestrationRole::Supervisor => "supervisor",
                OrchestrationRole::ProjectManager => "project-manager",
                OrchestrationRole::Worker => "worker",
            };
            let ownership = serde_json::to_string(&agent.ownership)
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
            transaction.execute(
                "INSERT INTO tiered_orchestration_agents
                 (goal_id,run_id,version,agent_id,role,parent_id,lane,
                  ownership_json,stop_condition,lease_id,lease_expires_at_ms)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![
                    request.goal_id,
                    request.run_id,
                    version,
                    agent.agent_id,
                    role,
                    agent.parent_id,
                    agent.lane,
                    ownership,
                    agent.stop_condition,
                    agent.lease_id,
                    agent.lease_expires_at_ms,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(TieredAdmissionReceipt {
            goal_id: request.goal_id.clone(),
            run_id: request.run_id.clone(),
            version: version as u64,
            supervisor_id: validated.supervisor_id,
            project_manager_ids: validated.project_manager_ids,
            worker_count: validated.worker_count,
            lease_ids: request
                .agents
                .iter()
                .map(|agent| agent.lease_id.clone())
                .collect(),
        })
    }

    /// Verify a supplied original request against one consistent SQLite read
    /// snapshot. This does not reconstruct a request from storage, renew leases,
    /// establish current authority, or permit dispatch/replay. Historical lease
    /// validity is evaluated at admission time, never at readback time.
    pub fn verify_admitted_request(
        &self,
        request: &TieredAdmissionRequest,
    ) -> Result<TieredAdmissionReceipt, TieredStoreError> {
        // Bound caller-controlled collections before serialization or DB work.
        validate_admission(request, 1).map_err(TieredStoreError::Admission)?;
        let version = request
            .expected_version
            .checked_add(1)
            .and_then(|value| i64::try_from(value).ok())
            .ok_or(TieredStoreError::Integrity("invalid-request-version"))?;
        let transaction = rusqlite::Transaction::new_unchecked(
            self.connection,
            rusqlite::TransactionBehavior::Deferred,
        )?;
        let (stored_hash, admitted_at): (String, i64) = transaction
            .query_row(
                "SELECT snapshot_hash,created_at_ms FROM tiered_orchestration_heads
                 WHERE goal_id=?1 AND run_id=?2 AND version=?3",
                params![request.goal_id, request.run_id, version],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or(TieredStoreError::Integrity("missing-admission"))?;
        if admitted_at <= 0 {
            return Err(TieredStoreError::Integrity("invalid-admission-time"));
        }
        let validated =
            validate_admission(request, admitted_at).map_err(TieredStoreError::Admission)?;
        let payload = serde_json::to_vec(request).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let hash = format!("{:x}", Sha256::digest(payload));
        if stored_hash != hash {
            return Err(TieredStoreError::Integrity("request-hash-mismatch"));
        }
        let latest: (i64, String, i64) = transaction.query_row(
            "SELECT version,snapshot_hash,created_at_ms FROM tiered_orchestration_heads
             WHERE goal_id=?1 AND run_id=?2 ORDER BY version DESC LIMIT 1",
            params![request.goal_id, request.run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let projection: Option<(i64, String, i64)> = transaction
            .query_row(
                "SELECT version,snapshot_hash,created_at_ms FROM tiered_orchestration_current
                 WHERE goal_id=?1 AND run_id=?2",
                params![request.goal_id, request.run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if latest.0 <= 0 || latest.2 <= 0 || projection.as_ref() != Some(&latest) {
            return Err(TieredStoreError::Integrity("current-projection-mismatch"));
        }
        let mut statement = transaction.prepare(
            "SELECT agent_id,role,parent_id,lane,ownership_json,stop_condition,
                    lease_id,lease_expires_at_ms
             FROM tiered_orchestration_agents
             WHERE goal_id=?1 AND run_id=?2 AND version=?3
             ORDER BY agent_id LIMIT 1005",
        )?;
        let mut rows = statement.query(params![request.goal_id, request.run_id, version])?;
        let mut expected: Vec<_> = request.agents.iter().collect();
        expected.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
        for agent in expected {
            let row = rows
                .next()?
                .ok_or(TieredStoreError::Integrity("missing-agent"))?;
            let role = match agent.role {
                OrchestrationRole::Supervisor => "supervisor",
                OrchestrationRole::ProjectManager => "project-manager",
                OrchestrationRole::Worker => "worker",
            };
            let ownership = serde_json::to_string(&agent.ownership)
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
            if row.get::<_, String>(0)? != agent.agent_id
                || row.get::<_, String>(1)? != role
                || row.get::<_, Option<String>>(2)? != agent.parent_id
                || row.get::<_, Option<String>>(3)? != agent.lane
                || row.get::<_, String>(4)? != ownership
                || row.get::<_, String>(5)? != agent.stop_condition
                || row.get::<_, String>(6)? != agent.lease_id
                || row.get::<_, i64>(7)? != agent.lease_expires_at_ms
            {
                return Err(TieredStoreError::Integrity("agent-row-mismatch"));
            }
        }
        if rows.next()?.is_some() {
            return Err(TieredStoreError::Integrity("extra-agent"));
        }
        drop(rows);
        drop(statement);
        transaction.commit()?;
        Ok(TieredAdmissionReceipt {
            goal_id: request.goal_id.clone(),
            run_id: request.run_id.clone(),
            version: version as u64,
            supervisor_id: validated.supervisor_id,
            project_manager_ids: validated.project_manager_ids,
            worker_count: validated.worker_count,
            lease_ids: request
                .agents
                .iter()
                .map(|agent| agent.lease_id.clone())
                .collect(),
        })
    }

    pub fn current_version(&self, goal_id: &str, run_id: &str) -> Result<u64, TieredStoreError> {
        let version = self
            .connection
            .query_row(
                "SELECT version FROM tiered_orchestration_current
                 WHERE goal_id=?1 AND run_id=?2",
                params![goal_id, run_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0);
        u64::try_from(version).map_err(|_| TieredStoreError::Integrity("invalid-current-version"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiered_orchestration::AgentAdmission;

    fn request(expected_version: u64) -> TieredAdmissionRequest {
        let supervisor = AgentAdmission {
            agent_id: "sup".into(),
            role: OrchestrationRole::Supervisor,
            goal_id: "g".into(),
            run_id: "r".into(),
            parent_id: None,
            lane: None,
            ownership: vec!["docs".into()],
            stop_condition: "goal-terminal".into(),
            lease_id: "lease-sup".into(),
            lease_expires_at_ms: 1000,
        };
        let pm = AgentAdmission {
            agent_id: "pm".into(),
            role: OrchestrationRole::ProjectManager,
            goal_id: "g".into(),
            run_id: "r".into(),
            parent_id: Some("sup".into()),
            lane: Some("verification".into()),
            ownership: vec!["tests".into()],
            stop_condition: "lane-terminal".into(),
            lease_id: "lease-pm".into(),
            lease_expires_at_ms: 1000,
        };
        TieredAdmissionRequest {
            goal_id: "g".into(),
            run_id: "r".into(),
            expected_version,
            worker_quota: 41,
            agents: vec![supervisor, pm],
        }
    }

    #[test]
    fn admission_survives_reopen_and_stale_cas_is_rejected() {
        let connection = Connection::open_in_memory().unwrap();
        {
            let store = TieredOrchestrationStore::open(&connection).unwrap();
            let receipt = store.admit(&request(0), 10).unwrap();
            assert_eq!(receipt.version, 1);
            assert_eq!(store.current_version("g", "r").unwrap(), 1);
            assert!(matches!(
                store.admit(&request(0), 11),
                Err(TieredStoreError::StaleVersion)
            ));
        }
        let reopened = TieredOrchestrationStore::open(&connection).unwrap();
        assert_eq!(reopened.current_version("g", "r").unwrap(), 1);
    }

    #[test]
    fn immutable_journal_rejects_update_and_delete() {
        let connection = Connection::open_in_memory().unwrap();
        let store = TieredOrchestrationStore::open(&connection).unwrap();
        store.admit(&request(0), 10).unwrap();
        assert!(connection
            .execute(
                "UPDATE tiered_orchestration_heads SET version=9
                 WHERE goal_id='g' AND run_id='r'",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM tiered_orchestration_agents WHERE goal_id='g'",
                [],
            )
            .is_err());
    }

    #[test]
    fn second_admission_appends_version_and_updates_projection() {
        let connection = Connection::open_in_memory().unwrap();
        let store = TieredOrchestrationStore::open(&connection).unwrap();
        assert_eq!(store.admit(&request(0), 10).unwrap().version, 1);
        assert_eq!(store.admit(&request(1), 11).unwrap().version, 2);
        assert_eq!(store.current_version("g", "r").unwrap(), 2);
        let journal_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tiered_orchestration_heads WHERE goal_id='g' AND run_id='r'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(journal_rows, 2);
    }

    #[test]
    fn invalid_topology_is_rejected_before_any_rows_are_written() {
        let connection = Connection::open_in_memory().unwrap();
        let store = TieredOrchestrationStore::open(&connection).unwrap();
        let mut invalid = request(0);
        invalid
            .agents
            .retain(|agent| agent.role != OrchestrationRole::ProjectManager);
        assert!(matches!(
            store.admit(&invalid, 10),
            Err(TieredStoreError::Admission(AdmissionError::Invalid(
                "one-to-three-pms-required"
            )))
        ));
        assert_eq!(store.current_version("g", "r").unwrap(), 0);
        let rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tiered_orchestration_agents",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn tiered_ownership_alias_rejection_keeps_journal_empty() {
        let connection = Connection::open_in_memory().unwrap();
        let store = TieredOrchestrationStore::open(&connection).unwrap();
        for (first, second) in [("src", "SRC\\native"), ("src/native", "src")] {
            let mut invalid = request(0);
            invalid.agents[0].ownership = vec![first.into()];
            invalid.agents[1].ownership = vec![second.into()];
            assert!(matches!(
                store.admit(&invalid, 10),
                Err(TieredStoreError::Admission(AdmissionError::Conflict(
                    "overlapping-worker-ownership"
                )))
            ));
            for table in [
                "tiered_orchestration_heads",
                "tiered_orchestration_current",
                "tiered_orchestration_agents",
            ] {
                let count: i64 = connection
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert_eq!(count, 0);
            }
        }
    }

    #[test]
    fn tiered_scope_guard_failure_precedes_all_admission_writes() {
        let connection = Connection::open_in_memory().unwrap();
        let store = TieredOrchestrationStore::open(&connection).unwrap();
        assert!(matches!(
            store.admit_with_guard(&request(0), 10, |transaction| {
                assert!(!transaction.is_autocommit());
                Err(TieredStoreError::Admission(AdmissionError::Invalid(
                    "scope",
                )))
            }),
            Err(TieredStoreError::Admission(AdmissionError::Invalid(
                "scope"
            )))
        ));
        assert_eq!(store.current_version("g", "r").unwrap(), 0);
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tiered_orchestration_heads",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        assert!(connection.is_autocommit());
    }

    #[test]
    fn mid_transaction_constraint_failure_rolls_back_journal_projection_and_agents() {
        let connection = Connection::open_in_memory().unwrap();
        let store = TieredOrchestrationStore::open(&connection).unwrap();
        store.admit(&request(0), 10).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER fail_second_admission_agent
                 BEFORE INSERT ON tiered_orchestration_agents
                 WHEN NEW.version = 2 AND NEW.agent_id = 'pm'
                 BEGIN SELECT RAISE(ABORT, 'injected-agent-failure'); END;",
            )
            .unwrap();
        assert!(matches!(
            store.admit(&request(1), 11),
            Err(TieredStoreError::Sqlite(_))
        ));
        assert_eq!(store.current_version("g", "r").unwrap(), 1);
        let heads: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tiered_orchestration_heads WHERE goal_id='g' AND run_id='r'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let agents: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tiered_orchestration_agents WHERE goal_id='g' AND run_id='r'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(heads, 1);
        assert_eq!(agents, 2);
    }

    #[test]
    fn tiered_readback_verifies_historical_request_without_mutation_or_lease_renewal() {
        let connection = Connection::open_in_memory().unwrap();
        let store = TieredOrchestrationStore::open(&connection).unwrap();
        let first = store.admit(&request(0), 10).unwrap();
        store.admit(&request(1), 11).unwrap();
        let before = connection.total_changes();
        let verified = store.verify_admitted_request(&request(0)).unwrap();
        assert_eq!(verified.version, first.version);
        assert_eq!(verified.lease_ids, first.lease_ids);
        assert_eq!(verified.supervisor_id, first.supervisor_id);
        assert_eq!(connection.total_changes(), before);
        assert_eq!(store.current_version("g", "r").unwrap(), 2);
        // Verification is historical; the stored expiry is never renewed.
        let expiry: i64 = connection
            .query_row(
                "SELECT MIN(lease_expires_at_ms) FROM tiered_orchestration_agents",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(expiry, 1000);
        // CAS replay is still rejected, rather than becoming dispatch permission.
        assert!(matches!(
            store.admit(&request(0), 12),
            Err(TieredStoreError::StaleVersion)
        ));
    }

    #[test]
    fn tiered_admission_rejects_nonpositive_clock_without_writes() {
        let connection = Connection::open_in_memory().unwrap();
        let store = TieredOrchestrationStore::open(&connection).unwrap();
        for now_ms in [i64::MIN, -1, 0] {
            assert!(matches!(
                store.admit(&request(0), now_ms),
                Err(TieredStoreError::Admission(AdmissionError::Invalid(
                    "admission-time-required"
                )))
            ));
            assert_eq!(store.current_version("g", "r").unwrap(), 0);
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM tiered_orchestration_heads",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 0);
        }
        let mut earliest = request(0);
        for agent in &mut earliest.agents {
            agent.lease_expires_at_ms = 2;
        }
        assert_eq!(store.admit(&earliest, 1).unwrap().version, 1);
        assert_eq!(store.verify_admitted_request(&earliest).unwrap().version, 1);
    }

    #[test]
    fn tiered_readback_rejects_missing_payload_drift_and_invalid_version() {
        let connection = Connection::open_in_memory().unwrap();
        let store = TieredOrchestrationStore::open(&connection).unwrap();
        assert!(matches!(
            store.verify_admitted_request(&request(0)),
            Err(TieredStoreError::Integrity("missing-admission"))
        ));
        store.admit(&request(0), 10).unwrap();
        let mut drifted = request(0);
        drifted.worker_quota += 1;
        assert!(matches!(
            store.verify_admitted_request(&drifted),
            Err(TieredStoreError::Integrity("request-hash-mismatch"))
        ));
        assert!(store.verify_admitted_request(&request(u64::MAX)).is_err());
        let before = connection.total_changes();
        assert!(store.verify_admitted_request(&request(1)).is_err());
        assert_eq!(connection.total_changes(), before);
    }

    #[test]
    fn tiered_readback_rejects_every_changed_agent_column() {
        for change in [
            "agent_id='other'",
            "role='worker'",
            "parent_id='other'",
            "lane='other'",
            "ownership_json='[\"other\"]'",
            "stop_condition='other'",
            "lease_id='other'",
            "lease_expires_at_ms=9999",
        ] {
            let connection = Connection::open_in_memory().unwrap();
            let store = TieredOrchestrationStore::open(&connection).unwrap();
            store.admit(&request(0), 10).unwrap();
            // Fixture corruption deliberately bypasses immutability triggers.
            connection
                .execute_batch("DROP TRIGGER tiered_agents_immutable_update;")
                .unwrap();
            connection
                .execute(
                    &format!(
                        "UPDATE tiered_orchestration_agents SET {change} WHERE agent_id='sup'"
                    ),
                    [],
                )
                .unwrap();
            let before = connection.total_changes();
            assert!(
                store.verify_admitted_request(&request(0)).is_err(),
                "accepted changed column: {change}"
            );
            assert_eq!(connection.total_changes(), before);
        }
    }

    #[test]
    fn tiered_readback_rejects_missing_and_extra_agents() {
        for missing in [true, false] {
            let connection = Connection::open_in_memory().unwrap();
            let store = TieredOrchestrationStore::open(&connection).unwrap();
            store.admit(&request(0), 10).unwrap();
            if missing {
                connection
                    .execute_batch(
                        "DROP TRIGGER tiered_agents_immutable_delete;
                         DELETE FROM tiered_orchestration_agents WHERE agent_id='sup';",
                    )
                    .unwrap();
            } else {
                connection
                    .execute_batch(
                        "INSERT INTO tiered_orchestration_agents
                         SELECT goal_id,run_id,version,'zzz',role,parent_id,lane,
                                ownership_json,stop_condition,'extra',lease_expires_at_ms
                         FROM tiered_orchestration_agents WHERE agent_id='sup';",
                    )
                    .unwrap();
            }
            let before = connection.total_changes();
            assert!(store.verify_admitted_request(&request(0)).is_err());
            assert_eq!(connection.total_changes(), before);
        }
    }

    #[test]
    fn tiered_readback_rejects_projection_and_journal_corruption() {
        for change in [
            "UPDATE tiered_orchestration_current SET version=-1",
            "UPDATE tiered_orchestration_current SET version=0",
            "UPDATE tiered_orchestration_current SET version=9",
            "UPDATE tiered_orchestration_current SET snapshot_hash='bad'",
            "UPDATE tiered_orchestration_current SET created_at_ms=999",
            "DROP TRIGGER tiered_current_immutable_delete;
             DELETE FROM tiered_orchestration_current",
            "DROP TRIGGER tiered_heads_immutable_update;
             UPDATE tiered_orchestration_heads SET snapshot_hash='bad'",
            "DROP TRIGGER tiered_heads_immutable_update;
             UPDATE tiered_orchestration_heads SET created_at_ms=0",
        ] {
            let connection = Connection::open_in_memory().unwrap();
            let store = TieredOrchestrationStore::open(&connection).unwrap();
            store.admit(&request(0), 10).unwrap();
            connection.execute_batch(change).unwrap();
            let before = connection.total_changes();
            assert!(
                store.verify_admitted_request(&request(0)).is_err(),
                "accepted corruption: {change}"
            );
            assert_eq!(connection.total_changes(), before);
        }
    }

    #[test]
    fn tiered_readback_survives_real_disk_close_and_reopen() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "omnia-tiered-readback-{}-{stamp}.sqlite",
            std::process::id()
        ));
        {
            let connection = Connection::open(&path).unwrap();
            let store = TieredOrchestrationStore::open(&connection).unwrap();
            store.admit(&request(0), 10).unwrap();
        }
        {
            let connection = Connection::open(&path).unwrap();
            let store = TieredOrchestrationStore::from_migrated(&connection);
            let before = connection.total_changes();
            let verified = store.verify_admitted_request(&request(0)).unwrap();
            assert_eq!(verified.version, 1);
            assert_eq!(verified.project_manager_ids, vec!["pm"]);
            assert_eq!(connection.total_changes(), before);
        }
        std::fs::remove_file(path).unwrap();
    }
}
