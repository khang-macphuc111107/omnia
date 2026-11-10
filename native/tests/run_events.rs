//! Shared event processing with the real SQLite journal, without a UI runtime.
use std::{cell::Cell, sync::Arc};

use omnia_harness::{
    agent::{AgentEvent, ApprovalRequest},
    CancellationToken,
};
use omnia_native::sessions::Sessions;
use omnia_session_store::{
    event_publisher::publish_event,
    run_events::{publish_run_event, RunEventState},
    HarnessStore,
};
use serde_json::json;

#[test]
fn native_event_is_committed_before_notification_and_replays_after_reopen() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("events.sqlite3");
    let store = Arc::new(HarnessStore::open(&database).unwrap());
    let sessions = Sessions::from_shared(Arc::clone(&store));
    let session = sessions.create("Native events").unwrap();
    let state = RunEventState::default();
    let cancel = CancellationToken::new();
    let notified = Cell::new(false);
    let event = AgentEvent::PlanPresented {
        id: "plan".into(),
        plan: "Inspect, implement, verify".into(),
    };
    assert!(publish_run_event(
        &event,
        &state,
        &cancel,
        |_| panic!("non-approval events do not consult approval readiness"),
        |value| {
            publish_event(&store, &session.id, value, |published| {
                let replay = store.replay(&session.id).unwrap();
                assert_eq!(replay.event_cursor, published.sequence);
                assert_eq!(replay.events.last().unwrap().event, published.event);
                assert!(state.persistence_error.try_lock().is_ok());
                notified.set(true);
                false // A disconnected UI can recover from the journal.
            })?;
            Ok(())
        },
    )
    .unwrap());
    assert!(notified.get());
    assert!(!cancel.is_cancelled());
    drop(sessions);
    drop(store);
    let reopened = HarnessStore::open(&database).unwrap();
    let replay = reopened.replay(&session.id).unwrap();
    assert_eq!(replay.events.len(), 1);
    assert_eq!(replay.events[0].event["type"], "plan_presented");
}

#[test]
fn native_journal_rejection_cancels_without_notifying_or_creating_an_event() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("events.sqlite3");
    let store = HarnessStore::open(&database).unwrap();
    let state = RunEventState::default();
    let cancel = CancellationToken::new();
    let notified = Cell::new(false);
    let error = publish_run_event(
        &AgentEvent::TurnStarted { turn: 1 },
        &state,
        &cancel,
        |_| true,
        |value| {
            // A genuine SQLite foreign-key rejection, not an injected flag.
            publish_event(&store, "missing-session", value, |_| {
                notified.set(true);
                true
            })?;
            Ok(())
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "harness_storage_failed");
    assert!(cancel.is_cancelled());
    assert!(!notified.get());
    assert_eq!(
        state.persistence_error.lock().unwrap().as_deref(),
        Some(error.to_string().as_str())
    );
    drop(store);
    let reopened = HarnessStore::open(&database).unwrap();
    // replay intentionally returns an idle empty projection for absent IDs;
    // summary establishes absence while replay proves no event survived.
    assert!(reopened.summary("missing-session").is_err());
    let replay = reopened.replay("missing-session").unwrap();
    assert_eq!(replay.status, "idle");
    assert!(replay.events.is_empty());
    assert_eq!(replay.event_cursor, 0);
}

#[test]
fn native_nested_approval_is_published_only_after_sender_readiness() {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(HarnessStore::open(&root.path().join("events.sqlite3")).unwrap());
    let sessions = Sessions::from_shared(Arc::clone(&store));
    let session = sessions.create("Approval publication").unwrap();
    let state = RunEventState::default();
    let cancel = CancellationToken::new();
    let event = AgentEvent::Subagent {
        parent_id: "child".into(),
        event: Box::new(AgentEvent::ApprovalRequested {
            request: ApprovalRequest {
                tool_use_id: "approval".into(),
                tool: "fixture".into(),
                input: json!({}),
                summary: "Readiness fixture only; no tool invocation".into(),
                ordinal: 1,
                total: 1,
                remaining: vec![],
            },
        }),
    };
    let ready = Cell::new(false);
    let publish = |value| {
        publish_event(&store, &session.id, value, |_| true)?;
        Ok(())
    };
    let readiness = |id: &str| {
        assert_eq!(id, "approval");
        ready.get()
    };
    assert!(!publish_run_event(&event, &state, &cancel, readiness, publish).unwrap());
    assert!(store.replay(&session.id).unwrap().events.is_empty());
    ready.set(true);
    assert!(publish_run_event(&event, &state, &cancel, readiness, publish).unwrap());
    assert_eq!(store.replay(&session.id).unwrap().events.len(), 1);
    assert!(!cancel.is_cancelled());
}
