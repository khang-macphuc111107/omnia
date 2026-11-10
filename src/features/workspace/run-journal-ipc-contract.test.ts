import { describe, expect, it } from "vitest";

import type { ReadRunJournalRequest, RunJournalReplayPage } from "@/lib/desktop";

import { assertRunJournalReplayPageContract } from "./run-journal-ipc-contract";

const runId = "run_0123456789abcdef0123456789abcdef";
const epoch = "journal_epoch_0123456789abcdef0123456789abcdef";

function cursor(sequence: number, eventId: string | null = sequence === 0 ? null : `run_event_${sequence}`) {
  return { schemaVersion: 1 as const, runId, journalEpoch: epoch, sequence, eventId };
}

function event(sequence: number) {
  return {
    schemaVersion: 1 as const,
    id: `run_event_${sequence}`,
    runId,
    journalEpoch: epoch,
    attemptId: null,
    frozenProviderInputId: null,
    sequence,
    eventType: "run.started",
    source: "native",
    visibility: "inspector",
    sensitivity: "normal",
    payload: {},
    occurredAtMs: 1_786_600_000_000 + sequence,
    committedAtMs: 1_786_600_001_000 + sequence,
  };
}

function page(overrides: Partial<RunJournalReplayPage> = {}): RunJournalReplayPage {
  return {
    runId,
    journalEpoch: epoch,
    coverage: "complete",
    coverageReason: null,
    events: [event(1)],
    nextCursor: cursor(1),
    throughCursor: cursor(1),
    complete: true,
    ...overrides,
  };
}

describe("run journal IPC replay contract", () => {
  it("accepts a contiguous fixed-watermark page", () => {
    const request: ReadRunJournalRequest = { runId, limit: 250 };
    expect(() => assertRunJournalReplayPageContract(page(), request)).not.toThrow();
  });

  it("rejects an event that crosses the run or journal epoch", () => {
    const crossed = { ...event(1), runId: "run_other_0123456789abcdef0123456789abcdef" };
    expect(() => assertRunJournalReplayPageContract(page({ events: [crossed] }))).toThrow(
      /crosses the replay run or epoch/,
    );
  });

  it("rejects non-contiguous events and a forged next cursor", () => {
    expect(() => assertRunJournalReplayPageContract(page({ events: [event(2)] }))).toThrow(/not contiguous/);
    expect(() => assertRunJournalReplayPageContract(page({ nextCursor: cursor(2) }))).toThrow(/nextCursor/);
  });

  it("rejects duplicate event IDs and a complete page below its watermark", () => {
    const duplicate = { ...event(2), id: "run_event_1" };
    expect(() => assertRunJournalReplayPageContract(page({ events: [event(1), duplicate], nextCursor: cursor(2), throughCursor: cursor(2), complete: true }))).toThrow(/appears more than once/);
    expect(() => assertRunJournalReplayPageContract(page({ throughCursor: cursor(2), complete: true }))).toThrow(/fixed-watermark cursor/);
  });

  it("rejects a page that advances beyond its requested fixed watermark", () => {
    const request: ReadRunJournalRequest = {
      runId,
      journalEpoch: epoch,
      throughSequence: 1,
      throughEventId: "run_event_1",
      limit: 250,
    };
    expect(() => assertRunJournalReplayPageContract(page({ throughCursor: cursor(2) }), request)).toThrow(
      /fixed watermark/,
    );
  });

  it("accepts an empty page at the zero cursor", () => {
    const empty = page({ events: [], nextCursor: cursor(0), throughCursor: cursor(0), complete: true });
    expect(() => assertRunJournalReplayPageContract(empty, { runId, limit: 250 })).not.toThrow();
  });
});
