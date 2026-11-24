//! Interactive ConPTY terminal hub backing `/api/terminal/*` (`/api/pty/*`) and `/ws`
//! binary terminal streaming + resize, backed directly by `omnia_agent::pty_session::PtyManager`
//! (`portable-pty` real Windows ConPTY, `#![deny(unsafe_code)]`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use omnia_agent::path_guard::strip_verbatim_prefix;
use omnia_agent::pty_session::{PtyCreateRequest, PtyKind, PtyManager, PtySessionInfo};
use omnia_core::now_epoch_ms;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// Public metadata describing a live terminal session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub pty_id: String,
    pub cwd: String,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
    pub created_at_ms: i64,
    pub alive: bool,
    pub exit_code: Option<i32>,
    pub scrollback_bytes: usize,
}

/// Manages bounded interactive Windows ConPTY sessions via `omnia_agent::pty_session::PtyManager`.
pub struct TerminalHub {
    manager: PtyManager,
    created_at_ms: Mutex<HashMap<String, i64>>,
}

impl Default for TerminalHub {
    fn default() -> Self {
        Self::new(PathBuf::from("."))
    }
}

impl TerminalHub {
    #[must_use]
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        let root_pb: PathBuf = workspace_root.into();
        let clean_root = strip_verbatim_prefix(&root_pb);
        Self {
            manager: PtyManager::new(clean_root),
            created_at_ms: Mutex::new(HashMap::new()),
        }
    }

    /// Spawns a bounded interactive ConPTY shell/command inside `cwd`.
    pub fn create_session(
        &self,
        cwd: &Path,
        shell: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSessionInfo, String> {
        let safe_cwd = resolve_safe_terminal_cwd(cwd)?;
        let requested = resolve_shell_executable(shell);
        let (kind, command, args) = if requested.to_ascii_lowercase().contains("python") {
            (PtyKind::PythonRepl, Some(requested), Vec::new())
        } else if is_powershell(&requested) {
            (
                PtyKind::Custom,
                Some(requested),
                vec!["-NoLogo".to_string(), "-NoProfile".to_string()],
            )
        } else {
            (PtyKind::Custom, Some(requested), Vec::new())
        };

        let pty_info = self
            .manager
            .create(PtyCreateRequest {
                kind,
                command,
                args,
                cwd: Some(safe_cwd.to_string_lossy().into_owned()),
                cols: cols.clamp(20, 400),
                rows: rows.clamp(5, 200),
            })
            .map_err(|e| e.to_string())?;

        let now = now_epoch_ms();
        if let Ok(mut guard) = self.created_at_ms.lock() {
            guard.insert(pty_info.id.clone(), now);
        }
        Ok(self.convert_info(pty_info, Some(now)))
    }

    #[must_use]
    pub fn list(&self) -> Vec<TerminalSessionInfo> {
        self.manager
            .list()
            .into_iter()
            .map(|item| {
                let ts = self
                    .created_at_ms
                    .lock()
                    .ok()
                    .and_then(|g| g.get(&item.id).copied());
                self.convert_info(item, ts)
            })
            .collect()
    }

    pub async fn write_input(&self, pty_id: &str, data: Vec<u8>) -> Result<(), String> {
        self.manager
            .write(pty_id, &data)
            .map_err(|e| e.to_string())
    }

    pub fn resize(
        &self,
        pty_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSessionInfo, String> {
        let cols = cols.clamp(20, 400);
        let rows = rows.clamp(5, 200);
        self.manager
            .resize(pty_id, cols, rows)
            .map_err(|e| e.to_string())?;
        self.list()
            .into_iter()
            .find(|s| s.pty_id == pty_id)
            .ok_or_else(|| format!("terminal '{pty_id}' not found after resize"))
    }

    pub fn read_scrollback(&self, pty_id: &str, max_bytes: usize) -> Result<String, String> {
        self.manager
            .read_scrollback(pty_id, max_bytes.clamp(256, 262_144))
            .map_err(|e| e.to_string())
    }

    pub fn subscribe(&self, pty_id: &str) -> Result<broadcast::Receiver<Vec<u8>>, String> {
        self.manager.subscribe(pty_id).map_err(|e| e.to_string())
    }

    pub fn kill(&self, pty_id: &str) -> Result<bool, String> {
        if let Ok(mut guard) = self.created_at_ms.lock() {
            guard.remove(pty_id);
        }
        Ok(self.manager.kill(pty_id))
    }

    fn convert_info(
        &self,
        info: PtySessionInfo,
        created_override: Option<i64>,
    ) -> TerminalSessionInfo {
        TerminalSessionInfo {
            pty_id: info.id,
            cwd: info.cwd,
            shell: info.program,
            cols: info.cols,
            rows: info.rows,
            created_at_ms: created_override.unwrap_or_else(now_epoch_ms),
            alive: info.alive,
            exit_code: None,
            scrollback_bytes: info.scrollback_bytes,
        }
    }
}

fn resolve_safe_terminal_cwd(cwd: &Path) -> Result<PathBuf, String> {
    let raw = cwd.to_string_lossy();
    if raw.starts_with(r"\\") || raw.starts_with("//") || raw.starts_with(r"\??\") {
        return Err("UNC/SMB terminal working directory is blocked".into());
    }
    if !cwd.is_dir() {
        return Err(format!(
            "terminal working directory does not exist: {}",
            cwd.display()
        ));
    }
    let canon = std::fs::canonicalize(cwd).map_err(|e| format!("canonicalize cwd: {e}"))?;
    let clean = strip_verbatim_prefix(&canon);
    let clean_str = clean.to_string_lossy();
    if clean_str.starts_with(r"\\")
        || clean_str.starts_with("//")
        || clean_str.starts_with(r"\??\")
    {
        return Err("UNC/SMB terminal working directory is blocked".into());
    }
    Ok(clean)
}

fn resolve_shell_executable(requested: Option<&str>) -> String {
    if let Some(raw) = requested.map(str::trim).filter(|s| !s.is_empty()) {
        let lower = raw.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "pwsh"
                | "pwsh.exe"
                | "powershell"
                | "powershell.exe"
                | "cmd"
                | "cmd.exe"
                | "bash"
                | "sh"
                | "python"
                | "python.exe"
                | "python3"
        ) {
            return raw.to_string();
        }
    }
    if cfg!(windows) {
        "cmd.exe".to_string()
    } else {
        "sh".to_string()
    }
}

fn is_powershell(shell: &str) -> bool {
    let lower = shell.to_ascii_lowercase();
    lower.contains("powershell") || lower.contains("pwsh")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_safe_terminal_cwd_strips_windows_verbatim_prefix_and_blocks_unc() {
        assert!(resolve_safe_terminal_cwd(Path::new(r"\\server\share")).is_err());
        let unique = std::env::temp_dir().join(format!(
            "omnia_pty_cwd_test_{}_{}",
            std::process::id(),
            now_epoch_ms()
        ));
        std::fs::create_dir_all(&unique).expect("create temp dir");
        let resolved = resolve_safe_terminal_cwd(&unique).expect("resolve safe cwd");
        let rendered = resolved.to_string_lossy();
        assert!(
            !rendered.starts_with(r"\\?\"),
            "verbatim prefix must be stripped before ConPTY spawn: {rendered}"
        );
        assert!(resolved.is_dir());

        let hub = TerminalHub::new(&resolved);
        let shell = if cfg!(windows) { "cmd.exe" } else { "sh" };
        let info = hub
            .create_session(&resolved, Some(shell), 80, 24)
            .expect("spawn interactive terminal");
        assert!(!info.cwd.starts_with(r"\\?\"));
        std::thread::sleep(std::time::Duration::from_millis(150));
        let scrollback = hub.read_scrollback(&info.pty_id, 4096).unwrap_or_default();
        assert!(
            !scrollback.contains("UNC paths are not supported"),
            "cmd.exe must not hit UNC cwd fallback: {scrollback}"
        );
        let _ = hub.kill(&info.pty_id);
        let _ = std::fs::remove_dir_all(&unique);
    }
}
