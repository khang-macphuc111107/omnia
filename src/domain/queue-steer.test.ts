import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import {
  applyQueueBulkAction,
  createQueueItem,
  createQueueState,
  enqueueQueueItem,
  promoteBtwItem,
  projectQueueReadiness,
  readyQueueItems,
  reorderQueueItems,
  setQueueStatus,
  undoQueueReorder,
  validateQueueState,
  validateQueueItems,
} from "./queue-steer";

const now = "2026-09-15T00:00:00.000Z";
const later = "2026-09-15T00:01:00.000Z";

function item(
  itemId: string,
  mode: "queue" | "steer" | "btw" | "parallel" | "scheduled" = "queue",
  extra: Partial<Parameters<typeof createQueueItem>[0]> = {},
) {
  return createQueueItem({ itemId, mode, orderKey: itemId, createdAt: now, ...extra });
}

describe("queue-steer renderer domain", () => {
  it("creates immutable queue items and enforces scheduled/draft invariants", () => {
    const scheduled = item("scheduled", "scheduled", { scheduledAt: later });
    expect(scheduled.status).toBe("queued");
    expect(Object.isFrozen(scheduled)).toBe(true);
    expect(() => item("missing-time", "scheduled")).toThrowError(DomainError);
    expect(() => createQueueItem({ itemId: "draft", mode: "draft", status: "queued", orderKey: "1", createdAt: now })).toThrowError(DomainError);
  });

  it("rejects unknown dependencies and cycles before a queue can be projected", () => {
    const first = item("first");
    const unknown = item("unknown", "queue", { dependencyIds: ["absent"] });
    expect(() => validateQueueItems([first, unknown])).toThrowError(DomainError);

    const cycleA = item("cycle-a", "queue", { dependencyIds: ["cycle-b"] });
    const cycleB = item("cycle-b", "queue", { dependencyIds: ["cycle-a"] });
    expect(() => validateQueueItems([cycleA, cycleB])).toThrowError(DomainError);
    expect(() => validateQueueItems([cycleA, cycleB])).toThrowError(/Queue dependency cycle/);
  });

  it("rejects self-conflicts and queue snapshots whose lifecycle timestamps are in the future", () => {
    expect(() => item("self-conflict", "queue", { conflictSet: ["self-conflict"] })).toThrowError(DomainError);
    const future = "2026-09-15T00:02:00.000Z";
    const futureItem = item("future", "queue", { createdAt: future, updatedAt: future });
    expect(() => createQueueState({ queueId: "queue-1", now, items: [futureItem] })).toThrowError(DomainError);
  });

  it("fails closed for malformed raw queue item records", () => {
    const base = item("raw");
    const malformedRecords = [
      { ...base, orderKey: "   " },
      { ...base, priority: 1.25 },
      { ...base, contextPolicy: "unsupported" },
      { ...base, effort: "unsupported" },
      { ...base, approvalPolicy: { required: "yes" } },
      { ...base, approvalPolicy: { required: true, unexpected: true } },
      { ...base, retryPolicy: { maxAttempts: "many" } },
      { ...base, retryPolicy: { maxAttempts: 1, unexpected: true } },
      { ...base, provenance: { actorId: "" } },
      { ...base, provenance: { actorId: "actor", unexpected: true } },
      { ...base, unexpected: true },
      { ...base, dependencyIds: "not-an-array" },
      { ...base, conflictSet: "not-an-array" },
    ];
    for (const malformed of malformedRecords) {
      expect(() => validateQueueItems([malformed as unknown as Parameters<typeof validateQueueItems>[0][number]])).toThrowError(DomainError);
    }
    expect(() => createQueueItem({ ...base, unexpected: true } as unknown as Parameters<typeof createQueueItem>[0])).toThrowError(DomainError);
  });

  it("rejects malformed runtime inputs instead of silently coercing them", () => {
    const state = createQueueState({ queueId: "queue-1", now, items: [item("a"), item("b")] });
    expect(() => projectQueueReadiness(state, now, [123 as unknown as string])).toThrowError(DomainError);
    expect(() => reorderQueueItems(state, {
      expectedRevision: 0,
      operationId: "bad-reorder-input",
      orderedItemIds: ["a", 3 as unknown as string],
      now: later,
    })).toThrowError(DomainError);
    expect(() => applyQueueBulkAction(state, {
      expectedRevision: 0,
      operationId: "bad-bulk-action",
      itemIds: ["a"],
      action: "future-action" as never,
      now: later,
    })).toThrowError(DomainError);
  });

  it("bounds queue size and validates a maximum-depth dependency chain iteratively", () => {
    const oversized = Array.from({ length: 4097 }, (_, index) => item(`oversized-${index}`));
    expect(() => validateQueueItems(oversized)).toThrowError(DomainError);

    const full = Array.from({ length: 4096 }, (_, index) => item(`full-${index}`));
    const fullState = createQueueState({ queueId: "full-queue", now, items: full });
    expect(() => enqueueQueueItem(fullState, item("overflow"), {
      expectedRevision: 0,
      operationId: "overflow-enqueue",
      now: later,
    })).toThrowError(DomainError);

    const chain = Array.from({ length: 4096 }, (_, index) => item(
      `chain-${index}`,
      "queue",
      { dependencyIds: index === 0 ? [] : [`chain-${index - 1}`] },
    ));
    expect(() => validateQueueItems(chain)).not.toThrow();
  });

  it("keeps reserved item IDs safe across reorder receipts, JSON hydration, and undo", () => {
    const reservedIds = ["__proto__", "constructor", "prototype"];
    const state = createQueueState({
      queueId: "reserved-queue",
      now,
      items: reservedIds.map((itemId) => item(itemId, "queue", { orderKey: `original-${itemId}` })),
    });
    const reordered = reorderQueueItems(state, {
      expectedRevision: 0,
      operationId: "reserved-reorder",
      orderedItemIds: ["prototype", "__proto__", "constructor"],
      now: later,
    });

    expect(Object.getPrototypeOf(reordered.receipt.previousOrderKeys)).toBeNull();
    expect(Object.getPrototypeOf(reordered.receipt.nextOrderKeys)).toBeNull();
    expect(() => validateQueueState(reordered.state)).not.toThrow();

    const hydratedReceipt = JSON.parse(JSON.stringify(reordered.receipt)) as typeof reordered.receipt;
    const undone = undoQueueReorder(reordered.state, hydratedReceipt, {
      expectedRevision: 1,
      operationId: "reserved-undo",
      now: later,
    });
    expect(new Map(undone.state.items.map((candidate) => [candidate.itemId, candidate.orderKey]))).toEqual(new Map([
      ["__proto__", "original-__proto__"],
      ["constructor", "original-constructor"],
      ["prototype", "original-prototype"],
    ]));
  });

  it("rejects every queue mutation against an archived queue, including stale undo receipts", () => {
    const active = createQueueState({ queueId: "archived-queue", now, items: [item("a"), item("btw", "btw")] });
    const archived = setQueueStatus(active, {
      expectedRevision: 0,
      operationId: "archive",
      status: "archived",
      now: later,
    });

    expect(() => enqueueQueueItem(archived.state, item("added"), {
      expectedRevision: 1,
      operationId: "archived-enqueue",
      now: later,
    })).toThrowError(DomainError);
    expect(() => reorderQueueItems(archived.state, {
      expectedRevision: 1,
      operationId: "archived-reorder",
      orderedItemIds: ["a", "btw"],
      now: later,
    })).toThrowError(DomainError);
    expect(() => applyQueueBulkAction(archived.state, {
      expectedRevision: 1,
      operationId: "archived-bulk",
      itemIds: ["a"],
      action: "pause",
      now: later,
    })).toThrowError(DomainError);
    expect(() => promoteBtwItem(archived.state, {
      expectedRevision: 1,
      operationId: "archived-promote",
      itemId: "btw",
      now: later,
    })).toThrowError(DomainError);
    expect(() => setQueueStatus(archived.state, {
      expectedRevision: 1,
      operationId: "archived-reactivate",
      status: "active",
      now: later,
    })).toThrowError(DomainError);

    const reordered = reorderQueueItems(active, {
      expectedRevision: 0,
      operationId: "reorder-before-archive",
      orderedItemIds: ["btw", "a"],
      now: later,
    });
    const archivedAfterReorder = setQueueStatus(reordered.state, {
      expectedRevision: 1,
      operationId: "archive-after-reorder",
      status: "archived",
      now: later,
    });
    expect(() => undoQueueReorder(archivedAfterReorder.state, reordered.receipt, {
      expectedRevision: 2,
      operationId: "archived-undo",
      now: later,
    })).toThrowError(DomainError);
  });

  it("fails closed with DomainError for erased public-boundary state, input, and collection values", () => {
    const state = createQueueState({ queueId: "boundary-queue", now, items: [item("a"), item("btw", "btw")] });
    const reordered = reorderQueueItems(state, {
      expectedRevision: 0,
      operationId: "boundary-reorder",
      orderedItemIds: ["btw", "a"],
      now: later,
    });

    expect(() => createQueueItem(null as never)).toThrowError(DomainError);
    expect(() => createQueueState(null as never)).toThrowError(DomainError);
    expect(() => validateQueueItems(null as never)).toThrowError(DomainError);
    expect(() => validateQueueState(null as never)).toThrowError(DomainError);
    expect(() => projectQueueReadiness(state, now, null as never)).toThrowError(DomainError);
    expect(() => readyQueueItems(state, now, null as never)).toThrowError(DomainError);
    expect(() => projectQueueReadiness(state, null as never)).toThrowError(DomainError);
    expect(() => readyQueueItems(state, null as never)).toThrowError(DomainError);
    expect(() => projectQueueReadiness(null as never, now)).toThrowError(DomainError);
    expect(() => enqueueQueueItem(null as never, item("added"), null as never)).toThrowError(DomainError);
    expect(() => enqueueQueueItem(state, item("timestamp-enqueue"), {
      expectedRevision: 0,
      operationId: "null-enqueue-time",
      now: null as never,
    })).toThrowError(DomainError);
    expect(() => reorderQueueItems(state, {
      expectedRevision: 0,
      operationId: "null-reorder-list",
      orderedItemIds: null as unknown as readonly string[],
      now: later,
    })).toThrowError(DomainError);
    expect(() => reorderQueueItems(state, {
      expectedRevision: 0,
      operationId: "null-reorder-time",
      orderedItemIds: ["btw", "a"],
      now: null as never,
    })).toThrowError(DomainError);
    expect(() => undoQueueReorder(reordered.state, reordered.receipt, null as never)).toThrowError(DomainError);
    expect(() => undoQueueReorder(reordered.state, reordered.receipt, {
      expectedRevision: 1,
      operationId: "null-undo-time",
      now: null as never,
    })).toThrowError(DomainError);
    expect(() => applyQueueBulkAction(state, {
      expectedRevision: 0,
      operationId: "null-bulk-list",
      itemIds: null as unknown as readonly string[],
      action: "pause",
      now: later,
    })).toThrowError(DomainError);
    expect(() => applyQueueBulkAction(state, {
      expectedRevision: 0,
      operationId: "null-bulk-time",
      itemIds: ["a"],
      action: "pause",
      now: null as never,
    })).toThrowError(DomainError);
    expect(() => promoteBtwItem(state, null as never)).toThrowError(DomainError);
    expect(() => promoteBtwItem(state, {
      expectedRevision: 0,
      operationId: "null-promote-time",
      itemId: "btw",
      now: null as never,
    })).toThrowError(DomainError);
    expect(() => setQueueStatus(state, null as never)).toThrowError(DomainError);
    expect(() => setQueueStatus(state, {
      expectedRevision: 0,
      operationId: "null-status-time",
      status: "paused",
      now: null as never,
    })).toThrowError(DomainError);
  });

  it("enforces lifecycle and temporal invariants for items, mutations, and receipts", () => {
    for (const status of ["queued", "paused"] as const) {
      expect(() => createQueueItem({
        itemId: `started-${status}`,
        mode: "queue",
        status,
        orderKey: `started-${status}`,
        createdAt: now,
        updatedAt: later,
        startedAt: now,
      })).toThrowError(DomainError);
    }
    expect(() => createQueueItem({
      itemId: "started-draft",
      mode: "draft",
      status: "draft",
      orderKey: "started-draft",
      createdAt: now,
      updatedAt: later,
      startedAt: now,
    })).toThrowError(DomainError);

    for (const status of ["completed", "cancelled", "failed"] as const) {
      expect(() => createQueueItem({
        itemId: `missing-completion-${status}`,
        mode: "queue",
        status,
        orderKey: `missing-completion-${status}`,
        createdAt: now,
        updatedAt: later,
      })).toThrowError(DomainError);
    }
    expect(() => createQueueItem({
      itemId: "queued-completion",
      mode: "queue",
      status: "queued",
      orderKey: "queued-completion",
      createdAt: now,
      updatedAt: later,
      completedAt: later,
    })).toThrowError(DomainError);
    expect(() => createQueueItem({
      itemId: "removed-completion",
      mode: "queue",
      status: "removed",
      orderKey: "removed-completion",
      createdAt: now,
      updatedAt: later,
      completedAt: later,
    })).toThrowError(DomainError);
    expect(() => createQueueItem({
      itemId: "completion-before-start",
      mode: "queue",
      status: "completed",
      orderKey: "completion-before-start",
      createdAt: now,
      updatedAt: later,
      startedAt: later,
      completedAt: now,
    })).toThrowError(DomainError);

    const newerState = createQueueState({ queueId: "newer-state", now: later, items: [item("a", "queue", { updatedAt: later })] });
    expect(() => setQueueStatus(newerState, {
      expectedRevision: 0,
      operationId: "stale-mutation-time",
      status: "paused",
      now,
    })).toThrowError(DomainError);

    const receiptAfterStateUpdate = {
      schemaVersion: 1 as const,
      operationId: "receipt-after-state-update",
      queueId: "receipt-time-queue",
      operation: "queue-status" as const,
      previousRevision: 0,
      nextRevision: 1,
      changedItemIds: [] as readonly string[],
      createdAt: later,
      executionDisposition: "preview-only" as const,
    };
    const staleReceiptState = {
      ...createQueueState({ queueId: "receipt-time-queue", now, items: [item("a")] }),
      revision: 1,
      receipts: [receiptAfterStateUpdate],
      updatedAt: now,
    };
    expect(() => validateQueueState(staleReceiptState)).toThrowError(DomainError);

    const first = setQueueStatus(createQueueState({ queueId: "duplicate-receipt", now, items: [item("a")] }), {
      expectedRevision: 0,
      operationId: "duplicate-operation",
      status: "paused",
      now: later,
    });
    const duplicateReceiptState = {
      ...first.state,
      revision: 2,
      receipts: [
        ...first.state.receipts,
        { ...first.receipt, previousRevision: 1, nextRevision: 2, createdAt: later },
      ],
      updatedAt: later,
    };
    expect(() => validateQueueState(duplicateReceiptState)).toThrowError(DomainError);
  });

  it("orders steer before ordinary queue work and waits for dependencies/schedules", () => {
    const state = createQueueState({
      queueId: "queue-1",
      now,
      items: [
        item("ordinary", "queue", { priority: 100 }),
        item("steering", "steer", { priority: -100 }),
        item("blocked", "queue", { dependencyIds: ["ordinary"] }),
        item("later", "scheduled", { scheduledAt: later }),
      ],
    });
    const projections = projectQueueReadiness(state, now);
    expect(readyQueueItems(state, now).map((candidate) => candidate.itemId)).toEqual(["steering", "ordinary"]);
    expect(projections.find((entry) => entry.item.itemId === "blocked")?.reason).toBe("dependency-pending");
    expect(projections.find((entry) => entry.item.itemId === "later")?.reason).toBe("scheduled-for-later");
  });

  it("blocks conflicting parallel work while an active item is running", () => {
    const running = item("running", "parallel", { status: "running", startedAt: now, conflictSet: ["shared"] });
    const waiting = item("waiting", "parallel", { conflictSet: ["shared"] });
    const state = createQueueState({ queueId: "queue-1", now, items: [running, waiting] });
    expect(projectQueueReadiness(state, now, ["running"]).find((entry) => entry.item.itemId === "waiting")?.reason).toBe("conflict-active");
  });

  it("uses revision CAS and produces an undoable, preview-only reorder receipt", () => {
    const state = createQueueState({ queueId: "queue-1", now, items: [item("a"), item("b"), item("c")] });
    const reordered = reorderQueueItems(state, { expectedRevision: 0, operationId: "op-reorder", orderedItemIds: ["c", "a", "b"], now: later });
    expect(reordered.state.revision).toBe(1);
    expect(reordered.state.items.filter((candidate) => candidate.status === "queued").sort((left, right) => left.orderKey.localeCompare(right.orderKey)).map((candidate) => candidate.itemId)).toEqual(["c", "a", "b"]);
    expect(reordered.receipt.executionDisposition).toBe("preview-only");
    expect(() => reorderQueueItems(state, { expectedRevision: 1, operationId: "stale", orderedItemIds: ["a", "b", "c"], now: later })).toThrowError(DomainError);
    const undone = undoQueueReorder(reordered.state, reordered.receipt, { expectedRevision: 1, operationId: "op-undo", now: later });
    expect([...undone.state.items].sort((left, right) => left.orderKey.localeCompare(right.orderKey)).map((candidate) => candidate.itemId)).toEqual(["a", "b", "c"]);
  });

  it("rejects malformed undo inputs before reading their fields", () => {
    const state = createQueueState({ queueId: "queue-1", now, items: [item("a"), item("b")] });
    const reordered = reorderQueueItems(state, { expectedRevision: 0, operationId: "op-reorder", orderedItemIds: ["b", "a"], now: later });
    expect(() => undoQueueReorder(reordered.state, reordered.receipt, null as never)).toThrowError(DomainError);
    expect(() => undoQueueReorder(reordered.state, reordered.receipt, { expectedRevision: 1, operationId: "bad-time", now: "not-a-timestamp" } as never)).toThrowError(DomainError);
  });

  it("binds undo to the latest retained reorder receipt and rejects forged metadata", () => {
    const state = createQueueState({ queueId: "queue-1", now, items: [item("a"), item("b")] });
    const reordered = reorderQueueItems(state, { expectedRevision: 0, operationId: "bound-reorder", orderedItemIds: ["b", "a"], now: later });

    const forged = { ...reordered.receipt, operationId: "forged-reorder" };
    expect(() => undoQueueReorder(reordered.state, forged, { expectedRevision: 1, operationId: "forged-undo", now: later })).toThrowError(DomainError);

    const changedAfterReorder = setQueueStatus(reordered.state, { expectedRevision: 1, operationId: "pause-after-reorder", status: "paused", now: later });
    const staleButRevisionForged = { ...reordered.receipt, previousRevision: 1, nextRevision: 2 };
    expect(() => undoQueueReorder(changedAfterReorder.state, staleButRevisionForged, { expectedRevision: 2, operationId: "stale-undo", now: later })).toThrowError(DomainError);
  });

  it("accepts a structurally equivalent reorder receipt after JSON serialization", () => {
    const state = createQueueState({ queueId: "queue-1", now, items: [item("a"), item("b")] });
    const reordered = reorderQueueItems(state, { expectedRevision: 0, operationId: "serialized-reorder", orderedItemIds: ["b", "a"], now: later });
    const hydratedReceipt = JSON.parse(JSON.stringify(reordered.receipt)) as typeof reordered.receipt;
    const undone = undoQueueReorder(reordered.state, hydratedReceipt, { expectedRevision: 1, operationId: "serialized-undo", now: later });
    expect(undone.state.revision).toBe(2);
    expect(undone.receipt.operation).toBe("undo-reorder");
  });

  it("fails closed with a domain error when enqueue/reorder receive malformed state input", () => {
    const malformedState = null as never;
    expect(() => enqueueQueueItem(malformedState, item("added"), { expectedRevision: 0, operationId: "bad-state-enqueue", now: later })).toThrowError(DomainError);
    expect(() => reorderQueueItems(malformedState, { expectedRevision: 0, operationId: "bad-state-reorder", orderedItemIds: [], now: later })).toThrowError(DomainError);
  });

  it("enqueues only fresh draft/queued items and rejects stale or duplicate mutations", () => {
    const state = createQueueState({ queueId: "queue-1", now, items: [item("existing")] });
    const added = enqueueQueueItem(state, item("added"), { expectedRevision: 0, operationId: "enqueue-1", now: later });
    expect(added.state.revision).toBe(1);
    expect(added.receipt.operation).toBe("enqueue");
    expect(() => enqueueQueueItem(state, item("other"), { expectedRevision: 1, operationId: "stale", now: later })).toThrowError(DomainError);
    expect(() => enqueueQueueItem(added.state, item("added"), { expectedRevision: 1, operationId: "duplicate-item", now: later })).toThrowError(DomainError);
    expect(() => setQueueStatus(added.state, { expectedRevision: 1, operationId: "enqueue-1", status: "paused", now: later })).toThrowError(DomainError);
  });

  it("keeps receipt time monotonic and rejects unknown bulk-action items", () => {
    const state = createQueueState({ queueId: "queue-1", now, items: [item("existing")] });
    expect(() => setQueueStatus(state, { expectedRevision: 0, operationId: "past-status", status: "paused", now: "2026-09-14T23:59:59.000Z" })).toThrowError(DomainError);
    expect(() => applyQueueBulkAction(state, { expectedRevision: 0, operationId: "unknown-item", itemIds: ["missing"], action: "pause", now: later })).toThrowError(DomainError);
  });

  it("records a completion timestamp when cancelling a queued item", () => {
    const state = createQueueState({ queueId: "queue-1", now, items: [item("cancel-me")] });
    const cancelled = applyQueueBulkAction(state, {
      expectedRevision: 0,
      operationId: "cancel",
      itemIds: ["cancel-me"],
      action: "cancel",
      now: later,
    });
    const cancelledItem = cancelled.state.items.find((candidate) => candidate.itemId === "cancel-me");
    expect(cancelledItem?.status).toBe("cancelled");
    expect(cancelledItem?.completedAt).toBe(later);
    expect(() => validateQueueState(cancelled.state)).not.toThrow();
  });

  it("rejects enqueue timestamps that are newer than the mutation observation", () => {
    const state = createQueueState({ queueId: "queue-1", now });
    const future = item("future", "queue", { createdAt: later, updatedAt: later });
    expect(() => enqueueQueueItem(state, future, { expectedRevision: 0, operationId: "future-enqueue", now })).toThrowError(DomainError);
  });

  it("does not allow reorder to silently mutate a running item", () => {
    const running = item("running", "queue", { status: "running", startedAt: now });
    const pending = item("pending");
    const state = createQueueState({ queueId: "queue-1", now, items: [running, pending] });
    expect(() => reorderQueueItems(state, { expectedRevision: 0, operationId: "op", orderedItemIds: ["pending"], now: later })).not.toThrow();
    const result = reorderQueueItems(state, { expectedRevision: 0, operationId: "op", orderedItemIds: ["pending"], now: later });
    expect(result.state.items.find((candidate) => candidate.itemId === "running")?.orderKey).toBe("running");
  });

  it("supports bulk pause/resume/cancel/remove while preserving removed audit rows", () => {
    const state = createQueueState({ queueId: "queue-1", now, items: [item("a"), item("b")] });
    const paused = applyQueueBulkAction(state, { expectedRevision: 0, operationId: "pause", itemIds: ["a", "b"], action: "pause", now: later });
    expect(paused.state.items.every((candidate) => candidate.status === "paused")).toBe(true);
    const resumed = applyQueueBulkAction(paused.state, { expectedRevision: 1, operationId: "resume", itemIds: ["a"], action: "resume", now: later });
    const removed = applyQueueBulkAction(resumed.state, { expectedRevision: 2, operationId: "remove", itemIds: ["a"], action: "remove", now: later });
    expect(removed.state.items.find((candidate) => candidate.itemId === "a")?.status).toBe("removed");
    expect(removed.state.items).toHaveLength(2);
  });

  it("promotes Btw only through an explicit mutation and preserves its item identity", () => {
    const state = createQueueState({ queueId: "queue-1", now, items: [item("side", "btw")] });
    const promoted = promoteBtwItem(state, { expectedRevision: 0, operationId: "promote", itemId: "side", now: later });
    expect(promoted.state.items[0]?.mode).toBe("queue");
    expect(promoted.state.items[0]?.itemId).toBe("side");
    expect(() => promoteBtwItem(promoted.state, { expectedRevision: 1, operationId: "again", itemId: "side", now: later })).toThrowError(DomainError);
  });

  it("rejects active-item validation errors and preserves queue immutability", () => {
    const state = createQueueState({ queueId: "queue-1", now, items: [item("a")] });
    expect(() => projectQueueReadiness(state, now, ["missing"])).toThrowError(DomainError);
    expect(state.revision).toBe(0);
    expect(state.receipts).toHaveLength(0);
  });

  it("fails closed when a retained reorder receipt loses its order-key proof", () => {
    const state = createQueueState({ queueId: "queue-1", now, items: [item("a"), item("b")] });
    const reordered = reorderQueueItems(state, { expectedRevision: 0, operationId: "reorder-proof", orderedItemIds: ["b", "a"], now: later });
    const malformed = {
      ...reordered.state,
      receipts: [{ ...reordered.receipt, nextOrderKeys: { b: "0001" } }],
    };
    expect(() => validateQueueState(malformed)).toThrowError(DomainError);
  });

  it("fails closed when a retained receipt carries an unknown operation", () => {
    const state = createQueueState({ queueId: "queue-1", now, items: [item("a")] });
    const malformed = {
      ...state,
      revision: 1,
      receipts: [{
        schemaVersion: 1,
        operationId: "unknown-operation",
        queueId: "queue-1",
        operation: "future-operation",
        previousRevision: 0,
        nextRevision: 1,
        changedItemIds: ["a"],
        createdAt: later,
        executionDisposition: "preview-only",
      }],
      updatedAt: later,
    } as unknown as Parameters<typeof validateQueueState>[0];
    expect(() => validateQueueState(malformed)).toThrowError(DomainError);
  });

  it("rejects unknown fields on hydrated queue states and receipts", () => {
    const state = createQueueState({ queueId: "queue-1", now, items: [item("a")] });

    expect(() => validateQueueState({ ...state, unexpected: true } as unknown as Parameters<typeof validateQueueState>[0])).toThrowError(DomainError);
    expect(() => createQueueState({ queueId: "queue-1", now, unexpected: true } as unknown as Parameters<typeof createQueueState>[0])).toThrowError(DomainError);

    const receipt = {
      schemaVersion: 1,
      operationId: "receipt-1",
      queueId: "queue-1",
      operation: "queue-status",
      previousRevision: 0,
      nextRevision: 1,
      changedItemIds: [],
      createdAt: later,
      executionDisposition: "preview-only",
      unexpected: true,
    };
    const malformed = {
      ...state,
      revision: 1,
      receipts: [receipt],
      updatedAt: later,
    } as unknown as Parameters<typeof validateQueueState>[0];
    expect(() => validateQueueState(malformed)).toThrowError(DomainError);
  });
});
