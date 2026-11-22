use omnia_core::{parse_json, utf8_codepoint_count, utf8_has_control_chars};
use serde_json::{json, Value};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::error::StoreError;

pub const MAX_AGENT_SESSION_TITLE_CHARS: usize = 256;
pub const MAX_AGENT_MODEL_CHARS: usize = 128;
pub const MAX_AGENT_SESSION_ID_CHARS: usize = 256;
pub const MAX_AGENT_SESSION_PAGE_LIMIT: usize = 100;
pub const DEFAULT_AGENT_SESSION_PAGE_LIMIT: usize = 50;
pub const MAX_NAVIGATION_OPEN_SESSION_IDS: usize = 64;
pub const DEFAULT_TOKEN_BUDGET: i64 = 128_000;

/// Execution environment associated with an Omnia native harness session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HarnessEnvironment {
    Wsl,
    WindowsNative,
    CloudApi,
}

impl HarnessEnvironment {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Wsl => "wsl",
            Self::WindowsNative => "windows_native",
            Self::CloudApi => "cloud_api",
        }
    }

    #[must_use]
    pub const fn display_label(self) -> &'static str {
        match self {
            Self::Wsl => "WSL",
            Self::WindowsNative => "Windows Native",
            Self::CloudApi => "Cloud API",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "wsl" => Ok(Self::Wsl),
            "windows_native" | "windows-native" | "windows" | "native" => Ok(Self::WindowsNative),
            "cloud_api" | "cloud-api" | "cloud" => Ok(Self::CloudApi),
            _ => Err(StoreError::invalid_input(format!(
                "Invalid harness environment '{raw}'."
            ))),
        }
    }
}

impl fmt::Display for HarnessEnvironment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Lifecycle state persisted in `agent_run_state` for active and interrupted turns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentRunStatus {
    Idle,
    Running,
    Interrupted,
    Completed,
    Failed,
    Cancelled,
}

impl AgentRunStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Interrupted => "interrupted",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "idle" => Ok(Self::Idle),
            "running" => Ok(Self::Running),
            "interrupted" => Ok(Self::Interrupted),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" | "canceled" => Ok(Self::Cancelled),
            _ => Err(StoreError::invalid_input(format!(
                "Invalid agent run status '{raw}'."
            ))),
        }
    }
}

impl fmt::Display for AgentRunStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Persistent summary record stored as `summary_json` in `agent_sessions`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSessionSummary {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub environment: HarnessEnvironment,
    pub model: String,
    pub status: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub revision: i64,
    pub token_budget: i64,
    pub tokens_used: i64,
    pub message_count: i64,
}

impl AgentSessionSummary {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "title": self.title,
            "cwd": self.cwd,
            "environment": self.environment.as_str(),
            "model": self.model,
            "status": self.status,
            "createdAtMs": self.created_at_ms,
            "updatedAtMs": self.updated_at_ms,
            "revision": self.revision,
            "tokenBudget": self.token_budget,
            "tokensUsed": self.tokens_used,
            "messageCount": self.message_count,
        })
    }

    pub fn from_json(val: &Value) -> Result<Self, StoreError> {
        let obj = val.as_object().ok_or_else(|| {
            StoreError::storage_failed("Stored session summary JSON must be an object.")
        })?;
        let id = opt_str(obj, &["id", "sessionId", "session_id"])
            .ok_or_else(|| StoreError::storage_failed("Stored session summary is missing 'id'."))?;
        validate_session_id(&id)?;
        let title_raw = opt_str(obj, &["title"]).unwrap_or_default();
        let title = normalize_and_validate_title(&title_raw)?;
        let cwd = opt_str(obj, &["cwd"]).unwrap_or_default();
        let env_raw = opt_str(obj, &["environment"]).unwrap_or_else(|| "windows_native".to_owned());
        let environment = HarnessEnvironment::parse(&env_raw)?;
        let model_raw = opt_str(obj, &["model"]).unwrap_or_default();
        let model = normalize_and_validate_model(&model_raw)?;
        let status = opt_str(obj, &["status"]).unwrap_or_else(|| "active".to_owned());
        if status.trim().is_empty() || utf8_has_control_chars(&status) {
            return Err(StoreError::storage_failed(
                "Stored session summary has invalid status.",
            ));
        }
        let created_at_ms = opt_i64(obj, &["createdAtMs", "created_at_ms"]).unwrap_or(0);
        let updated_at_ms =
            opt_i64(obj, &["updatedAtMs", "updated_at_ms"]).unwrap_or(created_at_ms);
        let revision = opt_i64(obj, &["revision"]).unwrap_or(1);
        if revision <= 0 {
            return Err(StoreError::storage_failed(
                "Stored session summary revision must be positive.",
            ));
        }
        let token_budget =
            opt_i64(obj, &["tokenBudget", "token_budget"]).unwrap_or(DEFAULT_TOKEN_BUDGET);
        let tokens_used = opt_i64(obj, &["tokensUsed", "tokens_used"]).unwrap_or(0);
        let message_count = opt_i64(obj, &["messageCount", "message_count"]).unwrap_or(0);
        if created_at_ms < 0
            || updated_at_ms < 0
            || token_budget < 0
            || tokens_used < 0
            || message_count < 0
        {
            return Err(StoreError::storage_failed(
                "Stored session summary contains negative numeric counters.",
            ));
        }

        Ok(Self {
            id,
            title,
            cwd,
            environment,
            model,
            status,
            created_at_ms,
            updated_at_ms,
            revision,
            token_budget,
            tokens_used,
            message_count,
        })
    }

    pub fn from_storage_json(raw: &str) -> Result<Self, StoreError> {
        let val = parse_json(raw).map_err(|err| {
            StoreError::storage_failed(format!("Invalid session summary JSON in SQLite: {err}"))
        })?;
        Self::from_json(&val)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMessage {
    pub id: String,
    pub session_id: String,
    pub seq: i64,
    pub role: String,
    pub content: String,
    pub created_at_ms: i64,
    pub metadata: Value,
}

impl AgentMessage {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "sessionId": self.session_id,
            "seq": self.seq,
            "role": self.role,
            "content": self.content,
            "createdAtMs": self.created_at_ms,
            "metadata": self.metadata,
        })
    }

    pub fn from_storage_json(raw: &str) -> Result<Self, StoreError> {
        let val = parse_json(raw).map_err(|err| {
            StoreError::storage_failed(format!("Invalid message JSON in SQLite: {err}"))
        })?;
        let obj = val
            .as_object()
            .ok_or_else(|| StoreError::storage_failed("Message JSON must be an object."))?;
        Ok(Self {
            id: opt_str(obj, &["id"]).unwrap_or_default(),
            session_id: opt_str(obj, &["sessionId", "session_id"]).unwrap_or_default(),
            seq: opt_i64(obj, &["seq"]).unwrap_or(0),
            role: opt_str(obj, &["role"]).unwrap_or_default(),
            content: opt_str(obj, &["content"]).unwrap_or_default(),
            created_at_ms: opt_i64(obj, &["createdAtMs", "created_at_ms"]).unwrap_or(0),
            metadata: obj.get("metadata").cloned().unwrap_or_else(|| json!({})),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSessionPageCursor {
    pub updated_at_ms: i64,
    pub id: String,
}

impl AgentSessionPageCursor {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "updatedAtMs": self.updated_at_ms,
            "id": self.id,
        })
    }

    pub fn from_json(val: &Value) -> Result<Self, StoreError> {
        let obj = val.as_object().ok_or_else(|| {
            StoreError::invalid_input("Session page cursor JSON must be an object.")
        })?;
        let updated_at_ms = opt_i64(obj, &["updatedAtMs", "updated_at_ms"]).ok_or_else(|| {
            StoreError::invalid_input("Session page cursor is missing updatedAtMs.")
        })?;
        let id = opt_str(obj, &["id", "sessionId", "session_id"])
            .ok_or_else(|| StoreError::invalid_input("Session page cursor is missing id."))?;
        validate_session_id(&id)?;
        Ok(Self { updated_at_ms, id })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSessionPage {
    pub items: Vec<AgentSessionSummary>,
    pub next_cursor: Option<AgentSessionPageCursor>,
    pub has_more: bool,
    pub total_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSessionNavigationSnapshot {
    pub revision: i64,
    pub active_session_id: Option<String>,
    pub open_session_ids: Vec<String>,
    pub page_limit: usize,
    pub cursor: Option<AgentSessionPageCursor>,
    pub updated_at_ms: i64,
}

impl Default for AgentSessionNavigationSnapshot {
    fn default() -> Self {
        Self {
            revision: 1,
            active_session_id: None,
            open_session_ids: Vec::new(),
            page_limit: DEFAULT_AGENT_SESSION_PAGE_LIMIT,
            cursor: None,
            updated_at_ms: 0,
        }
    }
}

impl AgentSessionNavigationSnapshot {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "revision": self.revision,
            "activeSessionId": self.active_session_id,
            "openSessionIds": self.open_session_ids,
            "pageLimit": self.page_limit,
            "cursor": self.cursor.as_ref().map(AgentSessionPageCursor::to_json),
            "updatedAtMs": self.updated_at_ms,
        })
    }

    pub fn from_storage_json(raw: &str, row_revision: i64) -> Result<Self, StoreError> {
        let val = parse_json(raw).map_err(|err| {
            StoreError::storage_failed(format!("Invalid navigation JSON in SQLite: {err}"))
        })?;
        let obj = val
            .as_object()
            .ok_or_else(|| StoreError::storage_failed("Navigation JSON must be an object."))?;
        let active_session_id =
            opt_str(obj, &["activeSessionId", "active_session_id"]).filter(|s| !s.is_empty());
        if let Some(ref active) = active_session_id {
            validate_session_id(active)?;
        }
        let open_session_ids = match obj
            .get("openSessionIds")
            .or_else(|| obj.get("open_session_ids"))
        {
            Some(Value::Array(arr)) => {
                let mut ids = Vec::with_capacity(arr.len());
                for item in arr {
                    let s = item.as_str().ok_or_else(|| {
                        StoreError::storage_failed("openSessionIds entries must be strings.")
                    })?;
                    validate_session_id(s)?;
                    ids.push(s.to_owned());
                }
                ids
            }
            Some(Value::Null) | None => Vec::new(),
            _ => {
                return Err(StoreError::storage_failed(
                    "openSessionIds must be an array.",
                ));
            }
        };
        let page_limit = opt_i64(obj, &["pageLimit", "page_limit"])
            .and_then(|v| usize::try_from(v).ok())
            .unwrap_or(DEFAULT_AGENT_SESSION_PAGE_LIMIT);
        let cursor = match obj.get("cursor") {
            Some(Value::Null) | None => None,
            Some(v) => Some(AgentSessionPageCursor::from_json(v)?),
        };
        let updated_at_ms = opt_i64(obj, &["updatedAtMs", "updated_at_ms"]).unwrap_or(0);
        Ok(Self {
            revision: row_revision,
            active_session_id,
            open_session_ids,
            page_limit: page_limit.clamp(1, MAX_AGENT_SESSION_PAGE_LIMIT),
            cursor,
            updated_at_ms,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveAgentSessionNavigationRequest {
    pub expected_revision: Option<i64>,
    pub active_session_id: Option<String>,
    pub open_session_ids: Vec<String>,
    pub page_limit: usize,
    pub cursor: Option<AgentSessionPageCursor>,
    pub receipt_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateAgentSessionRequest {
    pub id: Option<String>,
    pub title: String,
    pub cwd: String,
    pub environment: HarnessEnvironment,
    pub model: String,
    pub token_budget: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateAgentSessionSettingsRequest {
    pub session_id: String,
    pub expected_revision: i64,
    pub title: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderProfileRecord {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub secret_key: String,
    pub enabled: bool,
    pub extra_json: Value,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderProfileInput {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub secret_key: String,
    pub enabled: bool,
    pub extra_json: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderSelection {
    pub profile: ProviderProfileRecord,
    pub api_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfiguredProvider {
    pub profile_id: String,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub extra_json: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRunStateRecord {
    pub session_id: String,
    pub status: AgentRunStatus,
    pub snapshot_sequence: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentEvent {
    pub sequence: i64,
    pub session_id: String,
    pub run_id: String,
    pub event_type: String,
    pub payload: Value,
    pub created_at_ms: i64,
}

impl AgentEvent {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "sequence": self.sequence,
            "sessionId": self.session_id,
            "runId": self.run_id,
            "eventType": self.event_type,
            "payload": self.payload,
            "createdAtMs": self.created_at_ms,
        })
    }

    pub fn from_storage_json(
        sequence: i64,
        session_id: &str,
        raw: &str,
    ) -> Result<Self, StoreError> {
        let val = parse_json(raw).map_err(|err| {
            StoreError::storage_failed(format!("Invalid event JSON in SQLite: {err}"))
        })?;
        let obj = val
            .as_object()
            .ok_or_else(|| StoreError::storage_failed("Event JSON must be an object."))?;
        Ok(Self {
            sequence,
            session_id: session_id.to_owned(),
            run_id: opt_str(obj, &["runId", "run_id"]).unwrap_or_default(),
            event_type: opt_str(obj, &["eventType", "event_type"])
                .unwrap_or_else(|| "event".to_owned()),
            payload: obj.get("payload").cloned().unwrap_or_else(|| json!({})),
            created_at_ms: opt_i64(obj, &["createdAtMs", "created_at_ms"]).unwrap_or(0),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunEventState {
    pub session_id: String,
    pub run_id: String,
    pub status: AgentRunStatus,
    pub last_sequence: i64,
    pub events: Vec<AgentEvent>,
}

/// Thread-safe cooperative cancellation flag shared between callers and active runs.
#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedSessionConfig {
    pub session: AgentSessionSummary,
    pub navigation: AgentSessionNavigationSnapshot,
    pub provider: Option<ConfiguredProvider>,
    pub run_state: AgentRunStateRecord,
}

/// Validate a non-empty printable session ID without whitespace or control chars.
pub fn validate_session_id(id: &str) -> Result<(), StoreError> {
    if id.is_empty() || id.trim() != id {
        return Err(StoreError::invalid_input(
            "Session id must be non-empty without leading or trailing whitespace.",
        ));
    }
    if utf8_codepoint_count(id) > MAX_AGENT_SESSION_ID_CHARS {
        return Err(StoreError::invalid_input(format!(
            "Session id exceeds {MAX_AGENT_SESSION_ID_CHARS} characters."
        )));
    }
    if utf8_has_control_chars(id) || id.chars().any(char::is_whitespace) {
        return Err(StoreError::invalid_input(
            "Session id cannot contain whitespace or control characters.",
        ));
    }
    Ok(())
}

/// Trim and validate an agent session title (`1..=256` codepoints, zero control characters).
pub fn normalize_and_validate_title(raw: &str) -> Result<String, StoreError> {
    if utf8_has_control_chars(raw) {
        return Err(StoreError::invalid_input(
            "Session title cannot contain control characters.",
        ));
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(StoreError::invalid_input(
            "Session title cannot be empty or whitespace.",
        ));
    }
    if utf8_codepoint_count(trimmed) > MAX_AGENT_SESSION_TITLE_CHARS {
        return Err(StoreError::invalid_input(format!(
            "Session title exceeds {MAX_AGENT_SESSION_TITLE_CHARS} characters."
        )));
    }
    Ok(trimmed.to_owned())
}

/// Trim and validate an agent model identifier (`1..=128` codepoints, zero control characters).
pub fn normalize_and_validate_model(raw: &str) -> Result<String, StoreError> {
    if utf8_has_control_chars(raw) {
        return Err(StoreError::invalid_input(
            "Session model cannot contain control characters.",
        ));
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(StoreError::invalid_input(
            "Session model cannot be empty or whitespace.",
        ));
    }
    if utf8_codepoint_count(trimmed) > MAX_AGENT_MODEL_CHARS {
        return Err(StoreError::invalid_input(format!(
            "Session model exceeds {MAX_AGENT_MODEL_CHARS} characters."
        )));
    }
    Ok(trimmed.to_owned())
}

pub fn validate_page_limit(limit: usize) -> Result<usize, StoreError> {
    if limit == 0 {
        return Err(StoreError::new(
            "session_page_invalid",
            "Session page limit must be at least 1.",
            false,
        ));
    }
    if limit > MAX_AGENT_SESSION_PAGE_LIMIT {
        return Err(StoreError::new(
            "session_page_too_large",
            format!("Session page limit {limit} exceeds maximum {MAX_AGENT_SESSION_PAGE_LIMIT}."),
            false,
        ));
    }
    Ok(limit)
}

fn opt_str(map: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(Value::String(s)) = map.get(*key) {
            return Some(s.clone());
        }
    }
    None
}

fn opt_i64(map: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<i64> {
    for key in keys {
        if let Some(v) = map.get(*key) {
            if let Some(n) = v.as_i64() {
                return Some(n);
            }
        }
    }
    None
}
