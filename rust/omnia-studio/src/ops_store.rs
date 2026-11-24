//! Persistent WAL `omnia-winsqlite` store for Studio v5 + `omp-omni` companion tables:
//! Dual-Scope `Main` / `Subagent` model+effort roles, session `Chat / Builder / SOLO` modes,
//! Chat-surface `Quote + BTW` threads, `kb_notes` (+ FTS5 / fallback search), SHA-256 `pastes`,
//! `kanban_tasks`, `inbox_items`, `routines`, and real observed `usage_traces` (zero fake data).

use std::fs;
use std::path::Path;

use omnia_core::{now_epoch_ms, sha256_hex, uuid_v4, SecretRedactor};
use omnia_winsqlite::Connection;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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
    recorded_at_ms INTEGER NOT NULL
);
"#;

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
            "minimal" | "low" | "medium" | "high" | "max"
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
                last_run_at_ms: None,
                next_run_at_ms: None,
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

    pub fn record_trace(&self, trace: &UsageTraceInput) -> Result<String, String> {
        let trace_id = format!("trc_{}", uuid_v4());
        let now = now_epoch_ms();
        let note = trace
            .error_note
            .as_deref()
            .map(SecretRedactor::redact);
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "INSERT INTO ops_usage_traces (
                    trace_id, session_id, provider_id, model_id, surface,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    cost_usd, duration_ms, ttft_ms, tokens_per_second,
                    is_error, error_note, saved_tokens, recorded_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17);",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &trace_id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &trace.session_id)
            .map_err(|e| e.to_string())?;
        stmt.bind_text(3, &trace.provider_id)
            .map_err(|e| e.to_string())?;
        stmt.bind_text(4, &trace.model_id)
            .map_err(|e| e.to_string())?;
        stmt.bind_text(5, &trace.surface).map_err(|e| e.to_string())?;
        stmt.bind_int64(6, trace.input_tokens)
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(7, trace.output_tokens)
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(8, trace.cache_read_tokens)
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(9, trace.cache_write_tokens)
            .map_err(|e| e.to_string())?;
        stmt.bind_double(10, trace.cost_usd)
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(11, trace.duration_ms)
            .map_err(|e| e.to_string())?;
        match trace.ttft_ms {
            Some(v) => stmt.bind_int64(12, v).map_err(|e| e.to_string())?,
            None => stmt.bind_null(12).map_err(|e| e.to_string())?,
        }
        stmt.bind_double(13, trace.tokens_per_second)
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(14, i64::from(trace.is_error))
            .map_err(|e| e.to_string())?;
        stmt.bind_opt_text(15, note.as_deref())
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(16, trace.saved_tokens)
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(17, now).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(trace_id)
    }

    pub fn list_traces(&self, limit: usize) -> Result<Vec<Value>, String> {
        let cap = limit.clamp(1, 200) as i64;
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT trace_id, session_id, provider_id, model_id, surface,
                        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                        cost_usd, duration_ms, ttft_ms, tokens_per_second,
                        is_error, error_note, saved_tokens, recorded_at_ms
                 FROM ops_usage_traces
                 ORDER BY recorded_at_ms DESC
                 LIMIT ?1;",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(1, cap).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while stmt.step_row().map_err(|e| e.to_string())? {
            out.push(json!({
                "traceId": stmt.column_text(0).unwrap_or_default(),
                "sessionId": stmt.column_text(1).unwrap_or_default(),
                "providerId": stmt.column_text(2).unwrap_or_default(),
                "modelId": stmt.column_text(3).unwrap_or_default(),
                "surface": stmt.column_text(4).unwrap_or_default(),
                "inputTokens": stmt.column_int64(5).unwrap_or(0),
                "outputTokens": stmt.column_int64(6).unwrap_or(0),
                "cacheReadTokens": stmt.column_int64(7).unwrap_or(0),
                "cacheWriteTokens": stmt.column_int64(8).unwrap_or(0),
                "costUsd": stmt.column_double(9).unwrap_or(0.0),
                "durationMs": stmt.column_int64(10).unwrap_or(0),
                "ttftMs": stmt.column_opt_int64(11).ok().flatten(),
                "tokensPerSecond": stmt.column_double(12).unwrap_or(0.0),
                "isError": stmt.column_int64(13).unwrap_or(0) != 0,
                "errorNote": stmt.column_opt_text(14).ok().flatten(),
                "savedTokens": stmt.column_int64(15).unwrap_or(0),
                "recordedAtMs": stmt.column_int64(16).unwrap_or(0),
            }));
        }
        Ok(out)
    }

    /// Computes genuine SQLite aggregate statistics for `omp-stats` (`/api/stats/overview`,
    /// `/api/stats/spotlight`, `/api/traces`) — strictly 0/null when no runs are recorded!
    pub fn stats_snapshot(&self) -> Result<Value, String> {
        let conn = self.conn.lock();
        let mut agg = conn
            .prepare(
                "SELECT COUNT(*),
                        COALESCE(SUM(CASE WHEN is_error = 0 THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN is_error != 0 THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(input_tokens), 0),
                        COALESCE(SUM(output_tokens), 0),
                        COALESCE(SUM(cache_read_tokens), 0),
                        COALESCE(SUM(cache_write_tokens), 0),
                        COALESCE(SUM(cost_usd), 0.0),
                        COALESCE(SUM(saved_tokens), 0),
                        AVG(duration_ms),
                        AVG(ttft_ms),
                        AVG(tokens_per_second),
                        COALESCE(MIN(recorded_at_ms), 0),
                        COALESCE(MAX(recorded_at_ms), 0)
                 FROM ops_usage_traces;",
            )
            .map_err(|e| e.to_string())?;

        let (
            total_req,
            ok_req,
            err_req,
            in_tok,
            out_tok,
            cr_tok,
            cw_tok,
            total_cost,
            saved_tok,
            avg_dur,
            avg_ttft,
            avg_tps,
            first_ts,
            last_ts,
        ) = if agg.step_row().map_err(|e| e.to_string())? {
            let opt_double = |col: i32| -> Option<f64> {
                if agg.column_is_null(col) {
                    None
                } else {
                    agg.column_double(col).ok()
                }
            };
            (
                agg.column_int64(0).unwrap_or(0),
                agg.column_int64(1).unwrap_or(0),
                agg.column_int64(2).unwrap_or(0),
                agg.column_int64(3).unwrap_or(0),
                agg.column_int64(4).unwrap_or(0),
                agg.column_int64(5).unwrap_or(0),
                agg.column_int64(6).unwrap_or(0),
                agg.column_double(7).unwrap_or(0.0),
                agg.column_int64(8).unwrap_or(0),
                opt_double(9),
                opt_double(10),
                opt_double(11),
                agg.column_int64(12).unwrap_or(0),
                agg.column_int64(13).unwrap_or(0),
            )
        } else {
            (0, 0, 0, 0, 0, 0, 0, 0.0, 0, None, None, None, 0, 0)
        };
        drop(agg);

        let denom_in = in_tok + cr_tok + cw_tok;
        let cache_rate = if denom_in > 0 {
            (cr_tok as f64) / (denom_in as f64)
        } else {
            0.0
        };
        let error_rate = if total_req > 0 {
            (err_req as f64) / (total_req as f64)
        } else {
            0.0
        };

        let mut recent_stmt = conn
            .prepare(
                "SELECT trace_id, session_id, provider_id, model_id, surface,
                        input_tokens, output_tokens, cache_read_tokens, cost_usd,
                        duration_ms, ttft_ms, tokens_per_second, is_error, error_note,
                        saved_tokens, recorded_at_ms
                 FROM ops_usage_traces ORDER BY recorded_at_ms DESC LIMIT 50;",
            )
            .map_err(|e| e.to_string())?;
        let mut traces = Vec::new();
        while recent_stmt.step_row().map_err(|e| e.to_string())? {
            traces.push(json!({
                "traceId": recent_stmt.column_text(0).unwrap_or_default(),
                "sessionId": recent_stmt.column_text(1).unwrap_or_default(),
                "provider": recent_stmt.column_text(2).unwrap_or_default(),
                "model": recent_stmt.column_text(3).unwrap_or_default(),
                "surface": recent_stmt.column_text(4).unwrap_or_default(),
                "inputTokens": recent_stmt.column_int64(5).unwrap_or(0),
                "outputTokens": recent_stmt.column_int64(6).unwrap_or(0),
                "cacheReadTokens": recent_stmt.column_int64(7).unwrap_or(0),
                "costUsd": recent_stmt.column_double(8).unwrap_or(0.0),
                "durationMs": recent_stmt.column_int64(9).unwrap_or(0),
                "ttftMs": recent_stmt.column_opt_int64(10).unwrap_or(None),
                "tokensPerSecond": recent_stmt.column_double(11).unwrap_or(0.0),
                "isError": recent_stmt.column_int64(12).unwrap_or(0) != 0,
                "errorNote": recent_stmt.column_opt_text(13).unwrap_or(None),
                "savedTokens": recent_stmt.column_int64(14).unwrap_or(0),
                "recordedAtMs": recent_stmt.column_int64(15).unwrap_or(0),
            }));
        }

        Ok(json!({
            "totalRequests": total_req,
            "successfulRequests": ok_req,
            "failedRequests": err_req,
            "errorRate": error_rate,
            "totalInputTokens": in_tok,
            "totalOutputTokens": out_tok,
            "totalCacheReadTokens": cr_tok,
            "totalCacheWriteTokens": cw_tok,
            "cacheRate": cache_rate,
            "totalCost": total_cost,
            "totalSavedTokens": saved_tok,
            "avgDuration": avg_dur,
            "avgTtft": avg_ttft,
            "avgTokensPerSecond": avg_tps,
            "firstTimestamp": first_ts,
            "lastTimestamp": last_ts,
            "recentTraces": traces,
        }))
    }
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
    }
}
