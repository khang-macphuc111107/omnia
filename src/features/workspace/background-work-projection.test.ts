import { describe, expect, it } from "vitest";

import { projectBackgroundWork } from "./background-work-projection";
import type { ConversationView } from "./types";
import type { RunTimelineEventView } from "./evidence-types";
import type {
  RunCheckpointRecord,
  ResolvedRunControlOperation,
} from "@/lib/desktop";
import type {
  RunCheckpointProjection,
  RunControlOperationProjection,
} from "./run-control-projection";

const runId = "run_background_0123456789abcdef0123456789abcdef";

function conversation(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id: "conversation-background",
    activeBranchId: "branch-background",
    title: "Background design",
    excerpt: "",
    updatedAt: "2026-09-19T00:00:04.000Z",
    updatedLabel: "now",
    projectId: null,
    projectName: null,
    pinned: false,
    archived: false,
    hasDraft: false,
    unread: false,
    runState: null,
    draft: "",
    messages: [],
    ...overrides,
  };
}

function event(overrides: Partial<RunTimelineEventView> = {}): RunTimelineEventView {
  return {
    id: "run-event-background-1",
    runId,
    parentEventId: null,
    sequence: 1,
    type: "run.started",
    stage: "provider",
    status: "running",
    summary: "Provider stream started",
    detail: null,
    startedAt: "2026-09-19T00:00:01.000Z",
    endedAt: null,
    source: "provider",
    providerLabel: "Model preview",
    attemptOrdinal: 1,
    citationIds: [],
    ...overrides,
  };
}

function runControlProjection(
  overrides: Partial<RunControlOperationProjection> = {},
): RunControlOperationProjection {
  return {
    operation: {
      operationId: "operation_background_0123456789abcdef0123456789abcdef",
      kind: "pause",
      conversationId: "conversation-background",
      sourceRunId: runId,
      stateBase: { resolvedAt: "2026-09-19T00:00:06.000Z" },
      createdAt: "2026-09-19T00:00:05.000Z",
    } as unknown as ResolvedRunControlOperation,
    status: "resolved",
    durability: "unknown",
    stateRevisionId: null,
    resultRunId: null,
    resultAttemptId: null,
    checkpointId: null,
    blockedReason: null,
    diagnostic: null,
    ...overrides,
  };
}

function checkpointProjection(
  overrides: Partial<RunCheckpointProjection> = {},
): RunCheckpointProjection {
  return {
    checkpoint: {
      checkpointId: "checkpoint_background_0123456789abcdef0123456789abcdef",
      runId,
      status: "paused",
      createdAt: "2026-09-19T00:00:07.000Z",
    } as unknown as RunCheckpointRecord,
    resumable: true,
    reconciliationRequired: false,
    warning: null,
    ...overrides,
  };
}

describe("background-work projection", () => {
  it("projects visible queued, running, and failed Chat states with attention counts", () => {
    const projection = projectBackgroundWork({
      generatedAt: "2026-09-19T00:00:05.000Z",
      conversations: [
        conversation({ id: "streaming", runState: "streaming" }),
        conversation({ id: "queued", runState: "queued" }),
        conversation({ id: "failed", runState: "failed" }),
      ],
    });

    expect(projection.counts).toEqual({
      total: 3,
      active: 1,
      queued: 1,
      waiting: 0,
      attention: 1,
      completed: 0,
    });
    expect(projection.items.map((item) => item.state)).toEqual(["attention", "running", "queued"]);
    expect(projection.items.every((item) => item.durability === "renderer-session")).toBe(true);
    expect(projection.boundary).toMatch(/does not schedule work/i);
  });

  it("prefers the latest replayed timeline fact over a duplicate Chat run card", () => {
    const projection = projectBackgroundWork({
      conversations: [
        conversation({
          runState: "streaming",
          messages: [
            {
              id: "assistant-background",
              role: "assistant",
              content: "partial",
              createdAt: "2026-09-19T00:00:01.000Z",
              status: "streaming",
              modelLabel: "Model preview",
              runId,
              attachments: [],
              branchIndex: 1,
              branchCount: 1,
            },
          ],
        }),
      ],
      runTimelineEvents: [
        event(),
        event({
          id: "run-event-background-2",
          sequence: 2,
          status: "failed",
          type: "run.failed",
          summary: "Run failed",
          detail: "Provider outcome is unknown",
          endedAt: "2026-09-19T00:00:03.000Z",
        }),
      ],
    });

    expect(projection.items).toHaveLength(1);
    expect(projection.items[0]).toMatchObject({
      id: `run:${runId}`,
      state: "attention",
      durability: "native-projection",
      detail: "Provider/model: Model preview",
    });
  });

  it("keeps missing scheduler/task capabilities explicit instead of inventing queue rows", () => {
    const projection = projectBackgroundWork({ conversations: [] });

    expect(projection.items).toEqual([]);
    expect(projection.counts.total).toBe(0);
    expect(projection.missingCapabilities).toEqual(
      expect.arrayContaining(["durable task/goal queue", "approval inbox", "scheduler and trigger persistence"]),
    );
  });

  it("retains separate native evidence layers and maps run-control/checkpoint states", () => {
    const projection = projectBackgroundWork({
      conversations: [],
      runControlOperations: [
        runControlProjection({
          operation: {
            operationId: "operation-resolved",
            kind: "pause",
            conversationId: "conversation-background",
            sourceRunId: runId,
            stateBase: { resolvedAt: "2026-09-19T00:00:06.000Z" },
            createdAt: "2026-09-19T00:00:05.000Z",
          } as unknown as ResolvedRunControlOperation,
          status: "resolved",
        }),
        runControlProjection({
          operation: {
            operationId: "operation-blocked",
            kind: "resume",
            conversationId: "conversation-background",
            sourceRunId: runId,
            stateBase: { resolvedAt: "2026-09-19T00:00:08.000Z" },
            createdAt: "2026-09-19T00:00:07.000Z",
          } as unknown as ResolvedRunControlOperation,
          status: "blocked",
          durability: "replayed",
          blockedReason: "checkpoint is not ready",
        }),
      ],
      checkpoints: [
        checkpointProjection({
          checkpoint: {
            checkpointId: "checkpoint-running",
            runId,
            status: "checkpointing",
            createdAt: "2026-09-19T00:00:09.000Z",
          } as unknown as RunCheckpointRecord,
        }),
        checkpointProjection({
          checkpoint: {
            checkpointId: "checkpoint-reconciliation",
            runId,
            status: "paused",
            createdAt: "2026-09-19T00:00:10.000Z",
          } as unknown as RunCheckpointRecord,
          resumable: false,
          reconciliationRequired: true,
          warning: "Provider outcome requires reconciliation.",
        }),
      ],
    });

    expect(projection.items.map((item) => [item.id, item.state])).toEqual([
      ["checkpoint:checkpoint-reconciliation", "attention"],
      ["control:operation-blocked", "attention"],
      ["checkpoint:checkpoint-running", "running"],
      ["control:operation-resolved", "waiting"],
    ]);
    expect(projection.items.find((item) => item.id === "control:operation-blocked")).toMatchObject({
      durability: "native-projection",
      attention: true,
      detail: "checkpoint is not ready",
      actions: ["inspect"],
    });
    expect(projection.counts).toMatchObject({ total: 4, active: 1, waiting: 1, attention: 2 });
  });

  it("uses the higher event sequence and deterministic ID tie-breaker for replayed timeline facts", () => {
    const projection = projectBackgroundWork({
      conversations: [],
      runTimelineEvents: [
        event({ id: "event-z", sequence: 4, status: "running", summary: "Later ID" }),
        event({ id: "event-a", sequence: 4, status: "failed", summary: "Earlier ID" }),
        event({ id: "event-old", sequence: 3, status: "complete", summary: "Older sequence" }),
      ],
    });

    expect(projection.items).toHaveLength(1);
    expect(projection.items[0]).toMatchObject({
      id: `run:${runId}`,
      state: "running",
      subtitle: "Later ID",
    });
  });

  it("falls back to an epoch timestamp for malformed dates without breaking deterministic ordering", () => {
    const projection = projectBackgroundWork({
      conversations: [
        conversation({ id: "invalid-date", title: "Invalid date", updatedAt: "not-a-date", runState: "streaming" }),
        conversation({ id: "valid-date", title: "Valid date", updatedAt: "2026-09-19T00:00:11.000Z", runState: "streaming" }),
      ],
    });

    expect(projection.items.map((item) => item.title)).toEqual(["Valid date", "Invalid date"]);
    expect(projection.items.find((item) => item.title === "Invalid date")?.updatedAt).toBe("1970-01-01T00:00:00.000Z");
  });
});
