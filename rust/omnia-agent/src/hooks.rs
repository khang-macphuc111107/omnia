//! 25-Event Lifecycle Hooks Registry & Deterministic `exit 2` Hard-Block Engine.
//!
//! Supports both command-based hooks (`.omnia/hooks.json`, `.omp/hooks.json`,
//! `.claude/settings.json` compatible format) and in-process Rust/plugin callbacks.
//! Any hook process exiting with status code `2` triggers an unconditional
//! deterministic block (`HookOutcome::Blocked`) before the guarded action proceeds.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// Owns the entire subprocess tree launched for a single command hook so timeout,
/// cancellation, or early drop kills both the shell and every grandchild with zero orphans.
#[cfg(windows)]
mod owned_hook_tree {
    use std::ffi::c_void;
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent};

    /// Named manual-reset Win32 event gating hook command execution until the shell
    /// has been assigned to its kill-on-close Job Object (eliminating spawn-before-assign races).
    pub(super) struct StartGate {
        event: OwnedHandle,
        name: String,
    }

    impl StartGate {
        pub(super) fn new() -> io::Result<Self> {
            let name = format!("Local\\omnia-hook-{}", uuid::Uuid::new_v4().simple());
            let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: null-terminated UTF-16 event name and null security attributes create
            // an owned non-inheritable manual-reset event in the current Windows session.
            let raw = unsafe { CreateEventW(std::ptr::null(), 1, 0, wide.as_ptr()) };
            if raw.is_null() {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: `raw` is a newly created non-null Win32 event handle owned exclusively here.
            let event = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
            Ok(Self { event, name })
        }

        pub(super) fn name(&self) -> &str {
            &self.name
        }

        pub(super) fn release(&self) -> io::Result<()> {
            // SAFETY: `self.event` remains valid and owned for the entire hook execution.
            if unsafe { SetEvent(self.event.as_raw_handle() as HANDLE) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    /// Kill-on-close Win32 Job Object owning the hook shell and all descendant processes.
    pub(super) struct Guard {
        job: OwnedHandle,
    }

    impl Guard {
        pub(super) fn attach(child: &tokio::process::Child) -> io::Result<Self> {
            let process = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("hook shell has no active process handle"))?;
            // SAFETY: null attributes and null name create an unnamed non-inheritable Job Object.
            let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if raw.is_null() {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: `raw` is a newly created non-null Win32 Job Object handle owned exclusively here.
            let job = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
            // SAFETY: `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` is a plain C repr struct zero-initialized cleanly.
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let len = u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                .unwrap_or(u32::MAX);
            // SAFETY: `job` is our owned handle, `limits` matches the requested class and size,
            // and `process` is the live handle borrowed from `child`.
            let configured = unsafe {
                SetInformationJobObject(
                    job.as_raw_handle() as HANDLE,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                    len,
                ) != 0
                    && AssignProcessToJobObject(job.as_raw_handle() as HANDLE, process as HANDLE)
                        != 0
            };
            if !configured {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { job })
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            // SAFETY: `self.job` is an owned Job Object handle; terminating it synchronously
            // guarantees zero surviving grandchild processes before `OwnedHandle` closes it.
            unsafe {
                let _ = TerminateJobObject(self.job.as_raw_handle() as HANDLE, 1);
            }
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
            // SAFETY: `build_hidden_shell_command` places the child in its own process group (`pgid == pid`).
            let _ = unsafe { kill(-self.group, 9) };
        }
    }
}

/// All 25 lifecycle events supported by Omnia v5 hooks (OMP + Claude Code + Omnia parity).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookEvent {
    SessionStart,
    SessionBeforeSwitch,
    SessionSwitch,
    SessionBeforeBranch,
    SessionBranch,
    SessionBeforeCompact,
    SessionCompacting,
    SessionCompact,
    SessionBeforeShutdown,
    SessionShutdown,
    UserPromptSubmit,
    BeforeAgentStart,
    AgentStart,
    AgentEnd,
    TurnStart,
    TurnEnd,
    ContextPrepare,
    PreToolUse,
    PermissionRequest,
    PostToolUse,
    PostToolUseFailure,
    SubagentStart,
    SubagentStop,
    AutoRetryStart,
    TaskCompleted,
}

impl HookEvent {
    /// Complete ordered list of all 25 canonical lifecycle events.
    pub const ALL: [Self; 25] = [
        Self::SessionStart,
        Self::SessionBeforeSwitch,
        Self::SessionSwitch,
        Self::SessionBeforeBranch,
        Self::SessionBranch,
        Self::SessionBeforeCompact,
        Self::SessionCompacting,
        Self::SessionCompact,
        Self::SessionBeforeShutdown,
        Self::SessionShutdown,
        Self::UserPromptSubmit,
        Self::BeforeAgentStart,
        Self::AgentStart,
        Self::AgentEnd,
        Self::TurnStart,
        Self::TurnEnd,
        Self::ContextPrepare,
        Self::PreToolUse,
        Self::PermissionRequest,
        Self::PostToolUse,
        Self::PostToolUseFailure,
        Self::SubagentStart,
        Self::SubagentStop,
        Self::AutoRetryStart,
        Self::TaskCompleted,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SessionStart => "session_start",
            Self::SessionBeforeSwitch => "session_before_switch",
            Self::SessionSwitch => "session_switch",
            Self::SessionBeforeBranch => "session_before_branch",
            Self::SessionBranch => "session_branch",
            Self::SessionBeforeCompact => "session_before_compact",
            Self::SessionCompacting => "session_compacting",
            Self::SessionCompact => "session_compact",
            Self::SessionBeforeShutdown => "session_before_shutdown",
            Self::SessionShutdown => "session_shutdown",
            Self::UserPromptSubmit => "user_prompt_submit",
            Self::BeforeAgentStart => "before_agent_start",
            Self::AgentStart => "agent_start",
            Self::AgentEnd => "agent_end",
            Self::TurnStart => "turn_start",
            Self::TurnEnd => "turn_end",
            Self::ContextPrepare => "context",
            Self::PreToolUse => "pre_tool_use",
            Self::PermissionRequest => "permission_request",
            Self::PostToolUse => "post_tool_use",
            Self::PostToolUseFailure => "post_tool_use_failure",
            Self::SubagentStart => "subagent_start",
            Self::SubagentStop => "subagent_stop",
            Self::AutoRetryStart => "auto_retry_start",
            Self::TaskCompleted => "task_completed",
        }
    }

    /// Parses canonical snake_case, PascalCase (Claude Code), or dotted (OMP) hook names.
    #[must_use]
    pub fn parse_loose(raw: &str) -> Option<Self> {
        let key = raw.trim().to_ascii_lowercase().replace(['.', '-'], "_");
        match key.as_str() {
            "session_start" | "sessionstart" => Some(Self::SessionStart),
            "session_before_switch" => Some(Self::SessionBeforeSwitch),
            "session_switch" => Some(Self::SessionSwitch),
            "session_before_branch" => Some(Self::SessionBeforeBranch),
            "session_branch" => Some(Self::SessionBranch),
            "session_before_compact" => Some(Self::SessionBeforeCompact),
            "session_compacting" | "precompact" | "pre_compact" => Some(Self::SessionCompacting),
            "session_compact" | "postcompact" | "post_compact" => Some(Self::SessionCompact),
            "session_before_shutdown" => Some(Self::SessionBeforeShutdown),
            "session_shutdown" | "sessionend" | "session_end" => Some(Self::SessionShutdown),
            "user_prompt_submit" | "userpromptsubmit" => Some(Self::UserPromptSubmit),
            "before_agent_start" => Some(Self::BeforeAgentStart),
            "agent_start" => Some(Self::AgentStart),
            "agent_end" => Some(Self::AgentEnd),
            "turn_start" => Some(Self::TurnStart),
            "turn_end" => Some(Self::TurnEnd),
            "context" | "context_prepare" => Some(Self::ContextPrepare),
            "pre_tool_use" | "pretooluse" | "tool_call" => Some(Self::PreToolUse),
            "permission_request" | "permissionrequest" => Some(Self::PermissionRequest),
            "post_tool_use" | "posttooluse" | "tool_result" => Some(Self::PostToolUse),
            "post_tool_use_failure" | "posttoolusefailure" => Some(Self::PostToolUseFailure),
            "subagent_start" | "subagentstart" => Some(Self::SubagentStart),
            "subagent_stop" | "subagentstop" | "stop" | "session_stop" => Some(Self::SubagentStop),
            "auto_retry_start" => Some(Self::AutoRetryStart),
            "task_completed" | "taskcompleted" => Some(Self::TaskCompleted),
            _ => None,
        }
    }
}

/// Deterministic exit code that mandates an immediate hard block of the intercepted operation.
pub const HOOK_EXIT_HARD_BLOCK: i32 = 2;

/// Handler definition registered for a [`HookEvent`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookSpec {
    pub id: String,
    pub event: HookEvent,
    /// Optional glob/pipe matcher tested against `tool_name` or `target` (e.g. `"shell|edit_file"` or `"*"`).
    #[serde(default)]
    pub matcher: Option<String>,
    /// Shell/command line executed via non-interactive subprocess with JSON event payload on stdin.
    pub command: String,
    #[serde(default = "default_hook_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// If true, non-zero exit codes other than 2 also block rather than warn.
    #[serde(default)]
    pub fail_closed: bool,
    #[serde(default)]
    pub source: String,
}

const fn default_hook_timeout_ms() -> u64 {
    10_000
}

const fn default_true() -> bool {
    true
}

/// Aggregated result after running every matching hook for an event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookDispatchOutcome {
    pub event: HookEvent,
    pub blocked: bool,
    pub block_reason: Option<String>,
    pub blocking_hook_id: Option<String>,
    pub blocking_exit_code: Option<i32>,
    /// Last revised tool/prompt input supplied by hooks (if not blocked).
    pub revised_input: Option<Value>,
    /// Distinct non-empty developer/system context strings in execution order.
    pub additional_context: Vec<String>,
    /// Non-blocking warnings emitted by hooks that exited with non-2 failure codes.
    pub warnings: Vec<String>,
    pub executed_hooks: usize,
}

impl Default for HookDispatchOutcome {
    fn default() -> Self {
        Self {
            event: HookEvent::PreToolUse,
            blocked: false,
            block_reason: None,
            blocking_hook_id: None,
            blocking_exit_code: None,
            revised_input: None,
            additional_context: Vec::new(),
            warnings: Vec::new(),
            executed_hooks: 0,
        }
    }
}

/// In-process Rust callback hook signature.
pub type InlineHookCallback = Arc<dyn Fn(HookEvent, &Value) -> InlineHookDecision + Send + Sync>;

#[derive(Debug, Clone, Default)]
pub struct InlineHookDecision {
    pub block: bool,
    pub reason: Option<String>,
    pub revised_input: Option<Value>,
    pub additional_context: Option<String>,
}

#[derive(Clone)]
struct RegisteredInlineHook {
    id: String,
    event: HookEvent,
    matcher: Option<String>,
    enabled: bool,
    callback: InlineHookCallback,
}

/// Thread-safe registry executing command and inline lifecycle hooks across all 25 events.
#[derive(Clone, Default)]
pub struct HookRegistry {
    workspace_root: PathBuf,
    specs: Arc<RwLock<Vec<HookSpec>>>,
    inline: Arc<RwLock<Vec<RegisteredInlineHook>>>,
    /// Trusted plugin roots keyed by hook id (never deserialized from untrusted JSON).
    plugin_roots: Arc<RwLock<HashMap<String, PathBuf>>>,
}

impl std::fmt::Debug for HookRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let count = self.specs.read().map(|g| g.len()).unwrap_or(0);
        f.debug_struct("HookRegistry")
            .field("workspace_root", &self.workspace_root)
            .field("hook_count", &count)
            .finish()
    }
}

impl HookRegistry {
    #[must_use]
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            specs: Arc::new(RwLock::new(Vec::new())),
            inline: Arc::new(RwLock::new(Vec::new())),
            plugin_roots: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Loads workspace hooks from `.omnia/hooks.json`, `.omp/hooks.json`, and `.claude/settings.json`.
    pub fn load_from_workspace(workspace_root: impl Into<PathBuf>) -> Result<Self> {
        let root = workspace_root.into();
        let registry = Self::new(root.clone());
        let candidates = [
            root.join(".omnia").join("hooks.json"),
            root.join(".omp").join("hooks.json"),
            root.join(".claude").join("settings.json"),
        ];
        for path in candidates {
            if path.is_file() {
                if let Ok(raw) = std::fs::read_to_string(&path) {
                    let parsed = parse_hooks_json(&raw, &path.to_string_lossy())?;
                    for spec in parsed {
                        registry.register_command(spec);
                    }
                }
            }
        }
        Ok(registry)
    }

    pub fn register_command(&self, spec: HookSpec) {
        if let Ok(mut roots) = self.plugin_roots.write() {
            roots.remove(&spec.id);
        }
        if let Ok(mut guard) = self.specs.write() {
            guard.retain(|existing| existing.id != spec.id);
            guard.push(spec);
        }
    }

    /// Registers a command hook with a trusted plugin root directory exported as `OMNIA_PLUGIN_ROOT`.
    pub fn register_command_with_root(&self, spec: HookSpec, plugin_root: PathBuf) {
        let id = spec.id.clone();
        if let Ok(mut guard) = self.specs.write() {
            guard.retain(|existing| existing.id != id);
            guard.push(spec);
        }
        if let Ok(mut roots) = self.plugin_roots.write() {
            roots.insert(id, plugin_root);
        }
    }

    /// Fires a non-blocking background hook dispatch (e.g., task/notification completion).
    pub fn fire_background(
        &self,
        event: HookEvent,
        match_subject: Option<String>,
        payload: Value,
    ) -> tokio::task::JoinHandle<HookDispatchOutcome> {
        let registry = self.clone();
        tokio::spawn(async move {
            registry
                .dispatch(event, match_subject.as_deref(), payload)
                .await
        })
    }

    pub fn register_inline(
        &self,
        id: impl Into<String>,
        event: HookEvent,
        matcher: Option<String>,
        callback: InlineHookCallback,
    ) {
        if let Ok(mut guard) = self.inline.write() {
            let id = id.into();
            guard.retain(|existing| existing.id != id);
            guard.push(RegisteredInlineHook {
                id,
                event,
                matcher,
                enabled: true,
                callback,
            });
        }
    }

    #[must_use]
    pub fn list(&self) -> Vec<HookSpec> {
        self.specs.read().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> bool {
        let mut changed = false;
        if let Ok(mut guard) = self.specs.write() {
            for spec in guard.iter_mut() {
                if spec.id == id {
                    spec.enabled = enabled;
                    changed = true;
                }
            }
        }
        if let Ok(mut guard) = self.inline.write() {
            for hook in guard.iter_mut() {
                if hook.id == id {
                    hook.enabled = enabled;
                    changed = true;
                }
            }
        }
        changed
    }

    /// Dispatches `event` across all enabled matching inline & command hooks.
    /// Exit code `2` from any command hook deterministically returns `blocked: true`.
    pub async fn dispatch(
        &self,
        event: HookEvent,
        match_subject: Option<&str>,
        payload: Value,
    ) -> HookDispatchOutcome {
        let mut outcome = HookDispatchOutcome {
            event,
            ..Default::default()
        };

        let inline_hooks: Vec<RegisteredInlineHook> = self
            .inline
            .read()
            .map(|g| {
                g.iter()
                    .filter(|h| {
                        h.enabled
                            && h.event == event
                            && matcher_matches(h.matcher.as_deref(), match_subject)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();

        for hook in inline_hooks {
            outcome.executed_hooks += 1;
            let dec = (hook.callback)(event, &payload);
            if dec.block {
                outcome.blocked = true;
                outcome.blocking_hook_id = Some(hook.id);
                outcome.blocking_exit_code = Some(HOOK_EXIT_HARD_BLOCK);
                outcome.block_reason = Some(
                    dec.reason
                        .unwrap_or_else(|| "blocked by inline lifecycle hook".into()),
                );
                outcome.additional_context.clear();
                outcome.revised_input = None;
                return outcome;
            }
            if let Some(rev) = dec.revised_input {
                outcome.revised_input = Some(rev);
            }
            if let Some(ctx) = dec.additional_context {
                push_unique_context(&mut outcome.additional_context, &ctx);
            }
        }

        let cmd_hooks: Vec<HookSpec> = self
            .specs
            .read()
            .map(|g| {
                g.iter()
                    .filter(|h| {
                        h.enabled
                            && h.event == event
                            && matcher_matches(h.matcher.as_deref(), match_subject)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();

        if cmd_hooks.is_empty() {
            return outcome;
        }

        let stdin_payload = json!({
            "hook_event_name": event.as_str(),
            "event": event.as_str(),
            "match_subject": match_subject,
            "workspace_root": self.workspace_root.to_string_lossy(),
            "payload": payload,
        })
        .to_string();

        for spec in cmd_hooks {
            outcome.executed_hooks += 1;
            let plugin_root = self
                .plugin_roots
                .read()
                .ok()
                .and_then(|map| map.get(&spec.id).cloned());
            match execute_hook_command(
                &self.workspace_root,
                &spec,
                plugin_root.as_deref(),
                &stdin_payload,
            )
            .await
            {
                Ok(cmd_out) => {
                    if cmd_out.exit_code == HOOK_EXIT_HARD_BLOCK {
                        let reason = first_non_empty(&[&cmd_out.stderr, &cmd_out.stdout])
                            .unwrap_or_else(|| {
                                format!(
                                    "hook `{}` exited with status 2 (deterministic hard block)",
                                    spec.id
                                )
                            });
                        outcome.blocked = true;
                        outcome.blocking_hook_id = Some(spec.id);
                        outcome.blocking_exit_code = Some(HOOK_EXIT_HARD_BLOCK);
                        outcome.block_reason = Some(reason);
                        outcome.additional_context.clear();
                        outcome.revised_input = None;
                        return outcome;
                    }

                    if cmd_out.exit_code != 0 {
                        let msg = first_non_empty(&[&cmd_out.stderr, &cmd_out.stdout])
                            .unwrap_or_else(|| {
                                format!("hook `{}` exited with status {}", spec.id, cmd_out.exit_code)
                            });
                        if spec.fail_closed {
                            outcome.blocked = true;
                            outcome.blocking_hook_id = Some(spec.id);
                            outcome.blocking_exit_code = Some(cmd_out.exit_code);
                            outcome.block_reason = Some(msg);
                            outcome.additional_context.clear();
                            outcome.revised_input = None;
                            return outcome;
                        }
                        outcome.warnings.push(msg);
                        continue;
                    }

                    // Exit 0: check optional structured JSON decision on stdout.
                    let trimmed = cmd_out.stdout.trim();
                    if trimmed.starts_with('{') {
                        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                            let blocked_by_json = parsed
                                .get("block")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                                || parsed.get("decision").and_then(Value::as_str) == Some("block")
                                || parsed.get("continue").and_then(Value::as_bool) == Some(false);
                            if blocked_by_json {
                                let reason = parsed
                                    .get("reason")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| format!("blocked by hook `{}`", spec.id));
                                outcome.blocked = true;
                                outcome.blocking_hook_id = Some(spec.id);
                                outcome.blocking_exit_code = Some(0);
                                outcome.block_reason = Some(reason);
                                outcome.additional_context.clear();
                                outcome.revised_input = None;
                                return outcome;
                            }
                            if let Some(rev) = parsed
                                .get("revised_input")
                                .or_else(|| parsed.get("updatedInput"))
                                .cloned()
                            {
                                outcome.revised_input = Some(rev);
                            }
                            if let Some(ctx) = parsed
                                .get("additionalContext")
                                .or_else(|| parsed.get("additional_context"))
                                .and_then(Value::as_str)
                            {
                                push_unique_context(&mut outcome.additional_context, ctx);
                            }
                        }
                    } else if !trimmed.is_empty() {
                        push_unique_context(&mut outcome.additional_context, trimmed);
                    }
                }
                Err(err) => {
                    if spec.fail_closed {
                        outcome.blocked = true;
                        outcome.blocking_hook_id = Some(spec.id);
                        outcome.block_reason = Some(format!("hook failed closed: {err}"));
                        return outcome;
                    }
                    outcome
                        .warnings
                        .push(format!("hook `{}` execution error: {err}", spec.id));
                }
            }
        }

        outcome
    }
}

/// Parses `.omnia/hooks.json` array or `.claude/settings.json` `{ "hooks": { "PreToolUse": [...] } }` formats.
pub fn parse_hooks_json(raw: &str, source: &str) -> Result<Vec<HookSpec>> {
    let val: Value = serde_json::from_str(raw).context("parse hooks JSON")?;
    let mut out = Vec::new();
    if let Some(arr) = val.as_array() {
        for (idx, item) in arr.iter().enumerate() {
            if let Ok(mut spec) = serde_json::from_value::<HookSpec>(item.clone()) {
                if spec.id.trim().is_empty() {
                    spec.id = format!("hook-{idx}");
                }
                if spec.source.is_empty() {
                    spec.source = source.to_owned();
                }
                out.push(spec);
            }
        }
        return Ok(out);
    }

    if let Some(obj) = val.get("hooks").and_then(Value::as_object) {
        let mut seq = 0usize;
        for (ev_key, entries) in obj {
            let Some(event) = HookEvent::parse_loose(ev_key) else {
                continue;
            };
            let Some(groups) = entries.as_array() else {
                continue;
            };
            for group in groups {
                let matcher = group
                    .get("matcher")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if let Some(hook_list) = group.get("hooks").and_then(Value::as_array) {
                    for entry in hook_list {
                        if let Some(cmd) = entry.get("command").and_then(Value::as_str) {
                            seq += 1;
                            out.push(HookSpec {
                                id: format!("{ev_key}-{seq}"),
                                event,
                                matcher: matcher.clone(),
                                command: cmd.to_owned(),
                                timeout_ms: entry
                                    .get("timeout_ms")
                                    .or_else(|| entry.get("timeout"))
                                    .and_then(Value::as_u64)
                                    .unwrap_or_else(default_hook_timeout_ms),
                                enabled: entry.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                                fail_closed: entry
                                    .get("fail_closed")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                                source: source.to_owned(),
                            });
                        }
                    }
                } else if let Some(cmd) = group.get("command").and_then(Value::as_str) {
                    seq += 1;
                    out.push(HookSpec {
                        id: format!("{ev_key}-{seq}"),
                        event,
                        matcher,
                        command: cmd.to_owned(),
                        timeout_ms: default_hook_timeout_ms(),
                        enabled: true,
                        fail_closed: false,
                        source: source.to_owned(),
                    });
                }
            }
        }
    }
    Ok(out)
}

#[derive(Debug)]
struct HookCommandOutput {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

async fn execute_hook_command(
    workspace_root: &Path,
    spec: &HookSpec,
    plugin_root: Option<&Path>,
    stdin_payload: &str,
) -> Result<HookCommandOutput> {
    #[cfg(windows)]
    let gate = owned_hook_tree::StartGate::new()
        .with_context(|| format!("create Windows StartGate for hook `{}`", spec.id))?;
    #[cfg(windows)]
    let gate_name = Some(gate.name());
    #[cfg(not(windows))]
    let gate_name: Option<&str> = None;

    let mut child = spawn_hidden_hook_shell(
        &spec.command,
        workspace_root,
        spec,
        plugin_root,
        gate_name,
    )?;

    // Fail closed BEFORE releasing the startup gate if Job Object / process-group ownership
    // cannot be established, ensuring zero user commands or descendants can escape supervision.
    let _tree_guard = owned_hook_tree::Guard::attach(&child)
        .with_context(|| format!("attach hook `{}` to isolated process tree", spec.id))?;

    #[cfg(windows)]
    gate.release()
        .with_context(|| format!("release Windows StartGate for hook `{}`", spec.id))?;

    let stdin = child.stdin.take();
    let payload_owned = stdin_payload.to_owned();
    let work = async move {
        if let Some(mut stdin) = stdin {
            let _ = stdin.write_all(payload_owned.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
        child.wait_with_output().await
    };

    let timeout = Duration::from_millis(spec.timeout_ms.clamp(250, 60_000));
    let output = tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| anyhow::anyhow!("hook `{}` timed out after {}ms", spec.id, timeout.as_millis()))??;

    Ok(HookCommandOutput {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

fn configure_hook_env(
    cmd: &mut tokio::process::Command,
    cwd: &Path,
    spec: &HookSpec,
    plugin_root: Option<&Path>,
) {
    cmd.current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Strip provider credentials from hook subprocess environments by default.
    for (k, _) in std::env::vars_os() {
        let ks = k.to_string_lossy().to_ascii_uppercase();
        if (ks.contains("API_KEY") || ks.contains("AUTH_TOKEN") || ks.contains("SECRET"))
            && !ks.starts_with("OMNIA_HOOK_")
        {
            cmd.env_remove(&k);
        }
    }
    cmd.env("OMNIA_HOOK_EVENT", spec.event.as_str());
    cmd.env("OMNIA_HOOK_ID", &spec.id);
    cmd.env("OMNIA_PROJECT_DIR", cwd);
    cmd.env("CLAUDE_PROJECT_DIR", cwd);
    if let Some(root) = plugin_root {
        cmd.env("OMNIA_PLUGIN_ROOT", root);
    }
}

#[cfg(windows)]
fn build_windows_gated_shell(
    program: &str,
    command: &str,
    cwd: &Path,
    spec: &HookSpec,
    plugin_root: Option<&Path>,
    gate_name: &str,
) -> tokio::process::Command {
    // Wait on the named Win32 StartGate event until the parent has attached this shell
    // to its kill-on-close Job Object, then launch `cmd.exe /d /s /c "..."` inheriting
    // raw OS stdin/stdout/stderr handles untouched so existing cmd.exe hooks & stdin JSON
    // continue to work identically with zero spawn-before-assign race or orphan leaks.
    const GATE_SCRIPT: &str = concat!(
        "$gateName = $env:OMNIA_HOOK_GATE; ",
        "$hookCmd = $env:OMNIA_HOOK_CMD; ",
        "Remove-Item Env:OMNIA_HOOK_GATE, Env:OMNIA_HOOK_CMD -ErrorAction SilentlyContinue; ",
        "$g = [System.Threading.EventWaitHandle]::OpenExisting($gateName); ",
        "try { if (-not $g.WaitOne(30000)) { exit 1 } } finally { $g.Dispose() }; ",
        "$psi = [System.Diagnostics.ProcessStartInfo]::new('cmd.exe', '/d /s /c \"' + $hookCmd + '\"'); ",
        "$psi.UseShellExecute = $false; ",
        "$p = [System.Diagnostics.Process]::Start($psi); ",
        "$p.WaitForExit(); ",
        "exit $p.ExitCode"
    );

    let mut cmd = tokio::process::Command::new(program);
    cmd.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", GATE_SCRIPT])
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    configure_hook_env(&mut cmd, cwd, spec, plugin_root);
    cmd.env("OMNIA_HOOK_GATE", gate_name);
    cmd.env("OMNIA_HOOK_CMD", command);
    cmd
}

fn spawn_hidden_hook_shell(
    command: &str,
    cwd: &Path,
    spec: &HookSpec,
    plugin_root: Option<&Path>,
    gate_name: Option<&str>,
) -> Result<tokio::process::Child> {
    #[cfg(windows)]
    {
        let gate_name = gate_name.context("missing Windows StartGate name")?;
        for shell in ["pwsh", "powershell"] {
            match build_windows_gated_shell(shell, command, cwd, spec, plugin_root, gate_name)
                .spawn()
            {
                Ok(child) => return Ok(child),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                Err(err) => {
                    return Err(err).with_context(|| format!("spawn hook `{}` via {shell}", spec.id));
                }
            }
        }
        anyhow::bail!(
            "spawn hook `{}`: neither `pwsh` nor `powershell` found on PATH",
            spec.id
        )
    }
    #[cfg(not(windows))]
    {
        let _ = gate_name;
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.args(["-c", command]);
        #[cfg(unix)]
        cmd.process_group(0);
        configure_hook_env(&mut cmd, cwd, spec, plugin_root);
        cmd.spawn()
            .with_context(|| format!("spawn hook `{}`", spec.id))
    }
}

fn matcher_matches(matcher: Option<&str>, subject: Option<&str>) -> bool {
    let Some(pat) = matcher.map(str::trim).filter(|s| !s.is_empty() && *s != "*") else {
        return true;
    };
    let Some(sub) = subject else {
        return false;
    };
    pat.split('|').any(|alt| {
        let alt = alt.trim();
        if alt == "*" {
            return true;
        }
        if let Some(prefix) = alt.strip_suffix('*') {
            return sub.starts_with(prefix);
        }
        sub == alt
    })
}

fn push_unique_context(dest: &mut Vec<String>, text: &str) {
    let trimmed = text.trim();
    if !trimmed.is_empty() && !dest.iter().any(|existing| existing == trimmed) {
        dest.push(trimmed.to_owned());
    }
}

fn first_non_empty(parts: &[&str]) -> Option<String> {
    parts
        .iter()
        .map(|s| s.trim())
        .find(|s| !s.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_all_25_lifecycle_events() {
        assert_eq!(HookEvent::ALL.len(), 25);
        let mut unique = std::collections::HashSet::new();
        for ev in HookEvent::ALL {
            assert!(unique.insert(ev.as_str()));
            assert_eq!(HookEvent::parse_loose(ev.as_str()), Some(ev));
        }
    }

    #[tokio::test]
    async fn exit_code_2_enforces_deterministic_hard_block() {
        let tmp = std::env::temp_dir().join(format!(
            "omnia_hook_test_{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&tmp);
        let registry = HookRegistry::new(&tmp);
        registry.register_command(HookSpec {
            id: "deny-dangerous-shell".into(),
            event: HookEvent::PreToolUse,
            matcher: Some("shell|run_code".into()),
            command: "echo blocked by policy 1>&2 && exit 2".into(),
            timeout_ms: 5_000,
            enabled: true,
            fail_closed: false,
            source: "unit-test".into(),
        });

        let out = registry
            .dispatch(HookEvent::PreToolUse, Some("shell"), json!({"command": "echo hi"}))
            .await;
        assert!(out.blocked);
        assert_eq!(out.blocking_exit_code, Some(2));
        assert_eq!(out.blocking_hook_id.as_deref(), Some("deny-dangerous-shell"));
        assert!(out
            .block_reason
            .as_deref()
            .unwrap_or("")
            .contains("blocked by policy"));

        // Non-matching tool is allowed cleanly.
        let allowed = registry
            .dispatch(HookEvent::PreToolUse, Some("read_file"), json!({}))
            .await;
        assert!(!allowed.blocked);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn parses_claude_and_omnia_hook_configs() {
        let json_cfg = r#"{
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "shell|edit_file",
                        "hooks": [{ "command": "echo ok", "timeout_ms": 2000 }]
                    }
                ]
            }
        }"#;
        let specs = parse_hooks_json(json_cfg, "test").expect("parse");
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].event, HookEvent::PreToolUse);
        assert_eq!(specs[0].matcher.as_deref(), Some("shell|edit_file"));
    }

    #[tokio::test]
    async fn timeout_kills_hook_process_tree_without_orphans() {
        let tmp = std::env::temp_dir().join(format!(
            "omnia_hook_timeout_{}",
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::create_dir_all(&tmp);
        let registry = HookRegistry::new(&tmp);
        let sleep_cmd = if cfg!(windows) {
            "ping -n 20 127.0.0.1 >nul"
        } else {
            "sleep 20"
        };
        registry.register_command(HookSpec {
            id: "slow-hook".into(),
            event: HookEvent::PostToolUse,
            matcher: None,
            command: sleep_cmd.into(),
            timeout_ms: 1_200,
            enabled: true,
            fail_closed: false,
            source: "unit-test".into(),
        });

        let started = std::time::Instant::now();
        let out = registry
            .dispatch(HookEvent::PostToolUse, Some("shell"), json!({}))
            .await;
        assert!(!out.blocked);
        assert!(
            out.warnings.iter().any(|w| w.contains("timed out")),
            "expected timeout warning, got {:?}",
            out.warnings
        );
        assert!(
            started.elapsed() < Duration::from_secs(6),
            "process tree termination hung: {:?}",
            started.elapsed()
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn plugin_root_is_exported_from_trusted_side_map() {
        let tmp = std::env::temp_dir().join(format!(
            "omnia_hook_root_{}",
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::create_dir_all(&tmp);
        let fake_root = tmp.join("trusted-plugin");
        let registry = HookRegistry::new(&tmp);
        let cmd = if cfg!(windows) {
            "echo %OMNIA_PLUGIN_ROOT%"
        } else {
            "printf %s \"$OMNIA_PLUGIN_ROOT\""
        };
        registry.register_command_with_root(
            HookSpec {
                id: "root-probe".into(),
                event: HookEvent::SessionStart,
                matcher: None,
                command: cmd.into(),
                timeout_ms: 8_000,
                enabled: true,
                fail_closed: false,
                source: "plugin".into(),
            },
            fake_root.clone(),
        );
        let out = registry
            .dispatch(HookEvent::SessionStart, None, json!({}))
            .await;
        assert!(
            out.additional_context
                .iter()
                .any(|c| c.contains("trusted-plugin")),
            "expected OMNIA_PLUGIN_ROOT in context, got {:?}",
            out.additional_context
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
