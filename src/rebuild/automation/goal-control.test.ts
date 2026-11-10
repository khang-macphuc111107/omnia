import { describe, expect, it } from "vitest";
import { AutomationDomainError } from "./common";
import { GoalControlPlane, type GoalControlCommand } from "./goal-control";

const command = (overrides: Partial<GoalControlCommand> = {}): GoalControlCommand => ({
  schemaVersion: 1,
  controlId: "control-1",
  idempotencyKey: "idem-1",
  actor: { kind: "user", principalId: "khang" },
  target: { kind: "goal", id: "goal-1" },
  action: "set-goal",
  patch: { objective: "Ship the goal control plane" },
  expectedVersion: 0,
  runState: "not-started",
  activeRunPolicy: "not-applicable",
  effect: "reversible-write",
  requestedAtMs: 1,
  reason: "user request",
  ...overrides,
});

describe("GoalControlPlane", () => {
  it("sets, edits and tombstones a goal without physical deletion", () => {
    const plane = new GoalControlPlane(undefined, 1);
    expect(plane.apply(command()).decision).toBe("applied");
    const edit = plane.apply(command({
      controlId: "control-2",
      idempotencyKey: "idem-2",
      action: "edit-goal",
      expectedVersion: 1,
      patch: { objective: "Ship the revised goal control plane" },
      requestedAtMs: 2,
    }));
    expect(edit.after.version).toBe(2);
    const remove = plane.apply(command({
      controlId: "control-3",
      idempotencyKey: "idem-3",
      action: "remove-goal",
      expectedVersion: 2,
      patch: {},
      requestedAtMs: 3,
    }));
    expect(remove.decision).toBe("applied");
    expect(plane.snapshot()).toEqual([expect.objectContaining({ id: "goal-1", tombstoned: true, status: "cancelled" })]);
  });

  it("queues active-run steering and keeps the provider boundary explicit", () => {
    const plane = new GoalControlPlane({ steer: true }, 1);
    plane.apply(command());
    const receipt = plane.apply(command({
      controlId: "control-2",
      idempotencyKey: "idem-2",
      action: "steer",
      expectedVersion: 1,
      runState: "running",
      activeRunPolicy: "apply-at-safe-boundary",
      effect: "execution-control",
      patch: { prompt: "Prioritize the failing test first." },
      requestedAtMs: 2,
    }));
    expect(receipt.decision).toBe("queued");
    expect(receipt.executionDisposition).toBe("queued");
    expect(receipt.invalidation.required).toBe(true);
    expect(receipt.diagnostic).toMatch(/safe boundary/);
  });

  it("rejects stale writers and terminal mutations", () => {
    const plane = new GoalControlPlane(undefined, 1);
    plane.apply(command());
    expect(plane.apply(command({ controlId: "stale", idempotencyKey: "stale", expectedVersion: 0 })).decision).toBe("rejected");
    const terminal = plane.apply(command({
      controlId: "terminal",
      idempotencyKey: "terminal",
      action: "cancel",
      expectedVersion: 1,
      runState: "not-started",
      patch: {},
      requestedAtMs: 2,
    }));
    expect(terminal.decision).toBe("applied");
    expect(plane.apply(command({
      controlId: "late",
      idempotencyKey: "late",
      action: "edit-goal",
      expectedVersion: 2,
      runState: "terminal",
      patch: { objective: "must not mutate" },
      requestedAtMs: 3,
    })).decision).toBe("rejected");
  });

  it("replays an idempotent command and protects against payload drift", () => {
    const plane = new GoalControlPlane(undefined, 1);
    const first = plane.apply(command());
    const replay = plane.apply(command());
    expect(replay.replayed).toBe(true);
    expect(replay.controlId).toBe(first.controlId);
    expect(plane.revision).toBe(1);
    expect(() => plane.apply(command({ patch: { objective: "different" } }))).toThrow(AutomationDomainError);
    const restored = GoalControlPlane.restore(plane.serialize(), 2);
    expect(restored.snapshot()).toEqual(plane.snapshot());
    expect(restored.receiptsSnapshot()).toHaveLength(1);
  });

  it("supports queued goal/task changes before admission and rejects unsupported live control", () => {
    const plane = new GoalControlPlane(undefined, 1);
    plane.apply(command());
    const task = plane.apply(command({
      controlId: "task",
      idempotencyKey: "task",
      target: { kind: "task", id: "task-1" },
      action: "add-task",
      expectedVersion: 0,
      runState: "idle",
      activeRunPolicy: "not-applicable",
      patch: { objective: "Run focused verification" },
      requestedAtMs: 2,
    }));
    expect(task.decision).toBe("applied");
    const pause = plane.apply(command({
      controlId: "pause",
      idempotencyKey: "pause",
      target: { kind: "run", id: "run-1" },
      action: "pause",
      expectedVersion: 0,
      runState: "running",
      activeRunPolicy: "apply-at-safe-boundary",
      effect: "execution-control",
      patch: {},
      requestedAtMs: 3,
    }));
    expect(pause.decision).toBe("deferred");
    expect(pause.executionDisposition).toBe("not-admitted");
  });

  it("records supported control for an unknown active run without inventing provider state", () => {
    const plane = new GoalControlPlane({ steer: true }, 1);
    const receipt = plane.apply(command({
      controlId: "unknown-run-steer",
      idempotencyKey: "unknown-run-steer",
      target: { kind: "run", id: "run-not-yet-bound" },
      action: "steer",
      expectedVersion: 0,
      runState: "running",
      activeRunPolicy: "apply-at-safe-boundary",
      effect: "execution-control",
      patch: { prompt: "Prioritize the current blocker." },
      requestedAtMs: 2,
    }));
    expect(receipt.decision).toBe("queued");
    expect(receipt.executionDisposition).toBe("queued");
    expect(receipt.after.status).toBe("missing");
    expect(plane.snapshot()).toEqual([]);
    expect(plane.eventsSnapshot()).toHaveLength(1);
  });

  it("rejects a terminal entity even when the caller claims it is idle", () => {
    const plane = new GoalControlPlane();
    plane.apply(command());
    plane.apply(command({ controlId: "cancel", idempotencyKey: "cancel", action: "cancel", expectedVersion: 1 }));
    const state = plane.snapshot();
    const edit = plane.apply(command({
      controlId: "late-idle", idempotencyKey: "late-idle", action: "edit-goal",
      expectedVersion: 2, runState: "idle", patch: { objective: "must not revive" },
    }));
    expect(edit.decision).toBe("rejected");
    expect(plane.snapshot()).toEqual(state);
  });

  it("rejects control ID reuse without corrupting the first receipt or replay", () => {
    const plane = new GoalControlPlane();
    const first = plane.apply(command());
    expect(() => plane.apply(command({
      idempotencyKey: "another-key", action: "edit-goal", expectedVersion: 1,
      patch: { objective: "collision" },
    }))).toThrow(/control.*already|duplicate.*control/i);
    expect(plane.receiptsSnapshot()).toEqual([first]);
    expect(plane.apply(command())).toEqual({ ...first, replayed: true });
    expect(plane.eventsSnapshot()).toHaveLength(1);
  });

  it("advances the version when recording cancellation intent and rejects the old writer", () => {
    const plane = new GoalControlPlane({ cancel: true });
    plane.apply(command());
    const cancel = plane.apply(command({
      controlId: "cancel-live", idempotencyKey: "cancel-live", action: "cancel",
      expectedVersion: 1, runState: "running", effect: "execution-control",
      activeRunPolicy: "apply-at-safe-boundary",
    }));
    expect(cancel.decision).toBe("queued");
    expect(cancel.after.status).toBe("cancellation-requested");
    expect(cancel.after.version).toBe(2);
    const stale = plane.apply(command({
      controlId: "old-writer", idempotencyKey: "old-writer", action: "edit-goal",
      expectedVersion: 1, runState: "idle",
    }));
    expect(stale.decision).toBe("rejected");
    expect(GoalControlPlane.restore(plane.serialize()).snapshot()).toEqual(plane.snapshot());
  });

  it("does not partially mutate an entity when a patch fails validation", () => {
    const plane = new GoalControlPlane();
    plane.apply(command());
    const state = plane.snapshot();
    const events = plane.eventsSnapshot();
    expect(() => plane.apply(command({
      controlId: "invalid-patch", idempotencyKey: "invalid-patch", action: "edit-goal",
      expectedVersion: 1, patch: { objective: "partial corruption", taskIds: ["duplicate", "duplicate"] },
    }))).toThrow();
    expect(plane.snapshot()).toEqual(state);
    expect(plane.eventsSnapshot()).toEqual(events);
  });

  it("rejects kind collisions and nonzero creation expectations", () => {
    const plane = new GoalControlPlane();
    plane.apply(command());
    const collision = plane.apply(command({
      controlId: "kind-collision", idempotencyKey: "kind-collision",
      target: { kind: "task", id: "goal-1" }, action: "add-task", expectedVersion: 1,
    }));
    expect(collision.decision).toBe("rejected");
    const creation = plane.apply(command({
      controlId: "nonzero-create", idempotencyKey: "nonzero-create",
      target: { kind: "goal", id: "new-goal" }, expectedVersion: 5,
    }));
    expect(creation.decision).toBe("rejected");
    expect(plane.snapshot()).toHaveLength(1);
  });

  it("never labels an in-memory command receipt as durably persisted", () => {
    const plane = new GoalControlPlane();
    expect(plane.apply(command()).durable).toBe(false);
  });
});
