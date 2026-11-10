use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use tauri::{Manager, Webview};

use crate::error::{NativeError, NativeResult};
use crate::ipc_session::{session_state_unavailable, CoreSessionRegistry, EstablishedCoreSession};

pub const PROTOCOL_VERSION: &str = "1.0";

const REQUIRED_CLIENT_CAPABILITIES: &[&str] = &["run.stream.v1"];
const MAX_PROTOCOL_VERSION_BYTES: usize = 32;
const MAX_CLIENT_CAPABILITIES: usize = 256;
const MAX_CLIENT_CAPABILITY_BYTES: usize = 128;

const CHAT_PHASE_SERVER_CAPABILITIES: &[&str] = &[
    "conversation.durable.v1",
    "project.v1",
    "provider.byok.v1",
    "provider.capability-negotiation.v1",
    "run.cancel.v1",
    "run.stream.v1",
    "secret.opaque-ref.v1",
    "workspace.read.v1",
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InitializeClientInfo {
    pub(crate) name: String,
    pub(crate) title: String,
    pub(crate) version: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitializeRequest {
    protocol_version: String,
    client_info: InitializeClientInfo,
    #[serde(default)]
    capabilities: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreInitializeResponse {
    protocol_version: &'static str,
    server_info: ServerInfo,
    capabilities: Vec<&'static str>,
    unavailable_capabilities: Vec<&'static str>,
    session_token: String,
    session_epoch: u64,
}

impl std::fmt::Debug for CoreInitializeResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CoreInitializeResponse")
            .field("protocol_version", &self.protocol_version)
            .field("server_info", &self.server_info)
            .field("capabilities", &self.capabilities)
            .field("unavailable_capabilities", &self.unavailable_capabilities)
            .field("session_token", &"[redacted]")
            .field("session_epoch", &self.session_epoch)
            .finish()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerInfo {
    name: &'static str,
    title: &'static str,
    version: &'static str,
}

#[derive(Debug)]
struct NegotiatedInitialize {
    client_info: InitializeClientInfo,
    capabilities: Vec<String>,
}

/// Negotiate the renderer/core contract and create exactly one session for the
/// current webview document.
#[tauri::command]
pub fn core_initialize(
    request: InitializeRequest,
    webview: Webview,
) -> NativeResult<CoreInitializeResponse> {
    let negotiated = negotiate_initialize_request(request)?;
    let sessions = webview
        .try_state::<CoreSessionRegistry>()
        .ok_or_else(session_state_unavailable)?;
    let session = sessions.establish(
        webview.label(),
        negotiated.client_info,
        negotiated.capabilities,
    )?;
    Ok(initialize_response(session))
}

fn negotiate_initialize_request(request: InitializeRequest) -> NativeResult<NegotiatedInitialize> {
    validate_version(&request.protocol_version)?;
    validate_client_info(&request.client_info)?;
    let capabilities = validate_client_capabilities(request.capabilities)?;
    ensure_required_capabilities(&capabilities)?;
    Ok(NegotiatedInitialize {
        client_info: request.client_info,
        capabilities,
    })
}

fn initialize_response(session: EstablishedCoreSession) -> CoreInitializeResponse {
    CoreInitializeResponse {
        protocol_version: PROTOCOL_VERSION,
        server_info: ServerInfo {
            name: "omnia-core",
            title: "Omnia Core",
            version: env!("CARGO_PKG_VERSION"),
        },
        capabilities: CHAT_PHASE_SERVER_CAPABILITIES.to_vec(),
        // These remain unavailable until their sandbox, approval and audit
        // boundaries are production-wired and verified.
        unavailable_capabilities: vec![
            "run.replay-cursor",
            "server-request.resolve",
            "skill.prompt-only",
            "memory.read-write",
            "workspace.write",
            "process.execute",
            "browser.control",
            "computer.control",
        ],
        session_token: session.token,
        session_epoch: session.epoch,
    }
}

fn validate_version(version: &str) -> NativeResult<()> {
    if version.is_empty()
        || version.len() > MAX_PROTOCOL_VERSION_BYTES
        || version.chars().any(char::is_control)
    {
        return Err(NativeError::invalid(
            "protocolVersion",
            "must be a nonempty bounded identifier",
        ));
    }
    if version == PROTOCOL_VERSION {
        return Ok(());
    }
    Err(NativeError::new(
        "unsupported_protocol_version",
        format!("The client protocol is incompatible with Omnia Core {PROTOCOL_VERSION}"),
    ))
}

fn validate_client_capabilities(capabilities: Vec<String>) -> NativeResult<Vec<String>> {
    if capabilities.len() > MAX_CLIENT_CAPABILITIES {
        return Err(NativeError::invalid(
            "capabilities",
            format!("must contain at most {MAX_CLIENT_CAPABILITIES} entries"),
        ));
    }
    let mut seen = BTreeSet::new();
    for capability in &capabilities {
        if capability.is_empty()
            || capability.len() > MAX_CLIENT_CAPABILITY_BYTES
            || capability
                .chars()
                .any(|character| character.is_control() || character.is_whitespace())
            || !seen.insert(capability.as_str())
        {
            return Err(NativeError::invalid(
                "capabilities",
                "contains an invalid, duplicate, or oversized identifier",
            ));
        }
    }
    Ok(capabilities)
}

fn ensure_required_capabilities(advertised: &[String]) -> NativeResult<()> {
    let missing = REQUIRED_CLIENT_CAPABILITIES
        .iter()
        .copied()
        .filter(|required| !advertised.iter().any(|value| value == required))
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }
    Err(NativeError::new(
        "incompatible_client",
        format!(
            "The client does not support required core capabilities: {}",
            missing.join(", ")
        ),
    ))
}

fn validate_client_info(info: &InitializeClientInfo) -> NativeResult<()> {
    for (field, value, max) in [
        ("clientInfo.name", info.name.as_str(), 80_usize),
        ("clientInfo.title", info.title.as_str(), 120_usize),
        ("clientInfo.version", info.version.as_str(), 40_usize),
    ] {
        let value = value.trim();
        if value.is_empty() {
            return Err(NativeError::invalid(field, "cannot be empty"));
        }
        if value.chars().count() > max || value.chars().any(char::is_control) {
            return Err(NativeError::invalid(
                field,
                format!("must be at most {max} printable characters"),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compatible_request() -> InitializeRequest {
        InitializeRequest {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            client_info: InitializeClientInfo {
                name: "omnia-desktop".into(),
                title: "Omnia Desktop".into(),
                version: "0.1.0".into(),
            },
            capabilities: REQUIRED_CLIENT_CAPABILITIES
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
        }
    }

    #[test]
    fn negotiates_only_chat_phase_capabilities() {
        let negotiated = negotiate_initialize_request(compatible_request())
            .expect("compatible request should negotiate");
        let response = initialize_response(EstablishedCoreSession {
            token: "a".repeat(64),
            epoch: 1,
        });

        assert_eq!(negotiated.client_info.name, "omnia-desktop");
        assert_eq!(negotiated.capabilities, vec!["run.stream.v1"]);
        assert_eq!(response.protocol_version, PROTOCOL_VERSION);
        assert!(response.capabilities.contains(&"conversation.durable.v1"));
        assert!(response.capabilities.contains(&"workspace.read.v1"));
        assert!(!response.capabilities.contains(&"workspace.write.v1"));
        assert!(response
            .unavailable_capabilities
            .contains(&"process.execute"));
        assert_eq!(response.session_epoch, 1);
    }

    #[test]
    fn rejects_unknown_protocol_generations() {
        let mut request = compatible_request();
        request.protocol_version = "2.0".into();
        let error =
            negotiate_initialize_request(request).expect_err("version mismatch must fail closed");
        assert_eq!(error.code, "unsupported_protocol_version");
    }

    #[test]
    fn rejects_clients_without_stream_support() {
        let mut request = compatible_request();
        request.capabilities.clear();
        let error = negotiate_initialize_request(request)
            .expect_err("capability mismatch must fail closed");
        assert_eq!(error.code, "incompatible_client");
    }

    #[test]
    fn rejects_oversized_or_control_character_protocol_input_without_echoing_it() {
        let mut request = compatible_request();
        request.protocol_version = format!("{}\nsecret", "v".repeat(MAX_PROTOCOL_VERSION_BYTES));
        let error =
            negotiate_initialize_request(request).expect_err("oversized versions must fail closed");
        assert_eq!(error.code, "invalid_input");
        assert!(!error.message.contains("secret"));
    }

    #[test]
    fn rejects_unbounded_malformed_or_duplicate_capability_lists() {
        let mut request = compatible_request();
        request.capabilities = vec!["capability".to_owned(); MAX_CLIENT_CAPABILITIES + 1];
        assert_eq!(
            negotiate_initialize_request(request).unwrap_err().code,
            "invalid_input"
        );

        let mut request = compatible_request();
        request.capabilities.push("unsafe capability".to_owned());
        assert_eq!(
            negotiate_initialize_request(request).unwrap_err().code,
            "invalid_input"
        );

        let mut request = compatible_request();
        request.capabilities.push("run.stream.v1".to_owned());
        assert_eq!(
            negotiate_initialize_request(request).unwrap_err().code,
            "invalid_input"
        );
    }

    #[test]
    fn rejects_invalid_client_metadata() {
        let mut request = compatible_request();
        request.client_info.name = " \n".to_owned();
        assert_eq!(
            negotiate_initialize_request(request).unwrap_err().code,
            "invalid_input"
        );
    }

    #[test]
    fn debug_output_redacts_the_session_token() {
        let response = initialize_response(EstablishedCoreSession {
            token: "a".repeat(64),
            epoch: 1,
        });
        let debug = format!("{response:?}");
        assert!(debug.contains("[redacted]"));
        assert!(!debug.contains(&"a".repeat(64)));
    }
}
