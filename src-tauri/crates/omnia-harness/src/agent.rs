//! The agent loop: stream a model turn, run the tools it asked for (with the
//! user's permission policy), feed results back, repeat until the model stops.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::future::join_all;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::compact;
use crate::hooks::{HookEvent, HookOutcome, HookRunner, PermissionOverride};
use crate::permission::{Decision, PermissionPolicy};
use crate::plan::{plan_text, PRESENT_PLAN_TOOL};
use crate::{
    Block, HarnessError, HarnessResult, Message, MessageAccumulator, Provider, ProviderRequest,
    Role, StopReason, StreamEvent, ToolContext, ToolOutput, ToolRegistry, Usage,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub model: String,
    pub system: Option<String>,
    pub max_turns: u32,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub reasoning_effort: Option<String>,
    /// Retries for retryable provider errors before any output streamed.
    pub max_retries: u32,
    /// Compact the transcript when the prompt reaches this fraction of the
    /// model's context window; 0 disables compaction.
    pub compact_threshold: f32,
    /// Overrides the context window guessed from the model id.
    pub context_window: Option<u64>,
    /// User-configured models (same provider profile) tried in order, for the
    /// rest of the run, when the current model keeps failing with an overload,
    /// rate-limit, server or model-unavailable error. Empty means never switch.
    #[serde(default)]
    pub fallback_models: Vec<String>,
    /// Optional cap on input + output tokens across the whole session.
    #[serde(default)]
    pub token_budget: Option<u64>,
    /// Input + output tokens already spent by earlier runs of the session.
    #[serde(default)]
    pub initial_tokens_used: u64,
    /// Grace period before abandoning a tool after cancellation.
    #[serde(default)]
    pub cancel_grace_period: Option<Duration>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            model: String::new(),
            system: None,
            max_turns: 200,
            max_tokens: Some(16_000),
            temperature: None,
            reasoning_effort: None,
            max_retries: 3,
            compact_threshold: 0.8,
            context_window: None,
            fallback_models: Vec::new(),
            token_budget: None,
            initial_tokens_used: 0,
            cancel_grace_period: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub tool_use_id: String,
    pub tool: String,
    pub input: Value,
    pub summary: String,
    /// 1-based position in this turn's approval queue and its length.
    pub ordinal: usize,
    pub total: usize,
    /// The approvals still queued behind this one in the same turn, in the
    /// order they will be asked, so the UI can offer a batch decision.
    #[serde(default)]
    pub remaining: Vec<ApprovalPreview>,
}

/// A queued approval the user has not been asked about yet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApprovalPreview {
    pub tool_use_id: String,
    pub tool: String,
    pub input: Value,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ApprovalDecision {
    AllowOnce,
    /// Allow and add a session rule for calls like this one.
    AllowAlways,
    /// Run with edited input instead.
    AllowEdited {
        input: Value,
    },
    Deny {
        #[serde(default)]
        feedback: Option<String>,
    },
}

#[async_trait]
pub trait Approver: Send + Sync {
    async fn request(&self, request: ApprovalRequest) -> ApprovalDecision;
}

/// Approves everything; for headless runs in `Full` mode and tests.
pub struct AutoApprove;

#[async_trait]
impl Approver for AutoApprove {
    async fn request(&self, _request: ApprovalRequest) -> ApprovalDecision {
        ApprovalDecision::AllowOnce
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    TurnStarted {
        turn: u32,
    },
    Stream {
        event: StreamEvent,
    },
    AssistantMessage {
        message: Message,
    },
    ToolProposed {
        id: String,
        name: String,
        input: Value,
        summary: String,
    },
    ApprovalRequested {
        request: ApprovalRequest,
    },
    ApprovalDecided {
        id: String,
        decision: ApprovalDecision,
    },
    /// A Plan-mode run ended its turn with `present_plan`.
    PlanPresented {
        id: String,
        plan: String,
    },
    ToolStarted {
        id: String,
    },
    ToolProgress {
        id: String,
        chunk: String,
    },
    ToolCompleted {
        id: String,
        output: ToolOutput,
    },
    Compacted {
        before: usize,
        after: usize,
    },
    HookMessage {
        event: String,
        message: String,
    },
    SteerInjected {
        text: String,
    },
    Retrying {
        attempt: u32,
        delay_ms: u64,
        message: String,
    },
    /// The configured model kept failing, so the run moved to the next
    /// user-configured fallback model. Never emitted silently.
    ModelFallback {
        from: String,
        to: String,
        reason: String,
    },
    /// Session token usage crossed 80% of the user's budget.
    BudgetWarning {
        used: u64,
        budget: u64,
    },
    TurnCompleted {
        turn: u32,
        usage: Usage,
        stop: StopReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ttft_ms: Option<u64>,
    },
    RunCompleted {
        usage: Usage,
        stop: StopReason,
        turns: u32,
    },
    Error {
        message: String,
    },
    /// The `artifact` tool created, updated or deleted an artifact (`action`).
    Artifact {
        id: String,
        version: u32,
        title: String,
        kind: String,
        action: String,
    },
    /// An event from a subagent started by the `task` tool call `parent_id`.
    Subagent {
        parent_id: String,
        event: Box<AgentEvent>,
    },
}

pub trait EventSink: Send + Sync {
    fn emit(&self, event: AgentEvent);
}

impl<F: Fn(AgentEvent) + Send + Sync> EventSink for F {
    fn emit(&self, event: AgentEvent) {
        self(event)
    }
}

/// Messages the user typed while the agent was running; injected at the next
/// safe point (after tool results) instead of waiting for the run to end.
#[derive(Clone, Default)]
pub struct SteerQueue(Arc<std::sync::Mutex<VecDeque<String>>>);

impl SteerQueue {
    pub fn push(&self, text: impl Into<String>) {
        if let Ok(mut queue) = self.0.lock() {
            queue.push_back(text.into());
        }
    }

    pub fn drain(&self) -> Vec<String> {
        self.0
            .lock()
            .map(|mut queue| queue.drain(..).collect())
            .unwrap_or_default()
    }
}

/// Appends a user turn. If the transcript ends with tool calls that never got
/// results (the previous run was interrupted mid-batch), synthetic error
/// results are prepended so every provider accepts the history.
fn advance_checkpoint(ctx: &ToolContext, index: usize) -> HarnessResult<()> {
    if let Some(scope) = &ctx.checkpoint {
        scope
            .advance(index)
            .map_err(|error| HarnessError::tool("checkpoint", error))?;
    }
    Ok(())
}

pub fn push_user(history: &mut Vec<Message>, content: Vec<Block>) {
    let mut blocks = Vec::new();
    if let Some(last) = history
        .last()
        .filter(|message| message.role == Role::Assistant)
    {
        for (id, _, _) in last.tool_uses() {
            blocks.push(Block::ToolResult {
                tool_use_id: id.to_owned(),
                content: vec![Block::text("Interrupted by the user before this tool ran.")],
                is_error: true,
            });
        }
    }
    blocks.extend(content);
    match history.last_mut() {
        // Merge into a trailing user turn (e.g. tool results) to keep roles alternating.
        Some(last) if last.role == Role::User => last.content.extend(blocks),
        _ => history.push(Message {
            role: Role::User,
            content: blocks,
        }),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunOutcome {
    pub usage: Usage,
    pub stop: StopReason,
    pub turns: u32,
}

pub struct Agent {
    pub provider: Arc<dyn Provider>,
    pub tools: ToolRegistry,
    pub policy: Arc<Mutex<PermissionPolicy>>,
    pub approver: Arc<dyn Approver>,
    pub events: Arc<dyn EventSink>,
    pub steer: SteerQueue,
    pub config: AgentConfig,
    /// User-configured lifecycle hooks (PreToolUse, PostToolUse, Stop).
    pub hooks: Option<Arc<HookRunner>>,
}

/// Consecutive times a Stop hook may send the agent back to work.
const MAX_STOP_HOOK_CONTINUES: u32 = 3;
const COMPACT_KEEP_RECENT: usize = 6;
/// How long a tool may keep running after cancellation before it is abandoned.
const TOOL_CANCEL_GRACE: Duration = Duration::from_secs(2);

/// The model in use for a run plus the not-yet-used fallbacks. A switch
/// sticks for the remainder of the run.
struct ModelSelector {
    current: String,
    remaining: VecDeque<String>,
}

impl ModelSelector {
    fn new(config: &AgentConfig) -> Self {
        Self {
            current: config.model.clone(),
            remaining: config
                .fallback_models
                .iter()
                .map(|model| model.trim())
                .filter(|model| !model.is_empty() && *model != config.model)
                .map(str::to_owned)
                .collect(),
        }
    }

    fn next_fallback(&mut self) -> Option<String> {
        let next = self.remaining.pop_front()?;
        self.current = next.clone();
        Some(next)
    }
}

/// Overload, rate-limit, server and model-unavailable errors: a different
/// model may succeed where retrying the same one did not.
fn is_fallback_error(error: &HarnessError) -> bool {
    let HarnessError::Provider {
        status,
        message,
        retryable,
    } = error
    else {
        return false;
    };
    match status {
        Some(429 | 529 | 404) => true,
        Some(code) if (500..600).contains(code) => true,
        Some(400 | 403) => {
            let lower = message.to_ascii_lowercase();
            lower.contains("model")
                && [
                    "not found",
                    "not exist",
                    "unsupported",
                    "not supported",
                    "unavailable",
                    "access",
                ]
                .iter()
                .any(|needle| lower.contains(needle))
        }
        _ => *retryable,
    }
}

struct PlannedCall {
    id: String,
    name: String,
    input: Value,
    verdict: Result<(), String>,
    /// The user edited `input` while approving it.
    edited: bool,
}

impl Agent {
    fn admit_budget(&self, ctx: &ToolContext) -> HarnessResult<()> {
        if let Some(ledger) = &ctx.token_budget {
            ledger.admit()?;
        }
        Ok(())
    }

    fn observe_usage(&self, ctx: &ToolContext, usage: &Usage) {
        if let Some(ledger) = &ctx.token_budget {
            if let Some(warning) = ledger.record(usage) {
                self.events.emit(AgentEvent::BudgetWarning {
                    used: warning.used,
                    budget: warning.budget,
                });
            }
        }
        self.events.emit(AgentEvent::Stream {
            event: StreamEvent::Usage { usage: *usage },
        });
    }

    /// Runs until the model ends its turn without tool calls, the turn limit is
    /// hit, or `ctx.cancel` fires. `history` is extended in place, so the caller
    /// keeps a consistent transcript even when the run is interrupted.
    pub async fn run(
        &self,
        history: &mut Vec<Message>,
        ctx: &ToolContext,
    ) -> HarnessResult<RunOutcome> {
        // A root run creates one ledger. Child runs inherit the handle through
        // their cloned ToolContext, so prior usage and live sibling spend are
        // admitted against the same request-boundary budget.
        let mut run_ctx = ctx.clone();
        if run_ctx.token_budget.is_none() {
            if let Some(budget) = self.config.token_budget {
                run_ctx.token_budget = Some(crate::TokenBudgetLedger::new(
                    Some(budget),
                    self.config.initial_tokens_used,
                ));
            }
        }
        self.admit_budget(&run_ctx)?;
        let mut total = Usage::default();
        let mut turn = 0;
        let mut last_stop = StopReason::Other;
        let mut last_prompt_tokens: Option<u64> = None;
        let mut stop_continues = 0;
        let mut finished = false;
        let mut notes: Vec<tokio::task::JoinHandle<()>> = Vec::new();
        let mut models = ModelSelector::new(&self.config);
        while turn < self.config.max_turns {
            if run_ctx.cancel.is_cancelled() {
                return Err(HarnessError::Cancelled);
            }
            self.admit_budget(&run_ctx)?;
            tokio::select! {
                biased;
                _ = run_ctx.cancel.cancelled() => return Err(HarnessError::Cancelled),
                result = self.maybe_compact(history, last_prompt_tokens, &models.current, &run_ctx) => result?
            }
            // Compaction can await a provider while a sibling spends from the
            // same ledger. Recheck immediately before admitting this request.
            self.admit_budget(&run_ctx)?;
            turn += 1;
            self.events.emit(AgentEvent::TurnStarted { turn });
            let (message, usage, stop, duration_ms, ttft_ms) =
                self.stream_turn(history, &run_ctx, &mut models).await?;
            last_prompt_tokens = Some(
                usage
                    .input_tokens
                    .saturating_add(usage.cache_read_tokens)
                    .saturating_add(usage.cache_write_tokens),
            );
            total.add(&usage);
            last_stop = stop;
            let calls: Vec<(String, String, Value)> = message
                .tool_uses()
                .map(|(id, name, input)| (id.to_owned(), name.to_owned(), input.clone()))
                .collect();
            self.events.emit(AgentEvent::AssistantMessage {
                message: message.clone(),
            });
            history.push(message);
            self.events.emit(AgentEvent::TurnCompleted {
                turn,
                usage,
                stop,
                duration_ms,
                ttft_ms,
            });

            if calls.is_empty() {
                // A steer message arriving at the very end still deserves an answer.
                let steer = self.steer.drain();
                if !steer.is_empty() {
                    let boundary = history.len();
                    history.push(self.steer_message(steer, Vec::new()));
                    advance_checkpoint(&run_ctx, boundary)?;
                    continue;
                }
                if stop_continues < MAX_STOP_HOOK_CONTINUES {
                    if let Some(reason) = self.stop_hook(&run_ctx, stop_continues > 0).await {
                        stop_continues += 1;
                        let boundary = history.len();
                        history.push(Message {
                            role: Role::User,
                            content: vec![Block::text(format!("Stop hook feedback: {reason}"))],
                        });
                        advance_checkpoint(&run_ctx, boundary)?;
                        continue;
                    }
                }
                finished = true;
                break;
            }
            stop_continues = 0;
            let plan_calls: Vec<(String, String)> = calls
                .iter()
                .filter(|(_, name, _)| name == PRESENT_PLAN_TOOL)
                .filter_map(|(id, _, input)| {
                    plan_text(input).map(|plan| (id.clone(), plan.to_owned()))
                })
                .collect();
            let results = self.execute_calls(calls, &run_ctx, &mut notes).await?;
            // A presented plan ends the turn: the user answers it before anything else runs.
            let presented = plan_calls.into_iter().find(|(id, _)| {
                results.iter().any(|block| {
                    matches!(block, Block::ToolResult { tool_use_id, is_error: false, .. } if tool_use_id == id)
                })
            });
            let steer = self.steer.drain();
            let needs_boundary = !steer.is_empty();
            let boundary = history.len();
            // Preserve executed results and drained instructions even when the
            // durable boundary cannot be saved. Return before another request
            // or tool dispatch can use the previous checkpoint cursor.
            history.push(self.steer_message(steer, results));
            if needs_boundary {
                advance_checkpoint(&run_ctx, boundary)?;
            }
            // Keep terminal tool results in the transcript before returning an
            // interrupt, including when this was the last permitted turn.
            if run_ctx.cancel.is_cancelled() {
                return Err(HarnessError::Cancelled);
            }
            if let Some((id, plan)) = presented {
                self.events.emit(AgentEvent::PlanPresented {
                    id,
                    plan: plan.clone(),
                });
                self.notify(
                    &run_ctx,
                    &mut notes,
                    "plan_ready",
                    "Omnia finished a plan and is waiting for your approval".to_owned(),
                    json!({ "plan": plan }),
                );
                finished = true;
                break;
            }
        }
        if !finished {
            last_stop = StopReason::TurnLimit;
        }
        for note in notes {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), note).await;
        }
        // Cancellation may arrive after the final model/tool turn or while
        // notification hooks are being awaited. It must not become completion.
        if run_ctx.cancel.is_cancelled() {
            return Err(HarnessError::Cancelled);
        }
        self.events.emit(AgentEvent::RunCompleted {
            usage: total,
            stop: last_stop,
            turns: turn,
        });
        Ok(RunOutcome {
            usage: total,
            stop: last_stop,
            turns: turn,
        })
    }

    /// Summarizes older history once the prompt nears the context window.
    /// Ordinary failures are reported and ignored; cancellation and budget
    /// admission failures stop the run.
    async fn maybe_compact(
        &self,
        history: &mut Vec<Message>,
        last_prompt_tokens: Option<u64>,
        model: &str,
        ctx: &ToolContext,
    ) -> HarnessResult<()> {
        if self.config.compact_threshold <= 0.0 {
            return Ok(());
        }
        let window = self
            .config
            .context_window
            .unwrap_or_else(|| compact::context_window_for(model));
        let used = last_prompt_tokens.unwrap_or_else(|| compact::estimate_tokens(history) as u64);
        if !compact::should_compact(used, window, self.config.compact_threshold) {
            return Ok(());
        }
        let before = history.len();
        match compact::compact_observed(
            self.provider.as_ref(),
            model,
            history,
            COMPACT_KEEP_RECENT,
            || self.admit_budget(ctx),
            |usage| self.observe_usage(ctx, usage),
        )
        .await
        {
            Ok(compacted) if compacted.messages.len() < before => {
                if ctx.cancel.is_cancelled() {
                    return Err(HarnessError::Cancelled);
                }
                if let Some(scope) = &ctx.checkpoint {
                    if let Err(error) = scope.compact(compacted.split, &compacted.messages) {
                        self.events.emit(AgentEvent::Error {
                            message: format!("Context compaction checkpoint save failed: {error}"),
                        });
                        return Ok(());
                    }
                }
                *history = compacted.messages;
                self.events.emit(AgentEvent::Compacted {
                    before,
                    after: history.len(),
                });
            }
            Ok(_) => {}
            Err(error @ (HarnessError::BudgetExceeded { .. } | HarnessError::Cancelled)) => {
                return Err(error)
            }
            Err(error) => self.events.emit(AgentEvent::Error {
                message: format!("Context compaction failed: {error}"),
            }),
        }
        Ok(())
    }

    async fn stop_hook(&self, ctx: &ToolContext, active: bool) -> Option<String> {
        let hooks = self.hooks.as_ref()?;
        let outcome = hooks
            .run(
                HookEvent::Stop,
                json!({ "stop_hook_active": active }),
                &ctx.cwd,
                &ctx.cancel,
            )
            .await;
        self.report_hook_messages(HookEvent::Stop, &outcome);
        outcome.block
    }

    fn report_hook_messages(&self, event: HookEvent, outcome: &HookOutcome) {
        for message in &outcome.messages {
            self.events.emit(AgentEvent::HookMessage {
                event: event.as_str().to_owned(),
                message: message.clone(),
            });
        }
    }

    fn steer_message(&self, steer: Vec<String>, mut content: Vec<Block>) -> Message {
        for text in steer {
            self.events
                .emit(AgentEvent::SteerInjected { text: text.clone() });
            content.push(Block::text(text));
        }
        Message {
            role: Role::User,
            content,
        }
    }

    async fn stream_turn(
        &self,
        history: &[Message],
        ctx: &ToolContext,
        models: &mut ModelSelector,
    ) -> HarnessResult<(Message, Usage, StopReason, Option<u64>, Option<u64>)> {
        let mut request = ProviderRequest {
            model: models.current.clone(),
            system: self.config.system.clone(),
            messages: history.to_vec(),
            tools: self.tools.specs(),
            max_tokens: self.config.max_tokens,
            temperature: self.config.temperature,
            reasoning_effort: self.config.reasoning_effort.clone(),
        };
        let mut attempt = 0;
        loop {
            // A retry or fallback is a fresh provider request. Siblings may
            // have charged the shared ledger while this agent was awaiting a
            // retry delay, so admit every attempt independently.
            self.admit_budget(ctx)?;
            match self.try_stream(request.clone(), ctx).await {
                Ok(result) => return Ok(result),
                Err((error, streamed_any)) => {
                    let retryable = matches!(
                        error,
                        HarnessError::Provider {
                            retryable: true,
                            ..
                        }
                    );
                    if !retryable || streamed_any || attempt >= self.config.max_retries {
                        // Retries are spent (or pointless): move to the next
                        // user-configured model, loudly, if the error class allows.
                        if !streamed_any && is_fallback_error(&error) {
                            if let Some(next) = models.next_fallback() {
                                self.events.emit(AgentEvent::ModelFallback {
                                    from: request.model.clone(),
                                    to: next.clone(),
                                    reason: error.to_string(),
                                });
                                request.model = next;
                                attempt = 0;
                                continue;
                            }
                        }
                        self.events.emit(AgentEvent::Error {
                            message: error.to_string(),
                        });
                        return Err(error);
                    }
                    attempt += 1;
                    let delay_ms = 1_000u64 << (attempt - 1).min(5);
                    self.events.emit(AgentEvent::Retrying {
                        attempt,
                        delay_ms,
                        message: error.to_string(),
                    });
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
                        _ = ctx.cancel.cancelled() => return Err(HarnessError::Cancelled),
                    }
                }
            }
        }
    }

    async fn try_stream(
        &self,
        request: ProviderRequest,
        ctx: &ToolContext,
    ) -> Result<(Message, Usage, StopReason, Option<u64>, Option<u64>), (HarnessError, bool)> {
        let start = std::time::Instant::now();
        let mut ttft_ms: Option<u64> = None;
        let mut stream = tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => return Err((HarnessError::Cancelled, false)),
            stream = self.provider.stream(request) => stream.map_err(|error| (error, false))?,
        };
        let mut accumulator = MessageAccumulator::default();
        let mut streamed_any = false;
        loop {
            let next = tokio::select! {
                next = stream.next() => next,
                _ = ctx.cancel.cancelled() => return Err((HarnessError::Cancelled, streamed_any)),
            };
            let Some(event) = next else { break };
            let event = event.map_err(|error| (error, streamed_any))?;
            streamed_any = true;
            if ttft_ms.is_none()
                && matches!(
                    event,
                    StreamEvent::TextDelta { .. } | StreamEvent::ThinkingDelta { .. }
                )
            {
                ttft_ms = Some(start.elapsed().as_millis() as u64);
            }
            accumulator.push(&event).map_err(|error| (error, true))?;
            if let StreamEvent::Usage { usage } = &event {
                self.observe_usage(ctx, usage);
            } else {
                self.events.emit(AgentEvent::Stream { event });
            }
        }
        let duration_ms = Some(start.elapsed().as_millis() as u64);
        let (message, usage, stop) = accumulator.finish();
        Ok((message, usage, stop, duration_ms, ttft_ms))
    }

    async fn execute_calls(
        &self,
        calls: Vec<(String, String, Value)>,
        ctx: &ToolContext,
        notes: &mut Vec<tokio::task::JoinHandle<()>>,
    ) -> HarnessResult<Vec<Block>> {
        // 1. Decide every call first so approvals form one ordered queue.
        let mut planned = Vec::with_capacity(calls.len());
        let mut pending_asks = Vec::new();
        for (id, name, input) in calls {
            let verdict = match self.tools.get(&name) {
                None => Err(format!("Unknown tool `{name}`")),
                Some(tool) => {
                    let summary = tool.describe(&input);
                    self.events.emit(AgentEvent::ToolProposed {
                        id: id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                        summary,
                    });
                    let mut decision =
                        self.policy
                            .lock()
                            .await
                            .evaluate(&name, tool.effect(), &input);
                    if !matches!(decision, Decision::Deny(_)) {
                        decision = self
                            .pre_tool_hook(&name, &input, ctx)
                            .await
                            .unwrap_or(decision);
                    }
                    match decision {
                        Decision::Allow => Ok(()),
                        Decision::Deny(reason) => Err(reason),
                        Decision::Ask => {
                            pending_asks.push(planned.len());
                            Ok(())
                        }
                    }
                }
            };
            planned.push(PlannedCall {
                id,
                name,
                input,
                verdict,
                edited: false,
            });
        }
        let total = pending_asks.len();
        let previews: Vec<ApprovalPreview> = pending_asks
            .iter()
            .map(|slot| {
                let call = &planned[*slot];
                ApprovalPreview {
                    tool_use_id: call.id.clone(),
                    tool: call.name.clone(),
                    input: call.input.clone(),
                    summary: self.describe_call(&call.name, &call.input),
                }
            })
            .collect();
        for (index, slot) in pending_asks.into_iter().enumerate() {
            if ctx.cancel.is_cancelled() {
                return Err(HarnessError::Cancelled);
            }
            let call = &mut planned[slot];
            let request = ApprovalRequest {
                tool_use_id: call.id.clone(),
                tool: call.name.clone(),
                input: call.input.clone(),
                summary: previews[index].summary.clone(),
                ordinal: index + 1,
                total,
                remaining: previews[index + 1..].to_vec(),
            };
            self.notify(
                ctx,
                notes,
                "approval_requested",
                format!("Omnia is waiting for your approval: {}", request.summary),
                json!({
                    "tool_name": request.tool,
                    "tool_input": request.input,
                    "summary": request.summary,
                    "ordinal": request.ordinal,
                    "total": request.total,
                }),
            );
            self.events.emit(AgentEvent::ApprovalRequested {
                request: request.clone(),
            });
            let decision = tokio::select! {
                decision = self.approver.request(request) => decision,
                _ = ctx.cancel.cancelled() => return Err(HarnessError::Cancelled),
            };
            self.events.emit(AgentEvent::ApprovalDecided {
                id: call.id.clone(),
                decision: decision.clone(),
            });
            match decision {
                ApprovalDecision::AllowOnce => {}
                ApprovalDecision::AllowAlways => {
                    self.policy.lock().await.allow_like(&call.name, &call.input);
                }
                ApprovalDecision::AllowEdited { input } => {
                    call.input = input;
                    call.edited = true;
                    // The approval applied to the proposed arguments, not a bypass
                    // of deny rules or PreToolUse checks for the replacement.
                    if let Some(tool) = self.tools.get(&call.name) {
                        let mut decision = self.policy.lock().await.evaluate(
                            &call.name,
                            tool.effect(),
                            &call.input,
                        );
                        if !matches!(decision, Decision::Deny(_)) {
                            decision = self
                                .pre_tool_hook(&call.name, &call.input, ctx)
                                .await
                                .unwrap_or(decision);
                        }
                        if let Decision::Deny(reason) = decision {
                            call.verdict = Err(reason);
                        }
                    }
                }
                ApprovalDecision::Deny { feedback } => {
                    call.verdict = Err(match feedback {
                        Some(feedback) if !feedback.trim().is_empty() => {
                            format!("The user declined this action and said: {feedback}")
                        }
                        _ => "The user declined this action.".to_owned(),
                    });
                }
            }
        }

        // 2. Execute: consecutive read-only calls run in parallel, the rest in order.
        let mut outputs: Vec<Option<ToolOutput>> = vec![None; planned.len()];
        let mut index = 0;
        while index < planned.len() {
            if ctx.cancel.is_cancelled() {
                return Err(HarnessError::Cancelled);
            }
            let read_only = |call: &PlannedCall| {
                call.verdict.is_ok()
                    && self
                        .tools
                        .get(&call.name)
                        .is_some_and(|tool| tool.effect().is_read_only())
            };
            if read_only(&planned[index]) {
                let start = index;
                while index < planned.len() && read_only(&planned[index]) {
                    index += 1;
                }
                let batch = join_all(
                    planned[start..index]
                        .iter()
                        .map(|call| self.run_one(call, ctx)),
                )
                .await;
                for (offset, output) in batch.into_iter().enumerate() {
                    outputs[start + offset] = Some(output);
                }
            } else {
                outputs[index] = Some(self.run_one(&planned[index], ctx).await);
                index += 1;
            }
        }

        Ok(planned
            .into_iter()
            .zip(outputs)
            .map(|(call, output)| {
                let mut output = output.unwrap_or_else(|| ToolOutput::error("Tool did not run"));
                if call.edited && call.verdict.is_ok() {
                    // The model asked for different arguments than the ones that ran.
                    output.content.insert(
                        0,
                        Block::text(format!(
                            "(The user edited this call's arguments before approving it. It ran with: {})",
                            call.input
                        )),
                    );
                }
                Block::ToolResult {
                    tool_use_id: call.id,
                    content: output.content,
                    is_error: output.is_error,
                }
            })
            .collect())
    }

    fn describe_call(&self, name: &str, input: &Value) -> String {
        self.tools
            .get(name)
            .map(|tool| tool.describe(input))
            .unwrap_or_default()
    }

    /// Fires `Notification` hooks without making the run wait for them; the
    /// handles are awaited (briefly) when the run ends.
    fn notify(
        &self,
        ctx: &ToolContext,
        notes: &mut Vec<tokio::task::JoinHandle<()>>,
        kind: &str,
        message: String,
        extra: Value,
    ) {
        if let Some(hooks) = &self.hooks {
            notes.push(crate::hooks::fire_notification(
                Arc::clone(hooks),
                kind,
                message,
                extra,
                ctx.cwd.clone(),
                ctx.cancel.clone(),
            ));
        }
    }

    /// A PreToolUse hook may block a call or settle its permission; the
    /// user's own deny rules are applied before and always win.
    async fn pre_tool_hook(
        &self,
        name: &str,
        input: &Value,
        ctx: &ToolContext,
    ) -> Option<Decision> {
        let hooks = self.hooks.as_ref()?;
        let outcome = hooks
            .run(
                HookEvent::PreToolUse,
                json!({ "tool_name": name, "tool_input": input }),
                &ctx.cwd,
                &ctx.cancel,
            )
            .await;
        self.report_hook_messages(HookEvent::PreToolUse, &outcome);
        if let Some(reason) = outcome.block {
            return Some(Decision::Deny(format!(
                "Blocked by a PreToolUse hook: {reason}"
            )));
        }
        // Hooks may tighten the native permission decision, never grant trust
        // or suppress a user approval required by policy.
        match outcome.permission {
            Some((PermissionOverride::Allow, _)) | None => None,
            Some((PermissionOverride::Ask, _)) => Some(Decision::Ask),
            Some((PermissionOverride::Deny, reason)) => Some(Decision::Deny(format!(
                "Denied by a PreToolUse hook{}",
                reason
                    .map(|reason| format!(": {reason}"))
                    .unwrap_or_default()
            ))),
        }
    }

    async fn post_tool_hook(&self, call: &PlannedCall, output: &mut ToolOutput, ctx: &ToolContext) {
        let Some(hooks) = self.hooks.as_ref() else {
            return;
        };
        let response: String = output
            .content
            .iter()
            .filter_map(|block| match block {
                Block::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        let outcome = hooks
            .run(
                HookEvent::PostToolUse,
                json!({
                    "tool_name": call.name,
                    "tool_input": call.input,
                    "tool_response": { "output": response, "is_error": output.is_error },
                }),
                &ctx.cwd,
                &ctx.cancel,
            )
            .await;
        self.report_hook_messages(HookEvent::PostToolUse, &outcome);
        if let Some(reason) = outcome.block {
            output
                .content
                .push(Block::text(format!("PostToolUse hook feedback: {reason}")));
        }
        for context in outcome.additional_context {
            output.content.push(Block::text(context));
        }
    }

    async fn run_one(&self, call: &PlannedCall, ctx: &ToolContext) -> ToolOutput {
        let output = match (&call.verdict, self.tools.get(&call.name)) {
            (Err(reason), _) => ToolOutput::error(reason.clone()),
            (Ok(()), None) => ToolOutput::error(format!("Unknown tool `{}`", call.name)),
            (Ok(()), Some(tool)) => {
                self.events.emit(AgentEvent::ToolStarted {
                    id: call.id.clone(),
                });
                let mut tool_ctx = ctx.clone();
                tool_ctx.tool_use_id = call.id.clone();
                let checkpoint_error = if tool.effect() == crate::EffectClass::ExecuteProcess {
                    tool_ctx.checkpoint_note_untracked().err()
                } else {
                    None
                };
                if let Some(error) = checkpoint_error {
                    ToolOutput::error(format!(
                        "Cannot record untracked command before execution: {error}"
                    ))
                } else {
                    let events = Arc::clone(&self.events);
                    let id = call.id.clone();
                    tool_ctx.progress = Some(Arc::new(move |chunk: String| {
                        events.emit(AgentEvent::ToolProgress {
                            id: id.clone(),
                            chunk,
                        })
                    }));
                    let mut pending = tool.call(&tool_ctx, call.input.clone());
                    let grace = self.config.cancel_grace_period.unwrap_or(TOOL_CANCEL_GRACE);
                    let finished = tokio::select! {
                        result = &mut pending => Some(result),
                        // Cooperative tools get a moment to clean up (kill process
                        // trees, ...) and report; one that ignores `ctx.cancel` is
                        // abandoned so it cannot hold the run open.
                        _ = ctx.cancel.cancelled() => {
                            tokio::time::timeout(grace, &mut pending).await.ok()
                        }
                    };
                    drop(pending);
                    match finished {
                        Some(result) => {
                            let mut output = match result {
                                Ok(output) => output,
                                Err(error) => ToolOutput::error(error.to_string()),
                            };
                            self.post_tool_hook(call, &mut output, ctx).await;
                            output
                        }
                        None => ToolOutput::error(HarnessError::Cancelled.to_string()),
                    }
                }
            }
        };
        self.events.emit(AgentEvent::ToolCompleted {
            id: call.id.clone(),
            output: output.clone(),
        });
        if call.name == "artifact" {
            if let Some(event) = crate::tools::artifact::event_from_output(&output) {
                self.events.emit(event);
            }
        }
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::PermissionMode;
    use crate::{EffectClass, ProviderStream, Tool, ToolSpec};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Replays scripted turns; records how many requests it received.
    struct ScriptedProvider {
        turns: std::sync::Mutex<VecDeque<Vec<StreamEvent>>>,
        calls: AtomicUsize,
    }

    impl ScriptedProvider {
        fn new(turns: Vec<Vec<StreamEvent>>) -> Arc<Self> {
            Arc::new(Self {
                turns: std::sync::Mutex::new(turns.into()),
                calls: AtomicUsize::new(0),
            })
        }
    }

    #[async_trait]
    impl Provider for ScriptedProvider {
        fn id(&self) -> &str {
            "scripted"
        }

        async fn stream(&self, _request: ProviderRequest) -> HarnessResult<ProviderStream> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let events = self.turns.lock().unwrap().pop_front().unwrap_or_default();
            Ok(Box::pin(futures_util::stream::iter(
                events.into_iter().map(Ok),
            )))
        }
    }

    struct EchoTool {
        name: &'static str,
        effect: EffectClass,
    }

    #[async_trait]
    impl Tool for EchoTool {
        fn spec(&self) -> ToolSpec {
            ToolSpec {
                name: self.name.to_owned(),
                description: "echo".to_owned(),
                input_schema: json!({"type": "object"}),
            }
        }

        fn effect(&self) -> EffectClass {
            self.effect
        }

        async fn call(&self, _ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
            Ok(ToolOutput::text(format!("{}:{}", self.name, input)))
        }
    }

    struct DenyAll;

    #[async_trait]
    impl Approver for DenyAll {
        async fn request(&self, _request: ApprovalRequest) -> ApprovalDecision {
            ApprovalDecision::Deny {
                feedback: Some("not now".to_owned()),
            }
        }
    }

    fn tool_turn(calls: &[(&str, &str, &str)]) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        for (id, name, json) in calls {
            events.push(StreamEvent::ToolUseStart {
                id: (*id).to_owned(),
                name: (*name).to_owned(),
            });
            events.push(StreamEvent::ToolInputDelta {
                id: (*id).to_owned(),
                partial_json: (*json).to_owned(),
            });
            events.push(StreamEvent::ToolUseEnd {
                id: (*id).to_owned(),
            });
        }
        events.push(StreamEvent::Stop {
            reason: StopReason::ToolUse,
        });
        events
    }

    fn text_turn(text: &str) -> Vec<StreamEvent> {
        vec![
            StreamEvent::TextDelta {
                text: text.to_owned(),
            },
            StreamEvent::Stop {
                reason: StopReason::EndTurn,
            },
        ]
    }

    type EventLog = Arc<std::sync::Mutex<Vec<AgentEvent>>>;

    fn agent(
        provider: Arc<ScriptedProvider>,
        mode: PermissionMode,
        approver: Arc<dyn Approver>,
    ) -> (Agent, EventLog) {
        let mut tools = ToolRegistry::default();
        tools.register(Arc::new(EchoTool {
            name: "read",
            effect: EffectClass::ReadWorkspace,
        }));
        tools.register(Arc::new(EchoTool {
            name: "write",
            effect: EffectClass::WriteWorkspace,
        }));
        let log: EventLog = Arc::default();
        let sink = Arc::clone(&log);
        let agent = Agent {
            provider,
            tools,
            policy: Arc::new(Mutex::new(PermissionPolicy::new(mode))),
            approver,
            events: Arc::new(move |event: AgentEvent| sink.lock().unwrap().push(event)),
            steer: SteerQueue::default(),
            config: AgentConfig {
                model: "test".to_owned(),
                ..AgentConfig::default()
            },
            hooks: None,
        };
        (agent, log)
    }

    fn results(message: &Message) -> Vec<(String, bool, String)> {
        message
            .content
            .iter()
            .filter_map(|block| match block {
                Block::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => Some((
                    tool_use_id.clone(),
                    *is_error,
                    match content.first() {
                        Some(Block::Text { text }) => text.clone(),
                        _ => String::new(),
                    },
                )),
                _ => None,
            })
            .collect()
    }

    fn user(text: &str) -> Message {
        Message {
            role: Role::User,
            content: vec![Block::text(text)],
        }
    }

    #[tokio::test]
    async fn runs_tools_in_order_and_finishes() {
        let provider = ScriptedProvider::new(vec![
            tool_turn(&[
                ("a", "read", r#"{"path":"x"}"#),
                ("b", "write", r#"{"path":"y"}"#),
                ("c", "nope", "{}"),
            ]),
            text_turn("done"),
        ]);
        let (agent, log) = agent(
            Arc::clone(&provider),
            PermissionMode::Full,
            Arc::new(AutoApprove),
        );
        let mut history = vec![user("go")];
        let outcome = agent
            .run(&mut history, &ToolContext::new("."))
            .await
            .unwrap();
        assert_eq!(outcome.turns, 2);
        assert_eq!(outcome.stop, StopReason::EndTurn);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
        assert_eq!(history.len(), 4);
        let results = results(&history[2]);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].0, "a");
        assert!(!results[0].1 && results[0].2.starts_with("read:"));
        assert!(!results[1].1 && results[1].2.starts_with("write:"));
        assert!(results[2].1 && results[2].2.contains("Unknown tool"));
        assert!(log
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, AgentEvent::RunCompleted { .. })));
    }

    #[tokio::test]
    async fn denied_approval_becomes_error_result_with_feedback() {
        let provider = ScriptedProvider::new(vec![
            tool_turn(&[("a", "read", "{}"), ("b", "write", "{}")]),
            text_turn("ok"),
        ]);
        let (agent, log) = agent(provider, PermissionMode::AskWrites, Arc::new(DenyAll));
        let mut history = vec![user("go")];
        agent
            .run(&mut history, &ToolContext::new("."))
            .await
            .unwrap();
        let results = results(&history[2]);
        assert!(!results[0].1, "reads run without asking");
        assert!(results[1].1 && results[1].2.contains("not now"));
        let asked = log
            .lock()
            .unwrap()
            .iter()
            .filter(|event| matches!(event, AgentEvent::ApprovalRequested { .. }))
            .count();
        assert_eq!(asked, 1);
    }

    #[tokio::test]
    async fn steer_messages_are_injected_after_tool_results() {
        let provider =
            ScriptedProvider::new(vec![tool_turn(&[("a", "read", "{}")]), text_turn("ok")]);
        let (agent, _log) = agent(provider, PermissionMode::Full, Arc::new(AutoApprove));
        agent.steer.push("also check tests");
        let mut history = vec![user("go")];
        agent
            .run(&mut history, &ToolContext::new("."))
            .await
            .unwrap();
        assert!(history[2]
            .content
            .iter()
            .any(|block| matches!(block, Block::Text { text } if text == "also check tests")));
    }

    #[tokio::test]
    async fn write_tools_checkpoint_files_and_rewind_restores_them() {
        let dir = tempfile::tempdir().unwrap();
        let existing = dir.path().join("keep.txt");
        std::fs::write(&existing, "before").unwrap();
        let created = dir.path().join("made.txt");
        let provider = ScriptedProvider::new(vec![
            tool_turn(&[
                (
                    "a",
                    "write_file",
                    r#"{"path":"keep.txt","content":"after"}"#,
                ),
                ("b", "write_file", r#"{"path":"made.txt","content":"new"}"#),
            ]),
            text_turn("done"),
        ]);
        let (mut agent, _log) = agent(provider, PermissionMode::Full, Arc::new(AutoApprove));
        agent.tools = crate::tools::builtin_registry();
        let store = Arc::new(crate::CheckpointStore::open(dir.path().join("cp")).unwrap());
        let mut ctx = ToolContext::new(dir.path());
        let mut history = vec![user("earlier"), user("reply"), user("go")];
        ctx.checkpoint = Some(crate::CheckpointScope::from_key(Arc::clone(&store), 2));
        agent.run(&mut history, &ctx).await.unwrap();
        assert_eq!(std::fs::read_to_string(&existing).unwrap(), "after");
        assert!(created.exists());

        let report = store.restore(2);
        assert_eq!(std::fs::read_to_string(&existing).unwrap(), "before");
        assert!(!created.exists());
        assert_eq!(report.restored.len(), 1);
        assert_eq!(report.deleted.len(), 1);
    }

    #[tokio::test]
    async fn steered_write_uses_new_durable_boundary_and_tool_results_do_not_advance_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("keep.txt");
        std::fs::write(&file, "before").unwrap();
        let provider = ScriptedProvider::new(vec![
            text_turn("first answer"),
            tool_turn(&[(
                "a",
                "write_file",
                r#"{"path":"keep.txt","content":"after"}"#,
            )]),
            text_turn("done"),
        ]);
        let (mut agent, _) = agent(provider, PermissionMode::Full, Arc::new(AutoApprove));
        agent.tools = crate::tools::builtin_registry();
        agent.steer.push("now change the file");
        let store = Arc::new(crate::CheckpointStore::open(dir.path().join("cp")).unwrap());
        let mut history = vec![user("go")];
        let scope = crate::CheckpointScope::begin(Arc::clone(&store), &history, 0).unwrap();
        let original = scope.key();
        let mut ctx = ToolContext::new(dir.path());
        ctx.checkpoint = Some(scope.clone());
        agent.run(&mut history, &ctx).await.unwrap();
        assert!(scope.key() > original);
        assert_eq!(
            store.checkpoint_ids(),
            vec![scope.key()],
            "result-only continuation retains the steer identity"
        );
        assert_eq!(crate::compact::rewind_boundary(&history, 2), 2);
        assert!(store.restore(2).failed.is_empty());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "before");
    }

    #[tokio::test]
    async fn stop_feedback_write_uses_its_own_checkpoint_boundary() {
        use crate::hooks::{HookCommand, HookConfig, HookMatcher};
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("keep.txt");
        std::fs::write(&file, "before").unwrap();
        let provider = ScriptedProvider::new(vec![
            text_turn("first answer"),
            tool_turn(&[(
                "a",
                "write_file",
                r#"{"path":"keep.txt","content":"after"}"#,
            )]),
            text_turn("done"),
        ]);
        let (mut agent, _) = agent(provider, PermissionMode::Full, Arc::new(AutoApprove));
        agent.tools = crate::tools::builtin_registry();
        agent.config.max_turns = 3;
        let mut config = HookConfig::default();
        config.hooks.insert(
            "Stop".into(),
            vec![HookMatcher {
                matcher: None,
                hooks: vec![HookCommand {
                    kind: "command".into(),
                    command: if cfg!(windows) {
                        "Write-Output '{\"decision\":\"block\",\"reason\":\"continue\"}'".into()
                    } else {
                        "printf '%s' '{\"decision\":\"block\",\"reason\":\"continue\"}'".into()
                    },
                    timeout: Some(15),
                    plugin_root: None,
                }],
            }],
        );
        agent.hooks = Some(Arc::new(HookRunner::new(config, "s1")));
        let store = Arc::new(crate::CheckpointStore::open(dir.path().join("cp")).unwrap());
        let mut history = vec![user("go")];
        let scope = crate::CheckpointScope::begin(Arc::clone(&store), &history, 0).unwrap();
        let mut ctx = ToolContext::new(dir.path());
        ctx.checkpoint = Some(scope);
        agent.run(&mut history, &ctx).await.unwrap();
        assert!(
            matches!(&history[2].content[..], [Block::Text { text }] if text.starts_with("Stop hook feedback:"))
        );
        assert!(!store.tracked_paths(2).is_empty());
        assert!(store.restore(2).failed.is_empty());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "before");
    }

    struct WriteThenSteerAndBlockCheckpoint {
        steer: SteerQueue,
        calls: Arc<AtomicUsize>,
    }
    #[async_trait]
    impl Tool for WriteThenSteerAndBlockCheckpoint {
        fn spec(&self) -> ToolSpec {
            ToolSpec {
                name: "write-steer-fixture".into(),
                description: "write then steer".into(),
                input_schema: json!({"type":"object"}),
            }
        }
        fn effect(&self) -> EffectClass {
            EffectClass::WriteWorkspace
        }
        async fn call(&self, ctx: &ToolContext, _: Value) -> HarnessResult<ToolOutput> {
            let file = ctx.cwd.join("effect.txt");
            ctx.checkpoint_before(&file)
                .map_err(|error| HarnessError::tool("fixture", error))?;
            std::fs::write(file, "real effect happened").unwrap();
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.steer.push("keep this mid-batch instruction");
            std::fs::create_dir(ctx.cwd.join("cp/manifest.tmp")).unwrap();
            Ok(ToolOutput::text("write really completed"))
        }
    }

    #[tokio::test]
    async fn failed_boundary_save_retains_executed_tool_results_and_mid_batch_steer() {
        let dir = tempfile::tempdir().unwrap();
        let provider = ScriptedProvider::new(vec![
            tool_turn(&[
                ("write", "write-steer-fixture", "{}"),
                ("read", "read", "{}"),
            ]),
            text_turn("must not request after boundary failure"),
        ]);
        let (mut agent, log) = agent(
            provider.clone(),
            PermissionMode::Full,
            Arc::new(AutoApprove),
        );
        let calls = Arc::new(AtomicUsize::new(0));
        agent
            .tools
            .register(Arc::new(WriteThenSteerAndBlockCheckpoint {
                steer: agent.steer.clone(),
                calls: calls.clone(),
            }));
        let mut history = vec![user("go")];
        let store = Arc::new(crate::CheckpointStore::open(dir.path().join("cp")).unwrap());
        let scope = crate::CheckpointScope::begin(store, &history, 0).unwrap();
        let original = scope.key();
        let mut ctx = ToolContext::new(dir.path());
        ctx.checkpoint = Some(scope.clone());
        assert!(agent.run(&mut history, &ctx).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("effect.txt")).unwrap(),
            "real effect happened"
        );
        assert_eq!(
            scope.key(),
            original,
            "failed save does not publish a new cursor"
        );
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        assert_eq!(history.len(), 3);
        let completed = results(&history[2]);
        assert_eq!(completed.len(), 2);
        assert!(!completed[0].1 && !completed[1].1);
        assert!(completed[0].2.contains("write really completed"));
        assert!(history[2].content.iter().any(|block| matches!(block, Block::Text { text } if text == "keep this mid-batch instruction")));
        assert!(
            agent.steer.drain().is_empty(),
            "drained text is now retained in history"
        );
        assert!(!log
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, AgentEvent::RunCompleted { .. })));
    }

    #[tokio::test]
    async fn failed_boundary_save_retains_end_turn_steer_and_stop_feedback() {
        use crate::hooks::{HookCommand, HookConfig, HookMatcher};
        for stop_feedback in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let provider =
                ScriptedProvider::new(vec![text_turn("answer"), text_turn("must not request")]);
            let (mut agent, _) = agent(
                provider.clone(),
                PermissionMode::Full,
                Arc::new(AutoApprove),
            );
            if stop_feedback {
                let mut config = HookConfig::default();
                config.hooks.insert("Stop".into(), vec![HookMatcher { matcher: None, hooks: vec![HookCommand {
                    kind: "command".into(), command: if cfg!(windows) {
                        "Write-Output '{\"decision\":\"block\",\"reason\":\"retained feedback\"}'".into()
                    } else { "printf '%s' '{\"decision\":\"block\",\"reason\":\"retained feedback\"}'".into() },
                    timeout: Some(15), plugin_root: None,
                }] }]);
                agent.hooks = Some(Arc::new(HookRunner::new(config, "s1")));
            } else {
                agent.steer.push("retained end-turn steer");
            }
            let mut history = vec![user("go")];
            let store = Arc::new(crate::CheckpointStore::open(dir.path().join("cp")).unwrap());
            let scope = crate::CheckpointScope::begin(store, &history, 0).unwrap();
            let original = scope.key();
            let mut ctx = ToolContext::new(dir.path());
            ctx.checkpoint = Some(scope.clone());
            std::fs::create_dir(dir.path().join("cp/manifest.tmp")).unwrap();
            assert!(agent.run(&mut history, &ctx).await.is_err());
            assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
            assert_eq!(scope.key(), original);
            assert_eq!(history.len(), 3);
            assert!(history[2].content.iter().any(|block| matches!(block, Block::Text { text }
                if text.contains(if stop_feedback { "Stop hook feedback: retained feedback" } else { "retained end-turn steer" }))));
        }
    }

    #[tokio::test]
    async fn failed_compaction_checkpoint_save_keeps_the_original_history() {
        let dir = tempfile::tempdir().unwrap();
        let provider = ScriptedProvider::new(vec![text_turn("summary")]);
        let (mut agent, log) = agent(provider, PermissionMode::Full, Arc::new(AutoApprove));
        agent.config.context_window = Some(1);
        agent.config.compact_threshold = 0.5;
        let mut history: Vec<_> = (0..16)
            .map(|index| {
                if index % 2 == 0 {
                    user(&format!("turn {index}"))
                } else {
                    Message::assistant(vec![Block::text("reply")])
                }
            })
            .collect();
        let store = Arc::new(crate::CheckpointStore::open(dir.path().join("cp")).unwrap());
        let scope = crate::CheckpointScope::begin(store, &history, 14).unwrap();
        let mut ctx = ToolContext::new(dir.path());
        ctx.checkpoint = Some(scope.clone());
        let original = serde_json::to_value(&history).unwrap();
        std::fs::create_dir(dir.path().join("cp/manifest.tmp")).unwrap();
        agent
            .maybe_compact(&mut history, None, "test", &ctx)
            .await
            .unwrap();
        assert_eq!(serde_json::to_value(&history).unwrap(), original);
        assert!(log.lock().unwrap().iter().any(|event| matches!(event, AgentEvent::Error { message } if message.contains("checkpoint save failed"))));
        assert!(!log
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, AgentEvent::Compacted { .. })));
    }

    /// Each request pops one scripted outcome; records the model requested.
    struct FlakyProvider {
        outcomes: std::sync::Mutex<VecDeque<HarnessResult<Vec<StreamEvent>>>>,
        models: std::sync::Mutex<Vec<String>>,
    }

    impl FlakyProvider {
        fn new(outcomes: Vec<HarnessResult<Vec<StreamEvent>>>) -> Arc<Self> {
            Arc::new(Self {
                outcomes: std::sync::Mutex::new(outcomes.into()),
                models: std::sync::Mutex::new(Vec::new()),
            })
        }
    }

    #[async_trait]
    impl Provider for FlakyProvider {
        fn id(&self) -> &str {
            "flaky"
        }

        async fn stream(&self, request: ProviderRequest) -> HarnessResult<ProviderStream> {
            self.models.lock().unwrap().push(request.model);
            let outcome = self
                .outcomes
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(Vec::new()));
            outcome.map(|events| {
                Box::pin(futures_util::stream::iter(events.into_iter().map(Ok))) as ProviderStream
            })
        }
    }

    fn overloaded() -> HarnessError {
        HarnessError::Provider {
            status: Some(529),
            message: "overloaded".to_owned(),
            retryable: true,
        }
    }

    fn flaky_agent(provider: Arc<FlakyProvider>, config: AgentConfig) -> (Agent, EventLog) {
        let (mut agent, log) = agent(
            ScriptedProvider::new(Vec::new()),
            PermissionMode::Full,
            Arc::new(AutoApprove),
        );
        agent.provider = provider;
        agent.config = AgentConfig {
            model: "primary".to_owned(),
            max_retries: 0,
            ..config
        };
        (agent, log)
    }

    #[tokio::test]
    async fn falls_back_to_next_model_after_retries_and_announces_it() {
        let provider = FlakyProvider::new(vec![
            Err(overloaded()),
            Err(overloaded()),
            Ok(tool_turn(&[("a", "read", "{}")])),
            Ok(text_turn("done")),
        ]);
        let (agent, log) = flaky_agent(
            Arc::clone(&provider),
            AgentConfig {
                fallback_models: vec!["backup-1".to_owned(), "backup-2".to_owned()],
                ..AgentConfig::default()
            },
        );
        let mut history = vec![user("go")];
        let outcome = agent
            .run(&mut history, &ToolContext::new("."))
            .await
            .unwrap();
        assert_eq!(outcome.stop, StopReason::EndTurn);
        // Switch sticks for the rest of the run: backup-2 serves both later turns.
        assert_eq!(
            *provider.models.lock().unwrap(),
            ["primary", "backup-1", "backup-2", "backup-2"]
        );
        let fallbacks: Vec<_> = log
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                AgentEvent::ModelFallback { from, to, reason } => {
                    Some((from.clone(), to.clone(), reason.clone()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(fallbacks.len(), 2);
        assert_eq!(fallbacks[0].0, "primary");
        assert_eq!(fallbacks[0].1, "backup-1");
        assert!(fallbacks[0].2.contains("overloaded"));
        assert_eq!(fallbacks[1].0, "backup-1");
        assert_eq!(fallbacks[1].1, "backup-2");
    }

    #[tokio::test]
    async fn model_not_found_falls_back_without_retrying() {
        let provider = FlakyProvider::new(vec![
            Err(HarnessError::Provider {
                status: Some(404),
                message: "model not found".to_owned(),
                retryable: false,
            }),
            Ok(text_turn("ok")),
        ]);
        let (mut agent, _log) = flaky_agent(
            Arc::clone(&provider),
            AgentConfig {
                fallback_models: vec!["backup".to_owned()],
                ..AgentConfig::default()
            },
        );
        agent.config.max_retries = 3;
        let mut history = vec![user("go")];
        agent
            .run(&mut history, &ToolContext::new("."))
            .await
            .unwrap();
        assert_eq!(*provider.models.lock().unwrap(), ["primary", "backup"]);
    }

    #[tokio::test]
    async fn no_fallback_models_means_no_switch() {
        let provider = FlakyProvider::new(vec![Err(overloaded()), Ok(text_turn("never"))]);
        let (agent, log) = flaky_agent(Arc::clone(&provider), AgentConfig::default());
        let mut history = vec![user("go")];
        let result = agent.run(&mut history, &ToolContext::new(".")).await;
        assert!(matches!(result, Err(HarnessError::Provider { .. })));
        assert_eq!(*provider.models.lock().unwrap(), ["primary"]);
        assert!(!log
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, AgentEvent::ModelFallback { .. })));
    }

    fn usage_turn(mut events: Vec<StreamEvent>, input: u64, output: u64) -> Vec<StreamEvent> {
        events.insert(
            0,
            StreamEvent::Usage {
                usage: Usage {
                    input_tokens: input,
                    output_tokens: output,
                    ..Usage::default()
                },
            },
        );
        events
    }

    struct CheckpointRejectedProcess(Arc<AtomicUsize>);
    #[async_trait]
    impl Tool for CheckpointRejectedProcess {
        fn spec(&self) -> ToolSpec {
            ToolSpec {
                name: "process-fixture".into(),
                description: "count without spawning".into(),
                input_schema: json!({"type":"object"}),
            }
        }
        fn effect(&self) -> EffectClass {
            EffectClass::ExecuteProcess
        }
        async fn call(&self, _: &ToolContext, _: Value) -> HarnessResult<ToolOutput> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(ToolOutput::text("should not execute"))
        }
    }

    #[tokio::test]
    async fn checkpoint_note_failure_completes_process_tool_without_execution() {
        let dir = tempfile::tempdir().unwrap();
        let provider = ScriptedProvider::new(vec![
            tool_turn(&[("process-call", "process-fixture", "{}")]),
            text_turn("done"),
        ]);
        let (mut agent, log) = agent(provider, PermissionMode::Full, Arc::new(AutoApprove));
        let calls = Arc::new(AtomicUsize::new(0));
        agent
            .tools
            .register(Arc::new(CheckpointRejectedProcess(calls.clone())));
        let mut history = vec![user("go")];
        let store = Arc::new(crate::CheckpointStore::open(dir.path().join("cp")).unwrap());
        let scope = crate::CheckpointScope::begin(store, &history, 0).unwrap();
        let mut ctx = ToolContext::new(dir.path());
        ctx.checkpoint = Some(scope);
        std::fs::create_dir(dir.path().join("cp/manifest.tmp")).unwrap();
        agent.run(&mut history, &ctx).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let results = results(&history[2]);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "process-call");
        assert!(results[0].1);
        assert!(results[0].2.contains("Cannot record untracked command"));
        let events = log.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(
                    |event| matches!(event, AgentEvent::ToolStarted { id } if id == "process-call")
                )
                .count(),
            1
        );
        let completed: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                AgentEvent::ToolCompleted { id, output } if id == "process-call" => Some(output),
                _ => None,
            })
            .collect();
        assert_eq!(completed.len(), 1);
        assert!(completed[0].is_error);
        assert!(
            matches!(&completed[0].content[0], Block::Text { text } if text.contains("Cannot record untracked command"))
        );
    }

    #[derive(Clone, Copy)]
    enum UsageTail {
        Complete,
        Empty,
        Error,
        RetryableError,
        Pending,
    }

    struct ObservedUsageProvider {
        tail: UsageTail,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl Provider for ObservedUsageProvider {
        fn id(&self) -> &str {
            "observed-usage"
        }
        async fn stream(&self, _: ProviderRequest) -> HarnessResult<ProviderStream> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let usage = futures_util::stream::iter([
                Ok(StreamEvent::Usage {
                    usage: Usage {
                        input_tokens: 20,
                        ..Usage::default()
                    },
                }),
                Ok(StreamEvent::Usage {
                    usage: Usage {
                        input_tokens: 10,
                        output_tokens: 10,
                        ..Usage::default()
                    },
                }),
            ]);
            let tail: ProviderStream = match self.tail {
                UsageTail::Complete => Box::pin(futures_util::stream::iter(
                    text_turn("summary or answer").into_iter().map(Ok),
                )),
                UsageTail::Empty => Box::pin(futures_util::stream::empty()),
                UsageTail::Error => Box::pin(futures_util::stream::once(async {
                    Err(HarnessError::Protocol("after observed usage".into()))
                })),
                UsageTail::RetryableError => {
                    Box::pin(futures_util::stream::once(async { Err(overloaded()) }))
                }
                UsageTail::Pending => Box::pin(futures_util::stream::pending()),
            };
            Ok(Box::pin(usage.chain(tail)))
        }
    }

    fn observed_usage_fixture(
        tail: UsageTail,
        compaction: bool,
        cancel_after_usage: bool,
    ) -> (Agent, Arc<ObservedUsageProvider>, ToolContext, EventLog) {
        let (mut agent, log) = agent(
            ScriptedProvider::new(vec![]),
            PermissionMode::Full,
            Arc::new(AutoApprove),
        );
        let provider = Arc::new(ObservedUsageProvider {
            tail,
            calls: AtomicUsize::new(0),
        });
        agent.provider = provider.clone();
        agent.config.compact_threshold = if compaction { 0.5 } else { 0.0 };
        agent.config.context_window = Some(1);
        let mut ctx = ToolContext::new(".");
        ctx.token_budget = Some(crate::TokenBudgetLedger::new(Some(100), 60));
        if cancel_after_usage {
            let cancel = ctx.cancel.clone();
            let sink = log.clone();
            agent.events = Arc::new(move |event: AgentEvent| {
                let is_last_usage = matches!(&event, AgentEvent::Stream {
                    event: StreamEvent::Usage { usage }
                } if usage.output_tokens == 10);
                sink.lock().unwrap().push(event);
                if is_last_usage {
                    cancel.cancel();
                }
            });
        }
        (agent, provider, ctx, log)
    }

    fn observed_compaction_history() -> Vec<Message> {
        (0..16)
            .map(|index| {
                if index % 2 == 0 {
                    user("old user turn")
                } else {
                    Message::assistant(vec![Block::text("old answer")])
                }
            })
            .collect()
    }

    fn assert_observed_usage(log: &EventLog, expect_completed: bool) {
        let events = log.lock().unwrap();
        let mut observed = Usage::default();
        for event in events.iter() {
            if let AgentEvent::Stream {
                event: StreamEvent::Usage { usage },
            } = event
            {
                observed.add(usage);
            }
        }
        assert_eq!((observed.input_tokens, observed.output_tokens), (30, 10));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, AgentEvent::BudgetWarning { .. }))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .any(|event| matches!(event, AgentEvent::TurnCompleted { .. })),
            expect_completed
        );
    }

    #[tokio::test]
    async fn observed_usage_survives_stream_error_and_blocks_the_next_shared_request() {
        let (agent, provider, ctx, log) = observed_usage_fixture(UsageTail::Error, false, false);
        let mut history = vec![user("go")];
        assert!(matches!(
            agent.run(&mut history, &ctx).await,
            Err(HarnessError::Protocol(_))
        ));
        assert_eq!(ctx.token_budget.as_ref().unwrap().snapshot().used, 100);
        assert_observed_usage(&log, false);
        assert!(matches!(
            agent.run(&mut history, &ctx).await,
            Err(HarnessError::BudgetExceeded {
                used: 100,
                budget: 100
            })
        ));
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retryable_provider_error_after_usage_neither_retries_nor_falls_back() {
        let (mut agent, provider, ctx, log) =
            observed_usage_fixture(UsageTail::RetryableError, false, false);
        agent.config.max_retries = 3;
        agent.config.fallback_models = vec!["backup".into()];
        assert!(matches!(
            agent.run(&mut vec![user("go")], &ctx).await,
            Err(HarnessError::Provider {
                retryable: true,
                ..
            })
        ));
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        assert_eq!(ctx.token_budget.as_ref().unwrap().snapshot().used, 100);
        assert_observed_usage(&log, false);
        assert!(!log.lock().unwrap().iter().any(|event| matches!(
            event,
            AgentEvent::Retrying { .. } | AgentEvent::ModelFallback { .. }
        )));
    }

    #[tokio::test]
    async fn observed_usage_survives_cancellation_after_ingestion() {
        let (agent, _, ctx, log) = observed_usage_fixture(UsageTail::Pending, false, true);
        assert!(matches!(
            agent.run(&mut vec![user("go")], &ctx).await,
            Err(HarnessError::Cancelled)
        ));
        assert_eq!(ctx.token_budget.as_ref().unwrap().snapshot().used, 100);
        assert_observed_usage(&log, false);
    }

    #[tokio::test]
    async fn successful_multi_delta_usage_is_charged_exactly_once() {
        let (agent, _, ctx, log) = observed_usage_fixture(UsageTail::Complete, false, false);
        let outcome = agent.run(&mut vec![user("go")], &ctx).await.unwrap();
        assert_eq!(
            (outcome.usage.input_tokens, outcome.usage.output_tokens),
            (30, 10)
        );
        assert_eq!(ctx.token_budget.as_ref().unwrap().snapshot().used, 100);
        assert_observed_usage(&log, true);
    }

    #[tokio::test]
    async fn compaction_usage_is_charged_before_main_request_for_success_empty_and_error() {
        for tail in [UsageTail::Complete, UsageTail::Empty, UsageTail::Error] {
            let (agent, provider, ctx, log) = observed_usage_fixture(tail, true, false);
            let mut history = observed_compaction_history();
            assert!(matches!(
                agent.run(&mut history, &ctx).await,
                Err(HarnessError::BudgetExceeded {
                    used: 100,
                    budget: 100
                })
            ));
            assert_eq!(
                provider.calls.load(Ordering::SeqCst),
                1,
                "main request must not start"
            );
            assert_observed_usage(&log, false);
            let events = log.lock().unwrap();
            assert!(
                !events.iter().any(|event| matches!(
                    event,
                    AgentEvent::Stream {
                        event: StreamEvent::TextDelta { .. }
                    }
                )),
                "summary text is private to compaction"
            );
            assert_eq!(
                events
                    .iter()
                    .any(|event| matches!(event, AgentEvent::Compacted { .. })),
                matches!(tail, UsageTail::Complete)
            );
        }
    }

    #[tokio::test]
    async fn compaction_usage_is_retained_when_cancelled_after_ingestion() {
        let (agent, provider, ctx, log) = observed_usage_fixture(UsageTail::Pending, true, true);
        let mut history = observed_compaction_history();
        assert!(matches!(
            agent.run(&mut history, &ctx).await,
            Err(HarnessError::Cancelled)
        ));
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        assert_eq!(ctx.token_budget.as_ref().unwrap().snapshot().used, 100);
        assert_observed_usage(&log, false);
        assert_eq!(history.len(), 16);
    }

    #[tokio::test]
    async fn no_split_compaction_has_no_request_and_no_budget_charge() {
        let (agent, provider, ctx, log) = observed_usage_fixture(UsageTail::Complete, true, false);
        agent
            .maybe_compact(&mut vec![user("one")], None, "test", &ctx)
            .await
            .unwrap();
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
        assert_eq!(ctx.token_budget.as_ref().unwrap().snapshot().used, 60);
        assert!(log.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn compaction_admission_budget_error_is_propagated_without_request() {
        let (agent, provider, mut ctx, log) =
            observed_usage_fixture(UsageTail::Complete, true, false);
        ctx.token_budget = Some(crate::TokenBudgetLedger::new(Some(100), 100));
        assert!(matches!(
            agent
                .maybe_compact(&mut observed_compaction_history(), None, "test", &ctx)
                .await,
            Err(HarnessError::BudgetExceeded {
                used: 100,
                budget: 100
            })
        ));
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
        assert!(log.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unlimited_context_still_emits_compaction_usage() {
        let (agent, _, mut ctx, log) = observed_usage_fixture(UsageTail::Complete, true, false);
        ctx.token_budget = None;
        agent
            .maybe_compact(&mut observed_compaction_history(), None, "test", &ctx)
            .await
            .unwrap();
        let events = log.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event,
                    AgentEvent::Stream {
                        event: StreamEvent::Usage { .. }
                    }
                ))
                .count(),
            2
        );
        assert!(!events
            .iter()
            .any(|event| matches!(event, AgentEvent::BudgetWarning { .. })));
    }

    #[tokio::test]
    async fn budget_warns_once_at_eighty_percent_then_stops_before_next_request() {
        let provider = FlakyProvider::new(vec![
            Ok(usage_turn(tool_turn(&[("a", "read", "{}")]), 50, 10)), // 60/100
            Ok(usage_turn(tool_turn(&[("b", "read", "{}")]), 15, 10)), // 85/100: warn
            Ok(usage_turn(tool_turn(&[("c", "read", "{}")]), 10, 10)), // 105/100: stop
            Ok(text_turn("never requested")),
        ]);
        let (agent, log) = flaky_agent(
            Arc::clone(&provider),
            AgentConfig {
                token_budget: Some(100),
                ..AgentConfig::default()
            },
        );
        let mut history = vec![user("go")];
        let result = agent.run(&mut history, &ToolContext::new(".")).await;
        match result {
            Err(HarnessError::BudgetExceeded { used, budget }) => {
                assert_eq!((used, budget), (105, 100));
            }
            other => panic!("expected budget stop, got {other:?}"),
        }
        assert_eq!(provider.models.lock().unwrap().len(), 3);
        let warnings: Vec<_> = log
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                AgentEvent::BudgetWarning { used, budget } => Some((*used, *budget)),
                _ => None,
            })
            .collect();
        assert_eq!(warnings, [(85, 100)]);
        assert_eq!(
            HarnessError::BudgetExceeded {
                used: 105,
                budget: 100
            }
            .to_string(),
            "Token budget reached (105/100). Raise it in session settings to continue."
        );
    }

    #[tokio::test]
    async fn budget_counts_usage_from_earlier_runs() {
        let provider = FlakyProvider::new(vec![Ok(text_turn("never"))]);
        let (agent, log) = flaky_agent(
            Arc::clone(&provider),
            AgentConfig {
                token_budget: Some(100),
                initial_tokens_used: 100,
                ..AgentConfig::default()
            },
        );
        let mut history = vec![user("go")];
        let result = agent.run(&mut history, &ToolContext::new(".")).await;
        assert!(matches!(
            result,
            Err(HarnessError::BudgetExceeded {
                used: 100,
                budget: 100
            })
        ));
        assert!(provider.models.lock().unwrap().is_empty());
        // Already past 80% before the run: no (repeat) warning.
        assert!(!log
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, AgentEvent::BudgetWarning { .. })));
    }

    #[tokio::test]
    async fn cancellation_stops_the_run() {
        let provider = ScriptedProvider::new(vec![text_turn("hi")]);
        let (agent, _log) = agent(provider, PermissionMode::Full, Arc::new(AutoApprove));
        let ctx = ToolContext::new(".");
        ctx.cancel.cancel();
        let mut history = vec![user("go")];
        assert!(matches!(
            agent.run(&mut history, &ctx).await,
            Err(HarnessError::Cancelled)
        ));
    }

    /// Answers each request from a script and records what it was asked.
    struct Scripted {
        decisions: std::sync::Mutex<VecDeque<ApprovalDecision>>,
        asked: std::sync::Mutex<Vec<ApprovalRequest>>,
    }

    impl Scripted {
        fn new(decisions: Vec<ApprovalDecision>) -> Arc<Self> {
            Arc::new(Self {
                decisions: std::sync::Mutex::new(decisions.into()),
                asked: Default::default(),
            })
        }
    }

    #[async_trait]
    impl Approver for Scripted {
        async fn request(&self, request: ApprovalRequest) -> ApprovalDecision {
            self.asked.lock().unwrap().push(request);
            self.decisions
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(ApprovalDecision::AllowOnce)
        }
    }

    #[tokio::test]
    async fn allow_edited_runs_the_edited_input_and_tells_the_model() {
        let provider = ScriptedProvider::new(vec![
            tool_turn(&[("a", "write", r#"{"path":"original"}"#)]),
            text_turn("ok"),
        ]);
        let approver = Scripted::new(vec![ApprovalDecision::AllowEdited {
            input: json!({"path": "edited"}),
        }]);
        let (agent, log) = agent(provider, PermissionMode::AskWrites, approver.clone());
        let mut history = vec![user("go")];
        agent
            .run(&mut history, &ToolContext::new("."))
            .await
            .unwrap();
        let result = results(&history[2]);
        assert!(!result[0].1);
        assert!(
            result[0].2.contains("edited this call's arguments"),
            "{}",
            result[0].2
        );
        let Block::ToolResult { content, .. } = &history[2].content[0] else {
            panic!()
        };
        let Block::Text { text } = &content[1] else {
            panic!()
        };
        assert_eq!(text, r#"write:{"path":"edited"}"#);
        assert!(log.lock().unwrap().iter().any(|event| matches!(
            event,
            AgentEvent::ApprovalDecided {
                decision: ApprovalDecision::AllowEdited { .. },
                ..
            }
        )));
    }

    #[tokio::test]
    async fn allow_edited_input_is_still_subject_to_deny_rules() {
        let provider = ScriptedProvider::new(vec![
            tool_turn(&[("a", "write", r#"{"path":"fine.txt"}"#)]),
            text_turn("ok"),
        ]);
        let approver = Scripted::new(vec![ApprovalDecision::AllowEdited {
            input: json!({"path": "secrets/.env"}),
        }]);
        let (agent, _log) = agent(provider, PermissionMode::AskWrites, approver);
        agent
            .policy
            .lock()
            .await
            .rules
            .push(crate::permission::PermissionRule::new(
                "write",
                Some("re:\\.env$"),
                crate::permission::RuleAction::Deny,
            ));
        let mut history = vec![user("go")];
        agent
            .run(&mut history, &ToolContext::new("."))
            .await
            .unwrap();
        let result = results(&history[2]);
        assert!(
            result[0].1 && result[0].2.contains("Blocked by your rule"),
            "{:?}",
            result
        );
    }

    #[tokio::test]
    async fn approvals_carry_the_queue_behind_them_in_order() {
        let provider = ScriptedProvider::new(vec![
            tool_turn(&[
                ("a", "write", r#"{"path":"1"}"#),
                ("r", "read", "{}"),
                ("b", "write", r#"{"path":"2"}"#),
                ("c", "write", r#"{"path":"3"}"#),
            ]),
            text_turn("ok"),
        ]);
        let approver = Scripted::new(vec![]);
        let (agent, _log) = agent(provider, PermissionMode::AskWrites, approver.clone());
        let mut history = vec![user("go")];
        agent
            .run(&mut history, &ToolContext::new("."))
            .await
            .unwrap();
        let asked = approver.asked.lock().unwrap();
        let order: Vec<_> = asked
            .iter()
            .map(|r| (r.tool_use_id.as_str(), r.ordinal, r.total))
            .collect();
        assert_eq!(order, vec![("a", 1, 3), ("b", 2, 3), ("c", 3, 3)]);
        let behind: Vec<Vec<&str>> = asked
            .iter()
            .map(|r| r.remaining.iter().map(|p| p.tool_use_id.as_str()).collect())
            .collect();
        assert_eq!(behind, vec![vec!["b", "c"], vec!["c"], vec![]]);
        assert_eq!(asked[0].remaining[0].input, json!({"path": "2"}));
    }

    fn hook_runner_writing_to(event: &str, file: &std::path::Path) -> Arc<HookRunner> {
        use crate::hooks::{HookCommand, HookConfig, HookMatcher};
        let command = if cfg!(windows) {
            format!(
                "[Console]::In.ReadToEnd() | Add-Content -Path '{}'",
                file.display()
            )
        } else {
            format!("cat >> '{}'; echo >> '{}'", file.display(), file.display())
        };
        let mut config = HookConfig::default();
        config.hooks.insert(
            event.to_owned(),
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
        Arc::new(HookRunner::new(config, "s1"))
    }

    #[tokio::test]
    async fn notification_hook_fires_for_approvals_with_the_documented_payload() {
        let dir = std::env::temp_dir().join(format!("omnia-notify-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notified.jsonl");
        let _ = std::fs::remove_file(&file);
        let provider = ScriptedProvider::new(vec![
            tool_turn(&[("a", "write", r#"{"path":"x"}"#)]),
            text_turn("ok"),
        ]);
        let (mut agent, _log) = agent(provider, PermissionMode::AskWrites, Scripted::new(vec![]));
        agent.hooks = Some(hook_runner_writing_to("Notification", &file));
        let mut history = vec![user("go")];
        agent
            .run(&mut history, &ToolContext::new(&dir))
            .await
            .unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        let payload: Value = serde_json::from_str(
            text.lines()
                .find(|l| l.trim_start().starts_with('{'))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(payload["hook_event_name"], "Notification");
        assert_eq!(payload["notification_type"], "approval_requested");
        assert_eq!(payload["tool_name"], "write");
        assert_eq!(payload["tool_input"], json!({"path": "x"}));
        assert_eq!(
            (payload["ordinal"].as_u64(), payload["total"].as_u64()),
            (Some(1), Some(1))
        );
        assert!(payload["message"].as_str().unwrap().contains("approval"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn present_plan_ends_the_turn_and_fires_plan_ready() {
        let dir = std::env::temp_dir().join(format!("omnia-plan-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notified.jsonl");
        let _ = std::fs::remove_file(&file);
        let provider = ScriptedProvider::new(vec![
            tool_turn(&[("p", "present_plan", r##"{"plan":"# Plan\n1. do it"}"##)]),
            text_turn("must never be requested"),
        ]);
        let (mut agent, log) = agent(
            Arc::clone(&provider),
            PermissionMode::Plan,
            Scripted::new(vec![]),
        );
        crate::plan::register_for_mode(&mut agent.tools, PermissionMode::Plan);
        agent.hooks = Some(hook_runner_writing_to("Notification", &file));
        let mut history = vec![user("plan it")];
        let outcome = agent
            .run(&mut history, &ToolContext::new(&dir))
            .await
            .unwrap();
        assert_eq!(outcome.turns, 1);
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            1,
            "the turn ended at the plan"
        );
        let result = results(&history[2]);
        assert!(!result[0].1, "{result:?}");
        assert!(log.lock().unwrap().iter().any(|event| matches!(
            event,
            AgentEvent::PlanPresented { id, plan } if id == "p" && plan.contains("do it")
        )));
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("plan_ready"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn present_plan_is_refused_outside_plan_mode_registration() {
        // Without registration (any other mode) the call is an unknown tool and the run goes on.
        let provider = ScriptedProvider::new(vec![
            tool_turn(&[("p", "present_plan", r#"{"plan":"x"}"#)]),
            text_turn("ok"),
        ]);
        let (agent, _log) = agent(
            Arc::clone(&provider),
            PermissionMode::Full,
            Scripted::new(vec![]),
        );
        let mut history = vec![user("go")];
        let outcome = agent
            .run(&mut history, &ToolContext::new("."))
            .await
            .unwrap();
        assert_eq!(outcome.turns, 2);
        assert!(results(&history[2])[0].2.contains("Unknown tool"));
    }

    /// Signals when `call` starts; then either ignores `ctx.cancel` forever or
    /// honours it. Records whether its future was dropped.
    struct CancelProbe {
        cooperative: bool,
        started: Arc<tokio::sync::Notify>,
        dropped: Arc<std::sync::atomic::AtomicBool>,
    }

    struct DropFlag(Arc<std::sync::atomic::AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[async_trait]
    impl Tool for CancelProbe {
        fn spec(&self) -> ToolSpec {
            ToolSpec {
                name: "probe".to_owned(),
                description: "probe".to_owned(),
                input_schema: json!({"type": "object"}),
            }
        }

        fn effect(&self) -> EffectClass {
            EffectClass::ReadWorkspace
        }

        async fn call(&self, ctx: &ToolContext, _input: Value) -> HarnessResult<ToolOutput> {
            let _flag = DropFlag(Arc::clone(&self.dropped));
            self.started.notify_one();
            if self.cooperative {
                ctx.cancel.cancelled().await;
                return Err(HarnessError::Cancelled);
            }
            std::future::pending::<()>().await;
            Ok(ToolOutput::text("fabricated success"))
        }
    }

    /// Runs one `probe` call, cancels once it starts, and returns the run
    /// result, the provider, the event log, how long the run took after
    /// cancellation (virtual time), and whether the tool future was dropped.
    async fn run_cancelled_probe(
        cooperative: bool,
    ) -> (
        HarnessResult<RunOutcome>,
        Arc<ScriptedProvider>,
        EventLog,
        Duration,
        bool,
    ) {
        let (result, provider, log, elapsed, dropped, _) =
            run_cancelled_probe_with_turn_limit(cooperative, AgentConfig::default().max_turns)
                .await;
        (result, provider, log, elapsed, dropped)
    }

    async fn run_cancelled_probe_with_turn_limit(
        cooperative: bool,
        max_turns: u32,
    ) -> (
        HarnessResult<RunOutcome>,
        Arc<ScriptedProvider>,
        EventLog,
        Duration,
        bool,
        Vec<Message>,
    ) {
        let provider = ScriptedProvider::new(vec![
            tool_turn(&[("p1", "probe", "{}")]),
            text_turn("must not be requested"),
        ]);
        let (mut agent, log) = agent(
            Arc::clone(&provider),
            PermissionMode::Full,
            Arc::new(AutoApprove),
        );
        agent.config.max_turns = max_turns;
        let started = Arc::new(tokio::sync::Notify::new());
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        agent.tools.register(Arc::new(CancelProbe {
            cooperative,
            started: Arc::clone(&started),
            dropped: Arc::clone(&dropped),
        }));
        let ctx = ToolContext::new(".");
        let token = ctx.cancel.clone();
        let mut history = vec![user("go")];
        let cancelled_at = Arc::new(std::sync::Mutex::new(None));
        let mark = Arc::clone(&cancelled_at);
        let canceller = async move {
            started.notified().await;
            *mark.lock().unwrap() = Some(tokio::time::Instant::now());
            token.cancel();
        };
        let run = async {
            // Guard: a regression fails the test instead of hanging it.
            tokio::time::timeout(Duration::from_secs(60), agent.run(&mut history, &ctx))
                .await
                .expect("cancelled run must complete")
        };
        let (result, ()) = tokio::join!(run, canceller);
        let elapsed = cancelled_at
            .lock()
            .unwrap()
            .expect("tool started")
            .elapsed();
        (
            result,
            provider,
            log,
            elapsed,
            dropped.load(Ordering::SeqCst),
            history,
        )
    }

    fn probe_completions(log: &EventLog) -> Vec<ToolOutput> {
        log.lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                AgentEvent::ToolCompleted { id, output } if id == "p1" => Some(output.clone()),
                _ => None,
            })
            .collect()
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_abandons_a_tool_that_ignores_it() {
        let (result, provider, log, elapsed, dropped) = run_cancelled_probe(false).await;
        assert!(matches!(result, Err(HarnessError::Cancelled)), "{result:?}");
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            1,
            "no provider call after cancel"
        );
        assert!(dropped, "the abandoned tool future is dropped");
        assert!(
            elapsed >= TOOL_CANCEL_GRACE
                && elapsed < TOOL_CANCEL_GRACE + Duration::from_millis(100),
            "returns right after the grace period, took {elapsed:?}"
        );
        let completions = probe_completions(&log);
        assert_eq!(completions.len(), 1);
        assert!(completions[0].is_error, "no fabricated success");
        assert!(
            matches!(&completions[0].content[..], [Block::Text { text }] if text == "cancelled")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn cooperative_tool_reports_its_own_cancellation_without_waiting() {
        let (result, provider, log, elapsed, dropped) = run_cancelled_probe(true).await;
        assert!(matches!(result, Err(HarnessError::Cancelled)), "{result:?}");
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        assert!(dropped);
        assert_eq!(
            elapsed,
            Duration::ZERO,
            "no grace wait for a cooperative tool"
        );
        let completions = probe_completions(&log);
        assert_eq!(completions.len(), 1);
        assert!(completions[0].is_error);
    }

    async fn assert_last_tool_turn_is_cancelled(cooperative: bool) {
        let (result, provider, log, elapsed, dropped, history) =
            run_cancelled_probe_with_turn_limit(cooperative, 1).await;
        assert!(matches!(result, Err(HarnessError::Cancelled)), "{result:?}");
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            1,
            "no provider call after cancel"
        );
        assert!(dropped, "cancelled tool future must be dropped");
        if cooperative {
            assert_eq!(elapsed, Duration::ZERO);
        } else {
            assert!(
                elapsed >= TOOL_CANCEL_GRACE
                    && elapsed < TOOL_CANCEL_GRACE + Duration::from_millis(100),
                "last-turn cancellation respects the cleanup grace, took {elapsed:?}"
            );
        }
        let completions = probe_completions(&log);
        assert_eq!(completions.len(), 1, "exactly one tool terminal event");
        assert!(completions[0].is_error);
        assert_eq!(
            history.len(),
            3,
            "retain assistant call and its cancelled tool result"
        );
        assert_eq!(
            results(&history[2]),
            vec![("p1".to_owned(), true, "cancelled".to_owned())]
        );
        assert!(
            !log.lock()
                .unwrap()
                .iter()
                .any(|event| matches!(event, AgentEvent::RunCompleted { .. })),
            "an interrupt must not emit a successful run terminal event"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_on_last_turn_abandons_an_uncooperative_tool_without_completing() {
        assert_last_tool_turn_is_cancelled(false).await;
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_on_last_turn_preserves_a_cooperative_tool_result_without_completing() {
        assert_last_tool_turn_is_cancelled(true).await;
    }

    #[tokio::test]
    async fn cancellation_after_the_final_model_turn_is_not_reported_as_completed() {
        let provider = ScriptedProvider::new(vec![text_turn("already streamed")]);
        let (mut agent, log) = agent(
            Arc::clone(&provider),
            PermissionMode::Full,
            Arc::new(AutoApprove),
        );
        agent.config.max_turns = 1;
        let ctx = ToolContext::new(".");
        let token = ctx.cancel.clone();
        let sink = Arc::clone(&log);
        agent.events = Arc::new(move |event: AgentEvent| {
            if matches!(&event, AgentEvent::TurnCompleted { .. }) {
                token.cancel();
            }
            sink.lock().unwrap().push(event);
        });
        let mut history = vec![user("go")];
        let result = agent.run(&mut history, &ctx).await;
        assert!(matches!(result, Err(HarnessError::Cancelled)), "{result:?}");
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            history.len(),
            2,
            "already received assistant content remains available"
        );
        assert!(!log
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, AgentEvent::RunCompleted { .. })));
    }

    #[tokio::test]
    async fn cancellation_after_a_plan_tool_result_does_not_present_the_plan() {
        struct CancelPlanTool;

        #[async_trait]
        impl Tool for CancelPlanTool {
            fn spec(&self) -> ToolSpec {
                ToolSpec {
                    name: PRESENT_PLAN_TOOL.to_owned(),
                    description: "cancel while a plan tool completes".to_owned(),
                    input_schema: json!({"type": "object"}),
                }
            }

            fn effect(&self) -> EffectClass {
                EffectClass::PureCompute
            }

            async fn call(&self, ctx: &ToolContext, _input: Value) -> HarnessResult<ToolOutput> {
                ctx.cancel.cancel();
                Ok(ToolOutput::text("plan recorded before cancellation"))
            }
        }

        let provider = ScriptedProvider::new(vec![tool_turn(&[(
            "plan-1",
            PRESENT_PLAN_TOOL,
            r#"{"plan":"Do the work"}"#,
        )])]);
        let (mut agent, log) = agent(
            Arc::clone(&provider),
            PermissionMode::Full,
            Arc::new(AutoApprove),
        );
        agent.config.max_turns = 1;
        agent.tools.register(Arc::new(CancelPlanTool));
        let mut history = vec![user("plan it")];
        let result = agent.run(&mut history, &ToolContext::new(".")).await;
        assert!(matches!(result, Err(HarnessError::Cancelled)), "{result:?}");
        assert_eq!(
            results(&history[2]),
            vec![(
                "plan-1".to_owned(),
                false,
                "plan recorded before cancellation".to_owned(),
            )],
            "a completed tool result is still retained"
        );
        let events = log.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event,
                    AgentEvent::ToolCompleted { id, .. } if id == "plan-1"
                ))
                .count(),
            1
        );
        assert!(
            !events.iter().any(|event| matches!(
                event,
                AgentEvent::PlanPresented { .. } | AgentEvent::RunCompleted { .. }
            )),
            "cancelled run must not transition to plan-ready or completed"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn child_cancellation_on_its_last_tool_turn_is_not_reported_as_completed() {
        let mut turns: Vec<_> = (0..99)
            .map(|turn| tool_turn(&[(&format!("read-{turn}"), "read", "{}")]))
            .collect();
        turns.push(tool_turn(&[("p1", "probe", "{}")]));
        let provider = ScriptedProvider::new(turns);
        let (mut template, log) = agent(
            Arc::clone(&provider),
            PermissionMode::Full,
            Arc::new(AutoApprove),
        );
        template.config.compact_threshold = 0.0;
        let started = Arc::new(tokio::sync::Notify::new());
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        template.tools.register(Arc::new(CancelProbe {
            cooperative: true,
            started: Arc::clone(&started),
            dropped: Arc::clone(&dropped),
        }));
        let task = crate::subagent::TaskTool {
            provider: Arc::clone(&template.provider),
            config: template.config.clone(),
            tools: template.tools.clone(),
            policy: Arc::clone(&template.policy),
            approver: Arc::clone(&template.approver),
            events: Arc::clone(&template.events),
            agents: crate::subagent::builtin_agents(),
            hooks: None,
            current_depth: 0,
            max_depth: crate::subagent::DEFAULT_MAX_SUBAGENT_DEPTH,
        };
        let mut ctx = ToolContext::new(".");
        ctx.tool_use_id = "parent-task".to_owned();
        let token = ctx.cancel.clone();
        let canceller = async move {
            started.notified().await;
            token.cancel();
        };
        let run = async {
            tokio::time::timeout(
                Duration::from_secs(60),
                task.call(
                    &ctx,
                    json!({
                        "description": "cancel at child limit",
                        "prompt": "run the scripted tools",
                    }),
                ),
            )
            .await
            .expect("child cancellation must finish")
        };
        let (result, ()) = tokio::join!(run, canceller);
        assert!(matches!(result, Err(HarnessError::Cancelled)), "{result:?}");
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            100,
            "cancel on the child's last allowed turn"
        );
        assert!(dropped.load(Ordering::SeqCst));
        let events = log.lock().unwrap();
        let completions: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                AgentEvent::Subagent { parent_id, event } if parent_id == "parent-task" => {
                    match event.as_ref() {
                        AgentEvent::ToolCompleted { id, output }
                            if id.starts_with("subagent_") && id.ends_with("_t100_p1") =>
                        {
                            Some(output)
                        }
                        _ => None,
                    }
                }
                _ => None,
            })
            .collect();
        assert_eq!(completions.len(), 1);
        assert!(completions[0].is_error);
        assert!(!events.iter().any(|event| matches!(event,
            AgentEvent::Subagent { event, .. } if matches!(event.as_ref(), AgentEvent::RunCompleted { .. })
        )), "cancelled child must not report successful completion");
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_respects_custom_cancel_grace_period() {
        let provider = ScriptedProvider::new(vec![
            tool_turn(&[("p1", "probe", "{}")]),
            text_turn("must not be requested"),
        ]);
        let (mut agent, _log) = agent(
            Arc::clone(&provider),
            PermissionMode::Full,
            Arc::new(AutoApprove),
        );
        let custom_grace = Duration::from_millis(600);
        agent.config.cancel_grace_period = Some(custom_grace);

        let started = Arc::new(tokio::sync::Notify::new());
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        agent.tools.register(Arc::new(CancelProbe {
            cooperative: false,
            started: Arc::clone(&started),
            dropped: Arc::clone(&dropped),
        }));
        let ctx = ToolContext::new(".");
        let token = ctx.cancel.clone();
        let mut history = vec![user("go")];
        let cancelled_at = Arc::new(std::sync::Mutex::new(None));
        let mark = Arc::clone(&cancelled_at);
        let canceller = async move {
            started.notified().await;
            *mark.lock().unwrap() = Some(tokio::time::Instant::now());
            token.cancel();
        };
        let run = async {
            tokio::time::timeout(Duration::from_secs(60), agent.run(&mut history, &ctx))
                .await
                .expect("cancelled run must complete")
        };
        let (result, ()) = tokio::join!(run, canceller);
        let elapsed = cancelled_at
            .lock()
            .unwrap()
            .expect("tool started")
            .elapsed();
        assert!(matches!(result, Err(HarnessError::Cancelled)));
        assert!(dropped.load(Ordering::SeqCst));
        assert!(
            elapsed >= custom_grace && elapsed < custom_grace + Duration::from_millis(100),
            "custom grace period respected: elapsed {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn turn_completed_event_records_duration_and_ttft() {
        let provider = ScriptedProvider::new(vec![text_turn("hello world")]);
        let (agent, log) = agent(
            Arc::clone(&provider),
            PermissionMode::Full,
            Arc::new(AutoApprove),
        );
        let ctx = ToolContext::new(".");
        let mut history = vec![user("hi")];
        let outcome = agent.run(&mut history, &ctx).await.unwrap();
        assert_eq!(outcome.turns, 1);
        let events = log.lock().unwrap();
        let turn_completed = events.iter().find_map(|e| match e {
            AgentEvent::TurnCompleted {
                turn,
                usage: _,
                stop: _,
                duration_ms,
                ttft_ms,
            } => Some((*turn, *duration_ms, *ttft_ms)),
            _ => None,
        });
        assert!(turn_completed.is_some());
        let (turn, duration, ttft) = turn_completed.unwrap();
        assert_eq!(turn, 1);
        assert!(duration.is_some(), "duration_ms should be recorded");
        assert!(ttft.is_some(), "ttft_ms should be recorded");
    }
}
