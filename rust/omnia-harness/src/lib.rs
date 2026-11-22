#![forbid(unsafe_code)]

//! Omnia agent harness: cyclic-safe memory graph with erasure proofs, bilingual
//! EN/VN proactive RAG, skill registry, scientific/multimodal prompt composer, and
//! zero-drop additive steer queue.

pub mod composer_model;
pub mod contract_verifier;
pub mod memory_graph;
pub mod proactive_rag;
pub mod prompt_pipeline;
pub mod rich_composer;
pub mod skill_registry;
pub mod steer_queue;

pub use composer_model::{
    AttachmentPlacement, ComposerAttachment, ComposerModel, PasteDecisionResult, PdfInspection,
    SymbolTemplate,
};
pub use contract_verifier::{
    compute_line_hash4, format_hash_anchored_slice, hmac_sha256_bytes, hmac_sha256_hex,
    parse_hash_anchored_slice, prune_failed_attempts, scan_source_for_slop, sign_execution_receipt,
    sign_execution_receipt_digests, validate_shadow_git_index, verify_execution_receipt,
    verify_hash_anchored_edit, AnchorInput, AttemptOutcome, AttemptTurn, CompactedErrorReceipt,
    ContractError, ExecutionReceipt, HashAnchor, HashAnchorVerificationResult, PruneAttemptsResult,
    ShadowGitIndexReceipt, SlopFinding, SlopKind, SlopLanguage, SlopScanReport,
    DEFAULT_MAX_CONSECUTIVE_FAILURES,
};
pub use memory_graph::{
    is_valid_key, is_valid_namespace, parse_wiki_links, ErasureReceipt, MemoryEdge, MemoryEntry,
    MemoryError, MemoryGraph, MemoryTier, MemoryTraversalResult,
};
pub use proactive_rag::{
    fold_vietnamese_ascii, has_vietnamese_diacritics, tokenize_folded, CorpusSource,
    GroundedEvidenceItem, ProactiveRag, ProactiveRagResult, RagSubQuery, SourceProvenance,
    UnusedSourceNote,
};
pub use prompt_pipeline::{
    detect_unaccented_vietnamese_collision, encapsulate_data_plane_record, extract_protected_spans,
    restore_protected_spans, restore_vietnamese_contextual, verify_translation_invariants,
    AmbiguousTokenNote, AppliedNormalizationNote, DataPlaneRecord, ProtectedSpan,
    ProtectedSpanExtraction, ProtectedSpanKind, TranslationInvariantReport,
    UnaccentedVietnameseDetection, VietnameseRestorationResult, DATA_PLANE_SCHEMA_MODE,
};
pub use rich_composer::{
    search_symbol_palette, symbol_palette, AttachmentChoice, AttachmentMediaKind,
    AttachmentPayload, BlockFormat, ComposerNode, ComposerTable, ConversionStatus,
    DerivedRepresentation, DocumentAnchor, DropIndicator, DropZone, IncomingAttachment,
    LivePreviewOutput, PendingPastePrompt, RichComposer, SendReadiness, SerializedComposerTurn,
    SymbolPaletteItem, TextStyle, TrayAttachmentRef, UploadManifestEntry, WireBlock, WireMessage,
};
pub use skill_registry::{
    OpenAiSkillInterface, SkillError, SkillLoadReport, SkillMatch, SkillMetadata, SkillRegistry,
};
pub use steer_queue::{SteerItem, SteerMode, SteerQueue, SteerStatus};
