//! Windows controller accelerators for native browser children.
//!
//! Remote documents never send key messages or invoke commands. The synchronous
//! WebView2 callback only accepts a small enum into a bounded queue. A worker
//! schedules delivery to the local main document after that callback returns.
#![cfg(windows)]

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{Emitter, EventTarget, Manager, Webview};
use tokio::sync::{mpsc, oneshot};
use webview2_com::{
    AcceleratorKeyPressedEventHandler, FocusChangedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2AcceleratorKeyPressedEventArgs, ICoreWebView2Controller,
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
        COREWEBVIEW2_PHYSICAL_KEY_STATUS,
    },
};
use windows::{
    core::BOOL,
    Win32::UI::{
        Input::KeyboardAndMouse::{
            GetKeyState, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RMENU, VK_RWIN, VK_SHIFT,
        },
        WindowsAndMessaging::GetForegroundWindow,
    },
};

use crate::error::{NativeError, NativeResult};

pub(crate) const SHORTCUT_EVENT: &str = "omnia-native-browser-shortcut";
const QUEUE_CAPACITY: usize = 8;
const MAX_EVENT_AGE: Duration = Duration::from_secs(1);
const NATIVE_CALL_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum BrowserShortcutAction {
    FocusAddress,
    NewTab,
    CloseTab,
    NextTab,
    PreviousTab,
    Reload,
}

impl BrowserShortcutAction {
    fn needs_main_focus(self) -> bool {
        self != Self::Reload
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserShortcut {
    tab_key: String,
    label: String,
    lease_id: String,
    epoch: u64,
    action: BrowserShortcutAction,
}

#[derive(Clone, Copy, Debug, Default)]
struct Modifiers {
    control: bool,
    shift: bool,
    alt: bool,
    right_alt: bool,
    meta: bool,
}

#[derive(Clone, Copy, Debug, Default)]
struct KeyInput {
    virtual_key: u32,
    down: bool,
    handled: bool,
    repeated: bool,
    released: bool,
    modifiers: Modifiers,
}

fn shortcut_action(input: KeyInput) -> Option<BrowserShortcutAction> {
    let modifiers = input.modifiers;
    if !input.down
        || input.handled
        || input.repeated
        || input.released
        || input.virtual_key == 229 // VK_PROCESSKEY: an IME is processing this key.
        || modifiers.alt
        || modifiers.right_alt
        || modifiers.meta
    {
        return None;
    }
    match (input.virtual_key, modifiers.control, modifiers.shift) {
        (0x75, false, false) | (0x4c, true, false) => Some(BrowserShortcutAction::FocusAddress),
        (0x54, true, false) => Some(BrowserShortcutAction::NewTab),
        (0x57, true, false) => Some(BrowserShortcutAction::CloseTab),
        (0x09, true, false) => Some(BrowserShortcutAction::NextTab),
        (0x09, true, true) => Some(BrowserShortcutAction::PreviousTab),
        (0x52, true, false) => Some(BrowserShortcutAction::Reload),
        _ => None,
    }
}

#[derive(Clone, Debug)]
struct QueuedShortcut {
    payload: BrowserShortcut,
    revision: u64,
    created_at: Instant,
}

struct Ownership {
    lease_id: String,
    epoch: u64,
    visible: bool,
    revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ControllerTokens {
    got_focus: i64,
    lost_focus: i64,
    accelerator: i64,
}

#[derive(Default)]
enum RegistrationPhase {
    #[default]
    Fresh,
    Installing,
    Installed(ControllerTokens),
    Retired,
}

impl RegistrationPhase {
    fn begin(&mut self) -> bool {
        if !matches!(self, Self::Fresh) {
            return false;
        }
        *self = Self::Installing;
        true
    }

    /// Returns tokens that must be removed immediately after a late install.
    fn complete(&mut self, tokens: ControllerTokens) -> Option<ControllerTokens> {
        if matches!(self, Self::Installing) {
            *self = Self::Installed(tokens);
            None
        } else {
            Some(tokens)
        }
    }

    fn retire(&mut self) -> Option<ControllerTokens> {
        match std::mem::replace(self, Self::Retired) {
            Self::Installed(tokens) => Some(tokens),
            _ => None,
        }
    }
}

struct Shared {
    tab_key: String,
    label: String,
    parent_hwnd: usize,
    alive: AtomicBool,
    focused: AtomicBool,
    ownership: Mutex<Ownership>,
    registration: Mutex<RegistrationPhase>,
}

impl Shared {
    fn new(
        tab_key: String,
        label: String,
        parent_hwnd: usize,
        lease_id: String,
        epoch: u64,
    ) -> Self {
        Self {
            tab_key,
            label,
            parent_hwnd,
            alive: AtomicBool::new(true),
            focused: AtomicBool::new(false),
            ownership: Mutex::new(Ownership {
                lease_id,
                epoch,
                visible: false,
                revision: 0,
            }),
            registration: Mutex::new(RegistrationPhase::Fresh),
        }
    }

    fn invalidate(&self) {
        self.alive.store(false, Ordering::Release);
        self.focused.store(false, Ordering::Release);
    }

    fn set_owner(&self, lease_id: &str, epoch: u64, visible: bool) -> NativeResult<()> {
        if !valid_lease(lease_id) {
            self.invalidate();
            return Err(bridge_error());
        }
        if !self.alive.load(Ordering::Acquire) {
            return Err(bridge_error());
        }
        let mut owner = self.ownership.lock().map_err(|_| {
            self.invalidate();
            bridge_error()
        })?;
        if owner.lease_id != lease_id || owner.epoch != epoch || owner.visible != visible {
            let changed_owner = owner.lease_id != lease_id || owner.epoch != epoch;
            // Any ownership/visibility transition invalidates already queued keys.
            owner.revision = owner.revision.wrapping_add(1);
            owner.lease_id = lease_id.to_owned();
            owner.epoch = epoch;
            owner.visible = visible;
            // A real GotFocus may already have arrived during show(). Preserve
            // it when making the same lease visible; hiding or changing owners
            // must always clear focus before native UI work can fail.
            if changed_owner || !visible {
                self.focused.store(false, Ordering::Release);
            }
        }
        Ok(())
    }

    fn snapshot(
        &self,
        action: BrowserShortcutAction,
        foreground: bool,
        now: Instant,
    ) -> Option<QueuedShortcut> {
        if !foreground
            || !self.alive.load(Ordering::Acquire)
            || !self.focused.load(Ordering::Acquire)
        {
            return None;
        }
        // Never wait on a state mutex from a synchronous COM callback.
        let owner = self.ownership.try_lock().ok()?;
        if !owner.visible {
            return None;
        }
        Some(QueuedShortcut {
            payload: BrowserShortcut {
                tab_key: self.tab_key.clone(),
                label: self.label.clone(),
                lease_id: owner.lease_id.clone(),
                epoch: owner.epoch,
                action,
            },
            revision: owner.revision,
            created_at: now,
        })
    }

    fn accepts(&self, event: &QueuedShortcut, require_focus: bool, now: Instant) -> bool {
        if !self.alive.load(Ordering::Acquire)
            || (require_focus && !self.focused.load(Ordering::Acquire))
            || now.saturating_duration_since(event.created_at) > MAX_EVENT_AGE
        {
            return false;
        }
        self.ownership.try_lock().is_ok_and(|owner| {
            owner.visible
                && owner.revision == event.revision
                && owner.lease_id == event.payload.lease_id
                && owner.epoch == event.payload.epoch
                && self.label == event.payload.label
                && self.tab_key == event.payload.tab_key
        })
    }

    fn parent_is_foreground(&self) -> bool {
        // SAFETY: this only reads the current foreground handle; no handle is dereferenced.
        unsafe { GetForegroundWindow().0 as usize == self.parent_hwnd }
    }

    fn retire_tokens(&self) -> Option<ControllerTokens> {
        // A poisoned token mutex must still release its native registrations.
        self.registration
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retire()
    }
}

fn try_enqueue(
    shared: &Shared,
    sender: &mpsc::Sender<QueuedShortcut>,
    input: KeyInput,
    foreground: bool,
    now: Instant,
    mark_handled: impl FnOnce() -> bool,
) -> bool {
    let Some(action) = shortcut_action(input) else {
        return false;
    };
    let Some(event) = shared.snapshot(action, foreground, now) else {
        return false;
    };
    let Ok(permit) = sender.try_reserve() else {
        return false;
    };
    if !shared.accepts(&event, true, now) || !mark_handled() {
        return false;
    }
    permit.send(event);
    true
}

fn valid_lease(lease: &str) -> bool {
    lease.len() == 32 && lease.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_main_url(url: &url::Url) -> bool {
    let app_origin = matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    ) && url.port().is_none();
    let preview_origin = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420);
    (app_origin || preview_origin) && url.username().is_empty() && url.password().is_none()
}

fn bridge_error() -> NativeError {
    NativeError::new(
        "browser_keyboard_unavailable",
        "Browser page shortcuts could not connect. Reopen this tab to try again.",
    )
}

/// One guard per controller, stored by the native browser manager (normally in
/// an Arc so cloning a tab record does not install another callback).
///
/// Call set_owner after a successful show, and before hiding/reassigning a lease.
/// Before close, invalidate synchronously, then await detach; always continue
/// child cleanup even if detach returns an error. Dropping is a best-effort fallback.
pub(crate) struct BrowserKeyboardRegistration {
    child: Webview,
    shared: Arc<Shared>,
    worker: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl BrowserKeyboardRegistration {
    pub(crate) async fn install(
        child: &Webview,
        tab_key: &str,
        lease_id: &str,
        epoch: u64,
    ) -> NativeResult<Self> {
        if !child.label().starts_with("omnia-browser-")
            || tab_key.is_empty()
            || tab_key.len() > 128
            || !tab_key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || !valid_lease(lease_id)
        {
            return Err(bridge_error());
        }
        let parent_hwnd = child.window().hwnd().map_err(|_| bridge_error())?.0 as usize;
        let shared = Arc::new(Shared::new(
            tab_key.to_owned(),
            child.label().to_owned(),
            parent_hwnd,
            lease_id.to_owned(),
            epoch,
        ));
        let registration = Self {
            child: child.clone(),
            shared,
            worker: Mutex::new(None),
        };
        let (sender, receiver) = mpsc::channel(QUEUE_CAPACITY);
        let (acknowledge, acknowledged) = oneshot::channel();
        let weak = Arc::downgrade(&registration.shared);
        child
            .with_webview(move |platform| {
                let result = install_on_controller(&platform.controller(), &weak, sender);
                let _ = acknowledge.send(result);
            })
            .map_err(|_| bridge_error())?;
        tokio::time::timeout(NATIVE_CALL_TIMEOUT, acknowledged)
            .await
            .map_err(|_| bridge_error())?
            .map_err(|_| bridge_error())??;
        if !registration.shared.alive.load(Ordering::Acquire) {
            return Err(bridge_error());
        }
        let worker = tauri::async_runtime::spawn(delivery_worker(
            child.app_handle().clone(),
            Arc::downgrade(&registration.shared),
            receiver,
        ));
        *registration.worker.lock().map_err(|_| bridge_error())? = Some(worker);
        Ok(registration)
    }

    pub(crate) fn set_owner(&self, lease_id: &str, epoch: u64, visible: bool) -> NativeResult<()> {
        self.shared.set_owner(lease_id, epoch, visible)
    }

    /// Synchronous logical teardown, safe before a native hide/close that may fail.
    pub(crate) fn invalidate(&self) {
        self.shared.invalidate();
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            worker.abort();
        }
    }

    pub(crate) async fn detach(&self) -> NativeResult<()> {
        self.invalidate();
        let Some(tokens) = self.shared.retire_tokens() else {
            return Ok(());
        };
        let (acknowledge, acknowledged) = oneshot::channel();
        self.child
            .with_webview(move |platform| {
                let result =
                    remove_handlers(&platform.controller(), tokens).map_err(|_| bridge_error());
                let _ = acknowledge.send(result);
            })
            .map_err(|_| bridge_error())?;
        tokio::time::timeout(NATIVE_CALL_TIMEOUT, acknowledged)
            .await
            .map_err(|_| bridge_error())?
            .map_err(|_| bridge_error())?
    }
}

impl Drop for BrowserKeyboardRegistration {
    fn drop(&mut self) {
        self.invalidate();
        if let Some(tokens) = self.shared.retire_tokens() {
            let _ = self.child.with_webview(move |platform| {
                let _ = remove_handlers(&platform.controller(), tokens);
            });
        }
    }
}

fn install_on_controller(
    controller: &ICoreWebView2Controller,
    weak: &Weak<Shared>,
    sender: mpsc::Sender<QueuedShortcut>,
) -> NativeResult<()> {
    let shared = weak.upgrade().ok_or_else(bridge_error)?;
    if !shared.alive.load(Ordering::Acquire)
        || !shared
            .registration
            .lock()
            .map_err(|_| bridge_error())?
            .begin()
    {
        return Err(bridge_error());
    }
    let tokens = match add_handlers(controller, weak, sender) {
        Ok(tokens) => tokens,
        Err(_) => {
            shared.invalidate();
            shared.retire_tokens();
            return Err(bridge_error());
        }
    };
    let rollback = shared
        .registration
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .complete(tokens);
    if let Some(tokens) = rollback {
        let _ = remove_handlers(controller, tokens);
        return Err(bridge_error());
    }
    // A timeout/drop may invalidate this registration while native add calls run.
    if !shared.alive.load(Ordering::Acquire) {
        if let Some(tokens) = shared.retire_tokens() {
            let _ = remove_handlers(controller, tokens);
        }
        return Err(bridge_error());
    }
    Ok(())
}

fn add_handlers(
    controller: &ICoreWebView2Controller,
    weak: &Weak<Shared>,
    sender: mpsc::Sender<QueuedShortcut>,
) -> windows::core::Result<ControllerTokens> {
    let on_focus = weak.clone();
    let got_focus = FocusChangedEventHandler::create(Box::new(move |_, _| {
        if let Some(shared) = on_focus.upgrade() {
            shared
                .focused
                .store(shared.alive.load(Ordering::Acquire), Ordering::Release);
        }
        Ok(())
    }));
    let on_blur = weak.clone();
    let lost_focus = FocusChangedEventHandler::create(Box::new(move |_, _| {
        if let Some(shared) = on_blur.upgrade() {
            shared.focused.store(false, Ordering::Release);
        }
        Ok(())
    }));
    let on_key = weak.clone();
    let accelerator = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
        let (Some(shared), Some(args)) = (on_key.upgrade(), args) else {
            return Ok(());
        };
        let Ok(input) = read_key(&args) else {
            return Ok(());
        };
        try_enqueue(
            &shared,
            &sender,
            input,
            shared.parent_is_foreground(),
            Instant::now(),
            || {
                // SAFETY: args belongs to this synchronous callback. A queue permit
                // already exists, so this key is swallowed only when it can be queued.
                unsafe { args.SetHandled(true).is_ok() }
            },
        );
        Ok(())
    }));
    let mut tokens = ControllerTokens {
        got_focus: 0,
        lost_focus: 0,
        accelerator: 0,
    };
    // SAFETY: controller and COM callback interfaces remain on the WebView UI thread.
    unsafe {
        controller.add_GotFocus(&got_focus, &mut tokens.got_focus)?;
        if let Err(error) = controller.add_LostFocus(&lost_focus, &mut tokens.lost_focus) {
            let _ = controller.remove_GotFocus(tokens.got_focus);
            return Err(error);
        }
        if let Err(error) =
            controller.add_AcceleratorKeyPressed(&accelerator, &mut tokens.accelerator)
        {
            let _ = controller.remove_LostFocus(tokens.lost_focus);
            let _ = controller.remove_GotFocus(tokens.got_focus);
            return Err(error);
        }
    }
    Ok(tokens)
}

fn remove_handlers(
    controller: &ICoreWebView2Controller,
    tokens: ControllerTokens,
) -> windows::core::Result<()> {
    // Try every removal even if a previous one fails. Ownership was invalidated
    // first; retained callbacks only hold Weak state and cannot deliver actions.
    // SAFETY: called through with_webview on this exact controller's UI thread.
    unsafe {
        let accelerator = controller.remove_AcceleratorKeyPressed(tokens.accelerator);
        let got_focus = controller.remove_GotFocus(tokens.got_focus);
        let lost_focus = controller.remove_LostFocus(tokens.lost_focus);
        accelerator.and(got_focus).and(lost_focus)
    }
}

fn read_key(args: &ICoreWebView2AcceleratorKeyPressedEventArgs) -> windows::core::Result<KeyInput> {
    let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
    let mut virtual_key = 0;
    let mut handled = BOOL::default();
    let mut physical = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
    // SAFETY: args is valid for this controller callback; GetKeyState reads the
    // UI thread's queued key state rather than polling global asynchronous keys.
    unsafe {
        args.KeyEventKind(&mut kind)?;
        args.VirtualKey(&mut virtual_key)?;
        args.Handled(&mut handled)?;
        args.PhysicalKeyStatus(&mut physical)?;
    }
    let pressed = |key: VIRTUAL_KEY| unsafe { GetKeyState(i32::from(key.0)) < 0 };
    Ok(KeyInput {
        virtual_key,
        down: kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
            || kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
        handled: handled.as_bool(),
        repeated: physical.WasKeyDown.as_bool() || physical.RepeatCount > 1,
        released: physical.IsKeyReleased.as_bool(),
        modifiers: Modifiers {
            control: pressed(VK_CONTROL),
            shift: pressed(VK_SHIFT),
            alt: pressed(VK_MENU) || physical.IsMenuKeyDown.as_bool(),
            right_alt: pressed(VK_RMENU),
            meta: pressed(VK_LWIN) || pressed(VK_RWIN),
        },
    })
}

async fn delivery_worker(
    app: tauri::AppHandle,
    weak: Weak<Shared>,
    receiver: mpsc::Receiver<QueuedShortcut>,
) {
    delivery_loop(
        weak.clone(),
        receiver,
        NATIVE_CALL_TIMEOUT,
        move |event, token, done| {
            let ui_weak = weak.clone();
            let ui_app = app.clone();
            // This originates from a background worker, never from the COM callback.
            app.run_on_main_thread(move || {
                token.run(|| deliver_on_main(&ui_app, &ui_weak, event));
                let _ = done.send(());
            })
            .is_ok()
        },
    )
    .await;
}

/// Cancels an expired or aborted delivery without retiring its registration.
struct DeliveryAttempt(Arc<AtomicBool>);

#[derive(Debug)]
struct DeliveryToken(Arc<AtomicBool>);

impl DeliveryAttempt {
    fn new() -> (Self, DeliveryToken) {
        let active = Arc::new(AtomicBool::new(true));
        (Self(active.clone()), DeliveryToken(active))
    }

    fn cancel(&self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Drop for DeliveryAttempt {
    fn drop(&mut self) {
        self.cancel();
    }
}

impl DeliveryToken {
    fn run(self, deliver: impl FnOnce()) {
        if self.0.load(Ordering::Acquire) {
            deliver();
        }
    }
}

async fn delivery_loop(
    weak: Weak<Shared>,
    mut receiver: mpsc::Receiver<QueuedShortcut>,
    timeout: Duration,
    mut dispatch: impl FnMut(QueuedShortcut, DeliveryToken, oneshot::Sender<()>) -> bool,
) {
    while let Some(event) = receiver.recv().await {
        let Some(shared) = weak.upgrade() else { break };
        if !shared.accepts(&event, true, Instant::now()) {
            continue;
        }
        drop(shared);
        let (attempt, token) = DeliveryAttempt::new();
        let (done, mut completed) = oneshot::channel();
        if !dispatch(event, token, done) {
            continue;
        }
        if tokio::time::timeout(timeout, &mut completed).await.is_err() {
            attempt.cancel();
            // Keep at most one scheduled native callback. Merely continuing
            // here would accumulate unbounded closures during a main-thread
            // stall. Once that callback retires, fresh shortcuts can recover;
            // its expired action is never replayed. The input queue stays bounded.
            let _ = completed.await;
        }
    }
}

fn deliver_on_main(app: &tauri::AppHandle, weak: &Weak<Shared>, event: QueuedShortcut) {
    let Some(shared) = weak.upgrade() else { return };
    if !shared.parent_is_foreground() || !shared.accepts(&event, true, Instant::now()) {
        return;
    }
    let Some(main) = app.get_webview("main") else {
        return;
    };
    if !main.url().is_ok_and(|url| valid_main_url(&url)) {
        return;
    }
    if event.payload.action.needs_main_focus() && main.set_focus().is_err() {
        return;
    }
    // Focusing main deliberately triggers LostFocus. Recheck all ownership
    // fields without requiring the child to remain focused after that operation.
    if shared.accepts(&event, false, Instant::now()) {
        let _ = app.emit_to(EventTarget::webview("main"), SHORTCUT_EVENT, event.payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEASE: &str = "00000000000000000000000000000001";
    const OTHER_LEASE: &str = "00000000000000000000000000000002";

    fn key(virtual_key: u32) -> KeyInput {
        KeyInput {
            virtual_key,
            down: true,
            modifiers: Modifiers {
                control: true,
                ..Modifiers::default()
            },
            ..KeyInput::default()
        }
    }

    fn active() -> Shared {
        let shared = Shared::new(
            "tab-1".into(),
            "omnia-browser-unit".into(),
            1,
            LEASE.into(),
            4,
        );
        shared.set_owner(LEASE, 4, true).unwrap();
        shared.focused.store(true, Ordering::Release);
        shared
    }

    fn event(shared: &Shared, now: Instant) -> QueuedShortcut {
        shared
            .snapshot(BrowserShortcutAction::CloseTab, true, now)
            .unwrap()
    }

    #[tokio::test]
    async fn timed_out_delivery_retires_without_replay_then_accepts_fresh_shortcuts() {
        let shared = Arc::new(active());
        let (sender, receiver) = mpsc::channel(QUEUE_CAPACITY);
        let (held_sender, mut held_receiver) = mpsc::unbounded_channel();
        let (recovered_sender, recovered_receiver) = oneshot::channel();
        let mut recovered_sender = Some(recovered_sender);
        let delivered = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let dispatch_delivered = delivered.clone();
        let mut dispatch_count = 0;
        let worker = tokio::spawn(delivery_loop(
            Arc::downgrade(&shared),
            receiver,
            Duration::ZERO,
            move |_, token, done| {
                dispatch_count += 1;
                if dispatch_count == 1 {
                    held_sender.send((token, done)).unwrap();
                } else {
                    token.run(|| {
                        dispatch_delivered.fetch_add(1, Ordering::AcqRel);
                    });
                    let _ = done.send(());
                    let _ = recovered_sender.take().unwrap().send(());
                }
                true
            },
        ));
        sender.send(event(&shared, Instant::now())).await.unwrap();
        let (expired_token, retired) = held_receiver.recv().await.unwrap();
        // Synchronize with expiration rather than sleeping a guessed duration.
        tokio::time::timeout(Duration::from_secs(1), async {
            while expired_token.0.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        sender.send(event(&shared, Instant::now())).await.unwrap();
        tokio::task::yield_now().await;
        assert!(held_receiver.try_recv().is_err());
        assert_eq!(delivered.load(Ordering::Acquire), 0);
        expired_token.run(|| {
            delivered.fetch_add(100, Ordering::AcqRel);
        });
        let _ = retired.send(());
        tokio::time::timeout(Duration::from_secs(1), recovered_receiver)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(delivered.load(Ordering::Acquire), 1);
        drop(sender);
        worker.await.unwrap();
    }

    #[tokio::test]
    async fn dispatch_error_does_not_close_the_shortcut_receiver() {
        let shared = Arc::new(active());
        let (sender, receiver) = mpsc::channel(QUEUE_CAPACITY);
        let delivered = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let dispatch_delivered = delivered.clone();
        let mut dispatch_count = 0;
        let worker = tokio::spawn(delivery_loop(
            Arc::downgrade(&shared),
            receiver,
            Duration::ZERO,
            move |_, token, done| {
                dispatch_count += 1;
                if dispatch_count == 1 {
                    return false;
                }
                token.run(|| {
                    dispatch_delivered.fetch_add(1, Ordering::AcqRel);
                });
                let _ = done.send(());
                true
            },
        ));
        sender.send(event(&shared, Instant::now())).await.unwrap();
        sender.send(event(&shared, Instant::now())).await.unwrap();
        drop(sender);
        worker.await.unwrap();
        assert_eq!(delivered.load(Ordering::Acquire), 1);
    }

    #[test]
    fn dropped_attempt_cancels_a_callback_retained_after_worker_teardown() {
        let (attempt, token) = DeliveryAttempt::new();
        drop(attempt);
        token.run(|| panic!("an aborted worker's late callback must not deliver"));
    }

    #[test]
    fn maps_only_the_documented_browser_accelerators() {
        for (code, expected) in [
            (0x4c, BrowserShortcutAction::FocusAddress),
            (0x54, BrowserShortcutAction::NewTab),
            (0x57, BrowserShortcutAction::CloseTab),
            (0x09, BrowserShortcutAction::NextTab),
            (0x52, BrowserShortcutAction::Reload),
        ] {
            assert_eq!(shortcut_action(key(code)), Some(expected));
        }
        let mut previous = key(0x09);
        previous.modifiers.shift = true;
        assert_eq!(
            shortcut_action(previous),
            Some(BrowserShortcutAction::PreviousTab)
        );
        assert_eq!(
            shortcut_action(KeyInput {
                virtual_key: 0x75,
                down: true,
                ..KeyInput::default()
            }),
            Some(BrowserShortcutAction::FocusAddress)
        );
        for code in [0x50, 0x42, 0x4a, 0x31, 0x32, 0x33, 0x75, 0x1b, 0x7b, 229] {
            assert_eq!(shortcut_action(key(code)), None, "key {code}");
        }
    }

    #[test]
    fn rejects_unexpected_modifiers_keyup_repeat_handled_and_ime_keys() {
        let ordinary = key(0x54);
        for input in [
            KeyInput {
                down: false,
                ..ordinary
            },
            KeyInput {
                handled: true,
                ..ordinary
            },
            KeyInput {
                repeated: true,
                ..ordinary
            },
            KeyInput {
                released: true,
                ..ordinary
            },
            KeyInput {
                virtual_key: 229,
                ..ordinary
            },
            KeyInput {
                modifiers: Modifiers {
                    alt: true,
                    ..ordinary.modifiers
                },
                ..ordinary
            },
            KeyInput {
                modifiers: Modifiers {
                    right_alt: true,
                    ..ordinary.modifiers
                },
                ..ordinary
            },
            KeyInput {
                modifiers: Modifiers {
                    meta: true,
                    ..ordinary.modifiers
                },
                ..ordinary
            },
            KeyInput {
                modifiers: Modifiers {
                    shift: true,
                    ..ordinary.modifiers
                },
                ..ordinary
            },
            KeyInput {
                modifiers: Modifiers::default(),
                ..ordinary
            },
        ] {
            assert_eq!(shortcut_action(input), None);
        }
    }

    #[test]
    fn hidden_unfocused_background_and_retired_sources_cannot_queue() {
        let now = Instant::now();
        let shared = active();
        assert!(shared
            .snapshot(BrowserShortcutAction::NewTab, false, now)
            .is_none());
        shared.focused.store(false, Ordering::Release);
        assert!(shared
            .snapshot(BrowserShortcutAction::NewTab, true, now)
            .is_none());
        shared.focused.store(true, Ordering::Release);
        shared.set_owner(LEASE, 4, false).unwrap();
        shared.focused.store(true, Ordering::Release);
        assert!(shared
            .snapshot(BrowserShortcutAction::NewTab, true, now)
            .is_none());
        shared.set_owner(LEASE, 4, true).unwrap();
        shared.focused.store(true, Ordering::Release);
        shared.invalidate();
        assert!(shared
            .snapshot(BrowserShortcutAction::NewTab, true, now)
            .is_none());
    }

    #[test]
    fn queued_keys_expire_after_ownership_or_visibility_changes() {
        let now = Instant::now();
        for (lease, epoch) in [(OTHER_LEASE, 4), (LEASE, 5)] {
            let shared = active();
            let queued = event(&shared, now);
            shared.set_owner(lease, epoch, true).unwrap();
            shared.focused.store(true, Ordering::Release);
            assert!(!shared.accepts(&queued, true, now));
        }
        let shared = active();
        let queued = event(&shared, now);
        shared.set_owner(LEASE, 4, false).unwrap();
        shared.set_owner(LEASE, 4, true).unwrap();
        shared.focused.store(true, Ordering::Release);
        assert!(!shared.accepts(&queued, true, now));
    }

    #[test]
    fn identical_bounds_updates_keep_focus_and_fresh_queue_ownership() {
        let shared = active();
        let now = Instant::now();
        let queued = event(&shared, now);
        shared.set_owner(LEASE, 4, true).unwrap();
        assert!(shared.accepts(&queued, true, now));
        assert!(!shared.accepts(
            &queued,
            true,
            now + MAX_EVENT_AGE + Duration::from_millis(1)
        ));
        shared.focused.store(false, Ordering::Release);
        assert!(!shared.accepts(&queued, true, now));
        assert!(shared.accepts(&queued, false, now));
        shared.invalidate();
        assert!(!shared.accepts(&queued, false, now));
    }

    #[test]
    fn becoming_visible_preserves_a_real_focus_event_received_during_show() {
        let shared = active();
        shared.set_owner(LEASE, 4, false).unwrap();
        shared.focused.store(true, Ordering::Release);
        shared.set_owner(LEASE, 4, true).unwrap();
        assert!(shared
            .snapshot(BrowserShortcutAction::FocusAddress, true, Instant::now())
            .is_some());
        shared.set_owner(OTHER_LEASE, 4, true).unwrap();
        assert!(!shared.focused.load(Ordering::Acquire));
    }

    #[test]
    fn full_or_closed_queue_never_marks_the_key_handled() {
        let shared = active();
        let (sender, mut receiver) = mpsc::channel(1);
        let now = Instant::now();
        let marked = std::cell::Cell::new(0);
        assert!(try_enqueue(&shared, &sender, key(0x54), true, now, || {
            marked.set(marked.get() + 1);
            true
        }));
        assert!(!try_enqueue(&shared, &sender, key(0x54), true, now, || {
            marked.set(marked.get() + 1);
            true
        }));
        assert_eq!(marked.get(), 1);
        assert_eq!(
            receiver.try_recv().unwrap().payload.action,
            BrowserShortcutAction::NewTab
        );
        drop(receiver);
        assert!(!try_enqueue(&shared, &sender, key(0x54), true, now, || {
            marked.set(marked.get() + 1);
            true
        }));
        assert_eq!(marked.get(), 1);
    }

    #[test]
    fn failed_handled_mark_and_contended_state_do_not_queue() {
        let shared = active();
        let (sender, mut receiver) = mpsc::channel(1);
        let now = Instant::now();
        assert!(!try_enqueue(&shared, &sender, key(0x54), true, now, || {
            false
        }));
        assert!(receiver.try_recv().is_err());
        let _state = shared.ownership.lock().unwrap();
        assert!(!try_enqueue(
            &shared,
            &sender,
            key(0x54),
            true,
            now,
            || panic!("must not mark a contended key")
        ));
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn invalid_owner_update_invalidates_the_previous_lease() {
        let shared = active();
        let now = Instant::now();
        let queued = event(&shared, now);
        assert!(shared.set_owner("not-a-native-lease", 4, true).is_err());
        assert!(!shared.accepts(&queued, false, now));
        assert!(shared
            .snapshot(BrowserShortcutAction::NewTab, true, now)
            .is_none());
    }

    #[test]
    fn only_one_registration_and_one_token_removal_per_controller() {
        let tokens = ControllerTokens {
            got_focus: 1,
            lost_focus: 2,
            accelerator: 3,
        };
        let mut phase = RegistrationPhase::default();
        assert!(phase.begin());
        assert!(!phase.begin());
        assert_eq!(phase.complete(tokens), None);
        assert!(!phase.begin());
        assert_eq!(phase.retire(), Some(tokens));
        assert_eq!(phase.retire(), None);
        assert!(!phase.begin());
    }

    #[test]
    fn late_install_after_teardown_returns_all_tokens_for_immediate_removal() {
        let tokens = ControllerTokens {
            got_focus: 8,
            lost_focus: 9,
            accelerator: 10,
        };
        let mut phase = RegistrationPhase::default();
        assert!(phase.begin());
        assert_eq!(phase.retire(), None);
        assert_eq!(phase.complete(tokens), Some(tokens));
        assert_eq!(phase.retire(), None);
        assert!(!phase.begin());
    }

    #[test]
    fn events_have_a_fixed_enum_and_exact_main_origin() {
        assert_eq!(
            serde_json::to_value(BrowserShortcutAction::FocusAddress).unwrap(),
            "focus-address"
        );
        assert_eq!(
            serde_json::to_value(BrowserShortcutAction::PreviousTab).unwrap(),
            "previous-tab"
        );
        for raw in [
            "http://tauri.localhost",
            "https://tauri.localhost",
            "tauri://localhost/index.html",
        ] {
            assert!(valid_main_url(&url::Url::parse(raw).unwrap()));
        }
        for raw in [
            "https://example.com",
            "http://tauri.localhost:1430",
            "http://user@tauri.localhost",
            "http://tauri.localhost.evil",
            "http://127.0.0.1:1430",
        ] {
            assert!(!valid_main_url(&url::Url::parse(raw).unwrap()), "{raw}");
        }
    }
}
