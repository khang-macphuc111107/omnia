//! Native exact-approval broker contracts.
//!
//! This module deliberately exposes no Tauri command and performs no host
//! operation. It is the trusted, persistence-neutral state machine that a
//! future durable repository and supervised executor must wrap in one native
//! transaction. Renderer or model output can request an approval, but cannot
//! mint a receipt, choose an audit hash, consume an allow-once receipt, or
//! construct a dispatch permit.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;

use crate::error::{NativeError, NativeResult};

pub(crate) const EXACT_APPROVAL_SCHEMA_VERSION: u32 = 1;

const MAX_CANONICAL_ARGUMENT_BYTES: usize = 1024 * 1024;
const MAX_CANONICAL_ARGUMENT_DEPTH: usize = 32;
const MAX_CANONICAL_ARGUMENT_NODES: usize = 20_000;
const MAX_COLLECTION_ITEMS: usize = 1_024;
const MAX_PRESENTATION_ITEMS: usize = 64;
const MAX_PRESENTATION_TEXT_BYTES: usize = 8 * 1024;
const MAX_ID_BYTES: usize = 320;
const MIN_APPROVAL_TTL_MS: i64 = 1_000;
const MAX_APPROVAL_TTL_MS: i64 = 15 * 60 * 1_000;
const MAX_ALLOW_RUN_DISPATCHES: u32 = 128;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub(crate) enum KernelCapability {
    PureCompute,
    ReadAppData,
    ReadWorkspace,
    WriteWorkspace,
    ExecuteProcess,
    UseNetwork,
    ExternalSideEffect,
    ControlBrowser,
    ControlComputer,
    RequestAdmin,
    AccessSecretHandle,
}

impl KernelCapability {
    fn requires_single_dispatch(self) -> bool {
        matches!(
            self,
            Self::ControlComputer | Self::RequestAdmin | Self::AccessSecretHandle
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CapabilitySubjectType {
    SkillVersion,
    Workspace,
    Provider,
    Agent,
    ToolVersion,
    User,
}

impl CapabilitySubjectType {
    fn requires_content_hash(self) -> bool {
        matches!(self, Self::SkillVersion | Self::ToolVersion)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApprovalChoice {
    AllowOnce,
    AllowRun,
    Deny,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReservationState {
    Reserved,
    ReleasedBeforeDispatch,
    DispatchStarted,
    Finalized,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DispatchOutcome {
    Succeeded,
    Failed,
    Cancelled,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApprovalAuditAction {
    RequestCreated,
    DecisionRecorded,
    DispatchReserved,
    ReservationReleased,
    DispatchStarted,
    DispatchFinalized,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApprovalAuditOutcome {
    Proposed,
    Allowed,
    Denied,
    Cancelled,
    Succeeded,
    Failed,
    OutcomeUnknown,
}

#[derive(Clone, Debug)]
pub(crate) struct ExactOperationInput {
    pub profile_id: String,
    pub authenticated_client_session_id: String,
    pub authenticated_client_session_epoch: u64,
    pub run_id: String,
    pub attempt_id: String,
    pub iteration_id: String,
    pub tool_call_id: String,
    pub agent_id: String,
    pub environment_id: String,
    pub environment_revision: u64,
    pub environment_config_sha256: String,
    pub subject_type: CapabilitySubjectType,
    pub subject_id: String,
    pub subject_content_sha256: Option<String>,
    pub capability: KernelCapability,
    pub operation_type: String,
    pub arguments: Value,
    pub tool_version_sha256: String,
    pub capability_manifest_sha256: String,
    pub capability_set_sha256: String,
    pub policy_version_sha256: String,
    pub context_snapshot_sha256: String,
    pub network_policy_sha256: String,
    pub executable_sha256: Option<String>,
    pub workspace_grant_revision_sha256s: Vec<String>,
    pub resource_handles: Vec<String>,
    pub destinations: Vec<String>,
    pub data_classes: Vec<String>,
    pub requires_elevation: bool,
}

/// The complete non-secret authority scope bound to an approval.
///
/// Raw operation arguments are intentionally absent. Native code canonicalizes
/// and hashes them, then discards the body from the broker state. The executor
/// must supply the current typed operation again immediately before dispatch.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExactOperationBinding {
    pub schema_version: u32,
    pub profile_id: String,
    pub authenticated_client_session_id: String,
    pub authenticated_client_session_epoch: u64,
    pub run_id: String,
    pub attempt_id: String,
    pub iteration_id: String,
    pub tool_call_id: String,
    pub agent_id: String,
    pub environment_id: String,
    pub environment_revision: u64,
    pub environment_config_sha256: String,
    pub subject_type: CapabilitySubjectType,
    pub subject_id: String,
    pub subject_content_sha256: Option<String>,
    pub capability: KernelCapability,
    pub operation_type: String,
    pub operation_arguments_sha256: String,
    pub tool_version_sha256: String,
    pub capability_manifest_sha256: String,
    pub capability_set_sha256: String,
    pub policy_version_sha256: String,
    pub context_snapshot_sha256: String,
    pub network_policy_sha256: String,
    pub executable_sha256: Option<String>,
    pub workspace_grant_revision_sha256s: Vec<String>,
    pub resource_handles: Vec<String>,
    pub destinations: Vec<String>,
    pub data_classes: Vec<String>,
    pub requires_elevation: bool,
    pub scope_sha256: String,
}

#[derive(Clone, Debug)]
pub(crate) struct TrustedApprovalPresentationInput {
    pub title: String,
    pub summary: String,
    pub target_labels: Vec<String>,
    pub consequences: Vec<String>,
    pub rollback: Option<String>,
}

/// Renderer-safe content generated by a registered native operation adapter.
/// Security-controlled scope fields are copied from `ExactOperationBinding`,
/// never from a model-authored label.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalPresentation {
    pub title: String,
    pub summary: String,
    pub target_labels: Vec<String>,
    pub consequences: Vec<String>,
    pub rollback: Option<String>,
    pub operation_type: String,
    pub capability: KernelCapability,
    pub resource_handles: Vec<String>,
    pub destinations: Vec<String>,
    pub data_classes: Vec<String>,
    pub requires_elevation: bool,
    pub operation_arguments_sha256: String,
    pub presentation_sha256: String,
}

#[derive(Clone, Debug)]
pub(crate) struct CreateApprovalRequestInput {
    pub proposal_idempotency_key: String,
    pub operation: ExactOperationInput,
    pub presentation: TrustedApprovalPresentationInput,
    pub choices: Vec<ApprovalChoice>,
    pub allow_run_max_dispatches: Option<u32>,
    pub ttl_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExactApprovalRequest {
    pub schema_version: u32,
    pub id: String,
    pub capability_request_id: String,
    pub proposal_idempotency_key: String,
    pub nonce: String,
    pub binding: ExactOperationBinding,
    pub presentation: ApprovalPresentation,
    pub choices: Vec<ApprovalChoice>,
    pub allow_run_max_dispatches: Option<u32>,
    pub requested_ttl_ms: i64,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub request_sha256: String,
    pub created_audit_event_id: String,
    pub created_audit_event_sha256: String,
}

#[derive(Clone, Debug)]
pub(crate) struct DecideApprovalInput {
    pub approval_request_id: String,
    pub decision: ApprovalChoice,
    /// Must be a native-authenticated user handle such as `user:local`.
    pub decision_actor_handle: String,
    pub current_operation: ExactOperationInput,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExactApprovalReceipt {
    pub schema_version: u32,
    pub id: String,
    pub approval_request_id: String,
    pub capability_request_id: String,
    pub request_sha256: String,
    pub request_nonce: String,
    pub binding: ExactOperationBinding,
    pub presentation_sha256: String,
    pub decision: ApprovalChoice,
    pub decision_actor_handle: String,
    pub decided_at_ms: i64,
    pub expires_at_ms: i64,
    pub maximum_dispatches: u32,
    pub decision_audit_event_id: String,
    pub decision_audit_event_sha256: String,
    pub receipt_sha256: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ReserveDispatchInput {
    pub approval_receipt_id: String,
    pub invocation_idempotency_key: String,
    pub current_operation: ExactOperationInput,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalDispatchFinalization {
    pub outcome: DispatchOutcome,
    pub reason_code: String,
    pub verification_sha256: Option<String>,
    pub finalized_at_ms: i64,
    pub audit_event_id: String,
    pub audit_event_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalReservation {
    pub schema_version: u32,
    pub id: String,
    pub approval_receipt_id: String,
    pub invocation_idempotency_key: String,
    pub scope_sha256: String,
    pub operation_arguments_sha256: String,
    pub state: ReservationState,
    pub reserved_at_ms: i64,
    pub reserved_audit_event_id: String,
    pub reserved_audit_event_sha256: String,
    pub released_at_ms: Option<i64>,
    pub release_reason_code: Option<String>,
    pub release_audit_event_id: Option<String>,
    pub release_audit_event_sha256: Option<String>,
    pub dispatch_permit_id: Option<String>,
    pub dispatch_started_at_ms: Option<i64>,
    pub dispatch_audit_event_id: Option<String>,
    pub dispatch_audit_event_sha256: Option<String>,
    pub finalization: Option<ApprovalDispatchFinalization>,
}

/// Native executor authority. This type is never deserialized from IPC.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExactDispatchPermit {
    pub schema_version: u32,
    pub id: String,
    pub reservation_id: String,
    pub approval_receipt_id: String,
    pub scope_sha256: String,
    pub operation_arguments_sha256: String,
    pub issued_at_ms: i64,
    pub pre_dispatch_audit_event_id: String,
    pub pre_dispatch_audit_event_sha256: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AuthorizeDispatchInput {
    pub reservation_id: String,
    pub current_operation: ExactOperationInput,
}

#[derive(Clone, Debug)]
pub(crate) struct ReleaseReservationInput {
    pub reservation_id: String,
    pub reason_code: String,
}

#[derive(Clone, Debug)]
pub(crate) struct FinalizeDispatchInput {
    pub reservation_id: String,
    pub outcome: DispatchOutcome,
    pub reason_code: String,
    pub verification_sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalAuditEvent {
    pub schema_version: u32,
    pub id: String,
    pub sequence_no: u64,
    pub previous_event_sha256: Option<String>,
    pub occurred_at_ms: i64,
    pub actor_kind: String,
    pub actor_id: String,
    pub action: ApprovalAuditAction,
    pub outcome: ApprovalAuditOutcome,
    pub profile_id: String,
    pub capability_request_id: String,
    pub approval_request_id: String,
    pub approval_receipt_id: Option<String>,
    pub reservation_id: Option<String>,
    pub invocation_idempotency_key: Option<String>,
    pub scope_sha256: String,
    pub operation_arguments_sha256: String,
    pub event_sha256: String,
}

pub(crate) trait ApprovalClock: Send + Sync {
    fn now_ms(&self) -> NativeResult<i64>;
}

#[derive(Debug)]
struct SystemApprovalClock;

impl ApprovalClock for SystemApprovalClock {
    fn now_ms(&self) -> NativeResult<i64> {
        let duration = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| NativeError::new("clock_invalid", "The system clock is unavailable"))?;
        i64::try_from(duration.as_millis())
            .map_err(|_| NativeError::new("clock_invalid", "The system clock is out of range"))
    }
}

#[derive(Default)]
struct ReceiptUsage {
    active_reservation_ids: HashSet<String>,
    dispatches_started: u32,
}

#[derive(Default)]
struct BrokerState {
    requests: HashMap<String, ExactApprovalRequest>,
    request_id_by_proposal_key: HashMap<String, String>,
    receipts: HashMap<String, ExactApprovalReceipt>,
    receipt_id_by_request_id: HashMap<String, String>,
    reservations: HashMap<String, ApprovalReservation>,
    reservation_id_by_invocation: HashMap<(String, String), String>,
    receipt_usage: HashMap<String, ReceiptUsage>,
    audit_events: Vec<ApprovalAuditEvent>,
}

/// Thread-safe policy core. Production persistence must transact the returned
/// state changes with the executor's durable pre-dispatch fact before any
/// external side effect is attempted.
pub(crate) struct ExactApprovalBroker {
    clock: Arc<dyn ApprovalClock>,
    state: Mutex<BrokerState>,
}

impl Default for ExactApprovalBroker {
    fn default() -> Self {
        Self::new()
    }
}

impl ExactApprovalBroker {
    pub(crate) fn new() -> Self {
        Self::with_clock(Arc::new(SystemApprovalClock))
    }

    pub(crate) fn with_clock(clock: Arc<dyn ApprovalClock>) -> Self {
        Self {
            clock,
            state: Mutex::new(BrokerState::default()),
        }
    }

    fn lock_state(&self) -> NativeResult<MutexGuard<'_, BrokerState>> {
        self.state.lock().map_err(|_| {
            NativeError::new(
                "approval_broker_unavailable",
                "The approval broker state is unavailable",
            )
        })
    }

    pub(crate) fn request_approval(
        &self,
        input: CreateApprovalRequestInput,
    ) -> NativeResult<ExactApprovalRequest> {
        let proposal_idempotency_key =
            validate_opaque_handle("proposalIdempotencyKey", &input.proposal_idempotency_key)?;
        let binding = ExactOperationBinding::freeze(&input.operation)?;
        let presentation = ApprovalPresentation::freeze(input.presentation, &binding)?;
        let (choices, allow_run_max_dispatches) =
            validate_approval_choices(&input.choices, input.allow_run_max_dispatches, &binding)?;
        if !(MIN_APPROVAL_TTL_MS..=MAX_APPROVAL_TTL_MS).contains(&input.ttl_ms) {
            return Err(NativeError::invalid(
                "ttlMs",
                "must be between 1 second and 15 minutes",
            ));
        }
        let now = self.clock.now_ms()?;
        let expires_at_ms = now
            .checked_add(input.ttl_ms)
            .ok_or_else(|| NativeError::invalid("ttlMs", "overflows the native clock"))?;
        let mut state = self.lock_state()?;

        if let Some(existing_request_id) = state
            .request_id_by_proposal_key
            .get(&proposal_idempotency_key)
            .cloned()
        {
            let existing = state.requests.get(&existing_request_id).ok_or_else(|| {
                NativeError::new(
                    "approval_integrity_failed",
                    "The approval proposal index is inconsistent",
                )
            })?;
            verify_request_integrity(existing, &state.audit_events)?;
            if existing.binding.scope_sha256 == binding.scope_sha256
                && existing.presentation.presentation_sha256 == presentation.presentation_sha256
                && existing.choices == choices
                && existing.allow_run_max_dispatches == allow_run_max_dispatches
                && existing.requested_ttl_ms == input.ttl_ms
            {
                return Ok(existing.clone());
            }
            return Err(NativeError::new(
                "approval_proposal_conflict",
                "The approval proposal key was reused for a different operation",
            ));
        }

        let request_id = native_id("approval_request");
        let capability_request_id = native_id("capability_request");
        let nonce = native_id("approval_nonce");
        let request_sha256 = hash_request_material(&RequestHashMaterial {
            schema_version: EXACT_APPROVAL_SCHEMA_VERSION,
            id: &request_id,
            capability_request_id: &capability_request_id,
            proposal_idempotency_key: &proposal_idempotency_key,
            nonce: &nonce,
            scope_sha256: &binding.scope_sha256,
            presentation_sha256: &presentation.presentation_sha256,
            choices: &choices,
            allow_run_max_dispatches,
            requested_ttl_ms: input.ttl_ms,
            created_at_ms: now,
            expires_at_ms,
        })?;
        let audit = append_audit_event(
            &mut state,
            NewAuditEvent {
                occurred_at_ms: now,
                actor_kind: "harness",
                actor_id: &binding.agent_id,
                action: ApprovalAuditAction::RequestCreated,
                outcome: ApprovalAuditOutcome::Proposed,
                binding: &binding,
                capability_request_id: &capability_request_id,
                approval_request_id: &request_id,
                approval_receipt_id: None,
                reservation_id: None,
                invocation_idempotency_key: None,
            },
        )?;
        let request = ExactApprovalRequest {
            schema_version: EXACT_APPROVAL_SCHEMA_VERSION,
            id: request_id.clone(),
            capability_request_id,
            proposal_idempotency_key: proposal_idempotency_key.clone(),
            nonce,
            binding,
            presentation,
            choices,
            allow_run_max_dispatches,
            requested_ttl_ms: input.ttl_ms,
            created_at_ms: now,
            expires_at_ms,
            request_sha256,
            created_audit_event_id: audit.id.clone(),
            created_audit_event_sha256: audit.event_sha256.clone(),
        };
        state
            .request_id_by_proposal_key
            .insert(proposal_idempotency_key, request_id.clone());
        state.requests.insert(request_id, request.clone());
        Ok(request)
    }

    pub(crate) fn decide_approval(
        &self,
        input: DecideApprovalInput,
    ) -> NativeResult<ExactApprovalReceipt> {
        let current_binding = ExactOperationBinding::freeze(&input.current_operation)?;
        let decision_actor_handle =
            validate_actor_handle("decisionActorHandle", &input.decision_actor_handle, "user")?;
        let now = self.clock.now_ms()?;
        let mut state = self.lock_state()?;
        let request = state
            .requests
            .get(&input.approval_request_id)
            .cloned()
            .ok_or_else(|| {
                NativeError::new(
                    "approval_request_not_found",
                    "The approval request does not exist",
                )
            })?;
        verify_request_integrity(&request, &state.audit_events)?;
        assert_exact_binding(&request.binding, &current_binding)?;

        if let Some(receipt_id) = state.receipt_id_by_request_id.get(&request.id).cloned() {
            let receipt = state.receipts.get(&receipt_id).ok_or_else(|| {
                NativeError::new(
                    "approval_integrity_failed",
                    "The approval receipt index is inconsistent",
                )
            })?;
            verify_receipt_integrity(receipt, &request, &state.audit_events)?;
            if receipt.decision == input.decision
                && receipt.decision_actor_handle == decision_actor_handle
            {
                return Ok(receipt.clone());
            }
            return Err(NativeError::new(
                "approval_already_decided",
                "The approval request already has a different decision",
            ));
        }
        if now >= request.expires_at_ms {
            return Err(NativeError::new(
                "approval_expired",
                "The approval request has expired",
            ));
        }
        if !request.choices.contains(&input.decision) {
            return Err(NativeError::invalid(
                "decision",
                "was not offered by the approval request",
            ));
        }
        let maximum_dispatches = match input.decision {
            ApprovalChoice::AllowOnce => 1,
            ApprovalChoice::AllowRun => request.allow_run_max_dispatches.ok_or_else(|| {
                NativeError::new(
                    "approval_integrity_failed",
                    "The allow-run request has no dispatch limit",
                )
            })?,
            ApprovalChoice::Deny => 0,
        };
        let receipt_id = native_id("approval_receipt");
        let audit_outcome = if input.decision == ApprovalChoice::Deny {
            ApprovalAuditOutcome::Denied
        } else {
            ApprovalAuditOutcome::Allowed
        };
        let audit = append_audit_event(
            &mut state,
            NewAuditEvent {
                occurred_at_ms: now,
                actor_kind: "user",
                actor_id: &decision_actor_handle,
                action: ApprovalAuditAction::DecisionRecorded,
                outcome: audit_outcome,
                binding: &request.binding,
                capability_request_id: &request.capability_request_id,
                approval_request_id: &request.id,
                approval_receipt_id: Some(&receipt_id),
                reservation_id: None,
                invocation_idempotency_key: None,
            },
        )?;
        let mut receipt = ExactApprovalReceipt {
            schema_version: EXACT_APPROVAL_SCHEMA_VERSION,
            id: receipt_id.clone(),
            approval_request_id: request.id.clone(),
            capability_request_id: request.capability_request_id.clone(),
            request_sha256: request.request_sha256.clone(),
            request_nonce: request.nonce.clone(),
            binding: request.binding.clone(),
            presentation_sha256: request.presentation.presentation_sha256.clone(),
            decision: input.decision,
            decision_actor_handle,
            decided_at_ms: now,
            expires_at_ms: request.expires_at_ms,
            maximum_dispatches,
            decision_audit_event_id: audit.id.clone(),
            decision_audit_event_sha256: audit.event_sha256.clone(),
            receipt_sha256: String::new(),
        };
        receipt.receipt_sha256 = hash_receipt_material(&receipt)?;
        state
            .receipt_id_by_request_id
            .insert(request.id.clone(), receipt_id.clone());
        state.receipts.insert(receipt_id.clone(), receipt.clone());
        state
            .receipt_usage
            .insert(receipt_id, ReceiptUsage::default());
        Ok(receipt)
    }

    /// Atomically reserves dispatch authority. A future SQLite repository must
    /// persist this mutation, the durable authorization decision, and the
    /// reservation audit event in the same transaction.
    pub(crate) fn reserve_dispatch(
        &self,
        input: ReserveDispatchInput,
    ) -> NativeResult<ApprovalReservation> {
        let invocation_idempotency_key = validate_opaque_handle(
            "invocationIdempotencyKey",
            &input.invocation_idempotency_key,
        )?;
        let current_binding = ExactOperationBinding::freeze(&input.current_operation)?;
        let now = self.clock.now_ms()?;
        let mut state = self.lock_state()?;
        let receipt = state
            .receipts
            .get(&input.approval_receipt_id)
            .cloned()
            .ok_or_else(|| {
                NativeError::new(
                    "approval_receipt_not_found",
                    "The approval receipt does not exist",
                )
            })?;
        let request = state
            .requests
            .get(&receipt.approval_request_id)
            .cloned()
            .ok_or_else(|| {
                NativeError::new(
                    "approval_integrity_failed",
                    "The approval receipt has no request",
                )
            })?;
        verify_request_integrity(&request, &state.audit_events)?;
        verify_receipt_integrity(&receipt, &request, &state.audit_events)?;
        assert_exact_binding(&receipt.binding, &current_binding)?;
        if now >= receipt.expires_at_ms {
            return Err(NativeError::new(
                "approval_expired",
                "The approval receipt has expired",
            ));
        }
        if receipt.decision == ApprovalChoice::Deny {
            return Err(NativeError::new(
                "approval_denied",
                "The exact operation was denied by the user",
            ));
        }

        let invocation_key = (receipt.id.clone(), invocation_idempotency_key.clone());
        if let Some(existing_reservation_id) = state
            .reservation_id_by_invocation
            .get(&invocation_key)
            .cloned()
        {
            let existing = state
                .reservations
                .get(&existing_reservation_id)
                .ok_or_else(|| {
                    NativeError::new(
                        "approval_integrity_failed",
                        "The approval reservation index is inconsistent",
                    )
                })?;
            if existing.scope_sha256 == current_binding.scope_sha256
                && existing.operation_arguments_sha256 == current_binding.operation_arguments_sha256
            {
                return Ok(existing.clone());
            }
            return Err(NativeError::new(
                "approval_invocation_conflict",
                "The invocation key was reused for a different operation",
            ));
        }

        {
            let usage = state.receipt_usage.get(&receipt.id).ok_or_else(|| {
                NativeError::new(
                    "approval_integrity_failed",
                    "The approval receipt usage ledger is missing",
                )
            })?;
            let committed = usage
                .dispatches_started
                .checked_add(
                    u32::try_from(usage.active_reservation_ids.len()).map_err(|_| {
                        NativeError::new(
                            "approval_limit_reached",
                            "The approval reservation count is out of range",
                        )
                    })?,
                )
                .ok_or_else(|| {
                    NativeError::new(
                        "approval_limit_reached",
                        "The approval dispatch count is out of range",
                    )
                })?;
            if committed >= receipt.maximum_dispatches {
                return Err(NativeError::new(
                    "approval_consumed",
                    "The approval receipt has no remaining dispatch authority",
                ));
            }
        }

        let reservation_id = native_id("approval_reservation");
        let audit = append_audit_event(
            &mut state,
            NewAuditEvent {
                occurred_at_ms: now,
                actor_kind: "policy",
                actor_id: "policy:approval-broker",
                action: ApprovalAuditAction::DispatchReserved,
                outcome: ApprovalAuditOutcome::Allowed,
                binding: &receipt.binding,
                capability_request_id: &receipt.capability_request_id,
                approval_request_id: &receipt.approval_request_id,
                approval_receipt_id: Some(&receipt.id),
                reservation_id: Some(&reservation_id),
                invocation_idempotency_key: Some(&invocation_idempotency_key),
            },
        )?;
        let reservation = ApprovalReservation {
            schema_version: EXACT_APPROVAL_SCHEMA_VERSION,
            id: reservation_id.clone(),
            approval_receipt_id: receipt.id.clone(),
            invocation_idempotency_key: invocation_idempotency_key.clone(),
            scope_sha256: receipt.binding.scope_sha256.clone(),
            operation_arguments_sha256: receipt.binding.operation_arguments_sha256.clone(),
            state: ReservationState::Reserved,
            reserved_at_ms: now,
            reserved_audit_event_id: audit.id.clone(),
            reserved_audit_event_sha256: audit.event_sha256.clone(),
            released_at_ms: None,
            release_reason_code: None,
            release_audit_event_id: None,
            release_audit_event_sha256: None,
            dispatch_permit_id: None,
            dispatch_started_at_ms: None,
            dispatch_audit_event_id: None,
            dispatch_audit_event_sha256: None,
            finalization: None,
        };
        state
            .receipt_usage
            .get_mut(&receipt.id)
            .expect("validated receipt usage ledger")
            .active_reservation_ids
            .insert(reservation_id.clone());
        state
            .reservation_id_by_invocation
            .insert(invocation_key, reservation_id.clone());
        state
            .reservations
            .insert(reservation_id, reservation.clone());
        Ok(reservation)
    }

    /// Releases only a pre-dispatch reservation. Once dispatch starts, the
    /// authority remains consumed even if the operation later fails or its
    /// outcome is unknown.
    pub(crate) fn release_reservation(
        &self,
        input: ReleaseReservationInput,
    ) -> NativeResult<ApprovalReservation> {
        let reason_code = validate_reason_code(&input.reason_code)?;
        let now = self.clock.now_ms()?;
        let mut state = self.lock_state()?;
        let existing = state
            .reservations
            .get(&input.reservation_id)
            .cloned()
            .ok_or_else(|| {
                NativeError::new(
                    "approval_reservation_not_found",
                    "The approval reservation does not exist",
                )
            })?;
        if existing.state == ReservationState::ReleasedBeforeDispatch {
            if existing.release_reason_code.as_deref() == Some(reason_code.as_str()) {
                return Ok(existing);
            }
            return Err(NativeError::new(
                "approval_reservation_conflict",
                "The reservation was already released for a different reason",
            ));
        }
        if existing.state != ReservationState::Reserved {
            return Err(NativeError::new(
                "approval_dispatch_already_started",
                "A reservation cannot be released after dispatch starts",
            ));
        }
        let receipt = state
            .receipts
            .get(&existing.approval_receipt_id)
            .cloned()
            .ok_or_else(|| {
                NativeError::new(
                    "approval_integrity_failed",
                    "The approval reservation has no receipt",
                )
            })?;
        {
            let usage = state.receipt_usage.get(&receipt.id).ok_or_else(|| {
                NativeError::new(
                    "approval_integrity_failed",
                    "The approval receipt usage ledger is missing",
                )
            })?;
            if !usage.active_reservation_ids.contains(&existing.id) {
                return Err(NativeError::new(
                    "approval_integrity_failed",
                    "The reservation was not active in the receipt usage ledger",
                ));
            }
        }
        let audit = append_audit_event(
            &mut state,
            NewAuditEvent {
                occurred_at_ms: now,
                actor_kind: "harness",
                actor_id: &receipt.binding.agent_id,
                action: ApprovalAuditAction::ReservationReleased,
                outcome: ApprovalAuditOutcome::Cancelled,
                binding: &receipt.binding,
                capability_request_id: &receipt.capability_request_id,
                approval_request_id: &receipt.approval_request_id,
                approval_receipt_id: Some(&receipt.id),
                reservation_id: Some(&existing.id),
                invocation_idempotency_key: Some(&existing.invocation_idempotency_key),
            },
        )?;
        let mut released = existing;
        released.state = ReservationState::ReleasedBeforeDispatch;
        released.released_at_ms = Some(now);
        released.release_reason_code = Some(reason_code);
        released.release_audit_event_id = Some(audit.id.clone());
        released.release_audit_event_sha256 = Some(audit.event_sha256.clone());
        let usage = state
            .receipt_usage
            .get_mut(&receipt.id)
            .expect("validated receipt usage ledger");
        let removed = usage.active_reservation_ids.remove(&released.id);
        debug_assert!(removed, "validated reservation must remain active");
        state
            .reservations
            .insert(released.id.clone(), released.clone());
        Ok(released)
    }

    /// Recomputes the exact current operation scope and consumes the reserved
    /// dispatch before returning a permit to trusted executor code.
    pub(crate) fn authorize_dispatch(
        &self,
        input: AuthorizeDispatchInput,
    ) -> NativeResult<ExactDispatchPermit> {
        let current_binding = ExactOperationBinding::freeze(&input.current_operation)?;
        let now = self.clock.now_ms()?;
        let mut state = self.lock_state()?;
        let existing = state
            .reservations
            .get(&input.reservation_id)
            .cloned()
            .ok_or_else(|| {
                NativeError::new(
                    "approval_reservation_not_found",
                    "The approval reservation does not exist",
                )
            })?;
        let receipt = state
            .receipts
            .get(&existing.approval_receipt_id)
            .cloned()
            .ok_or_else(|| {
                NativeError::new(
                    "approval_integrity_failed",
                    "The approval reservation has no receipt",
                )
            })?;
        let request = state
            .requests
            .get(&receipt.approval_request_id)
            .cloned()
            .ok_or_else(|| {
                NativeError::new(
                    "approval_integrity_failed",
                    "The approval receipt has no request",
                )
            })?;
        verify_request_integrity(&request, &state.audit_events)?;
        verify_receipt_integrity(&receipt, &request, &state.audit_events)?;
        assert_exact_binding(&receipt.binding, &current_binding)?;

        if existing.state == ReservationState::DispatchStarted {
            return permit_from_reservation(&existing);
        }
        if existing.state == ReservationState::Finalized {
            return Err(NativeError::new(
                "approval_dispatch_finalized",
                "The dispatch reservation already has a terminal outcome",
            ));
        }
        if existing.state == ReservationState::ReleasedBeforeDispatch {
            return Err(NativeError::new(
                "approval_reservation_released",
                "The approval reservation was released before dispatch",
            ));
        }
        if now >= receipt.expires_at_ms {
            return Err(NativeError::new(
                "approval_expired",
                "The approval receipt expired before dispatch",
            ));
        }
        if receipt.decision == ApprovalChoice::Deny {
            return Err(NativeError::new(
                "approval_denied",
                "The exact operation was denied by the user",
            ));
        }

        let next_dispatches_started = {
            let usage = state.receipt_usage.get(&receipt.id).ok_or_else(|| {
                NativeError::new(
                    "approval_integrity_failed",
                    "The approval receipt usage ledger is missing",
                )
            })?;
            if !usage.active_reservation_ids.contains(&existing.id) {
                return Err(NativeError::new(
                    "approval_integrity_failed",
                    "The dispatch reservation was not active",
                ));
            }
            usage.dispatches_started.checked_add(1).ok_or_else(|| {
                NativeError::new(
                    "approval_limit_reached",
                    "The approval dispatch count is out of range",
                )
            })?
        };

        let permit_id = native_id("approval_permit");
        let audit = append_audit_event(
            &mut state,
            NewAuditEvent {
                occurred_at_ms: now,
                actor_kind: "policy",
                actor_id: "policy:approval-broker",
                action: ApprovalAuditAction::DispatchStarted,
                outcome: ApprovalAuditOutcome::Allowed,
                binding: &receipt.binding,
                capability_request_id: &receipt.capability_request_id,
                approval_request_id: &receipt.approval_request_id,
                approval_receipt_id: Some(&receipt.id),
                reservation_id: Some(&existing.id),
                invocation_idempotency_key: Some(&existing.invocation_idempotency_key),
            },
        )?;
        let mut dispatched = existing;
        dispatched.state = ReservationState::DispatchStarted;
        dispatched.dispatch_permit_id = Some(permit_id.clone());
        dispatched.dispatch_started_at_ms = Some(now);
        dispatched.dispatch_audit_event_id = Some(audit.id.clone());
        dispatched.dispatch_audit_event_sha256 = Some(audit.event_sha256.clone());
        let usage = state
            .receipt_usage
            .get_mut(&receipt.id)
            .expect("validated receipt usage ledger");
        let removed = usage.active_reservation_ids.remove(&dispatched.id);
        debug_assert!(removed, "validated reservation must remain active");
        usage.dispatches_started = next_dispatches_started;
        state
            .reservations
            .insert(dispatched.id.clone(), dispatched.clone());
        Ok(ExactDispatchPermit {
            schema_version: EXACT_APPROVAL_SCHEMA_VERSION,
            id: permit_id,
            reservation_id: dispatched.id,
            approval_receipt_id: receipt.id,
            scope_sha256: receipt.binding.scope_sha256,
            operation_arguments_sha256: receipt.binding.operation_arguments_sha256,
            issued_at_ms: now,
            pre_dispatch_audit_event_id: audit.id,
            pre_dispatch_audit_event_sha256: audit.event_sha256,
        })
    }

    pub(crate) fn finalize_dispatch(
        &self,
        input: FinalizeDispatchInput,
    ) -> NativeResult<ApprovalReservation> {
        let reason_code = validate_reason_code(&input.reason_code)?;
        let verification_sha256 = input
            .verification_sha256
            .as_deref()
            .map(|value| validate_sha256("verificationSha256", value))
            .transpose()?;
        let now = self.clock.now_ms()?;
        let mut state = self.lock_state()?;
        let existing = state
            .reservations
            .get(&input.reservation_id)
            .cloned()
            .ok_or_else(|| {
                NativeError::new(
                    "approval_reservation_not_found",
                    "The approval reservation does not exist",
                )
            })?;
        if existing.state == ReservationState::Finalized {
            let finalization = existing.finalization.as_ref().ok_or_else(|| {
                NativeError::new(
                    "approval_integrity_failed",
                    "The finalized reservation has no terminal fact",
                )
            })?;
            if finalization.outcome == input.outcome
                && finalization.reason_code == reason_code
                && finalization.verification_sha256 == verification_sha256
            {
                return Ok(existing);
            }
            return Err(NativeError::new(
                "approval_finalization_conflict",
                "The dispatch already has a different terminal outcome",
            ));
        }
        if existing.state != ReservationState::DispatchStarted {
            return Err(NativeError::new(
                "approval_dispatch_not_started",
                "A dispatch cannot be finalized before it starts",
            ));
        }
        if input.outcome == DispatchOutcome::Succeeded && verification_sha256.is_none() {
            return Err(NativeError::invalid(
                "verificationSha256",
                "is required for a verified successful effect",
            ));
        }
        let receipt = state
            .receipts
            .get(&existing.approval_receipt_id)
            .cloned()
            .ok_or_else(|| {
                NativeError::new(
                    "approval_integrity_failed",
                    "The approval reservation has no receipt",
                )
            })?;
        let audit_outcome = match input.outcome {
            DispatchOutcome::Succeeded => ApprovalAuditOutcome::Succeeded,
            DispatchOutcome::Failed => ApprovalAuditOutcome::Failed,
            DispatchOutcome::Cancelled => ApprovalAuditOutcome::Cancelled,
            DispatchOutcome::OutcomeUnknown => ApprovalAuditOutcome::OutcomeUnknown,
        };
        let audit = append_audit_event(
            &mut state,
            NewAuditEvent {
                occurred_at_ms: now,
                actor_kind: "harness",
                actor_id: &receipt.binding.agent_id,
                action: ApprovalAuditAction::DispatchFinalized,
                outcome: audit_outcome,
                binding: &receipt.binding,
                capability_request_id: &receipt.capability_request_id,
                approval_request_id: &receipt.approval_request_id,
                approval_receipt_id: Some(&receipt.id),
                reservation_id: Some(&existing.id),
                invocation_idempotency_key: Some(&existing.invocation_idempotency_key),
            },
        )?;
        let mut finalized = existing;
        finalized.state = ReservationState::Finalized;
        finalized.finalization = Some(ApprovalDispatchFinalization {
            outcome: input.outcome,
            reason_code,
            verification_sha256,
            finalized_at_ms: now,
            audit_event_id: audit.id.clone(),
            audit_event_sha256: audit.event_sha256.clone(),
        });
        state
            .reservations
            .insert(finalized.id.clone(), finalized.clone());
        Ok(finalized)
    }

    pub(crate) fn audit_events(&self) -> NativeResult<Vec<ApprovalAuditEvent>> {
        let state = self.lock_state()?;
        verify_audit_chain(&state.audit_events)?;
        Ok(state.audit_events.clone())
    }
}

impl ExactOperationBinding {
    pub(crate) fn freeze(input: &ExactOperationInput) -> NativeResult<Self> {
        let profile_id = validate_native_id("profileId", &input.profile_id, "profile_")?;
        let authenticated_client_session_id = validate_native_id(
            "authenticatedClientSessionId",
            &input.authenticated_client_session_id,
            "client_session_",
        )?;
        if input.authenticated_client_session_epoch == 0 {
            return Err(NativeError::invalid(
                "authenticatedClientSessionEpoch",
                "must be a positive native epoch",
            ));
        }
        let run_id = validate_native_id("runId", &input.run_id, "run_")?;
        let attempt_id = validate_native_id("attemptId", &input.attempt_id, "attempt_")?;
        let iteration_id = validate_native_id("iterationId", &input.iteration_id, "iteration_")?;
        let tool_call_id = validate_native_id("toolCallId", &input.tool_call_id, "run_item_")?;
        let agent_id = validate_native_id("agentId", &input.agent_id, "agent_")?;
        let environment_id =
            validate_native_id("environmentId", &input.environment_id, "environment_")?;
        if input.environment_revision == 0 {
            return Err(NativeError::invalid(
                "environmentRevision",
                "must be a positive revision",
            ));
        }
        let subject_id = validate_identifier("subjectId", &input.subject_id, 256)?;
        let subject_content_sha256 = input
            .subject_content_sha256
            .as_deref()
            .map(|value| validate_sha256("subjectContentSha256", value))
            .transpose()?;
        if input.subject_type.requires_content_hash() && subject_content_sha256.is_none() {
            return Err(NativeError::invalid(
                "subjectContentSha256",
                "is required for a versioned subject",
            ));
        }
        let operation_type = validate_operation_type(&input.operation_type)?;
        let operation_arguments_sha256 = canonical_json_sha256(&input.arguments)?;
        let environment_config_sha256 =
            validate_sha256("environmentConfigSha256", &input.environment_config_sha256)?;
        let tool_version_sha256 = validate_sha256("toolVersionSha256", &input.tool_version_sha256)?;
        let capability_manifest_sha256 = validate_sha256(
            "capabilityManifestSha256",
            &input.capability_manifest_sha256,
        )?;
        let capability_set_sha256 =
            validate_sha256("capabilitySetSha256", &input.capability_set_sha256)?;
        let policy_version_sha256 =
            validate_sha256("policyVersionSha256", &input.policy_version_sha256)?;
        let context_snapshot_sha256 =
            validate_sha256("contextSnapshotSha256", &input.context_snapshot_sha256)?;
        let network_policy_sha256 =
            validate_sha256("networkPolicySha256", &input.network_policy_sha256)?;
        let executable_sha256 = input
            .executable_sha256
            .as_deref()
            .map(|value| validate_sha256("executableSha256", value))
            .transpose()?;
        let workspace_grant_revision_sha256s = sorted_unique(
            "workspaceGrantRevisionSha256s",
            &input.workspace_grant_revision_sha256s,
            |value| validate_sha256("workspaceGrantRevisionSha256", value),
        )?;
        let resource_handles =
            sorted_unique("resourceHandles", &input.resource_handles, |value| {
                validate_opaque_handle("resourceHandle", value)
            })?;
        let destinations = sorted_unique("destinations", &input.destinations, |value| {
            canonical_destination(value)
        })?;
        let data_classes = sorted_unique("dataClasses", &input.data_classes, |value| {
            validate_data_class(value)
        })?;
        if input.capability == KernelCapability::PureCompute
            && (!resource_handles.is_empty()
                || !destinations.is_empty()
                || executable_sha256.is_some()
                || !workspace_grant_revision_sha256s.is_empty()
                || input.requires_elevation)
        {
            return Err(NativeError::new(
                "approval_scope_invalid",
                "Pure compute cannot carry resource, network, executable, or elevation authority",
            ));
        }
        if input.requires_elevation && input.capability != KernelCapability::RequestAdmin {
            return Err(NativeError::new(
                "approval_scope_invalid",
                "Elevation requires the explicit request_admin capability",
            ));
        }
        if input.capability == KernelCapability::UseNetwork && destinations.is_empty() {
            return Err(NativeError::new(
                "approval_scope_invalid",
                "Network authority requires at least one exact destination",
            ));
        }
        if !destinations.is_empty()
            && !matches!(
                input.capability,
                KernelCapability::UseNetwork
                    | KernelCapability::ExternalSideEffect
                    | KernelCapability::ControlBrowser
                    | KernelCapability::AccessSecretHandle
            )
        {
            return Err(NativeError::new(
                "approval_scope_invalid",
                "The selected capability cannot carry network destinations",
            ));
        }
        if input.capability == KernelCapability::ExecuteProcess && executable_sha256.is_none() {
            return Err(NativeError::new(
                "approval_scope_invalid",
                "Process execution requires an exact executable hash",
            ));
        }

        let mut binding = Self {
            schema_version: EXACT_APPROVAL_SCHEMA_VERSION,
            profile_id,
            authenticated_client_session_id,
            authenticated_client_session_epoch: input.authenticated_client_session_epoch,
            run_id,
            attempt_id,
            iteration_id,
            tool_call_id,
            agent_id,
            environment_id,
            environment_revision: input.environment_revision,
            environment_config_sha256,
            subject_type: input.subject_type,
            subject_id,
            subject_content_sha256,
            capability: input.capability,
            operation_type,
            operation_arguments_sha256,
            tool_version_sha256,
            capability_manifest_sha256,
            capability_set_sha256,
            policy_version_sha256,
            context_snapshot_sha256,
            network_policy_sha256,
            executable_sha256,
            workspace_grant_revision_sha256s,
            resource_handles,
            destinations,
            data_classes,
            requires_elevation: input.requires_elevation,
            scope_sha256: String::new(),
        };
        binding.scope_sha256 = hash_binding_material(&binding)?;
        Ok(binding)
    }
}

impl ApprovalPresentation {
    fn freeze(
        input: TrustedApprovalPresentationInput,
        binding: &ExactOperationBinding,
    ) -> NativeResult<Self> {
        let title = validate_presentation_text("title", &input.title, false)?;
        let summary = validate_presentation_text("summary", &input.summary, false)?;
        let target_labels = validate_presentation_list("targetLabels", &input.target_labels)?;
        let consequences = validate_presentation_list("consequences", &input.consequences)?;
        let rollback = input
            .rollback
            .as_deref()
            .map(|value| validate_presentation_text("rollback", value, false))
            .transpose()?;
        let mut presentation = Self {
            title,
            summary,
            target_labels,
            consequences,
            rollback,
            operation_type: binding.operation_type.clone(),
            capability: binding.capability,
            resource_handles: binding.resource_handles.clone(),
            destinations: binding.destinations.clone(),
            data_classes: binding.data_classes.clone(),
            requires_elevation: binding.requires_elevation,
            operation_arguments_sha256: binding.operation_arguments_sha256.clone(),
            presentation_sha256: String::new(),
        };
        presentation.presentation_sha256 = hash_presentation_material(&presentation)?;
        Ok(presentation)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BindingHashMaterial<'a> {
    schema_version: u32,
    profile_id: &'a str,
    authenticated_client_session_id: &'a str,
    authenticated_client_session_epoch: u64,
    run_id: &'a str,
    attempt_id: &'a str,
    iteration_id: &'a str,
    tool_call_id: &'a str,
    agent_id: &'a str,
    environment_id: &'a str,
    environment_revision: u64,
    environment_config_sha256: &'a str,
    subject_type: CapabilitySubjectType,
    subject_id: &'a str,
    subject_content_sha256: Option<&'a str>,
    capability: KernelCapability,
    operation_type: &'a str,
    operation_arguments_sha256: &'a str,
    tool_version_sha256: &'a str,
    capability_manifest_sha256: &'a str,
    capability_set_sha256: &'a str,
    policy_version_sha256: &'a str,
    context_snapshot_sha256: &'a str,
    network_policy_sha256: &'a str,
    executable_sha256: Option<&'a str>,
    workspace_grant_revision_sha256s: &'a [String],
    resource_handles: &'a [String],
    destinations: &'a [String],
    data_classes: &'a [String],
    requires_elevation: bool,
}

impl<'a> From<&'a ExactOperationBinding> for BindingHashMaterial<'a> {
    fn from(binding: &'a ExactOperationBinding) -> Self {
        Self {
            schema_version: binding.schema_version,
            profile_id: &binding.profile_id,
            authenticated_client_session_id: &binding.authenticated_client_session_id,
            authenticated_client_session_epoch: binding.authenticated_client_session_epoch,
            run_id: &binding.run_id,
            attempt_id: &binding.attempt_id,
            iteration_id: &binding.iteration_id,
            tool_call_id: &binding.tool_call_id,
            agent_id: &binding.agent_id,
            environment_id: &binding.environment_id,
            environment_revision: binding.environment_revision,
            environment_config_sha256: &binding.environment_config_sha256,
            subject_type: binding.subject_type,
            subject_id: &binding.subject_id,
            subject_content_sha256: binding.subject_content_sha256.as_deref(),
            capability: binding.capability,
            operation_type: &binding.operation_type,
            operation_arguments_sha256: &binding.operation_arguments_sha256,
            tool_version_sha256: &binding.tool_version_sha256,
            capability_manifest_sha256: &binding.capability_manifest_sha256,
            capability_set_sha256: &binding.capability_set_sha256,
            policy_version_sha256: &binding.policy_version_sha256,
            context_snapshot_sha256: &binding.context_snapshot_sha256,
            network_policy_sha256: &binding.network_policy_sha256,
            executable_sha256: binding.executable_sha256.as_deref(),
            workspace_grant_revision_sha256s: &binding.workspace_grant_revision_sha256s,
            resource_handles: &binding.resource_handles,
            destinations: &binding.destinations,
            data_classes: &binding.data_classes,
            requires_elevation: binding.requires_elevation,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PresentationHashMaterial<'a> {
    title: &'a str,
    summary: &'a str,
    target_labels: &'a [String],
    consequences: &'a [String],
    rollback: Option<&'a str>,
    operation_type: &'a str,
    capability: KernelCapability,
    resource_handles: &'a [String],
    destinations: &'a [String],
    data_classes: &'a [String],
    requires_elevation: bool,
    operation_arguments_sha256: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestHashMaterial<'a> {
    schema_version: u32,
    id: &'a str,
    capability_request_id: &'a str,
    proposal_idempotency_key: &'a str,
    nonce: &'a str,
    scope_sha256: &'a str,
    presentation_sha256: &'a str,
    choices: &'a [ApprovalChoice],
    allow_run_max_dispatches: Option<u32>,
    requested_ttl_ms: i64,
    created_at_ms: i64,
    expires_at_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReceiptHashMaterial<'a> {
    schema_version: u32,
    id: &'a str,
    approval_request_id: &'a str,
    capability_request_id: &'a str,
    request_sha256: &'a str,
    request_nonce: &'a str,
    scope_sha256: &'a str,
    presentation_sha256: &'a str,
    decision: ApprovalChoice,
    decision_actor_handle: &'a str,
    decided_at_ms: i64,
    expires_at_ms: i64,
    maximum_dispatches: u32,
    decision_audit_event_id: &'a str,
    decision_audit_event_sha256: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditHashMaterial<'a> {
    schema_version: u32,
    id: &'a str,
    sequence_no: u64,
    previous_event_sha256: Option<&'a str>,
    occurred_at_ms: i64,
    actor_kind: &'a str,
    actor_id: &'a str,
    action: ApprovalAuditAction,
    outcome: ApprovalAuditOutcome,
    profile_id: &'a str,
    capability_request_id: &'a str,
    approval_request_id: &'a str,
    approval_receipt_id: Option<&'a str>,
    reservation_id: Option<&'a str>,
    invocation_idempotency_key: Option<&'a str>,
    scope_sha256: &'a str,
    operation_arguments_sha256: &'a str,
}

struct NewAuditEvent<'a> {
    occurred_at_ms: i64,
    actor_kind: &'a str,
    actor_id: &'a str,
    action: ApprovalAuditAction,
    outcome: ApprovalAuditOutcome,
    binding: &'a ExactOperationBinding,
    capability_request_id: &'a str,
    approval_request_id: &'a str,
    approval_receipt_id: Option<&'a str>,
    reservation_id: Option<&'a str>,
    invocation_idempotency_key: Option<&'a str>,
}

fn hash_binding_material(binding: &ExactOperationBinding) -> NativeResult<String> {
    sha256_json(&BindingHashMaterial::from(binding), "approval scope")
}

fn hash_presentation_material(presentation: &ApprovalPresentation) -> NativeResult<String> {
    sha256_json(
        &PresentationHashMaterial {
            title: &presentation.title,
            summary: &presentation.summary,
            target_labels: &presentation.target_labels,
            consequences: &presentation.consequences,
            rollback: presentation.rollback.as_deref(),
            operation_type: &presentation.operation_type,
            capability: presentation.capability,
            resource_handles: &presentation.resource_handles,
            destinations: &presentation.destinations,
            data_classes: &presentation.data_classes,
            requires_elevation: presentation.requires_elevation,
            operation_arguments_sha256: &presentation.operation_arguments_sha256,
        },
        "approval presentation",
    )
}

fn hash_request_material(material: &RequestHashMaterial<'_>) -> NativeResult<String> {
    sha256_json(material, "approval request")
}

fn hash_receipt_material(receipt: &ExactApprovalReceipt) -> NativeResult<String> {
    sha256_json(
        &ReceiptHashMaterial {
            schema_version: receipt.schema_version,
            id: &receipt.id,
            approval_request_id: &receipt.approval_request_id,
            capability_request_id: &receipt.capability_request_id,
            request_sha256: &receipt.request_sha256,
            request_nonce: &receipt.request_nonce,
            scope_sha256: &receipt.binding.scope_sha256,
            presentation_sha256: &receipt.presentation_sha256,
            decision: receipt.decision,
            decision_actor_handle: &receipt.decision_actor_handle,
            decided_at_ms: receipt.decided_at_ms,
            expires_at_ms: receipt.expires_at_ms,
            maximum_dispatches: receipt.maximum_dispatches,
            decision_audit_event_id: &receipt.decision_audit_event_id,
            decision_audit_event_sha256: &receipt.decision_audit_event_sha256,
        },
        "approval receipt",
    )
}

fn append_audit_event(
    state: &mut BrokerState,
    input: NewAuditEvent<'_>,
) -> NativeResult<ApprovalAuditEvent> {
    let previous = state.audit_events.last();
    if let Some(previous) = previous {
        if input.occurred_at_ms < previous.occurred_at_ms {
            return Err(NativeError::new(
                "approval_audit_time_conflict",
                "Approval audit time cannot move backwards",
            ));
        }
    }
    let sequence_no = u64::try_from(state.audit_events.len())
        .ok()
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| {
            NativeError::new(
                "approval_audit_limit_reached",
                "Approval audit sequence is out of range",
            )
        })?;
    let id = native_id("approval_audit");
    let previous_event_sha256 = previous.map(|event| event.event_sha256.clone());
    let actor_kind = validate_actor_kind(input.actor_kind)?;
    let actor_id = validate_actor_handle("actorId", input.actor_id, &actor_kind)?;
    let event_sha256 = sha256_json(
        &AuditHashMaterial {
            schema_version: EXACT_APPROVAL_SCHEMA_VERSION,
            id: &id,
            sequence_no,
            previous_event_sha256: previous_event_sha256.as_deref(),
            occurred_at_ms: input.occurred_at_ms,
            actor_kind: &actor_kind,
            actor_id: &actor_id,
            action: input.action,
            outcome: input.outcome,
            profile_id: &input.binding.profile_id,
            capability_request_id: input.capability_request_id,
            approval_request_id: input.approval_request_id,
            approval_receipt_id: input.approval_receipt_id,
            reservation_id: input.reservation_id,
            invocation_idempotency_key: input.invocation_idempotency_key,
            scope_sha256: &input.binding.scope_sha256,
            operation_arguments_sha256: &input.binding.operation_arguments_sha256,
        },
        "approval audit event",
    )?;
    let event = ApprovalAuditEvent {
        schema_version: EXACT_APPROVAL_SCHEMA_VERSION,
        id,
        sequence_no,
        previous_event_sha256,
        occurred_at_ms: input.occurred_at_ms,
        actor_kind,
        actor_id,
        action: input.action,
        outcome: input.outcome,
        profile_id: input.binding.profile_id.clone(),
        capability_request_id: input.capability_request_id.to_owned(),
        approval_request_id: input.approval_request_id.to_owned(),
        approval_receipt_id: input.approval_receipt_id.map(str::to_owned),
        reservation_id: input.reservation_id.map(str::to_owned),
        invocation_idempotency_key: input.invocation_idempotency_key.map(str::to_owned),
        scope_sha256: input.binding.scope_sha256.clone(),
        operation_arguments_sha256: input.binding.operation_arguments_sha256.clone(),
        event_sha256,
    };
    state.audit_events.push(event.clone());
    Ok(event)
}

fn verify_request_integrity(
    request: &ExactApprovalRequest,
    audit_events: &[ApprovalAuditEvent],
) -> NativeResult<()> {
    if request.schema_version != EXACT_APPROVAL_SCHEMA_VERSION
        || hash_binding_material(&request.binding)? != request.binding.scope_sha256
        || hash_presentation_material(&request.presentation)?
            != request.presentation.presentation_sha256
        || request.presentation.operation_type != request.binding.operation_type
        || request.presentation.capability != request.binding.capability
        || request.presentation.resource_handles != request.binding.resource_handles
        || request.presentation.destinations != request.binding.destinations
        || request.presentation.data_classes != request.binding.data_classes
        || request.presentation.requires_elevation != request.binding.requires_elevation
        || request.presentation.operation_arguments_sha256
            != request.binding.operation_arguments_sha256
        || request.request_sha256
            != hash_request_material(&RequestHashMaterial {
                schema_version: request.schema_version,
                id: &request.id,
                capability_request_id: &request.capability_request_id,
                proposal_idempotency_key: &request.proposal_idempotency_key,
                nonce: &request.nonce,
                scope_sha256: &request.binding.scope_sha256,
                presentation_sha256: &request.presentation.presentation_sha256,
                choices: &request.choices,
                allow_run_max_dispatches: request.allow_run_max_dispatches,
                requested_ttl_ms: request.requested_ttl_ms,
                created_at_ms: request.created_at_ms,
                expires_at_ms: request.expires_at_ms,
            })?
    {
        return Err(NativeError::new(
            "approval_integrity_failed",
            "The approval request integrity check failed",
        ));
    }
    let audit = audit_events
        .iter()
        .find(|event| event.id == request.created_audit_event_id)
        .ok_or_else(|| {
            NativeError::new(
                "approval_integrity_failed",
                "The approval request creation audit event is missing",
            )
        })?;
    if audit.event_sha256 != request.created_audit_event_sha256
        || audit.action != ApprovalAuditAction::RequestCreated
        || audit.outcome != ApprovalAuditOutcome::Proposed
        || audit.actor_kind != "harness"
        || audit.actor_id != request.binding.agent_id
        || audit.profile_id != request.binding.profile_id
        || audit.capability_request_id != request.capability_request_id
        || audit.approval_request_id != request.id
        || audit.approval_receipt_id.is_some()
        || audit.reservation_id.is_some()
        || audit.invocation_idempotency_key.is_some()
        || audit.scope_sha256 != request.binding.scope_sha256
        || audit.operation_arguments_sha256 != request.binding.operation_arguments_sha256
    {
        return Err(NativeError::new(
            "approval_integrity_failed",
            "The approval request creation audit linkage is invalid",
        ));
    }
    Ok(())
}

fn verify_receipt_integrity(
    receipt: &ExactApprovalReceipt,
    request: &ExactApprovalRequest,
    audit_events: &[ApprovalAuditEvent],
) -> NativeResult<()> {
    if receipt.schema_version != EXACT_APPROVAL_SCHEMA_VERSION
        || receipt.approval_request_id != request.id
        || receipt.capability_request_id != request.capability_request_id
        || receipt.request_sha256 != request.request_sha256
        || receipt.request_nonce != request.nonce
        || receipt.binding != request.binding
        || receipt.presentation_sha256 != request.presentation.presentation_sha256
        || receipt.expires_at_ms != request.expires_at_ms
        || receipt.receipt_sha256 != hash_receipt_material(receipt)?
    {
        return Err(NativeError::new(
            "approval_integrity_failed",
            "The approval receipt integrity check failed",
        ));
    }
    let audit = audit_events
        .iter()
        .find(|event| event.id == receipt.decision_audit_event_id)
        .ok_or_else(|| {
            NativeError::new(
                "approval_integrity_failed",
                "The approval decision audit event is missing",
            )
        })?;
    let expected_outcome = match receipt.decision {
        ApprovalChoice::AllowOnce | ApprovalChoice::AllowRun => ApprovalAuditOutcome::Allowed,
        ApprovalChoice::Deny => ApprovalAuditOutcome::Denied,
    };
    if audit.event_sha256 != receipt.decision_audit_event_sha256
        || audit.action != ApprovalAuditAction::DecisionRecorded
        || audit.outcome != expected_outcome
        || audit.actor_kind != "user"
        || audit.actor_id != receipt.decision_actor_handle
        || audit.profile_id != receipt.binding.profile_id
        || audit.capability_request_id != receipt.capability_request_id
        || audit.approval_request_id != receipt.approval_request_id
        || audit.approval_receipt_id.as_deref() != Some(receipt.id.as_str())
        || audit.reservation_id.is_some()
        || audit.invocation_idempotency_key.is_some()
        || audit.scope_sha256 != receipt.binding.scope_sha256
        || audit.operation_arguments_sha256 != receipt.binding.operation_arguments_sha256
    {
        return Err(NativeError::new(
            "approval_integrity_failed",
            "The approval decision audit linkage is invalid",
        ));
    }
    Ok(())
}

fn verify_audit_chain(events: &[ApprovalAuditEvent]) -> NativeResult<()> {
    let mut previous_hash: Option<&str> = None;
    let mut previous_time = 0i64;
    for (index, event) in events.iter().enumerate() {
        let expected_sequence = u64::try_from(index)
            .ok()
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| {
                NativeError::new(
                    "approval_integrity_failed",
                    "The approval audit sequence is out of range",
                )
            })?;
        let rebuilt = sha256_json(
            &AuditHashMaterial {
                schema_version: event.schema_version,
                id: &event.id,
                sequence_no: event.sequence_no,
                previous_event_sha256: event.previous_event_sha256.as_deref(),
                occurred_at_ms: event.occurred_at_ms,
                actor_kind: &event.actor_kind,
                actor_id: &event.actor_id,
                action: event.action,
                outcome: event.outcome,
                profile_id: &event.profile_id,
                capability_request_id: &event.capability_request_id,
                approval_request_id: &event.approval_request_id,
                approval_receipt_id: event.approval_receipt_id.as_deref(),
                reservation_id: event.reservation_id.as_deref(),
                invocation_idempotency_key: event.invocation_idempotency_key.as_deref(),
                scope_sha256: &event.scope_sha256,
                operation_arguments_sha256: &event.operation_arguments_sha256,
            },
            "approval audit event",
        )?;
        if event.schema_version != EXACT_APPROVAL_SCHEMA_VERSION
            || event.sequence_no != expected_sequence
            || event.previous_event_sha256.as_deref() != previous_hash
            || event.occurred_at_ms < previous_time
            || event.event_sha256 != rebuilt
        {
            return Err(NativeError::new(
                "approval_integrity_failed",
                "The approval audit chain integrity check failed",
            ));
        }
        previous_hash = Some(&event.event_sha256);
        previous_time = event.occurred_at_ms;
    }
    Ok(())
}

fn assert_exact_binding(
    expected: &ExactOperationBinding,
    current: &ExactOperationBinding,
) -> NativeResult<()> {
    if expected != current {
        return Err(NativeError::new(
            "approval_scope_mismatch",
            "The operation, session, tool, environment, policy, context, or target changed after approval",
        ));
    }
    Ok(())
}

fn permit_from_reservation(reservation: &ApprovalReservation) -> NativeResult<ExactDispatchPermit> {
    let permit_id = reservation.dispatch_permit_id.clone().ok_or_else(|| {
        NativeError::new(
            "approval_integrity_failed",
            "The dispatched reservation has no permit ID",
        )
    })?;
    let issued_at_ms = reservation.dispatch_started_at_ms.ok_or_else(|| {
        NativeError::new(
            "approval_integrity_failed",
            "The dispatched reservation has no start time",
        )
    })?;
    let audit_event_id = reservation.dispatch_audit_event_id.clone().ok_or_else(|| {
        NativeError::new(
            "approval_integrity_failed",
            "The dispatched reservation has no audit event",
        )
    })?;
    let audit_event_sha256 = reservation
        .dispatch_audit_event_sha256
        .clone()
        .ok_or_else(|| {
            NativeError::new(
                "approval_integrity_failed",
                "The dispatched reservation has no audit hash",
            )
        })?;
    Ok(ExactDispatchPermit {
        schema_version: EXACT_APPROVAL_SCHEMA_VERSION,
        id: permit_id,
        reservation_id: reservation.id.clone(),
        approval_receipt_id: reservation.approval_receipt_id.clone(),
        scope_sha256: reservation.scope_sha256.clone(),
        operation_arguments_sha256: reservation.operation_arguments_sha256.clone(),
        issued_at_ms,
        pre_dispatch_audit_event_id: audit_event_id,
        pre_dispatch_audit_event_sha256: audit_event_sha256,
    })
}

fn validate_approval_choices(
    choices: &[ApprovalChoice],
    allow_run_max_dispatches: Option<u32>,
    binding: &ExactOperationBinding,
) -> NativeResult<(Vec<ApprovalChoice>, Option<u32>)> {
    if choices.is_empty()
        || choices.len() > 3
        || !choices.contains(&ApprovalChoice::Deny)
        || choices.iter().copied().collect::<HashSet<_>>().len() != choices.len()
    {
        return Err(NativeError::invalid(
            "choices",
            "must be unique, recognized, and include deny",
        ));
    }
    if choices.contains(&ApprovalChoice::AllowRun) {
        if binding.capability.requires_single_dispatch() || binding.requires_elevation {
            return Err(NativeError::new(
                "approval_choice_not_allowed",
                "This high-risk operation requires per-dispatch approval",
            ));
        }
        let maximum = allow_run_max_dispatches.ok_or_else(|| {
            NativeError::invalid(
                "allowRunMaxDispatches",
                "is required when allow-run is offered",
            )
        })?;
        if !(2..=MAX_ALLOW_RUN_DISPATCHES).contains(&maximum) {
            return Err(NativeError::invalid(
                "allowRunMaxDispatches",
                "must be between 2 and 128",
            ));
        }
    } else if allow_run_max_dispatches.is_some() {
        return Err(NativeError::invalid(
            "allowRunMaxDispatches",
            "must be omitted when allow-run is unavailable",
        ));
    }
    Ok((choices.to_vec(), allow_run_max_dispatches))
}

fn canonical_json_sha256(value: &Value) -> NativeResult<String> {
    let mut node_count = 0usize;
    let canonical = canonicalize_json(value, 0, &mut node_count)?;
    let bytes = serde_json::to_vec(&canonical).map_err(|_| {
        NativeError::new(
            "approval_canonicalization_failed",
            "The operation arguments could not be canonicalized",
        )
    })?;
    if bytes.len() > MAX_CANONICAL_ARGUMENT_BYTES {
        return Err(NativeError::invalid(
            "arguments",
            "exceed the canonical operation safety limit",
        ));
    }
    Ok(sha256_bytes(&bytes))
}

fn canonicalize_json(value: &Value, depth: usize, node_count: &mut usize) -> NativeResult<Value> {
    if depth > MAX_CANONICAL_ARGUMENT_DEPTH {
        return Err(NativeError::invalid(
            "arguments",
            "exceed the maximum nesting depth",
        ));
    }
    *node_count = node_count
        .checked_add(1)
        .ok_or_else(|| NativeError::invalid("arguments", "contain too many canonical values"))?;
    if *node_count > MAX_CANONICAL_ARGUMENT_NODES {
        return Err(NativeError::invalid(
            "arguments",
            "contain too many canonical values",
        ));
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Ok(value.clone()),
        Value::Array(values) => values
            .iter()
            .map(|entry| canonicalize_json(entry, depth + 1, node_count))
            .collect::<NativeResult<Vec<_>>>()
            .map(Value::Array),
        Value::Object(values) => {
            let mut canonical = BTreeMap::new();
            for (key, entry) in values {
                validate_json_key(key)?;
                canonical.insert(
                    key.clone(),
                    canonicalize_json(entry, depth + 1, node_count)?,
                );
            }
            Ok(Value::Object(canonical.into_iter().collect()))
        }
    }
}

fn validate_json_key(value: &str) -> NativeResult<()> {
    if value.is_empty()
        || value.len() > 256
        || value.contains('\0')
        || value.chars().any(char::is_control)
    {
        return Err(NativeError::invalid(
            "arguments",
            "contain an invalid object key",
        ));
    }
    Ok(())
}

fn sorted_unique<F>(
    label: &'static str,
    values: &[String],
    mut normalize: F,
) -> NativeResult<Vec<String>>
where
    F: FnMut(&str) -> NativeResult<String>,
{
    if values.len() > MAX_COLLECTION_ITEMS {
        return Err(NativeError::invalid(label, "contain too many values"));
    }
    let mut normalized = values
        .iter()
        .map(|value| normalize(value))
        .collect::<NativeResult<Vec<_>>>()?;
    normalized.sort_unstable();
    if normalized.windows(2).any(|window| window[0] == window[1]) {
        return Err(NativeError::invalid(label, "must contain unique values"));
    }
    Ok(normalized)
}

fn validate_native_id(label: &'static str, value: &str, prefix: &str) -> NativeResult<String> {
    let normalized = value.trim();
    let suffix = normalized.strip_prefix(prefix).unwrap_or_default();
    if normalized.len() > MAX_ID_BYTES
        || suffix.len() != 32
        || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(NativeError::invalid(
            label,
            "must be an opaque native identifier",
        ));
    }
    Ok(normalized.to_owned())
}

fn validate_identifier(label: &'static str, value: &str, max_bytes: usize) -> NativeResult<String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.len() > max_bytes
        || normalized.contains('\0')
        || normalized.chars().any(char::is_control)
    {
        return Err(NativeError::invalid(label, "is malformed or oversized"));
    }
    Ok(normalized.to_owned())
}

fn validate_operation_type(value: &str) -> NativeResult<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() > 160
        || !normalized.split('.').all(|segment| {
            !segment.is_empty()
                && segment.len() <= 64
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        })
    {
        return Err(NativeError::invalid(
            "operationType",
            "must be a canonical dotted operation identifier",
        ));
    }
    Ok(normalized)
}

fn validate_opaque_handle(label: &'static str, value: &str) -> NativeResult<String> {
    let normalized = value.trim();
    let Some((kind, opaque_id)) = normalized.split_once(':') else {
        return Err(NativeError::invalid(
            label,
            "must be an opaque native handle",
        ));
    };
    let valid_kind = (2..=64).contains(&kind.len())
        && kind.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' => true,
            b'0'..=b'9' | b'.' | b'_' | b'-' => index > 0,
            _ => false,
        });
    let valid_id = !opaque_id.is_empty()
        && opaque_id.len() <= 256
        && opaque_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-'));
    if !valid_kind
        || !valid_id
        || normalized.contains('/')
        || normalized.contains('\\')
        || normalized.contains('\0')
    {
        return Err(NativeError::invalid(
            label,
            "must be an opaque native handle, not a path or URL",
        ));
    }
    Ok(normalized.to_owned())
}

fn canonical_destination(value: &str) -> NativeResult<String> {
    let url = Url::parse(value.trim())
        .map_err(|_| NativeError::invalid("destination", "must be an absolute URL origin"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(NativeError::invalid(
            "destination",
            "must be an explicit HTTP(S) origin without credentials, path, query, or fragment",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| NativeError::invalid("destination", "must include a hostname"))?
        .to_ascii_lowercase();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| NativeError::invalid("destination", "must use a known explicit port"))?;
    Ok(format!(
        "{}://{}:{port}",
        url.scheme(),
        canonical_host(&host)
    ))
}

fn canonical_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    }
}

fn validate_data_class(value: &str) -> NativeResult<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.len() > 96
        || !normalized.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-' | b'.')
        })
    {
        return Err(NativeError::invalid("dataClass", "is malformed"));
    }
    Ok(normalized)
}

fn validate_presentation_text(
    label: &'static str,
    value: &str,
    allow_empty: bool,
) -> NativeResult<String> {
    let normalized = value.trim();
    if (!allow_empty && normalized.is_empty())
        || normalized.len() > MAX_PRESENTATION_TEXT_BYTES
        || normalized.contains('\0')
        || normalized
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(NativeError::invalid(label, "is malformed or oversized"));
    }
    Ok(normalized.to_owned())
}

fn validate_presentation_list(label: &'static str, values: &[String]) -> NativeResult<Vec<String>> {
    if values.len() > MAX_PRESENTATION_ITEMS {
        return Err(NativeError::invalid(label, "contain too many values"));
    }
    values
        .iter()
        .map(|value| validate_presentation_text(label, value, false))
        .collect()
}

fn validate_sha256(label: &'static str, value: &str) -> NativeResult<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(NativeError::invalid(label, "must be a SHA-256 hex digest"));
    }
    Ok(normalized)
}

fn validate_actor_kind(value: &str) -> NativeResult<String> {
    match value {
        "user" | "harness" | "policy" => Ok(value.to_owned()),
        _ => Err(NativeError::invalid(
            "actorKind",
            "is not authorized to write approval audit facts",
        )),
    }
}

fn validate_actor_handle(
    label: &'static str,
    value: &str,
    expected_kind: &str,
) -> NativeResult<String> {
    if expected_kind == "harness" && value.starts_with("agent_") {
        return validate_native_id(label, value, "agent_");
    }
    let handle = validate_opaque_handle(label, value)?;
    let kind = handle
        .split_once(':')
        .map(|(kind, _)| kind)
        .unwrap_or_default();
    let kind_matches = match expected_kind {
        "harness" => matches!(kind, "agent" | "harness"),
        "policy" => kind == "policy",
        other => kind == other,
    };
    if !kind_matches {
        return Err(NativeError::invalid(
            label,
            "does not match the authenticated actor kind",
        ));
    }
    Ok(handle)
}

fn validate_reason_code(value: &str) -> NativeResult<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.len() > 128
        || !normalized.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
    {
        return Err(NativeError::invalid("reasonCode", "is malformed"));
    }
    Ok(normalized)
}

fn sha256_json<T: Serialize>(value: &T, label: &'static str) -> NativeResult<String> {
    let bytes = serde_json::to_vec(value).map_err(|_| {
        NativeError::new(
            "approval_integrity_failed",
            format!("The {label} could not be hashed"),
        )
    })?;
    Ok(sha256_bytes(&bytes))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn native_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;

    #[derive(Debug)]
    struct TestClock {
        now_ms: Mutex<i64>,
    }

    impl TestClock {
        fn new(now_ms: i64) -> Self {
            Self {
                now_ms: Mutex::new(now_ms),
            }
        }

        fn set(&self, now_ms: i64) {
            *self.now_ms.lock().expect("test clock lock") = now_ms;
        }
    }

    impl ApprovalClock for TestClock {
        fn now_ms(&self) -> NativeResult<i64> {
            Ok(*self.now_ms.lock().expect("test clock lock"))
        }
    }

    fn native(prefix: &str, digit: char) -> String {
        format!("{prefix}{}", digit.to_string().repeat(32))
    }

    fn hash(digit: char) -> String {
        digit.to_string().repeat(64)
    }

    fn operation() -> ExactOperationInput {
        ExactOperationInput {
            profile_id: native("profile_", '1'),
            authenticated_client_session_id: native("client_session_", '2'),
            authenticated_client_session_epoch: 7,
            run_id: native("run_", '3'),
            attempt_id: native("attempt_", '4'),
            iteration_id: native("iteration_", '5'),
            tool_call_id: native("run_item_", '6'),
            agent_id: native("agent_", '7'),
            environment_id: native("environment_", '8'),
            environment_revision: 3,
            environment_config_sha256: hash('a'),
            subject_type: CapabilitySubjectType::ToolVersion,
            subject_id: "shell-tool@1".to_owned(),
            subject_content_sha256: Some(hash('b')),
            capability: KernelCapability::ExecuteProcess,
            operation_type: "process.spawn".to_owned(),
            arguments: json!({
                "argv": ["cargo", "test"],
                "cwdHandle": "workspace-grant:project-source",
                "environment": { "RUST_BACKTRACE": "1" }
            }),
            tool_version_sha256: hash('c'),
            capability_manifest_sha256: hash('d'),
            capability_set_sha256: hash('e'),
            policy_version_sha256: hash('f'),
            context_snapshot_sha256: hash('0'),
            network_policy_sha256: hash('1'),
            executable_sha256: Some(hash('2')),
            workspace_grant_revision_sha256s: vec![hash('3')],
            resource_handles: vec!["workspace-grant:project-source".to_owned()],
            destinations: vec![],
            data_classes: vec!["source-code".to_owned()],
            requires_elevation: false,
        }
    }

    fn presentation() -> TrustedApprovalPresentationInput {
        TrustedApprovalPresentationInput {
            title: "Run the reviewed test command".to_owned(),
            summary: "Execute Cargo tests in the selected workspace environment.".to_owned(),
            target_labels: vec!["Workspace: project-source".to_owned()],
            consequences: vec!["Starts an unprivileged child process".to_owned()],
            rollback: Some("The process can be cancelled; source files are read-only.".to_owned()),
        }
    }

    fn request_input(
        proposal_key: &str,
        operation: ExactOperationInput,
    ) -> CreateApprovalRequestInput {
        CreateApprovalRequestInput {
            proposal_idempotency_key: proposal_key.to_owned(),
            operation,
            presentation: presentation(),
            choices: vec![ApprovalChoice::AllowOnce, ApprovalChoice::Deny],
            allow_run_max_dispatches: None,
            ttl_ms: 60_000,
        }
    }

    fn approved_broker(
        clock: Arc<TestClock>,
    ) -> (
        ExactApprovalBroker,
        ExactOperationInput,
        ExactApprovalReceipt,
    ) {
        let broker = ExactApprovalBroker::with_clock(clock);
        let exact_operation = operation();
        let request = broker
            .request_approval(request_input("proposal:exact-operation", operation()))
            .expect("approval request");
        let receipt = broker
            .decide_approval(DecideApprovalInput {
                approval_request_id: request.id,
                decision: ApprovalChoice::AllowOnce,
                decision_actor_handle: "user:local".to_owned(),
                current_operation: operation(),
            })
            .expect("approval receipt");
        (broker, exact_operation, receipt)
    }

    #[test]
    fn canonical_arguments_ignore_object_key_order_but_preserve_array_order() {
        let first = json!({"b": 2, "a": {"y": 4, "x": 3}});
        let second = json!({"a": {"x": 3, "y": 4}, "b": 2});
        assert_eq!(
            canonical_json_sha256(&first).unwrap(),
            canonical_json_sha256(&second).unwrap()
        );
        assert_ne!(
            canonical_json_sha256(&json!({"argv": ["a", "b"]})).unwrap(),
            canonical_json_sha256(&json!({"argv": ["b", "a"]})).unwrap()
        );
    }

    #[test]
    fn binding_is_order_insensitive_for_scope_sets_and_never_contains_raw_arguments() {
        let mut first = operation();
        first.resource_handles = vec![
            "workspace-grant:two".to_owned(),
            "workspace-grant:one".to_owned(),
        ];
        first.workspace_grant_revision_sha256s = vec![hash('5'), hash('4')];
        let mut second = operation();
        second.resource_handles = vec![
            "workspace-grant:one".to_owned(),
            "workspace-grant:two".to_owned(),
        ];
        second.workspace_grant_revision_sha256s = vec![hash('4'), hash('5')];
        let first = ExactOperationBinding::freeze(&first).unwrap();
        let second = ExactOperationBinding::freeze(&second).unwrap();
        assert_eq!(first, second);
        let serialized = serde_json::to_string(&first).unwrap();
        assert!(!serialized.contains("RUST_BACKTRACE"));
        assert!(!serialized.contains("cargo"));
    }

    #[test]
    fn exact_receipt_rejects_argument_session_environment_policy_and_tool_drift() {
        let clock = Arc::new(TestClock::new(1_000_000));
        let (broker, _, receipt) = approved_broker(clock);
        let mutations = [
            {
                let mut value = operation();
                value.arguments = json!({"argv": ["cargo", "test", "--release"]});
                value
            },
            {
                let mut value = operation();
                value.authenticated_client_session_epoch += 1;
                value
            },
            {
                let mut value = operation();
                value.environment_revision += 1;
                value
            },
            {
                let mut value = operation();
                value.policy_version_sha256 = hash('9');
                value
            },
            {
                let mut value = operation();
                value.tool_version_sha256 = hash('8');
                value
            },
        ];
        for (index, changed) in mutations.into_iter().enumerate() {
            let error = broker
                .reserve_dispatch(ReserveDispatchInput {
                    approval_receipt_id: receipt.id.clone(),
                    invocation_idempotency_key: format!("dispatch:changed-{index}"),
                    current_operation: changed,
                })
                .expect_err("changed scope must fail closed");
            assert_eq!(error.code, "approval_scope_mismatch");
        }
    }

    #[test]
    fn allow_once_reservation_is_atomic_single_consumption_and_idempotent() {
        let clock = Arc::new(TestClock::new(1_000_000));
        let (broker, _, receipt) = approved_broker(clock);
        let reservation = broker
            .reserve_dispatch(ReserveDispatchInput {
                approval_receipt_id: receipt.id.clone(),
                invocation_idempotency_key: "dispatch:first".to_owned(),
                current_operation: operation(),
            })
            .unwrap();
        let retry = broker
            .reserve_dispatch(ReserveDispatchInput {
                approval_receipt_id: receipt.id.clone(),
                invocation_idempotency_key: "dispatch:first".to_owned(),
                current_operation: operation(),
            })
            .unwrap();
        assert_eq!(retry.id, reservation.id);

        let error = broker
            .reserve_dispatch(ReserveDispatchInput {
                approval_receipt_id: receipt.id.clone(),
                invocation_idempotency_key: "dispatch:second".to_owned(),
                current_operation: operation(),
            })
            .expect_err("a second active reservation must be rejected");
        assert_eq!(error.code, "approval_consumed");

        let permit = broker
            .authorize_dispatch(AuthorizeDispatchInput {
                reservation_id: reservation.id.clone(),
                current_operation: operation(),
            })
            .unwrap();
        let replay = broker
            .authorize_dispatch(AuthorizeDispatchInput {
                reservation_id: reservation.id,
                current_operation: operation(),
            })
            .unwrap();
        assert_eq!(replay, permit);

        let error = broker
            .reserve_dispatch(ReserveDispatchInput {
                approval_receipt_id: receipt.id,
                invocation_idempotency_key: "dispatch:third".to_owned(),
                current_operation: operation(),
            })
            .expect_err("allow-once remains consumed after dispatch starts");
        assert_eq!(error.code, "approval_consumed");
    }

    #[test]
    fn pre_dispatch_release_restores_authority_but_post_dispatch_release_is_rejected() {
        let clock = Arc::new(TestClock::new(1_000_000));
        let (broker, _, receipt) = approved_broker(clock);
        let first = broker
            .reserve_dispatch(ReserveDispatchInput {
                approval_receipt_id: receipt.id.clone(),
                invocation_idempotency_key: "dispatch:cancelled".to_owned(),
                current_operation: operation(),
            })
            .unwrap();
        let released = broker
            .release_reservation(ReleaseReservationInput {
                reservation_id: first.id,
                reason_code: "cancelled_before_dispatch".to_owned(),
            })
            .unwrap();
        assert_eq!(released.state, ReservationState::ReleasedBeforeDispatch);

        let second = broker
            .reserve_dispatch(ReserveDispatchInput {
                approval_receipt_id: receipt.id,
                invocation_idempotency_key: "dispatch:replacement".to_owned(),
                current_operation: operation(),
            })
            .unwrap();
        broker
            .authorize_dispatch(AuthorizeDispatchInput {
                reservation_id: second.id.clone(),
                current_operation: operation(),
            })
            .unwrap();
        let error = broker
            .release_reservation(ReleaseReservationInput {
                reservation_id: second.id,
                reason_code: "late_cancel".to_owned(),
            })
            .expect_err("dispatch authority cannot be restored after start");
        assert_eq!(error.code, "approval_dispatch_already_started");
    }

    #[test]
    fn denial_precedence_and_expiry_fail_closed() {
        let clock = Arc::new(TestClock::new(1_000_000));
        let broker = ExactApprovalBroker::with_clock(clock.clone());
        let request = broker
            .request_approval(request_input("proposal:deny", operation()))
            .unwrap();
        let receipt = broker
            .decide_approval(DecideApprovalInput {
                approval_request_id: request.id,
                decision: ApprovalChoice::Deny,
                decision_actor_handle: "user:local".to_owned(),
                current_operation: operation(),
            })
            .unwrap();
        let error = broker
            .reserve_dispatch(ReserveDispatchInput {
                approval_receipt_id: receipt.id,
                invocation_idempotency_key: "dispatch:denied".to_owned(),
                current_operation: operation(),
            })
            .expect_err("denial is authoritative");
        assert_eq!(error.code, "approval_denied");

        let (broker, _, receipt) = approved_broker(clock.clone());
        clock.set(1_061_000);
        let error = broker
            .reserve_dispatch(ReserveDispatchInput {
                approval_receipt_id: receipt.id,
                invocation_idempotency_key: "dispatch:expired".to_owned(),
                current_operation: operation(),
            })
            .expect_err("expired receipt must fail closed");
        assert_eq!(error.code, "approval_expired");
    }

    #[test]
    fn high_risk_capabilities_never_offer_allow_run() {
        let broker = ExactApprovalBroker::with_clock(Arc::new(TestClock::new(1_000_000)));
        let mut elevated = operation();
        elevated.capability = KernelCapability::RequestAdmin;
        elevated.requires_elevation = true;
        elevated.executable_sha256 = None;
        let mut input = request_input("proposal:admin", elevated);
        input.choices = vec![ApprovalChoice::AllowRun, ApprovalChoice::Deny];
        input.allow_run_max_dispatches = Some(2);
        let error = broker
            .request_approval(input)
            .expect_err("administrator operations need per-dispatch approval");
        assert_eq!(error.code, "approval_choice_not_allowed");
    }

    #[test]
    fn allow_run_is_bounded_to_exact_scope_and_dispatch_count() {
        let broker = ExactApprovalBroker::with_clock(Arc::new(TestClock::new(1_000_000)));
        let mut input = request_input("proposal:allow-run", operation());
        input.choices = vec![
            ApprovalChoice::AllowOnce,
            ApprovalChoice::AllowRun,
            ApprovalChoice::Deny,
        ];
        input.allow_run_max_dispatches = Some(2);
        let request = broker.request_approval(input).unwrap();
        let receipt = broker
            .decide_approval(DecideApprovalInput {
                approval_request_id: request.id,
                decision: ApprovalChoice::AllowRun,
                decision_actor_handle: "user:local".to_owned(),
                current_operation: operation(),
            })
            .unwrap();
        for ordinal in 0..2 {
            let reservation = broker
                .reserve_dispatch(ReserveDispatchInput {
                    approval_receipt_id: receipt.id.clone(),
                    invocation_idempotency_key: format!("dispatch:allow-run-{ordinal}"),
                    current_operation: operation(),
                })
                .unwrap();
            broker
                .authorize_dispatch(AuthorizeDispatchInput {
                    reservation_id: reservation.id,
                    current_operation: operation(),
                })
                .unwrap();
        }
        let error = broker
            .reserve_dispatch(ReserveDispatchInput {
                approval_receipt_id: receipt.id,
                invocation_idempotency_key: "dispatch:allow-run-2".to_owned(),
                current_operation: operation(),
            })
            .expect_err("allow-run still has an explicit quantitative limit");
        assert_eq!(error.code, "approval_consumed");

        let mut another_run = operation();
        another_run.run_id = native("run_", '9');
        assert_ne!(
            ExactOperationBinding::freeze(&another_run)
                .unwrap()
                .scope_sha256,
            ExactOperationBinding::freeze(&operation())
                .unwrap()
                .scope_sha256
        );
    }

    #[test]
    fn terminal_effect_is_unique_and_success_requires_postcondition_evidence() {
        let clock = Arc::new(TestClock::new(1_000_000));
        let (broker, _, receipt) = approved_broker(clock.clone());
        let reservation = broker
            .reserve_dispatch(ReserveDispatchInput {
                approval_receipt_id: receipt.id,
                invocation_idempotency_key: "dispatch:terminal".to_owned(),
                current_operation: operation(),
            })
            .unwrap();
        broker
            .authorize_dispatch(AuthorizeDispatchInput {
                reservation_id: reservation.id.clone(),
                current_operation: operation(),
            })
            .unwrap();
        clock.set(1_000_100);
        let error = broker
            .finalize_dispatch(FinalizeDispatchInput {
                reservation_id: reservation.id.clone(),
                outcome: DispatchOutcome::Succeeded,
                reason_code: "postcondition_verified".to_owned(),
                verification_sha256: None,
            })
            .expect_err("success must include verification evidence");
        assert_eq!(error.code, "invalid_input");
        let finalized = broker
            .finalize_dispatch(FinalizeDispatchInput {
                reservation_id: reservation.id.clone(),
                outcome: DispatchOutcome::Succeeded,
                reason_code: "postcondition_verified".to_owned(),
                verification_sha256: Some(hash('7')),
            })
            .unwrap();
        assert_eq!(finalized.state, ReservationState::Finalized);
        let retry = broker
            .finalize_dispatch(FinalizeDispatchInput {
                reservation_id: reservation.id.clone(),
                outcome: DispatchOutcome::Succeeded,
                reason_code: "postcondition_verified".to_owned(),
                verification_sha256: Some(hash('7')),
            })
            .unwrap();
        assert_eq!(retry, finalized);
        let error = broker
            .finalize_dispatch(FinalizeDispatchInput {
                reservation_id: reservation.id,
                outcome: DispatchOutcome::Failed,
                reason_code: "late_conflict".to_owned(),
                verification_sha256: None,
            })
            .expect_err("terminal effect cannot be rewritten");
        assert_eq!(error.code, "approval_finalization_conflict");
    }

    #[test]
    fn finalized_outcome_unknown_cannot_be_reauthorized() {
        let clock = Arc::new(TestClock::new(1_000_000));
        let (broker, _, receipt) = approved_broker(clock.clone());
        let reservation = broker
            .reserve_dispatch(ReserveDispatchInput {
                approval_receipt_id: receipt.id,
                invocation_idempotency_key: "dispatch:unknown-terminal".to_owned(),
                current_operation: operation(),
            })
            .unwrap();
        broker
            .authorize_dispatch(AuthorizeDispatchInput {
                reservation_id: reservation.id.clone(),
                current_operation: operation(),
            })
            .unwrap();
        clock.set(1_000_100);
        broker
            .finalize_dispatch(FinalizeDispatchInput {
                reservation_id: reservation.id.clone(),
                outcome: DispatchOutcome::OutcomeUnknown,
                reason_code: "remote_ack_missing".to_owned(),
                verification_sha256: None,
            })
            .unwrap();

        let error = broker
            .authorize_dispatch(AuthorizeDispatchInput {
                reservation_id: reservation.id,
                current_operation: operation(),
            })
            .expect_err("a terminal outcome must not mint another dispatch permit");
        assert_eq!(error.code, "approval_dispatch_finalized");
    }

    #[test]
    fn request_creation_audit_linkage_is_fail_closed() {
        let broker = ExactApprovalBroker::with_clock(Arc::new(TestClock::new(1_000_000)));
        let request = broker
            .request_approval(request_input("proposal:audit-link", operation()))
            .unwrap();
        let mut state = broker.lock_state().unwrap();
        let audit = state
            .audit_events
            .iter_mut()
            .find(|event| event.id == request.created_audit_event_id)
            .expect("request creation audit");
        audit.action = ApprovalAuditAction::DecisionRecorded;
        let error = verify_request_integrity(&request, &state.audit_events)
            .expect_err("request creation audit action drift must fail closed");
        assert_eq!(error.code, "approval_integrity_failed");
    }

    #[test]
    fn decision_audit_linkage_is_fail_closed() {
        let clock = Arc::new(TestClock::new(1_000_000));
        let (broker, _, receipt) = approved_broker(clock);
        let mut state = broker.lock_state().unwrap();
        let audit = state
            .audit_events
            .iter_mut()
            .find(|event| event.id == receipt.decision_audit_event_id)
            .expect("decision audit");
        audit.action = ApprovalAuditAction::RequestCreated;
        let request = state
            .requests
            .get(&receipt.approval_request_id)
            .cloned()
            .expect("approval request");
        let error = verify_receipt_integrity(&receipt, &request, &state.audit_events)
            .expect_err("decision audit action drift must fail closed");
        assert_eq!(error.code, "approval_integrity_failed");
    }

    #[test]
    fn audit_chain_is_gap_free_hash_linked_and_omits_raw_arguments() {
        let clock = Arc::new(TestClock::new(1_000_000));
        let (broker, _, receipt) = approved_broker(clock.clone());
        let reservation = broker
            .reserve_dispatch(ReserveDispatchInput {
                approval_receipt_id: receipt.id,
                invocation_idempotency_key: "dispatch:audit".to_owned(),
                current_operation: operation(),
            })
            .unwrap();
        broker
            .authorize_dispatch(AuthorizeDispatchInput {
                reservation_id: reservation.id.clone(),
                current_operation: operation(),
            })
            .unwrap();
        clock.set(1_000_100);
        broker
            .finalize_dispatch(FinalizeDispatchInput {
                reservation_id: reservation.id,
                outcome: DispatchOutcome::OutcomeUnknown,
                reason_code: "remote_ack_missing".to_owned(),
                verification_sha256: None,
            })
            .unwrap();
        let events = broker.audit_events().unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.sequence_no)
                .collect::<Vec<_>>(),
            (1..=events.len() as u64).collect::<Vec<_>>()
        );
        for index in 1..events.len() {
            assert_eq!(
                events[index].previous_event_sha256.as_deref(),
                Some(events[index - 1].event_sha256.as_str())
            );
        }
        let serialized = serde_json::to_string(&events).unwrap();
        assert!(!serialized.contains("RUST_BACKTRACE"));
        assert!(!serialized.contains("cargo"));
        assert!(!serialized.contains("--release"));
        assert!(events
            .iter()
            .any(|event| event.outcome == ApprovalAuditOutcome::OutcomeUnknown));
    }

    #[test]
    fn proposal_and_decision_retries_are_idempotent_but_conflicts_are_rejected() {
        let broker = ExactApprovalBroker::with_clock(Arc::new(TestClock::new(1_000_000)));
        let request = broker
            .request_approval(request_input("proposal:retry", operation()))
            .unwrap();
        let retry = broker
            .request_approval(request_input("proposal:retry", operation()))
            .unwrap();
        assert_eq!(retry.id, request.id);
        let mut changed = operation();
        changed.arguments = json!({"argv": ["cargo", "check"]});
        let error = broker
            .request_approval(request_input("proposal:retry", changed))
            .expect_err("proposal key cannot be retargeted");
        assert_eq!(error.code, "approval_proposal_conflict");

        let receipt = broker
            .decide_approval(DecideApprovalInput {
                approval_request_id: request.id.clone(),
                decision: ApprovalChoice::AllowOnce,
                decision_actor_handle: "user:local".to_owned(),
                current_operation: operation(),
            })
            .unwrap();
        let receipt_retry = broker
            .decide_approval(DecideApprovalInput {
                approval_request_id: request.id.clone(),
                decision: ApprovalChoice::AllowOnce,
                decision_actor_handle: "user:local".to_owned(),
                current_operation: operation(),
            })
            .unwrap();
        assert_eq!(receipt_retry, receipt);
        let error = broker
            .decide_approval(DecideApprovalInput {
                approval_request_id: request.id,
                decision: ApprovalChoice::Deny,
                decision_actor_handle: "user:local".to_owned(),
                current_operation: operation(),
            })
            .expect_err("a recorded decision is immutable");
        assert_eq!(error.code, "approval_already_decided");
    }

    #[test]
    fn reservation_race_allows_only_one_allow_once_invocation() {
        let clock = Arc::new(TestClock::new(1_000_000));
        let (broker, _, receipt) = approved_broker(clock);
        let broker = Arc::new(broker);
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let mut workers = Vec::new();
        for ordinal in 0..2 {
            let broker = Arc::clone(&broker);
            let barrier = Arc::clone(&barrier);
            let receipt_id = receipt.id.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                broker.reserve_dispatch(ReserveDispatchInput {
                    approval_receipt_id: receipt_id,
                    invocation_idempotency_key: format!("dispatch:race-{ordinal}"),
                    current_operation: operation(),
                })
            }));
        }
        barrier.wait();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().expect("worker joins"))
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .filter(|error| error.code == "approval_consumed")
                .count(),
            1
        );
    }

    #[test]
    fn release_and_dispatch_race_has_one_linearized_winner() {
        for ordinal in 0..32 {
            let clock = Arc::new(TestClock::new(1_000_000));
            let (broker, _, receipt) = approved_broker(clock);
            let broker = Arc::new(broker);
            let reservation = broker
                .reserve_dispatch(ReserveDispatchInput {
                    approval_receipt_id: receipt.id.clone(),
                    invocation_idempotency_key: format!("dispatch:release-race-{ordinal}"),
                    current_operation: operation(),
                })
                .unwrap();
            let reservation_id = reservation.id.clone();
            let barrier = Arc::new(std::sync::Barrier::new(3));

            let release_worker = {
                let broker = Arc::clone(&broker);
                let barrier = Arc::clone(&barrier);
                let reservation_id = reservation_id.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    broker.release_reservation(ReleaseReservationInput {
                        reservation_id,
                        reason_code: "cancelled_before_dispatch".to_owned(),
                    })
                })
            };
            let dispatch_worker = {
                let broker = Arc::clone(&broker);
                let barrier = Arc::clone(&barrier);
                let reservation_id = reservation_id.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    broker.authorize_dispatch(AuthorizeDispatchInput {
                        reservation_id,
                        current_operation: operation(),
                    })
                })
            };

            barrier.wait();
            let release_result = release_worker.join().expect("release worker joins");
            let dispatch_result = dispatch_worker.join().expect("dispatch worker joins");
            let expected_action = match (release_result, dispatch_result) {
                (Ok(released), Err(dispatch_error)) => {
                    assert_eq!(released.id, reservation_id);
                    assert_eq!(released.state, ReservationState::ReleasedBeforeDispatch);
                    assert_eq!(dispatch_error.code, "approval_reservation_released");

                    let replay = broker
                        .release_reservation(ReleaseReservationInput {
                            reservation_id: reservation_id.clone(),
                            reason_code: "cancelled_before_dispatch".to_owned(),
                        })
                        .unwrap();
                    assert_eq!(replay, released);
                    broker
                        .reserve_dispatch(ReserveDispatchInput {
                            approval_receipt_id: receipt.id.clone(),
                            invocation_idempotency_key: format!(
                                "dispatch:release-race-replacement-{ordinal}"
                            ),
                            current_operation: operation(),
                        })
                        .expect("pre-dispatch release must restore receipt authority");
                    ApprovalAuditAction::ReservationReleased
                }
                (Err(release_error), Ok(permit)) => {
                    assert_eq!(permit.reservation_id, reservation_id);
                    assert_eq!(release_error.code, "approval_dispatch_already_started");

                    let replay = broker
                        .authorize_dispatch(AuthorizeDispatchInput {
                            reservation_id: reservation_id.clone(),
                            current_operation: operation(),
                        })
                        .unwrap();
                    assert_eq!(replay, permit);
                    let error = broker
                        .reserve_dispatch(ReserveDispatchInput {
                            approval_receipt_id: receipt.id.clone(),
                            invocation_idempotency_key: format!(
                                "dispatch:dispatch-race-replacement-{ordinal}"
                            ),
                            current_operation: operation(),
                        })
                        .expect_err("started dispatch must keep allow-once authority consumed");
                    assert_eq!(error.code, "approval_consumed");
                    ApprovalAuditAction::DispatchStarted
                }
                (release_result, dispatch_result) => panic!(
                    "release/dispatch race did not linearize: release={release_result:?}, dispatch={dispatch_result:?}"
                ),
            };

            let events = broker.audit_events().unwrap();
            let transition_events = events
                .iter()
                .filter(|event| {
                    event.reservation_id.as_deref() == Some(reservation_id.as_str())
                        && matches!(
                            event.action,
                            ApprovalAuditAction::ReservationReleased
                                | ApprovalAuditAction::DispatchStarted
                        )
                })
                .collect::<Vec<_>>();
            assert_eq!(transition_events.len(), 1);
            assert_eq!(transition_events[0].action, expected_action);
        }
    }
}
