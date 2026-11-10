//! User-configured lifecycle hooks (Claude-Code-style `settings.json` format).
//!
//! ```json
//! {"hooks": {"PreToolUse": [{"matcher": "shell|write_file",
//!   "hooks": [{"type": "command", "command": "...", "timeout": 60}]}]}}
//! ```

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

const DEFAULT_TIMEOUT_SECS: u64 = 60;

/// Owns only the process tree created for one hook. Closing the Windows job or
/// killing the Unix process group also covers descendants after the shell exits.
#[cfg(windows)]
mod owned_hook_tree {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        minimum_working_set: usize,
        maximum_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io_counters: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }

    // The harness has no Windows binding dependency. These are the documented
    // kernel32 Job Object ABI and JOBOBJECT_EXTENDED_LIMIT_INFORMATION layout.
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            job: *mut c_void,
            class: i32,
            information: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn CreateEventW(
            attributes: *const c_void,
            manual_reset: i32,
            initial_state: i32,
            name: *const u16,
        ) -> *mut c_void;
        fn SetEvent(event: *mut c_void) -> i32;
    }

    pub(super) struct StartGate {
        event: OwnedHandle,
        name: String,
    }

    impl StartGate {
        pub(super) fn new() -> io::Result<Self> {
            let name = format!("Local\\omnia-hook-{}", uuid::Uuid::new_v4().simple());
            let wide: Vec<_> = name.encode_utf16().chain(Some(0)).collect();
            // SAFETY: a terminated name and null attributes create one owned,
            // non-inheritable event in this Windows session.
            let raw = unsafe { CreateEventW(std::ptr::null(), 1, 0, wide.as_ptr()) };
            if raw.is_null() {
                return Err(io::Error::last_os_error());
            }
            Ok(Self {
                event: unsafe { OwnedHandle::from_raw_handle(raw) },
                name,
            })
        }

        pub(super) fn name(&self) -> &str {
            &self.name
        }

        pub(super) fn release(&self) -> io::Result<()> {
            // SAFETY: the event handle remains owned for the whole hook run.
            if unsafe { SetEvent(self.event.as_raw_handle()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    pub(super) struct Guard {
        _job: OwnedHandle,
    }

    impl Guard {
        pub(super) fn attach(child: &tokio::process::Child) -> io::Result<Self> {
            let process = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("hook shell has no process handle"))?;
            // SAFETY: null attributes/name request an unnamed, non-inheritable
            // job; on success this function takes ownership of its only handle.
            let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if raw.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = unsafe { OwnedHandle::from_raw_handle(raw) };
            let mut limits = ExtendedLimits::default();
            limits.basic.flags = 0x0000_2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                                              // SAFETY: the buffer has the documented repr(C) layout and length;
                                              // process is the live shell handle borrowed from `child`.
            let configured = unsafe {
                SetInformationJobObject(
                    job.as_raw_handle(),
                    9, // JobObjectExtendedLimitInformation
                    &limits as *const _ as *const c_void,
                    std::mem::size_of::<ExtendedLimits>() as u32,
                ) != 0
                    && AssignProcessToJobObject(job.as_raw_handle(), process) != 0
            };
            if !configured {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { _job: job })
        }
    }
}

#[cfg(unix)]
mod owned_hook_tree {
    use std::io;

    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    pub(super) struct Guard {
        group: i32,
    }

    impl Guard {
        pub(super) fn attach(child: &tokio::process::Child) -> io::Result<Self> {
            let group = child
                .id()
                .and_then(|id| i32::try_from(id).ok())
                .filter(|id| *id > 0)
                .ok_or_else(|| io::Error::other("hook shell has no process group"))?;
            Ok(Self { group })
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            // SAFETY: build_command creates a new process group whose id is the
            // owned shell pid; the negative argument never targets our group.
            let _ = unsafe { kill(-self.group, 9) }; // SIGKILL
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HookEvent {
    PreToolUse,
    PostToolUse,
    UserPromptSubmit,
    Stop,
    SessionStart,
    /// The harness needs the user's attention. Payload fields:
    /// `notification_type` (`approval_requested`, `plan_ready`, `run_completed`
    /// or `run_failed`), `message` (a one-line human description) and, per
    /// type, `tool_name`/`tool_input`/`summary`/`ordinal`/`total` (approval),
    /// `plan` (plan_ready), `status`/`stop_reason`/`turns` (run_completed) or
    /// `error` (run_failed). A group's `matcher` is a regex tested against
    /// `notification_type`. Output is ignored: a Notification hook can neither
    /// block nor change anything.
    Notification,
}

impl HookEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PreToolUse => "PreToolUse",
            Self::PostToolUse => "PostToolUse",
            Self::UserPromptSubmit => "UserPromptSubmit",
            Self::Stop => "Stop",
            Self::SessionStart => "SessionStart",
            Self::Notification => "Notification",
        }
    }

    /// Events whose hook groups are filtered by a `matcher` regex.
    fn is_matcher_event(self) -> bool {
        matches!(
            self,
            Self::PreToolUse | Self::PostToolUse | Self::Notification
        )
    }

    fn stdout_is_context(self) -> bool {
        matches!(self, Self::UserPromptSubmit | Self::SessionStart)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionOverride {
    Allow,
    Ask,
    Deny,
}

impl PermissionOverride {
    fn rank(self) -> u8 {
        match self {
            Self::Allow => 0,
            Self::Ask => 1,
            Self::Deny => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookCommand {
    #[serde(rename = "type", default = "default_hook_type")]
    pub kind: String,
    #[serde(default)]
    pub command: String,
    /// Seconds.
    #[serde(default)]
    pub timeout: Option<u64>,
    /// Root folder of the plugin that contributed this hook; exported to the
    /// hook process as `OMNIA_PLUGIN_ROOT`. Never read from config files.
    #[serde(skip)]
    pub plugin_root: Option<PathBuf>,
}

fn default_hook_type() -> String {
    "command".to_owned()
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct HookMatcher {
    #[serde(default)]
    pub matcher: Option<String>,
    #[serde(default)]
    pub hooks: Vec<HookCommand>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct HookConfig {
    #[serde(default)]
    pub hooks: BTreeMap<String, Vec<HookMatcher>>,
    /// Problems found while loading config files (not part of the file format).
    #[serde(skip)]
    pub errors: Vec<String>,
}

impl HookConfig {
    pub fn is_empty(&self) -> bool {
        self.hooks.values().all(Vec::is_empty)
    }

    fn extend(&mut self, other: BTreeMap<String, Vec<HookMatcher>>) {
        for (event, groups) in other {
            self.hooks.entry(event).or_default().extend(groups);
        }
    }
}

/// Loads and merges hook configuration, in order: user config dir, workspace
/// `.omnia/settings.json`, workspace `.omnia/settings.local.json`.
pub fn load_hooks(workspace: &Path, user_config_dir: Option<&Path>) -> HookConfig {
    load_hooks_with_plugins(workspace, user_config_dir, &[])
}

/// Like [`load_hooks`], with each enabled plugin's `hooks.json` merged first
/// (so plugin hooks run before user and workspace hooks).
pub fn load_hooks_with_plugins(
    workspace: &Path,
    user_config_dir: Option<&Path>,
    plugins: &[crate::plugins::Plugin],
) -> HookConfig {
    let mut config = HookConfig::default();
    for plugin in plugins.iter().filter(|plugin| plugin.enabled) {
        let Some(file) = plugin.hooks_file() else {
            continue;
        };
        match crate::plugins::read_json_object(&file)
            .and_then(|value| crate::plugins::bind_hooks(&value, &plugin.path))
        {
            Ok(map) => config.extend(map),
            Err(error) => config
                .errors
                .push(format!("plugin {}: {error}", plugin.name)),
        }
    }
    load_hooks_files(workspace, user_config_dir, config)
}

fn load_hooks_files(
    workspace: &Path,
    user_config_dir: Option<&Path>,
    mut config: HookConfig,
) -> HookConfig {
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(dir) = user_config_dir {
        paths.push(dir.join("settings.json"));
    }
    paths.push(workspace.join(".omnia").join("settings.json"));
    paths.push(workspace.join(".omnia").join("settings.local.json"));

    for path in paths {
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                config.errors.push(format!("{}: {error}", path.display()));
                continue;
            }
        };
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        let value: Value = match serde_json::from_str(text) {
            Ok(value) => value,
            Err(error) => {
                config.errors.push(format!("{}: {error}", path.display()));
                continue;
            }
        };
        let Some(hooks) = value.get("hooks") else {
            continue;
        };
        match serde_json::from_value::<BTreeMap<String, Vec<HookMatcher>>>(hooks.clone()) {
            Ok(map) => config.extend(map),
            Err(error) => config
                .errors
                .push(format!("{}: invalid `hooks`: {error}", path.display())),
        }
    }
    config
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct HookOutcome {
    pub block: Option<String>,
    pub permission: Option<(PermissionOverride, Option<String>)>,
    pub additional_context: Vec<String>,
    pub messages: Vec<String>,
}

impl HookOutcome {
    fn merge_permission(&mut self, decision: PermissionOverride, reason: Option<String>) {
        let replace = match &self.permission {
            Some((current, _)) => decision.rank() > current.rank(),
            None => true,
        };
        if replace {
            self.permission = Some((decision, reason));
        }
    }
}

pub struct HookRunner {
    config: HookConfig,
    session_id: String,
}

struct RawOutput {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

enum RunError {
    Timeout,
    Cancelled,
    Spawn(String),
}

impl HookRunner {
    pub fn new(config: HookConfig, session_id: impl Into<String>) -> Self {
        Self {
            config,
            session_id: session_id.into(),
        }
    }

    pub fn config(&self) -> &HookConfig {
        &self.config
    }

    pub fn is_empty(&self) -> bool {
        self.config.is_empty()
    }

    /// `subject` is the tool name for tool events and the notification type
    /// for `Notification`.
    fn matching_commands(&self, event: HookEvent, subject: Option<&str>) -> Vec<&HookCommand> {
        let Some(groups) = self.config.hooks.get(event.as_str()) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for group in groups {
            let pattern = group.matcher.as_deref().map(str::trim).unwrap_or("");
            let matches = if !event.is_matcher_event() || pattern.is_empty() || pattern == "*" {
                true
            } else {
                match (Regex::new(&format!("^(?:{pattern})$")), subject) {
                    (Ok(regex), Some(name)) => regex.is_match(name),
                    _ => false,
                }
            };
            if matches {
                out.extend(
                    group
                        .hooks
                        .iter()
                        .filter(|hook| hook.kind == "command" && !hook.command.trim().is_empty()),
                );
            }
        }
        out
    }

    pub async fn run(
        &self,
        event: HookEvent,
        payload: Value,
        cwd: &Path,
        cancel: &CancellationToken,
    ) -> HookOutcome {
        let mut outcome = HookOutcome::default();
        let subject_key = if event == HookEvent::Notification {
            "notification_type"
        } else {
            "tool_name"
        };
        let subject = payload
            .get(subject_key)
            .and_then(Value::as_str)
            .map(str::to_owned);
        let commands = self.matching_commands(event, subject.as_deref());
        if commands.is_empty() {
            return outcome;
        }

        let mut full = match payload {
            Value::Object(map) => map,
            Value::Null => Default::default(),
            other => {
                let mut map = serde_json::Map::new();
                map.insert("payload".to_owned(), other);
                map
            }
        };
        full.insert("hook_event_name".to_owned(), json!(event.as_str()));
        full.insert("session_id".to_owned(), json!(self.session_id));
        full.insert("cwd".to_owned(), json!(cwd.to_string_lossy()));
        let stdin_text = Value::Object(full).to_string();

        for hook in commands {
            let timeout = Duration::from_secs(hook.timeout.unwrap_or(DEFAULT_TIMEOUT_SECS).max(1));
            let root = hook.plugin_root.as_deref();
            match run_command(&hook.command, &stdin_text, cwd, root, timeout, cancel).await {
                Ok(raw) => interpret(event, &hook.command, raw, &mut outcome),
                Err(RunError::Timeout) => outcome.messages.push(format!(
                    "hook `{}` timed out after {}s",
                    hook.command,
                    timeout.as_secs()
                )),
                Err(RunError::Cancelled) => {
                    outcome
                        .messages
                        .push(format!("hook `{}` cancelled", hook.command));
                    break;
                }
                Err(RunError::Spawn(error)) => outcome
                    .messages
                    .push(format!("hook `{}` failed to start: {error}", hook.command)),
            }
            if outcome.block.is_some() {
                break;
            }
        }
        outcome
    }
}

/// Builds the payload of a `Notification` hook: `notification_type` and
/// `message` plus the type-specific fields in `extra`.
pub fn notification_payload(kind: &str, message: impl Into<String>, extra: Value) -> Value {
    let mut payload = serde_json::Map::new();
    payload.insert("notification_type".to_owned(), json!(kind));
    payload.insert("message".to_owned(), json!(message.into()));
    if let Value::Object(extra) = extra {
        payload.extend(extra);
    }
    Value::Object(payload)
}

/// Runs the `Notification` hooks in the background. Their result is ignored.
pub fn fire_notification(
    hooks: std::sync::Arc<HookRunner>,
    kind: &str,
    message: impl Into<String>,
    extra: Value,
    cwd: PathBuf,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    let payload = notification_payload(kind, message, extra);
    tokio::spawn(async move {
        let _ = hooks
            .run(HookEvent::Notification, payload, &cwd, &cancel)
            .await;
    })
}

fn interpret(event: HookEvent, command: &str, raw: RawOutput, outcome: &mut HookOutcome) {
    match raw.code {
        Some(2) => {
            let reason = raw.stderr.trim();
            let reason = if reason.is_empty() {
                format!("blocked by hook `{command}`")
            } else {
                reason.to_owned()
            };
            outcome.block.get_or_insert(reason);
        }
        Some(0) => {
            let stdout = raw.stdout.trim();
            if stdout.is_empty() {
                return;
            }
            match serde_json::from_str::<Value>(stdout) {
                Ok(value) if value.is_object() => interpret_json(&value, outcome),
                _ if event.stdout_is_context() => {
                    outcome.additional_context.push(stdout.to_owned())
                }
                _ => {}
            }
        }
        other => {
            let stderr = raw.stderr.trim();
            outcome.messages.push(format!(
                "hook `{command}` exited with {}{}{}",
                other.map_or("a signal".to_owned(), |c| c.to_string()),
                if stderr.is_empty() { "" } else { ": " },
                stderr
            ));
        }
    }
}

fn interpret_json(value: &Value, outcome: &mut HookOutcome) {
    let specific = value.get("hookSpecificOutput");
    let field = |key: &str| -> Option<&Value> {
        value
            .get(key)
            .or_else(|| specific.and_then(|inner| inner.get(key)))
    };
    let string = |key: &str| field(key).and_then(Value::as_str).map(str::to_owned);

    if string("decision").as_deref() == Some("block") {
        outcome.block.get_or_insert_with(|| {
            string("reason").unwrap_or_else(|| "blocked by hook".to_owned())
        });
    }
    if field("continue").and_then(Value::as_bool) == Some(false) {
        outcome.block.get_or_insert_with(|| {
            string("stopReason").unwrap_or_else(|| "stopped by hook".to_owned())
        });
    }
    let decision = string("permissionDecision").or_else(|| match string("decision").as_deref() {
        Some("approve") => Some("allow".to_owned()),
        _ => None,
    });
    let decision = match decision.as_deref() {
        Some("allow") => Some(PermissionOverride::Allow),
        Some("ask") => Some(PermissionOverride::Ask),
        Some("deny") => Some(PermissionOverride::Deny),
        _ => None,
    };
    if let Some(decision) = decision {
        let reason = string("permissionDecisionReason").or_else(|| string("reason"));
        outcome.merge_permission(decision, reason);
    }
    if let Some(context) = string("additionalContext").filter(|c| !c.trim().is_empty()) {
        outcome.additional_context.push(context);
    }
}

fn build_command(
    program: &str,
    command: &str,
    cwd: &Path,
    plugin_root: Option<&Path>,
    gate_name: Option<&str>,
) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    if cfg!(windows) {
        // Wait until the shell belongs to its job before user commands can
        // start descendants. A separate event leaves the original stdin bytes
        // untouched, including when an external hook program reads that pipe.
        let gate_name = gate_name.expect("Windows hook startup gate");
        let gated = format!(
            "$omniaHookStartGate = [System.Threading.EventWaitHandle]::OpenExisting('{gate_name}')\n\
             try {{ if (-not $omniaHookStartGate.WaitOne(30000)) {{ exit 1 }} }} \
             finally {{ $omniaHookStartGate.Dispose() }}\n\
             Remove-Variable omniaHookStartGate\n{command}"
        );
        cmd.args(["-NoProfile", "-Command", &gated]);
    } else {
        cmd.args(["-c", command]);
    }
    cmd.current_dir(cwd)
        .env("OMNIA_PROJECT_DIR", cwd)
        .env("CLAUDE_PROJECT_DIR", cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(root) = plugin_root {
        cmd.env(crate::plugins::ROOT_ENV, root);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}

fn spawn_shell(
    command: &str,
    cwd: &Path,
    plugin_root: Option<&Path>,
    gate_name: Option<&str>,
) -> Result<tokio::process::Child, RunError> {
    #[cfg(windows)]
    {
        // Windows App Execution Aliases under `%LOCALAPPDATA%\Microsoft\
        // WindowsApps` are reparse-point launchers. Assigning that launcher
        // to a Job Object does not own the packaged PowerShell process, so
        // prefer the in-box executable when the alias is detected. A real
        // `pwsh.exe` installation remains preferred.
        let pwsh_is_alias = std::env::var_os("PATH")
            .and_then(|path| {
                std::env::split_paths(&path).find_map(|dir| {
                    let candidate = dir.join("pwsh.exe");
                    std::fs::symlink_metadata(candidate).ok()
                })
            })
            .is_some_and(|metadata| {
                use std::os::windows::fs::MetadataExt;
                metadata.file_attributes() & 0x0000_0400 != 0
            });
        if !pwsh_is_alias {
            match build_command("pwsh", command, cwd, plugin_root, gate_name).spawn() {
                Ok(child) => return Ok(child),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(RunError::Spawn(error.to_string())),
            }
        }
        build_command("powershell", command, cwd, plugin_root, gate_name)
            .spawn()
            .map_err(|error| RunError::Spawn(error.to_string()))
    }
    #[cfg(not(windows))]
    {
        build_command("sh", command, cwd, plugin_root, gate_name)
            .spawn()
            .map_err(|error| RunError::Spawn(error.to_string()))
    }
}

async fn run_command(
    command: &str,
    stdin_text: &str,
    cwd: &Path,
    plugin_root: Option<&Path>,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<RawOutput, RunError> {
    if cancel.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    #[cfg(windows)]
    let gate = owned_hook_tree::StartGate::new()
        .map_err(|error| RunError::Spawn(format!("cannot gate hook startup: {error}")))?;
    #[cfg(windows)]
    let gate_name = Some(gate.name());
    #[cfg(not(windows))]
    let gate_name = None;
    let mut child = spawn_shell(command, cwd, plugin_root, gate_name)?;
    // Fail closed before releasing the startup gate if tree ownership is not
    // available. Dropping the child then kills only an idle shell, not user work.
    let _tree = owned_hook_tree::Guard::attach(&child)
        .map_err(|error| RunError::Spawn(format!("cannot own hook process tree: {error}")))?;
    if cancel.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    #[cfg(windows)]
    gate.release()
        .map_err(|error| RunError::Spawn(format!("cannot release hook startup: {error}")))?;
    let mut stdin = child.stdin.take();
    let input = stdin_text.to_owned();
    let work = async move {
        if let Some(mut stdin) = stdin.take() {
            // The hook may exit without reading stdin; ignore broken pipes.
            let _ = stdin.write_all(input.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
        child.wait_with_output().await
    };
    // Both ordinary returns and dropping this future close the tree owner. The
    // shell is also reaped by Tokio's kill_on_drop child handling.
    tokio::select! {
        _ = cancel.cancelled() => Err(RunError::Cancelled),
        _ = tokio::time::sleep(timeout) => Err(RunError::Timeout),
        result = work => match result {
            Ok(output) => Ok(RawOutput {
                code: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            }),
            Err(error) => Err(RunError::Spawn(error.to_string())),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runner(event: &str, matcher: Option<&str>, commands: &[(&str, Option<u64>)]) -> HookRunner {
        let mut config = HookConfig::default();
        config.hooks.insert(
            event.to_owned(),
            vec![HookMatcher {
                matcher: matcher.map(str::to_owned),
                hooks: commands
                    .iter()
                    .map(|(command, timeout)| HookCommand {
                        kind: "command".to_owned(),
                        command: (*command).to_owned(),
                        timeout: *timeout,
                        plugin_root: None,
                    })
                    .collect(),
            }],
        );
        HookRunner::new(config, "s1")
    }

    #[cfg(windows)]
    mod sh {
        pub const BLOCK_JSON: &str = r#"Write-Output '{"decision":"block","reason":"nope"}'"#;
        pub const DENY_JSON: &str =
            r#"Write-Output '{"permissionDecision":"deny","permissionDecisionReason":"d"}'"#;
        pub const ALLOW_JSON: &str = r#"Write-Output '{"permissionDecision":"allow"}'"#;
        pub const EXIT2: &str = "[Console]::Error.Write('bad thing'); exit 2";
        pub const EXIT1: &str = "exit 1";
        pub const ECHO_STDIN: &str = "'got: ' + [Console]::In.ReadToEnd()";
        pub const SLEEP: &str = "Start-Sleep -Seconds 20";
        pub const ECHO_ROOT: &str = "$env:OMNIA_PLUGIN_ROOT";
    }
    #[cfg(unix)]
    mod sh {
        pub const BLOCK_JSON: &str = r#"echo '{"decision":"block","reason":"nope"}'"#;
        pub const DENY_JSON: &str =
            r#"echo '{"permissionDecision":"deny","permissionDecisionReason":"d"}'"#;
        pub const ALLOW_JSON: &str = r#"echo '{"permissionDecision":"allow"}'"#;
        pub const EXIT2: &str = "echo 'bad thing' >&2; exit 2";
        pub const EXIT1: &str = "exit 1";
        pub const ECHO_STDIN: &str = "printf 'got: '; cat";
        pub const SLEEP: &str = "sleep 20";
        pub const ECHO_ROOT: &str = "printf %s \"$OMNIA_PLUGIN_ROOT\"";
    }

    async fn run(runner: &HookRunner, event: HookEvent, payload: Value) -> HookOutcome {
        runner
            .run(
                event,
                payload,
                &std::env::temp_dir(),
                &CancellationToken::new(),
            )
            .await
    }

    #[test]
    fn loads_and_merges_configs() {
        let ws = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        std::fs::write(
            user.path().join("settings.json"),
            r#"{"model":"x","hooks":{"Stop":[{"hooks":[{"type":"command","command":"a"}]}]}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(ws.path().join(".omnia")).unwrap();
        std::fs::write(
            ws.path().join(".omnia/settings.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"b"}]}]}}"#,
        )
        .unwrap();
        std::fs::write(ws.path().join(".omnia/settings.local.json"), "{not json").unwrap();
        let config = load_hooks(ws.path(), Some(user.path()));
        assert_eq!(config.hooks["Stop"].len(), 2);
        assert_eq!(config.hooks["Stop"][1].hooks[0].command, "b");
        assert_eq!(config.errors.len(), 1);
    }

    #[test]
    fn matcher_selection() {
        let runner = runner("PreToolUse", Some("shell|write_file"), &[("x", None)]);
        assert_eq!(
            runner
                .matching_commands(HookEvent::PreToolUse, Some("shell"))
                .len(),
            1
        );
        assert_eq!(
            runner
                .matching_commands(HookEvent::PreToolUse, Some("read_file"))
                .len(),
            0
        );
        assert_eq!(
            runner
                .matching_commands(HookEvent::PreToolUse, Some("shell2"))
                .len(),
            0
        );
        let all = self::runner("PreToolUse", Some("*"), &[("x", None)]);
        assert_eq!(
            all.matching_commands(HookEvent::PreToolUse, Some("anything"))
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn block_json_and_exit2() {
        let r = runner("PreToolUse", None, &[(sh::BLOCK_JSON, None)]);
        let out = run(&r, HookEvent::PreToolUse, json!({"tool_name": "shell"})).await;
        assert_eq!(out.block.as_deref(), Some("nope"));

        let r = runner("PreToolUse", None, &[(sh::EXIT2, None)]);
        let out = run(&r, HookEvent::PreToolUse, json!({"tool_name": "shell"})).await;
        assert_eq!(out.block.as_deref(), Some("bad thing"));
    }

    #[tokio::test]
    async fn non_blocking_error_and_permission_precedence() {
        let r = runner("PreToolUse", None, &[(sh::EXIT1, None)]);
        let out = run(&r, HookEvent::PreToolUse, json!({"tool_name": "shell"})).await;
        assert!(out.block.is_none());
        assert_eq!(out.messages.len(), 1);

        let r = runner(
            "PreToolUse",
            None,
            &[(sh::ALLOW_JSON, None), (sh::DENY_JSON, None)],
        );
        let out = run(&r, HookEvent::PreToolUse, json!({"tool_name": "shell"})).await;
        assert_eq!(
            out.permission,
            Some((PermissionOverride::Deny, Some("d".to_owned())))
        );
    }

    #[tokio::test]
    async fn stdin_payload_and_context() {
        let r = runner("UserPromptSubmit", None, &[(sh::ECHO_STDIN, None)]);
        let out = run(&r, HookEvent::UserPromptSubmit, json!({"prompt": "hello"})).await;
        assert_eq!(out.additional_context.len(), 1);
        let parsed: Value =
            serde_json::from_str(out.additional_context[0].strip_prefix("got: ").unwrap()).unwrap();
        assert_eq!(parsed["hook_event_name"], "UserPromptSubmit");
        assert_eq!(parsed["prompt"], "hello");
        assert_eq!(parsed["session_id"], "s1");
    }

    #[tokio::test]
    async fn plugin_root_is_exported_to_hooks() {
        let root = std::env::temp_dir().join("omnia-plugin-root-probe");
        let mut r = runner("SessionStart", None, &[(sh::ECHO_ROOT, None)]);
        for group in r.config.hooks.values_mut().flatten() {
            group.hooks[0].plugin_root = Some(root.clone());
        }
        let out = run(&r, HookEvent::SessionStart, json!({})).await;
        assert_eq!(
            out.additional_context,
            vec![root.to_string_lossy().into_owned()]
        );

        let plain = runner("SessionStart", None, &[(sh::ECHO_ROOT, None)]);
        let out = run(&plain, HookEvent::SessionStart, json!({})).await;
        assert!(out.additional_context.is_empty());
    }

    #[tokio::test]
    async fn notification_hooks_match_on_type_and_receive_the_payload() {
        let r = runner(
            "Notification",
            Some("approval_requested|plan_ready"),
            &[(sh::ECHO_STDIN, None)],
        );
        assert_eq!(HookEvent::Notification.as_str(), "Notification");
        assert_eq!(
            r.matching_commands(HookEvent::Notification, Some("approval_requested"))
                .len(),
            1
        );
        assert_eq!(
            r.matching_commands(HookEvent::Notification, Some("run_completed"))
                .len(),
            0
        );
        let out = run(
            &r,
            HookEvent::Notification,
            json!({"notification_type": "plan_ready", "message": "Plan ready"}),
        )
        .await;
        // Notification stdout is not injected as context.
        assert!(out.additional_context.is_empty() && out.block.is_none());
        let skipped = run(
            &r,
            HookEvent::Notification,
            json!({"notification_type": "run_failed"}),
        )
        .await;
        assert!(skipped.messages.is_empty());
    }

    #[tokio::test]
    async fn fire_notification_really_runs_the_hook_command() {
        let dir = std::env::temp_dir().join(format!("omnia-fire-notify-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("fired.txt");
        let _ = std::fs::remove_file(&file);
        let command = if cfg!(windows) {
            format!(
                "[Console]::In.ReadToEnd() | Set-Content -Path '{}'",
                file.display()
            )
        } else {
            format!("cat > '{}'", file.display())
        };
        let mut config = HookConfig::default();
        config.hooks.insert(
            "Notification".to_owned(),
            vec![HookMatcher {
                matcher: None,
                hooks: vec![HookCommand {
                    kind: "command".to_owned(),
                    command,
                    timeout: Some(30),
                    plugin_root: None,
                }],
            }],
        );
        let runner = std::sync::Arc::new(HookRunner::new(config, "s1"));
        fire_notification(
            runner,
            "run_completed",
            "done",
            json!({"turns": 2}),
            dir.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let text =
            std::fs::read_to_string(&file).expect("the hook command ran and wrote its marker");
        assert!(
            text.contains("run_completed") && text.contains("Notification"),
            "{text}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn timeout_and_cancel() {
        let r = runner("Stop", None, &[(sh::SLEEP, Some(1))]);
        let out = run(&r, HookEvent::Stop, json!({})).await;
        assert!(out.block.is_none());
        assert!(out.messages[0].contains("timed out"));

        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            trigger.cancel();
        });
        let r = runner("Stop", None, &[(sh::SLEEP, None)]);
        let out = r
            .run(HookEvent::Stop, json!({}), &std::env::temp_dir(), &cancel)
            .await;
        assert!(out.messages[0].contains("cancelled"));
    }

    #[cfg(windows)]
    mod windows_tree {
        use super::*;
        use std::ffi::c_void;
        use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use tokio::net::TcpStream;

        const MARKER_ENV: &str = "OMNIA_HOOK_TREE_FIXTURE";
        const FIXTURE_TEST: &str = "hooks::tests::windows_tree::descendant_listener_fixture";

        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
            fn TerminateProcess(process: *mut c_void, code: u32) -> i32;
            fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
            fn IsProcessInJob(process: *mut c_void, job: *mut c_void, result: *mut i32) -> i32;
        }

        /// This is a no-op during an ordinary suite run. The hook launches this
        /// exact test in a child with a unique marker path, so no external runtime
        /// or fixed port is needed for the descendant fixture.
        #[test]
        fn descendant_listener_fixture() {
            let Some(marker) = std::env::var_os(MARKER_ENV) else {
                return;
            };
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            std::fs::write(marker, format!("{} {port}", std::process::id())).unwrap();
            // The fixture deliberately keeps the listener until process exit.
            // Its parent's owned job, or the regression's fallback cleanup,
            // terminates it well before this final safety bound.
            std::thread::sleep(Duration::from_secs(60));
            drop(listener);
        }

        struct FixtureProcesses(Vec<OwnedHandle>);

        impl FixtureProcesses {
            fn observe(pids: [u32; 2]) -> Self {
                let handles = pids
                    .into_iter()
                    .map(|pid| {
                        // SYNCHRONIZE | PROCESS_TERMINATE | QUERY_LIMITED_INFORMATION.
                        // Handles are opened
                        // from this test's unique marker, never a global scan.
                        let raw = unsafe { OpenProcess(0x0010_1001, 0, pid) };
                        assert!(!raw.is_null(), "fixture process {pid} disappeared");
                        unsafe { OwnedHandle::from_raw_handle(raw) }
                    })
                    .collect();
                Self(handles)
            }

            fn all_exited(&self) -> bool {
                self.0.iter().all(|handle| {
                    // WAIT_OBJECT_0 means the exact observed process ended.
                    unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) == 0 }
                })
            }

            fn diagnostic(&self) -> Vec<(u32, i32, i32)> {
                self.0
                    .iter()
                    .map(|handle| unsafe {
                        let mut in_job = -1;
                        let ok = IsProcessInJob(
                            handle.as_raw_handle(),
                            std::ptr::null_mut(),
                            &mut in_job,
                        );
                        (WaitForSingleObject(handle.as_raw_handle(), 0), ok, in_job)
                    })
                    .collect()
            }
        }

        impl Drop for FixtureProcesses {
            fn drop(&mut self) {
                // This also makes a fail-before regression safe: old hook code
                // must not leave its deliberately long-lived descendant around.
                for handle in &self.0 {
                    unsafe {
                        let _ = TerminateProcess(handle.as_raw_handle(), 1);
                        let _ = WaitForSingleObject(handle.as_raw_handle(), 1_000);
                    }
                }
            }
        }

        fn quote_ps(value: &Path) -> String {
            format!("'{}'", value.to_string_lossy().replace('\'', "''"))
        }

        async fn exercise_tree_cleanup(cancel_after_ready: bool) {
            let fixture = tempfile::tempdir().unwrap();
            let marker = fixture.path().join("descendant.ready");
            let parent_marker = fixture.path().join("parent.pid");
            let executable = std::env::current_exe().unwrap();
            let command = format!(
                "$env:{MARKER_ENV} = {marker}\n\
                 [System.IO.File]::WriteAllText({parent_marker}, [string]$PID)\n\
                 $omniaFixtureStart = [System.Diagnostics.ProcessStartInfo]::new({executable})\n\
                 $omniaFixtureStart.Arguments = '--exact {FIXTURE_TEST} --nocapture'\n\
                 $omniaFixtureStart.UseShellExecute = $false\n\
                 $omniaFixtureStart.CreateNoWindow = $true\n\
                 $omniaFixtureStart.RedirectStandardOutput = $true\n\
                 $omniaFixtureStart.RedirectStandardError = $true\n\
                 $omniaFixtureChild = [System.Diagnostics.Process]::Start($omniaFixtureStart)\n\
                 $omniaFixtureChild.WaitForExit()",
                marker = quote_ps(&marker),
                parent_marker = quote_ps(&parent_marker),
                executable = quote_ps(&executable),
            );
            let cancel = CancellationToken::new();
            let work = run_command(
                &command,
                "{}",
                fixture.path(),
                None,
                Duration::from_secs(if cancel_after_ready { 30 } else { 5 }),
                &cancel,
            );
            tokio::pin!(work);
            let ready = tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    tokio::select! {
                        result = &mut work => {
                            let detail = match result {
                                Ok(raw) => format!("exit {:?}: {}", raw.code, raw.stderr),
                                Err(RunError::Spawn(error)) => error,
                                Err(RunError::Timeout) => "timed out before fixture readiness".into(),
                                Err(RunError::Cancelled) => "cancelled before fixture readiness".into(),
                            };
                            panic!("hook fixture failed: {detail}");
                        }
                        _ = tokio::time::sleep(Duration::from_millis(20)) => {
                            if let Ok(text) = std::fs::read_to_string(&marker) {
                                let fields: Vec<_> = text.split_whitespace().collect();
                                if fields.len() == 2 {
                                    break (fields[0].parse::<u32>().unwrap(), fields[1].parse::<u16>().unwrap());
                                }
                            }
                        }
                    }
                }
            })
            .await
            .expect("owned descendant must signal readiness");
            let parent_pid = std::fs::read_to_string(&parent_marker)
                .unwrap()
                .parse::<u32>()
                .unwrap();
            let processes = FixtureProcesses::observe([parent_pid, ready.0]);
            eprintln!("fixture before cancel/timeout: parent={parent_pid}, child={}, states(wait,job_query,in_any_job)={:?}", ready.0, processes.diagnostic());
            let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, ready.1);
            assert!(TcpStream::connect(address).await.is_ok());
            // Negative control: this exact address cannot be rebound while
            // the observed descendant owns its listening socket.
            assert!(TcpListener::bind(address).is_err());

            if cancel_after_ready {
                cancel.cancel();
            }
            let result = tokio::time::timeout(Duration::from_secs(10), &mut work)
                .await
                .expect("hook termination remains bounded");
            if cancel_after_ready {
                assert!(matches!(result, Err(RunError::Cancelled)));
            } else {
                assert!(matches!(result, Err(RunError::Timeout)));
            }
            let cleanup = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    // A successful connect initiation is not a listening-owner
                    // oracle on every Windows network stack. Require both exact
                    // process handles signalled and same-address rebind, whose
                    // negative control above proves unavailable before teardown.
                    if processes.all_exited() && TcpListener::bind(address).is_ok() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await;
            assert!(cleanup.is_ok(),
                "both owned processes must exit and release descendant listener; address={address}; states(wait,job_query,in_any_job)={:?}; tcp_connect={:?}; bind={:?}",
                processes.diagnostic(), TcpStream::connect(address).await.map(|_| ()), TcpListener::bind(address).map(|_| ()));
        }

        #[tokio::test]
        async fn cancellation_closes_owned_hook_descendant_listener() {
            exercise_tree_cleanup(true).await;
        }

        #[tokio::test]
        async fn timeout_closes_owned_hook_descendant_listener() {
            exercise_tree_cleanup(false).await;
        }
    }
}
