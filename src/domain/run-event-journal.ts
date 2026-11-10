import { assertDomain } from "./errors";
import type {
  CommandId,
  IterationId,
  RunEventId,
  RunId,
  RunItemId,
} from "./ids";
import {
  isRunTerminal,
  type RunEvent,
  type RunEventSensitivity,
  type RunEventSource,
  type RunEventType,
  type RunEventVisibility,
  type RunState,
} from "./run";
import {
  assertIntegerInRange,
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  freezeJson,
  type IsoTimestamp,
  type JsonValue,
} from "./shared";

const MAX_EVENT_BATCH_SIZE = 256;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_EVENT_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_REPLAY_PAGE_SIZE = 1_000;

const RUN_EVENT_TYPES = {
  "run.created": true,
  "run.resolving": true,
  "run.awaiting_approval": true,
  "run.dispatching": true,
  "run.started": true,
  "run.paused": true,
  "run.resumed": true,
  "run.cancel_requested": true,
  "run.finalizing": true,
  "run.completed": true,
  "run.cancelled": true,
  "run.failed": true,
  "run.recovered": true,
  "policy.evaluated": true,
  "parameters.resolved": true,
  "skills.selected": true,
  "memory.retrieved": true,
  "context.compilation_started": true,
  "context.item_selected": true,
  "context.item_omitted": true,
  "context.compaction_started": true,
  "context.compaction_completed": true,
  "context.snapshot_frozen": true,
  "attempt.created": true,
  "attempt.dispatch_started": true,
  "attempt.accepted": true,
  "attempt.retry_scheduled": true,
  "attempt.fallback_proposed": true,
  "attempt.completed": true,
  "attempt.interrupted": true,
  "attempt.failed": true,
  "attempt.outcome_unknown": true,
  "item.started": true,
  "message.text_delta": true,
  "message.reasoning_summary_delta": true,
  "message.annotation": true,
  "citation.emitted": true,
  "artifact.delta": true,
  "tool.call_proposed": true,
  "tool.call_arguments_delta": true,
  "item.completed": true,
  "usage.updated": true,
  "notice.emitted": true,
  "validation.completed": true,
  "citation.validation_completed": true,
  "memory.proposal_created": true,
  "evaluation.completed": true,
  "checkpoint.created": true,
} as const satisfies Readonly<Record<RunEventType, true>>;

const RUN_EVENT_SOURCES = {
  harness: true,
  provider: true,
  tool: true,
  user: true,
  memory: true,
  skill: true,
} as const satisfies Readonly<Record<RunEventSource, true>>;

const RUN_EVENT_VISIBILITIES = {
  user: true,
  inspector: true,
  diagnostic: true,
} as const satisfies Readonly<Record<RunEventVisibility, true>>;

const RUN_EVENT_SENSITIVITIES = {
  normal: true,
  sensitive: true,
  secret_ref: true,
} as const satisfies Readonly<Record<RunEventSensitivity, true>>;

const TERMINAL_EVENT_BY_STATE = {
  completed: "run.completed",
  cancelled: "run.cancelled",
  failed: "run.failed",
} as const satisfies Readonly<
  Record<Extract<RunState, "completed" | "cancelled" | "failed">, RunEventType>
>;

const EVENTS_ALLOWED_AFTER_RUN_TERMINAL = {
  "validation.completed": true,
  "citation.validation_completed": true,
  "memory.proposal_created": true,
  "evaluation.completed": true,
  "checkpoint.created": true,
} as const satisfies Partial<Readonly<Record<RunEventType, true>>>;

const EXTENSION_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,62}\.[a-z0-9][a-z0-9_.-]{0,126}$/i;
const INGRESS_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export type RunJournalCoverage = "complete" | "legacy-partial" | "recovered-partial";

/**
 * Lineage that is already part of the target harness protocol but is not yet
 * present on the legacy in-memory Run aggregate. It remains immutable journal
 * data instead of being reconstructed from the renderer after a run.
 */
export interface RunEventLineage {
  readonly commandId?: CommandId;
  readonly correlationId?: string;
  readonly iterationId?: IterationId;
  readonly itemId?: RunItemId;
}

export type PendingRunJournalEvent<TPayload extends JsonValue = JsonValue> = Omit<
  RunEvent<TPayload>,
  "sequence"
> &
  RunEventLineage;

export type JournaledRunEvent<TPayload extends JsonValue = JsonValue> = RunEvent<TPayload> &
  RunEventLineage;

/**
 * The raw provider cursor or event ID never enters the common journal. The
 * native adapter hashes a canonical, attempt-bound producer identity and keeps
 * only this non-secret deduplication material.
 */
export interface RunEventIngressIdentity {
  readonly kind: "command-id" | "provider-event-id" | "provider-cursor" | "tool-event-id";
  readonly namespace: string;
  readonly identityHash: string;
}

export interface PendingRunJournalEntry {
  readonly event: PendingRunJournalEvent;
  readonly ingressIdentity?: RunEventIngressIdentity;
}

export interface RunEventJournalEntry {
  readonly event: JournaledRunEvent;
  readonly committedAt: IsoTimestamp;
  readonly ingressIdentity?: RunEventIngressIdentity;
}

export interface RunEventJournal {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  /** Changes after an import/restore that invalidates previously issued cursors. */
  readonly journalEpoch: string;
  readonly coverage: RunJournalCoverage;
  readonly coverageReason?: string;
  readonly entries: readonly RunEventJournalEntry[];
}

/**
 * Kernel-internal cursor position. Native IPC should serialize this as an
 * opaque token and must still re-check session/profile/run authorization.
 */
export interface RunJournalCursor {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly journalEpoch: string;
  readonly sequence: number;
  readonly eventId?: RunEventId;
}

export interface AppendRunEventBatchInput {
  /** Optimistic concurrency boundary for every newly appended event. */
  readonly expectedCursor: RunJournalCursor;
  readonly committedAt: IsoTimestamp;
  readonly entries: readonly PendingRunJournalEntry[];
}

export interface AppendRunEventBatchResult {
  readonly journal: RunEventJournal;
  readonly accepted: readonly JournaledRunEvent[];
  /** Canonical existing events returned for an exact lost-response retry. */
  readonly replayed: readonly JournaledRunEvent[];
  readonly cursor: RunJournalCursor;
}

export interface ReadRunEventPageInput {
  readonly afterCursor?: RunJournalCursor;
  /**
   * Pins a finite replay window. Reuse the returned throughCursor on every
   * subsequent page, then subscribe to the live tail after that watermark.
   */
  readonly throughCursor?: RunJournalCursor;
  readonly limit: number;
}

export interface RunEventReplayPage {
  readonly runId: RunId;
  readonly coverage: RunJournalCoverage;
  readonly coverageReason?: string;
  readonly events: readonly JournaledRunEvent[];
  readonly nextCursor: RunJournalCursor;
  readonly throughCursor: RunJournalCursor;
  readonly complete: boolean;
}

export interface CreateRunEventJournalInput {
  readonly runId: RunId;
  readonly journalEpoch: string;
  readonly coverage?: RunJournalCoverage;
  readonly coverageReason?: string;
}

function isKnownKey<TValue extends string>(
  value: string,
  values: Readonly<Record<TValue, true>>,
): value is TValue {
  return Object.prototype.hasOwnProperty.call(values, value);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    assertDomain(Number.isFinite(value), "invalid_argument", "Journal JSON cannot contain non-finite numbers.");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  assertDomain(
    typeof value === "object" && value !== undefined,
    "invalid_argument",
    "Journal values must be JSON-compatible.",
  );
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function normalizedEventFact(event: JournaledRunEvent, includeLocalIdentity: boolean): string {
  return canonicalJson({
    ...(includeLocalIdentity ? { id: event.id, occurredAt: event.occurredAt } : {}),
    schemaVersion: event.schemaVersion,
    type: event.type,
    projectId: event.projectId,
    conversationId: event.conversationId,
    branchId: event.branchId,
    runSetId: event.runSetId,
    runId: event.runId,
    attemptId: event.attemptId,
    commandId: event.commandId,
    correlationId: event.correlationId,
    iterationId: event.iterationId,
    itemId: event.itemId,
    source: event.source,
    visibility: event.visibility,
    sensitivity: event.sensitivity,
    payload: event.payload,
    extensions: event.extensions,
  });
}

function sameIngressIdentity(
  left: RunEventIngressIdentity | undefined,
  right: RunEventIngressIdentity | undefined,
): boolean {
  return (
    left?.kind === right?.kind &&
    left?.namespace === right?.namespace &&
    left?.identityHash === right?.identityHash
  );
}

function freezeExtensions(
  extensions: Readonly<Record<string, JsonValue>> | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  if (extensions === undefined) return undefined;
  const keys = Object.keys(extensions);
  assertDomain(keys.length <= 64, "invalid_argument", "Run event extensions exceed the key limit.", {
    keyCount: keys.length,
  });
  for (const key of keys) {
    assertDomain(
      EXTENSION_KEY_PATTERN.test(key),
      "invalid_argument",
      "Run event extension keys must be provider/tool namespaced.",
      { key },
    );
  }
  return freezeJson({ ...extensions });
}

function normalizeIngressIdentity(
  event: JournaledRunEvent,
  identity: RunEventIngressIdentity | undefined,
): RunEventIngressIdentity | undefined {
  if (identity === undefined) return undefined;
  assertDomain(
    identity.kind === "command-id" ||
      identity.kind === "provider-event-id" ||
      identity.kind === "provider-cursor" ||
      identity.kind === "tool-event-id",
    "invalid_argument",
    "Unsupported run event ingress identity kind.",
    { kind: identity.kind },
  );
  const namespace = assertNonBlank(identity.namespace, "run event ingress namespace", 128).toLowerCase();
  assertDomain(
    INGRESS_NAMESPACE_PATTERN.test(namespace),
    "invalid_argument",
    "Run event ingress namespace must use lowercase namespaced identifier characters.",
    { namespace },
  );
  if (identity.kind === "provider-event-id" || identity.kind === "provider-cursor") {
    assertDomain(
      event.source === "provider" && event.attemptId !== undefined,
      "scope_violation",
      "Provider ingress identities must be bound to a provider attempt event.",
      { eventId: event.id },
    );
  }
  if (identity.kind === "tool-event-id") {
    assertDomain(
      event.source === "tool",
      "scope_violation",
      "Tool ingress identities can only identify tool events.",
      { eventId: event.id },
    );
  }
  return Object.freeze({
    kind: identity.kind,
    namespace,
    identityHash: assertSha256(identity.identityHash, "run event ingress identity hash"),
  });
}

function ingressKey(event: JournaledRunEvent, identity: RunEventIngressIdentity): string {
  return [identity.kind, identity.namespace, event.attemptId ?? "run", identity.identityHash].join(":");
}

function normalizePendingEvent(
  runId: RunId,
  pending: PendingRunJournalEvent,
  sequence: number,
): JournaledRunEvent {
  assertDomain(pending.schemaVersion === 1, "invalid_argument", "Unsupported run event schema version.", {
    eventId: pending.id,
    schemaVersion: pending.schemaVersion,
  });
  assertDomain(
    isKnownKey(String(pending.type), RUN_EVENT_TYPES),
    "invalid_argument",
    "Unsupported run event type.",
    { eventId: pending.id, type: pending.type },
  );
  assertDomain(
    isKnownKey(String(pending.source), RUN_EVENT_SOURCES),
    "invalid_argument",
    "Unsupported run event source.",
    { eventId: pending.id, source: pending.source },
  );
  assertDomain(
    isKnownKey(String(pending.visibility), RUN_EVENT_VISIBILITIES),
    "invalid_argument",
    "Unsupported run event visibility.",
    { eventId: pending.id, visibility: pending.visibility },
  );
  assertDomain(
    isKnownKey(String(pending.sensitivity), RUN_EVENT_SENSITIVITIES),
    "invalid_argument",
    "Unsupported run event sensitivity.",
    { eventId: pending.id, sensitivity: pending.sensitivity },
  );
  assertNonBlank(pending.id, "run event ID", 256);
  assertNonBlank(pending.runId, "run event run ID", 256);
  assertDomain(pending.runId === runId, "scope_violation", "Run event belongs to another journal.", {
    eventId: pending.id,
    eventRunId: pending.runId,
    journalRunId: runId,
  });
  assertIsoTimestamp(pending.occurredAt, "run event occurrence time");
  assertIntegerInRange(sequence, "run event sequence", 1, Number.MAX_SAFE_INTEGER);
  if (pending.correlationId !== undefined) {
    assertNonBlank(pending.correlationId, "run event correlation ID", 256);
  }
  const extensions = freezeExtensions(pending.extensions);
  const event: JournaledRunEvent = Object.freeze({
    schemaVersion: 1,
    id: pending.id,
    sequence,
    type: pending.type,
    occurredAt: pending.occurredAt,
    ...(pending.projectId === undefined ? {} : { projectId: pending.projectId }),
    conversationId: pending.conversationId,
    branchId: pending.branchId,
    ...(pending.runSetId === undefined ? {} : { runSetId: pending.runSetId }),
    runId: pending.runId,
    ...(pending.attemptId === undefined ? {} : { attemptId: pending.attemptId }),
    ...(pending.commandId === undefined ? {} : { commandId: pending.commandId }),
    ...(pending.correlationId === undefined ? {} : { correlationId: pending.correlationId }),
    ...(pending.iterationId === undefined ? {} : { iterationId: pending.iterationId }),
    ...(pending.itemId === undefined ? {} : { itemId: pending.itemId }),
    source: pending.source,
    visibility: pending.visibility,
    sensitivity: pending.sensitivity,
    payload: freezeJson(pending.payload),
    ...(extensions === undefined ? {} : { extensions }),
  });
  const eventBytes = new TextEncoder().encode(canonicalJson(event)).byteLength;
  assertDomain(eventBytes <= MAX_EVENT_BYTES, "invalid_argument", "Run event exceeds the size limit.", {
    eventId: event.id,
    eventBytes,
    maximumBytes: MAX_EVENT_BYTES,
  });
  return event;
}

function terminalEvents(entries: readonly RunEventJournalEntry[]): readonly RunEventJournalEntry[] {
  return entries.filter(
    ({ event }) =>
      event.type === "run.completed" ||
      event.type === "run.cancelled" ||
      event.type === "run.failed",
  );
}

function assertCursorMatches(journal: RunEventJournal, cursor: RunJournalCursor): void {
  assertDomain(cursor.schemaVersion === 1, "invalid_argument", "Unsupported run journal cursor version.");
  assertDomain(
    cursor.runId === journal.runId && cursor.journalEpoch === journal.journalEpoch,
    "scope_violation",
    "Run journal cursor belongs to another run or journal epoch.",
    { runId: journal.runId },
  );
  assertIntegerInRange(cursor.sequence, "run journal cursor sequence", 0, journal.entries.length);
  if (cursor.sequence === 0) {
    assertDomain(
      cursor.eventId === undefined,
      "invalid_argument",
      "An empty run journal cursor cannot reference an event.",
    );
    return;
  }
  const event = journal.entries[cursor.sequence - 1]?.event;
  assertDomain(
    event !== undefined && event.id === cursor.eventId,
    "conflict",
    "Run journal cursor does not match the committed event at its sequence.",
    { sequence: cursor.sequence },
  );
}

export function createRunEventJournal(input: CreateRunEventJournalInput): RunEventJournal {
  assertNonBlank(input.runId, "run journal run ID", 256);
  const journalEpoch = assertNonBlank(input.journalEpoch, "run journal epoch", 128);
  const coverage = input.coverage ?? "complete";
  assertDomain(
    coverage === "complete" || coverage === "legacy-partial" || coverage === "recovered-partial",
    "invalid_argument",
    "Unsupported run journal coverage state.",
    { coverage },
  );
  const coverageReason =
    input.coverageReason === undefined
      ? undefined
      : assertNonBlank(input.coverageReason, "run journal coverage reason", 500);
  assertDomain(
    coverage === "complete" ? coverageReason === undefined : coverageReason !== undefined,
    "invalid_argument",
    "Partial run journals require a reason and complete journals cannot claim one.",
    { coverage },
  );
  return Object.freeze({
    schemaVersion: 1,
    runId: input.runId,
    journalEpoch,
    coverage,
    ...(coverageReason === undefined ? {} : { coverageReason }),
    entries: Object.freeze([]),
  });
}

export function runJournalCursorAt(
  journal: RunEventJournal,
  sequence = journal.entries.length,
): RunJournalCursor {
  validateRunEventJournal(journal);
  assertIntegerInRange(sequence, "run journal cursor sequence", 0, journal.entries.length);
  const eventId = sequence === 0 ? undefined : journal.entries[sequence - 1]?.event.id;
  return Object.freeze({
    schemaVersion: 1,
    runId: journal.runId,
    journalEpoch: journal.journalEpoch,
    sequence,
    ...(eventId === undefined ? {} : { eventId }),
  });
}

export function appendRunEventBatch(
  journal: RunEventJournal,
  input: AppendRunEventBatchInput,
): AppendRunEventBatchResult {
  validateRunEventJournal(journal);
  assertIsoTimestamp(input.committedAt, "run event commit time");
  // Validate the caller's run/epoch binding even for an exact lost-response
  // replay. A stale cursor from another epoch must never be accepted merely
  // because the producer identity happens to match an existing event.
  assertCursorMatches(journal, input.expectedCursor);
  assertDomain(input.entries.length > 0, "invalid_argument", "Run event batch cannot be empty.");
  assertDomain(
    input.entries.length <= MAX_EVENT_BATCH_SIZE,
    "invalid_argument",
    "Run event batch exceeds the event-count limit.",
    { eventCount: input.entries.length, maximum: MAX_EVENT_BATCH_SIZE },
  );

  const normalized = input.entries.map((entry) => {
    const event = normalizePendingEvent(journal.runId, entry.event, 1);
    return Object.freeze({
      event,
      ingressIdentity: normalizeIngressIdentity(event, entry.ingressIdentity),
    });
  });
  const batchBytes = normalized.reduce(
    (total, entry) => total + new TextEncoder().encode(canonicalJson(entry)).byteLength,
    0,
  );
  assertDomain(
    batchBytes <= MAX_EVENT_BATCH_BYTES,
    "invalid_argument",
    "Run event batch exceeds the byte limit.",
    { batchBytes, maximumBytes: MAX_EVENT_BATCH_BYTES },
  );

  const currentById = new Map(journal.entries.map((entry) => [entry.event.id, entry]));
  const currentByIngress = new Map<string, RunEventJournalEntry>();
  for (const entry of journal.entries) {
    if (entry.ingressIdentity !== undefined) {
      currentByIngress.set(ingressKey(entry.event, entry.ingressIdentity), entry);
    }
  }

  const existingMatches = normalized.map((candidate) => {
    const byId = currentById.get(candidate.event.id);
    const byIngress =
      candidate.ingressIdentity === undefined
        ? undefined
        : currentByIngress.get(ingressKey(candidate.event, candidate.ingressIdentity));
    assertDomain(
      byId === undefined || byIngress === undefined || byId === byIngress,
      "conflict",
      "Run event ID and producer identity resolve to different committed facts.",
      { eventId: candidate.event.id },
    );
    const match = byId ?? byIngress;
    if (match === undefined) return undefined;
    if (byId !== undefined) {
      assertDomain(
        normalizedEventFact(match.event, true) === normalizedEventFact(candidate.event, true) &&
          sameIngressIdentity(match.ingressIdentity, candidate.ingressIdentity),
        "conflict",
        "A run event ID was replayed with a different envelope.",
        { eventId: candidate.event.id },
      );
    }
    if (byIngress !== undefined) {
      assertDomain(
        normalizedEventFact(match.event, false) === normalizedEventFact(candidate.event, false),
        "conflict",
        "A producer event identity was replayed with a different normalized fact.",
        { eventId: candidate.event.id },
      );
    }
    return match;
  });

  if (existingMatches.every((match) => match !== undefined)) {
    const replayed = Object.freeze(existingMatches.map((match) => match!.event));
    return Object.freeze({
      journal,
      accepted: Object.freeze([]),
      replayed,
      cursor: runJournalCursorAt(journal),
    });
  }

  assertDomain(
    input.expectedCursor.sequence === journal.entries.length,
    "conflict",
    "New run events must append at the current journal head.",
    { expectedSequence: input.expectedCursor.sequence, headSequence: journal.entries.length },
  );

  const staged = [...journal.entries];
  const byId = new Map(staged.map((entry) => [entry.event.id, entry]));
  const byIngress = new Map<string, RunEventJournalEntry>();
  for (const entry of staged) {
    if (entry.ingressIdentity !== undefined) {
      byIngress.set(ingressKey(entry.event, entry.ingressIdentity), entry);
    }
  }
  const accepted: JournaledRunEvent[] = [];
  const replayed: JournaledRunEvent[] = [];
  let terminal = terminalEvents(staged)[0];

  for (const candidate of normalized) {
    const idMatch = byId.get(candidate.event.id);
    const ingressMatch =
      candidate.ingressIdentity === undefined
        ? undefined
        : byIngress.get(ingressKey(candidate.event, candidate.ingressIdentity));
    assertDomain(
      idMatch === undefined || ingressMatch === undefined || idMatch === ingressMatch,
      "conflict",
      "Run event ID and producer identity resolve to different facts in one batch.",
      { eventId: candidate.event.id },
    );
    const match = idMatch ?? ingressMatch;
    if (match !== undefined) {
      if (idMatch !== undefined) {
        assertDomain(
          normalizedEventFact(match.event, true) === normalizedEventFact(candidate.event, true) &&
            sameIngressIdentity(match.ingressIdentity, candidate.ingressIdentity),
          "conflict",
          "A run event ID conflicts within its append batch.",
          { eventId: candidate.event.id },
        );
      }
      if (ingressMatch !== undefined) {
        assertDomain(
          normalizedEventFact(match.event, false) === normalizedEventFact(candidate.event, false),
          "conflict",
          "A producer event identity conflicts within its append batch.",
          { eventId: candidate.event.id },
        );
      }
      replayed.push(match.event);
      continue;
    }

    assertDomain(
      terminal === undefined ||
        Object.prototype.hasOwnProperty.call(EVENTS_ALLOWED_AFTER_RUN_TERMINAL, candidate.event.type),
      "invalid_state_transition",
      "Only bounded post-run facts can be appended after a run terminal event.",
      { eventId: candidate.event.id, eventType: candidate.event.type },
    );

    const event = normalizePendingEvent(journal.runId, candidate.event, staged.length + 1);
    const isTerminal =
      event.type === "run.completed" || event.type === "run.cancelled" || event.type === "run.failed";
    assertDomain(
      !isTerminal || terminal === undefined,
      "invalid_state_transition",
      "A run journal can contain only one terminal run event.",
      { eventId: event.id, terminalEventId: terminal?.event.id },
    );
    const entry: RunEventJournalEntry = Object.freeze({
      event,
      committedAt: input.committedAt,
      ...(candidate.ingressIdentity === undefined
        ? {}
        : { ingressIdentity: candidate.ingressIdentity }),
    });
    staged.push(entry);
    byId.set(event.id, entry);
    if (entry.ingressIdentity !== undefined) {
      byIngress.set(ingressKey(event, entry.ingressIdentity), entry);
    }
    if (isTerminal) terminal = entry;
    accepted.push(event);
  }

  const nextJournal: RunEventJournal = Object.freeze({
    ...journal,
    entries: Object.freeze(staged),
  });
  validateRunEventJournal(nextJournal);
  return Object.freeze({
    journal: nextJournal,
    accepted: Object.freeze(accepted),
    replayed: Object.freeze(replayed),
    cursor: runJournalCursorAt(nextJournal),
  });
}

export function readRunEventPage(
  journal: RunEventJournal,
  input: ReadRunEventPageInput,
): RunEventReplayPage {
  validateRunEventJournal(journal);
  const limit = assertIntegerInRange(input.limit, "run event replay page size", 1, MAX_REPLAY_PAGE_SIZE);
  const afterCursor = input.afterCursor ?? runJournalCursorAt(journal, 0);
  const throughCursor = input.throughCursor ?? runJournalCursorAt(journal);
  assertCursorMatches(journal, afterCursor);
  assertCursorMatches(journal, throughCursor);
  assertDomain(
    afterCursor.sequence <= throughCursor.sequence,
    "invalid_argument",
    "Run event replay cursor cannot be after its fixed watermark.",
    { afterSequence: afterCursor.sequence, throughSequence: throughCursor.sequence },
  );
  const endSequence = Math.min(afterCursor.sequence + limit, throughCursor.sequence);
  const events = Object.freeze(
    journal.entries.slice(afterCursor.sequence, endSequence).map((entry) => entry.event),
  );
  const nextCursor = runJournalCursorAt(journal, endSequence);
  return Object.freeze({
    runId: journal.runId,
    coverage: journal.coverage,
    ...(journal.coverageReason === undefined ? {} : { coverageReason: journal.coverageReason }),
    events,
    nextCursor,
    throughCursor: runJournalCursorAt(journal, throughCursor.sequence),
    complete: endSequence === throughCursor.sequence,
  });
}

export function assertRunJournalMatchesRunState(journal: RunEventJournal, state: RunState): void {
  validateRunEventJournal(journal);
  const terminals = terminalEvents(journal.entries);
  if (!isRunTerminal(state)) {
    assertDomain(
      terminals.length === 0,
      "invalid_state_transition",
      "A nonterminal run cannot have a terminal journal event.",
      { runId: journal.runId, state },
    );
    return;
  }
  assertDomain(
    terminals.length === 1 && terminals[0]?.event.type === TERMINAL_EVENT_BY_STATE[state],
    "invalid_state_transition",
    "Terminal run state and terminal journal event do not match.",
    { runId: journal.runId, state, eventType: terminals[0]?.event.type },
  );
}

export function validateRunEventJournal(journal: RunEventJournal): void {
  assertDomain(journal.schemaVersion === 1, "invalid_argument", "Unsupported run journal version.");
  assertNonBlank(journal.runId, "run journal run ID", 256);
  assertNonBlank(journal.journalEpoch, "run journal epoch", 128);
  assertDomain(
    journal.coverage === "complete" ||
      journal.coverage === "legacy-partial" ||
      journal.coverage === "recovered-partial",
    "invalid_argument",
    "Unsupported run journal coverage state.",
    { coverage: journal.coverage },
  );
  assertDomain(
    journal.coverage === "complete"
      ? journal.coverageReason === undefined
      : journal.coverageReason !== undefined,
    "invalid_argument",
    "Run journal coverage metadata is inconsistent.",
    { coverage: journal.coverage },
  );
  if (journal.coverageReason !== undefined) {
    assertNonBlank(journal.coverageReason, "run journal coverage reason", 500);
  }

  const eventIds = new Set<RunEventId>();
  const ingressIdentities = new Set<string>();
  for (const [index, entry] of journal.entries.entries()) {
    assertIsoTimestamp(entry.committedAt, "run event commit time");
    assertDomain(
      entry.event.sequence === index + 1,
      "invalid_state_transition",
      "Run event journal sequence must be monotonic and gap-free.",
      { runId: journal.runId, expectedSequence: index + 1, actualSequence: entry.event.sequence },
    );
    assertDomain(entry.event.runId === journal.runId, "scope_violation", "Run event has wrong journal scope.", {
      eventId: entry.event.id,
      runId: journal.runId,
    });
    assertDomain(!eventIds.has(entry.event.id), "conflict", "Run event ID is duplicated in the journal.", {
      eventId: entry.event.id,
    });
    eventIds.add(entry.event.id);
    const normalizedEvent = normalizePendingEvent(journal.runId, entry.event, entry.event.sequence);
    assertDomain(
      normalizedEventFact(normalizedEvent, true) === normalizedEventFact(entry.event, true),
      "invalid_argument",
      "Run event is not a valid canonical journal envelope.",
      { eventId: entry.event.id },
    );
    const identity = normalizeIngressIdentity(entry.event, entry.ingressIdentity);
    if (identity !== undefined) {
      const key = ingressKey(entry.event, identity);
      assertDomain(
        !ingressIdentities.has(key),
        "conflict",
        "Producer event identity is duplicated in the run journal.",
        { eventId: entry.event.id },
      );
      ingressIdentities.add(key);
    }
  }
  assertDomain(
    terminalEvents(journal.entries).length <= 1,
    "invalid_state_transition",
    "Run journal contains more than one terminal run event.",
    { runId: journal.runId },
  );
}
