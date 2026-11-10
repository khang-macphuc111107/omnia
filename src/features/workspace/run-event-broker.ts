import { desktop, isDesktopRuntime, type RunStreamEvent } from "@/lib/desktop";

import { runEventBuffer } from "./run-event-buffer";
import { liveRunJournalPage } from "./run-journal-live";
import { pendingRunJournalHandoff } from "./run-journal-handoff";
import {
  refreshRunTelemetryIntoStore,
  replayRunJournalIntoStore,
} from "./run-journal-sync";
import { useWorkspaceStore } from "./store";

type Unlisten = () => void;
type RunEventSubscriber = (event: RunStreamEvent) => void;

/**
 * Projects one native stream notification into the renderer's live run view.
 *
 * The notification is advisory: durable journal replay remains the authority
 * for the inspector and terminal state. Keeping this mapping in the broker
 * gives every mounted surface the same lifecycle semantics and prevents a
 * composer from accidentally treating a provider notification as a second
 * persistence path.
 */
export function applyRunStreamEventToStore(event: RunStreamEvent): void {
  const state = useWorkspaceStore.getState();

  switch (event.type) {
    case "started":
      state.setRunStage(event.runId, "requesting");
      return;
    case "delta":
      state.appendRunDelta(event.runId, event.text);
      return;
    case "reasoningDelta":
      // Reasoning text is intentionally kept in the native journal rather
      // than merged into the assistant answer. Mark the run as active so the
      // renderer does not appear idle while a provider emits reasoning first.
      state.setRunStage(event.runId, "writing");
      return;
    case "usage":
      void refreshRunTelemetryIntoStore(event.runId);
      return;
    case "completed":
      state.finishRun(event.runId, event.finishReason);
      // The live event can omit records during a renderer handoff. Replay the
      // fixed native journal after terminalization to recover those records.
      void replayRunJournalIntoStore(event.runId, { baseline: true });
      return;
    case "error":
      state.failRun(event.runId, event.message);
      void replayRunJournalIntoStore(event.runId, { baseline: true });
      return;
    case "warning":
      // Warnings are already retained in the journal when applicable. There
      // is no durable warning slot in the chat projection, so leave the run
      // lifecycle untouched and let the inspector show the journal fact.
      return;
    default:
      return;
  }
}

let listenerPromise: Promise<Unlisten> | null = null;
let unlisten: Unlisten | null = null;
// Several mounted surfaces can share the same projection callback. Count
// owners while invoking that callback only once per native notification; one
// panel closing must not detach the global workspace subscription.
const subscribers = new Map<RunEventSubscriber, number>();

/**
 * Installs one process-wide advisory listener before startup journal replay.
 * Native journal records carried by notifications are retained in the bounded
 * buffer; the renderer still has to read native storage before projecting any
 * event as authoritative.
 */
export function startRunEventJournalBuffer(): Promise<void> {
  if (!isDesktopRuntime()) return Promise.resolve();
  if (listenerPromise) return listenerPromise.then(() => undefined);
  listenerPromise = desktop
    .onRunEvent((event: RunStreamEvent) => {
      runEventBuffer.recordStreamEvent(event);
      // Stream notifications carry the exact native journal records that were
      // committed before delivery. Project those records immediately so the
      // Run/Inspector timeline stays live during streaming. The `live` flag
      // prevents this advisory handoff from claiming fixed replay coverage;
      // startup/terminal replay still establishes the authoritative receipt.
      const livePage =
        "journalEvents" in event ? liveRunJournalPage(event.journalEvents ?? []) : null;
      if (livePage) {
        useWorkspaceStore.getState().applyRunJournalPage(livePage, {
          baseline: true,
          live: true,
        });
        useWorkspaceStore.getState().setRunJournalHandoff(
          livePage.runId,
          pendingRunJournalHandoff(runEventBuffer.snapshot(livePage.runId)),
        );
      }
      for (const subscriber of subscribers.keys()) subscriber(event);
    })
    .then((dispose) => {
      unlisten = dispose;
      return dispose;
    })
    .catch((cause: unknown) => {
      listenerPromise = null;
      throw cause;
    });
  return listenerPromise.then(() => undefined);
}

/**
 * Subscribes to the same advisory stream used by the composer. Keeping one
 * native listener avoids a second registration race while startup hydration is
 * still reading durable state.
 */
export function subscribeRunEvents(subscriber: RunEventSubscriber): Unlisten {
  subscribers.set(subscriber, (subscribers.get(subscriber) ?? 0) + 1);
  // Explicit native submissions await startup and display its failure. A
  // passive mounted panel must not create an unhandled rejection when the
  // native host is unavailable during startup or an isolated control test.
  void startRunEventJournalBuffer().catch(() => undefined);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const remaining = (subscribers.get(subscriber) ?? 1) - 1;
    if (remaining > 0) subscribers.set(subscriber, remaining);
    else subscribers.delete(subscriber);
  };
}

/**
 * Test/restart cleanup. Production startup keeps this listener for the life of
 * the desktop session so a mounted composer cannot reopen the old gap.
 */
export function stopRunEventJournalBuffer(): void {
  unlisten?.();
  unlisten = null;
  listenerPromise = null;
  subscribers.clear();
  runEventBuffer.clear();
}
