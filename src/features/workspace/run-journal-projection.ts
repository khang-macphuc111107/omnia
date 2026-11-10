import type {
  ReadRunJournalRequest,
  RunJournalCursor,
  RunJournalEventRecord,
  RunJournalReplayPage,
} from "@/lib/desktop";

import type { RunTimelineEventView, RunTimelineStage, RunTimelineStatus, RunTimelineSource } from "./evidence-types";
import { assertRunJournalReplayPageContract } from "./run-journal-ipc-contract";

/**
 * The native journal is the source of truth for run lifecycle facts.  This
 * module contains the deliberately boring renderer projection: it never
 * invents missing facts and it keeps the native event ID/sequence as the
 * stable identity used by the store for idempotent replay.
 */

export interface RunJournalReplayOptions {
  /** Do not append text deltas when the native message snapshot is the baseline. */
  readonly baseline?: boolean;
  /**
   * The page came from an advisory live notification rather than a fixed
   * native replay watermark. Live pages may update the visible timeline and
   * event-id dedupe set, but must not promote their provisional coverage to a
   * durable replay receipt. A later native replay remains authoritative.
   */
  readonly live?: boolean;
}

export interface RunJournalProjection {
  readonly timelineEvents: readonly RunTimelineEventView[];
  readonly textDeltas: readonly string[];
  readonly reasoningDeltas: readonly string[];
  readonly terminal:
    | { readonly kind: "completed"; readonly finishReason: string }
    | { readonly kind: "cancelled"; readonly finishReason: string }
    | { readonly kind: "failed"; readonly errorCode: string }
    | null;
  readonly cursor: RunJournalCursor;
  readonly throughCursor: RunJournalCursor;
  readonly coverage: RunJournalReplayPage["coverage"];
  readonly coverageReason: string | null;
}

function payloadRecord(event: RunJournalEventRecord): Readonly<Record<string, unknown>> {
  return event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Readonly<Record<string, unknown>>)
    : {};
}

function stringPayload(event: RunJournalEventRecord, key: string, fallback: string): string {
  const value = payloadRecord(event)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function numberPayload(event: RunJournalEventRecord, key: string): number | null {
  const value = payloadRecord(event)[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function stageForEvent(type: string): RunTimelineStage {
  if (type === "run.created" || type === "run.dispatching") return "routing";
  if (type === "attempt.created" || type === "attempt.dispatch_started") return "policy";
  if (type.startsWith("context.")) return "context";
  if (type.startsWith("memory.")) return "retrieval";
  if (type.startsWith("skills.")) return "context";
  if (type.startsWith("parameters.")) return "parameters";
  if (type.startsWith("policy.")) return "policy";
  if (type.startsWith("attempt.") || type === "run.started") return "provider";
  if (type.startsWith("message.")) return "provider";
  if (type.startsWith("usage.") || type === "run.completed" || type === "run.cancelled") return "finalization";
  if (type === "run.failed" || type === "attempt.outcome_unknown" || type === "run.recovered") return "validation";
  if (type.startsWith("validation.") || type.startsWith("citation.")) return "validation";
  if (type.startsWith("run.")) return "finalization";
  return "provider";
}

function statusForEvent(type: string): RunTimelineStatus {
  if (type === "run.completed" || type === "attempt.completed") return "complete";
  if (type === "run.cancelled" || type === "attempt.interrupted") return "stopped";
  if (type === "run.failed" || type === "attempt.failed") return "failed";
  // An outcome-unknown transition is terminal but not proof of provider
  // failure. Keep it visibly distinct so retry/billing decisions are not
  // misrepresented as a definitive failure in the inspector.
  if (type === "attempt.outcome_unknown" || type === "run.recovered" || type === "notice.emitted") return "warning";
  if (type === "run.created" || type === "attempt.created") return "pending";
  return "running";
}

function sourceForEvent(source: string): RunTimelineSource {
  if (source === "provider") return "provider";
  if (source === "retrieval") return "retrieval";
  if (source === "validation") return "validation";
  return source === "user" ? "user" : "harness";
}

function summaryForEvent(event: RunJournalEventRecord): string {
  const labels: Record<string, string> = {
    "run.created": "Run created",
    "run.dispatching": "Dispatching provider request",
    "attempt.created": "Provider attempt created",
    "attempt.dispatch_started": "Provider dispatch started",
    "attempt.accepted": "Provider accepted request",
    "run.started": "Provider stream started",
    "message.text_delta": "Assistant text received",
    "message.reasoning_summary_delta": "Reasoning update received",
    "usage.updated": "Usage updated",
    "attempt.completed": "Provider attempt completed",
    "attempt.interrupted": "Provider attempt interrupted",
    "attempt.failed": "Provider attempt failed",
    "attempt.outcome_unknown": "Provider outcome is unknown",
    "run.completed": "Run completed",
    "run.cancelled": "Run cancelled",
    "run.failed": "Run failed",
    "run.recovered": "Run recovered after restart",
  };
  return labels[event.eventType] ?? event.eventType.replaceAll(".", " ");
}

function detailForEvent(event: RunJournalEventRecord): string | null {
  const payload = payloadRecord(event);
  const detail = [
    typeof payload.errorCode === "string" ? `Error: ${payload.errorCode}` : null,
    typeof payload.finishReason === "string" ? `Finish: ${payload.finishReason}` : null,
    typeof payload.providerProfileId === "string" ? `Profile: ${payload.providerProfileId}` : null,
    typeof payload.model === "string" ? `Model: ${payload.model}` : null,
    typeof payload.inputTokens === "number" ? `Input: ${payload.inputTokens}` : null,
    typeof payload.outputTokens === "number" ? `Output: ${payload.outputTokens}` : null,
  ].filter((value): value is string => value !== null);
  return detail.length > 0 ? detail.join(" · ") : null;
}

export function timelineEventFromJournal(event: RunJournalEventRecord): RunTimelineEventView {
  const occurredAt = new Date(event.occurredAtMs).toISOString();
  const committedAt = new Date(event.committedAtMs).toISOString();
  const payload = payloadRecord(event);
  const providerLabel =
    typeof payload.model === "string"
      ? payload.model
      : typeof payload.providerProfileId === "string"
        ? payload.providerProfileId
        : null;
  return Object.freeze({
    id: event.id,
    runId: event.runId,
    parentEventId: null,
    sequence: event.sequence,
    type: event.eventType,
    stage: stageForEvent(event.eventType),
    status: statusForEvent(event.eventType),
    summary: summaryForEvent(event),
    detail: detailForEvent(event),
    startedAt: occurredAt,
    endedAt: statusForEvent(event.eventType) === "running" || statusForEvent(event.eventType) === "pending" ? null : committedAt,
    source: sourceForEvent(event.source),
    providerLabel,
    attemptOrdinal: numberPayload(event, "attemptOrdinal"),
    citationIds: [],
  });
}

function terminalForEvent(event: RunJournalEventRecord): RunJournalProjection["terminal"] {
  if (event.eventType === "run.completed") {
    return { kind: "completed", finishReason: stringPayload(event, "finishReason", "stop") };
  }
  if (event.eventType === "run.cancelled") {
    return { kind: "cancelled", finishReason: stringPayload(event, "finishReason", "cancelled") };
  }
  if (event.eventType === "run.failed") {
    return { kind: "failed", errorCode: stringPayload(event, "errorCode", "run_failed") };
  }
  return null;
}

/**
 * Projects a single native replay page.  The caller is responsible for
 * deduplicating event IDs across pages; this function is intentionally pure
 * so it is safe to use in tests and in a reconnect loop.
 */
export function projectRunJournalPage(
  page: RunJournalReplayPage,
  options: RunJournalReplayOptions = {},
): RunJournalProjection {
  const timelineEvents = page.events.map(timelineEventFromJournal);
  const textDeltas: string[] = [];
  const reasoningDeltas: string[] = [];
  let terminal: RunJournalProjection["terminal"] = null;

  for (const event of page.events) {
    const payload = payloadRecord(event);
    if (!options.baseline && event.eventType === "message.text_delta" && typeof payload.text === "string") {
      textDeltas.push(payload.text);
    }
    if (!options.baseline && event.eventType === "message.reasoning_summary_delta" && typeof payload.text === "string") {
      reasoningDeltas.push(payload.text);
    }
    const nextTerminal = terminalForEvent(event);
    if (nextTerminal) terminal = nextTerminal;
  }

  return Object.freeze({
    timelineEvents: Object.freeze(timelineEvents),
    textDeltas: Object.freeze(textDeltas),
    reasoningDeltas: Object.freeze(reasoningDeltas),
    terminal,
    cursor: page.nextCursor,
    throughCursor: page.throughCursor,
    coverage: page.coverage,
    coverageReason: page.coverageReason,
  });
}

/**
 * Reads the complete fixed-watermark journal.  The first request pins the
 * watermark; every subsequent request reuses it, preventing a live tail from
 * leaking into a finite replay.  A monotonicity guard fails closed if native
 * returns a stale cursor rather than looping forever.
 */
export async function readCompleteRunJournal(
  read: (request: ReadRunJournalRequest) => Promise<RunJournalReplayPage>,
  runId: string,
  limit = 1_000,
): Promise<RunJournalReplayPage> {
  const firstRequest: ReadRunJournalRequest = { runId, limit };
  let page = await read(firstRequest);
  assertRunJournalReplayPageContract(page, firstRequest);
  const events = [...page.events];
  const firstThrough = page.throughCursor;
  let guard = 0;
  while (!page.complete) {
    guard += 1;
    if (guard > 10_000) throw new Error("Run journal replay exceeded the page safety limit.");
    const after = page.nextCursor;
    if (after.sequence >= firstThrough.sequence) {
      throw new Error("Run journal replay returned a non-advancing cursor.");
    }
    const nextRequest: ReadRunJournalRequest = {
      runId,
      journalEpoch: firstThrough.journalEpoch,
      afterSequence: after.sequence,
      throughSequence: firstThrough.sequence,
      limit,
    };
    if (after.eventId !== null) nextRequest.afterEventId = after.eventId;
    if (firstThrough.eventId !== null) nextRequest.throughEventId = firstThrough.eventId;
    const nextPage = await read(nextRequest);
    assertRunJournalReplayPageContract(nextPage, nextRequest);
    if (nextPage.nextCursor.sequence <= after.sequence) {
      throw new Error("Run journal replay returned a non-advancing cursor.");
    }
    events.push(...nextPage.events);
    page = nextPage;
  }
  return {
    ...page,
    events,
    throughCursor: firstThrough,
  };
}

/**
 * Reads only the finite journal tail after a durable cursor. The first native
 * page pins the current head; subsequent pages reuse that same watermark so
 * newly committed events are not mixed into this recovery batch. This is the
 * renderer half of the replay-to-live handoff mitigation. It does not claim
 * the atomicity of a native subscription boundary.
 */
export async function readRunJournalTail(
  read: (request: ReadRunJournalRequest) => Promise<RunJournalReplayPage>,
  runId: string,
  after: RunJournalCursor,
  limit = 1_000,
): Promise<RunJournalReplayPage> {
  const firstRequest: ReadRunJournalRequest = {
    runId,
    journalEpoch: after.journalEpoch,
    afterSequence: after.sequence,
    limit,
  };
  if (after.eventId !== null) firstRequest.afterEventId = after.eventId;

  let page = await read(firstRequest);
  assertRunJournalReplayPageContract(page, firstRequest);
  const events = [...page.events];
  const firstThrough = page.throughCursor;
  let guard = 0;
  while (!page.complete) {
    guard += 1;
    if (guard > 10_000) throw new Error("Run journal tail replay exceeded the page safety limit.");
    const current = page.nextCursor;
    if (current.sequence >= firstThrough.sequence) {
      throw new Error("Run journal tail replay returned a non-advancing cursor.");
    }
    const nextRequest: ReadRunJournalRequest = {
      runId,
      journalEpoch: firstThrough.journalEpoch,
      afterSequence: current.sequence,
      throughSequence: firstThrough.sequence,
      limit,
    };
    if (current.eventId !== null) nextRequest.afterEventId = current.eventId;
    if (firstThrough.eventId !== null) nextRequest.throughEventId = firstThrough.eventId;
    const nextPage = await read(nextRequest);
    assertRunJournalReplayPageContract(nextPage, nextRequest);
    if (nextPage.nextCursor.sequence <= current.sequence) {
      throw new Error("Run journal tail replay returned a non-advancing cursor.");
    }
    events.push(...nextPage.events);
    page = nextPage;
  }

  return {
    ...page,
    events,
    throughCursor: firstThrough,
  };
}
