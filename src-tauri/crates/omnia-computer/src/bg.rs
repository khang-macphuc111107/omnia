//! Background (non-foreground) window control: platform independent parts.
//!
//! The tools in this family address one top-level window by handle and use
//! window messages (`PostMessage`) and `PrintWindow`, so they neither raise the
//! window nor move the user's cursor. Everything here is pure (coordinate
//! scaling, `lParam` packing, key planning, refusal rules) and unit tested; the
//! Win32 calls live in `bgwin.rs`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::geometry::{downscale_dims, ImageMap};
use crate::keys::{KeyChord, KeyStep, VK_CONTROL, VK_LWIN, VK_MENU, VK_SHIFT};
use crate::types::{MouseButton, RawImage, Rect};

// Window message numbers (kept here so the pure logic is testable everywhere).
pub const WM_KEYDOWN: u32 = 0x0100;
pub const WM_KEYUP: u32 = 0x0101;
pub const WM_CHAR: u32 = 0x0102;
pub const WM_SYSKEYDOWN: u32 = 0x0104;
pub const WM_SYSKEYUP: u32 = 0x0105;
pub const WM_SYSCHAR: u32 = 0x0106;
pub const WM_MOUSEMOVE: u32 = 0x0200;
pub const WM_LBUTTONDOWN: u32 = 0x0201;
pub const WM_LBUTTONUP: u32 = 0x0202;
pub const WM_LBUTTONDBLCLK: u32 = 0x0203;
pub const WM_RBUTTONDOWN: u32 = 0x0204;
pub const WM_RBUTTONUP: u32 = 0x0205;
pub const WM_RBUTTONDBLCLK: u32 = 0x0206;
pub const WM_MBUTTONDOWN: u32 = 0x0207;
pub const WM_MBUTTONUP: u32 = 0x0208;
pub const WM_MBUTTONDBLCLK: u32 = 0x0209;
pub const MK_LBUTTON: usize = 0x0001;
pub const MK_RBUTTON: usize = 0x0002;
pub const MK_MBUTTON: usize = 0x0010;

/// Longest text accepted by `computer_window_type` (UTF-16 units).
pub const MAX_TYPE_UNITS: usize = 20_000;

/// A top-level window as seen by the background tools.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BgWindow {
    pub hwnd: isize,
    pub title: String,
    pub process: String,
    pub pid: u32,
    pub class: String,
    /// Visible frame in physical screen pixels.
    pub bounds: Rect,
    /// Client-area size in physical pixels (what the screenshot shows).
    pub client_w: i32,
    pub client_h: i32,
    pub minimized: bool,
    pub visible: bool,
    /// DWM cloaked (other virtual desktop, suspended UWP...).
    pub cloaked: bool,
    /// The hwnd's top-level root; differs from `hwnd` for child windows.
    pub root: isize,
    /// `Some(true)` elevated, `Some(false)` not, `None` could not be determined.
    pub elevated: Option<bool>,
    /// Target is (or may be) more privileged than this process: UIPI would drop
    /// our messages silently.
    pub uipi_blocked: bool,
    /// One of this app's own windows (filled in by the caller).
    pub own: bool,
}

/// Identity of the host process, whose windows must never be driven.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnProcess {
    pub pid: u32,
    pub exe: String,
}

impl OwnProcess {
    pub fn current() -> Self {
        let exe = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_default();
        Self {
            pid: std::process::id(),
            exe,
        }
    }

    /// Matches nothing (tests that drive windows of their own process).
    #[cfg(test)]
    pub fn none() -> Self {
        Self {
            pid: 0,
            exe: String::new(),
        }
    }

    pub fn matches(&self, pid: u32, process: &str) -> bool {
        (self.pid != 0 && pid == self.pid)
            || (!self.exe.is_empty()
                && !process.is_empty()
                && process.eq_ignore_ascii_case(&self.exe))
    }
}

/// Why a window must not be operated in the background, if it must not.
pub fn refuse_reason(w: &BgWindow) -> Option<String> {
    if w.root != 0 && w.root != w.hwnd {
        return Some(format!(
            "hwnd {} is a child window; use its top-level window {} (see computer_window_list)",
            w.hwnd, w.root
        ));
    }
    if w.own {
        return Some("that is one of Omnia's own windows; the agent never operates them".into());
    }
    let proc = w.process.to_ascii_lowercase();
    if w.class.starts_with("$$$Secure UAP")
        || matches!(
            proc.as_str(),
            "winlogon.exe" | "logonui.exe" | "consent.exe"
        )
    {
        return Some(
            "secure-desktop / UAC / sign-in surfaces are never operated; ask the user to handle it"
                .into(),
        );
    }
    if w.uipi_blocked {
        return Some(format!(
            "`{}` runs with higher privileges (elevated or protected) than Omnia; Windows (UIPI) silently drops synthetic window messages and blocks capture of it. Ask the user to act on it directly.",
            if w.process.is_empty() { "the target process" } else { &w.process }
        ));
    }
    None
}

/// Parse a window handle given as a JSON number, decimal string or `"0x.."`.
pub fn parse_hwnd(v: &Value) -> Result<isize, String> {
    let bad = || {
        "`hwnd` must be the handle from computer_window_list (decimal string or 0x.. hex)"
            .to_string()
    };
    match v {
        Value::Number(n) => n.as_i64().map(|x| x as isize).ok_or_else(bad),
        Value::String(s) => {
            let s = s.trim();
            let parsed = match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                Some(hex) => i64::from_str_radix(hex, 16),
                None => s.parse::<i64>(),
            };
            parsed.map(|x| x as isize).map_err(|_| bad())
        }
        _ => Err(bad()),
    }
}

// ------------------------------------------------------------ coordinates

/// Mapping between window screenshot pixels and client-area pixels (origin 0,0).
/// `max_width` caps the image width; the crate-wide long-side cap also applies.
pub fn window_shot_map(
    client_w: i32,
    client_h: i32,
    max_width: Option<u32>,
    max_side: u32,
) -> ImageMap {
    let (w, h) = (client_w.max(1) as u32, client_h.max(1) as u32);
    let (mut iw, mut ih) = (w, h);
    if let Some(mw) = max_width.filter(|m| *m > 0) {
        if w > mw {
            iw = mw;
            ih = ((h as f64 * mw as f64 / w as f64).round() as u32).max(1);
        }
    }
    let (iw, ih) = downscale_dims(iw, ih, max_side);
    ImageMap {
        origin: (0, 0),
        src_w: w,
        src_h: h,
        img_w: iw,
        img_h: ih,
    }
}

/// Screenshot-space point -> client-area pixel, validated against the map.
pub fn image_to_client(map: &ImageMap, x: f64, y: f64) -> Result<(i32, i32), String> {
    if !x.is_finite() || !y.is_finite() || !map.contains(x, y) {
        return Err(format!(
            "({x},{y}) is outside the window screenshot ({}x{}); coordinates are pixels of the latest computer_window_screenshot/ocr of this window",
            map.img_w, map.img_h
        ));
    }
    let (cx, cy) = map.to_physical(x, y);
    Ok((
        cx.clamp(0, map.src_w as i32 - 1),
        cy.clamp(0, map.src_h as i32 - 1),
    ))
}

/// Downscale RGB pixels to the map's image size (identity when equal).
pub fn scale_to_map(raw: &RawImage, map: &ImageMap) -> RawImage {
    let rgb = crate::encode::resize_rgb(&raw.rgb, raw.width, raw.height, map.img_w, map.img_h);
    RawImage {
        origin: raw.origin,
        width: map.img_w,
        height: map.img_h,
        rgb,
    }
}

/// True when every sampled pixel equals the first (a failed/blank PrintWindow).
pub fn is_uniform(raw: &RawImage) -> bool {
    let n = raw.rgb.len() / 3;
    if n == 0 {
        return true;
    }
    let first = &raw.rgb[0..3];
    let step = (n / 4096).max(1);
    (0..n)
        .step_by(step)
        .all(|i| &raw.rgb[i * 3..i * 3 + 3] == first)
}

// ---------------------------------------------------------------- lParams

/// `MAKELPARAM(x, y)` for mouse messages (signed 16-bit client coordinates).
pub fn make_lparam(x: i32, y: i32) -> isize {
    (((y as i16 as u16 as u32) << 16) | (x as i16 as u16 as u32)) as isize
}

/// Inverse of [`make_lparam`] (sign-extending).
pub fn split_lparam(lp: isize) -> (i32, i32) {
    let v = lp as u32;
    (
        (v & 0xFFFF) as u16 as i16 as i32,
        (v >> 16) as u16 as i16 as i32,
    )
}

/// `(message, wParam)` posted for one click: move, down/up (and for a double
/// click the second down arrives as a DBLCLK message, like real input).
pub fn mouse_sequence(button: MouseButton, double: bool) -> Vec<(u32, usize)> {
    let (down, up, dbl, mk) = match button {
        MouseButton::Left => (WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK, MK_LBUTTON),
        MouseButton::Right => (WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK, MK_RBUTTON),
        MouseButton::Middle => (WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MBUTTONDBLCLK, MK_MBUTTON),
    };
    let mut seq = vec![(WM_MOUSEMOVE, 0), (down, mk), (up, 0)];
    if double {
        seq.push((dbl, mk));
        seq.push((up, 0));
    }
    seq
}

/// `lParam` of WM_KEYDOWN/KEYUP/SYSKEY*: repeat 1, scan code, extended bit,
/// context (alt) bit, previous-state and transition bits.
pub fn key_lparam(scan: u32, extended: bool, alt: bool, up: bool) -> isize {
    let mut l: u32 = 1 | ((scan & 0xFF) << 16);
    if extended {
        l |= 1 << 24;
    }
    if alt {
        l |= 1 << 29;
    }
    if up {
        l |= (1 << 30) | (1 << 31);
    }
    l as isize
}

/// US-layout scan code for a virtual key; used when `MapVirtualKey` has none.
pub fn scan_fallback(vk: u16) -> u32 {
    const ROW1: &[u8] = b"QWERTYUIOP";
    const ROW2: &[u8] = b"ASDFGHJKL";
    const ROW3: &[u8] = b"ZXCVBNM";
    match vk {
        0x41..=0x5A => {
            let c = vk as u8;
            if let Some(i) = ROW1.iter().position(|&b| b == c) {
                0x10 + i as u32
            } else if let Some(i) = ROW2.iter().position(|&b| b == c) {
                0x1E + i as u32
            } else {
                ROW3.iter()
                    .position(|&b| b == c)
                    .map_or(0, |i| 0x2C + i as u32)
            }
        }
        0x31..=0x39 => 0x02 + (vk as u32 - 0x31),
        0x30 => 0x0B,
        0x1B => 0x01,
        0x08 => 0x0E,
        0x09 => 0x0F,
        0x0D => 0x1C,
        0x11 => 0x1D,
        0x10 => 0x2A,
        0x12 => 0x38,
        0x20 => 0x39,
        0x14 => 0x3A,
        0x70..=0x79 => 0x3B + (vk as u32 - 0x70),
        0x7A => 0x57,
        0x7B => 0x58,
        0x24 => 0x47,
        0x26 => 0x48,
        0x21 => 0x49,
        0x25 => 0x4B,
        0x27 => 0x4D,
        0x23 => 0x4F,
        0x28 => 0x50,
        0x22 => 0x51,
        0x2D => 0x52,
        0x2E => 0x53,
        0x5B => 0x5B,
        0xBA => 0x27,
        0xBB => 0x0D,
        0xBC => 0x33,
        0xBD => 0x0C,
        0xBE => 0x34,
        0xBF => 0x35,
        0xC0 => 0x29,
        0xDB => 0x1A,
        0xDC => 0x2B,
        0xDD => 0x1B,
        0xDE => 0x28,
        _ => 0,
    }
}

// ------------------------------------------------------------------- text

/// Text -> WM_CHAR payloads: UTF-16 code units (surrogate pairs stay as two
/// consecutive units), every newline form becomes a single Enter (`\r`).
pub fn text_to_chars(text: &str) -> Vec<u16> {
    let mut out = Vec::new();
    let mut prev_cr = false;
    for u in text.encode_utf16() {
        match u {
            0x0D => {
                out.push(0x0D);
                prev_cr = true;
                continue;
            }
            0x0A => {
                if !prev_cr {
                    out.push(0x0D);
                }
            }
            _ => out.push(u),
        }
        prev_cr = false;
    }
    out
}

// ------------------------------------------------------------------- keys

/// How one chord is delivered. Chords without modifiers are simply posted (the
/// target's own message loop translates them to characters). Chords with
/// modifiers need the target thread's key state to show the modifier, and the
/// character message that TranslateMessage would have produced is added.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyPlan {
    pub mods: Vec<KeyStep>,
    pub key: KeyStep,
    /// Alt is held: SYSKEY* messages and the context bit.
    pub sys: bool,
    /// Character message to send between key down and up (with modifiers only).
    pub chr: Option<u16>,
}

impl KeyPlan {
    pub fn needs_state(&self) -> bool {
        !self.mods.is_empty()
    }
}

pub fn plan_chord(c: &KeyChord) -> Result<KeyPlan, String> {
    if c.modifiers
        .iter()
        .chain(std::iter::once(&c.key))
        .any(|k| k.vk == VK_LWIN)
    {
        return Err("the Windows key cannot be sent to a background window; use the foreground computer_key tool".into());
    }
    let has = |vk: u16| c.modifiers.iter().any(|m| m.vk == vk);
    let (ctrl, alt, shift) = (has(VK_CONTROL), has(VK_MENU), has(VK_SHIFT));
    let letter = (0x41..=0x5A).contains(&c.key.vk).then_some(c.key.vk as u8);
    let chr = match letter {
        Some(l) if ctrl && !alt => Some((l - 0x40) as u16),
        Some(l) if alt && !ctrl => Some(l.to_ascii_lowercase() as u16),
        Some(l) if shift && !ctrl && !alt => Some(l as u16),
        _ => None,
    };
    Ok(KeyPlan {
        mods: c.modifiers.clone(),
        key: c.key,
        sys: alt || c.key.vk == 0x79,
        chr,
    })
}

/// 256-byte keyboard state with the chord's modifiers held (generic and
/// left-hand variants, the way GetKeyState reads them).
pub fn modifier_state(base: &[u8; 256], mods: &[KeyStep]) -> [u8; 256] {
    let mut s = *base;
    for m in mods {
        s[m.vk as usize] |= 0x80;
        match m.vk {
            VK_CONTROL => s[0xA2] |= 0x80,
            VK_SHIFT => s[0xA0] |= 0x80,
            VK_MENU => s[0xA4] |= 0x80,
            _ => {}
        }
    }
    s
}

// ------------------------------------------------------------- formatting

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        format!("{}...", s.chars().take(n).collect::<String>())
    } else {
        s.to_string()
    }
}

pub fn format_windows(list: &[BgWindow]) -> String {
    if list.is_empty() {
        return "No visible top-level windows.".into();
    }
    let mut out = String::from(
        "Top-level windows (z-order, top first). Use the quoted hwnd with computer_window_* tools. Flags: minimized (cannot be captured until restore_without_activate), cloaked (other virtual desktop / hidden), elevated (admin - not operable), own (Omnia - never operated).\n",
    );
    for w in list {
        let mut flags = Vec::new();
        if w.minimized {
            flags.push("minimized");
        }
        if w.cloaked {
            flags.push("cloaked");
        }
        match w.elevated {
            Some(true) => flags.push("elevated"),
            None => flags.push("elevation-unknown"),
            Some(false) => {}
        }
        if w.own {
            flags.push("own");
        }
        out.push_str(&format!(
            "- hwnd=\"{}\" \"{}\" [{}, pid {}] class={} rect=({},{},{},{}) client={}x{}{}\n",
            w.hwnd,
            clip(&w.title, 100),
            w.process,
            w.pid,
            w.class,
            w.bounds.x,
            w.bounds.y,
            w.bounds.w,
            w.bounds.h,
            w.client_w,
            w.client_h,
            if flags.is_empty() {
                String::new()
            } else {
                format!(" [{}]", flags.join(", "))
            }
        ));
    }
    out
}

pub const LIMITS_NOTE: &str = "Background input uses window messages, which not every app honours: DirectX/OpenGL games, and some Chromium/Electron/UWP surfaces ignore synthetic messages. If the result does not change the window, fall back to the foreground tools (computer_window focus, then computer_click / computer_type / computer_key).";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{parse_chord, parse_keys};
    use serde_json::json;

    fn win() -> BgWindow {
        BgWindow {
            hwnd: 10,
            title: "t".into(),
            process: "notepad.exe".into(),
            pid: 4,
            class: "Notepad".into(),
            bounds: Rect::new(0, 0, 100, 100),
            client_w: 90,
            client_h: 80,
            minimized: false,
            visible: true,
            cloaked: false,
            root: 10,
            elevated: Some(false),
            uipi_blocked: false,
            own: false,
        }
    }

    #[test]
    fn hwnd_parsing() {
        assert_eq!(parse_hwnd(&json!("12345")).unwrap(), 12345);
        assert_eq!(parse_hwnd(&json!("0x1F")).unwrap(), 31);
        assert_eq!(parse_hwnd(&json!(77)).unwrap(), 77);
        assert!(parse_hwnd(&json!("notepad")).is_err());
        assert!(parse_hwnd(&json!(null)).is_err());
    }

    #[test]
    fn shot_map_scaling_and_translation() {
        // No cap needed: identity.
        let m = window_shot_map(400, 300, None, 1568);
        assert_eq!((m.img_w, m.img_h), (400, 300));
        assert_eq!(image_to_client(&m, 20.0, 30.0).unwrap(), (20, 30));
        // max_width halves the image; clicks map back to client pixels.
        let m = window_shot_map(1000, 600, Some(500), 1568);
        assert_eq!((m.img_w, m.img_h), (500, 300));
        assert_eq!(image_to_client(&m, 250.0, 150.0).unwrap(), (500, 300));
        assert_eq!(image_to_client(&m, 0.0, 0.0).unwrap(), (0, 0));
        assert_eq!(image_to_client(&m, 499.9, 299.9).unwrap(), (999, 599));
        // max_width never upscales; the long-side cap still applies.
        let m = window_shot_map(300, 200, Some(900), 1568);
        assert_eq!((m.img_w, m.img_h), (300, 200));
        let m = window_shot_map(3000, 1500, None, 1500);
        assert_eq!((m.img_w, m.img_h), (1500, 750));
        // out of range / non-finite rejected
        assert!(image_to_client(&m, 1500.0, 0.0).is_err());
        assert!(image_to_client(&m, -1.0, 5.0).is_err());
        assert!(image_to_client(&m, f64::NAN, 5.0).is_err());
        // degenerate client sizes do not divide by zero
        let m = window_shot_map(0, 0, None, 100);
        assert_eq!((m.img_w, m.img_h), (1, 1));
    }

    #[test]
    fn lparam_roundtrip() {
        assert_eq!(make_lparam(10, 20), 0x0014_000A);
        assert_eq!(split_lparam(make_lparam(10, 20)), (10, 20));
        assert_eq!(split_lparam(make_lparam(-5, -7)), (-5, -7));
        assert_eq!(make_lparam(-1, 0) as u32, 0x0000_FFFF);
        assert_eq!(split_lparam(make_lparam(32767, -32768)), (32767, -32768));
    }

    #[test]
    fn mouse_sequences() {
        let s = mouse_sequence(MouseButton::Left, false);
        assert_eq!(
            s,
            vec![
                (WM_MOUSEMOVE, 0),
                (WM_LBUTTONDOWN, MK_LBUTTON),
                (WM_LBUTTONUP, 0)
            ]
        );
        let d = mouse_sequence(MouseButton::Right, true);
        assert_eq!(
            d,
            vec![
                (WM_MOUSEMOVE, 0),
                (WM_RBUTTONDOWN, MK_RBUTTON),
                (WM_RBUTTONUP, 0),
                (WM_RBUTTONDBLCLK, MK_RBUTTON),
                (WM_RBUTTONUP, 0)
            ]
        );
        assert_eq!(
            mouse_sequence(MouseButton::Middle, false)[1],
            (WM_MBUTTONDOWN, MK_MBUTTON)
        );
    }

    #[test]
    fn key_lparam_bits() {
        let down = key_lparam(0x1E, false, false, false);
        assert_eq!(down as u32, 0x001E_0001);
        let up = key_lparam(0x1E, false, false, true);
        assert_eq!(up as u32, 0xC01E_0001);
        let ext = key_lparam(0x4B, true, false, false);
        assert_eq!(ext as u32, 0x014B_0001);
        let alt = key_lparam(0x1E, false, true, false);
        assert_eq!(alt as u32, 0x201E_0001);
    }

    #[test]
    fn chords_to_vk_and_scan_codes() {
        let c = parse_chord("ctrl+a").unwrap();
        assert_eq!((c.modifiers[0].vk, c.key.vk), (VK_CONTROL, 0x41));
        assert_eq!(scan_fallback(c.key.vk), 0x1E);
        assert_eq!(scan_fallback(VK_CONTROL), 0x1D);
        assert_eq!(scan_fallback(0x0D), 0x1C); // Enter
        assert_eq!(scan_fallback(0x09), 0x0F); // Tab
        assert_eq!(scan_fallback(0x08), 0x0E); // Backspace
        assert_eq!(scan_fallback(0x1B), 0x01); // Esc
        assert_eq!(scan_fallback(0x20), 0x39); // Space
        assert_eq!(scan_fallback(b'Q' as u16), 0x10);
        assert_eq!(scan_fallback(b'P' as u16), 0x19);
        assert_eq!(scan_fallback(b'M' as u16), 0x32);
        assert_eq!(scan_fallback(b'1' as u16), 0x02);
        assert_eq!(scan_fallback(b'0' as u16), 0x0B);
        assert_eq!(scan_fallback(0x70), 0x3B); // F1
        assert_eq!(scan_fallback(0x7B), 0x58); // F12
        assert_eq!(scan_fallback(0x25), 0x4B); // Left (extended)
        assert!(parse_chord("left").unwrap().key.extended);
        assert_eq!(scan_fallback(0xFF), 0);
        assert_eq!(parse_keys("ctrl+a backspace").unwrap().len(), 2);
    }

    #[test]
    fn plan_ctrl_letter_adds_control_char() {
        let p = plan_chord(&parse_chord("ctrl+a").unwrap()).unwrap();
        assert!(p.needs_state());
        assert!(!p.sys);
        assert_eq!(p.chr, Some(1));
        assert_eq!(
            plan_chord(&parse_chord("ctrl+z").unwrap()).unwrap().chr,
            Some(26)
        );
        assert_eq!(
            plan_chord(&parse_chord("shift+q").unwrap()).unwrap().chr,
            Some(b'Q' as u16)
        );
        let alt = plan_chord(&parse_chord("alt+f").unwrap()).unwrap();
        assert!(alt.sys);
        assert_eq!(alt.chr, Some(b'f' as u16));
        let plain = plan_chord(&parse_chord("enter").unwrap()).unwrap();
        assert!(!plain.needs_state());
        assert_eq!(plain.chr, None);
        assert_eq!(
            plan_chord(&parse_chord("ctrl+home").unwrap()).unwrap().chr,
            None
        );
        assert!(plan_chord(&parse_chord("win+r").unwrap()).is_err());
    }

    #[test]
    fn modifier_state_sets_generic_and_left_bits() {
        let mut base = [0u8; 256];
        base[0x41] = 0x01;
        let c = parse_chord("ctrl+shift+a").unwrap();
        let s = modifier_state(&base, &c.modifiers);
        assert_eq!(s[VK_CONTROL as usize] & 0x80, 0x80);
        assert_eq!(s[0xA2] & 0x80, 0x80);
        assert_eq!(s[VK_SHIFT as usize] & 0x80, 0x80);
        assert_eq!(s[0xA0] & 0x80, 0x80);
        assert_eq!(s[VK_MENU as usize], 0);
        assert_eq!(s[0x41], 0x01);
    }

    #[test]
    fn utf16_wm_char_splitting() {
        assert_eq!(text_to_chars("hi"), vec![b'h' as u16, b'i' as u16]);
        // U+1F600 is a surrogate pair: two WM_CHAR units, high first.
        assert_eq!(text_to_chars("a\u{1F600}"), vec![0x61, 0xD83D, 0xDE00]);
        // BMP non-ASCII stays one unit.
        assert_eq!(text_to_chars("\u{00E9}"), vec![0xE9]);
        // Every newline form is one Enter.
        assert_eq!(
            text_to_chars("a\r\nb\nc\rd"),
            vec![0x61, 0x0D, 0x62, 0x0D, 0x63, 0x0D, 0x64]
        );
        assert_eq!(text_to_chars("\n\n"), vec![0x0D, 0x0D]);
        assert_eq!(text_to_chars("\t"), vec![9]);
        assert!(text_to_chars("").is_empty());
    }

    #[test]
    fn refusals() {
        assert!(refuse_reason(&win()).is_none());
        let mut w = win();
        w.own = true;
        assert!(refuse_reason(&w).unwrap().contains("own"));
        let mut w = win();
        w.root = 99;
        assert!(refuse_reason(&w).unwrap().contains("child window"));
        let mut w = win();
        w.process = "consent.exe".into();
        assert!(refuse_reason(&w).unwrap().contains("secure"));
        let mut w = win();
        w.class = "$$$Secure UAP Dummy Window Class For Interactive Input Desktop".into();
        assert!(refuse_reason(&w).unwrap().contains("secure"));
        let mut w = win();
        w.uipi_blocked = true;
        w.elevated = Some(true);
        assert!(refuse_reason(&w).unwrap().contains("UIPI"));
    }

    #[test]
    fn own_process_matching() {
        let o = OwnProcess {
            pid: 7,
            exe: "Omnia.exe".into(),
        };
        assert!(o.matches(7, "x.exe"));
        assert!(o.matches(8, "omnia.EXE"));
        assert!(!o.matches(8, "notepad.exe"));
        assert!(!o.matches(8, ""));
        assert!(!OwnProcess::none().matches(0, ""));
    }

    #[test]
    fn uniform_detection() {
        let flat = RawImage {
            origin: (0, 0),
            width: 4,
            height: 4,
            rgb: vec![9; 48],
        };
        assert!(is_uniform(&flat));
        let mut rgb = vec![9u8; 48];
        rgb[47] = 200;
        assert!(!is_uniform(&RawImage {
            origin: (0, 0),
            width: 4,
            height: 4,
            rgb
        }));
    }

    #[test]
    fn listing_format_mentions_flags() {
        let mut w = win();
        w.minimized = true;
        w.cloaked = true;
        let t = format_windows(&[w]);
        assert!(t.contains("hwnd=\"10\""));
        assert!(t.contains("minimized, cloaked"));
    }
}
