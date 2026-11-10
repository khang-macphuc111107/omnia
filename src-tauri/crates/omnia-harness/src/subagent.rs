//! The `task` tool: delegate a self-contained job to a subagent that runs its
//! own loop with its own context window, then returns one report. Several
//! `task` calls in one turn run in parallel.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::agent::{
    Agent, AgentConfig, AgentEvent, ApprovalDecision, ApprovalRequest, Approver, EventSink,
    SteerQueue,
};
use crate::permission::PermissionPolicy;
use crate::{
    Block, EffectClass, HarnessError, HarnessResult, Message, Provider, Role, Tool, ToolContext,
    ToolOutput, ToolRegistry, ToolSpec,
};

const MAX_DEFINITION_BYTES: u64 = 128 * 1024;
const SUBAGENT_MAX_TURNS: u32 = 100;
pub const DEFAULT_MAX_SUBAGENT_DEPTH: usize = 5;

/// A subagent type: built in, or a Markdown file with frontmatter
/// (`name`, `description`, optional comma-separated `tools`, optional `model`)
/// whose body is the subagent's instructions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    /// Allowed tool names; `None` = every tool the parent has (minus `task`).
    pub tools: Option<Vec<String>>,
    pub model: Option<String>,
    pub prompt: String,
    #[serde(default)]
    pub read_only: bool,
}

pub fn builtin_agents() -> Vec<AgentDefinition> {
    vec![
        AgentDefinition {
            name: "general".to_owned(),
            description: "Multi-step work of any kind: research, edits, running commands.".to_owned(),
            tools: None,
            model: None,
            prompt: String::new(),
            read_only: false,
        },
        AgentDefinition {
            name: "explore".to_owned(),
            description: "Fast read-only search across the codebase or the web; returns findings, never edits.".to_owned(),
            tools: None,
            model: None,
            prompt: "Search broadly and report concrete findings with file paths and line numbers. Do not modify anything.".to_owned(),
            read_only: true,
        },
    ]
}

/// Built-ins plus definitions from `<workspace>/.omnia/agents`,
/// `<workspace>/.claude/agents` and each user dir. Later sources override
/// earlier ones with the same name, so project files win.
pub fn discover_agents(workspace: &Path, user_dirs: &[PathBuf]) -> Vec<AgentDefinition> {
    discover_agents_with_plugins(workspace, user_dirs, &[])
}

/// [`discover_agents`] plus the `agents/` folders of enabled plugins, which
/// rank below user and workspace definitions.
pub fn discover_agents_with_plugins(
    workspace: &Path,
    user_dirs: &[PathBuf],
    plugin_dirs: &[PathBuf],
) -> Vec<AgentDefinition> {
    let mut agents = builtin_agents();
    let mut dirs: Vec<PathBuf> = plugin_dirs.to_vec();
    dirs.extend_from_slice(user_dirs);
    dirs.push(workspace.join(".claude").join("agents"));
    dirs.push(workspace.join(".omnia").join("agents"));
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut paths: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            })
            .collect();
        paths.sort();
        for path in paths {
            if let Some(definition) = load_definition(&path) {
                agents.retain(|existing| existing.name != definition.name);
                agents.push(definition);
            }
        }
    }
    agents
}

fn load_definition(path: &Path) -> Option<AgentDefinition> {
    if std::fs::metadata(path).ok()?.len() > MAX_DEFINITION_BYTES {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let (fields, body) = split_frontmatter(&text);
    let field = |key: &str| {
        fields
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
            .filter(|value| !value.is_empty())
    };
    let name = field("name").or_else(|| {
        path.file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
    })?;
    Some(AgentDefinition {
        name,
        description: field("description").unwrap_or_default(),
        tools: field("tools").map(|tools| {
            tools
                .split(',')
                .map(|tool| tool.trim().to_owned())
                .filter(|tool| !tool.is_empty())
                .collect()
        }),
        model: field("model").filter(|model| model != "inherit"),
        prompt: body.trim().to_owned(),
        read_only: false,
    })
}

/// Minimal `key: value` frontmatter between leading `---` fences.
fn split_frontmatter(text: &str) -> (Vec<(String, String)>, &str) {
    let text = text.trim_start_matches('\u{feff}');
    let Some(rest) = text.strip_prefix("---") else {
        return (Vec::new(), text);
    };
    let Some(end) = rest.find("\n---") else {
        return (Vec::new(), text);
    };
    let fields = rest[..end]
        .lines()
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| {
            let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
            (key.trim().to_owned(), value.to_owned())
        })
        .collect();
    let body = &rest[end + 4..];
    (fields, body.split_once('\n').map_or("", |(_, body)| body))
}

pub struct TaskTool {
    pub provider: Arc<dyn Provider>,
    /// The parent's config; `system` and `model` are inherited.
    pub config: AgentConfig,
    /// The parent's tools. `task` itself is never passed down.
    pub tools: ToolRegistry,
    pub policy: Arc<Mutex<PermissionPolicy>>,
    pub approver: Arc<dyn Approver>,
    pub events: Arc<dyn EventSink>,
    pub agents: Vec<AgentDefinition>,
    pub hooks: Option<Arc<crate::hooks::HookRunner>>,
    pub current_depth: usize,
    pub max_depth: usize,
}

impl TaskTool {
    fn registry_for(
        &self,
        definition: &AgentDefinition,
        child_approver: &Arc<dyn Approver>,
        child_events: &Arc<dyn EventSink>,
    ) -> ToolRegistry {
        let mut registry = ToolRegistry::default();
        for name in self.tools.names() {
            if name == "task" {
                continue;
            }
            let Some(tool) = self.tools.get(name) else {
                continue;
            };
            let allowed = match &definition.tools {
                Some(list) => list.iter().any(|allowed| allowed == name),
                None if definition.read_only => {
                    tool.effect().is_read_only() || tool.effect() == EffectClass::Network
                }
                None => true,
            };
            if allowed {
                registry.register(tool);
            }
        }
        if self.current_depth + 1 < self.max_depth && !definition.read_only {
            let child_task = Arc::new(TaskTool {
                provider: Arc::clone(&self.provider),
                config: self.config.clone(),
                tools: self.tools.clone(),
                policy: Arc::clone(&self.policy),
                approver: Arc::clone(child_approver),
                events: Arc::clone(child_events),
                agents: self.agents.clone(),
                hooks: self.hooks.clone(),
                current_depth: self.current_depth + 1,
                max_depth: self.max_depth,
            });
            registry.register(child_task);
        }
        registry
    }
}

/// Provider tool-call ids are local to one response (some adapters synthesize
/// `call_0`), but the parent's approval channels and UI share one id space.
/// Qualify only the outward-facing copies: the child provider history and tool
/// results must keep the exact ids the provider supplied.
struct ChildEventIds {
    prefix: String,
    state: StdMutex<ChildEventIdState>,
}

#[derive(Default)]
struct ChildEventIdState {
    turn: u32,
    ids: HashMap<String, String>,
}

impl ChildEventIds {
    fn new() -> Self {
        Self {
            prefix: format!("subagent_{}", uuid::Uuid::new_v4().simple()),
            state: StdMutex::default(),
        }
    }

    fn qualify(&self, id: &str) -> String {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state
            .ids
            .get(id)
            .cloned()
            .unwrap_or_else(|| format!("{}_t{}_{}", self.prefix, state.turn, id))
    }

    fn introduce(&self, id: &str) -> String {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let external = format!("{}_t{}_{}", self.prefix, state.turn, id);
        state.ids.insert(id.to_owned(), external.clone());
        external
    }

    fn request(&self, request: &mut ApprovalRequest) {
        request.tool_use_id = self.qualify(&request.tool_use_id);
        for queued in &mut request.remaining {
            queued.tool_use_id = self.qualify(&queued.tool_use_id);
        }
    }

    fn blocks(&self, blocks: &mut [Block]) {
        for block in blocks {
            match block {
                Block::ToolUse { id, .. } => *id = self.introduce(id),
                Block::ToolResult {
                    tool_use_id,
                    content,
                    ..
                } => {
                    *tool_use_id = self.qualify(tool_use_id);
                    self.blocks(content);
                }
                _ => {}
            }
        }
    }

    fn event(&self, mut event: AgentEvent) -> AgentEvent {
        match &mut event {
            AgentEvent::TurnStarted { turn } => {
                self.state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .turn = *turn;
            }
            AgentEvent::AssistantMessage { message } => self.blocks(&mut message.content),
            AgentEvent::ApprovalRequested { request } => self.request(request),
            AgentEvent::ToolProposed { id, .. } => *id = self.introduce(id),
            AgentEvent::ApprovalDecided { id, .. }
            | AgentEvent::PlanPresented { id, .. }
            | AgentEvent::ToolStarted { id }
            | AgentEvent::ToolProgress { id, .. }
            | AgentEvent::ToolCompleted { id, .. } => *id = self.qualify(id),
            // A deeper child's inner events already carry that child's identity.
            AgentEvent::Subagent { parent_id, .. } => *parent_id = self.qualify(parent_id),
            _ => {}
        }
        event
    }
}

struct ChildApprover {
    parent: Arc<dyn Approver>,
    ids: Arc<ChildEventIds>,
}

#[async_trait]
impl Approver for ChildApprover {
    async fn request(&self, mut request: ApprovalRequest) -> ApprovalDecision {
        self.ids.request(&mut request);
        self.parent.request(request).await
    }
}

struct NestedSink {
    parent: Arc<dyn EventSink>,
    parent_id: String,
    ids: Arc<ChildEventIds>,
}

impl EventSink for NestedSink {
    fn emit(&self, event: AgentEvent) {
        // Keep token text/thinking private to the child's transcript, but
        // usage must cross this boundary for durable parent-session accounting.
        if matches!(&event, AgentEvent::Stream { event }
            if !matches!(event, crate::StreamEvent::Usage { .. }))
        {
            return;
        }
        self.parent.emit(AgentEvent::Subagent {
            parent_id: self.parent_id.clone(),
            event: Box::new(self.ids.event(event)),
        });
    }
}

#[async_trait]
impl Tool for TaskTool {
    fn spec(&self) -> ToolSpec {
        let types = self
            .agents
            .iter()
            .map(|agent| format!("- {}: {}", agent.name, agent.description))
            .collect::<Vec<_>>()
            .join("\n");
        ToolSpec {
            name: "task".to_owned(),
            description: format!(
                "Start a subagent with a fresh context to do a self-contained job and return one report. \
                 Use it for broad searches or independent pieces of work; call it several times in one turn \
                 to run subagents in parallel. The subagent sees only your prompt, so include every detail it needs.\n\
                 Subagent types:\n{types}"
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "description": {"type": "string", "description": "3-6 word label for the job"},
                    "prompt": {"type": "string", "description": "Complete instructions for the subagent"},
                    "subagent_type": {"type": "string", "description": "One of the subagent types; default general"}
                },
                "required": ["description", "prompt"]
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        // The subagent's own tool calls go through the permission policy.
        EffectClass::PureCompute
    }

    fn describe(&self, input: &Value) -> String {
        let label = input
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("subagent");
        format!("Task: {label}")
    }

    fn as_any(&self) -> Option<&dyn std::any::Any> {
        Some(self)
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        let Some(prompt) = input
            .get("prompt")
            .and_then(Value::as_str)
            .filter(|p| !p.trim().is_empty())
        else {
            return Ok(ToolOutput::error("`prompt` is required"));
        };
        let kind = input
            .get("subagent_type")
            .and_then(Value::as_str)
            .unwrap_or("general");
        let Some(definition) = self.agents.iter().find(|agent| agent.name == kind) else {
            let names: Vec<&str> = self
                .agents
                .iter()
                .map(|agent| agent.name.as_str())
                .collect();
            return Ok(ToolOutput::error(format!(
                "Unknown subagent_type `{kind}`. Available: {}",
                names.join(", ")
            )));
        };

        let mut system = self.config.system.clone().unwrap_or_default();
        system.push_str(
            "\n\n# Subagent\nYou are a subagent started by another agent. Do the job below completely, \
             then end with a final message that is a self-contained report of what you found or did \
             (paths, results, anything unfinished). That final message is all the parent sees.",
        );
        if !definition.prompt.is_empty() {
            system.push_str("\n\n");
            system.push_str(&definition.prompt);
        }
        let ids = Arc::new(ChildEventIds::new());
        let child_approver: Arc<dyn Approver> = Arc::new(ChildApprover {
            parent: Arc::clone(&self.approver),
            ids: Arc::clone(&ids),
        });
        let child_events: Arc<dyn EventSink> = Arc::new(NestedSink {
            parent: Arc::clone(&self.events),
            parent_id: ctx.tool_use_id.clone(),
            ids,
        });
        let child_tools = self.registry_for(definition, &child_approver, &child_events);
        let agent = Agent {
            provider: Arc::clone(&self.provider),
            tools: child_tools,
            policy: Arc::clone(&self.policy),
            approver: child_approver,
            events: child_events,
            steer: SteerQueue::default(),
            config: AgentConfig {
                model: definition
                    .model
                    .clone()
                    .unwrap_or_else(|| self.config.model.clone()),
                system: Some(system),
                max_turns: SUBAGENT_MAX_TURNS,
                ..self.config.clone()
            },
            hooks: self.hooks.clone(),
        };
        let mut history = vec![Message {
            role: Role::User,
            content: vec![Block::text(prompt)],
        }];
        let mut sub_ctx = ctx.clone();
        // File changes belong to the parent's active boundary, while child
        // compaction/steering must never reindex the parent's transcript.
        sub_ctx.checkpoint = sub_ctx
            .checkpoint
            .as_ref()
            .map(crate::CheckpointScope::child);
        sub_ctx.progress = None;
        match agent.run(&mut history, &sub_ctx).await {
            Ok(_) => {}
            Err(HarnessError::Cancelled) => return Err(HarnessError::Cancelled),
            Err(error) => return Ok(ToolOutput::error(format!("Subagent failed: {error}"))),
        }
        let report = history
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
            .unwrap_or_default();
        if report.trim().is_empty() {
            return Ok(ToolOutput::error("The subagent finished without a report."));
        }
        Ok(ToolOutput::text(report))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_event_ids_are_stable_for_late_progress_and_distinct_across_turns() {
        let ids = ChildEventIds::new();
        ids.event(AgentEvent::TurnStarted { turn: 1 });
        let first = ids.introduce("call_0");
        let sibling = ChildEventIds::new();
        sibling.event(AgentEvent::TurnStarted { turn: 1 });
        assert_ne!(first, sibling.introduce("call_0"));

        ids.event(AgentEvent::TurnStarted { turn: 2 });
        // A callback for an older, unreused id still points at its original row.
        assert!(matches!(
            ids.event(AgentEvent::ToolProgress { id: "call_0".into(), chunk: "late".into() }),
            AgentEvent::ToolProgress { id, .. } if id == first
        ));
        let repeated = ids.introduce("call_0");
        assert_ne!(repeated, first);
        assert_eq!(ids.qualify("call_0"), repeated);

        // Artifact ids identify stored artifacts, not provider calls.
        let artifact = AgentEvent::Artifact {
            id: "artifact-1".into(),
            version: 1,
            title: "test".into(),
            kind: "text".into(),
            action: "created".into(),
        };
        assert_eq!(ids.event(artifact.clone()), artifact);
    }

    #[test]
    fn parses_definition_files_and_project_overrides() {
        let dir = tempfile::tempdir().unwrap();
        let agents_dir = dir.path().join(".omnia").join("agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        std::fs::write(
            agents_dir.join("reviewer.md"),
            "---\nname: reviewer\ndescription: \"Reviews diffs\"\ntools: read_file, grep\nmodel: inherit\n---\nBe strict.\n",
        )
        .unwrap();
        std::fs::write(
            agents_dir.join("explore.md"),
            "---\ndescription: custom explore\n---\nGo.",
        )
        .unwrap();
        let agents = discover_agents(dir.path(), &[]);
        let reviewer = agents
            .iter()
            .find(|agent| agent.name == "reviewer")
            .unwrap();
        assert_eq!(reviewer.description, "Reviews diffs");
        assert_eq!(
            reviewer.tools.as_deref(),
            Some(&["read_file".to_owned(), "grep".to_owned()][..])
        );
        assert_eq!(reviewer.model, None);
        assert_eq!(reviewer.prompt, "Be strict.");
        let explore: Vec<_> = agents
            .iter()
            .filter(|agent| agent.name == "explore")
            .collect();
        assert_eq!(explore.len(), 1);
        assert_eq!(explore[0].description, "custom explore");
    }

    #[test]
    fn hierarchical_subagent_recursion_respects_depth_limit() {
        use crate::agent::AutoApprove;
        use crate::provider::{Provider, ProviderRequest, ProviderStream};
        struct DummyProvider;
        #[async_trait]
        impl Provider for DummyProvider {
            fn id(&self) -> &str {
                "dummy"
            }
            async fn stream(&self, _: ProviderRequest) -> HarnessResult<ProviderStream> {
                unimplemented!()
            }
        }

        let events: Arc<dyn EventSink> = Arc::new(|_: crate::agent::AgentEvent| {});
        let parent_task = TaskTool {
            provider: Arc::new(DummyProvider),
            config: AgentConfig::default(),
            tools: ToolRegistry::default(),
            policy: Arc::new(tokio::sync::Mutex::new(PermissionPolicy::new(
                crate::permission::PermissionMode::Full,
            ))),
            approver: Arc::new(AutoApprove),
            events: Arc::clone(&events),
            agents: builtin_agents(),
            hooks: None,
            current_depth: 0,
            max_depth: 3,
        };

        let general_agent = builtin_agents()
            .into_iter()
            .find(|a| a.name == "general")
            .unwrap();
        let explore_agent = builtin_agents()
            .into_iter()
            .find(|a| a.name == "explore")
            .unwrap();
        let approver: Arc<dyn Approver> = Arc::new(AutoApprove);

        // Depth 0 -> Child (Depth 1) should have 'task' tool
        let child_tools = parent_task.registry_for(&general_agent, &approver, &events);
        assert!(
            child_tools.get("task").is_some(),
            "Depth 1 must have task tool"
        );

        // Read-only agent should NOT have 'task' tool
        let explore_tools = parent_task.registry_for(&explore_agent, &approver, &events);
        assert!(
            explore_tools.get("task").is_none(),
            "Read-only agent must NOT have task tool"
        );

        // Depth 1 -> Grandchild (Depth 2) should have 'task' tool
        let child_task_tool = child_tools.get("task").unwrap();
        let child_task_downcast = child_task_tool
            .as_any()
            .and_then(|a| a.downcast_ref::<TaskTool>())
            .unwrap();
        assert_eq!(child_task_downcast.current_depth, 1);
        let grandchild_tools = child_task_downcast.registry_for(&general_agent, &approver, &events);
        assert!(
            grandchild_tools.get("task").is_some(),
            "Depth 2 must have task tool"
        );

        // Depth 2 -> Great-grandchild (Depth 3 == max_depth) must NOT have 'task' tool
        let grandchild_task_tool = grandchild_tools.get("task").unwrap();
        let grandchild_task_downcast = grandchild_task_tool
            .as_any()
            .and_then(|a| a.downcast_ref::<TaskTool>())
            .unwrap();
        assert_eq!(grandchild_task_downcast.current_depth, 2);
        let great_grandchild_tools =
            grandchild_task_downcast.registry_for(&general_agent, &approver, &events);
        assert!(
            great_grandchild_tools.get("task").is_none(),
            "Depth 3 reached max_depth, must NOT have task tool"
        );
    }
}
