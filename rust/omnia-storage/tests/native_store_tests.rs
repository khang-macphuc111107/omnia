use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use omnia_storage::{
    build_provider, prepare_session_config, provider_selection, upsert_profile_on,
    AgentRunStateRecord, AgentRunStatus, AgentSessionSummary, CreateAgentSessionRequest,
    HarnessEnvironment, HarnessStore, MapSecretBroker, ProviderProfileInput,
    ProviderProfileRepository, RunCoordinator, RunRegistry, SaveAgentSessionNavigationRequest,
    SessionCommand, SessionWorker, Sessions, UpdateAgentSessionSettingsRequest,
    DEFAULT_TOKEN_BUDGET,
};
use omnia_winsqlite::Connection;
use serde_json::json;

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "omnia-native-storage-{prefix}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        Self { path: dir }
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn harness_store_enforces_exclusive_ownership_and_releases_on_drop() {
    let temp = TempDirGuard::new("ownership");
    let db_path = temp.path.join("harness.db");

    let store1 = HarnessStore::open(&db_path).expect("open first store");
    let err = HarnessStore::open(&db_path).expect_err("second store must fail");
    assert_eq!(err.code, "harness_store_busy");
    assert!(err.retryable);

    drop(store1);
    let _store2 = HarnessStore::open(&db_path).expect("reopen after release");
}

#[test]
fn harness_store_validates_settings_and_enforces_cas_revision() {
    let mut store = HarnessStore::open_in_memory().expect("open memory store");
    let created = store
        .create_agent_session(
            CreateAgentSessionRequest {
                id: Some("sess-cas".to_owned()),
                title: "Initial".to_owned(),
                cwd: "D:\\Omnia".to_owned(),
                environment: HarnessEnvironment::WindowsNative,
                model: "gpt-5.4".to_owned(),
                token_budget: DEFAULT_TOKEN_BUDGET,
            },
            1_000,
        )
        .expect("create session");
    assert_eq!(created.revision, 1);

    // Reject invalid title / model variants.
    for bad_title in ["", "   \t  ", "bad\x07ctrl", &"a".repeat(257)] {
        let err = store
            .update_agent_session_settings(
                UpdateAgentSessionSettingsRequest {
                    session_id: "sess-cas".to_owned(),
                    expected_revision: 1,
                    title: bad_title.to_owned(),
                    model: "gpt-5.4".to_owned(),
                },
                1_100,
            )
            .expect_err("bad title must fail");
        assert_eq!(err.code, "invalid_input");
    }
    for bad_model in ["", "   ", "m\x00bad", &"m".repeat(129)] {
        let err = store
            .update_agent_session_settings(
                UpdateAgentSessionSettingsRequest {
                    session_id: "sess-cas".to_owned(),
                    expected_revision: 1,
                    title: "Valid".to_owned(),
                    model: bad_model.to_owned(),
                },
                1_100,
            )
            .expect_err("bad model must fail");
        assert_eq!(err.code, "invalid_input");
    }

    // Invalid revision <= 0
    let inv_rev = store
        .update_agent_session_settings(
            UpdateAgentSessionSettingsRequest {
                session_id: "sess-cas".to_owned(),
                expected_revision: 0,
                title: "Valid".to_owned(),
                model: "gpt-5.4".to_owned(),
            },
            1_100,
        )
        .expect_err("zero revision must fail");
    assert_eq!(inv_rev.code, "agent_session_revision_invalid");

    // Valid Unicode update succeeds and bumps revision 1 -> 2.
    let updated = store
        .update_agent_session_settings(
            UpdateAgentSessionSettingsRequest {
                session_id: "sess-cas".to_owned(),
                expected_revision: 1,
                title: "  Tieng Viet — Session  ".to_owned(),
                model: "claude-opus-4-6".to_owned(),
            },
            1_200,
        )
        .expect("update valid");
    assert_eq!(updated.revision, 2);
    assert_eq!(updated.title, "Tieng Viet — Session");
    assert_eq!(updated.model, "claude-opus-4-6");

    // Stale CAS revision fails.
    let stale = store
        .update_agent_session_settings(
            UpdateAgentSessionSettingsRequest {
                session_id: "sess-cas".to_owned(),
                expected_revision: 1,
                title: "Overwrite".to_owned(),
                model: "gpt-5.4".to_owned(),
            },
            1_300,
        )
        .expect_err("stale revision must fail");
    assert_eq!(stale.code, "agent_session_revision_conflict");

    // Revision exhaustion guard.
    store
        .upsert_agent_session(&AgentSessionSummary {
            revision: i64::MAX,
            ..updated
        })
        .expect("seed max revision");
    let exhausted = store
        .update_agent_session_settings(
            UpdateAgentSessionSettingsRequest {
                session_id: "sess-cas".to_owned(),
                expected_revision: i64::MAX,
                title: "Next".to_owned(),
                model: "gpt-5.4".to_owned(),
            },
            1_400,
        )
        .expect_err("exhausted revision must fail");
    assert_eq!(exhausted.code, "agent_session_revision_exhausted");
}

#[test]
fn harness_store_keyset_paging_125_sessions_limit_50_orders_deterministically() {
    let mut store = HarnessStore::open_in_memory().expect("open memory store");
    let base_ms = 1_700_000_125_000i64;
    for i in 0..124 {
        let id = format!("paging-fixture-{i:04}");
        store
            .create_agent_session(
                CreateAgentSessionRequest {
                    id: Some(id.clone()),
                    title: format!("Fixture {i:04}"),
                    cwd: "D:\\Omnia".to_owned(),
                    environment: HarnessEnvironment::WindowsNative,
                    model: "gpt-5.4".to_owned(),
                    token_budget: DEFAULT_TOKEN_BUDGET,
                },
                base_ms - i64::from(i),
            )
            .expect("seed session");
    }
    store
        .create_agent_session(
            CreateAgentSessionRequest {
                id: Some("off-page-active".to_owned()),
                title: "Off-page active".to_owned(),
                cwd: "D:\\Omnia".to_owned(),
                environment: HarnessEnvironment::WindowsNative,
                model: "gpt-5.4".to_owned(),
                token_budget: DEFAULT_TOKEN_BUDGET,
            },
            base_ms - 500,
        )
        .expect("seed off-page active");

    assert_eq!(
        store.session_page(0, None).expect_err("limit 0").code,
        "session_page_invalid"
    );
    assert_eq!(
        store.session_page(101, None).expect_err("limit 101").code,
        "session_page_too_large"
    );

    let p1 = store.session_page(50, None).expect("page 1");
    assert_eq!(p1.items.len(), 50);
    assert!(p1.has_more);
    assert_eq!(p1.total_count, 125);
    assert_eq!(p1.items[0].id, "paging-fixture-0000");

    let p2 = store
        .session_page(50, p1.next_cursor.as_ref())
        .expect("page 2");
    assert_eq!(p2.items.len(), 50);
    assert!(p2.has_more);

    let p3 = store
        .session_page(50, p2.next_cursor.as_ref())
        .expect("page 3");
    assert_eq!(p3.items.len(), 25);
    assert!(!p3.has_more);
    assert_eq!(p3.items.last().expect("last").id, "off-page-active");

    let mut seen = HashSet::new();
    for item in p1
        .items
        .iter()
        .chain(p2.items.iter())
        .chain(p3.items.iter())
    {
        assert!(seen.insert(item.id.clone()));
    }
    assert_eq!(seen.len(), 125);
}

#[test]
fn sessions_navigation_paging_selection_and_deletion_guard_behave_consistently() {
    let mut store = HarnessStore::open_in_memory().expect("open memory store");
    for i in 0..124 {
        store
            .create_agent_session(
                CreateAgentSessionRequest {
                    id: Some(format!("paging-fixture-{i:04}")),
                    title: format!("Fixture {i:04}"),
                    cwd: "D:\\Omnia".to_owned(),
                    environment: HarnessEnvironment::WindowsNative,
                    model: "gpt-5.4".to_owned(),
                    token_budget: DEFAULT_TOKEN_BUDGET,
                },
                2_000_000 - i64::from(i),
            )
            .expect("seed");
    }
    store
        .create_agent_session(
            CreateAgentSessionRequest {
                id: Some("off-page-active".to_owned()),
                title: "Off-page active".to_owned(),
                cwd: "D:\\Omnia".to_owned(),
                environment: HarnessEnvironment::WindowsNative,
                model: "gpt-5.4".to_owned(),
                token_budget: DEFAULT_TOKEN_BUDGET,
            },
            1_000_000,
        )
        .expect("seed off-page");
    store
        .save_session_navigation(
            SaveAgentSessionNavigationRequest {
                expected_revision: None,
                active_session_id: Some("off-page-active".to_owned()),
                open_session_ids: vec!["off-page-active".to_owned()],
                page_limit: 50,
                cursor: None,
                receipt_id: "seed-nav-1".to_owned(),
            },
            2_100_000,
        )
        .expect("seed nav");

    let mut sessions = Sessions::from_store(store).expect("create sessions view");
    let s1 = sessions.snapshot().expect("snap 1");
    assert_eq!(s1.active_session_id.as_deref(), Some("off-page-active"));
    assert!(!s1.active_on_page);
    assert!(!s1.can_go_prev);
    assert!(s1.can_go_next);

    let s2 = sessions.next_page().expect("page 2");
    assert!(s2.can_go_prev);
    assert!(s2.can_go_next);
    assert!(!s2.active_on_page);

    let s3 = sessions.next_page().expect("page 3");
    assert!(!s3.can_go_next);
    assert!(s3.active_on_page);

    let back2 = sessions.prev_page().expect("prev page 2");
    assert_eq!(back2.page.items[0].id, "paging-fixture-0050");

    let back1 = sessions.first_page().expect("first page");
    assert!(!back1.can_go_prev);
    assert_eq!(back1.page.items[0].id, "paging-fixture-0000");

    let (selected, sel_snap) = sessions
        .select_session("paging-fixture-0000", Some("select-r1"), 2_200_000)
        .expect("select p1");
    assert_eq!(selected.id, "paging-fixture-0000");
    assert!(sel_snap.active_on_page);

    // Block deletion while run is active, allow after idle.
    sessions
        .store_mut()
        .set_run_state(&AgentRunStateRecord {
            session_id: "off-page-active".to_owned(),
            status: AgentRunStatus::Running,
            snapshot_sequence: 1,
        })
        .expect("set running");
    let del_err = sessions
        .delete_session("off-page-active", 2_300_000)
        .expect_err("running session cannot be deleted");
    assert_eq!(del_err.code, "session_run_active");

    sessions
        .store_mut()
        .set_run_state(&AgentRunStateRecord {
            session_id: "off-page-active".to_owned(),
            status: AgentRunStatus::Completed,
            snapshot_sequence: 1,
        })
        .expect("set completed");
    let after_del = sessions
        .delete_session("off-page-active", 2_400_000)
        .expect("delete once idle");
    assert_eq!(after_del.page.total_count, 124);
    assert!(sessions
        .store()
        .is_session_deleted("off-page-active")
        .expect("tombstone"));
}

#[test]
fn harness_store_recovers_running_runs_on_restart_and_replays_navigation_receipts() {
    let temp = TempDirGuard::new("recovery");
    let db_path = temp.path.join("recovery.db");

    {
        let mut store = HarnessStore::open(&db_path).expect("open store 1");
        store
            .create_agent_session(
                CreateAgentSessionRequest {
                    id: Some("sess-rec".to_owned()),
                    title: "Recoverable".to_owned(),
                    cwd: "D:\\Omnia".to_owned(),
                    environment: HarnessEnvironment::Wsl,
                    model: "gpt-5.4".to_owned(),
                    token_budget: DEFAULT_TOKEN_BUDGET,
                },
                1_000,
            )
            .expect("create");
        store
            .set_run_state(&AgentRunStateRecord {
                session_id: "sess-rec".to_owned(),
                status: AgentRunStatus::Running,
                snapshot_sequence: 4,
            })
            .expect("mark running");

        let nav1 = store
            .save_session_navigation(
                SaveAgentSessionNavigationRequest {
                    expected_revision: None,
                    active_session_id: Some("sess-rec".to_owned()),
                    open_session_ids: vec!["sess-rec".to_owned()],
                    page_limit: 50,
                    cursor: None,
                    receipt_id: "rcpt-1".to_owned(),
                },
                1_050,
            )
            .expect("save nav");
        assert_eq!(nav1.revision, 1);

        // Same receipt_id replays cleanly without incrementing revision.
        let nav_replay = store
            .save_session_navigation(
                SaveAgentSessionNavigationRequest {
                    expected_revision: Some(99),
                    active_session_id: Some("sess-rec".to_owned()),
                    open_session_ids: vec!["sess-rec".to_owned()],
                    page_limit: 50,
                    cursor: None,
                    receipt_id: "rcpt-1".to_owned(),
                },
                1_060,
            )
            .expect("replay receipt");
        assert_eq!(nav_replay.revision, 1);

        // Wrong CAS revision with new receipt_id fails with navigation_conflict.
        let nav_err = store
            .save_session_navigation(
                SaveAgentSessionNavigationRequest {
                    expected_revision: Some(99),
                    active_session_id: Some("sess-rec".to_owned()),
                    open_session_ids: vec!["sess-rec".to_owned()],
                    page_limit: 50,
                    cursor: None,
                    receipt_id: "rcpt-2".to_owned(),
                },
                1_070,
            )
            .expect_err("stale nav must conflict");
        assert_eq!(nav_err.code, "navigation_conflict");
    }

    let reopened = HarnessStore::open(&db_path).expect("reopen store 2");
    let state = reopened
        .get_run_state("sess-rec")
        .expect("query state")
        .expect("some state");
    assert_eq!(state.status, AgentRunStatus::Interrupted);
    assert_eq!(state.snapshot_sequence, 4);
}

#[test]
fn read_only_provider_repository_reads_without_wal_recovery_or_writes() {
    let temp = TempDirGuard::new("ro-repo");
    let db_path = temp.path.join("ro_native.db");

    {
        let mut store = HarnessStore::open(&db_path).expect("seed rw");
        store
            .create_agent_session(
                CreateAgentSessionRequest {
                    id: Some("sess-ro".to_owned()),
                    title: "ReadOnly Check".to_owned(),
                    cwd: "D:\\Omnia".to_owned(),
                    environment: HarnessEnvironment::CloudApi,
                    model: "gpt-5.4".to_owned(),
                    token_budget: DEFAULT_TOKEN_BUDGET,
                },
                1_000,
            )
            .expect("create");
        store
            .set_run_state(&AgentRunStateRecord {
                session_id: "sess-ro".to_owned(),
                status: AgentRunStatus::Running,
                snapshot_sequence: 9,
            })
            .expect("set running");
        upsert_profile_on(
            store.connection_mut(),
            ProviderProfileInput {
                id: "prof-1".to_owned(),
                name: "Primary".to_owned(),
                kind: "openai".to_owned(),
                base_url: "https://api.example.com/v1".to_owned(),
                model: "gpt-5.4".to_owned(),
                secret_key: "OMNIA_TEST_KEY".to_owned(),
                enabled: true,
                extra_json: json!({ "tier": "primary" }),
            },
            1_100,
        )
        .expect("seed provider profile");
        drop(store);

        let conn = Connection::open_read_write(&db_path).expect("reset journal");
        conn.exec_batch("PRAGMA journal_mode = DELETE;")
            .expect("delete mode");
    }

    let before_bytes = fs::read(&db_path).expect("bytes before");
    let repo = ProviderProfileRepository::open_read_only(&db_path).expect("open ro repo");
    let profiles = repo.list_profiles().expect("list profiles");
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].id, "prof-1");

    // Verify WAL recovery was NOT run by read-only connection: run state stays 'running'.
    let states = repo.list_run_states().expect("list run states");
    assert_eq!(states.len(), 1);
    assert_eq!(states[0].status, AgentRunStatus::Running);
    drop(repo);

    let after_bytes = fs::read(&db_path).expect("bytes after");
    assert_eq!(before_bytes, after_bytes);
    let file_count = fs::read_dir(&temp.path).expect("read dir").count();
    assert_eq!(file_count, 1);
}

#[test]
fn provider_selection_build_and_prepare_session_config_enforce_gates() {
    let mut store = HarnessStore::open_in_memory().expect("open memory store");
    store
        .create_agent_session(
            CreateAgentSessionRequest {
                id: Some("sess-prep".to_owned()),
                title: "Prep".to_owned(),
                cwd: "D:\\Omnia".to_owned(),
                environment: HarnessEnvironment::WindowsNative,
                model: "gpt-5.4".to_owned(),
                token_budget: DEFAULT_TOKEN_BUDGET,
            },
            1_000,
        )
        .expect("create");

    let broker = MapSecretBroker::new();
    let prep_no_prof =
        prepare_session_config(&store, &broker, "sess-prep", None).expect("prep without profile");
    assert!(prep_no_prof.provider.is_none());

    upsert_profile_on(
        store.connection_mut(),
        ProviderProfileInput {
            id: "disabled-p".to_owned(),
            name: "Disabled".to_owned(),
            kind: "openai".to_owned(),
            base_url: "https://api.example.com/v1".to_owned(),
            model: "gpt-5.4".to_owned(),
            secret_key: "TEST_ENV_KEY_1".to_owned(),
            enabled: false,
            extra_json: json!({}),
        },
        1_100,
    )
    .expect("upsert disabled");

    assert_eq!(
        prepare_session_config(&store, &broker, "sess-prep", Some("missing-p"))
            .expect_err("missing profile")
            .code,
        "provider_profile_missing"
    );
    assert_eq!(
        prepare_session_config(&store, &broker, "sess-prep", Some("disabled-p"))
            .expect_err("disabled profile")
            .code,
        "provider_disabled"
    );

    upsert_profile_on(
        store.connection_mut(),
        ProviderProfileInput {
            id: "active-p".to_owned(),
            name: "Active".to_owned(),
            kind: "openai".to_owned(),
            base_url: "https://api.example.com/v1".to_owned(),
            model: "gpt-5.4".to_owned(),
            secret_key: "TEST_ENV_KEY_2".to_owned(),
            enabled: true,
            extra_json: json!({}),
        },
        1_200,
    )
    .expect("upsert enabled");

    assert_eq!(
        prepare_session_config(&store, &broker, "sess-prep", Some("active-p"))
            .expect_err("missing secret")
            .code,
        "secret_missing"
    );

    let synth_secret = format!("{}{}", "omnia_test_", "secret_token_987654321");
    broker.insert("TEST_ENV_KEY_2", synth_secret.clone());
    let prepared =
        prepare_session_config(&store, &broker, "sess-prep", Some("active-p")).expect("prepared");
    let cfg = prepared.provider.expect("provider configured");
    assert_eq!(cfg.profile_id, "active-p");
    assert_eq!(cfg.api_key, synth_secret);

    let mut repo = ProviderProfileRepository::open_in_memory().expect("repo");
    repo.upsert_profile(
        ProviderProfileInput {
            id: "p-ok".to_owned(),
            name: "OK".to_owned(),
            kind: "openai".to_owned(),
            base_url: "https://api.example.com/v1".to_owned(),
            model: "gpt-5.4".to_owned(),
            secret_key: "TEST_ENV_KEY_2".to_owned(),
            enabled: true,
            extra_json: json!({}),
        },
        1_300,
    )
    .expect("upsert");
    let sel = provider_selection(&repo, &broker, Some("p-ok")).expect("select");
    let built = build_provider(sel).expect("build");
    assert_eq!(built.model, "gpt-5.4");
}

#[test]
fn run_coordinator_prevents_concurrent_runs_and_redacts_persisted_events() {
    let mut store = HarnessStore::open_in_memory().expect("open store");
    store
        .create_agent_session(
            CreateAgentSessionRequest {
                id: Some("sess-run".to_owned()),
                title: "Run Session".to_owned(),
                cwd: "D:\\Omnia".to_owned(),
                environment: HarnessEnvironment::WindowsNative,
                model: "gpt-5.4".to_owned(),
                token_budget: DEFAULT_TOKEN_BUDGET,
            },
            1_000,
        )
        .expect("create");

    let coordinator = RunCoordinator::new(RunRegistry::new());
    let (token, mut run_state) = coordinator
        .start_run(&mut store, "sess-run", "run-abc", 1_100)
        .expect("start run");
    assert!(coordinator.registry().is_active("sess-run"));
    assert!(!token.is_cancelled());

    let dup = coordinator
        .start_run(&mut store, "sess-run", "run-def", 1_150)
        .expect_err("duplicate active run must fail");
    assert_eq!(dup.code, "session_run_active");

    let synth_key = ["sk", "proj", "0123456789abcdefXYZ"].join("-");
    omnia_storage::publish_run_event(
        &mut store,
        &mut run_state,
        "provider_trace",
        json!({
            "api_key": synth_key,
            "input_tokens": 500,
            "output_tokens": 120
        }),
        1_200,
    )
    .expect("publish event");

    assert!(coordinator.registry().cancel_run("sess-run"));
    assert!(token.is_cancelled());

    coordinator
        .finish_run_with_status(
            &mut store,
            &mut run_state,
            AgentRunStatus::Cancelled,
            json!({ "reason": "user_cancelled" }),
            1_300,
        )
        .expect("finish cancelled");
    assert!(!coordinator.registry().is_active("sess-run"));

    let events = store
        .list_agent_events("sess-run", 0)
        .expect("list persisted events");
    assert_eq!(events.len(), 3);
    assert_eq!(events[1].payload["api_key"], "[REDACTED]");
    assert_eq!(events[1].payload["input_tokens"], 500);
    assert_eq!(events[1].payload["output_tokens"], 120);
}

#[test]
fn session_worker_enforces_bounded_queue_and_executes_async_commands() {
    let unbacked = SessionWorker::create_unbacked_for_queue_test();
    let req1 = unbacked
        .submit(SessionCommand::Refresh)
        .expect("first submit");
    assert_eq!(req1, 1);
    let busy = unbacked
        .submit(SessionCommand::FirstPage)
        .expect_err("second pending command must fail immediately without retry");
    assert_eq!(busy.code, "session_worker_busy");
    assert!(busy.retryable);
    unbacked.stop_and_wait();
    assert_eq!(
        unbacked
            .submit(SessionCommand::Refresh)
            .expect_err("stopped worker fails")
            .code,
        "session_worker_stopped"
    );

    let sessions = Sessions::open_in_memory().expect("open sessions");
    let worker = SessionWorker::start(sessions);

    let r1 = worker
        .submit(SessionCommand::Create(CreateAgentSessionRequest {
            id: Some("w-sess-1".to_owned()),
            title: "Worker Created".to_owned(),
            cwd: "D:\\Omnia".to_owned(),
            environment: HarnessEnvironment::WindowsNative,
            model: "gpt-5.4".to_owned(),
            token_budget: DEFAULT_TOKEN_BUDGET,
        }))
        .expect("submit create");
    let resp1 = worker
        .wait_response(Duration::from_secs(2))
        .expect("wait create response");
    assert_eq!(resp1.request_id, r1);
    assert!(resp1.error.is_none());
    let created = resp1.session.expect("created session");
    assert_eq!(created.revision, 1);

    let r2 = worker
        .submit(SessionCommand::ApplyTurn {
            session_id: "w-sess-1".to_owned(),
            expected_revision: 1,
            user_content: Some("ping".to_owned()),
            assistant_content: Some("pong".to_owned()),
            tokens_delta: 42,
        })
        .expect("submit turn");
    let resp2 = worker
        .wait_response(Duration::from_secs(2))
        .expect("wait turn response");
    assert_eq!(resp2.request_id, r2);
    assert!(resp2.error.is_none());
    let after_turn = resp2.session.expect("updated session");
    assert_eq!(after_turn.revision, 2);
    assert_eq!(after_turn.message_count, 2);
    assert_eq!(after_turn.tokens_used, 42);

    worker.stop_and_wait();
}
