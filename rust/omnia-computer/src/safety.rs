//! Policy (Steer #22 YOLO default + opt-in strict profile), rate limiting,
//! global kill switch, and `process_create_time_100ns` PID-reuse continuity.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::ComputerError;

/// Hard OS security / UAC / secure-desktop surfaces that are ALWAYS refused,
/// even in Steer #22 YOLO (`unrestricted_default`) mode.
pub fn hard_blocked_apps() -> Vec<String> {
    [
        "CredentialUIBroker.exe",
        "consent.exe",
        "LogonUI.exe",
        "winlogon.exe",
        "SecHealthUI.exe",
        "SecurityHealthSystray.exe",
        "WindowsSecurity.exe",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

/// Strict-mode blocklist: secure-desktop / UAC prompts PLUS password managers.
pub fn strict_blocked_apps() -> Vec<String> {
    let mut apps = hard_blocked_apps();
    apps.extend(
        [
            "1Password.exe",
            "Bitwarden.exe",
            "KeePass.exe",
            "KeePassXC.exe",
            "LastPass.exe",
            "Dashlane.exe",
            "NordPass.exe",
            "Enpass.exe",
            "RoboForm.exe",
            "Keeper.exe",
        ]
        .iter()
        .map(|s| (*s).to_string()),
    );
    apps
}

/// Alias for [`hard_blocked_apps`] matching the YOLO default boundary.
pub fn default_blocked_apps() -> Vec<String> {
    hard_blocked_apps()
}

/// Process identity tuple combining OS PID with `GetProcessTimes` creation time
/// (100-ns FILETIME ticks) so PID/HWND reuse cannot misdirect an action.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub process_create_time_100ns: u64,
}

impl ProcessIdentity {
    pub fn new(pid: u32, process_create_time_100ns: u64) -> Self {
        Self {
            pid,
            process_create_time_100ns,
        }
    }

    /// Returns `Ok(())` if `observed` still refers to the same process instance
    /// as `self`, or `Err(ComputerError::StaleTarget)` if the PID changed or
    /// `process_create_time_100ns` changed (PID reuse).
    pub fn verify_same(&self, observed: ProcessIdentity) -> Result<(), ComputerError> {
        if self.pid != 0 && observed.pid != 0 && self.pid != observed.pid {
            return Err(ComputerError::StaleTarget(format!(
                "window PID changed ({} -> {}); re-list or re-snapshot before acting",
                self.pid, observed.pid
            )));
        }
        if self.process_create_time_100ns != 0
            && observed.process_create_time_100ns != 0
            && self.process_create_time_100ns != observed.process_create_time_100ns
        {
            return Err(ComputerError::StaleTarget(format!(
                "process_create_time_100ns changed ({} -> {}) for pid {}, indicating OS PID reuse; re-list or re-snapshot before acting",
                self.process_create_time_100ns, observed.process_create_time_100ns, observed.pid
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerPolicy {
    /// Process names (with or without `.exe`, case-insensitive). `None` = any.
    pub allowed_apps: Option<Vec<String>>,
    /// Blocked process names (in addition to `hard_blocked_apps()` which are always enforced).
    pub blocked_apps: Vec<String>,
    /// 0 = unlimited (Steer #22 YOLO default).
    pub max_actions_per_minute: u32,
    /// When `true`, reject actions if `process_create_time_100ns` cannot be obtained (`0`).
    pub require_process_create_time: bool,
}

impl ComputerPolicy {
    /// Steer #22 YOLO default: unrestricted user apps, unlimited action rate,
    /// while unconditionally preserving OS/UAC/secure-desktop boundaries.
    pub fn unrestricted_default() -> Self {
        Self {
            allowed_apps: None,
            blocked_apps: hard_blocked_apps(),
            max_actions_per_minute: 0,
            require_process_create_time: false,
        }
    }

    /// Opt-in strict policy: blocks secure-desktop + password managers and
    /// caps action rate at 240/minute.
    pub fn strict_default() -> Self {
        Self {
            allowed_apps: None,
            blocked_apps: strict_blocked_apps(),
            max_actions_per_minute: 240,
            require_process_create_time: false,
        }
    }
}

impl Default for ComputerPolicy {
    fn default() -> Self {
        Self::unrestricted_default()
    }
}

fn norm(name: &str) -> String {
    let n = name.trim().to_lowercase();
    n.strip_suffix(".exe").map(str::to_string).unwrap_or(n)
}

impl ComputerPolicy {
    /// `Ok` when an action on a window of `process` is permitted.
    pub fn check_process(&self, process: &str) -> Result<(), ComputerError> {
        let p = norm(process);
        if p.is_empty() {
            return Err(ComputerError::Blocked(
                "Cannot verify the target process identity; take a new snapshot before operating it."
                    .into(),
            ));
        }
        if hard_blocked_apps().iter().any(|b| norm(b) == p)
            || self.blocked_apps.iter().any(|b| norm(b) == p)
        {
            return Err(ComputerError::Blocked(format!(
                "`{process}` is on the blocked-apps list (secure-desktop / credential surfaces are never operated). Ask the user to handle it."
            )));
        }
        if let Some(allowed) = &self.allowed_apps {
            if !allowed.iter().any(|a| norm(a) == p) {
                return Err(ComputerError::Blocked(format!(
                    "`{process}` is not in the allowed-apps list ({}).",
                    allowed.join(", ")
                )));
            }
        }
        Ok(())
    }

    /// Verify PID-reuse continuity for a target window.
    pub fn check_identity(
        &self,
        expected: Option<ProcessIdentity>,
        observed: ProcessIdentity,
    ) -> Result<(), ComputerError> {
        if self.require_process_create_time && observed.process_create_time_100ns == 0 {
            return Err(ComputerError::StaleTarget(format!(
                "missing process_create_time_100ns for pid {}",
                observed.pid
            )));
        }
        if let Some(exp) = expected {
            exp.verify_same(observed)?;
        }
        Ok(())
    }
}

/// Global emergency stop. Cheap to clone; every action checks it.
#[derive(Clone)]
pub struct KillSwitch {
    flag: Arc<AtomicBool>,
    token: Arc<Mutex<CancellationToken>>,
}

impl Default for KillSwitch {
    fn default() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
            token: Arc::new(Mutex::new(CancellationToken::new())),
        }
    }
}

impl KillSwitch {
    pub fn trigger(&self) {
        self.flag.store(true, Ordering::SeqCst);
        if let Ok(t) = self.token.lock() {
            t.cancel();
        }
    }

    /// Re-arm after a trigger.
    pub fn reset(&self) {
        self.flag.store(false, Ordering::SeqCst);
        if let Ok(mut t) = self.token.lock() {
            *t = CancellationToken::new();
        }
    }

    pub fn is_triggered(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Token cancelled when the switch fires (for `select!`).
    pub fn token(&self) -> CancellationToken {
        self.token.lock().map(|t| t.clone()).unwrap_or_default()
    }

    pub fn flag(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }
}

pub struct Safety {
    policy: RwLock<ComputerPolicy>,
    pub kill: KillSwitch,
    recent: Mutex<VecDeque<Instant>>,
}

impl Safety {
    pub fn new(policy: ComputerPolicy, kill: KillSwitch) -> Self {
        Self {
            policy: RwLock::new(policy),
            kill,
            recent: Mutex::new(VecDeque::new()),
        }
    }

    pub fn policy(&self) -> ComputerPolicy {
        self.policy.read().map(|p| p.clone()).unwrap_or_default()
    }

    pub fn set_policy(&self, policy: ComputerPolicy) {
        if let Ok(mut p) = self.policy.write() {
            *p = policy;
        }
    }

    pub fn check_process(&self, process: &str) -> Result<(), ComputerError> {
        self.policy
            .read()
            .map_err(|_| ComputerError::Failed("policy lock poisoned".into()))?
            .check_process(process)
    }

    pub fn check_identity(
        &self,
        expected: Option<ProcessIdentity>,
        observed: ProcessIdentity,
    ) -> Result<(), ComputerError> {
        self.policy
            .read()
            .map_err(|_| ComputerError::Failed("policy lock poisoned".into()))?
            .check_identity(expected, observed)
    }

    /// Kill-switch only (no rate accounting); used by read-only queries and loops.
    pub fn check_alive(&self) -> Result<(), ComputerError> {
        if self.kill.is_triggered() {
            Err(ComputerError::Killed)
        } else {
            Ok(())
        }
    }

    /// Called once per action: kill switch + optional sliding one-minute rate limit.
    pub fn check_action(&self) -> Result<(), ComputerError> {
        self.check_action_at(Instant::now())
    }

    pub(crate) fn check_action_at(&self, now: Instant) -> Result<(), ComputerError> {
        self.check_alive()?;
        let max = self
            .policy
            .read()
            .map(|p| p.max_actions_per_minute)
            .unwrap_or(0);
        if max == 0 {
            return Ok(());
        }
        let mut recent = self
            .recent
            .lock()
            .map_err(|_| ComputerError::Failed("rate limiter poisoned".into()))?;
        while recent
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60))
        {
            recent.pop_front();
        }
        if recent.len() as u32 >= max {
            return Err(ComputerError::RateLimited(max));
        }
        recent.push_back(now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yolo_default_is_unrestricted_except_hard_os_boundaries() {
        let p = ComputerPolicy::unrestricted_default();
        assert_eq!(p, ComputerPolicy::default());
        assert_eq!(p.max_actions_per_minute, 0);
        assert!(p.allowed_apps.is_none());
        // Hard OS / UAC / logon surfaces ALWAYS blocked even in YOLO
        assert!(p.check_process("CredentialUIBroker.exe").is_err());
        assert!(p.check_process("consent.exe").is_err());
        assert!(p.check_process("LOGONUI").is_err());
        assert!(p.check_process("winlogon.exe").is_err());
        assert!(p.check_process("").is_err());
        assert!(p.check_process("   ").is_err());
        // Regular user apps allowed
        assert!(p.check_process("notepad.exe").is_ok());
        assert!(p.check_process("Bitwarden.exe").is_ok());
    }

    #[test]
    fn strict_default_blocks_password_managers_and_caps_rate() {
        let p = ComputerPolicy::strict_default();
        assert_eq!(p.max_actions_per_minute, 240);
        assert!(p.check_process("1Password.exe").is_err());
        assert!(p.check_process("Bitwarden.exe").is_err());
        assert!(p.check_process("KeePassXC.exe").is_err());
        assert!(p.check_process("consent.exe").is_err());
        assert!(p.check_process("notepad.exe").is_ok());
    }

    #[test]
    fn allow_list_and_hard_block_precedence() {
        let p = ComputerPolicy {
            allowed_apps: Some(vec!["notepad".into(), "consent.exe".into()]),
            blocked_apps: Vec::new(),
            max_actions_per_minute: 0,
            require_process_create_time: false,
        };
        assert!(p.check_process("Notepad.exe").is_ok());
        assert!(p.check_process("calc.exe").is_err());
        // Hard OS block wins even if blocked_apps is cleared and consent.exe is in allowed_apps
        assert!(p.check_process("consent.exe").is_err());
    }

    #[test]
    fn pid_reuse_continuity_guard_catches_reused_pid_and_hwnd() {
        let orig = ProcessIdentity::new(4200, 133_758_012_345_678_901);
        assert!(orig.verify_same(orig).is_ok());
        // Same PID, different create time -> OS PID reuse!
        let reused = ProcessIdentity::new(4200, 133_758_012_345_679_401);
        assert!(matches!(
            orig.verify_same(reused),
            Err(ComputerError::StaleTarget(_))
        ));
        // Different PID on same HWND -> HWND reuse!
        let swapped = ProcessIdentity::new(4201, 133_758_012_345_678_901);
        assert!(matches!(
            orig.verify_same(swapped),
            Err(ComputerError::StaleTarget(_))
        ));
        // Opt-in strict zero timestamp rejection
        let strict_ts = ComputerPolicy {
            require_process_create_time: true,
            ..ComputerPolicy::unrestricted_default()
        };
        assert!(matches!(
            strict_ts.check_identity(None, ProcessIdentity::new(4200, 0)),
            Err(ComputerError::StaleTarget(_))
        ));
    }

    #[test]
    fn kill_switch_blocks_and_resets() {
        let s = Safety::new(ComputerPolicy::default(), KillSwitch::default());
        assert!(s.check_action().is_ok());
        let token = s.kill.token();
        s.kill.trigger();
        assert!(token.is_cancelled());
        assert!(matches!(s.check_action(), Err(ComputerError::Killed)));
        s.kill.reset();
        assert!(s.check_action().is_ok());
        assert!(!s.kill.token().is_cancelled());
    }

    #[test]
    fn rate_limit_sliding_window() {
        let policy = ComputerPolicy {
            max_actions_per_minute: 3,
            ..ComputerPolicy::unrestricted_default()
        };
        let s = Safety::new(policy, KillSwitch::default());
        let t0 = Instant::now();
        for i in 0..3 {
            assert!(s.check_action_at(t0 + Duration::from_secs(i)).is_ok());
        }
        assert!(matches!(
            s.check_action_at(t0 + Duration::from_secs(10)),
            Err(ComputerError::RateLimited(3))
        ));
        assert!(s.check_action_at(t0 + Duration::from_secs(61)).is_ok());
    }
}
