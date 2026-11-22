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
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use omnia_connector_gateway::artifact_intake::classify_http_validator;
use omnia_core::uuid_v4;
use parking_lot::{Mutex, RwLock};
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_LENGTH,
    CONTENT_RANGE, CONTENT_TYPE, COOKIE, ETAG, IF_RANGE, LAST_MODIFIED, LOCATION, RANGE,
    RETRY_AFTER, USER_AGENT,
};
use reqwest::{redirect, Client};
use tokio::sync::{broadcast, watch};
use tokio::time::sleep;
use url::Url;

use crate::batch::{BatchPlanner, DownloadScheduler, SchedulerConfig};
use crate::chunker::{
    normalize_completed_intervals, record_completed_interval, total_interval_bytes, Chunker,
};
use crate::handoff::{classify_http_response, VisibleHandoffManager};
use crate::integrity::{parse_x_goog_hash, verify_file_integrity};
use crate::journal::{
    omnf_journal_path_for, part_meta_path_for, OmnfJournal, OmnfRecord, PartMetaV2,
};
use crate::media_box::{inspect_media_bytes, inspect_media_file, MediaBoxReport};
use crate::pacing::{AimdBdpController, PacingMode, TokenBucketLimiter};
use crate::privacy::{PrivacyShield, ProviderRegistry, ScopedCookieJar};
use crate::store::DownloadStore;
use crate::types::{
    current_epoch_ms, safe_output_filename, validate_safe_local_path, ChunkRange,
    CompletedDownload, DownloadConfig, DownloadJobSnapshot, DownloadProgressEvent,
    DownloadRequest, DownloadStatus, DownloaderError, ProbeInfo, SecurityPolicy, DRM_SUPPORTED,
};
use crate::writer::PositionalWriter;

/// Control signal sent to an active download job via `tokio::sync::watch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobControl {
    Run,
    Pause,
    Cancel,
}

/// Core async multi-stream segmented HTTP Range download engine.
pub struct DownloadEngine {
    client: Client,
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
            config,
            policy,
            handoffs,
            cookie_jar,
            providers,
        })
    }

    /// Issues an SSRF-checked HTTP request manually following up to 10 redirects while
    /// enforcing [`SecurityPolicy`] on every hop and stripping cross-origin credentials/cookies.
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
            self.policy.validate_url(&current_url)?;
            let parsed_cur = Url::parse(&current_url)
                .map_err(|e| DownloaderError::InvalidInput(format!("invalid URL: {e}")))?;

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

            let resp = self
                .client
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

        // Emit probing status
        let probe = self.probe(&req.url, &req.headers).await?;

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
        let integrity = tokio::task::spawn_blocking(move || {
            verify_file_integrity(&part_for_hash, exp_sha.as_deref(), exp_crc.as_deref())
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

        let range_violated = Arc::new(AtomicBool::new(false));
        let abort_flag = Arc::new(AtomicBool::new(false));
        let fatal_error: Arc<Mutex<Option<DownloaderError>>> = Arc::new(Mutex::new(None));
        let sidecar_io_lock: Arc<Mutex<()>> = Arc::new(Mutex::new(()));

        let mut handles = Vec::with_capacity(worker_count);
        for worker_idx in 0..worker_count {
            let client_engine_client = self.client.clone();
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
            let writer_ref = writer.clone();
            let limiter_ref = Arc::clone(&limiter);
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
                                let backoff = shared.lock().controller.on_congestion(
                                    503,
                                    None,
                                    current_epoch_ms(),
                                );
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
                            let backoff = shared.lock().controller.on_congestion(
                                status,
                                retry_after_hdr.as_deref(),
                                current_epoch_ms(),
                            );
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
                            let backoff = shared.lock().controller.on_congestion(
                                status,
                                retry_after_hdr.as_deref(),
                                current_epoch_ms(),
                            );
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

                        // Validate Content-Range starts at `cur_start`.
                        if let Some(cr) = resp.headers().get(CONTENT_RANGE).and_then(|v| v.to_str().ok()) {
                            if let Some((cr_start, _cr_end, cr_total)) = parse_content_range_bounds(cr) {
                                if cr_start != cur_start || cr_total != total_size {
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
                                    if attempts < worker_engine.config.max_retries {
                                        attempts += 1;
                                        let backoff = shared.lock().controller.on_congestion(
                                            503,
                                            None,
                                            current_epoch_ms(),
                                        );
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

                            // Step 2 (off-executor blocking pool, ZERO mutex held): write to disk!
                            if let Err(io_err) = writer_ref
                                .write_at_async(write_offset, data.slice(..allowed))
                                .await
                            {
                                abort_ref.store(true, Ordering::Relaxed);
                                fatal_ref.lock().get_or_insert(io_err);
                                break 'retry;
                            }

                            let write_len = allowed as u64;
                            let seg_end = write_offset + write_len - 1;
                            chunk_bytes_received = chunk_bytes_received.saturating_add(write_len);
                            let total_done =
                                counter_ref.fetch_add(write_len, Ordering::Relaxed) + write_len;

                            // Step 3 (in-RAM only): record confirmed on-disk interval and decide
                            // whether a throttled (~250ms / first write / chunk completion) flush is due.
                            let (completed_ranges_for_evt, flush_payload) = {
                                let mut st = shared.lock();
                                st.meta.add_completed_range(write_offset, seg_end);
                                st.pending_omnf.push((write_offset, seg_end));
                                let should_flush = chunk_finished_now
                                    || st
                                        .last_flush
                                        .is_none_or(|t| t.elapsed() >= Duration::from_millis(250));
                                let ranges_copy = st.meta.completed_ranges.clone();
                                if should_flush {
                                    st.last_flush = Some(Instant::now());
                                    let pending = std::mem::take(&mut st.pending_omnf);
                                    (
                                        ranges_copy,
                                        Some((st.meta.clone(), pending, st.chunks.clone())),
                                    )
                                } else {
                                    (ranges_copy, None)
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
                            if pacing_mode == PacingMode::Polite
                                && worker_engine.config.polite_segment_delay_ms > 0
                            {
                                sleep(Duration::from_millis(
                                    worker_engine.config.polite_segment_delay_ms,
                                ))
                                .await;
                            }
                        }

                        // Check if chunk finished (or was shortened to completion via midpoint steal).
                        let finished_chunk = {
                            let mut st = shared.lock();
                            st.controller
                                .on_chunk_success(chunk_bytes_received, req_started.elapsed());
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

fn extract_content_disposition_filename(header: &str) -> Option<String> {
    for part in header.split(';') {
        let trimmed = part.trim();
        let low = trimmed.to_ascii_lowercase();
        if let Some(rest) = low.strip_prefix("filename*=") {
            let orig_rest = &trimmed[trimmed.len() - rest.len()..];
            if let Some((_, encoded)) = orig_rest.rsplit_once("''") {
                return Some(percent_decode_basic(encoded.trim_matches('"')));
            }
        }
        if let Some(rest) = low.strip_prefix("filename=") {
            let orig_rest = &trimmed[trimmed.len() - rest.len()..];
            let val = orig_rest.trim().trim_matches('"');
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

fn percent_decode_basic(input: &str) -> String {
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
    String::from_utf8_lossy(&out).into_owned()
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
/// `ProviderRegistry`, `ScopedCookieJar`, and `DownloadScheduler`.
pub struct DownloadManager {
    engine: Arc<DownloadEngine>,
    store: Arc<DownloadStore>,
    handoffs: Arc<VisibleHandoffManager>,
    cookie_jar: Arc<ScopedCookieJar>,
    providers: Arc<ProviderRegistry>,
    scheduler: Arc<Mutex<DownloadScheduler>>,
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
            scheduler: Arc::new(Mutex::new(DownloadScheduler::new(
                SchedulerConfig::default(),
            ))),
            controls: Arc::new(RwLock::new(HashMap::new())),
            events_tx,
        })
    }

    /// Subscribes to live [`DownloadProgressEvent`] notifications (for Studio SSE `/api/downloads/events`).
    #[must_use]
    pub fn subscribe_events(&self) -> broadcast::Receiver<DownloadProgressEvent> {
        self.events_tx.subscribe()
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
            .execute_download(
                job_id.clone(),
                req,
                Some(Arc::clone(&self.store)),
                Some(self.events_tx.clone()),
                ctrl_rx,
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
        let (ctrl_tx, ctrl_rx) = watch::channel(JobControl::Run);
        self.controls.write().insert(job_id.clone(), ctrl_tx);

        let engine = Arc::clone(&self.engine);
        let store = Arc::clone(&self.store);
        let events_tx = self.events_tx.clone();
        let controls = Arc::clone(&self.controls);
        let id_clone = job_id.clone();

        let handle = tokio::spawn(async move {
            let res = engine
                .execute_download(
                    id_clone.clone(),
                    req,
                    Some(store),
                    Some(events_tx),
                    ctrl_rx,
                )
                .await;
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
}
