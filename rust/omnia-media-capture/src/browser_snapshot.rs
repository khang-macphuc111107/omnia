//! WeakMap `[ref=eN]` ARIA + Shadow DOM + `<slot>` + same-origin iframe DOM snapshot engine
//! with password-field `(hidden)` masking and strict UTF-8 char-boundary formatting.

use crate::browser_network::{redact_url, DialogRecord};
use serde_json::{json, Value};

const SNAPSHOT_JS: &str = include_str!("browser_snapshot.js");

/// Returns the embedded WeakMap `[ref=eN]` ARIA + Shadow DOM + `<slot>` + iframe DOM snapshot
/// script (`window.__omnia`) that masks `<input type="password">` values as `(hidden)`.
#[must_use]
pub fn snapshot_script() -> &'static str {
    SNAPSHOT_JS
}

/// Configuration for [`build_snapshot_eval_js`] and [`format_snapshot_tree`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomSnapshotOptions {
    pub interactive_only: bool,
    pub visible_only: bool,
    pub selector: Option<String>,
    pub max_nodes: usize,
    pub max_chars: usize,
}

impl Default for DomSnapshotOptions {
    fn default() -> Self {
        Self {
            interactive_only: false,
            visible_only: false,
            selector: None,
            max_nodes: 6_000,
            max_chars: 40_000,
        }
    }
}

/// Viewport geometry captured alongside a DOM accessibility snapshot.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SnapshotViewport {
    pub width: u32,
    pub height: u32,
    pub scroll_x: i32,
    pub scroll_y: i32,
    pub scroll_width: u32,
    pub scroll_height: u32,
    pub scale: f64,
}

/// Option entry inside a `<select>` (`combobox`/`listbox`) snapshot node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectOptionInfo {
    pub label: String,
    pub value: Option<String>,
    pub selected: bool,
    pub disabled: bool,
}

/// Single parsed node returned by `window.__omnia.snapshot(...)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomSnapshotNode {
    pub role: String,
    pub name: Option<String>,
    pub text: Option<String>,
    pub ref_id: Option<String>,
    pub level: Option<u8>,
    pub href: Option<String>,
    pub input_type: Option<String>,
    pub value: Option<String>,
    pub checked: Option<String>,
    pub focused: bool,
    pub disabled: bool,
    pub required: bool,
    pub expanded: Option<bool>,
    pub pressed: bool,
    pub selected: bool,
    pub src: Option<String>,
    pub cross_origin: bool,
    pub options: Vec<SelectOptionInfo>,
    pub children: Vec<DomSnapshotNode>,
}

/// Complete parsed snapshot payload from a browser page target.
#[derive(Debug, Clone, PartialEq)]
pub struct DomSnapshotResult {
    pub url: String,
    pub title: String,
    pub nodes: Vec<DomSnapshotNode>,
    pub truncated: bool,
    pub viewport: SnapshotViewport,
    pub node_count: usize,
    pub ref_count: usize,
    pub rendered: String,
}

impl DomSnapshotResult {
    /// Secret-safe JSON representation (redacts URL query/userinfo).
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "url": redact_url(&self.url),
            "title": self.title,
            "node_count": self.node_count,
            "ref_count": self.ref_count,
            "truncated": self.truncated,
            "viewport": {
                "width": self.viewport.width,
                "height": self.viewport.height,
                "scroll_x": self.viewport.scroll_x,
                "scroll_y": self.viewport.scroll_y,
                "scroll_width": self.viewport.scroll_width,
                "scroll_height": self.viewport.scroll_height,
                "scale": self.viewport.scale,
            },
            "tree": self.rendered,
        })
    }
}

/// Builds the self-installing JS expression that injects `window.__omnia` (if absent) and runs
/// `window.__omnia.snapshot(opts)` returning a JSON string.
#[must_use]
pub fn build_snapshot_eval_js(opts: &DomSnapshotOptions) -> String {
    let js_opts = json!({
        "interactive": opts.interactive_only,
        "visibleOnly": opts.visible_only,
        "selector": opts.selector,
        "maxNodes": opts.max_nodes.clamp(1, 20_000),
    });
    format!("({SNAPSHOT_JS}).snapshot({js_opts})")
}

/// Parses the JSON string returned by `window.__omnia.snapshot(...)` and formats the compact tree.
pub fn parse_snapshot_json(
    raw_json: &str,
    max_chars: usize,
) -> Result<DomSnapshotResult, String> {
    let val: Value = serde_json::from_str(raw_json)
        .map_err(|e| format!("invalid DOM snapshot JSON: {e}"))?;
    parse_snapshot_value(&val, max_chars)
}

/// Parses a JSON [`Value`] snapshot payload and renders the bounded ARIA tree text.
pub fn parse_snapshot_value(
    val: &Value,
    max_chars: usize,
) -> Result<DomSnapshotResult, String> {
    let obj = val
        .as_object()
        .ok_or_else(|| "DOM snapshot payload must be a JSON object".to_string())?;
    let url = obj
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let title = obj
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let js_truncated = obj
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let nodes = obj
        .get("nodes")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parse_node).collect::<Vec<_>>())
        .unwrap_or_default();

    let vp = obj.get("viewport").and_then(Value::as_object);
    let viewport = SnapshotViewport {
        width: vp
            .and_then(|v| v.get("width"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
        height: vp
            .and_then(|v| v.get("height"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
        scroll_x: vp
            .and_then(|v| v.get("scrollX"))
            .and_then(Value::as_i64)
            .unwrap_or(0) as i32,
        scroll_y: vp
            .and_then(|v| v.get("scrollY"))
            .and_then(Value::as_i64)
            .unwrap_or(0) as i32,
        scroll_width: vp
            .and_then(|v| v.get("scrollWidth"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
        scroll_height: vp
            .and_then(|v| v.get("scrollHeight"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
        scale: vp
            .and_then(|v| v.get("scale"))
            .and_then(Value::as_f64)
            .unwrap_or(1.0),
    };

    let mut node_count = 0usize;
    let mut ref_count = 0usize;
    count_tree(&nodes, &mut node_count, &mut ref_count);
    let (rendered, text_truncated) = format_snapshot_tree(&nodes, max_chars.max(64));

    Ok(DomSnapshotResult {
        url,
        title,
        nodes,
        truncated: js_truncated || text_truncated,
        viewport,
        node_count,
        ref_count,
        rendered,
    })
}

fn parse_node(val: &Value) -> Option<DomSnapshotNode> {
    let obj = val.as_object()?;
    let role = obj.get("role")?.as_str()?.to_string();
    let str_opt = |k: &str| {
        obj.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let bool_val = |k: &str| obj.get(k).and_then(Value::as_bool).unwrap_or(false);
    let options = obj
        .get("options")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|o| {
                    let oo = o.as_object()?;
                    Some(SelectOptionInfo {
                        label: oo.get("label")?.as_str()?.to_string(),
                        value: oo
                            .get("value")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        selected: oo.get("selected").and_then(Value::as_bool).unwrap_or(false),
                        disabled: oo.get("disabled").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let children = obj
        .get("children")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parse_node).collect())
        .unwrap_or_default();

    Some(DomSnapshotNode {
        role,
        name: str_opt("name"),
        text: str_opt("text"),
        ref_id: str_opt("ref"),
        level: obj
            .get("level")
            .and_then(Value::as_u64)
            .map(|n| n.min(6) as u8),
        href: str_opt("href"),
        input_type: str_opt("type"),
        value: str_opt("value"),
        checked: str_opt("checked"),
        focused: bool_val("focused"),
        disabled: bool_val("disabled"),
        required: bool_val("required"),
        expanded: obj.get("expanded").and_then(Value::as_bool),
        pressed: bool_val("pressed"),
        selected: bool_val("selected"),
        src: str_opt("src"),
        cross_origin: bool_val("crossOrigin"),
        options,
        children,
    })
}

fn count_tree(nodes: &[DomSnapshotNode], node_count: &mut usize, ref_count: &mut usize) {
    for n in nodes {
        *node_count += 1;
        if n.ref_id.is_some() {
            *ref_count += 1;
        }
        count_tree(&n.children, node_count, ref_count);
    }
}

/// Formats parsed [`DomSnapshotNode`]s into a compact indented ARIA tree strictly bounded by
/// `max_chars` (UTF-8 char-boundary safe, never overflowing even on the first line).
#[must_use]
pub fn format_snapshot_tree(nodes: &[DomSnapshotNode], max_chars: usize) -> (String, bool) {
    let mut lines = Vec::new();
    flatten_lines(nodes, 0, &mut lines);
    if lines.is_empty() {
        return (String::new(), false);
    }
    let mut out = String::new();
    let mut truncated = false;
    for (idx, line) in lines.iter().enumerate() {
        let sep = usize::from(idx > 0);
        if out.len() + sep + line.len() > max_chars {
            if out.is_empty() {
                let mut cut = max_chars.min(line.len());
                while cut > 0 && !line.is_char_boundary(cut) {
                    cut -= 1;
                }
                out.push_str(&line[..cut]);
            }
            truncated = true;
            break;
        }
        if idx > 0 {
            out.push('\n');
        }
        out.push_str(line);
    }
    if truncated {
        out.push_str("\n... [snapshot truncated: pass selector or interactive_only=true]");
    }
    (out, truncated)
}

fn flatten_lines(nodes: &[DomSnapshotNode], depth: usize, out: &mut Vec<String>) {
    let indent = "  ".repeat(depth.min(12));
    for n in nodes {
        if n.role == "text" {
            if let Some(ref t) = n.text {
                out.push(format!("{indent}- text: {t}"));
            }
            continue;
        }
        let mut line = format!("{indent}- {}", n.role);
        if let Some(lvl) = n.level {
            line.push_str(&format!("[level={lvl}]"));
        }
        if let Some(ref name) = n.name {
            line.push_str(&format!(" \"{}\"", name.replace('"', "'")));
        }
        if let Some(ref r) = n.ref_id {
            line.push_str(&format!(" [ref={r}]"));
        }
        if let Some(ref it) = n.input_type {
            line.push_str(&format!(" type={it}"));
        }
        if let Some(ref chk) = n.checked {
            line.push_str(&format!(" checked={chk}"));
        }
        if n.focused {
            line.push_str(" focused");
        }
        if n.disabled {
            line.push_str(" disabled");
        }
        if n.required {
            line.push_str(" required");
        }
        if let Some(exp) = n.expanded {
            line.push_str(if exp { " expanded" } else { " collapsed" });
        }
        if n.pressed {
            line.push_str(" pressed");
        }
        if n.selected {
            line.push_str(" selected");
        }
        if n.cross_origin {
            line.push_str(" [cross-origin]");
        }
        if let Some(ref src) = n.src {
            line.push_str(&format!(" src={}", redact_url(src)));
        }
        if let Some(ref href) = n.href {
            line.push_str(&format!(" href={href}"));
        }
        if let Some(ref val) = n.value {
            let safe_val = if n.input_type.as_deref() == Some("password") {
                "(hidden)"
            } else {
                val.as_str()
            };
            line.push_str(&format!(": {safe_val}"));
        }
        if !n.options.is_empty() {
            let preview: Vec<String> = n
                .options
                .iter()
                .take(8)
                .map(|o| {
                    if o.selected {
                        format!("*{}", o.label)
                    } else {
                        o.label.clone()
                    }
                })
                .collect();
            line.push_str(&format!(" options=[{}]", preview.join(", ")));
        }
        out.push(line);
        flatten_lines(&n.children, depth + 1, out);
    }
}

/// Renders a full agent-ready snapshot report including redacted URL, title, counts, and dialogs.
#[must_use]
pub fn render_dom_snapshot(
    snap: &DomSnapshotResult,
    dialogs: &[DialogRecord],
) -> String {
    let mut out = format!(
        "Page \"{}\" ({}) — {} nodes, {} refs{}\n",
        snap.title,
        redact_url(&snap.url),
        snap.node_count,
        snap.ref_count,
        if snap.truncated { " [truncated]" } else { "" }
    );
    if !dialogs.is_empty() {
        out.push_str("Handled dialogs:\n");
        for d in dialogs {
            out.push_str(&format!(
                "  - {} ({}): \"{}\"\n",
                d.dialog_type,
                if d.accepted { "accepted" } else { "dismissed" },
                d.message
            ));
        }
    }
    if snap.rendered.is_empty() {
        out.push_str("(empty page)");
    } else {
        out.push_str(&snap.rendered);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_script_contains_weakmap_shadow_slot_iframe_and_password_masking() {
        let js = snapshot_script();
        assert!(js.contains("new WeakMap()"));
        assert!(js.contains("shadowRoot"));
        assert!(js.contains("assignedNodes({ flatten: true })"));
        assert!(js.contains("contentDocument"));
        assert!(js.contains("if (t === 'password') return el.value ? '(hidden)' : ''"));
    }

    #[test]
    fn parses_nested_aria_tree_masks_password_and_marks_cross_origin_iframes() {
        let raw = json!({
            "url": "https://app.example.test/auth?token=dummy_secret_tok",
            "title": "Sign In",
            "truncated": false,
            "viewport": {
                "width": 1280, "height": 800,
                "scrollX": 0, "scrollY": 0,
                "scrollWidth": 1280, "scrollHeight": 1200,
                "scale": 1.0
            },
            "nodes": [
                { "role": "heading", "level": 1, "name": "Welcome" },
                {
                    "role": "form",
                    "name": "Login",
                    "children": [
                        { "role": "textbox", "name": "Password", "ref": "e1", "type": "password", "value": "should_never_appear", "required": true },
                        { "role": "combobox", "name": "Role", "ref": "e2", "options": [
                            { "label": "User", "selected": true },
                            { "label": "Admin", "selected": false }
                        ]},
                        { "role": "button", "name": "Submit", "ref": "e3", "focused": true }
                    ]
                },
                { "role": "iframe", "name": "OAuth", "src": "https://sso.example.test/frame?sig=dummy_sig_x", "crossOrigin": true }
            ]
        });

        let snap = parse_snapshot_value(&raw, 40_000).expect("parse snapshot");
        assert_eq!(snap.node_count, 6);
        assert_eq!(snap.ref_count, 3);
        assert!(!snap.truncated);
        assert!(snap.rendered.contains("heading[level=1] \"Welcome\""));
        assert!(snap.rendered.contains("[ref=e1] type=password required: (hidden)"));
        assert!(!snap.rendered.contains("should_never_appear"));
        assert!(snap.rendered.contains("options=[*User, Admin]"));
        assert!(snap.rendered.contains("[cross-origin] src=https://sso.example.test/frame"));
        assert!(!snap.rendered.contains("dummy_sig_x"));

        let full = render_dom_snapshot(&snap, &[]);
        assert!(full.contains("https://app.example.test/auth"));
        assert!(!full.contains("dummy_secret_tok"));
    }

    #[test]
    fn format_snapshot_tree_handles_multibyte_utf8_truncation_cleanly() {
        let nodes = vec![
            DomSnapshotNode {
                role: "button".into(),
                name: Some("Xác nhận đăng nhập hệ thống".into()),
                text: None,
                ref_id: Some("e1".into()),
                level: None,
                href: None,
                input_type: None,
                value: None,
                checked: None,
                focused: false,
                disabled: false,
                required: false,
                expanded: None,
                pressed: false,
                selected: false,
                src: None,
                cross_origin: false,
                options: vec![],
                children: vec![],
            },
            DomSnapshotNode {
                role: "button".into(),
                name: Some("Hủy".into()),
                text: None,
                ref_id: Some("e2".into()),
                level: None,
                href: None,
                input_type: None,
                value: None,
                checked: None,
                focused: false,
                disabled: false,
                required: false,
                expanded: None,
                pressed: false,
                selected: false,
                src: None,
                cross_origin: false,
                options: vec![],
                children: vec![],
            },
        ];
        // Truncate right in the middle of a multi-byte Vietnamese character on line 1
        let (text, truncated) = format_snapshot_tree(&nodes, 25);
        assert!(truncated);
        assert!(text.contains("[snapshot truncated"));
    }
}
