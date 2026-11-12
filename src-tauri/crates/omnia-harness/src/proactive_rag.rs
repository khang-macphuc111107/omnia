//! Proactive query-uncertainty assessment, multi-query decomposition, and
//! hybrid Web + Hierarchical/Graph Memory RAG with cited vs unused source ledgers.
//!
//! Per `PRODUCT-MEMORY` and `PRODUCT-GRAPH`, Omnia detects prompt uncertainty
//! (mutable/time-sensitive state, external named specs/models/APIs, broad
//! architectural comparisons, or underspecified troubleshooting shorthand)
//! without waiting for the user to type `"search"`. It decomposes the prompt
//! into diverse deduplicated sub-queries across web search and local
//! hierarchical/graph memory, expands high-confidence graph neighbors, and
//! emits a transparent ledger separating cited sources from explicitly unused
//! or filtered candidates.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::memory::{
    load_all_memories_in_scope, EdgeProvenance, FreshnessState, LoadedMemoryRecord,
};
use crate::tools::SearchBackend;

// ---------------------------------------------------------------------------
// Uncertainty Assessment
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UncertaintySignal {
    TimeSensitiveOrMutableState,
    ExternalNamedEntitiesOrSpecs,
    BroadArchitecturalOrComparativeScope,
    AmbiguousOrUnderspecifiedShorthand,
    ExplicitVerificationNeed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UncertaintyAssessment {
    pub should_trigger_proactive_search: bool,
    pub uncertainty_score_bps: u16,
    pub signals: Vec<UncertaintySignal>,
    pub recommended_web_queries: usize,
    pub recommended_memory_queries: usize,
    pub rationale: String,
}

/// Evaluates whether a user prompt warrants proactive multi-query retrieval
/// without requiring explicit `"search"` / `"web"` keywords.
pub fn assess_prompt_uncertainty(prompt: &str) -> UncertaintyAssessment {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return UncertaintyAssessment {
            should_trigger_proactive_search: false,
            uncertainty_score_bps: 0,
            signals: Vec::new(),
            recommended_web_queries: 0,
            recommended_memory_queries: 0,
            rationale: "Empty prompt requires no external retrieval.".to_string(),
        };
    }

    let lower = trimmed.to_lowercase();
    let word_count = trimmed.split_whitespace().count();
    let mut signals = BTreeSet::new();
    let mut score: u32 = 0;

    // 1. Time-sensitive / mutable state indicators (English + Vietnamese + recent years).
    let year_re = Regex::new(r"\b202[4-9]\b|\b203[0-2]\b").expect("valid year regex");
    let temporal_terms = [
        "latest",
        "current",
        "currently",
        "recent",
        "recently",
        "today",
        "now",
        "release",
        "changelog",
        "roadmap",
        "pricing",
        "quota",
        "rate limit",
        "benchmark",
        "deprecated",
        "deprecation",
        "breaking change",
        "status",
        "outage",
        "mới nhất",
        "hiện tại",
        "gần đây",
        "hôm nay",
        "phiên bản",
        "cập nhật",
        "lộ trình",
        "giá",
        "hạn mức",
    ];
    if year_re.is_match(&lower) || temporal_terms.iter().any(|t| contains_phrase(&lower, t)) {
        signals.insert(UncertaintySignal::TimeSensitiveOrMutableState);
        score += 3_600;
    }

    // 2. Named external entities, technical specs, RFCs/CVEs, model/framework identifiers.
    let spec_re = Regex::new(
        r"(?i)\b(?:rfc[-\s]?\d+|cve-\d{4}-\d+|iso[-\s]?\d+|wcag\s*\d(?:\.\d)?|fips[-\s]?\d+|http/[23]|oauth\s*2|tls\s*1\.[23]|v\d+\.\d+(?:\.\d+)?)\b",
    )
    .expect("valid spec regex");
    let identifier_re =
        Regex::new(r"\b[A-Za-z]+(?:-[A-Za-z0-9]+){1,4}\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b")
            .expect("valid identifier regex");
    let ecosystem_terms = [
        "openai",
        "anthropic",
        "gemini",
        "claude",
        "llama",
        "mistral",
        "qwen",
        "deepseek",
        "tauri",
        "tokio",
        "rusqlite",
        "reqwest",
        "win32",
        "uiautomation",
        "webview2",
        "directwrite",
        "kubernetes",
        "postgres",
        "sqlite",
        "graphql",
        "grpc",
    ];
    let camel_or_kebab_hits = identifier_re.find_iter(trimmed).count();
    if spec_re.is_match(trimmed)
        || camel_or_kebab_hits >= 2
        || ecosystem_terms.iter().any(|t| contains_phrase(&lower, t))
    {
        signals.insert(UncertaintySignal::ExternalNamedEntitiesOrSpecs);
        score += 2_800;
    }

    // 3. Broad architectural, comparative, or multi-facet synthesis prompts.
    let comparative_terms = [
        "compare",
        "comparison",
        "versus",
        " vs ",
        "tradeoff",
        "trade-off",
        "pros and cons",
        "architecture",
        "best practice",
        "alternatives",
        "difference between",
        "how should we design",
        "end-to-end",
        "production-grade",
        "so sánh",
        "kiến trúc",
        "ưu nhược điểm",
        "khác nhau",
        "thiết kế hệ thống",
        "tối ưu",
    ];
    if comparative_terms.iter().any(|t| contains_phrase(&lower, t)) {
        signals.insert(UncertaintySignal::BroadArchitecturalOrComparativeScope);
        score += 3_000;
    }

    // 4. Ambiguous shorthand, error codes, or multi-clause diagnostic questions.
    let error_code_re = Regex::new(
        r"(?i)\b(?:0x[0-9a-f]{4,}|errno\s*\d+|http\s*[45]\d{2}|error\s+[a-z0-9_-]{3,})\b",
    )
    .expect("valid error code regex");
    let question_marks = trimmed.matches('?').count();
    let diagnostic_terms = [
        "why does",
        "why is",
        "intermittent",
        "root cause",
        "workaround",
        "undocumented",
        "edge case",
        "tại sao",
        "nguyên nhân",
        "lỗi",
        "không hoạt động",
    ];
    if error_code_re.is_match(trimmed)
        || question_marks >= 2
        || (word_count >= 6 && diagnostic_terms.iter().any(|t| contains_phrase(&lower, t)))
    {
        signals.insert(UncertaintySignal::AmbiguousOrUnderspecifiedShorthand);
        score += 2_600;
    }

    // 5. Explicit grounding / verification / source requests (even without the word "search").
    let verification_terms = [
        "verify",
        "fact-check",
        "fact check",
        "citation",
        "citations",
        "cite",
        "official docs",
        "official documentation",
        "specification",
        "reference",
        "search",
        "look up",
        "kiểm chứng",
        "dẫn chứng",
        "nguồn",
        "tài liệu chính thức",
        "tra cứu",
        "tìm kiếm",
    ];
    if verification_terms
        .iter()
        .any(|t| contains_phrase(&lower, t))
    {
        signals.insert(UncertaintySignal::ExplicitVerificationNeed);
        score += 3_800;
    }

    // Dampen trivial local mechanical edits (e.g. "rename foo to bar", "2 + 2").
    let trivial_local_prefixes = [
        "rename ",
        "format this json",
        "convert this json",
        "translate this sentence",
        "fix typo in ",
    ];
    if signals.is_empty()
        || (word_count <= 7
            && !signals.contains(&UncertaintySignal::TimeSensitiveOrMutableState)
            && !signals.contains(&UncertaintySignal::ExplicitVerificationNeed)
            && trivial_local_prefixes.iter().any(|p| lower.starts_with(p)))
    {
        score = score.min(1_500);
    }

    let capped_bps = score.min(10_000) as u16;
    let should_trigger = capped_bps >= 3_000 || signals.len() >= 2;
    let signal_vec: Vec<UncertaintySignal> = signals.into_iter().collect();

    let (recommended_web_queries, recommended_memory_queries) = if !should_trigger {
        (0, if word_count >= 4 { 1 } else { 0 })
    } else if capped_bps >= 7_500 || signal_vec.len() >= 3 {
        (4, 3)
    } else if capped_bps >= 5_000 || signal_vec.len() >= 2 {
        (3, 2)
    } else {
        (2, 2)
    };

    let rationale = if should_trigger {
        format!(
            "Proactive multi-query retrieval triggered (score={} bps, signals={:?}).",
            capped_bps, signal_vec
        )
    } else {
        format!(
            "Prompt appears self-contained or low-uncertainty (score={} bps); external web fan-out skipped.",
            capped_bps
        )
    };

    UncertaintyAssessment {
        should_trigger_proactive_search: should_trigger,
        uncertainty_score_bps: capped_bps,
        signals: signal_vec,
        recommended_web_queries,
        recommended_memory_queries,
        rationale,
    }
}

fn contains_phrase(haystack_lower: &str, phrase: &str) -> bool {
    if phrase.starts_with(' ') || phrase.ends_with(' ') || phrase.contains(' ') {
        haystack_lower.contains(phrase)
    } else {
        haystack_lower
            .split(|c: char| !c.is_alphanumeric() && c != '-' && c != '_')
            .any(|tok| tok == phrase)
    }
}

// ---------------------------------------------------------------------------
// Multi-Query Decomposition
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryChannel {
    WebSearch,
    LocalMemory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryAngle {
    PrimaryConcept,
    SpecificationOrDocs,
    RecentChangesOrStatus,
    FailureModesOrTradeoffs,
    LocalWorkspaceMemory,
    GraphNeighborhood,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannedQuery {
    pub query_id: String,
    pub channel: QueryChannel,
    pub angle: QueryAngle,
    pub query: String,
    pub canonical_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecompositionConfig {
    pub max_web_queries: usize,
    pub max_memory_queries: usize,
    pub current_year: u16,
    /// Force decomposition even if uncertainty assessment would otherwise skip web fan-out.
    pub force_proactive: bool,
}

impl Default for DecompositionConfig {
    fn default() -> Self {
        Self {
            max_web_queries: 4,
            max_memory_queries: 3,
            current_year: 2026,
            force_proactive: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecomposedQueryPlan {
    pub assessment: UncertaintyAssessment,
    pub extracted_entities: Vec<String>,
    pub queries: Vec<PlannedQuery>,
}

/// Decomposes an uncertain or multi-faceted prompt into diverse, deduplicated
/// web-search and local-memory queries.
pub fn decompose_proactive_queries(
    prompt: &str,
    config: &DecompositionConfig,
) -> DecomposedQueryPlan {
    let assessment = assess_prompt_uncertainty(prompt);
    let entities = extract_key_terms(prompt);
    let clauses = split_prompt_facets(prompt);
    let core_subject = build_core_subject(prompt, &entities);

    let mut queries = Vec::new();
    let mut seen_keys: HashSet<(u8, String)> = HashSet::new();

    let web_budget = if config.force_proactive {
        config.max_web_queries.max(2)
    } else if assessment.should_trigger_proactive_search {
        assessment
            .recommended_web_queries
            .min(config.max_web_queries)
    } else {
        0
    };

    let mem_budget = if config.force_proactive {
        config.max_memory_queries.max(2)
    } else {
        assessment
            .recommended_memory_queries
            .max(usize::from(!entities.is_empty()))
            .min(config.max_memory_queries)
    };

    // Local hierarchical + graph memory queries first (zero network cost, workspace grounding).
    let mut mem_candidates: Vec<(QueryAngle, String)> = Vec::new();
    if !core_subject.is_empty() {
        mem_candidates.push((QueryAngle::LocalWorkspaceMemory, core_subject.clone()));
    }
    if entities.len() >= 2 {
        mem_candidates.push((
            QueryAngle::GraphNeighborhood,
            entities
                .iter()
                .take(4)
                .cloned()
                .collect::<Vec<_>>()
                .join(" "),
        ));
    }
    for clause in clauses.iter().skip(1) {
        let cleaned = build_core_subject(clause, &[]);
        if !cleaned.is_empty() {
            mem_candidates.push((QueryAngle::LocalWorkspaceMemory, cleaned));
        }
    }

    let mut mem_added = 0;
    for (angle, q_raw) in mem_candidates {
        if mem_added >= mem_budget {
            break;
        }
        let key = canonical_query_key(&q_raw);
        if key.is_empty() || !seen_keys.insert((0, key.clone())) {
            continue;
        }
        mem_added += 1;
        queries.push(PlannedQuery {
            query_id: format!("mem-q{mem_added}"),
            channel: QueryChannel::LocalMemory,
            angle,
            query: q_raw,
            canonical_key: key,
        });
    }

    // External web search decomposition across orthogonal angles.
    if web_budget > 0 && !core_subject.is_empty() {
        let mut web_candidates: Vec<(QueryAngle, String)> = Vec::new();
        web_candidates.push((QueryAngle::PrimaryConcept, core_subject.clone()));

        if assessment
            .signals
            .contains(&UncertaintySignal::TimeSensitiveOrMutableState)
        {
            let year_str = config.current_year.to_string();
            let temporal_q = if core_subject.contains(&year_str) {
                format!("{core_subject} release changelog status")
            } else {
                format!("{core_subject} {year_str} latest updates")
            };
            web_candidates.push((QueryAngle::RecentChangesOrStatus, temporal_q));
        }

        if assessment
            .signals
            .contains(&UncertaintySignal::ExternalNamedEntitiesOrSpecs)
            || assessment
                .signals
                .contains(&UncertaintySignal::ExplicitVerificationNeed)
        {
            web_candidates.push((
                QueryAngle::SpecificationOrDocs,
                format!("{core_subject} official documentation specification"),
            ));
        }

        if assessment
            .signals
            .contains(&UncertaintySignal::BroadArchitecturalOrComparativeScope)
            || assessment
                .signals
                .contains(&UncertaintySignal::AmbiguousOrUnderspecifiedShorthand)
        {
            web_candidates.push((
                QueryAngle::FailureModesOrTradeoffs,
                format!("{core_subject} architecture tradeoffs edge cases"),
            ));
        }

        for clause in clauses.iter().skip(1) {
            let facet_subj = build_core_subject(clause, &[]);
            if facet_subj.split_whitespace().count() >= 2 {
                web_candidates.push((QueryAngle::PrimaryConcept, facet_subj));
            }
        }

        // Ensure at least 2 orthogonal angles when web_budget >= 2.
        if web_candidates.len() < 2 {
            web_candidates.push((
                QueryAngle::SpecificationOrDocs,
                format!("{core_subject} reference guide {}", config.current_year),
            ));
        }

        let mut web_added = 0;
        for (angle, q_raw) in web_candidates {
            if web_added >= web_budget {
                break;
            }
            let key = canonical_query_key(&q_raw);
            if key.is_empty() || !seen_keys.insert((1, key.clone())) {
                continue;
            }
            web_added += 1;
            queries.push(PlannedQuery {
                query_id: format!("web-q{web_added}"),
                channel: QueryChannel::WebSearch,
                angle,
                query: q_raw,
                canonical_key: key,
            });
        }
    }

    DecomposedQueryPlan {
        assessment,
        extracted_entities: entities,
        queries,
    }
}

fn split_prompt_facets(prompt: &str) -> Vec<String> {
    prompt
        .split(['?', ';', '\n'])
        .map(str::trim)
        .filter(|s| s.split_whitespace().count() >= 3)
        .map(ToOwned::to_owned)
        .collect()
}

fn extract_key_terms(prompt: &str) -> Vec<String> {
    let stopwords: HashSet<&'static str> = [
        "the", "and", "for", "with", "that", "this", "from", "what", "when", "where", "which",
        "how", "why", "does", "should", "would", "could", "into", "about", "between", "have",
        "has", "are", "was", "were", "can", "please", "tell", "explain", "search", "find", "show",
        "give", "using", "used", "use", "need", "want", "make", "những", "trong", "của", "cho",
        "với", "như", "thế", "nào", "tại", "sao", "hãy", "giúp", "tôi", "các", "một", "này", "khi",
        "cần",
    ]
    .into_iter()
    .collect();

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw_tok in prompt.split(|c: char| {
        c.is_whitespace()
            || matches!(
                c,
                ',' | '.' | ':' | ';' | '?' | '!' | '(' | ')' | '[' | ']' | '"' | '\''
            )
    }) {
        let tok = raw_tok.trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_');
        if tok.chars().count() < 2 {
            continue;
        }
        let lower = tok.to_lowercase();
        if stopwords.contains(lower.as_str()) {
            continue;
        }
        if seen.insert(lower) {
            out.push(tok.to_string());
        }
        if out.len() >= 12 {
            break;
        }
    }
    out
}

fn build_core_subject(text: &str, fallback_entities: &[String]) -> String {
    let terms = extract_key_terms(text);
    let chosen = if terms.is_empty() {
        fallback_entities
            .iter()
            .take(7)
            .cloned()
            .collect::<Vec<_>>()
    } else {
        terms.into_iter().take(8).collect::<Vec<_>>()
    };
    chosen.join(" ")
}

fn canonical_query_key(query: &str) -> String {
    let mut tokens: Vec<String> = query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '-' && c != '_')
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    tokens.sort();
    tokens.dedup();
    tokens.join(" ")
}

// ---------------------------------------------------------------------------
// Hybrid Retrieval & Cited vs Unused Source Ledger
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProactiveRetrievalConfig {
    pub decomposition: DecompositionConfig,
    pub max_web_results_per_query: usize,
    pub max_cited_sources: usize,
    pub max_context_chars: usize,
    pub min_relevance_bps: u16,
    pub graph_expansion_hops: usize,
    pub include_ambiguous_graph_edges: bool,
    pub now_ms: u64,
}

impl Default for ProactiveRetrievalConfig {
    fn default() -> Self {
        Self {
            decomposition: DecompositionConfig::default(),
            max_web_results_per_query: 5,
            max_cited_sources: 8,
            max_context_chars: 12_000,
            min_relevance_bps: 1_800,
            graph_expansion_hops: 2,
            include_ambiguous_graph_edges: false,
            now_ms: crate::memory::now_epoch_ms(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceKind {
    Web {
        backend: String,
    },
    LocalMemory {
        scope: String,
        namespace: String,
    },
    GraphNeighbor {
        from_node_id: String,
        relation: String,
        provenance: EdgeProvenance,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CitedSource {
    pub citation_index: usize,
    pub source_id: String,
    pub canonical_target: String,
    pub kind: SourceKind,
    pub title: String,
    pub snippet: String,
    pub relevance_bps: u16,
    pub matched_queries: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reason_code", rename_all = "snake_case")]
pub enum UnusedReason {
    DuplicateCanonicalTarget {
        kept_source_id: String,
    },
    LowRelevance {
        score_bps: u16,
        threshold_bps: u16,
    },
    SupersededMemory {
        superseded_by: String,
    },
    ExpiredWorkingMemory {
        expired_at_ms: u64,
    },
    AmbiguousGraphProvenance {
        from_node_id: String,
        relation: String,
    },
    OverContextBudget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnusedSource {
    pub source_id: String,
    pub canonical_target: String,
    pub title: String,
    pub reason: UnusedReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutedQueryRecord {
    pub query_id: String,
    pub channel: QueryChannel,
    pub angle: QueryAngle,
    pub query: String,
    pub backend_name: String,
    pub raw_hit_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProactiveResearchReport {
    pub assessment: UncertaintyAssessment,
    pub plan: DecomposedQueryPlan,
    pub executed_queries: Vec<ExecutedQueryRecord>,
    pub cited_sources: Vec<CitedSource>,
    pub unused_sources: Vec<UnusedSource>,
    pub warnings: Vec<String>,
}

impl ProactiveResearchReport {
    /// Renders a transparent audit ledger distinguishing executed queries,
    /// cited sources (`[1..N]`), and explicitly filtered/unused sources.
    pub fn format_ledger_markdown(&self) -> String {
        let mut out = String::new();
        out.push_str("## Proactive Research & Memory Ledger\n\n");
        out.push_str(&format!(
            "- Uncertainty score: `{}` bps (proactive_web=`{}`)\n",
            self.assessment.uncertainty_score_bps, self.assessment.should_trigger_proactive_search
        ));

        out.push_str("\n### Executed Queries\n");
        if self.executed_queries.is_empty() {
            out.push_str("- (none)\n");
        } else {
            for q in &self.executed_queries {
                match &q.error {
                    Some(err) => out.push_str(&format!(
                        "- `{}` [{:?} / {}]: `{}` -> ERROR ({})\n",
                        q.query_id, q.angle, q.backend_name, q.query, err
                    )),
                    None => out.push_str(&format!(
                        "- `{}` [{:?} / {}]: `{}` -> {} raw hits\n",
                        q.query_id, q.angle, q.backend_name, q.query, q.raw_hit_count
                    )),
                }
            }
        }

        out.push_str("\n### Cited Sources\n");
        if self.cited_sources.is_empty() {
            out.push_str("- (no sources met relevance and freshness gates)\n");
        } else {
            for c in &self.cited_sources {
                out.push_str(&format!(
                    "- `[{}]` **{}** (`{}`) — relevance `{} bps` via {:?}\n",
                    c.citation_index,
                    c.title,
                    c.canonical_target,
                    c.relevance_bps,
                    c.matched_queries
                ));
            }
        }

        out.push_str("\n### Unused / Filtered Sources\n");
        if self.unused_sources.is_empty() {
            out.push_str("- (none)\n");
        } else {
            for u in &self.unused_sources {
                out.push_str(&format!(
                    "- **{}** (`{}`) — {:?}\n",
                    u.title, u.canonical_target, u.reason
                ));
            }
        }
        out
    }
}

struct CandidateHit {
    source_id: String,
    canonical_target: String,
    kind: SourceKind,
    title: String,
    snippet: String,
    relevance_bps: u16,
    matched_queries: Vec<String>,
}

pub struct ProactiveRetriever;

impl ProactiveRetriever {
    pub async fn retrieve(
        prompt: &str,
        cwd: &Path,
        omnia_home: Option<&Path>,
        web_backend: Option<&dyn SearchBackend>,
        config: &ProactiveRetrievalConfig,
    ) -> ProactiveResearchReport {
        let plan = decompose_proactive_queries(prompt, &config.decomposition);
        let prompt_terms = extract_key_terms(prompt);

        let mut executed_queries = Vec::new();
        let mut warnings = Vec::new();
        let mut unused_sources = Vec::new();
        let mut raw_candidates: Vec<CandidateHit> = Vec::new();

        // 1. Load local hierarchical + graph memories from user & project scopes.
        let mut all_memories: Vec<LoadedMemoryRecord> = Vec::new();
        let mut graphs = HashMap::new();
        for scope in ["user", "project"] {
            if scope == "user" && omnia_home.is_none() {
                continue;
            }
            match load_all_memories_in_scope(scope, cwd, omnia_home, config.now_ms) {
                Ok((records, graph)) => {
                    all_memories.extend(records);
                    graphs.insert(scope.to_string(), graph);
                }
                Err(err) => warnings.push(format!("memory load warning ({scope}): {err}")),
            }
        }

        // Partition active vs superseded/expired memories upfront when touched by local queries.
        let mem_queries: Vec<&PlannedQuery> = plan
            .queries
            .iter()
            .filter(|q| q.channel == QueryChannel::LocalMemory)
            .collect();

        let mut lifecycle_recorded: HashSet<String> = HashSet::new();
        let mut seed_active_ids: HashMap<String, Vec<String>> = HashMap::new();
        let records_by_id: HashMap<String, &LoadedMemoryRecord> = all_memories
            .iter()
            .map(|r| (r.node_id.clone(), r))
            .collect();

        for pq in &mem_queries {
            let q_terms = extract_key_terms(&pq.query);
            let mut hits_for_query = 0usize;

            for rec in &all_memories {
                let score = score_text_relevance(
                    &prompt_terms,
                    &q_terms,
                    &rec.doc.name,
                    &format!("{} {}", rec.doc.description, rec.doc.body),
                );
                if score == 0 {
                    continue;
                }
                hits_for_query += 1;
                match &rec.freshness {
                    FreshnessState::Superseded { superseded_by } => {
                        if lifecycle_recorded.insert(rec.node_id.clone()) {
                            unused_sources.push(UnusedSource {
                                source_id: rec.node_id.clone(),
                                canonical_target: rec.node_id.clone(),
                                title: rec.doc.name.clone(),
                                reason: UnusedReason::SupersededMemory {
                                    superseded_by: superseded_by.clone(),
                                },
                            });
                        }
                    }
                    FreshnessState::Expired { expired_at_ms } => {
                        if lifecycle_recorded.insert(rec.node_id.clone()) {
                            unused_sources.push(UnusedSource {
                                source_id: rec.node_id.clone(),
                                canonical_target: rec.node_id.clone(),
                                title: rec.doc.name.clone(),
                                reason: UnusedReason::ExpiredWorkingMemory {
                                    expired_at_ms: *expired_at_ms,
                                },
                            });
                        }
                    }
                    FreshnessState::Fresh | FreshnessState::Stale { .. } => {
                        seed_active_ids
                            .entry(rec.scope.clone())
                            .or_default()
                            .push(rec.node_id.clone());
                        raw_candidates.push(CandidateHit {
                            source_id: rec.node_id.clone(),
                            canonical_target: rec.node_id.clone(),
                            kind: SourceKind::LocalMemory {
                                scope: rec.scope.clone(),
                                namespace: rec.namespace.clone(),
                            },
                            title: rec.doc.name.clone(),
                            snippet: summarize_memory_snippet(rec),
                            relevance_bps: score,
                            matched_queries: vec![pq.query_id.clone()],
                        });
                    }
                }
            }

            executed_queries.push(ExecutedQueryRecord {
                query_id: pq.query_id.clone(),
                channel: QueryChannel::LocalMemory,
                angle: pq.angle,
                query: pq.query.clone(),
                backend_name: "omnia-memory-tree+graph".to_string(),
                raw_hit_count: hits_for_query,
                error: None,
            });
        }

        // 2. Graph neighborhood expansion across `EXTRACTED` / `INFERRED` edges (quarantining `AMBIGUOUS`).
        if config.graph_expansion_hops > 0 {
            for (scope, seeds) in &seed_active_ids {
                let Some(graph) = graphs.get(scope) else {
                    continue;
                };
                // Inspect full subgraph including ambiguous edges so we can explicitly log quarantined ones.
                let full_sub = graph.traverse_subgraph(seeds, config.graph_expansion_hops, true);
                let seed_set: HashSet<&String> = seeds.iter().collect();

                for edge in &full_sub.traversed_edges {
                    let candidate_id = if !seed_set.contains(&edge.to_id) {
                        &edge.to_id
                    } else if !seed_set.contains(&edge.from_id) {
                        &edge.from_id
                    } else {
                        continue;
                    };
                    let Some(target_rec) = records_by_id.get(candidate_id) else {
                        continue;
                    };
                    if edge.provenance == EdgeProvenance::Ambiguous
                        && !config.include_ambiguous_graph_edges
                    {
                        if lifecycle_recorded.insert(format!("ambig:{}", target_rec.node_id)) {
                            unused_sources.push(UnusedSource {
                                source_id: target_rec.node_id.clone(),
                                canonical_target: target_rec.node_id.clone(),
                                title: target_rec.doc.name.clone(),
                                reason: UnusedReason::AmbiguousGraphProvenance {
                                    from_node_id: edge.from_id.clone(),
                                    relation: edge.relation.clone(),
                                },
                            });
                        }
                        continue;
                    }
                    if !target_rec.freshness.is_active() {
                        continue;
                    }
                    let base_rel = match edge.provenance {
                        EdgeProvenance::Extracted => 5_200,
                        EdgeProvenance::Inferred => 3_800,
                        EdgeProvenance::Ambiguous => 2_200,
                    };
                    raw_candidates.push(CandidateHit {
                        source_id: target_rec.node_id.clone(),
                        canonical_target: target_rec.node_id.clone(),
                        kind: SourceKind::GraphNeighbor {
                            from_node_id: edge.from_id.clone(),
                            relation: edge.relation.clone(),
                            provenance: edge.provenance,
                        },
                        title: target_rec.doc.name.clone(),
                        snippet: summarize_memory_snippet(target_rec),
                        relevance_bps: base_rel.max(config.min_relevance_bps),
                        matched_queries: vec!["graph-hop".to_string()],
                    });
                }
            }
        }

        // 3. Execute decomposed external web queries when a `SearchBackend` is supplied.
        for pq in plan
            .queries
            .iter()
            .filter(|q| q.channel == QueryChannel::WebSearch)
        {
            let Some(backend) = web_backend else {
                warnings.push(format!(
                    "Skipped web query `{}` because no SearchBackend was configured.",
                    pq.query_id
                ));
                continue;
            };
            match backend
                .search(&pq.query, config.max_web_results_per_query)
                .await
            {
                Ok(results) => {
                    let q_terms = extract_key_terms(&pq.query);
                    let hit_count = results.len();
                    for (idx, item) in results.into_iter().enumerate() {
                        let canonical_url = canonicalize_url(&item.url);
                        let rank_bonus = (500_u16).saturating_sub((idx as u16) * 80);
                        let lexical = score_text_relevance(
                            &prompt_terms,
                            &q_terms,
                            &item.title,
                            &item.snippet,
                        );
                        let score = lexical.saturating_add(rank_bonus).min(10_000);
                        raw_candidates.push(CandidateHit {
                            source_id: format!("{}:{}", pq.query_id, idx + 1),
                            canonical_target: canonical_url,
                            kind: SourceKind::Web {
                                backend: backend.name().to_string(),
                            },
                            title: item.title,
                            snippet: item.snippet,
                            relevance_bps: score,
                            matched_queries: vec![pq.query_id.clone()],
                        });
                    }
                    executed_queries.push(ExecutedQueryRecord {
                        query_id: pq.query_id.clone(),
                        channel: QueryChannel::WebSearch,
                        angle: pq.angle,
                        query: pq.query.clone(),
                        backend_name: backend.name().to_string(),
                        raw_hit_count: hit_count,
                        error: None,
                    });
                }
                Err(err) => {
                    warnings.push(format!(
                        "Web search query `{}` failed on `{}`: {err}",
                        pq.query_id,
                        backend.name()
                    ));
                    executed_queries.push(ExecutedQueryRecord {
                        query_id: pq.query_id.clone(),
                        channel: QueryChannel::WebSearch,
                        angle: pq.angle,
                        query: pq.query.clone(),
                        backend_name: backend.name().to_string(),
                        raw_hit_count: 0,
                        error: Some(err),
                    });
                }
            }
        }

        // 4. Deterministic ranking, canonical deduplication, relevance gating, and budget enforcement.
        raw_candidates.sort_by(|a, b| {
            b.relevance_bps
                .cmp(&a.relevance_bps)
                .then_with(|| a.canonical_target.cmp(&b.canonical_target))
                .then_with(|| a.source_id.cmp(&b.source_id))
        });

        let mut kept_by_target: HashMap<String, usize> = HashMap::new();
        let mut deduped: Vec<CandidateHit> = Vec::new();
        for hit in raw_candidates {
            if let Some(&existing_idx) = kept_by_target.get(&hit.canonical_target) {
                for qid in &hit.matched_queries {
                    if !deduped[existing_idx].matched_queries.contains(qid) {
                        deduped[existing_idx].matched_queries.push(qid.clone());
                    }
                }
                if hit.source_id != deduped[existing_idx].source_id {
                    unused_sources.push(UnusedSource {
                        source_id: hit.source_id,
                        canonical_target: hit.canonical_target,
                        title: hit.title,
                        reason: UnusedReason::DuplicateCanonicalTarget {
                            kept_source_id: deduped[existing_idx].source_id.clone(),
                        },
                    });
                }
                continue;
            }
            let idx = deduped.len();
            kept_by_target.insert(hit.canonical_target.clone(), idx);
            deduped.push(hit);
        }

        let mut cited_sources = Vec::new();
        let mut used_chars = 0usize;
        for hit in deduped {
            if hit.relevance_bps < config.min_relevance_bps {
                unused_sources.push(UnusedSource {
                    source_id: hit.source_id,
                    canonical_target: hit.canonical_target,
                    title: hit.title,
                    reason: UnusedReason::LowRelevance {
                        score_bps: hit.relevance_bps,
                        threshold_bps: config.min_relevance_bps,
                    },
                });
                continue;
            }
            let entry_chars = hit.title.chars().count() + hit.snippet.chars().count();
            if cited_sources.len() >= config.max_cited_sources
                || (used_chars > 0 && used_chars + entry_chars > config.max_context_chars)
            {
                unused_sources.push(UnusedSource {
                    source_id: hit.source_id,
                    canonical_target: hit.canonical_target,
                    title: hit.title,
                    reason: UnusedReason::OverContextBudget,
                });
                continue;
            }
            used_chars += entry_chars;
            cited_sources.push(CitedSource {
                citation_index: cited_sources.len() + 1,
                source_id: hit.source_id,
                canonical_target: hit.canonical_target,
                kind: hit.kind,
                title: hit.title,
                snippet: hit.snippet,
                relevance_bps: hit.relevance_bps,
                matched_queries: hit.matched_queries,
            });
        }

        ProactiveResearchReport {
            assessment: plan.assessment.clone(),
            plan,
            executed_queries,
            cited_sources,
            unused_sources,
            warnings,
        }
    }
}

fn summarize_memory_snippet(rec: &LoadedMemoryRecord) -> String {
    let combined = if rec.doc.description.is_empty() {
        rec.doc.body.clone()
    } else {
        format!("{} — {}", rec.doc.description, rec.doc.body)
    };
    let clean = combined.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= 280 {
        clean
    } else {
        let mut truncated: String = clean.chars().take(280).collect();
        truncated.push_str("...");
        truncated
    }
}

fn score_text_relevance(
    prompt_terms: &[String],
    query_terms: &[String],
    title: &str,
    body: &str,
) -> u16 {
    let title_lower = title.to_lowercase();
    let body_lower = body.to_lowercase();
    let mut union_terms: Vec<String> = Vec::new();
    for t in prompt_terms.iter().chain(query_terms.iter()) {
        let tl = t.to_lowercase();
        if !union_terms.contains(&tl) {
            union_terms.push(tl);
        }
    }
    if union_terms.is_empty() {
        return 0;
    }

    let mut matched = 0u32;
    let mut title_hits = 0u32;
    for term in &union_terms {
        let in_title = title_lower.contains(term.as_str());
        let in_body = body_lower.contains(term.as_str());
        if in_title {
            title_hits += 1;
            matched += 1;
        } else if in_body {
            matched += 1;
        }
    }
    if matched == 0 {
        return 0;
    }
    let coverage_bps = (matched * 8_000) / (union_terms.len() as u32);
    let title_bonus = (title_hits * 900).min(2_000);
    (coverage_bps + title_bonus).min(10_000) as u16
}

/// Canonicalizes HTTP(S) URLs for cross-query deduplication by stripping
/// fragments, trailing slashes, and common tracking parameters (`utm_*`, `ref`).
pub fn canonicalize_url(raw: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(raw.trim()) else {
        return raw.trim().to_string();
    };
    parsed.set_fragment(None);
    let kept_pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(k, _)| {
            let kl = k.to_ascii_lowercase();
            !kl.starts_with("utm_") && kl != "fbclid" && kl != "gclid" && kl != "ref"
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if kept_pairs.is_empty() {
        parsed.set_query(None);
    } else {
        let mut pairs = parsed.query_pairs_mut();
        pairs.clear();
        for (k, v) in kept_pairs {
            pairs.append_pair(&k, &v);
        }
        drop(pairs);
    }
    let s = parsed.to_string();
    if s.ends_with('/') && parsed.path() != "/" {
        s.trim_end_matches('/').to_string()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use serde_json::json;

    use super::*;
    use crate::memory::register as register_memory;
    use crate::tools::SearchResult;
    use crate::{ToolContext, ToolRegistry};

    struct MockSearchBackend {
        calls: Mutex<Vec<String>>,
        responses: HashMap<String, Result<Vec<SearchResult>, String>>,
    }

    #[async_trait]
    impl SearchBackend for MockSearchBackend {
        fn name(&self) -> &str {
            "mock-web"
        }

        async fn search(
            &self,
            query: &str,
            max_results: usize,
        ) -> Result<Vec<SearchResult>, String> {
            self.calls.lock().unwrap().push(query.to_string());
            for (needle, res) in &self.responses {
                if query.to_lowercase().contains(&needle.to_lowercase()) {
                    return res.clone().map(|mut v| {
                        v.truncate(max_results);
                        v
                    });
                }
            }
            Ok(Vec::new())
        }
    }

    #[test]
    fn triggers_proactively_without_search_keyword_in_english_and_vietnamese() {
        // No "search", "web", or "google" keyword present!
        let en = assess_prompt_uncertainty(
            "Compare Tauri WebView2 vs Win32 DirectWrite latency tradeoffs and current 2026 UIA accessibility constraints",
        );
        assert!(en.should_trigger_proactive_search, "{en:?}");
        assert!(en.recommended_web_queries >= 3);
        assert!(en
            .signals
            .contains(&UncertaintySignal::TimeSensitiveOrMutableState));
        assert!(en
            .signals
            .contains(&UncertaintySignal::BroadArchitecturalOrComparativeScope));

        let vi = assess_prompt_uncertainty(
            "So sánh kiến trúc bộ định tuyến quota đa nhà cung cấp phiên bản mới nhất giữa OpenAI và Gemini",
        );
        assert!(vi.should_trigger_proactive_search, "{vi:?}");
        assert!(vi.recommended_web_queries >= 2);

        let trivial = assess_prompt_uncertainty("rename foo to bar");
        assert!(!trivial.should_trigger_proactive_search, "{trivial:?}");
        assert_eq!(trivial.recommended_web_queries, 0);
    }

    #[test]
    fn decomposition_produces_diverse_non_duplicate_queries() {
        let plan = decompose_proactive_queries(
            "Why does Win32 UIAutomation return ControlType.Pane error 0x80040201 in 2026 and what are the official spec alternatives?",
            &DecompositionConfig::default(),
        );
        assert!(plan.assessment.should_trigger_proactive_search);
        let web_qs: Vec<&PlannedQuery> = plan
            .queries
            .iter()
            .filter(|q| q.channel == QueryChannel::WebSearch)
            .collect();
        assert!(
            web_qs.len() >= 2,
            "expected multiple web angles: {web_qs:?}"
        );
        let unique_keys: HashSet<&str> = web_qs.iter().map(|q| q.canonical_key.as_str()).collect();
        assert_eq!(
            unique_keys.len(),
            web_qs.len(),
            "queries must be deduplicated"
        );
    }

    #[tokio::test]
    async fn hybrid_retriever_separates_cited_and_explicit_unused_sources() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let mut reg = ToolRegistry::default();
        register_memory(&mut reg, Some(home.path().to_path_buf()));
        let ctx = ToolContext::new(cwd.path());
        let write_tool = reg.get("memory_write").unwrap();
        let now_ms = 1_750_000_000_000_u64;

        // 1. Old superseded spec.
        write_tool
            .call(
                &ctx,
                json!({
                    "scope": "project",
                    "category": "specs/routing",
                    "slug": "router-v1",
                    "name": "Router V1 Spec",
                    "description": "Legacy quota router",
                    "body": "Old quota router design."
                }),
            )
            .await
            .unwrap();

        // 2. Active superseding spec linking to `breaker-contract` (EXTRACTED) and `weak-note` (AMBIGUOUS).
        write_tool
            .call(
                &ctx,
                json!({
                    "scope": "project",
                    "category": "specs/routing",
                    "slug": "router-v2",
                    "name": "Router V2 Spec",
                    "description": "Deterministic quota router architecture",
                    "body": "Uses atomic quota reservation and [[breaker-contract]].",
                    "supersedes": "router-v1",
                    "edges": [
                        {"to": "weak-note", "relation": "related_to", "provenance": "AMBIGUOUS"}
                    ]
                }),
            )
            .await
            .unwrap();

        // 3. Graph neighbor (`EXTRACTED`) + ambiguous neighbor (`AMBIGUOUS`).
        write_tool
            .call(
                &ctx,
                json!({
                    "scope": "project",
                    "category": "specs/routing",
                    "slug": "breaker-contract",
                    "name": "Circuit Breaker Contract",
                    "description": "Half-open recovery rules",
                    "body": "Closed, Open, and HalfOpen state machine."
                }),
            )
            .await
            .unwrap();
        write_tool
            .call(
                &ctx,
                json!({
                    "scope": "project",
                    "category": "specs/routing",
                    "slug": "weak-note",
                    "name": "Unverified Rumor Note",
                    "description": "Unverified tangent",
                    "body": "Weak tangential speculation."
                }),
            )
            .await
            .unwrap();

        // 4. Expired short-term working memory.
        write_tool
            .call(
                &ctx,
                json!({
                    "scope": "project",
                    "category": "memory/debug",
                    "slug": "expired-quota-scratch",
                    "name": "Expired Quota Scratch",
                    "description": "Temporary quota router scratchpad",
                    "body": "Transient quota router notes.",
                    "tier": "working",
                    "expires_at_ms": now_ms - 1_000
                }),
            )
            .await
            .unwrap();

        // Mock web search returning a strong result, a duplicate URL with utm tracking, and an off-topic hit.
        let mut responses = HashMap::new();
        responses.insert(
            "quota".to_string(),
            Ok(vec![
                SearchResult {
                    title: "Deterministic Provider Quota Routing in 2026".to_string(),
                    url: "https://docs.example.org/routing/quota?utm_source=test#top".to_string(),
                    snippet: "Atomic quota router architecture and circuit breaker tradeoffs."
                        .to_string(),
                },
                SearchResult {
                    title: "Deterministic Provider Quota Routing Mirror".to_string(),
                    url: "https://docs.example.org/routing/quota".to_string(),
                    snippet: "Duplicate canonical URL across query angles.".to_string(),
                },
                SearchResult {
                    title: "Medieval Bread Baking Recipes".to_string(),
                    url: "https://cooking.example.org/sourdough".to_string(),
                    snippet: "Flour, water, salt, and fermentation starter.".to_string(),
                },
            ]),
        );
        let mock_web = MockSearchBackend {
            calls: Mutex::new(Vec::new()),
            responses,
        };

        let cfg = ProactiveRetrievalConfig {
            now_ms,
            min_relevance_bps: 2_000,
            ..ProactiveRetrievalConfig::default()
        };
        let report = ProactiveRetriever::retrieve(
            "Compare deterministic provider quota router architecture and 2026 circuit breaker tradeoffs",
            cwd.path(),
            Some(home.path()),
            Some(&mock_web),
            &cfg,
        )
        .await;

        assert!(report.assessment.should_trigger_proactive_search);
        assert!(!mock_web.calls.lock().unwrap().is_empty());

        // Active spec + EXTRACTED graph neighbor + canonical web doc must be cited.
        let cited_targets: Vec<&str> = report
            .cited_sources
            .iter()
            .map(|c| c.canonical_target.as_str())
            .collect();
        assert!(cited_targets.contains(&"project:specs/routing/router-v2"));
        assert!(cited_targets.contains(&"project:specs/routing/breaker-contract"));
        assert!(cited_targets.contains(&"https://docs.example.org/routing/quota"));

        // Superseded spec, expired working memory, ambiguous graph neighbor, duplicate URL, and low-relevance result must all be in `unused_sources`!
        assert!(report.unused_sources.iter().any(|u| matches!(
            &u.reason,
            UnusedReason::SupersededMemory { superseded_by }
                if u.canonical_target == "project:specs/routing/router-v1"
                    && superseded_by == "project:specs/routing/router-v2"
        )));
        assert!(report.unused_sources.iter().any(|u| matches!(
            &u.reason,
            UnusedReason::ExpiredWorkingMemory { .. }
                if u.canonical_target == "project:memory/debug/expired-quota-scratch"
        )));
        assert!(report.unused_sources.iter().any(|u| matches!(
            &u.reason,
            UnusedReason::AmbiguousGraphProvenance { .. }
                if u.canonical_target == "project:specs/routing/weak-note"
        )));
        assert!(report.unused_sources.iter().any(|u| matches!(
            &u.reason,
            UnusedReason::DuplicateCanonicalTarget { .. }
                if u.canonical_target == "https://docs.example.org/routing/quota"
        )));
        assert!(report.unused_sources.iter().any(|u| matches!(
            &u.reason,
            UnusedReason::LowRelevance { .. }
                if u.canonical_target == "https://cooking.example.org/sourdough"
        )));

        let md = report.format_ledger_markdown();
        assert!(md.contains("### Executed Queries"));
        assert!(md.contains("### Cited Sources"));
        assert!(md.contains("### Unused / Filtered Sources"));
    }
}
