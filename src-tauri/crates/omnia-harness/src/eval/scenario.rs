//! Scenario file format (JSON). One file per scenario in `evals/`.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use crate::agent::AgentConfig;
use crate::hooks::HookMatcher;
use crate::permission::{PermissionMode, PermissionRule};

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Skip (counted as passed, shown as SKIP) when a requirement is unmet.
    #[serde(default)]
    pub requires: Vec<Requirement>,
    #[serde(default)]
    pub workspace: Workspace,
    #[serde(default)]
    pub permission_mode: PermissionMode,
    #[serde(default)]
    pub rules: Vec<PermissionRule>,
    /// Which tools the agent gets.
    #[serde(default)]
    pub tools: ToolSet,
    /// Hook configuration (event name -> matchers), same shape as the
    /// `hooks` object of `.omnia/settings.json`.
    #[serde(default)]
    pub hooks: BTreeMap<String, Vec<HookMatcher>>,
    pub prompts: Vec<String>,
    #[serde(default)]
    pub config: ConfigOverrides,
    #[serde(default)]
    pub approval: ApprovalSpec,
    /// The scripted model. See [`ScriptTurn`].
    pub script: Vec<ScriptTurn>,
    /// Restore the checkpoint of this prompt (0-based) after the run, then
    /// check `after_restore`.
    #[serde(default)]
    pub restore_checkpoint: Option<usize>,
    /// Scripted turns are all expected to be served; set this when a scenario
    /// ends early on purpose (budget stop, branches that may not be taken).
    #[serde(default)]
    pub allow_unused_turns: bool,
    #[serde(default)]
    pub expect: Expect,
    #[serde(default)]
    pub after_restore: Vec<FileCheck>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Requirement {
    /// The platform default shell (PowerShell on Windows, bash elsewhere).
    DefaultShell,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    /// Relative path -> UTF-8 content.
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    /// Relative path -> paragraphs; written as a minimal real .docx.
    #[serde(default)]
    pub docx: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSet {
    /// Every built-in tool.
    #[default]
    Builtin,
    ReadOnly,
    /// Built-in tools plus memory tools.
    BuiltinMemory,
    /// Built-in tools plus the `task` subagent tool.
    BuiltinTask,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigOverrides {
    pub model: Option<String>,
    pub max_turns: Option<u32>,
    pub max_retries: Option<u32>,
    pub compact_threshold: Option<f32>,
    pub context_window: Option<u64>,
    pub fallback_models: Option<Vec<String>>,
    pub token_budget: Option<u64>,
    pub initial_tokens_used: Option<u64>,
}

impl ConfigOverrides {
    pub fn apply(&self, config: &mut AgentConfig) {
        if let Some(value) = &self.model {
            config.model = value.clone();
        }
        if let Some(value) = self.max_turns {
            config.max_turns = value;
        }
        if let Some(value) = self.max_retries {
            config.max_retries = value;
        }
        if let Some(value) = self.compact_threshold {
            config.compact_threshold = value;
        }
        if let Some(value) = self.context_window {
            config.context_window = Some(value);
        }
        if let Some(value) = &self.fallback_models {
            config.fallback_models = value.clone();
        }
        if let Some(value) = self.token_budget {
            config.token_budget = Some(value);
        }
        if let Some(value) = self.initial_tokens_used {
            config.initial_tokens_used = value;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Allow,
    Always,
    Deny,
}

/// How ask prompts are answered: `decisions` are consumed in order, then
/// `default` applies.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalSpec {
    #[serde(default)]
    pub decisions: Vec<Verdict>,
    #[serde(default = "default_verdict")]
    pub default: Verdict,
    #[serde(default)]
    pub feedback: Option<String>,
}

fn default_verdict() -> Verdict {
    Verdict::Allow
}

impl Default for ApprovalSpec {
    fn default() -> Self {
        Self {
            decisions: Vec::new(),
            default: Verdict::Allow,
            feedback: None,
        }
    }
}

// ---------------------------------------------------------------- script

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestKind {
    /// The session agent's turns (default).
    #[default]
    Main,
    /// Context-compaction summary requests.
    Compaction,
    /// Requests made by a `task` subagent.
    Subagent,
}

/// One scripted assistant turn. A request consumes the first unused turn whose
/// conditions match; unmatched requests fail the scenario.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptTurn {
    #[serde(default)]
    pub kind: RequestKind,
    /// Only match when the latest tool result in the request contains this.
    #[serde(default)]
    pub when_last_result_contains: Option<String>,
    /// Only match requests for this model id.
    #[serde(default)]
    pub when_model: Option<String>,
    /// How many requests this turn serves (default 1).
    #[serde(default)]
    pub times: Option<u32>,
    #[serde(default)]
    pub say: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<ScriptCall>,
    #[serde(default)]
    pub usage: Option<ScriptUsage>,
    /// Fail the request instead of answering.
    #[serde(default)]
    pub error: Option<ScriptError>,
    /// `max_tokens` etc.; defaults to tool_use / end_turn.
    #[serde(default)]
    pub stop: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptCall {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub input: Value,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptUsage {
    #[serde(default)]
    pub input: u64,
    #[serde(default)]
    pub output: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptError {
    pub status: u16,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
}

// ------------------------------------------------------------ assertions

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Expect {
    /// Substring expected in the run error (e.g. budget exceeded). When
    /// absent, every prompt must complete without error.
    #[serde(default)]
    pub run_error: Option<String>,
    /// Stop reason of the last completed run (`end_turn`, `turn_limit`, ...).
    #[serde(default)]
    pub stop: Option<String>,
    #[serde(default)]
    pub turns: Option<Range>,
    /// Input + output tokens reported by the model across the scenario.
    #[serde(default)]
    pub tokens: Option<Range>,
    #[serde(default)]
    pub final_text_contains: Vec<String>,
    #[serde(default)]
    pub files: Vec<FileCheck>,
    /// Names of tool calls the model proposed.
    #[serde(default)]
    pub proposed: Option<NameCheck>,
    /// Names of tools that actually started executing (subagents included).
    #[serde(default)]
    pub executed: Option<NameCheck>,
    /// Some tool result must match each of these.
    #[serde(default)]
    pub results: Vec<ResultCheck>,
    /// No tool result may match any of these.
    #[serde(default)]
    pub no_results: Vec<ResultCheck>,
    /// Event type (snake_case tag) -> allowed count.
    #[serde(default)]
    pub events: BTreeMap<String, Range>,
    /// Exact model ids requested by the session agent, in order.
    #[serde(default)]
    pub models_requested: Option<Vec<String>>,
    #[serde(default)]
    pub requests: Vec<RequestCheck>,
    /// Final transcript length in messages.
    #[serde(default)]
    pub history_len: Option<Range>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Range {
    pub eq: Option<u64>,
    pub min: Option<u64>,
    pub max: Option<u64>,
}

impl Range {
    pub fn check(&self, value: u64) -> bool {
        self.eq.is_none_or(|v| value == v)
            && self.min.is_none_or(|v| value >= v)
            && self.max.is_none_or(|v| value <= v)
    }

    pub fn describe(&self) -> String {
        let mut parts = Vec::new();
        if let Some(v) = self.eq {
            parts.push(format!("== {v}"));
        }
        if let Some(v) = self.min {
            parts.push(format!(">= {v}"));
        }
        if let Some(v) = self.max {
            parts.push(format!("<= {v}"));
        }
        parts.join(" and ")
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileCheck {
    pub path: String,
    #[serde(default)]
    pub exists: Option<bool>,
    #[serde(default)]
    pub equals: Option<String>,
    #[serde(default)]
    pub contains: Vec<String>,
    #[serde(default)]
    pub not_contains: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NameCheck {
    /// The whole list, exactly.
    #[serde(default)]
    pub exact: Option<Vec<String>>,
    /// These names appear in this relative order (other names may interleave).
    #[serde(default)]
    pub ordered: Vec<String>,
    #[serde(default)]
    pub includes: Vec<String>,
    #[serde(default)]
    pub excludes: Vec<String>,
    #[serde(default)]
    pub count: Option<Range>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResultCheck {
    /// Restrict to results of this tool.
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub is_error: Option<bool>,
    #[serde(default)]
    pub contains: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestCheck {
    /// Index among the session agent's requests; negative counts from the end.
    pub index: i64,
    #[serde(default)]
    pub system_contains: Vec<String>,
    #[serde(default)]
    pub system_not_contains: Vec<String>,
    /// Text of the whole message list sent in that request.
    #[serde(default)]
    pub messages_contain: Vec<String>,
}
