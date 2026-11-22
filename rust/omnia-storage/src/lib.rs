#![forbid(unsafe_code)]

//! Persistent SQLite storage layers for both `omnia-studio` (`SessionStore`)
//! and `omnia-native` (`HarnessStore`, `Sessions`, `SessionWorker`, `ProviderProfileRepository`,
//! `RunRegistry`, `RunCoordinator`).

mod agent_cache;
mod error;
mod native_store;
mod native_types;
mod session_store;
mod sessions;

pub use agent_cache::{
    AcePlaybookEntry, AgentCacheStore, MerkleAstCacheEntry, WireTelemetryRecord,
    WireTelemetrySummary, AGENT_CACHE_SCHEMA_SQL,
};
pub use error::StoreError;
pub use native_store::HarnessStore;
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
    AttachmentPlacement, LeaseRecord, RunJournalEntry, SessionCursor, SessionMessageRecord,
    SessionPage, SessionRecord, SessionStore, StoredAttachment,
};
pub use sessions::{
    build_provider, get_profile_on, list_profiles_on, prepare_session_config, provider_selection,
    provider_selection_on, publish_run_event, upsert_profile_on, EnvSecretBroker, MapSecretBroker,
    ProviderProfileRepository, RunCoordinator, RunRegistry, SecretBroker, SessionCommand,
    SessionRegistry, SessionResponse, SessionWorker, Sessions, SessionsSnapshot,
    MAX_PENDING_SESSION_COMMANDS, MAX_PENDING_SESSION_RESPONSES,
};
