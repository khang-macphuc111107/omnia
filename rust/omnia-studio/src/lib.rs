#![deny(unsafe_code)]
//! Omnia Studio native HTTP/1.1 & JSON-RPC host serving Flagship Studio UI
//! and unifying all Omnia Rust capability crates on strict loopback origins.

pub mod config;
pub mod history;
pub mod http;
pub mod routes_capabilities;
pub mod routes_downloads;
pub mod routes_legacy;
pub mod routes_notebooks;
pub mod runtime_proxy;
pub mod telemetry;

pub use config::{CliAction, StudioConfig, DEFAULT_HOST, DEFAULT_PORT, RUNTIME_PROXY_TIMEOUT_MS};
pub use http::StudioServer;
pub use routes_legacy::{dispatch_request, StudioState};

use std::sync::Arc;

/// Starts a live [`StudioServer`] bound to `config.bind_addr()` backed by [`StudioState`].
pub async fn start_studio_server(config: StudioConfig) -> Result<StudioServer, String> {
    config.validate()?;
    let bind_addr = config.bind_addr();
    let state = Arc::new(StudioState::new(config)?);
    StudioServer::bind_and_serve(&bind_addr, state, dispatch_request).await
}
