//! Native contract for an input channel that is scoped to one captured target.
//!
//! This module deliberately stops at the capability/lifecycle boundary.  It
//! does not install a global keyboard hook, move the user's desktop pointer,
//! or inject arbitrary native messages.  A future platform backend must prove
//! that it can route events to the leased target without taking ownership of
//! the host user's input before these commands can return an active channel.

use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::{
    error::{NativeError, NativeResult},
    state::AppState,
};

pub const ISOLATED_INPUT_SCHEMA_VERSION: u32 = 1;
const MAX_ID_BYTES: usize = 512;
const MAX_RECEIPT_BYTES: usize = 512;
const MAX_TEXT_BYTES: usize = 4_096;

const MAX_LEASE_MS: u64 = 30 * 60 * 1_000;
const MIN_LEASE_MS: u64 = 1_000;
const MAX_EVENT_COORDINATE: f64 = 100_000.0;
const MAX_EVENT_DELTA: f64 = 100_000.0;
const MAX_KEY_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum IsolatedInputCapability {
    DetachedInput,
    CursorOverlay,
    FrameCapture,
    UnfocusedCapture,
    HeadlessCapture,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IsolatedInputTargetKind {
    Process,
    Window,
    Surface,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IsolatedInputMode {
    Visible,
    Unfocused,
    Headless,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IsolatedInputSessionState {
    Starting,
    Active,
    Paused,
    Stopped,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IsolatedInputChannelState {
    Active,
    Paused,
    Closed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IsolatedInputAvailability {
    Available,
    Degraded,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IsolatedInputPointerPhase {
    Move,
    Down,
    Up,
    Wheel,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IsolatedInputPointerButton {
    Left,
    Middle,
    Right,
    Back,
    Forward,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IsolatedInputKeyboardPhase {
    Down,
    Up,
    Text,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum IsolatedInputModifier {
    Alt,
    Ctrl,
    Meta,
    Shift,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)] // wire-schema fields validated at deserialization; adapter does not consume them yet
pub enum IsolatedInputEvent {
    Pointer {
        phase: IsolatedInputPointerPhase,
        x: f64,
        y: f64,
        #[serde(default)]
        button: Option<IsolatedInputPointerButton>,
        #[serde(default)]
        delta_x: Option<f64>,
        #[serde(default)]
        delta_y: Option<f64>,
        #[serde(default)]
        modifiers: Vec<IsolatedInputModifier>,
    },
    Keyboard {
        phase: IsolatedInputKeyboardPhase,
        code: String,
        key: String,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        modifiers: Vec<IsolatedInputModifier>,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)] // wire-schema fields validated at deserialization; adapter does not consume them yet
pub struct IsolatedInputSessionCreateRequest {
    pub target_kind: IsolatedInputTargetKind,
    /// Opaque target reference issued by a native surface enumerator.  The
    /// broker never interprets this as a process command line or path.
    pub target_ref: String,
    pub mode: IsolatedInputMode,
    pub lease_ms: u64,
    pub user_authorized: bool,
    pub authorization_receipt_id: String,
    #[serde(default)]
    pub requested_capabilities: Vec<IsolatedInputCapability>,
    #[serde(default)]
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IsolatedInputSessionReadRequest {
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IsolatedInputSessionStopRequest {
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IsolatedInputEventSendRequest {
    pub channel_id: String,
    pub event: IsolatedInputEvent,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IsolatedInputChannelAttachRequest {
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IsolatedInputChannelDetachRequest {
    pub channel_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolatedInputCapabilityDescriptor {
    pub capability: IsolatedInputCapability,
    pub availability: IsolatedInputAvailability,
    pub reason: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolatedInputCapabilitiesReceipt {
    pub schema_version: u32,
    pub capability_snapshot_id: String,
    pub platform: &'static str,
    pub backend: &'static str,
    pub capabilities: Vec<IsolatedInputCapabilityDescriptor>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolatedInputSessionReceipt {
    pub schema_version: u32,
    pub session_id: String,
    pub target_kind: IsolatedInputTargetKind,
    pub mode: IsolatedInputMode,
    pub state: IsolatedInputSessionState,
    pub routing: &'static str,
    pub expires_at: String,
    pub capabilities: Vec<IsolatedInputCapability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_code: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolatedInputChannelReceipt {
    pub schema_version: u32,
    pub channel_id: String,
    pub session_id: String,
    pub target_kind: IsolatedInputTargetKind,
    pub state: IsolatedInputChannelState,
    pub routing: &'static str,
    pub cursor: &'static str,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolatedInputEventReceipt {
    pub accepted: bool,
    pub channel_id: String,
    pub reason: &'static str,
}

#[derive(Clone, Debug)]
struct InputSession {
    session_id: String,
    target_kind: IsolatedInputTargetKind,
    mode: IsolatedInputMode,
    state: IsolatedInputSessionState,
    expires_at: SystemTime,
    capabilities: Vec<IsolatedInputCapability>,
    channel_id: Option<String>,
    last_error_code: Option<&'static str>,
}

#[derive(Clone, Debug)]
struct InputChannel {
    channel_id: String,
    session_id: String,
    target_kind: IsolatedInputTargetKind,
    state: IsolatedInputChannelState,
    created_at: SystemTime,
}

#[derive(Default)]
struct BrokerInner {
    sessions: std::collections::BTreeMap<String, InputSession>,
    channels: std::collections::BTreeMap<String, InputChannel>,
}

/// Native-owned lease registry.  It is intentionally inert until a platform
/// backend can provide detached routing and a visible capture surface.
#[derive(Clone, Default)]
pub struct IsolatedInputBroker {
    inner: Arc<Mutex<BrokerInner>>,
}

impl IsolatedInputBroker {
    fn lock(&self) -> NativeResult<MutexGuard<'_, BrokerInner>> {
        self.inner.lock().map_err(|_| {
            NativeError::new(
                "isolated_input_unavailable",
                "The isolated input registry is unavailable",
            )
        })
    }

    fn expire_stale(inner: &mut BrokerInner, now: SystemTime) {
        for session in inner.sessions.values_mut() {
            if matches!(
                session.state,
                IsolatedInputSessionState::Starting | IsolatedInputSessionState::Active
            ) && session.expires_at <= now
            {
                session.state = IsolatedInputSessionState::Stopped;
                session.last_error_code = Some("lease_expired");
                if let Some(channel_id) = session.channel_id.take() {
                    inner.channels.remove(&channel_id);
                }
            }
        }
    }

    fn capabilities() -> IsolatedInputCapabilitiesReceipt {
        let platform = if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else {
            "unknown"
        };
        let reason = "No detached native input/capture backend is installed";
        let capabilities = [
            IsolatedInputCapability::DetachedInput,
            IsolatedInputCapability::CursorOverlay,
            IsolatedInputCapability::FrameCapture,
            IsolatedInputCapability::UnfocusedCapture,
            IsolatedInputCapability::HeadlessCapture,
        ]
        .into_iter()
        .map(|capability| IsolatedInputCapabilityDescriptor {
            capability,
            availability: IsolatedInputAvailability::Unavailable,
            reason,
        })
        .collect();
        IsolatedInputCapabilitiesReceipt {
            schema_version: ISOLATED_INPUT_SCHEMA_VERSION,
            capability_snapshot_id: format!("cap-{}", Uuid::new_v4()),
            platform,
            backend: "none",
            capabilities,
        }
    }

    fn create(
        &self,
        request: IsolatedInputSessionCreateRequest,
    ) -> NativeResult<IsolatedInputSessionReceipt> {
        validate_create_request(&request)?;
        // Do not create a session that claims to control a target when no
        // backend can enforce the independent-input invariant.
        Err(NativeError::new(
            "unsupported_capability",
            "Detached input is unavailable on this runtime",
        ))
    }

    fn read(
        &self,
        request: IsolatedInputSessionReadRequest,
    ) -> NativeResult<IsolatedInputSessionReceipt> {
        validate_id(&request.session_id, "sessionId", MAX_ID_BYTES)?;
        let now = SystemTime::now();
        let mut inner = self.lock()?;
        Self::expire_stale(&mut inner, now);
        let session = inner.sessions.get(&request.session_id).ok_or_else(|| {
            NativeError::new("not_found", "The isolated input session was not found")
        })?;
        Ok(session_receipt(session))
    }

    fn stop(
        &self,
        request: IsolatedInputSessionStopRequest,
    ) -> NativeResult<IsolatedInputSessionReceipt> {
        validate_id(&request.session_id, "sessionId", MAX_ID_BYTES)?;
        let mut inner = self.lock()?;
        let channel_id = {
            let session = inner.sessions.get_mut(&request.session_id).ok_or_else(|| {
                NativeError::new("not_found", "The isolated input session was not found")
            })?;
            session.state = IsolatedInputSessionState::Stopped;
            session.channel_id.take()
        };
        if let Some(channel_id) = channel_id {
            inner.channels.remove(&channel_id);
        }
        let session = inner
            .sessions
            .get(&request.session_id)
            .expect("session remains after stop");
        Ok(session_receipt(session))
    }

    fn attach(
        &self,
        request: IsolatedInputChannelAttachRequest,
    ) -> NativeResult<IsolatedInputChannelReceipt> {
        validate_id(&request.session_id, "sessionId", MAX_ID_BYTES)?;
        Err(NativeError::new(
            "unsupported_capability",
            "Independent input is unavailable on this runtime",
        ))
    }

    fn detach(
        &self,
        request: IsolatedInputChannelDetachRequest,
    ) -> NativeResult<IsolatedInputEventReceipt> {
        validate_id(&request.channel_id, "channelId", MAX_ID_BYTES)?;
        let mut inner = self.lock()?;
        let Some(channel) = inner.channels.remove(&request.channel_id) else {
            return Ok(IsolatedInputEventReceipt {
                accepted: false,
                channel_id: request.channel_id,
                reason: "channel_not_found",
            });
        };
        if let Some(session) = inner.sessions.get_mut(&channel.session_id) {
            session.channel_id = None;
        }
        Ok(IsolatedInputEventReceipt {
            accepted: true,
            channel_id: request.channel_id,
            reason: "detached",
        })
    }

    fn send(
        &self,
        request: IsolatedInputEventSendRequest,
    ) -> NativeResult<IsolatedInputEventReceipt> {
        validate_id(&request.channel_id, "channelId", MAX_ID_BYTES)?;
        validate_event(&request.event)?;
        Err(NativeError::new(
            "unsupported_capability",
            "Independent input is unavailable on this runtime",
        ))
    }
}

#[tauri::command]
pub fn isolated_input_capabilities() -> NativeResult<IsolatedInputCapabilitiesReceipt> {
    Ok(IsolatedInputBroker::capabilities())
}

#[tauri::command]
pub fn isolated_input_session_create(
    state: State<'_, AppState>,
    request: IsolatedInputSessionCreateRequest,
) -> NativeResult<IsolatedInputSessionReceipt> {
    state.isolated_input.create(request)
}

#[tauri::command]
pub fn isolated_input_session_read(
    state: State<'_, AppState>,
    request: IsolatedInputSessionReadRequest,
) -> NativeResult<IsolatedInputSessionReceipt> {
    state.isolated_input.read(request)
}

#[tauri::command]
pub fn isolated_input_session_stop(
    state: State<'_, AppState>,
    request: IsolatedInputSessionStopRequest,
) -> NativeResult<IsolatedInputSessionReceipt> {
    state.isolated_input.stop(request)
}

#[tauri::command]
pub fn isolated_input_channel_attach(
    state: State<'_, AppState>,
    request: IsolatedInputChannelAttachRequest,
) -> NativeResult<IsolatedInputChannelReceipt> {
    state.isolated_input.attach(request)
}

#[tauri::command]
pub fn isolated_input_channel_detach(
    state: State<'_, AppState>,
    request: IsolatedInputChannelDetachRequest,
) -> NativeResult<IsolatedInputEventReceipt> {
    state.isolated_input.detach(request)
}

#[tauri::command]
pub fn isolated_input_event_send(
    state: State<'_, AppState>,
    request: IsolatedInputEventSendRequest,
) -> NativeResult<IsolatedInputEventReceipt> {
    state.isolated_input.send(request)
}

fn validate_create_request(request: &IsolatedInputSessionCreateRequest) -> NativeResult<()> {
    validate_id(&request.target_ref, "targetRef", MAX_ID_BYTES)?;
    validate_id(
        &request.authorization_receipt_id,
        "authorizationReceiptId",
        MAX_RECEIPT_BYTES,
    )?;
    if let Some(run_id) = &request.run_id {
        validate_id(run_id, "runId", MAX_ID_BYTES)?;
    }
    if !request.user_authorized {
        return Err(NativeError::new(
            "permission_denied",
            "An explicit user authorization receipt is required",
        ));
    }
    if !(MIN_LEASE_MS..=MAX_LEASE_MS).contains(&request.lease_ms) {
        return Err(NativeError::invalid(
            "leaseMs",
            format!("must be between {MIN_LEASE_MS} and {MAX_LEASE_MS}"),
        ));
    }
    let mut capabilities = BTreeSet::new();
    for capability in &request.requested_capabilities {
        if !capabilities.insert(*capability) {
            return Err(NativeError::invalid(
                "requestedCapabilities",
                "must not contain duplicates",
            ));
        }
    }
    Ok(())
}

fn validate_id(value: &str, field: &'static str, max_bytes: usize) -> NativeResult<()> {
    if value.trim().is_empty() || value.len() > max_bytes || !value.is_char_boundary(value.len()) {
        return Err(NativeError::invalid(field, "must be non-empty and bounded"));
    }
    Ok(())
}

fn validate_event(event: &IsolatedInputEvent) -> NativeResult<()> {
    match event {
        IsolatedInputEvent::Pointer {
            x,
            y,
            delta_x,
            delta_y,
            modifiers,
            ..
        } => {
            validate_finite_range(*x, -MAX_EVENT_COORDINATE, MAX_EVENT_COORDINATE, "pointer.x")?;
            validate_finite_range(*y, -MAX_EVENT_COORDINATE, MAX_EVENT_COORDINATE, "pointer.y")?;
            if let Some(value) = delta_x {
                validate_finite_range(*value, -MAX_EVENT_DELTA, MAX_EVENT_DELTA, "pointer.deltaX")?;
            }
            if let Some(value) = delta_y {
                validate_finite_range(*value, -MAX_EVENT_DELTA, MAX_EVENT_DELTA, "pointer.deltaY")?;
            }
            validate_modifiers(modifiers)
        }
        IsolatedInputEvent::Keyboard {
            code,
            key,
            text,
            modifiers,
            ..
        } => {
            validate_id(code, "keyboard.code", MAX_KEY_BYTES)?;
            validate_id(key, "keyboard.key", MAX_KEY_BYTES)?;
            if let Some(text) = text {
                if text.len() > MAX_TEXT_BYTES {
                    return Err(NativeError::invalid(
                        "keyboard.text",
                        format!("must be at most {MAX_TEXT_BYTES} bytes"),
                    ));
                }
            }
            validate_modifiers(modifiers)
        }
    }
}

fn validate_modifiers(modifiers: &[IsolatedInputModifier]) -> NativeResult<()> {
    let mut unique = BTreeSet::new();
    for modifier in modifiers {
        if !unique.insert(*modifier) {
            return Err(NativeError::invalid(
                "modifiers",
                "must not contain duplicates",
            ));
        }
    }
    Ok(())
}

fn validate_finite_range(
    value: f64,
    minimum: f64,
    maximum: f64,
    field: &'static str,
) -> NativeResult<()> {
    if !value.is_finite() || !(minimum..=maximum).contains(&value) {
        return Err(NativeError::invalid(field, "must be finite and bounded"));
    }
    Ok(())
}

fn session_receipt(session: &InputSession) -> IsolatedInputSessionReceipt {
    IsolatedInputSessionReceipt {
        schema_version: ISOLATED_INPUT_SCHEMA_VERSION,
        session_id: session.session_id.clone(),
        target_kind: session.target_kind,
        mode: session.mode,
        state: session.state,
        routing: "independent",
        expires_at: timestamp(session.expires_at),
        capabilities: session.capabilities.clone(),
        last_error_code: session.last_error_code,
    }
}

#[allow(dead_code)]
fn channel_receipt(channel: &InputChannel) -> IsolatedInputChannelReceipt {
    IsolatedInputChannelReceipt {
        schema_version: ISOLATED_INPUT_SCHEMA_VERSION,
        channel_id: channel.channel_id.clone(),
        session_id: channel.session_id.clone(),
        target_kind: channel.target_kind,
        state: channel.state,
        routing: "independent",
        cursor: "unavailable",
        created_at: timestamp(channel.created_at),
    }
}

fn timestamp(value: SystemTime) -> String {
    let duration = value.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO);
    format!("{}.{:03}Z", duration.as_secs(), duration.subsec_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> IsolatedInputSessionCreateRequest {
        IsolatedInputSessionCreateRequest {
            target_kind: IsolatedInputTargetKind::Window,
            target_ref: "target-opaque".into(),
            mode: IsolatedInputMode::Unfocused,
            lease_ms: 10_000,
            user_authorized: true,
            authorization_receipt_id: "receipt-1".into(),
            requested_capabilities: vec![IsolatedInputCapability::DetachedInput],
            run_id: None,
        }
    }

    #[test]
    fn capabilities_are_truthful_and_fail_closed_without_backend() {
        let receipt = IsolatedInputBroker::capabilities();
        assert_eq!(receipt.backend, "none");
        assert!(receipt
            .capabilities
            .iter()
            .all(|entry| entry.availability == IsolatedInputAvailability::Unavailable));
    }

    #[test]
    fn create_requires_explicit_authorization() {
        let mut value = request();
        value.user_authorized = false;
        let error = validate_create_request(&value).expect_err("authorization must be required");
        assert_eq!(error.code, "permission_denied");
    }

    #[test]
    fn create_rejects_unbounded_lease() {
        let mut value = request();
        value.lease_ms = MAX_LEASE_MS + 1;
        let error = validate_create_request(&value).expect_err("lease must be bounded");
        assert_eq!(error.code, "invalid_input");
    }

    #[test]
    fn event_rejects_duplicate_modifiers() {
        let event = IsolatedInputEvent::Pointer {
            phase: IsolatedInputPointerPhase::Move,
            x: 1.0,
            y: 2.0,
            button: None,
            delta_x: None,
            delta_y: None,
            modifiers: vec![IsolatedInputModifier::Ctrl, IsolatedInputModifier::Ctrl],
        };
        let error = validate_event(&event).expect_err("duplicate modifiers must be rejected");
        assert_eq!(error.code, "invalid_input");
    }

    #[test]
    fn timestamp_is_bounded_iso_like_metadata_without_paths_or_handles() {
        let value = timestamp(UNIX_EPOCH + Duration::from_millis(1_234));
        assert_eq!(value, "1.234Z");
    }
}
