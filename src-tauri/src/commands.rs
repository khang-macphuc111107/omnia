use serde::Serialize;
use tauri::{AppHandle, State};

use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRuntimeInfo {
    app_name: String,
    app_version: String,
    platform: String,
    tauri: bool,
    debug: bool,
}

#[tauri::command]
pub fn runtime_info(app: AppHandle) -> AppRuntimeInfo {
    AppRuntimeInfo {
        app_name: app.package_info().name.clone(),
        app_version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_owned(),
        tauri: true,
        debug: cfg!(debug_assertions),
    }
}

#[tauri::command]
pub fn cancel_run(state: State<'_, AppState>, run_id: String) -> bool {
    state
        .run_cancellations
        .get(run_id.trim())
        .is_some_and(|sender| sender.send(true).is_ok())
}
