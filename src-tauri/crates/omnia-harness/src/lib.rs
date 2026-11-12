//! Omnia's provider-neutral agent harness.
//!
//! The crate has no Tauri dependency so it can be tested headless and reused
//! by the desktop bridge (`src-tauri/src/harness_bridge.rs`). Design notes live
//! in `docs/omnia-harness/M1-HARNESS-DESIGN.md`.

pub mod agent;
pub mod agent_graph;
pub mod budget;
pub mod checkpoint;
pub mod commands;
pub mod compact;
pub mod error;
pub mod eval;
pub mod hooks;
pub mod lsp;
pub mod mcp;
pub mod memory;
pub mod model;
pub mod permission;
pub mod plan;
pub mod plugins;
pub mod proactive_rag;
pub mod prompt;
pub mod provider;
pub mod run_control;
pub mod skills;
pub mod subagent;
pub mod tool;
pub mod tools;
pub mod user_input;

pub use tokio_util::sync::CancellationToken;

pub use budget::{SharedTokenBudget, TokenBudgetLedger, TokenBudgetSnapshot, TokenBudgetWarning};
pub use checkpoint::{CheckpointScope, CheckpointStore, RestoreReport};
pub use error::{HarnessError, HarnessResult};
pub use model::*;
pub use provider::{Provider, ProviderRequest, ProviderStream};
pub use tool::{EffectClass, Tool, ToolContext, ToolOutput, ToolRegistry};
