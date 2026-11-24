//! Collision-proof Source Library with immutable `source_id`/`remote_id`, intra/cross-batch
//! SHA-256 deduplication, `allow_overflow_notebook: false` enforcement, `exclude_videos` /
//! `pure_documents_only` filtering, and unambiguous citation resolution.

use std::collections::BTreeMap;
use std::sync::Arc;

use omnia_connector_gateway::artifact_intake::{
    normalize_canonical_artifact_intake, IntakeSourceKind,
};
use omnia_core::{now_epoch_ms, sha256_hex, SecretRedactor};
use omnia_harness::fold_vietnamese_ascii;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::NotebookError;
use crate::policy::{
    extract_extension_lower, validate_filename_and_mime, ARTIFACT_INTAKE_ALLOWED_EXTENSIONS,
    DEFAULT_MAX_SOURCES_PER_NOTEBOOK,
};
use crate::store::{NotebookStore, SyncTombstoneRow};

/// High-level semantic category of a notebook source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Document,
    Spreadsheet,
    Presentation,
    Pdf,
    CodeRepository,
    NotebookIpynb,
    WebHtml,
    StructuredData,
    Image,
    Audio,
    Video,
    TranscriptShare,
    PromotedBtw,
    CopiedText,
    Archive,
    Binary,
}

impl SourceKind {
    /// Canonical snake_case tag persisted in SQLite.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Document => "document",
            Self::Spreadsheet => "spreadsheet",
            Self::Presentation => "presentation",
            Self::Pdf => "pdf",
            Self::CodeRepository => "code_repository",
            Self::NotebookIpynb => "notebook_ipynb",
            Self::WebHtml => "web_html",
            Self::StructuredData => "structured_data",
            Self::Image => "image",
            Self::Audio => "audio",
            Self::Video => "video",
            Self::TranscriptShare => "transcript_share",
            Self::PromotedBtw => "promoted_btw",
            Self::CopiedText => "copied_text",
            Self::Archive => "archive",
            Self::Binary => "binary",
        }
    }

    /// Lossy parser for persisted DB strings.
    #[must_use]
    pub fn from_str_lossy(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "document" => Self::Document,
            "spreadsheet" => Self::Spreadsheet,
            "presentation" => Self::Presentation,
            "pdf" => Self::Pdf,
            "code_repository" => Self::CodeRepository,
            "notebook_ipynb" => Self::NotebookIpynb,
            "web_html" => Self::WebHtml,
            "structured_data" => Self::StructuredData,
            "image" => Self::Image,
            "audio" => Self::Audio,
            "video" => Self::Video,
            "transcript_share" => Self::TranscriptShare,
            "promoted_btw" => Self::PromotedBtw,
            "copied_text" => Self::CopiedText,
            "archive" => Self::Archive,
            _ => Self::Binary,
        }
    }

    /// Classify source kind from filename extension and MIME type.
    #[must_use]
    pub fn classify(filename: &str, mime_type: &str) -> Self {
        let ext = extract_extension_lower(filename);
        let mime = mime_type.to_ascii_lowercase();
        if mime.starts_with("video/") || matches!(ext.as_str(), "mp4" | "webm" | "mkv" | "mov") {
            return Self::Video;
        }
        if mime.starts_with("audio/") || matches!(ext.as_str(), "mp3" | "wav" | "ogg" | "m4a") {
            return Self::Audio;
        }
        if mime.starts_with("image/")
            || matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "svg")
        {
            return Self::Image;
        }
        match ext.as_str() {
            "pdf" => Self::Pdf,
            "docx" | "odt" | "epub" | "rtf" | "md" | "mdx" | "txt" | "rst" | "adoc" | "tex" => {
                Self::Document
            }
            "xlsx" | "xls" | "ods" | "csv" | "tsv" => Self::Spreadsheet,
            "pptx" => Self::Presentation,
            "ipynb" => Self::NotebookIpynb,
            "html" | "htm" | "xhtml" => Self::WebHtml,
            "json" | "xml" | "yaml" | "yml" | "toml" => Self::StructuredData,
            "zip" | "jar" | "tar" | "tgz" | "gz" => Self::Archive,
            _ if mime == "application/octet-stream" => Self::Binary,
            _ => Self::Document,
        }
    }

    /// Returns `true` when this kind represents a pure textual/document/structured source
    /// (excluding videos, audio, raster/vector images, and raw opaque binaries).
    #[must_use]
    pub const fn is_pure_document(self) -> bool {
        !matches!(self, Self::Video | Self::Audio | Self::Image | Self::Binary)
    }
}

/// Persisted Notebook metadata record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotebookRecord {
    pub notebook_id: String,
    pub title: String,
    pub description: String,
    /// Strictly `false` by default — overflow notebooks are disallowed.
    pub allow_overflow_notebook: bool,
    pub max_sources: usize,
    pub model_id: String,
    pub effort_level: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Request payload to create a new notebook.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateNotebookRequest {
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// Explicitly forced `false` unless caller opts in (default: `false`).
    #[serde(default)]
    pub allow_overflow_notebook: bool,
    #[serde(default = "default_max_sources_value")]
    pub max_sources: usize,
    #[serde(default = "default_model_id")]
    pub model_id: String,
    #[serde(default = "default_effort_level")]
    pub effort_level: String,
}

fn default_max_sources_value() -> usize {
    DEFAULT_MAX_SOURCES_PER_NOTEBOOK
}

fn default_model_id() -> String {
    "gemini-3.5-flash-lite".to_string()
}

fn default_effort_level() -> String {
    "medium".to_string()
}

/// Collision-proof persisted source record (`SourceRecord` public Wave 3 contract).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceRecord {
    /// Immutable collision-proof local identifier (`src_<uuid>`).
    pub source_id: String,
    pub notebook_id: String,
    /// Optional immutable upstream remote identifier (e.g., NotebookLM / Gemini Share ID).
    pub remote_id: Option<String>,
    pub title: String,
    pub safe_filename: String,
    pub mime_type: String,
    pub source_kind: SourceKind,
    pub is_video: bool,
    /// Lowercase 64-hex SHA-256 content digest used for intra/cross-batch dedup.
    pub content_sha256: String,
    /// Lowercase 64-hex BLAKE3 content digest.
    pub content_blake3: String,
    pub byte_size: u64,
    pub chunk_count: usize,
    pub ingestion_stage: String,
    pub provenance: String,
    pub metadata: Value,
    pub created_at_ms: i64,
}

/// Semantic chunk persisted in `notebook_chunks` (`<= 120 KiB` each).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceChunkRecord {
    pub chunk_id: String,
    pub notebook_id: String,
    pub source_id: String,
    pub chunk_idx: usize,
    pub heading: String,
    pub body: String,
    pub token_count: usize,
    pub byte_size: usize,
    pub content_blake3: String,
}

/// Query filter for listing or searching sources (`exclude_videos` / `pure_documents_only`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceFilter {
    #[serde(default)]
    pub exclude_videos: bool,
    #[serde(default)]
    pub pure_documents_only: bool,
    #[serde(default)]
    pub source_kinds: Option<Vec<SourceKind>>,
    #[serde(default)]
    pub query: Option<String>,
}

impl SourceFilter {
    #[must_use]
    pub fn matches(&self, record: &SourceRecord, query_folded: Option<&str>) -> bool {
        if self.exclude_videos && (record.is_video || record.source_kind == SourceKind::Video) {
            return false;
        }
        if self.pure_documents_only && !record.source_kind.is_pure_document() {
            return false;
        }
        if let Some(kinds) = &self.source_kinds {
            if !kinds.contains(&record.source_kind) {
                return false;
            }
        }
        if let Some(q) = query_folded {
            let haystack = format!(
                "{} {} {}",
                fold_vietnamese_ascii(&record.title),
                fold_vietnamese_ascii(&record.safe_filename),
                record.source_id.to_ascii_lowercase()
            );
            if !haystack.contains(q) {
                return false;
            }
        }
        true
    }
}

/// Receipt proving `clear_sources` removed sources/chunks while preserving artifacts & chat history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClearSourcesReceipt {
    pub notebook_id: String,
    pub removed_sources: usize,
    pub removed_chunks: usize,
    pub preserved_artifacts: usize,
    pub preserved_turns: usize,
    pub preserved_btw_threads: usize,
}

/// Result of registering one source (either newly stored or deduplicated by SHA-256).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceRegistrationOutcome {
    pub source: SourceRecord,
    pub deduplicated: bool,
    pub existing_source_id: Option<String>,
}

/// Input descriptor for batch registration with intra-batch & cross-batch SHA-256 dedup.
#[derive(Debug, Clone)]
pub struct SourceRegistrationInput {
    pub notebook_id: String,
    pub remote_id: Option<String>,
    pub title: String,
    pub filename: String,
    pub mime_type: Option<String>,
    pub source_kind_override: Option<SourceKind>,
    pub raw_bytes: Vec<u8>,
    pub chunks: Vec<(String, String)>,
    pub ingestion_stage: String,
    pub provenance: String,
    pub metadata: Value,
}

/// Outcome report for a multi-source batch registration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceBatchDedupReport {
    pub notebook_id: String,
    pub inserted: Vec<SourceRecord>,
    pub intra_batch_duplicates: usize,
    pub cross_batch_duplicates: usize,
    pub duplicate_mappings: BTreeMap<String, String>,
}

/// Resolved unambiguous citation target.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedCitationTarget {
    pub source_id: String,
    pub remote_id: Option<String>,
    pub title: String,
    pub content_sha256: String,
    pub resolved_via: String,
}

/// Collision-proof Source Library managing immutable IDs, SHA-256 dedup, capacity, and citation identity.
#[derive(Debug, Clone)]
pub struct SourceLibrary {
    store: Arc<NotebookStore>,
}

impl SourceLibrary {
    #[must_use]
    pub fn new(store: Arc<NotebookStore>) -> Self {
        Self { store }
    }

    /// Create a new notebook (enforcing `allow_overflow_notebook: false` by default).
    pub fn create_notebook(
        &self,
        req: CreateNotebookRequest,
    ) -> Result<NotebookRecord, NotebookError> {
        let title = SecretRedactor::redact(req.title.trim());
        if title.is_empty() {
            return Err(NotebookError::InvalidInput(
                "notebook title cannot be empty".to_string(),
            ));
        }
        if req.allow_overflow_notebook {
            return Err(NotebookError::PolicyBlocked {
                code: "OVERFLOW_NOTEBOOK_FORBIDDEN",
                reason: "allow_overflow_notebook must remain false per Atelier Studio policy"
                    .to_string(),
            });
        }
        let max_sources = req.max_sources.clamp(1, 500);
        let now = now_epoch_ms();
        let record = NotebookRecord {
            notebook_id: format!("nb_{}", Uuid::new_v4().simple()),
            title,
            description: SecretRedactor::redact(req.description.trim()),
            allow_overflow_notebook: false,
            max_sources,
            model_id: if req.model_id.trim().is_empty() {
                default_model_id()
            } else {
                req.model_id.trim().to_string()
            },
            effort_level: if req.effort_level.trim().is_empty() {
                default_effort_level()
            } else {
                req.effort_level.trim().to_ascii_lowercase()
            },
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.store.create_notebook(&record)?;
        Ok(record)
    }

    /// Fetch a notebook record or return `NotFound`.
    pub fn require_notebook(&self, notebook_id: &str) -> Result<NotebookRecord, NotebookError> {
        self.store
            .get_notebook(notebook_id)?
            .ok_or_else(|| NotebookError::NotFound {
                entity: "notebook",
                id: notebook_id.to_string(),
            })
    }

    /// Register a single source with SHA-256 cross-batch dedup, `artifact_intake` canonical check,
    /// and strict `allow_overflow_notebook: false` capacity guard.
    pub fn register_source(
        &self,
        input: SourceRegistrationInput,
    ) -> Result<SourceRegistrationOutcome, NotebookError> {
        let notebook = self.require_notebook(&input.notebook_id)?;
        let (safe_filename, resolved_mime) =
            validate_filename_and_mime(&input.filename, input.mime_type.as_deref(), false)?;

        let content_sha256 = sha256_hex(&input.raw_bytes);
        let content_blake3 = blake3::hash(&input.raw_bytes).to_hex().to_string();

        // Cross-batch SHA-256 deduplication check.
        if let Some(existing) = self
            .store
            .find_source_by_sha256(&input.notebook_id, &content_sha256)?
        {
            return Ok(SourceRegistrationOutcome {
                existing_source_id: Some(existing.source_id.clone()),
                source: existing,
                deduplicated: true,
            });
        }

        // Enforce strict `allow_overflow_notebook: false` cap (fast path; re-checked atomically
        // inside the store's IMMEDIATE write transaction to close the concurrent-ingest race).
        let current_count = self.store.count_sources(&input.notebook_id)?;
        if current_count >= notebook.max_sources {
            return Err(NotebookError::OverflowDisallowed {
                notebook_id: notebook.notebook_id,
                current: current_count,
                max: notebook.max_sources,
            });
        }

        // Immutable `remote_id` binding: never collides with local `src_` IDs and is unique per notebook.
        let remote_id = input
            .remote_id
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map(str::to_string);
        if let Some(rid) = remote_id.as_deref() {
            if rid.starts_with("src_") {
                return Err(NotebookError::InvalidInput(format!(
                    "remote_id '{rid}' must not use the reserved local 'src_' prefix"
                )));
            }
            if let Some(existing) = self.store.find_source_id_by_remote(&input.notebook_id, rid)? {
                return Err(NotebookError::RemoteIdConflict {
                    remote_id: rid.to_string(),
                    existing_source_id: existing,
                });
            }
        }

        let source_id = format!("src_{}", Uuid::new_v4().simple());
        let safe_title = SecretRedactor::redact(if input.title.trim().is_empty() {
            &safe_filename
        } else {
            input.title.trim()
        });

        // Wire `omnia-connector-gateway::artifact_intake` canonical validation for canonical extensions.
        let ext = extract_extension_lower(&safe_filename);
        let safe_metadata = if ARTIFACT_INTAKE_ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
            let intake_manifest = json!({
                "manifest_id": format!("intake_{source_id}"),
                "source_kind": IntakeSourceKind::GeminiNotebook.as_str(),
                "artifacts": [{
                    "artifact_id": source_id,
                    "title": safe_title,
                    "filename": safe_filename,
                    "sha256": content_sha256,
                    "byte_size": input.raw_bytes.len() as u64,
                    "mime_type": resolved_mime,
                    "metadata": input.metadata,
                }]
            });
            let canonical = normalize_canonical_artifact_intake(&intake_manifest)?;
            canonical
                .artifacts
                .into_iter()
                .next()
                .map(|a| Value::Object(a.metadata))
                .unwrap_or_else(|| json!({}))
        } else {
            SecretRedactor::redact_json(&input.metadata)
        };

        let source_kind = input
            .source_kind_override
            .unwrap_or_else(|| SourceKind::classify(&safe_filename, &resolved_mime));
        let is_video = source_kind == SourceKind::Video;
        let now = now_epoch_ms();

        let chunk_records: Vec<SourceChunkRecord> = input
            .chunks
            .into_iter()
            .enumerate()
            .map(|(idx, (heading, body))| {
                let redacted_body = SecretRedactor::redact(&body);
                let redacted_heading = SecretRedactor::redact(&heading);
                let token_count = redacted_body.split_whitespace().count();
                let byte_size = redacted_body.len();
                let chunk_blake3 = blake3::hash(redacted_body.as_bytes()).to_hex().to_string();
                SourceChunkRecord {
                    chunk_id: format!("{source_id}:c{idx}"),
                    notebook_id: input.notebook_id.clone(),
                    source_id: source_id.clone(),
                    chunk_idx: idx,
                    heading: redacted_heading,
                    body: redacted_body,
                    token_count,
                    byte_size,
                    content_blake3: chunk_blake3,
                }
            })
            .collect();

        let record = SourceRecord {
            source_id,
            notebook_id: input.notebook_id,
            remote_id,
            title: safe_title,
            safe_filename,
            mime_type: resolved_mime,
            source_kind,
            is_video,
            content_sha256,
            content_blake3,
            byte_size: input.raw_bytes.len() as u64,
            chunk_count: chunk_records.len(),
            ingestion_stage: input.ingestion_stage,
            provenance: input.provenance,
            metadata: safe_metadata,
            created_at_ms: now,
        };

        self.store
            .insert_source_with_chunks(&record, &chunk_records)?;

        Ok(SourceRegistrationOutcome {
            source: record,
            deduplicated: false,
            existing_source_id: None,
        })
    }

    /// Register a batch of sources with BOTH intra-batch and cross-batch SHA-256 deduplication.
    pub fn register_batch(
        &self,
        notebook_id: &str,
        items: Vec<SourceRegistrationInput>,
    ) -> Result<SourceBatchDedupReport, NotebookError> {
        let _ = self.require_notebook(notebook_id)?;
        let mut seen_in_batch: BTreeMap<String, String> = BTreeMap::new();
        let mut inserted = Vec::new();
        let mut intra_batch_duplicates = 0usize;
        let mut cross_batch_duplicates = 0usize;
        let mut duplicate_mappings = BTreeMap::new();

        for mut item in items {
            item.notebook_id = notebook_id.to_string();
            let sha = sha256_hex(&item.raw_bytes);
            if let Some(primary_id) = seen_in_batch.get(&sha) {
                intra_batch_duplicates += 1;
                duplicate_mappings.insert(item.filename.clone(), primary_id.clone());
                continue;
            }
            let outcome = self.register_source(item)?;
            if outcome.deduplicated {
                cross_batch_duplicates += 1;
                if let Some(existing) = outcome.existing_source_id {
                    seen_in_batch.insert(sha, existing.clone());
                    duplicate_mappings.insert(outcome.source.safe_filename.clone(), existing);
                }
            } else {
                seen_in_batch.insert(sha, outcome.source.source_id.clone());
                inserted.push(outcome.source);
            }
        }

        Ok(SourceBatchDedupReport {
            notebook_id: notebook_id.to_string(),
            inserted,
            intra_batch_duplicates,
            cross_batch_duplicates,
            duplicate_mappings,
        })
    }

    /// Resolve a citation reference unambiguously:
    /// 1. Exact immutable `source_id` or `remote_id` ALWAYS succeeds unambiguously.
    /// 2. Title match succeeds ONLY when strictly one source in the notebook carries that title.
    /// 3. Duplicate titles reject with [`NotebookError::AmbiguousCitation`], forcing callers to cite by `source_id`.
    pub fn resolve_citation_ref(
        &self,
        notebook_id: &str,
        reference: &str,
    ) -> Result<ResolvedCitationTarget, NotebookError> {
        let trimmed = reference.trim();
        if trimmed.is_empty() {
            return Err(NotebookError::InvalidInput(
                "citation reference cannot be empty".to_string(),
            ));
        }

        if let Some(src) = self.store.find_source_by_id_or_remote(notebook_id, trimmed)? {
            let via = if src.source_id == trimmed {
                "source_id"
            } else {
                "remote_id"
            };
            return Ok(ResolvedCitationTarget {
                source_id: src.source_id,
                remote_id: src.remote_id,
                title: src.title,
                content_sha256: src.content_sha256,
                resolved_via: via.to_string(),
            });
        }

        let by_title = self.store.find_sources_by_title(notebook_id, trimmed)?;
        match by_title.len() {
            0 => Err(NotebookError::NotFound {
                entity: "source",
                id: trimmed.to_string(),
            }),
            1 => {
                let src = &by_title[0];
                Ok(ResolvedCitationTarget {
                    source_id: src.source_id.clone(),
                    remote_id: src.remote_id.clone(),
                    title: src.title.clone(),
                    content_sha256: src.content_sha256.clone(),
                    resolved_via: "unique_title".to_string(),
                })
            }
            _ => Err(NotebookError::AmbiguousCitation {
                title: trimmed.to_string(),
                matching_source_ids: by_title.into_iter().map(|s| s.source_id).collect(),
            }),
        }
    }

    /// List sources applying `exclude_videos` / `pure_documents_only` and optional query filters.
    pub fn list_sources(
        &self,
        notebook_id: &str,
        filter: &SourceFilter,
    ) -> Result<Vec<SourceRecord>, NotebookError> {
        let _ = self.require_notebook(notebook_id)?;
        self.store.list_sources(notebook_id, filter)
    }

    /// Clear all sources and chunks for a notebook while strictly preserving Studio artifacts & chat turns.
    pub fn clear_sources(&self, notebook_id: &str) -> Result<ClearSourcesReceipt, NotebookError> {
        self.store.clear_sources(notebook_id)
    }

    /// Delete one source by `source_id` or `remote_id`, recording a sync tombstone.
    pub fn delete_source(
        &self,
        notebook_id: &str,
        source_id_or_remote: &str,
        reason: Option<&str>,
    ) -> Result<Option<SyncTombstoneRow>, NotebookError> {
        let _ = self.require_notebook(notebook_id)?;
        self.store.delete_source_with_tombstone(
            notebook_id,
            source_id_or_remote.trim(),
            reason.unwrap_or("user_deleted"),
        )
    }

    /// Tombstone-safe remote source reconciliation (`sourceLibrary.js` / `syncService.js`):
    /// - Suppressed items matching active tombstones (`remote_id`, `tombstone_key`, or `content_sha256`)
    ///   NEVER resurrect on sync.
    /// - When `remote_snapshot_complete` is true and `remote_items` is empty, records/confirms empty
    ///   remote state without resurrecting stale local sources removed upstream.
    pub fn reconcile_remote_sources(
        &self,
        notebook_id: &str,
        remote_items: &[RemoteSyncItem],
        remote_snapshot_complete: bool,
    ) -> Result<RemoteReconcileReport, NotebookError> {
        let _ = self.require_notebook(notebook_id)?;
        let tombstones = self.store.list_tombstones(notebook_id)?;
        let mut suppressed = Vec::new();
        let mut kept_remote_ids = Vec::new();

        for item in remote_items {
            let matches_tombstone = tombstones.iter().any(|t| {
                t.tombstone_key == item.remote_id
                    || t.remote_id.as_deref() == Some(item.remote_id.as_str())
                    || item
                        .content_sha256
                        .as_deref()
                        .is_some_and(|sha| t.content_sha256.as_deref() == Some(sha))
            });
            if matches_tombstone {
                suppressed.push(item.remote_id.clone());
            } else {
                kept_remote_ids.push(item.remote_id.clone());
            }
        }

        let mut stale_local_removed = 0usize;
        if remote_snapshot_complete {
            let existing = self.store.list_sources(notebook_id, &SourceFilter::default())?;
            let mut to_remove = Vec::new();
            for src in &existing {
                if let Some(ref rid) = src.remote_id {
                    if !kept_remote_ids.iter().any(|k| k == rid) {
                        to_remove.push(src.source_id.clone());
                    }
                }
            }
            if !to_remove.is_empty() {
                stale_local_removed = self.store.delete_sources_by_ids(&to_remove)?;
            }
            if remote_items.is_empty() {
                self.store.record_tombstone(&SyncTombstoneRow {
                    notebook_id: notebook_id.to_string(),
                    tombstone_key: "__empty_remote_confirmed__".to_string(),
                    remote_id: None,
                    content_sha256: None,
                    reason: "empty_remote_snapshot".to_string(),
                    deleted_at_ms: now_epoch_ms(),
                })?;
            }
        }

        let active_sources = self.store.list_sources(notebook_id, &SourceFilter::default())?;
        Ok(RemoteReconcileReport {
            notebook_id: notebook_id.to_string(),
            active_sources,
            suppressed_tombstoned_ids: suppressed,
            kept_remote_ids,
            stale_local_removed,
            tombstone_count: tombstones.len(),
            empty_remote_confirmed: remote_snapshot_complete && remote_items.is_empty(),
        })
    }
}

/// Descriptor for a remote source entry checked during tombstone-safe sync reconciliation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteSyncItem {
    pub remote_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content_sha256: Option<String>,
}

/// Tombstone-safe reconciliation report returned by [`SourceLibrary::reconcile_remote_sources`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteReconcileReport {
    pub notebook_id: String,
    pub active_sources: Vec<SourceRecord>,
    pub suppressed_tombstoned_ids: Vec<String>,
    pub kept_remote_ids: Vec<String>,
    pub stale_local_removed: usize,
    pub tombstone_count: usize,
    pub empty_remote_confirmed: bool,
}
