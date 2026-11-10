import type {
  ReadRunJournalRequest,
  RunJournalEventRecord,
  RunJournalReplayPage,
} from "@/lib/desktop";

function contractError(detail: string): Error {
  return new Error(`Run journal IPC contract violation: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertCursor(
  value: unknown,
  name: "nextCursor" | "throughCursor",
  runId: string,
  journalEpoch: string,
): asserts value is RunJournalReplayPage["nextCursor"] {
  if (!isRecord(value)) throw contractError(`${name} must be an object.`);
  if (value.schemaVersion !== 1) throw contractError(`${name} has an unsupported schema version.`);
  if (value.runId !== runId || value.journalEpoch !== journalEpoch) {
    throw contractError(`${name} does not belong to the replay run and epoch.`);
  }
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) {
    throw contractError(`${name} sequence must be a non-negative safe integer.`);
  }
  if (value.sequence === 0) {
    if (value.eventId !== null) throw contractError(`${name} at sequence zero must not have an event ID.`);
  } else if (typeof value.eventId !== "string" || value.eventId.length === 0) {
    throw contractError(`${name} at a non-zero sequence must include its event ID.`);
  }
}

function assertEvent(
  value: unknown,
  sequence: number,
  runId: string,
  journalEpoch: string,
): asserts value is RunJournalEventRecord {
  if (!isRecord(value)) throw contractError(`event at sequence ${sequence} must be an object.`);
  if (value.schemaVersion !== 1) throw contractError(`event at sequence ${sequence} has an unsupported schema version.`);
  if (value.runId !== runId || value.journalEpoch !== journalEpoch) {
    throw contractError(`event at sequence ${sequence} crosses the replay run or epoch.`);
  }
  if (value.sequence !== sequence) throw contractError(`event sequence ${String(value.sequence)} is not contiguous.`);
  for (const field of ["id", "eventType", "source", "visibility", "sensitivity"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw contractError(`event at sequence ${sequence} has an invalid ${field}.`);
    }
  }
  for (const field of ["attemptId", "frozenProviderInputId"]) {
    if (value[field] !== null && typeof value[field] !== "string") {
      throw contractError(`event at sequence ${sequence} has an invalid ${field}.`);
    }
  }
  for (const field of ["occurredAtMs", "committedAtMs"]) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      throw contractError(`event at sequence ${sequence} has an invalid ${field}.`);
    }
  }
  if (!("payload" in value)) throw contractError(`event at sequence ${sequence} is missing its payload field.`);
}

/**
 * Checks the structural and cursor-consistency guarantees expected of the
 * renderer-facing native replay DTO. This does not authenticate journal
 * provenance; only the native journal reader can do that.
 */
export function assertRunJournalReplayPageContract(
  value: unknown,
  request?: ReadRunJournalRequest,
): asserts value is RunJournalReplayPage {
  if (!isRecord(value)) throw contractError("page must be an object.");
  const runId = value.runId;
  const journalEpoch = value.journalEpoch;
  if (typeof runId !== "string" || runId.length === 0) throw contractError("runId is required.");
  if (typeof journalEpoch !== "string" || journalEpoch.length === 0) {
    throw contractError("journalEpoch is required.");
  }
  if (request && runId !== request.runId) throw contractError("page runId does not match the request.");
  if (request?.journalEpoch && journalEpoch !== request.journalEpoch) {
    throw contractError("page journalEpoch does not match the requested epoch.");
  }
  if (value.coverage !== "complete" && value.coverage !== "legacy-partial" && value.coverage !== "recovered-partial") {
    throw contractError("coverage is not a supported journal coverage value.");
  }
  if (value.coverageReason !== null && typeof value.coverageReason !== "string") {
    throw contractError("coverageReason must be a string or null.");
  }
  if (!Array.isArray(value.events)) throw contractError("events must be an array.");
  assertCursor(value.nextCursor, "nextCursor", runId, journalEpoch);
  assertCursor(value.throughCursor, "throughCursor", runId, journalEpoch);

  const afterSequence = request?.afterSequence ?? 0;
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw contractError("request afterSequence must be a non-negative safe integer.");
  }
  if (afterSequence === 0 && request?.afterEventId !== undefined) {
    throw contractError("request afterEventId must be omitted when afterSequence is zero.");
  }
  if (afterSequence > 0 && (typeof request?.journalEpoch !== "string" || typeof request.afterEventId !== "string")) {
    throw contractError("request after cursor must include journalEpoch and afterEventId.");
  }
  if (request?.throughSequence === undefined && request?.throughEventId !== undefined) {
    throw contractError("request throughEventId requires throughSequence.");
  }
  if (request?.throughSequence === 0 && request.throughEventId !== undefined) {
    throw contractError("request throughEventId must be omitted when throughSequence is zero.");
  }
  if (request?.throughSequence !== undefined && request.throughSequence > 0 &&
      (typeof request.journalEpoch !== "string" || typeof request.throughEventId !== "string")) {
    throw contractError("request through cursor must include journalEpoch and throughEventId.");
  }
  const throughSequence = value.throughCursor.sequence;
  if (request?.throughSequence !== undefined && throughSequence !== request.throughSequence) {
    throw contractError("throughCursor does not match the requested fixed watermark.");
  }
  if (request?.throughEventId !== undefined && value.throughCursor.eventId !== request.throughEventId) {
    throw contractError("throughCursor event ID does not match the requested fixed watermark.");
  }
  if (throughSequence < afterSequence) throw contractError("throughCursor is behind the requested after cursor.");

  let expectedSequence = afterSequence + 1;
  const eventIds = new Set<string>();
  for (const event of value.events) {
    assertEvent(event, expectedSequence, runId, journalEpoch);
    if (eventIds.has(event.id)) throw contractError(`event ID ${event.id} appears more than once in the page.`);
    eventIds.add(event.id);
    expectedSequence += 1;
  }
  const nextSequence = expectedSequence - 1;
  if (value.nextCursor.sequence !== nextSequence) {
    throw contractError("nextCursor does not identify the last returned event or requested after cursor.");
  }
  if (value.events.length > 0 && value.nextCursor.eventId !== value.events[value.events.length - 1]?.id) {
    throw contractError("nextCursor event ID does not match the last returned event.");
  }
  if (value.events.length === 0 && afterSequence > 0 && request?.afterEventId !== undefined &&
      value.nextCursor.eventId !== request.afterEventId) {
    throw contractError("empty page nextCursor does not preserve the requested after event ID.");
  }
  if (nextSequence > throughSequence) throw contractError("nextCursor advances beyond the fixed watermark.");
  if (typeof value.complete !== "boolean" || value.complete !== (nextSequence >= throughSequence)) {
    throw contractError("complete does not agree with the fixed-watermark cursor positions.");
  }
  if (value.complete && (value.nextCursor.sequence !== value.throughCursor.sequence ||
      value.nextCursor.eventId !== value.throughCursor.eventId)) {
    throw contractError("a complete page must end at its fixed-watermark cursor.");
  }
}
