//! Persistent `omnia-winsqlite` WAL tables and typed query helpers for Omnia SOTA v4
//! agent infrastructure:
//! - `merkle_ast_cache`: BLAKE3-keyed incremental file & Tree-sitter AST symbol cache
//! - `ace_playbook`: Adaptive Context Engineering playbook for shell, edit, and patch errors
//! - `wire_telemetry`: Honest dual-TPS (`active_decode_tps`, `e2e_tps`) and KV-cache metrics

use std::fs;
use std::path::Path;
use std::sync::Mutex;

use omnia_core::SecretRedactor;
use omnia_winsqlite::{Connection, StepStatus};

use crate::error::StoreError;

/// SQLite WAL DDL for `merkle_ast_cache`, `ace_playbook`, and `wire_telemetry`.
pub const AGENT_CACHE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS merkle_ast_cache (
    path TEXT PRIMARY KEY,
    blake3_hex TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    language TEXT NOT NULL,
    ast_symbols_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merkle_ast_cache_blake3
    ON merkle_ast_cache (blake3_hex);

CREATE TABLE IF NOT EXISTS ace_playbook (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    error_fingerprint TEXT NOT NULL,
    symptom TEXT NOT NULL,
    remediation TEXT NOT NULL,
    success_count INTEGER NOT NULL DEFAULT 1,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_used_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ace_playbook_scope_fp
    ON ace_playbook (scope, error_fingerprint);

CREATE INDEX IF NOT EXISTS idx_ace_playbook_rank
    ON ace_playbook (success_count DESC, last_used_at_ms DESC);

CREATE TABLE IF NOT EXISTS wire_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    wire_dialect TEXT NOT NULL,
    ttft_ms REAL NOT NULL,
    active_decode_ms REAL NOT NULL,
    total_turn_ms REAL NOT NULL,
    active_decode_tps REAL NOT NULL,
    e2e_tps REAL NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    retries INTEGER NOT NULL,
    burst_flush INTEGER NOT NULL DEFAULT 0,
    finish_reason TEXT,
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wire_telemetry_session_turn
    ON wire_telemetry (session_id, turn_index ASC);
"#;

/// Cached file hash + extracted AST symbol payload persisted in `merkle_ast_cache`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MerkleAstCacheEntry {
    pub path: String,
    pub blake3_hex: String,
    pub size_bytes: i64,
    pub mtime_ms: i64,
    pub language: String,
    pub ast_symbols_json: String,
    pub updated_at_ms: i64,
}

/// Adaptive Context Engineering playbook record for shell/edit/patch error remediation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcePlaybookEntry {
    pub id: String,
    pub scope: String,
    pub error_fingerprint: String,
    pub symptom: String,
    pub remediation: String,
    pub success_count: i64,
    pub failure_count: i64,
    pub last_used_at_ms: i64,
    pub created_at_ms: i64,
}

/// Honest per-turn wire-level LLM telemetry record persisted in `wire_telemetry`.
#[derive(Debug, Clone, PartialEq)]
pub struct WireTelemetryRecord {
    pub id: Option<i64>,
    pub session_id: String,
    pub turn_index: i64,
    pub provider_id: String,
    pub model_id: String,
    pub wire_dialect: String,
    pub ttft_ms: f64,
    pub active_decode_ms: f64,
    pub total_turn_ms: f64,
    pub active_decode_tps: f64,
    pub e2e_tps: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub retries: i64,
    pub burst_flush: bool,
    pub finish_reason: Option<String>,
    pub created_at_ms: i64,
}

/// Aggregate session/global wire telemetry summary.
#[derive(Debug, Clone, PartialEq)]
pub struct WireTelemetrySummary {
    pub total_turns: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_reasoning_tokens: i64,
    pub total_cache_read_tokens: i64,
    pub total_cache_write_tokens: i64,
    pub total_retries: i64,
    pub burst_flush_turns: i64,
    pub cache_hit_pct: f64,
    pub mean_ttft_ms: f64,
    pub mean_active_decode_tps: f64,
    pub mean_e2e_tps: f64,
}

/// Thread-safe `omnia-winsqlite` WAL store managing `merkle_ast_cache`, `ace_playbook`,
/// and `wire_telemetry`.
pub struct AgentCacheStore {
    conn: Mutex<Connection>,
}

impl AgentCacheStore {
    /// Applies the SOTA v4 agent cache schema to an existing `omnia-winsqlite` connection.
    pub fn ensure_schema(conn: &Connection) -> Result<(), StoreError> {
        conn.exec_batch(AGENT_CACHE_SCHEMA_SQL)?;
        Ok(())
    }

    /// Opens or creates a WAL-backed `AgentCacheStore` at `db_path`.
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = db_path.as_ref();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|err| {
                    StoreError::storage_failed(format!(
                        "Failed to create cache store directory '{}': {err}",
                        parent.display()
                    ))
                })?;
            }
        }
        let conn = Connection::open_read_write(path)?;
        Self::ensure_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Opens an ephemeral in-memory `AgentCacheStore` (ideal for tests and isolated evals).
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        Self::ensure_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, StoreError> {
        self.conn
            .lock()
            .map_err(|_| StoreError::storage_failed("AgentCacheStore mutex poisoned."))
    }

    /// Inserts or updates a BLAKE3 Merkle + AST symbol cache row.
    pub fn upsert_merkle_ast(&self, entry: &MerkleAstCacheEntry) -> Result<(), StoreError> {
        if entry.path.trim().is_empty() || entry.blake3_hex.trim().is_empty() {
            return Err(StoreError::invalid_input(
                "merkle_ast_cache path and blake3_hex must be non-empty.",
            ));
        }
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "INSERT INTO merkle_ast_cache \
             (path, blake3_hex, size_bytes, mtime_ms, language, ast_symbols_json, updated_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(path) DO UPDATE SET \
                 blake3_hex = excluded.blake3_hex, \
                 size_bytes = excluded.size_bytes, \
                 mtime_ms = excluded.mtime_ms, \
                 language = excluded.language, \
                 ast_symbols_json = excluded.ast_symbols_json, \
                 updated_at_ms = excluded.updated_at_ms;",
        )?;
        stmt.bind_text(1, &entry.path)?;
        stmt.bind_text(2, &entry.blake3_hex)?;
        stmt.bind_int64(3, entry.size_bytes)?;
        stmt.bind_int64(4, entry.mtime_ms)?;
        stmt.bind_text(5, &entry.language)?;
        stmt.bind_text(6, &entry.ast_symbols_json)?;
        stmt.bind_int64(7, entry.updated_at_ms)?;
        stmt.step()?;
        Ok(())
    }

    /// Looks up a single cached file entry by workspace-relative path.
    pub fn get_merkle_ast(&self, path: &str) -> Result<Option<MerkleAstCacheEntry>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT path, blake3_hex, size_bytes, mtime_ms, language, ast_symbols_json, updated_at_ms \
             FROM merkle_ast_cache WHERE path = ?1;",
        )?;
        stmt.bind_text(1, path)?;
        if stmt.step()? == StepStatus::Row {
            Ok(Some(MerkleAstCacheEntry {
                path: stmt.column_text(0)?,
                blake3_hex: stmt.column_text(1)?,
                size_bytes: stmt.column_int64(2)?,
                mtime_ms: stmt.column_int64(3)?,
                language: stmt.column_text(4)?,
                ast_symbols_json: stmt.column_text(5)?,
                updated_at_ms: stmt.column_int64(6)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// Deletes a single cached file entry by path, returning `true` if removed.
    pub fn delete_merkle_ast(&self, path: &str) -> Result<bool, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare("DELETE FROM merkle_ast_cache WHERE path = ?1;")?;
        stmt.bind_text(1, path)?;
        stmt.step()?;
        Ok(conn.changes() > 0)
    }

    /// Lists all cached workspace-relative paths ordered lexicographically.
    pub fn list_merkle_paths(&self) -> Result<Vec<String>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare("SELECT path FROM merkle_ast_cache ORDER BY path ASC;")?;
        let mut out = Vec::new();
        while stmt.step()? == StepStatus::Row {
            out.push(stmt.column_text(0)?);
        }
        Ok(out)
    }

    /// Records or reinforces an ACE Playbook lesson (automatically redacting secrets).
    #[allow(clippy::too_many_arguments)]
    pub fn record_playbook_entry(
        &self,
        id: &str,
        scope: &str,
        error_fingerprint: &str,
        symptom: &str,
        remediation: &str,
        succeeded: bool,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        if id.trim().is_empty() || scope.trim().is_empty() || error_fingerprint.trim().is_empty() {
            return Err(StoreError::invalid_input(
                "ace_playbook id, scope, and error_fingerprint must be non-empty.",
            ));
        }
        let clean_symptom = SecretRedactor::redact(symptom);
        let clean_remediation = SecretRedactor::redact(remediation);
        let init_succ = if succeeded { 1 } else { 0 };
        let init_fail = if succeeded { 0 } else { 1 };
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "INSERT INTO ace_playbook \
             (id, scope, error_fingerprint, symptom, remediation, success_count, failure_count, last_used_at_ms, created_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8) \
             ON CONFLICT(id) DO UPDATE SET \
                 symptom = excluded.symptom, \
                 remediation = excluded.remediation, \
                 success_count = ace_playbook.success_count + excluded.success_count, \
                 failure_count = ace_playbook.failure_count + excluded.failure_count, \
                 last_used_at_ms = excluded.last_used_at_ms;",
        )?;
        stmt.bind_text(1, id)?;
        stmt.bind_text(2, scope)?;
        stmt.bind_text(3, error_fingerprint)?;
        stmt.bind_text(4, &clean_symptom)?;
        stmt.bind_text(5, &clean_remediation)?;
        stmt.bind_int64(6, init_succ)?;
        stmt.bind_int64(7, init_fail)?;
        stmt.bind_int64(8, now_ms)?;
        stmt.step()?;
        Ok(())
    }

    /// Queries ranked ACE Playbook lessons matching `scope` and `error_fingerprint`.
    pub fn lookup_playbook_by_fingerprint(
        &self,
        scope: &str,
        error_fingerprint: &str,
        limit: usize,
    ) -> Result<Vec<AcePlaybookEntry>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, scope, error_fingerprint, symptom, remediation, success_count, failure_count, last_used_at_ms, created_at_ms \
             FROM ace_playbook \
             WHERE scope = ?1 AND error_fingerprint = ?2 \
             ORDER BY success_count DESC, last_used_at_ms DESC \
             LIMIT ?3;",
        )?;
        stmt.bind_text(1, scope)?;
        stmt.bind_text(2, error_fingerprint)?;
        stmt.bind_int64(3, i64::try_from(limit.max(1)).unwrap_or(10))?;
        let mut out = Vec::new();
        while stmt.step()? == StepStatus::Row {
            out.push(AcePlaybookEntry {
                id: stmt.column_text(0)?,
                scope: stmt.column_text(1)?,
                error_fingerprint: stmt.column_text(2)?,
                symptom: stmt.column_text(3)?,
                remediation: stmt.column_text(4)?,
                success_count: stmt.column_int64(5)?,
                failure_count: stmt.column_int64(6)?,
                last_used_at_ms: stmt.column_int64(7)?,
                created_at_ms: stmt.column_int64(8)?,
            });
        }
        Ok(out)
    }

    /// Lists top-ranked ACE Playbook lessons across all scopes (or a single scope if specified).
    pub fn list_top_playbook_entries(
        &self,
        scope: Option<&str>,
        limit: usize,
    ) -> Result<Vec<AcePlaybookEntry>, StoreError> {
        let conn = self.lock_conn()?;
        let lim = i64::try_from(limit.max(1)).unwrap_or(20);
        let mut out = Vec::new();
        if let Some(sc) = scope {
            let mut stmt = conn.prepare(
                "SELECT id, scope, error_fingerprint, symptom, remediation, success_count, failure_count, last_used_at_ms, created_at_ms \
                 FROM ace_playbook WHERE scope = ?1 \
                 ORDER BY success_count DESC, last_used_at_ms DESC LIMIT ?2;",
            )?;
            stmt.bind_text(1, sc)?;
            stmt.bind_int64(2, lim)?;
            while stmt.step()? == StepStatus::Row {
                out.push(read_playbook_row(&stmt)?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, scope, error_fingerprint, symptom, remediation, success_count, failure_count, last_used_at_ms, created_at_ms \
                 FROM ace_playbook \
                 ORDER BY success_count DESC, last_used_at_ms DESC LIMIT ?1;",
            )?;
            stmt.bind_int64(1, lim)?;
            while stmt.step()? == StepStatus::Row {
                out.push(read_playbook_row(&stmt)?);
            }
        }
        Ok(out)
    }

    /// Appends one turn's honest dual-TPS & KV-cache wire telemetry record.
    pub fn record_wire_telemetry(&self, rec: &WireTelemetryRecord) -> Result<i64, StoreError> {
        if rec.session_id.trim().is_empty() {
            return Err(StoreError::invalid_input(
                "wire_telemetry session_id must be non-empty.",
            ));
        }
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "INSERT INTO wire_telemetry \
             (session_id, turn_index, provider_id, model_id, wire_dialect, ttft_ms, active_decode_ms, \
              total_turn_ms, active_decode_tps, e2e_tps, input_tokens, output_tokens, reasoning_tokens, \
              cache_read_tokens, cache_write_tokens, retries, burst_flush, finish_reason, created_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19);",
        )?;
        stmt.bind_text(1, &rec.session_id)?;
        stmt.bind_int64(2, rec.turn_index)?;
        stmt.bind_text(3, &rec.provider_id)?;
        stmt.bind_text(4, &rec.model_id)?;
        stmt.bind_text(5, &rec.wire_dialect)?;
        stmt.bind_double(6, rec.ttft_ms)?;
        stmt.bind_double(7, rec.active_decode_ms)?;
        stmt.bind_double(8, rec.total_turn_ms)?;
        stmt.bind_double(9, rec.active_decode_tps)?;
        stmt.bind_double(10, rec.e2e_tps)?;
        stmt.bind_int64(11, rec.input_tokens)?;
        stmt.bind_int64(12, rec.output_tokens)?;
        stmt.bind_int64(13, rec.reasoning_tokens)?;
        stmt.bind_int64(14, rec.cache_read_tokens)?;
        stmt.bind_int64(15, rec.cache_write_tokens)?;
        stmt.bind_int64(16, rec.retries)?;
        stmt.bind_int64(17, if rec.burst_flush { 1 } else { 0 })?;
        stmt.bind_opt_text(18, rec.finish_reason.as_deref())?;
        stmt.bind_int64(19, rec.created_at_ms)?;
        stmt.step()?;
        Ok(conn.last_insert_rowid())
    }

    /// Lists all persisted wire telemetry turns for `session_id` in turn order.
    pub fn list_wire_telemetry_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<WireTelemetryRecord>, StoreError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, turn_index, provider_id, model_id, wire_dialect, ttft_ms, \
                    active_decode_ms, total_turn_ms, active_decode_tps, e2e_tps, input_tokens, \
                    output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, \
                    retries, burst_flush, finish_reason, created_at_ms \
             FROM wire_telemetry WHERE session_id = ?1 ORDER BY turn_index ASC, id ASC;",
        )?;
        stmt.bind_text(1, session_id)?;
        let mut out = Vec::new();
        while stmt.step()? == StepStatus::Row {
            out.push(WireTelemetryRecord {
                id: Some(stmt.column_int64(0)?),
                session_id: stmt.column_text(1)?,
                turn_index: stmt.column_int64(2)?,
                provider_id: stmt.column_text(3)?,
                model_id: stmt.column_text(4)?,
                wire_dialect: stmt.column_text(5)?,
                ttft_ms: stmt.column_double(6)?,
                active_decode_ms: stmt.column_double(7)?,
                total_turn_ms: stmt.column_double(8)?,
                active_decode_tps: stmt.column_double(9)?,
                e2e_tps: stmt.column_double(10)?,
                input_tokens: stmt.column_int64(11)?,
                output_tokens: stmt.column_int64(12)?,
                reasoning_tokens: stmt.column_int64(13)?,
                cache_read_tokens: stmt.column_int64(14)?,
                cache_write_tokens: stmt.column_int64(15)?,
                retries: stmt.column_int64(16)?,
                burst_flush: stmt.column_int64(17)? != 0,
                finish_reason: stmt.column_opt_text(18)?,
                created_at_ms: stmt.column_int64(19)?,
            });
        }
        Ok(out)
    }

    /// Computes canonical KV-cache hit rate and dual-TPS summary for `session_id` (or globally if `None`).
    pub fn summarize_wire_telemetry(
        &self,
        session_id: Option<&str>,
    ) -> Result<WireTelemetrySummary, StoreError> {
        let conn = self.lock_conn()?;
        let sql = if session_id.is_some() {
            "SELECT COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), \
                    COALESCE(SUM(reasoning_tokens), 0), COALESCE(SUM(cache_read_tokens), 0), \
                    COALESCE(SUM(cache_write_tokens), 0), COALESCE(SUM(retries), 0), \
                    COALESCE(SUM(burst_flush), 0), COALESCE(AVG(ttft_ms), 0.0), \
                    COALESCE(AVG(active_decode_tps), 0.0), COALESCE(AVG(e2e_tps), 0.0) \
             FROM wire_telemetry WHERE session_id = ?1;"
        } else {
            "SELECT COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), \
                    COALESCE(SUM(reasoning_tokens), 0), COALESCE(SUM(cache_read_tokens), 0), \
                    COALESCE(SUM(cache_write_tokens), 0), COALESCE(SUM(retries), 0), \
                    COALESCE(SUM(burst_flush), 0), COALESCE(AVG(ttft_ms), 0.0), \
                    COALESCE(AVG(active_decode_tps), 0.0), COALESCE(AVG(e2e_tps), 0.0) \
             FROM wire_telemetry;"
        };
        let mut stmt = conn.prepare(sql)?;
        if let Some(sid) = session_id {
            stmt.bind_text(1, sid)?;
        }
        if stmt.step()? == StepStatus::Row {
            let total_turns = stmt.column_int64(0)?;
            let total_input_tokens = stmt.column_int64(1)?;
            let total_output_tokens = stmt.column_int64(2)?;
            let total_reasoning_tokens = stmt.column_int64(3)?;
            let total_cache_read_tokens = stmt.column_int64(4)?;
            let total_cache_write_tokens = stmt.column_int64(5)?;
            let total_retries = stmt.column_int64(6)?;
            let burst_flush_turns = stmt.column_int64(7)?;
            let mean_ttft_ms = stmt.column_double(8)?;
            let mean_active_decode_tps = stmt.column_double(9)?;
            let mean_e2e_tps = stmt.column_double(10)?;
            let prompt_denom =
                total_input_tokens.saturating_add(total_cache_read_tokens).saturating_add(total_cache_write_tokens);
            let cache_hit_pct = if prompt_denom > 0 {
                (total_cache_read_tokens as f64 / prompt_denom as f64) * 100.0
            } else {
                0.0
            };
            return Ok(WireTelemetrySummary {
                total_turns,
                total_input_tokens,
                total_output_tokens,
                total_reasoning_tokens,
                total_cache_read_tokens,
                total_cache_write_tokens,
                total_retries,
                burst_flush_turns,
                cache_hit_pct,
                mean_ttft_ms,
                mean_active_decode_tps,
                mean_e2e_tps,
            });
        }
        Ok(WireTelemetrySummary {
            total_turns: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_reasoning_tokens: 0,
            total_cache_read_tokens: 0,
            total_cache_write_tokens: 0,
            total_retries: 0,
            burst_flush_turns: 0,
            cache_hit_pct: 0.0,
            mean_ttft_ms: 0.0,
            mean_active_decode_tps: 0.0,
            mean_e2e_tps: 0.0,
        })
    }
}

fn read_playbook_row(stmt: &omnia_winsqlite::Statement<'_>) -> Result<AcePlaybookEntry, StoreError> {
    Ok(AcePlaybookEntry {
        id: stmt.column_text(0)?,
        scope: stmt.column_text(1)?,
        error_fingerprint: stmt.column_text(2)?,
        symptom: stmt.column_text(3)?,
        remediation: stmt.column_text(4)?,
        success_count: stmt.column_int64(5)?,
        failure_count: stmt.column_int64(6)?,
        last_used_at_ms: stmt.column_int64(7)?,
        created_at_ms: stmt.column_int64(8)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merkle_playbook_and_wire_telemetry_roundtrip() {
        let store = AgentCacheStore::open_in_memory().expect("open memory cache store");

        // 1. merkle_ast_cache
        let entry = MerkleAstCacheEntry {
            path: "src/engine.rs".to_owned(),
            blake3_hex: "a".repeat(64),
            size_bytes: 4096,
            mtime_ms: 1_700_000_000_000,
            language: "rust".to_owned(),
            ast_symbols_json: r#"[{"name":"run_turn","line":12}]"#.to_owned(),
            updated_at_ms: 1_700_000_000_500,
        };
        store.upsert_merkle_ast(&entry).expect("upsert merkle");
        let loaded = store
            .get_merkle_ast("src/engine.rs")
            .expect("get merkle")
            .expect("merkle row exists");
        assert_eq!(loaded, entry);
        assert_eq!(
            store.list_merkle_paths().expect("list paths"),
            vec!["src/engine.rs".to_owned()]
        );
        assert!(store.delete_merkle_ast("src/engine.rs").expect("delete"));
        assert!(store
            .get_merkle_ast("src/engine.rs")
            .expect("get deleted")
            .is_none());

        // 2. ace_playbook (with secret redaction & rank reinforcement)
        store
            .record_playbook_entry(
                "pb-edit-hash",
                "edit",
                "hashline_mismatch",
                "Anchor mismatch while editing auth Bearer dummy-token-99999999",
                "Re-read latest line range before splicing anchors",
                true,
                2_000,
            )
            .expect("record playbook 1");
        store
            .record_playbook_entry(
                "pb-edit-hash",
                "edit",
                "hashline_mismatch",
                "Anchor mismatch after concurrent edit",
                "Re-read latest line range before splicing anchors",
                true,
                3_000,
            )
            .expect("record playbook 2");
        let matches = store
            .lookup_playbook_by_fingerprint("edit", "hashline_mismatch", 5)
            .expect("lookup playbook");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].success_count, 2);
        assert_eq!(matches[0].failure_count, 0);
        assert!(!matches[0].symptom.contains("dummy-token-99999999"));

        // 3. wire_telemetry (honest dual TPS + canonical KV cache hit pct)
        let row_id = store
            .record_wire_telemetry(&WireTelemetryRecord {
                id: None,
                session_id: "sess-1".to_owned(),
                turn_index: 1,
                provider_id: "htmustc".to_owned(),
                model_id: "claude-sonnet-5-5".to_owned(),
                wire_dialect: "anthropic_messages".to_owned(),
                ttft_ms: 820.0,
                active_decode_ms: 1_500.0,
                total_turn_ms: 2_320.0,
                active_decode_tps: 96.0,
                e2e_tps: 62.0,
                input_tokens: 1_000,
                output_tokens: 144,
                reasoning_tokens: 200,
                cache_read_tokens: 9_000,
                cache_write_tokens: 0,
                retries: 0,
                burst_flush: false,
                finish_reason: Some("end_turn".to_owned()),
                created_at_ms: 4_000,
            })
            .expect("record telemetry");
        assert!(row_id > 0);
        let rows = store
            .list_wire_telemetry_for_session("sess-1")
            .expect("list telemetry");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].active_decode_tps, 96.0);
        assert_eq!(rows[0].e2e_tps, 62.0);
        let summary = store
            .summarize_wire_telemetry(Some("sess-1"))
            .expect("summarize telemetry");
        assert_eq!(summary.total_turns, 1);
        assert_eq!(summary.total_cache_read_tokens, 9_000);
        assert!((summary.cache_hit_pct - 90.0).abs() < 0.01);
    }
}
