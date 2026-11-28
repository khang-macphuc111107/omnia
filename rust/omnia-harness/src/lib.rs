#![forbid(unsafe_code)]

//! Omnia agent harness: cyclic-safe memory graph with erasure proofs, bilingual
//! EN/VN proactive RAG, persistent dual-tier Deep Research Vault, Deep Think engine,
//! 12-Artifact Proactive Lifecycle OS, skill registry with Cold Vault + 24 DAG pipelines,
//! scientific/multimodal prompt composer, and zero-drop additive steer queue.

pub mod artifact_os;
pub mod composer_model;
pub mod deep_think;
pub mod m2v_router;
pub mod memory_graph;
pub mod proactive_rag;
pub mod research_vault;
pub mod rich_composer;
pub mod skill_registry;
pub mod steer_queue;

pub use artifact_os::{
    evaluate_session_admission_gates, sync_global_lessons, sync_global_lessons_report,
    sync_global_lessons_with_paths, validate_no_proto_pollution, verify_artifact_content,
    wcag_contrast_ratio, ArtifactKind, ArtifactLink, ArtifactOs, ArtifactVerifyReport,
    GlobalLessonsSyncReport, LessonRecord, LifecycleArtifact, LinkRelation,
    SessionAdmissionEvalInput, SessionAdmissionGateStatus, SessionAdmissionReport, SixStateReceipt,
    SuperWorkflowState, DEFAULT_AGY_GLOBAL_LESSONS_PATH, DEFAULT_GLOBAL_MEMORY_DIR,
    GLOBAL_LESSONS_CAP, REQUIRED_SESSION_GATE_IDS,
};
pub use composer_model::{
    AttachmentPlacement, ComposerAttachment, ComposerModel, PasteDecisionResult, PdfInspection,
    SymbolTemplate,
};
pub use deep_think::{
    model_vendor_family, rejected_alternatives_matrix, scan_lean_source_for_axioms_and_sorry,
    AaronsonSignCheck, AaronsonSignId, AxiomFootprintAudit, BranchKind, DeepThinkEngine,
    DeepThinkSession, EpistemicBand, EpistemicBucket, EscalationState, FormalProofAudit,
    MultiKernelReplayCheck, RedTeamChallenge, ThinkBranch, STANDARD_FOUNDATIONAL_AXIOMS,
};
pub use m2v_router::{
    compose_vn_nfc, discover_m2v_model_dir, piece_hashes, rrf_fuse_ranks, M2vSeekEngine,
    M2vSkillHit, DEFAULT_M2V_MODEL_DIR, M2V_DIM, OMNIA_DATA_M2V_MODEL_DIR,
};
pub use memory_graph::{
    detect_asi06_injection_taint, extract_entities, is_valid_key, is_valid_namespace,
    parse_wiki_links, strip_anti_feedback_tags, ErasureReceipt, MemoryEdge, MemoryEntry,
    MemoryError, MemoryGraph, MemoryKind, MemoryProvenance, MemoryScope, MemoryTier,
    MemoryTraversalResult,
};
pub use omnia_core::{
    detect_unaccented_vietnamese_collision, encapsulate_data_plane_record,
    extract_protected_spans, restore_protected_spans, restore_vietnamese_contextual,
    verify_translation_invariants, AmbiguousTokenNote, AppliedNormalizationNote, DataPlaneRecord,
    ProtectedSpan, ProtectedSpanExtraction, ProtectedSpanKind, TranslationInvariantReport,
    UnaccentedVietnameseDetection, VietnameseRestorationResult, DATA_PLANE_SCHEMA_MODE,
};
pub use proactive_rag::{
    fold_vietnamese_ascii, has_vietnamese_diacritics, tokenize_folded, CorpusSource,
    GroundedEvidenceItem, ProactiveRag, ProactiveRagResult, RagSubQuery, SourceProvenance,
    UnusedSourceNote,
};
pub use research_vault::{
    atomic_write_with_retry, bounded_head_tail_text, build_local_file_anchor_url,
    build_text_fragment_url, classify_http_fetch_error, format_inline_citation_badge,
    html_to_clean_markdown, levenshtein_bounded, percent_encode_text_fragment,
    sanitize_quote_for_text_fragment, unwrap_canonical_redirect_url,
    verify_citations_against_sources, BrokenCitationRef, CitationOrphanClaim,
    CitationSourceSnapshot, CitationVerificationReport, EvidenceGrade, FabricatedMetricIssue,
    FetchErrorKind, RagChunkHit, ResearchClaim, ResearchSourceRecord, ResearchVault, SourceStage,
    SourcesLedgerSummary, StructuredTableResult, VaultTier, DEFAULT_GLOBAL_VAULT_DIR,
};
pub use rich_composer::{
    search_symbol_palette, symbol_palette, AttachmentChoice, AttachmentMediaKind,
    AttachmentPayload, BlockFormat, ComposerNode, ComposerTable, ConversionStatus,
    DerivedRepresentation, DocumentAnchor, DropIndicator, DropZone, IncomingAttachment,
    LivePreviewOutput, PendingPastePrompt, RichComposer, SendReadiness, SerializedComposerTurn,
    SymbolPaletteItem, TextStyle, TrayAttachmentRef, UploadManifestEntry, WireBlock, WireMessage,
};
pub use skill_registry::{
    resolve_skill_alias, CodifySkillRequest, ColdVaultEntry, ExecutionDagStage, GapRadarRecord,
    HybridSkillMatch, OpenAiSkillInterface, PipelineSpec, SkillDoctorReport, SkillError,
    SkillLoadReport, SkillMatch, SkillMetadata, SkillRegistry, DEFAULT_COLD_VAULT_PATHS,
};
pub use steer_queue::{SteerItem, SteerMode, SteerQueue, SteerStatus};
