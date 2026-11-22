//! OBS Studio WebSocket v5 (`obs-websocket` 5.x) pure-Rust frame codec, SHA-256/Base64
//! challenge-response authentication solver, and loopback endpoint validator.

use crate::capability::{
    json_optional_str, json_required_non_empty_str, validate_endpoint_url,
    ws_upgrade_handshake_bounded, AdapterKind, CapabilityReason, CapabilityReport,
    CapabilityStatus, EndpointUrlError, EndpointUrlPolicy, HttpProbeError, ValidatedEndpointUrl,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use thiserror::Error;

const OBS_WS_SCHEMES: &[&str] = &["ws", "wss"];

/// `obs-websocket` v5 protocol OpCodes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum ObsOpCode {
    /// Server -> client handshake (`op = 0`).
    Hello = 0,
    /// Client -> server authentication and subscription setup (`op = 1`).
    Identify = 1,
    /// Server -> client identification confirmation (`op = 2`).
    Identified = 2,
    /// Client -> server subscription update (`op = 3`).
    Reidentify = 3,
    /// Server -> client broadcast event (`op = 5`).
    Event = 5,
    /// Client -> server RPC command (`op = 6`).
    Request = 6,
    /// Server -> client RPC command response (`op = 7`).
    RequestResponse = 7,
    /// Client -> server batched RPC commands (`op = 8`).
    RequestBatch = 8,
    /// Server -> client batched RPC responses (`op = 9`).
    RequestBatchResponse = 9,
}

impl ObsOpCode {
    /// Returns the numeric wire OpCode.
    pub const fn code(self) -> u8 {
        self as u8
    }

    /// Parses a numeric OpCode into [`ObsOpCode`].
    pub const fn from_u64(raw: u64) -> Option<Self> {
        match raw {
            0 => Some(Self::Hello),
            1 => Some(Self::Identify),
            2 => Some(Self::Identified),
            3 => Some(Self::Reidentify),
            5 => Some(Self::Event),
            6 => Some(Self::Request),
            7 => Some(Self::RequestResponse),
            8 => Some(Self::RequestBatch),
            9 => Some(Self::RequestBatchResponse),
            _ => None,
        }
    }
}

/// Server-issued challenge and salt contained inside `Hello` (`op = 0`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObsAuthChallenge {
    /// Server challenge string combined with Base64 secret.
    pub challenge: String,
    /// Server salt string appended to the OBS WebSocket password.
    pub salt: String,
}

impl Serialize for ObsAuthChallenge {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "challenge": self.challenge,
            "salt": self.salt,
        })
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ObsAuthChallenge {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        parse_auth_challenge_value(&value).map_err(serde::de::Error::custom)
    }
}

/// Decoded `Hello` (`op = 0`) payload from an OBS WebSocket v5 server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObsHello {
    /// Optional OBS Studio version string (when provided by server).
    pub obs_studio_version: Option<String>,
    /// OBS WebSocket server version (for example `"5.5.2"`).
    pub obs_web_socket_version: String,
    /// Expected RPC protocol version (typically `1`).
    pub rpc_version: u32,
    /// Present when password authentication is enabled on the server.
    pub authentication: Option<ObsAuthChallenge>,
}

impl Serialize for ObsHello {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut d = Map::new();
        if let Some(studio) = &self.obs_studio_version {
            d.insert("obsStudioVersion".to_string(), json!(studio));
        }
        d.insert(
            "obsWebSocketVersion".to_string(),
            json!(self.obs_web_socket_version),
        );
        d.insert("rpcVersion".to_string(), json!(self.rpc_version));
        if let Some(auth) = &self.authentication {
            d.insert("authentication".to_string(), json!(auth));
        }
        Value::Object(d).serialize(serializer)
    }
}

/// Outbound `Identify` (`op = 1`) payload sent in response to `Hello`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObsIdentify {
    /// RPC protocol version negotiated from `Hello` (must be `>= 1`).
    pub rpc_version: u32,
    /// Computed Base64 SHA-256 authentication response, omitted when auth is disabled.
    pub authentication: Option<String>,
    /// Optional bitmask of subscribed OBS event categories.
    pub event_subscriptions: Option<u64>,
}

impl ObsIdentify {
    /// Creates an `ObsIdentify` payload directly from typed parameters.
    pub fn new(
        rpc_version: u32,
        authentication: Option<String>,
        event_subscriptions: Option<u64>,
    ) -> Self {
        Self {
            rpc_version,
            authentication,
            event_subscriptions,
        }
    }

    /// Derives an `ObsIdentify` payload from a parsed [`ObsHello`], failing closed if auth is required without a password.
    pub fn for_hello(
        hello: &ObsHello,
        password: Option<&str>,
        event_subscriptions: Option<u64>,
    ) -> Result<Self, ObsError> {
        let auth = match &hello.authentication {
            Some(challenge) => {
                let raw_password = password
                    .filter(|p| !p.is_empty())
                    .ok_or(ObsError::AuthPasswordRequired)?;
                Some(compute_obs_v5_auth(
                    raw_password,
                    &challenge.salt,
                    &challenge.challenge,
                ))
            }
            None => None,
        };
        Ok(Self {
            rpc_version: hello.rpc_version,
            authentication: auth,
            event_subscriptions,
        })
    }
}

impl Serialize for ObsIdentify {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut d = Map::new();
        d.insert("rpcVersion".to_string(), json!(self.rpc_version));
        if let Some(auth) = &self.authentication {
            d.insert("authentication".to_string(), json!(auth));
        }
        if let Some(subs) = self.event_subscriptions {
            d.insert("eventSubscriptions".to_string(), json!(subs));
        }
        Value::Object(d).serialize(serializer)
    }
}

/// Outbound `Request` (`op = 6`) command payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObsRequest {
    /// OBS WebSocket request type (for example `"GetSceneList"`).
    pub request_type: String,
    /// Client-assigned correlation identifier echoed in `RequestResponse`.
    pub request_id: String,
    /// Optional structured request parameters.
    pub request_data: Option<Value>,
}

impl ObsRequest {
    /// Constructs a new OBS v5 RPC request descriptor.
    pub fn new(
        request_type: impl Into<String>,
        request_id: impl Into<String>,
        request_data: Option<Value>,
    ) -> Self {
        Self {
            request_type: request_type.into(),
            request_id: request_id.into(),
            request_data,
        }
    }
}

impl Serialize for ObsRequest {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut d = Map::new();
        d.insert("requestType".to_string(), json!(self.request_type));
        d.insert("requestId".to_string(), json!(self.request_id));
        if let Some(data) = &self.request_data {
            d.insert("requestData".to_string(), data.clone());
        }
        Value::Object(d).serialize(serializer)
    }
}

/// Execution status block returned inside `RequestResponse` (`op = 7`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObsRequestStatus {
    /// `true` when the request succeeded on the OBS server.
    pub result: bool,
    /// Numeric `RequestStatus` code (`100` == `Success`).
    pub code: i64,
    /// Optional server comment explaining failure or status context.
    pub comment: Option<String>,
}

impl Serialize for ObsRequestStatus {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut obj = Map::new();
        obj.insert("result".to_string(), json!(self.result));
        obj.insert("code".to_string(), json!(self.code));
        if let Some(comment) = &self.comment {
            obj.insert("comment".to_string(), json!(comment));
        }
        Value::Object(obj).serialize(serializer)
    }
}

/// Decoded `RequestResponse` (`op = 7`) payload returned by an OBS WebSocket v5 server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObsRequestResponse {
    /// Echoed request type.
    pub request_type: String,
    /// Echoed correlation identifier matching [`ObsRequest::request_id`].
    pub request_id: String,
    /// Execution status result, code, and optional comment.
    pub request_status: ObsRequestStatus,
    /// Optional response payload object when present.
    pub response_data: Option<Value>,
}

impl Serialize for ObsRequestResponse {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut d = Map::new();
        d.insert("requestType".to_string(), json!(self.request_type));
        d.insert("requestId".to_string(), json!(self.request_id));
        d.insert("requestStatus".to_string(), json!(self.request_status));
        if let Some(data) = &self.response_data {
            d.insert("responseData".to_string(), data.clone());
        }
        Value::Object(d).serialize(serializer)
    }
}

/// Errors produced by OBS v5 frame codec, authentication setup, or URL validation.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum ObsError {
    /// Endpoint URL validation failed.
    #[error(transparent)]
    Endpoint(#[from] EndpointUrlError),
    /// Frame string is not valid JSON.
    #[error("invalid OBS v5 JSON frame: {0}")]
    InvalidJson(String),
    /// Frame OpCode does not match the expected message type.
    #[error("unexpected OBS v5 opcode: expected {expected}, got {actual}")]
    UnexpectedOpCode {
        /// Expected OpCode.
        expected: u8,
        /// Observed OpCode.
        actual: u64,
    },
    /// Required protocol field is missing or malformed.
    #[error("invalid OBS v5 frame field `{field}`: {detail}")]
    InvalidField {
        /// Field name.
        field: &'static str,
        /// Diagnostic detail.
        detail: String,
    },
    /// Server `Hello` included an authentication challenge, but no password was supplied.
    #[error("OBS v5 server requires password authentication")]
    AuthPasswordRequired,
}

impl ObsError {
    /// Converts this OBS v5 error into a truthful [`CapabilityReport`].
    pub fn to_capability_report(&self, origin: Option<String>) -> CapabilityReport {
        match self {
            Self::Endpoint(err) => {
                let mut report = err.to_capability_report(AdapterKind::ObsV5);
                if report.endpoint_origin.is_none() {
                    report.endpoint_origin = origin;
                }
                report
            }
            Self::AuthPasswordRequired => CapabilityReport::failure(
                AdapterKind::ObsV5,
                CapabilityStatus::Blocked,
                CapabilityReason::AuthPasswordRequired,
                self.to_string(),
                origin,
            ),
            Self::InvalidJson(_) | Self::UnexpectedOpCode { .. } | Self::InvalidField { .. } => {
                CapabilityReport::failure(
                    AdapterKind::ObsV5,
                    CapabilityStatus::Error,
                    CapabilityReason::ProtocolError,
                    self.to_string(),
                    origin,
                )
            }
        }
    }
}

/// Computes the official `obs-websocket` v5 authentication response:
/// `Base64(SHA256(Base64(SHA256(password + salt)) + challenge))`.
pub fn compute_obs_v5_auth(password: &str, salt: &str, challenge: &str) -> String {
    let mut secret_hasher = Sha256::new();
    secret_hasher.update(password.as_bytes());
    secret_hasher.update(salt.as_bytes());
    let secret_b64 = STANDARD.encode(secret_hasher.finalize());

    let mut auth_hasher = Sha256::new();
    auth_hasher.update(secret_b64.as_bytes());
    auth_hasher.update(challenge.as_bytes());
    STANDARD.encode(auth_hasher.finalize())
}

/// Parses an inbound `Hello` (`op = 0`) JSON wire frame.
pub fn parse_hello_op0(raw_json: &str) -> Result<ObsHello, ObsError> {
    let d = parse_obs_envelope(raw_json, ObsOpCode::Hello)?;
    let obs_studio_version =
        json_optional_str(d.as_map(), "obsStudioVersion").map_err(|detail| {
            ObsError::InvalidField {
                field: "obsStudioVersion",
                detail,
            }
        })?;
    let obs_web_socket_version = json_required_non_empty_str(d.as_map(), "obsWebSocketVersion")
        .map_err(|detail| ObsError::InvalidField {
            field: "obsWebSocketVersion",
            detail,
        })?;
    let rpc_version = parse_positive_u32(d.as_map(), "rpcVersion")?;
    let authentication =
        match d.as_map().get("authentication") {
            None | Some(Value::Null) => None,
            Some(auth_val) => Some(parse_auth_challenge_value(auth_val).map_err(|detail| {
                ObsError::InvalidField {
                    field: "authentication",
                    detail,
                }
            })?),
        };
    Ok(ObsHello {
        obs_studio_version,
        obs_web_socket_version,
        rpc_version,
        authentication,
    })
}

/// Serializes an [`ObsIdentify`] payload into an OBS v5 `Identify` (`op = 1`) JSON frame.
pub fn build_identify_op1(identify: &ObsIdentify) -> Result<String, ObsError> {
    if identify.rpc_version == 0 {
        return Err(ObsError::InvalidField {
            field: "rpcVersion",
            detail: "rpcVersion must be >= 1".to_string(),
        });
    }
    if let Some(auth) = &identify.authentication {
        if auth.trim().is_empty() {
            return Err(ObsError::InvalidField {
                field: "authentication",
                detail: "authentication token must be non-empty when present".to_string(),
            });
        }
    }
    let frame = json!({
        "op": ObsOpCode::Identify.code(),
        "d": identify,
    });
    serde_json::to_string(&frame).map_err(|err| ObsError::InvalidJson(err.to_string()))
}

/// Parses an `Identify` (`op = 1`) JSON wire frame back into [`ObsIdentify`].
pub fn parse_identify_op1(raw_json: &str) -> Result<ObsIdentify, ObsError> {
    let d = parse_obs_envelope(raw_json, ObsOpCode::Identify)?;
    let rpc_version = parse_positive_u32(d.as_map(), "rpcVersion")?;
    let authentication = json_optional_str(d.as_map(), "authentication").map_err(|detail| {
        ObsError::InvalidField {
            field: "authentication",
            detail,
        }
    })?;
    let event_subscriptions = match d.as_map().get("eventSubscriptions") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_u64().ok_or_else(|| ObsError::InvalidField {
            field: "eventSubscriptions",
            detail: "eventSubscriptions must be an unsigned integer".to_string(),
        })?),
    };
    Ok(ObsIdentify {
        rpc_version,
        authentication,
        event_subscriptions,
    })
}

/// Serializes an [`ObsRequest`] payload into an OBS v5 `Request` (`op = 6`) JSON frame.
pub fn build_request_op6(request: &ObsRequest) -> Result<String, ObsError> {
    if request.request_type.trim().is_empty() {
        return Err(ObsError::InvalidField {
            field: "requestType",
            detail: "requestType must be non-empty".to_string(),
        });
    }
    if request.request_id.trim().is_empty() {
        return Err(ObsError::InvalidField {
            field: "requestId",
            detail: "requestId must be non-empty".to_string(),
        });
    }
    let frame = json!({
        "op": ObsOpCode::Request.code(),
        "d": request,
    });
    serde_json::to_string(&frame).map_err(|err| ObsError::InvalidJson(err.to_string()))
}

/// Parses a `Request` (`op = 6`) JSON wire frame back into [`ObsRequest`].
pub fn parse_request_op6(raw_json: &str) -> Result<ObsRequest, ObsError> {
    let d = parse_obs_envelope(raw_json, ObsOpCode::Request)?;
    let request_type =
        json_required_non_empty_str(d.as_map(), "requestType").map_err(|detail| {
            ObsError::InvalidField {
                field: "requestType",
                detail,
            }
        })?;
    let request_id = json_required_non_empty_str(d.as_map(), "requestId").map_err(|detail| {
        ObsError::InvalidField {
            field: "requestId",
            detail,
        }
    })?;
    let request_data = match d.as_map().get("requestData") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.clone()),
    };
    Ok(ObsRequest {
        request_type,
        request_id,
        request_data,
    })
}

/// Parses an inbound `RequestResponse` (`op = 7`) JSON wire frame into [`ObsRequestResponse`].
pub fn parse_request_response_op7(raw_json: &str) -> Result<ObsRequestResponse, ObsError> {
    let d = parse_obs_envelope(raw_json, ObsOpCode::RequestResponse)?;
    let request_type =
        json_required_non_empty_str(d.as_map(), "requestType").map_err(|detail| {
            ObsError::InvalidField {
                field: "requestType",
                detail,
            }
        })?;
    let request_id = json_required_non_empty_str(d.as_map(), "requestId").map_err(|detail| {
        ObsError::InvalidField {
            field: "requestId",
            detail,
        }
    })?;

    let status_val = d
        .as_map()
        .get("requestStatus")
        .ok_or_else(|| ObsError::InvalidField {
            field: "requestStatus",
            detail: "missing requestStatus object".to_string(),
        })?;
    let status_obj = status_val
        .as_object()
        .ok_or_else(|| ObsError::InvalidField {
            field: "requestStatus",
            detail: "requestStatus must be a JSON object".to_string(),
        })?;
    let result = status_obj
        .get("result")
        .and_then(Value::as_bool)
        .ok_or_else(|| ObsError::InvalidField {
            field: "requestStatus.result",
            detail: "missing boolean result".to_string(),
        })?;
    let code = status_obj
        .get("code")
        .and_then(Value::as_i64)
        .ok_or_else(|| ObsError::InvalidField {
            field: "requestStatus.code",
            detail: "missing integer code".to_string(),
        })?;
    let comment =
        json_optional_str(status_obj, "comment").map_err(|detail| ObsError::InvalidField {
            field: "requestStatus.comment",
            detail,
        })?;

    let response_data = match d.as_map().get("responseData") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.clone()),
    };

    Ok(ObsRequestResponse {
        request_type,
        request_id,
        request_status: ObsRequestStatus {
            result,
            code,
            comment,
        },
        response_data,
    })
}

/// Validates an OBS WebSocket endpoint URL (`ws://` / `wss://`), restricting to loopback by default.
pub fn validate_obs_ws_url(
    raw_url: &str,
    allow_non_loopback: bool,
) -> Result<ValidatedEndpointUrl, ObsError> {
    Ok(validate_endpoint_url(
        raw_url,
        OBS_WS_SCHEMES,
        EndpointUrlPolicy { allow_non_loopback },
    )?)
}

/// Evaluates OBS WebSocket v5 endpoint reachability via a bounded WebSocket Upgrade handshake.
///
/// Performing a real HTTP `101 Switching Protocols` handshake rather than bare TCP connect
/// prevents transparent local WFP/firewall proxies from turning closed ports into false `Available`.
pub fn probe_obs_endpoint(
    raw_url: Option<&str>,
    allow_non_loopback: bool,
    timeout: Duration,
) -> CapabilityReport {
    let Some(raw) = raw_url.map(str::trim).filter(|s| !s.is_empty()) else {
        return CapabilityReport::unconfigured(AdapterKind::ObsV5, "obs_websocket_url");
    };
    let validated = match validate_obs_ws_url(raw, allow_non_loopback) {
        Ok(v) => v,
        Err(err) => return err.to_capability_report(None),
    };
    let origin = Some(validated.origin.clone());
    let started = Instant::now();
    match ws_upgrade_handshake_bounded(&validated, allow_non_loopback, timeout) {
        Ok(()) => CapabilityReport::available(
            AdapterKind::ObsV5,
            format!("OBS WebSocket upgrade verified at {}", validated.origin),
            origin,
            Some(started.elapsed().as_millis() as u64),
        ),
        Err(HttpProbeError::Blocked(detail)) => CapabilityReport::failure(
            AdapterKind::ObsV5,
            CapabilityStatus::Blocked,
            CapabilityReason::NonLoopbackForbidden,
            detail,
            origin,
        ),
        Err(HttpProbeError::Timeout(detail)) => CapabilityReport::failure(
            AdapterKind::ObsV5,
            CapabilityStatus::Unavailable,
            CapabilityReason::Timeout,
            detail,
            origin,
        ),
        Err(HttpProbeError::Unreachable(detail)) => CapabilityReport::failure(
            AdapterKind::ObsV5,
            CapabilityStatus::Unavailable,
            CapabilityReason::EndpointUnreachable,
            detail,
            origin,
        ),
        Err(HttpProbeError::Protocol(detail)) => CapabilityReport::failure(
            AdapterKind::ObsV5,
            CapabilityStatus::Error,
            CapabilityReason::ProtocolError,
            detail,
            origin,
        ),
    }
}

struct OwnedEnvelopeMap(Map<String, Value>);

impl OwnedEnvelopeMap {
    fn as_map(&self) -> &Map<String, Value> {
        &self.0
    }
}

fn parse_obs_envelope(raw_json: &str, expected: ObsOpCode) -> Result<OwnedEnvelopeMap, ObsError> {
    let value: Value =
        serde_json::from_str(raw_json).map_err(|err| ObsError::InvalidJson(err.to_string()))?;
    let mut obj = match value {
        Value::Object(map) => map,
        _ => {
            return Err(ObsError::InvalidField {
                field: "frame",
                detail: "OBS v5 frame must be a JSON object".to_string(),
            })
        }
    };
    let op = obj
        .get("op")
        .and_then(Value::as_u64)
        .ok_or_else(|| ObsError::InvalidField {
            field: "op",
            detail: "missing unsigned integer op code".to_string(),
        })?;
    if op != u64::from(expected.code()) {
        return Err(ObsError::UnexpectedOpCode {
            expected: expected.code(),
            actual: op,
        });
    }
    let data = obj.remove("d").ok_or_else(|| ObsError::InvalidField {
        field: "d",
        detail: "missing frame payload `d`".to_string(),
    })?;
    match data {
        Value::Object(map) => Ok(OwnedEnvelopeMap(map)),
        _ => Err(ObsError::InvalidField {
            field: "d",
            detail: "frame payload `d` must be a JSON object".to_string(),
        }),
    }
}

fn parse_positive_u32(map: &Map<String, Value>, field: &'static str) -> Result<u32, ObsError> {
    let raw = map
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| ObsError::InvalidField {
            field,
            detail: "missing unsigned integer".to_string(),
        })?;
    let val = u32::try_from(raw).map_err(|_| ObsError::InvalidField {
        field,
        detail: "integer exceeds u32 range".to_string(),
    })?;
    if val == 0 {
        return Err(ObsError::InvalidField {
            field,
            detail: "value must be >= 1".to_string(),
        });
    }
    Ok(val)
}

fn parse_auth_challenge_value(value: &Value) -> Result<ObsAuthChallenge, String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "authentication must be a JSON object".to_string())?;
    let challenge = json_required_non_empty_str(obj, "challenge")?;
    let salt = json_required_non_empty_str(obj, "salt")?;
    Ok(ObsAuthChallenge { challenge, salt })
}
