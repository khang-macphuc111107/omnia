//! Hybrid Grounded Citation Q&A Engine combining SQLite `notebook_chunks` BM25F,
//! `omnia-harness::{ProactiveRag, MemoryGraph}`, and `omnia-graph::GraphifyIndex` provenance.
//!
//! Enforces strict inline `[source_id:chunk_idx]` citation markers and rejects hallucinated or
//! ambiguous duplicate-title references.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, OnceLock};

use omnia_core::{now_epoch_ms, SecretRedactor};
use omnia_graph::{
    GraphifyEdge, GraphifyEntity, GraphifyEntityKind, GraphifyIndex, GraphifyProvenance,
};
use omnia_harness::{
    CorpusSource, MemoryGraph, MemoryTier, ProactiveRag, ProactiveRagResult, SourceProvenance,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::NotebookError;
use crate::source_library::{SourceFilter, SourceLibrary};
use crate::store::{Bm25ChunkHit, NotebookStore};

/// One ranked grounded chunk inside a [`GroundedPromptPack`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroundedChunkEvidence {
    /// Strict inline citation marker formatted as `[source_id:chunk_idx]`.
    pub citation_marker: String,
    pub source_id: String,
    pub source_title: String,
    pub chunk_idx: usize,
    pub heading: String,
    pub excerpt: String,
    pub bm25f_score: f64,
    pub rag_relevance_bps: u32,
    pub hybrid_score: f64,
    pub provenance: String,
    pub matched_terms: Vec<String>,
}

/// Complete hybrid grounded prompt package (`GroundedPromptPack` public Wave 3 contract).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroundedPromptPack {
    pub notebook_id: String,
    pub query: String,
    pub language: String,
    pub system_instructions: String,
    pub assembled_context: String,
    pub evidence: Vec<GroundedChunkEvidence>,
    pub proactive_rag: Value,
    pub memory_links: Vec<String>,
    pub graphify_entity_count: usize,
}

/// Verified inline citation hit inside a model response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifiedCitationRef {
    pub marker: String,
    pub source_id: String,
    pub chunk_idx: usize,
    pub source_title: String,
}

/// Invalid/hallucinated inline citation found inside a model response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvalidCitationRef {
    pub marker: String,
    pub reason: String,
}

/// Ambiguous duplicate-title reference detected inside a model response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AmbiguousCitationWarning {
    pub raw_reference: String,
    pub matching_source_ids: Vec<String>,
}

/// Strict citation audit emitted by [`GroundingEngine::verify_citations`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CitationVerificationReport {
    pub notebook_id: String,
    pub valid: bool,
    pub verified_citations: Vec<VerifiedCitationRef>,
    pub invalid_citations: Vec<InvalidCitationRef>,
    pub ambiguous_references: Vec<AmbiguousCitationWarning>,
    pub unique_cited_sources: Vec<String>,
}

/// Hybrid Grounding Engine wiring SQLite BM25F + `ProactiveRag` + `MemoryGraph` + `GraphifyIndex`.
#[derive(Debug)]
pub struct GroundingEngine {
    store: Arc<NotebookStore>,
    library: SourceLibrary,
    memory_graph: Arc<MemoryGraph>,
}

impl GroundingEngine {
    #[must_use]
    pub fn new(
        store: Arc<NotebookStore>,
        library: SourceLibrary,
        memory_graph: Arc<MemoryGraph>,
    ) -> Self {
        Self {
            store,
            library,
            memory_graph,
        }
    }

    /// Expose shared `MemoryGraph` provenance store.
    #[must_use]
    pub fn memory_graph(&self) -> Arc<MemoryGraph> {
        Arc::clone(&self.memory_graph)
    }

    /// Build a citation-grounded context pack by combining SQLite BM25F chunk retrieval with
    /// `omnia-harness::ProactiveRag` uncertainty/relevance scoring and recording provenance in
    /// `omnia-harness::MemoryGraph` and `omnia-graph::GraphifyIndex`.
    pub fn build_grounded_pack(
        &self,
        notebook_id: &str,
        query: &str,
        filter: &SourceFilter,
        max_chunks: usize,
    ) -> Result<GroundedPromptPack, NotebookError> {
        let notebook = self.library.require_notebook(notebook_id)?;
        let clean_query = SecretRedactor::redact(query.trim());
        if clean_query.is_empty() {
            return Err(NotebookError::InvalidInput(
                "grounded query cannot be empty".to_string(),
            ));
        }
        let limit = max_chunks.clamp(1, 24);

        // 1. Primary SQLite BM25F retrieval across `notebook_chunks`.
        let bm25_hits: Vec<Bm25ChunkHit> = self.store.search_chunks_bm25f(
            notebook_id,
            &clean_query,
            filter,
            limit.saturating_mul(2),
        )?;

        // 2. Wire `omnia-harness::ProactiveRag` over retrieved chunks so bilingual EN/VN
        //    uncertainty scoring and provenance filtering enrich hybrid ranking.
        let rag = ProactiveRag::new();
        for hit in &bm25_hits {
            rag.add_source(CorpusSource {
                id: format!("{}:{}", hit.chunk.source_id, hit.chunk.chunk_idx),
                title: hit.source_title.clone(),
                locator: format!("notebook://{}/{}#{}", notebook_id, hit.chunk.source_id, hit.chunk.chunk_idx),
                content: hit.chunk.body.clone(),
                keywords: hit.matched_terms.clone(),
                provenance: parse_source_provenance(&hit.source_provenance),
                is_superseded: false,
                freshness_label: "current".to_string(),
            });
        }
        let rag_result: ProactiveRagResult = rag.plan_and_retrieve(&clean_query, limit);
        let rag_bps_by_id: BTreeMap<String, u32> = rag_result
            .cited_sources
            .iter()
            .map(|item| (item.source_id.clone(), item.relevance_bps))
            .collect();

        // 3. Fuse BM25F + ProactiveRag scores and record provenance in MemoryGraph + GraphifyIndex.
        let ns = format!("notebooks/{}", sanitize_memory_segment(notebook_id));
        let mut memory_links = Vec::new();
        let mut evidence = Vec::new();
        let now = now_epoch_ms();

        // Build a bounded per-query provenance graph (zero unbounded cross-query memory growth).
        let graphify = GraphifyIndex::new();
        {
            let nb_entity_id = format!("notebook:{notebook_id}");
            let _ = graphify.upsert_entity(GraphifyEntity {
                id: nb_entity_id.clone(),
                kind: GraphifyEntityKind::Artifact,
                label: notebook.title.clone(),
                source_path: format!("notebook://{notebook_id}"),
                symbol_span: None,
            });

            for hit in bm25_hits.into_iter().take(limit) {
                let marker_key = format!("{}:{}", hit.chunk.source_id, hit.chunk.chunk_idx);
                let citation_marker = format!("[{marker_key}]");
                let rag_bps = *rag_bps_by_id.get(&marker_key).unwrap_or(&0);
                let hybrid_score = hit.bm25f_score + (f64::from(rag_bps) / 10_000.0);

                let excerpt = excerpt_snippet(&hit.chunk.body, 420);

                // Record Graphify entity + edge for deterministic provenance traversal.
                let chunk_entity_id = format!("chunk:{marker_key}");
                let chunk_locator = format!(
                    "notebook://{notebook_id}/{}#chunk-{}",
                    hit.chunk.source_id, hit.chunk.chunk_idx
                );
                let _ = graphify.upsert_entity(GraphifyEntity {
                    id: chunk_entity_id.clone(),
                    kind: GraphifyEntityKind::Artifact,
                    label: format!("{} ({})", hit.source_title, citation_marker),
                    source_path: format!("notebook://{notebook_id}/{}", hit.chunk.source_id),
                    symbol_span: Some(format!("chunk:{}", hit.chunk.chunk_idx)),
                });
                let _ = graphify.add_edge(GraphifyEdge {
                    from_id: nb_entity_id.clone(),
                    to_id: chunk_entity_id,
                    relation: "grounded_evidence".to_string(),
                    provenance: GraphifyProvenance::Extracted,
                    confidence_bps: GraphifyProvenance::Extracted.default_confidence_bps(),
                    source_locator: chunk_locator,
                });

                // Record durable provenance node in `omnia-harness::MemoryGraph`.
                let mem_key = format!(
                    "src_{}_c{}",
                    sanitize_memory_segment(&hit.chunk.source_id),
                    hit.chunk.chunk_idx
                );
                let mem_key_trimmed: String = mem_key.chars().take(64).collect();
                if let Ok(entry) = self.memory_graph.upsert(
                    &ns,
                    &mem_key_trimmed,
                    MemoryTier::Durable,
                    &format!("{} {}", citation_marker, excerpt),
                    &[],
                    Some(now),
                ) {
                    memory_links.push(entry.id);
                }

                evidence.push(GroundedChunkEvidence {
                    citation_marker,
                    source_id: hit.chunk.source_id,
                    source_title: hit.source_title,
                    chunk_idx: hit.chunk.chunk_idx,
                    heading: hit.chunk.heading,
                    excerpt,
                    bm25f_score: hit.bm25f_score,
                    rag_relevance_bps: rag_bps,
                    hybrid_score,
                    provenance: hit.source_provenance,
                    matched_terms: hit.matched_terms,
                });
            }
        }

        evidence.sort_by(|a, b| {
            b.hybrid_score
                .total_cmp(&a.hybrid_score)
                .then_with(|| a.source_id.cmp(&b.source_id))
                .then_with(|| a.chunk_idx.cmp(&b.chunk_idx))
        });

        let assembled_context = if evidence.is_empty() {
            "No matching notebook chunks were retrieved for this query.".to_string()
        } else {
            evidence
                .iter()
                .map(|ev| {
                    format!(
                        "### {} {} — {}\n{}",
                        ev.citation_marker, ev.source_title, ev.heading, ev.excerpt
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        };

        let mut system_instructions = "Answer strictly from the grounded notebook evidence below. \
Every factual claim MUST carry an exact inline `[source_id:chunk_idx]` citation marker matching one of the provided evidence headers. \
NEVER cite by ambiguous document title alone and NEVER fabricate source IDs or chunk indices."
            .to_string();

        if let Ok(settings) = self.store.get_chat_settings(notebook_id) {
            match settings.mode.as_str() {
                "learning" => {
                    system_instructions.push_str(
                        "\n\nMode (Learning Guide): Explain concepts progressively, highlight key terms, and include brief self-check questions grounded in the cited passages.",
                    );
                }
                "custom" if !settings.custom_prompt.trim().is_empty() => {
                    system_instructions.push_str("\n\nCustom Notebook Instructions:\n");
                    system_instructions.push_str(settings.custom_prompt.trim());
                }
                _ => {}
            }
            match settings.length.as_str() {
                "shorter" => {
                    system_instructions.push_str(
                        "\n\nResponse Length: Keep the answer concise and high-density while preserving every required citation.",
                    );
                }
                "longer" => {
                    system_instructions.push_str(
                        "\n\nResponse Length: Provide a thorough, deeply detailed multi-section analysis grounded in the cited passages.",
                    );
                }
                _ => {}
            }
        }

        let graphify_entity_count = graphify.entities().map(|v| v.len()).unwrap_or(0);

        Ok(GroundedPromptPack {
            notebook_id: notebook_id.to_string(),
            query: clean_query,
            language: rag_result.language.clone(),
            system_instructions,
            assembled_context,
            evidence,
            proactive_rag: rag_result.to_json(),
            memory_links,
            graphify_entity_count,
        })
    }

    /// Verify every inline `[source_id:chunk_idx]` citation in a generated answer against SQLite,
    /// rejecting hallucinated IDs, out-of-range chunks, and ambiguous duplicate-title citations.
    pub fn verify_citations(
        &self,
        notebook_id: &str,
        response_markdown: &str,
    ) -> Result<CitationVerificationReport, NotebookError> {
        static MARKER_RE: OnceLock<Regex> = OnceLock::new();
        static BRACKET_RE: OnceLock<Regex> = OnceLock::new();
        let _ = self.library.require_notebook(notebook_id)?;
        let marker_re = MARKER_RE.get_or_init(|| {
            Regex::new(r"\[([A-Za-z0-9_.-]+):(\d+)\]").expect("valid static citation marker regex")
        });
        let bracket_re = BRACKET_RE.get_or_init(|| {
            Regex::new(r"\[([^\[\]\n]{2,120})\]").expect("valid static bracket regex")
        });

        let mut verified = Vec::new();
        let mut invalid = Vec::new();
        let mut ambiguous = Vec::new();
        let mut seen_markers = BTreeSet::new();
        let mut unique_sources = BTreeSet::new();

        for cap in marker_re.captures_iter(response_markdown) {
            let full = cap[0].to_string();
            if !seen_markers.insert(full.clone()) {
                continue;
            }
            let raw_id = &cap[1];
            let chunk_idx = match cap[2].parse::<usize>() {
                Ok(n) => n,
                Err(_) => {
                    invalid.push(InvalidCitationRef {
                        marker: full,
                        reason: "chunk index out of range".to_string(),
                    });
                    continue;
                }
            };

            let Some(source) = self.store.find_source_by_id_or_remote(notebook_id, raw_id)? else {
                invalid.push(InvalidCitationRef {
                    marker: full,
                    reason: format!("unknown source_id '{raw_id}' in notebook '{notebook_id}'"),
                });
                continue;
            };

            let Some(_chunk) = self
                .store
                .get_chunk(notebook_id, &source.source_id, chunk_idx)?
            else {
                invalid.push(InvalidCitationRef {
                    marker: full,
                    reason: format!(
                        "chunk index {chunk_idx} does not exist for source '{}'",
                        source.source_id
                    ),
                });
                continue;
            };

            unique_sources.insert(source.source_id.clone());
            verified.push(VerifiedCitationRef {
                marker: full,
                source_id: source.source_id,
                chunk_idx,
                source_title: source.title,
            });
        }

        // Detect bracketed title-only citations that collide with duplicate titles.
        let mut checked_titles = BTreeSet::new();
        for cap in bracket_re.captures_iter(response_markdown) {
            let inner = cap[1].trim();
            if marker_re.is_match(&cap[0]) || inner.starts_with("http") || !checked_titles.insert(inner.to_string()) {
                continue;
            }
            if let Err(NotebookError::AmbiguousCitation {
                title,
                matching_source_ids,
            }) = self.library.resolve_citation_ref(notebook_id, inner)
            {
                ambiguous.push(AmbiguousCitationWarning {
                    raw_reference: title,
                    matching_source_ids,
                });
            }
        }

        let valid = !verified.is_empty() && invalid.is_empty() && ambiguous.is_empty();

        Ok(CitationVerificationReport {
            notebook_id: notebook_id.to_string(),
            valid,
            verified_citations: verified,
            invalid_citations: invalid,
            ambiguous_references: ambiguous,
            unique_cited_sources: unique_sources.into_iter().collect(),
        })
    }
}

fn parse_source_provenance(raw: &str) -> SourceProvenance {
    match raw.trim().to_ascii_uppercase().as_str() {
        "EXTRACTED" => SourceProvenance::Extracted,
        "INFERRED" => SourceProvenance::Inferred,
        _ => SourceProvenance::Ambiguous,
    }
}

fn sanitize_memory_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(48)
        .collect();
    if cleaned.is_empty() {
        "default".to_string()
    } else {
        cleaned
    }
}

fn excerpt_snippet(text: &str, max_chars: usize) -> String {
    let single_line = text.trim();
    let mut chars = single_line.chars();
    let taken: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{taken}...")
    } else {
        taken
    }
}
