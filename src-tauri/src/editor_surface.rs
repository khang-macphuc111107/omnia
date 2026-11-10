//! A token-authenticated top-level child WebView for the installed editor.
//!
//! Native children are above DOM overlays. The renderer must hide the leased
//! surface before displaying a dialog or leaving its measured editor host.

use std::{path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{
    webview::NewWindowResponse, AppHandle, Manager, PhysicalPosition, PhysicalSize, Rect, State,
    Webview, WebviewBuilder, WebviewUrl,
};

use crate::{
    editor_server::{require_local_editor_caller, EditorServerManager},
    error::{NativeError, NativeResult},
};

pub(crate) const EDITOR_SURFACE_LABEL: &str = "omnia-editor";
const MAX_GEOMETRY: f64 = 100_000.0;

pub(crate) fn deny_editor_invokes(
    handler: impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    move |invoke| {
        // Remote content never negotiates an application session, even if a
        // future capability accidentally includes this native child's origin.
        if invoke.message.webview_ref().label() == EDITOR_SURFACE_LABEL {
            invoke.resolver.reject(NativeError::new(
                "editor_caller_denied",
                "The editor document cannot invoke Omnia application commands",
            ));
            return true;
        }
        handler(invoke)
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditorSurfaceBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ClippedBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl ClippedBounds {
    fn has_area(self) -> bool {
        self.width != 0 && self.height != 0
    }

    fn rect(self) -> Rect {
        Rect {
            position: PhysicalPosition::new(self.x, self.y).into(),
            size: PhysicalSize::new(self.width, self.height).into(),
        }
    }
}

impl EditorSurfaceBounds {
    fn clip(self, client: PhysicalSize<u32>) -> NativeResult<ClippedBounds> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|value| !value.is_finite() || value.abs() > MAX_GEOMETRY)
            || self.width < 0.0
            || self.height < 0.0
        {
            return Err(NativeError::invalid(
                "bounds",
                "must contain finite bounded physical coordinates and nonnegative sizes",
            ));
        }
        let left = self.x.round().clamp(0.0, client.width as f64);
        let top = self.y.round().clamp(0.0, client.height as f64);
        let right = (self.x + self.width)
            .round()
            .clamp(left, client.width as f64);
        let bottom = (self.y + self.height)
            .round()
            .clamp(top, client.height as f64);
        Ok(ClippedBounds {
            x: left as i32,
            y: top as i32,
            width: (right - left) as u32,
            height: (bottom - top) as u32,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSurfaceLease {
    lease_id: String,
}

#[derive(Default)]
struct SurfaceState {
    lease_id: Option<String>,
    attaching: Option<String>,
    document_key: Option<String>,
    visible: bool,
    stopped: bool,
    epoch: u64,
    cleanup_needed: bool,
}

#[derive(Debug)]
struct Attachment {
    lease_id: String,
    previous_document: Option<String>,
    epoch: u64,
}

impl SurfaceState {
    fn reserve(&mut self) -> NativeResult<Attachment> {
        if self.stopped {
            return Err(NativeError::new(
                "editor_surface_stopped",
                "The editor surface stopped with its application window",
            ));
        }
        if self.attaching.is_some() {
            return Err(NativeError::retryable(
                "editor_surface_busy",
                "The editor surface is connecting. Retry the current connection",
            ));
        }
        let lease_id = uuid::Uuid::new_v4().simple().to_string();
        self.attaching = Some(lease_id.clone());
        self.lease_id = None;
        self.visible = false;
        Ok(Attachment {
            lease_id,
            previous_document: self.document_key.clone(),
            epoch: self.epoch,
        })
    }

    fn finish(&mut self, attachment: &Attachment, document_key: String) -> bool {
        if self.stopped
            || self.cleanup_needed
            || self.epoch != attachment.epoch
            || self.attaching.as_deref() != Some(&attachment.lease_id)
        {
            return false;
        }
        self.attaching = None;
        self.lease_id = Some(attachment.lease_id.clone());
        self.document_key = Some(document_key);
        self.visible = false;
        self.cleanup_needed = false;
        true
    }

    fn failed(&mut self, attachment: &Attachment) {
        if self.attaching.as_deref() == Some(&attachment.lease_id) {
            self.attaching = None;
            self.lease_id = None;
            self.visible = false;
            // A failed resize/show may follow a successful navigation. Never
            // reuse the previous document key for that now-unknown child.
            self.document_key = None;
            self.cleanup_needed = true;
        }
    }

    fn owns(&self, lease_id: &str) -> bool {
        !self.stopped && self.attaching.is_none() && self.lease_id.as_deref() == Some(lease_id)
    }

    fn release_with<H, C, F>(
        &mut self,
        lease_id: &str,
        hide: H,
        close: C,
        focus_main: F,
    ) -> NativeResult<()>
    where
        H: FnOnce() -> Result<(), ()>,
        C: FnOnce() -> Result<(), ()>,
        F: FnOnce() -> Result<(), ()>,
    {
        if !self.owns(lease_id) {
            return Ok(());
        }
        let was_visible = self.visible;
        // Logical retirement cannot depend on native UI operations succeeding:
        // the renderer intentionally ignores release errors during cleanup.
        self.lease_id = None;
        self.visible = false;

        let hide_failed = hide().is_err();
        if hide_failed {
            self.document_key = None;
            // A hidden child can be reused. A child whose visibility is unknown
            // must be closed; if close also fails, retain this cleanup obligation
            // and refuse reuse until a later attachment completes it.
            self.cleanup_needed = close().is_err();
        }
        // Return focus even if hiding failed; do not short-circuit cleanup.
        let focus_failed = was_visible && focus_main().is_err();
        if hide_failed || focus_failed {
            Err(surface_operation_failed())
        } else {
            Ok(())
        }
    }

    fn clean_orphan<C>(&mut self, close: C) -> NativeResult<()>
    where
        C: FnOnce() -> Result<(), ()>,
    {
        if self.cleanup_needed {
            close().map_err(|_| surface_operation_failed())?;
            self.cleanup_needed = false;
            self.document_key = None;
        }
        Ok(())
    }

    fn invalidate(&mut self) {
        self.lease_id = None;
        self.visible = false;
        self.epoch = self.epoch.wrapping_add(1);
    }
}

pub struct EditorSurfaceManager {
    inner: Mutex<SurfaceState>,
    data_directory: PathBuf,
}

impl EditorSurfaceManager {
    pub fn new(app_data: &std::path::Path) -> Self {
        Self {
            inner: Mutex::new(SurfaceState::default()),
            data_directory: app_data.join("editor").join("webview"),
        }
    }

    fn lock(&self) -> NativeResult<std::sync::MutexGuard<'_, SurfaceState>> {
        self.inner.lock().map_err(|_| {
            NativeError::new(
                "editor_surface_failed",
                "The editor surface state is unavailable",
            )
        })
    }

    fn begin_attachment(&self, main: &Webview) -> NativeResult<Attachment> {
        let attachment = {
            let mut state = self.lock()?;
            let attachment = state.reserve()?;
            let child = main.app_handle().get_webview(EDITOR_SURFACE_LABEL);
            if let Err(error) = state.clean_orphan(|| match child {
                Some(child) => child.close().map_err(|_| ()),
                None => Ok(()),
            }) {
                state.failed(&attachment);
                return Err(error);
            }
            attachment
        };
        if let Some(child) = main.app_handle().get_webview(EDITOR_SURFACE_LABEL) {
            if child.hide().is_err() {
                self.lock()?.failed(&attachment);
                return Err(surface_operation_failed());
            }
        }
        Ok(attachment)
    }

    fn attach(
        &self,
        main: &Webview,
        attachment: Attachment,
        url: url::Url,
        document_key: String,
        bounds: ClippedBounds,
        reconnect: bool,
    ) -> NativeResult<EditorSurfaceLease> {
        {
            let mut state = self.lock()?;
            if state.stopped || state.epoch != attachment.epoch {
                state.failed(&attachment);
                return Err(NativeError::retryable(
                    "editor_surface_superseded",
                    "The editor host changed while connecting. Retry the current connection",
                ));
            }
        }
        // No state lock is held while add_child schedules work on the main
        // thread. Other attach calls fail retryably during this reservation,
        // and previous leases cannot issue native operations meanwhile.
        let result = self.attach_reserved(main, &attachment, url, &document_key, bounds, reconnect);
        match result {
            Ok(child) => {
                let mut state = self.lock()?;
                if state.finish(&attachment, document_key) {
                    Ok(EditorSurfaceLease {
                        lease_id: attachment.lease_id,
                    })
                } else {
                    let _ = child.hide();
                    state.failed(&attachment);
                    Err(NativeError::retryable(
                        "editor_surface_superseded",
                        "The editor host changed while connecting. Retry the current connection",
                    ))
                }
            }
            Err(error) => {
                self.lock()?.failed(&attachment);
                Err(error)
            }
        }
    }

    fn attach_reserved(
        &self,
        main: &Webview,
        attachment: &Attachment,
        url: url::Url,
        document_key: &str,
        bounds: ClippedBounds,
        reconnect: bool,
    ) -> NativeResult<Webview> {
        let app = main.app_handle();
        let child = if let Some(child) = app.get_webview(EDITOR_SURFACE_LABEL) {
            child.hide().map_err(|_| surface_operation_failed())?;
            if reconnect || attachment.previous_document.as_deref() != Some(document_key) {
                child
                    .navigate(url)
                    .map_err(|_| surface_operation_failed())?;
            }
            child
        } else {
            std::fs::create_dir_all(&self.data_directory)
                .map_err(|_| surface_operation_failed())?;
            let builder = WebviewBuilder::new(EDITOR_SURFACE_LABEL, WebviewUrl::External(url))
                .focused(false)
                .disable_drag_drop_handler()
                .data_directory(self.data_directory.clone())
                .on_navigation(allowed_editor_navigation)
                .on_new_window(|_, _| NewWindowResponse::Deny);
            // Zero-sized initial bounds prevent a native child flashing over
            // an HTML overlay before the renderer has accepted its lease.
            let child = main
                .window()
                .add_child(
                    builder,
                    PhysicalPosition::new(0, 0),
                    PhysicalSize::new(0, 0),
                )
                .map_err(|_| surface_operation_failed())?;
            child.hide().map_err(|_| surface_operation_failed())?;
            child
        };
        if bounds.has_area() {
            child
                .set_bounds(bounds.rect())
                .map_err(|_| surface_operation_failed())?;
        }
        Ok(child)
    }

    fn update(
        &self,
        main: &Webview,
        lease_id: &str,
        bounds: ClippedBounds,
        visible: bool,
    ) -> NativeResult<()> {
        let mut state = self.lock()?;
        if !state.owns(lease_id) {
            return Ok(());
        }
        let child = main
            .app_handle()
            .get_webview(EDITOR_SURFACE_LABEL)
            .ok_or_else(surface_operation_failed)?;
        if bounds.has_area() {
            child
                .set_bounds(bounds.rect())
                .map_err(|_| surface_operation_failed())?;
        }
        let show = visible && bounds.has_area();
        if show != state.visible {
            if show {
                child.show().map_err(|_| surface_operation_failed())?;
            } else {
                child.hide().map_err(|_| surface_operation_failed())?;
                main.set_focus().map_err(|_| surface_operation_failed())?;
            }
            state.visible = show;
        }
        Ok(())
    }

    fn release(&self, main: &Webview, lease_id: &str) -> NativeResult<()> {
        let mut state = self.lock()?;
        let child = main.app_handle().get_webview(EDITOR_SURFACE_LABEL);
        state.release_with(
            lease_id,
            || {
                child
                    .as_ref()
                    .map_or(Ok(()), |child| child.hide().map_err(|_| ()))
            },
            || {
                child
                    .as_ref()
                    .map_or(Ok(()), |child| child.close().map_err(|_| ()))
            },
            || main.set_focus().map_err(|_| ()),
        )
    }

    fn focus(&self, main: &Webview, lease_id: &str) -> NativeResult<()> {
        let state = self.lock()?;
        if !state.owns(lease_id) || !state.visible {
            return Ok(());
        }
        main.app_handle()
            .get_webview(EDITOR_SURFACE_LABEL)
            .ok_or_else(surface_operation_failed)?
            .set_focus()
            .map_err(|_| surface_operation_failed())
    }

    pub fn hide_for_navigation(&self, app: &AppHandle) {
        if let Ok(mut state) = self.inner.lock() {
            state.invalidate();
            if let Some(child) = app.get_webview(EDITOR_SURFACE_LABEL) {
                let _ = child.hide();
            }
        }
    }

    pub fn stop(&self, app: &AppHandle) {
        if let Ok(mut state) = self.inner.lock() {
            state.stopped = true;
            state.invalidate();
        }
        if let Some(child) = app.get_webview(EDITOR_SURFACE_LABEL) {
            let _ = child.close();
        }
    }
}

fn allowed_editor_navigation(url: &url::Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1430)
        && url.username().is_empty()
        && url.password().is_none()
}

fn surface_operation_failed() -> NativeError {
    // Do not include WebView errors: their URLs may contain the editor token.
    NativeError::retryable(
        "editor_surface_failed",
        "The editor surface could not be updated. Retry the connection",
    )
}

fn clipped_bounds(main: &Webview, bounds: EditorSurfaceBounds) -> NativeResult<ClippedBounds> {
    let size = main
        .window()
        .inner_size()
        .map_err(|_| surface_operation_failed())?;
    bounds.clip(size)
}

#[tauri::command]
pub async fn editor_surface_attach(
    webview: Webview,
    surface: State<'_, EditorSurfaceManager>,
    manager: State<'_, EditorServerManager>,
    bounds: EditorSurfaceBounds,
    folder_id: Option<String>,
    reconnect: Option<bool>,
) -> NativeResult<EditorSurfaceLease> {
    require_local_editor_caller(&webview)?;
    let bounds = clipped_bounds(&webview, bounds)?;
    // Reserve before awaiting health so overlapping attaches cannot finish in
    // a different order and replace the newer host with a retired document.
    let attachment = surface.begin_attachment(&webview)?;
    let document = async {
        let status = manager.status().await?;
        if status.state != "ready" {
            return Err(NativeError::retryable(
                "editor_not_ready",
                "Connect the local editor before opening its surface",
            ));
        }
        manager.surface_document(folder_id.as_deref())
    }
    .await;
    let (url, document_key) = match document {
        Ok(document) => document,
        Err(error) => {
            surface.lock()?.failed(&attachment);
            return Err(error);
        }
    };
    surface.attach(
        &webview,
        attachment,
        url,
        document_key,
        bounds,
        reconnect.unwrap_or(false),
    )
}

#[tauri::command]
pub fn editor_surface_update(
    webview: Webview,
    surface: State<'_, EditorSurfaceManager>,
    lease_id: String,
    bounds: EditorSurfaceBounds,
    visible: bool,
) -> NativeResult<()> {
    require_local_editor_caller(&webview)?;
    surface.update(
        &webview,
        &lease_id,
        clipped_bounds(&webview, bounds)?,
        visible,
    )
}

#[tauri::command]
pub fn editor_surface_release(
    webview: Webview,
    surface: State<'_, EditorSurfaceManager>,
    lease_id: String,
) -> NativeResult<()> {
    require_local_editor_caller(&webview)?;
    surface.release(&webview, &lease_id)
}

#[tauri::command]
pub fn editor_surface_focus(
    webview: Webview,
    surface: State<'_, EditorSurfaceManager>,
    lease_id: String,
) -> NativeResult<()> {
    require_local_editor_caller(&webview)?;
    surface.focus(&webview, &lease_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(x: f64, y: f64, width: f64, height: f64) -> EditorSurfaceBounds {
        EditorSurfaceBounds {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn bounds_are_clipped_to_physical_client_area() {
        assert_eq!(
            bounds(-20.0, 80.2, 2000.0, 1500.0)
                .clip(PhysicalSize::new(1440, 900))
                .unwrap(),
            ClippedBounds {
                x: 0,
                y: 80,
                width: 1440,
                height: 820
            }
        );
        assert_eq!(
            bounds(2000.0, 1000.0, 1.0, 1.0)
                .clip(PhysicalSize::new(1440, 900))
                .unwrap(),
            ClippedBounds {
                x: 1440,
                y: 900,
                width: 0,
                height: 0
            }
        );
        assert!(!bounds(10.0, 10.0, 0.0, 10.0)
            .clip(PhysicalSize::new(100, 100))
            .unwrap()
            .has_area());
    }

    #[test]
    fn bounds_reject_nonfinite_unbounded_and_negative_sizes() {
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 100_001.0] {
            assert!(bounds(value, 0.0, 10.0, 10.0)
                .clip(PhysicalSize::new(100, 100))
                .is_err());
            assert!(bounds(0.0, 0.0, value, 10.0)
                .clip(PhysicalSize::new(100, 100))
                .is_err());
        }
        assert!(bounds(0.0, 0.0, -1.0, 10.0)
            .clip(PhysicalSize::new(100, 100))
            .is_err());
        assert!(bounds(0.0, 0.0, 10.0, -1.0)
            .clip(PhysicalSize::new(100, 100))
            .is_err());
    }

    #[test]
    fn leases_invalidate_previous_mounts_and_release_cannot_affect_new_owner() {
        let mut state = SurfaceState::default();
        let first = state.reserve().unwrap();
        assert!(state.finish(&first, "workspace:A".into()));
        assert!(state.owns(&first.lease_id));
        let second = state.reserve().unwrap();
        assert_eq!(second.previous_document.as_deref(), Some("workspace:A"));
        assert!(!state.owns(&first.lease_id));
        assert!(state.reserve().unwrap_err().retryable);
        assert!(state.finish(&second, "workspace:A".into()));
        assert!(!state.owns(&first.lease_id));
        assert!(state.owns(&second.lease_id));
        assert!(!state.visible);
    }

    #[test]
    fn page_reload_and_shutdown_reject_inflight_attachments() {
        let mut state = SurfaceState::default();
        let first = state.reserve().unwrap();
        state.invalidate();
        assert!(!state.finish(&first, "workspace:A".into()));
        state.failed(&first);
        let second = state.reserve().unwrap();
        state.stopped = true;
        state.invalidate();
        assert!(!state.finish(&second, "workspace:B".into()));
        assert!(state.reserve().is_err());
    }

    #[test]
    fn failed_attachments_release_reservation_without_reactivating_old_lease() {
        let mut state = SurfaceState::default();
        let first = state.reserve().unwrap();
        assert!(state.finish(&first, "workspace:A".into()));
        let second = state.reserve().unwrap();
        state.failed(&second);
        assert!(!state.owns(&first.lease_id));
        assert!(!state.owns(&second.lease_id));
        assert!(state.document_key.is_none());
        assert!(state.reserve().is_ok());
    }

    fn leased_surface(visible: bool) -> (SurfaceState, String) {
        let mut state = SurfaceState::default();
        let attachment = state.reserve().unwrap();
        assert!(state.finish(&attachment, "workspace:A".into()));
        state.visible = visible;
        (state, attachment.lease_id)
    }

    #[test]
    fn release_retires_lease_and_visibility_even_when_focus_fails() {
        let (mut state, lease_id) = leased_surface(true);
        let calls = std::cell::RefCell::new(Vec::new());
        let error = state
            .release_with(
                &lease_id,
                || {
                    calls.borrow_mut().push("hide");
                    Ok(())
                },
                || panic!("a successfully hidden child must be preserved"),
                || {
                    calls.borrow_mut().push("focus");
                    Err(())
                },
            )
            .unwrap_err();
        assert!(error.retryable);
        assert_eq!(calls.into_inner(), vec!["hide", "focus"]);
        assert!(!state.owns(&lease_id));
        assert!(!state.visible);
        assert_eq!(state.document_key.as_deref(), Some("workspace:A"));
        assert!(!state.cleanup_needed);
        state
            .release_with(
                &lease_id,
                || panic!("stale hide"),
                || panic!("stale close"),
                || panic!("stale focus"),
            )
            .unwrap();
    }

    #[test]
    fn release_hide_failure_closes_child_and_still_returns_focus() {
        let (mut state, lease_id) = leased_surface(true);
        let calls = std::cell::RefCell::new(Vec::new());
        assert!(state
            .release_with(
                &lease_id,
                || {
                    calls.borrow_mut().push("hide");
                    Err(())
                },
                || {
                    calls.borrow_mut().push("close");
                    Ok(())
                },
                || {
                    calls.borrow_mut().push("focus");
                    Ok(())
                },
            )
            .is_err());
        assert_eq!(calls.into_inner(), vec!["hide", "close", "focus"]);
        assert!(!state.owns(&lease_id));
        assert!(!state.visible);
        assert!(state.document_key.is_none());
        assert!(!state.cleanup_needed);
        let next = state.reserve().unwrap();
        assert!(state.finish(&next, "workspace:B".into()));
        state
            .release_with(
                &lease_id,
                || panic!("old hide"),
                || panic!("old close"),
                || panic!("old focus"),
            )
            .unwrap();
        assert!(state.owns(&next.lease_id));
        assert_eq!(state.document_key.as_deref(), Some("workspace:B"));
    }

    #[test]
    fn failed_hide_and_close_keep_orphan_cleanup_required_before_new_attachment() {
        let (mut state, lease_id) = leased_surface(true);
        assert!(state
            .release_with(&lease_id, || Err(()), || Err(()), || Err(()))
            .is_err());
        assert!(!state.owns(&lease_id));
        assert!(!state.visible);
        assert!(state.document_key.is_none());
        assert!(state.cleanup_needed);

        let failed = state.reserve().unwrap();
        assert!(!state.finish(&failed, "workspace:must-not-commit".into()));
        assert!(state.clean_orphan(|| Err(())).is_err());
        state.failed(&failed);
        assert!(state.cleanup_needed);
        assert!(!state.owns(&failed.lease_id));

        let next = state.reserve().unwrap();
        state.clean_orphan(|| Ok(())).unwrap();
        assert!(!state.cleanup_needed);
        assert!(state.finish(&next, "workspace:B".into()));
        state
            .release_with(
                &lease_id,
                || panic!("old hide"),
                || panic!("old close"),
                || panic!("old focus"),
            )
            .unwrap();
        assert!(state.owns(&next.lease_id));
    }

    #[test]
    fn releasing_hidden_surface_preserves_document_without_stealing_focus() {
        let (mut state, lease_id) = leased_surface(false);
        state
            .release_with(
                &lease_id,
                || Ok(()),
                || panic!("hidden child does not need closing"),
                || panic!("an already hidden child must not steal focus"),
            )
            .unwrap();
        assert!(!state.owns(&lease_id));
        assert!(!state.visible);
        assert!(!state.cleanup_needed);
        let next = state.reserve().unwrap();
        assert_eq!(next.previous_document.as_deref(), Some("workspace:A"));
        state
            .clean_orphan(|| panic!("a known hidden document needs no cleanup"))
            .unwrap();
    }

    #[test]
    fn navigation_accepts_only_exact_editor_origin_without_credentials() {
        for url in [
            "http://127.0.0.1:1430/?tkn=test-only",
            "http://127.0.0.1:1430/stable/workbench?a=b#file",
        ] {
            assert!(allowed_editor_navigation(&url::Url::parse(url).unwrap()));
        }
        for url in [
            "https://127.0.0.1:1430/",
            "http://localhost:1430/",
            "http://127.0.0.1:1431/",
            "http://user@127.0.0.1:1430/",
            "http://tauri.localhost/",
            "file:///C:/Windows/",
            "https://example.com/",
            "about:blank",
        ] {
            assert!(!allowed_editor_navigation(&url::Url::parse(url).unwrap()));
        }
    }
}
