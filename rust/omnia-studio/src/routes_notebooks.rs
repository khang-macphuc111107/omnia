//! Studio HTTP routes mounting `omnia-notebook` (`/api/notebooks/*`, `/api/btw/*`, `/api/bridge`).

use crate::http::{HttpRequest, HttpResponse};
use crate::routes_legacy::StudioState;
use base64::Engine as _;
use omnia_core::SecretRedactor;
use omnia_downloader::PrivacyShield;
use omnia_notebook::{
    BridgeDirection, BridgeTransferRequest, CreateNotebookRequest, CreateQuoteCardRequest,
    EffortLevel, GenerateArtifactRequest, IngestSourceRequest, InteractionSurface, NotebookError,
    QuoteRef, RecordTurnRequest, SourceFilter, StudioArtifactKind,
};
use serde_json::{json, Value};
use std::sync::Arc;

const MAX_INGEST_DECODED_BYTES: usize = 4 * 1024 * 1024;

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
        ("POST", "/api/notebooks/model") => Some(handle_notebooks_model(state, req)),

        ("POST", "/api/notebooks/sources/ingest") => {
            Some(handle_sources_ingest(state, req).await)
        }
        ("GET", "/api/notebooks/sources") => Some(handle_sources_list(state, req)),
        ("POST", "/api/notebooks/sources/clear") => Some(handle_sources_clear(state, req)),
        ("POST", "/api/notebooks/sources/heal") => Some(handle_sources_heal(state, req).await),
        ("POST", "/api/notebooks/preview") => Some(handle_preview(state, req).await),

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

        ("POST", "/api/bridge") => Some(handle_bridge_transfer(state, req)),
        ("GET", "/api/bridge") => Some(handle_bridge_list(state, req)),

        (
            _,
            "/api/notebooks/status"
            | "/api/notebooks"
            | "/api/notebooks/get"
            | "/api/notebooks/delete"
            | "/api/notebooks/model"
            | "/api/notebooks/sources/ingest"
            | "/api/notebooks/sources"
            | "/api/notebooks/sources/clear"
            | "/api/notebooks/sources/heal"
            | "/api/notebooks/preview"
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
            | "/api/bridge",
        ) => Some(HttpResponse::error(
            405,
            "method_not_allowed",
            "HTTP method not allowed for notebook route.",
        )),

        _ => None,
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

fn map_notebook_error(err: NotebookError) -> HttpResponse {
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
    match raw.trim().to_ascii_lowercase().as_str() {
        "minimal" => Ok(EffortLevel::Minimal),
        "low" => Ok(EffortLevel::Low),
        "medium" => Ok(EffortLevel::Medium),
        "high" => Ok(EffortLevel::High),
        other => Err(HttpResponse::error(
            400,
            "invalid_effort",
            &format!("Unsupported effort '{other}'; expected minimal, low, medium, or high."),
        )),
    }
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

fn parse_artifact_kind(raw: &str) -> Result<StudioArtifactKind, HttpResponse> {
    match raw.trim().to_ascii_lowercase().replace('-', "_").as_str() {
        "briefing" => Ok(StudioArtifactKind::Briefing),
        "study_guide" | "studyguide" => Ok(StudioArtifactKind::StudyGuide),
        "faq" => Ok(StudioArtifactKind::Faq),
        "timeline" => Ok(StudioArtifactKind::Timeline),
        "quiz" => Ok(StudioArtifactKind::Quiz),
        "flashcards" => Ok(StudioArtifactKind::Flashcards),
        "mind_map" | "mindmap" => Ok(StudioArtifactKind::MindMap),
        "infographic_spec" | "infographicspec" => Ok(StudioArtifactKind::InfographicSpec),
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
        Ok(Ok(outcome)) => HttpResponse::ok(json!({
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
    let filter = SourceFilter {
        exclude_videos: parse_bool_query(req, "exclude_videos"),
        pure_documents_only: parse_bool_query(req, "pure_documents_only"),
        source_kinds: None,
        query: req
            .query_param("query")
            .or_else(|| req.query_param("q"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    };
    match state.notebooks.list_sources(&notebook_id, &filter) {
        Ok(sources) => HttpResponse::ok(json!({
            "ok": true,
            "count": sources.len(),
            "sources": sources,
        })),
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
    let filter = SourceFilter {
        exclude_videos: obj
            .get("exclude_videos")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        pure_documents_only: obj
            .get("pure_documents_only")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        source_kinds: None,
        query: None,
    };
    let nb = Arc::clone(&state.notebooks);
    match tokio::task::spawn_blocking(move || {
        nb.build_grounded_prompt(&notebook_id, &query, &filter, max_chunks)
    })
    .await
    {
        Ok(Ok(pack)) => HttpResponse::ok(json!({
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
    let nb = Arc::clone(&state.notebooks);
    match tokio::task::spawn_blocking(move || nb.generate_artifact(gen_req)).await {
        Ok(Ok(artifact)) => HttpResponse::ok(json!({
            "ok": true,
            "artifact": artifact,
        })),
        Ok(Err(err)) => map_notebook_error(err),
        Err(err) => HttpResponse::error(500, "artifact_task_failed", &err.to_string()),
    }
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
        Ok(events) => HttpResponse::ok(json!({
            "ok": true,
            "count": events.len(),
            "events": events,
        })),
        Err(err) => map_notebook_error(err),
    }
}
