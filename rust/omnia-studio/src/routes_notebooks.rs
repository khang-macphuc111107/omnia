//! Studio HTTP routes mounting `omnia-notebook` (`/api/notebooks/*`, `/api/btw/*`, `/api/bridge`).

use crate::http::{HttpRequest, HttpResponse};
use crate::routes_legacy::StudioState;
use base64::Engine as _;
use omnia_core::SecretRedactor;
use omnia_downloader::PrivacyShield;
use omnia_notebook::{
    is_streamable_media_mime, parse_http_byte_range, sanitize_transport_filename,
    strip_local_path_fields, BridgeDirection, BridgeTransferRequest, ChatSettings,
    CreateNotebookRequest, CreateQuoteCardRequest, EffortLevel, GenerateArtifactRequest,
    HttpByteRangeError, IngestSourceRequest, InteractionSurface, NotebookError, QuoteRef,
    RecordTurnRequest, RepoPackageConfig, SourceFilter, StudioArtifactKind,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

const MAX_INGEST_DECODED_BYTES: usize = 4 * 1024 * 1024;
const MAX_BATCH_TOTAL_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
enum DynamicNotebookRoute {
    IngestRepo { notebook_id: String },
    IngestBatch { notebook_id: String },
    RenameNotebook { notebook_id: String },
    SourceChecked { notebook_id: String, source_id: String },
    ChatSettings { notebook_id: String },
    AudioStream { notebook_id: String, artifact_id: String },
    BtwItem { btw_id: String },
}

fn is_safe_path_segment(seg: &str) -> bool {
    !seg.is_empty()
        && seg.len() <= 160
        && !seg.contains("..")
        && !seg.contains('/')
        && !seg.contains('\\')
        && !seg.bytes().any(|b| b < 0x20 || b == 0x7f)
}

fn parse_dynamic_notebook_route(path: &str) -> Option<DynamicNotebookRoute> {
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    match segs.as_slice() {
        ["api", "notebooks", id, "ingest-repo"] if is_safe_path_segment(id) => {
            Some(DynamicNotebookRoute::IngestRepo {
                notebook_id: (*id).to_string(),
            })
        }
        ["api", "notebooks", id, "ingest-batch"] if is_safe_path_segment(id) => {
            Some(DynamicNotebookRoute::IngestBatch {
                notebook_id: (*id).to_string(),
            })
        }
        ["api", "notebooks", id, "rename"] if is_safe_path_segment(id) => {
            Some(DynamicNotebookRoute::RenameNotebook {
                notebook_id: (*id).to_string(),
            })
        }
        ["api", "notebooks", id, "chat-settings"] if is_safe_path_segment(id) => {
            Some(DynamicNotebookRoute::ChatSettings {
                notebook_id: (*id).to_string(),
            })
        }
        ["api", "notebooks", id, "sources", sid, "checked"]
            if is_safe_path_segment(id) && is_safe_path_segment(sid) =>
        {
            Some(DynamicNotebookRoute::SourceChecked {
                notebook_id: (*id).to_string(),
                source_id: (*sid).to_string(),
            })
        }
        ["api", "notebooks", id, "artifacts", aid, "audio"]
        | ["api", "notebooks", id, "media", aid]
            if is_safe_path_segment(id) && is_safe_path_segment(aid) =>
        {
            Some(DynamicNotebookRoute::AudioStream {
                notebook_id: (*id).to_string(),
                artifact_id: (*aid).to_string(),
            })
        }
        ["api", "btw", btw_id]
            if is_safe_path_segment(btw_id)
                && !matches!(
                    *btw_id,
                    "quote-card" | "create" | "append" | "list" | "promote" | "delete" | "ask"
                ) =>
        {
            Some(DynamicNotebookRoute::BtwItem {
                btw_id: (*btw_id).to_string(),
            })
        }
        _ => None,
    }
}

/// Returns `true` when `path` matches a dynamic `/api/notebooks/:id/*` or `/api/btw/:id` route.
#[must_use]
pub(crate) fn is_dynamic_notebook_route(path: &str) -> bool {
    parse_dynamic_notebook_route(path).is_some()
}

pub(crate) fn ok_sanitized(mut payload: Value) -> HttpResponse {
    strip_local_path_fields(&mut payload);
    HttpResponse::ok(payload)
}

/// Dispatches `/api/notebooks/*`, `/api/btw/*`, and `/api/bridge` routes.
pub async fn dispatch_notebook_route(
    state: &Arc<StudioState>,
    req: &HttpRequest,
) -> Option<HttpResponse> {
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/notebooks/status") => Some(handle_notebooks_status(state)),
        ("GET", "/api/notebooks") => Some(handle_notebooks_list(state)),
        ("POST", "/api/notebooks") => Some(handle_notebooks_create(state, req)),
        ("GET", "/api/notebooks/get") => Some(handle_notebooks_get(state, req)),
        ("POST", "/api/notebooks/delete") => Some(handle_notebooks_delete(state, req)),
        ("POST", "/api/notebooks/rename") | ("PATCH", "/api/notebooks/rename") => {
            Some(handle_notebooks_rename(state, req, None))
        }
        ("POST", "/api/notebooks/model") => Some(handle_notebooks_model(state, req)),
        ("GET", "/api/notebooks/chat-settings") => {
            Some(handle_chat_settings_get(state, req, None))
        }
        ("PUT", "/api/notebooks/chat-settings")
        | ("PATCH", "/api/notebooks/chat-settings")
        | ("POST", "/api/notebooks/chat-settings") => {
            Some(handle_chat_settings_put(state, req, None))
        }

        ("POST", "/api/notebooks/ingest-repo") => Some(handle_ingest_repo(state, req, None).await),
        ("POST", "/api/notebooks/sources/ingest") => {
            Some(handle_sources_ingest(state, req).await)
        }
        ("POST", "/api/notebooks/sources/ingest-batch") => {
            Some(handle_ingest_batch(state, req, None).await)
        }
        ("POST", "/api/notebooks/sources/checked")
        | ("PATCH", "/api/notebooks/sources/checked") => {
            Some(handle_source_checked(state, req, None, None))
        }
        ("GET", "/api/notebooks/sources") => Some(handle_sources_list(state, req)),
        ("GET", "/api/notebooks/sources/content") => Some(handle_source_content(state, req)),
        ("POST", "/api/notebooks/sources/clear") => Some(handle_sources_clear(state, req)),
        ("POST", "/api/notebooks/sources/heal") => Some(handle_sources_heal(state, req).await),
        ("POST", "/api/notebooks/preview") => Some(handle_preview(state, req).await),
        ("GET", "/api/notebooks/audio") => {
            Some(handle_audio_range_stream(state, req, None, None))
        }

        ("POST", "/api/notebooks/grounded-prompt") => {
            Some(handle_grounded_prompt(state, req).await)
        }
        ("POST", "/api/notebooks/verify-citations") => Some(handle_verify_citations(state, req)),
        ("GET", "/api/notebooks/turns") => Some(handle_turns_list(state, req)),
        ("POST", "/api/notebooks/turns") => Some(handle_turns_record(state, req)),

        ("GET", "/api/notebooks/artifacts") => Some(handle_artifacts_list(state, req)),
        ("POST", "/api/notebooks/artifacts") => Some(handle_artifacts_generate(state, req).await),
        ("POST", "/api/notebooks/artifacts/rename") => Some(handle_artifacts_rename(state, req)),
        ("POST", "/api/notebooks/artifacts/delete") => Some(handle_artifacts_delete(state, req)),
        ("POST", "/api/notebooks/import-share") => Some(handle_import_share(state, req).await),

        ("POST", "/api/btw/quote-card") => Some(handle_btw_quote_card(state, req)),
        ("POST", "/api/btw/create") => Some(handle_btw_create(state, req)),
        ("POST", "/api/btw/append") => Some(handle_btw_append(state, req)),
        ("GET", "/api/btw/list") => Some(handle_btw_list(state, req)),
        ("POST", "/api/btw/promote") => Some(handle_btw_promote(state, req)),
        ("POST", "/api/btw/delete") | ("DELETE", "/api/btw/delete") => {
            Some(handle_btw_delete(state, req, None))
        }

        ("POST", "/api/bridge") => Some(handle_bridge_transfer(state, req)),
        ("GET", "/api/bridge") => Some(handle_bridge_list(state, req)),

        (
            _,
            "/api/notebooks/status"
            | "/api/notebooks"
            | "/api/notebooks/get"
            | "/api/notebooks/delete"
            | "/api/notebooks/rename"
            | "/api/notebooks/model"
            | "/api/notebooks/chat-settings"
            | "/api/notebooks/ingest-repo"
            | "/api/notebooks/sources/ingest"
            | "/api/notebooks/sources/ingest-batch"
            | "/api/notebooks/sources/checked"
            | "/api/notebooks/sources"
            | "/api/notebooks/sources/content"
            | "/api/notebooks/sources/clear"
            | "/api/notebooks/sources/heal"
            | "/api/notebooks/preview"
            | "/api/notebooks/audio"
            | "/api/notebooks/grounded-prompt"
            | "/api/notebooks/verify-citations"
            | "/api/notebooks/turns"
            | "/api/notebooks/artifacts"
            | "/api/notebooks/artifacts/rename"
            | "/api/notebooks/artifacts/delete"
            | "/api/notebooks/import-share"
            | "/api/btw/quote-card"
            | "/api/btw/create"
            | "/api/btw/append"
            | "/api/btw/list"
            | "/api/btw/promote"
            | "/api/btw/delete"
            | "/api/bridge",
        ) => Some(HttpResponse::error(
            405,
            "method_not_allowed",
            "HTTP method not allowed for notebook route.",
        )),

        _ => {
            let dyn_route = parse_dynamic_notebook_route(req.path.as_str())?;
            match (req.method.as_str(), dyn_route) {
                ("POST", DynamicNotebookRoute::IngestRepo { notebook_id }) => {
                    Some(handle_ingest_repo(state, req, Some(notebook_id)).await)
                }
                ("POST", DynamicNotebookRoute::IngestBatch { notebook_id }) => {
                    Some(handle_ingest_batch(state, req, Some(notebook_id)).await)
                }
                ("PATCH" | "POST" | "PUT", DynamicNotebookRoute::RenameNotebook { notebook_id }) => {
                    Some(handle_notebooks_rename(state, req, Some(notebook_id)))
                }
                (
                    "PATCH" | "POST" | "PUT",
                    DynamicNotebookRoute::SourceChecked {
                        notebook_id,
                        source_id,
                    },
                ) => Some(handle_source_checked(
                    state,
                    req,
                    Some(notebook_id),
                    Some(source_id),
                )),
                ("GET", DynamicNotebookRoute::ChatSettings { notebook_id }) => {
                    Some(handle_chat_settings_get(state, req, Some(notebook_id)))
                }
                ("PUT" | "PATCH" | "POST", DynamicNotebookRoute::ChatSettings { notebook_id }) => {
                    Some(handle_chat_settings_put(state, req, Some(notebook_id)))
                }
                (
                    "GET",
                    DynamicNotebookRoute::AudioStream {
                        notebook_id,
                        artifact_id,
                    },
                ) => Some(handle_audio_range_stream(
                    state,
                    req,
                    Some(notebook_id),
                    Some(artifact_id),
                )),
                ("DELETE", DynamicNotebookRoute::BtwItem { btw_id }) => {
                    Some(handle_btw_delete(state, req, Some(btw_id)))
                }
                _ => Some(HttpResponse::error(
                    405,
                    "method_not_allowed",
                    "HTTP method not allowed for notebook route.",
                )),
            }
        }
    }
}

fn is_unc_or_smb_path(raw: &str) -> bool {
    let trimmed = raw.trim();
    trimmed.starts_with(r"\\")
        || trimmed.starts_with("//")
        || trimmed.starts_with(r"\??\")
        || trimmed.starts_with("/??/")
}

fn unc_blocked_response() -> HttpResponse {
    HttpResponse::error(
        400,
        "unc_path_blocked",
        "UNC/SMB or NT object-namespace paths are blocked for notebook operations.",
    )
}

fn redact_notebook_error_detail(raw: &str) -> String {
    let mut sanitized_tokens = Vec::new();
    for token in raw.split_whitespace() {
        let trimmed = token.trim_matches(|c: char| matches!(c, '(' | ')' | '"' | '\'' | ',' | ';'));
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            let safe_url = PrivacyShield::sanitize_for_receipt(trimmed);
            sanitized_tokens.push(token.replace(trimmed, &safe_url));
        } else {
            sanitized_tokens.push(token.to_string());
        }
    }
    SecretRedactor::redact(&sanitized_tokens.join(" "))
}

pub(crate) fn map_notebook_error(err: NotebookError) -> HttpResponse {
    let safe_detail = redact_notebook_error_detail(&err.to_string());
    HttpResponse::error(err.http_status(), err.error_code(), &safe_detail)
}

fn required_str(
    obj: &serde_json::Map<String, Value>,
    keys: &[&str],
    field_label: &str,
) -> Result<String, HttpResponse> {
    for key in keys {
        if let Some(val) = obj
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Ok(val.to_string());
        }
    }
    Err(HttpResponse::error(
        400,
        "missing_field",
        &format!("Field '{field_label}' is required."),
    ))
}

fn parse_effort(raw: &str) -> Result<EffortLevel, HttpResponse> {
    EffortLevel::parse_bilingual(raw).map_err(|_| {
        HttpResponse::error(
            400,
            "invalid_effort",
            &format!(
                "Unsupported effort '{}'; expected minimal, low, medium, high, xhigh, or max.",
                raw.trim()
            ),
        )
    })
}

fn parse_surface(raw: &str) -> Result<InteractionSurface, HttpResponse> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "gemini" => Ok(InteractionSurface::Gemini),
        "notebook" => Ok(InteractionSurface::Notebook),
        other => Err(HttpResponse::error(
            400,
            "invalid_surface",
            &format!("Unsupported surface '{other}'; expected 'notebook' or 'gemini'."),
        )),
    }
}

pub(crate) fn parse_artifact_kind(raw: &str) -> Result<StudioArtifactKind, HttpResponse> {
    match raw.trim().to_ascii_lowercase().replace('-', "_").as_str() {
        "briefing" | "briefing_doc" => Ok(StudioArtifactKind::Briefing),
        "study_guide" | "studyguide" => Ok(StudioArtifactKind::StudyGuide),
        "audio_overview" | "audio" | "audiooverview" => Ok(StudioArtifactKind::AudioOverview),
        "slide_deck" | "slidedeck" | "slides" => Ok(StudioArtifactKind::SlideDeck),
        "faq" => Ok(StudioArtifactKind::Faq),
        "timeline" => Ok(StudioArtifactKind::Timeline),
        "quiz" => Ok(StudioArtifactKind::Quiz),
        "flashcards" => Ok(StudioArtifactKind::Flashcards),
        "mind_map" | "mindmap" => Ok(StudioArtifactKind::MindMap),
        "infographic" | "infographic_spec" | "infographicspec" => {
            Ok(StudioArtifactKind::InfographicSpec)
        }
        "data_table" | "datatable" => Ok(StudioArtifactKind::DataTable),
        other => Err(HttpResponse::error(
            400,
            "invalid_artifact_kind",
            &format!("Unsupported artifact kind '{other}'."),
        )),
    }
}

fn parse_bridge_direction(raw: &str) -> Result<BridgeDirection, HttpResponse> {
    match raw.trim().to_ascii_lowercase().replace('-', "_").as_str() {
        "gemini_to_notebook" => Ok(BridgeDirection::GeminiToNotebook),
        "notebook_to_gemini" => Ok(BridgeDirection::NotebookToGemini),
        other => Err(HttpResponse::error(
            400,
            "invalid_bridge_direction",
            &format!(
                "Unsupported direction '{other}'; expected 'gemini_to_notebook' or 'notebook_to_gemini'."
            ),
        )),
    }
}

fn decode_text_or_base64(obj: &serde_json::Map<String, Value>) -> Result<Vec<u8>, HttpResponse> {
    if let Some(b64) = obj
        .get("bytes_base64")
        .or_else(|| obj.get("bytesBase64"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|err| {
                HttpResponse::error(
                    400,
                    "invalid_base64",
                    &format!("Field 'bytes_base64' is invalid base64: {err}"),
                )
            })?;
        if decoded.len() > MAX_INGEST_DECODED_BYTES {
            return Err(HttpResponse::error(
                413,
                "payload_too_large",
                "Decoded source payload exceeds 4 MiB limit.",
            ));
        }
        return Ok(decoded);
    }
    if let Some(text) = obj
        .get("text")
        .or_else(|| obj.get("content"))
        .and_then(Value::as_str)
    {
        if text.len() > MAX_INGEST_DECODED_BYTES {
            return Err(HttpResponse::error(
                413,
                "payload_too_large",
                "Source text exceeds 4 MiB limit.",
            ));
        }
        return Ok(text.as_bytes().to_vec());
    }
    Err(HttpResponse::error(
        400,
        "missing_content",
        "Either 'text' or 'bytes_base64' is required.",
    ))
}

fn parse_bool_query(req: &HttpRequest, key: &str) -> bool {
    req.query_param(key)
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

fn handle_notebooks_status(state: &Arc<StudioState>) -> HttpResponse {
    match state.notebooks.status() {
        Ok(status) => HttpResponse::ok(json!({
            "ok": true,
            "status": status,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_notebooks_list(state: &Arc<StudioState>) -> HttpResponse {
    match state.notebooks.list_notebooks() {
        Ok(notebooks) => HttpResponse::ok(json!({
            "ok": true,
            "count": notebooks.len(),
            "notebooks": notebooks,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_notebooks_create(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let create_req: CreateNotebookRequest = match serde_json::from_value(Value::Object(obj)) {
        Ok(r) => r,
        Err(err) => {
            return HttpResponse::error(
                400,
                "invalid_notebook_request",
                &format!("Invalid create notebook payload: {err}"),
            );
        }
    };
    match state.notebooks.create_notebook(create_req) {
        Ok(notebook) => HttpResponse::ok(json!({
            "ok": true,
            "notebook": notebook,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_notebooks_get(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let Some(id) = req
        .query_param("id")
        .or_else(|| req.query_param("notebook_id"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(400, "missing_notebook_id", "Query parameter 'id' is required.");
    };
    match state.notebooks.get_notebook(&id) {
        Ok(notebook) => HttpResponse::ok(json!({
            "ok": true,
            "notebook": notebook,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_notebooks_delete(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match required_str(&obj, &["notebook_id", "notebookId", "id"], "notebook_id")
    {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match state.notebooks.delete_notebook(&notebook_id) {
        Ok(deleted) => HttpResponse::ok(json!({
            "ok": true,
            "notebook_id": notebook_id,
            "deleted": deleted,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_notebooks_model(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match required_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let model_id = match required_str(&obj, &["model_id", "modelId", "model"], "model_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let effort_str = obj
        .get("effort")
        .or_else(|| obj.get("effort_level"))
        .and_then(Value::as_str)
        .unwrap_or("medium");
    let effort = match parse_effort(effort_str) {
        Ok(e) => e,
        Err(resp) => return resp,
    };
    match state
        .notebooks
        .set_notebook_model_effort(&notebook_id, &model_id, effort)
    {
        Ok(notebook) => HttpResponse::ok(json!({
            "ok": true,
            "notebook": notebook,
        })),
        Err(err) => map_notebook_error(err),
    }
}

async fn handle_sources_ingest(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match required_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let filename = match required_str(&obj, &["filename", "name"], "filename") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if is_unc_or_smb_path(&filename) {
        return unc_blocked_response();
    }
    let bytes = match decode_text_or_base64(&obj) {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    let ingest_req = IngestSourceRequest {
        notebook_id,
        title: obj
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string),
        filename,
        mime_type: obj
            .get("mime_type")
            .or_else(|| obj.get("mimeType"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string),
        remote_id: obj
            .get("remote_id")
            .or_else(|| obj.get("remoteId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string),
        bytes,
        copied_text_fallback: obj
            .get("copied_text_fallback")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        max_chunk_bytes: obj
            .get("max_chunk_bytes")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok()),
        metadata: obj.get("metadata").cloned().unwrap_or_else(|| json!({})),
    };

    let nb = Arc::clone(&state.notebooks);
    match tokio::task::spawn_blocking(move || nb.ingest_source(ingest_req)).await {
        Ok(Ok(outcome)) => ok_sanitized(json!({
            "ok": true,
            "outcome": outcome,
        })),
        Ok(Err(err)) => map_notebook_error(err),
        Err(err) => HttpResponse::error(500, "ingest_task_failed", &err.to_string()),
    }
}

fn handle_sources_list(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let Some(notebook_id) = req
        .query_param("notebook_id")
        .or_else(|| req.query_param("id"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(
            400,
            "missing_notebook_id",
            "Query parameter 'notebook_id' is required.",
        );
    };
    let source_ids = req
        .query_param("source_ids")
        .or_else(|| req.query_param("sourceIds"))
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty());
    let filter = SourceFilter {
        exclude_videos: parse_bool_query(req, "exclude_videos"),
        pure_documents_only: parse_bool_query(req, "pure_documents_only"),
        source_kinds: None,
        query: req
            .query_param("query")
            .or_else(|| req.query_param("q"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        source_ids,
        only_checked: parse_bool_query(req, "only_checked") || parse_bool_query(req, "onlyChecked"),
    };
    match state.notebooks.list_sources(&notebook_id, &filter) {
        Ok(sources) => ok_sanitized(json!({
            "ok": true,
            "count": sources.len(),
            "sources": sources,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_source_content(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let Some(notebook_id) = req
        .query_param("notebook_id")
        .or_else(|| req.query_param("notebookId"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(400, "missing_notebook_id", "Query parameter 'notebook_id' is required.");
    };
    let Some(source_id) = req
        .query_param("source_id")
        .or_else(|| req.query_param("sourceId"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(400, "missing_source_id", "Query parameter 'source_id' is required.");
    };
    let raw_mode = parse_bool_query(req, "raw") || parse_bool_query(req, "download");
    match state.notebooks.get_source_content(&notebook_id, &source_id) {
        Ok((source, content, sec)) => {
            let mut resp = if raw_mode {
                let mut r = HttpResponse::ok(json!({
                    "ok": true,
                    "source": source,
                    "content": content,
                    "headers": sec,
                }));
                r.body = content.into_bytes();
                r.content_type = if sec.force_attachment {
                    "application/octet-stream".to_string()
                } else {
                    "text/plain; charset=utf-8".to_string()
                };
                r
            } else {
                ok_sanitized(json!({
                    "ok": true,
                    "source": source,
                    "content": content,
                    "headers": sec,
                }))
            };
            resp.headers
                .push(("X-Content-Type-Options".to_string(), sec.x_content_type_options));
            resp.headers
                .push(("Content-Disposition".to_string(), sec.content_disposition));
            resp.headers
                .push(("Content-Security-Policy".to_string(), sec.content_security_policy));
            resp
        }
        Err(err) => map_notebook_error(err),
    }
}

fn handle_sources_clear(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match required_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    match state.notebooks.clear_sources(&notebook_id) {
        Ok(receipt) => HttpResponse::ok(json!({
            "ok": true,
            "receipt": receipt,
        })),
        Err(err) => map_notebook_error(err),
    }
}

async fn handle_sources_heal(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match required_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let nb = Arc::clone(&state.notebooks);
    match tokio::task::spawn_blocking(move || nb.heal_sources(&notebook_id)).await {
        Ok(Ok(report)) => HttpResponse::ok(json!({
            "ok": true,
            "report": report,
        })),
        Ok(Err(err)) => map_notebook_error(err),
        Err(err) => HttpResponse::error(500, "heal_task_failed", &err.to_string()),
    }
}

async fn handle_preview(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let filename = match required_str(&obj, &["filename", "name"], "filename") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if is_unc_or_smb_path(&filename) {
        return unc_blocked_response();
    }
    let mime_type = obj
        .get("mime_type")
        .or_else(|| obj.get("mimeType"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let bytes = match decode_text_or_base64(&obj) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let nb = Arc::clone(&state.notebooks);
    match tokio::task::spawn_blocking(move || {
        nb.preview_bytes(&filename, mime_type.as_deref(), &bytes)
    })
    .await
    {
        Ok(Ok(preview)) => {
            let force_attachment = preview.headers.force_attachment;
            let content_disposition = preview.headers.content_disposition.clone();
            let content_security_policy = preview.headers.content_security_policy.clone();
            let mut resp = HttpResponse::ok(json!({
                "ok": true,
                "preview": preview,
            }));
            if force_attachment {
                resp.headers
                    .push(("Content-Disposition".to_string(), content_disposition));
                resp.headers.push((
                    "Content-Security-Policy".to_string(),
                    content_security_policy,
                ));
            }
            resp
        }
        Ok(Err(err)) => map_notebook_error(err),
        Err(err) => HttpResponse::error(500, "preview_task_failed", &err.to_string()),
    }
}

async fn handle_grounded_prompt(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match required_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let query = match required_str(&obj, &["query", "prompt"], "query") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let max_chunks = obj
        .get("max_chunks")
        .or_else(|| obj.get("maxChunks"))
        .and_then(Value::as_u64)
        .map(|n| usize::try_from(n).unwrap_or(8).clamp(1, 32))
        .unwrap_or(8);
    let source_ids = obj
        .get("source_ids")
        .or_else(|| obj.get("sourceIds"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty());
    let filter = SourceFilter {
        exclude_videos: obj
            .get("exclude_videos")
            .or_else(|| obj.get("excludeVideos"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        pure_documents_only: obj
            .get("pure_documents_only")
            .or_else(|| obj.get("pureDocumentsOnly"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        source_kinds: None,
        query: None,
        source_ids,
        only_checked: obj
            .get("only_checked")
            .or_else(|| obj.get("onlyChecked"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };
    let nb = Arc::clone(&state.notebooks);
    match tokio::task::spawn_blocking(move || {
        nb.build_grounded_prompt(&notebook_id, &query, &filter, max_chunks)
    })
    .await
    {
        Ok(Ok(pack)) => ok_sanitized(json!({
            "ok": true,
            "pack": pack,
        })),
        Ok(Err(err)) => map_notebook_error(err),
        Err(err) => HttpResponse::error(500, "grounding_task_failed", &err.to_string()),
    }
}

fn handle_verify_citations(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match required_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let response_markdown = match required_str(
        &obj,
        &["response_markdown", "responseMarkdown", "markdown"],
        "response_markdown",
    ) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    match state
        .notebooks
        .verify_citations(&notebook_id, &response_markdown)
    {
        Ok(report) => HttpResponse::ok(json!({
            "ok": true,
            "report": report,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_turns_list(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let Some(notebook_id) = req
        .query_param("notebook_id")
        .or_else(|| req.query_param("id"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(
            400,
            "missing_notebook_id",
            "Query parameter 'notebook_id' is required.",
        );
    };
    match state.notebooks.list_turns(&notebook_id) {
        Ok(turns) => HttpResponse::ok(json!({
            "ok": true,
            "count": turns.len(),
            "turns": turns,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_turns_record(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match required_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let surface_str = obj
        .get("surface")
        .and_then(Value::as_str)
        .unwrap_or("notebook");
    let surface = match parse_surface(surface_str) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let prompt_text = match required_str(&obj, &["prompt_text", "promptText"], "prompt_text") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let response_markdown = obj
        .get("response_markdown")
        .or_else(|| obj.get("responseMarkdown"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let model_id = obj
        .get("model_id")
        .or_else(|| obj.get("modelId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("gemini-3.8-flash")
        .to_string();
    let effort_str = obj
        .get("effort")
        .or_else(|| obj.get("effort_level"))
        .and_then(Value::as_str)
        .unwrap_or("medium");
    let effort = match parse_effort(effort_str) {
        Ok(e) => e,
        Err(resp) => return resp,
    };
    let quotes: Vec<QuoteRef> = match obj.get("quotes") {
        Some(v) => match serde_json::from_value(v.clone()) {
            Ok(q) => q,
            Err(err) => {
                return HttpResponse::error(
                    400,
                    "invalid_quotes",
                    &format!("Invalid 'quotes' array: {err}"),
                );
            }
        },
        None => Vec::new(),
    };
    let citations: Vec<String> = obj
        .get("citations")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();

    let turn_req = RecordTurnRequest {
        notebook_id,
        surface,
        prompt_text,
        response_markdown,
        model_id,
        effort,
        quotes,
        citations,
    };
    match state.notebooks.record_turn(turn_req) {
        Ok(turn) => HttpResponse::ok(json!({
            "ok": true,
            "turn": turn,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_artifacts_list(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let Some(notebook_id) = req
        .query_param("notebook_id")
        .or_else(|| req.query_param("id"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(
            400,
            "missing_notebook_id",
            "Query parameter 'notebook_id' is required.",
        );
    };
    match state.notebooks.list_artifacts(&notebook_id) {
        Ok(artifacts) => HttpResponse::ok(json!({
            "ok": true,
            "count": artifacts.len(),
            "artifacts": artifacts,
        })),
        Err(err) => map_notebook_error(err),
    }
}

async fn handle_artifacts_generate(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match required_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let kind_raw = match required_str(&obj, &["kind"], "kind") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let kind = match parse_artifact_kind(&kind_raw) {
        Ok(k) => k,
        Err(resp) => return resp,
    };
    let gen_req = GenerateArtifactRequest {
        notebook_id,
        kind,
        title: obj
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string),
        source_ids: obj
            .get("source_ids")
            .or_else(|| obj.get("sourceIds"))
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect()
            }),
        focus_prompt: obj
            .get("focus_prompt")
            .or_else(|| obj.get("focusPrompt"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string),
    };
    let llm_cfg = build_notebook_llm_config(&obj, state);
    match state
        .notebooks
        .generate_artifact_with_llm(gen_req, &llm_cfg)
        .await
    {
        Ok(artifact) => {
            state.event_feed.publish(
                "atelier",
                "artifact_generated",
                None,
                serde_json::to_value(&artifact).unwrap_or_else(|_| json!({})),
            );
            HttpResponse::ok(json!({
                "ok": true,
                "artifact": artifact,
            }))
        }
        Err(err) => map_notebook_error(err),
    }
}

pub(crate) fn build_notebook_llm_config(
    obj: &serde_json::Map<String, Value>,
    state: &StudioState,
) -> omnia_notebook::NotebookLlmConfig {
    let mut cfg = omnia_notebook::NotebookLlmConfig::default();
    if let Some(m) = obj
        .get("model")
        .or_else(|| obj.get("modelSpec"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(p) = obj
            .get("provider")
            .or_else(|| obj.get("providerId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if !m.contains('/') {
                cfg.model_spec = format!("{p}/{m}");
            } else {
                cfg.model_spec = m.to_string();
            }
        } else {
            cfg.model_spec = m.to_string();
        }
    } else if let Ok(roles) = state.ops.list_model_roles() {
        if let Some(main_role) = roles.into_iter().find(|r| r.scope == "main") {
            cfg.model_spec = format!("{}/{}", main_role.provider_id, main_role.model_id);
        }
    }
    if let Some(u) = obj
        .get("baseUrl")
        .or_else(|| obj.get("base_url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        cfg.api_base_override = Some(u.to_string());
    }
    if let Some(k) = obj
        .get("apiKey")
        .or_else(|| obj.get("api_key"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        cfg.api_key_override = Some(k.to_string());
    }
    if let Some(w) = obj
        .get("wireApi")
        .or_else(|| obj.get("wire_api"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        cfg.wire_api_override = Some(w.to_string());
    }
    if let Some(eff_raw) = obj
        .get("effort")
        .or_else(|| obj.get("effort_level"))
        .or_else(|| obj.get("effortLevel"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Ok(parsed) = EffortLevel::parse_bilingual(eff_raw) {
            cfg.effort = Some(parsed);
        }
    }
    if obj
        .get("allowLoopback")
        .or_else(|| obj.get("allowLoopbackEndpoints"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        cfg.allow_loopback_endpoints = true;
    }
    cfg
}

fn handle_artifacts_rename(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let artifact_id = match required_str(&obj, &["artifact_id", "artifactId", "id"], "artifact_id")
    {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let title = match required_str(&obj, &["title", "new_title"], "title") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    match state.notebooks.rename_artifact(&artifact_id, &title) {
        Ok(artifact) => HttpResponse::ok(json!({
            "ok": true,
            "artifact": artifact,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_artifacts_delete(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let artifact_id = match required_str(&obj, &["artifact_id", "artifactId", "id"], "artifact_id")
    {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    match state.notebooks.delete_artifact(&artifact_id) {
        Ok(deleted) => HttpResponse::ok(json!({
            "ok": true,
            "artifact_id": artifact_id,
            "deleted": deleted,
        })),
        Err(err) => map_notebook_error(err),
    }
}

async fn handle_import_share(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match required_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let share_url = match required_str(&obj, &["share_url", "shareUrl", "url"], "share_url") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if is_unc_or_smb_path(&share_url) {
        return unc_blocked_response();
    }

    if let Some(pages_arr) = obj.get("raw_pages").and_then(Value::as_array) {
        let pages: Vec<String> = pages_arr
            .iter()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect();
        let nb = Arc::clone(&state.notebooks);
        return match tokio::task::spawn_blocking(move || {
            let refs: Vec<&str> = pages.iter().map(String::as_str).collect();
            nb.import_public_share_pages(&notebook_id, &share_url, &refs)
        })
        .await
        {
            Ok(Ok(outcome)) => HttpResponse::ok(json!({
                "ok": true,
                "outcome": outcome,
            })),
            Ok(Err(err)) => map_notebook_error(err),
            Err(err) => HttpResponse::error(500, "share_import_task_failed", &err.to_string()),
        };
    }

    match state
        .notebooks
        .fetch_and_import_public_share(&notebook_id, &share_url)
        .await
    {
        Ok(outcome) => HttpResponse::ok(json!({
            "ok": true,
            "outcome": outcome,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_btw_quote_card(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let card_req: CreateQuoteCardRequest = match serde_json::from_value(Value::Object(obj)) {
        Ok(r) => r,
        Err(err) => {
            return HttpResponse::error(
                400,
                "invalid_quote_card",
                &format!("Invalid quote card request: {err}"),
            );
        }
    };
    match state.notebooks.create_quote_card(card_req) {
        Ok(card) => HttpResponse::ok(json!({
            "ok": true,
            "card": card,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_btw_create(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let question = match required_str(
        &obj,
        &["question", "initial_question", "initialQuestion"],
        "question",
    ) {
        Ok(q) => q,
        Err(resp) => return resp,
    };
    let Some(quote_val) = obj.get("quote") else {
        return HttpResponse::error(400, "missing_quote", "Field 'quote' (QuoteRef) is required.");
    };
    let quote: QuoteRef = match serde_json::from_value(quote_val.clone()) {
        Ok(q) => q,
        Err(err) => {
            return HttpResponse::error(
                400,
                "invalid_quote",
                &format!("Field 'quote' is not a valid QuoteRef: {err}"),
            );
        }
    };
    match state.notebooks.create_btw_thread(quote, &question) {
        Ok(thread) => HttpResponse::ok(json!({
            "ok": true,
            "thread": thread,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_btw_append(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let btw_id = match required_str(&obj, &["btw_id", "btwId", "id"], "btw_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let role = obj
        .get("role")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("user");
    let content = match required_str(&obj, &["content", "message"], "content") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    match state.notebooks.append_btw_message(&btw_id, role, &content) {
        Ok(thread) => HttpResponse::ok(json!({
            "ok": true,
            "thread": thread,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_btw_list(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let Some(notebook_id) = req
        .query_param("notebook_id")
        .or_else(|| req.query_param("id"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(
            400,
            "missing_notebook_id",
            "Query parameter 'notebook_id' is required.",
        );
    };
    match state.notebooks.list_btw_threads(&notebook_id) {
        Ok(threads) => HttpResponse::ok(json!({
            "ok": true,
            "count": threads.len(),
            "threads": threads,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_btw_promote(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let btw_id = match required_str(&obj, &["btw_id", "btwId", "id"], "btw_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let title = obj
        .get("title")
        .or_else(|| obj.get("title_override"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match state.notebooks.promote_btw_to_source(&btw_id, title) {
        Ok(outcome) => HttpResponse::ok(json!({
            "ok": true,
            "outcome": outcome,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_bridge_transfer(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match required_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let dir_raw = match required_str(&obj, &["direction"], "direction") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let direction = match parse_bridge_direction(&dir_raw) {
        Ok(d) => d,
        Err(resp) => return resp,
    };
    let title = match required_str(&obj, &["title"], "title") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let content = match required_str(&obj, &["content"], "content") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let source_ids = obj
        .get("source_ids")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();
    let remote_turn_id = obj
        .get("remote_turn_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);

    let transfer_req = BridgeTransferRequest {
        notebook_id,
        direction,
        title,
        content,
        source_ids,
        remote_turn_id,
    };
    match state.notebooks.bridge_transfer(transfer_req) {
        Ok(receipt) => HttpResponse::ok(json!({
            "ok": true,
            "receipt": receipt,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_bridge_list(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let Some(notebook_id) = req
        .query_param("notebook_id")
        .or_else(|| req.query_param("id"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(
            400,
            "missing_notebook_id",
            "Query parameter 'notebook_id' is required.",
        );
    };
    match state.notebooks.list_bridge_events(&notebook_id) {
        Ok(events) => ok_sanitized(json!({
            "ok": true,
            "count": events.len(),
            "events": events,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_notebooks_rename(
    state: &Arc<StudioState>,
    req: &HttpRequest,
    path_notebook_id: Option<String>,
) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match path_notebook_id {
        Some(id) => id,
        None => match required_str(&obj, &["notebook_id", "notebookId", "id"], "notebook_id") {
            Ok(v) => v,
            Err(resp) => return resp,
        },
    };
    let title = match required_str(&obj, &["title", "new_title", "newTitle", "name"], "title") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    match state.notebooks.rename_notebook(&notebook_id, &title) {
        Ok(notebook) => ok_sanitized(json!({
            "ok": true,
            "notebook": notebook,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_source_checked(
    state: &Arc<StudioState>,
    req: &HttpRequest,
    path_notebook_id: Option<String>,
    path_source_id: Option<String>,
) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match path_notebook_id {
        Some(id) => id,
        None => match required_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
            Ok(v) => v,
            Err(resp) => return resp,
        },
    };
    let source_id = match path_source_id {
        Some(id) => id,
        None => match required_str(
            &obj,
            &["source_id", "sourceId", "remote_id", "remoteId"],
            "source_id",
        ) {
            Ok(v) => v,
            Err(resp) => return resp,
        },
    };
    let Some(checked) = obj
        .get("checked")
        .or_else(|| obj.get("selected"))
        .and_then(Value::as_bool)
    else {
        return HttpResponse::error(
            400,
            "missing_field",
            "Boolean field 'checked' is required.",
        );
    };
    match state
        .notebooks
        .set_source_checked(&notebook_id, &source_id, checked)
    {
        Ok(source) => ok_sanitized(json!({
            "ok": true,
            "source": source,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_chat_settings_get(
    state: &Arc<StudioState>,
    req: &HttpRequest,
    path_notebook_id: Option<String>,
) -> HttpResponse {
    let notebook_id = match path_notebook_id {
        Some(id) => id,
        None => match req
            .query_param("notebook_id")
            .or_else(|| req.query_param("notebookId"))
            .or_else(|| req.query_param("id"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            Some(v) => v,
            None => {
                return HttpResponse::error(
                    400,
                    "missing_notebook_id",
                    "Query parameter 'notebook_id' is required.",
                );
            }
        },
    };
    match state.notebooks.get_chat_settings(&notebook_id) {
        Ok(settings) => ok_sanitized(json!({
            "ok": true,
            "notebook_id": notebook_id,
            "settings": settings,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_chat_settings_put(
    state: &Arc<StudioState>,
    req: &HttpRequest,
    path_notebook_id: Option<String>,
) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match path_notebook_id {
        Some(id) => id,
        None => match required_str(&obj, &["notebook_id", "notebookId", "id"], "notebook_id") {
            Ok(v) => v,
            Err(resp) => return resp,
        },
    };
    let settings = ChatSettings {
        mode: obj
            .get("mode")
            .or_else(|| obj.get("chat_mode"))
            .or_else(|| obj.get("chatMode"))
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_string(),
        length: obj
            .get("length")
            .or_else(|| obj.get("chat_length"))
            .or_else(|| obj.get("chatLength"))
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_string(),
        custom_prompt: obj
            .get("customPrompt")
            .or_else(|| obj.get("custom_prompt"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    };
    match state.notebooks.set_chat_settings(&notebook_id, settings) {
        Ok(saved) => ok_sanitized(json!({
            "ok": true,
            "notebook_id": notebook_id,
            "settings": saved,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_btw_delete(
    state: &Arc<StudioState>,
    req: &HttpRequest,
    path_btw_id: Option<String>,
) -> HttpResponse {
    let btw_id = match path_btw_id {
        Some(id) => id,
        None => {
            if let Some(qid) = req
                .query_param("btw_id")
                .or_else(|| req.query_param("btwId"))
                .or_else(|| req.query_param("id"))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            {
                qid
            } else {
                let obj = match req.json_object() {
                    Ok(m) => m,
                    Err(resp) => return resp,
                };
                match required_str(&obj, &["btw_id", "btwId", "id"], "btw_id") {
                    Ok(v) => v,
                    Err(resp) => return resp,
                }
            }
        }
    };
    match state.notebooks.delete_btw_thread(&btw_id) {
        Ok(deleted) => ok_sanitized(json!({
            "ok": true,
            "btw_id": btw_id,
            "deleted": deleted,
        })),
        Err(err) => map_notebook_error(err),
    }
}

async fn handle_ingest_repo(
    state: &Arc<StudioState>,
    req: &HttpRequest,
    path_notebook_id: Option<String>,
) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match path_notebook_id {
        Some(id) => id,
        None => match required_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
            Ok(v) => v,
            Err(resp) => return resp,
        },
    };
    let raw_repo = match required_str(
        &obj,
        &["repo_path", "repoPath", "root_dir", "rootDir", "path"],
        "repo_path",
    ) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if is_unc_or_smb_path(&raw_repo) {
        return unc_blocked_response();
    }
    let candidate = PathBuf::from(&raw_repo);
    let root_dir = if candidate.is_absolute() {
        candidate
    } else {
        state.config.workspace_root.join(candidate)
    };
    let title = obj
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let mut cfg = RepoPackageConfig::for_workspace_root(&state.config.workspace_root);
    if let Some(mf) = obj
        .get("max_files")
        .or_else(|| obj.get("maxFiles"))
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
    {
        cfg.max_files = mf.clamp(1, 500);
    }
    if let Some(respect) = obj
        .get("respect_gitignore")
        .or_else(|| obj.get("respectGitignore"))
        .and_then(Value::as_bool)
    {
        cfg.respect_gitignore = respect;
    }

    let nb = Arc::clone(&state.notebooks);
    match tokio::task::spawn_blocking(move || {
        nb.ingest_code_repository(&notebook_id, &root_dir, title, &cfg)
    })
    .await
    {
        Ok(Ok((outcome, packaged))) => ok_sanitized(json!({
            "ok": true,
            "outcome": outcome,
            "packaged": {
                "root_name": packaged.root_name,
                "included_files": packaged.included_files,
                "skipped_binary_files": packaged.skipped_binary_files,
                "skipped_oversize_files": packaged.skipped_oversize_files,
                "skipped_reparse_entries": packaged.skipped_reparse_entries,
            }
        })),
        Ok(Err(err)) => map_notebook_error(err),
        Err(err) => HttpResponse::error(500, "ingest_repo_task_failed", &err.to_string()),
    }
}

async fn handle_ingest_batch(
    state: &Arc<StudioState>,
    req: &HttpRequest,
    path_notebook_id: Option<String>,
) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match path_notebook_id {
        Some(id) => id,
        None => match required_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
            Ok(v) => v,
            Err(resp) => return resp,
        },
    };
    let Some(raw_parts) = obj
        .get("parts")
        .or_else(|| obj.get("files"))
        .or_else(|| obj.get("sources"))
        .and_then(Value::as_array)
    else {
        return HttpResponse::error(
            400,
            "missing_parts",
            "Array field 'parts' is required for batch ingestion.",
        );
    };
    if raw_parts.is_empty() {
        return HttpResponse::error(400, "empty_parts", "Batch 'parts' array cannot be empty.");
    }

    let mut total_bytes = 0usize;
    let mut parts = Vec::with_capacity(raw_parts.len());
    for (idx, item) in raw_parts.iter().enumerate() {
        let Some(part_obj) = item.as_object() else {
            return HttpResponse::error(
                400,
                "invalid_part",
                &format!("Batch item at index {idx} must be a JSON object."),
            );
        };
        let filename = match required_str(part_obj, &["filename", "name"], "filename") {
            Ok(v) => v,
            Err(resp) => return resp,
        };
        if is_unc_or_smb_path(&filename) {
            return unc_blocked_response();
        }
        let bytes = match decode_text_or_base64(part_obj) {
            Ok(b) => b,
            Err(resp) => return resp,
        };
        total_bytes = total_bytes.saturating_add(bytes.len());
        if total_bytes > MAX_BATCH_TOTAL_BYTES {
            return HttpResponse::error(
                413,
                "payload_too_large",
                "Total decoded batch payload exceeds 16 MiB limit.",
            );
        }
        parts.push(IngestSourceRequest {
            notebook_id: notebook_id.clone(),
            title: part_obj
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string),
            filename,
            mime_type: part_obj
                .get("mime_type")
                .or_else(|| part_obj.get("mimeType"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string),
            remote_id: part_obj
                .get("remote_id")
                .or_else(|| part_obj.get("remoteId"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string),
            bytes,
            copied_text_fallback: part_obj
                .get("copied_text_fallback")
                .or_else(|| part_obj.get("copiedTextFallback"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            max_chunk_bytes: part_obj
                .get("max_chunk_bytes")
                .or_else(|| part_obj.get("maxChunkBytes"))
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok()),
            metadata: part_obj
                .get("metadata")
                .cloned()
                .unwrap_or_else(|| json!({})),
        });
    }

    let nb = Arc::clone(&state.notebooks);
    match tokio::task::spawn_blocking(move || nb.ingest_multipart_with_rollback(&notebook_id, parts))
        .await
    {
        Ok(Ok(outcome)) => ok_sanitized(json!({
            "ok": true,
            "outcome": outcome,
        })),
        Ok(Err(err)) => map_notebook_error(err),
        Err(err) => HttpResponse::error(500, "ingest_batch_task_failed", &err.to_string()),
    }
}

fn handle_audio_range_stream(
    state: &Arc<StudioState>,
    req: &HttpRequest,
    path_notebook_id: Option<String>,
    path_artifact_id: Option<String>,
) -> HttpResponse {
    if let Some(requested_mime) = req
        .query_param("mime")
        .or_else(|| req.query_param("content_type"))
    {
        if !is_streamable_media_mime(&requested_mime) {
            return HttpResponse::error(
                415,
                "unsupported_media_type",
                "Requested media MIME is not allowlisted for inline Range streaming.",
            );
        }
    }

    let notebook_id = match path_notebook_id {
        Some(id) => id,
        None => match req
            .query_param("notebook_id")
            .or_else(|| req.query_param("notebookId"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            Some(v) => v,
            None => {
                return HttpResponse::error(
                    400,
                    "missing_notebook_id",
                    "Parameter 'notebook_id' is required.",
                );
            }
        },
    };
    let artifact_id = match path_artifact_id {
        Some(id) => id,
        None => match req
            .query_param("artifact_id")
            .or_else(|| req.query_param("artifactId"))
            .or_else(|| req.query_param("id"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            Some(v) => v,
            None => {
                return HttpResponse::error(
                    400,
                    "missing_artifact_id",
                    "Parameter 'artifact_id' is required.",
                );
            }
        },
    };

    let artifact = match state.notebooks.get_artifact(&artifact_id) {
        Ok(a) if a.notebook_id == notebook_id => a,
        Ok(_) => {
            return HttpResponse::error(404, "NOT_FOUND", "Audio artifact not found in notebook.");
        }
        Err(err) => return map_notebook_error(err),
    };
    if artifact.kind != StudioArtifactKind::AudioOverview {
        return HttpResponse::error(
            415,
            "unsupported_media_type",
            "HTTP Range audio streaming is restricted to audio_overview artifacts.",
        );
    }

    let (_, wav) = match state
        .notebooks
        .render_audio_overview_wav(&notebook_id, &artifact_id)
    {
        Ok(pair) => pair,
        Err(err) => return map_notebook_error(err),
    };
    let safe_wav_name = sanitize_transport_filename(&format!("{}.wav", artifact.artifact_id), 72);

    if let Some(range_header) = req.header("range") {
        return match parse_http_byte_range(range_header, wav.len()) {
            Ok(range) => {
                let mut resp = HttpResponse::bytes(206, "audio/wav", range.slice(&wav).to_vec());
                resp.headers
                    .push(("Accept-Ranges".to_string(), "bytes".to_string()));
                resp.headers
                    .push(("Content-Range".to_string(), range.content_range_header()));
                resp.headers.push((
                    "Content-Disposition".to_string(),
                    format!("inline; filename=\"{safe_wav_name}\""),
                ));
                resp
            }
            Err(HttpByteRangeError::Unsatisfiable { total_len }) => {
                let mut resp = HttpResponse::error(
                    416,
                    "range_not_satisfiable",
                    "Requested byte range is outside the audio overview stream bounds.",
                );
                resp.headers
                    .push(("Accept-Ranges".to_string(), "bytes".to_string()));
                resp.headers
                    .push(("Content-Range".to_string(), format!("bytes */{total_len}")));
                resp
            }
            Err(HttpByteRangeError::InvalidHeader) => HttpResponse::error(
                400,
                "invalid_range",
                "Malformed HTTP Range header (expected 'bytes=start-end').",
            ),
        };
    }

    let mut resp = HttpResponse::bytes(200, "audio/wav", wav);
    resp.headers
        .push(("Accept-Ranges".to_string(), "bytes".to_string()));
    resp.headers.push((
        "Content-Disposition".to_string(),
        format!("inline; filename=\"{safe_wav_name}\""),
    ));
    resp
}

#[cfg(test)]
mod p0_notebook_route_tests {
    use super::*;

    #[test]
    fn dynamic_notebook_route_parser_handles_all_p0_routes_and_rejects_traversal() {
        assert_eq!(
            parse_dynamic_notebook_route("/api/notebooks/nb_123/ingest-repo"),
            Some(DynamicNotebookRoute::IngestRepo {
                notebook_id: "nb_123".to_string()
            })
        );
        assert_eq!(
            parse_dynamic_notebook_route("/api/notebooks/nb_123/ingest-batch"),
            Some(DynamicNotebookRoute::IngestBatch {
                notebook_id: "nb_123".to_string()
            })
        );
        assert_eq!(
            parse_dynamic_notebook_route("/api/notebooks/nb_123/rename"),
            Some(DynamicNotebookRoute::RenameNotebook {
                notebook_id: "nb_123".to_string()
            })
        );
        assert_eq!(
            parse_dynamic_notebook_route("/api/notebooks/nb_123/sources/src_9/checked"),
            Some(DynamicNotebookRoute::SourceChecked {
                notebook_id: "nb_123".to_string(),
                source_id: "src_9".to_string()
            })
        );
        assert_eq!(
            parse_dynamic_notebook_route("/api/notebooks/nb_123/chat-settings"),
            Some(DynamicNotebookRoute::ChatSettings {
                notebook_id: "nb_123".to_string()
            })
        );
        assert_eq!(
            parse_dynamic_notebook_route("/api/notebooks/nb_123/artifacts/art_7/audio"),
            Some(DynamicNotebookRoute::AudioStream {
                notebook_id: "nb_123".to_string(),
                artifact_id: "art_7".to_string()
            })
        );
        assert_eq!(
            parse_dynamic_notebook_route("/api/btw/btw_abc"),
            Some(DynamicNotebookRoute::BtwItem {
                btw_id: "btw_abc".to_string()
            })
        );
        // Reserved static `/api/btw/*` routes and path traversal must never match dynamic routes.
        assert_eq!(parse_dynamic_notebook_route("/api/btw/create"), None);
        assert_eq!(parse_dynamic_notebook_route("/api/btw/list"), None);
        assert_eq!(
            parse_dynamic_notebook_route("/api/notebooks/../evil/rename"),
            None
        );
    }

    #[test]
    fn effort_bilingual_parser_and_ok_sanitized_strip_local_paths() {
        assert_eq!(parse_effort("low").unwrap(), EffortLevel::Low);
        assert_eq!(parse_effort("xhigh").unwrap(), EffortLevel::XHigh);
        assert_eq!(parse_effort("max").unwrap(), EffortLevel::Max);
        assert_eq!(parse_effort("thấp").unwrap(), EffortLevel::Low);
        assert_eq!(parse_effort("trung bình").unwrap(), EffortLevel::Medium);
        assert_eq!(parse_effort("cao").unwrap(), EffortLevel::High);
        assert_eq!(parse_effort("rất cao").unwrap(), EffortLevel::XHigh);
        assert_eq!(parse_effort("tối đa").unwrap(), EffortLevel::Max);
        assert!(parse_effort("invalid-effort").is_err());

        let resp = ok_sanitized(json!({
            "ok": true,
            "localPath": "C:\\Users\\example\\secret.pdf",
            "nested": {
                "local_path": "/tmp/hidden.txt",
                "title": "Safe Title"
            }
        }));
        let parsed: Value = serde_json::from_slice(&resp.body).expect("json body");
        assert!(parsed.get("localPath").is_none());
        assert!(parsed["nested"].get("local_path").is_none());
        assert_eq!(parsed["nested"]["title"], "Safe Title");
    }
}
