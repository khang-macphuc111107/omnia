//! Persistent `omnia-winsqlite` WAL job & segment store (`download_jobs`, `download_segments`).
//!
//! Stores strictly secret-free `sanitized_url` values — never persists raw OAuth tokens,
//! signed URLs, or cookies.

use std::path::{Path, PathBuf};
use std::str::FromStr;

use omnia_connector_gateway::artifact_intake::HttpValidatorStrength;
use omnia_winsqlite::{Connection, StepStatus};
use parking_lot::Mutex;

use crate::batch::{ScheduleWindow, SchedulerConfig, SitePolicyRegistry, SiteRule};
use crate::pacing::PacingMode;
use crate::types::{
    current_epoch_ms, validate_safe_local_path, ChunkRange, DownloadJobSnapshot, DownloadStatus,
    DownloaderError, DRM_SUPPORTED,
};

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS download_jobs (
    job_id TEXT PRIMARY KEY,
    sanitized_url TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    destination_path TEXT NOT NULL,
    part_path TEXT NOT NULL,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    pacing_mode TEXT NOT NULL,
    streams INTEGER NOT NULL DEFAULT 1,
    etag TEXT,
    last_modified TEXT,
    validator_strength TEXT NOT NULL DEFAULT 'none',
    sha256_expected TEXT,
    sha256_actual TEXT,
    crc32c_expected TEXT,
    crc32c_actual TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS download_segments (
    job_id TEXT NOT NULL,
    segment_id INTEGER NOT NULL,
    start_byte INTEGER NOT NULL,
    end_byte INTEGER NOT NULL,
    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
    is_completed INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (job_id, segment_id),
    FOREIGN KEY (job_id) REFERENCES download_jobs(job_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_download_jobs_status ON download_jobs(status, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS download_scheduler_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    max_concurrent_jobs INTEGER NOT NULL,
    start_hour_utc INTEGER,
    end_hour_utc INTEGER,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS download_site_policies (
    host_pattern TEXT PRIMARY KEY,
    max_connections_per_host INTEGER NOT NULL,
    default_pacing TEXT,
    note TEXT NOT NULL DEFAULT '',
    updated_at_ms INTEGER NOT NULL
);
"#;

/// Thread-safe `omnia-winsqlite` repository for download jobs and per-segment progress.
pub struct DownloadStore {
    conn: Mutex<Connection>,
}

impl DownloadStore {
    /// Opens or creates a WAL-mode SQLite database at `db_path` (rejecting UNC/workspace-internal paths).
    pub fn open(
        db_path: &Path,
        workspace_root: Option<&Path>,
    ) -> Result<Self, DownloaderError> {
        let safe_path = validate_safe_local_path(db_path, workspace_root)?;
        if let Some(parent) = safe_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open_read_write(&safe_path)?;
        conn.exec_batch(SCHEMA_SQL)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Opens an isolated in-memory SQLite store (ideal for ephemeral sessions & unit tests).
    pub fn open_in_memory() -> Result<Self, DownloaderError> {
        let conn = Connection::open_in_memory()?;
        conn.exec_batch(SCHEMA_SQL)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Inserts or updates a [`DownloadJobSnapshot`] row in `download_jobs`.
    pub fn upsert_job(&self, job: &DownloadJobSnapshot) -> Result<(), DownloaderError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "INSERT INTO download_jobs (
                job_id, sanitized_url, provider_id, destination_path, part_path,
                total_bytes, downloaded_bytes, status, pacing_mode, streams,
                etag, last_modified, validator_strength,
                sha256_expected, sha256_actual, crc32c_expected, crc32c_actual,
                error_code, error_message, created_at_ms, updated_at_ms
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5,
                ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13,
                ?14, ?15, ?16, ?17,
                ?18, ?19, ?20, ?21
             )
             ON CONFLICT(job_id) DO UPDATE SET
                sanitized_url = excluded.sanitized_url,
                provider_id = excluded.provider_id,
                destination_path = excluded.destination_path,
                part_path = excluded.part_path,
                total_bytes = excluded.total_bytes,
                downloaded_bytes = excluded.downloaded_bytes,
                status = excluded.status,
                pacing_mode = excluded.pacing_mode,
                streams = excluded.streams,
                etag = excluded.etag,
                last_modified = excluded.last_modified,
                validator_strength = excluded.validator_strength,
                sha256_expected = excluded.sha256_expected,
                sha256_actual = excluded.sha256_actual,
                crc32c_expected = excluded.crc32c_expected,
                crc32c_actual = excluded.crc32c_actual,
                error_code = excluded.error_code,
                error_message = excluded.error_message,
                updated_at_ms = excluded.updated_at_ms",
        )?;

        stmt.bind_text(1, &job.job_id)?;
        stmt.bind_text(2, &job.sanitized_url)?;
        stmt.bind_text(3, &job.provider_id)?;
        stmt.bind_text(4, &job.destination_path.to_string_lossy())?;
        stmt.bind_text(5, &job.part_path.to_string_lossy())?;
        stmt.bind_int64(6, job.total_bytes as i64)?;
        stmt.bind_int64(7, job.downloaded_bytes as i64)?;
        stmt.bind_text(8, job.status.as_str())?;
        stmt.bind_text(9, job.pacing_mode.as_str())?;
        stmt.bind_int64(10, job.streams as i64)?;
        stmt.bind_opt_text(11, job.etag.as_deref())?;
        stmt.bind_opt_text(12, job.last_modified.as_deref())?;
        stmt.bind_text(13, job.validator_strength.as_str())?;
        stmt.bind_opt_text(14, job.sha256_expected.as_deref())?;
        stmt.bind_opt_text(15, job.sha256_actual.as_deref())?;
        stmt.bind_opt_text(16, job.crc32c_expected.as_deref())?;
        stmt.bind_opt_text(17, job.crc32c_actual.as_deref())?;
        stmt.bind_opt_text(18, job.error_code.as_deref())?;
        stmt.bind_opt_text(19, job.error_message.as_deref())?;
        stmt.bind_int64(20, job.created_at_ms as i64)?;
        stmt.bind_int64(21, job.updated_at_ms as i64)?;

        let _ = stmt.step()?;
        Ok(())
    }

    /// Atomically replaces all segment rows for `job_id` inside an immediate SQLite transaction.
    pub fn replace_segments(
        &self,
        job_id: &str,
        segments: &[ChunkRange],
    ) -> Result<(), DownloaderError> {
        let mut conn = self.conn.lock();
        let tx = conn.begin_immediate()?;
        {
            let mut del = tx.prepare("DELETE FROM download_segments WHERE job_id = ?1")?;
            del.bind_text(1, job_id)?;
            let _ = del.step()?;
        }
        {
            let now = current_epoch_ms() as i64;
            let mut ins = tx.prepare(
                "INSERT INTO download_segments (
                    job_id, segment_id, start_byte, end_byte,
                    downloaded_bytes, is_completed, updated_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for seg in segments {
                ins.reset()?;
                ins.clear_bindings()?;
                ins.bind_text(1, job_id)?;
                ins.bind_int64(2, seg.chunk_id as i64)?;
                ins.bind_int64(3, seg.start as i64)?;
                ins.bind_int64(4, seg.end as i64)?;
                ins.bind_int64(5, seg.downloaded as i64)?;
                ins.bind_int64(6, i64::from(seg.is_completed))?;
                ins.bind_int64(7, now)?;
                let _ = ins.step()?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Loads a single job snapshot by `job_id`.
    pub fn get_job(&self, job_id: &str) -> Result<Option<DownloadJobSnapshot>, DownloaderError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT job_id, sanitized_url, provider_id, destination_path, part_path,
                    total_bytes, downloaded_bytes, status, pacing_mode, streams,
                    etag, last_modified, validator_strength,
                    sha256_expected, sha256_actual, crc32c_expected, crc32c_actual,
                    error_code, error_message, created_at_ms, updated_at_ms
             FROM download_jobs WHERE job_id = ?1",
        )?;
        stmt.bind_text(1, job_id)?;
        match stmt.step()? {
            StepStatus::Row => Ok(Some(read_job_row(&stmt)?)),
            StepStatus::Done => Ok(None),
        }
    }

    /// Lists all tracked download jobs ordered by most recently updated first.
    pub fn list_jobs(&self) -> Result<Vec<DownloadJobSnapshot>, DownloaderError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT job_id, sanitized_url, provider_id, destination_path, part_path,
                    total_bytes, downloaded_bytes, status, pacing_mode, streams,
                    etag, last_modified, validator_strength,
                    sha256_expected, sha256_actual, crc32c_expected, crc32c_actual,
                    error_code, error_message, created_at_ms, updated_at_ms
             FROM download_jobs ORDER BY updated_at_ms DESC, job_id ASC",
        )?;
        let mut out = Vec::new();
        while stmt.step_row()? {
            out.push(read_job_row(&stmt)?);
        }
        Ok(out)
    }

    /// Loads persisted segment states for `job_id` ordered by `segment_id`.
    pub fn get_segments(&self, job_id: &str) -> Result<Vec<ChunkRange>, DownloaderError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT segment_id, start_byte, end_byte, downloaded_bytes, is_completed
             FROM download_segments WHERE job_id = ?1 ORDER BY segment_id ASC",
        )?;
        stmt.bind_text(1, job_id)?;
        let mut out = Vec::new();
        while stmt.step_row()? {
            out.push(ChunkRange {
                chunk_id: stmt.column_int64(0)?.max(0) as usize,
                start: stmt.column_int64(1)?.max(0) as u64,
                end: stmt.column_int64(2)?.max(0) as u64,
                downloaded: stmt.column_int64(3)?.max(0) as u64,
                is_completed: stmt.column_int64(4)? != 0,
            });
        }
        Ok(out)
    }

    /// Deletes a download job and its cascading segment rows.
    pub fn delete_job(&self, job_id: &str) -> Result<bool, DownloaderError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("DELETE FROM download_jobs WHERE job_id = ?1")?;
        stmt.bind_text(1, job_id)?;
        let _ = stmt.step()?;
        Ok(conn.changes() > 0)
    }

    /// Persists [`SchedulerConfig`] in WAL SQLite (`download_scheduler_config`).
    pub fn save_scheduler_config(&self, cfg: &SchedulerConfig) -> Result<(), DownloaderError> {
        let conn = self.conn.lock();
        let now = current_epoch_ms() as i64;
        let mut stmt = conn.prepare(
            "INSERT INTO download_scheduler_config (
                id, max_concurrent_jobs, start_hour_utc, end_hour_utc, updated_at_ms
             ) VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                max_concurrent_jobs = excluded.max_concurrent_jobs,
                start_hour_utc = excluded.start_hour_utc,
                end_hour_utc = excluded.end_hour_utc,
                updated_at_ms = excluded.updated_at_ms",
        )?;
        stmt.bind_int64(1, cfg.max_concurrent_jobs.clamp(1, 32) as i64)?;
        stmt.bind_opt_int64(2, cfg.window.map(|w| i64::from(w.start_hour_utc.min(23))))?;
        stmt.bind_opt_int64(3, cfg.window.map(|w| i64::from(w.end_hour_utc.min(23))))?;
        stmt.bind_int64(4, now)?;
        let _ = stmt.step()?;
        Ok(())
    }

    /// Loads persisted [`SchedulerConfig`] if previously saved.
    pub fn load_scheduler_config(&self) -> Result<Option<SchedulerConfig>, DownloaderError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT max_concurrent_jobs, start_hour_utc, end_hour_utc
             FROM download_scheduler_config WHERE id = 1",
        )?;
        match stmt.step()? {
            StepStatus::Row => {
                let max_jobs = (stmt.column_int64(0)?.max(1) as usize).clamp(1, 32);
                let start_opt = stmt.column_opt_int64(1)?;
                let end_opt = stmt.column_opt_int64(2)?;
                let window = match (start_opt, end_opt) {
                    (Some(s), Some(e)) => Some(ScheduleWindow {
                        start_hour_utc: s.clamp(0, 23) as u32,
                        end_hour_utc: e.clamp(0, 23) as u32,
                    }),
                    _ => None,
                };
                Ok(Some(SchedulerConfig {
                    max_concurrent_jobs: max_jobs,
                    window,
                }))
            }
            StepStatus::Done => Ok(None),
        }
    }

    /// Atomically replaces all site policy rules in WAL SQLite (`download_site_policies`).
    pub fn replace_site_policies(&self, reg: &SitePolicyRegistry) -> Result<(), DownloaderError> {
        let mut conn = self.conn.lock();
        let tx = conn.begin_immediate()?;
        tx.exec_batch("DELETE FROM download_site_policies")?;
        let now = current_epoch_ms() as i64;
        {
            let mut ins = tx.prepare(
                "INSERT INTO download_site_policies (
                    host_pattern, max_connections_per_host, default_pacing, note, updated_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for rule in reg.list_rules() {
                ins.reset()?;
                ins.clear_bindings()?;
                ins.bind_text(1, &rule.host_pattern)?;
                ins.bind_int64(2, rule.max_connections_per_host.clamp(1, 128) as i64)?;
                ins.bind_opt_text(3, rule.default_pacing.as_deref())?;
                ins.bind_text(4, &rule.note)?;
                ins.bind_int64(5, now)?;
                let _ = ins.step()?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Loads persisted [`SitePolicyRegistry`] rules from WAL SQLite.
    pub fn load_site_policies(&self) -> Result<SitePolicyRegistry, DownloaderError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT host_pattern, max_connections_per_host, default_pacing, note
             FROM download_site_policies ORDER BY host_pattern ASC",
        )?;
        let mut reg = SitePolicyRegistry::new();
        while stmt.step_row()? {
            let rule = SiteRule {
                host_pattern: stmt.column_text(0)?,
                max_connections_per_host: (stmt.column_int64(1)?.max(1) as usize).clamp(1, 128),
                default_pacing: stmt.column_opt_text(2)?,
                note: stmt.column_text(3)?,
            };
            let _ = reg.upsert_rule(rule);
        }
        Ok(reg)
    }
}

fn read_job_row(stmt: &omnia_winsqlite::Statement<'_>) -> Result<DownloadJobSnapshot, DownloaderError> {
    let validator_str = stmt.column_text(12)?;
    let validator_strength =
        HttpValidatorStrength::from_str(&validator_str).unwrap_or(HttpValidatorStrength::None);
    Ok(DownloadJobSnapshot {
        job_id: stmt.column_text(0)?,
        sanitized_url: stmt.column_text(1)?,
        provider_id: stmt.column_text(2)?,
        destination_path: PathBuf::from(stmt.column_text(3)?),
        part_path: PathBuf::from(stmt.column_text(4)?),
        total_bytes: stmt.column_int64(5)?.max(0) as u64,
        downloaded_bytes: stmt.column_int64(6)?.max(0) as u64,
        status: DownloadStatus::from_db_str(&stmt.column_text(7)?),
        pacing_mode: PacingMode::from_db_str(&stmt.column_text(8)?),
        streams: stmt.column_int64(9)?.max(1) as usize,
        etag: stmt.column_opt_text(10)?,
        last_modified: stmt.column_opt_text(11)?,
        validator_strength,
        sha256_expected: stmt.column_opt_text(13)?,
        sha256_actual: stmt.column_opt_text(14)?,
        crc32c_expected: stmt.column_opt_text(15)?,
        crc32c_actual: stmt.column_opt_text(16)?,
        error_code: stmt.column_opt_text(17)?,
        error_message: stmt.column_opt_text(18)?,
        drm_supported: DRM_SUPPORTED,
        created_at_ms: stmt.column_int64(19)?.max(0) as u64,
        updated_at_ms: stmt.column_int64(20)?.max(0) as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_store_persists_jobs_and_segments_with_cascade_delete() {
        let store = DownloadStore::open_in_memory().unwrap();
        let now = current_epoch_ms();
        let job = DownloadJobSnapshot {
            job_id: "job-sql-1".into(),
            sanitized_url: "https://cdn.example.org/data.bin?sig=[REDACTED]".into(),
            provider_id: "generic_http".into(),
            destination_path: PathBuf::from(r"D:\OmniaData\downloads\data.bin"),
            part_path: PathBuf::from(r"D:\OmniaData\downloads\data.bin.part"),
            total_bytes: 8192,
            downloaded_bytes: 4096,
            status: DownloadStatus::Paused,
            pacing_mode: PacingMode::Adaptive,
            streams: 4,
            etag: Some("\"v1\"".into()),
            last_modified: None,
            validator_strength: HttpValidatorStrength::StrongEtag,
            sha256_expected: None,
            sha256_actual: None,
            crc32c_expected: None,
            crc32c_actual: None,
            error_code: None,
            error_message: None,
            drm_supported: false,
            created_at_ms: now,
            updated_at_ms: now,
        };
        store.upsert_job(&job).unwrap();

        let segs = vec![
            ChunkRange {
                chunk_id: 0,
                start: 0,
                end: 4095,
                downloaded: 4096,
                is_completed: true,
            },
            ChunkRange {
                chunk_id: 1,
                start: 4096,
                end: 8191,
                downloaded: 0,
                is_completed: false,
            },
        ];
        store.replace_segments("job-sql-1", &segs).unwrap();

        let loaded = store.get_job("job-sql-1").unwrap().unwrap();
        assert_eq!(loaded.status, DownloadStatus::Paused);
        assert_eq!(loaded.downloaded_bytes, 4096);
        assert!(!loaded.drm_supported);

        let loaded_segs = store.get_segments("job-sql-1").unwrap();
        assert_eq!(loaded_segs, segs);

        assert!(store.delete_job("job-sql-1").unwrap());
        assert!(store.get_job("job-sql-1").unwrap().is_none());
        assert!(store.get_segments("job-sql-1").unwrap().is_empty());
    }

    #[test]
    fn sqlite_store_persists_scheduler_config_and_site_policies() {
        let dir = std::env::temp_dir().join(format!(
            "omnia-dl-store-sched-{}",
            omnia_core::uuid_v4_simple()
        ));
        let db_path = dir.join("downloads.db");
        {
            let store = DownloadStore::open(&db_path, None).unwrap();
            let cfg = SchedulerConfig {
                max_concurrent_jobs: 6,
                window: Some(ScheduleWindow {
                    start_hour_utc: 2,
                    end_hour_utc: 9,
                }),
            };
            store.save_scheduler_config(&cfg).unwrap();
            let mut reg = SitePolicyRegistry::new();
            reg.upsert_rule(SiteRule {
                host_pattern: "*.example.org".into(),
                max_connections_per_host: 4,
                default_pacing: Some("polite".into()),
                note: "throttled cdn".into(),
            })
            .unwrap();
            store.replace_site_policies(&reg).unwrap();
        }

        // Reopen WAL DB and verify durability.
        let reopened = DownloadStore::open(&db_path, None).unwrap();
        let loaded_cfg = reopened.load_scheduler_config().unwrap().unwrap();
        assert_eq!(loaded_cfg.max_concurrent_jobs, 6);
        assert_eq!(loaded_cfg.window.unwrap().end_hour_utc, 9);
        let loaded_reg = reopened.load_site_policies().unwrap();
        assert_eq!(
            loaded_reg
                .resolve_for_host("media.example.org")
                .unwrap()
                .max_connections_per_host,
            4
        );
        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
