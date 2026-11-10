export type CitationSourceType =
  | "attachment"
  | "workspace"
  | "web"
  | "conversation"
  | "artifact"
  | "connected-source";

export type CitationVerificationState =
  | "verified"
  | "unverified"
  | "mismatch"
  | "unavailable";

/**
 * A citation is a persisted projection of one source span used by one answer.
 * Null provenance fields mean the native harness did not retain that evidence;
 * the renderer must never infer a successful verification from display text.
 */
export interface CitationView {
  id: string;
  messageId: string;
  runId: string;
  sourceId: string;
  snapshotId: string | null;
  displayIndex: number;
  title: string;
  sourceType: CitationSourceType;
  locatorLabel: string;
  uri: string | null;
  excerpt: string;
  retrievedAt: string | null;
  sourceContentHash: string | null;
  sourceStart: number | null;
  sourceEnd: number | null;
  sourceAvailableInSnapshot: boolean;
  answerStart: number | null;
  answerEnd: number | null;
  verificationState: CitationVerificationState;
}

export type RunTimelineStage =
  | "policy"
  | "parameters"
  | "context"
  | "retrieval"
  | "routing"
  | "provider"
  | "validation"
  | "finalization";

export type RunTimelineStatus =
  | "pending"
  | "running"
  | "complete"
  | "stopped"
  | "warning"
  | "failed";

export type RunTimelineSource =
  | "harness"
  | "provider"
  | "retrieval"
  | "validation"
  | "user";

export interface RunTimelineEventView {
  id: string;
  runId: string;
  parentEventId: string | null;
  sequence: number;
  type: string;
  stage: RunTimelineStage;
  status: RunTimelineStatus;
  summary: string;
  detail: string | null;
  startedAt: string;
  endedAt: string | null;
  source: RunTimelineSource;
  providerLabel: string | null;
  attemptOrdinal: number | null;
  citationIds: string[];
}

export interface RunTimelineAudit {
  events: RunTimelineEventView[];
  issues: string[];
}

const SHA_256_PATTERN = /^[a-f0-9]{64}$/i;

export function hasFrozenCitationEvidence(citation: CitationView): boolean {
  return (
    citation.snapshotId !== null &&
    citation.snapshotId.trim().length > 0 &&
    citation.sourceContentHash !== null &&
    SHA_256_PATTERN.test(citation.sourceContentHash) &&
    citation.sourceAvailableInSnapshot &&
    citation.sourceStart !== null &&
    citation.sourceEnd !== null &&
    Number.isSafeInteger(citation.sourceStart) &&
    Number.isSafeInteger(citation.sourceEnd) &&
    citation.sourceStart >= 0 &&
    citation.sourceEnd > citation.sourceStart
  );
}

export function effectiveCitationVerification(
  citation: CitationView,
): CitationVerificationState {
  if (citation.verificationState !== "verified") return citation.verificationState;
  return hasFrozenCitationEvidence(citation) ? "verified" : "unverified";
}

export function orderCitations(citations: readonly CitationView[]): CitationView[] {
  return [...citations].sort(
    (left, right) =>
      left.displayIndex - right.displayIndex ||
      left.sourceId.localeCompare(right.sourceId) ||
      left.id.localeCompare(right.id),
  );
}

/**
 * Sorts the durable event projection for presentation and reports broken
 * sequence invariants instead of hiding or repairing them in the UI.
 */
export function auditRunTimeline(
  events: readonly RunTimelineEventView[],
  expectedRunId?: string,
): RunTimelineAudit {
  const scoped = expectedRunId
    ? events.filter((event) => event.runId === expectedRunId)
    : [...events];
  const ordered = [...scoped].sort(
    (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  const issues: string[] = [];
  const seenIds = new Set<string>();
  const seenSequences = new Set<number>();

  for (const event of ordered) {
    if (seenIds.has(event.id)) issues.push(`Duplicate event ID: ${event.id}`);
    seenIds.add(event.id);
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
      issues.push(`Invalid event sequence: ${event.sequence}`);
    }
    if (seenSequences.has(event.sequence)) {
      issues.push(`Duplicate event sequence: ${event.sequence}`);
    }
    seenSequences.add(event.sequence);
    if (expectedRunId && event.runId !== expectedRunId) {
      issues.push(`Event ${event.id} belongs to another run.`);
    }
  }

  if (ordered.length > 0) {
    const firstSequence = ordered[0]?.sequence;
    if (firstSequence !== 1) issues.push(`Timeline begins at sequence ${firstSequence ?? "unknown"}, not 1.`);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous && current && current.sequence > previous.sequence + 1) {
        issues.push(`Missing event sequences ${previous.sequence + 1}–${current.sequence - 1}.`);
      }
    }
  }

  return { events: ordered, issues: [...new Set(issues)] };
}
