//! Truthful capability state model, loopback endpoint policy, and bounded TCP/HTTP probe helpers.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Map, Value};
use std::fmt;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::str::FromStr;
use std::time::{Duration, Instant};
use thiserror::Error;
use url::{Host, Url};

/// Maximum HTTP response payload accepted by the bounded loopback probe helper (2 MiB).
pub const MAX_LOOPBACK_HTTP_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Maximum HTTP header block size accepted by the bounded loopback probe helper (16 KiB).
const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
/// Maximum TCP probe timeout (30 seconds).
const MAX_PROBE_TIMEOUT_MS: u64 = 30_000;

/// Operational state of a media, browser, or capture adapter.
///
/// Unconfigured or unreachable adapters must never fabricate `Available`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CapabilityStatus {
    /// Target endpoint or frame receipt has been actively verified.
    Available,
    /// Adapter is unconfigured, disabled, or its endpoint could not be reached.
    Unavailable,
    /// Policy, authorization, minimization, or dimension bounds forbid execution.
    Blocked,
    /// Target HWND, PID, creation timestamp, or geometry drifted or became invalid.
    StaleTarget,
    /// Protocol frame, JSON schema, URL syntax, or frame receipt integrity check failed.
    Error,
}

impl CapabilityStatus {
    /// Returns the canonical `snake_case` wire tag for this status.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Unavailable => "unavailable",
            Self::Blocked => "blocked",
            Self::StaleTarget => "stale_target",
            Self::Error => "error",
        }
    }

    /// Returns `true` strictly when the capability is verified as operational.
    pub const fn is_available(self) -> bool {
        matches!(self, Self::Available)
    }
}

impl fmt::Display for CapabilityStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for CapabilityStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "available" => Ok(Self::Available),
            "unavailable" => Ok(Self::Unavailable),
            "blocked" => Ok(Self::Blocked),
            "stale_target" => Ok(Self::StaleTarget),
            "error" => Ok(Self::Error),
            other => Err(format!("unknown capability status: {other}")),
        }
    }
}

impl Serialize for CapabilityStatus {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for CapabilityStatus {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::from_str(&raw).map_err(serde::de::Error::custom)
    }
}

/// Owning adapter domain for a [`CapabilityReport`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AdapterKind {
    /// Chromium DevTools Protocol (`/json/version`, `/json/list`, debugger URLs).
    BrowserCdp,
    /// Win32 HWND/PID/create-time target and capture frame receipt validator.
    WindowCapture,
    /// OBS Studio WebSocket v5 (`obs-websocket` 5.x) control adapter.
    ObsV5,
}

impl AdapterKind {
    /// Returns the canonical `snake_case` adapter identifier.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BrowserCdp => "browser_cdp",
            Self::WindowCapture => "window_capture",
            Self::ObsV5 => "obs_v5",
        }
    }
}

impl fmt::Display for AdapterKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for AdapterKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "browser_cdp" => Ok(Self::BrowserCdp),
            "window_capture" => Ok(Self::WindowCapture),
            "obs_v5" => Ok(Self::ObsV5),
            other => Err(format!("unknown adapter kind: {other}")),
        }
    }
}

impl Serialize for AdapterKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for AdapterKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::from_str(&raw).map_err(serde::de::Error::custom)
    }
}

/// Machine-readable reason codes emitted alongside [`CapabilityStatus`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CapabilityReason {
    /// Endpoint or capture receipt verified cleanly.
    Available,
    /// Adapter endpoint or configuration value is unset or blank.
    Unconfigured,
    /// Target exists structurally, but no verified capture receipt has been produced yet.
    CaptureReceiptRequired,
    /// Loopback TCP or HTTP endpoint refused connection or was otherwise unreachable.
    EndpointUnreachable,
    /// Endpoint probe exceeded its bounded timeout.
    Timeout,
    /// Non-loopback host was rejected because explicit opt-in was not granted.
    NonLoopbackForbidden,
    /// URL syntax, scheme, or control-character validation failed.
    InvalidUrl,
    /// URL resolved without a valid nonzero TCP port.
    MissingPort,
    /// URL contained embedded userinfo (`user:pass@`), which is rejected to prevent secret leakage.
    EmbeddedCredentialsForbidden,
    /// Wire protocol payload, HTTP status, or JSON structure failed validation.
    ProtocolError,
    /// Win32 window handle (`hwnd`) is zero.
    InvalidHwnd,
    /// Win32 process identifier (`pid`) is zero.
    InvalidPid,
    /// Process creation timestamp (`process_create_time_100ns`) is zero.
    MissingProcessCreateTime,
    /// Observed HWND differs from the expected target HWND.
    HwndMismatch,
    /// Observed PID differs from the expected target PID.
    PidMismatch,
    /// Observed `process_create_time_100ns` changed, indicating OS PID reuse.
    PidReuseDetected,
    /// Window is minimized (`IsIconic`), so non-blank capture is blocked.
    WindowMinimized,
    /// Window width or height is zero.
    ZeroAreaWindow,
    /// Window or frame dimensions exceed the configured capture ceiling.
    DimensionExceedsLimit,
    /// Window dimensions drifted between expectation, observation, and captured frame.
    GeometryMismatch,
    /// Frame receipt reported zero bytes, zero dimensions, or the empty SHA-256 digest.
    EmptyFrameReceipt,
    /// Declared byte length disagrees with buffer length or pixel-stride bounds.
    FrameSizeMismatch,
    /// Actual SHA-256 digest of captured bytes does not match `sha256_hex`.
    FrameHashMismatch,
    /// `sha256_hex` is not a valid 64-character hexadecimal SHA-256 digest.
    InvalidFrameHash,
    /// Captured frame is blank, all-transparent, uniform monochrome, or unverified.
    BlankFrameDetected,
    /// Server requested authentication challenge/salt, but no password was supplied.
    AuthPasswordRequired,
    /// Server rejected OBS v5 authentication or returned an authentication error.
    AuthFailed,
    /// OBS v5 request returned `requestStatus.result == false`.
    RequestRejected,
}

impl CapabilityReason {
    /// Returns the canonical `SCREAMING_SNAKE_CASE` wire code.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Available => "AVAILABLE",
            Self::Unconfigured => "UNCONFIGURED",
            Self::CaptureReceiptRequired => "CAPTURE_RECEIPT_REQUIRED",
            Self::EndpointUnreachable => "ENDPOINT_UNREACHABLE",
            Self::Timeout => "TIMEOUT",
            Self::NonLoopbackForbidden => "NON_LOOPBACK_FORBIDDEN",
            Self::InvalidUrl => "INVALID_URL",
            Self::MissingPort => "MISSING_PORT",
            Self::EmbeddedCredentialsForbidden => "EMBEDDED_CREDENTIALS_FORBIDDEN",
            Self::ProtocolError => "PROTOCOL_ERROR",
            Self::InvalidHwnd => "INVALID_HWND",
            Self::InvalidPid => "INVALID_PID",
            Self::MissingProcessCreateTime => "MISSING_PROCESS_CREATE_TIME",
            Self::HwndMismatch => "HWND_MISMATCH",
            Self::PidMismatch => "PID_MISMATCH",
            Self::PidReuseDetected => "PID_REUSE_DETECTED",
            Self::WindowMinimized => "WINDOW_MINIMIZED",
            Self::ZeroAreaWindow => "ZERO_AREA_WINDOW",
            Self::DimensionExceedsLimit => "DIMENSION_EXCEEDS_LIMIT",
            Self::GeometryMismatch => "GEOMETRY_MISMATCH",
            Self::EmptyFrameReceipt => "EMPTY_FRAME_RECEIPT",
            Self::FrameSizeMismatch => "FRAME_SIZE_MISMATCH",
            Self::FrameHashMismatch => "FRAME_HASH_MISMATCH",
            Self::InvalidFrameHash => "INVALID_FRAME_HASH",
            Self::BlankFrameDetected => "BLANK_FRAME_DETECTED",
            Self::AuthPasswordRequired => "AUTH_PASSWORD_REQUIRED",
            Self::AuthFailed => "AUTH_FAILED",
            Self::RequestRejected => "REQUEST_REJECTED",
        }
    }
}

impl fmt::Display for CapabilityReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for CapabilityReason {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "AVAILABLE" => Ok(Self::Available),
            "UNCONFIGURED" => Ok(Self::Unconfigured),
            "CAPTURE_RECEIPT_REQUIRED" => Ok(Self::CaptureReceiptRequired),
            "ENDPOINT_UNREACHABLE" => Ok(Self::EndpointUnreachable),
            "TIMEOUT" => Ok(Self::Timeout),
            "NON_LOOPBACK_FORBIDDEN" => Ok(Self::NonLoopbackForbidden),
            "INVALID_URL" => Ok(Self::InvalidUrl),
            "MISSING_PORT" => Ok(Self::MissingPort),
            "EMBEDDED_CREDENTIALS_FORBIDDEN" => Ok(Self::EmbeddedCredentialsForbidden),
            "PROTOCOL_ERROR" => Ok(Self::ProtocolError),
            "INVALID_HWND" => Ok(Self::InvalidHwnd),
            "INVALID_PID" => Ok(Self::InvalidPid),
            "MISSING_PROCESS_CREATE_TIME" => Ok(Self::MissingProcessCreateTime),
            "HWND_MISMATCH" => Ok(Self::HwndMismatch),
            "PID_MISMATCH" => Ok(Self::PidMismatch),
            "PID_REUSE_DETECTED" => Ok(Self::PidReuseDetected),
            "WINDOW_MINIMIZED" => Ok(Self::WindowMinimized),
            "ZERO_AREA_WINDOW" => Ok(Self::ZeroAreaWindow),
            "DIMENSION_EXCEEDS_LIMIT" => Ok(Self::DimensionExceedsLimit),
            "GEOMETRY_MISMATCH" => Ok(Self::GeometryMismatch),
            "EMPTY_FRAME_RECEIPT" => Ok(Self::EmptyFrameReceipt),
            "FRAME_SIZE_MISMATCH" => Ok(Self::FrameSizeMismatch),
            "FRAME_HASH_MISMATCH" => Ok(Self::FrameHashMismatch),
            "INVALID_FRAME_HASH" => Ok(Self::InvalidFrameHash),
            "BLANK_FRAME_DETECTED" => Ok(Self::BlankFrameDetected),
            "AUTH_PASSWORD_REQUIRED" => Ok(Self::AuthPasswordRequired),
            "AUTH_FAILED" => Ok(Self::AuthFailed),
            "REQUEST_REJECTED" => Ok(Self::RequestRejected),
            other => Err(format!("unknown capability reason code: {other}")),
        }
    }
}

impl Serialize for CapabilityReason {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for CapabilityReason {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::from_str(&raw).map_err(serde::de::Error::custom)
    }
}

/// Truthful capability evaluation receipt emitted by every adapter probe or validator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityReport {
    /// Owning adapter domain.
    pub adapter: AdapterKind,
    /// Evaluated operational status.
    pub status: CapabilityStatus,
    /// Machine-readable reason code.
    pub reason_code: CapabilityReason,
    /// Secret-free diagnostic explanation.
    pub detail: String,
    /// Sanitized `scheme://host:port` origin without userinfo, query, or path tokens.
    pub endpoint_origin: Option<String>,
    /// True strictly when live endpoint or frame receipt verification succeeded (`status == Available`).
    pub source_verified: bool,
    /// Measured loopback probe duration in milliseconds when network I/O occurred.
    pub latency_ms: Option<u64>,
}

impl CapabilityReport {
    /// Constructs a verified `Available` report.
    pub fn available(
        adapter: AdapterKind,
        detail: impl Into<String>,
        endpoint_origin: Option<String>,
        latency_ms: Option<u64>,
    ) -> Self {
        Self {
            adapter,
            status: CapabilityStatus::Available,
            reason_code: CapabilityReason::Available,
            detail: detail.into(),
            endpoint_origin,
            source_verified: true,
            latency_ms,
        }
    }

    /// Constructs an unverified non-available report (`source_verified` is always `false`).
    pub fn failure(
        adapter: AdapterKind,
        status: CapabilityStatus,
        reason_code: CapabilityReason,
        detail: impl Into<String>,
        endpoint_origin: Option<String>,
    ) -> Self {
        let safe_status = if status == CapabilityStatus::Available {
            CapabilityStatus::Error
        } else {
            status
        };
        Self {
            adapter,
            status: safe_status,
            reason_code,
            detail: detail.into(),
            endpoint_origin,
            source_verified: false,
            latency_ms: None,
        }
    }

    /// Convenience constructor for unconfigured adapters (`CapabilityStatus::Unavailable`).
    pub fn unconfigured(adapter: AdapterKind, config_key: &str) -> Self {
        Self::failure(
            adapter,
            CapabilityStatus::Unavailable,
            CapabilityReason::Unconfigured,
            format!("{config_key} is not configured; capability remains unavailable"),
            None,
        )
    }

    /// Returns `true` strictly when status is `Available` and `source_verified` is `true`.
    pub const fn is_operational(&self) -> bool {
        self.status.is_available() && self.source_verified
    }
}

impl Serialize for CapabilityReport {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut obj = Map::new();
        obj.insert("adapter".to_string(), json!(self.adapter));
        obj.insert("status".to_string(), json!(self.status));
        obj.insert("reason_code".to_string(), json!(self.reason_code));
        obj.insert("detail".to_string(), json!(self.detail));
        if let Some(origin) = &self.endpoint_origin {
            obj.insert("endpoint_origin".to_string(), json!(origin));
        }
        obj.insert("source_verified".to_string(), json!(self.source_verified));
        if let Some(latency_ms) = self.latency_ms {
            obj.insert("latency_ms".to_string(), json!(latency_ms));
        }
        Value::Object(obj).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for CapabilityReport {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let map = value
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("CapabilityReport must be a JSON object"))?;
        let adapter: AdapterKind = serde_json::from_value(
            map.get("adapter")
                .cloned()
                .ok_or_else(|| serde::de::Error::custom("missing adapter"))?,
        )
        .map_err(serde::de::Error::custom)?;
        let status: CapabilityStatus = serde_json::from_value(
            map.get("status")
                .cloned()
                .ok_or_else(|| serde::de::Error::custom("missing status"))?,
        )
        .map_err(serde::de::Error::custom)?;
        let reason_code: CapabilityReason = serde_json::from_value(
            map.get("reason_code")
                .cloned()
                .ok_or_else(|| serde::de::Error::custom("missing reason_code"))?,
        )
        .map_err(serde::de::Error::custom)?;
        let detail = map
            .get("detail")
            .and_then(Value::as_str)
            .ok_or_else(|| serde::de::Error::custom("missing string detail"))?
            .to_string();
        let endpoint_origin = match map.get("endpoint_origin") {
            None | Some(Value::Null) => None,
            Some(v) => Some(
                v.as_str()
                    .ok_or_else(|| serde::de::Error::custom("endpoint_origin must be string"))?
                    .to_string(),
            ),
        };
        let latency_ms =
            match map.get("latency_ms") {
                None | Some(Value::Null) => None,
                Some(v) => Some(v.as_u64().ok_or_else(|| {
                    serde::de::Error::custom("latency_ms must be unsigned integer")
                })?),
            };
        let source_verified = map
            .get("source_verified")
            .and_then(Value::as_bool)
            .ok_or_else(|| serde::de::Error::custom("missing bool source_verified"))?;

        // Enforce epistemic invariant even when deserializing external payloads.
        let enforced_verified = source_verified && status == CapabilityStatus::Available;
        Ok(Self {
            adapter,
            status,
            reason_code,
            detail,
            endpoint_origin,
            source_verified: enforced_verified,
            latency_ms,
        })
    }
}

/// Evaluates an optional adapter configuration value without fabricating availability.
pub fn probe_unconfigured_adapter(adapter: AdapterKind, config_name: &str) -> CapabilityReport {
    CapabilityReport::unconfigured(adapter, config_name)
}

/// Policy controlling endpoint loopback enforcement.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct EndpointUrlPolicy {
    /// Must remain `false` by default; `true` explicitly permits non-loopback control hosts.
    pub allow_non_loopback: bool,
}

/// Sanitized, validated endpoint URL descriptor shared across loopback adapters.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedEndpointUrl {
    /// Sanitized URL without userinfo.
    pub normalized_url: String,
    /// Canonical `scheme://host:port` origin without credentials, path, or query string.
    pub origin: String,
    /// Lowercase URL scheme (`http`, `https`, `ws`, or `wss`).
    pub scheme: String,
    /// Parsed host string (`127.0.0.1`, `localhost`, `[::1]`, or opted-in remote host).
    pub host: String,
    /// Host string formatted for socket resolution (IPv6 brackets stripped).
    pub connect_host: String,
    /// Resolved nonzero TCP port.
    pub port: u16,
    /// True when the parsed host is strictly loopback (`127.0.0.0/8`, `localhost`, or `::1`).
    pub is_loopback: bool,
    /// True when a non-loopback host was admitted via explicit opt-in.
    pub non_loopback_opted_in: bool,
}

impl Serialize for ValidatedEndpointUrl {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "normalized_url": self.normalized_url,
            "origin": self.origin,
            "scheme": self.scheme,
            "host": self.host,
            "connect_host": self.connect_host,
            "port": self.port,
            "is_loopback": self.is_loopback,
            "non_loopback_opted_in": self.non_loopback_opted_in,
        })
        .serialize(serializer)
    }
}

/// Validation failure returned by shared endpoint URL parsing.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum EndpointUrlError {
    /// Endpoint string was empty or whitespace-only.
    #[error("endpoint URL is not configured")]
    Unconfigured,
    /// Endpoint string failed URL parsing or contained control characters.
    #[error("invalid endpoint URL: {0}")]
    InvalidUrl(String),
    /// Endpoint scheme is outside the adapter's permitted list.
    #[error("unsupported URL scheme: {0}")]
    UnsupportedScheme(String),
    /// Embedded credentials (`user:pass@`) are forbidden in endpoint URLs.
    #[error("embedded credentials in endpoint URL are forbidden")]
    EmbeddedCredentials,
    /// Endpoint resolved without a valid nonzero port.
    #[error("endpoint URL is missing a valid nonzero port")]
    MissingPort,
    /// Non-loopback host was rejected under loopback-only policy.
    #[error("non-loopback endpoint host `{host}` rejected without explicit opt-in")]
    NonLoopbackForbidden {
        /// Rejected host identifier.
        host: String,
    },
}

impl EndpointUrlError {
    /// Converts this validation error into a truthful [`CapabilityReport`].
    pub fn to_capability_report(&self, adapter: AdapterKind) -> CapabilityReport {
        match self {
            Self::Unconfigured => CapabilityReport::unconfigured(adapter, "endpoint_url"),
            Self::InvalidUrl(msg) | Self::UnsupportedScheme(msg) => CapabilityReport::failure(
                adapter,
                CapabilityStatus::Error,
                CapabilityReason::InvalidUrl,
                msg.clone(),
                None,
            ),
            Self::EmbeddedCredentials => CapabilityReport::failure(
                adapter,
                CapabilityStatus::Blocked,
                CapabilityReason::EmbeddedCredentialsForbidden,
                self.to_string(),
                None,
            ),
            Self::MissingPort => CapabilityReport::failure(
                adapter,
                CapabilityStatus::Error,
                CapabilityReason::MissingPort,
                self.to_string(),
                None,
            ),
            Self::NonLoopbackForbidden { .. } => CapabilityReport::failure(
                adapter,
                CapabilityStatus::Blocked,
                CapabilityReason::NonLoopbackForbidden,
                self.to_string(),
                None,
            ),
        }
    }
}

/// Returns `true` strictly when `host` is `localhost`, `127.0.0.0/8`, or `::1`.
pub fn is_loopback_host(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
    }
}

/// Validates an endpoint URL against scheme, credential-free, port, and loopback rules.
pub fn validate_endpoint_url(
    raw_url: &str,
    allowed_schemes: &[&str],
    policy: EndpointUrlPolicy,
) -> Result<ValidatedEndpointUrl, EndpointUrlError> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err(EndpointUrlError::Unconfigured);
    }
    if trimmed.chars().any(char::is_control) {
        return Err(EndpointUrlError::InvalidUrl(
            "URL contains ASCII control characters".to_string(),
        ));
    }

    let parsed =
        Url::parse(trimmed).map_err(|err| EndpointUrlError::InvalidUrl(err.to_string()))?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if !allowed_schemes.iter().any(|allowed| *allowed == scheme) {
        return Err(EndpointUrlError::UnsupportedScheme(scheme));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(EndpointUrlError::EmbeddedCredentials);
    }

    let parsed_host = parsed
        .host()
        .ok_or_else(|| EndpointUrlError::InvalidUrl("URL is missing a host".to_string()))?;
    let host_str = parsed
        .host_str()
        .ok_or_else(|| EndpointUrlError::InvalidUrl("URL host string unavailable".to_string()))?
        .to_string();
    let connect_host = match parsed_host {
        Host::Ipv6(ip) => ip.to_string(),
        _ => host_str.clone(),
    };

    if parsed.port() == Some(0) {
        return Err(EndpointUrlError::MissingPort);
    }
    let port = parsed
        .port_or_known_default()
        .filter(|p| *p > 0)
        .ok_or(EndpointUrlError::MissingPort)?;

    let loopback = is_loopback_host(&parsed_host);
    if !loopback && !policy.allow_non_loopback {
        return Err(EndpointUrlError::NonLoopbackForbidden { host: host_str });
    }

    let origin = format!("{scheme}://{host_str}:{port}");
    Ok(ValidatedEndpointUrl {
        normalized_url: parsed.as_str().to_string(),
        origin,
        scheme,
        host: host_str,
        connect_host,
        port,
        is_loopback: loopback,
        non_loopback_opted_in: !loopback && policy.allow_non_loopback,
    })
}

/// Resolves `(connect_host, port)` and verifies resolved IPs obey the loopback policy.
pub(crate) fn resolve_permitted_addrs(
    connect_host: &str,
    port: u16,
    allow_non_loopback: bool,
) -> Result<Vec<SocketAddr>, CapabilityReport> {
    if connect_host.trim().is_empty() || port == 0 {
        return Err(CapabilityReport::failure(
            AdapterKind::BrowserCdp,
            CapabilityStatus::Error,
            CapabilityReason::InvalidUrl,
            "host and port must be non-empty and nonzero",
            None,
        ));
    }
    let addrs: Vec<SocketAddr> = (connect_host, port)
        .to_socket_addrs()
        .map_err(|err| {
            CapabilityReport::failure(
                AdapterKind::BrowserCdp,
                CapabilityStatus::Unavailable,
                CapabilityReason::EndpointUnreachable,
                format!("DNS/socket resolution failed: {err}"),
                None,
            )
        })?
        .collect();

    if addrs.is_empty() {
        return Err(CapabilityReport::failure(
            AdapterKind::BrowserCdp,
            CapabilityStatus::Unavailable,
            CapabilityReason::EndpointUnreachable,
            "no socket addresses resolved for endpoint",
            None,
        ));
    }

    if !allow_non_loopback && addrs.iter().any(|addr| !addr.ip().is_loopback()) {
        return Err(CapabilityReport::failure(
            AdapterKind::BrowserCdp,
            CapabilityStatus::Blocked,
            CapabilityReason::NonLoopbackForbidden,
            "resolved address is non-loopback without explicit opt-in",
            None,
        ));
    }
    Ok(addrs)
}

/// Probes TCP reachability against a host/port with strict loopback enforcement by default.
pub fn probe_loopback_tcp(
    adapter: AdapterKind,
    host: &str,
    port: u16,
    allow_non_loopback: bool,
    timeout: Duration,
) -> CapabilityReport {
    let trimmed_host = host.trim();
    if trimmed_host.is_empty() || port == 0 {
        return CapabilityReport::failure(
            adapter,
            CapabilityStatus::Error,
            CapabilityReason::MissingPort,
            "TCP probe requires a non-empty host and nonzero port",
            None,
        );
    }

    let normalized_for_url = if trimmed_host.contains(':') && !trimmed_host.starts_with('[') {
        format!("http://[{trimmed_host}]:{port}")
    } else {
        format!("http://{trimmed_host}:{port}")
    };
    let validated = match validate_endpoint_url(
        &normalized_for_url,
        &["http"],
        EndpointUrlPolicy { allow_non_loopback },
    ) {
        Ok(v) => v,
        Err(err) => return err.to_capability_report(adapter),
    };

    let bounded_timeout = clamp_timeout(timeout);
    let origin_display = format!("{}:{}", validated.host, validated.port);
    let addrs = match resolve_permitted_addrs(
        &validated.connect_host,
        validated.port,
        allow_non_loopback,
    ) {
        Ok(addrs) => addrs,
        Err(mut report) => {
            report.adapter = adapter;
            report.endpoint_origin = Some(origin_display);
            return report;
        }
    };

    let started = Instant::now();
    let mut last_err: Option<std::io::Error> = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, bounded_timeout) {
            Ok(stream) => {
                let _ = stream.shutdown(std::net::Shutdown::Both);
                let elapsed = started.elapsed().as_millis() as u64;
                return CapabilityReport::available(
                    adapter,
                    format!("loopback TCP handshake succeeded at {}", origin_display),
                    Some(origin_display),
                    Some(elapsed),
                );
            }
            Err(err) => last_err = Some(err),
        }
    }

    let is_timeout = last_err
        .as_ref()
        .is_some_and(|e| e.kind() == std::io::ErrorKind::TimedOut);
    let reason = if is_timeout {
        CapabilityReason::Timeout
    } else {
        CapabilityReason::EndpointUnreachable
    };
    let detail = match last_err {
        Some(err) => format!("TCP probe failed for {origin_display}: {err}"),
        None => format!("TCP probe failed for {origin_display}"),
    };
    CapabilityReport::failure(
        adapter,
        CapabilityStatus::Unavailable,
        reason,
        detail,
        Some(origin_display),
    )
}

/// Probes an optional endpoint URL with scheme validation and live TCP handshake.
pub fn probe_loopback_url_tcp(
    adapter: AdapterKind,
    raw_url: Option<&str>,
    allowed_schemes: &[&str],
    allow_non_loopback: bool,
    timeout: Duration,
) -> CapabilityReport {
    let Some(raw) = raw_url.map(str::trim).filter(|s| !s.is_empty()) else {
        return CapabilityReport::unconfigured(adapter, "endpoint_url");
    };
    let validated = match validate_endpoint_url(
        raw,
        allowed_schemes,
        EndpointUrlPolicy { allow_non_loopback },
    ) {
        Ok(v) => v,
        Err(err) => return err.to_capability_report(adapter),
    };
    let mut report = probe_loopback_tcp(
        adapter,
        &validated.connect_host,
        validated.port,
        allow_non_loopback,
        timeout,
    );
    report.endpoint_origin = Some(validated.origin);
    report
}

/// Internal HTTP probe failure classification mapped cleanly by adapter wrappers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum HttpProbeError {
    Blocked(String),
    Unreachable(String),
    Timeout(String),
    Protocol(String),
}

/// Performs a bounded HTTP/1.1 `GET` request over TCP for loopback JSON control endpoints.
///
/// Stops reading as soon as `Content-Length` bytes or the `0\r\n\r\n` chunked terminator arrive
/// so proxies or keep-alive servers do not stall until read timeout.
pub(crate) fn http_get_json_bounded(
    validated: &ValidatedEndpointUrl,
    path: &str,
    allow_non_loopback: bool,
    timeout: Duration,
    max_body_bytes: usize,
) -> Result<(u16, String), HttpProbeError> {
    let bounded_timeout = clamp_timeout(timeout);
    let mut stream = connect_loopback_stream(validated, allow_non_loopback, bounded_timeout)?;

    let clean_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let host_header = format!("{}:{}", validated.host, validated.port);
    let request = format!(
        "GET {clean_path} HTTP/1.1\r\nHost: {host_header}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(map_write_err)?;

    let (raw_headers, mut body_buf) =
        read_http_headers_with_tail(&mut stream, MAX_HTTP_HEADER_BYTES).map_err(|err| {
            if err.kind() == std::io::ErrorKind::UnexpectedEof {
                HttpProbeError::Unreachable("EOF before HTTP response headers".to_string())
            } else {
                map_read_err(err)
            }
        })?;

    let head = parse_http_head(&raw_headers)?;
    let body_bytes = if head.is_chunked {
        loop {
            if body_buf.len() > max_body_bytes + 64 * 1024 {
                return Err(HttpProbeError::Protocol(
                    "chunked HTTP body exceeded maximum body limit".to_string(),
                ));
            }
            if let Some(decoded) = try_decode_chunked_complete(&body_buf, max_body_bytes)? {
                break decoded;
            }
            if !read_more_into(&mut stream, &mut body_buf, max_body_bytes + 64 * 1024)? {
                return Err(HttpProbeError::Protocol(
                    "truncated chunked HTTP response body".to_string(),
                ));
            }
        }
    } else if let Some(len) = head.content_length {
        if len > max_body_bytes {
            return Err(HttpProbeError::Protocol(
                "HTTP Content-Length exceeded maximum body limit".to_string(),
            ));
        }
        while body_buf.len() < len {
            if !read_more_into(&mut stream, &mut body_buf, max_body_bytes)? {
                return Err(HttpProbeError::Protocol(
                    "truncated HTTP response body".to_string(),
                ));
            }
        }
        body_buf.truncate(len);
        body_buf
    } else {
        while read_more_into(&mut stream, &mut body_buf, max_body_bytes)? {}
        body_buf
    };

    let _ = stream.shutdown(std::net::Shutdown::Both);
    let body = String::from_utf8(body_bytes)
        .map_err(|_| HttpProbeError::Protocol("HTTP body is not valid UTF-8".to_string()))?;
    Ok((head.status_code, body))
}

/// Performs a bounded HTTP/1.1 WebSocket Upgrade (`101 Switching Protocols`) probe over TCP.
///
/// Stops reading at `\r\n\r\n` so live WebSocket servers return immediately while dead ports
/// behind transparent loopback proxies time out or close rather than falsely appearing `Available`.
pub(crate) fn ws_upgrade_handshake_bounded(
    validated: &ValidatedEndpointUrl,
    allow_non_loopback: bool,
    timeout: Duration,
) -> Result<(), HttpProbeError> {
    let bounded_timeout = clamp_timeout(timeout);
    let mut stream = connect_loopback_stream(validated, allow_non_loopback, bounded_timeout)?;

    let host_header = format!("{}:{}", validated.host, validated.port);
    let request = format!(
        "GET / HTTP/1.1\r\nHost: {host_header}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: b21uaWEtbWVkaWEtY2FwMQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(map_write_err)?;

    let (raw_headers, _) = read_http_headers_with_tail(&mut stream, MAX_HTTP_HEADER_BYTES)
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::UnexpectedEof {
                HttpProbeError::Unreachable(
                    "endpoint closed connection before WebSocket upgrade response".to_string(),
                )
            } else {
                map_read_err(err)
            }
        })?;

    let head = parse_http_head(&raw_headers)?;
    if head.status_code != 101 {
        return Err(HttpProbeError::Protocol(format!(
            "expected HTTP 101 Switching Protocols for WebSocket upgrade, got {}",
            head.status_code
        )));
    }
    if !head.has_websocket_upgrade {
        return Err(HttpProbeError::Protocol(
            "HTTP 101 response missing `Upgrade: websocket` header".to_string(),
        ));
    }
    let _ = stream.shutdown(std::net::Shutdown::Both);
    Ok(())
}

fn connect_loopback_stream(
    validated: &ValidatedEndpointUrl,
    allow_non_loopback: bool,
    bounded_timeout: Duration,
) -> Result<TcpStream, HttpProbeError> {
    let addrs =
        resolve_permitted_addrs(&validated.connect_host, validated.port, allow_non_loopback)
            .map_err(|report| match report.status {
                CapabilityStatus::Blocked => HttpProbeError::Blocked(report.detail),
                _ => HttpProbeError::Unreachable(report.detail),
            })?;

    let mut last_err: Option<std::io::Error> = None;
    let mut connected: Option<TcpStream> = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, bounded_timeout) {
            Ok(stream) => {
                connected = Some(stream);
                break;
            }
            Err(err) => last_err = Some(err),
        }
    }

    let stream = connected.ok_or_else(|| match last_err {
        Some(err) if err.kind() == std::io::ErrorKind::TimedOut => {
            HttpProbeError::Timeout(format!("TCP connect timed out: {err}"))
        }
        Some(err) => HttpProbeError::Unreachable(format!("TCP connect failed: {err}")),
        None => HttpProbeError::Unreachable("TCP connect failed".to_string()),
    })?;

    let _ = stream.set_read_timeout(Some(bounded_timeout));
    let _ = stream.set_write_timeout(Some(bounded_timeout));
    Ok(stream)
}

fn map_write_err(err: std::io::Error) -> HttpProbeError {
    if err.kind() == std::io::ErrorKind::TimedOut {
        HttpProbeError::Timeout(format!("HTTP write timed out: {err}"))
    } else {
        HttpProbeError::Unreachable(format!("HTTP write failed: {err}"))
    }
}

fn map_read_err(err: std::io::Error) -> HttpProbeError {
    if err.kind() == std::io::ErrorKind::TimedOut || err.kind() == std::io::ErrorKind::WouldBlock {
        HttpProbeError::Timeout(format!("HTTP read timed out: {err}"))
    } else if matches!(
        err.kind(),
        std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::BrokenPipe
    ) {
        HttpProbeError::Unreachable(format!("HTTP peer closed connection: {err}"))
    } else {
        HttpProbeError::Protocol(format!("HTTP read error: {err}"))
    }
}

struct ParsedHttpHead {
    status_code: u16,
    is_chunked: bool,
    content_length: Option<usize>,
    has_websocket_upgrade: bool,
}

fn read_http_headers_with_tail(
    stream: &mut TcpStream,
    header_limit: usize,
) -> std::io::Result<(Vec<u8>, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let tail = buf[pos + 4..].to_vec();
            buf.truncate(pos);
            return Ok((buf, tail));
        }
        match stream.read(&mut chunk) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "EOF before HTTP header terminator",
                ));
            }
            Ok(n) => {
                if buf.len().saturating_add(n) > header_limit {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "HTTP response headers exceeded maximum byte limit",
                    ));
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "socket read timed out before HTTP headers",
                ));
            }
            Err(err) => return Err(err),
        }
    }
}

fn read_more_into(
    stream: &mut TcpStream,
    buf: &mut Vec<u8>,
    limit: usize,
) -> Result<bool, HttpProbeError> {
    let mut chunk = [0u8; 4096];
    match stream.read(&mut chunk) {
        Ok(0) => Ok(false),
        Ok(n) => {
            if buf.len().saturating_add(n) > limit {
                return Err(HttpProbeError::Protocol(
                    "HTTP response body exceeded maximum byte limit".to_string(),
                ));
            }
            buf.extend_from_slice(&chunk[..n]);
            Ok(true)
        }
        Err(err) => Err(map_read_err(err)),
    }
}

fn parse_http_head(raw_headers: &[u8]) -> Result<ParsedHttpHead, HttpProbeError> {
    let header_text = std::str::from_utf8(raw_headers)
        .map_err(|_| HttpProbeError::Protocol("HTTP headers are not valid UTF-8".to_string()))?;
    let mut lines = header_text.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| HttpProbeError::Protocol("missing HTTP status line".to_string()))?;
    let mut parts = status_line.split_whitespace();
    let http_ver = parts.next().unwrap_or("");
    if !http_ver.starts_with("HTTP/1.") {
        return Err(HttpProbeError::Protocol(format!(
            "unsupported HTTP status line: {status_line}"
        )));
    }
    let status_code = parts
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| HttpProbeError::Protocol("invalid HTTP status code".to_string()))?;

    let mut is_chunked = false;
    let mut content_length: Option<usize> = None;
    let mut has_websocket_upgrade = false;
    for line in lines {
        if let Some((name, val)) = line.split_once(':') {
            let trimmed_name = name.trim();
            if trimmed_name.eq_ignore_ascii_case("transfer-encoding")
                && val.to_ascii_lowercase().contains("chunked")
            {
                is_chunked = true;
            } else if trimmed_name.eq_ignore_ascii_case("content-length") {
                let parsed_len = val.trim().parse::<usize>().map_err(|_| {
                    HttpProbeError::Protocol(format!(
                        "invalid Content-Length header: {}",
                        val.trim()
                    ))
                })?;
                if let Some(prev) = content_length {
                    if prev != parsed_len {
                        return Err(HttpProbeError::Protocol(
                            "conflicting Content-Length headers".to_string(),
                        ));
                    }
                }
                content_length = Some(parsed_len);
            } else if trimmed_name.eq_ignore_ascii_case("upgrade")
                && val.to_ascii_lowercase().contains("websocket")
            {
                has_websocket_upgrade = true;
            }
        }
    }

    Ok(ParsedHttpHead {
        status_code,
        is_chunked,
        content_length,
        has_websocket_upgrade,
    })
}

fn try_decode_chunked_complete(
    mut raw: &[u8],
    max_body_bytes: usize,
) -> Result<Option<Vec<u8>>, HttpProbeError> {
    let mut out = Vec::new();
    loop {
        let Some(crlf) = raw.windows(2).position(|w| w == b"\r\n") else {
            return Ok(None);
        };
        let size_line = std::str::from_utf8(&raw[..crlf])
            .map_err(|_| HttpProbeError::Protocol("invalid chunk size UTF-8".to_string()))?;
        let hex_size = size_line.split(';').next().unwrap_or("").trim();
        let chunk_len = usize::from_str_radix(hex_size, 16)
            .map_err(|_| HttpProbeError::Protocol("invalid hex chunk size".to_string()))?;
        raw = &raw[crlf + 2..];
        if chunk_len == 0 {
            if raw.len() < 2 {
                return Ok(None);
            }
            if &raw[..2] != b"\r\n" {
                return Err(HttpProbeError::Protocol(
                    "malformed 0-length HTTP chunk terminator".to_string(),
                ));
            }
            return Ok(Some(out));
        }
        if out.len().saturating_add(chunk_len) > max_body_bytes {
            return Err(HttpProbeError::Protocol(
                "chunked HTTP body exceeded maximum body limit".to_string(),
            ));
        }
        if raw.len() < chunk_len + 2 {
            return Ok(None);
        }
        if &raw[chunk_len..chunk_len + 2] != b"\r\n" {
            return Err(HttpProbeError::Protocol(
                "malformed HTTP chunk terminator".to_string(),
            ));
        }
        out.extend_from_slice(&raw[..chunk_len]);
        raw = &raw[chunk_len + 2..];
    }
}

fn clamp_timeout(timeout: Duration) -> Duration {
    let ms = timeout.as_millis() as u64;
    Duration::from_millis(ms.clamp(50, MAX_PROBE_TIMEOUT_MS))
}

/// Shared JSON object lookup helpers used across parser modules.
pub(crate) fn json_required_non_empty_str(
    obj: &Map<String, Value>,
    key: &str,
) -> Result<String, String> {
    match obj.get(key) {
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(s.clone()),
        Some(Value::String(_)) => Err(format!("field `{key}` must be non-empty")),
        Some(_) => Err(format!("field `{key}` must be a JSON string")),
        None => Err(format!("missing required field `{key}`")),
    }
}

pub(crate) fn json_optional_str(
    obj: &Map<String, Value>,
    key: &str,
) -> Result<Option<String>, String> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            if s.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(s.clone()))
            }
        }
        Some(_) => Err(format!("optional field `{key}` must be a string or null")),
    }
}
