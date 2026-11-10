//! Native-owned remote browsing surfaces. Remote documents receive no Omnia IPC
//! capability and never supply native command names, scripts, paths or handles.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    Emitter, EventTarget, Manager, PhysicalPosition, PhysicalSize, Rect, State, Webview,
    WebviewUrl,
};

use crate::error::{NativeError, NativeResult};
#[cfg(windows)]
use crate::native_browser_keyboard::BrowserKeyboardRegistration;

const NAVIGATION_EVENT: &str = "omnia-browser-surface-navigation";
const POLICY_EVENT: &str = "omnia-browser-surface-policy";
const MAX_TABS: usize = 32;
const MAX_URL_BYTES: usize = 8192;

/// Defense in depth in addition to the unchanged remote ACL. The browser
/// document must not negotiate or use an application IPC session.
pub(crate) fn deny_browser_invokes(
    handler: impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    move |invoke| {
        if invoke
            .message
            .webview_ref()
            .label()
            .starts_with("omnia-browser-")
        {
            invoke.resolver.reject(NativeError::new(
                "browser_caller_denied",
                "Browser documents cannot invoke Omnia application commands",
            ));
            return true;
        }
        handler(invoke)
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSurfaceBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ClippedBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl ClippedBounds {
    fn rect(self) -> Rect {
        Rect {
            position: PhysicalPosition::new(self.x, self.y).into(),
            size: PhysicalSize::new(self.width, self.height).into(),
        }
    }
}

fn clip_bounds(
    bounds: BrowserSurfaceBounds,
    width: u32,
    height: u32,
) -> NativeResult<ClippedBounds> {
    if ![bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .all(|n| n.is_finite() && n.abs() <= 1_000_000.0)
        || bounds.width <= 0.0
        || bounds.height <= 0.0
        || width == 0
        || height == 0
        || width > 1_000_000
        || height > 1_000_000
    {
        return Err(NativeError::invalid(
            "bounds",
            "must describe a finite visible browser region",
        ));
    }
    let left = bounds.x.round().max(0.0);
    let top = bounds.y.round().max(0.0);
    let right = (bounds.x + bounds.width).round().min(f64::from(width));
    let bottom = (bounds.y + bounds.height).round().min(f64::from(height));
    if right <= left || bottom <= top {
        return Err(NativeError::invalid(
            "bounds",
            "the browser region is outside the application window",
        ));
    }
    Ok(ClippedBounds {
        x: left as i32,
        y: top as i32,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

fn browser_url(raw: &str) -> NativeResult<url::Url> {
    if raw.len() > MAX_URL_BYTES {
        return Err(NativeError::invalid(
            "url",
            "the browser address is too long",
        ));
    }
    let url = omnia_browser::safety::navigation_url(raw).map_err(|_| {
        NativeError::invalid(
            "url",
            "use an HTTP or HTTPS address without embedded credentials",
        )
    })?;
    // A remote child must never navigate into the privileged app protocols,
    // its loopback services, or a local debugging endpoint.
    let local_host = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_unspecified(),
        Some(url::Host::Ipv6(ip)) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|ip| ip.is_loopback() || ip.is_unspecified())
        }
        Some(url::Host::Domain(host)) => {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            host == "localhost" || host.ends_with(".localhost")
        }
        None => true,
    };
    if !matches!(url.scheme(), "http" | "https") || local_host {
        return Err(NativeError::invalid(
            "url",
            "this address cannot be opened in the embedded browser",
        ));
    }
    Ok(url)
}

fn valid_tab_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn allowed_local_caller(label: &str, url: &url::Url) -> bool {
    let app_origin = matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    ) && url.port().is_none();
    let preview_origin = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420);
    label == "main"
        && (app_origin || preview_origin)
        && url.username().is_empty()
        && url.password().is_none()
}

fn require_local_caller(webview: &Webview) -> NativeResult<()> {
    let url = webview.url().map_err(|_| {
        NativeError::new(
            "browser_caller_denied",
            "The browser request origin is unavailable",
        )
    })?;
    if !allowed_local_caller(webview.label(), &url) {
        return Err(NativeError::new(
            "browser_caller_denied",
            "Only the local Omnia window can manage browser tabs",
        ));
    }
    Ok(())
}

#[derive(Clone)]
struct BrowserTab {
    tab_key: String,
    lease_id: String,
    label: String,
    url: url::Url,
    visible: bool,
    // Visibility is invalidated before native hide calls. Keep a failed focus
    // handoff independent from it so release can still return focus afterward.
    focus_return_pending: bool,
    zoom: f64,
}

#[derive(Default)]
struct SurfaceState {
    tabs: BTreeMap<String, BrowserTab>,
    // Failed native close attempts retain ownership here without retaining a
    // renderer lease. Pending children still count toward the native limit.
    closing: BTreeSet<String>,
    epoch: u64,
}

impl SurfaceState {
    fn reserve(&mut self, tab_key: &str, url: url::Url) -> NativeResult<BrowserTab> {
        if self.tabs.len() + self.closing.len() >= MAX_TABS {
            return Err(NativeError::new(
                "browser_tab_limit",
                if self.closing.is_empty() {
                    "Close a browser tab before opening another one"
                } else {
                    "Some browser pages are still closing. Retry or reopen Omnia."
                },
            ));
        }
        let entry = BrowserTab {
            tab_key: tab_key.to_owned(),
            lease_id: uuid::Uuid::new_v4().simple().to_string(),
            label: format!("omnia-browser-{}", uuid::Uuid::new_v4().simple()),
            url,
            visible: false,
            focus_return_pending: false,
            zoom: 1.0,
        };
        self.tabs.insert(tab_key.to_owned(), entry.clone());
        Ok(entry)
    }

    fn reassign(&mut self, tab_key: &str) -> Option<BrowserTab> {
        self.tabs.get_mut(tab_key).map(|entry| {
            entry.lease_id = uuid::Uuid::new_v4().simple().to_string();
            entry.visible = false;
            entry.clone()
        })
    }

    fn owned(&self, lease: &str) -> Option<BrowserTab> {
        if lease.len() != 32 {
            return None;
        }
        self.tabs
            .values()
            .find(|entry| entry.lease_id == lease)
            .cloned()
    }

    fn attachment_is_current(&self, entry: &BrowserTab, epoch: u64) -> bool {
        self.epoch == epoch
            && self.tabs.get(&entry.tab_key).is_some_and(|current| {
                current.label == entry.label && current.lease_id == entry.lease_id
            })
    }

    fn release(&mut self, lease: &str) -> Option<BrowserTab> {
        let owned = self.owned(lease)?;
        self.tabs.remove(&owned.tab_key)
    }

    fn begin_hide(&mut self, lease: &str) -> bool {
        let Some(record) = self.tabs.values_mut().find(|entry| entry.lease_id == lease) else {
            return false;
        };
        record.focus_return_pending |= record.visible;
        record.visible = false;
        record.focus_return_pending
    }

    fn finish_focus_return(&mut self, lease: &str, returned: bool) {
        if returned {
            if let Some(record) = self.tabs.values_mut().find(|entry| entry.lease_id == lease) {
                record.focus_return_pending = false;
            }
        }
    }

    fn retire(&mut self, lease: &str) -> Option<BrowserTab> {
        let owned = self.release(lease)?;
        self.closing.insert(owned.label.clone());
        Some(owned)
    }

    fn finish_close(&mut self, label: &str, closed: bool) {
        if closed {
            self.closing.remove(label);
        }
    }

    fn commit_reattach(
        &mut self,
        previous: &BrowserTab,
        prepared: NativeResult<()>,
    ) -> NativeResult<BrowserTab> {
        if let Err(error) = prepared {
            self.retire(&previous.lease_id);
            return Err(error);
        }
        if self.owned(&previous.lease_id).is_none() {
            return Err(NativeError::new(
                "browser_surface_expired",
                "The browser host changed before this tab could attach",
            ));
        }
        self.reassign(&previous.tab_key).ok_or_else(ui_error)
    }

    fn invalidate(&mut self) -> Vec<String> {
        self.epoch = self.epoch.wrapping_add(1);
        for entry in std::mem::take(&mut self.tabs).into_values() {
            self.closing.insert(entry.label);
        }
        self.closing.iter().cloned().collect()
    }
}

/// Native visibility/close errors must never skip the focus handoff. A false
/// obligation represents an already hidden page and must not move focus.
fn retire_visual(
    return_focus: bool,
    retire: impl FnOnce() -> NativeResult<()>,
    focus_main: impl FnOnce() -> NativeResult<()>,
) -> (NativeResult<()>, bool) {
    let retired = retire();
    let focused = if return_focus { focus_main() } else { Ok(()) };
    let returned = return_focus && focused.is_ok();
    (retired.and(focused), returned)
}

/// Handler removal acknowledgements may be delayed. Retire the native child,
/// hand off focus and unlock native operations before awaiting that cleanup.
async fn retire_before_detach(
    retire: impl FnOnce() -> NativeResult<()>,
    detach: impl std::future::Future<Output = ()>,
) -> NativeResult<()> {
    let result = retire();
    detach.await;
    result
}

#[derive(Clone)]
pub struct BrowserSurfaceManager {
    inner: Arc<Mutex<SurfaceState>>,
    // Native mutations are serialized, but callbacks only touch `inner`.
    // Never hold the std mutex while waiting for a UI-thread Webview operation.
    operations: Arc<tokio::sync::Mutex<()>>,
    profile_directory: PathBuf,
    // Controllers and COM interfaces never leave the UI thread. These guards
    // contain only native token IDs, an independent ownership snapshot and a
    // bounded worker. Keep this lock out of native Webview operations.
    #[cfg(windows)]
    keyboards: Arc<Mutex<BTreeMap<String, Arc<BrowserKeyboardRegistration>>>>,
}

impl BrowserSurfaceManager {
    pub fn new(app_data: &Path) -> Self {
        Self {
            inner: Arc::new(Mutex::new(SurfaceState::default())),
            operations: Arc::new(tokio::sync::Mutex::new(())),
            profile_directory: app_data.join("browser-webview-profile"),
            #[cfg(windows)]
            keyboards: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    fn lock(&self) -> NativeResult<std::sync::MutexGuard<'_, SurfaceState>> {
        self.inner.lock().map_err(|_| {
            NativeError::new(
                "browser_surface_state",
                "The browser tab state is unavailable",
            )
        })
    }

    fn owned(&self, lease: &str) -> NativeResult<BrowserTab> {
        self.lock()?.owned(lease).ok_or_else(|| {
            NativeError::new(
                "browser_surface_expired",
                "This browser tab is no longer attached",
            )
        })
    }

    #[cfg(windows)]
    fn register_keyboard(
        &self,
        entry: &BrowserTab,
        epoch: u64,
        keyboard: Arc<BrowserKeyboardRegistration>,
    ) -> NativeResult<()> {
        let state = self.lock()?;
        if !state.attachment_is_current(entry, epoch) {
            return Err(expired_attachment());
        }
        let mut keyboards = self.keyboards.lock().map_err(|_| ui_error())?;
        // Install exactly once for each actual controller, even when renderer
        // reattachment replaces its lease.
        if keyboards.contains_key(&entry.label) {
            return Err(ui_error());
        }
        keyboards.insert(entry.label.clone(), keyboard);
        Ok(())
    }

    fn keyboard_set_owner(
        &self,
        _entry: &BrowserTab,
        _epoch: u64,
        _visible: bool,
    ) -> NativeResult<()> {
        #[cfg(windows)]
        {
            let keyboard = self
                .keyboards
                .lock()
                .map_err(|_| ui_error())?
                .get(&_entry.label)
                .cloned()
                .ok_or_else(ui_error)?;
            keyboard.set_owner(&_entry.lease_id, _epoch, _visible)?;
        }
        Ok(())
    }

    #[cfg(windows)]
    fn take_keyboard(&self, label: &str) -> Option<Arc<BrowserKeyboardRegistration>> {
        let keyboard = self
            .keyboards
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(label);
        if let Some(keyboard) = &keyboard {
            // Logical teardown must precede any potentially failing native call.
            keyboard.invalidate();
        }
        keyboard
    }

    async fn detach_keyboard(&self, _label: &str) {
        #[cfg(windows)]
        if let Some(keyboard) = self.take_keyboard(_label) {
            let _ = keyboard.detach().await;
        }
    }

    fn discard_keyboard(&self, _label: &str) {
        #[cfg(windows)]
        drop(self.take_keyboard(_label));
    }

    fn close_retired(&self, app: &tauri::AppHandle, label: &str) -> NativeResult<()> {
        self.discard_keyboard(label);
        let closed = if let Some(child) = app.get_webview(label) {
            // A failed close must not retain an active renderer lease. Keep
            // the native label for a later retry and hide before closing.
            let _ = child.hide();
            child.close().map_err(|_| ui_error())
        } else {
            Ok(())
        };
        self.lock()?.finish_close(label, closed.is_ok());
        closed
    }

    fn retry_cleanup(&self, app: &tauri::AppHandle) {
        let labels = match self.lock() {
            Ok(state) => state.closing.iter().cloned().collect::<Vec<_>>(),
            Err(_) => return,
        };
        for label in labels {
            let _ = self.close_retired(app, &label);
        }
    }

    /// Called when main starts a new document, or its window is destroyed.
    /// The old renderer can no longer keep a remote child above the new UI.
    pub fn stop(&self, app: &tauri::AppHandle) {
        let entries = match self.lock() {
            Ok(mut state) => state.invalidate(),
            Err(_) => return,
        };
        // Disable every old controller before the first hide/close can pump
        // native events. New controllers from a new epoch are not included.
        #[cfg(windows)]
        {
            let keyboards = entries
                .iter()
                .filter_map(|label| self.take_keyboard(label))
                .collect::<Vec<_>>();
            drop(keyboards);
        }
        for label in entries {
            let _ = self.close_retired(app, &label);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSurfaceAttachment {
    lease_id: String,
    url: String,
    zoom_percent: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserNavigation {
    tab_key: String,
    lease_id: String,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loading: Option<bool>,
    zoom_percent: u16,
}

/// Policy events are emitted when the embedded page asks for a capability that
/// is intentionally denied at the native boundary.  The payload is bounded and
/// never contains a local destination path or request headers.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPolicyNotice {
    receipt_id: String,
    tab_key: String,
    lease_id: String,
    kind: &'static str,
    url: Option<String>,
    success: Option<bool>,
    reason: &'static str,
    occurred_at_ms: i64,
}

fn policy_reason(kind: &'static str) -> &'static str {
    match kind {
        "new-window-denied" => "New windows are managed as Omnia browser tabs.",
        "download-denied" => "Downloads require an explicit Omnia download approval.",
        "download-finished" => "The native browser reported the download result.",
        _ => "The browser capability was denied by native policy.",
    }
}

fn emit_navigation(
    manager: &BrowserSurfaceManager,
    app: &tauri::AppHandle,
    tab_key: &str,
    label: &str,
    url: &url::Url,
    title: Option<String>,
    loading: Option<bool>,
) {
    if browser_url(url.as_str()).is_err() {
        return;
    }
    let payload = manager.lock().ok().and_then(|mut state| {
        let entry = state
            .tabs
            .get_mut(tab_key)
            .filter(|entry| entry.label == label)?;
        entry.url = url.clone();
        Some(BrowserNavigation {
            tab_key: entry.tab_key.clone(),
            lease_id: entry.lease_id.clone(),
            url: url.to_string(),
            title: title.map(|title| {
                title
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(512)
                    .collect()
            }),
            loading,
            zoom_percent: (entry.zoom * 100.0).round() as u16,
        })
    });
    if let Some(payload) = payload {
        // Target the privileged main document only, not every child of its OS window.
        let _ = app.emit_to(EventTarget::webview("main"), NAVIGATION_EVENT, payload);
    }
}

fn emit_policy_notice(
    manager: &BrowserSurfaceManager,
    app: &tauri::AppHandle,
    entry: &BrowserTab,
    kind: &'static str,
    url: Option<&url::Url>,
    success: Option<bool>,
) {
    let Some(current) = manager.lock().ok().and_then(|state| {
        state
            .tabs
            .get(&entry.tab_key)
            .filter(|current| current.label == entry.label)
            .cloned()
    }) else {
        return;
    };
    let safe_url = url
        .filter(|url| browser_url(url.as_str()).is_ok())
        .map(|url| url.to_string());
    let payload = BrowserPolicyNotice {
        receipt_id: format!("browser_policy_{}", uuid::Uuid::new_v4().simple()),
        tab_key: current.tab_key,
        lease_id: current.lease_id,
        kind,
        url: safe_url,
        success,
        reason: policy_reason(kind),
        occurred_at_ms: crate::storage::now_ms(),
    };
    let _ = app.emit_to(EventTarget::webview("main"), POLICY_EVENT, payload);
}

fn ui_error() -> NativeError {
    NativeError::new(
        "browser_surface_failed",
        "The browser page could not be updated. Reopen this tab to try again.",
    )
}

fn expired_attachment() -> NativeError {
    NativeError::new(
        "browser_surface_expired",
        "The browser host changed before this tab could attach",
    )
}

fn measured_bounds(webview: &Webview, bounds: BrowserSurfaceBounds) -> NativeResult<ClippedBounds> {
    let size = webview.window().inner_size().map_err(|_| ui_error())?;
    clip_bounds(bounds, size.width, size.height)
}

#[tauri::command]
pub async fn browser_surface_attach(
    webview: Webview,
    manager: State<'_, BrowserSurfaceManager>,
    tab_key: String,
    url: String,
    bounds: BrowserSurfaceBounds,
) -> NativeResult<BrowserSurfaceAttachment> {
    require_local_caller(&webview)?;
    if !valid_tab_key(&tab_key) {
        return Err(NativeError::invalid(
            "tabKey",
            "must identify an existing browser tab",
        ));
    }
    let requested_url = browser_url(&url)?;
    let bounds = measured_bounds(&webview, bounds)?;
    let epoch = manager.lock()?.epoch;
    let _operation = manager.operations.lock().await;
    if manager.lock()?.epoch != epoch {
        return Err(NativeError::new(
            "browser_surface_expired",
            "The browser host changed before this tab could attach",
        ));
    }
    let app = webview.app_handle().clone();
    manager.retry_cleanup(&app);
    let existing = manager.lock()?.tabs.get(&tab_key).cloned();
    if let Some(existing) = existing {
        if let Some(child) = app.get_webview(&existing.label) {
            let prepared = manager
                .keyboard_set_owner(&existing, epoch, false)
                .and_then(|_| {
                    child
                        .hide()
                        .and_then(|_| child.set_bounds(bounds.rect()))
                        .map_err(|_| ui_error())
                });
            let committed = manager.lock()?.commit_reattach(&existing, prepared);
            let entry = match committed {
                Ok(entry) => entry,
                Err(error) => {
                    manager.retry_cleanup(&app);
                    return Err(error);
                }
            };
            if let Err(error) = manager.keyboard_set_owner(&entry, epoch, false) {
                manager.lock()?.retire(&entry.lease_id);
                manager.detach_keyboard(&entry.label).await;
                manager.retry_cleanup(&app);
                return Err(error);
            }
            let current = child
                .url()
                .ok()
                .filter(|url| browser_url(url.as_str()).is_ok())
                .unwrap_or(entry.url);
            return Ok(BrowserSurfaceAttachment {
                lease_id: entry.lease_id,
                url: current.into(),
                zoom_percent: (entry.zoom * 100.0).round() as u16,
            });
        }
        manager.lock()?.tabs.remove(&tab_key);
        manager.discard_keyboard(&existing.label);
    }
    std::fs::create_dir_all(&manager.profile_directory)
        .map_err(|error| NativeError::io("the browser profile cannot be created", error))?;
    let entry = manager.lock()?.reserve(&tab_key, requested_url.clone())?;
    let navigation_manager = manager.inner().clone();
    let navigation_app = app.clone();
    let navigation_key = tab_key.clone();
    let navigation_label = entry.label.clone();
    let page_manager = manager.inner().clone();
    let page_key = tab_key.clone();
    let page_label = entry.label.clone();
    let title_manager = manager.inner().clone();
    let title_key = tab_key.clone();
    let title_label = entry.label.clone();
    let policy_app = app.clone();
    let policy_manager = manager.inner().clone();
    let policy_entry = entry.clone();
    let download_app = app.clone();
    let download_manager = manager.inner().clone();
    let download_entry = entry.clone();
    let builder = WebviewBuilder::new(&entry.label, WebviewUrl::External(requested_url))
        .data_directory(manager.profile_directory.clone())
        .focused(false)
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            let allowed = browser_url(url.as_str()).is_ok();
            if allowed {
                emit_navigation(
                    &navigation_manager,
                    &navigation_app,
                    &navigation_key,
                    &navigation_label,
                    url,
                    None,
                    Some(true),
                );
            }
            allowed
        })
        .on_new_window(move |url, _| {
            emit_policy_notice(
                &policy_manager,
                &policy_app,
                &policy_entry,
                "new-window-denied",
                Some(&url),
                None,
            );
            NewWindowResponse::Deny
        })
        .on_download(move |_, event| {
            match event {
                DownloadEvent::Requested { url, .. } => {
                    emit_policy_notice(
                        &download_manager,
                        &download_app,
                        &download_entry,
                        "download-denied",
                        Some(&url),
                        Some(false),
                    );
                }
                DownloadEvent::Finished { url, success, .. } => {
                    emit_policy_notice(
                        &download_manager,
                        &download_app,
                        &download_entry,
                        "download-finished",
                        Some(&url),
                        Some(success),
                    );
                }
                _ => {}
            }
            false
        })
        .on_page_load(move |surface, payload| {
            emit_navigation(
                &page_manager,
                surface.app_handle(),
                &page_key,
                &page_label,
                payload.url(),
                None,
                Some(payload.event() == PageLoadEvent::Started),
            );
        })
        .on_document_title_changed(move |surface, title| {
            if let Ok(url) = surface.url() {
                emit_navigation(
                    &title_manager,
                    surface.app_handle(),
                    &title_key,
                    &title_label,
                    &url,
                    Some(title),
                    None,
                );
            }
        });
    // Start outside the client region so an inactive tab cannot flash above a
    // dialog before the renderer has sent its visibility update.
    let child = match webview.window().add_child(
        builder,
        PhysicalPosition::new(-1_000_000, -1_000_000),
        PhysicalSize::new(1, 1),
    ) {
        Ok(child) => child,
        Err(_) => {
            manager.lock()?.release(&entry.lease_id);
            return Err(ui_error());
        }
    };
    if manager.lock()?.owned(&entry.lease_id).is_none() {
        manager.lock()?.closing.insert(entry.label.clone());
        let _ = manager.close_retired(&app, &entry.label);
        return Err(NativeError::new(
            "browser_surface_expired",
            "The browser host changed before this tab could attach",
        ));
    }
    if child
        .hide()
        .and_then(|_| child.set_bounds(bounds.rect()))
        .is_err()
    {
        manager.lock()?.retire(&entry.lease_id);
        manager.retry_cleanup(&app);
        return Err(ui_error());
    }
    #[cfg(windows)]
    {
        let keyboard = match BrowserKeyboardRegistration::install(
            &child,
            &entry.tab_key,
            &entry.lease_id,
            epoch,
        )
        .await
        {
            Ok(keyboard) => Arc::new(keyboard),
            Err(error) => {
                manager.lock()?.retire(&entry.lease_id);
                manager.lock()?.closing.insert(entry.label.clone());
                manager.retry_cleanup(&app);
                return Err(error);
            }
        };
        if let Err(error) = manager.register_keyboard(&entry, epoch, keyboard.clone()) {
            keyboard.invalidate();
            let _ = keyboard.detach().await;
            manager.lock()?.retire(&entry.lease_id);
            manager.lock()?.closing.insert(entry.label.clone());
            manager.retry_cleanup(&app);
            return Err(error);
        }
    }
    // Main can navigate while native controller registration is awaiting its UI
    // acknowledgment. Never publish that old document's attachment afterward.
    let current_attachment = manager.lock()?.attachment_is_current(&entry, epoch);
    if !current_attachment {
        manager.detach_keyboard(&entry.label).await;
        manager.lock()?.closing.insert(entry.label.clone());
        let _ = manager.close_retired(&app, &entry.label);
        return Err(expired_attachment());
    }
    Ok(BrowserSurfaceAttachment {
        lease_id: entry.lease_id,
        url: entry.url.into(),
        zoom_percent: (entry.zoom * 100.0).round() as u16,
    })
}

#[tauri::command]
pub async fn browser_surface_update(
    webview: Webview,
    manager: State<'_, BrowserSurfaceManager>,
    lease_id: String,
    bounds: BrowserSurfaceBounds,
    visible: bool,
) -> NativeResult<()> {
    require_local_caller(&webview)?;
    let _operation = manager.operations.lock().await;
    let Some(entry) = manager.lock()?.owned(&lease_id) else {
        return Ok(());
    };
    let epoch = manager.lock()?.epoch;
    let Some(child) = webview.app_handle().get_webview(&entry.label) else {
        manager.discard_keyboard(&entry.label);
        return Err(ui_error());
    };
    if !visible {
        manager.keyboard_set_owner(&entry, epoch, false)?;
        let return_focus = manager.lock()?.begin_hide(&entry.lease_id);
        let (result, returned) = retire_visual(
            return_focus,
            || child.hide().map_err(|_| ui_error()),
            || webview.set_focus().map_err(|_| ui_error()),
        );
        manager
            .lock()?
            .finish_focus_return(&entry.lease_id, returned);
        return result;
    }
    let bounds = measured_bounds(&webview, bounds)?;
    let others = manager
        .lock()?
        .tabs
        .values()
        .filter(|other| other.visible && other.lease_id != lease_id)
        .cloned()
        .collect::<Vec<_>>();
    for other in others {
        manager.keyboard_set_owner(&other, epoch, false)?;
        if let Some(record) = manager.lock()?.tabs.get_mut(&other.tab_key) {
            record.visible = false;
        }
        if let Some(surface) = webview.app_handle().get_webview(&other.label) {
            surface.hide().map_err(|_| ui_error())?;
        }
    }
    if child
        .set_bounds(bounds.rect())
        .and_then(|_| child.show())
        .is_err()
    {
        let _ = manager.keyboard_set_owner(&entry, epoch, false);
        let _ = child.hide();
        if let Some(record) = manager.lock()?.tabs.get_mut(&entry.tab_key) {
            record.visible = false;
        }
        return Err(ui_error());
    }
    if !manager.lock()?.attachment_is_current(&entry, epoch) {
        let _ = manager.keyboard_set_owner(&entry, epoch, false);
        let _ = child.hide();
        return Ok(());
    }
    if let Err(error) = manager.keyboard_set_owner(&entry, epoch, true) {
        let _ = child.hide();
        if let Some(record) = manager.lock()?.tabs.get_mut(&entry.tab_key) {
            record.visible = false;
        }
        return Err(error);
    }
    if let Some(record) = manager.lock()?.tabs.get_mut(&entry.tab_key) {
        record.visible = true;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_surface_navigate(
    webview: Webview,
    manager: State<'_, BrowserSurfaceManager>,
    lease_id: String,
    url: String,
) -> NativeResult<()> {
    require_local_caller(&webview)?;
    let url = browser_url(&url)?;
    let _operation = manager.operations.lock().await;
    let entry = manager.owned(&lease_id)?;
    let child = webview
        .app_handle()
        .get_webview(&entry.label)
        .ok_or_else(ui_error)?;
    child.navigate(url).map_err(|_| ui_error())
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserSurfaceAction {
    Back,
    Forward,
    Reload,
    Focus,
    Devtools,
    #[serde(rename = "zoom-in")]
    ZoomIn,
    #[serde(rename = "zoom-out")]
    ZoomOut,
    #[serde(rename = "zoom-reset")]
    ZoomReset,
}

#[tauri::command]
pub async fn browser_surface_action(
    webview: Webview,
    manager: State<'_, BrowserSurfaceManager>,
    lease_id: String,
    action: BrowserSurfaceAction,
) -> NativeResult<()> {
    require_local_caller(&webview)?;
    let _operation = manager.operations.lock().await;
    let entry = manager.owned(&lease_id)?;
    let child = webview
        .app_handle()
        .get_webview(&entry.label)
        .ok_or_else(ui_error)?;
    match action {
        // These are closed, native-owned scripts. No renderer/page string is evaluated.
        BrowserSurfaceAction::Back => child.eval("window.history.back()"),
        BrowserSurfaceAction::Forward => child.eval("window.history.forward()"),
        BrowserSurfaceAction::Reload => child.reload(),
        BrowserSurfaceAction::Focus if entry.visible => child.set_focus(),
        BrowserSurfaceAction::Focus => {
            return Err(NativeError::new(
                "browser_surface_hidden",
                "Select this tab before focusing its page",
            ))
        }
        BrowserSurfaceAction::Devtools => {
            if !entry.visible {
                return Err(NativeError::new(
                    "browser_surface_hidden",
                    "Select this tab before inspecting its page",
                ));
            }
            #[cfg(debug_assertions)]
            {
                child.open_devtools();
                return Ok(());
            }
            #[cfg(not(debug_assertions))]
            {
                return Err(NativeError::new(
                    "browser_devtools_unavailable",
                    "Native developer tools are unavailable in this build",
                ));
            }
        }
        BrowserSurfaceAction::ZoomIn
        | BrowserSurfaceAction::ZoomOut
        | BrowserSurfaceAction::ZoomReset => {
            let (previous, next) = {
                let mut state = manager.lock()?;
                let record = state
                    .tabs
                    .get_mut(&entry.tab_key)
                    .filter(|record| record.lease_id == entry.lease_id)
                    .ok_or_else(expired_attachment)?;
                let previous = record.zoom;
                let next = next_zoom(previous, action);
                record.zoom = next;
                (previous, next)
            };
            if child.set_zoom(next).is_err() {
                if let Ok(mut state) = manager.lock() {
                    if let Some(record) = state
                        .tabs
                        .get_mut(&entry.tab_key)
                        .filter(|record| record.lease_id == entry.lease_id)
                    {
                        record.zoom = previous;
                    }
                }
                return Err(ui_error());
            }
            if let Ok(url) = child.url() {
                emit_navigation(
                    &manager,
                    webview.app_handle(),
                    &entry.tab_key,
                    &entry.label,
                    &url,
                    None,
                    None,
                );
            }
            return Ok(());
        }
    }
    .map_err(|_| ui_error())
}

fn next_zoom(previous: f64, action: BrowserSurfaceAction) -> f64 {
    let previous_percent = (previous * 100.0).round();
    let percent = match action {
        BrowserSurfaceAction::ZoomIn => (previous_percent + 10.0).min(500.0),
        BrowserSurfaceAction::ZoomOut => (previous_percent - 10.0).max(25.0),
        BrowserSurfaceAction::ZoomReset => 100.0,
        _ => previous_percent,
    };
    percent / 100.0
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserCaptureMode {
    Page,
    Selection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserCaptureProjection {
    title: String,
    page_text: String,
    selection_text: String,
    page_truncated: bool,
    selection_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureReceipt {
    receipt_id: String,
    tab_key: String,
    lease_id: String,
    url: String,
    title: String,
    mode: BrowserCaptureMode,
    text: String,
    content_sha256: String,
    byte_size: usize,
    truncated: bool,
    captured_at_ms: i64,
    source: &'static str,
}

const MAX_CAPTURE_BYTES: usize = 256 * 1024;
// A closed native-owned script. No renderer/page string is executed. Reading
// DOM text is an explicit local-user action; remote documents still have no IPC.
const CAPTURE_SCRIPT: &str = r#"(() => {
  const limit = 262144;
  const page = document.body ? document.body.innerText : '';
  const selected = window.getSelection ? String(window.getSelection()) : '';
  return { title: String(document.title).slice(0, 512), pageText: page.slice(0, limit),
    selectionText: selected.slice(0, limit), pageTruncated: page.length > limit,
    selectionTruncated: selected.length > limit };
})()"#;

fn capture_text(
    projection: BrowserCaptureProjection,
    mode: BrowserCaptureMode,
) -> (String, String, bool) {
    let (mut text, mut truncated) = match mode {
        BrowserCaptureMode::Page => (projection.page_text, projection.page_truncated),
        BrowserCaptureMode::Selection => {
            (projection.selection_text, projection.selection_truncated)
        }
    };
    if text.len() > MAX_CAPTURE_BYTES {
        let mut end = MAX_CAPTURE_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        truncated = true;
    }
    let title = projection
        .title
        .chars()
        .filter(|character| !character.is_control())
        .take(512)
        .collect();
    (title, text, truncated)
}

#[tauri::command]
pub async fn browser_surface_capture(
    webview: Webview,
    manager: State<'_, BrowserSurfaceManager>,
    lease_id: String,
    mode: BrowserCaptureMode,
) -> NativeResult<BrowserCaptureReceipt> {
    require_local_caller(&webview)?;
    let _operation = manager.operations.lock().await;
    let entry = manager.owned(&lease_id)?;
    if !entry.visible {
        return Err(NativeError::new(
            "browser_surface_hidden",
            "Select this tab before capturing page text",
        ));
    }
    let epoch = manager.lock()?.epoch;
    let child = webview
        .app_handle()
        .get_webview(&entry.label)
        .ok_or_else(ui_error)?;
    let before_url = child.url().map_err(|_| ui_error())?;
    browser_url(before_url.as_str())?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Mutex::new(Some(sender));
    child
        .eval_with_callback(CAPTURE_SCRIPT, move |result| {
            if let Ok(mut sender) = sender.lock() {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(result);
                }
            }
        })
        .map_err(|_| ui_error())?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), receiver)
        .await
        .map_err(|_| {
            NativeError::new(
                "browser_capture_timeout",
                "The page did not answer the text capture request",
            )
        })?
        .map_err(|_| ui_error())?;
    // A navigation/release/renderer reload can race the callback. Never attach
    // that result to the replacement document or to an obsolete lease.
    if !manager.lock()?.attachment_is_current(&entry, epoch)
        || !manager.owned(&lease_id)?.visible
        || child.url().map_err(|_| ui_error())? != before_url
    {
        return Err(NativeError::new(
            "browser_capture_stale",
            "The browser page changed during text capture; retry on the current page",
        ));
    }
    if result.len() > MAX_CAPTURE_BYTES * 16 {
        return Err(NativeError::new(
            "browser_capture_invalid",
            "The page returned an oversized text capture",
        ));
    }
    let projection: BrowserCaptureProjection = serde_json::from_str(&result).map_err(|_| {
        NativeError::new(
            "browser_capture_invalid",
            "The page did not return a valid text capture",
        )
    })?;
    let (title, text, truncated) = capture_text(projection, mode);
    let byte_size = text.len();
    let content_sha256 = format!("{:x}", Sha256::digest(text.as_bytes()));
    Ok(BrowserCaptureReceipt {
        receipt_id: format!("browser_capture_{}", uuid::Uuid::new_v4().simple()),
        tab_key: entry.tab_key,
        lease_id,
        url: before_url.into(),
        title,
        mode,
        text,
        content_sha256,
        byte_size,
        truncated,
        captured_at_ms: crate::storage::now_ms(),
        source: "native-dom-text",
    })
}

#[tauri::command]
pub async fn browser_surface_release(
    webview: Webview,
    manager: State<'_, BrowserSurfaceManager>,
    lease_id: String,
) -> NativeResult<()> {
    require_local_caller(&webview)?;
    let _operation = manager.operations.lock().await;
    let retiring = manager.lock()?.retire(&lease_id);
    let Some(entry) = retiring else {
        manager.retry_cleanup(webview.app_handle());
        return Ok(());
    };
    // Invalidating the registration is synchronous, before a hide or close can
    // pump controller callbacks. Native token removal can finish afterward.
    #[cfg(windows)]
    let keyboard = manager.take_keyboard(&entry.label);
    retire_before_detach(
        || {
            let (result, _) = retire_visual(
                entry.visible || entry.focus_return_pending,
                || manager.close_retired(webview.app_handle(), &entry.label),
                || webview.set_focus().map_err(|_| ui_error()),
            );
            drop(_operation);
            result
        },
        async {
            #[cfg(windows)]
            if let Some(keyboard) = keyboard {
                let _ = keyboard.detach().await;
            }
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_hide_still_returns_focus_and_does_not_repeat_a_successful_handoff() {
        let mut state = SurfaceState::default();
        let entry = state
            .reserve("tab", browser_url("https://example.com").unwrap())
            .unwrap();
        state.tabs.get_mut("tab").unwrap().visible = true;
        let needs_focus = state.begin_hide(&entry.lease_id);
        assert!(needs_focus);
        assert!(!state.owned(&entry.lease_id).unwrap().visible);
        let focus_calls = std::cell::Cell::new(0);
        let (result, returned) = retire_visual(
            needs_focus,
            || Err(ui_error()),
            || {
                focus_calls.set(focus_calls.get() + 1);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(focus_calls.get(), 1);
        state.finish_focus_return(&entry.lease_id, returned);
        let retired = state.retire(&entry.lease_id).unwrap();
        assert!(!retired.visible && !retired.focus_return_pending);
    }

    #[test]
    fn failed_hide_and_focus_keep_release_handoff_and_failed_close_cleanup() {
        let mut state = SurfaceState::default();
        let entry = state
            .reserve("tab", browser_url("https://example.com").unwrap())
            .unwrap();
        state.tabs.get_mut("tab").unwrap().visible = true;
        let needs_focus = state.begin_hide(&entry.lease_id);
        let (result, returned) = retire_visual(needs_focus, || Err(ui_error()), || Err(ui_error()));
        assert!(result.is_err());
        assert!(!returned);
        state.finish_focus_return(&entry.lease_id, returned);
        let retired = state.retire(&entry.lease_id).unwrap();
        assert!(!retired.visible);
        assert!(retired.focus_return_pending);
        assert!(state.owned(&entry.lease_id).is_none());
        let focus_called = std::cell::Cell::new(false);
        let (result, returned) = retire_visual(
            retired.visible || retired.focus_return_pending,
            || {
                state.finish_close(&retired.label, false);
                Err(ui_error())
            },
            || {
                focus_called.set(true);
                Err(ui_error())
            },
        );
        assert!(result.is_err());
        assert!(!returned);
        assert!(focus_called.get());
        assert!(state.closing.contains(&retired.label));
    }

    #[test]
    fn hidden_release_never_claims_a_focus_handoff() {
        let (result, returned) = retire_visual(
            false,
            || Ok(()),
            || panic!("hidden page must not take focus"),
        );
        assert!(result.is_ok());
        assert!(!returned);
    }

    #[tokio::test]
    async fn visual_retirement_and_unlock_precede_a_pending_detach_acknowledgement() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let retired = Arc::new(AtomicBool::new(false));
        let unlocked = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let retired_copy = retired.clone();
        let unlocked_copy = unlocked.clone();
        let task = tokio::spawn(retire_before_detach(
            move || {
                let (result, _) = retire_visual(
                    true,
                    || {
                        retired_copy.store(true, Ordering::Release);
                        Err(ui_error())
                    },
                    || Ok(()),
                );
                unlocked_copy.store(true, Ordering::Release);
                result
            },
            async move {
                let _ = started_tx.send(());
                let _ = finish_rx.await;
            },
        ));
        started_rx.await.unwrap();
        assert!(retired.load(Ordering::Acquire));
        assert!(unlocked.load(Ordering::Acquire));
        assert!(!task.is_finished());
        finish_tx.send(()).unwrap();
        assert!(
            task.await.unwrap().is_err(),
            "visual failure survives successful late detach"
        );
    }

    #[test]
    fn stale_hide_completion_cannot_clear_a_replacement_lease_obligation() {
        let mut state = SurfaceState::default();
        let first = state
            .reserve("tab", browser_url("https://example.com").unwrap())
            .unwrap();
        state.tabs.get_mut("tab").unwrap().visible = true;
        state.begin_hide(&first.lease_id);
        let replacement = state.reassign("tab").unwrap();
        state.finish_focus_return(&first.lease_id, true);
        assert!(
            state
                .owned(&replacement.lease_id)
                .unwrap()
                .focus_return_pending
        );
    }

    #[test]
    fn keyboard_registration_requires_the_exact_controller_lease_and_epoch() {
        let mut state = SurfaceState::default();
        let previous = state
            .reserve("tab", browser_url("https://example.com").unwrap())
            .unwrap();
        let epoch = state.epoch;
        assert!(state.attachment_is_current(&previous, epoch));
        assert!(!state.attachment_is_current(&previous, epoch.wrapping_add(1)));
        let mut wrong_controller = previous.clone();
        wrong_controller.label = "omnia-browser-different-controller".into();
        assert!(!state.attachment_is_current(&wrong_controller, epoch));
        let current = state.reassign("tab").unwrap();
        assert!(!state.attachment_is_current(&previous, epoch));
        assert!(state.attachment_is_current(&current, epoch));
    }

    #[test]
    fn late_keyboard_registration_cannot_reactivate_a_retired_or_previous_main_document() {
        let mut state = SurfaceState::default();
        let retired = state
            .reserve("retired", browser_url("https://example.com").unwrap())
            .unwrap();
        let epoch = state.epoch;
        state.retire(&retired.lease_id);
        assert!(!state.attachment_is_current(&retired, epoch));
        let late = state
            .reserve("late", browser_url("https://example.com").unwrap())
            .unwrap();
        state.invalidate();
        assert!(!state.attachment_is_current(&late, epoch));
        assert!(!state.attachment_is_current(&late, state.epoch));
        assert!(state.closing.contains(&late.label));
    }

    #[test]
    fn only_ordinary_remote_navigation_is_supported() {
        for raw in [
            "https://example.com/page?q=one#two",
            "http://example.org/",
            "https://example.com:8443/path",
        ] {
            assert!(browser_url(raw).is_ok(), "{raw}");
        }
        for raw in [
            "about:blank",
            "file:///C:/secret",
            "javascript:alert(1)",
            "data:text/html,no",
            "chrome://settings/",
            "tauri://localhost/",
            "http://tauri.localhost/",
            "http://ipc.localhost/",
            "http://asset.localhost/",
            "http://omnia-artifact.localhost/",
            "http://localhost:5173/",
            "http://LOCALHOST./",
            "http://127.0.0.1:1430/",
            "http://127.2.3.4:9222/",
            "http://0.0.0.0/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::]/",
            "https://user:secret@example.com/",
        ] {
            assert!(browser_url(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn navigation_input_is_bounded() {
        assert!(browser_url(&format!(
            "https://example.com/?q={}",
            "x".repeat(MAX_URL_BYTES)
        ))
        .is_err());
    }

    #[test]
    fn native_zoom_is_clamped_and_uses_ten_percent_steps() {
        assert_eq!(next_zoom(1.0, BrowserSurfaceAction::ZoomIn), 1.1);
        assert_eq!(next_zoom(1.0, BrowserSurfaceAction::ZoomOut), 0.9);
        assert_eq!(next_zoom(4.99, BrowserSurfaceAction::ZoomIn), 5.0);
        assert_eq!(next_zoom(0.26, BrowserSurfaceAction::ZoomOut), 0.25);
        assert_eq!(next_zoom(2.75, BrowserSurfaceAction::ZoomReset), 1.0);
    }

    #[test]
    fn native_capture_projection_is_bounded_and_hash_ready() {
        let (title, text, truncated) = capture_text(
            BrowserCaptureProjection {
                title: "Example\u{0000} title".into(),
                page_text: "x".repeat(MAX_CAPTURE_BYTES + 32),
                selection_text: "selection".into(),
                page_truncated: true,
                selection_truncated: false,
            },
            BrowserCaptureMode::Page,
        );
        assert_eq!(title, "Example title");
        assert_eq!(text.len(), MAX_CAPTURE_BYTES);
        assert!(truncated);
        assert_eq!(format!("{:x}", Sha256::digest(text.as_bytes())).len(), 64);
        let (_, selection, selection_truncated) = capture_text(
            BrowserCaptureProjection {
                title: "Selection".into(),
                page_text: "ignored".into(),
                selection_text: "selection".into(),
                page_truncated: false,
                selection_truncated: false,
            },
            BrowserCaptureMode::Selection,
        );
        assert_eq!(selection, "selection");
        assert!(!selection_truncated);
    }

    #[test]
    fn only_main_local_webview_can_manage_surfaces() {
        for raw in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
        ] {
            let url = url::Url::parse(raw).unwrap();
            assert!(allowed_local_caller("main", &url));
            assert!(!allowed_local_caller("omnia-browser-owned", &url));
        }
        for raw in [
            "https://example.com/",
            "http://tauri.localhost:1430/",
            "http://tauri.localhost.example.com/",
            "https://user:secret@tauri.localhost/",
            "http://127.0.0.1:1430/",
        ] {
            assert!(
                !allowed_local_caller("main", &url::Url::parse(raw).unwrap()),
                "{raw}"
            );
        }
    }

    #[test]
    fn renderer_tab_keys_never_become_webview_labels_or_paths() {
        assert!(valid_tab_key("browser-tab_123"));
        for key in ["", "../main", "x:y", "a b", "ê", &"x".repeat(129)] {
            assert!(!valid_tab_key(key));
        }
        let mut state = SurfaceState::default();
        let entry = state
            .reserve("main", browser_url("https://example.com").unwrap())
            .unwrap();
        assert!(entry.label.starts_with("omnia-browser-"));
        assert_ne!(entry.label, "main");
        assert_ne!(entry.lease_id, entry.tab_key);
    }

    #[test]
    fn replacement_lease_ignores_stale_updates_and_release() {
        let mut state = SurfaceState::default();
        let first = state
            .reserve("tab", browser_url("https://example.com").unwrap())
            .unwrap();
        let second = state.reassign("tab").unwrap();
        assert_eq!(second.label, first.label);
        assert_eq!(second.url, first.url);
        assert_ne!(second.lease_id, first.lease_id);
        assert!(state.owned(&first.lease_id).is_none());
        assert!(state.release(&first.lease_id).is_none());
        assert_eq!(state.tabs.len(), 1);
        assert!(state.release(&second.lease_id).is_some());
        assert!(state.tabs.is_empty());
    }

    #[test]
    fn failed_native_reattach_does_not_commit_an_undisclosed_lease() {
        let mut state = SurfaceState::default();
        let previous = state
            .reserve("tab", browser_url("https://example.com").unwrap())
            .unwrap();
        let failed = state.commit_reattach(&previous, Err(ui_error()));
        assert!(failed.is_err());
        assert!(state.owned(&previous.lease_id).is_none());
        assert!(state.tabs.is_empty());
        assert!(state.closing.contains(&previous.label));
        state.finish_close(&previous.label, true);
        let retry = state
            .reserve("tab", browser_url("https://example.com").unwrap())
            .unwrap();
        assert!(state.owned(&retry.lease_id).is_some());
        assert_ne!(previous.lease_id, retry.lease_id);
    }

    #[test]
    fn successful_reattach_commits_only_the_current_prepared_host() {
        let mut state = SurfaceState::default();
        let previous = state
            .reserve("tab", browser_url("https://example.com").unwrap())
            .unwrap();
        let current = state.commit_reattach(&previous, Ok(())).unwrap();
        assert_eq!(previous.label, current.label);
        assert_ne!(previous.lease_id, current.lease_id);
        assert!(state.commit_reattach(&previous, Ok(())).is_err());
        assert!(state.owned(&current.lease_id).is_some());
        state.invalidate();
        assert!(state.commit_reattach(&current, Ok(())).is_err());
        assert!(state.tabs.is_empty());
    }

    #[test]
    fn failed_close_retires_lease_but_retains_bounded_native_cleanup() {
        let mut state = SurfaceState::default();
        let previous = state
            .reserve("tab", browser_url("https://example.com").unwrap())
            .unwrap();
        state.retire(&previous.lease_id).unwrap();
        state.finish_close(&previous.label, false);
        assert!(state.owned(&previous.lease_id).is_none());
        assert!(state.tabs.is_empty());
        assert!(state.closing.contains(&previous.label));
        assert!(state.retire(&previous.lease_id).is_none());
        for i in 1..MAX_TABS {
            state
                .reserve(
                    &format!("tab-{i}"),
                    browser_url("https://example.com").unwrap(),
                )
                .unwrap();
        }
        assert!(state
            .reserve("overflow", browser_url("https://example.com").unwrap())
            .is_err());
        state.finish_close(&previous.label, true);
        assert!(state.closing.is_empty());
        assert!(state
            .reserve("retry", browser_url("https://example.com").unwrap())
            .is_ok());
    }

    #[test]
    fn main_navigation_retains_failed_cleanup_for_subsequent_retry() {
        let mut state = SurfaceState::default();
        let previous = state
            .reserve("tab", browser_url("https://example.com").unwrap())
            .unwrap();
        state.retire(&previous.lease_id).unwrap();
        assert_eq!(state.invalidate(), vec![previous.label.clone()]);
        state.finish_close(&previous.label, false);
        assert_eq!(state.invalidate(), vec![previous.label.clone()]);
        state.finish_close(&previous.label, true);
        assert!(state.invalidate().is_empty());
    }

    #[test]
    fn main_document_navigation_invalidates_leases_and_inflight_epoch() {
        let mut state = SurfaceState::default();
        let entry = state
            .reserve("tab", browser_url("https://example.com").unwrap())
            .unwrap();
        let epoch = state.epoch;
        let removed = state.invalidate();
        assert_eq!(removed.len(), 1);
        assert_ne!(state.epoch, epoch);
        assert!(state.owned(&entry.lease_id).is_none());
        assert!(state.tabs.is_empty());
    }

    #[test]
    fn live_tabs_have_distinct_native_leases_and_bounded_capacity() {
        let mut state = SurfaceState::default();
        for i in 0..MAX_TABS {
            let entry = state
                .reserve(
                    &format!("tab-{i}"),
                    browser_url("https://example.com").unwrap(),
                )
                .unwrap();
            assert!(!entry.visible);
            assert_eq!(entry.lease_id.len(), 32);
        }
        assert_eq!(state.tabs.len(), MAX_TABS);
        assert!(state
            .reserve("extra", browser_url("https://example.com").unwrap())
            .is_err());
        let leases = state
            .tabs
            .values()
            .map(|entry| &entry.lease_id)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(leases.len(), MAX_TABS);
    }

    #[test]
    fn physical_bounds_are_clipped_to_the_main_client_region() {
        assert_eq!(
            clip_bounds(
                BrowserSurfaceBounds {
                    x: -20.0,
                    y: 10.0,
                    width: 100.0,
                    height: 1000.0
                },
                800,
                600
            )
            .unwrap(),
            ClippedBounds {
                x: 0,
                y: 10,
                width: 80,
                height: 590
            }
        );
        assert_eq!(
            clip_bounds(
                BrowserSurfaceBounds {
                    x: 700.0,
                    y: 500.0,
                    width: 300.0,
                    height: 300.0
                },
                800,
                600
            )
            .unwrap(),
            ClippedBounds {
                x: 700,
                y: 500,
                width: 100,
                height: 100
            }
        );
    }

    #[test]
    fn invalid_or_invisible_geometry_is_rejected() {
        for bounds in [
            BrowserSurfaceBounds {
                x: f64::NAN,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            BrowserSurfaceBounds {
                x: 0.0,
                y: 0.0,
                width: f64::INFINITY,
                height: 100.0,
            },
            BrowserSurfaceBounds {
                x: 0.0,
                y: 0.0,
                width: -1.0,
                height: 100.0,
            },
            BrowserSurfaceBounds {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 100.0,
            },
            BrowserSurfaceBounds {
                x: 0.0,
                y: 0.0,
                width: 1_000_001.0,
                height: 100.0,
            },
            BrowserSurfaceBounds {
                x: 900.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
        ] {
            assert!(clip_bounds(bounds, 800, 600).is_err());
        }
        assert!(clip_bounds(
            BrowserSurfaceBounds {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0
            },
            0,
            600
        )
        .is_err());
    }

    #[test]
    fn action_deserialization_is_a_closed_whitelist() {
        for action in [
            "back",
            "forward",
            "reload",
            "focus",
            "devtools",
            "zoom-in",
            "zoom-out",
            "zoom-reset",
        ] {
            assert!(
                serde_json::from_value::<BrowserSurfaceAction>(serde_json::json!(action)).is_ok()
            );
        }
        for action in ["eval", "execute", "navigate", "Back", "devTools", ""] {
            assert!(
                serde_json::from_value::<BrowserSurfaceAction>(serde_json::json!(action)).is_err()
            );
        }
    }

    #[test]
    fn policy_receipt_reasons_match_the_observed_boundary_event() {
        assert_eq!(
            policy_reason("new-window-denied"),
            "New windows are managed as Omnia browser tabs."
        );
        assert_eq!(
            policy_reason("download-denied"),
            "Downloads require an explicit Omnia download approval."
        );
        assert_eq!(
            policy_reason("download-finished"),
            "The native browser reported the download result."
        );
        assert_eq!(
            policy_reason("unknown"),
            "The browser capability was denied by native policy."
        );
    }
}
