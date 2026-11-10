use std::collections::HashSet;

use rusqlite::{params, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{NativeError, NativeResult},
    storage::{sha256_hex, Storage},
};

const DEFAULT_PROFILE_ID: &str = "profile_default";
const MAX_OPAQUE_ID_BYTES: usize = 512;
const MAX_SELECTOR_BYTES: usize = 512;
const MAX_REASON_CODES: usize = 256;
const MAX_REJECTED_ALTERNATIVES: usize = 64;
const MAX_DERIVATIVE_HASHES: usize = 4_096;

const REQUESTED_MODES: &[&str] = &[
    "auto",
    "direct-native",
    "local-transform",
    "specialist-bridge-model",
    "hybrid-ensemble",
    "surrogate-to-primary",
    "human-review",
    "unsupported",
    "local-only",
    "direct-only",
    "cheapest",
    "highest-quality",
    "manual",
];
const RESOLVED_MODES: &[&str] = &[
    "direct-native",
    "local-transform",
    "specialist-bridge-model",
    "hybrid-ensemble",
    "surrogate-to-primary",
    "human-review",
    "unsupported",
];
const PROVIDER_MODES: &[&str] = &[
    "direct-native",
    "specialist-bridge-model",
    "hybrid-ensemble",
    "surrogate-to-primary",
];
const DISPOSITIONS: &[&str] = &[
    "ready",
    "ready-with-degradation",
    "review-required",
    "blocked",
    "failed",
    "unsupported",
];
const DATA_BOUNDARIES: &[&str] = &[
    "local-only",
    "approved-provider",
    "mixed",
    "denied",
    "review-required",
];
const EGRESS_DECISIONS: &[&str] = &["not-required", "approved", "denied", "review-required"];
const FIDELITY_PROFILES: &[&str] = &[
    "semantic-and-visual",
    "semantic-only",
    "render-required",
    "model-specific",
    "unknown",
];
const FIDELITY_DIMENSIONS: &[&str] = &[
    "integrity",
    "content",
    "structural",
    "layout",
    "spatial",
    "temporal",
    "semantic",
    "numeric",
    "formula",
    "code",
    "citation",
    "accessibility",
    "provenance",
];
const ARTIFACT_MODALITIES: &[&str] = &[
    "image",
    "audio",
    "video",
    "pdf",
    "document",
    "spreadsheet",
    "archive",
    "code",
    "structured-data",
    "scientific-artifact",
];
const SOURCE_SELECTOR_KINDS: &[&str] = &[
    "region", "page", "sheet", "cell", "range", "slide", "frame", "time", "byte", "symbol",
    "member",
];
const STAGE_KINDS: &[&str] = &[
    "admit",
    "direct-deliver",
    "local-transform",
    "specialist-bridge",
    "hybrid-verify",
    "surrogate-package",
    "primary-deliver",
    "human-review",
];
const STAGE_STATUSES: &[&str] = &[
    "planned",
    "running",
    "completed",
    "failed",
    "cancelled",
    "outcome-unknown",
    "reconcile-required",
    "unsupported",
];
const STAGE_BOUNDARIES: &[&str] = &["local-only", "approved-provider", "human-review"];
const PROVIDER_ACCEPTANCE: &[&str] = &["not-applicable", "not-accepted", "accepted", "unknown"];
const RECONCILIATION_STATUSES: &[&str] =
    &["not-required", "pending", "reconciled", "blocked", "failed"];
const STAGE_FIDELITY_DISPOSITIONS: &[&str] = &[
    "planned",
    "processing",
    "ready",
    "ready-with-degradation",
    "review-required",
    "blocked",
    "failed",
    "unsupported",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeRejectedAlternative {
    pub mode: String,
    pub reason_codes: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct PersistBridgeArtifact {
    pub attachment_id: String,
    pub source_sha256: String,
    pub source_selector: String,
    pub modality: String,
    pub media_type: String,
    pub byte_size: i64,
}

#[derive(Clone, Debug)]
pub struct PersistMultimodalBridgePlan {
    pub id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub frozen_provider_input_id: Option<String>,
    pub supersedes_plan_id: Option<String>,
    pub requested_mode: String,
    pub resolved_mode: String,
    pub disposition: String,
    pub source_manifest_sha256: String,
    pub capability_snapshot_revision_id: String,
    pub policy_revision_id: String,
    pub data_boundary: String,
    pub egress_decision: String,
    pub selected_reason_codes: Vec<String>,
    pub rejected_alternatives: Vec<BridgeRejectedAlternative>,
    pub decisive_fidelity_dimensions: Vec<String>,
    pub fidelity_profile: String,
    pub artifacts: Vec<PersistBridgeArtifact>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultimodalBridgePlanRecord {
    pub id: String,
    pub schema_version: i64,
    pub contract_revision: i64,
    pub run_id: String,
    pub attempt_id: String,
    pub frozen_provider_input_id: Option<String>,
    pub supersedes_plan_id: Option<String>,
    pub requested_mode: String,
    pub resolved_mode: String,
    pub disposition: String,
    pub source_manifest_sha256: String,
    pub capability_snapshot_revision_id: String,
    pub policy_revision_id: String,
    pub data_boundary: String,
    pub egress_decision: String,
    pub selected_reason_codes: Vec<String>,
    pub rejected_alternatives: Vec<BridgeRejectedAlternative>,
    pub decisive_fidelity_dimensions: Vec<String>,
    pub fidelity_profile: String,
    pub plan_sha256: String,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultimodalBridgeArtifactRecord {
    pub plan_id: String,
    pub ordinal: i64,
    pub attachment_id: String,
    pub source_sha256: String,
    pub source_selector: String,
    pub modality: String,
    pub media_type: String,
    pub byte_size: i64,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug)]
pub struct AppendBridgeStageReceipt {
    pub id: String,
    pub plan_id: String,
    pub stage_id: String,
    pub attempt_no: i64,
    pub stage_kind: String,
    pub status: String,
    pub boundary: String,
    pub output_manifest_sha256: Option<String>,
    pub provider_acceptance: String,
    pub reconciliation_status: String,
    pub derivative_sha256: Vec<String>,
    pub fidelity_disposition: String,
    pub started_at_ms: i64,
    pub completed_at_ms: Option<i64>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultimodalBridgeStageReceiptRecord {
    pub id: String,
    pub schema_version: i64,
    pub plan_id: String,
    pub stage_id: String,
    pub attempt_no: i64,
    pub stage_kind: String,
    pub status: String,
    pub boundary: String,
    pub source_manifest_sha256: String,
    pub output_manifest_sha256: Option<String>,
    pub capability_snapshot_revision_id: String,
    pub policy_revision_id: String,
    pub provider_acceptance: String,
    pub reconciliation_status: String,
    pub derivative_sha256: Vec<String>,
    pub fidelity_disposition: String,
    pub receipt_sha256: String,
    pub started_at_ms: i64,
    pub completed_at_ms: Option<i64>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultimodalBridgeStateRecord {
    pub plan: MultimodalBridgePlanRecord,
    pub artifacts: Vec<MultimodalBridgeArtifactRecord>,
    pub stage_receipts: Vec<MultimodalBridgeStageReceiptRecord>,
}

/// The only multimodal route preference that may cross the renderer/native
/// boundary during run preparation. It is deliberately distinct from a
/// resolved bridge plan: a renderer asks native to evaluate an intent; it
/// never grants egress, invents source provenance, or chooses a final route.
#[derive(Clone, Debug)]
pub(crate) struct BridgeAdmissionIntent {
    requested_mode: String,
}

impl BridgeAdmissionIntent {
    pub(crate) fn auto() -> Self {
        Self {
            requested_mode: "auto".to_owned(),
        }
    }

    #[cfg(test)]
    pub(crate) fn from_renderer_requested_mode(
        requested_mode: Option<String>,
    ) -> NativeResult<Self> {
        let requested_mode = requested_mode.unwrap_or_else(|| "auto".to_owned());
        validate_enum("bridgeRequestedMode", &requested_mode, REQUESTED_MODES)?;
        Ok(Self { requested_mode })
    }

    fn requested_mode(&self) -> &str {
        &self.requested_mode
    }
}

/// Native-owned bootstrap authority for the current planning-only bridge
/// slice. These revision IDs identify the policy/capability basis used to
/// create the immutable plan; they do not claim that a live provider probe,
/// an upload, or a provider acceptance has occurred.
#[derive(Clone, Debug)]
pub(crate) struct NativeBridgeAdmissionAuthority {
    capability_snapshot_revision_id: String,
    policy_revision_id: String,
}

impl Default for NativeBridgeAdmissionAuthority {
    fn default() -> Self {
        Self {
            capability_snapshot_revision_id: "capability_snapshot_local_planning_v1".to_owned(),
            policy_revision_id: "policy_revision_local_first_v1".to_owned(),
        }
    }
}

/// Canonical, native-derived evidence for the message-owned attachment set of
/// a prepared run. This type is deliberately not serializable: a renderer may
/// receive a safe projection of a persisted plan, never an authority-bearing
/// source manifest input.
#[derive(Clone, Debug)]
pub(crate) struct BoundAttachmentManifest {
    pub(crate) source_manifest_sha256: String,
    pub(crate) artifacts: Vec<PersistBridgeArtifact>,
}

/// Exact native lineage that a receipt-derived source manifest must satisfy.
/// `draft_ids` are opaque native draft identifiers selected before the
/// transaction; all other values are already-created native graph nodes.
pub(crate) struct BoundAttachmentManifestScope<'a> {
    pub(crate) profile_id: &'a str,
    pub(crate) project_id: Option<&'a str>,
    pub(crate) conversation_id: &'a str,
    pub(crate) branch_id: &'a str,
    pub(crate) message_id: &'a str,
    pub(crate) run_id: &'a str,
    pub(crate) attempt_id: &'a str,
    /// The exact frozen text input associated with this first attempt. A
    /// manifest must not be reusable merely because another frozen input row
    /// happens to exist for the same run in a future schema revision.
    pub(crate) frozen_provider_input_id: &'a str,
    pub(crate) draft_ids: &'a [String],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BoundAttachmentManifestHashMaterial<'a> {
    schema_version: i64,
    profile_id: &'a str,
    project_id: Option<&'a str>,
    conversation_id: &'a str,
    branch_id: &'a str,
    run_id: &'a str,
    attempt_id: &'a str,
    frozen_provider_input_id: &'a str,
    message_id: &'a str,
    artifacts: &'a [BoundAttachmentManifestHashArtifact],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BoundAttachmentManifestHashArtifact {
    binding_key: String,
    attachment_id: String,
    source_sha256: String,
    source_selector: String,
    modality: String,
    media_type: String,
    byte_size: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentBindingKeyHashMaterial<'a> {
    schema_version: i64,
    profile_id: &'a str,
    draft_id: &'a str,
    target_user_message_id: &'a str,
    target_run_id: &'a str,
    first_attempt_id: &'a str,
    captured_project_id: Option<&'a str>,
    captured_conversation_id: &'a str,
    captured_branch_id: &'a str,
}

/// Produces the canonical native-only attachment binding key from immutable
/// admission lineage. Keeping one implementation shared by binding, manifest
/// reconstruction, and replay prevents cross-path hash drift.
pub(crate) fn native_attachment_binding_key(
    draft_id: &str,
    user_message_id: &str,
    run_id: &str,
    attempt_id: &str,
    project_id: Option<&str>,
    conversation_id: &str,
    branch_id: &str,
) -> NativeResult<String> {
    let material = AttachmentBindingKeyHashMaterial {
        schema_version: 1,
        profile_id: DEFAULT_PROFILE_ID,
        draft_id,
        target_user_message_id: user_message_id,
        target_run_id: run_id,
        first_attempt_id: attempt_id,
        captured_project_id: project_id,
        captured_conversation_id: conversation_id,
        captured_branch_id: branch_id,
    };
    let bytes = serde_json::to_vec(&material).map_err(|_| {
        NativeError::new(
            "attachment_binding_key_serialization_failed",
            "The native attachment binding lineage could not be serialized",
        )
    })?;
    Ok(format!("attachment_binding_v1_{}", sha256_hex(bytes)))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PreparedAdmissionRoute {
    LocalTransformBlocked,
    HumanReview,
    RequestedRouteUnavailable,
    ExplicitUnsupported,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanHashMaterial<'a> {
    schema_version: i64,
    contract_revision: i64,
    id: &'a str,
    run_id: &'a str,
    attempt_id: &'a str,
    frozen_provider_input_id: Option<&'a str>,
    supersedes_plan_id: Option<&'a str>,
    requested_mode: &'a str,
    resolved_mode: &'a str,
    disposition: &'a str,
    source_manifest_sha256: &'a str,
    capability_snapshot_revision_id: &'a str,
    policy_revision_id: &'a str,
    data_boundary: &'a str,
    egress_decision: &'a str,
    selected_reason_codes: &'a [String],
    rejected_alternatives: &'a [BridgeRejectedAlternative],
    decisive_fidelity_dimensions: &'a [String],
    fidelity_profile: &'a str,
    artifacts: &'a [PersistBridgeArtifact],
    created_at_ms: i64,
}

impl Serialize for PersistBridgeArtifact {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Material<'a> {
            attachment_id: &'a str,
            source_sha256: &'a str,
            source_selector: &'a str,
            modality: &'a str,
            media_type: &'a str,
            byte_size: i64,
        }
        Material {
            attachment_id: &self.attachment_id,
            source_sha256: &self.source_sha256,
            source_selector: &self.source_selector,
            modality: &self.modality,
            media_type: &self.media_type,
            byte_size: self.byte_size,
        }
        .serialize(serializer)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StageReceiptHashMaterial<'a> {
    schema_version: i64,
    id: &'a str,
    plan_id: &'a str,
    stage_id: &'a str,
    attempt_no: i64,
    stage_kind: &'a str,
    status: &'a str,
    boundary: &'a str,
    source_manifest_sha256: &'a str,
    output_manifest_sha256: Option<&'a str>,
    capability_snapshot_revision_id: &'a str,
    policy_revision_id: &'a str,
    provider_acceptance: &'a str,
    reconciliation_status: &'a str,
    derivative_sha256: &'a [String],
    fidelity_disposition: &'a str,
    started_at_ms: i64,
    completed_at_ms: Option<i64>,
    created_at_ms: i64,
}

impl Storage {
    #[cfg(test)]
    pub(crate) fn persist_multimodal_bridge_plan(
        &self,
        input: PersistMultimodalBridgePlan,
    ) -> NativeResult<MultimodalBridgeStateRecord> {
        self.with_transaction(|transaction| {
            persist_multimodal_bridge_plan_in_transaction(transaction, &input)
        })
    }

    #[cfg(test)]
    pub(crate) fn append_multimodal_bridge_stage_receipt(
        &self,
        input: AppendBridgeStageReceipt,
    ) -> NativeResult<MultimodalBridgeStageReceiptRecord> {
        self.with_transaction(|transaction| {
            append_multimodal_bridge_stage_receipt_in_transaction(transaction, &input)
        })
    }

    #[cfg(test)]
    pub(crate) fn read_multimodal_bridge_state(
        &self,
        plan_id: &str,
    ) -> NativeResult<MultimodalBridgeStateRecord> {
        validate_prefixed_id("planId", plan_id, "bridge_plan_")?;
        self.with_connection(|connection| load_bridge_state(connection, plan_id))
    }
}

/// Persists a bridge plan inside a caller-owned transaction. The admission
/// orchestrator uses this primitive so message/run creation, immutable source
/// binding, the plan, and its initial stage receipt either commit together or
/// roll back together. It must never acquire the storage mutex or commit.
pub(crate) fn persist_multimodal_bridge_plan_in_transaction(
    transaction: &Transaction<'_>,
    input: &PersistMultimodalBridgePlan,
) -> NativeResult<MultimodalBridgeStateRecord> {
    validate_plan(input)?;
    let plan_sha256 = hash_json(&PlanHashMaterial {
        schema_version: 1,
        contract_revision: 2,
        id: &input.id,
        run_id: &input.run_id,
        attempt_id: &input.attempt_id,
        frozen_provider_input_id: input.frozen_provider_input_id.as_deref(),
        supersedes_plan_id: input.supersedes_plan_id.as_deref(),
        requested_mode: &input.requested_mode,
        resolved_mode: &input.resolved_mode,
        disposition: &input.disposition,
        source_manifest_sha256: &input.source_manifest_sha256,
        capability_snapshot_revision_id: &input.capability_snapshot_revision_id,
        policy_revision_id: &input.policy_revision_id,
        data_boundary: &input.data_boundary,
        egress_decision: &input.egress_decision,
        selected_reason_codes: &input.selected_reason_codes,
        rejected_alternatives: &input.rejected_alternatives,
        decisive_fidelity_dimensions: &input.decisive_fidelity_dimensions,
        fidelity_profile: &input.fidelity_profile,
        artifacts: &input.artifacts,
        created_at_ms: input.created_at_ms,
    })?;
    let selected_reason_codes_json = serialize_bounded(
        &input.selected_reason_codes,
        32 * 1024,
        "selected reason codes",
    )?;
    let rejected_alternatives_json = serialize_bounded(
        &input.rejected_alternatives,
        128 * 1024,
        "rejected alternatives",
    )?;
    let decisive_fidelity_dimensions_json = serialize_bounded(
        &input.decisive_fidelity_dimensions,
        32 * 1024,
        "decisive fidelity dimensions",
    )?;

    transaction.execute(
        "INSERT INTO multimodal_bridge_plans (
            id, schema_version, contract_revision, profile_id, run_id,
            attempt_id, frozen_provider_input_id, supersedes_plan_id,
            requested_mode, resolved_mode, disposition,
            source_manifest_sha256, capability_snapshot_revision_id,
            policy_revision_id, data_boundary, egress_decision,
            selected_reason_codes_json, rejected_alternatives_json,
            decisive_fidelity_dimensions_json, fidelity_profile,
            plan_sha256, created_at_ms
         ) VALUES (
            ?1, 1, 2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
            ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20
         )",
        params![
            input.id.as_str(),
            DEFAULT_PROFILE_ID,
            input.run_id.as_str(),
            input.attempt_id.as_str(),
            input.frozen_provider_input_id.as_deref(),
            input.supersedes_plan_id.as_deref(),
            input.requested_mode.as_str(),
            input.resolved_mode.as_str(),
            input.disposition.as_str(),
            input.source_manifest_sha256.as_str(),
            input.capability_snapshot_revision_id.as_str(),
            input.policy_revision_id.as_str(),
            input.data_boundary.as_str(),
            input.egress_decision.as_str(),
            selected_reason_codes_json,
            rejected_alternatives_json,
            decisive_fidelity_dimensions_json,
            input.fidelity_profile.as_str(),
            plan_sha256,
            input.created_at_ms,
        ],
    )?;
    for (ordinal, artifact) in input.artifacts.iter().enumerate() {
        transaction.execute(
            "INSERT INTO multimodal_bridge_plan_artifacts (
                plan_id, ordinal, attachment_id, source_sha256,
                source_selector, modality, media_type, byte_size,
                created_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                input.id.as_str(),
                i64::try_from(ordinal).map_err(|_| NativeError::new(
                    "bridge_plan_too_large",
                    "The bridge artifact list is too large",
                ))?,
                artifact.attachment_id.as_str(),
                artifact.source_sha256.as_str(),
                artifact.source_selector.as_str(),
                artifact.modality.as_str(),
                artifact.media_type.as_str(),
                artifact.byte_size,
                input.created_at_ms,
            ],
        )?;
    }
    load_bridge_state(transaction, &input.id)
}

/// Appends one immutable bridge-stage receipt inside a caller-owned
/// transaction. The source-manifest and policy/capability revision fields are
/// reloaded from the persisted plan, never accepted from the stage caller.
pub(crate) fn append_multimodal_bridge_stage_receipt_in_transaction(
    transaction: &Transaction<'_>,
    input: &AppendBridgeStageReceipt,
) -> NativeResult<MultimodalBridgeStageReceiptRecord> {
    validate_stage_receipt(input)?;
    let plan = load_plan(transaction, &input.plan_id)?;
    validate_stage_receipt_for_plan(&plan, input)?;
    let derivative_sha256_json = serialize_bounded(
        &input.derivative_sha256,
        128 * 1024,
        "bridge derivative hashes",
    )?;
    let receipt_sha256 = hash_json(&StageReceiptHashMaterial {
        schema_version: 1,
        id: &input.id,
        plan_id: &input.plan_id,
        stage_id: &input.stage_id,
        attempt_no: input.attempt_no,
        stage_kind: &input.stage_kind,
        status: &input.status,
        boundary: &input.boundary,
        source_manifest_sha256: &plan.source_manifest_sha256,
        output_manifest_sha256: input.output_manifest_sha256.as_deref(),
        capability_snapshot_revision_id: &plan.capability_snapshot_revision_id,
        policy_revision_id: &plan.policy_revision_id,
        provider_acceptance: &input.provider_acceptance,
        reconciliation_status: &input.reconciliation_status,
        derivative_sha256: &input.derivative_sha256,
        fidelity_disposition: &input.fidelity_disposition,
        started_at_ms: input.started_at_ms,
        completed_at_ms: input.completed_at_ms,
        created_at_ms: input.created_at_ms,
    })?;
    transaction.execute(
        "INSERT INTO multimodal_bridge_stage_receipts (
            id, schema_version, plan_id, stage_id, attempt_no,
            stage_kind, status, boundary, source_manifest_sha256,
            output_manifest_sha256, capability_snapshot_revision_id,
            policy_revision_id, provider_acceptance,
            reconciliation_status, derivative_sha256_json,
            fidelity_disposition, receipt_sha256, started_at_ms,
            completed_at_ms, created_at_ms
         ) VALUES (
            ?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
            ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
         )",
        params![
            input.id.as_str(),
            input.plan_id.as_str(),
            input.stage_id.as_str(),
            input.attempt_no,
            input.stage_kind.as_str(),
            input.status.as_str(),
            input.boundary.as_str(),
            plan.source_manifest_sha256,
            input.output_manifest_sha256.as_deref(),
            plan.capability_snapshot_revision_id,
            plan.policy_revision_id,
            input.provider_acceptance.as_str(),
            input.reconciliation_status.as_str(),
            derivative_sha256_json,
            input.fidelity_disposition.as_str(),
            receipt_sha256,
            input.started_at_ms,
            input.completed_at_ms,
            input.created_at_ms,
        ],
    )?;
    load_stage_receipt(transaction, &input.id)
}

#[derive(Debug)]
struct BoundAttachmentSourceRow {
    draft_id: String,
    binding_key: String,
    attachment_id: String,
    receipt_blob_id: String,
    receipt_profile_id: String,
    receipt_project_id: Option<String>,
    receipt_conversation_id: String,
    receipt_branch_id: String,
    receipt_message_id: String,
    receipt_run_id: String,
    attachment_profile_id: String,
    attachment_draft_id: Option<String>,
    attachment_message_id: Option<String>,
    attachment_project_id: Option<String>,
    attachment_blob_id: String,
    attachment_media_type: String,
    attachment_byte_size: i64,
    attachment_deleted_at_ms: Option<i64>,
    blob_id: String,
    blob_media_type: String,
    blob_plaintext_size: i64,
}

#[allow(clippy::type_complexity)] // row tuple mirrors the SQL column list; a type alias would add indirection
/// Reconstructs an immutable bridge source manifest from v6 receipts and the
/// post-bind message-owned attachment rows. No renderer field, storage path,
/// filename, decrypted byte stream, or provider payload participates in this
/// operation.
pub(crate) fn build_bound_attachment_manifest_in_transaction(
    transaction: &Transaction<'_>,
    scope: BoundAttachmentManifestScope<'_>,
) -> NativeResult<BoundAttachmentManifest> {
    validate_opaque_id("profileId", scope.profile_id)?;
    validate_prefixed_id("conversationId", scope.conversation_id, "conversation_")?;
    validate_prefixed_id("branchId", scope.branch_id, "branch_")?;
    validate_prefixed_id("messageId", scope.message_id, "message_")?;
    validate_prefixed_id("runId", scope.run_id, "run_")?;
    validate_prefixed_id("attemptId", scope.attempt_id, "attempt_")?;
    validate_prefixed_id(
        "frozenProviderInputId",
        scope.frozen_provider_input_id,
        "provider_input_",
    )?;
    if let Some(project_id) = scope.project_id {
        validate_prefixed_id("projectId", project_id, "project_")?;
    }
    if scope.draft_ids.is_empty() {
        return Err(NativeError::new(
            "attachment_provenance_conflict",
            "A bridge admission must contain at least one bound attachment draft",
        ));
    }

    // `generations` is intentionally profile-agnostic in the current schema;
    // profile ownership is established through the linked provider and then
    // rechecked through every immutable receipt below.
    let first_attempt_exists: bool = transaction.query_row(
        "SELECT EXISTS (
             SELECT 1
             FROM run_attempts attempt
             JOIN generations run ON run.id = attempt.generation_id
             JOIN messages assistant_message ON assistant_message.id = run.assistant_message_id
             JOIN frozen_provider_inputs frozen
               ON frozen.attempt_id = attempt.id AND frozen.run_id = run.id
             JOIN provider_profiles provider ON provider.id = run.provider_profile_id
             WHERE attempt.id = ?1 AND attempt.generation_id = ?2
               AND attempt.ordinal = 1 AND run.conversation_id = ?3
               AND run.branch_id = ?4
               AND assistant_message.parent_message_id = ?5
               AND provider.profile_id = ?6 AND provider.deleted_at_ms IS NULL
               AND frozen.id = ?7
         )",
        params![
            scope.attempt_id,
            scope.run_id,
            scope.conversation_id,
            scope.branch_id,
            scope.message_id,
            scope.profile_id,
            scope.frozen_provider_input_id,
        ],
        |row| row.get(0),
    )?;
    if !first_attempt_exists {
        return Err(provenance_conflict(
            "The target first attempt and frozen input do not match the prepared run lineage",
        ));
    }

    let mut sources = Vec::new();
    let mut seen_drafts = HashSet::new();
    let mut seen_attachments = HashSet::new();
    for draft_id in scope.draft_ids {
        validate_prefixed_id("attachmentDraftId", draft_id, "attachment_draft_")?;
        if !seen_drafts.insert(draft_id.as_str()) {
            return Err(provenance_conflict(
                "The manifest request contains a duplicate attachment draft",
            ));
        }

        let draft: Option<(
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
        )> = transaction
            .query_row(
                "SELECT profile_id, project_id, conversation_id, branch_id, state,
                        binding_key, bound_message_id, bound_run_id
                 FROM attachment_drafts
                 WHERE id = ?1",
                [draft_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            draft_profile_id,
            draft_project_id,
            draft_conversation_id,
            draft_branch_id,
            draft_state,
            draft_binding_key,
            draft_bound_message_id,
            draft_bound_run_id,
        )) = draft
        else {
            return Err(provenance_conflict(
                "A selected attachment draft disappeared before source-manifest reconstruction",
            ));
        };
        if draft_profile_id != scope.profile_id
            || draft_project_id.as_deref() != scope.project_id
            || draft_conversation_id.as_deref() != Some(scope.conversation_id)
            || draft_branch_id.as_deref() != Some(scope.branch_id)
            || draft_state != "bound"
            || draft_bound_message_id.as_deref() != Some(scope.message_id)
            || draft_bound_run_id.as_deref() != Some(scope.run_id)
        {
            return Err(provenance_conflict(
                "A selected attachment draft does not match the immutable target scope",
            ));
        }
        let Some(draft_binding_key) = draft_binding_key else {
            return Err(provenance_conflict(
                "A bound attachment draft is missing its native binding key",
            ));
        };
        let expected_binding_key = native_attachment_binding_key(
            draft_id,
            scope.message_id,
            scope.run_id,
            scope.attempt_id,
            scope.project_id,
            scope.conversation_id,
            scope.branch_id,
        )?;
        if draft_binding_key != expected_binding_key {
            return Err(provenance_conflict(
                "A bound attachment draft does not match the canonical native binding key",
            ));
        }

        let mut statement = transaction.prepare(
            "SELECT
                receipt.attachment_id, receipt.binding_key, receipt.attachment_blob_id,
                receipt.profile_id, receipt.project_id, receipt.conversation_id,
                receipt.branch_id, receipt.message_id, receipt.run_id,
                attachment.profile_id, attachment.draft_id, attachment.message_id,
                attachment.project_id, attachment.blob_id, attachment.media_type,
                attachment.byte_size, attachment.deleted_at_ms,
                blob.id, blob.media_type, blob.plaintext_size
             FROM attachment_binding_receipts receipt
             JOIN attachments attachment ON attachment.id = receipt.attachment_id
             JOIN blob_objects blob ON blob.id = receipt.attachment_blob_id
             WHERE receipt.draft_id = ?1 AND receipt.profile_id = ?2
             ORDER BY receipt.attachment_id ASC, receipt.binding_key ASC",
        )?;
        let rows = statement
            .query_map(params![draft_id, scope.profile_id], |row| {
                Ok(BoundAttachmentSourceRow {
                    draft_id: draft_id.clone(),
                    attachment_id: row.get(0)?,
                    binding_key: row.get(1)?,
                    receipt_blob_id: row.get(2)?,
                    receipt_profile_id: row.get(3)?,
                    receipt_project_id: row.get(4)?,
                    receipt_conversation_id: row.get(5)?,
                    receipt_branch_id: row.get(6)?,
                    receipt_message_id: row.get(7)?,
                    receipt_run_id: row.get(8)?,
                    attachment_profile_id: row.get(9)?,
                    attachment_draft_id: row.get(10)?,
                    attachment_message_id: row.get(11)?,
                    attachment_project_id: row.get(12)?,
                    attachment_blob_id: row.get(13)?,
                    attachment_media_type: row.get(14)?,
                    attachment_byte_size: row.get(15)?,
                    attachment_deleted_at_ms: row.get(16)?,
                    blob_id: row.get(17)?,
                    blob_media_type: row.get(18)?,
                    blob_plaintext_size: row.get(19)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if rows.is_empty() {
            return Err(provenance_conflict(
                "A bound attachment draft has no immutable binding receipts",
            ));
        }
        for source in rows {
            if !seen_attachments.insert(source.attachment_id.clone()) {
                return Err(provenance_conflict(
                    "An attachment appears in more than one immutable binding receipt",
                ));
            }
            if source.binding_key != draft_binding_key
                || source.receipt_profile_id != scope.profile_id
                || source.receipt_project_id.as_deref() != scope.project_id
                || source.receipt_conversation_id != scope.conversation_id
                || source.receipt_branch_id != scope.branch_id
                || source.receipt_message_id != scope.message_id
                || source.receipt_run_id != scope.run_id
                || source.attachment_profile_id != scope.profile_id
                || source.attachment_draft_id.is_some()
                || source.attachment_message_id.as_deref() != Some(scope.message_id)
                || source.attachment_project_id.is_some()
                || source.attachment_deleted_at_ms.is_some()
                || source.receipt_blob_id != source.attachment_blob_id
                || source.receipt_blob_id != source.blob_id
                || source.attachment_byte_size != source.blob_plaintext_size
                || source.attachment_media_type != source.blob_media_type
                || source.attachment_byte_size < 0
            {
                return Err(provenance_conflict(
                    "A receipt, message-owned attachment, or canonical blob no longer agrees",
                ));
            }
            if validate_sha256("attachmentBlobId", &source.blob_id).is_err()
                || !is_canonical_media_type(&source.blob_media_type)
            {
                return Err(provenance_conflict(
                    "A bound attachment blob does not have canonical manifest metadata",
                ));
            }
            sources.push(source);
        }
    }

    sources.sort_by(|left, right| {
        left.attachment_id
            .cmp(&right.attachment_id)
            .then_with(|| left.binding_key.cmp(&right.binding_key))
            .then_with(|| left.draft_id.cmp(&right.draft_id))
    });
    let artifacts = sources
        .iter()
        .map(|source| {
            let modality = modality_for_media_type(&source.blob_media_type)?;
            Ok(PersistBridgeArtifact {
                attachment_id: source.attachment_id.clone(),
                source_sha256: source.blob_id.clone(),
                source_selector: "region:full".to_owned(),
                modality: modality.to_owned(),
                media_type: source.blob_media_type.clone(),
                byte_size: source.blob_plaintext_size,
            })
        })
        .collect::<NativeResult<Vec<_>>>()?;
    let hash_artifacts = sources
        .iter()
        .zip(artifacts.iter())
        .map(|(source, artifact)| BoundAttachmentManifestHashArtifact {
            binding_key: source.binding_key.clone(),
            attachment_id: artifact.attachment_id.clone(),
            source_sha256: artifact.source_sha256.clone(),
            source_selector: artifact.source_selector.clone(),
            modality: artifact.modality.clone(),
            media_type: artifact.media_type.clone(),
            byte_size: artifact.byte_size,
        })
        .collect::<Vec<_>>();
    let source_manifest_sha256 = hash_json(&BoundAttachmentManifestHashMaterial {
        schema_version: 1,
        profile_id: scope.profile_id,
        project_id: scope.project_id,
        conversation_id: scope.conversation_id,
        branch_id: scope.branch_id,
        run_id: scope.run_id,
        attempt_id: scope.attempt_id,
        frozen_provider_input_id: scope.frozen_provider_input_id,
        message_id: scope.message_id,
        artifacts: &hash_artifacts,
    })?;
    Ok(BoundAttachmentManifest {
        source_manifest_sha256,
        artifacts,
    })
}

/// Creates a non-dispatchable planning record for the current native-only
/// checkpoint. The text-only gateway cannot produce a direct/native carrier,
/// so this function never resolves to an approved-provider mode and never
/// claims upload, provider acceptance, or cost.
pub(crate) fn plan_prepared_native_admission(
    intent: &BridgeAdmissionIntent,
    authority: &NativeBridgeAdmissionAuthority,
    manifest: &BoundAttachmentManifest,
    run_id: &str,
    attempt_id: &str,
    frozen_provider_input_id: &str,
    created_at_ms: i64,
) -> NativeResult<(PersistMultimodalBridgePlan, AppendBridgeStageReceipt)> {
    validate_prefixed_id("runId", run_id, "run_")?;
    validate_prefixed_id("attemptId", attempt_id, "attempt_")?;
    validate_prefixed_id(
        "frozenProviderInputId",
        frozen_provider_input_id,
        "provider_input_",
    )?;
    if created_at_ms <= 0 {
        return Err(NativeError::invalid("createdAtMs", "must be positive"));
    }
    if manifest.artifacts.is_empty() {
        return Err(NativeError::new(
            "attachment_provenance_conflict",
            "A bridge plan cannot be created without a reconstructed source manifest",
        ));
    }
    validate_sha256("sourceManifestSha256", &manifest.source_manifest_sha256)?;
    validate_opaque_id(
        "capabilitySnapshotRevisionId",
        &authority.capability_snapshot_revision_id,
    )?;
    validate_opaque_id("policyRevisionId", &authority.policy_revision_id)?;

    let route = match intent.requested_mode() {
        "unsupported" => PreparedAdmissionRoute::ExplicitUnsupported,
        "human-review" | "manual" => PreparedAdmissionRoute::HumanReview,
        "direct-native"
        | "direct-only"
        | "specialist-bridge-model"
        | "hybrid-ensemble"
        | "surrogate-to-primary" => PreparedAdmissionRoute::RequestedRouteUnavailable,
        "auto" | "local-transform" | "local-only" | "cheapest" | "highest-quality" => {
            PreparedAdmissionRoute::LocalTransformBlocked
        }
        _ => {
            return Err(NativeError::invalid(
                "bridgeRequestedMode",
                "contains an unsupported planning preference",
            ));
        }
    };
    let (
        resolved_mode,
        disposition,
        data_boundary,
        egress_decision,
        selected_reason_codes,
        rejected_alternatives,
        fidelity_profile,
        fidelity_disposition,
        stage_status,
        stage_boundary,
    ) = match route {
        PreparedAdmissionRoute::LocalTransformBlocked => (
            "local-transform",
            "blocked",
            "local-only",
            "not-required",
            vec![
                "local-transform-planning-only".to_owned(),
                "text-only-gateway-no-carrier".to_owned(),
            ],
            vec![BridgeRejectedAlternative {
                mode: "direct-native".to_owned(),
                reason_codes: vec!["provider-carrier-not-wired".to_owned()],
            }],
            "unknown",
            "blocked",
            "planned",
            "local-only",
        ),
        PreparedAdmissionRoute::HumanReview => (
            "human-review",
            "review-required",
            "review-required",
            "review-required",
            vec!["manual-or-human-review-requested".to_owned()],
            vec![BridgeRejectedAlternative {
                mode: "local-transform".to_owned(),
                reason_codes: vec!["explicit-review-preference".to_owned()],
            }],
            "unknown",
            "review-required",
            "planned",
            "human-review",
        ),
        PreparedAdmissionRoute::RequestedRouteUnavailable => (
            "unsupported",
            "unsupported",
            "denied",
            "denied",
            vec!["requested-route-unavailable-at-planning-checkpoint".to_owned()],
            vec![BridgeRejectedAlternative {
                mode: intent.requested_mode().to_owned(),
                reason_codes: vec!["provider-or-specialist-carrier-not-wired".to_owned()],
            }],
            "unknown",
            "unsupported",
            "unsupported",
            "local-only",
        ),
        PreparedAdmissionRoute::ExplicitUnsupported => (
            "unsupported",
            "unsupported",
            "denied",
            "denied",
            vec!["explicit-unsupported-request".to_owned()],
            Vec::new(),
            "unknown",
            "unsupported",
            "unsupported",
            "local-only",
        ),
    };
    let plan_id = format!("bridge_plan_{}", Uuid::new_v4().simple());
    let plan = PersistMultimodalBridgePlan {
        id: plan_id.clone(),
        run_id: run_id.to_owned(),
        attempt_id: attempt_id.to_owned(),
        frozen_provider_input_id: Some(frozen_provider_input_id.to_owned()),
        supersedes_plan_id: None,
        requested_mode: intent.requested_mode().to_owned(),
        resolved_mode: resolved_mode.to_owned(),
        disposition: disposition.to_owned(),
        source_manifest_sha256: manifest.source_manifest_sha256.clone(),
        capability_snapshot_revision_id: authority.capability_snapshot_revision_id.clone(),
        policy_revision_id: authority.policy_revision_id.clone(),
        data_boundary: data_boundary.to_owned(),
        egress_decision: egress_decision.to_owned(),
        selected_reason_codes,
        rejected_alternatives,
        decisive_fidelity_dimensions: vec!["provenance".to_owned(), "content".to_owned()],
        fidelity_profile: fidelity_profile.to_owned(),
        artifacts: manifest.artifacts.clone(),
        created_at_ms,
    };
    let receipt = AppendBridgeStageReceipt {
        id: format!("bridge_stage_receipt_{}", Uuid::new_v4().simple()),
        plan_id,
        stage_id: "admit:local-planning-v1".to_owned(),
        attempt_no: 1,
        stage_kind: "admit".to_owned(),
        status: stage_status.to_owned(),
        boundary: stage_boundary.to_owned(),
        output_manifest_sha256: None,
        provider_acceptance: "not-applicable".to_owned(),
        reconciliation_status: "not-required".to_owned(),
        derivative_sha256: Vec::new(),
        fidelity_disposition: fidelity_disposition.to_owned(),
        started_at_ms: created_at_ms,
        completed_at_ms: None,
        created_at_ms,
    };
    Ok((plan, receipt))
}

/// Native static mapping revision 1. Unknown canonical MIME values fail closed
/// rather than creating a durable modality that could be mistaken for a
/// trusted classification. The caller owns the admission transaction, so this
/// error rolls back message/run/attempt/frozen-input and bridge side effects.
fn modality_for_media_type(media_type: &str) -> NativeResult<&'static str> {
    let modality = match media_type {
        "application/pdf" => "pdf",
        "application/msword"
        | "application/rtf"
        | "application/vnd.oasis.opendocument.text"
        | "application/vnd.oasis.opendocument.presentation"
        | "application/vnd.ms-powerpoint"
        | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        | "text/html"
        | "text/markdown"
        | "text/plain"
        | "text/rtf" => "document",
        "application/vnd.ms-excel"
        | "application/vnd.oasis.opendocument.spreadsheet"
        | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        | "text/csv"
        | "text/tab-separated-values" => "spreadsheet",
        "application/gzip"
        | "application/vnd.rar"
        | "application/x-7z-compressed"
        | "application/x-rar-compressed"
        | "application/x-tar"
        | "application/zip" => "archive",
        "application/javascript"
        | "application/sql"
        | "application/typescript"
        | "application/x-httpd-php"
        | "application/x-sh"
        | "text/css"
        | "text/javascript"
        | "text/x-c"
        | "text/x-c++"
        | "text/x-csharp"
        | "text/x-go"
        | "text/x-java-source"
        | "text/x-python"
        | "text/x-rust"
        | "text/x-sql" => "code",
        "application/x-hdf5" | "application/x-netcdf" | "chemical/x-pdb" => "scientific-artifact",
        value if value.starts_with("image/") => "image",
        value if value.starts_with("audio/") => "audio",
        value if value.starts_with("video/") => "video",
        "application/json"
        | "application/ld+json"
        | "application/xml"
        | "application/yaml"
        | "application/x-yaml"
        | "text/xml"
        | "text/yaml" => "structured-data",
        _ => {
            return Err(NativeError::new(
                "attachment_media_type_unclassified",
                "The canonical attachment media type is not mapped to a trusted native modality",
            ));
        }
    };
    Ok(modality)
}

fn is_canonical_media_type(value: &str) -> bool {
    validate_media_type(value).is_ok() && value == value.to_ascii_lowercase()
}

fn provenance_conflict(message: &'static str) -> NativeError {
    NativeError::new("attachment_provenance_conflict", message)
}

fn validate_plan(input: &PersistMultimodalBridgePlan) -> NativeResult<()> {
    validate_prefixed_id("planId", &input.id, "bridge_plan_")?;
    validate_prefixed_id("runId", &input.run_id, "run_")?;
    validate_prefixed_id("attemptId", &input.attempt_id, "attempt_")?;
    if let Some(value) = &input.frozen_provider_input_id {
        validate_prefixed_id("frozenProviderInputId", value, "provider_input_")?;
    }
    if let Some(value) = &input.supersedes_plan_id {
        validate_prefixed_id("supersedesPlanId", value, "bridge_plan_")?;
        if value == &input.id {
            return Err(NativeError::invalid(
                "supersedesPlanId",
                "cannot reference the same bridge plan",
            ));
        }
    }
    validate_enum("requestedMode", &input.requested_mode, REQUESTED_MODES)?;
    validate_enum("resolvedMode", &input.resolved_mode, RESOLVED_MODES)?;
    validate_enum("disposition", &input.disposition, DISPOSITIONS)?;
    validate_sha256("sourceManifestSha256", &input.source_manifest_sha256)?;
    validate_opaque_id(
        "capabilitySnapshotRevisionId",
        &input.capability_snapshot_revision_id,
    )?;
    validate_opaque_id("policyRevisionId", &input.policy_revision_id)?;
    validate_enum("dataBoundary", &input.data_boundary, DATA_BOUNDARIES)?;
    validate_enum("egressDecision", &input.egress_decision, EGRESS_DECISIONS)?;
    validate_enum(
        "fidelityProfile",
        &input.fidelity_profile,
        FIDELITY_PROFILES,
    )?;
    if PROVIDER_MODES.contains(&input.resolved_mode.as_str()) && input.egress_decision != "approved"
    {
        return Err(NativeError::new(
            "bridge_egress_not_approved",
            "A provider bridge route requires an approved egress decision",
        ));
    }
    if input.resolved_mode == "unsupported"
        && !matches!(
            input.disposition.as_str(),
            "unsupported" | "blocked" | "review-required"
        )
    {
        return Err(NativeError::invalid(
            "disposition",
            "does not truthfully match an unsupported bridge route",
        ));
    }
    validate_unique_opaque_list(
        "selectedReasonCodes",
        &input.selected_reason_codes,
        1,
        MAX_REASON_CODES,
    )?;
    if input.rejected_alternatives.len() > MAX_REJECTED_ALTERNATIVES {
        return Err(NativeError::invalid(
            "rejectedAlternatives",
            "exceeds the bounded candidate set",
        ));
    }
    let mut rejected_modes = HashSet::new();
    for alternative in &input.rejected_alternatives {
        validate_enum(
            "rejectedAlternative.mode",
            &alternative.mode,
            RESOLVED_MODES,
        )?;
        if !rejected_modes.insert(alternative.mode.as_str()) {
            return Err(NativeError::invalid(
                "rejectedAlternatives",
                "contains a duplicate mode",
            ));
        }
        validate_unique_opaque_list(
            "rejectedAlternative.reasonCodes",
            &alternative.reason_codes,
            1,
            MAX_REASON_CODES,
        )?;
    }
    validate_unique_enum_list(
        "decisiveFidelityDimensions",
        &input.decisive_fidelity_dimensions,
        FIDELITY_DIMENSIONS,
    )?;
    if input.artifacts.is_empty() {
        return Err(NativeError::invalid(
            "artifacts",
            "must contain at least one frozen attachment",
        ));
    }
    let mut attachment_ids = HashSet::new();
    for artifact in &input.artifacts {
        validate_prefixed_id("attachmentId", &artifact.attachment_id, "attachment_")?;
        if !attachment_ids.insert(artifact.attachment_id.as_str()) {
            return Err(NativeError::invalid(
                "artifacts",
                "contains a duplicate attachment",
            ));
        }
        validate_sha256("artifact.sourceSha256", &artifact.source_sha256)?;
        validate_selector(&artifact.source_selector)?;
        validate_enum("artifact.modality", &artifact.modality, ARTIFACT_MODALITIES)?;
        validate_media_type(&artifact.media_type)?;
        if artifact.byte_size < 0 {
            return Err(NativeError::invalid(
                "artifact.byteSize",
                "must be non-negative",
            ));
        }
    }
    if input.created_at_ms <= 0 {
        return Err(NativeError::invalid("createdAtMs", "must be positive"));
    }
    Ok(())
}

fn validate_stage_receipt(input: &AppendBridgeStageReceipt) -> NativeResult<()> {
    validate_prefixed_id("receiptId", &input.id, "bridge_stage_receipt_")?;
    validate_prefixed_id("planId", &input.plan_id, "bridge_plan_")?;
    validate_opaque_id("stageId", &input.stage_id)?;
    if input.attempt_no < 1 {
        return Err(NativeError::invalid("attemptNo", "must be at least one"));
    }
    validate_enum("stageKind", &input.stage_kind, STAGE_KINDS)?;
    validate_enum("status", &input.status, STAGE_STATUSES)?;
    validate_enum("boundary", &input.boundary, STAGE_BOUNDARIES)?;
    validate_enum(
        "providerAcceptance",
        &input.provider_acceptance,
        PROVIDER_ACCEPTANCE,
    )?;
    validate_enum(
        "reconciliationStatus",
        &input.reconciliation_status,
        RECONCILIATION_STATUSES,
    )?;
    validate_enum(
        "fidelityDisposition",
        &input.fidelity_disposition,
        STAGE_FIDELITY_DISPOSITIONS,
    )?;
    if let Some(value) = &input.output_manifest_sha256 {
        validate_sha256("outputManifestSha256", value)?;
    }
    validate_unique_hash_list(&input.derivative_sha256)?;
    if input.boundary != "approved-provider" && input.provider_acceptance != "not-applicable" {
        return Err(NativeError::invalid(
            "providerAcceptance",
            "must be not-applicable outside a provider boundary",
        ));
    }
    if matches!(
        input.status.as_str(),
        "outcome-unknown" | "reconcile-required"
    ) {
        if !matches!(input.reconciliation_status.as_str(), "pending" | "blocked") {
            return Err(NativeError::invalid(
                "reconciliationStatus",
                "must remain pending or blocked for an unknown outcome",
            ));
        }
        if input.status == "outcome-unknown"
            && !matches!(input.provider_acceptance.as_str(), "accepted" | "unknown")
        {
            return Err(NativeError::invalid(
                "providerAcceptance",
                "cannot deny acceptance for an outcome-unknown stage",
            ));
        }
    }
    if input.status == "completed"
        && (input.completed_at_ms.is_none() || input.output_manifest_sha256.is_none())
    {
        return Err(NativeError::invalid(
            "status",
            "completed requires completion time and output manifest hash",
        ));
    }
    if input.started_at_ms <= 0
        || input.created_at_ms < input.started_at_ms
        || input
            .completed_at_ms
            .is_some_and(|completed| completed < input.started_at_ms)
    {
        return Err(NativeError::invalid(
            "timestamps",
            "do not form a valid monotonic stage interval",
        ));
    }
    Ok(())
}

/// The native bridge is planning-only at this checkpoint. A generic internal
/// caller may persist local or human-review evidence, but it may not create a
/// provider-bound receipt or provider-acceptance fact before a real carrier,
/// fresh egress evaluation, provider idempotency, durable acceptance evidence,
/// and reconciliation machinery exist.
fn validate_stage_receipt_for_plan(
    _plan: &MultimodalBridgePlanRecord,
    input: &AppendBridgeStageReceipt,
) -> NativeResult<()> {
    if input.boundary == "approved-provider" {
        return Err(NativeError::new(
            "bridge_provider_stage_unavailable",
            "Provider-bound multimodal stages are unavailable at the planning-only checkpoint",
        ));
    }
    if input.provider_acceptance != "not-applicable" {
        return Err(NativeError::new(
            "bridge_provider_acceptance_unavailable",
            "A planning-only multimodal bridge receipt cannot claim provider acceptance",
        ));
    }
    Ok(())
}

fn validate_unique_hash_list(values: &[String]) -> NativeResult<()> {
    if values.len() > MAX_DERIVATIVE_HASHES {
        return Err(NativeError::invalid(
            "derivativeSha256",
            "exceeds the bounded derivative list",
        ));
    }
    let mut seen = HashSet::new();
    for value in values {
        validate_sha256("derivativeSha256", value)?;
        if !seen.insert(value.as_str()) {
            return Err(NativeError::invalid(
                "derivativeSha256",
                "contains a duplicate hash",
            ));
        }
    }
    Ok(())
}

fn validate_unique_opaque_list(
    field: &'static str,
    values: &[String],
    minimum: usize,
    maximum: usize,
) -> NativeResult<()> {
    if values.len() < minimum || values.len() > maximum {
        return Err(NativeError::invalid(field, "has an invalid bounded length"));
    }
    let mut seen = HashSet::new();
    for value in values {
        validate_opaque_id(field, value)?;
        if !seen.insert(value.as_str()) {
            return Err(NativeError::invalid(field, "contains a duplicate value"));
        }
    }
    Ok(())
}

fn validate_unique_enum_list(
    field: &'static str,
    values: &[String],
    allowed: &[&str],
) -> NativeResult<()> {
    if values.is_empty() || values.len() > allowed.len() {
        return Err(NativeError::invalid(field, "has an invalid bounded length"));
    }
    let mut seen = HashSet::new();
    for value in values {
        validate_enum(field, value, allowed)?;
        if !seen.insert(value.as_str()) {
            return Err(NativeError::invalid(field, "contains a duplicate value"));
        }
    }
    Ok(())
}

fn validate_prefixed_id(field: &'static str, value: &str, prefix: &str) -> NativeResult<()> {
    validate_opaque_id(field, value)?;
    if !value.starts_with(prefix) || value.len() <= prefix.len() {
        return Err(NativeError::invalid(field, "has an invalid entity prefix"));
    }
    Ok(())
}

fn validate_opaque_id(field: &'static str, value: &str) -> NativeResult<()> {
    if value.is_empty()
        || value.len() > MAX_OPAQUE_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
    {
        return Err(NativeError::invalid(
            field,
            "must be a bounded opaque identifier without a URL or path",
        ));
    }
    Ok(())
}

fn validate_sha256(field: &'static str, value: &str) -> NativeResult<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(NativeError::invalid(
            field,
            "must be a lowercase SHA-256 digest",
        ));
    }
    Ok(())
}

fn validate_selector(value: &str) -> NativeResult<()> {
    if value.is_empty()
        || value.len() > MAX_SELECTOR_BYTES
        || value
            .chars()
            .any(|character| character.is_control() || is_bidi_override(character))
    {
        return Err(NativeError::invalid(
            "sourceSelector",
            "must use the bounded canonical native coordinate grammar",
        ));
    }
    if value == "full" {
        return Ok(());
    }
    for segment in value.split('/') {
        let Some((kind, payload)) = segment.split_once(':') else {
            return Err(NativeError::invalid(
                "sourceSelector",
                "must use a canonical typed coordinate segment",
            ));
        };
        if !SOURCE_SELECTOR_KINDS.contains(&kind)
            || payload.is_empty()
            || !payload.bytes().all(is_selector_payload_byte)
            || !payload.bytes().any(|byte| byte.is_ascii_alphanumeric())
        {
            return Err(NativeError::invalid(
                "sourceSelector",
                "contains an unsupported native coordinate segment",
            ));
        }
    }
    Ok(())
}

fn validate_media_type(value: &str) -> NativeResult<()> {
    let mut parts = value.split('/');
    let category = parts.next().unwrap_or_default();
    let subtype = parts.next().unwrap_or_default();
    if value.is_empty()
        || value.len() > 255
        || parts.next().is_some()
        || !is_media_type_token(category)
        || !is_media_type_token(subtype)
    {
        return Err(NativeError::invalid(
            "mediaType",
            "must be a canonical MIME type without parameters",
        ));
    }
    Ok(())
}

fn is_bidi_override(character: char) -> bool {
    matches!(
        character,
        '\u{202A}'
            ..='\u{202E}'
                | '\u{2066}'
                    ..='\u{2069}'
    )
}

fn is_selector_payload_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'.' | b'_'
                | b'~'
                | b':'
                | b'@'
                | b'='
                | b','
                | b'+'
                | b';'
                | b'('
                | b')'
                | b'['
                | b']'
                | b'{'
                | b'}'
                | b'%'
                | b'-'
        )
}

fn is_media_type_token(value: &str) -> bool {
    value
        .bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(
                    byte,
                    b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
                )
        })
}

fn validate_enum(field: &'static str, value: &str, allowed: &[&str]) -> NativeResult<()> {
    if !allowed.contains(&value) {
        return Err(NativeError::invalid(field, "contains an unsupported value"));
    }
    Ok(())
}

fn serialize_bounded<T: Serialize>(
    value: &T,
    maximum_bytes: usize,
    label: &'static str,
) -> NativeResult<String> {
    let serialized = serde_json::to_string(value).map_err(|_| {
        NativeError::new(
            "bridge_receipt_serialization_failed",
            format!("The {label} could not be serialized"),
        )
    })?;
    if serialized.len() > maximum_bytes {
        return Err(NativeError::new(
            "bridge_receipt_too_large",
            format!("The {label} exceeds the native receipt limit"),
        ));
    }
    Ok(serialized)
}

fn hash_json<T: Serialize>(value: &T) -> NativeResult<String> {
    let bytes = serde_json::to_vec(value).map_err(|_| {
        NativeError::new(
            "bridge_receipt_serialization_failed",
            "The immutable bridge receipt could not be hashed",
        )
    })?;
    Ok(sha256_hex(bytes))
}

fn load_bridge_state(
    connection: &rusqlite::Connection,
    plan_id: &str,
) -> NativeResult<MultimodalBridgeStateRecord> {
    let plan = load_plan(connection, plan_id)?;
    let mut artifacts_statement = connection.prepare(
        "SELECT plan_id, ordinal, attachment_id, source_sha256,
                source_selector, modality, media_type, byte_size, created_at_ms
         FROM multimodal_bridge_plan_artifacts
         WHERE plan_id = ?1
         ORDER BY ordinal",
    )?;
    let artifacts = artifacts_statement
        .query_map([plan_id], bridge_artifact_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let mut receipts_statement = connection.prepare(
        "SELECT id, schema_version, plan_id, stage_id, attempt_no, stage_kind,
                status, boundary, source_manifest_sha256,
                output_manifest_sha256, capability_snapshot_revision_id,
                policy_revision_id, provider_acceptance,
                reconciliation_status, derivative_sha256_json,
                fidelity_disposition, receipt_sha256, started_at_ms,
                completed_at_ms, created_at_ms
         FROM multimodal_bridge_stage_receipts
         WHERE plan_id = ?1
         ORDER BY stage_id, attempt_no, created_at_ms, id",
    )?;
    let stage_receipts = receipts_statement
        .query_map([plan_id], bridge_stage_receipt_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(MultimodalBridgeStateRecord {
        plan,
        artifacts,
        stage_receipts,
    })
}

fn load_plan(
    connection: &rusqlite::Connection,
    plan_id: &str,
) -> NativeResult<MultimodalBridgePlanRecord> {
    connection
        .query_row(
            "SELECT id, schema_version, contract_revision, run_id, attempt_id,
                    frozen_provider_input_id, supersedes_plan_id,
                    requested_mode, resolved_mode, disposition,
                    source_manifest_sha256, capability_snapshot_revision_id,
                    policy_revision_id, data_boundary, egress_decision,
                    selected_reason_codes_json, rejected_alternatives_json,
                    decisive_fidelity_dimensions_json, fidelity_profile,
                    plan_sha256, created_at_ms
             FROM multimodal_bridge_plans
             WHERE id = ?1 AND profile_id = ?2",
            params![plan_id, DEFAULT_PROFILE_ID],
            bridge_plan_from_row,
        )
        .optional()?
        .ok_or_else(|| {
            NativeError::new(
                "bridge_plan_not_found",
                "The multimodal bridge plan does not exist",
            )
        })
}

fn load_stage_receipt(
    connection: &rusqlite::Connection,
    receipt_id: &str,
) -> NativeResult<MultimodalBridgeStageReceiptRecord> {
    connection
        .query_row(
            "SELECT id, schema_version, plan_id, stage_id, attempt_no, stage_kind,
                    status, boundary, source_manifest_sha256,
                    output_manifest_sha256, capability_snapshot_revision_id,
                    policy_revision_id, provider_acceptance,
                    reconciliation_status, derivative_sha256_json,
                    fidelity_disposition, receipt_sha256, started_at_ms,
                    completed_at_ms, created_at_ms
             FROM multimodal_bridge_stage_receipts
             WHERE id = ?1",
            [receipt_id],
            bridge_stage_receipt_from_row,
        )
        .optional()?
        .ok_or_else(|| {
            NativeError::new(
                "bridge_stage_receipt_not_found",
                "The multimodal bridge stage receipt does not exist",
            )
        })
}

fn bridge_plan_from_row(row: &Row<'_>) -> rusqlite::Result<MultimodalBridgePlanRecord> {
    Ok(MultimodalBridgePlanRecord {
        id: row.get(0)?,
        schema_version: row.get(1)?,
        contract_revision: row.get(2)?,
        run_id: row.get(3)?,
        attempt_id: row.get(4)?,
        frozen_provider_input_id: row.get(5)?,
        supersedes_plan_id: row.get(6)?,
        requested_mode: row.get(7)?,
        resolved_mode: row.get(8)?,
        disposition: row.get(9)?,
        source_manifest_sha256: row.get(10)?,
        capability_snapshot_revision_id: row.get(11)?,
        policy_revision_id: row.get(12)?,
        data_boundary: row.get(13)?,
        egress_decision: row.get(14)?,
        selected_reason_codes: parse_json_column(row, 15)?,
        rejected_alternatives: parse_json_column(row, 16)?,
        decisive_fidelity_dimensions: parse_json_column(row, 17)?,
        fidelity_profile: row.get(18)?,
        plan_sha256: row.get(19)?,
        created_at_ms: row.get(20)?,
    })
}

fn bridge_artifact_from_row(row: &Row<'_>) -> rusqlite::Result<MultimodalBridgeArtifactRecord> {
    Ok(MultimodalBridgeArtifactRecord {
        plan_id: row.get(0)?,
        ordinal: row.get(1)?,
        attachment_id: row.get(2)?,
        source_sha256: row.get(3)?,
        source_selector: row.get(4)?,
        modality: row.get(5)?,
        media_type: row.get(6)?,
        byte_size: row.get(7)?,
        created_at_ms: row.get(8)?,
    })
}

fn bridge_stage_receipt_from_row(
    row: &Row<'_>,
) -> rusqlite::Result<MultimodalBridgeStageReceiptRecord> {
    Ok(MultimodalBridgeStageReceiptRecord {
        id: row.get(0)?,
        schema_version: row.get(1)?,
        plan_id: row.get(2)?,
        stage_id: row.get(3)?,
        attempt_no: row.get(4)?,
        stage_kind: row.get(5)?,
        status: row.get(6)?,
        boundary: row.get(7)?,
        source_manifest_sha256: row.get(8)?,
        output_manifest_sha256: row.get(9)?,
        capability_snapshot_revision_id: row.get(10)?,
        policy_revision_id: row.get(11)?,
        provider_acceptance: row.get(12)?,
        reconciliation_status: row.get(13)?,
        derivative_sha256: parse_json_column(row, 14)?,
        fidelity_disposition: row.get(15)?,
        receipt_sha256: row.get(16)?,
        started_at_ms: row.get(17)?,
        completed_at_ms: row.get(18)?,
        created_at_ms: row.get(19)?,
    })
}

fn parse_json_column<T: for<'de> Deserialize<'de>>(
    row: &Row<'_>,
    index: usize,
) -> rusqlite::Result<T> {
    let value: String = row.get(index)?;
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_786_742_400_000;

    fn digest(character: char) -> String {
        character.to_string().repeat(64)
    }

    fn seed_scope(storage: &Storage) {
        let binding_key = native_attachment_binding_key(
            "attachment_draft_bridge_test",
            "message_bridge_user",
            "run_bridge_test",
            "attempt_bridge_test",
            None,
            "conversation_bridge_test",
            "branch_bridge_test",
        )
        .expect("bridge test binding key should derive");
        storage
            .with_transaction(|transaction| {
                transaction.execute(
                    "INSERT INTO provider_profiles (
                        id, profile_id, provider_type, display_name,
                        normalized_base_url, auth_scheme, created_at_ms,
                        updated_at_ms
                     ) VALUES (
                        'provider_bridge_test', ?1, 'openai', 'Bridge test',
                        'https://example.invalid', 'none', ?2, ?2
                     )",
                    params![DEFAULT_PROFILE_ID, NOW],
                )?;
                transaction.execute(
                    "INSERT INTO conversations (
                        id, profile_id, title, created_at_ms, updated_at_ms
                     ) VALUES ('conversation_bridge_test', ?1, 'Bridge', ?2, ?2)",
                    params![DEFAULT_PROFILE_ID, NOW],
                )?;
                transaction.execute(
                    "INSERT INTO conversation_branches (
                        id, conversation_id, created_at_ms
                     ) VALUES ('branch_bridge_test', 'conversation_bridge_test', ?1)",
                    [NOW],
                )?;
                transaction.execute(
                    "UPDATE conversations
                     SET active_branch_id = 'branch_bridge_test'
                     WHERE id = 'conversation_bridge_test'",
                    [],
                )?;
                transaction.execute(
                    "INSERT INTO messages (
                        id, conversation_id, branch_id, role, status, sequence_no,
                        content_json, content_text, created_at_ms, updated_at_ms,
                        finalized_at_ms
                     ) VALUES (
                        'message_bridge_user', 'conversation_bridge_test',
                        'branch_bridge_test', 'user', 'complete', 0,
                        '[]', 'Inspect the image', ?1, ?1, ?1
                     )",
                    [NOW],
                )?;
                transaction.execute(
                    "INSERT INTO messages (
                        id, conversation_id, branch_id, parent_message_id, role,
                        status, sequence_no, content_json, content_text,
                        provider_profile_id, model_id, created_at_ms, updated_at_ms
                     ) VALUES (
                        'message_bridge_assistant', 'conversation_bridge_test',
                        'branch_bridge_test', 'message_bridge_user', 'assistant',
                        'draft', 1, '[]', '', 'provider_bridge_test',
                        'model-bridge-test', ?1, ?1
                     )",
                    [NOW],
                )?;
                transaction.execute(
                    "INSERT INTO generations (
                        id, conversation_id, branch_id, assistant_message_id,
                        provider_profile_id, model_id, state,
                        request_parameters_json, created_at_ms
                     ) VALUES (
                        'run_bridge_test', 'conversation_bridge_test',
                        'branch_bridge_test', 'message_bridge_assistant',
                        'provider_bridge_test', 'model-bridge-test', 'queued',
                        '{}', ?1
                     )",
                    [NOW],
                )?;
                transaction.execute(
                    "INSERT INTO run_attempts (
                        id, generation_id, ordinal, provider_profile_id, model_id,
                        state, created_at_ms
                     ) VALUES (
                        'attempt_bridge_test', 'run_bridge_test', 1,
                        'provider_bridge_test', 'model-bridge-test', 'created', ?1
                     )",
                    [NOW],
                )?;
                // Binding an attachment draft requires an undispatched frozen
                // provider input for the run's first attempt (schema guard
                // `attachment draft binding lineage is not dispatchable`).
                transaction.execute(
                    "INSERT INTO frozen_provider_inputs (
                        id, schema_version, attempt_id, run_id,
                        provider_profile_id, model_id, messages_json,
                        parameters_json, content_sha256, created_at_ms
                     ) VALUES (
                        'frozen_input_bridge_test', 1, 'attempt_bridge_test',
                        'run_bridge_test', 'provider_bridge_test',
                        'model-bridge-test', '[]', '{}', ?1, ?2
                     )",
                    params![digest('b'), NOW],
                )?;
                let source_hash = digest('a');
                transaction.execute(
                    "INSERT INTO blob_objects (
                        id, cipher_version, key_version, wrapped_dek, nonce,
                        media_type, plaintext_size, ciphertext_size,
                        storage_relpath, created_at_ms
                     ) VALUES (
                        ?1, 1, 1, X'01', X'000000000000000000000000',
                        'image/png', 4096, 4112, 'v1/aa/bridge-test', ?2
                     )",
                    params![source_hash, NOW],
                )?;
                transaction.execute(
                    "INSERT INTO attachment_drafts (
                        id, profile_id, conversation_id, branch_id, state,
                        expires_at_ms, created_at_ms, updated_at_ms, metadata_json
                     ) VALUES (
                        'attachment_draft_bridge_test', ?1,
                        'conversation_bridge_test', 'branch_bridge_test', 'open',
                        ?2, ?3, ?3, '{}'
                     )",
                    params![DEFAULT_PROFILE_ID, NOW + 60_000, NOW],
                )?;
                transaction.execute(
                    "INSERT INTO attachments (
                        id, profile_id, draft_id, blob_id, filename, media_type,
                        byte_size, extraction_status, created_at_ms
                     ) VALUES (
                        'attachment_bridge_test', ?1, 'attachment_draft_bridge_test', ?2,
                        'diagram.png', 'image/png', 4096, 'complete', ?3
                     )",
                    params![DEFAULT_PROFILE_ID, digest('a'), NOW],
                )?;
                transaction.execute(
                    "UPDATE attachment_drafts
                     SET state = 'bound', binding_key = ?1,
                         bound_message_id = 'message_bridge_user',
                         bound_run_id = 'run_bridge_test', bound_at_ms = ?2,
                         updated_at_ms = ?2
                     WHERE id = 'attachment_draft_bridge_test'",
                    params![binding_key, NOW],
                )?;
                transaction.execute(
                    "UPDATE attachments
                     SET draft_id = NULL, message_id = 'message_bridge_user'
                     WHERE id = 'attachment_bridge_test'",
                    [],
                )?;
                Ok(())
            })
            .expect("bridge test scope should seed");
    }

    fn plan() -> PersistMultimodalBridgePlan {
        PersistMultimodalBridgePlan {
            id: "bridge_plan_test".to_owned(),
            run_id: "run_bridge_test".to_owned(),
            attempt_id: "attempt_bridge_test".to_owned(),
            frozen_provider_input_id: None,
            supersedes_plan_id: None,
            requested_mode: "auto".to_owned(),
            resolved_mode: "local-transform".to_owned(),
            disposition: "ready".to_owned(),
            source_manifest_sha256: digest('b'),
            capability_snapshot_revision_id: "capability-snapshot-1".to_owned(),
            policy_revision_id: "policy-1".to_owned(),
            data_boundary: "local-only".to_owned(),
            egress_decision: "not-required".to_owned(),
            selected_reason_codes: vec!["local-transform-approved".to_owned()],
            rejected_alternatives: vec![BridgeRejectedAlternative {
                mode: "direct-native".to_owned(),
                reason_codes: vec!["native-capability-missing".to_owned()],
            }],
            decisive_fidelity_dimensions: vec!["content".to_owned(), "provenance".to_owned()],
            fidelity_profile: "semantic-and-visual".to_owned(),
            artifacts: vec![PersistBridgeArtifact {
                attachment_id: "attachment_bridge_test".to_owned(),
                source_sha256: digest('a'),
                source_selector: "region:page=1;x=0;y=0;width=640;height=480".to_owned(),
                modality: "image".to_owned(),
                media_type: "image/png".to_owned(),
                byte_size: 4096,
            }],
            created_at_ms: NOW,
        }
    }

    fn planning_manifest() -> BoundAttachmentManifest {
        BoundAttachmentManifest {
            source_manifest_sha256: digest('f'),
            artifacts: vec![PersistBridgeArtifact {
                attachment_id: "attachment_planning_test".to_owned(),
                source_sha256: digest('e'),
                source_selector: "page:7/region:x=0;y=0;width=100;height=100".to_owned(),
                modality: "pdf".to_owned(),
                media_type: "application/pdf".to_owned(),
                byte_size: 1024,
            }],
        }
    }

    #[test]
    fn bridge_plan_and_stage_receipts_are_immutable_and_provenance_bound() {
        let storage = Storage::in_memory().expect("storage should initialize");
        seed_scope(&storage);
        let state = storage
            .persist_multimodal_bridge_plan(plan())
            .expect("bridge plan should persist");
        assert_eq!(state.plan.resolved_mode, "local-transform");
        assert_eq!(state.artifacts.len(), 1);
        assert_eq!(state.artifacts[0].source_sha256, digest('a'));
        assert_eq!(state.plan.plan_sha256.len(), 64);

        let receipt = storage
            .append_multimodal_bridge_stage_receipt(AppendBridgeStageReceipt {
                id: "bridge_stage_receipt_test".to_owned(),
                plan_id: state.plan.id.clone(),
                stage_id: "stage-local-transform".to_owned(),
                attempt_no: 1,
                stage_kind: "local-transform".to_owned(),
                status: "completed".to_owned(),
                boundary: "local-only".to_owned(),
                output_manifest_sha256: Some(digest('c')),
                provider_acceptance: "not-applicable".to_owned(),
                reconciliation_status: "not-required".to_owned(),
                derivative_sha256: vec![digest('d')],
                fidelity_disposition: "ready".to_owned(),
                started_at_ms: NOW + 1,
                completed_at_ms: Some(NOW + 2),
                created_at_ms: NOW + 2,
            })
            .expect("stage receipt should persist");
        assert_eq!(receipt.source_manifest_sha256, digest('b'));
        assert_eq!(receipt.receipt_sha256.len(), 64);

        let provider_stage_error = storage
            .append_multimodal_bridge_stage_receipt(AppendBridgeStageReceipt {
                id: "bridge_stage_receipt_provider_blocked".to_owned(),
                plan_id: state.plan.id.clone(),
                stage_id: "stage-provider-deliver".to_owned(),
                attempt_no: 1,
                stage_kind: "primary-deliver".to_owned(),
                status: "planned".to_owned(),
                boundary: "approved-provider".to_owned(),
                output_manifest_sha256: None,
                provider_acceptance: "not-applicable".to_owned(),
                reconciliation_status: "not-required".to_owned(),
                derivative_sha256: Vec::new(),
                fidelity_disposition: "planned".to_owned(),
                started_at_ms: NOW + 3,
                completed_at_ms: None,
                created_at_ms: NOW + 3,
            })
            .expect_err("the planning-only checkpoint must reject provider stages");
        assert_eq!(
            provider_stage_error.code,
            "bridge_provider_stage_unavailable"
        );

        let loaded = storage
            .read_multimodal_bridge_state(&state.plan.id)
            .expect("bridge state should load");
        assert_eq!(loaded.stage_receipts.len(), 1);

        let update_error = storage
            .with_transaction(|transaction| {
                transaction.execute(
                    "UPDATE multimodal_bridge_plans SET disposition = 'failed' WHERE id = ?1",
                    [&state.plan.id],
                )?;
                Ok(())
            })
            .expect_err("immutable bridge plan must reject updates");
        assert_eq!(update_error.code, "storage_failed");
    }

    #[test]
    fn bridge_plan_rejects_paths_unapproved_egress_and_unknown_replay() {
        let mut unsafe_plan = plan();
        unsafe_plan.artifacts[0].source_selector = r"C:\Users\alice\secret.png".to_owned();
        assert_eq!(
            validate_plan(&unsafe_plan)
                .expect_err("filesystem selectors must fail")
                .code,
            "invalid_input"
        );

        let mut unapproved = plan();
        unapproved.resolved_mode = "direct-native".to_owned();
        assert_eq!(
            validate_plan(&unapproved)
                .expect_err("provider egress must be approved")
                .code,
            "bridge_egress_not_approved"
        );

        let invalid_receipt = AppendBridgeStageReceipt {
            id: "bridge_stage_receipt_unknown".to_owned(),
            plan_id: "bridge_plan_test".to_owned(),
            stage_id: "stage-primary-deliver".to_owned(),
            attempt_no: 1,
            stage_kind: "primary-deliver".to_owned(),
            status: "outcome-unknown".to_owned(),
            boundary: "approved-provider".to_owned(),
            output_manifest_sha256: None,
            provider_acceptance: "not-accepted".to_owned(),
            reconciliation_status: "not-required".to_owned(),
            derivative_sha256: Vec::new(),
            fidelity_disposition: "processing".to_owned(),
            started_at_ms: NOW,
            completed_at_ms: None,
            created_at_ms: NOW,
        };
        assert_eq!(
            validate_stage_receipt(&invalid_receipt)
                .expect_err("unknown outcome must require reconciliation")
                .code,
            "invalid_input"
        );
    }

    #[test]
    fn selector_mime_and_modality_registry_are_canonical_and_fail_closed() {
        for selector in [
            "full",
            "region:full",
            "page:7",
            "page:7/region:x=0;y=0;width=100;height=100",
            "sheet:Sheet%201/cell:A1",
            "range:A1:B9",
            "slide:2",
            "frame:120",
            "time:00:00:01-00:00:05",
            "byte:0-4095",
            "symbol:crate::module::Type",
            "member:field_name",
        ] {
            validate_selector(selector).expect("canonical native selector should validate");
        }
        for selector in [
            "file:/C:/Users/khang/private.pdf",
            "file:C:/Users/khang/private.pdf",
            "https:private.example/secret",
            "data:text/plain,secret",
            "blob:opaque",
            "../secret",
            r"\\server\share\private.pdf",
            "/var/private.pdf",
            r"page:7\private.pdf",
            "page:7\nregion:full",
        ] {
            assert_eq!(
                validate_selector(selector)
                    .expect_err("non-coordinate selectors must fail closed")
                    .code,
                "invalid_input"
            );
        }

        for media_type in [
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "text/x-rust",
            "application/sql",
        ] {
            validate_media_type(media_type).expect("canonical MIME should validate");
        }
        for media_type in [
            "IMAGE/PNG",
            "application/",
            "/json",
            "application/json/extra",
            "application//json",
            "application/json; charset=utf-8",
            "application /json",
        ] {
            assert_eq!(
                validate_media_type(media_type)
                    .expect_err("non-canonical MIME must fail closed")
                    .code,
                "invalid_input"
            );
        }

        for (media_type, modality) in [
            ("text/x-rust", "code"),
            ("application/sql", "code"),
            ("text/x-go", "code"),
            ("text/x-csharp", "code"),
            ("application/x-httpd-php", "code"),
            ("application/vnd.rar", "archive"),
            ("application/x-rar-compressed", "archive"),
            ("application/vnd.ms-powerpoint", "document"),
            (
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                "document",
            ),
            (
                "application/vnd.oasis.opendocument.presentation",
                "document",
            ),
            ("application/json", "structured-data"),
            ("application/x-hdf5", "scientific-artifact"),
        ] {
            assert_eq!(
                modality_for_media_type(media_type).expect("mapped MIME should classify"),
                modality
            );
        }
        let error = modality_for_media_type("application/octet-stream")
            .expect_err("unknown canonical MIME must fail closed");
        assert_eq!(error.code, "attachment_media_type_unclassified");
    }

    #[test]
    fn planning_only_route_respects_explicit_preferences_without_silent_fallback() {
        let authority = NativeBridgeAdmissionAuthority::default();
        let manifest = planning_manifest();
        for (requested, resolved, disposition, boundary) in [
            ("auto", "local-transform", "blocked", "local-only"),
            (
                "local-transform",
                "local-transform",
                "blocked",
                "local-only",
            ),
            ("local-only", "local-transform", "blocked", "local-only"),
            ("cheapest", "local-transform", "blocked", "local-only"),
            (
                "highest-quality",
                "local-transform",
                "blocked",
                "local-only",
            ),
            (
                "human-review",
                "human-review",
                "review-required",
                "human-review",
            ),
            ("manual", "human-review", "review-required", "human-review"),
            ("direct-native", "unsupported", "unsupported", "local-only"),
            ("direct-only", "unsupported", "unsupported", "local-only"),
            (
                "specialist-bridge-model",
                "unsupported",
                "unsupported",
                "local-only",
            ),
            (
                "hybrid-ensemble",
                "unsupported",
                "unsupported",
                "local-only",
            ),
            (
                "surrogate-to-primary",
                "unsupported",
                "unsupported",
                "local-only",
            ),
            ("unsupported", "unsupported", "unsupported", "local-only"),
        ] {
            let intent =
                BridgeAdmissionIntent::from_renderer_requested_mode(Some(requested.to_owned()))
                    .expect("canonical requested mode should parse");
            let (plan, receipt) = plan_prepared_native_admission(
                &intent,
                &authority,
                &manifest,
                "run_planning_route_test",
                "attempt_planning_route_test",
                "provider_input_planning_route_test",
                NOW,
            )
            .expect("planning-only route should resolve truthfully");
            assert_eq!(plan.requested_mode, requested);
            assert_eq!(plan.resolved_mode, resolved);
            assert_eq!(plan.disposition, disposition);
            assert_eq!(receipt.boundary, boundary);
            assert_eq!(receipt.provider_acceptance, "not-applicable");
            if matches!(
                requested,
                "direct-native"
                    | "direct-only"
                    | "specialist-bridge-model"
                    | "hybrid-ensemble"
                    | "surrogate-to-primary"
            ) {
                assert_ne!(plan.resolved_mode, "local-transform");
            }
        }
    }
}
