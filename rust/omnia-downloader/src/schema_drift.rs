//! 3-gram Structural Schema Drift & Conformance engine (`GRAM_WIDTH = 3`,
//! multiset Jaccard similarity, JSON shape walker, and linear-time HTML scanner)
//! ported cleanly from `schemaDriftAndConformance.js`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use omnia_core::hex_encode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Default shingle width (`GRAM_WIDTH = 3`).
pub const GRAM_WIDTH: usize = 3;
/// Default minimum similarity required for fuzzy edit pairing.
pub const DEFAULT_DRIFT_THRESHOLD: f64 = 0.65;

/// Extracted structural signature over 3-gram token windows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaSignature {
    pub unit_name: String,
    pub params: usize,
    pub text_hash: String,
    pub skeleton_hash: String,
    pub paths: Vec<String>,
    pub gram_total: usize,
    pub grams: BTreeMap<String, usize>,
}

/// Pairwise alignment verdict between a baseline unit and current unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DriftVerdict {
    Identical,
    Renamed,
    Edited,
}

/// Single aligned unit pair returned by [`compare_schema_snapshots`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchemaDriftPair {
    pub before: String,
    pub after: String,
    pub verdict: DriftVerdict,
    pub similarity: f64,
}

/// Complete schema conformance and drift comparison receipt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchemaDriftReport {
    pub pairs: Vec<SchemaDriftPair>,
    pub gone: Vec<String>,
    pub added: Vec<String>,
    pub renamed_map: BTreeMap<String, String>,
    pub summary: String,
    pub drift_detected: bool,
}

/// Builds a 3-gram multiset (`width = 3`, with shorter sequence boundary padding)
/// keyed by deterministic SHA-256 hex window tags.
#[must_use]
pub fn build_gram_multiset(tokens: &[String], width: usize) -> BTreeMap<String, usize> {
    let mut grams = BTreeMap::new();
    let effective_width = width.max(1);
    if tokens.is_empty() {
        return grams;
    }
    if tokens.len() <= effective_width {
        let key = hash_token_slice(tokens);
        *grams.entry(key).or_insert(0) += 1;
        return grams;
    }
    for window in tokens.windows(effective_width) {
        let key = hash_token_slice(window);
        *grams.entry(key).or_insert(0) += 1;
    }
    grams
}

/// Computes multiset Jaccard similarity in `[0.0, 1.0]` over two 3-gram multisets.
#[must_use]
pub fn compute_multiset_overlap(
    left: &BTreeMap<String, usize>,
    right: &BTreeMap<String, usize>,
) -> f64 {
    if left.is_empty() && right.is_empty() {
        return 1.0;
    }
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let mut sum_left = 0usize;
    let mut sum_right = 0usize;
    let mut intersection = 0usize;

    for (k, &lv) in left {
        sum_left += lv;
        if let Some(&rv) = right.get(k) {
            intersection += lv.min(rv);
        }
    }
    for &rv in right.values() {
        sum_right += rv;
    }
    let union = sum_left + sum_right - intersection;
    if union == 0 {
        1.0
    } else {
        (intersection as f64) / (union as f64)
    }
}

/// Convenience wrapper computing multiset Jaccard similarity between two [`SchemaSignature`]s.
#[must_use]
pub fn signature_similarity(left: &SchemaSignature, right: &SchemaSignature) -> f64 {
    compute_multiset_overlap(&left.grams, &right.grams)
}

fn hash_token_slice(tokens: &[String]) -> String {
    let mut hasher = Sha256::new();
    for tok in tokens {
        hasher.update(tok.as_bytes());
        hasher.update([0u8]);
    }
    hex_encode(&hasher.finalize())
}

fn finalize_signature(
    unit_name: String,
    params: usize,
    tokens: &[String],
    skeleton: &[String],
    paths: Vec<String>,
) -> SchemaSignature {
    let grams = build_gram_multiset(tokens, GRAM_WIDTH);
    let gram_total = grams.values().sum();
    SchemaSignature {
        unit_name,
        params,
        text_hash: hash_token_slice(tokens),
        skeleton_hash: hash_token_slice(skeleton),
        paths,
        gram_total,
        grams,
    }
}

/// Extracts deterministic [`SchemaSignature`] units from a JSON string, HTML fragment,
/// or plain-text snapshot.
#[must_use]
pub fn extract_structural_shapes_from_text(input: &str) -> Vec<SchemaSignature> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
    {
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            return extract_structural_shapes_from_json(&parsed);
        }
    }
    if looks_like_html(trimmed) {
        return extract_html_shapes(trimmed);
    }

    let words: Vec<String> = trimmed.split_whitespace().map(ToString::to_string).collect();
    vec![finalize_signature(
        "document".to_string(),
        0,
        &words,
        &words,
        vec!["$:text".to_string()],
    )]
}

/// Extracts [`SchemaSignature`] units from a parsed JSON [`Value`].
#[must_use]
pub fn extract_structural_shapes_from_json(value: &Value) -> Vec<SchemaSignature> {
    match value {
        Value::Null => Vec::new(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(idx, item)| {
                let unit_name = item
                    .as_object()
                    .and_then(|obj| obj.get("id").or_else(|| obj.get("name")))
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| format!("[{idx}]"));
                let mut tokens = Vec::new();
                let mut skeleton = Vec::new();
                let mut paths = Vec::new();
                walk_json_shape(item, "$", &mut tokens, &mut skeleton, &mut paths, 0);
                let params = match item {
                    Value::Object(map) => map.len(),
                    Value::Array(_) => 1,
                    _ => 0,
                };
                finalize_signature(unit_name, params, &tokens, &skeleton, paths)
            })
            .collect(),
        Value::Object(map) => map
            .iter()
            .map(|(key, val)| {
                let mut tokens = Vec::new();
                let mut skeleton = Vec::new();
                let mut paths = Vec::new();
                walk_json_shape(val, "$", &mut tokens, &mut skeleton, &mut paths, 0);
                let params = match val {
                    Value::Object(inner) => inner.len(),
                    Value::Array(_) => 1,
                    _ => 0,
                };
                finalize_signature(key.clone(), params, &tokens, &skeleton, paths)
            })
            .collect(),
        other => {
            let mut tokens = Vec::new();
            let mut skeleton = Vec::new();
            let mut paths = Vec::new();
            walk_json_shape(other, "$", &mut tokens, &mut skeleton, &mut paths, 0);
            vec![finalize_signature(
                "root".to_string(),
                0,
                &tokens,
                &skeleton,
                paths,
            )]
        }
    }
}

fn walk_json_shape(
    value: &Value,
    path: &str,
    tokens: &mut Vec<String>,
    skeleton: &mut Vec<String>,
    paths: &mut Vec<String>,
    depth: usize,
) {
    if depth > 128 {
        tokens.push("max-depth".to_string());
        skeleton.push("max-depth".to_string());
        paths.push(format!("{path}:max-depth"));
        return;
    }
    match value {
        Value::Null => {
            tokens.push("null".to_string());
            skeleton.push("null".to_string());
            paths.push(format!("{path}:null"));
        }
        Value::Bool(_) => {
            tokens.push("type:boolean".to_string());
            skeleton.push("type:boolean".to_string());
            paths.push(format!("{path}:boolean"));
        }
        Value::Number(_) => {
            tokens.push("type:number".to_string());
            skeleton.push("type:number".to_string());
            paths.push(format!("{path}:number"));
        }
        Value::String(_) => {
            tokens.push("type:string".to_string());
            skeleton.push("type:string".to_string());
            paths.push(format!("{path}:string"));
        }
        Value::Array(items) => {
            tokens.push("array".to_string());
            skeleton.push("array".to_string());
            paths.push(format!("{path}:array"));
            if items.is_empty() {
                tokens.push("empty-array".to_string());
                skeleton.push("empty-array".to_string());
                return;
            }
            let mut seen = HashSet::new();
            for (idx, item) in items.iter().take(8).enumerate() {
                let mut sub_tok = Vec::new();
                let mut sub_skel = Vec::new();
                let mut sub_paths = Vec::new();
                walk_json_shape(
                    item,
                    &format!("{path}[]"),
                    &mut sub_tok,
                    &mut sub_skel,
                    &mut sub_paths,
                    depth + 1,
                );
                let sig = sub_tok.join("\x00");
                if idx == 0 || seen.insert(sig) {
                    tokens.push("elem".to_string());
                    tokens.extend(sub_tok);
                    skeleton.push("elem".to_string());
                    skeleton.extend(sub_skel);
                    paths.extend(sub_paths);
                }
            }
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            tokens.push("object".to_string());
            tokens.push(format!("props:{}", keys.len()));
            skeleton.push("object".to_string());
            paths.push(format!("{path}:object({})", keys.len()));
            for k in keys {
                tokens.push(format!("prop:{k}"));
                skeleton.push(format!("prop:{k}"));
                walk_json_shape(
                    &map[k],
                    &format!("{path}.{k}"),
                    tokens,
                    skeleton,
                    paths,
                    depth + 1,
                );
            }
        }
    }
}

fn looks_like_html(trimmed: &str) -> bool {
    let bytes = trimmed.as_bytes();
    let mut i = 0;
    while i + 2 < bytes.len() {
        if bytes[i] == b'<' && bytes[i + 1].is_ascii_alphabetic() {
            let mut j = i + 2;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-') {
                j += 1;
            }
            if j < bytes.len() && (bytes[j].is_ascii_whitespace() || matches!(bytes[j], b'/' | b'>'))
            {
                return true;
            }
        }
        i += 1;
    }
    false
}

#[derive(Debug, Clone)]
struct HtmlNode {
    tag: String,
    attrs: BTreeMap<String, String>,
    children: Vec<HtmlNode>,
}

fn is_void_tag(tag: &str) -> bool {
    matches!(
        tag,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

fn is_structural_attr(attr: &str) -> bool {
    matches!(
        attr,
        "type"
            | "name"
            | "method"
            | "role"
            | "rel"
            | "enctype"
            | "target"
            | "multiple"
            | "required"
            | "readonly"
            | "disabled"
    )
}

fn scan_html_tags(input: &str) -> Vec<(String, String, bool, bool)> {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut out = Vec::new();
    let mut i = 0usize;

    while i < len {
        let Some(rel_lt) = input[i..].find('<') else {
            break;
        };
        let lt = i + rel_lt;
        let mut cursor = lt + 1;
        let mut is_closing = false;
        if cursor < len && bytes[cursor] == b'/' {
            is_closing = true;
            cursor += 1;
        }
        if cursor >= len || !bytes[cursor].is_ascii_alphabetic() {
            i = lt + 1;
            continue;
        }
        let name_start = cursor;
        while cursor < len && (bytes[cursor].is_ascii_alphanumeric() || bytes[cursor] == b'-') {
            cursor += 1;
        }
        let tag = input[name_start..cursor].to_ascii_lowercase();
        let attr_start = cursor;
        let mut quote: u8 = 0;
        let mut found_gt = None;

        while cursor < len {
            let b = bytes[cursor];
            if quote != 0 {
                if b == quote {
                    quote = 0;
                }
                cursor += 1;
                continue;
            }
            if (b == b'"' || b == b'\'') && input[cursor + 1..].contains(b as char) {
                quote = b;
                cursor += 1;
                continue;
            }
            if b == b'>' {
                found_gt = Some(cursor);
                break;
            }
            cursor += 1;
        }

        let Some(gt) = found_gt else {
            break;
        };
        let raw_attr = input[attr_start..gt].trim_end();
        let mut self_closing = is_void_tag(&tag);
        let attr_slice = if !is_closing && raw_attr.ends_with('/') {
            self_closing = true;
            &raw_attr[..raw_attr.len() - 1]
        } else {
            raw_attr
        };
        out.push((tag, attr_slice.to_string(), is_closing, self_closing));
        i = gt + 1;
    }
    out
}

fn parse_html_attrs(attr_text: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let bytes = attr_text.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    while i < len {
        while i < len && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= len {
            break;
        }
        let key_start = i;
        while i < len
            && !bytes[i].is_ascii_whitespace()
            && bytes[i] != b'='
            && bytes[i] != b'>'
        {
            i += 1;
        }
        let key = attr_text[key_start..i].trim().to_ascii_lowercase();
        if key.is_empty() {
            i += 1;
            continue;
        }
        while i < len && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut val = String::new();
        if i < len && bytes[i] == b'=' {
            i += 1;
            while i < len && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < len && (bytes[i] == b'"' || bytes[i] == b'\'') {
                let q = bytes[i];
                i += 1;
                let vs = i;
                while i < len && bytes[i] != q {
                    i += 1;
                }
                val = attr_text[vs..i].to_string();
                if i < len {
                    i += 1;
                }
            } else {
                let vs = i;
                while i < len && !bytes[i].is_ascii_whitespace() {
                    i += 1;
                }
                val = attr_text[vs..i].to_string();
            }
        }
        map.insert(key, val);
    }
    map
}

fn extract_html_shapes(html: &str) -> Vec<SchemaSignature> {
    let mut root = HtmlNode {
        tag: "#root".to_string(),
        attrs: BTreeMap::new(),
        children: Vec::new(),
    };
    let mut stack = vec![root];
    for (tag, attr_text, is_closing, self_closing) in scan_html_tags(html) {
        if is_closing {
            if let Some(pos) = stack.iter().rposition(|n| n.tag == tag) {
                if pos >= 1 {
                    while stack.len() > pos {
                        let finished = stack.pop().unwrap();
                        if let Some(parent) = stack.last_mut() {
                            parent.children.push(finished);
                        }
                    }
                }
            }
            continue;
        }
        let node = HtmlNode {
            tag,
            attrs: parse_html_attrs(&attr_text),
            children: Vec::new(),
        };
        if self_closing {
            if let Some(parent) = stack.last_mut() {
                parent.children.push(node);
            }
        } else {
            stack.push(node);
        }
    }
    while stack.len() > 1 {
        let finished = stack.pop().unwrap();
        if let Some(parent) = stack.last_mut() {
            parent.children.push(finished);
        }
    }
    root = stack.pop().unwrap();

    let mut named: Vec<(String, &HtmlNode)> = Vec::new();
    fn collect<'a>(node: &'a HtmlNode, out: &mut Vec<(String, &'a HtmlNode)>) {
        if let Some(id) = node
            .attrs
            .get("id")
            .or_else(|| node.attrs.get("data-testid"))
            .or_else(|| node.attrs.get("data-component"))
        {
            if !id.is_empty() {
                out.push((format!("{}#{id}", node.tag), node));
                return;
            }
        }
        if node.tag == "form" {
            if let Some(name) = node.attrs.get("name") {
                if !name.is_empty() {
                    out.push((format!("form[name={name}]"), node));
                    return;
                }
            }
        }
        for child in &node.children {
            collect(child, out);
        }
    }
    collect(&root, &mut named);

    let units: Vec<(String, &HtmlNode)> = if !named.is_empty() {
        named
    } else {
        root.children
            .iter()
            .enumerate()
            .map(|(i, c)| (format!("{}[{i}]", c.tag), c))
            .collect()
    };

    units
        .into_iter()
        .map(|(name, node)| {
            let mut tokens = Vec::new();
            let mut skeleton = Vec::new();
            let mut paths = Vec::new();
            walk_html(node, "", &mut tokens, &mut skeleton, &mut paths, true);
            finalize_signature(name, node.children.len(), &tokens, &skeleton, paths)
        })
        .collect()
}

fn walk_html(
    node: &HtmlNode,
    current_path: &str,
    tokens: &mut Vec<String>,
    skeleton: &mut Vec<String>,
    paths: &mut Vec<String>,
    is_root: bool,
) {
    tokens.push(format!("tag:{}", node.tag));
    skeleton.push(format!("tag:{}", node.tag));
    let next_path = if is_root {
        node.tag.clone()
    } else {
        format!("{current_path}>{}", node.tag)
    };
    paths.push(next_path.clone());

    for (attr, val) in &node.attrs {
        if is_root && matches!(attr.as_str(), "id" | "data-testid" | "data-component") {
            continue;
        }
        if is_structural_attr(attr) {
            let v = val.trim().to_ascii_lowercase();
            tokens.push(format!("attr:{attr}={v}"));
            skeleton.push(format!("attr:{attr}={v}"));
        } else if attr.starts_with("data-") || matches!(attr.as_str(), "action" | "href" | "src") {
            tokens.push(format!("attr:{attr}"));
            skeleton.push(format!("attr:{attr}"));
        }
    }

    for child in &node.children {
        walk_html(child, &next_path, tokens, skeleton, paths, false);
    }

    tokens.push(format!("/tag:{}", node.tag));
    skeleton.push(format!("/tag:{}", node.tag));
}

/// Compares baseline vs current snapshots (`text` JSON/HTML/text) using exact matches first
/// and greedy 3-gram multiset Jaccard similarity (`>= threshold`) second.
#[must_use]
pub fn compare_schema_snapshots(
    before_text: &str,
    after_text: &str,
    threshold: Option<f64>,
) -> SchemaDriftReport {
    let effective_threshold = threshold
        .filter(|v| v.is_finite())
        .unwrap_or(DEFAULT_DRIFT_THRESHOLD)
        .clamp(0.0, 1.0);
    let before = extract_structural_shapes_from_text(before_text);
    let after = extract_structural_shapes_from_text(after_text);

    let mut pairs = Vec::new();
    let mut taken_before = HashSet::new();
    let mut taken_after = HashSet::new();

    // Pass 1a: Exact unit name + text_hash + params.
    for (li, left) in before.iter().enumerate() {
        if let Some(ri) = after.iter().enumerate().position(|(idx, right)| {
            !taken_after.contains(&idx)
                && right.unit_name == left.unit_name
                && right.text_hash == left.text_hash
                && right.params == left.params
        }) {
            taken_before.insert(li);
            taken_after.insert(ri);
            pairs.push(SchemaDriftPair {
                before: left.unit_name.clone(),
                after: after[ri].unit_name.clone(),
                verdict: DriftVerdict::Identical,
                similarity: 1.0,
            });
        }
    }

    // Pass 1b: Pure renames (identical structural hash & param count under new unit name).
    for (li, left) in before.iter().enumerate() {
        if taken_before.contains(&li) {
            continue;
        }
        if let Some(ri) = after.iter().enumerate().position(|(idx, right)| {
            !taken_after.contains(&idx)
                && right.text_hash == left.text_hash
                && right.params == left.params
        }) {
            taken_before.insert(li);
            taken_after.insert(ri);
            let right = &after[ri];
            pairs.push(SchemaDriftPair {
                before: left.unit_name.clone(),
                after: right.unit_name.clone(),
                verdict: if left.unit_name == right.unit_name {
                    DriftVerdict::Identical
                } else {
                    DriftVerdict::Renamed
                },
                similarity: 1.0,
            });
        }
    }

    // Pass 2: Greedy 3-gram multiset Jaccard matching >= threshold.
    let mut scored: Vec<(f64, u8, usize, usize)> = Vec::new();
    for (li, left) in before.iter().enumerate() {
        if taken_before.contains(&li) {
            continue;
        }
        for (ri, right) in after.iter().enumerate() {
            if taken_after.contains(&ri) {
                continue;
            }
            let sim = signature_similarity(left, right);
            if sim >= effective_threshold {
                let same_name = u8::from(left.unit_name == right.unit_name);
                scored.push((sim, same_name, li, ri));
            }
        }
    }
    scored.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| a.2.cmp(&b.2))
            .then_with(|| a.3.cmp(&b.3))
    });

    for (sim, _, li, ri) in scored {
        if taken_before.contains(&li) || taken_after.contains(&ri) {
            continue;
        }
        taken_before.insert(li);
        taken_after.insert(ri);
        pairs.push(SchemaDriftPair {
            before: before[li].unit_name.clone(),
            after: after[ri].unit_name.clone(),
            verdict: DriftVerdict::Edited,
            similarity: sim,
        });
    }

    let gone: Vec<String> = before
        .iter()
        .enumerate()
        .filter(|(idx, _)| !taken_before.contains(idx))
        .map(|(_, s)| s.unit_name.clone())
        .collect();
    let added: Vec<String> = after
        .iter()
        .enumerate()
        .filter(|(idx, _)| !taken_after.contains(idx))
        .map(|(_, s)| s.unit_name.clone())
        .collect();

    pairs.sort_by(|a, b| a.before.cmp(&b.before));

    let mut renamed_map = BTreeMap::new();
    let mut identical_count = 0usize;
    let mut renamed_count = 0usize;
    let mut edited_count = 0usize;
    for p in &pairs {
        match p.verdict {
            DriftVerdict::Identical => identical_count += 1,
            DriftVerdict::Renamed => renamed_count += 1,
            DriftVerdict::Edited => edited_count += 1,
        }
        if p.before != p.after {
            renamed_map.insert(p.before.clone(), p.after.clone());
        }
    }

    let summary = format!(
        "{identical_count} unchanged, {renamed_count} renamed, {edited_count} edited, {} gone, {} new",
        gone.len(),
        added.len()
    );
    let drift_detected =
        renamed_count > 0 || edited_count > 0 || !gone.is_empty() || !added.is_empty();

    SchemaDriftReport {
        pairs,
        gone,
        added,
        renamed_map,
        summary,
        drift_detected,
    }
}

/// Validates schema conformance invariants (sorted set comparison helper).
#[must_use]
pub fn diff_required_keys<'a>(expected: &[&'a str], observed: &BTreeSet<String>) -> Vec<&'a str> {
    expected
        .iter()
        .copied()
        .filter(|key| !observed.contains(*key))
        .collect()
}

/// Legacy unused-import guard helper keeping deterministic HashMap hashing available if needed.
#[allow(dead_code)]
fn _unused_map_guard() -> HashMap<String, usize> {
    HashMap::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_and_json_3gram_schema_drift_detects_rename_edit_and_identical() {
        let before_html = r#"
            <div id="course-header" class="title"><h1 data-role="heading">Week 1</h1></div>
            <ul id="resources"><li data-kind="pdf"><a href="/a.pdf">Slides</a></li></ul>
        "#;
        let after_html = r#"
            <div id="module-header" class="title"><h1 data-role="heading">Week 1</h1></div>
            <ul id="resources"><li data-kind="pdf"><a href="/a.pdf">Slides</a></li><li><span>Extra</span></li></ul>
        "#;
        let report = compare_schema_snapshots(before_html, after_html, Some(0.45));
        assert!(report.drift_detected);
        assert_eq!(
            report.renamed_map.get("div#course-header").map(String::as_str),
            Some("div#module-header")
        );
        assert!(report
            .pairs
            .iter()
            .any(|p| p.before == "ul#resources" && p.verdict == DriftVerdict::Edited && p.similarity > 0.45));
    }

    #[test]
    fn identical_json_reports_zero_drift() {
        let before = r#"{"items":{"a":1,"b":"ok"},"status":{"code":200}}"#;
        let after = r#"{"items":{"b":"changed","a":99},"status":{"code":200}}"#;
        let report = compare_schema_snapshots(before, after, None);
        assert!(!report.drift_detected);
        assert_eq!(report.pairs.len(), 2);
        assert!(report.pairs.iter().all(|p| p.verdict == DriftVerdict::Identical));
    }
}
