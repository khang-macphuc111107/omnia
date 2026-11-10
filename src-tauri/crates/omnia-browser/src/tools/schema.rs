//! Tool names, effect classes and JSON schemas.

use omnia_harness::{EffectClass, ToolSpec};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Navigate,
    Snapshot,
    Click,
    Type,
    Press,
    Hover,
    Scroll,
    Select,
    Upload,
    Wait,
    Screenshot,
    Evaluate,
    GetText,
    Tabs,
    Console,
    Network,
    Pdf,
    Batch,
    Record,
    Emulate,
    SavePage,
}

pub const ALL_KINDS: [Kind; 21] = [
    Kind::Navigate,
    Kind::Snapshot,
    Kind::Click,
    Kind::Type,
    Kind::Press,
    Kind::Hover,
    Kind::Scroll,
    Kind::Select,
    Kind::Upload,
    Kind::Wait,
    Kind::Screenshot,
    Kind::Evaluate,
    Kind::GetText,
    Kind::Tabs,
    Kind::Console,
    Kind::Network,
    Kind::Pdf,
    Kind::Batch,
    Kind::Record,
    Kind::Emulate,
    Kind::SavePage,
];

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Navigate => "browser_navigate",
            Kind::Snapshot => "browser_snapshot",
            Kind::Click => "browser_click",
            Kind::Type => "browser_type",
            Kind::Press => "browser_press",
            Kind::Hover => "browser_hover",
            Kind::Scroll => "browser_scroll",
            Kind::Select => "browser_select",
            Kind::Upload => "browser_upload",
            Kind::Wait => "browser_wait",
            Kind::Screenshot => "browser_screenshot",
            Kind::Evaluate => "browser_evaluate",
            Kind::GetText => "browser_get_text",
            Kind::Tabs => "browser_tabs",
            Kind::Console => "browser_console",
            Kind::Network => "browser_network",
            Kind::Pdf => "browser_pdf",
            Kind::Batch => "browser_batch",
            Kind::Record => "browser_record",
            Kind::Emulate => "browser_emulate",
            Kind::SavePage => "browser_save_page",
        }
    }

    pub fn from_name(name: &str) -> Option<Kind> {
        ALL_KINDS.iter().copied().find(|k| k.name() == name)
    }

    pub fn effect(self) -> EffectClass {
        // Even observation may lazily launch a process, create a tab and run JS;
        // tabs includes close/new, and batch can contain any action. Do not let
        // read-only workspace grants bypass browser approval or serialization.
        EffectClass::BrowserControl
    }

    /// Tools that change the page and therefore report its new state.
    pub fn is_action(self) -> bool {
        matches!(
            self,
            Kind::Navigate
                | Kind::Click
                | Kind::Type
                | Kind::Press
                | Kind::Hover
                | Kind::Scroll
                | Kind::Select
                | Kind::Upload
                | Kind::Wait
        )
    }

    pub fn describe(self, input: &Value) -> String {
        let text = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("");
        let target = || {
            ["ref", "selector"]
                .iter()
                .find_map(|k| input.get(*k).and_then(Value::as_str))
                .map(str::to_string)
                .unwrap_or_else(|| "a point".into())
        };
        match self {
            Kind::Navigate => format!("Open {} in the browser", text("url")),
            Kind::Snapshot => "Snapshot the current page".into(),
            Kind::Click => format!("Click {}", target()),
            Kind::Type => format!("Type into {}", target()),
            Kind::Press => format!("Press {}", text("keys")),
            Kind::Hover => format!("Hover {}", target()),
            Kind::Scroll => format!("Scroll {}", text("direction")),
            Kind::Select => format!("Select option in {}", target()),
            Kind::Upload => format!("Upload files to {}", target()),
            Kind::Wait => "Wait for the page".into(),
            Kind::Screenshot => "Take a screenshot".into(),
            Kind::Evaluate => {
                let expr: String = text("expression").chars().take(80).collect();
                format!("Run JavaScript in the page: {expr}")
            }
            Kind::GetText => "Read page text".into(),
            Kind::Tabs => format!("Browser tabs: {}", text("action")),
            Kind::Console => "Read browser console".into(),
            Kind::Network => "List captured network requests".into(),
            Kind::Pdf => format!("Save page as PDF to {}", text("path")),
            Kind::Record => format!("Browser recording: {}", text("action")),
            Kind::Emulate => {
                if input.get("reset").and_then(Value::as_bool).unwrap_or(false) {
                    "Reset browser emulation".into()
                } else {
                    let device = match input.get("device") {
                        Some(Value::String(name)) => name.clone(),
                        Some(Value::Object(_)) => "a custom device".into(),
                        _ => String::new(),
                    };
                    let mut parts = Vec::new();
                    if !device.is_empty() {
                        parts.push(format!("device {device}"));
                    }
                    if !text("color_scheme").is_empty() {
                        parts.push(format!("{} color scheme", text("color_scheme")));
                    }
                    if input.get("reduced_motion").is_some() {
                        parts.push("reduced motion".into());
                    }
                    format!("Emulate in the browser: {}", parts.join(", "))
                }
            }
            Kind::SavePage => {
                let path = text("path");
                let format = if text("format").is_empty() {
                    "mhtml"
                } else {
                    text("format")
                };
                if path.is_empty() {
                    format!("Save page as {format} to the downloads folder")
                } else {
                    format!("Save page as {format} to {path}")
                }
            }
            Kind::Batch => format!(
                "Run {} browser actions",
                input["actions"].as_array().map_or(0, Vec::len)
            ),
        }
    }

    pub fn spec(self) -> ToolSpec {
        let (description, schema) = match self {
            Kind::Navigate => (
                "Open a URL in the browser (a real Edge/Chrome with a persistent profile, so logins stick). Waits for the page to load, then returns the title, final URL and an interactive snapshot with element refs. Use `new_tab` to keep the current page open.",
                object(
                    json!({
                        "url": {"type": "string", "description": "URL to open. https:// is assumed when no scheme is given."},
                        "tab": tab_prop(),
                        "new_tab": {"type": "boolean", "description": "Open in a new tab instead of the current one."},
                    }),
                    &["url"],
                ),
            ),
            Kind::Snapshot => (
                "Capture the page as a compact accessibility-style tree. Interactive elements carry refs like [ref=e12] that other browser_* tools accept. Refs stay valid until the page navigates. Can scope to a specific CSS selector or viewport region and capture an accompanying screenshot to save tokens.",
                object(
                    json!({
                        "tab": tab_prop(),
                        "interactive_only": {"type": "boolean", "description": "Only links, buttons, fields and headings (much shorter)."},
                        "visible_only": {"type": "boolean", "description": "Only capture elements within the current visible viewport to save tokens."},
                        "selector": {"type": "string", "description": "Scope snapshot to a CSS selector/region (e.g. main, #content, .sidebar)."},
                        "max_nodes": {"type": "integer", "description": "Maximum number of DOM nodes to walk (default 6000)."},
                        "max_chars": {"type": "integer", "description": "Output cap in characters (default 40000)."},
                        "capture_screenshot": {"type": "boolean", "description": "Also capture an inline visual screenshot of the scoped region or viewport."},
                    }),
                    &[],
                ),
            ),
            Kind::Click => (
                "Click an element by `ref` (from a snapshot), CSS `selector`, or viewport `x`/`y`. Scrolls it into view first. Reports the resulting page state.",
                object(
                    json!({
                        "ref": ref_prop(), "selector": selector_prop(),
                        "x": {"type": "number"}, "y": {"type": "number"},
                        "button": {"type": "string", "enum": ["left", "right", "middle"]},
                        "double": {"type": "boolean", "description": "Double-click."},
                        "modifiers": {"type": "array", "items": {"type": "string"}, "description": "Held keys: ctrl, shift, alt, meta."},
                        "tab": tab_prop(),
                    }),
                    &[],
                ),
            ),
            Kind::Type => (
                "Type text into a field (by `ref` or `selector`). By default the existing content is replaced; set `clear` to false to append. `submit` presses Enter afterwards.",
                object(
                    json!({
                        "ref": ref_prop(), "selector": selector_prop(),
                        "text": {"type": "string"},
                        "submit": {"type": "boolean", "description": "Press Enter after typing."},
                        "clear": {"type": "boolean", "description": "Replace existing content (default true)."},
                        "tab": tab_prop(),
                    }),
                    &["text"],
                ),
            ),
            Kind::Press => (
                "Press keys on the focused element. One combo like `Enter`, `Escape`, `Tab`, `ArrowDown`, `ctrl+a`, `shift+Tab`, or several separated by spaces (`ctrl+a Backspace`).",
                object(json!({"keys": {"type": "string"}, "tab": tab_prop()}), &["keys"]),
            ),
            Kind::Hover => (
                "Move the mouse over an element (opens menus and tooltips).",
                object(
                    json!({"ref": ref_prop(), "selector": selector_prop(), "x": {"type": "number"}, "y": {"type": "number"}, "tab": tab_prop()}),
                    &[],
                ),
            ),
            Kind::Scroll => (
                "Scroll the page by `direction` (up/down/left/right) and `amount` pixels (default: most of a screen), or scroll the element `ref` into view.",
                object(
                    json!({
                        "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
                        "amount": {"type": "number", "description": "Pixels."},
                        "ref": ref_prop(), "selector": selector_prop(),
                        "tab": tab_prop(),
                    }),
                    &[],
                ),
            ),
            Kind::Select => (
                "Choose option(s) of a <select> by value or visible label.",
                object(
                    json!({
                        "ref": ref_prop(), "selector": selector_prop(),
                        "values": {"type": "array", "items": {"type": "string"}},
                        "tab": tab_prop(),
                    }),
                    &["values"],
                ),
            ),
            Kind::Upload => (
                "Attach local files to an <input type=file> (by `ref` or `selector`).",
                object(
                    json!({
                        "ref": ref_prop(), "selector": selector_prop(),
                        "paths": {"type": "array", "items": {"type": "string"}, "description": "File paths (relative to the workspace)."},
                        "tab": tab_prop(),
                    }),
                    &["paths"],
                ),
            ),
            Kind::Wait => (
                "Wait until `text` appears, `text_gone` disappears, a CSS `selector` exists, or just `ms` milliseconds pass. Fails after `timeout_ms` (default 10000).",
                object(
                    json!({
                        "text": {"type": "string"}, "text_gone": {"type": "string"}, "selector": {"type": "string"},
                        "ms": {"type": "integer"}, "timeout_ms": {"type": "integer"},
                        "tab": tab_prop(),
                    }),
                    &[],
                ),
            ),
            Kind::Screenshot => (
                "Take a screenshot (JPEG, downscaled for token economy) of the viewport, the full page, or one element (`ref`/`selector`).",
                object(
                    json!({
                        "full_page": {"type": "boolean"},
                        "ref": ref_prop(), "selector": selector_prop(),
                        "tab": tab_prop(),
                    }),
                    &[],
                ),
            ),
            Kind::Evaluate => (
                "Run a JavaScript expression in the page and return its JSON result (promises are awaited). Can change the page, so prefer the dedicated tools when they fit.",
                object(json!({"expression": {"type": "string"}, "tab": tab_prop()}), &["expression"]),
            ),
            Kind::GetText => (
                "Return the readable text of the page (innerText), without element refs.",
                object(json!({"tab": tab_prop(), "max_chars": {"type": "integer", "description": "Default 20000."}}), &[]),
            ),
            Kind::Tabs => (
                "List, open, select or close browser tabs.",
                object(
                    json!({
                        "action": {"type": "string", "enum": ["list", "new", "select", "close"]},
                        "url": {"type": "string", "description": "For `new`: page to open."},
                        "tab": tab_prop(),
                    }),
                    &["action"],
                ),
            ),
            Kind::Console => (
                "Recent console messages and uncaught errors of a tab.",
                object(
                    json!({
                        "level": {"type": "string", "enum": ["error", "warning", "info", "debug"], "description": "Minimum severity."},
                        "limit": {"type": "integer"}, "clear": {"type": "boolean"}, "tab": tab_prop(),
                    }),
                    &[],
                ),
            ),
            Kind::Network => (
                "List network requests the browser captured (ids can be handed to the downloader). Filter by URL substring, resource type (document, xhr, fetch, media, image, script...) or MIME type.",
                object(
                    json!({
                        "filter": {"type": "string", "description": "URL substring."},
                        "resource_type": {"type": "string"}, "mime": {"type": "string"},
                        "limit": {"type": "integer", "description": "Most recent N (default 30)."},
                        "tab": tab_prop(),
                    }),
                    &[],
                ),
            ),
            Kind::Pdf => (
                "Save the current page as a PDF file (works best with a headless browser).",
                object(json!({"path": {"type": "string"}, "tab": tab_prop()}), &["path"]),
            ),
            Kind::Emulate => (
                "Emulate a device and media preferences on a tab: `device` is a preset (\"iPhone 15\", \"Pixel 8\", \"iPad\") or {width,height,dpr,mobile,user_agent}; `color_scheme` light|dark; `reduced_motion` true|false; `reset` clears every override first. Media preferences given in one call replace those from earlier calls. Overrides last until reset or the tab closes; reload the page to apply a new user agent.",
                object(
                    json!({
                        "device": {
                            "description": "Preset name or custom device.",
                            "anyOf": [
                                {"type": "string", "description": "iPhone 15, Pixel 8 or iPad."},
                                {
                                    "type": "object",
                                    "properties": {
                                        "width": {"type": "integer"}, "height": {"type": "integer"},
                                        "dpr": {"type": "number", "description": "Device pixel ratio (default 1)."},
                                        "mobile": {"type": "boolean", "description": "Mobile viewport with touch (default false)."},
                                        "user_agent": {"type": "string"},
                                    },
                                    "required": ["width", "height"],
                                },
                            ],
                        },
                        "color_scheme": {"type": "string", "enum": ["light", "dark"]},
                        "reduced_motion": {"type": "boolean", "description": "Emulate prefers-reduced-motion: reduce (true) or no-preference (false)."},
                        "reset": {"type": "boolean", "description": "Clear all emulation overrides first."},
                        "tab": tab_prop(),
                    }),
                    &[],
                ),
            ),
            Kind::SavePage => (
                "Save the current page to a file: `mhtml` (default; one self-contained archive with images and styles, via Page.captureSnapshot) or `html` (the current DOM only). `path` is relative to the workspace; without it the file goes to downloads/page-<timestamp>.<ext>.",
                object(
                    json!({
                        "path": {"type": "string", "description": "Output file (default downloads/page-<timestamp>.<ext>)."},
                        "format": {"type": "string", "enum": ["mhtml", "html"], "description": "Default mhtml."},
                        "tab": tab_prop(),
                    }),
                    &[],
                ),
            ),
            Kind::Record => (
                "Record the browser session. `start` begins capturing every browser action (with a robust selector for element targets) and a screenshot frame after each one plus ~1 frame/s while idle (max 600 frames); `stop` writes recording.gif, steps.json and a Playwright replay.spec.ts into the app recordings folder and returns the paths; `status` reports progress. Text typed into password fields is never written; the spec uses process.env.OMNIA_SECRET_n placeholders.",
                object(
                    json!({
                        "action": {"type": "string", "enum": ["start", "stop", "status"]},
                        "name": {"type": "string", "description": "For start: short recording name (folder prefix)."},
                        "fps": {"type": "number", "description": "For start: idle frames per second (0-4, default 1; 0 = frames only after actions)."},
                    }),
                    &["action"],
                ),
            ),
            Kind::Batch => (
                "Run several browser_* actions in order in one call; stops at the first failure and returns all outputs. Each action is {\"tool\": \"browser_click\", \"input\": {...}}. Only the final action reports page state.",
                object(
                    json!({"actions": {"type": "array", "items": {
                        "type": "object",
                        "properties": {"tool": {"type": "string"}, "input": {"type": "object"}},
                        "required": ["tool"],
                    }}}),
                    &["actions"],
                ),
            ),
        };
        ToolSpec {
            name: self.name().into(),
            description: description.into(),
            input_schema: schema,
        }
    }
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type": "object", "properties": properties, "required": required})
}

fn tab_prop() -> Value {
    json!({"type": "string", "description": "Tab id or 1-based index from browser_tabs (default: active tab)."})
}

fn ref_prop() -> Value {
    json!({"type": "string", "description": "Element ref from browser_snapshot, e.g. e12."})
}

fn selector_prop() -> Value {
    json!({"type": "string", "description": "CSS selector (used when no ref)."})
}
