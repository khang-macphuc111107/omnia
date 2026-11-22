//! Studio HTTP/SSE routes mounting `omnia-downloader` (`/api/downloads/*` and `/api/omni-drive/*`).

use crate::http::{HttpRequest, HttpResponse};
use crate::routes_legacy::StudioState;
use base64::Engine as _;
use omnia_core::SecretRedactor;
use omnia_downloader::{
    expand_batch_pattern, parse_drive_url, resolve_workspace_export, safe_output_filename,
    validate_safe_local_path, DownloadRequest, DownloaderError, DriveAuth, DriveResolver,
    DriveResourceKind, PacingMode, PrivacyShield, SecurityPolicy, WorkspaceExportFormat,
    AUTO_SOLVE_PERMITTED, DRM_SUPPORTED, EXECUTION_MODE_MANUAL_VISIBLE_BROWSER, MAX_STREAMS,
    MIN_STREAMS,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

const MAX_MEDIA_INSPECT_BYTES: usize = 4 * 1024 * 1024;
const SSE_KEEPALIVE_SECS: u64 = 15;

/// Dispatches `/api/downloads/*` and `/api/omni-drive/*` routes.
pub async fn dispatch_download_route(
    state: &Arc<StudioState>,
    req: &HttpRequest,
) -> Option<HttpResponse> {
    match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/api/downloads/probe") => Some(handle_downloads_probe(state, req).await),
        ("POST", "/api/downloads/start") => Some(handle_downloads_start(state, req).await),
        ("GET", "/api/downloads/list") => Some(handle_downloads_list(state)),
        ("GET", "/api/downloads/get") => Some(handle_downloads_get(state, req)),
        ("GET", "/api/downloads/segments") => Some(handle_downloads_segments(state, req)),
        ("POST", "/api/downloads/pause") => Some(handle_downloads_pause(state, req)),
        ("POST", "/api/downloads/cancel") => Some(handle_downloads_cancel(state, req)),
        ("GET", "/api/downloads/events") => Some(handle_downloads_events(state)),

        ("POST", "/api/omni-drive/resolve") => Some(handle_drive_resolve(req)),
        ("POST", "/api/omni-drive/plan-folder") => Some(handle_drive_plan_folder(state, req).await),
        ("POST", "/api/omni-drive/batch-expand") => Some(handle_drive_batch_expand(state, req)),
        ("POST", "/api/omni-drive/inspect-media") => {
            Some(handle_drive_inspect_media(state, req).await)
        }
        ("GET", "/api/omni-drive/providers") => Some(handle_drive_providers(state)),
        ("GET", "/api/omni-drive/handoffs") => Some(handle_drive_handoffs(state)),

        (
            _,
            "/api/downloads/probe"
            | "/api/downloads/start"
            | "/api/downloads/list"
            | "/api/downloads/get"
            | "/api/downloads/segments"
            | "/api/downloads/pause"
            | "/api/downloads/cancel"
            | "/api/downloads/events"
            | "/api/omni-drive/resolve"
            | "/api/omni-drive/plan-folder"
            | "/api/omni-drive/batch-expand"
            | "/api/omni-drive/inspect-media"
            | "/api/omni-drive/providers"
            | "/api/omni-drive/handoffs",
        ) => Some(HttpResponse::error(
            405,
            "method_not_allowed",
            "HTTP method not allowed for downloader route.",
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
        "UNC/SMB or NT object-namespace paths are blocked for download and staging operations.",
    )
}

fn redact_urls_and_secrets(raw: &str) -> String {
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
    let joined = sanitized_tokens.join(" ");
    // Strip any bare `key=...` query parameter fragments not covered by generic patterns.
    let mut out = String::with_capacity(joined.len());
    let mut rest = joined.as_str();
    while let Some(pos) = rest.find("key=") {
        let prefix_ok = pos == 0
            || matches!(
                rest.as_bytes()[pos - 1],
                b'?' | b'&' | b' ' | b';' | b'"' | b'\''
            );
        if !prefix_ok {
            out.push_str(&rest[..pos + 4]);
            rest = &rest[pos + 4..];
            continue;
        }
        out.push_str(&rest[..pos + 4]);
        out.push_str("[REDACTED]");
        let after = &rest[pos + 4..];
        let end = after
            .find(|c: char| c.is_whitespace() || matches!(c, '&' | '#' | '"' | '\'' | ')' | ',' | ';'))
            .unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    SecretRedactor::redact(&out)
}

fn sanitize_downloader_error_message(err: &DownloaderError) -> String {
    match err {
        DownloaderError::Network(req_err) => {
            let safe_target = req_err
                .url()
                .map(|u| PrivacyShield::sanitize_for_receipt(u.as_str()));
            let base = redact_urls_and_secrets(&req_err.to_string());
            match safe_target {
                Some(origin) if !base.contains(&origin) => {
                    format!("HTTP request failed ({origin}): {base}")
                }
                _ => format!("HTTP request failed: {base}"),
            }
        }
        other => redact_urls_and_secrets(&other.to_string()),
    }
}

fn map_downloader_error(err: DownloaderError) -> HttpResponse {
    let code = err.error_code();
    let status = match &err {
        DownloaderError::InvalidInput(_)
        | DownloaderError::Json(_)
        | DownloaderError::Intake(_) => 400,
        DownloaderError::SignInRequired { .. } => 401,
        DownloaderError::BlockedAcl403 { .. }
        | DownloaderError::DrmUnsupported { .. }
        | DownloaderError::ForbiddenPath { .. }
        | DownloaderError::RangePolicy(_)
        | DownloaderError::SecurityRejected(_) => 403,
        DownloaderError::JobNotFound(_) => 404,
        DownloaderError::Paused { .. } | DownloaderError::Cancelled { .. } => 409,
        DownloaderError::IntegrityMismatch { .. }
        | DownloaderError::CorruptJournal { .. }
        | DownloaderError::RangeNotSupported(_) => 422,
        DownloaderError::AuthChallengeRequired { .. } => 429,
        DownloaderError::HttpStatus { status, .. } => {
            if (400..600).contains(status) {
                *status
            } else {
                502
            }
        }
        DownloaderError::Network(_) => 502,
        DownloaderError::Io(_) | DownloaderError::Sqlite(_) => 500,
    };
    let safe_detail = sanitize_downloader_error_message(&err);
    HttpResponse::error(status, code, &safe_detail)
}

fn parse_optional_headers(obj: &serde_json::Map<String, Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(map) = obj.get("headers").and_then(Value::as_object) {
        for (k, v) in map {
            if let Some(val_str) = v.as_str() {
                out.insert(k.clone(), val_str.to_string());
            }
        }
    }
    out
}

fn parse_pacing_mode(raw: &str) -> Result<PacingMode, HttpResponse> {
    match raw.trim().to_ascii_lowercase().replace('-', "_").as_str() {
        "turbo" => Ok(PacingMode::Turbo),
        "adaptive" => Ok(PacingMode::Adaptive),
        "polite" => Ok(PacingMode::Polite),
        "linear_rate_guarded" | "linear" => Ok(PacingMode::LinearRateGuarded),
        other => Err(HttpResponse::error(
            400,
            "invalid_pacing_mode",
            &format!(
                "Unsupported pacing_mode '{other}'; expected turbo, adaptive, polite, or linear_rate_guarded."
            ),
        )),
    }
}

fn parse_export_format(raw: Option<&str>) -> Result<WorkspaceExportFormat, HttpResponse> {
    let Some(val) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(WorkspaceExportFormat::OfficeNative);
    };
    match val.to_ascii_lowercase().replace('-', "_").as_str() {
        "default" | "office_native" | "office" | "docx" | "xlsx" | "pptx" | "png" => {
            Ok(WorkspaceExportFormat::OfficeNative)
        }
        "pdf" => Ok(WorkspaceExportFormat::Pdf),
        "markdown" | "md" => Ok(WorkspaceExportFormat::Markdown),
        "plain_text" | "txt" | "text" => Ok(WorkspaceExportFormat::PlainText),
        "csv" => Ok(WorkspaceExportFormat::Csv),
        "svg" => Ok(WorkspaceExportFormat::Svg),
        other => Err(HttpResponse::error(
            400,
            "invalid_export_format",
            &format!("Unsupported export_format '{other}'."),
        )),
    }
}

async fn handle_downloads_probe(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(url) = obj
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(400, "missing_url", "Field 'url' is required.");
    };
    if is_unc_or_smb_path(url) {
        return unc_blocked_response();
    }
    let headers = parse_optional_headers(&obj);
    match state.downloads.probe_url(url, &headers).await {
        Ok(probe) => HttpResponse::ok(json!({
            "ok": true,
            "probe": probe,
        })),
        Err(err) => map_downloader_error(err),
    }
}

async fn handle_downloads_start(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(url) = obj
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
    else {
        return HttpResponse::error(400, "missing_url", "Field 'url' is required.");
    };
    if is_unc_or_smb_path(&url) {
        return unc_blocked_response();
    }

    let staging_dir = if let Some(raw_dir) = obj
        .get("staging_dir")
        .or_else(|| obj.get("stagingDir"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if is_unc_or_smb_path(raw_dir) {
            return unc_blocked_response();
        }
        PathBuf::from(raw_dir)
    } else {
        state.downloads_staging_dir.clone()
    };

    // Enforce external staging containment outside `workspace_root` (DOD-06) synchronously.
    let safe_staging = match validate_safe_local_path(&staging_dir, Some(&state.config.workspace_root))
    {
        Ok(p) => p,
        Err(err) => return map_downloader_error(err),
    };

    // Enforce strict SSRF/loopback/credentials policy synchronously before spawning.
    if let Err(err) = SecurityPolicy::strict().validate_url(&url) {
        return map_downloader_error(err);
    }

    let filename = match obj
        .get("filename")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(raw_name) => {
            if is_unc_or_smb_path(raw_name) {
                return unc_blocked_response();
            }
            match safe_output_filename(raw_name) {
                Ok(clean) => Some(clean),
                Err(err) => return map_downloader_error(err),
            }
        }
        None => None,
    };

    let streams = match obj.get("streams").and_then(Value::as_u64) {
        Some(n) => {
            let s = usize::try_from(n).unwrap_or(0);
            if !(MIN_STREAMS..=MAX_STREAMS).contains(&s) {
                return HttpResponse::error(
                    400,
                    "invalid_streams",
                    &format!("Field 'streams' must be between {MIN_STREAMS} and {MAX_STREAMS}."),
                );
            }
            Some(s)
        }
        None => None,
    };

    let pacing_mode = match obj
        .get("pacing_mode")
        .or_else(|| obj.get("pacingMode"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    {
        Some(raw_mode) => match parse_pacing_mode(raw_mode) {
            Ok(mode) => Some(mode),
            Err(resp) => return resp,
        },
        None => None,
    };

    let mut dl_req = DownloadRequest::new(url, safe_staging.clone());
    dl_req.workspace_root = Some(state.config.workspace_root.clone());
    dl_req.filename = filename;
    dl_req.streams = streams;
    dl_req.min_split_bytes = obj
        .get("min_split_bytes")
        .or_else(|| obj.get("minSplitBytes"))
        .and_then(Value::as_u64);
    dl_req.pacing_mode = pacing_mode;
    dl_req.speed_limit_bps = obj
        .get("speed_limit_bps")
        .or_else(|| obj.get("speedLimitBps"))
        .and_then(Value::as_u64);
    dl_req.headers = parse_optional_headers(&obj);
    dl_req.expected_sha256 = obj
        .get("expected_sha256")
        .or_else(|| obj.get("expectedSha256"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    dl_req.expected_crc32c_b64 = obj
        .get("expected_crc32c_b64")
        .or_else(|| obj.get("expectedCrc32cB64"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    dl_req.resume = obj.get("resume").and_then(Value::as_bool).unwrap_or(true);

    let (job_id, _handle) = state.downloads.spawn_download(dl_req);
    HttpResponse::ok(json!({
        "ok": true,
        "job_id": job_id,
        "status": "queued",
        "staging_dir": safe_staging.display().to_string(),
        "drm_supported": DRM_SUPPORTED,
    }))
}

fn handle_downloads_list(state: &Arc<StudioState>) -> HttpResponse {
    match state.downloads.list_jobs() {
        Ok(jobs) => HttpResponse::ok(json!({
            "ok": true,
            "count": jobs.len(),
            "jobs": jobs,
            "staging_dir": state.downloads_staging_dir.display().to_string(),
            "drm_supported": DRM_SUPPORTED,
        })),
        Err(err) => map_downloader_error(err),
    }
}

fn handle_downloads_get(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let Some(id) = req
        .query_param("id")
        .or_else(|| req.query_param("job_id"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(400, "missing_job_id", "Query parameter 'id' is required.");
    };
    match state.downloads.get_job(&id) {
        Ok(Some(job)) => HttpResponse::ok(json!({
            "ok": true,
            "job": job,
        })),
        Ok(None) => HttpResponse::error(404, "JOB_NOT_FOUND", &format!("Download job '{id}' not found.")),
        Err(err) => map_downloader_error(err),
    }
}

fn handle_downloads_segments(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let Some(id) = req
        .query_param("id")
        .or_else(|| req.query_param("job_id"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(400, "missing_job_id", "Query parameter 'id' is required.");
    };
    match state.downloads.get_segments(&id) {
        Ok(segments) => HttpResponse::ok(json!({
            "ok": true,
            "job_id": id,
            "count": segments.len(),
            "segments": segments,
        })),
        Err(err) => map_downloader_error(err),
    }
}

fn handle_downloads_pause(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(job_id) = obj
        .get("job_id")
        .or_else(|| obj.get("jobId"))
        .or_else(|| obj.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(400, "missing_job_id", "Field 'job_id' is required.");
    };
    match state.downloads.pause_job(job_id) {
        Ok(()) => HttpResponse::ok(json!({
            "ok": true,
            "job_id": job_id,
            "paused": true,
        })),
        Err(err) => map_downloader_error(err),
    }
}

fn handle_downloads_cancel(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(job_id) = obj
        .get("job_id")
        .or_else(|| obj.get("jobId"))
        .or_else(|| obj.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(400, "missing_job_id", "Field 'job_id' is required.");
    };
    match state.downloads.cancel_job(job_id) {
        Ok(()) => HttpResponse::ok(json!({
            "ok": true,
            "job_id": job_id,
            "cancelled": true,
        })),
        Err(err) => map_downloader_error(err),
    }
}

fn handle_downloads_events(state: &Arc<StudioState>) -> HttpResponse {
    let (tx, rx) = mpsc::channel::<Vec<u8>>(64);
    let initial_jobs = state.downloads.list_jobs().unwrap_or_default();
    let mut bcast = state.downloads.subscribe_events();

    tokio::spawn(async move {
        let snapshot_payload = json!({ "jobs": initial_jobs });
        let snapshot_frame = format!("event: snapshot\ndata: {snapshot_payload}\n\n").into_bytes();
        if tx.send(snapshot_frame).await.is_err() {
            return;
        }
        loop {
            tokio::select! {
                _ = tx.closed() => break,
                recv = bcast.recv() => {
                    match recv {
                        Ok(event) => {
                            if let Ok(serialized) = serde_json::to_string(&event) {
                                let frame =
                                    format!("event: progress\ndata: {serialized}\n\n").into_bytes();
                                if tx.send(frame).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    });

    HttpResponse::sse_channel(rx, Duration::from_secs(SSE_KEEPALIVE_SECS))
}

fn handle_drive_resolve(req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(url) = obj
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(400, "missing_url", "Field 'url' is required.");
    };
    if is_unc_or_smb_path(url) {
        return unc_blocked_response();
    }
    let export_fmt = match parse_export_format(
        obj.get("export_format")
            .or_else(|| obj.get("exportFormat"))
            .and_then(Value::as_str),
    ) {
        Ok(fmt) => fmt,
        Err(resp) => return resp,
    };

    match parse_drive_url(url) {
        Ok(resource) => {
            let export_target = match resource.kind {
                DriveResourceKind::GoogleDoc => {
                    resolve_workspace_export("application/vnd.google-apps.document", export_fmt)
                }
                DriveResourceKind::GoogleSheet => {
                    resolve_workspace_export("application/vnd.google-apps.spreadsheet", export_fmt)
                }
                DriveResourceKind::GoogleSlides => {
                    resolve_workspace_export("application/vnd.google-apps.presentation", export_fmt)
                }
                DriveResourceKind::GoogleDrawing => {
                    resolve_workspace_export("application/vnd.google-apps.drawing", export_fmt)
                }
                _ => None,
            };
            HttpResponse::ok(json!({
                "ok": true,
                "resource": resource,
                "export_target": export_target,
            }))
        }
        Err(err) => map_downloader_error(err),
    }
}

async fn handle_drive_plan_folder(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };

    let (folder_id, parsed_resource_key) = if let Some(fid) = obj
        .get("folder_id")
        .or_else(|| obj.get("folderId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        (fid.to_string(), None)
    } else if let Some(raw_url) = obj
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if is_unc_or_smb_path(raw_url) {
            return unc_blocked_response();
        }
        match parse_drive_url(raw_url) {
            Ok(parsed) => (parsed.file_id, parsed.resource_key),
            Err(err) => return map_downloader_error(err),
        }
    } else {
        return HttpResponse::error(
            400,
            "missing_folder_id",
            "Field 'folder_id' or 'url' is required.",
        );
    };

    let resource_key = obj
        .get("resource_key")
        .or_else(|| obj.get("resourceKey"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .or(parsed_resource_key);

    let staging_dir = if let Some(raw_dir) = obj
        .get("staging_dir")
        .or_else(|| obj.get("stagingDir"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if is_unc_or_smb_path(raw_dir) {
            return unc_blocked_response();
        }
        PathBuf::from(raw_dir)
    } else {
        state.downloads_staging_dir.clone()
    };

    let safe_staging = match validate_safe_local_path(&staging_dir, Some(&state.config.workspace_root))
    {
        Ok(p) => p,
        Err(err) => return map_downloader_error(err),
    };

    let export_fmt = match parse_export_format(
        obj.get("export_format")
            .or_else(|| obj.get("exportFormat"))
            .and_then(Value::as_str),
    ) {
        Ok(fmt) => fmt,
        Err(resp) => return resp,
    };

    let max_depth = obj
        .get("max_depth")
        .or_else(|| obj.get("maxDepth"))
        .and_then(Value::as_u64)
        .map(|n| usize::try_from(n).unwrap_or(4).clamp(1, 16))
        .unwrap_or(4);

    let auth = if let Some(token) = obj
        .get("oauth_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        DriveAuth::OAuthBearer(token.to_string())
    } else if let Some(key) = obj
        .get("api_key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        DriveAuth::ApiKey(key.to_string())
    } else {
        DriveAuth::None
    };

    let resolver = match DriveResolver::new(auth) {
        Ok(r) => r,
        Err(err) => return map_downloader_error(err),
    };

    match resolver
        .plan_folder_batch(
            &folder_id,
            resource_key.as_deref(),
            safe_staging,
            Some(&state.config.workspace_root),
            export_fmt,
            max_depth,
        )
        .await
    {
        Ok(plan) => HttpResponse::ok(json!({
            "ok": true,
            "plan": plan,
        })),
        Err(err) => map_downloader_error(err),
    }
}

fn handle_drive_batch_expand(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(pattern) = obj
        .get("pattern")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(400, "missing_pattern", "Field 'pattern' is required.");
    };
    if is_unc_or_smb_path(pattern) {
        return unc_blocked_response();
    }

    let urls = match expand_batch_pattern(pattern) {
        Ok(urls) => urls,
        Err(err) => return map_downloader_error(err),
    };

    let staging_opt = obj
        .get("staging_dir")
        .or_else(|| obj.get("stagingDir"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let plan = if let Some(raw_dir) = staging_opt {
        if is_unc_or_smb_path(raw_dir) {
            return unc_blocked_response();
        }
        let categorize = obj
            .get("categorize_subfolders")
            .or_else(|| obj.get("categorizeSubfolders"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        match state.downloads.batch_planner().plan_from_pattern(
            pattern,
            std::path::Path::new(raw_dir),
            Some(&state.config.workspace_root),
            categorize,
        ) {
            Ok(p) => Some(p),
            Err(err) => return map_downloader_error(err),
        }
    } else {
        None
    };

    HttpResponse::ok(json!({
        "ok": true,
        "count": urls.len(),
        "urls": urls,
        "plan": plan,
    }))
}

async fn handle_drive_inspect_media(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };

    if let Some(b64) = obj
        .get("bytes_base64")
        .or_else(|| obj.get("bytesBase64"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let decoded = match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(bytes) => bytes,
            Err(err) => {
                return HttpResponse::error(
                    400,
                    "invalid_base64",
                    &format!("Field 'bytes_base64' is not valid base64: {err}"),
                );
            }
        };
        if decoded.len() > MAX_MEDIA_INSPECT_BYTES {
            return HttpResponse::error(
                413,
                "payload_too_large",
                "Media inspection buffer exceeds 4 MiB limit.",
            );
        }
        let report = state.downloads.inspect_media_bytes(&decoded);
        return HttpResponse::ok(json!({
            "ok": true,
            "drm_supported": DRM_SUPPORTED,
            "report": report,
        }));
    }

    if let Some(raw_path) = obj
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if is_unc_or_smb_path(raw_path) {
            return unc_blocked_response();
        }
        let safe_path = match validate_safe_local_path(
            std::path::Path::new(raw_path),
            Some(&state.config.workspace_root),
        ) {
            Ok(p) => p,
            Err(err) => return map_downloader_error(err),
        };
        let dl = Arc::clone(&state.downloads);
        let result = tokio::task::spawn_blocking(move || dl.inspect_media_file(&safe_path)).await;
        return match result {
            Ok(Ok(report)) => HttpResponse::ok(json!({
                "ok": true,
                "drm_supported": DRM_SUPPORTED,
                "report": report,
            })),
            Ok(Err(err)) => map_downloader_error(err),
            Err(err) => HttpResponse::error(500, "inspect_task_failed", &err.to_string()),
        };
    }

    HttpResponse::error(
        400,
        "missing_media_input",
        "Either 'bytes_base64' or external 'path' is required.",
    )
}

fn handle_drive_providers(state: &Arc<StudioState>) -> HttpResponse {
    let providers = state.downloads.providers().list();
    let categories = state.downloads.providers().categories();
    HttpResponse::ok(json!({
        "ok": true,
        "count": providers.len(),
        "providers": providers,
        "categories": categories,
    }))
}

fn handle_drive_handoffs(state: &Arc<StudioState>) -> HttpResponse {
    let tickets = state.downloads.handoffs().list_tickets();
    HttpResponse::ok(json!({
        "ok": true,
        "execution_mode": EXECUTION_MODE_MANUAL_VISIBLE_BROWSER,
        "auto_solve_permitted": AUTO_SOLVE_PERMITTED,
        "count": tickets.len(),
        "tickets": tickets,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_urls_and_secrets_strips_drive_api_key_and_signed_tokens() {
        let dummy_key = ["AIza", "DummyFixtureKey", "1234567890"].join("");
        let raw = format!(
            "error sending request for url (https://www.googleapis.com/drive/v3/files/abc123456789?alt=media&key={dummy_key}&sig=topsecret)"
        );
        let cleaned = redact_urls_and_secrets(&raw);
        assert!(
            !cleaned.contains(&dummy_key),
            "API key leaked in error text: {cleaned}"
        );
        assert!(
            !cleaned.contains("topsecret"),
            "signed token leaked in error text: {cleaned}"
        );
        assert!(is_unc_or_smb_path(r"\??\C:\Windows\win.ini"));
        assert!(is_unc_or_smb_path("/??/C:/Windows/win.ini"));
    }
}
