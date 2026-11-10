//! `Browser`: connection, tab registry, event supervisor, network and downloads.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::cdp::{CdpClient, CdpEvent};
use crate::error::{BrowserError, Result};
use crate::launch::{launch_process, resolve_ws_url, LaunchOptions, LaunchedProcess};
use crate::network::{
    build_replay_spec, header, CapturedRequest, NetworkFilter, NetworkStore, RequestSpec,
    DEFAULT_CAPACITY,
};
use crate::tab::{DialogPolicy, NavigateOptions, Tab, TabInfo};

/// What the browser does with page-triggered downloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadBehavior {
    Deny,
    /// Save under the suggested file name.
    Allow,
    /// Save under the download GUID (collision-free).
    AllowAndName,
}

impl DownloadBehavior {
    fn as_str(self) -> &'static str {
        match self {
            Self::Deny => "deny",
            Self::Allow => "allow",
            Self::AllowAndName => "allowAndName",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadState {
    InProgress,
    Completed,
    Canceled,
}

/// Download lifecycle reported by `Browser.downloadWillBegin`/`downloadProgress`.
#[derive(Debug, Clone, PartialEq)]
pub enum DownloadEvent {
    Started {
        guid: String,
        url: String,
        suggested_filename: String,
        frame_id: Option<String>,
    },
    Progress {
        guid: String,
        total_bytes: f64,
        received_bytes: f64,
        state: DownloadState,
    },
}

#[derive(Default)]
struct TabRegistry {
    tabs: HashMap<String, Tab>,
    order: Vec<String>,
    active: Option<String>,
}

struct Shared {
    client: CdpClient,
    registry: Mutex<TabRegistry>,
    /// CDP session id (page or child) to owning tab id.
    sessions: Mutex<HashMap<String, String>>,
    attach_lock: tokio::sync::Mutex<()>,
    network: NetworkStore,
    downloads: broadcast::Sender<DownloadEvent>,
    dialog_policy: Arc<Mutex<DialogPolicy>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn attachable(info: &Value) -> bool {
    info["type"].as_str() == Some("page")
        && info["url"]
            .as_str()
            .is_some_and(|u| crate::safety::navigation_url(u).is_ok())
}

impl Shared {
    fn tab(&self, id: &str) -> Option<Tab> {
        lock(&self.registry).tabs.get(id).cloned()
    }

    fn tab_for_session(&self, session: &str) -> Option<Tab> {
        let id = lock(&self.sessions).get(session).cloned()?;
        self.tab(&id)
    }

    fn remove_tab(&self, id: &str) {
        let mut reg = lock(&self.registry);
        reg.tabs.remove(id);
        reg.order.retain(|t| t != id);
        if reg.active.as_deref() == Some(id) {
            reg.active = reg.order.last().cloned();
        }
        drop(reg);
        lock(&self.sessions).retain(|_, tab| tab != id);
    }

    async fn attach(self: &Arc<Self>, target_id: &str) -> Result<Tab> {
        let _guard = self.attach_lock.lock().await;
        if let Some(tab) = self.tab(target_id) {
            return Ok(tab);
        }
        let attached = self
            .client
            .send(
                "Target.attachToTarget",
                json!({"targetId": target_id, "flatten": true}),
                None,
            )
            .await?;
        let session = attached["sessionId"]
            .as_str()
            .ok_or_else(|| BrowserError::Invalid("attachToTarget returned no sessionId".into()))?
            .to_string();
        let info = self
            .client
            .send("Target.getTargetInfo", json!({"targetId": target_id}), None)
            .await
            .map(|v| v["targetInfo"].clone())
            .unwrap_or(Value::Null);
        let tab = Tab::new(
            self.client.clone(),
            target_id.to_string(),
            session.clone(),
            self.dialog_policy.clone(),
            info["url"].as_str().unwrap_or("").to_string(),
            info["title"].as_str().unwrap_or("").to_string(),
        );
        lock(&self.sessions).insert(session, target_id.to_string());
        {
            let mut reg = lock(&self.registry);
            reg.tabs.insert(target_id.to_string(), tab.clone());
            reg.order.push(target_id.to_string());
            if reg.active.is_none() {
                reg.active = Some(target_id.to_string());
            }
        }
        let setup = async {
            tab.send("Page.enable", json!({})).await?;
            tab.send("Runtime.enable", json!({})).await?;
            tab.send(
                "Network.enable",
                json!({"maxTotalBufferSize": 100_000_000, "maxResourceBufferSize": 50_000_000}),
            )
            .await?;
            let _ = tab.send("Log.enable", json!({})).await;
            let _ = tab
                .send(
                    "Target.setAutoAttach",
                    json!({"autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true}),
                )
                .await;
            Ok::<_, BrowserError>(())
        };
        if let Err(error) = setup.await {
            self.remove_tab(target_id);
            return Err(error);
        }
        Ok(tab)
    }

    fn on_event(self: &Arc<Self>, event: CdpEvent) {
        match event.method.as_str() {
            "Target.targetCreated" => {
                let info = &event.params["targetInfo"];
                if attachable(info) {
                    if let Some(id) = info["targetId"].as_str().map(str::to_string) {
                        let opener = info["openerId"].as_str().map(str::to_string);
                        let shared = self.clone();
                        tokio::spawn(async move {
                            if shared.attach(&id).await.is_ok() {
                                let mut reg = lock(&shared.registry);
                                if opener.is_some() && opener == reg.active {
                                    reg.active = Some(id);
                                }
                            }
                        });
                    }
                }
            }
            "Target.targetDestroyed" => {
                if let Some(id) = event.params["targetId"].as_str() {
                    self.remove_tab(id);
                }
            }
            "Target.targetInfoChanged" => {
                let info = &event.params["targetInfo"];
                if let Some(tab) = info["targetId"].as_str().and_then(|id| self.tab(id)) {
                    tab.set_info(info["url"].as_str(), info["title"].as_str());
                }
            }
            "Target.attachedToTarget" => {
                // Child sessions (cross-origin iframes) of a page we already track.
                let Some(parent) = event.session_id.as_deref() else {
                    return;
                };
                let info = &event.params["targetInfo"];
                let (Some(session), Some(kind)) =
                    (event.params["sessionId"].as_str(), info["type"].as_str())
                else {
                    return;
                };
                let Some(tab) = self.tab_for_session(parent) else {
                    return;
                };
                lock(&self.sessions).insert(session.to_string(), tab.id().to_string());
                if kind == "iframe" {
                    let client = self.client.clone();
                    let session = session.to_string();
                    tokio::spawn(async move {
                        let _ = client
                            .send("Network.enable", json!({}), Some(&session))
                            .await;
                        let _ = client
                            .send(
                                "Target.setAutoAttach",
                                json!({"autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true}),
                                Some(&session),
                            )
                            .await;
                        let _ = client
                            .send("Runtime.runIfWaitingForDebugger", json!({}), Some(&session))
                            .await;
                    });
                }
            }
            "Target.detachedFromTarget" => {
                if let Some(session) = event.params["sessionId"].as_str() {
                    lock(&self.sessions).remove(session);
                }
            }
            "Browser.downloadWillBegin" => {
                let p = &event.params;
                let _ = self.downloads.send(DownloadEvent::Started {
                    guid: p["guid"].as_str().unwrap_or("").to_string(),
                    url: p["url"].as_str().unwrap_or("").to_string(),
                    suggested_filename: p["suggestedFilename"].as_str().unwrap_or("").to_string(),
                    frame_id: p["frameId"].as_str().map(str::to_string),
                });
            }
            "Browser.downloadProgress" => {
                let p = &event.params;
                let state = match p["state"].as_str() {
                    Some("completed") => DownloadState::Completed,
                    Some("canceled") => DownloadState::Canceled,
                    _ => DownloadState::InProgress,
                };
                let _ = self.downloads.send(DownloadEvent::Progress {
                    guid: p["guid"].as_str().unwrap_or("").to_string(),
                    total_bytes: p["totalBytes"].as_f64().unwrap_or(0.0),
                    received_bytes: p["receivedBytes"].as_f64().unwrap_or(0.0),
                    state,
                });
            }
            _ => {
                let Some(session) = event.session_id.as_deref() else {
                    return;
                };
                let Some(tab) = self.tab_for_session(session) else {
                    return;
                };
                if event.method.starts_with("Network.") {
                    self.network.handle_event(&event, Some(tab.id()));
                }
                tab.handle_event(&event);
            }
        }
    }
}

/// A connected Chromium instance: tabs, network capture and downloads.
pub struct Browser {
    shared: Arc<Shared>,
    process: Mutex<Option<LaunchedProcess>>,
    supervisor: JoinHandle<()>,
}

impl Drop for Browser {
    fn drop(&mut self) {
        self.supervisor.abort();
        self.shared.client.close();
        // The launched child (if any) is killed by `kill_on_drop`.
    }
}

impl Browser {
    /// Starts a managed browser with a dedicated profile and connects to it.
    pub async fn launch(options: &LaunchOptions) -> Result<Browser> {
        let process = launch_process(options).await?;
        let client = CdpClient::connect(&process.ws_url).await?;
        Self::from_client(client, Some(process)).await
    }

    /// Attaches to an already-running browser (`ws://…`, `http://127.0.0.1:9222`, or a port).
    pub async fn connect(endpoint: &str) -> Result<Browser> {
        let ws = resolve_ws_url(endpoint).await?;
        let client = CdpClient::connect(&ws).await?;
        Self::from_client(client, None).await
    }

    async fn from_client(client: CdpClient, process: Option<LaunchedProcess>) -> Result<Browser> {
        let (downloads, _) = broadcast::channel(256);
        let shared = Arc::new(Shared {
            client: client.clone(),
            registry: Mutex::new(TabRegistry::default()),
            sessions: Mutex::new(HashMap::new()),
            attach_lock: tokio::sync::Mutex::new(()),
            network: NetworkStore::new(DEFAULT_CAPACITY),
            downloads,
            dialog_policy: Arc::new(Mutex::new(DialogPolicy::default())),
        });
        let mut rx = client.subscribe();
        let loop_shared = shared.clone();
        let supervisor = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => loop_shared.on_event(event),
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        let browser = Browser {
            shared: shared.clone(),
            process: Mutex::new(process),
            supervisor,
        };
        client
            .send("Target.setDiscoverTargets", json!({"discover": true}), None)
            .await?;
        let targets = client.send("Target.getTargets", json!({}), None).await?;
        for info in targets["targetInfos"].as_array().into_iter().flatten() {
            if attachable(info) {
                if let Some(id) = info["targetId"].as_str() {
                    shared.attach(id).await?;
                }
            }
        }
        Ok(browser)
    }

    pub fn client(&self) -> &CdpClient {
        &self.shared.client
    }

    pub fn is_closed(&self) -> bool {
        self.shared.client.is_closed()
    }

    /// Resolves when the connection (browser) goes away.
    pub async fn closed(&self) {
        self.shared.client.closed().await;
    }

    /// Executable of the browser we launched, if any.
    pub fn executable(&self) -> Option<PathBuf> {
        lock(&self.process).as_ref().map(|p| p.executable.clone())
    }

    /// Asks the browser to quit and reaps the child we launched.
    pub async fn close(&self) {
        let _ = self
            .shared
            .client
            .send_with_timeout(
                "Browser.close",
                json!({}),
                None,
                std::time::Duration::from_secs(3),
            )
            .await;
        self.shared.client.close();
        let child = lock(&self.process).take();
        if let Some(mut process) = child {
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(3), process.child.wait()).await;
            let _ = process.child.start_kill();
        }
    }

    pub fn set_dialog_policy(&self, policy: DialogPolicy) {
        *lock(&self.shared.dialog_policy) = policy;
    }

    // ------------------------------------------------------------------ tabs

    pub fn tabs(&self) -> Vec<TabInfo> {
        let reg = lock(&self.shared.registry);
        reg.order
            .iter()
            .filter_map(|id| reg.tabs.get(id))
            .map(Tab::info)
            .collect()
    }

    pub fn active_tab_id(&self) -> Option<String> {
        lock(&self.shared.registry).active.clone()
    }

    pub fn tab(&self, id: &str) -> Option<Tab> {
        self.shared.tab(id)
    }

    /// Finds a tab by full id, unique id prefix (>= 4 chars) or 1-based index.
    pub fn find_tab(&self, spec: &str) -> Result<Tab> {
        let reg = lock(&self.shared.registry);
        let spec = spec.trim();
        if let Some(tab) = reg.tabs.get(spec) {
            return Ok(tab.clone());
        }
        if let Ok(index) = spec.parse::<usize>() {
            if let Some(tab) = index
                .checked_sub(1)
                .and_then(|i| reg.order.get(i))
                .and_then(|id| reg.tabs.get(id))
            {
                return Ok(tab.clone());
            }
        }
        if spec.len() >= 4 {
            let matches: Vec<&Tab> = reg
                .order
                .iter()
                .filter(|id| id.to_lowercase().starts_with(&spec.to_lowercase()))
                .filter_map(|id| reg.tabs.get(id))
                .collect();
            if matches.len() == 1 {
                return Ok(matches[0].clone());
            }
        }
        Err(BrowserError::NotFound(format!(
            "no tab `{spec}`; use browser_tabs to list tab ids"
        )))
    }

    /// The active tab; opens a blank one if the browser has none.
    pub async fn active_tab(&self) -> Result<Tab> {
        let existing = {
            let reg = lock(&self.shared.registry);
            reg.active
                .as_ref()
                .or(reg.order.last())
                .and_then(|id| reg.tabs.get(id))
                .cloned()
        };
        match existing {
            Some(tab) => Ok(tab),
            None => self.new_tab(None).await,
        }
    }

    /// Opens a tab (optionally navigating) and makes it active.
    pub async fn new_tab(&self, url: Option<&str>) -> Result<Tab> {
        if let Some(url) = url {
            crate::safety::navigation_url(url)?;
        }
        let created = self
            .shared
            .client
            .send("Target.createTarget", json!({"url": "about:blank"}), None)
            .await?;
        let id = created["targetId"]
            .as_str()
            .ok_or_else(|| BrowserError::Invalid("createTarget returned no targetId".into()))?
            .to_string();
        let tab = self.shared.attach(&id).await?;
        lock(&self.shared.registry).active = Some(id);
        if let Some(url) = url.filter(|u| *u != "about:blank") {
            tab.navigate(url, &NavigateOptions::default()).await?;
        }
        Ok(tab)
    }

    pub async fn select_tab(&self, id: &str) -> Result<Tab> {
        let tab = self.find_tab(id)?;
        self.shared
            .client
            .send("Target.activateTarget", json!({"targetId": tab.id()}), None)
            .await?;
        lock(&self.shared.registry).active = Some(tab.id().to_string());
        Ok(tab)
    }

    pub async fn close_tab(&self, id: &str) -> Result<()> {
        let tab = self.find_tab(id)?;
        self.shared
            .client
            .send("Target.closeTarget", json!({"targetId": tab.id()}), None)
            .await?;
        self.shared.remove_tab(tab.id());
        Ok(())
    }

    // --------------------------------------------------------------- network

    pub fn captured_requests(&self, filter: &NetworkFilter) -> Vec<CapturedRequest> {
        self.shared.network.list(filter)
    }

    pub fn captured_request(&self, request_id: &str) -> Option<CapturedRequest> {
        self.shared.network.get(request_id)
    }

    pub fn clear_captured(&self) {
        self.shared.network.clear();
    }

    /// New captured requests (published when response headers arrive).
    pub fn subscribe_requests(&self) -> broadcast::Receiver<CapturedRequest> {
        self.shared.network.subscribe()
    }

    fn session_for_request(&self, request_id: &str) -> Result<String> {
        if let Some(session) = self.shared.network.session_of(request_id) {
            return Ok(session);
        }
        let reg = lock(&self.shared.registry);
        reg.active
            .as_ref()
            .and_then(|id| reg.tabs.get(id))
            .map(|t| t.session_id().to_string())
            .ok_or_else(|| BrowserError::NotFound("no tab available".into()))
    }

    /// Everything the downloader needs to re-fetch a captured request with the
    /// same auth context. Cookies come from the request headers, falling back
    /// to `Network.getCookies` for the URL.
    pub async fn replay_spec(&self, request_id: &str) -> Result<RequestSpec> {
        let request =
            self.shared.network.get(request_id).ok_or_else(|| {
                BrowserError::NotFound(format!("no captured request `{request_id}`"))
            })?;
        let mut api_cookies = None;
        if header(&request.request_headers, "cookie").is_none_or(|c| c.trim().is_empty()) {
            let session = self.session_for_request(request_id)?;
            if let Ok(response) = self
                .shared
                .client
                .send(
                    "Network.getCookies",
                    json!({"urls": [request.url]}),
                    Some(&session),
                )
                .await
            {
                let pairs: Vec<(String, String)> = response["cookies"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|c| {
                        Some((
                            c["name"].as_str()?.to_string(),
                            c["value"].as_str()?.to_string(),
                        ))
                    })
                    .collect();
                api_cookies = Some(pairs);
            }
        }
        Ok(build_replay_spec(&request, api_cookies.as_deref()))
    }

    /// Body of a captured response (only available while the browser still holds it).
    pub async fn response_body(&self, request_id: &str) -> Result<Vec<u8>> {
        let session = self.session_for_request(request_id)?;
        let response = self
            .shared
            .client
            .send(
                "Network.getResponseBody",
                json!({"requestId": request_id}),
                Some(&session),
            )
            .await?;
        let body = response["body"].as_str().unwrap_or("");
        if response["base64Encoded"].as_bool().unwrap_or(false) {
            STANDARD
                .decode(body)
                .map_err(|e| BrowserError::Invalid(format!("bad response body encoding: {e}")))
        } else {
            Ok(body.as_bytes().to_vec())
        }
    }

    // ------------------------------------------------------------- downloads

    /// Sets how page-triggered downloads are handled and turns on download events.
    pub async fn set_download_behavior(
        &self,
        behavior: DownloadBehavior,
        dir: &Path,
    ) -> Result<()> {
        self.shared
            .client
            .send(
                "Browser.setDownloadBehavior",
                json!({
                    "behavior": behavior.as_str(),
                    "downloadPath": dir.to_string_lossy(),
                    "eventsEnabled": true,
                }),
                None,
            )
            .await
            .map(|_| ())
    }

    pub fn subscribe_downloads(&self) -> broadcast::Receiver<DownloadEvent> {
        self.shared.downloads.subscribe()
    }
}
