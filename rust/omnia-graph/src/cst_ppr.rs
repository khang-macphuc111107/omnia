use std::collections::{BTreeMap, BTreeSet};

use rustc_hash::{FxHashMap, FxHashSet};
use serde::{Deserialize, Serialize};
use tree_sitter::{Language, Node, Parser};

/// Relationship kinds in the 4-relation heterogeneous CSR code graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CsrRelationKind {
    Calls,
    Imports,
    Defines,
    References,
}

impl CsrRelationKind {
    #[must_use]
    pub const fn weight(self) -> f64 {
        match self {
            Self::Calls => 1.0,
            Self::Defines => 0.9,
            Self::Imports => 0.75,
            Self::References => 0.55,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Calls => "calls",
            Self::Imports => "imports",
            Self::Defines => "defines",
            Self::References => "references",
        }
    }
}

/// Real Tree-sitter CST extracted symbol record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CstSymbol {
    pub name: String,
    pub kind: String,
    pub line: usize,
    pub end_line: usize,
    pub is_public: bool,
}

/// Real Tree-sitter CST facts extracted from one workspace source file.
#[derive(Debug, Clone, Default)]
pub struct CstFileFacts {
    pub language: &'static str,
    pub symbols: Vec<CstSymbol>,
    pub imports: Vec<String>,
    pub inherits: Vec<String>,
    pub call_refs: Vec<String>,
}

/// Ranked result from Personalized PageRank over the 4-relation CSR code graph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PprEntityHit {
    pub id: String,
    pub score: f64,
    pub score_bps: u32,
}

/// Determine Tree-sitter language from file path extension.
#[must_use]
pub fn detect_cst_language(rel_path: &str) -> Option<&'static str> {
    let ext = rel_path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "rs" => Some("rust"),
        "py" | "pyi" => Some("python"),
        "js" | "mjs" | "cjs" | "jsx" => Some("javascript"),
        "ts" => Some("typescript"),
        "tsx" => Some("tsx"),
        "go" => Some("go"),
        "c" | "h" => Some("c"),
        "cc" | "cpp" | "cxx" | "hpp" | "hxx" | "hh" => Some("cpp"),
        _ => None,
    }
}

fn ts_language(lang: &str) -> Option<Language> {
    match lang {
        "rust" => Some(tree_sitter_rust::LANGUAGE.into()),
        "python" => Some(tree_sitter_python::LANGUAGE.into()),
        "javascript" => Some(tree_sitter_javascript::LANGUAGE.into()),
        "typescript" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        "go" => Some(tree_sitter_go::LANGUAGE.into()),
        #[cfg(feature = "cpp-c-ast")]
        "c" => Some(tree_sitter_c::LANGUAGE.into()),
        #[cfg(feature = "cpp-c-ast")]
        "cpp" => Some(tree_sitter_cpp::LANGUAGE.into()),
        _ => None,
    }
}

/// Extract deterministic CST symbols, imports, inheritance edges, and call references
/// using real Tree-sitter parsers across 8 languages.
#[must_use]
pub fn extract_cst_facts(rel_path: &str, src: &str) -> CstFileFacts {
    let Some(lang_name) = detect_cst_language(rel_path) else {
        return CstFileFacts::default();
    };
    let Some(language) = ts_language(lang_name) else {
        return CstFileFacts::default();
    };
    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return CstFileFacts::default();
    }
    let Some(tree) = parser.parse(src, None) else {
        return CstFileFacts {
            language: lang_name,
            ..Default::default()
        };
    };

    let bytes = src.as_bytes();
    let mut facts = CstFileFacts {
        language: lang_name,
        ..Default::default()
    };
    let mut seen_syms: FxHashSet<(String, usize)> = FxHashSet::default();
    let mut seen_imports: BTreeSet<String> = BTreeSet::new();
    let mut seen_inherits: BTreeSet<String> = BTreeSet::new();
    let mut seen_calls: BTreeSet<String> = BTreeSet::new();

    collect_cst_node(
        tree.root_node(),
        bytes,
        lang_name,
        &mut facts.symbols,
        &mut seen_syms,
        &mut seen_imports,
        &mut seen_inherits,
        &mut seen_calls,
    );
    facts.imports = seen_imports.into_iter().collect();
    facts.inherits = seen_inherits.into_iter().collect();
    facts.call_refs = seen_calls.into_iter().collect();
    facts
}

fn node_text<'a>(node: Node<'_>, bytes: &'a [u8]) -> &'a str {
    node.utf8_text(bytes).unwrap_or("").trim()
}

fn find_ident_child(node: Node<'_>, bytes: &[u8]) -> Option<String> {
    if let Some(n) = node.child_by_field_name("name") {
        let s = node_text(n, bytes);
        if !s.is_empty() {
            return Some(s.to_owned());
        }
    }
    let mut cur = node.walk();
    for ch in node.named_children(&mut cur) {
        if matches!(
            ch.kind(),
            "identifier" | "type_identifier" | "field_identifier" | "property_identifier"
        ) {
            let s = node_text(ch, bytes);
            if !s.is_empty() {
                return Some(s.to_owned());
            }
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn collect_cst_node(
    node: Node<'_>,
    bytes: &[u8],
    lang: &str,
    symbols: &mut Vec<CstSymbol>,
    seen_syms: &mut FxHashSet<(String, usize)>,
    imports: &mut BTreeSet<String>,
    inherits: &mut BTreeSet<String>,
    calls: &mut BTreeSet<String>,
) {
    let kind = node.kind();
    let line = node.start_position().row + 1;
    let end_line = node.end_position().row + 1;

    match kind {
        // Definitions across Rust/Python/JS/TS/Go/C/C++
        "function_item"
        | "struct_item"
        | "enum_item"
        | "trait_item"
        | "type_item"
        | "mod_item"
        | "function_definition"
        | "class_definition"
        | "function_declaration"
        | "class_declaration"
        | "interface_declaration"
        | "type_alias_declaration"
        | "method_definition"
        | "method_declaration"
        | "type_spec"
        | "struct_specifier"
        | "class_specifier"
        | "enum_specifier" => {
            if let Some(name) = find_ident_child(node, bytes) {
                let raw = node_text(node, bytes);
                let is_public = match lang {
                    "rust" => raw.starts_with("pub ") || raw.starts_with("pub("),
                    "go" => name.chars().next().is_some_and(|c| c.is_ascii_uppercase()),
                    "python" => !name.starts_with('_'),
                    _ => true,
                };
                if seen_syms.insert((name.clone(), line)) {
                    symbols.push(CstSymbol {
                        name,
                        kind: kind.to_owned(),
                        line,
                        end_line,
                        is_public,
                    });
                }
            }
            if kind == "class_definition" || kind == "class_declaration" {
                if let Some(supers) = node.child_by_field_name("superclasses") {
                    let s = node_text(supers, bytes);
                    for tok in s.split(|c: char| !c.is_alphanumeric() && c != '_') {
                        if tok.len() >= 2 {
                            inherits.insert(tok.to_owned());
                        }
                    }
                }
            }
        }
        "impl_item" => {
            if let Some(ty) = node.child_by_field_name("type") {
                let t = node_text(ty, bytes);
                if !t.is_empty() && seen_syms.insert((t.to_owned(), line)) {
                    symbols.push(CstSymbol {
                        name: t.to_owned(),
                        kind: "impl_item".to_owned(),
                        line,
                        end_line,
                        is_public: true,
                    });
                }
            }
            if let Some(tr) = node.child_by_field_name("trait") {
                let tr_text = node_text(tr, bytes);
                if !tr_text.is_empty() {
                    inherits.insert(tr_text.to_owned());
                }
            }
        }
        "use_declaration" => {
            let text = node_text(node, bytes)
                .trim_start_matches("pub ")
                .trim_start_matches("use ")
                .trim_end_matches(';')
                .trim();
            if !text.is_empty() {
                imports.insert(text.to_owned());
            }
        }
        "import_statement"
        | "import_from_statement"
        | "import_declaration"
        | "import_spec"
        | "preproc_include" => {
            let text = node_text(node, bytes);
            if !text.is_empty() && text.len() <= 240 {
                imports.insert(text.to_owned());
            }
        }
        "call_expression" | "call" => {
            if let Some(func) = node.child_by_field_name("function") {
                let raw = node_text(func, bytes);
                if let Some(last) = raw
                    .rsplit(['.', ':'])
                    .next()
                    .map(str::trim)
                    .filter(|s| s.len() >= 2 && s.len() <= 64)
                {
                    calls.insert(last.to_owned());
                }
            }
        }
        _ => {}
    }

    let mut cur = node.walk();
    for ch in node.children(&mut cur) {
        collect_cst_node(ch, bytes, lang, symbols, seen_syms, imports, inherits, calls);
    }
}

/// 4-relation Compressed Sparse Row (CSR) bidirectional graph supporting deterministic
/// Personalized PageRank (`alpha = 0.85`).
#[derive(Debug, Clone, Default)]
pub struct CsrCodeGraph {
    node_ids: Vec<String>,
    id_to_idx: FxHashMap<String, usize>,
    offsets: Vec<usize>,
    targets: Vec<usize>,
    weights: Vec<f64>,
}

impl CsrCodeGraph {
    /// Build a symmetric weighted CSR adjacency structure from directed edge tuples
    /// `(from_id, to_id, relation_kind, provenance_weight)`.
    #[must_use]
    pub fn build(nodes: &[String], typed_edges: &[(String, String, CsrRelationKind, f64)]) -> Self {
        let mut node_ids: Vec<String> = nodes.to_vec();
        node_ids.sort();
        node_ids.dedup();
        let mut id_to_idx: FxHashMap<String, usize> = FxHashMap::default();
        for (i, id) in node_ids.iter().enumerate() {
            id_to_idx.insert(id.clone(), i);
        }

        let n = node_ids.len();
        let mut adj: Vec<BTreeMap<usize, f64>> = vec![BTreeMap::new(); n];
        for (from, to, rel, prov_weight) in typed_edges {
            let Some(&u) = id_to_idx.get(from) else {
                continue;
            };
            let Some(&v) = id_to_idx.get(to) else {
                continue;
            };
            if u == v {
                continue;
            }
            let w = (rel.weight() * prov_weight.clamp(0.05, 1.0)).max(0.05);
            *adj[u].entry(v).or_insert(0.0) += w;
            // Reverse damping factor 0.65 preserves bidirectional influence without erasing forward signal.
            *adj[v].entry(u).or_insert(0.0) += w * 0.65;
        }

        let mut offsets = Vec::with_capacity(n + 1);
        let mut targets = Vec::new();
        let mut weights = Vec::new();
        offsets.push(0);
        for row in adj {
            let row_sum: f64 = row.values().sum();
            let norm = if row_sum > 0.0 { row_sum } else { 1.0 };
            for (v, w) in row {
                targets.push(v);
                weights.push(w / norm);
            }
            offsets.push(targets.len());
        }

        Self {
            node_ids,
            id_to_idx,
            offsets,
            targets,
            weights,
        }
    }

    #[must_use]
    pub fn node_count(&self) -> usize {
        self.node_ids.len()
    }

    /// Run power-iteration Personalized PageRank (`alpha = 0.85`, 20 iterations).
    #[must_use]
    pub fn personalized_pagerank(&self, seed_ids: &[&str], top_k: usize) -> Vec<PprEntityHit> {
        let n = self.node_ids.len();
        if n == 0 || top_k == 0 {
            return Vec::new();
        }
        let mut teleport = vec![0.0f64; n];
        let mut seed_hits = 0usize;
        for sid in seed_ids {
            if let Some(&idx) = self.id_to_idx.get(*sid) {
                if teleport[idx] == 0.0 {
                    teleport[idx] = 1.0;
                    seed_hits += 1;
                }
            }
        }
        if seed_hits == 0 {
            let uniform = 1.0 / n as f64;
            teleport.fill(uniform);
        } else {
            for t in &mut teleport {
                *t /= seed_hits as f64;
            }
        }

        let alpha = 0.85f64;
        let mut rank = teleport.clone();
        let mut next = vec![0.0f64; n];

        for _ in 0..20 {
            for (i, slot) in next.iter_mut().enumerate() {
                *slot = (1.0 - alpha) * teleport[i];
            }
            let mut dangling_mass = 0.0f64;
            for u in 0..n {
                let start = self.offsets[u];
                let end = self.offsets[u + 1];
                if start == end {
                    dangling_mass += rank[u];
                    continue;
                }
                let contrib = alpha * rank[u];
                for e in start..end {
                    let v = self.targets[e];
                    next[v] += contrib * self.weights[e];
                }
            }
            if dangling_mass > 0.0 {
                let d = alpha * dangling_mass;
                for (i, slot) in next.iter_mut().enumerate() {
                    *slot += d * teleport[i];
                }
            }
            std::mem::swap(&mut rank, &mut next);
        }

        let max_score = rank.iter().copied().fold(0.0f64, f64::max).max(1e-12);
        let mut scored: Vec<PprEntityHit> = rank
            .into_iter()
            .enumerate()
            .filter(|(_, s)| *s > 0.0)
            .map(|(i, s)| PprEntityHit {
                id: self.node_ids[i].clone(),
                score: s,
                score_bps: ((s / max_score) * 10_000.0).round() as u32,
            })
            .collect();
        scored.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| a.id.cmp(&b.id))
        });
        scored.truncate(top_k);
        scored
    }
}
