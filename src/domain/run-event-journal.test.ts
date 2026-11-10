import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import type {
  AttemptId,
  BranchId,
  ConversationId,
  RunEventId,
  RunId,
} from "./ids";
import {
  appendRunEventBatch,
  assertRunJournalMatchesRunState,
  createRunEventJournal,
  readRunEventPage,
  runJournalCursorAt,
  type PendingRunJournalEvent,
  type RunEventIngressIdentity,
} from "./run-event-journal";

const id = <T extends string>(value: string) => value as T;
const runId = id<RunId>("run_01");
const conversationId = id<ConversationId>("conversation_01");
const branchId = id<BranchId>("branch_01");
const attemptId = id<AttemptId>("attempt_01");
const t1 = "2026-08-13T00:00:01.000Z";
const t2 = "2026-08-13T00:00:02.000Z";
const t3 = "2026-08-13T00:00:03.000Z";

function event(
  idValue: string,
  type: PendingRunJournalEvent["type"],
  occurredAt: string,
  payload: PendingRunJournalEvent["payload"] = {},
): PendingRunJournalEvent {
  return {
    schemaVersion: 1,
    id: id<RunEventId>(idValue),
    type,
    occurredAt,
    conversationId,
    branchId,
    runId,
    source: "provider",
    visibility: "inspector",
    sensitivity: "normal",
    attemptId,
    payload,
  };
}

function providerIngress(hash: string): RunEventIngressIdentity {
  return {
    kind: "provider-event-id",
    namespace: "openai.sse",
    identityHash: hash,
  };
}

function hash(char: string): string {
  return char.repeat(64);
}

describe("durable run event journal", () => {
  it("assigns the sequence only at append time and returns a stable head cursor", () => {
    const journal = createRunEventJournal({ runId, journalEpoch: "epoch-1" });
    const result = appendRunEventBatch(journal, {
      expectedCursor: runJournalCursorAt(journal),
      committedAt: t1,
      entries: [
        { event: event("event_1", "attempt.accepted", t1), ingressIdentity: providerIngress(hash("a")) },
        { event: event("event_2", "message.text_delta", t2, { text: "hello" }), ingressIdentity: providerIngress(hash("b")) },
      ],
    });

    expect(result.accepted.map((value) => value.sequence)).toEqual([1, 2]);
    expect(result.cursor.sequence).toBe(2);
    expect(result.cursor.eventId).toBe(id<RunEventId>("event_2"));
    expect(Object.isFrozen(result.journal.entries)).toBe(true);
    expect(Object.isFrozen(result.journal.entries[1]?.event.payload)).toBe(true);
  });

  it("rejects a stale append cursor instead of allowing a forked sequence", () => {
    const journal = createRunEventJournal({ runId, journalEpoch: "epoch-1" });
    const first = appendRunEventBatch(journal, {
      expectedCursor: runJournalCursorAt(journal),
      committedAt: t1,
      entries: [{ event: event("event_1", "attempt.accepted", t1) }],
    }).journal;

    expect(() =>
      appendRunEventBatch(first, {
        expectedCursor: runJournalCursorAt(journal),
        committedAt: t2,
        entries: [{ event: event("event_2", "message.text_delta", t2) }],
      }),
    ).toThrowError(DomainError);
  });

  it("replays an exact lost response by provider identity without appending a duplicate", () => {
    const journal = createRunEventJournal({ runId, journalEpoch: "epoch-1" });
    const ingressIdentity = providerIngress(hash("a"));
    const first = appendRunEventBatch(journal, {
      expectedCursor: runJournalCursorAt(journal),
      committedAt: t1,
      entries: [{ event: event("event_1", "message.text_delta", t1, { text: "hello" }), ingressIdentity }],
    });
    const replay = appendRunEventBatch(first.journal, {
      expectedCursor: runJournalCursorAt(journal),
      committedAt: t2,
      entries: [{ event: event("new-local-id", "message.text_delta", t3, { text: "hello" }), ingressIdentity }],
    });

    expect(replay.accepted).toHaveLength(0);
    expect(replay.replayed.map((value) => value.id)).toEqual([id<RunEventId>("event_1")]);
    expect(replay.journal.entries).toHaveLength(1);
    expect(replay.cursor).toEqual(first.cursor);
  });

  it("rejects producer identity reuse when the normalized fact changes", () => {
    const journal = createRunEventJournal({ runId, journalEpoch: "epoch-1" });
    const ingressIdentity = providerIngress(hash("a"));
    const first = appendRunEventBatch(journal, {
      expectedCursor: runJournalCursorAt(journal),
      committedAt: t1,
      entries: [{ event: event("event_1", "message.text_delta", t1, { text: "hello" }), ingressIdentity }],
    }).journal;

    expect(() =>
      appendRunEventBatch(first, {
        expectedCursor: runJournalCursorAt(first),
        committedAt: t2,
        entries: [{ event: event("event_2", "message.text_delta", t2, { text: "different" }), ingressIdentity }],
      }),
    ).toThrowError(DomainError);
  });

  it("pins replay to a through-cursor so a live tail cannot leak into the page", () => {
    const empty = createRunEventJournal({ runId, journalEpoch: "epoch-1" });
    const first = appendRunEventBatch(empty, {
      expectedCursor: runJournalCursorAt(empty),
      committedAt: t1,
      entries: [
        { event: event("event_1", "attempt.accepted", t1) },
        { event: event("event_2", "message.text_delta", t2, { text: "a" }) },
      ],
    });
    const withTail = appendRunEventBatch(first.journal, {
      expectedCursor: first.cursor,
      committedAt: t3,
      entries: [{ event: event("event_3", "message.text_delta", t3, { text: "b" }) }],
    }).journal;
    const page = readRunEventPage(withTail, {
      afterCursor: runJournalCursorAt(withTail, 0),
      throughCursor: first.cursor,
      limit: 10,
    });

    expect(page.events.map((value) => value.id)).toEqual([
      id<RunEventId>("event_1"),
      id<RunEventId>("event_2"),
    ]);
    expect(page.complete).toBe(true);
    expect(page.throughCursor.sequence).toBe(2);
  });

  it("invalidates cursors after a journal epoch changes", () => {
    const journal = createRunEventJournal({ runId, journalEpoch: "epoch-2" });
    const stale = {
      ...runJournalCursorAt(journal),
      journalEpoch: "epoch-1",
    };
    expect(() => readRunEventPage(journal, { afterCursor: stale, limit: 10 })).toThrowError(DomainError);
  });

  it("requires partial coverage to carry an explicit recovery reason", () => {
    expect(() =>
      createRunEventJournal({ runId, journalEpoch: "epoch-1", coverage: "recovered-partial" }),
    ).toThrowError(DomainError);
    const journal = createRunEventJournal({
      runId,
      journalEpoch: "epoch-1",
      coverage: "recovered-partial",
      coverageReason: "The prior renderer subscription ended before native replay was available.",
    });
    expect(journal.coverage).toBe("recovered-partial");
  });

  it("allows exactly one terminal event and checks it against the projected run state", () => {
    const journal = createRunEventJournal({ runId, journalEpoch: "epoch-1" });
    const result = appendRunEventBatch(journal, {
      expectedCursor: runJournalCursorAt(journal),
      committedAt: t1,
      entries: [{ event: event("event_1", "run.completed", t1) }],
    });
    expect(() => assertRunJournalMatchesRunState(result.journal, "completed")).not.toThrow();
    expect(() => assertRunJournalMatchesRunState(result.journal, "failed")).toThrowError(DomainError);
    expect(() =>
      appendRunEventBatch(result.journal, {
        expectedCursor: result.cursor,
        committedAt: t2,
        entries: [{ event: event("event_2", "run.failed", t2) }],
      }),
    ).toThrowError(DomainError);
  });

  it("never deduplicates equal adjacent content without a proven producer identity", () => {
    const journal = createRunEventJournal({ runId, journalEpoch: "epoch-1" });
    const result = appendRunEventBatch(journal, {
      expectedCursor: runJournalCursorAt(journal),
      committedAt: t1,
      entries: [
        { event: event("event_1", "message.text_delta", t1, { text: "same" }) },
        { event: event("event_2", "message.text_delta", t2, { text: "same" }) },
      ],
    });
    expect(result.accepted).toHaveLength(2);
    expect(result.journal.entries.map(({ event: value }) => value.sequence)).toEqual([1, 2]);
  });

  it("rejects raw non-namespaced extension keys at the persistence boundary", () => {
    const journal = createRunEventJournal({ runId, journalEpoch: "epoch-1" });
    expect(() =>
      appendRunEventBatch(journal, {
        expectedCursor: runJournalCursorAt(journal),
        committedAt: t1,
        entries: [
          {
            event: {
              ...event("event_1", "attempt.accepted", t1),
              extensions: { authorization: "secret" },
            },
          },
        ],
      }),
    ).toThrowError(DomainError);
  });

  it("rejects stream facts but accepts bounded post-run work after terminalization", () => {
    const journal = createRunEventJournal({ runId, journalEpoch: "epoch-1" });
    const terminal = appendRunEventBatch(journal, {
      expectedCursor: runJournalCursorAt(journal),
      committedAt: t1,
      entries: [{ event: event("event_1", "run.completed", t1) }],
    });
    expect(() =>
      appendRunEventBatch(terminal.journal, {
        expectedCursor: terminal.cursor,
        committedAt: t2,
        entries: [{ event: event("event_2", "usage.updated", t2, { outputTokens: 1 }) }],
      }),
    ).toThrowError(DomainError);

    const validation = appendRunEventBatch(terminal.journal, {
      expectedCursor: terminal.cursor,
      committedAt: t2,
      entries: [{ event: event("event_3", "validation.completed", t2, { valid: true }) }],
    });
    expect(validation.accepted.map((value) => value.type)).toEqual(["validation.completed"]);
  });
});
