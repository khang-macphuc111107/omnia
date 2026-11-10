import { describe, expect, it } from "vitest";

import type {
  ReadRunJournalRequest,
  RunJournalReplayPage,
} from "@/lib/desktop";

import {
  projectRunJournalPage,
  readCompleteRunJournal,
} from "./run-journal-projection";

function cursor(sequence: number, eventId: string | null = sequence > 0 ? `run_event_${sequence}` : null) {
  return {
    schemaVersion: 1 as const,
    runId: "run_0123456789abcdef0123456789abcdef",
    journalEpoch: "journal_epoch_0123456789abcdef0123456789abcdef",
    sequence,
    eventId,
  };
}

function page(
  events: RunJournalReplayPage["events"],
  nextSequence: number,
  throughSequence: number,
  complete: boolean,
): RunJournalReplayPage {
  return {
    runId: "run_0123456789abcdef0123456789abcdef",
    journalEpoch: "journal_epoch_0123456789abcdef0123456789abcdef",
    coverage: "complete",
    coverageReason: null,
    events,
    nextCursor: cursor(nextSequence),
    throughCursor: cursor(throughSequence),
    complete,
  };
}

function event(
  id: string,
  sequence: number,
  eventType: string,
  payload: unknown = {},
): RunJournalReplayPage["events"][number] {
  return {
    schemaVersion: 1,
    id,
    runId: "run_0123456789abcdef0123456789abcdef",
    journalEpoch: "journal_epoch_0123456789abcdef0123456789abcdef",
    attemptId: "attempt_0123456789abcdef0123456789abcdef",
    frozenProviderInputId: "provider_input_0123456789abcdef0123456789abcdef",
    sequence,
    eventType,
    source: "provider",
    visibility: "inspector",
    sensitivity: "normal",
    payload,
    occurredAtMs: 1_786_600_000_000 + sequence,
    committedAtMs: 1_786_600_001_000 + sequence,
  };
}

describe("native run journal renderer projection", () => {
  it("projects lifecycle facts and keeps baseline snapshots from duplicating text", () => {
    const replayPage = page(
      [
        event("run_event_1", 1, "run.started", { model: "model-x" }),
        event("run_event_2", 2, "message.text_delta", { text: "hello" }),
        event("run_event_3", 3, "usage.updated", { inputTokens: 4, outputTokens: 1 }),
        event("run_event_4", 4, "run.completed", { finishReason: "stop" }),
      ],
      4,
      4,
      true,
    );

    const baseline = projectRunJournalPage(replayPage, { baseline: true });
    expect(baseline.timelineEvents.map((item) => item.id)).toEqual([
      "run_event_1",
      "run_event_2",
      "run_event_3",
      "run_event_4",
    ]);
    expect(baseline.textDeltas).toEqual([]);
    expect(baseline.terminal).toEqual({ kind: "completed", finishReason: "stop" });

    const live = projectRunJournalPage(replayPage);
    expect(live.textDeltas).toEqual(["hello"]);
    expect(live.timelineEvents[1]?.stage).toBe("provider");

    const terminal = live.timelineEvents[3];
    expect(terminal?.endedAt).toBe(new Date(1_786_600_001_004).toISOString());
  });

  it("follows the fixed watermark and rejects a non-advancing page", async () => {
    const first = page(
      [event("run_event_1", 1, "run.started")],
      1,
      2,
      false,
    );
    const second = page(
      [event("run_event_2", 2, "run.completed", { finishReason: "stop" })],
      2,
      2,
      true,
    );
    const requests: ReadRunJournalRequest[] = [];
    const result = await readCompleteRunJournal(async (request) => {
      requests.push(request);
      return requests.length === 1 ? first : second;
    }, first.runId);
    expect(result.events.map((item) => item.id)).toEqual(["run_event_1", "run_event_2"]);
    expect(requests[1]).toMatchObject({
      journalEpoch: first.journalEpoch,
      afterSequence: 1,
      throughSequence: 2,
      throughEventId: "run_event_2",
    });

    await expect(
      readCompleteRunJournal(async () => first, first.runId),
    ).rejects.toThrow("Run journal IPC contract violation");
  });

  it("keeps outcome-unknown and recovery facts visibly distinct from failure", () => {
    const replayPage = page(
      [
        event("run_event_1", 1, "attempt.outcome_unknown", { status: 502 }),
        event("run_event_2", 2, "run.recovered"),
        event("run_event_3", 3, "run.failed", { errorCode: "retry_exhausted" }),
      ],
      3,
      3,
      true,
    );

    expect(projectRunJournalPage(replayPage).timelineEvents.map((item) => item.status)).toEqual([
      "warning",
      "warning",
      "failed",
    ]);
  });
});
