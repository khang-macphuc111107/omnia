//! The platform boundary. [`Backend`] lives on one dedicated OS thread (the
//! "worker") because UI Automation / COM objects and thread-level DPI awareness
//! are thread-bound. On non-Windows targets every method reports "unsupported".

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc;

use tokio::sync::oneshot;

use crate::bg::BgWindow;
use crate::keys::{KeyChord, KeyStep};
use crate::types::*;
use crate::ComputerError;

pub type CResult<T> = Result<T, ComputerError>;

pub struct Backend {
    #[cfg(windows)]
    uia: Option<crate::uia::Uia>,
}

#[cfg(windows)]
impl Default for Backend {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
impl Backend {
    pub fn new() -> Self {
        crate::winapi::init_thread();
        Self { uia: None }
    }

    fn uia(&mut self) -> CResult<&mut crate::uia::Uia> {
        if self.uia.is_none() {
            self.uia = Some(crate::uia::Uia::new()?);
        }
        Ok(self.uia.as_mut().expect("just initialised"))
    }

    pub fn monitors(&mut self) -> CResult<Vec<MonitorInfo>> {
        crate::winapi::monitors()
    }
    pub fn windows(&mut self) -> CResult<Vec<WindowInfo>> {
        crate::winapi::list_windows()
    }
    pub fn window_info(&mut self, hwnd: isize) -> CResult<Option<WindowInfo>> {
        Ok(crate::winapi::window_info(hwnd))
    }
    pub fn foreground(&mut self) -> CResult<Option<WindowInfo>> {
        Ok(crate::winapi::foreground())
    }
    pub fn window_at_point(&mut self, x: i32, y: i32) -> CResult<Option<WindowInfo>> {
        Ok(crate::winapi::window_at_point(x, y))
    }
    pub fn capture_rect(&mut self, r: Rect) -> CResult<RawImage> {
        crate::screen::capture_rect(r)
    }
    pub fn capture_window(&mut self, hwnd: isize) -> CResult<RawImage> {
        crate::screen::capture_window(hwnd)
    }
    pub fn click(
        &mut self,
        x: i32,
        y: i32,
        button: MouseButton,
        count: u32,
        mods: Vec<KeyStep>,
        t: InputTiming,
    ) -> CResult<()> {
        crate::input::click(x, y, button, count, &mods, &t)
    }
    pub fn drag(
        &mut self,
        from: (i32, i32),
        to: (i32, i32),
        button: MouseButton,
        t: InputTiming,
    ) -> CResult<()> {
        crate::input::drag(from, to, button, &t)
    }
    pub fn scroll(
        &mut self,
        at: Option<(i32, i32)>,
        dir: ScrollDir,
        notches: u32,
        t: InputTiming,
    ) -> CResult<()> {
        crate::input::scroll(at, dir, notches, &t)
    }
    pub fn type_text(&mut self, text: String, t: InputTiming) -> CResult<()> {
        crate::input::type_text(&text, &t)
    }
    pub fn press_keys(&mut self, chords: Vec<KeyChord>, t: InputTiming) -> CResult<()> {
        crate::input::press_keys(&chords, &t)
    }
    pub fn window_op(
        &mut self,
        hwnd: isize,
        action: WindowAction,
        rect: Option<Rect>,
    ) -> CResult<String> {
        crate::winapi::window_op(hwnd, action, rect)
    }
    pub fn bg_list(&mut self) -> CResult<Vec<BgWindow>> {
        crate::bgwin::bg_list()
    }
    pub fn bg_info(&mut self, hwnd: isize) -> CResult<Option<BgWindow>> {
        Ok(crate::bgwin::bg_info(hwnd))
    }
    pub fn bg_capture(&mut self, hwnd: isize) -> CResult<RawImage> {
        crate::screen::capture_window_client(hwnd)
    }
    pub fn bg_restore(&mut self, hwnd: isize) -> CResult<(bool, String)> {
        crate::bgwin::bg_restore(hwnd)
    }
    pub fn bg_click(
        &mut self,
        hwnd: isize,
        x: i32,
        y: i32,
        button: MouseButton,
        double: bool,
        t: InputTiming,
    ) -> CResult<(String, isize)> {
        crate::bgwin::bg_click(hwnd, x, y, button, double, &t)
    }
    pub fn bg_type(
        &mut self,
        hwnd: isize,
        units: Vec<u16>,
        hint: Option<isize>,
        t: InputTiming,
    ) -> CResult<String> {
        crate::bgwin::bg_type(hwnd, &units, hint, &t)
    }
    pub fn bg_key(
        &mut self,
        hwnd: isize,
        chords: Vec<KeyChord>,
        hint: Option<isize>,
        t: InputTiming,
    ) -> CResult<String> {
        crate::bgwin::bg_key(hwnd, &chords, hint, &t)
    }
    pub fn launch(
        &mut self,
        app: String,
        args: Option<String>,
        timeout_ms: u64,
    ) -> CResult<LaunchResult> {
        crate::launch::launch(&app, args.as_deref(), timeout_ms)
    }
    pub fn snapshot(&mut self, window: WindowInfo, opts: SnapshotOptions) -> CResult<Snapshot> {
        self.uia()?.snapshot(&window, &opts)
    }
    pub fn element_info(&mut self, r: String) -> CResult<(Rect, isize)> {
        self.uia()?.element_info(&r)
    }
    pub fn act(
        &mut self,
        r: String,
        action: ElementAction,
        value: Option<String>,
        t: InputTiming,
    ) -> CResult<String> {
        self.uia()?.act(&r, action, value.as_deref(), &t)
    }
}

#[cfg(not(windows))]
impl Backend {
    pub fn new() -> Self {
        Self {}
    }
}

#[cfg(not(windows))]
macro_rules! unsupported {
    ($($name:ident($($arg:ident : $ty:ty),*) -> $ret:ty;)*) => {
        impl Backend {
            $(pub fn $name(&mut self, $($arg: $ty),*) -> CResult<$ret> {
                $(let _ = $arg;)*
                Err(ComputerError::Unsupported)
            })*
        }
    };
}

#[cfg(not(windows))]
unsupported! {
    monitors() -> Vec<MonitorInfo>;
    windows() -> Vec<WindowInfo>;
    window_info(hwnd: isize) -> Option<WindowInfo>;
    foreground() -> Option<WindowInfo>;
    window_at_point(x: i32, y: i32) -> Option<WindowInfo>;
    capture_rect(r: Rect) -> RawImage;
    capture_window(hwnd: isize) -> RawImage;
    click(x: i32, y: i32, b: MouseButton, c: u32, m: Vec<KeyStep>, t: InputTiming) -> ();
    drag(a: (i32, i32), b: (i32, i32), btn: MouseButton, t: InputTiming) -> ();
    scroll(at: Option<(i32, i32)>, d: ScrollDir, n: u32, t: InputTiming) -> ();
    type_text(text: String, t: InputTiming) -> ();
    press_keys(c: Vec<KeyChord>, t: InputTiming) -> ();
    window_op(h: isize, a: WindowAction, r: Option<Rect>) -> String;
    bg_list() -> Vec<BgWindow>;
    bg_info(hwnd: isize) -> Option<BgWindow>;
    bg_capture(hwnd: isize) -> RawImage;
    bg_restore(hwnd: isize) -> (bool, String);
    bg_click(hwnd: isize, x: i32, y: i32, b: MouseButton, d: bool, t: InputTiming) -> (String, isize);
    bg_type(hwnd: isize, units: Vec<u16>, hint: Option<isize>, t: InputTiming) -> String;
    bg_key(hwnd: isize, c: Vec<KeyChord>, hint: Option<isize>, t: InputTiming) -> String;
    launch(app: String, args: Option<String>, timeout_ms: u64) -> LaunchResult;
    snapshot(w: WindowInfo, o: SnapshotOptions) -> Snapshot;
    element_info(r: String) -> (Rect, isize);
    act(r: String, a: ElementAction, v: Option<String>, t: InputTiming) -> String;
}

/// Blocking OCR over captured pixels (runs on a caller-provided blocking thread).
pub fn ocr_recognize(raw: &RawImage, language: Option<&str>) -> CResult<Vec<crate::ocr::OcrLine>> {
    #[cfg(windows)]
    {
        crate::ocr_win::recognize(raw, language)
    }
    #[cfg(not(windows))]
    {
        let _ = (raw, language);
        Err(ComputerError::Unsupported)
    }
}

type Job = Box<dyn FnOnce(&mut Backend) + Send>;

/// One OS thread owning the [`Backend`]; jobs run strictly in order.
pub struct Worker {
    tx: mpsc::Sender<Job>,
}

impl Worker {
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel::<Job>();
        let spawned = std::thread::Builder::new()
            .name("omnia-computer".into())
            .spawn(move || {
                let mut backend = Backend::new();
                while let Ok(job) = rx.recv() {
                    let _ = catch_unwind(AssertUnwindSafe(|| job(&mut backend)));
                }
            });
        if spawned.is_err() {
            // `run` will report the dead worker.
        }
        Self { tx }
    }

    pub async fn run<R, F>(&self, f: F) -> CResult<R>
    where
        R: Send + 'static,
        F: FnOnce(&mut Backend) -> CResult<R> + Send + 'static,
    {
        let (otx, orx) = oneshot::channel();
        let job: Job = Box::new(move |be| {
            let _ = otx.send(f(be));
        });
        self.tx
            .send(job)
            .map_err(|_| ComputerError::Failed("computer worker thread is not running".into()))?;
        orx.await.map_err(|_| {
            ComputerError::Failed("computer worker panicked while handling the request".into())
        })?
    }
}
