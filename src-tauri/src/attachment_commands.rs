use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::{
    attachment_repository::{
        AttachmentBinaryPreviewRecord, AttachmentDraftRecord, AttachmentDraftScope,
        AttachmentRecord, AttachmentTextRecord, IngestAttachmentDraft,
    },
    error::{NativeError, NativeResult},
    phase2_commands::{
        validate_attachment_binary_preview_request, validate_attachment_draft_abandon_request,
        validate_attachment_draft_get_request, validate_attachment_draft_list_request,
        validate_attachment_draft_remove_request, validate_attachment_list_request,
        validate_attachment_pick_request, validate_attachment_text_read_request,
        AttachmentBinaryPreviewRequest, AttachmentDraftAbandonRequest, AttachmentDraftGetRequest,
        AttachmentDraftListRequest, AttachmentDraftRemoveRequest, AttachmentListRequest,
        AttachmentPickRequest, AttachmentTextReadRequest,
    },
    state::AppState,
};

#[tauri::command]
pub async fn attachment_pick(
    app: AppHandle,
    state: State<'_, AppState>,
    request: AttachmentPickRequest,
) -> NativeResult<Option<AttachmentDraftRecord>> {
    validate_attachment_pick_request(&request)?;
    let max_files = request.max_files.unwrap_or(20) as usize;
    let selected = app
        .dialog()
        .file()
        .set_title("Add files to this conversation")
        .blocking_pick_files();
    let Some(selected) = selected else {
        return Ok(None);
    };
    if selected.is_empty() {
        return Ok(None);
    }
    if selected.len() > max_files {
        return Err(NativeError::invalid(
            "files",
            format!("must contain at most {max_files} selections"),
        ));
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

    state
        .attachments
        .ingest_draft(
            &state.storage,
            &state.content_store,
            &state.blob_keys,
            IngestAttachmentDraft {
                scope: AttachmentDraftScope {
                    project_id: None,
                    conversation_id: Some(&request.conversation_id),
                    branch_id: Some(&request.branch_id),
                },
                paths: &paths,
                accepted_media_types: &request.accepted_media_types,
                expires_at_ms: None,
            },
        )
        .map(Some)
}

#[tauri::command]
pub fn attachment_draft_get(
    state: State<'_, AppState>,
    request: AttachmentDraftGetRequest,
) -> NativeResult<AttachmentDraftRecord> {
    validate_attachment_draft_get_request(&request)?;
    state
        .attachments
        .get_draft(&state.storage, &request.draft_id)
}

#[tauri::command]
pub fn attachment_draft_list(
    state: State<'_, AppState>,
    request: AttachmentDraftListRequest,
) -> NativeResult<Vec<AttachmentDraftRecord>> {
    validate_attachment_draft_list_request(&request)?;
    state.attachments.list_drafts(
        &state.storage,
        &request.conversation_id,
        request.branch_id.as_deref(),
        request.include_terminal,
    )
}

#[tauri::command]
pub fn attachment_draft_remove(
    state: State<'_, AppState>,
    request: AttachmentDraftRemoveRequest,
) -> NativeResult<AttachmentDraftRecord> {
    validate_attachment_draft_remove_request(&request)?;
    state.attachments.remove_attachment(
        &state.storage,
        &state.content_store,
        &request.draft_id,
        &request.attachment_id,
    )
}

#[tauri::command]
pub fn attachment_draft_abandon(
    state: State<'_, AppState>,
    request: AttachmentDraftAbandonRequest,
) -> NativeResult<AttachmentDraftRecord> {
    validate_attachment_draft_abandon_request(&request)?;
    state
        .attachments
        .abandon_draft(&state.storage, &request.draft_id)
}

#[tauri::command]
pub fn attachment_list(
    state: State<'_, AppState>,
    request: AttachmentListRequest,
) -> NativeResult<Vec<AttachmentRecord>> {
    validate_attachment_list_request(&request)?;
    state.attachments.list_attachments(
        &state.storage,
        request.project_id.as_deref(),
        request.message_id.as_deref(),
        request.include_deleted,
    )
}

#[tauri::command]
pub fn attachment_text_read(
    state: State<'_, AppState>,
    request: AttachmentTextReadRequest,
) -> NativeResult<AttachmentTextRecord> {
    let max_bytes = validate_attachment_text_read_request(&request)?;
    state.attachments.read_text(
        &state.storage,
        &state.content_store,
        &state.blob_keys,
        &request.attachment_id,
        max_bytes,
    )
}

#[tauri::command]
pub fn attachment_binary_preview(
    state: State<'_, AppState>,
    request: AttachmentBinaryPreviewRequest,
) -> NativeResult<AttachmentBinaryPreviewRecord> {
    let max_bytes = validate_attachment_binary_preview_request(&request)?;
    state.attachments.read_binary_preview(
        &state.storage,
        &state.content_store,
        &state.blob_keys,
        &request.attachment_id,
        max_bytes,
    )
}
