//! Shared, transport-independent ownership of session admission and lifecycle
//! serialization. Hosts share one `Arc<RunCoordinator<T>>`; opening a second
//! recovering store is neither required nor allowed by this API.
//!
//! Admission reserves volatile state after reading the canonical snapshot and
//! rejecting ambiguous effects. It does not dispatch a provider, append a run
//! event, authorize tools, or fence late journal writes/external effects.

use std::sync::{Arc, Mutex, MutexGuard};

use omnia_harness::Message;
use serde_json::Value;

use crate::{
    error::{NativeError, NativeResult},
    harness_store::HarnessStore,
    run_registry::{RunRegistry, RunTicket},
};

/// Safe conversation snapshot and the identity of its volatile reservation.
/// Provider construction/startup belongs to the host. On startup failure the
/// host must remove only this ticket, not whichever run now has the session ID.
pub struct RunAdmission {
    pub history: Vec<Message>,
    pub ticket: RunTicket,
}

/// One canonical store, active-run registry, and lifecycle serialization lock.
///
/// `from_store` consumes a uniquely owned store. Native views may clone the
/// exposed store `Arc` for metadata, but execution hosts must share this
/// coordinator rather than construct independent registries for one store.
pub struct RunCoordinator<T> {
    store: Arc<HarnessStore>,
    runs: Arc<RunRegistry<T>>,
    lifecycle: Mutex<()>,
}

impl<T> RunCoordinator<T> {
    pub fn from_store(store: HarnessStore) -> Self {
        Self {
            store: Arc::new(store),
            runs: Arc::new(RunRegistry::default()),
            lifecycle: Mutex::new(()),
        }
    }

    pub fn store(&self) -> &Arc<HarnessStore> {
        &self.store
    }

    pub fn runs(&self) -> &Arc<RunRegistry<T>> {
        &self.runs
    }

    /// Serialize rewind/deletion/import and admission using this same lock.
    /// Never hold this guard across an await or call `admit` while holding it.
    /// A poison error cannot establish a safe lifecycle boundary.
    pub fn lock_lifecycle(&self) -> NativeResult<MutexGuard<'_, ()>> {
        self.lifecycle
            .lock()
            .map_err(|_| NativeError::new("agent_lock_failed", "Lifecycle lock poisoned"))
    }

    /// Read the canonical snapshot, reject a live reservation or ambiguous
    /// journal, then reserve while the lifecycle lock is still held.
    ///
    /// This preserves desktop admission ordering: snapshot errors precede
    /// duplicate errors, and duplicate errors precede ambiguous-effect errors.
    /// Rejected admission never creates a reservation or mutates the journal.
    pub fn admit(&self, id: &str, run: Arc<T>) -> NativeResult<RunAdmission> {
        let _lifecycle = self.lock_lifecycle()?;
        let (_, history, replay) = self.store.read_snapshot(id)?;
        if self.runs.contains_key(id)? {
            return Err(NativeError::new(
                "agent_run_active",
                "The agent is already working; steer it or interrupt it first",
            ));
        }
        let uncheckpointed_effects = replay
            .events
            .iter()
            .any(|event| has_tool_start(&event.event));
        // A completed effect can remain in the journal without its resulting
        // transcript. Sending the old transcript may invite duplicate effects;
        // explicit reconciliation/fork is still required.
        if !replay.unknown_side_effects.is_empty() || uncheckpointed_effects {
            return Err(NativeError::new(
                "unknown_side_effects",
                "Inspect the interrupted tool journal and explicitly fork after reconciling effects; no tool is automatically replayed",
            ));
        }
        // Keep the caller's Arc until after `_lifecycle` drops. A failed
        // reservation must not run a reentrant T destructor under this lock.
        let ticket = self.runs.reserve(id, Arc::clone(&run))?;
        Ok(RunAdmission { history, ticket })
    }
}

fn has_tool_start(event: &Value) -> bool {
    matches!(
        event.get("type").and_then(Value::as_str),
        Some("tool_started" | "run_started")
    ) || event.get("event").is_some_and(has_tool_start)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness_store::{AgentSessionSummary, SessionScope};
    use omnia_harness::{permission::PermissionMode, Block, Role};
    use serde_json::json;
    use std::{path::PathBuf, sync::Barrier};

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("omnia-run-coordinator-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self { root }
        }

        fn database(&self) -> PathBuf {
            self.root.join("sessions.sqlite3")
        }

        fn coordinator<T>(&self) -> RunCoordinator<T> {
            RunCoordinator::from_store(HarnessStore::open(&self.database()).unwrap())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // Tests declare all store owners after this fixture. Preserve
            // unexpected files instead of deleting a recursive directory tree.
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

    fn seed(store: &HarnessStore, id: &str) {
        store
            .save_summary(&AgentSessionSummary {
                id: id.to_owned(),
                title: "Coordinator fixture".to_owned(),
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

    fn message(text: &str) -> Message {
        Message {
            role: Role::User,
            content: vec![Block::text(text)],
        }
    }

    #[test]
    fn safe_persisted_history_is_returned_without_starting_or_mutating_a_run() {
        let fixture = Fixture::new();
        let coordinator = fixture.coordinator();
        seed(coordinator.store(), "session");
        let history = vec![message("existing transcript")];
        coordinator
            .store()
            .write_messages("session", &history, 0)
            .unwrap();
        let before = coordinator.store().replay("session").unwrap();
        let admitted = coordinator.admit("session", Arc::new(7)).unwrap();
        assert_eq!(
            serde_json::to_value(admitted.history).unwrap(),
            serde_json::to_value(history).unwrap()
        );
        assert_eq!(admitted.ticket.session_id(), "session");
        assert_eq!(*coordinator.runs().get("session").unwrap().unwrap(), 7);
        let after = coordinator.store().replay("session").unwrap();
        assert_eq!(before.event_cursor, after.event_cursor);
        assert_eq!(before.status, after.status);
        assert!(after.events.is_empty());
        assert!(coordinator.runs().remove_current(&admitted.ticket).unwrap());
        assert!(coordinator.lock_lifecycle().is_ok());
    }

    #[test]
    fn snapshot_failure_precedes_duplicate_and_creates_no_new_reservation() {
        let fixture = Fixture::new();
        let coordinator = fixture.coordinator();
        assert!(coordinator.admit("missing", Arc::new(1)).is_err());
        assert!(coordinator.runs().is_empty().unwrap());
        let ticket = coordinator.runs().reserve("missing", Arc::new(2)).unwrap();
        let expected = coordinator.store().read_snapshot("missing").err().unwrap();
        let actual = coordinator.admit("missing", Arc::new(3)).err().unwrap();
        assert_eq!(actual.code, expected.code);
        assert_ne!(actual.code, "agent_run_active");
        assert_eq!(*coordinator.runs().get("missing").unwrap().unwrap(), 2);
        assert!(coordinator.runs().remove_current(&ticket).unwrap());
    }

    #[test]
    fn duplicate_precedes_ambiguous_journal_and_preserves_current_state() {
        let fixture = Fixture::new();
        let coordinator = fixture.coordinator();
        seed(coordinator.store(), "session");
        let admitted = coordinator.admit("session", Arc::new(1)).unwrap();
        coordinator
            .store()
            .append_event("session", &json!({"type":"run_started","runId":"fixture"}))
            .unwrap();
        let error = coordinator.admit("session", Arc::new(2)).err().unwrap();
        assert_eq!(error.code, "agent_run_active");
        assert_eq!(*coordinator.runs().get("session").unwrap().unwrap(), 1);
        assert!(coordinator.runs().remove_current(&admitted.ticket).unwrap());
        assert_eq!(
            coordinator
                .admit("session", Arc::new(3))
                .err()
                .unwrap()
                .code,
            "unknown_side_effects"
        );
        assert!(coordinator.runs().is_empty().unwrap());
    }

    #[test]
    fn ambiguous_and_nested_uncheckpointed_effects_are_rejected_without_writes() {
        let fixture = Fixture::new();
        let coordinator = fixture.coordinator();
        let events = [
            json!({"type":"run_started","runId":"fixture"}),
            json!({"type":"tool_started","id":"unresolved"}),
            json!({"type":"subagent","parent_id":"outer","event":{"type":"subagent","parent_id":"inner","event":{"type":"tool_started","id":"nested"}}}),
            // Preserve the legacy predicate: an event payload is inspected
            // recursively even when the outer type is not "subagent".
            json!({"type":"wrapper","event":{"type":"run_started"}}),
        ];
        for (index, event) in events.iter().enumerate() {
            let id = format!("session-{index}");
            seed(coordinator.store(), &id);
            coordinator.store().append_event(&id, event).unwrap();
            let before = coordinator.store().replay(&id).unwrap();
            let error = coordinator.admit(&id, Arc::new(index)).err().unwrap();
            assert_eq!(error.code, "unknown_side_effects");
            assert_eq!(error.message, "Inspect the interrupted tool journal and explicitly fork after reconciling effects; no tool is automatically replayed");
            assert!(!error.retryable);
            let after = coordinator.store().replay(&id).unwrap();
            assert_eq!(before.event_cursor, after.event_cursor);
            assert_eq!(before.events.len(), after.events.len());
            assert_eq!(before.status, after.status);
            assert!(coordinator.runs().is_empty().unwrap());
        }
    }

    #[test]
    fn checkpoint_does_not_hide_an_unresolved_effect() {
        let fixture = Fixture::new();
        let coordinator = fixture.coordinator();
        seed(coordinator.store(), "session");
        // A transcript checkpoint updates the projection established by the
        // run-start boundary. Tool-only synthetic journals have no such row.
        coordinator
            .store()
            .append_event("session", &json!({"type":"run_started","runId":"fixture"}))
            .unwrap();
        coordinator
            .store()
            .append_event("session", &json!({"type":"tool_started","id":"unknown"}))
            .unwrap();
        coordinator
            .store()
            .write_messages("session", &[], 0)
            .unwrap();
        let replay = coordinator.store().replay("session").unwrap();
        assert!(replay.events.is_empty());
        assert_eq!(replay.unknown_side_effects, ["unknown"]);
        assert_eq!(
            coordinator
                .admit("session", Arc::new(()))
                .err()
                .unwrap()
                .code,
            "unknown_side_effects"
        );
        assert!(coordinator.runs().is_empty().unwrap());
    }

    #[test]
    fn checkpointed_completed_effects_allow_admission_but_stale_cleanup_cannot_remove_successor() {
        let fixture = Fixture::new();
        let coordinator = fixture.coordinator();
        seed(coordinator.store(), "session");
        coordinator
            .store()
            .append_event("session", &json!({"type":"run_started","runId":"fixture"}))
            .unwrap();
        coordinator
            .store()
            .append_event("session", &json!({"type":"tool_started","id":"finished"}))
            .unwrap();
        coordinator
            .store()
            .append_event("session", &json!({"type":"tool_completed","id":"finished"}))
            .unwrap();
        // Completion alone does not prove that its transcript was persisted.
        assert_eq!(
            coordinator
                .admit("session", Arc::new(0))
                .err()
                .unwrap()
                .code,
            "unknown_side_effects"
        );
        coordinator
            .store()
            .write_messages("session", &[message("effect reconciled in transcript")], 0)
            .unwrap();
        let old = coordinator.admit("session", Arc::new(1)).unwrap();
        coordinator.runs().retire("session").unwrap();
        let current = coordinator.admit("session", Arc::new(2)).unwrap();
        assert!(!coordinator.runs().remove_current(&old.ticket).unwrap());
        assert_eq!(*coordinator.runs().get("session").unwrap().unwrap(), 2);
        assert!(coordinator.runs().remove_current(&current.ticket).unwrap());
    }

    #[test]
    fn shared_coordinator_serializes_eight_admissions_with_one_winner() {
        let fixture = Fixture::new();
        let coordinator = Arc::new(fixture.coordinator());
        seed(coordinator.store(), "session");
        let barrier = Arc::new(Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|value| {
                let coordinator = Arc::clone(&coordinator);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    coordinator.admit("session", Arc::new(value))
                })
            })
            .collect();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .filter(|error| error.code == "agent_run_active")
                .count(),
            7
        );
        let admitted = results.into_iter().find_map(Result::ok).unwrap();
        assert_eq!(coordinator.runs().snapshot().unwrap().len(), 1);
        assert!(coordinator.runs().remove_current(&admitted.ticket).unwrap());
    }

    #[test]
    fn lifecycle_poison_fails_closed_without_reserving_or_changing_journal() {
        let fixture = Fixture::new();
        let coordinator = fixture.coordinator();
        seed(coordinator.store(), "session");
        let before = coordinator.store().replay("session").unwrap();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = coordinator.lock_lifecycle().unwrap();
            panic!("fixture poison");
        }));
        assert_eq!(
            coordinator.lock_lifecycle().err().unwrap().code,
            "agent_lock_failed"
        );
        assert_eq!(
            coordinator
                .admit("session", Arc::new(()))
                .err()
                .unwrap()
                .code,
            "agent_lock_failed"
        );
        assert!(coordinator.runs().is_empty().unwrap());
        let after = coordinator.store().replay("session").unwrap();
        assert_eq!(before.event_cursor, after.event_cursor);
        assert_eq!(before.status, after.status);
    }

    #[test]
    fn metadata_arc_shares_owner_without_reopening_or_recovering_live_store() {
        let fixture = Fixture::new();
        let coordinator = fixture.coordinator::<()>();
        seed(coordinator.store(), "session");
        coordinator
            .store()
            .append_event("session", &json!({"type":"run_started","runId":"fixture"}))
            .unwrap();
        let metadata = Arc::clone(coordinator.store());
        assert!(Arc::ptr_eq(coordinator.store(), &metadata));
        assert_eq!(metadata.replay("session").unwrap().status, "running");
        assert_eq!(
            HarnessStore::open(&fixture.database()).err().unwrap().code,
            "harness_store_busy"
        );
        // A pure observer retains the same kernel ownership after the
        // coordinator drops. No startup recovery occurred while it was live.
        drop(coordinator);
        assert_eq!(metadata.replay("session").unwrap().status, "running");
        assert_eq!(
            HarnessStore::open(&fixture.database()).err().unwrap().code,
            "harness_store_busy"
        );
        drop(metadata);
        let reopened = HarnessStore::open(&fixture.database()).unwrap();
        assert_eq!(reopened.replay("session").unwrap().status, "interrupted");
        assert_eq!(reopened.replay("session").unwrap().events.len(), 1);
    }

    struct DropProbe {
        owner: std::sync::Weak<RunCoordinator<DropProbe>>,
        outside_lifecycle: Arc<std::sync::atomic::AtomicBool>,
    }

    impl Drop for DropProbe {
        fn drop(&mut self) {
            if let Some(owner) = self.owner.upgrade() {
                self.outside_lifecycle.store(
                    owner.lifecycle.try_lock().is_ok(),
                    std::sync::atomic::Ordering::SeqCst,
                );
            }
        }
    }

    #[test]
    fn rejected_state_drops_after_lifecycle_unlock_for_capacity_and_poison() {
        use std::sync::atomic::{AtomicBool, Ordering};
        for poisoned in [false, true] {
            let fixture = Fixture::new();
            let coordinator = Arc::new(fixture.coordinator::<DropProbe>());
            seed(coordinator.store(), "session");
            if poisoned {
                coordinator.runs().poison_for_test();
            } else {
                // Fill the default bounded registry without dispatch or
                // synthetic lifecycle writes; only the target needs a snapshot.
                for index in 0..64 {
                    coordinator
                        .runs()
                        .reserve(
                            &format!("occupied-{index}"),
                            Arc::new(DropProbe {
                                owner: Arc::downgrade(&coordinator),
                                outside_lifecycle: Arc::new(AtomicBool::new(false)),
                            }),
                        )
                        .unwrap();
                }
            }
            let dropped = Arc::new(AtomicBool::new(false));
            let error = coordinator
                .admit(
                    "session",
                    Arc::new(DropProbe {
                        owner: Arc::downgrade(&coordinator),
                        outside_lifecycle: Arc::clone(&dropped),
                    }),
                )
                .err()
                .unwrap();
            assert_eq!(
                error.code,
                if poisoned {
                    "agent_lock_failed"
                } else {
                    "agent_run_capacity"
                }
            );
            assert!(dropped.load(Ordering::SeqCst));
        }
    }
}
