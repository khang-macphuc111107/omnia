//! `omnia-notebook`: Full Native Rust (`#![forbid(unsafe_code)]`) Gemini Notebook
//! (**Atelier Research Studio v3**) engine for Omnia.
//!
//! Wires Omnia's existing `omnia-winsqlite`, `omnia-connector-gateway::{artifact_intake, gemini_share}`,
//! `omnia-harness::{proactive_rag, memory_graph}`, `omnia-graph::graphify_index`, and
//! `omnia-workspace-ops` into a cohesive persistent notebook engine ready for Wave 3
//! `omnia-studio` (`/api/notebooks/*`, `/api/btw/*`, `/api/bridge`) and Atelier Research Studio v3 UI.

#![forbid(unsafe_code)]

pub mod dispatcher;
pub mod error;
pub mod grounding;
pub mod ingestion;
pub mod interactions;
pub mod policy;
pub mod preview;
pub mod share_import;
pub mod source_library;
pub mod store;
pub mod studio_artifacts;

use std::future::Future;
use std::path::Path;
use std::sync::Arc;

use chrono::Utc;
use omnia_core::{now_epoch_ms, SecretRedactor};
use omnia_harness::MemoryGraph;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;

pub use dispatcher::{
    default_model_catalog, DispatchReceipt, DispatchRequest, DualQueueDispatcher, DualQueueStats,
    EffortLevel, ModelCatalogEntry, SingleQueueStats,
};
pub use error::NotebookError;
pub use grounding::{
    AmbiguousCitationWarning, CitationVerificationReport, GroundedChunkEvidence,
    GroundedPromptPack, GroundingEngine, InvalidCitationRef, VerifiedCitationRef,
};
pub use ingestion::{
    chunk_copied_text_fallback, chunk_text_semantically, clean_html_to_text,
    clean_json_to_markdown, extract_docx_markdown, extract_epub_markdown, extract_odt_markdown,
    extract_pptx_slides, extract_xlsx_sheets, extract_xml_text, inspect_and_extract_pdf,
    inspect_zip_archive_safe, is_likely_binary, normalize_utf8_and_lf, package_code_repository,
    parse_delimited_table, parse_ipynb_cells, read_zip_entries_bounded, render_ipynb_to_markdown,
    render_sheets_to_markdown, render_slides_to_markdown, strip_rtf_to_text, ExtractedNotebookCell,
    ExtractedSheet, ExtractedSlide, HealSweepReport, IngestSourceOutcome, IngestSourceRequest,
    IngestionEngine, IngestionStage, MultipartIngestOutcome, PackagedRepository, PdfClassification,
    PdfExtractionResult, RepoPackageConfig, SafeZipEntry,
};
pub use interactions::{
    build_composer_quote_card, BridgeDirection, BridgeTransferReceipt, BridgeTransferRequest,
    BtwMessage, BtwThread, BtwThreadStatus, ComposerQuoteCard, CreateQuoteCardRequest,
    InteractionService, InteractionSurface, PromoteBtwOutcome, QuoteRef, SelectionAction,
};
pub use policy::{
    validate_archive_entry_path, validate_archive_limits, validate_filename_and_mime,
    validate_xml_safety, validate_xml_safety_with_limit, AuthChallengeCircuitBreaker,
    AuthCircuitSnapshot, AuthCircuitState, PreviewSecurityHeaders, VisibleHandoffManager,
    VisibleHandoffStatus, VisibleHandoffTicket, ARTIFACT_INTAKE_ALLOWED_EXTENSIONS,
    AUTH_CHALLENGE_CODE, AUTH_CHALLENGE_HTTP_STATUS, DEFAULT_MAX_SOURCES_PER_NOTEBOOK,
    MANUAL_VISIBLE_BROWSER_ONLY, MAX_ARCHIVE_DEPTH, MAX_ARCHIVE_ENTRIES, MAX_BINARY_PREVIEW_BYTES,
    MAX_CHUNK_BYTES, MAX_COPIED_TEXT_BYTES, MAX_EXPANSION_RATIO, MAX_JAR_PREVIEW_CLASSES,
    MAX_XML_BYTES,
};
pub use preview::{
    detect_code_language, format_hex_dump, ArchiveTreeEntry, MediaAssetMetadata, PreviewContent,
    PreviewFormat, PreviewPayload, RichPreviewService,
};
pub use share_import::{PublicShareImporter, ShareImportOutcome, ShareImporterConfig};
pub use source_library::{
    ClearSourcesReceipt, CreateNotebookRequest, NotebookRecord, ResolvedCitationTarget,
    SourceBatchDedupReport, SourceChunkRecord, SourceFilter, SourceKind, SourceLibrary,
    SourceRecord, SourceRegistrationInput, SourceRegistrationOutcome,
};
pub use store::{
    Bm25ChunkHit, NotebookStore, NotebookTurnRecord, StoredArtifactRow, StoredBridgeRow,
    StoredBtwRow,
};
pub use studio_artifacts::{
    GenerateArtifactRequest, StudioArtifactKind, StudioArtifactRecord, StudioArtifactService,
};

/// Crate identity string for diagnostics.
pub const CRATE_NAME: &str = "omnia-notebook";

/// Request payload to persist a main-surface chat turn in `notebook_turns`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordTurnRequest {
    pub notebook_id: String,
    pub surface: InteractionSurface,
    pub prompt_text: String,
    pub response_markdown: String,
    pub model_id: String,
    pub effort: EffortLevel,
    #[serde(default)]
    pub quotes: Vec<QuoteRef>,
    #[serde(default)]
    pub citations: Vec<String>,
}

/// High-level health/telemetry snapshot for Wave 3 `/api/notebooks/status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotebookEngineStatus {
    pub crate_name: String,
    pub timestamp_utc: String,
    pub db_path: String,
    pub journal_mode: String,
    pub fts5_enabled: bool,
    pub notebook_count: usize,
    pub circuit_breaker: AuthCircuitSnapshot,
    pub pending_handoffs: usize,
    pub queues: DualQueueStats,
}

/// Unified pure-Rust facade composing all Atelier Research Studio v3 subsystems.
#[derive(Debug)]
pub struct NotebookEngine {
    store: Arc<NotebookStore>,
    library: SourceLibrary,
    ingestion: IngestionEngine,
    preview: RichPreviewService,
    interactions: InteractionService,
    dispatcher: DualQueueDispatcher,
    grounding: GroundingEngine,
    artifacts: StudioArtifactService,
    handoff: Arc<VisibleHandoffManager>,
    circuit_breaker: Arc<AuthChallengeCircuitBreaker>,
    share_importer: PublicShareImporter,
}

impl NotebookEngine {
    /// Open or create a persistent WAL-backed [`NotebookEngine`] at `db_path`.
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self, NotebookError> {
        let store = Arc::new(NotebookStore::open(db_path)?);
        Ok(Self::from_store(store))
    }

    /// Open an isolated in-memory [`NotebookEngine`] for unit tests or ephemeral sessions.
    pub fn open_in_memory() -> Result<Self, NotebookError> {
        let store = Arc::new(NotebookStore::open_in_memory()?);
        Ok(Self::from_store(store))
    }

    /// Assemble an engine around an existing [`NotebookStore`].
    #[must_use]
    pub fn from_store(store: Arc<NotebookStore>) -> Self {
        let library = SourceLibrary::new(Arc::clone(&store));
        let ingestion = IngestionEngine::new(Arc::clone(&store), library.clone());
        let preview = RichPreviewService::new();
        let interactions = InteractionService::new(Arc::clone(&store), library.clone());
        let dispatcher = DualQueueDispatcher::default();
        let memory_graph = Arc::new(MemoryGraph::new());
        let grounding = GroundingEngine::new(Arc::clone(&store), library.clone(), memory_graph);
        let artifacts = StudioArtifactService::new(Arc::clone(&store), library.clone());
        let handoff = Arc::new(VisibleHandoffManager::new());
        let circuit_breaker = Arc::new(AuthChallengeCircuitBreaker::new());
        let share_importer = PublicShareImporter::new(
            Arc::clone(&store),
            library.clone(),
            Arc::clone(&circuit_breaker),
            Arc::clone(&handoff),
            ShareImporterConfig::default(),
        );
        Self {
            store,
            library,
            ingestion,
            preview,
            interactions,
            dispatcher,
            grounding,
            artifacts,
            handoff,
            circuit_breaker,
            share_importer,
        }
    }

    /// Access underlying persistent SQLite store.
    #[must_use]
    pub fn store(&self) -> &NotebookStore {
        &self.store
    }

    /// Access the collision-proof [`SourceLibrary`].
    #[must_use]
    pub fn library(&self) -> &SourceLibrary {
        &self.library
    }

    /// Access the 6-stage [`IngestionEngine`].
    #[must_use]
    pub fn ingestion(&self) -> &IngestionEngine {
        &self.ingestion
    }

    /// Access the 17-format [`RichPreviewService`].
    #[must_use]
    pub fn preview(&self) -> &RichPreviewService {
        &self.preview
    }

    /// Access the `Quote + BTW` & Cross-Bridge [`InteractionService`].
    #[must_use]
    pub fn interactions(&self) -> &InteractionService {
        &self.interactions
    }

    /// Access the true Dual-Queue [`DualQueueDispatcher`].
    #[must_use]
    pub fn dispatcher(&self) -> &DualQueueDispatcher {
        &self.dispatcher
    }

    /// Access the hybrid [`GroundingEngine`].
    #[must_use]
    pub fn grounding(&self) -> &GroundingEngine {
        &self.grounding
    }

    /// Access the [`StudioArtifactService`].
    #[must_use]
    pub fn artifacts(&self) -> &StudioArtifactService {
        &self.artifacts
    }

    /// Access the [`VisibleHandoffManager`] (`MANUAL_VISIBLE_BROWSER_ONLY`).
    #[must_use]
    pub fn handoff_manager(&self) -> &VisibleHandoffManager {
        &self.handoff
    }

    /// Access the zero-retry `429 AUTH_CHALLENGE_REQUIRED` [`AuthChallengeCircuitBreaker`].
    #[must_use]
    pub fn circuit_breaker(&self) -> &AuthChallengeCircuitBreaker {
        &self.circuit_breaker
    }

    /// Access the live public [`PublicShareImporter`].
    #[must_use]
    pub fn share_importer(&self) -> &PublicShareImporter {
        &self.share_importer
    }

    /// Return a consolidated status snapshot for Wave 3 `/api/notebooks/status`.
    pub fn status(&self) -> Result<NotebookEngineStatus, NotebookError> {
        let notebooks = self.store.list_notebooks()?;
        Ok(NotebookEngineStatus {
            crate_name: CRATE_NAME.to_string(),
            timestamp_utc: Utc::now().to_rfc3339(),
            db_path: self.store.db_path().display().to_string(),
            journal_mode: self.store.journal_mode()?,
            fts5_enabled: self.store.fts5_enabled(),
            notebook_count: notebooks.len(),
            circuit_breaker: self.circuit_breaker.snapshot(),
            pending_handoffs: self.handoff.list_pending().len(),
            queues: self.dispatcher.stats(),
        })
    }

    // -------------------------------------------------------------------------
    // Notebook Lifecycle (`/api/notebooks/*`)
    // -------------------------------------------------------------------------

    pub fn create_notebook(
        &self,
        req: CreateNotebookRequest,
    ) -> Result<NotebookRecord, NotebookError> {
        self.library.create_notebook(req)
    }

    pub fn list_notebooks(&self) -> Result<Vec<NotebookRecord>, NotebookError> {
        self.store.list_notebooks()
    }

    pub fn get_notebook(&self, notebook_id: &str) -> Result<NotebookRecord, NotebookError> {
        self.library.require_notebook(notebook_id)
    }

    pub fn delete_notebook(&self, notebook_id: &str) -> Result<bool, NotebookError> {
        self.store.delete_notebook(notebook_id)
    }

    pub fn set_notebook_model_effort(
        &self,
        notebook_id: &str,
        model_id: &str,
        effort: EffortLevel,
    ) -> Result<NotebookRecord, NotebookError> {
        if model_id.trim().is_empty() {
            return Err(NotebookError::InvalidInput(
                "model_id cannot be empty".to_string(),
            ));
        }
        if !self
            .store
            .update_notebook_model_effort(notebook_id, model_id.trim(), effort.as_str())?
        {
            return Err(NotebookError::NotFound {
                entity: "notebook",
                id: notebook_id.to_string(),
            });
        }
        self.library.require_notebook(notebook_id)
    }

    // -------------------------------------------------------------------------
    // Sources, Ingestion, Deduplication, Healing & Preview
    // -------------------------------------------------------------------------

    pub fn ingest_source(
        &self,
        req: IngestSourceRequest,
    ) -> Result<IngestSourceOutcome, NotebookError> {
        self.ingestion.ingest_source(req)
    }

    pub fn ingest_multipart_with_rollback(
        &self,
        notebook_id: &str,
        parts: Vec<IngestSourceRequest>,
    ) -> Result<MultipartIngestOutcome, NotebookError> {
        self.ingestion
            .ingest_multipart_with_rollback(notebook_id, parts)
    }

    pub fn ingest_code_repository(
        &self,
        notebook_id: &str,
        root_dir: &Path,
        title: Option<String>,
        config: &RepoPackageConfig,
    ) -> Result<(IngestSourceOutcome, PackagedRepository), NotebookError> {
        self.ingestion
            .ingest_code_repository(notebook_id, root_dir, title, config)
    }

    pub fn register_source_batch(
        &self,
        notebook_id: &str,
        items: Vec<SourceRegistrationInput>,
    ) -> Result<SourceBatchDedupReport, NotebookError> {
        self.library.register_batch(notebook_id, items)
    }

    pub fn list_sources(
        &self,
        notebook_id: &str,
        filter: &SourceFilter,
    ) -> Result<Vec<SourceRecord>, NotebookError> {
        self.library.list_sources(notebook_id, filter)
    }

    pub fn clear_sources(&self, notebook_id: &str) -> Result<ClearSourcesReceipt, NotebookError> {
        self.library.clear_sources(notebook_id)
    }

    pub fn resolve_citation(
        &self,
        notebook_id: &str,
        reference: &str,
    ) -> Result<ResolvedCitationTarget, NotebookError> {
        self.library.resolve_citation_ref(notebook_id, reference)
    }

    pub fn heal_sources(&self, notebook_id: &str) -> Result<HealSweepReport, NotebookError> {
        self.ingestion.heal_sources(notebook_id)
    }

    pub fn preview_bytes(
        &self,
        filename: &str,
        mime_type: Option<&str>,
        bytes: &[u8],
    ) -> Result<PreviewPayload, NotebookError> {
        self.preview.generate_preview(filename, mime_type, bytes)
    }

    // -------------------------------------------------------------------------
    // Grounded Citation Q&A & Main Chat Turns
    // -------------------------------------------------------------------------

    pub fn build_grounded_prompt(
        &self,
        notebook_id: &str,
        query: &str,
        filter: &SourceFilter,
        max_chunks: usize,
    ) -> Result<GroundedPromptPack, NotebookError> {
        self.grounding
            .build_grounded_pack(notebook_id, query, filter, max_chunks)
    }

    pub fn verify_citations(
        &self,
        notebook_id: &str,
        response_markdown: &str,
    ) -> Result<CitationVerificationReport, NotebookError> {
        self.grounding
            .verify_citations(notebook_id, response_markdown)
    }

    pub fn record_turn(
        &self,
        req: RecordTurnRequest,
    ) -> Result<NotebookTurnRecord, NotebookError> {
        let _ = self.library.require_notebook(&req.notebook_id)?;
        let turn_index = self.store.list_turns(&req.notebook_id)?.len();
        let quote_values: Vec<Value> = req
            .quotes
            .into_iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()?;
        let turn = NotebookTurnRecord {
            turn_id: format!("trn_{}", Uuid::new_v4().simple()),
            notebook_id: req.notebook_id,
            turn_index,
            surface: req.surface.as_str().to_string(),
            role: "assistant".to_string(),
            prompt_text: SecretRedactor::redact(&req.prompt_text),
            response_markdown: SecretRedactor::redact(&req.response_markdown),
            model_id: req.model_id.trim().to_string(),
            effort_level: req.effort.as_str().to_string(),
            quotes: quote_values,
            citations: req.citations,
            created_at_ms: now_epoch_ms(),
        };
        self.store.insert_turn(&turn)?;
        Ok(turn)
    }

    pub fn list_turns(&self, notebook_id: &str) -> Result<Vec<NotebookTurnRecord>, NotebookError> {
        let _ = self.library.require_notebook(notebook_id)?;
        self.store.list_turns(notebook_id)
    }

    // -------------------------------------------------------------------------
    // Studio Artifacts
    // -------------------------------------------------------------------------

    pub fn generate_artifact(
        &self,
        req: GenerateArtifactRequest,
    ) -> Result<StudioArtifactRecord, NotebookError> {
        self.artifacts.generate_artifact(req)
    }

    pub fn list_artifacts(
        &self,
        notebook_id: &str,
    ) -> Result<Vec<StudioArtifactRecord>, NotebookError> {
        self.artifacts.list_artifacts(notebook_id)
    }

    pub fn rename_artifact(
        &self,
        artifact_id: &str,
        new_title: &str,
    ) -> Result<StudioArtifactRecord, NotebookError> {
        self.artifacts.rename_artifact(artifact_id, new_title)
    }

    pub fn delete_artifact(&self, artifact_id: &str) -> Result<bool, NotebookError> {
        self.artifacts.delete_artifact(artifact_id)
    }

    // -------------------------------------------------------------------------
    // Unified `Quote + BTW` (`R11`) & Bidirectional Cross-Bridge (`/api/btw/*`, `/api/bridge`)
    // -------------------------------------------------------------------------

    pub fn create_quote_card(
        &self,
        req: CreateQuoteCardRequest,
    ) -> Result<ComposerQuoteCard, NotebookError> {
        self.interactions.create_quote_card(req)
    }

    pub fn create_btw_thread(
        &self,
        quote: QuoteRef,
        initial_question: &str,
    ) -> Result<BtwThread, NotebookError> {
        self.interactions.create_btw_thread(quote, initial_question)
    }

    pub fn append_btw_message(
        &self,
        btw_id: &str,
        role: &str,
        content: &str,
    ) -> Result<BtwThread, NotebookError> {
        self.interactions.append_btw_message(btw_id, role, content)
    }

    pub fn list_btw_threads(&self, notebook_id: &str) -> Result<Vec<BtwThread>, NotebookError> {
        self.interactions.list_btw_threads(notebook_id)
    }

    pub fn promote_btw_to_source(
        &self,
        btw_id: &str,
        title_override: Option<&str>,
    ) -> Result<PromoteBtwOutcome, NotebookError> {
        self.interactions
            .promote_btw_to_source(btw_id, title_override)
    }

    pub fn bridge_transfer(
        &self,
        req: BridgeTransferRequest,
    ) -> Result<BridgeTransferReceipt, NotebookError> {
        self.interactions.bridge_transfer(req)
    }

    pub fn list_bridge_events(
        &self,
        notebook_id: &str,
    ) -> Result<Vec<StoredBridgeRow>, NotebookError> {
        self.interactions.list_bridge_events(notebook_id)
    }

    // -------------------------------------------------------------------------
    // Dual-Queue Parallel Dispatch & Public Share Importer
    // -------------------------------------------------------------------------

    pub async fn submit_gemini<F, Fut>(
        &self,
        req: DispatchRequest,
        executor: F,
    ) -> Result<DispatchReceipt, NotebookError>
    where
        F: FnOnce(DispatchRequest) -> Fut,
        Fut: Future<Output = Result<(String, Vec<String>, Value), NotebookError>>,
    {
        self.dispatcher.dispatch_gemini(req, executor).await
    }

    pub async fn submit_notebook<F, Fut>(
        &self,
        req: DispatchRequest,
        executor: F,
    ) -> Result<DispatchReceipt, NotebookError>
    where
        F: FnOnce(DispatchRequest) -> Fut,
        Fut: Future<Output = Result<(String, Vec<String>, Value), NotebookError>>,
    {
        self.dispatcher.dispatch_notebook(req, executor).await
    }

    pub fn import_public_share_pages(
        &self,
        notebook_id: &str,
        share_url: &str,
        raw_batchexecute_pages: &[&str],
    ) -> Result<ShareImportOutcome, NotebookError> {
        self.share_importer
            .import_public_share_pages(notebook_id, share_url, raw_batchexecute_pages)
    }

    pub async fn fetch_and_import_public_share(
        &self,
        notebook_id: &str,
        share_url: &str,
    ) -> Result<ShareImportOutcome, NotebookError> {
        self.share_importer
            .fetch_and_import_public_share(notebook_id, share_url)
            .await
    }

    /// Complete an interactive visible-browser handoff ticket and close the circuit breaker.
    pub fn complete_handoff_and_reset(
        &self,
        ticket_id: &str,
    ) -> Result<AuthCircuitSnapshot, NotebookError> {
        let _ = self.handoff.mark_completed(ticket_id)?;
        self.circuit_breaker
            .reset_after_handoff(&self.handoff, ticket_id)
    }
}

/// Streaming multi-slice SHA-256 hex digest helper (zero intermediate concatenation).
#[must_use]
pub fn sha256_slices_hex(slices: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for s in slices {
        hasher.update(s);
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for b in digest {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Canonical host extraction helper for public origin checks.
pub fn parse_canonical_origin(raw_url: &str) -> Result<String, NotebookError> {
    let parsed = Url::parse(raw_url.trim())
        .map_err(|e| NotebookError::InvalidInput(format!("invalid URL: {e}")))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| NotebookError::InvalidInput("URL missing host".to_string()))?;
    Ok(match parsed.port() {
        Some(p) => format!("{}://{host}:{p}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    })
}
