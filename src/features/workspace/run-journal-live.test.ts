import { describe, expect, it } from "vitest";

import type { RunJournalEventRecord } from "@/lib/desktop";

import { liveRunJournalPage } from "./run-journal-live";

const runId = "run_0123456789abcdef0123456789abcdef";
const epoch = "journal_epoch_0123456789abcdef0123456789abcdef";

function event(
  id: string,
  sequence: number,
  eventType: string,
  payload: unknown = {},
  overrides: Partial<RunJournalEventRecord> = {},
): RunJournalEventRecord {
  return {
    schemaVersion: 1,
    id,
    runId,
    journalEpoch: epoch,
    attemptId: null,
    frozenProviderInputId: null,
    sequence,
    eventType,
    source: "provider",
    visibility: "inspector",
    sensitivity: "normal",
    payload,
    occurredAtMs: 1_786_600_000_000 + sequence,
    committedAtMs: 1_786_600_001_000 + sequence,
    ...overrides,
  };
}

describe("live run journal handoff", () => {
  it("builds a sorted advisory page without claiming fixed-watermark replay coverage", () => {
    const page = liveRunJournalPage([
      event("run_event_2", 2, "message.text_delta", { text: "world" }),
      event("run_event_1", 1, "run.started"),
    ]);

    expect(page).toMatchObject({
      runId,
      journalEpoch: epoch,
      complete: true,
      coverage: "legacy-partial",
      coverageReason: "Advisory live notification; fixed-watermark journal replay has not been established.",
    });
    expect(page?.events.map((item) => item.id)).toEqual(["run_event_1", "run_event_2"]);
    expect(page?.nextCursor).toMatchObject({ sequence: 2, eventId: "run_event_2" });
  });

  it("ignores records from a different run or journal epoch", () => {
    const page = liveRunJournalPage([
      event("run_event_2", 2, "message.text_delta"),
      event("other_run_event", 3, "message.text_delta", {}, { runId: "run_other" }),
      event("other_epoch_event", 4, "message.text_delta", {}, { journalEpoch: "journal_other" }),
    ]);

    expect(page?.events.map((item) => item.id)).toEqual(["run_event_2"]);
    expect(page?.nextCursor.sequence).toBe(2);
  });

  it("returns no page when a notification has no journal records", () => {
    expect(liveRunJournalPage([])).toBeNull();
  });
});
