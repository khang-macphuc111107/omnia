//! Snapshot node classification and compact text rendering (pure, fixture-testable).

use crate::types::Rect;

/// Which UIA patterns an element supports.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PatternFlags {
    pub invoke: bool,
    pub value: bool,
    pub toggle: bool,
    pub selection_item: bool,
    pub expand_collapse: bool,
    pub text: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Gets a ref; always listed.
    Interactive,
    /// Static text; listed only when not `interactive_only`.
    Text,
    /// Named structural element; listed only when not `interactive_only`.
    Container,
    Skip,
}

/// UIA control type id -> short role name.
pub fn role_name(control_type: i32) -> &'static str {
    match control_type {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        50040 => "AppBar",
        _ => "Element",
    }
}

pub fn classify(control_type: i32, name_empty: bool, p: &PatternFlags) -> Kind {
    match control_type {
        // Pure chrome.
        50014 | 50027 | 50022 | 50038 | 50037 => Kind::Skip,
        50006 => {
            if name_empty {
                Kind::Skip
            } else {
                Kind::Text
            }
        }
        // Always interactive.
        50000 | 50002 | 50003 | 50004 | 50005 | 50007 | 50011 | 50013 | 50015 | 50016 | 50019
        | 50024 | 50029 | 50030 | 50031 => Kind::Interactive,
        50020 => {
            if name_empty {
                Kind::Skip
            } else if p.invoke || p.toggle || p.selection_item {
                Kind::Interactive
            } else {
                Kind::Text
            }
        }
        _ => {
            if p.invoke || p.toggle || p.selection_item || p.expand_collapse {
                Kind::Interactive
            } else if name_empty {
                Kind::Skip
            } else {
                Kind::Container
            }
        }
    }
}

/// Whether the walker should look inside a node of this type.
pub fn has_useful_children(control_type: i32) -> bool {
    !matches!(
        control_type,
        50000
            | 50002
            | 50004
            | 50005
            | 50006
            | 50013
            | 50014
            | 50015
            | 50016
            | 50020
            | 50027
            | 50038
    )
}

#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub depth: usize,
    pub role: &'static str,
    pub name: String,
    pub auto_id: String,
    pub ref_id: Option<String>,
    pub rect: Rect,
    pub value: Option<String>,
    pub states: Vec<&'static str>,
}

fn clip(text: &str, max: usize) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    if flat.chars().count() <= max {
        flat.replace('"', "'")
    } else {
        let mut s: String = flat.chars().take(max).collect();
        s.push_str("...");
        s.replace('"', "'")
    }
}

/// `- Button "Save" [ref=w3e17] (10,20,80,24) disabled: value`
pub fn format_node(n: &Node) -> String {
    let mut line = format!("{}- {}", "  ".repeat(n.depth), n.role);
    if !n.name.trim().is_empty() {
        line.push_str(&format!(" \"{}\"", clip(n.name.trim(), 120)));
    } else if !n.auto_id.is_empty() {
        line.push_str(&format!(" #{}", clip(&n.auto_id, 60)));
    }
    if let Some(r) = &n.ref_id {
        line.push_str(&format!(" [ref={r}]"));
    }
    if n.ref_id.is_some() {
        line.push_str(&format!(
            " ({},{},{},{})",
            n.rect.x, n.rect.y, n.rect.w, n.rect.h
        ));
    }
    for s in &n.states {
        line.push(' ');
        line.push_str(s);
    }
    if let Some(v) = &n.value {
        if !v.is_empty() {
            line.push_str(&format!(": {}", clip(v, 300)));
        }
    }
    line
}

/// Render nodes, stopping before `max_chars`. Returns `(text, nodes_shown)`.
pub fn format_nodes(nodes: &[Node], max_chars: usize) -> (String, usize) {
    let mut out = String::new();
    let mut shown = 0;
    for n in nodes {
        let line = format_node(n);
        if out.len() + line.len() + 1 > max_chars && shown > 0 {
            break;
        }
        if shown > 0 {
            out.push('\n');
        }
        out.push_str(&line);
        shown += 1;
    }
    if shown < nodes.len() {
        out.push_str(&format!(
            "\n... [{} more nodes omitted: output limit reached; pass `window` or raise `max_chars`]",
            nodes.len() - shown
        ));
    }
    (out, shown)
}

/// Parse `w3e17` into `(window_slot, element_index)`.
pub fn parse_ref(r: &str) -> Option<(u32, usize)> {
    let rest = r.trim().strip_prefix('w')?;
    let (w, e) = rest.split_once('e')?;
    Some((w.parse().ok()?, e.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(role: &'static str, name: &str, r: Option<&str>) -> Node {
        Node {
            depth: 0,
            role,
            name: name.into(),
            auto_id: String::new(),
            ref_id: r.map(String::from),
            rect: Rect::new(10, 20, 80, 24),
            value: None,
            states: vec![],
        }
    }

    #[test]
    fn formats_button_edit_checkbox() {
        assert_eq!(
            format_node(&node("Button", "Save", Some("w3e17"))),
            "- Button \"Save\" [ref=w3e17] (10,20,80,24)"
        );
        let mut e = node("Edit", "File name", Some("w3e18"));
        e.value = Some("notes.txt".into());
        assert_eq!(
            format_node(&e),
            "- Edit \"File name\" [ref=w3e18] (10,20,80,24): notes.txt"
        );
        let mut c = node("CheckBox", "Wrap", Some("w3e19"));
        c.states = vec!["checked", "disabled"];
        assert_eq!(
            format_node(&c),
            "- CheckBox \"Wrap\" [ref=w3e19] (10,20,80,24) checked disabled"
        );
    }

    #[test]
    fn text_has_no_ref_and_indents() {
        let mut t = node("Text", "Hello \"world\"\nline2", None);
        t.depth = 2;
        assert_eq!(format_node(&t), "    - Text \"Hello 'world' line2\"");
    }

    #[test]
    fn unnamed_uses_automation_id() {
        let mut b = node("Button", "", Some("w1e1"));
        b.auto_id = "CloseButton".into();
        assert!(format_node(&b).starts_with("- Button #CloseButton [ref=w1e1]"));
    }

    #[test]
    fn truncation_reports_omitted() {
        let nodes: Vec<Node> = (0..50)
            .map(|i| node("Button", &format!("B{i}"), Some("w1e1")))
            .collect();
        let (text, shown) = format_nodes(&nodes, 200);
        assert!(shown < 50 && shown > 0);
        assert!(text.contains("more nodes omitted"));
        let (full, n) = format_nodes(&nodes[..2], 10_000);
        assert_eq!(n, 2);
        assert!(!full.contains("omitted"));
    }

    #[test]
    fn classification() {
        let none = PatternFlags::default();
        assert_eq!(classify(50000, false, &none), Kind::Interactive);
        assert_eq!(classify(50020, false, &none), Kind::Text);
        assert_eq!(classify(50020, true, &none), Kind::Skip);
        assert_eq!(classify(50033, true, &none), Kind::Skip);
        assert_eq!(classify(50033, false, &none), Kind::Container);
        let inv = PatternFlags {
            invoke: true,
            ..Default::default()
        };
        assert_eq!(classify(50033, true, &inv), Kind::Interactive);
        assert_eq!(classify(50014, false, &none), Kind::Skip);
        assert_eq!(classify(50030, true, &none), Kind::Interactive);
        assert_eq!(role_name(50004), "Edit");
        assert_eq!(role_name(1), "Element");
        assert!(!has_useful_children(50000));
        assert!(has_useful_children(50007));
    }

    #[test]
    fn ref_parsing() {
        assert_eq!(parse_ref("w3e17"), Some((3, 17)));
        assert_eq!(parse_ref(" w10e0 "), Some((10, 0)));
        assert_eq!(parse_ref("e17"), None);
        assert_eq!(parse_ref("wxe1"), None);
    }
}
