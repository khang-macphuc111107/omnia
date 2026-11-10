import {
  desktop,
  type RunJournalCursor,
  type RunJournalReplayPage,
  type RunTelemetrySnapshot,
} from "@/lib/desktop";

import { readCompleteRunJournal, readRunJournalTail } from "./run-journal-projection";
import {
  coveredRunJournalHandoff,
  degradedRunJournalHandoff,
  hasRunJournalHandoffSignal,
} from "./run-journal-handoff";
import { useWorkspaceStore } from "./store";
import { runEventBuffer } from "./run-event-buffer";

const MAX_REPLAY_TO_LIVE_HANDOFF_ROUNDS = 4;

function cursorWithEventId(
  cursor: RunJournalCursor,
): RunJournalCursor {
  return {
    schemaVersion: cursor.schemaVersion,
    runId: cursor.runId,
    journalEpoch: cursor.journalEpoch,
    sequence: cursor.sequence,
    eventId: cursor.eventId,
  };
}

function hasBufferedTail(
  runId: string,
  cursor: RunJournalReplayPage["nextCursor"],
): boolean {
  const buffered = runEventBuffer.snapshot(runId);
  return buffered.journalEpoch === cursor.journalEpoch && buffered.events.some(
    (event) => event.sequence > cursor.sequence,
  );
}

/**
 * Replays a fixed-watermark native journal into the renderer projection.  A
 * caller may use baseline mode after native snapshot hydration: the snapshot
 * already contains the authoritative assistant text, while the journal still
 * supplies the inspector timeline and cursor.
 */
export async function replayRunJournalIntoStore(
  runId: string,
  options: { baseline?: boolean } = {},
): Promise<RunJournalReplayPage | null> {
  if (!runId) return null;
  const initialHandoff = runEventBuffer.snapshot(runId);
  let observedHandoffSignal = hasRunJournalHandoffSignal(initialHandoff);
  try {
    let page = await readCompleteRunJournal(
      (request) => desktop.readRunJournal(request),
      runId,
    );
    useWorkspaceStore.getState().applyRunJournalPage(page, options);

    // The startup/listener ordering is intentionally explicit: replay first
    // pins a finite watermark, then native storage is read again from the
    // replay cursor while the process-wide broker retains any durable records
    // emitted during the handoff. This closes the known renderer gap without
    // pretending that a renderer-side sequence of IPC calls is an atomic native
    // subscription boundary.
    let cursor = page.nextCursor;
    let replayedEvents = [...page.events];
    for (let round = 0; round < MAX_REPLAY_TO_LIVE_HANDOFF_ROUNDS; round += 1) {
      const tail = await readRunJournalTail(
        (request) => desktop.readRunJournal(request),
        runId,
        cursorWithEventId(cursor),
      );
      if (tail.events.length > 0 || tail.nextCursor.sequence > cursor.sequence) {
        useWorkspaceStore.getState().applyRunJournalPage(tail, options);
        replayedEvents = [...replayedEvents, ...tail.events];
        page = {
          ...tail,
          events: replayedEvents,
        };
      }
      cursor = tail.nextCursor;
      observedHandoffSignal = observedHandoffSignal || hasRunJournalHandoffSignal(runEventBuffer.snapshot(runId));
      runEventBuffer.acknowledge(runId, cursor);
      if (!hasBufferedTail(runId, cursor)) break;
    }
    const finalHandoff = runEventBuffer.snapshot(runId);
    observedHandoffSignal = observedHandoffSignal || hasRunJournalHandoffSignal(finalHandoff);
    // A successful native tail read covered everything the advisory buffer had
    // observed at the time of handoff. New notifications will create a fresh
    // buffer entry; conflicts/overflow cannot silently survive as stale state.
    runEventBuffer.clear(runId);
    if (observedHandoffSignal) {
      useWorkspaceStore.getState().setRunJournalHandoff(
        runId,
        coveredRunJournalHandoff(finalHandoff),
      );
    }
    // The journal is the lifecycle source of truth. Telemetry remains a
    // separate bounded projection so a future telemetry retry/read failure
    // cannot erase already replayed journal evidence.
    await refreshRunTelemetryIntoStore(runId);
    return page;
  } catch {
    // A legacy or partially migrated run may not have a readable journal.
    // Native conversation/message projections remain authoritative; the
    // inspector simply reports no replay data for that run.
    const currentHandoff = runEventBuffer.snapshot(runId);
    const handoffSnapshot = currentHandoff.events.length > 0 || currentHandoff.overflowed || currentHandoff.conflict
      ? currentHandoff
      : initialHandoff;
    useWorkspaceStore.getState().setRunJournalHandoff(
      runId,
      degradedRunJournalHandoff(handoffSnapshot),
    );
    return null;
  }
}

/**
 * Refreshes only the renderer-safe native telemetry projection for one exact
 * run. Missing, legacy, unavailable, or limit-exceeded telemetry is not
 * replaced with fixture values or zeroes; the inspector keeps an explicit
 * unavailable state instead.
 */
export async function refreshRunTelemetryIntoStore(
  runId: string,
): Promise<RunTelemetrySnapshot | null> {
  if (!runId) return null;
  try {
    const snapshot = await desktop.readRunTelemetry({ runId });
    useWorkspaceStore.getState().upsertRunTelemetry(snapshot);
    return snapshot;
  } catch {
    return null;
  }
}
