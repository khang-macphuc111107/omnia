use std::fs;
use std::path::Path;
use std::sync::Mutex;

use omnia_core::{compact_json, sha256_hex, try_parse_json, uuid_v4, SecretRedactor};
use omnia_winsqlite::{Connection, StepStatus};

use crate::error::StoreError;

const SESSION_STORE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS store_leases (
    lease_name TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    acquired_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model_id TEXT NOT NULL,
    effort TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated_id
    ON sessions (updated_at_ms DESC, id DESC);

CREATE TABLE IF NOT EXISTS session_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE(session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_session_messages_session_seq
    ON session_messages (session_id, seq ASC);

CREATE TABLE IF NOT EXISTS attachment_blobs (
    sha256 TEXT PRIMARY KEY,
    byte_len INTEGER NOT NULL,
    content BLOB NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_attachments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    placement TEXT NOT NULL CHECK(placement IN ('inline', 'tray')),
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    sha256 TEXT NOT NULL REFERENCES attachment_blobs(sha256) ON DELETE RESTRICT,
    byte_len INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_attachments_session
    ON session_attachments (session_id, created_at_ms ASC);

CREATE TABLE IF NOT EXISTS run_journal (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_journal_session_seq
    ON run_journal (session_id, seq ASC);
"#;

const PRIMARY_LEASE_NAME: &str = "studio_primary";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseRecord {
    pub lease_name: String,
    pub owner_id: String,
    pub pid: i64,
    pub acquired_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRecord {
    pub id: String,
    pub title: String,
    pub model_id: String,
    pub effort: String,
    pub revision: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMessageRecord {
    pub id: String,
    pub session_id: String,
    pub seq: i64,
    pub role: String,
    pub content: String,
    pub metadata_json: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCursor {
    pub updated_at_ms: i64,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionPage {
    pub items: Vec<SessionRecord>,
    pub has_more: bool,
    pub next_cursor: Option<SessionCursor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentPlacement {
    Inline,
    Tray,
}

impl AttachmentPlacement {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Inline => "inline",
            Self::Tray => "tray",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "inline" => Ok(Self::Inline),
            "tray" => Ok(Self::Tray),
            _ => Err(StoreError::invalid_input(format!(
                "Invalid attachment placement '{raw}'; expected 'inline' or 'tray'."
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAttachment {
    pub id: String,
    pub session_id: String,
    pub message_id: String,
    pub placement: AttachmentPlacement,
    pub filename: String,
    pub mime_type: String,
    pub sha256: String,
    pub byte_len: i64,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunJournalEntry {
    pub seq: i64,
    pub session_id: String,
    pub run_id: String,
    pub event_type: String,
    pub payload_json: String,
    pub created_at_ms: i64,
}

/// Cooperative multi-session SQLite store backing `omnia-studio.exe`.
#[derive(Debug)]
pub struct SessionStore {
    conn: Mutex<Connection>,
}

impl SessionStore {
    /// Open (or create) a `SessionStore` at `db_path`, configure WAL/NORMAL/FK pragmas,
    /// and apply idempotent schema DDL.
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = db_path.as_ref();
        if path.as_os_str().is_empty() {
            return Err(StoreError::invalid_input(
                "Session store path cannot be empty.",
            ));
        }
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|err| {
                    StoreError::storage_failed(format!(
                        "Failed to create session store directory {}: {err}",
                        parent.display()
                    ))
                })?;
            }
        }
        let conn = Connection::open_read_write(path)?;
        conn.exec_batch(SESSION_STORE_SCHEMA_SQL)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Open an isolated in-memory `SessionStore` for unit testing.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        conn.exec_batch(SESSION_STORE_SCHEMA_SQL)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Return the active SQLite journal mode string (`wal` for file stores).
    pub fn journal_mode(&self) -> Result<String, StoreError> {
        let conn = self.lock_conn()?;
        Ok(conn
            .query_scalar_text("PRAGMA journal_mode;")?
            .unwrap_or_default()
            .to_ascii_lowercase())
    }

    /// Attempt to acquire the cooperative primary lease; returns `Ok(true)` if granted
    /// (including re-entrant or expired lease takeover) or `Ok(false)` if actively held by another owner.
    pub fn acquire_lease(
        &self,
        owner_id: &str,
        pid: i64,
        ttl_ms: i64,
        now_ms: i64,
    ) -> Result<bool, StoreError> {
        if owner_id.trim().is_empty() {
            return Err(StoreError::invalid_input("Lease owner_id cannot be empty."));
        }
        if ttl_ms <= 0 {
            return Err(StoreError::invalid_input("Lease ttl_ms must be positive."));
        }
        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;

        let current = read_lease_locked(&tx)?;
        if let Some(existing) = current {
            if existing.owner_id != owner_id && existing.expires_at_ms > now_ms {
                tx.commit()?;
                return Ok(false);
            }
        }

        let expires_at = now_ms.saturating_add(ttl_ms);
        let mut stmt = tx.prepare(
            "INSERT INTO store_leases (lease_name, owner_id, pid, acquired_at_ms, expires_at_ms)\n\
             VALUES (?1, ?2, ?3, ?4, ?5)\n\
             ON CONFLICT(lease_name) DO UPDATE SET\n\
                 owner_id = excluded.owner_id,\n\
                 pid = excluded.pid,\n\
                 acquired_at_ms = CASE WHEN store_leases.owner_id = excluded.owner_id\n\
                                       THEN store_leases.acquired_at_ms\n\
                                       ELSE excluded.acquired_at_ms END,\n\
                 expires_at_ms = excluded.expires_at_ms;",
        )?;
        stmt.bind_text(1, PRIMARY_LEASE_NAME)?;
        stmt.bind_text(2, owner_id)?;
        stmt.bind_int64(3, pid)?;
        stmt.bind_int64(4, now_ms)?;
        stmt.bind_int64(5, expires_at)?;
        stmt.step()?;
        drop(stmt);

        tx.commit()?;
        Ok(true)
    }

    /// Extend the active lease TTL if `owner_id` currently owns an unexpired (or matching) lease.
    pub fn heartbeat(&self, owner_id: &str, ttl_ms: i64, now_ms: i64) -> Result<bool, StoreError> {
        if owner_id.trim().is_empty() || ttl_ms <= 0 {
            return Err(StoreError::invalid_input(
                "Lease owner_id must be non-empty and ttl_ms positive.",
            ));
        }
        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;
        let mut stmt = tx.prepare(
            "UPDATE store_leases\n\
             SET expires_at_ms = ?1\n\
             WHERE lease_name = ?2 AND owner_id = ?3 AND expires_at_ms >= ?4;",
        )?;
        stmt.bind_int64(1, now_ms.saturating_add(ttl_ms))?;
        stmt.bind_text(2, PRIMARY_LEASE_NAME)?;
        stmt.bind_text(3, owner_id)?;
        stmt.bind_int64(4, now_ms)?;
        stmt.step()?;
        drop(stmt);
        let updated = tx.changes() > 0;
        tx.commit()?;
        Ok(updated)
    }

    /// Release the primary lease if owned by `owner_id`.
    pub fn release_lease(&self, owner_id: &str) -> Result<bool, StoreError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;
        let mut stmt =
            tx.prepare("DELETE FROM store_leases WHERE lease_name = ?1 AND owner_id = ?2;")?;
        stmt.bind_text(1, PRIMARY_LEASE_NAME)?;
        stmt.bind_text(2, owner_id)?;
        stmt.step()?;
        drop(stmt);
        let released = tx.changes() > 0;
        tx.commit()?;
        Ok(released)
    }

    /// Return the currently unexpired lease if one exists at `now_ms`.
    pub fn active_lease(&self, now_ms: i64) -> Result<Option<LeaseRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let Some(rec) = read_lease_locked(&conn)? else {
            return Ok(None);
        };
        if rec.expires_at_ms <= now_ms {
            return Ok(None);
        }
        Ok(Some(rec))
    }

    /// Create a new Studio session row, optionally using a caller-supplied `custom_id`.
    pub fn create_session(
        &self,
        title: &str,
        model_id: &str,
        effort: &str,
        now_ms: i64,
        custom_id: Option<&str>,
    ) -> Result<SessionRecord, StoreError> {
        if title.trim().is_empty() {
            return Err(StoreError::invalid_input("Session title cannot be empty."));
        }
        if model_id.trim().is_empty() {
            return Err(StoreError::invalid_input(
                "Session model_id cannot be empty.",
            ));
        }
        let id = match custom_id {
            Some(s) if !s.trim().is_empty() => s.trim().to_owned(),
            _ => uuid_v4(),
        };
        let norm_title = title.trim().to_owned();
        let norm_model = model_id.trim().to_owned();
        let norm_effort = if effort.trim().is_empty() {
            "medium".to_owned()
        } else {
            effort.trim().to_owned()
        };

        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;
        let mut stmt = tx.prepare(
            "INSERT INTO sessions (id, title, model_id, effort, revision, created_at_ms, updated_at_ms)\n\
             VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6);",
        )?;
        stmt.bind_text(1, &id)?;
        stmt.bind_text(2, &norm_title)?;
        stmt.bind_text(3, &norm_model)?;
        stmt.bind_text(4, &norm_effort)?;
        stmt.bind_int64(5, now_ms)?;
        stmt.bind_int64(6, now_ms)?;
        stmt.step()?;
        drop(stmt);
        tx.commit()?;

        Ok(SessionRecord {
            id,
            title: norm_title,
            model_id: norm_model,
            effort: norm_effort,
            revision: 1,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        })
    }

    /// Upsert a Studio session cleanly while preserving or bumping its revision.
    pub fn upsert_session(
        &self,
        id: &str,
        title: &str,
        model_id: &str,
        effort: &str,
        now_ms: i64,
    ) -> Result<SessionRecord, StoreError> {
        if id.trim().is_empty() {
            return Err(StoreError::invalid_input("Session id cannot be empty."));
        }
        if title.trim().is_empty() || model_id.trim().is_empty() {
            return Err(StoreError::invalid_input(
                "Session title and model_id cannot be empty.",
            ));
        }
        let norm_id = id.trim();
        let norm_title = title.trim();
        let norm_model = model_id.trim();
        let norm_effort = if effort.trim().is_empty() {
            "medium"
        } else {
            effort.trim()
        };

        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;
        let mut stmt = tx.prepare(
            "INSERT INTO sessions (id, title, model_id, effort, revision, created_at_ms, updated_at_ms)\n\
             VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)\n\
             ON CONFLICT(id) DO UPDATE SET\n\
                 title = excluded.title,\n\
                 model_id = excluded.model_id,\n\
                 effort = excluded.effort,\n\
                 revision = sessions.revision + 1,\n\
                 updated_at_ms = CASE WHEN excluded.updated_at_ms > sessions.updated_at_ms\n\
                                      THEN excluded.updated_at_ms ELSE sessions.updated_at_ms END;",
        )?;
        stmt.bind_text(1, norm_id)?;
        stmt.bind_text(2, norm_title)?;
        stmt.bind_text(3, norm_model)?;
        stmt.bind_text(4, norm_effort)?;
        stmt.bind_int64(5, now_ms)?;
        stmt.step()?;
        drop(stmt);

        let record = read_session_locked(&tx, norm_id)?.ok_or_else(|| {
            StoreError::storage_failed(format!("Upserted session {norm_id} disappeared."))
        })?;
        tx.commit()?;
        Ok(record)
    }

    /// Update a session's title, model, and effort with optional CAS `expected_revision`.
    pub fn update_session_settings(
        &self,
        session_id: &str,
        title: &str,
        model_id: &str,
        effort: &str,
        now_ms: i64,
        expected_revision: Option<i64>,
    ) -> Result<SessionRecord, StoreError> {
        if session_id.trim().is_empty() {
            return Err(StoreError::invalid_input("session_id cannot be empty."));
        }
        if title.trim().is_empty() || model_id.trim().is_empty() {
            return Err(StoreError::invalid_input(
                "Session title and model_id cannot be empty.",
            ));
        }

        let norm_title = title.trim();
        let norm_model = model_id.trim();
        let norm_effort = if effort.trim().is_empty() {
            "medium"
        } else {
            effort.trim()
        };

        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;

        let existing = read_session_locked(&tx, session_id)?.ok_or_else(|| {
            StoreError::not_found(
                "session_not_found",
                format!("Session not found: {session_id}"),
            )
        })?;

        if let Some(expected) = expected_revision {
            if existing.revision != expected {
                return Err(StoreError::conflict(
                    "session_revision_conflict",
                    format!(
                        "Session revision conflict for {session_id}: expected {expected}, actual {}",
                        existing.revision
                    ),
                ));
            }
        }

        let effective_updated = now_ms.max(existing.updated_at_ms);
        let mut stmt = tx.prepare(
            "UPDATE sessions\n\
             SET title = ?1, model_id = ?2, effort = ?3, revision = revision + 1, updated_at_ms = ?4\n\
             WHERE id = ?5;",
        )?;
        stmt.bind_text(1, norm_title)?;
        stmt.bind_text(2, norm_model)?;
        stmt.bind_text(3, norm_effort)?;
        stmt.bind_int64(4, effective_updated)?;
        stmt.bind_text(5, session_id)?;
        stmt.step()?;
        drop(stmt);

        let updated = read_session_locked(&tx, session_id)?.ok_or_else(|| {
            StoreError::storage_failed(format!("Updated session {session_id} disappeared."))
        })?;
        tx.commit()?;
        Ok(updated)
    }

    /// Fetch a single session by ID, or `Ok(None)` when absent.
    pub fn get_session(&self, session_id: &str) -> Result<Option<SessionRecord>, StoreError> {
        let conn = self.lock_conn()?;
        read_session_locked(&conn, session_id)
    }

    /// Delete a session and its dependent messages, attachments (cascade), and journal entries.
    pub fn delete_session(&self, session_id: &str) -> Result<bool, StoreError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;

        let mut del_journal = tx.prepare("DELETE FROM run_journal WHERE session_id = ?1;")?;
        del_journal.bind_text(1, session_id)?;
        del_journal.step()?;
        drop(del_journal);

        let mut del_sess = tx.prepare("DELETE FROM sessions WHERE id = ?1;")?;
        del_sess.bind_text(1, session_id)?;
        del_sess.step()?;
        drop(del_sess);
        let deleted = tx.changes() > 0;

        tx.commit()?;
        Ok(deleted)
    }

    /// Keyset-paginated listing ordered by `(updated_at_ms DESC, id DESC)`.
    /// Limit is clamped into `1..=250`.
    pub fn list_sessions_page(
        &self,
        limit: usize,
        cursor: Option<&SessionCursor>,
    ) -> Result<SessionPage, StoreError> {
        let bounded = limit.clamp(1, 250);
        let probe = i64::try_from(bounded + 1).unwrap_or(251);
        let conn = self.lock_conn()?;

        let mut stmt = if cursor.is_some() {
            conn.prepare(
                "SELECT id, title, model_id, effort, revision, created_at_ms, updated_at_ms\n\
                 FROM sessions\n\
                 WHERE (updated_at_ms < ?1) OR (updated_at_ms = ?1 AND id < ?2)\n\
                 ORDER BY updated_at_ms DESC, id DESC\n\
                 LIMIT ?3;",
            )?
        } else {
            conn.prepare(
                "SELECT id, title, model_id, effort, revision, created_at_ms, updated_at_ms\n\
                 FROM sessions\n\
                 ORDER BY updated_at_ms DESC, id DESC\n\
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

        let mut items = Vec::with_capacity(bounded);
        let mut has_more = false;
        while stmt.step()? == StepStatus::Row {
            let rec = SessionRecord {
                id: stmt.column_text(0)?,
                title: stmt.column_text(1)?,
                model_id: stmt.column_text(2)?,
                effort: stmt.column_text(3)?,
                revision: stmt.column_int64(4)?,
                created_at_ms: stmt.column_int64(5)?,
                updated_at_ms: stmt.column_int64(6)?,
            };
            if items.len() == bounded {
                has_more = true;
                break;
            }
            items.push(rec);
        }

        let next_cursor = if has_more {
            items.last().map(|last| SessionCursor {
                updated_at_ms: last.updated_at_ms,
                id: last.id.clone(),
            })
        } else {
            None
        };

        Ok(SessionPage {
            items,
            has_more,
            next_cursor,
        })
    }

    /// Append a persistent message to `session_messages`, auto-assigning monotonic `seq`
    /// and advancing the session's `updated_at_ms`.
    pub fn append_message(
        &self,
        session_id: &str,
        role: &str,
        content: &str,
        metadata_json: &str,
        now_ms: i64,
    ) -> Result<SessionMessageRecord, StoreError> {
        if session_id.trim().is_empty() || role.trim().is_empty() {
            return Err(StoreError::invalid_input(
                "session_id and role cannot be empty.",
            ));
        }
        let redacted_meta = redact_json_or_text(if metadata_json.trim().is_empty() {
            "{}"
        } else {
            metadata_json
        });
        let id = uuid_v4();

        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;
        let Some(existing) = read_session_locked(&tx, session_id)? else {
            return Err(StoreError::not_found(
                "session_not_found",
                format!("Session not found: {session_id}"),
            ));
        };

        let mut seq_stmt = tx.prepare(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM session_messages WHERE session_id = ?1;",
        )?;
        seq_stmt.bind_text(1, session_id)?;
        let next_seq = match seq_stmt.step()? {
            StepStatus::Row => seq_stmt.column_int64(0)?,
            StepStatus::Done => 1,
        };
        drop(seq_stmt);

        let mut ins = tx.prepare(
            "INSERT INTO session_messages (id, session_id, seq, role, content, metadata_json, created_at_ms)\n\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);",
        )?;
        ins.bind_text(1, &id)?;
        ins.bind_text(2, session_id)?;
        ins.bind_int64(3, next_seq)?;
        ins.bind_text(4, role.trim())?;
        ins.bind_text(5, content)?;
        ins.bind_text(6, &redacted_meta)?;
        ins.bind_int64(7, now_ms)?;
        ins.step()?;
        drop(ins);

        let mut upd = tx.prepare("UPDATE sessions SET updated_at_ms = ?1 WHERE id = ?2;")?;
        upd.bind_int64(1, now_ms.max(existing.updated_at_ms))?;
        upd.bind_text(2, session_id)?;
        upd.step()?;
        drop(upd);

        tx.commit()?;
        Ok(SessionMessageRecord {
            id,
            session_id: session_id.to_owned(),
            seq: next_seq,
            role: role.trim().to_owned(),
            content: content.to_owned(),
            metadata_json: redacted_meta,
            created_at_ms: now_ms,
        })
    }

    /// List messages for `session_id` in ascending sequence order.
    pub fn list_messages(
        &self,
        session_id: &str,
        since_seq: i64,
    ) -> Result<Vec<SessionMessageRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, seq, role, content, metadata_json, created_at_ms\n\
             FROM session_messages\n\
             WHERE session_id = ?1 AND seq > ?2\n\
             ORDER BY seq ASC;",
        )?;
        stmt.bind_text(1, session_id)?;
        stmt.bind_int64(2, since_seq)?;
        let mut out = Vec::new();
        while stmt.step()? == StepStatus::Row {
            out.push(SessionMessageRecord {
                id: stmt.column_text(0)?,
                session_id: stmt.column_text(1)?,
                seq: stmt.column_int64(2)?,
                role: stmt.column_text(3)?,
                content: stmt.column_text(4)?,
                metadata_json: stmt.column_text(5)?,
                created_at_ms: stmt.column_int64(6)?,
            });
        }
        Ok(out)
    }

    /// Store a SHA-256 content-addressed attachment blob (`inline` or `tray`) linked to a session.
    #[allow(clippy::too_many_arguments)]
    pub fn store_attachment(
        &self,
        session_id: &str,
        message_id: &str,
        placement: AttachmentPlacement,
        filename: &str,
        mime_type: &str,
        bytes: &[u8],
        now_ms: i64,
    ) -> Result<StoredAttachment, StoreError> {
        if session_id.trim().is_empty() || filename.trim().is_empty() {
            return Err(StoreError::invalid_input(
                "Attachment session_id and filename cannot be empty.",
            ));
        }
        let digest = sha256_hex(bytes);
        let byte_len = i64::try_from(bytes.len())
            .map_err(|_| StoreError::invalid_input("Attachment exceeds i64 byte length."))?;
        let att_id = uuid_v4();

        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;

        let mut blob_stmt = tx.prepare(
            "INSERT OR IGNORE INTO attachment_blobs (sha256, byte_len, content, created_at_ms)\n\
             VALUES (?1, ?2, ?3, ?4);",
        )?;
        blob_stmt.bind_text(1, &digest)?;
        blob_stmt.bind_int64(2, byte_len)?;
        blob_stmt.bind_blob(3, bytes)?;
        blob_stmt.bind_int64(4, now_ms)?;
        blob_stmt.step()?;
        drop(blob_stmt);

        let mut att_stmt = tx.prepare(
            "INSERT INTO session_attachments\n\
             (id, session_id, message_id, placement, filename, mime_type, sha256, byte_len, created_at_ms)\n\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);",
        )?;
        att_stmt.bind_text(1, &att_id)?;
        att_stmt.bind_text(2, session_id)?;
        att_stmt.bind_text(3, message_id)?;
        att_stmt.bind_text(4, placement.as_str())?;
        att_stmt.bind_text(5, filename)?;
        att_stmt.bind_text(6, mime_type)?;
        att_stmt.bind_text(7, &digest)?;
        att_stmt.bind_int64(8, byte_len)?;
        att_stmt.bind_int64(9, now_ms)?;
        att_stmt.step()?;
        drop(att_stmt);

        tx.commit()?;
        Ok(StoredAttachment {
            id: att_id,
            session_id: session_id.to_owned(),
            message_id: message_id.to_owned(),
            placement,
            filename: filename.to_owned(),
            mime_type: mime_type.to_owned(),
            sha256: digest,
            byte_len,
            created_at_ms: now_ms,
        })
    }

    /// Return the number of unique deduplicated SHA-256 blobs in `attachment_blobs`.
    pub fn unique_blob_count(&self) -> Result<i64, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare("SELECT COUNT(*) FROM attachment_blobs;")?;
        match stmt.step()? {
            StepStatus::Row => Ok(stmt.column_int64(0)?),
            StepStatus::Done => Ok(0),
        }
    }

    /// List attachments associated with `session_id` in chronological order.
    pub fn list_session_attachments(
        &self,
        session_id: &str,
    ) -> Result<Vec<StoredAttachment>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, message_id, placement, filename, mime_type, sha256, byte_len, created_at_ms\n\
             FROM session_attachments\n\
             WHERE session_id = ?1\n\
             ORDER BY created_at_ms ASC, id ASC;",
        )?;
        stmt.bind_text(1, session_id)?;

        let mut out = Vec::new();
        while stmt.step()? == StepStatus::Row {
            let placement = AttachmentPlacement::parse(&stmt.column_text(3)?)?;
            out.push(StoredAttachment {
                id: stmt.column_text(0)?,
                session_id: stmt.column_text(1)?,
                message_id: stmt.column_text(2)?,
                placement,
                filename: stmt.column_text(4)?,
                mime_type: stmt.column_text(5)?,
                sha256: stmt.column_text(6)?,
                byte_len: stmt.column_int64(7)?,
                created_at_ms: stmt.column_int64(8)?,
            });
        }
        Ok(out)
    }

    /// Read raw bytes for a SHA-256 attachment digest.
    pub fn read_blob(&self, sha256: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare("SELECT content FROM attachment_blobs WHERE sha256 = ?1;")?;
        stmt.bind_text(1, sha256)?;
        match stmt.step()? {
            StepStatus::Row => Ok(Some(stmt.column_blob(0)?)),
            StepStatus::Done => Ok(None),
        }
    }

    /// Append a secret-redacted entry into `run_journal`.
    pub fn append_run_journal(
        &self,
        session_id: &str,
        run_id: &str,
        event_type: &str,
        payload_json: &str,
        now_ms: i64,
    ) -> Result<i64, StoreError> {
        if session_id.trim().is_empty() || run_id.trim().is_empty() || event_type.trim().is_empty()
        {
            return Err(StoreError::invalid_input(
                "run_journal session_id, run_id, and event_type cannot be empty.",
            ));
        }
        let redacted = redact_json_or_text(payload_json);

        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;
        let mut stmt = tx.prepare(
            "INSERT INTO run_journal (session_id, run_id, event_type, payload_json, created_at_ms)\n\
             VALUES (?1, ?2, ?3, ?4, ?5);",
        )?;
        stmt.bind_text(1, session_id)?;
        stmt.bind_text(2, run_id)?;
        stmt.bind_text(3, event_type)?;
        stmt.bind_text(4, &redacted)?;
        stmt.bind_int64(5, now_ms)?;
        stmt.step()?;
        drop(stmt);
        let seq = tx.last_insert_rowid();
        tx.commit()?;
        Ok(seq)
    }

    /// Read journal entries for `session_id` strictly after `since_seq`.
    pub fn list_run_journal(
        &self,
        session_id: &str,
        since_seq: i64,
    ) -> Result<Vec<RunJournalEntry>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT seq, session_id, run_id, event_type, payload_json, created_at_ms\n\
             FROM run_journal\n\
             WHERE session_id = ?1 AND seq > ?2\n\
             ORDER BY seq ASC;",
        )?;
        stmt.bind_text(1, session_id)?;
        stmt.bind_int64(2, since_seq)?;
        let mut out = Vec::new();
        while stmt.step()? == StepStatus::Row {
            out.push(RunJournalEntry {
                seq: stmt.column_int64(0)?,
                session_id: stmt.column_text(1)?,
                run_id: stmt.column_text(2)?,
                event_type: stmt.column_text(3)?,
                payload_json: stmt.column_text(4)?,
                created_at_ms: stmt.column_int64(5)?,
            });
        }
        Ok(out)
    }

    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, StoreError> {
        self.conn
            .lock()
            .map_err(|_| StoreError::storage_failed("SessionStore mutex poisoned."))
    }
}

fn redact_json_or_text(raw: &str) -> String {
    if let Some(val) = try_parse_json(raw) {
        let redacted = SecretRedactor::redact_json(&val);
        if let Ok(compact) = compact_json(&redacted) {
            return compact;
        }
    }
    SecretRedactor::redact(raw)
}

fn read_lease_locked(conn: &Connection) -> Result<Option<LeaseRecord>, StoreError> {
    let mut stmt = conn.prepare(
        "SELECT lease_name, owner_id, pid, acquired_at_ms, expires_at_ms\n\
         FROM store_leases WHERE lease_name = ?1;",
    )?;
    stmt.bind_text(1, PRIMARY_LEASE_NAME)?;
    match stmt.step()? {
        StepStatus::Row => Ok(Some(LeaseRecord {
            lease_name: stmt.column_text(0)?,
            owner_id: stmt.column_text(1)?,
            pid: stmt.column_int64(2)?,
            acquired_at_ms: stmt.column_int64(3)?,
            expires_at_ms: stmt.column_int64(4)?,
        })),
        StepStatus::Done => Ok(None),
    }
}

fn read_session_locked(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<SessionRecord>, StoreError> {
    let mut stmt = conn.prepare(
        "SELECT id, title, model_id, effort, revision, created_at_ms, updated_at_ms\n\
         FROM sessions WHERE id = ?1;",
    )?;
    stmt.bind_text(1, session_id)?;
    match stmt.step()? {
        StepStatus::Row => Ok(Some(SessionRecord {
            id: stmt.column_text(0)?,
            title: stmt.column_text(1)?,
            model_id: stmt.column_text(2)?,
            effort: stmt.column_text(3)?,
            revision: stmt.column_int64(4)?,
            created_at_ms: stmt.column_int64(5)?,
            updated_at_ms: stmt.column_int64(6)?,
        })),
        StepStatus::Done => Ok(None),
    }
}
