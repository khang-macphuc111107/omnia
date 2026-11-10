use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{NativeError, NativeResult};

pub const WORKSPACE_INDEXER_VERSION: &str = "workspace-text-v1";
pub const WORKSPACE_RETRIEVER_VERSION: &str = "workspace-lexical-mmr-v1";
const TOKEN_ESTIMATOR_VERSION: &str = "utf8-bytes-div-3-v1";

const HARD_MAX_SCANNED_ENTRIES: usize = 500_000;
const HARD_MAX_FILES: usize = 50_000;
const HARD_MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const HARD_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const HARD_MAX_CHUNKS: usize = 200_000;
const HARD_MAX_REPORTED_SKIPS: usize = 20_000;
const HARD_MAX_DEPTH: usize = 64;
const HARD_MAX_IGNORE_PATTERNS: usize = 512;
const HARD_MAX_QUERY_BYTES: usize = 8 * 1024;
const HARD_MAX_RETRIEVAL_RESULTS: usize = 200;
const HARD_MAX_RETRIEVAL_BUDGET: usize = 256_000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct WorkspaceIndexOptions {
    pub max_scanned_entries: usize,
    pub max_files: usize,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub max_chunks: usize,
    pub max_reported_skips: usize,
    pub max_depth: usize,
    pub chunk_target_bytes: usize,
    pub chunk_overlap_bytes: usize,
    pub include_unknown_text: bool,
    pub ignore_patterns: Vec<String>,
}

impl Default for WorkspaceIndexOptions {
    fn default() -> Self {
        Self {
            max_scanned_entries: 100_000,
            max_files: 10_000,
            max_total_bytes: 512 * 1024 * 1024,
            max_file_bytes: 4 * 1024 * 1024,
            max_chunks: 50_000,
            max_reported_skips: 5_000,
            max_depth: 32,
            chunk_target_bytes: 6 * 1024,
            chunk_overlap_bytes: 512,
            include_unknown_text: false,
            ignore_patterns: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct WorkspaceRetrievalOptions {
    pub token_budget: usize,
    pub max_results: usize,
    pub max_results_per_source: usize,
    pub minimum_score: f64,
    pub diversity_lambda: f64,
    pub max_reported_omissions: usize,
}

impl Default for WorkspaceRetrievalOptions {
    fn default() -> Self {
        Self {
            token_budget: 8_000,
            max_results: 12,
            max_results_per_source: 3,
            minimum_score: 0.15,
            diversity_lambda: 0.82,
            max_reported_omissions: 10_000,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceSkipReason {
    IgnoredPath,
    SensitivePath,
    SensitiveContent,
    UnsupportedType,
    ExtractorRequired,
    ReparsePoint,
    ScopeViolation,
    PermissionDenied,
    Unreadable,
    InvalidUtf8,
    BinaryContent,
    EmptyText,
    FileTooLarge,
    ChangedDuringRead,
    MaxDepthReached,
    MaxScannedEntriesReached,
    MaxFilesReached,
    MaxTotalBytesReached,
    MaxChunksReached,
}

impl WorkspaceSkipReason {
    fn is_error(self) -> bool {
        matches!(
            self,
            Self::ScopeViolation
                | Self::PermissionDenied
                | Self::Unreadable
                | Self::ChangedDuringRead
        )
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSkippedPath {
    pub relative_path: String,
    pub reason: WorkspaceSkipReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_size: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedWorkspaceSource {
    pub source_id: String,
    pub version_id: String,
    pub grant_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub relative_path: String,
    pub media_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub byte_size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at_ms: Option<i64>,
    pub content_sha256: String,
    pub chunk_count: usize,
    pub token_estimate: usize,
    pub truncated: bool,
    pub extractor_version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedWorkspaceChunk {
    pub chunk_id: String,
    pub source_id: String,
    pub source_version_id: String,
    pub grant_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub relative_path: String,
    pub ordinal: usize,
    pub content: String,
    pub content_sha256: String,
    pub source_content_sha256: String,
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_line: usize,
    pub end_line: usize,
    pub token_estimate: usize,
    pub token_estimator_version: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIndexStats {
    pub scanned_entries: usize,
    pub files_seen: usize,
    pub directories_seen: usize,
    pub indexed_files: usize,
    pub indexed_chunks: usize,
    pub discovered_file_bytes: u64,
    pub indexed_file_bytes: u64,
    pub indexed_token_estimate: usize,
    pub skipped_paths: usize,
    pub reported_skips: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIndexSnapshot {
    pub snapshot_id: String,
    pub snapshot_sha256: String,
    pub indexer_version: String,
    pub grant_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub started_at_ms: i64,
    pub completed_at_ms: i64,
    pub truncated: bool,
    pub has_errors: bool,
    pub skip_report_truncated: bool,
    pub stats: WorkspaceIndexStats,
    pub sources: Vec<IndexedWorkspaceSource>,
    pub chunks: Vec<IndexedWorkspaceChunk>,
    pub skipped: Vec<WorkspaceSkippedPath>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceRetrievalReason {
    QueryTerms,
    ExactPhrase,
    PathMatch,
    DiversitySelected,
}

impl WorkspaceRetrievalReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::QueryTerms => "query_terms",
            Self::ExactPhrase => "exact_phrase",
            Self::PathMatch => "path_match",
            Self::DiversitySelected => "diversity_selected",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceRetrievalOmissionReason {
    NoQueryMatch,
    BelowThreshold,
    DuplicateContent,
    SourceLimit,
    TokenBudget,
    MaxResults,
}

impl WorkspaceRetrievalOmissionReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NoQueryMatch => "no_query_match",
            Self::BelowThreshold => "below_threshold",
            Self::DuplicateContent => "duplicate_content",
            Self::SourceLimit => "source_limit",
            Self::TokenBudget => "token_budget",
            Self::MaxResults => "max_results",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRetrievalMatch {
    pub rank: usize,
    pub score: f64,
    pub reasons: Vec<WorkspaceRetrievalReason>,
    pub chunk: IndexedWorkspaceChunk,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRetrievalOmission {
    pub chunk_id: String,
    pub reason: WorkspaceRetrievalOmissionReason,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRetrievalResult {
    pub query_sha256: String,
    pub scorer_version: String,
    pub token_budget: usize,
    pub consumed_tokens: usize,
    pub total_chunks: usize,
    pub matched_candidates: usize,
    pub omission_report_truncated: bool,
    pub matches: Vec<WorkspaceRetrievalMatch>,
    pub omissions: Vec<WorkspaceRetrievalOmission>,
}

#[derive(Clone, Debug)]
struct CandidateFile {
    absolute_path: PathBuf,
    relative_path: String,
    media_type: &'static str,
    language: Option<&'static str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FileClassification {
    Text {
        media_type: &'static str,
        language: Option<&'static str>,
    },
    ExtractorRequired,
    Unsupported,
}

#[derive(Clone, Debug)]
struct RetrievalCandidate {
    chunk: IndexedWorkspaceChunk,
    score: f64,
    token_set: BTreeSet<String>,
    reasons: Vec<WorkspaceRetrievalReason>,
}

pub fn build_workspace_index(
    grant_id: &str,
    project_id: Option<&str>,
    root: &Path,
    options: &WorkspaceIndexOptions,
) -> NativeResult<WorkspaceIndexSnapshot> {
    build_workspace_index_with_cancel(grant_id, project_id, root, options, || false)
}

pub fn build_workspace_index_with_cancel<F>(
    grant_id: &str,
    project_id: Option<&str>,
    root: &Path,
    options: &WorkspaceIndexOptions,
    mut should_cancel: F,
) -> NativeResult<WorkspaceIndexSnapshot>
where
    F: FnMut() -> bool,
{
    validate_index_options(options)?;
    if grant_id.trim().is_empty() {
        return Err(NativeError::invalid("grantId", "cannot be empty"));
    }
    if project_id.is_some_and(|value| value.trim().is_empty()) {
        return Err(NativeError::invalid("projectId", "cannot be empty"));
    }

    let started_at_ms = now_ms();
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|error| NativeError::io("the workspace root cannot be inspected", error))?;
    if is_reparse_point(&root_metadata) {
        return Err(NativeError::new(
            "workspace_reparse_root",
            "The workspace root cannot be a symbolic link, junction, or reparse point",
        ));
    }
    if !root_metadata.is_dir() {
        return Err(NativeError::invalid(
            "workspaceRoot",
            "must identify a directory",
        ));
    }
    let canonical_root = dunce::canonicalize(root)
        .map_err(|error| NativeError::io("the workspace root cannot be verified", error))?;

    let mut stats = WorkspaceIndexStats::default();
    let mut skipped = Vec::new();
    let mut has_errors = false;
    let mut truncated = false;
    let mut queue = VecDeque::from([(canonical_root.clone(), 0usize)]);
    let mut candidates = Vec::new();

    'scan: while let Some((directory, depth)) = queue.pop_front() {
        if should_cancel() {
            return Err(NativeError::new(
                "workspace_index_cancelled",
                "Workspace indexing was cancelled",
            ));
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                let relative =
                    relative_display(&canonical_root, &directory).unwrap_or_else(|| ".".to_owned());
                let reason = io_skip_reason(&error);
                record_skip(
                    &mut skipped,
                    &mut stats,
                    options.max_reported_skips,
                    relative,
                    reason,
                    None,
                );
                has_errors |= reason.is_error();
                continue;
            }
        };
        let mut entries = entries.collect::<Result<Vec<_>, _>>().map_err(|error| {
            NativeError::io("a workspace directory entry cannot be read", error)
        })?;
        entries.sort_by(|left, right| {
            let left_name = left.file_name().to_string_lossy().to_lowercase();
            let right_name = right.file_name().to_string_lossy().to_lowercase();
            left_name
                .cmp(&right_name)
                .then_with(|| left.file_name().cmp(&right.file_name()))
        });

        for entry in entries {
            if should_cancel() {
                return Err(NativeError::new(
                    "workspace_index_cancelled",
                    "Workspace indexing was cancelled",
                ));
            }
            if stats.scanned_entries >= options.max_scanned_entries {
                record_skip(
                    &mut skipped,
                    &mut stats,
                    options.max_reported_skips,
                    ".".to_owned(),
                    WorkspaceSkipReason::MaxScannedEntriesReached,
                    None,
                );
                truncated = true;
                break 'scan;
            }
            stats.scanned_entries += 1;
            let path = entry.path();
            let Some(relative_path) = relative_display(&canonical_root, &path) else {
                record_skip(
                    &mut skipped,
                    &mut stats,
                    options.max_reported_skips,
                    "<unrepresentable-path>".to_owned(),
                    WorkspaceSkipReason::ScopeViolation,
                    None,
                );
                has_errors = true;
                continue;
            };
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    let reason = io_skip_reason(&error);
                    record_skip(
                        &mut skipped,
                        &mut stats,
                        options.max_reported_skips,
                        relative_path,
                        reason,
                        None,
                    );
                    has_errors |= reason.is_error();
                    continue;
                }
            };
            if is_reparse_point(&metadata) {
                record_skip(
                    &mut skipped,
                    &mut stats,
                    options.max_reported_skips,
                    relative_path,
                    WorkspaceSkipReason::ReparsePoint,
                    None,
                );
                continue;
            }

            if metadata.is_dir() {
                stats.directories_seen += 1;
                if is_sensitive_path(&relative_path) {
                    record_skip(
                        &mut skipped,
                        &mut stats,
                        options.max_reported_skips,
                        relative_path,
                        WorkspaceSkipReason::SensitivePath,
                        None,
                    );
                    continue;
                }
                if is_builtin_ignored_directory(&relative_path)
                    || is_user_ignored(&relative_path, true, &options.ignore_patterns)
                {
                    record_skip(
                        &mut skipped,
                        &mut stats,
                        options.max_reported_skips,
                        relative_path,
                        WorkspaceSkipReason::IgnoredPath,
                        None,
                    );
                    continue;
                }
                if depth >= options.max_depth {
                    record_skip(
                        &mut skipped,
                        &mut stats,
                        options.max_reported_skips,
                        relative_path,
                        WorkspaceSkipReason::MaxDepthReached,
                        None,
                    );
                    truncated = true;
                    continue;
                }
                match canonical_beneath_root(&canonical_root, &path) {
                    Ok(canonical) => queue.push_back((canonical, depth + 1)),
                    Err(_) => {
                        record_skip(
                            &mut skipped,
                            &mut stats,
                            options.max_reported_skips,
                            relative_path,
                            WorkspaceSkipReason::ScopeViolation,
                            None,
                        );
                        has_errors = true;
                    }
                }
                continue;
            }
            if !metadata.is_file() {
                continue;
            }

            stats.files_seen += 1;
            stats.discovered_file_bytes =
                stats.discovered_file_bytes.saturating_add(metadata.len());
            if is_sensitive_path(&relative_path) {
                record_skip(
                    &mut skipped,
                    &mut stats,
                    options.max_reported_skips,
                    relative_path,
                    WorkspaceSkipReason::SensitivePath,
                    Some(metadata.len()),
                );
                continue;
            }
            if is_user_ignored(&relative_path, false, &options.ignore_patterns) {
                record_skip(
                    &mut skipped,
                    &mut stats,
                    options.max_reported_skips,
                    relative_path,
                    WorkspaceSkipReason::IgnoredPath,
                    Some(metadata.len()),
                );
                continue;
            }
            let classification = classify_file(&relative_path, options.include_unknown_text);
            let (media_type, language) = match classification {
                FileClassification::Text {
                    media_type,
                    language,
                } => (media_type, language),
                FileClassification::ExtractorRequired => {
                    record_skip(
                        &mut skipped,
                        &mut stats,
                        options.max_reported_skips,
                        relative_path,
                        WorkspaceSkipReason::ExtractorRequired,
                        Some(metadata.len()),
                    );
                    continue;
                }
                FileClassification::Unsupported => {
                    record_skip(
                        &mut skipped,
                        &mut stats,
                        options.max_reported_skips,
                        relative_path,
                        WorkspaceSkipReason::UnsupportedType,
                        Some(metadata.len()),
                    );
                    continue;
                }
            };
            candidates.push(CandidateFile {
                absolute_path: path,
                relative_path,
                media_type,
                language,
            });
        }
    }

    candidates.sort_by(|left, right| {
        left.relative_path
            .to_lowercase()
            .cmp(&right.relative_path.to_lowercase())
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });

    let mut sources = Vec::new();
    let mut chunks = Vec::new();
    for candidate in candidates {
        if should_cancel() {
            return Err(NativeError::new(
                "workspace_index_cancelled",
                "Workspace indexing was cancelled",
            ));
        }
        if sources.len() >= options.max_files {
            record_skip(
                &mut skipped,
                &mut stats,
                options.max_reported_skips,
                candidate.relative_path,
                WorkspaceSkipReason::MaxFilesReached,
                None,
            );
            truncated = true;
            continue;
        }

        let before_metadata = match fs::symlink_metadata(&candidate.absolute_path) {
            Ok(metadata) => metadata,
            Err(error) => {
                let reason = io_skip_reason(&error);
                record_skip(
                    &mut skipped,
                    &mut stats,
                    options.max_reported_skips,
                    candidate.relative_path,
                    reason,
                    None,
                );
                has_errors |= reason.is_error();
                continue;
            }
        };
        if is_reparse_point(&before_metadata) {
            record_skip(
                &mut skipped,
                &mut stats,
                options.max_reported_skips,
                candidate.relative_path,
                WorkspaceSkipReason::ReparsePoint,
                Some(before_metadata.len()),
            );
            continue;
        }
        if before_metadata.len() > options.max_file_bytes {
            record_skip(
                &mut skipped,
                &mut stats,
                options.max_reported_skips,
                candidate.relative_path,
                WorkspaceSkipReason::FileTooLarge,
                Some(before_metadata.len()),
            );
            continue;
        }
        if stats
            .indexed_file_bytes
            .saturating_add(before_metadata.len())
            > options.max_total_bytes
        {
            record_skip(
                &mut skipped,
                &mut stats,
                options.max_reported_skips,
                candidate.relative_path,
                WorkspaceSkipReason::MaxTotalBytesReached,
                Some(before_metadata.len()),
            );
            truncated = true;
            continue;
        }
        let canonical_before =
            match canonical_beneath_root(&canonical_root, &candidate.absolute_path) {
                Ok(path) => path,
                Err(_) => {
                    record_skip(
                        &mut skipped,
                        &mut stats,
                        options.max_reported_skips,
                        candidate.relative_path,
                        WorkspaceSkipReason::ScopeViolation,
                        Some(before_metadata.len()),
                    );
                    has_errors = true;
                    continue;
                }
            };
        // The canonical path was checked above, but the final directory entry
        // can still be replaced with a junction/reparse point before the open.
        // On Windows, opening with FILE_FLAG_OPEN_REPARSE_POINT makes the
        // handle refer to that final entry instead of following it outside the
        // granted root. The post-read identity checks below still reject any
        // replacement or mutation observed during the read.
        let mut file = match open_read_without_following_final_reparse_point(&canonical_before) {
            Ok(file) => file,
            Err(error) => {
                let reason = io_skip_reason(&error);
                record_skip(
                    &mut skipped,
                    &mut stats,
                    options.max_reported_skips,
                    candidate.relative_path,
                    reason,
                    Some(before_metadata.len()),
                );
                has_errors |= reason.is_error();
                continue;
            }
        };
        let read_limit = options.max_file_bytes.saturating_add(1);
        let mut bytes = Vec::with_capacity(
            usize::try_from(before_metadata.len().min(options.max_file_bytes)).unwrap_or_default(),
        );
        if let Err(error) = file.by_ref().take(read_limit).read_to_end(&mut bytes) {
            let reason = io_skip_reason(&error);
            record_skip(
                &mut skipped,
                &mut stats,
                options.max_reported_skips,
                candidate.relative_path,
                reason,
                Some(before_metadata.len()),
            );
            has_errors |= reason.is_error();
            continue;
        }
        if bytes.len() as u64 > options.max_file_bytes {
            record_skip(
                &mut skipped,
                &mut stats,
                options.max_reported_skips,
                candidate.relative_path,
                WorkspaceSkipReason::FileTooLarge,
                Some(bytes.len() as u64),
            );
            continue;
        }

        let after_metadata = match fs::symlink_metadata(&candidate.absolute_path) {
            Ok(metadata) => metadata,
            Err(_) => {
                record_skip(
                    &mut skipped,
                    &mut stats,
                    options.max_reported_skips,
                    candidate.relative_path,
                    WorkspaceSkipReason::ChangedDuringRead,
                    Some(bytes.len() as u64),
                );
                has_errors = true;
                continue;
            }
        };
        let canonical_after = canonical_beneath_root(&canonical_root, &candidate.absolute_path);
        let handle_changed = match file.metadata() {
            Ok(handle_metadata) => metadata_changed(&handle_metadata, &after_metadata),
            Err(_) => true,
        };
        if is_reparse_point(&after_metadata)
            || canonical_after.as_ref().ok() != Some(&canonical_before)
            || metadata_changed(&before_metadata, &after_metadata)
            || handle_changed
        {
            record_skip(
                &mut skipped,
                &mut stats,
                options.max_reported_skips,
                candidate.relative_path,
                WorkspaceSkipReason::ChangedDuringRead,
                Some(bytes.len() as u64),
            );
            has_errors = true;
            continue;
        }
        if looks_binary(&bytes) {
            record_skip(
                &mut skipped,
                &mut stats,
                options.max_reported_skips,
                candidate.relative_path,
                WorkspaceSkipReason::BinaryContent,
                Some(bytes.len() as u64),
            );
            continue;
        }
        if contains_private_key_material(&bytes) {
            record_skip(
                &mut skipped,
                &mut stats,
                options.max_reported_skips,
                candidate.relative_path,
                WorkspaceSkipReason::SensitiveContent,
                Some(bytes.len() as u64),
            );
            continue;
        }
        let bom_bytes = usize::from(bytes.starts_with(&[0xef, 0xbb, 0xbf])) * 3;
        let text = match std::str::from_utf8(&bytes[bom_bytes..]) {
            Ok(text) => text,
            Err(_) => {
                record_skip(
                    &mut skipped,
                    &mut stats,
                    options.max_reported_skips,
                    candidate.relative_path,
                    WorkspaceSkipReason::InvalidUtf8,
                    Some(bytes.len() as u64),
                );
                continue;
            }
        };
        if text.trim().is_empty() {
            record_skip(
                &mut skipped,
                &mut stats,
                options.max_reported_skips,
                candidate.relative_path,
                WorkspaceSkipReason::EmptyText,
                Some(bytes.len() as u64),
            );
            continue;
        }

        let source_content_sha256 = sha256_hex(&bytes);
        let source_id = stable_id(
            "indexed_source_",
            &[
                grant_id.as_bytes(),
                candidate.relative_path.to_lowercase().as_bytes(),
            ],
        );
        let version_id = stable_id(
            "source_version_",
            &[source_id.as_bytes(), source_content_sha256.as_bytes()],
        );
        let remaining_chunks = options.max_chunks.saturating_sub(chunks.len());
        if remaining_chunks == 0 {
            record_skip(
                &mut skipped,
                &mut stats,
                options.max_reported_skips,
                candidate.relative_path,
                WorkspaceSkipReason::MaxChunksReached,
                Some(bytes.len() as u64),
            );
            truncated = true;
            break;
        }
        let (mut source_chunks, source_truncated) = chunk_source(
            grant_id,
            project_id,
            &candidate.relative_path,
            &source_id,
            &version_id,
            &source_content_sha256,
            text,
            bom_bytes,
            options.chunk_target_bytes,
            options.chunk_overlap_bytes,
            remaining_chunks,
        );
        if source_chunks.is_empty() {
            record_skip(
                &mut skipped,
                &mut stats,
                options.max_reported_skips,
                candidate.relative_path,
                WorkspaceSkipReason::EmptyText,
                Some(bytes.len() as u64),
            );
            continue;
        }
        if source_truncated {
            record_skip(
                &mut skipped,
                &mut stats,
                options.max_reported_skips,
                candidate.relative_path.clone(),
                WorkspaceSkipReason::MaxChunksReached,
                Some(bytes.len() as u64),
            );
            truncated = true;
        }
        let source_token_estimate = source_chunks.iter().map(|chunk| chunk.token_estimate).sum();
        let chunk_count = source_chunks.len();
        stats.indexed_file_bytes = stats.indexed_file_bytes.saturating_add(bytes.len() as u64);
        stats.indexed_token_estimate = stats
            .indexed_token_estimate
            .saturating_add(source_token_estimate);
        stats.indexed_chunks = stats.indexed_chunks.saturating_add(chunk_count);
        stats.indexed_files += 1;
        sources.push(IndexedWorkspaceSource {
            source_id,
            version_id,
            grant_id: grant_id.to_owned(),
            project_id: project_id.map(ToOwned::to_owned),
            relative_path: candidate.relative_path,
            media_type: candidate.media_type.to_owned(),
            language: candidate.language.map(ToOwned::to_owned),
            byte_size: bytes.len() as u64,
            modified_at_ms: modified_at_ms(&after_metadata),
            content_sha256: source_content_sha256,
            chunk_count,
            token_estimate: source_token_estimate,
            truncated: source_truncated,
            extractor_version: WORKSPACE_INDEXER_VERSION.to_owned(),
        });
        chunks.append(&mut source_chunks);
        if source_truncated {
            break;
        }
    }

    stats.reported_skips = skipped.len();
    let skip_report_truncated = stats.skipped_paths > skipped.len();
    let snapshot_sha256 = hash_snapshot(
        grant_id,
        project_id,
        options,
        truncated,
        has_errors,
        &stats,
        &sources,
        &chunks,
        &skipped,
        skip_report_truncated,
    );
    let snapshot_id = format!("workspace_index_{}", &snapshot_sha256[..32]);
    Ok(WorkspaceIndexSnapshot {
        snapshot_id,
        snapshot_sha256,
        indexer_version: WORKSPACE_INDEXER_VERSION.to_owned(),
        grant_id: grant_id.to_owned(),
        project_id: project_id.map(ToOwned::to_owned),
        started_at_ms,
        completed_at_ms: now_ms(),
        truncated,
        has_errors,
        skip_report_truncated,
        stats,
        sources,
        chunks,
        skipped,
    })
}

pub fn retrieve_workspace_chunks(
    chunks: &[IndexedWorkspaceChunk],
    query: &str,
    options: &WorkspaceRetrievalOptions,
) -> NativeResult<WorkspaceRetrievalResult> {
    validate_retrieval_options(options)?;
    let query = query.trim();
    if query.is_empty() {
        return Err(NativeError::invalid("query", "cannot be empty"));
    }
    if query.len() > HARD_MAX_QUERY_BYTES {
        return Err(NativeError::invalid(
            "query",
            format!("must be at most {HARD_MAX_QUERY_BYTES} UTF-8 bytes"),
        ));
    }
    let query_terms = tokenize(query).into_iter().collect::<BTreeSet<_>>();
    if query_terms.is_empty() {
        return Err(NativeError::invalid(
            "query",
            "must contain at least one searchable letter or number",
        ));
    }
    let query_lower = query.to_lowercase();
    let query_sha256 = sha256_hex(query.as_bytes());

    let mut document_frequency = BTreeMap::<String, usize>::new();
    let mut tokenized_chunks = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        let tokens = tokenize(&chunk.content);
        let token_set = tokens.iter().cloned().collect::<BTreeSet<_>>();
        for term in &query_terms {
            if token_set.contains(term) {
                *document_frequency.entry(term.clone()).or_default() += 1;
            }
        }
        tokenized_chunks.push((chunk, tokens, token_set));
    }

    let corpus_size = chunks.len().max(1) as f64;
    let mut candidates = Vec::new();
    let mut omissions = Vec::new();
    for (chunk, tokens, token_set) in tokenized_chunks {
        let mut frequencies = HashMap::<&str, usize>::new();
        for token in &tokens {
            *frequencies.entry(token.as_str()).or_default() += 1;
        }
        let mut matched_terms = 0usize;
        let mut lexical_score = 0.0;
        for term in &query_terms {
            let frequency = frequencies.get(term.as_str()).copied().unwrap_or_default();
            if frequency == 0 {
                continue;
            }
            matched_terms += 1;
            let document_count = document_frequency.get(term).copied().unwrap_or_default() as f64;
            let inverse_document_frequency =
                ((corpus_size + 1.0) / (document_count + 0.5)).ln() + 1.0;
            lexical_score +=
                inverse_document_frequency * (frequency as f64 / (frequency as f64 + 1.2));
        }
        if matched_terms == 0 {
            push_omission(
                &mut omissions,
                options.max_reported_omissions,
                &chunk.chunk_id,
                WorkspaceRetrievalOmissionReason::NoQueryMatch,
            );
            continue;
        }
        let coverage = matched_terms as f64 / query_terms.len() as f64;
        let exact_phrase =
            query_lower.len() >= 3 && chunk.content.to_lowercase().contains(&query_lower);
        let path_tokens = tokenize(&chunk.relative_path)
            .into_iter()
            .collect::<BTreeSet<_>>();
        let path_match_count = query_terms.intersection(&path_tokens).count();
        let score = lexical_score
            + coverage * 4.0
            + if exact_phrase { 5.0 } else { 0.0 }
            + path_match_count as f64 * 1.5;
        if score < options.minimum_score {
            push_omission(
                &mut omissions,
                options.max_reported_omissions,
                &chunk.chunk_id,
                WorkspaceRetrievalOmissionReason::BelowThreshold,
            );
            continue;
        }
        let mut reasons = vec![WorkspaceRetrievalReason::QueryTerms];
        if exact_phrase {
            reasons.push(WorkspaceRetrievalReason::ExactPhrase);
        }
        if path_match_count > 0 {
            reasons.push(WorkspaceRetrievalReason::PathMatch);
        }
        candidates.push(RetrievalCandidate {
            chunk: chunk.clone(),
            score,
            token_set,
            reasons,
        });
    }
    candidates.sort_by(compare_retrieval_candidates);
    let matched_candidates = candidates.len();

    let mut unique_content = BTreeSet::new();
    candidates.retain(|candidate| {
        if unique_content.insert(candidate.chunk.content_sha256.clone()) {
            true
        } else {
            push_omission(
                &mut omissions,
                options.max_reported_omissions,
                &candidate.chunk.chunk_id,
                WorkspaceRetrievalOmissionReason::DuplicateContent,
            );
            false
        }
    });

    let top_score = candidates
        .first()
        .map(|candidate| candidate.score)
        .unwrap_or(1.0);
    let mut selected = Vec::<RetrievalCandidate>::new();
    let mut per_source = BTreeMap::<String, usize>::new();
    let mut consumed_tokens = 0usize;
    while !candidates.is_empty() && selected.len() < options.max_results {
        let remaining_budget = options.token_budget.saturating_sub(consumed_tokens);
        let mut best: Option<(usize, f64)> = None;
        for (index, candidate) in candidates.iter().enumerate() {
            if candidate.chunk.token_estimate > remaining_budget {
                continue;
            }
            if per_source
                .get(&candidate.chunk.source_id)
                .copied()
                .unwrap_or_default()
                >= options.max_results_per_source
            {
                continue;
            }
            let maximum_similarity = selected
                .iter()
                .map(|selected| jaccard_similarity(&candidate.token_set, &selected.token_set))
                .fold(0.0, f64::max);
            let normalized_relevance = if top_score > 0.0 {
                candidate.score / top_score
            } else {
                0.0
            };
            let same_source_penalty = if selected
                .iter()
                .any(|selected| selected.chunk.source_id == candidate.chunk.source_id)
            {
                0.08
            } else {
                0.0
            };
            let mmr = options.diversity_lambda * normalized_relevance
                - (1.0 - options.diversity_lambda) * maximum_similarity
                - same_source_penalty;
            if best.map_or(true, |(best_index, best_score)| {
                mmr > best_score
                    || (mmr == best_score
                        && compare_retrieval_candidates(candidate, &candidates[best_index])
                            == std::cmp::Ordering::Less)
            }) {
                best = Some((index, mmr));
            }
        }
        let Some((best_index, _)) = best else {
            break;
        };
        let mut candidate = candidates.remove(best_index);
        candidate
            .reasons
            .push(WorkspaceRetrievalReason::DiversitySelected);
        consumed_tokens = consumed_tokens.saturating_add(candidate.chunk.token_estimate);
        *per_source
            .entry(candidate.chunk.source_id.clone())
            .or_default() += 1;
        selected.push(candidate);
    }

    let hit_max_results = selected.len() >= options.max_results;
    for candidate in candidates {
        let reason = if hit_max_results {
            WorkspaceRetrievalOmissionReason::MaxResults
        } else if per_source
            .get(&candidate.chunk.source_id)
            .copied()
            .unwrap_or_default()
            >= options.max_results_per_source
        {
            WorkspaceRetrievalOmissionReason::SourceLimit
        } else {
            WorkspaceRetrievalOmissionReason::TokenBudget
        };
        push_omission(
            &mut omissions,
            options.max_reported_omissions,
            &candidate.chunk.chunk_id,
            reason,
        );
    }

    let omission_report_truncated = omissions.len() >= options.max_reported_omissions
        && chunks.len().saturating_sub(selected.len()) > omissions.len();
    omissions.sort_by(|left, right| left.chunk_id.cmp(&right.chunk_id));
    let matches = selected
        .into_iter()
        .enumerate()
        .map(|(index, candidate)| WorkspaceRetrievalMatch {
            rank: index + 1,
            score: round_score(candidate.score),
            reasons: candidate.reasons,
            chunk: candidate.chunk,
        })
        .collect();
    Ok(WorkspaceRetrievalResult {
        query_sha256,
        scorer_version: WORKSPACE_RETRIEVER_VERSION.to_owned(),
        token_budget: options.token_budget,
        consumed_tokens,
        total_chunks: chunks.len(),
        matched_candidates,
        omission_report_truncated,
        matches,
        omissions,
    })
}

fn validate_index_options(options: &WorkspaceIndexOptions) -> NativeResult<()> {
    validate_bounded_usize(
        "maxScannedEntries",
        options.max_scanned_entries,
        HARD_MAX_SCANNED_ENTRIES,
    )?;
    validate_bounded_usize("maxFiles", options.max_files, HARD_MAX_FILES)?;
    validate_bounded_u64(
        "maxTotalBytes",
        options.max_total_bytes,
        HARD_MAX_TOTAL_BYTES,
    )?;
    validate_bounded_u64("maxFileBytes", options.max_file_bytes, HARD_MAX_FILE_BYTES)?;
    validate_bounded_usize("maxChunks", options.max_chunks, HARD_MAX_CHUNKS)?;
    validate_bounded_usize(
        "maxReportedSkips",
        options.max_reported_skips,
        HARD_MAX_REPORTED_SKIPS,
    )?;
    validate_bounded_usize("maxDepth", options.max_depth, HARD_MAX_DEPTH)?;
    if !(512..=64 * 1024).contains(&options.chunk_target_bytes) {
        return Err(NativeError::invalid(
            "chunkTargetBytes",
            "must be between 512 and 65536",
        ));
    }
    if options.chunk_overlap_bytes >= options.chunk_target_bytes / 2 {
        return Err(NativeError::invalid(
            "chunkOverlapBytes",
            "must be less than half of chunkTargetBytes",
        ));
    }
    if options.ignore_patterns.len() > HARD_MAX_IGNORE_PATTERNS {
        return Err(NativeError::invalid(
            "ignorePatterns",
            format!("must contain at most {HARD_MAX_IGNORE_PATTERNS} entries"),
        ));
    }
    if options
        .ignore_patterns
        .iter()
        .any(|pattern| pattern.len() > 512 || pattern.as_bytes().contains(&0))
    {
        return Err(NativeError::invalid(
            "ignorePatterns",
            "contains an invalid or oversized pattern",
        ));
    }
    Ok(())
}

fn validate_retrieval_options(options: &WorkspaceRetrievalOptions) -> NativeResult<()> {
    validate_bounded_usize(
        "tokenBudget",
        options.token_budget,
        HARD_MAX_RETRIEVAL_BUDGET,
    )?;
    validate_bounded_usize(
        "maxResults",
        options.max_results,
        HARD_MAX_RETRIEVAL_RESULTS,
    )?;
    validate_bounded_usize(
        "maxResultsPerSource",
        options.max_results_per_source,
        HARD_MAX_RETRIEVAL_RESULTS,
    )?;
    if !options.minimum_score.is_finite() || !(0.0..=1_000.0).contains(&options.minimum_score) {
        return Err(NativeError::invalid(
            "minimumScore",
            "must be a finite number between 0 and 1000",
        ));
    }
    if !options.diversity_lambda.is_finite() || !(0.0..=1.0).contains(&options.diversity_lambda) {
        return Err(NativeError::invalid(
            "diversityLambda",
            "must be a finite number between 0 and 1",
        ));
    }
    validate_bounded_usize(
        "maxReportedOmissions",
        options.max_reported_omissions,
        HARD_MAX_REPORTED_SKIPS,
    )?;
    Ok(())
}

fn validate_bounded_usize(field: &'static str, value: usize, maximum: usize) -> NativeResult<()> {
    if value == 0 || value > maximum {
        Err(NativeError::invalid(
            field,
            format!("must be between 1 and {maximum}"),
        ))
    } else {
        Ok(())
    }
}

fn validate_bounded_u64(field: &'static str, value: u64, maximum: u64) -> NativeResult<()> {
    if value == 0 || value > maximum {
        Err(NativeError::invalid(
            field,
            format!("must be between 1 and {maximum}"),
        ))
    } else {
        Ok(())
    }
}

fn record_skip(
    skipped: &mut Vec<WorkspaceSkippedPath>,
    stats: &mut WorkspaceIndexStats,
    maximum_reported: usize,
    relative_path: String,
    reason: WorkspaceSkipReason,
    byte_size: Option<u64>,
) {
    stats.skipped_paths += 1;
    if skipped.len() < maximum_reported {
        skipped.push(WorkspaceSkippedPath {
            relative_path,
            reason,
            byte_size,
        });
    }
}

fn push_omission(
    omissions: &mut Vec<WorkspaceRetrievalOmission>,
    maximum_reported: usize,
    chunk_id: &str,
    reason: WorkspaceRetrievalOmissionReason,
) {
    if omissions.len() < maximum_reported {
        omissions.push(WorkspaceRetrievalOmission {
            chunk_id: chunk_id.to_owned(),
            reason,
        });
    }
}

fn canonical_beneath_root(root: &Path, path: &Path) -> NativeResult<PathBuf> {
    let canonical = dunce::canonicalize(path)
        .map_err(|error| NativeError::io("a workspace path cannot be verified", error))?;
    if canonical == root || canonical.starts_with(root) {
        Ok(canonical)
    } else {
        Err(NativeError::new(
            "workspace_scope_violation",
            "A workspace path escapes the granted root",
        ))
    }
}

fn open_read_without_following_final_reparse_point(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(path)
}

fn relative_display(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .and_then(Path::to_str)
        .map(|value| value.replace('\\', "/"))
}

#[cfg(windows)]
fn is_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn metadata_changed(before: &Metadata, after: &Metadata) -> bool {
    before.len() != after.len() || before.modified().ok() != after.modified().ok()
}

fn modified_at_ms(metadata: &Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
}

fn io_skip_reason(error: &std::io::Error) -> WorkspaceSkipReason {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        WorkspaceSkipReason::PermissionDenied
    } else {
        WorkspaceSkipReason::Unreadable
    }
}

fn is_builtin_ignored_directory(relative_path: &str) -> bool {
    let name = relative_path
        .rsplit('/')
        .next()
        .unwrap_or(relative_path)
        .to_ascii_lowercase();
    matches!(
        name.as_str(),
        ".git"
            | ".hg"
            | ".svn"
            | ".cache"
            | ".next"
            | ".nuxt"
            | ".turbo"
            | ".venv"
            | "venv"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "coverage"
            | "__pycache__"
            | ".idea"
            | ".vs"
            | "bin"
            | "obj"
    )
}

fn is_sensitive_path(relative_path: &str) -> bool {
    let normalized = relative_path.replace('\\', "/").to_ascii_lowercase();
    let components = normalized.split('/').collect::<Vec<_>>();
    if components.iter().any(|component| {
        matches!(
            *component,
            ".ssh" | ".gnupg" | ".aws" | ".azure" | ".kube" | ".docker"
        )
    }) {
        return true;
    }
    let filename = components.last().copied().unwrap_or_default();
    let safe_environment_template = matches!(
        filename,
        ".env.example" | ".env.sample" | ".env.template" | ".env.defaults"
    );
    if filename == ".env" || (filename.starts_with(".env.") && !safe_environment_template) {
        return true;
    }
    if matches!(
        filename,
        ".npmrc"
            | ".pypirc"
            | ".netrc"
            | "credentials"
            | "credentials.json"
            | "service-account.json"
            | "id_rsa"
            | "id_dsa"
            | "id_ecdsa"
            | "id_ed25519"
    ) {
        return true;
    }
    Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "key" | "pem" | "p12" | "pfx" | "jks" | "keystore"
            )
        })
}

fn is_user_ignored(relative_path: &str, is_directory: bool, patterns: &[String]) -> bool {
    let normalized = relative_path.replace('\\', "/").to_ascii_lowercase();
    let basename = normalized.rsplit('/').next().unwrap_or(&normalized);
    let mut ignored = false;
    for raw_pattern in patterns {
        let raw_pattern = raw_pattern.trim();
        if raw_pattern.is_empty() || raw_pattern.starts_with('#') {
            continue;
        }
        let (negated, pattern) = raw_pattern
            .strip_prefix('!')
            .map_or((false, raw_pattern), |pattern| (true, pattern));
        let directory_only = pattern.ends_with('/');
        if directory_only && !is_directory {
            continue;
        }
        let pattern = pattern
            .trim_matches('/')
            .replace('\\', "/")
            .to_ascii_lowercase();
        if pattern.is_empty() {
            continue;
        }
        let matches = if pattern.contains('/') {
            glob_matches(&pattern, &normalized)
        } else {
            glob_matches(&pattern, basename)
                || normalized
                    .split('/')
                    .any(|component| glob_matches(&pattern, component))
        };
        if matches {
            ignored = !negated;
        }
    }
    ignored
}

fn glob_matches(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let mut memo = HashMap::<(usize, usize), bool>::new();
    fn matches_from(
        pattern: &[u8],
        value: &[u8],
        pattern_index: usize,
        value_index: usize,
        memo: &mut HashMap<(usize, usize), bool>,
    ) -> bool {
        if let Some(result) = memo.get(&(pattern_index, value_index)) {
            return *result;
        }
        let result = if pattern_index == pattern.len() {
            value_index == value.len()
        } else if pattern[pattern_index] == b'*' {
            let is_double = pattern.get(pattern_index + 1) == Some(&b'*');
            let next_pattern_index = if is_double {
                pattern_index + 2
            } else {
                pattern_index + 1
            };
            matches_from(pattern, value, next_pattern_index, value_index, memo)
                || (value_index < value.len()
                    && (is_double || value[value_index] != b'/')
                    && matches_from(pattern, value, pattern_index, value_index + 1, memo))
        } else if value_index < value.len()
            && (pattern[pattern_index] == b'?' && value[value_index] != b'/'
                || pattern[pattern_index] == value[value_index])
        {
            matches_from(pattern, value, pattern_index + 1, value_index + 1, memo)
        } else {
            false
        };
        memo.insert((pattern_index, value_index), result);
        result
    }
    matches_from(pattern, value, 0, 0, &mut memo)
}

fn classify_file(relative_path: &str, include_unknown_text: bool) -> FileClassification {
    let path = Path::new(relative_path);
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        filename.as_str(),
        "dockerfile"
            | "makefile"
            | "justfile"
            | "procfile"
            | ".env.example"
            | ".env.sample"
            | ".env.template"
            | ".env.defaults"
            | ".gitignore"
            | ".gitattributes"
            | ".editorconfig"
            | ".dockerignore"
    ) {
        return FileClassification::Text {
            media_type: "text/plain",
            language: Some("text"),
        };
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let text = |media_type, language| FileClassification::Text {
        media_type,
        language,
    };
    match extension.as_str() {
        "txt" | "log" => text("text/plain", Some("text")),
        "md" | "markdown" | "mdx" => text("text/markdown", Some("markdown")),
        "rst" => text("text/x-rst", Some("rst")),
        "adoc" | "asciidoc" => text("text/asciidoc", Some("asciidoc")),
        "html" | "htm" => text("text/html", Some("html")),
        "css" => text("text/css", Some("css")),
        "scss" | "sass" => text("text/x-scss", Some("scss")),
        "less" => text("text/x-less", Some("less")),
        "js" | "mjs" | "cjs" | "jsx" => text("text/javascript", Some("javascript")),
        "ts" | "mts" | "cts" | "tsx" => text("text/typescript", Some("typescript")),
        "json" | "jsonc" | "jsonl" | "ndjson" | "lock" => text("application/json", Some("json")),
        "yaml" | "yml" => text("application/yaml", Some("yaml")),
        "toml" => text("application/toml", Some("toml")),
        "xml" | "xsd" | "svg" => text("application/xml", Some("xml")),
        "csv" => text("text/csv", Some("csv")),
        "tsv" => text("text/tab-separated-values", Some("tsv")),
        "sql" => text("application/sql", Some("sql")),
        "graphql" | "gql" => text("application/graphql", Some("graphql")),
        "py" | "pyi" => text("text/x-python", Some("python")),
        "rs" => text("text/x-rust", Some("rust")),
        "go" => text("text/x-go", Some("go")),
        "java" => text("text/x-java", Some("java")),
        "kt" | "kts" => text("text/x-kotlin", Some("kotlin")),
        "c" | "h" => text("text/x-c", Some("c")),
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => text("text/x-c++", Some("cpp")),
        "cs" => text("text/x-csharp", Some("csharp")),
        "fs" | "fsi" | "fsx" => text("text/x-fsharp", Some("fsharp")),
        "swift" => text("text/x-swift", Some("swift")),
        "rb" => text("text/x-ruby", Some("ruby")),
        "php" => text("text/x-php", Some("php")),
        "lua" => text("text/x-lua", Some("lua")),
        "sh" | "bash" | "zsh" | "fish" => text("text/x-shellscript", Some("shell")),
        "ps1" | "psm1" | "psd1" => text("text/x-powershell", Some("powershell")),
        "bat" | "cmd" => text("text/x-batch", Some("batch")),
        "ini" | "cfg" | "conf" | "properties" => text("text/plain", Some("config")),
        "vue" => text("text/plain", Some("vue")),
        "svelte" => text("text/plain", Some("svelte")),
        "pdf" | "doc" | "docx" | "ppt" | "pptx" | "xls" | "xlsx" | "rtf" | "png" | "jpg"
        | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" => FileClassification::ExtractorRequired,
        _ if include_unknown_text => text("text/plain", None),
        _ => FileClassification::Unsupported,
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.iter().take(8_192).any(|byte| *byte == 0) {
        return true;
    }
    let sample = &bytes[..bytes.len().min(16_384)];
    let control_count = sample
        .iter()
        .filter(|byte| **byte < 0x20 && !matches!(**byte, b'\n' | b'\r' | b'\t' | 0x0c))
        .count();
    !sample.is_empty() && control_count * 100 > sample.len() * 2
}

fn contains_private_key_material(bytes: &[u8]) -> bool {
    const MARKERS: [&[u8]; 4] = [
        b"-----BEGIN PRIVATE KEY-----",
        b"-----BEGIN RSA PRIVATE KEY-----",
        b"-----BEGIN EC PRIVATE KEY-----",
        b"-----BEGIN OPENSSH PRIVATE KEY-----",
    ];
    MARKERS
        .iter()
        .any(|marker| bytes.windows(marker.len()).any(|window| window == *marker))
}

#[allow(clippy::too_many_arguments)]
fn chunk_source(
    grant_id: &str,
    project_id: Option<&str>,
    relative_path: &str,
    source_id: &str,
    source_version_id: &str,
    source_content_sha256: &str,
    text: &str,
    source_byte_offset: usize,
    target_bytes: usize,
    overlap_bytes: usize,
    maximum_chunks: usize,
) -> (Vec<IndexedWorkspaceChunk>, bool) {
    let mut chunks = Vec::new();
    let mut start = 0usize;
    let mut ordinal = 0usize;
    let mut truncated = false;
    while start < text.len() {
        if chunks.len() >= maximum_chunks {
            truncated = true;
            break;
        }
        let mut end = (start + target_bytes).min(text.len());
        end = previous_char_boundary(text, end);
        if end < text.len() {
            let minimum_boundary = start + target_bytes.saturating_mul(3) / 5;
            if let Some(boundary) = preferred_chunk_boundary(text, minimum_boundary, end) {
                end = boundary;
            }
        }
        if end <= start {
            end = next_char_boundary(text, (start + target_bytes).min(text.len()));
        }
        let raw = &text[start..end];
        let leading = raw.len() - raw.trim_start().len();
        let trailing = raw.len() - raw.trim_end().len();
        let content_start = start + leading;
        let content_end = end.saturating_sub(trailing);
        if content_end > content_start {
            let content = &text[content_start..content_end];
            ordinal += 1;
            let start_byte = source_byte_offset + content_start;
            let end_byte = source_byte_offset + content_end;
            let content_sha256 = sha256_hex(content.as_bytes());
            let chunk_id = stable_id(
                "workspace_chunk_",
                &[
                    source_version_id.as_bytes(),
                    ordinal.to_string().as_bytes(),
                    start_byte.to_string().as_bytes(),
                    end_byte.to_string().as_bytes(),
                    content_sha256.as_bytes(),
                ],
            );
            chunks.push(IndexedWorkspaceChunk {
                chunk_id,
                source_id: source_id.to_owned(),
                source_version_id: source_version_id.to_owned(),
                grant_id: grant_id.to_owned(),
                project_id: project_id.map(ToOwned::to_owned),
                relative_path: relative_path.to_owned(),
                ordinal,
                content: content.to_owned(),
                content_sha256,
                source_content_sha256: source_content_sha256.to_owned(),
                start_byte,
                end_byte,
                start_line: line_number_at(text, content_start),
                end_line: line_number_at(text, content_end.saturating_sub(1)),
                token_estimate: estimate_tokens(content),
                token_estimator_version: TOKEN_ESTIMATOR_VERSION.to_owned(),
            });
        }
        if end >= text.len() {
            break;
        }
        let proposed_start = end.saturating_sub(overlap_bytes);
        let next_start = previous_char_boundary(text, proposed_start);
        start = if next_start > start { next_start } else { end };
    }
    (chunks, truncated)
}

fn preferred_chunk_boundary(text: &str, minimum: usize, maximum: usize) -> Option<usize> {
    let minimum = previous_char_boundary(text, minimum.min(text.len()));
    let maximum = previous_char_boundary(text, maximum.min(text.len()));
    let window = &text[minimum..maximum];
    if let Some(index) = window.rfind("\n\n") {
        return Some(minimum + index + 2);
    }
    if let Some(index) = window.rfind('\n') {
        return Some(minimum + index + 1);
    }
    window
        .char_indices()
        .rev()
        .find(|(_, character)| character.is_whitespace())
        .map(|(index, character)| minimum + index + character.len_utf8())
}

fn previous_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn next_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn line_number_at(text: &str, byte_index: usize) -> usize {
    1 + text[..byte_index.min(text.len())]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
}

fn estimate_tokens(text: &str) -> usize {
    text.len().div_ceil(3).max(1)
}

fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for character in text.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            current.push(character);
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn compare_retrieval_candidates(
    left: &RetrievalCandidate,
    right: &RetrievalCandidate,
) -> std::cmp::Ordering {
    right
        .score
        .total_cmp(&left.score)
        .then_with(|| left.chunk.relative_path.cmp(&right.chunk.relative_path))
        .then_with(|| left.chunk.ordinal.cmp(&right.chunk.ordinal))
        .then_with(|| left.chunk.chunk_id.cmp(&right.chunk.chunk_id))
}

fn jaccard_similarity(left: &BTreeSet<String>, right: &BTreeSet<String>) -> f64 {
    if left.is_empty() && right.is_empty() {
        return 1.0;
    }
    let intersection = left.intersection(right).count();
    let union = left.union(right).count();
    if union == 0 {
        0.0
    } else {
        intersection as f64 / union as f64
    }
}

fn round_score(score: f64) -> f64 {
    (score * 1_000_000.0).round() / 1_000_000.0
}

#[allow(clippy::too_many_arguments)]
fn hash_snapshot(
    grant_id: &str,
    project_id: Option<&str>,
    options: &WorkspaceIndexOptions,
    truncated: bool,
    has_errors: bool,
    stats: &WorkspaceIndexStats,
    sources: &[IndexedWorkspaceSource],
    chunks: &[IndexedWorkspaceChunk],
    skipped: &[WorkspaceSkippedPath],
    skip_report_truncated: bool,
) -> String {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, WORKSPACE_INDEXER_VERSION.as_bytes());
    hash_field(&mut hasher, grant_id.as_bytes());
    hash_field(&mut hasher, project_id.unwrap_or_default().as_bytes());
    for value in [
        options.max_scanned_entries.to_string(),
        options.max_files.to_string(),
        options.max_total_bytes.to_string(),
        options.max_file_bytes.to_string(),
        options.max_chunks.to_string(),
        options.max_depth.to_string(),
        options.chunk_target_bytes.to_string(),
        options.chunk_overlap_bytes.to_string(),
        options.include_unknown_text.to_string(),
        truncated.to_string(),
        has_errors.to_string(),
        skip_report_truncated.to_string(),
        stats.scanned_entries.to_string(),
        stats.files_seen.to_string(),
        stats.indexed_files.to_string(),
        stats.indexed_chunks.to_string(),
        stats.indexed_file_bytes.to_string(),
        stats.skipped_paths.to_string(),
    ] {
        hash_field(&mut hasher, value.as_bytes());
    }
    for pattern in &options.ignore_patterns {
        hash_field(&mut hasher, pattern.as_bytes());
    }
    for source in sources {
        for value in [
            source.source_id.as_str(),
            source.version_id.as_str(),
            source.relative_path.as_str(),
            source.media_type.as_str(),
            source.language.as_deref().unwrap_or_default(),
            source.content_sha256.as_str(),
        ] {
            hash_field(&mut hasher, value.as_bytes());
        }
        hash_field(&mut hasher, &source.byte_size.to_le_bytes());
        hash_field(&mut hasher, &source.chunk_count.to_le_bytes());
        hash_field(&mut hasher, &[u8::from(source.truncated)]);
    }
    for chunk in chunks {
        for value in [
            chunk.chunk_id.as_str(),
            chunk.source_version_id.as_str(),
            chunk.content_sha256.as_str(),
        ] {
            hash_field(&mut hasher, value.as_bytes());
        }
        hash_field(&mut hasher, &chunk.start_byte.to_le_bytes());
        hash_field(&mut hasher, &chunk.end_byte.to_le_bytes());
    }
    for omitted in skipped {
        hash_field(&mut hasher, omitted.relative_path.as_bytes());
        hash_field(&mut hasher, format!("{:?}", omitted.reason).as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn stable_id(prefix: &str, fields: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for field in fields {
        hash_field(&mut hasher, field);
    }
    let digest = format!("{:x}", hasher.finalize());
    format!("{prefix}{}", &digest[..32])
}

fn hash_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn sha256_hex(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TestWorkspace {
        root: PathBuf,
    }

    impl TestWorkspace {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "omnia-workspace-indexer-{name}-{}-{}",
                std::process::id(),
                now_ms()
            ));
            fs::create_dir_all(&root).expect("test workspace should be created");
            Self { root }
        }

        fn write(&self, relative_path: &str, content: &[u8]) {
            let path = self.root.join(relative_path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("test parent should be created");
            }
            let mut file = File::create(path).expect("test file should be created");
            file.write_all(content)
                .expect("test file should be written");
            file.sync_all().expect("test file should be flushed");
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn compact_options() -> WorkspaceIndexOptions {
        WorkspaceIndexOptions {
            chunk_target_bytes: 512,
            chunk_overlap_bytes: 48,
            ..WorkspaceIndexOptions::default()
        }
    }

    #[test]
    fn indexes_supported_text_with_exact_hash_and_span_provenance() {
        let workspace = TestWorkspace::new("provenance");
        let content = "Dòng đầu tiên.\n\nOmnia giữ provenance cho từng đoạn.\n".repeat(30);
        workspace.write("docs/guide.md", content.as_bytes());
        workspace.write("src/main.rs", b"fn main() { println!(\"hello\"); }\n");
        workspace.write("assets/image.bin", &[0, 1, 2, 3, 0, 4]);

        let snapshot = build_workspace_index(
            "workspace_0123456789abcdef0123456789abcdef",
            Some("project_0123456789abcdef0123456789abcdef"),
            &workspace.root,
            &compact_options(),
        )
        .expect("index should build");

        assert_eq!(snapshot.sources.len(), 2);
        assert!(snapshot.chunks.len() > 2);
        assert!(!snapshot.snapshot_sha256.is_empty());
        let guide = snapshot
            .sources
            .iter()
            .find(|source| source.relative_path == "docs/guide.md")
            .expect("guide source should exist");
        assert_eq!(guide.content_sha256, sha256_hex(content.as_bytes()));
        for chunk in snapshot
            .chunks
            .iter()
            .filter(|chunk| chunk.source_id == guide.source_id)
        {
            let actual = &content.as_bytes()[chunk.start_byte..chunk.end_byte];
            assert_eq!(actual, chunk.content.as_bytes());
            assert_eq!(chunk.content_sha256, sha256_hex(actual));
            assert!(chunk.start_line >= 1);
            assert!(chunk.end_line >= chunk.start_line);
        }
        assert!(snapshot.skipped.iter().any(|skipped| {
            skipped.relative_path == "assets/image.bin"
                && skipped.reason == WorkspaceSkipReason::UnsupportedType
        }));
    }

    #[test]
    fn skips_sensitive_paths_private_keys_and_builtin_directories() {
        let workspace = TestWorkspace::new("sensitive");
        workspace.write(".env", b"API_KEY=do-not-index\n");
        workspace.write(".env.example", b"API_KEY=replace-me\n");
        workspace.write(
            "keys/example.txt",
            b"-----BEGIN PRIVATE KEY-----\nnot-real\n-----END PRIVATE KEY-----\n",
        );
        workspace.write("node_modules/pkg/index.js", b"export default 1;\n");
        workspace.write("src/safe.ts", b"export const safe = true;\n");

        let snapshot = build_workspace_index(
            "workspace_sensitive",
            None,
            &workspace.root,
            &compact_options(),
        )
        .expect("index should build");

        let indexed_paths = snapshot
            .sources
            .iter()
            .map(|source| source.relative_path.as_str())
            .collect::<BTreeSet<_>>();
        assert!(indexed_paths.contains(".env.example"));
        assert!(indexed_paths.contains("src/safe.ts"));
        assert!(!indexed_paths.contains(".env"));
        assert!(!indexed_paths.contains("keys/example.txt"));
        assert!(!indexed_paths.contains("node_modules/pkg/index.js"));
        assert!(snapshot
            .skipped
            .iter()
            .any(|skipped| skipped.reason == WorkspaceSkipReason::SensitiveContent));
    }

    #[test]
    fn user_ignore_patterns_are_deterministic_and_support_negation() {
        assert!(is_user_ignored(
            "generated/api.ts",
            false,
            &["generated/**".to_owned()]
        ));
        assert!(!is_user_ignored(
            "generated/keep.ts",
            false,
            &["generated/**".to_owned(), "!generated/keep.ts".to_owned()]
        ));
        assert!(is_user_ignored(
            "src/debug.test.ts",
            false,
            &["*.test.ts".to_owned()]
        ));
        assert!(!is_user_ignored(
            "src/app.ts",
            false,
            &["*.test.ts".to_owned()]
        ));
    }

    #[test]
    fn indexing_is_content_deterministic_even_when_timestamps_change() {
        let workspace = TestWorkspace::new("deterministic");
        workspace.write("README.md", b"Omnia deterministic workspace index.\n");
        let first = build_workspace_index(
            "workspace_deterministic",
            None,
            &workspace.root,
            &compact_options(),
        )
        .expect("first index should build");
        let second = build_workspace_index(
            "workspace_deterministic",
            None,
            &workspace.root,
            &compact_options(),
        )
        .expect("second index should build");
        assert_eq!(first.snapshot_sha256, second.snapshot_sha256);
        assert_eq!(first.sources[0].source_id, second.sources[0].source_id);
        assert_eq!(first.chunks[0].chunk_id, second.chunks[0].chunk_id);
    }

    #[test]
    fn hard_limits_are_visible_in_snapshot_instead_of_silent() {
        let workspace = TestWorkspace::new("limits");
        workspace.write("a.txt", b"alpha\n");
        workspace.write("b.txt", b"beta\n");
        let options = WorkspaceIndexOptions {
            max_files: 1,
            chunk_target_bytes: 512,
            chunk_overlap_bytes: 0,
            ..WorkspaceIndexOptions::default()
        };
        let snapshot = build_workspace_index("workspace_limits", None, &workspace.root, &options)
            .expect("limited index should build");
        assert!(snapshot.truncated);
        assert_eq!(snapshot.sources.len(), 1);
        assert!(snapshot
            .skipped
            .iter()
            .any(|skipped| skipped.reason == WorkspaceSkipReason::MaxFilesReached));
    }

    #[test]
    fn lexical_retrieval_obeys_token_and_source_budgets_with_omission_reasons() {
        let workspace = TestWorkspace::new("retrieval");
        workspace.write(
            "docs/harness.md",
            &"The context compiler preserves citation provenance and token budgets.\n"
                .repeat(30)
                .into_bytes(),
        );
        workspace.write(
            "docs/providers.md",
            b"Provider adapters normalize streaming events and capabilities.\n",
        );
        let snapshot = build_workspace_index(
            "workspace_retrieval",
            Some("project_retrieval"),
            &workspace.root,
            &compact_options(),
        )
        .expect("index should build");
        let result = retrieve_workspace_chunks(
            &snapshot.chunks,
            "citation provenance token budget",
            &WorkspaceRetrievalOptions {
                token_budget: 220,
                max_results: 2,
                max_results_per_source: 1,
                ..WorkspaceRetrievalOptions::default()
            },
        )
        .expect("retrieval should succeed");
        assert!(!result.matches.is_empty());
        assert_eq!(result.matches[0].chunk.relative_path, "docs/harness.md");
        assert!(result.consumed_tokens <= result.token_budget);
        assert!(result.matches.len() <= 2);
        assert!(result.omissions.iter().any(|omission| {
            matches!(
                omission.reason,
                WorkspaceRetrievalOmissionReason::SourceLimit
                    | WorkspaceRetrievalOmissionReason::TokenBudget
                    | WorkspaceRetrievalOmissionReason::MaxResults
            )
        }));
    }

    #[test]
    fn retrieval_deduplicates_identical_chunks_and_hashes_query_without_echoing_it() {
        let workspace = TestWorkspace::new("dedupe");
        workspace.write("a.txt", b"grounded retrieval citation\n");
        workspace.write("b.txt", b"grounded retrieval citation\n");
        let snapshot = build_workspace_index(
            "workspace_dedupe",
            None,
            &workspace.root,
            &compact_options(),
        )
        .expect("index should build");
        let result = retrieve_workspace_chunks(
            &snapshot.chunks,
            "grounded retrieval",
            &WorkspaceRetrievalOptions::default(),
        )
        .expect("retrieval should succeed");
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.query_sha256, sha256_hex(b"grounded retrieval"));
        assert!(result.omissions.iter().any(|omission| {
            omission.reason == WorkspaceRetrievalOmissionReason::DuplicateContent
        }));
    }

    #[test]
    fn invalid_options_and_empty_queries_fail_closed() {
        let workspace = TestWorkspace::new("invalid");
        let invalid = WorkspaceIndexOptions {
            chunk_target_bytes: 100,
            ..WorkspaceIndexOptions::default()
        };
        assert!(
            build_workspace_index("workspace_invalid", None, &workspace.root, &invalid).is_err()
        );
        assert!(
            retrieve_workspace_chunks(&[], "   ", &WorkspaceRetrievalOptions::default()).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_are_never_followed() {
        use std::os::unix::fs::symlink;

        let workspace = TestWorkspace::new("symlink");
        let outside = TestWorkspace::new("outside");
        outside.write("secret.txt", b"outside secret\n");
        symlink(
            outside.root.join("secret.txt"),
            workspace.root.join("linked.txt"),
        )
        .expect("symlink should be created");
        let snapshot = build_workspace_index(
            "workspace_symlink",
            None,
            &workspace.root,
            &compact_options(),
        )
        .expect("index should build");
        assert!(snapshot.sources.is_empty());
        assert!(snapshot
            .skipped
            .iter()
            .any(|skipped| skipped.reason == WorkspaceSkipReason::ReparsePoint));
    }
}
