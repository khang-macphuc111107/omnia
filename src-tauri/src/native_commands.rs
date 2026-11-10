use std::net::IpAddr;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use url::{Host, Url};

use crate::{
    app_state_persistence::{SnapshotLoad, SnapshotSave},
    error::{NativeError, NativeResult},
    prepared_provider_input::PreparedConversationRun,
    project_file_pointers::{
        ProjectFilePointerBody, ProjectFilePointerMutation, ProjectFilePointerReceipt,
        ProjectFilePointerRecord,
    },
    provider_attempt_lineage::{ProviderAttemptLineageReceipt, ReadProviderAttemptLineageRequest},
    run_journal::{ReadRunJournalRequest, RunJournalReplayPage},
    secret_store::{SecretPurpose, SecretStatus},
    settings_permissions_persistence::{SettingsPermissionsLoad, SettingsPermissionsSave},
    state::AppState,
    storage::{
        AppendRuntimeEventRequest, AppendRuntimeOperationRequest, ContextAdmissionDraft,
        ContextAdmissionItem, ContextAdmissionOmission, ConversationSnapshot, CreateGoalRequest,
        CreateGoalRevisionRequest, CreateStarterWorkflowRequest,
        CreateStarterWorkflowRevisionRequest, CreateTaskDependencyRequest, CreateTaskRequest,
        CreateTaskRevisionRequest, GoalRevisionRecord, GoalSnapshot, GoalSummary,
        LeaseRuntimeOutboxRequest, ListGoalsRequest, ListStarterWorkflowsRequest,
        ListTaskDependenciesRequest, ListTasksRequest, NewConversationRun, NewProviderProfile,
        ProjectRecord, ProviderProfileRecord, ReadGoalRequest, ReadGoalRevisionRequest,
        ReadStarterWorkflowRequest, ReadStarterWorkflowRevisionRequest, ReadTaskRequest,
        ReadTaskRevisionRequest, RuntimeEventReceipt, RuntimeOperationReceipt,
        RuntimeOutboxLeaseReceipt, RuntimeOutboxRecord, RuntimeOutboxSettlementReceipt,
        SettleRuntimeOutboxRequest, StarterWorkflowRevisionRecord, StarterWorkflowSnapshot,
        StarterWorkflowSummary, StateRevisionAppendRequest, StateRevisionGraphReadOptions,
        StateRevisionGraphSnapshot, StorageHealth, TaskDependencyRecord, TaskRevisionRecord,
        TaskSnapshot, TaskSummary, UpdateGoalStatusRequest, UpdateStarterWorkflowEnabledRequest,
        UpdateStarterWorkflowStatusRequest, UpdateTaskStatusRequest, WorkspaceGrantRecord,
    },
    telemetry::{ReadRunTelemetryRequest, RunTelemetrySnapshot},
    workspace::{WorkspaceDirectoryListing, WorkspaceTextFile},
    workspace_indexer::{
        IndexedWorkspaceChunk, WorkspaceIndexOptions, WorkspaceIndexSnapshot,
        WorkspaceRetrievalOptions, WorkspaceRetrievalResult,
    },
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFilePointerPickRequest {
    pub project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFilePointerListRequest {
    pub project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFilePointerRefreshRequest {
    pub project_id: String,
    pub pointer_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFilePointerReadRequest {
    pub project_id: String,
    pub pointer_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFilePointerReceiptsRequest {
    pub project_id: String,
    pub pointer_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadAppStateSnapshotRequest {
    pub minimum_revision: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveAppStateSnapshotRequest {
    pub snapshot: String,
    pub expected_revision: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AppStateSnapshotLoadResponse {
    Empty {
        receipt_id: String,
    },
    Loaded {
        snapshot: String,
        revision: i64,
        receipt_id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AppStateSnapshotSaveResponse {
    Saved {
        revision: i64,
        receipt_id: String,
    },
    Conflict {
        current_revision: Option<i64>,
        expected_revision: Option<i64>,
        receipt_id: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppStateTransferRequest {
    pub bundle: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateTransferResponse {
    pub status: &'static str,
    pub bundle: String,
    pub receipt_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatePersistenceHealth {
    pub status: &'static str,
    pub backend: &'static str,
    pub durable: bool,
    pub schema_version: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadSettingsPermissionsSnapshotRequest {
    pub minimum_revision: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveSettingsPermissionsSnapshotRequest {
    pub snapshot: String,
    pub expected_revision: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SettingsPermissionsSnapshotLoadResponse {
    Empty {
        receipt_id: String,
    },
    Loaded {
        snapshot: String,
        revision: i64,
        receipt_id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SettingsPermissionsSnapshotSaveResponse {
    Saved {
        revision: i64,
        receipt_id: String,
    },
    Conflict {
        current_revision: Option<i64>,
        expected_revision: Option<i64>,
        receipt_id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPermissionsPersistenceHealth {
    pub status: &'static str,
    pub backend: &'static str,
    pub durable: bool,
    pub schema_version: u32,
}

#[tauri::command]
pub fn app_state_snapshot_load(
    state: State<'_, AppState>,
    request: LoadAppStateSnapshotRequest,
) -> NativeResult<AppStateSnapshotLoadResponse> {
    match state.app_state.load(request.minimum_revision)? {
        SnapshotLoad::Empty { receipt_id } => {
            Ok(AppStateSnapshotLoadResponse::Empty { receipt_id })
        }
        SnapshotLoad::Loaded {
            snapshot,
            revision,
            receipt_id,
        } => Ok(AppStateSnapshotLoadResponse::Loaded {
            snapshot,
            revision,
            receipt_id,
        }),
    }
}

#[tauri::command]
pub fn app_state_snapshot_save(
    state: State<'_, AppState>,
    request: SaveAppStateSnapshotRequest,
) -> NativeResult<AppStateSnapshotSaveResponse> {
    match state
        .app_state
        .save(&request.snapshot, request.expected_revision)?
    {
        SnapshotSave::Saved {
            revision,
            receipt_id,
        } => Ok(AppStateSnapshotSaveResponse::Saved {
            revision,
            receipt_id,
        }),
        SnapshotSave::Conflict {
            current_revision,
            expected_revision,
            receipt_id,
        } => Ok(AppStateSnapshotSaveResponse::Conflict {
            current_revision,
            expected_revision,
            receipt_id,
        }),
    }
}

/// Validates and returns a detached transfer envelope for renderer export.
/// The native transport does not persist or merge the bundle.
#[tauri::command]
pub fn app_state_transfer_export(
    state: State<'_, AppState>,
    request: AppStateTransferRequest,
) -> NativeResult<AppStateTransferResponse> {
    let result = state.app_state.export_transfer(&request.bundle)?;
    Ok(AppStateTransferResponse {
        status: "exported",
        bundle: result.bundle,
        receipt_id: result.receipt_id,
    })
}

/// Validates and returns a detached transfer envelope for renderer import.
/// Applying the bundle remains the responsibility of the domain merge layer.
#[tauri::command]
pub fn app_state_transfer_import(
    state: State<'_, AppState>,
    request: AppStateTransferRequest,
) -> NativeResult<AppStateTransferResponse> {
    let result = state.app_state.import_transfer(&request.bundle)?;
    Ok(AppStateTransferResponse {
        status: "imported",
        bundle: result.bundle,
        receipt_id: result.receipt_id,
    })
}

#[tauri::command]
pub fn app_state_persistence_health(
    _state: State<'_, AppState>,
) -> NativeResult<AppStatePersistenceHealth> {
    Ok(AppStatePersistenceHealth {
        status: "available",
        backend: "native",
        durable: true,
        schema_version: 1,
    })
}

/// Loads the strict renderer settings/permission document from the native
/// JSON store. The native layer validates only bounded JSON and its top-level
/// revision; policy semantics remain in the renderer domain adapter.
#[tauri::command]
pub fn settings_permissions_snapshot_load(
    state: State<'_, AppState>,
    request: LoadSettingsPermissionsSnapshotRequest,
) -> NativeResult<SettingsPermissionsSnapshotLoadResponse> {
    match state.settings_permissions.load(request.minimum_revision)? {
        SettingsPermissionsLoad::Empty { receipt_id } => {
            Ok(SettingsPermissionsSnapshotLoadResponse::Empty { receipt_id })
        }
        SettingsPermissionsLoad::Loaded {
            snapshot,
            revision,
            receipt_id,
        } => Ok(SettingsPermissionsSnapshotLoadResponse::Loaded {
            snapshot,
            revision,
            receipt_id,
        }),
    }
}

/// Saves settings/permission JSON with compare-and-swap semantics. A stale
/// renderer receives a typed conflict rather than silently overwriting a
/// newer policy document.
#[tauri::command]
pub fn settings_permissions_snapshot_save(
    state: State<'_, AppState>,
    request: SaveSettingsPermissionsSnapshotRequest,
) -> NativeResult<SettingsPermissionsSnapshotSaveResponse> {
    match state
        .settings_permissions
        .save(&request.snapshot, request.expected_revision)?
    {
        SettingsPermissionsSave::Saved {
            revision,
            receipt_id,
        } => Ok(SettingsPermissionsSnapshotSaveResponse::Saved {
            revision,
            receipt_id,
        }),
        SettingsPermissionsSave::Conflict {
            current_revision,
            expected_revision,
            receipt_id,
        } => Ok(SettingsPermissionsSnapshotSaveResponse::Conflict {
            current_revision,
            expected_revision,
            receipt_id,
        }),
    }
}

#[tauri::command]
pub fn settings_permissions_persistence_health(
    _state: State<'_, AppState>,
) -> NativeResult<SettingsPermissionsPersistenceHealth> {
    Ok(SettingsPermissionsPersistenceHealth {
        status: "available",
        backend: "native",
        durable: true,
        schema_version: 1,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateProjectRequest {
    name: String,
    description: Option<String>,
    instructions: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateProjectMetadataRequest {
    project_id: String,
    name: String,
    description: Option<String>,
    instructions: Option<String>,
    expected_updated_at_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateConversationRequest {
    project_id: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForkConversationBranchRequest {
    conversation_id: String,
    parent_branch_id: String,
    forked_from_message_id: String,
    name: Option<String>,
    #[serde(default)]
    activate: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivateConversationBranchRequest {
    conversation_id: String,
    branch_id: String,
    expected_active_branch_id: String,
}

/// Bounded read request for the redacted immutable state-revision graph.
/// Native storage revalidates the conversation/branch relationship and never
/// returns the raw manifests that are persisted in the graph tables.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadStateRevisionGraphRequest {
    conversation_id: String,
    branch_id: String,
    /// Inclusive branch-sequence watermark. Native storage clamps a value
    /// beyond the currently materialized stream and rejects negative values.
    /// Omitting it pins the read to the highest fact visible in one SQLite
    /// snapshot.
    through_branch_sequence: Option<i64>,
    /// Maximum number of revision projections returned in this page. Native
    /// storage applies the bounded default when omitted and rejects zero or
    /// values above its hard cap.
    revisions_limit: Option<u32>,
    /// Maximum number of edge projections returned in this page. Native
    /// storage applies the bounded default when omitted and rejects zero or
    /// values above its hard cap.
    edges_limit: Option<u32>,
    /// Signed native continuation cursor for the revision collection.
    revisions_cursor: Option<String>,
    /// Signed native continuation cursor for the edge collection.
    edges_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareConversationRunRequest {
    conversation_id: String,
    branch_id: String,
    run_id: String,
    attempt_id: String,
    user_message_id: String,
    assistant_message_id: String,
    prompt: String,
    provider_profile_id: String,
    model: String,
    #[serde(default = "empty_json_object")]
    request_parameters_json: String,
    #[serde(default)]
    context_admission: Option<ContextAdmissionRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextAdmissionRequest {
    grant_id: String,
    query: String,
    index_options: Option<WorkspaceIndexOptions>,
    retrieval_options: Option<WorkspaceRetrievalOptions>,
}

fn empty_json_object() -> String {
    "{}".to_owned()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddWorkspaceFolderRequest {
    project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListWorkspaceDirectoryRequest {
    grant_id: String,
    relative_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadWorkspaceTextFileRequest {
    grant_id: String,
    relative_path: String,
}

/// Requests a bounded, read-only workspace index build for one granted folder.
/// The native indexer owns all path resolution; the renderer only supplies the
/// opaque grant and optional indexing policy.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildWorkspaceIndexRequest {
    grant_id: String,
    project_id: Option<String>,
    options: Option<WorkspaceIndexOptions>,
}

/// Requests lexical retrieval over chunks returned by a workspace index build.
/// Chunks are accepted as an explicit projection so the command does not retain
/// a process-global snapshot or expose native paths outside the grant boundary.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetrieveWorkspaceChunksRequest {
    chunks: Vec<IndexedWorkspaceChunk>,
    query: String,
    options: Option<WorkspaceRetrievalOptions>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveProviderProfileRequest {
    provider_type: String,
    display_name: String,
    base_url: String,
    auth_scheme: Option<String>,
    organization_id: Option<String>,
    remote_project_id: Option<String>,
    secret: Option<String>,
    allow_local_network: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileReceipt {
    pub profile: ProviderProfileRecord,
    pub secret_status: SecretStatus,
}

#[tauri::command]
pub fn storage_health(state: State<'_, AppState>) -> NativeResult<StorageHealth> {
    state.storage.health()
}

/// Tiered admissions remain denied at IPC until a native actor/delegation
/// authority can be attested. A negotiated webview session does not grant
/// execution permissions, and renderer-supplied authority is never trusted.
#[tauri::command]
pub fn tiered_admission_append(
    state: State<'_, AppState>,
    request: crate::tiered_orchestration::TieredAdmissionRequest,
) -> NativeResult<crate::tiered_orchestration::TieredAdmissionReceipt> {
    let _ = (state, request);
    Err(NativeError::new(
        "tiered_authority_unavailable",
        "Tiered admission requires a native-attested actor and delegation grant; IPC admission is unavailable",
    ))
}

/// Atomically admits one runtime operation into native storage and its first
/// queued outbox row. This is an admission receipt only; it never claims that
/// a scheduler or provider delivered the operation.
#[tauri::command]
pub fn runtime_operation_append(
    state: State<'_, AppState>,
    request: AppendRuntimeOperationRequest,
) -> NativeResult<RuntimeOperationReceipt> {
    state.storage.append_runtime_operation(request)
}

/// Reads the immutable first outbox attempt for a previously admitted runtime
/// operation. Delivery remains an explicit state owned by a future dispatcher.
#[tauri::command]
pub fn runtime_outbox_read(
    state: State<'_, AppState>,
    operation_id: String,
) -> NativeResult<Option<RuntimeOutboxRecord>> {
    state.storage.read_runtime_outbox(&operation_id)
}

#[tauri::command]
pub fn runtime_outbox_lease(
    state: State<'_, AppState>,
    request: LeaseRuntimeOutboxRequest,
) -> NativeResult<RuntimeOutboxLeaseReceipt> {
    state.storage.lease_runtime_outbox(request)
}

#[tauri::command]
pub fn runtime_outbox_settle(
    state: State<'_, AppState>,
    request: SettleRuntimeOutboxRequest,
) -> NativeResult<RuntimeOutboxSettlementReceipt> {
    state.storage.settle_runtime_outbox(request)
}

/// Appends an observed lifecycle receipt for an admitted runtime operation.
/// This is a durable journal write only; it never dispatches external work.
#[tauri::command]
pub fn runtime_event_append(
    state: State<'_, AppState>,
    request: AppendRuntimeEventRequest,
) -> NativeResult<RuntimeEventReceipt> {
    state.storage.append_runtime_event(request)
}

#[tauri::command]
pub fn runtime_events_read(
    state: State<'_, AppState>,
    operation_id: String,
) -> NativeResult<Vec<RuntimeEventReceipt>> {
    state.storage.read_runtime_events(&operation_id)
}

#[tauri::command]
pub fn project_create(
    state: State<'_, AppState>,
    request: CreateProjectRequest,
) -> NativeResult<ProjectRecord> {
    state.storage.create_project(
        &request.name,
        request.description.as_deref(),
        request.instructions.as_deref(),
    )
}

#[tauri::command]
pub fn project_update(
    state: State<'_, AppState>,
    request: UpdateProjectMetadataRequest,
) -> NativeResult<ProjectRecord> {
    state.storage.update_project_metadata(
        &request.project_id,
        &request.name,
        request.description.as_deref(),
        request.instructions.as_deref(),
        request.expected_updated_at_ms,
    )
}

#[tauri::command]
pub fn project_list(state: State<'_, AppState>) -> NativeResult<Vec<ProjectRecord>> {
    state.storage.list_projects()
}

/// Creates one authoritative Goal and its first immutable revision.  All
/// scope, canonicalisation, idempotency and receipt checks remain owned by
/// native storage; the command is intentionally a thin IPC delegation layer.
#[tauri::command]
pub fn goal_create(
    state: State<'_, AppState>,
    request: CreateGoalRequest,
) -> NativeResult<GoalSnapshot> {
    state.storage.create_goal(request)
}

/// Reads one native-authoritative Goal together with its verified current
/// revision.  The returned disposition remains preview-only until a typed Goal
/// execution authority is implemented.
#[tauri::command]
pub fn goal_read(
    state: State<'_, AppState>,
    request: ReadGoalRequest,
) -> NativeResult<GoalSnapshot> {
    state.storage.read_goal(request)
}

/// Lists bounded Goal summaries for an owned profile/scope.  Large manifests
/// are intentionally excluded; callers can request an exact snapshot with
/// `goal_read` when needed.
#[tauri::command]
pub fn goal_list(
    state: State<'_, AppState>,
    request: ListGoalsRequest,
) -> NativeResult<Vec<GoalSummary>> {
    state.storage.list_goals(request)
}

/// Reads one immutable Goal revision after native ownership, hash and scope
/// checks.  This is separate from `goal_read`, which resolves the current
/// revision pointer.
#[tauri::command]
pub fn goal_revision_read(
    state: State<'_, AppState>,
    request: ReadGoalRevisionRequest,
) -> NativeResult<GoalRevisionRecord> {
    state.storage.read_goal_revision(request)
}

/// Appends one immutable Goal revision and atomically advances the
/// authoritative root projection.  Idempotent replay and payload-drift
/// handling are implemented in native storage.
#[tauri::command]
pub fn goal_revision_create(
    state: State<'_, AppState>,
    request: CreateGoalRevisionRequest,
) -> NativeResult<GoalSnapshot> {
    state.storage.create_goal_revision(request)
}

/// Applies a validated Goal lifecycle transition as an immutable revision.
#[tauri::command]
pub fn goal_status_update(
    state: State<'_, AppState>,
    request: UpdateGoalStatusRequest,
) -> NativeResult<GoalSnapshot> {
    state.storage.update_goal_status(request)
}

/// Creates one native-authoritative Starter Workflow and its first immutable
/// revision. Workflow definitions remain preview-only until a typed execution
/// authority and approval/policy boundary is introduced.
#[tauri::command]
pub fn starter_workflow_create(
    state: State<'_, AppState>,
    request: CreateStarterWorkflowRequest,
) -> NativeResult<StarterWorkflowSnapshot> {
    state.storage.create_starter_workflow(request)
}

/// Reads one verified Starter Workflow projection and its current immutable
/// revision. Native storage owns scope, hash, pointer and state-anchor checks.
#[tauri::command]
pub fn starter_workflow_read(
    state: State<'_, AppState>,
    request: ReadStarterWorkflowRequest,
) -> NativeResult<StarterWorkflowSnapshot> {
    state.storage.read_starter_workflow(request)
}

/// Lists bounded Starter Workflow summaries without materialising every
/// potentially large workflow definition in the renderer.
#[tauri::command]
pub fn starter_workflow_list(
    state: State<'_, AppState>,
    request: ListStarterWorkflowsRequest,
) -> NativeResult<Vec<StarterWorkflowSummary>> {
    state.storage.list_starter_workflows(request)
}

/// Reads one immutable historical Starter Workflow revision after native
/// ownership and current-root integrity validation.
#[tauri::command]
pub fn starter_workflow_revision_read(
    state: State<'_, AppState>,
    request: ReadStarterWorkflowRevisionRequest,
) -> NativeResult<StarterWorkflowRevisionRecord> {
    state.storage.read_starter_workflow_revision(request)
}

/// Appends an immutable Starter Workflow revision and advances its root
/// projection atomically. Replay and payload-drift handling stay native.
#[tauri::command]
pub fn starter_workflow_revision_create(
    state: State<'_, AppState>,
    request: CreateStarterWorkflowRevisionRequest,
) -> NativeResult<StarterWorkflowSnapshot> {
    state.storage.create_starter_workflow_revision(request)
}

/// Applies a validated Starter Workflow lifecycle/enabled-state transition as
/// an immutable revision. `enabled` never grants execution authority by itself.
#[tauri::command]
pub fn starter_workflow_status_update(
    state: State<'_, AppState>,
    request: UpdateStarterWorkflowStatusRequest,
) -> NativeResult<StarterWorkflowSnapshot> {
    state.storage.update_starter_workflow_status(request)
}

/// Applies an enabled-only Starter Workflow lifecycle mutation through the
/// same native-authoritative revision/receipt boundary as status updates.
/// Enabling never grants execution authority by itself; the storage layer
/// still requires an active workflow and an explicit approval boundary for
/// any future execution path.
#[tauri::command]
pub fn starter_workflow_enabled_update(
    state: State<'_, AppState>,
    request: UpdateStarterWorkflowEnabledRequest,
) -> NativeResult<StarterWorkflowSnapshot> {
    state.storage.update_starter_workflow_enabled(request)
}

/// Creates one native-authoritative Task under an existing live Goal. Task
/// lineage, canonical payload, revision identity, and replay receipts remain
/// owned by native storage; this command only delegates the typed request.
#[tauri::command]
pub fn task_create(
    state: State<'_, AppState>,
    request: CreateTaskRequest,
) -> NativeResult<TaskSnapshot> {
    state.storage.create_task(request)
}

/// Reads one verified Task projection together with its current immutable
/// revision and bounded dependency projection.
#[tauri::command]
pub fn task_read(
    state: State<'_, AppState>,
    request: ReadTaskRequest,
) -> NativeResult<TaskSnapshot> {
    state.storage.read_task(request)
}

/// Lists bounded Task summaries for an owned Goal/project/conversation scope.
#[tauri::command]
pub fn task_list(
    state: State<'_, AppState>,
    request: ListTasksRequest,
) -> NativeResult<Vec<TaskSummary>> {
    state.storage.list_tasks(request)
}

/// Reads one immutable historical Task revision after native ownership and
/// current-root integrity validation.
#[tauri::command]
pub fn task_revision_read(
    state: State<'_, AppState>,
    request: ReadTaskRevisionRequest,
) -> NativeResult<TaskRevisionRecord> {
    state.storage.read_task_revision(request)
}

/// Appends an immutable Task revision and advances its root projection
/// atomically. Idempotent replay and payload drift remain native concerns.
#[tauri::command]
pub fn task_revision_create(
    state: State<'_, AppState>,
    request: CreateTaskRevisionRequest,
) -> NativeResult<TaskSnapshot> {
    state.storage.create_task_revision(request)
}

/// Applies a validated Task lifecycle transition as an immutable revision.
/// Task status is planning metadata and does not itself grant execution.
#[tauri::command]
pub fn task_status_update(
    state: State<'_, AppState>,
    request: UpdateTaskStatusRequest,
) -> NativeResult<TaskSnapshot> {
    state.storage.update_task_status(request)
}

/// Adds one immutable, cycle-checked Task dependency. `related` remains
/// descriptive and cannot become execution authority by implication.
#[tauri::command]
pub fn task_dependency_create(
    state: State<'_, AppState>,
    request: CreateTaskDependencyRequest,
) -> NativeResult<TaskDependencyRecord> {
    state.storage.create_task_dependency(request)
}

/// Lists the bounded dependency projection for one live Task.
#[tauri::command]
pub fn task_dependency_list(
    state: State<'_, AppState>,
    request: ListTaskDependenciesRequest,
) -> NativeResult<Vec<TaskDependencyRecord>> {
    state.storage.list_task_dependencies(request)
}

#[tauri::command]
pub fn conversation_create(
    state: State<'_, AppState>,
    request: CreateConversationRequest,
) -> NativeResult<ConversationSnapshot> {
    state
        .storage
        .create_conversation(request.project_id.as_deref(), request.title.as_deref())
}

#[tauri::command]
pub fn conversation_list(state: State<'_, AppState>) -> NativeResult<Vec<ConversationSnapshot>> {
    state.storage.list_conversations()
}

#[tauri::command]
pub fn conversation_branch_fork(
    state: State<'_, AppState>,
    request: ForkConversationBranchRequest,
) -> NativeResult<ConversationSnapshot> {
    state.storage.fork_conversation_branch(
        &request.conversation_id,
        &request.parent_branch_id,
        &request.forked_from_message_id,
        request.name.as_deref(),
        request.activate,
    )
}

/// Selects one existing branch after storage revalidates its ownership and
/// confirms the conversation has no queued or running generation.
#[tauri::command]
pub fn conversation_branch_activate(
    state: State<'_, AppState>,
    request: ActivateConversationBranchRequest,
) -> NativeResult<ConversationSnapshot> {
    state.storage.activate_conversation_branch(
        &request.conversation_id,
        &request.branch_id,
        &request.expected_active_branch_id,
    )
}

/// Appends one immutable state revision and applies branch-head CAS inside a
/// single native storage transaction. The typed outcome is returned to the
/// renderer; stale callers are not retried or silently rebased here.
#[tauri::command]
pub fn state_revision_append(
    state: State<'_, AppState>,
    request: StateRevisionAppendRequest,
) -> NativeResult<crate::storage::StateRevisionMutationResult> {
    state.storage.append_state_revision(request)
}

/// Reads a content-free, redacted state-revision graph projection for one
/// owned conversation branch.
#[tauri::command]
pub fn state_revision_graph_read(
    state: State<'_, AppState>,
    request: ReadStateRevisionGraphRequest,
) -> NativeResult<StateRevisionGraphSnapshot> {
    state.storage.read_state_revision_graph_page(
        &request.conversation_id,
        &request.branch_id,
        StateRevisionGraphReadOptions {
            requested_through_branch_sequence: request.through_branch_sequence,
            revisions_limit: request.revisions_limit,
            edges_limit: request.edges_limit,
            revisions_cursor: request.revisions_cursor,
            edges_cursor: request.edges_cursor,
        },
    )
}

#[tauri::command]
pub fn run_journal_read(
    state: State<'_, AppState>,
    request: ReadRunJournalRequest,
) -> NativeResult<RunJournalReplayPage> {
    state.storage.read_run_journal(&request)
}

/// Returns a bounded, content-free projection of durable telemetry for an
/// owned run. The outer IPC session guard protects this command; storage also
/// revalidates exact profile, run, and attempt lineage before it reads rows.
#[tauri::command]
pub fn run_telemetry_read(
    state: State<'_, AppState>,
    request: ReadRunTelemetryRequest,
) -> NativeResult<RunTelemetrySnapshot> {
    state.storage.read_run_telemetry(&request)
}

/// Reads the exact immutable attempt's content-free provenance. Historical
/// inspection never looks up the current provider configuration for authority.
#[tauri::command]
pub fn provider_attempt_lineage_read(
    state: State<'_, AppState>,
    request: ReadProviderAttemptLineageRequest,
) -> NativeResult<ProviderAttemptLineageReceipt> {
    state.storage.read_provider_attempt_lineage(&request)
}

#[tauri::command]
pub fn conversation_run_prepare(
    state: State<'_, AppState>,
    request: PrepareConversationRunRequest,
) -> NativeResult<PreparedConversationRun<ConversationSnapshot>> {
    let context = request
        .context_admission
        .map(|admission| {
            compile_context_admission(&state.storage, &request.conversation_id, &admission)
        })
        .transpose()?;
    state
        .storage
        .prepare_conversation_run_with_attachment_drafts_and_context(
            NewConversationRun {
                conversation_id: &request.conversation_id,
                branch_id: &request.branch_id,
                run_id: &request.run_id,
                attempt_id: &request.attempt_id,
                user_message_id: &request.user_message_id,
                assistant_message_id: &request.assistant_message_id,
                prompt: &request.prompt,
                provider_profile_id: &request.provider_profile_id,
                model_id: &request.model,
                request_parameters_json: &request.request_parameters_json,
            },
            &[],
            context,
        )
}

/// Executes the native retrieval compiler used by run preparation.  Keeping
/// this behind the storage/grant boundary is important: the renderer supplies
/// only an opaque grant and query, while the native indexer owns the live
/// filesystem read, scope check, hashes and bounded selection.
fn compile_context_admission(
    storage: &crate::storage::Storage,
    conversation_id: &str,
    admission: &ContextAdmissionRequest,
) -> NativeResult<ContextAdmissionDraft> {
    let conversation = storage.get_conversation(conversation_id)?;
    let project_id = conversation.conversation.project_id.as_deref();
    let grants = storage.list_workspace_grants(project_id)?;
    if !grants
        .iter()
        .any(|grant| grant.id == admission.grant_id && grant.project_id.as_deref() == project_id)
    {
        return Err(NativeError::new(
            "workspace_retrieval_scope_conflict",
            "The retrieval grant is not in the conversation project scope",
        ));
    }
    let root = storage.workspace_root_for_read(&admission.grant_id)?;
    let (_grant_project_id, grant_updated_at_ms, canonical_path_hash) =
        storage.workspace_grant_scope_for_read(&admission.grant_id)?;
    let index = crate::workspace_indexer::build_workspace_index(
        &admission.grant_id,
        project_id,
        &root,
        &admission.index_options.clone().unwrap_or_default(),
    )?;
    let retrieval = crate::workspace_indexer::retrieve_workspace_chunks(
        &index.chunks,
        &admission.query,
        &admission.retrieval_options.clone().unwrap_or_default(),
    )?;
    Ok(ContextAdmissionDraft {
        grant_id: admission.grant_id.clone(),
        grant_updated_at_ms,
        canonical_path_hash,
        query_sha256: retrieval.query_sha256,
        index_snapshot_id: index.snapshot_id,
        index_snapshot_sha256: index.snapshot_sha256,
        indexer_version: index.indexer_version,
        scorer_version: retrieval.scorer_version,
        token_budget: retrieval.token_budget,
        consumed_tokens: retrieval.consumed_tokens,
        selected: retrieval
            .matches
            .into_iter()
            .map(|matched| ContextAdmissionItem {
                chunk_id: matched.chunk.chunk_id,
                source_id: matched.chunk.source_id,
                relative_path: matched.chunk.relative_path,
                content: matched.chunk.content,
                content_sha256: matched.chunk.content_sha256,
                token_estimate: matched.chunk.token_estimate,
                rank: matched.rank,
                score: matched.score,
                reasons: matched
                    .reasons
                    .into_iter()
                    .map(|reason| reason.as_str().to_owned())
                    .collect(),
            })
            .collect(),
        omitted: retrieval
            .omissions
            .into_iter()
            .map(|omitted| ContextAdmissionOmission {
                chunk_id: omitted.chunk_id,
                reason: omitted.reason.as_str().to_owned(),
            })
            .collect(),
    })
}

/// Resolves a renderer run-control intent into the canonical, redacted native
/// operation envelope and persists the immutable native receipt. The resolver
/// itself remains pure (schema, identity and state-base validation); durable
/// persistence happens only after that validation succeeds and is owned by the
/// native storage layer. Renderer-supplied receipt/state/timestamp/hash fields
/// are never trusted as durable metadata.
#[tauri::command]
pub fn run_control_resolve(
    state: State<'_, AppState>,
    request: crate::run_control::RunControlOperationIntent,
) -> NativeResult<crate::run_control::ResolvedRunControlOperation> {
    state.storage.persist_run_control_intent(request)
}

/// Applies a previously resolved run-control operation at the native commit
/// boundary. The operation envelope is loaded from the immutable receipt by
/// storage; the renderer supplies only the replay address and optional CAS
/// expectations.
#[tauri::command]
pub fn run_control_apply(
    state: State<'_, AppState>,
    request: crate::run_control::RunControlApplyRequest,
) -> NativeResult<crate::run_control::RunControlApplyResult> {
    state.storage.apply_run_control(request)
}

/// Creates an immutable run checkpoint. Native storage validates run/attempt
/// lineage, state-revision scope, bounded metadata and idempotency before
/// committing the checkpoint row.
#[tauri::command]
pub fn checkpoint_create(
    state: State<'_, AppState>,
    request: crate::run_control::CreateRunCheckpointRequest,
) -> NativeResult<crate::run_control::RunCheckpoint> {
    state.storage.create_run_checkpoint(request)
}

/// Reads one exact checkpoint when `checkpointId` is supplied, or the latest
/// checkpoint for the run otherwise. The native layer enforces profile, run,
/// conversation and branch scope and returns no raw provider/process data.
#[tauri::command]
pub fn checkpoint_read(
    state: State<'_, AppState>,
    request: crate::run_control::ReadRunCheckpointRequest,
) -> NativeResult<Option<crate::run_control::RunCheckpoint>> {
    state.storage.read_run_checkpoint(request)
}

/// Resolves and persists an immutable, loop-guarded continuation intent. Empty
/// prompt continuation is represented by the typed intent contract rather than
/// by fabricating a user message.
#[tauri::command]
pub fn continuation_intent_resolve(
    state: State<'_, AppState>,
    request: crate::run_control::ResolveContinuationIntentRequest,
) -> NativeResult<crate::run_control::ContinuationIntent> {
    state.storage.resolve_continuation_intent(request)
}

/// Creates an immutable message/prompt revision while preserving the original
/// message, frozen provider input and active attempt lineage.
#[tauri::command]
pub fn message_revision_resolve(
    state: State<'_, AppState>,
    request: crate::run_control::ResolveMessageRevisionRequest,
) -> NativeResult<crate::run_control::MessageRevision> {
    state.storage.resolve_message_revision(request)
}

#[tauri::command]
pub async fn workspace_grant_pick(
    app: AppHandle,
    state: State<'_, AppState>,
    request: AddWorkspaceFolderRequest,
) -> NativeResult<Option<WorkspaceGrantRecord>> {
    let selected = app
        .dialog()
        .file()
        .set_title("Add a read-only workspace folder")
        .blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|_| {
        NativeError::new(
            "unsupported_folder_reference",
            "The selected folder cannot be represented as a local path",
        )
    })?;
    state
        .storage
        .add_workspace_grant(request.project_id.as_deref(), &path)
        .map(Some)
}

#[tauri::command]
pub fn workspace_grant_list(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> NativeResult<Vec<WorkspaceGrantRecord>> {
    state.storage.list_workspace_grants(project_id.as_deref())
}

#[tauri::command]
pub fn workspace_grant_revoke(state: State<'_, AppState>, grant_id: String) -> NativeResult<bool> {
    state.storage.revoke_workspace_grant(&grant_id)
}

#[tauri::command]
pub fn workspace_directory_list(
    state: State<'_, AppState>,
    request: ListWorkspaceDirectoryRequest,
) -> NativeResult<WorkspaceDirectoryListing> {
    let root = state.storage.workspace_root_for_read(&request.grant_id)?;
    crate::workspace::list_directory(&request.grant_id, &root, request.relative_path.as_deref())
}

#[tauri::command]
pub fn workspace_text_file_read(
    state: State<'_, AppState>,
    request: ReadWorkspaceTextFileRequest,
) -> NativeResult<WorkspaceTextFile> {
    let root = state.storage.workspace_root_for_read(&request.grant_id)?;
    crate::workspace::read_text_file(&request.grant_id, &root, &request.relative_path)
}

/// Builds a bounded lexical index for a previously granted workspace folder.
/// The indexer performs canonical-path and reparse-point checks before reading
/// any file; no absolute path is accepted from the renderer.
#[tauri::command]
pub fn workspace_index_build(
    state: State<'_, AppState>,
    request: BuildWorkspaceIndexRequest,
) -> NativeResult<WorkspaceIndexSnapshot> {
    let root = state.storage.workspace_root_for_read(&request.grant_id)?;
    let options = request.options.unwrap_or_default();
    crate::workspace_indexer::build_workspace_index(
        &request.grant_id,
        request.project_id.as_deref(),
        &root,
        &options,
    )
}

/// Retrieves relevant chunks from an explicit index projection using the
/// native lexical/MMR scorer. The command is stateless and bounded by the
/// supplied retrieval policy.
#[tauri::command]
pub fn workspace_index_retrieve(
    request: RetrieveWorkspaceChunksRequest,
) -> NativeResult<WorkspaceRetrievalResult> {
    let options = request.options.unwrap_or_default();
    crate::workspace_indexer::retrieve_workspace_chunks(&request.chunks, &request.query, &options)
}

/// Executes retrieval from a native-owned grant and journals the evidence for
/// one exact prepared attempt. Unlike the stateless scorer, the renderer cannot
/// provide chunks, hashes, project labels, or receipt metadata on this path.
#[tauri::command]
pub fn workspace_index_retrieve_for_run(
    state: State<'_, AppState>,
    request: crate::run_retrieval::RetrieveWorkspaceForRunRequest,
) -> NativeResult<crate::run_retrieval::RunWorkspaceRetrievalResult> {
    crate::run_retrieval::retrieve_workspace_for_run(&state.storage, request)
}

fn require_pointer_project(state: &AppState, project_id: &str) -> NativeResult<()> {
    if !state.storage.project_exists(project_id)? {
        return Err(NativeError::new(
            "project_not_found",
            "The selected project no longer exists",
        ));
    }
    Ok(())
}

/// The native picker grants the selected file identity. Renderer paths are
/// never accepted as ingest authority. Snapshot bodies are encrypted locally.
#[tauri::command]
pub async fn project_file_pointer_pick(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ProjectFilePointerPickRequest,
) -> NativeResult<Option<Vec<ProjectFilePointerMutation>>> {
    require_pointer_project(&state, &request.project_id)?;
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("Link files to this project")
        .blocking_pick_files()
    else {
        return Ok(None);
    };
    if selected.is_empty() {
        return Ok(None);
    }
    let paths = selected
        .into_iter()
        .map(|selected| {
            selected.into_path().map_err(|_| {
                NativeError::new(
                    "unsupported_file_reference",
                    "A selected file cannot be represented as a local path",
                )
            })
        })
        .collect::<NativeResult<Vec<_>>>()?;
    require_pointer_project(&state, &request.project_id)?;
    state
        .project_file_pointers
        .import_files(&state.blob_keys, &request.project_id, &paths)
        .map(Some)
}

#[tauri::command]
pub fn project_file_pointer_list(
    state: State<'_, AppState>,
    request: ProjectFilePointerListRequest,
) -> NativeResult<Vec<ProjectFilePointerRecord>> {
    require_pointer_project(&state, &request.project_id)?;
    state.project_file_pointers.list(&request.project_id)
}

/// Lists only source-backed pointers eligible for a new retrieval admission.
/// Missing sources remain readable through `project_file_pointer_read`, but
/// cannot silently re-enter indexing after the native watcher marked them
/// unavailable.
#[tauri::command]
pub fn project_file_pointer_retrieval_candidates(
    state: State<'_, AppState>,
    request: ProjectFilePointerListRequest,
) -> NativeResult<Vec<ProjectFilePointerRecord>> {
    require_pointer_project(&state, &request.project_id)?;
    state
        .project_file_pointers
        .list_retrieval_candidates(&request.project_id)
}

/// One bounded watcher observation. Consumers schedule this only for watched
/// projects and use the returned revision as the next CAS expectation.
#[tauri::command]
pub fn project_file_pointer_refresh(
    state: State<'_, AppState>,
    request: ProjectFilePointerRefreshRequest,
) -> NativeResult<ProjectFilePointerMutation> {
    require_pointer_project(&state, &request.project_id)?;
    state.project_file_pointers.refresh(
        &state.blob_keys,
        &request.project_id,
        &request.pointer_id,
        request.expected_revision,
    )
}

#[tauri::command]
pub fn project_file_pointer_read(
    state: State<'_, AppState>,
    request: ProjectFilePointerReadRequest,
) -> NativeResult<ProjectFilePointerBody> {
    require_pointer_project(&state, &request.project_id)?;
    state.project_file_pointers.read_body(
        &state.blob_keys,
        &request.project_id,
        &request.pointer_id,
        request.expected_revision,
    )
}

#[tauri::command]
pub fn project_file_pointer_receipts(
    state: State<'_, AppState>,
    request: ProjectFilePointerReceiptsRequest,
) -> NativeResult<Vec<ProjectFilePointerReceipt>> {
    require_pointer_project(&state, &request.project_id)?;
    state
        .project_file_pointers
        .receipts(&request.project_id, &request.pointer_id)
}

#[tauri::command]
pub fn provider_profile_save(
    state: State<'_, AppState>,
    request: SaveProviderProfileRequest,
) -> NativeResult<ProviderProfileReceipt> {
    let provider_type = validate_provider_type(&request.provider_type)?;
    let auth_scheme = validate_provider_auth_scheme(
        provider_type,
        request
            .auth_scheme
            .as_deref()
            .unwrap_or(default_auth_scheme(provider_type)),
    )?;
    let has_secret = request
        .secret
        .as_deref()
        .is_some_and(|secret| !secret.trim().is_empty());
    if auth_scheme == "none" && has_secret {
        return Err(NativeError::invalid(
            "secret",
            "must be omitted when authentication is disabled",
        ));
    }
    if auth_scheme != "none" && !has_secret {
        return Err(NativeError::invalid(
            "secret",
            "is required for the selected provider authentication scheme",
        ));
    }
    let normalized_base_url = normalize_provider_url(
        &request.base_url,
        request.allow_local_network.unwrap_or(false),
    )?;
    let secret_receipt = request
        .secret
        .map(|secret| state.secrets.put(SecretPurpose::ProviderCredential, secret))
        .transpose()?;
    let secret_ref = secret_receipt
        .as_ref()
        .map(|receipt| receipt.secret_ref.as_str());
    let profile = state.storage.save_provider_profile(NewProviderProfile {
        provider_type,
        display_name: &request.display_name,
        normalized_base_url: &normalized_base_url,
        auth_scheme,
        organization_id: request.organization_id.as_deref(),
        remote_project_id: request.remote_project_id.as_deref(),
        credential_ref: secret_ref,
        local_network_grant: request.allow_local_network.unwrap_or(false),
    });

    match profile {
        Ok(profile) => Ok(ProviderProfileReceipt {
            profile,
            secret_status: secret_receipt
                .map(|receipt| receipt.status)
                .unwrap_or(SecretStatus::Missing),
        }),
        Err(error) => {
            if let Some(secret_ref) = secret_ref {
                let _ = state
                    .secrets
                    .delete(SecretPurpose::ProviderCredential, secret_ref);
            }
            Err(error)
        }
    }
}

fn default_auth_scheme(provider_type: &str) -> &'static str {
    match provider_type {
        "anthropic" => "api-key-header",
        "gemini" => "api-key-header",
        "local" => "none",
        "deepseek" => "bearer",
        _ => "bearer",
    }
}

fn validate_provider_type(value: &str) -> NativeResult<&'static str> {
    match value.trim().to_ascii_lowercase().replace('-', "_").as_str() {
        "openai" => Ok("openai"),
        "deepseek" => Ok("deepseek"),
        "anthropic" => Ok("anthropic"),
        "gemini" | "google" | "google_gemini" => Ok("gemini"),
        "openai_compatible" => Ok("openai_compatible"),
        "local" => Ok("local"),
        "azure" | "azure_openai" => Err(NativeError::new(
            "provider_not_available",
            "Azure OpenAI deployment routing is planned but is not available in this preview",
        )),
        "custom" | "custom_adapter" => Err(NativeError::new(
            "provider_not_available",
            "Declarative custom adapters are planned but are not available in this preview",
        )),
        _ => Err(NativeError::invalid(
            "providerType",
            "does not identify a supported chat adapter",
        )),
    }
}

fn validate_provider_auth_scheme(provider_type: &str, value: &str) -> NativeResult<&'static str> {
    let normalized = value.trim().to_ascii_lowercase().replace('-', "_");
    let allowed = match provider_type {
        "openai" | "deepseek" | "openai_compatible" => {
            matches!(normalized.as_str(), "bearer" | "api_key_header")
        }
        // Anthropic supports both its native `x-api-key` contract and the
        // bearer-token form used by Claude Code/delegated OAuth flows. Keep
        // Gemini restricted to its x-goog-api-key header.
        "anthropic" => matches!(normalized.as_str(), "api_key_header" | "bearer"),
        "gemini" => normalized == "api_key_header",
        "local" => matches!(normalized.as_str(), "none" | "bearer" | "api_key_header"),
        _ => false,
    };
    if !allowed {
        return Err(NativeError::invalid(
            "authScheme",
            "is not supported by the selected provider adapter",
        ));
    }
    Ok(match normalized.as_str() {
        "bearer" => "bearer",
        "api_key_header" => "api-key-header",
        "none" => "none",
        _ => unreachable!("validated auth scheme"),
    })
}

#[tauri::command]
pub fn provider_profile_list(
    state: State<'_, AppState>,
) -> NativeResult<Vec<ProviderProfileRecord>> {
    state.storage.list_provider_profiles()
}

#[tauri::command]
pub fn provider_profile_delete(
    state: State<'_, AppState>,
    profile_id: String,
) -> NativeResult<bool> {
    let secret_ref = state.storage.provider_credential_ref(&profile_id)?;
    if let Some(secret_ref) = secret_ref {
        state
            .secrets
            .delete(SecretPurpose::ProviderCredential, &secret_ref)
            .map_err(|_error| {
                NativeError::retryable(
                    "provider_secret_cleanup_failed",
                    "The provider was not removed because its Windows credential could not be deleted",
                )
            })?;
    }
    state.storage.delete_provider_profile(&profile_id)
}

fn normalize_provider_url(value: &str, allow_local_network: bool) -> NativeResult<String> {
    let mut url = Url::parse(value.trim())
        .map_err(|_| NativeError::invalid("baseUrl", "must be a valid HTTP or HTTPS URL"))?;
    if url.username() != "" || url.password().is_some() {
        return Err(NativeError::invalid(
            "baseUrl",
            "cannot contain embedded credentials",
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(NativeError::invalid(
            "baseUrl",
            "cannot contain a query or fragment",
        ));
    }
    if !matches!(url.scheme(), "http" | "https") {
        return Err(NativeError::invalid("baseUrl", "must use HTTP or HTTPS"));
    }

    let host = url
        .host()
        .ok_or_else(|| NativeError::invalid("baseUrl", "must include a hostname"))?;
    let is_local = match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => is_private_or_local(IpAddr::V4(address)),
        Host::Ipv6(address) => is_private_or_local(IpAddr::V6(address)),
    };
    if url.scheme() == "http" && !is_local {
        return Err(NativeError::invalid(
            "baseUrl",
            "must use HTTPS for internet providers",
        ));
    }
    if is_local && !allow_local_network {
        return Err(NativeError::new(
            "local_network_permission_required",
            "Local and private-network providers require an explicit local-network grant",
        ));
    }

    url.set_username("").ok();
    url.set_password(None).ok();
    if url.path().is_empty() {
        url.set_path("/");
    }
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

fn is_private_or_local(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || address.is_multicast()
                || address.is_unspecified()
        }
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_multicast()
                || address.is_unspecified()
                || (address.segments()[0] & 0xfe00) == 0xfc00
                || (address.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        prepared_provider_input::StartPreparedAttemptRequest,
        storage::{NewProviderProfile, Storage},
    };
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn provider_urls_reject_credentials_and_insecure_internet() {
        assert!(normalize_provider_url("https://user:pass@example.com/v1", false).is_err());
        assert!(normalize_provider_url("http://api.example.com/v1", false).is_err());
        assert_eq!(
            normalize_provider_url("https://api.example.com/v1/", false).unwrap(),
            "https://api.example.com/v1"
        );
    }

    #[test]
    fn local_providers_require_an_explicit_grant() {
        assert!(normalize_provider_url("http://localhost:11434/v1", false).is_err());
        assert_eq!(
            normalize_provider_url("http://localhost:11434/v1", true).unwrap(),
            "http://localhost:11434/v1"
        );
    }

    #[test]
    fn private_and_metadata_addresses_are_classified_as_local() {
        assert!(is_private_or_local("127.0.0.1".parse().unwrap()));
        assert!(is_private_or_local("169.254.169.254".parse().unwrap()));
        assert!(is_private_or_local("10.0.0.1".parse().unwrap()));
        assert!(!is_private_or_local("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn provider_types_and_auth_schemes_are_allowlisted() {
        assert_eq!(
            validate_provider_type("openai-compatible").unwrap(),
            "openai_compatible"
        );
        assert_eq!(validate_provider_type("DeepSeek").unwrap(), "deepseek");
        assert_eq!(
            validate_provider_auth_scheme("deepseek", "bearer").unwrap(),
            "bearer"
        );
        assert_eq!(
            validate_provider_auth_scheme("openai_compatible", "api-key-header").unwrap(),
            "api-key-header"
        );
        assert!(validate_provider_type("azure_openai").is_err());
        assert!(validate_provider_type("custom_adapter").is_err());
        assert_eq!(
            validate_provider_auth_scheme("anthropic", "bearer").unwrap(),
            "bearer"
        );
        assert!(validate_provider_auth_scheme("gemini", "query-parameter").is_err());
    }

    #[test]
    fn text_only_prepare_ipc_rejects_attachment_draft_ids_until_bridge_admission_exists() {
        let error = serde_json::from_value::<PrepareConversationRunRequest>(serde_json::json!({
            "conversationId": "conversation_0123456789abcdef0123456789abcdef",
            "branchId": "branch_0123456789abcdef0123456789abcdef",
            "runId": "run_0123456789abcdef0123456789abcdef",
            "attemptId": "attempt_0123456789abcdef0123456789abcdef",
            "userMessageId": "message_0123456789abcdef0123456789abcdef",
            "assistantMessageId": "message_11111111111111111111111111111111",
            "prompt": "Do not bind an attachment through text-only preparation.",
            "providerProfileId": "provider_0123456789abcdef0123456789abcdef",
            "model": "test-model",
            "attachmentDraftIds": ["attachment_draft_0123456789abcdef0123456789abcdef"]
        }))
        .expect_err("text-only IPC must reject attachment admission fields");

        assert!(error.to_string().contains("attachmentDraftIds"));
    }

    #[test]
    fn live_context_admission_populates_frozen_provider_input_and_journal_pointer() {
        let storage = Storage::in_memory().expect("storage should initialize");
        let project = storage
            .create_project("Native live retrieval", None, None)
            .expect("project should be created");
        let root = std::env::temp_dir().join(format!("omnia-native-live-rag-{}", Uuid::new_v4()));
        fs::create_dir(&root).expect("retrieval fixture should be created");
        fs::write(
            root.join("grounding.md"),
            "Native grounding evidence proves provider input admission from a live workspace.",
        )
        .expect("retrieval fixture should be written");
        let cleanup_root = root.clone();
        let cleanup = || {
            let temp_root = fs::canonicalize(std::env::temp_dir()).ok();
            let target = fs::canonicalize(&cleanup_root).ok();
            if let (Some(temp_root), Some(target)) = (temp_root, target) {
                if target.parent() == Some(temp_root.as_path())
                    && target.file_name().is_some_and(|name| {
                        name.to_string_lossy().starts_with("omnia-native-live-rag-")
                    })
                {
                    let _ = fs::remove_dir_all(target);
                }
            }
        };
        let grant = storage
            .add_workspace_grant(Some(&project.id), &root)
            .expect("workspace grant should be created");
        let conversation = storage
            .create_conversation(Some(&project.id), Some("Live retrieval"))
            .expect("conversation should be created");
        let provider = storage
            .save_provider_profile(NewProviderProfile {
                provider_type: "local",
                display_name: "Native live retrieval provider",
                normalized_base_url: "http://127.0.0.1:11434/v1",
                auth_scheme: "none",
                organization_id: None,
                remote_project_id: None,
                credential_ref: None,
                local_network_grant: true,
            })
            .expect("provider should be created");
        let admission = ContextAdmissionRequest {
            grant_id: grant.id.clone(),
            query: "grounding evidence".to_owned(),
            index_options: None,
            retrieval_options: Some(WorkspaceRetrievalOptions {
                token_budget: 1_000,
                max_results: 4,
                max_results_per_source: 2,
                minimum_score: 0.15,
                diversity_lambda: 0.82,
                max_reported_omissions: 100,
            }),
        };
        let context =
            compile_context_admission(&storage, &conversation.conversation.id, &admission)
                .expect("native retrieval should compile from the live grant");
        assert_eq!(context.selected.len(), 1);
        assert!(context.selected[0]
            .content
            .contains("Native grounding evidence"));
        assert_eq!(context.selected[0].content_sha256.len(), 64);

        let run_id = format!("run_{}", Uuid::new_v4().simple());
        let attempt_id = format!("attempt_{}", Uuid::new_v4().simple());
        let user_message_id = format!("message_{}", Uuid::new_v4().simple());
        let assistant_message_id = format!("message_{}", Uuid::new_v4().simple());
        let prepared = storage
            .prepare_conversation_run_with_attachment_drafts_and_context(
                NewConversationRun {
                    conversation_id: &conversation.conversation.id,
                    branch_id: &conversation.conversation.active_branch_id,
                    run_id: &run_id,
                    attempt_id: &attempt_id,
                    user_message_id: &user_message_id,
                    assistant_message_id: &assistant_message_id,
                    prompt: "Answer with the grounded evidence.",
                    provider_profile_id: &provider.id,
                    model_id: "native-live-rag-model",
                    request_parameters_json: "{}",
                },
                &[],
                Some(context.clone()),
            )
            .expect("prepared run should freeze native context");
        let frozen = storage
            .load_prepared_provider_input(&StartPreparedAttemptRequest {
                attempt_id: attempt_id.clone(),
                frozen_provider_input_id: prepared.provider_input.id.clone(),
            })
            .expect("frozen provider input should be readable before dispatch");
        let admitted = frozen
            .messages
            .iter()
            .find(|message| message.role == "developer")
            .expect("retrieval should become a developer context message");
        assert!(admitted.content.contains("Native grounding evidence"));
        assert_eq!(
            frozen.messages.last().unwrap().content,
            "Answer with the grounded evidence."
        );

        let event_payload_json: String = storage
            .with_connection(|connection| {
                Ok(connection.query_row(
                    "SELECT payload_json FROM run_events
                     WHERE run_id = ?1 AND event_type = 'attempt.created'",
                    [&run_id],
                    |row| row.get(0),
                )?)
            })
            .expect("attempt journal payload should be readable");
        let event_payload: serde_json::Value =
            serde_json::from_str(&event_payload_json).expect("attempt payload should be JSON");
        let pointer = &event_payload["contextAdmission"];
        assert!(pointer["contextSnapshotId"]
            .as_str()
            .unwrap()
            .starts_with("context_snapshot_"));
        assert_eq!(
            pointer["querySha256"].as_str().unwrap(),
            context.query_sha256
        );
        assert_eq!(
            pointer["indexSnapshotSha256"].as_str().unwrap(),
            context.index_snapshot_sha256
        );
        let pointer_text = pointer.to_string();
        assert!(!pointer_text.contains("Native grounding evidence"));
        assert!(!pointer_text.contains("grounding.md"));
        cleanup();
    }
}
