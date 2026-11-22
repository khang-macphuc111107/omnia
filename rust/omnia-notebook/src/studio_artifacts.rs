//! NotebookLM Studio Artifact specs and structured pure-Rust builders persisted in `notebook_artifacts`.
//!
//! Supported Studio artifact kinds:
//! `Briefing`, `StudyGuide`, `Faq`, `Timeline`, `Quiz`, `Flashcards`, `MindMap` (Mermaid),
//! `InfographicSpec`, and `DataTable`.

use std::sync::Arc;

use omnia_core::{now_epoch_ms, SecretRedactor};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::NotebookError;
use crate::source_library::{SourceChunkRecord, SourceFilter, SourceLibrary, SourceRecord};
use crate::store::{NotebookStore, StoredArtifactRow};

/// All 9 Studio Artifact formats (`StudioArtifactKind` public Wave 3 contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StudioArtifactKind {
    Briefing,
    StudyGuide,
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
            Self::Briefing => "Executive Briefing",
            Self::StudyGuide => "Study Guide",
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
            "briefing" => Self::Briefing,
            "study_guide" => Self::StudyGuide,
            "faq" => Self::Faq,
            "timeline" => Self::Timeline,
            "quiz" => Self::Quiz,
            "flashcards" => Self::Flashcards,
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
        StudioArtifactKind::Faq => build_faq(title, items),
        StudioArtifactKind::Timeline => build_timeline(title, items),
        StudioArtifactKind::Quiz => build_quiz(title, items),
        StudioArtifactKind::Flashcards => build_flashcards(title, items),
        StudioArtifactKind::MindMap => build_mind_map(title, items),
        StudioArtifactKind::InfographicSpec => build_infographic_spec(title, focus, items),
        StudioArtifactKind::DataTable => build_data_table(title, items),
    }
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
    for (i, (src, chunks)) in items.iter().enumerate() {
        let (idx, snippet) = primary_snippet(chunks, 160);
        let cite = format!("[{}:{}]", src.source_id, idx);
        let prompt = format!(
            "Which source best documents the following topic: \"{}\"?",
            snippet.chars().take(90).collect::<String>()
        );
        let options = vec![
            src.title.clone(),
            "Unreferenced External Source".to_string(),
            "Deprecated Draft Archive".to_string(),
            "None of the Notebook Sources".to_string(),
        ];
        md.push_str(&format!(
            "\n### Question {}\n\n{prompt}\n\n- A) {}\n- B) {}\n- C) {}\n- D) {}\n\n> Answer: **A** {cite}\n",
            i + 1,
            options[0],
            options[1],
            options[2],
            options[3]
        ));
        questions.push(json!({
            "question_number": i + 1,
            "prompt": prompt,
            "options": options,
            "correct_index": 0,
            "citation": cite,
            "source_id": src.source_id,
        }));
    }
    (
        md,
        json!({
            "schema": "omnia.studio.quiz.v1",
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

    for (s_idx, (src, chunks)) in items.iter().enumerate() {
        let src_node = format!("s{s_idx}");
        let safe_src = sanitize_mermaid_label(&src.title);
        lines.push(format!("    {src_node}[\"{safe_src}\"]"));
        lines.push(format!("    root --> {src_node}"));
        let mut child_labels = Vec::new();

        for chunk in chunks.iter().take(4) {
            let c_node = format!("s{s_idx}_c{}", chunk.chunk_idx);
            let label = sanitize_mermaid_label(&format!(
                "{} [{}:{}]",
                if chunk.heading.is_empty() {
                    "Section"
                } else {
                    &chunk.heading
                },
                src.source_id,
                chunk.chunk_idx
            ));
            lines.push(format!("    {c_node}[\"{label}\"]"));
            lines.push(format!("    {src_node} --> {c_node}"));
            child_labels.push(label);
        }
        nodes.push(json!({
            "node_id": src_node,
            "source_id": src.source_id,
            "label": safe_src,
            "children": child_labels,
        }));
    }

    let mermaid = lines.join("\n");
    let md = format!("# {title}\n\n```mermaid\n{mermaid}\n```\n");
    (
        md,
        json!({
            "schema": "omnia.studio.mind_map.v1",
            "diagram_type": "flowchart_td",
            "mermaid": mermaid,
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
