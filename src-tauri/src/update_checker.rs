//! Self-hosted update checker (no tauri-plugin-updater).
//!
//! Commands: `update_get_settings`, `update_set_settings`, `update_check`,
//! `update_download`, `update_install`.  Progress is emitted as `omnia-update`
//! events (`available`, `progress`, `ready`, `error`).
//!
//! Trust model
//! * The feed URL is empty by default; with no URL nothing touches the network.
//! * Feed and installer URLs must be HTTPS (plain HTTP only for loopback, for
//!   local testing); redirects are held to the same rule.
//! * The manifest names the installer SHA-256 and size.  The download is
//!   streamed through SHA-256 and a size cap and is deleted on any mismatch.
//!   The hash is verified again immediately before launching, on a handle that
//!   denies writers on Windows, so the file cannot be swapped after the check.
//! * Only a file this process downloaded into `<app data>/updates/` can be
//!   launched; the renderer never supplies a path.
//! * Manifest `signature` is a base64 Ed25519 signature over canonical release
//!   metadata (see [`canonical_message`]), not just the digest, so a signed
//!   installer cannot be replayed as another version, platform, kind or size.
//!   The public key (base64, 32 bytes) is compiled in from the `OMNIA_UPDATE_PUBKEY`
//!   build-time env var, falling back to `UPDATE_PUBLIC_KEY` (empty: no release
//!   key exists yet).  Policy:
//!   - key valid: every download/install requires a valid signature.
//!   - key set but malformed (not base64 / not 32 bytes): FAIL CLOSED.  It is a
//!     configured-but-broken key; downloads/installs are refused and the
//!     unsigned opt-in is ignored.
//!   - no key: downloads/installs are refused unless the user explicitly turned
//!     on the persisted `allow_unsigned` setting (off by default).  Check-only
//!     still works and reports `signature_verified: false`.
//!
//! Consistency: a monotonically increasing settings *generation* is bumped on
//! every feed change (including A -> B -> A and clearing the feed).  A check
//! captures (generation, feed) at start; its result is committed as `Pending`
//! (with a unique candidate id) only if both still match, under the settings
//! lock, then the pending lock (the one lock order used everywhere).  Downloads
//! capture the candidate and re-check it, and re-authorize against the *current*
//! consent, before attaching the file; install re-authorizes the exact captured
//! candidate again.  Toggling `allow_unsigned` or auto-check keeps the pending
//! release; revoking consent still blocks download/install.
//!
//! `allow_unsigned` lives only in `update_settings.json`; it is never part of
//! data export/import, and a feed change resets it to off.

use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{NativeError, NativeResult};

pub const UPDATE_EVENT: &str = "omnia-update";
/// Base64 Ed25519 public key (32 bytes) that release signatures must verify
/// against (overridable at build time with `OMNIA_UPDATE_PUBKEY`).  Empty = no
/// key: downloads are refused unless the user opts in to unsigned updates.
pub const UPDATE_PUBLIC_KEY: &str = match option_env!("OMNIA_UPDATE_PUBKEY") {
    Some(key) => key,
    None => "",
};

const SETTINGS_FILE: &str = "update_settings.json";
const UPDATES_DIR: &str = "updates";
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_INSTALLER_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_NOTES_CHARS: usize = 8_000;
const AUTO_CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;
const MSI_HOLD: Duration = Duration::from_secs(3);
const STARTUP_DELAY: Duration = Duration::from_secs(8);

// ---------------------------------------------------------------- types

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    #[serde(default)]
    feed_url: String,
    #[serde(default)]
    auto_check: bool,
    #[serde(default)]
    last_checked_at: u64,
    /// User explicitly trusts this feed without release signatures.  Default off.
    #[serde(default)]
    allow_unsigned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsView {
    pub feed_url: String,
    pub auto_check: bool,
    pub current_version: String,
    /// A valid release-signing public key is compiled in (says nothing about any
    /// particular release: see `UpdateCheckResult::signature_verified`).
    pub key_configured: bool,
    /// A key is compiled in but malformed: all downloads/installs are refused.
    pub key_invalid: bool,
    /// First 16 hex chars of the SHA-256 of the compiled-in key, for checking a packaged build.
    pub key_fingerprint: Option<String>,
    /// Persisted opt-in to unsigned updates (only effective when no key is compiled in).
    pub allow_unsigned: bool,
    /// Unsigned updates are explicitly allowed AND effective (no key compiled in).
    pub unsigned_allowed: bool,
    /// Version found by the last successful check, when newer than current.
    pub available_version: Option<String>,
    /// Candidate id of that pending release.
    pub available_candidate: Option<u64>,
    /// Set by `update_set_settings` only: the save invalidated the pending release,
    /// so the UI must return to the "check" state.
    pub pending_reset: bool,
    pub generation: u64,
    pub platform: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsRequest {
    pub feed_url: String,
    pub auto_check: bool,
    /// `None` keeps the stored value.  A changed feed URL always resets it to off.
    #[serde(default)]
    pub allow_unsigned: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallerKind {
    Nsis,
    Msi,
}

impl InstallerKind {
    fn extension(self) -> &'static str {
        match self {
            Self::Nsis => "exe",
            Self::Msi => "msi",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Nsis => "nsis",
            Self::Msi => "msi",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct PlatformEntry {
    url: String,
    sha256: String,
    size: u64,
    #[serde(default)]
    signature: Option<String>,
    kind: InstallerKind,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub_date: Option<String>,
    platforms: HashMap<String, PlatformEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub notes: String,
    pub size: u64,
    /// This release's signature was verified against the compiled-in key.
    pub signature_verified: bool,
    /// Id of the pending candidate this check produced (events carry it too).
    pub candidate: u64,
    pub generation: u64,
    pub pub_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateEventKind {
    Available,
    Progress,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEvent {
    pub kind: UpdateEventKind,
    pub received: u64,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Candidate this event is about; the UI ignores events for any other candidate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<u64>,
    pub generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

impl UpdateEvent {
    fn new(kind: UpdateEventKind, received: u64, total: u64) -> Self {
        Self {
            kind,
            received,
            total,
            version: None,
            message: None,
            candidate: None,
            generation: 0,
            operation_id: None,
        }
    }

    fn for_candidate(kind: UpdateEventKind, received: u64, total: u64, candidate: u64) -> Self {
        Self {
            candidate: Some(candidate),
            ..Self::new(kind, received, total)
        }
    }
}

#[derive(Debug, Clone)]
struct Pending {
    /// Unique per committed check result.
    id: u64,
    /// Settings generation and feed the release was fetched under.
    generation: u64,
    feed: String,
    /// `CheckTicket::attempt` of the check that produced it.  A check that started
    /// earlier never replaces a candidate committed by a later-started one.
    attempt: u64,
    version: String,
    entry: PlatformEntry,
    available: bool,
    downloaded: Option<PathBuf>,
}

/// Interception points used by tests to force interleavings deterministically
/// (a no-op outside `cfg(test)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HookPoint {
    /// In `install_expected`, after hashing, before the final atomic policy decision.
    InstallBeforeFinalAuthorize,
    /// In `install_expected`, after the final decision, immediately before the launcher
    /// runs (the policy locks are held here).
    InstallAtLaunch,
}

#[cfg(test)]
type TestHook = std::sync::Arc<dyn Fn(HookPoint, &UpdateManager) + Send + Sync>;

/// Spawns the verified installer.  A function pointer so tests never launch one.
pub type InstallerLauncher =
    fn(&Path, InstallerKind) -> std::io::Result<Option<std::process::Child>>;

type Emit<'a> = &'a (dyn Fn(UpdateEvent) + Sync);

fn err(code: &'static str, message: impl Into<String>) -> NativeError {
    NativeError::new(code, message)
}

// ---------------------------------------------------------------- validation

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

fn url_allowed(url: &url::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => url.host_str().is_some_and(is_loopback_host),
        _ => false,
    }
}

fn parse_remote_url(text: &str, what: &str) -> NativeResult<url::Url> {
    let url = url::Url::parse(text.trim()).map_err(|_| {
        err(
            "update_invalid_url",
            format!("The {what} is not a valid URL"),
        )
    })?;
    if !url_allowed(&url) {
        return Err(err(
            "update_invalid_url",
            format!("The {what} must use https:// (http:// is allowed only for 127.0.0.1 or localhost) and contain no credentials"),
        ));
    }
    Ok(url)
}

fn platform_key() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn normalize_sha256(text: &str) -> Option<String> {
    let lower = text.trim().to_ascii_lowercase();
    (lower.len() == 64 && lower.bytes().all(|b| b.is_ascii_hexdigit())).then_some(lower)
}

/// Whether `latest` should be offered to a user running `current`.
/// Pre-releases are ignored unless the running build is itself a pre-release.
fn is_newer(current: &semver::Version, latest: &semver::Version) -> bool {
    if !latest.pre.is_empty() && current.pre.is_empty() {
        return false;
    }
    latest.cmp_precedence(current) == std::cmp::Ordering::Greater
}

/// Compiled-in key state, validated once at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
enum KeyState {
    /// No key configured.
    Absent,
    /// Valid Ed25519 public key (32 bytes).
    Valid(Vec<u8>),
    /// Configured but not base64 / not exactly 32 bytes.  Fails closed.
    Broken,
}

impl KeyState {
    fn parse(text: &str) -> Self {
        let text = text.trim();
        if text.is_empty() {
            return Self::Absent;
        }
        match STANDARD.decode(text) {
            Ok(bytes) if bytes.len() == 32 => Self::Valid(bytes),
            _ => Self::Broken,
        }
    }

    fn fingerprint(&self) -> Option<String> {
        match self {
            Self::Valid(bytes) => Some(hex(&Sha256::digest(bytes))[..16].to_owned()),
            _ => None,
        }
    }
}

/// The exact bytes that are signed and verified: UTF-8, fields joined with `\n`,
/// no trailing newline:
///
/// ```text
/// omnia-update-v1
/// {version}   semver Display of the parsed manifest version (no leading "v")
/// {platform}  the literal manifest platform key, lowercase ASCII, e.g. windows-x86_64
/// {kind}      "nsis" or "msi"
/// {size}      installer size, decimal u64 without leading zeros
/// {sha256}    64 lowercase hex characters
/// ```
fn canonical_message(
    version: &str,
    platform: &str,
    kind: InstallerKind,
    size: u64,
    sha256: &str,
) -> NativeResult<String> {
    let version_ok = semver::Version::parse(version).is_ok_and(|v| v.to_string() == version);
    let platform_ok = !platform.is_empty()
        && platform
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
    let sha_ok = sha256.len() == 64
        && sha256
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !version_ok || !platform_ok || !sha_ok {
        return Err(err(
            "update_signature",
            "The release metadata is not in canonical form",
        ));
    }
    Ok(format!(
        "omnia-update-v1\n{version}\n{platform}\n{}\n{size}\n{sha256}",
        kind.name()
    ))
}

fn verify_signature(key: &KeyState, message: &str, signature: Option<&str>) -> NativeResult<()> {
    let KeyState::Valid(key) = key else {
        return Err(err(
            "update_signature",
            "The built-in update signing key is missing or invalid",
        ));
    };
    let signature = signature
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| err("update_signature", "The update is not signed; refusing it"))?;
    let signature = STANDARD.decode(signature).map_err(|_| {
        err(
            "update_signature",
            "The update signature is not valid base64",
        )
    })?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(message.as_bytes(), &signature)
        .map_err(|_| {
            err(
                "update_signature",
                "The update signature does not match; refusing it",
            )
        })
}

fn open_for_verification(path: &Path) -> std::io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ only: nobody can write or delete while we hold it.
        options.share_mode(1);
    }
    options.open(path)
}

/// Re-hash the file on a handle that denies writers; return the open handle so
/// the caller can keep it locked while the installer starts.
fn verify_file(path: &Path, size: u64, sha256: &str) -> NativeResult<File> {
    let mut file = open_for_verification(path).map_err(|e| {
        err(
            "update_verify",
            format!("Cannot open the downloaded installer: {e}"),
        )
    })?;
    let length = file
        .metadata()
        .map_err(|e| {
            err(
                "update_verify",
                format!("Cannot inspect the downloaded installer: {e}"),
            )
        })?
        .len();
    if length != size {
        return Err(err(
            "update_verify",
            "The downloaded installer has the wrong size",
        ));
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| {
            err(
                "update_verify",
                format!("Cannot read the downloaded installer: {e}"),
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if hex(&hasher.finalize()) != sha256 {
        return Err(err(
            "update_verify",
            "The downloaded installer failed its SHA-256 check",
        ));
    }
    Ok(file)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `origin` is the URL the request starts at.  Redirects may never downgrade
/// HTTPS to HTTP, and plain-HTTP (loopback) hops are only followed when the
/// original URL was itself loopback.
fn http_client(origin: &url::Url) -> NativeResult<reqwest::Client> {
    let origin_loopback = origin.host_str().is_some_and(is_loopback_host);
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .user_agent(concat!("Omnia-Updater/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            let target = attempt.url();
            let downgrade = target.scheme() != "https"
                && (!origin_loopback || attempt.previous().iter().any(|u| u.scheme() == "https"));
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if url_allowed(target) && !downgrade {
                attempt.follow()
            } else {
                attempt.error("redirect target is not allowed")
            }
        }))
        .build()
        .map_err(|_| err("update_network", "Could not prepare the update connection"))
}

// ---------------------------------------------------------------- manager

struct PartGuard {
    path: PathBuf,
    armed: bool,
}

impl Drop for PartGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

struct DownloadFlag<'a>(&'a AtomicBool);

impl Drop for DownloadFlag<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// What a check captured when it began.
struct CheckTicket {
    generation: u64,
    feed: String,
    /// Strictly increasing per started check (assigned under the settings lock), so
    /// start order is total even for checks of the same feed and generation.
    attempt: u64,
}

pub struct UpdateManager {
    settings_path: PathBuf,
    updates_dir: PathBuf,
    current_version: String,
    key: KeyState,
    settings: Mutex<StoredSettings>,
    pending: Mutex<Option<Pending>>,
    /// Bumped (under the settings lock) on every feed change.
    generation: AtomicU64,
    next_candidate: AtomicU64,
    /// Source of `CheckTicket::attempt`.
    next_attempt: AtomicU64,
    downloading: AtomicBool,
    /// Test-only interception hook (see `HookPoint`).
    #[cfg(test)]
    test_hook: Mutex<Option<TestHook>>,
}

impl UpdateManager {
    pub fn new(app_data_dir: &Path, current_version: &str) -> Self {
        Self::with_public_key(app_data_dir, current_version, UPDATE_PUBLIC_KEY)
    }

    pub fn with_public_key(app_data_dir: &Path, current_version: &str, public_key: &str) -> Self {
        let settings_path = app_data_dir.join(SETTINGS_FILE);
        let settings: StoredSettings = fs::read_to_string(&settings_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self {
            settings_path,
            updates_dir: app_data_dir.join(UPDATES_DIR),
            current_version: current_version.to_owned(),
            key: KeyState::parse(public_key),
            settings: Mutex::new(settings),
            pending: Mutex::new(None),
            generation: AtomicU64::new(0),
            next_candidate: AtomicU64::new(0),
            next_attempt: AtomicU64::new(0),
            downloading: AtomicBool::new(false),
            #[cfg(test)]
            test_hook: Mutex::new(None),
        }
    }

    fn save(&self, settings: &StoredSettings) -> NativeResult<()> {
        if let Some(parent) = self.settings_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| NativeError::io("Could not prepare update settings storage", e))?;
        }
        let tmp = self.settings_path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(settings)
            .map_err(|_| err("update_settings", "Could not serialize update settings"))?;
        fs::write(&tmp, text).map_err(|e| NativeError::io("Could not save update settings", e))?;
        fs::rename(&tmp, &self.settings_path)
            .map_err(|e| NativeError::io("Could not save update settings", e))
    }

    fn lock_settings(&self) -> NativeResult<std::sync::MutexGuard<'_, StoredSettings>> {
        self.settings
            .lock()
            .map_err(|_| err("update_state", "Update settings are unavailable"))
    }

    fn lock_pending(&self) -> NativeResult<std::sync::MutexGuard<'_, Option<Pending>>> {
        self.pending
            .lock()
            .map_err(|_| err("update_state", "Update state is unavailable"))
    }

    /// Run the test hook, if any.  Compiled to nothing outside tests.
    #[allow(unused_variables)]
    fn hook(&self, point: HookPoint) {
        #[cfg(test)]
        {
            let hook = self.test_hook.lock().ok().and_then(|h| h.clone());
            if let Some(hook) = hook {
                hook(point, self);
            }
        }
    }

    pub fn get_settings(&self) -> NativeResult<UpdateSettingsView> {
        let settings = self.lock_settings()?;
        let (available_version, available_candidate) = self
            .lock_pending()?
            .as_ref()
            .filter(|p| p.available)
            .map_or((None, None), |p| (Some(p.version.clone()), Some(p.id)));
        let key_configured = matches!(self.key, KeyState::Valid(_));
        Ok(UpdateSettingsView {
            feed_url: settings.feed_url.clone(),
            auto_check: settings.auto_check,
            current_version: self.current_version.clone(),
            key_configured,
            key_invalid: self.key == KeyState::Broken,
            key_fingerprint: self.key.fingerprint(),
            allow_unsigned: settings.allow_unsigned,
            unsigned_allowed: settings.allow_unsigned && self.key == KeyState::Absent,
            available_version,
            available_candidate,
            pending_reset: false,
            generation: self.generation.load(Ordering::SeqCst),
            platform: platform_key(),
        })
    }

    pub fn set_settings(&self, request: UpdateSettingsRequest) -> NativeResult<UpdateSettingsView> {
        let feed = request.feed_url.trim();
        let normalized = if feed.is_empty() {
            String::new()
        } else {
            parse_remote_url(feed, "update feed URL")?.to_string()
        };
        let mut pending_reset = false;
        {
            // Lock order everywhere: settings, then pending.
            let mut settings = self.lock_settings()?;
            let changed = settings.feed_url != normalized;
            let mut next = settings.clone();
            next.feed_url = normalized;
            next.auto_check = request.auto_check;
            if let Some(allow) = request.allow_unsigned {
                next.allow_unsigned = allow;
            }
            if changed {
                next.last_checked_at = 0;
                // Trust in one feed never carries over to another.
                next.allow_unsigned = false;
            }
            self.save(&next)?;
            *settings = next;
            if changed {
                // A different feed (even A -> B -> A) invalidates whatever the previous one
                // offered, including checks and downloads still in flight.
                self.generation.fetch_add(1, Ordering::SeqCst);
                pending_reset = self.lock_pending()?.take().is_some();
            }
            // Auto-check and allow_unsigned changes keep the pending release; consent is
            // re-evaluated against the current settings at download/install time.
        }
        let mut view = self.get_settings()?;
        view.pending_reset = pending_reset;
        Ok(view)
    }

    pub fn auto_check_due(&self) -> bool {
        self.lock_settings().is_ok_and(|s| {
            s.auto_check
                && !s.feed_url.is_empty()
                && now_secs().saturating_sub(s.last_checked_at) >= AUTO_CHECK_INTERVAL_SECS
        })
    }

    /// Capture generation + feed at the start of a check.
    fn begin_check(&self) -> NativeResult<(CheckTicket, url::Url)> {
        let mut settings = self.lock_settings()?;
        if settings.feed_url.is_empty() {
            return Err(err(
                "update_not_configured",
                "No update feed URL is configured",
            ));
        }
        let feed_url = parse_remote_url(&settings.feed_url, "update feed URL")?;
        let ticket = CheckTicket {
            generation: self.generation.load(Ordering::SeqCst),
            feed: settings.feed_url.clone(),
            attempt: self.next_attempt.fetch_add(1, Ordering::SeqCst) + 1,
        };
        settings.last_checked_at = now_secs();
        let snapshot = settings.clone();
        let _ = self.save(&snapshot);
        Ok((ticket, feed_url))
    }

    /// Publish a finished check as the pending candidate, unless the feed/generation
    /// changed since the check began (then the result is discarded).
    fn commit_check(
        &self,
        ticket: &CheckTicket,
        version: String,
        entry: PlatformEntry,
        available: bool,
    ) -> NativeResult<Pending> {
        // Lock order: settings, then pending.  Both are held for the compare-and-publish so
        // the ordering decision and the write are one atomic step.
        let settings = self.lock_settings()?;
        if self.generation.load(Ordering::SeqCst) != ticket.generation
            || settings.feed_url != ticket.feed
        {
            return Err(err(
                "update_stale",
                "The update settings changed during the check; check again",
            ));
        }
        let mut slot = self.lock_pending()?;
        // Last *started* check wins, not last finished: an older check that completes
        // late must not overwrite (or reset the download of) a newer candidate.
        if slot
            .as_ref()
            .is_some_and(|p| p.generation == ticket.generation && p.attempt > ticket.attempt)
        {
            return Err(err(
                "update_stale",
                "A newer update check already finished; its result is kept",
            ));
        }
        let pending = Pending {
            id: self.next_candidate.fetch_add(1, Ordering::SeqCst) + 1,
            generation: ticket.generation,
            feed: ticket.feed.clone(),
            attempt: ticket.attempt,
            version,
            entry,
            available,
            downloaded: None,
        };
        *slot = Some(pending.clone());
        Ok(pending)
    }

    pub async fn check(&self) -> NativeResult<UpdateCheckResult> {
        let (ticket, feed_url) = self.begin_check()?;
        let feed_url_is_https = feed_url.scheme() == "https";
        let current = semver::Version::parse(&self.current_version).map_err(|_| {
            err(
                "update_manifest",
                "The running Omnia version is not a valid semantic version",
            )
        })?;

        let client = http_client(&feed_url)?;
        let response = tokio::time::timeout(Duration::from_secs(30), client.get(feed_url).send())
            .await
            .map_err(|_| err("update_network", "The update server did not answer in time"))?
            .map_err(|_| err("update_network", "Could not reach the update server"))?;
        if !response.status().is_success() {
            return Err(err(
                "update_network",
                format!(
                    "The update server answered HTTP {}",
                    response.status().as_u16()
                ),
            ));
        }
        if response
            .content_length()
            .is_some_and(|len| len as usize > MAX_MANIFEST_BYTES)
        {
            return Err(err("update_manifest", "The update manifest is too large"));
        }
        let mut body: Vec<u8> = Vec::new();
        let mut stream = response.bytes_stream();
        loop {
            let next = tokio::time::timeout(Duration::from_secs(30), stream.next())
                .await
                .map_err(|_| err("update_network", "The update server stalled"))?;
            let Some(chunk) = next else { break };
            let chunk =
                chunk.map_err(|_| err("update_network", "The update download was interrupted"))?;
            if body.len() + chunk.len() > MAX_MANIFEST_BYTES {
                return Err(err("update_manifest", "The update manifest is too large"));
            }
            body.extend_from_slice(&chunk);
        }
        let manifest: Manifest = serde_json::from_slice(&body)
            .map_err(|_| err("update_manifest", "The update manifest is not valid"))?;
        let latest =
            semver::Version::parse(manifest.version.trim_start_matches('v')).map_err(|_| {
                err(
                    "update_manifest",
                    "The update manifest has an invalid version",
                )
            })?;
        let entry = manifest
            .platforms
            .get(&platform_key())
            .cloned()
            .ok_or_else(|| {
                err(
                    "update_manifest",
                    format!("The update manifest has no build for {}", platform_key()),
                )
            })?;
        let entry_url = parse_remote_url(&entry.url, "installer URL")?;
        let sha = normalize_sha256(&entry.sha256).ok_or_else(|| {
            err(
                "update_manifest",
                "The installer SHA-256 in the manifest is invalid",
            )
        })?;
        if entry.size == 0 || entry.size > MAX_INSTALLER_BYTES {
            return Err(err(
                "update_manifest",
                "The installer size in the manifest is out of range",
            ));
        }
        // An HTTPS feed may not point at a plain-HTTP installer.
        if entry_url.scheme() != "https" && feed_url_is_https {
            return Err(err(
                "update_invalid_url",
                "The installer URL must be https:// when the feed is https://",
            ));
        }
        let entry = PlatformEntry {
            sha256: sha,
            ..entry
        };

        let available = is_newer(&current, &latest);
        let notes: String = manifest.notes.chars().take(MAX_NOTES_CHARS).collect();
        let version = latest.to_string();
        let signature_verified = self.signature_ok(&version, &entry).is_ok();
        let size = entry.size;
        let pending = self.commit_check(&ticket, version, entry, available)?;
        Ok(UpdateCheckResult {
            current: current.to_string(),
            latest: pending.version,
            available,
            notes,
            size,
            signature_verified,
            candidate: pending.id,
            generation: pending.generation,
            pub_date: manifest.pub_date,
        })
    }

    /// Signature half of the policy: valid only with a valid key and a matching signature.
    fn signature_ok(&self, version: &str, entry: &PlatformEntry) -> NativeResult<()> {
        let message = canonical_message(
            version,
            &platform_key(),
            entry.kind,
            entry.size,
            &entry.sha256,
        )?;
        verify_signature(&self.key, &message, entry.signature.as_deref())
    }

    /// Release policy gate (see module docs) evaluated against the *current* settings.
    /// The candidate must still belong to the current feed generation, so consent given
    /// to a replacement feed can never authorize a release fetched from an older one.
    fn authorize_locked(&self, settings: &StoredSettings, candidate: &Pending) -> NativeResult<()> {
        if self.generation.load(Ordering::SeqCst) != candidate.generation
            || settings.feed_url != candidate.feed
        {
            return Err(err(
                "update_stale",
                "The update feed changed; check for updates again",
            ));
        }
        match &self.key {
            KeyState::Broken => Err(err(
                "update_signature",
                "The built-in update signing key is invalid; updates are disabled",
            )),
            KeyState::Valid(_) => self.signature_ok(&candidate.version, &candidate.entry),
            KeyState::Absent => {
                if settings.allow_unsigned {
                    Ok(())
                } else {
                    Err(err(
                        "update_unsigned",
                        "This build has no update signing key, so updates are refused. Enable \"Allow unsigned updates\" only if you fully trust the feed",
                    ))
                }
            }
        }
    }

    /// Authorize exactly this candidate, which must also still be the pending one.
    fn authorize_candidate(&self, candidate: &Pending) -> NativeResult<()> {
        let settings = self.lock_settings()?;
        self.authorize_locked(&settings, candidate)?;
        match self.lock_pending()?.as_ref() {
            Some(p) if p.id == candidate.id => Ok(()),
            _ => Err(err(
                "update_stale",
                "The update was replaced; check for updates again",
            )),
        }
    }

    fn safe_file_name(version: &str, sha: &str, kind: InstallerKind, candidate_id: u64) -> String {
        let version: String = version
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        format!(
            "omnia-update-{version}-{}-{candidate_id}.{}",
            &sha[..12],
            kind.extension()
        )
    }

    /// Record a finished download on the candidate it was started for.  Rejected when
    /// the candidate was replaced/invalidated meanwhile or consent was revoked.
    fn attach_download(&self, candidate: &Pending, path: &Path) -> NativeResult<()> {
        let settings = self.lock_settings()?;
        self.authorize_locked(&settings, candidate)?;
        match self.lock_pending()?.as_mut() {
            Some(p) if p.id == candidate.id => {
                p.downloaded = Some(path.to_owned());
                Ok(())
            }
            _ => Err(err(
                "update_stale",
                "The update was replaced during the download; check again",
            )),
        }
    }

    fn expected_candidate(&self, expected_candidate_id: u64) -> NativeResult<Pending> {
        let pending = self
            .lock_pending()?
            .clone()
            .ok_or_else(|| err("update_state", "Check for updates first"))?;
        if pending.id != expected_candidate_id {
            return Err(err(
                "update_stale",
                "The displayed update was replaced; check again",
            ));
        }
        if !pending.available {
            return Err(err("update_state", "There is no available update"));
        }
        Ok(pending)
    }

    #[cfg(test)]
    async fn download(&self, emit: Emit<'_>) -> NativeResult<PathBuf> {
        let id = self.lock_pending()?.as_ref().map_or(0, |p| p.id);
        self.download_expected(id, emit).await
    }

    pub async fn download_expected(
        &self,
        expected_candidate_id: u64,
        emit: Emit<'_>,
    ) -> NativeResult<PathBuf> {
        let pending = self.expected_candidate(expected_candidate_id)?;
        if self.downloading.swap(true, Ordering::SeqCst) {
            return Err(err("update_state", "An update download is already running"));
        }
        let _flag = DownloadFlag(&self.downloading);

        let entry = pending.entry.clone();
        // Refuse unsigned/badly signed releases before spending bandwidth.
        self.authorize_candidate(&pending)?;
        let url = parse_remote_url(&entry.url, "installer URL")?;

        fs::create_dir_all(&self.updates_dir)
            .map_err(|e| NativeError::io("Could not prepare the updates folder", e))?;
        // Keep existing installers intact: one may be the pending candidate's
        // verified download or be held open by install_expected. Candidate-specific
        // names also prevent a retry from replacing a file already in use.
        let final_name =
            Self::safe_file_name(&pending.version, &entry.sha256, entry.kind, pending.id);
        let final_path = self.updates_dir.join(&final_name);
        let part_path = self.updates_dir.join(format!("{final_name}.part"));
        let mut guard = PartGuard {
            path: part_path.clone(),
            armed: true,
        };

        let client = http_client(&url)?;
        let response = tokio::time::timeout(Duration::from_secs(30), client.get(url).send())
            .await
            .map_err(|_| err("update_network", "The update server did not answer in time"))?
            .map_err(|_| err("update_network", "Could not reach the update server"))?;
        if !response.status().is_success() {
            return Err(err(
                "update_network",
                format!(
                    "The update server answered HTTP {}",
                    response.status().as_u16()
                ),
            ));
        }
        if response
            .content_length()
            .is_some_and(|len| len != entry.size)
        {
            return Err(err(
                "update_verify",
                "The installer size does not match the manifest",
            ));
        }

        let mut file = File::create(&part_path)
            .map_err(|e| NativeError::io("Could not create the installer file", e))?;
        let mut hasher = Sha256::new();
        let mut received: u64 = 0;
        let mut last_emit = Instant::now();
        let progress = |received: u64| {
            let mut event = UpdateEvent::for_candidate(
                UpdateEventKind::Progress,
                received,
                entry.size,
                pending.id,
            );
            event.generation = pending.generation;
            event
        };
        emit(progress(0));
        let mut stream = response.bytes_stream();
        loop {
            let next = tokio::time::timeout(Duration::from_secs(30), stream.next())
                .await
                .map_err(|_| err("update_network", "The update download stalled"))?;
            let Some(chunk) = next else { break };
            let chunk =
                chunk.map_err(|_| err("update_network", "The update download was interrupted"))?;
            received += chunk.len() as u64;
            if received > entry.size {
                return Err(err(
                    "update_verify",
                    "The installer is larger than the manifest says",
                ));
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .map_err(|e| NativeError::io("Could not write the installer file", e))?;
            if last_emit.elapsed() >= Duration::from_millis(100) {
                last_emit = Instant::now();
                emit(progress(received));
            }
        }
        file.flush()
            .map_err(|e| NativeError::io("Could not write the installer file", e))?;
        drop(file);
        if received != entry.size {
            return Err(err(
                "update_verify",
                "The installer is smaller than the manifest says",
            ));
        }
        if hex(&hasher.finalize()) != entry.sha256 {
            return Err(err(
                "update_verify",
                "The downloaded installer failed its SHA-256 check and was deleted",
            ));
        }
        // A stale or de-authorized candidate must not be finalized (the guard deletes the partial).
        self.authorize_candidate(&pending)?;
        let _ = fs::remove_file(&final_path);
        fs::rename(&part_path, &final_path)
            .map_err(|e| NativeError::io("Could not finalize the installer file", e))?;
        guard.armed = false;

        if let Err(error) = self.attach_download(&pending, &final_path) {
            let _ = fs::remove_file(&final_path);
            return Err(error);
        }
        let mut ready =
            UpdateEvent::for_candidate(UpdateEventKind::Ready, received, entry.size, pending.id);
        ready.generation = pending.generation;
        emit(ready);
        Ok(final_path)
    }

    /// Verify and launch the downloaded installer.  The caller exits the app
    /// afterwards.
    #[cfg(test)]
    fn install(
        &self,
        launcher: InstallerLauncher,
    ) -> NativeResult<Option<std::thread::JoinHandle<()>>> {
        let id = self.lock_pending()?.as_ref().map_or(0, |p| p.id);
        self.install_expected(id, launcher)
    }

    pub fn install_expected(
        &self,
        expected_candidate_id: u64,
        launcher: InstallerLauncher,
    ) -> NativeResult<Option<std::thread::JoinHandle<()>>> {
        let pending = self.expected_candidate(expected_candidate_id)?;
        let path = pending
            .downloaded
            .clone()
            .ok_or_else(|| err("update_state", "Download the update before installing it"))?;

        // Only files inside the updates folder may ever be launched.
        let root = dunce::canonicalize(&self.updates_dir).map_err(|_| {
            err(
                "update_install",
                "The updates folder is missing; download the update again",
            )
        })?;
        let canonical = dunce::canonicalize(&path).map_err(|_| {
            err(
                "update_install",
                "The downloaded installer is missing; download it again",
            )
        })?;
        let extension_ok = canonical
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case(pending.entry.kind.extension()));
        if !canonical.starts_with(&root)
            || canonical.parent() != Some(root.as_path())
            || !extension_ok
        {
            return Err(err(
                "update_install",
                "Refusing to launch a file outside the updates folder",
            ));
        }

        // Re-authorize the exact captured candidate against current consent/feed.
        self.authorize_candidate(&pending)?;
        // Keep this handle (denies writers on Windows) open across the spawn.
        //
        // Residual race (documented, not eliminated): there is no atomic "verify then
        // exec" on Windows.  The deny-write handle blocks other writers/renames while
        // it is held.  For NSIS it is released right after CreateProcess (the image
        // is already mapped); for MSI (msiexec opens the package slightly later) it
        // is held in a background thread until msiexec has run ~3 s or exited.  A
        // same-user attacker acting after the handle is released can still replace
        // the file before the installer has finished reading it.
        let locked = verify_file(&canonical, pending.entry.size, &pending.entry.sha256)?;
        // Consent may have been revoked or the candidate replaced while hashing.
        self.hook(HookPoint::InstallBeforeFinalAuthorize);
        // Final decision and launch are one critical section: holding the settings and
        // pending locks (same order as everywhere else) means `set_settings` (revoke,
        // feed change) and `commit_check` (replacement) cannot interleave between the
        // authorization that permits the launch and the launch itself.  Any change
        // that wins the race lands first and the launch is refused; any change that
        // loses it waits until the installer process has been created.
        let settings = self.lock_settings()?;
        self.authorize_locked(&settings, &pending)?;
        let slot = self.lock_pending()?;
        match slot.as_ref() {
            Some(p) if p.id == pending.id && p.downloaded.as_deref() == Some(path.as_path()) => {}
            _ => {
                return Err(err(
                    "update_stale",
                    "The update was replaced; check for updates again",
                ))
            }
        }
        self.hook(HookPoint::InstallAtLaunch);
        let launched = launcher(&canonical, pending.entry.kind);
        drop(slot);
        drop(settings);
        let child = launched.map_err(|e| NativeError::io("Could not start the installer", e))?;
        if let (InstallerKind::Msi, Some(mut child)) = (pending.entry.kind, child) {
            let holder = std::thread::spawn(move || {
                let _locked = locked;
                let started = Instant::now();
                while started.elapsed() < MSI_HOLD && matches!(child.try_wait(), Ok(None)) {
                    std::thread::sleep(Duration::from_millis(100));
                }
            });
            return Ok(Some(holder));
        }
        Ok(None)
    }
}

/// Start the real installer interactively (NSIS: normal wizard; MSI: passive UI).
pub fn spawn_installer(
    path: &Path,
    kind: InstallerKind,
) -> std::io::Result<Option<std::process::Child>> {
    #[cfg(windows)]
    {
        use std::process::Command;
        match kind {
            InstallerKind::Nsis => Command::new(path).spawn().map(Some),
            InstallerKind::Msi => Command::new(msiexec_path()?)
                .arg("/i")
                .arg(path)
                .arg("/passive")
                .spawn()
                .map(Some),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (path, kind);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Installing updates is only supported on Windows",
        ))
    }
}

/// Absolute `%SystemRoot%\System32\msiexec.exe` (never a PATH lookup).
#[cfg(windows)]
fn msiexec_path() -> std::io::Result<PathBuf> {
    let root = std::env::var_os("SystemRoot")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let exe = root.join("System32").join("msiexec.exe");
    if exe.is_file() {
        Ok(exe)
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "msiexec.exe was not found in the Windows system folder",
        ))
    }
}

// ---------------------------------------------------------------- commands

fn emit_event(app: &AppHandle, event: UpdateEvent) {
    let _ = app.emit(UPDATE_EVENT, event);
}

#[tauri::command]
pub fn update_get_settings(manager: State<'_, UpdateManager>) -> NativeResult<UpdateSettingsView> {
    manager.get_settings()
}

#[tauri::command]
pub fn update_set_settings(
    manager: State<'_, UpdateManager>,
    request: UpdateSettingsRequest,
) -> NativeResult<UpdateSettingsView> {
    manager.set_settings(request)
}

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    manager: State<'_, UpdateManager>,
) -> NativeResult<UpdateCheckResult> {
    let result = manager.check().await?;
    // A manual check lights the sidebar badge the same way the startup check does.
    if result.available {
        let mut event = UpdateEvent::for_candidate(
            UpdateEventKind::Available,
            0,
            result.size,
            result.candidate,
        );
        event.generation = result.generation;
        event.version = Some(result.latest.clone());
        emit_event(&app, event);
    }
    Ok(result)
}

#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    manager: State<'_, UpdateManager>,
    expected_candidate_id: u64,
    generation: u64,
    operation_id: String,
) -> NativeResult<()> {
    let emitter = app.clone();
    let operation = operation_id.clone();
    let result = manager
        .download_expected(expected_candidate_id, &move |mut event| {
            event.operation_id = Some(operation.clone());
            emit_event(&emitter, event);
        })
        .await;
    match result {
        Ok(_) => Ok(()),
        Err(error) => {
            let mut event =
                UpdateEvent::for_candidate(UpdateEventKind::Error, 0, 0, expected_candidate_id);
            event.generation = generation;
            event.operation_id = Some(operation_id);
            event.message = Some(error.message.clone());
            emit_event(&app, event);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    manager: State<'_, UpdateManager>,
    expected_candidate_id: u64,
) -> NativeResult<()> {
    if let Some(holder) = manager.install_expected(expected_candidate_id, spawn_installer)? {
        // Keep the app (and its deny-write handle) alive until msiexec has had time to open the package.
        let _ = tauri::async_runtime::spawn_blocking(move || holder.join()).await;
    }
    app.exit(0);
    Ok(())
}

/// Launch hook: daily background check when the user opted in.
pub fn start_on_launch(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        let manager = app.state::<UpdateManager>();
        if !manager.auto_check_due() {
            return;
        }
        if let Ok(result) = manager.check().await {
            if result.available
                && manager.get_settings().is_ok_and(|s| {
                    s.generation == result.generation
                        && s.available_candidate == Some(result.candidate)
                })
            {
                let mut event = UpdateEvent::for_candidate(
                    UpdateEventKind::Available,
                    0,
                    result.size,
                    result.candidate,
                );
                event.generation = result.generation;
                event.version = Some(result.latest);
                emit_event(&app, event);
            }
        }
    });
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        net::TcpListener,
        sync::Arc,
    };

    type Routes = Arc<Mutex<HashMap<String, Vec<u8>>>>;

    fn serve() -> (String, Routes) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let routes: Routes = Arc::new(Mutex::new(HashMap::new()));
        let shared = routes.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let routes = shared.clone();
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut request_line = String::new();
                    if reader.read_line(&mut request_line).is_err() {
                        return;
                    }
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                    }
                    let path = request_line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_owned();
                    let body = routes.lock().unwrap().get(&path).cloned();
                    let response = match body {
                        Some(body) => {
                            let mut out = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            )
                            .into_bytes();
                            out.extend(body);
                            out
                        }
                        None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
                    };
                    let _ = stream.write_all(&response);
                });
            }
        });
        (base, routes)
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omnia-update-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn sha_hex(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    fn manifest_json(
        version: &str,
        installer_url: &str,
        installer: &[u8],
        signature: Option<&str>,
    ) -> Vec<u8> {
        let mut entry = serde_json::json!({
            "url": installer_url,
            "sha256": sha_hex(installer),
            "size": installer.len(),
            "kind": "nsis",
        });
        if let Some(signature) = signature {
            entry["signature"] = signature.into();
        }
        serde_json::to_vec(&serde_json::json!({
            "version": version,
            "notes": "Fixes <b>things</b>",
            "pub_date": "2026-01-01T00:00:00Z",
            "platforms": { platform_key(): entry },
        }))
        .unwrap()
    }

    struct Fixture {
        dir: PathBuf,
        base: String,
        routes: Routes,
    }

    fn fixture(version: &str, installer: &[u8]) -> Fixture {
        let (base, routes) = serve();
        routes
            .lock()
            .unwrap()
            .insert("/installer.exe".into(), installer.to_vec());
        routes.lock().unwrap().insert(
            "/feed.json".into(),
            manifest_json(version, &format!("{base}/installer.exe"), installer, None),
        );
        Fixture {
            dir: temp_dir(),
            base,
            routes,
        }
    }

    /// Feed configured, no unsigned opt-in (the default policy).
    fn configured_strict(fixture: &Fixture, current: &str, key: &str) -> UpdateManager {
        let manager = UpdateManager::with_public_key(&fixture.dir, current, key);
        manager
            .set_settings(UpdateSettingsRequest {
                feed_url: format!("{}/feed.json", fixture.base),
                auto_check: false,
                allow_unsigned: None,
            })
            .unwrap();
        manager
    }

    /// Like `configured_strict`, plus the explicit unsigned opt-in when no key is compiled in.
    fn configured(fixture: &Fixture, current: &str, key: &str) -> UpdateManager {
        let manager = configured_strict(fixture, current, key);
        if key.is_empty() {
            manager
                .set_settings(UpdateSettingsRequest {
                    feed_url: manager.get_settings().unwrap().feed_url,
                    auto_check: false,
                    allow_unsigned: Some(true),
                })
                .unwrap();
        }
        manager
    }

    fn no_emit() -> impl Fn(UpdateEvent) + Sync {
        |_| {}
    }

    #[test]
    fn empty_feed_is_idle_and_makes_no_request() {
        let dir = temp_dir();
        let manager = UpdateManager::with_public_key(&dir, "1.0.0", "");
        let error = run(manager.check()).unwrap_err();
        assert_eq!(error.code, "update_not_configured");
        assert!(!manager.auto_check_due());
        assert!(manager.get_settings().unwrap().feed_url.is_empty());
    }

    #[test]
    fn feed_url_must_be_https_except_loopback() {
        let dir = temp_dir();
        let manager = UpdateManager::with_public_key(&dir, "1.0.0", "");
        let set = |url: &str| {
            manager.set_settings(UpdateSettingsRequest {
                feed_url: url.into(),
                auto_check: false,
                allow_unsigned: None,
            })
        };
        assert!(set("http://example.com/feed.json").is_err());
        assert!(set("ftp://example.com/feed.json").is_err());
        assert!(set("https://user:pw@example.com/feed.json").is_err());
        assert!(set("not a url").is_err());
        assert!(set("http://127.0.0.1:9/feed.json").is_ok());
        assert!(set("http://localhost:9/feed.json").is_ok());
        assert!(set("https://example.com/feed.json").is_ok());
        assert!(set("   ").is_ok());
        assert!(manager.get_settings().unwrap().feed_url.is_empty());
    }

    #[test]
    fn settings_persist_across_restart() {
        let dir = temp_dir();
        let manager = UpdateManager::with_public_key(&dir, "1.0.0", "");
        manager
            .set_settings(UpdateSettingsRequest {
                feed_url: "https://example.com/feed.json".into(),
                auto_check: true,
                allow_unsigned: None,
            })
            .unwrap();
        let reopened = UpdateManager::with_public_key(&dir, "1.0.0", "");
        let view = reopened.get_settings().unwrap();
        assert_eq!(view.feed_url, "https://example.com/feed.json");
        assert!(view.auto_check);
        assert!(!view.key_configured);
        assert!(reopened.auto_check_due());
    }

    #[test]
    fn semver_rules() {
        let v = |s: &str| semver::Version::parse(s).unwrap();
        assert!(is_newer(&v("0.1.0"), &v("0.1.1")));
        assert!(is_newer(&v("0.9.0"), &v("0.10.0")));
        assert!(!is_newer(&v("1.0.0"), &v("1.0.0")));
        assert!(!is_newer(&v("1.0.0"), &v("0.9.9")));
        assert!(
            !is_newer(&v("1.0.0"), &v("1.1.0-beta.1")),
            "pre-release ignored for stable users"
        );
        assert!(is_newer(&v("1.0.0-beta.1"), &v("1.0.0-beta.2")));
        assert!(is_newer(&v("1.0.0-beta.2"), &v("1.0.0")));
        assert!(
            !is_newer(&v("1.0.0+a"), &v("1.0.0+b")),
            "build metadata has no precedence"
        );
        assert!(is_newer(&v("1.0.0-rc.1"), &v("1.0.0-rc.1.1")));
    }

    #[test]
    fn check_reports_available_and_not_available() {
        let fx = fixture("1.2.0", b"installer-bytes");
        let manager = configured(&fx, "1.0.0", "");
        let result = run(manager.check()).unwrap();
        assert!(result.available);
        assert_eq!(result.latest, "1.2.0");
        assert_eq!(result.current, "1.0.0");
        assert_eq!(result.size, b"installer-bytes".len() as u64);
        assert_eq!(
            manager.get_settings().unwrap().available_version.as_deref(),
            Some("1.2.0")
        );

        let up_to_date = configured(&fx, "1.2.0", "");
        let result = run(up_to_date.check()).unwrap();
        assert!(!result.available);
        assert_eq!(up_to_date.get_settings().unwrap().available_version, None);
        // An up-to-date build cannot download anything.
        assert!(run(up_to_date.download(&no_emit())).is_err());
    }

    #[test]
    fn check_rejects_non_https_installer_and_missing_platform() {
        let fx = fixture("1.2.0", b"x");
        fx.routes.lock().unwrap().insert(
            "/feed.json".into(),
            manifest_json("1.2.0", "http://example.com/installer.exe", b"x", None),
        );
        let manager = configured(&fx, "1.0.0", "");
        assert_eq!(run(manager.check()).unwrap_err().code, "update_invalid_url");

        fx.routes.lock().unwrap().insert(
            "/feed.json".into(),
            serde_json::to_vec(&serde_json::json!({"version":"1.2.0","platforms":{}})).unwrap(),
        );
        assert_eq!(run(manager.check()).unwrap_err().code, "update_manifest");
        fx.routes
            .lock()
            .unwrap()
            .insert("/feed.json".into(), b"not json".to_vec());
        assert_eq!(run(manager.check()).unwrap_err().code, "update_manifest");
    }

    #[test]
    fn second_download_preserves_existing_candidate_and_installer_files() {
        let first_bytes = b"first installer";
        let second_bytes = b"second installer";
        let fx = fixture("1.2.0", first_bytes);
        let manager = configured(&fx, "1.0.0", "");
        let first = run(manager.check()).unwrap();
        let first_path = run(manager.download_expected(first.candidate, &no_emit())).unwrap();

        // Model an installer file being held by an in-flight install. Cleanup for
        // a later candidate must not remove any regular file in the update folder.
        let held_path = fx.dir.join("updates").join("in-flight-installer.exe");
        fs::write(&held_path, b"held installer").unwrap();
        fx.routes
            .lock()
            .unwrap()
            .insert("/installer.exe".into(), second_bytes.to_vec());
        fx.routes.lock().unwrap().insert(
            "/feed.json".into(),
            manifest_json(
                "1.3.0",
                &format!("{}/installer.exe", fx.base),
                second_bytes,
                None,
            ),
        );
        let second = run(manager.check()).unwrap();
        let second_path = run(manager.download_expected(second.candidate, &no_emit())).unwrap();

        assert_ne!(
            first_path, second_path,
            "candidate downloads must have distinct paths"
        );
        assert_eq!(fs::read(&first_path).unwrap(), first_bytes);
        assert_eq!(fs::read(&held_path).unwrap(), b"held installer");
        assert_eq!(fs::read(&second_path).unwrap(), second_bytes);
    }

    #[test]
    fn download_verifies_and_reports_progress() {
        let installer = vec![7u8; 300_000];
        let fx = fixture("1.2.0", &installer);
        let manager = configured(&fx, "1.0.0", "");
        run(manager.check()).unwrap();
        let events = Mutex::new(Vec::new());
        let path = run(manager.download(&|e| events.lock().unwrap().push(e))).unwrap();
        assert_eq!(fs::read(&path).unwrap(), installer);
        assert!(path.starts_with(fx.dir.join("updates")));
        let events = events.lock().unwrap();
        assert_eq!(events.last().unwrap().kind, UpdateEventKind::Ready);
        assert_eq!(events.last().unwrap().received, installer.len() as u64);
        assert!(events.iter().any(|e| e.kind == UpdateEventKind::Progress));
        let leftovers: Vec<_> = fs::read_dir(fx.dir.join("updates"))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(leftovers.len(), 1, "no .part file remains");
    }

    #[test]
    fn tampered_download_is_refused_and_partial_deleted() {
        let fx = fixture("1.2.0", b"genuine-installer");
        let manager = configured(&fx, "1.0.0", "");
        run(manager.check()).unwrap();
        // Same length, different bytes.
        fx.routes
            .lock()
            .unwrap()
            .insert("/installer.exe".into(), b"tampered-installer".to_vec());
        let error = run(manager.download(&no_emit())).unwrap_err();
        assert_eq!(error.code, "update_verify");
        let remaining: Vec<_> = fs::read_dir(fx.dir.join("updates"))
            .unwrap()
            .flatten()
            .collect();
        assert!(remaining.is_empty(), "partial file must be deleted");
        assert_eq!(
            manager.install(|_, _| Ok(None)).unwrap_err().code,
            "update_state"
        );

        // Wrong size is also refused.
        fx.routes
            .lock()
            .unwrap()
            .insert("/installer.exe".into(), b"short".to_vec());
        assert_eq!(
            run(manager.download(&no_emit())).unwrap_err().code,
            "update_verify"
        );
        assert!(fs::read_dir(fx.dir.join("updates"))
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn install_launches_only_verified_file_in_updates_dir() {
        use std::sync::atomic::AtomicUsize;
        static LAUNCHES: AtomicUsize = AtomicUsize::new(0);
        fn fake(path: &Path, kind: InstallerKind) -> std::io::Result<Option<std::process::Child>> {
            assert_eq!(kind, InstallerKind::Nsis);
            assert!(path.exists());
            LAUNCHES.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        }
        let fx = fixture("1.2.0", b"good-installer");
        let manager = configured(&fx, "1.0.0", "");
        assert_eq!(manager.install(fake).unwrap_err().code, "update_state");
        run(manager.check()).unwrap();
        assert_eq!(
            manager.install(fake).unwrap_err().code,
            "update_state",
            "not downloaded yet"
        );
        let path = run(manager.download(&no_emit())).unwrap();

        // Swap the bytes after download: the re-verification must refuse.
        fs::write(&path, b"evil-installer!").unwrap();
        assert_eq!(manager.install(fake).unwrap_err().code, "update_verify");
        assert_eq!(LAUNCHES.load(Ordering::SeqCst), 0);
        fs::write(&path, b"good-installer").unwrap();
        manager.install(fake).unwrap();
        assert_eq!(LAUNCHES.load(Ordering::SeqCst), 1);

        // A path outside the updates folder is never launched, even with a valid hash.
        let outside = fx.dir.join("outside.exe");
        fs::write(&outside, b"good-installer").unwrap();
        manager.pending.lock().unwrap().as_mut().unwrap().downloaded = Some(outside.clone());
        assert_eq!(manager.install(fake).unwrap_err().code, "update_install");
        // Traversal that resolves outside is also refused.
        let sneaky = fx.dir.join("updates").join("..").join("outside.exe");
        manager.pending.lock().unwrap().as_mut().unwrap().downloaded = Some(sneaky);
        assert_eq!(manager.install(fake).unwrap_err().code, "update_install");
        assert_eq!(LAUNCHES.load(Ordering::SeqCst), 1);
    }

    // ---- signing fixture ----
    //
    // Canonical signed message (exact bytes, UTF-8, "\n"-joined, no trailing newline):
    //   omnia-update-v1\n{version}\n{platform}\n{kind}\n{size}\n{sha256-lowercase-hex}
    // e.g. "omnia-update-v1\n1.2.0\nwindows-x86_64\nnsis\n16\n<64 hex>".

    struct Signer {
        pair: ring::signature::Ed25519KeyPair,
        public: String,
    }

    fn signer(seed: u8) -> Signer {
        let pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap();
        let public = STANDARD.encode(ring::signature::KeyPair::public_key(&pair).as_ref());
        Signer { pair, public }
    }

    impl Signer {
        fn sign_message(&self, message: &str) -> String {
            STANDARD.encode(self.pair.sign(message.as_bytes()).as_ref())
        }

        fn sign(&self, version: &str, kind: InstallerKind, size: u64, sha: &str) -> String {
            self.sign_message(&format!(
                "omnia-update-v1\n{version}\n{}\n{}\n{size}\n{sha}",
                platform_key(),
                kind.name()
            ))
        }
    }

    fn serve_signed(fx: &Fixture, installer: &[u8], signature: &str) {
        fx.routes.lock().unwrap().insert(
            "/feed.json".into(),
            manifest_json(
                "1.2.0",
                &format!("{}/installer.exe", fx.base),
                installer,
                Some(signature),
            ),
        );
        fx.routes
            .lock()
            .unwrap()
            .insert("/installer.exe".into(), installer.to_vec());
    }

    fn set_allow(manager: &UpdateManager, allow: bool) -> UpdateSettingsView {
        manager
            .set_settings(UpdateSettingsRequest {
                feed_url: manager.get_settings().unwrap().feed_url,
                auto_check: false,
                allow_unsigned: Some(allow),
            })
            .unwrap()
    }

    #[test]
    fn canonical_message_is_exact() {
        let sha = "a".repeat(64);
        let message =
            canonical_message("1.2.0", "windows-x86_64", InstallerKind::Msi, 42, &sha).unwrap();
        assert_eq!(
            message,
            format!("omnia-update-v1\n1.2.0\nwindows-x86_64\nmsi\n42\n{sha}")
        );
        assert!(!message.ends_with('\n'));
        assert!(canonical_message(
            "1.2.0",
            "windows-x86_64",
            InstallerKind::Nsis,
            1,
            &"A".repeat(64)
        )
        .is_err());
        assert!(
            canonical_message("v1.2.0", "windows-x86_64", InstallerKind::Nsis, 1, &sha).is_err()
        );
        assert!(
            canonical_message("1.2.0", "Windows-x86_64", InstallerKind::Nsis, 1, &sha).is_err()
        );
        assert!(
            canonical_message("1.2.0", "windows-x86_64", InstallerKind::Nsis, 1, "abc").is_err()
        );
    }

    #[test]
    fn no_key_fails_closed_by_default() {
        let fx = fixture("1.2.0", b"unsigned-installer");
        let manager = configured_strict(&fx, "1.0.0", "");
        let view = manager.get_settings().unwrap();
        assert!(
            !view.key_configured
                && !view.unsigned_allowed
                && !view.allow_unsigned
                && !view.key_invalid
                && view.key_fingerprint.is_none()
        );
        // Check-only still works and reports unsigned.
        let result = run(manager.check()).unwrap();
        assert!(result.available && !result.signature_verified);
        assert_eq!(
            run(manager.download(&no_emit())).unwrap_err().code,
            "update_unsigned"
        );
        assert!(
            !fx.dir.join("updates").exists()
                || fs::read_dir(fx.dir.join("updates"))
                    .unwrap()
                    .next()
                    .is_none()
        );
        assert_eq!(
            manager.install(|_, _| Ok(None)).unwrap_err().code,
            "update_state"
        );
    }

    #[test]
    fn explicit_opt_in_allows_unsigned_and_is_per_feed() {
        let fx = fixture("1.2.0", b"unsigned-installer");
        let manager = configured(&fx, "1.0.0", "");
        assert!(manager.get_settings().unwrap().allow_unsigned);
        run(manager.check()).unwrap();
        run(manager.download(&no_emit())).unwrap();
        manager.install(|_, _| Ok(None)).unwrap();

        // Persisted across restart (update_settings.json only).
        let reopened = UpdateManager::with_public_key(&fx.dir, "1.0.0", "");
        assert!(reopened.get_settings().unwrap().allow_unsigned);

        // Omitting the field keeps it; changing the feed resets it to off.
        let feed = manager.get_settings().unwrap().feed_url;
        let kept = manager
            .set_settings(UpdateSettingsRequest {
                feed_url: feed,
                auto_check: true,
                allow_unsigned: None,
            })
            .unwrap();
        assert!(kept.allow_unsigned);
        let moved = manager
            .set_settings(UpdateSettingsRequest {
                feed_url: "https://other.example.com/feed.json".into(),
                auto_check: true,
                allow_unsigned: None,
            })
            .unwrap();
        assert!(!moved.allow_unsigned);
        assert!(!set_allow(&manager, false).allow_unsigned);
    }

    #[test]
    fn valid_key_requires_valid_signature_and_ignores_opt_in() {
        let signer = signer(9);
        let installer = b"signed-installer";
        let sha = sha_hex(installer);
        let good = signer.sign("1.2.0", InstallerKind::Nsis, installer.len() as u64, &sha);

        let fx = fixture("1.2.0", installer);
        let manager = configured(&fx, "1.0.0", &signer.public);
        let view = manager.get_settings().unwrap();
        assert!(view.key_configured && !view.key_invalid);
        let fingerprint = view.key_fingerprint.unwrap();
        assert_eq!(fingerprint.len(), 16);
        assert!(fingerprint.bytes().all(|b| b.is_ascii_hexdigit()));
        // A configured key does not make an unsigned release verified.
        assert!(!run(manager.check()).unwrap().signature_verified);
        // Unsigned manifest refused before any bytes are fetched.
        assert_eq!(
            run(manager.download(&no_emit())).unwrap_err().code,
            "update_signature"
        );
        // Opting in cannot override a compiled-in key.
        set_allow(&manager, true);
        run(manager.check()).unwrap();
        assert_eq!(
            run(manager.download(&no_emit())).unwrap_err().code,
            "update_signature"
        );

        serve_signed(&fx, installer, &good);
        assert!(run(manager.check()).unwrap().signature_verified);
        run(manager.download(&no_emit())).unwrap();
        manager.install(|_, _| Ok(None)).unwrap();
    }

    #[test]
    fn signature_binds_version_kind_size_platform_and_key() {
        let signer = signer(9);
        let installer = b"signed-installer";
        let size = installer.len() as u64;
        let sha = sha_hex(installer);
        let fx = fixture("1.2.0", installer);
        let manager = configured(&fx, "1.0.0", &signer.public);
        let bad = [
            signer.sign("1.2.1", InstallerKind::Nsis, size, &sha),
            signer.sign("1.2.0", InstallerKind::Msi, size, &sha),
            signer.sign("1.2.0", InstallerKind::Nsis, size + 1, &sha),
            signer.sign("1.2.0", InstallerKind::Nsis, size, &sha_hex(b"other")),
            self::signer(1).sign("1.2.0", InstallerKind::Nsis, size, &sha),
            signer.sign_message(&format!(
                "omnia-update-v1\n1.2.0\nlinux-arm\nnsis\n{size}\n{sha}"
            )),
            // Digest-only signatures (the old format) are no longer accepted.
            signer.sign_message(&sha),
            "!!!".to_owned(),
        ];
        for signature in &bad {
            serve_signed(&fx, installer, signature);
            run(manager.check()).unwrap();
            assert_eq!(
                run(manager.download(&no_emit())).unwrap_err().code,
                "update_signature"
            );
        }
    }

    #[test]
    fn invalid_key_fails_closed_even_with_opt_in() {
        let keys = [
            "c2hvcnQ=".to_owned(),
            "not base64 at all!".to_owned(),
            STANDARD.encode([0u8; 31]),
            STANDARD.encode([0u8; 33]),
        ];
        for bad_key in &keys {
            let fx = fixture("1.2.0", b"installer-bytes");
            let manager = configured(&fx, "1.0.0", bad_key);
            let view = set_allow(&manager, true);
            assert!(view.key_invalid && !view.key_configured && view.key_fingerprint.is_none());
            run(manager.check()).unwrap();
            assert_eq!(
                run(manager.download(&no_emit())).unwrap_err().code,
                "update_signature"
            );
        }
    }

    #[test]
    fn https_feed_cannot_name_plain_http_installer() {
        // The local-test case (loopback feed, loopback installer) stays allowed...
        let fx = fixture("1.2.0", b"x");
        let manager = configured(&fx, "1.0.0", "");
        assert!(run(manager.check()).is_ok());
        // ...and clients can be built for both origin kinds (redirect rules are enforced in the policy closure).
        assert!(http_client(&url::Url::parse("https://example.com/f").unwrap()).is_ok());
        assert!(http_client(&url::Url::parse("http://127.0.0.1:1/f").unwrap()).is_ok());
    }

    // ---- feed/consent generation (no network) ----

    const FEED_A: &str = "https://a.example.com/feed.json";
    const FEED_B: &str = "https://b.example.com/feed.json";
    const INSTALLER: &[u8] = b"offline-installer";

    fn offline_manager(feed: &str) -> (UpdateManager, PathBuf) {
        let dir = temp_dir();
        let manager = UpdateManager::with_public_key(&dir, "1.0.0", "");
        feed_to(&manager, feed, false, None);
        (manager, dir)
    }

    fn feed_to(
        manager: &UpdateManager,
        feed: &str,
        auto_check: bool,
        allow: Option<bool>,
    ) -> UpdateSettingsView {
        manager
            .set_settings(UpdateSettingsRequest {
                feed_url: feed.into(),
                auto_check,
                allow_unsigned: allow,
            })
            .unwrap()
    }

    fn offline_commit(
        manager: &UpdateManager,
        ticket: &CheckTicket,
        version: &str,
    ) -> NativeResult<Pending> {
        let entry = PlatformEntry {
            url: "https://a.example.com/installer.exe".into(),
            sha256: sha_hex(INSTALLER),
            size: INSTALLER.len() as u64,
            signature: None,
            kind: InstallerKind::Nsis,
        };
        manager.commit_check(ticket, version.into(), entry, true)
    }

    fn offline_check(manager: &UpdateManager, version: &str) -> Pending {
        let (ticket, _) = manager.begin_check().unwrap();
        offline_commit(manager, &ticket, version).unwrap()
    }

    /// Put the installer where `download` would, so `install` can run offline.
    fn place_installer(dir: &Path, pending: &Pending) -> PathBuf {
        let updates = dir.join(UPDATES_DIR);
        fs::create_dir_all(&updates).unwrap();
        let path = updates.join(UpdateManager::safe_file_name(
            &pending.version,
            &pending.entry.sha256,
            pending.entry.kind,
            pending.id,
        ));
        fs::write(&path, INSTALLER).unwrap();
        path
    }

    #[test]
    fn delayed_check_result_is_discarded_after_feed_change() {
        let (manager, _dir) = offline_manager(FEED_A);
        let (ticket, _) = manager.begin_check().unwrap();
        feed_to(&manager, FEED_B, false, Some(true));
        assert_eq!(
            offline_commit(&manager, &ticket, "1.2.0").unwrap_err().code,
            "update_stale"
        );
        assert_eq!(manager.get_settings().unwrap().available_version, None);

        // Clearing the feed is also a change.
        let (ticket, _) = manager.begin_check().unwrap();
        feed_to(&manager, "", false, None);
        assert_eq!(
            offline_commit(&manager, &ticket, "1.2.0").unwrap_err().code,
            "update_stale"
        );
        assert_eq!(manager.get_settings().unwrap().available_version, None);
    }

    #[test]
    fn feed_change_a_b_a_still_discards_the_old_check() {
        let (manager, _dir) = offline_manager(FEED_A);
        let (ticket, _) = manager.begin_check().unwrap();
        feed_to(&manager, FEED_B, false, None);
        feed_to(&manager, FEED_A, false, None);
        assert_eq!(manager.get_settings().unwrap().feed_url, FEED_A);
        assert_eq!(
            offline_commit(&manager, &ticket, "1.2.0").unwrap_err().code,
            "update_stale"
        );
        assert_eq!(manager.get_settings().unwrap().available_version, None);
    }

    #[test]
    fn stale_download_completion_does_not_attach_to_new_pending() {
        let (manager, dir) = offline_manager(FEED_A);
        feed_to(&manager, FEED_A, false, Some(true));
        let old = offline_check(&manager, "1.2.0");
        let path = place_installer(&dir, &old);
        // A concurrent check replaces the pending candidate while the old download runs.
        let replacement = offline_check(&manager, "1.3.0");
        assert_ne!(old.id, replacement.id);
        assert_eq!(
            manager.attach_download(&old, &path).unwrap_err().code,
            "update_stale"
        );
        assert!(manager
            .pending
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .downloaded
            .is_none());
        assert_eq!(
            manager.get_settings().unwrap().available_candidate,
            Some(replacement.id)
        );
        assert_eq!(
            manager.install(|_, _| Ok(None)).unwrap_err().code,
            "update_state"
        );

        // A feed change (A -> B -> A) after the replacement also rejects it.
        feed_to(&manager, FEED_B, false, None);
        feed_to(&manager, FEED_A, false, Some(true));
        assert_eq!(
            manager
                .attach_download(&replacement, &path)
                .unwrap_err()
                .code,
            "update_stale"
        );
        assert!(manager.pending.lock().unwrap().is_none());
    }

    #[test]
    fn consent_granted_after_feed_change_does_not_authorize_old_release() {
        let (manager, dir) = offline_manager(FEED_A);
        let old = offline_check(&manager, "1.2.0");
        let path = place_installer(&dir, &old);
        let view = feed_to(&manager, FEED_B, false, None);
        assert!(view.pending_reset && !view.allow_unsigned);
        // Consent granted to the replacement feed afterwards.
        assert!(feed_to(&manager, FEED_B, false, Some(true)).allow_unsigned);
        assert_eq!(
            manager.authorize_candidate(&old).unwrap_err().code,
            "update_stale"
        );
        assert_eq!(
            manager.attach_download(&old, &path).unwrap_err().code,
            "update_stale"
        );
        assert_eq!(
            manager.install(|_, _| Ok(None)).unwrap_err().code,
            "update_state"
        );
        // A release found on the new feed is authorized by that consent.
        let fresh = offline_check(&manager, "1.2.0");
        manager.authorize_candidate(&fresh).unwrap();
    }

    #[test]
    fn auto_check_toggle_preserves_pending_but_feed_change_resets_it() {
        let (manager, _dir) = offline_manager(FEED_A);
        let pending = offline_check(&manager, "1.2.0");
        let view = feed_to(&manager, FEED_A, true, None);
        assert!(!view.pending_reset && view.auto_check);
        assert_eq!(view.available_candidate, Some(pending.id));
        assert_eq!(view.available_version.as_deref(), Some("1.2.0"));
        let view = feed_to(&manager, FEED_A, false, Some(true));
        assert!(
            !view.pending_reset && view.available_candidate == Some(pending.id),
            "allow_unsigned toggle keeps pending"
        );
        let view = feed_to(&manager, FEED_B, false, None);
        assert!(view.pending_reset && view.available_version.is_none());
    }

    #[test]
    fn revoking_consent_blocks_download_and_install_of_kept_pending() {
        let (manager, dir) = offline_manager(FEED_A);
        feed_to(&manager, FEED_A, false, Some(true));
        let pending = offline_check(&manager, "1.2.0");
        let path = place_installer(&dir, &pending);

        // Revoked while the download was running: it must not attach.
        feed_to(&manager, FEED_A, false, Some(false));
        assert_eq!(
            manager.attach_download(&pending, &path).unwrap_err().code,
            "update_unsigned"
        );
        assert!(manager
            .pending
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .downloaded
            .is_none());

        // Granted again: attaches; then revoked: install is denied but pending is kept.
        feed_to(&manager, FEED_A, false, Some(true));
        manager.attach_download(&pending, &path).unwrap();
        feed_to(&manager, FEED_A, false, Some(false));
        assert!(
            manager.get_settings().unwrap().available_version.is_some(),
            "pending kept"
        );
        assert_eq!(
            manager.install(|_, _| Ok(None)).unwrap_err().code,
            "update_unsigned"
        );
        feed_to(&manager, FEED_A, false, Some(true));
        manager.install(|_, _| Ok(None)).unwrap();
    }

    // ---- concurrency regressions (deterministic, no network) ----

    fn set_hook(
        manager: &UpdateManager,
        hook: impl Fn(HookPoint, &UpdateManager) + Send + Sync + 'static,
    ) {
        *manager.test_hook.lock().unwrap() = Some(std::sync::Arc::new(hook));
    }

    /// Consent granted, candidate checked and downloaded: ready to install.
    fn installable(feed: &str) -> (UpdateManager, PathBuf, Pending) {
        let (manager, dir) = offline_manager(feed);
        feed_to(&manager, feed, false, Some(true));
        let pending = offline_check(&manager, "1.2.0");
        let path = place_installer(&dir, &pending);
        manager.attach_download(&pending, &path).unwrap();
        (manager, dir, pending)
    }

    #[test]
    fn older_same_feed_check_finishing_late_does_not_overwrite_newer_candidate() {
        let (manager, dir) = offline_manager(FEED_A);
        feed_to(&manager, FEED_A, false, Some(true));
        // Two checks of the same feed and generation start in order: old, then new.
        let (old_ticket, _) = manager.begin_check().unwrap();
        let (new_ticket, _) = manager.begin_check().unwrap();
        assert_eq!(old_ticket.generation, new_ticket.generation);
        assert!(new_ticket.attempt > old_ticket.attempt);

        // The newer one finishes first and its candidate gets downloaded.
        let newer = offline_commit(&manager, &new_ticket, "1.3.0").unwrap();
        let path = place_installer(&dir, &newer);
        manager.attach_download(&newer, &path).unwrap();

        // The older one finishes late: refused, nothing about the newer candidate changes.
        assert_eq!(
            offline_commit(&manager, &old_ticket, "1.2.0")
                .unwrap_err()
                .code,
            "update_stale"
        );
        let slot = manager.pending.lock().unwrap().clone().unwrap();
        assert_eq!((slot.id, slot.version.as_str()), (newer.id, "1.3.0"));
        assert_eq!(
            slot.downloaded.as_deref(),
            Some(path.as_path()),
            "download of the newer candidate is kept"
        );
        assert_eq!(
            manager.get_settings().unwrap().available_candidate,
            Some(newer.id)
        );
        manager.install_expected(newer.id, |_, _| Ok(None)).unwrap();

        // In-order completion still works, and a check started later replaces normally.
        let (a, _) = manager.begin_check().unwrap();
        let (b, _) = manager.begin_check().unwrap();
        offline_commit(&manager, &a, "1.4.0").unwrap();
        let latest = offline_commit(&manager, &b, "1.5.0").unwrap();
        assert_eq!(
            manager.get_settings().unwrap().available_candidate,
            Some(latest.id)
        );
    }

    #[test]
    fn older_check_racing_on_threads_never_overwrites_newer_candidate() {
        use std::sync::{mpsc, Arc};
        let (manager, _dir) = offline_manager(FEED_A);
        let manager = Arc::new(manager);
        let (old_ticket, _) = manager.begin_check().unwrap();
        let (new_ticket, _) = manager.begin_check().unwrap();
        // Force the order "newer commits, then older commits" across two threads.
        let (newer_done_tx, newer_done_rx) = mpsc::channel::<u64>();
        let m = manager.clone();
        let newer = std::thread::spawn(move || {
            let id = offline_commit(&m, &new_ticket, "1.3.0").unwrap().id;
            newer_done_tx.send(id).unwrap();
        });
        let m = manager.clone();
        let older = std::thread::spawn(move || {
            let newer_id = newer_done_rx.recv().unwrap();
            (
                newer_id,
                offline_commit(&m, &old_ticket, "1.2.0").map(|p| p.id),
            )
        });
        newer.join().unwrap();
        let (newer_id, older_result) = older.join().unwrap();
        assert_eq!(older_result.unwrap_err().code, "update_stale");
        assert_eq!(
            manager.get_settings().unwrap().available_candidate,
            Some(newer_id)
        );
        assert_eq!(
            manager.get_settings().unwrap().available_version.as_deref(),
            Some("1.3.0")
        );
    }

    #[test]
    fn revoke_between_hash_and_launch_blocks_the_launch() {
        use std::sync::atomic::AtomicUsize;
        static LAUNCHES: AtomicUsize = AtomicUsize::new(0);
        fn fake(_: &Path, _: InstallerKind) -> std::io::Result<Option<std::process::Child>> {
            LAUNCHES.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        }
        let (manager, _dir, pending) = installable(FEED_A);
        set_hook(&manager, |point, m| {
            if point == HookPoint::InstallBeforeFinalAuthorize {
                feed_to(m, FEED_A, false, Some(false));
            }
        });
        assert_eq!(
            manager.install_expected(pending.id, fake).unwrap_err().code,
            "update_unsigned"
        );
        assert_eq!(LAUNCHES.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn replacement_or_feed_change_between_hash_and_launch_blocks_the_launch() {
        use std::sync::atomic::AtomicUsize;
        static LAUNCHES: AtomicUsize = AtomicUsize::new(0);
        fn fake(_: &Path, _: InstallerKind) -> std::io::Result<Option<std::process::Child>> {
            LAUNCHES.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        }
        // A newer check replaces the candidate at the last moment.
        let (manager, _dir, pending) = installable(FEED_A);
        set_hook(&manager, |point, m| {
            if point == HookPoint::InstallBeforeFinalAuthorize {
                offline_check(m, "1.3.0");
            }
        });
        assert_eq!(
            manager.install_expected(pending.id, fake).unwrap_err().code,
            "update_stale"
        );

        // The feed is switched away and back (A -> B -> A, consent re-granted).
        let (manager, _dir, pending) = installable(FEED_A);
        set_hook(&manager, |point, m| {
            if point == HookPoint::InstallBeforeFinalAuthorize {
                feed_to(m, FEED_B, false, None);
                feed_to(m, FEED_A, false, Some(true));
            }
        });
        assert_eq!(
            manager.install_expected(pending.id, fake).unwrap_err().code,
            "update_stale"
        );
        assert_eq!(LAUNCHES.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn launch_runs_inside_the_policy_critical_section() {
        use std::sync::{atomic::AtomicUsize, Arc};
        // The launcher is a fn pointer, so it reaches the manager through statics.
        static MANAGER: Mutex<Option<Arc<UpdateManager>>> = Mutex::new(None);
        static LOCKS_HELD: AtomicUsize = AtomicUsize::new(0);
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        static LAUNCHED_AT: AtomicUsize = AtomicUsize::new(usize::MAX);
        static REVOKER: Mutex<Option<std::thread::JoinHandle<usize>>> = Mutex::new(None);
        fn fake(_: &Path, _: InstallerKind) -> std::io::Result<Option<std::process::Child>> {
            let manager = MANAGER.lock().unwrap().clone().unwrap();
            // Observed from inside the launch itself: both policy locks must still be held.
            if manager.settings.try_lock().is_err() && manager.pending.try_lock().is_err() {
                LOCKS_HELD.fetch_add(1, Ordering::SeqCst);
            }
            // A revoke issued at this moment can only complete after the launch.
            *REVOKER.lock().unwrap() = Some(std::thread::spawn(move || {
                feed_to(&manager, FEED_A, false, Some(false));
                SEQ.fetch_add(1, Ordering::SeqCst)
            }));
            std::thread::sleep(Duration::from_millis(50)); // widen the window; ordering is lock-enforced
            LAUNCHED_AT.store(SEQ.fetch_add(1, Ordering::SeqCst), Ordering::SeqCst);
            Ok(None)
        }
        let (manager, _dir, pending) = installable(FEED_A);
        let manager = Arc::new(manager);
        *MANAGER.lock().unwrap() = Some(manager.clone());
        manager.install_expected(pending.id, fake).unwrap();
        let revoked_at = REVOKER.lock().unwrap().take().unwrap().join().unwrap();
        assert_eq!(
            LOCKS_HELD.load(Ordering::SeqCst),
            1,
            "settings and pending locks must be held during launch"
        );
        assert!(
            LAUNCHED_AT.load(Ordering::SeqCst) < revoked_at,
            "revoke completed only after launch"
        );
        // The revoke did apply afterwards: a second install is refused before launching.
        assert!(!manager.get_settings().unwrap().allow_unsigned);
        assert_eq!(
            manager.install_expected(pending.id, fake).unwrap_err().code,
            "update_unsigned"
        );
        assert_eq!(LOCKS_HELD.load(Ordering::SeqCst), 1);
        *MANAGER.lock().unwrap() = None;
    }
}
