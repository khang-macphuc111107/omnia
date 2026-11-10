//! Typed, fail-closed run-control contracts.
//!
//! This module is deliberately independent from the execution scheduler.  It
//! validates and canonicalises a run-control intent before a queue, provider
//! worker or external effect can consume it.  The resolver never mutates an
//! accepted message/attempt and never treats a renderer snapshot as durable
//! state.  `ResolvedRunControlOperation::to_state_revision_append_request`
//! provides the narrow bridge to the immutable state-revision CAS layer; a
//! future queue/checkpoint implementation can consume the same resolved DTO
//! without changing the renderer contract.
//!
//! Contract reminders kept next to the native boundary: graph edges are
//! recorded as `child -> parent`; an `outcome-unknown` external effect is
//! never replayed automatically; `stateBase` is resolved before dispatch;
//! idempotency is part of the canonical operation identity; and the compact
//! `native-state-revision-graph-read-v1` projection must not be treated as a
//! substitute for the richer durable graph.

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    authority_continuity::{
        build_run_control_projection, record_id as authority_continuity_record_id,
        validate_record_id as validate_authority_continuity_record_id,
    },
    error::{NativeError, NativeResult},
    storage::StateRevisionAppendRequest,
};

pub const RUN_CONTROL_OPERATION_SCHEMA_VERSION: u32 = 2;
pub const RUN_CONTROL_CHECKPOINT_SCHEMA_VERSION: u32 = 1;
pub const CONTINUATION_INTENT_SCHEMA_VERSION: u32 = 1;
pub const MESSAGE_REVISION_SCHEMA_VERSION: u32 = 1;

const MAX_ID_BYTES: usize = 256;
const MAX_KEY_BYTES: usize = 512;
const MAX_TEXT_BYTES: usize = 4_096;
const MAX_CURSOR_COUNT: usize = 256;
const MAX_REVISION_IDS: usize = 512;

/// The user-facing operation vocabulary.  Serde's kebab-case names are the
/// wire values documented in `run-control-operation.schema.json`.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum RunControlKind {
    Pause,
    Resume,
    Continue,
    Edit,
    Retry,
    Copy,
    Duplicate,
    Branch,
    Fork,
    Compare,
    Promote,
    Merge,
}

impl RunControlKind {
    pub fn mutates_state(self) -> bool {
        !matches!(self, Self::Copy | Self::Compare)
    }

    fn state_revision_kind(self) -> Option<&'static str> {
        match self {
            Self::Pause => Some("checkpoint"),
            Self::Resume => Some("resume"),
            Self::Continue => Some("continuation"),
            Self::Edit => Some("prompt-edit"),
            Self::Retry => Some("retry-result"),
            Self::Copy | Self::Compare => None,
            // A duplicate creates a fresh branch identity.  It must never be
            // collapsed into a continuation because that would silently
            // share execution/billing lineage with the source run.  A caller
            // that needs parallel semantics should submit the explicit
            // `fork` operation instead.
            Self::Duplicate => Some("branch"),
            Self::Branch => Some("branch"),
            Self::Fork => Some("fork"),
            Self::Promote => Some("promotion"),
            Self::Merge => Some("merge"),
        }
    }

    fn default_edge_kind(self) -> Option<&'static str> {
        match self {
            Self::Pause => Some("checkpoint-of"),
            Self::Resume => Some("resumes-from-checkpoint"),
            Self::Continue => Some("continues-from"),
            Self::Duplicate => Some("branches-from"),
            Self::Edit => Some("edits"),
            Self::Retry => Some("retries"),
            Self::Copy | Self::Compare => None,
            Self::Branch => Some("branches-from"),
            Self::Fork => Some("forks-from"),
            Self::Promote => Some("promotes"),
            Self::Merge => Some("merges-from"),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum RunControlOperationState {
    Resolved,
    Applied,
    Blocked,
    Rejected,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum RunControlStateBaseMode {
    ExactHistorical,
    CurrentState,
    HistoricalPlusSelectedDeltas,
    FreshBranch,
    FreshGoalStart,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum RunControlStateBaseReason {
    ExactFrozen,
    CurrentBranchHead,
    HistoricalSelectedDeltas,
    FreshIsolatedBootstrap,
    FreshGoalBootstrap,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum RunControlActiveRunPolicy {
    ApplyAtSafeBoundary,
    InterruptNewAttempt,
    QueueAfterTerminal,
    ForkParallel,
    NotApplicable,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum RunControlActorKind {
    User,
    Agent,
    Automation,
    Recovery,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum RunControlStreamKind {
    Conversation,
    Branch,
    Run,
    Task,
    Project,
    Provider,
    Recovery,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum StateDigestAlgorithm {
    #[serde(rename = "sha-256")]
    Sha256,
    #[serde(rename = "sha-384")]
    Sha384,
    #[serde(rename = "sha-512")]
    Sha512,
    Blake3,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ContinuationIntentKind {
    None,
    NextBestAction,
    UnfinishedAnswer,
    NextPlanTask,
    ResumeCheckpoint,
    BootstrapActiveGoal,
    StarterWorkflow,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum CheckpointStatus {
    Requested,
    Checkpointing,
    Paused,
    Resuming,
    Expired,
    Blocked,
    Invalidated,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum CheckpointDisposition {
    CooperativeCheckpoint,
    ProviderSupportedSuspend,
    CancelThenReconcile,
    PendingEffectCheckpoint,
    Held,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum MessageRevisionEffect {
    EditDraft,
    ReplaceQueued,
    EditAsBranch,
    ReplayHistorical,
    RetryCurrentState,
    SelectedDeltaRetry,
    AnnotationOrCorrection,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunControlActor {
    pub kind: RunControlActorKind,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunControlCursor {
    pub stream_kind: RunControlStreamKind,
    pub stream_id: String,
    pub journal_epoch: Option<String>,
    pub sequence: i64,
    pub event_id: Option<String>,
    pub payload_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateDigest {
    pub algorithm: StateDigestAlgorithm,
    pub canonicalization_revision: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunControlStateBase {
    pub mode: RunControlStateBaseMode,
    pub source_state_revision_id: Option<String>,
    pub requested_head_state_revision_id: Option<String>,
    pub resolved_state_revision_id: String,
    pub resolved_state_digest: StateDigest,
    pub selected_delta_ids: Vec<String>,
    pub context_manifest_id: Option<String>,
    pub resolution_reason: RunControlStateBaseReason,
    pub resolved_at: String,
    pub resolved_at_cursors: Vec<RunControlCursor>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunControlResult {
    pub result_state_revision_id: Option<String>,
    pub result_run_id: Option<String>,
    pub result_attempt_id: Option<String>,
    pub result_checkpoint_id: Option<String>,
    pub result_branch_id: Option<String>,
    /// Source branch cursor captured by native branch/fork application.  This
    /// is a provenance fact, not a renderer authority claim; it remains
    /// optional for legacy/non-branch operations and for blocked outcomes.
    #[serde(default)]
    pub source_branch_cursor: Option<RunControlCursor>,
    /// Child-branch cursor is intentionally absent until the destination
    /// stream has its first durable state fact.  When present it is validated
    /// as a native cursor and remains scoped to `result_branch_id`.
    #[serde(default)]
    pub destination_branch_cursor: Option<RunControlCursor>,
    pub blocked_reason: Option<String>,
    pub diagnostic_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunControlBranchCursorExpectation {
    pub stream_kind: RunControlStreamKind,
    pub stream_id: String,
    pub journal_epoch: Option<String>,
    pub sequence: i64,
    pub event_id: Option<String>,
    pub payload_hash: Option<String>,
}

/// Renderer/native input.  `operationState`, receipts and results are owned by
/// native resolution and therefore are intentionally not accepted here.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunControlOperationRequest {
    #[serde(default)]
    pub schema_version: Option<u32>,
    pub operation_id: String,
    pub kind: RunControlKind,
    pub conversation_id: String,
    pub branch_id: String,
    pub source_run_id: Option<String>,
    pub source_attempt_id: Option<String>,
    pub source_message_id: Option<String>,
    pub source_prompt_revision_id: Option<String>,
    pub state_base: RunControlStateBase,
    pub edit_revision_id: Option<String>,
    pub continuation_intent: ContinuationIntentKind,
    pub active_run_policy: RunControlActiveRunPolicy,
    pub expected_active_run_id: Option<String>,
    pub expected_conversation_version: Option<i64>,
    pub expected_branch_cursor: Option<RunControlBranchCursorExpectation>,
    #[serde(default)]
    pub compare_state_revision_ids: Vec<String>,
    #[serde(default)]
    pub merge_state_revision_ids: Vec<String>,
    pub actor: RunControlActor,
    pub idempotency_key: String,
    pub created_at: String,
}

/// Renderer/native intent envelope. Unlike `RunControlOperationRequest`, this
/// type does not accept a renderer-resolved state base as authority. The
/// optional `state_base` value is only a selector/shape hint; native storage
/// derives the canonical digest, timestamp, cursor set and revision IDs from
/// the accepted state-revision graph in the same transaction that writes the
/// immutable operation receipt.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunControlOperationIntent {
    #[serde(default)]
    pub schema_version: Option<u32>,
    pub operation_id: String,
    pub kind: RunControlKind,
    pub conversation_id: String,
    pub branch_id: String,
    pub source_run_id: Option<String>,
    pub source_attempt_id: Option<String>,
    pub source_message_id: Option<String>,
    pub source_prompt_revision_id: Option<String>,
    /// Optional selector/shape hint. Authority-bearing fields are ignored
    /// when deriving a base; malformed values are rejected as input, never
    /// promoted to durable authority.
    pub state_base: Option<RunControlStateBase>,
    pub edit_revision_id: Option<String>,
    pub continuation_intent: ContinuationIntentKind,
    pub active_run_policy: RunControlActiveRunPolicy,
    pub expected_active_run_id: Option<String>,
    pub expected_conversation_version: Option<i64>,
    pub expected_branch_cursor: Option<RunControlBranchCursorExpectation>,
    #[serde(default)]
    pub compare_state_revision_ids: Vec<String>,
    #[serde(default)]
    pub merge_state_revision_ids: Vec<String>,
    pub actor: RunControlActor,
    pub idempotency_key: String,
    pub created_at: String,
}

impl RunControlOperationIntent {
    /// Validate all intent fields that are independent of the mutable native
    /// state graph. This deliberately does not validate a state base against
    /// SQLite; that work belongs to the authoritative storage transaction.
    pub fn validate(&self) -> NativeResult<()> {
        if self
            .schema_version
            .is_some_and(|version| version != RUN_CONTROL_OPERATION_SCHEMA_VERSION)
        {
            return Err(NativeError::new(
                "unsupported_schema",
                "The run-control operation schema version is unsupported",
            ));
        }
        validate_identifier("operationId", &self.operation_id, MAX_ID_BYTES)?;
        validate_identifier("conversationId", &self.conversation_id, MAX_ID_BYTES)?;
        validate_identifier("branchId", &self.branch_id, MAX_ID_BYTES)?;
        validate_identifier("idempotencyKey", &self.idempotency_key, MAX_KEY_BYTES)?;
        validate_rfc3339("createdAt", &self.created_at)?;
        validate_actor(&self.actor)?;
        validate_optional_identifier("sourceRunId", self.source_run_id.as_deref())?;
        validate_optional_identifier("sourceAttemptId", self.source_attempt_id.as_deref())?;
        validate_optional_identifier("sourceMessageId", self.source_message_id.as_deref())?;
        validate_optional_identifier(
            "sourcePromptRevisionId",
            self.source_prompt_revision_id.as_deref(),
        )?;
        validate_optional_identifier("editRevisionId", self.edit_revision_id.as_deref())?;
        validate_optional_identifier(
            "expectedActiveRunId",
            self.expected_active_run_id.as_deref(),
        )?;
        if self
            .expected_conversation_version
            .is_some_and(|version| version < 0)
        {
            return Err(NativeError::invalid(
                "expectedConversationVersion",
                "must be zero or greater",
            ));
        }
        if let Some(cursor) = self.expected_branch_cursor.as_ref() {
            validate_branch_cursor(cursor)?;
        }
        validate_revision_id_list(
            "compareStateRevisionIds",
            &self.compare_state_revision_ids,
            0,
        )?;
        validate_revision_id_list("mergeStateRevisionIds", &self.merge_state_revision_ids, 0)?;
        if let Some(state_base) = self.state_base.as_ref() {
            // This checks selector syntax and mode invariants. The digest,
            // timestamp and cursors are intentionally not used as authority;
            // native derivation overwrites them below.
            validate_state_base(state_base)?;
        }
        validate_kind_requirements_fields(
            self.kind,
            self.source_run_id.as_ref(),
            self.source_attempt_id.as_ref(),
            self.source_message_id.as_ref(),
            self.source_prompt_revision_id.as_ref(),
            self.edit_revision_id.as_ref(),
            self.continuation_intent,
            self.active_run_policy,
            &self.compare_state_revision_ids,
            &self.merge_state_revision_ids,
        )
    }

    /// Build the legacy request shape after native has supplied the canonical
    /// state base, then run the existing pure resolver/semantic validator.
    pub fn into_request(self, state_base: RunControlStateBase) -> RunControlOperationRequest {
        RunControlOperationRequest {
            schema_version: self.schema_version,
            operation_id: self.operation_id,
            kind: self.kind,
            conversation_id: self.conversation_id,
            branch_id: self.branch_id,
            source_run_id: self.source_run_id,
            source_attempt_id: self.source_attempt_id,
            source_message_id: self.source_message_id,
            source_prompt_revision_id: self.source_prompt_revision_id,
            state_base,
            edit_revision_id: self.edit_revision_id,
            continuation_intent: self.continuation_intent,
            active_run_policy: self.active_run_policy,
            expected_active_run_id: self.expected_active_run_id,
            expected_conversation_version: self.expected_conversation_version,
            expected_branch_cursor: self.expected_branch_cursor,
            compare_state_revision_ids: self.compare_state_revision_ids,
            merge_state_revision_ids: self.merge_state_revision_ids,
            actor: self.actor,
            idempotency_key: self.idempotency_key,
            created_at: self.created_at,
        }
    }

    /// Compare a retry/resolution replay with the immutable native receipt.
    /// Replays use the historical stored base and therefore never read the
    /// live branch head. Selector fields, when supplied, still have to match
    /// the original immutable selection; digest/timestamp/cursor hints are
    /// deliberately ignored because they are not renderer authority.
    pub fn validate_replay_against(
        &self,
        stored: &ResolvedRunControlOperation,
    ) -> NativeResult<()> {
        if self.operation_id != stored.operation_id {
            return Err(NativeError::new(
                "payload_drift",
                "The idempotency key is already bound to another run-control operation",
            ));
        }
        let candidate = self
            .clone()
            .into_request(stored.state_base.clone())
            .resolve()?;
        if candidate.canonical_payload_hash != stored.canonical_payload_hash {
            return Err(NativeError::new(
                "payload_drift",
                "The idempotency key is already bound to a different run-control payload",
            ));
        }
        if let Some(hint) = self.state_base.as_ref() {
            let persisted = &stored.state_base;
            if hint.mode != persisted.mode
                || hint.source_state_revision_id != persisted.source_state_revision_id
                || hint.requested_head_state_revision_id
                    != persisted.requested_head_state_revision_id
                || hint.selected_delta_ids != persisted.selected_delta_ids
                || hint.context_manifest_id != persisted.context_manifest_id
                || hint.resolution_reason != persisted.resolution_reason
            {
                return Err(NativeError::new(
                    "payload_drift",
                    "The idempotency key is already bound to a different state-base selector",
                ));
            }
        }
        Ok(())
    }
}

/// Canonical operation returned by native resolution and persisted as a state
/// revision operation fact.  `canonical_payload_hash` is deliberately skipped
/// from serde: it is a diagnostic handle, not part of the portable v2 schema.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedRunControlOperation {
    pub schema_version: u32,
    pub operation_id: String,
    pub receipt_id: Option<String>,
    pub authority_continuity_record_id: Option<String>,
    pub kind: RunControlKind,
    pub operation_state: RunControlOperationState,
    pub conversation_id: String,
    pub branch_id: String,
    pub source_run_id: Option<String>,
    pub source_attempt_id: Option<String>,
    pub source_message_id: Option<String>,
    pub source_prompt_revision_id: Option<String>,
    pub state_base: RunControlStateBase,
    pub edit_revision_id: Option<String>,
    pub continuation_intent: ContinuationIntentKind,
    pub active_run_policy: RunControlActiveRunPolicy,
    pub expected_active_run_id: Option<String>,
    pub expected_conversation_version: Option<i64>,
    pub expected_branch_cursor: Option<RunControlBranchCursorExpectation>,
    pub compare_state_revision_ids: Vec<String>,
    pub merge_state_revision_ids: Vec<String>,
    pub result: Option<RunControlResult>,
    pub actor: RunControlActor,
    pub idempotency_key: String,
    pub created_at: String,
    #[serde(skip)]
    pub canonical_payload_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunControlApplyResult {
    pub operation: ResolvedRunControlOperation,
    pub durable: bool,
    pub state_revision_id: Option<String>,
    pub replayed: bool,
    pub diagnostic: Option<String>,
}

/// Native request for applying a previously resolved operation.  The
/// renderer intentionally sends only the operation/replay address and
/// optional optimistic-concurrency expectations; the canonical operation
/// envelope is loaded from the native receipt instead of being trusted from
/// the renderer a second time.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunControlApplyRequest {
    pub operation_id: String,
    pub idempotency_key: String,
    pub expected_operation_state: Option<RunControlOperationState>,
    pub expected_head_state_revision_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunCheckpoint {
    pub schema_version: u32,
    pub checkpoint_id: String,
    pub run_id: String,
    pub attempt_id: Option<String>,
    pub agent_instance_id: Option<String>,
    pub state_revision_id: String,
    pub status: CheckpointStatus,
    pub disposition: CheckpointDisposition,
    pub cursor: i64,
    pub partial_output_policy: Option<String>,
    pub frozen_provider_input_id: Option<String>,
    pub provider_acceptance: Option<String>,
    pub pending_reconciliation_ids: Vec<String>,
    pub lease_epoch: Option<i64>,
    pub telemetry_watermark: Option<i64>,
    pub content_hash: String,
    pub idempotency_key: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinuationIntent {
    pub schema_version: u32,
    pub intent_id: String,
    pub root_kind: String,
    pub root_id: String,
    pub intent_kind: String,
    pub state_revision_id: String,
    pub execution_mode: String,
    pub model_profile_id: Option<String>,
    pub effort: String,
    pub allowed_tool_ids: Vec<String>,
    pub budget: Option<ContinuationBudget>,
    pub loop_guard: ContinuationLoopGuard,
    pub approval_policy_revision: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinuationBudget {
    pub max_tokens: Option<i64>,
    pub max_cost: Option<String>,
    pub max_duration_seconds: Option<i64>,
    pub max_segments: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinuationLoopGuard {
    pub chain_id: String,
    pub duplicate_signature: String,
    pub max_automatic_segments: i64,
    pub progress_score: Option<String>,
    pub no_progress_count: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageRevision {
    pub schema_version: u32,
    pub revision_id: String,
    pub message_id: String,
    pub kind: String,
    pub effect: MessageRevisionEffect,
    pub parent_revision_id: Option<String>,
    pub source_cursor: i64,
    pub destination_branch_id: Option<String>,
    pub content_hash: String,
    pub redaction_class: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRunCheckpointRequest {
    pub run_id: String,
    pub attempt_id: Option<String>,
    pub agent_instance_id: Option<String>,
    pub state_revision_id: String,
    pub status: CheckpointStatus,
    pub disposition: CheckpointDisposition,
    pub cursor: i64,
    pub partial_output_policy: Option<String>,
    pub frozen_provider_input_id: Option<String>,
    pub provider_acceptance: Option<String>,
    #[serde(default)]
    pub pending_reconciliation_ids: Vec<String>,
    pub lease_epoch: Option<i64>,
    pub telemetry_watermark: Option<i64>,
    pub content_hash: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadRunCheckpointRequest {
    pub run_id: String,
    pub checkpoint_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveContinuationIntentRequest {
    pub conversation_id: String,
    pub branch_id: String,
    pub root_kind: String,
    pub root_id: String,
    pub intent_kind: String,
    pub state_revision_id: String,
    pub execution_mode: Option<String>,
    pub model_profile_id: Option<String>,
    pub effort: Option<String>,
    #[serde(default)]
    pub allowed_tool_ids: Vec<String>,
    pub budget: Option<ContinuationBudget>,
    pub loop_guard: Option<ContinuationLoopGuard>,
    pub approval_policy_revision: Option<String>,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveMessageRevisionRequest {
    pub conversation_id: String,
    pub branch_id: String,
    pub message_id: String,
    pub kind: String,
    pub effect: MessageRevisionEffect,
    pub source_cursor: i64,
    pub parent_revision_id: Option<String>,
    pub destination_branch_id: Option<String>,
    pub content_hash: String,
    pub redaction_class: String,
    pub idempotency_key: String,
}

impl RunControlOperationRequest {
    /// Resolve and validate a renderer intent.  This function is pure and can
    /// be exercised without a SQLite connection or an available provider.
    pub fn resolve(self) -> NativeResult<ResolvedRunControlOperation> {
        if self
            .schema_version
            .is_some_and(|version| version != RUN_CONTROL_OPERATION_SCHEMA_VERSION)
        {
            return Err(NativeError::new(
                "unsupported_schema",
                "The run-control operation schema version is unsupported",
            ));
        }
        validate_identifier("operationId", &self.operation_id, MAX_ID_BYTES)?;
        validate_identifier("conversationId", &self.conversation_id, MAX_ID_BYTES)?;
        validate_identifier("branchId", &self.branch_id, MAX_ID_BYTES)?;
        validate_identifier("idempotencyKey", &self.idempotency_key, MAX_KEY_BYTES)?;
        validate_rfc3339("createdAt", &self.created_at)?;
        validate_actor(&self.actor)?;
        validate_state_base(&self.state_base)?;
        validate_optional_identifier("sourceRunId", self.source_run_id.as_deref())?;
        validate_optional_identifier("sourceAttemptId", self.source_attempt_id.as_deref())?;
        validate_optional_identifier("sourceMessageId", self.source_message_id.as_deref())?;
        validate_optional_identifier(
            "sourcePromptRevisionId",
            self.source_prompt_revision_id.as_deref(),
        )?;
        validate_optional_identifier("editRevisionId", self.edit_revision_id.as_deref())?;
        validate_optional_identifier(
            "expectedActiveRunId",
            self.expected_active_run_id.as_deref(),
        )?;
        if self
            .expected_conversation_version
            .is_some_and(|version| version < 0)
        {
            return Err(NativeError::invalid(
                "expectedConversationVersion",
                "must be zero or greater",
            ));
        }
        if let Some(cursor) = self.expected_branch_cursor.as_ref() {
            validate_branch_cursor(cursor)?;
        }
        validate_revision_id_list(
            "compareStateRevisionIds",
            &self.compare_state_revision_ids,
            0,
        )?;
        validate_revision_id_list("mergeStateRevisionIds", &self.merge_state_revision_ids, 0)?;
        validate_kind_requirements(&self)?;

        let canonical_payload = serde_json::json!({
            "schemaVersion": RUN_CONTROL_OPERATION_SCHEMA_VERSION,
            "operationId": &self.operation_id,
            "kind": self.kind,
            "conversationId": &self.conversation_id,
            "branchId": &self.branch_id,
            "sourceRunId": &self.source_run_id,
            "sourceAttemptId": &self.source_attempt_id,
            "sourceMessageId": &self.source_message_id,
            "sourcePromptRevisionId": &self.source_prompt_revision_id,
            "stateBase": &self.state_base,
            "editRevisionId": &self.edit_revision_id,
            "continuationIntent": self.continuation_intent,
            "activeRunPolicy": self.active_run_policy,
            "expectedActiveRunId": &self.expected_active_run_id,
            "expectedConversationVersion": self.expected_conversation_version,
            "expectedBranchCursor": &self.expected_branch_cursor,
            "compareStateRevisionIds": &self.compare_state_revision_ids,
            "mergeStateRevisionIds": &self.merge_state_revision_ids,
            "actor": &self.actor,
            "idempotencyKey": &self.idempotency_key,
            "createdAt": &self.created_at,
        });
        let canonical_bytes = serde_json::to_vec(&canonical_payload).map_err(|_| {
            NativeError::new(
                "run_control_integrity_failed",
                "The run-control operation could not be canonicalized",
            )
        })?;
        let canonical_payload_hash = sha256_hex(&canonical_bytes);
        let continuity_record_id = authority_continuity_record_id(&self.operation_id);
        Ok(ResolvedRunControlOperation {
            schema_version: RUN_CONTROL_OPERATION_SCHEMA_VERSION,
            operation_id: self.operation_id,
            receipt_id: None,
            authority_continuity_record_id: Some(continuity_record_id),
            kind: self.kind,
            operation_state: RunControlOperationState::Resolved,
            conversation_id: self.conversation_id,
            branch_id: self.branch_id,
            source_run_id: self.source_run_id,
            source_attempt_id: self.source_attempt_id,
            source_message_id: self.source_message_id,
            source_prompt_revision_id: self.source_prompt_revision_id,
            state_base: self.state_base,
            edit_revision_id: self.edit_revision_id,
            continuation_intent: self.continuation_intent,
            active_run_policy: self.active_run_policy,
            expected_active_run_id: self.expected_active_run_id,
            expected_conversation_version: self.expected_conversation_version,
            expected_branch_cursor: self.expected_branch_cursor,
            compare_state_revision_ids: self.compare_state_revision_ids,
            merge_state_revision_ids: self.merge_state_revision_ids,
            result: None,
            actor: self.actor,
            idempotency_key: self.idempotency_key,
            created_at: self.created_at,
            canonical_payload_hash,
        })
    }
}

impl ResolvedRunControlOperation {
    /// Re-validates the native-owned operation envelope after it has crossed
    /// the SQLite boundary.  Renderer requests are validated by
    /// `RunControlOperationRequest::resolve`, but persisted JSON is still an
    /// untrusted recovery input (the database may have been copied, restored,
    /// or tampered with).  Keep this check in the contract module so storage
    /// cannot accidentally validate a weaker subset of the resolver rules.
    pub(crate) fn validate_integrity(&self) -> NativeResult<()> {
        if self.schema_version != RUN_CONTROL_OPERATION_SCHEMA_VERSION {
            return Err(NativeError::new(
                "unsupported_schema",
                "The persisted run-control operation schema version is unsupported",
            ));
        }
        validate_identifier("operationId", &self.operation_id, MAX_ID_BYTES)?;
        validate_identifier("conversationId", &self.conversation_id, MAX_ID_BYTES)?;
        validate_identifier("branchId", &self.branch_id, MAX_ID_BYTES)?;
        if let Some(record_id) = self.authority_continuity_record_id.as_deref() {
            validate_authority_continuity_record_id(record_id)?;
            if record_id != authority_continuity_record_id(&self.operation_id) {
                return Err(NativeError::new(
                    "run_control_integrity_failed",
                    "The authority-continuity record is not deterministically bound to the operation",
                ));
            }
        }
        validate_optional_identifier("sourceRunId", self.source_run_id.as_deref())?;
        validate_optional_identifier("sourceAttemptId", self.source_attempt_id.as_deref())?;
        validate_optional_identifier("sourceMessageId", self.source_message_id.as_deref())?;
        validate_optional_identifier(
            "sourcePromptRevisionId",
            self.source_prompt_revision_id.as_deref(),
        )?;
        validate_optional_identifier("editRevisionId", self.edit_revision_id.as_deref())?;
        validate_optional_identifier(
            "expectedActiveRunId",
            self.expected_active_run_id.as_deref(),
        )?;
        validate_identifier("idempotencyKey", &self.idempotency_key, MAX_KEY_BYTES)?;
        validate_rfc3339("createdAt", &self.created_at)?;
        validate_actor(&self.actor)?;
        validate_state_base(&self.state_base)?;
        if self
            .expected_conversation_version
            .is_some_and(|version| version < 0)
        {
            return Err(NativeError::invalid(
                "expectedConversationVersion",
                "must be zero or greater",
            ));
        }
        if let Some(cursor) = self.expected_branch_cursor.as_ref() {
            validate_branch_cursor(cursor)?;
        }
        validate_revision_id_list(
            "compareStateRevisionIds",
            &self.compare_state_revision_ids,
            0,
        )?;
        validate_revision_id_list("mergeStateRevisionIds", &self.merge_state_revision_ids, 0)?;
        // The resolver validates operation-specific requirements before it
        // emits an envelope.  Persisted envelopes are recovery input, though,
        // and may have been restored or modified outside the resolver.  Run
        // the same closed semantic checks here instead of accepting a shape-
        // valid `retry`, `resume`, `compare`, etc. with missing lineage.
        validate_resolved_kind_requirements(self)?;

        // The resolver intentionally emits a closed lifecycle: a newly
        // persisted envelope is `resolved` with no result; later immutable
        // event projections carry a non-resolved state and a typed result.
        // Permit a projection-only applied result (no state-revision ID), but
        // reject missing or contradictory result metadata during recovery.
        match self.operation_state {
            RunControlOperationState::Resolved => {
                if self.result.is_some() {
                    return Err(NativeError::new(
                        "run_control_integrity_failed",
                        "A resolved run-control operation must not contain a result",
                    ));
                }
            }
            RunControlOperationState::Applied => {
                let result = self.result.as_ref().ok_or_else(|| {
                    NativeError::new(
                        "run_control_integrity_failed",
                        "An applied run-control operation is missing its result",
                    )
                })?;
                Self::validate_result_branch_id(
                    self.kind,
                    &self.branch_id,
                    result.result_branch_id.as_deref(),
                )?;
                if result.result_branch_id.is_none() {
                    return Err(NativeError::new(
                        "run_control_integrity_failed",
                        "An applied run-control operation is missing its result branch",
                    ));
                }
                if let Some(revision_id) = result.result_state_revision_id.as_deref() {
                    validate_identifier("resultStateRevisionId", revision_id, MAX_ID_BYTES)?;
                }
                validate_optional_identifier("resultRunId", result.result_run_id.as_deref())?;
                validate_optional_identifier(
                    "resultAttemptId",
                    result.result_attempt_id.as_deref(),
                )?;
                validate_optional_identifier(
                    "resultCheckpointId",
                    result.result_checkpoint_id.as_deref(),
                )?;
                if let Some(diagnostic_id) = result.diagnostic_id.as_deref() {
                    validate_bounded_text("diagnosticId", diagnostic_id, MAX_TEXT_BYTES)?;
                }
                if self.kind.mutates_state()
                    && !matches!(self.kind, RunControlKind::Branch | RunControlKind::Fork)
                    && result.result_state_revision_id.is_none()
                {
                    return Err(NativeError::new(
                        "run_control_integrity_failed",
                        "A mutating applied run-control operation must carry its state revision",
                    ));
                }
                if !self.kind.mutates_state() && result.result_state_revision_id.is_some() {
                    return Err(NativeError::new(
                        "run_control_integrity_failed",
                        "A projection-only operation must not claim a state revision",
                    ));
                }
                Self::validate_branch_receipt_cursors(self.kind, result)?;
            }
            RunControlOperationState::Blocked
            | RunControlOperationState::Rejected
            | RunControlOperationState::Cancelled
            | RunControlOperationState::Failed => {
                let result = self.result.as_ref().ok_or_else(|| {
                    NativeError::new(
                        "run_control_integrity_failed",
                        "A terminal run-control operation is missing its result",
                    )
                })?;
                if result.result_state_revision_id.is_some() {
                    return Err(NativeError::new(
                        "run_control_integrity_failed",
                        "A blocked or failed run-control result cannot claim a state revision",
                    ));
                }
                Self::validate_result_branch_id(
                    self.kind,
                    &self.branch_id,
                    result.result_branch_id.as_deref(),
                )?;
                if let Some(reason) = result.blocked_reason.as_deref() {
                    validate_bounded_text("blockedReason", reason, MAX_TEXT_BYTES)?;
                }
                validate_optional_identifier("resultRunId", result.result_run_id.as_deref())?;
                validate_optional_identifier(
                    "resultAttemptId",
                    result.result_attempt_id.as_deref(),
                )?;
                validate_optional_identifier(
                    "resultCheckpointId",
                    result.result_checkpoint_id.as_deref(),
                )?;
                if let Some(diagnostic_id) = result.diagnostic_id.as_deref() {
                    validate_bounded_text("diagnosticId", diagnostic_id, MAX_TEXT_BYTES)?;
                }
            }
        }
        Ok(())
    }

    /// Validates the optional branch scope carried by a terminal result.
    /// Whenever persisted, the branch must be a bounded identifier and must
    /// remain within the operation's branch scope.  Applied operations impose
    /// the stronger presence requirement above; blocked/rejected/cancelled/
    /// failed projections may omit the optional field for compatibility.
    fn validate_result_branch_id(
        kind: RunControlKind,
        operation_branch_id: &str,
        result_branch_id: Option<&str>,
    ) -> NativeResult<()> {
        if let Some(result_branch_id) = result_branch_id {
            validate_identifier("resultBranchId", result_branch_id, MAX_ID_BYTES)?;
            if !matches!(kind, RunControlKind::Branch | RunControlKind::Fork)
                && result_branch_id != operation_branch_id
            {
                return Err(NativeError::new(
                    "run_control_integrity_failed",
                    "The run-control result is bound to another branch",
                ));
            }
        }
        Ok(())
    }

    fn validate_branch_receipt_cursors(
        kind: RunControlKind,
        result: &RunControlResult,
    ) -> NativeResult<()> {
        if let Some(cursor) = result.source_branch_cursor.as_ref() {
            validate_cursor(cursor)?;
            if cursor.stream_kind != RunControlStreamKind::Branch {
                return Err(NativeError::new(
                    "run_control_integrity_failed",
                    "The source branch cursor must use the branch stream kind",
                ));
            }
        }
        if let Some(cursor) = result.destination_branch_cursor.as_ref() {
            validate_cursor(cursor)?;
            if cursor.stream_kind != RunControlStreamKind::Branch {
                return Err(NativeError::new(
                    "run_control_integrity_failed",
                    "The destination branch cursor must use the branch stream kind",
                ));
            }
        }
        // Older branch/fork receipts were represented as ordinary state
        // revisions on the source branch. Keep those historical envelopes
        // readable; the new atomic child-branch result is identified by its
        // absent state-revision ID and must carry the pinned source cursor.
        if matches!(kind, RunControlKind::Branch | RunControlKind::Fork)
            && result.result_state_revision_id.is_none()
            && result.source_branch_cursor.is_none()
        {
            return Err(NativeError::new(
                "run_control_integrity_failed",
                "A branch/fork result is missing its source branch cursor",
            ));
        }
        Ok(())
    }

    /// Recomputes the resolver-level canonical operation hash from the
    /// immutable operation fields.  The hash is intentionally kept out of the
    /// serialized wire envelope (`canonical_payload_hash` is a diagnostic
    /// handle), so native storage uses this method when validating a replayed
    /// receipt loaded from SQLite.
    pub fn recompute_canonical_payload_hash(&self) -> NativeResult<String> {
        let canonical_payload = serde_json::json!({
            "schemaVersion": self.schema_version,
            "operationId": &self.operation_id,
            "kind": self.kind,
            "conversationId": &self.conversation_id,
            "branchId": &self.branch_id,
            "sourceRunId": &self.source_run_id,
            "sourceAttemptId": &self.source_attempt_id,
            "sourceMessageId": &self.source_message_id,
            "sourcePromptRevisionId": &self.source_prompt_revision_id,
            "stateBase": &self.state_base,
            "editRevisionId": &self.edit_revision_id,
            "continuationIntent": self.continuation_intent,
            "activeRunPolicy": self.active_run_policy,
            "expectedActiveRunId": &self.expected_active_run_id,
            "expectedConversationVersion": self.expected_conversation_version,
            "expectedBranchCursor": &self.expected_branch_cursor,
            "compareStateRevisionIds": &self.compare_state_revision_ids,
            "mergeStateRevisionIds": &self.merge_state_revision_ids,
            "actor": &self.actor,
            "idempotencyKey": &self.idempotency_key,
            "createdAt": &self.created_at,
        });
        let canonical_bytes = serde_json::to_vec(&canonical_payload).map_err(|_| {
            NativeError::new(
                "run_control_integrity_failed",
                "The run-control operation could not be canonicalized",
            )
        })?;
        Ok(sha256_hex(&canonical_bytes))
    }

    /// Build the narrow immutable state-revision mutation.  The state-revision
    /// storage layer still performs scope checks, parent checks and head CAS;
    /// this method only supplies bounded, redacted manifests and never embeds
    /// prompt text, credentials, cookies, provider bodies or attachment bytes.
    pub fn to_state_revision_append_request(&self) -> NativeResult<StateRevisionAppendRequest> {
        if !self.kind.mutates_state() {
            return Err(NativeError::new(
                "run_control_projection_only",
                "This run-control operation is read-only and has no state-revision mutation",
            ));
        }
        if matches!(
            self.state_base.mode,
            RunControlStateBaseMode::FreshBranch | RunControlStateBaseMode::FreshGoalStart
        ) {
            return Err(NativeError::new(
                "run_control_bootstrap_required",
                "A fresh state base must be bootstrapped by the branch/goal coordinator",
            ));
        }
        let kind = self
            .kind
            .state_revision_kind()
            .ok_or_else(|| NativeError::new("run_control_projection_only", "No state mutation"))?;
        let status = match self.operation_state {
            RunControlOperationState::Blocked => "blocked",
            RunControlOperationState::Rejected => "rejected",
            RunControlOperationState::Cancelled => "discarded",
            RunControlOperationState::Failed => "invalid",
            RunControlOperationState::Resolved | RunControlOperationState::Applied => "candidate",
        };
        let parent_id = self.state_base.resolved_state_revision_id.clone();
        let expected_head = self
            .state_base
            .requested_head_state_revision_id
            .clone()
            .ok_or_else(|| {
                NativeError::new(
                    "invalid_state_base",
                    "A mutating run-control operation requires a requested branch head",
                )
            })?;
        let actor_json = serde_json::to_string(&self.actor).map_err(|_| {
            NativeError::new(
                "run_control_integrity_failed",
                "The run-control actor envelope could not be serialized",
            )
        })?;
        let causation_json = serde_json::to_string(&serde_json::json!({
            "operationId": &self.operation_id,
            "operationKind": self.kind,
            "sourceRunId": &self.source_run_id,
            "sourceAttemptId": &self.source_attempt_id,
            "sourceMessageId": &self.source_message_id,
            "sourcePromptRevisionId": &self.source_prompt_revision_id,
            "idempotencyKeyHash": sha256_hex(self.idempotency_key.as_bytes()),
        }))
        .map_err(|_| {
            NativeError::new("run_control_integrity_failed", "Invalid causation envelope")
        })?;
        // Storage persists state-revision envelopes as bounded JSON objects.
        // Keep the resolved timestamp and the complete cursor set together
        // under an object rather than serializing the cursor vector directly
        // as an array (which `validated_state_revision_json` intentionally
        // rejects at the storage boundary).
        let watermark_json = serde_json::to_string(&serde_json::json!({
            "resolvedAt": &self.state_base.resolved_at,
            "cursors": &self.state_base.resolved_at_cursors,
        }))
        .map_err(|_| NativeError::new("run_control_integrity_failed", "Invalid state watermark"))?;
        let manifest_json = serde_json::to_string(&serde_json::json!({
            "operationId": &self.operation_id,
            "stateBaseMode": self.state_base.mode,
            "sourceStateRevisionId": &self.state_base.source_state_revision_id,
            "resolvedStateRevisionId": &self.state_base.resolved_state_revision_id,
            "resolvedStateDigest": &self.state_base.resolved_state_digest,
            "selectedDeltaIds": &self.state_base.selected_delta_ids,
            "contextManifestId": &self.state_base.context_manifest_id,
            "resolutionReason": self.state_base.resolution_reason,
            "kind": self.kind,
        }))
        .map_err(|_| NativeError::new("run_control_integrity_failed", "Invalid state manifest"))?;
        let authority_json = if let Some(record_id) = self.authority_continuity_record_id.as_deref()
        {
            let (derived_record_id, projection_json) = build_run_control_projection(
                &self.operation_id,
                serde_json::to_string(&self.actor.kind)
                    .map_err(|_| {
                        NativeError::new(
                            "run_control_integrity_failed",
                            "The run-control actor kind could not be serialized",
                        )
                    })?
                    .trim_matches('"'),
                &self.actor.id,
                &self.conversation_id,
                &self.branch_id,
                serde_json::to_string(&self.kind)
                    .map_err(|_| {
                        NativeError::new(
                            "run_control_integrity_failed",
                            "The run-control kind could not be serialized",
                        )
                    })?
                    .trim_matches('"'),
                &self.created_at,
            )?;
            if derived_record_id != record_id {
                return Err(NativeError::new(
                    "run_control_integrity_failed",
                    "The authority-continuity record is not bound to this operation",
                ));
            }
            projection_json
        } else {
            // Legacy envelopes created before the native continuity
            // correlation existed remain readable. New resolver output always
            // carries the typed projection above.
            r#"{"redaction":"renderer-safe","externalEffects":"not-authorized-by-run-control-resolver"}"#.to_owned()
        };
        let routing_cache_json = r#"{"routing":"resolved-by-provider-dispatch","cache":"not-authorized-by-run-control-resolver"}"#.to_owned();
        let causal_cursor_json = self
            .expected_branch_cursor
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| NativeError::new("run_control_integrity_failed", "Invalid causal cursor"))?
            .unwrap_or_else(|| "{}".to_owned());
        let state_digest = Some(self.state_base.resolved_state_digest.value.clone());
        Ok(StateRevisionAppendRequest {
            conversation_id: self.conversation_id.clone(),
            branch_id: self.branch_id.clone(),
            kind: kind.to_owned(),
            status: status.to_owned(),
            expected_head_state_revision_id: Some(expected_head),
            idempotency_key: self.idempotency_key.clone(),
            parent_state_revision_ids: vec![parent_id],
            watermark_json,
            actor_json,
            causation_json,
            manifest_json,
            authority_json,
            routing_cache_json,
            state_digest,
            canonicalization_revision: self
                .state_base
                .resolved_state_digest
                .canonicalization_revision
                .clone(),
            edge_kind: self.kind.default_edge_kind().map(str::to_owned),
            operation_id: Some(self.operation_id.clone()),
            causal_cursor_json,
            policy_revision_id: "policy-local-default-v1".to_owned(),
        })
    }

    pub fn with_applied_revision(mut self, revision_id: String) -> Self {
        self.operation_state = RunControlOperationState::Applied;
        self.result = Some(RunControlResult {
            result_state_revision_id: Some(revision_id),
            result_run_id: self.source_run_id.clone(),
            result_attempt_id: self.source_attempt_id.clone(),
            result_checkpoint_id: None,
            result_branch_id: Some(self.branch_id.clone()),
            source_branch_cursor: None,
            destination_branch_cursor: None,
            blocked_reason: None,
            diagnostic_id: None,
        });
        self
    }

    /// Marks an atomic branch/fork application. The child branch is a durable
    /// conversation-routing fact, so it intentionally has no state-revision
    /// identifier until a later child-branch run establishes its own stream.
    pub fn with_applied_branch(
        mut self,
        destination_branch_id: String,
        source_branch_cursor: RunControlCursor,
    ) -> Self {
        self.operation_state = RunControlOperationState::Applied;
        self.result = Some(RunControlResult {
            result_state_revision_id: None,
            result_run_id: self.source_run_id.clone(),
            result_attempt_id: self.source_attempt_id.clone(),
            result_checkpoint_id: None,
            result_branch_id: Some(destination_branch_id),
            source_branch_cursor: Some(source_branch_cursor),
            destination_branch_cursor: None,
            blocked_reason: None,
            diagnostic_id: None,
        });
        self
    }

    /// Marks a projection-only operation as durably applied.  Copy/compare do
    /// not create a state-revision fact, so the result intentionally carries a
    /// null revision identifier instead of a fabricated empty string.
    pub fn with_applied_projection(mut self) -> Self {
        self.operation_state = RunControlOperationState::Applied;
        self.result = Some(RunControlResult {
            result_state_revision_id: None,
            result_run_id: self.source_run_id.clone(),
            result_attempt_id: self.source_attempt_id.clone(),
            result_checkpoint_id: None,
            result_branch_id: Some(self.branch_id.clone()),
            source_branch_cursor: None,
            destination_branch_cursor: None,
            blocked_reason: None,
            diagnostic_id: None,
        });
        self
    }

    pub fn blocked(mut self, reason: impl Into<String>) -> Self {
        let reason = reason.into();
        self.operation_state = RunControlOperationState::Blocked;
        self.result = Some(RunControlResult {
            result_state_revision_id: None,
            result_run_id: self.source_run_id.clone(),
            result_attempt_id: self.source_attempt_id.clone(),
            result_checkpoint_id: None,
            result_branch_id: Some(self.branch_id.clone()),
            source_branch_cursor: None,
            destination_branch_cursor: None,
            blocked_reason: Some(reason),
            diagnostic_id: None,
        });
        self
    }

    pub fn failed(mut self, reason: impl Into<String>) -> Self {
        let reason = reason.into();
        self.operation_state = RunControlOperationState::Failed;
        self.result = Some(RunControlResult {
            result_state_revision_id: None,
            result_run_id: self.source_run_id.clone(),
            result_attempt_id: self.source_attempt_id.clone(),
            result_checkpoint_id: None,
            result_branch_id: Some(self.branch_id.clone()),
            source_branch_cursor: None,
            destination_branch_cursor: None,
            blocked_reason: Some(reason),
            diagnostic_id: None,
        });
        self
    }
}

fn validate_kind_requirements(request: &RunControlOperationRequest) -> NativeResult<()> {
    validate_kind_requirements_fields(
        request.kind,
        request.source_run_id.as_ref(),
        request.source_attempt_id.as_ref(),
        request.source_message_id.as_ref(),
        request.source_prompt_revision_id.as_ref(),
        request.edit_revision_id.as_ref(),
        request.continuation_intent,
        request.active_run_policy,
        &request.compare_state_revision_ids,
        &request.merge_state_revision_ids,
    )
}

#[allow(clippy::too_many_arguments)] // mirrors the persisted record layout; bundling into a struct would be a larger refactor
fn validate_kind_requirements_fields(
    kind: RunControlKind,
    source_run_id: Option<&String>,
    source_attempt_id: Option<&String>,
    source_message_id: Option<&String>,
    source_prompt_revision_id: Option<&String>,
    edit_revision_id: Option<&String>,
    continuation_intent: ContinuationIntentKind,
    active_run_policy: RunControlActiveRunPolicy,
    compare_state_revision_ids: &[String],
    merge_state_revision_ids: &[String],
) -> NativeResult<()> {
    let required = |field: &'static str, value: Option<&String>| {
        if value.is_some_and(|value| !value.trim().is_empty()) {
            Ok(())
        } else {
            Err(NativeError::invalid(
                field,
                "is required for this operation",
            ))
        }
    };
    match kind {
        RunControlKind::Pause => required("sourceRunId", source_run_id)?,
        RunControlKind::Resume => {
            required("sourceRunId", source_run_id)?;
            if continuation_intent != ContinuationIntentKind::ResumeCheckpoint {
                return Err(NativeError::invalid(
                    "continuationIntent",
                    "must be resume-checkpoint for resume",
                ));
            }
        }
        RunControlKind::Continue => {
            if continuation_intent == ContinuationIntentKind::None {
                return Err(NativeError::invalid(
                    "continuationIntent",
                    "must name an intent for continue",
                ));
            }
        }
        RunControlKind::Edit => {
            required("sourceMessageId", source_message_id)?;
            required("sourcePromptRevisionId", source_prompt_revision_id)?;
            required("editRevisionId", edit_revision_id)?;
        }
        RunControlKind::Retry => {
            required("sourceAttemptId", source_attempt_id)?;
            required("sourcePromptRevisionId", source_prompt_revision_id)?;
        }
        RunControlKind::Compare => {
            if compare_state_revision_ids.len() < 2 {
                return Err(NativeError::invalid(
                    "compareStateRevisionIds",
                    "must contain at least two revisions",
                ));
            }
        }
        RunControlKind::Promote | RunControlKind::Merge => {
            if merge_state_revision_ids.len() < 2 {
                return Err(NativeError::invalid(
                    "mergeStateRevisionIds",
                    "must contain at least two revisions",
                ));
            }
        }
        RunControlKind::Copy
        | RunControlKind::Duplicate
        | RunControlKind::Branch
        | RunControlKind::Fork => {}
    }
    if matches!(kind, RunControlKind::Pause | RunControlKind::Resume)
        && matches!(active_run_policy, RunControlActiveRunPolicy::NotApplicable)
    {
        return Err(NativeError::invalid(
            "activeRunPolicy",
            "must describe how the active run is handled",
        ));
    }
    Ok(())
}

/// Replays the operation-specific resolver rules against a persisted
/// envelope.  `ResolvedRunControlOperation::validate_integrity` cannot
/// deserialize into `RunControlOperationRequest` because the former carries
/// native-owned lifecycle/result fields, so keep this small projection of the
/// semantic checks beside the original resolver rules.
fn validate_resolved_kind_requirements(
    operation: &ResolvedRunControlOperation,
) -> NativeResult<()> {
    let required = |field: &'static str, value: Option<&String>| {
        if value.is_some_and(|value| !value.trim().is_empty()) {
            Ok(())
        } else {
            Err(NativeError::invalid(
                field,
                "is required for this operation",
            ))
        }
    };

    match operation.kind {
        RunControlKind::Pause => {
            required("sourceRunId", operation.source_run_id.as_ref())?;
        }
        RunControlKind::Resume => {
            required("sourceRunId", operation.source_run_id.as_ref())?;
            if operation.continuation_intent != ContinuationIntentKind::ResumeCheckpoint {
                return Err(NativeError::invalid(
                    "continuationIntent",
                    "must be resume-checkpoint for resume",
                ));
            }
        }
        RunControlKind::Continue => {
            if operation.continuation_intent == ContinuationIntentKind::None {
                return Err(NativeError::invalid(
                    "continuationIntent",
                    "must name an intent for continue",
                ));
            }
        }
        RunControlKind::Edit => {
            required("sourceMessageId", operation.source_message_id.as_ref())?;
            required(
                "sourcePromptRevisionId",
                operation.source_prompt_revision_id.as_ref(),
            )?;
            required("editRevisionId", operation.edit_revision_id.as_ref())?;
        }
        RunControlKind::Retry => {
            required("sourceAttemptId", operation.source_attempt_id.as_ref())?;
            required(
                "sourcePromptRevisionId",
                operation.source_prompt_revision_id.as_ref(),
            )?;
        }
        RunControlKind::Compare => {
            if operation.compare_state_revision_ids.len() < 2 {
                return Err(NativeError::invalid(
                    "compareStateRevisionIds",
                    "must contain at least two revisions",
                ));
            }
        }
        RunControlKind::Promote | RunControlKind::Merge => {
            if operation.merge_state_revision_ids.len() < 2 {
                return Err(NativeError::invalid(
                    "mergeStateRevisionIds",
                    "must contain at least two revisions",
                ));
            }
        }
        RunControlKind::Copy
        | RunControlKind::Duplicate
        | RunControlKind::Branch
        | RunControlKind::Fork => {}
    }

    if matches!(
        operation.kind,
        RunControlKind::Pause | RunControlKind::Resume
    ) && matches!(
        operation.active_run_policy,
        RunControlActiveRunPolicy::NotApplicable
    ) {
        return Err(NativeError::invalid(
            "activeRunPolicy",
            "must describe how the active run is handled",
        ));
    }
    Ok(())
}

fn validate_state_base(state_base: &RunControlStateBase) -> NativeResult<()> {
    validate_optional_identifier(
        "sourceStateRevisionId",
        state_base.source_state_revision_id.as_deref(),
    )?;
    validate_optional_identifier(
        "requestedHeadStateRevisionId",
        state_base.requested_head_state_revision_id.as_deref(),
    )?;
    validate_identifier(
        "resolvedStateRevisionId",
        &state_base.resolved_state_revision_id,
        MAX_ID_BYTES,
    )?;
    validate_state_digest(&state_base.resolved_state_digest)?;
    validate_identifier(
        "canonicalizationRevision",
        &state_base.resolved_state_digest.canonicalization_revision,
        MAX_ID_BYTES,
    )?;
    if state_base.selected_delta_ids.len() > MAX_REVISION_IDS {
        return Err(NativeError::invalid(
            "selectedDeltaIds",
            "contains too many revision IDs",
        ));
    }
    validate_revision_id_list("selectedDeltaIds", &state_base.selected_delta_ids, 0)?;
    validate_optional_identifier(
        "contextManifestId",
        state_base.context_manifest_id.as_deref(),
    )?;
    validate_rfc3339("resolvedAt", &state_base.resolved_at)?;
    if state_base.resolved_at_cursors.is_empty()
        || state_base.resolved_at_cursors.len() > MAX_CURSOR_COUNT
    {
        return Err(NativeError::invalid(
            "resolvedAtCursors",
            "must contain between one and 256 cursors",
        ));
    }
    // A state-base watermark is a set of positions, not an ordered list of
    // renderer counters.  Duplicate stream addresses would make the
    // watermark ambiguous (and could let one cursor shadow another during
    // native resolution), so reject them before any durable receipt is
    // created.  The native resolver performs the authoritative event lookup
    // later; this shape-level guard is intentionally independent of storage.
    let mut cursor_streams = std::collections::HashSet::new();
    for cursor in &state_base.resolved_at_cursors {
        validate_cursor(cursor)?;
        if !cursor_streams.insert((cursor.stream_kind, cursor.stream_id.as_str())) {
            return Err(NativeError::new(
                "invalid_state_base",
                "resolvedAtCursors must not contain duplicate stream addresses",
            ));
        }
    }
    match state_base.mode {
        RunControlStateBaseMode::ExactHistorical => {
            require_some(
                "sourceStateRevisionId",
                state_base.source_state_revision_id.as_ref(),
            )?;
            if !state_base.selected_delta_ids.is_empty()
                || state_base.resolution_reason != RunControlStateBaseReason::ExactFrozen
            {
                return Err(NativeError::new(
                    "invalid_state_base",
                    "exact-historical requires exact-frozen and no selected deltas",
                ));
            }
        }
        RunControlStateBaseMode::CurrentState => {
            require_some(
                "sourceStateRevisionId",
                state_base.source_state_revision_id.as_ref(),
            )?;
            require_some(
                "requestedHeadStateRevisionId",
                state_base.requested_head_state_revision_id.as_ref(),
            )?;
            if !state_base.selected_delta_ids.is_empty()
                || state_base.resolution_reason != RunControlStateBaseReason::CurrentBranchHead
            {
                return Err(NativeError::new(
                    "invalid_state_base",
                    "current-state requires current-branch-head and no selected deltas",
                ));
            }
        }
        RunControlStateBaseMode::HistoricalPlusSelectedDeltas => {
            require_some(
                "sourceStateRevisionId",
                state_base.source_state_revision_id.as_ref(),
            )?;
            if state_base.selected_delta_ids.is_empty()
                || state_base.resolution_reason
                    != RunControlStateBaseReason::HistoricalSelectedDeltas
            {
                return Err(NativeError::new(
                    "invalid_state_base",
                    "historical-plus-selected-deltas requires selected deltas",
                ));
            }
        }
        RunControlStateBaseMode::FreshBranch => {
            if state_base.source_state_revision_id.is_some()
                || !state_base.selected_delta_ids.is_empty()
                || state_base.resolution_reason != RunControlStateBaseReason::FreshIsolatedBootstrap
            {
                return Err(NativeError::new(
                    "invalid_state_base",
                    "fresh-branch must be isolated and have no source/deltas",
                ));
            }
        }
        RunControlStateBaseMode::FreshGoalStart => {
            if state_base.source_state_revision_id.is_some()
                || !state_base.selected_delta_ids.is_empty()
                || state_base.resolution_reason != RunControlStateBaseReason::FreshGoalBootstrap
            {
                return Err(NativeError::new(
                    "invalid_state_base",
                    "fresh-goal-start must be isolated and have no source/deltas",
                ));
            }
        }
    }
    Ok(())
}

fn validate_state_digest(digest: &StateDigest) -> NativeResult<()> {
    validate_bounded_text("stateDigest.value", &digest.value, 512)?;
    if digest.value.len() < 16 {
        return Err(NativeError::invalid(
            "stateDigest.value",
            "must contain at least 16 characters",
        ));
    }
    Ok(())
}

fn validate_actor(actor: &RunControlActor) -> NativeResult<()> {
    validate_identifier("actor.id", &actor.id, MAX_ID_BYTES)
}

fn validate_cursor(cursor: &RunControlCursor) -> NativeResult<()> {
    validate_identifier("cursor.streamId", &cursor.stream_id, MAX_ID_BYTES)?;
    validate_optional_identifier("cursor.journalEpoch", cursor.journal_epoch.as_deref())?;
    validate_optional_identifier("cursor.eventId", cursor.event_id.as_deref())?;
    if cursor.sequence < 0 {
        return Err(NativeError::invalid(
            "cursor.sequence",
            "must be zero or greater",
        ));
    }
    if let Some(hash) = cursor.payload_hash.as_deref() {
        validate_bounded_text("cursor.payloadHash", hash, 256)?;
    }

    // Provenance is either complete enough to resolve or explicitly absent
    // for a legacy-partial cursor.  Accepting only one of journal epoch/event
    // identity, or a payload hash without that identity, would create a
    // cursor that looks authoritative while lacking a durable event address.
    // Native storage may still classify an all-absent cursor as
    // legacy-partial, but it must never be upgraded to complete by shape
    // validation alone.
    let has_epoch = cursor.journal_epoch.is_some();
    let has_event = cursor.event_id.is_some();
    let has_hash = cursor.payload_hash.is_some();
    if has_epoch != has_event || (has_hash && (!has_epoch || !has_event)) {
        return Err(NativeError::new(
            "invalid_state_base",
            "cursor provenance must include journalEpoch and eventId together, or omit all provenance fields",
        ));
    }
    if cursor.sequence == 0 && (has_epoch || has_event || has_hash) {
        return Err(NativeError::new(
            "invalid_state_base",
            "cursor provenance must be omitted when sequence is zero",
        ));
    }
    Ok(())
}

fn validate_branch_cursor(cursor: &RunControlBranchCursorExpectation) -> NativeResult<()> {
    validate_identifier(
        "expectedBranchCursor.streamId",
        &cursor.stream_id,
        MAX_ID_BYTES,
    )?;
    validate_optional_identifier(
        "expectedBranchCursor.journalEpoch",
        cursor.journal_epoch.as_deref(),
    )?;
    validate_optional_identifier("expectedBranchCursor.eventId", cursor.event_id.as_deref())?;
    if cursor.sequence < 0 {
        return Err(NativeError::invalid(
            "expectedBranchCursor.sequence",
            "must be zero or greater",
        ));
    }
    if let Some(hash) = cursor.payload_hash.as_deref() {
        validate_bounded_text("expectedBranchCursor.payloadHash", hash, 256)?;
    }

    // `expectedBranchCursor` is an optimistic causal selector, not native
    // authority by itself, but it still travels into the durable causal
    // cursor envelope.  Keep its shape contract aligned with
    // `RunControlCursor`: an event address is either complete enough to be
    // resolved later (`journalEpoch` + `eventId`, with an optional hash) or it
    // is explicitly legacy-partial with all provenance fields absent.  A
    // partially filled address would look authoritative in the receipt while
    // lacking a durable event identity.
    let has_epoch = cursor.journal_epoch.is_some();
    let has_event = cursor.event_id.is_some();
    let has_hash = cursor.payload_hash.is_some();
    if has_epoch != has_event || (has_hash && (!has_epoch || !has_event)) {
        return Err(NativeError::new(
            "invalid_state_base",
            "expectedBranchCursor provenance must include journalEpoch and eventId together, or omit all provenance fields",
        ));
    }
    if cursor.sequence == 0 && (has_epoch || has_event || has_hash) {
        return Err(NativeError::new(
            "invalid_state_base",
            "expectedBranchCursor provenance must be omitted when sequence is zero",
        ));
    }
    Ok(())
}

fn validate_revision_id_list(
    field: &'static str,
    values: &[String],
    minimum: usize,
) -> NativeResult<()> {
    if values.len() < minimum || values.len() > MAX_REVISION_IDS {
        return Err(NativeError::invalid(
            field,
            "contains an invalid number of revision IDs",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for value in values {
        validate_identifier(field, value, MAX_ID_BYTES)?;
        if !seen.insert(value) {
            return Err(NativeError::invalid(
                field,
                "must not contain duplicate revision IDs",
            ));
        }
    }
    Ok(())
}

fn require_some<T>(field: &'static str, value: Option<&T>) -> NativeResult<()> {
    if value.is_some() {
        Ok(())
    } else {
        Err(NativeError::invalid(
            field,
            "is required for this state-base mode",
        ))
    }
}

fn validate_optional_identifier(field: &'static str, value: Option<&str>) -> NativeResult<()> {
    if let Some(value) = value {
        validate_identifier(field, value, MAX_ID_BYTES)?;
    }
    Ok(())
}

fn validate_identifier(field: &'static str, value: &str, maximum: usize) -> NativeResult<()> {
    // Validate the exact value that will be persisted and hashed.  Trimming
    // first would let a trailing newline/tab (which is a control character)
    // slip through because `trim` strips it before the control check.
    if value.trim().is_empty()
        || value.len() > maximum
        || value.chars().any(|character| character.is_control())
        || value.contains('/')
        || value.contains('\\')
    {
        return Err(NativeError::invalid(
            field,
            "must be a bounded opaque identifier",
        ));
    }
    Ok(())
}

fn validate_bounded_text(field: &'static str, value: &str, maximum: usize) -> NativeResult<()> {
    if value.trim().is_empty()
        || value.len() > maximum
        || value.chars().any(|character| character.is_control())
    {
        return Err(NativeError::invalid(
            field,
            "must be bounded text without control characters",
        ));
    }
    Ok(())
}

fn validate_rfc3339(field: &'static str, value: &str) -> NativeResult<()> {
    validate_bounded_text(field, value, MAX_TEXT_BYTES)?;
    DateTime::parse_from_rfc3339(value.trim())
        .map(|_| ())
        .map_err(|_| NativeError::invalid(field, "must be an RFC3339 timestamp"))
}

fn sha256_hex(bytes: impl AsRef<[u8]>) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes.as_ref());
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONVERSATION: &str = "conversation_0123456789abcdef0123456789abcdef";
    const BRANCH: &str = "branch_0123456789abcdef0123456789abcdef";
    const RUN: &str = "run_0123456789abcdef0123456789abcdef";
    const ATTEMPT: &str = "attempt_0123456789abcdef0123456789abcdef";
    const MESSAGE: &str = "message_0123456789abcdef0123456789abcdef";
    const PROMPT_REVISION: &str = "prompt_revision_0123456789abcdef0123456789abcdef";
    const STATE: &str = "state_rev_0123456789abcdef0123456789abcdef";
    const STREAM: &str = "state_stream_0123456789abcdef0123456789abcdef";

    fn base(mode: RunControlStateBaseMode) -> RunControlStateBase {
        let (source, requested, reason, deltas) = match mode {
            RunControlStateBaseMode::ExactHistorical => (
                Some(STATE.to_owned()),
                None,
                RunControlStateBaseReason::ExactFrozen,
                vec![],
            ),
            RunControlStateBaseMode::CurrentState => (
                Some(STATE.to_owned()),
                Some(STATE.to_owned()),
                RunControlStateBaseReason::CurrentBranchHead,
                vec![],
            ),
            RunControlStateBaseMode::HistoricalPlusSelectedDeltas => (
                Some(STATE.to_owned()),
                None,
                RunControlStateBaseReason::HistoricalSelectedDeltas,
                vec!["state_rev_delta_0123456789abcdef0123456789abcdef".to_owned()],
            ),
            RunControlStateBaseMode::FreshBranch => (
                None,
                None,
                RunControlStateBaseReason::FreshIsolatedBootstrap,
                vec![],
            ),
            RunControlStateBaseMode::FreshGoalStart => (
                None,
                None,
                RunControlStateBaseReason::FreshGoalBootstrap,
                vec![],
            ),
        };
        RunControlStateBase {
            mode,
            source_state_revision_id: source,
            requested_head_state_revision_id: requested,
            resolved_state_revision_id: STATE.to_owned(),
            resolved_state_digest: StateDigest {
                algorithm: StateDigestAlgorithm::Sha256,
                canonicalization_revision: "state-revision-c14n-v1".to_owned(),
                value: "0123456789abcdef0123456789abcdef".to_owned(),
            },
            selected_delta_ids: deltas,
            context_manifest_id: None,
            resolution_reason: reason,
            resolved_at: "2026-09-11T00:00:00Z".to_owned(),
            resolved_at_cursors: vec![RunControlCursor {
                stream_kind: RunControlStreamKind::Branch,
                stream_id: STREAM.to_owned(),
                journal_epoch: None,
                sequence: 1,
                event_id: None,
                payload_hash: None,
            }],
        }
    }

    fn request(kind: RunControlKind) -> RunControlOperationRequest {
        RunControlOperationRequest {
            schema_version: Some(RUN_CONTROL_OPERATION_SCHEMA_VERSION),
            operation_id: "op_0123456789abcdef0123456789abcdef".to_owned(),
            kind,
            conversation_id: CONVERSATION.to_owned(),
            branch_id: BRANCH.to_owned(),
            source_run_id: Some(RUN.to_owned()),
            source_attempt_id: Some(ATTEMPT.to_owned()),
            source_message_id: Some(MESSAGE.to_owned()),
            source_prompt_revision_id: Some(PROMPT_REVISION.to_owned()),
            state_base: base(RunControlStateBaseMode::CurrentState),
            edit_revision_id: Some(
                "prompt_revision_edit_0123456789abcdef0123456789abcdef".to_owned(),
            ),
            continuation_intent: ContinuationIntentKind::UnfinishedAnswer,
            active_run_policy: RunControlActiveRunPolicy::ApplyAtSafeBoundary,
            expected_active_run_id: Some(RUN.to_owned()),
            expected_conversation_version: Some(2),
            expected_branch_cursor: None,
            compare_state_revision_ids: vec![],
            merge_state_revision_ids: vec![],
            actor: RunControlActor {
                kind: RunControlActorKind::User,
                id: "user_local".to_owned(),
            },
            idempotency_key: "run-control:op_0123456789abcdef0123456789abcdef".to_owned(),
            created_at: "2026-09-11T00:00:00Z".to_owned(),
        }
    }

    #[test]
    fn resolves_current_state_retry_and_hashes_without_raw_prompt() {
        let resolved = request(RunControlKind::Retry)
            .resolve()
            .expect("retry should resolve");
        assert_eq!(
            resolved.schema_version,
            RUN_CONTROL_OPERATION_SCHEMA_VERSION
        );
        assert_eq!(resolved.operation_state, RunControlOperationState::Resolved);
        assert_eq!(resolved.canonical_payload_hash.len(), 64);
        let serialized = serde_json::to_string(&resolved).expect("operation should serialize");
        // Prompt-revision identifiers are intentionally present; only raw
        // prompt content must stay outside the portable operation envelope.
        assert!(!serialized.contains("raw prompt body"));
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn resolver_binds_a_native_authority_continuity_record_without_granting_authority() {
        let resolved = request(RunControlKind::Retry)
            .resolve()
            .expect("retry should resolve");
        let record_id = resolved
            .authority_continuity_record_id
            .as_deref()
            .expect("new resolver output should carry a continuity record ID");
        assert!(record_id.starts_with("authority_continuity_"));
        validate_authority_continuity_record_id(record_id)
            .expect("resolver-generated continuity ID should validate");

        let append = resolved
            .to_state_revision_append_request()
            .expect("retry should map to a state-revision append");
        let authority: serde_json::Value =
            serde_json::from_str(&append.authority_json).expect("authority JSON should parse");
        assert_eq!(
            authority
                .get("recordId")
                .and_then(serde_json::Value::as_str),
            Some(record_id)
        );
        assert_eq!(
            authority
                .get("effectiveStatus")
                .and_then(serde_json::Value::as_str),
            Some("not-evaluated")
        );
        assert_eq!(
            authority
                .get("effectState")
                .and_then(serde_json::Value::as_str),
            Some("none")
        );
        assert_eq!(
            authority
                .get("sameAttemptRetryAllowed")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn persisted_continuity_id_cannot_drift_from_operation_id() {
        let mut resolved = request(RunControlKind::Retry)
            .resolve()
            .expect("retry should resolve");
        resolved.authority_continuity_record_id = Some(
            "authority_continuity_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
                .to_owned(),
        );
        let error = resolved
            .validate_integrity()
            .expect_err("continuity record must remain bound to operation");
        assert_eq!(error.code, "run_control_integrity_failed");
    }

    #[test]
    fn run_control_wire_vocabulary_is_closed_and_kebab_case() {
        let kinds = [
            (RunControlKind::Pause, "pause"),
            (RunControlKind::Resume, "resume"),
            (RunControlKind::Continue, "continue"),
            (RunControlKind::Edit, "edit"),
            (RunControlKind::Retry, "retry"),
            (RunControlKind::Copy, "copy"),
            (RunControlKind::Duplicate, "duplicate"),
            (RunControlKind::Branch, "branch"),
            (RunControlKind::Fork, "fork"),
            (RunControlKind::Compare, "compare"),
            (RunControlKind::Promote, "promote"),
            (RunControlKind::Merge, "merge"),
        ];
        for (kind, expected) in kinds {
            assert_eq!(
                serde_json::to_value(kind).unwrap(),
                serde_json::json!(expected)
            );
        }
        assert!(serde_json::from_str::<RunControlKind>("\"unknown\"").is_err());

        let states = [
            (RunControlOperationState::Resolved, "resolved"),
            (RunControlOperationState::Applied, "applied"),
            (RunControlOperationState::Blocked, "blocked"),
            (RunControlOperationState::Rejected, "rejected"),
            (RunControlOperationState::Cancelled, "cancelled"),
            (RunControlOperationState::Failed, "failed"),
        ];
        for (state, expected) in states {
            assert_eq!(
                serde_json::to_value(state).unwrap(),
                serde_json::json!(expected)
            );
        }
    }

    #[test]
    fn resolver_rejects_unsupported_schema_identifiers_and_timestamps() {
        let mut unsupported = request(RunControlKind::Retry);
        unsupported.schema_version = Some(RUN_CONTROL_OPERATION_SCHEMA_VERSION + 1);
        assert_eq!(
            unsupported.resolve().expect_err("unsupported schema").code,
            "unsupported_schema"
        );

        let mut path_like = request(RunControlKind::Retry);
        path_like.operation_id = "C:\\Users\\khang\\secret".to_owned();
        assert_eq!(
            path_like
                .resolve()
                .expect_err("path-like identifiers are forbidden")
                .code,
            "invalid_input"
        );

        let mut whitespace = request(RunControlKind::Retry);
        whitespace.idempotency_key = "   ".to_owned();
        assert_eq!(
            whitespace
                .resolve()
                .expect_err("blank idempotency key")
                .code,
            "invalid_input"
        );

        let mut oversized = request(RunControlKind::Retry);
        oversized.operation_id = "x".repeat(MAX_ID_BYTES + 1);
        assert_eq!(
            oversized.resolve().expect_err("oversized identifier").code,
            "invalid_input"
        );

        let mut invalid_time = request(RunControlKind::Retry);
        invalid_time.created_at = "not-an-rfc3339-time".to_owned();
        assert_eq!(
            invalid_time.resolve().expect_err("invalid timestamp").code,
            "invalid_input"
        );
    }

    #[test]
    fn resolver_rejects_negative_versions_and_cursors() {
        let mut version = request(RunControlKind::Retry);
        version.expected_conversation_version = Some(-1);
        assert_eq!(
            version.resolve().expect_err("negative version").code,
            "invalid_input"
        );

        let mut cursor = request(RunControlKind::Retry);
        cursor.expected_branch_cursor = Some(RunControlBranchCursorExpectation {
            stream_kind: RunControlStreamKind::Branch,
            stream_id: STREAM.to_owned(),
            journal_epoch: None,
            sequence: -1,
            event_id: None,
            payload_hash: None,
        });
        assert_eq!(
            cursor.resolve().expect_err("negative branch cursor").code,
            "invalid_input"
        );
    }

    #[test]
    fn resolver_rejects_partial_cursor_provenance_but_preserves_all_absent_legacy_shape() {
        let mut epoch_without_event = request(RunControlKind::Retry);
        epoch_without_event.state_base.resolved_at_cursors[0].journal_epoch =
            Some("journal_epoch_0123456789abcdef0123456789abcdef".to_owned());
        assert_eq!(
            epoch_without_event
                .resolve()
                .expect_err("journal epoch without event identity must fail")
                .code,
            "invalid_state_base"
        );

        let mut hash_without_identity = request(RunControlKind::Retry);
        hash_without_identity.state_base.resolved_at_cursors[0].payload_hash =
            Some("0123456789abcdef0123456789abcdef".to_owned());
        assert_eq!(
            hash_without_identity
                .resolve()
                .expect_err("payload hash without event identity must fail")
                .code,
            "invalid_state_base"
        );

        // Existing migrated/legacy fixtures may have no event identity at
        // all.  Shape validation keeps those rows representable; storage
        // provenance validation decides whether they are executable.
        request(RunControlKind::Retry)
            .resolve()
            .expect("all-absent cursor provenance remains a legacy shape");
    }

    #[test]
    fn resolver_rejects_partial_expected_branch_cursor_provenance() {
        let mut epoch_without_event = request(RunControlKind::Retry);
        epoch_without_event.expected_branch_cursor = Some(RunControlBranchCursorExpectation {
            stream_kind: RunControlStreamKind::Branch,
            stream_id: STREAM.to_owned(),
            journal_epoch: Some("journal_epoch_0123456789abcdef0123456789abcdef".to_owned()),
            sequence: 1,
            event_id: None,
            payload_hash: None,
        });
        assert_eq!(
            epoch_without_event
                .resolve()
                .expect_err("expected cursor epoch without event identity must fail")
                .code,
            "invalid_state_base"
        );

        let mut hash_without_identity = request(RunControlKind::Retry);
        hash_without_identity.expected_branch_cursor = Some(RunControlBranchCursorExpectation {
            stream_kind: RunControlStreamKind::Branch,
            stream_id: STREAM.to_owned(),
            journal_epoch: None,
            sequence: 1,
            event_id: None,
            payload_hash: Some("0123456789abcdef0123456789abcdef".to_owned()),
        });
        assert_eq!(
            hash_without_identity
                .resolve()
                .expect_err("expected cursor hash without event identity must fail")
                .code,
            "invalid_state_base"
        );

        let mut zero_with_identity = request(RunControlKind::Retry);
        zero_with_identity.expected_branch_cursor = Some(RunControlBranchCursorExpectation {
            stream_kind: RunControlStreamKind::Branch,
            stream_id: STREAM.to_owned(),
            journal_epoch: Some("journal_epoch_0123456789abcdef0123456789abcdef".to_owned()),
            sequence: 0,
            event_id: Some("event_0123456789abcdef0123456789abcdef".to_owned()),
            payload_hash: None,
        });
        assert_eq!(
            zero_with_identity
                .resolve()
                .expect_err("zero expected cursor cannot carry event identity")
                .code,
            "invalid_state_base"
        );

        let mut legacy_partial = request(RunControlKind::Retry);
        legacy_partial.expected_branch_cursor = Some(RunControlBranchCursorExpectation {
            stream_kind: RunControlStreamKind::Branch,
            stream_id: STREAM.to_owned(),
            journal_epoch: None,
            sequence: 1,
            event_id: None,
            payload_hash: None,
        });
        legacy_partial
            .resolve()
            .expect("all-absent expected cursor provenance remains representable");
    }

    #[test]
    fn resolver_rejects_cursor_identity_on_zero_sequence() {
        let mut cursor = request(RunControlKind::Retry);
        {
            let cursor = &mut cursor.state_base.resolved_at_cursors[0];
            cursor.sequence = 0;
            cursor.journal_epoch =
                Some("journal_epoch_0123456789abcdef0123456789abcdef".to_owned());
            cursor.event_id = Some("event_0123456789abcdef0123456789abcdef".to_owned());
        }
        assert_eq!(
            cursor
                .resolve()
                .expect_err("zero sequence cannot carry event identity")
                .code,
            "invalid_state_base"
        );
    }

    #[test]
    fn resolver_rejects_duplicate_cursor_stream_addresses() {
        let mut operation = request(RunControlKind::Retry);
        operation
            .state_base
            .resolved_at_cursors
            .push(operation.state_base.resolved_at_cursors[0].clone());
        assert_eq!(
            operation
                .resolve()
                .expect_err("duplicate stream cursors must fail")
                .code,
            "invalid_state_base"
        );
    }

    #[test]
    fn all_state_base_modes_resolve_only_with_their_declared_reason() {
        let modes = [
            RunControlStateBaseMode::ExactHistorical,
            RunControlStateBaseMode::CurrentState,
            RunControlStateBaseMode::HistoricalPlusSelectedDeltas,
            RunControlStateBaseMode::FreshBranch,
            RunControlStateBaseMode::FreshGoalStart,
        ];
        for mode in modes {
            let mut input = request(RunControlKind::Retry);
            input.state_base = base(mode);
            let resolved = input
                .resolve()
                .expect("fixture mode should satisfy contract");
            assert_eq!(resolved.state_base.mode, mode);
        }
    }

    #[test]
    fn canonical_hash_changes_when_idempotency_payload_changes() {
        let first = request(RunControlKind::Retry)
            .resolve()
            .expect("first operation should resolve");
        let mut changed_input = request(RunControlKind::Retry);
        changed_input.idempotency_key = "run-control:another-operation-key".to_owned();
        let changed = changed_input
            .resolve()
            .expect("changed operation should resolve");
        assert_ne!(first.canonical_payload_hash, changed.canonical_payload_hash);
    }

    #[test]
    fn duplicate_creates_a_branch_fact_and_never_a_continuation_fact() {
        let resolved = request(RunControlKind::Duplicate)
            .resolve()
            .expect("duplicate should resolve");
        let append = resolved
            .to_state_revision_append_request()
            .expect("duplicate should map to a durable branch fact");
        assert_eq!(append.kind, "branch");
        assert_eq!(append.edge_kind.as_deref(), Some("branches-from"));
        assert_ne!(append.kind, "continuation");
        assert_ne!(append.edge_kind.as_deref(), Some("continues-from"));
    }

    #[test]
    fn state_digest_algorithm_uses_portable_wire_names() {
        let values = [
            (StateDigestAlgorithm::Sha256, "sha-256"),
            (StateDigestAlgorithm::Sha384, "sha-384"),
            (StateDigestAlgorithm::Sha512, "sha-512"),
            (StateDigestAlgorithm::Blake3, "blake3"),
        ];
        for (algorithm, expected) in values {
            assert_eq!(
                serde_json::to_value(algorithm).unwrap(),
                serde_json::json!(expected)
            );
        }
    }

    #[test]
    fn every_mutating_operation_has_a_closed_revision_and_edge_mapping() {
        let expected = [
            (
                RunControlKind::Pause,
                Some("checkpoint"),
                Some("checkpoint-of"),
            ),
            (
                RunControlKind::Resume,
                Some("resume"),
                Some("resumes-from-checkpoint"),
            ),
            (
                RunControlKind::Continue,
                Some("continuation"),
                Some("continues-from"),
            ),
            (RunControlKind::Edit, Some("prompt-edit"), Some("edits")),
            (RunControlKind::Retry, Some("retry-result"), Some("retries")),
            (
                RunControlKind::Duplicate,
                Some("branch"),
                Some("branches-from"),
            ),
            (
                RunControlKind::Branch,
                Some("branch"),
                Some("branches-from"),
            ),
            (RunControlKind::Fork, Some("fork"), Some("forks-from")),
            (RunControlKind::Promote, Some("promotion"), Some("promotes")),
            (RunControlKind::Merge, Some("merge"), Some("merges-from")),
        ];
        for (kind, revision, edge) in expected {
            assert!(kind.mutates_state());
            assert_eq!(kind.state_revision_kind(), revision);
            assert_eq!(kind.default_edge_kind(), edge);
        }
        assert!(!RunControlKind::Copy.mutates_state());
        assert!(!RunControlKind::Compare.mutates_state());
        assert_eq!(RunControlKind::Copy.state_revision_kind(), None);
        assert_eq!(RunControlKind::Copy.default_edge_kind(), None);
        assert_eq!(RunControlKind::Compare.state_revision_kind(), None);
        assert_eq!(RunControlKind::Compare.default_edge_kind(), None);
    }

    #[test]
    fn copy_and_compare_are_projection_only_operations() {
        for kind in [RunControlKind::Copy, RunControlKind::Compare] {
            let mut input = request(kind);
            if kind == RunControlKind::Compare {
                input.compare_state_revision_ids = vec![
                    STATE.to_owned(),
                    "state_rev_other_0123456789abcdef0123456789abcdef".to_owned(),
                ];
            }
            let resolved = input
                .resolve()
                .expect("projection operation should resolve");
            let error = resolved
                .to_state_revision_append_request()
                .expect_err("projection operation must not mutate state");
            assert_eq!(error.code, "run_control_projection_only");
        }
    }

    #[test]
    fn append_request_is_redacted_and_binds_operation_causality() {
        let resolved = request(RunControlKind::Retry)
            .resolve()
            .expect("retry should resolve");
        let append = resolved
            .to_state_revision_append_request()
            .expect("retry should map to an append request");
        assert!(append.causation_json.contains("operationId"));
        assert!(append.causation_json.contains("idempotencyKeyHash"));
        assert!(append.manifest_json.contains("resolvedStateRevisionId"));
        assert!(append.authority_json.contains("renderer-safe"));
        assert!(append.routing_cache_json.contains("not-authorized"));
        for payload in [
            &append.actor_json,
            &append.causation_json,
            &append.manifest_json,
            &append.authority_json,
            &append.routing_cache_json,
            &append.watermark_json,
        ] {
            assert!(!payload.contains("raw prompt"));
            assert!(!payload.contains("apiKey"));
            assert!(!payload.contains("cookie"));
            assert!(!payload.contains("attachmentBytes"));
        }
    }

    #[test]
    fn fresh_state_bases_require_bootstrap_and_historical_mutations_require_head() {
        for mode in [
            RunControlStateBaseMode::FreshBranch,
            RunControlStateBaseMode::FreshGoalStart,
        ] {
            let mut input = request(RunControlKind::Retry);
            input.state_base = base(mode);
            let resolved = input.resolve().expect("fresh base should resolve");
            let error = resolved
                .to_state_revision_append_request()
                .expect_err("fresh base needs coordinator bootstrap");
            assert_eq!(error.code, "run_control_bootstrap_required");
        }

        let mut historical = request(RunControlKind::Retry);
        historical.state_base = base(RunControlStateBaseMode::ExactHistorical);
        let resolved = historical
            .resolve()
            .expect("historical base should resolve");
        let error = resolved
            .to_state_revision_append_request()
            .expect_err("mutating operation must pin expected head");
        assert_eq!(error.code, "invalid_state_base");
    }

    #[test]
    fn pause_and_resume_require_an_explicit_active_run_policy_and_intent() {
        let mut pause = request(RunControlKind::Pause);
        pause.active_run_policy = RunControlActiveRunPolicy::NotApplicable;
        assert_eq!(
            pause.resolve().expect_err("pause policy is required").code,
            "invalid_input"
        );

        let mut resume = request(RunControlKind::Resume);
        resume.continuation_intent = ContinuationIntentKind::UnfinishedAnswer;
        assert_eq!(
            resume
                .resolve()
                .expect_err("resume must use checkpoint intent")
                .code,
            "invalid_input"
        );
    }

    #[test]
    fn applied_and_blocked_operations_preserve_typed_results() {
        let resolved = request(RunControlKind::Retry)
            .resolve()
            .expect("retry should resolve");
        let applied = resolved
            .clone()
            .with_applied_revision("state_rev_applied_0123456789abcdef0123456789abcdef".to_owned());
        assert_eq!(applied.operation_state, RunControlOperationState::Applied);
        assert_eq!(
            applied
                .result
                .as_ref()
                .and_then(|result| result.result_state_revision_id.as_deref()),
            Some("state_rev_applied_0123456789abcdef0123456789abcdef")
        );
        let blocked = resolved.blocked("safe-boundary-not-reached");
        assert_eq!(blocked.operation_state, RunControlOperationState::Blocked);
        assert_eq!(
            blocked
                .result
                .as_ref()
                .and_then(|result| result.blocked_reason.as_deref()),
            Some("safe-boundary-not-reached")
        );
        let append = blocked
            .to_state_revision_append_request()
            .expect("blocked operation remains a durable fact");
        assert_eq!(append.status, "blocked");
    }

    #[test]
    fn expected_branch_cursor_is_carried_as_a_causal_watermark() {
        let mut input = request(RunControlKind::Retry);
        input.expected_branch_cursor = Some(RunControlBranchCursorExpectation {
            stream_kind: RunControlStreamKind::Branch,
            stream_id: STREAM.to_owned(),
            journal_epoch: Some("epoch_01".to_owned()),
            sequence: 7,
            event_id: Some("event_07".to_owned()),
            payload_hash: Some("abcdef0123456789".to_owned()),
        });
        let resolved = input.resolve().expect("cursor should resolve");
        let append = resolved
            .to_state_revision_append_request()
            .expect("cursor should map to append request");
        assert!(append.watermark_json.starts_with('{'));
        assert!(append.watermark_json.contains("\"resolvedAt\""));
        assert!(append.watermark_json.contains("\"cursors\""));
        assert!(append.causal_cursor_json.contains("\"sequence\":7"));
        assert!(append
            .causal_cursor_json
            .contains("\"eventId\":\"event_07\""));
    }

    #[test]
    fn renderer_request_rejects_native_owned_fields() {
        let mut object = serde_json::to_value(request(RunControlKind::Retry))
            .expect("request should serialize")
            .as_object()
            .expect("request is an object")
            .clone();
        object.insert("operationState".to_owned(), serde_json::json!("applied"));
        let error =
            serde_json::from_value::<RunControlOperationRequest>(serde_json::Value::Object(object))
                .expect_err("renderer must not submit native-owned operation state");
        assert!(error.to_string().contains("operationState"));
    }

    #[test]
    fn resolver_rejects_control_characters_in_identifiers_and_bounded_text() {
        let mut operation = request(RunControlKind::Retry);
        operation.operation_id = "operation_0123456789abcdef0123456789abc\n".to_owned();
        let error = operation
            .resolve()
            .expect_err("control characters must not cross the native boundary");
        assert_eq!(error.code, "invalid_input");

        let mut digest = request(RunControlKind::Retry);
        digest.state_base.resolved_state_digest.value = "0123456789abcdef\u{0000}".to_owned();
        let error = digest
            .resolve()
            .expect_err("control characters must not enter state digests");
        assert_eq!(error.code, "invalid_input");

        let mut actor = request(RunControlKind::Retry);
        actor.actor.id = "user_\tlocal".to_owned();
        let error = actor
            .resolve()
            .expect_err("actor identifiers must be bounded opaque IDs");
        assert_eq!(error.code, "invalid_input");
    }

    #[test]
    fn resolver_rejects_duplicate_revision_ids_and_enforces_operation_arity() {
        let mut compare = request(RunControlKind::Compare);
        compare.compare_state_revision_ids = vec![STATE.to_owned(), STATE.to_owned()];
        let error = compare
            .resolve()
            .expect_err("compare inputs must be unique");
        assert_eq!(error.code, "invalid_input");

        let mut merge = request(RunControlKind::Merge);
        merge.merge_state_revision_ids = vec![STATE.to_owned()];
        let error = merge
            .resolve()
            .expect_err("merge requires at least two state revisions");
        assert_eq!(error.code, "invalid_input");

        let mut promote = request(RunControlKind::Promote);
        promote.merge_state_revision_ids = vec![
            STATE.to_owned(),
            "state_rev_other_0123456789abcdef0123456789abcdef".to_owned(),
        ];
        let resolved = promote.resolve().expect("promotion arity should resolve");
        let append = resolved
            .to_state_revision_append_request()
            .expect("promotion should map to a durable state fact");
        assert_eq!(append.kind, "promotion");
        assert_eq!(append.edge_kind.as_deref(), Some("promotes"));
    }

    #[test]
    fn resolver_rejects_state_base_reason_and_shape_mismatches() {
        let mut current = request(RunControlKind::Retry);
        current.state_base.resolution_reason = RunControlStateBaseReason::ExactFrozen;
        let error = current
            .resolve()
            .expect_err("current state must identify the current branch head");
        assert_eq!(error.code, "invalid_state_base");

        let mut historical = request(RunControlKind::Retry);
        historical.state_base = base(RunControlStateBaseMode::HistoricalPlusSelectedDeltas);
        historical.state_base.selected_delta_ids.clear();
        let error = historical
            .resolve()
            .expect_err("historical selected-delta state requires at least one selected delta");
        assert_eq!(error.code, "invalid_state_base");

        let mut fresh = request(RunControlKind::Retry);
        fresh.state_base = base(RunControlStateBaseMode::FreshBranch);
        fresh.state_base.source_state_revision_id = Some(STATE.to_owned());
        let error = fresh
            .resolve()
            .expect_err("fresh branches cannot carry a source revision");
        assert_eq!(error.code, "invalid_state_base");
    }

    #[test]
    fn canonical_hash_is_deterministic_for_identical_requests() {
        let first = request(RunControlKind::Retry)
            .resolve()
            .expect("first operation should resolve");
        let second = request(RunControlKind::Retry)
            .resolve()
            .expect("second operation should resolve");
        assert_eq!(first.canonical_payload_hash, second.canonical_payload_hash);
        assert_eq!(first, second);
    }

    #[test]
    fn mutating_operation_status_maps_to_storage_status_without_claiming_applied() {
        let resolved = request(RunControlKind::Retry)
            .resolve()
            .expect("retry should resolve");
        let applied = resolved
            .clone()
            .with_applied_revision("state_rev_applied_0123456789abcdef0123456789abcdef".to_owned());
        assert_eq!(
            applied
                .to_state_revision_append_request()
                .expect("applied operation maps to candidate state fact")
                .status,
            "candidate"
        );

        for (operation, expected_status) in [
            (
                resolved.clone().blocked("safe-boundary-not-reached"),
                "blocked",
            ),
            (
                {
                    let mut operation = resolved.clone();
                    operation.operation_state = RunControlOperationState::Rejected;
                    operation
                },
                "rejected",
            ),
            (
                {
                    let mut operation = resolved.clone();
                    operation.operation_state = RunControlOperationState::Cancelled;
                    operation
                },
                "discarded",
            ),
            (
                {
                    let mut operation = resolved.clone();
                    operation.operation_state = RunControlOperationState::Failed;
                    operation
                },
                "invalid",
            ),
        ] {
            assert_eq!(
                operation
                    .to_state_revision_append_request()
                    .expect("typed terminal operation should remain a durable fact")
                    .status,
                expected_status
            );
        }
    }

    #[test]
    fn every_terminal_result_rejects_a_cross_branch_result_branch_id() {
        let resolved = request(RunControlKind::Retry)
            .resolve()
            .expect("retry should resolve");
        let terminal_operations = [
            resolved.clone().with_applied_revision(
                "state_rev_applied_0123456789abcdef0123456789abcdef".to_owned(),
            ),
            resolved.clone().blocked("safe-boundary-not-reached"),
            {
                let mut operation = resolved.clone().blocked("rejected-by-policy");
                operation.operation_state = RunControlOperationState::Rejected;
                operation
            },
            {
                let mut operation = resolved.clone().blocked("cancelled-by-user");
                operation.operation_state = RunControlOperationState::Cancelled;
                operation
            },
            {
                let mut operation = resolved.clone().failed("provider-failed");
                operation.operation_state = RunControlOperationState::Failed;
                operation
            },
        ];

        for mut operation in terminal_operations {
            operation
                .result
                .as_mut()
                .expect("terminal operation should carry a result")
                .result_branch_id =
                Some("branch_foreign_0123456789abcdef0123456789abcdef".to_owned());
            let error = operation
                .validate_integrity()
                .expect_err("terminal result must remain in the operation branch");
            assert_eq!(error.code, "run_control_integrity_failed");
        }
    }

    #[test]
    fn branch_apply_result_carries_source_cursor_and_destination_branch() {
        let resolved = request(RunControlKind::Branch)
            .resolve()
            .expect("branch operation should resolve");
        let source_cursor = RunControlCursor {
            stream_kind: RunControlStreamKind::Branch,
            stream_id: STREAM.to_owned(),
            journal_epoch: Some("journal_epoch_0123456789abcdef0123456789abcdef".to_owned()),
            sequence: 1,
            event_id: Some("event_0123456789abcdef0123456789abcdef".to_owned()),
            payload_hash: Some("a".repeat(64)),
        };
        let applied = resolved.with_applied_branch(
            "branch_child_0123456789abcdef0123456789abcdef".to_owned(),
            source_cursor.clone(),
        );
        applied
            .validate_integrity()
            .expect("branch result should permit a destination branch");
        let result = applied.result.expect("branch result should be present");
        assert_eq!(
            result.result_branch_id.as_deref(),
            Some("branch_child_0123456789abcdef0123456789abcdef")
        );
        assert_eq!(result.source_branch_cursor, Some(source_cursor));
        assert!(result.destination_branch_cursor.is_none());
    }

    #[test]
    fn applied_result_requires_a_well_formed_result_branch_id() {
        let resolved = request(RunControlKind::Retry)
            .resolve()
            .expect("retry should resolve");

        let mut missing = resolved
            .clone()
            .with_applied_revision("state_rev_applied_0123456789abcdef0123456789abcdef".to_owned());
        missing
            .result
            .as_mut()
            .expect("applied operation should carry a result")
            .result_branch_id = None;
        let missing_error = missing
            .validate_integrity()
            .expect_err("applied result must identify its branch");
        assert_eq!(missing_error.code, "run_control_integrity_failed");

        let mut malformed = resolved
            .with_applied_revision("state_rev_applied_0123456789abcdef0123456789abcdef".to_owned());
        malformed
            .result
            .as_mut()
            .expect("applied operation should carry a result")
            .result_branch_id = Some("branch/invalid".to_owned());
        let malformed_error = malformed
            .validate_integrity()
            .expect_err("applied result branch must be an opaque identifier");
        assert_eq!(malformed_error.code, "invalid_input");
    }

    #[test]
    fn append_manifest_keeps_selected_deltas_bounded_and_redacted() {
        let mut input = request(RunControlKind::Retry);
        input.state_base = base(RunControlStateBaseMode::HistoricalPlusSelectedDeltas);
        // A mutating operation appends against the live branch head, so the
        // native mapper requires the caller's compare-and-swap expectation.
        input.state_base.requested_head_state_revision_id = Some(STATE.to_owned());
        input.state_base.selected_delta_ids =
            vec!["state_rev_delta_0123456789abcdef0123456789abcdef".to_owned()];
        let resolved = input.resolve().expect("selected delta should resolve");
        let append = resolved
            .to_state_revision_append_request()
            .expect("selected delta retry should map to a state fact");
        assert!(append.manifest_json.contains("selectedDeltaIds"));
        assert!(append
            .manifest_json
            .contains("state_rev_delta_0123456789abcdef0123456789abcdef"));
        for payload in [
            &append.actor_json,
            &append.causation_json,
            &append.manifest_json,
            &append.authority_json,
            &append.routing_cache_json,
            &append.watermark_json,
            &append.causal_cursor_json,
        ] {
            assert!(!payload.contains("promptBody"));
            assert!(!payload.contains("responseBody"));
            assert!(!payload.contains("credential"));
            assert!(!payload.contains("cookie"));
            assert!(!payload.contains("filesystemPath"));
        }
    }
}
