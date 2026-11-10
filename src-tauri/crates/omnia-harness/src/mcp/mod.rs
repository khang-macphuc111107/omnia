//! Hand-rolled Model Context Protocol client (JSON-RPC 2.0) with stdio and
//! streamable-HTTP transports, plus `McpTool` / `McpManager` glue so MCP
//! servers' tools look like any other harness [`crate::Tool`].

mod client;
mod config;
mod http;
mod manager;
mod rpc;
mod stdio;
#[cfg(test)]
mod testutil;
mod tool;

use std::time::Duration;

use thiserror::Error;

pub use client::{McpClient, McpOptions, McpToolInfo, ServerKind};
pub use config::{
    expand_env, expand_plugin_server, load_mcp_config, load_mcp_config_with_plugins,
    McpServerConfig, McpTransportConfig,
};
pub use manager::{McpManager, McpServerState, McpServerStatus};
pub use tool::{convert_call_result, sanitize_tool_name, McpTool};

/// MCP protocol revision this client proposes.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Debug, Error)]
pub enum McpError {
    #[error("request timed out after {0:?}")]
    Timeout(Duration),
    #[error("request cancelled")]
    Cancelled,
    #[error("connection closed")]
    Closed,
    #[error("server error {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("transport error: {0}")]
    Transport(String),
    #[error("protocol error: {0}")]
    Protocol(String),
}

pub(crate) type McpResult<T> = Result<T, McpError>;
