//! Omnia as an MCP *server*: other local apps drive Omnia sessions over
//! Streamable HTTP (JSON-RPC 2.0 `POST /mcp`, answered as `application/json`).
//!
//! Security model: OFF by default; bound to 127.0.0.1 only; every request
//! needs the bearer token generated when the server is enabled; requests with
//! a non-local `Origin` or `Host` are refused (browser CSRF / DNS rebinding).
//!
//! Layering, so the protocol is testable without Tauri:
//! * pure functions: [`authorize`], [`handle_message`], [`handle_http`],
//!   [`format_transcript`], [`last_assistant_text`];
//! * [`McpBackend`]: what the tools need from Omnia ([`TauriBackend`] is the
//!   real one, tests use a fake);
//! * [`serve`]: a minimal HTTP/1.1 listener on tokio (no server crate is
//!   available offline);
//! * [`McpServerManager`] + the `agent_mcp_server_*` commands.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use omnia_harness::mcp::PROTOCOL_VERSION;
use omnia_harness::{Block, Message, Role};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::error::{NativeError, NativeResult};
use crate::harness_bridge::{
    self, AgentSendRequest, AgentSessionCreateRequest, AgentSessionRef, HarnessHub,
};
use crate::state::AppState;
use crate::storage::{
    CreateGoalRequest, CreateGoalRevisionRequest, CreateTaskDependencyRequest, CreateTaskRequest,
    CreateTaskRevisionRequest, ListGoalsRequest, ListTaskDependenciesRequest, ListTasksRequest,
    ReadGoalRequest, ReadGoalRevisionRequest, ReadTaskRequest, ReadTaskRevisionRequest, Storage,
    UpdateGoalStatusRequest, UpdateTaskStatusRequest,
};

const SETTINGS_FILE: &str = "mcp_server.json";
const MAX_HEAD_BYTES: usize = 32 * 1024;
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(20);
const DEFAULT_WAIT_SECONDS: u64 = 600;
const MAX_TRANSCRIPT_CHARS: usize = 200_000;
/// Revisions this server can speak, newest first.
const SUPPORTED_PROTOCOLS: [&str; 3] = [PROTOCOL_VERSION, "2025-03-26", "2024-11-05"];

// ---------------------------------------------------------------------------
// Request authorization (pure)
// ---------------------------------------------------------------------------

/// Why a request was refused before reaching JSON-RPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reject {
    pub status: u16,
    pub message: &'static str,
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

/// Host part (no port, lowercase) of a `Host` value or URL authority.
fn host_only(authority: &str) -> String {
    let authority = authority.trim().to_ascii_lowercase();
    if authority.starts_with('[') {
        return match authority.find(']') {
            Some(end) => authority[..=end].to_owned(),
            None => authority,
        };
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host.to_owned(),
        _ => authority,
    }
}

fn is_local_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

fn origin_is_local(origin: &str) -> bool {
    let origin = origin.trim();
    let lower = origin.to_ascii_lowercase();
    let rest = match lower
        .strip_prefix("http://")
        .or_else(|| lower.strip_prefix("https://"))
    {
        Some(rest) => rest,
        None => return false, // includes the opaque "null" origin
    };
    let authority = rest.split('/').next().unwrap_or("");
    !authority.contains('@') && is_local_host(&host_only(authority))
}

/// Compares secrets without leaking the position of the first difference
/// (both sides are hashed to a fixed length first).
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (ha, hb) = (Sha256::digest(a.as_bytes()), Sha256::digest(b.as_bytes()));
    ha.iter()
        .zip(hb.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// Host, Origin and bearer-token checks. DNS-rebinding/CSRF checks come first
/// (403); only a request that passes them is asked for credentials (401).
pub fn authorize(headers: &[(String, String)], expected_token: &str) -> Result<(), Reject> {
    match header(headers, "host") {
        Some(host) if is_local_host(&host_only(host)) => {}
        _ => {
            return Err(Reject {
                status: 403,
                message: "Host must be 127.0.0.1 or localhost",
            })
        }
    }
    if let Some(origin) = header(headers, "origin") {
        if !origin_is_local(origin) {
            return Err(Reject {
                status: 403,
                message: "Cross-origin requests are not allowed",
            });
        }
    }
    let unauthorized = Reject {
        status: 401,
        message: "Missing or invalid bearer token",
    };
    let Some(value) = header(headers, "authorization") else {
        return Err(unauthorized);
    };
    let presented = match value.trim().split_once(' ') {
        Some((scheme, token)) if scheme.eq_ignore_ascii_case("bearer") => token.trim(),
        _ => return Err(unauthorized),
    };
    if expected_token.is_empty() || !constant_time_eq(presented, expected_token) {
        return Err(unauthorized);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Backend + tools
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CreateSessionArgs {
    pub cwd: String,
    pub profile_id: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SendArgs {
    pub session_id: String,
    pub text: String,
    pub wait: bool,
    pub timeout: Duration,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalPlanningStatus {
    #[default]
    Draft,
    Active,
    Paused,
    Completed,
    Archived,
    Cancelled,
}

impl GoalPlanningStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Archived => "archived",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalRemovalStatus {
    Archived,
    Cancelled,
}

impl GoalRemovalStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Archived => "archived",
            Self::Cancelled => "cancelled",
        }
    }
}

fn nonempty_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.trim().is_empty() {
        return Err(serde::de::Error::custom("must be a non-empty string"));
    }
    Ok(value)
}

/// A missing patch field preserves its base value; an explicitly supplied
/// non-null field must have the advertised type, rather than becoming None.
fn present_value<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// Nullable patch fields distinguish omission from an explicit request to clear.
fn present_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalListArgs {
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub branch_id: Option<String>,
    pub status: Option<GoalPlanningStatus>,
    pub include_archived: Option<bool>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalReadArgs {
    #[serde(deserialize_with = "nonempty_string")]
    pub goal_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalSetArgs {
    #[serde(deserialize_with = "nonempty_string")]
    pub title: String,
    pub description: Option<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<Value>,
    #[serde(default)]
    pub roadmap: serde_json::Map<String, Value>,
    #[serde(default)]
    pub metadata: serde_json::Map<String, Value>,
    #[serde(default)]
    pub status: GoalPlanningStatus,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub branch_id: Option<String>,
    pub state_revision_id: Option<String>,
    #[serde(deserialize_with = "nonempty_string")]
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalEditArgs {
    #[serde(deserialize_with = "nonempty_string")]
    pub goal_id: String,
    #[serde(deserialize_with = "nonempty_string")]
    pub expected_current_revision_id: String,
    #[serde(deserialize_with = "nonempty_string")]
    pub title: String,
    #[serde(default, deserialize_with = "present_nullable")]
    pub description: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_value")]
    pub acceptance_criteria: Option<Vec<Value>>,
    #[serde(default, deserialize_with = "present_value")]
    pub roadmap: Option<serde_json::Map<String, Value>>,
    #[serde(default, deserialize_with = "present_value")]
    pub metadata: Option<serde_json::Map<String, Value>>,
    #[serde(default, deserialize_with = "present_value")]
    pub status: Option<GoalPlanningStatus>,
    #[serde(default, deserialize_with = "present_nullable")]
    pub state_revision_id: Option<Option<String>>,
    #[serde(deserialize_with = "nonempty_string")]
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalRemoveArgs {
    #[serde(deserialize_with = "nonempty_string")]
    pub goal_id: String,
    pub expected_current_revision_id: Option<String>,
    pub expected_updated_at_ms: Option<i64>,
    pub status: GoalRemovalStatus,
    #[serde(deserialize_with = "nonempty_string")]
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskListArgs {
    pub goal_id: Option<String>,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub branch_id: Option<String>,
    pub status: Option<String>,
    pub include_archived: Option<bool>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskReadArgs {
    #[serde(deserialize_with = "nonempty_string")]
    pub task_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRevisionReadArgs {
    #[serde(deserialize_with = "nonempty_string")]
    pub task_id: String,
    #[serde(deserialize_with = "nonempty_string")]
    pub revision_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDependencyListArgs {
    #[serde(deserialize_with = "nonempty_string")]
    pub task_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCreateArgs {
    #[serde(deserialize_with = "nonempty_string")]
    pub goal_id: String,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub branch_id: Option<String>,
    pub state_revision_id: Option<String>,
    #[serde(deserialize_with = "nonempty_string")]
    pub title: String,
    pub description: Option<String>,
    #[serde(default)]
    pub metadata: serde_json::Map<String, Value>,
    #[serde(default = "default_task_status")]
    pub status: String,
    #[serde(deserialize_with = "nonempty_string")]
    pub idempotency_key: String,
}

fn default_task_status() -> String {
    "pending".to_owned()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRevisionCreateArgs {
    #[serde(deserialize_with = "nonempty_string")]
    pub task_id: String,
    pub expected_current_revision_id: Option<String>,
    pub state_revision_id: Option<String>,
    #[serde(deserialize_with = "nonempty_string")]
    pub payload_json: String,
    #[serde(deserialize_with = "nonempty_string")]
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskStatusUpdateArgs {
    #[serde(deserialize_with = "nonempty_string")]
    pub task_id: String,
    #[serde(deserialize_with = "nonempty_string")]
    pub status: String,
    pub expected_updated_at_ms: Option<i64>,
    #[serde(deserialize_with = "nonempty_string")]
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDependencyCreateArgs {
    #[serde(deserialize_with = "nonempty_string")]
    pub from_task_id: String,
    #[serde(deserialize_with = "nonempty_string")]
    pub to_task_id: String,
    #[serde(deserialize_with = "nonempty_string")]
    pub dependency_kind: String,
}

/// What the MCP tools need from Omnia. Errors are user-facing strings.
#[async_trait]
pub trait McpBackend: Send + Sync + 'static {
    async fn list_sessions(&self) -> Result<Value, String>;
    async fn read_session(&self, session_id: &str, last_n: Option<usize>)
        -> Result<String, String>;
    async fn create_session(&self, args: CreateSessionArgs) -> Result<Value, String>;
    async fn send_message(&self, args: SendArgs) -> Result<Value, String>;
    async fn interrupt(&self, session_id: &str) -> Result<Value, String>;
    async fn list_profiles(&self) -> Result<Value, String>;
    async fn goal_list(&self, args: GoalListArgs) -> Result<Value, String>;
    async fn goal_read(&self, args: GoalReadArgs) -> Result<Value, String>;
    async fn goal_set(&self, args: GoalSetArgs) -> Result<Value, String>;
    async fn goal_edit(&self, args: GoalEditArgs) -> Result<Value, String>;
    async fn goal_remove(&self, args: GoalRemoveArgs) -> Result<Value, String>;
    async fn task_list(&self, args: TaskListArgs) -> Result<Value, String>;
    async fn task_read(&self, args: TaskReadArgs) -> Result<Value, String>;
    async fn task_revision_read(&self, args: TaskRevisionReadArgs) -> Result<Value, String>;
    async fn task_dependency_list(&self, args: TaskDependencyListArgs) -> Result<Value, String>;
    async fn task_create(&self, args: TaskCreateArgs) -> Result<Value, String>;
    async fn task_revision_create(&self, args: TaskRevisionCreateArgs) -> Result<Value, String>;
    async fn task_status_update(&self, args: TaskStatusUpdateArgs) -> Result<Value, String>;
    async fn task_dependency_create(&self, args: TaskDependencyCreateArgs)
        -> Result<Value, String>;
}

pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "omnia_list_sessions",
            "description": "List Omnia agent sessions (id, title, workspace folder, model, permission mode, running flag).",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
        },
        {
            "name": "omnia_read_session",
            "description": "Read a session's transcript as plain text.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": {"type": "string"},
                    "lastN": {"type": "integer", "minimum": 1, "description": "Only the last N messages."}
                },
                "required": ["sessionId"],
                "additionalProperties": false
            }
        },
        {
            "name": "omnia_create_session",
            "description": "Create a new session in an existing absolute workspace folder. profileId and model default to the most recently used ones. permissionMode is one of ask_all, ask_writes (default), auto, full, plan.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cwd": {"type": "string", "description": "Absolute path of an existing folder."},
                    "profileId": {"type": "string"},
                    "model": {"type": "string"},
                    "permissionMode": {"type": "string"}
                },
                "required": ["cwd"],
                "additionalProperties": false
            }
        },
        {
            "name": "omnia_send_message",
            "description": "Send a message to a session and start an agent run. With wait=true (default) it blocks until the run finishes and returns {status, text} where text is the final assistant reply. The run uses the session's permission mode: tool approvals it needs are NOT answered through MCP, they appear in the Omnia desktop UI and the run waits there until the user decides (or the timeout elapses; the run keeps going).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": {"type": "string"},
                    "text": {"type": "string"},
                    "wait": {"type": "boolean", "default": true},
                    "timeoutSeconds": {"type": "integer", "minimum": 1, "maximum": 600, "default": 600}
                },
                "required": ["sessionId", "text"],
                "additionalProperties": false
            }
        },
        {
            "name": "omnia_interrupt",
            "description": "Interrupt the running agent in a session.",
            "inputSchema": {
                "type": "object",
                "properties": {"sessionId": {"type": "string"}},
                "required": ["sessionId"],
                "additionalProperties": false
            }
        },
        {
            "name": "omnia_list_profiles",
            "description": "List configured provider profiles (id, name, type, enabled). Credentials are never returned.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
        },
        {
            "name": "omnia_goal_list",
            "description": "List bounded native goal summaries. Goals are planning records with preview-only execution disposition; listing does not dispatch a provider or scheduler.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "projectId": {"type": ["string", "null"]},
                    "conversationId": {"type": ["string", "null"]},
                    "branchId": {"type": ["string", "null"]},
                    "status": {"enum": ["draft", "active", "paused", "completed", "archived", "cancelled", null]},
                    "includeArchived": {"type": ["boolean", "null"], "default": false},
                    "limit": {"type": ["integer", "null"], "minimum": 1, "maximum": 256, "default": 64}
                },
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "omnia_goal_read",
            "description": "Read a verified native goal snapshot, current immutable revision, replay status and preview-only execution disposition.",
            "inputSchema": {
                "type": "object",
                "properties": {"goalId": {"type": "string", "minLength": 1}},
                "required": ["goalId"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "omnia_goal_set",
            "description": "Create a native planning goal and its immutable first revision. The required idempotencyKey replays the same intent and rejects payload drift. status defaults to draft. This does not start or steer an agent run.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "minLength": 1, "maxLength": 500},
                    "description": {"type": ["string", "null"], "maxLength": 16000},
                    "acceptanceCriteria": {"type": "array", "items": {}, "default": []},
                    "roadmap": {"type": "object", "default": {}},
                    "metadata": {"type": "object", "default": {}},
                    "status": {"enum": ["draft", "active", "paused", "completed", "archived", "cancelled"], "default": "draft"},
                    "projectId": {"type": ["string", "null"]},
                    "conversationId": {"type": ["string", "null"]},
                    "branchId": {"type": ["string", "null"]},
                    "stateRevisionId": {"type": ["string", "null"]},
                    "idempotencyKey": {"type": "string", "minLength": 1, "description": "Stable key for this exact mutation; native storage enforces a 512 UTF-8 byte limit."}
                },
                "required": ["title", "idempotencyKey"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true}
        },
        {
            "name": "omnia_goal_edit",
            "description": "Append an immutable native goal revision with required current-revision CAS and idempotencyKey. Supply the new title; omitted fields preserve their values from expectedCurrentRevisionId, while description/stateRevisionId may be cleared with null. Scope is immutable. Native lifecycle rules apply. This changes planning state only and does not steer an active provider run.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "goalId": {"type": "string", "minLength": 1},
                    "expectedCurrentRevisionId": {"type": "string", "minLength": 1},
                    "title": {"type": "string", "minLength": 1, "maxLength": 500},
                    "description": {"type": ["string", "null"], "maxLength": 16000},
                    "acceptanceCriteria": {"type": "array", "items": {}},
                    "roadmap": {"type": "object"},
                    "metadata": {"type": "object"},
                    "status": {"enum": ["draft", "active", "paused", "completed", "archived", "cancelled"]},
                    "stateRevisionId": {"type": ["string", "null"]},
                    "idempotencyKey": {"type": "string", "minLength": 1}
                },
                "required": ["goalId", "expectedCurrentRevisionId", "title", "idempotencyKey"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true}
        },
        {
            "name": "omnia_goal_remove",
            "description": "Archive or cancel a native planning goal. Supply expectedCurrentRevisionId for immutable revision CAS, or expectedUpdatedAtMs for the native timestamp CAS. History is retained; no physical deletion occurs. This records planning lifecycle only: it does not interrupt a harness session or confirm cancellation of a running provider.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "goalId": {"type": "string", "minLength": 1},
                    "expectedCurrentRevisionId": {"type": "string", "minLength": 1},
                    "expectedUpdatedAtMs": {"type": "integer", "minimum": 1},
                    "status": {"enum": ["archived", "cancelled"]},
                    "idempotencyKey": {"type": "string", "minLength": 1}
                },
                "required": ["goalId", "status", "idempotencyKey"],
                "anyOf": [
                    {"required": ["expectedCurrentRevisionId"]},
                    {"required": ["expectedUpdatedAtMs"]}
                ],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true}
        },
        {
            "name": "omnia_task_list",
            "description": "List bounded native Task summaries within an optional Goal/project scope. Tasks are planning records with preview-only execution disposition; listing does not schedule or dispatch work.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "goalId": {"type": ["string", "null"]},
                    "projectId": {"type": ["string", "null"]},
                    "conversationId": {"type": ["string", "null"]},
                    "branchId": {"type": ["string", "null"]},
                    "status": {"type": ["string", "null"]},
                    "includeArchived": {"type": ["boolean", "null"], "default": false},
                    "limit": {"type": ["integer", "null"], "minimum": 1, "maximum": 256, "default": 64}
                },
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "omnia_task_read",
            "description": "Read a verified native Task snapshot, immutable current revision, dependencies and preview-only execution disposition.",
            "inputSchema": {
                "type": "object",
                "properties": {"taskId": {"type": "string", "minLength": 1}},
                "required": ["taskId"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "omnia_task_revision_read",
            "description": "Read one verified immutable historical Task revision. Historical planning reads retain lineage checks and do not dispatch work.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": {"type": "string", "minLength": 1},
                    "revisionId": {"type": "string", "minLength": 1}
                },
                "required": ["taskId", "revisionId"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "omnia_task_dependency_list",
            "description": "List verified native dependencies touching a Task. Dependency metadata is planning state and is not scheduler admission.",
            "inputSchema": {
                "type": "object",
                "properties": {"taskId": {"type": "string", "minLength": 1}},
                "required": ["taskId"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "omnia_task_create",
            "description": "Create a native planning Task under a live Goal with an immutable first revision. The idempotency key is bound to Goal scope and payload. This does not enqueue, schedule or start a provider run.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "goalId": {"type": "string", "minLength": 1},
                    "projectId": {"type": ["string", "null"]},
                    "conversationId": {"type": ["string", "null"]},
                    "branchId": {"type": ["string", "null"]},
                    "stateRevisionId": {"type": ["string", "null"]},
                    "title": {"type": "string", "minLength": 1, "maxLength": 500},
                    "description": {"type": ["string", "null"], "maxLength": 16000},
                    "metadata": {"type": "object", "default": {}},
                    "status": {"type": "string", "default": "pending"},
                    "idempotencyKey": {"type": "string", "minLength": 1}
                },
                "required": ["goalId", "title", "idempotencyKey"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true}
        },
        {
            "name": "omnia_task_revision_create",
            "description": "Append an immutable Task planning revision with optional current-revision CAS and idempotency key. Same-status metadata edits are allowed; terminal Tasks cannot receive revisions. No provider dispatch occurs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": {"type": "string", "minLength": 1},
                    "expectedCurrentRevisionId": {"type": ["string", "null"]},
                    "stateRevisionId": {"type": ["string", "null"]},
                    "payloadJson": {"type": "string", "minLength": 1},
                    "idempotencyKey": {"type": "string", "minLength": 1}
                },
                "required": ["taskId", "payloadJson", "idempotencyKey"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true}
        },
        {
            "name": "omnia_task_status_update",
            "description": "Apply a validated native Task lifecycle transition with optional timestamp CAS and idempotency key. This changes planning metadata only and does not cancel or start a provider run.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": {"type": "string", "minLength": 1},
                    "status": {"type": "string", "minLength": 1},
                    "expectedUpdatedAtMs": {"type": ["integer", "null"], "minimum": 1},
                    "idempotencyKey": {"type": "string", "minLength": 1}
                },
                "required": ["taskId", "status", "idempotencyKey"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true}
        },
        {
            "name": "omnia_task_dependency_create",
            "description": "Create a scope-checked, cycle-checked Task dependency. The relation is planning metadata only and is not live scheduler admission or DAG execution control.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "fromTaskId": {"type": "string", "minLength": 1},
                    "toTaskId": {"type": "string", "minLength": 1},
                    "dependencyKind": {"enum": ["blocks", "requires", "related"]}
                },
                "required": ["fromTaskId", "toTaskId", "dependencyKind"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true}
        }
    ])
}

/// Returns the canonical planning-tool definitions used by both MCP and the
/// in-process harness adapter. The full MCP surface remains separate so
/// session/provider tools cannot accidentally become builtin AI tools.
pub fn goal_tool_definitions() -> Value {
    let tools = tool_definitions()
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|tool| {
            matches!(
                tool.get("name").and_then(Value::as_str),
                Some(
                    "omnia_goal_list"
                        | "omnia_goal_read"
                        | "omnia_goal_set"
                        | "omnia_goal_edit"
                        | "omnia_goal_remove"
                )
            )
        })
        .collect::<Vec<_>>();
    Value::Array(tools)
}

/// Returns the canonical Task planning-tool definitions shared by MCP and
/// the in-process Omnia adapter.
pub fn task_tool_definitions() -> Value {
    let tools = tool_definitions()
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|tool| {
            matches!(
                tool.get("name").and_then(Value::as_str),
                Some(
                    "omnia_task_list"
                        | "omnia_task_read"
                        | "omnia_task_revision_read"
                        | "omnia_task_dependency_list"
                        | "omnia_task_create"
                        | "omnia_task_revision_create"
                        | "omnia_task_status_update"
                        | "omnia_task_dependency_create"
                )
            )
        })
        .collect::<Vec<_>>();
    Value::Array(tools)
}

fn text_result(text: impl Into<String>, is_error: bool) -> Value {
    json!({"content": [{"type": "text", "text": text.into()}], "isError": is_error})
}

fn json_result(value: &Value, is_error: bool) -> Value {
    text_result(
        serde_json::to_string_pretty(value).unwrap_or_default(),
        is_error,
    )
}

fn required_str(args: &Value, key: &str) -> Result<String, String> {
    match args.get(key).and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => Ok(value.to_owned()),
        _ => Err(format!(
            "`{key}` is required and must be a non-empty string"
        )),
    }
}

fn optional_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn goal_arguments<T: serde::de::DeserializeOwned>(args: &Value) -> Result<T, String> {
    if !args.is_object() {
        return Err("Goal tool arguments must be a JSON object".to_owned());
    }
    serde_json::from_value(args.clone())
        .map_err(|error| format!("Invalid goal tool arguments: {error}"))
}

/// Runs one tool. `Err` = unknown tool (protocol error); a tool's own
/// failure is `Ok` with `isError: true`.
async fn call_tool(name: &str, args: &Value, backend: &dyn McpBackend) -> Result<Value, ()> {
    let outcome: Result<Value, String> = match name {
        "omnia_list_sessions" => backend
            .list_sessions()
            .await
            .map(|v| json_result(&v, false)),
        "omnia_list_profiles" => backend
            .list_profiles()
            .await
            .map(|v| json_result(&v, false)),
        "omnia_read_session" => match required_str(args, "sessionId") {
            Ok(session_id) => {
                let last_n = args
                    .get("lastN")
                    .and_then(Value::as_u64)
                    .map(|n| n.max(1) as usize);
                backend
                    .read_session(&session_id, last_n)
                    .await
                    .map(|text| text_result(text, false))
            }
            Err(error) => Err(error),
        },
        "omnia_create_session" => match required_str(args, "cwd") {
            Ok(cwd) => backend
                .create_session(CreateSessionArgs {
                    cwd,
                    profile_id: optional_str(args, "profileId"),
                    model: optional_str(args, "model"),
                    permission_mode: optional_str(args, "permissionMode"),
                })
                .await
                .map(|v| json_result(&v, false)),
            Err(error) => Err(error),
        },
        "omnia_send_message" => match (required_str(args, "sessionId"), required_str(args, "text"))
        {
            (Ok(session_id), Ok(text)) => {
                let timeout = args
                    .get("timeoutSeconds")
                    .and_then(Value::as_u64)
                    .unwrap_or(DEFAULT_WAIT_SECONDS)
                    .clamp(1, DEFAULT_WAIT_SECONDS);
                backend
                    .send_message(SendArgs {
                        session_id,
                        text,
                        wait: args.get("wait").and_then(Value::as_bool).unwrap_or(true),
                        timeout: Duration::from_secs(timeout),
                    })
                    .await
                    .map(|v| {
                        let failed = v.get("status").and_then(Value::as_str) == Some("failed");
                        json_result(&v, failed)
                    })
            }
            (Err(error), _) | (_, Err(error)) => Err(error),
        },
        "omnia_interrupt" => match required_str(args, "sessionId") {
            Ok(session_id) => backend
                .interrupt(&session_id)
                .await
                .map(|v| json_result(&v, false)),
            Err(error) => Err(error),
        },
        "omnia_goal_list" => match goal_arguments(args) {
            Ok(args) => backend
                .goal_list(args)
                .await
                .map(|v| json_result(&v, false)),
            Err(error) => Err(error),
        },
        "omnia_goal_read" => match goal_arguments(args) {
            Ok(args) => backend
                .goal_read(args)
                .await
                .map(|v| json_result(&v, false)),
            Err(error) => Err(error),
        },
        "omnia_goal_set" => match goal_arguments(args) {
            Ok(args) => backend.goal_set(args).await.map(|v| json_result(&v, false)),
            Err(error) => Err(error),
        },
        "omnia_goal_edit" => match goal_arguments(args) {
            Ok(args) => backend
                .goal_edit(args)
                .await
                .map(|v| json_result(&v, false)),
            Err(error) => Err(error),
        },
        "omnia_goal_remove" => match goal_arguments(args) {
            Ok(args) => backend
                .goal_remove(args)
                .await
                .map(|v| json_result(&v, false)),
            Err(error) => Err(error),
        },
        "omnia_task_list" => match goal_arguments(args) {
            Ok(args) => backend
                .task_list(args)
                .await
                .map(|v| json_result(&v, false)),
            Err(error) => Err(error),
        },
        "omnia_task_read" => match goal_arguments(args) {
            Ok(args) => backend
                .task_read(args)
                .await
                .map(|v| json_result(&v, false)),
            Err(error) => Err(error),
        },
        "omnia_task_revision_read" => match goal_arguments(args) {
            Ok(args) => backend
                .task_revision_read(args)
                .await
                .map(|v| json_result(&v, false)),
            Err(error) => Err(error),
        },
        "omnia_task_dependency_list" => match goal_arguments(args) {
            Ok(args) => backend
                .task_dependency_list(args)
                .await
                .map(|v| json_result(&v, false)),
            Err(error) => Err(error),
        },
        "omnia_task_create" => match goal_arguments(args) {
            Ok(args) => backend
                .task_create(args)
                .await
                .map(|v| json_result(&v, false)),
            Err(error) => Err(error),
        },
        "omnia_task_revision_create" => match goal_arguments(args) {
            Ok(args) => backend
                .task_revision_create(args)
                .await
                .map(|v| json_result(&v, false)),
            Err(error) => Err(error),
        },
        "omnia_task_status_update" => match goal_arguments(args) {
            Ok(args) => backend
                .task_status_update(args)
                .await
                .map(|v| json_result(&v, false)),
            Err(error) => Err(error),
        },
        "omnia_task_dependency_create" => match goal_arguments(args) {
            Ok(args) => backend
                .task_dependency_create(args)
                .await
                .map(|v| json_result(&v, false)),
            Err(error) => Err(error),
        },
        _ => return Err(()),
    };
    Ok(outcome.unwrap_or_else(|error| text_result(error, true)))
}

// ---------------------------------------------------------------------------
// JSON-RPC (pure apart from the backend calls)
// ---------------------------------------------------------------------------

fn rpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

/// Picks the protocol revision for `initialize`: the client's if we speak
/// it, otherwise our newest (the client then decides whether to continue).
pub fn negotiate_protocol(requested: Option<&str>) -> &'static str {
    requested
        .and_then(|wanted| SUPPORTED_PROTOCOLS.iter().find(|v| **v == wanted))
        .copied()
        .unwrap_or(SUPPORTED_PROTOCOLS[0])
}

pub fn initialize_result(requested: Option<&str>) -> Value {
    json!({
        "protocolVersion": negotiate_protocol(requested),
        "capabilities": {"tools": {"listChanged": false}},
        "serverInfo": {"name": "omnia", "title": "Omnia", "version": env!("CARGO_PKG_VERSION")},
        "instructions": "Drive Omnia agent sessions and manage native planning goals. Goal tools return preview-only planning state; they do not dispatch or steer a provider run. Goal edits require the expected current revision; removals require a revision or timestamp expectation. All goal mutations require a stable idempotency key. Session tool approvals appear in the Omnia desktop UI."
    })
}

/// Handles one JSON-RPC message. `None` = nothing to send back (notification
/// or client response).
pub async fn handle_message(message: &Value, backend: &dyn McpBackend) -> Option<Value> {
    let Some(object) = message.as_object() else {
        return Some(rpc_error(Value::Null, -32600, "Invalid Request"));
    };
    let id = object.get("id").cloned();
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        // A response to a server request (we send none) or garbage.
        return match id {
            Some(_) if object.contains_key("result") || object.contains_key("error") => None,
            Some(id) => Some(rpc_error(id, -32600, "Invalid Request")),
            None => Some(rpc_error(Value::Null, -32600, "Invalid Request")),
        };
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(rpc_error(
            id.unwrap_or(Value::Null),
            -32600,
            "Invalid Request: jsonrpc must be \"2.0\"",
        ));
    }
    let Some(id) = id else {
        return None; // notification (notifications/initialized, cancelled, ...)
    };
    let params = object.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => rpc_result(
            id,
            initialize_result(params.get("protocolVersion").and_then(Value::as_str)),
        ),
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({"tools": tool_definitions()})),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(rpc_error(id, -32602, "Invalid params: `name` is required"));
            };
            let empty = json!({});
            let args = params.get("arguments").unwrap_or(&empty);
            match call_tool(name, args, backend).await {
                Ok(result) => rpc_result(id, result),
                Err(()) => rpc_error(id, -32602, format!("Unknown tool: {name}")),
            }
        }
        other => rpc_error(id, -32601, format!("Method not found: {other}")),
    })
}

/// Handles a request body (single message or batch). `None` = HTTP 202.
pub async fn handle_body(body: &[u8], backend: &dyn McpBackend) -> Option<Value> {
    let parsed: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => return Some(rpc_error(Value::Null, -32700, "Parse error")),
    };
    match parsed {
        Value::Array(items) if items.is_empty() => Some(rpc_error(
            Value::Null,
            -32600,
            "Invalid Request: empty batch",
        )),
        Value::Array(items) => {
            let mut out = Vec::new();
            for item in &items {
                out.extend(handle_message(item, backend).await);
            }
            (!out.is_empty()).then_some(Value::Array(out))
        }
        single => handle_message(&single, backend).await,
    }
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    /// Header names as sent; look up through [`header`] (case-insensitive).
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }
    fn json(status: u16, value: &Value) -> Self {
        Self {
            status,
            headers: vec![("Content-Type", "application/json".to_owned())],
            body: serde_json::to_vec(value).unwrap_or_default(),
        }
    }
    fn plain(status: u16, message: &str) -> Self {
        Self {
            status,
            headers: vec![("Content-Type", "text/plain; charset=utf-8".to_owned())],
            body: message.as_bytes().to_vec(),
        }
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Payload Too Large",
        _ => "Error",
    }
}

/// Full request handling without any socket: auth, routing, JSON-RPC.
pub async fn handle_http(
    request: &HttpRequest,
    token: &str,
    backend: &dyn McpBackend,
) -> HttpResponse {
    if let Err(reject) = authorize(&request.headers, token) {
        let mut response = HttpResponse::plain(reject.status, reject.message);
        if reject.status == 401 {
            response
                .headers
                .push(("WWW-Authenticate", "Bearer".to_owned()));
        }
        return response;
    }
    let path = request.path.split('?').next().unwrap_or("");
    if path != "/mcp" {
        return HttpResponse::plain(404, "Not found");
    }
    if request.method != "POST" {
        // No server-initiated stream and no sessions to terminate.
        let mut response = HttpResponse::plain(405, "Use POST");
        response.headers.push(("Allow", "POST".to_owned()));
        return response;
    }
    match handle_body(&request.body, backend).await {
        Some(reply) => HttpResponse::json(200, &reply),
        None => HttpResponse::empty(202),
    }
}

/// Parses the request line and headers (everything before the blank line).
type Head = (String, String, Vec<(String, String)>);

pub fn parse_head(head: &str) -> Result<Head, u16> {
    let mut lines = head.split("\r\n");
    let request_line = lines.next().ok_or(400u16)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().filter(|m| !m.is_empty()).ok_or(400u16)?;
    let path = parts.next().filter(|p| p.starts_with('/')).ok_or(400u16)?;
    if !parts.next().is_some_and(|v| v.starts_with("HTTP/1.")) || parts.next().is_some() {
        return Err(400);
    }
    let mut headers = Vec::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(400u16)?;
        if name.is_empty() || name.contains(char::is_whitespace) {
            return Err(400);
        }
        headers.push((name.to_owned(), value.trim().to_owned()));
    }
    Ok((method.to_owned(), path.to_owned(), headers))
}

async fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, u16> {
    let mut buffer: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position;
        }
        if buffer.len() > MAX_HEAD_BYTES {
            return Err(400);
        }
        let read = stream.read(&mut chunk).await.map_err(|_| 400u16)?;
        if read == 0 {
            return Err(400);
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = std::str::from_utf8(&buffer[..head_end]).map_err(|_| 400u16)?;
    let (method, path, headers) = parse_head(head)?;
    if header(&headers, "transfer-encoding").is_some() {
        return Err(411);
    }
    let length = match header(&headers, "content-length") {
        Some(value) => value.parse::<usize>().map_err(|_| 400u16)?,
        None => 0,
    };
    if length > MAX_BODY_BYTES {
        return Err(413);
    }
    let mut body = buffer[head_end + 4..].to_vec();
    if body.len() < length
        && header(&headers, "expect").is_some_and(|v| v.eq_ignore_ascii_case("100-continue"))
    {
        let _ = stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await;
    }
    while body.len() < length {
        let read = stream.read(&mut chunk).await.map_err(|_| 400u16)?;
        if read == 0 {
            return Err(400);
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(length);
    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

async fn write_response(stream: &mut TcpStream, response: &HttpResponse) {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\n",
        response.status,
        reason(response.status)
    );
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!(
        "Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        response.body.len()
    ));
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(&response.body).await;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
}

async fn serve_connection(
    mut stream: TcpStream,
    backend: Arc<dyn McpBackend>,
    token: Arc<RwLock<String>>,
) {
    let request = match tokio::time::timeout(READ_TIMEOUT, read_request(&mut stream)).await {
        Ok(Ok(request)) => request,
        Ok(Err(status)) => {
            write_response(&mut stream, &HttpResponse::plain(status, reason(status))).await;
            return;
        }
        Err(_) => return,
    };
    let expected = token.read().map(|guard| guard.clone()).unwrap_or_default();
    let response = handle_http(&request, &expected, backend.as_ref()).await;
    write_response(&mut stream, &response).await;
}

/// A listening server. Dropping it does not stop it; call [`RunningServer::stop`].
pub struct RunningServer {
    pub addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl RunningServer {
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.task.await;
    }
}

/// Binds 127.0.0.1:`port` (0 = random) and serves until stopped.
pub async fn serve(
    backend: Arc<dyn McpBackend>,
    token: Arc<RwLock<String>>,
    port: u16,
) -> std::io::Result<RunningServer> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    let addr = listener.local_addr()?;
    let (shutdown, mut stop) = watch::channel(false);
    let task = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = stop.changed() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    let backend = Arc::clone(&backend);
                    let token = Arc::clone(&token);
                    let mut stop = stop.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::select! {
                            _ = stop.changed() => {}
                            _ = serve_connection(stream, backend, token) => {}
                        }
                    });
                }
            }
        }
    });
    Ok(RunningServer {
        addr,
        shutdown,
        task,
    })
}

// ---------------------------------------------------------------------------
// Transcript helpers (pure)
// ---------------------------------------------------------------------------

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_owned()
    } else {
        format!("{}…", text.chars().take(max).collect::<String>())
    }
}

fn block_text(block: &Block) -> Option<String> {
    Some(match block {
        Block::Text { text } => text.clone(),
        Block::Thinking { .. } => return None,
        Block::Image { media_type, .. } => format!("[image {media_type}]"),
        Block::ToolUse { name, input, .. } => {
            format!("[tool_use {name}] {}", clip(&input.to_string(), 300))
        }
        Block::ToolResult {
            content, is_error, ..
        } => {
            let inner: Vec<String> = content.iter().filter_map(block_text).collect();
            let label = if *is_error {
                "tool_result (error)"
            } else {
                "tool_result"
            };
            format!("[{label}] {}", clip(&inner.join("\n"), 600))
        }
    })
}

/// Plain-text transcript of the last `last_n` messages (all when `None`),
/// capped to the most recent [`MAX_TRANSCRIPT_CHARS`] characters.
pub fn format_transcript(messages: &[Message], last_n: Option<usize>) -> String {
    let skip = last_n.map_or(0, |n| messages.len().saturating_sub(n));
    let mut out = String::new();
    for (index, message) in messages.iter().enumerate().skip(skip) {
        let role = match message.role {
            Role::User => "user",
            Role::Assistant => "assistant",
        };
        let body: Vec<String> = message.content.iter().filter_map(block_text).collect();
        out.push_str(&format!("### #{index} {role}\n{}\n\n", body.join("\n")));
    }
    if out.chars().count() > MAX_TRANSCRIPT_CHARS {
        let tail: String = out
            .chars()
            .rev()
            .take(MAX_TRANSCRIPT_CHARS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        out = format!("[…truncated…]\n{tail}");
    }
    if out.is_empty() {
        "(no messages)".to_owned()
    } else {
        out
    }
}

/// Text blocks of the last assistant message (empty when there is none).
pub fn last_assistant_text(messages: &[Message]) -> String {
    messages
        .iter()
        .rev()
        .find(|message| message.role == Role::Assistant)
        .map(|message| {
            message
                .content
                .iter()
                .filter_map(|block| match block {
                    Block::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Real backend
// ---------------------------------------------------------------------------

pub struct TauriBackend {
    pub app: AppHandle,
}

fn native(error: NativeError) -> String {
    format!("{}: {}", error.code, error.message)
}

fn native_goal_list(storage: &Storage, args: GoalListArgs) -> Result<Value, String> {
    let goals = storage
        .list_goals(ListGoalsRequest {
            project_id: args.project_id,
            conversation_id: args.conversation_id,
            branch_id: args.branch_id,
            status: args.status.map(|status| status.as_str().to_owned()),
            include_archived: args.include_archived,
            limit: args.limit,
        })
        .map_err(native)?;
    Ok(json!({
        "goals": serde_json::to_value(goals).map_err(|error| error.to_string())?,
        "executionDisposition": "preview-only",
        "integrity": "valid"
    }))
}

fn native_goal_read(storage: &Storage, args: GoalReadArgs) -> Result<Value, String> {
    let snapshot = storage
        .read_goal(ReadGoalRequest {
            goal_id: args.goal_id,
        })
        .map_err(native)?;
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

fn native_goal_set(storage: &Storage, args: GoalSetArgs) -> Result<Value, String> {
    let snapshot = storage
        .create_goal(CreateGoalRequest {
            project_id: args.project_id,
            conversation_id: args.conversation_id,
            branch_id: args.branch_id,
            state_revision_id: args.state_revision_id,
            title: args.title,
            description: args.description,
            acceptance_criteria_json: serde_json::to_string(&args.acceptance_criteria)
                .map_err(|error| error.to_string())?,
            roadmap_json: serde_json::to_string(&args.roadmap)
                .map_err(|error| error.to_string())?,
            metadata_json: serde_json::to_string(&args.metadata)
                .map_err(|error| error.to_string())?,
            status: args.status.as_str().to_owned(),
            idempotency_key: args.idempotency_key,
        })
        .map_err(native)?;
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

/// Materialise a patch from its immutable expected base, never from a later
/// current head. This preserves the command's canonical payload when the caller
/// retries after other mutations. The native writer owns atomic CAS, lifecycle
/// checks, scope, receipt replay and payload-drift rejection.
fn native_goal_revision(
    storage: &Storage,
    goal_id: String,
    expected_current_revision_id: String,
    idempotency_key: String,
    patch: impl FnOnce(&mut serde_json::Map<String, Value>),
) -> Result<Value, String> {
    let revision = storage
        .read_goal_revision(ReadGoalRevisionRequest {
            goal_id: goal_id.clone(),
            revision_id: expected_current_revision_id.clone(),
        })
        .map_err(native)?;
    let mut payload: Value = serde_json::from_str(&revision.payload_json)
        .map_err(|_| "goal_integrity_failed: The base Goal revision is malformed".to_owned())?;
    let fields = payload.as_object_mut().ok_or_else(|| {
        "goal_integrity_failed: The base Goal revision must be an object".to_owned()
    })?;
    patch(fields);
    let state_revision_id = fields
        .get("stateRevisionId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let snapshot = storage
        .create_goal_revision(CreateGoalRevisionRequest {
            goal_id,
            expected_current_revision_id: Some(expected_current_revision_id),
            state_revision_id,
            payload_json: serde_json::to_string(&payload).map_err(|error| error.to_string())?,
            idempotency_key,
        })
        .map_err(native)?;
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

fn native_goal_edit(storage: &Storage, args: GoalEditArgs) -> Result<Value, String> {
    native_goal_revision(
        storage,
        args.goal_id,
        args.expected_current_revision_id,
        args.idempotency_key,
        |fields| {
            fields.insert("title".to_owned(), json!(args.title));
            if let Some(description) = args.description {
                fields.insert("description".to_owned(), json!(description));
            }
            if let Some(acceptance_criteria) = args.acceptance_criteria {
                fields.insert("acceptanceCriteria".to_owned(), json!(acceptance_criteria));
            }
            if let Some(roadmap) = args.roadmap {
                fields.insert("roadmap".to_owned(), Value::Object(roadmap));
            }
            if let Some(metadata) = args.metadata {
                fields.insert("metadata".to_owned(), Value::Object(metadata));
            }
            if let Some(status) = args.status {
                fields.insert("status".to_owned(), json!(status));
            }
            if let Some(state_revision_id) = args.state_revision_id {
                fields.insert("stateRevisionId".to_owned(), json!(state_revision_id));
            }
        },
    )
}

fn native_goal_remove(storage: &Storage, args: GoalRemoveArgs) -> Result<Value, String> {
    if let Some(expected_current_revision_id) = args.expected_current_revision_id {
        if expected_current_revision_id.trim().is_empty() {
            return Err("`expectedCurrentRevisionId` must be a non-empty string".to_owned());
        }
        // Prefer the immutable revision guard when callers have it. Timestamp
        // CAS remains available below for compatibility with native lifecycle
        // commands, but a timestamp can tie within one clock tick.
        return native_goal_revision(
            storage,
            args.goal_id,
            expected_current_revision_id,
            args.idempotency_key,
            |fields| {
                fields.insert("status".to_owned(), json!(args.status));
            },
        );
    }
    let Some(expected_updated_at_ms) = args.expected_updated_at_ms else {
        return Err(
            "One of `expectedCurrentRevisionId` or `expectedUpdatedAtMs` is required".to_owned(),
        );
    };
    let snapshot = storage
        .update_goal_status(UpdateGoalStatusRequest {
            goal_id: args.goal_id,
            status: args.status.as_str().to_owned(),
            expected_updated_at_ms: Some(expected_updated_at_ms),
            idempotency_key: args.idempotency_key,
        })
        .map_err(native)?;
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

fn task_snapshot_value<T: Serialize>(snapshot: T) -> Result<Value, String> {
    let mut value = serde_json::to_value(snapshot).map_err(|error| error.to_string())?;
    if let Some(object) = value.as_object_mut() {
        object
            .entry("executionDisposition")
            .or_insert_with(|| json!("preview-only"));
        object.entry("integrity").or_insert_with(|| json!("valid"));
    }
    Ok(value)
}

fn native_task_list(storage: &Storage, args: TaskListArgs) -> Result<Value, String> {
    let tasks = storage
        .list_tasks(ListTasksRequest {
            goal_id: args.goal_id,
            project_id: args.project_id,
            conversation_id: args.conversation_id,
            branch_id: args.branch_id,
            status: args.status,
            include_archived: args.include_archived,
            limit: args.limit,
        })
        .map_err(native)?;
    Ok(json!({
        "tasks": serde_json::to_value(tasks).map_err(|error| error.to_string())?,
        "executionDisposition": "preview-only",
        "integrity": "valid"
    }))
}

fn native_task_read(storage: &Storage, args: TaskReadArgs) -> Result<Value, String> {
    task_snapshot_value(
        storage
            .read_task(ReadTaskRequest {
                task_id: args.task_id,
            })
            .map_err(native)?,
    )
}

fn native_task_revision_read(
    storage: &Storage,
    args: TaskRevisionReadArgs,
) -> Result<Value, String> {
    task_snapshot_value(
        storage
            .read_task_revision(ReadTaskRevisionRequest {
                task_id: args.task_id,
                revision_id: args.revision_id,
            })
            .map_err(native)?,
    )
}

fn native_task_dependency_list(
    storage: &Storage,
    args: TaskDependencyListArgs,
) -> Result<Value, String> {
    let dependencies = storage
        .list_task_dependencies(ListTaskDependenciesRequest {
            task_id: args.task_id,
        })
        .map_err(native)?;
    Ok(json!({
        "dependencies": serde_json::to_value(dependencies).map_err(|error| error.to_string())?,
        "executionDisposition": "preview-only",
        "integrity": "valid"
    }))
}

fn native_task_create(storage: &Storage, args: TaskCreateArgs) -> Result<Value, String> {
    let snapshot = storage
        .create_task(CreateTaskRequest {
            goal_id: args.goal_id,
            project_id: args.project_id,
            conversation_id: args.conversation_id,
            branch_id: args.branch_id,
            state_revision_id: args.state_revision_id,
            title: args.title,
            description: args.description,
            metadata_json: serde_json::to_string(&args.metadata)
                .map_err(|error| error.to_string())?,
            status: args.status,
            idempotency_key: args.idempotency_key,
        })
        .map_err(native)?;
    task_snapshot_value(snapshot)
}

fn native_task_revision_create(
    storage: &Storage,
    args: TaskRevisionCreateArgs,
) -> Result<Value, String> {
    let snapshot = storage
        .create_task_revision(CreateTaskRevisionRequest {
            task_id: args.task_id,
            expected_current_revision_id: args.expected_current_revision_id,
            state_revision_id: args.state_revision_id,
            payload_json: args.payload_json,
            idempotency_key: args.idempotency_key,
        })
        .map_err(native)?;
    task_snapshot_value(snapshot)
}

fn native_task_status_update(
    storage: &Storage,
    args: TaskStatusUpdateArgs,
) -> Result<Value, String> {
    let snapshot = storage
        .update_task_status(UpdateTaskStatusRequest {
            task_id: args.task_id,
            status: args.status,
            expected_updated_at_ms: args.expected_updated_at_ms,
            idempotency_key: args.idempotency_key,
        })
        .map_err(native)?;
    task_snapshot_value(snapshot)
}

fn native_task_dependency_create(
    storage: &Storage,
    args: TaskDependencyCreateArgs,
) -> Result<Value, String> {
    let dependency = storage
        .create_task_dependency(CreateTaskDependencyRequest {
            from_task_id: args.from_task_id,
            to_task_id: args.to_task_id,
            dependency_kind: args.dependency_kind,
        })
        .map_err(native)?;
    task_snapshot_value(dependency)
}

#[async_trait]
impl McpBackend for TauriBackend {
    async fn list_sessions(&self) -> Result<Value, String> {
        let hub = self.app.state::<HarnessHub>();
        let items = harness_bridge::list_sessions(&hub).map_err(native)?;
        Ok(Value::Array(
            items
                .iter()
                .map(|item| {
                    let s = &item.summary;
                    json!({
                        "id": s.id, "title": s.title, "cwd": s.cwd, "model": s.model,
                        "profileId": s.profile_id, "permissionMode": s.permission_mode,
                        "messageCount": s.message_count, "running": item.running,
                        "updatedAtMs": s.updated_at_ms,
                    })
                })
                .collect(),
        ))
    }

    async fn read_session(
        &self,
        session_id: &str,
        last_n: Option<usize>,
    ) -> Result<String, String> {
        let hub = self.app.state::<HarnessHub>();
        let detail = harness_bridge::read_session(
            &hub,
            AgentSessionRef {
                session_id: session_id.to_owned(),
            },
        )
        .map_err(native)?;
        let header = format!(
            "Session {} \"{}\" ({}){}\n\n",
            detail.summary.id,
            detail.summary.title,
            detail.summary.cwd,
            if detail.running { " [running]" } else { "" }
        );
        Ok(header + &format_transcript(&detail.messages, last_n))
    }

    async fn create_session(&self, args: CreateSessionArgs) -> Result<Value, String> {
        let hub = self.app.state::<HarnessHub>();
        let state = self.app.state::<AppState>();
        let profiles = state.storage.list_provider_profiles().map_err(native)?;
        let recent = harness_bridge::list_sessions(&hub).map_err(native)?;
        let profile_id = match args.profile_id {
            Some(id) => {
                let profile = profiles
                    .iter()
                    .find(|p| p.id == id)
                    .ok_or("Unknown profileId; call omnia_list_profiles")?;
                if !profile.enabled {
                    return Err("That provider profile is disabled".to_owned());
                }
                id
            }
            None => recent
                .iter()
                .map(|item| item.summary.profile_id.as_str())
                .find(|id| profiles.iter().any(|p| p.id == *id && p.enabled))
                .map(str::to_owned)
                .or_else(|| profiles.iter().find(|p| p.enabled).map(|p| p.id.clone()))
                .ok_or("No enabled provider profile is configured in Omnia")?,
        };
        let model = match args.model {
            Some(model) => model,
            None => recent
                .iter()
                .find(|item| item.summary.profile_id == profile_id)
                .map(|item| item.summary.model.clone())
                .ok_or(
                    "`model` is required: no earlier session uses this profile to infer one from",
                )?,
        };
        let permission_mode = match args.permission_mode {
            Some(mode) => Some(serde_json::from_value(Value::String(mode)).map_err(|_| {
                "permissionMode must be one of ask_all, ask_writes, auto, full, plan"
            })?),
            None => None,
        };
        let summary = harness_bridge::create_session(
            &hub,
            AgentSessionCreateRequest {
                cwd: args.cwd,
                profile_id,
                model,
                permission_mode,
                reasoning_effort: None,
                title: None,
                fallback_models: Vec::new(),
                token_budget: None,
                system_prompt: None,
            },
        )
        .map_err(native)?;
        serde_json::to_value(&summary).map_err(|e| e.to_string())
    }

    async fn send_message(&self, args: SendArgs) -> Result<Value, String> {
        let hub = self.app.state::<HarnessHub>();
        let state = self.app.state::<AppState>();
        let session_ref = || AgentSessionRef {
            session_id: args.session_id.clone(),
        };
        let before = harness_bridge::read_session(&hub, session_ref())
            .map_err(native)?
            .messages
            .len();
        // Subscribe first so a fast run cannot finish unnoticed.
        let mut finished = hub.subscribe_finished();
        harness_bridge::send_message(
            &self.app,
            &state,
            &hub,
            AgentSendRequest {
                session_id: args.session_id.clone(),
                text: args.text,
                images: Vec::new(),
            },
        )
        .await
        .map_err(native)?;
        if !args.wait {
            return Ok(json!({"status": "started", "sessionId": args.session_id}));
        }
        let deadline = tokio::time::Instant::now() + args.timeout;
        let event = loop {
            match tokio::time::timeout_at(deadline, finished.recv()).await {
                Err(_) => {
                    return Ok(json!({
                        "status": "timeout",
                        "sessionId": args.session_id,
                        "message": "Still running; read the session later or call omnia_interrupt. Pending approvals must be answered in the Omnia desktop UI."
                    }))
                }
                Ok(Ok(done)) if done.session_id == args.session_id => break Some(done.event),
                Ok(Ok(_)) => {}
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {
                    if !hub.run_active(&args.session_id) {
                        break None;
                    }
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break None,
            }
        };
        let messages = harness_bridge::read_session(&hub, session_ref())
            .map_err(native)?
            .messages;
        let text = last_assistant_text(messages.get(before..).unwrap_or(&[]));
        let status = event
            .as_ref()
            .and_then(|e| e.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("finished")
            .to_owned();
        let mut out = json!({"status": status, "sessionId": args.session_id, "text": text});
        if let Some(message) = event
            .as_ref()
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
        {
            out["message"] = json!(message);
        }
        Ok(out)
    }

    async fn interrupt(&self, session_id: &str) -> Result<Value, String> {
        let hub = self.app.state::<HarnessHub>();
        let running = hub.run_active(session_id);
        harness_bridge::interrupt_session(
            &hub,
            AgentSessionRef {
                session_id: session_id.to_owned(),
            },
        )
        .map_err(native)?;
        Ok(json!({"sessionId": session_id, "wasRunning": running}))
    }

    async fn list_profiles(&self) -> Result<Value, String> {
        let state = self.app.state::<AppState>();
        let profiles = state.storage.list_provider_profiles().map_err(native)?;
        Ok(Value::Array(
            profiles
                .iter()
                .map(|p| {
                    json!({
                        "id": p.id, "name": p.display_name,
                        "providerType": p.provider_type, "enabled": p.enabled,
                    })
                })
                .collect(),
        ))
    }

    async fn goal_list(&self, args: GoalListArgs) -> Result<Value, String> {
        let state = self.app.state::<AppState>();
        native_goal_list(&state.storage, args)
    }

    async fn goal_read(&self, args: GoalReadArgs) -> Result<Value, String> {
        let state = self.app.state::<AppState>();
        native_goal_read(&state.storage, args)
    }

    async fn goal_set(&self, args: GoalSetArgs) -> Result<Value, String> {
        let state = self.app.state::<AppState>();
        native_goal_set(&state.storage, args)
    }

    async fn goal_edit(&self, args: GoalEditArgs) -> Result<Value, String> {
        let state = self.app.state::<AppState>();
        native_goal_edit(&state.storage, args)
    }

    async fn goal_remove(&self, args: GoalRemoveArgs) -> Result<Value, String> {
        let state = self.app.state::<AppState>();
        native_goal_remove(&state.storage, args)
    }

    async fn task_list(&self, args: TaskListArgs) -> Result<Value, String> {
        let state = self.app.state::<AppState>();
        native_task_list(&state.storage, args)
    }

    async fn task_read(&self, args: TaskReadArgs) -> Result<Value, String> {
        let state = self.app.state::<AppState>();
        native_task_read(&state.storage, args)
    }

    async fn task_revision_read(&self, args: TaskRevisionReadArgs) -> Result<Value, String> {
        let state = self.app.state::<AppState>();
        native_task_revision_read(&state.storage, args)
    }

    async fn task_dependency_list(&self, args: TaskDependencyListArgs) -> Result<Value, String> {
        let state = self.app.state::<AppState>();
        native_task_dependency_list(&state.storage, args)
    }

    async fn task_create(&self, args: TaskCreateArgs) -> Result<Value, String> {
        let state = self.app.state::<AppState>();
        native_task_create(&state.storage, args)
    }

    async fn task_revision_create(&self, args: TaskRevisionCreateArgs) -> Result<Value, String> {
        let state = self.app.state::<AppState>();
        native_task_revision_create(&state.storage, args)
    }

    async fn task_status_update(&self, args: TaskStatusUpdateArgs) -> Result<Value, String> {
        let state = self.app.state::<AppState>();
        native_task_status_update(&state.storage, args)
    }

    async fn task_dependency_create(
        &self,
        args: TaskDependencyCreateArgs,
    ) -> Result<Value, String> {
        let state = self.app.state::<AppState>();
        native_task_dependency_create(&state.storage, args)
    }
}

// ---------------------------------------------------------------------------
// Settings + lifecycle
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct McpServerSettings {
    pub enabled: bool,
    /// 0 = pick a random port; after the first start the chosen port is kept.
    pub port: u16,
    pub token: String,
}

pub fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| "The system random generator is unavailable".to_owned())?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("omnia_{hex}"))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub enabled: bool,
    pub url: Option<String>,
    pub token: Option<String>,
    pub port: u16,
}

struct Inner {
    settings: McpServerSettings,
    running: Option<RunningServer>,
}

pub struct McpServerManager {
    path: PathBuf,
    token: Arc<RwLock<String>>,
    inner: tokio::sync::Mutex<Inner>,
}

impl McpServerManager {
    /// Settings live in the app data dir (never in the repo or renderer prefs).
    pub fn new(app_data_dir: &std::path::Path) -> Self {
        let path = app_data_dir.join(SETTINGS_FILE);
        let settings: McpServerSettings = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self {
            path,
            token: Arc::new(RwLock::new(settings.token.clone())),
            inner: tokio::sync::Mutex::new(Inner {
                settings,
                running: None,
            }),
        }
    }

    fn save(&self, settings: &McpServerSettings) -> Result<(), String> {
        let tmp = self.path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, text).map_err(|e| format!("Cannot save MCP server settings: {e}"))?;
        std::fs::rename(&tmp, &self.path)
            .map_err(|e| format!("Cannot save MCP server settings: {e}"))
    }

    fn set_live_token(&self, token: &str) {
        if let Ok(mut guard) = self.token.write() {
            *guard = token.to_owned();
        }
    }

    fn info(inner: &Inner) -> McpServerInfo {
        let enabled = inner.running.is_some();
        McpServerInfo {
            enabled,
            url: inner
                .running
                .as_ref()
                .map(|r| format!("http://127.0.0.1:{}/mcp", r.addr.port())),
            token: enabled.then(|| inner.settings.token.clone()),
            port: inner.settings.port,
        }
    }

    pub async fn status(&self) -> McpServerInfo {
        Self::info(&*self.inner.lock().await)
    }

    /// Called at app launch: starts the server when it was left enabled.
    pub async fn start_if_enabled(&self, backend: Arc<dyn McpBackend>) -> Result<(), String> {
        let enabled = self.inner.lock().await.settings.enabled;
        if enabled {
            self.set(backend, true, None).await?;
        }
        Ok(())
    }

    pub async fn set(
        &self,
        backend: Arc<dyn McpBackend>,
        enabled: bool,
        port: Option<u16>,
    ) -> Result<McpServerInfo, String> {
        let mut inner = self.inner.lock().await;
        let explicit_port = port.filter(|p| *p != inner.settings.port);
        if !enabled {
            if let Some(server) = inner.running.take() {
                server.stop().await;
            }
            inner.settings.enabled = false;
            inner.settings.token.clear();
            if let Some(port) = port {
                inner.settings.port = port;
            }
            self.set_live_token("");
            self.save(&inner.settings)?;
            return Ok(Self::info(&inner));
        }
        if inner.running.is_some() && explicit_port.is_none() {
            return Ok(Self::info(&inner));
        }
        let mut previous_token = None;
        if let Some(server) = inner.running.take() {
            // Port change while running: keep the token, rebind.
            previous_token = Some(inner.settings.token.clone());
            server.stop().await;
        }
        let token = match previous_token {
            Some(token) if !token.is_empty() => token,
            _ => generate_token()?,
        };
        let wanted = port.unwrap_or(inner.settings.port);
        self.set_live_token(&token);
        let bound = match serve(Arc::clone(&backend), Arc::clone(&self.token), wanted).await {
            Ok(server) => server,
            // A remembered port that is now taken falls back to a random one;
            // a port the caller asked for explicitly is an error.
            Err(_) if wanted != 0 && port.is_none() => serve(backend, Arc::clone(&self.token), 0)
                .await
                .map_err(|e| format!("Cannot start the MCP server: {e}"))?,
            Err(error) => {
                self.set_live_token("");
                inner.settings.enabled = false;
                inner.settings.token.clear();
                let _ = self.save(&inner.settings);
                return Err(format!("Cannot listen on 127.0.0.1:{wanted}: {error}"));
            }
        };
        inner.settings.enabled = true;
        inner.settings.token = token;
        inner.settings.port = bound.addr.port();
        inner.running = Some(bound);
        self.save(&inner.settings)?;
        Ok(Self::info(&inner))
    }

    pub async fn rotate_token(&self) -> Result<McpServerInfo, String> {
        let mut inner = self.inner.lock().await;
        if inner.running.is_none() {
            return Err("The MCP server is not enabled".to_owned());
        }
        let token = generate_token()?;
        inner.settings.token = token.clone();
        self.save(&inner.settings)?;
        self.set_live_token(&token);
        Ok(Self::info(&inner))
    }
}

fn command_error(message: String) -> NativeError {
    NativeError::new("mcp_server_failed", message)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSetRequest {
    pub enabled: bool,
    #[serde(default)]
    pub port: Option<u16>,
}

#[tauri::command]
pub async fn agent_mcp_server_status(
    manager: State<'_, McpServerManager>,
) -> NativeResult<McpServerInfo> {
    Ok(manager.status().await)
}

#[tauri::command]
pub async fn agent_mcp_server_set(
    app: AppHandle,
    manager: State<'_, McpServerManager>,
    request: McpServerSetRequest,
) -> NativeResult<McpServerInfo> {
    manager
        .set(
            Arc::new(TauriBackend { app }),
            request.enabled,
            request.port,
        )
        .await
        .map_err(command_error)
}

#[tauri::command]
pub async fn agent_mcp_server_rotate_token(
    manager: State<'_, McpServerManager>,
) -> NativeResult<McpServerInfo> {
    manager.rotate_token().await.map_err(command_error)
}

/// Launch hook: start the server in the background when it was left enabled.
pub fn start_on_launch(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let manager = app.state::<McpServerManager>();
        if let Err(error) = manager
            .start_if_enabled(Arc::new(TauriBackend { app: app.clone() }))
            .await
        {
            eprintln!("Omnia MCP server did not start: {error}");
        }
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeBackend {
        calls: std::sync::Mutex<Vec<String>>,
        goal_storage: std::sync::OnceLock<Storage>,
    }

    impl FakeBackend {
        /// Only session/provider behavior is fake. Goal adapters below exercise
        /// the same helpers as Tauri against a fully migrated native SQLite DB.
        fn goals(&self) -> &Storage {
            self.goal_storage.get_or_init(|| {
                Storage::in_memory().expect("native goal storage should initialize")
            })
        }

        fn with_goal_database(path: &std::path::Path) -> Self {
            Self {
                calls: Default::default(),
                goal_storage: std::sync::OnceLock::from(
                    Storage::open(path.to_path_buf()).expect("native goal database should open"),
                ),
            }
        }
    }

    struct TempGoalDatabase(PathBuf);

    impl TempGoalDatabase {
        fn new() -> Self {
            Self(
                std::env::temp_dir()
                    .join(format!("omnia-mcp-goal-{}.sqlite3", uuid::Uuid::new_v4())),
            )
        }
    }

    impl Drop for TempGoalDatabase {
        fn drop(&mut self) {
            // Delete only the three exact SQLite files created by this fixture.
            // No directory traversal or recursive cleanup is needed.
            for suffix in ["", "-wal", "-shm"] {
                let mut file = self.0.as_os_str().to_os_string();
                file.push(suffix);
                if let Err(error) = std::fs::remove_file(PathBuf::from(file)) {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        if std::thread::panicking() {
                            eprintln!("Goal fixture cleanup failed: {error}");
                        } else {
                            panic!("Goal fixture cleanup failed: {error}");
                        }
                    }
                }
            }
        }
    }

    async fn goal_call(backend: &FakeBackend, name: &str, arguments: Value) -> Value {
        let reply = handle_message(
            &json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": name, "arguments": arguments}
            }),
            backend,
        )
        .await
        .expect("a goal tool call must return a response");
        assert!(reply.get("error").is_none(), "{reply}");
        reply["result"].clone()
    }

    async fn task_call(backend: &FakeBackend, name: &str, arguments: Value) -> Value {
        let reply = handle_message(
            &json!({
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {"name": name, "arguments": arguments}
            }),
            backend,
        )
        .await
        .expect("a task tool call must return a response");
        assert!(reply.get("error").is_none(), "{reply}");
        reply["result"].clone()
    }

    fn goal_success(result: Value) -> Value {
        assert_eq!(result["isError"], false, "{result}");
        serde_json::from_str(
            result["content"][0]["text"]
                .as_str()
                .expect("goal result must contain JSON text"),
        )
        .expect("goal result must be valid JSON")
    }

    fn goal_failure(result: Value, code: &str) {
        assert_eq!(result["isError"], true, "{result}");
        assert!(
            result["content"][0]["text"]
                .as_str()
                .expect("goal error must contain text")
                .contains(code),
            "expected {code}: {result}"
        );
    }

    #[tokio::test]
    async fn task_tools_round_trip_native_planning_state() {
        let backend = FakeBackend::default();
        let goal = goal_success(
            goal_call(
                &backend,
                "omnia_goal_set",
                json!({"title": "Task parent", "idempotencyKey": "goal-task-parent"}),
            )
            .await,
        );
        let goal_id = goal["goal"]["id"].as_str().unwrap().to_owned();

        let created = task_call(
            &backend,
            "omnia_task_create",
            json!({
                "goalId": goal_id,
                "title": "First task",
                "metadata": {"source": "mcp-test"},
                "idempotencyKey": "task-create-1"
            }),
        )
        .await;
        let created = goal_success(created);
        assert_eq!(created["executionDisposition"], "preview-only");
        assert_eq!(created["task"]["title"], "First task");
        let task_id = created["task"]["id"].as_str().unwrap().to_owned();
        let revision_id = created["task"]["currentRevisionId"]
            .as_str()
            .unwrap()
            .to_owned();

        let read =
            goal_success(task_call(&backend, "omnia_task_read", json!({"taskId": task_id})).await);
        assert_eq!(read["task"]["id"], task_id);
        assert_eq!(read["currentRevision"]["revisionId"], revision_id);
        assert_eq!(read["executionDisposition"], "preview-only");

        let listed = goal_success(
            task_call(
                &backend,
                "omnia_task_list",
                json!({"goalId": goal["goal"]["id"]}),
            )
            .await,
        );
        assert_eq!(listed["tasks"].as_array().unwrap().len(), 1);

        let revised = goal_success(
            task_call(
                &backend,
                "omnia_task_revision_create",
                json!({
                    "taskId": task_id,
                    "expectedCurrentRevisionId": revision_id,
                    "payloadJson": serde_json::to_string(&json!({
                        "schemaVersion": 1,
                        "title": "First task edited",
                        "description": null,
                        "metadata": {"source": "mcp-test", "edited": true},
                        "status": "pending",
                        "stateRevisionId": null
                    })).unwrap(),
                    "idempotencyKey": "task-revision-1"
                }),
            )
            .await,
        );
        assert_eq!(revised["task"]["title"], "First task edited");

        let status = goal_success(
            task_call(
                &backend,
                "omnia_task_status_update",
                json!({
                    "taskId": task_id,
                    "status": "ready",
                    "idempotencyKey": "task-status-1"
                }),
            )
            .await,
        );
        assert_eq!(status["task"]["status"], "ready");

        let second = goal_success(
            task_call(
                &backend,
                "omnia_task_create",
                json!({
                    "goalId": goal["goal"]["id"],
                    "title": "Second task",
                    "idempotencyKey": "task-create-2"
                }),
            )
            .await,
        );
        let second_id = second["task"]["id"].as_str().unwrap();
        let dependency = goal_success(
            task_call(
                &backend,
                "omnia_task_dependency_create",
                json!({
                    "fromTaskId": task_id,
                    "toTaskId": second_id,
                    "dependencyKind": "blocks"
                }),
            )
            .await,
        );
        assert_eq!(dependency["executionDisposition"], "preview-only");
        let dependencies = goal_success(
            task_call(
                &backend,
                "omnia_task_dependency_list",
                json!({"taskId": task_id}),
            )
            .await,
        );
        assert_eq!(dependencies["dependencies"].as_array().unwrap().len(), 1);
        let historical = goal_success(
            task_call(
                &backend,
                "omnia_task_revision_read",
                json!({"taskId": task_id, "revisionId": revision_id}),
            )
            .await,
        );
        assert_eq!(historical["revisionId"], revision_id);
        assert_eq!(historical["executionDisposition"], "preview-only");
    }

    #[async_trait]
    impl McpBackend for FakeBackend {
        async fn list_sessions(&self) -> Result<Value, String> {
            Ok(json!([{"id": "s1", "title": "T"}]))
        }
        async fn read_session(&self, id: &str, last_n: Option<usize>) -> Result<String, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("read {id} {last_n:?}"));
            Ok(format!("transcript of {id}"))
        }
        async fn create_session(&self, args: CreateSessionArgs) -> Result<Value, String> {
            if args.cwd == "bad" {
                return Err("cwd: must be an existing absolute folder".to_owned());
            }
            Ok(json!({"id": "new", "cwd": args.cwd, "model": args.model}))
        }
        async fn send_message(&self, args: SendArgs) -> Result<Value, String> {
            self.calls.lock().unwrap().push(format!(
                "send {} wait={} t={}",
                args.session_id,
                args.wait,
                args.timeout.as_secs()
            ));
            Ok(json!({"status": "completed", "text": format!("echo: {}", args.text)}))
        }
        async fn interrupt(&self, id: &str) -> Result<Value, String> {
            Ok(json!({"sessionId": id, "wasRunning": true}))
        }
        async fn list_profiles(&self) -> Result<Value, String> {
            Ok(json!([{"id": "p1", "name": "Anthropic", "enabled": true}]))
        }
        async fn goal_list(&self, args: GoalListArgs) -> Result<Value, String> {
            native_goal_list(self.goals(), args)
        }
        async fn goal_read(&self, args: GoalReadArgs) -> Result<Value, String> {
            native_goal_read(self.goals(), args)
        }
        async fn goal_set(&self, args: GoalSetArgs) -> Result<Value, String> {
            native_goal_set(self.goals(), args)
        }
        async fn goal_edit(&self, args: GoalEditArgs) -> Result<Value, String> {
            native_goal_edit(self.goals(), args)
        }
        async fn goal_remove(&self, args: GoalRemoveArgs) -> Result<Value, String> {
            native_goal_remove(self.goals(), args)
        }
        async fn task_list(&self, args: TaskListArgs) -> Result<Value, String> {
            native_task_list(self.goals(), args)
        }
        async fn task_read(&self, args: TaskReadArgs) -> Result<Value, String> {
            native_task_read(self.goals(), args)
        }
        async fn task_revision_read(&self, args: TaskRevisionReadArgs) -> Result<Value, String> {
            native_task_revision_read(self.goals(), args)
        }
        async fn task_dependency_list(
            &self,
            args: TaskDependencyListArgs,
        ) -> Result<Value, String> {
            native_task_dependency_list(self.goals(), args)
        }
        async fn task_create(&self, args: TaskCreateArgs) -> Result<Value, String> {
            native_task_create(self.goals(), args)
        }
        async fn task_revision_create(
            &self,
            args: TaskRevisionCreateArgs,
        ) -> Result<Value, String> {
            native_task_revision_create(self.goals(), args)
        }
        async fn task_status_update(&self, args: TaskStatusUpdateArgs) -> Result<Value, String> {
            native_task_status_update(self.goals(), args)
        }
        async fn task_dependency_create(
            &self,
            args: TaskDependencyCreateArgs,
        ) -> Result<Value, String> {
            native_task_dependency_create(self.goals(), args)
        }
    }

    fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    const TOKEN: &str = "omnia_testtoken";

    fn good_headers() -> Vec<(String, String)> {
        headers(&[
            ("Host", "127.0.0.1:5000"),
            ("Authorization", "Bearer omnia_testtoken"),
        ])
    }

    #[test]
    fn authorize_accepts_good_requests() {
        assert_eq!(authorize(&good_headers(), TOKEN), Ok(()));
        let mut with_origin = good_headers();
        with_origin.push(("origin".into(), "http://localhost:3000".into()));
        assert_eq!(authorize(&with_origin, TOKEN), Ok(()));
        let ipv6 = headers(&[
            ("host", "[::1]:80"),
            ("authorization", "bearer omnia_testtoken"),
        ]);
        assert_eq!(authorize(&ipv6, TOKEN), Ok(()));
    }

    #[test]
    fn authorize_rejects_missing_or_wrong_token_with_401() {
        let none = headers(&[("Host", "localhost")]);
        assert_eq!(authorize(&none, TOKEN).unwrap_err().status, 401);
        let wrong = headers(&[("Host", "localhost"), ("Authorization", "Bearer nope")]);
        assert_eq!(authorize(&wrong, TOKEN).unwrap_err().status, 401);
        let scheme = headers(&[
            ("Host", "localhost"),
            ("Authorization", "Basic omnia_testtoken"),
        ]);
        assert_eq!(authorize(&scheme, TOKEN).unwrap_err().status, 401);
        // A server with no token configured must never authorize anything.
        let empty = headers(&[("Host", "localhost"), ("Authorization", "Bearer ")]);
        assert_eq!(authorize(&empty, "").unwrap_err().status, 401);
    }

    #[test]
    fn authorize_rejects_foreign_origin_and_host_with_403() {
        for origin in [
            "https://evil.example",
            "null",
            "http://localhost.evil.com",
            "http://user@evil.com",
            "file://",
        ] {
            let mut h = good_headers();
            h.push(("Origin".into(), origin.into()));
            assert_eq!(authorize(&h, TOKEN).unwrap_err().status, 403, "{origin}");
        }
        let rebinding = headers(&[
            ("Host", "evil.example:80"),
            ("Authorization", "Bearer omnia_testtoken"),
        ]);
        assert_eq!(authorize(&rebinding, TOKEN).unwrap_err().status, 403);
        let missing_host = headers(&[("Authorization", "Bearer omnia_testtoken")]);
        assert_eq!(authorize(&missing_host, TOKEN).unwrap_err().status, 403);
    }

    #[test]
    fn constant_time_eq_matches_equality() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
    }

    async fn rpc(method: &str, params: Value) -> Value {
        let backend = FakeBackend::default();
        handle_message(
            &json!({"jsonrpc": "2.0", "id": 7, "method": method, "params": params}),
            &backend,
        )
        .await
        .expect("response")
    }

    #[tokio::test]
    async fn initialize_negotiates_the_protocol_version() {
        let reply = rpc("initialize", json!({"protocolVersion": "2025-03-26"})).await;
        assert_eq!(reply["id"], 7);
        assert_eq!(reply["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(reply["result"]["serverInfo"]["name"], "omnia");
        assert!(reply["result"]["capabilities"]["tools"].is_object());
        let unknown = rpc("initialize", json!({"protocolVersion": "2099-01-01"})).await;
        assert_eq!(unknown["result"]["protocolVersion"], PROTOCOL_VERSION);
        let none = rpc("initialize", json!({})).await;
        assert_eq!(none["result"]["protocolVersion"], PROTOCOL_VERSION);
    }

    #[tokio::test]
    async fn tools_list_names_every_tool_with_a_schema() {
        let reply = rpc("tools/list", Value::Null).await;
        let tools = reply["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            [
                "omnia_list_sessions",
                "omnia_read_session",
                "omnia_create_session",
                "omnia_send_message",
                "omnia_interrupt",
                "omnia_list_profiles",
                "omnia_goal_list",
                "omnia_goal_read",
                "omnia_goal_set",
                "omnia_goal_edit",
                "omnia_goal_remove",
                "omnia_task_list",
                "omnia_task_read",
                "omnia_task_revision_read",
                "omnia_task_dependency_list",
                "omnia_task_create",
                "omnia_task_revision_create",
                "omnia_task_status_update",
                "omnia_task_dependency_create"
            ]
        );
        assert!(tools.iter().all(|t| t["inputSchema"]["type"] == "object"));
    }

    #[test]
    fn goal_tool_definitions_are_the_canonical_mcp_schemas() {
        let definitions = goal_tool_definitions();
        let tools = definitions
            .as_array()
            .expect("goal definitions must be an array");
        assert_eq!(tools.len(), 5);
        let names: Vec<&str> = tools
            .iter()
            .map(|tool| tool["name"].as_str().expect("tool needs a name"))
            .collect();
        assert_eq!(
            names,
            [
                "omnia_goal_list",
                "omnia_goal_read",
                "omnia_goal_set",
                "omnia_goal_edit",
                "omnia_goal_remove"
            ]
        );
        assert!(tools
            .iter()
            .all(|tool| tool["inputSchema"]["additionalProperties"] == false));
        assert_eq!(
            tools
                .iter()
                .find(|tool| tool["name"] == "omnia_goal_remove")
                .unwrap()["inputSchema"]["properties"]["expectedUpdatedAtMs"]["type"],
            "integer"
        );
    }

    #[test]
    fn task_tool_definitions_are_the_canonical_mcp_schemas() {
        let definitions = task_tool_definitions();
        let tools = definitions
            .as_array()
            .expect("task definitions must be an array");
        assert_eq!(tools.len(), 8);
        let names: Vec<&str> = tools
            .iter()
            .map(|tool| tool["name"].as_str().expect("tool needs a name"))
            .collect();
        assert_eq!(
            names,
            [
                "omnia_task_list",
                "omnia_task_read",
                "omnia_task_revision_read",
                "omnia_task_dependency_list",
                "omnia_task_create",
                "omnia_task_revision_create",
                "omnia_task_status_update",
                "omnia_task_dependency_create"
            ]
        );
        assert!(tools
            .iter()
            .all(|tool| tool["inputSchema"]["additionalProperties"] == false));
        assert!(tools.iter().all(|tool| tool["description"]
            .as_str()
            .is_some_and(|description| !description.trim().is_empty())));
    }

    #[tokio::test]
    async fn ping_unknown_method_and_notifications() {
        assert_eq!(rpc("ping", Value::Null).await["result"], json!({}));
        let unknown = rpc("resources/list", Value::Null).await;
        assert_eq!(unknown["error"]["code"], -32601);
        let backend = FakeBackend::default();
        let note = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        assert!(handle_message(&note, &backend).await.is_none());
        let bad = handle_message(&json!([1]), &backend).await.unwrap();
        assert_eq!(bad["error"]["code"], -32600);
        let wrong_version = handle_message(
            &json!({"jsonrpc": "1.0", "id": 1, "method": "ping"}),
            &backend,
        )
        .await
        .unwrap();
        assert_eq!(wrong_version["error"]["code"], -32600);
    }

    #[tokio::test]
    async fn tools_call_dispatches_and_reports_tool_errors_in_band() {
        let ok = rpc(
            "tools/call",
            json!({"name": "omnia_read_session", "arguments": {"sessionId": "s1", "lastN": 3}}),
        )
        .await;
        assert_eq!(ok["result"]["isError"], false);
        assert_eq!(ok["result"]["content"][0]["text"], "transcript of s1");

        let send = rpc("tools/call", json!({"name": "omnia_send_message", "arguments": {"sessionId": "s1", "text": "hi", "timeoutSeconds": 9999}})).await;
        let text = send["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("echo: hi"), "{text}");

        let missing = rpc(
            "tools/call",
            json!({"name": "omnia_read_session", "arguments": {}}),
        )
        .await;
        assert_eq!(missing["result"]["isError"], true);

        let failed = rpc(
            "tools/call",
            json!({"name": "omnia_create_session", "arguments": {"cwd": "bad"}}),
        )
        .await;
        assert_eq!(failed["result"]["isError"], true);

        let unknown = rpc("tools/call", json!({"name": "nope"})).await;
        assert_eq!(unknown["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn goal_set_returns_a_native_planning_snapshot() {
        let reply = rpc(
            "tools/call",
            json!({
                "name": "omnia_goal_set",
                "arguments": {"title": "Verify native goal planning", "idempotencyKey": "mcp-set"}
            }),
        )
        .await;
        assert!(reply.get("error").is_none(), "{reply}");
        assert_eq!(reply["result"]["isError"], false, "{reply}");
        let snapshot: Value =
            serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(snapshot["goal"]["title"], "Verify native goal planning");
        assert_eq!(snapshot["goal"]["status"], "draft");
        assert_eq!(snapshot["executionDisposition"], "preview-only");
        assert_eq!(snapshot["integrity"], "valid");
        assert_eq!(snapshot["replayed"], false);
    }

    #[tokio::test]
    async fn goal_planning_rejects_malformed_intent_in_band() {
        for (name, arguments) in [
            ("omnia_goal_list", json!([])),
            ("omnia_goal_list", Value::Null),
            ("omnia_goal_list", json!({"unexpected": true})),
            ("omnia_goal_list", json!({"limit": "64"})),
            ("omnia_goal_read", json!({"goalId": " "})),
            (
                "omnia_goal_read",
                json!({"goalId": "goal_a", "steer": true}),
            ),
            (
                "omnia_goal_set",
                json!({"title": "T", "idempotencyKey": "k", "acceptanceCriteria": {}}),
            ),
            (
                "omnia_goal_set",
                json!({"title": "T", "idempotencyKey": "k", "metadata": []}),
            ),
            (
                "omnia_goal_set",
                json!({"title": "T", "idempotencyKey": "k", "status": "running"}),
            ),
            (
                "omnia_goal_edit",
                json!({"goalId": "goal_a", "title": "T", "idempotencyKey": "k"}),
            ),
            (
                "omnia_goal_edit",
                json!({
                    "goalId": "goal_a", "expectedCurrentRevisionId": "goal_revision_a",
                    "title": "T", "metadata": null, "idempotencyKey": "k"
                }),
            ),
            (
                "omnia_goal_remove",
                json!({"goalId": "goal_a", "status": "archived", "idempotencyKey": "k"}),
            ),
            (
                "omnia_goal_remove",
                json!({
                    "goalId": "goal_a",
                    "status": "completed",
                    "idempotencyKey": "k"
                }),
            ),
            ("omnia_task_list", json!([])),
            ("omnia_task_list", Value::Null),
            ("omnia_task_list", json!({"limit": "64"})),
            ("omnia_task_read", json!({"taskId": " "})),
            (
                "omnia_task_read",
                json!({"taskId": "task_a", "steer": true}),
            ),
            (
                "omnia_task_create",
                json!({
                    "goalId": "goal_a", "title": "T", "idempotencyKey": "k",
                    "metadata": []
                }),
            ),
            (
                "omnia_task_create",
                json!({
                    "goalId": "goal_a", "title": "T", "idempotencyKey": "k",
                    "status": null
                }),
            ),
            (
                "omnia_task_revision_create",
                json!({
                    "taskId": "task_a", "payloadJson": "{}", "idempotencyKey": "k",
                    "expectedCurrentRevisionId": 42
                }),
            ),
            (
                "omnia_task_status_update",
                json!({
                    "taskId": "task_a", "status": " ", "idempotencyKey": "k"
                }),
            ),
            (
                "omnia_task_dependency_create",
                json!({
                    "fromTaskId": "task_a", "toTaskId": "task_b"
                }),
            ),
        ] {
            let reply = rpc("tools/call", json!({"name": name, "arguments": arguments})).await;
            assert!(reply.get("error").is_none(), "{name}: {reply}");
            assert_eq!(reply["result"]["isError"], true, "{name}: {reply}");
        }
    }

    #[tokio::test]
    async fn goal_edit_uses_revision_cas_and_replays_idempotently() {
        let backend = FakeBackend::default();
        let created = handle_message(
            &json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "omnia_goal_set", "arguments": {
                    "title": "Original title",
                    "description": "Keep this description",
                    "acceptanceCriteria": [{"id": "one", "text": "one"}],
                    "roadmap": {"step": 1},
                    "metadata": {"owner": "mcp"},
                    "idempotencyKey": "mcp-edit-create"
                }}
            }),
            &backend,
        )
        .await
        .unwrap();
        let snapshot: Value =
            serde_json::from_str(created["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        let goal_id = snapshot["goal"]["id"].as_str().unwrap().to_owned();
        let revision_id = snapshot["currentRevision"]["revisionId"]
            .as_str()
            .unwrap()
            .to_owned();

        let edit = |id: u64, key: &str, title: &str, expected: &str| {
            json!({
                "jsonrpc": "2.0", "id": id, "method": "tools/call",
                "params": {"name": "omnia_goal_edit", "arguments": {
                    "goalId": goal_id,
                    "expectedCurrentRevisionId": expected,
                    "title": title,
                    "idempotencyKey": key
                }}
            })
        };
        let edited = handle_message(
            &edit(2, "mcp-edit-1", "Edited title", &revision_id),
            &backend,
        )
        .await
        .unwrap();
        assert_eq!(edited["result"]["isError"], false, "{edited}");
        let edited_snapshot: Value =
            serde_json::from_str(edited["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(edited_snapshot["goal"]["title"], "Edited title");
        assert_eq!(
            edited_snapshot["goal"]["description"],
            "Keep this description"
        );
        assert!(
            edited_snapshot["currentRevision"]["revisionId"]
                .as_str()
                .unwrap()
                != revision_id
        );
        assert_eq!(edited_snapshot["replayed"], false);

        let replay = handle_message(
            &edit(3, "mcp-edit-1", "Edited title", &revision_id),
            &backend,
        )
        .await
        .unwrap();
        assert_eq!(replay["result"]["isError"], false, "{replay}");
        let replay_snapshot: Value =
            serde_json::from_str(replay["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(replay_snapshot["replayed"], true);
        assert_eq!(
            replay_snapshot["currentRevision"]["revisionId"],
            edited_snapshot["currentRevision"]["revisionId"]
        );

        let stale = handle_message(
            &edit(4, "mcp-edit-stale", "Rejected stale title", &revision_id),
            &backend,
        )
        .await
        .unwrap();
        assert_eq!(stale["result"]["isError"], true, "{stale}");
        assert!(stale["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("stale_revision_head"));
    }

    #[tokio::test]
    async fn goal_remove_archives_or_cancels_without_deleting_history() {
        let backend = FakeBackend::default();
        let create = |id: u64, key: &str| {
            json!({
                "jsonrpc": "2.0", "id": id, "method": "tools/call",
                "params": {"name": "omnia_goal_set", "arguments": {
                    "title": "Removable goal",
                    "idempotencyKey": key
                }}
            })
        };
        let created = handle_message(&create(1, "mcp-remove-create"), &backend)
            .await
            .unwrap();
        let snapshot: Value =
            serde_json::from_str(created["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        let goal_id = snapshot["goal"]["id"].as_str().unwrap().to_owned();
        let revision_id = snapshot["currentRevision"]["revisionId"]
            .as_str()
            .unwrap()
            .to_owned();
        let removed = handle_message(
            &json!({
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {"name": "omnia_goal_remove", "arguments": {
                    "goalId": goal_id,
                    "expectedCurrentRevisionId": revision_id,
                    "status": "archived",
                    "idempotencyKey": "mcp-remove-archive"
                }}
            }),
            &backend,
        )
        .await
        .unwrap();
        assert_eq!(removed["result"]["isError"], false, "{removed}");
        let removed_snapshot: Value =
            serde_json::from_str(removed["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(removed_snapshot["goal"]["status"], "archived");
        assert_eq!(removed_snapshot["executionDisposition"], "preview-only");

        let list_default = handle_message(
            &json!({
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": {"name": "omnia_goal_list", "arguments": {}}
            }),
            &backend,
        )
        .await
        .unwrap();
        let default_items: Value = serde_json::from_str(
            list_default["result"]["content"][0]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(default_items["executionDisposition"], "preview-only");
        assert_eq!(default_items["goals"].as_array().unwrap().len(), 0);

        let list_archived = handle_message(
            &json!({
                "jsonrpc": "2.0", "id": 4, "method": "tools/call",
                "params": {"name": "omnia_goal_list", "arguments": {"includeArchived": true}}
            }),
            &backend,
        )
        .await
        .unwrap();
        let archived_items: Value = serde_json::from_str(
            list_archived["result"]["content"][0]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(archived_items["executionDisposition"], "preview-only");
        assert_eq!(archived_items["goals"].as_array().unwrap().len(), 1);
        assert_eq!(archived_items["goals"][0]["status"], "archived");

        let cancelled_created = handle_message(&create(5, "mcp-remove-cancel-create"), &backend)
            .await
            .unwrap();
        let cancelled_snapshot: Value = serde_json::from_str(
            cancelled_created["result"]["content"][0]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let cancelled_goal_id = cancelled_snapshot["goal"]["id"].as_str().unwrap();
        let cancelled_revision_id = cancelled_snapshot["currentRevision"]["revisionId"]
            .as_str()
            .unwrap();
        let cancelled = handle_message(
            &json!({
                "jsonrpc": "2.0", "id": 6, "method": "tools/call",
                "params": {"name": "omnia_goal_remove", "arguments": {
                    "goalId": cancelled_goal_id,
                    "expectedCurrentRevisionId": cancelled_revision_id,
                    "status": "cancelled",
                    "idempotencyKey": "mcp-remove-cancel"
                }}
            }),
            &backend,
        )
        .await
        .unwrap();
        assert_eq!(cancelled["result"]["isError"], false, "{cancelled}");
        let cancelled_out: Value =
            serde_json::from_str(cancelled["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(cancelled_out["goal"]["status"], "cancelled");

        let timestamp_created = handle_message(&create(7, "mcp-remove-timestamp-create"), &backend)
            .await
            .unwrap();
        let timestamp_snapshot: Value = serde_json::from_str(
            timestamp_created["result"]["content"][0]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let timestamp_goal_id = timestamp_snapshot["goal"]["id"].as_str().unwrap();
        let timestamp = timestamp_snapshot["goal"]["updatedAtMs"].as_i64().unwrap();
        let timestamp_removed = handle_message(
            &json!({
                "jsonrpc": "2.0", "id": 8, "method": "tools/call",
                "params": {"name": "omnia_goal_remove", "arguments": {
                    "goalId": timestamp_goal_id,
                    "expectedUpdatedAtMs": timestamp,
                    "status": "archived",
                    "idempotencyKey": "mcp-remove-timestamp"
                }}
            }),
            &backend,
        )
        .await
        .unwrap();
        assert_eq!(
            timestamp_removed["result"]["isError"], false,
            "{timestamp_removed}"
        );
        let timestamp_out: Value = serde_json::from_str(
            timestamp_removed["result"]["content"][0]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(timestamp_out["goal"]["status"], "archived");
    }

    #[tokio::test]
    async fn goal_file_reopen_preserves_current_head_and_historical_idempotency() {
        let database = TempGoalDatabase::new();
        let backend = FakeBackend::with_goal_database(&database.0);
        let set_args = json!({
            "title": "Persisted goal",
            "description": "Original description",
            "acceptanceCriteria": [{"id": "one", "text": "Retain native history"}],
            "roadmap": {"phase": "original"},
            "metadata": {"phase": "original"},
            "idempotencyKey": "persistent-set"
        });
        let created = goal_success(goal_call(&backend, "omnia_goal_set", set_args.clone()).await);
        let goal_id = created["goal"]["id"].as_str().unwrap().to_owned();
        let initial_revision = created["currentRevision"]["revisionId"]
            .as_str()
            .unwrap()
            .to_owned();
        let first_args = json!({
            "goalId": goal_id,
            "expectedCurrentRevisionId": initial_revision,
            "title": "First revision",
            "description": "First description",
            "metadata": {"phase": "first"},
            "idempotencyKey": "persistent-edit-first"
        });
        let first = goal_success(goal_call(&backend, "omnia_goal_edit", first_args.clone()).await);
        let second_args = json!({
            "goalId": goal_id,
            "expectedCurrentRevisionId": first["currentRevision"]["revisionId"],
            "title": "Second revision",
            "description": "Second description",
            "metadata": {"phase": "second"},
            "idempotencyKey": "persistent-edit-second"
        });
        let second = goal_success(goal_call(&backend, "omnia_goal_edit", second_args).await);
        assert_eq!(second["currentRevision"]["revisionNo"], 3);
        drop(backend);

        let reopened = FakeBackend::with_goal_database(&database.0);
        let read_args = json!({"goalId": goal_id});
        let persisted =
            goal_success(goal_call(&reopened, "omnia_goal_read", read_args.clone()).await);
        assert_eq!(persisted["goal"], second["goal"]);
        assert_eq!(persisted["currentRevision"], second["currentRevision"]);
        assert_eq!(persisted["executionDisposition"], "preview-only");
        assert_eq!(persisted["integrity"], "valid");

        // Replay must resolve its immutable historical base, even though the
        // current metadata and description now differ from both earlier writes.
        let set_replay = goal_success(goal_call(&reopened, "omnia_goal_set", set_args).await);
        assert_eq!(set_replay["replayed"], true);
        assert_eq!(
            set_replay["selectedRevision"]["revisionId"],
            initial_revision
        );
        assert_eq!(set_replay["goal"], second["goal"]);
        let edit_replay = goal_success(goal_call(&reopened, "omnia_goal_edit", first_args).await);
        assert_eq!(edit_replay["replayed"], true);
        assert_eq!(
            edit_replay["selectedRevision"]["revisionId"],
            first["currentRevision"]["revisionId"]
        );
        assert_eq!(edit_replay["currentRevision"], second["currentRevision"]);
        assert_eq!(edit_replay["goal"], second["goal"]);
        let selected: Value = serde_json::from_str(
            edit_replay["selectedRevision"]["payloadJson"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(selected["description"], "First description");
        assert_eq!(selected["metadata"], json!({"phase": "first"}));

        let list = goal_success(goal_call(&reopened, "omnia_goal_list", json!({})).await);
        assert_eq!(list["executionDisposition"], "preview-only");
        assert_eq!(list["goals"].as_array().unwrap().len(), 1);
        assert_eq!(
            list["goals"][0]["currentRevisionId"],
            second["currentRevision"]["revisionId"]
        );
        let unchanged = goal_success(goal_call(&reopened, "omnia_goal_read", read_args).await);
        assert_eq!(unchanged["goal"], persisted["goal"]);
        assert_eq!(unchanged["currentRevision"]["revisionNo"], 3);
    }

    #[tokio::test]
    async fn goal_stale_remove_and_edit_leave_the_native_head_unchanged() {
        let backend = FakeBackend::default();
        let created = goal_success(
            goal_call(
                &backend,
                "omnia_goal_set",
                json!({"title": "CAS fixture", "idempotencyKey": "cas-set"}),
            )
            .await,
        );
        let goal_id = created["goal"]["id"].as_str().unwrap();
        let revision_id = created["currentRevision"]["revisionId"].as_str().unwrap();
        let changed = goal_success(
            goal_call(
                &backend,
                "omnia_goal_edit",
                json!({
                    "goalId": goal_id, "expectedCurrentRevisionId": revision_id,
                    "title": "Current title", "idempotencyKey": "cas-edit"
                }),
            )
            .await,
        );
        for (name, arguments) in [
            (
                "omnia_goal_edit",
                json!({
                    "goalId": goal_id, "expectedCurrentRevisionId": revision_id,
                    "title": "Stale title", "idempotencyKey": "cas-stale-edit"
                }),
            ),
            (
                "omnia_goal_remove",
                json!({
                    "goalId": goal_id, "expectedCurrentRevisionId": revision_id,
                    "status": "archived", "idempotencyKey": "cas-stale-remove"
                }),
            ),
        ] {
            goal_failure(
                goal_call(&backend, name, arguments).await,
                "stale_revision_head",
            );
        }
        let current =
            goal_success(goal_call(&backend, "omnia_goal_read", json!({"goalId": goal_id})).await);
        assert_eq!(current["goal"], changed["goal"]);
        assert_eq!(current["currentRevision"], changed["currentRevision"]);
        assert_eq!(current["currentRevision"]["revisionNo"], 2);
    }

    #[tokio::test]
    async fn goal_payload_drift_cannot_rebind_a_native_mutation_receipt() {
        let backend = FakeBackend::default();
        let created = goal_success(
            goal_call(
                &backend,
                "omnia_goal_set",
                json!({"title": "Drift fixture", "idempotencyKey": "drift-set"}),
            )
            .await,
        );
        goal_failure(
            goal_call(
                &backend,
                "omnia_goal_set",
                json!({"title": "Different goal", "idempotencyKey": "drift-set"}),
            )
            .await,
            "payload_drift",
        );
        let goal_id = created["goal"]["id"].as_str().unwrap();
        let original_revision = created["currentRevision"]["revisionId"].as_str().unwrap();
        let edit_args = json!({
            "goalId": goal_id, "expectedCurrentRevisionId": original_revision,
            "title": "Accepted edit", "idempotencyKey": "drift-edit"
        });
        let accepted =
            goal_success(goal_call(&backend, "omnia_goal_edit", edit_args.clone()).await);
        let mut changed_payload = edit_args.clone();
        changed_payload["title"] = json!("Payload drift");
        let mut changed_precondition = edit_args;
        changed_precondition["expectedCurrentRevisionId"] =
            accepted["currentRevision"]["revisionId"].clone();
        for arguments in [changed_payload, changed_precondition] {
            goal_failure(
                goal_call(&backend, "omnia_goal_edit", arguments).await,
                "payload_drift",
            );
        }
        let current =
            goal_success(goal_call(&backend, "omnia_goal_read", json!({"goalId": goal_id})).await);
        assert_eq!(current["goal"], accepted["goal"]);
        assert_eq!(current["currentRevision"]["revisionNo"], 2);
        let list = goal_success(goal_call(&backend, "omnia_goal_list", json!({})).await);
        assert_eq!(list["goals"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn goal_terminal_history_survives_reopen_and_rejects_new_mutations() {
        let database = TempGoalDatabase::new();
        for status in ["archived", "cancelled"] {
            let backend = FakeBackend::with_goal_database(&database.0);
            let created = goal_success(
                goal_call(
                    &backend,
                    "omnia_goal_set",
                    json!({
                        "title": "Terminal fixture",
                        "idempotencyKey": format!("terminal-set-{status}")
                    }),
                )
                .await,
            );
            let goal_id = created["goal"]["id"].as_str().unwrap();
            let remove_args = json!({
                "goalId": goal_id,
                "expectedCurrentRevisionId": created["currentRevision"]["revisionId"],
                "status": status,
                "idempotencyKey": format!("terminal-remove-{status}")
            });
            let removed =
                goal_success(goal_call(&backend, "omnia_goal_remove", remove_args.clone()).await);
            assert_eq!(removed["goal"]["status"], status);
            assert!(removed["goal"]["deletedAtMs"].is_null());
            drop(backend);

            let reopened = FakeBackend::with_goal_database(&database.0);
            let replay =
                goal_success(goal_call(&reopened, "omnia_goal_remove", remove_args.clone()).await);
            assert_eq!(replay["replayed"], true);
            assert_eq!(replay["goal"], removed["goal"]);
            goal_failure(
                goal_call(
                    &reopened,
                    "omnia_goal_edit",
                    json!({
                        "goalId": goal_id,
                        "expectedCurrentRevisionId": removed["currentRevision"]["revisionId"],
                        "title": "Cannot resurrect terminal goal",
                        "status": "active",
                        "idempotencyKey": format!("terminal-edit-{status}")
                    }),
                )
                .await,
                "goal_terminal",
            );
            let mut changed_status = remove_args;
            changed_status["status"] = json!(if status == "archived" {
                "cancelled"
            } else {
                "archived"
            });
            goal_failure(
                goal_call(&reopened, "omnia_goal_remove", changed_status).await,
                "payload_drift",
            );
            let retained = goal_success(
                goal_call(&reopened, "omnia_goal_read", json!({"goalId": goal_id})).await,
            );
            assert_eq!(retained["goal"], removed["goal"]);
            assert_eq!(retained["currentRevision"], removed["currentRevision"]);
            assert_eq!(retained["executionDisposition"], "preview-only");
            assert_eq!(retained["currentRevision"]["revisionNo"], 2);
        }
    }

    #[tokio::test]
    async fn send_defaults_wait_true_and_clamps_the_timeout() {
        let backend = FakeBackend::default();
        let _ = handle_message(
            &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"omnia_send_message","arguments":{"sessionId":"s","text":"x","timeoutSeconds":99999}}}),
            &backend,
        )
        .await;
        let _ = handle_message(
            &json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"omnia_send_message","arguments":{"sessionId":"s","text":"x","wait":false,"timeoutSeconds":5}}}),
            &backend,
        )
        .await;
        let calls = backend.calls.lock().unwrap().clone();
        assert_eq!(calls, ["send s wait=true t=600", "send s wait=false t=5"]);
    }

    #[tokio::test]
    async fn http_layer_enforces_auth_routing_and_batches() {
        let backend = FakeBackend::default();
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.to_vec();
        let mut request = HttpRequest {
            method: "POST".into(),
            path: "/mcp".into(),
            headers: good_headers(),
            body: body.clone(),
        };
        let ok = handle_http(&request, TOKEN, &backend).await;
        assert_eq!(ok.status, 200);
        assert_eq!(
            serde_json::from_slice::<Value>(&ok.body).unwrap()["result"],
            json!({})
        );

        request.headers = headers(&[("Host", "127.0.0.1")]);
        let denied = handle_http(&request, TOKEN, &backend).await;
        assert_eq!(denied.status, 401);
        assert!(denied.headers.iter().any(|(k, _)| *k == "WWW-Authenticate"));

        request.headers = good_headers();
        request
            .headers
            .push(("Origin".into(), "https://evil.example".into()));
        assert_eq!(handle_http(&request, TOKEN, &backend).await.status, 403);

        request.headers = good_headers();
        request.method = "GET".into();
        assert_eq!(handle_http(&request, TOKEN, &backend).await.status, 405);
        request.method = "POST".into();
        request.path = "/other".into();
        assert_eq!(handle_http(&request, TOKEN, &backend).await.status, 404);

        request.path = "/mcp?x=1".into();
        request.body = br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.to_vec();
        assert_eq!(handle_http(&request, TOKEN, &backend).await.status, 202);
        request.body = b"{nope".to_vec();
        let parse = handle_http(&request, TOKEN, &backend).await;
        assert_eq!(
            serde_json::from_slice::<Value>(&parse.body).unwrap()["error"]["code"],
            -32700
        );
        request.body =
            br#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"x"}]"#
                .to_vec();
        let batch = handle_http(&request, TOKEN, &backend).await;
        assert_eq!(
            serde_json::from_slice::<Value>(&batch.body)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn parse_head_validates_the_request_line_and_headers() {
        let (method, path, h) =
            parse_head("POST /mcp HTTP/1.1\r\nHost: a\r\nContent-Length: 2").unwrap();
        assert_eq!((method.as_str(), path.as_str()), ("POST", "/mcp"));
        assert_eq!(header(&h, "content-length"), Some("2"));
        assert!(parse_head("garbage").is_err());
        assert!(parse_head("POST mcp HTTP/1.1").is_err());
        assert!(parse_head("POST /mcp HTTP/1.1\r\nbad header: x").is_err());
    }

    #[test]
    fn transcript_formatting_and_final_text() {
        let messages = vec![
            Message::user("hello"),
            Message {
                role: Role::Assistant,
                content: vec![
                    Block::Thinking {
                        text: "secret".into(),
                        signature: None,
                    },
                    Block::Text {
                        text: "first".into(),
                    },
                    Block::ToolUse {
                        id: "t".into(),
                        name: "bash".into(),
                        input: json!({"cmd": "ls"}),
                    },
                ],
            },
            Message {
                role: Role::User,
                content: vec![Block::ToolResult {
                    tool_use_id: "t".into(),
                    content: vec![Block::text("file.txt")],
                    is_error: false,
                }],
            },
            Message {
                role: Role::Assistant,
                content: vec![Block::Text {
                    text: "done".into(),
                }],
            },
        ];
        let all = format_transcript(&messages, None);
        assert!(all.contains("### #0 user\nhello"));
        assert!(all.contains("[tool_use bash]"));
        assert!(all.contains("[tool_result] file.txt"));
        assert!(!all.contains("secret"));
        let last = format_transcript(&messages, Some(1));
        assert!(last.starts_with("### #3 assistant"));
        assert_eq!(last_assistant_text(&messages), "done");
        assert_eq!(last_assistant_text(&messages[..1]), "");
        assert_eq!(format_transcript(&[], None), "(no messages)");
    }

    // ---- real sockets -----------------------------------------------------

    async fn http_round_trip(addr: SocketAddr, raw: String) -> (u16, String) {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream.write_all(raw.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        stream.read_to_end(&mut out).await.unwrap();
        let text = String::from_utf8_lossy(&out).into_owned();
        let status = text.split(' ').nth(1).unwrap().parse().unwrap();
        let body = text
            .split_once("\r\n\r\n")
            .map(|(_, b)| b.to_owned())
            .unwrap_or_default();
        (status, body)
    }

    fn post(addr: SocketAddr, extra_headers: &str, body: &str) -> String {
        format!(
            "POST /mcp HTTP/1.1\r\nHost: {addr}\r\n{extra_headers}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
    }

    #[tokio::test]
    async fn server_round_trip_over_a_real_socket() {
        let token = Arc::new(RwLock::new("omnia_live".to_owned()));
        let server = serve(Arc::new(FakeBackend::default()), Arc::clone(&token), 0)
            .await
            .unwrap();
        let addr = server.addr;
        assert!(addr.ip().is_loopback());
        let list = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;

        let (status, _) = http_round_trip(addr, post(addr, "", list)).await;
        assert_eq!(status, 401);
        let (status, _) =
            http_round_trip(addr, post(addr, "Authorization: Bearer wrong\r\n", list)).await;
        assert_eq!(status, 401);
        let (status, _) = http_round_trip(
            addr,
            post(
                addr,
                "Authorization: Bearer omnia_live\r\nOrigin: https://evil.example\r\n",
                list,
            ),
        )
        .await;
        assert_eq!(status, 403);

        let (status, body) = http_round_trip(
            addr,
            post(addr, "Authorization: Bearer omnia_live\r\n", list),
        )
        .await;
        assert_eq!(status, 200);
        let reply: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(reply["result"]["tools"].as_array().unwrap().len(), 19);

        let call = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"omnia_send_message","arguments":{"sessionId":"s1","text":"ping"}}}"#;
        let (status, body) = http_round_trip(
            addr,
            post(addr, "Authorization: Bearer omnia_live\r\n", call),
        )
        .await;
        assert_eq!(status, 200);
        assert!(body.contains("echo: ping"), "{body}");

        // Rotating the shared token takes effect immediately.
        *token.write().unwrap() = "omnia_rotated".to_owned();
        let (status, _) = http_round_trip(
            addr,
            post(addr, "Authorization: Bearer omnia_live\r\n", list),
        )
        .await;
        assert_eq!(status, 401);
        let (status, _) = http_round_trip(
            addr,
            post(addr, "Authorization: Bearer omnia_rotated\r\n", list),
        )
        .await;
        assert_eq!(status, 200);

        // Oversized and chunked bodies are refused.
        let huge = format!(
            "POST /mcp HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer omnia_rotated\r\nContent-Length: 99999999\r\n\r\n"
        );
        assert_eq!(http_round_trip(addr, huge).await.0, 413);
        let chunked = format!(
            "POST /mcp HTTP/1.1\r\nHost: {addr}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"
        );
        assert_eq!(http_round_trip(addr, chunked).await.0, 411);

        assert!(
            TcpListener::bind(addr).await.is_err(),
            "live listener must exclude the teardown probe"
        );
        server.stop().await;
        // A local network filter can acknowledge connects to closed ports.
        // Rebinding checks release of the actual listening endpoint.
        let released = TcpListener::bind(addr)
            .await
            .expect("stopped listener releases its endpoint");
        drop(released);
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omnia-mcp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn manager_enables_rotates_persists_and_disables() {
        let dir = temp_dir();
        let backend: Arc<dyn McpBackend> = Arc::new(FakeBackend::default());
        let manager = McpServerManager::new(&dir);
        let status = manager.status().await;
        assert!(!status.enabled && status.url.is_none() && status.token.is_none());
        assert!(manager.rotate_token().await.is_err());

        let on = manager.set(Arc::clone(&backend), true, None).await.unwrap();
        assert!(on.enabled);
        let token = on.token.clone().unwrap();
        assert!(token.starts_with("omnia_") && token.len() > 40);
        let url = on.url.clone().unwrap();
        assert!(url.starts_with("http://127.0.0.1:") && url.ends_with("/mcp"));
        assert_ne!(on.port, 0, "the random port is remembered");
        // Idempotent while running.
        assert_eq!(
            manager.set(Arc::clone(&backend), true, None).await.unwrap(),
            on
        );

        let addr: SocketAddr = url
            .trim_start_matches("http://")
            .trim_end_matches("/mcp")
            .parse()
            .unwrap();
        let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let (status, _) = http_round_trip(
            addr,
            post(addr, &format!("Authorization: Bearer {token}\r\n"), ping),
        )
        .await;
        assert_eq!(status, 200);

        let rotated = manager.rotate_token().await.unwrap();
        let new_token = rotated.token.clone().unwrap();
        assert_ne!(new_token, token);
        let (status, _) = http_round_trip(
            addr,
            post(addr, &format!("Authorization: Bearer {token}\r\n"), ping),
        )
        .await;
        assert_eq!(status, 401);

        // Settings persist (token included) in the data dir.
        let saved: McpServerSettings =
            serde_json::from_str(&std::fs::read_to_string(dir.join(SETTINGS_FILE)).unwrap())
                .unwrap();
        assert!(saved.enabled && saved.token == new_token && saved.port == on.port);

        // A fresh manager (app relaunch) restarts the server on the same port.
        let relaunched = McpServerManager::new(&dir);
        manager
            .set(Arc::clone(&backend), false, None)
            .await
            .unwrap();
        relaunched
            .start_if_enabled(Arc::clone(&backend))
            .await
            .unwrap();
        let again = relaunched.status().await;
        assert!(again.enabled);
        relaunched
            .set(Arc::clone(&backend), false, None)
            .await
            .unwrap();

        let off = relaunched.status().await;
        assert!(!off.enabled && off.token.is_none());
        let cleared: McpServerSettings =
            serde_json::from_str(&std::fs::read_to_string(dir.join(SETTINGS_FILE)).unwrap())
                .unwrap();
        assert!(!cleared.enabled && cleared.token.is_empty());
        let released = TcpListener::bind(addr)
            .await
            .expect("disabled server releases its endpoint");
        drop(released);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tokens_are_unique_and_long() {
        let a = generate_token().unwrap();
        let b = generate_token().unwrap();
        assert_ne!(a, b);
        assert_eq!(a.len(), "omnia_".len() + 64);
    }
}
