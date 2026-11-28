//! 6-Stage Self-Healing Ingestion Engine and pure-Rust document converters.
//!
//! Pipeline stages:
//! 1. `Stage1NativeValidate` — MIME allowlist, Win32 filename sanitization, security checks, SHA-256/BLAKE3.
//! 2. `Stage2Utf8Normalize` — BOM/UTF-16 decoding, LF normalization, control-char cleanup.
//! 3. `Stage3FormatConvert` — Pure-Rust OOXML (`docx`/`xlsx`/`pptx`), PDF, EPUB, ODT, RTF, HTML,
//!    Markdown, CSV/TSV, JSON, IPYNB, XML, and Code-Repository-to-Markdown converters.
//! 4. `Stage4SemanticChunk` — `<= 120 KiB` heading-aware semantic chunker with atomic multi-part sibling rollback.
//! 5. `Stage5CopiedTextFallback` — `<= 40 KiB` copied-text slice fallback when native conversion yields no text.
//! 6. `Stage6HealSweep` — Post-ingestion repair sweep for degraded or zero-chunk sources.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::Arc;

use flate2::read::ZlibDecoder;
use ignore::WalkBuilder;
use omnia_connector_gateway::find_unsafe_prototype_key;
use omnia_core::{sha256_hex, SecretRedactor};
use omnia_workspace_ops::is_reparse_point_metadata;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zip::ZipArchive;

use crate::error::NotebookError;
use crate::policy::{
    extract_extension_lower, infer_mime_from_extension, normalize_drive_filename_suffix,
    sanitize_transport_filename, strip_local_path_fields, validate_archive_entry_path,
    validate_archive_limits, validate_filename_and_mime, validate_xml_safety, MAX_ARCHIVE_DEPTH,
    MAX_ARCHIVE_ENTRIES, MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES, MAX_CHUNK_BYTES,
    MAX_COPIED_TEXT_BYTES, MAX_TRANSPORT_FILENAME_LEN,
};
use crate::source_library::{
    SourceChunkRecord, SourceKind, SourceLibrary, SourceRecord, SourceRegistrationInput,
    SourceRegistrationOutcome,
};
use crate::store::NotebookStore;

/// Explicit stage identifier for the 6-stage self-healing ingestion pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IngestionStage {
    Stage1NativeValidate,
    Stage2Utf8Normalize,
    Stage3FormatConvert,
    Stage4SemanticChunk,
    Stage5CopiedTextFallback,
    Stage6HealSweep,
}

impl IngestionStage {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Stage1NativeValidate => "stage1_native_validate",
            Self::Stage2Utf8Normalize => "stage2_utf8_normalize",
            Self::Stage3FormatConvert => "stage3_format_convert",
            Self::Stage4SemanticChunk => "stage4_semantic_chunk",
            Self::Stage5CopiedTextFallback => "stage5_copied_text_fallback",
            Self::Stage6HealSweep => "stage6_heal_sweep",
        }
    }
}

/// Request to ingest one document/file/payload into a notebook.
#[derive(Debug, Clone)]
pub struct IngestSourceRequest {
    pub notebook_id: String,
    pub title: Option<String>,
    pub filename: String,
    pub mime_type: Option<String>,
    pub remote_id: Option<String>,
    pub bytes: Vec<u8>,
    /// Optional fallback text used by Stage 5 (`<= 40 KiB`) when native binary extraction yields no text.
    pub copied_text_fallback: Option<String>,
    /// Optional override for semantic chunk limit (clamped to `<= 120 KiB`).
    pub max_chunk_bytes: Option<usize>,
    pub metadata: Value,
}

/// Result of running the 6-stage ingestion pipeline on one input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IngestSourceOutcome {
    pub source: SourceRecord,
    pub deduplicated: bool,
    pub stage_completed: IngestionStage,
    pub extracted_chars: usize,
    pub chunk_count: usize,
    pub warnings: Vec<String>,
}

/// Result of multi-part ingestion (either all parts persisted or all siblings rolled back).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MultipartIngestOutcome {
    pub notebook_id: String,
    pub sources: Vec<SourceRecord>,
    pub deduplicated_count: usize,
    pub warnings: Vec<String>,
}

/// Report emitted by Stage 6 `heal_sources`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealSweepReport {
    pub notebook_id: String,
    pub inspected: usize,
    pub already_healthy: usize,
    pub healed: usize,
    pub quarantined: usize,
    pub details: Vec<String>,
}

/// Parsed tabular sheet extracted from XLSX, CSV, or TSV.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedSheet {
    pub name: String,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// Parsed slide extracted from PPTX.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedSlide {
    pub slide_number: usize,
    pub title: String,
    pub lines: Vec<String>,
}

/// Parsed Jupyter notebook cell extracted from IPYNB.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedNotebookCell {
    pub cell_index: usize,
    pub cell_type: String,
    pub source: String,
    pub outputs: Vec<String>,
}

/// PDF inspection & text extraction classification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PdfClassification {
    ReadableText,
    ScannedOrNoText,
    Encrypted,
    Malformed,
}

/// Result of pure-Rust PDF inspection & extraction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PdfExtractionResult {
    pub classification: PdfClassification,
    pub pdf_version: Option<String>,
    pub estimated_pages: usize,
    pub is_encrypted: bool,
    pub extracted_text: String,
    pub warnings: Vec<String>,
}

/// Configuration for the pure-Rust code-repository-to-Markdown packager.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoPackageConfig {
    pub max_files: usize,
    pub max_file_bytes: usize,
    pub max_total_bytes: usize,
    pub respect_gitignore: bool,
    /// Explicit allowlist of authorized workspace roots. `package_code_repository` fails closed
    /// unless `root_dir` canonicalizes inside one of these roots with zero reparse-point ancestors.
    #[serde(default)]
    pub allowed_workspace_roots: Vec<std::path::PathBuf>,
}

impl Default for RepoPackageConfig {
    fn default() -> Self {
        Self {
            max_files: 500,
            max_file_bytes: 512 * 1024,
            max_total_bytes: 8 * 1024 * 1024,
            respect_gitignore: true,
            allowed_workspace_roots: Vec::new(),
        }
    }
}

impl RepoPackageConfig {
    /// Construct a default repository packaging config authorized for one workspace root.
    #[must_use]
    pub fn for_workspace_root(root: impl Into<std::path::PathBuf>) -> Self {
        Self {
            allowed_workspace_roots: vec![root.into()],
            ..Self::default()
        }
    }
}

/// Output of packaging a local code repository into deterministic Markdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackagedRepository {
    pub root_name: String,
    pub included_files: Vec<String>,
    pub skipped_binary_files: Vec<String>,
    pub skipped_oversize_files: Vec<String>,
    pub skipped_reparse_entries: Vec<String>,
    pub markdown: String,
}

/// 6-Stage Self-Healing Ingestion Engine.
#[derive(Debug, Clone)]
pub struct IngestionEngine {
    store: Arc<NotebookStore>,
    library: SourceLibrary,
}

impl IngestionEngine {
    #[must_use]
    pub fn new(store: Arc<NotebookStore>, library: SourceLibrary) -> Self {
        Self { store, library }
    }

    /// Execute stages 1..5 on a single source input and persist it atomically in SQLite WAL.
    pub fn ingest_source(
        &self,
        req: IngestSourceRequest,
    ) -> Result<IngestSourceOutcome, NotebookError> {
        // Stage 1: Native validation (Drive suffix normalization, MIME allowlist, safe filename, notebook presence).
        let _ = self.library.require_notebook(&req.notebook_id)?;
        let normalized_input_filename = normalize_drive_filename_suffix(&req.filename);
        let (safe_filename, resolved_mime) =
            validate_filename_and_mime(&normalized_input_filename, req.mime_type.as_deref(), false)?;
        let ext = extract_extension_lower(&safe_filename);
        let mut warnings = Vec::new();
        let mut source_kind_override: Option<SourceKind> = None;

        // Stage 2 + Stage 3: Format-specific pure-Rust extraction & normalization.
        let mut stage_completed = IngestionStage::Stage3FormatConvert;
        let extracted_text = match ext.as_str() {
            "docx" => extract_docx_markdown(&req.bytes, 0)?,
            "xlsx" => {
                let sheets = extract_xlsx_sheets(&req.bytes, 0)?;
                render_sheets_to_markdown(&sheets)
            }
            "pptx" => {
                let slides = extract_pptx_slides(&req.bytes, 0)?;
                render_slides_to_markdown(&slides)
            }
            "epub" => extract_epub_markdown(&req.bytes, 0)?,
            "odt" => extract_odt_markdown(&req.bytes, 0)?,
            "rtf" => strip_rtf_to_text(&normalize_utf8_and_lf(&req.bytes)),
            "pdf" => {
                let pdf = inspect_and_extract_pdf(&req.bytes);
                if pdf.is_encrypted || pdf.classification == PdfClassification::Encrypted {
                    return Err(NotebookError::SecurityRejected {
                        code: "ENCRYPTED_PDF",
                        reason: format!(
                            "encrypted PDF '{safe_filename}' cannot be ingested without authorized plaintext export"
                        ),
                    });
                }
                warnings.extend(pdf.warnings);
                pdf.extracted_text
            }
            "csv" => {
                let text = normalize_utf8_and_lf(&req.bytes);
                let sheet = parse_delimited_table(&safe_filename, &text, b',');
                render_sheets_to_markdown(&[sheet])
            }
            "tsv" => {
                let text = normalize_utf8_and_lf(&req.bytes);
                let sheet = parse_delimited_table(&safe_filename, &text, b'\t');
                render_sheets_to_markdown(&[sheet])
            }
            "ipynb" => {
                let cells = parse_ipynb_cells(&req.bytes)?;
                render_ipynb_to_markdown(&cells)
            }
            "html" | "htm" | "xhtml" => {
                let raw = normalize_utf8_and_lf(&req.bytes);
                clean_html_to_text(&raw)
            }
            "xml" | "svg" => {
                validate_xml_safety(&req.bytes, &safe_filename)?;
                extract_xml_text(&req.bytes, &safe_filename)?
            }
            "json" => clean_json_to_markdown(&req.bytes)?,
            "zip" | "jar" => {
                let entries = inspect_zip_archive_safe(&req.bytes, 0, &safe_filename)?;
                let mut lines = vec![format!("# Archive: {safe_filename}")];
                for entry in &entries {
                    lines.push(format!("- `{}` ({} bytes)", entry.path, entry.uncompressed_bytes));
                }
                lines.join("\n")
            }
            _ => {
                if is_likely_binary(&req.bytes) {
                    warnings.push(format!(
                        "binary payload '{safe_filename}' yielded no direct UTF-8 text"
                    ));
                    String::new()
                } else {
                    stage_completed = IngestionStage::Stage2Utf8Normalize;
                    normalize_utf8_and_lf(&req.bytes)
                }
            }
        };

        // Stage 4: Semantic chunking (`<= 120 KiB`) OR Stage 5: Copied-text fallback (`<= 40 KiB`).
        let mut final_text = extracted_text.trim().to_string();
        let chunk_limit = req
            .max_chunk_bytes
            .unwrap_or(MAX_CHUNK_BYTES)
            .clamp(256, MAX_CHUNK_BYTES);

        let chunks = if !final_text.is_empty() {
            stage_completed = IngestionStage::Stage4SemanticChunk;
            chunk_text_semantically(&final_text, chunk_limit)
        } else if let Some(fallback) = req
            .copied_text_fallback
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            stage_completed = IngestionStage::Stage5CopiedTextFallback;
            source_kind_override = Some(SourceKind::CopiedText);
            warnings.push(
                "native extraction empty; applied Stage 5 copied-text fallback (<= 40 KiB slices)"
                    .to_string(),
            );
            final_text = normalize_utf8_and_lf(fallback.as_bytes());
            chunk_copied_text_fallback(&final_text)
        } else {
            // Preserve metadata-only / media source cleanly with a descriptive metadata chunk.
            warnings.push(
                "no textual body extracted; persisted metadata placeholder chunk for Stage 6 heal sweep"
                    .to_string(),
            );
            vec![(
                "Metadata".to_string(),
                format!(
                    "Source `{safe_filename}` ({resolved_mime}, {} bytes).",
                    req.bytes.len()
                ),
            )]
        };

        let mut metadata = if req.metadata.is_object() {
            req.metadata
        } else {
            json!({})
        };
        strip_local_path_fields(&mut metadata);
        if let Some(obj) = metadata.as_object_mut() {
            obj.insert(
                "ingestion_warnings".to_string(),
                Value::Array(warnings.iter().cloned().map(Value::String).collect()),
            );
            if let Some(fb) = req.copied_text_fallback.as_deref() {
                let capped = truncate_utf8_bytes(fb.trim(), MAX_COPIED_TEXT_BYTES);
                obj.insert(
                    "fallback_text_excerpt".to_string(),
                    Value::String(SecretRedactor::redact(capped)),
                );
            }
        }

        let reg: SourceRegistrationOutcome = self.library.register_source(SourceRegistrationInput {
            notebook_id: req.notebook_id,
            remote_id: req.remote_id,
            title: req.title.unwrap_or_else(|| safe_filename.clone()),
            filename: safe_filename,
            mime_type: Some(resolved_mime),
            source_kind_override,
            raw_bytes: req.bytes,
            chunks,
            ingestion_stage: stage_completed.as_str().to_string(),
            provenance: "EXTRACTED".to_string(),
            metadata,
        })?;

        Ok(IngestSourceOutcome {
            chunk_count: reg.source.chunk_count,
            source: reg.source,
            deduplicated: reg.deduplicated,
            stage_completed,
            extracted_chars: final_text.chars().count(),
            warnings,
        })
    }

    /// Multi-part ingestion with atomic sibling rollback: if ANY part fails validation, conversion,
    /// or capacity enforcement, every sibling source already persisted in this batch is deleted.
    pub fn ingest_multipart_with_rollback(
        &self,
        notebook_id: &str,
        parts: Vec<IngestSourceRequest>,
    ) -> Result<MultipartIngestOutcome, NotebookError> {
        let _ = self.library.require_notebook(notebook_id)?;
        if parts.is_empty() {
            return Err(NotebookError::InvalidInput(
                "multipart ingestion batch cannot be empty".to_string(),
            ));
        }

        let mut inserted_new_ids: Vec<String> = Vec::new();
        let mut sources: Vec<SourceRecord> = Vec::new();
        let mut deduplicated_count = 0usize;
        let mut warnings = Vec::new();

        for (idx, mut part) in parts.into_iter().enumerate() {
            part.notebook_id = notebook_id.to_string();
            match self.ingest_source(part) {
                Ok(outcome) => {
                    if outcome.deduplicated {
                        deduplicated_count += 1;
                    } else {
                        inserted_new_ids.push(outcome.source.source_id.clone());
                    }
                    warnings.extend(outcome.warnings);
                    sources.push(outcome.source);
                }
                Err(err) => {
                    let rolled_back = self.store.delete_sources_by_ids(&inserted_new_ids)?;
                    return Err(NotebookError::IngestionFailed {
                        stage: format!("multipart_part_{idx}"),
                        detail: err.to_string(),
                        rolled_back_siblings: rolled_back,
                    });
                }
            }
        }

        Ok(MultipartIngestOutcome {
            notebook_id: notebook_id.to_string(),
            sources,
            deduplicated_count,
            warnings,
        })
    }

    /// Package a local code repository directory into deterministic Markdown and ingest it as a source.
    pub fn ingest_code_repository(
        &self,
        notebook_id: &str,
        root_dir: &Path,
        title: Option<String>,
        config: &RepoPackageConfig,
    ) -> Result<(IngestSourceOutcome, PackagedRepository), NotebookError> {
        let packaged = package_code_repository(root_dir, config)?;
        let md_bytes = packaged.markdown.as_bytes().to_vec();
        let filename = format!("{}_repo.md", sanitize_slug(&packaged.root_name));
        let req = IngestSourceRequest {
            notebook_id: notebook_id.to_string(),
            title: Some(title.unwrap_or_else(|| format!("Repository: {}", packaged.root_name))),
            filename,
            mime_type: Some("text/markdown".to_string()),
            remote_id: None,
            bytes: md_bytes,
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({
                "repository_root": packaged.root_name,
                "included_file_count": packaged.included_files.len(),
                "skipped_binary_count": packaged.skipped_binary_files.len(),
                "skipped_oversize_count": packaged.skipped_oversize_files.len(),
                "skipped_reparse_count": packaged.skipped_reparse_entries.len(),
            }),
        };

        let mut outcome = self.ingest_source(req)?;
        // Also classify source kind metadata in response cleanly (persisted markdown is already pure document).
        outcome.warnings.push(format!(
            "packaged {} repository files deterministically",
            packaged.included_files.len()
        ));
        Ok((outcome, packaged))
    }

    /// Stage 6 Heal Sweep: inspect all sources in `notebook_id` and repair zero-chunk sources
    /// using stored fallback text or deterministic metadata placeholder chunks.
    pub fn heal_sources(&self, notebook_id: &str) -> Result<HealSweepReport, NotebookError> {
        let _ = self.library.require_notebook(notebook_id)?;
        let sources = self
            .store
            .list_sources(notebook_id, &crate::source_library::SourceFilter::default())?;
        let mut already_healthy = 0usize;
        let mut healed = 0usize;
        let mut quarantined = 0usize;
        let mut details = Vec::new();

        for src in &sources {
            let chunks = self.store.list_chunks_for_source(&src.source_id)?;
            if !chunks.is_empty() && chunks.len() == src.chunk_count {
                already_healthy += 1;
                continue;
            }
            if let Some(fallback) = src
                .metadata
                .get("fallback_text_excerpt")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let slices = chunk_copied_text_fallback(fallback);
                let records = build_chunk_records(notebook_id, &src.source_id, slices);
                self.store.replace_source_chunks(
                    &src.source_id,
                    &src.title,
                    &records,
                    IngestionStage::Stage6HealSweep.as_str(),
                )?;
                healed += 1;
                details.push(format!(
                    "healed source '{}' with {} copied-text fallback chunk(s)",
                    src.source_id,
                    records.len()
                ));
            } else {
                quarantined += 1;
                details.push(format!(
                    "quarantined source '{}' (0 chunks and no recoverable fallback text)",
                    src.source_id
                ));
            }
        }

        Ok(HealSweepReport {
            notebook_id: notebook_id.to_string(),
            inspected: sources.len(),
            already_healthy,
            healed,
            quarantined,
            details,
        })
    }
}

fn build_chunk_records(
    notebook_id: &str,
    source_id: &str,
    slices: Vec<(String, String)>,
) -> Vec<SourceChunkRecord> {
    slices
        .into_iter()
        .enumerate()
        .map(|(idx, (heading, body))| {
            let clean_body = SecretRedactor::redact(&body);
            let clean_heading = SecretRedactor::redact(&heading);
            let token_count = clean_body.split_whitespace().count();
            let byte_size = clean_body.len();
            let content_blake3 = blake3::hash(clean_body.as_bytes()).to_hex().to_string();
            SourceChunkRecord {
                chunk_id: format!("{source_id}:c{idx}"),
                notebook_id: notebook_id.to_string(),
                source_id: source_id.to_string(),
                chunk_idx: idx,
                heading: clean_heading,
                body: clean_body,
                token_count,
                byte_size,
                content_blake3,
            }
        })
        .collect()
}

/// Safe ZIP entry descriptor collected after enforcing zip-bomb, entry-count, depth, and zip-slip guards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SafeZipEntry {
    pub path: String,
    pub compressed_bytes: u64,
    pub uncompressed_bytes: u64,
    pub is_dir: bool,
}

/// Shared cumulative decompression budget enforced across all entries AND nested recursion levels.
#[derive(Debug, Clone)]
struct ArchiveBudget {
    root_compressed_bytes: u64,
    total_actual_uncompressed: u64,
    total_entries: usize,
}

impl ArchiveBudget {
    fn new(root_compressed_bytes: u64) -> Self {
        Self {
            root_compressed_bytes,
            total_actual_uncompressed: 0,
            total_entries: 0,
        }
    }

    fn remaining_uncompressed(&self) -> u64 {
        MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES.saturating_sub(self.total_actual_uncompressed)
    }

    fn charge_entries(&mut self, added: usize, depth: usize, context: &str) -> Result<(), NotebookError> {
        self.total_entries = self.total_entries.saturating_add(added);
        validate_archive_limits(
            self.total_entries,
            self.root_compressed_bytes,
            self.total_actual_uncompressed,
            depth,
            context,
        )
    }

    fn charge_bytes(
        &mut self,
        added: u64,
        local_actual_uncompressed: u64,
        local_compressed_bytes: u64,
        depth: usize,
        context: &str,
    ) -> Result<(), NotebookError> {
        self.total_actual_uncompressed = self.total_actual_uncompressed.saturating_add(added);
        // Enforce cumulative global budget across ALL entries & recursion levels against outer root.
        validate_archive_limits(
            self.total_entries,
            self.root_compressed_bytes,
            self.total_actual_uncompressed,
            depth,
            context,
        )?;
        // Enforce local archive expansion ratio against this archive's compressed size.
        validate_archive_limits(
            self.total_entries,
            local_compressed_bytes,
            local_actual_uncompressed,
            depth,
            context,
        )
    }
}

/// Inspect a ZIP/OOXML/JAR archive safely without extracting to disk, enforcing cumulative
/// actual-byte budgets across ALL entries and nested recursion depths (`<= 5`), entry count
/// (`<= 1000`), total decompressed cap (`<= 128 MiB`), expansion ratio (`<= 100x`), and zip-slip.
pub fn inspect_zip_archive_safe(
    bytes: &[u8],
    depth: usize,
    context: &str,
) -> Result<Vec<SafeZipEntry>, NotebookError> {
    let mut budget = ArchiveBudget::new(bytes.len() as u64);
    let mut entries = Vec::new();
    let collect_none = |_: &str| false;
    walk_zip_with_budget(
        bytes,
        depth,
        context,
        &mut budget,
        &collect_none,
        &mut entries,
        None,
    )?;
    Ok(entries)
}

fn is_zip_family_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".zip")
        || lower.ends_with(".jar")
        || lower.ends_with(".docx")
        || lower.ends_with(".xlsx")
        || lower.ends_with(".pptx")
        || lower.ends_with(".epub")
        || lower.ends_with(".odt")
}

/// Single-pass bounded reader for selected ZIP/OOXML entry payloads while enforcing cumulative
/// actual decompression budgets across all entries and nested archives (zero double-decompression).
pub fn read_zip_entries_bounded(
    bytes: &[u8],
    depth: usize,
    context: &str,
    predicate: impl Fn(&str) -> bool,
) -> Result<BTreeMap<String, Vec<u8>>, NotebookError> {
    let mut budget = ArchiveBudget::new(bytes.len() as u64);
    let mut entries = Vec::new();
    let mut payloads = BTreeMap::new();
    walk_zip_with_budget(
        bytes,
        depth,
        context,
        &mut budget,
        &predicate,
        &mut entries,
        Some(&mut payloads),
    )?;
    Ok(payloads)
}

fn walk_zip_with_budget(
    bytes: &[u8],
    depth: usize,
    context: &str,
    budget: &mut ArchiveBudget,
    predicate: &dyn Fn(&str) -> bool,
    top_entries: &mut Vec<SafeZipEntry>,
    mut collected_payloads: Option<&mut BTreeMap<String, Vec<u8>>>,
) -> Result<(), NotebookError> {
    if depth > MAX_ARCHIVE_DEPTH {
        return Err(NotebookError::SecurityRejected {
            code: "ARCHIVE_DEPTH_EXCEEDED",
            reason: format!(
                "archive '{context}' nesting depth {depth} exceeds maximum {MAX_ARCHIVE_DEPTH}"
            ),
        });
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|e| {
        NotebookError::InvalidInput(format!("invalid ZIP container '{context}': {e}"))
    })?;
    let count = archive.len();
    let local_compressed = bytes.len() as u64;
    budget.charge_entries(count, depth, context)?;

    // Also validate header-declared total upfront before decompressing any entry.
    let mut declared_sum: u64 = 0;
    for idx in 0..count {
        let file = archive.by_index(idx).map_err(|e| {
            NotebookError::InvalidInput(format!("failed reading ZIP entry {idx} in '{context}': {e}"))
        })?;
        let _ = validate_archive_entry_path(file.name())?;
        declared_sum = declared_sum.saturating_add(file.size());
        validate_archive_limits(
            budget.total_entries,
            budget.root_compressed_bytes,
            budget.total_actual_uncompressed.saturating_add(declared_sum),
            depth,
            context,
        )?;
    }

    let mut scratch = [0u8; 8_192];
    let mut local_actual_uncompressed: u64 = 0;
    for idx in 0..count {
        let mut file = archive.by_index(idx).map_err(|e| {
            NotebookError::InvalidInput(format!("failed opening ZIP entry {idx} in '{context}': {e}"))
        })?;
        let safe_path = validate_archive_entry_path(file.name())?;
        let is_dir = file.is_dir();
        let compressed = file.compressed_size();

        if is_dir {
            if depth == 0 {
                top_entries.push(SafeZipEntry {
                    path: safe_path,
                    compressed_bytes: compressed,
                    uncompressed_bytes: 0,
                    is_dir: true,
                });
            }
            continue;
        }

        let is_nested_zip = is_zip_family_path(&safe_path);
        if is_nested_zip && depth + 1 > MAX_ARCHIVE_DEPTH {
            return Err(NotebookError::SecurityRejected {
                code: "ARCHIVE_DEPTH_EXCEEDED",
                reason: format!(
                    "nested archive '{safe_path}' inside '{context}' exceeds maximum nesting depth {MAX_ARCHIVE_DEPTH}"
                ),
            });
        }

        let need_buffer = is_nested_zip || (collected_payloads.is_some() && predicate(&safe_path));
        let mut buf: Vec<u8> = Vec::new();
        let mut entry_actual_bytes: u64 = 0;

        // Stream actual decompressed bytes in bounded 8 KiB chunks so lying `size == 0` zip bombs
        // fail immediately upon breaching the cumulative ratio or 128 MiB cap.
        loop {
            let max_chunk = (budget.remaining_uncompressed().saturating_add(1) as usize).min(scratch.len());
            let read_n = file.read(&mut scratch[..max_chunk]).map_err(|e| {
                NotebookError::InvalidInput(format!(
                    "failed decompressing ZIP entry '{safe_path}' in '{context}': {e}"
                ))
            })?;
            if read_n == 0 {
                break;
            }
            entry_actual_bytes = entry_actual_bytes.saturating_add(read_n as u64);
            local_actual_uncompressed = local_actual_uncompressed.saturating_add(read_n as u64);
            budget.charge_bytes(
                read_n as u64,
                local_actual_uncompressed,
                local_compressed,
                depth,
                context,
            )?;
            if need_buffer {
                buf.extend_from_slice(&scratch[..read_n]);
            }
        }
        drop(file);

        if depth == 0 {
            top_entries.push(SafeZipEntry {
                path: safe_path.clone(),
                compressed_bytes: compressed,
                uncompressed_bytes: entry_actual_bytes,
                is_dir: false,
            });
        }

        if is_nested_zip && buf.starts_with(b"PK\x03\x04") {
            let mut nested_entries = Vec::new();
            let collect_none = |_: &str| false;
            walk_zip_with_budget(
                &buf,
                depth + 1,
                &safe_path,
                budget,
                &collect_none,
                &mut nested_entries,
                None,
            )?;
        }

        if let Some(ref mut map) = collected_payloads {
            if predicate(&safe_path) {
                map.insert(safe_path, buf);
            }
        }
    }

    Ok(())
}

/// Pure-Rust OOXML DOCX extractor (`word/document.xml` paragraphs + Markdown tables),
/// strictly enforcing XXE rejection (`<!DOCTYPE`/`<!ENTITY`) and zip-bomb bounds.
pub fn extract_docx_markdown(bytes: &[u8], depth: usize) -> Result<String, NotebookError> {
    let files = read_zip_entries_bounded(bytes, depth, "docx", |p| {
        p == "word/document.xml" || p.starts_with("word/header") || p.starts_with("word/footer")
    })?;
    let Some(doc_xml) = files.get("word/document.xml") else {
        return Err(NotebookError::InvalidInput(
            "DOCX archive missing required 'word/document.xml'".to_string(),
        ));
    };
    validate_xml_safety(doc_xml, "word/document.xml")?;

    let mut reader = Reader::from_reader(doc_xml.as_slice());
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();
    let mut blocks: Vec<String> = Vec::new();
    let mut current_para = String::new();
    let mut in_table = false;
    let mut table_rows: Vec<Vec<String>> = Vec::new();
    let mut current_row: Vec<String> = Vec::new();
    let mut current_cell = String::new();
    let mut in_text = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let qname = e.name();
                let local = local_xml_name(qname.as_ref());
                match local {
                    "tbl" => {
                        in_table = true;
                        table_rows.clear();
                    }
                    "tr" if in_table => current_row.clear(),
                    "tc" if in_table => current_cell.clear(),
                    "p" => current_para.clear(),
                    "t" => in_text = true,
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let qname = e.name();
                let local = local_xml_name(qname.as_ref());
                match local {
                    "tab" => {
                        if in_table {
                            current_cell.push('\t');
                        } else {
                            current_para.push('\t');
                        }
                    }
                    "br" | "cr" => {
                        if in_table {
                            current_cell.push(' ');
                        } else {
                            current_para.push('\n');
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) if in_text => {
                let txt = e
                    .unescape()
                    .map_err(|err| NotebookError::InvalidInput(format!("DOCX XML text error: {err}")))?;
                if in_table {
                    current_cell.push_str(&txt);
                } else {
                    current_para.push_str(&txt);
                }
            }
            Ok(Event::End(e)) => {
                let qname = e.name();
                let local = local_xml_name(qname.as_ref());
                match local {
                    "t" => in_text = false,
                    "p" => {
                        if in_table {
                            if !current_cell.is_empty() && !current_cell.ends_with(' ') {
                                current_cell.push(' ');
                            }
                        } else {
                            let trimmed = current_para.trim();
                            if !trimmed.is_empty() {
                                blocks.push(trimmed.to_string());
                            }
                            current_para.clear();
                        }
                    }
                    "tc" if in_table => {
                        current_row.push(current_cell.trim().to_string());
                        current_cell.clear();
                    }
                    "tr" if in_table => {
                        if !current_row.is_empty() {
                            table_rows.push(std::mem::take(&mut current_row));
                        }
                    }
                    "tbl" if in_table => {
                        in_table = false;
                        if !table_rows.is_empty() {
                            let headers = table_rows[0].clone();
                            let body = table_rows[1..].to_vec();
                            let sheet = ExtractedSheet {
                                name: String::new(),
                                headers,
                                rows: body,
                            };
                            blocks.push(render_single_sheet_markdown(&sheet, false));
                        }
                        table_rows.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(NotebookError::InvalidInput(format!(
                    "malformed DOCX XML: {e}"
                )));
            }
            _ => {}
        }
        buf.clear();
    }

    Ok(blocks.join("\n\n"))
}

/// Pure-Rust OOXML XLSX extractor (`xl/sharedStrings.xml`, `xl/workbook.xml`, `xl/worksheets/sheet*.xml`).
pub fn extract_xlsx_sheets(bytes: &[u8], depth: usize) -> Result<Vec<ExtractedSheet>, NotebookError> {
    let files = read_zip_entries_bounded(bytes, depth, "xlsx", |p| {
        p == "xl/sharedStrings.xml"
            || p == "xl/workbook.xml"
            || (p.starts_with("xl/worksheets/sheet") && p.ends_with(".xml"))
    })?;

    for (name, xml) in &files {
        validate_xml_safety(xml, name)?;
    }

    let shared_strings = match files.get("xl/sharedStrings.xml") {
        Some(xml) => parse_xlsx_shared_strings(xml)?,
        None => Vec::new(),
    };
    let sheet_names = match files.get("xl/workbook.xml") {
        Some(xml) => parse_xlsx_sheet_names(xml)?,
        None => Vec::new(),
    };

    let mut sheet_entries: Vec<(usize, &String, &Vec<u8>)> = files
        .iter()
        .filter(|(k, _)| k.starts_with("xl/worksheets/sheet") && k.ends_with(".xml"))
        .map(|(k, v)| (extract_trailing_number(k).unwrap_or(usize::MAX), k, v))
        .collect();
    sheet_entries.sort_by_key(|(n, k, _)| (*n, (*k).clone()));

    if sheet_entries.is_empty() {
        return Err(NotebookError::InvalidInput(
            "XLSX archive contains no worksheet XML entries".to_string(),
        ));
    }

    let mut sheets = Vec::with_capacity(sheet_entries.len());
    for (idx, (_, path, xml)) in sheet_entries.into_iter().enumerate() {
        let name = sheet_names
            .get(idx)
            .cloned()
            .unwrap_or_else(|| format!("Sheet{}", idx + 1));
        let all_rows = parse_xlsx_worksheet(xml, &shared_strings, path)?;
        let (headers, rows) = if all_rows.is_empty() {
            (Vec::new(), Vec::new())
        } else {
            (all_rows[0].clone(), all_rows[1..].to_vec())
        };
        sheets.push(ExtractedSheet {
            name,
            headers,
            rows,
        });
    }
    Ok(sheets)
}

fn parse_xlsx_shared_strings(xml: &[u8]) -> Result<Vec<String>, NotebookError> {
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut strings = Vec::new();
    let mut in_si = false;
    let mut in_t = false;
    let mut cur = String::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => match local_xml_name(e.name().as_ref()) {
                "si" => {
                    in_si = true;
                    cur.clear();
                }
                "t" if in_si => in_t = true,
                _ => {}
            },
            Ok(Event::Text(e)) if in_si && in_t => {
                let txt = e.unescape().map_err(|err| {
                    NotebookError::InvalidInput(format!("XLSX sharedStrings error: {err}"))
                })?;
                cur.push_str(&txt);
            }
            Ok(Event::End(e)) => match local_xml_name(e.name().as_ref()) {
                "t" => in_t = false,
                "si" => {
                    in_si = false;
                    strings.push(std::mem::take(&mut cur));
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(NotebookError::InvalidInput(format!(
                    "malformed XLSX sharedStrings XML: {e}"
                )));
            }
            _ => {}
        }
        buf.clear();
    }
    Ok(strings)
}

fn parse_xlsx_sheet_names(xml: &[u8]) -> Result<Vec<String>, NotebookError> {
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut names = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                if local_xml_name(e.name().as_ref()) == "sheet" {
                    for attr in e.attributes().flatten() {
                        if local_xml_name(attr.key.as_ref()) == "name" {
                            if let Ok(val) = attr.unescape_value() {
                                names.push(val.into_owned());
                            }
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(NotebookError::InvalidInput(format!(
                    "malformed XLSX workbook XML: {e}"
                )));
            }
            _ => {}
        }
        buf.clear();
    }
    Ok(names)
}

fn parse_xlsx_worksheet(
    xml: &[u8],
    shared_strings: &[String],
    path: &str,
) -> Result<Vec<Vec<String>>, NotebookError> {
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut cur_row: Vec<String> = Vec::new();
    let mut cell_type = String::new();
    let mut in_val = false;
    let mut in_inline_t = false;
    let mut cur_val = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => match local_xml_name(e.name().as_ref()) {
                "row" => cur_row.clear(),
                "c" => {
                    cell_type.clear();
                    cur_val.clear();
                    for attr in e.attributes().flatten() {
                        if local_xml_name(attr.key.as_ref()) == "t" {
                            if let Ok(v) = attr.unescape_value() {
                                cell_type = v.into_owned();
                            }
                        }
                    }
                }
                "v" => in_val = true,
                "t" => in_inline_t = true,
                _ => {}
            },
            Ok(Event::Text(e)) if in_val || in_inline_t => {
                let txt = e.unescape().map_err(|err| {
                    NotebookError::InvalidInput(format!("XLSX cell text error in {path}: {err}"))
                })?;
                cur_val.push_str(&txt);
            }
            Ok(Event::End(e)) => match local_xml_name(e.name().as_ref()) {
                "v" => in_val = false,
                "t" => in_inline_t = false,
                "c" => {
                    let resolved = if cell_type == "s" {
                        cur_val
                            .trim()
                            .parse::<usize>()
                            .ok()
                            .and_then(|idx| shared_strings.get(idx).cloned())
                            .unwrap_or_else(|| cur_val.clone())
                    } else {
                        cur_val.clone()
                    };
                    cur_row.push(resolved.trim().to_string());
                    cur_val.clear();
                }
                "row" => {
                    if cur_row.iter().any(|c| !c.is_empty()) {
                        rows.push(std::mem::take(&mut cur_row));
                    } else {
                        cur_row.clear();
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(NotebookError::InvalidInput(format!(
                    "malformed XLSX worksheet '{path}': {e}"
                )));
            }
            _ => {}
        }
        buf.clear();
    }
    Ok(rows)
}

/// Pure-Rust OOXML PPTX extractor (`ppt/slides/slide*.xml` sorted numerically).
pub fn extract_pptx_slides(bytes: &[u8], depth: usize) -> Result<Vec<ExtractedSlide>, NotebookError> {
    let files = read_zip_entries_bounded(bytes, depth, "pptx", |p| {
        p.starts_with("ppt/slides/slide") && p.ends_with(".xml")
    })?;

    let mut slide_entries: Vec<(usize, &String, &Vec<u8>)> = files
        .iter()
        .map(|(k, v)| (extract_trailing_number(k).unwrap_or(usize::MAX), k, v))
        .collect();
    slide_entries.sort_by_key(|(n, k, _)| (*n, (*k).clone()));

    if slide_entries.is_empty() {
        return Err(NotebookError::InvalidInput(
            "PPTX archive contains no slide XML entries".to_string(),
        ));
    }

    let mut slides = Vec::with_capacity(slide_entries.len());
    for (idx, (num, path, xml)) in slide_entries.into_iter().enumerate() {
        validate_xml_safety(xml, path)?;
        let mut reader = Reader::from_reader(xml.as_slice());
        let mut buf = Vec::new();
        let mut lines = Vec::new();
        let mut cur_para = String::new();
        let mut in_t = false;
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) => match local_xml_name(e.name().as_ref()) {
                    "p" => cur_para.clear(),
                    "t" => in_t = true,
                    _ => {}
                },
                Ok(Event::Text(e)) if in_t => {
                    let txt = e.unescape().map_err(|err| {
                        NotebookError::InvalidInput(format!("PPTX slide text error: {err}"))
                    })?;
                    cur_para.push_str(&txt);
                }
                Ok(Event::End(e)) => match local_xml_name(e.name().as_ref()) {
                    "t" => in_t = false,
                    "p" => {
                        let trimmed = cur_para.trim();
                        if !trimmed.is_empty() {
                            lines.push(trimmed.to_string());
                        }
                        cur_para.clear();
                    }
                    _ => {}
                },
                Ok(Event::Eof) => break,
                Err(e) => {
                    return Err(NotebookError::InvalidInput(format!(
                        "malformed PPTX slide XML '{path}': {e}"
                    )));
                }
                _ => {}
            }
            buf.clear();
        }
        let slide_number = if num == usize::MAX { idx + 1 } else { num };
        let title = lines
            .first()
            .cloned()
            .unwrap_or_else(|| format!("Slide {slide_number}"));
        slides.push(ExtractedSlide {
            slide_number,
            title,
            lines,
        });
    }
    Ok(slides)
}

/// Pure-Rust EPUB safe ZIP+XHTML extractor (XXE + zip-bomb enforced).
pub fn extract_epub_markdown(bytes: &[u8], depth: usize) -> Result<String, NotebookError> {
    let files = read_zip_entries_bounded(bytes, depth, "epub", |p| {
        let low = p.to_ascii_lowercase();
        low.ends_with(".xhtml") || low.ends_with(".html") || low.ends_with(".htm") || low.ends_with(".opf")
    })?;
    let mut sections = Vec::new();
    for (path, data) in &files {
        validate_xml_safety(data, path)?;
        let low = path.to_ascii_lowercase();
        if low.ends_with(".xhtml") || low.ends_with(".html") || low.ends_with(".htm") {
            let text = clean_html_to_text(&normalize_utf8_and_lf(data));
            if !text.trim().is_empty() {
                sections.push(format!("## {path}\n\n{text}"));
            }
        }
    }
    Ok(sections.join("\n\n"))
}

/// Pure-Rust ODT (`content.xml`) safe ZIP+XML extractor (XXE + zip-bomb enforced).
pub fn extract_odt_markdown(bytes: &[u8], depth: usize) -> Result<String, NotebookError> {
    let files = read_zip_entries_bounded(bytes, depth, "odt", |p| p == "content.xml")?;
    let Some(xml) = files.get("content.xml") else {
        return Err(NotebookError::InvalidInput(
            "ODT archive missing required 'content.xml'".to_string(),
        ));
    };
    validate_xml_safety(xml, "content.xml")?;
    extract_xml_text(xml, "content.xml")
}

/// Strip RTF control words/groups into readable plain text.
#[must_use]
pub fn strip_rtf_to_text(rtf: &str) -> String {
    let bytes = rtf.as_bytes();
    let mut out = String::with_capacity(rtf.len());
    let mut i = 0;
    let mut skip_depth = 0usize;
    let mut depth = 0usize;

    while i < bytes.len() {
        match bytes[i] {
            b'{' => {
                depth += 1;
                // Skip non-body header groups (`{\fonttbl`, `{\colortbl`, `{\stylesheet`, `{\*`).
                let rest = &rtf[i + 1..];
                if skip_depth == 0
                    && (rest.starts_with(r"\*")
                        || rest.starts_with(r"\fonttbl")
                        || rest.starts_with(r"\colortbl")
                        || rest.starts_with(r"\stylesheet")
                        || rest.starts_with(r"\info"))
                {
                    skip_depth = depth;
                }
                i += 1;
            }
            b'}' => {
                if skip_depth == depth {
                    skip_depth = 0;
                }
                depth = depth.saturating_sub(1);
                i += 1;
            }
            b'\\' if i + 1 < bytes.len() => {
                i += 1;
                let next = bytes[i];
                if next == b'\\' || next == b'{' || next == b'}' {
                    if skip_depth == 0 {
                        out.push(next as char);
                    }
                    i += 1;
                } else if next == b'\''
                    && i + 2 < bytes.len()
                    && bytes[i + 1].is_ascii_hexdigit()
                    && bytes[i + 2].is_ascii_hexdigit()
                {
                    // Both nibbles are ASCII, so `i + 3` is guaranteed to be a char boundary.
                    let hi = (bytes[i + 1] as char).to_digit(16).unwrap_or(0);
                    let lo = (bytes[i + 2] as char).to_digit(16).unwrap_or(0);
                    if skip_depth == 0 {
                        out.push(char::from((hi * 16 + lo) as u8));
                    }
                    i += 3;
                } else if next == b'\'' {
                    // Malformed `\'` escape (non-hex or truncated): drop the apostrophe only and let
                    // the main loop re-read whatever follows from a valid char boundary.
                    i += 1;
                } else {
                    let start = i;
                    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
                        i += 1;
                    }
                    let word = &rtf[start..i];
                    // Optional signed numeric parameter.
                    if i < bytes.len() && (bytes[i] == b'-' || bytes[i].is_ascii_digit()) {
                        if bytes[i] == b'-' {
                            i += 1;
                        }
                        while i < bytes.len() && bytes[i].is_ascii_digit() {
                            i += 1;
                        }
                    }
                    if i < bytes.len() && bytes[i] == b' ' {
                        i += 1;
                    }
                    if skip_depth == 0 {
                        match word {
                            "par" | "line" => out.push('\n'),
                            "tab" => out.push('\t'),
                            _ => {}
                        }
                    }
                }
            }
            b'\r' | b'\n' => i += 1,
            _ => {
                let ch = rtf.get(i..).and_then(|s| s.chars().next()).unwrap_or(' ');
                if skip_depth == 0 {
                    out.push(ch);
                }
                i += ch.len_utf8();
            }
        }
    }
    collapse_blank_lines(&out)
}

/// Pure-Rust PDF text-stream/literal extractor + encrypted-PDF classifier.
#[must_use]
pub fn inspect_and_extract_pdf(bytes: &[u8]) -> PdfExtractionResult {
    if bytes.len() < 8 || !bytes.starts_with(b"%PDF-") {
        return PdfExtractionResult {
            classification: PdfClassification::Malformed,
            pdf_version: None,
            estimated_pages: 0,
            is_encrypted: false,
            extracted_text: String::new(),
            warnings: vec!["missing %PDF- signature".to_string()],
        };
    }

    let version_line = bytes
        .iter()
        .take(24)
        .copied()
        .take_while(|b| *b != b'\r' && *b != b'\n')
        .collect::<Vec<_>>();
    let pdf_version = String::from_utf8_lossy(&version_line)
        .strip_prefix("%PDF-")
        .map(str::trim)
        .map(str::to_string);

    let latin1: String = bytes.iter().map(|b| *b as char).collect();

    // Detect encrypted PDF dictionary markers.
    let is_encrypted = contains_pdf_encrypt_marker(&latin1);
    let estimated_pages = count_pdf_pages(&latin1);

    if is_encrypted {
        return PdfExtractionResult {
            classification: PdfClassification::Encrypted,
            pdf_version,
            estimated_pages,
            is_encrypted: true,
            extracted_text: String::new(),
            warnings: vec![
                "PDF declares /Encrypt dictionary; encrypted PDFs are classified and never brute-forced"
                    .to_string(),
            ],
        };
    }

    let mut extracted_segments = Vec::new();
    let mut warnings = Vec::new();

    // Extract text from every `stream ... endstream` block (supporting both raw and FlateDecode).
    // All offsets are computed on raw bytes (never on a re-encoded string) so binary stream
    // payloads with high bytes can never desynchronize indices or panic on slicing.
    const MAX_PDF_STREAM_BYTES: u64 = 16 * 1024 * 1024;
    const MAX_PDF_TOTAL_DECODED_BYTES: usize = 64 * 1024 * 1024;
    let mut total_decoded = 0usize;
    let mut search_pos = 0usize;
    while let Some(stream_kw) = find_bytes(bytes, b"stream", search_pos) {
        // Look back up to 256 bytes for dictionary header (`/FlateDecode`).
        let dict_start = stream_kw.saturating_sub(256);
        let is_flate = find_bytes(&bytes[dict_start..stream_kw], b"/FlateDecode", 0).is_some();

        let mut data_start = stream_kw + b"stream".len();
        if data_start < bytes.len() && bytes[data_start] == b'\r' {
            data_start += 1;
        }
        if data_start < bytes.len() && bytes[data_start] == b'\n' {
            data_start += 1;
        }
        let Some(data_end) = find_bytes(bytes, b"endstream", data_start) else {
            break;
        };
        let raw_stream = &bytes[data_start..data_end];
        search_pos = data_end + b"endstream".len();

        let decoded: Vec<u8> = if is_flate {
            let decoder = ZlibDecoder::new(raw_stream);
            let mut out = Vec::new();
            match decoder.take(MAX_PDF_STREAM_BYTES).read_to_end(&mut out) {
                Ok(_) if !out.is_empty() => out,
                _ => {
                    warnings.push("skipped undecodable FlateDecode PDF stream".to_string());
                    continue;
                }
            }
        } else {
            raw_stream.to_vec()
        };

        total_decoded = total_decoded.saturating_add(decoded.len());
        if total_decoded > MAX_PDF_TOTAL_DECODED_BYTES {
            warnings.push(
                "PDF decoded stream budget (64 MiB) exhausted; remaining streams skipped"
                    .to_string(),
            );
            break;
        }

        let stream_text = extract_pdf_text_operators(&decoded);
        if !stream_text.trim().is_empty() {
            extracted_segments.push(stream_text);
        }
    }

    // Fallback: scan directly if a synthetic PDF put `BT ... ET` outside `stream`.
    if extracted_segments.is_empty() {
        let direct = extract_pdf_text_operators(bytes);
        if !direct.trim().is_empty() {
            extracted_segments.push(direct);
        }
    }

    let extracted_text = collapse_blank_lines(&extracted_segments.join("\n"));
    let classification = if extracted_text.trim().is_empty() {
        PdfClassification::ScannedOrNoText
    } else {
        PdfClassification::ReadableText
    };

    PdfExtractionResult {
        classification,
        pdf_version,
        estimated_pages: estimated_pages.max(usize::from(!extracted_text.is_empty())),
        is_encrypted: false,
        extracted_text,
        warnings,
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= haystack.len() || haystack.len() - from < needle.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|rel| from + rel)
}

fn contains_pdf_encrypt_marker(latin1: &str) -> bool {
    // Check `/Encrypt ` or `/Encrypt<<` or `/Encrypt\n` in trailer/objects or `/Filter /Standard`.
    for marker in ["/Encrypt ", "/Encrypt<<", "/Encrypt\r", "/Encrypt\n", "/Filter /Standard", "/Filter/Standard"] {
        if latin1.contains(marker) {
            return true;
        }
    }
    false
}

fn count_pdf_pages(latin1: &str) -> usize {
    let mut count = 0usize;
    let bytes = latin1.as_bytes();
    let mut i = 0;
    while let Some(rel) = latin1[i..].find("/Type") {
        let pos = i + rel + 5;
        let rest = latin1[pos..].trim_start();
        if let Some(after) = rest.strip_prefix("/Page") {
            let next_byte = after.as_bytes().first().copied().unwrap_or(b' ');
            if !next_byte.is_ascii_alphabetic() {
                count += 1;
            }
        }
        i = pos.min(bytes.len());
    }
    count
}

fn extract_pdf_text_operators(stream: &[u8]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut current_line = String::new();
    let mut i = 0usize;
    let len = stream.len();

    while i < len {
        match stream[i] {
            b'(' => {
                let (decoded, next_i) = parse_pdf_literal_string(stream, i);
                i = next_i;
                // Check if followed by Tj / ' / " operator (ignoring whitespace).
                let look = skip_pdf_ws(stream, i);
                if matches_pdf_op(stream, look, b"Tj")
                    || matches_pdf_op(stream, look, b"'")
                    || matches_pdf_op(stream, look, b"\"")
                {
                    if !decoded.is_empty() {
                        current_line.push_str(&decoded);
                    }
                    if matches_pdf_op(stream, look, b"'") || matches_pdf_op(stream, look, b"\"") {
                        flush_pdf_line(&mut current_line, &mut lines);
                    }
                }
            }
            b'<' if i + 1 < len && stream[i + 1] != b'<' => {
                let (decoded, next_i) = parse_pdf_hex_string(stream, i);
                i = next_i;
                let look = skip_pdf_ws(stream, i);
                if matches_pdf_op(stream, look, b"Tj") {
                    current_line.push_str(&decoded);
                }
            }
            b'[' => {
                // TJ array: `[(Hello) -40 (World)] TJ`
                let (arr_text, next_i) = parse_pdf_tj_array(stream, i);
                let look = skip_pdf_ws(stream, next_i);
                if matches_pdf_op(stream, look, b"TJ") {
                    current_line.push_str(&arr_text);
                    i = look + 2;
                } else {
                    i += 1;
                }
            }
            b'T' if i + 1 < len && matches!(stream[i + 1], b'*' | b'd' | b'D') => {
                flush_pdf_line(&mut current_line, &mut lines);
                i += 2;
            }
            b'E' if i + 1 < len && stream[i + 1] == b'T' => {
                flush_pdf_line(&mut current_line, &mut lines);
                i += 2;
            }
            _ => i += 1,
        }
    }
    flush_pdf_line(&mut current_line, &mut lines);
    lines.join("\n")
}

fn flush_pdf_line(current_line: &mut String, lines: &mut Vec<String>) {
    let trimmed = current_line.trim();
    if !trimmed.is_empty() {
        lines.push(trimmed.to_string());
    }
    current_line.clear();
}

fn skip_pdf_ws(data: &[u8], mut idx: usize) -> usize {
    while idx < data.len() && data[idx].is_ascii_whitespace() {
        idx += 1;
    }
    idx
}

fn matches_pdf_op(data: &[u8], idx: usize, op: &[u8]) -> bool {
    if idx + op.len() > data.len() || &data[idx..idx + op.len()] != op {
        return false;
    }
    let after = idx + op.len();
    after == data.len() || !data[after].is_ascii_alphanumeric()
}

fn parse_pdf_literal_string(data: &[u8], start: usize) -> (String, usize) {
    let mut i = start + 1;
    let mut depth = 1usize;
    let mut raw = Vec::new();
    while i < data.len() && depth > 0 {
        let b = data[i];
        if b == b'\\' && i + 1 < data.len() {
            i += 1;
            match data[i] {
                b'n' => raw.push(b'\n'),
                b'r' => raw.push(b'\r'),
                b't' => raw.push(b'\t'),
                b'b' => raw.push(0x08),
                b'f' => raw.push(0x0C),
                b'(' | b')' | b'\\' => raw.push(data[i]),
                b'\r' => {
                    if i + 1 < data.len() && data[i + 1] == b'\n' {
                        i += 1;
                    }
                }
                b'\n' => {}
                d if (b'0'..=b'7').contains(&d) => {
                    let mut val = u32::from(d - b'0');
                    for _ in 0..2 {
                        if i + 1 < data.len() && (b'0'..=b'7').contains(&data[i + 1]) {
                            i += 1;
                            val = val * 8 + u32::from(data[i] - b'0');
                        } else {
                            break;
                        }
                    }
                    raw.push((val & 0xFF) as u8);
                }
                other => raw.push(other),
            }
            i += 1;
        } else if b == b'(' {
            depth += 1;
            raw.push(b);
            i += 1;
        } else if b == b')' {
            depth -= 1;
            if depth > 0 {
                raw.push(b);
            }
            i += 1;
        } else {
            raw.push(b);
            i += 1;
        }
    }
    (String::from_utf8_lossy(&raw).into_owned(), i)
}

fn parse_pdf_hex_string(data: &[u8], start: usize) -> (String, usize) {
    let mut i = start + 1;
    let mut hex_chars = Vec::new();
    while i < data.len() && data[i] != b'>' {
        if data[i].is_ascii_hexdigit() {
            hex_chars.push(data[i]);
        }
        i += 1;
    }
    if i < data.len() && data[i] == b'>' {
        i += 1;
    }
    if hex_chars.len() % 2 == 1 {
        hex_chars.push(b'0');
    }
    let mut bytes = Vec::with_capacity(hex_chars.len() / 2);
    for pair in hex_chars.as_chunks::<2>().0 {
        if let Ok(s) = std::str::from_utf8(pair) {
            if let Ok(val) = u8::from_str_radix(s, 16) {
                bytes.push(val);
            }
        }
    }
    // Support UTF-16BE BOM inside PDF hex strings.
    if bytes.starts_with(&[0xFE, 0xFF]) && bytes.len() >= 4 {
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_be_bytes(*c))
            .collect();
        return (String::from_utf16_lossy(&units), i);
    }
    (String::from_utf8_lossy(&bytes).into_owned(), i)
}

fn parse_pdf_tj_array(data: &[u8], start: usize) -> (String, usize) {
    let mut i = start + 1;
    let mut out = String::new();
    while i < data.len() && data[i] != b']' {
        match data[i] {
            b'(' => {
                let (s, next_i) = parse_pdf_literal_string(data, i);
                out.push_str(&s);
                i = next_i;
            }
            b'<' if i + 1 < data.len() && data[i + 1] != b'<' => {
                let (s, next_i) = parse_pdf_hex_string(data, i);
                out.push_str(&s);
                i = next_i;
            }
            b'-' | b'0'..=b'9' => {
                let num_start = i;
                i += 1;
                while i < data.len() && (data[i].is_ascii_digit() || data[i] == b'.') {
                    i += 1;
                }
                if let Ok(s) = std::str::from_utf8(&data[num_start..i]) {
                    if let Ok(kerning) = s.parse::<f64>() {
                        if kerning <= -120.0 && !out.ends_with(' ') {
                            out.push(' ');
                        }
                    }
                }
            }
            _ => i += 1,
        }
    }
    if i < data.len() && data[i] == b']' {
        i += 1;
    }
    (out, i)
}

/// Package a local code repository into deterministic fenced Markdown respecting `.gitignore`,
/// enforcing workspace-root containment (`config.allowed_workspace_roots`), walking all ancestors
/// for reparse points/symlinks, and skipping binary files and sensitive credential/key filenames.
pub fn package_code_repository(
    root_dir: &Path,
    config: &RepoPackageConfig,
) -> Result<PackagedRepository, NotebookError> {
    let canonical_root = validate_contained_repo_root(root_dir, &config.allowed_workspace_roots)?;
    let root_dir = canonical_root.as_path();

    let root_name = root_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("repository")
        .to_string();

    let mut builder = WalkBuilder::new(root_dir);
    builder
        .hidden(true)
        .follow_links(false)
        .git_ignore(config.respect_gitignore)
        .git_global(false)
        .git_exclude(config.respect_gitignore)
        .ignore(config.respect_gitignore)
        .require_git(false);

    let mut candidates: Vec<(String, std::path::PathBuf)> = Vec::new();
    let mut skipped_reparse_entries = Vec::new();

    for entry_res in builder.build() {
        let Ok(entry) = entry_res else {
            continue;
        };
        let path = entry.path();
        if path == root_dir {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(path) else {
            continue;
        };
        if is_reparse_point_metadata(&meta) {
            if let Ok(rel) = path.strip_prefix(root_dir) {
                skipped_reparse_entries.push(to_posix_path(rel));
            }
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let Ok(rel) = path.strip_prefix(root_dir) else {
            continue;
        };
        let rel_posix = to_posix_path(rel);
        if is_forbidden_repo_file(&rel_posix) {
            continue;
        }
        candidates.push((rel_posix, path.to_path_buf()));
    }

    // Strict deterministic POSIX lexicographical ordering.
    candidates.sort_by(|a, b| a.0.cmp(&b.0));

    let mut included_files = Vec::new();
    let mut skipped_binary_files = Vec::new();
    let mut skipped_oversize_files = Vec::new();
    let mut sections = Vec::new();
    let mut total_bytes = 0usize;

    for (rel_posix, abs_path) in candidates {
        if included_files.len() >= config.max_files || total_bytes >= config.max_total_bytes {
            break;
        }
        // Check on-disk size BEFORE reading so oversize files are never loaded into memory.
        let on_disk = fs::metadata(&abs_path).map(|m| m.len()).unwrap_or(u64::MAX);
        if on_disk > config.max_file_bytes as u64 {
            skipped_oversize_files.push(rel_posix);
            continue;
        }
        let Ok(raw) = fs::read(&abs_path) else {
            continue;
        };
        if raw.len() > config.max_file_bytes {
            skipped_oversize_files.push(rel_posix);
            continue;
        }
        if is_likely_binary(&raw) {
            skipped_binary_files.push(rel_posix);
            continue;
        }
        let text = SecretRedactor::redact(&normalize_utf8_and_lf(&raw));
        let lang = crate::preview::detect_code_language(&rel_posix).unwrap_or("text");
        total_bytes = total_bytes.saturating_add(text.len());
        included_files.push(rel_posix.clone());
        sections.push(format!("## {rel_posix}\n\n```{lang}\n{text}\n```"));
    }

    let mut md = format!("# Code Repository: {root_name}\n\n## Files ({})\n", included_files.len());
    for f in &included_files {
        md.push_str(&format!("- `{f}`\n"));
    }
    if !sections.is_empty() {
        md.push('\n');
        md.push_str(&sections.join("\n\n"));
    }

    Ok(PackagedRepository {
        root_name,
        included_files,
        skipped_binary_files,
        skipped_oversize_files,
        skipped_reparse_entries,
        markdown: md,
    })
}

fn validate_contained_repo_root(
    root_dir: &Path,
    allowed_roots: &[std::path::PathBuf],
) -> Result<std::path::PathBuf, NotebookError> {
    if allowed_roots.is_empty() {
        return Err(NotebookError::SecurityRejected {
            code: "WORKSPACE_ROOT_ALLOWLIST_REQUIRED",
            reason: "package_code_repository requires non-empty allowed_workspace_roots"
                .to_string(),
        });
    }
    reject_unsafe_win32_device_prefix(root_dir)?;
    if !root_dir.exists() || !root_dir.is_dir() {
        return Err(NotebookError::InvalidInput(format!(
            "repository root '{}' does not exist or is not a directory",
            root_dir.display()
        )));
    }
    check_all_ancestors_for_reparse_points(root_dir)?;

    let canonical_target = fs::canonicalize(root_dir).map_err(|e| {
        NotebookError::Io(format!("failed canonicalizing '{}': {e}", root_dir.display()))
    })?;

    let mut contained = false;
    for allowed in allowed_roots {
        reject_unsafe_win32_device_prefix(allowed)?;
        if !allowed.exists() || !allowed.is_dir() {
            continue;
        }
        check_all_ancestors_for_reparse_points(allowed)?;
        let canonical_allowed = fs::canonicalize(allowed).map_err(|e| {
            NotebookError::Io(format!(
                "failed canonicalizing allowed root '{}': {e}",
                allowed.display()
            ))
        })?;
        if canonical_target.starts_with(&canonical_allowed) {
            contained = true;
            break;
        }
    }

    if !contained {
        return Err(NotebookError::SecurityRejected {
            code: "REPO_OUTSIDE_ALLOWED_ROOT",
            reason: format!(
                "repository root '{}' is outside configured allowed_workspace_roots",
                root_dir.display()
            ),
        });
    }
    Ok(canonical_target)
}

fn reject_unsafe_win32_device_prefix(path: &Path) -> Result<(), NotebookError> {
    let raw = path.to_string_lossy();
    if raw.contains('\0') {
        return Err(NotebookError::SecurityRejected {
            code: "UNSAFE_LOCAL_PATH",
            reason: "NUL byte rejected in repository path".to_string(),
        });
    }
    if raw.starts_with(r"\\?\") || raw.starts_with("//?/") {
        let rest = &raw[4..];
        let b = rest.as_bytes();
        let valid_drive = b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && (b[2] == b'\\' || b[2] == b'/');
        if !valid_drive {
            return Err(NotebookError::SecurityRejected {
                code: "UNSAFE_LOCAL_PATH",
                reason: "verbatim NT device/UNC namespace rejected in repository path".to_string(),
            });
        }
        return Ok(());
    }
    if raw.starts_with(r"\\") || raw.starts_with("//") {
        return Err(NotebookError::SecurityRejected {
            code: "UNSAFE_LOCAL_PATH",
            reason: "UNC/SMB network path rejected in repository path".to_string(),
        });
    }
    Ok(())
}

fn check_all_ancestors_for_reparse_points(path: &Path) -> Result<(), NotebookError> {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| NotebookError::Io(format!("failed reading cwd: {e}")))?
            .join(path)
    };
    let mut cur: Option<&Path> = Some(abs.as_path());
    while let Some(ancestor) = cur {
        if ancestor.parent().is_none() {
            break;
        }
        if let Ok(meta) = fs::symlink_metadata(ancestor) {
            if is_reparse_point_metadata(&meta) {
                return Err(NotebookError::SecurityRejected {
                    code: "REPARSE_POINT_ANCESTOR",
                    reason: format!(
                        "reparse point / symlink ancestor rejected at '{}'",
                        ancestor.display()
                    ),
                });
            }
        }
        cur = ancestor.parent();
    }
    Ok(())
}

fn is_forbidden_repo_file(rel_posix: &str) -> bool {
    let low = rel_posix.to_ascii_lowercase();
    let segments: Vec<&str> = low.split('/').collect();
    if segments.iter().any(|s| {
        matches!(
            *s,
            ".git"
                | "node_modules"
                | "target"
                | "__pycache__"
                | ".runtime"
                | "mhh-upload-20261105"
                | ".ssh"
                | ".gnupg"
                | ".aws"
                | ".kube"
                | ".azure"
                | "chrome_canary_profile"
                | "user data"
        )
    }) {
        return true;
    }
    let file = segments.last().copied().unwrap_or("");
    file.contains("cookies")
        || file.contains("credential")
        || file == "chrome_master_key.bin"
        || file == "master.key"
        || file == "id_rsa"
        || file.starts_with("id_rsa.")
        || file == "id_ed25519"
        || file.starts_with("id_ed25519.")
        || file == "id_ecdsa"
        || file.starts_with("id_ecdsa.")
        || file == "id_dsa"
        || file.starts_with("id_dsa.")
        || file == "authorized_keys"
        || file == "known_hosts"
        || file == "netrc"
        || file == "_netrc"
        || file == ".netrc"
        || file == ".npmrc"
        || file == ".pypirc"
        || file == ".dockercfg"
        || file.starts_with(".env")
        || file.ends_with(".pem")
        || file.ends_with(".key")
        || file.ends_with(".p12")
        || file.ends_with(".pfx")
        || file.ends_with(".ppk")
        || file.ends_with(".kdbx")
        || file.ends_with(".jks")
        || file.ends_with(".keystore")
        || file.ends_with(".secret")
        || file.ends_with(".secrets")
}

/// Clean HTML markup into safe plain text (stripping `<script>`, `<style>`, comments, and tags).
#[must_use]
pub fn clean_html_to_text(html: &str) -> String {
    let without_scripts = strip_html_tag_block(html, "script");
    let without_styles = strip_html_tag_block(&without_scripts, "style");
    let without_comments = strip_html_comments(&without_styles);

    let mut out = String::with_capacity(without_comments.len());
    let mut in_tag = false;
    let mut tag_buf = String::new();
    for ch in without_comments.chars() {
        if ch == '<' {
            in_tag = true;
            tag_buf.clear();
        } else if ch == '>' && in_tag {
            in_tag = false;
            let tag_low = tag_buf
                .trim()
                .trim_start_matches('/')
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if matches!(
                tag_low.as_str(),
                "p" | "div" | "br" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                    | "section" | "article" | "blockquote" | "pre"
            ) {
                out.push('\n');
            } else if matches!(tag_low.as_str(), "td" | "th") {
                out.push('\t');
            }
        } else if !in_tag {
            out.push(ch);
        } else {
            tag_buf.push(ch);
        }
    }

    let decoded = decode_html_entities(&out);
    collapse_blank_lines(&decoded)
}

fn strip_html_tag_block(input: &str, tag: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;

    while let Some(rel) = lower[cursor..].find(&open) {
        let start = cursor + rel;
        out.push_str(&input[cursor..start]);
        if let Some(rel_end) = lower[start..].find(&close) {
            cursor = start + rel_end + close.len();
        } else {
            cursor = input.len();
            break;
        }
    }
    if cursor < input.len() {
        out.push_str(&input[cursor..]);
    }
    out
}

fn strip_html_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;
    while let Some(rel) = input[cursor..].find("<!--") {
        let start = cursor + rel;
        out.push_str(&input[cursor..start]);
        if let Some(rel_end) = input[start + 4..].find("-->") {
            cursor = start + 4 + rel_end + 3;
        } else {
            cursor = input.len();
            break;
        }
    }
    if cursor < input.len() {
        out.push_str(&input[cursor..]);
    }
    out
}

fn decode_html_entities(input: &str) -> String {
    input
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

/// RFC-4180 quote-aware CSV/TSV parser producing an [`ExtractedSheet`].
#[must_use]
pub fn parse_delimited_table(name: &str, text: &str, delimiter: u8) -> ExtractedSheet {
    let delim_ch = delimiter as char;
    let mut all_rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    cell.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                cell.push(ch);
            }
        } else if ch == '"' && cell.is_empty() {
            in_quotes = true;
        } else if ch == delim_ch {
            row.push(cell.trim().to_string());
            cell.clear();
        } else if ch == '\n' {
            row.push(cell.trim().to_string());
            cell.clear();
            if row.iter().any(|c| !c.is_empty()) {
                all_rows.push(std::mem::take(&mut row));
            } else {
                row.clear();
            }
        } else if ch != '\r' {
            cell.push(ch);
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell.trim().to_string());
        if row.iter().any(|c| !c.is_empty()) {
            all_rows.push(row);
        }
    }

    let (headers, rows) = if all_rows.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        (all_rows[0].clone(), all_rows[1..].to_vec())
    };
    ExtractedSheet {
        name: name.to_string(),
        headers,
        rows,
    }
}

/// Parse Jupyter Notebook (`.ipynb`) JSON cells while guarding against prototype pollution keys.
pub fn parse_ipynb_cells(bytes: &[u8]) -> Result<Vec<ExtractedNotebookCell>, NotebookError> {
    let val: Value = serde_json::from_slice(bytes)?;
    if let Some(proto) = find_unsafe_prototype_key(&val, "$") {
        return Err(NotebookError::SecurityRejected {
            code: "UNSAFE_PROTOTYPE_KEY",
            reason: format!("IPYNB contains forbidden prototype key at '{proto}'"),
        });
    }
    let cells = val
        .get("cells")
        .and_then(Value::as_array)
        .ok_or_else(|| NotebookError::InvalidInput("IPYNB missing 'cells' array".to_string()))?;

    let mut out = Vec::with_capacity(cells.len());
    for (idx, cell) in cells.iter().enumerate() {
        let cell_type = cell
            .get("cell_type")
            .and_then(Value::as_str)
            .unwrap_or("raw")
            .to_string();
        let source = extract_ipynb_text_field(cell.get("source"));
        let mut outputs = Vec::new();
        if let Some(raw_outputs) = cell.get("outputs").and_then(Value::as_array) {
            for output in raw_outputs {
                let text = extract_ipynb_text_field(output.get("text")).trim().to_string();
                if !text.is_empty() {
                    outputs.push(text);
                } else if let Some(plain) = output
                    .get("data")
                    .and_then(|d| d.get("text/plain"))
                {
                    let p = extract_ipynb_text_field(Some(plain)).trim().to_string();
                    if !p.is_empty() {
                        outputs.push(p);
                    }
                }
            }
        }
        out.push(ExtractedNotebookCell {
            cell_index: idx,
            cell_type,
            source: SecretRedactor::redact(&source),
            outputs: outputs.into_iter().map(|o| SecretRedactor::redact(&o)).collect(),
        });
    }
    Ok(out)
}

fn extract_ipynb_text_field(val: Option<&Value>) -> String {
    match val {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(lines)) => lines
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .concat(),
        _ => String::new(),
    }
}

/// Extract clean text from a general XML document after running [`validate_xml_safety`].
pub fn extract_xml_text(bytes: &[u8], context: &str) -> Result<String, NotebookError> {
    validate_xml_safety(bytes, context)?;
    let mut reader = Reader::from_reader(bytes);
    let mut buf = Vec::new();
    let mut pieces = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Text(e)) => {
                let txt = e
                    .unescape()
                    .map_err(|err| NotebookError::InvalidInput(format!("XML text error in '{context}': {err}")))?;
                let trimmed = txt.trim();
                if !trimmed.is_empty() {
                    pieces.push(trimmed.to_string());
                }
            }
            Ok(Event::CData(e)) => {
                let txt = String::from_utf8_lossy(e.as_ref()).trim().to_string();
                if !txt.is_empty() {
                    pieces.push(txt);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(NotebookError::InvalidInput(format!(
                    "malformed XML '{context}': {e}"
                )));
            }
            _ => {}
        }
        buf.clear();
    }
    Ok(pieces.join("\n"))
}

/// Validate JSON (prototype-key guard), redact secrets, and pretty-format for chunking.
pub fn clean_json_to_markdown(bytes: &[u8]) -> Result<String, NotebookError> {
    let val: Value = serde_json::from_slice(bytes)?;
    if let Some(proto) = find_unsafe_prototype_key(&val, "$") {
        return Err(NotebookError::SecurityRejected {
            code: "UNSAFE_PROTOTYPE_KEY",
            reason: format!("JSON payload contains forbidden prototype key at '{proto}'"),
        });
    }
    let redacted = SecretRedactor::redact_json(&val);
    Ok(serde_json::to_string_pretty(&redacted)?)
}

/// Render parsed sheets as Markdown tables.
#[must_use]
pub fn render_sheets_to_markdown(sheets: &[ExtractedSheet]) -> String {
    sheets
        .iter()
        .map(|s| render_single_sheet_markdown(s, true))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn render_single_sheet_markdown(sheet: &ExtractedSheet, include_heading: bool) -> String {
    let mut out = String::new();
    if include_heading && !sheet.name.is_empty() {
        out.push_str(&format!("## {}\n\n", sheet.name));
    }
    if sheet.headers.is_empty() && sheet.rows.is_empty() {
        return out;
    }
    let cols = sheet
        .headers
        .len()
        .max(sheet.rows.iter().map(Vec::len).max().unwrap_or(0))
        .max(1);
    let header_row: Vec<String> = (0..cols)
        .map(|i| {
            sheet
                .headers
                .get(i)
                .map(|c| escape_md_cell(c))
                .unwrap_or_default()
        })
        .collect();
    out.push_str(&format!("| {} |\n", header_row.join(" | ")));
    out.push_str(&format!(
        "| {} |\n",
        vec!["---"; cols].join(" | ")
    ));
    for row in &sheet.rows {
        let cells: Vec<String> = (0..cols)
            .map(|i| row.get(i).map(|c| escape_md_cell(c)).unwrap_or_default())
            .collect();
        out.push_str(&format!("| {} |\n", cells.join(" | ")));
    }
    out.trim_end().to_string()
}

fn escape_md_cell(cell: &str) -> String {
    cell.replace('|', "\\|").replace('\n', " ")
}

/// Render extracted PPTX slides to Markdown sections.
#[must_use]
pub fn render_slides_to_markdown(slides: &[ExtractedSlide]) -> String {
    slides
        .iter()
        .map(|s| format!("## Slide {}: {}\n\n{}", s.slide_number, s.title, s.lines.join("\n")))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Render parsed IPYNB cells into structured Markdown.
#[must_use]
pub fn render_ipynb_to_markdown(cells: &[ExtractedNotebookCell]) -> String {
    cells
        .iter()
        .map(|cell| {
            let mut part = format!("## Cell {} ({})\n\n", cell.cell_index + 1, cell.cell_type);
            if cell.cell_type == "code" {
                part.push_str(&format!("```python\n{}\n```", cell.source.trim_end()));
            } else {
                part.push_str(cell.source.trim());
            }
            if !cell.outputs.is_empty() {
                part.push_str("\n\n### Output\n```\n");
                part.push_str(&cell.outputs.join("\n"));
                part.push_str("\n```");
            }
            part
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Heading-aware semantic chunker guaranteeing every chunk is valid UTF-8 and strictly `<= max_chunk_bytes` (`<= 120 KiB`).
#[must_use]
pub fn chunk_text_semantically(text: &str, max_chunk_bytes: usize) -> Vec<(String, String)> {
    let limit = max_chunk_bytes.clamp(128, MAX_CHUNK_BYTES);
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut cur_heading = "Overview".to_string();
    let mut cur_body = String::new();

    for line in normalized.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') {
            if !cur_body.trim().is_empty() {
                sections.push((cur_heading.clone(), std::mem::take(&mut cur_body)));
            }
            cur_heading = trimmed.trim_start_matches('#').trim().to_string();
            if cur_heading.is_empty() {
                cur_heading = "Section".to_string();
            }
            cur_body.push_str(line);
            cur_body.push('\n');
        } else {
            cur_body.push_str(line);
            cur_body.push('\n');
        }
    }
    if !cur_body.trim().is_empty() {
        sections.push((cur_heading, cur_body));
    }

    let mut chunks = Vec::new();
    for (heading, body) in sections {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.len() <= limit {
            chunks.push((heading, trimmed.to_string()));
            continue;
        }

        let mut acc = String::new();
        for para in trimmed.split("\n\n") {
            let p = para.trim();
            if p.is_empty() {
                continue;
            }
            if p.len() > limit {
                if !acc.is_empty() {
                    chunks.push((heading.clone(), std::mem::take(&mut acc)));
                }
                for piece in split_utf8_by_max_bytes(p, limit) {
                    chunks.push((heading.clone(), piece));
                }
                continue;
            }
            let sep = if acc.is_empty() { 0 } else { 2 };
            if acc.len() + sep + p.len() > limit {
                chunks.push((heading.clone(), std::mem::take(&mut acc)));
            }
            if !acc.is_empty() {
                acc.push_str("\n\n");
            }
            acc.push_str(p);
        }
        if !acc.is_empty() {
            chunks.push((heading, acc));
        }
    }
    chunks
}

/// Stage 5 copied-text fallback slicer strictly capped at `<= 40 KiB` (`MAX_COPIED_TEXT_BYTES`) per chunk.
#[must_use]
pub fn chunk_copied_text_fallback(text: &str) -> Vec<(String, String)> {
    split_utf8_by_max_bytes(text.trim(), MAX_COPIED_TEXT_BYTES)
        .into_iter()
        .enumerate()
        .map(|(i, piece)| (format!("Copied Text Part {}", i + 1), piece))
        .collect()
}

/// Split UTF-8 text into slices each strictly `<= max_bytes` on valid UTF-8 char boundaries.
#[must_use]
pub fn split_utf8_by_max_bytes(text: &str, max_bytes: usize) -> Vec<String> {
    let cap = max_bytes.max(1);
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < text.len() {
        let mut end = (start + cap).min(text.len());
        while end > start && !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == start {
            if let Some(ch) = text[start..].chars().next() {
                end = start + ch.len_utf8();
            } else {
                break;
            }
        }
        // Prefer breaking at newline/space when not at the end.
        if end < text.len() {
            let slice = &text[start..end];
            if let Some(nl) = slice.rfind('\n') {
                if nl > slice.len() / 2 {
                    end = start + nl;
                }
            } else if let Some(sp) = slice.rfind(' ') {
                if sp > slice.len() / 2 {
                    end = start + sp;
                }
            }
        }
        let piece = text[start..end].trim();
        if !piece.is_empty() {
            out.push(piece.to_string());
        }
        start = end;
        while start < text.len() && text.as_bytes()[start].is_ascii_whitespace() {
            start += 1;
        }
    }
    out
}

/// Result of encoding-safe text decoding (`decode_text_safely`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecodedText {
    pub text: String,
    pub detected_encoding: String,
    pub stripped_nuls: usize,
    pub stripped_controls: usize,
}

/// Pure-Rust Windows-1252 single-byte lookup for `0x80..=0x9F` (rest maps 1:1 to Unicode Latin-1).
const CP1252_80_9F: [char; 32] = [
    '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}', '\u{017D}', '\u{008F}',
    '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
];

fn detect_bomless_utf16(bytes: &[u8]) -> Option<&'static str> {
    let sample_len = bytes.len().min(4_096) & !1;
    if sample_len < 4 {
        return None;
    }
    let pairs = sample_len / 2;
    let mut even_nuls = 0usize;
    let mut odd_nuls = 0usize;
    for pair in bytes[..sample_len].as_chunks::<2>().0 {
        if pair[0] == 0 {
            even_nuls += 1;
        }
        if pair[1] == 0 {
            odd_nuls += 1;
        }
    }
    let odd_ratio = (odd_nuls as f64) / (pairs as f64);
    let even_ratio = (even_nuls as f64) / (pairs as f64);
    if odd_ratio >= 0.40 && even_ratio <= 0.08 {
        Some("utf-16le-bomless")
    } else if even_ratio >= 0.40 && odd_ratio <= 0.08 {
        Some("utf-16be-bomless")
    } else {
        None
    }
}

fn decode_cp1252(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for &b in bytes {
        match b {
            0x00 => {}
            0x80..=0x9F => out.push(CP1252_80_9F[(b - 0x80) as usize]),
            _ => out.push(char::from(b)),
        }
    }
    out
}

/// Multi-encoding text decoder safely handling UTF-8 (with/without BOM), UTF-16LE/BE (BOM &
/// BOM-less NUL-stride heuristic), UTF-32LE/BE BOM, stray-NUL UTF-8 (`<25%` NULs), and
/// Windows-1252 / Latin-1 fallback while normalizing CRLF/CR to LF and stripping unsafe controls.
#[must_use]
pub fn decode_text_safely(bytes: &[u8]) -> DecodedText {
    if bytes.is_empty() {
        return DecodedText {
            text: String::new(),
            detected_encoding: "utf-8".to_string(),
            stripped_nuls: 0,
            stripped_controls: 0,
        };
    }

    let mut stripped_nuls = 0usize;
    let (raw, encoding): (String, &str) = if bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00])
        && bytes.len() >= 4
    {
        let decoded: String = bytes[4..]
            .as_chunks::<4>()
            .0
            .iter()
            .filter_map(|&c| char::from_u32(u32::from_le_bytes(c)))
            .collect();
        (decoded, "utf-32le")
    } else if bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF]) && bytes.len() >= 4 {
        let decoded: String = bytes[4..]
            .as_chunks::<4>()
            .0
            .iter()
            .filter_map(|&c| char::from_u32(u32::from_be_bytes(c)))
            .collect();
        (decoded, "utf-32be")
    } else if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let rest = &bytes[3..];
        match std::str::from_utf8(rest) {
            Ok(s) => (s.to_string(), "utf-8-bom"),
            Err(_) => (decode_cp1252(rest), "windows-1252"),
        }
    } else if bytes.starts_with(&[0xFF, 0xFE]) && bytes.len() >= 2 {
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&c| u16::from_le_bytes(c))
            .collect();
        (String::from_utf16_lossy(&units), "utf-16le")
    } else if bytes.starts_with(&[0xFE, 0xFF]) && bytes.len() >= 2 {
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&c| u16::from_be_bytes(c))
            .collect();
        (String::from_utf16_lossy(&units), "utf-16be")
    } else if let Some(bomless) = detect_bomless_utf16(bytes) {
        if bomless == "utf-16le-bomless" {
            let units: Vec<u16> = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|&c| u16::from_le_bytes(c))
                .collect();
            (String::from_utf16_lossy(&units), bomless)
        } else {
            let units: Vec<u16> = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|&c| u16::from_be_bytes(c))
                .collect();
            (String::from_utf16_lossy(&units), bomless)
        }
    } else {
        let nul_count = bytes.iter().filter(|&&b| b == 0).count();
        if nul_count > 0 && nul_count * 4 < bytes.len() {
            stripped_nuls = nul_count;
            let cleaned: Vec<u8> = bytes.iter().copied().filter(|&b| b != 0).collect();
            match std::str::from_utf8(&cleaned) {
                Ok(s) => (s.to_string(), "utf-8-nul-cleaned"),
                Err(_) => (decode_cp1252(&cleaned), "windows-1252"),
            }
        } else {
            match std::str::from_utf8(bytes) {
                Ok(s) => (s.to_string(), "utf-8"),
                Err(_) => (decode_cp1252(bytes), "windows-1252"),
            }
        }
    };

    let lf = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut stripped_controls = 0usize;
    let mut clean = String::with_capacity(lf.len());
    for ch in lf.chars() {
        if ch == '\0' {
            stripped_nuls += 1;
        } else if ch == '\u{FEFF}' || (ch.is_control() && ch != '\n' && ch != '\t') {
            stripped_controls += 1;
        } else {
            clean.push(ch);
        }
    }

    DecodedText {
        text: clean,
        detected_encoding: encoding.to_string(),
        stripped_nuls,
        stripped_controls,
    }
}

/// Decode UTF-8 / UTF-16 / UTF-32 / Windows-1252 text cleanly, strip unsafe control chars,
/// and normalize line endings to LF.
#[must_use]
pub fn normalize_utf8_and_lf(bytes: &[u8]) -> String {
    decode_text_safely(bytes).text
}

/// Heuristic binary detector inspecting the first 8 KiB for NUL bytes or excessive non-printable bytes
/// (recognizing UTF-16LE/BE with or without BOM and UTF-32 BOM as textual encodings).
#[must_use]
pub fn is_likely_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8_192)];
    if sample.is_empty() {
        return false;
    }
    if sample.starts_with(&[0xFF, 0xFE])
        || sample.starts_with(&[0xFE, 0xFF])
        || sample.starts_with(&[0x00, 0x00, 0xFE, 0xFF])
        || detect_bomless_utf16(sample).is_some()
    {
        return false;
    }
    if sample.contains(&0) {
        return true;
    }
    let suspicious = sample
        .iter()
        .filter(|&&b| b < 0x09 || (0x0E..0x20).contains(&b))
        .count();
    suspicious * 10 > sample.len() * 3
}

/// Explicit stage identifier for the 5-stage `UploadHealer` recovery ladder (Stage 0 -> Stage 5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealStage {
    Stage0Direct,
    Stage1SanitizedRetry,
    Stage2DeepConvertSplit,
    Stage3PlainTxtChunks,
    Stage4CopiedTextMicroChunks,
    Stage5MetadataInventory,
}

impl HealStage {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Stage0Direct => "stage0_direct",
            Self::Stage1SanitizedRetry => "stage1_sanitized_retry",
            Self::Stage2DeepConvertSplit => "stage2_deep_convert_split",
            Self::Stage3PlainTxtChunks => "stage3_plain_txt_chunks",
            Self::Stage4CopiedTextMicroChunks => "stage4_copied_text_micro_chunks",
            Self::Stage5MetadataInventory => "stage5_metadata_inventory",
        }
    }

    #[must_use]
    pub const fn stage_number(self) -> u8 {
        match self {
            Self::Stage0Direct => 0,
            Self::Stage1SanitizedRetry => 1,
            Self::Stage2DeepConvertSplit => 2,
            Self::Stage3PlainTxtChunks => 3,
            Self::Stage4CopiedTextMicroChunks => 4,
            Self::Stage5MetadataInventory => 5,
        }
    }
}

/// Payload context passed to the caller's upload/transport validator on each `UploadHealer` stage.
#[derive(Debug, Clone)]
pub struct UploadAttemptContext {
    pub stage: HealStage,
    pub filename: String,
    pub mime_type: String,
    pub part_index: usize,
    pub total_parts: usize,
    pub bytes: Vec<u8>,
}

/// Audit entry recorded for each stage attempted by [`UploadHealer`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadHealAttempt {
    pub stage: HealStage,
    pub filename: String,
    pub parts_attempted: usize,
    pub succeeded: bool,
    pub purged_failed_rows: usize,
    pub error: Option<String>,
}

/// Final outcome returned by [`UploadHealer::heal_and_ingest`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HealedUploadOutcome {
    pub notebook_id: String,
    pub final_stage: HealStage,
    pub normalized_filename: String,
    pub sources: Vec<SourceRecord>,
    pub attempts: Vec<UploadHealAttempt>,
    pub total_purged_failed_rows: usize,
    pub warnings: Vec<String>,
}

/// 5-Stage Upload Recovery Ladder (`Stage 0` Direct -> `Stage 1` Sanitized `<= 88`-char retry ->
/// `Stage 2` Deep Convert & Split `<= 120 KiB` -> `Stage 3` Plain `.txt` chunks `<= 120 KiB` ->
/// `Stage 4` Copied-Text micro-chunks `<= 40 KiB` -> `Stage 5` Metadata Inventory fallback)
/// enforcing zero-red-rows failed-source purge before every retry and atomic sibling rollback.
#[derive(Debug, Clone, Default)]
pub struct UploadHealer;

impl UploadHealer {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// Run the 5-stage recovery ladder using a local always-accept validator.
    pub fn heal_ingest_local(
        &self,
        engine: &IngestionEngine,
        req: IngestSourceRequest,
    ) -> Result<HealedUploadOutcome, NotebookError> {
        self.heal_and_ingest(engine, req, |_| Ok(()))
    }

    /// Execute the 5-stage self-healing upload ladder against `engine` and an external/remote
    /// `upload_validator` closure. Security/policy/capacity errors fail closed immediately;
    /// transport or conversion failures purge failed rows, roll back partial siblings, and
    /// escalate deterministically through Stages 0 -> 5.
    pub fn heal_and_ingest<F>(
        &self,
        engine: &IngestionEngine,
        req: IngestSourceRequest,
        mut upload_validator: F,
    ) -> Result<HealedUploadOutcome, NotebookError>
    where
        F: FnMut(&UploadAttemptContext) -> Result<(), String>,
    {
        let _ = engine.library.require_notebook(&req.notebook_id)?;
        let notebook_id = req.notebook_id.clone();
        let normalized_filename = normalize_drive_filename_suffix(&req.filename);
        let ext = extract_extension_lower(&normalized_filename);
        const BLOCKED_EXECUTABLE_EXTS: &[&str] = &[
            "exe", "dll", "sys", "msi", "msp", "scr", "com", "pif", "lnk", "vbs", "vbe", "hta",
            "reg", "cpl", "ocx", "drv", "inf", "apk", "dmg", "pkg", "deb", "rpm",
        ];
        if BLOCKED_EXECUTABLE_EXTS.contains(&ext.as_str()) {
            return Err(NotebookError::SecurityRejected {
                code: "DISALLOWED_EXTENSION",
                reason: format!("executable/installer extension '.{ext}' is strictly blocked"),
            });
        }
        let original_mime = req
            .mime_type
            .clone()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| infer_mime_from_extension(&ext).to_string());
        let sanitized_name =
            sanitize_transport_filename(&normalized_filename, MAX_TRANSPORT_FILENAME_LEN);
        let stem_base = sanitized_name
            .rsplit_once('.')
            .map_or(sanitized_name.as_str(), |(s, _)| s)
            .to_string();
        let original_sha256 = sha256_hex(&req.bytes);
        let original_len = req.bytes.len();
        let base_title = req
            .title
            .clone()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| normalized_filename.clone());
        let mut base_meta = if req.metadata.is_object() {
            req.metadata.clone()
        } else {
            json!({})
        };
        strip_local_path_fields(&mut base_meta);

        let mut attempts = Vec::new();
        let mut warnings = Vec::new();
        let mut total_purged = 0usize;

        let shared = HealStageShared {
            notebook_id: &notebook_id,
            normalized_filename: &normalized_filename,
            sanitized_name: &sanitized_name,
            original_sha256: &original_sha256,
            base_meta: &base_meta,
            copied_text_fallback: req.copied_text_fallback.as_deref(),
            max_chunk_bytes: req.max_chunk_bytes,
        };

        // Stage 0: Direct upload with Drive suffix normalization.
        if let Some(done) = run_heal_stage(
            engine,
            &shared,
            HealStage::Stage0Direct,
            vec![(
                normalized_filename.clone(),
                base_title.clone(),
                original_mime.clone(),
                req.bytes.clone(),
            )],
            req.remote_id.clone(),
            &mut upload_validator,
            &mut attempts,
            &mut warnings,
            &mut total_purged,
        )? {
            return Ok(done);
        }

        // Stage 1: Sanitized `<= 88`-char ASCII filename + safe text normalization retry.
        let stage1_bytes = if is_likely_binary(&req.bytes) {
            req.bytes.clone()
        } else {
            decode_text_safely(&req.bytes).text.into_bytes()
        };
        if let Some(done) = run_heal_stage(
            engine,
            &shared,
            HealStage::Stage1SanitizedRetry,
            vec![(
                sanitized_name.clone(),
                base_title.clone(),
                original_mime.clone(),
                stage1_bytes,
            )],
            req.remote_id.clone(),
            &mut upload_validator,
            &mut attempts,
            &mut warnings,
            &mut total_purged,
        )? {
            return Ok(done);
        }

        // Extract recoverable text for Stages 2..4 (security errors fail closed immediately).
        let (extracted_md, detected_enc) = extract_healable_text(
            &ext,
            &normalized_filename,
            &req.bytes,
            req.copied_text_fallback.as_deref(),
        )?;

        // Stage 2: Deep convert & split into `<= 120 KiB` Markdown parts with atomic rollback.
        if !extracted_md.trim().is_empty() {
            let md_limit = req
                .max_chunk_bytes
                .unwrap_or(MAX_CHUNK_BYTES)
                .clamp(256, MAX_CHUNK_BYTES);
            let md_slices = chunk_text_semantically(&extracted_md, md_limit);
            let md_parts: Vec<(String, String, String, Vec<u8>)> = md_slices
                .into_iter()
                .enumerate()
                .map(|(i, (heading, body))| {
                    let fname = sanitize_transport_filename(
                        &format!("{stem_base}-p{:02}.md", i + 1),
                        MAX_TRANSPORT_FILENAME_LEN,
                    );
                    let title = format!("{base_title} (Part {})", i + 1);
                    let payload = format!("# {heading}\n\n{body}");
                    (fname, title, "text/markdown".to_string(), payload.into_bytes())
                })
                .collect();
            if !md_parts.is_empty() {
                if let Some(done) = run_heal_stage(
                    engine,
                    &shared,
                    HealStage::Stage2DeepConvertSplit,
                    md_parts,
                    None,
                    &mut upload_validator,
                    &mut attempts,
                    &mut warnings,
                    &mut total_purged,
                )? {
                    return Ok(done);
                }
            }

            // Stage 3: Plain UTF-8 `.txt` chunks (`<= 120 KiB` each, sanitized `<= 88`-char names).
            let plain_text = strip_markdown_to_plain(&extracted_md);
            let txt_slices = split_utf8_by_max_bytes(&plain_text, md_limit);
            let txt_parts: Vec<(String, String, String, Vec<u8>)> = txt_slices
                .into_iter()
                .enumerate()
                .map(|(i, piece)| {
                    let fname = sanitize_transport_filename(
                        &format!("{stem_base}-txt-{:02}.txt", i + 1),
                        MAX_TRANSPORT_FILENAME_LEN,
                    );
                    let title = format!("{base_title} (Plain Part {})", i + 1);
                    (fname, title, "text/plain".to_string(), piece.into_bytes())
                })
                .collect();
            if !txt_parts.is_empty() {
                if let Some(done) = run_heal_stage(
                    engine,
                    &shared,
                    HealStage::Stage3PlainTxtChunks,
                    txt_parts,
                    None,
                    &mut upload_validator,
                    &mut attempts,
                    &mut warnings,
                    &mut total_purged,
                )? {
                    return Ok(done);
                }
            }

            // Stage 4: Copied-text micro-chunks strictly `<= 40 KiB` (`MAX_COPIED_TEXT_BYTES`).
            let micro_slices = chunk_copied_text_fallback(&plain_text);
            let micro_parts: Vec<(String, String, String, Vec<u8>)> = micro_slices
                .into_iter()
                .enumerate()
                .map(|(i, (heading, piece))| {
                    let fname = sanitize_transport_filename(
                        &format!("{stem_base}-micro-{:02}.txt", i + 1),
                        MAX_TRANSPORT_FILENAME_LEN,
                    );
                    let title = format!("{base_title} ({heading})");
                    (fname, title, "text/plain".to_string(), piece.into_bytes())
                })
                .collect();
            if !micro_parts.is_empty() {
                if let Some(done) = run_heal_stage(
                    engine,
                    &shared,
                    HealStage::Stage4CopiedTextMicroChunks,
                    micro_parts,
                    None,
                    &mut upload_validator,
                    &mut attempts,
                    &mut warnings,
                    &mut total_purged,
                )? {
                    return Ok(done);
                }
            }
        }

        // Stage 5: Final deterministic metadata-inventory `.txt` fallback.
        let stage_summary = attempts
            .iter()
            .map(|a| {
                format!(
                    "- {}: {}",
                    a.stage.as_str(),
                    a.error.as_deref().unwrap_or("unknown failure")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let inventory_body = format!(
            "# Source Metadata Inventory\n\
             Original Filename: {normalized_filename}\n\
             Sanitized Filename: {sanitized_name}\n\
             MIME Type: {original_mime}\n\
             Byte Size: {original_len}\n\
             SHA-256: {original_sha256}\n\
             Detected Encoding: {detected_enc}\n\n\
             ## Prior Stage Diagnostics\n\
             {stage_summary}\n"
        );
        let inv_name = sanitize_transport_filename(
            &format!("{stem_base}-inventory.txt"),
            MAX_TRANSPORT_FILENAME_LEN,
        );
        if let Some(done) = run_heal_stage(
            engine,
            &shared,
            HealStage::Stage5MetadataInventory,
            vec![(
                inv_name,
                format!("{base_title} (Metadata Inventory)"),
                "text/plain".to_string(),
                inventory_body.into_bytes(),
            )],
            None,
            &mut upload_validator,
            &mut attempts,
            &mut warnings,
            &mut total_purged,
        )? {
            return Ok(done);
        }

        Err(NotebookError::IngestionFailed {
            stage: HealStage::Stage5MetadataInventory.as_str().to_string(),
            detail: format!(
                "all 6 UploadHealer stages (0..5) rejected for '{normalized_filename}'"
            ),
            rolled_back_siblings: 0,
        })
    }
}

struct HealStageShared<'a> {
    notebook_id: &'a str,
    normalized_filename: &'a str,
    sanitized_name: &'a str,
    original_sha256: &'a str,
    base_meta: &'a Value,
    copied_text_fallback: Option<&'a str>,
    max_chunk_bytes: Option<usize>,
}

#[allow(clippy::too_many_arguments)]
fn run_heal_stage<F>(
    engine: &IngestionEngine,
    shared: &HealStageShared<'_>,
    stage: HealStage,
    parts: Vec<(String, String, String, Vec<u8>)>,
    remote_id_first: Option<String>,
    upload_validator: &mut F,
    attempts: &mut Vec<UploadHealAttempt>,
    warnings: &mut Vec<String>,
    total_purged: &mut usize,
) -> Result<Option<HealedUploadOutcome>, NotebookError>
where
    F: FnMut(&UploadAttemptContext) -> Result<(), String>,
{
    let purged = if stage == HealStage::Stage0Direct {
        0
    } else {
        engine.store.purge_failed_sources(shared.notebook_id)?
    };
    *total_purged += purged;

    let total_parts = parts.len();
    let first_name = parts
        .first()
        .map(|p| p.0.clone())
        .unwrap_or_else(|| shared.sanitized_name.to_string());
    let mut inserted_new_ids = Vec::new();
    let mut created_sources = Vec::new();
    let mut stage_warnings = Vec::new();

    for (idx, (part_filename, part_title, part_mime, part_bytes)) in parts.into_iter().enumerate() {
        let ctx = UploadAttemptContext {
            stage,
            filename: part_filename.clone(),
            mime_type: part_mime.clone(),
            part_index: idx,
            total_parts,
            bytes: part_bytes.clone(),
        };
        if let Err(reason) = upload_validator(&ctx) {
            let _ = engine.store.delete_sources_by_ids(&inserted_new_ids)?;
            let post_purged = engine.store.purge_failed_sources(shared.notebook_id)?;
            *total_purged += post_purged;
            attempts.push(UploadHealAttempt {
                stage,
                filename: part_filename,
                parts_attempted: idx + 1,
                succeeded: false,
                purged_failed_rows: purged + post_purged,
                error: Some(reason.clone()),
            });
            warnings.push(format!("{} rejected: {reason}", stage.as_str()));
            return Ok(None);
        }

        let mut part_meta = shared.base_meta.clone();
        if let Some(map) = part_meta.as_object_mut() {
            map.insert("heal_stage".to_string(), json!(stage.as_str()));
            map.insert("heal_part_index".to_string(), json!(idx));
            map.insert("heal_total_parts".to_string(), json!(total_parts));
            map.insert("original_sha256".to_string(), json!(shared.original_sha256));
        }
        let ingest_req = IngestSourceRequest {
            notebook_id: shared.notebook_id.to_string(),
            title: Some(part_title),
            filename: part_filename.clone(),
            mime_type: Some(part_mime),
            remote_id: if idx == 0 {
                remote_id_first.clone()
            } else {
                None
            },
            bytes: part_bytes,
            copied_text_fallback: if stage == HealStage::Stage0Direct
                || stage == HealStage::Stage1SanitizedRetry
            {
                shared.copied_text_fallback.map(ToString::to_string)
            } else {
                None
            },
            max_chunk_bytes: shared.max_chunk_bytes,
            metadata: part_meta,
        };

        match engine.ingest_source(ingest_req) {
            Ok(outcome) => {
                if !outcome.deduplicated {
                    inserted_new_ids.push(outcome.source.source_id.clone());
                }
                stage_warnings.extend(outcome.warnings);
                created_sources.push(outcome.source);
            }
            Err(err @ NotebookError::SecurityRejected { .. })
            | Err(err @ NotebookError::PolicyBlocked { .. })
            | Err(err @ NotebookError::OverflowDisallowed { .. }) => {
                let _ = engine.store.delete_sources_by_ids(&inserted_new_ids)?;
                return Err(err);
            }
            Err(err) => {
                let _ = engine.store.delete_sources_by_ids(&inserted_new_ids)?;
                attempts.push(UploadHealAttempt {
                    stage,
                    filename: part_filename,
                    parts_attempted: idx + 1,
                    succeeded: false,
                    purged_failed_rows: purged,
                    error: Some(err.to_string()),
                });
                warnings.push(format!("{} failed: {err}", stage.as_str()));
                return Ok(None);
            }
        }
    }

    attempts.push(UploadHealAttempt {
        stage,
        filename: first_name,
        parts_attempted: total_parts,
        succeeded: true,
        purged_failed_rows: purged,
        error: None,
    });
    warnings.extend(stage_warnings);
    Ok(Some(HealedUploadOutcome {
        notebook_id: shared.notebook_id.to_string(),
        final_stage: stage,
        normalized_filename: shared.normalized_filename.to_string(),
        sources: created_sources,
        attempts: attempts.clone(),
        total_purged_failed_rows: *total_purged,
        warnings: warnings.clone(),
    }))
}

fn extract_healable_text(
    ext: &str,
    safe_filename: &str,
    bytes: &[u8],
    copied_fallback: Option<&str>,
) -> Result<(String, String), NotebookError> {
    let extracted = match ext {
        "docx" => extract_docx_markdown(bytes, 0),
        "xlsx" => extract_xlsx_sheets(bytes, 0).map(|s| render_sheets_to_markdown(&s)),
        "pptx" => extract_pptx_slides(bytes, 0).map(|s| render_slides_to_markdown(&s)),
        "epub" => extract_epub_markdown(bytes, 0),
        "odt" => extract_odt_markdown(bytes, 0),
        "rtf" => Ok(strip_rtf_to_text(&normalize_utf8_and_lf(bytes))),
        "pdf" => {
            let pdf = inspect_and_extract_pdf(bytes);
            if pdf.is_encrypted || pdf.classification == PdfClassification::Encrypted {
                return Err(NotebookError::SecurityRejected {
                    code: "ENCRYPTED_PDF",
                    reason: format!("encrypted PDF '{safe_filename}' rejected by UploadHealer"),
                });
            }
            Ok(pdf.extracted_text)
        }
        "csv" => {
            let dec = decode_text_safely(bytes);
            return Ok((
                render_sheets_to_markdown(&[parse_delimited_table(safe_filename, &dec.text, b',')]),
                dec.detected_encoding,
            ));
        }
        "tsv" => {
            let dec = decode_text_safely(bytes);
            return Ok((
                render_sheets_to_markdown(&[parse_delimited_table(
                    safe_filename,
                    &dec.text,
                    b'\t',
                )]),
                dec.detected_encoding,
            ));
        }
        "ipynb" => parse_ipynb_cells(bytes).map(|c| render_ipynb_to_markdown(&c)),
        "html" | "htm" | "xhtml" => {
            let dec = decode_text_safely(bytes);
            return Ok((clean_html_to_text(&dec.text), dec.detected_encoding));
        }
        "xml" | "svg" => {
            validate_xml_safety(bytes, safe_filename)?;
            extract_xml_text(bytes, safe_filename)
        }
        "json" => clean_json_to_markdown(bytes),
        "zip" | "jar" => inspect_zip_archive_safe(bytes, 0, safe_filename).map(|entries| {
            let mut lines = vec![format!("# Archive: {safe_filename}")];
            for entry in entries {
                lines.push(format!(
                    "- `{}` ({} bytes)",
                    entry.path, entry.uncompressed_bytes
                ));
            }
            lines.join("\n")
        }),
        _ => {
            if is_likely_binary(bytes) {
                Ok(String::new())
            } else {
                let dec = decode_text_safely(bytes);
                return Ok((dec.text, dec.detected_encoding));
            }
        }
    };

    match extracted {
        Ok(text) if !text.trim().is_empty() => Ok((text, "utf-8".to_string())),
        Err(err @ NotebookError::SecurityRejected { .. })
        | Err(err @ NotebookError::PolicyBlocked { .. }) => Err(err),
        _ => {
            if let Some(fb) = copied_fallback.map(str::trim).filter(|s| !s.is_empty()) {
                Ok((normalize_utf8_and_lf(fb.as_bytes()), "copied-text".to_string()))
            } else {
                Ok((String::new(), "binary".to_string()))
            }
        }
    }
}

fn strip_markdown_to_plain(md: &str) -> String {
    let mut lines = Vec::new();
    for line in md.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            continue;
        }
        let cleaned = trimmed
            .trim_start_matches('#')
            .trim_start_matches('>')
            .trim()
            .replace('`', "");
        if !cleaned.is_empty() {
            lines.push(cleaned);
        }
    }
    lines.join("\n")
}

fn local_xml_name(raw: &[u8]) -> &str {
    let s = std::str::from_utf8(raw).unwrap_or("");
    s.rsplit_once(':').map_or(s, |(_, local)| local)
}

fn extract_trailing_number(path: &str) -> Option<usize> {
    let stem = path
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .split('.')
        .next()
        .unwrap_or("");
    let digits: String = stem.chars().filter(char::is_ascii_digit).collect();
    digits.parse::<usize>().ok()
}

fn collapse_blank_lines(text: &str) -> String {
    let mut out = Vec::new();
    let mut prev_blank = false;
    for line in text.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            if !prev_blank {
                out.push("");
            }
            prev_blank = true;
        } else {
            out.push(trimmed);
            prev_blank = false;
        }
    }
    out.join("\n").trim().to_string()
}

fn truncate_utf8_bytes(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn to_posix_path(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn sanitize_slug(input: &str) -> String {
    let slug: String = input
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = slug.trim_matches('_');
    if trimmed.is_empty() {
        "repo".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Normalizes `SRT`, YouTube `JSON3`, or `TTML` subtitle payloads into clean `WEBVTT`
/// (reusable across Atelier media ingestion and Deep Research transcript extraction).
#[must_use]
pub fn normalize_subtitles_to_webvtt(raw: &str) -> String {
    let trimmed = raw.trim_start_matches('\u{FEFF}').trim();
    if trimmed.is_empty() {
        return "WEBVTT\n".to_string();
    }
    if trimmed.starts_with("WEBVTT") {
        return format!("{}\n", trimmed.replace("\r\n", "\n").replace('\r', "\n"));
    }
    // 1. YouTube JSON3 format (`{ "events": [{ "tStartMs": ..., "dDurationMs": ..., "segs": [{ "utf8": ... }] }] }`)
    if trimmed.starts_with('{') {
        if let Ok(Value::Object(root)) = serde_json::from_str::<Value>(trimmed) {
            if let Some(events) = root.get("events").and_then(Value::as_array) {
                let mut out = String::from("WEBVTT\n\n");
                for ev in events {
                    let start_ms = ev.get("tStartMs").and_then(Value::as_u64).unwrap_or(0);
                    let dur_ms = ev.get("dDurationMs").and_then(Value::as_u64).unwrap_or(2000);
                    let Some(segs) = ev.get("segs").and_then(Value::as_array) else {
                        continue;
                    };
                    let text: String = segs
                        .iter()
                        .filter_map(|s| s.get("utf8").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("");
                    let clean = text.replace('\n', " ").trim().to_string();
                    if clean.is_empty() {
                        continue;
                    }
                    out.push_str(&format!(
                        "{} --> {}\n{}\n\n",
                        format_vtt_ms(start_ms),
                        format_vtt_ms(start_ms.saturating_add(dur_ms.max(100))),
                        clean
                    ));
                }
                return out;
            }
        }
    }
    // 2. TTML / XML captions (`<p begin="..." end="...">...</p>`)
    if trimmed.starts_with('<') && (trimmed.contains("<tt") || trimmed.contains("<p ")) {
        let mut out = String::from("WEBVTT\n\n");
        let mut rest = trimmed;
        while let Some(pos) = rest.find("<p ") {
            let after = &rest[pos + 3..];
            let Some(tag_end) = after.find('>') else {
                break;
            };
            let attrs = &after[..tag_end];
            let body_rest = &after[tag_end + 1..];
            let Some(close_pos) = body_rest.find("</p>") else {
                break;
            };
            let body_raw = &body_rest[..close_pos];
            let begin = extract_xml_attr(attrs, "begin").unwrap_or_else(|| "00:00:00.000".into());
            let end = extract_xml_attr(attrs, "end").unwrap_or_else(|| "00:00:02.000".into());
            let text = clean_html_to_text(body_raw).trim().to_string();
            if !text.is_empty() {
                out.push_str(&format!(
                    "{} --> {}\n{}\n\n",
                    normalize_vtt_timestamp(&begin),
                    normalize_vtt_timestamp(&end),
                    text
                ));
            }
            rest = &body_rest[close_pos + 4..];
        }
        return out;
    }
    // 3. SRT -> WEBVTT (replace `,` milliseconds with `.` on timestamp arrow lines)
    let normalized = trimmed.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::from("WEBVTT\n\n");
    for line in normalized.lines() {
        let t = line.trim();
        if t.contains("-->") {
            let parts: Vec<&str> = t.split("-->").collect();
            if parts.len() == 2 {
                out.push_str(&format!(
                    "{} --> {}\n",
                    normalize_vtt_timestamp(parts[0].trim()),
                    normalize_vtt_timestamp(parts[1].trim())
                ));
                continue;
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn format_vtt_ms(ms: u64) -> String {
    let hrs = ms / 3_600_000;
    let rem = ms % 3_600_000;
    let mins = rem / 60_000;
    let rem2 = rem % 60_000;
    let secs = rem2 / 1_000;
    let millis = rem2 % 1_000;
    format!("{hrs:02}:{mins:02}:{secs:02}.{millis:03}")
}

fn normalize_vtt_timestamp(raw: &str) -> String {
    let cleaned = raw.trim().replace(',', ".");
    if let Some(secs_str) = cleaned.strip_suffix('s') {
        if let Ok(sec_f) = secs_str.parse::<f64>() {
            if sec_f.is_finite() && sec_f >= 0.0 {
                return format_vtt_ms((sec_f * 1000.0).round() as u64);
            }
        }
    }
    let parts: Vec<&str> = cleaned.split(':').collect();
    if parts.len() == 2 {
        format!("00:{cleaned}")
    } else {
        cleaned
    }
}

fn extract_xml_attr(attrs: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let start = attrs.find(&needle)? + needle.len();
    let end = attrs[start..].find('"')?;
    Some(attrs[start..start + end].to_string())
}

/// Expose archive entry ceiling constant for callers.
#[must_use]
pub const fn max_archive_entries() -> usize {
    MAX_ARCHIVE_ENTRIES
}
