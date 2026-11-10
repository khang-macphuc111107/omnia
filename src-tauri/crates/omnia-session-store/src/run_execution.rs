//! Transport-independent execution after the host has prepared an agent.
//!
//! The caller retains admission, provider/credential selection, tool and
//! workspace authorization, event publication, terminal publication and run
//! cleanup. This module runs the existing Agent; it creates no runtime, store,
//! admission registry or second execution engine. Its file/checkpoint and
//! persistence ordering intentionally retains the compatibility host behavior.

use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use omnia_harness::{
    agent::{Agent, AgentEvent, EventSink},
    hooks::HookEvent,
    permission::PermissionRule,
    Block, CheckpointScope, CheckpointStore, HarnessError, Message, ToolContext,
};
use serde_json::{json, Value};

use crate::{
    error::{NativeError, NativeResult},
    harness_store::HarnessStore,
};

/// Usage events are the accounting source, including nested child agents.
/// Turn completion is context telemetry and must not be charged a second time.
pub fn observed_spend(event: &AgentEvent) -> u64 {
    match event {
        AgentEvent::Stream {
            event: omnia_harness::StreamEvent::Usage { usage },
        } => usage.input_tokens.saturating_add(usage.output_tokens),
        AgentEvent::Subagent { event, .. } => observed_spend(event),
        _ => 0,
    }
}

/// Saturating accumulation shared by the host's event sink and finalizer.
pub fn record_observed_spend(total: &AtomicU64, event: &AgentEvent) {
    let delta = observed_spend(event);
    // compare_exchange_weak keeps saturation atomic on the declared MSRV;
    // try_update is newer and fetch_update is deprecated by current stable.
    let mut previous = total.load(Ordering::SeqCst);
    while let Err(actual) = total.compare_exchange_weak(
        previous,
        previous.saturating_add(delta),
        Ordering::SeqCst,
        Ordering::SeqCst,
    ) {
        previous = actual;
    }
}

/// One run finalizer owns this call. Save known spend before transcript I/O;
/// drain it only after the summary succeeds so a transcript retry cannot charge
/// the same deltas again. New events arriving after the snapshot remain pending.
///
/// Summary and transcript writes remain separate transactions. This function
/// does not provide a crash-atomic usage/transcript commit or fence late events.
pub fn persist_run_snapshot(
    store: &HarnessStore,
    id: &str,
    history: &[Message],
    rules: Vec<PermissionRule>,
    run_tokens: &AtomicU64,
) -> NativeResult<()> {
    let spent = run_tokens.load(Ordering::SeqCst);
    store
        .update_summary(id, |summary| {
            summary.rules = rules;
            summary.tokens_used = summary.tokens_used.saturating_add(spent);
        })
        .map_err(|error| {
            NativeError::retryable(
                "harness_storage_failed",
                format!("Observed run spend could not be saved; keep the event journal for recovery: {error}"),
            )
        })?;
    let mut previous = run_tokens.load(Ordering::SeqCst);
    while let Err(actual) = run_tokens.compare_exchange_weak(
        previous,
        previous.saturating_sub(spent),
        Ordering::SeqCst,
        Ordering::SeqCst,
    ) {
        previous = actual;
    }
    store.write_messages(id, history, 0).map_err(|error| {
        NativeError::retryable(
            "harness_storage_failed",
            format!("Observed run spend was saved, but the conversation snapshot could not be saved: {error}"),
        )
    })
}

/// Inputs already selected and authorized by the host.
///
/// This is not an admission token or a serialized command. The host must supply
/// the same admitted session, history, policy and event-accounting state. The
/// event sink owns usage accumulation, plan observations and journal failure
/// cancellation; this executor consumes those observations at finalization.
pub struct PreparedRunExecution<'a> {
    pub store: &'a HarnessStore,
    pub session_id: &'a str,
    pub agent: Agent,
    pub ctx: ToolContext,
    pub history: &'a mut Vec<Message>,
    pub content: Vec<Block>,
    pub prompt_text: &'a str,
    pub checkpoint_dir: &'a Path,
    pub base_rules: &'a AtomicUsize,
    pub run_tokens: &'a AtomicU64,
    pub plan_presented: &'a AtomicBool,
    pub persistence_error: &'a Mutex<Option<String>>,
}

fn report_hook(events: &dyn EventSink, event: HookEvent, messages: &[String]) {
    for message in messages {
        events.emit(AgentEvent::HookMessage {
            event: event.as_str().to_owned(),
            message: message.clone(),
        });
    }
}

/// Execute the existing prepared Agent and return an unpublished terminal event.
///
/// User content is persisted before the agent runs. Ordinary provider failures
/// and cancellation still save the resulting transcript and known spend before
/// returning failed/interrupted terminal JSON. Preparation, hook, checkpoint or
/// persistence errors return `Err`; the host retains terminal reporting and
/// cleanup. Dropping or panicking this future is not a crash-recovery guarantee.
pub async fn execute_prepared_run(input: PreparedRunExecution<'_>) -> NativeResult<Value> {
    let PreparedRunExecution {
        store,
        session_id,
        agent,
        mut ctx,
        history,
        mut content,
        prompt_text,
        checkpoint_dir,
        base_rules,
        run_tokens,
        plan_presented,
        persistence_error,
    } = input;

    // The user message of this turn will sit at index history.len().
    let checkpoints = CheckpointStore::open(checkpoint_dir).map_err(|error| {
        NativeError::new(
            "checkpoint_store_failed",
            format!("Cannot open file checkpoints: {error}"),
        )
    })?;
    let first_message = history.is_empty();
    let keep = history.len().saturating_sub(1);

    if let Some(hooks) = &agent.hooks {
        if first_message {
            let outcome = hooks
                .run(
                    HookEvent::SessionStart,
                    json!({"source": "startup"}),
                    &ctx.cwd,
                    &ctx.cancel,
                )
                .await;
            report_hook(&*agent.events, HookEvent::SessionStart, &outcome.messages);
            content.extend(outcome.additional_context.into_iter().map(Block::text));
        }
        let outcome = hooks
            .run(
                HookEvent::UserPromptSubmit,
                json!({"prompt": prompt_text}),
                &ctx.cwd,
                &ctx.cancel,
            )
            .await;
        report_hook(
            &*agent.events,
            HookEvent::UserPromptSubmit,
            &outcome.messages,
        );
        if let Some(reason) = outcome.block {
            return Err(NativeError::new(
                "prompt_hook_blocked",
                format!("Prompt blocked by a UserPromptSubmit hook: {reason}"),
            ));
        }
        content.extend(outcome.additional_context.into_iter().map(Block::text));
    }

    omnia_harness::agent::push_user(history, content);
    store.write_messages(session_id, history, keep)?;
    let checkpoint_scope = CheckpointScope::begin(
        Arc::new(checkpoints),
        history,
        history.len().saturating_sub(1),
    )
    .map_err(|error| {
        NativeError::new(
            "checkpoint_store_failed",
            format!("Cannot establish file checkpoint boundary: {error}"),
        )
    })?;
    if let Some(message) = checkpoint_scope.recovery_note() {
        // A preservation notice is nonfatal; ambiguous historical file
        // restoration remains explicitly blocked.
        agent.events.emit(AgentEvent::Error { message });
    }
    ctx.checkpoint = Some(checkpoint_scope);

    let result = agent.run(history, &ctx).await;
    // A presented plan already sent plan_ready; interrupting is not news.
    if let Some(hooks) = &agent.hooks {
        let (kind, message, extra) = match &result {
            Ok(outcome) if !plan_presented.load(Ordering::SeqCst) => (
                "run_completed",
                "Omnia finished the run".to_owned(),
                json!({"status": "completed", "stop_reason": outcome.stop, "turns": outcome.turns}),
            ),
            Err(HarnessError::Cancelled) | Ok(_) => ("", String::new(), Value::Null),
            Err(error) => (
                "run_failed",
                format!("Omnia's run failed: {error}"),
                json!({"status": "failed", "error": error.to_string()}),
            ),
        };
        if !kind.is_empty() {
            // fire_notification spawns the hook itself. Preserve the host's
            // five-second wait; timeout does not claim the task was joined.
            let handle = omnia_harness::hooks::fire_notification(
                Arc::clone(hooks),
                kind,
                message,
                extra,
                ctx.cwd.clone(),
                ctx.cancel.clone(),
            );
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), handle).await;
        }
    }

    // Compaction may rewrite prior messages. Merge only run-owned metadata,
    // never overwrite a concurrent title/model/provider update.
    let rules = {
        let base = base_rules.load(Ordering::SeqCst);
        agent
            .policy
            .lock()
            .await
            .rules
            .iter()
            .skip(base)
            .cloned()
            .collect::<Vec<_>>()
    };
    persist_run_snapshot(store, session_id, history, rules, run_tokens)?;
    if let Some(error) = persistence_error
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
    {
        return Err(NativeError::new("harness_storage_failed", error));
    }
    Ok(match result {
        Ok(outcome) => {
            json!({"type": "run_finished", "status": "completed", "outcome": outcome})
        }
        Err(HarnessError::Cancelled) => {
            json!({"type": "run_finished", "status": "interrupted"})
        }
        Err(error) => {
            json!({"type": "run_finished", "status": "failed", "message": error.to_string()})
        }
    })
}
