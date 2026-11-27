use std::fs;
use std::path::Path;
use std::sync::Mutex;

use omnia_core::{
    compact_json, hex_decode, hex_encode, sha256_hex, try_parse_json, uuid_v4, SecretRedactor,
};
use omnia_winsqlite::{Connection, StepStatus};

use crate::error::StoreError;

const SESSION_STORE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS store_leases (
    lease_name TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    acquired_at_ms INTEGER NOT NULL,
    heartbeat_at_ms INTEGER NOT NULL DEFAULT 0,
    expires_at_ms INTEGER NOT NULL,
    lease_epoch INTEGER NOT NULL DEFAULT 1
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
    pub heartbeat_at_ms: i64,
    pub expires_at_ms: i64,
    pub lease_epoch: i64,
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

/// Validate a Studio session identifier (`AUD-32`): 1..=128 UTF-8 bytes, no `..`,
/// no URI/path delimiters (`/`, `\`, `?`, `#`), and no ASCII control bytes (`< 0x20` or `0x7f`).
#[must_use]
pub fn is_valid_studio_session_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 || id.contains("..") {
        return false;
    }
    !id.bytes()
        .any(|b| matches!(b, b'/' | b'\\' | b'?' | b'#') || b < 0x20 || b == 0x7f)
}

impl SessionCursor {
    /// Encode cursor into PR #1 opaque hex token format `<hex(updated_at_ms)>.<hex(id)>`.
    #[must_use]
    pub fn encode(&self) -> String {
        let ts = self.updated_at_ms.to_string();
        format!(
            "{}.{}",
            hex_encode(ts.as_bytes()),
            hex_encode(self.id.as_bytes())
        )
    }

    /// Decode and strictly validate an opaque hex cursor token (`AUD-32`).
    pub fn decode(raw: &str) -> Result<Self, StoreError> {
        if raw.is_empty() || raw.len() > 600 {
            return Err(StoreError::invalid_input("Invalid session cursor length."));
        }
        let Some((ts_part, id_part)) = raw.split_once('.') else {
            return Err(StoreError::invalid_input(
                "Invalid session cursor separator.",
            ));
        };
        if id_part.contains('.') || ts_part.is_empty() || id_part.is_empty() {
            return Err(StoreError::invalid_input("Malformed session cursor format."));
        }
        let ts_bytes = hex_decode(ts_part)
            .map_err(|_| StoreError::invalid_input("Malformed session cursor timestamp hex."))?;
        let id_bytes = hex_decode(id_part)
            .map_err(|_| StoreError::invalid_input("Malformed session cursor id hex."))?;
        let ts_str = std::str::from_utf8(&ts_bytes)
            .map_err(|_| StoreError::invalid_input("Invalid UTF-8 in session cursor timestamp."))?;
        let id = String::from_utf8(id_bytes)
            .map_err(|_| StoreError::invalid_input("Invalid UTF-8 in session cursor id."))?;
        if !is_strict_signed_decimal(ts_str) {
            return Err(StoreError::invalid_input("Invalid session cursor timestamp."));
        }
        let updated_at_ms = ts_str
            .parse::<i64>()
            .map_err(|_| StoreError::invalid_input("Out-of-range session cursor timestamp."))?;
        if !is_valid_studio_session_id(&id) {
            return Err(StoreError::invalid_input("Invalid session cursor id."));
        }
        Ok(Self { updated_at_ms, id })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionPage {
    pub items: Vec<SessionRecord>,
    pub has_more: bool,
    pub next_cursor: Option<SessionCursor>,
    pub total_count: i64,
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
        ensure_lease_columns(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Open an isolated in-memory `SessionStore` for unit testing.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        conn.exec_batch(SESSION_STORE_SCHEMA_SQL)?;
        ensure_lease_columns(&conn)?;
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

    /// Run `PRAGMA quick_check(1)` to verify SQLite database integrity.
    pub fn integrity_check(&self) -> Result<bool, StoreError> {
        let conn = self.lock_conn()?;
        Ok(conn.integrity_check()?)
    }

    /// Attempt to acquire the cooperative primary lease and return the granted [`LeaseRecord`]
    /// including its monotonic `lease_epoch` (`AUD-08`).
    ///
    /// - Rejects empty `owner_id`, non-positive `pid`, non-positive `ttl_ms`, or `now_ms + ttl_ms`
    ///   `i64` overflow.
    /// - Re-entrant acquisition requires BOTH `owner_id` AND `pid` to match an unexpired lease;
    ///   reusing an owner string from a different PID while unexpired is rejected (`Ok(None)`).
    /// - Acquiring an expired/released lease increments `lease_epoch` monotonically (overflow fails
    ///   closed with `lease_epoch_overflow`).
    pub fn acquire_lease_record(
        &self,
        owner_id: &str,
        pid: i64,
        ttl_ms: i64,
        now_ms: i64,
    ) -> Result<Option<LeaseRecord>, StoreError> {
        if owner_id.trim().is_empty() || pid <= 0 || ttl_ms <= 0 {
            return Err(StoreError::invalid_input(
                "Invalid lease owner_id, pid, or ttl_ms.",
            ));
        }
        let Some(new_expires) = checked_expiry(now_ms, ttl_ms) else {
            return Err(StoreError::invalid_input("Lease expiry overflows i64."));
        };

        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;

        let current = read_lease_locked(&tx)?;
        let Some(existing) = current else {
            let mut ins = tx.prepare(
                "INSERT INTO store_leases\n\
                 (lease_name, owner_id, pid, acquired_at_ms, heartbeat_at_ms, expires_at_ms, lease_epoch)\n\
                 VALUES (?1, ?2, ?3, ?4, ?4, ?5, 1);",
            )?;
            ins.bind_text(1, PRIMARY_LEASE_NAME)?;
            ins.bind_text(2, owner_id)?;
            ins.bind_int64(3, pid)?;
            ins.bind_int64(4, now_ms)?;
            ins.bind_int64(5, new_expires)?;
            ins.step()?;
            drop(ins);
            tx.commit()?;
            return Ok(Some(LeaseRecord {
                lease_name: PRIMARY_LEASE_NAME.to_owned(),
                owner_id: owner_id.to_owned(),
                pid,
                acquired_at_ms: now_ms,
                heartbeat_at_ms: now_ms,
                expires_at_ms: new_expires,
                lease_epoch: 1,
            }));
        };

        let same_owner =
            existing.owner_id == owner_id && existing.pid == pid && existing.expires_at_ms > now_ms;
        if !same_owner && existing.expires_at_ms > now_ms {
            tx.rollback()?;
            return Ok(None);
        }

        let next_acquired = if same_owner {
            existing.acquired_at_ms
        } else {
            now_ms
        };
        let next_epoch = if same_owner {
            existing.lease_epoch
        } else {
            existing.lease_epoch.checked_add(1).ok_or_else(|| {
                StoreError::conflict("lease_epoch_overflow", "Lease epoch overflow.")
            })?
        };

        let mut upd = tx.prepare(
            "UPDATE store_leases\n\
             SET owner_id = ?1, pid = ?2, acquired_at_ms = ?3, heartbeat_at_ms = ?4,\n\
                 expires_at_ms = ?5, lease_epoch = ?6\n\
             WHERE lease_name = ?7;",
        )?;
        upd.bind_text(1, owner_id)?;
        upd.bind_int64(2, pid)?;
        upd.bind_int64(3, next_acquired)?;
        upd.bind_int64(4, now_ms)?;
        upd.bind_int64(5, new_expires)?;
        upd.bind_int64(6, next_epoch)?;
        upd.bind_text(7, PRIMARY_LEASE_NAME)?;
        upd.step()?;
        drop(upd);

        tx.commit()?;
        Ok(Some(LeaseRecord {
            lease_name: PRIMARY_LEASE_NAME.to_owned(),
            owner_id: owner_id.to_owned(),
            pid,
            acquired_at_ms: next_acquired,
            heartbeat_at_ms: now_ms,
            expires_at_ms: new_expires,
            lease_epoch: next_epoch,
        }))
    }

    /// Attempt to acquire the cooperative primary lease; returns `Ok(true)` if granted
    /// (including matching `(owner_id, pid)` re-entrant refresh or expired lease takeover)
    /// or `Ok(false)` if actively held by another owner or PID.
    pub fn acquire_lease(
        &self,
        owner_id: &str,
        pid: i64,
        ttl_ms: i64,
        now_ms: i64,
    ) -> Result<bool, StoreError> {
        self.acquire_lease_record(owner_id, pid, ttl_ms, now_ms)
            .map(|opt| opt.is_some())
    }

    /// Extend the active lease TTL if `owner_id` currently owns an unexpired lease.
    /// Returns `Ok(false)` on `now_ms + ttl_ms` overflow without mutating the database.
    pub fn heartbeat(&self, owner_id: &str, ttl_ms: i64, now_ms: i64) -> Result<bool, StoreError> {
        if owner_id.trim().is_empty() || ttl_ms <= 0 {
            return Err(StoreError::invalid_input(
                "Lease owner_id must be non-empty and ttl_ms positive.",
            ));
        }
        let Some(expires_at) = checked_expiry(now_ms, ttl_ms) else {
            return Ok(false);
        };
        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;
        let mut stmt = tx.prepare(
            "UPDATE store_leases\n\
             SET heartbeat_at_ms = ?1, expires_at_ms = ?2\n\
             WHERE lease_name = ?3 AND owner_id = ?4 AND expires_at_ms > ?1;",
        )?;
        stmt.bind_int64(1, now_ms)?;
        stmt.bind_int64(2, expires_at)?;
        stmt.bind_text(3, PRIMARY_LEASE_NAME)?;
        stmt.bind_text(4, owner_id)?;
        stmt.step()?;
        drop(stmt);
        let updated = tx.changes() > 0;
        tx.commit()?;
        Ok(updated)
    }

    /// Fenced heartbeat (`AUD-08`): extends the lease only if `(owner_id, pid, lease_epoch)`
    /// matches the currently unexpired primary lease. Rejects stale PIDs, stale epochs, and
    /// `i64` expiry overflow cleanly with `Ok(false)`.
    pub fn heartbeat_fenced(
        &self,
        owner_id: &str,
        pid: i64,
        lease_epoch: i64,
        ttl_ms: i64,
        now_ms: i64,
    ) -> Result<bool, StoreError> {
        if owner_id.trim().is_empty() || pid <= 0 || lease_epoch <= 0 {
            return Ok(false);
        }
        let Some(expires_at) = checked_expiry(now_ms, ttl_ms) else {
            return Ok(false);
        };
        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;
        let mut stmt = tx.prepare(
            "UPDATE store_leases\n\
             SET heartbeat_at_ms = ?1, expires_at_ms = ?2\n\
             WHERE lease_name = ?3 AND owner_id = ?4 AND pid = ?5\n\
               AND lease_epoch = ?6 AND expires_at_ms > ?1;",
        )?;
        stmt.bind_int64(1, now_ms)?;
        stmt.bind_int64(2, expires_at)?;
        stmt.bind_text(3, PRIMARY_LEASE_NAME)?;
        stmt.bind_text(4, owner_id)?;
        stmt.bind_int64(5, pid)?;
        stmt.bind_int64(6, lease_epoch)?;
        stmt.step()?;
        drop(stmt);
        let updated = tx.changes() > 0;
        tx.commit()?;
        Ok(updated)
    }

    /// Release the primary lease if owned by `owner_id`, expiring `expires_at_ms = 0` in place
    /// so monotonic `lease_epoch` history is preserved for future fencing.
    pub fn release_lease(&self, owner_id: &str) -> Result<bool, StoreError> {
        if owner_id.trim().is_empty() {
            return Ok(false);
        }
        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;
        let mut stmt = tx.prepare(
            "UPDATE store_leases SET expires_at_ms = 0\n\
             WHERE lease_name = ?1 AND owner_id = ?2 AND expires_at_ms > 0;",
        )?;
        stmt.bind_text(1, PRIMARY_LEASE_NAME)?;
        stmt.bind_text(2, owner_id)?;
        stmt.step()?;
        drop(stmt);
        let released = tx.changes() > 0;
        tx.commit()?;
        Ok(released)
    }

    /// Fenced lease release (`AUD-08`): releases the primary lease only when `(owner_id, pid, lease_epoch)`
    /// matches, preventing a stale process from releasing a successor's lease.
    pub fn release_lease_fenced(
        &self,
        owner_id: &str,
        pid: i64,
        lease_epoch: i64,
    ) -> Result<bool, StoreError> {
        if owner_id.trim().is_empty() || pid <= 0 || lease_epoch <= 0 {
            return Ok(false);
        }
        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;
        let mut stmt = tx.prepare(
            "UPDATE store_leases SET expires_at_ms = 0\n\
             WHERE lease_name = ?1 AND owner_id = ?2 AND pid = ?3\n\
               AND lease_epoch = ?4 AND expires_at_ms > 0;",
        )?;
        stmt.bind_text(1, PRIMARY_LEASE_NAME)?;
        stmt.bind_text(2, owner_id)?;
        stmt.bind_int64(3, pid)?;
        stmt.bind_int64(4, lease_epoch)?;
        stmt.step()?;
        drop(stmt);
        let released = tx.changes() > 0;
        tx.commit()?;
        Ok(released)
    }

    /// Return `true` iff `(owner_id, pid, lease_epoch)` currently holds the unexpired primary lease.
    pub fn is_lease_current(
        &self,
        owner_id: &str,
        pid: i64,
        lease_epoch: i64,
        now_ms: i64,
    ) -> Result<bool, StoreError> {
        if owner_id.trim().is_empty() || pid <= 0 || lease_epoch <= 0 {
            return Ok(false);
        }
        let conn = self.lock_conn()?;
        Ok(read_lease_locked(&conn)?.is_some_and(|rec| {
            rec.owner_id == owner_id
                && rec.pid == pid
                && rec.lease_epoch == lease_epoch
                && rec.expires_at_ms > now_ms
        }))
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

    /// Atomically verify that `(owner_id, pid, lease_epoch)` holds the current unexpired lease
    /// and insert the session row inside the same `BEGIN IMMEDIATE` SQLite transaction (`AUD-08`).
    ///
    /// A missing, expired, or stale lease rolls back and returns `Ok(None)` without mutating `sessions`.
    #[allow(clippy::too_many_arguments)]
    pub fn create_session_if_lease_current(
        &self,
        title: &str,
        model_id: &str,
        effort: &str,
        now_ms: i64,
        owner_id: &str,
        pid: i64,
        lease_epoch: i64,
        custom_id: Option<&str>,
    ) -> Result<Option<SessionRecord>, StoreError> {
        let clean_effort = if effort.trim().is_empty() {
            "high"
        } else {
            effort.trim()
        };
        if !is_valid_effort(clean_effort)
            || owner_id.trim().is_empty()
            || pid <= 0
            || lease_epoch <= 0
        {
            return Err(StoreError::invalid_input(
                "Invalid fenced session create arguments.",
            ));
        }
        let clean_title = if title.trim().is_empty() {
            "New Studio Session".to_owned()
        } else {
            title.trim().to_owned()
        };
        let clean_model = if model_id.trim().is_empty() {
            "claude-opus-4-6".to_owned()
        } else {
            model_id.trim().to_owned()
        };
        let id = match custom_id {
            Some(s) if !s.trim().is_empty() => {
                let trimmed = s.trim();
                if !is_valid_studio_session_id(trimmed) {
                    return Err(StoreError::invalid_input("Invalid custom session id."));
                }
                trimmed.to_owned()
            }
            _ => uuid_v4(),
        };

        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;
        let lease_ok = read_lease_locked(&tx)?.is_some_and(|rec| {
            rec.owner_id == owner_id
                && rec.pid == pid
                && rec.lease_epoch == lease_epoch
                && rec.expires_at_ms > now_ms
        });
        if !lease_ok {
            tx.rollback()?;
            return Ok(None);
        }

        let mut stmt = tx.prepare(
            "INSERT INTO sessions (id, title, model_id, effort, revision, created_at_ms, updated_at_ms)\n\
             VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6);",
        )?;
        stmt.bind_text(1, &id)?;
        stmt.bind_text(2, &clean_title)?;
        stmt.bind_text(3, &clean_model)?;
        stmt.bind_text(4, clean_effort)?;
        stmt.bind_int64(5, now_ms)?;
        stmt.bind_int64(6, now_ms)?;
        stmt.step()?;
        drop(stmt);
        tx.commit()?;

        Ok(Some(SessionRecord {
            id,
            title: clean_title,
            model_id: clean_model,
            effort: clean_effort.to_owned(),
            revision: 1,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        }))
    }

    /// Idempotent, lease-fenced session bootstrap (`AUD-01` + `AUD-08`): verifies the lease is
    /// current inside `BEGIN IMMEDIATE`; if `id` already exists returns the existing row without
    /// duplicating or failing on restart, otherwise inserts the row atomically.
    #[allow(clippy::too_many_arguments)]
    pub fn ensure_session_if_lease_current(
        &self,
        id: &str,
        title: &str,
        model_id: &str,
        effort: &str,
        now_ms: i64,
        owner_id: &str,
        pid: i64,
        lease_epoch: i64,
    ) -> Result<Option<SessionRecord>, StoreError> {
        let trimmed_id = id.trim();
        let clean_effort = if effort.trim().is_empty() {
            "high"
        } else {
            effort.trim()
        };
        if !is_valid_studio_session_id(trimmed_id)
            || !is_valid_effort(clean_effort)
            || owner_id.trim().is_empty()
            || pid <= 0
            || lease_epoch <= 0
        {
            return Err(StoreError::invalid_input(
                "Invalid fenced bootstrap session arguments.",
            ));
        }
        let clean_title = if title.trim().is_empty() {
            "New Studio Session".to_owned()
        } else {
            title.trim().to_owned()
        };
        let clean_model = if model_id.trim().is_empty() {
            "claude-opus-4-6".to_owned()
        } else {
            model_id.trim().to_owned()
        };

        let mut conn = self.lock_conn()?;
        let tx = conn.begin_immediate()?;
        let lease_ok = read_lease_locked(&tx)?.is_some_and(|rec| {
            rec.owner_id == owner_id
                && rec.pid == pid
                && rec.lease_epoch == lease_epoch
                && rec.expires_at_ms > now_ms
        });
        if !lease_ok {
            tx.rollback()?;
            return Ok(None);
        }

        if let Some(existing) = read_session_locked(&tx, trimmed_id)? {
            tx.commit()?;
            return Ok(Some(existing));
        }

        let mut stmt = tx.prepare(
            "INSERT INTO sessions (id, title, model_id, effort, revision, created_at_ms, updated_at_ms)\n\
             VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6);",
        )?;
        stmt.bind_text(1, trimmed_id)?;
        stmt.bind_text(2, &clean_title)?;
        stmt.bind_text(3, &clean_model)?;
        stmt.bind_text(4, clean_effort)?;
        stmt.bind_int64(5, now_ms)?;
        stmt.bind_int64(6, now_ms)?;
        stmt.step()?;
        drop(stmt);
        tx.commit()?;

        Ok(Some(SessionRecord {
            id: trimmed_id.to_owned(),
            title: clean_title,
            model_id: clean_model,
            effort: clean_effort.to_owned(),
            revision: 1,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        }))
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
        if existing.revision == i64::MAX {
            return Err(StoreError::conflict(
                "session_revision_exhausted",
                format!("Session revision exhausted for {session_id}."),
            ));
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

    /// Return total persisted session count.
    pub fn count_sessions(&self) -> Result<i64, StoreError> {
        let conn = self.lock_conn()?;
        count_sessions_locked(&conn)
    }

    /// Keyset-paginated listing ordered by `(updated_at_ms DESC, id DESC)`.
    /// Limit is clamped into `1..=250`. Includes exact `total_count` (`AUD-32`).
    pub fn list_sessions_page(
        &self,
        limit: usize,
        cursor: Option<&SessionCursor>,
    ) -> Result<SessionPage, StoreError> {
        let bounded = limit.clamp(1, 250);
        let probe = i64::try_from(bounded + 1).unwrap_or(251);
        let conn = self.lock_conn()?;
        let total_count = count_sessions_locked(&conn)?;

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
            total_count,
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

fn checked_expiry(now_ms: i64, ttl_ms: i64) -> Option<i64> {
    if ttl_ms <= 0 {
        return None;
    }
    now_ms.checked_add(ttl_ms)
}

fn is_valid_effort(effort: &str) -> bool {
    matches!(
        effort,
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto"
    )
}

fn is_strict_signed_decimal(s: &str) -> bool {
    let digits = s.strip_prefix('-').unwrap_or(s);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

fn ensure_lease_columns(conn: &Connection) -> Result<(), StoreError> {
    let mut has_heartbeat = false;
    let mut has_epoch = false;
    let mut stmt = conn.prepare("PRAGMA table_info(store_leases);")?;
    while stmt.step()? == StepStatus::Row {
        let name = stmt.column_text(1)?;
        if name == "heartbeat_at_ms" {
            has_heartbeat = true;
        } else if name == "lease_epoch" {
            has_epoch = true;
        }
    }
    drop(stmt);

    if !has_heartbeat {
        conn.exec_batch(
            "ALTER TABLE store_leases ADD COLUMN heartbeat_at_ms INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    if !has_epoch {
        conn.exec_batch(
            "ALTER TABLE store_leases ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 1;",
        )?;
    }
    Ok(())
}

fn count_sessions_locked(conn: &Connection) -> Result<i64, StoreError> {
    let mut stmt = conn.prepare("SELECT COUNT(*) FROM sessions;")?;
    match stmt.step()? {
        StepStatus::Row => Ok(stmt.column_int64(0)?),
        StepStatus::Done => Ok(0),
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
        "SELECT lease_name, owner_id, pid, acquired_at_ms, heartbeat_at_ms, expires_at_ms, lease_epoch\n\
         FROM store_leases WHERE lease_name = ?1;",
    )?;
    stmt.bind_text(1, PRIMARY_LEASE_NAME)?;
    match stmt.step()? {
        StepStatus::Row => Ok(Some(LeaseRecord {
            lease_name: stmt.column_text(0)?,
            owner_id: stmt.column_text(1)?,
            pid: stmt.column_int64(2)?,
            acquired_at_ms: stmt.column_int64(3)?,
            heartbeat_at_ms: stmt.column_int64(4)?,
            expires_at_ms: stmt.column_int64(5)?,
            lease_epoch: stmt.column_int64(6)?,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDirGuard(PathBuf);

    impl TempDirGuard {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "omnia-pr1-session-{tag}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn pr1_fenced_leases_monotonic_epochs_overflow_and_atomic_session_create() {
        let store = SessionStore::open_in_memory().expect("open store");
        assert!(store.integrity_check().expect("integrity check"));

        // Invalid PID and expiry overflow must fail closed.
        assert!(store.acquire_lease_record("invalid-pid", 0, 1_000, 1).is_err());
        assert!(store.acquire_lease_record("invalid-pid", -5, 1_000, 1).is_err());
        assert!(store
            .acquire_lease_record("overflow-owner", 100, 100, i64::MAX - 10)
            .is_err());

        // 1. Initial lease gets epoch 1.
        let l1 = store
            .acquire_lease_record("owner-alpha", 4100, 10_000, 1_000)
            .expect("acquire alpha")
            .expect("granted");
        assert_eq!(l1.lease_epoch, 1);
        assert_eq!(l1.heartbeat_at_ms, 1_000);
        assert_eq!(l1.expires_at_ms, 11_000);

        // Heartbeat extends owner-alpha; competing owner-beta rejected.
        assert!(store.heartbeat("owner-alpha", 10_000, 8_000).expect("hb alpha"));
        assert!(!store.heartbeat("owner-beta", 10_000, 8_000).expect("hb beta"));

        // Reusing same owner string from a different PID must NOT steal/refresh live lease (AUD-08).
        assert!(store
            .acquire_lease_record("owner-alpha", 4101, 10_000, 9_000)
            .expect("diff pid check")
            .is_none());

        // Matching (owner_id, pid) re-entrant refresh preserves acquired_at_ms & lease_epoch.
        let l1_refresh = store
            .acquire_lease_record("owner-alpha", 4100, 10_000, 9_000)
            .expect("same pid refresh")
            .expect("refreshed");
        assert_eq!(l1_refresh.lease_epoch, 1);
        assert_eq!(l1_refresh.acquired_at_ms, 1_000);
        assert_eq!(l1_refresh.expires_at_ms, 19_000);

        // Still active at t=15000.
        assert!(store
            .acquire_lease_record("owner-beta", 4200, 10_000, 15_000)
            .expect("blocked beta")
            .is_none());

        // Expired takeover bumps lease_epoch 1 -> 2.
        let l2 = store
            .acquire_lease_record("owner-beta", 4200, 10_000, 19_001)
            .expect("takeover beta")
            .expect("granted beta");
        assert_eq!(l2.lease_epoch, 2);

        // Release sets expires_at_ms=0 in place without resetting lease_epoch.
        assert!(store.release_lease("owner-beta").expect("release beta"));
        assert!(store.active_lease(19_500).expect("no active").is_none());

        // Fenced lease acquires monotonic epoch 3 (never reset to 1!).
        let fenced = store
            .acquire_lease_record("owner-fenced", 4300, 10_000, 20_000)
            .expect("acquire fenced")
            .expect("granted fenced");
        assert_eq!(fenced.lease_epoch, 3);
        assert!(store
            .heartbeat_fenced("owner-fenced", 4300, fenced.lease_epoch, 10_000, 21_000)
            .expect("fenced hb"));
        assert!(!store
            .heartbeat_fenced("owner-fenced", 4301, fenced.lease_epoch, 10_000, 21_500)
            .expect("wrong pid hb"));
        assert!(!store
            .heartbeat_fenced("owner-fenced", 4300, fenced.lease_epoch - 1, 10_000, 21_500)
            .expect("stale epoch hb"));
        assert!(!store
            .release_lease_fenced("owner-fenced", 4301, fenced.lease_epoch)
            .expect("wrong pid release"));

        // Atomic fenced session create succeeds with current lease and fails cleanly on stale epoch.
        let fenced_session = store
            .create_session_if_lease_current(
                "Fenced",
                "test-model",
                "high",
                22_000,
                "owner-fenced",
                4300,
                fenced.lease_epoch,
                Some("fenced-session"),
            )
            .expect("fenced create")
            .expect("session created");
        assert_eq!(fenced_session.id, "fenced-session");

        let stale_create = store
            .create_session_if_lease_current(
                "Stale",
                "test-model",
                "high",
                22_001,
                "owner-fenced",
                4300,
                fenced.lease_epoch - 1,
                Some("stale-session"),
            )
            .expect("stale create returns None");
        assert!(stale_create.is_none());
        assert!(store.get_session("stale-session").expect("lookup").is_none());

        // Idempotent restart-safe bootstrap (AUD-01) reopens existing row without duplicate error.
        let ensured1 = store
            .ensure_session_if_lease_current(
                "fenced-session",
                "Fenced",
                "test-model",
                "high",
                22_002,
                "owner-fenced",
                4300,
                fenced.lease_epoch,
            )
            .expect("ensure existing")
            .expect("existing row");
        assert_eq!(ensured1.id, "fenced-session");
        assert_eq!(store.count_sessions().expect("count"), 1);

        // Release fenced and verify successor gets epoch 4; stale release cannot touch successor.
        assert!(store
            .release_lease_fenced("owner-fenced", 4300, fenced.lease_epoch)
            .expect("release fenced"));
        let successor = store
            .acquire_lease_record("owner-successor", 4400, 10_000, 23_000)
            .expect("acquire successor")
            .expect("granted successor");
        assert_eq!(successor.lease_epoch, 4);
        assert!(!store
            .release_lease_fenced("owner-fenced", 4300, fenced.lease_epoch)
            .expect("stale release blocked"));
        assert!(!store
            .heartbeat("owner-successor", 100, i64::MAX - 10)
            .expect("overflow hb returns false"));
        assert!(store
            .release_lease_fenced("owner-successor", 4400, successor.lease_epoch)
            .expect("release successor"));
    }

    #[test]
    fn legacy_5_column_store_leases_table_migrates_cleanly_on_reopen() {
        let temp = TempDirGuard::new("legacy-migrate");
        let db_path = temp.0.join("studio_legacy.db");

        {
            let conn = Connection::open_read_write(&db_path).expect("seed legacy db");
            conn.exec_batch(
                "CREATE TABLE store_leases (\n\
                    lease_name TEXT PRIMARY KEY,\n\
                    owner_id TEXT NOT NULL,\n\
                    pid INTEGER NOT NULL,\n\
                    acquired_at_ms INTEGER NOT NULL,\n\
                    expires_at_ms INTEGER NOT NULL\n\
                );\n\
                INSERT INTO store_leases (lease_name, owner_id, pid, acquired_at_ms, expires_at_ms)\n\
                VALUES ('studio_primary', 'legacy-owner', 777, 1000, 2000);",
            )
            .expect("seed legacy row");
        }

        let store = SessionStore::open(&db_path).expect("open migrates legacy table");
        let taken = store
            .acquire_lease_record("modern-owner", 888, 5_000, 3_000)
            .expect("takeover expired legacy lease")
            .expect("granted");
        assert_eq!(taken.lease_epoch, 2);
        assert_eq!(taken.heartbeat_at_ms, 3_000);
    }

    #[test]
    fn opaque_session_cursor_and_56_session_timestamp_tie_paging_enumerates_every_id_once() {
        let store = SessionStore::open_in_memory().expect("open store");
        for i in 0..56 {
            let ts = 10_000 + (i / 4) * 100; // Deliberate 4-way timestamp ties!
            store
                .create_session(
                    &format!("Session {i:02}"),
                    "gpt-5.4",
                    "high",
                    ts,
                    Some(&format!("sess-{i:02}")),
                )
                .expect("create session");
        }

        let mut seen = HashSet::new();
        let mut cursor_token: Option<String> = None;
        let mut pages = 0usize;
        loop {
            let decoded = cursor_token
                .as_deref()
                .map(SessionCursor::decode)
                .transpose()
                .expect("valid cursor token");
            let page = store
                .list_sessions_page(15, decoded.as_ref())
                .expect("list page");
            assert_eq!(page.total_count, 56);
            for rec in &page.items {
                assert!(seen.insert(rec.id.clone()), "duplicate session {}", rec.id);
            }
            pages += 1;
            if !page.has_more {
                assert!(page.next_cursor.is_none());
                break;
            }
            cursor_token = page.next_cursor.map(|c| c.encode());
        }
        assert_eq!(pages, 4);
        assert_eq!(seen.len(), 56);

        // Negative cursor & session-ID checks (AUD-32).
        for bad in ["", "nothex.1234", "3132.2e2e", "3132.612f62", "a.b.c"] {
            assert!(SessionCursor::decode(bad).is_err(), "must reject {bad}");
        }
        assert!(!is_valid_studio_session_id(""));
        assert!(!is_valid_studio_session_id("../escape"));
        assert!(!is_valid_studio_session_id("bad/slash"));
        assert!(!is_valid_studio_session_id("bad?query"));
        assert!(!is_valid_studio_session_id("bad\x07ctrl"));
        assert!(is_valid_studio_session_id("sess-valid_01"));
    }
}
