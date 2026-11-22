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
        let mapped = match ch {
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
        };
        out.push(mapped);
    }
    out
}

/// Return true if `input` contains any accented Vietnamese character or đ/Đ.
#[must_use]
pub fn has_vietnamese_diacritics(input: &str) -> bool {
    input.chars().any(|ch| {
        matches!(
            ch,
            'đ' | 'Đ' | 'ă' | 'Ă' | 'â' | 'Â' | 'ê' | 'Ê' | 'ô' | 'Ô' | 'ơ' | 'Ơ' | 'ư' | 'Ư'
        ) || ('\u{1EA0}'..='\u{1EF9}').contains(&ch)
            || matches!(
                ch,
                'á' | 'à'
                    | 'ã'
                    | 'é'
                    | 'è'
                    | 'í'
                    | 'ì'
                    | 'ó'
                    | 'ò'
                    | 'õ'
                    | 'ú'
                    | 'ù'
                    | 'ý'
                    | 'Á'
                    | 'À'
                    | 'Ã'
                    | 'É'
                    | 'È'
                    | 'Í'
                    | 'Ì'
                    | 'Ó'
                    | 'Ò'
                    | 'Õ'
                    | 'Ú'
                    | 'Ù'
                    | 'Ý'
            )
    })
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
            corpus: Mutex::new(default_omnia_corpus()),
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
                let score = score_source(&src, &tokens);
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

            let limit = max_citations.max(1);
            for (idx, item) in scored_valid.into_iter().enumerate() {
                if idx < limit {
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

        let synthesis = build_synthesis(language, should_retrieve, &cited_sources);
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

fn default_omnia_corpus() -> Vec<CorpusSource> {
    vec![
        CorpusSource {
            id: "src-dynamic-router".to_owned(),
            title: "DynamicProviderRouter & Quota Truthfulness".to_owned(),
            locator: "docs/workspace/DYNAMIC_ROUTING_REQUIREMENTS.md".to_owned(),
            content: "Deterministic provider/model router with Known, Unknown, Stale, and Contradictory quota states, token_budget strictly defaulting to None, circuit breakers, fencing tokens, and secret-free JSON route receipts.".to_owned(),
            keywords: vec![
                "router", "quota", "circuit", "fallback", "fencing", "budget",
                "dinh tuyen", "han muc",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            provenance: SourceProvenance::Extracted,
            is_superseded: false,
            freshness_label: "current".to_owned(),
        },
        CorpusSource {
            id: "src-peer-mesh".to_owned(),
            title: "Bidirectional Agent Peer Mesh & Graphify".to_owned(),
            locator: "docs/handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md".to_owned(),
            content: "Bidirectional A<->B peer mesh with disjoint_paths ownership, read_since cursor wakeup, max_hops/epoch cycle guards, and Graphify EXTRACTED/INFERRED/AMBIGUOUS provenance traversal.".to_owned(),
            keywords: vec![
                "peer", "mesh", "duplex", "graphify", "disjoint", "hop", "epoch",
                "giao thuc", "do thi",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            provenance: SourceProvenance::Extracted,
            is_superseded: false,
            freshness_label: "current".to_owned(),
        },
        CorpusSource {
            id: "src-session-wal".to_owned(),
            title: "Durable SQLite WAL Session Storage".to_owned(),
            locator: "docs/workspace/ARCHITECTURE.md".to_owned(),
            content: "Out-of-source C++20/Rust winsqlite3 WAL persistence stores durable sessions, audit events, and memory erasure receipts without keeping unredacted secrets.".to_owned(),
            keywords: vec!["sqlite", "wal", "session", "storage", "luu tru", "memory", "erasure"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            provenance: SourceProvenance::Extracted,
            is_superseded: false,
            freshness_label: "current".to_owned(),
        },
        CorpusSource {
            id: "src-cors-loopback".to_owned(),
            title: "Studio Loopback Origin & CORS Contract".to_owned(),
            locator: "docs/workspace/GOAL.md".to_owned(),
            content: "Studio HTTP server enforces strict 127.0.0.1 loopback binding, explicit Origin/CORS allowlist validation, and preflight method controls.".to_owned(),
            keywords: vec!["cors", "loopback", "origin", "studio", "bao mat", "http"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            provenance: SourceProvenance::Extracted,
            is_superseded: false,
            freshness_label: "current".to_owned(),
        },
        CorpusSource {
            id: "src-composer-steer".to_owned(),
            title: "Rich Composer & Additive Steer Queue".to_owned(),
            locator: "docs/workspace/COMPOSER_REQUIREMENTS.md".to_owned(),
            content: "Dual-mode inline vs tray attachments, 15 scientific Math/Phys/Chem LaTeX symbol templates, encrypted PDF guards, and ADDITIVE_INTAKE SteerQueue preserving unfinished tasks with token_budget None.".to_owned(),
            keywords: vec![
                "composer", "steer", "additive", "attachment", "latex", "pdf",
                "soan thao", "bo nho",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            provenance: SourceProvenance::Extracted,
            is_superseded: false,
            freshness_label: "current".to_owned(),
        },
        CorpusSource {
            id: "src-ambiguous-draft".to_owned(),
            title: "Unverified Experimental Scratch Note".to_owned(),
            locator: "docs/drafts/unverified.md".to_owned(),
            content: "Speculative unverified router shortcut hypothesis pending verification.".to_owned(),
            keywords: vec!["router", "quota", "draft", "speculative"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            provenance: SourceProvenance::Ambiguous,
            is_superseded: false,
            freshness_label: "draft".to_owned(),
        },
        CorpusSource {
            id: "src-legacy-tauri-superseded".to_owned(),
            title: "Retired Rust/Tauri Architecture Snapshot".to_owned(),
            locator: "archive/pre-cpp-rust-snapshot-20261112".to_owned(),
            content: "Superseded pre-migration Tauri webview IPC notes replaced by native Flagship Studio.".to_owned(),
            keywords: vec!["tauri", "legacy", "router", "architecture"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            provenance: SourceProvenance::Extracted,
            is_superseded: true,
            freshness_label: "superseded".to_owned(),
        },
    ]
}
