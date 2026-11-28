//! NotebookLM Studio Artifact specs and structured pure-Rust builders persisted in `notebook_artifacts`.
//!
//! Supported Studio artifact kinds:
//! `Briefing`, `StudyGuide`, `Faq`, `Timeline`, `Quiz`, `Flashcards`, `MindMap` (Mermaid),
//! `InfographicSpec`, and `DataTable`.

use std::collections::BTreeSet;
use std::sync::Arc;

use omnia_core::{now_epoch_ms, SecretRedactor};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::NotebookError;
use crate::grounding::GroundingEngine;
use crate::llm_client::{complete_prompt, extract_json_payload, NotebookLlmConfig};
use crate::source_library::{SourceChunkRecord, SourceFilter, SourceLibrary, SourceRecord};
use crate::store::{NotebookStore, StoredArtifactRow};

/// All Studio Artifact formats covering the 9 Atelier v5 outputs
/// (`AudioOverview`, `MindMap`, `Flashcards`, `Quiz`, `SlideDeck`, `DataTable`,
/// `InfographicSpec`, `Briefing`, `StudyGuide`) plus `Faq` & `Timeline`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StudioArtifactKind {
    Briefing,
    StudyGuide,
    AudioOverview,
    SlideDeck,
    Faq,
    Timeline,
    Quiz,
    Flashcards,
    MindMap,
    InfographicSpec,
    DataTable,
}

impl StudioArtifactKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Briefing => "briefing",
            Self::StudyGuide => "study_guide",
            Self::AudioOverview => "audio_overview",
            Self::SlideDeck => "slide_deck",
            Self::Faq => "faq",
            Self::Timeline => "timeline",
            Self::Quiz => "quiz",
            Self::Flashcards => "flashcards",
            Self::MindMap => "mind_map",
            Self::InfographicSpec => "infographic_spec",
            Self::DataTable => "data_table",
        }
    }

    #[must_use]
    pub const fn default_title(self) -> &'static str {
        match self {
            Self::Briefing => "Briefing Doc",
            Self::StudyGuide => "Study Guide",
            Self::AudioOverview => "Audio Overview Script",
            Self::SlideDeck => "Slide Deck",
            Self::Faq => "Frequently Asked Questions",
            Self::Timeline => "Chronological Timeline",
            Self::Quiz => "Practice Quiz",
            Self::Flashcards => "Study Flashcards",
            Self::MindMap => "Mermaid Mind Map",
            Self::InfographicSpec => "Infographic Specification",
            Self::DataTable => "Structured Data Table",
        }
    }

    #[must_use]
    pub fn from_str_lossy(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "briefing" | "briefing_doc" => Self::Briefing,
            "study_guide" | "studyguide" => Self::StudyGuide,
            "audio_overview" | "audio" | "podcast" => Self::AudioOverview,
            "slide_deck" | "slidedeck" | "slides" => Self::SlideDeck,
            "faq" => Self::Faq,
            "timeline" => Self::Timeline,
            "quiz" => Self::Quiz,
            "flashcards" | "flashcard" => Self::Flashcards,
            "mind_map" | "mindmap" => Self::MindMap,
            "infographic_spec" | "infographic" => Self::InfographicSpec,
            "data_table" | "datatable" => Self::DataTable,
            _ => Self::Briefing,
        }
    }
}

/// Request to build and persist a Studio artifact from notebook sources.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerateArtifactRequest {
    pub notebook_id: String,
    pub kind: StudioArtifactKind,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
    #[serde(default)]
    pub focus_prompt: Option<String>,
}

/// Persisted Studio artifact record returned to Wave 3 Studio API / UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StudioArtifactRecord {
    pub artifact_id: String,
    pub notebook_id: String,
    pub kind: StudioArtifactKind,
    pub title: String,
    pub content_markdown: String,
    pub structured_json: Value,
    pub cited_source_ids: Vec<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Service generating, persisting, renaming, and deleting Studio artifacts.
#[derive(Debug, Clone)]
pub struct StudioArtifactService {
    store: Arc<NotebookStore>,
    library: SourceLibrary,
}

impl StudioArtifactService {
    #[must_use]
    pub fn new(store: Arc<NotebookStore>, library: SourceLibrary) -> Self {
        Self { store, library }
    }

    /// Generate a structured, citation-grounded Studio artifact and persist it in `notebook_artifacts`.
    pub fn generate_artifact(
        &self,
        req: GenerateArtifactRequest,
    ) -> Result<StudioArtifactRecord, NotebookError> {
        let notebook = self.library.require_notebook(&req.notebook_id)?;
        let selected_sources = self.resolve_selected_sources(&req.notebook_id, req.source_ids.as_deref())?;
        if selected_sources.is_empty() {
            return Err(NotebookError::InvalidInput(format!(
                "notebook '{}' has no eligible sources to generate {:?}",
                req.notebook_id, req.kind
            )));
        }

        let mut source_chunks: Vec<(SourceRecord, Vec<SourceChunkRecord>)> =
            Vec::with_capacity(selected_sources.len());
        for src in selected_sources {
            let chunks = self.store.list_chunks_for_source(&src.source_id)?;
            source_chunks.push((src, chunks));
        }

        let title = req
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(SecretRedactor::redact)
            .unwrap_or_else(|| format!("{} — {}", req.kind.default_title(), notebook.title));
        let focus = req
            .focus_prompt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(SecretRedactor::redact);

        let (content_markdown, structured_json) =
            synthesize_artifact(req.kind, &title, focus.as_deref(), &source_chunks);

        let cited_source_ids: Vec<String> = source_chunks
            .iter()
            .map(|(s, _)| s.source_id.clone())
            .collect();
        let now = now_epoch_ms();
        let artifact_id = format!("art_{}", Uuid::new_v4().simple());

        let row = StoredArtifactRow {
            artifact_id: artifact_id.clone(),
            notebook_id: req.notebook_id.clone(),
            kind: req.kind.as_str().to_string(),
            title: title.clone(),
            content_markdown: SecretRedactor::redact(&content_markdown),
            structured_json: SecretRedactor::redact_json(&structured_json),
            cited_source_ids: cited_source_ids.clone(),
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.store.upsert_artifact(&row)?;
        Ok(record_from_row(row))
    }

    /// Generates a real-LLM grounded Studio artifact across multi-chunk source evidence
    /// (ALL 9 Atelier Studio v5 types + `Faq`/`Timeline`), verifying every `[source_id:chunk_idx]`
    /// citation via [`GroundingEngine`] before persisting to SQLite.
    pub async fn generate_artifact_with_llm(
        &self,
        req: GenerateArtifactRequest,
        grounding: &GroundingEngine,
        llm_cfg: &NotebookLlmConfig,
    ) -> Result<StudioArtifactRecord, NotebookError> {
        let notebook = self.library.require_notebook(&req.notebook_id)?;
        let selected_sources =
            self.resolve_selected_sources(&req.notebook_id, req.source_ids.as_deref())?;
        if selected_sources.is_empty() {
            return Err(NotebookError::InvalidInput(format!(
                "notebook '{}' has no eligible sources to generate {:?}",
                req.notebook_id, req.kind
            )));
        }

        let mut source_chunks: Vec<(SourceRecord, Vec<SourceChunkRecord>)> =
            Vec::with_capacity(selected_sources.len());
        let mut corpus_blocks = Vec::new();
        for src in selected_sources {
            let chunks = self.store.list_chunks_for_source(&src.source_id)?;
            for ch in chunks.iter().take(6) {
                let excerpt: String = ch
                    .body
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(1200)
                    .collect();
                corpus_blocks.push(format!(
                    "### [{}:{}] {} ({})\n{}",
                    src.source_id, ch.chunk_idx, src.title, ch.heading, excerpt
                ));
            }
            source_chunks.push((src, chunks));
        }

        let title = req
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(SecretRedactor::redact)
            .unwrap_or_else(|| format!("{} — {}", req.kind.default_title(), notebook.title));
        let focus = req
            .focus_prompt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(SecretRedactor::redact);

        let (sys_prompt, user_prompt) =
            build_llm_artifact_prompts(req.kind, &title, focus.as_deref(), &corpus_blocks);
        let llm_resp = complete_prompt(llm_cfg, &sys_prompt, &user_prompt).await?;

        let verify = grounding.verify_citations(&req.notebook_id, &llm_resp.text)?;
        let mut cited_set: BTreeSet<String> = verify
            .verified_citations
            .iter()
            .map(|c| c.source_id.clone())
            .collect();
        if cited_set.is_empty() {
            for (s, _) in &source_chunks {
                cited_set.insert(s.source_id.clone());
            }
        }
        let parsed_json = extract_json_payload(&llm_resp.text);
        let mut structured_json = json!({
            "schema": format!("omnia.studio.{}.llm.v1", req.kind.as_str()),
            "title": title,
            "focus": focus,
            "generated_by": "real_llm",
            "model_id": llm_resp.model_id,
            "provider_id": llm_resp.provider_id,
            "wire_api": llm_resp.wire_api,
            "input_tokens": llm_resp.input_tokens,
            "output_tokens": llm_resp.output_tokens,
            "latency_ms": llm_resp.latency_ms,
            "citation_verification": verify,
            "parsed_payload": parsed_json,
        });
        // Hoist structured interactive payloads (`questions`, `tree`, `turns`, `cards`) to top-level
        // keys so NotebookLM++ UI viewers consume LLM and deterministic outputs identically.
        if let (Some(dst), Some(src_obj)) = (
            structured_json.as_object_mut(),
            parsed_json.as_ref().and_then(Value::as_object),
        ) {
            for key in ["questions", "tree", "turns", "cards", "slides", "events", "entries", "mermaid"] {
                if let Some(val) = src_obj.get(key) {
                    dst.insert(key.to_string(), val.clone());
                }
            }
        }

        let now = now_epoch_ms();
        let row = StoredArtifactRow {
            artifact_id: format!("art_{}", Uuid::new_v4().simple()),
            notebook_id: req.notebook_id,
            kind: req.kind.as_str().to_string(),
            title,
            content_markdown: SecretRedactor::redact(&llm_resp.text),
            structured_json: SecretRedactor::redact_json(&structured_json),
            cited_source_ids: cited_set.into_iter().collect(),
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.store.upsert_artifact(&row)?;
        Ok(record_from_row(row))
    }

    /// List all Studio artifacts belonging to `notebook_id`.
    pub fn list_artifacts(
        &self,
        notebook_id: &str,
    ) -> Result<Vec<StudioArtifactRecord>, NotebookError> {
        let _ = self.library.require_notebook(notebook_id)?;
        Ok(self
            .store
            .list_artifacts(notebook_id)?
            .into_iter()
            .map(record_from_row)
            .collect())
    }

    /// Fetch a single artifact by ID.
    pub fn get_artifact(&self, artifact_id: &str) -> Result<StudioArtifactRecord, NotebookError> {
        self.store
            .get_artifact(artifact_id)?
            .map(record_from_row)
            .ok_or_else(|| NotebookError::NotFound {
                entity: "artifact",
                id: artifact_id.to_string(),
            })
    }

    /// Rename a persisted Studio artifact.
    pub fn rename_artifact(
        &self,
        artifact_id: &str,
        new_title: &str,
    ) -> Result<StudioArtifactRecord, NotebookError> {
        let clean = SecretRedactor::redact(new_title.trim());
        if clean.is_empty() {
            return Err(NotebookError::InvalidInput(
                "artifact title cannot be empty".to_string(),
            ));
        }
        if !self.store.rename_artifact(artifact_id, &clean)? {
            return Err(NotebookError::NotFound {
                entity: "artifact",
                id: artifact_id.to_string(),
            });
        }
        self.get_artifact(artifact_id)
    }

    /// Delete a persisted Studio artifact.
    pub fn delete_artifact(&self, artifact_id: &str) -> Result<bool, NotebookError> {
        self.store.delete_artifact(artifact_id)
    }

    fn resolve_selected_sources(
        &self,
        notebook_id: &str,
        source_ids: Option<&[String]>,
    ) -> Result<Vec<SourceRecord>, NotebookError> {
        match source_ids {
            Some(ids) if !ids.is_empty() => {
                let mut out = Vec::with_capacity(ids.len());
                for id in ids {
                    let resolved = self.library.resolve_citation_ref(notebook_id, id)?;
                    if let Some(src) = self.store.get_source(&resolved.source_id)? {
                        out.push(src);
                    }
                }
                Ok(out)
            }
            _ => self.store.list_sources(notebook_id, &SourceFilter::default()),
        }
    }
}

fn synthesize_artifact(
    kind: StudioArtifactKind,
    title: &str,
    focus: Option<&str>,
    items: &[(SourceRecord, Vec<SourceChunkRecord>)],
) -> (String, Value) {
    match kind {
        StudioArtifactKind::Briefing => build_briefing(title, focus, items),
        StudioArtifactKind::StudyGuide => build_study_guide(title, focus, items),
        StudioArtifactKind::AudioOverview => build_audio_overview(title, focus, items),
        StudioArtifactKind::SlideDeck => build_slide_deck(title, focus, items),
        StudioArtifactKind::Faq => build_faq(title, items),
        StudioArtifactKind::Timeline => build_timeline(title, items),
        StudioArtifactKind::Quiz => build_quiz(title, items),
        StudioArtifactKind::Flashcards => build_flashcards(title, items),
        StudioArtifactKind::MindMap => build_mind_map(title, items),
        StudioArtifactKind::InfographicSpec => build_infographic_spec(title, focus, items),
        StudioArtifactKind::DataTable => build_data_table(title, items),
    }
}

fn build_llm_artifact_prompts(
    kind: StudioArtifactKind,
    title: &str,
    focus: Option<&str>,
    evidence_blocks: &[String],
) -> (String, String) {
    let sys = "You are Atelier Studio, an authoritative research synthesis assistant. \
Every claim MUST cite exact source chunk markers in `[source_id:chunk_idx]` notation matching \
only the evidence provided below. Never invent sources, facts, or numbers. \
Produce clean GitHub-Flavored Markdown AND embed a fenced ```json``` block matching the requested schema."
        .to_string();

    let kind_spec = match kind {
        StudioArtifactKind::AudioOverview => {
            "Artifact: Two-Host Audio Overview Script (Host A: analytical guide, Host B: inquisitive synthesizer).\n\
             Include chapter markers, natural conversational transitions, spoken math/term clarity, SSML pause hints `[pause:300ms]`, \
             and `[source_id:chunk_idx]` citations on every key point.\n\
             Embed ```json```: {\"turns\":[{\"speaker\":\"Host A\"|\"Host B\",\"text\":\"...\",\"citation_ids\":[\"[source_id:0]\"]}],\"chapters\":[{\"title\":\"...\",\"turns\":[]}]}."
        }
        StudioArtifactKind::MindMap => {
            "Artifact: Hierarchical Concept Mind Map.\n\
             Include a valid ```mermaid\\nflowchart TD``` diagram AND ```json```: {\"tree\":{\"id\":\"root\",\"label\":\"...\",\"citation_ids\":[],\"children\":[{\"id\":\"n1\",\"label\":\"...\",\"citation_ids\":[\"[source_id:0]\"],\"children\":[]}]}}."
        }
        StudioArtifactKind::Flashcards => {
            "Artifact: Active-Recall Flashcards Deck (6-12 cards covering core definitions, mechanisms, edge cases).\n\
             Embed ```json```: {\"cards\":[{\"front\",\"back\",\"hint\",\"difficulty\":\"easy|medium|hard\",\"citations\":[]}]}."
        }
        StudioArtifactKind::Quiz => {
            "Artifact: Assessment Quiz (5-10 MCQs with 4 plausible options, exact answer index, detailed explanation, citation_ids).\n\
             Embed ```json```: {\"questions\":[{\"id\":\"q1\",\"question\":\"...\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"correct_index\":0,\"explanation\":\"...\",\"citation_ids\":[\"[source_id:0]\"]}]}."
        }
        StudioArtifactKind::SlideDeck => {
            "Artifact: Executive Slide Deck (6-10 slides).\n\
             For each slide provide: Slide Title, 3-4 concise bullets with citations, Visual/Diagram Suggestion, and Speaker Notes.\n\
             Embed ```json```: {\"slides\":[{\"number\":1,\"title\",\"bullets\":[],\"visual_hint\",\"speaker_notes\",\"citations\":[]}]}."
        }
        StudioArtifactKind::DataTable => {
            "Artifact: Structured Analytical Data Table comparing entities, metrics, properties, constraints, and provenance across sources.\n\
             Render a clean Markdown table AND ```json```: {\"columns\":[],\"rows\":[[]],\"notes\":[]}."
        }
        StudioArtifactKind::InfographicSpec => {
            "Artifact: Visual Infographic Layout Spec.\n\
             Include hero headline, 3-5 KPI callouts, section flow, recommended chart specs, and ```json```: {\"headline\",\"kpis\":[],\"sections\":[],\"charts\":[],\"citations\":[]}."
        }
        StudioArtifactKind::Briefing => {
            "Artifact: Executive Briefing Document covering Thesis, Key Findings, Technical Trade-offs, Risks/Limitations, and Next Actions.\n\
             Embed ```json```: {\"executive_summary\",\"key_findings\":[{\"claim\",\"citations\":[]}],\"risks\":[],\"actions\":[]}."
        }
        StudioArtifactKind::StudyGuide => {
            "Artifact: Comprehensive Study Guide with Learning Objectives, Core Concepts, Glossary, Practice Questions, and Review Checklist.\n\
             Embed ```json```: {\"objectives\":[],\"concepts\":[],\"glossary\":[{\"term\",\"definition\",\"citations\":[]}],\"practice_prompts\":[]}."
        }
        StudioArtifactKind::Faq => {
            "Artifact: Grounded Frequently Asked Questions (Q&A pairs with exact citations). Include ```json``` summary."
        }
        StudioArtifactKind::Timeline => {
            "Artifact: Chronological / Causal Execution Timeline with citations. Include ```json``` events array."
        }
    };

    let focus_line = focus
        .map(|f| format!("User Focus: {f}\n"))
        .unwrap_or_default();
    let user = format!(
        "Title: {title}\n{focus_line}\n{kind_spec}\n\n## Grounded Evidence Chunks\n\n{}",
        evidence_blocks.join("\n\n")
    );
    (sys, user)
}

fn build_audio_overview(
    title: &str,
    focus: Option<&str>,
    items: &[(SourceRecord, Vec<SourceChunkRecord>)],
) -> (String, Value) {
    let mut turns = Vec::new();
    let mut md = format!("# {title}\n");
    if let Some(f) = focus {
        md.push_str(&format!("\n> Focus: {f}\n"));
    }
    md.push_str("\n## Two-Host Dialogue Script\n");

    let all_primary_cites: Vec<String> = items
        .iter()
        .map(|(src, chunks)| {
            let (idx, _) = primary_snippet(chunks, 80);
            format!("[{}:{}]", src.source_id, idx)
        })
        .collect();
    let intro_text = match focus {
        Some(f) => format!(
            "Welcome to Omnia Atelier Audio Overview for \"{title}\". Today we're exploring {} grounded source(s) with a focus on {f}.",
            items.len()
        ),
        None => format!(
            "Welcome to Omnia Atelier Audio Overview for \"{title}\". Today we're unpacking {} grounded source(s) together.",
            items.len()
        ),
    };
    md.push_str(&format!("\n**Host A:** {intro_text}\n"));
    turns.push(json!({
        "speaker": "Host A",
        "text": intro_text,
        "line": intro_text,
        "citation_ids": all_primary_cites.iter().take(3).cloned().collect::<Vec<_>>(),
    }));

    for (i, (src, chunks)) in items.iter().enumerate() {
        let (idx, snippet) = primary_snippet(chunks, 180);
        let cite = format!("[{}:{}]", src.source_id, idx);
        let lead_speaker = if i % 2 == 0 { "Host B" } else { "Host A" };
        let follow_speaker = if lead_speaker == "Host A" { "Host B" } else { "Host A" };
        let lead_text = format!("Looking at \"{}\" {cite}, the key evidence stands out: {snippet}", src.title);
        md.push_str(&format!("\n**{lead_speaker}:** {lead_text}\n"));
        turns.push(json!({
            "speaker": lead_speaker,
            "text": lead_text,
            "line": lead_text,
            "source_id": src.source_id,
            "citation": cite,
            "citation_ids": [cite],
        }));

        let follow_text = if let Some(second) = chunks.get(1) {
            let sec_cite = format!("[{}:{}]", src.source_id, second.chunk_idx);
            let sec_snip: String = second
                .body
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(160)
                .collect();
            let text = format!(
                "That connects directly to the follow-up section in \"{}\" {sec_cite}: {sec_snip}",
                src.title
            );
            md.push_str(&format!("\n**{follow_speaker}:** {text}\n"));
            turns.push(json!({
                "speaker": follow_speaker,
                "text": text,
                "line": text,
                "source_id": src.source_id,
                "citation": sec_cite,
                "citation_ids": [cite, sec_cite],
            }));
            None
        } else {
            Some(format!(
                "Good catch — \"{}\" anchors that takeaway cleanly in {cite} so we can cross-check it against the rest of the notebook.",
                src.title
            ))
        };
        if let Some(text) = follow_text {
            md.push_str(&format!("\n**{follow_speaker}:** {text}\n"));
            turns.push(json!({
                "speaker": follow_speaker,
                "text": text,
                "line": text,
                "source_id": src.source_id,
                "citation": cite,
                "citation_ids": [cite],
            }));
        }
    }

    let outro_text = format!(
        "That wraps our grounded walkthrough of \"{title}\" across {} source(s). Jump in anytime to ask a follow-up question on any turn!",
        items.len()
    );
    md.push_str(&format!("\n**Host B:** {outro_text}\n"));
    turns.push(json!({
        "speaker": "Host B",
        "text": outro_text,
        "line": outro_text,
        "citation_ids": all_primary_cites,
    }));

    (
        md,
        json!({
            "schema": "omnia.studio.audio_overview.v2",
            "title": title,
            "focus": focus,
            "turns": turns,
        }),
    )
}

fn build_slide_deck(
    title: &str,
    focus: Option<&str>,
    items: &[(SourceRecord, Vec<SourceChunkRecord>)],
) -> (String, Value) {
    let mut slides = Vec::new();
    let mut md = format!("# {title}\n");
    for (i, (src, chunks)) in items.iter().enumerate() {
        let num = i + 1;
        let (idx, snippet) = primary_snippet(chunks, 180);
        let cite = format!("[{}:{}]", src.source_id, idx);
        md.push_str(&format!("\n## Slide {num}: {}\n- {snippet} {cite}\n", src.title));
        slides.push(json!({
            "number": num,
            "title": src.title,
            "bullets": [format!("{snippet} {cite}")],
            "focus": focus,
            "citations": [cite],
        }));
    }
    (
        md,
        json!({
            "schema": "omnia.studio.slide_deck.v1",
            "title": title,
            "focus": focus,
            "slides": slides,
        }),
    )
}

fn build_briefing(
    title: &str,
    focus: Option<&str>,
    items: &[(SourceRecord, Vec<SourceChunkRecord>)],
) -> (String, Value) {
    let mut points = Vec::new();
    let mut md = format!("# {title}\n");
    if let Some(f) = focus {
        md.push_str(&format!("\n> Focus: {f}\n"));
    }
    md.push_str("\n## Key Takeaways\n");
    for (src, chunks) in items {
        let (idx, snippet) = primary_snippet(chunks, 220);
        let cite = format!("[{}:{}]", src.source_id, idx);
        md.push_str(&format!("- **{}** {cite}: {snippet}\n", src.title));
        points.push(json!({
            "source_id": src.source_id,
            "citation": cite,
            "title": src.title,
            "summary": snippet,
        }));
    }
    (
        md,
        json!({
            "schema": "omnia.studio.briefing.v1",
            "title": title,
            "focus": focus,
            "takeaways": points,
        }),
    )
}

fn build_study_guide(
    title: &str,
    focus: Option<&str>,
    items: &[(SourceRecord, Vec<SourceChunkRecord>)],
) -> (String, Value) {
    let mut modules = Vec::new();
    let mut md = format!("# {title}\n");
    if let Some(f) = focus {
        md.push_str(&format!("\n_Objective: {f}_\n"));
    }
    for (i, (src, chunks)) in items.iter().enumerate() {
        let headings: Vec<String> = chunks
            .iter()
            .map(|c| c.heading.clone())
            .filter(|h| !h.is_empty())
            .take(5)
            .collect();
        let (idx, snippet) = primary_snippet(chunks, 200);
        let cite = format!("[{}:{}]", src.source_id, idx);
        md.push_str(&format!(
            "\n## Module {}: {} {cite}\n\n- Topics: {}\n- Core Concept: {snippet}\n",
            i + 1,
            src.title,
            if headings.is_empty() {
                "Core Overview".to_string()
            } else {
                headings.join(", ")
            }
        ));
        modules.push(json!({
            "module_number": i + 1,
            "title": src.title,
            "citation": cite,
            "topics": headings,
            "concept_summary": snippet,
        }));
    }
    (
        md,
        json!({
            "schema": "omnia.studio.study_guide.v1",
            "title": title,
            "modules": modules,
        }),
    )
}

fn build_faq(title: &str, items: &[(SourceRecord, Vec<SourceChunkRecord>)]) -> (String, Value) {
    let mut qa_list = Vec::new();
    let mut md = format!("# {title}\n");
    for (src, chunks) in items {
        let (idx, snippet) = primary_snippet(chunks, 240);
        let cite = format!("[{}:{}]", src.source_id, idx);
        let q = format!("What are the core facts covered in '{}'?", src.title);
        let a = format!("{snippet} {cite}");
        md.push_str(&format!("\n### Q: {q}\n\n**A:** {a}\n"));
        qa_list.push(json!({
            "question": q,
            "answer": a,
            "citation": cite,
            "source_id": src.source_id,
        }));
    }
    (
        md,
        json!({
            "schema": "omnia.studio.faq.v1",
            "title": title,
            "entries": qa_list,
        }),
    )
}

fn build_timeline(
    title: &str,
    items: &[(SourceRecord, Vec<SourceChunkRecord>)],
) -> (String, Value) {
    let mut events = Vec::new();
    let mut md = format!("# {title}\n\n");
    for (pos, (src, chunks)) in items.iter().enumerate() {
        let (idx, snippet) = primary_snippet(chunks, 180);
        let cite = format!("[{}:{}]", src.source_id, idx);
        let step_label = format!("Milestone {}", pos + 1);
        md.push_str(&format!(
            "- **{step_label}** (`{}`) — **{}** {cite}: {snippet}\n",
            src.created_at_ms, src.title
        ));
        events.push(json!({
            "order": pos + 1,
            "label": step_label,
            "timestamp_ms": src.created_at_ms,
            "title": src.title,
            "citation": cite,
            "detail": snippet,
        }));
    }
    (
        md,
        json!({
            "schema": "omnia.studio.timeline.v1",
            "title": title,
            "events": events,
        }),
    )
}

fn build_quiz(title: &str, items: &[(SourceRecord, Vec<SourceChunkRecord>)]) -> (String, Value) {
    let mut questions = Vec::new();
    let mut md = format!("# {title}\n");
    let fallback_distractors = [
        "Unreferenced External Source",
        "Deprecated Draft Archive",
        "None of the Notebook Sources",
        "Unverified Off-Corpus Summary",
    ];
    for (i, (src, chunks)) in items.iter().enumerate() {
        let (idx, snippet) = primary_snippet(chunks, 160);
        let cite = format!("[{}:{}]", src.source_id, idx);
        let q_id = format!("q{}", i + 1);
        let question_text = format!(
            "Which source best documents the following topic: \"{}\"?",
            snippet.chars().take(90).collect::<String>()
        );
        let mut distractors: Vec<String> = items
            .iter()
            .enumerate()
            .filter(|(j, (other, _))| *j != i && other.title != src.title)
            .map(|(_, (other, _))| other.title.clone())
            .take(3)
            .collect();
        for fb in fallback_distractors {
            if distractors.len() >= 3 {
                break;
            }
            if fb != src.title && !distractors.iter().any(|d| d == fb) {
                distractors.push(fb.to_string());
            }
        }
        let correct_index = i % 4;
        let mut options = Vec::with_capacity(4);
        let mut d_iter = distractors.into_iter();
        for slot in 0..4 {
            if slot == correct_index {
                options.push(src.title.clone());
            } else {
                options.push(d_iter.next().unwrap_or_else(|| "None of the above".to_string()));
            }
        }
        let answer_letter = ["A", "B", "C", "D"][correct_index];
        let explanation = format!(
            "Grounded directly in \"{}\" {cite}: {snippet}",
            src.title
        );
        md.push_str(&format!(
            "\n### Question {}\n\n{question_text}\n\n- A) {}\n- B) {}\n- C) {}\n- D) {}\n\n> Answer: **{answer_letter}** — {explanation}\n",
            i + 1,
            options[0],
            options[1],
            options[2],
            options[3]
        ));
        questions.push(json!({
            "id": q_id,
            "question_number": i + 1,
            "question": question_text,
            "prompt": question_text,
            "options": options,
            "correct_index": correct_index,
            "explanation": explanation,
            "citation": cite,
            "citation_ids": [cite],
            "source_id": src.source_id,
        }));
    }
    (
        md,
        json!({
            "schema": "omnia.studio.quiz.v2",
            "title": title,
            "questions": questions,
        }),
    )
}

fn build_flashcards(
    title: &str,
    items: &[(SourceRecord, Vec<SourceChunkRecord>)],
) -> (String, Value) {
    let mut cards = Vec::new();
    let mut md = format!("# {title}\n");
    for (i, (src, chunks)) in items.iter().enumerate() {
        let (idx, snippet) = primary_snippet(chunks, 200);
        let cite = format!("[{}:{}]", src.source_id, idx);
        let front = format!("Source Concept: {}", src.title);
        let back = format!("{snippet} {cite}");
        md.push_str(&format!(
            "\n### Card {}\n- **Front:** {front}\n- **Back:** {back}\n",
            i + 1
        ));
        cards.push(json!({
            "card_index": i + 1,
            "front": front,
            "back": back,
            "citation": cite,
            "source_id": src.source_id,
        }));
    }
    (
        md,
        json!({
            "schema": "omnia.studio.flashcards.v1",
            "title": title,
            "cards": cards,
        }),
    )
}

fn build_mind_map(
    title: &str,
    items: &[(SourceRecord, Vec<SourceChunkRecord>)],
) -> (String, Value) {
    let safe_root = sanitize_mermaid_label(title);
    let mut lines = vec![
        "flowchart TD".to_string(),
        format!("    root[\"{safe_root}\"]"),
    ];
    let mut nodes = Vec::new();
    let mut tree_children = Vec::new();
    let mut root_citation_ids = Vec::new();

    for (s_idx, (src, chunks)) in items.iter().enumerate() {
        let src_node = format!("s{s_idx}");
        let safe_src = sanitize_mermaid_label(&src.title);
        lines.push(format!("    {src_node}[\"{safe_src}\"]"));
        lines.push(format!("    root --> {src_node}"));
        let mut child_labels = Vec::new();
        let mut branch_children = Vec::new();
        let mut branch_cites = Vec::new();

        for chunk in chunks.iter().take(4) {
            let c_node = format!("s{s_idx}_c{}", chunk.chunk_idx);
            let cite = format!("[{}:{}]", src.source_id, chunk.chunk_idx);
            let heading_raw = if chunk.heading.is_empty() {
                format!("Section {}", chunk.chunk_idx + 1)
            } else {
                chunk.heading.clone()
            };
            let clean_heading = sanitize_mermaid_label(&heading_raw);
            let label = sanitize_mermaid_label(&format!("{heading_raw} {cite}"));
            lines.push(format!("    {c_node}[\"{label}\"]"));
            lines.push(format!("    {src_node} --> {c_node}"));
            child_labels.push(label);
            branch_cites.push(cite.clone());
            branch_children.push(json!({
                "id": c_node,
                "label": clean_heading,
                "source_id": src.source_id,
                "citation_ids": [cite],
                "children": [],
            }));
        }
        if branch_cites.is_empty() {
            let fallback_cite = format!("[{}:0]", src.source_id);
            branch_cites.push(fallback_cite);
        }
        if let Some(first_cite) = branch_cites.first() {
            root_citation_ids.push(first_cite.clone());
        }
        tree_children.push(json!({
            "id": src_node,
            "label": safe_src,
            "source_id": src.source_id,
            "citation_ids": branch_cites,
            "children": branch_children,
        }));
        nodes.push(json!({
            "node_id": src_node,
            "source_id": src.source_id,
            "label": safe_src,
            "children": child_labels,
        }));
    }

    let tree = json!({
        "id": "root",
        "label": safe_root,
        "citation_ids": root_citation_ids,
        "children": tree_children,
    });
    let mermaid = lines.join("\n");
    let md = format!("# {title}\n\n```mermaid\n{mermaid}\n```\n");
    (
        md,
        json!({
            "schema": "omnia.studio.mind_map.v2",
            "diagram_type": "flowchart_td",
            "mermaid": mermaid,
            "tree": tree,
            "nodes": nodes,
        }),
    )
}

fn build_infographic_spec(
    title: &str,
    focus: Option<&str>,
    items: &[(SourceRecord, Vec<SourceChunkRecord>)],
) -> (String, Value) {
    let total_chunks: usize = items.iter().map(|(_, c)| c.len()).sum();
    let total_bytes: u64 = items.iter().map(|(s, _)| s.byte_size).sum();
    let kpis = vec![
        json!({ "label": "Sources Grounded", "value": items.len() }),
        json!({ "label": "Indexed Chunks", "value": total_chunks }),
        json!({ "label": "Corpus Bytes", "value": total_bytes }),
    ];
    let panels: Vec<Value> = items
        .iter()
        .enumerate()
        .map(|(i, (src, chunks))| {
            let (idx, snippet) = primary_snippet(chunks, 140);
            json!({
                "panel_order": i + 1,
                "heading": src.title,
                "citation": format!("[{}:{}]", src.source_id, idx),
                "callout": snippet,
                "kind": src.source_kind.as_str(),
            })
        })
        .collect();

    let mut md = format!(
        "# {title}\n\n- **Sources:** {}\n- **Chunks:** {total_chunks}\n- **Total Bytes:** {total_bytes}\n",
        items.len()
    );
    if let Some(f) = focus {
        md.push_str(&format!("- **Theme:** {f}\n"));
    }
    md.push_str("\n## Visual Panels\n");
    for (src, chunks) in items {
        let (idx, snippet) = primary_snippet(chunks, 140);
        md.push_str(&format!(
            "- **{}** [{}:{}]: {snippet}\n",
            src.title, src.source_id, idx
        ));
    }

    (
        md,
        json!({
            "schema": "omnia.studio.infographic_spec.v1",
            "title": title,
            "focus": focus,
            "layout": "vertical_editorial_grid",
            "palette_tokens": ["surface-canvas", "surface-card", "accent-primary", "ink-primary"],
            "kpis": kpis,
            "panels": panels,
        }),
    )
}

fn build_data_table(
    title: &str,
    items: &[(SourceRecord, Vec<SourceChunkRecord>)],
) -> (String, Value) {
    let columns = vec![
        "Source ID",
        "Title",
        "Kind",
        "Chunks",
        "Bytes",
        "Primary Citation",
        "Excerpt",
    ];
    let mut rows = Vec::new();
    let mut md = format!(
        "# {title}\n\n| {} |\n| {} |\n",
        columns.join(" | "),
        vec!["---"; columns.len()].join(" | ")
    );
    for (src, chunks) in items {
        let (idx, snippet) = primary_snippet(chunks, 110);
        let cite = format!("[{}:{}]", src.source_id, idx);
        let clean_snip = snippet.replace('|', "\\|").replace('\n', " ");
        let clean_title = src.title.replace('|', "\\|");
        md.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} | {} |\n",
            src.source_id,
            clean_title,
            src.source_kind.as_str(),
            chunks.len(),
            src.byte_size,
            cite,
            clean_snip
        ));
        rows.push(json!([
            src.source_id,
            src.title,
            src.source_kind.as_str(),
            chunks.len(),
            src.byte_size,
            cite,
            snippet,
        ]));
    }
    (
        md,
        json!({
            "schema": "omnia.studio.data_table.v1",
            "title": title,
            "columns": columns,
            "rows": rows,
        }),
    )
}

fn primary_snippet(chunks: &[SourceChunkRecord], max_chars: usize) -> (usize, String) {
    let Some(first) = chunks.first() else {
        return (0, "No indexed chunk content.".to_string());
    };
    let clean = first.body.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = clean.chars();
    let taken: String = chars.by_ref().take(max_chars).collect();
    let text = if chars.next().is_some() {
        format!("{taken}...")
    } else {
        taken
    };
    (first.chunk_idx, text)
}

fn sanitize_mermaid_label(raw: &str) -> String {
    raw.replace(['"', '\n', '\r', '<', '>'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn record_from_row(row: StoredArtifactRow) -> StudioArtifactRecord {
    StudioArtifactRecord {
        artifact_id: row.artifact_id,
        notebook_id: row.notebook_id,
        kind: StudioArtifactKind::from_str_lossy(&row.kind),
        title: row.title,
        content_markdown: row.content_markdown,
        structured_json: row.structured_json,
        cited_source_ids: row.cited_source_ids,
        created_at_ms: row.created_at_ms,
        updated_at_ms: row.updated_at_ms,
    }
}

#[cfg(test)]
mod steer23_artifact_schema_tests {
    use super::*;
    use crate::source_library::SourceKind;

    fn sample_items() -> Vec<(SourceRecord, Vec<SourceChunkRecord>)> {
        let s1 = SourceRecord {
            source_id: "src_alpha".to_string(),
            notebook_id: "nb_1".to_string(),
            remote_id: None,
            title: "SQLite WAL Concurrency".to_string(),
            safe_filename: "sqlite_wal.md".to_string(),
            mime_type: "text/markdown".to_string(),
            source_kind: SourceKind::Document,
            is_video: false,
            content_sha256: "0000".to_string(),
            content_blake3: "0000".to_string(),
            byte_size: 256,
            chunk_count: 2,
            ingestion_stage: "indexed".to_string(),
            provenance: "local".to_string(),
            metadata: json!({}),
            created_at_ms: 1_000,
        };
        let c1 = vec![
            SourceChunkRecord {
                chunk_id: "chk_1".to_string(),
                notebook_id: "nb_1".to_string(),
                source_id: "src_alpha".to_string(),
                chunk_idx: 0,
                heading: "Write-Ahead Logging".to_string(),
                body: "WAL allows concurrent readers alongside a single writer.".to_string(),
                token_count: 12,
                byte_size: 58,
                content_blake3: "aaaa".to_string(),
            },
            SourceChunkRecord {
                chunk_id: "chk_2".to_string(),
                notebook_id: "nb_1".to_string(),
                source_id: "src_alpha".to_string(),
                chunk_idx: 1,
                heading: "Checkpointing".to_string(),
                body: "Passive checkpoints merge WAL frames back to the main DB.".to_string(),
                token_count: 12,
                byte_size: 59,
                content_blake3: "bbbb".to_string(),
            },
        ];
        let s2 = SourceRecord {
            source_id: "src_beta".to_string(),
            notebook_id: "nb_1".to_string(),
            remote_id: None,
            title: "Rust Async Runtime".to_string(),
            safe_filename: "rust_async.txt".to_string(),
            mime_type: "text/plain".to_string(),
            source_kind: SourceKind::Document,
            is_video: false,
            content_sha256: "1111".to_string(),
            content_blake3: "1111".to_string(),
            byte_size: 180,
            chunk_count: 1,
            ingestion_stage: "indexed".to_string(),
            provenance: "local".to_string(),
            metadata: json!({}),
            created_at_ms: 2_000,
        };
        let c2 = vec![SourceChunkRecord {
            chunk_id: "chk_3".to_string(),
            notebook_id: "nb_1".to_string(),
            source_id: "src_beta".to_string(),
            chunk_idx: 0,
            heading: "Work Stealing".to_string(),
            body: "Tokio schedules async tasks across worker queues efficiently.".to_string(),
            token_count: 11,
            byte_size: 62,
            content_blake3: "cccc".to_string(),
        }];
        vec![(s1, c1), (s2, c2)]
    }

    #[test]
    fn quiz_mind_map_and_audio_overview_emit_steer23_structured_schemas() {
        let items = sample_items();

        let (_qmd, qjson) = build_quiz("Systems Quiz", &items);
        let qs = qjson["questions"].as_array().expect("quiz questions");
        assert_eq!(qs.len(), 2);
        assert_eq!(qs[0]["id"], "q1");
        assert!(qs[0]["question"].as_str().unwrap().contains("Which source"));
        assert_eq!(qs[0]["options"].as_array().unwrap().len(), 4);
        assert!(qs[0]["correct_index"].as_u64().unwrap() < 4);
        assert!(qs[0]["explanation"].as_str().unwrap().contains("SQLite WAL"));
        assert_eq!(qs[0]["citation_ids"], json!(["[src_alpha:0]"]));

        let (_mmd, mjson) = build_mind_map("Systems Map", &items);
        assert!(mjson["mermaid"].as_str().unwrap().starts_with("flowchart TD"));
        let tree = &mjson["tree"];
        assert_eq!(tree["id"], "root");
        assert_eq!(tree["label"], "Systems Map");
        let branches = tree["children"].as_array().expect("tree children");
        assert_eq!(branches.len(), 2);
        assert_eq!(branches[0]["label"], "SQLite WAL Concurrency");
        assert_eq!(branches[0]["children"].as_array().unwrap().len(), 2);
        assert_eq!(
            branches[0]["children"][0]["citation_ids"],
            json!(["[src_alpha:0]"])
        );

        let (_amd, ajson) = build_audio_overview("Systems Podcast", Some("WAL & Tokio"), &items);
        let turns = ajson["turns"].as_array().expect("podcast turns");
        assert!(turns.len() >= 4);
        assert!(turns.iter().any(|t| t["speaker"] == "Host A"));
        assert!(turns.iter().any(|t| t["speaker"] == "Host B"));
        for t in turns {
            assert!(!t["text"].as_str().unwrap_or("").is_empty());
            assert!(t["citation_ids"].as_array().is_some());
        }
    }
}
