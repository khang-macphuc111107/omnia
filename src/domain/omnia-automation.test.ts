import { describe, expect, it } from "vitest";

import {
  createDefaultOmniaAutomation,
  createOmniaAutomationRuntime,
  deserializeOmniaAutomationRuntime,
  enqueueOmniaAutomationRun,
  finishOmniaAutomationRun,
  listDueOmniaAutomations,
  serializeOmniaAutomationRuntime,
  setOmniaAutomationStatus,
  startOmniaAutomationRun,
  upsertOmniaAutomation,
  validateOmniaAutomationRuntime,
} from "./omnia-automation";

const t1 = "2026-10-17T00:00:01.000Z";
const t2 = "2026-10-17T00:00:02.000Z";
const t3 = "2026-10-17T00:00:03.000Z";
const t4 = "2026-10-17T00:00:04.000Z";

function activeScheduledAutomation(nextRunAt = t2) {
  const draft = createDefaultOmniaAutomation("Scheduled automation", t1);
  return {
    ...draft,
    status: "active" as const,
    trigger: "schedule" as const,
    triggerDetail: "Run on a cadence",
    schedule: { timezone: "UTC", expression: "every minute", nextRunAt },
    updatedAt: t1,
  };
}

describe("omnia automation contract", () => {
  it("creates a valid default and round-trips the durable runtime", () => {
    const definition = createDefaultOmniaAutomation("  Daily coding review  ", t1);
    const runtime = upsertOmniaAutomation(createOmniaAutomationRuntime(10), definition);

    expect(runtime.automations).toHaveLength(1);
    expect(runtime.automations[0]).toMatchObject({
      name: "Daily coding review",
      status: "draft",
      trigger: "manual",
      connector: "none",
      connectorPermission: "not-connected",
    });
    expect(deserializeOmniaAutomationRuntime(serializeOmniaAutomationRuntime(runtime))).toEqual(runtime);
    expect(validateOmniaAutomationRuntime(runtime)).toEqual(runtime);
  });

  it("lists only active cadence definitions whose next run is due", () => {
    const due = activeScheduledAutomation(t2);
    const future = activeScheduledAutomation(t4);
    const draft = { ...activeScheduledAutomation(t2), status: "draft" as const };
    const runtime = [due, future, draft].reduce(
      (current, definition) => upsertOmniaAutomation(current, definition),
      createOmniaAutomationRuntime(),
    );

    expect(listDueOmniaAutomations(runtime, t3).map((definition) => definition.id)).toEqual([due.id]);
  });

  it("enforces lifecycle transitions and preserves run metadata", () => {
    const definition = createDefaultOmniaAutomation("Manual run", t1);
    let runtime = upsertOmniaAutomation(createOmniaAutomationRuntime(), definition);
    runtime = setOmniaAutomationStatus(runtime, definition.id, "active", t2);
    runtime = enqueueOmniaAutomationRun(runtime, definition.id, "manual", { source: "test" }, t2);
    const runId = runtime.runs[0]?.id;
    expect(runId).toBeDefined();

    runtime = startOmniaAutomationRun(runtime, runId!, t3);
    runtime = finishOmniaAutomationRun(runtime, runId!, "succeeded", { resultRef: "artifact://run", finishedAt: t4 });
    expect(runtime.runs[0]).toMatchObject({
      status: "succeeded",
      startedAt: t3,
      finishedAt: t4,
      metadata: { source: "test" },
      resultRef: "artifact://run",
    });
  });

  it("rejects duplicate active runs when serial concurrency is exhausted", () => {
    const definition = createDefaultOmniaAutomation("Serial run", t1);
    const runtime = enqueueOmniaAutomationRun(
      upsertOmniaAutomation(createOmniaAutomationRuntime(), definition),
      definition.id,
      undefined,
      {},
      t2,
    );

    expect(() => enqueueOmniaAutomationRun(runtime, definition.id, undefined, {}, t3)).toThrow(/concurrency/i);
  });

  it("keeps terminal failure semantics explicit", () => {
    const definition = createDefaultOmniaAutomation("Failed run", t1);
    let runtime = enqueueOmniaAutomationRun(
      upsertOmniaAutomation(createOmniaAutomationRuntime(), definition),
      definition.id,
      undefined,
      {},
      t2,
    );
    const runId = runtime.runs[0]?.id;
    expect(runId).toBeDefined();
    runtime = startOmniaAutomationRun(runtime, runId!, t3);

    expect(() => finishOmniaAutomationRun(runtime, runId!, "failed", { finishedAt: t4 })).toThrow(/error/i);
    runtime = finishOmniaAutomationRun(runtime, runId!, "failed", { error: "provider unavailable", finishedAt: t4 });
    expect(runtime.runs[0]).toMatchObject({ status: "failed", error: "provider unavailable" });
  });
});
