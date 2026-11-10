//! Shared run-event accounting and publication policy.
//!
//! Hosts retain the actual journal/notifier, retry/fallback request-log counters,
//! terminal publication and cleanup. This module creates no queue, runtime or
//! store. A successful publisher callback is a host observation, not proof of
//! durable publication or an external effect unless that callback establishes it.

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};

use omnia_harness::{agent::AgentEvent, CancellationToken};
use serde_json::Value;

use crate::{
    error::{NativeError, NativeResult},
    run_execution::record_observed_spend,
};

/// Observations shared by the event sink and the existing run finalizer.
///
/// These are process-local observations, not durable run authority. The host
/// must use the same state for a run's sink and finalization. A later publisher
/// error replaces the earlier diagnostic, preserving the compatibility host's
/// behavior rather than inventing first-error or aggregate-error semantics.
#[derive(Default)]
pub struct RunEventState {
    pub run_tokens: AtomicU64,
    pub plan_presented: AtomicBool,
    pub persistence_error: Mutex<Option<String>>,
}

fn approval_id(event: &AgentEvent) -> Option<&str> {
    match event {
        AgentEvent::ApprovalRequested { request } => Some(&request.tool_use_id),
        AgentEvent::Subagent { event, .. } => approval_id(event),
        _ => None,
    }
}

/// Account an event, filter premature approval announcements, then publish it.
///
/// Usage is recorded before publication, including usage inside subagent events.
/// Only a direct `PlanPresented` sets the run's plan flag, matching the existing
/// host semantics; a child's plan does not silently become its parent's plan.
/// The approval readiness callback must establish that its answer channel exists
/// before exposing the actionable event. It is called only for approval events.
///
/// Returns `Ok(false)` when an approval announcement was filtered and `Ok(true)`
/// when encoding and the publisher callback succeeded. On an encoding/publisher
/// error, request cancellation and retain its display diagnostic before returning
/// the original error. Neither callback runs under the diagnostic mutex. Callback
/// panics propagate as before; this API does not add panic cleanup, effect fencing,
/// notification retry, queue bounds or late-event suppression.
pub fn publish_run_event(
    event: &AgentEvent,
    state: &RunEventState,
    cancel: &CancellationToken,
    approval_ready: impl FnOnce(&str) -> bool,
    publish: impl FnOnce(Value) -> NativeResult<()>,
) -> NativeResult<bool> {
    if matches!(event, AgentEvent::PlanPresented { .. }) {
        state.plan_presented.store(true, Ordering::SeqCst);
    }
    record_observed_spend(&state.run_tokens, event);

    if let Some(id) = approval_id(event) {
        if !approval_ready(id) {
            return Ok(false);
        }
    }
    let result = serde_json::to_value(event)
        .map_err(|error| NativeError::new("event_encoding_failed", error.to_string()))
        .and_then(publish);
    if let Err(error) = result {
        cancel.cancel();
        *state
            .persistence_error
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(error.to_string());
        return Err(error);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use omnia_harness::{agent::ApprovalRequest, StopReason, StreamEvent, Usage};
    use serde_json::json;
    use std::{cell::Cell, panic::AssertUnwindSafe};

    fn child(event: AgentEvent) -> AgentEvent {
        AgentEvent::Subagent {
            parent_id: "parent-task".to_owned(),
            event: Box::new(event),
        }
    }

    fn usage(input_tokens: u64, output_tokens: u64) -> AgentEvent {
        AgentEvent::Stream {
            event: StreamEvent::Usage {
                usage: Usage {
                    input_tokens,
                    output_tokens,
                    ..Usage::default()
                },
            },
        }
    }

    fn approval() -> AgentEvent {
        AgentEvent::ApprovalRequested {
            request: ApprovalRequest {
                tool_use_id: "approval-1".to_owned(),
                tool: "read".to_owned(),
                input: json!({"path":"fixture.txt"}),
                summary: "Read a fixture".to_owned(),
                ordinal: 1,
                total: 1,
                remaining: Vec::new(),
            },
        }
    }

    #[test]
    fn accounts_nested_usage_before_publishing_without_charging_completion() {
        let state = RunEventState::default();
        let cancel = CancellationToken::new();
        let published = Cell::new(0);
        for event in [
            usage(3, 2),
            child(child(usage(7, 11))),
            AgentEvent::TurnCompleted {
                turn: 1,
                usage: Usage {
                    input_tokens: 10,
                    output_tokens: 13,
                    ..Usage::default()
                },
                stop: StopReason::EndTurn,
                duration_ms: None,
                ttft_ms: None,
            },
        ] {
            assert!(publish_run_event(
                &event,
                &state,
                &cancel,
                |_| panic!("ordinary events must not query approval readiness"),
                |value| {
                    published.set(published.get() + 1);
                    assert!(value.is_object());
                    if published.get() == 1 {
                        assert_eq!(state.run_tokens.load(Ordering::SeqCst), 5);
                    } else {
                        assert_eq!(state.run_tokens.load(Ordering::SeqCst), 23);
                    }
                    Ok(())
                },
            )
            .unwrap());
        }
        assert_eq!(published.get(), 3);
        assert_eq!(state.run_tokens.load(Ordering::SeqCst), 23);
        assert!(!cancel.is_cancelled());
        assert!(state.persistence_error.lock().unwrap().is_none());
    }

    #[test]
    fn direct_plan_is_observed_before_publish_but_child_plan_is_not_parent_plan() {
        let state = RunEventState::default();
        let cancel = CancellationToken::new();
        let plan = AgentEvent::PlanPresented {
            id: "plan-1".to_owned(),
            plan: "Inspect and implement".to_owned(),
        };
        publish_run_event(&child(plan.clone()), &state, &cancel, |_| true, |_| Ok(())).unwrap();
        assert!(!state.plan_presented.load(Ordering::SeqCst));
        publish_run_event(
            &plan,
            &state,
            &cancel,
            |_| true,
            |value| {
                assert!(state.plan_presented.load(Ordering::SeqCst));
                assert_eq!(value["type"], "plan_presented");
                Ok(())
            },
        )
        .unwrap();
    }

    #[test]
    fn nested_approval_is_filtered_until_answer_channel_is_ready() {
        let state = RunEventState::default();
        let cancel = CancellationToken::new();
        let event = child(child(approval()));
        let ready_queries = Cell::new(0);
        let published = Cell::new(0);
        for ready in [false, true] {
            let receipt = publish_run_event(
                &event,
                &state,
                &cancel,
                |id| {
                    ready_queries.set(ready_queries.get() + 1);
                    assert_eq!(id, "approval-1");
                    ready
                },
                |value| {
                    published.set(published.get() + 1);
                    assert_eq!(
                        value["event"]["event"]["request"]["tool_use_id"],
                        "approval-1"
                    );
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(receipt, ready);
        }
        assert_eq!(ready_queries.get(), 2);
        assert_eq!(published.get(), 1);
        assert!(!cancel.is_cancelled());
        assert!(state.persistence_error.lock().unwrap().is_none());
    }

    #[test]
    fn publisher_failure_keeps_usage_cancels_and_replaces_diagnostic() {
        let state = RunEventState::default();
        let cancel = CancellationToken::new();
        for (code, message, expected_tokens) in [
            ("first_publish_failed", "first fixture failure", 5),
            ("second_publish_failed", "second fixture failure", 10),
        ] {
            let error = publish_run_event(
                &usage(3, 2),
                &state,
                &cancel,
                |_| true,
                |_| Err(NativeError::new(code, message)),
            )
            .unwrap_err();
            assert_eq!(error.code, code);
            assert!(cancel.is_cancelled());
            assert_eq!(state.run_tokens.load(Ordering::SeqCst), expected_tokens);
            assert_eq!(
                state.persistence_error.lock().unwrap().as_deref(),
                Some(error.to_string().as_str())
            );
        }
    }

    #[test]
    fn poisoned_diagnostic_mutex_still_records_publisher_failure() {
        let state = RunEventState::default();
        let poisoned = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _guard = state.persistence_error.lock().unwrap();
            panic!("poison fixture");
        }));
        assert!(poisoned.is_err());
        let cancel = CancellationToken::new();
        let error = publish_run_event(
            &AgentEvent::TurnStarted { turn: 1 },
            &state,
            &cancel,
            |_| true,
            |_| {
                Err(NativeError::new(
                    "fixture_failure",
                    "poison recovery fixture",
                ))
            },
        )
        .unwrap_err();
        assert!(cancel.is_cancelled());
        assert_eq!(
            state
                .persistence_error
                .lock()
                .unwrap_err()
                .into_inner()
                .as_deref(),
            Some(error.to_string().as_str())
        );
    }

    #[test]
    fn callbacks_can_lock_state_and_reenter_publication() {
        let state = RunEventState::default();
        let cancel = CancellationToken::new();
        let nested_published = Cell::new(false);
        publish_run_event(
            &approval(),
            &state,
            &cancel,
            |_| {
                assert!(state.persistence_error.try_lock().is_ok());
                true
            },
            |_| {
                assert!(state.persistence_error.try_lock().is_ok());
                publish_run_event(
                    &usage(1, 2),
                    &state,
                    &cancel,
                    |_| true,
                    |_| {
                        nested_published.set(true);
                        Ok(())
                    },
                )?;
                Ok(())
            },
        )
        .unwrap();
        assert!(nested_published.get());
        assert_eq!(state.run_tokens.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn usage_accumulation_saturates() {
        let state = RunEventState::default();
        state.run_tokens.store(u64::MAX - 1, Ordering::SeqCst);
        publish_run_event(
            &usage(u64::MAX, u64::MAX),
            &state,
            &CancellationToken::new(),
            |_| true,
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(state.run_tokens.load(Ordering::SeqCst), u64::MAX);
    }
}
