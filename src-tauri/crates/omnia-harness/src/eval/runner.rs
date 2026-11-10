//! Builds an [`Agent`] from a scenario, runs it, and collects what happened.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;

use super::check;
use super::fixture;
use super::scenario::{ApprovalSpec, Requirement, Scenario, ToolSet, Verdict};
use super::script::{LoggedRequest, ScriptedProvider};
use crate::agent::{
    push_user, Agent, AgentConfig, AgentEvent, ApprovalDecision, ApprovalRequest, Approver,
    EventSink, SteerQueue,
};
use crate::hooks::{HookConfig, HookRunner};
use crate::permission::{PermissionMode, PermissionPolicy};
use crate::prompt::{compose_system_prompt, PromptInputs};
use crate::subagent::{builtin_agents, TaskTool};
use crate::{
    memory, tools, Block, CheckpointScope, CheckpointStore, HarnessError, Message, Provider, Role,
    StopReason, ToolContext, ToolRegistry, Usage,
};

/// Result of one scenario.
#[derive(Debug, Clone)]
pub struct EvalReport {
    pub name: String,
    pub passed: bool,
    /// Set when a requirement was unmet; `passed` is then true.
    pub skipped: Option<String>,
    pub failures: Vec<String>,
    /// Tool calls that started executing (subagents included).
    pub tool_calls: usize,
    /// Tokens the model reported for the session agent's turns.
    pub tokens: Usage,
    pub turns: u32,
    pub duration: Duration,
}

impl EvalReport {
    fn failed(name: &str, message: String) -> Self {
        Self {
            name: name.to_owned(),
            passed: false,
            skipped: None,
            failures: vec![message],
            tool_calls: 0,
            tokens: Usage::default(),
            turns: 0,
            duration: Duration::ZERO,
        }
    }
}

/// Knobs for [`run_scenario_with`].
#[derive(Default, Clone)]
pub struct RunOptions {
    /// Replaces the scripted model (live mode, see `evals/README.md`). Script
    /// bookkeeping checks are skipped when set.
    pub provider: Option<Arc<dyn Provider>>,
}

/// Everything the assertions look at.
pub(crate) struct Observed {
    pub events: Vec<AgentEvent>,
    pub history: Vec<Message>,
    pub run_error: Option<String>,
    pub last_stop: Option<StopReason>,
    pub turns: u32,
    pub tokens: Usage,
    pub requests: Vec<LoggedRequest>,
    pub workspace: PathBuf,
}

struct ScriptedApprover {
    spec: ApprovalSpec,
    next: Mutex<usize>,
}

#[async_trait]
impl Approver for ScriptedApprover {
    async fn request(&self, _request: ApprovalRequest) -> ApprovalDecision {
        let index = {
            let mut next = self.next.lock().unwrap_or_else(|e| e.into_inner());
            let index = *next;
            *next += 1;
            index
        };
        let verdict = self
            .spec
            .decisions
            .get(index)
            .copied()
            .unwrap_or(self.spec.default);
        match verdict {
            Verdict::Allow => ApprovalDecision::AllowOnce,
            Verdict::Always => ApprovalDecision::AllowAlways,
            Verdict::Deny => ApprovalDecision::Deny {
                feedback: self.spec.feedback.clone(),
            },
        }
    }
}

struct Collector(Arc<Mutex<Vec<AgentEvent>>>);

impl EventSink for Collector {
    fn emit(&self, event: AgentEvent) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).push(event);
    }
}

/// Temp directory removed on drop (the crate has no runtime `tempfile` dependency).
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn new() -> std::io::Result<Self> {
        let path = std::env::temp_dir().join(format!("omnia-eval-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path)?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Directory holding the scenario files of this crate.
pub fn evals_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("evals")
}

/// Sorted paths of every `*.json` scenario in `dir`.
pub fn scenario_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

/// Runs the scenario file at `path` with the scripted model.
pub fn run_scenario(path: &Path) -> EvalReport {
    run_scenario_with(path, RunOptions::default())
}

pub fn run_scenario_with(path: &Path, options: RunOptions) -> EvalReport {
    let label = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    let scenario: Scenario = match std::fs::read_to_string(path)
        .map_err(|error| error.to_string())
        .and_then(|text| serde_json::from_str(&text).map_err(|error| error.to_string()))
    {
        Ok(scenario) => scenario,
        Err(error) => return EvalReport::failed(&label, format!("cannot load scenario: {error}")),
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => return EvalReport::failed(&scenario.name, format!("no runtime: {error}")),
    };
    runtime.block_on(run_loaded(scenario, options))
}

fn default_shell_available() -> bool {
    let program = if cfg!(windows) { "powershell" } else { "bash" };
    std::process::Command::new(program)
        .arg(if cfg!(windows) { "-NoProfile" } else { "-c" })
        .arg(if cfg!(windows) { "-Command" } else { "true" })
        .arg("exit 0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn registry_for(set: ToolSet, home: &Path) -> ToolRegistry {
    let mut registry = match set {
        ToolSet::ReadOnly => tools::read_only_registry(),
        _ => tools::builtin_registry(),
    };
    if set == ToolSet::BuiltinMemory {
        memory::register(&mut registry, Some(home.to_path_buf()));
    }
    registry
}

pub async fn run_loaded(scenario: Scenario, options: RunOptions) -> EvalReport {
    let started = Instant::now();
    for requirement in &scenario.requires {
        match requirement {
            Requirement::DefaultShell if !default_shell_available() => {
                return EvalReport {
                    name: scenario.name.clone(),
                    passed: true,
                    skipped: Some("default shell is not available".to_owned()),
                    failures: Vec::new(),
                    tool_calls: 0,
                    tokens: Usage::default(),
                    turns: 0,
                    duration: started.elapsed(),
                };
            }
            Requirement::DefaultShell => {}
        }
    }

    let root = match ScratchDir::new() {
        Ok(dir) => dir,
        Err(error) => return EvalReport::failed(&scenario.name, format!("tempdir: {error}")),
    };
    let workspace = root.path().join("ws");
    let home = root.path().join("home");
    if let Err(error) = fixture::materialize(&scenario.workspace, &workspace) {
        return EvalReport::failed(&scenario.name, format!("fixture: {error}"));
    }
    let store = match CheckpointStore::open(root.path().join("checkpoints")) {
        Ok(store) => Arc::new(store),
        Err(error) => return EvalReport::failed(&scenario.name, format!("checkpoints: {error}")),
    };

    let scripted = ScriptedProvider::new(&scenario.script);
    let live = options.provider.is_some();
    let provider: Arc<dyn Provider> = match options.provider {
        Some(provider) => provider,
        None => Arc::new(scripted.clone()),
    };
    let log = Arc::new(Mutex::new(Vec::new()));
    let events: Arc<dyn EventSink> = Arc::new(Collector(Arc::clone(&log)));
    let mut policy = PermissionPolicy::new(scenario.permission_mode);
    policy.rules = scenario.rules.clone();
    let policy = Arc::new(tokio::sync::Mutex::new(policy));
    let approver: Arc<dyn Approver> = Arc::new(ScriptedApprover {
        spec: scenario.approval.clone(),
        next: Mutex::new(0),
    });
    let hooks = (!scenario.hooks.is_empty()).then(|| {
        Arc::new(HookRunner::new(
            HookConfig {
                hooks: scenario.hooks.clone(),
                errors: Vec::new(),
            },
            "eval",
        ))
    });
    let mut config = AgentConfig {
        model: "eval-model".to_owned(),
        max_retries: 0,
        // Compaction only runs when a scenario opts in.
        compact_threshold: 0.0,
        ..AgentConfig::default()
    };
    scenario.config.apply(&mut config);

    let mut ctx = ToolContext::new(&workspace);
    ctx.session_id = format!("eval-{}-{}", scenario.name, uuid::Uuid::new_v4());

    let mut history: Vec<Message> = Vec::new();
    let mut run_error = None;
    let mut last_stop = None;
    let mut turns = 0;
    let mut checkpoint_ids = Vec::new();

    for prompt in &scenario.prompts {
        let memory_section = memory::memory_prompt_section(&workspace, Some(&home));
        let system = compose_system_prompt(&PromptInputs {
            base: "You are the Omnia eval agent.".to_owned(),
            project_default: None,
            session_override: None,
            plan_mode: scenario.permission_mode == PermissionMode::Plan,
            memory_section: memory_section.as_deref(),
            skills_section: None,
        });
        let mut run_config = config.clone();
        run_config.system = Some(system);
        let mut registry = registry_for(scenario.tools, &home);
        if scenario.tools == ToolSet::BuiltinTask {
            let task = TaskTool {
                provider: Arc::clone(&provider),
                config: run_config.clone(),
                tools: registry.clone(),
                policy: Arc::clone(&policy),
                approver: Arc::clone(&approver),
                events: Arc::clone(&events),
                agents: builtin_agents(),
                hooks: hooks.clone(),
                current_depth: 0,
                max_depth: crate::subagent::DEFAULT_MAX_SUBAGENT_DEPTH,
            };
            registry.register(Arc::new(task));
        }
        let agent = Agent {
            provider: Arc::clone(&provider),
            tools: registry,
            policy: Arc::clone(&policy),
            approver: Arc::clone(&approver),
            events: Arc::clone(&events),
            steer: SteerQueue::default(),
            config: run_config,
            hooks: hooks.clone(),
        };
        let id = history.len();
        checkpoint_ids.push(id);
        ctx.checkpoint = Some(CheckpointScope::from_key(Arc::clone(&store), id));
        push_user(&mut history, vec![Block::text(prompt.clone())]);
        match agent.run(&mut history, &ctx).await {
            Ok(outcome) => {
                last_stop = Some(outcome.stop);
                turns += outcome.turns;
            }
            Err(error) => {
                run_error = Some(match error {
                    HarnessError::Cancelled => "cancelled".to_owned(),
                    other => other.to_string(),
                });
                break;
            }
        }
    }

    let events = log.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut tokens = Usage::default();
    for event in &events {
        if let AgentEvent::TurnCompleted { usage, .. } = event {
            tokens.add(usage);
        }
    }
    let observed = Observed {
        events,
        history,
        run_error,
        last_stop,
        turns,
        tokens,
        requests: scripted.requests(),
        workspace: workspace.clone(),
    };
    let mut failures = check::check_expect(&scenario.expect, &observed);

    if !live {
        for note in scripted.unmatched() {
            failures.push(format!("script: {note}"));
        }
        if !scenario.allow_unused_turns && scripted.unused() > 0 {
            failures.push(format!(
                "script: {} scripted turn(s) were never used",
                scripted.unused()
            ));
        }
    }

    if let Some(prompt_index) = scenario.restore_checkpoint {
        match checkpoint_ids.get(prompt_index) {
            Some(id) => {
                let report = store.restore(*id);
                if !report.failed.is_empty() {
                    failures.push(format!("checkpoint restore failed: {:?}", report.failed));
                }
                failures.extend(check::check_files(
                    &scenario.after_restore,
                    &workspace,
                    "after restore",
                ));
            }
            None => failures.push(format!(
                "restore_checkpoint {prompt_index} is out of range (ran {} prompts)",
                checkpoint_ids.len()
            )),
        }
    }

    let tool_calls = check::executed_names(&observed.events).len();
    EvalReport {
        name: scenario.name.clone(),
        passed: failures.is_empty(),
        skipped: None,
        failures,
        tool_calls,
        tokens,
        turns,
        duration: started.elapsed(),
    }
}

/// The last assistant turn's text.
pub(crate) fn final_text(history: &[Message]) -> String {
    history
        .iter()
        .rev()
        .find(|message| message.role == Role::Assistant)
        .map(|message| {
            message
                .content
                .iter()
                .filter_map(|block| match block {
                    Block::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
