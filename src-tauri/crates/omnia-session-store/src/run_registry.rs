//! Bounded, process-local reservation of active agent runs.
//!
//! Hosts share this registry and their canonical store. A reservation identifies
//! one registry generation; late cleanup can remove only that reservation, not
//! a successor for the same session. This is volatile coordination, not a
//! durable run journal, actor authorization, effect fence, or task executor.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};

use uuid::Uuid;

use crate::error::{NativeError, NativeResult};

const DEFAULT_CAPACITY: usize = 64;
const MAX_CAPACITY: usize = 4096;
const MAX_SESSION_ID_BYTES: usize = 256;

/// Opaque cleanup identity. Hosts may retain/clone it but cannot manufacture a
/// generation or use a ticket issued by a different registry.
#[derive(Clone)]
pub struct RunTicket {
    registry_id: Uuid,
    generation: u64,
    session_id: String,
}

impl RunTicket {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
}

struct RegistryState<T> {
    last_generation: u64,
    runs: HashMap<String, (RunTicket, Arc<T>)>,
}

/// Owns a bounded set of active state references. Returned references are
/// independent `Arc`s; no registry lock survives a method return or host await.
pub struct RunRegistry<T> {
    registry_id: Uuid,
    capacity: usize,
    state: Mutex<RegistryState<T>>,
}

impl<T> Default for RunRegistry<T> {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }
}

impl<T> RunRegistry<T> {
    /// Crate-private fault injection for coordinator tests. Never available to
    /// production consumers or through the `test-support` feature.
    #[cfg(test)]
    pub(crate) fn poison_for_test(&self) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = self.state.lock().unwrap();
            panic!("fixture registry poison");
        }));
    }

    pub fn new(capacity: usize) -> NativeResult<Self> {
        if !(1..=MAX_CAPACITY).contains(&capacity) {
            return Err(NativeError::new(
                "invalid_input",
                "Active run capacity must be between 1 and 4096",
            ));
        }
        Ok(Self::with_capacity(capacity))
    }

    fn with_capacity(capacity: usize) -> Self {
        Self {
            registry_id: Uuid::new_v4(),
            capacity,
            state: Mutex::new(RegistryState {
                last_generation: 0,
                // Allocate as sessions arrive, not at maximum capacity.
                runs: HashMap::new(),
            }),
        }
    }

    fn lock(&self) -> NativeResult<MutexGuard<'_, RegistryState<T>>> {
        self.state.lock().map_err(|_| {
            NativeError::new("agent_lock_failed", "Active run registry lock is poisoned")
        })
    }

    pub fn reserve(&self, session_id: &str, run: Arc<T>) -> NativeResult<RunTicket> {
        if session_id.is_empty()
            || session_id.len() > MAX_SESSION_ID_BYTES
            || !session_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err(NativeError::new(
                "invalid_input",
                "The active run session identifier is invalid",
            ));
        }

        let mut state = self.lock()?;
        if state.runs.contains_key(session_id) {
            return Err(NativeError::new(
                "agent_run_active",
                "The agent is already working; steer it or interrupt it first",
            ));
        }
        if state.runs.len() >= self.capacity {
            return Err(NativeError::new(
                "agent_run_capacity",
                "The active run registry has reached its configured capacity",
            ));
        }
        let generation = state.last_generation.checked_add(1).ok_or_else(|| {
            NativeError::new(
                "agent_run_generation_exhausted",
                "The active run registry generation is exhausted",
            )
        })?;
        let ticket = RunTicket {
            registry_id: self.registry_id,
            generation,
            session_id: session_id.to_owned(),
        };
        state
            .runs
            .insert(session_id.to_owned(), (ticket.clone(), run));
        state.last_generation = generation;
        Ok(ticket)
    }

    pub fn get(&self, session_id: &str) -> NativeResult<Option<Arc<T>>> {
        Ok(self
            .lock()?
            .runs
            .get(session_id)
            .map(|(_, run)| Arc::clone(run)))
    }

    pub fn contains_key(&self, session_id: &str) -> NativeResult<bool> {
        Ok(self.lock()?.runs.contains_key(session_id))
    }

    pub fn is_empty(&self) -> NativeResult<bool> {
        Ok(self.lock()?.runs.is_empty())
    }

    /// Late completion is a no-op after retirement/replacement, including a
    /// ticket copied from another registry with the same session/generation.
    pub fn remove_current(&self, ticket: &RunTicket) -> NativeResult<bool> {
        let removed = {
            let mut state = self.lock()?;
            let matches = state
                .runs
                .get(&ticket.session_id)
                .is_some_and(|(current, _)| {
                    ticket.registry_id == self.registry_id
                        && current.registry_id == ticket.registry_id
                        && current.generation == ticket.generation
                });
            if matches {
                state.runs.remove(&ticket.session_id)
            } else {
                None
            }
        };
        // User-defined state destructors may reenter the registry. Destroy
        // removed state only after the mutex guard above has been released.
        let was_removed = removed.is_some();
        drop(removed);
        Ok(was_removed)
    }

    /// Explicit lifecycle retirement (for example, session deletion). The
    /// caller remains responsible for cancellation, journal and tombstones.
    pub fn retire(&self, session_id: &str) -> NativeResult<Option<Arc<T>>> {
        let removed = self.lock()?.runs.remove(session_id);
        Ok(removed.map(|(_, run)| run))
    }

    /// Unordered snapshot, bounded by configured capacity. Host work on these
    /// references cannot hold the registry lock or block other sessions.
    pub fn snapshot(&self) -> NativeResult<Vec<Arc<T>>> {
        Ok(self
            .lock()?
            .runs
            .values()
            .map(|(_, run)| Arc::clone(run))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Barrier, Weak,
    };

    #[test]
    fn capacity_configuration_and_identifiers_are_validated() {
        assert_eq!(
            RunRegistry::<()>::new(0).err().unwrap().code,
            "invalid_input"
        );
        assert_eq!(
            RunRegistry::<()>::new(MAX_CAPACITY + 1).err().unwrap().code,
            "invalid_input"
        );
        assert!(RunRegistry::<()>::new(MAX_CAPACITY).is_ok());
        let registry = RunRegistry::new(1).unwrap();
        for id in ["", " leading", "trailing ", "a/b", "line\nbreak", "tiếng"] {
            assert_eq!(
                registry.reserve(id, Arc::new(())).err().unwrap().code,
                "invalid_input"
            );
        }
        assert_eq!(
            registry
                .reserve(&"a".repeat(MAX_SESSION_ID_BYTES + 1), Arc::new(()))
                .err()
                .unwrap()
                .code,
            "invalid_input"
        );
        let ticket = registry
            .reserve(&"a".repeat(MAX_SESSION_ID_BYTES), Arc::new(()))
            .unwrap();
        assert_eq!(ticket.session_id().len(), MAX_SESSION_ID_BYTES);
        assert!(registry.remove_current(&ticket).unwrap());
        assert!(registry.reserve("run_01-A", Arc::new(())).is_ok());
    }

    #[test]
    fn duplicate_precedes_capacity_and_retirement_releases_capacity() {
        let registry = RunRegistry::new(1).unwrap();
        let first = registry.reserve("first", Arc::new(1)).unwrap();
        assert_eq!(
            registry.reserve("first", Arc::new(2)).err().unwrap().code,
            "agent_run_active"
        );
        assert_eq!(
            registry.reserve("second", Arc::new(2)).err().unwrap().code,
            "agent_run_capacity"
        );
        assert_eq!(*registry.get("first").unwrap().unwrap(), 1);
        assert!(registry.remove_current(&first).unwrap());
        assert!(!registry.remove_current(&first).unwrap());
        assert!(registry.reserve("second", Arc::new(2)).is_ok());
    }

    #[test]
    fn stale_and_foreign_tickets_cannot_remove_successors() {
        let registry = RunRegistry::new(2).unwrap();
        let foreign = RunRegistry::new(2).unwrap();
        let old = registry.reserve("session", Arc::new(1)).unwrap();
        let foreign_ticket = foreign.reserve("session", Arc::new(2)).unwrap();
        assert!(!registry.remove_current(&foreign_ticket).unwrap());
        assert_eq!(*registry.retire("session").unwrap().unwrap(), 1);
        let successor = registry.reserve("session", Arc::new(3)).unwrap();
        assert!(!registry.remove_current(&old).unwrap());
        assert_eq!(*registry.get("session").unwrap().unwrap(), 3);
        assert!(registry.remove_current(&successor).unwrap());
        assert!(registry.is_empty().unwrap());
        assert!(registry.retire("missing").unwrap().is_none());
    }

    #[test]
    fn cloned_state_and_snapshots_survive_retirement_without_holding_locks() {
        let registry = RunRegistry::default();
        let value = Arc::new(42);
        let weak = Arc::downgrade(&value);
        registry.reserve("session", value).unwrap();
        let fetched = registry.get("session").unwrap().unwrap();
        let snapshot = registry.snapshot().unwrap();
        assert_eq!(snapshot.len(), 1);
        assert!(Arc::ptr_eq(&snapshot[0], &fetched));
        assert!(registry.contains_key("session").unwrap());
        drop(registry.retire("session").unwrap());
        assert!(registry.is_empty().unwrap());
        assert_eq!(*fetched, 42);
        drop(fetched);
        assert!(weak.upgrade().is_some());
        drop(snapshot);
        assert!(weak.upgrade().is_none());
        assert!(registry.snapshot().unwrap().is_empty());
    }

    #[test]
    fn concurrent_reservation_has_exactly_one_winner() {
        let registry = Arc::new(RunRegistry::new(8).unwrap());
        let barrier = Arc::new(Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|value| {
                let registry = Arc::clone(&registry);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    registry.reserve("same-session", Arc::new(value))
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
        let winner = results.into_iter().find_map(Result::ok).unwrap();
        assert_eq!(registry.snapshot().unwrap().len(), 1);
        assert!(registry.remove_current(&winner).unwrap());
    }

    #[test]
    fn poison_fails_closed_for_every_operation() {
        let registry = RunRegistry::new(1).unwrap();
        let ticket = registry.reserve("session", Arc::new(1)).unwrap();
        let _ = std::panic::catch_unwind(|| {
            let _guard = registry.state.lock().unwrap();
            panic!("fixture poison");
        });
        assert_eq!(
            registry.reserve("other", Arc::new(2)).err().unwrap().code,
            "agent_lock_failed"
        );
        assert_eq!(
            registry.get("session").unwrap_err().code,
            "agent_lock_failed"
        );
        assert_eq!(
            registry.contains_key("session").unwrap_err().code,
            "agent_lock_failed"
        );
        assert_eq!(registry.is_empty().unwrap_err().code, "agent_lock_failed");
        assert_eq!(
            registry.remove_current(&ticket).unwrap_err().code,
            "agent_lock_failed"
        );
        assert_eq!(
            registry.retire("session").unwrap_err().code,
            "agent_lock_failed"
        );
        assert_eq!(registry.snapshot().unwrap_err().code, "agent_lock_failed");
    }

    #[test]
    fn generation_exhaustion_never_wraps_or_mutates_registry() {
        let registry = RunRegistry::new(1).unwrap();
        registry.state.lock().unwrap().last_generation = u64::MAX;
        assert_eq!(
            registry.reserve("session", Arc::new(1)).err().unwrap().code,
            "agent_run_generation_exhausted"
        );
        assert!(registry.is_empty().unwrap());
        assert_eq!(registry.state.lock().unwrap().last_generation, u64::MAX);
    }

    struct DropProbe {
        registry: Weak<RunRegistry<DropProbe>>,
        dropped_outside_lock: Arc<AtomicBool>,
    }

    impl Drop for DropProbe {
        fn drop(&mut self) {
            let registry = self.registry.upgrade().unwrap();
            self.dropped_outside_lock
                .store(registry.state.try_lock().is_ok(), Ordering::SeqCst);
        }
    }

    #[test]
    fn removed_or_rejected_user_state_is_dropped_outside_registry_lock() {
        let registry = Arc::new(RunRegistry::new(1).unwrap());
        let first_dropped = Arc::new(AtomicBool::new(false));
        let ticket = registry
            .reserve(
                "session",
                Arc::new(DropProbe {
                    registry: Arc::downgrade(&registry),
                    dropped_outside_lock: Arc::clone(&first_dropped),
                }),
            )
            .unwrap();
        let rejected_dropped = Arc::new(AtomicBool::new(false));
        assert_eq!(
            registry
                .reserve(
                    "session",
                    Arc::new(DropProbe {
                        registry: Arc::downgrade(&registry),
                        dropped_outside_lock: Arc::clone(&rejected_dropped),
                    })
                )
                .err()
                .unwrap()
                .code,
            "agent_run_active"
        );
        assert!(rejected_dropped.load(Ordering::SeqCst));
        assert!(registry.remove_current(&ticket).unwrap());
        assert!(first_dropped.load(Ordering::SeqCst));

        let retired_dropped = Arc::new(AtomicBool::new(false));
        registry
            .reserve(
                "retired",
                Arc::new(DropProbe {
                    registry: Arc::downgrade(&registry),
                    dropped_outside_lock: Arc::clone(&retired_dropped),
                }),
            )
            .unwrap();
        let retired = registry.retire("retired").unwrap();
        assert!(!retired_dropped.load(Ordering::SeqCst));
        drop(retired);
        assert!(retired_dropped.load(Ordering::SeqCst));
    }

    #[test]
    fn default_capacity_is_bounded_and_lazy() {
        let registry = RunRegistry::default();
        assert_eq!(registry.capacity, DEFAULT_CAPACITY);
        assert_eq!(registry.state.lock().unwrap().runs.capacity(), 0);
        for index in 0..DEFAULT_CAPACITY {
            registry
                .reserve(&format!("session-{index}"), Arc::new(()))
                .unwrap();
        }
        assert_eq!(registry.snapshot().unwrap().len(), DEFAULT_CAPACITY);
        assert_eq!(
            registry
                .reserve("overflow", Arc::new(()))
                .err()
                .unwrap()
                .code,
            "agent_run_capacity"
        );
    }
}
