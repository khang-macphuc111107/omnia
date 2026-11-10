import { describe, expect, it } from "vitest";

import type { RunJournalEventRecord } from "@/lib/desktop";

import {
  coveredRunJournalHandoff,
  degradedRunJournalHandoff,
  hasRunJournalHandoffSignal,
  pendingRunJournalHandoff,
} from "./run-journal-handoff";

const cleanEvent: RunJournalEventRecord = {
  schemaVersion: 1,
  id: "event-1",
  runId: "run-1",
  journalEpoch: "epoch-1",
  attemptId: null,
  frozenProviderInputId: null,
  sequence: 1,
  eventType: "message.created",
  source: "harness",
  visibility: "user",
  sensitivity: "normal",
  payload: {},
  occurredAtMs: 1,
  committedAtMs: 1,
};

const clean = { events: [cleanEvent], overflowed: false, conflict: null };

describe("run journal replay-to-live handoff projection", () => {
  it("only reports a handoff when a live buffer signal exists", () => {
    expect(hasRunJournalHandoffSignal({ events: [], overflowed: false, conflict: null })).toBe(false);
    expect(hasRunJournalHandoffSignal(clean)).toBe(true);
  });

  it("keeps a clean live tail explicitly advisory", () => {
    expect(pendingRunJournalHandoff(clean)).toMatchObject({
      status: "pending",
      bufferedEventCount: 1,
      overflowed: false,
      conflict: null,
    });
    expect(pendingRunJournalHandoff(clean).detail).toMatch(/advisory/i);
  });

  it("retains an overflow warning even after native replay covers it", () => {
    const snapshot = { events: [], overflowed: true, conflict: null };
    expect(coveredRunJournalHandoff(snapshot)).toMatchObject({
      status: "covered",
      overflowed: true,
    });
    expect(coveredRunJournalHandoff(snapshot).detail).toMatch(/completed/i);
  });

  it("fails closed when replay cannot clear a conflicting epoch", () => {
    const snapshot = {
      events: [],
      overflowed: false,
      conflict: "A live notification crossed journal epochs; native replay is required before merging it.",
    };
    const projection = degradedRunJournalHandoff(snapshot);
    expect(projection.status).toBe("degraded");
    expect(projection.conflict).toContain("crossed journal epochs");
    expect(projection.detail).toMatch(/may be incomplete/i);
  });
});
