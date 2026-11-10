//! Public TaskTool regressions for provider-local tool ids in concurrent children.
//! No filesystem mutation, provider HTTP, native bridge, or real permission grants.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use omnia_harness::agent::{AgentConfig, AgentEvent, ApprovalDecision, ApprovalRequest, Approver};
use omnia_harness::permission::{PermissionMode, PermissionPolicy};
use omnia_harness::subagent::{builtin_agents, TaskTool};
use omnia_harness::{
    Block, CancellationToken, EffectClass, HarnessResult, Provider, ProviderRequest,
    ProviderStream, StopReason, StreamEvent, Tool, ToolContext, ToolOutput, ToolRegistry, ToolSpec,
};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

type Pending = HashMap<String, oneshot::Sender<ApprovalDecision>>;

/// Mirrors the bridge's id-keyed pending, queued, and batch-decision boundary.
/// The production TaskTool must make its requests safe for such a shared broker.
struct ParkedApprover {
    pending: Mutex<Pending>,
    queued: Mutex<HashMap<String, Vec<String>>>,
    batch: Mutex<HashMap<String, ApprovalDecision>>,
    requests: mpsc::UnboundedSender<ApprovalRequest>,
    cancel: CancellationToken,
}

impl ParkedApprover {
    fn decide(&self, id: &str, decision: ApprovalDecision) {
        self.pending
            .lock()
            .unwrap()
            .remove(id)
            .expect("approval still pending")
            .send(decision)
            .expect("correct child still waiting");
    }

    fn decide_all(&self, id: &str, decision: ApprovalDecision) {
        let remaining = self.queued.lock().unwrap().get(id).unwrap().clone();
        for next in remaining {
            self.batch.lock().unwrap().insert(next, decision.clone());
        }
        self.decide(id, decision);
    }
}

#[async_trait]
impl Approver for ParkedApprover {
    async fn request(&self, request: ApprovalRequest) -> ApprovalDecision {
        let id = request.tool_use_id.clone();
        if let Some(decision) = self.batch.lock().unwrap().remove(&id) {
            return decision;
        }
        let (sender, receiver) = oneshot::channel();
        self.queued.lock().unwrap().insert(
            id.clone(),
            request
                .remaining
                .iter()
                .map(|next| next.tool_use_id.clone())
                .collect(),
        );
        self.pending.lock().unwrap().insert(id.clone(), sender);
        let _ = self.requests.send(request);
        let decision = tokio::select! {
            result = receiver => result.unwrap_or(ApprovalDecision::Deny { feedback: None }),
            _ = self.cancel.cancelled() => ApprovalDecision::Deny { feedback: None },
        };
        // An unqualified collision here could remove a sibling's sender.
        self.pending.lock().unwrap().remove(&id);
        self.queued.lock().unwrap().remove(&id);
        decision
    }
}

struct RepeatedIdsProvider {
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
}

#[async_trait]
impl Provider for RepeatedIdsProvider {
    fn id(&self) -> &str {
        "scripted"
    }

    async fn stream(&self, request: ProviderRequest) -> HarnessResult<ProviderStream> {
        let child = match &request.messages[0].content[0] {
            Block::Text { text } => text.clone(),
            _ => panic!("fixture needs a child label"),
        };
        let has_results = request.messages.iter().any(|message| {
            message
                .content
                .iter()
                .any(|block| matches!(block, Block::ToolResult { .. }))
        });
        self.requests.lock().unwrap().push(request);
        let mut events = Vec::new();
        if has_results {
            events.push(StreamEvent::TextDelta {
                text: format!("report:{child}"),
            });
            events.push(StreamEvent::Stop {
                reason: StopReason::EndTurn,
            });
        } else {
            // These are also the supported OpenAI-compat fallback ids when a
            // service omits tool-call ids; they repeat in each child response.
            for slot in 0..2 {
                let id = format!("call_{slot}");
                events.push(StreamEvent::ToolUseStart {
                    id: id.clone(),
                    name: "write".into(),
                });
                events.push(StreamEvent::ToolInputDelta {
                    id: id.clone(),
                    partial_json: json!({"child": child, "slot": slot}).to_string(),
                });
                events.push(StreamEvent::ToolUseEnd { id });
            }
            events.push(StreamEvent::Stop {
                reason: StopReason::ToolUse,
            });
        }
        Ok(Box::pin(futures_util::stream::iter(
            events.into_iter().map(Ok),
        )))
    }
}

struct HarmlessWrite {
    calls: Arc<Mutex<Vec<(String, Value)>>>,
}

#[async_trait]
impl Tool for HarmlessWrite {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "write".into(),
            description: "Record a test action in memory".into(),
            input_schema: json!({"type": "object"}),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        self.calls
            .lock()
            .unwrap()
            .push((ctx.tool_use_id.clone(), input));
        Ok(ToolOutput::text("recorded"))
    }
}

struct Fixture {
    tool: Arc<TaskTool>,
    approver: Arc<ParkedApprover>,
    requests: mpsc::UnboundedReceiver<ApprovalRequest>,
    provider_requests: Arc<Mutex<Vec<ProviderRequest>>>,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    events: Arc<Mutex<Vec<AgentEvent>>>,
    cancel: CancellationToken,
}

impl Fixture {
    fn new() -> Self {
        let (sender, requests) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let approver = Arc::new(ParkedApprover {
            pending: Mutex::default(),
            queued: Mutex::default(),
            batch: Mutex::default(),
            requests: sender,
            cancel: cancel.clone(),
        });
        let provider_requests = Arc::default();
        let calls = Arc::default();
        let events: Arc<Mutex<Vec<AgentEvent>>> = Arc::default();
        let sink = Arc::clone(&events);
        let mut tools = ToolRegistry::default();
        tools.register(Arc::new(HarmlessWrite {
            calls: Arc::clone(&calls),
        }));
        let tool = Arc::new(TaskTool {
            provider: Arc::new(RepeatedIdsProvider {
                requests: Arc::clone(&provider_requests),
            }),
            config: AgentConfig {
                model: "test".into(),
                compact_threshold: 0.0,
                ..AgentConfig::default()
            },
            tools,
            policy: Arc::new(tokio::sync::Mutex::new(PermissionPolicy::new(
                PermissionMode::AskWrites,
            ))),
            approver: approver.clone(),
            events: Arc::new(move |event| sink.lock().unwrap().push(event)),
            agents: builtin_agents(),
            hooks: None,
            current_depth: 0,
            max_depth: omnia_harness::subagent::DEFAULT_MAX_SUBAGENT_DEPTH,
        });
        Self {
            tool,
            approver,
            requests,
            provider_requests,
            calls,
            events,
            cancel,
        }
    }

    fn start(&self, child: &'static str) -> tokio::task::JoinHandle<HarnessResult<ToolOutput>> {
        let tool = Arc::clone(&self.tool);
        let mut ctx = ToolContext::new(".");
        ctx.session_id = "same-session".into();
        ctx.tool_use_id = format!("parent-{child}");
        ctx.cancel = self.cancel.clone();
        tokio::spawn(async move {
            tool.call(&ctx, json!({"description": child, "prompt": child}))
                .await
        })
    }

    async fn next_request(&mut self) -> ApprovalRequest {
        tokio::time::timeout(Duration::from_secs(5), self.requests.recv())
            .await
            .expect("fixture approval did not arrive")
            .expect("approval channel closed")
    }

    async fn first_requests(&mut self) -> (ApprovalRequest, ApprovalRequest) {
        let first = self.next_request().await;
        let second = self.next_request().await;
        let (a, b) = if first.input["child"] == "a" {
            (first, second)
        } else {
            (second, first)
        };
        assert_eq!(a.input["child"], "a");
        assert_eq!(b.input["child"], "b");
        assert_eq!((a.ordinal, a.total, b.ordinal, b.total), (1, 2, 1, 2));
        let ids = [
            &a.tool_use_id,
            &a.remaining[0].tool_use_id,
            &b.tool_use_id,
            &b.remaining[0].tool_use_id,
        ];
        assert_eq!(ids.into_iter().collect::<HashSet<_>>().len(), 4);
        (a, b)
    }

    fn assert_raw_provider_history_and_correlated_events(&self) {
        let requests = self.provider_requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
        for request in requests.iter().filter(|request| request.messages.len() > 1) {
            let calls: Vec<_> = request.messages[1]
                .tool_uses()
                .map(|(id, _, _)| id)
                .collect();
            assert_eq!(calls, vec!["call_0", "call_1"]);
            let results: Vec<_> = request.messages[2]
                .content
                .iter()
                .filter_map(|block| match block {
                    Block::ToolResult { tool_use_id, .. } => Some(tool_use_id.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(results, calls);
        }

        let events = self.events.lock().unwrap();
        let mut proposed = HashSet::new();
        let mut completed = HashSet::new();
        let mut decided = HashSet::new();
        let mut message_calls = HashSet::new();
        for event in events.iter() {
            let AgentEvent::Subagent { parent_id, event } = event else {
                panic!("child event must remain nested")
            };
            assert!(matches!(parent_id.as_str(), "parent-a" | "parent-b"));
            match event.as_ref() {
                AgentEvent::ToolProposed { id, .. } => {
                    proposed.insert(id.clone());
                }
                AgentEvent::ToolCompleted { id, .. } => {
                    completed.insert(id.clone());
                }
                AgentEvent::ApprovalDecided { id, .. } => {
                    decided.insert(id.clone());
                }
                AgentEvent::AssistantMessage { message } => {
                    message_calls.extend(message.tool_uses().map(|(id, _, _)| id.to_owned()));
                }
                AgentEvent::ApprovalRequested { request } => {
                    assert!(request.tool_use_id.starts_with("subagent_"));
                }
                _ => {}
            }
        }
        assert_eq!(proposed.len(), 4);
        assert_eq!(message_calls, proposed);
        assert_eq!(completed, proposed);
        assert_eq!(decided, proposed);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Test assertion failures cannot leave parked fixture tasks running.
        self.cancel.cancel();
    }
}

async fn finish(task: tokio::task::JoinHandle<HarnessResult<ToolOutput>>) {
    let output = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("child did not finish")
        .expect("child panicked")
        .expect("child run failed");
    assert!(!output.is_error);
}

#[tokio::test]
async fn same_raw_ids_in_siblings_are_independently_answerable_and_cleanup_isolated() {
    let mut fixture = Fixture::new();
    let a_task = fixture.start("a");
    let b_task = fixture.start("b");
    let (a, b) = fixture.first_requests().await;

    fixture.approver.decide(
        &a.tool_use_id,
        ApprovalDecision::Deny {
            feedback: Some("only a0".into()),
        },
    );
    let a_second = fixture.next_request().await;
    assert_eq!(a_second.tool_use_id, a.remaining[0].tool_use_id);
    assert_eq!(a_second.input["child"], "a");
    fixture
        .approver
        .decide(&a_second.tool_use_id, ApprovalDecision::AllowOnce);
    finish(a_task).await;
    assert!(fixture
        .approver
        .pending
        .lock()
        .unwrap()
        .contains_key(&b.tool_use_id));
    assert_eq!(
        fixture.calls.lock().unwrap().as_slice(),
        &[("call_1".into(), json!({"child": "a", "slot": 1}))]
    );

    fixture
        .approver
        .decide(&b.tool_use_id, ApprovalDecision::AllowOnce);
    let b_second = fixture.next_request().await;
    assert_eq!(b_second.tool_use_id, b.remaining[0].tool_use_id);
    fixture.approver.decide(
        &b_second.tool_use_id,
        ApprovalDecision::Deny { feedback: None },
    );
    finish(b_task).await;
    assert_eq!(fixture.calls.lock().unwrap().len(), 2);
    assert!(fixture.approver.pending.lock().unwrap().is_empty());
    fixture.assert_raw_provider_history_and_correlated_events();
}

#[tokio::test]
async fn batch_allow_and_deny_only_affect_the_selected_child_queue() {
    let mut fixture = Fixture::new();
    let a_task = fixture.start("a");
    let b_task = fixture.start("b");
    let (a, b) = fixture.first_requests().await;

    fixture
        .approver
        .decide_all(&a.tool_use_id, ApprovalDecision::AllowOnce);
    finish(a_task).await;
    assert!(fixture
        .approver
        .pending
        .lock()
        .unwrap()
        .contains_key(&b.tool_use_id));
    let calls = fixture.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 2);
    assert!(calls.iter().all(|(_, input)| input["child"] == "a"));
    assert!(fixture.requests.try_recv().is_err());

    fixture
        .approver
        .decide_all(&b.tool_use_id, ApprovalDecision::Deny { feedback: None });
    finish(b_task).await;
    assert_eq!(*fixture.calls.lock().unwrap(), calls);
    assert!(fixture.approver.pending.lock().unwrap().is_empty());
    assert!(fixture.approver.batch.lock().unwrap().is_empty());
    fixture.assert_raw_provider_history_and_correlated_events();
}
