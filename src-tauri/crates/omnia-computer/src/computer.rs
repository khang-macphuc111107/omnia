//! The shared handle: policy-checked, async operations on top of the worker.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use omnia_harness::Block;

use crate::backend::{Backend, CResult, Worker};
use crate::encode::{encode_image, ImageFormat};
use crate::geometry::{match_window, ImageMap};
use crate::keys::{modifier, parse_keys, KeyStep};
use crate::ocr::{map_line, region_to_physical, OcrLine};
use crate::safety::{ComputerPolicy, KillSwitch, Safety};
use crate::types::*;
use crate::ComputerError;

#[derive(Clone)]
pub struct ComputerConfig {
    pub policy: ComputerPolicy,
    /// Long side of screenshots sent to the model.
    pub max_image_side: u32,
    pub image_format: ImageFormat,
    pub jpeg_quality: u8,
    pub timing: InputTiming,
    /// Append a fresh observation (snapshot or small screenshot) after actions.
    pub observe: bool,
    pub observe_max_chars: usize,
    pub observe_image_side: u32,
    /// Wait before observing so the UI can react.
    pub settle_ms: u64,
    /// Defaults for `computer_snapshot`.
    pub snapshot: SnapshotOptions,
    pub launch_timeout_ms: u64,
}

impl Default for ComputerConfig {
    fn default() -> Self {
        Self {
            policy: ComputerPolicy::default(),
            max_image_side: 1568,
            image_format: ImageFormat::Jpeg,
            jpeg_quality: 85,
            timing: InputTiming::default(),
            observe: true,
            observe_max_chars: 6000,
            observe_image_side: 768,
            settle_ms: 350,
            snapshot: SnapshotOptions::default(),
            launch_timeout_ms: 10_000,
        }
    }
}

pub enum ShotTarget {
    Monitor(Option<usize>),
    Window(WindowSel),
}

pub struct Screenshot {
    pub bytes: Vec<u8>,
    pub media_type: &'static str,
    pub map: ImageMap,
    pub label: String,
}

impl Screenshot {
    pub fn to_blocks(&self) -> Vec<Block> {
        let m = &self.map;
        vec![
            Block::Image {
                media_type: self.media_type.into(),
                data: base64::engine::general_purpose::STANDARD.encode(&self.bytes),
            },
            Block::text(format!(
                "Screenshot {}x{} of {}. Click/scroll/drag coordinates are pixels in this image; \
1 image px = {:.3} physical px; image (0,0) is screen ({},{}).",
                m.img_w,
                m.img_h,
                self.label,
                m.scale(),
                m.origin.0,
                m.origin.1
            )),
        ]
    }
}

/// OCR outcome; `lines` are in the screenshot space of `map` (the full target).
pub struct OcrOutput {
    pub lines: Vec<OcrLine>,
    pub map: ImageMap,
    pub label: String,
}

pub enum ClickTarget {
    Ref(String),
    Point {
        x: f64,
        y: f64,
        monitor: Option<usize>,
        window: Option<WindowSel>,
    },
}

struct Inner {
    cfg: ComputerConfig,
    safety: Safety,
    worker: OnceLock<Worker>,
    last_map: Mutex<Option<ImageMap>>,
    bg_maps: Mutex<HashMap<isize, ImageMap>>,
    own: Mutex<crate::bg::OwnProcess>,
    /// Last control clicked per top-level window (fallback typing target).
    bg_focus: Mutex<HashMap<isize, isize>>,
}

/// Cheap-to-clone handle shared by all computer tools.
#[derive(Clone)]
pub struct Computer {
    inner: Arc<Inner>,
}

impl Computer {
    pub fn new(cfg: ComputerConfig) -> Self {
        Self::with_kill_switch(cfg, KillSwitch::default())
    }

    pub fn with_kill_switch(cfg: ComputerConfig, kill: KillSwitch) -> Self {
        let safety = Safety::new(cfg.policy.clone(), kill);
        Self {
            inner: Arc::new(Inner {
                cfg,
                safety,
                worker: OnceLock::new(),
                last_map: Mutex::new(None),
                bg_maps: Mutex::new(HashMap::new()),
                own: Mutex::new(crate::bg::OwnProcess::current()),
                bg_focus: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn config(&self) -> &ComputerConfig {
        &self.inner.cfg
    }

    pub fn safety(&self) -> &Safety {
        &self.inner.safety
    }

    pub fn kill_switch(&self) -> KillSwitch {
        self.inner.safety.kill.clone()
    }

    pub(crate) async fn run<R, F>(&self, f: F) -> CResult<R>
    where
        R: Send + 'static,
        F: FnOnce(&mut Backend) -> CResult<R> + Send + 'static,
    {
        self.inner.worker.get_or_init(Worker::spawn).run(f).await
    }

    pub(crate) fn timing(&self) -> InputTiming {
        self.inner.cfg.timing.clone()
    }

    pub(crate) fn bg_maps(&self) -> &Mutex<HashMap<isize, ImageMap>> {
        &self.inner.bg_maps
    }

    pub(crate) fn bg_focus(&self) -> &Mutex<HashMap<isize, isize>> {
        &self.inner.bg_focus
    }

    pub(crate) fn own_process(&self) -> crate::bg::OwnProcess {
        self.inner
            .own
            .lock()
            .map(|o| o.clone())
            .unwrap_or_else(|_| crate::bg::OwnProcess::current())
    }

    #[cfg(test)]
    pub(crate) fn set_own_process(&self, own: crate::bg::OwnProcess) {
        if let Ok(mut o) = self.inner.own.lock() {
            *o = own;
        }
    }

    fn set_last_map(&self, map: ImageMap) {
        if let Ok(mut g) = self.inner.last_map.lock() {
            *g = Some(map);
        }
    }

    // ------------------------------------------------------------ queries

    pub async fn monitors(&self) -> CResult<Vec<MonitorInfo>> {
        self.safety().check_alive()?;
        self.run(|b| b.monitors()).await
    }

    pub async fn windows(&self) -> CResult<Vec<WindowInfo>> {
        self.safety().check_alive()?;
        self.run(|b| b.windows()).await
    }

    /// Resolve a window selector and enforce the app policy on it.
    pub async fn resolve_window(&self, sel: &WindowSel) -> CResult<WindowInfo> {
        self.safety().check_alive()?;
        let w = match sel {
            WindowSel::Focused => self
                .run(|b| b.foreground())
                .await?
                .ok_or_else(|| ComputerError::NotFound("no focused window".into()))?,
            WindowSel::Hwnd(h) => {
                let h = *h;
                self.run(move |b| b.window_info(h))
                    .await?
                    .ok_or_else(|| ComputerError::NotFound(format!("no window with hwnd {h}")))?
            }
            WindowSel::Title(_) => {
                let all = self.run(|b| b.windows()).await?;
                match_window(&all, sel)
                    .map_err(ComputerError::NotFound)?
                    .clone()
            }
        };
        self.safety().check_process(&w.process)?;
        Ok(w)
    }

    pub async fn snapshot(
        &self,
        sel: Option<&WindowSel>,
        opts: SnapshotOptions,
    ) -> CResult<Snapshot> {
        let w = self
            .resolve_window(sel.unwrap_or(&WindowSel::Focused))
            .await?;
        if w.minimized {
            return Err(ComputerError::Invalid(
                "window is minimized; restore it first (computer_window restore)".into(),
            ));
        }
        self.run(move |b| b.snapshot(w, opts)).await
    }

    async fn encode(&self, raw: RawImage, side: u32) -> CResult<(Vec<u8>, &'static str, ImageMap)> {
        let (fmt, q) = (self.inner.cfg.image_format, self.inner.cfg.jpeg_quality);
        let join = tokio::task::spawn_blocking(move || {
            let enc = encode_image(&raw, side, fmt, q)?;
            let map = ImageMap {
                origin: raw.origin,
                src_w: raw.width,
                src_h: raw.height,
                img_w: enc.width,
                img_h: enc.height,
            };
            Ok::<_, ComputerError>((enc.bytes, fmt.media_type(), map))
        });
        join.await
            .map_err(|e| ComputerError::Failed(format!("encode task: {e}")))?
    }

    /// Screenshot of a monitor or window, optionally a sub-region given in the
    /// full-target screenshot space (`[x,y,w,h]`) for zooming in.
    pub async fn screenshot(
        &self,
        target: ShotTarget,
        region: Option<[f64; 4]>,
    ) -> CResult<Screenshot> {
        self.safety().check_alive()?;
        let side = self.inner.cfg.max_image_side;
        let (bounds, label, hwnd) = match &target {
            ShotTarget::Monitor(idx) => {
                let ms = self.run(|b| b.monitors()).await?;
                let i = idx.unwrap_or(0);
                let m = ms.get(i).ok_or_else(|| {
                    ComputerError::NotFound(format!("no monitor {i} (have {})", ms.len()))
                })?;
                (
                    m.bounds,
                    format!("monitor {i}{}", if m.primary { " (primary)" } else { "" }),
                    None,
                )
            }
            ShotTarget::Window(sel) => {
                let w = self.resolve_window(sel).await?;
                (w.bounds, format!("window \"{}\"", w.title), Some(w.hwnd))
            }
        };
        let raw = if let Some(r) = region {
            let base = ImageMap::fit(bounds, side);
            let phys = base
                .region_to_physical(r)
                .intersect(&bounds)
                .ok_or_else(|| ComputerError::Invalid("region is outside the screenshot".into()))?;
            self.run(move |b| b.capture_rect(phys)).await?
        } else if let Some(h) = hwnd {
            self.run(move |b| b.capture_window(h)).await?
        } else {
            self.run(move |b| b.capture_rect(bounds)).await?
        };
        let (bytes, media_type, map) = self.encode(raw, side).await?;
        self.set_last_map(map);
        Ok(Screenshot {
            bytes,
            media_type,
            map,
            label: if region.is_some() {
                format!("{label} (zoomed region)")
            } else {
                label
            },
        })
    }

    /// OCR a monitor or window (optionally a `[x0,y0,x1,y1]` region of the
    /// full-target screenshot space). Same capture guards as `screenshot`;
    /// result boxes are in the full-target screenshot space, which also becomes
    /// the space `computer_click` x,y are read in.
    pub async fn ocr(
        &self,
        target: ShotTarget,
        region: Option<[f64; 4]>,
        language: Option<String>,
    ) -> CResult<OcrOutput> {
        self.safety().check_alive()?;
        let side = self.inner.cfg.max_image_side;
        let (bounds, label, hwnd) = match &target {
            ShotTarget::Monitor(idx) => {
                let ms = self.run(|b| b.monitors()).await?;
                let i = idx.unwrap_or(0);
                let m = ms.get(i).ok_or_else(|| {
                    ComputerError::NotFound(format!("no monitor {i} (have {})", ms.len()))
                })?;
                (
                    m.bounds,
                    format!("monitor {i}{}", if m.primary { " (primary)" } else { "" }),
                    None,
                )
            }
            ShotTarget::Window(sel) => {
                let w = self.resolve_window(sel).await?;
                (w.bounds, format!("window \"{}\"", w.title), Some(w.hwnd))
            }
        };
        let full_map = ImageMap::fit(bounds, side);
        let raw = if let Some(r) = region {
            let phys = region_to_physical(&full_map, r)
                .map_err(ComputerError::Invalid)?
                .intersect(&bounds)
                .ok_or_else(|| ComputerError::Invalid("region is outside the screenshot".into()))?;
            self.run(move |b| b.capture_rect(phys)).await?
        } else if let Some(h) = hwnd {
            self.run(move |b| b.capture_window(h)).await?
        } else {
            self.run(move |b| b.capture_rect(bounds)).await?
        };
        let origin = raw.origin;
        let raw_lines = tokio::task::spawn_blocking(move || {
            crate::backend::ocr_recognize(&raw, language.as_deref())
        })
        .await
        .map_err(|e| ComputerError::Failed(format!("ocr task: {e}")))??;
        self.set_last_map(full_map);
        let lines = raw_lines
            .iter()
            .map(|l| map_line(l, origin, &full_map))
            .collect();
        Ok(OcrOutput {
            lines,
            map: full_map,
            label: if region.is_some() {
                format!("{label} (region)")
            } else {
                label
            },
        })
    }

    // ------------------------------------------------------------ guards

    async fn guard_hwnd(&self, hwnd: isize) -> CResult<WindowInfo> {
        let w = self
            .run(move |b| b.window_info(hwnd))
            .await?
            .ok_or_else(|| ComputerError::NotFound("the element's window is gone".into()))?;
        self.safety().check_process(&w.process)?;
        Ok(w)
    }

    async fn guard_point(&self, x: i32, y: i32) -> CResult<()> {
        if let Some(w) = self.run(move |b| b.window_at_point(x, y)).await? {
            self.safety().check_process(&w.process)?;
        }
        Ok(())
    }

    async fn guard_foreground(&self) -> CResult<()> {
        if let Some(w) = self.run(|b| b.foreground()).await? {
            self.safety().check_process(&w.process)?;
        }
        Ok(())
    }

    async fn map_for(
        &self,
        monitor: Option<usize>,
        window: Option<&WindowSel>,
    ) -> CResult<ImageMap> {
        let side = self.inner.cfg.max_image_side;
        if let Some(sel) = window {
            return Ok(ImageMap::fit(self.resolve_window(sel).await?.bounds, side));
        }
        if monitor.is_none() {
            if let Some(m) = self.inner.last_map.lock().ok().and_then(|g| *g) {
                return Ok(m);
            }
        }
        let ms = self.run(|b| b.monitors()).await?;
        let i = monitor.unwrap_or(0);
        let m = ms.get(i).ok_or_else(|| {
            ComputerError::NotFound(format!("no monitor {i} (have {})", ms.len()))
        })?;
        Ok(ImageMap::fit(m.bounds, side))
    }

    /// Screenshot-space point -> physical point (and policy check on what is there).
    pub async fn physical_point(
        &self,
        x: f64,
        y: f64,
        monitor: Option<usize>,
        window: Option<&WindowSel>,
    ) -> CResult<(i32, i32)> {
        let map = self.map_for(monitor, window).await?;
        if !map.contains(x, y) {
            return Err(ComputerError::Invalid(format!(
                "({x},{y}) is outside the screenshot ({}x{}); coordinates are in the last screenshot's pixel space",
                map.img_w, map.img_h
            )));
        }
        Ok(map.to_physical(x, y))
    }

    async fn target_point(&self, t: &ClickTarget) -> CResult<(i32, i32)> {
        match t {
            ClickTarget::Ref(r) => {
                let r = r.clone();
                let (rect, hwnd) = self.run(move |b| b.element_info(r)).await?;
                let w = self.guard_hwnd(hwnd).await?;
                if rect.is_empty() {
                    return Err(ComputerError::Invalid(
                        "element has no on-screen area".into(),
                    ));
                }
                if !w.focused {
                    self.run(move |b| b.window_op(hwnd, WindowAction::Focus, None))
                        .await?;
                }
                Ok(rect.center())
            }
            ClickTarget::Point {
                x,
                y,
                monitor,
                window,
            } => self.physical_point(*x, *y, *monitor, window.as_ref()).await,
        }
    }

    // ----------------------------------------------------------- actions

    pub async fn click(
        &self,
        target: &ClickTarget,
        button: MouseButton,
        count: u32,
        modifiers: &[String],
    ) -> CResult<String> {
        self.safety().check_action()?;
        let mods: Vec<KeyStep> = modifiers
            .iter()
            .map(|m| {
                modifier(&m.trim().to_lowercase())
                    .ok_or_else(|| ComputerError::Invalid(format!("unknown modifier \"{m}\"")))
            })
            .collect::<CResult<_>>()?;
        let (x, y) = self.target_point(target).await?;
        self.guard_point(x, y).await?;
        let t = self.timing();
        self.run(move |b| b.click(x, y, button, count, mods, t))
            .await?;
        Ok(format!(
            "{}{:?}-clicked at screen ({x},{y})",
            if count > 1 { "double " } else { "" },
            button
        ))
    }

    pub async fn type_text(&self, text: &str, target: Option<&str>) -> CResult<String> {
        self.safety().check_action()?;
        if let Some(r) = target {
            self.act(r, ElementAction::Focus, None).await?;
        }
        self.guard_foreground().await?;
        let (t, s) = (self.timing(), text.to_string());
        self.run(move |b| b.type_text(s, t)).await?;
        Ok(format!("typed {} characters", text.chars().count()))
    }

    pub async fn press_keys(&self, keys: &str) -> CResult<String> {
        self.safety().check_action()?;
        let chords = parse_keys(keys).map_err(ComputerError::Invalid)?;
        self.guard_foreground().await?;
        let t = self.timing();
        self.run(move |b| b.press_keys(chords, t)).await?;
        Ok(format!("pressed {keys}"))
    }

    pub async fn scroll(
        &self,
        at: Option<&ClickTarget>,
        dir: ScrollDir,
        amount: u32,
    ) -> CResult<String> {
        self.safety().check_action()?;
        let pt = match at {
            Some(t) => {
                let p = self.target_point(t).await?;
                self.guard_point(p.0, p.1).await?;
                Some(p)
            }
            None => {
                self.guard_foreground().await?;
                None
            }
        };
        let t = self.timing();
        self.run(move |b| b.scroll(pt, dir, amount, t)).await?;
        Ok(format!("scrolled {dir:?} by {amount}"))
    }

    pub async fn drag(
        &self,
        from: (f64, f64),
        to: (f64, f64),
        monitor: Option<usize>,
        window: Option<&WindowSel>,
        button: MouseButton,
    ) -> CResult<String> {
        self.safety().check_action()?;
        let a = self.physical_point(from.0, from.1, monitor, window).await?;
        let b2 = self.physical_point(to.0, to.1, monitor, window).await?;
        self.guard_point(a.0, a.1).await?;
        self.guard_point(b2.0, b2.1).await?;
        let t = self.timing();
        self.run(move |b| b.drag(a, b2, button, t)).await?;
        Ok(format!(
            "dragged screen ({},{}) -> ({},{})",
            a.0, a.1, b2.0, b2.1
        ))
    }

    pub async fn act(
        &self,
        r: &str,
        action: ElementAction,
        value: Option<&str>,
    ) -> CResult<String> {
        self.safety().check_action()?;
        let rr = r.to_string();
        let (_, hwnd) = self.run(move |b| b.element_info(rr)).await?;
        self.guard_hwnd(hwnd).await?;
        let (rr, v, t) = (r.to_string(), value.map(str::to_string), self.timing());
        self.run(move |b| b.act(rr, action, v, t)).await
    }

    pub async fn window_op(
        &self,
        sel: &WindowSel,
        action: WindowAction,
        rect: Option<Rect>,
    ) -> CResult<String> {
        self.safety().check_action()?;
        let w = self.resolve_window(sel).await?;
        let h = w.hwnd;
        let msg = self.run(move |b| b.window_op(h, action, rect)).await?;
        Ok(format!("\"{}\": {msg}", w.title))
    }

    pub async fn launch(&self, app: &str, args: Option<&str>) -> CResult<String> {
        self.safety().check_action()?;
        self.safety().check_process(app)?;
        let (a, g, to) = (
            app.to_string(),
            args.map(str::to_string),
            self.inner.cfg.launch_timeout_ms,
        );
        let res = self.run(move |b| b.launch(a, g, to)).await?;
        match res.window {
            Some(w) => {
                let note = match self.safety().check_process(&w.process) {
                    Ok(()) => String::new(),
                    Err(e) => format!(" (note: {e})"),
                };
                Ok(format!(
                    "launched `{}`; window \"{}\" [{}, hwnd={}] appeared{note}",
                    res.resolved, w.title, w.process, w.hwnd
                ))
            }
            None => Ok(format!(
                "started `{}`{} but no new window appeared within {} ms; use computer_windows to look for it",
                res.resolved,
                res.pid.map(|p| format!(" (pid {p})")).unwrap_or_default(),
                to
            )),
        }
    }

    // ------------------------------------------------------- observation

    /// Fresh bounded view of the active window: interactive snapshot, or a small
    /// screenshot when the window exposes no useful UIA tree. Never fails.
    pub async fn observe(&self) -> Vec<Block> {
        let cfg = &self.inner.cfg;
        if !cfg.observe || self.safety().check_alive().is_err() {
            return Vec::new();
        }
        tokio::time::sleep(Duration::from_millis(cfg.settle_ms)).await;
        let fg = match self.run(|b| b.foreground()).await {
            Ok(Some(w)) => w,
            _ => return Vec::new(),
        };
        if let Err(e) = self.safety().check_process(&fg.process) {
            return vec![Block::text(format!(
                "[Active window \"{}\" ({}) is off limits: {e}]",
                fg.title, fg.process
            ))];
        }
        let opts = SnapshotOptions {
            interactive_only: true,
            max_depth: 12,
            max_nodes: 800,
            max_chars: cfg.observe_max_chars,
        };
        let snap = if fg.minimized {
            None
        } else {
            self.run(move |b| b.snapshot(fg.clone(), opts)).await.ok()
        };
        if let Some(s) = snap.as_ref().filter(|s| s.ref_count >= 3) {
            return vec![Block::text(render_snapshot(s))];
        }
        let hwnd = match self.run(|b| b.foreground()).await {
            Ok(Some(w)) => w.hwnd,
            _ => return Vec::new(),
        };
        let shot = async {
            let raw = self.run(move |b| b.capture_window(hwnd)).await?;
            let (bytes, media_type, map) = self.encode(raw, cfg.observe_image_side).await?;
            self.set_last_map(map);
            Ok::<_, ComputerError>(Screenshot {
                bytes,
                media_type,
                map,
                label: "the active window (no usable accessibility tree)".into(),
            })
        }
        .await;
        match shot {
            Ok(s) => s.to_blocks(),
            Err(_) => snap
                .map(|s| vec![Block::text(render_snapshot(&s))])
                .unwrap_or_default(),
        }
    }
}

/// Header + tree text for a snapshot.
pub fn render_snapshot(s: &Snapshot) -> String {
    let w = &s.window;
    let mut out = format!(
        "Window \"{}\" [{}, pid {}, hwnd={}] at ({},{},{},{}) - {} nodes, {} refs{}\n",
        w.title,
        w.process,
        w.pid,
        w.hwnd,
        w.bounds.x,
        w.bounds.y,
        w.bounds.w,
        w.bounds.h,
        s.node_count,
        s.ref_count,
        if s.truncated { " (tree truncated)" } else { "" }
    );
    out.push_str(if s.text.is_empty() {
        "(no accessible elements found)"
    } else {
        &s.text
    });
    out.push_str("\nRefs are valid until this window is snapshotted again. Rects are physical screen pixels.");
    out
}
