//! Finding, launching and attaching to a Chromium-based browser.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};

use crate::error::{BrowserError, Result};

/// How to start a managed browser.
#[derive(Debug, Clone)]
pub struct LaunchOptions {
    /// Browser executable; auto-detected (Edge first on Windows) when `None`.
    pub executable: Option<PathBuf>,
    /// Dedicated persistent profile directory (`--user-data-dir`).
    pub profile_dir: PathBuf,
    pub headless: bool,
    pub window_size: Option<(u32, u32)>,
    pub extra_args: Vec<String>,
    pub startup_timeout: Duration,
}

impl LaunchOptions {
    pub fn new(profile_dir: impl Into<PathBuf>) -> Self {
        Self {
            executable: None,
            profile_dir: profile_dir.into(),
            headless: false,
            window_size: Some((1280, 900)),
            extra_args: Vec::new(),
            startup_timeout: Duration::from_secs(20),
        }
    }
}

/// A browser process we started. The child is killed when this is dropped.
pub struct LaunchedProcess {
    pub child: Child,
    pub port: u16,
    pub ws_url: String,
    pub executable: PathBuf,
}

/// Known install locations for the current OS, most preferred first.
pub fn candidate_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(windows) {
        let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
        let roots = [
            env("ProgramFiles(x86)"),
            env("ProgramFiles"),
            env("LOCALAPPDATA"),
        ];
        for root in roots.iter().flatten() {
            out.push(root.join(r"Microsoft\Edge\Application\msedge.exe"));
        }
        for root in roots.iter().flatten() {
            out.push(root.join(r"Google\Chrome\Application\chrome.exe"));
        }
        for root in roots.iter().flatten() {
            out.push(root.join(r"Google\Chrome SxS\Application\chrome.exe"));
        }
        for root in roots.iter().flatten() {
            out.push(root.join(r"Chromium\Application\chrome.exe"));
        }
    } else if cfg!(target_os = "macos") {
        for app in [
            "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "Google Chrome.app/Contents/MacOS/Google Chrome",
            "Chromium.app/Contents/MacOS/Chromium",
        ] {
            out.push(PathBuf::from("/Applications").join(app));
            if let Some(home) = std::env::var_os("HOME") {
                out.push(PathBuf::from(home).join("Applications").join(app));
            }
        }
    } else {
        for name in [
            "microsoft-edge",
            "microsoft-edge-stable",
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
        ] {
            for dir in [
                "/usr/bin",
                "/usr/local/bin",
                "/snap/bin",
                "/opt/google/chrome",
            ] {
                out.push(Path::new(dir).join(name));
            }
        }
    }
    out
}

/// First existing browser executable, if any.
pub fn find_browser() -> Option<PathBuf> {
    candidate_paths().into_iter().find(|path| path.is_file())
}

/// Command-line arguments for a managed launch.
pub fn build_args(options: &LaunchOptions) -> Vec<String> {
    let mut args = vec![
        "--remote-debugging-port=0".to_string(),
        format!("--user-data-dir={}", options.profile_dir.display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-features=Translate".into(),
        "--disable-popup-blocking".into(),
    ];
    if options.headless {
        args.push("--headless=new".into());
    }
    if let Some((w, h)) = options.window_size {
        args.push(format!("--window-size={w},{h}"));
    }
    args.extend(options.extra_args.iter().cloned());
    args.push("about:blank".into());
    args
}

/// Parses the `DevToolsActivePort` file: port on line one, ws path on line two.
pub fn parse_devtools_active_port(contents: &str) -> Option<(u16, String)> {
    let mut lines = contents.lines();
    let port = lines.next()?.trim().parse::<u16>().ok()?;
    let path = lines.next()?.trim();
    if path.is_empty() {
        return None;
    }
    Some((port, path.to_string()))
}

/// Starts the browser and waits for it to publish its DevTools endpoint.
pub async fn launch_process(options: &LaunchOptions) -> Result<LaunchedProcess> {
    let executable = match &options.executable {
        Some(path) => path.clone(),
        None => find_browser().ok_or(BrowserError::NoBrowser)?,
    };
    tokio::fs::create_dir_all(&options.profile_dir).await?;
    let port_file = options.profile_dir.join("DevToolsActivePort");
    let _ = tokio::fs::remove_file(&port_file).await;

    let mut command = Command::new(&executable);
    command
        .args(build_args(options))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| BrowserError::Launch(format!("cannot start {}: {e}", executable.display())))?;

    let deadline = tokio::time::Instant::now() + options.startup_timeout;
    loop {
        if let Ok(contents) = tokio::fs::read_to_string(&port_file).await {
            if let Some((port, path)) = parse_devtools_active_port(&contents) {
                return Ok(LaunchedProcess {
                    child,
                    port,
                    ws_url: format!("ws://127.0.0.1:{port}{path}"),
                    executable,
                });
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(BrowserError::Launch(format!(
                "browser exited early ({status}); another instance may already be using the profile {}",
                options.profile_dir.display()
            )));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(BrowserError::Launch(
                "timed out waiting for DevToolsActivePort".into(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Minimal HTTP/1.1 GET against a local DevTools endpoint.
async fn http_get(host: &str, port: u16, path: &str) -> Result<String> {
    let mut stream = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect((host, port)),
    )
    .await
    .map_err(|_| BrowserError::Launch(format!("timed out connecting to {host}:{port}")))??;
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await?;
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut raw))
        .await
        .map_err(|_| BrowserError::Launch("timed out reading DevTools response".into()))??;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| BrowserError::Launch("malformed DevTools HTTP response".into()))?;
    if !head.starts_with("HTTP/1.1 200") && !head.starts_with("HTTP/1.0 200") {
        return Err(BrowserError::Launch(format!(
            "DevTools endpoint answered `{}`",
            head.lines().next().unwrap_or("")
        )));
    }
    Ok(body.to_string())
}

/// Turns `ws://...`, `http://host:port` or `host:port`/`port` into a browser ws URL.
pub async fn resolve_ws_url(endpoint: &str) -> Result<String> {
    let endpoint = endpoint.trim();
    if endpoint.starts_with("ws://") || endpoint.starts_with("wss://") {
        return Ok(crate::safety::local_endpoint(endpoint, true)?.to_string());
    }
    let normalized = if endpoint.chars().all(|c| c.is_ascii_digit()) {
        format!("http://127.0.0.1:{endpoint}")
    } else if endpoint.contains("://") {
        endpoint.to_string()
    } else {
        format!("http://{endpoint}")
    };
    let url = crate::safety::local_endpoint(&normalized, false)?;
    let host = url
        .host_str()
        .unwrap_or("127.0.0.1")
        .trim_matches(['[', ']'])
        .to_string();
    let port = url.port().unwrap_or(9222);
    let body = http_get(&host, port, "/json/version").await?;
    let value: serde_json::Value = serde_json::from_str(&body)?;
    value
        .get("webSocketDebuggerUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| BrowserError::Launch("/json/version has no webSocketDebuggerUrl".into()))
        .and_then(|endpoint| crate::safety::local_endpoint(endpoint, true).map(|u| u.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_active_port_file() {
        assert_eq!(
            parse_devtools_active_port("9222\n/devtools/browser/abc-123\n"),
            Some((9222, "/devtools/browser/abc-123".into()))
        );
        assert_eq!(parse_devtools_active_port("9222\n"), None);
        assert_eq!(parse_devtools_active_port("nope\n/x"), None);
    }

    #[test]
    fn builds_expected_args() {
        let mut options = LaunchOptions::new("C:/profile");
        options.headless = true;
        options.window_size = Some((800, 600));
        options.extra_args.push("--foo".into());
        let args = build_args(&options);
        assert!(args.contains(&"--remote-debugging-port=0".to_string()));
        assert!(args.contains(&"--headless=new".to_string()));
        assert!(args.contains(&"--window-size=800,600".to_string()));
        assert!(args.contains(&"--disable-features=Translate".to_string()));
        assert!(args.iter().any(|a| a.starts_with("--user-data-dir=")));
        assert_eq!(args.last().map(String::as_str), Some("about:blank"));
        options.headless = false;
        assert!(!build_args(&options).contains(&"--headless=new".to_string()));
    }

    #[tokio::test]
    async fn resolves_ws_endpoint_via_json_version() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /json/version"));
            let body = r#"{"webSocketDebuggerUrl":"ws://127.0.0.1:1/devtools/browser/x"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let ws = resolve_ws_url(&format!("http://127.0.0.1:{port}"))
            .await
            .unwrap();
        assert_eq!(ws, "ws://127.0.0.1:1/devtools/browser/x");
        assert_eq!(
            resolve_ws_url("ws://127.0.0.1:5/devtools/browser/y")
                .await
                .unwrap(),
            "ws://127.0.0.1:5/devtools/browser/y"
        );
    }
}
