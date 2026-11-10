import type { RunJournalEventRecord, RunStreamEvent } from "@/lib/desktop";

/**
 * A bounded renderer-side copy of durable journal records delivered alongside
 * advisory run notifications.  It is intentionally not an authority: native
 * replay remains the source of truth.  The buffer only closes the renderer
 * handoff window and tells recovery whether the notification stream became
 * incomplete or crossed a journal epoch.
 */
export interface RunEventBufferSnapshot {
  readonly runId: string;
  readonly journalEpoch: string | null;
  readonly events: readonly RunJournalEventRecord[];
  readonly overflowed: boolean;
  readonly conflict: string | null;
}

const DEFAULT_MAX_EVENTS_PER_RUN = 4_096;

function durableKey(event: RunJournalEventRecord): string {
  return `${event.journalEpoch}:${event.sequence}:${event.id}`;
}

function isJournalEventRecord(value: unknown): value is RunJournalEventRecord {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RunJournalEventRecord>;
  return (
    typeof event.id === "string" &&
    typeof event.runId === "string" &&
    typeof event.journalEpoch === "string" &&
    typeof event.sequence === "number" &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence >= 1
  );
}

function journalEventsFromStreamEvent(event: RunStreamEvent): readonly RunJournalEventRecord[] {
  if (!("journalEvents" in event) || !Array.isArray(event.journalEvents)) return [];
  return event.journalEvents.filter(isJournalEventRecord);
}

interface MutableRunBuffer {
  epoch: string | null;
  eventsByKey: Map<string, RunJournalEventRecord>;
  sequenceToId: Map<number, string>;
  overflowed: boolean;
  conflict: string | null;
}

/**
 * Keeps only durable notification records.  The object is deliberately
 * dependency-free so startup, the composer, and focused tests can share the
 * same handoff state without creating a second event authority.
 */
export class RunEventBuffer {
  private readonly runs = new Map<string, MutableRunBuffer>();

  public constructor(private readonly maxEventsPerRun = DEFAULT_MAX_EVENTS_PER_RUN) {}

  public recordStreamEvent(event: RunStreamEvent): void {
    for (const journalEvent of journalEventsFromStreamEvent(event)) {
      this.record(journalEvent);
    }
  }

  public record(event: RunJournalEventRecord): void {
    if (!isJournalEventRecord(event)) return;
    const buffer = this.runs.get(event.runId) ?? {
      epoch: event.journalEpoch,
      eventsByKey: new Map<string, RunJournalEventRecord>(),
      sequenceToId: new Map<number, string>(),
      overflowed: false,
      conflict: null,
    };

    if (buffer.epoch === null) buffer.epoch = event.journalEpoch;
    if (buffer.epoch !== event.journalEpoch) {
      buffer.conflict =
        "A live notification crossed journal epochs; native replay is required before merging it.";
      this.runs.set(event.runId, buffer);
      return;
    }

    const sequenceOwner = buffer.sequenceToId.get(event.sequence);
    if (sequenceOwner !== undefined && sequenceOwner !== event.id) {
      buffer.conflict =
        "A live notification reused a durable sequence with a different event ID; native replay is required.";
      this.runs.set(event.runId, buffer);
      return;
    }

    const key = durableKey(event);
    if (!buffer.eventsByKey.has(key)) {
      if (buffer.eventsByKey.size >= this.maxEventsPerRun) {
        buffer.overflowed = true;
      } else {
        buffer.eventsByKey.set(key, event);
        buffer.sequenceToId.set(event.sequence, event.id);
      }
    }
    this.runs.set(event.runId, buffer);
  }

  public snapshot(runId: string): RunEventBufferSnapshot {
    const buffer = this.runs.get(runId);
    if (!buffer) {
      return {
        runId,
        journalEpoch: null,
        events: [],
        overflowed: false,
        conflict: null,
      };
    }
    return {
      runId,
      journalEpoch: buffer.epoch,
      events: [...buffer.eventsByKey.values()].sort(
        (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
      ),
      overflowed: buffer.overflowed,
      conflict: buffer.conflict,
    };
  }

  /**
   * Drops records already covered by a durable cursor while preserving the
   * overflow/conflict signal.  A later native replay can therefore clear the
   * signal explicitly instead of silently losing evidence.
   */
  public acknowledge(runId: string, cursor: { journalEpoch: string; sequence: number }): void {
    const buffer = this.runs.get(runId);
    if (!buffer || buffer.epoch !== cursor.journalEpoch) return;
    for (const [key, event] of buffer.eventsByKey) {
      if (event.sequence <= cursor.sequence) {
        buffer.eventsByKey.delete(key);
        buffer.sequenceToId.delete(event.sequence);
      }
    }
    if (buffer.eventsByKey.size === 0 && !buffer.overflowed && !buffer.conflict) {
      this.runs.delete(runId);
    }
  }

  public clear(runId?: string): void {
    if (runId === undefined) this.runs.clear();
    else this.runs.delete(runId);
  }
}

export const runEventBuffer = new RunEventBuffer();

export function journalEventsFromRunStreamEvent(
  event: RunStreamEvent,
): readonly RunJournalEventRecord[] {
  return journalEventsFromStreamEvent(event);
}
