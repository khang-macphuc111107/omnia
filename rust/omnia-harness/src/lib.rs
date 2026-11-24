#![forbid(unsafe_code)]

//! Omnia agent harness: cyclic-safe memory graph with erasure proofs, bilingual
//! EN/VN proactive RAG, skill registry, scientific/multimodal prompt composer, and
//! zero-drop additive steer queue.

pub mod composer_model;
pub mod memory_graph;
pub mod proactive_rag;
pub mod rich_composer;
pub mod skill_registry;
pub mod steer_queue;

pub use composer_model::{
    AttachmentPlacement, ComposerAttachment, ComposerModel, PasteDecisionResult, PdfInspection,
    SymbolTemplate,
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
