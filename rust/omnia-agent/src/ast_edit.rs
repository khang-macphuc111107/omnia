//! 8+ Language Tree-sitter Structural Search (`ast_grep`) & Rewrite (`ast_edit`).
//!
//! Supports Rust, Python, JavaScript, TypeScript, TSX, Go, C, C++, and JSON
//! with metavariable pattern matching (`$IDENT`, `$$$REST`), symbol-block targeting,
//! non-overlapping span rewrites, and zero-new-syntax-error atomic verification.

use anyhow::{bail, Context, Result};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use tree_sitter::{Language, Node, Parser};

/// Supported Tree-sitter languages (9 compiled grammars / 8+ languages).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AstLang {
    Rust,
    Python,
    JavaScript,
    TypeScript,
    Tsx,
    Go,
    #[cfg(feature = "cpp-c-ast")]
    C,
    #[cfg(feature = "cpp-c-ast")]
    Cpp,
    Json,
}

impl AstLang {
    #[must_use]
    pub fn from_name(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "rs" | "rust" => Some(Self::Rust),
            "py" | "python" => Some(Self::Python),
            "js" | "jsx" | "javascript" | "mjs" | "cjs" => Some(Self::JavaScript),
            "ts" | "typescript" | "mts" | "cts" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            "go" | "golang" => Some(Self::Go),
            #[cfg(feature = "cpp-c-ast")]
            "c" => Some(Self::C),
            #[cfg(feature = "cpp-c-ast")]
            "cpp" | "c++" | "cc" | "cxx" | "hpp" | "hxx" | "hh" => Some(Self::Cpp),
            "json" => Some(Self::Json),
            _ => None,
        }
    }

    #[must_use]
    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?;
        Self::from_name(ext)
    }

    #[must_use]
    pub fn ts_language(self) -> Language {
        match self {
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::Go => tree_sitter_go::LANGUAGE.into(),
            #[cfg(feature = "cpp-c-ast")]
            Self::C => tree_sitter_c::LANGUAGE.into(),
            #[cfg(feature = "cpp-c-ast")]
            Self::Cpp => tree_sitter_cpp::LANGUAGE.into(),
            Self::Json => tree_sitter_json::LANGUAGE.into(),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::Python => "python",
            Self::JavaScript => "javascript",
            Self::TypeScript => "typescript",
            Self::Tsx => "tsx",
            Self::Go => "go",
            #[cfg(feature = "cpp-c-ast")]
            Self::C => "c",
            #[cfg(feature = "cpp-c-ast")]
            Self::Cpp => "cpp",
            Self::Json => "json",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AstMatch {
    pub file: String,
    pub language: String,
    pub start_line: usize,
    pub end_line: usize,
    pub start_byte: usize,
    pub end_byte: usize,
    pub matched_text: String,
    pub captures: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AstRewriteOp {
    pub pat: String,
    pub out: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AstEditFileReceipt {
    pub file: String,
    pub language: String,
    pub replacements: usize,
    pub syntax_errors_before: usize,
    pub syntax_errors_after: usize,
    pub diff: String,
}

/// Counts Tree-sitter `ERROR` / `MISSING` nodes in `source` for `lang`.
pub fn count_syntax_errors(lang: AstLang, source: &str) -> Result<usize> {
    let mut parser = Parser::new();
    parser
        .set_language(&lang.ts_language())
        .context("set Tree-sitter language")?;
    let tree = parser
        .parse(source, None)
        .context("Tree-sitter parse failed")?;
    Ok(count_error_nodes(tree.root_node()))
}

fn count_error_nodes(node: Node<'_>) -> usize {
    let mut errs = usize::from(node.is_error() || node.is_missing());
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        errs += count_error_nodes(child);
    }
    errs
}

/// Extracts named pattern AST root and replaces `$VAR` placeholders cleanly for Tree-sitter parsing.
fn parse_pattern_node(lang: AstLang, pattern: &str) -> Result<(String, HashMap<String, String>, tree_sitter::Tree)> {
    let (sanitized, placeholder_map) = encode_metavars(pattern);
    let mut parser = Parser::new();
    parser
        .set_language(&lang.ts_language())
        .context("set pattern language")?;

    // Try parsing pattern as top-level, then wrapped in block/expression context if needed.
    let candidates = match lang {
        AstLang::Rust => vec![
            sanitized.clone(),
            format!("fn __omnia_pat__() {{ {sanitized}; }}"),
            format!("fn __omnia_pat__() {{ {sanitized} }}"),
        ],
        AstLang::Python => vec![sanitized.clone(), format!("def __omnia_pat__():\n    {sanitized}")],
        AstLang::JavaScript | AstLang::TypeScript | AstLang::Tsx => vec![
            sanitized.clone(),
            format!("function __omnia_pat__() {{ {sanitized}; }}"),
        ],
        AstLang::Go => vec![
            sanitized.clone(),
            format!("package p\nfunc __omnia_pat__() {{ {sanitized} }}"),
        ],
        #[cfg(feature = "cpp-c-ast")]
        AstLang::C | AstLang::Cpp => vec![
            sanitized.clone(),
            format!("void __omnia_pat__() {{ {sanitized}; }}"),
        ],
        AstLang::Json => vec![sanitized.clone()],
    };

    for cand in candidates {
        if let Some(tree) = parser.parse(&cand, None) {
            if count_error_nodes(tree.root_node()) == 0 {
                return Ok((cand, placeholder_map, tree));
            }
        }
    }

    let tree = parser
        .parse(&sanitized, None)
        .context("parse pattern fallback")?;
    Ok((sanitized, placeholder_map, tree))
}

fn encode_metavars(pattern: &str) -> (String, HashMap<String, String>) {
    let mut out = String::with_capacity(pattern.len());
    let mut map = HashMap::new();
    let bytes = pattern.as_bytes();
    let mut i = 0usize;
    let mut seq = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'$' {
            let is_multi = pattern[i..].starts_with("$$$");
            let name_start = if is_multi { i + 3 } else { i + 1 };
            let mut name_end = name_start;
            while name_end < bytes.len()
                && (bytes[name_end].is_ascii_uppercase()
                    || bytes[name_end].is_ascii_digit()
                    || bytes[name_end] == b'_')
            {
                name_end += 1;
            }
            if name_end > name_start {
                let raw_var = &pattern[i..name_end];
                let existing = map
                    .iter()
                    .find_map(|(ph, orig): (&String, &String)| (orig == raw_var).then(|| ph.clone()));
                let ph = existing.unwrap_or_else(|| {
                    seq += 1;
                    let p = format!("__OMNIA_MV_{seq}__");
                    map.insert(p.clone(), raw_var.to_owned());
                    p
                });
                out.push_str(&ph);
                i = name_end;
                continue;
            }
        }
        if let Some(ch) = pattern[i..].chars().next() {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }
    (out, map)
}

fn find_inner_pattern_target<'a>(root: Node<'a>, pat_src: &str, raw_sanitized: &str) -> Option<Node<'a>> {
    let want = raw_sanitized.trim();
    if pat_src.trim() == want {
        // Direct top-level parse: if tree-sitter wraps the single target in a `source_file`/`program`/`module`,
        // return its named root node (or first non-trivia child matching `want`).
        let mut cursor = root.walk();
        for ch in root.children(&mut cursor) {
            if !ch.is_extra() && ch.utf8_text(pat_src.as_bytes()).unwrap_or("").trim() == want {
                if ch.kind() == "expression_statement" && !want.ends_with(';') {
                    if let Some(inner) = ch.named_child(0) {
                        return Some(inner);
                    }
                }
                return Some(ch);
            }
        }
        return root.named_child(0).or_else(|| root.child(0));
    }

    // Wrapped inside `__omnia_pat__`: descend strictly into the wrapper body and pick the
    // node whose exact text matches `raw_sanitized.trim()` (ignoring outer keywords like `fn` or `()`).
    let mut best: Option<Node<'a>> = None;
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        let text = node.utf8_text(pat_src.as_bytes()).unwrap_or("").trim();
        if text == want {
            // Prefer inner expression node over `expression_statement` wrapper unless pattern ended with `;`.
            if node.kind() == "expression_statement" && !want.ends_with(';') {
                if let Some(inner) = node.named_child(0) {
                    best = Some(inner);
                    continue;
                }
            }
            best = Some(node);
            continue;
        }
        let count = node.child_count();
        for idx in (0..count).rev() {
            if let Some(ch) = node.child(idx) {
                if ch.utf8_text(pat_src.as_bytes()).unwrap_or("").contains(want) {
                    stack.push(ch);
                }
            }
        }
    }
    best.or_else(|| root.named_child(0))
}

/// Runs structural `ast_grep` search across `target_path` (file or directory inside `workspace_root`).
pub fn ast_grep_path(
    workspace_root: &Path,
    target_path: Option<&Path>,
    lang_hint: Option<&str>,
    pattern: &str,
    max_matches: usize,
) -> Result<Vec<AstMatch>> {
    let explicit_lang = lang_hint.and_then(AstLang::from_name);
    let root = target_path.unwrap_or(workspace_root);
    let files: Vec<PathBuf> = if root.is_file() {
        vec![root.to_path_buf()]
    } else {
        WalkBuilder::new(root)
            .hidden(true)
            .git_ignore(true)
            .build()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_some_and(|ft| ft.is_file()))
            .map(|e| e.into_path())
            .take(2_500)
            .collect()
    };

    let mut matches = Vec::new();
    for file in files {
        let Some(lang) = explicit_lang.or_else(|| AstLang::from_path(&file)) else {
            continue;
        };
        let Ok(src) = std::fs::read_to_string(&file) else {
            continue;
        };
        let file_matches = ast_grep_source(lang, &src, &file.to_string_lossy(), pattern)?;
        for m in file_matches {
            matches.push(m);
            if matches.len() >= max_matches.max(1) {
                return Ok(matches);
            }
        }
    }
    Ok(matches)
}

/// Searches one in-memory source string with an AST pattern supporting `$VAR` / `$$$ARGS`.
pub fn ast_grep_source(
    lang: AstLang,
    source: &str,
    file_label: &str,
    pattern: &str,
) -> Result<Vec<AstMatch>> {
    let (sanitized, _) = encode_metavars(pattern);
    let (pat_src, ph_map, pat_tree) = parse_pattern_node(lang, pattern)?;
    let Some(pat_root) = find_inner_pattern_target(pat_tree.root_node(), &pat_src, &sanitized) else {
        bail!("unable to compile AST pattern `{pattern}` for {}", lang.as_str());
    };

    let mut parser = Parser::new();
    parser.set_language(&lang.ts_language())?;
    let tree = parser.parse(source, None).context("parse target source")?;

    let mut out = Vec::new();
    collect_ast_matches(
        tree.root_node(),
        source,
        pat_root,
        &pat_src,
        &ph_map,
        lang,
        file_label,
        &mut out,
    );
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn collect_ast_matches(
    node: Node<'_>,
    source: &str,
    pat_node: Node<'_>,
    pat_src: &str,
    ph_map: &HashMap<String, String>,
    lang: AstLang,
    file_label: &str,
    out: &mut Vec<AstMatch>,
) {
    let mut captures = BTreeMap::new();
    if match_subtree(node, source, pat_node, pat_src, ph_map, &mut captures) {
        out.push(AstMatch {
            file: file_label.to_owned(),
            language: lang.as_str().to_owned(),
            start_line: node.start_position().row + 1,
            end_line: node.end_position().row + 1,
            start_byte: node.start_byte(),
            end_byte: node.end_byte(),
            matched_text: node.utf8_text(source.as_bytes()).unwrap_or("").to_owned(),
            captures,
        });
        return;
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_ast_matches(child, source, pat_node, pat_src, ph_map, lang, file_label, out);
    }
}

fn match_subtree(
    cand: Node<'_>,
    src: &str,
    pat: Node<'_>,
    pat_src: &str,
    ph_map: &HashMap<String, String>,
    captures: &mut BTreeMap<String, String>,
) -> bool {
    let pat_text = pat.utf8_text(pat_src.as_bytes()).unwrap_or("");
    if let Some(orig_var) = ph_map.get(pat_text) {
        let cand_text = cand.utf8_text(src.as_bytes()).unwrap_or("").to_owned();
        if let Some(existing) = captures.get(orig_var) {
            return existing == &cand_text;
        }
        captures.insert(orig_var.clone(), cand_text);
        return true;
    }

    if cand.kind() != pat.kind() {
        return false;
    }

    if pat.child_count() == 0 && cand.child_count() == 0 {
        let ctxt = cand.utf8_text(src.as_bytes()).unwrap_or("");
        return ctxt == pat_text;
    }

    let p_children: Vec<Node<'_>> = (0..pat.child_count())
        .filter_map(|i| pat.child(i))
        .filter(|n| !n.is_extra())
        .collect();
    let c_children: Vec<Node<'_>> = (0..cand.child_count())
        .filter_map(|i| cand.child(i))
        .filter(|n| !n.is_extra())
        .collect();

    // Check whether p_children contains a `$$$...` multi-node capture.
    if let Some(multi_pos) = p_children.iter().position(|n| {
        let t = n.utf8_text(pat_src.as_bytes()).unwrap_or("");
        ph_map.get(t).is_some_and(|v| v.starts_with("$$$"))
    }) {
        let prefix_len = multi_pos;
        let suffix_len = p_children.len() - multi_pos - 1;
        if c_children.len() < prefix_len + suffix_len {
            return false;
        }
        for i in 0..prefix_len {
            if !match_subtree(c_children[i], src, p_children[i], pat_src, ph_map, captures) {
                return false;
            }
        }
        let c_mid_end = c_children.len() - suffix_len;
        for j in 0..suffix_len {
            if !match_subtree(
                c_children[c_mid_end + j],
                src,
                p_children[multi_pos + 1 + j],
                pat_src,
                ph_map,
                captures,
            ) {
                return false;
            }
        }
        let multi_ph = p_children[multi_pos]
            .utf8_text(pat_src.as_bytes())
            .unwrap_or("");
        if let Some(orig_var) = ph_map.get(multi_ph) {
            let captured = if prefix_len < c_mid_end {
                let start_b = c_children[prefix_len].start_byte();
                let end_b = c_children[c_mid_end - 1].end_byte();
                src[start_b..end_b].to_owned()
            } else {
                String::new()
            };
            captures.insert(orig_var.clone(), captured);
        }
        return true;
    }

    if p_children.len() != c_children.len() {
        return false;
    }
    for (c_ch, p_ch) in c_children.into_iter().zip(p_children) {
        if !match_subtree(c_ch, src, p_ch, pat_src, ph_map, captures) {
            return false;
        }
    }
    true
}

/// Applies AST pattern rewrites to an in-memory string and returns `(new_content, diff, count, before_errs, after_errs)`.
pub fn ast_edit_source(
    lang: AstLang,
    source: &str,
    file_label: &str,
    ops: &[AstRewriteOp],
) -> Result<(String, AstEditFileReceipt)> {
    let errors_before = count_syntax_errors(lang, source)?;
    let mut current = source.to_owned();
    let mut total_replacements = 0usize;

    for op in ops {
        let hits = ast_grep_source(lang, &current, file_label, &op.pat)?;
        if hits.is_empty() {
            continue;
        }
        // Apply non-overlapping spans right-to-left to preserve byte offsets.
        let mut sorted = hits;
        sorted.sort_by_key(|m| std::cmp::Reverse(m.start_byte));
        let mut last_start = usize::MAX;
        for m in sorted {
            if m.end_byte > last_start {
                continue;
            }
            let rendered = render_ast_replacement(&op.out, &m.captures);
            current.replace_range(m.start_byte..m.end_byte, &rendered);
            last_start = m.start_byte;
            total_replacements += 1;
        }
    }

    let errors_after = count_syntax_errors(lang, &current)?;
    if errors_after > errors_before {
        bail!(
            "ast_edit rejected rewrite in `{file_label}`: introduced syntax errors ({errors_before} -> {errors_after})"
        );
    }

    let diff = imara_unified_diff(file_label, source, &current);
    let receipt = AstEditFileReceipt {
        file: file_label.to_owned(),
        language: lang.as_str().to_owned(),
        replacements: total_replacements,
        syntax_errors_before: errors_before,
        syntax_errors_after: errors_after,
        diff,
    };
    Ok((current, receipt))
}

fn render_ast_replacement(template: &str, captures: &BTreeMap<String, String>) -> String {
    let mut out = template.to_owned();
    // Replace longest capture keys first so `$ARGS` doesn't corrupt `$A`
    let mut keys: Vec<(&String, &String)> = captures.iter().collect();
    keys.sort_by_key(|k| std::cmp::Reverse(k.0.len()));
    for (k, v) in keys {
        out = out.replace(k, v);
    }
    out
}

fn imara_unified_diff(label: &str, before: &str, after: &str) -> String {
    if before == after {
        return String::new();
    }
    let input = imara_diff::InternedInput::new(before, after);
    let diff = imara_diff::Diff::compute(imara_diff::Algorithm::Histogram, &input);
    format!("--- a/{label}\n+++ b/{label}\n{}", diff.unified_diff(&imara_diff::BasicLineDiffPrinter(&input.interner), imara_diff::UnifiedDiffConfig::default(), &input))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ast_edit_supports_8_plus_languages_and_structural_rewrites() {
        // 1. Rust
        let rs = "fn main() {\n    let a = legacy_call(x, 1 + 2);\n    // legacy_call(commented, out)\n}\n";
        let (rs_new, rs_rec) = ast_edit_source(
            AstLang::Rust,
            rs,
            "main.rs",
            &[AstRewriteOp {
                pat: "legacy_call($A, $B)".into(),
                out: "modern_call($B, $A)".into(),
            }],
        )
        .expect("rust ast_edit");
        assert_eq!(rs_rec.replacements, 1);
        assert!(rs_new.contains("modern_call(1 + 2, x)"));
        assert!(rs_new.contains("// legacy_call(commented, out)"));

        // 2..9 Verify all 9 compiled grammars parse cleanly with 0 syntax errors
        let samples = [
            (AstLang::Python, "def f(x):\n    return x + 1\n"),
            (AstLang::JavaScript, "export function f(x) { return x + 1; }\n"),
            (AstLang::TypeScript, "export function f(x: number): number { return x + 1; }\n"),
            (AstLang::Tsx, "export const C = () => <div>ok</div>;\n"),
            (AstLang::Go, "package main\nfunc f(x int) int { return x + 1 }\n"),
            #[cfg(feature = "cpp-c-ast")]
            (AstLang::C, "int f(int x) { return x + 1; }\n"),
            #[cfg(feature = "cpp-c-ast")]
            (AstLang::Cpp, "int f(int x) { return x + 1; }\n"),
            (AstLang::Json, "{\"ok\": true, \"count\": 8}\n"),
        ];
        for (lang, src) in samples {
            assert_eq!(
                count_syntax_errors(lang, src).expect("parse"),
                0,
                "expected 0 syntax errors for {}",
                lang.as_str()
            );
        }
    }
}
