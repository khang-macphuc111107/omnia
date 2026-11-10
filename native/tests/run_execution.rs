//! Real Rust HTTP adapter + Agent + durable store, with a synthetic local
//! provider. This does not prove external inference or native UI Send.
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use omnia_harness::{
    agent::{Agent, AgentEvent, AutoApprove, EventSink, SteerQueue},
    permission::{PermissionMode, PermissionPolicy},
    Block, StreamEvent, ToolContext, ToolRegistry,
};
use omnia_native::sessions::Sessions;
use omnia_provider_services::routing::{build_provider, ProviderProfileInput};
use omnia_session_store::{
    event_publisher::publish_event,
    run_coordinator::RunCoordinator,
    run_events::{publish_run_event, RunEventState},
    run_execution::{execute_prepared_run, PreparedRunExecution},
    session_preparation::prepare_session_config,
    HarnessStore,
};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone, Copy, PartialEq)]
enum Scenario {
    Success,
    AuthenticationFailure,
    CancelOnUsage,
    RecordedPersistenceFailure,
}

async fn run_fixture(scenario: Scenario) {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("native-execution.sqlite3");
    let runtime = RunCoordinator::<()>::from_store(HarnessStore::open(&database).unwrap());
    let sessions = Sessions::from_shared(Arc::clone(runtime.store()));
    let summary = sessions.create("Native execution fixture").unwrap();
    let summary = sessions
        .update_settings(&summary.id, 1, "Fixture", "fixture/model", "high")
        .unwrap();
    let admitted = runtime.admit(&summary.id, Arc::new(())).unwrap();
    let mut history = admitted.history;
    let mut ctx = ToolContext::new(root.path());
    ctx.session_id = summary.id.clone();
    let cancel = ctx.cancel.clone();
    let server_cancel = cancel.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(10), async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let (head_end, content_length) = loop {
                let mut chunk = [0; 1024];
                let count = socket.read(&mut chunk).await.unwrap();
                assert_ne!(count, 0, "request header must finish");
                request.extend_from_slice(&chunk[..count]);
                assert!(request.len() <= 32 * 1024);
                if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let head = std::str::from_utf8(&request[..end]).unwrap();
                    let length = head
                        .lines()
                        .filter_map(|line| line.split_once(':'))
                        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                        .unwrap()
                        .1
                        .trim()
                        .parse::<usize>()
                        .unwrap();
                    assert!(length <= 1024 * 1024);
                    break (end + 4, length);
                }
            };
            while request.len() - head_end < content_length {
                let mut chunk = [0; 1024];
                let count = socket.read(&mut chunk).await.unwrap();
                assert_ne!(count, 0, "request body must finish");
                request.extend_from_slice(&chunk[..count]);
                assert!(request.len() <= 1024 * 1024 + 32 * 1024);
            }
            let body: Value =
                serde_json::from_slice(&request[head_end..head_end + content_length]).unwrap();
            assert_eq!(body["model"], "fixture/model");
            assert!(body["messages"].as_array().unwrap().iter().any(|message| {
                message["role"] == "user" && message["content"] == "native fixture prompt"
            }));
            if scenario == Scenario::AuthenticationFailure {
                socket
                    .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
            } else {
                let events = concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"native answer\"}}]}\n\n",
                    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n"
                );
                if scenario == Scenario::CancelOnUsage {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                    socket.write_all(events.as_bytes()).await.unwrap();
                    server_cancel.cancelled().await;
                } else {
                    let body = format!("{events}data: {{\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n");
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    socket.write_all(response.as_bytes()).await.unwrap();
                }
            }
        })
        .await
        .expect("local HTTP fixture has a finite deadline");
    });
    let base_url = format!("http://{address}");
    let provider = build_provider(
        ProviderProfileInput {
            provider_type: "local",
            base_url: &base_url,
            auth_scheme: "none",
            enabled: true,
            local_network_grant: true,
            organization: None,
            project: None,
        },
        None,
        None,
    )
    .await
    .unwrap();
    publish_event(
        runtime.store(),
        &summary.id,
        json!({"type":"run_started", "runId":"native_fixture_run"}),
        |_| true,
    )
    .unwrap();
    let event_state = Arc::new(RunEventState::default());
    if scenario == Scenario::RecordedPersistenceFailure {
        *event_state.persistence_error.lock().unwrap() =
            Some("synthetic recorded journal failure".to_owned());
    }
    let observed = Arc::new(Mutex::new(Vec::new()));
    let sink_state = Arc::clone(&event_state);
    let sink_observed = observed.clone();
    let sink_store = runtime.store().clone();
    let session_id = summary.id.clone();
    let events: Arc<dyn EventSink> = Arc::new(move |event: AgentEvent| {
        let usage = matches!(
            event,
            AgentEvent::Stream {
                event: StreamEvent::Usage { .. }
            }
        );
        publish_run_event(
            &event,
            &sink_state,
            &cancel,
            |_| false, // This fixture registers no tools or approval senders.
            |value| {
                publish_event(&sink_store, &session_id, value.clone(), |_| true)?;
                sink_observed.lock().unwrap().push(value);
                Ok(())
            },
        )
        .unwrap();
        if scenario == Scenario::CancelOnUsage && usage {
            cancel.cancel();
        }
    });
    let mut config = prepare_session_config(&summary, root.path(), None, false, &[]);
    config.compact_threshold = 0.0;
    config.max_retries = 0;
    let agent = Agent {
        provider,
        tools: ToolRegistry::default(),
        policy: Arc::new(tokio::sync::Mutex::new(PermissionPolicy::new(
            PermissionMode::AskAll,
        ))),
        approver: Arc::new(AutoApprove),
        events,
        steer: SteerQueue::default(),
        config,
        hooks: None,
    };
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        execute_prepared_run(PreparedRunExecution {
            store: runtime.store(),
            session_id: &summary.id,
            agent,
            ctx,
            history: &mut history,
            content: vec![Block::text("native fixture prompt")],
            prompt_text: "native fixture prompt",
            checkpoint_dir: &root.path().join("checkpoints"),
            base_rules: &AtomicUsize::new(0),
            run_tokens: &event_state.run_tokens,
            plan_presented: &event_state.plan_presented,
            persistence_error: &event_state.persistence_error,
        }),
    )
    .await
    .expect("shared execution must terminate");
    server.await.unwrap();
    let terminal = match scenario {
        Scenario::RecordedPersistenceFailure => {
            assert_eq!(result.unwrap_err().code, "harness_storage_failed");
            json!({"type":"run_finished","status":"failed"})
        }
        _ => {
            let terminal = result.unwrap();
            let expected = match scenario {
                Scenario::Success => "completed",
                Scenario::AuthenticationFailure => "failed",
                Scenario::CancelOnUsage => "interrupted",
                _ => unreachable!(),
            };
            assert_eq!(terminal["status"], expected);
            terminal
        }
    };
    publish_event(runtime.store(), &summary.id, terminal, |_| true).unwrap();
    assert!(runtime.runs().remove_current(&admitted.ticket).unwrap());
    assert!(runtime.runs().is_empty().unwrap());
    assert_eq!(event_state.run_tokens.load(Ordering::SeqCst), 0);
    let durable = runtime.store().messages(&summary.id).unwrap();
    assert_eq!(durable, history);
    assert!(
        !durable.is_empty(),
        "user turn is persisted even on failure"
    );
    let expected_tokens = if scenario == Scenario::AuthenticationFailure {
        0
    } else {
        5
    };
    assert_eq!(
        runtime.store().summary(&summary.id).unwrap().tokens_used,
        expected_tokens
    );
    if scenario == Scenario::Success {
        assert_eq!(
            durable.last().unwrap().content,
            vec![Block::text("native answer")]
        );
    }
    let event_count = observed.lock().unwrap().len();
    assert!(event_count > 0);
    drop(sessions);
    drop(runtime);
    let reopened = HarnessStore::open(&database).unwrap();
    assert_eq!(reopened.messages(&summary.id).unwrap(), durable);
    assert_ne!(reopened.replay(&summary.id).unwrap().status, "running");
}

#[tokio::test]
async fn native_consumer_executes_http_stream_and_reopens_durable_transcript() {
    run_fixture(Scenario::Success).await;
}

#[tokio::test]
async fn native_consumer_preserves_failed_provider_turn_without_retry() {
    run_fixture(Scenario::AuthenticationFailure).await;
}

#[tokio::test]
async fn native_consumer_cancels_pending_stream_and_saves_observed_spend() {
    run_fixture(Scenario::CancelOnUsage).await;
}

#[tokio::test]
async fn native_consumer_does_not_report_success_after_recorded_persistence_failure() {
    run_fixture(Scenario::RecordedPersistenceFailure).await;
}
