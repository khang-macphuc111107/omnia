//! Chromium DevTools Protocol (CDP) endpoint validator, `/json/version` & `/json/list` parsers,
//! and live loopback discovery probe.

use crate::capability::{
    http_get_json_bounded, json_optional_str, json_required_non_empty_str, validate_endpoint_url,
    AdapterKind, CapabilityReason, CapabilityReport, CapabilityStatus, EndpointUrlError,
    EndpointUrlPolicy, HttpProbeError, ValidatedEndpointUrl, MAX_LOOPBACK_HTTP_BODY_BYTES,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub use crate::browser_ws::{
    create_isolated_profile_dir, is_forbidden_live_browser_path, launch_isolated_browser,
    resolve_isolated_browser_binary, CdpSession, IsolatedBrowserHandle,
    IsolatedBrowserLaunchOptions,
};
use thiserror::Error;

/// Permitted URL schemes for CDP HTTP discovery and WebSocket debugger endpoints.
const CDP_URL_SCHEMES: &[&str] = &["http", "https", "ws", "wss"];
/// Permitted HTTP schemes when probing `/json/version` and `/json/list`.
const CDP_HTTP_SCHEMES: &[&str] = &["http", "https"];
/// Permitted WebSocket schemes for `webSocketDebuggerUrl` fields.
const CDP_WS_SCHEMES: &[&str] = &["ws", "wss"];

/// Policy controlling whether non-loopback CDP endpoints are permitted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct CdpEndpointPolicy {
    /// Default `false` restricts CDP control URLs to `127.0.0.1`, `localhost`, or `[::1]`.
    pub allow_non_loopback: bool,
}

impl From<CdpEndpointPolicy> for EndpointUrlPolicy {
    fn from(value: CdpEndpointPolicy) -> Self {
        Self {
            allow_non_loopback: value.allow_non_loopback,
        }
    }
}

/// Validated CDP endpoint URL descriptor.
pub type ValidatedCdpUrl = ValidatedEndpointUrl;

/// Parsed `/json/version` metadata reported by a Chromium/Edge CDP server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CdpVersionInfo {
    /// Browser product/version string (for example `Edg/130.0.2849.68`).
    pub browser: String,
    /// CDP protocol version (for example `1.3`).
    pub protocol_version: String,
    /// Optional browser User-Agent string.
    pub user_agent: Option<String>,
    /// Optional V8 JavaScript engine version.
    pub v8_version: Option<String>,
    /// Optional Blink/WebKit engine version.
    pub webkit_version: Option<String>,
    /// Optional browser-level `webSocketDebuggerUrl`.
    pub websocket_debugger_url: Option<String>,
}

impl Serialize for CdpVersionInfo {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "Browser": self.browser,
            "Protocol-Version": self.protocol_version,
            "User-Agent": self.user_agent,
            "V8-Version": self.v8_version,
            "WebKit-Version": self.webkit_version,
            "webSocketDebuggerUrl": self.websocket_debugger_url,
        })
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for CdpVersionInfo {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        parse_cdp_version_value(&value).map_err(serde::de::Error::custom)
    }
}

/// Parsed target entry from `/json/list`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CdpTargetInfo {
    /// Stable target identifier within the browser session.
    pub id: String,
    /// Target classification (`page`, `iframe`, `worker`, `service_worker`, etc.).
    pub target_type: String,
    /// Target page title.
    pub title: String,
    /// Target page URL.
    pub url: String,
    /// Optional target description.
    pub description: Option<String>,
    /// Optional relative DevTools frontend path.
    pub devtools_frontend_url: Option<String>,
    /// Optional per-target `webSocketDebuggerUrl`.
    pub websocket_debugger_url: Option<String>,
}

impl Serialize for CdpTargetInfo {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "id": self.id,
            "type": self.target_type,
            "title": self.title,
            "url": self.url,
            "description": self.description,
            "devtoolsFrontendUrl": self.devtools_frontend_url,
            "webSocketDebuggerUrl": self.websocket_debugger_url,
        })
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for CdpTargetInfo {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        parse_cdp_target_value(&value).map_err(serde::de::Error::custom)
    }
}

/// Snapshot returned after a verified live CDP `/json/version` + `/json/list` probe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CdpProbeSnapshot {
    /// Validated endpoint URL details.
    pub endpoint: ValidatedCdpUrl,
    /// Parsed `/json/version` metadata.
    pub version: CdpVersionInfo,
    /// Parsed `/json/list` target descriptors.
    pub targets: Vec<CdpTargetInfo>,
}

impl Serialize for CdpProbeSnapshot {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "endpoint": self.endpoint,
            "version": self.version,
            "targets": self.targets,
        })
        .serialize(serializer)
    }
}

/// Errors produced during CDP URL validation, payload parsing, or endpoint probing.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum CdpError {
    /// Endpoint URL validation failed.
    #[error(transparent)]
    Endpoint(#[from] EndpointUrlError),
    /// CDP payload failed JSON syntax or schema checks.
    #[error("malformed CDP payload: {0}")]
    MalformedPayload(String),
    /// Discovery endpoint returned a non-200 HTTP status code.
    #[error("CDP endpoint returned HTTP status {0}")]
    HttpStatus(u16),
    /// Discovery endpoint could not be reached.
    #[error("CDP endpoint unreachable: {0}")]
    Unreachable(String),
}

impl CdpError {
    /// Converts this CDP error into a truthful [`CapabilityReport`].
    pub fn to_capability_report(&self, origin: Option<String>) -> CapabilityReport {
        match self {
            Self::Endpoint(err) => {
                let mut report = err.to_capability_report(AdapterKind::BrowserCdp);
                if report.endpoint_origin.is_none() {
                    report.endpoint_origin = origin;
                }
                report
            }
            Self::MalformedPayload(detail) => CapabilityReport::failure(
                AdapterKind::BrowserCdp,
                CapabilityStatus::Error,
                CapabilityReason::ProtocolError,
                detail.clone(),
                origin,
            ),
            Self::HttpStatus(code) => CapabilityReport::failure(
                AdapterKind::BrowserCdp,
                CapabilityStatus::Error,
                CapabilityReason::ProtocolError,
                format!("CDP HTTP endpoint returned non-200 status {code}"),
                origin,
            ),
            Self::Unreachable(detail) => CapabilityReport::failure(
                AdapterKind::BrowserCdp,
                CapabilityStatus::Unavailable,
                CapabilityReason::EndpointUnreachable,
                detail.clone(),
                origin,
            ),
        }
    }
}

/// Validates a CDP control URL under strict loopback-only policy (`127.0.0.1`, `localhost`, `[::1]`).
pub fn validate_loopback_cdp_url(raw_url: &str) -> Result<ValidatedCdpUrl, CdpError> {
    validate_cdp_url_with_policy(raw_url, CdpEndpointPolicy::default())
}

/// Validates a CDP control URL using the provided [`CdpEndpointPolicy`].
pub fn validate_cdp_url_with_policy(
    raw_url: &str,
    policy: CdpEndpointPolicy,
) -> Result<ValidatedCdpUrl, CdpError> {
    Ok(validate_endpoint_url(
        raw_url,
        CDP_URL_SCHEMES,
        policy.into(),
    )?)
}

/// Parses a Chromium/Edge `/json/version` JSON response into [`CdpVersionInfo`].
pub fn parse_cdp_version(raw_json: &str) -> Result<CdpVersionInfo, CdpError> {
    let value: Value = serde_json::from_str(raw_json)
        .map_err(|err| CdpError::MalformedPayload(format!("invalid /json/version JSON: {err}")))?;
    parse_cdp_version_value(&value).map_err(CdpError::MalformedPayload)
}

/// Parses a Chromium/Edge `/json/list` JSON array response into [`CdpTargetInfo`] entries.
pub fn parse_cdp_list(raw_json: &str) -> Result<Vec<CdpTargetInfo>, CdpError> {
    let value: Value = serde_json::from_str(raw_json)
        .map_err(|err| CdpError::MalformedPayload(format!("invalid /json/list JSON: {err}")))?;
    let items = value
        .as_array()
        .ok_or_else(|| CdpError::MalformedPayload("/json/list must be a JSON array".to_string()))?;
    let mut targets = Vec::with_capacity(items.len());
    for (idx, item) in items.iter().enumerate() {
        let target = parse_cdp_target_value(item).map_err(|err| {
            CdpError::MalformedPayload(format!("/json/list[{idx}] invalid: {err}"))
        })?;
        targets.push(target);
    }
    Ok(targets)
}

/// Probes a live CDP HTTP endpoint (`/json/version` and `/json/list`) and returns a truthful capability receipt.
///
/// Returns `Unavailable` when `raw_url` is unconfigured or the endpoint refuses connection.
pub fn probe_cdp_endpoint(
    raw_url: Option<&str>,
    policy: CdpEndpointPolicy,
    timeout: Duration,
) -> (CapabilityReport, Option<CdpProbeSnapshot>) {
    let Some(raw) = raw_url.map(str::trim).filter(|s| !s.is_empty()) else {
        return (
            CapabilityReport::unconfigured(AdapterKind::BrowserCdp, "cdp_endpoint_url"),
            None,
        );
    };

    let validated = match validate_endpoint_url(raw, CDP_HTTP_SCHEMES, policy.into()) {
        Ok(v) => v,
        Err(err) => return (err.to_capability_report(AdapterKind::BrowserCdp), None),
    };

    let started = Instant::now();
    let version_body = match fetch_cdp_json(&validated, "/json/version", policy, timeout) {
        Ok(body) => body,
        Err(report) => return (report, None),
    };
    let version = match parse_cdp_version(&version_body) {
        Ok(v) => v,
        Err(err) => {
            return (
                err.to_capability_report(Some(validated.origin.clone())),
                None,
            )
        }
    };

    // Enforce the same loopback policy on advertised WebSocket debugger URLs.
    if let Some(ws_url) = version.websocket_debugger_url.as_deref() {
        if let Err(err) = validate_endpoint_url(ws_url, CDP_WS_SCHEMES, policy.into()) {
            let mut report = err.to_capability_report(AdapterKind::BrowserCdp);
            report.endpoint_origin = Some(validated.origin.clone());
            return (report, None);
        }
    }

    let list_body = match fetch_cdp_json(&validated, "/json/list", policy, timeout) {
        Ok(body) => body,
        Err(report) => return (report, None),
    };
    let targets = match parse_cdp_list(&list_body) {
        Ok(t) => t,
        Err(err) => {
            return (
                err.to_capability_report(Some(validated.origin.clone())),
                None,
            )
        }
    };

    let latency_ms = started.elapsed().as_millis() as u64;
    let origin = validated.origin.clone();
    let target_count = targets.len();
    let browser_name = version.browser.clone();
    let snapshot = CdpProbeSnapshot {
        endpoint: validated,
        version,
        targets,
    };
    let report = CapabilityReport::available(
        AdapterKind::BrowserCdp,
        format!("CDP verified ({browser_name}, {target_count} target(s)) at {origin}"),
        Some(origin),
        Some(latency_ms),
    );
    (report, Some(snapshot))
}

fn fetch_cdp_json(
    validated: &ValidatedCdpUrl,
    path: &str,
    policy: CdpEndpointPolicy,
    timeout: Duration,
) -> Result<String, CapabilityReport> {
    let origin = Some(validated.origin.clone());
    match http_get_json_bounded(
        validated,
        path,
        policy.allow_non_loopback,
        timeout,
        MAX_LOOPBACK_HTTP_BODY_BYTES,
    ) {
        Ok((200, body)) => Ok(body),
        Ok((status, _)) => Err(CdpError::HttpStatus(status).to_capability_report(origin)),
        Err(HttpProbeError::Blocked(detail)) => Err(CapabilityReport::failure(
            AdapterKind::BrowserCdp,
            CapabilityStatus::Blocked,
            CapabilityReason::NonLoopbackForbidden,
            detail,
            origin,
        )),
        Err(HttpProbeError::Timeout(detail)) => Err(CapabilityReport::failure(
            AdapterKind::BrowserCdp,
            CapabilityStatus::Unavailable,
            CapabilityReason::Timeout,
            detail,
            origin,
        )),
        Err(HttpProbeError::Unreachable(detail)) => {
            Err(CdpError::Unreachable(detail).to_capability_report(origin))
        }
        Err(HttpProbeError::Protocol(detail)) => {
            Err(CdpError::MalformedPayload(detail).to_capability_report(origin))
        }
    }
}

fn parse_cdp_version_value(value: &Value) -> Result<CdpVersionInfo, String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "/json/version must be a JSON object".to_string())?;
    let browser = json_required_non_empty_str(obj, "Browser")?;
    let protocol_version = json_required_non_empty_str(obj, "Protocol-Version")?;
    let user_agent = json_optional_str(obj, "User-Agent")?;
    let v8_version = json_optional_str(obj, "V8-Version")?;
    let webkit_version = json_optional_str(obj, "WebKit-Version")?;
    let websocket_debugger_url = json_optional_str(obj, "webSocketDebuggerUrl")?;

    if let Some(ws_url) = websocket_debugger_url.as_deref() {
        validate_endpoint_url(
            ws_url,
            CDP_WS_SCHEMES,
            EndpointUrlPolicy {
                allow_non_loopback: true,
            },
        )
        .map_err(|err| format!("invalid webSocketDebuggerUrl: {err}"))?;
    }

    Ok(CdpVersionInfo {
        browser,
        protocol_version,
        user_agent,
        v8_version,
        webkit_version,
        websocket_debugger_url,
    })
}

fn parse_cdp_target_value(value: &Value) -> Result<CdpTargetInfo, String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "target entry must be a JSON object".to_string())?;
    let id = json_required_non_empty_str(obj, "id")?;
    let target_type = json_required_non_empty_str(obj, "type")?;
    let title = json_optional_str_raw(obj, "title")?;
    let url = json_optional_str_raw(obj, "url")?;
    let description = json_optional_str(obj, "description")?;
    let devtools_frontend_url = json_optional_str(obj, "devtoolsFrontendUrl")?;
    let websocket_debugger_url = json_optional_str(obj, "webSocketDebuggerUrl")?;

    if let Some(ws_url) = websocket_debugger_url.as_deref() {
        validate_endpoint_url(
            ws_url,
            CDP_WS_SCHEMES,
            EndpointUrlPolicy {
                allow_non_loopback: true,
            },
        )
        .map_err(|err| format!("invalid target webSocketDebuggerUrl: {err}"))?;
    }

    Ok(CdpTargetInfo {
        id,
        target_type,
        title,
        url,
        description,
        devtools_frontend_url,
        websocket_debugger_url,
    })
}

fn json_optional_str_raw(
    obj: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, String> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) => Ok(s.clone()),
        Some(_) => Err(format!("field `{key}` must be a string or null")),
    }
}
