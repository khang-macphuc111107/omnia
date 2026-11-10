use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

type Events = Arc<Mutex<Vec<Value>>>;

fn setup() -> (Arc<QuestionBroker>, Events) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    let broker = Arc::new(QuestionBroker::new(
        "session-a".into(),
        "run-a".into(),
        CancellationToken::new(),
        Arc::new(move |event| {
            recorded.lock().unwrap().push(event);
            Ok(())
        }),
    ));
    (broker, events)
}

fn question() -> QuestionInput {
    QuestionInput {
        prompt: "Choose a scope".into(),
        options: vec!["Workspace".into(), "File".into()],
        recommended: vec!["Workspace".into()],
    }
}

#[tokio::test]
async fn channel_exists_before_request_is_published_and_answer_is_journaled() {
    let (broker, events) = setup();
    let (pending, rx) = broker.begin("tool-a", question()).unwrap();
    assert_eq!(broker.pending().len(), 1);
    assert_eq!(events.lock().unwrap()[0]["id"], pending.id);
    let receipt = broker
        .answer(&pending.id, Some("run-a"), Some("File".into()))
        .unwrap();
    assert_eq!(receipt.status, "answered");
    assert_eq!(rx.await.unwrap(), Some("File".into()));
    assert!(broker.pending().is_empty());
    let events = events.lock().unwrap();
    assert_eq!(events[1]["type"], "ask_user_resolved");
    assert_eq!(events[1]["answer"], "File");
    assert_eq!(events[1]["runId"], "run-a");
}

#[tokio::test]
async fn free_text_and_explicit_cancel_are_distinct() {
    let (broker, _) = setup();
    let (first, rx) = broker.begin("tool-a", question()).unwrap();
    broker
        .answer(&first.id, None, Some(" Custom scope ".into()))
        .unwrap();
    assert_eq!(rx.await.unwrap(), Some("Custom scope".into()));
    let (second, rx) = broker.begin("tool-b", question()).unwrap();
    let receipt = broker.answer(&second.id, None, None).unwrap();
    assert_eq!(receipt.status, "cancelled");
    assert_eq!(rx.await.unwrap(), None);
}

#[tokio::test]
async fn duplicate_stale_and_cross_run_answers_are_rejected_without_extra_events() {
    let (broker, events) = setup();
    let (pending, rx) = broker.begin("tool-a", question()).unwrap();
    assert!(matches!(
        broker.answer(&pending.id, Some("run-b"), Some("File".into())),
        Err(QuestionError::WrongRun)
    ));
    assert!(matches!(
        broker.answer("unknown", None, Some("File".into())),
        Err(QuestionError::NotPending)
    ));
    assert_eq!(events.lock().unwrap().len(), 1);
    broker
        .answer(&pending.id, None, Some("File".into()))
        .unwrap();
    assert!(matches!(
        broker.answer(&pending.id, None, Some("File".into())),
        Err(QuestionError::NotPending)
    ));
    assert_eq!(rx.await.unwrap(), Some("File".into()));
    assert_eq!(events.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn close_terminalizes_pending_requests_and_prevents_future_requests() {
    let (broker, events) = setup();
    let (pending, rx) = broker.begin("tool-a", question()).unwrap();
    broker.close("run_interrupted").unwrap();
    assert_eq!(rx.await.unwrap(), None);
    assert!(broker.pending().is_empty());
    assert!(matches!(
        broker.begin("tool-b", question()),
        Err(QuestionError::Closed)
    ));
    assert!(matches!(
        broker.answer(&pending.id, None, Some("File".into())),
        Err(QuestionError::Closed)
    ));
    assert_eq!(events.lock().unwrap()[1]["reason"], "run_interrupted");
}

#[test]
fn invalid_or_unbounded_inputs_never_publish_a_request() {
    let (broker, events) = setup();
    let mut bad = question();
    bad.prompt = " ".into();
    assert!(broker.begin("tool-a", bad).is_err());
    let mut bad = question();
    bad.options = vec!["same".into(), "same".into()];
    assert!(broker.begin("tool-a", bad).is_err());
    let mut bad = question();
    bad.recommended = vec!["not an option".into()];
    assert!(broker.begin("tool-a", bad).is_err());
    let mut bad = question();
    bad.prompt = "x".repeat(MAX_PROMPT_BYTES + 1);
    assert!(broker.begin("tool-a", bad).is_err());
    assert!(events.lock().unwrap().is_empty());
}

#[test]
fn pending_question_limit_is_bounded_before_publication() {
    let (broker, events) = setup();
    let mut receivers = Vec::new();
    for index in 0..MAX_PENDING {
        let (pending, receiver) = broker
            .begin(&format!("tool-{index}"), question())
            .expect("limit should allow the configured number of pending requests");
        receivers.push((pending, receiver));
    }
    assert!(matches!(
        broker.begin("tool-over-limit", question()),
        Err(QuestionError::Invalid(_))
    ));
    assert_eq!(broker.pending().len(), MAX_PENDING);
    assert_eq!(events.lock().unwrap().len(), MAX_PENDING);
    drop(receivers);
}

#[test]
fn failed_request_journal_removes_pending_and_cancels_run() {
    let cancel = CancellationToken::new();
    let observed_cancel = cancel.clone();
    let broker = QuestionBroker::new(
        "session-a".into(),
        "run-a".into(),
        cancel,
        Arc::new(|_| Err("storage unavailable".into())),
    );
    assert!(matches!(
        broker.begin("tool-a", question()),
        Err(QuestionError::Journal(_))
    ));
    assert!(broker.pending().is_empty());
    assert!(observed_cancel.is_cancelled());
}

#[tokio::test]
async fn failed_answer_journal_preserves_pending_request_and_does_not_deliver() {
    let failed = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&failed);
    let broker = QuestionBroker::new(
        "session-a".into(),
        "run-a".into(),
        CancellationToken::new(),
        Arc::new(move |_| {
            if flag.load(Ordering::SeqCst) {
                Err("storage unavailable".into())
            } else {
                Ok(())
            }
        }),
    );
    let (pending, mut rx) = broker.begin("tool-a", question()).unwrap();
    failed.store(true, Ordering::SeqCst);
    assert!(matches!(
        broker.answer(&pending.id, None, Some("File".into())),
        Err(QuestionError::Journal(_))
    ));
    assert_eq!(broker.pending().len(), 1);
    assert!(matches!(
        rx.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    failed.store(false, Ordering::SeqCst);
    broker
        .answer(&pending.id, None, Some("File".into()))
        .unwrap();
    assert_eq!(rx.await.unwrap(), Some("File".into()));
}

#[tokio::test]
async fn question_tool_observes_cancellation_and_cleans_up() {
    let (broker, _) = setup();
    let tool = AskUserTool::new(Arc::clone(&broker));
    let mut ctx = ToolContext::new(".");
    ctx.session_id = "session-a".into();
    ctx.tool_use_id = "tool-a".into();
    let cancel = ctx.cancel.clone();
    let task = tokio::spawn(async move { tool.call(&ctx, json!({"prompt":"Continue?"})).await });
    for _ in 0..100 {
        if !broker.pending().is_empty() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(broker.pending().len(), 1);
    cancel.cancel();
    assert!(matches!(task.await.unwrap(), Err(HarnessError::Cancelled)));
    assert!(broker.pending().is_empty());
}

#[tokio::test]
async fn tool_requires_its_own_session_and_preserves_user_cancel_as_result() {
    let (broker, events) = setup();
    let tool = AskUserTool::new(Arc::clone(&broker));
    let mut ctx = ToolContext::new(".");
    ctx.session_id = "session-b".into();
    ctx.tool_use_id = "tool-a".into();
    let out = tool
        .call(&ctx, json!({"prompt":"Continue?"}))
        .await
        .unwrap();
    assert!(out.is_error);
    assert!(events.lock().unwrap().is_empty());
    ctx.session_id = "session-a".into();
    let task = tokio::spawn(async move { tool.call(&ctx, json!({"prompt":"Continue?"})).await });
    for _ in 0..100 {
        if !broker.pending().is_empty() {
            break;
        }
        tokio::task::yield_now().await;
    }
    let pending = broker.pending().pop().unwrap();
    broker.answer(&pending.id, None, None).unwrap();
    let out = task.await.unwrap().unwrap();
    assert!(!out.is_error);
    let raw = serde_json::to_value(&out).unwrap();
    assert!(raw.to_string().contains("cancelled"));
}
