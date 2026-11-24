//! Pure `omnia-winsqlite` WAL persistent backing store for `omnia-agent`.
//!
//! Replaces legacy `rusqlite` dependencies with Windows built-in `winsqlite3` via
//! `omnia-winsqlite` (`Connection`, RAII `Statement`, `Transaction`).
//! Persists:
//! - `merkle_cache`: dirty-path BLAKE3 file snapshots per workspace
//! - `ast_symbol_cache`: content-addressable `ParsedFileAst` JSON by BLAKE3 hex
//! - `checkpoint_blobs`: deflate-compressed CoW blobs (20 MiB LRU cap)
//! - `turn_checkpoints`: per-session turn rollback manifests
//! - `workspace_playbook`: cross-session ACE (`arXiv:2510.04618`) error -> verified-fix
//!   pairs for BOTH `shell` AND `edit_file`/`apply_patch` errors
//! - `models.yml` config reader/writer (`OMNIA_HOME`, `PI_CODING_AGENT_DIR`, `~/.omp/agent`).

use crate::path_guard::sanitize_windows_path;
use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use omnia_winsqlite::{Connection, StepStatus};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedMerkleRow {
    pub rel_path: String,
    pub size_bytes: u64,
    pub mtime_secs: i64,
    pub mtime_nanos: u32,
    pub blake3_hex: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedAstRow {
    pub blake3_hex: String,
    pub language: String,
    pub ast_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookEntry {
    pub id: i64,
    pub workspace_hash: String,
    pub error_fingerprint: String,
    pub error_kind: String,
    pub symptom: String,
    pub verified_fix: String,
    pub helpful_count: u32,
    pub harmful_count: u32,
    pub last_used_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCost {
    #[serde(default)]
    pub input: f64,
    #[serde(default)]
    pub output: f64,
    #[serde(default)]
    pub cache_read: f64,
    #[serde(default)]
    pub cache_write: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntryConfig {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_context_window")]
    pub context_window: u64,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u64,
    #[serde(default)]
    pub cost: ModelCost,
    /// Per-model wire dialect override (OMP `api:` field). Empty = inherit the provider `api`.
    #[serde(default)]
    pub api: String,
    /// Per-model credential (OMP `apiKey:` field): a literal secret or an ENV var name.
    /// Empty = inherit provider/env key resolution.
    #[serde(default)]
    pub api_key: String,
    /// Per-model reasoning-effort capability (OMP `thinking:` block).
    #[serde(default)]
    pub thinking: Option<ModelThinkingConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelThinkingConfig {
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub efforts: Vec<String>,
    #[serde(default)]
    pub default_level: String,
}

fn default_context_window() -> u64 {
    200_000
}
fn default_max_tokens() -> u64 {
    16_384
}
fn default_api() -> String {
    "openai-completions".to_string()
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    #[serde(default)]
    pub id: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_api")]
    pub api: String,
    #[serde(default = "default_true")]
    pub auth_header: bool,
    #[serde(default)]
    pub models: Vec<ModelEntryConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModelsYamlRoot {
    #[serde(default)]
    providers: BTreeMap<String, YamlProviderBody>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YamlProviderBody {
    base_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default = "default_api")]
    api: String,
    #[serde(default = "default_true")]
    auth_header: bool,
    #[serde(default)]
    models: Vec<ModelEntryConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsConfigReadResult {
    pub path: String,
    pub providers: Vec<ProviderConfig>,
    pub raw_yaml: String,
}

const SCHEMA_SQL: &str = r"
CREATE TABLE IF NOT EXISTS merkle_cache (
    workspace_hash TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    mtime_secs INTEGER NOT NULL,
    mtime_nanos INTEGER NOT NULL,
    blake3_hex TEXT NOT NULL,
    PRIMARY KEY (workspace_hash, rel_path)
);

CREATE TABLE IF NOT EXISTS ast_symbol_cache (
    blake3_hex TEXT PRIMARY KEY,
    language TEXT NOT NULL,
    ast_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoint_blobs (
    blake3_hex TEXT PRIMARY KEY,
    compressed_bytes BLOB NOT NULL,
    raw_size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turn_checkpoints (
    session_id TEXT NOT NULL,
    turn_idx INTEGER NOT NULL,
    manifest_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, turn_idx)
);

CREATE TABLE IF NOT EXISTS workspace_playbook (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_hash TEXT NOT NULL,
    error_fingerprint TEXT NOT NULL,
    error_kind TEXT NOT NULL,
    symptom TEXT NOT NULL,
    verified_fix TEXT NOT NULL,
    helpful_count INTEGER NOT NULL DEFAULT 1,
    harmful_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER NOT NULL,
    UNIQUE(workspace_hash, error_fingerprint)
);
";

/// Thread-safe handle to the `omnia-winsqlite` agent database.
#[derive(Clone)]
pub struct AgentStore {
    conn: Arc<Mutex<Connection>>,
}

impl AgentStore {
    /// Open or create `<data_dir>/omnia_agent.db` with WAL + schema bootstrap.
    pub fn open(data_dir: &Path) -> Result<Self> {
        let clean = sanitize_windows_path(data_dir);
        fs::create_dir_all(&clean)
            .with_context(|| format!("failed to create agent store dir {}", clean.display()))?;
        let db_path = clean.join("omnia_agent.db");
        let conn = Connection::open_read_write(&db_path)
            .map_err(|e| anyhow!("failed to open winsqlite db {}: {e}", db_path.display()))?;
        conn.exec_batch(SCHEMA_SQL)
            .map_err(|e| anyhow!("failed to bootstrap agent store schema: {e}"))?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Open an isolated in-memory SQLite store (tests and ephemeral runs).
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()
            .map_err(|e| anyhow!("failed to open in-memory winsqlite db: {e}"))?;
        conn.exec_batch(SCHEMA_SQL)
            .map_err(|e| anyhow!("failed to bootstrap in-memory agent store schema: {e}"))?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Run a passive WAL checkpoint.
    pub fn checkpoint(&self) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("agent store mutex poisoned"))?;
        let _ = conn.exec_batch("PRAGMA wal_checkpoint(PASSIVE);");
        Ok(())
    }

    pub fn load_merkle_cache(&self, workspace_hash: &str) -> Result<Vec<CachedMerkleRow>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("agent store mutex poisoned"))?;
        let mut stmt = conn
            .prepare(
                "SELECT rel_path, size_bytes, mtime_secs, mtime_nanos, blake3_hex
                 FROM merkle_cache WHERE workspace_hash = ?1",
            )
            .map_err(|e| anyhow!("{e}"))?;
        stmt.bind_text(1, workspace_hash)
            .map_err(|e| anyhow!("{e}"))?;
        let mut rows = Vec::new();
        while matches!(stmt.step().map_err(|e| anyhow!("{e}"))?, StepStatus::Row) {
            rows.push(CachedMerkleRow {
                rel_path: stmt.column_text(0).map_err(|e| anyhow!("{e}"))?,
                size_bytes: stmt.column_int64(1).map_err(|e| anyhow!("{e}"))?.max(0) as u64,
                mtime_secs: stmt.column_int64(2).map_err(|e| anyhow!("{e}"))?,
                mtime_nanos: stmt.column_int64(3).map_err(|e| anyhow!("{e}"))?.max(0) as u32,
                blake3_hex: stmt.column_text(4).map_err(|e| anyhow!("{e}"))?,
            });
        }
        Ok(rows)
    }

    pub fn upsert_merkle_cache(
        &self,
        workspace_hash: &str,
        upserts: &[CachedMerkleRow],
        removed_paths: &[String],
    ) -> Result<()> {
        if upserts.is_empty() && removed_paths.is_empty() {
            return Ok(());
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("agent store mutex poisoned"))?;
        let tx = conn.begin_immediate().map_err(|e| anyhow!("{e}"))?;
        {
            if !removed_paths.is_empty() {
                let mut del_stmt = tx
                    .prepare("DELETE FROM merkle_cache WHERE workspace_hash = ?1 AND rel_path = ?2")
                    .map_err(|e| anyhow!("{e}"))?;
                for rem in removed_paths {
                    del_stmt.reset().map_err(|e| anyhow!("{e}"))?;
                    del_stmt.clear_bindings().map_err(|e| anyhow!("{e}"))?;
                    del_stmt
                        .bind_text(1, workspace_hash)
                        .map_err(|e| anyhow!("{e}"))?;
                    del_stmt.bind_text(2, rem).map_err(|e| anyhow!("{e}"))?;
                    let _ = del_stmt.step().map_err(|e| anyhow!("{e}"))?;
                }
            }
            if !upserts.is_empty() {
                let mut up_stmt = tx
                    .prepare(
                        "INSERT INTO merkle_cache (workspace_hash, rel_path, size_bytes, mtime_secs, mtime_nanos, blake3_hex)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                         ON CONFLICT(workspace_hash, rel_path) DO UPDATE SET
                            size_bytes = excluded.size_bytes,
                            mtime_secs = excluded.mtime_secs,
                            mtime_nanos = excluded.mtime_nanos,
                            blake3_hex = excluded.blake3_hex",
                    )
                    .map_err(|e| anyhow!("{e}"))?;
                for row in upserts {
                    up_stmt.reset().map_err(|e| anyhow!("{e}"))?;
                    up_stmt.clear_bindings().map_err(|e| anyhow!("{e}"))?;
                    up_stmt
                        .bind_text(1, workspace_hash)
                        .map_err(|e| anyhow!("{e}"))?;
                    up_stmt
                        .bind_text(2, &row.rel_path)
                        .map_err(|e| anyhow!("{e}"))?;
                    up_stmt
                        .bind_int64(3, row.size_bytes as i64)
                        .map_err(|e| anyhow!("{e}"))?;
                    up_stmt
                        .bind_int64(4, row.mtime_secs)
                        .map_err(|e| anyhow!("{e}"))?;
                    up_stmt
                        .bind_int64(5, i64::from(row.mtime_nanos))
                        .map_err(|e| anyhow!("{e}"))?;
                    up_stmt
                        .bind_text(6, &row.blake3_hex)
                        .map_err(|e| anyhow!("{e}"))?;
                    let _ = up_stmt.step().map_err(|e| anyhow!("{e}"))?;
                }
            }
        }
        tx.commit().map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }

    pub fn load_ast_cache_batch(
        &self,
        blake3_hexes: &[String],
    ) -> Result<HashMap<String, CachedAstRow>> {
        let mut out = HashMap::new();
        if blake3_hexes.is_empty() {
            return Ok(out);
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("agent store mutex poisoned"))?;
        let mut stmt = conn
            .prepare(
                "SELECT blake3_hex, language, ast_json FROM ast_symbol_cache WHERE blake3_hex = ?1",
            )
            .map_err(|e| anyhow!("{e}"))?;
        for hex in blake3_hexes {
            stmt.reset().map_err(|e| anyhow!("{e}"))?;
            stmt.clear_bindings().map_err(|e| anyhow!("{e}"))?;
            stmt.bind_text(1, hex).map_err(|e| anyhow!("{e}"))?;
            if matches!(stmt.step().map_err(|e| anyhow!("{e}"))?, StepStatus::Row) {
                let row = CachedAstRow {
                    blake3_hex: stmt.column_text(0).map_err(|e| anyhow!("{e}"))?,
                    language: stmt.column_text(1).map_err(|e| anyhow!("{e}"))?,
                    ast_json: stmt.column_text(2).map_err(|e| anyhow!("{e}"))?,
                };
                out.insert(row.blake3_hex.clone(), row);
            }
        }
        Ok(out)
    }

    pub fn upsert_ast_cache_batch(&self, rows: &[CachedAstRow]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let now = Utc::now().timestamp();
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("agent store mutex poisoned"))?;
        let tx = conn.begin_immediate().map_err(|e| anyhow!("{e}"))?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO ast_symbol_cache (blake3_hex, language, ast_json, updated_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(blake3_hex) DO UPDATE SET
                        language = excluded.language,
                        ast_json = excluded.ast_json,
                        updated_at = excluded.updated_at",
                )
                .map_err(|e| anyhow!("{e}"))?;
            for r in rows {
                stmt.reset().map_err(|e| anyhow!("{e}"))?;
                stmt.clear_bindings().map_err(|e| anyhow!("{e}"))?;
                stmt.bind_text(1, &r.blake3_hex)
                    .map_err(|e| anyhow!("{e}"))?;
                stmt.bind_text(2, &r.language).map_err(|e| anyhow!("{e}"))?;
                stmt.bind_text(3, &r.ast_json).map_err(|e| anyhow!("{e}"))?;
                stmt.bind_int64(4, now).map_err(|e| anyhow!("{e}"))?;
                let _ = stmt.step().map_err(|e| anyhow!("{e}"))?;
            }
        }
        tx.commit().map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }

    pub fn put_checkpoint_blob(
        &self,
        blake3_hex: &str,
        compressed_bytes: &[u8],
        raw_size: usize,
    ) -> Result<()> {
        let now = Utc::now().timestamp();
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("agent store mutex poisoned"))?;
        {
            let mut stmt = conn
                .prepare(
                    "INSERT OR IGNORE INTO checkpoint_blobs (blake3_hex, compressed_bytes, raw_size, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                )
                .map_err(|e| anyhow!("{e}"))?;
            stmt.bind_text(1, blake3_hex).map_err(|e| anyhow!("{e}"))?;
            stmt.bind_blob(2, compressed_bytes)
                .map_err(|e| anyhow!("{e}"))?;
            stmt.bind_int64(3, raw_size as i64)
                .map_err(|e| anyhow!("{e}"))?;
            stmt.bind_int64(4, now).map_err(|e| anyhow!("{e}"))?;
            let _ = stmt.step().map_err(|e| anyhow!("{e}"))?;
        }
        let mut total_stmt = conn
            .prepare("SELECT COALESCE(SUM(LENGTH(compressed_bytes)), 0) FROM checkpoint_blobs")
            .map_err(|e| anyhow!("{e}"))?;
        let total = if matches!(
            total_stmt.step().map_err(|e| anyhow!("{e}"))?,
            StepStatus::Row
        ) {
            total_stmt.column_int64(0).map_err(|e| anyhow!("{e}"))?
        } else {
            0
        };
        drop(total_stmt);
        const MAX_BLOB_BYTES: i64 = 20 * 1024 * 1024;
        if total > MAX_BLOB_BYTES {
            conn.exec_batch(
                "DELETE FROM checkpoint_blobs WHERE blake3_hex IN (
                    SELECT blake3_hex FROM checkpoint_blobs ORDER BY created_at ASC LIMIT 64
                 );",
            )
            .map_err(|e| anyhow!("{e}"))?;
        }
        Ok(())
    }

    pub fn get_checkpoint_blob(&self, blake3_hex: &str) -> Result<Option<Vec<u8>>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("agent store mutex poisoned"))?;
        let mut stmt = conn
            .prepare("SELECT compressed_bytes FROM checkpoint_blobs WHERE blake3_hex = ?1")
            .map_err(|e| anyhow!("{e}"))?;
        stmt.bind_text(1, blake3_hex).map_err(|e| anyhow!("{e}"))?;
        if matches!(stmt.step().map_err(|e| anyhow!("{e}"))?, StepStatus::Row) {
            Ok(Some(stmt.column_blob(0).map_err(|e| anyhow!("{e}"))?))
        } else {
            Ok(None)
        }
    }

    pub fn save_turn_checkpoint(
        &self,
        session_id: &str,
        turn_idx: u32,
        manifest_json: &str,
    ) -> Result<()> {
        let now = Utc::now().timestamp();
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("agent store mutex poisoned"))?;
        let mut stmt = conn
            .prepare(
                "INSERT INTO turn_checkpoints (session_id, turn_idx, manifest_json, created_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(session_id, turn_idx) DO UPDATE SET
                    manifest_json = excluded.manifest_json,
                    created_at = excluded.created_at",
            )
            .map_err(|e| anyhow!("{e}"))?;
        stmt.bind_text(1, session_id).map_err(|e| anyhow!("{e}"))?;
        stmt.bind_int64(2, i64::from(turn_idx))
            .map_err(|e| anyhow!("{e}"))?;
        stmt.bind_text(3, manifest_json)
            .map_err(|e| anyhow!("{e}"))?;
        stmt.bind_int64(4, now).map_err(|e| anyhow!("{e}"))?;
        let _ = stmt.step().map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }

    pub fn load_turn_checkpoints(&self, session_id: &str) -> Result<Vec<(u32, String)>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("agent store mutex poisoned"))?;
        let mut stmt = conn
            .prepare(
                "SELECT turn_idx, manifest_json FROM turn_checkpoints
                 WHERE session_id = ?1 ORDER BY turn_idx ASC",
            )
            .map_err(|e| anyhow!("{e}"))?;
        stmt.bind_text(1, session_id).map_err(|e| anyhow!("{e}"))?;
        let mut out = Vec::new();
        while matches!(stmt.step().map_err(|e| anyhow!("{e}"))?, StepStatus::Row) {
            let t = stmt.column_int64(0).map_err(|e| anyhow!("{e}"))?.max(0) as u32;
            let json = stmt.column_text(1).map_err(|e| anyhow!("{e}"))?;
            out.push((t, json));
        }
        Ok(out)
    }

    /// Return the most recent session ID stored in `turn_checkpoints`.
    pub fn latest_checkpoint_session(&self) -> Result<Option<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("agent store mutex poisoned"))?;
        let mut stmt = conn
            .prepare("SELECT session_id FROM turn_checkpoints ORDER BY created_at DESC LIMIT 1")
            .map_err(|e| anyhow!("{e}"))?;
        if matches!(stmt.step().map_err(|e| anyhow!("{e}"))?, StepStatus::Row) {
            Ok(Some(stmt.column_text(0).map_err(|e| anyhow!("{e}"))?))
        } else {
            Ok(None)
        }
    }

    pub fn record_playbook_fix(
        &self,
        workspace_hash: &str,
        error_fingerprint: &str,
        error_kind: &str,
        symptom: &str,
        verified_fix: &str,
    ) -> Result<()> {
        let now = Utc::now().timestamp();
        let sym_short: String = symptom.chars().take(240).collect();
        let fix_short: String = verified_fix.chars().take(400).collect();
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("agent store mutex poisoned"))?;
        let mut stmt = conn
            .prepare(
                "INSERT INTO workspace_playbook
                    (workspace_hash, error_fingerprint, error_kind, symptom, verified_fix, helpful_count, harmful_count, last_used_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, ?6)
                 ON CONFLICT(workspace_hash, error_fingerprint) DO UPDATE SET
                    verified_fix = excluded.verified_fix,
                    helpful_count = workspace_playbook.helpful_count + 1,
                    last_used_at = excluded.last_used_at",
            )
            .map_err(|e| anyhow!("{e}"))?;
        stmt.bind_text(1, workspace_hash)
            .map_err(|e| anyhow!("{e}"))?;
        stmt.bind_text(2, error_fingerprint)
            .map_err(|e| anyhow!("{e}"))?;
        stmt.bind_text(3, error_kind).map_err(|e| anyhow!("{e}"))?;
        stmt.bind_text(4, &sym_short).map_err(|e| anyhow!("{e}"))?;
        stmt.bind_text(5, &fix_short).map_err(|e| anyhow!("{e}"))?;
        stmt.bind_int64(6, now).map_err(|e| anyhow!("{e}"))?;
        let _ = stmt.step().map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }

    pub fn lookup_playbook_fix(
        &self,
        workspace_hash: &str,
        error_fingerprint: &str,
    ) -> Result<Option<PlaybookEntry>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("agent store mutex poisoned"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, workspace_hash, error_fingerprint, error_kind, symptom, verified_fix,
                        helpful_count, harmful_count, last_used_at
                 FROM workspace_playbook
                 WHERE workspace_hash = ?1 AND error_fingerprint = ?2
                   AND helpful_count > harmful_count",
            )
            .map_err(|e| anyhow!("{e}"))?;
        stmt.bind_text(1, workspace_hash)
            .map_err(|e| anyhow!("{e}"))?;
        stmt.bind_text(2, error_fingerprint)
            .map_err(|e| anyhow!("{e}"))?;
        if matches!(stmt.step().map_err(|e| anyhow!("{e}"))?, StepStatus::Row) {
            Ok(Some(PlaybookEntry {
                id: stmt.column_int64(0).map_err(|e| anyhow!("{e}"))?,
                workspace_hash: stmt.column_text(1).map_err(|e| anyhow!("{e}"))?,
                error_fingerprint: stmt.column_text(2).map_err(|e| anyhow!("{e}"))?,
                error_kind: stmt.column_text(3).map_err(|e| anyhow!("{e}"))?,
                symptom: stmt.column_text(4).map_err(|e| anyhow!("{e}"))?,
                verified_fix: stmt.column_text(5).map_err(|e| anyhow!("{e}"))?,
                helpful_count: stmt.column_int64(6).map_err(|e| anyhow!("{e}"))?.max(0) as u32,
                harmful_count: stmt.column_int64(7).map_err(|e| anyhow!("{e}"))?.max(0) as u32,
                last_used_at: stmt.column_int64(8).map_err(|e| anyhow!("{e}"))?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn mark_playbook_harmful(
        &self,
        workspace_hash: &str,
        error_fingerprint: &str,
    ) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("agent store mutex poisoned"))?;
        let mut stmt = conn
            .prepare(
                "UPDATE workspace_playbook SET harmful_count = harmful_count + 1
                 WHERE workspace_hash = ?1 AND error_fingerprint = ?2",
            )
            .map_err(|e| anyhow!("{e}"))?;
        stmt.bind_text(1, workspace_hash)
            .map_err(|e| anyhow!("{e}"))?;
        stmt.bind_text(2, error_fingerprint)
            .map_err(|e| anyhow!("{e}"))?;
        let _ = stmt.step().map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }
}

/// Resolve the active Omnia data directory (`OMNIA_HOME` or OS local app data).
#[must_use]
pub fn default_omnia_data_dir() -> PathBuf {
    if let Ok(home) = std::env::var("OMNIA_HOME") {
        let t = home.trim();
        if !t.is_empty() {
            return sanitize_windows_path(Path::new(t));
        }
    }
    let base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    sanitize_windows_path(&base.join("omnia-agent"))
}

#[must_use]
pub fn resolve_models_yml_path(config_dir: Option<&Path>) -> PathBuf {
    if let Some(dir) = config_dir {
        return sanitize_windows_path(dir).join("models.yml");
    }
    if let Ok(env_dir) = std::env::var("OMNIA_HOME") {
        if !env_dir.trim().is_empty() {
            let cand = sanitize_windows_path(Path::new(&env_dir)).join("models.yml");
            if cand.exists() {
                return cand;
            }
        }
    }
    if let Ok(env_dir) = std::env::var("PI_CODING_AGENT_DIR") {
        if !env_dir.trim().is_empty() {
            return sanitize_windows_path(Path::new(&env_dir)).join("models.yml");
        }
    }
    if let Some(home) = dirs::home_dir() {
        for cand in [
            home.join(".omnia").join("models.yml"),
            home.join(".omp").join("agent").join("models.yml"),
            home.join(".pi").join("agent").join("models.yml"),
        ] {
            if cand.exists() {
                return sanitize_windows_path(&cand);
            }
        }
        return sanitize_windows_path(&home.join(".omnia").join("models.yml"));
    }
    PathBuf::from("models.yml")
}

pub fn read_models_config(config_dir: Option<&Path>) -> Result<ModelsConfigReadResult> {
    let path = resolve_models_yml_path(config_dir);
    if !path.exists() {
        return Ok(ModelsConfigReadResult {
            path: path.to_string_lossy().into_owned(),
            providers: Vec::new(),
            raw_yaml: "providers: {}\n".into(),
        });
    }
    let raw_yaml =
        fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))?;
    let parsed: ModelsYamlRoot = serde_yaml::from_str(&raw_yaml).unwrap_or(ModelsYamlRoot {
        providers: BTreeMap::new(),
    });

    let providers = parsed
        .providers
        .into_iter()
        .map(|(id, body)| ProviderConfig {
            id,
            base_url: body.base_url,
            api_key: body.api_key,
            api: body.api,
            auth_header: body.auth_header,
            models: body
                .models
                .into_iter()
                .map(|mut m| {
                    if m.name.is_empty() {
                        m.name = m.id.clone();
                    }
                    m
                })
                .collect(),
        })
        .collect();

    Ok(ModelsConfigReadResult {
        path: path.to_string_lossy().into_owned(),
        providers,
        raw_yaml,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winsqlite_merkle_ast_checkpoint_and_playbook_roundtrip() {
        let db = AgentStore::open_in_memory().unwrap();
        let ws_hash = "ws_deadbeef";
        let m_rows = vec![
            CachedMerkleRow {
                rel_path: "src/app.py".into(),
                size_bytes: 120,
                mtime_secs: 1_700_000_000,
                mtime_nanos: 123,
                blake3_hex: "aa".repeat(32),
            },
            CachedMerkleRow {
                rel_path: "src/old.py".into(),
                size_bytes: 40,
                mtime_secs: 1_700_000_000,
                mtime_nanos: 0,
                blake3_hex: "bb".repeat(32),
            },
        ];
        db.upsert_merkle_cache(ws_hash, &m_rows, &[]).unwrap();
        assert_eq!(db.load_merkle_cache(ws_hash).unwrap().len(), 2);

        db.upsert_merkle_cache(ws_hash, &[], &["src/old.py".into()])
            .unwrap();
        let after_del = db.load_merkle_cache(ws_hash).unwrap();
        assert_eq!(after_del.len(), 1);
        assert_eq!(after_del[0].rel_path, "src/app.py");

        let ast_row = CachedAstRow {
            blake3_hex: "aa".repeat(32),
            language: "python".into(),
            ast_json: r#"{"symbols":[{"name":"main"}]}"#.into(),
        };
        db.upsert_ast_cache_batch(std::slice::from_ref(&ast_row))
            .unwrap();
        let hits = db
            .load_ast_cache_batch(&["aa".repeat(32), "cc".repeat(32)])
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits.get(&"aa".repeat(32)).unwrap().ast_json,
            ast_row.ast_json
        );

        db.put_checkpoint_blob("blob1", b"compressed", 64).unwrap();
        assert_eq!(
            db.get_checkpoint_blob("blob1").unwrap().as_deref(),
            Some(&b"compressed"[..])
        );
        db.save_turn_checkpoint("sess-1", 2, r#"{"turn":2}"#)
            .unwrap();
        assert_eq!(db.load_turn_checkpoints("sess-1").unwrap().len(), 1);
        assert_eq!(
            db.latest_checkpoint_session().unwrap().as_deref(),
            Some("sess-1")
        );

        db.record_playbook_fix(
            ws_hash,
            "fp_1",
            "EditMismatch",
            "anchor mismatch",
            "Re-read file before editing",
        )
        .unwrap();
        let hit = db.lookup_playbook_fix(ws_hash, "fp_1").unwrap().unwrap();
        assert_eq!(hit.helpful_count, 1);
        db.mark_playbook_harmful(ws_hash, "fp_1").unwrap();
        assert!(db.lookup_playbook_fix(ws_hash, "fp_1").unwrap().is_none());
    }
}
