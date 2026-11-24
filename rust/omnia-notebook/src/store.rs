//! Persistent WAL SQLite storage layer built directly on `omnia-winsqlite`.
//!
//! Tables managed:
//! - `notebooks`
//! - `notebook_sources` (immutable `source_id`, optional `remote_id`, `UNIQUE(notebook_id, content_sha256)`)
//! - `notebook_chunks` (+ optional `notebook_chunks_fts` FTS5 shadow index + exact multi-field BM25F search)
//! - `notebook_artifacts`
//! - `notebook_turns`
//! - `notebook_btw_threads`
//! - `notebook_bridge_events`

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use omnia_core::now_epoch_ms;
use omnia_harness::{fold_vietnamese_ascii, tokenize_folded};
use omnia_winsqlite::{Connection, StepStatus, StoreOwnership};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::NotebookError;
use crate::policy::DEFAULT_MAX_SOURCES_PER_NOTEBOOK;
use crate::source_library::{
    ClearSourcesReceipt, NotebookRecord, SourceChunkRecord, SourceFilter, SourceKind, SourceRecord,
};

const NOTEBOOK_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS notebooks (
    notebook_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    allow_overflow_notebook INTEGER NOT NULL DEFAULT 0,
    max_sources INTEGER NOT NULL DEFAULT 50,
    model_id TEXT NOT NULL DEFAULT 'gemini-3.5-flash-lite',
    effort_level TEXT NOT NULL DEFAULT 'medium',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notebook_sources (
    source_id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
    remote_id TEXT,
    title TEXT NOT NULL,
    safe_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    is_video INTEGER NOT NULL DEFAULT 0,
    content_sha256 TEXT NOT NULL,
    content_blake3 TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    ingestion_stage TEXT NOT NULL,
    provenance TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL,
    UNIQUE(notebook_id, content_sha256)
);

CREATE INDEX IF NOT EXISTS idx_notebook_sources_notebook
    ON notebook_sources (notebook_id, created_at_ms ASC);

CREATE INDEX IF NOT EXISTS idx_notebook_sources_remote
    ON notebook_sources (notebook_id, remote_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notebook_sources_remote
    ON notebook_sources (notebook_id, remote_id)
    WHERE remote_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notebook_sources_title
    ON notebook_sources (notebook_id, title);

CREATE TABLE IF NOT EXISTS notebook_chunks (
    chunk_id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES notebook_sources(source_id) ON DELETE CASCADE,
    chunk_idx INTEGER NOT NULL,
    heading TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    body_folded TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    byte_size INTEGER NOT NULL,
    content_blake3 TEXT NOT NULL,
    UNIQUE(source_id, chunk_idx)
);

CREATE INDEX IF NOT EXISTS idx_notebook_chunks_notebook
    ON notebook_chunks (notebook_id, source_id, chunk_idx ASC);

CREATE TABLE IF NOT EXISTS notebook_artifacts (
    artifact_id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    content_markdown TEXT NOT NULL,
    structured_json TEXT NOT NULL,
    cited_source_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notebook_artifacts_notebook
    ON notebook_artifacts (notebook_id, created_at_ms ASC);

CREATE TABLE IF NOT EXISTS notebook_turns (
    turn_id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
    turn_index INTEGER NOT NULL,
    surface TEXT NOT NULL,
    role TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    response_markdown TEXT NOT NULL,
    model_id TEXT NOT NULL,
    effort_level TEXT NOT NULL,
    quotes_json TEXT NOT NULL DEFAULT '[]',
    citations_json TEXT NOT NULL DEFAULT '[]',
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notebook_turns_notebook
    ON notebook_turns (notebook_id, turn_index ASC);

CREATE TABLE IF NOT EXISTS notebook_btw_threads (
    btw_id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
    anchor_turn_id TEXT NOT NULL,
    anchor_quote_json TEXT NOT NULL,
    status TEXT NOT NULL,
    promoted_source_id TEXT,
    messages_json TEXT NOT NULL DEFAULT '[]',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notebook_btw_notebook
    ON notebook_btw_threads (notebook_id, created_at_ms ASC);

CREATE TABLE IF NOT EXISTS notebook_bridge_events (
    event_id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
    direction TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    target_source_id TEXT,
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notebook_bridge_notebook
    ON notebook_bridge_events (notebook_id, created_at_ms ASC);

CREATE TABLE IF NOT EXISTS notebook_sync_tombstones (
    notebook_id TEXT NOT NULL REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
    tombstone_key TEXT NOT NULL,
    remote_id TEXT,
    content_sha256 TEXT,
    reason TEXT NOT NULL DEFAULT 'user_deleted',
    deleted_at_ms INTEGER NOT NULL,
    PRIMARY KEY (notebook_id, tombstone_key)
);

CREATE INDEX IF NOT EXISTS idx_notebook_tombstones_remote
    ON notebook_sync_tombstones (notebook_id, remote_id);
"#;

const NOTEBOOK_FTS5_SQL: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS notebook_chunks_fts USING fts5(
    chunk_id UNINDEXED,
    notebook_id UNINDEXED,
    source_id UNINDEXED,
    title,
    heading,
    body_folded
);
"#;

/// Persisted main-surface turn record inside `notebook_turns`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotebookTurnRecord {
    pub turn_id: String,
    pub notebook_id: String,
    pub turn_index: usize,
    pub surface: String,
    pub role: String,
    pub prompt_text: String,
    pub response_markdown: String,
    pub model_id: String,
    pub effort_level: String,
    pub quotes: Vec<Value>,
    pub citations: Vec<String>,
    pub created_at_ms: i64,
}

/// Persisted Studio artifact row inside `notebook_artifacts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredArtifactRow {
    pub artifact_id: String,
    pub notebook_id: String,
    pub kind: String,
    pub title: String,
    pub content_markdown: String,
    pub structured_json: Value,
    pub cited_source_ids: Vec<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Persisted BTW side-thread row inside `notebook_btw_threads`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredBtwRow {
    pub btw_id: String,
    pub notebook_id: String,
    pub anchor_turn_id: String,
    pub anchor_quote_json: Value,
    pub status: String,
    pub promoted_source_id: Option<String>,
    pub messages_json: Value,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Persisted Cross-Bridge audit row inside `notebook_bridge_events`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredBridgeRow {
    pub event_id: String,
    pub notebook_id: String,
    pub direction: String,
    pub payload_json: Value,
    pub target_source_id: Option<String>,
    pub created_at_ms: i64,
}

/// Persisted remote sync tombstone row inside `notebook_sync_tombstones`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncTombstoneRow {
    pub notebook_id: String,
    pub tombstone_key: String,
    pub remote_id: Option<String>,
    pub content_sha256: Option<String>,
    pub reason: String,
    pub deleted_at_ms: i64,
}

/// Ranked BM25F chunk match returned by [`NotebookStore::search_chunks_bm25f`].
#[derive(Debug, Clone, PartialEq)]
pub struct Bm25ChunkHit {
    pub chunk: SourceChunkRecord,
    pub source_title: String,
    pub source_provenance: String,
    pub bm25f_score: f64,
    pub matched_terms: Vec<String>,
}

/// WAL-backed SQLite store for `omnia-notebook`.
///
/// Field drop order is deliberate: `conn` MUST precede `_ownership` so SQLite closes its handle
/// before `StoreOwnership` releases the Win32 `LockFileEx` advisory byte lock.
#[derive(Debug)]
pub struct NotebookStore {
    db_path: PathBuf,
    conn: Mutex<Connection>,
    fts5_enabled: bool,
    _ownership: Option<StoreOwnership>,
}

impl NotebookStore {
    /// Open or create a persistent WAL SQLite database at `db_path` with cooperative Win32 lease locking.
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self, NotebookError> {
        let path = db_path.as_ref().to_path_buf();
        if path.as_os_str().is_empty() {
            return Err(NotebookError::InvalidInput(
                "notebook database path cannot be empty".to_string(),
            ));
        }
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|e| {
                    NotebookError::Io(format!(
                        "failed to create notebook store parent directory '{}': {e}",
                        parent.display()
                    ))
                })?;
            }
        }
        let ownership = StoreOwnership::acquire(&path)?;
        let conn = Connection::open_read_write(&path)?;
        let fts5_enabled = bootstrap_schema(&conn)?;
        Ok(Self {
            db_path: path,
            conn: Mutex::new(conn),
            fts5_enabled,
            _ownership: Some(ownership),
        })
    }

    /// Open an isolated in-memory WAL-compatible SQLite database (ideal for unit tests and ephemeral workspaces).
    pub fn open_in_memory() -> Result<Self, NotebookError> {
        let conn = Connection::open_in_memory()?;
        let fts5_enabled = bootstrap_schema(&conn)?;
        Ok(Self {
            db_path: PathBuf::from(":memory:"),
            conn: Mutex::new(conn),
            fts5_enabled,
            _ownership: None,
        })
    }

    /// Path of the underlying SQLite database file (or `:memory:`).
    #[must_use]
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// Returns `true` when the runtime `winsqlite3` DLL supports SQLite FTS5 virtual tables.
    #[must_use]
    pub const fn fts5_enabled(&self) -> bool {
        self.fts5_enabled
    }

    /// Query the current SQLite `journal_mode` pragma (for persistence/WAL verification).
    pub fn journal_mode(&self) -> Result<String, NotebookError> {
        let conn = self.conn.lock();
        Ok(conn
            .query_scalar_text("PRAGMA journal_mode;")?
            .unwrap_or_default())
    }

    /// Insert a new notebook record.
    pub fn create_notebook(&self, record: &NotebookRecord) -> Result<(), NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "INSERT INTO notebooks (
                notebook_id, title, description, allow_overflow_notebook,
                max_sources, model_id, effort_level, created_at_ms, updated_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);",
        )?;
        stmt.bind_text(1, &record.notebook_id)?;
        stmt.bind_text(2, &record.title)?;
        stmt.bind_text(3, &record.description)?;
        stmt.bind_int64(4, i64::from(record.allow_overflow_notebook))?;
        stmt.bind_int64(5, record.max_sources as i64)?;
        stmt.bind_text(6, &record.model_id)?;
        stmt.bind_text(7, &record.effort_level)?;
        stmt.bind_int64(8, record.created_at_ms)?;
        stmt.bind_int64(9, record.updated_at_ms)?;
        stmt.step()?;
        Ok(())
    }

    /// Fetch a notebook by `notebook_id`.
    pub fn get_notebook(&self, notebook_id: &str) -> Result<Option<NotebookRecord>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT notebook_id, title, description, allow_overflow_notebook,
                    max_sources, model_id, effort_level, created_at_ms, updated_at_ms
             FROM notebooks WHERE notebook_id = ?1;",
        )?;
        stmt.bind_text(1, notebook_id)?;
        if matches!(stmt.step()?, StepStatus::Row) {
            return Ok(Some(NotebookRecord {
                notebook_id: stmt.column_text(0)?,
                title: stmt.column_text(1)?,
                description: stmt.column_text(2)?,
                allow_overflow_notebook: stmt.column_int64(3)? != 0,
                max_sources: stmt.column_int64(4)?.max(1) as usize,
                model_id: stmt.column_text(5)?,
                effort_level: stmt.column_text(6)?,
                created_at_ms: stmt.column_int64(7)?,
                updated_at_ms: stmt.column_int64(8)?,
            }));
        }
        Ok(None)
    }

    /// List all notebooks ordered by `updated_at_ms DESC`.
    pub fn list_notebooks(&self) -> Result<Vec<NotebookRecord>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT notebook_id, title, description, allow_overflow_notebook,
                    max_sources, model_id, effort_level, created_at_ms, updated_at_ms
             FROM notebooks ORDER BY updated_at_ms DESC, notebook_id ASC;",
        )?;
        let mut out = Vec::new();
        while stmt.step_row()? {
            out.push(NotebookRecord {
                notebook_id: stmt.column_text(0)?,
                title: stmt.column_text(1)?,
                description: stmt.column_text(2)?,
                allow_overflow_notebook: stmt.column_int64(3)? != 0,
                max_sources: stmt.column_int64(4)?.max(1) as usize,
                model_id: stmt.column_text(5)?,
                effort_level: stmt.column_text(6)?,
                created_at_ms: stmt.column_int64(7)?,
                updated_at_ms: stmt.column_int64(8)?,
            });
        }
        Ok(out)
    }

    /// Delete a notebook and cascade-remove all owned rows.
    pub fn delete_notebook(&self, notebook_id: &str) -> Result<bool, NotebookError> {
        let mut conn = self.conn.lock();
        let tx = conn.begin_immediate()?;
        if self.fts5_enabled {
            let mut fts =
                tx.prepare("DELETE FROM notebook_chunks_fts WHERE notebook_id = ?1;")?;
            fts.bind_text(1, notebook_id)?;
            fts.step()?;
        }
        let deleted = {
            let mut stmt = tx.prepare("DELETE FROM notebooks WHERE notebook_id = ?1;")?;
            stmt.bind_text(1, notebook_id)?;
            stmt.step()?;
            tx.changes() > 0
        };
        tx.commit()?;
        Ok(deleted)
    }

    /// Update notebook model/effort selection metadata.
    pub fn update_notebook_model_effort(
        &self,
        notebook_id: &str,
        model_id: &str,
        effort_level: &str,
    ) -> Result<bool, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "UPDATE notebooks SET model_id = ?2, effort_level = ?3, updated_at_ms = ?4
             WHERE notebook_id = ?1;",
        )?;
        stmt.bind_text(1, notebook_id)?;
        stmt.bind_text(2, model_id)?;
        stmt.bind_text(3, effort_level)?;
        stmt.bind_int64(4, now_epoch_ms())?;
        stmt.step()?;
        Ok(conn.changes() > 0)
    }

    /// Count sources currently persisted in a notebook.
    pub fn count_sources(&self, notebook_id: &str) -> Result<usize, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare("SELECT COUNT(*) FROM notebook_sources WHERE notebook_id = ?1;")?;
        stmt.bind_text(1, notebook_id)?;
        if stmt.step_row()? {
            return Ok(stmt.column_int64(0)?.max(0) as usize);
        }
        Ok(0)
    }

    /// Find an existing source by `(notebook_id, content_sha256)` for cross-batch deduplication.
    pub fn find_source_by_sha256(
        &self,
        notebook_id: &str,
        content_sha256: &str,
    ) -> Result<Option<SourceRecord>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT source_id, notebook_id, remote_id, title, safe_filename, mime_type,
                    source_kind, is_video, content_sha256, content_blake3, byte_size,
                    chunk_count, ingestion_stage, provenance, metadata_json, created_at_ms
             FROM notebook_sources
             WHERE notebook_id = ?1 AND content_sha256 = ?2;",
        )?;
        stmt.bind_text(1, notebook_id)?;
        stmt.bind_text(2, content_sha256)?;
        if stmt.step_row()? {
            return Ok(Some(read_source_row(&stmt)?));
        }
        Ok(None)
    }

    /// Fetch a source by immutable `source_id`.
    pub fn get_source(&self, source_id: &str) -> Result<Option<SourceRecord>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT source_id, notebook_id, remote_id, title, safe_filename, mime_type,
                    source_kind, is_video, content_sha256, content_blake3, byte_size,
                    chunk_count, ingestion_stage, provenance, metadata_json, created_at_ms
             FROM notebook_sources WHERE source_id = ?1;",
        )?;
        stmt.bind_text(1, source_id)?;
        if stmt.step_row()? {
            return Ok(Some(read_source_row(&stmt)?));
        }
        Ok(None)
    }

    /// Find a source inside `notebook_id` by immutable `source_id` first, then by `remote_id`.
    ///
    /// `source_id` always wins. A `remote_id` lookup that matches more than one source (possible
    /// only in legacy databases created before the unique partial index) is rejected with
    /// [`NotebookError::AmbiguousCitation`] instead of silently returning an arbitrary row.
    pub fn find_source_by_id_or_remote(
        &self,
        notebook_id: &str,
        id_or_remote: &str,
    ) -> Result<Option<SourceRecord>, NotebookError> {
        let conn = self.conn.lock();
        {
            let mut by_id = conn.prepare(
                "SELECT source_id, notebook_id, remote_id, title, safe_filename, mime_type,
                        source_kind, is_video, content_sha256, content_blake3, byte_size,
                        chunk_count, ingestion_stage, provenance, metadata_json, created_at_ms
                 FROM notebook_sources
                 WHERE notebook_id = ?1 AND source_id = ?2;",
            )?;
            by_id.bind_text(1, notebook_id)?;
            by_id.bind_text(2, id_or_remote)?;
            if by_id.step_row()? {
                return Ok(Some(read_source_row(&by_id)?));
            }
        }
        let mut by_remote = conn.prepare(
            "SELECT source_id, notebook_id, remote_id, title, safe_filename, mime_type,
                    source_kind, is_video, content_sha256, content_blake3, byte_size,
                    chunk_count, ingestion_stage, provenance, metadata_json, created_at_ms
             FROM notebook_sources
             WHERE notebook_id = ?1 AND remote_id = ?2
             ORDER BY created_at_ms ASC, source_id ASC;",
        )?;
        by_remote.bind_text(1, notebook_id)?;
        by_remote.bind_text(2, id_or_remote)?;
        let mut matches = Vec::new();
        while by_remote.step_row()? {
            matches.push(read_source_row(&by_remote)?);
        }
        match matches.len() {
            0 => Ok(None),
            1 => Ok(matches.pop()),
            _ => Err(NotebookError::AmbiguousCitation {
                title: id_or_remote.to_string(),
                matching_source_ids: matches.into_iter().map(|s| s.source_id).collect(),
            }),
        }
    }

    /// Return the `source_id` currently bound to `remote_id` inside `notebook_id`, if any.
    pub fn find_source_id_by_remote(
        &self,
        notebook_id: &str,
        remote_id: &str,
    ) -> Result<Option<String>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT source_id FROM notebook_sources
             WHERE notebook_id = ?1 AND remote_id = ?2
             ORDER BY created_at_ms ASC, source_id ASC LIMIT 1;",
        )?;
        stmt.bind_text(1, notebook_id)?;
        stmt.bind_text(2, remote_id)?;
        if stmt.step_row()? {
            return Ok(Some(stmt.column_text(0)?));
        }
        Ok(None)
    }

    /// Find all sources in a notebook sharing a given title (used to detect duplicate-title ambiguity).
    pub fn find_sources_by_title(
        &self,
        notebook_id: &str,
        title: &str,
    ) -> Result<Vec<SourceRecord>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT source_id, notebook_id, remote_id, title, safe_filename, mime_type,
                    source_kind, is_video, content_sha256, content_blake3, byte_size,
                    chunk_count, ingestion_stage, provenance, metadata_json, created_at_ms
             FROM notebook_sources
             WHERE notebook_id = ?1 AND lower(title) = lower(?2)
             ORDER BY created_at_ms ASC, source_id ASC;",
        )?;
        stmt.bind_text(1, notebook_id)?;
        stmt.bind_text(2, title)?;
        let mut out = Vec::new();
        while stmt.step_row()? {
            out.push(read_source_row(&stmt)?);
        }
        Ok(out)
    }

    /// Atomically insert a source and all its semantic chunks inside one IMMEDIATE transaction.
    ///
    /// The notebook capacity (`max_sources`, with `allow_overflow_notebook` strictly `false`) is
    /// re-checked INSIDE the write transaction so concurrent ingests can never race past the cap.
    pub fn insert_source_with_chunks(
        &self,
        source: &SourceRecord,
        chunks: &[SourceChunkRecord],
    ) -> Result<(), NotebookError> {
        let mut conn = self.conn.lock();
        let tx = conn.begin_immediate()?;
        {
            let mut cap = tx.prepare(
                "SELECT n.max_sources,
                        (SELECT COUNT(*) FROM notebook_sources s WHERE s.notebook_id = n.notebook_id)
                 FROM notebooks n WHERE n.notebook_id = ?1;",
            )?;
            cap.bind_text(1, &source.notebook_id)?;
            if !cap.step_row()? {
                return Err(NotebookError::NotFound {
                    entity: "notebook",
                    id: source.notebook_id.clone(),
                });
            }
            let max = cap.column_int64(0)?.max(1) as usize;
            let current = cap.column_int64(1)?.max(0) as usize;
            if current >= max {
                return Err(NotebookError::OverflowDisallowed {
                    notebook_id: source.notebook_id.clone(),
                    current,
                    max,
                });
            }
        }
        {
            let mut stmt = tx.prepare(
                "INSERT INTO notebook_sources (
                    source_id, notebook_id, remote_id, title, safe_filename, mime_type,
                    source_kind, is_video, content_sha256, content_blake3, byte_size,
                    chunk_count, ingestion_stage, provenance, metadata_json, created_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16);",
            )?;
            let meta_str = serde_json::to_string(&source.metadata)?;
            stmt.bind_text(1, &source.source_id)?;
            stmt.bind_text(2, &source.notebook_id)?;
            stmt.bind_opt_text(3, source.remote_id.as_deref())?;
            stmt.bind_text(4, &source.title)?;
            stmt.bind_text(5, &source.safe_filename)?;
            stmt.bind_text(6, &source.mime_type)?;
            stmt.bind_text(7, source.source_kind.as_str())?;
            stmt.bind_int64(8, i64::from(source.is_video))?;
            stmt.bind_text(9, &source.content_sha256)?;
            stmt.bind_text(10, &source.content_blake3)?;
            stmt.bind_int64(11, source.byte_size as i64)?;
            stmt.bind_int64(12, chunks.len() as i64)?;
            stmt.bind_text(13, &source.ingestion_stage)?;
            stmt.bind_text(14, &source.provenance)?;
            stmt.bind_text(15, &meta_str)?;
            stmt.bind_int64(16, source.created_at_ms)?;
            stmt.step()?;
        }

        insert_chunks_in_tx(&tx, self.fts5_enabled, &source.title, chunks)?;

        {
            let mut upd = tx.prepare(
                "UPDATE notebooks SET updated_at_ms = ?2 WHERE notebook_id = ?1;",
            )?;
            upd.bind_text(1, &source.notebook_id)?;
            upd.bind_int64(2, now_epoch_ms())?;
            upd.step()?;
        }

        tx.commit()?;
        Ok(())
    }

    /// Atomically replace chunks for an existing source (used during Stage 6 heal sweep).
    pub fn replace_source_chunks(
        &self,
        source_id: &str,
        source_title: &str,
        chunks: &[SourceChunkRecord],
        new_stage: &str,
    ) -> Result<(), NotebookError> {
        let mut conn = self.conn.lock();
        let tx = conn.begin_immediate()?;
        if self.fts5_enabled {
            let mut fts = tx.prepare("DELETE FROM notebook_chunks_fts WHERE source_id = ?1;")?;
            fts.bind_text(1, source_id)?;
            fts.step()?;
        }
        {
            let mut del = tx.prepare("DELETE FROM notebook_chunks WHERE source_id = ?1;")?;
            del.bind_text(1, source_id)?;
            del.step()?;
        }
        insert_chunks_in_tx(&tx, self.fts5_enabled, source_title, chunks)?;
        {
            let mut upd = tx.prepare(
                "UPDATE notebook_sources SET chunk_count = ?2, ingestion_stage = ?3 WHERE source_id = ?1;",
            )?;
            upd.bind_text(1, source_id)?;
            upd.bind_int64(2, chunks.len() as i64)?;
            upd.bind_text(3, new_stage)?;
            upd.step()?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Delete a specific set of sibling `source_id`s atomically (used for multi-part rollback).
    pub fn delete_sources_by_ids(&self, source_ids: &[String]) -> Result<usize, NotebookError> {
        if source_ids.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn.lock();
        let tx = conn.begin_immediate()?;
        let mut removed = 0usize;
        for sid in source_ids {
            if self.fts5_enabled {
                let mut fts =
                    tx.prepare("DELETE FROM notebook_chunks_fts WHERE source_id = ?1;")?;
                fts.bind_text(1, sid)?;
                fts.step()?;
            }
            let mut del = tx.prepare("DELETE FROM notebook_sources WHERE source_id = ?1;")?;
            del.bind_text(1, sid)?;
            del.step()?;
            if tx.changes() > 0 {
                removed += 1;
            }
        }
        tx.commit()?;
        Ok(removed)
    }

    /// List sources in a notebook with optional `exclude_videos` / `pure_documents_only` filters.
    pub fn list_sources(
        &self,
        notebook_id: &str,
        filter: &SourceFilter,
    ) -> Result<Vec<SourceRecord>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT source_id, notebook_id, remote_id, title, safe_filename, mime_type,
                    source_kind, is_video, content_sha256, content_blake3, byte_size,
                    chunk_count, ingestion_stage, provenance, metadata_json, created_at_ms
             FROM notebook_sources
             WHERE notebook_id = ?1
             ORDER BY created_at_ms ASC, source_id ASC;",
        )?;
        stmt.bind_text(1, notebook_id)?;
        let query_folded = filter
            .query
            .as_deref()
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(fold_vietnamese_ascii);

        let mut out = Vec::new();
        while stmt.step_row()? {
            let rec = read_source_row(&stmt)?;
            if !filter.matches(&rec, query_folded.as_deref()) {
                continue;
            }
            out.push(rec);
        }
        Ok(out)
    }

    /// Clear ONLY `notebook_sources` and `notebook_chunks` for `notebook_id`, strictly preserving
    /// Studio artifacts (`notebook_artifacts`), chat turns (`notebook_turns`), and BTW threads (`notebook_btw_threads`).
    pub fn clear_sources(&self, notebook_id: &str) -> Result<ClearSourcesReceipt, NotebookError> {
        let mut conn = self.conn.lock();
        let tx = conn.begin_immediate()?;

        let exists = {
            let mut chk = tx.prepare("SELECT 1 FROM notebooks WHERE notebook_id = ?1;")?;
            chk.bind_text(1, notebook_id)?;
            chk.step_row()?
        };
        if !exists {
            return Err(NotebookError::NotFound {
                entity: "notebook",
                id: notebook_id.to_string(),
            });
        }

        if self.fts5_enabled {
            let mut fts =
                tx.prepare("DELETE FROM notebook_chunks_fts WHERE notebook_id = ?1;")?;
            fts.bind_text(1, notebook_id)?;
            fts.step()?;
        }

        let removed_chunks = {
            let mut del = tx.prepare("DELETE FROM notebook_chunks WHERE notebook_id = ?1;")?;
            del.bind_text(1, notebook_id)?;
            del.step()?;
            tx.changes().max(0) as usize
        };

        {
            let mut src_sel = tx.prepare(
                "SELECT source_id, remote_id, content_sha256 FROM notebook_sources WHERE notebook_id = ?1;",
            )?;
            src_sel.bind_text(1, notebook_id)?;
            let mut tomb_rows = Vec::new();
            while src_sel.step_row()? {
                let sid = src_sel.column_text(0)?;
                let rid = src_sel.column_opt_text(1)?;
                let sha = src_sel.column_text(2)?;
                let key = rid.clone().unwrap_or(sid);
                tomb_rows.push((key, rid, sha));
            }
            drop(src_sel);
            if !tomb_rows.is_empty() {
                let now = now_epoch_ms();
                let mut ins = tx.prepare(
                    "INSERT INTO notebook_sync_tombstones (
                        notebook_id, tombstone_key, remote_id, content_sha256, reason, deleted_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(notebook_id, tombstone_key) DO UPDATE SET
                        remote_id = COALESCE(excluded.remote_id, notebook_sync_tombstones.remote_id),
                        content_sha256 = COALESCE(excluded.content_sha256, notebook_sync_tombstones.content_sha256),
                        reason = excluded.reason,
                        deleted_at_ms = excluded.deleted_at_ms;",
                )?;
                for (key, rid, sha) in tomb_rows {
                    ins.reset()?;
                    ins.clear_bindings()?;
                    ins.bind_text(1, notebook_id)?;
                    ins.bind_text(2, &key)?;
                    ins.bind_opt_text(3, rid.as_deref())?;
                    ins.bind_text(4, &sha)?;
                    ins.bind_text(5, "clear_sources")?;
                    ins.bind_int64(6, now)?;
                    ins.step()?;
                }
            }
        }

        let removed_sources = {
            let mut del = tx.prepare("DELETE FROM notebook_sources WHERE notebook_id = ?1;")?;
            del.bind_text(1, notebook_id)?;
            del.step()?;
            tx.changes().max(0) as usize
        };

        let preserved_artifacts = count_table_for_notebook(&tx, "notebook_artifacts", notebook_id)?;
        let preserved_turns = count_table_for_notebook(&tx, "notebook_turns", notebook_id)?;
        let preserved_btw_threads =
            count_table_for_notebook(&tx, "notebook_btw_threads", notebook_id)?;

        {
            let mut upd = tx.prepare(
                "UPDATE notebooks SET updated_at_ms = ?2 WHERE notebook_id = ?1;",
            )?;
            upd.bind_text(1, notebook_id)?;
            upd.bind_int64(2, now_epoch_ms())?;
            upd.step()?;
        }

        tx.commit()?;
        Ok(ClearSourcesReceipt {
            notebook_id: notebook_id.to_string(),
            removed_sources,
            removed_chunks,
            preserved_artifacts,
            preserved_turns,
            preserved_btw_threads,
        })
    }

    /// List all chunks belonging to a single source ordered by `chunk_idx ASC`.
    pub fn list_chunks_for_source(
        &self,
        source_id: &str,
    ) -> Result<Vec<SourceChunkRecord>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT chunk_id, notebook_id, source_id, chunk_idx, heading, body,
                    token_count, byte_size, content_blake3
             FROM notebook_chunks
             WHERE source_id = ?1
             ORDER BY chunk_idx ASC;",
        )?;
        stmt.bind_text(1, source_id)?;
        let mut out = Vec::new();
        while stmt.step_row()? {
            out.push(read_chunk_row(&stmt)?);
        }
        Ok(out)
    }

    /// Fetch one exact chunk by `(notebook_id, source_id, chunk_idx)` for citation verification.
    pub fn get_chunk(
        &self,
        notebook_id: &str,
        source_id: &str,
        chunk_idx: usize,
    ) -> Result<Option<SourceChunkRecord>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT chunk_id, notebook_id, source_id, chunk_idx, heading, body,
                    token_count, byte_size, content_blake3
             FROM notebook_chunks
             WHERE notebook_id = ?1 AND source_id = ?2 AND chunk_idx = ?3;",
        )?;
        stmt.bind_text(1, notebook_id)?;
        stmt.bind_text(2, source_id)?;
        stmt.bind_int64(3, chunk_idx as i64)?;
        if stmt.step_row()? {
            return Ok(Some(read_chunk_row(&stmt)?));
        }
        Ok(None)
    }

    /// Deterministic multi-field **BM25F** search over `notebook_chunks` (with Vietnamese diacritic
    /// folding and bilingual token expansion via `omnia-harness`).
    ///
    /// Field weights: `title = 3.0`, `heading = 2.0`, `body = 1.0`, `k1 = 1.5`, `b = 0.75`.
    pub fn search_chunks_bm25f(
        &self,
        notebook_id: &str,
        query: &str,
        filter: &SourceFilter,
        limit: usize,
    ) -> Result<Vec<Bm25ChunkHit>, NotebookError> {
        let query_terms: Vec<String> = tokenize_folded(query).into_iter().collect();
        if query_terms.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }

        // Load eligible sources + chunks for this notebook.
        let sources = self.list_sources(notebook_id, filter)?;
        if sources.is_empty() {
            return Ok(Vec::new());
        }
        let source_map: HashMap<String, SourceRecord> = sources
            .into_iter()
            .map(|s| (s.source_id.clone(), s))
            .collect();

        let conn = self.conn.lock();
        // When SQLite FTS5 is available, pre-filter candidate chunk_ids via `notebook_chunks_fts`
        // so large notebooks avoid scanning and tokenizing irrelevant chunks on every query.
        let fts_candidates: Option<std::collections::HashSet<String>> = if self.fts5_enabled {
            let match_expr = build_fts5_or_query(&query_terms);
            if !match_expr.is_empty() {
                if let Ok(mut fts_stmt) = conn.prepare(
                    "SELECT chunk_id FROM notebook_chunks_fts
                     WHERE notebook_id = ?1 AND notebook_chunks_fts MATCH ?2
                     LIMIT 256;",
                ) {
                    let _ = fts_stmt.bind_text(1, notebook_id);
                    let _ = fts_stmt.bind_text(2, &match_expr);
                    let mut ids = std::collections::HashSet::new();
                    while let Ok(true) = fts_stmt.step_row() {
                        if let Ok(cid) = fts_stmt.column_text(0) {
                            ids.insert(cid);
                        }
                    }
                    (!ids.is_empty()).then_some(ids)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        let mut stmt = conn.prepare(
            "SELECT chunk_id, notebook_id, source_id, chunk_idx, heading, body,
                    body_folded, token_count, byte_size, content_blake3
             FROM notebook_chunks
             WHERE notebook_id = ?1
             ORDER BY source_id ASC, chunk_idx ASC;",
        )?;
        stmt.bind_text(1, notebook_id)?;

        struct DocStats {
            chunk: SourceChunkRecord,
            title_tf: HashMap<String, usize>,
            heading_tf: HashMap<String, usize>,
            body_tf: HashMap<String, usize>,
            title_len: f64,
            heading_len: f64,
            body_len: f64,
            source_title: String,
            source_provenance: String,
        }

        let mut docs = Vec::new();
        while stmt.step_row()? {
            let chunk_id = stmt.column_text(0)?;
            if let Some(ref allow) = fts_candidates {
                if !allow.contains(&chunk_id) {
                    continue;
                }
            }
            let source_id = stmt.column_text(2)?;
            let Some(src) = source_map.get(&source_id) else {
                continue;
            };
            let chunk = SourceChunkRecord {
                chunk_id,
                notebook_id: stmt.column_text(1)?,
                source_id: source_id.clone(),
                chunk_idx: stmt.column_int64(3)?.max(0) as usize,
                heading: stmt.column_text(4)?,
                body: stmt.column_text(5)?,
                token_count: stmt.column_int64(7)?.max(0) as usize,
                byte_size: stmt.column_int64(8)?.max(0) as usize,
                content_blake3: stmt.column_text(9)?,
            };
            let body_folded = stmt.column_text(6)?;
            let (title_tf, title_len) = term_frequencies(&fold_vietnamese_ascii(&src.title));
            let (heading_tf, heading_len) = term_frequencies(&fold_vietnamese_ascii(&chunk.heading));
            let (body_tf, body_len) = term_frequencies(&body_folded);
            docs.push(DocStats {
                chunk,
                title_tf,
                heading_tf,
                body_tf,
                title_len: title_len.max(1) as f64,
                heading_len: heading_len.max(1) as f64,
                body_len: body_len.max(1) as f64,
                source_title: src.title.clone(),
                source_provenance: src.provenance.clone(),
            });
        }
        drop(stmt);
        drop(conn);

        if docs.is_empty() {
            return Ok(Vec::new());
        }

        let n = docs.len() as f64;
        let avg_title = docs.iter().map(|d| d.title_len).sum::<f64>() / n;
        let avg_heading = docs.iter().map(|d| d.heading_len).sum::<f64>() / n;
        let avg_body = docs.iter().map(|d| d.body_len).sum::<f64>() / n;

        // Document frequency per query term across fields.
        let mut df: BTreeMap<&str, usize> = BTreeMap::new();
        for term in &query_terms {
            let count = docs
                .iter()
                .filter(|d| {
                    d.title_tf.contains_key(term)
                        || d.heading_tf.contains_key(term)
                        || d.body_tf.contains_key(term)
                })
                .count();
            df.insert(term.as_str(), count);
        }

        const K1: f64 = 1.5;
        const W_TITLE: f64 = 3.0;
        const W_HEADING: f64 = 2.0;
        const W_BODY: f64 = 1.0;
        const B_TITLE: f64 = 0.5;
        const B_HEADING: f64 = 0.6;
        const B_BODY: f64 = 0.75;

        let mut hits = Vec::new();
        for doc in docs {
            let mut score = 0.0_f64;
            let mut matched = Vec::new();

            for term in &query_terms {
                let tf_t = *doc.title_tf.get(term).unwrap_or(&0) as f64;
                let tf_h = *doc.heading_tf.get(term).unwrap_or(&0) as f64;
                let tf_b = *doc.body_tf.get(term).unwrap_or(&0) as f64;
                if tf_t == 0.0 && tf_h == 0.0 && tf_b == 0.0 {
                    continue;
                }
                matched.push(term.clone());
                let pseudo_tf = W_TITLE * (tf_t / (1.0 - B_TITLE + B_TITLE * (doc.title_len / avg_title)))
                    + W_HEADING
                        * (tf_h / (1.0 - B_HEADING + B_HEADING * (doc.heading_len / avg_heading)))
                    + W_BODY * (tf_b / (1.0 - B_BODY + B_BODY * (doc.body_len / avg_body)));
                let doc_freq = *df.get(term.as_str()).unwrap_or(&0) as f64;
                let idf = ((n - doc_freq + 0.5) / (doc_freq + 0.5) + 1.0).ln();
                score += idf * (pseudo_tf / (K1 + pseudo_tf));
            }

            if score > 0.0 {
                hits.push(Bm25ChunkHit {
                    chunk: doc.chunk,
                    source_title: doc.source_title,
                    source_provenance: doc.source_provenance,
                    bm25f_score: score,
                    matched_terms: matched,
                });
            }
        }

        hits.sort_by(|a, b| {
            b.bm25f_score
                .total_cmp(&a.bm25f_score)
                .then_with(|| a.chunk.source_id.cmp(&b.chunk.source_id))
                .then_with(|| a.chunk.chunk_idx.cmp(&b.chunk.chunk_idx))
        });
        hits.truncate(limit);
        Ok(hits)
    }

    /// Persist a main-surface turn into `notebook_turns`.
    pub fn insert_turn(&self, turn: &NotebookTurnRecord) -> Result<(), NotebookError> {
        let conn = self.conn.lock();
        let quotes_str = serde_json::to_string(&turn.quotes)?;
        let citations_str = serde_json::to_string(&turn.citations)?;
        let mut stmt = conn.prepare(
            "INSERT INTO notebook_turns (
                turn_id, notebook_id, turn_index, surface, role, prompt_text,
                response_markdown, model_id, effort_level, quotes_json, citations_json, created_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12);",
        )?;
        stmt.bind_text(1, &turn.turn_id)?;
        stmt.bind_text(2, &turn.notebook_id)?;
        stmt.bind_int64(3, turn.turn_index as i64)?;
        stmt.bind_text(4, &turn.surface)?;
        stmt.bind_text(5, &turn.role)?;
        stmt.bind_text(6, &turn.prompt_text)?;
        stmt.bind_text(7, &turn.response_markdown)?;
        stmt.bind_text(8, &turn.model_id)?;
        stmt.bind_text(9, &turn.effort_level)?;
        stmt.bind_text(10, &quotes_str)?;
        stmt.bind_text(11, &citations_str)?;
        stmt.bind_int64(12, turn.created_at_ms)?;
        stmt.step()?;
        Ok(())
    }

    /// List all main-surface turns for `notebook_id` ordered by `turn_index ASC`.
    pub fn list_turns(&self, notebook_id: &str) -> Result<Vec<NotebookTurnRecord>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT turn_id, notebook_id, turn_index, surface, role, prompt_text,
                    response_markdown, model_id, effort_level, quotes_json, citations_json, created_at_ms
             FROM notebook_turns
             WHERE notebook_id = ?1
             ORDER BY turn_index ASC, created_at_ms ASC;",
        )?;
        stmt.bind_text(1, notebook_id)?;
        let mut out = Vec::new();
        while stmt.step_row()? {
            let quotes: Vec<Value> = serde_json::from_str(&stmt.column_text(9)?)?;
            let citations: Vec<String> = serde_json::from_str(&stmt.column_text(10)?)?;
            out.push(NotebookTurnRecord {
                turn_id: stmt.column_text(0)?,
                notebook_id: stmt.column_text(1)?,
                turn_index: stmt.column_int64(2)?.max(0) as usize,
                surface: stmt.column_text(3)?,
                role: stmt.column_text(4)?,
                prompt_text: stmt.column_text(5)?,
                response_markdown: stmt.column_text(6)?,
                model_id: stmt.column_text(7)?,
                effort_level: stmt.column_text(8)?,
                quotes,
                citations,
                created_at_ms: stmt.column_int64(11)?,
            });
        }
        Ok(out)
    }

    /// Insert or update a Studio artifact row inside `notebook_artifacts`.
    pub fn upsert_artifact(&self, row: &StoredArtifactRow) -> Result<(), NotebookError> {
        let conn = self.conn.lock();
        let structured = serde_json::to_string(&row.structured_json)?;
        let cited = serde_json::to_string(&row.cited_source_ids)?;
        let mut stmt = conn.prepare(
            "INSERT INTO notebook_artifacts (
                artifact_id, notebook_id, kind, title, content_markdown,
                structured_json, cited_source_ids_json, created_at_ms, updated_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(artifact_id) DO UPDATE SET
                title = excluded.title,
                content_markdown = excluded.content_markdown,
                structured_json = excluded.structured_json,
                cited_source_ids_json = excluded.cited_source_ids_json,
                updated_at_ms = excluded.updated_at_ms;",
        )?;
        stmt.bind_text(1, &row.artifact_id)?;
        stmt.bind_text(2, &row.notebook_id)?;
        stmt.bind_text(3, &row.kind)?;
        stmt.bind_text(4, &row.title)?;
        stmt.bind_text(5, &row.content_markdown)?;
        stmt.bind_text(6, &structured)?;
        stmt.bind_text(7, &cited)?;
        stmt.bind_int64(8, row.created_at_ms)?;
        stmt.bind_int64(9, row.updated_at_ms)?;
        stmt.step()?;
        Ok(())
    }

    /// List Studio artifacts for `notebook_id`.
    pub fn list_artifacts(
        &self,
        notebook_id: &str,
    ) -> Result<Vec<StoredArtifactRow>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT artifact_id, notebook_id, kind, title, content_markdown,
                    structured_json, cited_source_ids_json, created_at_ms, updated_at_ms
             FROM notebook_artifacts
             WHERE notebook_id = ?1
             ORDER BY created_at_ms ASC, artifact_id ASC;",
        )?;
        stmt.bind_text(1, notebook_id)?;
        let mut out = Vec::new();
        while stmt.step_row()? {
            out.push(read_artifact_row(&stmt)?);
        }
        Ok(out)
    }

    /// Fetch a single Studio artifact by ID.
    pub fn get_artifact(
        &self,
        artifact_id: &str,
    ) -> Result<Option<StoredArtifactRow>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT artifact_id, notebook_id, kind, title, content_markdown,
                    structured_json, cited_source_ids_json, created_at_ms, updated_at_ms
             FROM notebook_artifacts WHERE artifact_id = ?1;",
        )?;
        stmt.bind_text(1, artifact_id)?;
        if stmt.step_row()? {
            return Ok(Some(read_artifact_row(&stmt)?));
        }
        Ok(None)
    }

    /// Rename a Studio artifact.
    pub fn rename_artifact(&self, artifact_id: &str, new_title: &str) -> Result<bool, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "UPDATE notebook_artifacts SET title = ?2, updated_at_ms = ?3 WHERE artifact_id = ?1;",
        )?;
        stmt.bind_text(1, artifact_id)?;
        stmt.bind_text(2, new_title)?;
        stmt.bind_int64(3, now_epoch_ms())?;
        stmt.step()?;
        Ok(conn.changes() > 0)
    }

    /// Delete a Studio artifact by ID.
    pub fn delete_artifact(&self, artifact_id: &str) -> Result<bool, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("DELETE FROM notebook_artifacts WHERE artifact_id = ?1;")?;
        stmt.bind_text(1, artifact_id)?;
        stmt.step()?;
        Ok(conn.changes() > 0)
    }

    /// Insert or update an isolated BTW side-thread row inside `notebook_btw_threads`.
    pub fn upsert_btw_thread(&self, row: &StoredBtwRow) -> Result<(), NotebookError> {
        let conn = self.conn.lock();
        let quote_str = serde_json::to_string(&row.anchor_quote_json)?;
        let msgs_str = serde_json::to_string(&row.messages_json)?;
        let mut stmt = conn.prepare(
            "INSERT INTO notebook_btw_threads (
                btw_id, notebook_id, anchor_turn_id, anchor_quote_json,
                status, promoted_source_id, messages_json, created_at_ms, updated_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(btw_id) DO UPDATE SET
                status = excluded.status,
                promoted_source_id = excluded.promoted_source_id,
                messages_json = excluded.messages_json,
                updated_at_ms = excluded.updated_at_ms;",
        )?;
        stmt.bind_text(1, &row.btw_id)?;
        stmt.bind_text(2, &row.notebook_id)?;
        stmt.bind_text(3, &row.anchor_turn_id)?;
        stmt.bind_text(4, &quote_str)?;
        stmt.bind_text(5, &row.status)?;
        stmt.bind_opt_text(6, row.promoted_source_id.as_deref())?;
        stmt.bind_text(7, &msgs_str)?;
        stmt.bind_int64(8, row.created_at_ms)?;
        stmt.bind_int64(9, row.updated_at_ms)?;
        stmt.step()?;
        Ok(())
    }

    /// Fetch a single BTW side-thread by `btw_id`.
    pub fn get_btw_thread(&self, btw_id: &str) -> Result<Option<StoredBtwRow>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT btw_id, notebook_id, anchor_turn_id, anchor_quote_json,
                    status, promoted_source_id, messages_json, created_at_ms, updated_at_ms
             FROM notebook_btw_threads WHERE btw_id = ?1;",
        )?;
        stmt.bind_text(1, btw_id)?;
        if stmt.step_row()? {
            return Ok(Some(read_btw_row(&stmt)?));
        }
        Ok(None)
    }

    /// List all BTW side-threads for a notebook.
    pub fn list_btw_threads(&self, notebook_id: &str) -> Result<Vec<StoredBtwRow>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT btw_id, notebook_id, anchor_turn_id, anchor_quote_json,
                    status, promoted_source_id, messages_json, created_at_ms, updated_at_ms
             FROM notebook_btw_threads
             WHERE notebook_id = ?1
             ORDER BY created_at_ms ASC, btw_id ASC;",
        )?;
        stmt.bind_text(1, notebook_id)?;
        let mut out = Vec::new();
        while stmt.step_row()? {
            out.push(read_btw_row(&stmt)?);
        }
        Ok(out)
    }

    /// Persist a bidirectional Cross-Bridge transfer audit record.
    pub fn insert_bridge_event(&self, row: &StoredBridgeRow) -> Result<(), NotebookError> {
        let conn = self.conn.lock();
        let payload_str = serde_json::to_string(&row.payload_json)?;
        let mut stmt = conn.prepare(
            "INSERT INTO notebook_bridge_events (
                event_id, notebook_id, direction, payload_json, target_source_id, created_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6);",
        )?;
        stmt.bind_text(1, &row.event_id)?;
        stmt.bind_text(2, &row.notebook_id)?;
        stmt.bind_text(3, &row.direction)?;
        stmt.bind_text(4, &payload_str)?;
        stmt.bind_opt_text(5, row.target_source_id.as_deref())?;
        stmt.bind_int64(6, row.created_at_ms)?;
        stmt.step()?;
        Ok(())
    }

    /// List Cross-Bridge audit records for a notebook.
    pub fn list_bridge_events(
        &self,
        notebook_id: &str,
    ) -> Result<Vec<StoredBridgeRow>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT event_id, notebook_id, direction, payload_json, target_source_id, created_at_ms
             FROM notebook_bridge_events
             WHERE notebook_id = ?1
             ORDER BY created_at_ms ASC, event_id ASC;",
        )?;
        stmt.bind_text(1, notebook_id)?;
        let mut out = Vec::new();
        while stmt.step_row()? {
            out.push(StoredBridgeRow {
                event_id: stmt.column_text(0)?,
                notebook_id: stmt.column_text(1)?,
                direction: stmt.column_text(2)?,
                payload_json: serde_json::from_str(&stmt.column_text(3)?)?,
                target_source_id: stmt.column_opt_text(4)?,
                created_at_ms: stmt.column_int64(5)?,
            });
        }
        Ok(out)
    }

    /// Delete one source inside `notebook_id` atomically while recording a tombstone so sync never resurrects it.
    pub fn delete_source_with_tombstone(
        &self,
        notebook_id: &str,
        source_id_or_remote: &str,
        reason: &str,
    ) -> Result<Option<SyncTombstoneRow>, NotebookError> {
        let mut conn = self.conn.lock();
        let tx = conn.begin_immediate()?;
        let found = {
            let mut sel = tx.prepare(
                "SELECT source_id, remote_id, content_sha256
                 FROM notebook_sources
                 WHERE notebook_id = ?1 AND (source_id = ?2 OR remote_id = ?2)
                 LIMIT 1;",
            )?;
            sel.bind_text(1, notebook_id)?;
            sel.bind_text(2, source_id_or_remote)?;
            if sel.step_row()? {
                Some((
                    sel.column_text(0)?,
                    sel.column_opt_text(1)?,
                    sel.column_text(2)?,
                ))
            } else {
                None
            }
        };
        let Some((sid, rid, sha)) = found else {
            return Ok(None);
        };

        if self.fts5_enabled {
            let mut fts = tx.prepare("DELETE FROM notebook_chunks_fts WHERE source_id = ?1;")?;
            fts.bind_text(1, &sid)?;
            fts.step()?;
        }
        {
            let mut del_chunks = tx.prepare("DELETE FROM notebook_chunks WHERE source_id = ?1;")?;
            del_chunks.bind_text(1, &sid)?;
            del_chunks.step()?;
        }
        {
            let mut del_src = tx.prepare("DELETE FROM notebook_sources WHERE source_id = ?1;")?;
            del_src.bind_text(1, &sid)?;
            del_src.step()?;
        }

        let tombstone_key = rid.clone().unwrap_or(sid);
        let now = now_epoch_ms();
        let tomb = SyncTombstoneRow {
            notebook_id: notebook_id.to_string(),
            tombstone_key,
            remote_id: rid,
            content_sha256: Some(sha),
            reason: reason.to_string(),
            deleted_at_ms: now,
        };
        {
            let mut ins = tx.prepare(
                "INSERT INTO notebook_sync_tombstones (
                    notebook_id, tombstone_key, remote_id, content_sha256, reason, deleted_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(notebook_id, tombstone_key) DO UPDATE SET
                    remote_id = COALESCE(excluded.remote_id, notebook_sync_tombstones.remote_id),
                    content_sha256 = COALESCE(excluded.content_sha256, notebook_sync_tombstones.content_sha256),
                    reason = excluded.reason,
                    deleted_at_ms = excluded.deleted_at_ms;",
            )?;
            ins.bind_text(1, &tomb.notebook_id)?;
            ins.bind_text(2, &tomb.tombstone_key)?;
            ins.bind_opt_text(3, tomb.remote_id.as_deref())?;
            ins.bind_opt_text(4, tomb.content_sha256.as_deref())?;
            ins.bind_text(5, &tomb.reason)?;
            ins.bind_int64(6, tomb.deleted_at_ms)?;
            ins.step()?;
        }
        tx.commit()?;
        Ok(Some(tomb))
    }

    /// Persist or update an explicit sync tombstone.
    pub fn record_tombstone(&self, row: &SyncTombstoneRow) -> Result<(), NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "INSERT INTO notebook_sync_tombstones (
                notebook_id, tombstone_key, remote_id, content_sha256, reason, deleted_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(notebook_id, tombstone_key) DO UPDATE SET
                remote_id = COALESCE(excluded.remote_id, notebook_sync_tombstones.remote_id),
                content_sha256 = COALESCE(excluded.content_sha256, notebook_sync_tombstones.content_sha256),
                reason = excluded.reason,
                deleted_at_ms = excluded.deleted_at_ms;",
        )?;
        stmt.bind_text(1, &row.notebook_id)?;
        stmt.bind_text(2, &row.tombstone_key)?;
        stmt.bind_opt_text(3, row.remote_id.as_deref())?;
        stmt.bind_opt_text(4, row.content_sha256.as_deref())?;
        stmt.bind_text(5, &row.reason)?;
        stmt.bind_int64(6, row.deleted_at_ms)?;
        stmt.step()?;
        Ok(())
    }

    /// List all active sync tombstones for `notebook_id`.
    pub fn list_tombstones(
        &self,
        notebook_id: &str,
    ) -> Result<Vec<SyncTombstoneRow>, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT notebook_id, tombstone_key, remote_id, content_sha256, reason, deleted_at_ms
             FROM notebook_sync_tombstones
             WHERE notebook_id = ?1
             ORDER BY deleted_at_ms DESC, tombstone_key ASC;",
        )?;
        stmt.bind_text(1, notebook_id)?;
        let mut out = Vec::new();
        while stmt.step_row()? {
            out.push(SyncTombstoneRow {
                notebook_id: stmt.column_text(0)?,
                tombstone_key: stmt.column_text(1)?,
                remote_id: stmt.column_opt_text(2)?,
                content_sha256: stmt.column_opt_text(3)?,
                reason: stmt.column_text(4)?,
                deleted_at_ms: stmt.column_int64(5)?,
            });
        }
        Ok(out)
    }

    /// Remove a specific tombstone key (when user intentionally re-imports a previously deleted source).
    pub fn clear_tombstone(
        &self,
        notebook_id: &str,
        tombstone_key: &str,
    ) -> Result<bool, NotebookError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "DELETE FROM notebook_sync_tombstones WHERE notebook_id = ?1 AND tombstone_key = ?2;",
        )?;
        stmt.bind_text(1, notebook_id)?;
        stmt.bind_text(2, tombstone_key)?;
        stmt.step()?;
        Ok(conn.changes() > 0)
    }
}

fn bootstrap_schema(conn: &Connection) -> Result<bool, NotebookError> {
    conn.exec_batch(NOTEBOOK_SCHEMA_SQL)?;
    let fts5_enabled = conn.exec_batch(NOTEBOOK_FTS5_SQL).is_ok();
    Ok(fts5_enabled)
}

fn insert_chunks_in_tx(
    conn: &Connection,
    fts5_enabled: bool,
    source_title: &str,
    chunks: &[SourceChunkRecord],
) -> Result<(), NotebookError> {
    let mut stmt = conn.prepare(
        "INSERT INTO notebook_chunks (
            chunk_id, notebook_id, source_id, chunk_idx, heading, body,
            body_folded, token_count, byte_size, content_blake3
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
    )?;
    let mut fts_stmt = if fts5_enabled {
        Some(conn.prepare(
            "INSERT INTO notebook_chunks_fts (
                chunk_id, notebook_id, source_id, title, heading, body_folded
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6);",
        )?)
    } else {
        None
    };

    let folded_title = fold_vietnamese_ascii(source_title);
    for chunk in chunks {
        let folded_body = fold_vietnamese_ascii(&chunk.body);
        stmt.reset()?;
        stmt.clear_bindings()?;
        stmt.bind_text(1, &chunk.chunk_id)?;
        stmt.bind_text(2, &chunk.notebook_id)?;
        stmt.bind_text(3, &chunk.source_id)?;
        stmt.bind_int64(4, chunk.chunk_idx as i64)?;
        stmt.bind_text(5, &chunk.heading)?;
        stmt.bind_text(6, &chunk.body)?;
        stmt.bind_text(7, &folded_body)?;
        stmt.bind_int64(8, chunk.token_count as i64)?;
        stmt.bind_int64(9, chunk.byte_size as i64)?;
        stmt.bind_text(10, &chunk.content_blake3)?;
        stmt.step()?;

        if let Some(fts) = fts_stmt.as_mut() {
            fts.reset()?;
            fts.clear_bindings()?;
            fts.bind_text(1, &chunk.chunk_id)?;
            fts.bind_text(2, &chunk.notebook_id)?;
            fts.bind_text(3, &chunk.source_id)?;
            fts.bind_text(4, &folded_title)?;
            fts.bind_text(5, &fold_vietnamese_ascii(&chunk.heading))?;
            fts.bind_text(6, &folded_body)?;
            fts.step()?;
        }
    }
    Ok(())
}

fn count_table_for_notebook(
    conn: &Connection,
    table: &str,
    notebook_id: &str,
) -> Result<usize, NotebookError> {
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE notebook_id = ?1;");
    let mut stmt = conn.prepare(&sql)?;
    stmt.bind_text(1, notebook_id)?;
    if stmt.step_row()? {
        return Ok(stmt.column_int64(0)?.max(0) as usize);
    }
    Ok(0)
}

fn read_source_row(stmt: &omnia_winsqlite::Statement<'_>) -> Result<SourceRecord, NotebookError> {
    let kind_str = stmt.column_text(6)?;
    let source_kind = SourceKind::from_str_lossy(&kind_str);
    let metadata: Value = serde_json::from_str(&stmt.column_text(14)?)?;
    Ok(SourceRecord {
        source_id: stmt.column_text(0)?,
        notebook_id: stmt.column_text(1)?,
        remote_id: stmt.column_opt_text(2)?,
        title: stmt.column_text(3)?,
        safe_filename: stmt.column_text(4)?,
        mime_type: stmt.column_text(5)?,
        source_kind,
        is_video: stmt.column_int64(7)? != 0,
        content_sha256: stmt.column_text(8)?,
        content_blake3: stmt.column_text(9)?,
        byte_size: stmt.column_int64(10)?.max(0) as u64,
        chunk_count: stmt.column_int64(11)?.max(0) as usize,
        ingestion_stage: stmt.column_text(12)?,
        provenance: stmt.column_text(13)?,
        metadata,
        created_at_ms: stmt.column_int64(15)?,
    })
}

fn read_chunk_row(
    stmt: &omnia_winsqlite::Statement<'_>,
) -> Result<SourceChunkRecord, NotebookError> {
    Ok(SourceChunkRecord {
        chunk_id: stmt.column_text(0)?,
        notebook_id: stmt.column_text(1)?,
        source_id: stmt.column_text(2)?,
        chunk_idx: stmt.column_int64(3)?.max(0) as usize,
        heading: stmt.column_text(4)?,
        body: stmt.column_text(5)?,
        token_count: stmt.column_int64(6)?.max(0) as usize,
        byte_size: stmt.column_int64(7)?.max(0) as usize,
        content_blake3: stmt.column_text(8)?,
    })
}

fn read_artifact_row(
    stmt: &omnia_winsqlite::Statement<'_>,
) -> Result<StoredArtifactRow, NotebookError> {
    Ok(StoredArtifactRow {
        artifact_id: stmt.column_text(0)?,
        notebook_id: stmt.column_text(1)?,
        kind: stmt.column_text(2)?,
        title: stmt.column_text(3)?,
        content_markdown: stmt.column_text(4)?,
        structured_json: serde_json::from_str(&stmt.column_text(5)?)?,
        cited_source_ids: serde_json::from_str(&stmt.column_text(6)?)?,
        created_at_ms: stmt.column_int64(7)?,
        updated_at_ms: stmt.column_int64(8)?,
    })
}

fn read_btw_row(stmt: &omnia_winsqlite::Statement<'_>) -> Result<StoredBtwRow, NotebookError> {
    Ok(StoredBtwRow {
        btw_id: stmt.column_text(0)?,
        notebook_id: stmt.column_text(1)?,
        anchor_turn_id: stmt.column_text(2)?,
        anchor_quote_json: serde_json::from_str(&stmt.column_text(3)?)?,
        status: stmt.column_text(4)?,
        promoted_source_id: stmt.column_opt_text(5)?,
        messages_json: serde_json::from_str(&stmt.column_text(6)?)?,
        created_at_ms: stmt.column_int64(7)?,
        updated_at_ms: stmt.column_int64(8)?,
    })
}

fn build_fts5_or_query(terms: &[String]) -> String {
    terms
        .iter()
        .filter_map(|t| {
            let clean: String = t
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            (clean.len() >= 2).then(|| format!("\"{clean}\""))
        })
        .take(24)
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn term_frequencies(folded_text: &str) -> (HashMap<String, usize>, usize) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut total = 0usize;
    let mut cur = String::new();
    for ch in folded_text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            cur.push(ch);
        } else if !cur.is_empty() {
            if cur.len() >= 2 {
                *counts.entry(std::mem::take(&mut cur)).or_insert(0) += 1;
                total += 1;
            } else {
                cur.clear();
            }
        }
    }
    if cur.len() >= 2 {
        *counts.entry(cur).or_insert(0) += 1;
        total += 1;
    }
    (counts, total)
}

/// Default source quota constant re-exported for store defaults.
#[must_use]
pub const fn default_max_sources() -> usize {
    DEFAULT_MAX_SOURCES_PER_NOTEBOOK
}
