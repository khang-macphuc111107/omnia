//! Omnia-owned browser profile policy and host browser/ffmpeg settings.
//!
//! The persistent profile lives under the app data dir and is never a personal
//! browser profile. Chromium allows one process per profile, so the profile is
//! leased to one session's live browser at a time; other sessions fall back to
//! a disposable profile.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use omnia_browser::BrowserHandle;
use serde::{Deserialize, Serialize};

use crate::error::{NativeError, NativeResult};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BrowserSettings {
    /// Keep sign-ins in one persistent Omnia-owned profile (default on).
    pub keep_sign_ins: bool,
    /// Absolute path to a user-chosen `ffmpeg(.exe)`.
    pub ffmpeg_path: Option<PathBuf>,
}
impl Default for BrowserSettings {
    fn default() -> Self {
        Self {
            keep_sign_ins: true,
            ffmpeg_path: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileMode {
    Persistent,
    DisposableFallback,
    Disposable,
}

/// A configured ffmpeg path must be an existing absolute file named `ffmpeg(.exe)`.
pub fn validate_ffmpeg_path(raw: &str) -> NativeResult<Option<PathBuf>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let path = PathBuf::from(raw);
    let named = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("ffmpeg") || n.eq_ignore_ascii_case("ffmpeg.exe"));
    if !path.is_absolute() || !named || !path.is_file() {
        return Err(NativeError::invalid(
            "ffmpegPath",
            "must be the absolute path of an existing file named ffmpeg or ffmpeg.exe",
        ));
    }
    Ok(Some(path))
}

type Liveness = Arc<dyn Fn() -> bool + Send + Sync>;
struct Owner {
    session: String,
    live: Liveness,
}

pub struct ProfileCoordinator {
    root: PathBuf,
    settings: Mutex<BrowserSettings>,
    owner: Mutex<Option<Owner>>,
}

/// Settings file in the app data dir (keep-sign-ins flag and ffmpeg path; no secrets).
pub(crate) const SETTINGS_FILE_NAME: &str = "agent-browser-settings.json";

impl ProfileCoordinator {
    pub fn new(app_data: &Path) -> Self {
        let root = app_data.to_path_buf();
        let settings = std::fs::read(Self::settings_file(&root))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<BrowserSettings>(&bytes).ok())
            .map(|mut s| {
                // A stale or tampered path is dropped rather than trusted.
                if let Some(p) = &s.ffmpeg_path {
                    if validate_ffmpeg_path(&p.to_string_lossy())
                        .ok()
                        .flatten()
                        .is_none()
                    {
                        s.ffmpeg_path = None;
                    }
                }
                s
            })
            .unwrap_or_default();
        Self {
            root,
            settings: Mutex::new(settings),
            owner: Mutex::new(None),
        }
    }
    fn settings_file(root: &Path) -> PathBuf {
        root.join(SETTINGS_FILE_NAME)
    }
    pub fn persistent_dir(&self) -> PathBuf {
        self.root.join("browser-profile").join("default")
    }
    pub fn settings(&self) -> BrowserSettings {
        self.settings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    /// Apply `keep_sign_ins` / `ffmpeg_path` (`Some(None)` clears) and persist atomically.
    pub fn update(
        &self,
        keep: Option<bool>,
        ffmpeg: Option<Option<PathBuf>>,
    ) -> NativeResult<BrowserSettings> {
        let mut guard = self.settings.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = guard.clone();
        if let Some(keep) = keep {
            next.keep_sign_ins = keep;
        }
        if let Some(path) = ffmpeg {
            next.ffmpeg_path = path;
        }
        let file = Self::settings_file(&self.root);
        let save = || -> std::io::Result<()> {
            std::fs::create_dir_all(&self.root)?;
            let tmp = file.with_extension("json.tmp");
            std::fs::write(
                &tmp,
                serde_json::to_vec_pretty(&next).map_err(std::io::Error::other)?,
            )?;
            std::fs::rename(&tmp, &file)
        };
        save().map_err(|_| {
            NativeError::new("browser_settings_failed", "Could not save browser settings")
        })?;
        *guard = next.clone();
        Ok(next)
    }
    /// Configured ffmpeg, then `~/.omnia/bin`, then `PATH`.
    pub fn resolve_ffmpeg(&self) -> Option<PathBuf> {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .filter(|v| !v.is_empty())
            .map(|h| PathBuf::from(h).join(".omnia").join("bin"));
        omnia_download::find_ffmpeg_ordered(self.settings().ffmpeg_path.as_deref(), home.as_deref())
    }

    fn lease_free_for(&self, owner: &Option<Owner>, session: &str) -> bool {
        match owner {
            None => true,
            Some(o) => o.session == session || !(o.live)(),
        }
    }
    /// The mode a launch for `session` would get right now (no side effects).
    pub fn preview(&self, session: &str) -> ProfileMode {
        if !self.settings().keep_sign_ins {
            return ProfileMode::Disposable;
        }
        let owner = self.owner.lock().unwrap_or_else(|e| e.into_inner());
        if self.lease_free_for(&owner, session) {
            ProfileMode::Persistent
        } else {
            ProfileMode::DisposableFallback
        }
    }
    /// Called at launch time: choose the profile dir and lease the persistent one.
    pub fn resolve(
        &self,
        session: &str,
        handle: &BrowserHandle,
        disposable_root: &Path,
    ) -> (PathBuf, ProfileMode) {
        let handle = handle.clone();
        self.claim(session, Arc::new(move || handle.is_live()), disposable_root)
    }
    fn claim(
        &self,
        session: &str,
        live: Liveness,
        disposable_root: &Path,
    ) -> (PathBuf, ProfileMode) {
        let disposable = || disposable_root.join(uuid::Uuid::new_v4().to_string());
        if !self.settings().keep_sign_ins {
            return (disposable(), ProfileMode::Disposable);
        }
        let mut owner = self.owner.lock().unwrap_or_else(|e| e.into_inner());
        if self.lease_free_for(&owner, session) {
            *owner = Some(Owner {
                session: session.to_owned(),
                live,
            });
            (self.persistent_dir(), ProfileMode::Persistent)
        } else {
            (disposable(), ProfileMode::DisposableFallback)
        }
    }
    /// Give the lease back when the owning session's services are retired.
    pub fn release(&self, session: &str) {
        let mut owner = self.owner.lock().unwrap_or_else(|e| e.into_inner());
        if owner.as_ref().is_some_and(|o| o.session == session) {
            *owner = None;
        }
    }
    pub fn in_use(&self) -> bool {
        let owner = self.owner.lock().unwrap_or_else(|e| e.into_inner());
        owner.as_ref().is_some_and(|o| (o.live)())
    }
    /// Delete the persistent profile; refused while any browser is using it.
    pub fn clear(&self) -> NativeResult<()> {
        // Hold the lease lock so a launch cannot claim the profile mid-delete.
        let owner = self.owner.lock().unwrap_or_else(|e| e.into_inner());
        if owner.as_ref().is_some_and(|o| (o.live)()) {
            return Err(NativeError::new(
                "browser_profile_in_use",
                "A session browser is using the saved sign-ins. Close its session services first.",
            ));
        }
        let dir = self.persistent_dir();
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(NativeError::new(
                "browser_clear_failed",
                "Could not delete the saved browser data",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffmpeg_path_validation() {
        assert_eq!(validate_ffmpeg_path("  ").unwrap(), None);
        assert!(validate_ffmpeg_path("ffmpeg").is_err());
        let dir = std::env::temp_dir().join(format!("omnia-ffv-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let wrong = dir.join("tool.exe");
        let right = dir.join("ffmpeg.exe");
        std::fs::write(&wrong, b"x").unwrap();
        std::fs::write(&right, b"x").unwrap();
        assert!(validate_ffmpeg_path(&wrong.to_string_lossy()).is_err());
        assert!(
            validate_ffmpeg_path(&dir.join("missing").join("ffmpeg.exe").to_string_lossy())
                .is_err()
        );
        assert_eq!(
            validate_ffmpeg_path(&right.to_string_lossy()).unwrap(),
            Some(right)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lease_is_exclusive_while_live_and_cleared_only_when_idle() {
        let dir = std::env::temp_dir().join(format!("omnia-bl-{}", uuid::Uuid::new_v4()));
        let c = ProfileCoordinator::new(&dir);
        let live = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let flag = live.clone();
        let live_fn: Liveness = Arc::new(move || flag.load(std::sync::atomic::Ordering::SeqCst));
        let tmp = dir.join("tmp");
        let (p1, m1) = c.claim("a", live_fn.clone(), &tmp);
        assert_eq!(
            (p1.as_path(), m1),
            (c.persistent_dir().as_path(), ProfileMode::Persistent)
        );
        // Same session relaunching keeps the lease; another session falls back.
        assert_eq!(
            c.claim("a", live_fn.clone(), &tmp).1,
            ProfileMode::Persistent
        );
        let (p2, m2) = c.claim("b", live_fn.clone(), &tmp);
        assert_eq!(m2, ProfileMode::DisposableFallback);
        assert!(p2.starts_with(&tmp));
        assert_eq!(c.preview("b"), ProfileMode::DisposableFallback);
        // clear refuses while in use, and does not delete.
        std::fs::create_dir_all(c.persistent_dir()).unwrap();
        assert!(c.in_use());
        assert_eq!(c.clear().unwrap_err().code, "browser_profile_in_use");
        assert!(c.persistent_dir().exists());
        // Once the owner's browser is gone the profile can be taken over / cleared.
        live.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(c.preview("b"), ProfileMode::Persistent);
        c.clear().unwrap();
        assert!(!c.persistent_dir().exists());
        assert_eq!(c.claim("b", live_fn, &tmp).1, ProfileMode::Persistent);
        c.release("b");
        assert!(!c.in_use());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_default_on_and_persist() {
        let dir = std::env::temp_dir().join(format!("omnia-bs-{}", uuid::Uuid::new_v4()));
        let c = ProfileCoordinator::new(&dir);
        assert!(c.settings().keep_sign_ins);
        c.update(Some(false), None).unwrap();
        assert!(!ProfileCoordinator::new(&dir).settings().keep_sign_ins);
        assert_eq!(c.preview("a"), ProfileMode::Disposable);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
