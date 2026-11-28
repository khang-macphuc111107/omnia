#![forbid(unsafe_code)]

//! Persistent SQLite storage layers for both `omnia-studio` (`SessionStore`)
//! and `omnia-native` (`HarnessStore`, `Sessions`, `SessionWorker`, `ProviderProfileRepository`,
//! `RunRegistry`, `RunCoordinator`).

mod error;
mod graph_cursor;
mod native_store;
mod native_types;
mod recall_store;
mod session_store;
mod sessions;

pub(crate) const SQLITE_SECURITY_PRAGMAS: &str =
    "PRAGMA trusted_schema = OFF; PRAGMA secure_delete = ON;";

pub(crate) fn apply_connection_security_pragmas(
    conn: &omnia_winsqlite::Connection,
) -> Result<(), StoreError> {
    conn.exec_batch(SQLITE_SECURITY_PRAGMAS)?;
    Ok(())
}

pub use error::StoreError;
pub use graph_cursor::{
    decode_graph_cursor, encode_graph_cursor, hmac_sha256, new_graph_cursor_secret,
    GraphCursorCodec, GraphKeysetCursor, GRAPH_CURSOR_PREFIX, MIN_GRAPH_CURSOR_SECRET_BYTES,
};
pub use native_store::HarnessStore;
pub use recall_store::{
    KanbanTaskRecord, KbNoteRecord, PasteRecord, RecallStore, RoutineRecord, RoutineRunRecord,
    SessionSearchHit, WireTelemetryRecord, WireTelemetrySummary, RECALL_STORE_SCHEMA_SQL,
};
pub use native_types::{
    normalize_and_validate_model, normalize_and_validate_title, validate_page_limit,
    validate_session_id, AgentEvent, AgentMessage, AgentRunStateRecord, AgentRunStatus,
    AgentSessionNavigationSnapshot, AgentSessionPage, AgentSessionPageCursor, AgentSessionSummary,
    CancellationToken, ConfiguredProvider, CreateAgentSessionRequest, HarnessEnvironment,
    PreparedSessionConfig, ProviderProfileInput, ProviderProfileRecord, ProviderSelection,
    RunEventState, SaveAgentSessionNavigationRequest, UpdateAgentSessionSettingsRequest,
    DEFAULT_AGENT_SESSION_PAGE_LIMIT, DEFAULT_TOKEN_BUDGET, MAX_AGENT_MODEL_CHARS,
    MAX_AGENT_SESSION_ID_CHARS, MAX_AGENT_SESSION_PAGE_LIMIT, MAX_AGENT_SESSION_TITLE_CHARS,
    MAX_NAVIGATION_OPEN_SESSION_IDS,
};
pub use session_store::{
    is_valid_studio_session_id, AttachmentPlacement, LeaseRecord, RunJournalEntry, SessionCursor,
    SessionMessageRecord, SessionPage, SessionRecord, SessionStore, StoredAttachment,
};
pub use sessions::{
    build_provider, get_profile_on, list_profiles_on, prepare_session_config, provider_selection,
    provider_selection_on, publish_run_event, upsert_profile_on, validate_loopback_http_url,
    validate_provider_base_url, EnvSecretBroker, MapSecretBroker, ProviderProfileRepository,
    RunCoordinator, RunRegistry, SecretBroker, SessionCommand, SessionRegistry, SessionResponse,
    SessionWorker, Sessions, SessionsSnapshot, MAX_PENDING_SESSION_COMMANDS,
    MAX_PENDING_SESSION_RESPONSES,
};
