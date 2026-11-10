mod agent_services;
mod app_state_persistence;
mod artifact_commands;
mod attachment_commands;
mod attachment_repository;
pub(crate) mod authority_continuity;
mod blob_key_broker;
mod browser_profile;
mod browser_surface;
// Capability negotiation remains a native contract under test until its
// command/storage integration is implemented; it has no production caller.
#[cfg(test)]
mod capability_runtime;
mod commands;
mod content_store;
mod core_protocol;
mod data_portability;
mod download_manager;
mod editor_server;
mod editor_surface;
mod error;
#[cfg(test)]
mod exact_approval_broker;
mod goal_tools;
mod harness_bridge;
mod harness_store;
mod ide_files;
mod inspector;
mod ipc_session;
mod isolated_input;
mod mcp_server;
mod model_compare_receipt;
mod multimodal_bridge;
// Native-first shell migration seam. It is test-gated until benchmark,
// accessibility, packaged-runtime and rollback evidence justify promotion.
#[cfg(test)]
mod native_boundary;
#[cfg(test)]
mod native_boundary_persistence;
#[cfg(windows)]
mod native_browser_keyboard;
mod native_commands;
#[cfg(test)]
mod native_windows_collector;
// Native compare execution engine. The renderer still uses the receipt
// projector above until an opaque-id dispatch command is available; keeping
// this module in the native test target makes its provider fan-out and merge
// invariants compile and run independently of the Tauri command surface.
mod native_compare;
mod phase2_commands;
mod plugin_bridge;
mod plugin_connections;
#[cfg(test)]
pub(crate) mod portable_bundle;
pub(crate) mod prepared_provider_input;
mod project_file_pointers;
mod prompt_presets;
pub(crate) mod provider_attempt_lineage;
pub(crate) mod provider_cache_plan;
pub(crate) mod provider_definition;
#[cfg(test)]
pub(crate) mod provider_fault_harness;
mod provider_gateway;
mod review;
mod run_control;
mod run_journal;
mod run_retrieval;
mod scheduler;
mod secret_store;
mod session_navigation;
mod settings_permissions_persistence;
mod state;
mod storage;
mod telemetry;
// Native admission invariants for the bounded supervisor/PM/worker topology.
// The production command records durable intent only; it never dispatches a
// provider or process.
#[allow(dead_code)]
mod tiered_orchestration;
// Durable journal adapter used by Storage's mutex/transaction boundary.
#[allow(dead_code)]
mod tiered_orchestration_store;
mod update_checker;
mod voice;
mod workspace;
mod workspace_indexer;

use tauri::{webview::PageLoadEvent, Manager};

fn build_core_command_handler() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        core_protocol::core_initialize,
        commands::runtime_info,
        commands::cancel_run,
        editor_server::editor_server_status,
        editor_server::editor_server_start,
        editor_server::editor_workspace_get,
        editor_server::editor_workspace_pick,
        editor_server::editor_workspace_remove,
        editor_surface::editor_surface_attach,
        editor_surface::editor_surface_update,
        editor_surface::editor_surface_release,
        editor_surface::editor_surface_focus,
        browser_surface::browser_surface_attach,
        browser_surface::browser_surface_update,
        browser_surface::browser_surface_navigate,
        browser_surface::browser_surface_action,
        browser_surface::browser_surface_capture,
        browser_surface::browser_surface_release,
        native_commands::app_state_snapshot_load,
        native_commands::app_state_snapshot_save,
        native_commands::app_state_transfer_export,
        native_commands::app_state_transfer_import,
        native_commands::app_state_persistence_health,
        native_commands::settings_permissions_snapshot_load,
        native_commands::settings_permissions_snapshot_save,
        native_commands::settings_permissions_persistence_health,
        download_manager::download_job_create,
        download_manager::download_job_start,
        download_manager::download_job_pause,
        download_manager::download_job_resume,
        download_manager::download_job_cancel,
        download_manager::download_job_append_chunk,
        download_manager::download_job_complete,
        download_manager::download_job_get,
        download_manager::download_job_list,
        isolated_input::isolated_input_capabilities,
        isolated_input::isolated_input_session_create,
        isolated_input::isolated_input_session_read,
        isolated_input::isolated_input_session_stop,
        isolated_input::isolated_input_channel_attach,
        isolated_input::isolated_input_channel_detach,
        isolated_input::isolated_input_event_send,
        native_commands::storage_health,
        native_commands::tiered_admission_append,
        native_commands::runtime_operation_append,
        native_commands::runtime_outbox_read,
        native_commands::runtime_outbox_lease,
        native_commands::runtime_outbox_settle,
        native_commands::runtime_event_append,
        native_commands::runtime_events_read,
        native_commands::project_create,
        native_commands::project_update,
        native_commands::project_list,
        native_commands::goal_create,
        native_commands::goal_read,
        native_commands::goal_list,
        native_commands::goal_revision_read,
        native_commands::goal_revision_create,
        native_commands::goal_status_update,
        native_commands::starter_workflow_create,
        native_commands::starter_workflow_read,
        native_commands::starter_workflow_list,
        native_commands::starter_workflow_revision_read,
        native_commands::starter_workflow_revision_create,
        native_commands::starter_workflow_status_update,
        native_commands::starter_workflow_enabled_update,
        native_commands::task_create,
        native_commands::task_read,
        native_commands::task_list,
        native_commands::task_revision_read,
        native_commands::task_revision_create,
        native_commands::task_status_update,
        native_commands::task_dependency_create,
        native_commands::task_dependency_list,
        native_commands::conversation_create,
        native_commands::conversation_list,
        native_commands::conversation_branch_fork,
        native_commands::conversation_branch_activate,
        native_commands::state_revision_append,
        native_commands::state_revision_graph_read,
        native_commands::run_journal_read,
        native_commands::run_telemetry_read,
        native_commands::provider_attempt_lineage_read,
        model_compare_receipt::model_compare_receipt_create,
        native_commands::conversation_run_prepare,
        native_commands::run_control_resolve,
        native_commands::run_control_apply,
        native_commands::checkpoint_create,
        native_commands::checkpoint_read,
        native_commands::continuation_intent_resolve,
        native_commands::message_revision_resolve,
        attachment_commands::attachment_pick,
        attachment_commands::attachment_draft_get,
        attachment_commands::attachment_draft_list,
        attachment_commands::attachment_draft_remove,
        attachment_commands::attachment_draft_abandon,
        attachment_commands::attachment_list,
        attachment_commands::attachment_text_read,
        attachment_commands::attachment_binary_preview,
        native_commands::workspace_grant_pick,
        native_commands::workspace_grant_list,
        native_commands::workspace_grant_revoke,
        native_commands::workspace_directory_list,
        native_commands::workspace_text_file_read,
        ide_files::ide_write_permission_request,
        ide_files::ide_write_permission_revoke,
        ide_files::ide_text_file_read,
        ide_files::ide_text_file_write,
        native_commands::workspace_index_build,
        native_commands::workspace_index_retrieve,
        native_commands::project_file_pointer_pick,
        native_commands::project_file_pointer_list,
        native_commands::project_file_pointer_retrieval_candidates,
        native_commands::project_file_pointer_refresh,
        native_commands::project_file_pointer_read,
        native_commands::project_file_pointer_receipts,
        native_commands::workspace_index_retrieve_for_run,
        native_commands::provider_profile_save,
        native_commands::provider_profile_list,
        native_commands::provider_profile_delete,
        provider_gateway::provider_connection_test,
        provider_gateway::provider_models_list,
        provider_gateway::start_prepared_attempt,
        native_compare::native_compare_execute_prepared,
        agent_services::agent_services_status,
        agent_services::agent_services_close,
        agent_services::agent_computer_permission_set,
        agent_services::agent_computer_emergency_stop,
        agent_services::agent_download_control,
        agent_services::agent_media_list,
        agent_services::agent_download_start,
        agent_services::agent_download_reveal,
        agent_services::agent_recordings_list,
        agent_services::agent_recording_reveal,
        agent_services::agent_browser_settings_get,
        agent_services::agent_browser_settings_set,
        agent_services::agent_browser_clear_data,
        agent_services::agent_browser_open_for_signin,
        harness_bridge::agent_session_create,
        harness_bridge::agent_session_list,
        session_navigation::agent_session_navigation_load,
        session_navigation::agent_session_navigation_save,
        harness_bridge::agent_session_read,
        harness_bridge::agent_session_delete,
        harness_bridge::agent_session_update,
        harness_bridge::agent_system_prompt_preview,
        harness_bridge::agent_prompt_presets_list,
        harness_bridge::agent_prompt_preset_save,
        harness_bridge::agent_prompt_preset_delete,
        harness_bridge::agent_send,
        inspector::agent_inspector_list,
        inspector::agent_inspector_get,
        inspector::agent_inspector_clear,
        harness_bridge::agent_steer,
        harness_bridge::agent_interrupt,
        harness_bridge::agent_user_input,
        harness_bridge::agent_approval_decide,
        harness_bridge::agent_rewind,
        harness_bridge::agent_fork,
        harness_bridge::agent_pick_folder,
        harness_bridge::agent_mcp_status,
        harness_bridge::agent_mcp_reload,
        mcp_server::agent_mcp_server_status,
        mcp_server::agent_mcp_server_set,
        mcp_server::agent_mcp_server_rotate_token,
        harness_bridge::agent_commands_list,
        harness_bridge::agent_skills_list,
        harness_bridge::agent_agents_list,
        plugin_bridge::agent_plugins_list,
        plugin_bridge::agent_plugin_set_enabled,
        plugin_bridge::agent_plugin_install,
        plugin_bridge::agent_plugin_uninstall,
        harness_bridge::agent_plugin_connection_receipts,
        harness_bridge::agent_workspace_files,
        artifact_commands::agent_artifacts_list,
        artifact_commands::agent_artifact_get,
        artifact_commands::agent_artifact_export,
        artifact_commands::agent_artifact_open_browser,
        artifact_commands::agent_artifact_preview_url,
        review::agent_workspace_diff,
        review::agent_hunk_revert,
        review::agent_hunk_stage,
        harness_bridge::agent_workspace_trust_status,
        harness_bridge::agent_workspace_trust_set,
        harness_bridge::agent_approval_decide_all,
        harness_bridge::agent_permission_rules_list,
        harness_bridge::agent_permission_rules_set,
        harness_bridge::agent_permission_rules_test,
        data_portability::agent_data_export,
        data_portability::agent_data_import,
        scheduler::agent_schedules_list,
        scheduler::agent_schedule_save,
        scheduler::agent_schedule_delete,
        scheduler::agent_schedule_run_now,
        scheduler::agent_schedule_preview,
        voice::voice_status,
        voice::voice_start,
        voice::voice_stop,
        voice::voice_open_settings,
        update_checker::update_get_settings,
        update_checker::update_set_settings,
        update_checker::update_check,
        update_checker::update_download,
        update_checker::update_install,
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .register_uri_scheme_protocol(artifact_commands::PREVIEW_SCHEME, |ctx, request| {
            artifact_commands::handle_preview_request(ctx.app_handle(), &request)
        })
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let state = state::AppState::initialize(&app_data_dir)
                .map_err(Box::<dyn std::error::Error>::from)?;
            app.manage(state);
            app.manage(editor_server::EditorServerManager::new(&app_data_dir));
            app.manage(editor_surface::EditorSurfaceManager::new(&app_data_dir));
            app.manage(browser_surface::BrowserSurfaceManager::new(&app_data_dir));
            app.manage(harness_bridge::HarnessHub::open(&app_data_dir)?);
            app.manage(artifact_commands::PreviewTokens::default());
            app.manage(state::initialize_core_session_registry());
            app.manage(mcp_server::McpServerManager::new(&app_data_dir));
            mcp_server::start_on_launch(app.handle());
            app.manage(scheduler::ScheduleStore::new(&app_data_dir));
            scheduler::start(app.handle());
            app.manage(update_checker::UpdateManager::new(
                &app_data_dir,
                &app.package_info().version.to_string(),
            ));
            update_checker::start_on_launch(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(browser) = window.try_state::<browser_surface::BrowserSurfaceManager>()
                {
                    browser.stop(window.app_handle());
                }
                if let Some(surface) = window.try_state::<editor_surface::EditorSurfaceManager>() {
                    surface.stop(window.app_handle());
                }
                if let Some(editor) = window.try_state::<editor_server::EditorServerManager>() {
                    editor.stop();
                }
            }
        })
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                if webview.label() == "main" {
                    if let Some(browser) =
                        webview.try_state::<browser_surface::BrowserSurfaceManager>()
                    {
                        browser.stop(webview.app_handle());
                    }
                    if let Some(surface) =
                        webview.try_state::<editor_surface::EditorSurfaceManager>()
                    {
                        surface.hide_for_navigation(webview.app_handle());
                    }
                }
                if let Err(error) = ipc_session::handle_page_load_started(
                    &webview.state::<ipc_session::CoreSessionRegistry>(),
                    webview.label(),
                ) {
                    #[cfg(debug_assertions)]
                    eprintln!("Omnia IPC session invalidation failed: {}", error.code);
                }
            }
        })
        .invoke_handler(ipc_session::session_guarded_handler(
            browser_surface::deny_browser_invokes(editor_surface::deny_editor_invokes(
                build_core_command_handler(),
            )),
        ))
        .run(tauri::generate_context!())
        .expect("failed to run Omnia desktop application");
}
