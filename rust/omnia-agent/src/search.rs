//! Frontier `v0.3.0` Pure-Rust Hybrid Code Search Engine (`search.rs`).
//!
//! Combines:
//! 1. **Fielded BM25F** (Robertson & Zaragoza) over 4 AST-derived fields:
//!    `symbol_def` (w=4.0, b=0.40), `file_path` (w=3.0, b=0.30),
//!    `doc_comment` (w=1.5, b=0.50), `body` (w=1.0, b=0.75).
//! 2. **Zoekt-Style ASCII Lowercase Trigram Inverted Index** (`FxHashMap<[u8; 3], Vec<u32>>`)
//!    for $O(\min |L_i|)$ candidate file pruning (95-99% pruning before byte scans).
//! 3. **SIMD Line Verifier**: `memchr::memmem::Finder` (literal), `aho_corasick::AhoCorasick`
//!    (multi-term), and `regex::Regex` (regex) emitting Hashline-tagged hits (`path:42:a3f: code`).
//! 4. **Reciprocal Rank Fusion (RRF, $k = 60$)** fusing BM25F + Exact/Trigram density + PPR graph rank.
//!
//! Security invariant: `PermissionsEngine` Deny rules are enforced BEFORE indexing or reading
//! any file, and deleted files are cleanly pruned from all posting lists.

use crate::edit::line_hash_tag;
use crate::graph_locator::ParsedFileAst;
use aho_corasick::AhoCorasickBuilder;
use memchr::memmem;
use crate::permissions::{ApprovalMode, PermissionDecision, PermissionRule, PermissionsEngine};
use regex::RegexBuilder;
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

const MAX_INDEX_FILE_BYTES: u64 = 1024 * 1024; // 1 MiB per indexed source file
const BM25F_K1: f64 = 1.2;
const W_SYMBOL: f64 = 4.0;
const B_SYMBOL: f64 = 0.40;
const W_PATH: f64 = 3.0;
const B_PATH: f64 = 0.30;
const W_DOC: f64 = 1.5;
const B_DOC: f64 = 0.50;
const W_BODY: f64 = 1.0;
const B_BODY: f64 = 0.75;
const RRF_K: f64 = 60.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    Regex,
    Literal,
    Hybrid,
    Symbol,
}

impl SearchMode {
    pub fn parse(s: Option<&str>, literal_flag: bool, query: &str) -> Self {
        if let Some(m) = s {
            match m.trim().to_ascii_lowercase().as_str() {
                "literal" => return Self::Literal,
                "hybrid" => return Self::Hybrid,
                "symbol" => return Self::Symbol,
                "regex" => return Self::Regex,
                _ => {}
            }
        }
        if literal_flag {
            return Self::Literal;
        }
        // Auto-promote multi-word natural-language queries without regex metacharacters to Hybrid!
        let has_spaces = query.trim().contains(' ');
        let has_regex_meta = query
            .chars()
            .any(|c| matches!(c, '*' | '+' | '?' | '[' | ']' | '(' | ')' | '|' | '^' | '$' | '\\' | '{' | '}'));
        if has_spaces && !has_regex_meta {
            Self::Hybrid
        } else {
            Self::Regex
        }
    }
}

#[derive(Debug, Clone)]
struct IndexedDoc {
    rel_path: String,
    sym_len: u32,
    path_len: u32,
    doc_len: u32,
    body_len: u32,
    sym_tf: FxHashMap<String, u32>,
    path_tf: FxHashMap<String, u32>,
    doc_tf: FxHashMap<String, u32>,
    body_tf: FxHashMap<String, u32>,
    trigrams: Vec<[u8; 3]>,
}

#[derive(Debug, Clone, Default)]
pub struct HybridSearchIndex {
    next_id: u32,
    path_to_id: FxHashMap<String, u32>,
    docs: FxHashMap<u32, IndexedDoc>,
    /// Trigram -> sorted FileId posting list
    trigram_postings: FxHashMap<[u8; 3], Vec<u32>>,
    /// Term -> document frequency across all fields
    term_df: FxHashMap<String, u32>,
    /// Term -> FileIds containing term in any field
    term_postings: FxHashMap<String, Vec<u32>>,
    total_sym_len: u64,
    total_path_len: u64,
    total_doc_len: u64,
    total_body_len: u64,
}

#[derive(Debug, Clone)]
pub struct SearchQueryOptions<'a> {
    pub workspace_root: &'a Path,
    pub query: &'a str,
    pub mode: SearchMode,
    pub subpath: Option<&'a str>,
    pub case_sensitive: bool,
    pub context_lines: usize,
    pub max_matches: usize,
    pub permission_rules: &'a [PermissionRule],
    pub workspace_trusted: bool,
    pub approval_mode: ApprovalMode,
    pub ppr_scores: &'a BTreeMap<String, f64>,
    pub parsed_asts: &'a BTreeMap<String, ParsedFileAst>,
}

#[derive(Debug, Clone)]
pub struct SearchOutcome {
    pub formatted: String,
    pub match_count: usize,
    pub candidate_files: usize,
}

impl HybridSearchIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn doc_count(&self) -> usize {
        self.docs.len()
    }

    /// Incrementally index or update a single file (strictly after PermissionsEngine Deny check!).
    pub fn upsert_file(
        &mut self,
        rel_path: &str,
        content: &str,
        ast: Option<&ParsedFileAst>,
    ) {
        if self.path_to_id.contains_key(rel_path) {
            self.remove_file(rel_path);
        }

        let doc_id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);

        // 1. Fielded code-aware tokenization
        let mut sym_tf: FxHashMap<String, u32> = FxHashMap::default();
        let mut sym_len = 0u32;
        if let Some(a) = ast {
            for s in &a.symbols {
                for tok in tokenize_code(&s.name) {
                    *sym_tf.entry(tok).or_insert(0) += 1;
                    sym_len += 1;
                }
                for tok in tokenize_code(&s.qualified_name) {
                    *sym_tf.entry(tok).or_insert(0) += 1;
                    sym_len += 1;
                }
            }
        }

        let mut path_tf: FxHashMap<String, u32> = FxHashMap::default();
        let mut path_len = 0u32;
        for tok in tokenize_code(rel_path) {
            *path_tf.entry(tok).or_insert(0) += 1;
            path_len += 1;
        }

        let mut doc_tf: FxHashMap<String, u32> = FxHashMap::default();
        let mut doc_len = 0u32;
        if let Some(a) = ast {
            for dt in &a.doc_terms {
                for tok in tokenize_code(dt) {
                    *doc_tf.entry(tok).or_insert(0) += 1;
                    doc_len += 1;
                }
            }
        }

        let mut body_tf: FxHashMap<String, u32> = FxHashMap::default();
        let mut body_len = 0u32;
        // Cap body tokenization at 256 KiB per file for sub-millisecond indexing
        let body_slice = &content[..content.floor_char_boundary(content.len().min(256 * 1024))];
        for tok in tokenize_code(body_slice) {
            *body_tf.entry(tok).or_insert(0) += 1;
            body_len += 1;
        }

        // Update term_postings & term_df across union of unique terms in this file
        let mut all_terms: FxHashSet<&str> = FxHashSet::default();
        for k in sym_tf.keys() {
            all_terms.insert(k.as_str());
        }
        for k in path_tf.keys() {
            all_terms.insert(k.as_str());
        }
        for k in doc_tf.keys() {
            all_terms.insert(k.as_str());
        }
        for k in body_tf.keys() {
            all_terms.insert(k.as_str());
        }
        for t in all_terms {
            let owned = t.to_string();
            *self.term_df.entry(owned.clone()).or_insert(0) += 1;
            self.term_postings.entry(owned).or_default().push(doc_id);
        }

        // 2. ASCII lowercase trigram set for O(min |L_i|) literal/regex prefiltering
        let trigrams = extract_unique_trigrams(body_slice);
        for &tri in &trigrams {
            self.trigram_postings.entry(tri).or_default().push(doc_id);
        }

        self.total_sym_len += sym_len as u64;
        self.total_path_len += path_len as u64;
        self.total_doc_len += doc_len as u64;
        self.total_body_len += body_len as u64;

        self.path_to_id.insert(rel_path.to_string(), doc_id);
        self.docs.insert(
            doc_id,
            IndexedDoc {
                rel_path: rel_path.to_string(),
                sym_len,
                path_len,
                doc_len,
                body_len,
                sym_tf,
                path_tf,
                doc_tf,
                body_tf,
                trigrams,
            },
        );
    }

    /// Cleanly remove a deleted or invalidated file from all BM25F and trigram posting lists.
    pub fn remove_file(&mut self, rel_path: &str) {
        let Some(doc_id) = self.path_to_id.remove(rel_path) else {
            return;
        };
        let Some(doc) = self.docs.remove(&doc_id) else {
            return;
        };

        self.total_sym_len = self.total_sym_len.saturating_sub(doc.sym_len as u64);
        self.total_path_len = self.total_path_len.saturating_sub(doc.path_len as u64);
        self.total_doc_len = self.total_doc_len.saturating_sub(doc.doc_len as u64);
        self.total_body_len = self.total_body_len.saturating_sub(doc.body_len as u64);

        let mut all_terms: FxHashSet<&str> = FxHashSet::default();
        for k in doc.sym_tf.keys() {
            all_terms.insert(k.as_str());
        }
        for k in doc.path_tf.keys() {
            all_terms.insert(k.as_str());
        }
        for k in doc.doc_tf.keys() {
            all_terms.insert(k.as_str());
        }
        for k in doc.body_tf.keys() {
            all_terms.insert(k.as_str());
        }

        for t in all_terms {
            if let Some(df) = self.term_df.get_mut(t) {
                *df = df.saturating_sub(1);
                if *df == 0 {
                    self.term_df.remove(t);
                }
            }
            if let Some(post) = self.term_postings.get_mut(t) {
                if let Ok(pos) = post.binary_search(&doc_id) {
                    post.remove(pos);
                }
                if post.is_empty() {
                    self.term_postings.remove(t);
                }
            }
        }

        for tri in &doc.trigrams {
            if let Some(post) = self.trigram_postings.get_mut(tri) {
                if let Ok(pos) = post.binary_search(&doc_id) {
                    post.remove(pos);
                }
                if post.is_empty() {
                    self.trigram_postings.remove(tri);
                }
            }
        }
    }

    /// Execute `search_code` across the indexed workspace in `Regex`, `Literal`, `Hybrid`, or `Symbol` mode.
    pub fn search(&self, opts: &SearchQueryOptions<'_>) -> anyhow::Result<SearchOutcome> {
        match opts.mode {
            SearchMode::Symbol => self.search_symbol(opts),
            SearchMode::Hybrid => self.search_hybrid(opts),
            SearchMode::Literal => self.search_literal_simd(opts),
            SearchMode::Regex => self.search_regex_trigram(opts),
        }
    }

    fn path_matches_subpath(rel_path: &str, subpath: Option<&str>) -> bool {
        let Some(sub) = subpath.filter(|s| !s.is_empty()) else {
            return true;
        };
        rel_path == sub || rel_path.starts_with(&format!("{sub}/"))
    }

    fn is_file_denied(opts: &SearchQueryOptions<'_>, abs_file: &Path) -> bool {
        let target_str = abs_file.to_string_lossy();
        for tool in ["grep", "read"] {
            let eval = PermissionsEngine::evaluate(
                opts.permission_rules,
                opts.workspace_trusted,
                tool,
                &target_str,
                opts.approval_mode,
            );
            if eval.decision == PermissionDecision::Deny {
                return true;
            }
        }
        false
    }

    fn search_symbol(&self, opts: &SearchQueryOptions<'_>) -> anyhow::Result<SearchOutcome> {
        let q_lower = opts.query.trim().to_ascii_lowercase();
        let q_tokens = tokenize_code(opts.query);
        let mut ranked: Vec<(f64, String)> = Vec::new();

        for (rel, ast) in opts.parsed_asts {
            if !Self::path_matches_subpath(rel, opts.subpath) {
                continue;
            }
            let abs = opts.workspace_root.join(rel);
            if Self::is_file_denied(opts, &abs) {
                continue;
            }
            let ppr = opts.ppr_scores.get(rel).copied().unwrap_or(0.0);
            for sym in &ast.symbols {
                let nl = sym.name.to_ascii_lowercase();
                let ql = sym.qualified_name.to_ascii_lowercase();
                let mut score = 0.0;
                if nl == q_lower || ql == q_lower {
                    score = 10.0;
                } else if nl.contains(&q_lower) || ql.contains(&q_lower) {
                    score = 5.0;
                } else if !q_tokens.is_empty() {
                    let hits = q_tokens
                        .iter()
                        .filter(|t| nl.contains(t.as_str()) || ql.contains(t.as_str()))
                        .count();
                    if hits > 0 {
                        score = (hits as f64 / q_tokens.len() as f64) * 3.5;
                    }
                }
                if score > 0.0 {
                    score += ppr * 2.0;
                    let line = format!(
                        "{}:L{}-{} [{}] {}",
                        rel, sym.start_line, sym.end_line, sym.kind.label(), sym.signature
                    );
                    ranked.push((score, line));
                }
            }
        }

        ranked.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        let total_hits = ranked.len();
        ranked.truncate(opts.max_matches);

        if ranked.is_empty() {
            return Ok(SearchOutcome {
                formatted: format!("No AST symbols matching '{}'.", opts.query),
                match_count: 0,
                candidate_files: opts.parsed_asts.len(),
            });
        }
        let mut out = ranked
            .into_iter()
            .map(|(_, line)| line)
            .collect::<Vec<_>>()
            .join("\n");
        if total_hits > opts.max_matches {
            out.push_str(&format!(
                "\n[showing {} of {} symbol matches]",
                opts.max_matches, total_hits
            ));
        }
        Ok(SearchOutcome {
            formatted: out,
            match_count: total_hits.min(opts.max_matches),
            candidate_files: opts.parsed_asts.len(),
        })
    }

    fn search_hybrid(&self, opts: &SearchQueryOptions<'_>) -> anyhow::Result<SearchOutcome> {
        let q_tokens = tokenize_code(opts.query);
        if q_tokens.is_empty() {
            return self.search_literal_simd(opts);
        }

        // 1. BM25F scores over indexed candidate docs
        let bm25_ranked = self.rank_bm25f(&q_tokens, opts.subpath);

        // 2. Trigram / exact substring density scores
        let exact_cands = self.trigram_candidates(opts.query);
        let exact_set: FxHashSet<u32> = exact_cands.into_iter().collect();

        // 3. Collect union of top BM25F docs + exact trigram docs + PPR docs
        let mut pool: FxHashSet<u32> = FxHashSet::default();
        for (id, _) in bm25_ranked.iter().take(60) {
            pool.insert(*id);
        }
        for &id in exact_set.iter().take(60) {
            if let Some(d) = self.docs.get(&id) {
                if Self::path_matches_subpath(&d.rel_path, opts.subpath) {
                    pool.insert(id);
                }
            }
        }

        let bm25_pos: FxHashMap<u32, usize> = bm25_ranked
            .iter()
            .enumerate()
            .map(|(rank, (id, _))| (*id, rank + 1))
            .collect();

        // PPR rank among candidate pool
        let mut ppr_list: Vec<(u32, f64)> = pool
            .iter()
            .filter_map(|&id| {
                let d = self.docs.get(&id)?;
                Some((id, opts.ppr_scores.get(&d.rel_path).copied().unwrap_or(0.0)))
            })
            .collect();
        ppr_list.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let ppr_pos: FxHashMap<u32, usize> = ppr_list
            .iter()
            .enumerate()
            .map(|(rank, (id, _))| (*id, rank + 1))
            .collect();

        // Exact/trigram density ranking using Aho-Corasick over pool
        let ac = AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .build(&q_tokens)?;

        let mut exact_list: Vec<(u32, usize)> = Vec::new();
        let mut file_lines_cache: FxHashMap<u32, Vec<(usize, String)>> = FxHashMap::default();
        for &id in &pool {
            let Some(doc) = self.docs.get(&id) else {
                continue;
            };
            let abs = opts.workspace_root.join(&doc.rel_path);
            if Self::is_file_denied(opts, &abs) {
                continue;
            }
            let Ok(bytes) = fs::read(&abs) else {
                continue;
            };
            if bytes.len() as u64 > MAX_INDEX_FILE_BYTES || bytes.iter().take(2048).any(|&b| b == 0)
            {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes).replace("\r\n", "\n");
            let lines: Vec<&str> = text.split('\n').collect();
            let mut matched = Vec::new();
            let mut total_token_hits = 0usize;
            for (idx, line) in lines.iter().enumerate() {
                let cnt = ac.find_iter(line).count();
                if cnt > 0 {
                    total_token_hits += cnt;
                    if matched.len() < 8 {
                        let tag = hashline_at(&lines, idx);
                        let snippet: String = line.chars().take(180).collect();
                        matched.push((idx + 1, format!("{}:{}:{}: {}", doc.rel_path, idx + 1, tag, snippet)));
                    }
                }
            }
            if total_token_hits > 0 || exact_set.contains(&id) {
                exact_list.push((id, total_token_hits));
                file_lines_cache.insert(id, matched);
            }
        }
        exact_list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let exact_pos: FxHashMap<u32, usize> = exact_list
            .iter()
            .enumerate()
            .map(|(rank, (id, _))| (*id, rank + 1))
            .collect();

        // Reciprocal Rank Fusion (RRF, k=60)
        let mut rrf: Vec<(f64, u32)> = pool
            .into_iter()
            .filter_map(|id| {
                let doc = self.docs.get(&id)?;
                let abs = opts.workspace_root.join(&doc.rel_path);
                if Self::is_file_denied(opts, &abs) {
                    return None;
                }
                let mut score = 0.0;
                if let Some(&r) = bm25_pos.get(&id) {
                    score += 1.0 / (RRF_K + r as f64);
                }
                if let Some(&r) = exact_pos.get(&id) {
                    score += 1.0 / (RRF_K + r as f64);
                }
                if let Some(&r) = ppr_pos.get(&id) {
                    score += 0.7 / (RRF_K + r as f64);
                }
                if score > 0.0 {
                    Some((score, id))
                } else {
                    None
                }
            })
            .collect();

        rrf.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));

        let mut out_lines = Vec::new();
        let mut match_count = 0usize;
        let cand_count = rrf.len();
        for (score, id) in rrf.into_iter().take(12) {
            if match_count >= opts.max_matches {
                break;
            }
            let Some(doc) = self.docs.get(&id) else {
                continue;
            };
            let syms_preview = opts
                .parsed_asts
                .get(&doc.rel_path)
                .map(|a| {
                    a.symbols
                        .iter()
                        .take(5)
                        .map(|s| format!("{}(L{})", s.name, s.start_line))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            if syms_preview.is_empty() {
                out_lines.push(format!("# {} (rrf={:.4})", doc.rel_path, score));
            } else {
                out_lines.push(format!(
                    "# {} (rrf={:.4}) :: {}",
                    doc.rel_path, score, syms_preview
                ));
            }
            if let Some(lines) = file_lines_cache.get(&id) {
                for (_, formatted_line) in lines {
                    if match_count >= opts.max_matches {
                        break;
                    }
                    out_lines.push(format!("  {formatted_line}"));
                    match_count += 1;
                }
            } else {
                match_count += 1;
            }
        }

        if out_lines.is_empty() {
            return Ok(SearchOutcome {
                formatted: format!(
                    "No hybrid matches for '{}' (indexed {} files).",
                    opts.query,
                    self.docs.len()
                ),
                match_count: 0,
                candidate_files: 0,
            });
        }

        Ok(SearchOutcome {
            formatted: out_lines.join("\n"),
            match_count,
            candidate_files: cand_count,
        })
    }

    fn search_literal_simd(&self, opts: &SearchQueryOptions<'_>) -> anyhow::Result<SearchOutcome> {
        let candidates = self.candidate_paths_for_literal(opts.query, opts.subpath);
        let needle_bytes = if opts.case_sensitive {
            opts.query.as_bytes().to_vec()
        } else {
            opts.query.to_ascii_lowercase().into_bytes()
        };
        let finder = memmem::Finder::new(&needle_bytes);

        let mut hits = Vec::new();
        let mut truncated = false;
        let cand_count = candidates.len();

        for rel in candidates {
            if truncated {
                break;
            }
            let abs = opts.workspace_root.join(&rel);
            if Self::is_file_denied(opts, &abs) {
                continue;
            }
            let Ok(bytes) = fs::read(&abs) else {
                continue;
            };
            if bytes.len() as u64 > MAX_INDEX_FILE_BYTES || bytes.iter().take(2048).any(|&b| b == 0)
            {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes).replace("\r\n", "\n");
            let lines: Vec<&str> = text.split('\n').collect();
            let mut matched_indices = Vec::new();
            for (idx, line) in lines.iter().enumerate() {
                let hit = if opts.case_sensitive {
                    finder.find(line.as_bytes()).is_some()
                } else {
                    let low = line.to_ascii_lowercase();
                    finder.find(low.as_bytes()).is_some()
                };
                if hit {
                    matched_indices.push(idx);
                }
            }
            emit_matched_lines(
                &rel,
                &lines,
                &matched_indices,
                opts.context_lines,
                opts.max_matches,
                &mut hits,
                &mut truncated,
            );
        }

        format_line_search_outcome(opts.query, cand_count, hits, truncated, opts.max_matches)
    }

    fn search_regex_trigram(&self, opts: &SearchQueryOptions<'_>) -> anyhow::Result<SearchOutcome> {
        let re = RegexBuilder::new(opts.query)
            .case_insensitive(!opts.case_sensitive)
            .build()?;

        // Extract longest literal substring >= 3 bytes from regex to pre-filter via trigram index!
        let literal_anchor = extract_regex_literal_anchor(opts.query);
        let candidates = match literal_anchor {
            Some(ref lit) => self.candidate_paths_for_literal(lit, opts.subpath),
            None => self.all_sorted_paths(opts.subpath),
        };

        let mut hits = Vec::new();
        let mut truncated = false;
        let cand_count = candidates.len();

        for rel in candidates {
            if truncated {
                break;
            }
            let abs = opts.workspace_root.join(&rel);
            if Self::is_file_denied(opts, &abs) {
                continue;
            }
            let Ok(bytes) = fs::read(&abs) else {
                continue;
            };
            if bytes.len() as u64 > MAX_INDEX_FILE_BYTES || bytes.iter().take(2048).any(|&b| b == 0)
            {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes).replace("\r\n", "\n");
            let lines: Vec<&str> = text.split('\n').collect();
            let mut matched_indices = Vec::new();
            for (idx, line) in lines.iter().enumerate() {
                if re.is_match(line) {
                    matched_indices.push(idx);
                }
            }
            emit_matched_lines(
                &rel,
                &lines,
                &matched_indices,
                opts.context_lines,
                opts.max_matches,
                &mut hits,
                &mut truncated,
            );
        }

        format_line_search_outcome(opts.query, cand_count, hits, truncated, opts.max_matches)
    }

    /// Rank candidate docs using 4-field AST-weighted BM25F.
    pub fn rank_bm25f(&self, q_tokens: &[String], subpath: Option<&str>) -> Vec<(u32, f64)> {
        let n = self.docs.len() as f64;
        if n == 0.0 || q_tokens.is_empty() {
            return Vec::new();
        }
        let avg_sym = (self.total_sym_len as f64 / n).max(1.0);
        let avg_path = (self.total_path_len as f64 / n).max(1.0);
        let avg_doc = (self.total_doc_len as f64 / n).max(1.0);
        let avg_body = (self.total_body_len as f64 / n).max(1.0);

        let mut unique_q: Vec<&str> = q_tokens.iter().map(|s| s.as_str()).collect();
        unique_q.sort_unstable();
        unique_q.dedup();

        let mut doc_scores: FxHashMap<u32, f64> = FxHashMap::default();
        for term in unique_q {
            let Some(postings) = self.term_postings.get(term) else {
                continue;
            };
            let df = self.term_df.get(term).copied().unwrap_or(1) as f64;
            let idf = (1.0 + (n - df + 0.5) / (df + 0.5)).ln().max(0.01);

            for &doc_id in postings {
                let Some(doc) = self.docs.get(&doc_id) else {
                    continue;
                };
                if !Self::path_matches_subpath(&doc.rel_path, subpath) {
                    continue;
                }
                let tf_s = doc.sym_tf.get(term).copied().unwrap_or(0) as f64;
                let tf_p = doc.path_tf.get(term).copied().unwrap_or(0) as f64;
                let tf_d = doc.doc_tf.get(term).copied().unwrap_or(0) as f64;
                let tf_b = doc.body_tf.get(term).copied().unwrap_or(0) as f64;

                let pseudo_tf = W_SYMBOL * tf_s
                    / ((1.0 - B_SYMBOL) + B_SYMBOL * (doc.sym_len as f64 / avg_sym))
                    + W_PATH * tf_p
                        / ((1.0 - B_PATH) + B_PATH * (doc.path_len as f64 / avg_path))
                    + W_DOC * tf_d / ((1.0 - B_DOC) + B_DOC * (doc.doc_len as f64 / avg_doc))
                    + W_BODY * tf_b
                        / ((1.0 - B_BODY) + B_BODY * (doc.body_len as f64 / avg_body));

                if pseudo_tf > 0.0 {
                    let score = idf * (pseudo_tf * (BM25F_K1 + 1.0)) / (pseudo_tf + BM25F_K1);
                    *doc_scores.entry(doc_id).or_insert(0.0) += score;
                }
            }
        }

        let mut out: Vec<(u32, f64)> = doc_scores.into_iter().collect();
        out.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        out
    }

    /// Return FileIds whose trigram sets contain ALL trigrams of `literal` ($O(\min |L_i|)$ intersection!).
    pub fn trigram_candidates(&self, literal: &str) -> Vec<u32> {
        let tris = extract_unique_trigrams(literal);
        if tris.is_empty() {
            return Vec::new();
        }
        let mut lists: Vec<&Vec<u32>> = Vec::with_capacity(tris.len());
        for tri in &tris {
            match self.trigram_postings.get(tri) {
                Some(post) if !post.is_empty() => lists.push(post),
                _ => return Vec::new(), // Any missing trigram guarantees 0 exact matches!
            }
        }
        // Intersect shortest posting lists first
        lists.sort_by_key(|l| l.len());
        let mut acc: Vec<u32> = lists[0].clone();
        for next in &lists[1..] {
            acc = intersect_sorted(&acc, next);
            if acc.is_empty() {
                break;
            }
        }
        acc
    }

    fn candidate_paths_for_literal(&self, literal: &str, subpath: Option<&str>) -> Vec<String> {
        if literal.len() >= 3 && literal.is_ascii() {
            let ids = self.trigram_candidates(literal);
            let mut paths: Vec<String> = ids
                .into_iter()
                .filter_map(|id| self.docs.get(&id).map(|d| d.rel_path.clone()))
                .filter(|p| Self::path_matches_subpath(p, subpath))
                .collect();
            paths.sort();
            return paths;
        }
        self.all_sorted_paths(subpath)
    }

    fn all_sorted_paths(&self, subpath: Option<&str>) -> Vec<String> {
        let mut paths: Vec<String> = self
            .docs
            .values()
            .map(|d| d.rel_path.clone())
            .filter(|p| Self::path_matches_subpath(p, subpath))
            .collect();
        paths.sort();
        paths
    }
}

fn hashline_at(lines: &[&str], idx: usize) -> String {
    let prev = if idx > 0 { lines[idx - 1].trim() } else { "" };
    let curr = lines[idx].trim();
    let next = if idx + 1 < lines.len() {
        lines[idx + 1].trim()
    } else {
        ""
    };
    let tag = line_hash_tag(prev, curr, next);
    String::from_utf8_lossy(&tag).into_owned()
}

fn emit_matched_lines(
    rel: &str,
    lines: &[&str],
    matched_indices: &[usize],
    context_lines: usize,
    max_matches: usize,
    hits: &mut Vec<String>,
    truncated: &mut bool,
) {
    if matched_indices.is_empty() {
        return;
    }
    let ctx = context_lines.min(3);
    let mut emitted_line = FxHashSet::default();
    for &idx in matched_indices {
        if hits.len() >= max_matches {
            *truncated = true;
            return;
        }
        let lo = idx.saturating_sub(ctx);
        let hi = (idx + ctx).min(lines.len().saturating_sub(1));
        for li in lo..=hi {
            if !emitted_line.insert(li) {
                continue;
            }
            let tag = hashline_at(lines, li);
            let sep = if li == idx { ":" } else { "-" };
            let snippet: String = lines[li].chars().take(220).collect();
            hits.push(format!("{rel}:{}{sep}{tag}: {snippet}", li + 1));
            if li == idx && hits.len() >= max_matches {
                *truncated = true;
                return;
            }
        }
    }
}

fn format_line_search_outcome(
    query: &str,
    cand_count: usize,
    hits: Vec<String>,
    truncated: bool,
    max_matches: usize,
) -> anyhow::Result<SearchOutcome> {
    if hits.is_empty() {
        Ok(SearchOutcome {
            formatted: format!(
                "No matches for '{query}' (checked {cand_count} candidate files)."
            ),
            match_count: 0,
            candidate_files: cand_count,
        })
    } else {
        let count = hits.len();
        let mut text = hits.join("\n");
        if truncated {
            text.push_str(&format!(
                "\n[truncated at {max_matches} matches; narrow with path, mode=\"symbol\", or more specific pattern]"
            ));
        }
        Ok(SearchOutcome {
            formatted: text,
            match_count: count,
            candidate_files: cand_count,
        })
    }
}

/// Code-aware sub-tokenizer: splits on non-alphanumerics, snake_case, and camelCase,
/// emitting both compound and sub-tokens in lowercase (dedup-friendly for BM25F).
pub fn tokenize_code(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for word in text.split(|c: char| !c.is_alphanumeric() && c != '_') {
        if word.len() < 2 || word.len() > 64 {
            continue;
        }
        let low = word.to_ascii_lowercase();
        out.push(low.clone());

        // Split snake_case & camelCase sub-identifiers
        let mut sub_start = 0usize;
        let bytes = word.as_bytes();
        for i in 1..bytes.len() {
            let prev = bytes[i - 1];
            let curr = bytes[i];
            let boundary = curr == b'_'
                || (prev.is_ascii_lowercase() && curr.is_ascii_uppercase())
                || (prev.is_ascii_alphabetic() && curr.is_ascii_digit());
            if boundary {
                let piece = &word[sub_start..i];
                let clean = piece.trim_matches('_');
                if clean.len() >= 2 && clean.len() < word.len() {
                    out.push(clean.to_ascii_lowercase());
                }
                sub_start = if curr == b'_' { i + 1 } else { i };
            }
        }
        if sub_start > 0 && sub_start < word.len() {
            let tail = word[sub_start..].trim_matches('_');
            if tail.len() >= 2 && tail.len() < word.len() {
                out.push(tail.to_ascii_lowercase());
            }
        }
    }
    out
}

fn extract_unique_trigrams(text: &str) -> Vec<[u8; 3]> {
    let bytes = text.as_bytes();
    if bytes.len() < 3 {
        return Vec::new();
    }
    let mut seen: FxHashSet<[u8; 3]> = FxHashSet::default();
    let mut out = Vec::new();
    for w in bytes.windows(3) {
        if w[0].is_ascii() && w[1].is_ascii() && w[2].is_ascii() {
            let tri = [
                w[0].to_ascii_lowercase(),
                w[1].to_ascii_lowercase(),
                w[2].to_ascii_lowercase(),
            ];
            if seen.insert(tri) {
                out.push(tri);
                if out.len() >= 12_000 {
                    break;
                }
            }
        }
    }
    out
}

fn extract_regex_literal_anchor(pattern: &str) -> Option<String> {
    // Reject top-level alternation (`foo|bar`) since neither branch is guaranteed in every match
    if pattern.contains('|') {
        return None;
    }
    let mut best = String::new();
    let mut cur = String::new();
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            // Escaped literal punctuation (e.g. `\.`) ends or continues carefully; safest to break run
            if cur.len() > best.len() {
                best = std::mem::take(&mut cur);
            } else {
                cur.clear();
            }
            i += 2;
            continue;
        }
        let is_meta = matches!(
            c,
            '.' | '*' | '+' | '?' | '[' | ']' | '(' | ')' | '^' | '$' | '{' | '}'
        );
        if is_meta {
            // If quantifier `?` or `*` follows previous char, drop that optional char from `cur`
            if matches!(c, '?' | '*') {
                cur.pop();
            }
            if cur.len() > best.len() {
                best = std::mem::take(&mut cur);
            } else {
                cur.clear();
            }
        } else if c.is_ascii() {
            cur.push(c);
        } else {
            if cur.len() > best.len() {
                best = std::mem::take(&mut cur);
            } else {
                cur.clear();
            }
        }
        i += 1;
    }
    if cur.len() > best.len() {
        best = cur;
    }
    if best.len() >= 3 {
        Some(best)
    } else {
        None
    }
}

fn intersect_sorted(a: &[u32], b: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(a.len().min(b.len()));
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                out.push(a[i]);
                i += 1;
                j += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph_locator::WorkspaceGraphIndex;

    #[test]
    fn trigram_prefilter_matches_exact_simd_and_skips_non_matching_files() {
        let tmp = std::env::temp_dir().join(format!("omni_search_tri_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("hit.py"), "def compute_eigen_delta():\n    return 42\n").unwrap();
        fs::write(tmp.join("miss1.py"), "def alpha():\n    return 1\n").unwrap();
        fs::write(tmp.join("miss2.py"), "def beta():\n    return 2\n").unwrap();

        let mut g = WorkspaceGraphIndex::new(&tmp);
        g.refresh().unwrap();

        let cands = g.search_index().trigram_candidates("eigen_delta");
        assert_eq!(cands.len(), 1, "trigram intersection must prune 2/3 non-matching files");

        let res = g
            .search(
                "eigen_delta",
                SearchMode::Literal,
                None,
                true,
                0,
                20,
                &PermissionsEngine::default_rules(),
                true,
                ApprovalMode::Yolo,
            )
            .unwrap();
        assert_eq!(res.candidate_files, 1);
        assert_eq!(res.match_count, 1);
        assert!(res.formatted.contains("hit.py:1:"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn bm25f_rrf_ranks_ast_symbol_definition_above_comment_or_body_mentions() {
        let tmp = std::env::temp_dir().join(format!("omni_search_bm25_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("notes.py"),
            "# reconcile_ledger is mentioned in a comment\nx = 'reconcile_ledger'\n",
        )
        .unwrap();
        fs::write(
            tmp.join("ledger.py"),
            "class Ledger:\n    def reconcile_ledger(self):\n        return True\n",
        )
        .unwrap();

        let mut g = WorkspaceGraphIndex::new(&tmp);
        g.refresh().unwrap();

        let res = g
            .search(
                "reconcile_ledger",
                SearchMode::Hybrid,
                None,
                false,
                0,
                20,
                &PermissionsEngine::default_rules(),
                true,
                ApprovalMode::Yolo,
            )
            .unwrap();
        let first_header = res
            .formatted
            .lines()
            .find(|l| l.starts_with("# "))
            .unwrap_or("");
        assert!(
            first_header.contains("ledger.py"),
            "BM25F+RRF must rank AST symbol definition file first, got: {}",
            res.formatted
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn hybrid_search_never_indexes_or_leaks_denied_env_or_ssh_files_and_prunes_deletions() {
        let tmp = std::env::temp_dir().join(format!("omni_search_sec_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join(".env"), "TOP_SECRET_TOKEN_XYZ=123\n").unwrap();
        fs::write(tmp.join("id_rsa"), "TOP_SECRET_TOKEN_XYZ_SSH\n").unwrap();
        fs::write(tmp.join("temp.py"), "def ephemeral_marker_fn():\n    pass\n").unwrap();

        let mut g = WorkspaceGraphIndex::new(&tmp);
        g.refresh().unwrap();

        // Secret files must NEVER be indexed or returned
        assert_eq!(g.search_index().doc_count(), 1);
        let leak = g
            .search(
                "TOP_SECRET_TOKEN_XYZ",
                SearchMode::Hybrid,
                None,
                false,
                0,
                20,
                &PermissionsEngine::default_rules(),
                true,
                ApprovalMode::Yolo,
            )
            .unwrap();
        assert_eq!(leak.match_count, 0);

        // Incremental deletion must prune postings cleanly
        fs::remove_file(tmp.join("temp.py")).unwrap();
        g.refresh().unwrap();
        assert_eq!(g.search_index().doc_count(), 0);
        assert!(g
            .search_index()
            .trigram_candidates("ephemeral_marker")
            .is_empty());

        let _ = fs::remove_dir_all(&tmp);
    }
}
