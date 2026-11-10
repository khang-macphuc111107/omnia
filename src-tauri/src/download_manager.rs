//! Native, broker-fed download queue.
//!
//! The browser/attachment broker owns request URLs, cookies, headers, and
//! response streams.  This module deliberately receives only an opaque source
//! receipt id and bounded byte chunks.  It provides the IDM-like queue
//! lifecycle (start, pause, resume, cancel, complete) without exposing browser
//! credentials or raw network material to the renderer.

use std::sync::{Arc, Mutex};

use chrono::Utc;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    content_store::{BlobCommitOutcome, BlobDescriptor},
    error::{NativeError, NativeResult},
    state::AppState,
};

const MAX_JOB_ID_BYTES: usize = 128;
const MAX_SOURCE_RECEIPT_ID_BYTES: usize = 256;
const MAX_FILENAME_BYTES: usize = 512;
const MAX_MEDIA_TYPE_BYTES: usize = 255;
pub(crate) const MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum DownloadJobState {
    Queued,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJobView {
    pub job_id: String,
    pub source_receipt_id: String,
    pub output_filename: String,
    pub media_type: String,
    pub state: DownloadJobState,
    pub received_bytes: u64,
    pub expected_bytes: Option<u64>,
    pub checkpoint_bytes: u64,
    pub created_at: String,
    pub updated_at: String,
    pub output_blob_id: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Debug)]
struct DownloadJobRuntime {
    view: DownloadJobView,
    bytes: Vec<u8>,
    output_descriptor: Option<BlobDescriptor>,
}

#[derive(Default)]
pub struct DownloadManager {
    jobs: DashMap<String, Arc<Mutex<DownloadJobRuntime>>>,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create(&self, request: CreateDownloadJobRequest) -> NativeResult<DownloadJobView> {
        let source_receipt_id = bounded_non_blank(
            request.source_receipt_id,
            "sourceReceiptId",
            MAX_SOURCE_RECEIPT_ID_BYTES,
        )?;
        let output_filename = validate_filename(request.output_filename)?;
        let media_type = validate_media_type(request.media_type)?;
        if let Some(expected) = request.expected_bytes {
            validate_size(expected, "expectedBytes")?;
        }
        let now = Utc::now().to_rfc3339();
        let job_id = format!("download-{}", Uuid::new_v4());
        let view = DownloadJobView {
            job_id: job_id.clone(),
            source_receipt_id,
            output_filename,
            media_type,
            state: DownloadJobState::Queued,
            received_bytes: 0,
            expected_bytes: request.expected_bytes,
            checkpoint_bytes: 0,
            created_at: now.clone(),
            updated_at: now,
            output_blob_id: None,
            error_code: None,
        };
        self.jobs.insert(
            job_id,
            Arc::new(Mutex::new(DownloadJobRuntime {
                view: view.clone(),
                bytes: Vec::new(),
                output_descriptor: None,
            })),
        );
        Ok(view)
    }

    pub fn start(&self, job_id: String) -> NativeResult<DownloadJobView> {
        self.transition(job_id, DownloadJobState::Queued, DownloadJobState::Running)
    }

    pub fn pause(&self, job_id: String) -> NativeResult<DownloadJobView> {
        self.transition(job_id, DownloadJobState::Running, DownloadJobState::Paused)
    }

    pub fn resume(&self, job_id: String) -> NativeResult<DownloadJobView> {
        self.transition(job_id, DownloadJobState::Paused, DownloadJobState::Running)
    }

    pub fn cancel(&self, job_id: String) -> NativeResult<DownloadJobView> {
        let runtime = self.get(&job_id)?;
        let mut runtime = lock_runtime(&runtime)?;
        match runtime.view.state {
            DownloadJobState::Queued | DownloadJobState::Running | DownloadJobState::Paused => {
                runtime.view.state = DownloadJobState::Cancelled;
                runtime.view.updated_at = Utc::now().to_rfc3339();
                Ok(runtime.view.clone())
            }
            _ => Err(invalid_transition(
                &runtime.view,
                DownloadJobState::Cancelled,
            )),
        }
    }

    pub fn append_chunk(
        &self,
        request: AppendDownloadChunkRequest,
    ) -> NativeResult<DownloadJobView> {
        if request.chunk.is_empty() {
            return Err(NativeError::invalid("chunk", "must not be empty"));
        }
        if request.chunk.len() > MAX_CHUNK_BYTES {
            return Err(NativeError::new(
                "download_chunk_too_large",
                format!("Download chunks cannot exceed {MAX_CHUNK_BYTES} bytes"),
            ));
        }
        let runtime = self.get(&request.job_id)?;
        let mut runtime = lock_runtime(&runtime)?;
        if runtime.view.state != DownloadJobState::Running {
            return Err(invalid_transition(&runtime.view, DownloadJobState::Running));
        }
        let current = runtime.bytes.len() as u64;
        let next = current
            .checked_add(request.chunk.len() as u64)
            .ok_or_else(|| NativeError::new("download_size_invalid", "Download size overflowed"))?;
        validate_size(next, "receivedBytes")?;
        if let Some(expected) = runtime.view.expected_bytes {
            if next > expected {
                return Err(NativeError::new(
                    "download_size_exceeded",
                    "Received bytes exceed the broker-declared size",
                ));
            }
        }
        runtime.bytes.extend_from_slice(&request.chunk);
        runtime.view.received_bytes = next;
        runtime.view.checkpoint_bytes = next;
        runtime.view.updated_at = Utc::now().to_rfc3339();
        Ok(runtime.view.clone())
    }

    pub fn complete(&self, state: &AppState, job_id: String) -> NativeResult<DownloadJobView> {
        let runtime = self.get(&job_id)?;
        let mut runtime = lock_runtime(&runtime)?;
        if runtime.view.state != DownloadJobState::Running {
            return Err(invalid_transition(&runtime.view, DownloadJobState::Running));
        }
        if let Some(expected) = runtime.view.expected_bytes {
            if runtime.view.received_bytes != expected {
                return Err(NativeError::new(
                    "download_incomplete",
                    "The broker-declared byte count has not been reached",
                ));
            }
        }
        let prepared = state.content_store.prepare_bytes(
            &state.blob_keys,
            &runtime.view.media_type,
            &runtime.bytes,
        )?;
        let descriptor = prepared.descriptor().clone();
        let committed = prepared.commit()?;
        let blob_id = match &committed {
            BlobCommitOutcome::Published(descriptor) => descriptor.id.clone(),
            BlobCommitOutcome::AlreadyExists { id, .. } => id.clone(),
        };
        runtime.output_descriptor = Some(descriptor);
        runtime.view.output_blob_id = Some(blob_id);
        runtime.view.state = DownloadJobState::Completed;
        runtime.view.updated_at = Utc::now().to_rfc3339();
        Ok(runtime.view.clone())
    }

    pub fn get_view(&self, job_id: String) -> NativeResult<DownloadJobView> {
        let runtime = self.get(&job_id)?;
        let guard = lock_runtime(&runtime)?;
        Ok(guard.view.clone())
    }

    pub fn list(&self) -> Vec<DownloadJobView> {
        let mut jobs: Vec<_> = self
            .jobs
            .iter()
            .filter_map(|entry| {
                entry
                    .value()
                    .lock()
                    .ok()
                    .map(|runtime| runtime.view.clone())
            })
            .collect();
        jobs.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        jobs
    }

    fn transition(
        &self,
        job_id: String,
        from: DownloadJobState,
        to: DownloadJobState,
    ) -> NativeResult<DownloadJobView> {
        let runtime = self.get(&job_id)?;
        let mut runtime = lock_runtime(&runtime)?;
        if runtime.view.state != from {
            return Err(invalid_transition(&runtime.view, from));
        }
        runtime.view.state = to;
        runtime.view.updated_at = Utc::now().to_rfc3339();
        Ok(runtime.view.clone())
    }

    fn get(&self, job_id: &str) -> NativeResult<Arc<Mutex<DownloadJobRuntime>>> {
        bounded_non_blank(job_id.to_owned(), "jobId", MAX_JOB_ID_BYTES)?;
        self.jobs
            .get(job_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or_else(|| {
                NativeError::new("download_job_not_found", "The download job does not exist")
            })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateDownloadJobRequest {
    pub source_receipt_id: String,
    pub output_filename: String,
    pub media_type: String,
    pub expected_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadJobRequest {
    pub job_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppendDownloadChunkRequest {
    pub job_id: String,
    pub chunk: Vec<u8>,
}

fn lock_runtime(
    runtime: &Arc<Mutex<DownloadJobRuntime>>,
) -> NativeResult<std::sync::MutexGuard<'_, DownloadJobRuntime>> {
    runtime
        .lock()
        .map_err(|_| NativeError::new("download_state_poisoned", "Download state is unavailable"))
}

fn invalid_transition(view: &DownloadJobView, expected: DownloadJobState) -> NativeError {
    NativeError::new(
        "download_invalid_transition",
        format!("Download job is {:?}; expected {:?}", view.state, expected),
    )
}

fn bounded_non_blank(value: String, field: &'static str, max_bytes: usize) -> NativeResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max_bytes {
        return Err(NativeError::invalid(
            field,
            "is blank or exceeds its size limit",
        ));
    }
    Ok(trimmed.to_owned())
}

fn validate_size(value: u64, field: &'static str) -> NativeResult<()> {
    if value > MAX_DOWNLOAD_BYTES {
        return Err(NativeError::invalid(
            field,
            "exceeds the native download limit",
        ));
    }
    Ok(())
}

fn validate_filename(value: String) -> NativeResult<String> {
    let filename = bounded_non_blank(value, "outputFilename", MAX_FILENAME_BYTES)?;
    if filename == "."
        || filename == ".."
        || filename
            .chars()
            .any(|character| matches!(character, '/' | '\\' | ':'))
    {
        return Err(NativeError::invalid(
            "outputFilename",
            "must be a plain filename without path separators",
        ));
    }
    Ok(filename)
}

fn validate_media_type(value: String) -> NativeResult<String> {
    let media_type =
        bounded_non_blank(value, "mediaType", MAX_MEDIA_TYPE_BYTES)?.to_ascii_lowercase();
    let mut parts = media_type.split('/');
    let valid = parts.next().is_some_and(|part| !part.is_empty())
        && parts.next().is_some_and(|part| !part.is_empty())
        && parts.next().is_none()
        && media_type
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$&^_.+-/".contains(&byte));
    if !valid {
        return Err(NativeError::invalid(
            "mediaType",
            "must be a canonical MIME type",
        ));
    }
    Ok(media_type)
}

#[tauri::command]
pub fn download_job_create(
    state: tauri::State<'_, AppState>,
    request: CreateDownloadJobRequest,
) -> NativeResult<DownloadJobView> {
    state.downloads.create(request)
}

#[tauri::command]
pub fn download_job_start(
    state: tauri::State<'_, AppState>,
    request: DownloadJobRequest,
) -> NativeResult<DownloadJobView> {
    state.downloads.start(request.job_id)
}

#[tauri::command]
pub fn download_job_pause(
    state: tauri::State<'_, AppState>,
    request: DownloadJobRequest,
) -> NativeResult<DownloadJobView> {
    state.downloads.pause(request.job_id)
}

#[tauri::command]
pub fn download_job_resume(
    state: tauri::State<'_, AppState>,
    request: DownloadJobRequest,
) -> NativeResult<DownloadJobView> {
    state.downloads.resume(request.job_id)
}

#[tauri::command]
pub fn download_job_cancel(
    state: tauri::State<'_, AppState>,
    request: DownloadJobRequest,
) -> NativeResult<DownloadJobView> {
    state.downloads.cancel(request.job_id)
}

#[tauri::command]
pub fn download_job_append_chunk(
    state: tauri::State<'_, AppState>,
    request: AppendDownloadChunkRequest,
) -> NativeResult<DownloadJobView> {
    state.downloads.append_chunk(request)
}

#[tauri::command]
pub fn download_job_complete(
    state: tauri::State<'_, AppState>,
    request: DownloadJobRequest,
) -> NativeResult<DownloadJobView> {
    state.downloads.complete(&state, request.job_id)
}

#[tauri::command]
pub fn download_job_get(
    state: tauri::State<'_, AppState>,
    request: DownloadJobRequest,
) -> NativeResult<DownloadJobView> {
    state.downloads.get_view(request.job_id)
}

#[tauri::command]
pub fn download_job_list(state: tauri::State<'_, AppState>) -> NativeResult<Vec<DownloadJobView>> {
    Ok(state.downloads.list())
}

// ============================================================================
// Ultra IDM+ Native Helpers: M3U8 Parser, Dynamic Byte-Range Splitting & Merger
// ============================================================================

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsByteRange {
    pub length: u64,
    pub offset: u64,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsEncryptionKey {
    pub method: String,
    pub uri: Option<String>,
    pub resolved_uri: Option<String>,
    pub iv: Option<String>,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsMapInitSegment {
    pub uri: String,
    pub resolved_uri: String,
    pub byte_range: Option<HlsByteRange>,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsVariantStream {
    pub uri: String,
    pub resolved_url: String,
    pub bandwidth: u64,
    pub average_bandwidth: Option<u64>,
    pub resolution: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<f64>,
    pub codecs: Option<String>,
    pub audio_group_id: Option<String>,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsMediaRendition {
    pub media_type: String,
    pub group_id: String,
    pub name: String,
    pub language: Option<String>,
    pub uri: Option<String>,
    pub resolved_url: Option<String>,
    pub is_default: bool,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsMediaSegment {
    pub index: usize,
    pub sequence_number: u64,
    pub duration_secs: f64,
    pub title: String,
    pub uri: String,
    pub resolved_url: String,
    pub byte_range: Option<HlsByteRange>,
    pub discontinuity: bool,
    pub key: Option<HlsEncryptionKey>,
    pub map: Option<HlsMapInitSegment>,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsPlaylistManifest {
    pub is_valid_m3u8: bool,
    pub is_master_playlist: bool,
    pub version: Option<u32>,
    pub target_duration: Option<f64>,
    pub media_sequence: u64,
    pub playlist_type: Option<String>,
    pub has_end_list: bool,
    pub total_duration_secs: f64,
    pub init_segment: Option<HlsMapInitSegment>,
    pub encryption_keys: Vec<HlsEncryptionKey>,
    pub variants: Vec<HlsVariantStream>,
    pub renditions: Vec<HlsMediaRendition>,
    pub segments: Vec<HlsMediaSegment>,
}

#[cfg(test)]
fn resolve_manifest_url(raw_uri: &str, base_url: Option<&str>) -> String {
    let trimmed = raw_uri.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("blob:")
        || trimmed.starts_with("data:")
    {
        return trimmed.to_owned();
    }
    if let Some(base) = base_url {
        if let Ok(parsed_base) = url::Url::parse(base.trim()) {
            if let Ok(joined) = parsed_base.join(trimmed) {
                return joined.to_string();
            }
        }
    }
    trimmed.to_owned()
}

#[cfg(test)]
fn parse_m3u8_attributes(attr_line: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let bytes = attr_line.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        while i < bytes.len() && (bytes[i] == b',' || bytes[i].is_ascii_whitespace()) {
            i += 1;
        }
        let key_start = i;
        while i < bytes.len() && bytes[i] != b'=' && bytes[i] != b',' {
            i += 1;
        }
        let key = attr_line[key_start..i].trim().to_ascii_uppercase();
        if i >= bytes.len() || bytes[i] != b'=' {
            i += 1;
            continue;
        }
        i += 1; // skip '='
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let value = if i < bytes.len() && bytes[i] == b'"' {
            i += 1;
            let val_start = i;
            while i < bytes.len() && bytes[i] != b'"' {
                i += 1;
            }
            let v = &attr_line[val_start..i];
            if i < bytes.len() {
                i += 1;
            }
            v.trim().to_owned()
        } else {
            let val_start = i;
            while i < bytes.len() && bytes[i] != b',' {
                i += 1;
            }
            attr_line[val_start..i].trim().to_owned()
        };
        if !key.is_empty() {
            map.insert(key, value);
        }
    }

    map
}

#[cfg(test)]
fn parse_hls_byterange(raw: &str, previous_end: u64) -> Option<(HlsByteRange, u64)> {
    let cleaned = raw.trim().trim_matches('"');
    let mut parts = cleaned.split('@');
    let length = parts.next()?.trim().parse::<u64>().ok()?;
    if length == 0 {
        return None;
    }
    let offset = match parts.next() {
        Some(off_str) => off_str.trim().parse::<u64>().ok()?,
        None => previous_end,
    };
    Some((
        HlsByteRange { length, offset },
        offset.saturating_add(length),
    ))
}

#[cfg(test)]
/// Parses an HLS (`.m3u8`) Master or Media playlist into structured variants, renditions,
/// encryption descriptors, init segments, and media segments.
pub fn parse_hls_playlist_manifest(
    manifest_text: &str,
    base_url: Option<&str>,
) -> NativeResult<HlsPlaylistManifest> {
    let lines: Vec<&str> = manifest_text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();

    let is_valid_m3u8 = lines.iter().any(|line| line.starts_with("#EXTM3U"));
    if !is_valid_m3u8 {
        return Err(NativeError::invalid(
            "manifestText",
            "must begin with #EXTM3U header",
        ));
    }

    let mut version: Option<u32> = None;
    let mut target_duration: Option<f64> = None;
    let mut media_sequence: u64 = 0;
    let mut playlist_type: Option<String> = None;
    let mut has_end_list = false;
    let mut active_init_segment: Option<HlsMapInitSegment> = None;
    let mut active_key: Option<HlsEncryptionKey> = None;
    let mut encryption_keys: Vec<HlsEncryptionKey> = Vec::new();
    let mut variants: Vec<HlsVariantStream> = Vec::new();
    let mut renditions: Vec<HlsMediaRendition> = Vec::new();
    let mut segments: Vec<HlsMediaSegment> = Vec::new();

    let mut pending_stream_inf: Option<std::collections::HashMap<String, String>> = None;
    let mut pending_extinf: Option<(f64, String)> = None;
    let mut pending_byte_range: Option<HlsByteRange> = None;
    let mut pending_discontinuity = false;
    let mut last_byterange_end: u64 = 0;

    for line in lines {
        if line.starts_with('#') {
            if let Some(rest) = line.strip_prefix("#EXT-X-VERSION:") {
                version = rest.trim().parse::<u32>().ok();
            } else if let Some(rest) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
                target_duration = rest.trim().parse::<f64>().ok();
            } else if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
                if let Ok(seq) = rest.trim().parse::<u64>() {
                    media_sequence = seq;
                }
            } else if let Some(rest) = line.strip_prefix("#EXT-X-PLAYLIST-TYPE:") {
                playlist_type = Some(rest.trim().to_ascii_uppercase());
            } else if line == "#EXT-X-ENDLIST" {
                has_end_list = true;
            } else if line == "#EXT-X-DISCONTINUITY" {
                pending_discontinuity = true;
            } else if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
                pending_stream_inf = Some(parse_m3u8_attributes(rest));
            } else if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA:") {
                let attrs = parse_m3u8_attributes(rest);
                let uri = attrs.get("URI").cloned();
                let resolved_url = uri.as_deref().map(|u| resolve_manifest_url(u, base_url));
                renditions.push(HlsMediaRendition {
                    media_type: attrs
                        .get("TYPE")
                        .cloned()
                        .unwrap_or_else(|| "AUDIO".to_owned()),
                    group_id: attrs
                        .get("GROUP-ID")
                        .cloned()
                        .unwrap_or_else(|| "default".to_owned()),
                    name: attrs
                        .get("NAME")
                        .cloned()
                        .unwrap_or_else(|| "Track".to_owned()),
                    language: attrs.get("LANGUAGE").cloned(),
                    uri,
                    resolved_url,
                    is_default: attrs
                        .get("DEFAULT")
                        .is_some_and(|v| v.eq_ignore_ascii_case("YES")),
                });
            } else if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
                let attrs = parse_m3u8_attributes(rest);
                if let Some(uri) = attrs.get("URI") {
                    let byte_range = attrs
                        .get("BYTERANGE")
                        .and_then(|br| parse_hls_byterange(br, 0).map(|(r, _)| r));
                    active_init_segment = Some(HlsMapInitSegment {
                        uri: uri.clone(),
                        resolved_uri: resolve_manifest_url(uri, base_url),
                        byte_range,
                    });
                }
            } else if let Some(rest) = line.strip_prefix("#EXT-X-KEY:") {
                let attrs = parse_m3u8_attributes(rest);
                let method = attrs
                    .get("METHOD")
                    .cloned()
                    .unwrap_or_else(|| "NONE".to_owned())
                    .to_ascii_uppercase();
                if method == "NONE" {
                    active_key = None;
                } else {
                    let uri = attrs.get("URI").cloned();
                    let resolved_uri = uri.as_deref().map(|u| resolve_manifest_url(u, base_url));
                    let key_entry = HlsEncryptionKey {
                        method,
                        uri,
                        resolved_uri,
                        iv: attrs.get("IV").cloned(),
                    };
                    encryption_keys.push(key_entry.clone());
                    active_key = Some(key_entry);
                }
            } else if let Some(rest) = line.strip_prefix("#EXT-X-BYTERANGE:") {
                if let Some((br, next_end)) = parse_hls_byterange(rest, last_byterange_end) {
                    pending_byte_range = Some(br);
                    last_byterange_end = next_end;
                }
            } else if let Some(rest) = line.strip_prefix("#EXTINF:") {
                let mut parts = rest.splitn(2, ',');
                let dur = parts
                    .next()
                    .and_then(|d| d.trim().parse::<f64>().ok())
                    .unwrap_or(0.0);
                let title = parts.next().unwrap_or("").trim().to_owned();
                pending_extinf = Some((dur, title));
            }
            continue;
        }

        if let Some(attrs) = pending_stream_inf.take() {
            let bandwidth = attrs
                .get("BANDWIDTH")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            let average_bandwidth = attrs
                .get("AVERAGE-BANDWIDTH")
                .and_then(|v| v.parse::<u64>().ok());
            let resolution = attrs.get("RESOLUTION").cloned();
            let (width, height) = resolution
                .as_deref()
                .and_then(|res| {
                    let mut split = res.split(&['x', 'X'][..]);
                    let w = split.next()?.parse::<u32>().ok()?;
                    let h = split.next()?.parse::<u32>().ok()?;
                    Some((Some(w), Some(h)))
                })
                .unwrap_or((None, None));
            let frame_rate = attrs.get("FRAME-RATE").and_then(|v| v.parse::<f64>().ok());

            variants.push(HlsVariantStream {
                uri: line.to_owned(),
                resolved_url: resolve_manifest_url(line, base_url),
                bandwidth,
                average_bandwidth,
                resolution,
                width,
                height,
                frame_rate,
                codecs: attrs.get("CODECS").cloned(),
                audio_group_id: attrs.get("AUDIO").cloned(),
            });
            continue;
        }

        let index = segments.len();
        let sequence_number = media_sequence + index as u64;
        let (duration_secs, title) = pending_extinf
            .take()
            .unwrap_or((target_duration.unwrap_or(0.0), String::new()));

        segments.push(HlsMediaSegment {
            index,
            sequence_number,
            duration_secs,
            title,
            uri: line.to_owned(),
            resolved_url: resolve_manifest_url(line, base_url),
            byte_range: pending_byte_range.take(),
            discontinuity: pending_discontinuity,
            key: active_key.clone(),
            map: active_init_segment.clone(),
        });
        pending_discontinuity = false;
    }

    variants.sort_by(|a, b| {
        let pixels_a = u64::from(a.width.unwrap_or(0)) * u64::from(a.height.unwrap_or(0));
        let pixels_b = u64::from(b.width.unwrap_or(0)) * u64::from(b.height.unwrap_or(0));
        pixels_b
            .cmp(&pixels_a)
            .then_with(|| b.bandwidth.cmp(&a.bandwidth))
    });

    let total_duration_secs: f64 = segments.iter().map(|seg| seg.duration_secs).sum();
    let is_master_playlist = !variants.is_empty();

    Ok(HlsPlaylistManifest {
        is_valid_m3u8,
        is_master_playlist,
        version,
        target_duration,
        media_sequence,
        playlist_type,
        has_end_list,
        total_duration_secs,
        init_segment: active_init_segment,
        encryption_keys,
        variants,
        renditions,
        segments,
    })
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ByteRangeSegmentState {
    Queued,
    Downloading,
    Paused,
    Completed,
    Failed,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteRangeSegment {
    pub id: String,
    pub index: usize,
    pub start_byte: u64,
    pub end_byte: u64,
    pub current_byte: u64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub state: ByteRangeSegmentState,
    pub is_stolen_split: bool,
    pub parent_segment_id: Option<String>,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkStealSplitOutcome {
    pub source_segment_id: String,
    pub new_segment_id: String,
    pub split_midpoint_byte: u64,
    pub stolen_start_byte: u64,
    pub stolen_end_byte: u64,
    pub stolen_bytes: u64,
}

#[cfg(test)]
/// Plans `1..=32` initial inclusive HTTP byte-range segments (`[start_byte, end_byte]`)
/// for a file of `total_bytes`.
pub fn plan_byte_range_segments(
    total_bytes: u64,
    max_connections: usize,
    min_segment_bytes: u64,
) -> NativeResult<Vec<ByteRangeSegment>> {
    if total_bytes == 0 {
        return Err(NativeError::invalid(
            "totalBytes",
            "must be greater than zero",
        ));
    }
    let clamped_connections = max_connections.clamp(1, 32) as u64;
    let effective_min = min_segment_bytes.max(1);
    let max_by_min_size = (total_bytes / effective_min).max(1);
    let segment_count = clamped_connections.min(total_bytes).min(max_by_min_size);

    let base_len = total_bytes / segment_count;
    let remainder = total_bytes % segment_count;

    let mut segments = Vec::with_capacity(segment_count as usize);
    let mut cursor = 0_u64;

    for i in 0..segment_count {
        let seg_len = base_len + u64::from(i < remainder);
        let start_byte = cursor;
        let end_byte = start_byte + seg_len - 1;
        cursor = end_byte + 1;

        segments.push(ByteRangeSegment {
            id: format!("seg-{}", i + 1),
            index: i as usize,
            start_byte,
            end_byte,
            current_byte: start_byte,
            downloaded_bytes: 0,
            total_bytes: seg_len,
            state: ByteRangeSegmentState::Downloading,
            is_stolen_split: false,
            parent_segment_id: None,
        });
    }

    Ok(segments)
}

#[cfg(test)]
/// True IDM Dynamic In-Flight Work-Stealing Split:
/// Finds the active segment with the largest remaining byte range (`end_byte - current_byte >= 2 * min_split_bytes`)
/// and splits its remaining range `[current_byte, end_byte]` at `midpoint` into two contiguous segments.
pub fn split_largest_remaining_segment(
    segments: &mut Vec<ByteRangeSegment>,
    min_split_bytes: u64,
) -> Option<WorkStealSplitOutcome> {
    let min_span = min_split_bytes.max(1).saturating_mul(2);

    let mut best_pos: Option<usize> = None;
    let mut best_remaining_span: u64 = 0;

    for (idx, seg) in segments.iter().enumerate() {
        if !matches!(
            seg.state,
            ByteRangeSegmentState::Downloading
                | ByteRangeSegmentState::Queued
                | ByteRangeSegmentState::Paused
        ) {
            continue;
        }
        let current_byte = seg.start_byte.saturating_add(seg.downloaded_bytes);
        if seg.end_byte <= current_byte {
            continue;
        }
        let remaining_span = seg.end_byte - current_byte;
        if remaining_span < min_span {
            continue;
        }
        if best_pos.is_none() || remaining_span > best_remaining_span {
            best_pos = Some(idx);
            best_remaining_span = remaining_span;
        }
    }

    let pos = best_pos?;
    let next_id_num = segments.len() + 1;
    let target = &mut segments[pos];
    let source_segment_id = target.id.clone();
    let current_byte = target.start_byte.saturating_add(target.downloaded_bytes);
    let original_end_byte = target.end_byte;
    let midpoint = current_byte + (original_end_byte - current_byte) / 2;
    let stolen_start_byte = midpoint + 1;
    let stolen_end_byte = original_end_byte;
    let stolen_bytes = stolen_end_byte - stolen_start_byte + 1;

    target.end_byte = midpoint;
    target.current_byte = current_byte;
    target.total_bytes = midpoint - target.start_byte + 1;

    let new_segment_id = format!("seg-{next_id_num}-stolen");
    let stolen_segment = ByteRangeSegment {
        id: new_segment_id.clone(),
        index: pos + 1,
        start_byte: stolen_start_byte,
        end_byte: stolen_end_byte,
        current_byte: stolen_start_byte,
        downloaded_bytes: 0,
        total_bytes: stolen_bytes,
        state: ByteRangeSegmentState::Downloading,
        is_stolen_split: true,
        parent_segment_id: Some(source_segment_id.clone()),
    };

    segments.insert(pos + 1, stolen_segment);
    for (idx, seg) in segments.iter_mut().enumerate() {
        seg.index = idx;
    }

    Some(WorkStealSplitOutcome {
        source_segment_id,
        new_segment_id,
        split_midpoint_byte: midpoint,
        stolen_start_byte,
        stolen_end_byte,
        stolen_bytes,
    })
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderedSegmentBuffer {
    pub index: usize,
    pub start_byte: u64,
    pub end_byte: u64,
    pub bytes: Vec<u8>,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedSegmentOutcome {
    pub bytes: Vec<u8>,
    pub total_bytes: u64,
    pub segment_count: usize,
    pub prepended_init_bytes: usize,
    pub sha256_hex: String,
    pub container_format: String,
}

#[cfg(test)]
fn detect_container_signature(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 8 {
        let box_tag = &bytes[4..8];
        if box_tag == b"ftyp"
            || box_tag == b"moof"
            || box_tag == b"styp"
            || box_tag == b"moov"
            || box_tag == b"mdat"
        {
            return "MP4/fMP4";
        }
        if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
            return "PNG";
        }
    }
    if bytes.len() >= 4 {
        if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
            return "WebM/MKV";
        }
        if bytes.starts_with(b"%PDF") {
            return "PDF";
        }
        if bytes.starts_with(&[b'P', b'K', 0x03, 0x04]) {
            return "ZIP";
        }
    }
    if bytes.len() >= 3 && bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return "JPEG";
    }
    if !bytes.is_empty() && bytes[0] == 0x47 && (bytes.len() < 189 || bytes[188] == 0x47) {
        return "MPEG-TS";
    }
    "UNKNOWN"
}

#[cfg(test)]
/// Verifies contiguity of ordered byte-range segment buffers, prepends an optional initialization
/// header (`#EXT-X-MAP`), merges them into a single buffer, and computes SHA-256 + container format.
pub fn merge_ordered_segments(
    segments: &[OrderedSegmentBuffer],
    expected_total_bytes: Option<u64>,
    init_segment: Option<&[u8]>,
) -> NativeResult<MergedSegmentOutcome> {
    use sha2::{Digest, Sha256};

    if segments.is_empty() {
        return Err(NativeError::invalid("segments", "must not be empty"));
    }

    let mut sorted: Vec<&OrderedSegmentBuffer> = segments.iter().collect();
    sorted.sort_by_key(|seg| seg.start_byte);

    let mut expected_cursor = 0_u64;
    for seg in &sorted {
        if seg.start_byte != expected_cursor {
            return Err(NativeError::new(
                "download_segment_non_contiguous",
                format!(
                    "Segment #{} starts at byte {}, expected {}",
                    seg.index, seg.start_byte, expected_cursor
                ),
            ));
        }
        let declared_len = seg
            .end_byte
            .checked_sub(seg.start_byte)
            .and_then(|d| d.checked_add(1))
            .ok_or_else(|| NativeError::invalid("endByte", "range underflow"))?;
        if seg.bytes.len() as u64 != declared_len {
            return Err(NativeError::new(
                "download_segment_length_mismatch",
                format!(
                    "Segment #{} has {} bytes, declared {}",
                    seg.index,
                    seg.bytes.len(),
                    declared_len
                ),
            ));
        }
        expected_cursor = seg.end_byte + 1;
    }

    if let Some(expected) = expected_total_bytes {
        if expected_cursor != expected {
            return Err(NativeError::new(
                "download_incomplete",
                format!("Merged segment bytes ({expected_cursor}) != expected ({expected})"),
            ));
        }
    }

    let init_bytes = init_segment.unwrap_or(&[]);
    let total_capacity = init_bytes.len() + expected_cursor as usize;
    let mut merged = Vec::with_capacity(total_capacity);
    merged.extend_from_slice(init_bytes);
    for seg in &sorted {
        merged.extend_from_slice(&seg.bytes);
    }

    let mut hasher = Sha256::new();
    hasher.update(&merged);
    let digest = hasher.finalize();
    let sha256_hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    let container_format = detect_container_signature(&merged).to_owned();

    Ok(MergedSegmentOutcome {
        total_bytes: merged.len() as u64,
        bytes: merged,
        segment_count: sorted.len(),
        prepended_init_bytes: init_bytes.len(),
        sha256_hex,
        container_format,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hls_master_and_media_manifests() {
        let master = "\
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac\",NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,URI=\"audio/en.m3u8\"
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS=\"avc1.64001f\"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=15000000,RESOLUTION=3840x2160,CODECS=\"hev1.1.6\"
2160p/index.m3u8
";
        let parsed_master =
            parse_hls_playlist_manifest(master, Some("https://stream.example.com/vod/master.m3u8"))
                .expect("valid master m3u8");
        assert!(parsed_master.is_master_playlist);
        assert_eq!(parsed_master.variants.len(), 2);
        assert_eq!(parsed_master.variants[0].height, Some(2160));
        assert_eq!(
            parsed_master.variants[0].resolved_url,
            "https://stream.example.com/vod/2160p/index.m3u8"
        );
        assert_eq!(parsed_master.renditions.len(), 1);

        let media = "\
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"512@0\"
#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x01
#EXTINF:4.0,Seg10
seg10.m4s
#EXTINF:3.5,Seg11
seg11.m4s
#EXT-X-ENDLIST
";
        let parsed_media = parse_hls_playlist_manifest(
            media,
            Some("https://stream.example.com/vod/2160p/index.m3u8"),
        )
        .expect("valid media m3u8");
        assert!(!parsed_media.is_master_playlist);
        assert!(parsed_media.has_end_list);
        assert_eq!(parsed_media.segments.len(), 2);
        assert_eq!(parsed_media.segments[0].sequence_number, 10);
        assert_eq!(
            parsed_media
                .init_segment
                .as_ref()
                .map(|m| m.resolved_uri.as_str()),
            Some("https://stream.example.com/vod/2160p/init.mp4")
        );
    }

    #[test]
    fn plans_and_dynamically_work_steal_splits_byte_ranges() {
        let mut segments = plan_byte_range_segments(1_000_000, 4, 65_536).expect("plan segments");
        assert_eq!(segments.len(), 4);
        assert_eq!(segments[0].start_byte, 0);
        assert_eq!(segments[0].end_byte, 249_999);
        assert_eq!(segments[3].start_byte, 750_000);
        assert_eq!(segments[3].end_byte, 999_999);

        segments[0].state = ByteRangeSegmentState::Completed;
        segments[0].downloaded_bytes = 250_000;
        segments[1].state = ByteRangeSegmentState::Completed;
        segments[1].downloaded_bytes = 250_000;
        segments[2].state = ByteRangeSegmentState::Completed;
        segments[2].downloaded_bytes = 250_000;
        segments[3].downloaded_bytes = 50_000;

        let split =
            split_largest_remaining_segment(&mut segments, 65_536).expect("should split seg 4");
        assert_eq!(split.source_segment_id, "seg-4");
        assert_eq!(segments.len(), 5);
        assert!(segments[4].is_stolen_split);

        let sum_bytes: u64 = segments.iter().map(|s| s.total_bytes).sum();
        assert_eq!(sum_bytes, 1_000_000);
    }

    #[test]
    fn verifies_and_merges_ordered_segment_buffers() {
        let seg0 = OrderedSegmentBuffer {
            index: 0,
            start_byte: 0,
            end_byte: 7,
            bytes: vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
        };
        let seg1 = OrderedSegmentBuffer {
            index: 1,
            start_byte: 8,
            end_byte: 11,
            bytes: vec![1, 2, 3, 4],
        };

        let merged = merge_ordered_segments(&[seg1, seg0], Some(12), None).expect("merge ok");
        assert_eq!(merged.total_bytes, 12);
        assert_eq!(merged.container_format, "PNG");
        assert_eq!(merged.sha256_hex.len(), 64);
    }
}
