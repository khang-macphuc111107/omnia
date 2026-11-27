//! Studio v5 routes for Notebook Atelier LLM Q&A / 9-Artifacts / Whisper / Tombstone Sync
//! (`/api/atelier/*`, `/api/notebooks/{ask,btw/ask,artifacts/generate,transcribe,sources/delete,sync/*}`)
//! and OmniDrive Pro v5 HLS/DASH + FFmpeg + CAS + 3-gram SchemaDrift + Crawlers
//! (`/api/omnidrive/*`, `/api/downloads/{stream,media/*,crawl/*,capture-bundles*,schema-drift}`).

use std::path::PathBuf;
use std::sync::Arc;

use omnia_core::{base64_decode, uuid_v4};
use omnia_downloader::{
    validate_safe_local_path, CaptureBundle, DownloadRequest, MediaMuxRequest, PacingMode,
};
use omnia_notebook::{
    InteractionSurface, RemoteSyncItem, SourceFilter, WhisperTranscribeRequest,
};
use serde_json::{json, Value};

use crate::http::{HttpRequest, HttpResponse};
use crate::routes_downloads::map_downloader_error;
use crate::routes_legacy::StudioState;
use crate::routes_notebooks::{build_notebook_llm_config, map_notebook_error};

#[must_use]
pub fn is_known_route(path: &str) -> bool {
    if path == "/api/atelier" || path.starts_with("/api/atelier/") {
        return true;
    }
    if path == "/api/omnidrive" || path.starts_with("/api/omnidrive/") {
        return true;
    }
    matches!(
        path,
        "/api/notebooks/ask"
            | "/api/notebooks/btw/ask"
            | "/api/notebooks/artifacts/generate"
            | "/api/notebooks/transcribe"
            | "/api/notebooks/sources/transcribe"
            | "/api/notebooks/sources/delete"
            | "/api/notebooks/sync/tombstones"
            | "/api/notebooks/sync/clear"
            | "/api/notebooks/sync/reconcile"
            | "/api/downloads/stream"
            | "/api/downloads/media/mux"
            | "/api/downloads/media/ffprobe"
            | "/api/downloads/crawl/moodle"
            | "/api/downloads/crawl/web"
            | "/api/downloads/crawl/youtube"
            | "/api/downloads/capture-bundles"
            | "/api/downloads/capture-bundles/verify"
            | "/api/downloads/bundles/capture"
            | "/api/downloads/schema-drift"
            | "/api/downloads/drift/compare"
            | "/api/omni-drive/stream"
            | "/api/omni-drive/media/mux"
            | "/api/omni-drive/media/ffprobe"
            | "/api/omni-drive/crawl/moodle"
            | "/api/omni-drive/crawl/web"
            | "/api/omni-drive/crawl/youtube"
            | "/api/omni-drive/capture-bundles"
            | "/api/omni-drive/capture-bundles/verify"
            | "/api/omni-drive/bundles"
            | "/api/omni-drive/bundles/capture"
            | "/api/omni-drive/schema-drift"
            | "/api/omni-drive/drift/compare"
    )
}

pub async fn dispatch(state: &Arc<StudioState>, req: &HttpRequest) -> Option<HttpResponse> {
    if let Some(resp) = dispatch_atelier(state, req).await {
        return Some(resp);
    }
    if let Some(resp) = dispatch_omnidrive(state, req).await {
        return Some(resp);
    }
    None
}

async fn dispatch_atelier(state: &Arc<StudioState>, req: &HttpRequest) -> Option<HttpResponse> {
    let norm = req
        .path
        .strip_prefix("/api/atelier")
        .map(|rest| format!("/api/notebooks{rest}"))
        .unwrap_or_else(|| req.path.clone());

    match (req.method.as_str(), norm.as_str()) {
        ("POST", "/api/notebooks/ask") => Some(handle_notebook_ask(state, req).await),
        ("POST", "/api/notebooks/btw/ask") => Some(handle_btw_ask(state, req).await),
        ("POST", "/api/notebooks/artifacts/generate") => {
            let mut aliased = req.clone();
            aliased.path = "/api/notebooks/artifacts".to_string();
            crate::routes_notebooks::dispatch_notebook_route(state, &aliased).await
        }
        ("POST", "/api/notebooks/transcribe") | ("POST", "/api/notebooks/sources/transcribe") => {
            Some(handle_notebook_transcribe(state, req).await)
        }
        ("POST", "/api/notebooks/sources/delete") => Some(handle_source_delete(state, req)),
        ("GET", "/api/notebooks/sync/tombstones") => Some(handle_sync_tombstones(state, req)),
        ("POST", "/api/notebooks/sync/clear") => Some(handle_sync_clear_tombstone(state, req)),
        ("POST", "/api/notebooks/sync/reconcile") => Some(handle_sync_reconcile(state, req)),
        _ if req.path == "/api/atelier" || req.path.starts_with("/api/atelier/") => {
            let mut aliased = req.clone();
            aliased.path = norm;
            crate::routes_notebooks::dispatch_notebook_route(state, &aliased).await
        }
        _ => None,
    }
}

async fn dispatch_omnidrive(state: &Arc<StudioState>, req: &HttpRequest) -> Option<HttpResponse> {
    let norm = req
        .path
        .strip_prefix("/api/omnidrive")
        .map(|rest| format!("/api/omni-drive{rest}"))
        .unwrap_or_else(|| req.path.clone());

    match (req.method.as_str(), norm.as_str()) {
        ("POST", "/api/downloads/stream") | ("POST", "/api/omni-drive/stream") => {
            Some(handle_stream_download(state, req).await)
        }
        ("POST", "/api/downloads/media/mux") | ("POST", "/api/omni-drive/media/mux") => {
            Some(handle_media_mux(state, req).await)
        }
        ("POST", "/api/downloads/media/ffprobe") | ("POST", "/api/omni-drive/media/ffprobe") => {
            Some(handle_media_ffprobe(state, req).await)
        }
        ("POST", "/api/downloads/crawl/moodle") | ("POST", "/api/omni-drive/crawl/moodle") => {
            Some(handle_crawl_moodle(state, req).await)
        }
        ("POST", "/api/downloads/crawl/web") | ("POST", "/api/omni-drive/crawl/web") => {
            Some(handle_crawl_web(state, req).await)
        }
        ("POST", "/api/downloads/crawl/youtube") | ("POST", "/api/omni-drive/crawl/youtube") => {
            Some(handle_crawl_youtube(state, req).await)
        }
        ("POST", "/api/downloads/capture-bundles")
        | ("POST", "/api/omni-drive/capture-bundles")
        | ("POST", "/api/downloads/bundles/capture")
        | ("POST", "/api/omni-drive/bundles")
        | ("POST", "/api/omni-drive/bundles/capture") => Some(handle_capture_bundle_seal(state, req)),
        ("POST", "/api/downloads/capture-bundles/verify")
        | ("POST", "/api/omni-drive/capture-bundles/verify") => {
            Some(handle_capture_bundle_verify(state, req))
        }
        ("POST", "/api/downloads/schema-drift")
        | ("POST", "/api/omni-drive/schema-drift")
        | ("POST", "/api/downloads/drift/compare")
        | ("POST", "/api/omni-drive/drift/compare") => {
            Some(handle_schema_drift(state, req))
        }
        _ if req.path == "/api/omnidrive" || req.path.starts_with("/api/omnidrive/") => {
            let mut aliased = req.clone();
            aliased.path = norm;
            crate::routes_downloads::dispatch_download_route(state, &aliased).await
        }
        _ => None,
    }
}

fn parse_obj(req: &HttpRequest) -> Result<serde_json::Map<String, Value>, HttpResponse> {
    if req.body.is_empty() {
        return Ok(serde_json::Map::new());
    }
    match serde_json::from_slice::<Value>(&req.body) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(HttpResponse::error(400, "invalid_json", "Expected JSON object.")),
        Err(e) => Err(HttpResponse::error(400, "invalid_json", &format!("Invalid JSON: {e}"))),
    }
}

fn req_str(
    obj: &serde_json::Map<String, Value>,
    keys: &[&str],
    label: &str,
) -> Result<String, HttpResponse> {
    for k in keys {
        if let Some(s) = obj
            .get(*k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Ok(s.to_string());
        }
    }
    Err(HttpResponse::error(
        400,
        "missing_field",
        &format!("Field '{label}' is required."),
    ))
}

fn qparam(req: &HttpRequest, name: &str) -> Option<String> {
    req.query_params()
        .into_iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v)
        .filter(|s| !s.trim().is_empty())
}

// =========================================================================
// Notebook / Atelier v5 Handlers
// =========================================================================

async fn handle_notebook_ask(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match req_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let query = match req_str(&obj, &["query", "prompt", "question"], "query") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let surface = match obj
        .get("surface")
        .and_then(Value::as_str)
        .unwrap_or("main")
        .to_ascii_lowercase()
        .as_str()
    {
        "chat" | "integrated_chat" | "gemini" => InteractionSurface::Gemini,
        _ => InteractionSurface::Notebook,
    };
    let max_chunks = obj
        .get("maxChunks")
        .or_else(|| obj.get("max_chunks"))
        .and_then(Value::as_u64)
        .unwrap_or(8)
        .clamp(1, 32) as usize;
    let exclude_videos = obj
        .get("excludeVideos")
        .or_else(|| obj.get("exclude_videos"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let pure_documents_only = obj
        .get("pureDocumentsOnly")
        .or_else(|| obj.get("pure_documents_only"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let filter = SourceFilter {
        exclude_videos,
        pure_documents_only,
        source_kinds: None,
        query: obj
            .get("sourceQuery")
            .or_else(|| obj.get("source_query"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
    };
    let llm_cfg = build_notebook_llm_config(&obj, state);

    match state
        .notebooks
        .ask_notebook_with_llm(&notebook_id, surface, &query, &filter, max_chunks, &llm_cfg)
        .await
    {
        Ok(outcome) => {
            state.event_feed.publish(
                "atelier",
                "grounded_answer",
                Some(&notebook_id),
                serde_json::to_value(&outcome).unwrap_or_else(|_| json!({})),
            );
            HttpResponse::ok(json!({ "ok": true, "result": outcome }))
        }
        Err(err) => map_notebook_error(err),
    }
}

async fn handle_btw_ask(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let btw_id = match req_str(&obj, &["btw_id", "btwId", "id"], "btw_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let question = match req_str(&obj, &["question", "query", "prompt"], "question") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let llm_cfg = build_notebook_llm_config(&obj, state);
    match state.notebooks.ask_btw_with_llm(&btw_id, &question, &llm_cfg).await {
        Ok(outcome) => HttpResponse::ok(json!({ "ok": true, "result": outcome })),
        Err(err) => map_notebook_error(err),
    }
}

async fn handle_notebook_transcribe(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match req_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let media_path = match req_str(&obj, &["media_path", "mediaPath", "path"], "media_path") {
        Ok(v) => PathBuf::from(v),
        Err(resp) => return resp,
    };
    let wreq = WhisperTranscribeRequest {
        notebook_id,
        media_path,
        title: obj
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string),
        remote_id: obj
            .get("remote_id")
            .or_else(|| obj.get("remoteId"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        language: obj
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("vi")
            .to_string(),
        model_size: obj
            .get("modelSize")
            .or_else(|| obj.get("model_size"))
            .and_then(Value::as_str)
            .unwrap_or("tiny")
            .to_string(),
        workspace_root: Some(state.config.workspace_root.clone()),
        output_dir: Some(state.downloads_staging_dir.join("whisper")),
    };
    match state.notebooks.transcribe_and_ingest_media(wreq).await {
        Ok(out) => HttpResponse::ok(json!({ "ok": true, "outcome": out })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_source_delete(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match req_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let source_id = match req_str(
        &obj,
        &["source_id", "sourceId", "remote_id", "remoteId"],
        "source_id",
    ) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let reason = obj.get("reason").and_then(Value::as_str);
    match state.notebooks.delete_source(&notebook_id, &source_id, reason) {
        Ok(tombstone) => HttpResponse::ok(json!({
            "ok": true,
            "notebookId": notebook_id,
            "tombstone": tombstone,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_sync_tombstones(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let Some(notebook_id) = qparam(req, "notebook_id").or_else(|| qparam(req, "notebookId")) else {
        return HttpResponse::error(400, "missing_notebook_id", "Query param 'notebook_id' is required.");
    };
    match state.notebooks.list_tombstones(&notebook_id) {
        Ok(tombstones) => HttpResponse::ok(json!({
            "ok": true,
            "notebookId": notebook_id,
            "tombstones": tombstones,
        })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_sync_clear_tombstone(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match req_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let key = match req_str(&obj, &["tombstone_key", "tombstoneKey", "key"], "tombstone_key") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    match state.notebooks.clear_tombstone(&notebook_id, &key) {
        Ok(cleared) => HttpResponse::ok(json!({ "ok": true, "cleared": cleared })),
        Err(err) => map_notebook_error(err),
    }
}

fn handle_sync_reconcile(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let notebook_id = match req_str(&obj, &["notebook_id", "notebookId"], "notebook_id") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let items: Vec<RemoteSyncItem> = match obj
        .get("remoteItems")
        .or_else(|| obj.get("remote_items"))
        .cloned()
        .map(serde_json::from_value)
        .transpose()
    {
        Ok(Some(v)) => v,
        Ok(None) => Vec::new(),
        Err(e) => return HttpResponse::error(400, "invalid_remote_items", &e.to_string()),
    };
    let complete = obj
        .get("remoteSnapshotComplete")
        .or_else(|| obj.get("remote_snapshot_complete"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    match state
        .notebooks
        .reconcile_remote_sources(&notebook_id, &items, complete)
    {
        Ok(report) => HttpResponse::ok(json!({ "ok": true, "report": report })),
        Err(err) => map_notebook_error(err),
    }
}

// =========================================================================
// OmniDrive Pro v5 Handlers
// =========================================================================

async fn handle_stream_download(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let url = match req_str(&obj, &["url"], "url") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let staging = obj
        .get("stagingDir")
        .or_else(|| obj.get("staging_dir"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| state.downloads_staging_dir.clone());
    let safe_staging = match validate_safe_local_path(&staging, Some(&state.config.workspace_root)) {
        Ok(p) => p,
        Err(err) => return map_downloader_error(err),
    };
    let mut dl_req = DownloadRequest::new(url, safe_staging);
    dl_req.workspace_root = Some(state.config.workspace_root.clone());
    dl_req.filename = obj
        .get("filename")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    dl_req.streams = obj
        .get("streams")
        .and_then(Value::as_u64)
        .map(|n| n.clamp(1, 128) as usize);
    dl_req.pacing_mode = Some(PacingMode::Adaptive);

    let wait_sync = obj.get("wait").and_then(Value::as_bool).unwrap_or(false);
    if wait_sync {
        match state.downloads.download_now(dl_req).await {
            Ok(done) => HttpResponse::ok(json!({ "ok": true, "completed": done })),
            Err(err) => map_downloader_error(err),
        }
    } else {
        let (job_id, _handle) = state.downloads.spawn_download(dl_req);
        state.event_feed.publish(
            "downloads",
            "stream_job_started",
            Some(&job_id),
            json!({ "jobId": job_id }),
        );
        HttpResponse::ok(json!({ "ok": true, "accepted": true, "jobId": job_id }))
    }
}

async fn handle_media_mux(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let video_input = match req_str(&obj, &["videoInput", "video_input", "video"], "videoInput") {
        Ok(v) => PathBuf::from(v),
        Err(resp) => return resp,
    };
    let output_path = match req_str(&obj, &["outputPath", "output_path", "output"], "outputPath") {
        Ok(v) => PathBuf::from(v),
        Err(resp) => return resp,
    };
    let mux_req = MediaMuxRequest {
        video_input,
        audio_input: obj
            .get("audioInput")
            .or_else(|| obj.get("audio_input"))
            .or_else(|| obj.get("audio"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from),
        subtitle_input: obj
            .get("subtitleInput")
            .or_else(|| obj.get("subtitle_input"))
            .or_else(|| obj.get("subtitle"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from),
        subtitle_lang: obj
            .get("subtitleLang")
            .or_else(|| obj.get("subtitle_lang"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        output_path,
        clip_in_secs: obj
            .get("clipInSecs")
            .or_else(|| obj.get("clip_in_secs"))
            .or_else(|| obj.get("clipStartSec"))
            .or_else(|| obj.get("clip_start_sec"))
            .and_then(Value::as_f64),
        clip_out_secs: obj
            .get("clipOutSecs")
            .or_else(|| obj.get("clip_out_secs"))
            .or_else(|| obj.get("clipEndSec"))
            .or_else(|| obj.get("clip_end_sec"))
            .and_then(Value::as_f64),
        workspace_root: Some(state.config.workspace_root.clone()),
        verify_with_ffprobe: obj
            .get("verifyWithFfprobe")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        timeout_secs: obj.get("timeoutSecs").and_then(Value::as_u64),
    };
    match state.downloads.convert_or_clip_media(mux_req).await {
        Ok(out) => HttpResponse::ok(json!({ "ok": true, "outcome": out })),
        Err(err) => map_downloader_error(err),
    }
}

async fn handle_media_ffprobe(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let path = match req_str(&obj, &["path", "mediaPath", "target", "url"], "path") {
        Ok(v) => PathBuf::from(v),
        Err(resp) => return resp,
    };
    match state
        .downloads
        .inspect_media_ffprobe(&path, Some(&state.config.workspace_root))
        .await
    {
        Ok(report) => HttpResponse::ok(json!({ "ok": true, "report": report })),
        Err(err) => map_downloader_error(err),
    }
}

async fn handle_crawl_moodle(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let url = match req_str(&obj, &["url"], "url") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let cookie = obj.get("cookie").and_then(Value::as_str);
    let filter = obj.get("filter").and_then(Value::as_str);
    match state.downloads.crawl_moodle(&url, cookie, filter).await {
        Ok(report) => HttpResponse::ok(json!({ "ok": true, "crawl": report })),
        Err(err) => map_downloader_error(err),
    }
}

async fn handle_crawl_web(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let url = match req_str(&obj, &["url"], "url") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let max_depth = obj.get("maxDepth").and_then(Value::as_u64).unwrap_or(2) as usize;
    let max_pages = obj.get("maxPages").and_then(Value::as_u64).unwrap_or(16) as usize;
    let filter = obj.get("filter").and_then(Value::as_str);
    match state
        .downloads
        .crawl_web(&url, max_depth, max_pages, filter)
        .await
    {
        Ok(report) => HttpResponse::ok(json!({ "ok": true, "crawl": report })),
        Err(err) => map_downloader_error(err),
    }
}

async fn handle_crawl_youtube(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let url = match req_str(&obj, &["url"], "url") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    match state.downloads.inspect_youtube(&url).await {
        Ok(info) => HttpResponse::ok(json!({ "ok": true, "youtube": info })),
        Err(err) => map_downloader_error(err),
    }
}

fn handle_capture_bundle_seal(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let source_url = match req_str(&obj, &["sourceUrl", "source_url", "url"], "sourceUrl") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let bundle_id = obj
        .get("bundleId")
        .or_else(|| obj.get("bundle_id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("cap_{}", uuid_v4()));
    let mut owned_parts: Vec<(String, String, Vec<u8>)> = Vec::new();
    if let Some(arr) = obj.get("parts").and_then(Value::as_array) {
        for item in arr {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("part")
                .to_string();
            let mime = item
                .get("mediaType")
                .or_else(|| item.get("mimeType"))
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream")
                .to_string();
            let bytes = if let Some(b64) = item.get("dataBase64").and_then(Value::as_str) {
                match base64_decode(b64) {
                    Ok(b) => b,
                    Err(e) => {
                        return HttpResponse::error(400, "invalid_base64", &e.to_string())
                    }
                }
            } else {
                item.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .as_bytes()
                    .to_vec()
            };
            owned_parts.push((name, mime, bytes));
        }
    }
    let refs: Vec<(&str, &str, &[u8])> = owned_parts
        .iter()
        .map(|(n, m, b)| (n.as_str(), m.as_str(), b.as_slice()))
        .collect();
    let meta = obj.get("metadata").cloned().unwrap_or_else(|| json!({}));
    match state
        .downloads
        .seal_capture_bundle(bundle_id, &source_url, &refs, meta)
    {
        Ok(bundle) => {
            if let Ok(mut bundles) = state.captured_bundles.lock() {
                bundles.push(bundle.clone());
                if bundles.len() > 64 {
                    let drop_n = bundles.len() - 64;
                    bundles.drain(0..drop_n);
                }
            }
            HttpResponse::ok(json!({ "ok": true, "bundle": bundle }))
        }
        Err(err) => map_downloader_error(err),
    }
}

fn handle_capture_bundle_verify(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let bundle_val = obj.get("bundle").cloned().unwrap_or(Value::Object(obj));
    let bundle: CaptureBundle = match serde_json::from_value(bundle_val) {
        Ok(b) => b,
        Err(e) => return HttpResponse::error(400, "invalid_bundle", &e.to_string()),
    };
    match bundle.verify_all(state.downloads.cas()) {
        Ok(valid) => HttpResponse::ok(json!({ "ok": true, "verified": valid })),
        Err(err) => map_downloader_error(err),
    }
}

fn handle_schema_drift(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match parse_obj(req) {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let before = match req_str(&obj, &["before", "baseline"], "before") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let after = match req_str(&obj, &["after", "current"], "after") {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let threshold = obj.get("threshold").and_then(Value::as_f64);
    let report = state
        .downloads
        .compare_schema_drift(&before, &after, threshold);
    HttpResponse::ok(json!({ "ok": true, "drift": report }))
}
