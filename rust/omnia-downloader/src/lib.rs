//! `omnia-downloader`: Full Native Rust multi-stream segmented HTTP & Google Drive
//! downloader (OmniDownloader Pro / OmniDrive Pro v3) for Omnia.
//!
//! # Security & Compliance Invariants
//! - `#![forbid(unsafe_code)]` across the entire crate.
//! - `DRM_SUPPORTED = false` — commercial DRM (`Widevine`/`PlayReady`/`FairPlay`/`SAMPLE-AES`)
//!   is detected strictly read-only and never decrypted.
//! - `VisibleHandoffManager` (`MANUAL_VISIBLE_BROWSER_ONLY`, `auto_solve_permitted = false`) —
//!   zero automated CAPTCHA/Turnstile/hCaptcha/reCAPTCHA/Altcha PoW solvers.
//! - Zero-retry fail-closed on `429 AUTH_CHALLENGE_REQUIRED` and `403 BLOCKED_ACL_403`.
//! - Strict SSRF/loopback/private-IP guard (with `allow_loopback_for_tests` gated behind `#[cfg(test)]`),
//!   UNC/SMB `\\server\share` blocking, and `DOD-06` external staging containment.

#![forbid(unsafe_code)]

pub mod batch;
pub mod capture_bundle;
pub mod chunker;
pub mod crawlers;
pub mod drive;
pub mod engine;
pub mod handoff;
pub mod integrity;
pub mod journal;
pub mod media_box;
pub mod media_ops;
pub mod pacing;
pub mod privacy;
pub mod schema_drift;
pub mod store;
pub mod streaming;
pub mod types;
pub mod writer;

/// Crate identity string for diagnostics.
pub const CRATE_NAME: &str = "omnia-downloader";

// Clean public re-exports ready for Wave 3 `omnia-studio` (`/api/downloads/*`, `/api/omni-drive/*`)
// and `omnia-cli` integration.
pub use batch::{
    expand_batch_pattern, parse_ef2, serialize_ef2, BatchItem, BatchPlan, BatchPlanner,
    DownloadCategory, DownloadScheduler, Ef2Entry, ScheduleWindow, SchedulerConfig,
    MAX_BATCH_EXPANSION,
};
pub use capture_bundle::{
    open_wire_value, seal_wire_value, CaptureBundle, CaptureBundleEntry, CasBlobMeta,
    ContentAddressableBlobStore, WireCodecKind, DEFAULT_MAX_CAS_ENTRIES, DEFAULT_MAX_INFLATE_BYTES,
};
pub use chunker::{
    compute_missing_intervals, normalize_completed_intervals, record_completed_interval,
    total_interval_bytes, Chunker,
};
pub use crawlers::{
    crawl_moodle_course, crawl_web_tree, extract_moodle_resources_from_html, has_redos_hazard,
    inspect_youtube_url, parse_youtube_player_json, parse_youtube_url, CrawlReport,
    DiscoveredCrawlResource, SafeFilterPattern, YouTubeFormatOption, YouTubeInspectResult,
    YouTubePlaylistEntry,
};
pub use drive::{
    extract_drive_confirm_url, is_valid_drive_id, parse_drive_url, resolve_workspace_export,
    DriveAuth, DriveFileMetadata, DriveResolver, DriveResourceKind, DriveResourceRef,
    WorkspaceExportFormat, WorkspaceExportTarget, DEFAULT_DRIVE_API_BASE, MAX_DRIVE_API_BODY_BYTES,
};
pub use engine::{DownloadEngine, DownloadManager, JobControl};
pub use handoff::{
    classify_http_response, HandoffReason, HandoffStatus, HttpGateClassification,
    VisibleHandoffManager, VisibleHandoffTicket, AUTO_SOLVE_PERMITTED,
    EXECUTION_MODE_MANUAL_VISIBLE_BROWSER,
};
pub use integrity::{
    crc32c_base64, crc32c_bytes, decode_crc32c_base64, hash_file_streaming, parse_x_goog_hash,
    verify_file_integrity, Crc32cHasher, GoogleHashHeader, IntegrityReport,
};
pub use journal::{
    omnf_journal_path_for, part_meta_path_for, OmnfJournal, OmnfRecord, OmnfReplayState,
    PartMetaV2, MAX_OMNF_FRAME_PAYLOAD_BYTES, MAX_OMNF_JOURNAL_RECORDS, OMNF_MAGIC,
    PART_META_VERSION,
};
pub use media_box::{
    inspect_media_bytes, inspect_media_file, AdtsInfo, ContainerFormat, DrmBoxMetadata,
    IsoBmffBoxInfo, MediaBoxReport, MpegTsInfo, WebmInfo,
};
pub use media_ops::{
    build_ffmpeg_mux_args, convert_or_clip_media, find_media_binary, parse_ffprobe_json,
    run_ffprobe, FfprobeReport, FfprobeStreamSummary, MediaMuxOutcome, MediaMuxRequest,
};
pub use pacing::{
    parse_retry_after, parse_retry_after_now, AimdBdpController, CongestionMetrics, PacingMode,
    TokenBucketLimiter, MAX_RETRY_AFTER_SECS,
};
pub use privacy::{
    PrivacyShield, ProviderCategory, ProviderDefinition, ProviderRegistry, ScopedCookie,
    ScopedCookieJar,
};
pub use schema_drift::{
    build_gram_multiset, compare_schema_snapshots, compute_multiset_overlap, diff_required_keys,
    extract_structural_shapes_from_json, extract_structural_shapes_from_text,
    signature_similarity, DriftVerdict, SchemaDriftPair, SchemaDriftReport, SchemaSignature,
    DEFAULT_DRIFT_THRESHOLD, GRAM_WIDTH,
};
pub use store::DownloadStore;
pub use streaming::{
    decrypt_hls_aes128_cbc, hls_sequence_iv, parse_dash_manifest, parse_hls_manifest,
    DashAdaptationSet, DashManifest, DashRepresentation, DashSegment, HlsAes128Key, HlsByteRange,
    HlsManifest, HlsSegment, HlsVariant,
};
pub use types::{
    safe_output_filename, validate_safe_local_path, ChunkRange, CompletedDownload, DownloadConfig,
    DownloadJobSnapshot, DownloadProgressEvent, DownloadRequest, DownloadStatus, DownloaderError,
    ProbeInfo, SecurityPolicy, DEFAULT_MIN_SPLIT_BYTES, DRM_SUPPORTED, MAX_STREAMS, MIN_STREAMS,
};
pub use writer::PositionalWriter;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::net::SocketAddr;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    struct TempSandbox {
        base: PathBuf,
        workspace: PathBuf,
        staging: PathBuf,
    }

    impl TempSandbox {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "omnia-dl-e2e-{tag}-{}",
                omnia_core::uuid_v4_simple()
            ));
            let workspace = base.join("workspace");
            let staging = base.join("external_staging");
            fs::create_dir_all(&workspace).unwrap();
            fs::create_dir_all(&staging).unwrap();
            Self {
                base,
                workspace,
                staging,
            }
        }
    }

    impl Drop for TempSandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[derive(Clone, Copy)]
    enum MockServerBehavior {
        /// Normal RFC 9110 Range server supporting HEAD, 206 Partial Content, If-Range, X-Goog-Hash,
        /// with optional small delay per range chunk to exercise pause/resume and work-stealing.
        StandardRange { chunk_delay_ms: u64 },
        /// Advertises `Accept-Ranges: bytes` on HEAD, then violates Range with `200 OK` full payload on GET!
        RangeViolation200Ok,
        /// Returns HTTP 429 with Google `/sorry/` challenge interstitial (zero-retry fail-closed).
        Challenge429,
        /// Returns HTTP 403 `cannotDownloadFile` ACL denial (zero-retry fail-closed).
        BlockedAcl403,
    }

    async fn spawn_mock_http_server(
        payload: Arc<Vec<u8>>,
        etag: &'static str,
        behavior: MockServerBehavior,
    ) -> (SocketAddr, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_clone = Arc::clone(&hits);
        let crc_b64 = crc32c_base64(&payload);

        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let payload = Arc::clone(&payload);
                let hits_inner = Arc::clone(&hits_clone);
                let crc_val = crc_b64.clone();

                tokio::spawn(async move {
                    let mut req_buf = vec![0u8; 4096];
                    let n = match socket.read(&mut req_buf).await {
                        Ok(n) if n > 0 => n,
                        _ => return,
                    };
                    let req_text = String::from_utf8_lossy(&req_buf[..n]);
                    let first_line = req_text.lines().next().unwrap_or("");
                    let method = first_line.split_whitespace().next().unwrap_or("GET");
                    let range_hdr = req_text.lines().find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        if k.eq_ignore_ascii_case("range") {
                            Some(v.trim().to_string())
                        } else {
                            None
                        }
                    });
                    let if_range_hdr = req_text.lines().find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        if k.eq_ignore_ascii_case("if-range") {
                            Some(v.trim().to_string())
                        } else {
                            None
                        }
                    });

                    hits_inner.fetch_add(1, Ordering::Relaxed);

                    match behavior {
                        MockServerBehavior::Challenge429 => {
                            let body = "<html><body><div class=\"g-recaptcha\"></div>Our systems have detected unusual traffic from your computer network</body></html>";
                            let resp = format!(
                                "HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        }
                        MockServerBehavior::BlockedAcl403 => {
                            let body = r#"{"error":{"code":403,"errors":[{"reason":"cannotDownloadFile"}]}}"#;
                            let resp = format!(
                                "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        }
                        MockServerBehavior::RangeViolation200Ok => {
                            if method == "HEAD" {
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\nETag: {etag}\r\nX-Goog-Hash: crc32c={crc_val}\r\nConnection: close\r\n\r\n",
                                    payload.len()
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                            } else {
                                // Violate Range by answering 200 OK with full payload!
                                let hdr = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: {etag}\r\nX-Goog-Hash: crc32c={crc_val}\r\nConnection: close\r\n\r\n",
                                    payload.len()
                                );
                                let _ = socket.write_all(hdr.as_bytes()).await;
                                let _ = socket.write_all(&payload).await;
                            }
                        }
                        MockServerBehavior::StandardRange { chunk_delay_ms } => {
                            if method == "HEAD" {
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\nETag: {etag}\r\nX-Goog-Hash: crc32c={crc_val}\r\nContent-Disposition: attachment; filename=\"fixture.bin\"\r\nConnection: close\r\n\r\n",
                                    payload.len()
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                                return;
                            }

                            let if_range_ok = if_range_hdr
                                .as_deref()
                                .is_none_or(|v| v == etag);

                            if let Some(rng) = range_hdr.filter(|_| if_range_ok) {
                                if let Some(spec) = rng.strip_prefix("bytes=") {
                                    if let Some((s_str, e_str)) = spec.split_once('-') {
                                        if let (Ok(start), Ok(end)) =
                                            (s_str.parse::<usize>(), e_str.parse::<usize>())
                                        {
                                            let clamped_end = end.min(payload.len().saturating_sub(1));
                                            if start <= clamped_end {
                                                let slice = &payload[start..=clamped_end];
                                                let hdr = format!(
                                                    "HTTP/1.1 206 Partial Content\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{clamped_end}/{}\r\nContent-Length: {}\r\nETag: {etag}\r\nX-Goog-Hash: crc32c={crc_val}\r\nConnection: close\r\n\r\n",
                                                    payload.len(),
                                                    slice.len()
                                                );
                                                let _ = socket.write_all(hdr.as_bytes()).await;
                                                for piece in slice.chunks(8192) {
                                                    if chunk_delay_ms > 0 {
                                                        tokio::time::sleep(
                                                            std::time::Duration::from_millis(
                                                                chunk_delay_ms,
                                                            ),
                                                        )
                                                        .await;
                                                    }
                                                    if socket.write_all(piece).await.is_err() {
                                                        return;
                                                    }
                                                }
                                                return;
                                            }
                                        }
                                    }
                                }
                            }

                            // Full 200 OK fallback
                            let hdr = format!(
                                "HTTP/1.1 200 OK\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\nETag: {etag}\r\nX-Goog-Hash: crc32c={crc_val}\r\nConnection: close\r\n\r\n",
                                payload.len()
                            );
                            let _ = socket.write_all(hdr.as_bytes()).await;
                            let _ = socket.write_all(&payload).await;
                        }
                    }
                });
            }
        });

        (addr, hits, handle)
    }

    #[test]
    fn crate_invariants_and_strict_ssrf_unc_drm_fail_closed() {
        assert_eq!(CRATE_NAME, "omnia-downloader");
        const {
            assert!(!DRM_SUPPORTED);
            assert!(!AUTO_SOLVE_PERMITTED);
        }
        assert_eq!(
            EXECUTION_MODE_MANUAL_VISIBLE_BROWSER,
            "MANUAL_VISIBLE_BROWSER_ONLY"
        );

        let strict = SecurityPolicy::strict();
        assert!(!strict.loopback_allowed());
        for forbidden in [
            "http://127.0.0.1:8080/secret.bin",
            "http://localhost/secret.bin",
            "http://[::1]/secret.bin",
            "http://10.0.0.1/internal.bin",
            "http://192.168.1.5/lan.bin",
            "http://169.254.169.254/latest/meta-data/",
            "https://user:pass@cdn.example.org/file.bin",
        ] {
            assert!(
                strict.validate_url(forbidden).is_err(),
                "strict policy must reject {forbidden}"
            );
        }

        // UNC/SMB, NT device namespaces, and workspace-internal paths must be rejected.
        for bad_path in [
            r"\\server\share\out.bin",
            r"\\?\UNC\server\share\out.bin",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\out.bin",
            r"\\?\Pipe\omnia_pipe",
            r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\out.bin",
            r"\\.\PhysicalDrive0",
        ] {
            assert!(
                matches!(
                    validate_safe_local_path(std::path::Path::new(bad_path), None),
                    Err(DownloaderError::ForbiddenPath { .. })
                ),
                "must reject device/UNC path {bad_path}"
            );
        }
        let sb = TempSandbox::new("ws-block");
        assert!(matches!(
            validate_safe_local_path(&sb.workspace.join("inside"), Some(&sb.workspace)),
            Err(DownloaderError::ForbiddenPath { .. })
        ));

        // Valid verbatim ASCII drive path outside workspace must succeed.
        let verbatim_staging = format!(r"\\?\{}", sb.staging.display());
        assert!(
            validate_safe_local_path(std::path::Path::new(&verbatim_staging), Some(&sb.workspace))
                .is_ok()
        );
    }

    #[cfg(windows)]
    #[test]
    fn path_guard_walks_all_ancestors_catching_intermediate_ntfs_junction() {
        let sb = TempSandbox::new("junction-ancestor");
        let existing_sub = sb.workspace.join("existing_subdir");
        fs::create_dir_all(&existing_sub).unwrap();

        let junction = sb.base.join("junction_to_workspace");
        let status = std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &junction.to_string_lossy(),
                &sb.workspace.to_string_lossy(),
            ])
            .output()
            .expect("invoke mklink /J");
        if !status.status.success() {
            return;
        }

        // Even though `existing_subdir` itself is NOT a reparse point, its parent
        // `junction_to_workspace` IS a reparse point — full ancestor walk MUST reject it!
        let sneaky_path = junction.join("existing_subdir").join("out.part");
        let err = validate_safe_local_path(&sneaky_path, Some(&sb.workspace)).unwrap_err();
        assert!(matches!(
            err,
            DownloaderError::ForbiddenPath {
                reason: "reparse_point_detected",
                ..
            }
        ));

        // Remove junction cleanly before TempSandbox drop.
        let _ = fs::remove_dir(&junction);
    }

    #[tokio::test]
    async fn e2e_loopback_multi_stream_download_pause_resume_and_sha256_verify() {
        let sb = TempSandbox::new("pause-resume");
        // 192 KiB deterministic binary fixture
        let payload: Vec<u8> = (0..196_608u32)
            .map(|i| ((i.wrapping_mul(73) ^ (i >> 5)).wrapping_add(19) & 0xFF) as u8)
            .collect();
        let expected_sha256 = omnia_core::sha256_hex(&payload);
        let expected_crc = crc32c_base64(&payload);

        let (addr, _hits, server_handle) = spawn_mock_http_server(
            Arc::new(payload.clone()),
            "\"strong-fixture-v1\"",
            MockServerBehavior::StandardRange { chunk_delay_ms: 25 },
        )
        .await;
        let url = format!("http://{addr}/archive/fixture.bin");

        let mgr = DownloadManager::in_memory_for_tests(DownloadConfig {
            default_streams: 4,
            min_split_bytes: 8 * 1024,
            ..DownloadConfig::default()
        })
        .unwrap();

        let mut events_rx = mgr.subscribe_events();

        // Phase 1: Start with 4 streams and pause mid-transfer!
        let mut req1 = DownloadRequest::new(&url, &sb.staging);
        req1.workspace_root = Some(sb.workspace.clone());
        req1.streams = Some(4);
        req1.min_split_bytes = Some(8 * 1024);
        req1.expected_sha256 = Some(expected_sha256.clone());

        let (job_id, handle1) = mgr.spawn_download(req1);

        // Wait until we receive at least one progress event with > 0 bytes, then pause.
        let mut saw_progress = false;
        while let Ok(evt) =
            tokio::time::timeout(std::time::Duration::from_secs(5), events_rx.recv()).await
        {
            if let Ok(ev) = evt {
                if ev.job_id == job_id && ev.downloaded_bytes > 0 {
                    saw_progress = true;
                    let _ = mgr.pause_job(&job_id);
                    break;
                }
            }
        }
        assert!(saw_progress, "expected live DownloadProgressEvent before pause");

        let phase1_res = handle1.await.unwrap();
        assert!(
            matches!(phase1_res, Err(DownloaderError::Paused { .. })),
            "expected phase 1 to pause cleanly mid-transfer, got: {phase1_res:?}"
        );

        let part_path = sb.staging.join("fixture.bin.part");
        let meta_path = part_meta_path_for(&part_path);
        let meta = PartMetaV2::load(&meta_path).unwrap();
        assert_eq!(meta.version, 2);
        assert!(meta.completed_bytes() > 0);
        assert!(meta.completed_bytes() < payload.len() as u64);

        // Verify OMNF binary journal also recorded valid CRC32 frames!
        let omnf_state = OmnfJournal::replay_file(&omnf_journal_path_for(&part_path)).unwrap();
        assert!(omnf_state.records_replayed >= 2);
        assert!(!omnf_state.completed_ranges.is_empty());

        // Phase 2: Resume the same file with 12 streams (chunk-count change!)
        let mut req2 = DownloadRequest::new(&url, &sb.staging);
        req2.workspace_root = Some(sb.workspace.clone());
        req2.streams = Some(12);
        req2.min_split_bytes = Some(4 * 1024);
        req2.expected_sha256 = Some(expected_sha256.clone());
        req2.resume = true;

        let done = mgr.download_with_job_id(job_id.clone(), req2).await.unwrap();
        assert_eq!(done.total_bytes, payload.len() as u64);
        assert_eq!(done.sha256_hex, expected_sha256);
        assert_eq!(done.crc32c_b64, expected_crc);
        assert!(done.resumed_bytes > 0);
        assert!(!done.drm_supported);
        assert_eq!(fs::read(&done.output_path).unwrap(), payload);

        // Persisted SQLite snapshot must show Completed + actual digests!
        let snap = mgr.get_job(&job_id).unwrap().unwrap();
        assert_eq!(snap.status, DownloadStatus::Completed);
        assert_eq!(snap.sha256_actual.as_deref(), Some(expected_sha256.as_str()));

        server_handle.abort();
    }

    #[tokio::test]
    async fn e2e_200_ok_range_violation_truncates_and_falls_back_cleanly() {
        let sb = TempSandbox::new("fallback-200");
        let payload: Vec<u8> = (0..65_536u32).map(|i| ((i * 29 + 7) & 0xFF) as u8).collect();
        let expected_sha256 = omnia_core::sha256_hex(&payload);

        let (addr, _hits, server_handle) = spawn_mock_http_server(
            Arc::new(payload.clone()),
            "\"etag-200-fallback\"",
            MockServerBehavior::RangeViolation200Ok,
        )
        .await;

        let mgr = DownloadManager::in_memory_for_tests(DownloadConfig::default()).unwrap();
        let mut req = DownloadRequest::new(format!("http://{addr}/fallback.bin"), &sb.staging);
        req.streams = Some(8);
        req.min_split_bytes = Some(4096);
        req.expected_sha256 = Some(expected_sha256.clone());

        let done = mgr.download_now(req).await.unwrap();
        assert!(done.fallback_to_single_stream);
        assert_eq!(done.streams_used, 1);
        assert_eq!(done.sha256_hex, expected_sha256);
        assert_eq!(fs::read(&done.output_path).unwrap(), payload);

        server_handle.abort();
    }

    #[tokio::test]
    async fn e2e_429_auth_challenge_and_403_acl_are_zero_retry_fail_closed() {
        let sb = TempSandbox::new("fail-closed");

        // 1. 429 AUTH_CHALLENGE_REQUIRED
        let (addr_429, hits_429, h429) = spawn_mock_http_server(
            Arc::new(Vec::new()),
            "\"none\"",
            MockServerBehavior::Challenge429,
        )
        .await;
        let mgr = DownloadManager::in_memory_for_tests(DownloadConfig {
            max_retries: 5,
            ..DownloadConfig::default()
        })
        .unwrap();
        let err_429 = mgr
            .download_now(DownloadRequest::new(
                format!("http://{addr_429}/protected.bin"),
                &sb.staging,
            ))
            .await
            .unwrap_err();
        assert!(matches!(err_429, DownloaderError::AuthChallengeRequired { .. }));
        assert!(!err_429.is_retryable());
        // Probe sends HEAD (429) -> 1 GET to inspect body = 2 total requests, ZERO retries!
        assert!(hits_429.load(Ordering::Relaxed) <= 2);
        assert_eq!(mgr.handoffs().list_tickets().len(), 1);
        assert!(!mgr.handoffs().list_tickets()[0].auto_solve_permitted);
        h429.abort();

        // 2. 403 BLOCKED_ACL_403
        let (addr_403, hits_403, h403) = spawn_mock_http_server(
            Arc::new(Vec::new()),
            "\"none\"",
            MockServerBehavior::BlockedAcl403,
        )
        .await;
        let err_403 = mgr
            .download_now(DownloadRequest::new(
                format!("http://{addr_403}/view-only.pdf"),
                &sb.staging,
            ))
            .await
            .unwrap_err();
        assert!(matches!(
            err_403,
            DownloaderError::BlockedAcl403 {
                can_download: false,
                ..
            }
        ));
        assert!(!err_403.is_retryable());
        assert!(hits_403.load(Ordering::Relaxed) <= 2);
        h403.abort();
    }

    #[tokio::test]
    async fn e2e_fallback_error_persists_terminal_status_in_sqlite() {
        let sb = TempSandbox::new("fallback-terminal");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        // Mock server: HEAD advertises Accept-Ranges: bytes (size 16384);
        // ranged GET violates with 200 OK -> triggers fallback single-stream GET;
        // fallback single-stream GET (without Range header) returns 403 Forbidden ACL!
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = match sock.read(&mut buf).await {
                        Ok(n) if n > 0 => n,
                        _ => return,
                    };
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let method = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().next())
                        .unwrap_or("GET");
                    let has_range = req.lines().any(|l| {
                        l.split_once(':')
                            .is_some_and(|(k, _)| k.eq_ignore_ascii_case("range"))
                    });
                    if method == "HEAD" {
                        let resp = "HTTP/1.1 200 OK\r\nAccept-Ranges: bytes\r\nContent-Length: 16384\r\nETag: \"fb-v1\"\r\nConnection: close\r\n\r\n";
                        let _ = sock.write_all(resp.as_bytes()).await;
                    } else if has_range {
                        // Violate Range with 200 OK to force fallback to single-stream!
                        let resp = "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nfull";
                        let _ = sock.write_all(resp.as_bytes()).await;
                    } else {
                        // Single-stream fallback encounters 403 ACL block!
                        let body = r#"{"error":{"reason":"cannotDownloadFile"}}"#;
                        let resp = format!(
                            "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = sock.write_all(resp.as_bytes()).await;
                    }
                });
            }
        });

        let mgr = DownloadManager::in_memory_for_tests(DownloadConfig::default()).unwrap();
        let job_id = "job-fallback-err-1".to_string();
        let mut req = DownloadRequest::new(format!("http://{addr}/fail_fallback.bin"), &sb.staging);
        req.streams = Some(4);
        req.min_split_bytes = Some(1024);

        let err = mgr
            .download_with_job_id(job_id.clone(), req)
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            DownloaderError::BlockedAcl403 {
                can_download: false,
                ..
            }
        ));

        // Defect #5 verification: SQLite MUST reflect BlockedPolicy, NEVER stuck in Downloading!
        let snap = mgr.get_job(&job_id).unwrap().unwrap();
        assert_eq!(snap.status, DownloadStatus::BlockedPolicy);
        assert_eq!(snap.error_code.as_deref(), Some("BLOCKED_ACL_403"));

        server.abort();
    }
}
