//! Process Supervisor & Secret Environment Guard — delegates JobObject spawning
//! and Win32 process tree introspection to `omnia_workspace_ops::process_ops`.

use anyhow::Result;
use std::process::{Child, Command};

/// Windows `CREATE_NO_WINDOW` creation flag preventing console window flash.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Canonical RAII Win32 JobObject / process-group supervisor re-exported from `omnia-workspace-ops`.
pub use omnia_workspace_ops::process_ops::ProcessSupervisor;

/// Re-exported process tree inspection helpers from `omnia-workspace-ops`.
pub use omnia_workspace_ops::process_ops::{pid_is_alive, process_tree_rss_bytes};

/// Provider API key & token environment variable names stripped from untrusted child processes.
pub const SENSITIVE_PROVIDER_ENV_VARS: &[&str] = &[
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "XAI_API_KEY",
    "OMNIA_API_KEY",
    "HTMUSTC_API_KEY",
    "CLAUDE_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
];

/// Removes sensitive provider API keys and secret variables from a `std::process::Command`.
pub fn strip_provider_secrets(cmd: &mut Command) {
    for key in SENSITIVE_PROVIDER_ENV_VARS {
        cmd.env_remove(key);
    }
    for (k, _) in std::env::vars_os() {
        let up = k.to_string_lossy().to_ascii_uppercase();
        if (up.contains("API_KEY") || up.contains("AUTH_TOKEN") || up.contains("SECRET"))
            && !up.starts_with("OMNIA_HOOK_")
        {
            cmd.env_remove(&k);
        }
    }
}

/// Removes sensitive provider API keys and secret variables from a `tokio::process::Command`.
pub fn strip_provider_secrets_tokio(cmd: &mut tokio::process::Command) {
    for key in SENSITIVE_PROVIDER_ENV_VARS {
        cmd.env_remove(key);
    }
    for (k, _) in std::env::vars_os() {
        let up = k.to_string_lossy().to_ascii_uppercase();
        if (up.contains("API_KEY") || up.contains("AUTH_TOKEN") || up.contains("SECRET"))
            && !up.starts_with("OMNIA_HOOK_")
        {
            cmd.env_remove(&k);
        }
    }
}

/// Strips provider secrets and spawns `cmd` inside an `omnia_workspace_ops` `ProcessSupervisor`
/// (`CREATE_NO_WINDOW | CREATE_SUSPENDED` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
pub fn spawn_supervised_command(cmd: &mut Command) -> Result<(Child, ProcessSupervisor)> {
    strip_provider_secrets(cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    omnia_workspace_ops::process_ops::spawn_supervised_command(cmd)
        .map_err(|e| anyhow::anyhow!("spawn supervised command: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[test]
    fn kills_process_tree_and_reports_dead() {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("cmd.exe");
            c.args(["/d", "/c", "ping -n 10 127.0.0.1 >nul"]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = Command::new("sleep");
            c.arg("5");
            c
        };
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        let (mut child, mut sup) = spawn_supervised_command(&mut cmd).expect("spawn");
        let pid = child.id();
        assert!(pid_is_alive(pid));
        sup.kill_tree();
        let _ = child.wait();
        drop(child);
        std::thread::sleep(std::time::Duration::from_millis(120));
        assert!(!pid_is_alive(pid));
    }

    #[cfg(windows)]
    #[test]
    fn supervised_command_strips_provider_api_keys_from_child_env() {
        let mut cmd = Command::new("cmd.exe");
        cmd.env("OMNIA_API_KEY", "sk-dummy-not-leak-12345678")
            .env("OPENAI_API_KEY", "sk-dummy-not-leak-12345699")
            .args([
                "/d",
                "/c",
                "echo OMNIA=[%OMNIA_API_KEY%] OPENAI=[%OPENAI_API_KEY%]",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (child, _sup) = spawn_supervised_command(&mut cmd).expect("spawn supervised");
        let out = child.wait_with_output().expect("wait output");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            !stdout.contains("sk-dummy-not-leak"),
            "child shell must NEVER inherit provider API keys: {stdout}"
        );
    }
}
