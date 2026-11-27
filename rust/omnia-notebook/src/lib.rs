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
pub mod llm_client;
pub mod policy;
pub mod preview;
pub mod share_import;
pub mod source_library;
pub mod store;
pub mod studio_artifacts;
pub mod whisper_bridge;

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
    inspect_zip_archive_safe, is_likely_binary, normalize_subtitles_to_webvtt,
    normalize_utf8_and_lf, package_code_repository, parse_delimited_table, parse_ipynb_cells,
    read_zip_entries_bounded, render_ipynb_to_markdown, render_sheets_to_markdown,
    render_slides_to_markdown, strip_rtf_to_text, ExtractedNotebookCell, ExtractedSheet,
    ExtractedSlide, HealSweepReport, IngestSourceOutcome, IngestSourceRequest, IngestionEngine,
    IngestionStage, MultipartIngestOutcome, PackagedRepository, PdfClassification,
    PdfExtractionResult, RepoPackageConfig, SafeZipEntry,
};
pub use interactions::{
    build_composer_quote_card, format_multi_quote_prompt, BridgeDirection, BridgeTransferReceipt,
    BridgeTransferRequest, BtwMessage, BtwThread, BtwThreadStatus, ComposerQuoteCard,
    ContextualAskPreset, CreateQuoteCardRequest, InteractionService, InteractionSurface,
    PromoteBtwOutcome, QuoteRef, SelectionAction,
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
pub use llm_client::{
    complete_prompt, extract_json_payload, resolve_notebook_endpoint, NotebookLlmConfig,
    NotebookLlmResponse,
};
pub use share_import::{PublicShareImporter, ShareImportOutcome, ShareImporterConfig};
pub use source_library::{
    ClearSourcesReceipt, CreateNotebookRequest, NotebookRecord, RemoteReconcileReport,
    RemoteSyncItem, ResolvedCitationTarget, SourceBatchDedupReport, SourceChunkRecord,
    SourceFilter, SourceKind, SourceLibrary, SourceRecord, SourceRegistrationInput,
    SourceRegistrationOutcome,
};
pub use store::{
    Bm25ChunkHit, NotebookStore, NotebookTurnRecord, StoredArtifactRow, StoredBridgeRow,
    StoredBtwRow, SyncTombstoneRow,
};
pub use studio_artifacts::{
    GenerateArtifactRequest, StudioArtifactKind, StudioArtifactRecord, StudioArtifactService,
};
pub use whisper_bridge::{
    discover_whisper_runner, transcribe_and_ingest, validate_local_media_path,
    validate_whisper_params, WhisperRunner, WhisperTranscribeOutcome, WhisperTranscribeRequest,
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

/// Real-LLM grounded Q&A turn receipt returned by [`NotebookEngine::ask_notebook_with_llm`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskNotebookOutcome {
    pub turn: NotebookTurnRecord,
    pub pack: GroundedPromptPack,
    pub verification: CitationVerificationReport,
    pub llm_usage: NotebookLlmResponse,
}

/// Real-LLM isolated BTW side-thread turn receipt returned by [`NotebookEngine::ask_btw_with_llm`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskBtwOutcome {
    pub thread: BtwThread,
    pub verification: CitationVerificationReport,
    pub llm_usage: NotebookLlmResponse,
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

    /// Returns a source's metadata, reconstructed textual body across its semantic chunks,
    /// and strict [`PreviewSecurityHeaders`] (`nosniff`, forced `attachment` for HTML/SVG/XML/binary).
    pub fn get_source_content(
        &self,
        notebook_id: &str,
        source_id: &str,
    ) -> Result<(SourceRecord, String, PreviewSecurityHeaders), NotebookError> {
        let _ = self.library.require_notebook(notebook_id)?;
        let Some(src) = self.store.get_source(source_id)? else {
            return Err(NotebookError::NotFound {
                entity: "source",
                id: source_id.to_string(),
            });
        };
        if src.notebook_id != notebook_id {
            return Err(NotebookError::NotFound {
                entity: "source",
                id: source_id.to_string(),
            });
        }
        let chunks = self.store.list_chunks_for_source(source_id)?;
        let mut combined = String::new();
        for (idx, ch) in chunks.iter().enumerate() {
            if idx > 0 {
                combined.push_str("\n\n");
            }
            if !ch.heading.trim().is_empty() {
                combined.push_str("## ");
                combined.push_str(ch.heading.trim());
                combined.push('\n');
            }
            combined.push_str(&ch.body);
        }
        let ext = policy::extract_extension_lower(&src.safe_filename);
        let force_attachment = policy::requires_forced_attachment(&ext, &src.mime_type)
            || matches!(ext.as_str(), "xml" | "xhtml");
        let headers = PreviewSecurityHeaders::for_format(&src.safe_filename, force_attachment);
        Ok((src, SecretRedactor::redact(&combined), headers))
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

    /// Generates a Studio artifact using a REAL configured LLM endpoint with strict citation verification.
    pub async fn generate_artifact_with_llm(
        &self,
        req: GenerateArtifactRequest,
        llm_cfg: &NotebookLlmConfig,
    ) -> Result<StudioArtifactRecord, NotebookError> {
        self.artifacts
            .generate_artifact_with_llm(req, &self.grounding, llm_cfg)
            .await
    }

    /// Executes Grounded Q&A / Chat using a REAL LLM endpoint, verifies `[source_id:chunk_idx]` citations,
    /// and persists the verified main turn into `notebook_turns`.
    pub async fn ask_notebook_with_llm(
        &self,
        notebook_id: &str,
        surface: InteractionSurface,
        query: &str,
        filter: &SourceFilter,
        max_chunks: usize,
        llm_cfg: &NotebookLlmConfig,
    ) -> Result<AskNotebookOutcome, NotebookError> {
        let pack = self.build_grounded_prompt(notebook_id, query, filter, max_chunks)?;
        let llm_resp = complete_prompt(
            llm_cfg,
            &pack.system_instructions,
            &format!("Question: {}\n\n{}", pack.query, pack.assembled_context),
        )
        .await?;
        let verification = self.verify_citations(notebook_id, &llm_resp.text)?;
        let cited_markers: Vec<String> = verification
            .verified_citations
            .iter()
            .map(|c| c.marker.clone())
            .collect();
        let turn = self.record_turn(RecordTurnRequest {
            notebook_id: notebook_id.to_string(),
            surface,
            prompt_text: pack.query.clone(),
            response_markdown: llm_resp.text.clone(),
            model_id: llm_resp.model_id.clone(),
            effort: llm_cfg.effort.unwrap_or(EffortLevel::Medium),
            quotes: Vec::new(),
            citations: cited_markers,
        })?;
        Ok(AskNotebookOutcome {
            turn,
            pack,
            verification,
            llm_usage: llm_resp,
        })
    }

    /// Sends a follow-up question inside an isolated `Quote + BTW` thread using a REAL LLM
    /// without polluting `notebook_turns`.
    pub async fn ask_btw_with_llm(
        &self,
        btw_id: &str,
        question: &str,
        llm_cfg: &NotebookLlmConfig,
    ) -> Result<AskBtwOutcome, NotebookError> {
        let existing = self
            .store
            .get_btw_thread(btw_id)?
            .ok_or_else(|| NotebookError::NotFound {
                entity: "btw_thread",
                id: btw_id.to_string(),
            })?;
        let anchor_quote: QuoteRef = serde_json::from_value(existing.anchor_quote_json.clone())?;
        let _ = self.append_btw_message(btw_id, "user", question)?;
        let pack = self.build_grounded_prompt(
            &existing.notebook_id,
            &format!("{}\n{}", anchor_quote.excerpt, question),
            &SourceFilter::default(),
            6,
        )?;
        let user_prompt = format!(
            "Anchored excerpt: \"{}\"\n\nFollow-up BTW question: {}\n\nGrounded context:\n{}",
            anchor_quote.excerpt, question, pack.assembled_context
        );
        let llm_resp =
            complete_prompt(llm_cfg, &pack.system_instructions, &user_prompt).await?;
        let verification =
            self.verify_citations(&existing.notebook_id, &llm_resp.text)?;
        let updated_thread =
            self.append_btw_message(btw_id, "assistant", &llm_resp.text)?;
        Ok(AskBtwOutcome {
            thread: updated_thread,
            verification,
            llm_usage: llm_resp,
        })
    }

    /// Deletes one source while recording a durable tombstone so sync never resurrects it.
    pub fn delete_source(
        &self,
        notebook_id: &str,
        source_id_or_remote: &str,
        reason: Option<&str>,
    ) -> Result<Option<SyncTombstoneRow>, NotebookError> {
        self.library
            .delete_source(notebook_id, source_id_or_remote, reason)
    }

    /// Lists active sync tombstones for `notebook_id`.
    pub fn list_tombstones(
        &self,
        notebook_id: &str,
    ) -> Result<Vec<SyncTombstoneRow>, NotebookError> {
        let _ = self.library.require_notebook(notebook_id)?;
        self.store.list_tombstones(notebook_id)
    }

    /// Clears a tombstone key if the user explicitly re-adds the source.
    pub fn clear_tombstone(
        &self,
        notebook_id: &str,
        tombstone_key: &str,
    ) -> Result<bool, NotebookError> {
        let _ = self.library.require_notebook(notebook_id)?;
        self.store.clear_tombstone(notebook_id, tombstone_key)
    }

    /// Performs tombstone-safe remote sync reconciliation (`sourceLibrary.js` / `syncService.js`).
    pub fn reconcile_remote_sources(
        &self,
        notebook_id: &str,
        remote_items: &[RemoteSyncItem],
        remote_snapshot_complete: bool,
    ) -> Result<RemoteReconcileReport, NotebookError> {
        self.library
            .reconcile_remote_sources(notebook_id, remote_items, remote_snapshot_complete)
    }

    /// Runs offline Whisper / faster-whisper transcription and ingests the resulting Markdown transcript.
    pub async fn transcribe_and_ingest_media(
        &self,
        req: WhisperTranscribeRequest,
    ) -> Result<WhisperTranscribeOutcome, NotebookError> {
        transcribe_and_ingest(self, req).await
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

#[cfg(test)]
mod v5_tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn real_llm_grounded_qa_btw_and_all_9_atelier_artifacts_and_tombstones() {
        let engine = NotebookEngine::open_in_memory().expect("open engine");
        let nb = engine
            .create_notebook(CreateNotebookRequest {
                title: "Atelier v5 Real LLM".to_string(),
                description: "Real LLM synthesis & tombstones".to_string(),
                max_sources: 16,
                allow_overflow_notebook: false,
                model_id: "gpt-fixture".to_string(),
                effort_level: "high".to_string(),
            })
            .expect("create nb");
        let nb_id = nb.notebook_id;

        let s1 = engine
            .ingest_source(IngestSourceRequest {
                notebook_id: nb_id.clone(),
                title: Some("Storage Architecture".to_string()),
                filename: "storage.md".to_string(),
                mime_type: None,
                remote_id: Some("rem_storage_01".to_string()),
                bytes: b"# WAL Storage\nOmnia uses winsqlite3 WAL locking and SHA-256 content addressing.\n# Chunk Two\nEvery citation binds to an immutable source_id and chunk_idx."
                    .to_vec(),
                copied_text_fallback: None,
                max_chunk_bytes: None,
                metadata: json!({}),
            })
            .expect("ingest s1")
            .source;
        let sid = s1.source_id.clone();

        // Start a mock OpenAI HTTP server responding to 11 calls (Ask + BTW + 9 Studio v5 artifacts)
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let sid_srv = sid.clone();
        let srv = tokio::spawn(async move {
            for idx in 0..12usize {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = [0u8; 8192];
                let _ = sock.read(&mut buf).await;
                let content = format!(
                    "## Synthesis #{idx}\nGrounded finding citing [{sid_srv}:0].\n```json\n{{\"artifact_call\": {idx}, \"verified_cite\": \"[{sid_srv}:0]\"}}\n```"
                );
                let body = serde_json::json!({
                    "id": format!("chatcmpl-v5-{idx}"),
                    "choices": [{ "message": { "role": "assistant", "content": content } }],
                    "usage": { "prompt_tokens": 100, "completion_tokens": 45 }
                })
                .to_string();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });

        let llm_cfg = NotebookLlmConfig {
            model_spec: "openai/gpt-fixture".to_string(),
            config_dir: None,
            api_base_override: Some(format!("http://{addr}/v1")),
            api_key_override: Some("sk-dummy-atelier-fixture-12345".to_string()),
            wire_api_override: Some("openai-completions".to_string()),
            effort: Some(EffortLevel::High),
            temperature: 0.2,
            max_tokens: 2048,
            allow_loopback_endpoints: true,
        };

        // 1. Real LLM Grounded Q&A
        let ask = engine
            .ask_notebook_with_llm(
                &nb_id,
                InteractionSurface::Notebook,
                "How does Omnia bind citations in WAL storage?",
                &SourceFilter::default(),
                4,
                &llm_cfg,
            )
            .await
            .expect("ask real llm");
        assert!(ask.verification.valid);
        assert_eq!(ask.verification.verified_citations.len(), 1);
        assert_eq!(engine.list_turns(&nb_id).expect("turns").len(), 1);

        // 2. Real LLM Quote + BTW without polluting main turns
        let quote = engine
            .create_quote_card(CreateQuoteCardRequest {
                notebook_id: nb_id.clone(),
                surface: InteractionSurface::Notebook,
                anchor_turn_id: ask.turn.turn_id.clone(),
                source_id: Some(sid.clone()),
                excerpt: "winsqlite3 WAL locking".to_string(),
                char_start: 0,
                char_end: 22,
            })
            .expect("quote card");
        let btw = engine
            .create_btw_thread(quote.quote, "Does it use LockFileEx?")
            .expect("btw thread");
        let btw_ans = engine
            .ask_btw_with_llm(&btw.btw_id, "Confirm lease lock mechanism.", &llm_cfg)
            .await
            .expect("ask btw real llm");
        assert_eq!(btw_ans.thread.messages.len(), 3);
        assert_eq!(engine.list_turns(&nb_id).expect("still 1 main turn").len(), 1);

        // 3. ALL 9 Atelier Studio v5 Artifacts generated via REAL LLM
        let v5_kinds = [
            StudioArtifactKind::AudioOverview,
            StudioArtifactKind::MindMap,
            StudioArtifactKind::Flashcards,
            StudioArtifactKind::Quiz,
            StudioArtifactKind::SlideDeck,
            StudioArtifactKind::DataTable,
            StudioArtifactKind::InfographicSpec,
            StudioArtifactKind::Briefing,
            StudioArtifactKind::StudyGuide,
        ];
        for kind in v5_kinds {
            let art = engine
                .generate_artifact_with_llm(
                    GenerateArtifactRequest {
                        notebook_id: nb_id.clone(),
                        kind,
                        title: None,
                        source_ids: None,
                        focus_prompt: Some("WAL locks and provenance".to_string()),
                    },
                    &llm_cfg,
                )
                .await
                .expect("llm artifact");
            assert_eq!(art.structured_json["generated_by"], "real_llm");
            assert_eq!(art.cited_source_ids, vec![sid.clone()]);
        }

        // 4. Tombstone-safe delete prevents remote sync resurrection
        let tomb = engine
            .delete_source(&nb_id, &sid, Some("user_removed"))
            .expect("delete")
            .expect("tombstone recorded");
        assert_eq!(tomb.remote_id.as_deref(), Some("rem_storage_01"));
        let reconcile = engine
            .reconcile_remote_sources(
                &nb_id,
                &[RemoteSyncItem {
                    remote_id: "rem_storage_01".to_string(),
                    title: Some("Storage Architecture".to_string()),
                    content_sha256: Some(s1.content_sha256.clone()),
                }],
                true,
            )
            .expect("reconcile");
        assert_eq!(reconcile.suppressed_tombstoned_ids, vec!["rem_storage_01"]);
        assert!(reconcile.active_sources.is_empty());

        srv.abort();
    }

    #[test]
    fn effort_xhigh_max_subtitles_webvtt_and_source_content_headers() {
        assert_eq!(EffortLevel::parse_strict("xhigh").unwrap(), EffortLevel::XHigh);
        assert_eq!(EffortLevel::parse_strict("max").unwrap(), EffortLevel::Max);

        let srt = "1\n00:00:01,500 --> 00:00:03,250\nHello Omnia\n";
        let vtt = normalize_subtitles_to_webvtt(srt);
        assert!(vtt.starts_with("WEBVTT"));
        assert!(vtt.contains("00:00:01.500 --> 00:00:03.250"));

        let json3 = r#"{"events":[{"tStartMs":1000,"dDurationMs":2000,"segs":[{"utf8":"Hi"}]}]}"#;
        assert!(normalize_subtitles_to_webvtt(json3).contains("00:00:01.000 --> 00:00:03.000"));

        let eng = NotebookEngine::open_in_memory().unwrap();
        let nb = eng
            .create_notebook(CreateNotebookRequest {
                title: "Content Header Test".into(),
                description: "".into(),
                allow_overflow_notebook: false,
                max_sources: 10,
                model_id: "gemini-3.5-flash-lite".into(),
                effort_level: "max".into(),
            })
            .unwrap();
        let out = eng
            .ingest_source(IngestSourceRequest {
                notebook_id: nb.notebook_id.clone(),
                title: Some("Unsafe Page".into()),
                filename: "page.html".into(),
                mime_type: Some("text/html".into()),
                remote_id: None,
                bytes: b"<html><body><h1>Title</h1><p>Body text</p></body></html>".to_vec(),
                copied_text_fallback: None,
                max_chunk_bytes: None,
                metadata: serde_json::json!({}),
            })
            .unwrap();
        let (_src, body, sec) = eng
            .get_source_content(&nb.notebook_id, &out.source.source_id)
            .unwrap();
        assert!(body.contains("Title"));
        assert_eq!(sec.x_content_type_options, "nosniff");
        assert!(sec.force_attachment);
    }
}
