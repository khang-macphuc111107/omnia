//! shell, shell_output, shell_kill.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};

use super::shell_session::{self as session, Kind, SessionState, StateCapture};
use super::{cancelled, finish, parse_input, short, truncate_chars};
use crate::{EffectClass, HarnessResult, Tool, ToolContext, ToolOutput, ToolSpec};

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
const HEAD_BYTES: usize = 15_000;
const TAIL_BYTES: usize = 15_000;
const MAX_LINE_CHARS: usize = 8_000;

// ------------------------------------------------------------ output buffer

/// Keeps the first and last ~15k of output; the middle is dropped.
#[derive(Default)]
pub(crate) struct OutputBuf {
    head: String,
    tail: VecDeque<String>,
    tail_len: usize,
    dropped: usize,
}

impl OutputBuf {
    pub(crate) fn push_line(&mut self, line: &str) {
        let mut line = truncate_chars(line, MAX_LINE_CHARS);
        line.push('\n');
        if self.tail.is_empty() && self.dropped == 0 && self.head.len() + line.len() <= HEAD_BYTES {
            self.head.push_str(&line);
            return;
        }
        self.tail_len += line.len();
        self.tail.push_back(line);
        while self.tail_len > TAIL_BYTES {
            if let Some(front) = self.tail.pop_front() {
                self.tail_len -= front.len();
                self.dropped += front.len();
            } else {
                break;
            }
        }
    }

    pub(crate) fn render(&self) -> String {
        let mut out = self.head.clone();
        if self.dropped > 0 {
            out.push_str(&format!(
                "\n... [{} bytes of output truncated] ...\n\n",
                self.dropped
            ));
        }
        for line in &self.tail {
            out.push_str(line);
        }
        out
    }

    fn take(&mut self) -> String {
        let out = self.render();
        *self = Self::default();
        out
    }
}

// ----------------------------------------------------------- shell resolving

fn find_in_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        vec![".exe".into(), ".cmd".into(), ".bat".into(), String::new()]
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&paths) {
        for ext in &exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn find_git_bash() -> Option<PathBuf> {
    if let Some(bash) = find_in_path("bash") {
        // C:\Windows\System32\bash.exe is the WSL launcher, not Git Bash.
        let lower = bash.to_string_lossy().to_ascii_lowercase();
        if !cfg!(windows) || !lower.contains("\\windows\\system32") {
            return Some(bash);
        }
    }
    if cfg!(windows) {
        let mut candidates = Vec::new();
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
            if let Some(base) = std::env::var_os(var) {
                let base = PathBuf::from(base);
                candidates.push(base.join("Git").join("bin").join("bash.exe"));
                candidates.push(
                    base.join("Programs")
                        .join("Git")
                        .join("bin")
                        .join("bash.exe"),
                );
            }
        }
        if let Some(git) = find_in_path("git") {
            // <root>\cmd\git.exe -> <root>\bin\bash.exe
            if let Some(root) = git.parent().and_then(Path::parent) {
                candidates.push(root.join("bin").join("bash.exe"));
            }
        }
        return candidates.into_iter().find(|p| p.is_file());
    }
    None
}

fn default_shell<'a>() -> &'a str {
    if cfg!(windows) {
        if find_in_path("pwsh").is_some() {
            "pwsh"
        } else {
            "powershell"
        }
    } else {
        "bash"
    }
}

fn build_command(shell: Option<&str>, command: &str, cwd: &Path) -> Result<Command, String> {
    let shell = shell.unwrap_or_else(default_shell);
    let mut cmd = match shell {
        "pwsh" | "powershell" => {
            let exe = find_in_path(if shell == "pwsh" {
                "pwsh"
            } else {
                "powershell"
            })
            .ok_or_else(|| format!("shell `{shell}` was not found on PATH"))?;
            let mut cmd = Command::new(exe);
            cmd.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
            cmd.arg(format!(
                "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; {command}"
            ));
            cmd
        }
        "bash" => {
            let exe = find_git_bash()
                .or_else(|| (!cfg!(windows)).then(|| PathBuf::from("bash")))
                .ok_or("bash was not found (install Git for Windows or use powershell)")?;
            let mut cmd = Command::new(exe);
            cmd.arg("-c").arg(command);
            cmd
        }
        "cmd" => {
            if !cfg!(windows) {
                return Err("`cmd` is only available on Windows".into());
            }
            let mut cmd = Command::new("cmd.exe");
            #[cfg(windows)]
            {
                cmd.arg("/D").arg("/S").arg("/C");
                cmd.raw_arg(format!("\"{command}\""));
            }
            cmd
        }
        "wsl" => {
            if !cfg!(windows) {
                return Err("`wsl` is only available on Windows".into());
            }
            let mut cmd = Command::new("wsl.exe");
            cmd.args(["-e", "bash", "-c"]).arg(command);
            cmd
        }
        "sh" if !cfg!(windows) => {
            let mut cmd = Command::new("sh");
            cmd.arg("-c").arg(command);
            cmd
        }
        other => {
            return Err(format!(
                "unknown shell `{other}` (use powershell, pwsh, bash, cmd or wsl)"
            ))
        }
    };
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    #[cfg(unix)]
    cmd.process_group(0);
    Ok(cmd)
}

async fn kill_tree(pid: Option<u32>, child: Option<&mut Child>) {
    if let Some(pid) = pid {
        #[cfg(windows)]
        {
            let mut cmd = Command::new("taskkill");
            cmd.args(["/T", "/F", "/PID", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            cmd.creation_flags(0x0800_0000);
            let _ = cmd.status().await;
        }
        #[cfg(unix)]
        {
            let _ = Command::new("kill")
                .args(["-KILL", &format!("-{pid}")])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
    }
    if let Some(child) = child {
        let _ = child.start_kill();
    }
}

fn spawn_reader<R: AsyncRead + Unpin + Send + 'static>(
    stream: R,
    buf: Arc<Mutex<OutputBuf>>,
    progress: Option<Arc<dyn Fn(String) + Send + Sync>>,
    capture: Option<Arc<Mutex<StateCapture>>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stream);
        let mut raw = Vec::new();
        loop {
            raw.clear();
            match reader.read_until(b'\n', &mut raw).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&raw);
                    let line = line.trim_end_matches(['\n', '\r']);
                    if let Some(capture) = &capture {
                        if capture.lock().map(|mut c| c.feed(line)).unwrap_or(false) {
                            continue;
                        }
                    }
                    if let Some(progress) = &progress {
                        progress(line.to_string());
                    }
                    if let Ok(mut buf) = buf.lock() {
                        buf.push_line(line);
                    }
                }
            }
        }
    })
}

fn start_readers(
    child: &mut Child,
    buf: &Arc<Mutex<OutputBuf>>,
    progress: Option<Arc<dyn Fn(String) + Send + Sync>>,
    capture: Option<Arc<Mutex<StateCapture>>>,
) -> Vec<tokio::task::JoinHandle<()>> {
    let mut handles = Vec::new();
    if let Some(out) = child.stdout.take() {
        handles.push(spawn_reader(
            out,
            buf.clone(),
            progress.clone(),
            capture.clone(),
        ));
    }
    if let Some(err) = child.stderr.take() {
        handles.push(spawn_reader(err, buf.clone(), progress, capture));
    }
    handles
}

async fn join_readers(handles: Vec<tokio::task::JoinHandle<()>>) {
    for handle in handles {
        // A surviving grandchild can hold the pipe open; don't wait forever.
        let abort = handle.abort_handle();
        if tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .is_err()
        {
            abort.abort();
        }
    }
}

// ---------------------------------------------------------------- job table

#[derive(Clone, Copy, PartialEq)]
enum JobState {
    Running,
    Exited(Option<i32>),
}

struct Job {
    command: String,
    pid: Option<u32>,
    buf: Arc<Mutex<OutputBuf>>,
    state: Mutex<JobState>,
    killed: AtomicBool,
}

fn jobs() -> &'static Mutex<HashMap<String, Arc<Job>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<Job>>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}

fn get_job(id: &str) -> Result<Arc<Job>, String> {
    jobs()
        .lock()
        .ok()
        .and_then(|map| map.get(id).cloned())
        .ok_or_else(|| format!("no background job with id `{id}`"))
}

fn job_status(job: &Job) -> String {
    match *job.state.lock().unwrap() {
        JobState::Running => "running".into(),
        JobState::Exited(code) => {
            let code = code.map_or("unknown".to_string(), |c| c.to_string());
            if job.killed.load(Ordering::SeqCst) {
                format!("killed (exit code {code})")
            } else {
                format!("exited (exit code {code})")
            }
        }
    }
}

// --------------------------------------------------------------------- shell

pub struct ShellTool;

#[derive(Deserialize)]
struct ShellArgs {
    command: String,
    shell: Option<String>,
    timeout_ms: Option<u64>,
    #[serde(default)]
    run_in_background: bool,
    persist: Option<bool>,
}

#[async_trait]
impl Tool for ShellTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "shell".into(),
            description: "Run a shell command in the working directory and return its combined \
stdout/stderr and exit code. On Windows the default shell is PowerShell (pwsh if installed); pass \
`shell` = \"bash\" (Git Bash), \"cmd\", \"powershell\" or \"pwsh\" to choose another. Commands time \
out after `timeout_ms` (default 120000, max 600000) and the whole process tree is killed. Output \
over ~30k characters keeps the head and tail. Use `run_in_background` for long-running processes \
(dev servers, watchers): it returns a job id to use with shell_output and shell_kill. Prefer the \
dedicated file tools (read_file, grep, glob, edit_file) over shell equivalents. `cd` and environment \
changes persist between foreground calls of the same shell kind (default for bash and PowerShell; \
pass `persist` = false for a clean one-off call; use shell_reset to forget saved state). When the \
saved directory differs from the workspace root the output starts with `cwd: <path>`."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The command line to execute."},
                    "shell": {"type": "string", "enum": ["powershell", "pwsh", "bash", "cmd", "wsl"], "description": "Shell to use (default: pwsh/powershell on Windows, bash elsewhere). wsl runs bash inside WSL (Windows only, no persistence)."},
                    "timeout_ms": {"type": "integer", "minimum": 1, "maximum": 600000, "description": "Timeout in milliseconds (default 120000)."},
                    "run_in_background": {"type": "boolean", "description": "Start the command detached and return a job id (background jobs never persist state)."},
                    "persist": {"type": "boolean", "description": "Keep cwd and environment changes for later shell calls (default true for bash/powershell/pwsh, false for cmd; ignored for wsl and background jobs)."}
                },
                "required": ["command"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ExecuteProcess
    }

    fn describe(&self, input: &Value) -> String {
        let command = input["command"].as_str().unwrap_or("?");
        let bg = if input["run_in_background"].as_bool() == Some(true) {
            " (background)"
        } else {
            ""
        };
        format!("Run `{}`{bg}", short(command))
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        let args: ShellArgs = match parse_input(input) {
            Ok(args) => args,
            Err(error) => return Ok(ToolOutput::error(error)),
        };
        if args.run_in_background {
            return finish(start_background(ctx, args));
        }
        run_foreground(ctx, args).await
    }
}

async fn run_foreground(ctx: &ToolContext, args: ShellArgs) -> HarnessResult<ToolOutput> {
    let timeout_ms = args
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS);
    let shell_name = args.shell.as_deref().unwrap_or_else(default_shell);
    let kind =
        Kind::of(shell_name).filter(|kind| args.persist.unwrap_or_else(|| kind.default_persist()));

    // Durable state: start in the saved cwd with the saved env diff applied.
    let mut saved = SessionState::default();
    let mut run_cwd = ctx.cwd.clone();
    let mut header = String::new();
    let mut command = args.command.clone();
    let mut sentinel = String::new();
    let mut capture = None;
    if let Some(kind) = kind {
        saved = session::load(&ctx.session_id, &ctx.cwd, kind);
        if let Some(dir) = saved.cwd.clone() {
            if dir.is_dir() {
                run_cwd = dir;
            } else {
                header.push_str(&format!(
                    "note: saved directory {} no longer exists; using the workspace root\n",
                    dir.display()
                ));
                saved.cwd = None;
            }
        }
        sentinel = session::new_sentinel();
        command = session::wrap_command(kind, &args.command, &sentinel, &saved);
        capture = Some(Arc::new(Mutex::new(StateCapture::new(&sentinel))));
    }

    let mut cmd = match build_command(Some(shell_name), &command, &run_cwd) {
        Ok(cmd) => cmd,
        Err(error) => return Ok(ToolOutput::error(error)),
    };
    let start_env = kind.map(|_| session::effective_env(&saved));
    if kind == Some(Kind::Cmd) {
        // cmd has no safe inline syntax for env changes: use the process env.
        for key in &saved.unset {
            cmd.env_remove(key);
        }
        for (key, value) in &saved.set {
            cmd.env(key, value);
        }
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => return Ok(ToolOutput::error(format!("failed to start shell: {error}"))),
    };
    let pid = child.id();
    let buf = Arc::new(Mutex::new(OutputBuf::default()));
    let readers = start_readers(&mut child, &buf, ctx.progress.clone(), capture.clone());

    enum End {
        Exit(std::io::Result<std::process::ExitStatus>),
        Timeout,
        Cancel,
    }
    let end = tokio::select! {
        status = child.wait() => End::Exit(status),
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => End::Timeout,
        _ = ctx.cancel.cancelled() => End::Cancel,
    };
    if matches!(end, End::Timeout | End::Cancel) {
        kill_tree(pid, Some(&mut child)).await;
        let _ = child.wait().await;
    }
    join_readers(readers).await;
    let output = buf.lock().map(|b| b.render()).unwrap_or_default();
    match end {
        End::Cancel => Err(cancelled()),
        End::Timeout => Ok(ToolOutput::error(format!(
            "{output}\n[command timed out after {timeout_ms} ms and was killed]"
        ))),
        End::Exit(Err(error)) => Ok(ToolOutput::error(format!(
            "failed to wait for command: {error}"
        ))),
        End::Exit(Ok(status)) => {
            let mut code = status.code();
            if let (Some(kind), Some(capture), Some(start_env)) = (kind, &capture, &start_env) {
                let lines = capture.lock().map(|c| c.lines.clone()).unwrap_or_default();
                if let Some(block) = session::parse_block(kind, &sentinel, &lines) {
                    code = block.rc.or(code);
                    session::absorb(kind, &mut saved, &block, start_env);
                    session::save(&ctx.session_id, &ctx.cwd, kind, saved.clone());
                }
                if let Some(dir) = &saved.cwd {
                    if !session::same_dir(dir, &ctx.cwd) {
                        header.push_str(&format!("cwd: {}\n", dir.display()));
                    }
                }
            }
            let code_text = code.map_or("terminated by signal".to_string(), |c| c.to_string());
            let mut text = if kind.is_some() {
                // Drop the blank line the state trailer starts with.
                output.trim_end_matches(['\n', '\r']).to_string() + "\n"
            } else {
                output
            };
            if text.trim().is_empty() {
                text = "(no output)\n".into();
            }
            text.push_str(&format!("[exit code: {code_text}]"));
            Ok(ToolOutput {
                content: vec![crate::Block::text(format!("{header}{text}"))],
                is_error: code != Some(0),
            })
        }
    }
}

fn start_background(ctx: &ToolContext, args: ShellArgs) -> Result<ToolOutput, String> {
    let mut cmd = build_command(args.shell.as_deref(), &args.command, &ctx.cwd)?;
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("failed to start shell: {error}"))?;
    let pid = child.id();
    let buf = Arc::new(Mutex::new(OutputBuf::default()));
    let readers = start_readers(&mut child, &buf, None, None);
    let id = format!("bg_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let job = Arc::new(Job {
        command: args.command.clone(),
        pid,
        buf,
        state: Mutex::new(JobState::Running),
        killed: AtomicBool::new(false),
    });
    jobs().lock().unwrap().insert(id.clone(), job.clone());
    tokio::spawn(async move {
        let status = child.wait().await;
        join_readers(readers).await;
        *job.state.lock().unwrap() = JobState::Exited(status.ok().and_then(|s| s.code()));
    });
    Ok(ToolOutput::text(format!(
        "Started background job.\njob_id: {id}\nUse shell_output with this job_id to read new output and status, and shell_kill to stop it."
    )))
}

// -------------------------------------------------------------- shell_output

pub struct ShellOutputTool;

#[derive(Deserialize)]
struct JobArgs {
    job_id: String,
    wait_ms: Option<u64>,
}

#[async_trait]
impl Tool for ShellOutputTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "shell_output".into(),
            description:
                "Read output produced by a background shell job since the last read, plus \
its status (running / exited with code / killed). Optionally wait up to `wait_ms` (max 60000) for \
the job to finish first."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "job_id": {"type": "string", "description": "Id returned by shell with run_in_background."},
                    "wait_ms": {"type": "integer", "minimum": 0, "maximum": 60000, "description": "Wait up to this long for the job to exit before reading."}
                },
                "required": ["job_id"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Read output of job {}",
            input["job_id"].as_str().unwrap_or("?")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        let args: JobArgs = match parse_input(input) {
            Ok(args) => args,
            Err(error) => return Ok(ToolOutput::error(error)),
        };
        let job = match get_job(&args.job_id) {
            Ok(job) => job,
            Err(error) => return Ok(ToolOutput::error(error)),
        };
        if let Some(wait) = args.wait_ms {
            let deadline = tokio::time::Instant::now() + Duration::from_millis(wait.min(60_000));
            while *job.state.lock().unwrap() == JobState::Running
                && tokio::time::Instant::now() < deadline
            {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(50)) => {}
                    _ = ctx.cancel.cancelled() => return Err(cancelled()),
                }
            }
        }
        let output = job.buf.lock().map(|mut b| b.take()).unwrap_or_default();
        let output = if output.is_empty() {
            "(no new output)\n".to_string()
        } else {
            output
        };
        Ok(ToolOutput::text(format!(
            "{output}[job {} `{}`: {}]",
            args.job_id,
            short(&job.command),
            job_status(&job)
        )))
    }
}

// --------------------------------------------------------------- shell_kill

pub struct ShellKillTool;

#[async_trait]
impl Tool for ShellKillTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "shell_kill".into(),
            description: "Kill a background shell job (and its whole process tree).".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "job_id": {"type": "string", "description": "Id returned by shell with run_in_background."}
                },
                "required": ["job_id"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ExecuteProcess
    }

    fn describe(&self, input: &Value) -> String {
        format!("Kill job {}", input["job_id"].as_str().unwrap_or("?"))
    }

    async fn call(&self, _ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        let args: JobArgs = match parse_input(input) {
            Ok(args) => args,
            Err(error) => return Ok(ToolOutput::error(error)),
        };
        let job = match get_job(&args.job_id) {
            Ok(job) => job,
            Err(error) => return Ok(ToolOutput::error(error)),
        };
        if *job.state.lock().unwrap() != JobState::Running {
            return Ok(ToolOutput::text(format!(
                "Job {} already finished: {}",
                args.job_id,
                job_status(&job)
            )));
        }
        job.killed.store(true, Ordering::SeqCst);
        kill_tree(job.pid, None).await;
        for _ in 0..60 {
            if *job.state.lock().unwrap() != JobState::Running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok(ToolOutput::text(format!(
            "Killed job {}: {}",
            args.job_id,
            job_status(&job)
        )))
    }
}

// -------------------------------------------------------------- shell_reset

pub struct ShellResetTool;

#[derive(Deserialize)]
struct ResetArgs {
    shell: Option<String>,
}

#[async_trait]
impl Tool for ShellResetTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "shell_reset".into(),
            description: "Forget the saved shell state (working directory and environment \
changes) so the next shell call starts fresh in the workspace root. Resets every shell kind unless \
`shell` is given."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "shell": {"type": "string", "enum": ["powershell", "pwsh", "bash", "cmd"], "description": "Only reset this shell kind (default: all)."}
                },
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        // Only clears in-memory bookkeeping; no process runs, nothing on disk.
        EffectClass::PureCompute
    }

    fn describe(&self, input: &Value) -> String {
        match input["shell"].as_str() {
            Some(shell) => format!("Reset saved {shell} state"),
            None => "Reset saved shell state".into(),
        }
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        let args: ResetArgs = match parse_input(input) {
            Ok(args) => args,
            Err(error) => return Ok(ToolOutput::error(error)),
        };
        let only = match args.shell.as_deref() {
            None => None,
            Some(name) => match Kind::of(name) {
                Some(kind) => Some(kind),
                None => return Ok(ToolOutput::error(format!("unknown shell `{name}`"))),
            },
        };
        let cleared = session::reset(&ctx.session_id, &ctx.cwd, only);
        if cleared.is_empty() {
            return Ok(ToolOutput::text("No saved shell state to clear."));
        }
        let names: Vec<&str> = cleared.iter().map(|k| k.name()).collect();
        Ok(ToolOutput::text(format!(
            "Cleared saved cwd/env for: {}.",
            names.join(", ")
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Block, HarnessError};
    use tempfile::tempdir;

    fn have_bash() -> bool {
        find_git_bash().is_some()
    }

    fn ps_name() -> Option<&'static str> {
        ["pwsh", "powershell"]
            .into_iter()
            .find(|n| find_in_path(n).is_some())
    }

    fn session_ctx(dir: &Path, id: &str) -> ToolContext {
        let mut ctx = ToolContext::new(dir);
        ctx.session_id = id.into();
        ctx
    }

    async fn run(ctx: &ToolContext, shell: &str, command: &str) -> ToolOutput {
        ShellTool
            .call(ctx, json!({"command": command, "shell": shell}))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn bash_state_persists() {
        if !have_bash() {
            return;
        }
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let ctx = session_ctx(dir.path(), "persist-bash");
        let out = run(&ctx, "bash", "cd sub; export FOO=1; echo first; false").await;
        assert!(
            out.is_error && text(&out).contains("[exit code: 1]"),
            "{}",
            text(&out)
        );
        assert!(text(&out).contains("first") && !text(&out).contains("__OMNIA_"));
        assert!(text(&out).starts_with("cwd: "), "{}", text(&out));
        let out = run(&ctx, "bash", "pwd; echo foo=$FOO").await;
        let t = text(&out);
        assert!(t.contains("sub") && t.contains("foo=1"), "{t}");
        assert!(
            t.contains("[exit code: 0]") && !t.contains("__OMNIA_"),
            "{t}"
        );
        // exit in the command: state is left alone.
        let out = run(&ctx, "bash", "cd ..; exit 4").await;
        assert!(text(&out).contains("[exit code: 4]"), "{}", text(&out));
        let t = text(&run(&ctx, "bash", "pwd").await);
        assert!(t.contains("sub"), "{t}");
        // unset persists, persist=false is stateless, reset clears.
        run(&ctx, "bash", "unset FOO").await;
        assert!(text(&run(&ctx, "bash", "echo [$FOO]").await).contains("[]"));
        let out = ShellTool
            .call(
                &ctx,
                json!({"command": "cd /; export ZED=1", "shell": "bash", "persist": false}),
            )
            .await
            .unwrap();
        assert!(!text(&out).starts_with("cwd:"));
        assert!(text(&run(&ctx, "bash", "echo [$ZED]").await).contains("[]"));
        let out = ShellResetTool.call(&ctx, json!({})).await.unwrap();
        assert!(text(&out).contains("bash"), "{}", text(&out));
        let t = text(&run(&ctx, "bash", "pwd").await);
        assert!(!t.starts_with("cwd:"), "{t}");
    }

    #[tokio::test]
    async fn powershell_state_persists() {
        let Some(ps) = ps_name() else { return };
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let ctx = session_ctx(dir.path(), "persist-ps");
        let out = run(
            &ctx,
            ps,
            "Set-Location sub; $env:FOO='1'; 'first'; cmd /c exit 3",
        )
        .await;
        let t = text(&out);
        assert!(out.is_error && t.contains("[exit code: 3]"), "{t}");
        assert!(t.contains("first") && !t.contains("__OMNIA_"), "{t}");
        assert!(t.starts_with("cwd: "), "{t}");
        let t = text(&run(&ctx, ps, "(Get-Location).Path; \"foo=$env:FOO\"").await);
        assert!(t.contains("sub") && t.contains("foo=1"), "{t}");
        assert!(t.contains("[exit code: 0]"), "{t}");
        let t = text(&run(&ctx, ps, "Set-Location ..; exit 5").await);
        assert!(t.contains("[exit code: 5]"), "{t}");
        let t = text(&run(&ctx, ps, "(Get-Location).Path").await);
        assert!(t.contains("sub"), "{t}");
        let out = ShellResetTool
            .call(&ctx, json!({"shell": "powershell"}))
            .await
            .unwrap();
        assert!(text(&out).contains("powershell"), "{}", text(&out));
        let t = text(&run(&ctx, ps, "\"foo=[$env:FOO]\"").await);
        assert!(t.contains("foo=[]") && !t.starts_with("cwd:"), "{t}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cmd_state_persists_when_requested() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let ctx = session_ctx(dir.path(), "persist-cmd");
        let call = |command: &'static str| {
            let ctx = ctx.clone();
            async move {
                ShellTool
                    .call(
                        &ctx,
                        json!({"command": command, "shell": "cmd", "persist": true}),
                    )
                    .await
                    .unwrap()
            }
        };
        let out = call("cd sub & set FOO=1").await;
        let t = text(&out);
        assert!(
            t.contains("[exit code: 0]") && t.starts_with("cwd: "),
            "{t}"
        );
        let t = text(&call("cd & echo foo=%FOO%").await);
        assert!(t.contains("sub") && t.contains("foo=1"), "{t}");
    }

    fn text(out: &ToolOutput) -> String {
        match &out.content[0] {
            Block::Text { text } => text.clone(),
            other => panic!("{other:?}"),
        }
    }

    fn sleep_cmd() -> &'static str {
        if cfg!(windows) {
            "Start-Sleep -Seconds 60"
        } else {
            "sleep 60"
        }
    }

    #[test]
    fn output_buf_keeps_head_and_tail() {
        let mut buf = OutputBuf::default();
        for i in 0..20_000 {
            buf.push_line(&format!("line {i}"));
        }
        let out = buf.render();
        assert!(out.starts_with("line 0\n"));
        assert!(out.contains("truncated"));
        assert!(out.trim_end().ends_with("line 19999"));
        assert!(out.len() < 32_000);
    }

    #[tokio::test]
    async fn echo_and_exit_code() {
        let dir = tempdir().unwrap();
        let ctx = ToolContext::new(dir.path());
        let out = ShellTool
            .call(&ctx, json!({"command": "echo hello-omnia"}))
            .await
            .unwrap();
        assert!(!out.is_error, "{}", text(&out));
        assert!(text(&out).contains("hello-omnia") && text(&out).contains("[exit code: 0]"));
        let out = ShellTool
            .call(&ctx, json!({"command": "exit 3"}))
            .await
            .unwrap();
        assert!(out.is_error && text(&out).contains("[exit code: 3]"));
    }

    #[tokio::test]
    async fn runs_in_cwd_and_streams_progress() {
        let dir = tempdir().unwrap();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = seen.clone();
        let mut ctx = ToolContext::new(dir.path());
        ctx.progress = Some(Arc::new(move |s| sink.lock().unwrap().push(s)));
        let cmd = if cfg!(windows) {
            "(Get-Location).Path"
        } else {
            "pwd"
        };
        let out = ShellTool.call(&ctx, json!({"command": cmd})).await.unwrap();
        let leaf = dir
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(text(&out).contains(&leaf), "{}", text(&out));
        assert!(seen.lock().unwrap().iter().any(|l| l.contains(&leaf)));
    }

    #[tokio::test]
    async fn timeout_kills() {
        let dir = tempdir().unwrap();
        let ctx = ToolContext::new(dir.path());
        let started = std::time::Instant::now();
        let out = ShellTool
            .call(&ctx, json!({"command": sleep_cmd(), "timeout_ms": 800}))
            .await
            .unwrap();
        assert!(
            out.is_error && text(&out).contains("timed out"),
            "{}",
            text(&out)
        );
        assert!(started.elapsed() < Duration::from_secs(30));
    }

    #[tokio::test]
    async fn cancel_kills() {
        let dir = tempdir().unwrap();
        let ctx = ToolContext::new(dir.path());
        let token = ctx.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(800)).await;
            token.cancel();
        });
        let started = std::time::Instant::now();
        let result = ShellTool.call(&ctx, json!({"command": sleep_cmd()})).await;
        assert!(matches!(result, Err(HarnessError::Cancelled)));
        assert!(started.elapsed() < Duration::from_secs(30));
    }

    #[tokio::test]
    async fn background_job_output_and_kill() {
        let dir = tempdir().unwrap();
        let ctx = ToolContext::new(dir.path());
        let out = ShellTool
            .call(
                &ctx,
                json!({"command": "echo bg-done", "run_in_background": true}),
            )
            .await
            .unwrap();
        let id = text(&out)
            .lines()
            .find_map(|l| l.strip_prefix("job_id: "))
            .unwrap()
            .to_string();
        let out = ShellOutputTool
            .call(&ctx, json!({"job_id": id, "wait_ms": 20000}))
            .await
            .unwrap();
        assert!(
            text(&out).contains("bg-done") && text(&out).contains("exited"),
            "{}",
            text(&out)
        );

        let out = ShellTool
            .call(
                &ctx,
                json!({"command": sleep_cmd(), "run_in_background": true}),
            )
            .await
            .unwrap();
        let id = text(&out)
            .lines()
            .find_map(|l| l.strip_prefix("job_id: "))
            .unwrap()
            .to_string();
        let out = ShellOutputTool
            .call(&ctx, json!({"job_id": id}))
            .await
            .unwrap();
        assert!(text(&out).contains("running"));
        let out = ShellKillTool
            .call(&ctx, json!({"job_id": id}))
            .await
            .unwrap();
        assert!(text(&out).contains("killed"), "{}", text(&out));
        let out = ShellOutputTool
            .call(&ctx, json!({"job_id": "nope"}))
            .await
            .unwrap();
        assert!(out.is_error);
    }
}
