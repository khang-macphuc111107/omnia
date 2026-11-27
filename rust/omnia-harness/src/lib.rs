#![forbid(unsafe_code)]

//! Omnia agent harness: cyclic-safe memory graph with erasure proofs, bilingual
//! EN/VN proactive RAG, persistent dual-tier Deep Research Vault, Deep Think engine,
//! 12-Artifact Proactive Lifecycle OS, skill registry with Cold Vault + 24 DAG pipelines,
//! scientific/multimodal prompt composer, and zero-drop additive steer queue.

pub mod artifact_os;
pub mod composer_model;
pub mod deep_think;
pub mod memory_graph;
pub mod proactive_rag;
pub mod research_vault;
pub mod rich_composer;
pub mod skill_registry;
pub mod steer_queue;

pub use artifact_os::{
    validate_no_proto_pollution, verify_artifact_content, wcag_contrast_ratio, ArtifactKind,
    ArtifactLink, ArtifactOs, ArtifactVerifyReport, LessonRecord, LifecycleArtifact, LinkRelation,
    SixStateReceipt, SuperWorkflowState, DEFAULT_GLOBAL_MEMORY_DIR,
};
pub use composer_model::{
    AttachmentPlacement, ComposerAttachment, ComposerModel, PasteDecisionResult, PdfInspection,
    SymbolTemplate,
};
pub use deep_think::{
    model_vendor_family, rejected_alternatives_matrix, BranchKind, DeepThinkEngine,
    DeepThinkSession, EpistemicBand, EscalationState, RedTeamChallenge, ThinkBranch,
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
    atomic_write_with_retry, bounded_head_tail_text, classify_http_fetch_error,
    html_to_clean_markdown, levenshtein_bounded, unwrap_canonical_redirect_url, EvidenceGrade,
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
    resolve_skill_alias, CodifySkillRequest, ColdVaultEntry, ExecutionDagStage,
    OpenAiSkillInterface, PipelineSpec, SkillDoctorReport, SkillError, SkillLoadReport,
    SkillMatch, SkillMetadata, SkillRegistry, DEFAULT_COLD_VAULT_PATHS,
};
pub use steer_queue::{SteerItem, SteerMode, SteerQueue, SteerStatus};
