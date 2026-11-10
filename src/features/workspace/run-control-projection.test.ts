import { describe, expect, it } from "vitest";

import type {
  ResolvedRunControlOperation,
  RunCheckpointRecord,
  RunControlApplyResult,
} from "@/lib/desktop";

import {
  getRunControlAvailability,
  mergeRunControlProjection,
  projectResolvedRunControlOperation,
  projectRunCheckpoint,
  projectRunControlApply,
} from "./run-control-projection";

const conversationId = "conversation_0123456789abcdef0123456789abcdef";
const branchId = "branch_0123456789abcdef0123456789abcdef";
const operationId = "operation_0123456789abcdef0123456789abcdef";
const stateRevisionId = "state_rev_0123456789abcdef0123456789abcdef";

function operation(
  overrides: Partial<ResolvedRunControlOperation> = {},
): ResolvedRunControlOperation {
  return {
    schemaVersion: 2,
    operationId,
    receiptId: "receipt_0123456789abcdef0123456789abcdef",
    authorityContinuityRecordId: null,
    kind: "continue",
    operationState: "resolved",
    conversationId,
    branchId,
    sourceRunId: "run_0123456789abcdef0123456789abcdef",
    sourceAttemptId: "attempt_0123456789abcdef0123456789abcdef",
    sourceMessageId: "message_0123456789abcdef0123456789abcdef",
    sourcePromptRevisionId: null,
    stateBase: {
      mode: "current-state",
      sourceStateRevisionId: stateRevisionId,
      requestedHeadStateRevisionId: stateRevisionId,
      resolvedStateRevisionId: stateRevisionId,
      resolvedStateDigest: {
        algorithm: "sha-256",
        canonicalizationRevision: "state-revision-c14n-v1",
        value: "a".repeat(64),
      },
      selectedDeltaIds: [],
      contextManifestId: null,
      resolutionReason: "current-branch-head",
      resolvedAt: "2026-09-12T00:00:00.000Z",
      resolvedAtCursors: [
        {
          streamKind: "branch",
          streamId: branchId,
          journalEpoch: null,
          sequence: 4,
          eventId: null,
          payloadHash: null,
        },
      ],
    },
    editRevisionId: null,
    continuationIntent: "unfinished-answer",
    activeRunPolicy: "queue-after-terminal",
    expectedActiveRunId: null,
    expectedConversationVersion: null,
    expectedBranchCursor: null,
    compareStateRevisionIds: [],
    mergeStateRevisionIds: [],
    result: null,
    actor: { kind: "user", id: "user_local" },
    idempotencyKey: "run-control:test-projection",
    createdAt: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}

function checkpoint(
  overrides: Partial<RunCheckpointRecord> = {},
): RunCheckpointRecord {
  return {
    schemaVersion: 1,
    checkpointId: "checkpoint_0123456789abcdef0123456789abcdef",
    runId: "run_0123456789abcdef0123456789abcdef",
    attemptId: "attempt_0123456789abcdef0123456789abcdef",
    agentInstanceId: null,
    stateRevisionId,
    status: "paused",
    disposition: "cooperative-checkpoint",
    cursor: 12,
    partialOutputPolicy: "durable-only",
    frozenProviderInputId: "provider_input_0123456789abcdef0123456789abcdef",
    providerAcceptance: "accepted",
    pendingReconciliationIds: [],
    leaseEpoch: 2,
    telemetryWatermark: 4,
    contentHash: "b".repeat(64),
    idempotencyKey: "checkpoint:test-projection",
    createdAt: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("renderer run-control projections", () => {
  it("does not mark a resolved operation durable before native apply", () => {
    const projection = projectResolvedRunControlOperation(operation());

    expect(projection.status).toBe("resolved");
    expect(projection.durability).toBe("unknown");
    expect(projection.stateRevisionId).toBeNull();
  });

  it("preserves applied evidence when an idempotent replay is observed", () => {
    const applied = operation({
      operationState: "applied",
      result: {
        resultStateRevisionId: stateRevisionId,
        resultRunId: "run_0123456789abcdef0123456789abcdef",
        resultAttemptId: null,
        resultCheckpointId: null,
        resultBranchId: branchId,
        blockedReason: null,
        diagnosticId: null,
      },
    });
    const first = projectRunControlApply({
      operation: applied,
      durable: true,
      stateRevisionId,
      replayed: false,
      diagnostic: null,
    } satisfies RunControlApplyResult);
    const replay = projectRunControlApply({
      operation: applied,
      durable: true,
      stateRevisionId,
      replayed: true,
      diagnostic: null,
    } satisfies RunControlApplyResult);

    expect(first.status).toBe("applied");
    expect(first.durability).toBe("durable");
    expect(replay.status).toBe("already-applied");
    expect(replay.durability).toBe("replayed");
    expect(mergeRunControlProjection(first, replay)).toEqual(replay);
    expect(mergeRunControlProjection(replay, projectResolvedRunControlOperation(operation()))).toEqual(replay);
  });

  it.each([
    ["blocked", "blocked"],
    ["failed", "failed"],
  ] as const)("preserves %s status when native replays a terminal receipt", (operationState, expectedStatus) => {
    const replay = projectRunControlApply({
      operation: operation({
        operationState,
        result: { blockedReason: "native-terminal-diagnostic" },
      }),
      durable: true,
      stateRevisionId: null,
      replayed: true,
      diagnostic: "native-terminal-diagnostic",
    } satisfies RunControlApplyResult);

    expect(replay.status).toBe(expectedStatus);
    expect(replay.status).not.toBe("already-applied");
    expect(replay.durability).toBe("replayed");
  });

  it("ignores a same-ID receipt whose immutable intent payload drifts", () => {
    const original = projectResolvedRunControlOperation(operation());
    const drifted = projectRunControlApply({
      operation: operation({
        operationState: "applied",
        sourceMessageId: "message_drifted_0123456789abcdef0123456789",
        result: { resultStateRevisionId: stateRevisionId },
      }),
      durable: true,
      stateRevisionId,
      replayed: false,
      diagnostic: null,
    } satisfies RunControlApplyResult);

    expect(mergeRunControlProjection(original, drifted)).toBe(original);
  });

  it("treats equivalent immutable receipts as identical despite object key order", () => {
    const original = projectResolvedRunControlOperation(operation());
    const reordered = operation({
      stateBase: {
        ...operation().stateBase,
        resolvedStateDigest: {
          value: "a".repeat(64),
          canonicalizationRevision: "state-revision-c14n-v1",
          algorithm: "sha-256",
        },
        resolvedAtCursors: [
          {
            payloadHash: null,
            eventId: null,
            sequence: 4,
            journalEpoch: null,
            streamId: branchId,
            streamKind: "branch",
          },
        ],
      },
      operationState: "applied",
      result: { resultStateRevisionId: stateRevisionId },
    });
    const incoming = projectRunControlApply({
      operation: reordered,
      durable: true,
      stateRevisionId,
      replayed: false,
      diagnostic: null,
    } satisfies RunControlApplyResult);

    expect(mergeRunControlProjection(original, incoming)).toEqual(incoming);
  });

  it.each([
    ["stale-head", "stale-head"],
    ["payload-drift", "payload-drift"],
    ["reconciliation", "reconciliation-required"],
  ] as const)("maps native diagnostic %s without optimistic success", (diagnostic, expected) => {
    const projected = projectRunControlApply({
      operation: operation({ operationState: "failed" }),
      durable: true,
      stateRevisionId: null,
      replayed: false,
      diagnostic,
    });
    expect(projected.status).toBe(expected);
  });

  it("keeps browser preview and missing canonical state-base fail-closed", () => {
    expect(
      getRunControlAvailability("continue", {
        runtime: "browser-preview",
        hasCanonicalStateBase: false,
      }),
    ).toMatchObject({ enabled: false, reason: "native-runtime-required" });
    expect(
      getRunControlAvailability("retry", {
        runtime: "desktop",
        activeRunId: null,
        hasCanonicalStateBase: false,
      }),
    ).toMatchObject({ enabled: false, reason: "native-runtime-required" });

    for (const kind of ["copy", "compare"] as const) {
      expect(
        getRunControlAvailability(kind, {
          runtime: "desktop",
          hasCanonicalStateBase: false,
        }),
      ).toMatchObject({ enabled: false, reason: "native-runtime-required" });
    }
  });

  it("blocks retry for outcome-unknown and resume until a verified checkpoint exists", () => {
    const unknown = projectRunCheckpoint(
      checkpoint({
        disposition: "outcome-unknown",
        pendingReconciliationIds: ["reconcile_0123456789abcdef0123456789abcdef"],
      }),
    );
    expect(
      getRunControlAvailability("retry", {
        runtime: "desktop",
        hasCanonicalStateBase: true,
        checkpoint: unknown,
      }),
    ).toMatchObject({ enabled: false, reason: "provider-outcome-unknown" });
    expect(
      getRunControlAvailability("resume", {
        runtime: "desktop",
        hasCanonicalStateBase: true,
        checkpoint: unknown,
      }),
    ).toMatchObject({ enabled: false, reason: "reconciliation-required" });

    const requested = projectRunCheckpoint(checkpoint({ status: "checkpointing" }));
    expect(
      getRunControlAvailability("resume", {
        runtime: "desktop",
        hasCanonicalStateBase: true,
        checkpoint: requested,
      }),
    ).toMatchObject({ enabled: false, reason: "checkpoint-not-ready" });
  });

  it("blocks retry for reconciliation debt even when the checkpoint disposition is not outcome-unknown", () => {
    const pendingEffect = projectRunCheckpoint(
      checkpoint({
        disposition: "cooperative-checkpoint",
        pendingReconciliationIds: ["reconcile_0123456789abcdef0123456789abcdef"],
      }),
    );

    expect(pendingEffect.reconciliationRequired).toBe(true);
    expect(
      getRunControlAvailability("retry", {
        runtime: "desktop",
        hasCanonicalStateBase: true,
        checkpoint: pendingEffect,
      }),
    ).toMatchObject({
      enabled: false,
      reason: "reconciliation-required",
    });
  });

  it("allows resume only from a paused checkpoint with no reconciliation debt", () => {
    const paused = projectRunCheckpoint(checkpoint());
    expect(paused.resumable).toBe(true);
    expect(
      getRunControlAvailability("resume", {
        runtime: "desktop",
        hasCanonicalStateBase: true,
        checkpoint: paused,
      }),
    ).toEqual({ enabled: true, reason: null, detail: null });
  });
});
