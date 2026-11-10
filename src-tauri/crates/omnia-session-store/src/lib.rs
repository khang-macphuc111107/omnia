//! One source owner for Omnia's durable agent sessions and ordered session
//! navigation. Both native UI and compatibility transports use these exact
//! schemas, error types and SQLite transactions.
//!
//! Opening a store first acquires exclusive OS ownership of the database file,
//! then runs recovery (running projections become interrupted). Share one
//! `Arc<HarnessStore>` for live observers; a second production open is rejected.
pub mod error;
pub mod event_publisher;
pub mod harness_store;
mod ownership;
pub mod run_coordinator;
pub mod run_events;
pub mod run_execution;
pub mod run_registry;
pub mod session_navigation;
pub mod session_preparation;

pub use error::{NativeError, NativeResult, ProviderErrorClass};
pub use harness_store::{AgentSessionSummary, HarnessStore, SessionScope};
pub use session_navigation::{
    AgentSessionNavigationLoad, AgentSessionNavigationSave, AgentSessionNavigationSnapshot,
    AgentSessionPage, AgentSessionPageCursor, AgentSessionPageRequest,
    SaveAgentSessionNavigationRequest,
};
