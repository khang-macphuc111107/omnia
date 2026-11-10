//! Harness tools. Model-correctable failures are `ToolOutput::error`; `Err` is
//! reserved for cancellation.

use std::sync::Arc;

use async_trait::async_trait;
use omnia_harness::{
    Block, EffectClass, HarnessError, HarnessResult, Tool, ToolContext, ToolOutput, ToolSpec,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::computer::{render_snapshot, ClickTarget, Computer, ComputerConfig, ShotTarget};
use crate::types::*;
use crate::ComputerError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Windows,
    Snapshot,
    Screenshot,
    Ocr,
    FindText,
    Click,
    Type,
    Key,
    Scroll,
    Drag,
    Act,
    Window,
    Launch,
    Batch,
    BgList,
    BgShot,
    BgClick,
    BgType,
    BgKey,
    BgOcr,
    BgFind,
}

impl Kind {
    const ALL: [Kind; 21] = [
        Kind::Windows,
        Kind::Snapshot,
        Kind::Screenshot,
        Kind::Ocr,
        Kind::FindText,
        Kind::Click,
        Kind::Type,
        Kind::Key,
        Kind::Scroll,
        Kind::Drag,
        Kind::Act,
        Kind::Window,
        Kind::Launch,
        Kind::Batch,
        Kind::BgList,
        Kind::BgShot,
        Kind::BgClick,
        Kind::BgType,
        Kind::BgKey,
        Kind::BgOcr,
        Kind::BgFind,
    ];

    fn name(self) -> &'static str {
        match self {
            Kind::Windows => "computer_windows",
            Kind::Snapshot => "computer_snapshot",
            Kind::Screenshot => "computer_screenshot",
            Kind::Ocr => "computer_ocr",
            Kind::FindText => "computer_find_text",
            Kind::Click => "computer_click",
            Kind::Type => "computer_type",
            Kind::Key => "computer_key",
            Kind::Scroll => "computer_scroll",
            Kind::Drag => "computer_drag",
            Kind::Act => "computer_act",
            Kind::Window => "computer_window",
            Kind::Launch => "computer_launch",
            Kind::Batch => "computer_batch",
            Kind::BgList => "computer_window_list",
            Kind::BgShot => "computer_window_screenshot",
            Kind::BgClick => "computer_window_click",
            Kind::BgType => "computer_window_type",
            Kind::BgKey => "computer_window_key",
            Kind::BgOcr => "computer_window_ocr",
            Kind::BgFind => "computer_window_find_text",
        }
    }

    fn from_short(s: &str) -> Option<Kind> {
        let s = s.trim().trim_start_matches("computer_");
        Some(match s {
            "click" => Kind::Click,
            "type" => Kind::Type,
            "key" => Kind::Key,
            "scroll" => Kind::Scroll,
            "drag" => Kind::Drag,
            "act" => Kind::Act,
            "window" => Kind::Window,
            "launch" => Kind::Launch,
            _ => return None,
        })
    }

    fn effect(self) -> EffectClass {
        match self {
            Kind::Windows
            | Kind::Snapshot
            | Kind::Screenshot
            | Kind::Ocr
            | Kind::FindText
            | Kind::BgList
            | Kind::BgShot
            | Kind::BgOcr
            | Kind::BgFind => EffectClass::ReadWorkspace,
            _ => EffectClass::ComputerControl,
        }
    }
}

const WINDOW_DOC: &str = "Window title substring (case-insensitive), process name, or hwnd (number or \"0x..\"). Omit for the focused window.";

fn hwnd_schema() -> Value {
    json!({"type": "string", "description": "Window handle from computer_window_list (decimal string or 0x.. hex)."})
}

fn spec_for(kind: Kind) -> ToolSpec {
    let window = json!({"type": "string", "description": WINDOW_DOC});
    let monitor = json!({"type": "integer", "description": "Monitor index from computer_windows/computer_screenshot (0 = primary)."});
    let r#ref = json!({"type": "string", "description": "Element ref from the latest computer_snapshot, like w3e17."});
    let xy = |d: &str| json!({"type": "number", "description": d});
    let (description, schema): (&str, Value) = match kind {
        Kind::Windows => (
            "List monitors (bounds, DPI scale) and visible top-level windows (hwnd, title, process, bounds, focused/minimized).",
            json!({"type": "object", "properties": {}}),
        ),
        Kind::Snapshot => (
            "PREFERRED way to see an app: a compact UI Automation tree of a window with element refs (`- Button \"Save\" [ref=w3e17] (x,y,w,h)`). Use refs with computer_click / computer_act / computer_type. Falls back to screenshots only for apps with no accessibility tree (games, canvases).",
            json!({"type": "object", "properties": {
                "window": window,
                "interactive_only": {"type": "boolean", "description": "Only actionable elements (default true). False adds static text and named containers."},
                "max_chars": {"type": "integer", "description": "Output cap in characters (default 30000)."},
                "max_depth": {"type": "integer"},
                "max_nodes": {"type": "integer"}
            }}),
        ),
        Kind::Screenshot => (
            "Screenshot of a monitor or window as an image (long side downscaled to <=1568 px). Coordinates you then give to computer_click/scroll/drag are pixels of THIS image. Use `region` [x,y,w,h] (in the full screenshot's pixel space) to zoom into a part. Prefer computer_snapshot when the app has accessible UI.",
            json!({"type": "object", "properties": {
                "monitor": monitor, "window": window,
                "region": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 4, "description": "[x,y,w,h] sub-region to zoom into."}
            }}),
        ),
        Kind::Ocr => (
            "Read text on screen with the Windows OCR engine (for apps/canvases with no accessible text). Returns recognized lines with bounding boxes `(x,y,w,h)` and centres in the same pixel space as computer_screenshot/computer_click, plus the full text. Read-only. Use `region` [x0,y0,x1,y1] to limit to part of the screen.",
            json!({"type": "object", "properties": {
                "monitor": monitor, "window": window,
                "region": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 4, "description": "[x0,y0,x1,y1] corners in the full screenshot's pixel space."},
                "language": {"type": "string", "description": "BCP-47 tag of an installed OCR language, e.g. en-US, vi, ja. Default: the user profile languages."}
            }}),
        ),
        Kind::FindText => (
            "Find visible text on screen via OCR (case-insensitive substring/phrase) and return matching boxes and centre points you can pass to computer_click as x,y. Use when the target has no accessible ref.",
            json!({"type": "object", "properties": {
                "text": {"type": "string", "description": "Text to look for."},
                "monitor": monitor, "window": window,
                "region": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 4, "description": "[x0,y0,x1,y1] corners in the full screenshot's pixel space."},
                "language": {"type": "string", "description": "BCP-47 OCR language tag (default: user profile languages)."}
            }, "required": ["text"]}),
        ),
        Kind::Click => (
            "Click an element by `ref` (preferred) or at x,y in the last screenshot's pixel space. After the action the active window's fresh interactive tree (or a small screenshot) is returned.",
            json!({"type": "object", "properties": {
                "ref": r#ref, "x": xy("X in screenshot pixels."), "y": xy("Y in screenshot pixels."),
                "monitor": monitor, "window": window,
                "button": {"type": "string", "enum": ["left", "right", "middle"]},
                "double": {"type": "boolean"},
                "modifiers": {"type": "array", "items": {"type": "string", "enum": ["ctrl", "shift", "alt", "win"]}}
            }}),
        ),
        Kind::Type => (
            "Type text into the focused control, or into `ref` (focused first). Unicode, newlines press Enter. For replacing a field's value use computer_act set_value.",
            json!({"type": "object", "properties": {"text": {"type": "string"}, "ref": r#ref}, "required": ["text"]}),
        ),
        Kind::Key => (
            "Press key combos, e.g. \"enter\", \"ctrl+shift+s\", \"alt+f4\", \"win+r\", \"f5\". Space-separate several: \"ctrl+a ctrl+c\".",
            json!({"type": "object", "properties": {"keys": {"type": "string"}}, "required": ["keys"]}),
        ),
        Kind::Scroll => (
            "Scroll the mouse wheel at a ref or x,y (screenshot pixels), or at the cursor if neither is given.",
            json!({"type": "object", "properties": {
                "ref": r#ref, "x": xy("X in screenshot pixels."), "y": xy("Y in screenshot pixels."),
                "monitor": monitor, "window": window,
                "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
                "amount": {"type": "integer", "description": "Wheel notches (default 3)."}
            }, "required": ["direction"]}),
        ),
        Kind::Drag => (
            "Press at `from` [x,y], move smoothly and release at `to` [x,y] (screenshot pixels).",
            json!({"type": "object", "properties": {
                "from": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2},
                "to": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2},
                "monitor": monitor, "window": window,
                "button": {"type": "string", "enum": ["left", "right", "middle"]}
            }, "required": ["from", "to"]}),
        ),
        Kind::Act => (
            "Act on an element through UI Automation patterns (precise, no mouse): invoke (press button/link), set_value (replace text), toggle (checkbox), select (list/tab item), expand, collapse, focus. Falls back to mouse/keyboard when the pattern is missing.",
            json!({"type": "object", "properties": {
                "ref": r#ref,
                "action": {"type": "string", "enum": ["invoke", "set_value", "toggle", "select", "expand", "collapse", "scroll_into_view", "focus"]},
                "value": {"type": "string", "description": "For set_value."}
            }, "required": ["ref", "action"]}),
        ),
        Kind::Window => (
            "Window management: focus (bring to front), minimize, maximize, restore, close, move (rect x,y), resize (rect w,h).",
            json!({"type": "object", "properties": {
                "window": window,
                "action": {"type": "string", "enum": ["focus", "minimize", "maximize", "restore", "close", "move", "resize"]},
                "rect": {"type": "array", "items": {"type": "integer"}, "minItems": 4, "maxItems": 4, "description": "[x,y,w,h] in physical pixels (move uses x,y; resize uses w,h)."}
            }, "required": ["window", "action"]}),
        ),
        Kind::Launch => (
            "Launch an app by Start-menu name (\"Notepad\", \"Visual Studio Code\"), exe on PATH, full path or URI, and wait for its window.",
            json!({"type": "object", "properties": {
                "app": {"type": "string"},
                "args": {"type": "string", "description": "Command-line arguments."}
            }, "required": ["app"]}),
        ),
        Kind::Batch => (
            "Run several actions in order, stopping at the first error; one observation is returned at the end. Each item is {\"tool\": \"click|type|key|scroll|drag|act|window|launch|wait\", ...that tool's arguments} (wait takes `ms`). Refs from a prior snapshot stay valid across steps unless a step changes the UI.",
            json!({"type": "object", "properties": {
                "actions": {"type": "array", "items": {"type": "object", "properties": {"tool": {"type": "string"}}, "required": ["tool"]}}
            }, "required": ["actions"]}),
        ),
        Kind::BgList => (
            "BACKGROUND computer use (does not raise windows or move the user's mouse/keyboard). Lists visible top-level windows with the hwnd STRING to pass to the other computer_window_* tools, title, process, pid, class, rect, client size and flags: minimized, cloaked (DWM: other virtual desktop/hidden), elevated (admin; not operable), own (Omnia; never operated).",
            json!({"type": "object", "properties": {}}),
        ),
        Kind::BgShot => (
            "BACKGROUND screenshot (PNG) of one window's client area by hwnd, via PrintWindow(PW_RENDERFULLCONTENT): works while the window is behind other windows, without focusing it. Coordinates for computer_window_click are pixels of THIS image. Minimized windows cannot be rendered: the call says so; pass restore_without_activate=true to show it again with SW_SHOWNOACTIVATE (Windows still activates a window that leaves the minimized state; Omnia hands focus back when it can, and says so). Limits: GPU/DirectX/game surfaces and some Chromium/UWP windows may come back blank (the tool warns); then use the foreground computer_screenshot. Elevated apps, Omnia's own windows and secure desktop/UAC are refused.",
            json!({"type": "object", "properties": {
                "hwnd": hwnd_schema(),
                "max_width": {"type": "integer", "minimum": 1, "description": "Cap the image width in pixels (never upscales). Click coordinates follow this scaling."},
                "restore_without_activate": {"type": "boolean", "description": "If the window is minimized, show it again with SW_SHOWNOACTIVATE before capturing (changes the window's visible state; focus is handed back to the previous window when possible)."}
            }, "required": ["hwnd"]}),
        ),
        Kind::BgClick => (
            "BACKGROUND click: posts WM_*BUTTON messages to the deepest child window under x,y of a window (hwnd) without foregrounding it or moving the real cursor. x,y are pixels of the latest computer_window_screenshot/ocr of that window (raw client pixels if none yet). Limits: PostMessage input is not honoured by every app - DirectX/OpenGL games and some Chromium/Electron/UWP surfaces ignore synthetic messages, and an app may still activate itself in reaction to a click. If nothing changes, fall back to the foreground tools (computer_window focus, then computer_click). A fresh window screenshot is returned.",
            json!({"type": "object", "properties": {
                "hwnd": hwnd_schema(),
                "x": {"type": "number", "description": "X in window screenshot pixels."},
                "y": {"type": "number", "description": "Y in window screenshot pixels."},
                "button": {"type": "string", "enum": ["left", "right", "middle"]},
                "double": {"type": "boolean"},
                "observe": {"type": "boolean", "description": "Append a window screenshot after the action (default true)."}
            }, "required": ["hwnd", "x", "y"]}),
        ),
        Kind::BgType => (
            "BACKGROUND typing: posts one WM_CHAR per UTF-16 unit to the window's focused child control (found via GetGUIThreadInfo; falls back to the window itself), without focusing the window. Click the target field first with computer_window_click: when the window has no keyboard focus of its own, the last clicked control receives the characters. Newlines send Enter. Limits: PostMessage input is not honoured by every app (DirectX/games, some Chromium/Electron/UWP surfaces ignore it); fall back to the foreground tools (computer_window focus, then computer_type).",
            json!({"type": "object", "properties": {
                "hwnd": hwnd_schema(),
                "text": {"type": "string"},
                "observe": {"type": "boolean", "description": "Append a window screenshot after the action (default true)."}
            }, "required": ["hwnd", "text"]}),
        ),
        Kind::BgKey => (
            "BACKGROUND key press(es) via WM_KEYDOWN/WM_KEYUP with real scan codes to the window's focused child (no foregrounding). `key` like \"Enter\", \"Tab\", \"Ctrl+A\", \"Ctrl+Shift+Home\", \"Alt+F\", space-separated for several. Modifier chords temporarily set the target thread's key state (AttachThreadInput) and are delivered synchronously. The Windows key is not supported. Limits: apps that ignore synthetic messages (DirectX/games, some Chromium/Electron/UWP surfaces) need the foreground computer_key after computer_window focus.",
            json!({"type": "object", "properties": {
                "hwnd": hwnd_schema(),
                "key": {"type": "string"},
                "observe": {"type": "boolean", "description": "Append a window screenshot after the action (default true)."}
            }, "required": ["hwnd", "key"]}),
        ),
        Kind::BgOcr => (
            "BACKGROUND OCR (Windows OCR engine) of one window's client area by hwnd, even when occluded. Returns lines with boxes (x,y,w,h) and centres in window-screenshot pixels - the same space computer_window_click reads. Read-only. Minimized windows need restore_without_activate=true.",
            json!({"type": "object", "properties": {
                "hwnd": hwnd_schema(),
                "max_width": {"type": "integer", "minimum": 1, "description": "Coordinate space width cap (as in computer_window_screenshot)."},
                "language": {"type": "string", "description": "BCP-47 tag of an installed OCR language. Default: user profile languages."},
                "restore_without_activate": {"type": "boolean"}
            }, "required": ["hwnd"]}),
        ),
        Kind::BgFind => (
            "BACKGROUND find visible text in one window (OCR, case-insensitive) by hwnd and return boxes and centres in window-screenshot pixels to pass to computer_window_click. Read-only; works while the window is occluded.",
            json!({"type": "object", "properties": {
                "hwnd": hwnd_schema(),
                "text": {"type": "string"},
                "max_width": {"type": "integer", "minimum": 1},
                "language": {"type": "string"},
                "restore_without_activate": {"type": "boolean"}
            }, "required": ["hwnd", "text"]}),
        ),
    };
    ToolSpec {
        name: kind.name().into(),
        description: description.into(),
        input_schema: schema,
    }
}

// ---------------------------------------------------------------- arguments

#[derive(Deserialize, Default)]
struct Args {
    #[serde(rename = "ref")]
    r: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    monitor: Option<usize>,
    window: Option<Value>,
    button: Option<MouseButton>,
    double: Option<bool>,
    modifiers: Option<Vec<String>>,
    text: Option<String>,
    keys: Option<String>,
    direction: Option<ScrollDir>,
    amount: Option<u32>,
    from: Option<[f64; 2]>,
    to: Option<[f64; 2]>,
    action: Option<String>,
    value: Option<String>,
    rect: Option<[i32; 4]>,
    region: Option<[f64; 4]>,
    language: Option<String>,
    app: Option<String>,
    args: Option<Value>,
    hwnd: Option<Value>,
    max_width: Option<u32>,
    restore_without_activate: Option<bool>,
    observe: Option<bool>,
    key: Option<String>,
    #[allow(dead_code)]
    // accepted for tool-schema compatibility; wait duration is not used by this adapter
    ms: Option<u64>,
}

fn parse<T: serde::de::DeserializeOwned>(input: Value) -> Result<T, ComputerError> {
    serde_json::from_value(input)
        .map_err(|e| ComputerError::Invalid(format!("invalid arguments: {e}")))
}

fn window_sel(v: &Option<Value>) -> Result<Option<WindowSel>, ComputerError> {
    v.as_ref()
        .map(WindowSel::from_json)
        .transpose()
        .map_err(ComputerError::Invalid)
}

fn bg_hwnd(a: &Args) -> Result<isize, ComputerError> {
    let v = a.hwnd.as_ref().ok_or_else(|| {
        ComputerError::Invalid("`hwnd` is required (see computer_window_list)".into())
    })?;
    crate::bg::parse_hwnd(v).map_err(ComputerError::Invalid)
}

fn need<T>(v: Option<T>, what: &str) -> Result<T, ComputerError> {
    v.ok_or_else(|| ComputerError::Invalid(format!("`{what}` is required")))
}

fn point_target(a: &Args) -> Result<Option<ClickTarget>, ComputerError> {
    if let Some(r) = &a.r {
        return Ok(Some(ClickTarget::Ref(r.clone())));
    }
    match (a.x, a.y) {
        (Some(x), Some(y)) => Ok(Some(ClickTarget::Point {
            x,
            y,
            monitor: a.monitor,
            window: window_sel(&a.window)?,
        })),
        (None, None) => Ok(None),
        _ => Err(ComputerError::Invalid("give both `x` and `y`".into())),
    }
}

fn args_string(v: &Option<Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|s| {
                    if s.contains(' ') {
                        format!("\"{s}\"")
                    } else {
                        s.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    }
}

fn parse_element_action(s: &str) -> Result<ElementAction, ComputerError> {
    serde_json::from_value(Value::String(s.to_string()))
        .map_err(|_| ComputerError::Invalid(format!("unknown action \"{s}\"")))
}

fn parse_window_action(s: &str) -> Result<WindowAction, ComputerError> {
    serde_json::from_value(Value::String(s.to_string()))
        .map_err(|_| ComputerError::Invalid(format!("unknown window action \"{s}\"")))
}

/// Run one state-changing action; returns a short result line.
async fn run_action(c: &Computer, kind: Kind, input: Value) -> Result<String, ComputerError> {
    let a: Args = parse(input)?;
    match kind {
        Kind::Click => {
            let target = point_target(&a)?
                .ok_or_else(|| ComputerError::Invalid("give `ref` or `x`,`y`".into()))?;
            let count = if a.double.unwrap_or(false) { 2 } else { 1 };
            c.click(
                &target,
                a.button.unwrap_or_default(),
                count,
                &a.modifiers.clone().unwrap_or_default(),
            )
            .await
        }
        Kind::Type => c.type_text(&need(a.text, "text")?, a.r.as_deref()).await,
        Kind::Key => c.press_keys(&need(a.keys, "keys")?).await,
        Kind::Scroll => {
            let target = point_target(&a)?;
            c.scroll(
                target.as_ref(),
                need(a.direction, "direction")?,
                a.amount.unwrap_or(3),
            )
            .await
        }
        Kind::Drag => {
            let (f, t) = (need(a.from, "from")?, need(a.to, "to")?);
            c.drag(
                (f[0], f[1]),
                (t[0], t[1]),
                a.monitor,
                window_sel(&a.window)?.as_ref(),
                a.button.unwrap_or_default(),
            )
            .await
        }
        Kind::Act => {
            let action = parse_element_action(&need(a.action, "action")?)?;
            c.act(&need(a.r, "ref")?, action, a.value.as_deref()).await
        }
        Kind::Window => {
            let sel = window_sel(&a.window)?
                .ok_or_else(|| ComputerError::Invalid("`window` is required".into()))?;
            let action = parse_window_action(&need(a.action, "action")?)?;
            c.window_op(
                &sel,
                action,
                a.rect.map(|r| Rect::new(r[0], r[1], r[2], r[3])),
            )
            .await
        }
        Kind::Launch => {
            c.launch(&need(a.app, "app")?, args_string(&a.args).as_deref())
                .await
        }
        _ => Err(ComputerError::Invalid("not an action".into())),
    }
}

// -------------------------------------------------------------------- tools

pub struct ComputerTool {
    computer: Computer,
    kind: Kind,
}

fn err_output(e: ComputerError) -> ToolOutput {
    ToolOutput::error(e.to_string())
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        format!("{}...", s.chars().take(n).collect::<String>())
    } else {
        s.to_string()
    }
}

impl ComputerTool {
    async fn read_only(&self, input: Value) -> Result<ToolOutput, ComputerError> {
        let c = &self.computer;
        match self.kind {
            Kind::Windows => {
                let ms = c.monitors().await?;
                let ws = c.windows().await?;
                let mut out = String::from("Monitors (physical pixels):\n");
                for m in &ms {
                    out.push_str(&format!(
                        "- [{}] {} {}x{} at ({},{}) scale {:.2} ({} dpi){}\n",
                        m.index,
                        m.name,
                        m.bounds.w,
                        m.bounds.h,
                        m.bounds.x,
                        m.bounds.y,
                        m.scale,
                        m.dpi,
                        if m.primary { " primary" } else { "" }
                    ));
                }
                out.push_str("Windows (top of z-order first):\n");
                for w in &ws {
                    out.push_str(&format!(
                        "- hwnd={} \"{}\" [{}, pid {}] class={} ({},{},{},{}){}{}\n",
                        w.hwnd,
                        clip(&w.title, 100),
                        w.process,
                        w.pid,
                        w.class,
                        w.bounds.x,
                        w.bounds.y,
                        w.bounds.w,
                        w.bounds.h,
                        if w.focused { " focused" } else { "" },
                        if w.minimized { " minimized" } else { "" }
                    ));
                }
                Ok(ToolOutput::text(out))
            }
            Kind::Snapshot => {
                let a: Value = input;
                let sel = a
                    .get("window")
                    .map(WindowSel::from_json)
                    .transpose()
                    .map_err(ComputerError::Invalid)?;
                let mut opts = c.config().snapshot.clone();
                if let Some(v) = a.get("interactive_only").and_then(Value::as_bool) {
                    opts.interactive_only = v;
                }
                if let Some(v) = a.get("max_chars").and_then(Value::as_u64) {
                    opts.max_chars = (v as usize).clamp(500, 200_000);
                }
                if let Some(v) = a.get("max_depth").and_then(Value::as_u64) {
                    opts.max_depth = (v as usize).clamp(1, 40);
                }
                if let Some(v) = a.get("max_nodes").and_then(Value::as_u64) {
                    opts.max_nodes = (v as usize).clamp(1, 20_000);
                }
                let snap = c.snapshot(sel.as_ref(), opts).await?;
                Ok(ToolOutput::text(render_snapshot(&snap)))
            }
            Kind::Screenshot => {
                let a: Args = parse(input)?;
                let target = match window_sel(&a.window)? {
                    Some(w) => ShotTarget::Window(w),
                    None => ShotTarget::Monitor(a.monitor),
                };
                let shot = c.screenshot(target, a.region).await?;
                Ok(ToolOutput {
                    content: shot.to_blocks(),
                    is_error: false,
                })
            }
            Kind::Ocr | Kind::FindText => {
                let a: Args = parse(input)?;
                let needle = if self.kind == Kind::FindText {
                    let t = need(a.text.clone(), "text")?;
                    if t.trim().is_empty() {
                        return Err(ComputerError::Invalid("`text` must not be empty".into()));
                    }
                    Some(t)
                } else {
                    None
                };
                let target = match window_sel(&a.window)? {
                    Some(w) => ShotTarget::Window(w),
                    None => ShotTarget::Monitor(a.monitor),
                };
                let out = c.ocr(target, a.region, a.language).await?;
                let text = match needle {
                    Some(n) => {
                        let m = crate::ocr::find_matches(&out.lines, &n);
                        crate::ocr::format_matches(&out.label, &n, &m, &out.map, 50)
                    }
                    None => crate::ocr::format_ocr(&out.label, &out.lines, &out.map, 300, 20_000),
                };
                Ok(ToolOutput::text(text))
            }
            Kind::BgList => Ok(ToolOutput::text(c.bg_windows_text().await?)),
            Kind::BgShot => {
                let a: Args = parse(input)?;
                let hwnd = bg_hwnd(&a)?;
                let shot = c
                    .bg_screenshot(
                        hwnd,
                        a.max_width,
                        a.restore_without_activate.unwrap_or(false),
                    )
                    .await?;
                Ok(ToolOutput {
                    content: shot.to_blocks(),
                    is_error: false,
                })
            }
            Kind::BgOcr | Kind::BgFind => {
                let a: Args = parse(input)?;
                let hwnd = bg_hwnd(&a)?;
                let needle = if self.kind == Kind::BgFind {
                    let t = need(a.text.clone(), "text")?;
                    if t.trim().is_empty() {
                        return Err(ComputerError::Invalid("`text` must not be empty".into()));
                    }
                    Some(t)
                } else {
                    None
                };
                let out = c
                    .bg_ocr(
                        hwnd,
                        a.max_width,
                        a.language,
                        a.restore_without_activate.unwrap_or(false),
                    )
                    .await?;
                let mut text = match needle {
                    Some(n) => {
                        let m = crate::ocr::find_matches(&out.lines, &n);
                        crate::ocr::format_matches(&out.label, &n, &m, &out.map, 50)
                    }
                    None => crate::ocr::format_ocr(&out.label, &out.lines, &out.map, 300, 20_000),
                }
                .replace("computer_click", "computer_window_click");
                if out.blank {
                    text.push_str("\nWARNING: the capture is a single flat colour (GPU surface PrintWindow cannot read); use the foreground computer_ocr.");
                }
                Ok(ToolOutput::text(text))
            }
            _ => Err(ComputerError::Invalid("not a read-only tool".into())),
        }
    }
}

#[async_trait]
impl Tool for ComputerTool {
    fn spec(&self) -> ToolSpec {
        spec_for(self.kind)
    }

    fn effect(&self) -> EffectClass {
        self.kind.effect()
    }

    fn describe(&self, input: &Value) -> String {
        let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
        match self.kind {
            Kind::Windows => "List windows and monitors".into(),
            Kind::Snapshot => format!(
                "Read UI tree of {}",
                if input.get("window").is_some() {
                    s("window").to_string()
                } else {
                    "the focused window".into()
                }
            ),
            Kind::Screenshot => "Take a screenshot".into(),
            Kind::Ocr => "Read text on screen (OCR)".into(),
            Kind::FindText => format!("Find text \"{}\" on screen", clip(s("text"), 60)),
            Kind::Click => match input.get("ref").and_then(Value::as_str) {
                Some(r) => format!("Click element {r}"),
                None => format!(
                    "Click at ({}, {})",
                    input.get("x").unwrap_or(&Value::Null),
                    input.get("y").unwrap_or(&Value::Null)
                ),
            },
            Kind::Type => format!("Type \"{}\"", clip(s("text"), 60)),
            Kind::Key => format!("Press {}", s("keys")),
            Kind::Scroll => format!("Scroll {}", s("direction")),
            Kind::Drag => "Drag with the mouse".into(),
            Kind::Act => format!("{} on {}", s("action"), s("ref")),
            Kind::Window => format!("{} window {}", s("action"), s("window")),
            Kind::Launch => format!("Launch {}", s("app")),
            Kind::BgList => "List windows for background control".into(),
            Kind::BgShot => format!("Background screenshot of window {}", s("hwnd")),
            Kind::BgClick => format!(
                "Background click in window {} at ({}, {})",
                s("hwnd"),
                input.get("x").unwrap_or(&Value::Null),
                input.get("y").unwrap_or(&Value::Null)
            ),
            Kind::BgType => format!(
                "Background type \"{}\" into window {}",
                clip(s("text"), 60),
                s("hwnd")
            ),
            Kind::BgKey => format!("Background press {} in window {}", s("key"), s("hwnd")),
            Kind::BgOcr => format!("Read text of window {} (OCR)", s("hwnd")),
            Kind::BgFind => format!(
                "Find text \"{}\" in window {}",
                clip(s("text"), 60),
                s("hwnd")
            ),
            Kind::Batch => format!(
                "Run {} computer actions",
                input
                    .get("actions")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len)
            ),
        }
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        if ctx.cancel.is_cancelled() {
            return Err(HarnessError::Cancelled);
        }
        Ok(self.dispatch(ctx, input).await.unwrap_or_else(err_output))
    }
}

impl ComputerTool {
    async fn dispatch(&self, ctx: &ToolContext, input: Value) -> Result<ToolOutput, ComputerError> {
        let c = &self.computer;
        match self.kind {
            Kind::Windows
            | Kind::Snapshot
            | Kind::Screenshot
            | Kind::Ocr
            | Kind::FindText
            | Kind::BgList
            | Kind::BgShot
            | Kind::BgOcr
            | Kind::BgFind => self.read_only(input).await,
            Kind::BgClick | Kind::BgType | Kind::BgKey => {
                let a: Args = parse(input)?;
                let hwnd = bg_hwnd(&a)?;
                let mut msg = match self.kind {
                    Kind::BgClick => {
                        let (x, y) = (need(a.x, "x")?, need(a.y, "y")?);
                        c.bg_click(
                            hwnd,
                            x,
                            y,
                            a.button.unwrap_or_default(),
                            a.double.unwrap_or(false),
                        )
                        .await?
                    }
                    Kind::BgType => c.bg_type(hwnd, &need(a.text, "text")?).await?,
                    _ => c.bg_key(hwnd, &need(a.key, "key")?).await?,
                };
                msg.push_str(". Delivery is not confirmed by Windows; check the result below. ");
                msg.push_str(crate::bg::LIMITS_NOTE);
                let mut content = vec![Block::text(msg)];
                if a.observe.unwrap_or(true) {
                    content.extend(c.bg_observe(hwnd).await);
                }
                Ok(ToolOutput {
                    content,
                    is_error: false,
                })
            }
            Kind::Batch => {
                let items = input
                    .get("actions")
                    .and_then(Value::as_array)
                    .filter(|a| !a.is_empty())
                    .ok_or_else(|| {
                        ComputerError::Invalid("`actions` must be a non-empty array".into())
                    })?
                    .clone();
                let mut log = Vec::new();
                let mut failed = None;
                for (i, item) in items.iter().enumerate() {
                    if ctx.cancel.is_cancelled() {
                        failed = Some("cancelled".to_string());
                        break;
                    }
                    let name = item
                        .get("tool")
                        .or_else(|| item.get("action_type"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let res = if name.trim_start_matches("computer_") == "wait" {
                        let ms = item
                            .get("ms")
                            .and_then(Value::as_u64)
                            .unwrap_or(500)
                            .min(10_000);
                        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                        Ok(format!("waited {ms} ms"))
                    } else {
                        match Kind::from_short(name) {
                            Some(k) => run_action(c, k, item.clone()).await,
                            None => Err(ComputerError::Invalid(format!(
                                "unknown batch tool \"{name}\""
                            ))),
                        }
                    };
                    match res {
                        Ok(msg) => log.push(format!("{}. {name}: {msg}", i + 1)),
                        Err(e) => {
                            log.push(format!("{}. {name}: ERROR {e}", i + 1));
                            failed = Some(format!(
                                "step {} failed; remaining steps were not run",
                                i + 1
                            ));
                            break;
                        }
                    }
                }
                if let Some(f) = &failed {
                    log.push(f.clone());
                }
                let mut content = vec![Block::text(log.join("\n"))];
                content.extend(c.observe().await);
                Ok(ToolOutput {
                    content,
                    is_error: failed.is_some(),
                })
            }
            kind => {
                let msg = run_action(c, kind, input).await?;
                let mut content = vec![Block::text(msg)];
                content.extend(c.observe().await);
                Ok(ToolOutput {
                    content,
                    is_error: false,
                })
            }
        }
    }
}

/// All computer-use tools, sharing one worker thread, policy and kill switch.
pub fn computer_tools(config: ComputerConfig) -> Vec<Arc<dyn Tool>> {
    computer_tools_for(Computer::new(config))
}

/// Same, over an existing handle (to keep a reference to the kill switch or policy).
pub fn computer_tools_for(computer: Computer) -> Vec<Arc<dyn Tool>> {
    Kind::ALL
        .iter()
        .map(|&kind| {
            Arc::new(ComputerTool {
                computer: computer.clone(),
                kind,
            }) as Arc<dyn Tool>
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_tools_are_registered_with_matching_effects() {
        let tools = computer_tools(ComputerConfig::default());
        let mut names: Vec<String> = tools.iter().map(|t| t.spec().name).collect();
        let total = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), total, "tool names are unique");
        for (name, effect, required) in [
            ("computer_window_list", EffectClass::ReadWorkspace, vec![]),
            (
                "computer_window_screenshot",
                EffectClass::ReadWorkspace,
                vec!["hwnd"],
            ),
            (
                "computer_window_ocr",
                EffectClass::ReadWorkspace,
                vec!["hwnd"],
            ),
            (
                "computer_window_find_text",
                EffectClass::ReadWorkspace,
                vec!["hwnd", "text"],
            ),
            (
                "computer_window_click",
                EffectClass::ComputerControl,
                vec!["hwnd", "x", "y"],
            ),
            (
                "computer_window_type",
                EffectClass::ComputerControl,
                vec!["hwnd", "text"],
            ),
            (
                "computer_window_key",
                EffectClass::ComputerControl,
                vec!["hwnd", "key"],
            ),
        ] {
            let t = tools
                .iter()
                .find(|t| t.spec().name == name)
                .unwrap_or_else(|| panic!("{name} missing"));
            assert_eq!(t.effect(), effect, "{name}");
            let spec = t.spec();
            let req: Vec<String> = spec
                .input_schema
                .get("required")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            assert_eq!(req, required, "{name}");
        }
        // The foreground tool names stay untouched.
        assert!(names.contains(&"computer_windows".to_string()));
        assert!(names.contains(&"computer_window".to_string()));
    }

    #[test]
    fn input_tools_document_the_postmessage_limit() {
        for t in computer_tools(ComputerConfig::default()) {
            let spec = t.spec();
            if [
                "computer_window_click",
                "computer_window_type",
                "computer_window_key",
            ]
            .contains(&spec.name.as_str())
            {
                assert!(spec.description.contains("DirectX"), "{}", spec.name);
                assert!(spec.description.contains("foreground"), "{}", spec.name);
            }
        }
    }
}
