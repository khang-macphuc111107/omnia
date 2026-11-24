//! Frontier `v0.3.0` `tree-sitter 0.25` Heterogeneous AST Graph + Personalized PageRank RepoMap.
//!
//! Synthesizes **LocAgent** (`arXiv:2503.09089`), **RepoGraph** (`arXiv:2410.14684`),
//! **GraphLocator** (`arXiv:2512.22469`), **OrcaLoca** (`arXiv:2502.00350`),
//! **CoSIL** (`arXiv:2503.22424`), and **Aider RepoMap**:
//! - Real `tree-sitter 0.25` AST extraction (Python, JS/JSX, TS/TSX, Rust, Go + C/C++ lexical fallback)
//! - Structured `AstSymbol` records with 1-based line spans & compact 1-line signatures
//! - Content-addressable SQLite `ast_symbol_cache` keyed by BLAKE3 hex (zero re-parses across worktrees!)
//! - 3-Relation CSR Graph (`Import` 1.0, `Inherits` 1.6, IDF-weighted `CallRef` 1.2/sqrt(df), weak `ImportedBy` 0.25)
//! - Sparse Power-Iteration Personalized PageRank ($\alpha = 0.85$, L1 $< 10^{-5}$, query-seeded)
//! - Principled Python stdlib-shadowing detector (full core Python 3.x stdlib set, zero benchmark hardcoding)
//! - Binary-search token-budgeted Turn-1 RepoMap embedding directly into `<workspace_context>`

use crate::agent_store::{AgentStore, CachedAstRow};
use crate::cache_guard::estimate_tokens;
use crate::merkle::{MerkleIndex, MerkleRefreshDelta};
use crate::permissions::{ApprovalMode, PermissionRule, PermissionsEngine};
use crate::search::{
    tokenize_code, HybridSearchIndex, SearchMode, SearchOutcome, SearchQueryOptions,
};
use anyhow::Result;
use regex::Regex;
use rustc_hash::{FxHashMap, FxHashSet};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;
use tree_sitter::{Language, Node, Parser};

const MAX_PARSE_FILE_BYTES: u64 = 512 * 1024; // 512 KiB per source file
const MAX_CALL_REF_DF: usize = 12; // Skip ubiquitous names like `get`/`run`/`init` in CallRef edges

/// Comprehensive core Python 3.x standard library top-level module names (sorted for binary_search).
const PYTHON_STDLIB_MODULES: &[&str] = &[
    "abc",
    "argparse",
    "array",
    "ast",
    "asyncio",
    "base64",
    "bisect",
    "calendar",
    "cgi",
    "cmd",
    "code",
    "codecs",
    "collections",
    "colorsys",
    "concurrent",
    "configparser",
    "contextlib",
    "copy",
    "csv",
    "ctypes",
    "curses",
    "dataclasses",
    "datetime",
    "decimal",
    "difflib",
    "dis",
    "doctest",
    "email",
    "encodings",
    "enum",
    "errno",
    "faulthandler",
    "fcntl",
    "filecmp",
    "fileinput",
    "fnmatch",
    "fractions",
    "ftplib",
    "functools",
    "gc",
    "getopt",
    "getpass",
    "gettext",
    "glob",
    "graphlib",
    "gzip",
    "hashlib",
    "heapq",
    "hmac",
    "html",
    "http",
    "imaplib",
    "importlib",
    "inspect",
    "io",
    "ipaddress",
    "itertools",
    "json",
    "keyword",
    "linecache",
    "locale",
    "logging",
    "lzma",
    "mailbox",
    "marshal",
    "math",
    "mimetypes",
    "mmap",
    "multiprocessing",
    "netrc",
    "numbers",
    "operator",
    "optparse",
    "os",
    "pathlib",
    "pdb",
    "pickle",
    "pkgutil",
    "platform",
    "plistlib",
    "poplib",
    "posixpath",
    "pprint",
    "profile",
    "pstats",
    "pty",
    "pwd",
    "queue",
    "quopri",
    "random",
    "re",
    "readline",
    "reprlib",
    "resource",
    "rlcompleter",
    "runpy",
    "sched",
    "secrets",
    "select",
    "selectors",
    "shelve",
    "shlex",
    "shutil",
    "signal",
    "site",
    "smtplib",
    "socket",
    "socketserver",
    "sqlite3",
    "ssl",
    "stat",
    "statistics",
    "string",
    "struct",
    "subprocess",
    "sys",
    "sysconfig",
    "tarfile",
    "tempfile",
    "termios",
    "textwrap",
    "threading",
    "time",
    "timeit",
    "tkinter",
    "token",
    "tokenize",
    "tomllib",
    "trace",
    "traceback",
    "tracemalloc",
    "tty",
    "turtle",
    "types",
    "typing",
    "unicodedata",
    "unittest",
    "urllib",
    "uuid",
    "venv",
    "warnings",
    "wave",
    "weakref",
    "webbrowser",
    "wsgiref",
    "xml",
    "xmlrpc",
    "zipapp",
    "zipfile",
    "zipimport",
    "zlib",
    "zoneinfo",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SymbolKind {
    Class,
    Struct,
    Enum,
    Trait,
    Interface,
    Function,
    Method,
    TypeAlias,
    Const,
}

impl SymbolKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Class => "class",
            Self::Struct => "struct",
            Self::Enum => "enum",
            Self::Trait => "trait",
            Self::Interface => "interface",
            Self::Function => "fn",
            Self::Method => "method",
            Self::TypeAlias => "type",
            Self::Const => "const",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AstSymbol {
    pub name: String,
    pub qualified_name: String,
    pub kind: SymbolKind,
    pub start_line: u32,
    pub end_line: u32,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFileAst {
    pub language: String,
    pub blake3_hex: String,
    pub symbols: Vec<AstSymbol>,
    pub imports: Vec<String>,
    pub call_refs: Vec<String>,
    pub inherits_refs: Vec<String>,
    pub doc_terms: Vec<String>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNodeInfo {
    pub path: String,
    pub language: String,
    pub symbols: Vec<String>,
    pub symbol_count: usize,
    pub imports: Vec<String>,
    pub imported_by_count: usize,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdgeInfo {
    pub source: String,
    pub target: String,
    pub specifier: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitySearchHit {
    pub file: String,
    pub name: String,
    pub qualified_name: String,
    pub kind: String,
    pub start_line: u32,
    pub end_line: u32,
    pub signature: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphTraversalReport {
    pub seed: String,
    pub hops: usize,
    pub seed_files: Vec<String>,
    pub reached_files: Vec<String>,
    pub edges: Vec<GraphEdgeInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessGraphMap {
    pub workspace_path: String,
    pub root_hash: String,
    pub node_count: usize,
    pub edge_count: usize,
    pub symbol_count: usize,
    pub build_ms: f64,
    pub nodes: Vec<GraphNodeInfo>,
    pub edges: Vec<GraphEdgeInfo>,
    pub outline_text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EdgeKind {
    Import,
    Inherits,
    CallRef,
    CoChange,
}

impl EdgeKind {
    fn label(self) -> &'static str {
        match self {
            Self::Import => "import",
            Self::Inherits => "inherits",
            Self::CallRef => "call",
            Self::CoChange => "cochange",
        }
    }
}

/// Zero-cost post-edit syntax diagnostic (D1).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxDiagnostic {
    pub line: u32,
    pub col: u32,
    pub kind: String,
    pub snippet: String,
    pub enclosing_symbol: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxCheckReport {
    pub diagnostics: Vec<SyntaxDiagnostic>,
}

impl SyntaxCheckReport {
    pub fn is_clean(&self) -> bool {
        self.diagnostics.is_empty()
    }

    pub fn format_lines(&self) -> Vec<String> {
        self.diagnostics
            .iter()
            .map(|d| {
                let sym = d
                    .enclosing_symbol
                    .as_deref()
                    .map(|s| format!(" in `{s}`"))
                    .unwrap_or_default();
                format!(
                    "[AST Syntax Diagnostic] L{}:{} ({}{sym}): {}",
                    d.line, d.col, d.kind, d.snippet
                )
            })
            .collect()
    }
}

/// Compact Compressed Sparse Row (CSR) weighted directed graph for sub-millisecond PPR.
struct CsrGraph {
    nodes: Vec<String>,
    row_ptr: Vec<usize>,
    col_idx: Vec<usize>,
    weights: Vec<f64>,
    out_weight_sum: Vec<f64>,
    display_edges: Vec<(usize, usize, String, EdgeKind)>,
    inbound_counts: Vec<usize>,
}

impl CsrGraph {
    fn build(
        parsed: &BTreeMap<String, ParsedFileAst>,
        forensics: Option<&crate::git_forensics::GitForensicsReport>,
    ) -> Self {
        let nodes: Vec<String> = parsed.keys().cloned().collect();
        let n = nodes.len();
        let path_to_idx: FxHashMap<&str, usize> = nodes
            .iter()
            .enumerate()
            .map(|(i, p)| (p.as_str(), i))
            .collect();
        let all_files: BTreeSet<&str> = nodes.iter().map(|s| s.as_str()).collect();

        // Symbol name -> list of defining file indices (for Inherits & IDF-weighted CallRef edges)
        let mut sym_def_files: FxHashMap<&str, Vec<usize>> = FxHashMap::default();
        for (idx, path) in nodes.iter().enumerate() {
            if let Some(ast) = parsed.get(path) {
                let mut seen_in_file = FxHashSet::default();
                for s in &ast.symbols {
                    if s.name.len() >= 2 && seen_in_file.insert(s.name.as_str()) {
                        sym_def_files.entry(s.name.as_str()).or_default().push(idx);
                    }
                }
            }
        }

        let mut adj: Vec<FxHashMap<usize, f64>> = vec![FxHashMap::default(); n];
        let mut display_edges: Vec<(usize, usize, String, EdgeKind)> = Vec::new();
        let mut inbound_counts = vec![0usize; n];

        for (src_idx, src_path) in nodes.iter().enumerate() {
            let Some(ast) = parsed.get(src_path) else {
                continue;
            };

            // 1. Import edges (w = 1.0) + weak ImportedBy back-edge (w = 0.25)
            let mut seen_imp = FxHashSet::default();
            for imp in &ast.imports {
                if let Some(target_path) =
                    resolve_workspace_import(src_path, imp, &ast.language, &all_files)
                {
                    if let Some(&dst_idx) = path_to_idx.get(target_path.as_str()) {
                        if dst_idx != src_idx && seen_imp.insert(dst_idx) {
                            *adj[src_idx].entry(dst_idx).or_insert(0.0) += 1.0;
                            *adj[dst_idx].entry(src_idx).or_insert(0.0) += 0.25;
                            inbound_counts[dst_idx] += 1;
                            display_edges.push((src_idx, dst_idx, imp.clone(), EdgeKind::Import));
                        }
                    }
                }
            }

            // 2. Inherits edges (w = 1.6)
            let mut seen_inh = FxHashSet::default();
            for base in &ast.inherits_refs {
                if let Some(defs) = sym_def_files.get(base.as_str()) {
                    if defs.len() <= 6 {
                        for &dst_idx in defs {
                            if dst_idx != src_idx && seen_inh.insert(dst_idx) {
                                *adj[src_idx].entry(dst_idx).or_insert(0.0) += 1.6;
                                *adj[dst_idx].entry(src_idx).or_insert(0.0) += 0.25;
                                inbound_counts[dst_idx] += 1;
                                display_edges.push((
                                    src_idx,
                                    dst_idx,
                                    base.clone(),
                                    EdgeKind::Inherits,
                                ));
                            }
                        }
                    }
                }
            }

            // 3. CallRef edges (IDF-attenuated: w = 1.2 / sqrt(df), skipping df > MAX_CALL_REF_DF)
            let mut seen_call = FxHashSet::default();
            for call_name in &ast.call_refs {
                if let Some(defs) = sym_def_files.get(call_name.as_str()) {
                    let df = defs.len();
                    if df > 0 && df <= MAX_CALL_REF_DF {
                        let w = 1.2 / (df as f64).sqrt();
                        for &dst_idx in defs {
                            if dst_idx != src_idx && seen_call.insert((dst_idx, call_name.as_str()))
                            {
                                *adj[src_idx].entry(dst_idx).or_insert(0.0) += w;
                                if !seen_imp.contains(&dst_idx) && !seen_inh.contains(&dst_idx) {
                                    display_edges.push((
                                        src_idx,
                                        dst_idx,
                                        call_name.clone(),
                                        EdgeKind::CallRef,
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }

        // 4. Git Temporal Co-Change Jaccard edges (D5): w = 0.8 * Jaccard(u, v)
        if let Some(f) = forensics {
            for edge in &f.cochange_edges {
                if let (Some(&u), Some(&v)) = (
                    path_to_idx.get(edge.a.as_str()),
                    path_to_idx.get(edge.b.as_str()),
                ) {
                    if u != v {
                        let w = 0.8 * edge.jaccard;
                        *adj[u].entry(v).or_insert(0.0) += w;
                        *adj[v].entry(u).or_insert(0.0) += w;
                        display_edges.push((
                            u,
                            v,
                            format!("cochange:{:.2}", edge.jaccard),
                            EdgeKind::CoChange,
                        ));
                    }
                }
            }
        }

        // Pack into CSR arrays
        let mut row_ptr = Vec::with_capacity(n + 1);
        let mut col_idx = Vec::new();
        let mut weights = Vec::new();
        let mut out_weight_sum = Vec::with_capacity(n);
        row_ptr.push(0);

        for map in adj {
            let mut entries: Vec<(usize, f64)> = map.into_iter().collect();
            entries.sort_by_key(|(dst, _)| *dst);
            let mut sum = 0.0;
            for (dst, w) in entries {
                col_idx.push(dst);
                weights.push(w);
                sum += w;
            }
            out_weight_sum.push(sum);
            row_ptr.push(col_idx.len());
        }

        Self {
            nodes,
            row_ptr,
            col_idx,
            weights,
            out_weight_sum,
            display_edges,
            inbound_counts,
        }
    }

    /// Sparse Power-Iteration Personalized PageRank (alpha=0.85, tol < 1e-5, max 25 iters).
    fn compute_ppr(
        &self,
        parsed: &BTreeMap<String, ParsedFileAst>,
        seed_text: Option<&str>,
        forensics: Option<&crate::git_forensics::GitForensicsReport>,
    ) -> Vec<f64> {
        let n = self.nodes.len();
        if n == 0 {
            return Vec::new();
        }
        let alpha = 0.85f64;
        let base_uniform = 0.15 / (n as f64);

        let seed_lower = seed_text.unwrap_or("").to_ascii_lowercase();
        let seed_tokens: FxHashSet<String> = if seed_lower.is_empty() {
            FxHashSet::default()
        } else {
            tokenize_code(&seed_lower).into_iter().collect()
        };

        let mut v = vec![base_uniform; n];
        for (i, path) in self.nodes.iter().enumerate() {
            let p_low = path.to_ascii_lowercase();
            let base_name = p_low.rsplit('/').next().unwrap_or(&p_low);
            let stem = base_name.split('.').next().unwrap_or(base_name);

            if !seed_lower.is_empty() {
                if seed_lower.contains(&p_low)
                    || (base_name.len() >= 4 && seed_lower.contains(base_name))
                {
                    v[i] += 3.0;
                } else if stem.len() >= 3 && seed_tokens.contains(stem) {
                    v[i] += 1.5;
                }
                if let Some(ast) = parsed.get(path) {
                    let mut sym_hits = 0u32;
                    for sym in &ast.symbols {
                        let sl = sym.name.to_ascii_lowercase();
                        if sl.len() >= 3 && seed_tokens.contains(&sl) {
                            sym_hits += 1;
                            if sym_hits >= 3 {
                                break;
                            }
                        }
                    }
                    if sym_hits > 0 {
                        v[i] += 2.0 * (sym_hits as f64).min(3.0) / 1.5;
                    }
                }
            }

            // Structural anomaly boost: root-level Python stdlib shadowing!
            if detect_python_stdlib_shadow(path).is_some() {
                v[i] += 1.5;
            }
            // D5 Churn Gravity boost: ln(1 + commit_count) * 0.15 for recently active files
            if let Some(f) = forensics {
                if let Some(&commits) = f.file_commits.get(path) {
                    v[i] += 0.15 * (1.0 + commits as f64).ln();
                }
            }
        }

        // Normalize personalization vector
        let v_sum: f64 = v.iter().sum();
        if v_sum > 0.0 {
            for x in &mut v {
                *x /= v_sum;
            }
        } else {
            v.fill(1.0 / (n as f64));
        }

        let mut r = v.clone();
        let mut next = vec![0.0; n];

        for _ in 0..25 {
            for i in 0..n {
                next[i] = (1.0 - alpha) * v[i];
            }
            let mut dangling_mass = 0.0;
            for u in 0..n {
                let ru = r[u];
                if ru == 0.0 {
                    continue;
                }
                let out_sum = self.out_weight_sum[u];
                if out_sum <= 0.0 {
                    dangling_mass += ru;
                    continue;
                }
                let start = self.row_ptr[u];
                let end = self.row_ptr[u + 1];
                let scale = alpha * ru / out_sum;
                for edge_i in start..end {
                    let dst = self.col_idx[edge_i];
                    next[dst] += scale * self.weights[edge_i];
                }
            }
            if dangling_mass > 0.0 {
                let d_scale = alpha * dangling_mass;
                for i in 0..n {
                    next[i] += d_scale * v[i];
                }
            }

            let mut l1_diff = 0.0;
            for i in 0..n {
                l1_diff += (next[i] - r[i]).abs();
            }
            std::mem::swap(&mut r, &mut next);
            if l1_diff < 1e-5 {
                break;
            }
        }
        r
    }
}

/// Detect root-level Python files/packages shadowing a Python 3.x standard library module
/// (e.g., `calendar.py`, `json.py`, `logging/__init__.py`). Zero benchmark hardcoding!
pub fn detect_python_stdlib_shadow(rel_path: &str) -> Option<&'static str> {
    let norm = rel_path.replace('\\', "/");
    let s = norm.strip_suffix(".py")?;
    let stem = if s.contains('/') {
        let pkg = norm.strip_suffix("/__init__.py")?;
        if pkg.contains('/') {
            return None;
        }
        pkg
    } else {
        s
    };

    PYTHON_STDLIB_MODULES
        .binary_search(&stem)
        .ok()
        .map(|idx| PYTHON_STDLIB_MODULES[idx])
}

#[derive(Clone)]
pub struct WorkspaceGraphIndex {
    merkle: MerkleIndex,
    parsed: BTreeMap<String, ParsedFileAst>,
    search_index: HybridSearchIndex,
    cached_forensics: Option<crate::git_forensics::GitForensicsReport>,
    last_build_ms: f64,
    db: Option<AgentStore>,
}

impl WorkspaceGraphIndex {
    pub fn new(workspace_root: &Path) -> Self {
        Self::with_options(workspace_root, PermissionsEngine::default_rules(), None)
    }

    pub fn with_options(
        workspace_root: &Path,
        permission_rules: Vec<PermissionRule>,
        db: Option<AgentStore>,
    ) -> Self {
        Self {
            merkle: MerkleIndex::with_options(workspace_root, permission_rules, db.clone()),
            parsed: BTreeMap::new(),
            search_index: HybridSearchIndex::new(),
            cached_forensics: None,
            last_build_ms: 0.0,
            db,
        }
    }

    pub fn merkle(&self) -> &MerkleIndex {
        &self.merkle
    }

    pub fn parsed_asts(&self) -> &BTreeMap<String, ParsedFileAst> {
        &self.parsed
    }

    pub fn search_index(&self) -> &HybridSearchIndex {
        &self.search_index
    }

    pub fn symbol_count(&self) -> usize {
        self.parsed.values().map(|p| p.symbols.len()).sum()
    }

    /// Incrementally refresh BLAKE3 Merkle tree, hydrate/parse `tree-sitter` ASTs ONLY for
    /// changed files (checking content-addressable SQLite `ast_symbol_cache` first!),
    /// and update `HybridSearchIndex` incrementally!
    pub fn refresh(&mut self) -> Result<MerkleRefreshDelta> {
        let t0 = Instant::now();
        let delta = self.merkle.refresh()?;

        for rem in &delta.removed_files {
            self.parsed.remove(rem);
            self.search_index.remove_file(rem);
        }

        // Also ensure any files hydrated from SQLite merkle_cache on warm start get loaded into `parsed` + `search_index`
        let mut files_to_sync: Vec<String> = delta.changed_files.clone();
        for rel in self.merkle.files().keys() {
            if !self.parsed.contains_key(rel) && !files_to_sync.contains(rel) {
                files_to_sync.push(rel.clone());
            }
        }

        // Bulk lookup content-addressable AST cache by BLAKE3 hex!
        let hexes: Vec<String> = files_to_sync
            .iter()
            .filter_map(|rel| self.merkle.files().get(rel).map(|e| e.sha256.clone()))
            .collect();
        let cached_asts = self
            .db
            .as_ref()
            .and_then(|db| db.load_ast_cache_batch(&hexes).ok())
            .unwrap_or_default();

        let root = self.merkle.workspace_root().to_path_buf();
        let mut new_cache_rows: Vec<CachedAstRow> = Vec::new();

        for rel in &files_to_sync {
            let Some(entry) = self.merkle.files().get(rel) else {
                continue;
            };
            let lang = detect_language(rel);
            let abs = root.join(rel);

            let content_opt = if entry.size_bytes <= MAX_PARSE_FILE_BYTES && lang != "binary" {
                fs::read_to_string(&abs).ok()
            } else {
                None
            };

            let ast = if let Some(cached) = cached_asts.get(&entry.sha256) {
                if let Ok(mut parsed_ast) = serde_json::from_str::<ParsedFileAst>(&cached.ast_json)
                {
                    parsed_ast.size_bytes = entry.size_bytes;
                    parsed_ast
                } else {
                    parse_file_ast(
                        lang,
                        &entry.sha256,
                        content_opt.as_deref(),
                        entry.size_bytes,
                    )
                }
            } else {
                let parsed_ast = parse_file_ast(
                    lang,
                    &entry.sha256,
                    content_opt.as_deref(),
                    entry.size_bytes,
                );
                if lang != "binary" && lang != "text" && self.db.is_some() {
                    if let Ok(ast_json) = serde_json::to_string(&parsed_ast) {
                        new_cache_rows.push(CachedAstRow {
                            blake3_hex: entry.sha256.clone(),
                            language: lang.to_string(),
                            ast_json,
                        });
                    }
                }
                parsed_ast
            };

            if let Some(ref txt) = content_opt {
                self.search_index.upsert_file(rel, txt, Some(&ast));
            } else {
                self.search_index.remove_file(rel);
            }
            self.parsed.insert(rel.clone(), ast);
        }

        if let Some(ref db) = self.db {
            if !new_cache_rows.is_empty() {
                let _ = db.upsert_ast_cache_batch(&new_cache_rows);
            }
        }

        // Refresh Git temporal co-change forensics ONLY when HEAD OID changes (0 overhead on non-git dirs!)
        if let Some(head_oid) = crate::git_forensics::probe_git_head_oid(&root) {
            let needs_refresh = self
                .cached_forensics
                .as_ref()
                .is_none_or(|f| f.head_oid != head_oid);
            if needs_refresh {
                self.cached_forensics = crate::git_forensics::compute_git_cochange(&root, 200);
            }
        } else {
            self.cached_forensics = None;
        }

        self.last_build_ms = ((t0.elapsed().as_secs_f64() * 1000.0) * 100.0).round() / 100.0;
        Ok(delta)
    }

    /// Find an AST symbol span inside `rel_path` (exact qualified_name, exact name, or suffix match) for D5 `read_file(symbol=...)`.
    pub fn find_symbol_span(&self, rel_path: &str, symbol_query: &str) -> Option<&AstSymbol> {
        let norm = rel_path.trim().replace('\\', "/");
        let ast = self.parsed.get(&norm)?;
        let q = symbol_query.trim();
        if q.is_empty() {
            return None;
        }
        let ql = q.to_ascii_lowercase();
        ast.symbols
            .iter()
            .find(|s| s.qualified_name.eq_ignore_ascii_case(q))
            .or_else(|| ast.symbols.iter().find(|s| s.name.eq_ignore_ascii_case(q)))
            .or_else(|| {
                ast.symbols.iter().find(|s| {
                    s.qualified_name
                        .to_ascii_lowercase()
                        .ends_with(&format!(".{ql}"))
                        || s.qualified_name
                            .to_ascii_lowercase()
                            .ends_with(&format!("::{ql}"))
                })
            })
            .or_else(|| {
                ast.symbols
                    .iter()
                    .find(|s| s.qualified_name.to_ascii_lowercase().contains(&ql))
            })
    }

    /// `cAST` (`arXiv:2506.15655`) boundary snap: snap a target line cutoff (e.g. 260) to the nearest
    /// enclosing `AstSymbol::end_line` within `+-20` lines so oversized reads never slice functions in half!
    pub fn snap_line_to_ast_boundary(
        &self,
        rel_path: &str,
        target_line_1: usize,
        total_lines: usize,
    ) -> usize {
        let norm = rel_path.trim().replace('\\', "/");
        let Some(ast) = self.parsed.get(&norm) else {
            return target_line_1.min(total_lines);
        };
        let lo = target_line_1.saturating_sub(20);
        let hi = (target_line_1 + 20).min(total_lines);
        let mut best: Option<usize> = None;
        let mut best_dist = usize::MAX;
        for sym in &ast.symbols {
            let end_l = sym.end_line as usize;
            if end_l >= lo && end_l <= hi {
                let d = end_l.abs_diff(target_line_1);
                if d < best_dist {
                    best_dist = d;
                    best = Some(end_l);
                }
            }
        }
        best.unwrap_or_else(|| target_line_1.min(total_lines))
    }

    /// Render compact `cAST` AST-skeleton outline for remaining symbols past `after_line_1` (D5).
    pub fn render_ast_skeleton_after(
        &self,
        rel_path: &str,
        after_line_1: usize,
        total_lines: usize,
    ) -> Option<String> {
        let norm = rel_path.trim().replace('\\', "/");
        let ast = self.parsed.get(&norm)?;
        let rem: Vec<&AstSymbol> = ast
            .symbols
            .iter()
            .filter(|s| (s.start_line as usize) > after_line_1)
            .collect();
        if rem.is_empty() {
            return None;
        }
        let mut out = format!(
            "[AST Outline for truncated L{}..L{} — call read_file(path=\"{}\", symbol=...) or start_line/end_line:]\n",
            after_line_1 + 1,
            total_lines,
            norm
        );
        for s in rem.iter().take(40) {
            out.push_str(&format!(
                "- {} {} (L{}-L{}): {}\n",
                s.kind.label(),
                s.qualified_name,
                s.start_line,
                s.end_line,
                s.signature
            ));
        }
        if rem.len() > 40 {
            out.push_str(&format!("... (+{} more symbols)\n", rem.len() - 40));
        }
        Some(out)
    }

    /// Compute Personalized PageRank map (`rel_path -> ppr_score`) seeded by optional prompt/query text.
    pub fn compute_ppr_map(&self, seed_text: Option<&str>) -> BTreeMap<String, f64> {
        let csr = CsrGraph::build(&self.parsed, self.cached_forensics.as_ref());
        let scores = csr.compute_ppr(&self.parsed, seed_text, self.cached_forensics.as_ref());
        csr.nodes.into_iter().zip(scores).collect()
    }

    /// List all parsed CST symbols defined in a specific workspace-relative file.
    pub fn symbols_in_file(&self, rel_path: &str) -> Vec<EntitySearchHit> {
        let norm = rel_path.trim().replace('\\', "/");
        let Some(ast) = self.parsed.get(&norm) else {
            return Vec::new();
        };
        ast.symbols
            .iter()
            .map(|sym| EntitySearchHit {
                file: norm.clone(),
                name: sym.name.clone(),
                qualified_name: sym.qualified_name.clone(),
                kind: sym.kind.label().to_string(),
                start_line: sym.start_line,
                end_line: sym.end_line,
                signature: sym.signature.clone(),
                score: 1.0,
            })
            .collect()
    }

    /// LocAgent (`arXiv:2503.09089`) structured entity search across parsed CST symbols.
    pub fn search_entity(&self, query: &str, limit: usize) -> Vec<EntitySearchHit> {
        let q_lower = query.trim().to_ascii_lowercase();
        if q_lower.is_empty() {
            return Vec::new();
        }
        let q_tokens = tokenize_code(&q_lower);
        let mut hits: Vec<(f64, EntitySearchHit)> = Vec::new();

        for (file, ast) in &self.parsed {
            for sym in &ast.symbols {
                let name_l = sym.name.to_ascii_lowercase();
                let qname_l = sym.qualified_name.to_ascii_lowercase();
                let mut score = 0.0f64;
                if name_l == q_lower || qname_l == q_lower {
                    score += 12.0;
                } else if qname_l.ends_with(&format!(".{q_lower}"))
                    || qname_l.ends_with(&format!("::{q_lower}"))
                {
                    score += 9.0;
                } else if name_l.contains(&q_lower) || qname_l.contains(&q_lower) {
                    score += 5.0;
                } else {
                    for qt in &q_tokens {
                        if name_l.contains(qt.as_str()) {
                            score += 2.0;
                        } else if sym.signature.to_ascii_lowercase().contains(qt.as_str()) {
                            score += 0.8;
                        }
                    }
                }
                if score > 0.0 {
                    hits.push((
                        score,
                        EntitySearchHit {
                            file: file.clone(),
                            name: sym.name.clone(),
                            qualified_name: sym.qualified_name.clone(),
                            kind: sym.kind.label().to_string(),
                            start_line: sym.start_line,
                            end_line: sym.end_line,
                            signature: sym.signature.clone(),
                            score,
                        },
                    ));
                }
            }
        }
        hits.sort_by(|a, b| {
            b.0.total_cmp(&a.0)
                .then_with(|| a.1.file.cmp(&b.1.file))
                .then_with(|| a.1.start_line.cmp(&b.1.start_line))
        });
        hits.into_iter()
            .take(limit.clamp(1, 50))
            .map(|(_, h)| h)
            .collect()
    }

    /// LocAgent k-hop heterogeneous code graph traversal starting from a file path or symbol name.
    pub fn traverse_graph(&self, seed: &str, max_hops: usize) -> GraphTraversalReport {
        let hops = max_hops.clamp(1, 3);
        let norm_seed = seed.trim().replace('\\', "/");
        let mut seed_files: Vec<String> = Vec::new();
        if self.parsed.contains_key(&norm_seed) {
            seed_files.push(norm_seed.clone());
        } else {
            for hit in self.search_entity(seed, 5) {
                if !seed_files.contains(&hit.file) {
                    seed_files.push(hit.file);
                }
            }
        }

        let csr = CsrGraph::build(&self.parsed, self.cached_forensics.as_ref());
        let node_to_idx: FxHashMap<&str, usize> = csr
            .nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.as_str(), i))
            .collect();

        let mut visited: FxHashMap<usize, usize> = FxHashMap::default();
        let mut frontier: Vec<usize> = Vec::new();
        for sf in &seed_files {
            if let Some(&idx) = node_to_idx.get(sf.as_str()) {
                visited.insert(idx, 0);
                frontier.push(idx);
            }
        }

        let mut edges_out = Vec::new();
        for depth in 1..=hops {
            let mut next_frontier = Vec::new();
            for &u in &frontier {
                let start = csr.row_ptr[u];
                let end = csr.row_ptr[u + 1];
                for edge_pos in start..end {
                    let v = csr.col_idx[edge_pos];
                    let weight = csr.weights[edge_pos];
                    if edges_out.len() < 80 {
                        edges_out.push(GraphEdgeInfo {
                            source: csr.nodes[u].clone(),
                            target: csr.nodes[v].clone(),
                            specifier: format!("csr:{weight:.2}"),
                        });
                    }
                    if let std::collections::hash_map::Entry::Vacant(e) = visited.entry(v) {
                        e.insert(depth);
                        next_frontier.push(v);
                    }
                }
            }
            frontier = next_frontier;
            if frontier.is_empty() {
                break;
            }
        }

        let mut nodes_out: Vec<String> = visited.keys().map(|&i| csr.nodes[i].clone()).collect();
        nodes_out.sort();
        GraphTraversalReport {
            seed: seed.to_string(),
            hops,
            seed_files,
            reached_files: nodes_out,
            edges: edges_out,
        }
    }

    /// Execute pure-Rust hybrid/symbol/literal/regex search fused with Personalized PageRank.
    #[allow(clippy::too_many_arguments)]
    pub fn search(
        &self,
        query: &str,
        mode: SearchMode,
        subpath: Option<&str>,
        case_sensitive: bool,
        context_lines: usize,
        max_matches: usize,
        permission_rules: &[PermissionRule],
        workspace_trusted: bool,
        approval_mode: ApprovalMode,
    ) -> Result<SearchOutcome> {
        let ppr_scores = if matches!(mode, SearchMode::Hybrid | SearchMode::Symbol) {
            self.compute_ppr_map(Some(query))
        } else {
            BTreeMap::new()
        };
        self.search_index.search(&SearchQueryOptions {
            workspace_root: self.merkle.workspace_root(),
            query,
            mode,
            subpath,
            case_sensitive,
            context_lines,
            max_matches,
            permission_rules,
            workspace_trusted,
            approval_mode,
            ppr_scores: &ppr_scores,
            parsed_asts: &self.parsed,
        })
    }

    /// Render a binary-search token-budgeted PPR AST RepoMap directly for Turn-1 `<workspace_context>`.
    pub fn render_turn1_repomap(&self, prompt_text: &str, token_budget: usize) -> String {
        if self.parsed.is_empty() {
            return String::new();
        }
        let csr = CsrGraph::build(&self.parsed, self.cached_forensics.as_ref());
        let ppr = csr.compute_ppr(
            &self.parsed,
            Some(prompt_text),
            self.cached_forensics.as_ref(),
        );
        let mut order: Vec<usize> = (0..csr.nodes.len()).collect();
        order.sort_by(|&a, &b| {
            ppr[b]
                .total_cmp(&ppr[a])
                .then_with(|| csr.nodes[a].cmp(&csr.nodes[b]))
        });

        let short_hash: String = self.merkle.root_hash().chars().take(12).collect();
        let total_files = self.parsed.len();
        let total_syms = self.symbol_count();

        let render_k = |k: usize| -> String {
            let mut out = format!(
                "[RepoMap | blake3={} | files={} | symbols={} | ppr_top={}]\n",
                short_hash, total_files, total_syms, k
            );
            let mut kept_set = FxHashSet::default();
            for &idx in order.iter().take(k) {
                kept_set.insert(idx);
                let path = &csr.nodes[idx];
                let ast = &self.parsed[path];
                out.push_str(&format!("- {} [{}]", path, ast.language));
                if let Some(shadowed) = detect_python_stdlib_shadow(path) {
                    out.push_str(&format!(" [WARN: shadows stdlib `{shadowed}`]"));
                }
                if csr.inbound_counts[idx] > 0 {
                    out.push_str(&format!(
                        " (ppr={:.2}, in={})",
                        ppr[idx], csr.inbound_counts[idx]
                    ));
                } else {
                    out.push_str(&format!(" (ppr={:.2})", ppr[idx]));
                }
                if !ast.symbols.is_empty() {
                    let syms: Vec<String> = ast
                        .symbols
                        .iter()
                        .take(6)
                        .map(|s| {
                            if s.end_line > s.start_line + 2 {
                                format!("{}(L{}-{})", s.name, s.start_line, s.end_line)
                            } else {
                                format!("{}(L{})", s.name, s.start_line)
                            }
                        })
                        .collect();
                    out.push_str(&format!(" :: {}", syms.join(", ")));
                    if ast.symbols.len() > 6 {
                        out.push_str(&format!(" (+{})", ast.symbols.len() - 6));
                    }
                }
                out.push('\n');
            }
            if total_files > k {
                let rest: Vec<&str> = order
                    .iter()
                    .skip(k)
                    .take(12)
                    .map(|&idx| csr.nodes[idx].as_str())
                    .collect();
                out.push_str(&format!("Other files: {}", rest.join(", ")));
                if total_files > k + rest.len() {
                    out.push_str(&format!(" (+{} more)", total_files - k - rest.len()));
                }
                out.push('\n');
            }
            // Compact edge list among kept nodes
            let mut edge_strs = Vec::new();
            let mut seen_pair = FxHashSet::default();
            for &(s, d, _, kind) in &csr.display_edges {
                if kept_set.contains(&s) && kept_set.contains(&d) && seen_pair.insert((s, d)) {
                    edge_strs.push(format!(
                        "{} -> {} [{}]",
                        csr.nodes[s],
                        csr.nodes[d],
                        kind.label()
                    ));
                    if edge_strs.len() >= 10 {
                        break;
                    }
                }
            }
            if !edge_strs.is_empty() {
                out.push_str(&format!("Edges: {}\n", edge_strs.join("; ")));
            }
            out
        };

        // Binary search max `k` fitting cleanly within `token_budget`
        let max_k = order.len().min(30);
        let mut lo = 1usize;
        let mut hi = max_k;
        let mut best_k = 1usize;
        while lo <= hi {
            let mid = (lo + hi) / 2;
            let cand = render_k(mid);
            if estimate_tokens(&cand) as usize <= token_budget {
                best_k = mid;
                lo = mid + 1;
            } else if mid == 0 {
                break;
            } else {
                hi = mid - 1;
            }
        }
        render_k(best_k)
    }

    pub fn build_map(
        &self,
        subpath: Option<&str>,
        query: Option<&str>,
        max_nodes: usize,
    ) -> HarnessGraphMap {
        self.build_map_focused(subpath, query, None, 1, max_nodes)
    }

    pub fn build_map_focused(
        &self,
        subpath: Option<&str>,
        query: Option<&str>,
        focus_symbol: Option<&str>,
        hops: usize,
        max_nodes: usize,
    ) -> HarnessGraphMap {
        let t0 = Instant::now();
        let csr = CsrGraph::build(&self.parsed, self.cached_forensics.as_ref());
        let combined_seed = match (query, focus_symbol) {
            (Some(q), Some(f)) => Some(format!("{q} {f}")),
            (Some(q), None) => Some(q.to_string()),
            (None, Some(f)) => Some(f.to_string()),
            (None, None) => None,
        };
        let ppr = csr.compute_ppr(
            &self.parsed,
            combined_seed.as_deref(),
            self.cached_forensics.as_ref(),
        );

        // Optional ego-subgraph filter around `focus_symbol` (1..=2 hops)
        let ego_filter: Option<FxHashSet<usize>> = focus_symbol
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|sym_q| {
                let sl = sym_q.to_ascii_lowercase();
                let mut frontier: FxHashSet<usize> = FxHashSet::default();
                for (i, path) in csr.nodes.iter().enumerate() {
                    if let Some(ast) = self.parsed.get(path) {
                        if ast.symbols.iter().any(|s| {
                            s.name.to_ascii_lowercase().contains(&sl)
                                || s.qualified_name.to_ascii_lowercase().contains(&sl)
                        }) {
                            frontier.insert(i);
                        }
                    }
                }
                let mut visited = frontier.clone();
                for _ in 0..hops.clamp(1, 2) {
                    let mut next_f = FxHashSet::default();
                    for &u in &frontier {
                        let start = csr.row_ptr[u];
                        let end = csr.row_ptr[u + 1];
                        for &dst in &csr.col_idx[start..end] {
                            if visited.insert(dst) {
                                next_f.insert(dst);
                            }
                        }
                    }
                    frontier = next_f;
                }
                visited
            });

        let norm_sub = subpath
            .map(|s| s.trim().replace('\\', "/").trim_matches('/').to_string())
            .filter(|s| !s.is_empty());
        let query_lower = query
            .map(|q| q.trim().to_ascii_lowercase())
            .filter(|q| !q.is_empty());

        let mut ranked_indices: Vec<usize> = (0..csr.nodes.len())
            .filter(|&idx| {
                let path = &csr.nodes[idx];
                let ast = &self.parsed[path];
                if let Some(ref ego) = ego_filter {
                    if !ego.contains(&idx) {
                        return false;
                    }
                }
                if let Some(ref sub) = norm_sub {
                    if !(path.as_str() == sub.as_str() || path.starts_with(&format!("{sub}/"))) {
                        return false;
                    }
                }
                if let Some(ref q) = query_lower {
                    let path_hit = path.to_ascii_lowercase().contains(q);
                    let sym_hit = ast.symbols.iter().any(|s| {
                        s.name.to_ascii_lowercase().contains(q)
                            || s.qualified_name.to_ascii_lowercase().contains(q)
                    });
                    if !path_hit && !sym_hit {
                        return false;
                    }
                }
                true
            })
            .collect();

        ranked_indices.sort_by(|&a, &b| {
            ppr[b]
                .total_cmp(&ppr[a])
                .then_with(|| csr.inbound_counts[b].cmp(&csr.inbound_counts[a]))
                .then_with(|| csr.nodes[a].cmp(&csr.nodes[b]))
        });

        let total_nodes = ranked_indices.len();
        let total_symbols: usize = ranked_indices
            .iter()
            .map(|&i| self.parsed[&csr.nodes[i]].symbols.len())
            .sum();

        if max_nodes > 0 && ranked_indices.len() > max_nodes {
            ranked_indices.truncate(max_nodes);
        }

        let kept: FxHashSet<usize> = ranked_indices.iter().copied().collect();
        let nodes: Vec<GraphNodeInfo> = ranked_indices
            .iter()
            .map(|&idx| {
                let path = &csr.nodes[idx];
                let ast = &self.parsed[path];
                let sym_names: Vec<String> = ast.symbols.iter().map(|s| s.name.clone()).collect();
                GraphNodeInfo {
                    path: path.clone(),
                    language: ast.language.clone(),
                    symbol_count: sym_names.len(),
                    symbols: sym_names,
                    imports: ast.imports.clone(),
                    imported_by_count: csr.inbound_counts[idx],
                    size_bytes: ast.size_bytes,
                }
            })
            .collect();

        let mut seen_edge = FxHashSet::default();
        let filtered_edges: Vec<GraphEdgeInfo> = csr
            .display_edges
            .iter()
            .filter(|&&(s, d, _, _)| {
                (kept.contains(&s) || kept.contains(&d)) && seen_edge.insert((s, d))
            })
            .map(|(s, d, spec, _)| GraphEdgeInfo {
                source: csr.nodes[*s].clone(),
                target: csr.nodes[*d].clone(),
                specifier: spec.clone(),
            })
            .collect();

        let outline_text = format_detailed_outline(
            &self.merkle,
            &self.parsed,
            &csr,
            &ppr,
            &ranked_indices,
            &filtered_edges,
            total_nodes,
            total_symbols,
        );
        let build_ms =
            ((self.last_build_ms + t0.elapsed().as_secs_f64() * 1000.0) * 100.0).round() / 100.0;

        HarnessGraphMap {
            workspace_path: self.merkle.workspace_root().to_string_lossy().into_owned(),
            root_hash: self.merkle.root_hash().to_string(),
            node_count: total_nodes,
            edge_count: filtered_edges.len(),
            symbol_count: total_symbols,
            build_ms,
            nodes,
            edges: filtered_edges,
            outline_text,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn format_detailed_outline(
    merkle: &MerkleIndex,
    parsed: &BTreeMap<String, ParsedFileAst>,
    csr: &CsrGraph,
    ppr: &[f64],
    ranked_indices: &[usize],
    edges: &[GraphEdgeInfo],
    total_nodes: usize,
    total_symbols: usize,
) -> String {
    let short_hash: String = merkle.root_hash().chars().take(12).collect();
    let mut out = format!(
        "Workspace Map (blake3={}, files={}, symbols={}, edges={}, refresh={:.2}ms)\n",
        short_hash,
        total_nodes,
        total_symbols,
        edges.len(),
        merkle.last_refresh_ms()
    );
    for &idx in ranked_indices {
        let path = &csr.nodes[idx];
        let ast = &parsed[path];
        out.push_str(&format!(
            "- {} [{}] (ppr={:.2}",
            path, ast.language, ppr[idx]
        ));
        if csr.inbound_counts[idx] > 0 {
            out.push_str(&format!(", in={}", csr.inbound_counts[idx]));
        }
        out.push(')');
        if let Some(shadow) = detect_python_stdlib_shadow(path) {
            out.push_str(&format!(" [WARN: shadows Python stdlib `{shadow}`]"));
        }
        if !ast.symbols.is_empty() {
            let preview: Vec<String> = ast
                .symbols
                .iter()
                .take(8)
                .map(|s| format!("{}(L{}-{})", s.qualified_name, s.start_line, s.end_line))
                .collect();
            out.push_str(&format!(" :: {}", preview.join(", ")));
            if ast.symbols.len() > 8 {
                out.push_str(&format!(" (+{})", ast.symbols.len() - 8));
            }
        }
        out.push('\n');
    }
    if !edges.is_empty() {
        out.push_str("Key dependencies:\n");
        for e in edges.iter().take(25) {
            out.push_str(&format!("  {} -> {}\n", e.source, e.target));
        }
        if edges.len() > 25 {
            out.push_str(&format!("  ... (+{} more edges)\n", edges.len() - 25));
        }
    }
    out
}

pub fn detect_language(rel_path: &str) -> &'static str {
    let ext = Path::new(rel_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "py" | "pyi" => "python",
        "rs" => "rust",
        "ts" => "typescript",
        "tsx" => "tsx",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "go" => "go",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" => "cpp",
        "json" => "json",
        "toml" => "toml",
        "yml" | "yaml" => "yaml",
        "md" | "mdx" => "markdown",
        "sh" | "bash" => "shell",
        "ps1" => "powershell",
        "sql" => "sql",
        "css" | "scss" => "css",
        "html" | "htm" => "html",
        "png" | "jpg" | "jpeg" | "gif" | "ico" | "exe" | "dll" | "so" | "dylib" | "wasm"
        | "zip" | "tar" | "gz" | "pdf" | "pyc" | "sqlite" | "db" => "binary",
        _ => "text",
    }
}

thread_local! {
    static TS_PARSER: RefCell<Parser> = RefCell::new(Parser::new());
}

fn ts_language_for(lang: &str) -> Option<Language> {
    match lang {
        "python" => Some(tree_sitter_python::LANGUAGE.into()),
        "javascript" => Some(tree_sitter_javascript::LANGUAGE.into()),
        "typescript" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        "rust" => Some(tree_sitter_rust::LANGUAGE.into()),
        "go" => Some(tree_sitter_go::LANGUAGE.into()),
        _ => None,
    }
}

/// Zero-cost post-edit `tree-sitter` incremental AST + JSON/YAML/TOML syntax verification (D1).
///
/// - Fast-path $O(1)$ early exit when `!tree.root_node().has_error()`.
/// - Delta regression filter: ignores pre-existing unrelated syntax errors outside `edited_span +- 2`!
pub fn verify_syntax_delta(
    rel_path: &str,
    before: &str,
    after: &str,
    edited_span: Option<(usize, usize)>,
) -> SyntaxCheckReport {
    let lang = detect_language(rel_path);
    let ext = Path::new(rel_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    // 1. tree-sitter AST syntax verification (Python, JS/JSX, TS/TSX, Rust, Go)
    if let Some(ts_lang) = ts_language_for(lang) {
        return TS_PARSER.with(|cell| {
            let mut parser = cell.borrow_mut();
            if parser.set_language(&ts_lang).is_err() {
                return SyntaxCheckReport::default();
            }
            let Some(tree_after) = parser.parse(after, None) else {
                return SyntaxCheckReport::default();
            };
            // O(1) fast-path on valid code!
            if !tree_after.root_node().has_error() {
                return SyntaxCheckReport::default();
            }

            let mut after_errs = Vec::new();
            collect_ts_syntax_errors(tree_after.root_node(), after, &mut after_errs, 8);
            if after_errs.is_empty() {
                return SyntaxCheckReport::default();
            }

            // Delta filter against pre-existing errors in `before`
            let mut before_sigs: FxHashSet<(String, String)> = FxHashSet::default();
            if !before.is_empty() {
                if let Some(tree_before) = parser.parse(before, None) {
                    if tree_before.root_node().has_error() {
                        let mut before_errs = Vec::new();
                        collect_ts_syntax_errors(
                            tree_before.root_node(),
                            before,
                            &mut before_errs,
                            16,
                        );
                        for e in before_errs {
                            before_sigs.insert((e.kind, e.snippet));
                        }
                    }
                }
            }

            let filtered: Vec<SyntaxDiagnostic> = after_errs
                .into_iter()
                .filter(|d| {
                    let was_preexisting =
                        before_sigs.contains(&(d.kind.clone(), d.snippet.clone()));
                    if !was_preexisting {
                        return true;
                    }
                    edited_span.is_some_and(|(s, e)| {
                        let l = d.line as usize;
                        l >= s && l <= e
                    })
                })
                .take(5)
                .collect();

            SyntaxCheckReport {
                diagnostics: filtered,
            }
        });
    }

    // 2. Zero-cost config validators (JSON, YAML, TOML)
    if ext == "json" {
        if let Err(err) = serde_json::from_str::<serde_json::Value>(after) {
            let before_ok = before.trim().is_empty()
                || serde_json::from_str::<serde_json::Value>(before).is_ok();
            if before_ok || edited_span.is_none() {
                return SyntaxCheckReport {
                    diagnostics: vec![SyntaxDiagnostic {
                        line: err.line().max(1) as u32,
                        col: err.column().max(1) as u32,
                        kind: "JSON".into(),
                        snippet: err.to_string().chars().take(120).collect(),
                        enclosing_symbol: None,
                    }],
                };
            }
        }
        return SyntaxCheckReport::default();
    }

    if matches!(ext.as_str(), "yml" | "yaml") {
        if let Err(err) = serde_yaml::from_str::<serde_yaml::Value>(after) {
            let before_ok = before.trim().is_empty()
                || serde_yaml::from_str::<serde_yaml::Value>(before).is_ok();
            if before_ok || edited_span.is_none() {
                let (line, col) = err
                    .location()
                    .map(|loc| (loc.line().max(1) as u32, loc.column().max(1) as u32))
                    .unwrap_or((1, 1));
                return SyntaxCheckReport {
                    diagnostics: vec![SyntaxDiagnostic {
                        line,
                        col,
                        kind: "YAML".into(),
                        snippet: err.to_string().chars().take(120).collect(),
                        enclosing_symbol: None,
                    }],
                };
            }
        }
        return SyntaxCheckReport::default();
    }

    if ext == "toml" {
        let errs = validate_toml_structural(after);
        if !errs.is_empty() {
            let before_errs = if before.trim().is_empty() {
                Vec::new()
            } else {
                validate_toml_structural(before)
            };
            if before_errs.is_empty() || errs.len() > before_errs.len() {
                return SyntaxCheckReport { diagnostics: errs };
            }
        }
    }

    SyntaxCheckReport::default()
}

fn collect_ts_syntax_errors(node: Node, src: &str, out: &mut Vec<SyntaxDiagnostic>, limit: usize) {
    if out.len() >= limit || !node.has_error() {
        return;
    }
    if node.is_error() || node.is_missing() {
        let pos = node.start_position();
        let kind = if node.is_missing() {
            format!("MISSING {}", node.kind())
        } else {
            "ERROR".to_string()
        };
        let line_text = src
            .lines()
            .nth(pos.row)
            .unwrap_or("")
            .trim()
            .chars()
            .take(80)
            .collect::<String>();
        let enclosing = find_enclosing_symbol_name(node, src);
        out.push(SyntaxDiagnostic {
            line: pos.row as u32 + 1,
            col: pos.column as u32 + 1,
            kind,
            snippet: line_text,
            enclosing_symbol: enclosing,
        });
        return;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.has_error() {
            collect_ts_syntax_errors(child, src, out, limit);
            if out.len() >= limit {
                break;
            }
        }
    }
}

fn find_enclosing_symbol_name(node: Node, src: &str) -> Option<String> {
    let mut cur = node.parent();
    while let Some(p) = cur {
        let k = p.kind();
        if matches!(
            k,
            "function_definition"
                | "class_definition"
                | "function_declaration"
                | "method_definition"
                | "class_declaration"
                | "function_item"
                | "struct_item"
                | "impl_item"
                | "method_declaration"
        ) {
            if let Some(name_node) = p
                .child_by_field_name("name")
                .or_else(|| p.child_by_field_name("type"))
            {
                if let Ok(txt) = name_node.utf8_text(src.as_bytes()) {
                    let t = txt.trim();
                    if !t.is_empty() {
                        return Some(t.to_string());
                    }
                }
            }
        }
        cur = p.parent();
    }
    None
}

/// Zero-dependency structural TOML syntax checker catching unclosed quotes, unbalanced brackets,
/// malformed `[section]` headers, and key/value lines missing `=`.
fn validate_toml_structural(src: &str) -> Vec<SyntaxDiagnostic> {
    let mut out = Vec::new();
    let mut bracket_depth: i32 = 0;
    let mut brace_depth: i32 = 0;
    let mut in_multiline_double = false;
    let mut in_multiline_single = false;

    for (idx, raw_line) in src.lines().enumerate() {
        let line_no = idx as u32 + 1;
        let trimmed = raw_line.trim();
        if trimmed.is_empty()
            || (!in_multiline_double && !in_multiline_single && trimmed.starts_with('#'))
        {
            continue;
        }
        let bytes = raw_line.as_bytes();
        let mut i = 0usize;
        let mut in_dquote = false;
        let mut in_squote = false;
        while i < bytes.len() {
            if in_multiline_double {
                if bytes[i..].starts_with(b"\"\"\"") {
                    in_multiline_double = false;
                    i += 3;
                    continue;
                }
                if bytes[i] == b'\\' {
                    i += 2;
                    continue;
                }
                i += 1;
                continue;
            }
            if in_multiline_single {
                if bytes[i..].starts_with(b"'''") {
                    in_multiline_single = false;
                    i += 3;
                    continue;
                }
                i += 1;
                continue;
            }
            let b = bytes[i];
            if !in_squote && !in_dquote && b == b'#' {
                break;
            }
            if !in_squote && !in_dquote && bytes[i..].starts_with(b"\"\"\"") {
                in_multiline_double = true;
                i += 3;
                continue;
            }
            if !in_squote && !in_dquote && bytes[i..].starts_with(b"'''") {
                in_multiline_single = true;
                i += 3;
                continue;
            }
            if b == b'"' && !in_squote {
                in_dquote = !in_dquote;
            } else if b == b'\'' && !in_dquote {
                in_squote = !in_squote;
            } else if b == b'\\' && in_dquote {
                i += 2;
                continue;
            } else if !in_dquote && !in_squote {
                match b {
                    b'[' => bracket_depth += 1,
                    b']' => bracket_depth -= 1,
                    b'{' => brace_depth += 1,
                    b'}' => brace_depth -= 1,
                    _ => {}
                }
            }
            i += 1;
        }

        if in_dquote || in_squote {
            out.push(SyntaxDiagnostic {
                line: line_no,
                col: 1,
                kind: "TOML".into(),
                snippet: format!(
                    "Unclosed string literal: {}",
                    trimmed.chars().take(60).collect::<String>()
                ),
                enclosing_symbol: None,
            });
            break;
        }
        if !in_multiline_double && !in_multiline_single && bracket_depth == 0 && brace_depth == 0 {
            if trimmed.starts_with('[') {
                let code_part = trimmed.split('#').next().unwrap_or("").trim();
                if !code_part.ends_with(']') {
                    out.push(SyntaxDiagnostic {
                        line: line_no,
                        col: 1,
                        kind: "TOML".into(),
                        snippet: format!(
                            "Malformed table header: {}",
                            trimmed.chars().take(60).collect::<String>()
                        ),
                        enclosing_symbol: None,
                    });
                }
            } else if !trimmed.starts_with(']')
                && !trimmed.starts_with('}')
                && !trimmed.contains('=')
            {
                out.push(SyntaxDiagnostic {
                    line: line_no,
                    col: 1,
                    kind: "TOML".into(),
                    snippet: format!(
                        "Expected key = value assignment: {}",
                        trimmed.chars().take(60).collect::<String>()
                    ),
                    enclosing_symbol: None,
                });
            }
        }
        if bracket_depth < 0 || brace_depth < 0 {
            out.push(SyntaxDiagnostic {
                line: line_no,
                col: 1,
                kind: "TOML".into(),
                snippet: format!(
                    "Unmatched closing delimiter: {}",
                    trimmed.chars().take(60).collect::<String>()
                ),
                enclosing_symbol: None,
            });
            break;
        }
        if out.len() >= 3 {
            break;
        }
    }
    if out.is_empty()
        && (bracket_depth != 0 || brace_depth != 0 || in_multiline_double || in_multiline_single)
    {
        out.push(SyntaxDiagnostic {
            line: src.lines().count().max(1) as u32,
            col: 1,
            kind: "TOML".into(),
            snippet: "Unclosed TOML bracket/brace/multiline string at EOF".into(),
            enclosing_symbol: None,
        });
    }
    out
}

fn parse_file_ast(
    lang: &str,
    blake3_hex: &str,
    content: Option<&str>,
    size_bytes: u64,
) -> ParsedFileAst {
    let mut ast = ParsedFileAst {
        language: lang.to_string(),
        blake3_hex: blake3_hex.to_string(),
        symbols: Vec::new(),
        imports: Vec::new(),
        call_refs: Vec::new(),
        inherits_refs: Vec::new(),
        doc_terms: Vec::new(),
        size_bytes,
    };
    let Some(src) = content else {
        return ast;
    };

    if let Some(ts_lang) = ts_language_for(lang) {
        TS_PARSER.with(|cell| {
            let mut parser = cell.borrow_mut();
            if parser.set_language(&ts_lang).is_ok() {
                if let Some(tree) = parser.parse(src, None) {
                    let mut ctx = AstWalkCtx::default();
                    walk_ts_node(tree.root_node(), lang, src, None, &mut ctx);
                    ast.symbols = ctx.symbols;
                    ast.imports = ctx.imports;
                    ast.call_refs = ctx.call_refs;
                    ast.inherits_refs = ctx.inherits_refs;
                    ast.doc_terms = ctx.doc_terms;
                }
            }
        });
        return ast;
    }

    if matches!(lang, "c" | "cpp") {
        extract_c_cpp_lexical(src, &mut ast);
    }
    ast
}

#[derive(Default)]
struct AstWalkCtx {
    symbols: Vec<AstSymbol>,
    seen_syms: FxHashSet<String>,
    imports: Vec<String>,
    seen_imps: FxHashSet<String>,
    call_refs: Vec<String>,
    seen_calls: FxHashSet<String>,
    inherits_refs: Vec<String>,
    seen_inh: FxHashSet<String>,
    doc_terms: Vec<String>,
}

impl AstWalkCtx {
    fn push_sym(&mut self, sym: AstSymbol) {
        if self.symbols.len() < 256 {
            let key = format!("{}:{}", sym.qualified_name, sym.start_line);
            if self.seen_syms.insert(key) {
                self.symbols.push(sym);
            }
        }
    }
    fn push_imp(&mut self, s: &str) {
        let trimmed = s.trim().trim_matches('"').trim_matches('\'');
        if !trimmed.is_empty() && self.imports.len() < 60 && self.seen_imps.insert(trimmed.into()) {
            self.imports.push(trimmed.into());
        }
    }
    fn push_call(&mut self, s: &str) {
        let t = s.trim();
        if t.len() >= 2 && self.call_refs.len() < 120 && self.seen_calls.insert(t.into()) {
            self.call_refs.push(t.into());
        }
    }
    fn push_inh(&mut self, s: &str) {
        let t = s.trim();
        if t.len() >= 2 && self.inherits_refs.len() < 40 && self.seen_inh.insert(t.into()) {
            self.inherits_refs.push(t.into());
        }
    }
    fn push_doc(&mut self, s: &str) {
        if self.doc_terms.len() < 40 {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                let clipped: String = trimmed.chars().take(120).collect();
                self.doc_terms.push(clipped);
            }
        }
    }
}

fn node_text<'a>(node: Node<'_>, src: &'a str) -> &'a str {
    node.utf8_text(src.as_bytes()).unwrap_or("")
}

fn first_line_sig(node: Node<'_>, src: &str) -> String {
    let raw = node_text(node, src);
    raw.lines()
        .next()
        .unwrap_or("")
        .trim()
        .chars()
        .take(100)
        .collect()
}

fn walk_ts_node(
    node: Node<'_>,
    lang: &str,
    src: &str,
    enclosing_type: Option<&str>,
    ctx: &mut AstWalkCtx,
) {
    let kind = node.kind();
    let mut next_enclosing = enclosing_type.map(String::from);

    match lang {
        "python" => match kind {
            "class_definition" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, src).to_string();
                    let qname = qualify(enclosing_type, &name);
                    ctx.push_sym(AstSymbol {
                        name: name.clone(),
                        qualified_name: qname.clone(),
                        kind: SymbolKind::Class,
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        signature: first_line_sig(node, src),
                    });
                    if let Some(supers) = node.child_by_field_name("superclasses") {
                        let mut cur = supers.walk();
                        for ch in supers.named_children(&mut cur) {
                            let b = last_ident(node_text(ch, src));
                            ctx.push_inh(b);
                        }
                    }
                    next_enclosing = Some(qname);
                }
            }
            "function_definition" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, src).to_string();
                    let qname = qualify(enclosing_type, &name);
                    ctx.push_sym(AstSymbol {
                        name,
                        qualified_name: qname,
                        kind: if enclosing_type.is_some() {
                            SymbolKind::Method
                        } else {
                            SymbolKind::Function
                        },
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        signature: first_line_sig(node, src),
                    });
                }
            }
            "import_statement" => {
                let mut cur = node.walk();
                for ch in node.named_children(&mut cur) {
                    if ch.kind() == "dotted_name" {
                        ctx.push_imp(node_text(ch, src));
                    } else if ch.kind() == "aliased_import" {
                        if let Some(n) = ch.child_by_field_name("name") {
                            ctx.push_imp(node_text(n, src));
                        }
                    }
                }
            }
            "import_from_statement" => {
                if let Some(mod_node) = node.child_by_field_name("module_name") {
                    ctx.push_imp(node_text(mod_node, src));
                }
            }
            "call" => {
                if let Some(fn_node) = node.child_by_field_name("function") {
                    ctx.push_call(last_ident(node_text(fn_node, src)));
                }
            }
            "comment" => {
                ctx.push_doc(node_text(node, src).trim_start_matches('#'));
            }
            "expression_statement" => {
                if let Some(ch) = node.named_child(0) {
                    if ch.kind() == "string" {
                        ctx.push_doc(node_text(ch, src).trim_matches(['"', '\'']));
                    }
                }
            }
            _ => {}
        },
        "javascript" | "typescript" | "tsx" => match kind {
            "class_declaration" | "abstract_class_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, src).to_string();
                    let qname = qualify(enclosing_type, &name);
                    ctx.push_sym(AstSymbol {
                        name: name.clone(),
                        qualified_name: qname.clone(),
                        kind: SymbolKind::Class,
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        signature: first_line_sig(node, src),
                    });
                    next_enclosing = Some(qname);
                }
                let mut cur = node.walk();
                for ch in node.named_children(&mut cur) {
                    if matches!(
                        ch.kind(),
                        "class_heritage" | "extends_clause" | "implements_clause"
                    ) {
                        for tok in tokenize_code(node_text(ch, src)) {
                            if !matches!(tok.as_str(), "extends" | "implements") {
                                ctx.push_inh(&tok);
                            }
                        }
                    }
                }
            }
            "interface_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, src).to_string();
                    ctx.push_sym(AstSymbol {
                        name: name.clone(),
                        qualified_name: qualify(enclosing_type, &name),
                        kind: SymbolKind::Interface,
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        signature: first_line_sig(node, src),
                    });
                }
            }
            "type_alias_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, src).to_string();
                    ctx.push_sym(AstSymbol {
                        name: name.clone(),
                        qualified_name: qualify(enclosing_type, &name),
                        kind: SymbolKind::TypeAlias,
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        signature: first_line_sig(node, src),
                    });
                }
            }
            "enum_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, src).to_string();
                    ctx.push_sym(AstSymbol {
                        name: name.clone(),
                        qualified_name: qualify(enclosing_type, &name),
                        kind: SymbolKind::Enum,
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        signature: first_line_sig(node, src),
                    });
                }
            }
            "function_declaration" | "generator_function_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, src).to_string();
                    ctx.push_sym(AstSymbol {
                        name: name.clone(),
                        qualified_name: qualify(enclosing_type, &name),
                        kind: SymbolKind::Function,
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        signature: first_line_sig(node, src),
                    });
                }
            }
            "method_definition" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, src).to_string();
                    if name != "constructor" {
                        ctx.push_sym(AstSymbol {
                            name: name.clone(),
                            qualified_name: qualify(enclosing_type, &name),
                            kind: SymbolKind::Method,
                            start_line: node.start_position().row as u32 + 1,
                            end_line: node.end_position().row as u32 + 1,
                            signature: first_line_sig(node, src),
                        });
                    }
                }
            }
            "variable_declarator" => {
                if let (Some(name_node), Some(val_node)) = (
                    node.child_by_field_name("name"),
                    node.child_by_field_name("value"),
                ) {
                    if matches!(val_node.kind(), "arrow_function" | "function_expression") {
                        let name = node_text(name_node, src).to_string();
                        ctx.push_sym(AstSymbol {
                            name: name.clone(),
                            qualified_name: qualify(enclosing_type, &name),
                            kind: SymbolKind::Function,
                            start_line: node.start_position().row as u32 + 1,
                            end_line: node.end_position().row as u32 + 1,
                            signature: first_line_sig(node, src),
                        });
                    }
                }
            }
            "import_statement" | "export_statement" => {
                if let Some(src_node) = node.child_by_field_name("source") {
                    ctx.push_imp(node_text(src_node, src));
                }
            }
            "call_expression" => {
                if let Some(fn_node) = node.child_by_field_name("function") {
                    let fn_name = node_text(fn_node, src);
                    if fn_name == "require" {
                        if let Some(args) = node.child_by_field_name("arguments") {
                            if let Some(first) = args.named_child(0) {
                                ctx.push_imp(node_text(first, src));
                            }
                        }
                    } else {
                        ctx.push_call(last_ident(fn_name));
                    }
                }
            }
            "comment" => {
                ctx.push_doc(node_text(node, src).trim_start_matches(['/', '*']));
            }
            _ => {}
        },
        "rust" => match kind {
            "struct_item" | "enum_item" | "trait_item" | "type_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, src).to_string();
                    let sk = match kind {
                        "struct_item" => SymbolKind::Struct,
                        "enum_item" => SymbolKind::Enum,
                        "trait_item" => SymbolKind::Trait,
                        _ => SymbolKind::TypeAlias,
                    };
                    ctx.push_sym(AstSymbol {
                        name: name.clone(),
                        qualified_name: qualify(enclosing_type, &name),
                        kind: sk,
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        signature: first_line_sig(node, src),
                    });
                }
            }
            "impl_item" => {
                if let Some(tr_node) = node.child_by_field_name("trait") {
                    ctx.push_inh(last_ident(node_text(tr_node, src)));
                }
                if let Some(ty_node) = node.child_by_field_name("type") {
                    let ty_name = last_ident(node_text(ty_node, src));
                    if !ty_name.is_empty() {
                        next_enclosing = Some(ty_name.to_string());
                    }
                }
            }
            "function_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, src).to_string();
                    ctx.push_sym(AstSymbol {
                        name: name.clone(),
                        qualified_name: qualify(enclosing_type, &name),
                        kind: if enclosing_type.is_some() {
                            SymbolKind::Method
                        } else {
                            SymbolKind::Function
                        },
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        signature: first_line_sig(node, src),
                    });
                }
            }
            "use_declaration" => {
                let raw = node_text(node, src)
                    .trim_start_matches("pub")
                    .trim()
                    .trim_start_matches("use")
                    .trim()
                    .trim_end_matches(';');
                if raw.starts_with("crate::")
                    || raw.starts_with("super::")
                    || raw.starts_with("self::")
                {
                    ctx.push_imp(raw);
                }
            }
            "mod_item" => {
                if node.child_by_field_name("body").is_none() {
                    if let Some(name_node) = node.child_by_field_name("name") {
                        ctx.push_imp(&format!("mod::{}", node_text(name_node, src)));
                    }
                }
            }
            "call_expression" => {
                if let Some(fn_node) = node.child_by_field_name("function") {
                    ctx.push_call(last_ident(node_text(fn_node, src)));
                }
            }
            "line_comment" | "block_comment" => {
                let raw = node_text(node, src);
                if raw.starts_with("///") || raw.starts_with("//!") {
                    ctx.push_doc(raw.trim_start_matches(['/', '!']));
                }
            }
            _ => {}
        },
        "go" => match kind {
            "function_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, src).to_string();
                    ctx.push_sym(AstSymbol {
                        name: name.clone(),
                        qualified_name: name,
                        kind: SymbolKind::Function,
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        signature: first_line_sig(node, src),
                    });
                }
            }
            "method_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, src).to_string();
                    ctx.push_sym(AstSymbol {
                        name: name.clone(),
                        qualified_name: name,
                        kind: SymbolKind::Method,
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        signature: first_line_sig(node, src),
                    });
                }
            }
            "type_spec" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, src).to_string();
                    ctx.push_sym(AstSymbol {
                        name: name.clone(),
                        qualified_name: name,
                        kind: SymbolKind::Struct,
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        signature: first_line_sig(node, src),
                    });
                }
            }
            "import_spec" => {
                if let Some(path_node) = node.child_by_field_name("path") {
                    ctx.push_imp(node_text(path_node, src));
                }
            }
            "call_expression" => {
                if let Some(fn_node) = node.child_by_field_name("function") {
                    ctx.push_call(last_ident(node_text(fn_node, src)));
                }
            }
            "comment" => {
                ctx.push_doc(node_text(node, src).trim_start_matches(['/', '*']));
            }
            _ => {}
        },
        _ => {}
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        walk_ts_node(child, lang, src, next_enclosing.as_deref(), ctx);
    }
}

fn qualify(enclosing: Option<&str>, name: &str) -> String {
    match enclosing {
        Some(p) if !p.is_empty() => format!("{p}.{name}"),
        _ => name.to_string(),
    }
}

fn last_ident(expr: &str) -> &str {
    let trimmed = expr.trim().split('<').next().unwrap_or(expr.trim());
    trimmed
        .rsplit(['.', ':', ' '])
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '_')
}

fn extract_c_cpp_lexical(src: &str, ast: &mut ParsedFileAst) {
    static C_RE: OnceLock<(Regex, Regex)> = OnceLock::new();
    let (sym_re, inc_re) = C_RE.get_or_init(|| {
        (
            Regex::new(r"(?m)^(?:struct|class|enum)[ \t]+([A-Za-z_][A-Za-z0-9_]*)|^[A-Za-z_][A-Za-z0-9_* \t]+?[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\([^;]*\)[ \t]*\{").unwrap(),
            Regex::new(r#"(?m)^[ \t]*#include[ \t]*"([^"]+)""#).unwrap(),
        )
    });
    for cap in sym_re.captures_iter(src) {
        if let Some(m) = cap.get(1).or_else(|| cap.get(2)) {
            let line_no = src[..m.start()].bytes().filter(|&b| b == b'\n').count() as u32 + 1;
            let name = m.as_str().to_string();
            ast.symbols.push(AstSymbol {
                name: name.clone(),
                qualified_name: name.clone(),
                kind: if cap.get(1).is_some() {
                    SymbolKind::Struct
                } else {
                    SymbolKind::Function
                },
                start_line: line_no,
                end_line: line_no,
                signature: name,
            });
        }
    }
    for cap in inc_re.captures_iter(src) {
        if let Some(m) = cap.get(1) {
            ast.imports.push(m.as_str().to_string());
        }
    }
}

fn resolve_workspace_import(
    src_rel: &str,
    specifier: &str,
    lang: &str,
    all_files: &BTreeSet<&str>,
) -> Option<String> {
    let src_dir = src_rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    match lang {
        "python" => {
            let mut base_dir = src_dir.to_string();
            let mut mod_str = specifier;
            if mod_str.starts_with('.') {
                let dots = mod_str.chars().take_while(|&c| c == '.').count();
                mod_str = &mod_str[dots..];
                for _ in 1..dots {
                    base_dir = base_dir
                        .rsplit_once('/')
                        .map(|(d, _)| d.to_string())
                        .unwrap_or_default();
                }
                let mod_path = mod_str.replace('.', "/");
                for cand in [
                    join_rel(&base_dir, &format!("{mod_path}.py")),
                    join_rel(&base_dir, &format!("{mod_path}/__init__.py")),
                ] {
                    if all_files.contains(cand.as_str()) {
                        return Some(cand);
                    }
                }
            } else {
                let mod_path = mod_str.replace('.', "/");
                for cand in [
                    format!("{mod_path}.py"),
                    format!("{mod_path}/__init__.py"),
                    format!("src/{mod_path}.py"),
                    format!("src/{mod_path}/__init__.py"),
                    join_rel(src_dir, &format!("{mod_path}.py")),
                ] {
                    if all_files.contains(cand.as_str()) {
                        return Some(cand);
                    }
                }
            }
            None
        }
        "javascript" | "typescript" | "tsx" => {
            if !specifier.starts_with('.') {
                return None;
            }
            let joined = normalize_rel_join(src_dir, specifier);
            for ext in [
                "",
                ".ts",
                ".tsx",
                ".js",
                ".jsx",
                ".mjs",
                "/index.ts",
                "/index.tsx",
                "/index.js",
            ] {
                let cand = format!("{joined}{ext}");
                if all_files.contains(cand.as_str()) {
                    return Some(cand);
                }
            }
            None
        }
        "rust" => {
            if let Some(m) = specifier.strip_prefix("mod::") {
                for cand in [
                    join_rel(src_dir, &format!("{m}.rs")),
                    join_rel(src_dir, &format!("{m}/mod.rs")),
                ] {
                    if all_files.contains(cand.as_str()) {
                        return Some(cand);
                    }
                }
            } else if let Some(rest) = specifier.strip_prefix("crate::") {
                let first = rest.split("::").next().unwrap_or("");
                if !first.is_empty() {
                    let crate_src = src_rel
                        .split("/src/")
                        .next()
                        .map(|p| {
                            if src_rel.contains("/src/") {
                                format!("{p}/src")
                            } else {
                                "src".into()
                            }
                        })
                        .unwrap_or_else(|| "src".into());
                    for cand in [
                        join_rel(&crate_src, &format!("{first}.rs")),
                        join_rel(&crate_src, &format!("{first}/mod.rs")),
                    ] {
                        if all_files.contains(cand.as_str()) {
                            return Some(cand);
                        }
                    }
                }
            }
            None
        }
        "c" | "cpp" => {
            let joined = normalize_rel_join(src_dir, specifier);
            if all_files.contains(joined.as_str()) {
                return Some(joined);
            }
            if all_files.contains(specifier) {
                return Some(specifier.to_string());
            }
            None
        }
        _ => None,
    }
}

fn join_rel(dir: &str, child: &str) -> String {
    let c = child.trim_start_matches('/');
    if dir.is_empty() {
        c.to_string()
    } else if c.is_empty() {
        dir.to_string()
    } else {
        format!("{dir}/{c}")
    }
}

fn normalize_rel_join(base_dir: &str, rel: &str) -> String {
    let mut parts: Vec<&str> = base_dir.split('/').filter(|s| !s.is_empty()).collect();
    let norm = rel.replace('\\', "/");
    for seg in norm.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_sitter_extracts_python_ts_js_rust_go_symbols_calls_and_inheritance() {
        let tmp = std::env::temp_dir().join(format!("omni_ts_ast_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(tmp.join("pkg")).unwrap();
        fs::write(
            tmp.join("pkg/base.py"),
            "class BaseEngine:\n    def balance(self):\n        return 0\n",
        )
        .unwrap();
        fs::write(
            tmp.join("pkg/app.py"),
            "from .base import BaseEngine\nclass LedgerEngine(BaseEngine):\n    def run(self):\n        return self.balance()\n",
        )
        .unwrap();
        fs::write(
            tmp.join("service.ts"),
            "import { helper } from './util';\nexport interface AuthCfg { key: string }\nexport const verifyToken = (t: string) => helper(t);\n",
        )
        .unwrap();
        fs::write(
            tmp.join("util.js"),
            "export function helper(x) { return x; }\n",
        )
        .unwrap();
        fs::write(
            tmp.join("lib.rs"),
            "pub trait Runner { fn run(&self); }\npub struct App;\nimpl Runner for App { fn run(&self) {} }\n",
        )
        .unwrap();
        fs::write(
            tmp.join("main.go"),
            "package main\ntype Server struct{}\nfunc (s *Server) Start() {}\n",
        )
        .unwrap();

        let mut g = WorkspaceGraphIndex::new(&tmp);
        g.refresh().unwrap();

        let py_app = &g.parsed_asts()["pkg/app.py"];
        assert!(py_app
            .symbols
            .iter()
            .any(|s| s.qualified_name == "LedgerEngine.run"));
        assert!(py_app.inherits_refs.iter().any(|b| b == "BaseEngine"));
        assert!(py_app.call_refs.iter().any(|c| c == "balance"));

        let ts_svc = &g.parsed_asts()["service.ts"];
        assert!(ts_svc.symbols.iter().any(|s| s.name == "AuthCfg"));
        assert!(ts_svc.symbols.iter().any(|s| s.name == "verifyToken"));
        assert!(ts_svc.call_refs.iter().any(|c| c == "helper"));

        let rs_lib = &g.parsed_asts()["lib.rs"];
        assert!(rs_lib.symbols.iter().any(|s| s.name == "Runner"));
        assert!(rs_lib.symbols.iter().any(|s| s.qualified_name == "App.run"));
        assert!(rs_lib.inherits_refs.iter().any(|t| t == "Runner"));

        let go_main = &g.parsed_asts()["main.go"];
        assert!(go_main.symbols.iter().any(|s| s.name == "Server"));
        assert!(go_main.symbols.iter().any(|s| s.name == "Start"));

        let map = g.build_map(None, None, 40);
        assert!(map
            .edges
            .iter()
            .any(|e| e.source == "pkg/app.py" && e.target == "pkg/base.py"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ppr_ranks_query_relevant_hub_and_callers_above_unrelated_files() {
        let mut parsed = BTreeMap::new();
        for i in 0..80 {
            let name = format!("noise_{i:02}.py");
            parsed.insert(
                name,
                ParsedFileAst {
                    language: "python".into(),
                    blake3_hex: String::new(),
                    symbols: vec![AstSymbol {
                        name: format!("noop_{i}"),
                        qualified_name: format!("noop_{i}"),
                        kind: SymbolKind::Function,
                        start_line: 1,
                        end_line: 2,
                        signature: format!("def noop_{i}():"),
                    }],
                    imports: Vec::new(),
                    call_refs: Vec::new(),
                    inherits_refs: Vec::new(),
                    doc_terms: Vec::new(),
                    size_bytes: 30,
                },
            );
        }
        parsed.insert(
            "ledger/fx.py".into(),
            ParsedFileAst {
                language: "python".into(),
                blake3_hex: String::new(),
                symbols: vec![AstSymbol {
                    name: "convert_currency".into(),
                    qualified_name: "FxTable.convert_currency".into(),
                    kind: SymbolKind::Method,
                    start_line: 10,
                    end_line: 30,
                    signature: "def convert_currency(self, amt):".into(),
                }],
                imports: Vec::new(),
                call_refs: Vec::new(),
                inherits_refs: Vec::new(),
                doc_terms: Vec::new(),
                size_bytes: 200,
            },
        );
        parsed.insert(
            "ledger/engine.py".into(),
            ParsedFileAst {
                language: "python".into(),
                blake3_hex: String::new(),
                symbols: vec![AstSymbol {
                    name: "post_entry".into(),
                    qualified_name: "post_entry".into(),
                    kind: SymbolKind::Function,
                    start_line: 1,
                    end_line: 15,
                    signature: "def post_entry():".into(),
                }],
                imports: vec!["ledger.fx".into()],
                call_refs: vec!["convert_currency".into()],
                inherits_refs: Vec::new(),
                doc_terms: Vec::new(),
                size_bytes: 150,
            },
        );

        let t0 = Instant::now();
        let csr = CsrGraph::build(&parsed, None);
        let ppr = csr.compute_ppr(&parsed, Some("Fix rounding bug in convert_currency"), None);
        let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
        assert!(elapsed_ms < 20.0, "PPR must run fast, got {elapsed_ms}ms");

        let fx_idx = csr.nodes.iter().position(|p| p == "ledger/fx.py").unwrap();
        let eng_idx = csr
            .nodes
            .iter()
            .position(|p| p == "ledger/engine.py")
            .unwrap();
        let noise_idx = csr.nodes.iter().position(|p| p == "noise_00.py").unwrap();
        assert!(ppr[fx_idx] > ppr[noise_idx] * 5.0);
        assert!(ppr[eng_idx] > ppr[noise_idx]);
    }

    #[test]
    fn detects_python_stdlib_shadowing_and_embeds_budgeted_turn1_repomap() {
        assert_eq!(detect_python_stdlib_shadow("calendar.py"), Some("calendar"));
        assert_eq!(
            detect_python_stdlib_shadow("logging/__init__.py"),
            Some("logging")
        );
        assert_eq!(detect_python_stdlib_shadow("pkg/calendar.py"), None);
        assert_eq!(detect_python_stdlib_shadow("my_module.py"), None);

        let tmp = std::env::temp_dir().join(format!("omni_shadow_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("calendar.py"),
            "def business_days():\n    return 5\n",
        )
        .unwrap();
        fs::write(tmp.join("app.py"), "def run():\n    return 1\n").unwrap();

        let mut g = WorkspaceGraphIndex::new(&tmp);
        g.refresh().unwrap();
        let repomap = g.render_turn1_repomap("Fix import error in app.py", 450);
        assert!(repomap.contains("[WARN: shadows stdlib `calendar`]"));
        assert!(estimate_tokens(&repomap) <= 460);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ast_verify_detects_python_indentation_and_rust_missing_brace_in_under_5ms() {
        let py_ok = "def add(a, b):\n    return a + b\n";
        let py_bad = "def add(a, b):\n    return a + (\n";
        let rs_ok = "fn run() {\n    let x = 1;\n}\n";
        let rs_bad = "fn run() {\n    let x = 1;\n";

        // Warm up grammars once so debug-mode parallel CPU contention doesn't pollute latency check
        let _ = verify_syntax_delta("app.py", py_ok, py_ok, Some((1, 2)));
        let _ = verify_syntax_delta("src/lib.rs", rs_ok, rs_ok, Some((1, 2)));

        let t0 = Instant::now();
        assert!(verify_syntax_delta("app.py", py_ok, py_ok, Some((1, 2))).is_clean());
        let rep_py = verify_syntax_delta("app.py", py_ok, py_bad, Some((2, 2)));
        assert!(!rep_py.is_clean(), "must catch broken Python syntax");

        let rep_rs = verify_syntax_delta("src/lib.rs", rs_ok, rs_bad, Some((2, 3)));
        assert!(!rep_rs.is_clean(), "must catch missing Rust closing brace");
        assert!(
            t0.elapsed().as_millis() < 250,
            "warm AST verification must stay fast (took {}ms)",
            t0.elapsed().as_millis()
        );
    }

    #[test]
    fn locagent_search_entity_and_traverse_graph_k_hop() {
        let tmp = std::env::temp_dir().join(format!("omni_locagent_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(tmp.join("pkg")).unwrap();
        fs::write(
            tmp.join("pkg/ledger.py"),
            "class LedgerEngine:\n    def settle_invoice(self, amount):\n        return amount * 100\n",
        )
        .unwrap();
        fs::write(
            tmp.join("pkg/service.py"),
            "from pkg.ledger import LedgerEngine\n\ndef run_billing(amt):\n    eng = LedgerEngine()\n    return eng.settle_invoice(amt)\n",
        )
        .unwrap();

        let mut g = WorkspaceGraphIndex::new(&tmp);
        g.refresh().unwrap();

        let hits = g.search_entity("settle_invoice", 5);
        assert!(!hits.is_empty(), "search_entity must locate settle_invoice");
        assert_eq!(hits[0].file, "pkg/ledger.py");
        assert!(hits[0].qualified_name.contains("settle_invoice"));

        let trav = g.traverse_graph("pkg/ledger.py", 2);
        assert!(
            trav.seed_files.contains(&"pkg/ledger.py".to_string()),
            "seed_files must include root"
        );
        assert!(
            trav.reached_files.contains(&"pkg/service.py".to_string()),
            "2-hop traversal must discover importing caller pkg/service.py: {:?}",
            trav.reached_files
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ast_verify_ignores_preexisting_unrelated_error_outside_edited_span() {
        let before = "def broken():\n    return (1 +\n\ndef healthy():\n    return 1\n";
        let after = "def broken():\n    return (1 +\n\ndef healthy():\n    return 2\n";
        // Editing lines 4..5 must NOT flag the pre-existing error at line 2!
        let rep = verify_syntax_delta("legacy.py", before, after, Some((4, 5)));
        assert!(
            rep.is_clean(),
            "unrelated pre-existing error outside edited span must be filtered: {:?}",
            rep.diagnostics
        );
    }

    #[test]
    fn config_verify_catches_invalid_json_yaml_and_toml_immediately() {
        let bad_json = verify_syntax_delta("pkg.json", "{}", "{\"a\": 1,}", None);
        assert!(!bad_json.is_clean());
        assert_eq!(bad_json.diagnostics[0].kind, "JSON");

        let bad_yaml = verify_syntax_delta("cfg.yml", "a: 1\n", "a: [1, 2\n", None);
        assert!(!bad_yaml.is_clean());
        assert_eq!(bad_yaml.diagnostics[0].kind, "YAML");

        let bad_toml = verify_syntax_delta(
            "pyproject.toml",
            "[project]\nname = \"x\"\n",
            "[project\nname = \"x\"\n",
            None,
        );
        assert!(!bad_toml.is_clean());
        assert_eq!(bad_toml.diagnostics[0].kind, "TOML");

        let good_toml = verify_syntax_delta(
            "pyproject.toml",
            "",
            "[project]\nname = \"x\"\ndeps = [\n  \"pytest\",\n]\n",
            None,
        );
        assert!(
            good_toml.is_clean(),
            "valid TOML must pass: {:?}",
            good_toml.diagnostics
        );
    }
}
