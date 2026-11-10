import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const SESSION_TOKEN = "a".repeat(64);

function compatibleCore(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: "1.0",
    serverInfo: {
      name: "omnia-core",
      title: "Omnia Core",
      version: "0.1.0",
    },
    capabilities: ["run.stream.v1", "project.v1"],
    unavailableCapabilities: [],
    sessionToken: SESSION_TOKEN,
    sessionEpoch: 1,
    ...overrides,
  };
}

describe("desktop native IPC session bridge", () => {
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

  it("initializes once and attaches the exact session header to application commands", async () => {
    invokeMock
      .mockResolvedValueOnce(compatibleCore())
      .mockResolvedValueOnce([]);
    const { desktop } = await import("./desktop");

    await desktop.initializeCore("0.1.0");
    await desktop.listProjects();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "core_initialize", {
      request: {
        protocolVersion: "1.0",
        clientInfo: {
          name: "omnia-desktop",
          title: "Omnia Desktop",
          version: "0.1.0",
        },
        capabilities: ["run.stream.v1"],
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "project_list",
      undefined,
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
  });

  it("bridges durable runtime admission and outbox reads without inferring delivery", async () => {
    const receipt = {
      operationId: "runtime_operation_queue_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetKind: "goal",
      targetId: "goal_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      operationKind: "queue",
      effectClass: "reversible_write",
      resultingHeadVersion: 1,
      operationState: "accepted",
      outboxId: "runtime_outbox_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      deliveryAttempt: 1,
      deliveryState: "queued",
      canonicalPayloadSha256: "b".repeat(64),
      durable: true,
      replayed: false,
    };
    const outbox = {
      outboxId: receipt.outboxId,
      operationId: receipt.operationId,
      deliveryAttempt: 1,
      previousOutboxId: null,
      payloadSha256: "c".repeat(64),
      payloadJson: "{}",
      deliveryState: "queued",
      leaseOwner: null,
      leaseExpiresAtMs: null,
      createdAtMs: 1_786_800_000_000,
    };
    invokeMock
      .mockResolvedValueOnce(compatibleCore())
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce(outbox);
    const { desktop } = await import("./desktop");
    const request = {
      operationId: receipt.operationId,
      targetKind: "goal" as const,
      targetId: receipt.targetId,
      operationKind: "queue" as const,
      effectClass: "reversible_write" as const,
      expectedHeadVersion: 0,
      idempotencyKey: "runtime-queue-bridge",
      payloadJson: "{}",
    };

    await desktop.initializeCore("0.1.0");
    await expect(desktop.runtimeOperationAppend(request)).resolves.toEqual(receipt);
    await expect(desktop.readRuntimeOutbox(receipt.operationId)).resolves.toEqual(outbox);

    const sessionHeaders = { headers: { "x-omnia-session": SESSION_TOKEN } };
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "runtime_operation_append",
      { request },
      sessionHeaders,
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      3,
      "runtime_outbox_read",
      { operationId: receipt.operationId },
      sessionHeaders,
    );
  });

  it("keeps runtime discovery and initialize outside the session header", async () => {
    invokeMock
      .mockResolvedValueOnce({
        appName: "Omnia",
        appVersion: "0.1.0",
        platform: "windows",
        tauri: true,
        debug: false,
      })
      .mockResolvedValueOnce(compatibleCore());
    const { desktop } = await import("./desktop");

    await desktop.runtimeInfo();
    await desktop.initializeCore("0.1.0");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "runtime_info");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "core_initialize", {
      request: expect.any(Object),
    });
  });

  it("uses one native initialize invocation for concurrent callers", async () => {
    let resolveInitialize: ((value: unknown) => void) | undefined;
    invokeMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveInitialize = resolve;
      }),
    );
    const { desktop } = await import("./desktop");

    const first = desktop.initializeCore("0.1.0");
    const second = desktop.initializeCore("0.1.0");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    resolveInitialize?.(compatibleCore());

    await expect(Promise.all([first, second])).resolves.toEqual([
      compatibleCore(),
      compatibleCore(),
    ]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("does not expose a session to commands until compatibility validation completes", async () => {
    let resolveInitialize: ((value: unknown) => void) | undefined;
    invokeMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveInitialize = resolve;
      }),
    );
    const { desktop } = await import("./desktop");

    const initialization = desktop.initializeCore("0.1.0");
    await expect(desktop.listProjects()).rejects.toMatchObject({
      code: "core_not_initialized",
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    resolveInitialize?.(compatibleCore());
    await initialization;
    invokeMock.mockResolvedValueOnce([]);
    await desktop.listProjects();

    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "project_list",
      undefined,
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
  });

  it("does not leave a partial renderer session after incompatible initialization", async () => {
    invokeMock
      .mockResolvedValueOnce(compatibleCore({ sessionToken: "invalid" }))
      .mockResolvedValueOnce(compatibleCore())
      .mockResolvedValueOnce([]);
    const { desktop } = await import("./desktop");

    await expect(desktop.initializeCore("0.1.0")).rejects.toThrow("session token");
    await expect(desktop.listProjects()).rejects.toMatchObject({
      code: "core_not_initialized",
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await desktop.initializeCore("0.1.0");
    await desktop.listProjects();
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it("reads telemetry through the initialized session without fabricating a browser fallback", async () => {
    const runId = "run_11111111111111111111111111111111";
    invokeMock
      .mockResolvedValueOnce(compatibleCore())
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runId,
        attempts: [],
        readAtMs: 1_786_800_000_000,
      });
    const { desktop } = await import("./desktop");

    await desktop.initializeCore("0.1.0");
    await expect(desktop.readRunTelemetry({ runId })).resolves.toMatchObject({ runId });

    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "run_telemetry_read",
      { request: { runId } },
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
  });

  it("reads an exact historical provider attempt through the guarded native session", async () => {
    const request = {
      conversationId: "conversation_11111111111111111111111111111111",
      branchId: "branch_11111111111111111111111111111111",
      runId: "run_11111111111111111111111111111111",
      attemptId: "attempt_11111111111111111111111111111111",
    };
    invokeMock
      .mockResolvedValueOnce(compatibleCore())
      .mockResolvedValueOnce({ schemaVersion: 1, ...request });
    const { desktop } = await import("./desktop");

    await expect(desktop.readProviderAttemptLineage(request)).rejects.toMatchObject({
      code: "core_not_initialized",
    });
    await desktop.initializeCore("0.1.0");
    await expect(desktop.readProviderAttemptLineage(request)).resolves.toMatchObject(request);
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "provider_attempt_lineage_read",
      { request },
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
  });

  it("routes immutable state revision append and redacted graph reads through the native session", async () => {
    const conversationId = "conversation_11111111111111111111111111111111";
    const branchId = "branch_11111111111111111111111111111111";
    const mutation = {
      outcome: "applied",
      streamId: "state_stream_11111111111111111111111111111111",
      revisionId: "state_rev_11111111111111111111111111111111",
      acceptedHeadStateRevisionId: "state_rev_11111111111111111111111111111111",
      currentHeadStateRevisionId: "state_rev_11111111111111111111111111111111",
      expectedHeadStateRevisionId: null,
      branchSequence: 0,
      canonicalPayloadHash: "a".repeat(64),
      safeDiff: null,
    };
    const graph = {
      schemaVersion: 1,
      streamId: mutation.streamId,
      conversationId,
      branchId,
      acceptedHeadStateRevisionId: mutation.revisionId,
      acceptedHeadBranchSequence: 0,
      throughBranchSequence: 0,
      revisions: [],
      edges: [],
      integrity: "valid",
      revisionsHasMore: false,
      edgesHasMore: false,
      nextRevisionsCursor: null,
      nextEdgesCursor: null,
      revisionsLimit: 250,
      edgesLimit: 250,
      responseBytes: 0,
    };
    invokeMock
      .mockResolvedValueOnce(compatibleCore())
      .mockResolvedValueOnce(mutation)
      .mockResolvedValueOnce(graph);
    const { desktop } = await import("./desktop");

    await desktop.initializeCore("0.1.0");
    await expect(
      desktop.appendStateRevision({
        conversationId,
        branchId,
        kind: "root",
        status: "accepted",
        idempotencyKey: "operation-1",
      }),
    ).resolves.toMatchObject({ outcome: "applied", revisionId: mutation.revisionId });
    await expect(
      desktop.readStateRevisionGraph({
        conversationId,
        branchId,
        throughBranchSequence: 0,
      }),
    ).resolves.toMatchObject({ streamId: mutation.streamId, integrity: "valid" });

    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "state_revision_append",
      {
        request: {
          conversationId,
          branchId,
          kind: "root",
          status: "accepted",
          idempotencyKey: "operation-1",
        },
      },
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      3,
      "state_revision_graph_read",
      { request: { conversationId, branchId, throughBranchSequence: 0 } },
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
  });

  it("preserves revision-head CAS fields and exposes enabled-only workflow updates", async () => {
    const goalId = "goal_11111111111111111111111111111111";
    const taskId = "task_11111111111111111111111111111111";
    const starterWorkflowId = "starter_workflow_11111111111111111111111111111111";
    const expectedGoalRevisionId = "goal_revision_11111111111111111111111111111111";
    const expectedTaskRevisionId = "task_revision_11111111111111111111111111111111";
    const expectedWorkflowRevisionId = "starter_workflow_revision_11111111111111111111111111111111";
    invokeMock
      .mockResolvedValueOnce(compatibleCore())
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const { desktop } = await import("./desktop");

    await desktop.initializeCore("0.1.0");
    await desktop.createGoalRevision({
      goalId,
      expectedCurrentRevisionId: expectedGoalRevisionId,
      stateRevisionId: "state_rev_11111111111111111111111111111111",
      payloadJson: "{}",
      idempotencyKey: "goal-revision-cas-1",
    });
    await desktop.createTaskRevision({
      taskId,
      expectedCurrentRevisionId: expectedTaskRevisionId,
      stateRevisionId: "state_rev_11111111111111111111111111111111",
      payloadJson: "{}",
      idempotencyKey: "task-revision-cas-1",
    });
    await desktop.createStarterWorkflowRevision({
      starterWorkflowId,
      expectedCurrentRevisionId: expectedWorkflowRevisionId,
      stateRevisionId: "state_rev_11111111111111111111111111111111",
      definitionJson: "{}",
      idempotencyKey: "workflow-revision-cas-1",
    });
    await desktop.updateStarterWorkflowEnabled({
      starterWorkflowId,
      enabled: true,
      expectedUpdatedAtMs: 1_786_800_000_000,
      idempotencyKey: "workflow-enabled-1",
    });

    const sessionHeaders = { headers: { "x-omnia-session": SESSION_TOKEN } };
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "goal_revision_create",
      {
        request: {
          goalId,
          expectedCurrentRevisionId: expectedGoalRevisionId,
          stateRevisionId: "state_rev_11111111111111111111111111111111",
          payloadJson: "{}",
          idempotencyKey: "goal-revision-cas-1",
        },
      },
      sessionHeaders,
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      3,
      "task_revision_create",
      {
        request: {
          taskId,
          expectedCurrentRevisionId: expectedTaskRevisionId,
          stateRevisionId: "state_rev_11111111111111111111111111111111",
          payloadJson: "{}",
          idempotencyKey: "task-revision-cas-1",
        },
      },
      sessionHeaders,
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      4,
      "starter_workflow_revision_create",
      {
        request: {
          starterWorkflowId,
          expectedCurrentRevisionId: expectedWorkflowRevisionId,
          stateRevisionId: "state_rev_11111111111111111111111111111111",
          definitionJson: "{}",
          idempotencyKey: "workflow-revision-cas-1",
        },
      },
      sessionHeaders,
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      5,
      "starter_workflow_enabled_update",
      {
        request: {
          starterWorkflowId,
          enabled: true,
          expectedUpdatedAtMs: 1_786_800_000_000,
          idempotencyKey: "workflow-enabled-1",
        },
      },
      sessionHeaders,
    );
  });

  it("keeps state-revision IPC fail-closed in browser preview", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined,
    });
    const { desktop } = await import("./desktop");

    await expect(
      desktop.appendStateRevision({
        conversationId: "conversation_11111111111111111111111111111111",
        branchId: "branch_11111111111111111111111111111111",
        kind: "root",
        status: "accepted",
        idempotencyKey: "operation-1",
      }),
    ).rejects.toThrow("requires the Tauri desktop runtime");
    await expect(
      desktop.readStateRevisionGraph({
        conversationId: "conversation_11111111111111111111111111111111",
        branchId: "branch_11111111111111111111111111111111",
      }),
    ).rejects.toThrow("requires the Tauri desktop runtime");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("routes run-control, checkpoint, continuation and message-revision contracts through the native session", async () => {
    const conversationId = "conversation_11111111111111111111111111111111";
    const branchId = "branch_11111111111111111111111111111111";
    const operationId = "operation_11111111111111111111111111111111";
    const checkpointId = "checkpoint_11111111111111111111111111111111";
    const intentId = "intent_11111111111111111111111111111111";
    const revisionId = "message_revision_111111111111111111111111";
    invokeMock
      .mockResolvedValueOnce(compatibleCore())
      .mockResolvedValueOnce({ operationId, operationState: "resolved" })
      .mockResolvedValueOnce({ operationId, outcome: "applied" })
      .mockResolvedValueOnce({ checkpointId, status: "paused" })
      .mockResolvedValueOnce({ checkpointId, status: "paused" })
      .mockResolvedValueOnce({ intentId, intentKind: "unfinished-answer" })
      .mockResolvedValueOnce({ revisionId, effect: "edit-draft" });
    const { desktop } = await import("./desktop");

    await desktop.initializeCore("0.1.0");
    await desktop.resolveRunControl({
      schemaVersion: 2,
      operationId,
      conversationId,
      branchId,
      kind: "continue",
      stateBase: {
        mode: "current-state",
        sourceStateRevisionId: "state_rev_11111111111111111111111111111111",
        requestedHeadStateRevisionId: "state_rev_11111111111111111111111111111111",
        resolvedStateRevisionId: "state_rev_11111111111111111111111111111111",
        resolvedStateDigest: {
          algorithm: "sha-256",
          canonicalizationRevision: "state-revision-c14n-v1",
          value: "a".repeat(64),
        },
        selectedDeltaIds: [],
        contextManifestId: null,
        resolutionReason: "current-branch-head",
        resolvedAt: "2026-09-11T00:00:00Z",
        resolvedAtCursors: [{
          streamKind: "branch",
          streamId: branchId,
          sequence: 0,
          journalEpoch: null,
          eventId: null,
          payloadHash: null,
        }],
      },
      actor: { kind: "user", id: "user_local" },
      idempotencyKey: "operation-key-1",
      continuationIntent: "unfinished-answer",
      activeRunPolicy: "queue-after-terminal",
      compareStateRevisionIds: [],
      mergeStateRevisionIds: [],
      createdAt: "2026-09-11T00:00:00Z",
    });
    await desktop.applyRunControl({ operationId, idempotencyKey: "operation-key-1" });
    await desktop.createRunCheckpoint({
      runId: "run_11111111111111111111111111111111",
      stateRevisionId: "state_rev_11111111111111111111111111111111",
      status: "requested",
      disposition: "cooperative-checkpoint",
      cursor: 4,
      providerAcceptance: "accepted",
      contentHash: "a".repeat(64),
      idempotencyKey: "checkpoint-key-1",
    });
    await desktop.readRunCheckpoint({ runId: "run_11111111111111111111111111111111", checkpointId });
    await desktop.resolveContinuationIntent({
      conversationId,
      branchId,
      rootKind: "run",
      rootId: "run_11111111111111111111111111111111",
      intentKind: "unfinished-answer",
      stateRevisionId: "state_rev_11111111111111111111111111111111",
      idempotencyKey: "intent-key-1",
    });
    await desktop.resolveMessageRevision({
      conversationId,
      branchId,
      messageId: "message_11111111111111111111111111111111",
      kind: "user",
      effect: "edit-draft",
      sourceCursor: 3,
      contentHash: "b".repeat(64),
      redactionClass: "normal",
      idempotencyKey: "revision-key-1",
    });

    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "run_control_resolve",
      {
        request: {
          conversationId,
          branchId,
          schemaVersion: 2,
          operationId,
          kind: "continue",
          stateBase: {
            mode: "current-state",
            sourceStateRevisionId: "state_rev_11111111111111111111111111111111",
            requestedHeadStateRevisionId: "state_rev_11111111111111111111111111111111",
            resolvedStateRevisionId: "state_rev_11111111111111111111111111111111",
            resolvedStateDigest: {
              algorithm: "sha-256",
              canonicalizationRevision: "state-revision-c14n-v1",
              value: "a".repeat(64),
            },
            selectedDeltaIds: [],
            contextManifestId: null,
            resolutionReason: "current-branch-head",
            resolvedAt: "2026-09-11T00:00:00Z",
            resolvedAtCursors: [{
              streamKind: "branch",
              streamId: branchId,
              sequence: 0,
              journalEpoch: null,
              eventId: null,
              payloadHash: null,
            }],
          },
          actor: { kind: "user", id: "user_local" },
          idempotencyKey: "operation-key-1",
          continuationIntent: "unfinished-answer",
          activeRunPolicy: "queue-after-terminal",
          compareStateRevisionIds: [],
          mergeStateRevisionIds: [],
          createdAt: "2026-09-11T00:00:00Z",
        },
      },
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      3,
      "run_control_apply",
      { request: { operationId, idempotencyKey: "operation-key-1" } },
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      4,
      "checkpoint_create",
      {
        request: {
          runId: "run_11111111111111111111111111111111",
          stateRevisionId: "state_rev_11111111111111111111111111111111",
          status: "requested",
          disposition: "cooperative-checkpoint",
          cursor: 4,
          providerAcceptance: "accepted",
          contentHash: "a".repeat(64),
          idempotencyKey: "checkpoint-key-1",
        },
      },
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      5,
      "checkpoint_read",
      { request: { runId: "run_11111111111111111111111111111111", checkpointId } },
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      6,
      "continuation_intent_resolve",
      {
        request: {
          conversationId,
          branchId,
          rootKind: "run",
          rootId: "run_11111111111111111111111111111111",
          intentKind: "unfinished-answer",
          stateRevisionId: "state_rev_11111111111111111111111111111111",
          idempotencyKey: "intent-key-1",
        },
      },
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      7,
      "message_revision_resolve",
      {
        request: {
          conversationId,
          branchId,
          messageId: "message_11111111111111111111111111111111",
          kind: "user",
          effect: "edit-draft",
          sourceCursor: 3,
          contentHash: "b".repeat(64),
          redactionClass: "normal",
          idempotencyKey: "revision-key-1",
        },
      },
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
  });

  it("keeps run-control contracts fail-closed in browser preview", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined,
    });
    const { desktop } = await import("./desktop");

    await expect(
      desktop.resolveRunControl({
        schemaVersion: 2,
        operationId: "operation_11111111111111111111111111111111",
        conversationId: "conversation_11111111111111111111111111111111",
        branchId: "branch_11111111111111111111111111111111",
        kind: "continue",
        stateBase: {
          mode: "fresh-goal-start",
          sourceStateRevisionId: null,
          requestedHeadStateRevisionId: null,
          resolvedStateRevisionId: "state_rev_11111111111111111111111111111111",
          resolvedStateDigest: {
          algorithm: "sha-256",
            canonicalizationRevision: "state-revision-c14n-v1",
            value: "a".repeat(64),
          },
          selectedDeltaIds: [],
          contextManifestId: null,
          resolutionReason: "fresh-goal-bootstrap",
          resolvedAt: "2026-09-11T00:00:00Z",
          resolvedAtCursors: [{
            streamKind: "branch",
            streamId: "branch_11111111111111111111111111111111",
            sequence: 0,
            journalEpoch: null,
            eventId: null,
            payloadHash: null,
          }],
        },
        actor: { kind: "user", id: "user_local" },
        idempotencyKey: "operation-key-1",
        continuationIntent: "unfinished-answer",
        activeRunPolicy: "not-applicable",
        compareStateRevisionIds: [],
        mergeStateRevisionIds: [],
        createdAt: "2026-09-11T00:00:00Z",
      }),
    ).rejects.toThrow("requires the Tauri desktop runtime");
    await expect(
      desktop.readRunCheckpoint({ runId: "run_11111111111111111111111111111111" }),
    ).rejects.toThrow("requires the Tauri desktop runtime");
    await expect(
      desktop.resolveContinuationIntent({
        conversationId: "conversation_11111111111111111111111111111111",
        branchId: "branch_11111111111111111111111111111111",
        rootKind: "run",
        rootId: "run_11111111111111111111111111111111",
        intentKind: "unfinished-answer",
        stateRevisionId: "state_rev_11111111111111111111111111111111",
        idempotencyKey: "intent-key-1",
      }),
    ).rejects.toThrow("requires the Tauri desktop runtime");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not invent a watermark when reading the live graph head", async () => {
    const conversationId = "conversation_11111111111111111111111111111111";
    const branchId = "branch_11111111111111111111111111111111";
    invokeMock
      .mockResolvedValueOnce(compatibleCore())
      .mockResolvedValueOnce({
        schemaVersion: 1,
        streamId: "state_stream_11111111111111111111111111111111",
        conversationId,
        branchId,
        acceptedHeadStateRevisionId: null,
        acceptedHeadBranchSequence: 0,
        throughBranchSequence: 0,
        revisions: [],
        edges: [],
        integrity: "valid",
        revisionsHasMore: false,
        edgesHasMore: false,
        nextRevisionsCursor: null,
        nextEdgesCursor: null,
        revisionsLimit: 250,
        edgesLimit: 250,
        responseBytes: 0,
      });
    const { desktop } = await import("./desktop");

    await desktop.initializeCore("0.1.0");
    await desktop.readStateRevisionGraph({ conversationId, branchId });

    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "state_revision_graph_read",
      { request: { conversationId, branchId } },
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
  });

  it("does not replay a mutable command when native reports a stale session", async () => {
    invokeMock
      .mockResolvedValueOnce(compatibleCore())
      .mockRejectedValueOnce({
        code: "core_session_stale",
        message: "The session is stale",
        retryable: false,
      });
    const { desktop } = await import("./desktop");

    await desktop.initializeCore("0.1.0");
    await expect(desktop.createProject({ name: "No replay" })).rejects.toMatchObject({
      code: "core_session_stale",
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls.filter(([command]) => command === "project_create")).toHaveLength(1);
  });

  it("updates project metadata through the initialized native session", async () => {
    const project = {
      id: "project_11111111111111111111111111111111",
      name: "Updated",
      description: "Description",
      instructions: null,
      createdAtMs: 1_786_800_000_000,
      updatedAtMs: 1_786_800_000_001,
    };
    invokeMock
      .mockResolvedValueOnce(compatibleCore())
      .mockResolvedValueOnce(project);
    const { desktop } = await import("./desktop");

    await desktop.initializeCore("0.1.0");
    await expect(
      desktop.updateProjectMetadata({
        projectId: project.id,
        name: "Updated",
        description: "Description",
        expectedUpdatedAtMs: 1_786_800_000_000,
      }),
    ).resolves.toEqual(project);

    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "project_update",
      {
        request: {
          projectId: project.id,
          name: "Updated",
          description: "Description",
          expectedUpdatedAtMs: 1_786_800_000_000,
        },
      },
      { headers: { "x-omnia-session": SESSION_TOKEN } },
    );
  });

  it("does not fabricate a native session in browser preview", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined,
    });
    const { desktop } = await import("./desktop");

    await expect(desktop.initializeCore("0.1.0")).resolves.toMatchObject({
      sessionToken: null,
      sessionEpoch: null,
    });
    await expect(
      desktop.readRunTelemetry({ runId: "run_11111111111111111111111111111111" }),
    ).rejects.toThrow("requires the Tauri desktop runtime");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
