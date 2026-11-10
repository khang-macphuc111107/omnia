//! Durable storage for agent-harness sessions. Kept in its own SQLite file so
//! the harness does not couple to the legacy conversation schema.

use std::path::Path;
use std::sync::Mutex;

use omnia_harness::permission::{PermissionMode, PermissionRule};
use omnia_harness::Message;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAgentEvent {
    pub sequence: i64,
    pub event: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReplay {
    #[serde(rename = "runStatus")]
    pub status: String,
    #[serde(rename = "replayEvents")]
    pub events: Vec<StoredAgentEvent>,
    pub pending_approvals: Vec<Value>,
    /// Calls that started without a durable completion. Never replay these automatically.
    pub unknown_side_effects: Vec<String>,
    pub event_cursor: i64,
}

use crate::error::{NativeError, NativeResult};

/// Durable membership of a chat session. Projectless sessions still use an
/// app-owned scratch directory for provider/tool execution, so scope must not
/// be inferred from whether `cwd` happens to be non-empty.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionScope {
    Projectless,
    #[default]
    Project,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummary {
    pub id: String,
    pub title: String,
    /// Explicit project membership; legacy summaries default to `Project`.
    #[serde(default)]
    pub scope: SessionScope,
    pub cwd: String,
    pub profile_id: String,
    pub model: String,
    pub permission_mode: PermissionMode,
    #[serde(default)]
    pub rules: Vec<PermissionRule>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// Ordered, user-configured fallback models (same provider profile).
    #[serde(default)]
    pub fallback_models: Vec<String>,
    /// Optional cap on input + output tokens across the whole session.
    #[serde(default)]
    pub token_budget: Option<u64>,
    /// Cumulative input + output tokens spent by this session's runs.
    #[serde(default)]
    pub tokens_used: u64,
    /// User-authored system prompt override for this session.
    #[serde(default)]
    pub system_prompt: Option<omnia_harness::prompt::SystemPromptConfig>,
    /// Session this one was forked from, if any.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Monotonic revision for user-editable per-session settings. Transcript
    /// and usage projections do not advance this counter, so a renderer can
    /// use it as a compare-and-swap token when settings are edited in more
    /// than one window.
    #[serde(default = "default_settings_revision")]
    pub settings_revision: u64,
    pub message_count: usize,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

fn default_settings_revision() -> u64 {
    1
}

/// One session with its transcript and event journal, for export/import.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionBundle {
    pub summary: AgentSessionSummary,
    pub messages: Vec<Value>,
    #[serde(default)]
    pub events: Vec<Value>,
}

pub struct HarnessStore {
    // Field drop order is significant: close SQLite before releasing ownership.
    connection: Mutex<Connection>,
    _ownership: Option<crate::ownership::StoreOwnership>,
}

fn storage_error(error: impl std::fmt::Display) -> NativeError {
    NativeError::new(
        "harness_storage_failed",
        format!("Agent session storage failed: {error}"),
    )
}

impl HarnessStore {
    pub fn open(path: &Path) -> NativeResult<Self> {
        let ownership = crate::ownership::StoreOwnership::acquire(path)?;
        let connection = Connection::open(path).map_err(storage_error)?;
        let mut store = Self::with_connection(connection)?;
        store._ownership = Some(ownership);
        Ok(store)
    }

    /// Synthetic multi-connection SQLite snapshot fixture only. Never available
    /// to production consumers or external test-support users.
    #[cfg(test)]
    pub(crate) fn open_snapshot_fixture(path: &Path) -> NativeResult<Self> {
        Self::with_connection(Connection::open(path).map_err(storage_error)?)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn in_memory() -> NativeResult<Self> {
        Self::with_connection(Connection::open_in_memory().map_err(storage_error)?)
    }

    fn with_connection(connection: Connection) -> NativeResult<Self> {
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS agent_sessions (
                     id TEXT PRIMARY KEY,
                     summary_json TEXT NOT NULL,
                     updated_at_ms INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS agent_sessions_page_order
                   ON agent_sessions(updated_at_ms DESC, id ASC);
                 CREATE TABLE IF NOT EXISTS agent_messages (
                     session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
                     seq INTEGER NOT NULL,
                     message_json TEXT NOT NULL,
                     PRIMARY KEY (session_id, seq)
                 );
                 CREATE TABLE IF NOT EXISTS agent_deleted (id TEXT PRIMARY KEY);
                 CREATE TABLE IF NOT EXISTS agent_events (
                     sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                     session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
                     event_json TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS agent_run_state (
                     session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
                     status TEXT NOT NULL,
                     snapshot_sequence INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE TABLE IF NOT EXISTS workspace_trust (
                     cwd TEXT PRIMARY KEY, fingerprint TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS agent_session_navigation (
                     singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                     revision INTEGER NOT NULL CHECK(revision > 0),
                     snapshot_json TEXT NOT NULL
                 );
                 -- Navigation receipts are immutable facts.  The singleton
                 -- row above is only the current projection; keeping a
                 -- receipt row per committed revision means a restart (or a
                 -- conflict response) can return the same durable identity
                 -- instead of manufacturing a new UUID for the same state.
                 CREATE TABLE IF NOT EXISTS agent_session_navigation_receipts (
                     receipt_id TEXT PRIMARY KEY,
                     revision INTEGER NOT NULL UNIQUE CHECK(revision > 0),
                     snapshot_json TEXT NOT NULL
                 );
                 -- Databases created before durable receipts existed may
                 -- already contain one current navigation row.  Preserve
                 -- that state with a deterministic migration receipt; it is
                 -- only a compatibility marker and is never reused for a
                 -- newly committed revision.
                 INSERT OR IGNORE INTO agent_session_navigation_receipts
                     (receipt_id, revision, snapshot_json)
                 SELECT 'session_navigation_legacy_' || revision, revision, snapshot_json
                   FROM agent_session_navigation
                  WHERE singleton = 1 AND revision > 0;
                 UPDATE agent_run_state SET status = 'interrupted' WHERE status = 'running';",
            )
            .map_err(storage_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
            _ownership: None,
        })
    }

    pub(crate) fn lock(&self) -> NativeResult<std::sync::MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| storage_error("lock poisoned"))
    }

    pub fn save_summary(&self, summary: &AgentSessionSummary) -> NativeResult<()> {
        let json = serde_json::to_string(summary).map_err(storage_error)?;
        let connection = self.lock()?;
        let deleted: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_deleted WHERE id = ?1)",
                [&summary.id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if deleted {
            return Err(storage_error("session was deleted"));
        }
        connection
            .execute(
                "INSERT INTO agent_sessions (id, summary_json, updated_at_ms) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET summary_json = excluded.summary_json,
                                               updated_at_ms = excluded.updated_at_ms",
                params![summary.id, json, summary.updated_at_ms],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn summary(&self, id: &str) -> NativeResult<AgentSessionSummary> {
        let json: Option<String> = self
            .lock()?
            .query_row(
                "SELECT summary_json FROM agent_sessions WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        let json = json.ok_or_else(|| {
            NativeError::new(
                "agent_session_not_found",
                "The agent session does not exist",
            )
        })?;
        serde_json::from_str(&json).map_err(storage_error)
    }

    pub fn list(&self) -> NativeResult<Vec<AgentSessionSummary>> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT summary_json FROM agent_sessions ORDER BY updated_at_ms DESC")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        let mut sessions = Vec::new();
        for row in rows {
            sessions
                .push(serde_json::from_str(&row.map_err(storage_error)?).map_err(storage_error)?);
        }
        Ok(sessions)
    }

    /// Every session with transcript and journal, read in one consistent snapshot.
    pub fn export_bundles(&self) -> NativeResult<Vec<SessionBundle>> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(storage_error)?;
        let mut bundles = Vec::new();
        {
            let mut sessions = tx
                .prepare("SELECT id, summary_json FROM agent_sessions ORDER BY updated_at_ms DESC")
                .map_err(storage_error)?;
            let rows = sessions
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(storage_error)?;
            let mut messages = tx
                .prepare(
                    "SELECT message_json FROM agent_messages WHERE session_id = ?1 ORDER BY seq",
                )
                .map_err(storage_error)?;
            let mut events = tx
                .prepare(
                    "SELECT event_json FROM agent_events WHERE session_id = ?1 ORDER BY sequence",
                )
                .map_err(storage_error)?;
            for row in rows {
                let (id, raw) = row.map_err(storage_error)?;
                let parse =
                    |raw: String| serde_json::from_str::<Value>(&raw).map_err(storage_error);
                let message_rows = messages
                    .query_map([&id], |row| row.get::<_, String>(0))
                    .map_err(storage_error)?;
                let event_rows = events
                    .query_map([&id], |row| row.get::<_, String>(0))
                    .map_err(storage_error)?;
                bundles.push(SessionBundle {
                    summary: serde_json::from_str(&raw).map_err(storage_error)?,
                    messages: message_rows
                        .map(|r| parse(r.map_err(storage_error)?))
                        .collect::<NativeResult<_>>()?,
                    events: event_rows
                        .map(|r| parse(r.map_err(storage_error)?))
                        .collect::<NativeResult<_>>()?,
                });
            }
        }
        tx.commit().map_err(storage_error)?;
        Ok(bundles)
    }

    /// Imports sessions atomically. With `replace` every existing session is
    /// dropped first; otherwise ids that already exist are skipped and returned.
    /// Imported sessions come back idle, and an import un-deletes its ids.
    pub fn import_bundles(
        &self,
        bundles: &[SessionBundle],
        replace: bool,
    ) -> NativeResult<(usize, Vec<String>)> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(storage_error)?;
        if replace {
            tx.execute("DELETE FROM agent_sessions", [])
                .map_err(storage_error)?;
        }
        let (mut imported, mut skipped) = (0, Vec::new());
        for bundle in bundles {
            let id = &bundle.summary.id;
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE id = ?1)",
                    [id],
                    |r| r.get(0),
                )
                .map_err(storage_error)?;
            if exists {
                skipped.push(id.clone());
                continue;
            }
            let mut summary = bundle.summary.clone();
            summary.message_count = bundle.messages.len();
            tx.execute("DELETE FROM agent_deleted WHERE id = ?1", [id])
                .map_err(storage_error)?;
            tx.execute(
                "INSERT INTO agent_sessions (id, summary_json, updated_at_ms) VALUES (?1, ?2, ?3)",
                params![
                    id,
                    serde_json::to_string(&summary).map_err(storage_error)?,
                    summary.updated_at_ms
                ],
            )
            .map_err(storage_error)?;
            for (seq, message) in bundle.messages.iter().enumerate() {
                tx.execute(
                    "INSERT INTO agent_messages (session_id, seq, message_json) VALUES (?1, ?2, ?3)",
                    params![id, seq as i64, serde_json::to_string(message).map_err(storage_error)?],
                )
                .map_err(storage_error)?;
            }
            for event in &bundle.events {
                tx.execute(
                    "INSERT INTO agent_events (session_id, event_json) VALUES (?1, ?2)",
                    params![id, serde_json::to_string(event).map_err(storage_error)?],
                )
                .map_err(storage_error)?;
            }
            imported += 1;
        }
        tx.commit().map_err(storage_error)?;
        Ok((imported, skipped))
    }

    pub fn delete(&self, id: &str) -> NativeResult<()> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(storage_error)?;
        tx.execute("INSERT OR IGNORE INTO agent_deleted (id) VALUES (?1)", [id])
            .map_err(storage_error)?;
        tx.execute("DELETE FROM agent_sessions WHERE id = ?1", [id])
            .map_err(storage_error)?;
        tx.commit().map_err(storage_error)
    }

    pub fn messages(&self, id: &str) -> NativeResult<Vec<Message>> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT message_json FROM agent_messages WHERE session_id = ?1 ORDER BY seq")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([id], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        rows.map(|row| serde_json::from_str(&row.map_err(storage_error)?).map_err(storage_error))
            .collect()
    }

    /// Mutate only the requested metadata under the same lock as transcript writes.
    /// Unlike an upsert this cannot resurrect a deleted session.
    pub fn update_summary(
        &self,
        id: &str,
        update: impl FnOnce(&mut AgentSessionSummary),
    ) -> NativeResult<AgentSessionSummary> {
        let connection = self.lock()?;
        let raw: String = connection
            .query_row(
                "SELECT summary_json FROM agent_sessions WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        let mut summary: AgentSessionSummary = serde_json::from_str(&raw).map_err(storage_error)?;
        update(&mut summary);
        connection
            .execute(
                "UPDATE agent_sessions SET summary_json = ?2, updated_at_ms = ?3 WHERE id = ?1",
                params![
                    id,
                    serde_json::to_string(&summary).map_err(storage_error)?,
                    summary.updated_at_ms
                ],
            )
            .map_err(storage_error)?;
        Ok(summary)
    }

    /// Updates user-editable session settings under a native compare-and-swap
    /// revision. The ordinary metadata updater remains unconditional because
    /// transcript/usage projections can arrive while a run is streaming; this
    /// path is reserved for renderer-authored settings writes.
    pub fn update_summary_cas(
        &self,
        id: &str,
        expected_revision: Option<u64>,
        update: impl FnOnce(&mut AgentSessionSummary),
    ) -> NativeResult<AgentSessionSummary> {
        if let Some(expected) = expected_revision {
            if expected == 0 {
                return Err(NativeError::invalid(
                    "expectedSettingsRevision",
                    "must be a positive integer",
                ));
            }
        }
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let raw: String = transaction
            .query_row(
                "SELECT summary_json FROM agent_sessions WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        let mut summary: AgentSessionSummary = serde_json::from_str(&raw).map_err(storage_error)?;
        let current_revision = summary.settings_revision;
        if current_revision == 0 {
            return Err(NativeError::new(
                "agent_session_revision_invalid",
                "The stored session settings revision is invalid",
            ));
        }
        if expected_revision.is_some_and(|expected| expected != current_revision) {
            return Err(NativeError::retryable(
                "agent_session_revision_conflict",
                format!(
                    "Session settings changed elsewhere (expected revision {}, current revision {})",
                    expected_revision.unwrap_or_default(),
                    current_revision
                ),
            ));
        }
        let next_revision = current_revision.checked_add(1).ok_or_else(|| {
            NativeError::new(
                "agent_session_revision_exhausted",
                "Session settings revision is exhausted",
            )
        })?;
        if next_revision > 9_007_199_254_740_991 {
            return Err(NativeError::new(
                "agent_session_revision_exhausted",
                "Session settings revision exceeds the supported range",
            ));
        }
        update(&mut summary);
        summary.settings_revision = next_revision;
        transaction
            .execute(
                "UPDATE agent_sessions SET summary_json = ?2, updated_at_ms = ?3 WHERE id = ?1",
                params![
                    id,
                    serde_json::to_string(&summary).map_err(storage_error)?,
                    summary.updated_at_ms
                ],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(summary)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn begin_run(&self, id: &str) -> NativeResult<()> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(storage_error)?;
        tx.execute("INSERT INTO agent_run_state(session_id,status) VALUES (?1,'running') ON CONFLICT(session_id) DO UPDATE SET status='running'", [id]).map_err(storage_error)?;
        tx.commit().map_err(storage_error)
    }

    pub fn append_event(&self, id: &str, event: &Value) -> NativeResult<i64> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(storage_error)?;
        tx.execute(
            "INSERT INTO agent_events (session_id, event_json) VALUES (?1, ?2)",
            params![id, serde_json::to_string(event).map_err(storage_error)?],
        )
        .map_err(storage_error)?;
        let sequence = tx.last_insert_rowid();
        let status = match event.get("type").and_then(Value::as_str) {
            Some("run_started") => Some("running"),
            Some("run_finished") => Some(
                event
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("failed"),
            ),
            _ => None,
        };
        if let Some(status) = status {
            tx.execute("INSERT INTO agent_run_state (session_id, status) VALUES (?1, ?2) ON CONFLICT(session_id) DO UPDATE SET status = excluded.status", params![id, status]).map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)?;
        Ok(sequence)
    }

    pub fn read_snapshot(
        &self,
        id: &str,
    ) -> NativeResult<(AgentSessionSummary, Vec<Message>, RunReplay)> {
        let connection = self.lock()?;
        let raw: String = connection
            .query_row(
                "SELECT summary_json FROM agent_sessions WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        let summary = serde_json::from_str(&raw).map_err(storage_error)?;
        let mut statement = connection
            .prepare("SELECT message_json FROM agent_messages WHERE session_id=?1 ORDER BY seq")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([id], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        let messages = rows
            .map(|row| serde_json::from_str(&row.map_err(storage_error)?).map_err(storage_error))
            .collect::<NativeResult<Vec<_>>>()?;
        Ok((summary, messages, Self::replay_locked(&connection, id)?))
    }

    pub fn replay(&self, id: &str) -> NativeResult<RunReplay> {
        let connection = self.lock()?;
        Self::replay_locked(&connection, id)
    }

    fn replay_locked(connection: &Connection, id: &str) -> NativeResult<RunReplay> {
        let (status, snapshot): (String, i64) = connection
            .query_row(
                "SELECT status,snapshot_sequence FROM agent_run_state WHERE session_id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage_error)?
            .unwrap_or(("idle".into(), 0));
        let mut cursor = snapshot;
        let mut statement = connection.prepare("SELECT sequence, event_json FROM agent_events WHERE session_id = ?1 ORDER BY sequence").map_err(storage_error)?;
        let rows = statement
            .query_map([id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(storage_error)?;
        let mut events = Vec::new();
        let mut pending = std::collections::BTreeMap::new();
        let mut started = std::collections::BTreeSet::new();
        for row in rows {
            let (sequence, raw) = row.map_err(storage_error)?;
            let event: Value = serde_json::from_str(&raw).map_err(storage_error)?;
            // IDs may be reused by providers between runs. Keep outstanding calls
            // across runs, but a completed approval must never reappear.
            match event.get("type").and_then(Value::as_str) {
                Some("approval_requested") => {
                    if let Some(request) = event.get("request") {
                        if let Some(id) = request.get("tool_use_id").and_then(Value::as_str) {
                            pending.insert(id.to_owned(), request.clone());
                        }
                    }
                }
                Some("approval_decided") => {
                    if let Some(id) = event.get("id").and_then(Value::as_str) {
                        pending.remove(id);
                    }
                }
                Some("tool_started") | Some("tool_completed") | Some("subagent") => {
                    fn track(
                        event: &Value,
                        prefix: &str,
                        started: &mut std::collections::BTreeSet<String>,
                    ) {
                        match event.get("type").and_then(Value::as_str) {
                            Some("subagent") => {
                                if let (Some(parent), Some(inner)) = (
                                    event.get("parent_id").and_then(Value::as_str),
                                    event.get("event"),
                                ) {
                                    track(inner, &format!("{prefix}{parent}/"), started);
                                }
                            }
                            Some(kind @ ("tool_started" | "tool_completed")) => {
                                if let Some(id) = event.get("id").and_then(Value::as_str) {
                                    let key = format!("{prefix}{id}");
                                    if kind == "tool_started" {
                                        started.insert(key);
                                    } else {
                                        started.remove(&key);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    track(&event, "", &mut started);
                }
                Some("run_finished") => pending.clear(),
                _ => {}
            }
            cursor = cursor.max(sequence);
            if sequence > snapshot {
                events.push(StoredAgentEvent { sequence, event });
            }
        }
        // After process restart there are no live senders. These approvals are
        // retained in events for audit, not presented as answerable requests.
        if status != "running" {
            pending.clear();
        }
        Ok(RunReplay {
            status,
            events,
            pending_approvals: pending.into_values().collect(),
            unknown_side_effects: started.into_iter().collect(),
            event_cursor: cursor,
        })
    }

    pub fn workspace_trusted(&self, cwd: &str, fingerprint: &str) -> NativeResult<bool> {
        let stored: Option<String> = self
            .lock()?
            .query_row(
                "SELECT fingerprint FROM workspace_trust WHERE cwd = ?1",
                [cwd],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        Ok(stored.as_deref() == Some(fingerprint))
    }

    pub fn set_workspace_trust(&self, cwd: &str, fingerprint: Option<&str>) -> NativeResult<()> {
        let connection = self.lock()?;
        if let Some(fingerprint) = fingerprint {
            connection.execute("INSERT INTO workspace_trust (cwd, fingerprint) VALUES (?1, ?2) ON CONFLICT(cwd) DO UPDATE SET fingerprint = excluded.fingerprint", params![cwd, fingerprint]).map_err(storage_error)?;
        } else {
            connection
                .execute("DELETE FROM workspace_trust WHERE cwd = ?1", [cwd])
                .map_err(storage_error)?;
        }
        Ok(())
    }

    /// Replaces the transcript. Messages before `keep` are untouched, so
    /// appending a turn rewrites only the tail.
    pub fn write_messages(&self, id: &str, messages: &[Message], keep: usize) -> NativeResult<()> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(storage_error)?;
        let raw: String = tx
            .query_row(
                "SELECT summary_json FROM agent_sessions WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        let mut summary: AgentSessionSummary = serde_json::from_str(&raw).map_err(storage_error)?;
        summary.message_count = messages.len();
        summary.updated_at_ms = chrono::Utc::now().timestamp_millis();
        tx.execute(
            "UPDATE agent_sessions SET summary_json = ?2, updated_at_ms = ?3 WHERE id = ?1",
            params![
                id,
                serde_json::to_string(&summary).map_err(storage_error)?,
                summary.updated_at_ms
            ],
        )
        .map_err(storage_error)?;
        tx.execute(
            "DELETE FROM agent_messages WHERE session_id = ?1 AND seq >= ?2",
            params![id, keep as i64],
        )
        .map_err(storage_error)?;
        for (seq, message) in messages.iter().enumerate().skip(keep) {
            let json = serde_json::to_string(message).map_err(storage_error)?;
            tx.execute(
                "INSERT INTO agent_messages (session_id, seq, message_json) VALUES (?1, ?2, ?3)",
                params![id, seq as i64, json],
            )
            .map_err(storage_error)?;
        }
        tx.execute("UPDATE agent_run_state SET snapshot_sequence=COALESCE((SELECT MAX(sequence) FROM agent_events WHERE session_id=?1),0) WHERE session_id=?1", [id]).map_err(storage_error)?;
        tx.commit().map_err(storage_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omnia_harness::{Block, Role};

    fn summary(id: &str, updated: i64) -> AgentSessionSummary {
        AgentSessionSummary {
            id: id.to_owned(),
            title: "t".to_owned(),
            scope: SessionScope::Project,
            cwd: "C:/work".to_owned(),
            profile_id: "p".to_owned(),
            model: "m".to_owned(),
            permission_mode: PermissionMode::AskWrites,
            rules: Vec::new(),
            reasoning_effort: None,
            fallback_models: Vec::new(),
            token_budget: None,
            tokens_used: 0,
            system_prompt: None,
            parent_id: None,
            settings_revision: 1,
            message_count: 0,
            created_at_ms: 1,
            updated_at_ms: updated,
        }
    }

    fn text(role: Role, text: &str) -> Message {
        Message {
            role,
            content: vec![Block::text(text)],
        }
    }

    #[test]
    fn metadata_updates_and_transcript_do_not_resurrect_deleted_sessions() {
        let store = HarnessStore::in_memory().unwrap();
        let old = summary("a", 1);
        store.save_summary(&old).unwrap();
        store
            .update_summary("a", |s| {
                s.title = "renamed".into();
                s.model = "new-model".into();
            })
            .unwrap();
        store.begin_run("a").unwrap();
        store
            .write_messages("a", &[text(Role::User, "hello")], 0)
            .unwrap();
        let current = store.summary("a").unwrap();
        assert_eq!(current.title, "renamed");
        assert_eq!(current.model, "new-model");
        assert_eq!(current.message_count, 1);
        store.delete("a").unwrap();
        assert!(store.save_summary(&old).is_err());
        assert!(store.update_summary("a", |_| {}).is_err());
        assert!(store.write_messages("a", &[], 0).is_err());
        assert!(store.begin_run("a").is_err());
        assert!(store
            .append_event("a", &serde_json::json!({"type":"run_finished"}))
            .is_err());
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn settings_updates_use_a_monotonic_compare_and_swap_revision() {
        let store = HarnessStore::in_memory().unwrap();
        store.save_summary(&summary("settings", 1)).unwrap();

        let first = store
            .update_summary_cas("settings", Some(1), |session| {
                session.model = "new-model".into();
                session.updated_at_ms = 2;
            })
            .unwrap();
        assert_eq!(first.settings_revision, 2);
        assert_eq!(first.model, "new-model");

        let stale = store
            .update_summary_cas("settings", Some(1), |session| {
                session.title = "must-not-commit".into();
            })
            .expect_err("a stale settings editor must receive a typed conflict");
        assert_eq!(stale.code, "agent_session_revision_conflict");
        assert!(stale.retryable);
        let current = store.summary("settings").unwrap();
        assert_eq!(current.settings_revision, 2);
        assert_eq!(current.title, "t");

        let legacy = store
            .update_summary_cas("settings", None, |session| {
                session.title = "legacy-compatible".into();
                session.updated_at_ms = 3;
            })
            .unwrap();
        assert_eq!(legacy.settings_revision, 3);
        assert_eq!(legacy.title, "legacy-compatible");
    }

    #[test]
    fn settings_cas_rejects_zero_expected_revision_without_mutation() {
        let store = HarnessStore::in_memory().unwrap();
        store.save_summary(&summary("settings-zero", 1)).unwrap();
        let error = store
            .update_summary_cas("settings-zero", Some(0), |_| {})
            .expect_err("zero is not a valid CAS revision");
        assert_eq!(error.code, "invalid_input");
        assert_eq!(store.summary("settings-zero").unwrap().settings_revision, 1);
    }

    #[test]
    fn settings_revision_survives_transcript_usage_and_storage_reopen() {
        let root =
            std::env::temp_dir().join(format!("omnia-settings-cas-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("harness.sqlite3");
        {
            let store = HarnessStore::open(&path).unwrap();
            store.save_summary(&summary("settings-durable", 1)).unwrap();
            store
                .update_summary_cas("settings-durable", Some(1), |session| {
                    session.model = "persistent-model".into();
                })
                .unwrap();
            store
                .write_messages("settings-durable", &[text(Role::User, "hello")], 0)
                .unwrap();
            store
                .update_summary("settings-durable", |session| session.tokens_used = 123)
                .unwrap();
            assert_eq!(
                store.summary("settings-durable").unwrap().settings_revision,
                2
            );
        }
        {
            let store = HarnessStore::open(&path).unwrap();
            let current = store.summary("settings-durable").unwrap();
            assert_eq!(current.settings_revision, 2);
            assert_eq!(current.model, "persistent-model");
            assert_eq!(current.tokens_used, 123);
            assert_eq!(current.message_count, 1);
            let updated = store
                .update_summary_cas("settings-durable", Some(2), |session| {
                    session.token_budget = Some(1000);
                })
                .unwrap();
            assert_eq!(updated.settings_revision, 3);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn older_session_documents_start_with_settings_revision_one() {
        let mut legacy = serde_json::to_value(summary("legacy", 1)).unwrap();
        legacy.as_object_mut().unwrap().remove("settingsRevision");
        let migrated: AgentSessionSummary = serde_json::from_value(legacy).unwrap();
        assert_eq!(migrated.settings_revision, 1);
    }

    #[test]
    fn explicit_projectless_scope_survives_messages_settings_and_store_reopen() {
        let root = std::env::temp_dir().join(format!(
            "omnia-projectless-scope-store-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("harness.sqlite3");
        {
            let store = HarnessStore::open(&path).unwrap();
            let mut session = summary("projectless", 1);
            session.scope = SessionScope::Projectless;
            session.cwd = root.join("scratch").to_string_lossy().into_owned();
            store.save_summary(&session).unwrap();
            store
                .write_messages("projectless", &[text(Role::User, "research")], 0)
                .unwrap();
            store
                .update_summary_cas("projectless", Some(1), |session| {
                    session.model = "different-model".into()
                })
                .unwrap();
        }
        let store = HarnessStore::open(&path).unwrap();
        let session = store.summary("projectless").unwrap();
        assert_eq!(session.scope, SessionScope::Projectless);
        assert_eq!(session.message_count, 1);
        assert_eq!(session.model, "different-model");
        assert_eq!(store.list().unwrap()[0].scope, SessionScope::Projectless);
        assert_eq!(
            store.export_bundles().unwrap()[0].summary.scope,
            SessionScope::Projectless
        );
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_scope_defaults_to_project_and_unknown_scope_is_rejected() {
        let mut legacy = serde_json::to_value(summary("legacy-scope", 1)).unwrap();
        legacy.as_object_mut().unwrap().remove("scope");
        let migrated: AgentSessionSummary = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(migrated.scope, SessionScope::Project);
        legacy["scope"] = serde_json::json!("unexpected-scope");
        assert!(serde_json::from_value::<AgentSessionSummary>(legacy).is_err());
    }

    #[test]
    fn snapshot_replay_preserves_pending_approvals_and_unknown_effects() {
        let store = HarnessStore::in_memory().unwrap();
        store.save_summary(&summary("a", 1)).unwrap();
        store.begin_run("a").unwrap();
        store
            .write_messages("a", &[text(Role::User, "hello")], 0)
            .unwrap();
        let sequence = store
            .append_event(
                "a",
                &serde_json::json!({"type":"approval_requested", "request":{"tool_use_id":"t"}}),
            )
            .unwrap();
        let (_, messages, replay) = store.read_snapshot("a").unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(replay.events.len(), 1);
        assert_eq!(replay.events[0].sequence, sequence);
        assert_eq!(replay.pending_approvals.len(), 1);
        store
            .append_event(
                "a",
                &serde_json::json!({"type":"approval_decided", "id":"t"}),
            )
            .unwrap();
        store
            .append_event("a", &serde_json::json!({"type":"tool_started", "id":"t"}))
            .unwrap();
        store.write_messages("a", &messages, 0).unwrap();
        let replay = store.replay("a").unwrap();
        assert!(replay.events.is_empty());
        assert!(replay.pending_approvals.is_empty());
        assert_eq!(replay.unknown_side_effects, ["t"]);
        let serialized = serde_json::to_value(&replay).unwrap();
        assert!(serialized.get("replayEvents").is_some());
        assert_eq!(serialized["runStatus"], "running");
        store
            .append_event("a", &serde_json::json!({"type":"tool_completed", "id":"t"}))
            .unwrap();
        assert!(store.replay("a").unwrap().unknown_side_effects.is_empty());
    }

    #[test]
    fn reopening_marks_run_interrupted_and_preserves_event_journal() {
        let dir = std::env::temp_dir().join(format!("omnia-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("harness.sqlite3");
        {
            let store = HarnessStore::open(&path).unwrap();
            store.save_summary(&summary("a", 1)).unwrap();
            store.begin_run("a").unwrap();
            store.append_event("a", &serde_json::json!({"type":"approval_requested", "request":{"tool_use_id":"a"}})).unwrap();
            store
                .append_event("a", &serde_json::json!({"type":"tool_started", "id":"t"}))
                .unwrap();
        }
        {
            let store = HarnessStore::open(&path).unwrap();
            let replay = store.replay("a").unwrap();
            assert_eq!(replay.status, "interrupted");
            assert!(replay.pending_approvals.is_empty());
            assert_eq!(replay.unknown_side_effects, ["t"]);
            assert_eq!(replay.events.len(), 2);
            assert!(replay.event_cursor > 0);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sessions_and_messages_round_trip() {
        let store = HarnessStore::in_memory().unwrap();
        store.save_summary(&summary("a", 5)).unwrap();
        store.save_summary(&summary("b", 9)).unwrap();
        assert_eq!(
            store
                .list()
                .unwrap()
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["b", "a"]
        );

        let mut history = vec![text(Role::User, "hi"), text(Role::Assistant, "hello")];
        store.write_messages("a", &history, 0).unwrap();
        history.push(text(Role::User, "more"));
        store.write_messages("a", &history, 2).unwrap();
        assert_eq!(store.messages("a").unwrap(), history);

        // Rewind: truncate to the first message.
        store.write_messages("a", &history[..1], 0).unwrap();
        assert_eq!(store.messages("a").unwrap().len(), 1);

        store.delete("a").unwrap();
        assert!(store.summary("a").is_err());
        assert!(store.messages("a").unwrap().is_empty());
    }
}
