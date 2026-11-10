import {
  MULTIMODAL_BRIDGE_MODES,
  MULTIMODAL_BRIDGE_REQUEST_MODES,
  bridgeModalityForMediaType,
  type BridgeArtifactModality,
  type BridgeDataBoundary,
  type BridgeDisposition,
  type BridgeEgressDecision,
  type BridgeFidelityDimension,
  type BridgeFidelityProfile,
  type BridgeReasonCode,
  type BridgeStageKind,
  type MultimodalBridgeMode,
  type MultimodalBridgeRequestMode,
} from "@/domain/multimodal-bridge";

/**
 * Renderer-safe raw DTOs for the durable bridge state owned by the native
 * kernel. These types deliberately exclude source bytes, paths, filenames,
 * provider handles, credentials, prompts, and arbitrary provider payloads.
 *
 * The native admission seam is not connected yet. Keeping this boundary
 * explicit lets the renderer render only facts that native storage has
 * persisted, rather than inferring a route from generic model badges.
 */
export interface NativeMultimodalBridgePlanRecord {
  readonly id: string;
  readonly schemaVersion: number;
  readonly contractRevision: number;
  readonly runId: string;
  readonly attemptId: string;
  readonly frozenProviderInputId: string | null;
  readonly supersedesPlanId: string | null;
  readonly requestedMode: string;
  readonly resolvedMode: string;
  readonly disposition: string;
  readonly sourceManifestSha256: string;
  readonly capabilitySnapshotRevisionId: string;
  readonly policyRevisionId: string;
  readonly dataBoundary: string;
  readonly egressDecision: string;
  readonly selectedReasonCodes: readonly string[];
  readonly rejectedAlternatives: readonly NativeBridgeRejectedAlternative[];
  readonly decisiveFidelityDimensions: readonly string[];
  readonly fidelityProfile: string;
  readonly planSha256: string;
  readonly createdAtMs: number;
}

export interface NativeBridgeRejectedAlternative {
  readonly mode: string;
  readonly reasonCodes: readonly string[];
}

export interface NativeMultimodalBridgeArtifactRecord {
  readonly planId: string;
  readonly ordinal: number;
  readonly attachmentId: string;
  readonly sourceSha256: string;
  readonly sourceSelector: string;
  readonly modality: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly createdAtMs: number;
}

export interface NativeMultimodalBridgeStageReceiptRecord {
  readonly id: string;
  readonly schemaVersion: number;
  readonly planId: string;
  readonly stageId: string;
  readonly attemptNo: number;
  readonly stageKind: string;
  readonly status: string;
  readonly boundary: string;
  readonly sourceManifestSha256: string;
  readonly outputManifestSha256: string | null;
  readonly capabilitySnapshotRevisionId: string;
  readonly policyRevisionId: string;
  readonly providerAcceptance: string;
  readonly reconciliationStatus: string;
  readonly derivativeSha256: readonly string[];
  readonly fidelityDisposition: string;
  readonly receiptSha256: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly createdAtMs: number;
}

export interface NativeMultimodalBridgeState {
  readonly plan: NativeMultimodalBridgePlanRecord;
  readonly artifacts: readonly NativeMultimodalBridgeArtifactRecord[];
  readonly stageReceipts: readonly NativeMultimodalBridgeStageReceiptRecord[];
}

export type BridgeCapabilityFreshnessProjection =
  | "live-probe"
  | "cached-fresh"
  | "cached-stale"
  | "manual"
  | "unknown"
  | "not-observed";

export type BridgeStageStatus =
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "outcome-unknown"
  | "reconcile-required"
  | "unsupported";

export type BridgeStageBoundary =
  | "local-only"
  | "approved-provider"
  | "human-review";

export type BridgeProviderAcceptance =
  | "not-applicable"
  | "not-accepted"
  | "accepted"
  | "unknown";

export type BridgeReconciliationStatus =
  | "not-required"
  | "pending"
  | "reconciled"
  | "blocked"
  | "failed";

export type BridgeStageFidelityDisposition =
  | "planned"
  | "processing"
  | "ready"
  | "ready-with-degradation"
  | "review-required"
  | "blocked"
  | "failed"
  | "unsupported";

export interface BridgeArtifactProjection {
  readonly ordinal: number;
  readonly attachmentId: string;
  readonly sourceSha256: string;
  /** A typed page/cell/slide/frame/time selector. Never a filesystem path. */
  readonly sourceSelector: string;
  readonly modality: BridgeArtifactModality;
  readonly mediaType: string;
  readonly byteSize: number;
}

export interface BridgeRejectedAlternativeProjection {
  readonly mode: MultimodalBridgeMode;
  readonly reasonCodes: readonly BridgeReasonCode[];
}

export interface BridgeStageReceiptProjection {
  readonly receiptId: string;
  readonly stageId: string;
  readonly attemptNo: number;
  readonly stageKind: BridgeStageKind;
  readonly status: BridgeStageStatus;
  readonly boundary: BridgeStageBoundary;
  readonly sourceManifestSha256: string;
  readonly outputManifestSha256: string | null;
  readonly providerAcceptance: BridgeProviderAcceptance;
  readonly reconciliationStatus: BridgeReconciliationStatus;
  readonly derivativeSha256: readonly string[];
  readonly fidelityDisposition: BridgeStageFidelityDisposition;
  readonly receiptSha256: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly createdAtMs: number;
}

/**
 * Shared presentation projection for composer, run inspector, background
 * work, notifications and accessible announcements. It contains facts and
 * evidence identifiers only; it is intentionally not a route planner or
 * provider request shape.
 */
export interface MultimodalBridgePlanProjection {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly planSha256: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly frozenProviderInputId: string | null;
  readonly supersedesPlanId: string | null;
  readonly requestedMode: MultimodalBridgeRequestMode;
  /** Never `auto`: native resolves it before persisting a bridge plan. */
  readonly resolvedMode: MultimodalBridgeMode;
  readonly disposition: BridgeDisposition;
  readonly sourceManifestSha256: string;
  readonly capabilitySnapshotRevisionId: string;
  /** Native v9 retains a snapshot revision but not freshness yet. */
  readonly capabilityFreshness: BridgeCapabilityFreshnessProjection;
  readonly policyRevisionId: string;
  readonly dataBoundary: BridgeDataBoundary;
  readonly egressDecision: BridgeEgressDecision;
  readonly selectedReasonCodes: readonly BridgeReasonCode[];
  readonly rejectedAlternatives: readonly BridgeRejectedAlternativeProjection[];
  readonly decisiveFidelityDimensions: readonly BridgeFidelityDimension[];
  readonly fidelityProfile: BridgeFidelityProfile;
  readonly artifacts: readonly BridgeArtifactProjection[];
  readonly stageReceipts: readonly BridgeStageReceiptProjection[];
  /** Derived only from durable provider-boundary stage receipts. */
  readonly providerAcceptance: BridgeProviderAcceptance | "not-observed";
  /** True only when the newest receipt per stage requires reconciliation. */
  readonly reconciliationRequired: boolean;
  readonly createdAtMs: number;
}

export type BridgePresentationTone =
  | "neutral"
  | "progress"
  | "info"
  | "warning"
  | "danger";

export interface BridgeCompactStatus {
  readonly label: string;
  readonly detail: string;
  readonly tone: BridgePresentationTone;
  readonly stageId: string | null;
}

export interface BridgeActionAvailability {
  readonly inspect: { readonly available: true; readonly reason: null };
  readonly continue: { readonly available: false; readonly reason: string };
  readonly retry: { readonly available: false; readonly reason: string };
  readonly reconcile: { readonly available: false; readonly reason: string };
}

export interface BridgeInspectorRow {
  readonly label: string;
  readonly value: string;
}

export interface BridgeInspectorSection {
  readonly id: "route" | "capability" | "artifacts" | "fidelity" | "execution" | "recovery";
  readonly label: string;
  readonly rows: readonly BridgeInspectorRow[];
}

/**
 * Compact receipt-derived timeline data for the inspector. This is grouped by
 * native stage ID so retries stay visible as attempts instead of looking like
 * duplicate stages. It is deliberately a timeline, not a renderer-owned DAG:
 * dependency edges and execution authority remain native facts.
 */
export interface BridgeStageTimelineEntry {
  readonly stageId: string;
  readonly stageKind: BridgeStageKind;
  readonly label: string;
  readonly attemptCount: number;
  readonly latestAttemptNo: number;
  readonly latestStatus: BridgeStageStatus;
  readonly latestBoundary: BridgeStageBoundary;
  readonly latestReconciliationStatus: BridgeReconciliationStatus;
  readonly latestProviderAcceptance: BridgeProviderAcceptance;
  readonly latestFidelityDisposition: BridgeStageFidelityDisposition;
  readonly latestReceiptId: string;
  readonly firstCreatedAtMs: number;
  readonly latestCreatedAtMs: number;
}

const DISPOSITIONS = [
  "ready",
  "ready-with-degradation",
  "review-required",
  "blocked",
  "failed",
  "unsupported",
] as const satisfies readonly BridgeDisposition[];

const DATA_BOUNDARIES = [
  "local-only",
  "approved-provider",
  "mixed",
  "denied",
  "review-required",
] as const satisfies readonly BridgeDataBoundary[];

const EGRESS_DECISIONS = [
  "not-required",
  "approved",
  "denied",
  "review-required",
] as const satisfies readonly BridgeEgressDecision[];

const ARTIFACT_MODALITIES = [
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
] as const satisfies readonly BridgeArtifactModality[];

const PROVIDER_BOUND_MODES = [
  "direct-native",
  "specialist-bridge-model",
  "hybrid-ensemble",
  "surrogate-to-primary",
] as const satisfies readonly MultimodalBridgeMode[];

const FIDELITY_DIMENSIONS = [
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
] as const satisfies readonly BridgeFidelityDimension[];

const FIDELITY_PROFILES = [
  "semantic-and-visual",
  "semantic-only",
  "render-required",
  "model-specific",
  "unknown",
] as const satisfies readonly BridgeFidelityProfile[];

const STAGE_KINDS = [
  "admit",
  "direct-deliver",
  "local-transform",
  "specialist-bridge",
  "hybrid-verify",
  "surrogate-package",
  "primary-deliver",
  "human-review",
] as const satisfies readonly BridgeStageKind[];

const STAGE_STATUSES = [
  "planned",
  "running",
  "completed",
  "failed",
  "cancelled",
  "outcome-unknown",
  "reconcile-required",
  "unsupported",
] as const satisfies readonly BridgeStageStatus[];

const STAGE_BOUNDARIES = [
  "local-only",
  "approved-provider",
  "human-review",
] as const satisfies readonly BridgeStageBoundary[];

const PROVIDER_ACCEPTANCE = [
  "not-applicable",
  "not-accepted",
  "accepted",
  "unknown",
] as const satisfies readonly BridgeProviderAcceptance[];

const RECONCILIATION_STATUSES = [
  "not-required",
  "pending",
  "reconciled",
  "blocked",
  "failed",
] as const satisfies readonly BridgeReconciliationStatus[];

const STAGE_FIDELITY_DISPOSITIONS = [
  "planned",
  "processing",
  "ready",
  "ready-with-degradation",
  "review-required",
  "blocked",
  "failed",
  "unsupported",
] as const satisfies readonly BridgeStageFidelityDisposition[];

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const CONTROL_OR_BIDI_PATTERN = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;
const SOURCE_SELECTOR_KINDS = new Set([
  "region",
  "page",
  "sheet",
  "cell",
  "range",
  "slide",
  "frame",
  "time",
  "byte",
  "symbol",
  "member",
]);
const SOURCE_SELECTOR_PAYLOAD_PATTERN = /^[A-Za-z0-9._~:@=,+;()[\]{}%-]+$/;

function assertion(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid renderer-safe bridge projection: ${message}`);
}

function enumValue<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  assertion(allowed.includes(value as T), `${label} is not a recognized canonical value.`);
  return value as T;
}

function opaqueId(value: string, label: string): string {
  assertion(OPAQUE_ID_PATTERN.test(value), `${label} must be an opaque identifier.`);
  return value;
}

function prefixedOpaqueId(value: string, prefix: string, label: string): string {
  const normalized = opaqueId(value, label);
  assertion(
    normalized.startsWith(prefix) && normalized.length > prefix.length,
    `${label} must have the native ${prefix} prefix.`,
  );
  return normalized;
}

function sha256(value: string, label: string): string {
  assertion(SHA256_PATTERN.test(value), `${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function timestamp(value: number, label: string): number {
  assertion(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer.`);
  return value;
}

function sourceSelector(value: string): string {
  assertion(value.length > 0 && value.length <= 512, "source selector has an invalid length.");
  assertion(!CONTROL_OR_BIDI_PATTERN.test(value), "source selector cannot contain control or bidirectional override characters.");
  if (value === "full") return value;
  for (const segment of value.split("/")) {
    const separator = segment.indexOf(":");
    const kind = separator < 0 ? "" : segment.slice(0, separator);
    const payload = separator < 0 ? "" : segment.slice(separator + 1);
    assertion(
      SOURCE_SELECTOR_KINDS.has(kind) &&
        payload.length > 0 &&
        SOURCE_SELECTOR_PAYLOAD_PATTERN.test(payload) &&
        /[A-Za-z0-9]/.test(payload),
      "source selector must use the canonical native coordinate grammar, not a filesystem path or URL.",
    );
  }
  return value;
}

function mediaType(value: string): string {
  assertion(
    value.length <= 255 && MEDIA_TYPE_PATTERN.test(value),
    "artifact media type must be canonical.",
  );
  return value;
}

function reasonCodes(values: readonly string[], label: string): readonly BridgeReasonCode[] {
  assertion(values.length > 0 && values.length <= 256, `${label} must be a bounded non-empty list.`);
  const normalized = values.map((value) => {
    assertion(OPAQUE_ID_PATTERN.test(value), `${label} must contain canonical reason codes.`);
    return value as BridgeReasonCode;
  });
  assertion(new Set(normalized).size === normalized.length, `${label} cannot contain duplicates.`);
  return Object.freeze(normalized);
}

function derivativeHashes(values: readonly string[]): readonly string[] {
  assertion(values.length <= 4096, "derivative hash list exceeds the renderer safety bound.");
  const normalized = values.map((value) => sha256(value, "derivative hash"));
  assertion(new Set(normalized).size === normalized.length, "derivative hash list cannot contain duplicates.");
  return Object.freeze(normalized);
}

function stageReceiptsInStableOrder(
  records: readonly BridgeStageReceiptProjection[],
): readonly BridgeStageReceiptProjection[] {
  return Object.freeze(
    [...records].sort(
      (left, right) =>
        left.createdAtMs - right.createdAtMs ||
        left.attemptNo - right.attemptNo ||
        left.receiptId.localeCompare(right.receiptId),
    ),
  );
}

/**
 * A retry number is the primary chronology within one native stage. Receipt
 * creation time and opaque ID make the ordering deterministic when a clock is
 * coarse or a replay records the same millisecond.
 */
function compareStageAttemptRecency(
  left: BridgeStageReceiptProjection,
  right: BridgeStageReceiptProjection,
): number {
  return (
    left.attemptNo - right.attemptNo ||
    left.createdAtMs - right.createdAtMs ||
    left.receiptId.localeCompare(right.receiptId)
  );
}

function newestReceiptPerStage(
  records: readonly BridgeStageReceiptProjection[],
): readonly BridgeStageReceiptProjection[] {
  const byStage = new Map<string, BridgeStageReceiptProjection>();
  for (const receipt of records) {
    const current = byStage.get(receipt.stageId);
    if (current === undefined || compareStageAttemptRecency(current, receipt) < 0) {
      byStage.set(receipt.stageId, receipt);
    }
  }
  return Object.freeze([...byStage.values()]);
}

function newestFirst(
  records: readonly BridgeStageReceiptProjection[],
): readonly BridgeStageReceiptProjection[] {
  return Object.freeze(
    [...records].sort(
      (left, right) =>
        right.createdAtMs - left.createdAtMs ||
        right.attemptNo - left.attemptNo ||
        right.receiptId.localeCompare(left.receiptId),
    ),
  );
}

function assertPlanRouteSemantics(
  resolvedMode: MultimodalBridgeMode,
  disposition: BridgeDisposition,
  dataBoundary: BridgeDataBoundary,
  egressDecision: BridgeEgressDecision,
): void {
  if ((PROVIDER_BOUND_MODES as readonly string[]).includes(resolvedMode)) {
    assertion(
      egressDecision === "approved",
      "a provider-bound bridge mode requires a durable approved egress decision.",
    );
    assertion(
      dataBoundary !== "denied" && dataBoundary !== "local-only",
      "a provider-bound bridge mode cannot claim a denied or local-only data boundary.",
    );
  }
  if (resolvedMode === "unsupported") {
    assertion(
      disposition === "unsupported" || disposition === "blocked" || disposition === "review-required",
      "an unsupported bridge mode has an incompatible disposition.",
    );
  }
}

function assertStageReceiptSemantics(receipt: BridgeStageReceiptProjection): void {
  if (receipt.boundary !== "approved-provider") {
    assertion(
      receipt.providerAcceptance === "not-applicable",
      "a non-provider stage cannot claim provider acceptance.",
    );
  }
  if (receipt.status === "outcome-unknown" || receipt.status === "reconcile-required") {
    assertion(
      receipt.reconciliationStatus === "pending" || receipt.reconciliationStatus === "blocked",
      "an unknown external outcome must remain pending or blocked for reconciliation.",
    );
  }
  if (receipt.status === "outcome-unknown") {
    assertion(
      receipt.providerAcceptance === "accepted" || receipt.providerAcceptance === "unknown",
      "an outcome-unknown stage cannot assert that provider acceptance did not occur.",
    );
  }
  if (receipt.status === "completed") {
    assertion(
      receipt.completedAtMs !== null && receipt.outputManifestSha256 !== null,
      "a completed stage requires a completion time and output manifest digest.",
    );
  }
}

/**
 * Converts the persisted native v9 bridge state into a renderer projection.
 * It intentionally copies only known fields, validates every identifier and
 * rejects filesystem/URL-shaped source selectors before React can render them.
 */
export function bridgePlanProjectionFromNativeState(
  state: NativeMultimodalBridgeState,
): MultimodalBridgePlanProjection {
  const { plan } = state;
  assertion(plan.schemaVersion === 1, "plan schema version is unsupported.");
  assertion(plan.contractRevision === 2, "bridge contract revision is unsupported.");
  const planId = prefixedOpaqueId(plan.id, "bridge_plan_", "plan ID");
  const planSha256 = sha256(plan.planSha256, "plan hash");
  const runId = prefixedOpaqueId(plan.runId, "run_", "run ID");
  const attemptId = prefixedOpaqueId(plan.attemptId, "attempt_", "attempt ID");
  const frozenProviderInputId =
    plan.frozenProviderInputId === null
      ? null
      : prefixedOpaqueId(plan.frozenProviderInputId, "provider_input_", "frozen provider input ID");
  const supersedesPlanId =
    plan.supersedesPlanId === null
      ? null
      : prefixedOpaqueId(plan.supersedesPlanId, "bridge_plan_", "superseding plan ID");
  assertion(supersedesPlanId !== planId, "a bridge plan cannot supersede itself.");
  const requestedMode = enumValue(
    plan.requestedMode,
    MULTIMODAL_BRIDGE_REQUEST_MODES,
    "requested bridge mode",
  );
  const resolvedMode = enumValue(
    plan.resolvedMode,
    MULTIMODAL_BRIDGE_MODES,
    "resolved bridge mode",
  );
  const disposition = enumValue(plan.disposition, DISPOSITIONS, "bridge disposition");
  const sourceManifestSha256 = sha256(plan.sourceManifestSha256, "source manifest hash");
  const capabilitySnapshotRevisionId = opaqueId(
    plan.capabilitySnapshotRevisionId,
    "capability snapshot revision ID",
  );
  const policyRevisionId = opaqueId(plan.policyRevisionId, "policy revision ID");
  const dataBoundary = enumValue(plan.dataBoundary, DATA_BOUNDARIES, "data boundary");
  const egressDecision = enumValue(plan.egressDecision, EGRESS_DECISIONS, "egress decision");
  assertPlanRouteSemantics(resolvedMode, disposition, dataBoundary, egressDecision);
  const selectedReasonCodes = reasonCodes(plan.selectedReasonCodes, "selected reason codes");
  assertion(
    plan.rejectedAlternatives.length <= 64,
    "rejected alternatives exceed the native projection bound.",
  );
  const rejectedAlternatives = Object.freeze(
    plan.rejectedAlternatives.map((alternative) =>
      Object.freeze({
        mode: enumValue(alternative.mode, MULTIMODAL_BRIDGE_MODES, "rejected bridge mode"),
        reasonCodes: reasonCodes(alternative.reasonCodes, "rejected reason codes"),
      }),
    ),
  );
  assertion(
    new Set(rejectedAlternatives.map((alternative) => alternative.mode)).size ===
      rejectedAlternatives.length,
    "rejected alternatives cannot contain duplicate modes.",
  );
  const decisiveFidelityDimensions = Object.freeze(
    plan.decisiveFidelityDimensions.map((dimension) =>
      enumValue(dimension, FIDELITY_DIMENSIONS, "decisive fidelity dimension"),
    ),
  );
  assertion(
    decisiveFidelityDimensions.length > 0 &&
      new Set(decisiveFidelityDimensions).size === decisiveFidelityDimensions.length,
    "decisive fidelity dimensions must be a non-empty unique set.",
  );
  const fidelityProfile = enumValue(plan.fidelityProfile, FIDELITY_PROFILES, "fidelity profile");
  const createdAtMs = timestamp(plan.createdAtMs, "plan created time");
  const artifacts = state.artifacts.map((artifact) => {
    assertion(artifact.planId === planId, "artifact plan ID must match its plan.");
    assertion(Number.isSafeInteger(artifact.ordinal) && artifact.ordinal >= 0, "artifact ordinal is invalid.");
    assertion(Number.isSafeInteger(artifact.byteSize) && artifact.byteSize >= 0, "artifact byte size is invalid.");
    timestamp(artifact.createdAtMs, "artifact created time");
    const normalizedMediaType = mediaType(artifact.mediaType);
    const trustedModality = bridgeModalityForMediaType(normalizedMediaType);
    assertion(
      trustedModality !== null,
      "artifact media type is not mapped to a trusted native modality.",
    );
    assertion(
      trustedModality === artifact.modality,
      "artifact modality does not match its canonical media type.",
    );
    return Object.freeze({
      ordinal: artifact.ordinal,
      attachmentId: prefixedOpaqueId(artifact.attachmentId, "attachment_", "attachment ID"),
      sourceSha256: sha256(artifact.sourceSha256, "artifact source hash"),
      sourceSelector: sourceSelector(artifact.sourceSelector),
      modality: enumValue(artifact.modality, ARTIFACT_MODALITIES, "artifact modality"),
      mediaType: normalizedMediaType,
      byteSize: artifact.byteSize,
    });
  });
  assertion(artifacts.length > 0, "bridge state requires at least one artifact.");
  assertion(
    new Set(artifacts.map((artifact) => artifact.attachmentId)).size === artifacts.length,
    "bridge state cannot contain duplicate attachment IDs.",
  );
  assertion(
    new Set(artifacts.map((artifact) => artifact.ordinal)).size === artifacts.length,
    "bridge state cannot contain duplicate artifact ordinals.",
  );
  const artifactsInOrdinalOrder = [...artifacts].sort((left, right) => left.ordinal - right.ordinal);
  assertion(
    artifactsInOrdinalOrder.every((artifact, ordinal) => artifact.ordinal === ordinal),
    "bridge state must contain a dense native artifact ordinal sequence.",
  );

  const stageReceipts = stageReceiptsInStableOrder(
    state.stageReceipts.map((receipt) => {
      assertion(receipt.schemaVersion === 1, "stage receipt schema version is unsupported.");
      assertion(receipt.planId === planId, "stage receipt plan ID must match its plan.");
      assertion(Number.isSafeInteger(receipt.attemptNo) && receipt.attemptNo >= 1, "stage attempt number is invalid.");
      const startedAtMs = timestamp(receipt.startedAtMs, "stage receipt start time");
      const completedAtMs = receipt.completedAtMs === null
        ? null
        : timestamp(receipt.completedAtMs, "stage receipt completion time");
      assertion(completedAtMs === null || completedAtMs >= startedAtMs, "stage receipt completion must not precede its start.");
      const createdAtMs = timestamp(receipt.createdAtMs, "stage receipt created time");
      assertion(createdAtMs >= startedAtMs, "stage receipt must not predate its start.");
      const receiptProjection = Object.freeze({
        receiptId: prefixedOpaqueId(receipt.id, "bridge_stage_receipt_", "stage receipt ID"),
        stageId: opaqueId(receipt.stageId, "stage ID"),
        attemptNo: receipt.attemptNo,
        stageKind: enumValue(receipt.stageKind, STAGE_KINDS, "stage kind"),
        status: enumValue(receipt.status, STAGE_STATUSES, "stage status"),
        boundary: enumValue(receipt.boundary, STAGE_BOUNDARIES, "stage boundary"),
        sourceManifestSha256: sha256(receipt.sourceManifestSha256, "stage source manifest hash"),
        outputManifestSha256:
          receipt.outputManifestSha256 === null
            ? null
            : sha256(receipt.outputManifestSha256, "stage output manifest hash"),
        providerAcceptance: enumValue(
          receipt.providerAcceptance,
          PROVIDER_ACCEPTANCE,
          "provider acceptance",
        ),
        reconciliationStatus: enumValue(
          receipt.reconciliationStatus,
          RECONCILIATION_STATUSES,
          "reconciliation status",
        ),
        derivativeSha256: derivativeHashes(receipt.derivativeSha256),
        fidelityDisposition: enumValue(
          receipt.fidelityDisposition,
          STAGE_FIDELITY_DISPOSITIONS,
          "stage fidelity disposition",
        ),
        receiptSha256: sha256(receipt.receiptSha256, "stage receipt hash"),
        startedAtMs,
        completedAtMs,
        createdAtMs,
      });
      assertion(
        receiptProjection.sourceManifestSha256 === sourceManifestSha256,
        "stage receipt source manifest must match the frozen plan.",
      );
      assertion(
        opaqueId(receipt.capabilitySnapshotRevisionId, "stage capability snapshot revision ID") ===
          capabilitySnapshotRevisionId,
        "stage receipt capability revision must match the frozen plan.",
      );
      assertion(
        opaqueId(receipt.policyRevisionId, "stage policy revision ID") === policyRevisionId,
        "stage receipt policy revision must match the frozen plan.",
      );
      assertStageReceiptSemantics(receiptProjection);
      return receiptProjection;
    }),
  );
  assertion(
    new Set(stageReceipts.map((receipt) => receipt.receiptId)).size === stageReceipts.length,
    "bridge state cannot contain duplicate stage receipt IDs.",
  );

  const latestStages = newestReceiptPerStage(stageReceipts);
  const providerStages = newestFirst(
    latestStages.filter((receipt) => receipt.boundary === "approved-provider"),
  );
  const providerAcceptance =
    providerStages.find((receipt) => receipt.providerAcceptance !== "not-applicable")
      ?.providerAcceptance ?? "not-observed";
  const reconciliationRequired = latestStages.some(
    (receipt) =>
      receipt.status === "outcome-unknown" ||
      receipt.status === "reconcile-required" ||
      receipt.reconciliationStatus === "pending" ||
      receipt.reconciliationStatus === "blocked",
  );

  return Object.freeze({
    schemaVersion: 1,
    planId,
    planSha256,
    runId,
    attemptId,
    frozenProviderInputId,
    supersedesPlanId,
    requestedMode,
    resolvedMode,
    disposition,
    sourceManifestSha256,
    capabilitySnapshotRevisionId,
    // v9 persistence intentionally has no freshness value. Do not treat the
    // revision ID as evidence that the capability snapshot is current.
    capabilityFreshness: "not-observed",
    policyRevisionId,
    dataBoundary,
    egressDecision,
    selectedReasonCodes,
    rejectedAlternatives,
    decisiveFidelityDimensions,
    fidelityProfile,
    artifacts: Object.freeze(artifactsInOrdinalOrder),
    stageReceipts,
    providerAcceptance,
    reconciliationRequired,
    createdAtMs,
  });
}

function latestRelevantStage(
  projection: MultimodalBridgePlanProjection,
): BridgeStageReceiptProjection | null {
  const latestStages = newestFirst(newestReceiptPerStage(projection.stageReceipts));
  return (
    latestStages.find(
      (receipt) =>
        receipt.status === "outcome-unknown" ||
        receipt.status === "reconcile-required" ||
        receipt.reconciliationStatus === "pending" ||
        receipt.reconciliationStatus === "blocked",
    ) ??
    latestStages.find((receipt) => receipt.status === "running") ??
    latestStages.find((receipt) => receipt.status === "failed") ??
    latestStages.find((receipt) => receipt.status === "unsupported") ??
    latestStages[0] ??
    null
  );
}

function stageLabel(stage: BridgeStageKind): string {
  switch (stage) {
    case "admit":
      return "Admitting source";
    case "direct-deliver":
      return "Delivering native input";
    case "local-transform":
      return "Transforming locally";
    case "specialist-bridge":
      return "Running specialist bridge";
    case "hybrid-verify":
      return "Verifying bridge output";
    case "surrogate-package":
      return "Packaging source-grounded surrogate";
    case "primary-deliver":
      return "Delivering to primary model";
    case "human-review":
      return "Awaiting human review";
  }
}

export function bridgeStageTimeline(
  projection: MultimodalBridgePlanProjection,
): readonly BridgeStageTimelineEntry[] {
  const grouped = new Map<string, BridgeStageReceiptProjection[]>();
  for (const receipt of projection.stageReceipts) {
    const records = grouped.get(receipt.stageId);
    if (records) {
      records.push(receipt);
    } else {
      grouped.set(receipt.stageId, [receipt]);
    }
  }

  return Object.freeze(
    [...grouped.entries()]
      .map(([stageId, records]) => {
        const ordered = [...records].sort(compareStageAttemptRecency);
        const latest = ordered[ordered.length - 1]!;
        return Object.freeze({
          stageId,
          stageKind: latest.stageKind,
          label: stageLabel(latest.stageKind),
          attemptCount: ordered.length,
          latestAttemptNo: latest.attemptNo,
          latestStatus: latest.status,
          latestBoundary: latest.boundary,
          latestReconciliationStatus: latest.reconciliationStatus,
          latestProviderAcceptance: latest.providerAcceptance,
          latestFidelityDisposition: latest.fidelityDisposition,
          latestReceiptId: latest.receiptId,
          firstCreatedAtMs: ordered[0]!.createdAtMs,
          latestCreatedAtMs: latest.createdAtMs,
        });
      })
      .sort(
        (left, right) =>
          left.firstCreatedAtMs - right.firstCreatedAtMs ||
          left.stageId.localeCompare(right.stageId),
      ),
  );
}

/**
 * Maps only durable plan/receipt facts to compact UI copy. In particular,
 * `ready` means the plan is ready, not that any provider accepted a file.
 */
export function bridgeBadgeFromPlan(
  projection: MultimodalBridgePlanProjection,
): BridgeCompactStatus {
  const stage = latestRelevantStage(projection);
  if (
    projection.reconciliationRequired ||
    stage?.status === "outcome-unknown" ||
    stage?.status === "reconcile-required"
  ) {
    return {
      label: "Outcome unknown — reconciling",
      detail: "A bridge stage may have crossed an external boundary. Blind retry remains disabled until native reconciliation records an outcome.",
      tone: "warning",
      stageId: stage?.stageId ?? null,
    };
  }
  if (stage?.status === "running") {
    return {
      label:
        stage.boundary === "approved-provider"
          ? "Sending through approved bridge"
          : stageLabel(stage.stageKind),
      detail:
        stage.boundary === "approved-provider"
          ? "Provider acceptance is reported only after a durable provider-stage receipt arrives."
          : "This is a durable bridge-stage receipt; source bytes remain outside the renderer.",
      tone: "progress",
      stageId: stage.stageId,
    };
  }
  if (stage?.status === "failed") {
    return {
      label: "Bridge failed",
      detail: "A native bridge-stage receipt records failure. The available recovery action depends on the next native classification.",
      tone: "danger",
      stageId: stage.stageId,
    };
  }
  if (stage?.status === "cancelled") {
    return {
      label: "Bridge stage cancelled",
      detail: "The latest bridge stage was cancelled. The frozen plan does not imply that a later stage or provider dispatch occurred.",
      tone: "warning",
      stageId: stage.stageId,
    };
  }
  if (stage?.status === "unsupported" || projection.disposition === "unsupported") {
    return {
      label: "Unsupported for current route",
      detail: "No supported or authorized bridge route is being represented as native input.",
      tone: "warning",
      stageId: stage?.stageId ?? null,
    };
  }
  if (projection.disposition === "review-required") {
    return {
      label: "Review required",
      detail: "A fidelity, policy, or capability ambiguity requires explicit review before an external stage can proceed.",
      tone: "warning",
      stageId: stage?.stageId ?? null,
    };
  }
  if (projection.disposition === "blocked") {
    return {
      label: "Blocked by policy or authority",
      detail: "The frozen bridge plan does not authorize a dispatch. Inspect policy and selected route reasons for the constraint.",
      tone: "danger",
      stageId: stage?.stageId ?? null,
    };
  }
  if (projection.disposition === "failed") {
    return {
      label: "Bridge plan failed",
      detail: "The durable plan is marked failed. This does not imply a provider received the source artifact.",
      tone: "danger",
      stageId: stage?.stageId ?? null,
    };
  }
  if (projection.disposition === "ready-with-degradation") {
    return {
      label: "Ready with disclosed limits",
      detail: "The route has a visible fidelity disclosure. Provider acceptance remains not observed until a provider-stage receipt exists.",
      tone: "warning",
      stageId: stage?.stageId ?? null,
    };
  }
  if (stage?.status === "completed") {
    return {
      label: "Bridge stage recorded",
      detail: "A stage completed, but completed receipts do not prove that later stages or provider acceptance occurred.",
      tone: "info",
      stageId: stage.stageId,
    };
  }
  return {
    label: "Bridge ready",
    detail: "The route decision is frozen. No provider acceptance is implied until a provider-stage receipt records it.",
    tone: "info",
    stageId: null,
  };
}

/**
 * Exposes truthful disabled reasons until native bridge-control commands exist.
 * Consumers can reuse this instead of placing optimistic retry/send controls
 * beside an immutable plan projection.
 */
export function bridgeActionAvailability(
  projection: MultimodalBridgePlanProjection,
): BridgeActionAvailability {
  const reconciliationReason = projection.reconciliationRequired
    ? "Blind retry is disabled while native reconciliation is pending or blocked."
    : "Native bridge execution controls are not connected in this build.";
  return Object.freeze({
    inspect: Object.freeze({ available: true, reason: null }),
    continue: Object.freeze({
      available: false,
      reason: "Bridge continuation must be started by a native admission/dispatch command, not by the renderer.",
    }),
    retry: Object.freeze({ available: false, reason: reconciliationReason }),
    reconcile: Object.freeze({
      available: false,
      reason: "Reconciliation is native-owned and no renderer command is connected yet.",
    }),
  });
}

function shortDigest(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function yesNoUnknown(value: boolean | null): string {
  return value === true ? "Yes" : value === false ? "No" : "Not observed";
}

/**
 * Creates structured, copy-safe inspector data. It does not add an inferred
 * provider destination, cost, freshness, or provider acceptance when native
 * state did not record those facts.
 */
export function bridgeInspectorSections(
  projection: MultimodalBridgePlanProjection,
): readonly BridgeInspectorSection[] {
  const status = bridgeBadgeFromPlan(projection);
  const providerStageObserved = projection.stageReceipts.some(
    (receipt) => receipt.boundary === "approved-provider",
  );
  const latestStages = newestFirst(newestReceiptPerStage(projection.stageReceipts));
  const executionRows: BridgeInspectorRow[] = [
    { label: "Current bridge state", value: status.label },
    { label: "Provider stage receipt", value: yesNoUnknown(providerStageObserved) },
    {
      label: "Provider acceptance",
      value:
        projection.providerAcceptance === "not-observed"
          ? "Not observed"
          : projection.providerAcceptance,
    },
    {
      label: "Stage receipts",
      value: projection.stageReceipts.length === 0 ? "None observed" : String(projection.stageReceipts.length),
    },
  ];
  for (const receipt of latestStages) {
    executionRows.push({
      // A bridge DAG may branch by artifact/page/region. Stage kind plus attempt
      // number is therefore not a unique display identity; preserve the opaque
      // native stage ID so rows remain distinguishable and React keys remain stable.
      label: `${stageLabel(receipt.stageKind)} · ${receipt.stageId} · attempt ${receipt.attemptNo}`,
      value: `${receipt.status} · ${receipt.boundary} · acceptance ${receipt.providerAcceptance}`,
    });
  }

  const artifactRows: BridgeInspectorRow[] = [
    { label: "Source manifest", value: shortDigest(projection.sourceManifestSha256) },
  ];
  for (const artifact of projection.artifacts) {
    artifactRows.push({
      label: `${artifact.modality} · attachment ${artifact.ordinal + 1}`,
      value: `${artifact.mediaType} · ${artifact.byteSize.toLocaleString()} bytes · ${artifact.sourceSelector} · ${shortDigest(artifact.sourceSha256)}`,
    });
  }

  const rejected = projection.rejectedAlternatives.length === 0
    ? "None recorded"
    : projection.rejectedAlternatives
      .map((alternative) => `${alternative.mode}: ${alternative.reasonCodes.join(", ")}`)
      .join("; ");

  return Object.freeze([
    Object.freeze({
      id: "route",
      label: "Route decision",
      rows: Object.freeze([
        { label: "Requested", value: projection.requestedMode },
        { label: "Resolved", value: projection.resolvedMode },
        { label: "Disposition", value: projection.disposition },
        { label: "Plan digest", value: shortDigest(projection.planSha256) },
        { label: "Selected reasons", value: projection.selectedReasonCodes.join(", ") },
        { label: "Rejected alternatives", value: rejected },
      ]),
    }),
    Object.freeze({
      id: "capability",
      label: "Capability and policy",
      rows: Object.freeze([
        { label: "Capability snapshot", value: projection.capabilitySnapshotRevisionId },
        { label: "Capability freshness", value: projection.capabilityFreshness === "not-observed" ? "Not observed" : projection.capabilityFreshness },
        { label: "Policy revision", value: projection.policyRevisionId },
        { label: "Data boundary", value: projection.dataBoundary },
        { label: "Egress decision", value: projection.egressDecision },
      ]),
    }),
    Object.freeze({
      id: "artifacts",
      label: "Original source lineage",
      rows: Object.freeze(artifactRows),
    }),
    Object.freeze({
      id: "fidelity",
      label: "Fidelity disclosure",
      rows: Object.freeze([
        { label: "Profile", value: projection.fidelityProfile },
        { label: "Decisive dimensions", value: projection.decisiveFidelityDimensions.join(", ") },
        {
          label: "Derivatives recorded",
          value: String(
            new Set(projection.stageReceipts.flatMap((receipt) => receipt.derivativeSha256)).size,
          ),
        },
      ]),
    }),
    Object.freeze({
      id: "execution",
      label: "Execution receipts",
      rows: Object.freeze(executionRows),
    }),
    Object.freeze({
      id: "recovery",
      label: "Recovery and replay",
      rows: Object.freeze([
        { label: "Reconciliation required", value: projection.reconciliationRequired ? "Yes" : "No" },
        { label: "Frozen provider input", value: projection.frozenProviderInputId ?? "Not observed" },
        { label: "Supersedes plan", value: projection.supersedesPlanId ?? "None" },
        {
          label: "Retry availability",
          value: bridgeActionAvailability(projection).retry.reason,
        },
      ]),
    }),
  ]);
}

/** Accessible compact summary shared by status badges and live regions. */
export function bridgeAnnouncement(projection: MultimodalBridgePlanProjection): string {
  const status = bridgeBadgeFromPlan(projection);
  const egress = projection.egressDecision === "approved"
    ? "Provider egress approved by the frozen policy."
    : projection.egressDecision === "not-required"
      ? "No provider egress is required by this plan."
      : `Provider egress is ${projection.egressDecision}.`;
  const acceptance = projection.providerAcceptance === "not-observed"
    ? "Provider acceptance has not been observed."
    : `Provider acceptance is ${projection.providerAcceptance}.`;
  return `${status.label}. Requested ${projection.requestedMode}; resolved ${projection.resolvedMode}; disposition ${projection.disposition}. ${egress} ${acceptance}`;
}
