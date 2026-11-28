//! Isolated Chromium/Edge Launcher (`D:\OmniaData\tmp\omnia-cdp-*`, zero-race
//! `--remote-debugging-port=0` + `DevToolsActivePort` polling, strictly rejecting Thorium)
//! and Multiplexed WebSocket CDP Session Client (`PendingCallGuard`, `8192`-slot event bus,
//! `2000`-entry `NetworkRing` + `replay_spec()`, auto JS dialog handling, multi-tab + OOPIF
//! `Target.setAutoAttach`, event-driven `settle()`/`wait_for()`, WeakMap `[ref=eN]` ARIA
//! snapshots, `browser_batch`, and Virtual Cursor Overlay).

use crate::browser_cdp::validate_loopback_cdp_url;
use crate::browser_network::{
    ConsoleEntry, ConsoleRing, DialogPolicy, DialogRecord, NetworkEntry, NetworkFilter,
    NetworkRing, ReplayRequestSpec, CONSOLE_RING_CAPACITY, DIALOG_RING_CAPACITY,
    NETWORK_RING_CAPACITY,
};
use crate::browser_snapshot::{
    build_snapshot_eval_js, parse_snapshot_json, DomSnapshotOptions, DomSnapshotResult,
};
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, oneshot, watch, Mutex as AsyncMutex};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message as WsMessage;

const DEFAULT_CDP_HTTP_TIMEOUT_MS: u64 = 2_500;
const CDP_MAX_WS_BYTES: usize = 256 << 20; // 256 MiB for full-page screenshots / MHTML
const CDP_EVENT_BUS_CAPACITY: usize = 8_192;
const BLOB_CHUNK_BYTES: usize = 786_432; // 768 KiB -> base64 < 1 MiB per CDP round-trip

fn validate_cdp_http_url(raw_url: &str) -> Result<(), String> {
    let validated = validate_loopback_cdp_url(raw_url).map_err(|e| e.to_string())?;
    let scheme = validated.scheme.as_str();
    if scheme != "http" && scheme != "https" {
        return Err(format!("expected http/https CDP URL, got `{scheme}`"));
    }
    Ok(())
}

fn validate_cdp_ws_url(raw_url: &str) -> Result<(), String> {
    let validated = validate_loopback_cdp_url(raw_url).map_err(|e| e.to_string())?;
    let scheme = validated.scheme.as_str();
    if scheme != "ws" && scheme != "wss" {
        return Err(format!("expected ws/wss CDP URL, got `{scheme}`"));
    }
    Ok(())
}

static PROFILE_SEQ: AtomicU64 = AtomicU64::new(1);

/// Lightweight cancellation token built on `tokio::sync::watch` (zero extra crate deps).
#[derive(Clone, Debug)]
struct CancelToken {
    tx: Arc<watch::Sender<bool>>,
    rx: watch::Receiver<bool>,
}

impl CancelToken {
    fn new() -> Self {
        let (tx, rx) = watch::channel(false);
        Self {
            tx: Arc::new(tx),
            rx,
        }
    }

    fn cancel(&self) {
        let _ = self.tx.send(true);
    }

    fn is_cancelled(&self) -> bool {
        *self.rx.borrow()
    }

    async fn cancelled(&self) {
        let mut rx = self.rx.clone();
        if *rx.borrow() {
            return;
        }
        while rx.changed().await.is_ok() {
            if *rx.borrow() {
                return;
            }
        }
    }
}

/// Options controlling isolated browser process launch for agentic CDP sessions.
#[derive(Debug, Clone)]
pub struct IsolatedBrowserLaunchOptions {
    /// Optional explicit Chromium/Edge executable path (must NEVER be Thorium).
    pub browser_bin: Option<String>,
    /// Parent temp root for isolated user-data-dir (defaults to `D:\OmniaData\tmp`).
    pub temp_root: Option<PathBuf>,
    pub headless: bool,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub startup_timeout_ms: u64,
    pub initial_url: Option<String>,
}

impl Default for IsolatedBrowserLaunchOptions {
    fn default() -> Self {
        Self {
            browser_bin: None,
            temp_root: None,
            headless: true,
            viewport_width: 1280,
            viewport_height: 800,
            startup_timeout_ms: 15_000,
            initial_url: Some("about:blank".into()),
        }
    }
}

/// Live handle owning an isolated headless/windowed Chromium/Edge process via Win32 JobObject.
#[derive(Debug)]
pub struct IsolatedBrowserHandle {
    pub pid: u32,
    pub executable: PathBuf,
    pub user_data_dir: PathBuf,
    pub debug_port: u16,
    pub http_url: String,
    pub ws_browser_url: String,
    job_raw: usize,
    cleanup_profile_on_drop: bool,
}

impl IsolatedBrowserHandle {
    /// Gracefully terminates the browser job object and removes its temporary profile directory.
    pub fn shutdown(mut self) {
        self.cleanup_inner();
    }

    fn cleanup_inner(&mut self) {
        if self.job_raw != 0 {
            omnia_workspace_ops::win32_window::close_job_handle(self.job_raw);
            self.job_raw = 0;
        }
        if self.cleanup_profile_on_drop {
            let _ = std::fs::remove_dir_all(&self.user_data_dir);
        }
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "pid": self.pid,
            "executable": self.executable.to_string_lossy(),
            "user_data_dir": self.user_data_dir.to_string_lossy(),
            "debug_port": self.debug_port,
            "http_url": self.http_url,
            "ws_browser_url": self.ws_browser_url,
        })
    }
}

impl Drop for IsolatedBrowserHandle {
    fn drop(&mut self) {
        self.cleanup_inner();
    }
}

/// Rejects any path pointing to user's Thorium browser or live browser profiles.
#[must_use]
pub fn is_forbidden_live_browser_path(path: &Path) -> bool {
    let lower = path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    lower.contains("thorium")
        || lower.contains("\\microsoft\\edge\\user data")
        || lower.contains("\\google\\chrome\\user data")
        || lower.contains("\\brave-browser\\user data")
}

/// Discovers a valid non-Thorium Chromium/Edge executable on the host (`OMNIA_BROWSER_BIN`,
/// `ms-playwright`, Chrome/Edge Program Files, and `LOCALAPPDATA` EdgeCore).
pub fn resolve_isolated_browser_binary(override_bin: Option<&str>) -> Result<PathBuf, String> {
    if let Some(raw) = override_bin.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(raw);
        if is_forbidden_live_browser_path(&p) {
            return Err(format!(
                "refusing forbidden browser executable `{}` (live Thorium/user profile protected)",
                p.display()
            ));
        }
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!(
            "explicit browser executable does not exist: `{}`",
            p.display()
        ));
    }

    if let Ok(env_bin) = std::env::var("OMNIA_BROWSER_BIN") {
        let trimmed = env_bin.trim();
        if !trimmed.is_empty() {
            let p = PathBuf::from(trimmed);
            if is_forbidden_live_browser_path(&p) {
                return Err("OMNIA_BROWSER_BIN points to forbidden Thorium path".into());
            }
            if p.is_file() {
                return Ok(p);
            }
        }
    }

    let mut local_roots: Vec<PathBuf> = Vec::new();
    if let Some(la) = std::env::var_os("LOCALAPPDATA") {
        local_roots.push(PathBuf::from(la));
    }
    for drive_root in [r"E:\Users", r"C:\Users"] {
        if let Ok(users) = std::fs::read_dir(drive_root) {
            for user_entry in users.flatten() {
                local_roots.push(user_entry.path().join("AppData").join("Local"));
            }
        }
    }

    // 1. Prefer isolated automation Chromium installs (`ms-playwright`) before system browsers.
    let mut candidates: Vec<PathBuf> = Vec::new();
    for local_app in &local_roots {
        let pw_dir = local_app.join("ms-playwright");
        if let Ok(pw_vers) = std::fs::read_dir(&pw_dir) {
            for ver in pw_vers.flatten() {
                candidates.push(ver.path().join("chrome-win64").join("chrome.exe"));
                candidates.push(ver.path().join("chrome-win").join("chrome.exe"));
                candidates.push(
                    ver.path()
                        .join("chrome-headless-shell-win64")
                        .join("chrome-headless-shell.exe"),
                );
            }
        }
    }

    // 2. Installed full Chrome / Edge executables (strictly launched with isolated temp profile).
    candidates.extend([
        PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        PathBuf::from(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    ]);

    // 3. EdgeCore fallback last.
    for local_app in &local_roots {
        let edge_core = local_app.join("Microsoft").join("EdgeCore");
        if let Ok(vers) = std::fs::read_dir(&edge_core) {
            for ver in vers.flatten() {
                candidates.push(ver.path().join("msedge.exe"));
            }
        }
    }

    for cand in candidates {
        if !is_forbidden_live_browser_path(&cand) && cand.is_file() {
            return Ok(cand);
        }
    }

    Err("no isolated Edge/Chrome/Chromium binary found on host (Thorium strictly excluded)".into())
}

/// Computes an isolated `--user-data-dir` strictly under `D:\OmniaData\tmp\omnia-cdp-*` (or custom temp root).
pub fn create_isolated_profile_dir(temp_root: Option<&Path>) -> Result<PathBuf, String> {
    let base = match temp_root {
        Some(p) => p.to_path_buf(),
        None => {
            let omnia_tmp = PathBuf::from(r"D:\OmniaData\tmp");
            if Path::new(r"D:\OmniaData").exists() {
                omnia_tmp
            } else {
                std::env::temp_dir().join("omnia-cdp-profiles")
            }
        }
    };
    if is_forbidden_live_browser_path(&base) {
        return Err(format!(
            "refusing live browser profile path `{}`",
            base.display()
        ));
    }
    std::fs::create_dir_all(&base)
        .map_err(|e| format!("create temp root `{}`: {e}", base.display()))?;
    let seq = PROFILE_SEQ.fetch_add(1, Ordering::Relaxed);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let mut hasher = Sha256::new();
    hasher.update(format!("{}:{}:{}", std::process::id(), ts, seq).as_bytes());
    let digest = hasher.finalize();
    let short_hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
    let profile_dir = base.join(format!("omnia-cdp-{short_hex}"));
    std::fs::create_dir_all(&profile_dir)
        .map_err(|e| format!("create isolated profile dir `{}`: {e}", profile_dir.display()))?;
    Ok(profile_dir)
}

/// Parses Chromium's `{user-data-dir}/DevToolsActivePort` file (`<port>\n</devtools/browser/...>`).
pub fn parse_devtools_active_port(content: &str) -> Option<(u16, Option<String>)> {
    let mut lines = content.lines().map(str::trim).filter(|l| !l.is_empty());
    let port: u16 = lines.next()?.parse().ok().filter(|&p| p > 0)?;
    let ws_path = lines
        .next()
        .filter(|p| p.starts_with('/'))
        .map(str::to_string);
    Some((port, ws_path))
}

/// Launches an isolated headless/windowed Chromium/Edge browser using zero-race
/// `--remote-debugging-port=0` and polling `{user-data-dir}/DevToolsActivePort`.
pub async fn launch_isolated_browser(
    opts: IsolatedBrowserLaunchOptions,
) -> Result<IsolatedBrowserHandle, String> {
    let exe = resolve_isolated_browser_binary(opts.browser_bin.as_deref())?;
    let user_data_dir = create_isolated_profile_dir(opts.temp_root.as_deref())?;
    let active_port_file = user_data_dir.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&active_port_file);

    let mut args = vec![
        "--remote-debugging-port=0".into(),
        "--remote-debugging-address=127.0.0.1".into(),
        "--remote-allow-origins=http://127.0.0.1,http://localhost".into(),
        format!("--user-data-dir={}", user_data_dir.to_string_lossy()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-background-networking".into(),
        "--disable-sync".into(),
        "--disable-extensions".into(),
        "--disable-blink-features=AutomationControlled".into(),
        format!(
            "--window-size={},{}",
            opts.viewport_width, opts.viewport_height
        ),
    ];
    if opts.headless {
        args.push("--headless=new".into());
        args.push("--disable-gpu".into());
    }
    args.push(
        opts.initial_url
            .clone()
            .unwrap_or_else(|| "about:blank".into()),
    );

    let (pid, job_raw) = omnia_workspace_ops::win32_window::spawn_hidden_suspended_detached(
        &exe.to_string_lossy(),
        &args,
        &user_data_dir,
        &BTreeMap::new(),
    )?;

    let deadline = tokio::time::Instant::now()
        + Duration::from_millis(opts.startup_timeout_ms.clamp(2_000, 45_000));
    let (port, ws_browser_url) = loop {
        if let Ok(raw) = std::fs::read_to_string(&active_port_file) {
            if let Some((port, ws_path)) = parse_devtools_active_port(&raw) {
                let ws_url = if let Some(path) = ws_path {
                    format!("ws://127.0.0.1:{port}{path}")
                } else {
                    match probe_json_version_ws_url(port).await {
                        Ok(Some(ws)) => ws,
                        _ => {
                            if tokio::time::Instant::now() >= deadline {
                                omnia_workspace_ops::win32_window::close_job_handle(job_raw);
                                let _ = std::fs::remove_dir_all(&user_data_dir);
                                return Err(format!(
                                    "timed out resolving /json/version on 127.0.0.1:{port}"
                                ));
                            }
                            tokio::time::sleep(Duration::from_millis(80)).await;
                            continue;
                        }
                    }
                };
                break (port, ws_url);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            omnia_workspace_ops::win32_window::close_job_handle(job_raw);
            let _ = std::fs::remove_dir_all(&user_data_dir);
            return Err("timed out waiting for DevToolsActivePort from isolated browser".into());
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    };

    let http_url = format!("http://127.0.0.1:{port}");
    validate_cdp_http_url(&http_url)?;
    validate_cdp_ws_url(&ws_browser_url)?;

    Ok(IsolatedBrowserHandle {
        pid,
        executable: exe,
        user_data_dir,
        debug_port: port,
        http_url,
        ws_browser_url,
        job_raw,
        cleanup_profile_on_drop: true,
    })
}

async fn probe_json_version_ws_url(port: u16) -> Result<Option<String>, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(DEFAULT_CDP_HTTP_TIMEOUT_MS);
    let mut stream = tokio::time::timeout(
        Duration::from_millis(DEFAULT_CDP_HTTP_TIMEOUT_MS),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .map_err(|_| "connect timeout".to_owned())?
    .map_err(|e| e.to_string())?;

    let req = format!(
        "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| e.to_string())?;

    let mut raw = Vec::with_capacity(1024);
    let mut buf = [0u8; 2048];
    let mut hdr_end: Option<usize> = None;
    let mut content_len: Option<usize> = None;

    loop {
        if let Some(hend) = hdr_end {
            if let Some(cl) = content_len {
                if raw.len() >= hend + cl {
                    break;
                }
            } else if serde_json::from_slice::<Value>(&raw[hend..]).is_ok() {
                break;
            }
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err("timed out reading /json/version".to_owned());
        }
        let n = tokio::time::timeout(deadline - now, stream.read(&mut buf))
            .await
            .map_err(|_| "read timeout on /json/version".to_owned())?
            .map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..n]);
        if hdr_end.is_none() {
            if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                let hend = pos + 4;
                let hdr_text = String::from_utf8_lossy(&raw[..pos]);
                for line in hdr_text.lines() {
                    if let Some((k, v)) = line.split_once(':') {
                        if k.trim().eq_ignore_ascii_case("content-length") {
                            content_len = v.trim().parse::<usize>().ok();
                        }
                    }
                }
                hdr_end = Some(hend);
            }
        }
    }

    let Some(hend) = hdr_end else {
        return Ok(None);
    };
    let end = content_len
        .map(|cl| hend.saturating_add(cl).min(raw.len()))
        .unwrap_or(raw.len());
    let val: Value = serde_json::from_slice(&raw[hend..end]).map_err(|e| e.to_string())?;
    Ok(val
        .get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .map(str::to_owned))
}

/// Broadcast CDP protocol event emitted by the multiplexed reader loop.
#[derive(Debug, Clone)]
pub struct CdpEvent {
    pub session_id: Option<String>,
    pub method: String,
    pub params: Value,
}

/// Metadata describing an open browser page target tracked by [`CdpSession`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserTabInfo {
    pub target_id: String,
    pub session_id: Option<String>,
    pub title: String,
    pub url: String,
    pub active: bool,
}

impl BrowserTabInfo {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "target_id": self.target_id,
            "session_id": self.session_id,
            "title": self.title,
            "url": crate::browser_network::redact_url(&self.url),
            "active": self.active,
        })
    }
}

/// Condition evaluated by [`CdpSession::wait_for`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitCondition {
    Text(String),
    TextGone(String),
    Selector(String),
    DelayMs(u64),
}

/// Target addressing priority for interactive browser actions (`Ref > Selector > Point`).
#[derive(Debug, Clone, PartialEq)]
pub enum ElementTarget {
    Ref(String),
    Selector(String),
    Point { x: f64, y: f64 },
}

/// Single step in [`CdpSession::execute_batch`] (`browser_batch`).
#[derive(Debug, Clone, PartialEq)]
pub enum BrowserBatchAction {
    Navigate { url: String },
    Click { target: ElementTarget, double: bool },
    Type { target: Option<ElementTarget>, text: String, clear: bool },
    Press { key: String },
    Hover { target: ElementTarget },
    Scroll { dx: f64, dy: f64 },
    Wait { condition: WaitCondition, timeout_ms: u64 },
    Eval { expression: String },
}

/// Named step inside a multi-step `browser_batch` request.
#[derive(Debug, Clone, PartialEq)]
pub struct BrowserBatchStep {
    pub label: Option<String>,
    pub action: BrowserBatchAction,
}

/// Outcome of executing a single step in [`BrowserBatchReport`].
#[derive(Debug, Clone, PartialEq)]
pub struct BrowserBatchStepResult {
    pub index: usize,
    pub label: String,
    pub ok: bool,
    pub detail: String,
}

/// Aggregated result of [`CdpSession::execute_batch`] (stops on first error).
#[derive(Debug, Clone, PartialEq)]
pub struct BrowserBatchReport {
    pub ok: bool,
    pub completed: usize,
    pub total: usize,
    pub steps: Vec<BrowserBatchStepResult>,
    pub error: Option<String>,
    pub final_snapshot: Option<DomSnapshotResult>,
}

impl BrowserBatchReport {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "ok": self.ok,
            "completed": self.completed,
            "total": self.total,
            "error": self.error,
            "steps": self.steps.iter().map(|s| json!({
                "index": s.index,
                "label": s.label,
                "ok": s.ok,
                "detail": s.detail,
            })).collect::<Vec<_>>(),
            "final_snapshot": self.final_snapshot.as_ref().map(DomSnapshotResult::to_json),
        })
    }
}

/// Parses a JSON array of `browser_batch` actions (`[{"action":"navigate","url":"..."}, ...]`).
pub fn parse_batch_steps(items: &[Value]) -> Result<Vec<BrowserBatchStep>, String> {
    if items.is_empty() {
        return Err("browser_batch requires a non-empty array of steps".to_string());
    }
    let mut out = Vec::with_capacity(items.len());
    for (idx, item) in items.iter().enumerate() {
        let obj = item
            .as_object()
            .ok_or_else(|| format!("batch step {idx} must be a JSON object"))?;
        let kind = obj
            .get("action")
            .or_else(|| obj.get("tool"))
            .and_then(Value::as_str)
            .ok_or_else(|| format!("batch step {idx} missing string `action`"))?
            .trim()
            .trim_start_matches("browser_")
            .to_ascii_lowercase();
        let label = obj
            .get("label")
            .and_then(Value::as_str)
            .map(str::to_string);
        let target_opt = || -> Result<Option<ElementTarget>, String> {
            if let Some(r) = obj.get("ref").and_then(Value::as_str) {
                return Ok(Some(ElementTarget::Ref(r.to_string())));
            }
            if let Some(sel) = obj.get("selector").and_then(Value::as_str) {
                return Ok(Some(ElementTarget::Selector(sel.to_string())));
            }
            if let (Some(x), Some(y)) = (
                obj.get("x").and_then(Value::as_f64),
                obj.get("y").and_then(Value::as_f64),
            ) {
                return Ok(Some(ElementTarget::Point { x, y }));
            }
            Ok(None)
        };
        let action = match kind.as_str() {
            "navigate" | "goto" => {
                let url = obj
                    .get("url")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("batch step {idx} navigate missing `url`"))?
                    .to_string();
                BrowserBatchAction::Navigate { url }
            }
            "click" => {
                let target = target_opt()?
                    .ok_or_else(|| format!("batch step {idx} click requires ref, selector, or x/y"))?;
                let double = obj.get("double").and_then(Value::as_bool).unwrap_or(false);
                BrowserBatchAction::Click { target, double }
            }
            "type" | "fill" => {
                let text = obj
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("batch step {idx} type missing `text`"))?
                    .to_string();
                let clear = obj.get("clear").and_then(Value::as_bool).unwrap_or(false);
                BrowserBatchAction::Type {
                    target: target_opt()?,
                    text,
                    clear,
                }
            }
            "press" | "key" => {
                let key = obj
                    .get("key")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("batch step {idx} press missing `key`"))?
                    .to_string();
                BrowserBatchAction::Press { key }
            }
            "hover" => {
                let target = target_opt()?
                    .ok_or_else(|| format!("batch step {idx} hover requires ref, selector, or x/y"))?;
                BrowserBatchAction::Hover { target }
            }
            "scroll" => {
                let dx = obj.get("dx").and_then(Value::as_f64).unwrap_or(0.0);
                let dy = obj.get("dy").and_then(Value::as_f64).unwrap_or(400.0);
                BrowserBatchAction::Scroll { dx, dy }
            }
            "wait" => {
                let timeout_ms = obj
                    .get("timeout_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(5_000)
                    .clamp(50, 60_000);
                let condition = if let Some(t) = obj.get("text").and_then(Value::as_str) {
                    WaitCondition::Text(t.to_string())
                } else if let Some(t) = obj.get("text_gone").and_then(Value::as_str) {
                    WaitCondition::TextGone(t.to_string())
                } else if let Some(sel) = obj.get("selector").and_then(Value::as_str) {
                    WaitCondition::Selector(sel.to_string())
                } else {
                    let ms = obj.get("ms").and_then(Value::as_u64).unwrap_or(250);
                    WaitCondition::DelayMs(ms.min(10_000))
                };
                BrowserBatchAction::Wait {
                    condition,
                    timeout_ms,
                }
            }
            "eval" | "evaluate" => {
                let expression = obj
                    .get("expression")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("batch step {idx} eval missing `expression`"))?
                    .to_string();
                BrowserBatchAction::Eval { expression }
            }
            other => {
                return Err(format!("unknown browser_batch action `{other}` at step {idx}"));
            }
        };
        out.push(BrowserBatchStep { label, action });
    }
    Ok(out)
}

type PendingCdpRequests = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;
type WsSink = Arc<
    AsyncMutex<
        futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            WsMessage,
        >,
    >,
>;

/// RAII guard removing an in-flight RPC ID from `pending` if the awaiting future is dropped,
/// cancelled, or times out (zero leaked pending channels).
struct PendingCallGuard {
    pending: PendingCdpRequests,
    id: i64,
    armed: bool,
}

impl PendingCallGuard {
    fn arm(pending: PendingCdpRequests, id: i64) -> Self {
        Self {
            pending,
            id,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingCallGuard {
    fn drop(&mut self) {
        if self.armed {
            if let Ok(mut map) = self.pending.lock() {
                map.remove(&self.id);
            }
        }
    }
}

/// Shared event-driven supervisor state updated by the background CDP reader loop.
struct SessionSupervisorState {
    active_target_id: String,
    active_session_id: String,
    tabs: HashMap<String, BrowserTabInfo>,
    /// Tracks child OOPIF (`iframe`) `sessionId -> targetId` attached via `Target.setAutoAttach`.
    iframe_sessions: HashMap<String, String>,
    inflight_requests: HashSet<String>,
    loading_frames: HashSet<String>,
    last_activity: Instant,
    network: NetworkRing,
    console: ConsoleRing,
    dialogs: VecDeque<DialogRecord>,
    dialog_policy: DialogPolicy,
}

impl SessionSupervisorState {
    fn new() -> Self {
        Self {
            active_target_id: String::new(),
            active_session_id: String::new(),
            tabs: HashMap::new(),
            iframe_sessions: HashMap::new(),
            inflight_requests: HashSet::new(),
            loading_frames: HashSet::new(),
            last_activity: Instant::now(),
            network: NetworkRing::new(NETWORK_RING_CAPACITY),
            console: ConsoleRing::new(CONSOLE_RING_CAPACITY),
            dialogs: VecDeque::with_capacity(DIALOG_RING_CAPACITY),
            dialog_policy: DialogPolicy::Auto,
        }
    }

    fn push_dialog(&mut self, record: DialogRecord) {
        if self.dialogs.len() >= DIALOG_RING_CAPACITY {
            self.dialogs.pop_front();
        }
        self.dialogs.push_back(record);
    }
}

/// Multiplexed WebSocket CDP Session attached to an isolated Chromium/Edge instance with
/// `PendingCallGuard`, `8192`-slot event bus, `2000`-entry `NetworkRing`, auto JS dialog
/// handling, multi-tab + OOPIF tracking, event-driven `settle()`/`wait_for()`, WeakMap ARIA
/// snapshots, `browser_batch`, and Virtual Cursor Overlay.
pub struct CdpSession {
    writer: WsSink,
    pending: PendingCdpRequests,
    next_id: Arc<AtomicI64>,
    events_tx: broadcast::Sender<CdpEvent>,
    supervisor: Arc<Mutex<SessionSupervisorState>>,
    cancel: CancelToken,
    pub target_id: String,
    pub session_id: String,
    pub last_cursor: Mutex<(f64, f64)>,
}

impl std::fmt::Debug for CdpSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CdpSession")
            .field("target_id", &self.target_id)
            .field("session_id", &self.session_id)
            .finish()
    }
}

impl Drop for CdpSession {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl CdpSession {
    /// Connects to a validated loopback CDP WebSocket URL (`/devtools/browser/...` or `/devtools/page/...`).
    pub async fn connect(ws_url: &str) -> Result<Arc<Self>, String> {
        validate_cdp_ws_url(ws_url)?;
        let ws_cfg = WebSocketConfig::default()
            .max_message_size(Some(CDP_MAX_WS_BYTES))
            .max_frame_size(Some(CDP_MAX_WS_BYTES));
        let (ws_stream, _) =
            tokio_tungstenite::connect_async_with_config(ws_url, Some(ws_cfg), false)
                .await
                .map_err(|e| format!("CDP WebSocket connect `{ws_url}` failed: {e}"))?;
        let (sink, mut stream) = ws_stream.split();
        let writer: WsSink = Arc::new(AsyncMutex::new(sink));
        let pending: PendingCdpRequests = Arc::new(Mutex::new(HashMap::new()));
        let next_id = Arc::new(AtomicI64::new(1));
        let (events_tx, _) = broadcast::channel(CDP_EVENT_BUS_CAPACITY);
        let supervisor = Arc::new(Mutex::new(SessionSupervisorState::new()));
        let cancel = CancelToken::new();

        // Spawn multiplexed reader & event supervisor loop
        let r_pending = Arc::clone(&pending);
        let r_events = events_tx.clone();
        let r_sup = Arc::clone(&supervisor);
        let r_writer = Arc::clone(&writer);
        let r_next_id = Arc::clone(&next_id);
        let r_cancel = cancel.clone();

        tokio::spawn(async move {
            loop {
                let next_msg = tokio::select! {
                    _ = r_cancel.cancelled() => break,
                    m = stream.next() => m,
                };
                let Some(Ok(msg)) = next_msg else {
                    break;
                };
                let WsMessage::Text(txt) = msg else {
                    continue;
                };
                let Ok(val) = serde_json::from_str::<Value>(txt.as_str()) else {
                    continue;
                };

                // 1. RPC response dispatch
                if let Some(id) = val.get("id").and_then(Value::as_i64) {
                    let tx = r_pending.lock().ok().and_then(|mut m| m.remove(&id));
                    if let Some(tx) = tx {
                        if let Some(err) = val.get("error") {
                            let _ = tx.send(Err(err.to_string()));
                        } else {
                            let _ = tx.send(Ok(val.get("result").cloned().unwrap_or(Value::Null)));
                        }
                    }
                    continue;
                }

                // 2. CDP protocol event handling
                let Some(method) = val.get("method").and_then(Value::as_str) else {
                    continue;
                };
                let ev_session = val
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let params = val.get("params").cloned().unwrap_or(Value::Null);

                let auto_dialog: Option<(Option<String>, bool)> = {
                    let mut out = None;
                    if let Ok(mut sup) = r_sup.lock() {
                        match method {
                            "Target.targetCreated" | "Target.targetInfoChanged" => {
                                if let Some(info) = params.get("targetInfo") {
                                    if info.get("type").and_then(Value::as_str) == Some("page") {
                                        if let Some(tid) =
                                            info.get("targetId").and_then(Value::as_str)
                                        {
                                            let title = info
                                                .get("title")
                                                .and_then(Value::as_str)
                                                .unwrap_or("")
                                                .to_string();
                                            let url = info
                                                .get("url")
                                                .and_then(Value::as_str)
                                                .unwrap_or("")
                                                .to_string();
                                            let active = sup.active_target_id == tid;
                                            let entry = sup
                                                .tabs
                                                .entry(tid.to_string())
                                                .or_insert_with(|| BrowserTabInfo {
                                                    target_id: tid.to_string(),
                                                    session_id: None,
                                                    title: String::new(),
                                                    url: String::new(),
                                                    active,
                                                });
                                            entry.title = title;
                                            entry.url = url;
                                        }
                                    }
                                }
                            }
                            "Target.targetDestroyed" => {
                                if let Some(tid) = params.get("targetId").and_then(Value::as_str) {
                                    sup.tabs.remove(tid);
                                }
                            }
                            "Target.attachedToTarget" => {
                                if let (Some(sid), Some(info)) = (
                                    params.get("sessionId").and_then(Value::as_str),
                                    params.get("targetInfo"),
                                ) {
                                    let ttype = info
                                        .get("type")
                                        .and_then(Value::as_str)
                                        .unwrap_or("");
                                    let tid = info
                                        .get("targetId")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .to_string();
                                    if ttype == "iframe" {
                                        sup.iframe_sessions.insert(sid.to_string(), tid);
                                    } else if ttype == "page" && !tid.is_empty() {
                                        if let Some(tab) = sup.tabs.get_mut(&tid) {
                                            tab.session_id = Some(sid.to_string());
                                        }
                                    }
                                }
                            }
                            "Target.detachedFromTarget" => {
                                if let Some(sid) = params.get("sessionId").and_then(Value::as_str) {
                                    sup.iframe_sessions.remove(sid);
                                }
                            }
                            "Network.requestWillBeSent"
                            | "Network.requestWillBeSentExtraInfo"
                            | "Network.responseReceived"
                            | "Network.responseReceivedExtraInfo"
                            | "Network.loadingFinished"
                            | "Network.loadingFailed" => {
                                sup.last_activity = Instant::now();
                                if let Some(rid) =
                                    params.get("requestId").and_then(Value::as_str)
                                {
                                    match method {
                                        "Network.requestWillBeSent" => {
                                            sup.inflight_requests.insert(rid.to_string());
                                        }
                                        "Network.loadingFinished" | "Network.loadingFailed" => {
                                            sup.inflight_requests.remove(rid);
                                        }
                                        _ => {}
                                    }
                                }
                                sup.network.ingest_cdp_event(method, &params);
                            }
                            "Page.frameStartedLoading" => {
                                sup.last_activity = Instant::now();
                                if let Some(fid) = params.get("frameId").and_then(Value::as_str) {
                                    sup.loading_frames.insert(fid.to_string());
                                }
                            }
                            "Page.frameStoppedLoading" => {
                                sup.last_activity = Instant::now();
                                if let Some(fid) = params.get("frameId").and_then(Value::as_str) {
                                    sup.loading_frames.remove(fid);
                                }
                            }
                            "Page.loadEventFired" | "Page.domContentEventFired" => {
                                sup.last_activity = Instant::now();
                            }
                            "Page.javascriptDialogOpening" => {
                                let dtype = params
                                    .get("type")
                                    .and_then(Value::as_str)
                                    .unwrap_or("alert")
                                    .to_string();
                                let msg = params
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string();
                                let (accept, _) = sup.dialog_policy.decide(&dtype);
                                sup.push_dialog(DialogRecord {
                                    dialog_type: dtype,
                                    message: msg,
                                    accepted: accept,
                                });
                                out = Some((ev_session.clone(), accept));
                            }
                            "Runtime.consoleAPICalled"
                            | "Runtime.exceptionThrown"
                            | "Log.entryAdded" => {
                                sup.console.ingest_cdp_event(method, &params);
                            }
                            _ => {}
                        }
                    }
                    out
                };

                // Handle JS dialog asynchronously so the reader loop never stalls waiting on itself.
                if let Some((dlg_sid, accept)) = auto_dialog {
                    let w = Arc::clone(&r_writer);
                    let id_gen = Arc::clone(&r_next_id);
                    tokio::spawn(async move {
                        let id = id_gen.fetch_add(1, Ordering::Relaxed);
                        let mut cmd = json!({
                            "id": id,
                            "method": "Page.handleJavaScriptDialog",
                            "params": { "accept": accept },
                        });
                        if let Some(sid) = dlg_sid {
                            cmd["sessionId"] = json!(sid);
                        }
                        let mut guard = w.lock().await;
                        let _ = guard.send(WsMessage::Text(cmd.to_string().into())).await;
                    });
                }

                let _ = r_events.send(CdpEvent {
                    session_id: ev_session,
                    method: method.to_string(),
                    params,
                });
            }

            // Fail any remaining waiters immediately upon disconnect
            if let Ok(mut map) = r_pending.lock() {
                for (_, tx) in map.drain() {
                    let _ = tx.send(Err("CDP WebSocket closed".to_string()));
                }
            }
        });

        let mut session = Self {
            writer,
            pending,
            next_id,
            events_tx,
            supervisor,
            cancel,
            target_id: String::new(),
            session_id: String::new(),
            last_cursor: Mutex::new((40.0, 40.0)),
        };

        // Attach to first existing page target or create one when connecting to browser-level WS.
        if ws_url.contains("/devtools/browser/") {
            let _ = session
                .call_raw(None, "Target.setDiscoverTargets", json!({ "discover": true }))
                .await;
            let targets = session.call_raw(None, "Target.getTargets", json!({})).await?;
            let existing_page = targets
                .get("targetInfos")
                .and_then(Value::as_array)
                .and_then(|arr| {
                    arr.iter()
                        .find(|t| t.get("type").and_then(Value::as_str) == Some("page"))
                })
                .and_then(|t| t.get("targetId").and_then(Value::as_str))
                .map(str::to_owned);

            let tid = match existing_page {
                Some(t) => t,
                None => {
                    let created = session
                        .call_raw(None, "Target.createTarget", json!({ "url": "about:blank" }))
                        .await?;
                    created
                        .get("targetId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "Target.createTarget returned no targetId".to_owned())?
                        .to_owned()
                }
            };
            let attached = session
                .call_raw(
                    None,
                    "Target.attachToTarget",
                    json!({ "targetId": tid, "flatten": true }),
                )
                .await?;
            session.target_id = tid.clone();
            session.session_id = attached
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            if let Ok(mut sup) = session.supervisor.lock() {
                sup.active_target_id = tid.clone();
                sup.active_session_id = session.session_id.clone();
                sup.tabs.insert(
                    tid.clone(),
                    BrowserTabInfo {
                        target_id: tid,
                        session_id: (!session.session_id.is_empty())
                            .then(|| session.session_id.clone()),
                        title: String::new(),
                        url: "about:blank".into(),
                        active: true,
                    },
                );
            }
        }

        let sid = session.active_page_session();
        session.enable_page_domains(sid.as_deref()).await;
        let arc = Arc::new(session);
        let _ = arc.inject_virtual_cursor_overlay().await;
        Ok(arc)
    }

    async fn enable_page_domains(&self, sid: Option<&str>) {
        let _ = self.call_raw(sid, "Page.enable", json!({})).await;
        let _ = self.call_raw(sid, "Runtime.enable", json!({})).await;
        let _ = self.call_raw(sid, "DOM.enable", json!({})).await;
        let _ = self.call_raw(sid, "Network.enable", json!({})).await;
        let _ = self.call_raw(sid, "Log.enable", json!({})).await;
        // Enable recursive auto-attach for cross-origin iframes (OOPIFs)
        let _ = self
            .call_raw(
                sid,
                "Target.setAutoAttach",
                json!({
                    "autoAttach": true,
                    "waitForDebuggerOnStart": false,
                    "flatten": true
                }),
            )
            .await;
    }

    /// Sends a CDP command with RAII [`PendingCallGuard`] cleanup on drop/timeout/cancel.
    pub async fn call_raw(
        &self,
        session_id: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        if self.cancel.is_cancelled() {
            return Err("CDP session closed".to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut msg = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        if let Some(sid) = session_id {
            msg["sessionId"] = json!(sid);
        }
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "CDP pending lock poisoned".to_owned())?
            .insert(id, tx);

        // RAII guard ensures `id` is removed even if this future is dropped mid-await!
        let mut guard = PendingCallGuard::arm(Arc::clone(&self.pending), id);

        {
            let mut w = self.writer.lock().await;
            w.send(WsMessage::Text(msg.to_string().into()))
                .await
                .map_err(|e| format!("CDP send `{method}` failed: {e}"))?;
        }

        let res = tokio::time::timeout(Duration::from_secs(15), rx)
            .await
            .map_err(|_| format!("CDP `{method}` timed out"))?
            .map_err(|_| "CDP channel closed".to_owned())?;
        guard.disarm();
        res
    }

    fn active_page_session(&self) -> Option<String> {
        if let Ok(sup) = self.supervisor.lock() {
            if !sup.active_session_id.is_empty() {
                return Some(sup.active_session_id.clone());
            }
        }
        (!self.session_id.is_empty()).then(|| self.session_id.clone())
    }

    /// Subscribes to the live `8192`-slot broadcast CDP event bus.
    #[must_use]
    pub fn subscribe_events(&self) -> broadcast::Receiver<CdpEvent> {
        self.events_tx.subscribe()
    }

    /// Awaits the first CDP event matching `predicate` within `timeout`.
    pub async fn wait_event<F>(&self, mut predicate: F, timeout: Duration) -> Result<CdpEvent, String>
    where
        F: FnMut(&CdpEvent) -> bool,
    {
        let mut rx = self.subscribe_events();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Err("timed out waiting for CDP event".to_string());
            }
            match tokio::time::timeout(deadline - now, rx.recv()).await {
                Ok(Ok(ev)) => {
                    if predicate(&ev) {
                        return Ok(ev);
                    }
                }
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(broadcast::error::RecvError::Closed)) => {
                    return Err("CDP event bus closed".to_string());
                }
                Err(_) => return Err("timed out waiting for CDP event".to_string()),
            }
        }
    }

    /// Event-driven network + frame-load settle helper waiting until zero inflight requests and
    /// zero loading frames persist for `quiet_ms` (bounded by `timeout_ms`).
    pub async fn settle(&self, quiet_ms: u64, timeout_ms: u64) {
        let quiet = Duration::from_millis(quiet_ms.clamp(50, 5_000));
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms.clamp(100, 30_000));
        loop {
            let settled = self.supervisor.lock().ok().is_some_and(|sup| {
                sup.inflight_requests.is_empty()
                    && sup.loading_frames.is_empty()
                    && sup.last_activity.elapsed() >= quiet
            });
            if settled || tokio::time::Instant::now() >= deadline {
                return;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    }

    /// Waits for text, text disappearance, CSS selector, or fixed delay (piercing same-origin iframes).
    pub async fn wait_for(&self, cond: &WaitCondition, timeout_ms: u64) -> Result<bool, String> {
        if let WaitCondition::DelayMs(ms) = cond {
            tokio::time::sleep(Duration::from_millis((*ms).min(30_000))).await;
            return Ok(true);
        }
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(timeout_ms.clamp(100, 60_000));
        loop {
            let matched = match cond {
                WaitCondition::Text(needle) => {
                    let n = serde_json::to_string(needle).unwrap_or_else(|_| "\"\"".into());
                    self.eval_js(&format!(
                        r#"(function(n){{
                            function has(doc){{
                                if(!doc) return false;
                                const t = (doc.body && doc.body.innerText) || '';
                                if(t.toLowerCase().includes(n.toLowerCase())) return true;
                                for(const f of doc.querySelectorAll('iframe')){{
                                    try {{ if(has(f.contentDocument)) return true; }} catch(e){{}}
                                }}
                                return false;
                            }}
                            return has(document);
                        }})({n})"#
                    ))
                    .await
                    .ok()
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                }
                WaitCondition::TextGone(needle) => {
                    let n = serde_json::to_string(needle).unwrap_or_else(|_| "\"\"".into());
                    self.eval_js(&format!(
                        r#"(function(n){{
                            const t = (document.body && document.body.innerText) || '';
                            return !t.toLowerCase().includes(n.toLowerCase());
                        }})({n})"#
                    ))
                    .await
                    .ok()
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                }
                WaitCondition::Selector(sel) => {
                    let s = serde_json::to_string(sel).unwrap_or_else(|_| "\"\"".into());
                    self.eval_js(&format!("Boolean(document.querySelector({s}))"))
                        .await
                        .ok()
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                }
                WaitCondition::DelayMs(_) => true,
            };
            if matched {
                return Ok(true);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!("timed out waiting for condition: {cond:?}"));
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }

    // --------------------------------------------------------- tabs & OOPIFs

    /// Lists tracked top-level browser tabs.
    #[must_use]
    pub fn list_tabs(&self) -> Vec<BrowserTabInfo> {
        self.supervisor
            .lock()
            .map(|sup| sup.tabs.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Returns currently attached cross-origin iframe session count.
    #[must_use]
    pub fn iframe_session_count(&self) -> usize {
        self.supervisor
            .lock()
            .map(|sup| sup.iframe_sessions.len())
            .unwrap_or(0)
    }

    /// Opens a new browser tab and switches active focus to it.
    pub async fn new_tab(&self, url: &str) -> Result<BrowserTabInfo, String> {
        let created = self
            .call_raw(None, "Target.createTarget", json!({ "url": url }))
            .await?;
        let tid = created
            .get("targetId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Target.createTarget returned no targetId".to_string())?
            .to_string();
        let attached = self
            .call_raw(
                None,
                "Target.attachToTarget",
                json!({ "targetId": tid, "flatten": true }),
            )
            .await?;
        let sid = attached
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let info = BrowserTabInfo {
            target_id: tid.clone(),
            session_id: (!sid.is_empty()).then(|| sid.clone()),
            title: String::new(),
            url: url.to_string(),
            active: true,
        };
        if let Ok(mut sup) = self.supervisor.lock() {
            for t in sup.tabs.values_mut() {
                t.active = false;
            }
            sup.active_target_id = tid.clone();
            sup.active_session_id = sid.clone();
            sup.tabs.insert(tid, info.clone());
        }
        self.enable_page_domains((!sid.is_empty()).then_some(sid.as_str()))
            .await;
        Ok(info)
    }

    /// Switches active target by target ID prefix or 1-based index.
    pub async fn switch_tab(&self, target_or_index: &str) -> Result<BrowserTabInfo, String> {
        let chosen = {
            let sup = self
                .supervisor
                .lock()
                .map_err(|_| "supervisor lock poisoned".to_string())?;
            let list: Vec<BrowserTabInfo> = sup.tabs.values().cloned().collect();
            if let Ok(idx) = target_or_index.trim().parse::<usize>() {
                list.get(idx.saturating_sub(1)).cloned()
            } else {
                list.into_iter()
                    .find(|t| t.target_id.starts_with(target_or_index.trim()))
            }
        }
        .ok_or_else(|| format!("no tab matching `{target_or_index}`"))?;

        let sid = match chosen.session_id.clone() {
            Some(s) => s,
            None => {
                let attached = self
                    .call_raw(
                        None,
                        "Target.attachToTarget",
                        json!({ "targetId": chosen.target_id, "flatten": true }),
                    )
                    .await?;
                attached
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            }
        };
        let _ = self
            .call_raw(
                None,
                "Target.activateTarget",
                json!({ "targetId": chosen.target_id }),
            )
            .await;
        self.enable_page_domains((!sid.is_empty()).then_some(sid.as_str()))
            .await;
        let updated = BrowserTabInfo {
            session_id: (!sid.is_empty()).then(|| sid.clone()),
            active: true,
            ..chosen
        };
        if let Ok(mut sup) = self.supervisor.lock() {
            for t in sup.tabs.values_mut() {
                t.active = t.target_id == updated.target_id;
            }
            sup.active_target_id = updated.target_id.clone();
            sup.active_session_id = sid;
            sup.tabs.insert(updated.target_id.clone(), updated.clone());
        }
        Ok(updated)
    }

    // --------------------------------------------------- network / console / dialogs

    pub fn set_dialog_policy(&self, policy: DialogPolicy) {
        if let Ok(mut sup) = self.supervisor.lock() {
            sup.dialog_policy = policy;
        }
    }

    #[must_use]
    pub fn take_dialogs(&self) -> Vec<DialogRecord> {
        self.supervisor
            .lock()
            .map(|mut sup| sup.dialogs.drain(..).collect())
            .unwrap_or_default()
    }

    #[must_use]
    pub fn console_entries(&self) -> Vec<ConsoleEntry> {
        self.supervisor
            .lock()
            .map(|sup| sup.console.entries())
            .unwrap_or_default()
    }

    #[must_use]
    pub fn network_entries(&self, filter: &NetworkFilter) -> Vec<NetworkEntry> {
        self.supervisor
            .lock()
            .map(|sup| sup.network.query(filter))
            .unwrap_or_default()
    }

    /// Builds a [`ReplayRequestSpec`] for a captured network `request_id`, falling back to
    /// `Network.getCookies` when `ExtraInfo` omitted the `Cookie` header.
    pub async fn network_replay_spec(&self, request_id: &str) -> Result<ReplayRequestSpec, String> {
        let initial = self
            .supervisor
            .lock()
            .map_err(|_| "supervisor lock poisoned".to_string())?
            .network
            .replay_spec(request_id, None)?;
        if initial.cookies.is_some() {
            return Ok(initial);
        }
        let sid = self.active_page_session();
        let fallback_cookies = self
            .call_raw(
                sid.as_deref(),
                "Network.getCookies",
                json!({ "urls": [&initial.url] }),
            )
            .await
            .ok()
            .and_then(|v| {
                let arr = v.get("cookies")?.as_array()?;
                let joined: Vec<String> = arr
                    .iter()
                    .filter_map(|c| {
                        let n = c.get("name")?.as_str()?;
                        let val = c.get("value")?.as_str()?;
                        Some(format!("{n}={val}"))
                    })
                    .collect();
                (!joined.is_empty()).then(|| joined.join("; "))
            });
        self.supervisor
            .lock()
            .map_err(|_| "supervisor lock poisoned".to_string())?
            .network
            .replay_spec(request_id, fallback_cookies.as_deref())
    }

    // --------------------------------------------------- navigation & evaluation

    pub async fn navigate(&self, url: &str) -> Result<Value, String> {
        let sid = self.active_page_session();
        let res = self
            .call_raw(sid.as_deref(), "Page.navigate", json!({ "url": url }))
            .await?;
        self.settle(250, 5_000).await;
        let _ = self.inject_virtual_cursor_overlay().await;
        Ok(res)
    }

    pub async fn eval_js(&self, expression: &str) -> Result<Value, String> {
        let sid = self.active_page_session();
        let res = self
            .call_raw(
                sid.as_deref(),
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
            )
            .await?;
        if let Some(exc) = res.get("exceptionDetails") {
            return Err(format!("JS exception: {exc}"));
        }
        Ok(res
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    /// Runs the WeakMap `[ref=eN]` ARIA + Shadow DOM + `<slot>` + iframe snapshot script.
    pub async fn snapshot_aria(
        &self,
        opts: &DomSnapshotOptions,
    ) -> Result<DomSnapshotResult, String> {
        let expr = build_snapshot_eval_js(opts);
        let raw = self.eval_js(&expr).await?;
        let raw_str = raw
            .as_str()
            .ok_or_else(|| "window.__omnia.snapshot did not return a JSON string".to_string())?;
        parse_snapshot_json(raw_str, opts.max_chars)
    }

    /// Injects Omnia's visual non-intrusive SVG virtual cursor + click ripple overlay.
    pub async fn inject_virtual_cursor_overlay(&self) -> Result<(), String> {
        let js = r##"(function(){
            if (document.getElementById('__omnia_virtual_cursor__')) return true;
            const root = document.createElement('div');
            root.id = '__omnia_virtual_cursor__';
            root.style.cssText = 'position:fixed;left:40px;top:40px;z-index:2147483647;pointer-events:none;transition:left 140ms ease,top 140ms ease;transform:translate(-2px,-2px);';
            root.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.45))"><path d="M3 2l7.5 19 2.8-7.2L20.5 11z" fill="#38bdf8" stroke="#0f172a" stroke-width="1.6"/></svg><span id="__omnia_cursor_label__" style="margin-left:6px;padding:2px 6px;border-radius:6px;background:rgba(15,23,42,0.88);color:#e2e8f0;font:600 11px/1.3 system-ui,sans-serif;white-space:nowrap;">Omnia Agent</span>';
            (document.body || document.documentElement).appendChild(root);
            window.__omniaMoveCursor = function(x, y, label, ripple) {
                const el = document.getElementById('__omnia_virtual_cursor__');
                if (!el) return;
                el.style.left = Math.round(x) + 'px';
                el.style.top = Math.round(y) + 'px';
                const lbl = document.getElementById('__omnia_cursor_label__');
                if (lbl && label) lbl.textContent = String(label);
                if (ripple) {
                    const ring = document.createElement('div');
                    ring.style.cssText = 'position:fixed;left:'+Math.round(x-12)+'px;top:'+Math.round(y-12)+'px;width:24px;height:24px;border-radius:999px;border:2px solid #38bdf8;pointer-events:none;z-index:2147483646;opacity:0.9;transition:transform 320ms ease-out,opacity 320ms ease-out;';
                    (document.body || document.documentElement).appendChild(ring);
                    requestAnimationFrame(()=>{ ring.style.transform='scale(2.1)'; ring.style.opacity='0'; });
                    setTimeout(()=>ring.remove(), 350);
                }
            };
            return true;
        })()"##;
        let _ = self.eval_js(js).await;
        Ok(())
    }

    pub async fn move_virtual_cursor(&self, x: f64, y: f64, label: &str) -> Result<(), String> {
        if let Ok(mut pos) = self.last_cursor.lock() {
            *pos = (x, y);
        }
        let _ = self.inject_virtual_cursor_overlay().await;
        let lbl_json = serde_json::to_string(label).unwrap_or_else(|_| "\"Omnia\"".into());
        let _ = self
            .eval_js(&format!(
                "window.__omniaMoveCursor && window.__omniaMoveCursor({x}, {y}, {lbl_json}, false)"
            ))
            .await;
        let sid = self.active_page_session();
        self.call_raw(
            sid.as_deref(),
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": x, "y": y }),
        )
        .await?;
        Ok(())
    }

    pub async fn click_at(&self, x: f64, y: f64, label: Option<&str>) -> Result<Value, String> {
        self.click_at_count(x, y, 1, label).await
    }

    async fn click_at_count(
        &self,
        x: f64,
        y: f64,
        click_count: u32,
        label: Option<&str>,
    ) -> Result<Value, String> {
        self.move_virtual_cursor(x, y, label.unwrap_or("click"))
            .await?;
        let lbl_json =
            serde_json::to_string(label.unwrap_or("click")).unwrap_or_else(|_| "\"click\"".into());
        let _ = self
            .eval_js(&format!(
                "window.__omniaMoveCursor && window.__omniaMoveCursor({x}, {y}, {lbl_json}, true)"
            ))
            .await;
        let sid = self.active_page_session();
        for n in 1..=click_count.max(1) {
            self.call_raw(
                sid.as_deref(),
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mousePressed",
                    "x": x,
                    "y": y,
                    "button": "left",
                    "clickCount": n
                }),
            )
            .await?;
            self.call_raw(
                sid.as_deref(),
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseReleased",
                    "x": x,
                    "y": y,
                    "button": "left",
                    "clickCount": n
                }),
            )
            .await?;
        }
        Ok(json!({ "clicked": true, "x": x, "y": y, "click_count": click_count.max(1) }))
    }

    /// Resolves an [`ElementTarget`] (`Ref` > `Selector` > `Point`) to viewport coordinates with
    /// iframe offset walking and `elementFromPoint` occlusion checking.
    async fn resolve_target_point(
        &self,
        target: &ElementTarget,
    ) -> Result<(f64, f64, Option<String>), String> {
        match target {
            ElementTarget::Point { x, y } => Ok((*x, *y, None)),
            ElementTarget::Ref(ref_id) => {
                let r_json = serde_json::to_string(ref_id).map_err(|e| e.to_string())?;
                self.resolve_dom_expr_center(
                    &format!("window.__omnia && window.__omnia.get({r_json})"),
                    &format!("ref `{ref_id}`"),
                )
                .await
            }
            ElementTarget::Selector(sel) => {
                let s_json = serde_json::to_string(sel).map_err(|e| e.to_string())?;
                self.resolve_dom_expr_center(
                    &format!("document.querySelector({s_json})"),
                    &format!("selector `{sel}`"),
                )
                .await
            }
        }
    }

    async fn resolve_dom_expr_center(
        &self,
        lookup_expr: &str,
        desc: &str,
    ) -> Result<(f64, f64, Option<String>), String> {
        let pt = self
            .eval_js(&format!(
                r#"(function(){{
                    const el = {lookup_expr};
                    if (!el) return null;
                    el.scrollIntoView({{ block: 'center', inline: 'center' }});
                    const r = el.getBoundingClientRect();
                    let ox = 0, oy = 0, win = el.ownerDocument && el.ownerDocument.defaultView;
                    while (win && win.frameElement) {{
                        const fr = win.frameElement.getBoundingClientRect();
                        const st = win.parent.getComputedStyle(win.frameElement);
                        ox += fr.left + (parseFloat(st.borderLeftWidth) || 0) + (parseFloat(st.paddingLeft) || 0);
                        oy += fr.top + (parseFloat(st.borderTopWidth) || 0) + (parseFloat(st.paddingTop) || 0);
                        win = win.parent;
                    }}
                    const x = ox + r.left + r.width / 2;
                    const y = oy + r.top + r.height / 2;
                    const hit = document.elementFromPoint(x, y);
                    const coveredBy = (hit && hit !== el && !el.contains(hit))
                        ? (hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : ''))
                        : null;
                    return {{ x, y, coveredBy }};
                }})()"#
            ))
            .await?;
        let Some(x) = pt.get("x").and_then(Value::as_f64) else {
            return Err(format!("element not found for {desc}"));
        };
        let y = pt.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        let covered = pt
            .get("coveredBy")
            .and_then(Value::as_str)
            .map(str::to_string);
        Ok((x, y, covered))
    }

    pub async fn click_selector(&self, selector: &str) -> Result<Value, String> {
        self.click_target(&ElementTarget::Selector(selector.to_string()), false)
            .await
    }

    pub async fn click_ref(&self, ref_id: &str) -> Result<Value, String> {
        self.click_target(&ElementTarget::Ref(ref_id.to_string()), false)
            .await
    }

    pub async fn click_target(&self, target: &ElementTarget, double: bool) -> Result<Value, String> {
        let (x, y, covered_by) = self.resolve_target_point(target).await?;
        let mut res = self
            .click_at_count(x, y, if double { 2 } else { 1 }, Some("click"))
            .await?;
        if let Some(cov) = covered_by {
            res["covered_by"] = json!(cov);
        }
        Ok(res)
    }

    pub async fn hover(&self, target: &ElementTarget) -> Result<Value, String> {
        let (x, y, _) = self.resolve_target_point(target).await?;
        self.move_virtual_cursor(x, y, "hover").await?;
        Ok(json!({ "hovered": true, "x": x, "y": y }))
    }

    pub async fn scroll(&self, dx: f64, dy: f64) -> Result<Value, String> {
        let (x, y) = self.last_cursor.lock().map(|p| *p).unwrap_or((400.0, 400.0));
        let sid = self.active_page_session();
        self.call_raw(
            sid.as_deref(),
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseWheel",
                "x": x,
                "y": y,
                "deltaX": dx,
                "deltaY": dy
            }),
        )
        .await?;
        Ok(json!({ "scrolled": true, "dx": dx, "dy": dy }))
    }

    pub async fn type_text(&self, text: &str) -> Result<Value, String> {
        let sid = self.active_page_session();
        self.call_raw(
            sid.as_deref(),
            "Input.insertText",
            json!({ "text": text }),
        )
        .await
    }

    pub async fn press_key(&self, key: &str) -> Result<Value, String> {
        let sid = self.active_page_session();
        let (modifiers, base_key, command) = parse_cdp_key_chord(key);
        let mut down = json!({
            "type": "keyDown",
            "key": base_key,
            "modifiers": modifiers,
        });
        if let Some(cmd) = command {
            down["commands"] = json!([cmd]);
        }
        self.call_raw(sid.as_deref(), "Input.dispatchKeyEvent", down)
            .await?;
        self.call_raw(
            sid.as_deref(),
            "Input.dispatchKeyEvent",
            json!({
                "type": "keyUp",
                "key": base_key,
                "modifiers": modifiers,
            }),
        )
        .await?;
        Ok(json!({ "pressed": key, "modifiers": modifiers }))
    }

    /// Reads a page-origin `blob:` URL in `768 KiB` base64 chunks (keeping CDP frames `< 1 MiB`).
    pub async fn read_blob_bytes(&self, blob_url: &str) -> Result<Vec<u8>, String> {
        if !blob_url.starts_with("blob:") {
            return Err("read_blob_bytes requires a `blob:` URL".to_string());
        }
        let u_json = serde_json::to_string(blob_url).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        let mut offset = 0usize;
        loop {
            let chunk_val = self
                .eval_js(&format!(
                    r#"(async function(){{
                        const resp = await fetch({u_json});
                        if (!resp.ok) throw new Error('blob fetch failed: ' + resp.status);
                        const blob = await resp.blob();
                        const slice = blob.slice({offset}, {offset} + {BLOB_CHUNK_BYTES});
                        const bytes = new Uint8Array(await slice.arrayBuffer());
                        let bin = '';
                        const STEP = 0x8000;
                        for (let i = 0; i < bytes.length; i += STEP) {{
                            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
                        }}
                        return {{ total: blob.size, data: btoa(bin), len: bytes.length }};
                    }})()"#
                ))
                .await?;
            let b64 = chunk_val
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or("");
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| format!("blob chunk base64 decode: {e}"))?;
            let len = decoded.len();
            let total = chunk_val
                .get("total")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            out.extend_from_slice(&decoded);
            offset += len;
            if len == 0 || offset >= total {
                break;
            }
        }
        Ok(out)
    }

    pub async fn screenshot_png_base64(&self) -> Result<String, String> {
        let sid = self.active_page_session();
        let res = self
            .call_raw(
                sid.as_deref(),
                "Page.captureScreenshot",
                json!({ "format": "png", "fromSurface": true }),
            )
            .await?;
        res.get("data")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "Page.captureScreenshot returned no image data".to_owned())
    }

    pub async fn print_to_pdf_base64(&self) -> Result<String, String> {
        let sid = self.active_page_session();
        let res = self
            .call_raw(
                sid.as_deref(),
                "Page.printToPDF",
                json!({ "printBackground": true }),
            )
            .await?;
        res.get("data")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "Page.printToPDF returned no data".to_owned())
    }

    pub async fn save_mhtml(&self) -> Result<String, String> {
        let sid = self.active_page_session();
        let res = self
            .call_raw(
                sid.as_deref(),
                "Page.captureSnapshot",
                json!({ "format": "mhtml" }),
            )
            .await?;
        res.get("data")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "Page.captureSnapshot returned no data".to_owned())
    }

    /// Executes a sequence of `browser_batch` steps, stopping at the first error and optionally
    /// capturing a single compact interactive ARIA snapshot at the end.
    pub async fn execute_batch(
        &self,
        steps: &[BrowserBatchStep],
        include_final_snapshot: bool,
    ) -> BrowserBatchReport {
        let mut results = Vec::with_capacity(steps.len());
        let mut error = None;

        for (idx, step) in steps.iter().enumerate() {
            let label = step
                .label
                .clone()
                .unwrap_or_else(|| format!("step-{}", idx + 1));
            let outcome: Result<String, String> = match &step.action {
                BrowserBatchAction::Navigate { url } => self
                    .navigate(url)
                    .await
                    .map(|_| format!("navigated to {}", crate::browser_network::redact_url(url))),
                BrowserBatchAction::Click { target, double } => self
                    .click_target(target, *double)
                    .await
                    .map(|v| format!("clicked ({v})")),
                BrowserBatchAction::Type {
                    target,
                    text,
                    clear,
                } => {
                    let focus_res = if let Some(t) = target {
                        self.click_target(t, false).await.map(|_| ())
                    } else {
                        Ok(())
                    };
                    match focus_res {
                        Err(e) => Err(e),
                        Ok(()) => {
                            if *clear {
                                let _ = self.press_key("Control+a").await;
                                let _ = self.press_key("Backspace").await;
                            }
                            self.type_text(text)
                                .await
                                .map(|_| format!("typed {} chars", text.chars().count()))
                        }
                    }
                }
                BrowserBatchAction::Press { key } => {
                    self.press_key(key).await.map(|_| format!("pressed {key}"))
                }
                BrowserBatchAction::Hover { target } => {
                    self.hover(target).await.map(|_| "hovered".to_string())
                }
                BrowserBatchAction::Scroll { dx, dy } => self
                    .scroll(*dx, *dy)
                    .await
                    .map(|_| format!("scrolled ({dx}, {dy})")),
                BrowserBatchAction::Wait {
                    condition,
                    timeout_ms,
                } => self
                    .wait_for(condition, *timeout_ms)
                    .await
                    .map(|_| "wait satisfied".to_string()),
                BrowserBatchAction::Eval { expression } => self
                    .eval_js(expression)
                    .await
                    .map(|v| format!("eval={v}")),
            };

            match outcome {
                Ok(detail) => results.push(BrowserBatchStepResult {
                    index: idx,
                    label,
                    ok: true,
                    detail,
                }),
                Err(err) => {
                    results.push(BrowserBatchStepResult {
                        index: idx,
                        label,
                        ok: false,
                        detail: err.clone(),
                    });
                    error = Some(err);
                    break;
                }
            }
        }

        let completed = results.iter().filter(|r| r.ok).count();
        let final_snapshot = if include_final_snapshot {
            self.snapshot_aria(&DomSnapshotOptions {
                interactive_only: true,
                max_chars: 8_000,
                ..Default::default()
            })
            .await
            .ok()
        } else {
            None
        };

        BrowserBatchReport {
            ok: error.is_none(),
            completed,
            total: steps.len(),
            steps: results,
            error,
            final_snapshot,
        }
    }

    pub async fn snapshot_dom_summary(&self) -> Result<Value, String> {
        self.eval_js(
            r#"(function(){
                const title = document.title || '';
                const url = location.href;
                const text = (document.body && document.body.innerText || '').slice(0, 4000);
                const interactive = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role=button]'))
                    .slice(0, 40)
                    .map((el, idx) => {
                        const r = el.getBoundingClientRect();
                        return {
                            idx,
                            tag: el.tagName.toLowerCase(),
                            text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 80),
                            x: Math.round(r.left + r.width / 2),
                            y: Math.round(r.top + r.height / 2),
                        };
                    });
                return { title, url, text, interactive };
            })()"#,
        )
        .await
    }

    pub async fn close(&self) {
        if !self.target_id.is_empty() {
            let _ = self
                .call_raw(
                    None,
                    "Target.closeTarget",
                    json!({ "targetId": self.target_id }),
                )
                .await;
        }
        self.cancel.cancel();
        let mut w = self.writer.lock().await;
        let _ = w.close().await;
    }
}

/// Parses a CDP key chord like `"Control+a"` / `"Ctrl+Shift+Z"` into `(modifier_mask, key, editing_command)`.
fn parse_cdp_key_chord(spec: &str) -> (u8, String, Option<&'static str>) {
    let mut mods = 0u8;
    let parts: Vec<&str> = spec.split('+').map(str::trim).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return (0, String::new(), None);
    }
    for &p in &parts[..parts.len() - 1] {
        match p.to_ascii_lowercase().as_str() {
            "alt" | "option" => mods |= 1,
            "ctrl" | "control" => mods |= 2,
            "meta" | "cmd" | "super" => mods |= 4,
            "shift" => mods |= 8,
            _ => {}
        }
    }
    let key = parts[parts.len() - 1].to_string();
    let command = if (mods & 2) != 0 || (mods & 4) != 0 {
        match key.to_ascii_lowercase().as_str() {
            "a" => Some("selectAll"),
            "c" => Some("copy"),
            "x" => Some("cut"),
            "v" => Some("paste"),
            "z" if (mods & 8) != 0 => Some("redo"),
            "z" => Some("undo"),
            "y" => Some("redo"),
            _ => None,
        }
    } else {
        None
    };
    (mods, key, command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_thorium_and_live_user_profiles() {
        assert!(is_forbidden_live_browser_path(Path::new(
            r"C:\Users\example\AppData\Local\Thorium\Application\thorium.exe"
        )));
        assert!(is_forbidden_live_browser_path(Path::new(
            r"C:\Users\example\AppData\Local\Microsoft\Edge\User Data\Default"
        )));
        assert!(!is_forbidden_live_browser_path(Path::new(
            r"D:\OmniaData\tmp\omnia-cdp-demo123"
        )));
        assert!(resolve_isolated_browser_binary(Some(
            r"C:\Program Files\Thorium\thorium.exe"
        ))
        .is_err());
    }

    #[test]
    fn creates_isolated_temp_profile_outside_live_user_data() {
        let base = std::env::temp_dir().join(format!("omnia_cdp_unit_{}", std::process::id()));
        let prof = create_isolated_profile_dir(Some(&base)).expect("isolated dir");
        assert!(prof.is_dir());
        assert!(!is_forbidden_live_browser_path(&prof));
        if let Ok(bin) = resolve_isolated_browser_binary(None) {
            assert!(
                !is_forbidden_live_browser_path(&bin),
                "resolved browser must never point to Thorium/live profile: {}",
                bin.display()
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parses_devtools_active_port_cleanly() {
        assert_eq!(
            parse_devtools_active_port("51234\n/devtools/browser/abc-123\n"),
            Some((51234, Some("/devtools/browser/abc-123".to_string())))
        );
        assert_eq!(parse_devtools_active_port("9222\n"), Some((9222, None)));
        assert_eq!(parse_devtools_active_port("0\n/devtools/browser/x"), None);
        assert_eq!(parse_devtools_active_port(""), None);
    }

    #[test]
    fn pending_call_guard_cleans_up_on_drop_and_stays_silent_when_disarmed() {
        let pending: PendingCdpRequests = Arc::new(Mutex::new(HashMap::new()));
        let (tx1, _rx1) = oneshot::channel();
        let (tx2, _rx2) = oneshot::channel();
        pending.lock().unwrap().insert(1, tx1);
        pending.lock().unwrap().insert(2, tx2);

        {
            let _g1 = PendingCallGuard::arm(Arc::clone(&pending), 1);
            let mut g2 = PendingCallGuard::arm(Arc::clone(&pending), 2);
            g2.disarm();
        }
        let map = pending.lock().unwrap();
        assert!(!map.contains_key(&1), "armed guard must remove aborted id");
        assert!(map.contains_key(&2), "disarmed guard must leave completed id");
    }

    #[test]
    fn parses_browser_batch_steps_and_key_chords() {
        let steps = parse_batch_steps(&[
            json!({ "action": "navigate", "url": "https://example.test" }),
            json!({ "action": "browser_click", "ref": "e4", "double": true }),
            json!({ "action": "type", "selector": "#email", "text": "hello", "clear": true }),
            json!({ "action": "press", "key": "Control+a" }),
            json!({ "action": "wait", "text": "Done", "timeout_ms": 2000 }),
        ])
        .expect("valid batch");
        assert_eq!(steps.len(), 5);
        assert!(parse_batch_steps(&[]).is_err());
        assert!(parse_batch_steps(&[json!({ "action": "unknown_op" })]).is_err());

        assert_eq!(
            parse_cdp_key_chord("Control+a"),
            (2, "a".to_string(), Some("selectAll"))
        );
        assert_eq!(
            parse_cdp_key_chord("Ctrl+Shift+z"),
            (10, "z".to_string(), Some("redo"))
        );
    }

    #[test]
    fn probe_json_version_reads_content_length_without_waiting_for_keepalive_eof() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind mock cdp");
        let port = listener.local_addr().unwrap().port();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();

        let srv = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().expect("accept");
            let mut req_buf = [0u8; 512];
            let _ = sock.read(&mut req_buf);
            let body = format!(
                r#"{{"Browser":"Chrome/151","webSocketDebuggerUrl":"ws://127.0.0.1:{port}/devtools/browser/test-id"}}"#
            );
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            sock.write_all(resp.as_bytes()).expect("write resp");
            sock.flush().ok();
            let _ = done_rx.recv_timeout(Duration::from_secs(5));
        });

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("rt");
        let t0 = std::time::Instant::now();
        let ws = rt
            .block_on(probe_json_version_ws_url(port))
            .expect("probe ok");
        assert!(
            t0.elapsed() < Duration::from_millis(1_000),
            "probe must return immediately via Content-Length without waiting for EOF"
        );
        assert_eq!(
            ws.as_deref(),
            Some(format!("ws://127.0.0.1:{port}/devtools/browser/test-id").as_str())
        );
        let _ = done_tx.send(());
        let _ = srv.join();
    }

    #[tokio::test]
    async fn live_mock_cdp_ws_executes_batch_stops_on_error_and_handles_dialogs_and_network() {
        use tokio_tungstenite::accept_async;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock ws");
        let addr = listener.local_addr().unwrap();
        let ws_url = format!("ws://{addr}/devtools/page/mock-1");

        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.expect("accept ws");
            let mut ws = accept_async(tcp).await.expect("handshake");

            // Emit synthetic CDP events right away: network request + JS alert dialog + OOPIF attach
            let _ = ws
                .send(WsMessage::Text(
                    json!({
                        "method": "Target.attachedToTarget",
                        "params": {
                            "sessionId": "iframe-sess-1",
                            "targetInfo": { "targetId": "frame-1", "type": "iframe", "url": "https://embed.example.test" }
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .await;
            let _ = ws
                .send(WsMessage::Text(
                    json!({
                        "method": "Network.requestWillBeSent",
                        "params": {
                            "requestId": "req-42",
                            "type": "Fetch",
                            "request": {
                                "url": "https://api.example.test/data?token=dummy_tok",
                                "method": "GET",
                                "headers": { "Accept": "application/json" }
                            }
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .await;
            let _ = ws
                .send(WsMessage::Text(
                    json!({
                        "method": "Network.loadingFinished",
                        "params": { "requestId": "req-42", "encodedDataLength": 128.0 }
                    })
                    .to_string()
                    .into(),
                ))
                .await;
            let _ = ws
                .send(WsMessage::Text(
                    json!({
                        "method": "Page.javascriptDialogOpening",
                        "params": { "type": "alert", "message": "Fixture alert" }
                    })
                    .to_string()
                    .into(),
                ))
                .await;

            while let Some(Ok(WsMessage::Text(txt))) = ws.next().await {
                let Ok(req) = serde_json::from_str::<Value>(txt.as_str()) else {
                    continue;
                };
                let Some(id) = req.get("id").and_then(Value::as_i64) else {
                    continue;
                };
                let method = req.get("method").and_then(Value::as_str).unwrap_or("");
                let resp = match method {
                    "Runtime.evaluate" => {
                        let expr = req
                            .pointer("/params/expression")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        if expr.contains("FAIL_ME") {
                            json!({ "id": id, "result": { "exceptionDetails": { "text": "boom" } } })
                        } else {
                            json!({ "id": id, "result": { "result": { "value": 42 } } })
                        }
                    }
                    _ => json!({ "id": id, "result": {} }),
                };
                if ws.send(WsMessage::Text(resp.to_string().into())).await.is_err() {
                    break;
                }
            }
        });

        let session = CdpSession::connect(&ws_url).await.expect("connect mock cdp");
        // Allow background events to process
        tokio::time::sleep(Duration::from_millis(80)).await;

        assert_eq!(session.iframe_session_count(), 1);
        let net = session.network_entries(&NetworkFilter::default());
        assert_eq!(net.len(), 1);
        assert_eq!(net[0].request_id, "req-42");

        let dialogs = session.take_dialogs();
        assert_eq!(dialogs.len(), 1);
        assert_eq!(dialogs[0].dialog_type, "alert");
        assert!(dialogs[0].accepted);

        // Execute batch: step 0 succeeds, step 1 fails, step 2 MUST NOT execute!
        let batch_steps = parse_batch_steps(&[
            json!({ "action": "eval", "expression": "1 + 1", "label": "ok-eval" }),
            json!({ "action": "eval", "expression": "FAIL_ME()", "label": "fail-eval" }),
            json!({ "action": "eval", "expression": "should_not_run()", "label": "skipped" }),
        ])
        .unwrap();
        let report = session.execute_batch(&batch_steps, false).await;
        assert!(!report.ok);
        assert_eq!(report.completed, 1);
        assert_eq!(report.total, 3);
        assert_eq!(report.steps.len(), 2);
        assert!(report.steps[0].ok);
        assert!(!report.steps[1].ok);

        session.close().await;
        server.abort();
    }
}
