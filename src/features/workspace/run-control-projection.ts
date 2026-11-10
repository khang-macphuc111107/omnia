import type {
  ContinuationIntent,
  MessageRevision,
  ResolvedRunControlOperation,
  RunCheckpointRecord,
  RunControlApplyOutcome,
  RunControlApplyResult,
  RunControlKind,
} from "@/lib/desktop";

/**
 * Renderer-only status for a native run-control receipt.
 *
 * The renderer never invents these states from a button click. Every value
 * below is derived from a native resolution/apply receipt and is therefore
 * safe to show as evidence without pretending that a remote provider paused
 * or that a side effect was reconciled.
 */
export type RunControlProjectionStatus =
  | "resolved"
  | "applied"
  | "already-applied"
  | "blocked"
  | "rejected"
  | "cancelled"
  | "failed"
  | "stale-head"
  | "payload-drift"
  | "reconciliation-required";

export type RunControlDurability = "unknown" | "durable" | "replayed" | "not-durable";

export interface RunControlOperationProjection {
  operation: ResolvedRunControlOperation;
  status: RunControlProjectionStatus;
  durability: RunControlDurability;
  stateRevisionId: string | null;
  resultRunId: string | null;
  resultAttemptId: string | null;
  checkpointId: string | null;
  blockedReason: string | null;
  diagnostic: string | null;
}

export interface RunCheckpointProjection {
  checkpoint: RunCheckpointRecord;
  /** A paused checkpoint is resumable only when native evidence is safe. */
  resumable: boolean;
  /** True when replaying the provider/tool effect requires reconciliation. */
  reconciliationRequired: boolean;
  warning: string | null;
}

export type RunControlAvailabilityReason =
  | "native-runtime-required"
  | "operation-pending"
  | "run-not-active"
  | "checkpoint-not-ready"
  | "provider-outcome-unknown"
  | "reconciliation-required"
  | "stale-head"
  | "payload-drift"
  | "operation-rejected"
  | "operation-failed";

export interface RunControlAvailability {
  enabled: boolean;
  reason: RunControlAvailabilityReason | null;
  detail: string | null;
}

export interface RunControlAvailabilityContext {
  runtime: "desktop" | "browser-preview";
  activeRunId?: string | null;
  operation?: RunControlOperationProjection | null;
  checkpoint?: RunCheckpointProjection | null;
  /** Native state-base preparation is intentionally explicit. */
  hasCanonicalStateBase: boolean;
}

const statusRank: Record<RunControlProjectionStatus, number> = {
  resolved: 10,
  applied: 80,
  "already-applied": 80,
  blocked: 60,
  rejected: 70,
  cancelled: 70,
  failed: 70,
  "stale-head": 65,
  "payload-drift": 65,
  "reconciliation-required": 66,
};

function statusFromApplyOutcome(outcome: RunControlApplyOutcome): RunControlProjectionStatus {
  return outcome;
}

function statusFromApplyResult(result: RunControlApplyResult): RunControlProjectionStatus {
  const operation = result.operation;
  const diagnostic = `${result.diagnostic ?? ""} ${operation.result?.blockedReason ?? ""}`.toLowerCase();
  if (diagnostic.includes("payload-drift") || diagnostic.includes("payload drift")) {
    return "payload-drift";
  }
  if (
    diagnostic.includes("stale-head") ||
    diagnostic.includes("stale head") ||
    diagnostic.includes("expected-head") ||
    diagnostic.includes("expected head")
  ) {
    return "stale-head";
  }
  if (diagnostic.includes("reconciliation")) return "reconciliation-required";
  return statusFromApplyOutcome(operation.operationState === "resolved" ? "applied" : operation.operationState);
}

function safeString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Serializes a typed immutable identity without depending on JSON property
 * insertion order. Native IPC payloads are schema-stable, but a replay/read
 * adapter may materialize equivalent objects in a different order; that is
 * not payload drift and must not discard a stronger receipt.
 */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

function operationIdentityMatches(
  left: ResolvedRunControlOperation,
  right: ResolvedRunControlOperation,
): boolean {
  // `operationId` is the native address, not permission to reinterpret a
  // receipt. Compare the complete immutable intent and resolved state-base
  // identity while deliberately excluding lifecycle fields (`operationState`,
  // `result`, receipt metadata) that are expected to change on apply/replay.
  // Explicit object construction keeps comparison independent of property
  // insertion order and makes optional native fields normalize consistently.
  const identity = (operation: ResolvedRunControlOperation) =>
    stableSerialize({
      schemaVersion: operation.schemaVersion,
      operationId: operation.operationId,
      kind: operation.kind,
      conversationId: operation.conversationId,
      branchId: operation.branchId,
      sourceRunId: operation.sourceRunId,
      sourceAttemptId: operation.sourceAttemptId,
      sourceMessageId: operation.sourceMessageId,
      sourcePromptRevisionId: operation.sourcePromptRevisionId,
      stateBase: operation.stateBase,
      editRevisionId: operation.editRevisionId,
      continuationIntent: operation.continuationIntent,
      activeRunPolicy: operation.activeRunPolicy,
      expectedActiveRunId: operation.expectedActiveRunId,
      expectedConversationVersion: operation.expectedConversationVersion,
      expectedBranchCursor: operation.expectedBranchCursor,
      compareStateRevisionIds: operation.compareStateRevisionIds,
      mergeStateRevisionIds: operation.mergeStateRevisionIds,
      actor: operation.actor,
      idempotencyKey: operation.idempotencyKey,
      createdAt: operation.createdAt,
    });
  return identity(left) === identity(right);
}

/**
 * Converts a native resolution receipt into a renderer projection. A resolved
 * operation is not marked durable merely because it crossed the IPC boundary;
 * native `run_control_apply` is the authority for that fact.
 */
export function projectResolvedRunControlOperation(
  operation: ResolvedRunControlOperation,
): RunControlOperationProjection {
  const status = operation.operationState;
  return {
    operation,
    status,
    durability: "unknown",
    stateRevisionId: operation.result?.resultStateRevisionId ?? null,
    resultRunId: operation.result?.resultRunId ?? null,
    resultAttemptId: operation.result?.resultAttemptId ?? null,
    checkpointId: operation.result?.resultCheckpointId ?? null,
    blockedReason: safeString(operation.result?.blockedReason),
    diagnostic: null,
  };
}

/** Converts the native apply receipt without inferring anything from UI state. */
export function projectRunControlApply(
  result: RunControlApplyResult,
): RunControlOperationProjection {
  const operation = result.operation;
  const appliedStatus = statusFromApplyResult(result);
  // Native marks every terminal receipt replayed, including blocked, failed,
  // stale-head and reconciliation outcomes. Only a replay of an actually
  // applied operation is semantically `already-applied`; preserving the
  // original terminal status is necessary for truthful disabled reasons.
  const status = result.replayed && appliedStatus === "applied" ? "already-applied" : appliedStatus;
  return {
    operation,
    status,
    durability: result.replayed ? "replayed" : result.durable ? "durable" : "not-durable",
    stateRevisionId: result.stateRevisionId ?? operation.result?.resultStateRevisionId ?? null,
    resultRunId: operation.result?.resultRunId ?? null,
    resultAttemptId: operation.result?.resultAttemptId ?? null,
    checkpointId: operation.result?.resultCheckpointId ?? null,
    blockedReason: safeString(operation.result?.blockedReason),
    diagnostic: safeString(result.diagnostic),
  };
}

/**
 * Merge immutable native receipts. A duplicate idempotent replay does not add
 * a second visible operation, and a conflicting payload is ignored rather than
 * allowing the renderer to reinterpret an operation ID.
 */
export function mergeRunControlProjection(
  current: RunControlOperationProjection | undefined,
  incoming: RunControlOperationProjection,
): RunControlOperationProjection | undefined {
  if (!current) return incoming;
  if (!operationIdentityMatches(current.operation, incoming.operation)) return current;

  const currentRank = statusRank[current.status];
  const incomingRank = statusRank[incoming.status];
  if (incomingRank > currentRank) return incoming;

  if (incomingRank < currentRank) {
    // A delayed resolution/read must never erase a durable or blocked receipt.
    return current;
  }

  if (current.durability === "durable" && incoming.durability === "unknown") return current;
  if (current.durability === "replayed" && incoming.durability !== "replayed") return current;
  if (incoming.durability === "replayed" || current.durability === "unknown") return incoming;

  // Keep the latest non-empty diagnostic/evidence while preserving immutable
  // native operation identity and the strongest status already observed.
  return {
    ...current,
    diagnostic: incoming.diagnostic ?? current.diagnostic,
    blockedReason: incoming.blockedReason ?? current.blockedReason,
    stateRevisionId: incoming.stateRevisionId ?? current.stateRevisionId,
    resultRunId: incoming.resultRunId ?? current.resultRunId,
    resultAttemptId: incoming.resultAttemptId ?? current.resultAttemptId,
    checkpointId: incoming.checkpointId ?? current.checkpointId,
  };
}

export function projectRunCheckpoint(record: RunCheckpointRecord): RunCheckpointProjection {
  const reconciliationRequired =
    record.disposition === "outcome-unknown" || record.pendingReconciliationIds.length > 0;
  const resumable =
    record.status === "paused" &&
    !reconciliationRequired &&
    record.providerAcceptance !== "unknown" &&
    record.providerAcceptance !== "rejected";
  return {
    checkpoint: record,
    resumable,
    reconciliationRequired,
    warning: reconciliationRequired
      ? "Provider or external-effect outcome must be reconciled before resume or retry."
      : record.status === "checkpointing" || record.status === "requested"
        ? "Checkpoint is not durable yet."
        : null,
  };
}

function operationInFlight(operation: RunControlOperationProjection | null | undefined): boolean {
  return operation?.status === "resolved";
}

/**
 * Returns an explicit availability reason for controls. This selector is
 * deliberately conservative: without native canonical state-base preparation
 * the renderer cannot safely construct a run-control request.
 */
export function getRunControlAvailability(
  kind: RunControlKind,
  context: RunControlAvailabilityContext,
): RunControlAvailability {
  if (context.runtime !== "desktop") {
    return {
      enabled: false,
      reason: "native-runtime-required",
      detail: "This durable action is available only in the native desktop runtime.",
    };
  }
  if (operationInFlight(context.operation)) {
    return {
      enabled: false,
      reason: "operation-pending",
      detail: "Wait for the native operation receipt before issuing another control.",
    };
  }
  // These are native durable run-control variants, including snapshot-based
  // copy/compare. A plain clipboard copy does not use this selector; when a
  // request crosses the native run-control boundary, every kind carries the
  // schema-required immutable `stateBase` and must fail closed until it is
  // prepared. This keeps compare pins and copied snapshots from silently
  // drifting to a later mutable branch head.
  if (
    [
      "pause",
      "resume",
      "continue",
      "edit",
      "retry",
      "copy",
      "duplicate",
      "branch",
      "fork",
      "compare",
      "promote",
      "merge",
    ].includes(kind) &&
    !context.hasCanonicalStateBase
  ) {
    return {
      enabled: false,
      reason: "native-runtime-required",
      detail: "Native state-base preparation is required; the renderer will not guess cursors or digests.",
    };
  }
  if (kind === "pause" && !context.activeRunId) {
    return { enabled: false, reason: "run-not-active", detail: "Pause is available only for an active run." };
  }
  if (kind === "resume" || kind === "continue") {
    if (context.checkpoint?.reconciliationRequired) {
      return {
        enabled: false,
        reason: "reconciliation-required",
        detail: context.checkpoint.warning,
      };
    }
    if (kind === "resume" && !context.checkpoint?.resumable) {
      return {
        enabled: false,
        reason: "checkpoint-not-ready",
        detail: context.checkpoint?.warning ?? "A verified paused checkpoint is required.",
      };
    }
  }
  // A checkpoint can carry reconciliation debt even when its disposition is
  // not `outcome-unknown` (for example, a provider may have acknowledged a
  // cooperative checkpoint while an external effect is still pending). The
  // projection computes that fact from both disposition and the persisted
  // reconciliation-id list; retry must honor the derived invariant instead of
  // checking only one wire enum.
  if (kind === "retry" && context.checkpoint?.reconciliationRequired) {
    return {
      enabled: false,
      reason:
        context.checkpoint.checkpoint.disposition === "outcome-unknown"
          ? "provider-outcome-unknown"
          : "reconciliation-required",
      detail:
        context.checkpoint.warning ??
        "Retry is blocked until pending provider or external effects are reconciled.",
    };
  }
  const operation = context.operation;
  const status = operation?.status;
  if (status === "stale-head") {
    return {
      enabled: false,
      reason: "stale-head",
      detail: "The branch head changed; rebase or resolve a fresh native operation first.",
    };
  }
  if (status === "payload-drift") {
    return {
      enabled: false,
      reason: "payload-drift",
      detail: "The native payload no longer matches the resolved operation; inspect reconciliation.",
    };
  }
  if (status === "reconciliation-required") {
    return {
      enabled: false,
      reason: "reconciliation-required",
      detail: operation?.diagnostic ?? "Native reconciliation is required before continuing.",
    };
  }
  if (status === "rejected") {
    return { enabled: false, reason: "operation-rejected", detail: "The native operation was rejected." };
  }
  if (status === "failed") {
    return { enabled: false, reason: "operation-failed", detail: "The native operation failed; inspect its diagnostic." };
  }
  return { enabled: true, reason: null, detail: null };
}

export interface RunControlStoreProjection {
  runControlOperationsById: Record<string, RunControlOperationProjection>;
  checkpointsByRunId: Record<string, RunCheckpointProjection>;
  continuationIntentsById: Record<string, ContinuationIntent>;
  messageRevisionsByMessageId: Record<string, MessageRevision[]>;
}
