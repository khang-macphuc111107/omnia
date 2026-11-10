//! Integration tests for omnia-harness verifying:
//! 1. Cancellation future drop & configurable grace period
//! 2. Duplicate tool call ID rejection across stream chunks
//! 3. Local provider routing without authorization headers

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Value};

use omnia_harness::agent::{Agent, AgentConfig, AgentEvent, AutoApprove, EventSink};
use omnia_harness::model::{Message, MessageAccumulator, StopReason, StreamEvent, ToolSpec};
use omnia_harness::permission::{PermissionMode, PermissionPolicy};
use omnia_harness::provider::openai_chat::OpenAiChatProvider;
use omnia_harness::provider::{Provider, ProviderConfig, ProviderRequest, ProviderStream};
use omnia_harness::tool::{EffectClass, Tool, ToolContext, ToolOutput, ToolRegistry};
use omnia_harness::{HarnessError, HarnessResult};

// ============================================================================
// 1. Cancellation Future Drop & Grace Period
// ============================================================================

struct DropGuard(Arc<AtomicBool>);
impl Drop for DropGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

struct TestHungTool {
    started: Arc<tokio::sync::Notify>,
    dropped: Arc<AtomicBool>,
}

#[async_trait]
impl Tool for TestHungTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "hung_tool".into(),
            description: "Test tool that hangs and tracks future drop".into(),
            input_schema: json!({"type": "object"}),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    async fn call(&self, _ctx: &ToolContext, _input: Value) -> HarnessResult<ToolOutput> {
        let _guard = DropGuard(Arc::clone(&self.dropped));
        self.started.notify_one();
        // Deliberately ignore ctx.cancel and pend forever
        std::future::pending::<()>().await;
        Ok(ToolOutput::text("unexpected success"))
    }
}

struct ScriptedStreamProvider {
    turns: Arc<tokio::sync::Mutex<VecDeque<Vec<StreamEvent>>>>,
}

impl ScriptedStreamProvider {
    fn new(turns: Vec<Vec<StreamEvent>>) -> Self {
        Self {
            turns: Arc::new(tokio::sync::Mutex::new(turns.into())),
        }
    }
}

#[async_trait]
impl Provider for ScriptedStreamProvider {
    fn id(&self) -> &str {
        "scripted"
    }

    async fn stream(&self, _request: ProviderRequest) -> HarnessResult<ProviderStream> {
        let mut guard = self.turns.lock().await;
        let events = guard.pop_front().unwrap_or_default();
        let stream = futures_util::stream::iter(events.into_iter().map(Ok));
        Ok(Box::pin(stream))
    }
}

#[derive(Default)]
struct TestEventCollector(Arc<tokio::sync::Mutex<Vec<AgentEvent>>>);
impl EventSink for TestEventCollector {
    fn emit(&self, event: AgentEvent) {
        if let Ok(mut lock) = self.0.try_lock() {
            lock.push(event);
        }
    }
}

#[tokio::test]
async fn test_cancellation_future_dropped_with_custom_grace_period() {
    let tool_started = Arc::new(tokio::sync::Notify::new());
    let future_dropped = Arc::new(AtomicBool::new(false));

    let tool = Arc::new(TestHungTool {
        started: Arc::clone(&tool_started),
        dropped: Arc::clone(&future_dropped),
    });

    let scripted_turn = vec![
        StreamEvent::ToolUseStart {
            id: "call_1".into(),
            name: "hung_tool".into(),
        },
        StreamEvent::ToolInputDelta {
            id: "call_1".into(),
            partial_json: "{}".into(),
        },
        StreamEvent::ToolUseEnd {
            id: "call_1".into(),
        },
        StreamEvent::Stop {
            reason: StopReason::ToolUse,
        },
    ];

    let provider = Arc::new(ScriptedStreamProvider::new(vec![scripted_turn]));
    let events = TestEventCollector::default();
    let events_clone = Arc::clone(&events.0);

    let mut registry = ToolRegistry::default();
    registry.register(tool);

    let mut config = AgentConfig::default();
    // Configure a short custom grace period of 400ms
    let custom_grace = Duration::from_millis(400);
    config.cancel_grace_period = Some(custom_grace);

    let agent = Agent {
        provider: Arc::clone(&provider) as Arc<dyn Provider>,
        tools: registry,
        policy: Arc::new(tokio::sync::Mutex::new(PermissionPolicy::new(
            PermissionMode::Full,
        ))),
        approver: Arc::new(AutoApprove),
        events: Arc::new(events),
        steer: omnia_harness::agent::SteerQueue::default(),
        config,
        hooks: None,
    };

    let ctx = ToolContext::new(".");
    let cancel_token = ctx.cancel.clone();
    let mut history = vec![Message::user("run hung tool")];

    let cancel_task = tokio::spawn(async move {
        tool_started.notified().await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel_token.cancel();
    });

    let start = tokio::time::Instant::now();
    let run_res = agent.run(&mut history, &ctx).await;
    let elapsed = start.elapsed();

    let _ = cancel_task.await;

    assert!(
        matches!(run_res, Err(HarnessError::Cancelled)),
        "Result must be Cancelled"
    );
    assert!(
        future_dropped.load(Ordering::SeqCst),
        "Abandoned tool future must be dropped on cancellation"
    );
    assert!(
        elapsed >= custom_grace && elapsed < custom_grace + Duration::from_millis(300),
        "Elapsed duration ({:?}) must reflect custom grace period ({:?})",
        elapsed,
        custom_grace
    );

    let event_log = events_clone.lock().await;
    let completed = event_log.iter().find_map(|e| match e {
        AgentEvent::ToolCompleted { id, output } if id == "call_1" => Some(output),
        _ => None,
    });
    assert!(completed.is_some(), "ToolCompleted event must be emitted");
    assert!(
        completed.unwrap().is_error,
        "Tool completion must be flagged as error"
    );
}

// ============================================================================
// 2. Duplicate Tool Call ID Rejection Across Stream Chunks
// ============================================================================

#[test]
fn test_duplicate_tool_call_id_while_pending_is_rejected() {
    let mut acc = MessageAccumulator::default();

    acc.push(&StreamEvent::ToolUseStart {
        id: "call_dup".into(),
        name: "tool_a".into(),
    })
    .expect("First start must succeed");

    acc.push(&StreamEvent::ToolInputDelta {
        id: "call_dup".into(),
        partial_json: "{\"param\": 1".into(),
    })
    .expect("Input delta must succeed");

    // Attempting a second ToolUseStart with the same id while the first is pending
    let dup_err = acc.push(&StreamEvent::ToolUseStart {
        id: "call_dup".into(),
        name: "tool_b".into(),
    });

    assert!(
        matches!(dup_err, Err(HarnessError::Protocol(ref msg)) if msg.contains("duplicate tool call id `call_dup`")),
        "Expected duplicate ID protocol error, got: {dup_err:?}"
    );
}

#[test]
fn test_duplicate_tool_call_id_after_completion_is_rejected() {
    let mut acc = MessageAccumulator::default();

    // Start and complete first tool call
    acc.push(&StreamEvent::ToolUseStart {
        id: "call_dup".into(),
        name: "tool_a".into(),
    })
    .unwrap();
    acc.push(&StreamEvent::ToolInputDelta {
        id: "call_dup".into(),
        partial_json: "{\"param\": 1}".into(),
    })
    .unwrap();
    acc.push(&StreamEvent::ToolUseEnd {
        id: "call_dup".into(),
    })
    .unwrap();

    // Reusing the same completed ID later in the same message must fail
    let dup_err = acc.push(&StreamEvent::ToolUseStart {
        id: "call_dup".into(),
        name: "tool_b".into(),
    });

    assert!(
        matches!(dup_err, Err(HarnessError::Protocol(ref msg)) if msg.contains("duplicate tool call id `call_dup`")),
        "Expected duplicate ID protocol error for completed call, got: {dup_err:?}"
    );

    // Verify first call remains intact and uncorrupted
    let (msg, _, _) = acc.finish();
    let calls: Vec<_> = msg.tool_uses().collect();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "call_dup");
    assert_eq!(calls[0].1, "tool_a");
    assert_eq!(calls[0].2, &json!({"param": 1}));
}

// ============================================================================
// 3. Local Provider Routing & Uncensored Model Routing (No Auth)
// ============================================================================

#[tokio::test]
async fn test_local_provider_routing_without_auth_header() {
    // Spin up an ephemeral local TCP listener to simulate a local OpenAI-compatible
    // engine (such as Ollama or vLLM hosting a local uncensored model).
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    let request_received = Arc::new(tokio::sync::Mutex::new(String::new()));
    let req_capture = Arc::clone(&request_received);

    let server_handle = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();

        let mut raw = Vec::new();
        let mut buf = [0u8; 1024];
        loop {
            match socket.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    raw.extend_from_slice(&buf[..n]);
                    if raw.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let req_str = String::from_utf8_lossy(&raw).to_string();
        *req_capture.blocking_lock() = req_str;

        // Return a mock SSE stream response
        let sse_body = concat!(
            "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"created\":1700000000,\"model\":\"huihui-qwen2.5-coder\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"local response\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"created\":1700000000,\"model\":\"huihui-qwen2.5-coder\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
            sse_body.len(),
            sse_body
        );
        let _ = socket.write_all(resp.as_bytes());
        let _ = socket.flush();
    });

    let local_base_url = format!("http://127.0.0.1:{port}/v1");
    let provider = OpenAiChatProvider::new(ProviderConfig {
        base_url: local_base_url,
        api_key: None,
        bearer_auth: false,
        extra_headers: vec![],
    });

    let mut stream = provider
        .stream(ProviderRequest {
            model: "huihui-qwen2.5-coder-7b-abliterated-q4km".into(),
            messages: vec![Message::user("test local routing")],
            ..Default::default()
        })
        .await
        .expect("Stream connection to local provider must succeed");

    let mut deltas = Vec::new();
    while let Some(event_res) = stream.next().await {
        if let Ok(StreamEvent::TextDelta { text }) = event_res {
            deltas.push(text);
        }
    }

    server_handle.join().unwrap();

    let captured = request_received.lock().await;
    assert!(
        captured.starts_with("POST /v1/chat/completions HTTP/1.1"),
        "Must route to /v1/chat/completions endpoint, got: {captured}"
    );
    assert!(
        !captured.to_lowercase().contains("authorization:"),
        "Local provider routing with auth_scheme none must NOT include Authorization header: {captured}"
    );
    assert_eq!(deltas.join(""), "local response");
}
