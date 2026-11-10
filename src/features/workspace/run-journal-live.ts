import type {
  RunJournalCursor,
  RunJournalEventRecord,
  RunJournalReplayPage,
} from "@/lib/desktop";

function cursorFor(event: RunJournalEventRecord): RunJournalCursor {
  return {
    schemaVersion: event.schemaVersion,
    runId: event.runId,
    journalEpoch: event.journalEpoch,
    sequence: event.sequence,
    eventId: event.id,
  };
}

/**
 * Builds the smallest page shape needed to project journal records delivered
 * with one native stream notification. The records are durable and carry
 * their own identity, but this is not a fixed-watermark replay: callers must
 * pass `live: true` and let native replay establish coverage later.
 */
export function liveRunJournalPage(
  input: readonly RunJournalEventRecord[],
): RunJournalReplayPage | null {
  if (input.length === 0) return null;

  const first = input[0];
  if (!first) return null;
  const events = input
    .filter(
      (event) =>
        event.runId === first.runId && event.journalEpoch === first.journalEpoch,
    )
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  const last = events.at(-1);
  if (!last) return null;

  const cursor = cursorFor(last);
  return {
    runId: first.runId,
    journalEpoch: first.journalEpoch,
    // Notifications carry durable identities, but they do not pin a native
    // through-cursor. Marking this page complete would let a consumer that
    // forgets the `live` option present an advisory tail as a full replay.
    // Keep the page shape compatible while making the read-only boundary
    // explicit; the subsequent fixed-watermark read is the only path that
    // can promote coverage back to complete.
    coverage: "legacy-partial",
    coverageReason: "Advisory live notification; fixed-watermark journal replay has not been established.",
    events,
    nextCursor: cursor,
    throughCursor: cursor,
    complete: true,
  };
}
