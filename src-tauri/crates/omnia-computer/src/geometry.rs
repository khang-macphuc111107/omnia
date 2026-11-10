//! Pure coordinate math: virtual-screen normalization, screenshot scaling,
//! smooth mouse paths and window selection.

use crate::types::{MonitorInfo, Rect, WindowInfo, WindowSel};

/// Bounding box of all monitors (the "virtual screen"); origin may be negative.
pub fn virtual_bounds(monitors: &[MonitorInfo]) -> Option<Rect> {
    monitors.iter().map(|m| m.bounds).reduce(|a, b| a.union(&b))
}

/// Map a physical virtual-screen point to the 0..=65535 range expected by
/// `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`.
pub fn normalize_abs(x: i32, y: i32, virt: Rect) -> (i32, i32) {
    let norm = |v: i32, origin: i32, size: i32| -> i32 {
        if size <= 1 {
            return 0;
        }
        let rel = (v - origin).clamp(0, size - 1) as i64;
        ((rel * 65535 + (size as i64 - 1) / 2) / (size as i64 - 1)) as i32
    };
    (norm(x, virt.x, virt.w), norm(y, virt.y, virt.h))
}

/// Dimensions after downscaling so the long side is at most `max_side`.
/// Never upscales. Returns `(width, height)`.
pub fn downscale_dims(w: u32, h: u32, max_side: u32) -> (u32, u32) {
    let long = w.max(h);
    if max_side == 0 || long <= max_side || w == 0 || h == 0 {
        return (w, h);
    }
    let f = max_side as f64 / long as f64;
    (
        ((w as f64 * f).round() as u32).max(1),
        ((h as f64 * f).round() as u32).max(1),
    )
}

/// Mapping between coordinates in a screenshot and physical virtual-screen pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageMap {
    /// Physical virtual-screen position of image pixel (0,0).
    pub origin: (i32, i32),
    pub src_w: u32,
    pub src_h: u32,
    pub img_w: u32,
    pub img_h: u32,
}

impl ImageMap {
    /// Mapping for capturing `bounds` downscaled to `max_side`.
    pub fn fit(bounds: Rect, max_side: u32) -> Self {
        let (sw, sh) = (bounds.w.max(1) as u32, bounds.h.max(1) as u32);
        let (iw, ih) = downscale_dims(sw, sh, max_side);
        Self {
            origin: (bounds.x, bounds.y),
            src_w: sw,
            src_h: sh,
            img_w: iw,
            img_h: ih,
        }
    }

    /// Physical pixels per image pixel along x.
    pub fn scale(&self) -> f64 {
        self.src_w as f64 / self.img_w.max(1) as f64
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= 0.0 && y >= 0.0 && x < self.img_w as f64 && y < self.img_h as f64
    }

    /// Screenshot-space point -> physical virtual-screen point.
    pub fn to_physical(&self, x: f64, y: f64) -> (i32, i32) {
        let px = self.origin.0 as f64 + x * self.src_w as f64 / self.img_w.max(1) as f64;
        let py = self.origin.1 as f64 + y * self.src_h as f64 / self.img_h.max(1) as f64;
        (px.round() as i32, py.round() as i32)
    }

    /// Fractional physical point -> screenshot-space point.
    pub fn to_image_f(&self, px: f64, py: f64) -> (f64, f64) {
        (
            (px - self.origin.0 as f64) * self.img_w as f64 / self.src_w.max(1) as f64,
            (py - self.origin.1 as f64) * self.img_h as f64 / self.src_h.max(1) as f64,
        )
    }

    /// Physical point -> screenshot-space point.
    pub fn to_image(&self, px: i32, py: i32) -> (f64, f64) {
        (
            (px - self.origin.0) as f64 * self.img_w as f64 / self.src_w.max(1) as f64,
            (py - self.origin.1) as f64 * self.img_h as f64 / self.src_h.max(1) as f64,
        )
    }

    /// Sub-region of the image (screenshot space `[x,y,w,h]`) -> physical rect.
    pub fn region_to_physical(&self, region: [f64; 4]) -> Rect {
        let (x0, y0) = self.to_physical(region[0], region[1]);
        let (x1, y1) = self.to_physical(region[0] + region[2], region[1] + region[3]);
        Rect::from_ltrb(x0, y0, x1.max(x0 + 1), y1.max(y0 + 1))
    }
}

/// Points of a smooth (ease in-out) path from `a` to `b`, excluding `a`,
/// including `b`. `steps == 0` yields just `b`.
pub fn smooth_path(a: (i32, i32), b: (i32, i32), steps: u32) -> Vec<(i32, i32)> {
    if steps == 0 || a == b {
        return vec![b];
    }
    (1..=steps)
        .map(|i| {
            let t = i as f64 / steps as f64;
            let e = t * t * (3.0 - 2.0 * t);
            (
                (a.0 as f64 + (b.0 - a.0) as f64 * e).round() as i32,
                (a.1 as f64 + (b.1 - a.1) as f64 * e).round() as i32,
            )
        })
        .collect()
}

/// Pick a window from a z-ordered list (top first).
pub fn match_window<'a>(
    windows: &'a [WindowInfo],
    sel: &WindowSel,
) -> Result<&'a WindowInfo, String> {
    match sel {
        WindowSel::Focused => windows
            .iter()
            .find(|w| w.focused)
            .ok_or_else(|| "no focused window".to_string()),
        WindowSel::Hwnd(h) => windows
            .iter()
            .find(|w| w.hwnd == *h)
            .ok_or_else(|| format!("no window with hwnd {h}")),
        WindowSel::Title(t) => {
            let needle = t.to_lowercase();
            let stem = needle.trim_end_matches(".exe").to_string();
            let proc_stem = |w: &WindowInfo| {
                w.process
                    .to_lowercase()
                    .trim_end_matches(".exe")
                    .to_string()
            };
            windows
                .iter()
                .find(|w| w.title.to_lowercase() == needle)
                .or_else(|| {
                    windows
                        .iter()
                        .find(|w| w.title.to_lowercase().contains(&needle))
                })
                .or_else(|| windows.iter().find(|w| proc_stem(w) == stem))
                .or_else(|| {
                    windows
                        .iter()
                        .find(|w| w.process.to_lowercase().contains(&needle))
                })
                .ok_or_else(|| format!("no window matching \"{t}\" (use computer_windows to list)"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(index: usize, x: i32, y: i32, w: i32, h: i32, dpi: u32, primary: bool) -> MonitorInfo {
        MonitorInfo {
            index,
            name: format!("M{index}"),
            bounds: Rect::new(x, y, w, h),
            work_area: Rect::new(x, y, w, h),
            dpi,
            scale: dpi as f64 / 96.0,
            primary,
        }
    }

    #[test]
    fn virtual_bounds_with_negative_origin() {
        let ms = [
            mon(0, 0, 0, 2560, 1440, 144, true),
            mon(1, -1920, -200, 1920, 1080, 96, false),
        ];
        assert_eq!(
            virtual_bounds(&ms),
            Some(Rect::new(-1920, -200, 4480, 1640))
        );
        assert_eq!(virtual_bounds(&[]), None);
    }

    #[test]
    fn normalize_corners_and_negative_origin() {
        let virt = Rect::new(-1920, -200, 4480, 1640);
        assert_eq!(normalize_abs(-1920, -200, virt), (0, 0));
        assert_eq!(normalize_abs(2559, 1439, virt), (65535, 65535));
        assert_eq!(normalize_abs(9999, -9999, virt), (65535, 0));
        let (x, _) = normalize_abs(0, 0, virt);
        let expected = (1920.0 / 4479.0 * 65535.0_f64).round() as i32;
        assert!((x - expected).abs() <= 1);
        assert_eq!(normalize_abs(5, 5, Rect::new(0, 0, 1, 1)), (0, 0));
    }

    #[test]
    fn downscale_math() {
        assert_eq!(downscale_dims(3840, 2160, 1568), (1568, 882));
        assert_eq!(downscale_dims(1000, 500, 1568), (1000, 500));
        assert_eq!(downscale_dims(1080, 1920, 1568), (882, 1568));
        assert_eq!(downscale_dims(100, 100, 0), (100, 100));
    }

    #[test]
    fn image_map_roundtrip_dpi_and_offset() {
        let map = ImageMap::fit(Rect::new(-3840, 0, 3840, 2160), 1568);
        assert_eq!((map.img_w, map.img_h), (1568, 882));
        assert!((map.scale() - 3840.0 / 1568.0).abs() < 1e-9);
        assert_eq!(map.to_physical(0.0, 0.0), (-3840, 0));
        let (px, py) = map.to_physical(784.0, 441.0);
        assert_eq!((px, py), (-1920, 1080));
        let (ix, iy) = map.to_image(px, py);
        assert!((ix - 784.0).abs() < 1e-6 && (iy - 441.0).abs() < 1e-6);
        assert!(map.contains(1567.0, 881.0));
        assert!(!map.contains(1568.0, 0.0) && !map.contains(-1.0, 0.0));
    }

    #[test]
    fn region_maps_to_physical() {
        let map = ImageMap::fit(Rect::new(100, 50, 3000, 2000), 1500);
        let r = map.region_to_physical([10.0, 20.0, 100.0, 50.0]);
        assert_eq!(r, Rect::new(120, 90, 200, 100));
    }

    #[test]
    fn smooth_path_ends_at_target() {
        let p = smooth_path((0, 0), (100, 50), 10);
        assert_eq!(p.len(), 10);
        assert_eq!(*p.last().unwrap(), (100, 50));
        assert!(p.windows(2).all(|w| w[0].0 <= w[1].0));
        assert_eq!(smooth_path((3, 3), (9, 9), 0), vec![(9, 9)]);
    }

    fn win(hwnd: isize, title: &str, process: &str, focused: bool) -> WindowInfo {
        WindowInfo {
            hwnd,
            title: title.into(),
            process: process.into(),
            pid: 1,
            class: String::new(),
            bounds: Rect::new(0, 0, 10, 10),
            minimized: false,
            focused,
        }
    }

    #[test]
    fn window_matching() {
        let ws = vec![
            win(1, "Untitled - Notepad", "notepad.exe", false),
            win(2, "Notes", "Code.exe", true),
            win(3, "Notepad Settings", "notepad.exe", false),
        ];
        assert_eq!(match_window(&ws, &WindowSel::Focused).unwrap().hwnd, 2);
        assert_eq!(match_window(&ws, &WindowSel::Hwnd(3)).unwrap().hwnd, 3);
        assert_eq!(
            match_window(&ws, &WindowSel::Title("notes".into()))
                .unwrap()
                .hwnd,
            2
        );
        assert_eq!(
            match_window(&ws, &WindowSel::Title("notepad".into()))
                .unwrap()
                .hwnd,
            1
        );
        assert_eq!(
            match_window(&ws, &WindowSel::Title("code".into()))
                .unwrap()
                .hwnd,
            2
        );
        assert!(match_window(&ws, &WindowSel::Title("zzz".into())).is_err());
    }

    #[test]
    fn window_sel_from_json() {
        use serde_json::json;
        assert_eq!(
            WindowSel::from_json(&json!(42)).unwrap(),
            WindowSel::Hwnd(42)
        );
        assert_eq!(
            WindowSel::from_json(&json!("0x10")).unwrap(),
            WindowSel::Hwnd(16)
        );
        assert_eq!(
            WindowSel::from_json(&json!("Calc")).unwrap(),
            WindowSel::Title("Calc".into())
        );
        assert!(WindowSel::from_json(&json!(true)).is_err());
    }
}
