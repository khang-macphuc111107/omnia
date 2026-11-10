import type { RunJournalEventRecord } from "@/lib/desktop";

/**
 * Renderer-only state for the replay-to-live handoff.  A live notification is
 * useful for keeping the inspector responsive, but it is not a fixed
 * watermark receipt.  The projection makes that distinction visible without
 * turning a buffer observation into native authority.
 */
export type RunJournalHandoffStatus = "pending" | "covered" | "degraded";

export interface RunJournalHandoffProjection {
  readonly status: RunJournalHandoffStatus;
  readonly bufferedEventCount: number;
  readonly overflowed: boolean;
  readonly conflict: string | null;
  readonly detail: string;
}

export interface RunJournalHandoffSnapshot {
  readonly events: readonly RunJournalEventRecord[];
  readonly overflowed: boolean;
  readonly conflict: string | null;
}

export function hasRunJournalHandoffSignal(
  snapshot: RunJournalHandoffSnapshot,
): boolean {
  return snapshot.events.length > 0 || snapshot.overflowed || snapshot.conflict !== null;
}

export function pendingRunJournalHandoff(
  snapshot: RunJournalHandoffSnapshot,
): RunJournalHandoffProjection {
  const warning = snapshot.conflict ?? (snapshot.overflowed
    ? "The renderer buffer reached its safety limit; native replay must establish the missing tail."
    : null);
  return Object.freeze({
    status: "pending" as const,
    bufferedEventCount: snapshot.events.length,
    overflowed: snapshot.overflowed,
    conflict: snapshot.conflict,
    detail: warning
      ? `Live events are advisory while fixed-watermark replay is pending. ${warning}`
      : "Live events are advisory while fixed-watermark replay is pending.",
  });
}

export function coveredRunJournalHandoff(
  snapshot: RunJournalHandoffSnapshot,
): RunJournalHandoffProjection {
  const recoveredGap = snapshot.conflict || snapshot.overflowed;
  return Object.freeze({
    status: "covered" as const,
    bufferedEventCount: snapshot.events.length,
    overflowed: snapshot.overflowed,
    conflict: snapshot.conflict,
    detail: recoveredGap
      ? "Native fixed-watermark replay completed after the advisory handoff signal; the buffer warning is retained for review."
      : "Native fixed-watermark replay completed after the advisory live handoff.",
  });
}

export function degradedRunJournalHandoff(
  snapshot: RunJournalHandoffSnapshot,
): RunJournalHandoffProjection {
  const reason = snapshot.conflict ?? (snapshot.overflowed
    ? "The renderer buffer reached its safety limit before native replay completed."
    : "Native fixed-watermark replay was unavailable.");
  return Object.freeze({
    status: "degraded" as const,
    bufferedEventCount: snapshot.events.length,
    overflowed: snapshot.overflowed,
    conflict: snapshot.conflict,
    detail: `The visible live tail is advisory and may be incomplete. ${reason}`,
  });
}
