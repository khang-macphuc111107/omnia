//! Live async multi-segment HTTP Range engine (`DownloadEngine`) and Wave 3
//! Studio/CLI facade (`DownloadManager`).
//!
//! Capabilities:
//! - 1–128 parallel Range workers with strong `If-Range`/ETag validation.
//! - Dynamic midpoint work-stealing with exact `remainingForThisChunk` clamping.
//! - `200 OK` Range-violation truncate fallback to single sequential stream.
//! - Streaming pre-allocated random-access disk I/O (zero full-file RAM buffering).
//! - `.part.meta` v2 interval resume + binary `OMNF` CRC32 journal + `omnia-winsqlite` store.
//! - `AIMD + BDP` congestion controller (`Retry-After` seconds + RFC 9110 HTTP-date)
//!   + `TokenBucketLimiter` + 4 pacing modes.
//! - Streaming SHA-256 & CRC32C (`X-Goog-Hash`) integrity verification.
//! - Strict SSRF/loopback/private-IP redirect validation, cross-origin cookie/header strip,
//!   UNC/SMB blocking, `drm_supported = false`, and zero-retry `429 AUTH_CHALLENGE_REQUIRED`
//!   / `403 BLOCKED_ACL_403` fail-closed classification.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::Write as _;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use omnia_connector_gateway::artifact_intake::{classify_http_validator, HttpValidatorStrength};
use omnia_core::uuid_v4;
use parking_lot::{Mutex, RwLock};
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_LENGTH,
    CONTENT_RANGE, CONTENT_TYPE, COOKIE, ETAG, IF_RANGE, LAST_MODIFIED, LOCATION, RANGE,
    RETRY_AFTER, USER_AGENT,
};
use reqwest::{redirect, Client};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, watch};
use tokio::time::sleep;
use url::{Host, Url};

use crate::batch::{BatchPlanner, DownloadScheduler};
use crate::capture_bundle::{CaptureBundle, ContentAddressableBlobStore};
use crate::chunker::{
    normalize_completed_intervals, record_completed_interval, total_interval_bytes, Chunker,
};
use crate::crawlers::{
    crawl_moodle_course, crawl_web_tree, inspect_youtube_url, CrawlReport, YouTubeInspectResult,
};
use crate::drive::{
    extract_drive_confirm_url, parse_drive_url, resolve_workspace_export, DriveResourceKind,
    WorkspaceExportFormat,
};
use crate::handoff::{classify_http_response, VisibleHandoffManager};
use crate::integrity::{parse_x_goog_hash, verify_file_integrity_with_md5};
use crate::journal::{
    omnf_journal_path_for, part_meta_path_for, OmnfJournal, OmnfRecord, PartMetaV2,
};
use crate::media_box::{extract_moof_tfdt_timestamps, inspect_media_bytes, inspect_media_file, MediaBoxReport};
use crate::media_ops::{
    convert_or_clip_media, mux_or_skip_if_missing_cancellable, run_ffprobe,
    slice_segments_for_clip_range, FfprobeReport, MediaMuxOutcome, MediaMuxRequest,
};
use crate::pacing::{AimdBdpController, CongestionMetrics, PacingMode, TokenBucketLimiter};
use crate::privacy::{PrivacyShield, ProviderRegistry, ScopedCookieJar};
use crate::schema_drift::{compare_schema_snapshots, SchemaDriftReport};
use crate::store::DownloadStore;
use crate::streaming::{
    decrypt_hls_aes128_cbc, hls_audio_rendition_for, hls_sequence_iv, parse_dash_manifest,
    parse_hls_manifest, select_dash_tracks, select_hls_variant, DashManifest, HlsManifest,
    StreamQuality,
};
use crate::types::{
    check_redirect_https_downgrade, current_epoch_ms, safe_output_filename,
    validate_and_resolve_addrs, validate_safe_local_path, ChunkRange, CompletedDownload,
    DownloadConfig, DownloadJobSnapshot, DownloadProgressEvent, DownloadRequest, DownloadStatus,
    DownloaderError, ProbeInfo, SecurityPolicy, DRM_SUPPORTED,
};
use crate::writer::{CoalescedDiskWriter, PositionalWriter, DEFAULT_COALESCE_BYTES};

/// Control signal sent to an active download job via `tokio::sync::watch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobControl {
    Run,
    Pause,
    Cancel,
}

/// Live AIMD + BDP telemetry snapshot observed across active/completed multi-stream transfers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AimdTelemetrySnapshot {
    pub active_job_id: Option<String>,
    pub pacing_mode: PacingMode,
    pub metrics: CongestionMetrics,
    pub active_workers: usize,
    pub sample_count: u64,
    pub updated_at_ms: u64,
}

impl Default for AimdTelemetrySnapshot {
    fn default() -> Self {
        let init = AimdBdpController::new(PacingMode::Adaptive, 16).metrics();
        Self {
            active_job_id: None,
            pacing_mode: PacingMode::Adaptive,
            metrics: init,
            active_workers: 0,
            sample_count: 0,
            updated_at_ms: 0,
        }
    }
}

type PinnedClientCache = HashMap<(String, u16), (Instant, Client)>;

/// Core async multi-stream segmented HTTP Range download engine.
pub struct DownloadEngine {
    client: Client,
    pinned_clients: Arc<RwLock<PinnedClientCache>>,
    config: DownloadConfig,
    policy: SecurityPolicy,
    handoffs: Arc<VisibleHandoffManager>,
    cookie_jar: Arc<ScopedCookieJar>,
    providers: Arc<ProviderRegistry>,
}

impl DownloadEngine {
    /// Builds a production [`DownloadEngine`] with strict SSRF & manual-redirect validation.
    pub fn new(config: DownloadConfig) -> Result<Self, DownloaderError> {
        Self::with_components(
            config,
            SecurityPolicy::strict(),
            Arc::new(VisibleHandoffManager::new()),
            Arc::new(ScopedCookieJar::new()),
            Arc::new(ProviderRegistry::new()),
        )
    }

    /// Test-only constructor permitting loopback mock servers (`127.0.0.1` / `localhost`).
    #[cfg(test)]
    pub fn with_test_policy(mut config: DownloadConfig) -> Result<Self, DownloaderError> {
        config.no_proxy = true;
        Self::with_components(
            config,
            SecurityPolicy::allow_loopback_for_tests(),
            Arc::new(VisibleHandoffManager::new()),
            Arc::new(ScopedCookieJar::new()),
            Arc::new(ProviderRegistry::new()),
        )
    }

    pub(crate) fn with_components(
        config: DownloadConfig,
        policy: SecurityPolicy,
        handoffs: Arc<VisibleHandoffManager>,
        cookie_jar: Arc<ScopedCookieJar>,
        providers: Arc<ProviderRegistry>,
    ) -> Result<Self, DownloaderError> {
        // Disable automatic redirects so EVERY hop is validated against SSRF policy and
        // cross-origin `Cookie` / `Authorization` headers are strictly stripped!
        let mut builder = Client::builder()
            .user_agent(&config.user_agent)
            .connect_timeout(Duration::from_secs(config.timeout_secs.clamp(3, 15)))
            .redirect(redirect::Policy::none());
        if config.no_proxy {
            builder = builder.no_proxy();
        }
        let client = builder.build()?;
        Ok(Self {
            client,
            pinned_clients: Arc::new(RwLock::new(HashMap::new())),
            config,
            policy,
            handoffs,
            cookie_jar,
            providers,
        })
    }

    /// Returns a pooled HTTP client with verified DNS addresses pinned via `resolve_to_addrs`
    /// to eliminate TOCTOU DNS-rebinding windows on domain targets.
    fn client_for_pinned_target(
        &self,
        parsed: &Url,
        addrs: &[SocketAddr],
    ) -> Result<Client, DownloaderError> {
        let Some(Host::Domain(host)) = parsed.host() else {
            return Ok(self.client.clone());
        };
        let port = parsed.port_or_known_default().unwrap_or(443);
        let cache_key = (host.to_ascii_lowercase(), port);
        if let Some((cached_at, cached)) = self.pinned_clients.read().get(&cache_key) {
            if cached_at.elapsed() < Duration::from_secs(15) {
                return Ok(cached.clone());
            }
        }
        let mut builder = Client::builder()
            .user_agent(&self.config.user_agent)
            .connect_timeout(Duration::from_secs(self.config.timeout_secs.clamp(3, 15)))
            .redirect(redirect::Policy::none())
            .resolve_to_addrs(host, addrs);
        if self.config.no_proxy {
            builder = builder.no_proxy();
        }
        let built = builder.build()?;
        let mut guard = self.pinned_clients.write();
        if guard.len() > 64 {
            guard.clear();
        }
        guard.insert(cache_key, (Instant::now(), built.clone()));
        Ok(built)
    }

    /// Issues an SSRF-checked, DNS-pinned HTTP request manually following up to 10 redirects while
    /// enforcing [`SecurityPolicy`] & HTTPS downgrade refusal on every hop and stripping cross-origin credentials/cookies.
    async fn send_checked(
        &self,
        method: reqwest::Method,
        initial_url: &str,
        extra_headers: &BTreeMap<String, String>,
        range_header: Option<&str>,
        if_range_header: Option<&str>,
    ) -> Result<reqwest::Response, DownloaderError> {
        let mut current_url = PrivacyShield::sanitize_live_url(initial_url);
        let origin_parsed = Url::parse(&current_url)
            .map_err(|e| DownloaderError::InvalidInput(format!("invalid URL: {e}")))?;
        let mut prev_url: Option<Url> = None;

        for hop in 0..=10usize {
            let (parsed_cur, addrs) = validate_and_resolve_addrs(&current_url, self.policy).await?;
            let client = self.client_for_pinned_target(&parsed_cur, &addrs)?;

            let filtered =
                PrivacyShield::filter_headers_for_target(extra_headers, &origin_parsed, &parsed_cur);
            let mut hdrs = HeaderMap::new();
            hdrs.insert(
                USER_AGENT,
                HeaderValue::from_str(&self.config.user_agent)
                    .unwrap_or_else(|_| HeaderValue::from_static("OmniaDownloader/3.0")),
            );
            for (k, v) in &filtered {
                if let (Ok(name), Ok(val)) = (
                    HeaderName::from_bytes(k.as_bytes()),
                    HeaderValue::from_str(v),
                ) {
                    hdrs.insert(name, val);
                }
            }
            if let Some(cookie_val) = self
                .cookie_jar
                .cookie_header_for(&parsed_cur, prev_url.as_ref())
            {
                if let Ok(val) = HeaderValue::from_str(&cookie_val) {
                    hdrs.insert(COOKIE, val);
                }
            }
            if let Some(rng) = range_header {
                if let Ok(val) = HeaderValue::from_str(rng) {
                    hdrs.insert(RANGE, val);
                }
            }
            if let Some(ifr) = if_range_header {
                if let Ok(val) = HeaderValue::from_str(ifr) {
                    hdrs.insert(IF_RANGE, val);
                }
            }

            let resp = client
                .request(method.clone(), &current_url)
                .headers(hdrs)
                .send()
                .await?;

            // Ingest scoped `Set-Cookie` headers into RFC 6265 jar.
            for sc in resp.headers().get_all(reqwest::header::SET_COOKIE) {
                if let Ok(sc_str) = sc.to_str() {
                    self.cookie_jar.store_set_cookie(&parsed_cur, sc_str);
                }
            }

            let status = resp.status().as_u16();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                if hop == 10 {
                    return Err(DownloaderError::SecurityRejected(
                        "redirect chain exceeded maximum of 10 hops".into(),
                    ));
                }
                let loc = resp
                    .headers()
                    .get(LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| DownloaderError::HttpStatus {
                        status,
                        detail: "redirect response missing Location header".into(),
                    })?;
                let next_parsed = parsed_cur.join(loc).map_err(|e| {
                    DownloaderError::InvalidInput(format!("invalid redirect Location `{loc}`: {e}"))
                })?;
                check_redirect_https_downgrade(&parsed_cur, &next_parsed)?;
                let next_str = PrivacyShield::sanitize_live_url(next_parsed.as_str());
                // Check redirect URL immediately for /sorry/ or accounts login walls!
                let redir_gate = classify_http_response(status, &next_str, None, "");
                self.handoffs.enforce_classification(&next_str, redir_gate)?;

                prev_url = Some(parsed_cur);
                current_url = next_str;
                continue;
            }

            return Ok(resp);
        }

        Err(DownloaderError::SecurityRejected(
            "redirect limit reached".into(),
        ))
    }

    /// Probes a target URL (`HEAD` with `GET bytes=0-0` fallback) to determine size,
    /// range support, strong validators (`ETag`/`Last-Modified`), filename, and `X-Goog-Hash`.
    pub async fn probe(
        &self,
        raw_url: &str,
        extra_headers: &BTreeMap<String, String>,
    ) -> Result<ProbeInfo, DownloaderError> {
        self.policy.validate_url(raw_url)?;
        let sanitized_url = PrivacyShield::sanitize_for_receipt(raw_url);

        let head_res = self
            .send_checked(reqwest::Method::HEAD, raw_url, extra_headers, None, None)
            .await;

        let resp = match head_res {
            Ok(r) if r.status().is_success() => {
                let has_len = r.headers().contains_key(CONTENT_LENGTH);
                let has_ranges = r
                    .headers()
                    .get(ACCEPT_RANGES)
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| v.eq_ignore_ascii_case("bytes"));
                if has_len && has_ranges {
                    r
                } else {
                    // Fallback GET bytes=0-0 to discover true Range support and Content-Range total size.
                    match self
                        .send_checked(
                            reqwest::Method::GET,
                            raw_url,
                            extra_headers,
                            Some("bytes=0-0"),
                            None,
                        )
                        .await
                    {
                        Ok(r2) => r2,
                        Err(_) => r,
                    }
                }
            }
            Ok(r) if matches!(r.status().as_u16(), 401 | 403 | 429) => {
                // Inspect body via GET so challenge/ACL classifier gets full markers.
                self.send_checked(
                    reqwest::Method::GET,
                    raw_url,
                    extra_headers,
                    Some("bytes=0-0"),
                    None,
                )
                .await?
            }
            _ => {
                self.send_checked(
                    reqwest::Method::GET,
                    raw_url,
                    extra_headers,
                    Some("bytes=0-0"),
                    None,
                )
                .await?
            }
        };

        let status = resp.status().as_u16();
        let final_url = resp.url().to_string();
        let content_type = resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);

        if status == 401 || status == 403 || status == 429 {
            let body_snippet = read_bounded_snippet(resp, 8 * 1024).await;
            let gate = classify_http_response(
                status,
                &final_url,
                content_type.as_deref(),
                &body_snippet,
            );
            self.handoffs.enforce_classification(raw_url, gate)?;
            return Err(DownloaderError::HttpStatus {
                status,
                detail: format!("probe returned HTTP {status}"),
            });
        }

        if !(200..300).contains(&status) {
            return Err(DownloaderError::HttpStatus {
                status,
                detail: format!("probe failed with HTTP {status}"),
            });
        }

        let headers = resp.headers().clone();
        let supports_ranges = status == 206
            || headers
                .get(ACCEPT_RANGES)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.eq_ignore_ascii_case("bytes"));

        let total_size = headers
            .get(CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_content_range_total)
            .or_else(|| {
                headers
                    .get(CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.trim().parse::<u64>().ok())
            })
            .unwrap_or(0);

        let etag = headers
            .get(ETAG)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim().to_string());
        let last_modified = headers
            .get(LAST_MODIFIED)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim().to_string());
        let validator_strength =
            classify_http_validator(etag.as_deref(), last_modified.as_deref());

        let goog_vals: Vec<&str> = headers
            .get_all("x-goog-hash")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .collect();
        let goog_hash = parse_x_goog_hash(goog_vals);

        let suggested_raw = headers
            .get(CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .and_then(extract_content_disposition_filename)
            .or_else(|| {
                final_url
                    .split('?')
                    .next()
                    .and_then(|p| p.rsplit('/').next())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "download.bin".to_string());
        let suggested_filename =
            safe_output_filename(&suggested_raw).unwrap_or_else(|_| "download.bin".to_string());

        // Check if an HTML response on a binary probe is actually a challenge interstitial.
        if content_type
            .as_deref()
            .is_some_and(|ct| ct.to_ascii_lowercase().contains("text/html"))
        {
            let body_snippet = read_bounded_snippet(resp, 8 * 1024).await;
            let gate = classify_http_response(
                status,
                &final_url,
                content_type.as_deref(),
                &body_snippet,
            );
            self.handoffs.enforce_classification(raw_url, gate)?;
        }

        Ok(ProbeInfo {
            sanitized_url,
            total_size,
            supports_ranges,
            etag,
            last_modified,
            validator_strength,
            suggested_filename,
            content_type,
            goog_crc32c_b64: goog_hash.crc32c_b64,
            goog_md5_b64: goog_hash.md5_b64,
        })
    }

    /// Executes a complete download (multi-stream ranged with dynamic midpoint work-stealing,
    /// `200 OK` truncate fallback, `.part.meta` v2 + `OMNF` resume, SQLite persistence, and
    /// streaming SHA-256 / CRC32C verification).
    #[allow(clippy::too_many_arguments)]
    pub async fn execute_download(
        &self,
        job_id: String,
        req: DownloadRequest,
        store: Option<Arc<DownloadStore>>,
        events_tx: Option<broadcast::Sender<DownloadProgressEvent>>,
        control_rx: watch::Receiver<JobControl>,
    ) -> Result<CompletedDownload, DownloaderError> {
        self.execute_download_with_runtime(job_id, req, store, events_tx, control_rx, None, None)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn execute_download_with_runtime(
        &self,
        job_id: String,
        mut req: DownloadRequest,
        store: Option<Arc<DownloadStore>>,
        events_tx: Option<broadcast::Sender<DownloadProgressEvent>>,
        control_rx: watch::Receiver<JobControl>,
        global_limiter: Option<Arc<TokenBucketLimiter>>,
        aimd_telemetry: Option<Arc<RwLock<AimdTelemetrySnapshot>>>,
    ) -> Result<CompletedDownload, DownloaderError> {
        let created_at = current_epoch_ms();
        self.policy.validate_url(&req.url)?;
        let safe_staging = validate_safe_local_path(&req.staging_dir, req.workspace_root.as_deref())?;
        fs::create_dir_all(&safe_staging)?;

        let sanitized_url = PrivacyShield::sanitize_for_receipt(&req.url);
        let provider_id = self.providers.resolve_url(&req.url).id.clone();
        let pacing_mode = req.pacing_mode.unwrap_or(self.config.pacing_mode);
        let requested_streams = pacing_mode.effective_max_streams(
            req.streams.unwrap_or(self.config.default_streams),
        );
        let min_split = req
            .min_split_bytes
            .unwrap_or(self.config.min_split_bytes)
            .max(1);

        // Wire `drive::parse_drive_url`, Workspace export, and confirm-token extraction into execution!
        let mut parsed_drive_ref = None;
        if let Ok(dref) = parse_drive_url(&req.url) {
            if dref.kind == DriveResourceKind::Folder {
                return Err(DownloaderError::InvalidInput(
                    "Google Drive URL points to a folder; use /api/omni-drive/plan-folder to list & batch folder contents".into(),
                ));
            }
            let export_pref = match req
                .export_format
                .as_deref()
                .map(|s| s.trim().to_ascii_lowercase())
                .as_deref()
            {
                Some("pdf") => WorkspaceExportFormat::Pdf,
                Some("md" | "markdown") => WorkspaceExportFormat::Markdown,
                Some("txt" | "plain_text" | "text") => WorkspaceExportFormat::PlainText,
                Some("csv") => WorkspaceExportFormat::Csv,
                Some("svg") => WorkspaceExportFormat::Svg,
                _ => WorkspaceExportFormat::OfficeNative,
            };
            let export_kind_info = match dref.kind {
                DriveResourceKind::GoogleDoc => Some((
                    "document",
                    resolve_workspace_export("application/vnd.google-apps.document", export_pref),
                )),
                DriveResourceKind::GoogleSheet => Some((
                    "spreadsheets",
                    resolve_workspace_export("application/vnd.google-apps.spreadsheet", export_pref),
                )),
                DriveResourceKind::GoogleSlides => Some((
                    "presentation",
                    resolve_workspace_export("application/vnd.google-apps.presentation", export_pref),
                )),
                DriveResourceKind::GoogleDrawing => Some((
                    "drawings",
                    resolve_workspace_export("application/vnd.google-apps.drawing", export_pref),
                )),
                _ => None,
            };
            if let Some((seg, Some(exp))) = export_kind_info {
                let mut export_url = Url::parse(&format!(
                    "https://docs.google.com/{seg}/d/{}/export",
                    dref.file_id
                ))
                .map_err(|e| DownloaderError::InvalidInput(e.to_string()))?;
                {
                    let mut q = export_url.query_pairs_mut();
                    q.append_pair("format", &exp.extension);
                    if let Some(ref rk) = dref.resource_key {
                        q.append_pair("resourcekey", rk);
                    }
                    if let Some(au) = dref.auth_user {
                        q.append_pair("authuser", &au.to_string());
                    }
                }
                req.url = export_url.to_string();
                if req.filename.is_none() {
                    req.filename = Some(format!("drive_{}.{}", dref.file_id, exp.extension));
                }
            } else if dref.kind == DriveResourceKind::File {
                let mut uc_url = Url::parse("https://drive.google.com/uc")
                    .map_err(|e| DownloaderError::InvalidInput(e.to_string()))?;
                {
                    let mut q = uc_url.query_pairs_mut();
                    q.append_pair("id", &dref.file_id);
                    q.append_pair("export", "download");
                    if let Some(ref rk) = dref.resource_key {
                        q.append_pair("resourcekey", rk);
                    }
                    if let Some(au) = dref.auth_user {
                        q.append_pair("authuser", &au.to_string());
                    }
                }
                req.url = uc_url.to_string();
                parsed_drive_ref = Some(dref);
            }
        }

        // Fast-path manifest URLs (.m3u8 / .mpd) directly to HLS/DASH streaming execution.
        if url_looks_like_manifest(&req.url) {
            return self
                .execute_manifest_download(
                    job_id,
                    req,
                    None,
                    safe_staging,
                    sanitized_url,
                    provider_id,
                    pacing_mode,
                    requested_streams,
                    store,
                    events_tx,
                    control_rx,
                    global_limiter,
                    created_at,
                )
                .await;
        }

        // Emit probing status
        let mut probe = self.probe(&req.url, &req.headers).await?;

        // If a Google Drive public download returned an HTML virus-scan confirm prompt, extract
        // the sanctioned `drive.usercontent.google.com/download?confirm=...` URL and re-probe!
        if let Some(ref dref) = parsed_drive_ref {
            let is_html = probe
                .content_type
                .as_deref()
                .is_some_and(|ct| ct.to_ascii_lowercase().contains("text/html"));
            if is_html {
                let (_, _, html_bytes) = self
                    .fetch_guarded_bytes(&req.url, &req.headers, None, 512 * 1024)
                    .await?;
                let html = String::from_utf8_lossy(&html_bytes);
                if let Some(confirmed_url) = extract_drive_confirm_url(
                    &html,
                    &dref.file_id,
                    dref.resource_key.as_deref(),
                    &self.handoffs,
                )? {
                    req.url = confirmed_url;
                    probe = self.probe(&req.url, &req.headers).await?;
                }
            }
        }

        if content_type_is_manifest(probe.content_type.as_deref()) {
            return self
                .execute_manifest_download(
                    job_id,
                    req,
                    Some(&probe),
                    safe_staging,
                    sanitized_url,
                    provider_id,
                    pacing_mode,
                    requested_streams,
                    store,
                    events_tx,
                    control_rx,
                    global_limiter,
                    created_at,
                )
                .await;
        }

        let raw_name = req
            .filename
            .as_deref()
            .unwrap_or(&probe.suggested_filename);
        let safe_name = safe_output_filename(raw_name)?;
        let final_dest = safe_staging.join(&safe_name);
        let part_path = safe_staging.join(format!("{safe_name}.part"));
        let meta_path = part_meta_path_for(&part_path);
        let omnf_path = omnf_journal_path_for(&part_path);

        let expected_crc32c = req
            .expected_crc32c_b64
            .clone()
            .or_else(|| probe.goog_crc32c_b64.clone());

        // Attempt `.part.meta` v2 or `OMNF` binary journal interval resume if validators match!
        let mut resumed_intervals: Vec<(u64, u64)> = Vec::new();
        let mut resumed_bytes = 0u64;
        if req.resume && probe.supports_ranges && probe.total_size > 0 && part_path.exists() {
            let part_len_ok = fs::metadata(&part_path)
                .map(|m| m.len() == probe.total_size)
                .unwrap_or(false);
            if part_len_ok {
                if let Ok(prev_meta) = PartMetaV2::load(&meta_path) {
                    if prev_meta.is_compatible_for_resume(
                        &sanitized_url,
                        probe.total_size,
                        probe.etag.as_deref(),
                        probe.last_modified.as_deref(),
                    ) {
                        resumed_intervals = prev_meta.completed_ranges;
                        resumed_bytes = total_interval_bytes(&resumed_intervals);
                    }
                } else if let Ok(replayed) = OmnfJournal::replay_file(&omnf_path) {
                    let meta_proxy = PartMetaV2::new(
                        &job_id,
                        replayed.sanitized_url.as_deref().unwrap_or(""),
                        &safe_name,
                        replayed.total_size,
                        replayed.etag.clone(),
                        replayed.last_modified.clone(),
                    );
                    if meta_proxy.is_compatible_for_resume(
                        &sanitized_url,
                        probe.total_size,
                        probe.etag.as_deref(),
                        probe.last_modified.as_deref(),
                    ) {
                        resumed_intervals =
                            normalize_completed_intervals(&replayed.completed_ranges, probe.total_size);
                        resumed_bytes = total_interval_bytes(&resumed_intervals);
                    }
                }
            }
        }

        // Open pre-allocated positional writer (zero full-file RAM buffering).
        let writer = PositionalWriter::open_or_create(
            &part_path,
            probe.total_size,
            req.workspace_root.as_deref(),
        )?;

        // Seed `.part.meta` v2 & `OMNF` binary journal.
        let mut part_meta = PartMetaV2::new(
            &job_id,
            &sanitized_url,
            &safe_name,
            probe.total_size,
            probe.etag.clone(),
            probe.last_modified.clone(),
        );
        part_meta.completed_ranges = resumed_intervals.clone();
        part_meta.save_atomic(&meta_path)?;
        if resumed_bytes == 0 {
            if omnf_path.exists() {
                let _ = fs::remove_file(&omnf_path);
            }
            OmnfJournal::append_record(
                &omnf_path,
                &OmnfRecord::JobInit {
                    job_id: job_id.clone(),
                    sanitized_url: sanitized_url.clone(),
                    total_size: probe.total_size,
                    etag: probe.etag.clone(),
                    last_modified: probe.last_modified.clone(),
                },
            )?;
        }

        // Plan chunks: validate via `omnia-workspace-ops::range_downloader` when workspace_root set
        // and no prior intervals exist; otherwise plan remaining gaps safely across stream-count changes!
        let initial_chunks = if !probe.supports_ranges || probe.total_size == 0 {
            Vec::new()
        } else if !resumed_intervals.is_empty() {
            Chunker::plan_from_completed_intervals(
                probe.total_size,
                &resumed_intervals,
                requested_streams,
                min_split,
            )
        } else if let Some(ref ws_root) = req.workspace_root {
            let plan = Chunker::plan_validated_range(
                &req.url,
                probe.total_size,
                requested_streams,
                min_split,
                &safe_staging,
                ws_root,
                self.policy,
            )?;
            Chunker::chunks_from_plan(&plan)
        } else {
            Chunker::plan_initial_ranges(probe.total_size, requested_streams, min_split)
        };

        let mut job_snap = DownloadJobSnapshot {
            job_id: job_id.clone(),
            sanitized_url: sanitized_url.clone(),
            provider_id,
            destination_path: final_dest.clone(),
            part_path: part_path.clone(),
            total_bytes: probe.total_size,
            downloaded_bytes: resumed_bytes,
            status: DownloadStatus::Downloading,
            pacing_mode,
            streams: initial_chunks.len().max(1),
            etag: probe.etag.clone(),
            last_modified: probe.last_modified.clone(),
            validator_strength: probe.validator_strength,
            sha256_expected: req.expected_sha256.clone(),
            sha256_actual: None,
            crc32c_expected: expected_crc32c.clone(),
            crc32c_actual: None,
            error_code: None,
            error_message: None,
            drm_supported: DRM_SUPPORTED,
            created_at_ms: created_at,
            updated_at_ms: current_epoch_ms(),
        };
        if let Some(ref st) = store {
            st.upsert_job(&job_snap)?;
            if !initial_chunks.is_empty() {
                st.replace_segments(&job_id, &initial_chunks)?;
            }
        }

        let limiter = Arc::new(TokenBucketLimiter::new(
            req.speed_limit_bps.or(self.config.speed_limit_bps),
        ));
        let global_lim = global_limiter
            .unwrap_or_else(|| Arc::new(TokenBucketLimiter::new(None)));
        let downloaded_counter = Arc::new(AtomicU64::new(resumed_bytes));
        let start_instant = Instant::now();
        let mut fallback_to_single_stream = false;
        let mut streams_used = initial_chunks.len().max(1);

        // Execute multi-stream ranged transfer unless server lacks range support or file already 100% done.
        if probe.supports_ranges && probe.total_size > 0 {
            if !initial_chunks.is_empty() {
                let range_outcome = self
                    .run_ranged_workers(
                        &job_id,
                        &req,
                        &probe,
                        pacing_mode,
                        requested_streams,
                        min_split,
                        initial_chunks,
                        part_meta,
                        &meta_path,
                        &omnf_path,
                        writer.clone(),
                        Arc::clone(&limiter),
                        Arc::clone(&global_lim),
                        aimd_telemetry.clone(),
                        Arc::clone(&downloaded_counter),
                        start_instant,
                        store.clone(),
                        events_tx.clone(),
                        control_rx.clone(),
                    )
                    .await;

                match range_outcome {
                    Ok(used) => {
                        streams_used = used;
                    }
                    Err(RangedOutcomeError::RangeViolated200Ok) => {
                        tracing::warn!(
                            job_id = %job_id,
                            "server violated byte range with HTTP 200 OK; truncating .part and falling back to single stream"
                        );
                        fallback_to_single_stream = true;
                        streams_used = 1;
                        writer.truncate_to_zero()?;
                        downloaded_counter.store(0, Ordering::Relaxed);
                        resumed_bytes = 0;

                        let reset_meta = PartMetaV2::new(
                            &job_id,
                            &sanitized_url,
                            &safe_name,
                            probe.total_size,
                            probe.etag.clone(),
                            probe.last_modified.clone(),
                        );
                        reset_meta.save_atomic(&meta_path)?;
                        OmnfJournal::append_record(
                            &omnf_path,
                            &OmnfRecord::TruncateFallback {
                                reason: "server_returned_200_ok_on_range_request".into(),
                            },
                        )?;

                        if let Err(err) = self
                            .run_single_stream(
                                &job_id,
                                &req,
                                probe.total_size,
                                &writer,
                                &limiter,
                                &downloaded_counter,
                                start_instant,
                                &events_tx,
                                &control_rx,
                                true,
                            )
                            .await
                        {
                            Self::record_terminal_error(&store, &mut job_snap, &err);
                            emit_progress(
                                &events_tx,
                                &job_id,
                                job_snap.status,
                                downloaded_counter.load(Ordering::Relaxed),
                                probe.total_size,
                                0,
                                0,
                                Vec::new(),
                                true,
                                Some(err.error_code().to_string()),
                            );
                            return Err(err);
                        }
                    }
                    Err(RangedOutcomeError::Fatal(err)) => {
                        Self::record_terminal_error(&store, &mut job_snap, &err);
                        emit_progress(
                            &events_tx,
                            &job_id,
                            job_snap.status,
                            downloaded_counter.load(Ordering::Relaxed),
                            probe.total_size,
                            0,
                            0,
                            Vec::new(),
                            false,
                            Some(err.error_code().to_string()),
                        );
                        return Err(err);
                    }
                }
            }
        } else {
            streams_used = 1;
            if let Err(err) = self
                .run_single_stream(
                    &job_id,
                    &req,
                    probe.total_size,
                    &writer,
                    &limiter,
                    &downloaded_counter,
                    start_instant,
                    &events_tx,
                    &control_rx,
                    false,
                )
                .await
            {
                Self::record_terminal_error(&store, &mut job_snap, &err);
                return Err(err);
            }
        }

        writer.sync_all()?;

        // Streaming SHA-256 & CRC32C verification (zero full-file RAM buffering!)
        job_snap.status = DownloadStatus::Verifying;
        job_snap.updated_at_ms = current_epoch_ms();
        if let Some(ref st) = store {
            let _ = st.upsert_job(&job_snap);
        }

        let part_for_hash = part_path.clone();
        let exp_sha = req.expected_sha256.clone();
        let exp_crc = expected_crc32c.clone();
        let exp_md5 = req.expected_md5_hex.clone();
        let integrity = tokio::task::spawn_blocking(move || {
            verify_file_integrity_with_md5(
                &part_for_hash,
                exp_sha.as_deref(),
                exp_crc.as_deref(),
                exp_md5.as_deref(),
            )
        })
        .await
        .map_err(|e| DownloaderError::InvalidInput(format!("integrity task failed: {e}")))?;

        let integrity = match integrity {
            Ok(rep) => rep,
            Err(err) => {
                Self::record_terminal_error(&store, &mut job_snap, &err);
                return Err(err);
            }
        };

        let _ = OmnfJournal::append_record(
            &omnf_path,
            &OmnfRecord::ChecksumVerified {
                sha256_hex: integrity.sha256_hex.clone(),
                crc32c_b64: integrity.crc32c_b64.clone(),
            },
        );
        let _ = OmnfJournal::append_record(
            &omnf_path,
            &OmnfRecord::JobFinished {
                total_bytes: integrity.total_bytes,
            },
        );

        // Close writer handle before Windows atomic rename!
        drop(writer);
        if final_dest.exists() {
            let _ = fs::remove_file(&final_dest);
        }
        fs::rename(&part_path, &final_dest)?;
        let _ = fs::remove_file(&meta_path);
        let _ = fs::remove_file(&omnf_path);

        job_snap.status = DownloadStatus::Completed;
        job_snap.total_bytes = integrity.total_bytes;
        job_snap.downloaded_bytes = integrity.total_bytes;
        job_snap.streams = streams_used;
        job_snap.sha256_actual = Some(integrity.sha256_hex.clone());
        job_snap.crc32c_actual = Some(integrity.crc32c_b64.clone());
        job_snap.error_code = None;
        job_snap.error_message = None;
        job_snap.updated_at_ms = current_epoch_ms();
        if let Some(ref st) = store {
            st.upsert_job(&job_snap)?;
        }

        let completed_ranges = if integrity.total_bytes > 0 {
            vec![(0, integrity.total_bytes - 1)]
        } else {
            Vec::new()
        };
        emit_progress(
            &events_tx,
            &job_id,
            DownloadStatus::Completed,
            integrity.total_bytes,
            integrity.total_bytes,
            0,
            0,
            completed_ranges,
            fallback_to_single_stream,
            None,
        );

        Ok(CompletedDownload {
            job_id,
            output_path: final_dest,
            sanitized_url,
            total_bytes: integrity.total_bytes,
            sha256_hex: integrity.sha256_hex,
            crc32c_b64: integrity.crc32c_b64,
            streams_used,
            resumed_bytes,
            fallback_to_single_stream,
            drm_supported: DRM_SUPPORTED,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_ranged_workers(
        &self,
        job_id: &str,
        req: &DownloadRequest,
        probe: &ProbeInfo,
        pacing_mode: PacingMode,
        requested_streams: usize,
        min_split: u64,
        initial_chunks: Vec<ChunkRange>,
        part_meta: PartMetaV2,
        meta_path: &Path,
        omnf_path: &Path,
        writer: PositionalWriter,
        limiter: Arc<TokenBucketLimiter>,
        global_limiter: Arc<TokenBucketLimiter>,
        aimd_telemetry: Option<Arc<RwLock<AimdTelemetrySnapshot>>>,
        downloaded_counter: Arc<AtomicU64>,
        start_instant: Instant,
        store: Option<Arc<DownloadStore>>,
        events_tx: Option<broadcast::Sender<DownloadProgressEvent>>,
        control_rx: watch::Receiver<JobControl>,
    ) -> Result<usize, RangedOutcomeError> {
        let worker_count = requested_streams.min(initial_chunks.len().max(1));
        let if_range_val = part_meta.if_range_validator().map(str::to_string);

        let initial_chunk_count = initial_chunks.len();
        let shared_state = Arc::new(Mutex::new(SharedRangeState {
            chunks: initial_chunks,
            claimed: vec![false; initial_chunk_count],
            meta: part_meta,
            pending_omnf: Vec::new(),
            last_flush: None,
            controller: AimdBdpController::new(pacing_mode, requested_streams),
            max_active_chunks_seen: worker_count,
        }));
        if let Some(ref telem) = aimd_telemetry {
            let init_metrics = shared_state.lock().controller.metrics();
            let mut guard = telem.write();
            guard.active_job_id = Some(job_id.to_string());
            guard.pacing_mode = pacing_mode;
            guard.metrics = init_metrics;
            guard.active_workers = worker_count;
            guard.updated_at_ms = current_epoch_ms();
        }

        let range_violated = Arc::new(AtomicBool::new(false));
        let abort_flag = Arc::new(AtomicBool::new(false));
        let fatal_error: Arc<Mutex<Option<DownloaderError>>> = Arc::new(Mutex::new(None));
        let sidecar_io_lock: Arc<Mutex<()>> = Arc::new(Mutex::new(()));

        let mut handles = Vec::with_capacity(worker_count);
        for worker_idx in 0..worker_count {
            let client_engine_client = self.client.clone();
            let pinned_clients = Arc::clone(&self.pinned_clients);
            let config_clone = self.config.clone();
            let policy = self.policy;
            let handoffs = Arc::clone(&self.handoffs);
            let cookie_jar = Arc::clone(&self.cookie_jar);
            let providers = Arc::clone(&self.providers);
            let req_url = req.url.clone();
            let req_headers = req.headers.clone();
            let total_size = probe.total_size;
            let if_range_clone = if_range_val.clone();
            let shared = Arc::clone(&shared_state);
            let writer_ref = CoalescedDiskWriter::new(writer.clone(), DEFAULT_COALESCE_BYTES);
            let limiter_ref = Arc::clone(&limiter);
            let global_limiter_ref = Arc::clone(&global_limiter);
            let telemetry_ref = aimd_telemetry.clone();
            let counter_ref = Arc::clone(&downloaded_counter);
            let meta_path_buf = meta_path.to_path_buf();
            let omnf_path_buf = omnf_path.to_path_buf();
            let store_ref = store.clone();
            let events_ref = events_tx.clone();
            let ctrl_rx = control_rx.clone();
            let job_id_owned = job_id.to_string();
            let range_violated_ref = Arc::clone(&range_violated);
            let abort_ref = Arc::clone(&abort_flag);
            let fatal_ref = Arc::clone(&fatal_error);
            let sidecar_lock_ref = Arc::clone(&sidecar_io_lock);

            let worker_engine = DownloadEngine {
                client: client_engine_client,
                pinned_clients,
                config: config_clone,
                policy,
                handoffs,
                cookie_jar,
                providers,
            };

            let handle = tokio::spawn(async move {
                loop {
                    if abort_ref.load(Ordering::Relaxed)
                        || range_violated_ref.load(Ordering::Relaxed)
                    {
                        break;
                    }
                    match *ctrl_rx.borrow() {
                        JobControl::Pause => {
                            abort_ref.store(true, Ordering::Relaxed);
                            let mut err_guard = fatal_ref.lock();
                            err_guard.get_or_insert(DownloaderError::Paused {
                                job_id: job_id_owned.clone(),
                            });
                            break;
                        }
                        JobControl::Cancel => {
                            abort_ref.store(true, Ordering::Relaxed);
                            let mut err_guard = fatal_ref.lock();
                            err_guard.get_or_insert(DownloaderError::Cancelled {
                                job_id: job_id_owned.clone(),
                            });
                            break;
                        }
                        JobControl::Run => {}
                    }

                    // Claim next unclaimed incomplete chunk, OR steal midpoint tail if allowed!
                    let assignment: Option<(usize, u64, u64)> = {
                        let mut st = shared.lock();
                        let mut found = None;
                        // Prefer own initial slot first for locality.
                        if worker_idx < st.chunks.len()
                            && !st.claimed[worker_idx]
                            && !st.chunks[worker_idx].is_completed
                            && st.chunks[worker_idx].remaining() > 0
                        {
                            st.claimed[worker_idx] = true;
                            let c = &st.chunks[worker_idx];
                            found = Some((c.chunk_id, c.current_offset(), c.end));
                        }
                        if found.is_none() {
                            for idx in 0..st.chunks.len() {
                                if !st.claimed[idx]
                                    && !st.chunks[idx].is_completed
                                    && st.chunks[idx].remaining() > 0
                                {
                                    st.claimed[idx] = true;
                                    let c = &st.chunks[idx];
                                    found = Some((c.chunk_id, c.current_offset(), c.end));
                                    break;
                                }
                            }
                        }
                        if found.is_none() && pacing_mode.allows_work_stealing() {
                            if let Some(stolen) = Chunker::steal_midpoint(&mut st.chunks, min_split)
                            {
                                st.claimed.push(true);
                                st.max_active_chunks_seen =
                                    st.max_active_chunks_seen.max(st.chunks.len());
                                found = Some((stolen.chunk_id, stolen.start, stolen.end));
                            }
                        }
                        found
                    };

                    let Some((chunk_id, start_byte, end_byte)) = assignment else {
                        break;
                    };

                    let mut attempts = 0u32;
                    let mut cur_start = start_byte;
                    let chunk_end_target = end_byte;

                    'retry: loop {
                        if abort_ref.load(Ordering::Relaxed)
                            || range_violated_ref.load(Ordering::Relaxed)
                        {
                            break 'retry;
                        }
                        let req_started = Instant::now();
                        let range_hdr = format!("bytes={cur_start}-{chunk_end_target}");

                        let resp_res = worker_engine
                            .send_checked(
                                reqwest::Method::GET,
                                &req_url,
                                &req_headers,
                                Some(&range_hdr),
                                if_range_clone.as_deref(),
                            )
                            .await;

                        let resp = match resp_res {
                            Ok(r) => r,
                            Err(err) => {
                                if !err.is_retryable() || attempts >= worker_engine.config.max_retries
                                {
                                    abort_ref.store(true, Ordering::Relaxed);
                                    fatal_ref.lock().get_or_insert(err);
                                    break 'retry;
                                }
                                attempts += 1;
                                let backoff = {
                                    let mut st = shared.lock();
                                    let d = st.controller.on_congestion(
                                        503,
                                        None,
                                        current_epoch_ms(),
                                    );
                                    record_aimd_telemetry(
                                        &telemetry_ref,
                                        &job_id_owned,
                                        pacing_mode,
                                        worker_count,
                                        &st.controller,
                                    );
                                    d
                                };
                                sleep(backoff.min(Duration::from_secs(5))).await;
                                continue 'retry;
                            }
                        };

                        let status = resp.status().as_u16();
                        let final_url = resp.url().to_string();
                        let ct = resp
                            .headers()
                            .get(CONTENT_TYPE)
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_string);
                        let retry_after_hdr = resp
                            .headers()
                            .get(RETRY_AFTER)
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_string);

                        // Inspect 401/403/429 for zero-retry fail-closed gates FIRST!
                        if status == 401 || status == 403 || status == 429 {
                            let body_snip = read_bounded_snippet(resp, 8 * 1024).await;
                            let gate = classify_http_response(
                                status,
                                &final_url,
                                ct.as_deref(),
                                &body_snip,
                            );
                            if let Err(gate_err) =
                                worker_engine.handoffs.enforce_classification(&req_url, gate)
                            {
                                abort_ref.store(true, Ordering::Relaxed);
                                fatal_ref.lock().get_or_insert(gate_err);
                                break 'retry;
                            }
                            // Transient non-challenge 429: apply AIMD backoff + Retry-After!
                            if attempts >= worker_engine.config.max_retries {
                                abort_ref.store(true, Ordering::Relaxed);
                                fatal_ref.lock().get_or_insert(DownloaderError::HttpStatus {
                                    status,
                                    detail: "HTTP 429 retries exhausted".into(),
                                });
                                break 'retry;
                            }
                            attempts += 1;
                            let backoff = {
                                let mut st = shared.lock();
                                let d = st.controller.on_congestion(
                                    status,
                                    retry_after_hdr.as_deref(),
                                    current_epoch_ms(),
                                );
                                record_aimd_telemetry(
                                    &telemetry_ref,
                                    &job_id_owned,
                                    pacing_mode,
                                    worker_count,
                                    &st.controller,
                                );
                                d
                            };
                            sleep(backoff.min(Duration::from_secs(10))).await;
                            continue 'retry;
                        }

                        if status == 503 {
                            if attempts >= worker_engine.config.max_retries {
                                abort_ref.store(true, Ordering::Relaxed);
                                fatal_ref.lock().get_or_insert(DownloaderError::HttpStatus {
                                    status,
                                    detail: "HTTP 503 retries exhausted".into(),
                                });
                                break 'retry;
                            }
                            attempts += 1;
                            let backoff = {
                                let mut st = shared.lock();
                                let d = st.controller.on_congestion(
                                    status,
                                    retry_after_hdr.as_deref(),
                                    current_epoch_ms(),
                                );
                                record_aimd_telemetry(
                                    &telemetry_ref,
                                    &job_id_owned,
                                    pacing_mode,
                                    worker_count,
                                    &st.controller,
                                );
                                d
                            };
                            sleep(backoff.min(Duration::from_secs(10))).await;
                            continue 'retry;
                        }

                        // `200 OK` Range-violation fallback trigger!
                        if status == 200 {
                            range_violated_ref.store(true, Ordering::Relaxed);
                            abort_ref.store(true, Ordering::Relaxed);
                            break 'retry;
                        }

                        if status != 206 {
                            abort_ref.store(true, Ordering::Relaxed);
                            fatal_ref.lock().get_or_insert(DownloaderError::RangeNotSupported(status));
                            break 'retry;
                        }

                        // Validate exact Content-Range `(start, end, total)` bounds (`http.rs` guard).
                        if let Some(cr) = resp.headers().get(CONTENT_RANGE).and_then(|v| v.to_str().ok()) {
                            if let Some((cr_start, cr_end, cr_total)) = parse_content_range_bounds(cr) {
                                if cr_start != cur_start
                                    || cr_total != total_size
                                    || cr_end < cr_start
                                    || cr_end >= total_size
                                {
                                    abort_ref.store(true, Ordering::Relaxed);
                                    fatal_ref.lock().get_or_insert(DownloaderError::InvalidInput(
                                        format!(
                                            "Content-Range `{cr}` mismatched requested start={cur_start} total={total_size}"
                                        ),
                                    ));
                                    break 'retry;
                                }
                            }
                        }

                        let mut stream = resp.bytes_stream();
                        let mut chunk_bytes_received = 0u64;
                        let mut buffered_ranges: Vec<(u64, u64)> = Vec::new();

                        while let Some(item) = stream.next().await {
                            if abort_ref.load(Ordering::Relaxed)
                                || range_violated_ref.load(Ordering::Relaxed)
                            {
                                break;
                            }
                            match *ctrl_rx.borrow() {
                                JobControl::Pause => {
                                    abort_ref.store(true, Ordering::Relaxed);
                                    fatal_ref.lock().get_or_insert(DownloaderError::Paused {
                                        job_id: job_id_owned.clone(),
                                    });
                                    break;
                                }
                                JobControl::Cancel => {
                                    abort_ref.store(true, Ordering::Relaxed);
                                    fatal_ref.lock().get_or_insert(DownloaderError::Cancelled {
                                        job_id: job_id_owned.clone(),
                                    });
                                    break;
                                }
                                JobControl::Run => {}
                            }

                            let data = match item {
                                Ok(b) => b,
                                Err(net_err) => {
                                    let _ = writer_ref.flush_async().await;
                                    if !buffered_ranges.is_empty() {
                                        let mut st = shared.lock();
                                        for (bs, be) in buffered_ranges.drain(..) {
                                            st.meta.add_completed_range(bs, be);
                                            st.pending_omnf.push((bs, be));
                                        }
                                    }
                                    if attempts < worker_engine.config.max_retries {
                                        attempts += 1;
                                        let backoff = {
                                            let mut st = shared.lock();
                                            let d = st.controller.on_congestion(
                                                503,
                                                None,
                                                current_epoch_ms(),
                                            );
                                            record_aimd_telemetry(
                                                &telemetry_ref,
                                                &job_id_owned,
                                                pacing_mode,
                                                worker_count,
                                                &st.controller,
                                            );
                                            d
                                        };
                                        sleep(backoff.min(Duration::from_secs(5))).await;
                                        continue 'retry;
                                    }
                                    abort_ref.store(true, Ordering::Relaxed);
                                    fatal_ref.lock().get_or_insert(DownloaderError::Network(net_err));
                                    break 'retry;
                                }
                            };

                            if data.is_empty() {
                                continue;
                            }

                            // Step 1 (in-RAM only): clamp write to `remainingForThisChunk` and
                            // reserve `[write_offset, seg_end]` by advancing `chk.downloaded`
                            // before dropping `shared.lock()` so midpoint work-stealers can NEVER
                            // steal or overlap this slice while disk I/O runs off-executor!
                            let (write_offset, allowed, chunk_finished_now) = {
                                let mut st = shared.lock();
                                let Some(chk) =
                                    st.chunks.iter_mut().find(|c| c.chunk_id == chunk_id)
                                else {
                                    break;
                                };
                                let allowed = Chunker::clamp_write_len(chk, data.len());
                                if allowed == 0 {
                                    chk.is_completed = true;
                                    break;
                                }
                                let write_offset = chk.current_offset();
                                chk.downloaded = chk.downloaded.saturating_add(allowed as u64);
                                let done_now = chk.remaining() == 0;
                                if done_now {
                                    chk.is_completed = true;
                                }
                                cur_start = chk.current_offset();
                                (write_offset, allowed, done_now)
                            };

                            // Step 2 (user-space coalescing + off-executor blocking write): buffer contiguous writes up to 512 KiB.
                            if let Err(io_err) = writer_ref
                                .write_at_coalesced(write_offset, data.slice(..allowed))
                                .await
                            {
                                abort_ref.store(true, Ordering::Relaxed);
                                fatal_ref.lock().get_or_insert(io_err);
                                break 'retry;
                            }

                            let write_len = allowed as u64;
                            let seg_end = write_offset + write_len - 1;
                            buffered_ranges.push((write_offset, seg_end));
                            chunk_bytes_received = chunk_bytes_received.saturating_add(write_len);
                            let total_done =
                                counter_ref.fetch_add(write_len, Ordering::Relaxed) + write_len;

                            let should_flush_now = chunk_finished_now || {
                                let st = shared.lock();
                                st.last_flush
                                    .is_none_or(|t| t.elapsed() >= Duration::from_millis(250))
                            };
                            if should_flush_now {
                                if let Err(io_err) = writer_ref.flush_async().await {
                                    abort_ref.store(true, Ordering::Relaxed);
                                    fatal_ref.lock().get_or_insert(io_err);
                                    break 'retry;
                                }
                            }

                            // Step 3 (in-RAM only): record confirmed on-disk intervals after flush
                            // and prepare atomic sidecar + OMNF + SQLite updates.
                            let (completed_ranges_for_evt, flush_payload) = {
                                let mut st = shared.lock();
                                if should_flush_now {
                                    for (bs, be) in buffered_ranges.drain(..) {
                                        st.meta.add_completed_range(bs, be);
                                        st.pending_omnf.push((bs, be));
                                    }
                                    st.last_flush = Some(Instant::now());
                                    let ranges_copy = st.meta.completed_ranges.clone();
                                    let pending = std::mem::take(&mut st.pending_omnf);
                                    (
                                        ranges_copy,
                                        Some((st.meta.clone(), pending, st.chunks.clone())),
                                    )
                                } else {
                                    (st.meta.completed_ranges.clone(), None)
                                }
                            };

                            // Step 4 (off-executor blocking pool): persist `.part.meta` v2,
                            // batched `OMNF` frames, and SQLite segments without blocking Tokio!
                            if let Some((meta_snap, omnf_batch, chunks_snap)) = flush_payload {
                                let lock_clone = Arc::clone(&sidecar_lock_ref);
                                let meta_p = meta_path_buf.clone();
                                let omnf_p = omnf_path_buf.clone();
                                let store_opt = store_ref.clone();
                                let jid = job_id_owned.clone();
                                let _ = tokio::task::spawn_blocking(move || {
                                    let _io_guard = lock_clone.lock();
                                    let _ = meta_snap.save_atomic(&meta_p);
                                    for (s, e) in omnf_batch {
                                        let _ = OmnfJournal::append_record(
                                            &omnf_p,
                                            &OmnfRecord::RangeCompleted { start: s, end: e },
                                        );
                                    }
                                    if let Some(st_db) = store_opt {
                                        let _ = st_db.replace_segments(&jid, &chunks_snap);
                                    }
                                })
                                .await;
                            }

                            let elapsed_secs = start_instant.elapsed().as_secs_f64().max(0.001);
                            let speed_bps = (total_done as f64 / elapsed_secs) as u64;
                            emit_progress(
                                &events_ref,
                                &job_id_owned,
                                DownloadStatus::Downloading,
                                total_done.min(total_size),
                                total_size,
                                speed_bps,
                                worker_count,
                                completed_ranges_for_evt,
                                false,
                                None,
                            );

                            limiter_ref.acquire(write_len).await;
                            global_limiter_ref.acquire(write_len).await;
                            if pacing_mode == PacingMode::Polite
                                && worker_engine.config.polite_segment_delay_ms > 0
                            {
                                sleep(Duration::from_millis(
                                    worker_engine.config.polite_segment_delay_ms,
                                ))
                                .await;
                            }
                        }

                        // Ensure any trailing coalesced bytes for this worker slice hit disk cleanly!
                        if let Err(io_err) = writer_ref.flush_async().await {
                            abort_ref.store(true, Ordering::Relaxed);
                            fatal_ref.lock().get_or_insert(io_err);
                            break 'retry;
                        }
                        if !buffered_ranges.is_empty() {
                            let mut st = shared.lock();
                            for (bs, be) in buffered_ranges.drain(..) {
                                st.meta.add_completed_range(bs, be);
                                st.pending_omnf.push((bs, be));
                            }
                        }

                        // Check if chunk finished (or was shortened to completion via midpoint steal).
                        let finished_chunk = {
                            let mut st = shared.lock();
                            st.controller
                                .on_chunk_success(chunk_bytes_received, req_started.elapsed());
                            record_aimd_telemetry(
                                &telemetry_ref,
                                &job_id_owned,
                                pacing_mode,
                                worker_count,
                                &st.controller,
                            );
                            st.chunks
                                .iter()
                                .find(|c| c.chunk_id == chunk_id)
                                .is_none_or(|c| c.is_completed || c.remaining() == 0)
                        };
                        if finished_chunk || abort_ref.load(Ordering::Relaxed) {
                            break 'retry;
                        }
                        if attempts >= worker_engine.config.max_retries {
                            abort_ref.store(true, Ordering::Relaxed);
                            fatal_ref.lock().get_or_insert(DownloaderError::InvalidInput(
                                format!("incomplete ranged stream for chunk {chunk_id}"),
                            ));
                            break 'retry;
                        }
                        attempts += 1;
                    }
                }
            });
            handles.push(handle);
        }

        for h in handles {
            if let Err(join_err) = h.await {
                fatal_error
                    .lock()
                    .get_or_insert(DownloaderError::InvalidInput(format!(
                        "download worker join error: {join_err}"
                    )));
            }
        }

        // Guaranteed final off-executor flush of any unpersisted `.part.meta` v2, `OMNF` frames,
        // and SQLite segments (critical on pause/error/completion so zero written bytes are lost).
        let final_flush = {
            let mut st = shared_state.lock();
            if !st.pending_omnf.is_empty() || fatal_error.lock().is_some() {
                let pending = std::mem::take(&mut st.pending_omnf);
                Some((st.meta.clone(), pending, st.chunks.clone()))
            } else {
                None
            }
        };
        if let Some((meta_snap, omnf_batch, chunks_snap)) = final_flush {
            let lock_clone = Arc::clone(&sidecar_io_lock);
            let meta_p = meta_path.to_path_buf();
            let omnf_p = omnf_path.to_path_buf();
            let store_opt = store.clone();
            let jid = job_id.to_string();
            let _ = tokio::task::spawn_blocking(move || {
                let _io_guard = lock_clone.lock();
                let _ = meta_snap.save_atomic(&meta_p);
                for (s, e) in omnf_batch {
                    let _ = OmnfJournal::append_record(
                        &omnf_p,
                        &OmnfRecord::RangeCompleted { start: s, end: e },
                    );
                }
                if let Some(st_db) = store_opt {
                    let _ = st_db.replace_segments(&jid, &chunks_snap);
                }
            })
            .await;
        }

        if range_violated.load(Ordering::Relaxed) {
            return Err(RangedOutcomeError::RangeViolated200Ok);
        }
        if let Some(err) = fatal_error.lock().take() {
            return Err(RangedOutcomeError::Fatal(err));
        }

        let st = shared_state.lock();
        if st
            .chunks
            .iter()
            .any(|c| !c.is_completed || c.remaining() != 0)
        {
            return Err(RangedOutcomeError::Fatal(DownloaderError::InvalidInput(
                "ranged download ended with incomplete segments".into(),
            )));
        }
        Ok(st.max_active_chunks_seen)
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_single_stream(
        &self,
        job_id: &str,
        req: &DownloadRequest,
        expected_total: u64,
        writer: &PositionalWriter,
        limiter: &TokenBucketLimiter,
        downloaded_counter: &AtomicU64,
        start_instant: Instant,
        events_tx: &Option<broadcast::Sender<DownloadProgressEvent>>,
        control_rx: &watch::Receiver<JobControl>,
        is_fallback: bool,
    ) -> Result<(), DownloaderError> {
        let resp = self
            .send_checked(reqwest::Method::GET, &req.url, &req.headers, None, None)
            .await?;
        let status = resp.status().as_u16();
        let final_url = resp.url().to_string();
        let ct = resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);

        if status == 401 || status == 403 || status == 429 {
            let body_snip = read_bounded_snippet(resp, 8 * 1024).await;
            let gate = classify_http_response(status, &final_url, ct.as_deref(), &body_snip);
            self.handoffs.enforce_classification(&req.url, gate)?;
            return Err(DownloaderError::HttpStatus {
                status,
                detail: format!("single-stream HTTP {status}"),
            });
        }
        if !(200..300).contains(&status) {
            return Err(DownloaderError::HttpStatus {
                status,
                detail: format!("single-stream failed with HTTP {status}"),
            });
        }

        let mut offset = 0u64;
        let mut completed_ranges = Vec::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk_res) = stream.next().await {
            match *control_rx.borrow() {
                JobControl::Pause => {
                    return Err(DownloaderError::Paused {
                        job_id: job_id.to_string(),
                    });
                }
                JobControl::Cancel => {
                    return Err(DownloaderError::Cancelled {
                        job_id: job_id.to_string(),
                    });
                }
                JobControl::Run => {}
            }
            let data = chunk_res?;
            if data.is_empty() {
                continue;
            }
            let len = data.len() as u64;
            writer.write_at_async(offset, data).await?;
            record_completed_interval(
                &mut completed_ranges,
                offset,
                offset + len - 1,
                expected_total.max(offset + len),
            );
            offset = offset.saturating_add(len);
            downloaded_counter.store(offset, Ordering::Relaxed);

            let elapsed = start_instant.elapsed().as_secs_f64().max(0.001);
            emit_progress(
                events_tx,
                job_id,
                DownloadStatus::Downloading,
                offset,
                expected_total.max(offset),
                (offset as f64 / elapsed) as u64,
                1,
                completed_ranges.clone(),
                is_fallback,
                None,
            );
            limiter.acquire(len).await;
        }

        if expected_total > 0 && offset != expected_total {
            return Err(DownloaderError::InvalidInput(format!(
                "single-stream byte count mismatch: got {offset}, expected {expected_total}"
            )));
        }
        writer.set_len(offset)?;
        Ok(())
    }

    fn record_terminal_error(
        store: &Option<Arc<DownloadStore>>,
        snap: &mut DownloadJobSnapshot,
        err: &DownloaderError,
    ) {
        snap.status = match err {
            DownloaderError::Paused { .. } => DownloadStatus::Paused,
            DownloaderError::Cancelled { .. } => DownloadStatus::Cancelled,
            DownloaderError::AuthChallengeRequired { .. }
            | DownloaderError::SignInRequired { .. } => DownloadStatus::AwaitingManualHandoff,
            DownloaderError::BlockedAcl403 { .. }
            | DownloaderError::DrmUnsupported { .. }
            | DownloaderError::SecurityRejected(_)
            | DownloaderError::ForbiddenPath { .. }
            | DownloaderError::RangePolicy(_) => DownloadStatus::BlockedPolicy,
            _ => DownloadStatus::Failed,
        };
        snap.error_code = Some(err.error_code().to_string());
        snap.error_message = Some(err.to_string());
        snap.updated_at_ms = current_epoch_ms();
        if let Some(ref st) = store {
            let _ = st.upsert_job(snap);
        }
    }

    async fn fetch_guarded_bytes(
        &self,
        url: &str,
        extra_headers: &BTreeMap<String, String>,
        range_header: Option<&str>,
        max_bytes: usize,
    ) -> Result<(u16, Option<String>, Vec<u8>), DownloaderError> {
        let resp = self
            .send_checked(reqwest::Method::GET, url, extra_headers, range_header, None)
            .await?;
        let status = resp.status().as_u16();
        let ct = resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(ToString::to_string);
        let final_url = resp.url().as_str().to_string();
        let mut buf = Vec::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk_res) = stream.next().await {
            let chunk = chunk_res?;
            if buf.len().saturating_add(chunk.len()) > max_bytes {
                return Err(DownloaderError::InvalidInput(format!(
                    "manifest/segment payload exceeds {max_bytes} bytes limit"
                )));
            }
            buf.extend_from_slice(&chunk);
        }
        let preview = String::from_utf8_lossy(&buf[..buf.len().min(4096)]);
        let gate = classify_http_response(status, &final_url, ct.as_deref(), &preview);
        self.handoffs.enforce_classification(&final_url, gate)?;
        if status >= 400 {
            return Err(DownloaderError::HttpStatus {
                status,
                detail: format!("stream request returned HTTP {status}"),
            });
        }
        Ok((status, ct, buf))
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute_manifest_download(
        &self,
        job_id: String,
        req: DownloadRequest,
        probe: Option<&ProbeInfo>,
        safe_staging: PathBuf,
        sanitized_url: String,
        provider_id: String,
        pacing_mode: PacingMode,
        requested_streams: usize,
        store: Option<Arc<DownloadStore>>,
        events_tx: Option<broadcast::Sender<DownloadProgressEvent>>,
        control_rx: watch::Receiver<JobControl>,
        global_limiter: Option<Arc<TokenBucketLimiter>>,
        created_at: u64,
    ) -> Result<CompletedDownload, DownloaderError> {
        #[derive(Clone)]
        struct SegmentPlanItem {
            uri: String,
            range_hdr: Option<String>,
            aes_key: Option<(String, [u8; 16])>,
            discontinuity: bool,
        }

        let start_instant = Instant::now();
        let concurrency = match pacing_mode {
            PacingMode::Polite | PacingMode::LinearRateGuarded => 1,
            _ => requested_streams.clamp(1, 12),
        };
        let (_, ct, manifest_bytes) = self
            .fetch_guarded_bytes(&req.url, &req.headers, None, 8 * 1024 * 1024)
            .await?;
        let manifest_text = String::from_utf8_lossy(&manifest_bytes).into_owned();
        let trimmed = manifest_text.trim_start();
        let is_dash = trimmed.starts_with('<')
            || req
                .url
                .split(['?', '#'])
                .next()
                .unwrap_or(&req.url)
                .to_ascii_lowercase()
                .ends_with(".mpd")
            || ct
                .as_deref()
                .is_some_and(|c| c.to_ascii_lowercase().contains("dash+xml"));

        let default_name = if let Some(explicit) = req.filename.as_deref() {
            explicit.to_string()
        } else if let Some(p) = probe {
            let stem = p.suggested_filename.trim_end_matches(".m3u8").trim_end_matches(".mpd");
            if is_dash {
                format!("{stem}.mp4")
            } else {
                format!("{stem}.ts")
            }
        } else if is_dash {
            "stream_dash.mp4".to_string()
        } else {
            "stream_hls.ts".to_string()
        };
        let safe_name = safe_output_filename(&default_name)?;
        let mut final_dest = safe_staging.join(&safe_name);
        let part_path = safe_staging.join(format!("{safe_name}.part"));

        let mut job_snap = DownloadJobSnapshot {
            job_id: job_id.clone(),
            sanitized_url: sanitized_url.clone(),
            provider_id,
            destination_path: final_dest.clone(),
            part_path: part_path.clone(),
            total_bytes: 0,
            downloaded_bytes: 0,
            status: DownloadStatus::Downloading,
            pacing_mode,
            streams: concurrency,
            etag: probe.and_then(|p| p.etag.clone()),
            last_modified: probe.and_then(|p| p.last_modified.clone()),
            validator_strength: HttpValidatorStrength::None,
            sha256_expected: req.expected_sha256.clone(),
            sha256_actual: None,
            crc32c_expected: req.expected_crc32c_b64.clone(),
            crc32c_actual: None,
            error_code: None,
            error_message: None,
            drm_supported: DRM_SUPPORTED,
            created_at_ms: created_at,
            updated_at_ms: created_at,
        };
        if let Some(ref st) = store {
            let _ = st.upsert_job(&job_snap);
        }

        let build_hls_plan = |hls: &HlsManifest, clip_start: Option<f64>, clip_end: Option<f64>| {
            let mut items = Vec::new();
            let (slice_start, slice_end) = if clip_start.is_some() || clip_end.is_some() {
                let durs: Vec<f64> = hls.segments.iter().map(|s| s.duration_secs).collect();
                slice_segments_for_clip_range(&durs, clip_start, clip_end)
            } else {
                (0, hls.segments.len())
            };
            let mut seen_init: Option<(String, Option<crate::streaming::HlsByteRange>)> = None;
            for seg in &hls.segments[slice_start.min(hls.segments.len())..slice_end.min(hls.segments.len())] {
                let key_pair = seg.aes128_key.as_ref().map(|k| {
                    let iv = k.explicit_iv.unwrap_or_else(|| hls_sequence_iv(seg.sequence));
                    (k.uri.clone(), iv)
                });
                if let Some(init_uri) = &seg.init_map_uri {
                    let key_tag = (init_uri.clone(), seg.init_map_byte_range);
                    if seen_init.as_ref() != Some(&key_tag) {
                        let map_range = seg.init_map_byte_range.map(|r| {
                            format!("bytes={}-{}", r.offset, r.offset + r.length.saturating_sub(1))
                        });
                        items.push(SegmentPlanItem {
                            uri: init_uri.clone(),
                            range_hdr: map_range,
                            aes_key: key_pair.clone(),
                            discontinuity: false,
                        });
                        seen_init = Some(key_tag);
                    }
                }
                let range_hdr = seg
                    .byte_range
                    .map(|r| format!("bytes={}-{}", r.offset, r.offset + r.length.saturating_sub(1)));
                items.push(SegmentPlanItem {
                    uri: seg.uri.clone(),
                    range_hdr,
                    aes_key: key_pair,
                    discontinuity: seg.discontinuity,
                });
            }
            items
        };

        let build_dash_plan = |rep: &crate::streaming::DashRepresentation,
                               clip_start: Option<f64>,
                               clip_end: Option<f64>| {
            let mut items = Vec::new();
            if let Some(ref single) = rep.single_file_uri {
                items.push(SegmentPlanItem {
                    uri: single.clone(),
                    range_hdr: None,
                    aes_key: None,
                    discontinuity: false,
                });
                return items;
            }
            if let Some(init_uri) = &rep.init_uri {
                items.push(SegmentPlanItem {
                    uri: init_uri.clone(),
                    range_hdr: None,
                    aes_key: None,
                    discontinuity: false,
                });
            }
            let timescale = rep.timescale.unwrap_or(1).max(1) as f64;
            let (slice_start, slice_end) = if clip_start.is_some() || clip_end.is_some() {
                let durs: Vec<f64> = rep
                    .segments
                    .iter()
                    .map(|s| s.duration.unwrap_or(0) as f64 / timescale)
                    .collect();
                slice_segments_for_clip_range(&durs, clip_start, clip_end)
            } else {
                (0, rep.segments.len())
            };
            for seg in &rep.segments[slice_start.min(rep.segments.len())..slice_end.min(rep.segments.len())] {
                let range_hdr = seg
                    .byte_range
                    .map(|r| format!("bytes={}-{}", r.offset, r.offset + r.length.saturating_sub(1)));
                items.push(SegmentPlanItem {
                    uri: seg.uri.clone(),
                    range_hdr,
                    aes_key: None,
                    discontinuity: false,
                });
            }
            items
        };

        let (video_plan, audio_plan): (Vec<SegmentPlanItem>, Vec<SegmentPlanItem>) = if is_dash {
            let dash: DashManifest = parse_dash_manifest(&manifest_text, &req.url)?;
            dash.enforce_no_drm()?;
            let (video_rep_opt, audio_rep_opt) = select_dash_tracks(&dash, StreamQuality::Best);
            let v_rep = video_rep_opt
                .or(audio_rep_opt)
                .ok_or_else(|| DownloaderError::InvalidInput("DASH manifest contains no playable representations".into()))?;
            let v_items = build_dash_plan(v_rep, req.clip_start_sec, req.clip_end_sec);
            let a_items = match audio_rep_opt {
                Some(a_rep) if !std::ptr::eq(a_rep, v_rep) => {
                    build_dash_plan(a_rep, req.clip_start_sec, req.clip_end_sec)
                }
                _ => Vec::new(),
            };
            (v_items, a_items)
        } else {
            let mut hls: HlsManifest = parse_hls_manifest(&manifest_text, &req.url)?;
            hls.enforce_no_drm()?;
            let mut audio_items = Vec::new();
            if hls.is_master {
                let best = select_hls_variant(&hls, StreamQuality::Best).ok_or_else(|| {
                    DownloaderError::InvalidInput("HLS master playlist contains no variants".into())
                })?;
                if let Some(aud_rend) = hls_audio_rendition_for(&hls, best) {
                    if let Some(ref aud_uri) = aud_rend.uri {
                        let (_, _, aud_bytes) = self
                            .fetch_guarded_bytes(aud_uri, &req.headers, None, 8 * 1024 * 1024)
                            .await?;
                        let aud_text = String::from_utf8_lossy(&aud_bytes);
                        let aud_hls = parse_hls_manifest(&aud_text, aud_uri)?;
                        aud_hls.enforce_no_drm()?;
                        audio_items = build_hls_plan(&aud_hls, req.clip_start_sec, req.clip_end_sec);
                    }
                }
                let (_, _, sub_bytes) = self
                    .fetch_guarded_bytes(&best.uri, &req.headers, None, 8 * 1024 * 1024)
                    .await?;
                let sub_text = String::from_utf8_lossy(&sub_bytes);
                hls = parse_hls_manifest(&sub_text, &best.uri)?;
                hls.enforce_no_drm()?;
            }
            let v_items = build_hls_plan(&hls, req.clip_start_sec, req.clip_end_sec);
            (v_items, audio_items)
        };

        if video_plan.is_empty() {
            let err = DownloaderError::InvalidInput("streaming manifest contained 0 media segments".into());
            Self::record_terminal_error(&store, &mut job_snap, &err);
            return Err(err);
        }

        let seg_count = video_plan.len() + audio_plan.len();
        let mut seg_rows: Vec<ChunkRange> = (0..seg_count)
            .map(|i| ChunkRange::new(i, i as u64, i as u64))
            .collect();
        if let Some(ref st) = store {
            let _ = st.replace_segments(&job_id, &seg_rows);
        }

        let limiter = Arc::new(TokenBucketLimiter::new(
            req.speed_limit_bps.or(self.config.speed_limit_bps),
        ));
        let global_lim = global_limiter
            .unwrap_or_else(|| Arc::new(TokenBucketLimiter::new(None)));
        let shared_downloaded = Arc::new(AtomicU64::new(0));
        let completed_count = Arc::new(AtomicU64::new(0));
        let key_cache: Arc<tokio::sync::Mutex<HashMap<String, [u8; 16]>>> =
            Arc::new(tokio::sync::Mutex::new(HashMap::new()));

        let has_separate_audio = !audio_plan.is_empty();
        let audio_part_path = safe_staging.join(format!("{safe_name}.audio.part"));

        let fetch_track_to_file = |items: Vec<SegmentPlanItem>, out_path: PathBuf, seg_idx_offset: usize| {
            let worker = Arc::new(DownloadEngine {
                client: self.client.clone(),
                pinned_clients: Arc::clone(&self.pinned_clients),
                config: self.config.clone(),
                policy: self.policy,
                handoffs: Arc::clone(&self.handoffs),
                cookie_jar: Arc::clone(&self.cookie_jar),
                providers: Arc::clone(&self.providers),
            });
            let hdrs = Arc::new(req.headers.clone());
            let ctrl = control_rx.clone();
            let lim = Arc::clone(&limiter);
            let glim = Arc::clone(&global_lim);
            let kcache = Arc::clone(&key_cache);
            let dl_bytes = Arc::clone(&shared_downloaded);
            let done_cnt = Arc::clone(&completed_count);
            let ev_tx = events_tx.clone();
            let jid = Arc::new(job_id.clone());

            async move {
                let jid_loop = Arc::clone(&jid);
                let jid_ref = jid_loop.as_str();

                // `.buffered(concurrency)` downloads up to `concurrency` segments in parallel
                // while yielding decrypted buffers strictly in index order `0..N`!
                let mut stream = futures_util::stream::iter(items.into_iter().enumerate().map(
                    move |(local_idx, item)| {
                        let worker_item = Arc::clone(&worker);
                        let hdrs_item = Arc::clone(&hdrs);
                        let kcache_item = Arc::clone(&kcache);
                        let lim_item = Arc::clone(&lim);
                        let glim_item = Arc::clone(&glim);
                        let ctrl_item = ctrl.clone();
                        let jid_item = Arc::clone(&jid);
                        async move {
                            match *ctrl_item.borrow() {
                                JobControl::Pause => {
                                    return Err(DownloaderError::Paused {
                                        job_id: jid_item.as_ref().clone(),
                                    });
                                }
                                JobControl::Cancel => {
                                    return Err(DownloaderError::Cancelled {
                                        job_id: jid_item.as_ref().clone(),
                                    });
                                }
                                JobControl::Run => {}
                            }
                            let (_, _, raw_seg) = worker_item
                                .fetch_guarded_bytes(
                                    &item.uri,
                                    hdrs_item.as_ref(),
                                    item.range_hdr.as_deref(),
                                    64 * 1024 * 1024,
                                )
                                .await?;

                            let plain = if let Some((ref key_uri, iv)) = item.aes_key {
                                let cached_opt = kcache_item.lock().await.get(key_uri).copied();
                                let key = match cached_opt {
                                    Some(k) => k,
                                    None => {
                                        let (_, _, key_bytes) = worker_item
                                            .fetch_guarded_bytes(
                                                key_uri,
                                                hdrs_item.as_ref(),
                                                None,
                                                1024,
                                            )
                                            .await?;
                                        if key_bytes.len() != 16 {
                                            return Err(DownloaderError::InvalidInput(format!(
                                                "HLS AES-128 key must be 16 bytes, got {}",
                                                key_bytes.len()
                                            )));
                                        }
                                        let mut arr = [0u8; 16];
                                        arr.copy_from_slice(&key_bytes);
                                        kcache_item.lock().await.insert(key_uri.clone(), arr);
                                        arr
                                    }
                                };
                                decrypt_hls_aes128_cbc(&raw_seg, &key, &iv)?
                            } else {
                                raw_seg
                            };
                            let n = plain.len() as u64;
                            lim_item.acquire(n).await;
                            glim_item.acquire(n).await;
                            Ok::<_, DownloaderError>((local_idx + seg_idx_offset, item.discontinuity, plain))
                        }
                    },
                ))
                .buffered(concurrency);

                let mut out_file = File::create(&out_path)?;
                let mut track_ranges = Vec::new();
                let mut track_offset = 0u64;
                let mut last_tfdt: Option<u64> = None;

                while let Some(seg_res) = stream.next().await {
                    let (global_idx, is_disc, plain_seg) = seg_res?;
                    if is_disc {
                        let tfdts = extract_moof_tfdt_timestamps(&plain_seg);
                        if let Some(&(_, first_dts)) = tfdts.first() {
                            if last_tfdt.is_some_and(|prev| first_dts < prev) {
                                tracing::info!(
                                    job_id = %jid_ref,
                                    segment_idx = global_idx,
                                    prev_tfdt = ?last_tfdt,
                                    new_tfdt = first_dts,
                                    "HLS EXT-X-DISCONTINUITY fMP4 tfdt reset detected"
                                );
                            }
                            last_tfdt = Some(first_dts);
                        }
                    }
                    out_file.write_all(&plain_seg)?;
                    let seg_len = plain_seg.len() as u64;
                    let total_now = dl_bytes.fetch_add(seg_len, Ordering::Relaxed) + seg_len;
                    let done_segs = done_cnt.fetch_add(1, Ordering::Relaxed) + 1;
                    let est_total =
                        ((total_now * (seg_count as u64)) / done_segs.max(1)).max(total_now);
                    if seg_len > 0 {
                        record_completed_interval(
                            &mut track_ranges,
                            track_offset,
                            track_offset + seg_len - 1,
                            est_total.max(track_offset + seg_len),
                        );
                    }
                    track_offset = track_offset.saturating_add(seg_len);

                    let elapsed = start_instant.elapsed().as_secs_f64().max(0.001);
                    emit_progress(
                        &ev_tx,
                        jid_ref,
                        DownloadStatus::Downloading,
                        total_now,
                        est_total,
                        (total_now as f64 / elapsed) as u64,
                        concurrency,
                        track_ranges.clone(),
                        false,
                        None,
                    );
                }
                out_file.sync_all()?;
                Ok::<_, DownloaderError>((track_offset, track_ranges))
            }
        };

        let video_count = video_plan.len();
        let track_res = if has_separate_audio {
            tokio::try_join!(
                fetch_track_to_file(video_plan, part_path.clone(), 0),
                fetch_track_to_file(audio_plan, audio_part_path.clone(), video_count)
            )
        } else {
            fetch_track_to_file(video_plan, part_path.clone(), 0)
                .await
                .map(|r| (r, (0, Vec::new())))
        };

        let ((_, mut completed_ranges), _) = match track_res {
            Ok(ok) => ok,
            Err(err) => {
                Self::record_terminal_error(&store, &mut job_snap, &err);
                return Err(err);
            }
        };

        for row in &mut seg_rows {
            row.is_completed = true;
            row.downloaded = 1;
        }
        if let Some(ref st) = store {
            let _ = st.replace_segments(&job_id, &seg_rows);
        }

        // Auto-wire FFmpeg `-c copy` when combining dual video+audio tracks OR explicit clip range!
        let needs_mux_or_clip = has_separate_audio
            || req.clip_start_sec.is_some()
            || req.clip_end_sec.is_some();
        if needs_mux_or_clip {
            let mux_dest = if final_dest
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("ts"))
            {
                final_dest.with_extension("mp4")
            } else {
                final_dest.clone()
            };
            let mux_req = MediaMuxRequest {
                video_input: part_path.clone(),
                audio_input: has_separate_audio.then(|| audio_part_path.clone()),
                subtitle_input: None,
                subtitle_lang: None,
                output_path: mux_dest.clone(),
                clip_in_secs: req.clip_start_sec,
                clip_out_secs: req.clip_end_sec,
                workspace_root: req.workspace_root.clone(),
                verify_with_ffprobe: false,
                timeout_secs: Some(180),
            };
            match mux_or_skip_if_missing_cancellable(mux_req, Some(control_rx.clone())).await {
                Ok(outcome) => {
                    if !outcome.mux_skipped {
                        let _ = fs::remove_file(&part_path);
                        if has_separate_audio {
                            let _ = fs::remove_file(&audio_part_path);
                        }
                        if outcome.output_path != final_dest {
                            if final_dest.exists() {
                                let _ = fs::remove_file(&final_dest);
                            }
                            final_dest = outcome.output_path;
                            job_snap.destination_path = final_dest.clone();
                        }
                    } else {
                        // Graceful MuxSkipped fallback: finalize video file cleanly while retaining audio track side-by-side!
                        if final_dest.exists() {
                            let _ = fs::remove_file(&final_dest);
                        }
                        fs::rename(&part_path, &final_dest)?;
                    }
                }
                Err(err) => {
                    Self::record_terminal_error(&store, &mut job_snap, &err);
                    return Err(err);
                }
            }
        } else {
            if final_dest.exists() {
                let _ = fs::remove_file(&final_dest);
            }
            fs::rename(&part_path, &final_dest)?;
        }

        job_snap.status = DownloadStatus::Verifying;
        job_snap.updated_at_ms = current_epoch_ms();
        if let Some(ref st) = store {
            let _ = st.upsert_job(&job_snap);
        }

        let dest_for_hash = final_dest.clone();
        let exp_sha = req.expected_sha256.clone();
        let exp_crc = req.expected_crc32c_b64.clone();
        let exp_md5 = req.expected_md5_hex.clone();
        let integrity = tokio::task::spawn_blocking(move || {
            verify_file_integrity_with_md5(
                &dest_for_hash,
                exp_sha.as_deref(),
                exp_crc.as_deref(),
                exp_md5.as_deref(),
            )
        })
        .await
        .map_err(|e| DownloaderError::InvalidInput(format!("integrity task failed: {e}")))?
        .inspect_err(|err| Self::record_terminal_error(&store, &mut job_snap, err))?;

        if completed_ranges.is_empty() && integrity.total_bytes > 0 {
            completed_ranges.push((0, integrity.total_bytes - 1));
        }

        job_snap.status = DownloadStatus::Completed;
        job_snap.total_bytes = integrity.total_bytes;
        job_snap.downloaded_bytes = integrity.total_bytes;
        job_snap.streams = concurrency;
        job_snap.sha256_actual = Some(integrity.sha256_hex.clone());
        job_snap.crc32c_actual = Some(integrity.crc32c_b64.clone());
        job_snap.error_code = None;
        job_snap.error_message = None;
        job_snap.updated_at_ms = current_epoch_ms();
        if let Some(ref st) = store {
            let _ = st.upsert_job(&job_snap);
        }
        emit_progress(
            &events_tx,
            &job_id,
            DownloadStatus::Completed,
            integrity.total_bytes,
            integrity.total_bytes,
            0,
            0,
            completed_ranges,
            false,
            None,
        );

        Ok(CompletedDownload {
            job_id,
            output_path: final_dest,
            sanitized_url,
            total_bytes: integrity.total_bytes,
            sha256_hex: integrity.sha256_hex,
            crc32c_b64: integrity.crc32c_b64,
            streams_used: concurrency,
            resumed_bytes: 0,
            fallback_to_single_stream: false,
            drm_supported: DRM_SUPPORTED,
        })
    }
}

fn url_looks_like_manifest(raw_url: &str) -> bool {
    let base = raw_url
        .split(['?', '#'])
        .next()
        .unwrap_or(raw_url)
        .to_ascii_lowercase();
    base.ends_with(".m3u8") || base.ends_with(".mpd")
}

fn content_type_is_manifest(ct: Option<&str>) -> bool {
    let Some(raw) = ct else {
        return false;
    };
    let low = raw.to_ascii_lowercase();
    low.contains("mpegurl") || low.contains("dash+xml")
}

struct SharedRangeState {
    chunks: Vec<ChunkRange>,
    claimed: Vec<bool>,
    meta: PartMetaV2,
    pending_omnf: Vec<(u64, u64)>,
    last_flush: Option<Instant>,
    controller: AimdBdpController,
    max_active_chunks_seen: usize,
}

enum RangedOutcomeError {
    RangeViolated200Ok,
    Fatal(DownloaderError),
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    events_tx: &Option<broadcast::Sender<DownloadProgressEvent>>,
    job_id: &str,
    status: DownloadStatus,
    downloaded_bytes: u64,
    total_bytes: u64,
    speed_bps: u64,
    active_streams: usize,
    completed_ranges: Vec<(u64, u64)>,
    fallback_to_single_stream: bool,
    error_code: Option<String>,
) {
    let Some(tx) = events_tx else {
        return;
    };
    let eta_secs = if speed_bps > 0 && total_bytes > downloaded_bytes {
        Some((total_bytes - downloaded_bytes) / speed_bps)
    } else {
        None
    };
    let _ = tx.send(DownloadProgressEvent {
        job_id: job_id.to_string(),
        status,
        downloaded_bytes,
        total_bytes,
        speed_bps,
        active_streams,
        eta_secs,
        completed_ranges,
        fallback_to_single_stream,
        error_code,
        timestamp_ms: current_epoch_ms(),
    });
}

async fn read_bounded_snippet(resp: reqwest::Response, max_bytes: usize) -> String {
    let mut out = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(Ok(chunk)) = stream.next().await {
        let take = (max_bytes.saturating_sub(out.len())).min(chunk.len());
        out.extend_from_slice(&chunk[..take]);
        if out.len() >= max_bytes {
            break;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_content_range_total(header: &str) -> Option<u64> {
    let (_, total_str) = header.trim().rsplit_once('/')?;
    if total_str.trim() == "*" {
        return None;
    }
    total_str.trim().parse::<u64>().ok()
}

fn parse_content_range_bounds(header: &str) -> Option<(u64, u64, u64)> {
    let rest = header.trim().strip_prefix("bytes ")?;
    let (range_part, total_part) = rest.split_once('/')?;
    let (start_s, end_s) = range_part.split_once('-')?;
    Some((
        start_s.trim().parse::<u64>().ok()?,
        end_s.trim().parse::<u64>().ok()?,
        total_part.trim().parse::<u64>().ok()?,
    ))
}

fn split_header_params_quote_safe(header: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let bytes = header.as_bytes();
    let mut start = 0usize;
    let mut in_quotes = false;
    let mut escaped = false;
    for (idx, &b) in bytes.iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if b == b'\\' && in_quotes {
            escaped = true;
            continue;
        }
        if b == b'"' {
            in_quotes = !in_quotes;
            continue;
        }
        if b == b';' && !in_quotes {
            parts.push(&header[start..idx]);
            start = idx + 1;
        }
    }
    if start <= header.len() {
        parts.push(&header[start..]);
    }
    parts
}

fn unquote_disposition_value(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(inner) = trimmed.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                if let Some(next_c) = chars.next() {
                    out.push(next_c);
                }
            } else {
                out.push(c);
            }
        }
        out
    } else {
        trimmed.to_string()
    }
}

fn record_aimd_telemetry(
    telemetry_ref: &Option<Arc<RwLock<AimdTelemetrySnapshot>>>,
    job_id: &str,
    pacing_mode: PacingMode,
    worker_count: usize,
    controller: &AimdBdpController,
) {
    if let Some(telem) = telemetry_ref {
        let mut tg = telem.write();
        tg.active_job_id = Some(job_id.to_string());
        tg.pacing_mode = pacing_mode;
        tg.metrics = controller.metrics();
        tg.active_workers = worker_count;
        tg.sample_count = tg.sample_count.saturating_add(1);
        tg.updated_at_ms = current_epoch_ms();
    }
}

fn decode_rfc5987_ext_value(ext_val: &str) -> String {
    if let Some((charset_lang, encoded)) = ext_val.split_once("''") {
        let charset = charset_lang
            .split('\'')
            .next()
            .unwrap_or("utf-8")
            .trim()
            .to_ascii_lowercase();
        let bytes = percent_decode_bytes(encoded.trim_matches('"'));
        if charset == "iso-8859-1" || charset == "latin1" || charset == "latin-1" {
            return bytes.into_iter().map(char::from).collect();
        }
        return String::from_utf8_lossy(&bytes).into_owned();
    }
    percent_decode_basic(ext_val.trim_matches('"'))
}

fn extract_content_disposition_filename(header: &str) -> Option<String> {
    let mut fallback_filename: Option<String> = None;
    for part in split_header_params_quote_safe(header) {
        let trimmed = part.trim();
        let Some((k_raw, v_raw)) = trimmed.split_once('=') else {
            continue;
        };
        let key_low = k_raw.trim().to_ascii_lowercase();
        if key_low == "filename*" {
            let decoded = decode_rfc5987_ext_value(v_raw.trim());
            if !decoded.is_empty() {
                return Some(decoded);
            }
        } else if key_low == "filename" && fallback_filename.is_none() {
            let val = unquote_disposition_value(v_raw);
            if !val.is_empty() {
                fallback_filename = Some(val);
            }
        }
    }
    fallback_filename
}

fn percent_decode_bytes(input: &str) -> Vec<u8> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn percent_decode_basic(input: &str) -> String {
    String::from_utf8_lossy(&percent_decode_bytes(input)).into_owned()
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// High-level Wave 3 Studio & CLI download manager owning persistent SQLite storage,
/// live SSE progress broadcast, pause/resume/cancel handles, `VisibleHandoffManager`,
/// `ProviderRegistry`, `ScopedCookieJar`, global bandwidth limiter, live AIMD telemetry, and `DownloadScheduler`.
pub struct DownloadManager {
    engine: Arc<DownloadEngine>,
    store: Arc<DownloadStore>,
    handoffs: Arc<VisibleHandoffManager>,
    cookie_jar: Arc<ScopedCookieJar>,
    providers: Arc<ProviderRegistry>,
    cas: Arc<ContentAddressableBlobStore>,
    scheduler: Arc<Mutex<DownloadScheduler>>,
    global_limiter: Arc<TokenBucketLimiter>,
    aimd_telemetry: Arc<RwLock<AimdTelemetrySnapshot>>,
    controls: Arc<RwLock<HashMap<String, watch::Sender<JobControl>>>>,
    events_tx: broadcast::Sender<DownloadProgressEvent>,
}

impl DownloadManager {
    /// Creates a persistent [`DownloadManager`] backed by an external `omnia-winsqlite` DB.
    pub fn open(
        db_path: &Path,
        workspace_root: Option<&Path>,
        config: DownloadConfig,
    ) -> Result<Self, DownloaderError> {
        let store = Arc::new(DownloadStore::open(db_path, workspace_root)?);
        Self::build(store, config, SecurityPolicy::strict())
    }

    /// Creates an in-memory [`DownloadManager`] (no SQLite file on disk).
    pub fn in_memory(config: DownloadConfig) -> Result<Self, DownloaderError> {
        let store = Arc::new(DownloadStore::open_in_memory()?);
        Self::build(store, config, SecurityPolicy::strict())
    }

    /// Test-only in-memory [`DownloadManager`] allowing loopback mock HTTP servers.
    #[cfg(test)]
    pub fn in_memory_for_tests(mut config: DownloadConfig) -> Result<Self, DownloaderError> {
        config.no_proxy = true;
        let store = Arc::new(DownloadStore::open_in_memory()?);
        Self::build(store, config, SecurityPolicy::allow_loopback_for_tests())
    }

    fn build(
        store: Arc<DownloadStore>,
        config: DownloadConfig,
        policy: SecurityPolicy,
    ) -> Result<Self, DownloaderError> {
        let handoffs = Arc::new(VisibleHandoffManager::new());
        let cookie_jar = Arc::new(ScopedCookieJar::new());
        let providers = Arc::new(ProviderRegistry::new());
        let cas = Arc::new(ContentAddressableBlobStore::in_memory());
        let global_limiter = Arc::new(TokenBucketLimiter::new(config.speed_limit_bps));
        let aimd_telemetry = Arc::new(RwLock::new(AimdTelemetrySnapshot {
            pacing_mode: config.pacing_mode,
            metrics: AimdBdpController::new(config.pacing_mode, config.default_streams).metrics(),
            ..AimdTelemetrySnapshot::default()
        }));
        let loaded_sched_cfg = store.load_scheduler_config().ok().flatten().unwrap_or_default();
        let engine = Arc::new(DownloadEngine::with_components(
            config,
            policy,
            Arc::clone(&handoffs),
            Arc::clone(&cookie_jar),
            Arc::clone(&providers),
        )?);
        let (events_tx, _) = broadcast::channel(512);
        Ok(Self {
            engine,
            store,
            handoffs,
            cookie_jar,
            providers,
            cas,
            scheduler: Arc::new(Mutex::new(DownloadScheduler::new(loaded_sched_cfg))),
            global_limiter,
            aimd_telemetry,
            controls: Arc::new(RwLock::new(HashMap::new())),
            events_tx,
        })
    }

    /// Subscribes to live [`DownloadProgressEvent`] notifications (for Studio SSE `/api/downloads/events`).
    #[must_use]
    pub fn subscribe_events(&self) -> broadcast::Receiver<DownloadProgressEvent> {
        self.events_tx.subscribe()
    }

    /// Returns the live [`AimdTelemetrySnapshot`] updated by active/recent ranged workers.
    #[must_use]
    pub fn live_aimd_telemetry(&self) -> AimdTelemetrySnapshot {
        self.aimd_telemetry.read().clone()
    }

    /// Dynamically sets or clears the global cross-job bandwidth cap (`bytes/sec`).
    pub fn set_global_speed_limit_bps(&self, rate_bps: Option<u64>) {
        self.global_limiter.set_rate_bps(rate_bps);
    }

    /// Returns the currently active global cross-job bandwidth cap (`bytes/sec`), if set.
    #[must_use]
    pub fn global_speed_limit_bps(&self) -> Option<u64> {
        self.global_limiter.rate_bps()
    }

    /// Exposes the persistent [`DownloadStore`] for SQLite scheduler & site-policy synchronization.
    #[must_use]
    pub fn store(&self) -> &Arc<DownloadStore> {
        &self.store
    }

    /// Probes a URL without writing files to disk (`/api/downloads/plan`).
    pub async fn probe_url(
        &self,
        url: &str,
        headers: &BTreeMap<String, String>,
    ) -> Result<ProbeInfo, DownloaderError> {
        self.engine.probe(url, headers).await
    }

    /// Executes a download synchronously to completion, returning its verified receipt.
    pub async fn download_now(
        &self,
        req: DownloadRequest,
    ) -> Result<CompletedDownload, DownloaderError> {
        let job_id = uuid_v4();
        self.download_with_job_id(job_id, req).await
    }

    /// Executes a download under an explicit `job_id` (useful when resuming a known job).
    pub async fn download_with_job_id(
        &self,
        job_id: String,
        req: DownloadRequest,
    ) -> Result<CompletedDownload, DownloaderError> {
        let (ctrl_tx, ctrl_rx) = watch::channel(JobControl::Run);
        self.controls.write().insert(job_id.clone(), ctrl_tx);
        let result = self
            .engine
            .execute_download_with_runtime(
                job_id.clone(),
                req,
                Some(Arc::clone(&self.store)),
                Some(self.events_tx.clone()),
                ctrl_rx,
                Some(Arc::clone(&self.global_limiter)),
                Some(Arc::clone(&self.aimd_telemetry)),
            )
            .await;
        self.controls.write().remove(&job_id);
        result
    }

    /// Spawns a background download task and immediately returns `(job_id, JoinHandle)`.
    pub fn spawn_download(
        &self,
        req: DownloadRequest,
    ) -> (
        String,
        tokio::task::JoinHandle<Result<CompletedDownload, DownloaderError>>,
    ) {
        let job_id = uuid_v4();
        let created_at = current_epoch_ms();
        let pacing_mode = req.pacing_mode.unwrap_or(self.engine.config.pacing_mode);
        let requested_streams = pacing_mode.effective_max_streams(
            req.streams.unwrap_or(self.engine.config.default_streams),
        );
        let placeholder_name = req
            .filename
            .as_deref()
            .and_then(|n| safe_output_filename(n).ok())
            .unwrap_or_else(|| "pending.download".to_string());
        let initial_snap = DownloadJobSnapshot {
            job_id: job_id.clone(),
            sanitized_url: PrivacyShield::sanitize_for_receipt(&req.url),
            provider_id: self.engine.providers.resolve_url(&req.url).id.clone(),
            destination_path: req.staging_dir.join(&placeholder_name),
            part_path: req.staging_dir.join(format!("{placeholder_name}.part")),
            total_bytes: 0,
            downloaded_bytes: 0,
            status: DownloadStatus::Queued,
            pacing_mode,
            streams: requested_streams,
            etag: None,
            last_modified: None,
            validator_strength: HttpValidatorStrength::None,
            sha256_expected: req.expected_sha256.clone(),
            sha256_actual: None,
            crc32c_expected: req.expected_crc32c_b64.clone(),
            crc32c_actual: None,
            error_code: None,
            error_message: None,
            drm_supported: DRM_SUPPORTED,
            created_at_ms: created_at,
            updated_at_ms: created_at,
        };
        let _ = self.store.upsert_job(&initial_snap);

        let (ctrl_tx, ctrl_rx) = watch::channel(JobControl::Run);
        self.controls.write().insert(job_id.clone(), ctrl_tx);

        let engine = Arc::clone(&self.engine);
        let store = Arc::clone(&self.store);
        let events_tx = self.events_tx.clone();
        let global_limiter = Arc::clone(&self.global_limiter);
        let aimd_telemetry = Arc::clone(&self.aimd_telemetry);
        let controls = Arc::clone(&self.controls);
        let id_clone = job_id.clone();

        let handle = tokio::spawn(async move {
            let res = engine
                .execute_download_with_runtime(
                    id_clone.clone(),
                    req,
                    Some(Arc::clone(&store)),
                    Some(events_tx),
                    ctrl_rx,
                    Some(global_limiter),
                    Some(aimd_telemetry),
                )
                .await;
            if let Err(ref err) = res {
                if let Ok(Some(mut snap)) = store.get_job(&id_clone) {
                    if matches!(snap.status, DownloadStatus::Queued | DownloadStatus::Probing) {
                        DownloadEngine::record_terminal_error(&Some(store), &mut snap, err);
                    }
                }
            }
            controls.write().remove(&id_clone);
            res
        });

        (job_id, handle)
    }

    /// Signals a running job to pause cleanly after flushing `.part.meta` v2 & `OMNF`.
    pub fn pause_job(&self, job_id: &str) -> Result<(), DownloaderError> {
        let controls = self.controls.read();
        let tx = controls
            .get(job_id)
            .ok_or_else(|| DownloaderError::JobNotFound(job_id.to_string()))?;
        let _ = tx.send(JobControl::Pause);
        Ok(())
    }

    /// Signals a running job to cancel cleanly.
    pub fn cancel_job(&self, job_id: &str) -> Result<(), DownloaderError> {
        let controls = self.controls.read();
        let tx = controls
            .get(job_id)
            .ok_or_else(|| DownloaderError::JobNotFound(job_id.to_string()))?;
        let _ = tx.send(JobControl::Cancel);
        Ok(())
    }

    /// Returns a persisted job snapshot from `omnia-winsqlite`.
    pub fn get_job(&self, job_id: &str) -> Result<Option<DownloadJobSnapshot>, DownloaderError> {
        self.store.get_job(job_id)
    }

    /// Lists all persisted jobs from `omnia-winsqlite`.
    pub fn list_jobs(&self) -> Result<Vec<DownloadJobSnapshot>, DownloaderError> {
        self.store.list_jobs()
    }

    /// Returns persisted segments for a job.
    pub fn get_segments(&self, job_id: &str) -> Result<Vec<ChunkRange>, DownloaderError> {
        self.store.get_segments(job_id)
    }

    /// Accesses the shared [`VisibleHandoffManager`] (`MANUAL_VISIBLE_BROWSER_ONLY`).
    #[must_use]
    pub fn handoffs(&self) -> &VisibleHandoffManager {
        &self.handoffs
    }

    /// Accesses the 23-provider / 10-category [`ProviderRegistry`].
    #[must_use]
    pub fn providers(&self) -> &ProviderRegistry {
        &self.providers
    }

    /// Accesses the RFC 6265 [`ScopedCookieJar`].
    #[must_use]
    pub fn cookie_jar(&self) -> &ScopedCookieJar {
        &self.cookie_jar
    }

    /// Accesses the batch [`DownloadScheduler`].
    #[must_use]
    pub fn scheduler(&self) -> &Mutex<DownloadScheduler> {
        &self.scheduler
    }

    /// Creates a [`BatchPlanner`] bound to strict production security policy.
    #[must_use]
    pub const fn batch_planner(&self) -> BatchPlanner {
        BatchPlanner::new()
    }

    /// Read-only binary media container inspection for a downloaded local file.
    pub fn inspect_media_file(&self, path: &Path) -> Result<MediaBoxReport, DownloaderError> {
        inspect_media_file(path)
    }

    /// Read-only binary media container inspection for in-memory bytes.
    #[must_use]
    pub fn inspect_media_bytes(&self, bytes: &[u8]) -> MediaBoxReport {
        inspect_media_bytes(bytes)
    }

    /// Accesses the Content-Addressable Blob Store (`sha256:<hex>`).
    #[must_use]
    pub fn cas(&self) -> &ContentAddressableBlobStore {
        &self.cas
    }

    /// Seals a verifiable CAS [`CaptureBundle`] inside the manager's CAS store.
    pub fn seal_capture_bundle(
        &self,
        bundle_id: String,
        source_url: &str,
        parts: &[(&str, &str, &[u8])],
        metadata: serde_json::Value,
    ) -> Result<CaptureBundle, DownloaderError> {
        CaptureBundle::build_and_seal(&self.cas, bundle_id, source_url, parts, metadata)
    }

    /// Executes FFmpeg lossless `-c copy` mux/clip/soft-sub conversion with optional `ffprobe` verify.
    pub async fn convert_or_clip_media(
        &self,
        req: MediaMuxRequest,
    ) -> Result<MediaMuxOutcome, DownloaderError> {
        convert_or_clip_media(req).await
    }

    /// Runs `ffprobe` container/stream verification on a local file outside workspace.
    pub async fn inspect_media_ffprobe(
        &self,
        path: &Path,
        workspace_root: Option<&Path>,
    ) -> Result<FfprobeReport, DownloaderError> {
        run_ffprobe(path, workspace_root).await
    }

    /// Compares two HTML/JSON/text snapshots for 3-gram structural schema drift.
    #[must_use]
    pub fn compare_schema_drift(
        &self,
        before_text: &str,
        after_text: &str,
        threshold: Option<f64>,
    ) -> SchemaDriftReport {
        compare_schema_snapshots(before_text, after_text, threshold)
    }

    /// Crawls a Moodle LMS course/page URL under strict SSRF & ReDoS guards.
    pub async fn crawl_moodle(
        &self,
        url: &str,
        cookie_header: Option<&str>,
        filter_pattern: Option<&str>,
    ) -> Result<CrawlReport, DownloaderError> {
        crawl_moodle_course(url, cookie_header, filter_pattern, self.engine.policy).await
    }

    /// Bounded SSRF-safe BFS Web crawler.
    pub async fn crawl_web(
        &self,
        root_url: &str,
        max_depth: usize,
        max_pages: usize,
        filter_pattern: Option<&str>,
    ) -> Result<CrawlReport, DownloaderError> {
        crawl_web_tree(root_url, max_depth, max_pages, filter_pattern, self.engine.policy).await
    }

    /// Inspects a public YouTube URL without DRM bypass.
    pub async fn inspect_youtube(&self, url: &str) -> Result<YouTubeInspectResult, DownloaderError> {
        inspect_youtube_url(url, self.engine.policy).await
    }
}

#[cfg(test)]
mod stream_tests {
    use super::*;
    use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    use cbc::Encryptor;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    type Aes128CbcEnc = Encryptor<aes::Aes128>;

    #[tokio::test]
    async fn engine_executes_hls_aes128_cbc_and_dash_mpd_end_to_end() {
        let key: [u8; 16] = *b"OmniaDummyHlsKey";
        let plain0 = b"SegmentZeroPayload_123456";
        let plain1 = b"SegmentOnePayload_ABCDEF";
        let iv0 = hls_sequence_iv(10);
        let iv1 = hls_sequence_iv(11);

        let mut buf0 = vec![0u8; plain0.len() + 16];
        buf0[..plain0.len()].copy_from_slice(plain0);
        let enc0 = Aes128CbcEnc::new(&key.into(), &iv0.into())
            .encrypt_padded_mut::<Pkcs7>(&mut buf0, plain0.len())
            .unwrap()
            .to_vec();

        let mut buf1 = vec![0u8; plain1.len() + 16];
        buf1[..plain1.len()].copy_from_slice(plain1);
        let enc1 = Aes128CbcEnc::new(&key.into(), &iv1.into())
            .encrypt_padded_mut::<Pkcs7>(&mut buf1, plain1.len())
            .unwrap()
            .to_vec();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base_url = format!("http://{addr}");
        let m3u8_body = format!(
            "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-KEY:METHOD=AES-128,URI=\"{base_url}/key.bin\"\n#EXTINF:2.0,\n{base_url}/seg0.ts\n#EXTINF:2.0,\n{base_url}/seg1.ts\n#EXT-X-ENDLIST\n"
        );
        let mpd_body = format!(
            "<?xml version=\"1.0\"?><MPD type=\"static\"><Period><AdaptationSet mimeType=\"video/mp4\"><Representation id=\"v1\" bandwidth=\"500000\"><SegmentList><Initialization sourceURL=\"{base_url}/init.mp4\"/><SegmentURL media=\"{base_url}/dash0.m4s\"/></SegmentList></Representation></AdaptationSet></Period></MPD>"
        );

        let srv = tokio::spawn(async move {
            for _ in 0..8 {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let mut req_buf = [0u8; 2048];
                let n = sock.read(&mut req_buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&req_buf[..n]);
                let path = req_str
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/");
                let (ct, body): (&str, Vec<u8>) = match path {
                    "/stream.m3u8" => ("application/vnd.apple.mpegurl", m3u8_body.as_bytes().to_vec()),
                    "/key.bin" => ("application/octet-stream", key.to_vec()),
                    "/seg0.ts" => ("video/mp2t", enc0.clone()),
                    "/seg1.ts" => ("video/mp2t", enc1.clone()),
                    "/manifest.mpd" => ("application/dash+xml", mpd_body.as_bytes().to_vec()),
                    "/init.mp4" => ("video/mp4", b"FTYP_INIT_".to_vec()),
                    "/dash0.m4s" => ("video/mp4", b"MDAT_DASH0".to_vec()),
                    _ => ("text/plain", b"not-found".to_vec()),
                };
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&body).await;
            }
        });

        let mgr = DownloadManager::in_memory_for_tests(DownloadConfig::default()).unwrap();
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let stage = std::env::temp_dir().join(format!("omnia-dl-stream-test-{nanos}"));
        fs::create_dir_all(&stage).unwrap();

        let hls_done = mgr
            .download_now(DownloadRequest::new(format!("{base_url}/stream.m3u8"), &stage))
            .await
            .expect("HLS AES-128 download");
        let hls_bytes = fs::read(&hls_done.output_path).unwrap();
        assert_eq!(hls_bytes, [plain0.as_slice(), plain1.as_slice()].concat());

        let dash_done = mgr
            .download_now(DownloadRequest::new(format!("{base_url}/manifest.mpd"), &stage))
            .await
            .expect("DASH download");
        let dash_bytes = fs::read(&dash_done.output_path).unwrap();
        assert_eq!(dash_bytes, b"FTYP_INIT_MDAT_DASH0");

        let _ = fs::remove_dir_all(&stage);
        srv.abort();
    }

    #[tokio::test]
    async fn engine_executes_dash_number_template_md5_fairplay_reject_dual_hls_and_live_aimd() {
        let seg1_v = b"VIDEO_SEG_1_PAYLOAD";
        let seg2_v = b"VIDEO_SEG_2_PAYLOAD";
        let seg1_a = b"AUDIO_SEG_1_PAYLOAD";
        let seg2_a = b"AUDIO_SEG_2_PAYLOAD";
        let dash_init = b"INIT_";
        let dash_s1 = b"D1_";
        let dash_s2 = b"D2";
        let dash_full = [dash_init.as_slice(), dash_s1.as_slice(), dash_s2.as_slice()].concat();
        let dash_md5_hex = omnia_core::hex_encode(&crate::integrity::md5_bytes(&dash_full));

        let range_payload = vec![b'Z'; 4096];
        let range_payload_srv = range_payload.clone();

        let vid0_hit = Arc::new(AtomicBool::new(false));
        let vid_hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let aud_hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let vid0_hit_s = Arc::clone(&vid0_hit);
        let vid_hits_s = Arc::clone(&vid_hits);
        let aud_hits_s = Arc::clone(&aud_hits);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base_url = format!("http://{addr}");

        let master_m3u8 = format!(
            "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"English\",DEFAULT=YES,URI=\"{base_url}/audio.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=2400000,AUDIO=\"aud\"\n{base_url}/video.m3u8\n"
        );
        let video_m3u8 = format!(
            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n{base_url}/vid0.ts\n#EXTINF:2.0,\n{base_url}/vid1.ts\n#EXTINF:2.0,\n{base_url}/vid2.ts\n#EXT-X-ENDLIST\n"
        );
        let audio_m3u8 = format!(
            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n{base_url}/aud0.aac\n#EXTINF:2.0,\n{base_url}/aud1.aac\n#EXTINF:2.0,\n{base_url}/aud2.aac\n#EXT-X-ENDLIST\n"
        );
        let drm_m3u8 = format!(
            "#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT=\"com.apple.streamingkeydelivery\",URI=\"skd://example.test/key\"\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n{base_url}/vid1.ts\n#EXT-X-ENDLIST\n"
        );
        let dash_mpd = format!(
            "<?xml version=\"1.0\"?><MPD type=\"static\" mediaPresentationDuration=\"PT6S\"><Period><AdaptationSet mimeType=\"video/mp4\"><Representation id=\"v1\" bandwidth=\"900000\"><SegmentTemplate initialization=\"{base_url}/dash-init.mp4\" media=\"{base_url}/dash-$Number%05d$.m4s\" timescale=\"1\" duration=\"3\" startNumber=\"1\"><SegmentTimeline><S d=\"3\" r=\"-1\"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>"
        );

        let srv = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let vid0_hit_c = Arc::clone(&vid0_hit_s);
                let vid_hits_c = Arc::clone(&vid_hits_s);
                let aud_hits_c = Arc::clone(&aud_hits_s);
                let master = master_m3u8.clone();
                let video = video_m3u8.clone();
                let audio = audio_m3u8.clone();
                let drm = drm_m3u8.clone();
                let mpd = dash_mpd.clone();
                let rp = range_payload_srv.clone();
                tokio::spawn(async move {
                    let mut req_buf = [0u8; 4096];
                    let n = sock.read(&mut req_buf).await.unwrap_or(0);
                    let req_str = String::from_utf8_lossy(&req_buf[..n]);
                    let mut lines = req_str.lines();
                    let req_line = lines.next().unwrap_or("");
                    let method = req_line.split_whitespace().next().unwrap_or("GET");
                    let path = req_line.split_whitespace().nth(1).unwrap_or("/");
                    let range_hdr = lines
                        .find(|l| l.to_ascii_lowercase().starts_with("range:"))
                        .map(|l| l.to_string());

                    if path == "/ranged.bin" {
                        if method == "HEAD" {
                            let head = format!(
                                "HTTP/1.1 200 OK\r\nAccept-Ranges: bytes\r\nETag: \"r1\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                rp.len()
                            );
                            let _ = sock.write_all(head.as_bytes()).await;
                            return;
                        }
                        if let Some(rh) = range_hdr {
                            let spec = rh.split_once(':').map(|x| x.1.trim()).unwrap_or("");
                            if let Some(nums) = spec.strip_prefix("bytes=") {
                                let (a, b) = nums.split_once('-').unwrap_or(("0", ""));
                                let s: usize = a.parse().unwrap_or(0);
                                let e: usize = b.parse().unwrap_or(rp.len() - 1).min(rp.len() - 1);
                                let slice = &rp[s..=e];
                                let head = format!(
                                    "HTTP/1.1 206 Partial Content\r\nAccept-Ranges: bytes\r\nETag: \"r1\"\r\nContent-Range: bytes {s}-{e}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    rp.len(),
                                    slice.len()
                                );
                                let _ = sock.write_all(head.as_bytes()).await;
                                let _ = sock.write_all(slice).await;
                                return;
                            }
                        }
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            rp.len()
                        );
                        let _ = sock.write_all(head.as_bytes()).await;
                        let _ = sock.write_all(&rp).await;
                        return;
                    }

                    let (ct, body): (&str, Vec<u8>) = match path {
                        "/master.m3u8" => ("application/vnd.apple.mpegurl", master.into_bytes()),
                        "/video.m3u8" => ("application/vnd.apple.mpegurl", video.into_bytes()),
                        "/audio.m3u8" => ("application/vnd.apple.mpegurl", audio.into_bytes()),
                        "/drm.m3u8" => ("application/vnd.apple.mpegurl", drm.into_bytes()),
                        "/vid0.ts" => {
                            vid0_hit_c.store(true, Ordering::SeqCst);
                            ("video/mp2t", b"SKIP_0".to_vec())
                        }
                        "/vid1.ts" => {
                            vid_hits_c.fetch_add(1, Ordering::SeqCst);
                            ("video/mp2t", seg1_v.to_vec())
                        }
                        "/vid2.ts" => {
                            vid_hits_c.fetch_add(1, Ordering::SeqCst);
                            ("video/mp2t", seg2_v.to_vec())
                        }
                        "/aud0.aac" => ("audio/aac", b"SKIP_A0".to_vec()),
                        "/aud1.aac" => {
                            aud_hits_c.fetch_add(1, Ordering::SeqCst);
                            ("audio/aac", seg1_a.to_vec())
                        }
                        "/aud2.aac" => {
                            aud_hits_c.fetch_add(1, Ordering::SeqCst);
                            ("audio/aac", seg2_a.to_vec())
                        }
                        "/template.mpd" => ("application/dash+xml", mpd.into_bytes()),
                        "/dash-init.mp4" => ("video/mp4", dash_init.to_vec()),
                        "/dash-00001.m4s" => ("video/mp4", dash_s1.to_vec()),
                        "/dash-00002.m4s" => ("video/mp4", dash_s2.to_vec()),
                        _ => ("text/plain", b"not-found".to_vec()),
                    };
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(&body).await;
                });
            }
        });

        let mgr = DownloadManager::in_memory_for_tests(DownloadConfig::default()).unwrap();
        mgr.set_global_speed_limit_bps(Some(4 * 1024 * 1024));
        assert_eq!(mgr.global_speed_limit_bps(), Some(4 * 1024 * 1024));

        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let stage = std::env::temp_dir().join(format!("omnia-dl-sota-test-{nanos}"));
        fs::create_dir_all(&stage).unwrap();

        // 1. HLS FairPlay `#EXT-X-SESSION-KEY` must fail closed immediately with `DrmUnsupported`.
        let drm_err = mgr
            .download_now(DownloadRequest::new(format!("{base_url}/drm.m3u8"), &stage))
            .await
            .unwrap_err();
        assert!(matches!(drm_err, DownloaderError::DrmUnsupported { .. }));

        // 2. DASH `$Number%05d$` + `r="-1"` + exact MD5 pass + mismatched MD5 fail closed.
        let mut ok_dash = DownloadRequest::new(format!("{base_url}/template.mpd"), &stage);
        ok_dash.filename = Some("dash_ok.mp4".to_string());
        ok_dash.expected_md5_hex = Some(dash_md5_hex);
        let dash_done = mgr.download_now(ok_dash).await.expect("DASH template MD5 pass");
        assert_eq!(fs::read(&dash_done.output_path).unwrap(), dash_full);

        let mut bad_dash = DownloadRequest::new(format!("{base_url}/template.mpd"), &stage);
        bad_dash.filename = Some("dash_bad.mp4".to_string());
        bad_dash.expected_md5_hex = Some("00000000000000000000000000000000".to_string());
        let md5_err = mgr.download_now(bad_dash).await.unwrap_err();
        assert!(matches!(md5_err, DownloaderError::IntegrityMismatch { .. }));

        // 3. HLS dual-track master + clip slicing [2.5s..5.5s] skips seg 0 and downloads video+audio 1..2.
        let mut hls_req = DownloadRequest::new(format!("{base_url}/master.m3u8"), &stage);
        hls_req.filename = Some("dual.ts".to_string());
        hls_req.clip_start_sec = Some(2.5);
        hls_req.clip_end_sec = Some(5.5);
        let _ = mgr.download_now(hls_req).await;
        assert!(!vid0_hit.load(Ordering::SeqCst), "clip slicing must skip out-of-range segment 0");
        assert_eq!(vid_hits.load(Ordering::SeqCst), 2);
        assert_eq!(aud_hits.load(Ordering::SeqCst), 2);

        // 4. Ranged download populates live AIMD telemetry snapshot.
        let mut range_req = DownloadRequest::new(format!("{base_url}/ranged.bin"), &stage);
        range_req.streams = Some(2);
        range_req.min_split_bytes = Some(1024);
        let ranged_done = mgr.download_now(range_req).await.expect("ranged download");
        assert_eq!(ranged_done.total_bytes, 4096);
        let telem = mgr.live_aimd_telemetry();
        assert!(telem.sample_count >= 1);
        assert_eq!(telem.active_job_id.as_deref(), Some(ranged_done.job_id.as_str()));

        let _ = fs::remove_dir_all(&stage);
        srv.abort();
    }

    #[tokio::test]
    async fn drive_folder_rejection_and_content_disposition_edge_cases() {
        assert_eq!(
            extract_content_disposition_filename(r#"attachment; filename="a;b\"c.pdf"; x=1"#).as_deref(),
            Some("a;b\"c.pdf")
        );
        assert_eq!(
            extract_content_disposition_filename("attachment; filename*=UTF-8''hello%20world.txt").as_deref(),
            Some("hello world.txt")
        );
        assert_eq!(
            extract_content_disposition_filename("attachment; filename*=ISO-8859-1''caf%E9.txt").as_deref(),
            Some("café.txt")
        );

        let mgr = DownloadManager::in_memory_for_tests(DownloadConfig::default()).unwrap();
        let stage = std::env::temp_dir().join(format!(
            "omnia-dl-drive-test-{}",
            omnia_core::uuid_v4_simple()
        ));
        fs::create_dir_all(&stage).unwrap();
        let err = mgr
            .download_now(DownloadRequest::new(
                "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz",
                &stage,
            ))
            .await
            .unwrap_err();
        assert!(matches!(err, DownloaderError::InvalidInput(_)));
        let _ = fs::remove_dir_all(&stage);
    }
}
