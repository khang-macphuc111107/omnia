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

CREATE TABLE IF NOT EXISTS arena_runs (
    run_id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    system_prompt TEXT NOT NULL DEFAULT '',
    models_json TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    outputs_json TEXT NOT NULL DEFAULT '[]',
    winner_model TEXT,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS arena_votes (
    vote_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    winner_model TEXT NOT NULL,
    loser_models_json TEXT NOT NULL DEFAULT '[]',
    is_tie INTEGER NOT NULL DEFAULT 0,
    elo_delta REAL NOT NULL DEFAULT 0.0,
    note TEXT NOT NULL DEFAULT '',
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_personas (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'sparkles',
    description TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT 'claude-sonnet-5-5',
    effort TEXT NOT NULL DEFAULT 'max',
    temperature REAL NOT NULL DEFAULT 0.7,
    top_p REAL NOT NULL DEFAULT 0.95,
    system_prompt TEXT NOT NULL DEFAULT '',
    focus_mode TEXT NOT NULL DEFAULT 'solo',
    pinned_files_json TEXT NOT NULL DEFAULT '[]',
    is_builtin INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_branches (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_msg_id TEXT NOT NULL DEFAULT '',
    branch_index INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'assistant',
    content TEXT NOT NULL,
    model_id TEXT NOT NULL DEFAULT '',
    effort TEXT NOT NULL DEFAULT 'max',
    thinking_text TEXT NOT NULL DEFAULT '',
    tool_calls_json TEXT NOT NULL DEFAULT '[]',
    created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_branches_session
    ON chat_branches (session_id, parent_msg_id, branch_index);

CREATE TABLE IF NOT EXISTS ops_peer_mesh_agents (
    agent_id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    owned_paths_json TEXT NOT NULL DEFAULT '[]',
    excluded_paths_json TEXT NOT NULL DEFAULT '[]',
    epoch INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_peer_mesh_edges (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    channel_label TEXT NOT NULL DEFAULT 'duplex-mesh',
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id)
);

CREATE TABLE IF NOT EXISTS ops_peer_mesh_messages (
    seq INTEGER PRIMARY KEY,
    from_id TEXT NOT NULL,
    recipients_json TEXT NOT NULL DEFAULT '[]',
    epoch INTEGER NOT NULL DEFAULT 1,
    hop_count INTEGER NOT NULL DEFAULT 0,
    max_hops INTEGER NOT NULL DEFAULT 4,
    in_reply_to_seq INTEGER,
    topic TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL,
    sent_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_peer_mesh_msg_sent
    ON ops_peer_mesh_messages (sent_at_ms DESC, seq ASC);

CREATE TABLE IF NOT EXISTS ops_routine_runs (
    run_id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL,
    status TEXT NOT NULL,
    scheduled_for_ms INTEGER,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_ops_routine_runs_routine
    ON ops_routine_runs (routine_id, started_at_ms DESC);
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRunRecord {
    pub run_id: String,
    pub routine_id: String,
    pub status: String,
    pub scheduled_for_ms: Option<i64>,
    pub started_at_ms: i64,
    pub finished_at_ms: i64,
    pub summary: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerMeshAgentRecord {
    pub agent_id: String,
    pub role: String,
    pub owned_paths: Vec<String>,
    pub excluded_paths: Vec<String>,
    pub epoch: u64,
    pub active: bool,
    pub last_read_seq: u64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerMeshEdgeRecord {
    pub from_id: String,
    pub to_id: String,
    pub channel_label: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerMeshMessageRecord {
    pub seq: u64,
    pub from_id: String,
    pub recipients: Vec<String>,
    pub epoch: u64,
    pub hop_count: u32,
    pub max_hops: u32,
    pub in_reply_to_seq: Option<u64>,
    pub topic: String,
    pub payload: String,
    pub sent_at_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerMeshSnapshotRecord {
    pub agents: Vec<PeerMeshAgentRecord>,
    pub edges: Vec<PeerMeshEdgeRecord>,
    pub messages: Vec<PeerMeshMessageRecord>,
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
        seed_builtin_studio_personas(&conn)?;
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
        let next_run_at_ms = compute_next_cron_run_ms(schedule_expr.trim(), now).ok();
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO ops_routines
                 (id, name, prompt, workspace_path, schedule_expr, isolation_mode, model_spec, enabled, next_run_at_ms, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9);",
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
        stmt.bind_opt_int64(8, next_run_at_ms)
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(9, now).map_err(|e| e.to_string())?;
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
            next_run_at_ms,
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

    pub fn record_routine_run(&self, run: &RoutineRunRecord) -> Result<(), String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO ops_routine_runs
                 (run_id, routine_id, status, scheduled_for_ms, started_at_ms, finished_at_ms, summary, error)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(run_id) DO UPDATE SET
                    status = excluded.status,
                    finished_at_ms = excluded.finished_at_ms,
                    summary = excluded.summary,
                    error = excluded.error;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &run.run_id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &run.routine_id).map_err(|e| e.to_string())?;
        stmt.bind_text(3, &run.status).map_err(|e| e.to_string())?;
        stmt.bind_opt_int64(4, run.scheduled_for_ms)
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(5, run.started_at_ms).map_err(|e| e.to_string())?;
        stmt.bind_int64(6, run.finished_at_ms).map_err(|e| e.to_string())?;
        stmt.bind_text(7, &run.summary).map_err(|e| e.to_string())?;
        stmt.bind_opt_text(8, run.error.as_deref())
            .map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_routine_runs(
        &self,
        routine_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<RoutineRunRecord>, String> {
        let cap = limit.clamp(1, 200) as i64;
        let conn = self.conn.lock();
        let mut stmt = if routine_id.is_some() {
            conn.prepare(
                "SELECT run_id, routine_id, status, scheduled_for_ms, started_at_ms, finished_at_ms, summary, error
                 FROM ops_routine_runs WHERE routine_id = ?1 ORDER BY started_at_ms DESC LIMIT ?2;",
            )
        } else {
            conn.prepare(
                "SELECT run_id, routine_id, status, scheduled_for_ms, started_at_ms, finished_at_ms, summary, error
                 FROM ops_routine_runs ORDER BY started_at_ms DESC LIMIT ?1;",
            )
        }
        .map_err(|e| e.to_string())?;
        if let Some(rid) = routine_id {
            stmt.bind_text(1, rid).map_err(|e| e.to_string())?;
            stmt.bind_int64(2, cap).map_err(|e| e.to_string())?;
        } else {
            stmt.bind_int64(1, cap).map_err(|e| e.to_string())?;
        }
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            out.push(RoutineRunRecord {
                run_id: stmt.column_text(0).map_err(|e| e.to_string())?,
                routine_id: stmt.column_text(1).map_err(|e| e.to_string())?,
                status: stmt.column_text(2).map_err(|e| e.to_string())?,
                scheduled_for_ms: stmt.column_opt_int64(3).ok().flatten(),
                started_at_ms: stmt.column_int64(4).map_err(|e| e.to_string())?,
                finished_at_ms: stmt.column_int64(5).map_err(|e| e.to_string())?,
                summary: stmt.column_text(6).map_err(|e| e.to_string())?,
                error: stmt.column_opt_text(7).map_err(|e| e.to_string())?,
            });
        }
        Ok(out)
    }

    /// Evaluates enabled routines against Vixie 5-field cron (and `@every`/`@hourly`/... aliases),
    /// records due trigger receipts into `ops_routine_runs`, and advances `next_run_at_ms`.
    pub fn evaluate_due_routines(&self, now_ms: i64) -> Result<Vec<RoutineRunRecord>, String> {
        let routines = self.list_routines()?;
        let mut runs = Vec::new();
        for rtn in routines {
            if !rtn.enabled {
                continue;
            }
            let Some(due_ms) = rtn.next_run_at_ms else {
                if let Ok(initial_next) = compute_next_cron_run_ms(&rtn.schedule_expr, now_ms) {
                    let conn = self.conn.lock();
                    let mut upd = conn
                        .prepare("UPDATE ops_routines SET next_run_at_ms = ?1 WHERE id = ?2;")
                        .map_err(|e| e.to_string())?;
                    upd.bind_int64(1, initial_next).map_err(|e| e.to_string())?;
                    upd.bind_text(2, &rtn.id).map_err(|e| e.to_string())?;
                    upd.step().map_err(|e| e.to_string())?;
                }
                continue;
            };
            if due_ms > now_ms {
                continue;
            }
            let next_after = compute_next_cron_run_ms(&rtn.schedule_expr, now_ms).ok();
            let run = RoutineRunRecord {
                run_id: format!("rrun_{}", uuid_v4()),
                routine_id: rtn.id.clone(),
                status: "triggered".to_string(),
                scheduled_for_ms: Some(due_ms),
                started_at_ms: now_ms,
                finished_at_ms: now_ms,
                summary: SecretRedactor::redact(&format!(
                    "Scheduled routine '{}' ({}) fired at {now_ms}",
                    rtn.name, rtn.schedule_expr
                )),
                error: None,
            };
            self.record_routine_run(&run)?;
            {
                let conn = self.conn.lock();
                let mut upd = conn
                    .prepare(
                        "UPDATE ops_routines SET last_run_at_ms = ?1, next_run_at_ms = ?2 WHERE id = ?3;",
                    )
                    .map_err(|e| e.to_string())?;
                upd.bind_int64(1, now_ms).map_err(|e| e.to_string())?;
                upd.bind_opt_int64(2, next_after)
                    .map_err(|e| e.to_string())?;
                upd.bind_text(3, &rtn.id).map_err(|e| e.to_string())?;
                upd.step().map_err(|e| e.to_string())?;
            }
            runs.push(run);
        }
        Ok(runs)
    }

    pub fn save_peer_mesh_agent(&self, agent: &PeerMeshAgentRecord) -> Result<(), String> {
        let owned_json = serde_json::to_string(&agent.owned_paths).unwrap_or_else(|_| "[]".into());
        let excl_json = serde_json::to_string(&agent.excluded_paths).unwrap_or_else(|_| "[]".into());
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO ops_peer_mesh_agents
                 (agent_id, role, owned_paths_json, excluded_paths_json, epoch, active, last_read_seq, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(agent_id) DO UPDATE SET
                    role = excluded.role,
                    owned_paths_json = excluded.owned_paths_json,
                    excluded_paths_json = excluded.excluded_paths_json,
                    epoch = excluded.epoch,
                    active = excluded.active,
                    last_read_seq = excluded.last_read_seq,
                    updated_at_ms = excluded.updated_at_ms;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &agent.agent_id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &agent.role).map_err(|e| e.to_string())?;
        stmt.bind_text(3, &owned_json).map_err(|e| e.to_string())?;
        stmt.bind_text(4, &excl_json).map_err(|e| e.to_string())?;
        stmt.bind_int64(5, agent.epoch as i64).map_err(|e| e.to_string())?;
        stmt.bind_int64(6, if agent.active { 1 } else { 0 })
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(7, agent.last_read_seq as i64)
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(8, agent.updated_at_ms)
            .map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn save_peer_mesh_edge(&self, edge: &PeerMeshEdgeRecord) -> Result<(), String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO ops_peer_mesh_edges (from_id, to_id, channel_label, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(from_id, to_id) DO UPDATE SET
                    channel_label = excluded.channel_label,
                    updated_at_ms = excluded.updated_at_ms;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &edge.from_id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &edge.to_id).map_err(|e| e.to_string())?;
        stmt.bind_text(3, &edge.channel_label)
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(4, edge.updated_at_ms)
            .map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn save_peer_mesh_message(&self, msg: &PeerMeshMessageRecord) -> Result<(), String> {
        let recipients_json =
            serde_json::to_string(&msg.recipients).unwrap_or_else(|_| "[]".into());
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO ops_peer_mesh_messages
                 (seq, from_id, recipients_json, epoch, hop_count, max_hops, in_reply_to_seq, topic, payload, sent_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(seq) DO UPDATE SET
                    from_id = excluded.from_id,
                    recipients_json = excluded.recipients_json,
                    epoch = excluded.epoch,
                    hop_count = excluded.hop_count,
                    max_hops = excluded.max_hops,
                    in_reply_to_seq = excluded.in_reply_to_seq,
                    topic = excluded.topic,
                    payload = excluded.payload,
                    sent_at_ms = excluded.sent_at_ms;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(1, msg.seq as i64).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &msg.from_id).map_err(|e| e.to_string())?;
        stmt.bind_text(3, &recipients_json)
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(4, msg.epoch as i64).map_err(|e| e.to_string())?;
        stmt.bind_int64(5, i64::from(msg.hop_count))
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(6, i64::from(msg.max_hops))
            .map_err(|e| e.to_string())?;
        stmt.bind_opt_int64(7, msg.in_reply_to_seq.map(|v| v as i64))
            .map_err(|e| e.to_string())?;
        stmt.bind_text(8, &msg.topic).map_err(|e| e.to_string())?;
        stmt.bind_text(9, &msg.payload).map_err(|e| e.to_string())?;
        stmt.bind_int64(10, msg.sent_at_ms)
            .map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_peer_mesh_messages_since(
        &self,
        since_seq: u64,
    ) -> Result<Vec<PeerMeshMessageRecord>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT seq, from_id, recipients_json, epoch, hop_count, max_hops, in_reply_to_seq, topic, payload, sent_at_ms
                 FROM ops_peer_mesh_messages WHERE seq > ?1 ORDER BY seq ASC;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(1, since_seq as i64)
            .map_err(|e| e.to_string())?;
        let mut messages = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            let recipients_raw = stmt.column_text(2).map_err(|e| e.to_string())?;
            let recipients: Vec<String> =
                serde_json::from_str(&recipients_raw).unwrap_or_default();
            messages.push(PeerMeshMessageRecord {
                seq: stmt.column_int64(0).map_err(|e| e.to_string())?.max(0) as u64,
                from_id: stmt.column_text(1).map_err(|e| e.to_string())?,
                recipients,
                epoch: stmt.column_int64(3).map_err(|e| e.to_string())?.max(0) as u64,
                hop_count: stmt.column_int64(4).map_err(|e| e.to_string())?.max(0) as u32,
                max_hops: stmt.column_int64(5).map_err(|e| e.to_string())?.max(0) as u32,
                in_reply_to_seq: stmt
                    .column_opt_int64(6)
                    .ok()
                    .flatten()
                    .and_then(|v| u64::try_from(v).ok()),
                topic: stmt.column_text(7).map_err(|e| e.to_string())?,
                payload: stmt.column_text(8).map_err(|e| e.to_string())?,
                sent_at_ms: stmt.column_int64(9).map_err(|e| e.to_string())?,
            });
        }
        Ok(messages)
    }

    pub fn load_peer_mesh_snapshot(&self) -> Result<PeerMeshSnapshotRecord, String> {
        let messages = self.list_peer_mesh_messages_since(0)?;
        let conn = self.conn.lock();
        let mut agents = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT agent_id, role, owned_paths_json, excluded_paths_json, epoch, active, last_read_seq, updated_at_ms
                     FROM ops_peer_mesh_agents ORDER BY agent_id ASC;",
                )
                .map_err(|e| e.to_string())?;
            while stmt.step_row().map_err(|e| e.to_string())? {
                let owned_raw = stmt.column_text(2).map_err(|e| e.to_string())?;
                let excl_raw = stmt.column_text(3).map_err(|e| e.to_string())?;
                agents.push(PeerMeshAgentRecord {
                    agent_id: stmt.column_text(0).map_err(|e| e.to_string())?,
                    role: stmt.column_text(1).map_err(|e| e.to_string())?,
                    owned_paths: serde_json::from_str(&owned_raw).unwrap_or_default(),
                    excluded_paths: serde_json::from_str(&excl_raw).unwrap_or_default(),
                    epoch: stmt.column_int64(4).map_err(|e| e.to_string())?.max(1) as u64,
                    active: stmt.column_int64(5).map_err(|e| e.to_string())? != 0,
                    last_read_seq: stmt.column_int64(6).map_err(|e| e.to_string())?.max(0) as u64,
                    updated_at_ms: stmt.column_int64(7).map_err(|e| e.to_string())?,
                });
            }
        }
        let mut edges = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT from_id, to_id, channel_label, updated_at_ms
                     FROM ops_peer_mesh_edges ORDER BY from_id ASC, to_id ASC;",
                )
                .map_err(|e| e.to_string())?;
            while stmt.step_row().map_err(|e| e.to_string())? {
                edges.push(PeerMeshEdgeRecord {
                    from_id: stmt.column_text(0).map_err(|e| e.to_string())?,
                    to_id: stmt.column_text(1).map_err(|e| e.to_string())?,
                    channel_label: stmt.column_text(2).map_err(|e| e.to_string())?,
                    updated_at_ms: stmt.column_int64(3).map_err(|e| e.to_string())?,
                });
            }
        }
        Ok(PeerMeshSnapshotRecord {
            agents,
            edges,
            messages,
        })
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

    // ---- Steer #23: AI Studio Multi-Model Arena, Elo Leaderboard, Gems/Personas & Chat Branches ----

    pub fn save_arena_run(&self, input: &ArenaRunInput) -> Result<ArenaRunRecord, String> {
        let prompt = SecretRedactor::redact(input.prompt.trim());
        if prompt.is_empty() {
            return Err("arena prompt cannot be empty".into());
        }
        let system_prompt = SecretRedactor::redact(input.system_prompt.trim());
        let run_id = input
            .run_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("arn_{}", uuid_v4()));
        let models: Vec<String> = input
            .models
            .iter()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .collect();
        let params = SecretRedactor::redact_json(&input.params);
        let outputs = SecretRedactor::redact_json(&input.outputs);
        let models_json = serde_json::to_string(&models).map_err(|e| e.to_string())?;
        let params_json = serde_json::to_string(&params).map_err(|e| e.to_string())?;
        let outputs_json = serde_json::to_string(&outputs).map_err(|e| e.to_string())?;
        let now = now_epoch_ms();

        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO arena_runs
                 (run_id, prompt, system_prompt, models_json, params_json, outputs_json, winner_model, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)
                 ON CONFLICT(run_id) DO UPDATE SET
                    prompt = excluded.prompt,
                    system_prompt = excluded.system_prompt,
                    models_json = excluded.models_json,
                    params_json = excluded.params_json,
                    outputs_json = excluded.outputs_json;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &run_id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &prompt).map_err(|e| e.to_string())?;
        stmt.bind_text(3, &system_prompt).map_err(|e| e.to_string())?;
        stmt.bind_text(4, &models_json).map_err(|e| e.to_string())?;
        stmt.bind_text(5, &params_json).map_err(|e| e.to_string())?;
        stmt.bind_text(6, &outputs_json).map_err(|e| e.to_string())?;
        stmt.bind_int64(7, now).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;

        Ok(ArenaRunRecord {
            run_id,
            prompt,
            system_prompt,
            models,
            params,
            outputs,
            winner_model: None,
            created_at_ms: now,
        })
    }

    pub fn get_arena_run(&self, run_id: &str) -> Result<Option<ArenaRunRecord>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT run_id, prompt, system_prompt, models_json, params_json, outputs_json, winner_model, created_at_ms
                 FROM arena_runs WHERE run_id = ?1;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, run_id.trim()).map_err(|e| e.to_string())?;
        if stmt.step_row().map_err(|e| e.to_string())? {
            return Ok(Some(read_arena_run_row(&stmt)?));
        }
        Ok(None)
    }

    pub fn list_arena_runs(&self, limit: usize) -> Result<Vec<ArenaRunRecord>, String> {
        let cap = limit.clamp(1, 200) as i64;
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT run_id, prompt, system_prompt, models_json, params_json, outputs_json, winner_model, created_at_ms
                 FROM arena_runs ORDER BY created_at_ms DESC LIMIT ?1;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(1, cap).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            out.push(read_arena_run_row(&stmt)?);
        }
        Ok(out)
    }

    pub fn record_arena_vote(&self, input: &ArenaVoteInput) -> Result<ArenaVoteRecord, String> {
        let winner = input.winner_model.trim().to_string();
        if winner.is_empty() {
            return Err("winner_model is required".into());
        }
        let losers: Vec<String> = input
            .loser_models
            .iter()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty() && m != &winner)
            .collect();
        let run_id = input.run_id.trim().to_string();
        let safe_note = SecretRedactor::redact(input.note.as_deref().unwrap_or("").trim());
        let vote_id = format!("avt_{}", uuid_v4());
        let now = now_epoch_ms();

        let mut conn = self.conn.lock();
        let current_ratings = compute_elo_ratings_from_conn(&conn)?;
        let winner_elo = *current_ratings.get(&winner).unwrap_or(&ARENA_BASE_ELO);
        let mut total_delta = 0.0_f64;
        let actual_score = if input.is_tie { 0.5 } else { 1.0 };
        for opp in &losers {
            let opp_elo = *current_ratings.get(opp).unwrap_or(&ARENA_BASE_ELO);
            let expected = 1.0 / (1.0 + 10.0_f64.powf((opp_elo - winner_elo) / 400.0));
            total_delta += ARENA_ELO_K * (actual_score - expected);
        }
        let elo_delta = round2(total_delta);
        let losers_json = serde_json::to_string(&losers).map_err(|e| e.to_string())?;

        let tx = conn.begin_immediate().map_err(|e| e.to_string())?;
        {
            let mut ins = tx
                .prepare(
                    "INSERT INTO arena_votes
                     (vote_id, run_id, winner_model, loser_models_json, is_tie, elo_delta, note, created_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);",
                )
                .map_err(|e| e.to_string())?;
            ins.bind_text(1, &vote_id).map_err(|e| e.to_string())?;
            ins.bind_text(2, &run_id).map_err(|e| e.to_string())?;
            ins.bind_text(3, &winner).map_err(|e| e.to_string())?;
            ins.bind_text(4, &losers_json).map_err(|e| e.to_string())?;
            ins.bind_int64(5, i64::from(input.is_tie))
                .map_err(|e| e.to_string())?;
            ins.bind_double(6, elo_delta).map_err(|e| e.to_string())?;
            ins.bind_text(7, &safe_note).map_err(|e| e.to_string())?;
            ins.bind_int64(8, now).map_err(|e| e.to_string())?;
            ins.step().map_err(|e| e.to_string())?;
        }
        if !run_id.is_empty() {
            let winner_label = if input.is_tie { "tie" } else { winner.as_str() };
            let mut upd = tx
                .prepare("UPDATE arena_runs SET winner_model = ?2 WHERE run_id = ?1;")
                .map_err(|e| e.to_string())?;
            upd.bind_text(1, &run_id).map_err(|e| e.to_string())?;
            upd.bind_text(2, winner_label).map_err(|e| e.to_string())?;
            upd.step().map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;

        Ok(ArenaVoteRecord {
            vote_id,
            run_id,
            winner_model: winner,
            loser_models: losers,
            is_tie: input.is_tie,
            elo_delta,
            note: safe_note,
            created_at_ms: now,
        })
    }

    pub fn list_arena_leaderboard(&self) -> Result<Vec<ArenaLeaderboardEntry>, String> {
        let conn = self.conn.lock();

        #[derive(Default)]
        struct ModelStats {
            elo: f64,
            wins: u64,
            losses: u64,
            ties: u64,
            runs_count: u64,
            ttft_sum: f64,
            ttft_n: u64,
            tps_sum: f64,
            tps_n: u64,
            cost_sum: f64,
            cost_n: u64,
        }

        let mut map: BTreeMap<String, ModelStats> = BTreeMap::new();
        let ensure = |m: &mut BTreeMap<String, ModelStats>, id: &str| {
            m.entry(id.to_string()).or_insert_with(|| ModelStats {
                elo: ARENA_BASE_ELO,
                ..ModelStats::default()
            });
        };

        // 1. Aggregate observed run metrics (TTFT, tok/s, USD) from arena_runs.outputs_json.
        {
            let mut stmt = conn
                .prepare("SELECT models_json, outputs_json FROM arena_runs ORDER BY created_at_ms ASC;")
                .map_err(|e| e.to_string())?;
            while stmt.step_row().map_err(|e| e.to_string())? {
                let models_raw = stmt.column_text(0).unwrap_or_default();
                let outputs_raw = stmt.column_text(1).unwrap_or_default();
                if let Ok(models) = serde_json::from_str::<Vec<String>>(&models_raw) {
                    for m in models {
                        if !m.trim().is_empty() {
                            ensure(&mut map, m.trim());
                        }
                    }
                }
                if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&outputs_raw) {
                    for item in items {
                        let model_id = item
                            .get("model")
                            .or_else(|| item.get("modelId"))
                            .or_else(|| item.get("model_id"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .unwrap_or("");
                        if model_id.is_empty() {
                            continue;
                        }
                        ensure(&mut map, model_id);
                        if let Some(st) = map.get_mut(model_id) {
                            st.runs_count += 1;
                            if let Some(ttft) = item
                                .get("ttftMs")
                                .or_else(|| item.get("ttft_ms"))
                                .and_then(Value::as_f64)
                                .filter(|v| *v > 0.0)
                            {
                                st.ttft_sum += ttft;
                                st.ttft_n += 1;
                            }
                            if let Some(tps) = item
                                .get("tokensPerSecond")
                                .or_else(|| item.get("tokens_per_second"))
                                .or_else(|| item.get("tps"))
                                .and_then(Value::as_f64)
                                .filter(|v| *v > 0.0)
                            {
                                st.tps_sum += tps;
                                st.tps_n += 1;
                            }
                            if let Some(cost) = item
                                .get("costUsd")
                                .or_else(|| item.get("cost_usd"))
                                .and_then(Value::as_f64)
                                .filter(|v| *v >= 0.0)
                            {
                                st.cost_sum += cost;
                                st.cost_n += 1;
                            }
                        }
                    }
                }
            }
        }

        // 2. Replay arena_votes chronologically to compute exact Elo (1500 base, K=32).
        {
            let mut stmt = conn
                .prepare(
                    "SELECT winner_model, loser_models_json, is_tie
                     FROM arena_votes ORDER BY created_at_ms ASC, vote_id ASC;",
                )
                .map_err(|e| e.to_string())?;
            while stmt.step_row().map_err(|e| e.to_string())? {
                let winner = stmt.column_text(0).unwrap_or_default();
                let losers_raw = stmt.column_text(1).unwrap_or_default();
                let is_tie = stmt.column_int64(2).unwrap_or(0) != 0;
                if winner.trim().is_empty() {
                    continue;
                }
                let losers: Vec<String> = serde_json::from_str(&losers_raw).unwrap_or_default();
                ensure(&mut map, &winner);
                for opp in &losers {
                    if opp.trim().is_empty() || opp == &winner {
                        continue;
                    }
                    ensure(&mut map, opp);
                    let w_elo = map[&winner].elo;
                    let l_elo = map[opp].elo;
                    let expected_w = 1.0 / (1.0 + 10.0_f64.powf((l_elo - w_elo) / 400.0));
                    let score_w = if is_tie { 0.5 } else { 1.0 };
                    let delta = ARENA_ELO_K * (score_w - expected_w);
                    if let Some(ws) = map.get_mut(&winner) {
                        ws.elo += delta;
                        if is_tie {
                            ws.ties += 1;
                        } else {
                            ws.wins += 1;
                        }
                    }
                    if let Some(ls) = map.get_mut(opp) {
                        ls.elo -= delta;
                        if is_tie {
                            ls.ties += 1;
                        } else {
                            ls.losses += 1;
                        }
                    }
                }
            }
        }

        let mut entries: Vec<ArenaLeaderboardEntry> = map
            .into_iter()
            .map(|(model_id, st)| {
                let matches = st.wins + st.losses + st.ties;
                let win_rate_pct = if matches > 0 {
                    round2(((st.wins as f64 + 0.5 * st.ties as f64) / matches as f64) * 100.0)
                } else {
                    0.0
                };
                ArenaLeaderboardEntry {
                    model_id,
                    elo: round2(st.elo),
                    wins: st.wins,
                    losses: st.losses,
                    ties: st.ties,
                    matches,
                    win_rate_pct,
                    runs_count: st.runs_count,
                    avg_ttft_ms: (st.ttft_n > 0).then(|| round2(st.ttft_sum / st.ttft_n as f64)),
                    avg_tps: (st.tps_n > 0).then(|| round2(st.tps_sum / st.tps_n as f64)),
                    avg_cost_usd: if st.cost_n > 0 {
                        round6(st.cost_sum / st.cost_n as f64)
                    } else {
                        0.0
                    },
                }
            })
            .collect();
        entries.sort_by(|a, b| {
            b.elo
                .total_cmp(&a.elo)
                .then_with(|| b.wins.cmp(&a.wins))
                .then_with(|| a.model_id.cmp(&b.model_id))
        });
        Ok(entries)
    }

    pub fn list_studio_personas(&self) -> Result<Vec<StudioPersonaRecord>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, icon, description, model_id, effort, temperature, top_p,
                        system_prompt, focus_mode, pinned_files_json, is_builtin, created_at_ms, updated_at_ms
                 FROM studio_personas ORDER BY is_builtin DESC, updated_at_ms DESC, name ASC;",
            )
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            out.push(read_studio_persona_row(&stmt)?);
        }
        Ok(out)
    }

    pub fn get_studio_persona(&self, id: &str) -> Result<Option<StudioPersonaRecord>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, icon, description, model_id, effort, temperature, top_p,
                        system_prompt, focus_mode, pinned_files_json, is_builtin, created_at_ms, updated_at_ms
                 FROM studio_personas WHERE id = ?1;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, id.trim()).map_err(|e| e.to_string())?;
        if stmt.step_row().map_err(|e| e.to_string())? {
            return Ok(Some(read_studio_persona_row(&stmt)?));
        }
        Ok(None)
    }

    pub fn upsert_studio_persona(
        &self,
        input: &StudioPersonaInput,
    ) -> Result<StudioPersonaRecord, String> {
        let name = SecretRedactor::redact(input.name.trim());
        if name.is_empty() {
            return Err("persona name is required".into());
        }
        let id = input
            .id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("gem_{}", uuid_v4()));
        let icon = input
            .icon
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("sparkles")
            .to_string();
        let description = SecretRedactor::redact(input.description.as_deref().unwrap_or("").trim());
        let model_id = input
            .model_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("claude-sonnet-5-5")
            .to_string();
        let effort = input
            .effort
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("max")
            .to_ascii_lowercase();
        let temperature = input.temperature.unwrap_or(0.7).clamp(0.0, 2.0);
        let top_p = input.top_p.unwrap_or(0.95).clamp(0.0, 1.0);
        let system_prompt =
            SecretRedactor::redact(input.system_prompt.as_deref().unwrap_or("").trim());
        let focus_mode = input
            .focus_mode
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("solo")
            .to_ascii_lowercase();
        let pinned_files = input.pinned_files.clone().unwrap_or_default();
        let pinned_json = serde_json::to_string(&pinned_files).map_err(|e| e.to_string())?;
        let now = now_epoch_ms();

        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO studio_personas
                 (id, name, icon, description, model_id, effort, temperature, top_p,
                  system_prompt, focus_mode, pinned_files_json, is_builtin, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?12)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    icon = excluded.icon,
                    description = excluded.description,
                    model_id = excluded.model_id,
                    effort = excluded.effort,
                    temperature = excluded.temperature,
                    top_p = excluded.top_p,
                    system_prompt = excluded.system_prompt,
                    focus_mode = excluded.focus_mode,
                    pinned_files_json = excluded.pinned_files_json,
                    updated_at_ms = excluded.updated_at_ms;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &name).map_err(|e| e.to_string())?;
        stmt.bind_text(3, &icon).map_err(|e| e.to_string())?;
        stmt.bind_text(4, &description).map_err(|e| e.to_string())?;
        stmt.bind_text(5, &model_id).map_err(|e| e.to_string())?;
        stmt.bind_text(6, &effort).map_err(|e| e.to_string())?;
        stmt.bind_double(7, temperature).map_err(|e| e.to_string())?;
        stmt.bind_double(8, top_p).map_err(|e| e.to_string())?;
        stmt.bind_text(9, &system_prompt).map_err(|e| e.to_string())?;
        stmt.bind_text(10, &focus_mode).map_err(|e| e.to_string())?;
        stmt.bind_text(11, &pinned_json).map_err(|e| e.to_string())?;
        stmt.bind_int64(12, now).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        drop(stmt);

        let mut sel = conn
            .prepare(
                "SELECT id, name, icon, description, model_id, effort, temperature, top_p,
                        system_prompt, focus_mode, pinned_files_json, is_builtin, created_at_ms, updated_at_ms
                 FROM studio_personas WHERE id = ?1;",
            )
            .map_err(|e| e.to_string())?;
        sel.bind_text(1, &id).map_err(|e| e.to_string())?;
        if sel.step_row().map_err(|e| e.to_string())? {
            return read_studio_persona_row(&sel);
        }
        Err(format!("failed to load upserted persona '{id}'"))
    }

    pub fn delete_studio_persona(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("DELETE FROM studio_personas WHERE id = ?1;")
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, id.trim()).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(conn.changes() > 0)
    }

    pub fn append_chat_branch(&self, input: &ChatBranchInput) -> Result<ChatBranchRecord, String> {
        let session_id = input.session_id.trim().to_string();
        if session_id.is_empty() {
            return Err("session_id is required".into());
        }
        let parent_msg_id = input.parent_msg_id.trim().to_string();
        let role = if input.role.trim().is_empty() {
            "assistant".to_string()
        } else {
            input.role.trim().to_ascii_lowercase()
        };
        let content = SecretRedactor::redact(&input.content);
        let model_id = input.model_id.as_deref().unwrap_or("").trim().to_string();
        let effort = input
            .effort
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("max")
            .to_string();
        let thinking_text = SecretRedactor::redact(input.thinking_text.as_deref().unwrap_or(""));
        let tool_calls = input
            .tool_calls
            .as_ref()
            .map(SecretRedactor::redact_json)
            .unwrap_or_else(|| json!([]));
        let tool_calls_json = serde_json::to_string(&tool_calls).map_err(|e| e.to_string())?;
        let id = input
            .id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("br_{}", uuid_v4()));
        let now = now_epoch_ms();

        let mut conn = self.conn.lock();
        let tx = conn.begin_immediate().map_err(|e| e.to_string())?;
        let branch_index = match input.branch_index {
            Some(idx) => idx.max(0),
            None => {
                let mut q = tx
                    .prepare(
                        "SELECT COALESCE(MAX(branch_index) + 1, 0)
                         FROM chat_branches WHERE session_id = ?1 AND parent_msg_id = ?2;",
                    )
                    .map_err(|e| e.to_string())?;
                q.bind_text(1, &session_id).map_err(|e| e.to_string())?;
                q.bind_text(2, &parent_msg_id).map_err(|e| e.to_string())?;
                if q.step_row().map_err(|e| e.to_string())? {
                    q.column_int64(0).unwrap_or(0)
                } else {
                    0
                }
            }
        };
        {
            let mut ins = tx
                .prepare(
                    "INSERT INTO chat_branches
                     (id, session_id, parent_msg_id, branch_index, role, content,
                      model_id, effort, thinking_text, tool_calls_json, created_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                     ON CONFLICT(id) DO UPDATE SET
                        content = excluded.content,
                        model_id = excluded.model_id,
                        effort = excluded.effort,
                        thinking_text = excluded.thinking_text,
                        tool_calls_json = excluded.tool_calls_json;",
                )
                .map_err(|e| e.to_string())?;
            ins.bind_text(1, &id).map_err(|e| e.to_string())?;
            ins.bind_text(2, &session_id).map_err(|e| e.to_string())?;
            ins.bind_text(3, &parent_msg_id).map_err(|e| e.to_string())?;
            ins.bind_int64(4, branch_index).map_err(|e| e.to_string())?;
            ins.bind_text(5, &role).map_err(|e| e.to_string())?;
            ins.bind_text(6, &content).map_err(|e| e.to_string())?;
            ins.bind_text(7, &model_id).map_err(|e| e.to_string())?;
            ins.bind_text(8, &effort).map_err(|e| e.to_string())?;
            ins.bind_text(9, &thinking_text).map_err(|e| e.to_string())?;
            ins.bind_text(10, &tool_calls_json)
                .map_err(|e| e.to_string())?;
            ins.bind_int64(11, now).map_err(|e| e.to_string())?;
            ins.step().map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;

        Ok(ChatBranchRecord {
            id,
            session_id,
            parent_msg_id,
            branch_index,
            role,
            content,
            model_id,
            effort,
            thinking_text,
            tool_calls,
            created_at_ms: now,
        })
    }

    pub fn list_chat_branches(
        &self,
        session_id: &str,
        parent_msg_id: Option<&str>,
    ) -> Result<Vec<ChatBranchRecord>, String> {
        let conn = self.conn.lock();
        let mut out = Vec::new();
        if let Some(pid) = parent_msg_id.map(str::trim).filter(|s| !s.is_empty()) {
            let mut stmt = conn
                .prepare(
                    "SELECT id, session_id, parent_msg_id, branch_index, role, content,
                            model_id, effort, thinking_text, tool_calls_json, created_at_ms
                     FROM chat_branches
                     WHERE session_id = ?1 AND parent_msg_id = ?2
                     ORDER BY branch_index ASC, created_at_ms ASC;",
                )
                .map_err(|e| e.to_string())?;
            stmt.bind_text(1, session_id.trim())
                .map_err(|e| e.to_string())?;
            stmt.bind_text(2, pid).map_err(|e| e.to_string())?;
            while stmt.step_row().map_err(|e| e.to_string())? {
                out.push(read_chat_branch_row(&stmt)?);
            }
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT id, session_id, parent_msg_id, branch_index, role, content,
                            model_id, effort, thinking_text, tool_calls_json, created_at_ms
                     FROM chat_branches
                     WHERE session_id = ?1
                     ORDER BY created_at_ms ASC, branch_index ASC;",
                )
                .map_err(|e| e.to_string())?;
            stmt.bind_text(1, session_id.trim())
                .map_err(|e| e.to_string())?;
            while stmt.step_row().map_err(|e| e.to_string())? {
                out.push(read_chat_branch_row(&stmt)?);
            }
        }
        Ok(out)
    }

    pub fn fork_chat_branches(
        &self,
        source_session_id: &str,
        target_session_id: &str,
        up_to_branch_id: Option<&str>,
    ) -> Result<usize, String> {
        let branches = self.list_chat_branches(source_session_id, None)?;
        let mut copied = 0usize;
        for br in branches {
            let matches_stop = up_to_branch_id
                .map(str::trim)
                .is_some_and(|stop| !stop.is_empty() && br.id == stop);
            self.append_chat_branch(&ChatBranchInput {
                id: None,
                session_id: target_session_id.trim().to_string(),
                parent_msg_id: br.parent_msg_id,
                branch_index: Some(br.branch_index),
                role: br.role,
                content: br.content,
                model_id: Some(br.model_id),
                effort: Some(br.effort),
                thinking_text: Some(br.thinking_text),
                tool_calls: Some(br.tool_calls),
            })?;
            copied += 1;
            if matches_stop {
                break;
            }
        }
        Ok(copied)
    }
}

const ARENA_BASE_ELO: f64 = 1_500.0;
const ARENA_ELO_K: f64 = 32.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaRunInput {
    pub run_id: Option<String>,
    pub prompt: String,
    #[serde(default)]
    pub system_prompt: String,
    pub models: Vec<String>,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub outputs: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaRunRecord {
    pub run_id: String,
    pub prompt: String,
    pub system_prompt: String,
    pub models: Vec<String>,
    pub params: Value,
    pub outputs: Value,
    pub winner_model: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaVoteInput {
    #[serde(default)]
    pub run_id: String,
    pub winner_model: String,
    #[serde(default)]
    pub loser_models: Vec<String>,
    #[serde(default)]
    pub is_tie: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaVoteRecord {
    pub vote_id: String,
    pub run_id: String,
    pub winner_model: String,
    pub loser_models: Vec<String>,
    pub is_tie: bool,
    pub elo_delta: f64,
    pub note: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaLeaderboardEntry {
    pub model_id: String,
    pub elo: f64,
    pub wins: u64,
    pub losses: u64,
    pub ties: u64,
    pub matches: u64,
    pub win_rate_pct: f64,
    pub runs_count: u64,
    pub avg_ttft_ms: Option<f64>,
    pub avg_tps: Option<f64>,
    pub avg_cost_usd: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioPersonaInput {
    pub id: Option<String>,
    pub name: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub model_id: Option<String>,
    pub effort: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub system_prompt: Option<String>,
    pub focus_mode: Option<String>,
    pub pinned_files: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioPersonaRecord {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub description: String,
    pub model_id: String,
    pub effort: String,
    pub temperature: f64,
    pub top_p: f64,
    pub system_prompt: String,
    pub focus_mode: String,
    pub pinned_files: Vec<String>,
    pub is_builtin: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatBranchInput {
    pub id: Option<String>,
    pub session_id: String,
    #[serde(default)]
    pub parent_msg_id: String,
    pub branch_index: Option<i64>,
    #[serde(default)]
    pub role: String,
    pub content: String,
    pub model_id: Option<String>,
    pub effort: Option<String>,
    pub thinking_text: Option<String>,
    pub tool_calls: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatBranchRecord {
    pub id: String,
    pub session_id: String,
    pub parent_msg_id: String,
    pub branch_index: i64,
    pub role: String,
    pub content: String,
    pub model_id: String,
    pub effort: String,
    pub thinking_text: String,
    pub tool_calls: Value,
    pub created_at_ms: i64,
}

fn seed_builtin_studio_personas(conn: &Connection) -> Result<(), String> {
    let existing_count = {
        let mut stmt = conn
            .prepare("SELECT COUNT(*) FROM studio_personas;")
            .map_err(|e| e.to_string())?;
        if stmt.step_row().map_err(|e| e.to_string())? {
            stmt.column_int64(0).unwrap_or(0)
        } else {
            0
        }
    };
    if existing_count > 0 {
        return Ok(());
    }
    let now = now_epoch_ms();
    let defaults = [
        (
            "gem_principal_architect",
            "Principal Architect",
            "layers",
            "Systems design, multi-crate architecture, invariants, and trade-off matrices.",
            "claude-sonnet-5-5",
            "max",
            0.3_f64,
            0.95_f64,
            "You are a Principal Systems Architect. Reason from first principles, preserve invariants, produce crisp trade-off tables, and verify every architectural claim against real files.",
            "solo",
        ),
        (
            "gem_deep_researcher",
            "Deep Researcher",
            "globe",
            "Multi-source web + academic synthesis with verifiable inline citations and PRISMA ledgers.",
            "gemini-4-carbon",
            "max",
            0.4_f64,
            0.95_f64,
            "You are a Deep Research Analyst. Search authoritative primary sources, cross-verify claims, report conflicts honestly, and cite every claim inline with exact [S###] or [G###] markers.",
            "deep",
        ),
        (
            "gem_code_reviewer",
            "Code Reviewer",
            "shield",
            "Adversarial security, concurrency, edge-case, and performance diff auditor.",
            "gpt-6.2-sol",
            "xhigh",
            0.2_f64,
            0.9_f64,
            "You are a Staff Adversarial Code Reviewer. Hunt for races, lifetime/ownership bugs, unchecked arithmetic, injection vectors, and missing regression tests with exact file:line evidence.",
            "code",
        ),
        (
            "gem_math_proof_lab",
            "Math & Proof Lab",
            "sigma",
            "Formal derivations, counterexample search, complexity proofs, and LaTeX clarity.",
            "gpt-6.2-sol",
            "max",
            0.1_f64,
            0.9_f64,
            "You are a Formal Mathematics & Algorithms Specialist. State definitions, hypotheses, and edge cases explicitly, verify boundary cases, and present clean LaTeX derivations.",
            "academic",
        ),
    ];
    for (id, name, icon, desc, model, effort, temp, top_p, sys_prompt, focus) in defaults {
        let mut stmt = conn
            .prepare(
                "INSERT OR IGNORE INTO studio_personas
                 (id, name, icon, description, model_id, effort, temperature, top_p,
                  system_prompt, focus_mode, pinned_files_json, is_builtin, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '[]', 1, ?11, ?11);",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, name).map_err(|e| e.to_string())?;
        stmt.bind_text(3, icon).map_err(|e| e.to_string())?;
        stmt.bind_text(4, desc).map_err(|e| e.to_string())?;
        stmt.bind_text(5, model).map_err(|e| e.to_string())?;
        stmt.bind_text(6, effort).map_err(|e| e.to_string())?;
        stmt.bind_double(7, temp).map_err(|e| e.to_string())?;
        stmt.bind_double(8, top_p).map_err(|e| e.to_string())?;
        stmt.bind_text(9, sys_prompt).map_err(|e| e.to_string())?;
        stmt.bind_text(10, focus).map_err(|e| e.to_string())?;
        stmt.bind_int64(11, now).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn compute_elo_ratings_from_conn(conn: &Connection) -> Result<BTreeMap<String, f64>, String> {
    let mut ratings: BTreeMap<String, f64> = BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT winner_model, loser_models_json, is_tie
             FROM arena_votes ORDER BY created_at_ms ASC, vote_id ASC;",
        )
        .map_err(|e| e.to_string())?;
    while stmt.step_row().map_err(|e| e.to_string())? {
        let winner = stmt.column_text(0).unwrap_or_default();
        let losers_raw = stmt.column_text(1).unwrap_or_default();
        let is_tie = stmt.column_int64(2).unwrap_or(0) != 0;
        let losers: Vec<String> = serde_json::from_str(&losers_raw).unwrap_or_default();
        let w_entry = *ratings.entry(winner.clone()).or_insert(ARENA_BASE_ELO);
        let mut w_cur = w_entry;
        let score_w = if is_tie { 0.5 } else { 1.0 };
        for opp in losers {
            if opp.trim().is_empty() || opp == winner {
                continue;
            }
            let l_cur = *ratings.entry(opp.clone()).or_insert(ARENA_BASE_ELO);
            let expected = 1.0 / (1.0 + 10.0_f64.powf((l_cur - w_cur) / 400.0));
            let delta = ARENA_ELO_K * (score_w - expected);
            w_cur += delta;
            ratings.insert(opp, l_cur - delta);
        }
        ratings.insert(winner, w_cur);
    }
    Ok(ratings)
}

fn read_arena_run_row(stmt: &omnia_winsqlite::Statement<'_>) -> Result<ArenaRunRecord, String> {
    let models_raw = stmt.column_text(3).map_err(|e| e.to_string())?;
    let params_raw = stmt.column_text(4).map_err(|e| e.to_string())?;
    let outputs_raw = stmt.column_text(5).map_err(|e| e.to_string())?;
    Ok(ArenaRunRecord {
        run_id: stmt.column_text(0).map_err(|e| e.to_string())?,
        prompt: stmt.column_text(1).map_err(|e| e.to_string())?,
        system_prompt: stmt.column_text(2).map_err(|e| e.to_string())?,
        models: serde_json::from_str(&models_raw).unwrap_or_default(),
        params: serde_json::from_str(&params_raw).unwrap_or_else(|_| json!({})),
        outputs: serde_json::from_str(&outputs_raw).unwrap_or_else(|_| json!([])),
        winner_model: stmt.column_opt_text(6).map_err(|e| e.to_string())?,
        created_at_ms: stmt.column_int64(7).map_err(|e| e.to_string())?,
    })
}

fn read_studio_persona_row(
    stmt: &omnia_winsqlite::Statement<'_>,
) -> Result<StudioPersonaRecord, String> {
    let pinned_raw = stmt.column_text(10).map_err(|e| e.to_string())?;
    Ok(StudioPersonaRecord {
        id: stmt.column_text(0).map_err(|e| e.to_string())?,
        name: stmt.column_text(1).map_err(|e| e.to_string())?,
        icon: stmt.column_text(2).map_err(|e| e.to_string())?,
        description: stmt.column_text(3).map_err(|e| e.to_string())?,
        model_id: stmt.column_text(4).map_err(|e| e.to_string())?,
        effort: stmt.column_text(5).map_err(|e| e.to_string())?,
        temperature: stmt.column_double(6).map_err(|e| e.to_string())?,
        top_p: stmt.column_double(7).map_err(|e| e.to_string())?,
        system_prompt: stmt.column_text(8).map_err(|e| e.to_string())?,
        focus_mode: stmt.column_text(9).map_err(|e| e.to_string())?,
        pinned_files: serde_json::from_str(&pinned_raw).unwrap_or_default(),
        is_builtin: stmt.column_int64(11).map_err(|e| e.to_string())? != 0,
        created_at_ms: stmt.column_int64(12).map_err(|e| e.to_string())?,
        updated_at_ms: stmt.column_int64(13).map_err(|e| e.to_string())?,
    })
}

fn read_chat_branch_row(stmt: &omnia_winsqlite::Statement<'_>) -> Result<ChatBranchRecord, String> {
    let tc_raw = stmt.column_text(9).map_err(|e| e.to_string())?;
    Ok(ChatBranchRecord {
        id: stmt.column_text(0).map_err(|e| e.to_string())?,
        session_id: stmt.column_text(1).map_err(|e| e.to_string())?,
        parent_msg_id: stmt.column_text(2).map_err(|e| e.to_string())?,
        branch_index: stmt.column_int64(3).map_err(|e| e.to_string())?,
        role: stmt.column_text(4).map_err(|e| e.to_string())?,
        content: stmt.column_text(5).map_err(|e| e.to_string())?,
        model_id: stmt.column_text(6).map_err(|e| e.to_string())?,
        effort: stmt.column_text(7).map_err(|e| e.to_string())?,
        thinking_text: stmt.column_text(8).map_err(|e| e.to_string())?,
        tool_calls: serde_json::from_str(&tc_raw).unwrap_or_else(|_| json!([])),
        created_at_ms: stmt.column_int64(10).map_err(|e| e.to_string())?,
    })
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

    #[test]
    fn steer23_arena_personas_and_chat_branches_persist_and_compute_elo() {
        let store = OpsStore::open_in_memory().expect("open ops store");

        // 1. 4 built-in flagship Gems auto-seeded + CRUD
        let initial_personas = store.list_studio_personas().expect("seeded personas");
        assert_eq!(initial_personas.len(), 4);
        assert!(initial_personas.iter().any(|p| p.name == "Principal Architect"));
        assert!(initial_personas.iter().any(|p| p.name == "Deep Researcher"));
        assert!(initial_personas.iter().any(|p| p.name == "Code Reviewer"));
        assert!(initial_personas.iter().any(|p| p.name == "Math & Proof Lab"));

        let custom = store
            .upsert_studio_persona(&StudioPersonaInput {
                id: None,
                name: "Rust Kernel Tuner".to_string(),
                icon: Some("cpu".to_string()),
                description: Some("Zero-alloc profiling gem".to_string()),
                model_id: Some("claude-sonnet-5-5".to_string()),
                effort: Some("max".to_string()),
                temperature: Some(0.25),
                top_p: Some(0.9),
                system_prompt: Some("Optimize hot loops cleanly.".to_string()),
                focus_mode: Some("code".to_string()),
                pinned_files: Some(vec!["Cargo.toml".to_string()]),
            })
            .expect("upsert persona");
        assert_eq!(store.list_studio_personas().unwrap().len(), 5);
        assert_eq!(store.get_studio_persona(&custom.id).unwrap().unwrap().name, "Rust Kernel Tuner");
        assert!(store.delete_studio_persona(&custom.id).unwrap());
        assert_eq!(store.list_studio_personas().unwrap().len(), 4);

        // 2. Arena run + winner vote + tie vote + Elo leaderboard & telemetry averages
        let run = store
            .save_arena_run(&ArenaRunInput {
                run_id: None,
                prompt: "Compare lock-free ring buffers".to_string(),
                system_prompt: "Be concise".to_string(),
                models: vec!["claude-sonnet-5-5".into(), "gpt-6.2-sol".into()],
                params: json!({ "effort": "max", "temperature": 0.5 }),
                outputs: json!([
                    { "model": "claude-sonnet-5-5", "ttftMs": 220.0, "tokensPerSecond": 92.0, "costUsd": 0.004200 },
                    { "model": "gpt-6.2-sol", "ttftMs": 310.0, "tokensPerSecond": 84.0, "costUsd": 0.005100 }
                ]),
            })
            .expect("save arena run");
        assert_eq!(store.list_arena_runs(10).unwrap().len(), 1);

        let v1 = store
            .record_arena_vote(&ArenaVoteInput {
                run_id: run.run_id.clone(),
                winner_model: "claude-sonnet-5-5".to_string(),
                loser_models: vec!["gpt-6.2-sol".to_string()],
                is_tie: false,
                note: Some("Clearer memory-ordering proof".to_string()),
            })
            .expect("vote 1");
        assert!(v1.elo_delta > 0.0);
        assert_eq!(
            store.get_arena_run(&run.run_id).unwrap().unwrap().winner_model.as_deref(),
            Some("claude-sonnet-5-5")
        );

        let lb = store.list_arena_leaderboard().expect("leaderboard");
        assert_eq!(lb.len(), 2);
        assert_eq!(lb[0].model_id, "claude-sonnet-5-5");
        assert!(lb[0].elo > 1_500.0);
        assert_eq!(lb[0].wins, 1);
        assert_eq!(lb[0].avg_ttft_ms, Some(220.0));
        assert_eq!(lb[1].model_id, "gpt-6.2-sol");
        assert!(lb[1].elo < 1_500.0);
        assert_eq!(lb[1].losses, 1);

        // 3. Chat branches (< 1/N >) + fork lineage
        let b0 = store
            .append_chat_branch(&ChatBranchInput {
                session_id: "sess_br_1".to_string(),
                parent_msg_id: "msg_user_1".to_string(),
                role: "assistant".to_string(),
                content: "First response variant".to_string(),
                model_id: Some("claude-sonnet-5-5".to_string()),
                effort: Some("max".to_string()),
                thinking_text: Some("Step 1".to_string()),
                ..ChatBranchInput::default()
            })
            .expect("branch 0");
        let b1 = store
            .append_chat_branch(&ChatBranchInput {
                session_id: "sess_br_1".to_string(),
                parent_msg_id: "msg_user_1".to_string(),
                role: "assistant".to_string(),
                content: "Regenerated second variant".to_string(),
                model_id: Some("gpt-6.2-sol".to_string()),
                effort: Some("xhigh".to_string()),
                ..ChatBranchInput::default()
            })
            .expect("branch 1");
        assert_eq!(b0.branch_index, 0);
        assert_eq!(b1.branch_index, 1);
        let listed = store
            .list_chat_branches("sess_br_1", Some("msg_user_1"))
            .expect("list branches");
        assert_eq!(listed.len(), 2);

        let copied = store
            .fork_chat_branches("sess_br_1", "sess_br_forked", Some(&b0.id))
            .expect("fork branches");
        assert_eq!(copied, 1);
        assert_eq!(
            store.list_chat_branches("sess_br_forked", None).unwrap().len(),
            1
        );
    }

    #[test]
    fn vixie_cron_evaluator_due_routine_runs_and_peer_mesh_snapshot_roundtrip() {
        // 1. Vixie 5-field cron matching (UTC epoch 2026-11-28T03:15:00Z = Saturday = dow 6)
        // Compute exact timestamp deterministically using UTC day/hour/minute check
        let feb_leap_days = compute_next_cron_run_ms("0 0 29 2 *", 1_709_164_800_000).expect("leap");
        assert!(cron_matches_epoch_ms("0 0 29 2 *", feb_leap_days).unwrap());
        // 1_700_000_100s = 2023-11-14T22:15:00Z (minute 15 matches */15); 1_700_000_700s = 22:25:00Z.
        assert!(cron_matches_epoch_ms("*/15 * * * *", 1_700_000_100_000).unwrap());
        assert!(!cron_matches_epoch_ms("*/15 * * * *", 1_700_000_700_000).unwrap());
        assert!(!cron_matches_epoch_ms("5 0 * * *", 1_700_000_000_000).unwrap());
        let next_every = compute_next_cron_run_ms("@every 30s", 1_700_000_000_000).expect("@every");
        assert_eq!(next_every, 1_700_000_030_000);

        // 2. Due routine evaluation records run receipts and advances next_run_at_ms
        let store = OpsStore::open_in_memory().expect("ops");
        let rtn = store
            .upsert_routine(
                "Hourly Verify",
                "Run strict audit",
                "D:/Omnia",
                "*/5 * * * *",
                "worktree",
                None,
            )
            .expect("upsert routine");
        let due_at = rtn.next_run_at_ms.expect("initial next_run_at_ms");
        let triggered = store.evaluate_due_routines(due_at + 100).expect("eval due");
        assert_eq!(triggered.len(), 1);
        assert_eq!(triggered[0].routine_id, rtn.id);
        let runs = store.list_routine_runs(Some(&rtn.id), 10).expect("list runs");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, "triggered");

        // 3. PeerMesh snapshot WAL persistence
        store
            .save_peer_mesh_agent(&PeerMeshAgentRecord {
                agent_id: "coord".to_string(),
                role: "coordinator".to_string(),
                owned_paths: vec!["docs/".to_string()],
                excluded_paths: vec![],
                epoch: 1,
                active: true,
                last_read_seq: 0,
                updated_at_ms: 1_000,
            })
            .expect("save agent");
        store
            .save_peer_mesh_edge(&PeerMeshEdgeRecord {
                from_id: "coord".to_string(),
                to_id: "worker-a".to_string(),
                channel_label: "duplex-mesh".to_string(),
                updated_at_ms: 1_000,
            })
            .expect("save edge");
        store
            .save_peer_mesh_message(&PeerMeshMessageRecord {
                seq: 1,
                from_id: "coord".to_string(),
                recipients: vec!["worker-a".to_string()],
                epoch: 1,
                hop_count: 0,
                max_hops: 4,
                in_reply_to_seq: None,
                topic: "handoff".to_string(),
                payload: "check net_diag".to_string(),
                sent_at_ms: 1_500,
            })
            .expect("save msg");
        let snap = store.load_peer_mesh_snapshot().expect("snapshot");
        assert_eq!(snap.agents.len(), 1);
        assert_eq!(snap.edges.len(), 1);
        assert_eq!(snap.messages.len(), 1);
        assert_eq!(snap.messages[0].seq, 1);
    }
}

/// Parsed pure-Rust Vixie 5-field cron schedule (or `@every <N>s|m|h` interval).
#[derive(Debug, Clone)]
pub enum CronSchedule {
    EveryMs(i64),
    Vixie {
        minutes: [bool; 60],
        hours: [bool; 24],
        dom: [bool; 32],
        months: [bool; 13],
        dow: [bool; 7],
        dom_restricted: bool,
        dow_restricted: bool,
    },
}

fn epoch_ms_to_utc(ms: i64) -> (i32, u8, u8, u8, u8, u8) {
    let days = ms.div_euclid(86_400_000);
    let secs_of_day = ms.rem_euclid(86_400_000) / 1_000;
    let hour = (secs_of_day / 3_600) as u8;
    let min = ((secs_of_day % 3_600) / 60) as u8;
    let dow = (days + 4).rem_euclid(7) as u8;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = (y + i64::from(m <= 2)) as i32;
    (year, m as u8, d as u8, hour, min, dow)
}

fn parse_cron_value(raw: &str, min: usize, max: usize, wrap_seven: bool) -> Result<usize, String> {
    let lower = raw.trim().to_ascii_lowercase();
    let val = match lower.as_str() {
        "jan" => 1,
        "feb" => 2,
        "mar" => 3,
        "apr" => 4,
        "may" => 5,
        "jun" => 6,
        "jul" => 7,
        "aug" => 8,
        "sep" => 9,
        "oct" => 10,
        "nov" => 11,
        "dec" => 12,
        "sun" => 0,
        "mon" => 1,
        "tue" => 2,
        "wed" => 3,
        "thu" => 4,
        "fri" => 5,
        "sat" => 6,
        _ => lower
            .parse::<usize>()
            .map_err(|_| format!("invalid cron token '{raw}'"))?,
    };
    let normalized = if wrap_seven && val == 7 { 0 } else { val };
    if normalized < min || normalized > max {
        return Err(format!("cron value {val} out of range {min}..={max}"));
    }
    Ok(normalized)
}

fn parse_cron_field(
    field: &str,
    out: &mut [bool],
    min: usize,
    max: usize,
    wrap_seven: bool,
) -> Result<bool, String> {
    let trimmed = field.trim();
    if trimmed == "*" {
        for slot in out.iter_mut().take(max + 1).skip(min) {
            *slot = true;
        }
        return Ok(false);
    }
    let mut restricted = false;
    for part in trimmed.split(',') {
        let (base, step) = if let Some((b, s)) = part.split_once('/') {
            let step_val = s
                .trim()
                .parse::<usize>()
                .ok()
                .filter(|&v| v > 0)
                .ok_or_else(|| format!("invalid cron step '{s}'"))?;
            (b.trim(), step_val)
        } else {
            (part.trim(), 1usize)
        };
        let (start, end) = if base == "*" {
            (min, max)
        } else if let Some((lo_s, hi_s)) = base.split_once('-') {
            restricted = true;
            let lo = parse_cron_value(lo_s, min, max, wrap_seven)?;
            let hi = parse_cron_value(hi_s, min, max, wrap_seven)?;
            if lo > hi {
                return Err(format!("inverted cron range '{base}'"));
            }
            (lo, hi)
        } else {
            restricted = true;
            let single = parse_cron_value(base, min, max, wrap_seven)?;
            if step == 1 {
                out[single] = true;
                continue;
            }
            (single, max)
        };
        if step > 1 && base == "*" {
            restricted = true;
        }
        let mut cur = start;
        while cur <= end {
            let slot = if wrap_seven && cur == 7 { 0 } else { cur };
            out[slot] = true;
            cur += step;
        }
    }
    Ok(restricted)
}

/// Parses a standard Vixie 5-field cron expression or `@hourly`/`@daily`/`@weekly`/`@monthly`/`@yearly`/`@every`.
pub fn parse_cron_schedule(expr: &str) -> Result<CronSchedule, String> {
    let trimmed = expr.trim();
    if let Some(rest) = trimmed
        .strip_prefix("@every ")
        .or_else(|| trimmed.strip_prefix("every "))
    {
        let s = rest.trim().to_ascii_lowercase();
        let (num_s, mult) = if let Some(n) = s.strip_suffix('s') {
            (n, 1_000i64)
        } else if let Some(n) = s.strip_suffix('m') {
            (n, 60_000i64)
        } else if let Some(n) = s.strip_suffix('h') {
            (n, 3_600_000i64)
        } else {
            return Err(format!("unsupported @every interval '{trimmed}'"));
        };
        let qty = num_s
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|&v| v > 0)
            .ok_or_else(|| format!("invalid @every quantity '{trimmed}'"))?;
        return Ok(CronSchedule::EveryMs(qty.saturating_mul(mult)));
    }

    let expanded = match trimmed.to_ascii_lowercase().as_str() {
        "@hourly" => "0 * * * *",
        "@daily" | "@midnight" => "0 0 * * *",
        "@weekly" => "0 0 * * 0",
        "@monthly" => "0 0 1 * *",
        "@yearly" | "@annually" => "0 0 1 1 *",
        _ => trimmed,
    };
    let fields: Vec<&str> = expanded.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(format!(
            "expected 5-field Vixie cron expression, got '{}' fields",
            fields.len()
        ));
    }

    let mut minutes = [false; 60];
    let mut hours = [false; 24];
    let mut dom = [false; 32];
    let mut months = [false; 13];
    let mut dow = [false; 7];

    parse_cron_field(fields[0], &mut minutes, 0, 59, false)?;
    parse_cron_field(fields[1], &mut hours, 0, 23, false)?;
    let dom_restricted = parse_cron_field(fields[2], &mut dom, 1, 31, false)?;
    parse_cron_field(fields[3], &mut months, 1, 12, false)?;
    let dow_restricted = parse_cron_field(fields[4], &mut dow, 0, 6, true)?;

    Ok(CronSchedule::Vixie {
        minutes,
        hours,
        dom,
        months,
        dow,
        dom_restricted,
        dow_restricted,
    })
}

fn vixie_matches(sched: &CronSchedule, ms: i64) -> bool {
    let CronSchedule::Vixie {
        minutes,
        hours,
        dom,
        months,
        dow,
        dom_restricted,
        dow_restricted,
    } = sched
    else {
        return true;
    };
    let (_year, month, day, hour, minute, wd) = epoch_ms_to_utc(ms);
    if !minutes[usize::from(minute)]
        || !hours[usize::from(hour)]
        || !months[usize::from(month)]
    {
        return false;
    }
    let dom_ok = dom[usize::from(day)];
    let dow_ok = dow[usize::from(wd)];
    if *dom_restricted && *dow_restricted {
        dom_ok || dow_ok
    } else {
        dom_ok && dow_ok
    }
}

/// Returns `true` when `epoch_ms` falls within a minute matching `expr`.
pub fn cron_matches_epoch_ms(expr: &str, epoch_ms: i64) -> Result<bool, String> {
    let sched = parse_cron_schedule(expr)?;
    Ok(vixie_matches(&sched, epoch_ms))
}

/// Computes the next UTC epoch timestamp (`> after_ms`) matching `expr`.
pub fn compute_next_cron_run_ms(expr: &str, after_ms: i64) -> Result<i64, String> {
    let sched = parse_cron_schedule(expr)?;
    match sched {
        CronSchedule::EveryMs(step_ms) => Ok(after_ms.saturating_add(step_ms)),
        ref vix @ CronSchedule::Vixie {
            ref hours,
            ref months,
            ..
        } => {
            let mut candidate = ((after_ms / 60_000) + 1) * 60_000;
            // Search up to 4 years + 4 days so Feb 29 leap schedules always resolve quickly.
            for _ in 0..1_500 {
                let (_y, month, _d, hour, _min, _wd) = epoch_ms_to_utc(candidate);
                if !months[usize::from(month)] {
                    // Advance to next midnight/day quickly
                    candidate = ((candidate / 86_400_000) + 1) * 86_400_000;
                    continue;
                }
                if hours[usize::from(hour)] && vixie_matches(vix, candidate) {
                    return Ok(candidate);
                }
                // Check remaining minutes in current day if hour matches or jump to matching hours
                let day_start = candidate.div_euclid(86_400_000) * 86_400_000;
                let start_min_of_day = ((candidate - day_start) / 60_000) as usize;
                for m_idx in start_min_of_day..1_440 {
                    let probe = day_start + (m_idx as i64) * 60_000;
                    if vixie_matches(vix, probe) {
                        return Ok(probe);
                    }
                }
                candidate = day_start + 86_400_000;
            }
            Err(format!("no next cron run found within 4 years for '{expr}'"))
        }
    }
}
