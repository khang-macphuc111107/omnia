//! Persistent WAL `omnia-winsqlite` store for Studio v5 + `omp-omni` companion tables:
//! Dual-Scope `Main` / `Subagent` model+effort roles, session `Chat / Builder / SOLO` modes,
//! Chat-surface `Quote + BTW` threads, `kb_notes` (+ FTS5 / fallback search), SHA-256 `pastes`,
//! `kanban_tasks`, `inbox_items`, `routines`, and real observed `usage_traces` (zero fake data).

use std::fs;
use std::path::Path;

use crate::telemetry::{compute_distribution, estimate_kv_cache_savings_usd};
use omnia_core::{now_epoch_ms, sha256_hex, uuid_v4, SecretRedactor};
use omnia_winsqlite::Connection;
use omnia_workspace_ops::net_diag::SpeedtestResult;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const OPS_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS ops_model_roles (
    scope TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    effort TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_session_modes (
    session_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'builder',
    cwd TEXT NOT NULL DEFAULT '',
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_chat_btw (
    btw_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    anchor_turn_id TEXT NOT NULL,
    quote_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    promoted_message_id TEXT,
    messages_json TEXT NOT NULL DEFAULT '[]',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_kb_notes (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    outbound_links_json TEXT NOT NULL DEFAULT '[]',
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_pastes (
    paste_id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    title TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'text/plain',
    content TEXT NOT NULL,
    byte_len INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_kanban_seq (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_num INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO ops_kanban_seq (id, next_num) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS ops_kanban_tasks (
    id TEXT PRIMARY KEY,
    seq_num INTEGER NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog',
    priority TEXT NOT NULL DEFAULT 'medium',
    workspace_id TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    linked_session_id TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_inbox_items (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_routines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    schedule_expr TEXT NOT NULL,
    isolation_mode TEXT NOT NULL DEFAULT 'worktree',
    model_spec TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at_ms INTEGER,
    next_run_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_usage_traces (
    trace_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    surface TEXT NOT NULL DEFAULT 'studio',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0.0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    ttft_ms INTEGER,
    tokens_per_second REAL NOT NULL DEFAULT 0.0,
    is_error INTEGER NOT NULL DEFAULT 0,
    error_note TEXT,
    saved_tokens INTEGER NOT NULL DEFAULT 0,
    recorded_at_ms INTEGER NOT NULL,
    req_id TEXT NOT NULL DEFAULT '',
    workspace TEXT NOT NULL DEFAULT '',
    git_branch TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'main',
    wire_dialect TEXT NOT NULL DEFAULT 'auto',
    reasoning_effort TEXT NOT NULL DEFAULT 'max',
    status TEXT NOT NULL DEFAULT 'ok',
    tpot_ms REAL,
    active_decode_tps REAL NOT NULL DEFAULT 0.0,
    e2e_tps REAL NOT NULL DEFAULT 0.0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    stall_retries INTEGER NOT NULL DEFAULT 0,
    hedge_wins INTEGER NOT NULL DEFAULT 0,
    prefix_hash TEXT NOT NULL DEFAULT '',
    cache_bust_reason TEXT,
    context_window_fill_pct REAL,
    compaction_eta_turns INTEGER,
    kv_savings_usd REAL NOT NULL DEFAULT 0.0
);

CREATE TABLE IF NOT EXISTS ops_network_speedtests (
    run_id TEXT PRIMARY KEY,
    profile TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    provenance TEXT NOT NULL,
    cancelled INTEGER NOT NULL DEFAULT 0,
    unloaded_p50_ms REAL,
    unloaded_p95_ms REAL,
    unloaded_p99_ms REAL,
    jitter_ms REAL,
    loss_pct REAL NOT NULL DEFAULT 0.0,
    single_dl_mbps REAL NOT NULL DEFAULT 0.0,
    multi_dl_mbps REAL NOT NULL DEFAULT 0.0,
    download_mbps REAL NOT NULL DEFAULT 0.0,
    single_ul_mbps REAL NOT NULL DEFAULT 0.0,
    multi_ul_mbps REAL NOT NULL DEFAULT 0.0,
    upload_mbps REAL NOT NULL DEFAULT 0.0,
    dl_bloat_ms REAL NOT NULL DEFAULT 0.0,
    ul_bloat_ms REAL NOT NULL DEFAULT 0.0,
    worst_bloat_ms REAL NOT NULL DEFAULT 0.0,
    bufferbloat_grade TEXT NOT NULL DEFAULT 'A+',
    payload_json TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_router_failover_events (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    circuit_state TEXT NOT NULL DEFAULT 'Closed',
    recorded_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_steer_items (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
"#;

const OPS_USAGE_MIGRATIONS: &[&str] = &[
    "ALTER TABLE ops_usage_traces ADD COLUMN req_id TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE ops_usage_traces ADD COLUMN workspace TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE ops_usage_traces ADD COLUMN git_branch TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE ops_usage_traces ADD COLUMN role TEXT NOT NULL DEFAULT 'main';",
    "ALTER TABLE ops_usage_traces ADD COLUMN wire_dialect TEXT NOT NULL DEFAULT 'auto';",
    "ALTER TABLE ops_usage_traces ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'max';",
    "ALTER TABLE ops_usage_traces ADD COLUMN status TEXT NOT NULL DEFAULT 'ok';",
    "ALTER TABLE ops_usage_traces ADD COLUMN tpot_ms REAL;",
    "ALTER TABLE ops_usage_traces ADD COLUMN active_decode_tps REAL NOT NULL DEFAULT 0.0;",
    "ALTER TABLE ops_usage_traces ADD COLUMN e2e_tps REAL NOT NULL DEFAULT 0.0;",
    "ALTER TABLE ops_usage_traces ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE ops_usage_traces ADD COLUMN stall_retries INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE ops_usage_traces ADD COLUMN hedge_wins INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE ops_usage_traces ADD COLUMN prefix_hash TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE ops_usage_traces ADD COLUMN cache_bust_reason TEXT;",
    "ALTER TABLE ops_usage_traces ADD COLUMN context_window_fill_pct REAL;",
    "ALTER TABLE ops_usage_traces ADD COLUMN compaction_eta_turns INTEGER;",
    "ALTER TABLE ops_usage_traces ADD COLUMN kv_savings_usd REAL NOT NULL DEFAULT 0.0;",
];

const OPS_KB_FTS_SQL: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS ops_kb_fts USING fts5(
    slug UNINDEXED,
    title,
    content,
    tags
);
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoleConfig {
    pub scope: String,
    pub provider_id: String,
    pub model_id: String,
    pub effort: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbNoteRecord {
    pub slug: String,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub outbound_links: Vec<String>,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteRecord {
    pub paste_id: String,
    pub sha256: String,
    pub title: String,
    pub mime_type: String,
    pub content: String,
    pub byte_len: usize,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanTaskRecord {
    pub id: String,
    pub seq_num: i64,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub workspace_id: Option<String>,
    pub tags: Vec<String>,
    pub linked_session_id: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRecord {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub workspace_path: String,
    pub schedule_expr: String,
    pub isolation_mode: String,
    pub model_spec: Option<String>,
    pub enabled: bool,
    pub last_run_at_ms: Option<i64>,
    pub next_run_at_ms: Option<i64>,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTraceInput {
    pub session_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub surface: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cost_usd: f64,
    pub duration_ms: i64,
    pub ttft_ms: Option<i64>,
    pub tokens_per_second: f64,
    pub is_error: bool,
    pub error_note: Option<String>,
    pub saved_tokens: i64,
}

/// Persistent SQLite WAL repository backing Studio v5 `ops_*` surfaces.
pub struct OpsStore {
    conn: Mutex<Connection>,
    fts_enabled: bool,
}

impl OpsStore {
    pub fn open(db_path: &Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("create ops db dir '{}': {e}", parent.display()))?;
            }
        }
        let conn = Connection::open_read_write(db_path)
            .map_err(|e| format!("open ops db '{}': {e}", db_path.display()))?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("open in-memory ops db: {e}"))?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self, String> {
        conn.exec_batch(OPS_SCHEMA_SQL)
            .map_err(|e| format!("init ops schema: {e}"))?;
        for mig in OPS_USAGE_MIGRATIONS {
            let _ = conn.exec_batch(mig);
        }
        let fts_enabled = conn.exec_batch(OPS_KB_FTS_SQL).is_ok();
        Ok(Self {
            conn: Mutex::new(conn),
            fts_enabled,
        })
    }

    pub fn set_model_role(
        &self,
        scope: &str,
        provider_id: &str,
        model_id: &str,
        effort: &str,
    ) -> Result<ModelRoleConfig, String> {
        let clean_scope = scope.trim().to_ascii_lowercase();
        if !matches!(
            clean_scope.as_str(),
            "main" | "subagent" | "architect" | "fast" | "advisor" | "verifier" | "fast_apply"
        ) {
            return Err(format!("unsupported model role scope '{scope}'"));
        }
        let clean_effort = effort.trim().to_ascii_lowercase();
        if !matches!(
            clean_effort.as_str(),
            "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
        ) {
            return Err(format!("unsupported reasoning effort '{effort}'"));
        }
        let now = now_epoch_ms();
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO ops_model_roles (scope, provider_id, model_id, effort, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(scope) DO UPDATE SET
                    provider_id = excluded.provider_id,
                    model_id = excluded.model_id,
                    effort = excluded.effort,
                    updated_at_ms = excluded.updated_at_ms;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &clean_scope).map_err(|e| e.to_string())?;
        stmt.bind_text(2, provider_id.trim())
            .map_err(|e| e.to_string())?;
        stmt.bind_text(3, model_id.trim())
            .map_err(|e| e.to_string())?;
        stmt.bind_text(4, &clean_effort).map_err(|e| e.to_string())?;
        stmt.bind_int64(5, now).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(ModelRoleConfig {
            scope: clean_scope,
            provider_id: provider_id.trim().to_string(),
            model_id: model_id.trim().to_string(),
            effort: clean_effort,
            updated_at_ms: now,
        })
    }

    pub fn list_model_roles(&self) -> Result<Vec<ModelRoleConfig>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT scope, provider_id, model_id, effort, updated_at_ms
                 FROM ops_model_roles ORDER BY scope ASC;",
            )
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            out.push(ModelRoleConfig {
                scope: stmt.column_text(0).map_err(|e| e.to_string())?,
                provider_id: stmt.column_text(1).map_err(|e| e.to_string())?,
                model_id: stmt.column_text(2).map_err(|e| e.to_string())?,
                effort: stmt.column_text(3).map_err(|e| e.to_string())?,
                updated_at_ms: stmt.column_int64(4).map_err(|e| e.to_string())?,
            });
        }
        Ok(out)
    }

    pub fn set_session_mode(&self, session_id: &str, mode: &str, cwd: &str) -> Result<String, String> {
        let clean_mode = mode.trim().to_ascii_lowercase();
        if !matches!(clean_mode.as_str(), "chat" | "builder" | "solo") {
            return Err(format!(
                "unsupported agent mode '{mode}' (expected chat|builder|solo)"
            ));
        }
        let now = now_epoch_ms();
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO ops_session_modes (session_id, mode, cwd, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(session_id) DO UPDATE SET
                    mode = excluded.mode,
                    cwd = CASE WHEN excluded.cwd = '' THEN ops_session_modes.cwd ELSE excluded.cwd END,
                    updated_at_ms = excluded.updated_at_ms;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, session_id.trim())
            .map_err(|e| e.to_string())?;
        stmt.bind_text(2, &clean_mode).map_err(|e| e.to_string())?;
        stmt.bind_text(3, cwd.trim()).map_err(|e| e.to_string())?;
        stmt.bind_int64(4, now).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(clean_mode)
    }

    pub fn get_session_mode(&self, session_id: &str) -> Result<String, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT mode FROM ops_session_modes WHERE session_id = ?1;")
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, session_id.trim())
            .map_err(|e| e.to_string())?;
        if stmt.step_row().map_err(|e| e.to_string())? {
            return stmt.column_text(0).map_err(|e| e.to_string());
        }
        Ok("builder".to_string())
    }

    pub fn create_chat_btw(
        &self,
        session_id: &str,
        anchor_turn_id: &str,
        quote: &Value,
        initial_question: &str,
    ) -> Result<Value, String> {
        let btw_id = format!("cbtw_{}", uuid_v4());
        let now = now_epoch_ms();
        let messages = json!([{
            "messageId": format!("msg_{}", uuid_v4()),
            "role": "user",
            "content": SecretRedactor::redact(initial_question.trim()),
            "createdAtMs": now,
        }]);
        let quote_str = serde_json::to_string(&SecretRedactor::redact_json(quote))
            .map_err(|e| e.to_string())?;
        let msgs_str = serde_json::to_string(&messages).map_err(|e| e.to_string())?;
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO ops_chat_btw
                 (btw_id, session_id, anchor_turn_id, quote_json, status, messages_json, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?6, ?6);",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &btw_id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, session_id.trim())
            .map_err(|e| e.to_string())?;
        stmt.bind_text(3, anchor_turn_id.trim())
            .map_err(|e| e.to_string())?;
        stmt.bind_text(4, &quote_str).map_err(|e| e.to_string())?;
        stmt.bind_text(5, &msgs_str).map_err(|e| e.to_string())?;
        stmt.bind_int64(6, now).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(json!({
            "btwId": btw_id,
            "surface": "chat",
            "sessionId": session_id.trim(),
            "anchorTurnId": anchor_turn_id.trim(),
            "anchorQuote": SecretRedactor::redact_json(quote),
            "status": "open",
            "messages": messages,
            "createdAtMs": now,
            "updatedAtMs": now,
        }))
    }

    pub fn append_chat_btw(&self, btw_id: &str, role: &str, content: &str) -> Result<Value, String> {
        let mut conn = self.conn.lock();
        let tx = conn.begin_immediate().map_err(|e| e.to_string())?;
        let (session_id, anchor_turn_id, quote_raw, status, promoted_id, msgs_raw, created_at) = {
            let mut sel = tx
                .prepare(
                    "SELECT session_id, anchor_turn_id, quote_json, status, promoted_message_id, messages_json, created_at_ms
                     FROM ops_chat_btw WHERE btw_id = ?1;",
                )
                .map_err(|e| e.to_string())?;
            sel.bind_text(1, btw_id).map_err(|e| e.to_string())?;
            if !sel.step_row().map_err(|e| e.to_string())? {
                return Err(format!("chat btw thread '{btw_id}' not found"));
            }
            (
                sel.column_text(0).map_err(|e| e.to_string())?,
                sel.column_text(1).map_err(|e| e.to_string())?,
                sel.column_text(2).map_err(|e| e.to_string())?,
                sel.column_text(3).map_err(|e| e.to_string())?,
                sel.column_opt_text(4).map_err(|e| e.to_string())?,
                sel.column_text(5).map_err(|e| e.to_string())?,
                sel.column_int64(6).map_err(|e| e.to_string())?,
            )
        };
        let mut messages: Vec<Value> =
            serde_json::from_str(&msgs_raw).map_err(|e| e.to_string())?;
        let now = now_epoch_ms();
        messages.push(json!({
            "messageId": format!("msg_{}", uuid_v4()),
            "role": role.trim(),
            "content": SecretRedactor::redact(content.trim()),
            "createdAtMs": now,
        }));
        let updated_msgs = serde_json::to_string(&messages).map_err(|e| e.to_string())?;
        {
            let mut upd = tx
                .prepare(
                    "UPDATE ops_chat_btw SET messages_json = ?2, updated_at_ms = ?3 WHERE btw_id = ?1;",
                )
                .map_err(|e| e.to_string())?;
            upd.bind_text(1, btw_id).map_err(|e| e.to_string())?;
            upd.bind_text(2, &updated_msgs).map_err(|e| e.to_string())?;
            upd.bind_int64(3, now).map_err(|e| e.to_string())?;
            upd.step().map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        let quote: Value = serde_json::from_str(&quote_raw).unwrap_or_else(|_| json!({}));
        Ok(json!({
            "btwId": btw_id,
            "surface": "chat",
            "sessionId": session_id,
            "anchorTurnId": anchor_turn_id,
            "anchorQuote": quote,
            "status": status,
            "promotedMessageId": promoted_id,
            "messages": messages,
            "createdAtMs": created_at,
            "updatedAtMs": now,
        }))
    }

    pub fn list_chat_btw(&self, session_id: &str) -> Result<Vec<Value>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT btw_id, session_id, anchor_turn_id, quote_json, status, promoted_message_id, messages_json, created_at_ms, updated_at_ms
                 FROM ops_chat_btw WHERE session_id = ?1 ORDER BY created_at_ms ASC;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, session_id).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            let quote: Value =
                serde_json::from_str(&stmt.column_text(3).map_err(|e| e.to_string())?)
                    .unwrap_or_else(|_| json!({}));
            let msgs: Value =
                serde_json::from_str(&stmt.column_text(6).map_err(|e| e.to_string())?)
                    .unwrap_or_else(|_| json!([]));
            out.push(json!({
                "btwId": stmt.column_text(0).map_err(|e| e.to_string())?,
                "surface": "chat",
                "sessionId": stmt.column_text(1).map_err(|e| e.to_string())?,
                "anchorTurnId": stmt.column_text(2).map_err(|e| e.to_string())?,
                "anchorQuote": quote,
                "status": stmt.column_text(4).map_err(|e| e.to_string())?,
                "promotedMessageId": stmt.column_opt_text(5).map_err(|e| e.to_string())?,
                "messages": msgs,
                "createdAtMs": stmt.column_int64(7).map_err(|e| e.to_string())?,
                "updatedAtMs": stmt.column_int64(8).map_err(|e| e.to_string())?,
            }));
        }
        Ok(out)
    }

    pub fn upsert_kb_note(
        &self,
        slug: &str,
        title: &str,
        content: &str,
        tags: &[String],
    ) -> Result<KbNoteRecord, String> {
        let clean_slug = slug.trim().to_ascii_lowercase();
        if clean_slug.is_empty() || title.trim().is_empty() {
            return Err("kb note slug and title are required".into());
        }
        let safe_title = SecretRedactor::redact(title.trim());
        let safe_content = SecretRedactor::redact(content);
        let tags_json = serde_json::to_string(tags).map_err(|e| e.to_string())?;
        let outbound_links = extract_wikilinks(&safe_content);
        let links_json = serde_json::to_string(&outbound_links).map_err(|e| e.to_string())?;
        let now = now_epoch_ms();

        let mut conn = self.conn.lock();
        let tx = conn.begin_immediate().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO ops_kb_notes (slug, title, content, tags_json, outbound_links_json, updated_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(slug) DO UPDATE SET
                        title = excluded.title,
                        content = excluded.content,
                        tags_json = excluded.tags_json,
                        outbound_links_json = excluded.outbound_links_json,
                        updated_at_ms = excluded.updated_at_ms;",
                )
                .map_err(|e| e.to_string())?;
            stmt.bind_text(1, &clean_slug).map_err(|e| e.to_string())?;
            stmt.bind_text(2, &safe_title).map_err(|e| e.to_string())?;
            stmt.bind_text(3, &safe_content).map_err(|e| e.to_string())?;
            stmt.bind_text(4, &tags_json).map_err(|e| e.to_string())?;
            stmt.bind_text(5, &links_json).map_err(|e| e.to_string())?;
            stmt.bind_int64(6, now).map_err(|e| e.to_string())?;
            stmt.step().map_err(|e| e.to_string())?;
        }
        if self.fts_enabled {
            let _ = tx
                .prepare("DELETE FROM ops_kb_fts WHERE slug = ?1;")
                .and_then(|mut s| {
                    s.bind_text(1, &clean_slug)?;
                    s.step()
                });
            let _ = tx
                .prepare("INSERT INTO ops_kb_fts (slug, title, content, tags) VALUES (?1, ?2, ?3, ?4);")
                .and_then(|mut s| {
                    s.bind_text(1, &clean_slug)?;
                    s.bind_text(2, &safe_title)?;
                    s.bind_text(3, &safe_content)?;
                    s.bind_text(4, &tags.join(" "))?;
                    s.step()
                });
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(KbNoteRecord {
            slug: clean_slug,
            title: safe_title,
            content: safe_content,
            tags: tags.to_vec(),
            outbound_links,
            updated_at_ms: now,
        })
    }

    pub fn search_kb_notes(&self, query: Option<&str>) -> Result<Vec<KbNoteRecord>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT slug, title, content, tags_json, outbound_links_json, updated_at_ms
                 FROM ops_kb_notes ORDER BY updated_at_ms DESC;",
            )
            .map_err(|e| e.to_string())?;
        let needle = query.unwrap_or("").trim().to_ascii_lowercase();
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            let rec = KbNoteRecord {
                slug: stmt.column_text(0).map_err(|e| e.to_string())?,
                title: stmt.column_text(1).map_err(|e| e.to_string())?,
                content: stmt.column_text(2).map_err(|e| e.to_string())?,
                tags: serde_json::from_str(&stmt.column_text(3).map_err(|e| e.to_string())?)
                    .unwrap_or_default(),
                outbound_links: serde_json::from_str(
                    &stmt.column_text(4).map_err(|e| e.to_string())?,
                )
                .unwrap_or_default(),
                updated_at_ms: stmt.column_int64(5).map_err(|e| e.to_string())?,
            };
            if needle.is_empty()
                || rec.slug.to_ascii_lowercase().contains(&needle)
                || rec.title.to_ascii_lowercase().contains(&needle)
                || rec.content.to_ascii_lowercase().contains(&needle)
                || rec
                    .tags
                    .iter()
                    .any(|t| t.to_ascii_lowercase().contains(&needle))
            {
                out.push(rec);
            }
        }
        Ok(out)
    }

    pub fn create_paste(
        &self,
        title: &str,
        mime_type: &str,
        content: &str,
    ) -> Result<PasteRecord, String> {
        let safe_content = SecretRedactor::redact(content);
        let safe_title = SecretRedactor::redact(if title.trim().is_empty() {
            "Untitled Paste"
        } else {
            title.trim()
        });
        let sha256 = sha256_hex(safe_content.as_bytes());
        let paste_id = format!("pst_{}", &sha256[..16]);
        let byte_len = safe_content.len();
        let now = now_epoch_ms();

        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO ops_pastes (paste_id, sha256, title, mime_type, content, byte_len, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(paste_id) DO NOTHING;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &paste_id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &sha256).map_err(|e| e.to_string())?;
        stmt.bind_text(3, &safe_title).map_err(|e| e.to_string())?;
        stmt.bind_text(4, mime_type.trim())
            .map_err(|e| e.to_string())?;
        stmt.bind_text(5, &safe_content).map_err(|e| e.to_string())?;
        stmt.bind_int64(6, byte_len as i64)
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(7, now).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;

        Ok(PasteRecord {
            paste_id,
            sha256,
            title: safe_title,
            mime_type: mime_type.trim().to_string(),
            content: safe_content,
            byte_len,
            created_at_ms: now,
        })
    }

    pub fn get_paste(&self, paste_id: &str) -> Result<Option<PasteRecord>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT paste_id, sha256, title, mime_type, content, byte_len, created_at_ms
                 FROM ops_pastes WHERE paste_id = ?1;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, paste_id).map_err(|e| e.to_string())?;
        if stmt.step_row().map_err(|e| e.to_string())? {
            return Ok(Some(PasteRecord {
                paste_id: stmt.column_text(0).map_err(|e| e.to_string())?,
                sha256: stmt.column_text(1).map_err(|e| e.to_string())?,
                title: stmt.column_text(2).map_err(|e| e.to_string())?,
                mime_type: stmt.column_text(3).map_err(|e| e.to_string())?,
                content: stmt.column_text(4).map_err(|e| e.to_string())?,
                byte_len: stmt.column_int64(5).map_err(|e| e.to_string())?.max(0) as usize,
                created_at_ms: stmt.column_int64(6).map_err(|e| e.to_string())?,
            }));
        }
        Ok(None)
    }

    pub fn list_pastes(&self) -> Result<Vec<PasteRecord>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT paste_id, sha256, title, mime_type, content, byte_len, created_at_ms
                 FROM ops_pastes ORDER BY created_at_ms DESC LIMIT 100;",
            )
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            out.push(PasteRecord {
                paste_id: stmt.column_text(0).map_err(|e| e.to_string())?,
                sha256: stmt.column_text(1).map_err(|e| e.to_string())?,
                title: stmt.column_text(2).map_err(|e| e.to_string())?,
                mime_type: stmt.column_text(3).map_err(|e| e.to_string())?,
                content: stmt.column_text(4).map_err(|e| e.to_string())?,
                byte_len: stmt.column_int64(5).map_err(|e| e.to_string())?.max(0) as usize,
                created_at_ms: stmt.column_int64(6).map_err(|e| e.to_string())?,
            });
        }
        Ok(out)
    }

    pub fn create_kanban_task(
        &self,
        title: &str,
        description: &str,
        status: &str,
        priority: &str,
        tags: &[String],
        linked_session_id: Option<&str>,
    ) -> Result<KanbanTaskRecord, String> {
        if title.trim().is_empty() {
            return Err("kanban task title cannot be empty".into());
        }
        let mut conn = self.conn.lock();
        let tx = conn.begin_immediate().map_err(|e| e.to_string())?;
        let seq_num = {
            let mut s = tx
                .prepare("SELECT next_num FROM ops_kanban_seq WHERE id = 1;")
                .map_err(|e| e.to_string())?;
            if s.step_row().map_err(|e| e.to_string())? {
                s.column_int64(0).map_err(|e| e.to_string())?
            } else {
                1
            }
        };
        {
            let mut upd = tx
                .prepare("UPDATE ops_kanban_seq SET next_num = ?1 WHERE id = 1;")
                .map_err(|e| e.to_string())?;
            upd.bind_int64(1, seq_num + 1).map_err(|e| e.to_string())?;
            upd.step().map_err(|e| e.to_string())?;
        }
        let id = format!("tsk_{}", uuid_v4());
        let now = now_epoch_ms();
        let tags_json = serde_json::to_string(tags).map_err(|e| e.to_string())?;
        {
            let mut ins = tx
                .prepare(
                    "INSERT INTO ops_kanban_tasks
                     (id, seq_num, title, description, status, priority, tags_json, linked_session_id, created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9);",
                )
                .map_err(|e| e.to_string())?;
            ins.bind_text(1, &id).map_err(|e| e.to_string())?;
            ins.bind_int64(2, seq_num).map_err(|e| e.to_string())?;
            ins.bind_text(3, title.trim()).map_err(|e| e.to_string())?;
            ins.bind_text(4, description.trim())
                .map_err(|e| e.to_string())?;
            ins.bind_text(5, status.trim()).map_err(|e| e.to_string())?;
            ins.bind_text(6, priority.trim())
                .map_err(|e| e.to_string())?;
            ins.bind_text(7, &tags_json).map_err(|e| e.to_string())?;
            ins.bind_opt_text(8, linked_session_id)
                .map_err(|e| e.to_string())?;
            ins.bind_int64(9, now).map_err(|e| e.to_string())?;
            ins.step().map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(KanbanTaskRecord {
            id,
            seq_num,
            title: title.trim().to_string(),
            description: description.trim().to_string(),
            status: status.trim().to_string(),
            priority: priority.trim().to_string(),
            workspace_id: None,
            tags: tags.to_vec(),
            linked_session_id: linked_session_id.map(ToString::to_string),
            created_at_ms: now,
            updated_at_ms: now,
        })
    }

    pub fn list_kanban_tasks(&self) -> Result<Vec<KanbanTaskRecord>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, seq_num, title, description, status, priority, workspace_id, tags_json, linked_session_id, created_at_ms, updated_at_ms
                 FROM ops_kanban_tasks ORDER BY seq_num ASC;",
            )
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            out.push(KanbanTaskRecord {
                id: stmt.column_text(0).map_err(|e| e.to_string())?,
                seq_num: stmt.column_int64(1).map_err(|e| e.to_string())?,
                title: stmt.column_text(2).map_err(|e| e.to_string())?,
                description: stmt.column_text(3).map_err(|e| e.to_string())?,
                status: stmt.column_text(4).map_err(|e| e.to_string())?,
                priority: stmt.column_text(5).map_err(|e| e.to_string())?,
                workspace_id: stmt.column_opt_text(6).map_err(|e| e.to_string())?,
                tags: serde_json::from_str(&stmt.column_text(7).map_err(|e| e.to_string())?)
                    .unwrap_or_default(),
                linked_session_id: stmt.column_opt_text(8).map_err(|e| e.to_string())?,
                created_at_ms: stmt.column_int64(9).map_err(|e| e.to_string())?,
                updated_at_ms: stmt.column_int64(10).map_err(|e| e.to_string())?,
            });
        }
        Ok(out)
    }

    pub fn update_kanban_status(&self, id: &str, status: &str) -> Result<bool, String> {
        let now = now_epoch_ms();
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("UPDATE ops_kanban_tasks SET status = ?2, updated_at_ms = ?3 WHERE id = ?1;")
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, status.trim()).map_err(|e| e.to_string())?;
        stmt.bind_int64(3, now).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(conn.changes() > 0)
    }

    pub fn upsert_routine(
        &self,
        name: &str,
        prompt: &str,
        workspace_path: &str,
        schedule_expr: &str,
        isolation_mode: &str,
        model_spec: Option<&str>,
    ) -> Result<RoutineRecord, String> {
        if name.trim().is_empty() || prompt.trim().is_empty() {
            return Err("routine name and prompt are required".into());
        }
        let id = format!("rtn_{}", uuid_v4());
        let now = now_epoch_ms();
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO ops_routines
                 (id, name, prompt, workspace_path, schedule_expr, isolation_mode, model_spec, enabled, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8);",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, name.trim()).map_err(|e| e.to_string())?;
        stmt.bind_text(3, prompt.trim()).map_err(|e| e.to_string())?;
        stmt.bind_text(4, workspace_path.trim())
            .map_err(|e| e.to_string())?;
        stmt.bind_text(5, schedule_expr.trim())
            .map_err(|e| e.to_string())?;
        stmt.bind_text(6, isolation_mode.trim())
            .map_err(|e| e.to_string())?;
        stmt.bind_opt_text(7, model_spec)
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(8, now).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(RoutineRecord {
            id,
            name: name.trim().to_string(),
            prompt: prompt.trim().to_string(),
            workspace_path: workspace_path.trim().to_string(),
            schedule_expr: schedule_expr.trim().to_string(),
            isolation_mode: isolation_mode.trim().to_string(),
            model_spec: model_spec.map(ToString::to_string),
            enabled: true,
            last_run_at_ms: None,
            next_run_at_ms: None,
            created_at_ms: now,
        })
    }

    pub fn list_routines(&self) -> Result<Vec<RoutineRecord>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, prompt, workspace_path, schedule_expr, isolation_mode, model_spec, enabled, last_run_at_ms, next_run_at_ms, created_at_ms
                 FROM ops_routines ORDER BY created_at_ms DESC;",
            )
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            out.push(RoutineRecord {
                id: stmt.column_text(0).map_err(|e| e.to_string())?,
                name: stmt.column_text(1).map_err(|e| e.to_string())?,
                prompt: stmt.column_text(2).map_err(|e| e.to_string())?,
                workspace_path: stmt.column_text(3).map_err(|e| e.to_string())?,
                schedule_expr: stmt.column_text(4).map_err(|e| e.to_string())?,
                isolation_mode: stmt.column_text(5).map_err(|e| e.to_string())?,
                model_spec: stmt.column_opt_text(6).map_err(|e| e.to_string())?,
                enabled: stmt.column_int64(7).map_err(|e| e.to_string())? != 0,
                last_run_at_ms: stmt.column_opt_int64(8).ok().flatten(),
                next_run_at_ms: stmt.column_opt_int64(9).ok().flatten(),
                created_at_ms: stmt.column_int64(10).map_err(|e| e.to_string())?,
            });
        }
        Ok(out)
    }

    pub fn add_inbox_item(&self, content: &str, source: &str) -> Result<Value, String> {
        let id = format!("inb_{}", uuid_v4());
        let now = now_epoch_ms();
        let safe = SecretRedactor::redact(content.trim());
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("INSERT INTO ops_inbox_items (id, content, source, created_at_ms) VALUES (?1, ?2, ?3, ?4);")
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &safe).map_err(|e| e.to_string())?;
        stmt.bind_text(3, source.trim()).map_err(|e| e.to_string())?;
        stmt.bind_int64(4, now).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(json!({ "id": id, "content": safe, "source": source.trim(), "createdAtMs": now }))
    }

    pub fn list_inbox_items(&self) -> Result<Vec<Value>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, content, source, created_at_ms FROM ops_inbox_items ORDER BY created_at_ms DESC;")
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            out.push(json!({
                "id": stmt.column_text(0).map_err(|e| e.to_string())?,
                "content": stmt.column_text(1).map_err(|e| e.to_string())?,
                "source": stmt.column_text(2).map_err(|e| e.to_string())?,
                "createdAtMs": stmt.column_int64(3).map_err(|e| e.to_string())?,
            }));
        }
        Ok(out)
    }
}

/// Rich per-request / per-step AI telemetry record for lab-grade statistical forensics.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichUsageTraceInput {
    pub req_id: String,
    pub session_id: String,
    pub workspace: String,
    pub git_branch: String,
    pub role: String,
    pub provider_id: String,
    pub model_id: String,
    pub surface: String,
    pub wire_dialect: String,
    pub reasoning_effort: String,
    pub status: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cost_usd: f64,
    pub kv_savings_usd: Option<f64>,
    pub duration_ms: i64,
    pub ttft_ms: Option<i64>,
    pub tpot_ms: Option<f64>,
    pub active_decode_tps: f64,
    pub e2e_tps: f64,
    pub stall_retries: i64,
    pub hedge_wins: i64,
    pub prefix_hash: String,
    pub cache_bust_reason: Option<String>,
    pub context_window_fill_pct: Option<f64>,
    pub compaction_eta_turns: Option<i64>,
    pub is_error: bool,
    pub error_note: Option<String>,
    pub saved_tokens: i64,
    pub recorded_at_ms: Option<i64>,
}

/// Persisted `ops_steer_items` row tuple `(id, text, mode, status, created_at_ms)`.
pub type PersistedSteerRow = (String, String, String, String, i64);

/// Filter parameters for telemetry summaries and request waterfall queries.
#[derive(Debug, Clone, Default)]
pub struct TraceQueryFilter {
    pub window_ms: Option<i64>,
    pub model: Option<String>,
    pub role: Option<String>,
    pub session_id: Option<String>,
    pub limit: usize,
}

impl TraceQueryFilter {
    #[must_use]
    pub fn parse_window_ms(raw: Option<&str>) -> Option<i64> {
        match raw.map(str::trim).unwrap_or("all").to_ascii_lowercase().as_str() {
            "1h" | "60m" => Some(3_600_000),
            "24h" | "1d" => Some(86_400_000),
            "7d" | "1w" => Some(7 * 86_400_000),
            "15m" => Some(900_000),
            "5m" => Some(300_000),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
struct TraceRowInternal {
    trace_id: String,
    req_id: String,
    session_id: String,
    workspace: String,
    git_branch: String,
    role: String,
    provider_id: String,
    model_id: String,
    surface: String,
    wire_dialect: String,
    reasoning_effort: String,
    status: String,
    input_tokens: i64,
    output_tokens: i64,
    reasoning_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    cost_usd: f64,
    kv_savings_usd: f64,
    duration_ms: i64,
    ttft_ms: Option<i64>,
    tpot_ms: Option<f64>,
    active_decode_tps: f64,
    e2e_tps: f64,
    stall_retries: i64,
    hedge_wins: i64,
    prefix_hash: String,
    cache_bust_reason: Option<String>,
    context_window_fill_pct: Option<f64>,
    compaction_eta_turns: Option<i64>,
    is_error: bool,
    error_note: Option<String>,
    saved_tokens: i64,
    recorded_at_ms: i64,
}

fn round6(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

impl OpsStore {
    pub fn record_trace(&self, trace: &UsageTraceInput) -> Result<String, String> {
        let e2e_tps = if trace.duration_ms > 0 && trace.output_tokens > 0 {
            round2((trace.output_tokens as f64) / ((trace.duration_ms as f64) / 1000.0))
        } else {
            trace.tokens_per_second
        };
        let active_ms = trace
            .ttft_ms
            .map(|ttft| (trace.duration_ms - ttft).max(1))
            .unwrap_or(trace.duration_ms.max(1));
        let active_decode_tps = if trace.tokens_per_second > 0.0 {
            round2(trace.tokens_per_second)
        } else if trace.output_tokens > 0 {
            round2((trace.output_tokens as f64) / ((active_ms as f64) / 1000.0))
        } else {
            0.0
        };
        let tpot_ms = if trace.output_tokens > 1 {
            Some(round2((active_ms as f64) / ((trace.output_tokens - 1) as f64)))
        } else {
            None
        };
        let rich = RichUsageTraceInput {
            req_id: format!("req_{}", uuid_v4()),
            session_id: trace.session_id.clone(),
            workspace: String::new(),
            git_branch: String::new(),
            role: "main".to_string(),
            provider_id: trace.provider_id.clone(),
            model_id: trace.model_id.clone(),
            surface: trace.surface.clone(),
            wire_dialect: "auto".to_string(),
            reasoning_effort: "max".to_string(),
            status: if trace.is_error { "error" } else { "ok" }.to_string(),
            input_tokens: trace.input_tokens,
            output_tokens: trace.output_tokens,
            reasoning_tokens: 0,
            cache_read_tokens: trace.cache_read_tokens,
            cache_write_tokens: trace.cache_write_tokens,
            cost_usd: trace.cost_usd,
            kv_savings_usd: None,
            duration_ms: trace.duration_ms,
            ttft_ms: trace.ttft_ms,
            tpot_ms,
            active_decode_tps,
            e2e_tps,
            stall_retries: 0,
            hedge_wins: 0,
            prefix_hash: String::new(),
            cache_bust_reason: None,
            context_window_fill_pct: None,
            compaction_eta_turns: None,
            is_error: trace.is_error,
            error_note: trace.error_note.clone(),
            saved_tokens: trace.saved_tokens,
            recorded_at_ms: None,
        };
        self.record_rich_trace(&rich)
    }

    pub fn record_rich_trace(&self, trace: &RichUsageTraceInput) -> Result<String, String> {
        let trace_id = format!("trc_{}", uuid_v4());
        let req_id = if trace.req_id.trim().is_empty() {
            format!("req_{}", &trace_id[4..12])
        } else {
            trace.req_id.trim().to_string()
        };
        let now = trace.recorded_at_ms.unwrap_or_else(now_epoch_ms);
        let note = trace
            .error_note
            .as_deref()
            .map(SecretRedactor::redact);
        let kv_savings = round6(
            trace
                .kv_savings_usd
                .unwrap_or_else(|| estimate_kv_cache_savings_usd(&trace.model_id, trace.cache_read_tokens)),
        );
        let active_ms = trace
            .ttft_ms
            .map(|t| (trace.duration_ms - t).max(1))
            .unwrap_or(trace.duration_ms.max(1));
        let e2e_tps = if trace.e2e_tps > 0.0 {
            round2(trace.e2e_tps)
        } else if trace.duration_ms > 0 && trace.output_tokens > 0 {
            round2((trace.output_tokens as f64) / ((trace.duration_ms as f64) / 1000.0))
        } else {
            0.0
        };
        let active_tps = if trace.active_decode_tps > 0.0 {
            round2(trace.active_decode_tps)
        } else if trace.output_tokens > 0 {
            round2((trace.output_tokens as f64) / ((active_ms as f64) / 1000.0))
        } else {
            e2e_tps
        };
        let tpot_ms = trace.tpot_ms.or_else(|| {
            if trace.output_tokens > 1 {
                Some(round2((active_ms as f64) / ((trace.output_tokens - 1) as f64)))
            } else {
                None
            }
        });
        let status = if trace.status.trim().is_empty() {
            if trace.is_error { "error" } else { "ok" }
        } else {
            trace.status.trim()
        };
        let role = if trace.role.trim().is_empty() {
            "main"
        } else {
            trace.role.trim()
        };
        let dialect = if trace.wire_dialect.trim().is_empty() {
            "auto"
        } else {
            trace.wire_dialect.trim()
        };
        let effort = if trace.reasoning_effort.trim().is_empty() {
            "max"
        } else {
            trace.reasoning_effort.trim()
        };

        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO ops_usage_traces (
                    trace_id, session_id, provider_id, model_id, surface,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    cost_usd, duration_ms, ttft_ms, tokens_per_second,
                    is_error, error_note, saved_tokens, recorded_at_ms,
                    req_id, workspace, git_branch, role, wire_dialect, reasoning_effort,
                    status, tpot_ms, active_decode_tps, e2e_tps, reasoning_tokens,
                    stall_retries, hedge_wins, prefix_hash, cache_bust_reason,
                    context_window_fill_pct, compaction_eta_turns, kv_savings_usd
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5,
                    ?6, ?7, ?8, ?9,
                    ?10, ?11, ?12, ?13,
                    ?14, ?15, ?16, ?17,
                    ?18, ?19, ?20, ?21, ?22, ?23,
                    ?24, ?25, ?26, ?27, ?28,
                    ?29, ?30, ?31, ?32,
                    ?33, ?34, ?35
                 );",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &trace_id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &trace.session_id).map_err(|e| e.to_string())?;
        stmt.bind_text(3, &trace.provider_id).map_err(|e| e.to_string())?;
        stmt.bind_text(4, &trace.model_id).map_err(|e| e.to_string())?;
        stmt.bind_text(5, if trace.surface.is_empty() { "studio" } else { &trace.surface })
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(6, trace.input_tokens).map_err(|e| e.to_string())?;
        stmt.bind_int64(7, trace.output_tokens).map_err(|e| e.to_string())?;
        stmt.bind_int64(8, trace.cache_read_tokens).map_err(|e| e.to_string())?;
        stmt.bind_int64(9, trace.cache_write_tokens).map_err(|e| e.to_string())?;
        stmt.bind_double(10, round6(trace.cost_usd)).map_err(|e| e.to_string())?;
        stmt.bind_int64(11, trace.duration_ms).map_err(|e| e.to_string())?;
        match trace.ttft_ms {
            Some(v) => stmt.bind_int64(12, v).map_err(|e| e.to_string())?,
            None => stmt.bind_null(12).map_err(|e| e.to_string())?,
        }
        stmt.bind_double(13, active_tps).map_err(|e| e.to_string())?;
        stmt.bind_int64(14, i64::from(trace.is_error)).map_err(|e| e.to_string())?;
        stmt.bind_opt_text(15, note.as_deref()).map_err(|e| e.to_string())?;
        stmt.bind_int64(16, trace.saved_tokens).map_err(|e| e.to_string())?;
        stmt.bind_int64(17, now).map_err(|e| e.to_string())?;
        stmt.bind_text(18, &req_id).map_err(|e| e.to_string())?;
        stmt.bind_text(19, trace.workspace.trim()).map_err(|e| e.to_string())?;
        stmt.bind_text(20, trace.git_branch.trim()).map_err(|e| e.to_string())?;
        stmt.bind_text(21, role).map_err(|e| e.to_string())?;
        stmt.bind_text(22, dialect).map_err(|e| e.to_string())?;
        stmt.bind_text(23, effort).map_err(|e| e.to_string())?;
        stmt.bind_text(24, status).map_err(|e| e.to_string())?;
        match tpot_ms {
            Some(v) => stmt.bind_double(25, v).map_err(|e| e.to_string())?,
            None => stmt.bind_null(25).map_err(|e| e.to_string())?,
        }
        stmt.bind_double(26, active_tps).map_err(|e| e.to_string())?;
        stmt.bind_double(27, e2e_tps).map_err(|e| e.to_string())?;
        stmt.bind_int64(28, trace.reasoning_tokens).map_err(|e| e.to_string())?;
        stmt.bind_int64(29, trace.stall_retries).map_err(|e| e.to_string())?;
        stmt.bind_int64(30, trace.hedge_wins).map_err(|e| e.to_string())?;
        stmt.bind_text(31, trace.prefix_hash.trim()).map_err(|e| e.to_string())?;
        stmt.bind_opt_text(32, trace.cache_bust_reason.as_deref())
            .map_err(|e| e.to_string())?;
        match trace.context_window_fill_pct {
            Some(v) => stmt.bind_double(33, round2(v)).map_err(|e| e.to_string())?,
            None => stmt.bind_null(33).map_err(|e| e.to_string())?,
        }
        match trace.compaction_eta_turns {
            Some(v) => stmt.bind_int64(34, v).map_err(|e| e.to_string())?,
            None => stmt.bind_null(34).map_err(|e| e.to_string())?,
        }
        stmt.bind_double(35, kv_savings).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(trace_id)
    }

    fn load_filtered_traces(&self, filter: &TraceQueryFilter) -> Result<Vec<TraceRowInternal>, String> {
        let now = now_epoch_ms();
        let min_ts = filter.window_ms.map(|w| now.saturating_sub(w));
        let cap = if filter.limit == 0 {
            2_000i64
        } else {
            filter.limit.clamp(1, 5_000) as i64
        };
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT trace_id, req_id, session_id, workspace, git_branch, role,
                        provider_id, model_id, surface, wire_dialect, reasoning_effort, status,
                        input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
                        cost_usd, kv_savings_usd, duration_ms, ttft_ms, tpot_ms,
                        active_decode_tps, e2e_tps, tokens_per_second,
                        stall_retries, hedge_wins, prefix_hash, cache_bust_reason,
                        context_window_fill_pct, compaction_eta_turns,
                        is_error, error_note, saved_tokens, recorded_at_ms
                 FROM ops_usage_traces
                 ORDER BY recorded_at_ms DESC
                 LIMIT ?1;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(1, cap).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            let recorded_at_ms = stmt.column_int64(34).unwrap_or(0);
            if let Some(floor) = min_ts {
                if recorded_at_ms < floor {
                    continue;
                }
            }
            let session_id = stmt.column_text(2).unwrap_or_default();
            if let Some(ref want_s) = filter.session_id {
                if !want_s.is_empty() && !session_id.eq_ignore_ascii_case(want_s) {
                    continue;
                }
            }
            let role = stmt.column_text(5).unwrap_or_else(|_| "main".to_string());
            if let Some(ref want_r) = filter.role {
                if !want_r.is_empty() && !role.eq_ignore_ascii_case(want_r) {
                    continue;
                }
            }
            let model_id = stmt.column_text(7).unwrap_or_default();
            if let Some(ref want_m) = filter.model {
                if !want_m.is_empty() && !model_id.to_ascii_lowercase().contains(&want_m.to_ascii_lowercase()) {
                    continue;
                }
            }
            let tps_fallback = stmt.column_double(24).unwrap_or(0.0);
            let active_tps = stmt.column_double(22).unwrap_or(0.0);
            let e2e_tps = stmt.column_double(23).unwrap_or(0.0);
            let tpot_ms = if stmt.column_is_null(21) {
                None
            } else {
                stmt.column_double(21).ok()
            };
            let ctx_fill = if stmt.column_is_null(29) {
                None
            } else {
                stmt.column_double(29).ok()
            };
            let trace_id = stmt.column_text(0).unwrap_or_default();
            let raw_req = stmt.column_text(1).unwrap_or_default();
            let req_id = if raw_req.is_empty() { trace_id.clone() } else { raw_req };
            let cr = stmt.column_int64(15).unwrap_or(0);
            let kv_raw = stmt.column_double(18).unwrap_or(0.0);
            let kv_savings_usd = if kv_raw > 0.0 {
                round6(kv_raw)
            } else {
                estimate_kv_cache_savings_usd(&model_id, cr)
            };

            out.push(TraceRowInternal {
                trace_id,
                req_id,
                session_id,
                workspace: stmt.column_text(3).unwrap_or_default(),
                git_branch: stmt.column_text(4).unwrap_or_default(),
                role,
                provider_id: stmt.column_text(6).unwrap_or_default(),
                model_id,
                surface: stmt.column_text(8).unwrap_or_default(),
                wire_dialect: stmt.column_text(9).unwrap_or_else(|_| "auto".to_string()),
                reasoning_effort: stmt.column_text(10).unwrap_or_else(|_| "max".to_string()),
                status: stmt.column_text(11).unwrap_or_else(|_| "ok".to_string()),
                input_tokens: stmt.column_int64(12).unwrap_or(0),
                output_tokens: stmt.column_int64(13).unwrap_or(0),
                reasoning_tokens: stmt.column_int64(14).unwrap_or(0),
                cache_read_tokens: cr,
                cache_write_tokens: stmt.column_int64(16).unwrap_or(0),
                cost_usd: round6(stmt.column_double(17).unwrap_or(0.0)),
                kv_savings_usd,
                duration_ms: stmt.column_int64(19).unwrap_or(0),
                ttft_ms: stmt.column_opt_int64(20).ok().flatten(),
                tpot_ms,
                active_decode_tps: if active_tps > 0.0 { active_tps } else { tps_fallback },
                e2e_tps: if e2e_tps > 0.0 { e2e_tps } else { tps_fallback },
                stall_retries: stmt.column_int64(25).unwrap_or(0),
                hedge_wins: stmt.column_int64(26).unwrap_or(0),
                prefix_hash: stmt.column_text(27).unwrap_or_default(),
                cache_bust_reason: stmt.column_opt_text(28).ok().flatten(),
                context_window_fill_pct: ctx_fill,
                compaction_eta_turns: stmt.column_opt_int64(30).ok().flatten(),
                is_error: stmt.column_int64(31).unwrap_or(0) != 0,
                error_note: stmt.column_opt_text(32).ok().flatten(),
                saved_tokens: stmt.column_int64(33).unwrap_or(0),
                recorded_at_ms,
            });
        }
        Ok(out)
    }

    pub fn list_traces(&self, limit: usize) -> Result<Vec<Value>, String> {
        self.list_rich_traces(&TraceQueryFilter {
            limit: limit.clamp(1, 500),
            ..TraceQueryFilter::default()
        })
    }

    pub fn list_rich_traces(&self, filter: &TraceQueryFilter) -> Result<Vec<Value>, String> {
        let rows = self.load_filtered_traces(filter)?;
        let ttfts: Vec<f64> = rows.iter().filter_map(|r| r.ttft_ms.map(|v| v as f64)).collect();
        let durs: Vec<f64> = rows.iter().map(|r| r.duration_ms as f64).collect();
        let ttft_thr = compute_distribution(&ttfts, 2).outlier_threshold_high;
        let dur_thr = compute_distribution(&durs, 2).outlier_threshold_high;

        let cap = if filter.limit == 0 { 200 } else { filter.limit.clamp(1, 500) };
        Ok(rows
            .into_iter()
            .take(cap)
            .map(|r| {
                let ttft_outlier = ttft_thr
                    .zip(r.ttft_ms)
                    .is_some_and(|(thr, v)| (v as f64) > thr && thr > 0.0);
                let dur_outlier =
                    dur_thr.is_some_and(|thr| (r.duration_ms as f64) > thr && thr > 0.0);
                let is_outlier = ttft_outlier || dur_outlier;
                let denom = r.input_tokens + r.cache_read_tokens + r.cache_write_tokens;
                let cache_pct = if denom > 0 {
                    round2((r.cache_read_tokens as f64 / denom as f64) * 100.0)
                } else {
                    0.0
                };
                json!({
                    "traceId": r.trace_id,
                    "reqId": r.req_id,
                    "sessionId": r.session_id,
                    "workspace": r.workspace,
                    "gitBranch": r.git_branch,
                    "role": r.role,
                    "providerId": r.provider_id,
                    "provider": r.provider_id,
                    "modelId": r.model_id,
                    "model": r.model_id,
                    "surface": r.surface,
                    "wireDialect": r.wire_dialect,
                    "reasoningEffort": r.reasoning_effort,
                    "status": r.status,
                    "inputTokens": r.input_tokens,
                    "outputTokens": r.output_tokens,
                    "reasoningTokens": r.reasoning_tokens,
                    "cacheReadTokens": r.cache_read_tokens,
                    "cacheWriteTokens": r.cache_write_tokens,
                    "cacheHitPct": cache_pct,
                    "costUsd": r.cost_usd,
                    "kvSavingsUsd": r.kv_savings_usd,
                    "durationMs": r.duration_ms,
                    "ttftMs": r.ttft_ms,
                    "tpotMs": r.tpot_ms,
                    "tokensPerSecond": r.active_decode_tps,
                    "activeDecodeTps": r.active_decode_tps,
                    "e2eTps": r.e2e_tps,
                    "stallRetries": r.stall_retries,
                    "hedgeWins": r.hedge_wins,
                    "prefixHash": r.prefix_hash,
                    "cacheBustReason": r.cache_bust_reason,
                    "contextWindowFillPct": r.context_window_fill_pct,
                    "compactionEtaTurns": r.compaction_eta_turns,
                    "isOutlier": is_outlier,
                    "isError": r.is_error,
                    "errorNote": r.error_note,
                    "savedTokens": r.saved_tokens,
                    "recordedAtMs": r.recorded_at_ms,
                })
            })
            .collect())
    }

    /// Computes lab-grade statistical forensics, percentiles (`p50/p90/p95/p99/Min/Max/Mean/StdDev/IQR`),
    /// rolling RPM/TPM (`1m/5m/15m/1h/24h`), Prefix-0 cache trend & cache-bust attribution,
    /// context window fill / compaction ETA, and 6-decimal USD cost + KV savings.
    pub fn telemetry_summary(&self, filter: &TraceQueryFilter) -> Result<Value, String> {
        let rows = self.load_filtered_traces(&TraceQueryFilter {
            limit: 5_000,
            ..filter.clone()
        })?;
        let now = now_epoch_ms();

        let total_req = rows.len() as i64;
        let err_req = rows.iter().filter(|r| r.is_error).count() as i64;
        let ok_req = total_req - err_req;
        let in_tok: i64 = rows.iter().map(|r| r.input_tokens).sum();
        let out_tok: i64 = rows.iter().map(|r| r.output_tokens).sum();
        let reas_tok: i64 = rows.iter().map(|r| r.reasoning_tokens).sum();
        let cr_tok: i64 = rows.iter().map(|r| r.cache_read_tokens).sum();
        let cw_tok: i64 = rows.iter().map(|r| r.cache_write_tokens).sum();
        let saved_tok: i64 = rows.iter().map(|r| r.saved_tokens).sum();
        let total_cost: f64 = round6(rows.iter().map(|r| r.cost_usd).sum());
        let total_kv_savings: f64 = round6(rows.iter().map(|r| r.kv_savings_usd).sum());
        let total_retries: i64 = rows.iter().map(|r| r.stall_retries).sum();
        let total_hedge_wins: i64 = rows.iter().map(|r| r.hedge_wins).sum();

        let denom_in = in_tok + cr_tok + cw_tok;
        let cache_rate = if denom_in > 0 {
            round6((cr_tok as f64) / (denom_in as f64))
        } else {
            0.0
        };
        let error_rate = if total_req > 0 {
            round6((err_req as f64) / (total_req as f64))
        } else {
            0.0
        };

        let ttfts: Vec<f64> = rows.iter().filter_map(|r| r.ttft_ms.map(|v| v as f64)).collect();
        let tpots: Vec<f64> = rows.iter().filter_map(|r| r.tpot_ms).collect();
        let durs: Vec<f64> = rows.iter().map(|r| r.duration_ms as f64).collect();
        let active_tps: Vec<f64> = rows
            .iter()
            .filter(|r| r.active_decode_tps > 0.0)
            .map(|r| r.active_decode_tps)
            .collect();
        let e2e_tps: Vec<f64> = rows
            .iter()
            .filter(|r| r.e2e_tps > 0.0)
            .map(|r| r.e2e_tps)
            .collect();
        let costs: Vec<f64> = rows.iter().map(|r| r.cost_usd).collect();

        let dist_ttft = compute_distribution(&ttfts, 2);
        let dist_tpot = compute_distribution(&tpots, 2);
        let dist_dur = compute_distribution(&durs, 2);
        let dist_active_tps = compute_distribution(&active_tps, 2);
        let dist_e2e_tps = compute_distribution(&e2e_tps, 2);
        let dist_cost = compute_distribution(&costs, 6);

        // Rolling RPM / TPM windows (`1m`, `5m`, `15m`, `1h`, `24h`)
        let rolling = |window_mins: f64| -> Value {
            let cutoff = now.saturating_sub((window_mins * 60_000.0) as i64);
            let mut reqs = 0u64;
            let mut toks = 0i64;
            let mut cost = 0.0f64;
            for r in &rows {
                if r.recorded_at_ms >= cutoff {
                    reqs += 1;
                    toks += r.input_tokens + r.output_tokens + r.reasoning_tokens + r.cache_read_tokens;
                    cost += r.cost_usd;
                }
            }
            json!({
                "requests": reqs,
                "tokens": toks,
                "rpm": round2((reqs as f64) / window_mins),
                "tpm": round2((toks as f64) / window_mins),
                "costUsd": round6(cost),
            })
        };

        // Prefix-0 BLAKE3 cache trend (chronological last 40 requests) & cache-bust root causes
        let mut bust_counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut cache_trend: Vec<Value> = Vec::new();
        let mut prev_prefix: Option<&str> = None;
        for r in rows.iter().rev() {
            let d = r.input_tokens + r.cache_read_tokens + r.cache_write_tokens;
            let hit_pct = if d > 0 {
                round2((r.cache_read_tokens as f64 / d as f64) * 100.0)
            } else {
                0.0
            };
            let inferred_bust = if let Some(ref explicit) = r.cache_bust_reason {
                Some(explicit.clone())
            } else if !r.prefix_hash.is_empty() {
                if let Some(prev) = prev_prefix {
                    if prev != r.prefix_hash && hit_pct < 50.0 {
                        Some("prefix_hash_changed".to_string())
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };
            if let Some(ref reason) = inferred_bust {
                *bust_counts.entry(reason.clone()).or_insert(0) += 1;
            }
            if !r.prefix_hash.is_empty() {
                prev_prefix = Some(r.prefix_hash.as_str());
            }
            cache_trend.push(json!({
                "recordedAtMs": r.recorded_at_ms,
                "modelId": r.model_id,
                "prefixHash": r.prefix_hash,
                "cacheHitPct": hit_pct,
                "kvSavingsUsd": r.kv_savings_usd,
                "bustReason": inferred_bust,
            }));
        }
        if cache_trend.len() > 40 {
            cache_trend.drain(0..(cache_trend.len() - 40));
        }

        // Context window fill % + compaction ETA
        let latest_fill = rows.iter().find_map(|r| r.context_window_fill_pct);
        let peak_fill = rows
            .iter()
            .filter_map(|r| r.context_window_fill_pct)
            .reduce(f64::max)
            .map(round2);
        let compaction_eta = rows.iter().find_map(|r| r.compaction_eta_turns).or_else(|| {
            latest_fill.map(|pct| {
                let remaining = (85.0 - pct).max(0.0);
                (remaining / 6.0).ceil() as i64
            })
        });

        // Group breakdowns by Model and by Role
        let by_model = aggregate_group_breakdown(&rows, |r| r.model_id.clone());
        let by_role = aggregate_group_breakdown(&rows, |r| r.role.clone());

        let first_ts = rows.last().map(|r| r.recorded_at_ms).unwrap_or(0);
        let last_ts = rows.first().map(|r| r.recorded_at_ms).unwrap_or(0);

        Ok(json!({
            "totalRequests": total_req,
            "successfulRequests": ok_req,
            "failedRequests": err_req,
            "errorRate": error_rate,
            "totalInputTokens": in_tok,
            "totalOutputTokens": out_tok,
            "totalReasoningTokens": reas_tok,
            "totalCacheReadTokens": cr_tok,
            "totalCacheWriteTokens": cw_tok,
            "cacheRate": cache_rate,
            "cacheHitPct": round2(cache_rate * 100.0),
            "totalCost": total_cost,
            "totalCostUsd": total_cost,
            "kvSavingsUsd": total_kv_savings,
            "totalSavedTokens": saved_tok,
            "totalStallRetries": total_retries,
            "totalHedgeWins": total_hedge_wins,
            "avgDuration": dist_dur.mean,
            "avgTtft": dist_ttft.mean,
            "avgTokensPerSecond": dist_active_tps.mean,
            "firstTimestamp": first_ts,
            "lastTimestamp": last_ts,
            "distributions": {
                "ttftMs": dist_ttft,
                "tpotMs": dist_tpot,
                "durationMs": dist_dur,
                "activeDecodeTps": dist_active_tps,
                "e2eTps": dist_e2e_tps,
                "costUsd": dist_cost,
            },
            "rollingRates": {
                "m1": rolling(1.0),
                "m5": rolling(5.0),
                "m15": rolling(15.0),
                "h1": rolling(60.0),
                "h24": rolling(1_440.0),
            },
            "cacheTrend": cache_trend,
            "cacheBustReasons": bust_counts,
            "contextWindow": {
                "latestFillPct": latest_fill,
                "peakFillPct": peak_fill,
                "compactionEtaTurns": compaction_eta,
            },
            "byModel": by_model,
            "byRole": by_role,
        }))
    }

    /// Computes genuine SQLite aggregate statistics for `omp-stats` (`/api/stats/overview`,
    /// `/api/stats/spotlight`, `/api/traces`) — strictly 0/null when no runs are recorded!
    pub fn stats_snapshot(&self) -> Result<Value, String> {
        let mut summary = self.telemetry_summary(&TraceQueryFilter::default())?;
        let recent = self.list_traces(50)?;
        if let Some(obj) = summary.as_object_mut() {
            obj.insert("recentTraces".to_string(), Value::Array(recent));
        }
        Ok(summary)
    }

    // ---- Network Speedtest & Bufferbloat SQLite WAL Persistence ----

    pub fn save_speedtest(&self, result: &SpeedtestResult) -> Result<(), String> {
        let payload_json = serde_json::to_string(result).map_err(|e| e.to_string())?;
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO ops_network_speedtests (
                    run_id, profile, endpoint, provenance, cancelled,
                    unloaded_p50_ms, unloaded_p95_ms, unloaded_p99_ms, jitter_ms, loss_pct,
                    single_dl_mbps, multi_dl_mbps, download_mbps,
                    single_ul_mbps, multi_ul_mbps, upload_mbps,
                    dl_bloat_ms, ul_bloat_ms, worst_bloat_ms, bufferbloat_grade,
                    payload_json, started_at_ms, finished_at_ms
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5,
                    ?6, ?7, ?8, ?9, ?10,
                    ?11, ?12, ?13,
                    ?14, ?15, ?16,
                    ?17, ?18, ?19, ?20,
                    ?21, ?22, ?23
                 )
                 ON CONFLICT(run_id) DO UPDATE SET
                    cancelled = excluded.cancelled,
                    download_mbps = excluded.download_mbps,
                    upload_mbps = excluded.upload_mbps,
                    bufferbloat_grade = excluded.bufferbloat_grade,
                    payload_json = excluded.payload_json,
                    finished_at_ms = excluded.finished_at_ms;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &result.run_id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &result.profile).map_err(|e| e.to_string())?;
        stmt.bind_text(3, &result.endpoint).map_err(|e| e.to_string())?;
        stmt.bind_text(4, result.provenance.as_str()).map_err(|e| e.to_string())?;
        stmt.bind_int64(5, i64::from(result.cancelled)).map_err(|e| e.to_string())?;
        bind_opt_f64(&mut stmt, 6, result.unloaded.p50_ms)?;
        bind_opt_f64(&mut stmt, 7, result.unloaded.p95_ms)?;
        bind_opt_f64(&mut stmt, 8, result.unloaded.p99_ms)?;
        bind_opt_f64(&mut stmt, 9, result.unloaded.jitter_ms)?;
        stmt.bind_double(10, result.unloaded.loss_pct).map_err(|e| e.to_string())?;
        stmt.bind_double(11, result.single_stream_dl_mbps).map_err(|e| e.to_string())?;
        stmt.bind_double(12, result.multi_stream_dl_mbps).map_err(|e| e.to_string())?;
        stmt.bind_double(13, result.download_mbps).map_err(|e| e.to_string())?;
        stmt.bind_double(14, result.single_stream_ul_mbps).map_err(|e| e.to_string())?;
        stmt.bind_double(15, result.multi_stream_ul_mbps).map_err(|e| e.to_string())?;
        stmt.bind_double(16, result.upload_mbps).map_err(|e| e.to_string())?;
        stmt.bind_double(17, result.dl_bufferbloat_delta_ms).map_err(|e| e.to_string())?;
        stmt.bind_double(18, result.ul_bufferbloat_delta_ms).map_err(|e| e.to_string())?;
        stmt.bind_double(19, result.worst_bufferbloat_delta_ms).map_err(|e| e.to_string())?;
        stmt.bind_text(20, &result.bufferbloat_grade).map_err(|e| e.to_string())?;
        stmt.bind_text(21, &payload_json).map_err(|e| e.to_string())?;
        stmt.bind_int64(22, result.started_at_ms).map_err(|e| e.to_string())?;
        stmt.bind_int64(23, result.finished_at_ms).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_speedtests(&self, limit: usize) -> Result<Vec<SpeedtestResult>, String> {
        let cap = limit.clamp(1, 100) as i64;
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT payload_json FROM ops_network_speedtests
                 ORDER BY finished_at_ms DESC LIMIT ?1;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(1, cap).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            let raw = stmt.column_text(0).unwrap_or_default();
            if let Ok(parsed) = serde_json::from_str::<SpeedtestResult>(&raw) {
                out.push(parsed);
            }
        }
        Ok(out)
    }

    pub fn get_speedtest(&self, run_id: &str) -> Result<Option<SpeedtestResult>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT payload_json FROM ops_network_speedtests WHERE run_id = ?1;")
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, run_id.trim()).map_err(|e| e.to_string())?;
        if stmt.step_row().map_err(|e| e.to_string())? {
            let raw = stmt.column_text(0).unwrap_or_default();
            return Ok(serde_json::from_str::<SpeedtestResult>(&raw).ok());
        }
        Ok(None)
    }

    // ---- Router Failover / Circuit-Breaker Timeline Persistence ----

    pub fn record_router_event(
        &self,
        candidate_id: &str,
        provider_id: &str,
        action: &str,
        reason: &str,
        circuit_state: &str,
    ) -> Result<Value, String> {
        let id = format!("rev_{}", uuid_v4());
        let now = now_epoch_ms();
        let safe_reason = SecretRedactor::redact(reason.trim());
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO ops_router_failover_events
                 (id, candidate_id, provider_id, action, reason, circuit_state, recorded_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, candidate_id.trim()).map_err(|e| e.to_string())?;
        stmt.bind_text(3, provider_id.trim()).map_err(|e| e.to_string())?;
        stmt.bind_text(4, action.trim()).map_err(|e| e.to_string())?;
        stmt.bind_text(5, &safe_reason).map_err(|e| e.to_string())?;
        stmt.bind_text(6, circuit_state.trim()).map_err(|e| e.to_string())?;
        stmt.bind_int64(7, now).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(json!({
            "id": id,
            "candidateId": candidate_id.trim(),
            "providerId": provider_id.trim(),
            "action": action.trim(),
            "reason": safe_reason,
            "circuitState": circuit_state.trim(),
            "recordedAtMs": now,
        }))
    }

    pub fn list_router_events(&self, limit: usize) -> Result<Vec<Value>, String> {
        let cap = limit.clamp(1, 200) as i64;
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, candidate_id, provider_id, action, reason, circuit_state, recorded_at_ms
                 FROM ops_router_failover_events
                 ORDER BY recorded_at_ms DESC LIMIT ?1;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(1, cap).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            out.push(json!({
                "id": stmt.column_text(0).unwrap_or_default(),
                "candidateId": stmt.column_text(1).unwrap_or_default(),
                "providerId": stmt.column_text(2).unwrap_or_default(),
                "action": stmt.column_text(3).unwrap_or_default(),
                "reason": stmt.column_text(4).unwrap_or_default(),
                "circuitState": stmt.column_text(5).unwrap_or_default(),
                "recordedAtMs": stmt.column_int64(6).unwrap_or(0),
            }));
        }
        Ok(out)
    }

    // ---- Steer Queue Persistence (ADDITIVE_INTAKE, token_budget = NULL) ----

    pub fn upsert_steer_item(
        &self,
        id: &str,
        text: &str,
        mode: &str,
        status: &str,
        created_at_ms: i64,
    ) -> Result<(), String> {
        let now = now_epoch_ms();
        let safe_text = SecretRedactor::redact(text);
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO ops_steer_items (id, text, mode, status, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    updated_at_ms = excluded.updated_at_ms;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &safe_text).map_err(|e| e.to_string())?;
        stmt.bind_text(3, mode).map_err(|e| e.to_string())?;
        stmt.bind_text(4, status).map_err(|e| e.to_string())?;
        stmt.bind_int64(5, created_at_ms).map_err(|e| e.to_string())?;
        stmt.bind_int64(6, now).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_persisted_steer_items(&self) -> Result<Vec<PersistedSteerRow>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, text, mode, status, created_at_ms
                 FROM ops_steer_items ORDER BY created_at_ms ASC;",
            )
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            out.push((
                stmt.column_text(0).unwrap_or_default(),
                stmt.column_text(1).unwrap_or_default(),
                stmt.column_text(2).unwrap_or_default(),
                stmt.column_text(3).unwrap_or_default(),
                stmt.column_int64(4).unwrap_or(0),
            ));
        }
        Ok(out)
    }
}

fn bind_opt_f64(stmt: &mut omnia_winsqlite::Statement<'_>, idx: i32, val: Option<f64>) -> Result<(), String> {
    match val {
        Some(v) => stmt.bind_double(idx, v).map_err(|e| e.to_string()),
        None => stmt.bind_null(idx).map_err(|e| e.to_string()),
    }
}

fn aggregate_group_breakdown<F>(rows: &[TraceRowInternal], key_fn: F) -> Vec<Value>
where
    F: Fn(&TraceRowInternal) -> String,
{
    let mut grouped: BTreeMap<String, Vec<&TraceRowInternal>> = BTreeMap::new();
    for r in rows {
        grouped.entry(key_fn(r)).or_default().push(r);
    }
    let mut out = Vec::with_capacity(grouped.len());
    for (key, items) in grouped {
        let reqs = items.len();
        let errs = items.iter().filter(|r| r.is_error).count();
        let in_t: i64 = items.iter().map(|r| r.input_tokens).sum();
        let out_t: i64 = items.iter().map(|r| r.output_tokens).sum();
        let cr_t: i64 = items.iter().map(|r| r.cache_read_tokens).sum();
        let cw_t: i64 = items.iter().map(|r| r.cache_write_tokens).sum();
        let cost: f64 = round6(items.iter().map(|r| r.cost_usd).sum());
        let kv_saved: f64 = round6(items.iter().map(|r| r.kv_savings_usd).sum());
        let ttfts: Vec<f64> = items.iter().filter_map(|r| r.ttft_ms.map(|v| v as f64)).collect();
        let tps: Vec<f64> = items
            .iter()
            .filter(|r| r.active_decode_tps > 0.0)
            .map(|r| r.active_decode_tps)
            .collect();
        let ttft_dist = compute_distribution(&ttfts, 2);
        let tps_dist = compute_distribution(&tps, 2);
        let denom = in_t + cr_t + cw_t;
        let cache_pct = if denom > 0 {
            round2((cr_t as f64 / denom as f64) * 100.0)
        } else {
            0.0
        };
        out.push(json!({
            "key": key,
            "requests": reqs,
            "errorCount": errs,
            "errorRate": if reqs > 0 { round6(errs as f64 / reqs as f64) } else { 0.0 },
            "inputTokens": in_t,
            "outputTokens": out_t,
            "cacheReadTokens": cr_t,
            "cacheHitPct": cache_pct,
            "costUsd": cost,
            "kvSavingsUsd": kv_saved,
            "ttftP50Ms": ttft_dist.p50,
            "ttftP95Ms": ttft_dist.p95,
            "avgActiveDecodeTps": tps_dist.mean,
        }));
    }
    out.sort_by_key(|a| {
        std::cmp::Reverse(a.get("requests").and_then(Value::as_u64).unwrap_or(0))
    });
    out
}

fn extract_wikilinks(content: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else {
            break;
        };
        let target = after[..end]
            .split('|')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !target.is_empty() && !links.contains(&target) {
            links.push(target);
        }
        rest = &after[end + 2..];
    }
    links
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ops_store_persists_dual_roles_kb_pastes_kanban_and_zero_fake_stats() {
        let store = OpsStore::open_in_memory().expect("open ops store");
        let empty_stats = store.stats_snapshot().expect("empty stats");
        assert_eq!(empty_stats["totalRequests"], 0);
        assert!(empty_stats["avgTokensPerSecond"].is_null());

        store
            .set_model_role("main", "htmustc-claude", "claude-sonnet-5-5", "max")
            .expect("main role");
        store
            .set_model_role("subagent", "htmustc-gemini", "gemini-3.8-flash", "medium")
            .expect("subagent role");
        assert_eq!(store.list_model_roles().expect("roles").len(), 2);

        let note = store
            .upsert_kb_note(
                "wal-leases",
                "SQLite WAL",
                "Uses [[win32-lockfile]] leases.",
                &["sqlite".to_string()],
            )
            .expect("kb");
        assert_eq!(note.outbound_links, vec!["win32-lockfile"]);
        assert_eq!(store.search_kb_notes(Some("wal")).expect("search").len(), 1);

        let paste = store
            .create_paste("Log snippet", "text/plain", "line1\nline2")
            .expect("paste");
        assert_eq!(
            store.get_paste(&paste.paste_id).expect("get").unwrap().sha256,
            paste.sha256
        );

        // Verify xhigh/none/auto efforts + rich telemetry percentiles, outliers & KV savings
        store
            .set_model_role("architect", "htmustc-codex", "gpt-6.2-sol", "xhigh")
            .expect("xhigh effort");

        for (i, ttft) in [180i64, 210, 195, 220, 205, 1900].iter().enumerate() {
            store
                .record_rich_trace(&RichUsageTraceInput {
                    req_id: format!("req_dummy_{i}"),
                    session_id: "sess_dummy_1".to_string(),
                    workspace: "D:/Omnia".to_string(),
                    git_branch: "omnia-sota-harness".to_string(),
                    role: "main".to_string(),
                    provider_id: "htmustc".to_string(),
                    model_id: "claude-sonnet-5-5".to_string(),
                    surface: "studio".to_string(),
                    wire_dialect: "anthropic-messages".to_string(),
                    reasoning_effort: "max".to_string(),
                    status: "ok".to_string(),
                    input_tokens: 1_000,
                    output_tokens: 400,
                    reasoning_tokens: 120,
                    cache_read_tokens: if i == 0 { 0 } else { 8_000 },
                    cache_write_tokens: 200,
                    cost_usd: 0.012345,
                    kv_savings_usd: None,
                    duration_ms: ttft + 1_200,
                    ttft_ms: Some(*ttft),
                    tpot_ms: Some(3.0),
                    active_decode_tps: 82.5,
                    e2e_tps: 64.0,
                    stall_retries: i64::from(i == 5),
                    hedge_wins: 0,
                    prefix_hash: if i < 4 { "abc123" } else { "def456" }.to_string(),
                    cache_bust_reason: if i == 4 { Some("system_prompt_edited".into()) } else { None },
                    context_window_fill_pct: Some(42.5),
                    compaction_eta_turns: Some(7),
                    is_error: false,
                    error_note: None,
                    saved_tokens: 8_000,
                    recorded_at_ms: None,
                })
                .expect("rich trace");
        }
        let summary = store
            .telemetry_summary(&TraceQueryFilter::default())
            .expect("summary");
        assert_eq!(summary["totalRequests"], 6);
        assert_eq!(summary["distributions"]["ttftMs"]["outlierCount"], 1);
        assert!(summary["kvSavingsUsd"].as_f64().unwrap() > 0.0);
        assert_eq!(summary["cacheBustReasons"]["system_prompt_edited"], 1);
        let traces = store
            .list_rich_traces(&TraceQueryFilter::default())
            .expect("traces");
        assert_eq!(traces.len(), 6);
        assert!(traces.iter().any(|t| t["isOutlier"] == true));

        // Router failover timeline & steer persistence
        let ev = store
            .record_router_event("htmustc:gpt-6.2-sol", "htmustc", "trip", "synthetic_test", "Open")
            .expect("router event");
        assert_eq!(ev["circuitState"], "Open");
        assert_eq!(store.list_router_events(10).expect("list events").len(), 1);

        store
            .upsert_steer_item("st_1", "Synthetic steer item", "ADDITIVE_INTAKE", "queued", 1000)
            .expect("steer upsert");
        assert_eq!(store.list_persisted_steer_items().expect("steer list").len(), 1);
    }
}
