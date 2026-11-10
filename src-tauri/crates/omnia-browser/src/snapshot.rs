//! Page snapshots: the in-page DOM walker's tree and its compact text form.
//!
//! The walker lives in `snapshot.js`; it returns JSON which is deserialized
//! into [`SnapNode`] and rendered by [`format_snapshot`]:
//!
//! ```text
//! - heading "Sign in" [level=1]
//! - textbox "Email" [ref=e13]: me@example.com
//! - link "Docs" [ref=e5] -> /docs
//! ```

use serde::{Deserialize, Serialize};

/// JS expression evaluating to the page-side registry (`window.__omnia`).
pub const SNAPSHOT_JS: &str = include_str!("snapshot.js");

pub const DEFAULT_MAX_CHARS: usize = 40_000;

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct SnapOption {
    pub label: String,
    pub value: Option<String>,
    pub selected: bool,
    pub disabled: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct SnapNode {
    pub role: String,
    pub name: Option<String>,
    pub text: Option<String>,
    #[serde(rename = "ref")]
    pub ref_id: Option<String>,
    pub value: Option<String>,
    pub href: Option<String>,
    pub src: Option<String>,
    pub level: Option<u8>,
    #[serde(rename = "type")]
    pub input_type: Option<String>,
    /// `"true"` or `"mixed"`.
    pub checked: Option<String>,
    pub disabled: bool,
    pub required: bool,
    pub expanded: Option<bool>,
    pub selected: bool,
    pub pressed: bool,
    pub focused: bool,
    #[serde(rename = "crossOrigin")]
    pub cross_origin: bool,
    pub options: Vec<SnapOption>,
    pub children: Vec<SnapNode>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ViewportInfo {
    pub width: f64,
    pub height: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub scroll_width: f64,
    pub scroll_height: f64,
}

/// Raw output of the in-page walker.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SnapshotData {
    pub url: String,
    pub title: String,
    pub nodes: Vec<SnapNode>,
    pub truncated: bool,
    pub viewport: ViewportInfo,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct SnapshotOptions {
    pub interactive_only: bool,
    pub visible_only: bool,
    pub selector: Option<String>,
    pub max_nodes: Option<usize>,
    pub max_chars: usize,
}

impl Default for SnapshotOptions {
    fn default() -> Self {
        Self {
            interactive_only: false,
            visible_only: false,
            selector: None,
            max_nodes: None,
            max_chars: DEFAULT_MAX_CHARS,
        }
    }
}

/// A rendered snapshot.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Snapshot {
    pub url: String,
    pub title: String,
    pub text: String,
    /// Number of nodes carrying a ref.
    pub ref_count: usize,
    /// Output was cut by `max_chars` or the walker's node budget.
    pub truncated: bool,
    pub viewport: ViewportInfo,
}

fn quote(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

fn render_line(node: &SnapNode, depth: usize, inline_text: Option<&str>) -> String {
    let indent = "  ".repeat(depth);
    if node.role == "text" {
        return format!("{indent}- text: {}", node.text.as_deref().unwrap_or(""));
    }
    let mut line = format!("{indent}- {}", node.role);
    if let Some(name) = node.name.as_deref().filter(|n| !n.is_empty()) {
        line.push(' ');
        line.push_str(&quote(name));
    }
    if let Some(r) = &node.ref_id {
        line.push_str(&format!(" [ref={r}]"));
    }
    if let Some(level) = node.level {
        line.push_str(&format!(" [level={level}]"));
    }
    if let Some(t) = node.input_type.as_deref().filter(|t| !t.is_empty()) {
        line.push_str(&format!(" [type={t}]"));
    }
    match node.checked.as_deref() {
        Some("mixed") => line.push_str(" [checked=mixed]"),
        Some(_) => line.push_str(" [checked]"),
        None => {}
    }
    if node.selected {
        line.push_str(" [selected]");
    }
    if node.pressed {
        line.push_str(" [pressed]");
    }
    match node.expanded {
        Some(true) => line.push_str(" [expanded]"),
        Some(false) => line.push_str(" [collapsed]"),
        None => {}
    }
    if node.disabled {
        line.push_str(" [disabled]");
    }
    if node.required {
        line.push_str(" [required]");
    }
    if node.focused {
        line.push_str(" [focused]");
    }
    if node.cross_origin {
        line.push_str(" [cross-origin]");
    }
    if let Some(src) = node.src.as_deref().filter(|s| !s.is_empty()) {
        line.push_str(&format!(" [src={src}]"));
    }
    if let Some(href) = node.href.as_deref().filter(|h| !h.is_empty()) {
        line.push_str(&format!(" -> {href}"));
    }
    if let Some(value) = node.value.as_deref().filter(|v| !v.is_empty()) {
        line.push_str(&format!(": {value}"));
    } else if let Some(text) = inline_text.or(node.text.as_deref()) {
        line.push_str(&format!(": {text}"));
    }
    line
}

fn emit(
    node: &SnapNode,
    depth: usize,
    interactive_only: bool,
    lines: &mut Vec<String>,
    refs: &mut usize,
) {
    if node.ref_id.is_some() {
        *refs += 1;
    }
    if interactive_only {
        if node.ref_id.is_some() || node.role == "heading" {
            // Headings are kept as cheap orientation; everything else is flattened.
            let mut flat = node.clone();
            flat.children.clear();
            lines.push(render_line(&flat, 0, None));
            for option in node.options.iter().take(30) {
                lines.push(render_option(option, 1));
            }
        }
        for child in &node.children {
            emit(child, 0, true, lines, refs);
        }
        return;
    }
    // Containers with no name/ref holding a single text child collapse to one line.
    let inline = match node.children.as_slice() {
        [only]
            if only.role == "text"
                && node.ref_id.is_none()
                && node.name.as_deref().unwrap_or("").is_empty() =>
        {
            only.text.as_deref()
        }
        _ => None,
    };
    lines.push(render_line(node, depth, inline));
    for option in node.options.iter().take(30) {
        lines.push(render_option(option, depth + 1));
    }
    if inline.is_none() {
        for child in &node.children {
            emit(child, depth + 1, false, lines, refs);
        }
    }
}

fn render_option(option: &SnapOption, depth: usize) -> String {
    let mut line = format!("{}- option {}", "  ".repeat(depth), quote(&option.label));
    if let Some(value) = option.value.as_deref().filter(|v| !v.is_empty()) {
        line.push_str(&format!(" [value={value}]"));
    }
    if option.selected {
        line.push_str(" [selected]");
    }
    if option.disabled {
        line.push_str(" [disabled]");
    }
    line
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

/// Renders walker output as compact text, cutting at a line boundary at `max_chars`.
pub fn format_snapshot(data: &SnapshotData, options: &SnapshotOptions) -> Snapshot {
    let mut lines = Vec::new();
    let mut refs = 0usize;
    for node in &data.nodes {
        emit(node, 0, options.interactive_only, &mut lines, &mut refs);
    }
    let total = lines.len();
    let mut text = String::new();
    let mut kept = 0usize;
    let mut line_truncated = false;
    for line in &lines {
        // Keep the formatter's output bound authoritative even when the first
        // DOM node contains a single very long text/name/value. Previously the
        // `kept == 0` escape hatch allowed that first line to exceed max_chars
        // by an arbitrary amount, which defeated tool truncation and could
        // flood the model context before the caller saw the truncation marker.
        let separator = usize::from(kept > 0);
        if text.len() + separator >= options.max_chars {
            line_truncated = true;
            break;
        }
        let available = options.max_chars - text.len() - separator;
        if kept > 0 {
            text.push('\n');
        }
        if line.len() <= available {
            text.push_str(line);
            kept += 1;
        } else {
            // Truncate on a UTF-8 boundary and reserve one character for the
            // ellipsis. The final marker below explains that more lines may be
            // requested with a narrower selector/interactive snapshot.
            if available >= '…'.len_utf8() {
                let prefix = truncate_utf8_bytes(line, available - '…'.len_utf8());
                text.push_str(prefix);
                text.push('…');
            } else {
                text.push_str(truncate_utf8_bytes(line, available));
            }
            kept += 1;
            line_truncated = true;
            break;
        }
    }
    let mut truncated = data.truncated;
    if kept < total || line_truncated {
        truncated = true;
        // The marker is deliberately appended only when space remains. The
        // snapshot text itself must never exceed max_chars; callers can rely
        // on the boolean for a lossless truncation signal.
        let remaining = total.saturating_sub(kept);
        let marker = format!(
            "\n... [snapshot truncated: {} more lines; use interactive_only or scroll for the rest]",
            remaining
        );
        let compact_marker = "\n... [snapshot truncated]";
        let marker = if text.len() + marker.len() <= options.max_chars {
            marker.as_str()
        } else {
            compact_marker
        };
        if options.max_chars >= marker.len() {
            let text_budget = options.max_chars - marker.len();
            if text.len() > text_budget {
                text = truncate_utf8_bytes(&text, text_budget).to_owned();
            }
            text.push_str(marker);
        }
    } else if data.truncated {
        let marker = "\n... [page too large; node budget reached]";
        if text.len() + marker.len() <= options.max_chars {
            text.push_str(marker);
        } else if options.max_chars >= "\n... [page too large]".len() {
            let compact = "\n... [page too large]";
            let text_budget = options.max_chars - compact.len();
            if text.len() > text_budget {
                text = truncate_utf8_bytes(&text, text_budget).to_owned();
            }
            text.push_str(compact);
        }
    }
    if text.is_empty() {
        let empty_message = "(no visible content)";
        if options.max_chars >= empty_message.len() {
            text.push_str(empty_message);
        } else {
            text.push_str(truncate_utf8_bytes(empty_message, options.max_chars));
            truncated = true;
        }
    } else if text.len() > options.max_chars {
        // Defensive guard for future formatting changes. All normal paths
        // already enforce the bound while constructing `text`.
        text = truncate_utf8_bytes(&text, options.max_chars).to_owned();
        truncated = true;
    }
    Snapshot {
        url: data.url.clone(),
        title: data.title.clone(),
        text,
        ref_count: refs,
        truncated,
        viewport: data.viewport.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> SnapshotData {
        serde_json::from_value(json!({
            "url": "https://example.com/login",
            "title": "Login",
            "nodes": [
                {"role": "banner", "children": [
                    {"role": "link", "name": "Docs", "ref": "e5", "href": "/docs"}
                ]},
                {"role": "main", "children": [
                    {"role": "heading", "name": "Sign in", "level": 1},
                    {"role": "paragraph", "children": [{"role": "text", "text": "Welcome back"}]},
                    {"role": "form", "name": "login", "children": [
                        {"role": "textbox", "name": "Email", "ref": "e13", "value": "me@example.com", "required": true},
                        {"role": "textbox", "name": "Password", "ref": "e14", "type": "password", "value": "(hidden)"},
                        {"role": "checkbox", "name": "Remember \"me\"", "ref": "e15", "checked": "true"},
                        {"role": "combobox", "name": "Country", "ref": "e16", "value": "Vietnam",
                         "options": [{"label": "Vietnam", "selected": true}, {"label": "France", "value": "fr"}]},
                        {"role": "button", "name": "Sign in", "ref": "e12", "disabled": true}
                    ]}
                ]},
                {"role": "iframe", "name": "ad", "src": "https://ads.example", "crossOrigin": true}
            ]
        }))
        .unwrap()
    }

    #[test]
    fn formats_full_tree() {
        let snap = format_snapshot(&fixture(), &SnapshotOptions::default());
        let expected = [
            "- banner",
            "  - link \"Docs\" [ref=e5] -> /docs",
            "- main",
            "  - heading \"Sign in\" [level=1]",
            "  - paragraph: Welcome back",
            "  - form \"login\"",
            "    - textbox \"Email\" [ref=e13] [required]: me@example.com",
            "    - textbox \"Password\" [ref=e14] [type=password]: (hidden)",
            "    - checkbox \"Remember \\\"me\\\"\" [ref=e15] [checked]",
            "    - combobox \"Country\" [ref=e16]: Vietnam",
            "      - option \"Vietnam\" [selected]",
            "      - option \"France\" [value=fr]",
            "    - button \"Sign in\" [ref=e12] [disabled]",
            "- iframe \"ad\" [cross-origin] [src=https://ads.example]",
        ]
        .join("\n");
        assert_eq!(snap.text, expected);
        assert_eq!(snap.ref_count, 6);
        assert!(!snap.truncated);
    }

    #[test]
    fn interactive_only_flattens() {
        let snap = format_snapshot(
            &fixture(),
            &SnapshotOptions {
                interactive_only: true,
                ..Default::default()
            },
        );
        let lines: Vec<&str> = snap.text.lines().collect();
        assert_eq!(lines[0], "- link \"Docs\" [ref=e5] -> /docs");
        assert_eq!(lines[1], "- heading \"Sign in\" [level=1]");
        assert!(lines
            .iter()
            .all(|l| !l.starts_with(' ') || l.starts_with("  - option")));
        assert!(!snap.text.contains("Welcome back"));
        assert!(!snap.text.contains("banner"));
        assert_eq!(snap.ref_count, 6);
    }

    #[test]
    fn truncates_at_line_boundary() {
        let snap = format_snapshot(
            &fixture(),
            &SnapshotOptions {
                interactive_only: false,
                max_chars: 90,
                ..Default::default()
            },
        );
        assert!(snap.truncated);
        assert!(snap.text.contains("snapshot truncated"));
        assert!(snap.text.starts_with("- banner\n  - link"));
    }

    #[test]
    fn empty_page_message() {
        let snap = format_snapshot(&SnapshotData::default(), &SnapshotOptions::default());
        assert_eq!(snap.text, "(no visible content)");
    }

    #[test]
    fn first_long_line_respects_output_budget() {
        let data = SnapshotData {
            nodes: vec![SnapNode {
                role: "paragraph".into(),
                text: Some("x".repeat(10_000)),
                ..Default::default()
            }],
            ..Default::default()
        };
        let max_chars = 64;
        let snap = format_snapshot(
            &data,
            &SnapshotOptions {
                max_chars,
                ..Default::default()
            },
        );
        assert!(snap.truncated);
        assert!(snap.text.chars().count() <= max_chars);
    }

    #[test]
    fn zero_budget_does_not_emit_unbounded_empty_page_text() {
        let snap = format_snapshot(
            &SnapshotData::default(),
            &SnapshotOptions {
                max_chars: 0,
                ..Default::default()
            },
        );
        assert!(snap.truncated);
        assert!(snap.text.is_empty());
    }

    #[test]
    fn snapshot_options_serde_and_defaults() {
        let default_opts = SnapshotOptions::default();
        assert!(!default_opts.interactive_only);
        assert!(!default_opts.visible_only);
        assert_eq!(default_opts.selector, None);
        assert_eq!(default_opts.max_nodes, None);

        let json_val = serde_json::json!({
            "interactive_only": true,
            "visible_only": true,
            "selector": "#main-content",
            "max_nodes": 1200,
            "max_chars": 15000
        });
        let parsed: SnapshotOptions = serde_json::from_value(json_val).unwrap();
        assert!(parsed.interactive_only);
        assert!(parsed.visible_only);
        assert_eq!(parsed.selector.as_deref(), Some("#main-content"));
        assert_eq!(parsed.max_nodes, Some(1200));
        assert_eq!(parsed.max_chars, 15000);
    }
}
