use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use tauri::http::HeaderMap;
use tauri::{ipc::Invoke, Runtime};
use zeroize::Zeroizing;

use crate::core_protocol::{InitializeClientInfo, PROTOCOL_VERSION};
use crate::error::{NativeError, NativeResult};

pub const SESSION_HEADER: &str = "x-omnia-session";

const SESSION_TOKEN_BYTES: usize = 32;
const SESSION_TOKEN_HEX_BYTES: usize = SESSION_TOKEN_BYTES * 2;
const MAX_SAFE_SESSION_EPOCH: u64 = (1_u64 << 53) - 1;
const PREINITIALIZE_COMMANDS: &[&str] = &["runtime_info", "core_initialize"];

struct CoreSession {
    token: Zeroizing<[u8; SESSION_TOKEN_BYTES]>,
    epoch: u64,
    _protocol_version: &'static str,
    _client_info: InitializeClientInfo,
    _capabilities: Vec<String>,
}

#[derive(Default)]
struct WebviewSessionSlot {
    epoch: u64,
    active: Option<CoreSession>,
}

#[derive(Default)]
struct CoreSessionRegistryInner {
    by_webview: BTreeMap<String, WebviewSessionSlot>,
}

/// Ephemeral, native-owned lifecycle sessions for Omnia application IPC.
///
/// A session proves only that one exact webview document completed protocol
/// negotiation. It is not durable user authentication, does not grant any
/// capability, and must never be persisted or written to diagnostics.
#[derive(Clone, Default)]
pub struct CoreSessionRegistry {
    inner: Arc<Mutex<CoreSessionRegistryInner>>,
}

#[derive(Clone)]
pub struct EstablishedCoreSession {
    pub token: String,
    pub epoch: u64,
}

impl std::fmt::Debug for EstablishedCoreSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EstablishedCoreSession")
            .field("token", &"[redacted]")
            .field("epoch", &self.epoch)
            .finish()
    }
}

impl CoreSessionRegistry {
    pub fn establish(
        &self,
        webview_label: &str,
        client_info: InitializeClientInfo,
        capabilities: Vec<String>,
    ) -> NativeResult<EstablishedCoreSession> {
        validate_webview_label(webview_label)?;

        let mut inner = self.lock_inner()?;
        let slot = inner
            .by_webview
            .entry(webview_label.to_owned())
            .or_default();
        if slot.active.is_some() {
            return Err(NativeError::new(
                "already_initialized",
                "Omnia Core is already initialized for this webview document",
            ));
        }

        if slot.epoch == 0 {
            slot.epoch = 1;
        }
        if slot.epoch > MAX_SAFE_SESSION_EPOCH {
            return Err(session_state_unavailable());
        }

        let epoch = slot.epoch;
        let token = generate_session_token(epoch)?;
        let encoded_token = hex_encode(&token[..]);
        slot.active = Some(CoreSession {
            token,
            epoch,
            _protocol_version: PROTOCOL_VERSION,
            _client_info: client_info,
            _capabilities: capabilities,
        });

        Ok(EstablishedCoreSession {
            token: encoded_token,
            epoch,
        })
    }

    pub fn authorize(&self, webview_label: &str, session_header: Option<&str>) -> NativeResult<()> {
        validate_webview_label(webview_label)?;
        let inner = self.lock_inner()?;
        let slot = inner.by_webview.get(webview_label);

        let Some(token) = session_header else {
            return Err(if slot.and_then(|slot| slot.active.as_ref()).is_some() {
                core_session_invalid()
            } else {
                core_not_initialized()
            });
        };
        let supplied = decode_session_token(token)?;
        let supplied_epoch = token_epoch(&supplied)?;

        let Some(slot) = slot else {
            return Err(core_session_invalid());
        };
        if supplied_epoch < slot.epoch {
            return Err(core_session_stale());
        }
        if supplied_epoch > slot.epoch {
            return Err(core_session_invalid());
        }

        let Some(session) = slot.active.as_ref() else {
            return Err(core_session_invalid());
        };
        if session.epoch != slot.epoch || !constant_time_eq(&session.token[..], &supplied[..]) {
            return Err(core_session_invalid());
        }

        Ok(())
    }

    /// Invalidate the active document and advance its native epoch.
    pub fn invalidate(&self, webview_label: &str) -> NativeResult<()> {
        validate_webview_label(webview_label)?;
        let mut inner = self.lock_inner()?;
        let slot = inner
            .by_webview
            .entry(webview_label.to_owned())
            .or_default();
        slot.active = None;
        slot.epoch = match slot.epoch {
            0 => 1,
            current => current
                .checked_add(1)
                .filter(|epoch| *epoch <= MAX_SAFE_SESSION_EPOCH)
                .ok_or_else(session_state_unavailable)?,
        };
        Ok(())
    }

    fn lock_inner(&self) -> NativeResult<MutexGuard<'_, CoreSessionRegistryInner>> {
        self.inner.lock().map_err(|_| session_state_unavailable())
    }

    #[cfg(test)]
    fn session_for(&self, webview_label: &str) -> Option<EstablishedCoreSession> {
        self.inner.lock().ok().and_then(|inner| {
            inner
                .by_webview
                .get(webview_label)
                .and_then(|slot| slot.active.as_ref())
                .map(|session| EstablishedCoreSession {
                    token: hex_encode(&session.token[..]),
                    epoch: session.epoch,
                })
        })
    }
}

/// Wrap every Omnia application command with the initialized-session gate.
///
/// Tauri plugin commands have separate plugin handlers and ACL permissions;
/// this wrapper intentionally governs the application commands registered by
/// Omnia's `Builder::invoke_handler` only.
pub fn session_guarded_handler<R: Runtime>(
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let command = invoke.message.command();
        if !command_requires_core_session(command) {
            return handler(invoke);
        }

        let webview_label = invoke.message.webview_ref().label().to_owned();
        let session_header = match extract_session_header(invoke.message.headers()) {
            Ok(value) => value,
            Err(error) => {
                invoke.resolver.reject(error);
                return true;
            }
        };
        let Some(registry) = invoke.message.state_ref().try_get::<CoreSessionRegistry>() else {
            invoke.resolver.reject(session_state_unavailable());
            return true;
        };

        match registry.authorize(&webview_label, session_header) {
            Ok(()) => handler(invoke),
            Err(error) => {
                invoke.resolver.reject(error);
                true
            }
        }
    }
}

pub fn command_requires_core_session(command: &str) -> bool {
    !PREINITIALIZE_COMMANDS.contains(&command)
}

pub fn handle_page_load_started(
    registry: &CoreSessionRegistry,
    webview_label: &str,
) -> NativeResult<()> {
    registry.invalidate(webview_label)
}

fn extract_session_header(headers: &HeaderMap) -> NativeResult<Option<&str>> {
    let mut values = headers.get_all(SESSION_HEADER).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(core_session_invalid());
    }
    value.to_str().map(Some).map_err(|_| core_session_invalid())
}

fn generate_session_token(epoch: u64) -> NativeResult<Zeroizing<[u8; SESSION_TOKEN_BYTES]>> {
    let mut token = Zeroizing::new([0_u8; SESSION_TOKEN_BYTES]);
    token[..8].copy_from_slice(&epoch.to_be_bytes());
    getrandom::fill(&mut token[8..]).map_err(|_| {
        NativeError::new(
            "core_session_unavailable",
            "Omnia Core could not create a secure IPC session",
        )
    })?;
    Ok(token)
}

fn token_epoch(token: &[u8; SESSION_TOKEN_BYTES]) -> NativeResult<u64> {
    let mut encoded = [0_u8; 8];
    encoded.copy_from_slice(&token[..8]);
    let epoch = u64::from_be_bytes(encoded);
    if epoch == 0 || epoch > MAX_SAFE_SESSION_EPOCH {
        return Err(core_session_invalid());
    }
    Ok(epoch)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn decode_session_token(token: &str) -> NativeResult<Zeroizing<[u8; SESSION_TOKEN_BYTES]>> {
    if token.len() != SESSION_TOKEN_HEX_BYTES
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(core_session_invalid());
    }

    let encoded = token.as_bytes();
    let mut decoded = Zeroizing::new([0_u8; SESSION_TOKEN_BYTES]);
    for (index, output) in decoded.iter_mut().enumerate() {
        let high = decode_hex_digit(encoded[index * 2]).ok_or_else(core_session_invalid)?;
        let low = decode_hex_digit(encoded[index * 2 + 1]).ok_or_else(core_session_invalid)?;
        *output = (high << 4) | low;
    }
    Ok(decoded)
}

fn decode_hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn validate_webview_label(label: &str) -> NativeResult<()> {
    if label.is_empty()
        || label.len() > 128
        || label
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(NativeError::new(
            "core_session_unavailable",
            "Omnia Core cannot bind an IPC session to this webview",
        ));
    }
    Ok(())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn core_not_initialized() -> NativeError {
    NativeError::new(
        "core_not_initialized",
        "Initialize Omnia Core before invoking application commands",
    )
}

fn core_session_invalid() -> NativeError {
    NativeError::new(
        "core_session_invalid",
        "The Omnia Core session is missing or invalid",
    )
}

fn core_session_stale() -> NativeError {
    NativeError::new(
        "core_session_stale",
        "The Omnia Core session belongs to an earlier webview document",
    )
}

pub(crate) fn session_state_unavailable() -> NativeError {
    NativeError::new(
        "core_session_unavailable",
        "Omnia Core IPC session state is unavailable",
    )
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::{Arc, Barrier};
    use std::thread;

    use serde_json::json;
    use tauri::http::{HeaderMap, HeaderValue};
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    use super::*;

    #[tauri::command]
    fn protected_ping() -> &'static str {
        "pong"
    }

    #[tauri::command]
    fn runtime_info() -> &'static str {
        "runtime"
    }

    #[tauri::command]
    fn core_initialize() -> &'static str {
        "initialize"
    }

    fn test_app(manage_registry: bool) -> tauri::App<tauri::test::MockRuntime> {
        let handler = session_guarded_handler(tauri::generate_handler![
            protected_ping,
            runtime_info,
            core_initialize
        ]);
        let mut builder = mock_builder().invoke_handler(handler);
        if manage_registry {
            builder = builder.manage(CoreSessionRegistry::default());
        }
        let app = builder
            .build(mock_context(noop_assets()))
            .expect("mock app should build");
        WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .expect("main webview should build");
        app
    }

    fn invoke_request(command: &str, headers: HeaderMap) -> InvokeRequest {
        InvokeRequest {
            cmd: command.to_owned(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost"
                .parse()
                .expect("test origin should parse"),
            body: InvokeBody::Json(json!({})),
            headers,
            invoke_key: INVOKE_KEY.to_owned(),
        }
    }

    fn headers_with_session(session_token: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(session_token) = session_token {
            headers.insert(
                SESSION_HEADER,
                HeaderValue::from_str(session_token).expect("test token should be a header value"),
            );
        }
        headers
    }

    fn invoke_command(
        app: &tauri::App<tauri::test::MockRuntime>,
        command: &str,
        headers: HeaderMap,
    ) -> Result<InvokeResponseBody, serde_json::Value> {
        let webview = app
            .get_webview_window("main")
            .expect("main webview should exist");
        get_ipc_response(&webview, invoke_request(command, headers))
    }

    fn client_info(name: &str) -> InitializeClientInfo {
        InitializeClientInfo {
            name: name.to_owned(),
            title: "Omnia Desktop".to_owned(),
            version: "0.1.0".to_owned(),
        }
    }

    fn establish(registry: &CoreSessionRegistry, label: &str) -> EstablishedCoreSession {
        registry
            .establish(label, client_info(label), vec!["run.stream.v1".to_owned()])
            .expect("session should be established")
    }

    fn mutate_token(token: &str) -> String {
        let mut bytes = token.as_bytes().to_vec();
        let index = bytes.len() - 1;
        bytes[index] = if bytes[index] == b'a' { b'b' } else { b'a' };
        String::from_utf8(bytes).expect("mutated token should remain ASCII")
    }

    #[test]
    fn request_before_initialize_is_rejected() {
        let registry = CoreSessionRegistry::default();
        let error = registry
            .authorize("main", None)
            .expect_err("missing session must fail closed");
        assert_eq!(error.code, "core_not_initialized");
    }

    #[test]
    fn request_before_initialize_is_rejected_at_the_transport_boundary() {
        let app = test_app(true);
        let error = invoke_command(&app, "protected_ping", headers_with_session(None))
            .expect_err("guard must reject pre-initialize invoke");
        assert_eq!(error["code"], "core_not_initialized");
    }

    #[test]
    fn missing_managed_registry_fails_closed_without_panicking() {
        let app = test_app(false);
        let error = invoke_command(&app, "protected_ping", headers_with_session(None))
            .expect_err("missing managed state must fail closed");
        assert_eq!(error["code"], "core_session_unavailable");
    }

    #[test]
    fn correct_session_reaches_registered_command() {
        let app = test_app(true);
        let session = establish(&app.state::<CoreSessionRegistry>(), "main");
        let response = invoke_command(
            &app,
            "protected_ping",
            headers_with_session(Some(&session.token)),
        )
        .expect("correct session should reach command")
        .deserialize::<String>()
        .expect("ping response should deserialize");
        assert_eq!(response, "pong");
    }

    #[test]
    fn missing_session_after_initialize_is_rejected_as_invalid() {
        let app = test_app(true);
        establish(&app.state::<CoreSessionRegistry>(), "main");

        let error = invoke_command(&app, "protected_ping", headers_with_session(None))
            .expect_err("an initialized document must present its session");
        assert_eq!(error["code"], "core_session_invalid");
    }

    #[test]
    fn runtime_info_and_core_initialize_are_allowed_before_initialize() {
        let app = test_app(true);
        for (command, expected) in [
            ("runtime_info", "runtime"),
            ("core_initialize", "initialize"),
        ] {
            let response = invoke_command(&app, command, headers_with_session(None))
                .expect("pre-initialize command should reach its handler")
                .deserialize::<String>()
                .expect("response should deserialize");
            assert_eq!(response, expected);
        }
    }

    #[test]
    fn malformed_non_utf8_session_header_is_rejected_as_invalid() {
        let app = test_app(true);
        let mut headers = HeaderMap::new();
        headers.insert(
            SESSION_HEADER,
            HeaderValue::from_bytes(&[0x80]).expect("opaque header byte should be accepted"),
        );
        let error = invoke_command(&app, "protected_ping", headers)
            .expect_err("non-UTF8 session header must fail closed");
        assert_eq!(error["code"], "core_session_invalid");
    }

    #[test]
    fn duplicate_session_headers_are_rejected_as_ambiguous() {
        let app = test_app(true);
        let session = establish(&app.state::<CoreSessionRegistry>(), "main");
        let mut headers = headers_with_session(Some(&session.token));
        headers.append(
            SESSION_HEADER,
            HeaderValue::from_str(&session.token).expect("test token should be a header value"),
        );

        let error = invoke_command(&app, "protected_ping", headers)
            .expect_err("duplicate session headers must fail closed");
        assert_eq!(error["code"], "core_session_invalid");
    }

    #[test]
    fn initialize_creates_one_opaque_webview_bound_session() {
        let registry = CoreSessionRegistry::default();
        let session = establish(&registry, "main");

        assert_eq!(session.token.len(), SESSION_TOKEN_HEX_BYTES);
        assert!(session
            .token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        assert_eq!(session.epoch, 1);
        registry
            .authorize("main", Some(&session.token))
            .expect("owning webview should be authorized");

        let error = registry
            .authorize("secondary", Some(&session.token))
            .expect_err("another webview must not reuse the session");
        assert_eq!(error.code, "core_session_invalid");
    }

    #[test]
    fn repeated_initialize_on_active_session_is_rejected() {
        let registry = CoreSessionRegistry::default();
        let first = establish(&registry, "main");
        let error = registry
            .establish(
                "main",
                client_info("second-client"),
                vec!["run.stream.v1".to_owned()],
            )
            .expect_err("initialize must be single-use per active webview epoch");
        assert_eq!(error.code, "already_initialized");
        assert_eq!(registry.session_for("main").unwrap().token, first.token);
    }

    #[test]
    fn missing_malformed_unknown_and_cross_webview_sessions_are_rejected() {
        let registry = CoreSessionRegistry::default();
        let main = establish(&registry, "main");
        let secondary = establish(&registry, "secondary");

        assert_eq!(
            registry.authorize("main", None).unwrap_err().code,
            "core_session_invalid"
        );
        assert_eq!(
            registry
                .authorize("main", Some("not-a-token"))
                .unwrap_err()
                .code,
            "core_session_invalid"
        );
        let unknown = mutate_token(&main.token);
        assert_eq!(
            registry.authorize("main", Some(&unknown)).unwrap_err().code,
            "core_session_invalid"
        );
        assert_eq!(
            registry
                .authorize("main", Some(&secondary.token))
                .unwrap_err()
                .code,
            "core_session_invalid"
        );
        registry
            .authorize("main", Some(&main.token))
            .expect("correct session should remain active");
    }

    #[test]
    fn page_reload_invalidates_previous_session_and_advances_epoch() {
        let registry = CoreSessionRegistry::default();
        let first = establish(&registry, "main");
        registry
            .invalidate("main")
            .expect("reload invalidation should succeed");

        let error = registry
            .authorize("main", Some(&first.token))
            .expect_err("old document session must be stale");
        assert_eq!(error.code, "core_session_stale");

        let second = establish(&registry, "main");
        assert_eq!(second.epoch, first.epoch + 1);
        assert_ne!(second.token, first.token);
        assert_eq!(
            registry
                .authorize("main", Some(&first.token))
                .unwrap_err()
                .code,
            "core_session_stale"
        );
        registry
            .authorize("main", Some(&second.token))
            .expect("new document session should be active");
    }

    #[test]
    fn stale_reload_session_is_rejected_at_the_transport_boundary() {
        let app = test_app(true);
        let session = establish(&app.state::<CoreSessionRegistry>(), "main");
        handle_page_load_started(&app.state::<CoreSessionRegistry>(), "main")
            .expect("page-load invalidation should succeed");

        let error = invoke_command(
            &app,
            "protected_ping",
            headers_with_session(Some(&session.token)),
        )
        .expect_err("stale document token must fail closed");
        assert_eq!(error["code"], "core_session_stale");
    }

    #[test]
    fn error_never_echoes_session_token() {
        let registry = CoreSessionRegistry::default();
        let session = establish(&registry, "main");
        let foreign = establish(&registry, "secondary");
        let error = registry
            .authorize("main", Some(&foreign.token))
            .expect_err("foreign session must fail closed");
        let serialized = serde_json::to_string(&error).expect("error should serialize");

        assert!(!serialized.contains(&session.token));
        assert!(!serialized.contains(&foreign.token));
    }

    #[test]
    fn concurrent_initialize_has_exactly_one_winner() {
        const CONTENDERS: usize = 16;
        let registry = CoreSessionRegistry::default();
        let barrier = Arc::new(Barrier::new(CONTENDERS));
        let mut handles = Vec::new();

        for index in 0..CONTENDERS {
            let registry = registry.clone();
            let barrier = barrier.clone();
            handles.push(thread::spawn(move || {
                barrier.wait();
                registry.establish(
                    "main",
                    client_info(&format!("client-{index}")),
                    vec!["run.stream.v1".to_owned()],
                )
            }));
        }

        let outcomes = handles
            .into_iter()
            .map(|handle| handle.join().expect("contender should not panic"))
            .collect::<Vec<_>>();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);

        let error_codes = outcomes
            .iter()
            .filter_map(|outcome| outcome.as_ref().err().map(|error| error.code))
            .collect::<BTreeSet<_>>();
        assert_eq!(error_codes, BTreeSet::from(["already_initialized"]));
    }
}
