//! Framework-independent state and approval channels for one active agent run.
//!
//! Hosts retain responsibility for admission, journaling decisions before
//! delivery, lifecycle finalization and effect reconciliation. Cancellation is
//! a request, not proof that an already authorized external effect has stopped.

use std::path::PathBuf;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

use async_trait::async_trait;
use dashmap::DashMap;
use tokio::sync::{oneshot, Mutex};

use crate::agent::{
    AgentEvent, ApprovalDecision, ApprovalRequest, Approver, EventSink, SteerQueue,
};
use crate::permission::PermissionPolicy;
use crate::user_input::QuestionBroker;
use crate::CancellationToken;

/// Shared control state used by a host's existing agent execution loop.
///
/// These fields preserve the compatibility host's control contract. They do
/// not independently authorize provider dispatch or create a second executor.
pub struct ActiveRun {
    pub cwd: PathBuf,
    pub cancel: CancellationToken,
    pub steer: SteerQueue,
    pub policy: Arc<Mutex<PermissionPolicy>>,
    pub approvals: Arc<DashMap<String, oneshot::Sender<ApprovalDecision>>>,
    pub questions: Arc<QuestionBroker>,
    /// For each approval currently asked: the ids queued behind it.
    pub queued: Arc<DashMap<String, Vec<String>>>,
    /// Decisions already made for approvals that have not been asked yet
    /// ("allow all pending" / "deny all pending").
    pub batch: Arc<DashMap<String, ApprovalDecision>>,
    /// `policy.rules[..base_len]` are global and project rules; the rest belong
    /// to the session.
    pub base_len: AtomicUsize,
}

/// Parks each approval request until its host answers it.
///
/// The answer sender is installed before the actionable event is published,
/// allowing synchronous host responses. A dropped sender or cancellation
/// resolves to denial. Hosts must supply a journal-gated event sink and persist
/// decisions before sending them; this type does not own durable storage.
pub struct ChannelApprover {
    pub approvals: Arc<DashMap<String, oneshot::Sender<ApprovalDecision>>>,
    pub queued: Arc<DashMap<String, Vec<String>>>,
    pub batch: Arc<DashMap<String, ApprovalDecision>>,
    pub events: Arc<dyn EventSink>,
    pub cancel: CancellationToken,
}

/// Owns the two volatile indexes for one pending request.
///
/// The request future can be dropped by a task abort before its `await`
/// continuation runs. Keeping cleanup in `Drop` makes that path equivalent to
/// the normal cancellation and sender-drop paths. This only removes UI
/// bookkeeping; it does not revoke an effect already authorized elsewhere.
struct PendingApprovalGuard {
    approvals: Arc<DashMap<String, oneshot::Sender<ApprovalDecision>>>,
    queued: Arc<DashMap<String, Vec<String>>>,
    id: String,
}

impl Drop for PendingApprovalGuard {
    fn drop(&mut self) {
        self.approvals.remove(&self.id);
        self.queued.remove(&self.id);
    }
}

#[async_trait]
impl Approver for ChannelApprover {
    async fn request(&self, request: ApprovalRequest) -> ApprovalDecision {
        let id = request.tool_use_id.clone();
        // The agent loop asks in order, so batch decisions are consumed in
        // exactly the order of the queue.
        if let Some((_, decision)) = self.batch.remove(&id) {
            return decision;
        }
        let (tx, rx) = oneshot::channel();
        self.queued.insert(
            id.clone(),
            request
                .remaining
                .iter()
                .map(|next| next.tool_use_id.clone())
                .collect(),
        );
        self.approvals.insert(id.clone(), tx);
        let _pending = PendingApprovalGuard {
            approvals: Arc::clone(&self.approvals),
            queued: Arc::clone(&self.queued),
            id,
        };
        self.events.emit(AgentEvent::ApprovalRequested { request });
        let decision = tokio::select! {
            result = rx => result.unwrap_or(ApprovalDecision::Deny { feedback: None }),
            _ = self.cancel.cancelled() => ApprovalDecision::Deny { feedback: None },
        };
        decision
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::ApprovalPreview;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn request(id: &str) -> ApprovalRequest {
        ApprovalRequest {
            tool_use_id: id.into(),
            tool: "fixture-tool".into(),
            input: json!({}),
            summary: "fixture".into(),
            ordinal: 1,
            total: 1,
            remaining: Vec::new(),
        }
    }

    fn approver(events: Arc<dyn EventSink>) -> ChannelApprover {
        ChannelApprover {
            approvals: Arc::default(),
            queued: Arc::default(),
            batch: Arc::default(),
            events,
            cancel: CancellationToken::new(),
        }
    }

    #[tokio::test]
    async fn synchronous_response_is_available_during_publication() {
        let approvals = Arc::new(DashMap::new());
        let channels = Arc::clone(&approvals);
        let events: Arc<dyn EventSink> = Arc::new(move |event: AgentEvent| {
            if let AgentEvent::ApprovalRequested { request } = event {
                let (_, sender): (_, oneshot::Sender<ApprovalDecision>) = channels
                    .remove(&request.tool_use_id)
                    .expect("answer sender must precede publication");
                sender.send(ApprovalDecision::AllowOnce).unwrap();
            }
        });
        let mut control = approver(events);
        control.approvals = approvals;
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            control.request(request("immediate")),
        )
        .await
        .expect("immediate approval must finish");
        assert_eq!(result, ApprovalDecision::AllowOnce);
        assert!(control.approvals.is_empty());
        assert!(control.queued.is_empty());
    }

    #[tokio::test]
    async fn cancellation_of_pending_request_denies_and_cleans_channels() {
        let (published, mut events) = tokio::sync::mpsc::unbounded_channel();
        let control = Arc::new(approver(Arc::new(move |event| {
            published.send(event).unwrap();
        })));
        let pending_control = Arc::clone(&control);
        let pending =
            tokio::spawn(async move { pending_control.request(request("pending")).await });
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), events.recv())
                .await
                .expect("request must be published"),
            Some(AgentEvent::ApprovalRequested { .. })
        ));
        assert!(control.approvals.contains_key("pending"));
        assert!(control.queued.contains_key("pending"));
        control.cancel.cancel();
        let result = tokio::time::timeout(Duration::from_secs(2), pending)
            .await
            .expect("cancel must release approval")
            .unwrap();
        assert_eq!(result, ApprovalDecision::Deny { feedback: None });
        assert!(control.approvals.is_empty());
        assert!(control.queued.is_empty());
    }

    #[tokio::test]
    async fn abort_pending_request_cleans_channels() {
        let (published, mut events) = tokio::sync::mpsc::unbounded_channel();
        let control = Arc::new(approver(Arc::new(move |event| {
            published.send(event).unwrap();
        })));
        let pending_control = Arc::clone(&control);
        let pending =
            tokio::spawn(async move { pending_control.request(request("aborted")).await });
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), events.recv())
                .await
                .expect("request must be published"),
            Some(AgentEvent::ApprovalRequested { .. })
        ));
        assert!(control.approvals.contains_key("aborted"));
        assert!(control.queued.contains_key("aborted"));
        pending.abort();
        let join = tokio::time::timeout(Duration::from_secs(2), pending)
            .await
            .expect("aborted request must terminate");
        assert!(join.is_err(), "task abort should report cancellation");
        assert!(control.approvals.is_empty());
        assert!(control.queued.is_empty());
    }

    #[tokio::test]
    async fn dropped_sender_denies_and_cleans_channels() {
        let approvals = Arc::new(DashMap::<String, oneshot::Sender<ApprovalDecision>>::new());
        let channels = Arc::clone(&approvals);
        let events: Arc<dyn EventSink> = Arc::new(move |event: AgentEvent| {
            if let AgentEvent::ApprovalRequested { request } = event {
                drop(
                    channels
                        .remove(&request.tool_use_id)
                        .expect("request sender installed"),
                );
            }
        });
        let mut control = approver(events);
        control.approvals = approvals;
        let result =
            tokio::time::timeout(Duration::from_secs(2), control.request(request("dropped")))
                .await
                .expect("dropped sender must release approval");
        assert_eq!(result, ApprovalDecision::Deny { feedback: None });
        assert!(control.approvals.is_empty());
        assert!(control.queued.is_empty());
    }

    #[tokio::test]
    async fn batch_decisions_are_consumed_by_id_without_publication() {
        let event_count = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&event_count);
        let control = approver(Arc::new(move |_| {
            count.fetch_add(1, Ordering::SeqCst);
        }));
        let denied = ApprovalDecision::Deny {
            feedback: Some("user batch decision".into()),
        };
        control
            .batch
            .insert("first".into(), ApprovalDecision::AllowOnce);
        control.batch.insert("second".into(), denied.clone());
        assert_eq!(
            control.request(request("first")).await,
            ApprovalDecision::AllowOnce
        );
        assert!(!control.batch.contains_key("first"));
        assert!(control.batch.contains_key("second"));
        assert_eq!(control.request(request("second")).await, denied);
        assert!(control.batch.is_empty());
        assert_eq!(event_count.load(Ordering::SeqCst), 0);
        assert!(control.approvals.is_empty());
        assert!(control.queued.is_empty());
    }

    #[tokio::test]
    async fn queued_approval_order_is_visible_before_event_and_then_removed() {
        let approvals = Arc::new(DashMap::<String, oneshot::Sender<ApprovalDecision>>::new());
        let queued = Arc::new(DashMap::<String, Vec<String>>::new());
        let channels = Arc::clone(&approvals);
        let queues = Arc::clone(&queued);
        let events: Arc<dyn EventSink> = Arc::new(move |event: AgentEvent| {
            if let AgentEvent::ApprovalRequested { request } = event {
                assert_eq!(
                    queues.get(&request.tool_use_id).unwrap().value(),
                    &vec!["second".to_owned(), "third".to_owned()]
                );
                let (_, sender) = channels.remove(&request.tool_use_id).unwrap();
                sender.send(ApprovalDecision::AllowOnce).unwrap();
            }
        });
        let mut control = approver(events);
        control.approvals = approvals;
        control.queued = queued;
        let mut first = request("first");
        first.total = 3;
        first.remaining = ["second", "third"]
            .into_iter()
            .map(|id| ApprovalPreview {
                tool_use_id: id.into(),
                tool: "fixture-tool".into(),
                input: json!({}),
                summary: "queued fixture".into(),
            })
            .collect();
        let result = tokio::time::timeout(Duration::from_secs(2), control.request(first))
            .await
            .expect("ordered approval must finish");
        assert_eq!(result, ApprovalDecision::AllowOnce);
        assert!(control.approvals.is_empty());
        assert!(control.queued.is_empty());
    }
}
