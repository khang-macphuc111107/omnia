//! Tauri transport adapters for the canonical Rust navigation service.
//! Persistence, schema validation and CAS live in omnia-session-store.
use crate::{error::NativeResult, harness_bridge::HarnessHub};
pub use omnia_session_store::session_navigation::*;
use tauri::State;

#[tauri::command]
pub fn agent_session_navigation_load(
    hub: State<'_, HarnessHub>,
) -> NativeResult<AgentSessionNavigationLoad> {
    hub.store().load_session_navigation()
}

#[tauri::command]
pub fn agent_session_navigation_save(
    hub: State<'_, HarnessHub>,
    request: SaveAgentSessionNavigationRequest,
) -> NativeResult<AgentSessionNavigationSave> {
    hub.store().save_session_navigation(request)
}
