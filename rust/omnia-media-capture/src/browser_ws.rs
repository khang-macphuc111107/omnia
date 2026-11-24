//! Isolated Chromium/Edge Launcher (`D:\OmniaData\tmp\omnia-cdp-*`, strictly rejecting
//! Thorium) + Live WebSocket CDP Session Client + Virtual Cursor Overlay.

use crate::browser_cdp::validate_loopback_cdp_url;
use futures_util::{SinkExt, StreamExt};

const DEFAULT_CDP_HTTP_TIMEOUT_MS: u64 = 2_500;

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
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use tokio_tungstenite::tungstenite::Message as WsMessage;

static PROFILE_SEQ: AtomicU64 = AtomicU64::new(1);

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
    let lower = path.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
    lower.contains("thorium")
        || lower.contains("\\microsoft\\edge\\user data")
        || lower.contains("\\google\\chrome\\user data")
        || lower.contains("\\brave-browser\\user data")
}

/// Discovers a valid non-Thorium Chromium/Edge executable on the host (`OMNIA_BROWSER_BIN` + `E:`/`C:` paths).
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

    // 1. Prefer isolated automation Chromium installs (`ms-playwright`) before system browsers / WebView runtimes.
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

    // 2. Installed full Chromium / Chrome / Edge executables (strictly launched with isolated temp profile).
    candidates.extend([
        PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        PathBuf::from(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    ]);

    // 3. EdgeCore fallback last (some WebView-only builds ignore `--remote-debugging-port`).
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

/// Launches an isolated headless/windowed Chromium/Edge browser bound to a fresh loopback CDP port.
pub async fn launch_isolated_browser(
    opts: IsolatedBrowserLaunchOptions,
) -> Result<IsolatedBrowserHandle, String> {
    let exe = resolve_isolated_browser_binary(opts.browser_bin.as_deref())?;
    let user_data_dir = create_isolated_profile_dir(opts.temp_root.as_deref())?;
    let port = allocate_loopback_port()?;

    let mut args = vec![
        format!("--remote-debugging-port={port}"),
        "--remote-debugging-address=127.0.0.1".into(),
        "--remote-allow-origins=http://127.0.0.1,http://localhost".into(),
        format!("--user-data-dir={}", user_data_dir.to_string_lossy()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-background-networking".into(),
        "--disable-sync".into(),
        "--disable-extensions".into(),
        "--disable-blink-features=AutomationControlled".into(),
        format!("--window-size={},{}", opts.viewport_width, opts.viewport_height),
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

    let http_url = format!("http://127.0.0.1:{port}");
    validate_cdp_http_url(&http_url)?;

    let deadline = tokio::time::Instant::now()
        + Duration::from_millis(opts.startup_timeout_ms.clamp(2_000, 45_000));
    let ws_browser_url = loop {
        match probe_json_version_ws_url(port).await {
            Ok(Some(ws)) => break ws,
            Ok(None) | Err(_) => {
                if tokio::time::Instant::now() >= deadline {
                    omnia_workspace_ops::win32_window::close_job_handle(job_raw);
                    let _ = std::fs::remove_dir_all(&user_data_dir);
                    return Err(format!(
                        "timed out waiting for CDP endpoint on 127.0.0.1:{port}"
                    ));
                }
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
        }
    };
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

fn allocate_loopback_port() -> Result<u16, String> {
    let listener =
        std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();
    drop(listener);
    Ok(port)
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

/// Real WebSocket CDP Session attached to an isolated Chromium page target with virtual cursor overlay.
pub struct CdpSession {
    writer: Arc<
        AsyncMutex<
            futures_util::stream::SplitSink<
                tokio_tungstenite::WebSocketStream<
                    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
                >,
                WsMessage,
            >,
        >,
    >,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>,
    next_id: AtomicI64,
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

impl CdpSession {
    /// Connects to a validated loopback CDP WebSocket URL (`/devtools/browser/...` or `/devtools/page/...`).
    pub async fn connect(ws_url: &str) -> Result<Arc<Self>, String> {
        validate_cdp_ws_url(ws_url)?;
        let (ws_stream, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .map_err(|e| format!("CDP WebSocket connect `{ws_url}` failed: {e}"))?;
        let (sink, mut stream) = ws_stream.split();
        let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let reader_pending = Arc::clone(&pending);

        tokio::spawn(async move {
            while let Some(Ok(msg)) = stream.next().await {
                if let WsMessage::Text(txt) = msg {
                    if let Ok(val) = serde_json::from_str::<Value>(txt.as_str()) {
                        if let Some(id) = val.get("id").and_then(Value::as_i64) {
                            let tx = reader_pending.lock().ok().and_then(|mut m| m.remove(&id));
                            if let Some(tx) = tx {
                                if let Some(err) = val.get("error") {
                                    let _ = tx.send(Err(err.to_string()));
                                } else {
                                    let _ = tx.send(Ok(val
                                        .get("result")
                                        .cloned()
                                        .unwrap_or(Value::Null)));
                                }
                            }
                        }
                    }
                }
            }
        });

        let mut session = Self {
            writer: Arc::new(AsyncMutex::new(sink)),
            pending,
            next_id: AtomicI64::new(1),
            target_id: String::new(),
            session_id: String::new(),
            last_cursor: Mutex::new((40.0, 40.0)),
        };

        // Attach to first existing page target or create one when connecting to browser-level WS.
        if ws_url.contains("/devtools/browser/") {
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
            session.target_id = tid;
            session.session_id = attached
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
        }

        let sid = (!session.session_id.is_empty()).then_some(session.session_id.as_str());
        let _ = session.call_raw(sid, "Page.enable", json!({})).await;
        let _ = session.call_raw(sid, "Runtime.enable", json!({})).await;
        let _ = session.call_raw(sid, "DOM.enable", json!({})).await;
        let arc = Arc::new(session);
        let _ = arc.inject_virtual_cursor_overlay().await;
        Ok(arc)
    }

    async fn call_raw(
        &self,
        session_id: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
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

        {
            let mut w = self.writer.lock().await;
            w.send(WsMessage::Text(msg.to_string().into()))
                .await
                .map_err(|e| {
                    if let Ok(mut m) = self.pending.lock() {
                        m.remove(&id);
                    }
                    format!("CDP send `{method}` failed: {e}")
                })?;
        }

        tokio::time::timeout(Duration::from_secs(15), rx)
            .await
            .map_err(|_| {
                if let Ok(mut m) = self.pending.lock() {
                    m.remove(&id);
                }
                format!("CDP `{method}` timed out")
            })?
            .map_err(|_| "CDP channel closed".to_owned())?
    }

    fn page_session(&self) -> Option<&str> {
        (!self.session_id.is_empty()).then_some(self.session_id.as_str())
    }

    pub async fn navigate(&self, url: &str) -> Result<Value, String> {
        let res = self
            .call_raw(self.page_session(), "Page.navigate", json!({ "url": url }))
            .await?;
        tokio::time::sleep(Duration::from_millis(400)).await;
        let _ = self.inject_virtual_cursor_overlay().await;
        Ok(res)
    }

    pub async fn eval_js(&self, expression: &str) -> Result<Value, String> {
        let res = self
            .call_raw(
                self.page_session(),
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
        self.call_raw(
            self.page_session(),
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": x, "y": y }),
        )
        .await?;
        Ok(())
    }

    pub async fn click_at(&self, x: f64, y: f64, label: Option<&str>) -> Result<Value, String> {
        self.move_virtual_cursor(x, y, label.unwrap_or("click"))
            .await?;
        let lbl_json = serde_json::to_string(label.unwrap_or("click")).unwrap_or_else(|_| "\"click\"".into());
        let _ = self
            .eval_js(&format!(
                "window.__omniaMoveCursor && window.__omniaMoveCursor({x}, {y}, {lbl_json}, true)"
            ))
            .await;
        self.call_raw(
            self.page_session(),
            "Input.dispatchMouseEvent",
            json!({
                "type": "mousePressed",
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": 1
            }),
        )
        .await?;
        self.call_raw(
            self.page_session(),
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseReleased",
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": 1
            }),
        )
        .await?;
        Ok(json!({ "clicked": true, "x": x, "y": y }))
    }

    pub async fn click_selector(&self, selector: &str) -> Result<Value, String> {
        let sel_json = serde_json::to_string(selector).map_err(|e| e.to_string())?;
        let pt = self
            .eval_js(&format!(
                r#"(function(){{
                    const el = document.querySelector({sel_json});
                    if (!el) return null;
                    el.scrollIntoView({{block:'center', inline:'center'}});
                    const r = el.getBoundingClientRect();
                    return {{ x: r.left + r.width / 2, y: r.top + r.height / 2 }};
                }})()"#
            ))
            .await?;
        let Some(x) = pt.get("x").and_then(Value::as_f64) else {
            return Err(format!("element not found for selector `{selector}`"));
        };
        let y = pt.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        self.click_at(x, y, Some(selector)).await
    }

    pub async fn type_text(&self, text: &str) -> Result<Value, String> {
        self.call_raw(
            self.page_session(),
            "Input.insertText",
            json!({ "text": text }),
        )
        .await
    }

    pub async fn screenshot_png_base64(&self) -> Result<String, String> {
        let res = self
            .call_raw(
                self.page_session(),
                "Page.captureScreenshot",
                json!({ "format": "png", "fromSurface": true }),
            )
            .await?;
        res.get("data")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "Page.captureScreenshot returned no image data".to_owned())
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
        let mut w = self.writer.lock().await;
        let _ = w.close().await;
    }
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
            // Keep socket open intentionally (Chromium behavior) until test completes!
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
}
