//! Studio HTTP/SSE routes mounting `omnia-downloader` (`/api/downloads/*` and `/api/omni-drive/*`).

use crate::http::{HttpRequest, HttpResponse};
use crate::routes_legacy::StudioState;
use base64::Engine as _;
use chrono::Utc;
use omnia_core::SecretRedactor;
use omnia_downloader::{
    classify_captured_media, expand_batch_pattern, parse_drive_url, parse_ef2,
    resolve_series_subfolder, resolve_workspace_export, safe_output_filename, serialize_ef2,
    validate_safe_local_path, verify_file_integrity_with_md5, BatchItem, BlobAssembler,
    DownloadCategory, DownloadRequest, DownloaderError, DriveAuth, DriveResolver,
    DriveResourceKind, Ef2Entry, HandoffReason, OmnfJournal, PacingMode, PartMetaV2,
    PrivacyShield, SameSiteContext, ScheduleWindow, ScopedCookieJar, SecurityPolicy, SiteRule,
    WorkspaceExportFormat, AUTO_SOLVE_PERMITTED, DEFAULT_MIN_SPLIT_BYTES, DRM_SUPPORTED,
    EXECUTION_MODE_MANUAL_VISIBLE_BROWSER, MAX_STREAMS, MIN_STREAMS, OMNF_MAGIC,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use std::time::Duration;
use tokio::sync::{mpsc, Notify};
use url::Url;

const MAX_MEDIA_INSPECT_BYTES: usize = 4 * 1024 * 1024;
const SSE_KEEPALIVE_SECS: u64 = 15;

type SchedulerPumpEntry = (Weak<StudioState>, Arc<Notify>);
type BlobSessionStore = Arc<StdMutex<HashMap<String, BlobAssembler>>>;
type BlobSessionEntry = (Weak<StudioState>, BlobSessionStore);

fn scheduler_pump_registry() -> &'static StdMutex<Vec<SchedulerPumpEntry>> {
    static REG: OnceLock<StdMutex<Vec<SchedulerPumpEntry>>> = OnceLock::new();
    REG.get_or_init(|| StdMutex::new(Vec::new()))
}

fn blob_session_registry() -> &'static StdMutex<Vec<BlobSessionEntry>> {
    static REG: OnceLock<StdMutex<Vec<BlobSessionEntry>>> = OnceLock::new();
    REG.get_or_init(|| StdMutex::new(Vec::new()))
}

fn blob_sessions_for_state(state: &Arc<StudioState>) -> BlobSessionStore {
    let target_weak = Arc::downgrade(state);
    let mut reg = blob_session_registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    reg.retain(|(ws, _)| ws.strong_count() > 0);
    if let Some((_, store)) = reg.iter().find(|(ws, _)| Weak::ptr_eq(ws, &target_weak)) {
        return Arc::clone(store);
    }
    let store: BlobSessionStore = Arc::new(StdMutex::new(HashMap::new()));
    reg.push((target_weak, Arc::clone(&store)));
    store
}

/// Applies matching [`SitePolicyRegistry`] stream caps and default pacing to `dl_req`.
fn apply_site_policy_to_request(state: &StudioState, dl_req: &mut DownloadRequest) {
    let Ok(parsed) = Url::parse(&dl_req.url) else {
        return;
    };
    let Some(host) = parsed.host_str() else {
        return;
    };
    let Ok(reg) = state.download_site_policies.lock() else {
        return;
    };
    if let Some(rule) = reg.resolve_for_host(host) {
        let cap = rule.max_connections_per_host.clamp(MIN_STREAMS, MAX_STREAMS);
        dl_req.streams = Some(
            dl_req
                .streams
                .map_or(cap, |s| s.clamp(MIN_STREAMS, MAX_STREAMS).min(cap)),
        );
        if dl_req.pacing_mode.is_none() {
            if let Some(ref raw_pacing) = rule.default_pacing {
                if let Ok(mode) = parse_pacing_mode(raw_pacing) {
                    dl_req.pacing_mode = Some(mode);
                }
            }
        }
    }
}

/// Hydrates WAL SQLite scheduler/policy settings once and ensures a live background Tokio pump.
fn ensure_scheduler_pump_and_hydrate(state: &Arc<StudioState>) -> Arc<Notify> {
    let target_weak = Arc::downgrade(state);
    let mut reg = scheduler_pump_registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    reg.retain(|(ws, _)| ws.strong_count() > 0);
    if let Some((_, notify)) = reg.iter().find(|(ws, _)| Weak::ptr_eq(ws, &target_weak)) {
        return Arc::clone(notify);
    }

    if let Ok(Some(persisted_cfg)) = state.downloads.store().load_scheduler_config() {
        if let Ok(mut guard) = state.download_scheduler_config.lock() {
            *guard = persisted_cfg.clone();
        }
        state.downloads.scheduler().lock().set_config(persisted_cfg);
    }
    if let Ok(persisted_reg) = state.downloads.store().load_site_policies() {
        if !persisted_reg.list_rules().is_empty() {
            if let Ok(mut guard) = state.download_site_policies.lock() {
                *guard = persisted_reg;
            }
        }
    }

    let notify = Arc::new(Notify::new());
    reg.push((target_weak.clone(), Arc::clone(&notify)));
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let task_notify = Arc::clone(&notify);
        handle.spawn(async move {
            run_scheduler_pump_loop(target_weak, task_notify).await;
        });
    }
    notify
}

async fn run_scheduler_pump_loop(weak_state: Weak<StudioState>, notify: Arc<Notify>) {
    loop {
        tokio::select! {
            _ = notify.notified() => {}
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
        let Some(state) = weak_state.upgrade() else {
            break;
        };
        loop {
            let next_item = {
                let mut sched = state.downloads.scheduler().lock();
                sched.next_dispatch_at(Utc::now())
            };
            let Some(item) = next_item else {
                break;
            };
            let mut dl_req = DownloadRequest::new(item.url.clone(), item.destination_dir.clone());
            dl_req.workspace_root = Some(state.config.workspace_root.clone());
            dl_req.filename = item.filename.clone();
            dl_req.expected_sha256 = item.expected_sha256.clone();
            apply_site_policy_to_request(&state, &mut dl_req);
            let (_job_id, handle) = state.downloads.spawn_download(dl_req);
            let weak_for_slot = Arc::downgrade(&state);
            let notify_for_slot = Arc::clone(&notify);
            tokio::spawn(async move {
                let _ = handle.await;
                if let Some(alive) = weak_for_slot.upgrade() {
                    alive.downloads.scheduler().lock().mark_finished();
                    notify_for_slot.notify_one();
                }
            });
        }
    }
}

/// Returns `true` if `path` is owned by the downloader / OmniDrive v3 route table.
#[must_use]
pub fn is_known_download_route(path: &str) -> bool {
    matches!(
        path,
        "/api/downloads/probe"
            | "/api/downloads/start"
            | "/api/downloads/list"
            | "/api/downloads/get"
            | "/api/downloads/segments"
            | "/api/downloads/pause"
            | "/api/downloads/cancel"
            | "/api/downloads/events"
            | "/api/downloads/speed-limit"
            | "/api/omni-drive/probe"
            | "/api/omni-drive/resolve"
            | "/api/omni-drive/plan-folder"
            | "/api/omni-drive/batch-expand"
            | "/api/omni-drive/batch/plan"
            | "/api/omni-drive/batch/enqueue"
            | "/api/omni-drive/batch/export-ef2"
            | "/api/omni-drive/batch/import-ef2"
            | "/api/omni-drive/scheduler"
            | "/api/omni-drive/integrity/verify"
            | "/api/omni-drive/journal/inspect"
            | "/api/omni-drive/inspect-media"
            | "/api/omni-drive/media/inspect"
            | "/api/omni-drive/providers"
            | "/api/omni-drive/handoffs"
            | "/api/omni-drive/handoffs/create"
            | "/api/omni-drive/handoffs/open"
            | "/api/omni-drive/handoffs/resolve"
            | "/api/omni-drive/handoffs/cancel"
            | "/api/omni-drive/cookies/evaluate"
            | "/api/omni-drive/recommend"
            | "/api/omni-drive/aimd"
            | "/api/omni-drive/bundles"
            | "/api/omni-drive/detect"
            | "/api/omni-drive/blob/chunk"
    )
}

/// Dispatches `/api/downloads/*` and `/api/omni-drive/*` routes.
pub async fn dispatch_download_route(
    state: &Arc<StudioState>,
    req: &HttpRequest,
) -> Option<HttpResponse> {
    if is_known_download_route(&req.path) {
        let _ = ensure_scheduler_pump_and_hydrate(state);
    }
    match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/api/downloads/probe") | ("POST", "/api/omni-drive/probe") => {
            Some(handle_downloads_probe(state, req).await)
        }
        ("POST", "/api/downloads/start") => Some(handle_downloads_start(state, req).await),
        ("GET", "/api/downloads/list") => Some(handle_downloads_list(state)),
        ("GET", "/api/downloads/get") => Some(handle_downloads_get(state, req)),
        ("GET", "/api/downloads/segments") => Some(handle_downloads_segments(state, req)),
        ("POST", "/api/downloads/pause") => Some(handle_downloads_pause(state, req)),
        ("POST", "/api/downloads/cancel") => Some(handle_downloads_cancel(state, req)),
        ("GET", "/api/downloads/events") => Some(handle_downloads_events(state)),
        ("POST", "/api/downloads/speed-limit") => Some(handle_downloads_speed_limit(state, req)),

        ("POST", "/api/omni-drive/resolve") => Some(handle_drive_resolve(req)),
        ("POST", "/api/omni-drive/plan-folder") => Some(handle_drive_plan_folder(state, req).await),
        ("POST", "/api/omni-drive/batch-expand") | ("POST", "/api/omni-drive/batch/plan") => {
            Some(handle_drive_batch_expand(state, req))
        }
        ("POST", "/api/omni-drive/batch/enqueue") => Some(handle_drive_batch_enqueue(state, req)),
        ("POST", "/api/omni-drive/batch/export-ef2") => Some(handle_drive_export_ef2(req)),
        ("POST", "/api/omni-drive/batch/import-ef2") => Some(handle_drive_import_ef2(req)),
        ("GET", "/api/omni-drive/scheduler") => Some(handle_drive_scheduler_get(state)),
        ("POST", "/api/omni-drive/scheduler") => Some(handle_drive_scheduler_post(state, req)),
        ("POST", "/api/omni-drive/integrity/verify") => {
            Some(handle_drive_integrity_verify(req).await)
        }
        ("POST", "/api/omni-drive/journal/inspect") => {
            Some(handle_drive_journal_inspect(req).await)
        }
        ("POST", "/api/omni-drive/inspect-media") | ("POST", "/api/omni-drive/media/inspect") => {
            Some(handle_drive_inspect_media(state, req).await)
        }
        ("GET", "/api/omni-drive/providers") => Some(handle_drive_providers(state, req)),
        ("GET", "/api/omni-drive/handoffs") => Some(handle_drive_handoffs(state)),
        ("POST", "/api/omni-drive/handoffs/create") => {
            Some(handle_drive_handoff_create(state, req))
        }
        ("POST", "/api/omni-drive/handoffs/open") => {
            Some(handle_drive_handoff_transition(state, req, "open"))
        }
        ("POST", "/api/omni-drive/handoffs/resolve") => {
            Some(handle_drive_handoff_transition(state, req, "resolve"))
        }
        ("POST", "/api/omni-drive/handoffs/cancel") => {
            Some(handle_drive_handoff_transition(state, req, "cancel"))
        }
        ("POST", "/api/omni-drive/cookies/evaluate") => Some(handle_drive_cookies_evaluate(req)),
        ("POST", "/api/omni-drive/recommend") => Some(handle_drive_recommend(state, req)),
        ("GET", "/api/omni-drive/aimd") => Some(handle_drive_aimd(state)),
        ("GET", "/api/omni-drive/bundles") => Some(handle_drive_bundles_list(state)),
        ("POST", "/api/omni-drive/detect") => Some(handle_drive_detect(req)),
        ("POST", "/api/omni-drive/blob/chunk") => Some(handle_drive_blob_chunk(state, req)),

        (_, path) if is_known_download_route(path) => Some(HttpResponse::error(
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

pub(crate) fn map_downloader_error(err: DownloaderError) -> HttpResponse {
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
    dl_req.expected_md5_hex = obj
        .get("expected_md5_hex")
        .or_else(|| obj.get("expectedMd5Hex"))
        .or_else(|| obj.get("expected_md5"))
        .or_else(|| obj.get("expectedMd5"))
        .or_else(|| obj.get("expected_md5_b64"))
        .or_else(|| obj.get("expectedMd5B64"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    dl_req.clip_start_sec = obj
        .get("clip_start_sec")
        .or_else(|| obj.get("clipStartSec"))
        .and_then(Value::as_f64);
    dl_req.clip_end_sec = obj
        .get("clip_end_sec")
        .or_else(|| obj.get("clipEndSec"))
        .and_then(Value::as_f64);
    if let (Some(cs), Some(ce)) = (dl_req.clip_start_sec, dl_req.clip_end_sec) {
        if !cs.is_finite() || !ce.is_finite() || cs < 0.0 || ce <= cs {
            return HttpResponse::error(
                400,
                "invalid_clip_range",
                "Field 'clipStartSec' must be >= 0 and strictly less than 'clipEndSec'.",
            );
        }
    }
    dl_req.export_format = obj
        .get("export_format")
        .or_else(|| obj.get("exportFormat"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    dl_req.resume = obj.get("resume").and_then(Value::as_bool).unwrap_or(true);

    let _ = ensure_scheduler_pump_and_hydrate(state);
    apply_site_policy_to_request(state, &mut dl_req);
    let effective_streams = dl_req.streams;
    let effective_pacing = dl_req.pacing_mode.map(|m| m.as_str());

    let (job_id, _handle) = state.downloads.spawn_download(dl_req);
    HttpResponse::ok(json!({
        "ok": true,
        "job_id": job_id,
        "status": "queued",
        "staging_dir": safe_staging.display().to_string(),
        "effective_streams": effective_streams,
        "effective_pacing": effective_pacing,
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

fn extract_urls_from_mixed_text(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = raw.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let rem = &raw[i..];
        if rem.starts_with("https://") || rem.starts_with("http://") {
            let mut end = 0usize;
            for ch in rem.chars() {
                if ch.is_whitespace()
                    || matches!(ch, '"' | '\'' | '<' | '>' | '(' | ')' | '{' | '}' | '`')
                {
                    break;
                }
                end += ch.len_utf8();
            }
            let candidate = rem[..end].trim_end_matches([',', ';', '.']);
            if !candidate.is_empty() {
                out.push(candidate.to_string());
            }
            i += end.max(1);
        } else {
            let step = rem.chars().next().map_or(1, char::len_utf8);
            i += step;
        }
    }
    out
}

fn decode_hex_bytes(raw: &str) -> Result<Vec<u8>, String> {
    let clean: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ':' && *c != '-')
        .collect();
    let clean = clean
        .strip_prefix("0x")
        .or_else(|| clean.strip_prefix("0X"))
        .unwrap_or(&clean);
    if clean.is_empty() || !clean.len().is_multiple_of(2) {
        return Err("Hex payload must contain a non-empty even number of hex digits.".to_string());
    }
    let mut out = Vec::with_capacity(clean.len() / 2);
    for pair in clean.as_bytes().as_chunks::<2>().0 {
        let s = std::str::from_utf8(pair).map_err(|_| "Invalid ASCII in hex string.")?;
        let b = u8::from_str_radix(s, 16)
            .map_err(|_| format!("Invalid hex byte '{s}'."))?;
        out.push(b);
    }
    Ok(out)
}

fn handle_drive_batch_expand(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };

    // Support single `pattern` OR multi-line mixed Markdown/HTML/plain `input`/`text` OR `urls` array.
    let single_pattern = obj
        .get("pattern")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut raw_candidates: Vec<String> = Vec::new();
    if let Some(pat) = single_pattern {
        if is_unc_or_smb_path(pat) {
            return unc_blocked_response();
        }
        match expand_batch_pattern(pat) {
            Ok(urls) => raw_candidates.extend(urls),
            Err(err) => return map_downloader_error(err),
        }
    } else if let Some(arr) = obj.get("urls").and_then(Value::as_array) {
        for v in arr {
            if let Some(s) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                if is_unc_or_smb_path(s) {
                    return unc_blocked_response();
                }
                match expand_batch_pattern(s) {
                    Ok(exp) => raw_candidates.extend(exp),
                    Err(_) => raw_candidates.push(s.to_string()),
                }
            }
        }
    } else if let Some(text) = obj
        .get("input")
        .or_else(|| obj.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if is_unc_or_smb_path(text) {
            return unc_blocked_response();
        }
        let extracted = extract_urls_from_mixed_text(text);
        for cand in extracted {
            match expand_batch_pattern(&cand) {
                Ok(exp) => raw_candidates.extend(exp),
                Err(_) => raw_candidates.push(cand),
            }
        }
    } else {
        return HttpResponse::error(
            400,
            "missing_pattern",
            "Field 'pattern', 'input', 'text', or 'urls' is required.",
        );
    }

    let extracted_count = raw_candidates.len();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut urls: Vec<String> = Vec::new();
    let mut items: Vec<Value> = Vec::new();
    let mut provider_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut category_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut trackers_stripped = 0usize;

    for raw in raw_candidates {
        let sanitized = PrivacyShield::sanitize_live_url(&raw);
        if sanitized != raw {
            trackers_stripped += 1;
        }
        if !seen.insert(sanitized.clone()) {
            continue;
        }
        let prov = state.downloads.providers().resolve_url(&sanitized);
        let filename = sanitized
            .split(['?', '#'])
            .next()
            .unwrap_or(&sanitized)
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .and_then(|raw_fn| safe_output_filename(raw_fn).ok());
        let category = filename
            .as_deref()
            .map_or(DownloadCategory::General, DownloadCategory::classify_filename);
        let series_subfolder = filename.as_deref().and_then(resolve_series_subfolder);
        *provider_counts.entry(prov.id.clone()).or_insert(0) += 1;
        *category_counts
            .entry(category.subfolder().to_string())
            .or_insert(0) += 1;
        items.push(json!({
            "url": sanitized,
            "sanitizedReceiptUrl": PrivacyShield::sanitize_for_receipt(&sanitized),
            "filename": filename,
            "providerId": prov.id,
            "providerName": prov.name,
            "category": category.subfolder(),
            "pacingMode": prov.pacing_mode.as_str(),
            "recommendedStreams": prov.default_streams,
            "seriesSubfolder": series_subfolder,
            "drmSupported": DRM_SUPPORTED,
        }));
        urls.push(sanitized);
    }

    let staging_opt = obj
        .get("staging_dir")
        .or_else(|| obj.get("stagingDir"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let plan = if let (Some(pat), Some(raw_dir)) = (single_pattern, staging_opt) {
        if is_unc_or_smb_path(raw_dir) {
            return unc_blocked_response();
        }
        let categorize = obj
            .get("categorize_subfolders")
            .or_else(|| obj.get("categorizeSubfolders"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        match state.downloads.batch_planner().plan_from_pattern(
            pat,
            Path::new(raw_dir),
            Some(&state.config.workspace_root),
            categorize,
        ) {
            Ok(p) => Some(p),
            Err(err) => return map_downloader_error(err),
        }
    } else {
        None
    };

    let deduped_removed = extracted_count.saturating_sub(urls.len());
    HttpResponse::ok(json!({
        "ok": true,
        "count": urls.len(),
        "extracted": extracted_count,
        "unique": urls.len(),
        "deduped": deduped_removed,
        "trackersStripped": trackers_stripped,
        "providerBreakdown": provider_counts,
        "categoryBreakdown": category_counts,
        "urls": urls,
        "items": items,
        "plan": plan,
        "drm_supported": DRM_SUPPORTED,
        "drmSupported": DRM_SUPPORTED,
    }))
}

fn handle_drive_batch_enqueue(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let staging_dir = if let Some(raw_dir) = obj
        .get("stagingDir")
        .or_else(|| obj.get("staging_dir"))
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
    let safe_staging =
        match validate_safe_local_path(&staging_dir, Some(&state.config.workspace_root)) {
            Ok(p) => p,
            Err(err) => return map_downloader_error(err),
        };
    let categorize = obj
        .get("categorizeSubfolders")
        .or_else(|| obj.get("categorize_subfolders"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let auto_group_series = obj
        .get("autoGroupSeries")
        .or_else(|| obj.get("auto_group_series"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut raw_urls: Vec<(String, Option<String>)> = Vec::new();
    if let Some(arr) = obj.get("urls").and_then(Value::as_array) {
        for v in arr {
            if let Some(s) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                raw_urls.push((s.to_string(), None));
            }
        }
    }
    if let Some(arr) = obj.get("items").and_then(Value::as_array) {
        for v in arr {
            if let Some(u) = v
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let fname = v
                    .get("filename")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string);
                raw_urls.push((u.to_string(), fname));
            }
        }
    }
    if raw_urls.is_empty() {
        return HttpResponse::error(
            400,
            "missing_batch_items",
            "Field 'urls' or 'items' must contain at least one URL.",
        );
    }

    let policy = SecurityPolicy::strict();
    let mut enqueued = Vec::new();
    let mut sched = state.downloads.scheduler().lock();
    for (raw_url, explicit_fn) in raw_urls {
        if is_unc_or_smb_path(&raw_url) {
            return unc_blocked_response();
        }
        let clean_url = PrivacyShield::sanitize_live_url(&raw_url);
        if let Err(err) = policy.validate_url(&clean_url) {
            return map_downloader_error(err);
        }
        let fname = match explicit_fn {
            Some(f) => match safe_output_filename(&f) {
                Ok(c) => Some(c),
                Err(err) => return map_downloader_error(err),
            },
            None => clean_url
                .split(['?', '#'])
                .next()
                .unwrap_or(&clean_url)
                .rsplit('/')
                .next()
                .filter(|s| !s.is_empty())
                .and_then(|f| safe_output_filename(f).ok()),
        };
        let mut dest = if categorize {
            let cat = fname
                .as_deref()
                .map_or(DownloadCategory::General, DownloadCategory::classify_filename);
            safe_staging.join(cat.subfolder())
        } else {
            safe_staging.clone()
        };
        if auto_group_series {
            if let Some(series_dir) = fname.as_deref().and_then(resolve_series_subfolder) {
                dest = dest.join(series_dir);
            }
        }
        let item = BatchItem {
            url: clean_url.clone(),
            filename: fname.clone(),
            destination_dir: dest.clone(),
            expected_sha256: None,
            expected_size: None,
            description: None,
        };
        sched.enqueue(item);
        enqueued.push(json!({
            "url": PrivacyShield::sanitize_for_receipt(&clean_url),
            "filename": fname,
            "destinationDir": dest.display().to_string(),
        }));
    }
    let pending = sched.pending_len();
    let active_count = sched.active_count();
    drop(sched);
    if !enqueued.is_empty() {
        ensure_scheduler_pump_and_hydrate(state).notify_one();
    }

    HttpResponse::ok(json!({
        "ok": true,
        "enqueuedCount": enqueued.len(),
        "enqueued": enqueued,
        "pending": pending,
        "activeCount": active_count,
        "autoGroupSeries": auto_group_series,
        "drmSupported": DRM_SUPPORTED,
    }))
}

fn handle_drive_export_ef2(req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let mut entries: Vec<Ef2Entry> = Vec::new();
    if let Some(arr) = obj.get("entries").and_then(Value::as_array) {
        for item in arr {
            if let Some(u) = item
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                if is_unc_or_smb_path(u) {
                    return unc_blocked_response();
                }
                entries.push(Ef2Entry {
                    url: PrivacyShield::sanitize_live_url(u),
                    filename: item
                        .get("filename")
                        .and_then(Value::as_str)
                        .and_then(|f| safe_output_filename(f).ok()),
                    referer: item
                        .get("referer")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    user_agent: item
                        .get("userAgent")
                        .or_else(|| item.get("user_agent"))
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    description: item
                        .get("description")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                });
            }
        }
    } else if let Some(arr) = obj.get("urls").and_then(Value::as_array) {
        for v in arr {
            if let Some(u) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                if is_unc_or_smb_path(u) {
                    return unc_blocked_response();
                }
                entries.push(Ef2Entry {
                    url: PrivacyShield::sanitize_live_url(u),
                    filename: None,
                    referer: None,
                    user_agent: None,
                    description: None,
                });
            }
        }
    }
    if entries.is_empty() {
        return HttpResponse::error(
            400,
            "missing_ef2_entries",
            "Field 'entries' or 'urls' must contain at least one URL.",
        );
    }
    let ef2 = serialize_ef2(&entries);
    HttpResponse::ok(json!({
        "ok": true,
        "count": entries.len(),
        "ef2": ef2,
        "content": ef2,
    }))
}

fn handle_drive_import_ef2(req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(content) = obj
        .get("content")
        .or_else(|| obj.get("ef2"))
        .or_else(|| obj.get("text"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    else {
        return HttpResponse::error(
            400,
            "missing_ef2_content",
            "Field 'content' (or 'ef2') is required.",
        );
    };
    match parse_ef2(content) {
        Ok(entries) => HttpResponse::ok(json!({
            "ok": true,
            "count": entries.len(),
            "entries": entries,
        })),
        Err(err) => map_downloader_error(err),
    }
}

fn handle_drive_scheduler_get(state: &Arc<StudioState>) -> HttpResponse {
    let _ = ensure_scheduler_pump_and_hydrate(state);
    let cfg = state
        .download_scheduler_config
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    let (pending, active_count) = {
        let sched = state.downloads.scheduler().lock();
        (sched.pending_len(), sched.active_count())
    };
    let site_rules = state
        .download_site_policies
        .lock()
        .map(|r| r.list_rules().to_vec())
        .unwrap_or_default();

    let window_json = cfg.window.map(|w| {
        json!({
            "startHourUtc": w.start_hour_utc,
            "endHourUtc": w.end_hour_utc,
            "start_hour_utc": w.start_hour_utc,
            "end_hour_utc": w.end_hour_utc,
        })
    });

    HttpResponse::ok(json!({
        "ok": true,
        "config": cfg,
        "maxConcurrentJobs": cfg.max_concurrent_jobs,
        "window": window_json,
        "pending": pending,
        "activeCount": active_count,
        "siteRules": site_rules,
    }))
}

fn handle_drive_scheduler_post(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let pump_notify = ensure_scheduler_pump_and_hydrate(state);
    let mut cfg = state
        .download_scheduler_config
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();

    if let Some(max_c) = obj
        .get("maxConcurrentJobs")
        .or_else(|| obj.get("max_concurrent_jobs"))
        .and_then(Value::as_u64)
    {
        cfg.max_concurrent_jobs = (max_c as usize).clamp(1, 32);
    }

    if let Some(win_val) = obj.get("window") {
        if win_val.is_null() {
            cfg.window = None;
        } else if let Some(wobj) = win_val.as_object() {
            let start = wobj
                .get("startHourUtc")
                .or_else(|| wobj.get("start_hour_utc"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(23) as u32;
            let end = wobj
                .get("endHourUtc")
                .or_else(|| wobj.get("end_hour_utc"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(23) as u32;
            cfg.window = Some(ScheduleWindow {
                start_hour_utc: start,
                end_hour_utc: end,
            });
        }
    } else if obj.contains_key("startHourUtc") || obj.contains_key("endHourUtc") {
        let start = obj
            .get("startHourUtc")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(23) as u32;
        let end = obj
            .get("endHourUtc")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(23) as u32;
        cfg.window = Some(ScheduleWindow {
            start_hour_utc: start,
            end_hour_utc: end,
        });
    }

    if let Some(rule_val) = obj.get("siteRule").or_else(|| obj.get("site_rule")) {
        if let Some(robj) = rule_val.as_object() {
            let pat = robj
                .get("hostPattern")
                .or_else(|| robj.get("host_pattern"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let cap = robj
                .get("maxConnectionsPerHost")
                .or_else(|| robj.get("max_connections_per_host"))
                .and_then(Value::as_u64)
                .unwrap_or(8) as usize;
            let rule = SiteRule {
                host_pattern: pat,
                max_connections_per_host: cap,
                default_pacing: robj
                    .get("defaultPacing")
                    .or_else(|| robj.get("default_pacing"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                note: robj
                    .get("note")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            };
            if let Ok(mut reg) = state.download_site_policies.lock() {
                if let Err(err) = reg.upsert_rule(rule) {
                    return map_downloader_error(err);
                }
            }
        }
    }
    if let Some(rules_arr) = obj
        .get("siteRules")
        .or_else(|| obj.get("site_rules"))
        .and_then(Value::as_array)
    {
        if let Ok(mut reg) = state.download_site_policies.lock() {
            for rv in rules_arr {
                if let Some(robj) = rv.as_object() {
                    let pat = robj
                        .get("hostPattern")
                        .or_else(|| robj.get("host_pattern"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if pat.is_empty() {
                        continue;
                    }
                    let cap = robj
                        .get("maxConnectionsPerHost")
                        .or_else(|| robj.get("max_connections_per_host"))
                        .and_then(Value::as_u64)
                        .unwrap_or(8) as usize;
                    let rule = SiteRule {
                        host_pattern: pat,
                        max_connections_per_host: cap,
                        default_pacing: robj
                            .get("defaultPacing")
                            .or_else(|| robj.get("default_pacing"))
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                        note: robj
                            .get("note")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    };
                    if let Err(err) = reg.upsert_rule(rule) {
                        return map_downloader_error(err);
                    }
                }
            }
        }
    }

    if let Err(err) = state.downloads.store().save_scheduler_config(&cfg) {
        return map_downloader_error(err);
    }
    if let Ok(reg) = state.download_site_policies.lock() {
        if let Err(err) = state.downloads.store().replace_site_policies(&reg) {
            return map_downloader_error(err);
        }
    }
    if let Ok(mut guard) = state.download_scheduler_config.lock() {
        *guard = cfg.clone();
    }
    {
        let mut sched = state.downloads.scheduler().lock();
        sched.set_config(cfg.clone());
    }
    pump_notify.notify_one();

    handle_drive_scheduler_get(state)
}

async fn handle_drive_integrity_verify(req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(raw_path) = obj
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(400, "missing_path", "Field 'path' is required.");
    };
    if is_unc_or_smb_path(raw_path) {
        return unc_blocked_response();
    }
    let safe_path = match validate_safe_local_path(Path::new(raw_path), None) {
        Ok(p) => p,
        Err(err) => return map_downloader_error(err),
    };
    let expected_sha256 = obj
        .get("expectedSha256")
        .or_else(|| obj.get("expected_sha256"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let expected_crc32c = obj
        .get("expectedCrc32c")
        .or_else(|| obj.get("expectedCrc32cB64"))
        .or_else(|| obj.get("expected_crc32c_b64"))
        .or_else(|| obj.get("expected_crc32c"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let expected_md5 = obj
        .get("expectedMd5")
        .or_else(|| obj.get("expected_md5"))
        .or_else(|| obj.get("expectedMd5Hex"))
        .or_else(|| obj.get("expected_md5_hex"))
        .or_else(|| obj.get("expectedMd5B64"))
        .or_else(|| obj.get("expected_md5_b64"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);

    let res = tokio::task::spawn_blocking(move || {
        verify_file_integrity_with_md5(
            &safe_path,
            expected_sha256.as_deref(),
            expected_crc32c.as_deref(),
            expected_md5.as_deref(),
        )
    })
    .await;

    match res {
        Ok(Ok(report)) => HttpResponse::ok(json!({
            "ok": true,
            "verified": true,
            "report": report,
        })),
        Ok(Err(err)) => map_downloader_error(err),
        Err(err) => HttpResponse::error(500, "integrity_task_failed", &err.to_string()),
    }
}

async fn handle_drive_journal_inspect(req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(raw_path) = obj
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(400, "missing_path", "Field 'path' is required.");
    };
    if is_unc_or_smb_path(raw_path) {
        return unc_blocked_response();
    }
    let safe_path = match validate_safe_local_path(Path::new(raw_path), None) {
        Ok(p) => p,
        Err(err) => return map_downloader_error(err),
    };

    let res = tokio::task::spawn_blocking(move || -> Result<Value, DownloaderError> {
        let mut head = [0u8; 4];
        {
            use std::io::Read as _;
            let mut f = std::fs::File::open(&safe_path)?;
            let n = f.read(&mut head)?;
            if n == 4 && head == OMNF_MAGIC {
                let replayed = OmnfJournal::replay_file(&safe_path)?;
                return Ok(json!({
                    "ok": true,
                    "format": "omnf",
                    "omnf": {
                        "jobId": replayed.job_id,
                        "sanitizedUrl": replayed.sanitized_url,
                        "totalSize": replayed.total_size,
                        "etag": replayed.etag,
                        "lastModified": replayed.last_modified,
                        "completedRanges": replayed.completed_ranges,
                        "fallbackTruncated": replayed.fallback_truncated,
                        "sha256Hex": replayed.sha256_hex,
                        "crc32cB64": replayed.crc32c_b64,
                        "finished": replayed.finished,
                        "recordsReplayed": replayed.records_replayed,
                    },
                }));
            }
        }
        let meta = PartMetaV2::load(&safe_path)?;
        Ok(json!({
            "ok": true,
            "format": "part_meta_v2",
            "completedBytes": meta.completed_bytes(),
            "ifRangeValidator": meta.if_range_validator(),
            "partMeta": meta,
        }))
    })
    .await;

    match res {
        Ok(Ok(payload)) => HttpResponse::ok(payload),
        Ok(Err(err)) => map_downloader_error(err),
        Err(err) => HttpResponse::error(500, "journal_inspect_failed", &err.to_string()),
    }
}

async fn handle_drive_inspect_media(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };

    if let Some(hex_str) = obj
        .get("hex")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let decoded = match decode_hex_bytes(hex_str) {
            Ok(bytes) => bytes,
            Err(msg) => return HttpResponse::error(400, "invalid_hex", &msg),
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
            "drmSupported": DRM_SUPPORTED,
            "report": report,
        }));
    }

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
            "drmSupported": DRM_SUPPORTED,
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
            Path::new(raw_path),
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
                "drmSupported": DRM_SUPPORTED,
                "report": report,
            })),
            Ok(Err(err)) => map_downloader_error(err),
            Err(err) => HttpResponse::error(500, "inspect_task_failed", &err.to_string()),
        };
    }

    HttpResponse::error(
        400,
        "missing_media_input",
        "Either 'hex', 'bytes_base64', or external 'path' is required.",
    )
}

fn handle_drive_providers(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let q = req
        .query_param("q")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let cat_filter = req
        .query_param("category")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();

    let all = state.downloads.providers().list();
    let categories = state.downloads.providers().categories();
    let providers: Vec<Value> = all
        .iter()
        .filter(|p| {
            let cat_str = serde_json::to_value(p.category)
                .ok()
                .and_then(|v| v.as_str().map(ToString::to_string))
                .unwrap_or_default();
            let cat_ok = cat_filter.is_empty()
                || cat_filter == "all"
                || cat_str.eq_ignore_ascii_case(&cat_filter);
            let q_ok = q.is_empty()
                || p.id.to_ascii_lowercase().contains(&q)
                || p.name.to_ascii_lowercase().contains(&q)
                || p.host_patterns
                    .iter()
                    .any(|h| h.to_ascii_lowercase().contains(&q));
            cat_ok && q_ok
        })
        .map(|p| {
            let mut val = serde_json::to_value(p).unwrap_or_else(|_| json!({}));
            if let Value::Object(ref mut map) = val {
                map.insert("domains".to_string(), json!(p.host_patterns));
            }
            val
        })
        .collect();

    HttpResponse::ok(json!({
        "ok": true,
        "count": providers.len(),
        "totalProviders": all.len(),
        "providers": providers,
        "categories": categories,
        "drm_supported": DRM_SUPPORTED,
        "drmSupported": DRM_SUPPORTED,
    }))
}

fn handle_drive_handoffs(state: &Arc<StudioState>) -> HttpResponse {
    let tickets = state.downloads.handoffs().list_tickets();
    HttpResponse::ok(json!({
        "ok": true,
        "execution_mode": EXECUTION_MODE_MANUAL_VISIBLE_BROWSER,
        "executionMode": EXECUTION_MODE_MANUAL_VISIBLE_BROWSER,
        "auto_solve_permitted": AUTO_SOLVE_PERMITTED,
        "autoSolvePermitted": AUTO_SOLVE_PERMITTED,
        "drm_supported": DRM_SUPPORTED,
        "drmSupported": DRM_SUPPORTED,
        "count": tickets.len(),
        "tickets": tickets,
        "handoffs": tickets,
    }))
}

fn parse_handoff_reason(raw: &str) -> HandoffReason {
    match raw
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .as_str()
    {
        "blocked_acl_403" | "acl_403" | "forbidden" => HandoffReason::BlockedAcl403,
        "sign_in_required" | "auth_required" | "mfa_required" | "session_expired" | "login" => {
            HandoffReason::SignInRequired
        }
        "drm_unsupported" | "drm" => HandoffReason::DrmUnsupported,
        _ => HandoffReason::AuthChallengeRequired,
    }
}

fn handle_drive_handoff_create(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
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
    let reason = parse_handoff_reason(
        obj.get("reason")
            .and_then(Value::as_str)
            .unwrap_or("auth_challenge_required"),
    );
    let detail = obj
        .get("detail")
        .or_else(|| obj.get("note"))
        .and_then(Value::as_str)
        .unwrap_or("Manual user action required in a visible browser window.");

    let ticket = state.downloads.handoffs().create_ticket(url, reason, detail);
    HttpResponse::ok(json!({
        "ok": true,
        "execution_mode": EXECUTION_MODE_MANUAL_VISIBLE_BROWSER,
        "executionMode": EXECUTION_MODE_MANUAL_VISIBLE_BROWSER,
        "auto_solve_permitted": AUTO_SOLVE_PERMITTED,
        "autoSolvePermitted": AUTO_SOLVE_PERMITTED,
        "drm_supported": DRM_SUPPORTED,
        "drmSupported": DRM_SUPPORTED,
        "ticketId": ticket.ticket_id,
        "ticket": ticket,
    }))
}

fn handle_drive_handoff_transition(
    state: &Arc<StudioState>,
    req: &HttpRequest,
    action: &str,
) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(ticket_id) = obj
        .get("ticketId")
        .or_else(|| obj.get("ticket_id"))
        .or_else(|| obj.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(400, "missing_ticket_id", "Field 'ticketId' is required.");
    };

    let updated = match action {
        "open" => state
            .downloads
            .handoffs()
            .mark_opened_in_visible_browser(ticket_id),
        "resolve" => state.downloads.handoffs().mark_completed_by_user(ticket_id),
        "cancel" => state.downloads.handoffs().cancel_ticket(ticket_id),
        _ => None,
    };

    match updated {
        Some(ticket) => HttpResponse::ok(json!({
            "ok": true,
            "action": action,
            "execution_mode": EXECUTION_MODE_MANUAL_VISIBLE_BROWSER,
            "executionMode": EXECUTION_MODE_MANUAL_VISIBLE_BROWSER,
            "auto_solve_permitted": AUTO_SOLVE_PERMITTED,
            "autoSolvePermitted": AUTO_SOLVE_PERMITTED,
            "drm_supported": DRM_SUPPORTED,
            "drmSupported": DRM_SUPPORTED,
            "ticket": ticket,
        })),
        None => HttpResponse::error(
            404,
            "handoff_not_found",
            &format!("Handoff ticket '{ticket_id}' not found."),
        ),
    }
}

fn handle_drive_cookies_evaluate(req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(raw_url) = obj
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(400, "missing_url", "Field 'url' is required.");
    };
    let Ok(target_url) = Url::parse(raw_url) else {
        return HttpResponse::error(400, "invalid_url", "Field 'url' must be a valid URL.");
    };
    let origin_url = obj
        .get("originUrl")
        .or_else(|| obj.get("origin_url"))
        .and_then(Value::as_str)
        .and_then(|s| Url::parse(s.trim()).ok())
        .unwrap_or_else(|| target_url.clone());
    let prev_origin = obj
        .get("previousOrigin")
        .or_else(|| obj.get("previous_origin"))
        .and_then(Value::as_str)
        .and_then(|s| Url::parse(s.trim()).ok());

    let raw_cookies: Vec<String> = obj
        .get("setCookies")
        .or_else(|| obj.get("set_cookies"))
        .or_else(|| obj.get("cookies"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();

    let jar = ScopedCookieJar::new();
    let mut decisions: Vec<Value> = Vec::new();
    let mut accepted_count = 0usize;
    let mut rejected_count = 0usize;

    for raw_hdr in &raw_cookies {
        let cookie_name = raw_hdr
            .split(';')
            .next()
            .and_then(|nv| nv.split_once('='))
            .map(|(n, _)| n.trim())
            .unwrap_or("(malformed)");
        let accepted = jar.store_set_cookie(&origin_url, raw_hdr);
        if accepted {
            accepted_count += 1;
        } else {
            rejected_count += 1;
        }
        decisions.push(json!({
            "name": cookie_name,
            "accepted": accepted,
            "reason": if accepted { "stored_in_scoped_jar" } else { "rejected_by_rfc6265_or_psl_guard" },
        }));
    }

    let same_site_ctx = obj
        .get("sameSiteContext")
        .or_else(|| obj.get("same_site_context"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map_or(SameSiteContext::SameSite, SameSiteContext::parse);
    let same_site_context_label = match same_site_ctx {
        SameSiteContext::SameSite => "same_site",
        SameSiteContext::CrossSiteTopLevelNav => "cross_site_top_level_nav",
        SameSiteContext::CrossSiteSubresource => "cross_site_subresource",
    };

    // Extract only cookie NAMES (never echoing raw cookie values in receipts!).
    let (matched_names, blocked_same_site_names) =
        jar.evaluate_names_for_context(&target_url, prev_origin.as_ref(), same_site_ctx);

    HttpResponse::ok(json!({
        "ok": true,
        "sanitizedUrl": PrivacyShield::sanitize_for_receipt(raw_url),
        "sameSiteContext": same_site_context_label,
        "storedCount": jar.len(),
        "acceptedCount": accepted_count,
        "rejectedCount": rejected_count,
        "matchedCount": matched_names.len(),
        "matchedCookieNames": matched_names,
        "blockedBySameSiteCount": blocked_same_site_names.len(),
        "blockedBySameSiteNames": blocked_same_site_names,
        "crossOriginStripped": prev_origin.is_some() && matched_names.is_empty() && accepted_count > 0,
        "decisions": decisions,
    }))
}

fn handle_drive_recommend(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let raw_url = obj
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("https://example.test/download.bin");
    let size_bytes = obj
        .get("fileSizeBytes")
        .or_else(|| obj.get("file_size_bytes"))
        .or_else(|| obj.get("sizeBytes"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let supports_range = obj
        .get("supportsRange")
        .or_else(|| obj.get("supports_range"))
        .and_then(Value::as_bool);
    let has_strong_etag = obj
        .get("hasStrongEtag")
        .or_else(|| obj.get("has_strong_etag"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let requires_auth = obj
        .get("requiresAuth")
        .or_else(|| obj.get("requires_auth"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let prov = state.downloads.providers().resolve_url(raw_url);
    let effective_range = supports_range.unwrap_or(prov.supports_ranges);
    let streams = if !effective_range || (size_bytes > 0 && size_bytes < DEFAULT_MIN_SPLIT_BYTES) {
        1
    } else if size_bytes >= 256 * 1024 * 1024 {
        prov.default_streams.clamp(16, MAX_STREAMS)
    } else {
        prov.default_streams.clamp(MIN_STREAMS, MAX_STREAMS)
    };
    let pacing = if !effective_range {
        PacingMode::LinearRateGuarded
    } else {
        prov.pacing_mode
    };
    let execution_mode = if requires_auth {
        EXECUTION_MODE_MANUAL_VISIBLE_BROWSER
    } else {
        "DIRECT_MULTI_STREAM"
    };

    HttpResponse::ok(json!({
        "ok": true,
        "providerId": prov.id,
        "providerName": prov.name,
        "category": prov.category,
        "pacingMode": pacing.as_str(),
        "streams": streams,
        "minSplitBytes": DEFAULT_MIN_SPLIT_BYTES,
        "supportsRange": effective_range,
        "resumable": effective_range && has_strong_etag,
        "executionMode": execution_mode,
        "autoSolvePermitted": AUTO_SOLVE_PERMITTED,
        "auto_solve_permitted": AUTO_SOLVE_PERMITTED,
        "drmSupported": DRM_SUPPORTED,
        "drm_supported": DRM_SUPPORTED,
    }))
}

fn handle_drive_aimd(state: &Arc<StudioState>) -> HttpResponse {
    let jobs = state.downloads.list_jobs().unwrap_or_default();
    let active_jobs = jobs
        .iter()
        .filter(|j| matches!(j.status, omnia_downloader::DownloadStatus::Downloading))
        .count();
    let live = state.downloads.live_aimd_telemetry();

    HttpResponse::ok(json!({
        "ok": true,
        "pacingMode": live.pacing_mode.as_str(),
        "activeJobs": active_jobs,
        "totalJobs": jobs.len(),
        "metrics": live.metrics,
        "activeWorkers": live.active_workers,
        "sampleCount": live.sample_count,
        "activeJobId": live.active_job_id,
        "updatedAtMs": live.updated_at_ms,
        "globalSpeedLimitBps": state.downloads.global_speed_limit_bps(),
        "drmSupported": DRM_SUPPORTED,
        "autoSolvePermitted": AUTO_SOLVE_PERMITTED,
    }))
}

fn handle_drive_bundles_list(state: &Arc<StudioState>) -> HttpResponse {
    let bundles = state
        .captured_bundles
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    HttpResponse::ok(json!({
        "ok": true,
        "count": bundles.len(),
        "bundles": bundles,
        "drmSupported": DRM_SUPPORTED,
    }))
}

fn handle_downloads_speed_limit(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let raw_val = obj
        .get("speedLimitBps")
        .or_else(|| obj.get("speed_limit_bps"))
        .or_else(|| obj.get("bytesPerSec"))
        .or_else(|| obj.get("bytes_per_sec"));
    let limit_bps = match raw_val {
        None | Some(Value::Null) => None,
        Some(Value::Number(num)) => {
            let Some(v) = num.as_u64() else {
                return HttpResponse::error(
                    400,
                    "invalid_speed_limit",
                    "Field 'speedLimitBps' must be a non-negative integer or null.",
                );
            };
            (v > 0).then_some(v)
        }
        Some(_) => {
            return HttpResponse::error(
                400,
                "invalid_speed_limit",
                "Field 'speedLimitBps' must be an integer (bytes/sec) or null.",
            );
        }
    };
    state.downloads.set_global_speed_limit_bps(limit_bps);
    HttpResponse::ok(json!({
        "ok": true,
        "globalSpeedLimitBps": state.downloads.global_speed_limit_bps(),
    }))
}

fn handle_drive_detect(req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let mut raw_items: Vec<(String, Option<String>, Option<u64>)> = Vec::new();
    if let Some(arr) = obj.get("candidates").and_then(Value::as_array) {
        for entry in arr.iter().take(512) {
            let Some(eobj) = entry.as_object() else {
                continue;
            };
            let Some(url_str) = eobj
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let mime = eobj
                .get("mimeType")
                .or_else(|| eobj.get("mime_type"))
                .or_else(|| eobj.get("contentType"))
                .and_then(Value::as_str)
                .map(|s| s.trim().to_string());
            let len = eobj
                .get("contentLength")
                .or_else(|| eobj.get("content_length"))
                .and_then(Value::as_u64);
            raw_items.push((url_str.to_string(), mime, len));
        }
    } else if let Some(url_str) = obj
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let mime = obj
            .get("mimeType")
            .or_else(|| obj.get("mime_type"))
            .or_else(|| obj.get("contentType"))
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string());
        let len = obj
            .get("contentLength")
            .or_else(|| obj.get("content_length"))
            .and_then(Value::as_u64);
        raw_items.push((url_str.to_string(), mime, len));
    } else {
        return HttpResponse::error(
            400,
            "missing_url",
            "Field 'url' or 'candidates' array is required.",
        );
    }

    let mut detected = Vec::new();
    let mut suppressed_count = 0usize;
    let mut seen_dedupe = BTreeSet::new();
    for (url_str, mime, len) in raw_items {
        if is_unc_or_smb_path(&url_str) {
            return unc_blocked_response();
        }
        if let Some(mut cand) = classify_captured_media(&url_str, mime.as_deref(), len) {
            cand.url = PrivacyShield::sanitize_for_receipt(&cand.url);
            cand.dedupe_key = PrivacyShield::sanitize_for_receipt(&cand.dedupe_key);
            if seen_dedupe.insert(cand.dedupe_key.clone()) {
                detected.push(cand);
            } else {
                suppressed_count += 1;
            }
        } else {
            suppressed_count += 1;
        }
    }

    HttpResponse::ok(json!({
        "ok": true,
        "detectedCount": detected.len(),
        "suppressedCount": suppressed_count,
        "candidates": detected,
        "drmSupported": DRM_SUPPORTED,
    }))
}

fn handle_drive_blob_chunk(state: &Arc<StudioState>, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(upload_id) = obj
        .get("uploadId")
        .or_else(|| obj.get("upload_id"))
        .or_else(|| obj.get("sessionId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .map(ToString::to_string)
    else {
        return HttpResponse::error(400, "missing_upload_id", "Field 'uploadId' is required.");
    };

    let abort_requested = obj.get("abort").and_then(Value::as_bool).unwrap_or(false);
    let store_arc = blob_sessions_for_state(state);
    if abort_requested {
        let removed = store_arc
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&upload_id);
        if let Some(asm) = removed {
            asm.abort();
        }
        return HttpResponse::ok(json!({
            "ok": true,
            "uploadId": upload_id,
            "aborted": true,
        }));
    }

    let staging_dir = if let Some(raw_dir) = obj
        .get("stagingDir")
        .or_else(|| obj.get("staging_dir"))
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

    let safe_staging =
        match validate_safe_local_path(&staging_dir, Some(&state.config.workspace_root)) {
            Ok(p) => p,
            Err(err) => return map_downloader_error(err),
        };
    let raw_filename = obj
        .get("filename")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("blob_capture.bin");
    if is_unc_or_smb_path(raw_filename) {
        return unc_blocked_response();
    }

    let total_chunks = obj
        .get("totalChunks")
        .or_else(|| obj.get("total_chunks"))
        .and_then(Value::as_u64)
        .map(|n| n as usize);
    let chunk_idx = obj
        .get("chunkIndex")
        .or_else(|| obj.get("chunk_index"))
        .and_then(Value::as_u64)
        .map(|n| n as usize);
    let data_b64 = obj
        .get("dataBase64")
        .or_else(|| obj.get("data_base64"))
        .or_else(|| obj.get("chunkBase64"))
        .or_else(|| obj.get("chunk_base64"))
        .and_then(Value::as_str);

    if chunk_idx.is_some() != data_b64.is_some() {
        return HttpResponse::error(
            400,
            "invalid_blob_chunk",
            "Fields 'chunkIndex' and 'dataBase64' must be provided together.",
        );
    }

    let finalize_opt = obj.get("finalize").and_then(Value::as_bool);
    let expected_sha256 = obj
        .get("expectedSha256")
        .or_else(|| obj.get("expected_sha256"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let expected_crc32c = obj
        .get("expectedCrc32c")
        .or_else(|| obj.get("expected_crc32c"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let expected_md5 = obj
        .get("expectedMd5")
        .or_else(|| obj.get("expected_md5"))
        .or_else(|| obj.get("expectedMd5Hex"))
        .or_else(|| obj.get("expected_md5_hex"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);

    let finalized_asm: Option<BlobAssembler>;
    let partial_snapshot: Option<(usize, u64, bool)>;
    {
        let mut sessions = store_arc.lock().unwrap_or_else(|e| e.into_inner());
        if !sessions.contains_key(&upload_id) {
            let asm = match BlobAssembler::new(
                &safe_staging,
                raw_filename,
                Some(&state.config.workspace_root),
            ) {
                Ok(a) => a,
                Err(err) => return map_downloader_error(err),
            };
            sessions.insert(upload_id.clone(), asm);
        }
        let asm = sessions
            .get_mut(&upload_id)
            .expect("inserted blob assembler session");
        if let Some(total) = total_chunks {
            if let Err(err) = asm.set_total_chunks(total) {
                return map_downloader_error(err);
            }
        }
        if let (Some(idx), Some(b64)) = (chunk_idx, data_b64) {
            if let Err(err) = asm.push_base64_chunk(idx, b64) {
                return map_downloader_error(err);
            }
        }
        let should_finalize = finalize_opt.unwrap_or_else(|| asm.is_complete());
        if should_finalize {
            finalized_asm = sessions.remove(&upload_id);
            partial_snapshot = None;
        } else {
            finalized_asm = None;
            partial_snapshot = Some((
                asm.received_count(),
                asm.buffered_bytes(),
                asm.is_complete(),
            ));
        }
    }

    if let Some((received_count, buffered_bytes, is_complete)) = partial_snapshot {
        return HttpResponse::ok(json!({
            "ok": true,
            "uploadId": upload_id,
            "finalized": false,
            "receivedCount": received_count,
            "bufferedBytes": buffered_bytes,
            "isComplete": is_complete,
        }));
    }

    let asm = finalized_asm.expect("finalized assembler removed");
    let (out_path, written) = match asm.finalize() {
        Ok(res) => res,
        Err(err) => return map_downloader_error(err),
    };
    let report = match verify_file_integrity_with_md5(
        &out_path,
        expected_sha256.as_deref(),
        expected_crc32c.as_deref(),
        expected_md5.as_deref(),
    ) {
        Ok(r) => r,
        Err(err) => return map_downloader_error(err),
    };

    HttpResponse::ok(json!({
        "ok": true,
        "uploadId": upload_id,
        "finalized": true,
        "outputPath": out_path.display().to_string(),
        "totalBytes": written,
        "integrity": report,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::StudioConfig;
    use omnia_downloader::OmnfRecord;

    fn make_req(method: &str, path: &str, query: &str, body: Value) -> HttpRequest {
        HttpRequest {
            method: method.to_string(),
            target: if query.is_empty() {
                path.to_string()
            } else {
                format!("{path}?{query}")
            },
            path: path.to_string(),
            query: query.to_string(),
            headers: BTreeMap::new(),
            cookie_header_count: 0,
            body: if method == "GET" {
                Vec::new()
            } else {
                serde_json::to_vec(&body).unwrap_or_default()
            },
        }
    }

    fn make_test_state() -> (Arc<StudioState>, PathBuf) {
        let mut cfg = StudioConfig::default();
        let tmp = std::env::temp_dir().join(format!(
            "omnia-studio-dl-test-{}",
            omnia_core::uuid_v4_simple()
        ));
        let ws = tmp.join("ws");
        let rb = tmp.join("rb");
        let _ = std::fs::create_dir_all(&ws);
        let _ = std::fs::create_dir_all(&rb);
        cfg.workspace_root = ws;
        cfg.rollback_root = rb;
        cfg.db_path = None;
        cfg.runtime_url = None;
        (Arc::new(StudioState::new(cfg).expect("StudioState::new")), tmp)
    }

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

    #[tokio::test]
    async fn omnidrive_v3_endpoints_ef2_scheduler_handoffs_cookies_recommend_aimd_integrity_journal() {
        let (state, tmp) = make_test_state();

        // 1. Batch plan (mixed text + tracker strip + dedupe)
        let plan_resp = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/batch/plan",
                "",
                json!({
                    "input": "Check https://example.test/pack_[01-02].zip?utm_source=demo and https://example.test/pack_01.zip"
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(plan_resp.status, 200);
        let pj: Value = serde_json::from_slice(&plan_resp.body).unwrap();
        assert_eq!(pj["count"], 2);
        assert_eq!(pj["deduped"], 1);
        assert_eq!(pj["trackersStripped"], 2);

        // 2. EF2 export & import roundtrip
        let exp = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/batch/export-ef2",
                "",
                json!({ "urls": ["https://example.test/a.bin", "https://example.test/b.bin"] }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(exp.status, 200);
        let ef2_str = serde_json::from_slice::<Value>(&exp.body).unwrap()["ef2"]
            .as_str()
            .unwrap()
            .to_string();
        let imp = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/batch/import-ef2",
                "",
                json!({ "content": ef2_str }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(imp.status, 200);
        assert_eq!(serde_json::from_slice::<Value>(&imp.body).unwrap()["count"], 2);

        // 3. Scheduler GET & POST + siteRule
        let sch_post = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/scheduler",
                "",
                json!({
                    "maxConcurrentJobs": 5,
                    "window": { "startHourUtc": 1, "endHourUtc": 6 },
                    "siteRule": { "hostPattern": "*.example.test", "maxConnectionsPerHost": 4 }
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(sch_post.status, 200);
        let sj: Value = serde_json::from_slice(&sch_post.body).unwrap();
        assert_eq!(sj["maxConcurrentJobs"], 5);
        assert_eq!(sj["siteRules"].as_array().unwrap().len(), 1);

        // 4. Handoffs create -> open -> resolve (strictly MANUAL_VISIBLE_BROWSER_ONLY, autoSolvePermitted: false)
        let hc = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/handoffs/create",
                "",
                json!({ "url": "https://example.test/protected", "reason": "auth_challenge_required" }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(hc.status, 200);
        let hcj: Value = serde_json::from_slice(&hc.body).unwrap();
        assert_eq!(hcj["executionMode"], EXECUTION_MODE_MANUAL_VISIBLE_BROWSER);
        assert_eq!(hcj["autoSolvePermitted"], false);
        let tid = hcj["ticketId"].as_str().unwrap().to_string();

        let ho = dispatch_download_route(
            &state,
            &make_req("POST", "/api/omni-drive/handoffs/open", "", json!({ "ticketId": tid })),
        )
        .await
        .unwrap();
        assert_eq!(ho.status, 200);
        let hr = dispatch_download_route(
            &state,
            &make_req("POST", "/api/omni-drive/handoffs/resolve", "", json!({ "ticketId": tid })),
        )
        .await
        .unwrap();
        assert_eq!(hr.status, 200);

        // 5. Cookies evaluate, Recommend, AIMD, Bundles GET (200 empty)
        let ck = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/cookies/evaluate",
                "",
                json!({
                    "url": "https://example.test/file",
                    "cookies": ["demo=1; Path=/; Secure", "bad=2; Domain=.com"]
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(ck.status, 200);
        let ckj: Value = serde_json::from_slice(&ck.body).unwrap();
        assert_eq!(ckj["acceptedCount"], 1);
        assert_eq!(ckj["rejectedCount"], 1);

        let rec = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/recommend",
                "",
                json!({ "url": "https://huggingface.co/org/model.gguf", "fileSizeBytes": 536870912 }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(rec.status, 200);
        assert_eq!(serde_json::from_slice::<Value>(&rec.body).unwrap()["autoSolvePermitted"], false);

        let aimd = dispatch_download_route(&state, &make_req("GET", "/api/omni-drive/aimd", "", Value::Null))
            .await
            .unwrap();
        assert_eq!(aimd.status, 200);

        let bundles = dispatch_download_route(
            &state,
            &make_req("GET", "/api/omni-drive/bundles", "", Value::Null),
        )
        .await
        .unwrap();
        assert_eq!(bundles.status, 200);

        // 6. Integrity verify + OMNF journal inspect + hex media inspect
        let sample_file = tmp.join("sample.bin");
        std::fs::write(&sample_file, b"omnia-fixture-payload").unwrap();
        let integ = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/integrity/verify",
                "",
                json!({ "path": sample_file.to_string_lossy() }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(integ.status, 200);

        let omnf_file = tmp.join("sample.part.omnf");
        OmnfJournal::append_record(
            &omnf_file,
            &OmnfRecord::JobInit {
                job_id: "job-1".to_string(),
                sanitized_url: "https://example.test/sample.bin".to_string(),
                total_size: 21,
                etag: Some("\"v1\"".to_string()),
                last_modified: None,
            },
        )
        .unwrap();
        let jrn = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/journal/inspect",
                "",
                json!({ "path": omnf_file.to_string_lossy() }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(jrn.status, 200);
        assert_eq!(serde_json::from_slice::<Value>(&jrn.body).unwrap()["format"], "omnf");

        let hex_insp = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/media/inspect",
                "",
                json!({ "hex": "000000186674797069736f6d0000020069736f6d6d703431" }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(hex_insp.status, 200);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn p0_site_policy_md5_samesite_speed_limit_detect_and_blob_chunk_routes() {
        let (state, tmp) = make_test_state();
        let stage = tmp.join("stage");
        std::fs::create_dir_all(&stage).unwrap();

        // 1. Configure SitePolicyRegistry rule for `*.example.test`.
        let sch_post = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/scheduler",
                "",
                json!({
                    "maxConcurrentJobs": 2,
                    "siteRule": {
                        "hostPattern": "*.example.test",
                        "maxConnectionsPerHost": 2,
                        "defaultPacing": "polite"
                    }
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(sch_post.status, 200);

        // 2. `/api/downloads/start` enforces SitePolicyRegistry stream cap (16 -> 2), default pacing,
        // and rejects invalid `clipStartSec >= clipEndSec` synchronously.
        let bad_clip = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/downloads/start",
                "",
                json!({
                    "url": "https://cdn.example.test/video.m3u8",
                    "stagingDir": stage.to_string_lossy(),
                    "clipStartSec": 5.0,
                    "clipEndSec": 2.0
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(bad_clip.status, 400);

        let start_ok = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/downloads/start",
                "",
                json!({
                    "url": "https://cdn.example.test/archive.bin",
                    "stagingDir": stage.to_string_lossy(),
                    "streams": 16,
                    "expectedMd5": "d41d8cd98f00b204e9800998ecf8427e",
                    "exportFormat": "pdf"
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(start_ok.status, 200);
        let sj: Value = serde_json::from_slice(&start_ok.body).unwrap();
        assert_eq!(sj["effective_streams"], 2);
        assert_eq!(sj["effective_pacing"], "polite");

        // 3. `/api/omni-drive/integrity/verify` honors `expectedMd5` pass & 422 mismatch.
        let sample_path = stage.join("sample_md5.bin");
        let payload = b"Omnia Studio MD5 Verification Bytes";
        std::fs::write(&sample_path, payload).unwrap();
        let md5_hex = omnia_core::hex_encode(&omnia_downloader::md5_bytes(payload));

        let md5_ok = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/integrity/verify",
                "",
                json!({
                    "path": sample_path.to_string_lossy(),
                    "expectedMd5": md5_hex
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(md5_ok.status, 200);
        let mj: Value = serde_json::from_slice(&md5_ok.body).unwrap();
        assert_eq!(mj["report"]["md5_verified"], true);

        let md5_bad = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/integrity/verify",
                "",
                json!({
                    "path": sample_path.to_string_lossy(),
                    "expectedMd5": "00000000000000000000000000000000"
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(md5_bad.status, 422);

        // 4. `/api/omni-drive/cookies/evaluate` enforces `sameSiteContext` cleanly without leaking values.
        let ck_sub = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/cookies/evaluate",
                "",
                json!({
                    "url": "https://cdn.example.test/api",
                    "previousOrigin": "https://other.example.org/",
                    "sameSiteContext": "cross_site_subresource",
                    "cookies": [
                        "strict_c=supersecret1; Path=/; Secure; SameSite=Strict",
                        "lax_c=supersecret2; Path=/; Secure; SameSite=Lax",
                        "none_c=supersecret3; Path=/; Secure; SameSite=None"
                    ]
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(ck_sub.status, 200);
        let ck_body = String::from_utf8_lossy(&ck_sub.body);
        assert!(!ck_body.contains("supersecret"));
        let ckj: Value = serde_json::from_slice(&ck_sub.body).unwrap();
        assert_eq!(ckj["sameSiteContext"], "cross_site_subresource");
        assert_eq!(ckj["matchedCookieNames"], json!(["none_c"]));
        assert_eq!(ckj["blockedBySameSiteCount"], 2);

        // 5. `/api/downloads/speed-limit` reflects on `GET /api/omni-drive/aimd`.
        let lim_set = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/downloads/speed-limit",
                "",
                json!({ "speedLimitBps": 1048576 }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(lim_set.status, 200);
        let aimd = dispatch_download_route(
            &state,
            &make_req("GET", "/api/omni-drive/aimd", "", Value::Null),
        )
        .await
        .unwrap();
        assert_eq!(aimd.status, 200);
        let aj: Value = serde_json::from_slice(&aimd.body).unwrap();
        assert_eq!(aj["globalSpeedLimitBps"], 1048576);
        assert!(aj.get("sampleCount").is_some());

        let lim_clr = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/downloads/speed-limit",
                "",
                json!({ "speedLimitBps": null }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(lim_clr.status, 200);
        assert_eq!(
            serde_json::from_slice::<Value>(&lim_clr.body).unwrap()["globalSpeedLimitBps"],
            Value::Null
        );

        // 6. `/api/omni-drive/detect` classifies streams and suppresses `.ts` & tiny media.
        let det = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/detect",
                "",
                json!({
                    "candidates": [
                        { "url": "https://cdn.example.test/live/master.m3u8?token=secret123", "mimeType": "application/vnd.apple.mpegurl" },
                        { "url": "https://cdn.example.test/live/seg-001.ts", "mimeType": "video/mp2t", "contentLength": 400000 },
                        { "url": "https://cdn.example.test/movie.mp4", "mimeType": "video/mp4", "contentLength": 500000 }
                    ]
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(det.status, 200);
        let dj: Value = serde_json::from_slice(&det.body).unwrap();
        assert_eq!(dj["detectedCount"], 2);
        assert_eq!(dj["suppressedCount"], 1);
        assert!(!String::from_utf8_lossy(&det.body).contains("secret123"));

        // 7. `/api/omni-drive/blob/chunk` blocks workspace-contained staging and assembles out-of-order chunks.
        let ws_reject = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/blob/chunk",
                "",
                json!({
                    "uploadId": "up-ws-fail",
                    "stagingDir": state.config.workspace_root.to_string_lossy(),
                    "filename": "bad.bin",
                    "totalChunks": 1,
                    "chunkIndex": 0,
                    "dataBase64": base64::engine::general_purpose::STANDARD.encode(b"bad")
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(ws_reject.status, 403);

        let c0 = b"BlobPartZero_";
        let c1 = b"BlobPartOne!";
        let full_blob = [c0.as_slice(), c1.as_slice()].concat();
        let blob_md5 = omnia_core::hex_encode(&omnia_downloader::md5_bytes(&full_blob));

        let push1 = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/blob/chunk",
                "",
                json!({
                    "uploadId": "up-1",
                    "stagingDir": stage.to_string_lossy(),
                    "filename": "capture.bin",
                    "totalChunks": 2,
                    "chunkIndex": 1,
                    "dataBase64": base64::engine::general_purpose::STANDARD.encode(c1)
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(push1.status, 200);
        assert_eq!(serde_json::from_slice::<Value>(&push1.body).unwrap()["finalized"], false);

        let push0 = dispatch_download_route(
            &state,
            &make_req(
                "POST",
                "/api/omni-drive/blob/chunk",
                "",
                json!({
                    "uploadId": "up-1",
                    "stagingDir": stage.to_string_lossy(),
                    "filename": "capture.bin",
                    "totalChunks": 2,
                    "chunkIndex": 0,
                    "dataBase64": base64::engine::general_purpose::STANDARD.encode(c0),
                    "expectedMd5": blob_md5
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(push0.status, 200);
        let p0j: Value = serde_json::from_slice(&push0.body).unwrap();
        assert_eq!(p0j["finalized"], true);
        assert_eq!(p0j["integrity"]["md5_verified"], true);
        assert_eq!(std::fs::read(stage.join("capture.bin")).unwrap(), full_blob);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn scheduler_persists_across_sqlite_reopen_and_pump_dispatches_batch_enqueue() {
        let tmp = std::env::temp_dir().join(format!(
            "omnia-studio-sched-pump-{}",
            omnia_core::uuid_v4_simple()
        ));
        let ws = tmp.join("ws");
        let rb = tmp.join("rb");
        let stage = tmp.join("stage");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&rb).unwrap();
        std::fs::create_dir_all(&stage).unwrap();
        let db_file = tmp.join("studio.db");

        let make_persistent_state = || {
            let cfg = StudioConfig {
                workspace_root: ws.clone(),
                rollback_root: rb.clone(),
                db_path: Some(db_file.clone()),
                runtime_url: None,
                ..StudioConfig::default()
            };
            Arc::new(StudioState::new(cfg).expect("persistent StudioState::new"))
        };

        // 1. Configure scheduler + SiteRule on instance 1, then drop instance 1.
        {
            let state1 = make_persistent_state();
            let post = dispatch_download_route(
                &state1,
                &make_req(
                    "POST",
                    "/api/omni-drive/scheduler",
                    "",
                    json!({
                        "maxConcurrentJobs": 7,
                        "window": { "startHourUtc": 2, "endHourUtc": 5 },
                        "siteRule": {
                            "hostPattern": "*.example.org",
                            "maxConnectionsPerHost": 3,
                            "defaultPacing": "turbo"
                        }
                    }),
                ),
            )
            .await
            .unwrap();
            assert_eq!(post.status, 200);
        }

        // 2. Reopen instance 2 on the same WAL DB and verify hydration via GET /scheduler.
        let state2 = make_persistent_state();
        let get_after = dispatch_download_route(
            &state2,
            &make_req("GET", "/api/omni-drive/scheduler", "", Value::Null),
        )
        .await
        .unwrap();
        assert_eq!(get_after.status, 200);
        let gj: Value = serde_json::from_slice(&get_after.body).unwrap();
        assert_eq!(gj["maxConcurrentJobs"], 7);
        assert_eq!(gj["window"]["startHourUtc"], 2);
        assert_eq!(gj["siteRules"].as_array().unwrap().len(), 1);
        assert_eq!(gj["siteRules"][0]["max_connections_per_host"], 3);

        // 3. Open schedule window (`null`) and verify batch enqueue triggers live background pump.
        let open_win = dispatch_download_route(
            &state2,
            &make_req(
                "POST",
                "/api/omni-drive/scheduler",
                "",
                json!({ "maxConcurrentJobs": 2, "window": null }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(open_win.status, 200);

        let enq = dispatch_download_route(
            &state2,
            &make_req(
                "POST",
                "/api/omni-drive/batch/enqueue",
                "",
                json!({
                    "urls": ["https://files.example.org/pumped_item.bin"],
                    "stagingDir": stage.to_string_lossy()
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(enq.status, 200);

        let mut dispatched = false;
        for _ in 0..25 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let pending = state2.downloads.scheduler().lock().pending_len();
            let jobs = state2.downloads.list_jobs().unwrap_or_default();
            if pending == 0 && !jobs.is_empty() {
                assert_eq!(jobs[0].streams, 3);
                assert_eq!(jobs[0].pacing_mode, PacingMode::Turbo);
                dispatched = true;
                break;
            }
        }
        assert!(dispatched, "background scheduler pump failed to dispatch queued batch item");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
