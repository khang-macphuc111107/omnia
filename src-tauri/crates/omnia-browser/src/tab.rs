//! A single page target: event-driven state, navigation, evaluation, snapshots.

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::cdp::{CdpClient, CdpEvent};
use crate::error::{BrowserError, Result};
use crate::snapshot::{format_snapshot, Snapshot, SnapshotData, SnapshotOptions, SNAPSHOT_JS};

const CONSOLE_CAP: usize = 500;
const IGNORED_NET_TYPES: &[&str] = &[
    "WebSocket",
    "EventSource",
    "Ping",
    "Prefetch",
    "CSPViolationReport",
];

/// What to do with JavaScript dialogs (alert/confirm/prompt/beforeunload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DialogPolicy {
    /// Accept alerts and `beforeunload`; dismiss confirm and prompt.
    #[default]
    Auto,
    AcceptAll,
    DismissAll,
}

impl DialogPolicy {
    pub fn should_accept(self, kind: &str) -> bool {
        match self {
            Self::AcceptAll => true,
            Self::DismissAll => false,
            Self::Auto => matches!(kind, "alert" | "beforeunload"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DialogRecord {
    pub kind: String,
    pub message: String,
    pub accepted: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConsoleMessage {
    /// `error`, `warning`, `info`, `log` or `debug`.
    pub level: String,
    pub text: String,
    /// `url:line` when known.
    pub location: Option<String>,
    pub timestamp: f64,
}

impl ConsoleMessage {
    pub fn rank(level: &str) -> u8 {
        match level {
            "error" => 3,
            "warning" | "warn" => 2,
            "debug" => 0,
            _ => 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TabInfo {
    pub id: String,
    pub url: String,
    pub title: String,
}

#[derive(Default)]
pub(crate) struct TabState {
    pub url: String,
    pub title: String,
    pub inflight: HashSet<String>,
    pub loading_frames: HashSet<String>,
    pub last_activity: Option<Instant>,
    pub console: VecDeque<ConsoleMessage>,
    pub dialogs: Vec<DialogRecord>,
}

pub(crate) struct TabInner {
    pub target_id: String,
    pub session_id: String,
    pub client: CdpClient,
    pub state: Mutex<TabState>,
    pub dialog_policy: Arc<Mutex<DialogPolicy>>,
}

/// Cheaply cloneable handle to one tab.
#[derive(Clone)]
pub struct Tab {
    pub(crate) inner: Arc<TabInner>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitUntil {
    /// Return once the navigation committed.
    Commit,
    /// Wait for the `load` event.
    Load,
    /// `load`, then until no requests were in flight for 500 ms.
    NetworkIdle,
}

#[derive(Debug, Clone, Copy)]
pub struct NavigateOptions {
    pub wait: WaitUntil,
    pub timeout: Duration,
}

impl Default for NavigateOptions {
    fn default() -> Self {
        Self {
            wait: WaitUntil::NetworkIdle,
            timeout: Duration::from_secs(30),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct NavigationResult {
    pub url: String,
    pub title: String,
    /// False when the wait timed out before load/idle (the page may still be loading).
    pub loaded: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WaitCondition {
    Text(String),
    TextGone(String),
    Selector(String),
    Delay(Duration),
}

pub(crate) fn check_exception(response: &Value) -> Result<()> {
    if let Some(details) = response.get("exceptionDetails") {
        let text = details["exception"]["description"]
            .as_str()
            .or_else(|| details["exception"]["value"].as_str())
            .or_else(|| details["text"].as_str())
            .unwrap_or("exception");
        return Err(BrowserError::Js(
            text.lines().take(6).collect::<Vec<_>>().join("\n"),
        ));
    }
    Ok(())
}

fn remote_object_text(arg: &Value) -> String {
    if let Some(value) = arg.get("value") {
        return match value {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
    }
    if let Some(text) = arg["unserializableValue"].as_str() {
        return text.to_string();
    }
    arg["description"]
        .as_str()
        .or_else(|| arg["type"].as_str())
        .unwrap_or("")
        .to_string()
}

impl Tab {
    pub(crate) fn new(
        client: CdpClient,
        target_id: String,
        session_id: String,
        dialog_policy: Arc<Mutex<DialogPolicy>>,
        url: String,
        title: String,
    ) -> Self {
        Self {
            inner: Arc::new(TabInner {
                target_id,
                session_id,
                client,
                state: Mutex::new(TabState {
                    url,
                    title,
                    ..Default::default()
                }),
                dialog_policy,
            }),
        }
    }

    pub(crate) fn state(&self) -> MutexGuard<'_, TabState> {
        self.inner.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn id(&self) -> &str {
        &self.inner.target_id
    }

    pub fn session_id(&self) -> &str {
        &self.inner.session_id
    }

    pub fn client(&self) -> &CdpClient {
        &self.inner.client
    }

    /// Last known URL/title (kept current by events).
    pub fn info(&self) -> TabInfo {
        let state = self.state();
        TabInfo {
            id: self.inner.target_id.clone(),
            url: state.url.clone(),
            title: state.title.clone(),
        }
    }

    pub(crate) fn set_info(&self, url: Option<&str>, title: Option<&str>) {
        let mut state = self.state();
        if let Some(url) = url {
            state.url = url.to_string();
        }
        if let Some(title) = title {
            state.title = title.to_string();
        }
    }

    /// Sends a command on this tab's session.
    pub async fn send(&self, method: &str, params: Value) -> Result<Value> {
        self.inner
            .client
            .send(method, params, Some(&self.inner.session_id))
            .await
    }

    pub async fn send_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        self.inner
            .client
            .send_with_timeout(method, params, Some(&self.inner.session_id), timeout)
            .await
    }

    /// Folds one event for this tab's session (or a child session) into its state.
    pub(crate) fn handle_event(&self, event: &CdpEvent) {
        let p = &event.params;
        let mut spawn_dialog = None;
        {
            let mut state = self.state();
            match event.method.as_str() {
                "Network.requestWillBeSent" => {
                    let kind = p["type"].as_str().unwrap_or("");
                    if !IGNORED_NET_TYPES.contains(&kind) {
                        if let Some(id) = p["requestId"].as_str() {
                            state.inflight.insert(id.to_string());
                        }
                    }
                    state.last_activity = Some(Instant::now());
                }
                "Network.loadingFinished" | "Network.loadingFailed" => {
                    if let Some(id) = p["requestId"].as_str() {
                        state.inflight.remove(id);
                    }
                    state.last_activity = Some(Instant::now());
                }
                "Page.frameStartedLoading" => {
                    if let Some(id) = p["frameId"].as_str() {
                        state.loading_frames.insert(id.to_string());
                    }
                    state.last_activity = Some(Instant::now());
                }
                "Page.frameStoppedLoading" => {
                    if let Some(id) = p["frameId"].as_str() {
                        state.loading_frames.remove(id);
                    }
                    state.last_activity = Some(Instant::now());
                }
                "Page.frameNavigated" => {
                    let frame = &p["frame"];
                    if frame.get("parentId").is_none() {
                        if let Some(url) = frame["url"].as_str() {
                            state.url = url.to_string();
                        }
                        state.inflight.clear();
                    }
                    state.last_activity = Some(Instant::now());
                }
                "Page.loadEventFired" => state.last_activity = Some(Instant::now()),
                "Runtime.consoleAPICalled" => {
                    let level = match p["type"].as_str().unwrap_or("log") {
                        "warning" => "warning",
                        "error" | "assert" => "error",
                        "info" => "info",
                        "debug" | "trace" => "debug",
                        _ => "log",
                    };
                    let text = p["args"]
                        .as_array()
                        .map(|args| {
                            args.iter()
                                .map(remote_object_text)
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                        .unwrap_or_default();
                    let frame = &p["stackTrace"]["callFrames"][0];
                    let location = frame["url"]
                        .as_str()
                        .filter(|u| !u.is_empty())
                        .map(|u| format!("{u}:{}", frame["lineNumber"].as_i64().unwrap_or(0) + 1));
                    push_console(
                        &mut state.console,
                        ConsoleMessage {
                            level: level.into(),
                            text,
                            location,
                            timestamp: p["timestamp"].as_f64().unwrap_or(0.0),
                        },
                    );
                }
                "Log.entryAdded" => {
                    let entry = &p["entry"];
                    let level = match entry["level"].as_str().unwrap_or("info") {
                        "warning" => "warning",
                        "error" => "error",
                        "verbose" => "debug",
                        _ => "info",
                    };
                    push_console(
                        &mut state.console,
                        ConsoleMessage {
                            level: level.into(),
                            text: entry["text"].as_str().unwrap_or("").to_string(),
                            location: entry["url"].as_str().filter(|u| !u.is_empty()).map(|u| {
                                format!("{u}:{}", entry["lineNumber"].as_i64().unwrap_or(0) + 1)
                            }),
                            timestamp: entry["timestamp"].as_f64().unwrap_or(0.0),
                        },
                    );
                }
                "Runtime.exceptionThrown" => {
                    let details = &p["exceptionDetails"];
                    let text = details["exception"]["description"]
                        .as_str()
                        .or_else(|| details["text"].as_str())
                        .unwrap_or("Uncaught exception");
                    push_console(
                        &mut state.console,
                        ConsoleMessage {
                            level: "error".into(),
                            text: text.lines().next().unwrap_or("").to_string(),
                            location: details["url"].as_str().map(|u| {
                                format!("{u}:{}", details["lineNumber"].as_i64().unwrap_or(0) + 1)
                            }),
                            timestamp: p["timestamp"].as_f64().unwrap_or(0.0),
                        },
                    );
                }
                "Page.javascriptDialogOpening" => {
                    let kind = p["type"].as_str().unwrap_or("alert").to_string();
                    let policy = *self
                        .inner
                        .dialog_policy
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    let accept = policy.should_accept(&kind);
                    let message = p["message"].as_str().unwrap_or("").to_string();
                    state.dialogs.push(DialogRecord {
                        kind: kind.clone(),
                        message,
                        accepted: accept,
                    });
                    spawn_dialog = Some((
                        accept,
                        p["defaultPrompt"].as_str().unwrap_or("").to_string(),
                    ));
                }
                _ => {}
            }
        }
        if let Some((accept, prompt)) = spawn_dialog {
            let tab = self.clone();
            tokio::spawn(async move {
                let _ = tab
                    .send(
                        "Page.handleJavaScriptDialog",
                        json!({"accept": accept, "promptText": prompt}),
                    )
                    .await;
            });
        }
    }

    /// Dialogs auto-handled since the last call.
    pub fn take_dialogs(&self) -> Vec<DialogRecord> {
        std::mem::take(&mut self.state().dialogs)
    }

    /// Console messages at or above `min_level`, newest last.
    pub fn console(&self, min_level: Option<&str>, limit: usize) -> Vec<ConsoleMessage> {
        let min = min_level.map(ConsoleMessage::rank).unwrap_or(0);
        let state = self.state();
        let mut out: Vec<ConsoleMessage> = state
            .console
            .iter()
            .filter(|m| ConsoleMessage::rank(&m.level) >= min)
            .cloned()
            .collect();
        if out.len() > limit {
            out.drain(..out.len() - limit);
        }
        out
    }

    pub fn clear_console(&self) {
        self.state().console.clear();
    }

    // ------------------------------------------------------------ evaluation

    /// Evaluates JS (awaiting promises) and returns the JSON-serializable result.
    pub async fn evaluate(&self, expression: &str) -> Result<Value> {
        let response = self
            .send(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                    "userGesture": true,
                    "objectGroup": "omnia",
                }),
            )
            .await?;
        check_exception(&response)?;
        Ok(response["result"]
            .get("value")
            .cloned()
            .unwrap_or(Value::Null))
    }

    /// Current `(url, title)` read from the page itself; refreshes the cache.
    pub async fn page_state(&self) -> Result<(String, String)> {
        let value = self
            .evaluate("JSON.stringify([location.href, document.title])")
            .await?;
        let pair: Vec<String> = serde_json::from_str(value.as_str().unwrap_or("[]"))?;
        let url = pair.first().cloned().unwrap_or_default();
        let title = pair.get(1).cloned().unwrap_or_default();
        self.set_info(Some(&url), Some(&title));
        Ok((url, title))
    }

    /// Readable page text (`document.body.innerText`), truncated to `max_chars`.
    pub async fn get_text(&self, max_chars: usize) -> Result<String> {
        let value = self
            .evaluate("document.body ? document.body.innerText : ''")
            .await?;
        let text = value.as_str().unwrap_or("");
        if text.chars().count() > max_chars {
            let cut: String = text.chars().take(max_chars).collect();
            Ok(format!(
                "{cut}\n... [truncated {} chars]",
                text.chars().count() - max_chars
            ))
        } else {
            Ok(text.to_string())
        }
    }

    pub async fn snapshot(&self, options: &SnapshotOptions) -> Result<Snapshot> {
        let expression = format!(
            "{SNAPSHOT_JS}.snapshot({})",
            json!({
                "interactive": options.interactive_only,
                "visibleOnly": options.visible_only,
                "selector": options.selector,
                "maxNodes": options.max_nodes,
            })
        );
        let value = self.evaluate(&expression).await?;
        let raw = value
            .as_str()
            .ok_or_else(|| BrowserError::Js("snapshot returned no data".into()))?;
        let data: SnapshotData = serde_json::from_str(raw)?;
        self.set_info(Some(&data.url), Some(&data.title));
        Ok(format_snapshot(&data, options))
    }

    // ------------------------------------------------------------ navigation

    async fn wait_load(
        &self,
        rx: tokio::sync::broadcast::Receiver<CdpEvent>,
        timeout: Duration,
    ) -> bool {
        let session = self.inner.session_id.clone();
        self.inner
            .client
            .wait_event(rx, timeout, move |e| {
                e.method == "Page.loadEventFired"
                    && e.session_id.as_deref() == Some(session.as_str())
            })
            .await
            .is_ok()
    }

    /// Polls until no request was in flight for `quiet`, or `timeout` passes.
    pub async fn wait_network_idle(&self, quiet: Duration, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            let idle = {
                let state = self.state();
                state.inflight.is_empty()
                    && state.last_activity.is_none_or(|t| t.elapsed() >= quiet)
            };
            if idle {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Lets an action's side effects (navigation, XHR) finish, bounded by `timeout`.
    pub async fn settle(&self, timeout: Duration) {
        tokio::time::sleep(Duration::from_millis(120)).await;
        let deadline = Instant::now() + timeout;
        loop {
            let done = {
                let state = self.state();
                state.loading_frames.is_empty()
                    && state.inflight.is_empty()
                    && state
                        .last_activity
                        .is_none_or(|t| t.elapsed() >= Duration::from_millis(250))
            };
            if done || Instant::now() >= deadline {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn finish_navigation(
        &self,
        rx: tokio::sync::broadcast::Receiver<CdpEvent>,
        expect_load: bool,
        options: &NavigateOptions,
    ) -> NavigationResult {
        let started = Instant::now();
        let mut loaded = true;
        if expect_load && options.wait != WaitUntil::Commit {
            loaded = self.wait_load(rx, options.timeout).await;
            if loaded && options.wait == WaitUntil::NetworkIdle {
                let left = options.timeout.saturating_sub(started.elapsed());
                loaded = self
                    .wait_network_idle(
                        Duration::from_millis(500),
                        left.min(Duration::from_secs(10)),
                    )
                    .await
                    || loaded;
            }
        }
        let (url, title) = self
            .page_state()
            .await
            .unwrap_or_else(|_| (self.info().url, self.info().title));
        NavigationResult { url, title, loaded }
    }

    pub async fn navigate(&self, url: &str, options: &NavigateOptions) -> Result<NavigationResult> {
        crate::safety::navigation_url(url)?;
        let rx = self.inner.client.subscribe();
        let response = self
            .send_timeout("Page.navigate", json!({"url": url}), options.timeout)
            .await?;
        if let Some(error) = response["errorText"].as_str() {
            return Err(BrowserError::Invalid(format!(
                "navigation to {url} failed: {error}"
            )));
        }
        let expect_load = response.get("loaderId").is_some()
            && !response["isDownload"].as_bool().unwrap_or(false);
        Ok(self.finish_navigation(rx, expect_load, options).await)
    }

    pub async fn reload(&self, options: &NavigateOptions) -> Result<NavigationResult> {
        let rx = self.inner.client.subscribe();
        self.send("Page.reload", json!({})).await?;
        Ok(self.finish_navigation(rx, true, options).await)
    }

    async fn go_history(&self, delta: i64, options: &NavigateOptions) -> Result<NavigationResult> {
        let history = self.send("Page.getNavigationHistory", json!({})).await?;
        let current = history["currentIndex"].as_i64().unwrap_or(0);
        let target = current + delta;
        let entries = history["entries"].as_array().cloned().unwrap_or_default();
        let Some(entry) = usize::try_from(target).ok().and_then(|i| entries.get(i)) else {
            return Err(BrowserError::Invalid(if delta < 0 {
                "no previous page in history".into()
            } else {
                "no next page in history".into()
            }));
        };
        let rx = self.inner.client.subscribe();
        self.send(
            "Page.navigateToHistoryEntry",
            json!({"entryId": entry["id"]}),
        )
        .await?;
        Ok(self.finish_navigation(rx, true, options).await)
    }

    pub async fn go_back(&self, options: &NavigateOptions) -> Result<NavigationResult> {
        self.go_history(-1, options).await
    }

    pub async fn go_forward(&self, options: &NavigateOptions) -> Result<NavigationResult> {
        self.go_history(1, options).await
    }

    // ------------------------------------------------------------ waiting

    pub async fn wait_for(&self, condition: &WaitCondition, timeout: Duration) -> Result<()> {
        if let WaitCondition::Delay(delay) = condition {
            tokio::time::sleep((*delay).min(timeout.max(Duration::from_secs(60)))).await;
            return Ok(());
        }
        let probe = match condition {
            WaitCondition::Text(t) | WaitCondition::TextGone(t) => format!(
                "(function(t){{function has(d){{try{{if(d.body&&d.body.innerText.includes(t))return true;}}catch(e){{}}\
                 for(const f of d.querySelectorAll('iframe')){{try{{if(f.contentDocument&&has(f.contentDocument))return true;}}catch(e){{}}}}return false;}}\
                 return has(document);}})({})",
                Value::String(t.clone())
            ),
            WaitCondition::Selector(s) => format!(
                "!!document.querySelector({})",
                Value::String(s.clone())
            ),
            WaitCondition::Delay(_) => unreachable!("handled above"),
        };
        let want = !matches!(condition, WaitCondition::TextGone(_));
        let deadline = Instant::now() + timeout;
        loop {
            match self.evaluate(&probe).await {
                Ok(value) if value.as_bool().unwrap_or(false) == want => return Ok(()),
                Ok(_) => {}
                // The page may be mid-navigation; keep polling until the deadline.
                Err(BrowserError::Js(_)) | Err(BrowserError::Cdp { .. }) => {}
                Err(other) => return Err(other),
            }
            if Instant::now() >= deadline {
                return Err(BrowserError::Timeout(format!("wait_for {condition:?}")));
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
}

fn push_console(buffer: &mut VecDeque<ConsoleMessage>, message: ConsoleMessage) {
    if buffer.len() >= CONSOLE_CAP {
        buffer.pop_front();
    }
    buffer.push_back(message);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialog_policy_decisions() {
        assert!(DialogPolicy::Auto.should_accept("alert"));
        assert!(DialogPolicy::Auto.should_accept("beforeunload"));
        assert!(!DialogPolicy::Auto.should_accept("confirm"));
        assert!(DialogPolicy::AcceptAll.should_accept("confirm"));
        assert!(!DialogPolicy::DismissAll.should_accept("alert"));
    }

    #[test]
    fn console_rank_orders_levels() {
        assert!(ConsoleMessage::rank("error") > ConsoleMessage::rank("warning"));
        assert!(ConsoleMessage::rank("warning") > ConsoleMessage::rank("log"));
        assert!(ConsoleMessage::rank("log") > ConsoleMessage::rank("debug"));
    }

    #[test]
    fn exception_details_become_js_errors() {
        let response = json!({"exceptionDetails": {"text": "Uncaught", "exception": {"description": "ReferenceError: x is not defined\n    at <anonymous>:1:1"}}});
        match check_exception(&response) {
            Err(BrowserError::Js(m)) => assert!(m.starts_with("ReferenceError")),
            other => panic!("{other:?}"),
        }
        assert!(check_exception(&json!({"result": {}})).is_ok());
    }

    #[test]
    fn remote_object_rendering() {
        assert_eq!(
            remote_object_text(&json!({"type":"string","value":"hi"})),
            "hi"
        );
        assert_eq!(remote_object_text(&json!({"type":"number","value":3})), "3");
        assert_eq!(
            remote_object_text(&json!({"type":"object","description":"Array(2)"})),
            "Array(2)"
        );
    }
}
