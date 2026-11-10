//! Content-free inspection receipts for installed plugin MCP connectors.
//! These facts describe configuration, never grant permission or prove login.

use std::collections::BTreeSet;

use omnia_harness::mcp::{expand_plugin_server, McpTransportConfig};
use omnia_harness::plugins::{Plugin, PluginScope, ROOT_ENV};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{NativeError, NativeResult};

const MAX_CONNECTIONS: usize = 256;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginConnectionState {
    Disabled,
    WorkspaceTrustRequired,
    MissingEnvironment,
    InvalidConfiguration,
    Configured,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConnectionReceipt {
    pub schema_version: u32,
    pub receipt_id: String,
    pub plugin_name: String,
    pub plugin_version: String,
    pub plugin_scope: PluginScope,
    pub server_name: String,
    pub configuration_sha256: String,
    pub configuration_snapshot_sha256: String,
    pub workspace_fingerprint: String,
    pub workspace_trusted: bool,
    pub transport: String,
    /// Origin only. User info, paths, query strings and fragments are excluded.
    pub endpoint_origin: Option<String>,
    pub required_environment: Vec<String>,
    pub missing_environment: Vec<String>,
    pub has_configured_headers: bool,
    pub state: PluginConnectionState,
    /// Configuration inspection cannot substitute for per-tool permissions.
    pub permission_boundary: &'static str,
    pub live_authentication_verified: bool,
}

fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

/// Extracts the same `${VAR}` / `${VAR:-default}` references understood by
/// the MCP loader, reporting only names and presence, never values.
fn environment_requirements(
    value: &Value,
    lookup: &dyn Fn(&str) -> Option<String>,
    required: &mut BTreeSet<String>,
    missing: &mut BTreeSet<String>,
) {
    match value {
        Value::String(text) => {
            let mut rest = text.as_str();
            while let Some(start) = rest.find("${") {
                let after = &rest[start + 2..];
                let Some(end) = after.find('}') else { break };
                let (name, fallback) = match after[..end].split_once(":-") {
                    Some((name, fallback)) => (name.trim(), Some(fallback)),
                    None => (after[..end].trim(), None),
                };
                // Never reflect arbitrary template text or secret-like defaults.
                if name != ROOT_ENV
                    && !name.is_empty()
                    && name.len() <= 128
                    && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                {
                    required.insert(name.to_owned());
                    if !lookup(name).is_some_and(|value| !value.is_empty())
                        && !fallback.is_some_and(|value| !value.is_empty())
                    {
                        missing.insert(name.to_owned());
                    }
                }
                rest = &after[end + 1..];
            }
        }
        Value::Array(values) => {
            for value in values {
                environment_requirements(value, lookup, required, missing);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                environment_requirements(value, lookup, required, missing);
            }
        }
        _ => {}
    }
}

pub fn inspect_plugin_connections(
    plugin: &Plugin,
    bytes: &[u8],
    configuration_snapshot_sha256: &str,
    workspace_fingerprint: &str,
    workspace_trusted: bool,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> NativeResult<Vec<PluginConnectionReceipt>> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        NativeError::new(
            "plugin_connection_config_invalid",
            "Plugin MCP configuration is not UTF-8",
        )
    })?;
    let root: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| {
        NativeError::new(
            "plugin_connection_config_invalid",
            "Plugin MCP configuration is not valid JSON",
        )
    })?;
    if !root.is_object() {
        return Err(NativeError::new(
            "plugin_connection_config_invalid",
            "Plugin MCP configuration must be an object",
        ));
    }
    let Some(servers) = root.get("mcpServers").or_else(|| root.get("servers")) else {
        return Ok(Vec::new());
    };
    let servers = servers.as_object().ok_or_else(|| {
        NativeError::new(
            "plugin_connection_config_invalid",
            "Plugin MCP servers must be an object",
        )
    })?;
    if servers.len() > MAX_CONNECTIONS {
        return Err(NativeError::new(
            "plugin_connection_limit",
            "Plugin has too many MCP connections to inspect",
        ));
    }
    let mut receipts = Vec::new();
    for (server, value) in servers {
        // Server names are metadata. Do not let an arbitrary huge name inflate
        // the redacted receipt or put control sequences into an inspector.
        if server.is_empty() || server.len() > 256 || server.chars().any(char::is_control) {
            return Err(NativeError::new(
                "plugin_connection_config_invalid",
                "Plugin MCP server name is invalid",
            ));
        }
        let mut required = BTreeSet::new();
        let mut missing = BTreeSet::new();
        environment_requirements(value, lookup, &mut required, &mut missing);
        if required.len() > 256 {
            return Err(NativeError::new(
                "plugin_connection_limit",
                "Plugin MCP connection references too many environment values",
            ));
        }
        let mut transport = "unknown".to_owned();
        let mut endpoint_origin = None;
        let mut has_headers = false;
        let parsed = expand_plugin_server(&plugin.name, &plugin.path, server, value, lookup);
        let (disabled, valid) = match parsed {
            Ok((_, config)) => {
                let valid = match config.transport {
                    McpTransportConfig::Stdio { command, .. } => {
                        transport = "stdio".into();
                        !command.trim().is_empty()
                    }
                    McpTransportConfig::Http { url, headers, .. } => {
                        transport = "http".into();
                        has_headers = !headers.is_empty();
                        match url::Url::parse(&url) {
                            Ok(url)
                                if matches!(url.scheme(), "http" | "https")
                                    && url.host_str().is_some()
                                    && url.username().is_empty()
                                    && url.password().is_none() =>
                            {
                                // Expanding an environment variable in the host
                                // can place a credential in the origin itself.
                                let dynamic_authority = value
                                    .get("url")
                                    .and_then(Value::as_str)
                                    .and_then(|raw| raw.split_once("://"))
                                    .is_some_and(|(_, rest)| {
                                        rest.split(['/', '?', '#'])
                                            .next()
                                            .unwrap_or("")
                                            .contains("${")
                                    });
                                if !dynamic_authority {
                                    endpoint_origin = Some(url.origin().ascii_serialization());
                                }
                                true
                            }
                            _ => false,
                        }
                    }
                };
                (config.disabled, valid)
            }
            Err(_) => (false, false),
        };
        let state = if !plugin.enabled || disabled {
            PluginConnectionState::Disabled
        } else if plugin.scope == PluginScope::Project && !workspace_trusted {
            PluginConnectionState::WorkspaceTrustRequired
        } else if !missing.is_empty() {
            PluginConnectionState::MissingEnvironment
        } else if !valid {
            PluginConnectionState::InvalidConfiguration
        } else {
            PluginConnectionState::Configured
        };
        let config_bytes = serde_json::to_vec(value).map_err(|_| {
            NativeError::new(
                "plugin_connection_config_invalid",
                "Plugin MCP configuration cannot be serialized",
            )
        })?;
        let mut receipt = PluginConnectionReceipt {
            schema_version: 1,
            receipt_id: String::new(),
            plugin_name: plugin.name.clone(),
            plugin_version: plugin.version.clone(),
            plugin_scope: plugin.scope,
            server_name: format!("plugin:{}:{server}", plugin.name),
            configuration_sha256: hash(config_bytes),
            configuration_snapshot_sha256: configuration_snapshot_sha256.to_owned(),
            workspace_fingerprint: workspace_fingerprint.to_owned(),
            workspace_trusted,
            transport,
            endpoint_origin,
            required_environment: required.into_iter().collect(),
            missing_environment: missing.into_iter().collect(),
            has_configured_headers: has_headers,
            state,
            permission_boundary: "workspace_trust_and_per_tool_policy",
            live_authentication_verified: false,
        };
        receipt.receipt_id = format!(
            "plugin_connection_{}",
            hash(serde_json::to_vec(&receipt).map_err(|_| {
                NativeError::new(
                    "plugin_connection_config_invalid",
                    "Plugin MCP receipt cannot be serialized",
                )
            })?)
        );
        receipts.push(receipt);
    }
    receipts.sort_by(|a, b| a.server_name.cmp(&b.server_name));
    Ok(receipts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use omnia_harness::plugins::PluginContents;
    use serde_json::json;
    use std::path::PathBuf;

    fn plugin(scope: PluginScope) -> Plugin {
        Plugin {
            name: "github".into(),
            version: "1.0".into(),
            description: String::new(),
            author: None,
            scope,
            path: PathBuf::from("C:/plugins/github"),
            manifest_path: PathBuf::from("C:/plugins/github/omnia-plugin.json"),
            enabled: true,
            contents: PluginContents::default(),
        }
    }
    fn inspect(
        plugin: &Plugin,
        config: Value,
        trusted: bool,
        token: bool,
    ) -> Vec<PluginConnectionReceipt> {
        inspect_plugin_connections(
            plugin,
            &serde_json::to_vec(&config).unwrap(),
            &"a".repeat(64),
            &"b".repeat(64),
            trusted,
            &|name| (token && name == "GITHUB_TOKEN").then(|| "private-token-value".into()),
        )
        .unwrap()
    }
    #[test]
    fn receipts_are_stable_redacted_and_do_not_grant_authority() {
        let config = json!({"mcpServers":{"github":{"url":"https://api.github.com/mcp?token=inline-secret", "headers":{"Authorization":"Bearer ${GITHUB_TOKEN}"}}}});
        let first = inspect(&plugin(PluginScope::User), config.clone(), true, true);
        let second = inspect(&plugin(PluginScope::User), config, true, true);
        assert_eq!(first[0].receipt_id, second[0].receipt_id);
        assert_eq!(first[0].state, PluginConnectionState::Configured);
        assert_eq!(
            first[0].endpoint_origin.as_deref(),
            Some("https://api.github.com")
        );
        assert_eq!(first[0].required_environment, ["GITHUB_TOKEN"]);
        assert!(first[0].missing_environment.is_empty());
        assert!(!first[0].live_authentication_verified);
        let text = serde_json::to_string(&first).unwrap();
        for secret in [
            "private-token-value",
            "inline-secret",
            "Authorization",
            "Bearer",
            "?token=",
        ] {
            assert!(!text.contains(secret));
        }
    }
    #[test]
    fn trust_disabled_missing_environment_and_invalid_endpoint_are_distinct() {
        let config = json!({"mcpServers":{"a":{"url":"https://api.github.com", "headers":{"Authorization":"${GITHUB_TOKEN}"}}}});
        let project = plugin(PluginScope::Project);
        assert_eq!(
            inspect(&project, config.clone(), false, true)[0].state,
            PluginConnectionState::WorkspaceTrustRequired
        );
        assert_eq!(
            inspect(&project, config.clone(), true, false)[0].state,
            PluginConnectionState::MissingEnvironment
        );
        let mut disabled = project.clone();
        disabled.enabled = false;
        assert_eq!(
            inspect(&disabled, config, true, true)[0].state,
            PluginConnectionState::Disabled
        );
        assert_eq!(
            inspect(
                &project,
                json!({"servers":{"a":{"url":"https://user:password@api.github.com"}}}),
                true,
                true
            )[0]
            .state,
            PluginConnectionState::InvalidConfiguration
        );
    }
    #[test]
    fn defaults_root_and_changed_configuration_are_accounted_for() {
        let config = json!({"mcpServers":{"a":{"command":"node", "args":["${OMNIA_PLUGIN_ROOT}/server.js"], "env":{"OPTION":"${OPTION:-default}"}}}});
        let first = inspect(&plugin(PluginScope::User), config, true, false);
        assert_eq!(first[0].state, PluginConnectionState::Configured);
        assert_eq!(first[0].required_environment, ["OPTION"]);
        assert!(first[0].missing_environment.is_empty());
        let changed = inspect(
            &plugin(PluginScope::User),
            json!({"mcpServers":{"a":{"command":"node", "args":["new-server.js"]}}}),
            true,
            false,
        );
        assert_ne!(first[0].receipt_id, changed[0].receipt_id);
        assert_ne!(
            first[0].configuration_sha256,
            changed[0].configuration_sha256
        );
    }
}
