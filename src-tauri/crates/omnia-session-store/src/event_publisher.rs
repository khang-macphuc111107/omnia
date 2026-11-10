//! Journal-first event publication shared by native and compatibility hosts.
//!
//! The notification is advisory: consumers recover missed notifications by
//! replaying the durable journal. This module owns no queue, thread, executor,
//! or UI framework. Hosts must bound callback work and notification buffers.

use serde::Serialize;
use serde_json::Value;

use crate::{error::NativeResult, harness_store::HarnessStore};

/// An event whose journal transaction committed before notification began.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedEvent {
    pub session_id: String,
    pub sequence: i64,
    pub event: Value,
}

/// Local publication observations, not proof of consumer processing or a
/// provider/tool operation completing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PublicationReceipt {
    pub sequence: i64,
    pub notification_delivered: bool,
}

/// Commit an event, release the store lock, then invoke the notifier once.
///
/// A journal failure returns before invoking `notify`. A notifier returning
/// `false` leaves the journal intact and returns its committed sequence, so a
/// disconnected or saturated consumer can replay later. The host decides what
/// its boolean delivery observation establishes; it never establishes that a
/// consumer applied the event or that an external effect completed.
///
/// Callbacks may reenter the store because `append_event` returns only after
/// releasing its transaction and mutex guard. A callback panic propagates:
/// the event remains committed and no publication receipt is returned. This
/// helper does not retry notification or replay external effects.
pub fn publish_event(
    store: &HarnessStore,
    session_id: &str,
    event: Value,
    notify: impl FnOnce(&PublishedEvent) -> bool,
) -> NativeResult<PublicationReceipt> {
    let sequence = store.append_event(session_id, &event)?;
    let published = PublishedEvent {
        session_id: session_id.to_owned(),
        sequence,
        event,
    };
    let notification_delivered = notify(&published);
    Ok(PublicationReceipt {
        sequence,
        notification_delivered,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness_store::{AgentSessionSummary, SessionScope};
    use omnia_harness::permission::PermissionMode;
    use serde_json::json;
    use std::{cell::Cell, path::PathBuf};

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("omnia-event-publisher-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self { root }
        }

        fn database(&self) -> PathBuf {
            self.root.join("sessions.sqlite3")
        }

        fn open(&self) -> HarnessStore {
            HarnessStore::open(&self.database()).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // Every test declares stores after the fixture, so database handles
            // close before these exact test-owned files are removed. Preserve
            // any unexpected file rather than recursively deleting a tree.
            for name in [
                "sessions.sqlite3",
                "sessions.sqlite3-wal",
                "sessions.sqlite3-shm",
            ] {
                let _ = std::fs::remove_file(self.root.join(name));
            }
            let _ = std::fs::remove_dir(&self.root);
        }
    }

    fn seed(store: &HarnessStore) {
        store
            .save_summary(&AgentSessionSummary {
                id: "session".to_owned(),
                title: "Publisher fixture".to_owned(),
                scope: SessionScope::Projectless,
                cwd: "fixture-owned".to_owned(),
                profile_id: "fixture".to_owned(),
                model: "fixture".to_owned(),
                permission_mode: PermissionMode::AskWrites,
                rules: Vec::new(),
                reasoning_effort: None,
                fallback_models: Vec::new(),
                token_budget: None,
                tokens_used: 0,
                system_prompt: None,
                parent_id: None,
                settings_revision: 1,
                message_count: 0,
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .unwrap();
    }

    #[test]
    fn callback_can_reenter_and_observe_committed_event_and_status() {
        let fixture = Fixture::new();
        let store = fixture.open();
        seed(&store);
        let expected = json!({"type":"run_started","runId":"fixture-run"});
        let calls = Cell::new(0);
        let receipt = publish_event(&store, "session", expected.clone(), |published| {
            calls.set(calls.get() + 1);
            assert_eq!(published.session_id, "session");
            assert_eq!(published.event, expected);
            let replay = store.replay("session").unwrap();
            assert_eq!(replay.status, "running");
            assert_eq!(replay.event_cursor, published.sequence);
            assert_eq!(replay.events.len(), 1);
            assert_eq!(replay.events[0].sequence, published.sequence);
            assert_eq!(replay.events[0].event, expected);
            true
        })
        .unwrap();
        assert_eq!(calls.get(), 1);
        assert!(receipt.notification_delivered);
        assert!(receipt.sequence > 0);
    }

    #[test]
    fn missed_notification_does_not_rollback_and_survives_reopen() {
        let fixture = Fixture::new();
        let store = fixture.open();
        seed(&store);
        let expected = json!({"type":"text_delta","text":"Unicode: tiếng Việt 🦀"});
        let receipt = publish_event(&store, "session", expected.clone(), |_| false).unwrap();
        assert!(!receipt.notification_delivered);
        drop(store);

        let reopened = fixture.open();
        let replay = reopened.replay("session").unwrap();
        assert_eq!(replay.events.len(), 1);
        assert_eq!(replay.events[0].event, expected);
        assert_eq!(replay.events[0].sequence, receipt.sequence);
        assert_eq!(replay.event_cursor, receipt.sequence);
    }

    #[test]
    fn foreign_key_append_failure_never_invokes_notifier() {
        let fixture = Fixture::new();
        let store = fixture.open();
        let called = Cell::new(false);
        let error = publish_event(
            &store,
            "missing-session",
            json!({"type":"text_delta","text":"must not publish"}),
            |_| {
                called.set(true);
                true
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "harness_storage_failed");
        assert!(!called.get());
        let count: i64 = store
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM agent_events", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn lifecycle_write_failure_rolls_back_event_before_notification() {
        let fixture = Fixture::new();
        let store = fixture.open();
        seed(&store);
        store
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER fixture_deny_run_state BEFORE INSERT ON agent_run_state
                 BEGIN SELECT RAISE(ABORT, 'fixture lifecycle failure'); END;",
            )
            .unwrap();
        let called = Cell::new(false);
        assert!(publish_event(
            &store,
            "session",
            json!({"type":"run_started","runId":"must-rollback"}),
            |_| {
                called.set(true);
                true
            },
        )
        .is_err());
        assert!(!called.get());
        let replay = store.replay("session").unwrap();
        assert_eq!(replay.status, "idle");
        assert!(replay.events.is_empty());
        assert_eq!(replay.event_cursor, 0);
        drop(store);
        let reopened = fixture.open();
        assert!(reopened.replay("session").unwrap().events.is_empty());
    }

    #[test]
    fn terminal_lifecycle_commits_even_when_notification_is_unavailable() {
        let fixture = Fixture::new();
        let store = fixture.open();
        seed(&store);
        let started = publish_event(
            &store,
            "session",
            json!({"type":"run_started","runId":"fixture-run"}),
            |_| true,
        )
        .unwrap();
        let terminal = json!({"type":"run_finished","status":"completed"});
        let completed = publish_event(&store, "session", terminal.clone(), |published| {
            let replay = store.replay("session").unwrap();
            assert_eq!(replay.status, "completed");
            assert_eq!(replay.event_cursor, published.sequence);
            false
        })
        .unwrap();
        assert!(!completed.notification_delivered);
        assert!(completed.sequence > started.sequence);
        drop(store);
        let reopened = fixture.open();
        let replay = reopened.replay("session").unwrap();
        assert_eq!(replay.status, "completed");
        assert_eq!(replay.events.last().unwrap().event, terminal);
        assert_eq!(replay.event_cursor, completed.sequence);
    }

    #[test]
    fn notifier_panic_propagates_without_erasing_committed_event() {
        let fixture = Fixture::new();
        let store = fixture.open();
        seed(&store);
        let event = json!({"type":"text_delta","text":"committed before panic"});
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = publish_event(&store, "session", event.clone(), |_| {
                panic!("fixture notifier panic")
            });
        }));
        assert!(result.is_err());
        let replay = store.replay("session").unwrap();
        assert_eq!(replay.events.len(), 1);
        assert_eq!(replay.events[0].event, event);
    }
}
