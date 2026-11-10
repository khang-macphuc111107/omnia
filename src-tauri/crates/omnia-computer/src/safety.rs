//! Policy (which apps may be touched), rate limiting and the global kill switch.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use omnia_harness::CancellationToken;

use crate::ComputerError;

/// Secure-desktop / credential prompts and password managers. This is about not
/// acting on sign-in or elevation UI by accident, not a content restriction.
pub fn default_blocked_apps() -> Vec<String> {
    [
        "CredentialUIBroker.exe",
        "consent.exe",
        "LogonUI.exe",
        "SecHealthUI.exe",
        "SecurityHealthSystray.exe",
        "WindowsSecurity.exe",
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
    .map(|s| s.to_string())
    .collect()
}

#[derive(Debug, Clone)]
pub struct ComputerPolicy {
    /// Process names (with or without `.exe`, case-insensitive). `None` = any.
    pub allowed_apps: Option<Vec<String>>,
    pub blocked_apps: Vec<String>,
    /// 0 = unlimited.
    pub max_actions_per_minute: u32,
}

impl Default for ComputerPolicy {
    fn default() -> Self {
        Self {
            allowed_apps: None,
            blocked_apps: default_blocked_apps(),
            max_actions_per_minute: 240,
        }
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
                "Cannot verify the target process identity; take a new snapshot before operating it.".into(),
            ));
        }
        if self.blocked_apps.iter().any(|b| norm(b) == p) {
            return Err(ComputerError::Blocked(format!(
                "`{process}` is on the blocked-apps list (credential / secure prompts are never operated). Ask the user to handle it."
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

    /// Kill-switch only (no rate accounting); used by long loops between steps.
    pub fn check_alive(&self) -> Result<(), ComputerError> {
        if self.kill.is_triggered() {
            Err(ComputerError::Killed)
        } else {
            Ok(())
        }
    }

    /// Called once per action: kill switch + sliding one-minute rate limit.
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
    fn default_blocks_credential_ui() {
        let p = ComputerPolicy::default();
        assert!(p.check_process("CredentialUIBroker.exe").is_err());
        assert!(p.check_process("consent.exe").is_err());
        assert!(p.check_process("LOGONUI").is_err());
        assert!(p.check_process("notepad.exe").is_ok());
        assert!(p.check_process("").is_err());
        assert!(p.check_process("   ").is_err());
    }

    #[test]
    fn allow_list_and_block_precedence() {
        let p = ComputerPolicy {
            allowed_apps: Some(vec!["notepad".into(), "consent.exe".into()]),
            ..Default::default()
        };
        assert!(p.check_process("Notepad.exe").is_ok());
        assert!(p.check_process("calc.exe").is_err());
        assert!(p.check_process("").is_err());
        assert!(p.check_process("   ").is_err());
        // blocked wins over allowed
        assert!(p.check_process("consent.exe").is_err());
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
            ..Default::default()
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
