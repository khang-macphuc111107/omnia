//! CodexPatched session/rollout JSONL, goal ledger, and zero-drop `ADDITIVE_INTAKE`
//! steer-queue contracts, including strict `token_budget: Option<u64>` enforcement
//! (`None` unless explicitly user-requested) and secret/PII/home-path redaction.

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use serde::{Serialize, Serializer};
use serde_json::{json, Map, Value};
use thiserror::Error;

use crate::{
    find_unsafe_prototype_key, has_bidi_controls, has_control_chars, impl_str_enum_serde,
    redact_emails, redact_json_value, redact_private_disk_paths, redact_secrets_in_text,
    strip_bidi_controls,
};

const MAX_ROLLOUT_LINE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ROLLOUT_LINES: usize = 50_000;
const MAX_THREAD_ID_LEN: usize = 240;

const RESERVED_CLIENT_METADATA_KEYS: &[&str] = &[
    "token_budget",
    "tokenbudget",
    "bypass_approval",
    "bypass_sandbox",
    "force_complete",
    "drop_queue",
    "internal_override",
    "__proto__",
    "constructor",
    "prototype",
];

/// Errors produced by CodexPatched ledger, rollout, and steer-queue validators.
#[derive(Debug, Error)]
pub enum CodexPatchedError {
    #[error("invalid JSON in CodexPatched payload: {0}")]
    InvalidJson(String),
    #[error("unsafe prototype key at '{0}'")]
    UnsafePrototypeKey(String),
    #[error("implicit or unauthorized non-null token_budget rejected for goal '{goal_id}'")]
    ImplicitTokenBudgetForbidden { goal_id: String },
    #[error("invalid goal ledger contract: {0}")]
    InvalidGoal(String),
    #[error("queue invariant violated: {0}")]
    QueueInvariant(String),
    #[error("invalid turn steer payload: {0}")]
    InvalidTurnSteer(String),
}

/// Lifecycle status of a tracked goal in a CodexPatched goal ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GoalStatus {
    Pending,
    InProgress,
    Blocked,
    Completed,
    Cancelled,
}

impl GoalStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Blocked => "blocked",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }

    #[must_use]
    pub const fn is_unfinished(self) -> bool {
        matches!(self, Self::Pending | Self::InProgress | Self::Blocked)
    }
}

impl FromStr for GoalStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "pending" | "queued" => Ok(Self::Pending),
            "in_progress" | "running" | "active" => Ok(Self::InProgress),
            "blocked" | "paused" => Ok(Self::Blocked),
            "completed" | "done" => Ok(Self::Completed),
            "cancelled" | "canceled" => Ok(Self::Cancelled),
            other => Err(format!("unknown goal status '{other}'")),
        }
    }
}

impl_str_enum_serde!(GoalStatus);

/// Steer mode governing how an arriving prompt affects the active queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SteerMode {
    AdditiveIntake,
    BoundaryCorrection,
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

impl FromStr for SteerMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let norm = s.trim().to_ascii_uppercase().replace('-', "_");
        match norm.as_str() {
            "ADDITIVE_INTAKE" | "ADDITIVE" => Ok(Self::AdditiveIntake),
            "BOUNDARY_CORRECTION" | "CORRECTION" => Ok(Self::BoundaryCorrection),
            "EXPLICIT_STOP_OR_REPLACE" | "STOP_OR_REPLACE" | "REPLACE" => {
                Ok(Self::ExplicitStopOrReplace)
            }
            other => Err(format!("unknown steer mode '{other}'")),
        }
    }
}

impl_str_enum_serde!(SteerMode);

/// Status of an item inside the zero-drop `ADDITIVE_INTAKE` queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum QueueItemStatus {
    Queued,
    InProgress,
    Paused,
    Completed,
    Superseded,
    Cancelled,
}

impl QueueItemStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::InProgress => "in_progress",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Superseded => "superseded",
            Self::Cancelled => "cancelled",
        }
    }

    #[must_use]
    pub const fn is_active_or_queued(self) -> bool {
        matches!(self, Self::Queued | Self::InProgress | Self::Paused)
    }
}

impl FromStr for QueueItemStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "queued" | "pending" => Ok(Self::Queued),
            "in_progress" | "running" | "active" => Ok(Self::InProgress),
            "paused" | "interrupted" => Ok(Self::Paused),
            "completed" | "done" => Ok(Self::Completed),
            "superseded" | "replaced" => Ok(Self::Superseded),
            "cancelled" | "canceled" => Ok(Self::Cancelled),
            other => Err(format!("unknown queue item status '{other}'")),
        }
    }
}

impl_str_enum_serde!(QueueItemStatus);

/// Tracked goal entry enforcing `token_budget: Option<u64>` stays `None` unless user-explicit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalRecord {
    pub id: String,
    pub title: String,
    pub status: GoalStatus,
    /// MUST stay `None` unless `explicit_user_budget == true` and `> 0`.
    pub token_budget: Option<u64>,
    pub explicit_user_budget: bool,
    pub created_at: Option<String>,
    pub metadata: Map<String, Value>,
    pub redacted_fields: Vec<String>,
}

impl GoalRecord {
    /// Creates a new goal with `token_budget = None` by default.
    #[must_use]
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        let mut redactions = BTreeSet::new();
        let cleaned_title = sanitize_text_for_ledger(&title.into(), "title", &mut redactions);
        Self {
            id: id.into().trim().to_string(),
            title: cleaned_title,
            status: GoalStatus::Pending,
            token_budget: None,
            explicit_user_budget: false,
            created_at: None,
            metadata: Map::new(),
            redacted_fields: redactions.into_iter().collect(),
        }
    }

    /// Sets an explicit user-authorized token budget (`> 0`), or clears it back to `None`.
    pub fn set_user_token_budget(&mut self, budget: Option<u64>) -> Result<(), CodexPatchedError> {
        match budget {
            None => {
                self.token_budget = None;
                self.explicit_user_budget = false;
                Ok(())
            }
            Some(0) => Err(CodexPatchedError::InvalidGoal(
                "explicit token_budget must be greater than zero".into(),
            )),
            Some(val) => {
                self.token_budget = Some(val);
                self.explicit_user_budget = true;
                Ok(())
            }
        }
    }

    /// Verifies the goal respects the no-artificial-cap invariant.
    pub fn verify_budget_invariant(&self) -> Result<(), CodexPatchedError> {
        match (self.token_budget, self.explicit_user_budget) {
            (None, _) => Ok(()),
            (Some(0), _) => Err(CodexPatchedError::InvalidGoal(format!(
                "goal '{}' has invalid zero token_budget",
                self.id
            ))),
            (Some(_), true) => Ok(()),
            (Some(_), false) => Err(CodexPatchedError::ImplicitTokenBudgetForbidden {
                goal_id: self.id.clone(),
            }),
        }
    }
}

impl Serialize for GoalRecord {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let effective_budget = if self.explicit_user_budget {
            self.token_budget
        } else {
            None
        };
        json!({
            "id": self.id,
            "title": self.title,
            "status": self.status,
            "token_budget": effective_budget,
            "explicit_user_budget": self.explicit_user_budget && effective_budget.is_some(),
            "created_at": self.created_at,
            "metadata": self.metadata,
            "redacted_fields": self.redacted_fields,
        })
        .serialize(serializer)
    }
}

/// Item stored inside `AdditiveSteerQueue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdditiveQueueItem {
    pub seq: u64,
    pub item_id: String,
    pub goal_id: String,
    pub mode: SteerMode,
    pub status: QueueItemStatus,
    pub supersedes_item_id: Option<String>,
    pub prompt: String,
    pub created_at: Option<String>,
    pub redacted_fields: Vec<String>,
}

impl Serialize for AdditiveQueueItem {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "seq": self.seq,
            "item_id": self.item_id,
            "goal_id": self.goal_id,
            "mode": self.mode,
            "status": self.status,
            "supersedes_item_id": self.supersedes_item_id,
            "prompt": self.prompt,
            "created_at": self.created_at,
            "redacted_fields": self.redacted_fields,
        })
        .serialize(serializer)
    }
}

/// Zero-drop `ADDITIVE_INTAKE` queue preserving strict monotonic sequence ordering.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AdditiveSteerQueue {
    items: Vec<AdditiveQueueItem>,
    next_seq: u64,
}

impl AdditiveSteerQueue {
    #[must_use]
    pub fn new() -> Self {
        Self {
            items: Vec::new(),
            next_seq: 1,
        }
    }

    /// Returns items in strict ascending monotonic `seq` order.
    #[must_use]
    pub fn items(&self) -> &[AdditiveQueueItem] {
        &self.items
    }

    /// Appends an additive item without cancelling, dropping, or overwriting any existing item.
    pub fn enqueue_additive(
        &mut self,
        item_id: impl Into<String>,
        goal_id: impl Into<String>,
        prompt: impl Into<String>,
        created_at: Option<String>,
    ) -> Result<&AdditiveQueueItem, CodexPatchedError> {
        self.apply_steer(
            item_id,
            goal_id,
            SteerMode::AdditiveIntake,
            None,
            prompt,
            created_at,
        )
    }

    /// Applies a steer event according to `SteerMode` without ever silently dropping backlog.
    pub fn apply_steer(
        &mut self,
        item_id: impl Into<String>,
        goal_id: impl Into<String>,
        mode: SteerMode,
        supersedes_item_id: Option<String>,
        prompt: impl Into<String>,
        created_at: Option<String>,
    ) -> Result<&AdditiveQueueItem, CodexPatchedError> {
        let item_id = item_id.into().trim().to_string();
        let goal_id = goal_id.into().trim().to_string();
        if item_id.is_empty() || has_control_chars(&item_id) || has_bidi_controls(&item_id) {
            return Err(CodexPatchedError::QueueInvariant(
                "queue item_id must be non-empty and free of control characters".into(),
            ));
        }
        if goal_id.is_empty() || has_control_chars(&goal_id) || has_bidi_controls(&goal_id) {
            return Err(CodexPatchedError::QueueInvariant(
                "queue goal_id must be non-empty and free of control characters".into(),
            ));
        }
        if self
            .items
            .iter()
            .any(|existing| existing.item_id == item_id)
        {
            return Err(CodexPatchedError::QueueInvariant(format!(
                "duplicate queue item_id '{item_id}'"
            )));
        }

        if mode == SteerMode::ExplicitStopOrReplace {
            let target_id = supersedes_item_id.as_deref().ok_or_else(|| {
                CodexPatchedError::QueueInvariant(
                    "EXPLICIT_STOP_OR_REPLACE requires supersedes_item_id naming target item"
                        .into(),
                )
            })?;
            let target = self
                .items
                .iter_mut()
                .find(|existing| existing.item_id == target_id)
                .ok_or_else(|| {
                    CodexPatchedError::QueueInvariant(format!(
                        "EXPLICIT_STOP_OR_REPLACE target '{target_id}' not found in queue"
                    ))
                })?;
            target.status = QueueItemStatus::Superseded;
        }

        let mut redactions = BTreeSet::new();
        let cleaned_prompt = sanitize_text_for_ledger(&prompt.into(), "prompt", &mut redactions);
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);

        self.items.push(AdditiveQueueItem {
            seq,
            item_id,
            goal_id,
            mode,
            status: QueueItemStatus::Queued,
            supersedes_item_id,
            prompt: cleaned_prompt,
            created_at,
            redacted_fields: redactions.into_iter().collect(),
        });
        Ok(self.items.last().expect("item just pushed"))
    }

    /// Transitions a specific item's status without disturbing sibling queued items.
    pub fn set_status(
        &mut self,
        item_id: &str,
        status: QueueItemStatus,
    ) -> Result<(), CodexPatchedError> {
        let item = self
            .items
            .iter_mut()
            .find(|i| i.item_id == item_id)
            .ok_or_else(|| {
                CodexPatchedError::QueueInvariant(format!("unknown queue item_id '{item_id}'"))
            })?;
        item.status = status;
        Ok(())
    }

    /// Counts items still pending execution or currently running/paused.
    #[must_use]
    pub fn unfinished_count(&self) -> usize {
        self.items
            .iter()
            .filter(|i| i.status.is_active_or_queued())
            .count()
    }
}

impl Serialize for AdditiveSteerQueue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "next_seq": self.next_seq,
            "unfinished_count": self.unfinished_count(),
            "items": self.items,
        })
        .serialize(serializer)
    }
}

/// Complete goal + zero-drop queue ledger for a CodexPatched session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexGoalQueueLedger {
    pub thread_id: String,
    pub goals: Vec<GoalRecord>,
    pub queue: AdditiveSteerQueue,
    pub redacted_fields: Vec<String>,
}

impl Serialize for CodexGoalQueueLedger {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "thread_id": self.thread_id,
            "goals": self.goals,
            "queue": self.queue,
            "redacted_fields": self.redacted_fields,
        })
        .serialize(serializer)
    }
}

/// Parses and validates a single `GoalRecord` JSON object, rejecting implicit `token_budget`.
pub fn parse_goal_record(raw: &Value) -> Result<GoalRecord, CodexPatchedError> {
    if let Some(path) = find_unsafe_prototype_key(raw, "$") {
        return Err(CodexPatchedError::UnsafePrototypeKey(path));
    }
    let obj = raw
        .as_object()
        .ok_or_else(|| CodexPatchedError::InvalidGoal("goal record must be an object".into()))?;
    let id = required_clean_str(obj, &["id", "goal_id", "goalId"], "goal.id")?;
    let title_raw = required_clean_str(obj, &["title", "description", "summary"], "goal.title")?;
    let status = match obj.get("status").and_then(Value::as_str) {
        Some(s) => GoalStatus::from_str(s).map_err(CodexPatchedError::InvalidGoal)?,
        None => GoalStatus::Pending,
    };

    let explicit_user_budget = obj
        .get("explicit_user_budget")
        .or_else(|| obj.get("explicitUserBudget"))
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            obj.get("token_budget_source")
                .or_else(|| obj.get("tokenBudgetSource"))
                .and_then(Value::as_str)
                .map(|s| s.eq_ignore_ascii_case("user_explicit"))
                .unwrap_or(false)
        });

    let token_budget = match obj.get("token_budget").or_else(|| obj.get("tokenBudget")) {
        None | Some(Value::Null) => None,
        Some(val) => {
            let num = val.as_u64().ok_or_else(|| {
                CodexPatchedError::InvalidGoal(
                    "token_budget must be null or positive integer".into(),
                )
            })?;
            if !explicit_user_budget {
                return Err(CodexPatchedError::ImplicitTokenBudgetForbidden { goal_id: id });
            }
            if num == 0 {
                return Err(CodexPatchedError::InvalidGoal(
                    "explicit token_budget must be > 0".into(),
                ));
            }
            Some(num)
        }
    };

    let mut redactions = BTreeSet::new();
    let title = sanitize_text_for_ledger(&title_raw, "title", &mut redactions);
    let created_at = obj
        .get("created_at")
        .or_else(|| obj.get("createdAt"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let metadata = match obj.get("metadata") {
        None | Some(Value::Null) => Map::new(),
        Some(meta) => {
            let (cleaned, paths) = redact_json_value(meta);
            for p in paths {
                redactions.insert(format!("metadata.{p}"));
            }
            cleaned.as_object().cloned().ok_or_else(|| {
                CodexPatchedError::InvalidGoal("goal metadata must be an object".into())
            })?
        }
    };

    Ok(GoalRecord {
        id,
        title,
        status,
        token_budget,
        explicit_user_budget: explicit_user_budget && token_budget.is_some(),
        created_at,
        metadata,
        redacted_fields: redactions.into_iter().collect(),
    })
}

/// Parses and validates a complete CodexPatched goal + `ADDITIVE_INTAKE` queue ledger JSON document.
pub fn parse_goal_queue_ledger(raw: &Value) -> Result<CodexGoalQueueLedger, CodexPatchedError> {
    if let Some(path) = find_unsafe_prototype_key(raw, "$") {
        return Err(CodexPatchedError::UnsafePrototypeKey(path));
    }
    let obj = raw
        .as_object()
        .ok_or_else(|| CodexPatchedError::InvalidGoal("ledger must be a JSON object".into()))?;
    let thread_id = required_clean_str(obj, &["thread_id", "threadId"], "thread_id")?;
    validate_thread_id(&thread_id)?;

    let mut redactions = BTreeSet::new();
    let mut goals = Vec::new();
    let mut seen_goal_ids = BTreeSet::new();
    if let Some(goal_arr) = obj.get("goals").and_then(Value::as_array) {
        for g in goal_arr {
            let parsed = parse_goal_record(g)?;
            if !seen_goal_ids.insert(parsed.id.clone()) {
                return Err(CodexPatchedError::InvalidGoal(format!(
                    "duplicate goal id '{}'",
                    parsed.id
                )));
            }
            for rf in &parsed.redacted_fields {
                redactions.insert(format!("goal.{}.{rf}", parsed.id));
            }
            goals.push(parsed);
        }
    }

    let raw_queue_items = obj
        .get("queue")
        .and_then(|q| q.get("items").or(Some(q)))
        .and_then(Value::as_array);

    let mut queue = AdditiveSteerQueue::new();
    if let Some(items) = raw_queue_items {
        let mut last_seq: Option<u64> = None;
        for (idx, item) in items.iter().enumerate() {
            let item_obj = item.as_object().ok_or_else(|| {
                CodexPatchedError::QueueInvariant(format!("queue item[{idx}] must be an object"))
            })?;
            let seq = item_obj.get("seq").and_then(Value::as_u64).ok_or_else(|| {
                CodexPatchedError::QueueInvariant(format!(
                    "queue item[{idx}] missing integer 'seq'"
                ))
            })?;
            if let Some(prev) = last_seq {
                if seq <= prev {
                    return Err(CodexPatchedError::QueueInvariant(format!(
                        "queue seq {seq} is not strictly greater than previous seq {prev}"
                    )));
                }
            }
            last_seq = Some(seq);

            let item_id = required_clean_str(item_obj, &["item_id", "itemId", "id"], "item_id")?;
            let goal_id = required_clean_str(item_obj, &["goal_id", "goalId"], "goal_id")?;
            let mode = match item_obj.get("mode").and_then(Value::as_str) {
                Some(m) => SteerMode::from_str(m).map_err(CodexPatchedError::QueueInvariant)?,
                None => SteerMode::AdditiveIntake,
            };
            let status = match item_obj.get("status").and_then(Value::as_str) {
                Some(s) => {
                    QueueItemStatus::from_str(s).map_err(CodexPatchedError::QueueInvariant)?
                }
                None => QueueItemStatus::Queued,
            };
            let supersedes = item_obj
                .get("supersedes_item_id")
                .or_else(|| item_obj.get("supersedesItemId"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);

            if mode == SteerMode::ExplicitStopOrReplace && supersedes.is_none() {
                return Err(CodexPatchedError::QueueInvariant(format!(
                    "queue item '{item_id}' uses EXPLICIT_STOP_OR_REPLACE without supersedes_item_id"
                )));
            }
            if mode == SteerMode::AdditiveIntake
                && matches!(
                    status,
                    QueueItemStatus::Cancelled | QueueItemStatus::Superseded
                )
            {
                return Err(CodexPatchedError::QueueInvariant(format!(
                    "ADDITIVE_INTAKE queue item '{item_id}' cannot be marked cancelled/superseded"
                )));
            }

            let prompt_raw =
                required_clean_str(item_obj, &["prompt", "text", "content"], "prompt")?;
            let mut item_redactions = BTreeSet::new();
            let prompt = sanitize_text_for_ledger(&prompt_raw, "prompt", &mut item_redactions);
            for rf in &item_redactions {
                redactions.insert(format!("queue.{item_id}.{rf}"));
            }

            if queue
                .items
                .iter()
                .any(|existing| existing.item_id == item_id)
            {
                return Err(CodexPatchedError::QueueInvariant(format!(
                    "duplicate queue item_id '{item_id}'"
                )));
            }

            queue.items.push(AdditiveQueueItem {
                seq,
                item_id,
                goal_id,
                mode,
                status,
                supersedes_item_id: supersedes,
                prompt,
                created_at: item_obj
                    .get("created_at")
                    .or_else(|| item_obj.get("createdAt"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                redacted_fields: item_redactions.into_iter().collect(),
            });
            queue.next_seq = seq.saturating_add(1);
        }
    }

    Ok(CodexGoalQueueLedger {
        thread_id,
        goals,
        queue,
        redacted_fields: redactions.into_iter().collect(),
    })
}

/// Validates and redacts a CodexPatched `TurnSteer` payload (`threadId`, `expectedTurnId`, `input`,
/// plus optional nested `omniaSteer` envelope), enforcing `tokenBudget: null` unless `explicitUserBudget == true`
/// and a strictly positive integer (`> 0`).
pub fn validate_turn_steer_payload(raw: &Value) -> Result<Value, CodexPatchedError> {
    if let Some(path) = find_unsafe_prototype_key(raw, "$") {
        return Err(CodexPatchedError::UnsafePrototypeKey(path));
    }
    let obj = raw.as_object().ok_or_else(|| {
        CodexPatchedError::InvalidTurnSteer("turn steer payload must be an object".into())
    })?;

    let thread_id = obj
        .get("threadId")
        .or_else(|| obj.get("thread_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| CodexPatchedError::InvalidTurnSteer("missing 'threadId'".into()))?;
    validate_thread_id(thread_id)?;

    let omnia_steer_obj = match obj.get("omniaSteer").or_else(|| obj.get("omnia_steer")) {
        None | Some(Value::Null) => None,
        Some(Value::Object(map)) => Some(map),
        Some(_) => {
            return Err(CodexPatchedError::InvalidTurnSteer(
                "'omniaSteer' must be an object when present".into(),
            ));
        }
    };

    let mode = match obj
        .get("mode")
        .or_else(|| omnia_steer_obj.and_then(|m| m.get("mode")))
        .and_then(Value::as_str)
    {
        Some(m) => SteerMode::from_str(m).map_err(CodexPatchedError::InvalidTurnSteer)?,
        None => SteerMode::AdditiveIntake,
    };

    let top_explicit = parse_optional_bool_flag(obj, "explicitUserBudget", "explicit_user_budget")?;
    let nested_explicit = match omnia_steer_obj {
        Some(m) => parse_optional_bool_flag(m, "explicitUserBudget", "explicit_user_budget")?,
        None => None,
    };
    if let (Some(a), Some(b)) = (top_explicit, nested_explicit) {
        if a != b {
            return Err(CodexPatchedError::InvalidTurnSteer(
                "conflicting explicitUserBudget flags between top-level payload and omniaSteer"
                    .into(),
            ));
        }
    }
    let explicit_budget = top_explicit.or(nested_explicit).unwrap_or(false);

    let top_budget = extract_validated_budget(obj, explicit_budget, thread_id)?;
    let nested_budget = match omnia_steer_obj {
        Some(m) => extract_validated_budget(m, explicit_budget, thread_id)?,
        None => None,
    };
    let effective_budget = match (top_budget, nested_budget) {
        (Some(a), Some(b)) if a != b => {
            return Err(CodexPatchedError::InvalidTurnSteer(
                "conflicting tokenBudget values between top-level payload and omniaSteer".into(),
            ));
        }
        (a, b) => a.or(b),
    };

    if let Some(client_meta) = obj
        .get("clientMetadata")
        .or_else(|| obj.get("client_metadata"))
        .and_then(Value::as_object)
    {
        for key in client_meta.keys() {
            let lower = key.trim().to_ascii_lowercase();
            if RESERVED_CLIENT_METADATA_KEYS.contains(&lower.as_str()) {
                return Err(CodexPatchedError::InvalidTurnSteer(format!(
                    "reserved clientMetadata key '{key}' is forbidden"
                )));
            }
        }
    }

    let input_arr = obj
        .get("input")
        .and_then(Value::as_array)
        .ok_or_else(|| CodexPatchedError::InvalidTurnSteer("'input' array is required".into()))?;
    if input_arr.is_empty() {
        return Err(CodexPatchedError::InvalidTurnSteer(
            "'input' must contain at least one item".into(),
        ));
    }

    let expected_turn_id = obj
        .get("expectedTurnId")
        .or_else(|| obj.get("expected_turn_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let (redacted_payload, redacted_fields) = redact_json_value(raw);
    Ok(json!({
        "threadId": thread_id,
        "expectedTurnId": expected_turn_id,
        "mode": mode,
        "explicitUserBudget": explicit_budget,
        "tokenBudget": effective_budget.map(|n| json!(n)).unwrap_or(Value::Null),
        "input": redacted_payload.get("input").cloned().unwrap_or_else(|| json!([])),
        "redacted_fields": redacted_fields,
    }))
}

fn parse_optional_bool_flag(
    obj: &Map<String, Value>,
    camel_key: &str,
    snake_key: &str,
) -> Result<Option<bool>, CodexPatchedError> {
    let camel = obj.get(camel_key).filter(|v| !v.is_null());
    let snake = obj.get(snake_key).filter(|v| !v.is_null());
    let parsed_camel = match camel {
        Some(v) => Some(v.as_bool().ok_or_else(|| {
            CodexPatchedError::InvalidTurnSteer(format!("'{camel_key}' must be a boolean"))
        })?),
        None => None,
    };
    let parsed_snake = match snake {
        Some(v) => Some(v.as_bool().ok_or_else(|| {
            CodexPatchedError::InvalidTurnSteer(format!("'{snake_key}' must be a boolean"))
        })?),
        None => None,
    };
    if let (Some(a), Some(b)) = (parsed_camel, parsed_snake) {
        if a != b {
            return Err(CodexPatchedError::InvalidTurnSteer(format!(
                "conflicting '{camel_key}' and '{snake_key}' flags"
            )));
        }
    }
    Ok(parsed_camel.or(parsed_snake))
}

fn extract_validated_budget(
    obj: &Map<String, Value>,
    explicit_budget: bool,
    thread_id: &str,
) -> Result<Option<u64>, CodexPatchedError> {
    let mut resolved: Option<u64> = None;
    for key in ["tokenBudget", "token_budget"] {
        let Some(val) = obj.get(key) else {
            continue;
        };
        if val.is_null() {
            continue;
        }
        if !explicit_budget {
            return Err(CodexPatchedError::ImplicitTokenBudgetForbidden {
                goal_id: thread_id.to_string(),
            });
        }
        let num = val.as_u64().ok_or_else(|| {
            CodexPatchedError::InvalidTurnSteer(format!(
                "explicit '{key}' must be a positive integer (> 0)"
            ))
        })?;
        if num == 0 {
            return Err(CodexPatchedError::InvalidTurnSteer(format!(
                "explicit '{key}' must be a positive integer (> 0)"
            )));
        }
        if let Some(prev) = resolved {
            if prev != num {
                return Err(CodexPatchedError::InvalidTurnSteer(
                    "conflicting 'tokenBudget' and 'token_budget' values".into(),
                ));
            }
        }
        resolved = Some(num);
    }
    Ok(resolved)
}

/// Single sanitized message extracted from a Codex rollout JSONL file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RolloutMessage {
    pub line_number: usize,
    pub timestamp: Option<String>,
    pub role: String,
    pub item_type: String,
    pub text: String,
    pub redacted_fields: Vec<String>,
}

impl Serialize for RolloutMessage {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "line_number": self.line_number,
            "timestamp": self.timestamp,
            "role": self.role,
            "item_type": self.item_type,
            "text": self.text,
            "redacted_fields": self.redacted_fields,
        })
        .serialize(serializer)
    }
}

/// Sanitized summary of a CodexPatched rollout JSONL session transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRolloutSession {
    pub session_id: Option<String>,
    pub thread_id: Option<String>,
    pub cwd: Option<String>,
    pub cli_version: Option<String>,
    pub model_provider: Option<String>,
    pub git_branch: Option<String>,
    pub token_usage_summary: BTreeMap<String, u64>,
    pub messages: Vec<RolloutMessage>,
    pub parsed_lines: usize,
    pub malformed_lines: usize,
    pub oversized_lines: usize,
    pub unsupported_lines: usize,
    pub redacted_fields: Vec<String>,
}

impl Serialize for ParsedRolloutSession {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "session_id": self.session_id,
            "thread_id": self.thread_id,
            "cwd": self.cwd,
            "cli_version": self.cli_version,
            "model_provider": self.model_provider,
            "git_branch": self.git_branch,
            "token_usage_summary": self.token_usage_summary,
            "messages": self.messages,
            "parsed_lines": self.parsed_lines,
            "malformed_lines": self.malformed_lines,
            "oversized_lines": self.oversized_lines,
            "unsupported_lines": self.unsupported_lines,
            "redacted_fields": self.redacted_fields,
        })
        .serialize(serializer)
    }
}

/// Parses a CodexPatched JSONL rollout stream into a secret/path-redacted summary.
pub fn parse_codex_rollout_jsonl(jsonl: &str) -> Result<ParsedRolloutSession, CodexPatchedError> {
    let mut session = ParsedRolloutSession {
        session_id: None,
        thread_id: None,
        cwd: None,
        cli_version: None,
        model_provider: None,
        git_branch: None,
        token_usage_summary: BTreeMap::new(),
        messages: Vec::new(),
        parsed_lines: 0,
        malformed_lines: 0,
        oversized_lines: 0,
        unsupported_lines: 0,
        redacted_fields: Vec::new(),
    };
    let mut all_redactions = BTreeSet::new();

    for (idx, raw_line) in jsonl.lines().enumerate() {
        let line_no = idx + 1;
        if line_no > MAX_ROLLOUT_LINES {
            session.oversized_lines += 1;
            continue;
        }
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.len() > MAX_ROLLOUT_LINE_BYTES {
            session.oversized_lines += 1;
            continue;
        }
        let val: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => {
                session.malformed_lines += 1;
                continue;
            }
        };
        if let Some(proto_path) = find_unsafe_prototype_key(&val, "$") {
            return Err(CodexPatchedError::UnsafePrototypeKey(proto_path));
        }

        let Some(obj) = val.as_object() else {
            session.malformed_lines += 1;
            continue;
        };
        let timestamp = obj
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);
        let record_type = obj.get("type").and_then(Value::as_str).unwrap_or_default();
        let payload = obj.get("payload").unwrap_or(&val);

        match record_type {
            "session_meta" => {
                session.parsed_lines += 1;
                if let Some(p) = payload.as_object() {
                    session.session_id = session.session_id.take().or_else(|| {
                        p.get("id")
                            .or_else(|| p.get("session_id"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
                    session.thread_id = session.thread_id.take().or_else(|| {
                        p.get("thread_id")
                            .or_else(|| p.get("threadId"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
                    if let Some(cwd_raw) = p.get("cwd").and_then(Value::as_str) {
                        let (cleaned_cwd, changed) = redact_private_disk_paths(cwd_raw);
                        if changed {
                            all_redactions.insert(format!("line_{line_no}.session_meta.cwd"));
                        }
                        session.cwd = Some(cleaned_cwd);
                    }
                    session.cli_version = session.cli_version.take().or_else(|| {
                        p.get("cli_version")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
                    session.model_provider = session.model_provider.take().or_else(|| {
                        p.get("model_provider")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
                    session.git_branch = session.git_branch.take().or_else(|| {
                        p.get("git")
                            .and_then(|g| g.get("branch"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
                }
            }
            "event_msg" => {
                session.parsed_lines += 1;
                if let Some(p) = payload.as_object() {
                    let ev_kind = p.get("type").and_then(Value::as_str).unwrap_or_default();
                    if ev_kind == "token_count" {
                        if let Some(info) = p.get("info").and_then(Value::as_object) {
                            for (k, v) in info {
                                if let Some(n) = v.as_u64() {
                                    session.token_usage_summary.insert(k.clone(), n);
                                }
                            }
                        }
                    } else if ev_kind == "item_completed" {
                        if let Some(item) = p.get("item").and_then(Value::as_object) {
                            let item_type = item
                                .get("type")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown")
                                .to_string();
                            let role = if item_type.eq_ignore_ascii_case("UserMessage") {
                                "user"
                            } else {
                                "assistant"
                            }
                            .to_string();
                            if let Some(raw_text) = extract_rollout_item_text(item) {
                                let mut msg_redactions = BTreeSet::new();
                                let cleaned = sanitize_text_for_ledger(
                                    &raw_text,
                                    "text",
                                    &mut msg_redactions,
                                );
                                for r in &msg_redactions {
                                    all_redactions.insert(format!("line_{line_no}.{r}"));
                                }
                                session.messages.push(RolloutMessage {
                                    line_number: line_no,
                                    timestamp,
                                    role,
                                    item_type,
                                    text: cleaned,
                                    redacted_fields: msg_redactions.into_iter().collect(),
                                });
                            }
                        }
                    }
                }
            }
            "response_item" => {
                session.parsed_lines += 1;
                if let Some(p) = payload.as_object() {
                    let role = p
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("assistant")
                        .to_string();
                    let item_type = p
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("message")
                        .to_string();
                    if let Some(raw_text) = extract_rollout_item_text(p) {
                        let mut msg_redactions = BTreeSet::new();
                        let cleaned =
                            sanitize_text_for_ledger(&raw_text, "text", &mut msg_redactions);
                        for r in &msg_redactions {
                            all_redactions.insert(format!("line_{line_no}.{r}"));
                        }
                        session.messages.push(RolloutMessage {
                            line_number: line_no,
                            timestamp,
                            role,
                            item_type,
                            text: cleaned,
                            redacted_fields: msg_redactions.into_iter().collect(),
                        });
                    }
                }
            }
            "turn_context" => {
                session.parsed_lines += 1;
                if let Some(p) = payload.as_object() {
                    if let Some(cwd_raw) = p.get("cwd").and_then(Value::as_str) {
                        let (cleaned_cwd, changed) = redact_private_disk_paths(cwd_raw);
                        if changed {
                            all_redactions.insert(format!("line_{line_no}.turn_context.cwd"));
                        }
                        session.cwd = Some(cleaned_cwd);
                    }
                }
            }
            _ => {
                session.unsupported_lines += 1;
            }
        }
    }

    session.redacted_fields = all_redactions.into_iter().collect();
    Ok(session)
}

fn validate_thread_id(thread_id: &str) -> Result<(), CodexPatchedError> {
    if thread_id.is_empty()
        || thread_id.len() > MAX_THREAD_ID_LEN
        || has_control_chars(thread_id)
        || has_bidi_controls(thread_id)
        || thread_id.chars().any(char::is_whitespace)
    {
        return Err(CodexPatchedError::InvalidTurnSteer(
            "threadId must be non-empty, <= 240 chars, and contain no whitespace or controls"
                .into(),
        ));
    }
    Ok(())
}

fn required_clean_str(
    obj: &Map<String, Value>,
    keys: &[&str],
    label: &str,
) -> Result<String, CodexPatchedError> {
    let s = keys
        .iter()
        .find_map(|k| obj.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| CodexPatchedError::InvalidGoal(format!("missing required '{label}'")))?;
    if has_control_chars(s) || has_bidi_controls(s) {
        return Err(CodexPatchedError::InvalidGoal(format!(
            "'{label}' contains disallowed control or bidi characters"
        )));
    }
    Ok(s.to_string())
}

fn sanitize_text_for_ledger(raw: &str, field: &str, redactions: &mut BTreeSet<String>) -> String {
    let (no_bidi, bidi_changed) = strip_bidi_controls(raw);
    if bidi_changed {
        redactions.insert(format!("{field}:bidi_stripped"));
    }
    let (no_secrets, secret_kinds) = redact_secrets_in_text(&no_bidi);
    for k in secret_kinds {
        redactions.insert(format!("{field}:{k}"));
    }
    let (no_paths, paths_changed) = redact_private_disk_paths(&no_secrets);
    if paths_changed {
        redactions.insert(format!("{field}:private_disk_path"));
    }
    let (no_emails, email_changed) = redact_emails(&no_paths);
    if email_changed {
        redactions.insert(format!("{field}:email"));
    }
    no_emails
}

fn extract_rollout_item_text(obj: &Map<String, Value>) -> Option<String> {
    if let Some(t) = obj.get("text").and_then(Value::as_str) {
        return Some(t.to_string());
    }
    let content = obj.get("content")?.as_array()?;
    let mut parts = Vec::new();
    for entry in content {
        if let Some(txt) = entry.get("text").and_then(Value::as_str) {
            if !txt.trim().is_empty() {
                parts.push(txt.to_string());
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_token_budget_none_unless_user_explicit() {
        let g = GoalRecord::new("GOAL-1", "Build contracts");
        assert_eq!(g.token_budget, None);
        assert!(g.verify_budget_invariant().is_ok());

        let implicit = json!({
            "id": "GOAL-2",
            "title": "Implicit cap should fail",
            "token_budget": 10000
        });
        assert!(matches!(
            parse_goal_record(&implicit),
            Err(CodexPatchedError::ImplicitTokenBudgetForbidden { .. })
        ));

        let explicit = json!({
            "id": "GOAL-3",
            "title": "User explicit cap",
            "token_budget": 25000,
            "explicit_user_budget": true
        });
        let parsed = parse_goal_record(&explicit).expect("explicit budget accepted");
        assert_eq!(parsed.token_budget, Some(25_000));
        assert!(parsed.explicit_user_budget);
    }

    #[test]
    fn additive_intake_queue_never_drops_or_reorders_backlog() {
        let mut q = AdditiveSteerQueue::new();
        q.enqueue_additive("item-1", "G1", "First unfinished task", None)
            .expect("enqueue 1");
        q.set_status("item-1", QueueItemStatus::InProgress)
            .expect("in progress");
        let gh_tok = format!("{}_{}", "ghp", "1234567890abcdef1234567890abcdef1234");
        q.enqueue_additive(
            "item-2",
            "G1",
            format!("Additive steer with Bearer {gh_tok}"),
            None,
        )
        .expect("enqueue 2");

        assert_eq!(q.items().len(), 2);
        assert_eq!(q.items()[0].seq, 1);
        assert_eq!(q.items()[0].status, QueueItemStatus::InProgress);
        assert_eq!(q.items()[1].seq, 2);
        assert_eq!(q.items()[1].mode, SteerMode::AdditiveIntake);
        assert!(!q.items()[1].prompt.contains("1234567890abcdef"));
        assert_eq!(q.unfinished_count(), 2);

        q.apply_steer(
            "item-3",
            "G1",
            SteerMode::ExplicitStopOrReplace,
            Some("item-2".into()),
            "Replace only item-2",
            None,
        )
        .expect("explicit replace");
        assert_eq!(q.items()[0].status, QueueItemStatus::InProgress);
        assert_eq!(q.items()[1].status, QueueItemStatus::Superseded);
        assert_eq!(q.items()[2].status, QueueItemStatus::Queued);
    }

    #[test]
    fn parses_rollout_jsonl_and_redacts_secrets_and_paths() {
        let sk_tok = format!("{}-{}-{}", "sk", "proj", "abcdef1234567890abcdef");
        let jsonl = format!(
            "{}\n{}\n{{\"timestamp\":\"2026-11-14T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"item_completed\",\"item\":{{\"type\":\"UserMessage\",\"content\":[{{\"type\":\"text\",\"text\":\"Use key {sk_tok} and mail me at alice@example.com\"}}]}}}}}}\n{}\n",
            "{\"timestamp\":\"2026-11-14T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"sess-1\",\"thread_id\":\"thr-1\",\"cwd\":\"C:\\\\Users\\\\example\\\\proj\"}}",
            "{\"timestamp\":\"2026-11-14T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"input_tokens\":120,\"output_tokens\":45}}}",
            "{not valid json}"
        );
        let parsed = parse_codex_rollout_jsonl(&jsonl).expect("rollout parsed");
        assert_eq!(parsed.session_id.as_deref(), Some("sess-1"));
        let cwd = parsed.cwd.as_deref().expect("cwd present");
        assert!(!cwd.contains("example"));
        assert_eq!(cwd, format!("{}\\proj", crate::REDACTED_USER_PROFILE));
        assert_eq!(parsed.token_usage_summary.get("input_tokens"), Some(&120));
        assert_eq!(parsed.messages.len(), 1);
        assert!(!parsed.messages[0].text.contains("abcdef1234567890"));
        assert!(!parsed.messages[0].text.contains("alice@example.com"));
        assert_eq!(parsed.malformed_lines, 1);
    }

    #[test]
    fn turn_steer_rejects_nested_or_implicit_or_invalid_explicit_budgets() {
        // Non-object omniaSteer must be rejected cleanly.
        let bad_steer_shape = json!({
            "threadId": "thr-1",
            "omniaSteer": "not-an-object",
            "input": [{"type": "text", "text": "hello"}]
        });
        assert!(matches!(
            validate_turn_steer_payload(&bad_steer_shape),
            Err(CodexPatchedError::InvalidTurnSteer(_))
        ));

        // Implicit nested omniaSteer.tokenBudget must be rejected.
        let implicit_nested = json!({
            "threadId": "thr-1",
            "omniaSteer": {
                "tokenBudget": 5000
            },
            "input": [{"type": "text", "text": "hello"}]
        });
        assert!(matches!(
            validate_turn_steer_payload(&implicit_nested),
            Err(CodexPatchedError::ImplicitTokenBudgetForbidden { .. })
        ));

        // Top-level implicit tokenBudget alongside valid omniaSteer must be rejected.
        let implicit_top_with_nested = json!({
            "threadId": "thr-1",
            "tokenBudget": 5000,
            "omniaSteer": {
                "mode": "ADDITIVE_INTAKE"
            },
            "input": [{"type": "text", "text": "hello"}]
        });
        assert!(matches!(
            validate_turn_steer_payload(&implicit_top_with_nested),
            Err(CodexPatchedError::ImplicitTokenBudgetForbidden { .. })
        ));

        // Explicit user budget with invalid values (0, -1, "100", true) must be rejected.
        for bad_val in [json!(0), json!(-1), json!("100"), json!(true)] {
            let invalid_top = json!({
                "threadId": "thr-1",
                "explicitUserBudget": true,
                "tokenBudget": bad_val,
                "input": [{"type": "text", "text": "hello"}]
            });
            assert!(
                matches!(
                    validate_turn_steer_payload(&invalid_top),
                    Err(CodexPatchedError::InvalidTurnSteer(_))
                ),
                "expected InvalidTurnSteer for explicit top-level tokenBudget={bad_val}"
            );

            let invalid_nested = json!({
                "threadId": "thr-1",
                "omniaSteer": {
                    "explicitUserBudget": true,
                    "tokenBudget": bad_val
                },
                "input": [{"type": "text", "text": "hello"}]
            });
            assert!(
                matches!(
                    validate_turn_steer_payload(&invalid_nested),
                    Err(CodexPatchedError::InvalidTurnSteer(_))
                ),
                "expected InvalidTurnSteer for explicit nested omniaSteer.tokenBudget={bad_val}"
            );
        }

        // Valid positive integer explicit budget succeeds cleanly.
        let valid_nested = json!({
            "threadId": "thr-1",
            "omniaSteer": {
                "explicitUserBudget": true,
                "tokenBudget": 12000
            },
            "input": [{"type": "text", "text": "hello"}]
        });
        let normalized = validate_turn_steer_payload(&valid_nested).expect("valid explicit steer");
        assert_eq!(normalized["tokenBudget"], 12_000);
        assert_eq!(normalized["explicitUserBudget"], true);
    }
}
