use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use omnia_core::{compact_json, uuid_v4_simple, SecretRedactor};
use omnia_winsqlite::{Connection, StepStatus, StoreOwnership};
use serde_json::{json, Value};

use crate::error::StoreError;
use crate::native_types::{
    normalize_and_validate_model, normalize_and_validate_title, validate_page_limit,
    validate_session_id, AgentEvent, AgentMessage, AgentRunStateRecord, AgentRunStatus,
    AgentSessionNavigationSnapshot, AgentSessionPage, AgentSessionPageCursor, AgentSessionSummary,
    CreateAgentSessionRequest, SaveAgentSessionNavigationRequest,
    UpdateAgentSessionSettingsRequest, DEFAULT_AGENT_SESSION_PAGE_LIMIT, DEFAULT_TOKEN_BUDGET,
    MAX_NAVIGATION_OPEN_SESSION_IDS,
};

const HARNESS_STORE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    summary_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_sessions_page_order
    ON agent_sessions (updated_at_ms DESC, id ASC);

CREATE TABLE IF NOT EXISTS agent_messages (
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    message_json TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS agent_deleted (
    id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS agent_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    event_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_events_session_seq
    ON agent_events (session_id, sequence ASC);

CREATE TABLE IF NOT EXISTS agent_run_state (
    session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    snapshot_sequence INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workspace_trust (
    cwd TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_session_navigation (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    revision INTEGER NOT NULL CHECK(revision > 0),
    snapshot_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_session_navigation_receipts (
    receipt_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL UNIQUE CHECK(revision > 0),
    snapshot_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    secret_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    extra_json TEXT NOT NULL DEFAULT '{}',
    updated_at_ms INTEGER NOT NULL DEFAULT 0
);
"#;

const HARNESS_RECOVERY_SQL: &str = r#"
INSERT OR IGNORE INTO agent_session_navigation_receipts (receipt_id, revision, snapshot_json)
SELECT 'session_navigation_legacy_' || revision, revision, snapshot_json
FROM agent_session_navigation
WHERE singleton = 1;

UPDATE agent_run_state
SET status = 'interrupted'
WHERE status = 'running';
"#;

/// Exclusive file-locked SQLite repository for `omnia-native.exe` sessions, navigation,
/// messages, run states, events, workspace trust, and provider profiles.
///
/// Field drop order is deliberate: `conn` MUST precede `ownership` so SQLite closes
/// its database handle before `StoreOwnership` releases the Win32 advisory byte lock.
#[derive(Debug)]
pub struct HarnessStore {
    db_path: PathBuf,
    conn: Connection,
    #[allow(dead_code)]
    ownership: Option<StoreOwnership>,
}

impl HarnessStore {
    /// Acquire exclusive Win32 store ownership (`LockFileEx`) on `db_path`, open SQLite WAL,
    /// initialize tables, backfill navigation receipts, and recover interrupted runs.
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = db_path.as_ref().to_path_buf();
        if path.as_os_str().is_empty() {
            return Err(StoreError::new(
                "harness_store_ownership_failed",
                "Harness store path cannot be empty.",
                false,
            ));
        }
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|err| {
                    StoreError::new(
                        "harness_store_ownership_failed",
                        format!(
                            "Failed to create harness store directory {}: {err}",
                            parent.display()
                        ),
                        false,
                    )
                })?;
            }
        }

        let ownership = StoreOwnership::acquire(&path)?;
        let conn = Connection::open_read_write(&path)?;
        bootstrap_schema(&conn)?;

        Ok(Self {
            db_path: path,
            conn,
            ownership: Some(ownership),
        })
    }

    /// Open an isolated in-memory `HarnessStore` without an OS file lock (for unit tests).
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        bootstrap_schema(&conn)?;
        Ok(Self {
            db_path: PathBuf::from(":memory:"),
            conn,
            ownership: None,
        })
    }

    #[must_use]
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    #[must_use]
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    pub fn connection_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// Create and persist a new agent session (`revision = 1`).
    pub fn create_agent_session(
        &mut self,
        req: CreateAgentSessionRequest,
        now_ms: i64,
    ) -> Result<AgentSessionSummary, StoreError> {
        if now_ms < 0 {
            return Err(StoreError::new(
                "invalid_clock",
                "Session timestamp cannot be negative.",
                false,
            ));
        }
        let id = match req.id {
            Some(custom) if !custom.trim().is_empty() => {
                let trimmed = custom.trim().to_owned();
                validate_session_id(&trimmed)?;
                trimmed
            }
            _ => format!("agent_session_{}", uuid_v4_simple()),
        };
        let title = normalize_and_validate_title(&req.title)?;
        let model = normalize_and_validate_model(&req.model)?;
        let token_budget = if req.token_budget <= 0 {
            DEFAULT_TOKEN_BUDGET
        } else {
            req.token_budget
        };

        let summary = AgentSessionSummary {
            id,
            title,
            cwd: req.cwd,
            environment: req.environment,
            model,
            status: "active".to_owned(),
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            revision: 1,
            token_budget,
            tokens_used: 0,
            message_count: 0,
        };
        let summary_json = compact_json(&summary.to_json())?;

        let tx = self.conn.begin_immediate()?;
        let mut del_tombstone = tx.prepare("DELETE FROM agent_deleted WHERE id = ?1;")?;
        del_tombstone.bind_text(1, &summary.id)?;
        del_tombstone.step()?;
        drop(del_tombstone);

        let mut ins = tx.prepare(
            "INSERT INTO agent_sessions (id, summary_json, updated_at_ms) VALUES (?1, ?2, ?3);",
        )?;
        ins.bind_text(1, &summary.id)?;
        ins.bind_text(2, &summary_json)?;
        ins.bind_int64(3, summary.updated_at_ms)?;
        ins.step()?;
        drop(ins);

        let mut run_ins = tx.prepare(
            "INSERT OR IGNORE INTO agent_run_state (session_id, status, snapshot_sequence)\n\
             VALUES (?1, 'idle', 0);",
        )?;
        run_ins.bind_text(1, &summary.id)?;
        run_ins.step()?;
        drop(run_ins);

        tx.commit()?;
        Ok(summary)
    }

    /// Insert or replace an exact [`AgentSessionSummary`] record (useful for fixtures/migrations).
    pub fn upsert_agent_session(
        &mut self,
        summary: &AgentSessionSummary,
    ) -> Result<AgentSessionSummary, StoreError> {
        validate_session_id(&summary.id)?;
        let title = normalize_and_validate_title(&summary.title)?;
        let model = normalize_and_validate_model(&summary.model)?;
        if summary.revision <= 0 {
            return Err(StoreError::new(
                "agent_session_revision_invalid",
                "Session revision must be positive.",
                false,
            ));
        }
        if summary.created_at_ms < 0 || summary.updated_at_ms < 0 {
            return Err(StoreError::new(
                "invalid_clock",
                "Session timestamps cannot be negative.",
                false,
            ));
        }
        let clean = AgentSessionSummary {
            title,
            model,
            ..summary.clone()
        };
        let summary_json = compact_json(&clean.to_json())?;

        let tx = self.conn.begin_immediate()?;
        let mut del_tombstone = tx.prepare("DELETE FROM agent_deleted WHERE id = ?1;")?;
        del_tombstone.bind_text(1, &clean.id)?;
        del_tombstone.step()?;
        drop(del_tombstone);

        let mut stmt = tx.prepare(
            "INSERT INTO agent_sessions (id, summary_json, updated_at_ms) VALUES (?1, ?2, ?3)\n\
             ON CONFLICT(id) DO UPDATE SET\n\
                 summary_json = excluded.summary_json,\n\
                 updated_at_ms = excluded.updated_at_ms;",
        )?;
        stmt.bind_text(1, &clean.id)?;
        stmt.bind_text(2, &summary_json)?;
        stmt.bind_int64(3, clean.updated_at_ms)?;
        stmt.step()?;
        drop(stmt);

        tx.commit()?;
        Ok(clean)
    }

    /// Load a single session summary by ID (`Ok(None)` when absent).
    pub fn get_agent_session(
        &self,
        session_id: &str,
    ) -> Result<Option<AgentSessionSummary>, StoreError> {
        validate_session_id(session_id)?;
        read_agent_session_locked(&self.conn, session_id)
    }

    /// Return `true` when `session_id` has a deletion tombstone in `agent_deleted`.
    pub fn is_session_deleted(&self, session_id: &str) -> Result<bool, StoreError> {
        validate_session_id(session_id)?;
        let mut stmt = self
            .conn
            .prepare("SELECT 1 FROM agent_deleted WHERE id = ?1;")?;
        stmt.bind_text(1, session_id)?;
        Ok(stmt.step()? == StepStatus::Row)
    }

    /// Keyset-paginated session listing ordered deterministically by `(updated_at_ms DESC, id ASC)`.
    pub fn session_page(
        &self,
        limit: usize,
        cursor: Option<&AgentSessionPageCursor>,
    ) -> Result<AgentSessionPage, StoreError> {
        let valid_limit = validate_page_limit(limit)?;
        if let Some(c) = cursor {
            validate_session_id(&c.id)?;
        }

        let total_count = self.session_count()?;
        let probe = i64::try_from(valid_limit + 1).unwrap_or(101);

        let mut stmt = if cursor.is_some() {
            self.conn.prepare(
                "SELECT summary_json\n\
                 FROM agent_sessions\n\
                 WHERE (updated_at_ms < ?1) OR (updated_at_ms = ?1 AND id > ?2)\n\
                 ORDER BY updated_at_ms DESC, id ASC\n\
                 LIMIT ?3;",
            )?
        } else {
            self.conn.prepare(
                "SELECT summary_json\n\
                 FROM agent_sessions\n\
                 ORDER BY updated_at_ms DESC, id ASC\n\
                 LIMIT ?1;",
            )?
        };

        if let Some(c) = cursor {
            stmt.bind_int64(1, c.updated_at_ms)?;
            stmt.bind_text(2, &c.id)?;
            stmt.bind_int64(3, probe)?;
        } else {
            stmt.bind_int64(1, probe)?;
        }

        let mut items = Vec::with_capacity(valid_limit);
        let mut has_more = false;
        while stmt.step()? == StepStatus::Row {
            let summary = AgentSessionSummary::from_storage_json(&stmt.column_text(0)?)?;
            if items.len() == valid_limit {
                has_more = true;
                break;
            }
            items.push(summary);
        }

        let next_cursor = if has_more {
            items.last().map(|last| AgentSessionPageCursor {
                updated_at_ms: last.updated_at_ms,
                id: last.id.clone(),
            })
        } else {
            None
        };

        Ok(AgentSessionPage {
            items,
            next_cursor,
            has_more,
            total_count,
        })
    }

    pub fn session_count(&self) -> Result<i64, StoreError> {
        let mut stmt = self.conn.prepare("SELECT COUNT(*) FROM agent_sessions;")?;
        match stmt.step()? {
            StepStatus::Row => Ok(stmt.column_int64(0)?),
            StepStatus::Done => Ok(0),
        }
    }

    /// Update a session's `title` and `model` using strict CAS `expected_revision`.
    pub fn update_agent_session_settings(
        &mut self,
        req: UpdateAgentSessionSettingsRequest,
        now_ms: i64,
    ) -> Result<AgentSessionSummary, StoreError> {
        validate_session_id(&req.session_id)?;
        if now_ms < 0 {
            return Err(StoreError::new(
                "invalid_clock",
                "Session timestamp cannot be negative.",
                false,
            ));
        }
        if req.expected_revision <= 0 {
            return Err(StoreError::new(
                "agent_session_revision_invalid",
                format!(
                    "Settings revision must be positive, got {}.",
                    req.expected_revision
                ),
                false,
            ));
        }
        let title = normalize_and_validate_title(&req.title)?;
        let model = normalize_and_validate_model(&req.model)?;

        let tx = self.conn.begin_immediate()?;
        let existing = read_agent_session_locked(&tx, &req.session_id)?.ok_or_else(|| {
            StoreError::not_found(
                "agent_session_not_found",
                format!("Agent session not found: {}", req.session_id),
            )
        })?;

        if existing.revision != req.expected_revision {
            return Err(StoreError::conflict(
                "agent_session_revision_conflict",
                format!(
                    "Settings revision conflict for {}: expected {}, stored {}",
                    req.session_id, req.expected_revision, existing.revision
                ),
            ));
        }
        if existing.revision == i64::MAX {
            return Err(StoreError::conflict(
                "agent_session_revision_exhausted",
                format!("Agent session revision exhausted for {}.", req.session_id),
            ));
        }

        let updated = AgentSessionSummary {
            title,
            model,
            updated_at_ms: now_ms.max(existing.updated_at_ms),
            revision: existing.revision + 1,
            ..existing
        };
        let summary_json = compact_json(&updated.to_json())?;

        let mut upd = tx.prepare(
            "UPDATE agent_sessions SET summary_json = ?1, updated_at_ms = ?2 WHERE id = ?3;",
        )?;
        upd.bind_text(1, &summary_json)?;
        upd.bind_int64(2, updated.updated_at_ms)?;
        upd.bind_text(3, &updated.id)?;
        upd.step()?;
        drop(upd);

        tx.commit()?;
        Ok(updated)
    }

    /// Record deletion tombstone and delete an idle/non-running session and cascade rows.
    /// Rejects active running sessions with `session_run_active`.
    pub fn delete_agent_session(&mut self, session_id: &str) -> Result<bool, StoreError> {
        validate_session_id(session_id)?;
        let tx = self.conn.begin_immediate()?;

        if let Some(run_state) = read_run_state_locked(&tx, session_id)? {
            if run_state.status == AgentRunStatus::Running {
                return Err(StoreError::conflict(
                    "session_run_active",
                    format!(
                        "Cannot delete agent session {session_id} while a run is actively running."
                    ),
                ));
            }
        }

        let mut tomb = tx.prepare("INSERT OR IGNORE INTO agent_deleted (id) VALUES (?1);")?;
        tomb.bind_text(1, session_id)?;
        tomb.step()?;
        drop(tomb);

        let mut del = tx.prepare("DELETE FROM agent_sessions WHERE id = ?1;")?;
        del.bind_text(1, session_id)?;
        del.step()?;
        drop(del);
        let deleted = tx.changes() > 0;

        tx.commit()?;
        Ok(deleted)
    }

    /// Append a message into `agent_messages` and atomically bump `message_count`, `tokens_used`,
    /// `updated_at_ms`, and `revision` on the parent session when requested.
    pub fn append_agent_message(
        &mut self,
        msg: AgentMessage,
        tokens_delta: i64,
    ) -> Result<AgentMessage, StoreError> {
        validate_session_id(&msg.session_id)?;
        if msg.role.trim().is_empty() {
            return Err(StoreError::invalid_input("Message role cannot be empty."));
        }
        let tx = self.conn.begin_immediate()?;
        let existing = read_agent_session_locked(&tx, &msg.session_id)?.ok_or_else(|| {
            StoreError::not_found(
                "agent_session_not_found",
                format!("Agent session not found: {}", msg.session_id),
            )
        })?;

        let next_seq = if msg.seq > 0 {
            msg.seq
        } else {
            let mut s = tx.prepare(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_messages WHERE session_id = ?1;",
            )?;
            s.bind_text(1, &msg.session_id)?;
            match s.step()? {
                StepStatus::Row => s.column_int64(0)?,
                StepStatus::Done => 1,
            }
        };

        let stored = AgentMessage {
            id: if msg.id.trim().is_empty() {
                format!("msg_{}", uuid_v4_simple())
            } else {
                msg.id
            },
            seq: next_seq,
            metadata: SecretRedactor::redact_json(&msg.metadata),
            ..msg
        };
        let msg_json = compact_json(&stored.to_json())?;

        let mut ins = tx.prepare(
            "INSERT INTO agent_messages (session_id, seq, message_json) VALUES (?1, ?2, ?3);",
        )?;
        ins.bind_text(1, &stored.session_id)?;
        ins.bind_int64(2, stored.seq)?;
        ins.bind_text(3, &msg_json)?;
        ins.step()?;
        drop(ins);

        let updated = AgentSessionSummary {
            updated_at_ms: stored.created_at_ms.max(existing.updated_at_ms),
            tokens_used: existing.tokens_used.saturating_add(tokens_delta.max(0)),
            message_count: existing.message_count.saturating_add(1),
            ..existing
        };
        let updated_json = compact_json(&updated.to_json())?;
        let mut upd = tx.prepare(
            "UPDATE agent_sessions SET summary_json = ?1, updated_at_ms = ?2 WHERE id = ?3;",
        )?;
        upd.bind_text(1, &updated_json)?;
        upd.bind_int64(2, updated.updated_at_ms)?;
        upd.bind_text(3, &updated.id)?;
        upd.step()?;
        drop(upd);

        tx.commit()?;
        Ok(stored)
    }

    /// Apply a completed turn (optional user message, optional assistant message, CAS revision bump).
    #[allow(clippy::too_many_arguments)]
    pub fn apply_turn(
        &mut self,
        session_id: &str,
        expected_revision: i64,
        user_content: Option<&str>,
        assistant_content: Option<&str>,
        tokens_delta: i64,
        now_ms: i64,
    ) -> Result<AgentSessionSummary, StoreError> {
        validate_session_id(session_id)?;
        if expected_revision <= 0 {
            return Err(StoreError::new(
                "agent_session_revision_invalid",
                "Expected session revision must be positive.",
                false,
            ));
        }
        if now_ms < 0 {
            return Err(StoreError::new(
                "invalid_clock",
                "Turn timestamp cannot be negative.",
                false,
            ));
        }

        let tx = self.conn.begin_immediate()?;
        let existing = read_agent_session_locked(&tx, session_id)?.ok_or_else(|| {
            StoreError::not_found(
                "agent_session_not_found",
                format!("Agent session not found: {session_id}"),
            )
        })?;
        if existing.revision != expected_revision {
            return Err(StoreError::conflict(
                "agent_session_revision_conflict",
                format!(
                    "Revision conflict applying turn to {session_id}: expected {expected_revision}, stored {}",
                    existing.revision
                ),
            ));
        }
        if existing.revision == i64::MAX {
            return Err(StoreError::conflict(
                "agent_session_revision_exhausted",
                format!("Agent session revision exhausted for {session_id}."),
            ));
        }

        let mut seq_stmt =
            tx.prepare("SELECT COALESCE(MAX(seq), 0) FROM agent_messages WHERE session_id = ?1;")?;
        seq_stmt.bind_text(1, session_id)?;
        let mut seq = match seq_stmt.step()? {
            StepStatus::Row => seq_stmt.column_int64(0)?,
            StepStatus::Done => 0,
        };
        drop(seq_stmt);

        let mut added = 0i64;
        for (role, text_opt) in [("user", user_content), ("assistant", assistant_content)] {
            if let Some(content) = text_opt {
                seq += 1;
                added += 1;
                let msg = AgentMessage {
                    id: format!("msg_{}", uuid_v4_simple()),
                    session_id: session_id.to_owned(),
                    seq,
                    role: role.to_owned(),
                    content: content.to_owned(),
                    created_at_ms: now_ms,
                    metadata: json!({}),
                };
                let msg_json = compact_json(&msg.to_json())?;
                let mut ins = tx.prepare(
                    "INSERT INTO agent_messages (session_id, seq, message_json) VALUES (?1, ?2, ?3);",
                )?;
                ins.bind_text(1, session_id)?;
                ins.bind_int64(2, seq)?;
                ins.bind_text(3, &msg_json)?;
                ins.step()?;
            }
        }

        let updated = AgentSessionSummary {
            updated_at_ms: now_ms.max(existing.updated_at_ms),
            revision: existing.revision + 1,
            tokens_used: existing.tokens_used.saturating_add(tokens_delta.max(0)),
            message_count: existing.message_count.saturating_add(added),
            ..existing
        };
        let summary_json = compact_json(&updated.to_json())?;
        let mut upd = tx.prepare(
            "UPDATE agent_sessions SET summary_json = ?1, updated_at_ms = ?2 WHERE id = ?3;",
        )?;
        upd.bind_text(1, &summary_json)?;
        upd.bind_int64(2, updated.updated_at_ms)?;
        upd.bind_text(3, &updated.id)?;
        upd.step()?;
        drop(upd);

        tx.commit()?;
        Ok(updated)
    }

    pub fn list_agent_messages(&self, session_id: &str) -> Result<Vec<AgentMessage>, StoreError> {
        validate_session_id(session_id)?;
        let mut stmt = self.conn.prepare(
            "SELECT message_json FROM agent_messages WHERE session_id = ?1 ORDER BY seq ASC;",
        )?;
        stmt.bind_text(1, session_id)?;
        let mut out = Vec::new();
        while stmt.step()? == StepStatus::Row {
            out.push(AgentMessage::from_storage_json(&stmt.column_text(0)?)?);
        }
        Ok(out)
    }

    pub fn get_run_state(
        &self,
        session_id: &str,
    ) -> Result<Option<AgentRunStateRecord>, StoreError> {
        validate_session_id(session_id)?;
        read_run_state_locked(&self.conn, session_id)
    }

    pub fn set_run_state(&mut self, state: &AgentRunStateRecord) -> Result<(), StoreError> {
        validate_session_id(&state.session_id)?;
        let tx = self.conn.begin_immediate()?;
        if read_agent_session_locked(&tx, &state.session_id)?.is_none() {
            return Err(StoreError::not_found(
                "agent_session_not_found",
                format!("Agent session not found: {}", state.session_id),
            ));
        }
        let mut stmt = tx.prepare(
            "INSERT INTO agent_run_state (session_id, status, snapshot_sequence)\n\
             VALUES (?1, ?2, ?3)\n\
             ON CONFLICT(session_id) DO UPDATE SET\n\
                 status = excluded.status,\n\
                 snapshot_sequence = excluded.snapshot_sequence;",
        )?;
        stmt.bind_text(1, &state.session_id)?;
        stmt.bind_text(2, state.status.as_str())?;
        stmt.bind_int64(3, state.snapshot_sequence)?;
        stmt.step()?;
        drop(stmt);
        tx.commit()?;
        Ok(())
    }

    /// Append a secret-redacted [`AgentEvent`] to `agent_events`.
    pub fn append_agent_event(
        &mut self,
        session_id: &str,
        run_id: &str,
        event_type: &str,
        payload: Value,
        now_ms: i64,
    ) -> Result<AgentEvent, StoreError> {
        validate_session_id(session_id)?;
        if run_id.trim().is_empty() || event_type.trim().is_empty() {
            return Err(StoreError::invalid_input(
                "Event run_id and event_type cannot be empty.",
            ));
        }
        let redacted_payload = SecretRedactor::redact_json(&payload);
        let event_doc = json!({
            "runId": run_id.trim(),
            "eventType": event_type.trim(),
            "payload": redacted_payload,
            "createdAtMs": now_ms,
        });
        let event_json = compact_json(&event_doc)?;

        let tx = self.conn.begin_immediate()?;
        if read_agent_session_locked(&tx, session_id)?.is_none() {
            return Err(StoreError::not_found(
                "agent_session_not_found",
                format!("Agent session not found: {session_id}"),
            ));
        }
        let mut stmt =
            tx.prepare("INSERT INTO agent_events (session_id, event_json) VALUES (?1, ?2);")?;
        stmt.bind_text(1, session_id)?;
        stmt.bind_text(2, &event_json)?;
        stmt.step()?;
        drop(stmt);
        let seq = tx.last_insert_rowid();
        tx.commit()?;

        Ok(AgentEvent {
            sequence: seq,
            session_id: session_id.to_owned(),
            run_id: run_id.trim().to_owned(),
            event_type: event_type.trim().to_owned(),
            payload: redacted_payload,
            created_at_ms: now_ms,
        })
    }

    pub fn list_agent_events(
        &self,
        session_id: &str,
        since_sequence: i64,
    ) -> Result<Vec<AgentEvent>, StoreError> {
        validate_session_id(session_id)?;
        let mut stmt = self.conn.prepare(
            "SELECT sequence, event_json\n\
             FROM agent_events\n\
             WHERE session_id = ?1 AND sequence > ?2\n\
             ORDER BY sequence ASC;",
        )?;
        stmt.bind_text(1, session_id)?;
        stmt.bind_int64(2, since_sequence)?;
        let mut out = Vec::new();
        while stmt.step()? == StepStatus::Row {
            let seq = stmt.column_int64(0)?;
            let raw = stmt.column_text(1)?;
            out.push(AgentEvent::from_storage_json(seq, session_id, &raw)?);
        }
        Ok(out)
    }

    pub fn set_workspace_trust(&mut self, cwd: &str, fingerprint: &str) -> Result<(), StoreError> {
        if cwd.trim().is_empty() || fingerprint.trim().is_empty() {
            return Err(StoreError::invalid_input(
                "workspace_trust cwd and fingerprint cannot be empty.",
            ));
        }
        let tx = self.conn.begin_immediate()?;
        let mut stmt = tx.prepare(
            "INSERT INTO workspace_trust (cwd, fingerprint) VALUES (?1, ?2)\n\
             ON CONFLICT(cwd) DO UPDATE SET fingerprint = excluded.fingerprint;",
        )?;
        stmt.bind_text(1, cwd)?;
        stmt.bind_text(2, fingerprint)?;
        stmt.step()?;
        drop(stmt);
        tx.commit()?;
        Ok(())
    }

    pub fn get_workspace_trust(&self, cwd: &str) -> Result<Option<String>, StoreError> {
        if cwd.trim().is_empty() {
            return Err(StoreError::invalid_input(
                "workspace_trust cwd cannot be empty.",
            ));
        }
        let mut stmt = self
            .conn
            .prepare("SELECT fingerprint FROM workspace_trust WHERE cwd = ?1;")?;
        stmt.bind_text(1, cwd)?;
        match stmt.step()? {
            StepStatus::Row => Ok(Some(stmt.column_text(0)?)),
            StepStatus::Done => Ok(None),
        }
    }

    pub fn load_session_navigation(
        &self,
    ) -> Result<Option<AgentSessionNavigationSnapshot>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT revision, snapshot_json FROM agent_session_navigation WHERE singleton = 1;",
        )?;
        match stmt.step()? {
            StepStatus::Row => {
                let rev = stmt.column_int64(0)?;
                let raw = stmt.column_text(1)?;
                Ok(Some(AgentSessionNavigationSnapshot::from_storage_json(
                    &raw, rev,
                )?))
            }
            StepStatus::Done => Ok(None),
        }
    }

    /// Save navigation state atomically with CAS revision checks and idempotent receipt tracking.
    pub fn save_session_navigation(
        &mut self,
        req: SaveAgentSessionNavigationRequest,
        now_ms: i64,
    ) -> Result<AgentSessionNavigationSnapshot, StoreError> {
        if req.receipt_id.trim().is_empty() {
            return Err(StoreError::new(
                "session_navigation_receipt_missing",
                "Navigation save requires a non-empty receipt_id.",
                false,
            ));
        }
        if now_ms < 0 {
            return Err(StoreError::new(
                "invalid_clock",
                "Navigation timestamp cannot be negative.",
                false,
            ));
        }
        if let Some(ref active) = req.active_session_id {
            validate_session_id(active)?;
        }
        let page_limit = if req.page_limit == 0 {
            DEFAULT_AGENT_SESSION_PAGE_LIMIT
        } else {
            validate_page_limit(req.page_limit)?
        };
        if let Some(ref cursor) = req.cursor {
            validate_session_id(&cursor.id)?;
        }

        let mut dedup_open = Vec::with_capacity(req.open_session_ids.len());
        let mut seen = HashSet::with_capacity(req.open_session_ids.len());
        for raw_id in req.open_session_ids {
            validate_session_id(&raw_id)?;
            if seen.insert(raw_id.clone()) {
                dedup_open.push(raw_id);
            }
        }
        if dedup_open.len() > MAX_NAVIGATION_OPEN_SESSION_IDS {
            return Err(StoreError::new(
                "session_navigation_invalid",
                format!("open_session_ids exceeds maximum {MAX_NAVIGATION_OPEN_SESSION_IDS}."),
                false,
            ));
        }
        if let Some(ref active) = req.active_session_id {
            if !seen.contains(active) {
                if dedup_open.len() >= MAX_NAVIGATION_OPEN_SESSION_IDS {
                    return Err(StoreError::new(
                        "session_navigation_invalid",
                        "open_session_ids cannot fit active_session_id within capacity.",
                        false,
                    ));
                }
                dedup_open.push(active.clone());
            }
        }

        let tx = self.conn.begin_immediate()?;

        // Idempotent replay by receipt_id.
        let mut receipt_stmt = tx.prepare(
            "SELECT revision, snapshot_json FROM agent_session_navigation_receipts WHERE receipt_id = ?1;",
        )?;
        receipt_stmt.bind_text(1, &req.receipt_id)?;
        if receipt_stmt.step()? == StepStatus::Row {
            let rev = receipt_stmt.column_int64(0)?;
            let raw = receipt_stmt.column_text(1)?;
            drop(receipt_stmt);
            let existing_snap = AgentSessionNavigationSnapshot::from_storage_json(&raw, rev)?;
            tx.commit()?;
            return Ok(existing_snap);
        }
        drop(receipt_stmt);

        let mut nav_stmt =
            tx.prepare("SELECT revision FROM agent_session_navigation WHERE singleton = 1;")?;
        let current_rev = match nav_stmt.step()? {
            StepStatus::Row => Some(nav_stmt.column_int64(0)?),
            StepStatus::Done => None,
        };
        drop(nav_stmt);

        let next_rev = match (current_rev, req.expected_revision) {
            (None, None) | (None, Some(0)) => 1,
            (None, Some(expected)) => {
                return Err(StoreError::conflict(
                    "navigation_conflict",
                    format!(
                        "Navigation revision conflict: expected {expected}, no snapshot stored."
                    ),
                ));
            }
            (Some(curr), Some(expected)) if curr == expected => {
                if curr == i64::MAX {
                    return Err(StoreError::conflict(
                        "session_navigation_revision_exhausted",
                        "Session navigation revision exhausted.",
                    ));
                }
                curr + 1
            }
            (Some(curr), None) => {
                if curr == i64::MAX {
                    return Err(StoreError::conflict(
                        "session_navigation_revision_exhausted",
                        "Session navigation revision exhausted.",
                    ));
                }
                // Callers explicitly passing `None` on first save fail if row already exists unless matching CAS;
                // wait: preserve C++ strictness or require CAS when row exists! Look: returning navigation_conflict
                // if `expected_revision` is `None` while row already exists catches blind overwrites!
                return Err(StoreError::conflict(
                    "navigation_conflict",
                    format!(
                        "Navigation revision conflict: snapshot already at revision {curr}, expected none."
                    ),
                ));
            }
            (Some(curr), Some(expected)) => {
                return Err(StoreError::conflict(
                    "navigation_conflict",
                    format!("Navigation revision conflict: expected {expected}, stored {curr}."),
                ));
            }
        };

        let snapshot = AgentSessionNavigationSnapshot {
            revision: next_rev,
            active_session_id: req.active_session_id,
            open_session_ids: dedup_open,
            page_limit,
            cursor: req.cursor,
            updated_at_ms: now_ms,
        };
        let snap_json = compact_json(&snapshot.to_json())?;

        let mut upsert_nav = tx.prepare(
            "INSERT INTO agent_session_navigation (singleton, revision, snapshot_json)\n\
             VALUES (1, ?1, ?2)\n\
             ON CONFLICT(singleton) DO UPDATE SET\n\
                 revision = excluded.revision,\n\
                 snapshot_json = excluded.snapshot_json;",
        )?;
        upsert_nav.bind_int64(1, next_rev)?;
        upsert_nav.bind_text(2, &snap_json)?;
        upsert_nav.step()?;
        drop(upsert_nav);

        let mut ins_receipt = tx.prepare(
            "INSERT INTO agent_session_navigation_receipts (receipt_id, revision, snapshot_json)\n\
             VALUES (?1, ?2, ?3);",
        )?;
        ins_receipt.bind_text(1, &req.receipt_id)?;
        ins_receipt.bind_int64(2, next_rev)?;
        ins_receipt.bind_text(3, &snap_json)?;
        ins_receipt.step()?;
        drop(ins_receipt);

        tx.commit()?;
        Ok(snapshot)
    }
}

fn bootstrap_schema(conn: &Connection) -> Result<(), StoreError> {
    conn.exec_batch(HARNESS_STORE_SCHEMA_SQL)?;
    conn.exec_batch(HARNESS_RECOVERY_SQL)?;
    Ok(())
}

fn read_agent_session_locked(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<AgentSessionSummary>, StoreError> {
    let mut stmt = conn.prepare("SELECT summary_json FROM agent_sessions WHERE id = ?1;")?;
    stmt.bind_text(1, session_id)?;
    match stmt.step()? {
        StepStatus::Row => Ok(Some(AgentSessionSummary::from_storage_json(
            &stmt.column_text(0)?,
        )?)),
        StepStatus::Done => Ok(None),
    }
}

fn read_run_state_locked(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<AgentRunStateRecord>, StoreError> {
    let mut stmt = conn.prepare(
        "SELECT session_id, status, snapshot_sequence FROM agent_run_state WHERE session_id = ?1;",
    )?;
    stmt.bind_text(1, session_id)?;
    match stmt.step()? {
        StepStatus::Row => {
            let sid = stmt.column_text(0)?;
            let status_raw = stmt.column_text(1)?;
            let seq = stmt.column_int64(2)?;
            Ok(Some(AgentRunStateRecord {
                session_id: sid,
                status: AgentRunStatus::parse(&status_raw)?,
                snapshot_sequence: seq,
            }))
        }
        StepStatus::Done => Ok(None),
    }
}
