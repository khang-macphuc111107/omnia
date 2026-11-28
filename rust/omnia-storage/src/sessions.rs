use std::collections::{HashMap, VecDeque};
use std::env;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use omnia_core::{compact_json, now_epoch_ms, parse_json, uuid_v4_simple};
use omnia_winsqlite::{Connection, StepStatus};
use serde_json::{json, Value};

use crate::error::StoreError;
use crate::native_store::HarnessStore;
use crate::native_types::{
    validate_page_limit, validate_session_id, AgentEvent, AgentRunStateRecord, AgentRunStatus,
    AgentSessionPage, AgentSessionPageCursor, AgentSessionSummary, CancellationToken,
    ConfiguredProvider, CreateAgentSessionRequest, PreparedSessionConfig, ProviderProfileInput,
    ProviderProfileRecord, ProviderSelection, RunEventState, SaveAgentSessionNavigationRequest,
    UpdateAgentSessionSettingsRequest, DEFAULT_AGENT_SESSION_PAGE_LIMIT,
};

pub const MAX_PENDING_SESSION_COMMANDS: usize = 1;
pub const MAX_PENDING_SESSION_RESPONSES: usize = 2;

const PROVIDER_PROFILE_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS provider_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    secret_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    extra_json TEXT NOT NULL DEFAULT '{}',
    updated_at_ms INTEGER NOT NULL DEFAULT 0
);
"#;

/// Repository for `provider_profiles`, supporting strict read-only inspection
/// without triggering WAL recovery or file modification.
#[derive(Debug)]
pub struct ProviderProfileRepository {
    conn: Connection,
}

impl ProviderProfileRepository {
    /// Open an existing SQLite database read-only without running recovery or writes.
    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let conn = Connection::open_read_only(path)?;
        crate::apply_connection_security_pragmas(&conn)?;
        Ok(Self { conn })
    }

    /// Open (or create) a read-write provider repository and ensure `provider_profiles` exists.
    pub fn open_read_write(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let conn = Connection::open_read_write(path)?;
        crate::apply_connection_security_pragmas(&conn)?;
        conn.exec_batch(PROVIDER_PROFILE_DDL)?;
        Ok(Self { conn })
    }

    /// Create an isolated in-memory provider repository for tests.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        crate::apply_connection_security_pragmas(&conn)?;
        conn.exec_batch(PROVIDER_PROFILE_DDL)?;
        Ok(Self { conn })
    }

    /// List all provider profiles ordered by `updated_at_ms DESC, id ASC`.
    pub fn list_profiles(&self) -> Result<Vec<ProviderProfileRecord>, StoreError> {
        list_profiles_on(&self.conn)
    }

    /// Fetch a single provider profile by ID.
    pub fn get_profile(&self, id: &str) -> Result<Option<ProviderProfileRecord>, StoreError> {
        get_profile_on(&self.conn, id)
    }

    /// Insert or update a provider profile.
    pub fn upsert_profile(
        &mut self,
        input: ProviderProfileInput,
        now_ms: i64,
    ) -> Result<ProviderProfileRecord, StoreError> {
        upsert_profile_on(&mut self.conn, input, now_ms)
    }

    /// Read any `agent_run_state` status for read-only inspection tests.
    pub fn list_run_states(&self) -> Result<Vec<AgentRunStateRecord>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT session_id, status, snapshot_sequence FROM agent_run_state ORDER BY session_id ASC;")?;
        let mut out = Vec::new();
        while stmt.step()? == StepStatus::Row {
            out.push(AgentRunStateRecord {
                session_id: stmt.column_text(0)?,
                status: AgentRunStatus::parse(&stmt.column_text(1)?)?,
                snapshot_sequence: stmt.column_int64(2)?,
            });
        }
        Ok(out)
    }
}

pub fn list_profiles_on(conn: &Connection) -> Result<Vec<ProviderProfileRecord>, StoreError> {
    let mut table_check = conn.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_profiles';",
    )?;
    if table_check.step()? != StepStatus::Row {
        return Ok(Vec::new());
    }
    drop(table_check);

    let mut stmt = conn.prepare(
        "SELECT id, name, kind, base_url, model, secret_key, enabled, extra_json, updated_at_ms\n\
         FROM provider_profiles\n\
         ORDER BY updated_at_ms DESC, id ASC;",
    )?;
    let mut out = Vec::new();
    while stmt.step()? == StepStatus::Row {
        out.push(read_profile_row(&stmt)?);
    }
    Ok(out)
}

pub fn get_profile_on(
    conn: &Connection,
    id: &str,
) -> Result<Option<ProviderProfileRecord>, StoreError> {
    if id.trim().is_empty() {
        return Err(StoreError::invalid_input(
            "Provider profile id cannot be empty.",
        ));
    }
    let mut table_check = conn.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_profiles';",
    )?;
    if table_check.step()? != StepStatus::Row {
        return Ok(None);
    }
    drop(table_check);

    let mut stmt = conn.prepare(
        "SELECT id, name, kind, base_url, model, secret_key, enabled, extra_json, updated_at_ms\n\
         FROM provider_profiles\n\
         WHERE id = ?1;",
    )?;
    stmt.bind_text(1, id.trim())?;
    match stmt.step()? {
        StepStatus::Row => Ok(Some(read_profile_row(&stmt)?)),
        StepStatus::Done => Ok(None),
    }
}

pub fn upsert_profile_on(
    conn: &mut Connection,
    input: ProviderProfileInput,
    now_ms: i64,
) -> Result<ProviderProfileRecord, StoreError> {
    if input.id.trim().is_empty()
        || input.name.trim().is_empty()
        || input.kind.trim().is_empty()
        || input.base_url.trim().is_empty()
        || input.model.trim().is_empty()
    {
        return Err(StoreError::invalid_input(
            "Provider profile requires non-empty id, name, kind, base_url, and model.",
        ));
    }
    let id = input.id.trim().to_owned();
    let name = input.name.trim().to_owned();
    let kind = input.kind.trim().to_owned();
    let base_url = input.base_url.trim().to_owned();
    let model = input.model.trim().to_owned();
    let secret_key = input.secret_key.trim().to_owned();
    let extra_str = compact_json(&input.extra_json)?;

    let tx = conn.begin_immediate()?;
    let mut stmt = tx.prepare(
        "INSERT INTO provider_profiles\n\
         (id, name, kind, base_url, model, secret_key, enabled, extra_json, updated_at_ms)\n\
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)\n\
         ON CONFLICT(id) DO UPDATE SET\n\
             name = excluded.name,\n\
             kind = excluded.kind,\n\
             base_url = excluded.base_url,\n\
             model = excluded.model,\n\
             secret_key = excluded.secret_key,\n\
             enabled = excluded.enabled,\n\
             extra_json = excluded.extra_json,\n\
             updated_at_ms = excluded.updated_at_ms;",
    )?;
    stmt.bind_text(1, &id)?;
    stmt.bind_text(2, &name)?;
    stmt.bind_text(3, &kind)?;
    stmt.bind_text(4, &base_url)?;
    stmt.bind_text(5, &model)?;
    stmt.bind_text(6, &secret_key)?;
    stmt.bind_int64(7, i64::from(input.enabled))?;
    stmt.bind_text(8, &extra_str)?;
    stmt.bind_int64(9, now_ms)?;
    stmt.step()?;
    drop(stmt);
    tx.commit()?;

    Ok(ProviderProfileRecord {
        id,
        name,
        kind,
        base_url,
        model,
        secret_key,
        enabled: input.enabled,
        extra_json: input.extra_json,
        updated_at_ms: now_ms,
    })
}

fn read_profile_row(
    stmt: &omnia_winsqlite::Statement<'_>,
) -> Result<ProviderProfileRecord, StoreError> {
    let extra_raw = stmt.column_text(7)?;
    let extra_json = if extra_raw.trim().is_empty() {
        json!({})
    } else {
        parse_json(&extra_raw)?
    };
    Ok(ProviderProfileRecord {
        id: stmt.column_text(0)?,
        name: stmt.column_text(1)?,
        kind: stmt.column_text(2)?,
        base_url: stmt.column_text(3)?,
        model: stmt.column_text(4)?,
        secret_key: stmt.column_text(5)?,
        enabled: stmt.column_int64(6)? != 0,
        extra_json,
        updated_at_ms: stmt.column_int64(8)?,
    })
}

/// Abstract secret lookup boundary so provider selection never logs or mutates process env in tests.
pub trait SecretBroker: Send + Sync {
    fn get_secret(&self, secret_key: &str) -> Result<Option<String>, StoreError>;
}

/// Production broker reading non-empty secrets from process environment variables.
#[derive(Debug, Default, Clone, Copy)]
pub struct EnvSecretBroker;

impl SecretBroker for EnvSecretBroker {
    fn get_secret(&self, secret_key: &str) -> Result<Option<String>, StoreError> {
        if secret_key.trim().is_empty() {
            return Ok(None);
        }
        match env::var(secret_key.trim()) {
            Ok(val) if !val.trim().is_empty() => Ok(Some(val)),
            _ => Ok(None),
        }
    }
}

/// Thread-safe in-memory secret broker for deterministic tests without mutating global env.
#[derive(Debug, Default, Clone)]
pub struct MapSecretBroker {
    secrets: Arc<Mutex<HashMap<String, String>>>,
}

impl MapSecretBroker {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, key: impl Into<String>, value: impl Into<String>) {
        if let Ok(mut guard) = self.secrets.lock() {
            guard.insert(key.into(), value.into());
        }
    }
}

impl SecretBroker for MapSecretBroker {
    fn get_secret(&self, secret_key: &str) -> Result<Option<String>, StoreError> {
        if secret_key.trim().is_empty() {
            return Ok(None);
        }
        let guard = self
            .secrets
            .lock()
            .map_err(|_| StoreError::storage_failed("MapSecretBroker mutex poisoned."))?;
        Ok(guard
            .get(secret_key.trim())
            .filter(|v| !v.trim().is_empty())
            .cloned())
    }
}

/// Select an enabled provider profile and resolve its credential from `broker`.
pub fn provider_selection(
    repo: &ProviderProfileRepository,
    broker: &dyn SecretBroker,
    preferred_id: Option<&str>,
) -> Result<ProviderSelection, StoreError> {
    provider_selection_on(&repo.conn, broker, preferred_id)
}

pub fn provider_selection_on(
    conn: &Connection,
    broker: &dyn SecretBroker,
    preferred_id: Option<&str>,
) -> Result<ProviderSelection, StoreError> {
    let profile = match preferred_id {
        Some(id) => get_profile_on(conn, id)?.ok_or_else(|| {
            StoreError::not_found(
                "provider_profile_missing",
                format!("Provider profile not found: {id}"),
            )
        })?,
        None => {
            let profiles = list_profiles_on(conn)?;
            if profiles.is_empty() {
                return Err(StoreError::not_found(
                    "provider_profile_missing",
                    "No provider profiles configured.",
                ));
            }
            profiles.into_iter().find(|p| p.enabled).ok_or_else(|| {
                StoreError::new(
                    "provider_disabled",
                    "All configured provider profiles are disabled.",
                    false,
                )
            })?
        }
    };

    if !profile.enabled {
        return Err(StoreError::new(
            "provider_disabled",
            format!("Provider profile '{}' is disabled.", profile.id),
            false,
        ));
    }

    if profile.secret_key.trim().is_empty() {
        return Err(StoreError::new(
            "secret_missing",
            format!(
                "Provider profile '{}' does not configure a secret_key.",
                profile.id
            ),
            false,
        ));
    }

    let api_key = broker.get_secret(&profile.secret_key)?.ok_or_else(|| {
        StoreError::new(
            "secret_missing",
            format!(
                "Missing credential secret '{}' for provider profile '{}'.",
                profile.secret_key, profile.id
            ),
            false,
        )
    })?;

    Ok(ProviderSelection { profile, api_key })
}

/// Validate a configured provider `base_url` (`AUD-12`):
/// - Requires strict `http://` or `https://` scheme with non-empty host and optional valid port (`1..=65535`).
/// - Rejects ASCII control characters, whitespace, embedded userinfo (`user:pass@`), query strings (`?`), and fragments (`#`).
/// - Cleartext `http://` is strictly restricted to canonical loopback hosts (`127.0.0.1`, `localhost`, `[::1]`).
/// - `https://` allows configured remote hosts and loopback while rejecting unspecified/link-local metadata targets (`0.0.0.0`, `[::]`, `169.254.*`, `fe80:*`).
pub fn validate_provider_base_url(raw: &str) -> Result<String, StoreError> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed
            .bytes()
            .any(|b| b <= 0x20 || b == 0x7f)
    {
        return Err(StoreError::invalid_input(
            "Provider base_url must be non-empty without whitespace or control characters.",
        ));
    }
    let (is_https, rest) = if let Some(r) = trimmed.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = trimmed.strip_prefix("http://") {
        (false, r)
    } else {
        return Err(StoreError::invalid_input(
            "Provider base_url must start with http:// or https://.",
        ));
    };
    if rest.contains('?') || rest.contains('#') {
        return Err(StoreError::invalid_input(
            "Provider base_url must not include query or fragment.",
        ));
    }
    let authority = rest.split('/').next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return Err(StoreError::invalid_input(
            "Provider base_url authority is missing or contains disallowed userinfo.",
        ));
    }

    let (host, port_opt) = parse_authority_host_port(authority)?;
    if let Some(port_str) = port_opt {
        parse_valid_port(port_str)?;
    }

    if !is_https {
        if !is_strict_loopback_host(host) {
            return Err(StoreError::invalid_input(
                "Cleartext http:// provider base_url must target loopback (127.0.0.1, localhost, or [::1]).",
            ));
        }
    } else if is_forbidden_metadata_or_unspecified_host(host) {
        return Err(StoreError::invalid_input(
            "Provider base_url cannot target unspecified or link-local metadata addresses.",
        ));
    }

    Ok(trimmed.to_owned())
}

/// Strictly parse and validate a loopback-only HTTP URL (`http://127.0.0.1[:port][/path]`,
/// `http://localhost[:port][/path]`, or `http://[::1][:port][/path]`) returning `(host, port, path)`.
pub fn validate_loopback_http_url(raw: &str) -> Result<(String, u16, String), StoreError> {
    let validated = validate_provider_base_url(raw)?;
    let Some(rest) = validated.strip_prefix("http://") else {
        return Err(StoreError::invalid_input(
            "Loopback HTTP URL must use the http:// scheme.",
        ));
    };
    let (authority, path) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    let (host, port_opt) = parse_authority_host_port(authority)?;
    let port = match port_opt {
        Some(p) => parse_valid_port(p)?,
        None => 80,
    };
    Ok((host.to_ascii_lowercase(), port, path.to_owned()))
}

fn parse_authority_host_port(authority: &str) -> Result<(&str, Option<&str>), StoreError> {
    if let Some(rest) = authority.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return Err(StoreError::invalid_input(
                "Malformed bracketed IPv6 authority in provider base_url.",
            ));
        };
        let host = &rest[..end];
        if host.is_empty()
            || !host
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.')
        {
            return Err(StoreError::invalid_input(
                "Invalid IPv6 host in provider base_url.",
            ));
        }
        let tail = &rest[end + 1..];
        if tail.is_empty() {
            return Ok((host, None));
        }
        if let Some(port_str) = tail.strip_prefix(':') {
            return Ok((host, Some(port_str)));
        }
        return Err(StoreError::invalid_input(
            "Malformed port suffix after bracketed IPv6 host.",
        ));
    }

    let (host, port_opt) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    if host.is_empty()
        || host.starts_with('.')
        || host.ends_with('.')
        || host.contains("..")
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return Err(StoreError::invalid_input(
            "Invalid host in provider base_url.",
        ));
    }
    Ok((host, port_opt))
}

fn parse_valid_port(raw: &str) -> Result<u16, StoreError> {
    if raw.is_empty()
        || raw.len() > 5
        || raw.starts_with('0')
        || !raw.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(StoreError::invalid_input(
            "Invalid port in provider base_url.",
        ));
    }
    let port = raw
        .parse::<u16>()
        .map_err(|_| StoreError::invalid_input("Port out of range in provider base_url."))?;
    if port == 0 {
        return Err(StoreError::invalid_input(
            "Port 0 is not allowed in provider base_url.",
        ));
    }
    Ok(port)
}

fn is_strict_loopback_host(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1"
    )
}

fn is_forbidden_metadata_or_unspecified_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    lower == "0.0.0.0"
        || lower == "::"
        || lower.starts_with("169.254.")
        || lower.starts_with("fe80:")
}

/// Validate a selected provider profile and construct a runtime [`ConfiguredProvider`].
pub fn build_provider(selection: ProviderSelection) -> Result<ConfiguredProvider, StoreError> {
    let p = selection.profile;
    let url = validate_provider_base_url(&p.base_url).map_err(|err| {
        StoreError::invalid_input(format!("Provider '{}' {}: {}", p.id, "base_url invalid", err.message))
    })?;
    if p.model.trim().is_empty() {
        return Err(StoreError::invalid_input(format!(
            "Provider '{}' model cannot be empty.",
            p.id
        )));
    }
    if selection.api_key.trim().is_empty() {
        return Err(StoreError::new(
            "secret_missing",
            format!("Provider '{}' resolved an empty credential.", p.id),
            false,
        ));
    }

    Ok(ConfiguredProvider {
        profile_id: p.id,
        name: p.name,
        kind: p.kind,
        base_url: url,
        model: p.model,
        api_key: selection.api_key,
        extra_json: p.extra_json,
    })
}

/// In-memory registry of currently running session turns for conflict and cancellation checks.
#[derive(Debug, Default, Clone)]
pub struct RunRegistry {
    active: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

impl RunRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_run(&self, session_id: &str) -> Result<CancellationToken, StoreError> {
        validate_session_id(session_id)?;
        let mut guard = self
            .active
            .lock()
            .map_err(|_| StoreError::storage_failed("RunRegistry mutex poisoned."))?;
        if guard.contains_key(session_id) {
            return Err(StoreError::conflict(
                "session_run_active",
                format!("Session {session_id} already has an active run."),
            ));
        }
        let token = CancellationToken::new();
        guard.insert(session_id.to_owned(), token.clone());
        Ok(token)
    }

    #[must_use]
    pub fn cancel_run(&self, session_id: &str) -> bool {
        let Ok(guard) = self.active.lock() else {
            return false;
        };
        if let Some(token) = guard.get(session_id) {
            token.cancel();
            return true;
        }
        false
    }

    pub fn finish_run(&self, session_id: &str) {
        if let Ok(mut guard) = self.active.lock() {
            guard.remove(session_id);
        }
    }

    #[must_use]
    pub fn is_active(&self, session_id: &str) -> bool {
        self.active
            .lock()
            .map(|guard| guard.contains_key(session_id))
            .unwrap_or(false)
    }

    #[must_use]
    pub fn active_count(&self) -> usize {
        self.active.lock().map(|g| g.len()).unwrap_or(0)
    }
}

/// Persist and append a secret-redacted [`AgentEvent`] to both `HarnessStore` and [`RunEventState`].
pub fn publish_run_event(
    store: &mut HarnessStore,
    state: &mut RunEventState,
    event_type: &str,
    payload: Value,
    now_ms: i64,
) -> Result<AgentEvent, StoreError> {
    let event = store.append_agent_event(
        &state.session_id,
        &state.run_id,
        event_type,
        payload,
        now_ms,
    )?;
    state.last_sequence = event.sequence;
    state.events.push(event.clone());
    store.set_run_state(&AgentRunStateRecord {
        session_id: state.session_id.clone(),
        status: state.status,
        snapshot_sequence: state.last_sequence,
    })?;
    Ok(event)
}

/// Coordinates run registration, persistent run-state lifecycle transitions, and event publication.
#[derive(Debug, Default, Clone)]
pub struct RunCoordinator {
    registry: RunRegistry,
}

impl RunCoordinator {
    #[must_use]
    pub fn new(registry: RunRegistry) -> Self {
        Self { registry }
    }

    #[must_use]
    pub fn registry(&self) -> &RunRegistry {
        &self.registry
    }

    pub fn start_run(
        &self,
        store: &mut HarnessStore,
        session_id: &str,
        run_id: &str,
        now_ms: i64,
    ) -> Result<(CancellationToken, RunEventState), StoreError> {
        validate_session_id(session_id)?;
        if run_id.trim().is_empty() {
            return Err(StoreError::invalid_input("run_id cannot be empty."));
        }
        let Some(_) = store.get_agent_session(session_id)? else {
            return Err(StoreError::not_found(
                "agent_session_not_found",
                format!("Agent session not found: {session_id}"),
            ));
        };

        let token = self.registry.register_run(session_id)?;
        let initial_seq = store
            .get_run_state(session_id)?
            .map(|r| r.snapshot_sequence)
            .unwrap_or(0);
        let mut state = RunEventState {
            session_id: session_id.to_owned(),
            run_id: run_id.trim().to_owned(),
            status: AgentRunStatus::Running,
            last_sequence: initial_seq,
            events: Vec::new(),
        };

        let start_payload = json!({ "runId": state.run_id });
        if let Err(err) = publish_run_event(store, &mut state, "run_started", start_payload, now_ms)
        {
            self.registry.finish_run(session_id);
            return Err(err);
        }
        Ok((token, state))
    }

    pub fn finish_run_with_status(
        &self,
        store: &mut HarnessStore,
        state: &mut RunEventState,
        status: AgentRunStatus,
        detail: Value,
        now_ms: i64,
    ) -> Result<AgentEvent, StoreError> {
        state.status = status;
        let res = publish_run_event(
            store,
            state,
            &format!("run_{}", status.as_str()),
            detail,
            now_ms,
        );
        self.registry.finish_run(&state.session_id);
        res
    }
}

/// Assemble the session summary, current navigation, run state, and optional configured provider.
pub fn prepare_session_config(
    store: &HarnessStore,
    broker: &dyn SecretBroker,
    session_id: &str,
    preferred_profile_id: Option<&str>,
) -> Result<PreparedSessionConfig, StoreError> {
    validate_session_id(session_id)?;
    let session = store.get_agent_session(session_id)?.ok_or_else(|| {
        StoreError::not_found(
            "agent_session_not_found",
            format!("Agent session not found: {session_id}"),
        )
    })?;
    let navigation = store.load_session_navigation()?.unwrap_or_default();
    let run_state = store
        .get_run_state(session_id)?
        .unwrap_or(AgentRunStateRecord {
            session_id: session.id.clone(),
            status: AgentRunStatus::Idle,
            snapshot_sequence: 0,
        });

    let profiles = list_profiles_on(store.connection())?;
    let provider = if preferred_profile_id.is_some() || !profiles.is_empty() {
        let sel = provider_selection_on(store.connection(), broker, preferred_profile_id)?;
        Some(build_provider(sel)?)
    } else {
        None
    };

    Ok(PreparedSessionConfig {
        session,
        navigation,
        provider,
        run_state,
    })
}

/// Snapshot of the currently viewed page, navigation cursors, and active session status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionsSnapshot {
    pub page: AgentSessionPage,
    pub active_session_id: Option<String>,
    pub active_session: Option<AgentSessionSummary>,
    pub active_on_page: bool,
    pub open_session_ids: Vec<String>,
    pub page_limit: usize,
    pub current_cursor: Option<AgentSessionPageCursor>,
    pub can_go_prev: bool,
    pub can_go_next: bool,
    pub navigation_revision: Option<i64>,
}

/// Stateful high-level session pager and controller over [`HarnessStore`].
#[derive(Debug)]
pub struct Sessions {
    store: HarnessStore,
    page_limit: usize,
    current_cursor: Option<AgentSessionPageCursor>,
    prev_cursors: Vec<Option<AgentSessionPageCursor>>,
    active_session_id: Option<String>,
    open_session_ids: Vec<String>,
    navigation_revision: Option<i64>,
    latest_page: AgentSessionPage,
}

/// Alias matching the prompt's `SessionRegistry` contract name.
pub type SessionRegistry = Sessions;

impl Sessions {
    pub fn from_store(store: HarnessStore) -> Result<Self, StoreError> {
        let nav = store.load_session_navigation()?;
        let page_limit = nav
            .as_ref()
            .map(|n| n.page_limit)
            .unwrap_or(DEFAULT_AGENT_SESSION_PAGE_LIMIT);
        let current_cursor = nav.as_ref().and_then(|n| n.cursor.clone());
        let active_session_id = nav.as_ref().and_then(|n| n.active_session_id.clone());
        let open_session_ids = nav
            .as_ref()
            .map(|n| n.open_session_ids.clone())
            .unwrap_or_default();
        let navigation_revision = nav.as_ref().map(|n| n.revision);

        let mut instance = Self {
            store,
            page_limit,
            current_cursor,
            prev_cursors: Vec::new(),
            active_session_id,
            open_session_ids,
            navigation_revision,
            latest_page: AgentSessionPage {
                items: Vec::new(),
                next_cursor: None,
                has_more: false,
                total_count: 0,
            },
        };
        instance.refresh()?;
        Ok(instance)
    }

    pub fn open(db_path: impl AsRef<Path>) -> Result<Self, StoreError> {
        Self::from_store(HarnessStore::open(db_path)?)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::from_store(HarnessStore::open_in_memory()?)
    }

    #[must_use]
    pub fn store(&self) -> &HarnessStore {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut HarnessStore {
        &mut self.store
    }

    #[must_use]
    pub fn page_limit(&self) -> usize {
        self.page_limit
    }

    pub fn set_page_limit(&mut self, limit: usize) -> Result<SessionsSnapshot, StoreError> {
        self.page_limit = validate_page_limit(limit)?;
        self.current_cursor = None;
        self.prev_cursors.clear();
        self.refresh()
    }

    pub fn refresh(&mut self) -> Result<SessionsSnapshot, StoreError> {
        let mut page = self
            .store
            .session_page(self.page_limit, self.current_cursor.as_ref())?;
        if page.items.is_empty() && self.current_cursor.is_some() {
            self.current_cursor = None;
            self.prev_cursors.clear();
            page = self.store.session_page(self.page_limit, None)?;
        }
        self.latest_page = page;
        self.build_snapshot()
    }

    pub fn first_page(&mut self) -> Result<SessionsSnapshot, StoreError> {
        self.current_cursor = None;
        self.prev_cursors.clear();
        self.refresh()
    }

    pub fn next_page(&mut self) -> Result<SessionsSnapshot, StoreError> {
        let Some(next) = self.latest_page.next_cursor.clone() else {
            return self.build_snapshot();
        };
        self.prev_cursors.push(self.current_cursor.clone());
        self.current_cursor = Some(next);
        self.refresh()
    }

    pub fn prev_page(&mut self) -> Result<SessionsSnapshot, StoreError> {
        let Some(prev) = self.prev_cursors.pop() else {
            return self.build_snapshot();
        };
        self.current_cursor = prev;
        self.refresh()
    }

    pub fn go_to_page(
        &mut self,
        limit: usize,
        cursor: Option<AgentSessionPageCursor>,
    ) -> Result<SessionsSnapshot, StoreError> {
        let valid_limit = validate_page_limit(limit)?;
        self.page_limit = valid_limit;
        if cursor.is_none() {
            self.prev_cursors.clear();
        }
        self.current_cursor = cursor;
        self.refresh()
    }

    pub fn create_session(
        &mut self,
        req: CreateAgentSessionRequest,
        now_ms: i64,
    ) -> Result<(AgentSessionSummary, SessionsSnapshot), StoreError> {
        let created = self.store.create_agent_session(req, now_ms)?;
        self.active_session_id = Some(created.id.clone());
        if !self.open_session_ids.contains(&created.id) {
            self.open_session_ids.push(created.id.clone());
        }
        self.persist_navigation(now_ms, None)?;
        self.current_cursor = None;
        self.prev_cursors.clear();
        let snap = self.refresh()?;
        Ok((created, snap))
    }

    pub fn select_session(
        &mut self,
        session_id: &str,
        receipt_id: Option<&str>,
        now_ms: i64,
    ) -> Result<(AgentSessionSummary, SessionsSnapshot), StoreError> {
        validate_session_id(session_id)?;
        let selected = self.store.get_agent_session(session_id)?.ok_or_else(|| {
            StoreError::not_found(
                "agent_session_not_found",
                format!("Agent session not found: {session_id}"),
            )
        })?;
        self.active_session_id = Some(selected.id.clone());
        if !self.open_session_ids.contains(&selected.id) {
            self.open_session_ids.push(selected.id.clone());
        }
        self.persist_navigation(now_ms, receipt_id)?;
        let snap = self.refresh()?;
        Ok((selected, snap))
    }

    pub fn update_settings(
        &mut self,
        req: UpdateAgentSessionSettingsRequest,
        now_ms: i64,
    ) -> Result<(AgentSessionSummary, SessionsSnapshot), StoreError> {
        let updated = self.store.update_agent_session_settings(req, now_ms)?;
        let snap = self.refresh()?;
        Ok((updated, snap))
    }

    pub fn delete_session(
        &mut self,
        session_id: &str,
        now_ms: i64,
    ) -> Result<SessionsSnapshot, StoreError> {
        validate_session_id(session_id)?;
        let deleted = self.store.delete_agent_session(session_id)?;
        if !deleted {
            return Err(StoreError::not_found(
                "agent_session_not_found",
                format!("Agent session not found: {session_id}"),
            ));
        }

        self.open_session_ids.retain(|id| id != session_id);
        if self.active_session_id.as_deref() == Some(session_id) {
            self.active_session_id = self.open_session_ids.first().cloned().or_else(|| {
                self.store
                    .session_page(1, None)
                    .ok()
                    .and_then(|p| p.items.into_iter().next().map(|s| s.id))
            });
        }
        if self.navigation_revision.is_some() {
            self.persist_navigation(now_ms, None)?;
        }
        self.refresh()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn apply_turn(
        &mut self,
        session_id: &str,
        expected_revision: i64,
        user_content: Option<&str>,
        assistant_content: Option<&str>,
        tokens_delta: i64,
        now_ms: i64,
    ) -> Result<(AgentSessionSummary, SessionsSnapshot), StoreError> {
        let updated = self.store.apply_turn(
            session_id,
            expected_revision,
            user_content,
            assistant_content,
            tokens_delta,
            now_ms,
        )?;
        let snap = self.refresh()?;
        Ok((updated, snap))
    }

    pub fn snapshot(&self) -> Result<SessionsSnapshot, StoreError> {
        self.build_snapshot()
    }

    fn persist_navigation(
        &mut self,
        now_ms: i64,
        explicit_receipt: Option<&str>,
    ) -> Result<(), StoreError> {
        let receipt_id = match explicit_receipt {
            Some(r) if !r.trim().is_empty() => r.trim().to_owned(),
            _ => format!("nav_{}", uuid_v4_simple()),
        };
        let saved = self.store.save_session_navigation(
            SaveAgentSessionNavigationRequest {
                expected_revision: self.navigation_revision,
                active_session_id: self.active_session_id.clone(),
                open_session_ids: self.open_session_ids.clone(),
                page_limit: self.page_limit,
                cursor: self.current_cursor.clone(),
                receipt_id,
            },
            now_ms,
        )?;
        self.navigation_revision = Some(saved.revision);
        self.open_session_ids = saved.open_session_ids;
        self.active_session_id = saved.active_session_id;
        Ok(())
    }

    fn build_snapshot(&self) -> Result<SessionsSnapshot, StoreError> {
        let active_session = match self.active_session_id.as_deref() {
            Some(id) => self.store.get_agent_session(id)?,
            None => None,
        };
        let active_on_page = self
            .active_session_id
            .as_deref()
            .is_some_and(|id| self.latest_page.items.iter().any(|item| item.id == id));

        Ok(SessionsSnapshot {
            page: self.latest_page.clone(),
            active_session_id: active_session.as_ref().map(|s| s.id.clone()),
            active_session,
            active_on_page,
            open_session_ids: self.open_session_ids.clone(),
            page_limit: self.page_limit,
            current_cursor: self.current_cursor.clone(),
            can_go_prev: !self.prev_cursors.is_empty(),
            can_go_next: self.latest_page.has_more,
            navigation_revision: self.navigation_revision,
        })
    }
}

/// Command variants executed asynchronously on a [`SessionWorker`] background thread.
#[derive(Debug, Clone)]
pub enum SessionCommand {
    Refresh,
    FirstPage,
    NextPage,
    PrevPage,
    Page {
        limit: usize,
        cursor: Option<AgentSessionPageCursor>,
    },
    Create(CreateAgentSessionRequest),
    Select {
        session_id: String,
        receipt_id: Option<String>,
    },
    UpdateSettings(UpdateAgentSessionSettingsRequest),
    Delete {
        session_id: String,
    },
    ApplyTurn {
        session_id: String,
        expected_revision: i64,
        user_content: Option<String>,
        assistant_content: Option<String>,
        tokens_delta: i64,
    },
}

/// Completed result produced by [`SessionWorker`].
#[derive(Debug, Clone)]
pub struct SessionResponse {
    pub request_id: u64,
    pub snapshot: Option<SessionsSnapshot>,
    pub session: Option<AgentSessionSummary>,
    pub error: Option<StoreError>,
}

struct QueuedCommand {
    request_id: u64,
    command: SessionCommand,
}

#[derive(Default)]
struct WorkerQueues {
    commands: VecDeque<QueuedCommand>,
    responses: VecDeque<SessionResponse>,
    stopped: bool,
}

struct WorkerShared {
    queues: Mutex<WorkerQueues>,
    cmd_cv: Condvar,
    resp_cv: Condvar,
}

/// Single-lane bounded background worker coordinating async SQLite session transitions.
pub struct SessionWorker {
    shared: Arc<WorkerShared>,
    next_id: AtomicU64,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl SessionWorker {
    /// Start a dedicated background worker thread owning `sessions`.
    #[must_use]
    pub fn start(sessions: Sessions) -> Self {
        let shared = Arc::new(WorkerShared {
            queues: Mutex::new(WorkerQueues::default()),
            cmd_cv: Condvar::new(),
            resp_cv: Condvar::new(),
        });
        let worker_shared = Arc::clone(&shared);
        let handle = thread::Builder::new()
            .name("omnia-session-worker".to_owned())
            .spawn(move || run_worker_loop(sessions, worker_shared))
            .expect("spawn omnia-session-worker thread");

        Self {
            shared,
            next_id: AtomicU64::new(1),
            handle: Mutex::new(Some(handle)),
        }
    }

    /// Construct a queue-backed worker WITHOUT a background thread so unit tests can
    /// deterministically assert bounded command capacity (`MAX_PENDING_SESSION_COMMANDS = 1`).
    #[must_use]
    pub fn create_unbacked_for_queue_test() -> Self {
        Self {
            shared: Arc::new(WorkerShared {
                queues: Mutex::new(WorkerQueues::default()),
                cmd_cv: Condvar::new(),
                resp_cv: Condvar::new(),
            }),
            next_id: AtomicU64::new(1),
            handle: Mutex::new(None),
        }
    }

    /// Enqueue a [`SessionCommand`] without blocking or automatic retry.
    /// Returns `session_worker_busy` when a pending command is already queued, or
    /// `session_worker_stopped` after shutdown.
    pub fn submit(&self, command: SessionCommand) -> Result<u64, StoreError> {
        let mut guard = self.shared.queues.lock().map_err(|_| {
            StoreError::new(
                "session_worker_unavailable",
                "Worker mutex poisoned.",
                false,
            )
        })?;
        if guard.stopped {
            return Err(StoreError::new(
                "session_worker_stopped",
                "Session worker has stopped.",
                false,
            ));
        }
        if guard.commands.len() >= MAX_PENDING_SESSION_COMMANDS {
            return Err(StoreError::new(
                "session_worker_busy",
                "Session worker command queue is full; no automatic retry will be scheduled.",
                true,
            ));
        }
        let request_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        guard.commands.push_back(QueuedCommand {
            request_id,
            command,
        });
        self.shared.cmd_cv.notify_one();
        Ok(request_id)
    }

    /// Non-blocking poll for the next completed [`SessionResponse`].
    #[must_use]
    pub fn poll(&self) -> Option<SessionResponse> {
        let mut guard = self.shared.queues.lock().ok()?;
        let resp = guard.responses.pop_front();
        if resp.is_some() {
            self.shared.resp_cv.notify_one();
        }
        resp
    }

    /// Wait up to `timeout` for the next completed [`SessionResponse`].
    #[must_use]
    pub fn wait_response(&self, timeout: Duration) -> Option<SessionResponse> {
        let deadline = Instant::now() + timeout;
        let mut guard = self.shared.queues.lock().ok()?;
        loop {
            if let Some(resp) = guard.responses.pop_front() {
                self.shared.resp_cv.notify_one();
                return Some(resp);
            }
            if guard.stopped && guard.commands.is_empty() {
                return None;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let (next_guard, _) = self.shared.resp_cv.wait_timeout(guard, remaining).ok()?;
            guard = next_guard;
        }
    }

    /// Stop the worker thread cleanly and wait for it to finish.
    pub fn stop_and_wait(&self) {
        if let Ok(mut guard) = self.shared.queues.lock() {
            guard.stopped = true;
            self.shared.cmd_cv.notify_all();
            self.shared.resp_cv.notify_all();
        }
        if let Ok(mut handle_guard) = self.handle.lock() {
            if let Some(join) = handle_guard.take() {
                let _ = join.join();
            }
        }
    }
}

impl Drop for SessionWorker {
    fn drop(&mut self) {
        self.stop_and_wait();
    }
}

fn run_worker_loop(mut sessions: Sessions, shared: Arc<WorkerShared>) {
    loop {
        let next_cmd = {
            let Ok(mut guard) = shared.queues.lock() else {
                return;
            };
            while guard.commands.is_empty() && !guard.stopped {
                let Ok(next) = shared.cmd_cv.wait(guard) else {
                    return;
                };
                guard = next;
            }
            if guard.stopped && guard.commands.is_empty() {
                return;
            }
            guard.commands.pop_front()
        };

        let Some(queued) = next_cmd else {
            continue;
        };

        let resp = execute_session_command(&mut sessions, queued.request_id, queued.command);

        let Ok(mut guard) = shared.queues.lock() else {
            return;
        };
        while guard.responses.len() >= MAX_PENDING_SESSION_RESPONSES && !guard.stopped {
            let Ok(next) = shared.resp_cv.wait(guard) else {
                return;
            };
            guard = next;
        }
        if guard.stopped && guard.responses.len() >= MAX_PENDING_SESSION_RESPONSES {
            guard.responses.pop_front();
        }
        guard.responses.push_back(resp);
        shared.resp_cv.notify_all();
    }
}

fn execute_session_command(
    sessions: &mut Sessions,
    request_id: u64,
    command: SessionCommand,
) -> SessionResponse {
    let now = now_epoch_ms();
    match command {
        SessionCommand::Refresh => match sessions.refresh() {
            Ok(snap) => SessionResponse {
                request_id,
                snapshot: Some(snap),
                session: None,
                error: None,
            },
            Err(err) => SessionResponse {
                request_id,
                snapshot: None,
                session: None,
                error: Some(err),
            },
        },
        SessionCommand::FirstPage => match sessions.first_page() {
            Ok(snap) => SessionResponse {
                request_id,
                snapshot: Some(snap),
                session: None,
                error: None,
            },
            Err(err) => SessionResponse {
                request_id,
                snapshot: None,
                session: None,
                error: Some(err),
            },
        },
        SessionCommand::NextPage => match sessions.next_page() {
            Ok(snap) => SessionResponse {
                request_id,
                snapshot: Some(snap),
                session: None,
                error: None,
            },
            Err(err) => SessionResponse {
                request_id,
                snapshot: None,
                session: None,
                error: Some(err),
            },
        },
        SessionCommand::PrevPage => match sessions.prev_page() {
            Ok(snap) => SessionResponse {
                request_id,
                snapshot: Some(snap),
                session: None,
                error: None,
            },
            Err(err) => SessionResponse {
                request_id,
                snapshot: None,
                session: None,
                error: Some(err),
            },
        },
        SessionCommand::Page { limit, cursor } => match sessions.go_to_page(limit, cursor) {
            Ok(snap) => SessionResponse {
                request_id,
                snapshot: Some(snap),
                session: None,
                error: None,
            },
            Err(err) => SessionResponse {
                request_id,
                snapshot: None,
                session: None,
                error: Some(err),
            },
        },
        SessionCommand::Create(req) => match sessions.create_session(req, now) {
            Ok((created, snap)) => SessionResponse {
                request_id,
                snapshot: Some(snap),
                session: Some(created),
                error: None,
            },
            Err(err) => SessionResponse {
                request_id,
                snapshot: None,
                session: None,
                error: Some(err),
            },
        },
        SessionCommand::Select {
            session_id,
            receipt_id,
        } => match sessions.select_session(&session_id, receipt_id.as_deref(), now) {
            Ok((selected, snap)) => SessionResponse {
                request_id,
                snapshot: Some(snap),
                session: Some(selected),
                error: None,
            },
            Err(err) => SessionResponse {
                request_id,
                snapshot: None,
                session: None,
                error: Some(err),
            },
        },
        SessionCommand::UpdateSettings(req) => match sessions.update_settings(req, now) {
            Ok((updated, snap)) => SessionResponse {
                request_id,
                snapshot: Some(snap),
                session: Some(updated),
                error: None,
            },
            Err(err) => SessionResponse {
                request_id,
                snapshot: None,
                session: None,
                error: Some(err),
            },
        },
        SessionCommand::Delete { session_id } => match sessions.delete_session(&session_id, now) {
            Ok(snap) => SessionResponse {
                request_id,
                snapshot: Some(snap),
                session: None,
                error: None,
            },
            Err(err) => SessionResponse {
                request_id,
                snapshot: None,
                session: None,
                error: Some(err),
            },
        },
        SessionCommand::ApplyTurn {
            session_id,
            expected_revision,
            user_content,
            assistant_content,
            tokens_delta,
        } => match sessions.apply_turn(
            &session_id,
            expected_revision,
            user_content.as_deref(),
            assistant_content.as_deref(),
            tokens_delta,
            now,
        ) {
            Ok((updated, snap)) => SessionResponse {
                request_id,
                snapshot: Some(snap),
                session: Some(updated),
                error: None,
            },
            Err(err) => SessionResponse {
                request_id,
                snapshot: None,
                session: None,
                error: Some(err),
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_url_validation_enforces_aud12_loopback_and_authority_safety() {
        // Valid loopback HTTP and remote/loopback HTTPS URLs.
        assert_eq!(
            validate_provider_base_url("http://127.0.0.1:8790/v1").unwrap(),
            "http://127.0.0.1:8790/v1"
        );
        assert_eq!(
            validate_provider_base_url("http://localhost:11434").unwrap(),
            "http://localhost:11434"
        );
        assert_eq!(
            validate_provider_base_url("http://[::1]:8790/v1").unwrap(),
            "http://[::1]:8790/v1"
        );
        assert_eq!(
            validate_provider_base_url("https://api.example.com/v1").unwrap(),
            "https://api.example.com/v1"
        );

        let (host, port, path) =
            validate_loopback_http_url("http://[::1]:8790/v1/chat").expect("valid loopback");
        assert_eq!(host, "::1");
        assert_eq!(port, 8790);
        assert_eq!(path, "/v1/chat");

        // Negative cases: LAN, metadata, public cleartext HTTP, userinfo, query/fragment, bad ports.
        for bad in [
            "",
            "ftp://127.0.0.1:8790",
            "http://169.254.169.254/latest/meta-data",
            "http://192.168.1.50:8080/v1",
            "http://10.0.0.1:8000/v1",
            "http://api.example.com/v1",
            "http://127.0.0.2:8790/v1",
            "http://0.0.0.0:8790/v1",
            "http://user:dummy@127.0.0.1:8790/v1",
            "https://user@api.example.com/v1",
            "https://169.254.169.254/v1",
            "https://0.0.0.0/v1",
            "https://[::]/v1",
            "https://[fe80::1]/v1",
            "https://api.example.com/v1?key=dummy",
            "https://api.example.com/v1#frag",
            "http://127.0.0.1:0/v1",
            "http://127.0.0.1:08790/v1",
            "http://127.0.0.1:70000/v1",
            "http://127.0.0.1:/v1",
            "http://[::1/v1",
            "https:///v1",
            "http://127.0.0.1:8790/v1\r\nHost: evil.example",
        ] {
            assert!(
                validate_provider_base_url(bad).is_err(),
                "must reject invalid/unsafe provider base_url: {bad:?}"
            );
        }

        // Loopback HTTP parser also rejects HTTPS so transport matches admission.
        assert!(validate_loopback_http_url("https://127.0.0.1:8790/v1").is_err());
    }
}
