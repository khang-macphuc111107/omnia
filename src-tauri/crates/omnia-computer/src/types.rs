//! Plain data types shared by every module (no platform dependencies).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }

    pub fn from_ltrb(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self::new(left, top, right - left, bottom - top)
    }

    pub fn right(&self) -> i32 {
        self.x + self.w
    }

    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }

    pub fn center(&self) -> (i32, i32) {
        (self.x + self.w / 2, self.y + self.h / 2)
    }

    pub fn is_empty(&self) -> bool {
        self.w <= 0 || self.h <= 0
    }

    pub fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && py >= self.y && px < self.right() && py < self.bottom()
    }

    pub fn union(&self, other: &Rect) -> Rect {
        let l = self.x.min(other.x);
        let t = self.y.min(other.y);
        Rect::from_ltrb(
            l,
            t,
            self.right().max(other.right()),
            self.bottom().max(other.bottom()),
        )
    }

    pub fn intersect(&self, other: &Rect) -> Option<Rect> {
        let l = self.x.max(other.x);
        let t = self.y.max(other.y);
        let r = self.right().min(other.right());
        let b = self.bottom().min(other.bottom());
        (r > l && b > t).then(|| Rect::from_ltrb(l, t, r, b))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    /// Physical pixels in virtual-screen coordinates (may have a negative origin).
    pub bounds: Rect,
    pub work_area: Rect,
    pub dpi: u32,
    /// `dpi / 96`.
    pub scale: f64,
    pub primary: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowInfo {
    pub hwnd: isize,
    pub title: String,
    pub process: String,
    pub pid: u32,
    pub class: String,
    pub bounds: Rect,
    pub minimized: bool,
    pub focused: bool,
}

/// Tightly packed RGB8 pixels captured from the screen.
#[derive(Debug, Clone)]
pub struct RawImage {
    /// Virtual-screen position of pixel (0,0).
    pub origin: (i32, i32),
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDir {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowAction {
    Focus,
    Minimize,
    Maximize,
    Restore,
    Close,
    Move,
    Resize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ElementAction {
    Invoke,
    SetValue,
    Toggle,
    Select,
    Expand,
    Collapse,
    ScrollIntoView,
    Focus,
}

/// How a window is addressed by the model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowSel {
    Focused,
    Hwnd(isize),
    /// Case-insensitive substring of the title or process name.
    Title(String),
}

impl WindowSel {
    /// Accepts a JSON number (hwnd), `"0x1234"` (hwnd) or any other string (title).
    pub fn from_json(value: &serde_json::Value) -> Result<Self, String> {
        match value {
            serde_json::Value::Number(n) => n
                .as_i64()
                .map(|v| WindowSel::Hwnd(v as isize))
                .ok_or_else(|| "window handle must be an integer".to_string()),
            serde_json::Value::String(s) => {
                let s = s.trim();
                if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                    if let Ok(v) = isize::from_str_radix(hex, 16) {
                        return Ok(WindowSel::Hwnd(v));
                    }
                }
                if s.is_empty() {
                    Ok(WindowSel::Focused)
                } else {
                    Ok(WindowSel::Title(s.to_string()))
                }
            }
            _ => Err("window must be a title substring or a numeric hwnd".into()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SnapshotOptions {
    pub interactive_only: bool,
    pub max_depth: usize,
    pub max_nodes: usize,
    pub max_chars: usize,
}

impl Default for SnapshotOptions {
    fn default() -> Self {
        Self {
            interactive_only: true,
            max_depth: 14,
            max_nodes: 1500,
            max_chars: 30_000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub window: WindowInfo,
    pub text: String,
    pub node_count: usize,
    pub ref_count: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct InputTiming {
    /// Delay between key events / typed characters.
    pub key_delay_ms: u64,
    /// Delay between mouse down/up and between click repeats.
    pub click_delay_ms: u64,
    /// Interpolation steps for a smooth move (0 = teleport).
    pub move_steps: u32,
    pub move_step_ms: u64,
}

impl Default for InputTiming {
    fn default() -> Self {
        Self {
            key_delay_ms: 4,
            click_delay_ms: 30,
            move_steps: 12,
            move_step_ms: 4,
        }
    }
}

#[derive(Debug, Clone)]
pub struct LaunchResult {
    pub resolved: String,
    pub pid: Option<u32>,
    pub window: Option<WindowInfo>,
}
