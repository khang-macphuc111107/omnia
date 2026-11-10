import { describe, expect, it, vi } from "vitest";

import type {
  ContinuationIntent,
  MessageRevision,
  ResolvedRunControlOperation,
  RunCheckpointRecord,
  RunControlApplyResult,
  RunControlOperationRequest,
} from "@/lib/desktop";

import {
  applyRunControlIntoStore,
  createRunCheckpointIntoStore,
  readRunCheckpointIntoStore,
  resolveAndApplyRunControlIntoStore,
  resolveContinuationIntentIntoStore,
  resolveMessageRevisionIntoStore,
  resolveRunControlIntoStore,
  type RunControlNativeClient,
  type RunControlProjectionStore,
} from "./run-control-sync";

const operationId = "operation_sync_aaaaaaaaaaaaaaaaaaaaaaaa";
const idempotencyKey = "run-control:sync";

function operation(overrides: Partial<ResolvedRunControlOperation> = {}): ResolvedRunControlOperation {
  return {
    schemaVersion: 2,
    operationId,
    receiptId: "receipt_sync_aaaaaaaaaaaaaaaaaaaaaaaa",
    authorityContinuityRecordId: null,
    kind: "continue",
    operationState: "resolved",
    conversationId: "conversation_sync_aaaaaaaaaaaaaaaaaaaa",
    branchId: "branch_sync_aaaaaaaaaaaaaaaaaaaaaaaa",
    sourceRunId: null,
    sourceAttemptId: null,
    sourceMessageId: null,
    sourcePromptRevisionId: null,
    stateBase: {
      mode: "fresh-goal-start",
      sourceStateRevisionId: null,
      requestedHeadStateRevisionId: null,
      resolvedStateRevisionId: "state_sync_aaaaaaaaaaaaaaaaaaaaaaaa",
      resolvedStateDigest: {
        algorithm: "sha-256",
        canonicalizationRevision: "state-revision-c14n-v1",
        value: "a".repeat(64),
      },
      selectedDeltaIds: [],
      contextManifestId: null,
      resolutionReason: "fresh-goal-bootstrap",
      resolvedAt: "2026-09-12T00:00:00.000Z",
      resolvedAtCursors: [
        {
          streamKind: "branch",
          streamId: "branch_sync_aaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: 1,
          journalEpoch: null,
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
    actor: { kind: "user", id: "user_sync" },
    idempotencyKey,
    createdAt: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}

function request(): RunControlOperationRequest {
  const resolved = operation();
  return {
    schemaVersion: 2,
    operationId: resolved.operationId,
    conversationId: resolved.conversationId,
    branchId: resolved.branchId,
    kind: resolved.kind,
    stateBase: resolved.stateBase,
    actor: resolved.actor,
    idempotencyKey: resolved.idempotencyKey,
    createdAt: resolved.createdAt,
    continuationIntent: resolved.continuationIntent,
    activeRunPolicy: resolved.activeRunPolicy,
    expectedActiveRunId: null,
    expectedConversationVersion: null,
    expectedBranchCursor: null,
    compareStateRevisionIds: [],
    mergeStateRevisionIds: [],
  };
}

function checkpoint(): RunCheckpointRecord {
  return {
    schemaVersion: 1,
    checkpointId: "checkpoint_sync_aaaaaaaaaaaaaaaaaaaaaaa",
    runId: "run_sync_aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    attemptId: null,
    agentInstanceId: null,
    stateRevisionId: "state_sync_aaaaaaaaaaaaaaaaaaaaaaaa",
    status: "paused",
    disposition: "cooperative-checkpoint",
    cursor: 1,
    partialOutputPolicy: "durable-only",
    frozenProviderInputId: null,
    providerAcceptance: "accepted",
    pendingReconciliationIds: [],
    leaseEpoch: null,
    telemetryWatermark: null,
    contentHash: "b".repeat(64),
    idempotencyKey: "checkpoint:sync",
    createdAt: "2026-09-12T00:00:00.000Z",
  };
}

function continuation(): ContinuationIntent {
  return {
    schemaVersion: 1,
    intentId: "intent_sync_aaaaaaaaaaaaaaaaaaaaaaaa",
    rootKind: "run",
    rootId: "run_sync_aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    intentKind: "unfinished-answer",
    stateRevisionId: "state_sync_aaaaaaaaaaaaaaaaaaaaaaaa",
    executionMode: "execute",
    modelProfileId: "auto",
    effort: "deep",
    allowedToolIds: [],
    budget: null,
    loopGuard: {
      chainId: "chain_sync_aaaaaaaaaaaaaaaaaaaaaaaa",
      duplicateSignature: "signature_sync",
      maxAutomaticSegments: 3,
      progressScore: null,
      noProgressCount: 0,
    },
    approvalPolicyRevision: null,
    createdAt: "2026-09-12T00:00:00.000Z",
  };
}

function revision(): MessageRevision {
  return {
    schemaVersion: 1,
    revisionId: "revision_sync_aaaaaaaaaaaaaaaaaaaa",
    messageId: "message_sync_aaaaaaaaaaaaaaaaaaaaaaaa",
    kind: "assistant",
    effect: "retry-current-state",
    parentRevisionId: null,
    sourceCursor: 1,
    destinationBranchId: "branch_sync_aaaaaaaaaaaaaaaaaaaaaaaa",
    contentHash: "c".repeat(64),
    redactionClass: "none",
    createdAt: "2026-09-12T00:00:00.000Z",
  };
}

function dependencies(overrides: Partial<RunControlNativeClient> = {}) {
  const calls: string[] = [];
  const native: RunControlNativeClient = {
    resolveRunControl: vi.fn(async () => {
      calls.push("resolve");
      return operation();
    }),
    applyRunControl: vi.fn(async () => {
      calls.push("apply");
      return {
        operation: operation({
          operationState: "applied",
          result: { resultStateRevisionId: "state_sync_aaaaaaaaaaaaaaaaaaaaaaaa" },
        }),
        durable: true,
        stateRevisionId: "state_sync_aaaaaaaaaaaaaaaaaaaaaaaa",
        replayed: false,
        diagnostic: null,
      } satisfies RunControlApplyResult;
    }),
    createRunCheckpoint: vi.fn(async () => {
      calls.push("checkpoint-create");
      return checkpoint();
    }),
    readRunCheckpoint: vi.fn(async () => {
      calls.push("checkpoint-read");
      return checkpoint();
    }),
    resolveContinuationIntent: vi.fn(async () => {
      calls.push("continuation");
      return continuation();
    }),
    resolveMessageRevision: vi.fn(async () => {
      calls.push("revision");
      return revision();
    }),
    ...overrides,
  };
  const store: RunControlProjectionStore & { operations: string[] } = {
    operations: [],
    upsertRunControlOperation: vi.fn((projection) => store.operations.push(`operation:${projection.status}`)),
    upsertRunCheckpoint: vi.fn(() => store.operations.push("checkpoint")),
    upsertContinuationIntent: vi.fn(() => store.operations.push("continuation")),
    upsertMessageRevision: vi.fn(() => store.operations.push("revision")),
  };
  return { native, store, calls };
}

describe("run-control native sync adapter", () => {
  it("requires explicit native canonical state-base preparation", async () => {
    const { native, store } = dependencies();
    await expect(
      resolveRunControlIntoStore(request(), {
        canonicalStateBasePrepared: false,
        native,
        store,
      }),
    ).rejects.toThrow("canonical state-base preparation");
    expect(native.resolveRunControl).not.toHaveBeenCalled();
    expect(store.upsertRunControlOperation).not.toHaveBeenCalled();
  });

  it("projects resolve and apply only after native receipts", async () => {
    const { native, store, calls } = dependencies();
    const result = await resolveAndApplyRunControlIntoStore(
      request(),
      { expectedHeadStateRevisionId: "state_sync_aaaaaaaaaaaaaaaaaaaaaaaa" },
      { canonicalStateBasePrepared: true, native, store },
    );
    expect(calls).toEqual(["resolve", "apply"]);
    expect(result.resolved.status).toBe("resolved");
    expect(result.applied.status).toBe("applied");
    expect(store.operations).toEqual(["operation:resolved", "operation:applied"]);
    expect(native.applyRunControl).toHaveBeenCalledWith({
      operationId,
      idempotencyKey,
      expectedHeadStateRevisionId: "state_sync_aaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  it("does not project an operation when native apply fails", async () => {
    const { native, store } = dependencies({
      applyRunControl: vi.fn(async () => {
        throw new Error("native apply failed");
      }),
    });
    await expect(
      applyRunControlIntoStore(
        { operationId, idempotencyKey },
        { canonicalStateBasePrepared: true, native, store },
      ),
    ).rejects.toThrow("native apply failed");
    expect(store.upsertRunControlOperation).not.toHaveBeenCalled();
  });

  it("projects checkpoints, continuations, revisions and null checkpoint reads", async () => {
    const { native, store } = dependencies();
    await expect(
      createRunCheckpointIntoStore(
        { runId: checkpoint().runId, stateRevisionId: checkpoint().stateRevisionId, status: "paused", disposition: "cooperative-checkpoint", cursor: 1, contentHash: checkpoint().contentHash, idempotencyKey: checkpoint().idempotencyKey },
        { native, store },
      ),
    ).resolves.toMatchObject({ resumable: true });
    await expect(
      readRunCheckpointIntoStore(
        { runId: checkpoint().runId },
        { native, store },
      ),
    ).resolves.toMatchObject({ checkpoint: { checkpointId: checkpoint().checkpointId } });
    (native.readRunCheckpoint as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(
      readRunCheckpointIntoStore(
        { runId: checkpoint().runId },
        { native, store },
      ),
    ).resolves.toBeNull();
    await expect(
      resolveContinuationIntentIntoStore(
        { conversationId: "conversation_sync_aaaaaaaaaaaaaaaaaaaa", branchId: "branch_sync_aaaaaaaaaaaaaaaaaaaaaaaa", rootKind: "run", rootId: continuation().rootId, intentKind: "unfinished-answer", stateRevisionId: continuation().stateRevisionId, idempotencyKey: "intent:sync" },
        { native, store },
      ),
    ).resolves.toEqual(continuation());
    await expect(
      resolveMessageRevisionIntoStore(
        { conversationId: "conversation_sync_aaaaaaaaaaaaaaaaaaaa", branchId: "branch_sync_aaaaaaaaaaaaaaaaaaaaaaaa", messageId: revision().messageId, kind: "assistant", effect: "retry-current-state", sourceCursor: 1, contentHash: revision().contentHash, redactionClass: "none", idempotencyKey: "revision:sync" },
        { native, store },
      ),
    ).resolves.toEqual(revision());
    expect(store.operations).toEqual(["checkpoint", "checkpoint", "continuation", "revision"]);
  });
});
