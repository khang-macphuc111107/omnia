//! OpenCode compatibility contracts: SSE event stream normalization,
//! permission prompt/reply normalization, `/v1/responses` MCP namespace
//! restoration, strict URL/path validation, and truthful availability reporting.

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use serde::{Serialize, Serializer};
use serde_json::{json, Map, Value};
use thiserror::Error;

use crate::{
    find_unsafe_prototype_key, has_bidi_controls, has_control_chars, impl_str_enum_serde,
    redact_json_value, redact_private_disk_paths, redact_secrets_in_text, sanitize_and_inspect_url,
    sha256_hex, strip_bidi_controls, SanitizedUrlInfo, UrlInspectionPolicy, UrlSanitizeError,
};

const MAX_SSE_FRAMES: usize = 65_536;
const MAX_SSE_DATA_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOOL_NAME_LEN: usize = 64;

/// Errors returned by OpenCode contract validators and normalizers.
#[derive(Debug, Error)]
pub enum OpenCodeError {
    #[error("OpenCode URL rejected: {0}")]
    InvalidUrl(#[from] UrlSanitizeError),
    #[error("OpenCode URL violates policy ({reason:?}): {detail}")]
    PolicyRejected {
        reason: AvailabilityReason,
        detail: String,
    },
    #[error("invalid relative path: {0}")]
    InvalidRelativePath(String),
    #[error("malformed SSE stream: {0}")]
    MalformedSse(String),
    #[error("invalid OpenCode payload: {0}")]
    InvalidPayload(String),
    #[error("unsafe prototype key in OpenCode payload: {0}")]
    UnsafePrototypeKey(String),
}

/// Truthful connector availability status mirroring sibling Omnia capability contracts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConnectorAvailability {
    Available,
    Unavailable,
    Blocked,
    Error,
}

impl ConnectorAvailability {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Unavailable => "unavailable",
            Self::Blocked => "blocked",
            Self::Error => "error",
        }
    }
}

impl FromStr for ConnectorAvailability {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "available" => Ok(Self::Available),
            "unavailable" => Ok(Self::Unavailable),
            "blocked" => Ok(Self::Blocked),
            "error" => Ok(Self::Error),
            other => Err(format!("unknown connector availability '{other}'")),
        }
    }
}

impl_str_enum_serde!(ConnectorAvailability);

/// Reason taxonomy for truthful OpenCode endpoint reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AvailabilityReason {
    Ready,
    Unconfigured,
    Disabled,
    InvalidUrl,
    InsecureTransport,
    EmbeddedCredentials,
    SecretInQuery,
    PrivateEndpointDisallowed,
    NonLoopbackDisallowed,
    MetadataBlocked,
    ProbeNotRun,
    ProbeFailed,
}

impl AvailabilityReason {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Unconfigured => "unconfigured",
            Self::Disabled => "disabled",
            Self::InvalidUrl => "invalid_url",
            Self::InsecureTransport => "insecure_transport",
            Self::EmbeddedCredentials => "embedded_credentials",
            Self::SecretInQuery => "secret_in_query",
            Self::PrivateEndpointDisallowed => "private_endpoint_disallowed",
            Self::NonLoopbackDisallowed => "non_loopback_disallowed",
            Self::MetadataBlocked => "metadata_blocked",
            Self::ProbeNotRun => "probe_not_run",
            Self::ProbeFailed => "probe_failed",
        }
    }
}

impl FromStr for AvailabilityReason {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "ready" => Ok(Self::Ready),
            "unconfigured" => Ok(Self::Unconfigured),
            "disabled" => Ok(Self::Disabled),
            "invalid_url" => Ok(Self::InvalidUrl),
            "insecure_transport" => Ok(Self::InsecureTransport),
            "embedded_credentials" => Ok(Self::EmbeddedCredentials),
            "secret_in_query" => Ok(Self::SecretInQuery),
            "private_endpoint_disallowed" => Ok(Self::PrivateEndpointDisallowed),
            "non_loopback_disallowed" => Ok(Self::NonLoopbackDisallowed),
            "metadata_blocked" => Ok(Self::MetadataBlocked),
            "probe_not_run" => Ok(Self::ProbeNotRun),
            "probe_failed" => Ok(Self::ProbeFailed),
            other => Err(format!("unknown availability reason '{other}'")),
        }
    }
}

impl_str_enum_serde!(AvailabilityReason);

/// Configuration inputs for evaluating OpenCode endpoint readiness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenCodeEndpointConfig {
    pub base_url: Option<String>,
    pub enabled: bool,
    pub allow_remote_https: bool,
    pub allow_private_endpoints: bool,
    pub strict_tls: bool,
    pub timeout_ms: u64,
}

impl Default for OpenCodeEndpointConfig {
    fn default() -> Self {
        Self {
            base_url: None,
            enabled: true,
            allow_remote_https: false,
            allow_private_endpoints: false,
            strict_tls: true,
            timeout_ms: 5_000,
        }
    }
}

/// Truthful endpoint status receipt; `source_verified` is strictly `true` only when `status == Available`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenCodeEndpointStatus {
    pub status: ConnectorAvailability,
    pub reason: AvailabilityReason,
    pub source_verified: bool,
    pub sanitized_base_url: Option<String>,
    pub origin: Option<String>,
    pub is_loopback: bool,
    pub detail: String,
}

impl Serialize for OpenCodeEndpointStatus {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Guard the truthful verification invariant at serialization boundaries as well.
        let verified = self.status == ConnectorAvailability::Available && self.source_verified;
        let obj = json!({
            "status": self.status,
            "reason": self.reason,
            "source_verified": verified,
            "sanitized_base_url": self.sanitized_base_url,
            "origin": self.origin,
            "is_loopback": self.is_loopback,
            "detail": self.detail,
        });
        obj.serialize(serializer)
    }
}

/// Validates and normalizes an OpenCode server URL under explicit policy constraints.
pub fn validate_opencode_url(
    raw_url: &str,
    allow_remote_https: bool,
    allow_private_endpoints: bool,
    strict_tls: bool,
) -> Result<SanitizedUrlInfo, OpenCodeError> {
    let policy = UrlInspectionPolicy {
        strict_tls,
        allow_loopback_http: true,
        allow_private_endpoints,
        allow_non_loopback: allow_remote_https,
        redact_signed_params: true,
        allow_socks_schemes: false,
    };
    let info = sanitize_and_inspect_url(raw_url, &policy)?;
    if info.had_embedded_credentials {
        return Err(OpenCodeError::PolicyRejected {
            reason: AvailabilityReason::EmbeddedCredentials,
            detail: "OpenCode endpoint URL must not embed userinfo credentials".to_string(),
        });
    }
    if info.is_metadata {
        return Err(OpenCodeError::PolicyRejected {
            reason: AvailabilityReason::MetadataBlocked,
            detail: "OpenCode endpoint URL cannot target cloud metadata addresses".to_string(),
        });
    }
    if info.had_query_secrets {
        return Err(OpenCodeError::PolicyRejected {
            reason: AvailabilityReason::SecretInQuery,
            detail: "OpenCode endpoint URL must not carry credentials in query parameters"
                .to_string(),
        });
    }
    if info.non_tls_remote {
        return Err(OpenCodeError::PolicyRejected {
            reason: AvailabilityReason::InsecureTransport,
            detail: "remote OpenCode endpoint must use HTTPS".to_string(),
        });
    }
    if info.private_disallowed {
        return Err(OpenCodeError::PolicyRejected {
            reason: AvailabilityReason::PrivateEndpointDisallowed,
            detail: "private/link-local OpenCode endpoint rejected by policy".to_string(),
        });
    }
    if info.non_loopback_disallowed {
        return Err(OpenCodeError::PolicyRejected {
            reason: AvailabilityReason::NonLoopbackDisallowed,
            detail: "non-loopback OpenCode endpoint requires allow_remote_https".to_string(),
        });
    }
    Ok(info)
}

/// Evaluates OpenCode endpoint readiness without guessing or fabricating live status.
#[must_use]
pub fn evaluate_opencode_endpoint(
    config: &OpenCodeEndpointConfig,
    probe_succeeded: Option<bool>,
    probe_error: Option<&str>,
) -> OpenCodeEndpointStatus {
    if !config.enabled {
        return OpenCodeEndpointStatus {
            status: ConnectorAvailability::Unavailable,
            reason: AvailabilityReason::Disabled,
            source_verified: false,
            sanitized_base_url: None,
            origin: None,
            is_loopback: false,
            detail: "OpenCode connector is explicitly disabled".to_string(),
        };
    }

    let trimmed = config
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let Some(raw_url) = trimmed else {
        return OpenCodeEndpointStatus {
            status: ConnectorAvailability::Unavailable,
            reason: AvailabilityReason::Unconfigured,
            source_verified: false,
            sanitized_base_url: None,
            origin: None,
            is_loopback: false,
            detail: "OpenCode endpoint URL is unconfigured".to_string(),
        };
    };

    match validate_opencode_url(
        raw_url,
        config.allow_remote_https,
        config.allow_private_endpoints,
        config.strict_tls,
    ) {
        Err(OpenCodeError::InvalidUrl(err)) => OpenCodeEndpointStatus {
            status: ConnectorAvailability::Unavailable,
            reason: AvailabilityReason::InvalidUrl,
            source_verified: false,
            sanitized_base_url: None,
            origin: None,
            is_loopback: false,
            detail: sanitize_diagnostic(&err.to_string()),
        },
        Err(OpenCodeError::PolicyRejected { reason, detail }) => OpenCodeEndpointStatus {
            status: ConnectorAvailability::Blocked,
            reason,
            source_verified: false,
            sanitized_base_url: None,
            origin: None,
            is_loopback: false,
            detail: sanitize_diagnostic(&detail),
        },
        Err(other) => OpenCodeEndpointStatus {
            status: ConnectorAvailability::Error,
            reason: AvailabilityReason::InvalidUrl,
            source_verified: false,
            sanitized_base_url: None,
            origin: None,
            is_loopback: false,
            detail: sanitize_diagnostic(&other.to_string()),
        },
        Ok(info) => match probe_succeeded {
            Some(true) => OpenCodeEndpointStatus {
                status: ConnectorAvailability::Available,
                reason: AvailabilityReason::Ready,
                source_verified: true,
                sanitized_base_url: Some(info.normalized_url),
                origin: Some(info.origin),
                is_loopback: info.is_loopback,
                detail: "OpenCode endpoint verified via runtime probe".to_string(),
            },
            Some(false) => {
                let (status, detail) = match probe_error {
                    Some(err) if !err.trim().is_empty() => (
                        ConnectorAvailability::Error,
                        format!("OpenCode probe failed: {}", sanitize_diagnostic(err)),
                    ),
                    _ => (
                        ConnectorAvailability::Unavailable,
                        "OpenCode endpoint did not respond to health probe".to_string(),
                    ),
                };
                OpenCodeEndpointStatus {
                    status,
                    reason: AvailabilityReason::ProbeFailed,
                    source_verified: false,
                    sanitized_base_url: Some(info.normalized_url),
                    origin: Some(info.origin),
                    is_loopback: info.is_loopback,
                    detail,
                }
            }
            None => OpenCodeEndpointStatus {
                status: ConnectorAvailability::Unavailable,
                reason: AvailabilityReason::ProbeNotRun,
                source_verified: false,
                sanitized_base_url: Some(info.normalized_url),
                origin: Some(info.origin),
                is_loopback: info.is_loopback,
                detail: "OpenCode endpoint configured but not yet runtime-verified".to_string(),
            },
        },
    }
}

/// Validates and normalizes an OpenCode relative workspace path, rejecting traversal and drive paths.
pub fn validate_opencode_relative_path(raw_path: &str) -> Result<String, OpenCodeError> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(OpenCodeError::InvalidRelativePath(
            "path must not be empty".to_string(),
        ));
    }
    if has_control_chars(trimmed) || has_bidi_controls(trimmed) {
        return Err(OpenCodeError::InvalidRelativePath(
            "path contains control or bidirectional override characters".to_string(),
        ));
    }
    if trimmed.contains('\\') {
        return Err(OpenCodeError::InvalidRelativePath(
            "Windows backslashes are forbidden in OpenCode relative paths".to_string(),
        ));
    }
    if trimmed.starts_with('/') {
        return Err(OpenCodeError::InvalidRelativePath(
            "absolute paths are forbidden".to_string(),
        ));
    }
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(OpenCodeError::InvalidRelativePath(
            "drive-letter prefixes are forbidden".to_string(),
        ));
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("%2e")
        || lower.contains("%2f")
        || lower.contains("%5c")
        || lower.contains("%00")
    {
        return Err(OpenCodeError::InvalidRelativePath(
            "encoded traversal or separator sequences are forbidden".to_string(),
        ));
    }

    let mut clean_segments = Vec::new();
    for seg in trimmed.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                return Err(OpenCodeError::InvalidRelativePath(
                    "parent directory traversal ('..') is forbidden".to_string(),
                ));
            }
            other => clean_segments.push(other),
        }
    }
    if clean_segments.is_empty() {
        return Err(OpenCodeError::InvalidRelativePath(
            "path resolves to empty relative path".to_string(),
        ));
    }
    Ok(clean_segments.join("/"))
}

/// OpenCode `Permission.Reply` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PermissionReply {
    Once,
    Always,
    Reject,
}

impl PermissionReply {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Always => "always",
            Self::Reject => "reject",
        }
    }
}

impl FromStr for PermissionReply {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "once" => Ok(Self::Once),
            "always" => Ok(Self::Always),
            "reject" | "deny" => Ok(Self::Reject),
            other => Err(format!("unknown permission reply '{other}'")),
        }
    }
}

impl_str_enum_serde!(PermissionReply);

/// OpenCode `Permission.Effect` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PermissionEffect {
    Allow,
    Deny,
    Ask,
}

impl PermissionEffect {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::Ask => "ask",
        }
    }
}

impl FromStr for PermissionEffect {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "allow" => Ok(Self::Allow),
            "deny" => Ok(Self::Deny),
            "ask" => Ok(Self::Ask),
            other => Err(format!("unknown permission effect '{other}'")),
        }
    }
}

impl_str_enum_serde!(PermissionEffect);

/// OpenCode `Permission.Source` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PermissionSource {
    Config,
    Rule,
    Default,
    User,
    Unknown,
}

impl PermissionSource {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Config => "config",
            Self::Rule => "rule",
            Self::Default => "default",
            Self::User => "user",
            Self::Unknown => "unknown",
        }
    }
}

impl FromStr for PermissionSource {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "config" => Ok(Self::Config),
            "rule" => Ok(Self::Rule),
            "default" => Ok(Self::Default),
            "user" => Ok(Self::User),
            _ => Ok(Self::Unknown),
        }
    }
}

impl_str_enum_serde!(PermissionSource);

/// Normalized OpenCode `Permission.Request` record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionRequest {
    pub id: String,
    pub session_id: String,
    pub action: String,
    pub resources: Vec<String>,
    pub save: Vec<String>,
    pub metadata: Map<String, Value>,
    pub source: Option<PermissionSource>,
    pub message: Option<String>,
    pub effect_hint: Option<PermissionEffect>,
    pub redacted_fields: Vec<String>,
}

impl Serialize for PermissionRequest {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "id": self.id,
            "sessionID": self.session_id,
            "action": self.action,
            "resources": self.resources,
            "save": self.save,
            "metadata": self.metadata,
            "source": self.source,
            "message": self.message,
            "effect_hint": self.effect_hint,
            "redacted_fields": self.redacted_fields,
        })
        .serialize(serializer)
    }
}

/// Normalized OpenCode `permission.replied` / reply submission record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionResponse {
    pub request_id: String,
    pub session_id: String,
    pub reply: PermissionReply,
    pub message: Option<String>,
}

impl Serialize for PermissionResponse {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "requestID": self.request_id,
            "sessionID": self.session_id,
            "reply": self.reply,
            "message": self.message,
        })
        .serialize(serializer)
    }
}

/// Normalizes an OpenCode permission prompt (`Permission.Request` or `permission.asked` properties).
pub fn normalize_permission_request(raw: &Value) -> Result<PermissionRequest, OpenCodeError> {
    if let Some(unsafe_path) = find_unsafe_prototype_key(raw, "$") {
        return Err(OpenCodeError::UnsafePrototypeKey(unsafe_path));
    }
    let obj = raw.as_object().ok_or_else(|| {
        OpenCodeError::InvalidPayload("permission request must be an object".into())
    })?;

    let id = required_clean_id(obj, &["id", "requestID", "request_id"], "id")?;
    let session_id = required_clean_id(obj, &["sessionID", "session_id"], "sessionID")?;
    let action = required_clean_id(obj, &["action", "permission"], "action")?;

    let mut redacted_fields = BTreeSet::new();
    let resources = normalize_string_list_field(
        obj,
        &["resources", "patterns"],
        "resources",
        &mut redacted_fields,
    )?;
    let save = normalize_string_list_field(obj, &["save", "always"], "save", &mut redacted_fields)?;

    let metadata = match obj.get("metadata") {
        None | Some(Value::Null) => Map::new(),
        Some(val) => {
            let (redacted_val, paths) = redact_json_value(val);
            for p in paths {
                redacted_fields.insert(format!("metadata.{p}"));
            }
            redacted_val.as_object().cloned().ok_or_else(|| {
                OpenCodeError::InvalidPayload("permission metadata must be an object".into())
            })?
        }
    };

    let source = obj
        .get("source")
        .and_then(Value::as_str)
        .map(PermissionSource::from_str)
        .transpose()
        .map_err(OpenCodeError::InvalidPayload)?;

    let effect_hint = obj
        .get("effect")
        .or_else(|| obj.get("effect_hint"))
        .and_then(Value::as_str)
        .map(PermissionEffect::from_str)
        .transpose()
        .map_err(OpenCodeError::InvalidPayload)?;

    let message = obj
        .get("message")
        .and_then(Value::as_str)
        .map(|s| sanitize_human_text(s, "message", &mut redacted_fields))
        .filter(|s| !s.is_empty());

    Ok(PermissionRequest {
        id,
        session_id,
        action,
        resources,
        save,
        metadata,
        source,
        message,
        effect_hint,
        redacted_fields: redacted_fields.into_iter().collect(),
    })
}

/// Normalizes an OpenCode permission reply (`permission.replied` or reply submission).
pub fn normalize_permission_reply(raw: &Value) -> Result<PermissionResponse, OpenCodeError> {
    if let Some(unsafe_path) = find_unsafe_prototype_key(raw, "$") {
        return Err(OpenCodeError::UnsafePrototypeKey(unsafe_path));
    }
    let obj = raw.as_object().ok_or_else(|| {
        OpenCodeError::InvalidPayload("permission reply must be an object".into())
    })?;

    let request_id = required_clean_id(obj, &["requestID", "request_id", "id"], "requestID")?;
    let session_id = required_clean_id(obj, &["sessionID", "session_id"], "sessionID")?;
    let reply_raw = obj
        .get("reply")
        .or_else(|| obj.get("response"))
        .and_then(Value::as_str)
        .ok_or_else(|| OpenCodeError::InvalidPayload("missing 'reply' field".into()))?;
    let reply = PermissionReply::from_str(reply_raw).map_err(OpenCodeError::InvalidPayload)?;

    let mut redacted_fields = BTreeSet::new();
    let message = obj
        .get("message")
        .and_then(Value::as_str)
        .map(|s| sanitize_human_text(s, "message", &mut redacted_fields))
        .filter(|s| !s.is_empty());

    Ok(PermissionResponse {
        request_id,
        session_id,
        reply,
        message,
    })
}

/// Session activity status inside `session.status` events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SessionRunStatus {
    Idle,
    Retry,
    Busy,
}

impl SessionRunStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Retry => "retry",
            Self::Busy => "busy",
        }
    }
}

impl FromStr for SessionRunStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "idle" => Ok(Self::Idle),
            "retry" => Ok(Self::Retry),
            "busy" | "running" => Ok(Self::Busy),
            other => Err(format!("unknown session status '{other}'")),
        }
    }
}

impl_str_enum_serde!(SessionRunStatus);

/// Canonical OpenCode event kinds from the OpenCode v2 event manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OpenCodeEventKind {
    ServerConnected,
    ServerHeartbeat,
    GlobalDisposed,
    SessionCreated,
    SessionUpdated,
    SessionDeleted,
    SessionStatus,
    SessionIdle,
    SessionError,
    MessageUpdated,
    MessagePartUpdated,
    MessagePartDelta,
    PermissionAsked,
    PermissionReplied,
    Other,
}

impl OpenCodeEventKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ServerConnected => "server.connected",
            Self::ServerHeartbeat => "server.heartbeat",
            Self::GlobalDisposed => "global.disposed",
            Self::SessionCreated => "session.created",
            Self::SessionUpdated => "session.updated",
            Self::SessionDeleted => "session.deleted",
            Self::SessionStatus => "session.status",
            Self::SessionIdle => "session.idle",
            Self::SessionError => "session.error",
            Self::MessageUpdated => "message.updated",
            Self::MessagePartUpdated => "message.part.updated",
            Self::MessagePartDelta => "message.part.delta",
            Self::PermissionAsked => "permission.asked",
            Self::PermissionReplied => "permission.replied",
            Self::Other => "other",
        }
    }
}

impl FromStr for OpenCodeEventKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s.trim() {
            "server.connected" => Self::ServerConnected,
            "server.heartbeat" => Self::ServerHeartbeat,
            "global.disposed" => Self::GlobalDisposed,
            "session.created" => Self::SessionCreated,
            "session.updated" => Self::SessionUpdated,
            "session.deleted" => Self::SessionDeleted,
            "session.status" => Self::SessionStatus,
            "session.idle" => Self::SessionIdle,
            "session.error" => Self::SessionError,
            "message.updated" => Self::MessageUpdated,
            "message.part.updated" => Self::MessagePartUpdated,
            "message.part.delta" => Self::MessagePartDelta,
            "permission.asked" => Self::PermissionAsked,
            "permission.replied" => Self::PermissionReplied,
            _ => Self::Other,
        })
    }
}

impl_str_enum_serde!(OpenCodeEventKind);

/// Raw parsed WHATWG SSE frame before OpenCode payload normalization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    pub event: Option<String>,
    pub id: Option<String>,
    pub retry_ms: Option<u64>,
    pub data: String,
}

impl Serialize for SseFrame {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "event": self.event,
            "id": self.id,
            "retry_ms": self.retry_ms,
            "data": self.data,
        })
        .serialize(serializer)
    }
}

/// Normalized OpenCode SSE event envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedSseEvent {
    pub event_id: Option<String>,
    pub sse_event: Option<String>,
    pub payload_type: String,
    pub kind: OpenCodeEventKind,
    pub directory: Option<String>,
    pub session_id: Option<String>,
    pub session_status: Option<SessionRunStatus>,
    pub permission_request: Option<PermissionRequest>,
    pub permission_reply: Option<PermissionResponse>,
    pub properties: Value,
    pub redacted_fields: Vec<String>,
}

impl Serialize for NormalizedSseEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "event_id": self.event_id,
            "sse_event": self.sse_event,
            "payload_type": self.payload_type,
            "kind": self.kind,
            "directory": self.directory,
            "session_id": self.session_id,
            "session_status": self.session_status,
            "permission_request": self.permission_request,
            "permission_reply": self.permission_reply,
            "properties": self.properties,
            "redacted_fields": self.redacted_fields,
        })
        .serialize(serializer)
    }
}

/// Parses an SSE byte/text stream into discrete frames following LF/CRLF framing rules.
pub fn parse_sse_frames(stream_text: &str) -> Result<Vec<SseFrame>, OpenCodeError> {
    if stream_text.len() > MAX_SSE_DATA_BYTES * 2 {
        return Err(OpenCodeError::MalformedSse(
            "SSE input exceeds maximum bounded size".into(),
        ));
    }

    let mut frames = Vec::new();
    let mut current_event: Option<String> = None;
    let mut current_id: Option<String> = None;
    let mut current_retry: Option<u64> = None;
    let mut data_lines: Vec<String> = Vec::new();
    let mut data_bytes: usize = 0;

    let flush_frame = |frames: &mut Vec<SseFrame>,
                       current_event: &mut Option<String>,
                       current_id: &mut Option<String>,
                       current_retry: &mut Option<u64>,
                       data_lines: &mut Vec<String>,
                       data_bytes: &mut usize|
     -> Result<(), OpenCodeError> {
        if !data_lines.is_empty() || current_event.is_some() || current_id.is_some() {
            if frames.len() >= MAX_SSE_FRAMES {
                return Err(OpenCodeError::MalformedSse(
                    "SSE frame count exceeds maximum bounded limit".into(),
                ));
            }
            frames.push(SseFrame {
                event: current_event.take(),
                id: current_id.take(),
                retry_ms: current_retry.take(),
                data: data_lines.join("\n"),
            });
            data_lines.clear();
            *data_bytes = 0;
        } else {
            *current_retry = None;
        }
        Ok(())
    };

    for raw_line in stream_text.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.is_empty() {
            flush_frame(
                &mut frames,
                &mut current_event,
                &mut current_id,
                &mut current_retry,
                &mut data_lines,
                &mut data_bytes,
            )?;
            continue;
        }
        if line.starts_with(':') {
            continue;
        }
        let (field, value_raw) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "event" => current_event = Some(value_raw.to_string()),
            "id" if !value_raw.contains('\0') => current_id = Some(value_raw.to_string()),
            "retry" => {
                if let Ok(ms) = value_raw.trim().parse::<u64>() {
                    current_retry = Some(ms);
                }
            }
            "data" => {
                data_bytes = data_bytes.saturating_add(value_raw.len() + 1);
                if data_bytes > MAX_SSE_DATA_BYTES {
                    return Err(OpenCodeError::MalformedSse(
                        "SSE frame data payload exceeds maximum bounded bytes".into(),
                    ));
                }
                data_lines.push(value_raw.to_string());
            }
            _ => {}
        }
    }

    flush_frame(
        &mut frames,
        &mut current_event,
        &mut current_id,
        &mut current_retry,
        &mut data_lines,
        &mut data_bytes,
    )?;

    Ok(frames)
}

/// Normalizes a single OpenCode SSE frame (either direct `{ type, properties }` or `{ directory, payload }`).
pub fn normalize_opencode_sse_frame(
    frame: &SseFrame,
    namespace_map: Option<&McpNamespaceMap>,
) -> Result<NormalizedSseEvent, OpenCodeError> {
    let raw_json: Value = serde_json::from_str(frame.data.trim())
        .map_err(|e| OpenCodeError::MalformedSse(format!("invalid SSE JSON data: {e}")))?;

    if let Some(unsafe_path) = find_unsafe_prototype_key(&raw_json, "$") {
        return Err(OpenCodeError::UnsafePrototypeKey(unsafe_path));
    }

    let restored = match namespace_map {
        Some(map) => restore_responses_sse_event(&raw_json, map),
        None => raw_json,
    };

    let obj = restored.as_object().ok_or_else(|| {
        OpenCodeError::InvalidPayload("OpenCode SSE data JSON must be an object".into())
    })?;

    // Global SSE envelopes wrap `{ directory, payload: { type, properties } }`.
    let (directory_raw, event_obj) =
        if let Some(inner) = obj.get("payload").and_then(Value::as_object) {
            (obj.get("directory").and_then(Value::as_str), inner)
        } else {
            (obj.get("directory").and_then(Value::as_str), obj)
        };

    let payload_type = event_obj
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| frame.event.clone())
        .ok_or_else(|| OpenCodeError::InvalidPayload("missing SSE event 'type'".into()))?;

    let kind = OpenCodeEventKind::from_str(&payload_type).map_err(OpenCodeError::InvalidPayload)?;

    let raw_props = event_obj
        .get("properties")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));

    let mut redacted_set = BTreeSet::new();
    let directory = directory_raw.map(|dir| {
        let (cleaned, changed) = redact_private_disk_paths(dir);
        if changed {
            redacted_set.insert("directory".to_string());
        }
        cleaned
    });

    let mut permission_request = None;
    let mut permission_reply = None;
    match kind {
        OpenCodeEventKind::PermissionAsked => {
            let req = normalize_permission_request(&raw_props)?;
            for rf in &req.redacted_fields {
                redacted_set.insert(format!("permission_request.{rf}"));
            }
            permission_request = Some(req);
        }
        OpenCodeEventKind::PermissionReplied => {
            permission_reply = Some(normalize_permission_reply(&raw_props)?);
        }
        _ => {}
    }

    let (redacted_props, prop_redactions) = redact_json_value(&raw_props);
    for p in prop_redactions {
        redacted_set.insert(format!("properties.{p}"));
    }

    let session_id = extract_session_id(&redacted_props)
        .or_else(|| permission_request.as_ref().map(|r| r.session_id.clone()))
        .or_else(|| permission_reply.as_ref().map(|r| r.session_id.clone()));

    let session_status = match kind {
        OpenCodeEventKind::SessionIdle => Some(SessionRunStatus::Idle),
        OpenCodeEventKind::SessionStatus => redacted_props
            .get("status")
            .and_then(|s| s.get("type").or(Some(s)))
            .and_then(Value::as_str)
            .and_then(|s| SessionRunStatus::from_str(s).ok()),
        _ => None,
    };

    Ok(NormalizedSseEvent {
        event_id: frame.id.clone(),
        sse_event: frame.event.clone(),
        payload_type,
        kind,
        directory,
        session_id,
        session_status,
        permission_request,
        permission_reply,
        properties: redacted_props,
        redacted_fields: redacted_set.into_iter().collect(),
    })
}

/// Parses and normalizes every non-empty frame in an OpenCode SSE stream.
pub fn normalize_opencode_sse_stream(
    stream_text: &str,
    namespace_map: Option<&McpNamespaceMap>,
) -> Result<Vec<NormalizedSseEvent>, OpenCodeError> {
    let frames = parse_sse_frames(stream_text)?;
    let mut out = Vec::new();
    for frame in &frames {
        if frame.data.trim().is_empty() {
            continue;
        }
        out.push(normalize_opencode_sse_frame(frame, namespace_map)?);
    }
    Ok(out)
}

/// Deterministic two-way `/v1/responses` namespace lowering table (tool names <= 64 chars).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct McpNamespaceMap {
    pub lowered_to_original: BTreeMap<String, String>,
    pub original_to_lowered: BTreeMap<String, String>,
}

impl Serialize for McpNamespaceMap {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "lowered_to_original": self.lowered_to_original,
            "original_to_lowered": self.original_to_lowered,
        })
        .serialize(serializer)
    }
}

impl McpNamespaceMap {
    /// Registers an arbitrary tool name, generating a deterministic <= 64 char alias if needed.
    pub fn register(&mut self, original: &str) -> String {
        if let Some(existing) = self.original_to_lowered.get(original) {
            return existing.clone();
        }
        let lowered = if original.len() <= MAX_TOOL_NAME_LEN && is_valid_tool_ident(original) {
            original.to_string()
        } else {
            let digest = sha256_hex(original.as_bytes());
            let prefix: String = original
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .take(MAX_TOOL_NAME_LEN - 17)
                .collect();
            let clean_prefix = prefix.trim_matches('_');
            if clean_prefix.is_empty() {
                format!("mcp_{}", &digest[..12])
            } else {
                format!("mcp_{clean_prefix}_{}", &digest[..12])
            }
        };
        self.original_to_lowered
            .insert(original.to_string(), lowered.clone());
        self.lowered_to_original
            .insert(lowered.clone(), original.to_string());
        lowered
    }

    /// Restores a lowered tool name, preserving `"functions"` pseudo-root separation.
    #[must_use]
    pub fn restore(&self, candidate: &str) -> String {
        if candidate == "functions"
            || candidate.starts_with("functions.")
            || candidate.starts_with("functions::")
        {
            return candidate.to_string();
        }
        self.lowered_to_original
            .get(candidate)
            .cloned()
            .unwrap_or_else(|| candidate.to_string())
    }
}

/// Restores `/v1/responses` SSE event tool names while preventing `functions` pseudo-root
/// collisions and custom `exec` delta mislabeling.
#[must_use]
pub fn restore_responses_sse_event(payload: &Value, map: &McpNamespaceMap) -> Value {
    let mut cloned = payload.clone();
    restore_value_recursive(&mut cloned, map);
    cloned
}

/// Normalizes an OpenCode provider summary while stripping headers and secret fields.
pub fn map_opencode_provider_info(raw: &Value) -> Result<Value, OpenCodeError> {
    if let Some(unsafe_path) = find_unsafe_prototype_key(raw, "$") {
        return Err(OpenCodeError::UnsafePrototypeKey(unsafe_path));
    }
    let obj = raw
        .as_object()
        .ok_or_else(|| OpenCodeError::InvalidPayload("provider object required".into()))?;
    let raw_id = required_clean_id(obj, &["id", "providerID"], "id")?;
    let mut redaction_set = BTreeSet::new();

    let (id, id_kinds) = redact_secrets_in_text(&raw_id);
    for k in id_kinds {
        redaction_set.insert(format!("id:{k}"));
    }

    let raw_name = obj
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(raw_id.as_str());
    let (name, name_kinds) = redact_secrets_in_text(raw_name);
    for k in name_kinds {
        redaction_set.insert(format!("name:{k}"));
    }

    let models = obj
        .get("models")
        .and_then(Value::as_object)
        .map(|m| {
            m.keys()
                .enumerate()
                .map(|(idx, k)| {
                    let (cleaned_key, key_kinds) = redact_secrets_in_text(k);
                    for kind in key_kinds {
                        redaction_set.insert(format!("models[{idx}]:{kind}"));
                    }
                    cleaned_key
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let (redacted, redacted_paths) = redact_json_value(raw);
    for path in redacted_paths {
        redaction_set.insert(path);
    }
    let options = redacted
        .get("options")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));

    Ok(json!({
        "id": id,
        "name": name,
        "models": models,
        "options": options,
        "redacted_fields": redaction_set.into_iter().collect::<Vec<_>>(),
    }))
}

/// Normalizes an OpenCode tool descriptor and records a bounded schema fingerprint.
pub fn map_opencode_tool_descriptor(
    raw: &Value,
    namespace_map: Option<&mut McpNamespaceMap>,
) -> Result<Value, OpenCodeError> {
    if let Some(unsafe_path) = find_unsafe_prototype_key(raw, "$") {
        return Err(OpenCodeError::UnsafePrototypeKey(unsafe_path));
    }
    let obj = raw
        .as_object()
        .ok_or_else(|| OpenCodeError::InvalidPayload("tool descriptor must be an object".into()))?;
    let raw_original_name = required_clean_id(obj, &["name", "id"], "name")?;
    let mut redaction_set = BTreeSet::new();
    let (original_name, name_kinds) = redact_secrets_in_text(&raw_original_name);
    for k in name_kinds {
        redaction_set.insert(format!("name:{k}"));
    }
    let exposed_name = match namespace_map {
        Some(map) => map.register(&original_name),
        None => original_name.clone(),
    };
    let description = obj
        .get("description")
        .and_then(Value::as_str)
        .map(|d| {
            let (cleaned, kinds) = redact_secrets_in_text(d);
            for k in kinds {
                redaction_set.insert(format!("description:{k}"));
            }
            cleaned
        })
        .unwrap_or_default();
    let raw_parameters = obj
        .get("parameters")
        .or_else(|| obj.get("inputSchema"))
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object" }));
    let (parameters, param_redactions) = redact_json_value(&raw_parameters);
    for p in param_redactions {
        redaction_set.insert(format!("parameters.{p}"));
    }
    let schema_hash = sha256_hex(parameters.to_string().as_bytes());

    Ok(json!({
        "original_name": original_name,
        "exposed_name": exposed_name,
        "description": description,
        "parameters": parameters,
        "schema_sha256": schema_hash,
        "redacted_fields": redaction_set.into_iter().collect::<Vec<_>>(),
    }))
}

fn restore_value_recursive(val: &mut Value, map: &McpNamespaceMap) {
    let Some(obj) = val.as_object_mut() else {
        if let Some(arr) = val.as_array_mut() {
            for item in arr {
                restore_value_recursive(item, map);
            }
        }
        return;
    };

    let ev_type = obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if let Some(name_val) = obj.get_mut("name") {
        if let Some(name_str) = name_val.as_str() {
            let restored = map.restore(name_str);
            // Preserve function_call vs custom_tool_call boundaries; never convert a
            // namespaced function_call delta into a custom_tool_call_input delta.
            if ev_type != "response.custom_tool_call_input.delta" || restored == "exec" {
                *name_val = Value::String(restored);
            }
        }
    }

    for (_, child) in obj.iter_mut() {
        restore_value_recursive(child, map);
    }
}

fn extract_session_id(props: &Value) -> Option<String> {
    props
        .get("sessionID")
        .or_else(|| props.get("session_id"))
        .or_else(|| {
            props
                .get("info")
                .and_then(|i| i.get("sessionID").or_else(|| i.get("id")))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn required_clean_id(
    obj: &Map<String, Value>,
    keys: &[&str],
    label: &str,
) -> Result<String, OpenCodeError> {
    let raw = keys
        .iter()
        .find_map(|k| obj.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| OpenCodeError::InvalidPayload(format!("missing required '{label}'")))?;

    if has_control_chars(raw) || has_bidi_controls(raw) {
        return Err(OpenCodeError::InvalidPayload(format!(
            "'{label}' contains disallowed control or bidi characters"
        )));
    }
    Ok(raw.to_string())
}

fn normalize_string_list_field(
    obj: &Map<String, Value>,
    keys: &[&str],
    label: &str,
    redacted_fields: &mut BTreeSet<String>,
) -> Result<Vec<String>, OpenCodeError> {
    let Some(val) = keys.iter().find_map(|k| obj.get(*k)) else {
        return Ok(Vec::new());
    };
    let arr = val
        .as_array()
        .ok_or_else(|| OpenCodeError::InvalidPayload(format!("'{label}' must be an array")))?;
    let mut out = Vec::with_capacity(arr.len());
    for (idx, item) in arr.iter().enumerate() {
        let s = item.as_str().ok_or_else(|| {
            OpenCodeError::InvalidPayload(format!("'{label}[{idx}]' must be a string"))
        })?;
        let cleaned = sanitize_human_text(s, &format!("{label}[{idx}]"), redacted_fields);
        if !cleaned.is_empty() {
            out.push(cleaned);
        }
    }
    Ok(out)
}

fn sanitize_human_text(raw: &str, field: &str, redacted_fields: &mut BTreeSet<String>) -> String {
    let (no_bidi, bidi_stripped) = strip_bidi_controls(raw);
    if bidi_stripped {
        redacted_fields.insert(format!("{field}:bidi_stripped"));
    }
    let (no_secrets, kinds) = redact_secrets_in_text(&no_bidi);
    for k in kinds {
        redacted_fields.insert(format!("{field}:{k}"));
    }
    no_secrets.trim().to_string()
}

fn sanitize_diagnostic(raw: &str) -> String {
    let (no_secrets, _) = redact_secrets_in_text(raw);
    let (no_paths, _) = redact_private_disk_paths(&no_secrets);
    no_paths
}

fn is_valid_tool_ident(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unconfigured_and_disabled_report_truthfully() {
        let uncfg = evaluate_opencode_endpoint(&OpenCodeEndpointConfig::default(), None, None);
        assert_eq!(uncfg.status, ConnectorAvailability::Unavailable);
        assert_eq!(uncfg.reason, AvailabilityReason::Unconfigured);
        assert!(!uncfg.source_verified);

        let disabled = evaluate_opencode_endpoint(
            &OpenCodeEndpointConfig {
                base_url: Some("http://127.0.0.1:4096".into()),
                enabled: false,
                ..Default::default()
            },
            Some(true),
            None,
        );
        assert_eq!(disabled.status, ConnectorAvailability::Unavailable);
        assert_eq!(disabled.reason, AvailabilityReason::Disabled);
        assert!(!disabled.source_verified);

        let unprobed = evaluate_opencode_endpoint(
            &OpenCodeEndpointConfig {
                base_url: Some("http://127.0.0.1:4096".into()),
                ..Default::default()
            },
            None,
            None,
        );
        assert_eq!(unprobed.status, ConnectorAvailability::Unavailable);
        assert_eq!(unprobed.reason, AvailabilityReason::ProbeNotRun);
        assert!(!unprobed.source_verified);

        let ready = evaluate_opencode_endpoint(
            &OpenCodeEndpointConfig {
                base_url: Some("http://127.0.0.1:4096".into()),
                ..Default::default()
            },
            Some(true),
            None,
        );
        assert_eq!(ready.status, ConnectorAvailability::Available);
        assert_eq!(ready.reason, AvailabilityReason::Ready);
        assert!(ready.source_verified);
        assert!(ready.is_loopback);
    }

    #[test]
    fn url_and_relative_path_validation_enforce_security_boundaries() {
        assert!(
            validate_opencode_url("http://user:pass@127.0.0.1:4096", false, false, true).is_err()
        );
        assert!(validate_opencode_url("http://169.254.169.254/latest", true, true, false).is_err());
        assert!(validate_opencode_url("http://example.com:4096", true, false, true).is_err());
        let ok = validate_opencode_url(
            "https://opencode.example.com/v1?utm_source=ads",
            true,
            false,
            true,
        )
        .expect("https remote allowed");
        assert!(ok
            .normalized_url
            .starts_with("https://opencode.example.com/v1"));
        assert_eq!(ok.stripped_tracking_params, vec!["utm_source"]);

        assert_eq!(
            validate_opencode_relative_path("./src/lib.rs").expect("valid rel path"),
            "src/lib.rs"
        );
        assert!(validate_opencode_relative_path("../secrets.txt").is_err());
        assert!(validate_opencode_relative_path("C:\\Windows\\win.ini").is_err());
        assert!(validate_opencode_relative_path("a/%2e%2e/b").is_err());
    }

    #[test]
    fn normalizes_sse_permission_prompt_and_restores_namespaces() {
        let mut ns = McpNamespaceMap::default();
        let lowered = ns
            .register("mcp__very_long_server_name_exceeding_limits__deep_search_tool_with_suffix");
        assert!(lowered.len() <= 64);
        assert_eq!(ns.restore("functions.exec"), "functions.exec");

        let ant_tok = format!("{}-{}-{}", "sk", "ant-api03", "1234567890abcdef");
        let stream = format!(
            concat!(
                ": heartbeat\n",
                "id: evt-1\n",
                "event: permission.asked\n",
                "data: {{\"type\":\"permission.asked\",\"properties\":{{\"id\":\"perm_1\",\"sessionID\":\"sess_1\",\"action\":\"bash\",\"resources\":[\"src/*\"],\"message\":\"Run with Bearer {tok}\",\"metadata\":{{\"authorization\":\"Bearer topsecret1234567890\"}}}}}}\n\n",
                "id: evt-2\n",
                "data: {{\"directory\":\"C:\\\\Users\\\\Alice\\\\proj\",\"payload\":{{\"type\":\"message.part.delta\",\"properties\":{{\"sessionID\":\"sess_1\",\"name\":\"{name}\"}}}}}}\n\n"
            ),
            tok = ant_tok,
            name = lowered
        );

        let events = normalize_opencode_sse_stream(&stream, Some(&ns)).expect("valid sse stream");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, OpenCodeEventKind::PermissionAsked);
        let req = events[0].permission_request.as_ref().expect("perm req");
        assert!(!req
            .message
            .as_deref()
            .unwrap_or("")
            .contains(&format!("{}-{}", "sk", "ant-api03")));
        assert_eq!(
            req.metadata.get("authorization").and_then(Value::as_str),
            Some(crate::REDACTED_SECRET)
        );
        let dir = events[1].directory.as_deref().expect("directory present");
        assert!(!dir.contains("Alice"));
        assert_eq!(dir, format!("{}\\proj", crate::REDACTED_USER_PROFILE));
        assert_eq!(
            events[1].properties.get("name").and_then(Value::as_str),
            Some("mcp__very_long_server_name_exceeding_limits__deep_search_tool_with_suffix")
        );
    }

    #[test]
    fn provider_and_tool_mappers_redact_nested_secrets_and_model_keys() {
        let name_secret = format!("{}-{}-{}", "sk", "proj", "providersecret123456");
        let model_secret = format!("{}_{}", "ghp", "1234567890abcdef1234567890abcdef1234");
        let param_secret = format!("{}-{}-{}", "sk", "ant-api03", "toolschema987654321");

        let provider = json!({
            "id": "custom-gw",
            "name": format!("Gateway Bearer {name_secret}"),
            "models": {
                format!("model-key-{model_secret}"): { "id": "m1" }
            },
            "options": {
                "apiKey": name_secret
            }
        });
        let mapped_provider = map_opencode_provider_info(&provider).expect("mapped provider");
        let provider_str = mapped_provider.to_string();
        assert!(!provider_str.contains("providersecret123456"));
        assert!(!provider_str.contains("1234567890abcdef"));

        let tool = json!({
            "name": "query_gateway",
            "description": "Runs a gateway query",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "api_key": {
                        "type": "string",
                        "default": param_secret
                    },
                    "note": {
                        "type": "string",
                        "description": format!("Example Bearer {param_secret}")
                    }
                }
            }
        });
        let mapped_tool = map_opencode_tool_descriptor(&tool, None).expect("mapped tool");
        let tool_str = mapped_tool.to_string();
        assert!(!tool_str.contains("toolschema987654321"));
        assert_eq!(
            mapped_tool["parameters"]["properties"]["api_key"]["default"],
            crate::REDACTED_SECRET
        );
        assert!(crate::detect_json_secrets(&mapped_tool).is_empty());
        assert!(crate::detect_json_secrets(&mapped_provider).is_empty());
    }
}
