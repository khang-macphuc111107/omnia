use std::collections::BTreeSet;
use std::sync::Mutex;

use omnia_core::SecretRedactor;
use serde::Serialize;
use serde_json::{json, Value};

/// Provenance trust grade for corpus sources evaluated by [`ProactiveRag`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SourceProvenance {
    Extracted,
    Inferred,
    Ambiguous,
}

impl SourceProvenance {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Extracted => "EXTRACTED",
            Self::Inferred => "INFERRED",
            Self::Ambiguous => "AMBIGUOUS",
        }
    }
}

/// Source document indexed into [`ProactiveRag`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorpusSource {
    pub id: String,
    pub title: String,
    pub locator: String,
    pub content: String,
    pub keywords: Vec<String>,
    pub provenance: SourceProvenance,
    pub is_superseded: bool,
    pub freshness_label: String,
}

impl CorpusSource {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "id": self.id,
            "title": self.title,
            "locator": self.locator,
            "content": SecretRedactor::redact(&self.content),
            "keywords": self.keywords,
            "provenance": self.provenance.as_str(),
            "is_superseded": self.is_superseded,
            "freshness_label": self.freshness_label,
        }))
    }
}

/// Cited evidence item with relevance score and claim-grounded excerpt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroundedEvidenceItem {
    pub source_id: String,
    pub title: String,
    pub locator: String,
    pub excerpt: String,
    pub relevance_bps: u32,
    pub provenance: SourceProvenance,
}

impl GroundedEvidenceItem {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "source_id": self.source_id,
            "title": self.title,
            "locator": self.locator,
            "excerpt": SecretRedactor::redact(&self.excerpt),
            "relevance_bps": self.relevance_bps,
            "provenance": self.provenance.as_str(),
        }))
    }
}

/// Excluded source candidate explaining why it was withheld from citations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnusedSourceNote {
    pub source_id: String,
    pub locator: String,
    pub exclusion_reason: String,
}

impl UnusedSourceNote {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "source_id": self.source_id,
            "locator": self.locator,
            "exclusion_reason": self.exclusion_reason,
        })
    }
}

/// Query decomposition plan produced before retrieval.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RagSubQuery {
    pub sub_query_id: String,
    pub text: String,
    pub intent: String,
}

impl RagSubQuery {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "sub_query_id": self.sub_query_id,
            "text": self.text,
            "intent": self.intent,
        })
    }
}

/// Full proactive uncertainty-triggered retrieval and grounding package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProactiveRagResult {
    pub query: String,
    pub language: String,
    pub uncertainty_score_bps: u32,
    pub should_retrieve: bool,
    pub sub_queries: Vec<RagSubQuery>,
    pub cited_sources: Vec<GroundedEvidenceItem>,
    pub unused_sources: Vec<UnusedSourceNote>,
    pub synthesis: String,
}

impl ProactiveRagResult {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "query": SecretRedactor::redact(&self.query),
            "language": self.language,
            "uncertainty_score_bps": self.uncertainty_score_bps,
            "should_retrieve": self.should_retrieve,
            "sub_queries": self.sub_queries.iter().map(RagSubQuery::to_json).collect::<Vec<_>>(),
            "cited_sources": self.cited_sources.iter().map(GroundedEvidenceItem::to_json).collect::<Vec<_>>(),
            "unused_sources": self.unused_sources.iter().map(UnusedSourceNote::to_json).collect::<Vec<_>>(),
            "synthesis": SecretRedactor::redact(&self.synthesis),
        }))
    }
}

impl Serialize for ProactiveRagResult {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Fold accented Vietnamese characters (NFC or NFD) and uppercase ASCII into
/// accent-insensitive lowercase ASCII for reliable bilingual matching.
#[must_use]
pub fn fold_vietnamese_ascii(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ('\u{0300}'..='\u{036F}').contains(&ch) {
            continue;
        }
        out.push(fold_vietnamese_char(ch));
    }
    out
}

fn fold_vietnamese_char(ch: char) -> char {
    match ch {
        'á' | 'à' | 'ả' | 'ã' | 'ạ' | 'ă' | 'ắ' | 'ằ' | 'ẳ' | 'ẵ' | 'ặ' | 'â' | 'ấ' | 'ầ'
        | 'ẩ' | 'ẫ' | 'ậ' | 'Á' | 'À' | 'Ả' | 'Ã' | 'Ạ' | 'Ă' | 'Ắ' | 'Ằ' | 'Ẳ' | 'Ẵ' | 'Ặ'
        | 'Â' | 'Ấ' | 'Ầ' | 'Ẩ' | 'Ẫ' | 'Ậ' => 'a',
        'é' | 'è' | 'ẻ' | 'ẽ' | 'ẹ' | 'ê' | 'ế' | 'ề' | 'ể' | 'ễ' | 'ệ' | 'É' | 'È' | 'Ẻ'
        | 'Ẽ' | 'Ẹ' | 'Ê' | 'Ế' | 'Ề' | 'Ể' | 'Ễ' | 'Ệ' => 'e',
        'í' | 'ì' | 'ỉ' | 'ĩ' | 'ị' | 'Í' | 'Ì' | 'Ỉ' | 'Ĩ' | 'Ị' => 'i',
        'ó' | 'ò' | 'ỏ' | 'õ' | 'ọ' | 'ô' | 'ố' | 'ồ' | 'ổ' | 'ỗ' | 'ộ' | 'ơ' | 'ớ' | 'ờ'
        | 'ở' | 'ỡ' | 'ợ' | 'Ó' | 'Ò' | 'Ỏ' | 'Õ' | 'Ọ' | 'Ô' | 'Ố' | 'Ồ' | 'Ổ' | 'Ỗ' | 'Ộ'
        | 'Ơ' | 'Ớ' | 'Ờ' | 'Ở' | 'Ỡ' | 'Ợ' => 'o',
        'ú' | 'ù' | 'ủ' | 'ũ' | 'ụ' | 'ư' | 'ứ' | 'ừ' | 'ử' | 'ữ' | 'ự' | 'Ú' | 'Ù' | 'Ủ'
        | 'Ũ' | 'Ụ' | 'Ư' | 'Ứ' | 'Ừ' | 'Ử' | 'Ữ' | 'Ự' => 'u',
        'ý' | 'ỳ' | 'ỷ' | 'ỹ' | 'ỵ' | 'Ý' | 'Ỳ' | 'Ỷ' | 'Ỹ' | 'Ỵ' => 'y',
        'đ' | 'Đ' => 'd',
        other => other.to_ascii_lowercase(),
    }
}

/// Detect accented Vietnamese letters in precomposed or decomposed text, including đ/Đ.
///
/// ```
/// use omnia_harness::has_vietnamese_diacritics;
///
/// assert!(has_vietnamese_diacritics("m\u{00e1}")); // precomposed á
/// assert!(has_vietnamese_diacritics("ma\u{0301}")); // decomposed á
/// assert!(!has_vietnamese_diacritics("b\u{0301}")); // not a Vietnamese vowel
/// ```
#[must_use]
pub fn has_vietnamese_diacritics(input: &str) -> bool {
    let mut base = '\0';
    for ch in input.chars() {
        if ch.is_ascii() {
            base = ch.to_ascii_lowercase();
            continue;
        }
        if fold_vietnamese_char(ch).is_ascii() {
            return true;
        }
        let accented = match ch {
            '\u{0300}' | '\u{0301}' | '\u{0303}' | '\u{0309}' | '\u{0323}' => {
                matches!(base, 'a' | 'e' | 'i' | 'o' | 'u' | 'y')
            }
            '\u{0302}' => matches!(base, 'a' | 'e' | 'o'),
            '\u{0306}' => base == 'a',
            '\u{031B}' => matches!(base, 'o' | 'u'),
            _ => false,
        };
        if accented {
            return true;
        }
        base = '\0';
    }
    false
}

/// Tokenize normalized ASCII into distinct keyword tokens (`len >= 2`), expanding
/// common bilingual Vietnamese/English domain terms.
#[must_use]
pub fn tokenize_folded(text: &str) -> BTreeSet<String> {
    let folded = fold_vietnamese_ascii(text);
    let mut base_tokens = Vec::new();
    let mut cur = String::new();
    for ch in folded.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            cur.push(ch);
        } else if !cur.is_empty() {
            if cur.len() >= 2 {
                base_tokens.push(std::mem::take(&mut cur));
            } else {
                cur.clear();
            }
        }
    }
    if cur.len() >= 2 {
        base_tokens.push(cur);
    }

    let mut out = BTreeSet::new();
    for tok in &base_tokens {
        out.insert(tok.clone());
    }
    // Cross-lingual expansions for unaccented or accented Vietnamese technical terms
    let joined = format!(" {} ", base_tokens.join(" "));
    if joined.contains(" han muc ") || joined.contains(" han-muc ") {
        for syn in ["quota", "emergency", "stale", "limit"] {
            out.insert(syn.to_owned());
        }
    }
    if joined.contains(" dinh tuyen ") {
        for syn in ["router", "routing", "fallback", "circuit"] {
            out.insert(syn.to_owned());
        }
    }
    if joined.contains(" bo nho ") {
        for syn in ["memory", "erasure", "graph", "receipt"] {
            out.insert(syn.to_owned());
        }
    }
    if joined.contains(" giao thuc ") || joined.contains(" do thi ") {
        for syn in ["peer", "mesh", "duplex", "graphify", "hop"] {
            out.insert(syn.to_owned());
        }
    }
    if joined.contains(" soan thao ") {
        for syn in ["composer", "steer", "additive", "queue"] {
            out.insert(syn.to_owned());
        }
    }
    if joined.contains(" kien truc ") || joined.contains(" thiet ke ") {
        for syn in ["architecture", "design", "router", "mesh", "wal"] {
            out.insert(syn.to_owned());
        }
    }
    if joined.contains(" luu tru ") {
        for syn in ["sqlite", "wal", "storage", "session"] {
            out.insert(syn.to_owned());
        }
    }
    if joined.contains(" bao mat ") {
        for syn in ["cors", "origin", "loopback", "token"] {
            out.insert(syn.to_owned());
        }
    }
    out
}

/// Proactive uncertainty-driven bilingual EN/VN RAG planner and citation gate.
#[derive(Debug)]
pub struct ProactiveRag {
    corpus: Mutex<Vec<CorpusSource>>,
}

impl Default for ProactiveRag {
    fn default() -> Self {
        Self::new()
    }
}

impl ProactiveRag {
    #[must_use]
    pub fn new() -> Self {
        Self {
            corpus: Mutex::new(Vec::new()),
        }
    }

    /// Construct a [`ProactiveRag`] instance pre-indexed from a workspace directory.
    #[must_use]
    pub fn from_workspace(root: &std::path::Path) -> Self {
        let rag = Self::new();
        let _ = rag.index_workspace(root);
        rag
    }

    /// Replace or insert a corpus source keyed by `id`.
    pub fn upsert_source(&self, source: CorpusSource) {
        let Ok(mut guard) = self.corpus.lock() else {
            return;
        };
        if let Some(existing) = guard.iter_mut().find(|s| s.id == source.id) {
            *existing = source;
        } else {
            guard.push(source);
        }
    }

    /// Index readable UTF-8 workspace files (skipping build/git/secret files and reparse points).
    pub fn index_workspace(&self, root: &std::path::Path) -> usize {
        let Ok(canon_root) = std::fs::canonicalize(root) else {
            return 0;
        };
        let mut files = Vec::new();
        collect_workspace_files_bounded(&canon_root, &canon_root, &mut files, 96);
        let mut added = 0usize;
        for file in files {
            let Ok(bytes) = std::fs::read(&file) else {
                continue;
            };
            if bytes.is_empty() || bytes.len() > 256 * 1024 || bytes.iter().take(1024).any(|&b| b == 0)
            {
                continue;
            }
            let Ok(raw_text) = String::from_utf8(bytes) else {
                continue;
            };
            let rel = file
                .strip_prefix(&canon_root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| file.to_string_lossy().replace('\\', "/"));
            let scrubbed = omnia_core::SecretRedactor::redact(&raw_text);
            let title = scrubbed
                .lines()
                .find(|l| !l.trim().is_empty())
                .map(|l| l.trim().trim_start_matches('#').trim().to_owned())
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| rel.clone());
            let snippet = omnia_core::truncate_utf8_word_safe(&scrubbed, 1_600);
            let kw: Vec<String> = tokenize_folded(&format!("{rel} {title} {snippet}"))
                .into_iter()
                .take(48)
                .collect();
            self.upsert_source(CorpusSource {
                id: format!("ws:{rel}"),
                title: omnia_core::truncate_utf8_word_safe(&title, 120),
                locator: rel,
                content: snippet,
                keywords: kw,
                provenance: SourceProvenance::Extracted,
                is_superseded: false,
                freshness_label: "workspace".to_owned(),
            });
            added += 1;
        }
        added
    }

    /// Index active, non-quarantined entries from [`crate::memory_graph::MemoryGraph`].
    pub fn index_memory_graph(&self, memory: &crate::memory_graph::MemoryGraph) -> usize {
        let Ok(entries) = memory.list_entries() else {
            return 0;
        };
        let mut added = 0usize;
        for entry in entries {
            if entry.quarantined || entry.tainted || entry.t_invalid_ms.is_some() {
                continue;
            }
            let provenance = if entry.provenance.is_trusted() {
                SourceProvenance::Extracted
            } else if entry.provenance == crate::memory_graph::MemoryProvenance::AgentDerived {
                SourceProvenance::Inferred
            } else {
                SourceProvenance::Ambiguous
            };
            let content = omnia_core::SecretRedactor::redact(&entry.content);
            let mut kw: Vec<String> = tokenize_folded(&format!(
                "{} {} {}",
                entry.namespace_path, entry.key, content
            ))
            .into_iter()
            .take(48)
            .collect();
            for tag in &entry.tags {
                let low = fold_vietnamese_ascii(tag);
                if !low.is_empty() && !kw.contains(&low) {
                    kw.push(low);
                }
            }
            self.upsert_source(CorpusSource {
                id: format!("mem:{}", entry.id),
                title: format!("{}/{}", entry.namespace_path, entry.key),
                locator: format!("memory://{}/{}", entry.namespace_path, entry.key),
                content,
                keywords: kw,
                provenance,
                is_superseded: entry.t_invalid_ms.is_some(),
                freshness_label: if entry.t_invalid_ms.is_some() {
                    "superseded".to_owned()
                } else {
                    "active_memory".to_owned()
                },
            });
            added += 1;
        }
        added
    }

    /// Clear all indexed sources.
    pub fn clear(&self) {
        if let Ok(mut guard) = self.corpus.lock() {
            guard.clear();
        }
    }

    pub fn add_source(&self, source: CorpusSource) {
        if let Ok(mut guard) = self.corpus.lock() {
            if let Some(existing) = guard.iter_mut().find(|s| s.id == source.id) {
                *existing = source;
            } else {
                guard.push(source);
            }
        }
    }

    #[must_use]
    pub fn sources(&self) -> Vec<CorpusSource> {
        self.corpus
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    /// Plan bilingual retrieval and rank eligible evidence against the query.
    /// A zero citation budget retains retrieval decisions but cites no sources.
    /// Canonically equivalent Vietnamese text gets the same language routing.
    ///
    /// ```
    /// use omnia_harness::ProactiveRag;
    ///
    /// let rag = ProactiveRag::new();
    /// for query in ["m\u{00e1}?", "ma\u{0301}?"] {
    ///     let plan = rag.plan_and_retrieve(query, 1);
    ///     assert_eq!(plan.language, "vi");
    ///     assert!(plan.sub_queries.iter().any(|q| q.intent == "bilingual_cross_reference"));
    /// }
    /// ```
    #[must_use]
    pub fn plan_and_retrieve(&self, query: &str, max_citations: usize) -> ProactiveRagResult {
        let folded = fold_vietnamese_ascii(query);
        let language = detect_language(query, &folded);
        let tokens = tokenize_folded(query);
        let uncertainty_score_bps = compute_uncertainty_bps(query, &folded, &tokens);
        let should_retrieve = uncertainty_score_bps >= 2_500;
        let sub_queries = build_sub_queries(query, language, &tokens);

        let mut cited_sources = Vec::new();
        let mut unused_sources = Vec::new();

        if should_retrieve {
            let sources = self.sources();
            let query_tris = char_trigrams_ascii(query);
            let avg_doc_tokens = if sources.is_empty() {
                1.0
            } else {
                sources
                    .iter()
                    .map(|s| tokenize_folded(&format!("{} {} {}", s.title, s.locator, s.content)).len())
                    .sum::<usize>() as f64
                    / sources.len() as f64
            };
            let mut scored_valid: Vec<GroundedEvidenceItem> = Vec::new();

            for src in sources {
                if src.is_superseded {
                    unused_sources.push(UnusedSourceNote {
                        source_id: src.id,
                        locator: src.locator,
                        exclusion_reason: "superseded_historical_artifact".to_owned(),
                    });
                    continue;
                }
                if src.provenance == SourceProvenance::Ambiguous {
                    unused_sources.push(UnusedSourceNote {
                        source_id: src.id,
                        locator: src.locator,
                        exclusion_reason: "quarantined_ambiguous_provenance".to_owned(),
                    });
                    continue;
                }
                let score = score_source_hybrid(&src, &tokens, &query_tris, avg_doc_tokens);
                if score < 1_000 {
                    unused_sources.push(UnusedSourceNote {
                        source_id: src.id,
                        locator: src.locator,
                        exclusion_reason: "below_relevance_threshold".to_owned(),
                    });
                    continue;
                }
                scored_valid.push(GroundedEvidenceItem {
                    source_id: src.id,
                    title: src.title,
                    locator: src.locator,
                    excerpt: omnia_core::truncate_utf8_word_safe(&src.content, 240),
                    relevance_bps: score,
                    provenance: src.provenance,
                });
            }

            scored_valid.sort_by(|a, b| {
                b.relevance_bps
                    .cmp(&a.relevance_bps)
                    .then_with(|| a.source_id.cmp(&b.source_id))
            });

            for (idx, item) in scored_valid.into_iter().enumerate() {
                if idx < max_citations {
                    cited_sources.push(item);
                } else {
                    unused_sources.push(UnusedSourceNote {
                        source_id: item.source_id,
                        locator: item.locator,
                        exclusion_reason: "outside_top_k_citation_budget".to_owned(),
                    });
                }
            }
        }

        let synthesis = if should_retrieve && max_citations == 0 {
            "No sources cited: citation budget is zero.".to_owned()
        } else {
            build_synthesis(language, should_retrieve, &cited_sources)
        };
        ProactiveRagResult {
            query: query.to_owned(),
            language: language.to_owned(),
            uncertainty_score_bps,
            should_retrieve,
            sub_queries,
            cited_sources,
            unused_sources,
            synthesis,
        }
    }
}

fn detect_language(raw: &str, folded: &str) -> &'static str {
    let normalized_words: String = folded
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect();
    let padded = format!(" {normalized_words} ");
    let vi_markers = [
        " tai sao ",
        " kien truc ",
        " nhu the nao ",
        " han muc ",
        " bo nho ",
        " lap lich ",
        " khac biet ",
        " la gi ",
        " hoat dong ",
        " tieng viet ",
        " giai thich ",
        " lam sao ",
        " so sanh ",
        " dinh tuyen ",
        " giao thuc ",
        " soan thao ",
        " luu tru ",
        " bao mat ",
    ];
    let has_vi = has_vietnamese_diacritics(raw) || vi_markers.iter().any(|m| padded.contains(m));

    let en_markers = [
        " how ",
        " why ",
        " what ",
        " when ",
        " where ",
        " which ",
        " explain ",
        " compare ",
        " does ",
        " should ",
        " between ",
        " versus ",
        " with ",
        " and ",
    ];
    let has_en = en_markers.iter().any(|m| padded.contains(m));

    match (has_vi, has_en) {
        (true, true) => "bilingual",
        (true, false) => "vi",
        (false, _) => "en",
    }
}

fn compute_uncertainty_bps(raw: &str, folded: &str, tokens: &BTreeSet<String>) -> u32 {
    let mut score: u32 = 2_000;
    if raw.contains('?') {
        score += 1_500;
    }
    let question_words = [
        "how",
        "why",
        "what",
        "which",
        "when",
        "compare",
        "explain",
        "verify",
        "proof",
        "tai sao",
        "nhu the nao",
        "kien truc",
        "la gi",
        "lam sao",
        "so sanh",
        "giai thich",
        "han muc",
        "dinh tuyen",
        "bo nho",
    ];
    for qw in question_words {
        if folded.contains(qw) {
            score += 1_200;
        }
    }
    if tokens.len() >= 4 {
        score += 1_000;
    } else if tokens.len() >= 2 && raw.trim().len() >= 10 {
        score += 600;
    }
    score.min(10_000)
}

fn build_sub_queries(raw: &str, language: &str, tokens: &BTreeSet<String>) -> Vec<RagSubQuery> {
    let keyword_summary = tokens.iter().take(6).cloned().collect::<Vec<_>>().join(" ");
    let mut out = vec![
        RagSubQuery {
            sub_query_id: "sq-primary".to_owned(),
            text: raw.trim().to_owned(),
            intent: "direct_requirement_lookup".to_owned(),
        },
        RagSubQuery {
            sub_query_id: "sq-keywords".to_owned(),
            text: keyword_summary,
            intent: "canonical_symbol_and_contract_match".to_owned(),
        },
        RagSubQuery {
            sub_query_id: "sq-verification".to_owned(),
            text: format!("{} tests receipts invariants", fold_vietnamese_ascii(raw)),
            intent: "evidence_and_test_oracle_check".to_owned(),
        },
    ];
    if language == "vi" || language == "bilingual" {
        out.push(RagSubQuery {
            sub_query_id: "sq-bilingual".to_owned(),
            text: tokens.iter().cloned().collect::<Vec<_>>().join(" "),
            intent: "bilingual_cross_reference".to_owned(),
        });
    }
    out
}

fn score_source(src: &CorpusSource, query_tokens: &BTreeSet<String>) -> u32 {
    if query_tokens.is_empty() {
        return 0;
    }
    let title_tokens = tokenize_folded(&src.title);
    let content_tokens = tokenize_folded(&src.content);
    let mut kw_tokens = BTreeSet::new();
    for kw in &src.keywords {
        for tok in tokenize_folded(kw) {
            kw_tokens.insert(tok);
        }
    }

    let mut score: u32 = 0;
    for tok in query_tokens {
        if kw_tokens.contains(tok) {
            score += 1_800;
        }
        if title_tokens.contains(tok) {
            score += 1_200;
        }
        if content_tokens.contains(tok) {
            score += 700;
        }
    }
    if src.provenance == SourceProvenance::Extracted && score > 0 {
        score += 500;
    }
    score.min(10_000)
}

fn build_synthesis(
    language: &str,
    should_retrieve: bool,
    cited: &[GroundedEvidenceItem],
) -> String {
    if !should_retrieve {
        return "Query uncertainty below retrieval threshold; no proactive retrieval triggered."
            .to_owned();
    }
    if cited.is_empty() {
        return "No verified non-ambiguous corpus sources met the relevance threshold.".to_owned();
    }
    let refs: Vec<String> = cited
        .iter()
        .map(|c| format!("{} ({})", c.title, c.locator))
        .collect();
    if language == "vi" {
        format!("Nguon xac minh lien quan: {}", refs.join("; "))
    } else {
        format!("Grounded verified sources: {}", refs.join("; "))
    }
}

fn is_safe_workspace_text_ext(path: &std::path::Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref(),
        Some(
            "rs" | "md"
                | "txt"
                | "toml"
                | "json"
                | "yml"
                | "yaml"
                | "ts"
                | "tsx"
                | "js"
                | "jsx"
                | "py"
                | "go"
                | "ps1"
                | "sql"
        )
    )
}

fn is_reparse_or_symlink(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return true;
        }
    }
    false
}

fn is_excluded_workspace_entry(name: &str) -> bool {
    let low = name.to_ascii_lowercase();
    matches!(
        low.as_str(),
        ".git"
            | "target"
            | "node_modules"
            | "build"
            | "dist"
            | "__pycache__"
            | ".venv"
            | "venv"
            | "roaming"
            | ".env"
            | "id_rsa"
            | "id_ed25519"
    ) || low.ends_with(".pem")
        || low.ends_with(".key")
        || low.ends_with(".pfx")
}

fn collect_workspace_files_bounded(
    canon_root: &std::path::Path,
    cur: &std::path::Path,
    out: &mut Vec<std::path::PathBuf>,
    max_files: usize,
) {
    if out.len() >= max_files {
        return;
    }
    let Ok(entries) = std::fs::read_dir(cur) else {
        return;
    };
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_excluded_workspace_entry(&name) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if is_reparse_or_symlink(&meta) {
            continue;
        }
        if meta.is_dir() {
            dirs.push(path);
        } else if meta.is_file() && meta.len() <= 256 * 1024 && is_safe_workspace_text_ext(&path) {
            files.push(path);
        }
    }
    dirs.sort();
    files.sort();
    for f in files {
        if out.len() >= max_files {
            return;
        }
        if let Ok(canon) = std::fs::canonicalize(&f) {
            if canon.starts_with(canon_root) {
                out.push(canon);
            }
        }
    }
    for d in dirs {
        if out.len() >= max_files {
            return;
        }
        collect_workspace_files_bounded(canon_root, &d, out, max_files);
    }
}

fn char_trigrams_ascii(text: &str) -> std::collections::BTreeSet<[u8; 3]> {
    let folded = fold_vietnamese_ascii(text);
    let bytes = folded.as_bytes();
    let mut out = std::collections::BTreeSet::new();
    if bytes.len() < 3 {
        return out;
    }
    for w in bytes.windows(3) {
        if w.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_') {
            out.insert([w[0], w[1], w[2]]);
        }
    }
    out
}

fn score_source_hybrid(
    src: &CorpusSource,
    query_tokens: &BTreeSet<String>,
    query_tris: &std::collections::BTreeSet<[u8; 3]>,
    avg_doc_tokens: f64,
) -> u32 {
    let base = score_source(src, query_tokens);
    let doc_text = format!("{} {} {}", src.title, src.locator, src.content);
    let doc_tokens = tokenize_folded(&doc_text);
    let doc_len = (doc_tokens.len() as f64).max(1.0);

    let overlap = query_tokens.iter().filter(|q| doc_tokens.contains(*q)).count();
    let k1 = 1.5;
    let b = 0.75;
    let tf = overlap as f64;
    let bm25_norm = if tf > 0.0 {
        (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * (doc_len / avg_doc_tokens.max(1.0))))
    } else {
        0.0
    };

    let mut tri_bonus = 0u32;
    if !query_tris.is_empty() {
        let doc_tris = char_trigrams_ascii(&doc_text);
        if !doc_tris.is_empty() {
            let hits = query_tris.intersection(&doc_tris).count();
            let ratio = hits as f64 / query_tris.len() as f64;
            tri_bonus = (ratio * 1_600.0).round() as u32;
        }
    }

    let bm25_bonus = (bm25_norm * 1_400.0).round() as u32;
    base.saturating_add(bm25_bonus).saturating_add(tri_bonus)
}

#[cfg(test)]
mod tests {
    use super::ProactiveRag;
    use crate::memory_graph::{MemoryGraph, MemoryTier};
    use crate::{CorpusSource, SourceProvenance};
    use std::fs;

    #[test]
    fn default_rag_has_zero_hardcoded_fixtures_and_indexes_workspace_and_memory() {
        let empty = ProactiveRag::new();
        assert!(empty.sources().is_empty());

        let dir = std::env::temp_dir().join(format!("omnia_rag_ws_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("docs")).expect("mkdir");
        fs::write(
            dir.join("docs/routing.md"),
            "# Loopback CORS & Router Limits\nDynamicProviderRouter validates Origin headers and preserves tokenBudget = null.\n",
        )
        .expect("write md");

        let rag = ProactiveRag::from_workspace(&dir);
        assert!(!rag.sources().is_empty());

        let memory = MemoryGraph::new();
        memory
            .upsert(
                "omnia/memory",
                "session-persist",
                MemoryTier::Durable,
                "Omnia Studio persists sessions via SessionStore SQLite WAL mode.",
                &[],
                Some(100),
            )
            .expect("upsert memory");
        assert_eq!(rag.index_memory_graph(&memory), 1);

        let allowed = rag.plan_and_retrieve("How does loopback CORS work?", 1);
        assert_eq!(allowed.cited_sources.len(), 1);

        let blocked = rag.plan_and_retrieve("How does loopback CORS work?", 0);
        assert!(blocked.should_retrieve);
        assert!(blocked.cited_sources.is_empty());
        assert!(blocked.unused_sources.iter().any(|note| {
            note.source_id == allowed.cited_sources[0].source_id
                && note.exclusion_reason == "outside_top_k_citation_budget"
        }));
        assert!(blocked.synthesis.contains("citation budget is zero"));

        let mem_q = rag.plan_and_retrieve("SessionStore SQLite WAL", 2);
        assert!(mem_q
            .cited_sources
            .iter()
            .any(|s| s.source_id.starts_with("mem:")));

        rag.upsert_source(CorpusSource {
            id: "src-manual".to_owned(),
            title: "Manual Entry".to_owned(),
            locator: "notes/manual.md".to_owned(),
            content: "Extra manual source document.".to_owned(),
            keywords: vec!["manual".to_owned(), "source".to_owned()],
            provenance: SourceProvenance::Extracted,
            is_superseded: false,
            freshness_label: "current".to_owned(),
        });
        assert!(rag.sources().iter().any(|s| s.id == "src-manual"));

        let _ = fs::remove_dir_all(&dir);
    }
}
