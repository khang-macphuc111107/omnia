//! Native consumer of the same preparation used by the compatibility host.
//! This does not dispatch a provider or grant workspace authority.
use std::sync::Arc;

use omnia_native::sessions::Sessions;
use omnia_session_store::{
    run_coordinator::RunCoordinator, session_preparation::prepare_session_config, HarnessStore,
};

#[test]
fn shared_preparation_reads_current_native_settings_without_a_second_store() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("sessions.sqlite3");
    let runtime = RunCoordinator::<()>::from_store(HarnessStore::open(&database).unwrap());
    let sessions = Sessions::from_shared(Arc::clone(runtime.store()));
    let session = sessions.create("Native preparation").unwrap();
    let updated = sessions
        .update_settings(&session.id, 1, "First config", "local/first", "high")
        .unwrap();
    let first = prepare_session_config(&updated, root.path(), None, false, &[]);
    assert_eq!(first.model, "local/first");
    assert_eq!(first.reasoning_effort.as_deref(), Some("high"));

    let updated = sessions
        .update_settings(&session.id, 2, "Second config", "local/second", "minimal")
        .unwrap();
    let second = prepare_session_config(&updated, root.path(), None, false, &[]);
    assert_eq!(second.model, "local/second");
    assert_eq!(second.reasoning_effort.as_deref(), Some("minimal"));
    assert_eq!(first.model, "local/first", "existing config is a snapshot");
    assert_eq!(
        sessions
            .update_settings(&session.id, 2, "Stale", "local/stale", "max")
            .unwrap_err()
            .code,
        "agent_session_revision_conflict"
    );
    assert_eq!(sessions.summary(&session.id).unwrap().model, "local/second");
    assert!(runtime.runs().is_empty().unwrap());
    assert_eq!(
        Sessions::open(&database).err().unwrap().code,
        "harness_store_busy"
    );
}
