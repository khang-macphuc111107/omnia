use std::sync::Mutex;

use omnia_core::{now_epoch_ms, SecretRedactor};
use serde::Serialize;
use serde_json::{json, Value};

/// Classification of an incoming mid-run steer directive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SteerMode {
    /// Default mode (`ADDITIVE_INTAKE`): preserves all active/queued items untouched.
    AdditiveIntake,
    /// Applies a boundary/correctness refinement alongside existing unfinished items.
    BoundaryCorrection,
    /// Explicitly targets a named item for cancellation or supersession.
    ExplicitStopOrReplace,
}

impl SteerMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AdditiveIntake => "ADDITIVE_INTAKE",
            Self::BoundaryCorrection => "BOUNDARY_CORRECTION",
            Self::ExplicitStopOrReplace => "EXPLICIT_STOP_OR_REPLACE",
        }
    }
}

/// Lifecycle state of one steer item in [`SteerQueue`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SteerStatus {
    Queued,
    InProgress,
    Completed,
    Cancelled,
    Superseded,
}

impl SteerStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Superseded => "superseded",
        }
    }

    #[must_use]
    pub const fn is_unfinished(self) -> bool {
        matches!(self, Self::Queued | Self::InProgress)
    }
}

/// Queued steer directive stored inside [`SteerQueue`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SteerItem {
    pub id: String,
    pub seq: u64,
    pub text: String,
    pub mode: SteerMode,
    pub status: SteerStatus,
    pub created_at_ms: i64,
    pub reconciliation_note: Option<String>,
    pub superseded_by: Option<String>,
}

impl SteerItem {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "id": self.id,
            "seq": self.seq,
            "text": SecretRedactor::redact(&self.text),
            "mode": self.mode.as_str(),
            "status": self.status.as_str(),
            "created_at_ms": self.created_at_ms,
            "reconciliation_note": self.reconciliation_note.as_deref().map(SecretRedactor::redact),
            "superseded_by": self.superseded_by,
        }))
    }
}

impl Serialize for SteerItem {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

#[derive(Debug, Default)]
struct SteerInner {
    next_seq: u64,
    items: Vec<SteerItem>,
}

/// Zero-drop additive steer queue (`ADDITIVE_INTAKE`).
///
/// Follow-up prompts append to the queue without disturbing `InProgress` or `Queued`
/// work, and `token_budget()` ALWAYS remains `None`.
#[derive(Debug, Default)]
pub struct SteerQueue {
    inner: Mutex<SteerInner>,
}

impl SteerQueue {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Active goals never carry an unrequested budget ceiling.
    #[must_use]
    pub const fn token_budget(&self) -> Option<u64> {
        None
    }

    pub fn enqueue(&self, text: &str, mode: SteerMode, now_ms: Option<i64>) -> SteerItem {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.next_seq = guard.next_seq.saturating_add(1);
        let seq = guard.next_seq;
        let item = SteerItem {
            id: format!("steer-{seq}"),
            seq,
            text: text.to_owned(),
            mode,
            status: SteerStatus::Queued,
            created_at_ms: now_ms.unwrap_or_else(now_epoch_ms),
            reconciliation_note: None,
            superseded_by: None,
        };
        guard.items.push(item.clone());
        item
    }

    pub fn mark_status(&self, id: &str, status: SteerStatus) -> bool {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(item) = guard.items.iter_mut().find(|it| it.id == id) {
            item.status = status;
            true
        } else {
            false
        }
    }

    /// Explicitly cancel or supersede a single named item without disturbing any other
    /// unfinished backlog entries.
    pub fn reconcile_cancel_or_supersede(
        &self,
        target_id: &str,
        replacement_id: Option<&str>,
        reason: &str,
    ) -> bool {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(target) = guard.items.iter_mut().find(|it| it.id == target_id) else {
            return false;
        };
        if let Some(rep) = replacement_id {
            target.status = SteerStatus::Superseded;
            target.superseded_by = Some(rep.to_owned());
        } else {
            target.status = SteerStatus::Cancelled;
        }
        target.reconciliation_note = Some(reason.to_owned());
        true
    }

    #[must_use]
    pub fn active_backlog_count(&self) -> usize {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard
            .items
            .iter()
            .filter(|it| it.status.is_unfinished())
            .count()
    }

    #[must_use]
    pub fn items(&self) -> Vec<SteerItem> {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.items.clone()
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        let items: Vec<Value> = self.items().iter().map(SteerItem::to_json).collect();
        SecretRedactor::redact_json(&json!({
            "token_budget": self.token_budget(),
            "active_backlog_count": self.active_backlog_count(),
            "items": items,
        }))
    }
}

impl Serialize for SteerQueue {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}
