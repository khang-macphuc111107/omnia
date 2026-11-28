//! The shared handle: policy-checked, async operations on top of the worker.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;

use crate::backend::{Backend, CResult, Worker};
use crate::encode::{encode_image, sha256_hex, ImageFormat};
use crate::geometry::{match_window, ImageMap};
use crate::keys::{modifier, parse_keys, KeyStep};
use crate::ocr::{map_line, region_to_physical, OcrLine};
use crate::safety::{ComputerPolicy, KillSwitch, ProcessIdentity, Safety};
use crate::tools::ContentBlock;
use crate::types::*;
use crate::ComputerError;

#[derive(Clone)]
pub struct ComputerConfig {
    pub policy: ComputerPolicy,
    /// Long side of screenshots sent to the model.
    pub max_image_side: u32,
    pub image_format: ImageFormat,
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
            image_format: ImageFormat::Png,
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
    pub sha256: String,
    pub map: ImageMap,
    pub label: String,
}

impl Screenshot {
    pub fn to_blocks(&self) -> Vec<ContentBlock> {
        let m = &self.map;
        vec![
            ContentBlock::Image {
                media_type: self.media_type.into(),
                data: base64::engine::general_purpose::STANDARD.encode(&self.bytes),
            },
            ContentBlock::text(format!(
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
    /// Known `(pid, process_create_time_100ns)` per HWND to catch PID/HWND reuse.
    known_identities: Mutex<HashMap<isize, ProcessIdentity>>,
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
                known_identities: Mutex::new(HashMap::new()),
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

    pub(crate) fn remember_identity(&self, hwnd: isize, id: ProcessIdentity) {
        if hwnd != 0 && id.pid != 0 {
            if let Ok(mut g) = self.inner.known_identities.lock() {
                g.insert(hwnd, id);
            }
        }
    }

    pub(crate) fn expected_identity(&self, hwnd: isize) -> Option<ProcessIdentity> {
        self.inner
            .known_identities
            .lock()
            .ok()
            .and_then(|g| g.get(&hwnd).copied())
    }

    pub(crate) fn verify_or_remember_identity(
        &self,
        hwnd: isize,
        expected: Option<ProcessIdentity>,
        observed: ProcessIdentity,
    ) -> CResult<()> {
        let exp = expected.or_else(|| self.expected_identity(hwnd));
        self.safety().check_identity(exp, observed)?;
        if exp.is_none() {
            self.remember_identity(hwnd, observed);
        }
        Ok(())
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
        let list = self.run(|b| b.windows()).await?;
        for w in &list {
            self.remember_identity(w.hwnd, ProcessIdentity::new(w.pid, w.process_create_time_100ns));
        }
        Ok(list)
    }

    /// Resolve a window selector and enforce the app policy and PID-reuse guard on it.
    pub async fn resolve_window(&self, sel: &WindowSel) -> CResult<WindowInfo> {
        self.safety().check_alive()?;
        let w = match sel {
            WindowSel::Focused => {
                let w = self
                    .run(|b| b.foreground())
                    .await?
                    .ok_or_else(|| ComputerError::NotFound("no focused window".into()))?;
                self.remember_identity(w.hwnd, ProcessIdentity::new(w.pid, w.process_create_time_100ns));
                w
            }
            WindowSel::Hwnd(h) => {
                let h = *h;
                let w = self
                    .run(move |b| b.window_info(h))
                    .await?
                    .ok_or_else(|| ComputerError::NotFound(format!("no window with hwnd {h}")))?;
                self.verify_or_remember_identity(
                    w.hwnd,
                    None,
                    ProcessIdentity::new(w.pid, w.process_create_time_100ns),
                )?;
                w
            }
            WindowSel::Title(_) => {
                let all = self.run(|b| b.windows()).await?;
                let w = match_window(&all, sel).map_err(ComputerError::NotFound)?.clone();
                self.remember_identity(w.hwnd, ProcessIdentity::new(w.pid, w.process_create_time_100ns));
                w
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
        let w = self.resolve_window(sel.unwrap_or(&WindowSel::Focused)).await?;
        if w.minimized {
            return Err(ComputerError::Invalid(
                "window is minimized; restore it first (computer_window restore)".into(),
            ));
        }
        self.remember_identity(w.hwnd, ProcessIdentity::new(w.pid, w.process_create_time_100ns));
        self.run(move |b| b.snapshot(w, opts)).await
    }

    async fn encode(
        &self,
        raw: RawImage,
        side: u32,
    ) -> CResult<(Vec<u8>, &'static str, String, ImageMap)> {
        let fmt = self.inner.cfg.image_format;
        let join = tokio::task::spawn_blocking(move || {
            let enc = encode_image(&raw, side, fmt)?;
            let hash = sha256_hex(&enc.bytes);
            let map = ImageMap {
                origin: raw.origin,
                src_w: raw.width,
                src_h: raw.height,
                img_w: enc.width,
                img_h: enc.height,
            };
            Ok::<_, ComputerError>((enc.bytes, fmt.media_type(), hash, map))
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
        let (bytes, media_type, sha256, map) = self.encode(raw, side).await?;
        self.set_last_map(map);
        Ok(Screenshot {
            bytes,
            media_type,
            sha256,
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
        let raw_lines =
            tokio::task::spawn_blocking(move || crate::backend::ocr_recognize(&raw, language.as_deref()))
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

    async fn guard_hwnd(
        &self,
        hwnd: isize,
        expected: Option<ProcessIdentity>,
    ) -> CResult<WindowInfo> {
        let w = self
            .run(move |b| b.window_info(hwnd))
            .await?
            .ok_or_else(|| ComputerError::NotFound("the element's window is gone".into()))?;
        self.verify_or_remember_identity(
            w.hwnd,
            expected,
            ProcessIdentity::new(w.pid, w.process_create_time_100ns),
        )?;
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
                let (rect, hwnd, expected_id) = self.run(move |b| b.element_info(r)).await?;
                let w = self.guard_hwnd(hwnd, Some(expected_id)).await?;
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

    pub async fn act(&self, r: &str, action: ElementAction, value: Option<&str>) -> CResult<String> {
        self.safety().check_action()?;
        let rr = r.to_string();
        let (_, hwnd, expected_id) = self.run(move |b| b.element_info(rr)).await?;
        self.guard_hwnd(hwnd, Some(expected_id)).await?;
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
                self.remember_identity(w.hwnd, ProcessIdentity::new(w.pid, w.process_create_time_100ns));
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
    pub async fn observe(&self) -> Vec<ContentBlock> {
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
            return vec![ContentBlock::text(format!(
                "[Active window \"{}\" ({}) is off limits: {e}]",
                fg.title, fg.process
            ))];
        }
        self.remember_identity(fg.hwnd, ProcessIdentity::new(fg.pid, fg.process_create_time_100ns));
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
            return vec![ContentBlock::text(render_snapshot(s))];
        }
        let hwnd = match self.run(|b| b.foreground()).await {
            Ok(Some(w)) => w.hwnd,
            _ => return Vec::new(),
        };
        let shot = async {
            let raw = self.run(move |b| b.capture_window(hwnd)).await?;
            let (bytes, media_type, sha256, map) =
                self.encode(raw, cfg.observe_image_side).await?;
            self.set_last_map(map);
            Ok::<_, ComputerError>(Screenshot {
                bytes,
                media_type,
                sha256,
                map,
                label: "the active window (no usable accessibility tree)".into(),
            })
        }
        .await;
        match shot {
            Ok(s) => s.to_blocks(),
            Err(_) => snap
                .map(|s| vec![ContentBlock::text(render_snapshot(&s))])
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
    out.push_str(
        "\nRefs are valid until this window is snapshotted again. Rects are physical screen pixels.",
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_uses_yolo_policy_and_pure_rust_png() {
        let cfg = ComputerConfig::default();
        assert_eq!(cfg.policy, ComputerPolicy::unrestricted_default());
        assert_eq!(cfg.policy.max_actions_per_minute, 0);
        assert_eq!(cfg.image_format, ImageFormat::Png);
        assert_eq!(cfg.max_image_side, 1568);
        assert!(cfg.observe);
    }

    #[test]
    fn screenshot_to_blocks_emits_base64_image_and_coordinate_guide() {
        let shot = Screenshot {
            bytes: vec![0x89, b'P', b'N', b'G'],
            media_type: "image/png",
            sha256: sha256_hex(&[0x89, b'P', b'N', b'G']),
            map: ImageMap::fit(Rect::new(-1920, 0, 1920, 1080), 960),
            label: "monitor 1".into(),
        };
        let blocks = shot.to_blocks();
        assert_eq!(blocks.len(), 2);
        assert!(matches!(&blocks[0], ContentBlock::Image { media_type, data } if media_type == "image/png" && !data.is_empty()));
        match &blocks[1] {
            ContentBlock::Text { text } => {
                assert!(text.contains("960x540"));
                assert!(text.contains("screen (-1920,0)"));
            }
            _ => panic!("expected text block"),
        }
    }

    #[test]
    fn known_identities_detect_pid_reuse_between_discovery_and_action() {
        let c = Computer::new(ComputerConfig::default());
        let orig = ProcessIdentity::new(500, 133_758_000_000_000_001);
        c.remember_identity(42, orig);
        assert!(c.verify_or_remember_identity(42, None, orig).is_ok());

        let reused = ProcessIdentity::new(500, 133_758_000_000_000_999);
        assert!(matches!(
            c.verify_or_remember_identity(42, None, reused),
            Err(ComputerError::StaleTarget(_))
        ));
    }

    #[test]
    fn render_snapshot_formats_header_and_empty_fallback() {
        let s = Snapshot {
            window: WindowInfo {
                hwnd: 99,
                title: "Editor".into(),
                process: "notepad.exe".into(),
                pid: 123,
                process_create_time_100ns: 1000,
                class: "Notepad".into(),
                bounds: Rect::new(10, 20, 800, 600),
                minimized: false,
                focused: true,
            },
            text: String::new(),
            node_count: 0,
            ref_count: 0,
            truncated: true,
        };
        let rendered = render_snapshot(&s);
        assert!(rendered.contains("Window \"Editor\" [notepad.exe, pid 123, hwnd=99]"));
        assert!(rendered.contains("(tree truncated)"));
        assert!(rendered.contains("(no accessible elements found)"));
    }
}
