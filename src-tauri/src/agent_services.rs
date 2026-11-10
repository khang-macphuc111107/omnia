//! Session-scoped, app-owned automation. Registration is inert; only harness
//! dispatch (after policy/approval) can launch Chromium or start a download.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use dashmap::DashMap;
use omnia_browser::network::{CapturedRequest, NetworkFilter};
use omnia_browser::tab::TabInfo;
use omnia_browser::{browser_tools, BrowserConfig, BrowserHandle};
use omnia_computer::{Computer, ComputerConfig};
use omnia_download::engine::{
    DownloadEngine, EngineConfig, JobKind, JobSnapshot, JobSpec, JobStatus,
};
use omnia_download::request::RequestSpec;
use omnia_harness::{
    EffectClass, HarnessError, HarnessResult, Tool, ToolContext, ToolOutput, ToolRegistry, ToolSpec,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::browser_profile::{validate_ffmpeg_path, ProfileCoordinator, ProfileMode};
use crate::error::{NativeError, NativeResult};
use crate::harness_bridge::{AgentSessionRef, HarnessHub};

pub type ServiceGuard = Arc<dyn Fn() -> NativeResult<()> + Send + Sync>;

pub struct AgentServices {
    root: PathBuf,
    profiles: Arc<ProfileCoordinator>,
    sessions: DashMap<String, Arc<SessionServices>>,
}
struct ComputerGrant {
    computer: Computer,
    capture: bool,
    control: bool,
}
/// What the resolver decided for this session's browser launches.
#[derive(Default)]
struct SessionProfile {
    mode: Mutex<Option<ProfileMode>>,
    /// Every disposable profile dir this session launched with; deleted on retire.
    disposable: Mutex<Vec<PathBuf>>,
}
pub struct SessionServices {
    id: String,
    profiles: Arc<ProfileCoordinator>,
    profile: Arc<SessionProfile>,
    browser: BrowserHandle,
    downloads: DownloadEngine,
    /// Serialized RequestSpec intentionally loses secrets and signed queries.
    /// Never resume a restored job with that degraded authority.
    restored: HashSet<String>,
    destination: PathBuf,
    /// `browser_record` output (steps.json, replay.spec.ts, recording.gif per recording).
    recordings: PathBuf,
    computer: Mutex<Option<ComputerGrant>>,
    closed: std::sync::atomic::AtomicBool,
}
fn service_error(error: impl std::fmt::Display) -> NativeError {
    NativeError::new("agent_service_failed", error.to_string())
}
impl AgentServices {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.join("agent-services"),
            profiles: Arc::new(ProfileCoordinator::new(root)),
            sessions: DashMap::new(),
        }
    }
    /// Push the effective ffmpeg location (settings, `~/.omnia/bin`, PATH) into every engine.
    fn refresh_ffmpeg(&self) {
        let path = self.profiles.resolve_ffmpeg();
        for services in self.sessions.iter() {
            services.downloads.set_ffmpeg_path(path.clone());
        }
    }
    pub fn session(&self, id: &str) -> NativeResult<Arc<SessionServices>> {
        use dashmap::mapref::entry::Entry;
        match self.sessions.entry(id.to_owned()) {
            Entry::Occupied(entry) => Ok(entry.get().clone()),
            Entry::Vacant(entry) => {
                // Database IDs, not renderer paths, determine all service storage.
                let dir = self
                    .root
                    .join(format!("{:x}", Sha256::digest(id.as_bytes())));
                let destination = dir.join("downloads");
                std::fs::create_dir_all(&destination).map_err(service_error)?;
                let recordings = dir.join("recordings");
                let downloads = DownloadEngine::new(EngineConfig::new(dir.join("jobs.json")))
                    .map_err(service_error)?;
                downloads.set_ffmpeg_path(self.profiles.resolve_ffmpeg());
                let restored = downloads.list().into_iter().map(|j| j.id).collect();
                // The profile is chosen at launch: one Omnia-owned persistent
                // profile (sign-ins kept) or a disposable one. Never a personal
                // browser profile, endpoint, extension set or signed-in account.
                let profile = Arc::new(SessionProfile::default());
                let disposable_root = dir.join("profiles");
                let mut config = BrowserConfig::new(disposable_root.join("unlaunched"));
                config.launch.headless = false;
                config.recordings_dir = Some(recordings.clone());
                let resolver: omnia_browser::tools::LaunchResolver = {
                    let (profiles, profile, root, session) = (
                        self.profiles.clone(),
                        profile.clone(),
                        disposable_root,
                        id.to_owned(),
                    );
                    let base = config.launch.clone();
                    Arc::new(move |handle: &BrowserHandle| {
                        let (dir, mode) = profiles.resolve(&session, handle, &root);
                        *profile.mode.lock().unwrap_or_else(|e| e.into_inner()) = Some(mode);
                        if mode != ProfileMode::Persistent {
                            profile
                                .disposable
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .push(dir.clone());
                        }
                        let mut launch = base.clone();
                        launch.profile_dir = dir;
                        launch
                    })
                };
                let browser = BrowserHandle::with_resolver(config, resolver);
                let services = Arc::new(SessionServices {
                    id: id.to_owned(),
                    profiles: self.profiles.clone(),
                    profile,
                    browser,
                    downloads,
                    restored,
                    destination,
                    recordings,
                    computer: Mutex::new(None),
                    closed: std::sync::atomic::AtomicBool::new(false),
                });
                entry.insert(services.clone());
                Ok(services)
            }
        }
    }
    pub fn retire(&self, id: &str) {
        if let Some((_, services)) = self.sessions.remove(id) {
            services
                .closed
                .store(true, std::sync::atomic::Ordering::SeqCst);
            services.stop_computer();
            for job in services.downloads.list() {
                let _ = services.downloads.pause(&job.id);
            }
            tauri::async_runtime::spawn(async move {
                services.browser.close().await;
                // The persistent profile is never deleted here; only give back its lease.
                services.profiles.release(&services.id);
                let dirs = std::mem::take(
                    &mut *services
                        .profile
                        .disposable
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()),
                );
                for dir in dirs {
                    let _ = std::fs::remove_dir_all(dir);
                }
            });
        }
    }
    pub fn stop_session_computer(&self, id: &str) {
        if let Some(services) = self.sessions.get(id) {
            services.stop_computer();
        }
    }
    pub fn emergency_stop(&self) {
        for services in self.sessions.iter() {
            services.stop_computer();
        }
    }
}
impl SessionServices {
    fn check_open(&self) -> NativeResult<()> {
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(NativeError::new(
                "agent_service_closed",
                "Session services have been closed",
            ));
        }
        Ok(())
    }
    fn stop_computer(&self) {
        if let Some(grant) = self
            .computer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            grant.computer.kill_switch().trigger();
        }
    }
    fn public_job(&self, mut job: JobSnapshot) -> Value {
        // reqwest failures may embed signed URLs; never expose raw errors.
        if job.error.is_some() {
            job.error = Some("Download failed; inspect errorCode. Reauthenticate in the dedicated browser if needed.".into());
        }
        let reauthorization_required = self.restored.contains(&job.id);
        let (mux_skipped, mux_hint) = match &job.mux {
            Some(omnia_download::mux::MuxOutcome::MuxSkipped { reason }) => (
                true,
                Some(format!("Tracks were kept as separate files. {reason}. Install ffmpeg or set its path in Session services to merge them.")),
            ),
            _ => (false, None),
        };
        json!({"job":job, "reauthorizationRequired":reauthorization_required, "muxSkipped":mux_skipped, "muxHint":mux_hint})
    }
    fn profile_mode(&self) -> ProfileMode {
        if self.browser.is_live() {
            if let Some(mode) = *self.profile.mode.lock().unwrap_or_else(|e| e.into_inner()) {
                return mode;
            }
        }
        self.profiles.preview(&self.id)
    }
    fn status(&self) -> Value {
        let computer = self.computer.lock().unwrap_or_else(|e| e.into_inner());
        let settings = self.profiles.settings();
        let ffmpeg = self.profiles.resolve_ffmpeg();
        json!({
            "browser": {
                "available": omnia_browser::launch::find_browser().is_some(),
                "launchPolicy": if settings.keep_sign_ins { "lazy_dedicated_persistent_profile" } else { "lazy_dedicated_disposable_profile" },
                "personalBrowser": false,
                "keepSignIns": settings.keep_sign_ins,
                "profileMode": self.profile_mode(),
                "running": self.browser.is_live(),
            },
            "ffmpeg": {"available": ffmpeg.is_some(), "path": ffmpeg, "configuredPath": settings.ffmpeg_path},
            "downloads": {"available":true, "unavailableReason":Value::Null, "destination":self.destination, "jobs":self.downloads.list().into_iter().map(|j| self.public_job(j)).collect::<Vec<_>>(), "restoredJobsRequireReauthorization":true},
            "computer": {"available":cfg!(windows), "capture":computer.as_ref().is_some_and(|g| g.capture), "control":computer.as_ref().is_some_and(|g| g.control), "defaultDisabled":true}
        })
    }
}

/// All wrapped calls recheck current session existence and workspace trust at
/// the actual tool boundary, including child-agent dispatch.
struct GuardedTool {
    tool: Arc<dyn Tool>,
    guard: ServiceGuard,
    services: Arc<SessionServices>,
}
#[async_trait]
impl Tool for GuardedTool {
    fn spec(&self) -> ToolSpec {
        self.tool.spec()
    }
    fn effect(&self) -> EffectClass {
        self.tool.effect()
    }
    fn describe(&self, input: &Value) -> String {
        self.tool.describe(input)
    }
    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        if ctx.cancel.is_cancelled() {
            return Err(HarnessError::Cancelled);
        }
        if let Err(error) = (self.guard)().and_then(|_| self.services.check_open()) {
            return Ok(ToolOutput::error(error.to_string()));
        }
        if self.tool.spec().name.starts_with("browser_") {
            // Page-triggered downloads must not bypass the host-owned download
            // manager or its separately authorized start tool.
            let setup = async {
                let browser = self
                    .services
                    .browser
                    .browser()
                    .await
                    .map_err(|_| "Dedicated browser unavailable")?;
                browser
                    .set_download_behavior(
                        omnia_browser::DownloadBehavior::Deny,
                        &self.services.destination,
                    )
                    .await
                    .map_err(|_| "Could not enforce browser download policy")
            };
            let result = tokio::select! {
                biased;
                _ = ctx.cancel.cancelled() => return Err(HarnessError::Cancelled),
                result = setup => result,
            };
            if let Err(message) = result {
                return Ok(ToolOutput::error(message));
            }
            if let Err(error) = (self.guard)().and_then(|_| self.services.check_open()) {
                return Ok(ToolOutput::error(error.to_string()));
            }
        }
        self.tool.call(ctx, input).await
    }
}

pub fn register(registry: &mut ToolRegistry, services: Arc<SessionServices>, guard: ServiceGuard) {
    let mut tools = browser_tools(services.browser.clone());
    tools.push(Arc::new(DownloadTool(services.clone())));
    // Keep schemas stable, but resolve the *current* explicit grant at call
    // time. Revocation never leaves a previously registered live handle.
    for tool in omnia_computer::computer_tools(ComputerConfig::default()) {
        tools.push(Arc::new(ComputerTool {
            spec: tool.spec(),
            effect: tool.effect(),
            services: services.clone(),
        }));
    }
    for tool in tools {
        registry.register(Arc::new(GuardedTool {
            tool,
            guard: guard.clone(),
            services: services.clone(),
        }));
    }
}
struct ComputerTool {
    spec: ToolSpec,
    effect: EffectClass,
    services: Arc<SessionServices>,
}
#[async_trait]
impl Tool for ComputerTool {
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }
    fn effect(&self) -> EffectClass {
        // Capturing the user's desktop is not a workspace read.
        EffectClass::ComputerControl
    }
    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        let computer = {
            let slot = self
                .services
                .computer
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let Some(grant) = slot.as_ref() else {
                return Ok(ToolOutput::error("Computer use is disabled. The user must explicitly grant capture/control in Omnia."));
            };
            if !grant.capture || (self.effect == EffectClass::ComputerControl && !grant.control) {
                return Ok(ToolOutput::error(
                    "This computer operation has no explicit capture/control permission.",
                ));
            }
            grant.computer.clone()
        };
        let Some(tool) = omnia_computer::tools::computer_tools_for(computer.clone())
            .into_iter()
            .find(|t| t.spec().name == self.spec.name)
        else {
            return Ok(ToolOutput::error("Computer tool unavailable"));
        };
        let kill = computer.kill_switch().token();
        tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => { computer.kill_switch().trigger(); Err(HarnessError::Cancelled) },
            _ = kill.cancelled() => Ok(ToolOutput::error("Emergency stop engaged; already dispatched OS actions may have completed.")),
            result = tool.call(ctx, input) => result,
        }
    }
}

struct DownloadTool(Arc<SessionServices>);
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DownloadInput {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    captured_request_id: Option<String>,
    #[serde(default)]
    kind: Option<JobKind>,
    #[serde(default)]
    file_name: Option<String>,
}
#[async_trait]
impl Tool for DownloadTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec { name:"download_start".into(), description:"Start a public HTTP(S), HLS or DASH download (separate tracks are merged with ffmpeg stream copy when available) into this session's app-owned downloads folder. Use capturedRequestId to replay a request from the dedicated browser without exposing its credentials. Restored jobs cannot resume until reauthorized; start a fresh approved download from a new capture.".into(), input_schema:json!({"type":"object", "properties":{"url":{"type":"string"},"capturedRequestId":{"type":"string"},"fileName":{"type":"string"},"kind":{"type":"object","description":"JobKind: {\"type\":\"http\"}, {\"type\":\"hls\",\"quality\":{\"type\":\"best\"}} or {\"type\":\"dash\",\"quality\":{\"type\":\"best\"}}. Quality is {\"type\":\"best\"}, {\"type\":\"worst\"}, {\"type\":\"maxHeight\",\"value\":720} or {\"type\":\"bandwidth\",\"value\":2000000}; a bare string such as \"best\" is also accepted.","properties":{"type":{"type":"string","enum":["http","hls","dash"]},"quality":{"description":"Stream quality; object form {type,value?} or a bare string like \"best\"."}}}},"additionalProperties":false}) }
    }
    fn effect(&self) -> EffectClass {
        EffectClass::Network
    }
    fn describe(&self, _: &Value) -> String {
        "Download requested resource to the session-owned downloads folder".into()
    }
    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        let run = async {
            let mut input = input;
            normalize_download_kind(&mut input);
            let input: DownloadInput = serde_json::from_value(input).map_err(|e| {
                if e.to_string().contains("quality") || e.to_string().contains("kind") {
                    "Invalid download input: kind must look like {\"type\":\"hls\",\"quality\":{\"type\":\"best\"}}".to_owned()
                } else {
                    "Invalid download input".to_owned()
                }
            })?;
            start_download(&self.0, input, false, || ctx.cancel.is_cancelled()).await
        };
        Ok(match run.await {
            Ok(value) => ToolOutput::text(value.to_string()),
            Err(message) => ToolOutput::error(message),
        })
    }
}

/// Lenient input: `kind.quality` may be a bare string ("best") instead of the persisted
/// adjacently-tagged form (`{"type":"best"}`). Only the tool input is rewritten.
fn normalize_download_kind(input: &mut Value) {
    let Some(quality) = input.get_mut("kind").and_then(|k| k.get_mut("quality")) else {
        return;
    };
    if let Value::String(name) = quality {
        let name = name.trim().to_owned();
        let tag = match name.to_ascii_lowercase().as_str() {
            "best" => "best",
            "worst" => "worst",
            "maxheight" | "max_height" | "max-height" => "maxHeight",
            "bandwidth" => "bandwidth",
            _ => return,
        };
        *quality = json!({"type": tag});
    }
}

enum Source {
    Url(String),
    Captured(String),
}
/// Exactly one of url / capturedRequestId.
fn resolve_source(url: Option<String>, captured: Option<String>) -> Result<Source, String> {
    match (url, captured) {
        (Some(url), None) if !url.trim().is_empty() => Ok(Source::Url(url)),
        (None, Some(id)) if !id.trim().is_empty() => Ok(Source::Captured(id)),
        _ => Err("Supply exactly one of url or capturedRequestId".into()),
    }
}
/// Heuristic DRM/license-exchange hint for a captured request. The download
/// engine additionally refuses DRM manifests when it parses them; this only
/// lets the UI avoid offering obviously protected resources.
fn drm_hint(request: &CapturedRequest) -> bool {
    let url = request.url.to_ascii_lowercase();
    let mime = request
        .mime_type
        .clone()
        .unwrap_or_default()
        .to_ascii_lowercase();
    ["widevine", "playready", "fairplay", "drm", ".ism/manifest"]
        .iter()
        .any(|needle| url.contains(needle))
        || mime.contains("ms-sstr")
        || mime.contains("vnd.ms-playready")
}
fn infer_kind(url: &str, mime: Option<&str>) -> JobKind {
    let path = url::Url::parse(url)
        .map(|u| u.path().to_ascii_lowercase())
        .unwrap_or_default();
    let mime = mime.unwrap_or_default().to_ascii_lowercase();
    if path.ends_with(".m3u8") || mime.contains("mpegurl") {
        JobKind::Hls {
            quality: Default::default(),
        }
    } else if path.ends_with(".mpd") || mime.contains("dash+xml") {
        JobKind::Dash {
            quality: Default::default(),
        }
    } else {
        JobKind::Http
    }
}
/// The single validated start path shared by the agent tool and the user command.
async fn start_download(
    services: &SessionServices,
    input: DownloadInput,
    infer: bool,
    cancelled: impl Fn() -> bool,
) -> Result<Value, String> {
    let mut captured_mime = None;
    let request = match resolve_source(input.url, input.captured_request_id)? {
        Source::Url(url) => RequestSpec::get(url),
        Source::Captured(id) => {
            let browser = services.browser.existing().await.ok_or_else(|| {
                "Captured request unavailable; capture it again in the dedicated browser".to_owned()
            })?;
            if let Some(capture) = browser.captured_request(&id) {
                if drm_hint(&capture) {
                    return Err("DRM-protected content cannot be downloaded".into());
                }
                captured_mime = capture.mime_type;
            }
            let spec = browser.replay_spec(&id).await.map_err(|_| {
                "Captured request unavailable; capture it again in the dedicated browser".to_owned()
            })?;
            if !spec.method.eq_ignore_ascii_case("GET") {
                return Err("Only captured GET requests are replayable".into());
            }
            let mut request = RequestSpec::get(spec.url);
            request.headers = spec.headers;
            request.cookies = spec.cookies;
            request.referer = spec.referer;
            request.user_agent = spec.user_agent;
            request
        }
    };
    url::Url::parse(&request.url).map_err(|_| "Invalid URL".to_owned())?;
    // Same destination policy the transport enforces, surfaced before a doomed job is queued.
    request.validate().map_err(|e| match e {
        omnia_download::DownloadError::InvalidRequest(message) => format!("blocked: {message}"),
        other => other.to_string(),
    })?;
    let kind = match input.kind {
        Some(kind) => kind,
        None if infer => infer_kind(&request.url, captured_mime.as_deref()),
        None => JobKind::Http,
    };
    if kind == JobKind::Blob {
        return Err("Blob downloads are not exposed by this host".into());
    }
    let mut spec = JobSpec::new(kind, request, &services.destination);
    spec.file_name = input.file_name;
    // Stream-copy ffmpeg merge (no shell, no re-encode). A missing ffmpeg keeps
    // the raw track files and reports muxSkipped on the job.
    spec.mux = matches!(spec.kind, JobKind::Hls { .. } | JobKind::Dash { .. });
    let spec_mux = spec.mux;
    let ffmpeg = services.profiles.resolve_ffmpeg();
    services.downloads.set_ffmpeg_path(ffmpeg.clone());
    if cancelled() {
        return Err("Download cancelled before creation".into());
    }
    services.check_open().map_err(|e| e.to_string())?;
    let id = services
        .downloads
        .add(spec)
        .map_err(|_| "Could not create download job".to_owned())?;
    Ok(
        json!({"jobId":id,"destination":services.destination,"mux":spec_mux,"ffmpegAvailable":ffmpeg.is_some()}),
    )
}

#[tauri::command]
pub fn agent_services_status(
    hub: State<'_, HarnessHub>,
    request: AgentSessionRef,
) -> NativeResult<Value> {
    hub.require_service_session(&request.session_id)?;
    Ok(hub.services.session(&request.session_id)?.status())
}
#[tauri::command]
pub fn agent_services_close(
    hub: State<'_, HarnessHub>,
    request: AgentSessionRef,
) -> NativeResult<()> {
    hub.require_service_session(&request.session_id)?;
    hub.services.retire(&request.session_id);
    Ok(())
}

fn browser_settings_json(host: &AgentServices) -> Value {
    let settings = host.profiles.settings();
    let ffmpeg = host.profiles.resolve_ffmpeg();
    json!({
        "keepSignIns": settings.keep_sign_ins,
        "profileInUse": host.profiles.in_use(),
        "ffmpeg": {"available": ffmpeg.is_some(), "path": ffmpeg, "configuredPath": settings.ffmpeg_path},
    })
}
/// User-level (not workspace) settings: readable without a session.
#[tauri::command]
pub fn agent_browser_settings_get(hub: State<'_, HarnessHub>) -> Value {
    browser_settings_json(&hub.services)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSettingsRequest {
    pub session_id: String,
    #[serde(default)]
    pub keep_sign_ins: Option<bool>,
    /// Absent: unchanged. Empty string: clear. Otherwise an absolute ffmpeg path.
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
}
#[tauri::command]
pub fn agent_browser_settings_set(
    hub: State<'_, HarnessHub>,
    request: BrowserSettingsRequest,
) -> NativeResult<Value> {
    hub.require_service_session(&request.session_id)?;
    set_browser_settings(
        &hub.services,
        request.keep_sign_ins,
        request.ffmpeg_path.as_deref(),
    )?;
    Ok(browser_settings_json(&hub.services))
}
fn set_browser_settings(
    host: &AgentServices,
    keep: Option<bool>,
    ffmpeg: Option<&str>,
) -> NativeResult<()> {
    let ffmpeg = ffmpeg.map(validate_ffmpeg_path).transpose()?;
    host.profiles.update(keep, ffmpeg)?;
    host.refresh_ffmpeg();
    Ok(())
}
/// Deleting saved sign-ins is user-initiated and needs no workspace trust; it
/// is refused while any session browser is using the profile.
#[tauri::command]
pub fn agent_browser_clear_data(hub: State<'_, HarnessHub>) -> NativeResult<Value> {
    hub.services.profiles.clear()?;
    Ok(browser_settings_json(&hub.services))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenForSigninRequest {
    pub session_id: String,
    #[serde(default)]
    pub url: Option<String>,
}
fn signin_url(raw: Option<String>) -> NativeResult<Option<String>> {
    let Some(raw) = raw.map(|u| u.trim().to_owned()).filter(|u| !u.is_empty()) else {
        return Ok(None);
    };
    let bad = || NativeError::invalid("url", "must be an http(s) URL without credentials");
    let parsed = url::Url::parse(&raw).map_err(|_| bad())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(bad());
    }
    Ok(Some(parsed.to_string()))
}
/// Launch this session's browser (headed) and open `url` so the user signs in
/// themselves. Credentials are never typed by Omnia.
#[tauri::command]
pub async fn agent_browser_open_for_signin(
    hub: State<'_, HarnessHub>,
    request: OpenForSigninRequest,
) -> NativeResult<Value> {
    hub.require_service_session(&request.session_id)?;
    let url = signin_url(request.url)?;
    let services = hub.services.session(&request.session_id)?;
    services.check_open()?;
    let failed = |_| {
        NativeError::new(
            "browser_launch_failed",
            "Could not open the dedicated browser",
        )
    };
    let browser = services.browser.browser().await.map_err(failed)?;
    browser
        .set_download_behavior(omnia_browser::DownloadBehavior::Deny, &services.destination)
        .await
        .map_err(|_| {
            NativeError::new(
                "browser_launch_failed",
                "Could not enforce browser download policy",
            )
        })?;
    if let Some(url) = url {
        browser.new_tab(Some(&url)).await.map_err(failed)?;
    }
    Ok(services.status())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerPermissionRequest {
    pub session_id: String,
    pub capture: bool,
    pub control: bool,
    /// Explicit desktop capture permission includes all visible desktop metadata.
    /// Control is further limited to these executable basenames.
    #[serde(default)]
    pub allowed_apps: Vec<String>,
}
#[tauri::command]
pub fn agent_computer_permission_set(
    hub: State<'_, HarnessHub>,
    request: ComputerPermissionRequest,
) -> NativeResult<Value> {
    hub.require_service_session(&request.session_id)?;
    if request.control && (!request.capture || request.allowed_apps.is_empty()) {
        return Err(NativeError::invalid(
            "control",
            "requires capture permission and a nonempty allowedApps list",
        ));
    }
    if request.allowed_apps.iter().any(|s| {
        s.trim().is_empty() || s.contains(['/', '\\', '*', '?']) || s.chars().any(char::is_control)
    }) {
        return Err(NativeError::invalid(
            "allowedApps",
            "must contain exact executable basenames, not paths or wildcards",
        ));
    }
    if (request.capture || request.control) && !cfg!(windows) {
        return Err(NativeError::new(
            "computer_unsupported",
            "Computer use is supported only on Windows",
        ));
    }
    let services = hub.services.session(&request.session_id)?;
    let mut slot = services.computer.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(old) = slot.take() {
        old.computer.kill_switch().trigger();
    }
    if request.capture {
        let mut config = ComputerConfig::default();
        config.policy.allowed_apps = Some(request.allowed_apps);
        // Capture-only still permits window metadata / monitor screenshots, as
        // explicitly disclosed above; actions require the separate control bit.
        *slot = Some(ComputerGrant {
            computer: Computer::new(config),
            capture: true,
            control: request.control,
        });
    }
    drop(slot);
    Ok(services.status())
}
/// Safety action intentionally needs no workspace trust or live agent session.
#[tauri::command]
pub fn agent_computer_emergency_stop(hub: State<'_, HarnessHub>) {
    hub.services.emergency_stop();
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadControlRequest {
    pub session_id: String,
    pub job_id: String,
    pub action: String,
}
#[tauri::command]
pub async fn agent_download_control(
    hub: State<'_, HarnessHub>,
    request: DownloadControlRequest,
) -> NativeResult<Value> {
    hub.require_service_session(&request.session_id)?;
    let services = hub.services.session(&request.session_id)?;
    let job = services
        .downloads
        .get(&request.job_id)
        .ok_or_else(|| NativeError::new("download_not_found", "No such job in this session"))?;
    match request.action.as_str() {
        "get" => return Ok(services.public_job(job)),
        "pause" => services.downloads.pause(&request.job_id),
        "cancel" => services.downloads.cancel(&request.job_id),
        "resume" => {
            if services.restored.contains(&request.job_id) {
                return Err(NativeError::new("download_reauthorization_required", "Persisted requests omit credentials and signed queries. Capture again in the dedicated browser, then start a new approved download; this job cannot be resumed safely."));
            }
            services.downloads.resume(&request.job_id)
        }
        _ => return Err(NativeError::invalid("action", "must be get, pause, resume or cancel")),
    }.map_err(|_| NativeError::new("download_control_failed", "Download control failed"))?;
    Ok(services.public_job(
        services
            .downloads
            .get(&request.job_id)
            .ok_or_else(|| service_error("Job disappeared"))?,
    ))
}

/// A candidate resource seen by the session dedicated browser. URLs are
/// display-redacted; the download itself replays by `id` inside the host.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaEntry {
    pub id: String,
    pub url: String,
    pub name: String,
    pub page_url: Option<String>,
    pub page_title: Option<String>,
    pub kind: &'static str,
    pub mime: Option<String>,
    pub size: Option<u64>,
    pub drm_protected: bool,
    /// Unix milliseconds.
    pub timestamp: f64,
}

/// Drop credentials, query and fragment so signed URLs never reach the UI.
fn redact_url(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(mut url) => {
            let had_extra = url.query().is_some() || url.fragment().is_some();
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            let mut text = url.to_string();
            if had_extra {
                text.push_str("?\u{2026}");
            }
            text
        }
        Err(_) => raw.split(['?', '#']).next().unwrap_or_default().to_owned(),
    }
}
fn display_name(raw: &str) -> String {
    url::Url::parse(raw)
        .ok()
        .and_then(|u| {
            u.path_segments()
                .and_then(|mut s| s.next_back().filter(|n| !n.is_empty()).map(str::to_owned))
                .or_else(|| u.host_str().map(str::to_owned))
        })
        .unwrap_or_else(|| "download".into())
}
fn classify(request: &CapturedRequest) -> Option<&'static str> {
    if !request.method.eq_ignore_ascii_case("GET") || request.error.is_some() {
        return None;
    }
    if request.status.is_some_and(|s| !(200..300).contains(&s)) {
        return None;
    }
    let url = request.url.to_ascii_lowercase();
    if url.starts_with("blob:") {
        return Some("blob");
    }
    let path = url::Url::parse(&request.url)
        .map(|u| u.path().to_ascii_lowercase())
        .unwrap_or_default();
    let mime = request
        .mime_type
        .clone()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let kind = request.resource_type.to_ascii_lowercase();
    // Individual stream segments are not user-facing downloads.
    if [".ts", ".m4s", ".m4f", ".cmfv", ".cmfa"]
        .iter()
        .any(|e| path.ends_with(e))
        || mime == "video/mp2t"
        || mime.contains("iso.segment")
    {
        return None;
    }
    if path.ends_with(".m3u8") || mime.contains("mpegurl") {
        return Some("hls");
    }
    if path.ends_with(".mpd") || mime.contains("dash+xml") {
        return Some("dash");
    }
    if mime == "application/pdf" || path.ends_with(".pdf") {
        return Some("pdf");
    }
    if mime.starts_with("audio/") {
        return Some("audio");
    }
    if mime.starts_with("video/") || kind == "media" {
        return Some("video");
    }
    if mime.starts_with("image/") || kind == "image" {
        // Skip icons and tracking pixels when the size is known.
        return request
            .content_length
            .map_or(true, |n| n >= 16 * 1024)
            .then_some("image");
    }
    if [
        "msword",
        "officedocument",
        "ms-excel",
        "ms-powerpoint",
        "rtf",
        "epub",
    ]
    .iter()
    .any(|n| mime.contains(n))
    {
        return Some("document");
    }
    let api_like = matches!(kind.as_str(), "xhr" | "fetch");
    if !api_like
        && (["zip", "x-7z", "x-rar", "gzip", "octet-stream"]
            .iter()
            .any(|n| mime.contains(n))
            || [".zip", ".7z", ".rar", ".exe", ".msi", ".iso"]
                .iter()
                .any(|e| path.ends_with(e)))
    {
        return Some("other");
    }
    None
}
/// Newest first, one row per (kind, redacted URL).
fn media_entries(captures: Vec<CapturedRequest>, tabs: &[TabInfo]) -> Vec<MediaEntry> {
    let mut seen = HashSet::new();
    let mut out: Vec<MediaEntry> = captures
        .into_iter()
        .filter_map(|request| {
            let kind = classify(&request)?;
            let tab = request
                .tab_id
                .as_ref()
                .and_then(|id| tabs.iter().find(|t| &t.id == id));
            let page_url = tab
                .map(|t| t.url.clone())
                .or_else(|| request.frame_url.clone())
                .filter(|u| !u.is_empty())
                .map(|u| redact_url(&u));
            Some(MediaEntry {
                url: redact_url(&request.url),
                name: display_name(&request.url),
                page_url,
                page_title: tab.map(|t| t.title.clone()).filter(|t| !t.is_empty()),
                kind,
                drm_protected: drm_hint(&request),
                mime: request.mime_type.clone(),
                size: request.content_length,
                timestamp: request.timestamp * 1000.0,
                id: request.request_id,
            })
        })
        .collect();
    out.sort_by(|a, b| b.timestamp.total_cmp(&a.timestamp));
    out.retain(|e| seen.insert((e.kind, e.url.clone())));
    out
}

#[tauri::command]
pub async fn agent_media_list(
    hub: State<'_, HarnessHub>,
    request: AgentSessionRef,
) -> NativeResult<Vec<MediaEntry>> {
    hub.require_service_session(&request.session_id)?;
    let services = hub.services.session(&request.session_id)?;
    services.check_open()?;
    // Never start the browser just to list captures.
    let Some(browser) = services.browser.existing().await else {
        return Ok(Vec::new());
    };
    Ok(media_entries(
        browser.captured_requests(&NetworkFilter::default()),
        &browser.tabs(),
    ))
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum UserDownloadKind {
    Http,
    Hls,
    Dash,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadStartRequest {
    pub session_id: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub captured_request_id: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub kind: Option<UserDownloadKind>,
}
/// User-initiated download: same validation and transport as the agent tool,
/// no agent approval, but the session/workspace-trust gate still applies.
#[tauri::command]
pub async fn agent_download_start(
    hub: State<'_, HarnessHub>,
    request: DownloadStartRequest,
) -> NativeResult<Value> {
    hub.require_service_session(&request.session_id)?;
    let services = hub.services.session(&request.session_id)?;
    let input = DownloadInput {
        url: request.url,
        captured_request_id: request.captured_request_id,
        kind: request.kind.map(|k| match k {
            UserDownloadKind::Http => JobKind::Http,
            UserDownloadKind::Hls => JobKind::Hls {
                quality: Default::default(),
            },
            UserDownloadKind::Dash => JobKind::Dash {
                quality: Default::default(),
            },
        }),
        file_name: request.file_name.filter(|n| !n.trim().is_empty()),
    };
    let started = start_download(&services, input, true, || false)
        .await
        .map_err(|message| NativeError::new("download_start_failed", message))?;
    let id = started["jobId"].as_str().unwrap_or_default().to_owned();
    let job = services
        .downloads
        .get(&id)
        .ok_or_else(|| service_error("Job disappeared"))?;
    Ok(services.public_job(job))
}

/// Only a completed job output inside the app-owned downloads dir may be revealed.
fn reveal_target(destination: &Path, job: &JobSnapshot) -> NativeResult<PathBuf> {
    let denied = || {
        NativeError::new(
            "download_reveal_denied",
            "Only completed downloads inside the app downloads folder can be shown",
        )
    };
    if job.status != JobStatus::Completed {
        return Err(denied());
    }
    let output = job.output_path.as_ref().ok_or_else(denied)?;
    let root = dunce::canonicalize(destination).map_err(|_| denied())?;
    let file = dunce::canonicalize(output).map_err(|_| denied())?;
    if file == root || !file.starts_with(&root) {
        return Err(denied());
    }
    Ok(file)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadRevealRequest {
    pub session_id: String,
    pub job_id: String,
}
#[tauri::command]
pub fn agent_download_reveal(
    hub: State<'_, HarnessHub>,
    request: DownloadRevealRequest,
) -> NativeResult<()> {
    hub.require_service_session(&request.session_id)?;
    let services = hub.services.session(&request.session_id)?;
    let job = services
        .downloads
        .get(&request.job_id)
        .ok_or_else(|| NativeError::new("download_not_found", "No such job in this session"))?;
    let file = reveal_target(&services.destination, &job)?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", file.display()))
            .spawn()
            .map_err(|_| NativeError::new("download_reveal_failed", "Could not open Explorer"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        Err(NativeError::new(
            "download_reveal_failed",
            "Showing in folder is supported only on Windows",
        ))
    }
}

/// A recording folder (or a file in one) strictly inside the session recordings dir.
fn recording_reveal_target(recordings: &Path, requested: &str) -> NativeResult<PathBuf> {
    let denied = || {
        NativeError::new(
            "recording_reveal_denied",
            "Only recordings inside the app recordings folder can be shown",
        )
    };
    let root = dunce::canonicalize(recordings).map_err(|_| denied())?;
    let target = dunce::canonicalize(requested).map_err(|_| denied())?;
    if target == root || !target.starts_with(&root) {
        return Err(denied());
    }
    Ok(target)
}
#[tauri::command]
pub fn agent_recordings_list(
    hub: State<'_, HarnessHub>,
    request: AgentSessionRef,
) -> NativeResult<Vec<omnia_browser::record::RecordingEntry>> {
    hub.require_service_session(&request.session_id)?;
    let services = hub.services.session(&request.session_id)?;
    services.check_open()?;
    Ok(omnia_browser::record::list_recordings(&services.recordings))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordingRevealRequest {
    pub session_id: String,
    pub path: String,
}
#[tauri::command]
pub fn agent_recording_reveal(
    hub: State<'_, HarnessHub>,
    request: RecordingRevealRequest,
) -> NativeResult<()> {
    hub.require_service_session(&request.session_id)?;
    let services = hub.services.session(&request.session_id)?;
    let target = recording_reveal_target(&services.recordings, &request.path)?;
    #[cfg(windows)]
    {
        let arg = if target.is_dir() {
            target.display().to_string()
        } else {
            format!("/select,{}", target.display())
        };
        std::process::Command::new("explorer.exe")
            .arg(arg)
            .spawn()
            .map_err(|_| NativeError::new("recording_reveal_failed", "Could not open Explorer"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Err(NativeError::new(
            "recording_reveal_failed",
            "Showing in folder is supported only on Windows",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omnia_download::Quality;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("omnia-host-services-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn recording_reveal_stays_inside_recordings_dir() {
        let fixture = Fixture::new();
        let recordings = fixture.0.join("recordings");
        let one = recordings.join("one-20260101-000000");
        std::fs::create_dir_all(&one).unwrap();
        std::fs::write(one.join("steps.json"), b"{}").unwrap();
        let outside = fixture.0.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        assert!(recording_reveal_target(&recordings, one.to_str().unwrap()).is_ok());
        assert!(
            recording_reveal_target(&recordings, one.join("steps.json").to_str().unwrap()).is_ok()
        );
        assert!(recording_reveal_target(&recordings, recordings.to_str().unwrap()).is_err());
        assert!(recording_reveal_target(&recordings, outside.to_str().unwrap()).is_err());
        let sneaky = one.join("..").join("..").join("outside");
        assert!(recording_reveal_target(&recordings, sneaky.to_str().unwrap()).is_err());
        assert!(recording_reveal_target(&recordings, "does-not-exist").is_err());
    }

    fn assert_no_profiles(root: &Path) {
        assert!(!root.join("browser-profile").exists());
        if let Ok(sessions) = std::fs::read_dir(root.join("agent-services")) {
            for dir in sessions.flatten() {
                assert!(
                    !dir.path().join("profiles").exists(),
                    "a profile dir was created"
                );
            }
        }
    }

    #[tokio::test]
    async fn persistent_profile_survives_retire_and_disposable_is_deleted() {
        let fixture = Fixture::new();
        let host = AgentServices::new(&fixture.0);
        // Default: keep sign-ins, one persistent Omnia-owned profile (not a personal one).
        let session = host.session("one").unwrap();
        assert_eq!(session.profile_mode(), ProfileMode::Persistent);
        assert_eq!(session.status()["browser"]["profileMode"], "persistent");
        assert_eq!(session.status()["browser"]["personalBrowser"], false);
        let launch = session.browser.resolve_launch();
        assert_eq!(launch.profile_dir, host.profiles.persistent_dir());
        assert!(!launch.headless);
        std::fs::create_dir_all(&launch.profile_dir).unwrap();
        std::fs::write(launch.profile_dir.join("Cookies"), b"signed-in").unwrap();
        host.retire("one");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while host.profiles.in_use() || host.profiles.preview("zzz") != ProfileMode::Persistent
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(
            launch.profile_dir.join("Cookies").is_file(),
            "persistent profile must not be deleted on retire"
        );

        // Setting off: a disposable per-launch profile that retire removes.
        host.profiles.update(Some(false), None).unwrap();
        let two = host.session("two").unwrap();
        assert_eq!(two.status()["browser"]["profileMode"], "disposable");
        let disposable = two.browser.resolve_launch().profile_dir;
        assert!(disposable.starts_with(fixture.0.join("agent-services")));
        std::fs::create_dir_all(&disposable).unwrap();
        host.retire("two");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while disposable.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(launch.profile_dir.is_dir());
    }

    #[test]
    fn settings_validate_ffmpeg_and_status_reports_it() {
        let fixture = Fixture::new();
        let host = AgentServices::new(&fixture.0);
        assert!(set_browser_settings(&host, None, Some("relative/ffmpeg.exe")).is_err());
        assert!(set_browser_settings(&host, None, Some("C:/nope/notffmpeg.exe")).is_err());
        let exe = fixture.0.join(if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        });
        std::fs::write(&exe, b"x").unwrap();
        set_browser_settings(&host, Some(false), Some(&exe.to_string_lossy())).unwrap();
        let status = host.session("one").unwrap().status();
        assert_eq!(status["ffmpeg"]["available"], true);
        assert_eq!(status["ffmpeg"]["configuredPath"], json!(exe));
        assert_eq!(status["browser"]["keepSignIns"], false);
        set_browser_settings(&host, None, Some("")).unwrap();
        assert!(host.profiles.settings().ffmpeg_path.is_none());
        assert!(!host.profiles.settings().keep_sign_ins);
    }

    #[test]
    fn signin_url_accepts_only_plain_http_urls() {
        assert_eq!(signin_url(None).unwrap(), None);
        assert_eq!(signin_url(Some("  ".into())).unwrap(), None);
        assert!(signin_url(Some("https://example.com/login".into()))
            .unwrap()
            .is_some());
        for bad in [
            "file:///c:/x",
            "javascript:alert(1)",
            "https://u:p@example.com/",
            "not a url",
        ] {
            assert!(signin_url(Some(bad.into())).is_err(), "{bad}");
        }
    }

    #[test]
    fn muxskipped_surfaces_a_hint_on_the_job() {
        let fixture = Fixture::new();
        let host = AgentServices::new(&fixture.0);
        let session = host.session("one").unwrap();
        let mut job = JobSnapshot {
            id: "j".into(),
            spec: JobSpec::new(
                JobKind::Http,
                RequestSpec::get("https://example.com/a.m3u8"),
                fixture.0.join("d"),
            ),
            status: omnia_download::engine::JobStatus::Completed,
            progress: Default::default(),
            output_path: None,
            extra_outputs: vec![],
            mux: Some(omnia_download::mux::MuxOutcome::MuxSkipped {
                reason: "ffmpeg was not found".into(),
            }),
            error: None,
            error_code: None,
            created_at: 0,
        };
        let value = session.public_job(job.clone());
        assert_eq!(value["muxSkipped"], true);
        assert!(value["muxHint"].as_str().unwrap().contains("ffmpeg"));
        job.mux = None;
        assert_eq!(session.public_job(job)["muxSkipped"], false);
    }

    #[tokio::test]
    async fn registration_is_inert_scoped_and_computer_is_disabled() {
        let fixture = Fixture::new();
        let host = AgentServices::new(&fixture.0);
        let session = host.session("one").unwrap();
        let other = host.session("two").unwrap();
        assert_ne!(session.destination, other.destination);
        assert!(session.browser.config().endpoint.is_none());
        assert_no_profiles(&fixture.0);
        let mut registry = ToolRegistry::default();
        register(&mut registry, session.clone(), Arc::new(|| Ok(())));
        assert!(registry.get("browser_navigate").is_some());
        assert!(registry.get("download_start").is_some());
        let tool = registry.get("computer_windows").unwrap();
        let result = tool
            .call(&ToolContext::new(&fixture.0), json!({}))
            .await
            .unwrap();
        assert!(result.is_error);
        assert!(session.computer.lock().unwrap().is_none());
        assert_no_profiles(&fixture.0);
        host.emergency_stop();
    }

    #[tokio::test]
    async fn revoked_trust_and_cancel_prevent_browser_launch() {
        let fixture = Fixture::new();
        let host = AgentServices::new(&fixture.0);
        let session = host.session("one").unwrap();
        let mut registry = ToolRegistry::default();
        register(
            &mut registry,
            session.clone(),
            Arc::new(|| {
                Err(NativeError::new(
                    "workspace_trust_required",
                    "fixture revoked",
                ))
            }),
        );
        let tool = registry.get("browser_navigate").unwrap();
        let ctx = ToolContext::new(&fixture.0);
        assert!(
            tool.call(&ctx, json!({"url":"https://example.com"}))
                .await
                .unwrap()
                .is_error
        );
        ctx.cancel.cancel();
        assert!(matches!(
            tool.call(&ctx, json!({})).await,
            Err(HarnessError::Cancelled)
        ));
        assert_no_profiles(&fixture.0);
    }

    #[tokio::test]
    async fn download_rejects_loopback_before_contacting_local_fixture() {
        let fixture = Fixture::new();
        let host = AgentServices::new(&fixture.0);
        let session = host.session("one").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/secret?token=fixture",
            listener.local_addr().unwrap()
        );
        let tool = DownloadTool(session.clone());
        let output = tool
            .call(&ToolContext::new(&fixture.0), json!({"url":url}))
            .await
            .unwrap();
        assert!(output.is_error);
        let text = format!("{output:?}");
        assert!(text.contains("blocked: downloads to loopback/private addresses are not allowed"));
        assert!(!text.contains("token=fixture"));
        assert!(session.downloads.list().is_empty());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
        assert!(host.session("two").unwrap().downloads.list().is_empty());
    }

    #[test]
    fn download_kind_accepts_bare_and_tagged_quality() {
        for quality in [json!("best"), json!({"type":"best"})] {
            let mut input =
                json!({"url":"https://example.com/a.m3u8","kind":{"type":"hls","quality":quality}});
            normalize_download_kind(&mut input);
            let parsed: DownloadInput = serde_json::from_value(input).unwrap();
            assert_eq!(
                parsed.kind,
                Some(JobKind::Hls {
                    quality: Quality::Best
                })
            );
        }
        let mut input = json!({"kind":{"type":"dash","quality":"Worst"}});
        normalize_download_kind(&mut input);
        let parsed: DownloadInput = serde_json::from_value(input).unwrap();
        assert_eq!(
            parsed.kind,
            Some(JobKind::Dash {
                quality: Quality::Worst
            })
        );
        let mut input = json!({"kind":{"type":"dash","quality":{"type":"maxHeight","value":720}}});
        normalize_download_kind(&mut input);
        let parsed: DownloadInput = serde_json::from_value(input).unwrap();
        assert_eq!(
            parsed.kind,
            Some(JobKind::Dash {
                quality: Quality::MaxHeight(720)
            })
        );
    }

    #[test]
    fn restored_jobs_are_marked_for_reauthorization_and_redacted() {
        let fixture = Fixture::new();
        let root = fixture
            .0
            .join("agent-services")
            .join(format!("{:x}", Sha256::digest(b"one")));
        std::fs::create_dir_all(&root).unwrap();
        let mut request = RequestSpec::get("https://example.com/file?signature=secret");
        request.cookies = Some("session=secret".into());
        request.headers = vec![("Authorization".into(), "Bearer secret".into())];
        let snapshot = JobSnapshot {
            id: "restored".into(),
            spec: JobSpec::new(JobKind::Http, request, root.join("downloads")),
            status: omnia_download::engine::JobStatus::Downloading,
            progress: Default::default(),
            output_path: None,
            extra_outputs: vec![],
            mux: None,
            error: None,
            error_code: None,
            created_at: 0,
        };
        let bytes = serde_json::to_vec(&vec![snapshot]).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("secret"));
        std::fs::write(root.join("jobs.json"), bytes).unwrap();
        let host = AgentServices::new(&fixture.0);
        let session = host.session("one").unwrap();
        let public = session.public_job(session.downloads.get("restored").unwrap());
        assert_eq!(public["reauthorizationRequired"], true);
        assert_eq!(public["job"]["status"], "paused");
    }

    #[test]
    fn emergency_stop_revokes_grants_and_kills_stale_handles() {
        let fixture = Fixture::new();
        let host = AgentServices::new(&fixture.0);
        let session = host.session("one").unwrap();
        let computer = Computer::new(ComputerConfig::default());
        *session.computer.lock().unwrap() = Some(ComputerGrant {
            computer: computer.clone(),
            capture: true,
            control: true,
        });
        host.emergency_stop();
        assert!(computer.kill_switch().is_triggered());
        assert!(session.computer.lock().unwrap().is_none());
        assert_eq!(session.status()["computer"]["capture"], false);
    }

    fn capture(url: &str, mime: &str, kind: &str, ts: f64) -> CapturedRequest {
        CapturedRequest {
            request_id: format!("id-{ts}"),
            url: url.into(),
            method: "GET".into(),
            resource_type: kind.into(),
            status: Some(200),
            mime_type: Some(mime.into()),
            timestamp: ts,
            ..Default::default()
        }
    }

    #[test]
    fn source_requires_exactly_one_of_url_or_capture() {
        assert!(resolve_source(Some("https://a.test/x".into()), Some("id".into())).is_err());
        assert!(resolve_source(None, None).is_err());
        assert!(resolve_source(Some("  ".into()), None).is_err());
        assert!(matches!(
            resolve_source(Some("https://a.test/x".into()), None),
            Ok(Source::Url(_))
        ));
        assert!(matches!(
            resolve_source(None, Some("id".into())),
            Ok(Source::Captured(_))
        ));
    }

    #[tokio::test]
    async fn start_download_rejects_bad_sources_without_creating_jobs() {
        let fixture = Fixture::new();
        let host = AgentServices::new(&fixture.0);
        let session = host.session("one").unwrap();
        let input = |url: Option<&str>, id: Option<&str>| DownloadInput {
            url: url.map(Into::into),
            captured_request_id: id.map(Into::into),
            kind: None,
            file_name: None,
        };
        assert!(start_download(
            &session,
            input(Some("https://a.test/x"), Some("id")),
            true,
            || false
        )
        .await
        .is_err());
        assert!(start_download(&session, input(None, None), true, || false)
            .await
            .is_err());
        // A capture id with no browser ever started must not launch one.
        assert!(
            start_download(&session, input(None, Some("id")), true, || false)
                .await
                .is_err()
        );
        assert!(start_download(
            &session,
            input(Some("file:///etc/passwd"), None),
            true,
            || false
        )
        .await
        .is_err());
        assert!(start_download(
            &session,
            input(Some("https://u:p@a.test/x"), None),
            true,
            || false
        )
        .await
        .is_err());
        let blob = DownloadInput {
            kind: Some(JobKind::Blob),
            ..input(Some("https://a.test/x"), None)
        };
        assert!(start_download(&session, blob, true, || false)
            .await
            .is_err());
        assert!(session.downloads.list().is_empty());
        assert!(session.browser.existing().await.is_none());
    }

    #[test]
    fn drm_flagged_captures_are_marked_and_refused() {
        let protected = capture(
            "https://cdn.test/widevine/license.mpd",
            "application/dash+xml",
            "Media",
            1.0,
        );
        assert!(drm_hint(&protected));
        let entries = media_entries(vec![protected], &[]);
        assert!(entries[0].drm_protected);
        assert!(!drm_hint(&capture(
            "https://cdn.test/a.mp4",
            "video/mp4",
            "Media",
            1.0
        )));
    }

    #[test]
    fn media_list_redacts_dedupes_and_sorts_newest_first() {
        let mut a = capture(
            "https://cdn.test/a.mp4?sig=SECRET",
            "video/mp4",
            "Media",
            1.0,
        );
        a.tab_id = Some("t1".into());
        a.content_length = Some(10);
        let b = capture(
            "https://cdn.test/a.mp4?sig=OTHER",
            "video/mp4",
            "Media",
            3.0,
        );
        let c = capture(
            "https://cdn.test/list.m3u8",
            "application/vnd.apple.mpegurl",
            "XHR",
            2.0,
        );
        let seg = capture("https://cdn.test/seg1.ts", "video/mp2t", "Media", 4.0);
        let html = capture("https://cdn.test/index.html", "text/html", "Document", 5.0);
        let tabs = [TabInfo {
            id: "t1".into(),
            url: "https://page.test/v?token=SECRET".into(),
            title: "Page".into(),
        }];
        let entries = media_entries(vec![a, b, c, seg, html], &tabs);
        assert_eq!(
            entries.iter().map(|e| e.kind).collect::<Vec<_>>(),
            ["video", "hls"]
        );
        assert_eq!(entries[0].timestamp, 3000.0);
        let json = serde_json::to_string(&entries).unwrap();
        assert!(!json.contains("SECRET") && !json.contains("OTHER"));
        assert_eq!(entries[0].name, "a.mp4");
    }

    #[tokio::test]
    async fn media_list_without_browser_is_empty_and_starts_nothing() {
        let fixture = Fixture::new();
        let host = AgentServices::new(&fixture.0);
        let session = host.session("one").unwrap();
        assert!(session.browser.existing().await.is_none());
        assert_no_profiles(&fixture.0);
    }

    #[test]
    fn reveal_is_limited_to_completed_files_in_the_downloads_dir() {
        let fixture = Fixture::new();
        let dest = fixture.0.join("downloads");
        std::fs::create_dir_all(&dest).unwrap();
        let inside = dest.join("a.bin");
        let outside = fixture.0.join("secret.txt");
        std::fs::write(&inside, b"x").unwrap();
        std::fs::write(&outside, b"x").unwrap();
        let job = |path: Option<PathBuf>, status: JobStatus| JobSnapshot {
            id: "j".into(),
            spec: JobSpec::new(JobKind::Http, RequestSpec::get("https://a.test/a"), &dest),
            status,
            progress: Default::default(),
            output_path: path,
            extra_outputs: vec![],
            mux: None,
            error: None,
            error_code: None,
            created_at: 0,
        };
        assert!(reveal_target(&dest, &job(Some(inside.clone()), JobStatus::Completed)).is_ok());
        assert!(reveal_target(&dest, &job(Some(outside), JobStatus::Completed)).is_err());
        assert!(reveal_target(
            &dest,
            &job(
                Some(dest.join("..").join("secret.txt")),
                JobStatus::Completed
            )
        )
        .is_err());
        assert!(reveal_target(&dest, &job(Some(inside), JobStatus::Downloading)).is_err());
        assert!(reveal_target(&dest, &job(None, JobStatus::Completed)).is_err());
        assert!(reveal_target(&dest, &job(Some(dest.clone()), JobStatus::Completed)).is_err());
    }
}
