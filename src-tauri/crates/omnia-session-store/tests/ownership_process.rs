//! Actual independent-process ownership/recovery tests, not dispatch evidence.
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use omnia_harness::permission::PermissionMode;
use omnia_session_store::{AgentSessionSummary, HarnessStore, SessionScope};
use serde_json::json;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("omnia-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn database(&self) -> PathBuf {
        self.0.join("sessions.sqlite3")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for name in [
            "sessions.sqlite3",
            "sessions.sqlite3-wal",
            "sessions.sqlite3-shm",
            "ready",
        ] {
            let _ = std::fs::remove_file(self.0.join(name));
        }
        let _ = std::fs::remove_dir(&self.0);
    }
}

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        // A panic must not leave a child holding the test-owned database.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn seed_running(store: &HarnessStore) {
    store
        .save_summary(&AgentSessionSummary {
            id: "owner-session".into(),
            title: "Process ownership fixture".into(),
            scope: SessionScope::Projectless,
            cwd: "fixture".into(),
            profile_id: String::new(),
            model: "fixture".into(),
            permission_mode: PermissionMode::AskAll,
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
    store
        .append_event(
            "owner-session",
            &json!({"type":"run_started","runId":"fixture-run"}),
        )
        .unwrap();
}

fn spawn_child(database: &Path, mode: &str) -> ChildGuard {
    ChildGuard(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "owner_process_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("OMNIA_OWNER_TEST_DATABASE", database)
            .env("OMNIA_OWNER_TEST_MODE", mode)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    )
}

fn wait_for_ready(child: &mut ChildGuard, fixture: &Fixture) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !fixture.0.join("ready").exists() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "child exited before owning store"
        );
        assert!(
            Instant::now() < deadline,
            "child ownership readiness deadline"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_exit(child: &mut ChildGuard) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success(), "child failed: {status}");
            return;
        }
        assert!(Instant::now() < deadline, "child exit deadline");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn owner_process_child() {
    let Some(database) = std::env::var_os("OMNIA_OWNER_TEST_DATABASE") else {
        return; // Helper is active only in the explicitly spawned child.
    };
    let database = PathBuf::from(database);
    match std::env::var("OMNIA_OWNER_TEST_MODE").unwrap().as_str() {
        "probe_busy" => {
            let error = HarnessStore::open(&database)
                .err()
                .expect("second owner accepted");
            assert_eq!(error.code, "harness_store_busy");
            assert!(error.retryable);
        }
        "hold" => {
            let store = HarnessStore::open(&database).unwrap();
            seed_running(&store);
            std::fs::write(database.parent().unwrap().join("ready"), b"owned").unwrap();
            let mut byte = [0];
            std::io::stdin().read_exact(&mut byte).unwrap();
            drop(store);
        }
        other => panic!("unsupported fixture mode: {other}"),
    }
}

#[test]
fn second_process_cannot_interrupt_live_owner() {
    let fixture = Fixture::new();
    let store = HarnessStore::open(&fixture.database()).unwrap();
    seed_running(&store);
    let mut child = spawn_child(&fixture.database(), "probe_busy");
    wait_for_exit(&mut child);
    assert_eq!(store.replay("owner-session").unwrap().status, "running");
    assert_eq!(store.replay("owner-session").unwrap().events.len(), 1);
}

#[test]
fn normal_child_close_releases_ownership_and_recovery_preserves_journal() {
    let fixture = Fixture::new();
    let mut child = spawn_child(&fixture.database(), "hold");
    wait_for_ready(&mut child, &fixture);
    assert_eq!(
        HarnessStore::open(&fixture.database()).err().unwrap().code,
        "harness_store_busy"
    );
    child.0.stdin.take().unwrap().write_all(b"x").unwrap();
    wait_for_exit(&mut child);
    let reopened = HarnessStore::open(&fixture.database()).unwrap();
    let replay = reopened.replay("owner-session").unwrap();
    assert_eq!(replay.status, "interrupted");
    assert_eq!(replay.events.len(), 1);
}

#[test]
fn killed_child_releases_kernel_ownership_without_stale_lock_cleanup() {
    let fixture = Fixture::new();
    let mut child = spawn_child(&fixture.database(), "hold");
    wait_for_ready(&mut child, &fixture);
    assert_eq!(
        HarnessStore::open(&fixture.database()).err().unwrap().code,
        "harness_store_busy"
    );
    child.0.kill().unwrap();
    let status = child.0.wait().unwrap();
    assert!(!status.success());
    let reopened = HarnessStore::open(&fixture.database()).unwrap();
    let replay = reopened.replay("owner-session").unwrap();
    assert_eq!(replay.status, "interrupted");
    assert_eq!(replay.events.len(), 1);
}

#[test]
fn failed_sqlite_initialization_releases_ownership_without_truncation() {
    let fixture = Fixture::new();
    let original = b"deliberately invalid sqlite fixture";
    std::fs::write(fixture.database(), original).unwrap();
    for _ in 0..2 {
        let error = HarnessStore::open(&fixture.database()).err().unwrap();
        assert_eq!(error.code, "harness_storage_failed");
        assert_eq!(std::fs::read(fixture.database()).unwrap(), original);
    }
}
