import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const SESSION_TOKEN = "b".repeat(64);

function compatibleCore() {
  return {
    protocolVersion: "1.0",
    serverInfo: {
      name: "omnia-core",
      title: "Omnia Core",
      version: "0.1.0",
    },
    capabilities: ["run.stream.v1", "run-control.v1"],
    unavailableCapabilities: [],
    sessionToken: SESSION_TOKEN,
    sessionEpoch: 7,
  };
}

function requestFixture() {
  return {
    schemaVersion: 2 as const,
    operationId: "operation_22222222222222222222222222222222",
    conversationId: "conversation_22222222222222222222222222222222",
    branchId: "branch_22222222222222222222222222222222",
    kind: "continue" as const,
    stateBase: {
      mode: "current-state" as const,
      sourceStateRevisionId: "state_rev_22222222222222222222222222222222",
      requestedHeadStateRevisionId: "state_rev_22222222222222222222222222222222",
      resolvedStateRevisionId: "state_rev_22222222222222222222222222222222",
      resolvedStateDigest: {
        algorithm: "sha-256" as const,
        canonicalizationRevision: "state-revision-c14n-v1",
        value: "c".repeat(64),
      },
      selectedDeltaIds: [],
      contextManifestId: null,
      resolutionReason: "current-branch-head" as const,
      resolvedAt: "2026-09-11T00:00:00Z",
      resolvedAtCursors: [{
        streamKind: "branch" as const,
        streamId: "branch_22222222222222222222222222222222",
        journalEpoch: null,
        sequence: 4,
        eventId: null,
        payloadHash: null,
      }],
    },
    actor: { kind: "user" as const, id: "user_local" },
    idempotencyKey: "run-control:test-2222",
    continuationIntent: "unfinished-answer" as const,
    activeRunPolicy: "queue-after-terminal" as const,
    compareStateRevisionIds: [],
    mergeStateRevisionIds: [],
    createdAt: "2026-09-11T00:00:00Z",
  };
}

describe("desktop run-control bridge fail-closed behavior", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const { __resetCoreSessionForTests } = await import("./desktop");
    __resetCoreSessionForTests();
  });

  it("attaches the session header to every run-control surface", async () => {
    invokeMock
      .mockResolvedValueOnce(compatibleCore())
      .mockResolvedValueOnce({ operationId: requestFixture().operationId, operationState: "resolved" })
      .mockResolvedValueOnce({ operation: {}, durable: true, stateRevisionId: null, replayed: false, diagnostic: null })
      .mockResolvedValueOnce({ checkpointId: "checkpoint_22222222222222222222222222222222" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ intentId: "intent_22222222222222222222222222222222" })
      .mockResolvedValueOnce({ revisionId: "message_revision_222222222222222222222222" });
    const { desktop } = await import("./desktop");

    await desktop.initializeCore("0.1.0");
    await desktop.resolveRunControl(requestFixture());
    await desktop.applyRunControl({
      operationId: requestFixture().operationId,
      idempotencyKey: requestFixture().idempotencyKey,
    });
    await desktop.createRunCheckpoint({
      runId: "run_22222222222222222222222222222222",
      stateRevisionId: "state_rev_22222222222222222222222222222222",
      status: "requested",
      disposition: "cooperative-checkpoint",
      cursor: 4,
      contentHash: "d".repeat(64),
      idempotencyKey: "checkpoint:test-2222",
    });
    await desktop.readRunCheckpoint({
      runId: "run_22222222222222222222222222222222",
    });
    await desktop.resolveContinuationIntent({
      conversationId: requestFixture().conversationId,
      branchId: requestFixture().branchId,
      rootKind: "run",
      rootId: "run_22222222222222222222222222222222",
      intentKind: "unfinished-answer",
      stateRevisionId: requestFixture().stateBase.resolvedStateRevisionId,
      idempotencyKey: "intent:test-2222",
    });
    await desktop.resolveMessageRevision({
      conversationId: requestFixture().conversationId,
      branchId: requestFixture().branchId,
      messageId: "message_22222222222222222222222222222222",
      kind: "user",
      effect: "edit-draft",
      sourceCursor: 4,
      contentHash: "e".repeat(64),
      redactionClass: "normal",
      idempotencyKey: "message-revision:test-2222",
    });

    expect(invokeMock.mock.calls.slice(1)).toHaveLength(6);
    for (const [, , options] of invokeMock.mock.calls.slice(1)) {
      expect(options).toEqual({ headers: { "x-omnia-session": SESSION_TOKEN } });
    }
    expect(invokeMock.mock.calls.slice(1).map(([command]) => command)).toEqual([
      "run_control_resolve",
      "run_control_apply",
      "checkpoint_create",
      "checkpoint_read",
      "continuation_intent_resolve",
      "message_revision_resolve",
    ]);
  });

  it("does not invoke native commands before core initialization", async () => {
    const { desktop } = await import("./desktop");
    const fixture = requestFixture();

    await expect(desktop.resolveRunControl(fixture)).rejects.toMatchObject({
      code: "core_not_initialized",
    });
    await expect(desktop.applyRunControl({
      operationId: fixture.operationId,
      idempotencyKey: fixture.idempotencyKey,
    })).rejects.toMatchObject({ code: "core_not_initialized" });
    await expect(desktop.createRunCheckpoint({
      runId: "run_22222222222222222222222222222222",
      stateRevisionId: fixture.stateBase.resolvedStateRevisionId,
      status: "requested",
      disposition: "cooperative-checkpoint",
      cursor: 0,
      contentHash: "f".repeat(64),
      idempotencyKey: "checkpoint:test-uninitialized",
    })).rejects.toMatchObject({ code: "core_not_initialized" });
    await expect(desktop.readRunCheckpoint({
      runId: "run_22222222222222222222222222222222",
    })).rejects.toMatchObject({ code: "core_not_initialized" });
    await expect(desktop.resolveContinuationIntent({
      conversationId: fixture.conversationId,
      branchId: fixture.branchId,
      rootKind: "run",
      rootId: "run_22222222222222222222222222222222",
      intentKind: "unfinished-answer",
      stateRevisionId: fixture.stateBase.resolvedStateRevisionId,
      idempotencyKey: "intent:test-uninitialized",
    })).rejects.toMatchObject({ code: "core_not_initialized" });
    await expect(desktop.resolveMessageRevision({
      conversationId: fixture.conversationId,
      branchId: fixture.branchId,
      messageId: "message_22222222222222222222222222222222",
      kind: "user",
      effect: "edit-draft",
      sourceCursor: 0,
      contentHash: "1".repeat(64),
      redactionClass: "normal",
      idempotencyKey: "message-revision:test-uninitialized",
    })).rejects.toMatchObject({ code: "core_not_initialized" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("uses canonical digest algorithm wire spellings in run-control requests", async () => {
    invokeMock
      .mockResolvedValueOnce(compatibleCore())
      .mockResolvedValueOnce({ operationId: requestFixture().operationId, operationState: "resolved" });
    const { desktop } = await import("./desktop");
    const fixture = requestFixture();

    await desktop.initializeCore("0.1.0");
    await desktop.resolveRunControl(fixture);
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "run_control_resolve",
      { request: expect.objectContaining({
        stateBase: expect.objectContaining({
          resolvedStateDigest: expect.objectContaining({ algorithm: "sha-256" }),
        }),
      }) },
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
  });

  it("allows native-authoritative intents without a renderer state base", async () => {
    invokeMock
      .mockResolvedValueOnce(compatibleCore())
      .mockResolvedValueOnce({
        operationId: requestFixture().operationId,
        operationState: "resolved",
      });
    const { desktop } = await import("./desktop");
    const { stateBase: _rendererHint, ...intent } = requestFixture();

    await desktop.initializeCore("0.1.0");
    await desktop.resolveRunControl(intent);

    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "run_control_resolve",
      { request: intent },
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
  });
});
