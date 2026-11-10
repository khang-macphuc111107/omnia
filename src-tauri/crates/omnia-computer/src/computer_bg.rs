//! Background window operations on [`Computer`]: policy-checked wrappers over
//! the worker for `computer_window_*` (no foreground change, no cursor move).

use std::time::Duration;

use base64::Engine;
use omnia_harness::Block;

use crate::backend::CResult;
use crate::bg::{
    format_windows, image_to_client, is_uniform, refuse_reason, scale_to_map, text_to_chars,
    window_shot_map, BgWindow, LIMITS_NOTE, MAX_TYPE_UNITS,
};
use crate::computer::Computer;
use crate::encode::{encode_image, ImageFormat};
use crate::geometry::ImageMap;
use crate::keys::parse_keys;
use crate::ocr::{map_line, OcrLine};
use crate::types::{MouseButton, RawImage};
use crate::ComputerError;

pub struct BgShot {
    pub bytes: Vec<u8>,
    pub media_type: &'static str,
    /// Image pixels <-> client-area pixels.
    pub map: ImageMap,
    pub window: BgWindow,
    pub blank: bool,
    /// Set when a minimized window was shown again; holds the focus note.
    pub restored: Option<String>,
}

impl BgShot {
    pub fn to_blocks(&self) -> Vec<Block> {
        let (m, w) = (&self.map, &self.window);
        let mut text = format!(
            "Window screenshot {}x{} of \"{}\" [{}, hwnd=\"{}\"], client area {}x{} px (no title bar/borders); 1 image px = {:.3} client px. \
Coordinates for computer_window_click are pixels of THIS image.",
            m.img_w,
            m.img_h,
            w.title,
            w.process,
            w.hwnd,
            m.src_w,
            m.src_h,
            m.scale()
        );
        if let Some(note) = &self.restored {
            text.push_str(&format!(
                " The window was minimized and was shown again. {note}"
            ));
        }
        if self.blank {
            text.push_str(" WARNING: the capture is a single flat colour; this app probably draws with a GPU surface that PrintWindow cannot read. Use the foreground computer_screenshot instead.");
        }
        vec![
            Block::Image {
                media_type: self.media_type.into(),
                data: base64::engine::general_purpose::STANDARD.encode(&self.bytes),
            },
            Block::text(text),
        ]
    }
}

pub struct BgOcr {
    pub lines: Vec<OcrLine>,
    pub map: ImageMap,
    pub label: String,
    pub blank: bool,
}

fn minimized_msg() -> ComputerError {
    ComputerError::Invalid(
        "window is minimized, so Windows cannot render it. Call again with restore_without_activate=true (shows it without activating or focusing it, which changes its visible state) or ask the user to restore it."
            .into(),
    )
}

impl Computer {
    /// Resolve a handle for background use and apply every refusal rule: kill
    /// switch, child window, Omnia's own windows, secure desktop, UIPI/elevation
    /// and the app allow/block policy.
    async fn bg_target(&self, hwnd: isize) -> CResult<BgWindow> {
        self.safety().check_alive()?;
        let mut w = self.run(move |b| b.bg_info(hwnd)).await?.ok_or_else(|| {
            ComputerError::NotFound(format!(
                "no window with hwnd \"{hwnd}\"; use computer_window_list"
            ))
        })?;
        w.own = self.own_process().matches(w.pid, &w.process);
        if let Some(reason) = refuse_reason(&w) {
            return Err(ComputerError::Blocked(reason));
        }
        self.safety().check_process(&w.process)?;
        Ok(w)
    }

    /// Visible top-level windows with background-relevant flags.
    pub async fn bg_windows(&self) -> CResult<Vec<BgWindow>> {
        self.safety().check_alive()?;
        let mut list = self.run(|b| b.bg_list()).await?;
        let own = self.own_process();
        for w in &mut list {
            w.own = own.matches(w.pid, &w.process);
        }
        Ok(list)
    }

    pub async fn bg_windows_text(&self) -> CResult<String> {
        Ok(format_windows(&self.bg_windows().await?))
    }

    async fn bg_capture_raw(
        &self,
        hwnd: isize,
        restore: bool,
    ) -> CResult<(BgWindow, RawImage, Option<String>)> {
        let mut w = self.bg_target(hwnd).await?;
        let mut restored = None;
        if w.minimized {
            if !restore {
                return Err(minimized_msg());
            }
            self.safety().check_action()?;
            let (ok, note) = self.run(move |b| b.bg_restore(hwnd)).await?;
            if !ok {
                return Err(ComputerError::Failed(
                    "the window stayed minimized after SW_SHOWNOACTIVATE; ask the user to restore it".into(),
                ));
            }
            restored = Some(note);
            w = self.bg_target(hwnd).await?;
        }
        let raw = self.run(move |b| b.bg_capture(hwnd)).await?;
        Ok((w, raw, restored))
    }

    /// Build a screenshot without publishing its coordinate map. Callers may
    /// discard blank observations, so they record the map only when delivered.
    async fn bg_shot_with(
        &self,
        hwnd: isize,
        max_width: Option<u32>,
        side: u32,
        fmt: ImageFormat,
        restore: bool,
    ) -> CResult<BgShot> {
        let (window, raw, restored) = self.bg_capture_raw(hwnd, restore).await?;
        let map = window_shot_map(raw.width as i32, raw.height as i32, max_width, side);
        let blank = is_uniform(&raw);
        let q = self.config().jpeg_quality;
        let bytes = tokio::task::spawn_blocking(move || {
            let scaled = scale_to_map(&raw, &map);
            encode_image(&scaled, 0, fmt, q).map(|e| e.bytes)
        })
        .await
        .map_err(|e| ComputerError::Failed(format!("encode task: {e}")))??;
        Ok(BgShot {
            bytes,
            media_type: fmt.media_type(),
            map,
            window,
            blank,
            restored,
        })
    }

    fn remember_bg_shot(&self, shot: &BgShot) {
        if let Ok(mut maps) = self.bg_maps().lock() {
            maps.insert(shot.window.hwnd, shot.map);
        }
    }

    fn bg_observation_blocks(&self, shot: BgShot) -> Vec<Block> {
        if shot.blank {
            return Vec::new();
        }
        // Only delivered images may replace the coordinates of the last
        // screenshot. A discarded blank observation has a different scale.
        self.remember_bg_shot(&shot);
        shot.to_blocks()
    }

    /// PNG of the window's client area, even when occluded.
    pub async fn bg_screenshot(
        &self,
        hwnd: isize,
        max_width: Option<u32>,
        restore: bool,
    ) -> CResult<BgShot> {
        let shot = self
            .bg_shot_with(
                hwnd,
                max_width,
                self.config().max_image_side,
                ImageFormat::Png,
                restore,
            )
            .await?;
        self.remember_bg_shot(&shot);
        Ok(shot)
    }

    /// OCR of the window's client area; boxes are in the screenshot space that
    /// `computer_window_click` then reads.
    pub async fn bg_ocr(
        &self,
        hwnd: isize,
        max_width: Option<u32>,
        language: Option<String>,
        restore: bool,
    ) -> CResult<BgOcr> {
        let (window, raw, _) = self.bg_capture_raw(hwnd, restore).await?;
        let map = window_shot_map(
            raw.width as i32,
            raw.height as i32,
            max_width,
            self.config().max_image_side,
        );
        let blank = is_uniform(&raw);
        let raw_lines = tokio::task::spawn_blocking(move || {
            crate::backend::ocr_recognize(&raw, language.as_deref())
        })
        .await
        .map_err(|e| ComputerError::Failed(format!("ocr task: {e}")))??;
        if let Ok(mut g) = self.bg_maps().lock() {
            g.insert(hwnd, map);
        }
        let lines = raw_lines
            .iter()
            .map(|l| map_line(l, (0, 0), &map))
            .collect();
        Ok(BgOcr {
            lines,
            map,
            label: format!("window \"{}\" (client area)", window.title),
            blank,
        })
    }

    /// Post a click at screenshot-space `(x, y)` of the latest window screenshot.
    pub async fn bg_click(
        &self,
        hwnd: isize,
        x: f64,
        y: f64,
        button: MouseButton,
        double: bool,
    ) -> CResult<String> {
        self.safety().check_action()?;
        let w = self.bg_target(hwnd).await?;
        if w.minimized {
            return Err(minimized_msg());
        }
        let known = self
            .bg_maps()
            .lock()
            .ok()
            .and_then(|g| g.get(&hwnd).copied());
        let (cx, cy, note) = match known {
            Some(m) => {
                if (m.src_w as i32, m.src_h as i32) != (w.client_w, w.client_h) {
                    return Err(ComputerError::Invalid(format!(
                        "the window size changed to {}x{} since the last screenshot; take computer_window_screenshot again",
                        w.client_w, w.client_h
                    )));
                }
                let (cx, cy) = image_to_client(&m, x, y).map_err(ComputerError::Invalid)?;
                (cx, cy, "")
            }
            None => {
                if !(x.is_finite() && y.is_finite())
                    || x < 0.0
                    || y < 0.0
                    || x >= w.client_w as f64
                    || y >= w.client_h as f64
                {
                    return Err(ComputerError::Invalid(format!(
                        "({x},{y}) is outside the {}x{} client area; take computer_window_screenshot first",
                        w.client_w, w.client_h
                    )));
                }
                (
                    x as i32,
                    y as i32,
                    " (no screenshot yet: x,y were taken as raw client pixels)",
                )
            }
        };
        let t = self.timing();
        let (msg, child) = self
            .run(move |b| b.bg_click(hwnd, cx, cy, button, double, t))
            .await?;
        if let Ok(mut g) = self.bg_focus().lock() {
            g.insert(hwnd, child);
        }
        Ok(format!("{msg}{note}"))
    }

    fn bg_hint(&self, hwnd: isize) -> Option<isize> {
        self.bg_focus()
            .lock()
            .ok()
            .and_then(|g| g.get(&hwnd).copied())
    }

    pub async fn bg_type(&self, hwnd: isize, text: &str) -> CResult<String> {
        self.safety().check_action()?;
        let units = text_to_chars(text);
        if units.is_empty() {
            return Err(ComputerError::Invalid("`text` must not be empty".into()));
        }
        if units.len() > MAX_TYPE_UNITS {
            return Err(ComputerError::Invalid(format!(
                "`text` is too long (max {MAX_TYPE_UNITS} UTF-16 units)"
            )));
        }
        self.bg_target(hwnd).await?;
        let (t, hint) = (self.timing(), self.bg_hint(hwnd));
        self.run(move |b| b.bg_type(hwnd, units, hint, t)).await
    }

    pub async fn bg_key(&self, hwnd: isize, key: &str) -> CResult<String> {
        self.safety().check_action()?;
        let chords = parse_keys(key).map_err(ComputerError::Invalid)?;
        self.bg_target(hwnd).await?;
        let (t, hint) = (self.timing(), self.bg_hint(hwnd));
        self.run(move |b| b.bg_key(hwnd, chords, hint, t)).await
    }

    /// Small post-action screenshot of the target window (best effort). Its
    /// scale replaces the stored one, so the text states the coordinate space.
    pub async fn bg_observe(&self, hwnd: isize) -> Vec<Block> {
        let cfg = self.config();
        if !cfg.observe || self.safety().check_alive().is_err() {
            return Vec::new();
        }
        tokio::time::sleep(Duration::from_millis(cfg.settle_ms)).await;
        match self
            .bg_shot_with(hwnd, None, cfg.observe_image_side, cfg.image_format, false)
            .await
        {
            Ok(shot) => self.bg_observation_blocks(shot),
            Err(_) => Vec::new(),
        }
    }

    pub fn bg_limits_note() -> &'static str {
        LIMITS_NOTE
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::ComputerConfig;
    use crate::types::Rect;

    fn shot(hwnd: isize, side: u32, blank: bool) -> BgShot {
        BgShot {
            bytes: vec![0],
            media_type: "image/png",
            map: window_shot_map(1600, 900, None, side),
            window: BgWindow {
                hwnd,
                title: "Background window".into(),
                process: "notepad.exe".into(),
                pid: 1,
                class: "Notepad".into(),
                bounds: Rect::new(0, 0, 1600, 900),
                client_w: 1600,
                client_h: 900,
                minimized: false,
                visible: true,
                cloaked: false,
                root: hwnd,
                elevated: Some(false),
                uipi_blocked: false,
                own: false,
            },
            blank,
            restored: None,
        }
    }

    #[test]
    fn blank_observation_preserves_previous_coordinate_map() {
        let computer = Computer::new(ComputerConfig::default());
        let screenshot = shot(10, 1568, false);
        computer.remember_bg_shot(&screenshot);

        assert!(computer
            .bg_observation_blocks(shot(10, 768, true))
            .is_empty());

        let maps = computer.bg_maps().lock().unwrap();
        let map = maps.get(&10).unwrap();
        assert_eq!(*map, screenshot.map);
        assert_eq!(image_to_client(map, 784.0, 0.0).unwrap(), (800, 0));
    }

    #[test]
    fn blank_observation_without_screenshot_leaves_no_coordinate_map() {
        let computer = Computer::new(ComputerConfig::default());

        assert!(computer
            .bg_observation_blocks(shot(10, 768, true))
            .is_empty());
        assert!(computer.bg_maps().lock().unwrap().is_empty());
    }

    #[test]
    fn delivered_observation_updates_only_its_window_coordinate_map() {
        let computer = Computer::new(ComputerConfig::default());
        let first = shot(10, 1568, false);
        let other = shot(20, 1568, false);
        let observation = shot(10, 768, false);
        computer.remember_bg_shot(&first);
        computer.remember_bg_shot(&other);
        let observation_map = observation.map;

        let blocks = computer.bg_observation_blocks(observation);

        assert_eq!(blocks.len(), 2);
        let maps = computer.bg_maps().lock().unwrap();
        assert_eq!(maps.get(&10), Some(&observation_map));
        assert_eq!(maps.get(&20), Some(&other.map));
    }
}
