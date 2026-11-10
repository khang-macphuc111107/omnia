import { assertDomain } from "./errors";
import type {
  AttemptId,
  BranchId,
  ContextSnapshotId,
  ConversationId,
  MessageId,
  ModelProfileId,
  ProjectId,
  ProviderConnectionId,
  RunEventId,
  RunId,
  RunSetId,
} from "./ids";
import type { ResolvedParameterSet } from "./parameters";
import { createOutputRoute, type OutputRoute } from "./output-route";
import { validateRetrievalRequestReceipt, type RetrievalRequestReceipt } from "./retrieval-request-receipt";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  freezeJson,
  type IsoTimestamp,
  type JsonObject,
  type JsonValue,
} from "./shared";

export type RunState =
  | "queued"
  | "resolving"
  | "awaiting-approval"
  | "dispatching"
  | "streaming"
  | "paused"
  | "cancelling"
  | "finalizing"
  | "completed"
  | "cancelled"
  | "failed";

export type AttemptState =
  | "created"
  | "dispatching"
  | "accepted"
  | "streaming"
  | "completed"
  | "interrupted"
  | "failed"
  | "unknown";

export type RunTerminalState = Extract<RunState, "completed" | "cancelled" | "failed">;
export type AttemptTerminalState = Extract<
  AttemptState,
  "completed" | "interrupted" | "failed" | "unknown"
>;

const RUN_TRANSITIONS = {
  queued: ["resolving", "cancelling", "cancelled"],
  resolving: ["awaiting-approval", "dispatching", "cancelling", "failed"],
  "awaiting-approval": ["resolving", "cancelling", "cancelled"],
  dispatching: ["streaming", "cancelling", "failed", "paused"],
  streaming: ["awaiting-approval", "paused", "cancelling", "finalizing", "failed"],
  paused: ["streaming", "cancelling", "failed"],
  cancelling: ["cancelled", "completed", "failed"],
  finalizing: ["completed", "cancelling", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
} as const satisfies Readonly<Record<RunState, readonly RunState[]>>;

const ATTEMPT_TRANSITIONS = {
  created: ["dispatching", "failed"],
  dispatching: ["accepted", "failed", "unknown"],
  accepted: ["streaming", "completed", "failed", "unknown"],
  streaming: ["completed", "interrupted", "failed", "unknown"],
  completed: [],
  interrupted: [],
  failed: [],
  unknown: [],
} as const satisfies Readonly<Record<AttemptState, readonly AttemptState[]>>;

export function isRunTerminal(state: RunState): state is RunTerminalState {
  return state === "completed" || state === "cancelled" || state === "failed";
}

export function isAttemptTerminal(state: AttemptState): state is AttemptTerminalState {
  return (
    state === "completed" ||
    state === "interrupted" ||
    state === "failed" ||
    state === "unknown"
  );
}

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return (RUN_TRANSITIONS[from] as readonly RunState[]).includes(to);
}

export function canTransitionAttempt(from: AttemptState, to: AttemptState): boolean {
  return (ATTEMPT_TRANSITIONS[from] as readonly AttemptState[]).includes(to);
}

export type RunEventSource = "harness" | "provider" | "tool" | "user" | "memory" | "skill";
export type RunEventVisibility = "user" | "inspector" | "diagnostic";
export type RunEventSensitivity = "normal" | "sensitive" | "secret_ref";

export type RunEventType =
  | "run.created"
  | "run.resolving"
  | "run.awaiting_approval"
  | "run.dispatching"
  | "run.started"
  | "run.paused"
  | "run.resumed"
  | "run.cancel_requested"
  | "run.finalizing"
  | "run.completed"
  | "run.cancelled"
  | "run.failed"
  | "run.recovered"
  | "policy.evaluated"
  | "parameters.resolved"
  | "skills.selected"
  | "memory.retrieved"
  | "context.compilation_started"
  | "context.item_selected"
  | "context.item_omitted"
  | "context.compaction_started"
  | "context.compaction_completed"
  | "context.snapshot_frozen"
  | "attempt.created"
  | "attempt.dispatch_started"
  | "attempt.accepted"
  | "attempt.retry_scheduled"
  | "attempt.fallback_proposed"
  | "attempt.completed"
  | "attempt.interrupted"
  | "attempt.failed"
  | "attempt.outcome_unknown"
  | "item.started"
  | "message.text_delta"
  | "message.reasoning_summary_delta"
  | "message.annotation"
  | "citation.emitted"
  | "artifact.delta"
  | "tool.call_proposed"
  | "tool.call_arguments_delta"
  | "item.completed"
  | "usage.updated"
  | "notice.emitted"
  | "validation.completed"
  | "citation.validation_completed"
  | "memory.proposal_created"
  | "evaluation.completed"
  | "checkpoint.created";

export interface RunEvent<TPayload extends JsonValue = JsonValue> {
  readonly schemaVersion: 1;
  readonly id: RunEventId;
  /** Monotonic and gap-free inside one run. */
  readonly sequence: number;
  readonly type: RunEventType;
  readonly occurredAt: IsoTimestamp;
  readonly projectId?: ProjectId;
  readonly conversationId: ConversationId;
  readonly branchId: BranchId;
  readonly runSetId?: RunSetId;
  readonly runId: RunId;
  readonly attemptId?: AttemptId;
  readonly source: RunEventSource;
  readonly visibility: RunEventVisibility;
  readonly sensitivity: RunEventSensitivity;
  readonly payload: TPayload;
  /** Keys must be provider/tool namespaced; secret-bearing values are forbidden. */
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

export interface UsageRecord {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cost?: {
    readonly amountMicrounits: number;
    readonly currency: string;
    readonly provenance: "reported" | "estimated";
    readonly priceTableObservedAt?: IsoTimestamp;
  };
}

export interface UsageDelta {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cost?: UsageRecord["cost"];
}

function assertUsageValue(value: number | undefined, label: string): void {
  assertDomain(
    value === undefined || (Number.isSafeInteger(value) && value >= 0),
    "invalid_argument",
    `${label} must be a non-negative safe integer.`,
    { value },
  );
}

function assertNotBefore(value: IsoTimestamp, minimum: IsoTimestamp, label: string): void {
  assertIsoTimestamp(value, label);
  assertDomain(
    Date.parse(value) >= Date.parse(minimum),
    "invalid_argument",
    `${label} cannot move backwards.`,
    { value, minimum },
  );
}

/** Usage events are monotonic snapshots; provider corrections may only increase totals. */
export function updateRunUsage(run: Run, delta: UsageDelta, now: IsoTimestamp): Run {
  assertNotBefore(now, run.updatedAt, "run usage update time");
  assertUsageValue(delta.inputTokens, "input tokens");
  assertUsageValue(delta.cachedInputTokens, "cached input tokens");
  assertUsageValue(delta.outputTokens, "output tokens");
  assertUsageValue(delta.reasoningTokens, "reasoning tokens");
  if (delta.cost !== undefined) {
    assertUsageValue(delta.cost.amountMicrounits, "cost microunits");
    assertDomain(delta.cost.currency.trim().length > 0, "invalid_argument", "Usage currency cannot be empty.");
  }
  const previous = run.usage;
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens"] as const) {
    const nextValue = delta[key];
    const previousValue = previous?.[key];
    assertDomain(
      nextValue === undefined || previousValue === undefined || nextValue >= previousValue,
      "invalid_state_transition",
      "Usage counters cannot decrease.",
      { runId: run.id, key, previousValue, nextValue },
    );
  }
  if (delta.cost !== undefined && previous?.cost !== undefined) {
    assertDomain(
      delta.cost.currency === previous.cost.currency &&
        delta.cost.amountMicrounits >= previous.cost.amountMicrounits,
      "invalid_state_transition",
      "Run cost cannot change currency or decrease.",
      { runId: run.id },
    );
  }
  const inputTokens = delta.inputTokens ?? previous?.inputTokens;
  const cachedInputTokens = delta.cachedInputTokens ?? previous?.cachedInputTokens;
  const outputTokens = delta.outputTokens ?? previous?.outputTokens;
  const reasoningTokens = delta.reasoningTokens ?? previous?.reasoningTokens;
  const usage: UsageRecord = Object.freeze({
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(delta.cost === undefined
      ? previous?.cost === undefined
        ? {}
        : { cost: previous.cost }
      : { cost: Object.freeze({ ...delta.cost }) }),
  });
  return Object.freeze({ ...run, usage, updatedAt: now });
}

export interface RunSnapshot {
  readonly id: ContextSnapshotId;
  readonly version: 1;
  readonly contentHash: string;
  readonly providerConnectionId: ProviderConnectionId;
  readonly modelProfileId: ModelProfileId;
  readonly providerModelId: string;
  readonly parameters: ResolvedParameterSet;
  readonly contextItemHashes: Readonly<Record<string, string>>;
  readonly skillVersionHashes: Readonly<Record<string, string>>;
  readonly memoryRevisionHashes: Readonly<Record<string, string>>;
  readonly policyDecisionIds: readonly string[];
  /** Content-free retrieval decision receipt captured with the frozen input. */
  readonly retrievalReceipt?: RetrievalRequestReceipt;
  readonly frozenAt: IsoTimestamp;
  readonly extensions: JsonObject;
}

export interface RunAttempt {
  readonly id: AttemptId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly providerConnectionId: ProviderConnectionId;
  readonly modelProfileId: ModelProfileId;
  readonly providerModelId: string;
  readonly state: AttemptState;
  readonly remoteRequestId?: string;
  readonly createdAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly acceptedByProvider: boolean | "unknown";
  readonly idempotencySupported: boolean;
  readonly errorCode?: string;
}

export interface Run {
  readonly id: RunId;
  readonly runSetId?: RunSetId;
  readonly conversationId: ConversationId;
  readonly branchId: BranchId;
  readonly projectId?: ProjectId;
  /** Immutable producer destination captured before execution begins. */
  readonly outputRoute?: OutputRoute;
  readonly userMessageId: MessageId;
  readonly assistantMessageId?: MessageId;
  readonly state: RunState;
  readonly sequence: number;
  readonly snapshot?: RunSnapshot;
  readonly attempts: readonly RunAttempt[];
  readonly events: readonly RunEvent[];
  readonly usage?: UsageRecord;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly terminalAt?: IsoTimestamp;
  readonly failure?: {
    readonly code: string;
    readonly retryable: boolean;
    readonly diagnosticId?: string;
  };
}

export interface CreateRunInput {
  readonly id: RunId;
  readonly runSetId?: RunSetId;
  readonly conversationId: ConversationId;
  readonly branchId: BranchId;
  readonly projectId?: ProjectId;
  /** Optional during migration; when present it is validated against run scope. */
  readonly outputRoute?: OutputRoute;
  readonly userMessageId: MessageId;
  readonly now: IsoTimestamp;
}

export function createRun(input: CreateRunInput): Run {
  assertIsoTimestamp(input.now, "run creation time");
  const outputRoute =
    input.outputRoute === undefined ? undefined : createOutputRoute(input.outputRoute);
  if (outputRoute !== undefined) {
    assertDomain(
      outputRoute.runId === input.id,
      "scope_violation",
      "Output route belongs to a different run.",
      { runId: input.id, routeRunId: outputRoute.runId },
    );
    assertDomain(
      outputRoute.conversationId === input.conversationId,
      "scope_violation",
      "Output route belongs to a different conversation.",
      { runId: input.id, conversationId: input.conversationId, routeConversationId: outputRoute.conversationId },
    );
    assertDomain(
      outputRoute.branchId === input.branchId,
      "scope_violation",
      "Output route belongs to a different branch.",
      { runId: input.id, branchId: input.branchId, routeBranchId: outputRoute.branchId },
    );
    assertDomain(
      outputRoute.projectId === input.projectId,
      "scope_violation",
      "Output route project scope does not match the run.",
      { runId: input.id, projectId: input.projectId, routeProjectId: outputRoute.projectId },
    );
  }
  return Object.freeze({
    id: input.id,
    ...(input.runSetId === undefined ? {} : { runSetId: input.runSetId }),
    conversationId: input.conversationId,
    branchId: input.branchId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(outputRoute === undefined ? {} : { outputRoute }),
    userMessageId: input.userMessageId,
    state: "queued",
    sequence: 0,
    attempts: Object.freeze([]),
    events: Object.freeze([]),
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export interface TransitionRunInput {
  readonly to: RunState;
  readonly now: IsoTimestamp;
  readonly assistantMessageId?: MessageId;
  readonly failure?: Run["failure"];
}

export function transitionRun(run: Run, input: TransitionRunInput): Run {
  assertNotBefore(input.now, run.updatedAt, "run transition time");
  assertDomain(
    canTransitionRun(run.state, input.to),
    "invalid_state_transition",
    `Run cannot transition from ${run.state} to ${input.to}.`,
    { runId: run.id, from: run.state, to: input.to },
  );

  if (input.to === "dispatching") {
    assertDomain(
      run.snapshot !== undefined,
      "invalid_state_transition",
      "A run snapshot must be frozen before provider dispatch.",
      { runId: run.id },
    );
  }
  if (input.to === "completed") {
    assertDomain(
      input.assistantMessageId !== undefined || run.assistantMessageId !== undefined,
      "invalid_state_transition",
      "A completed run must reference its finalized assistant message.",
      { runId: run.id },
    );
  }
  if (input.to === "failed") {
    assertDomain(
      input.failure !== undefined,
      "invalid_argument",
      "A failed run requires a typed failure.",
      { runId: run.id },
    );
  } else {
    assertDomain(
      input.failure === undefined,
      "invalid_argument",
      "Failure metadata is only valid for a failed run transition.",
      { runId: run.id, to: input.to },
    );
  }

  return Object.freeze({
    ...run,
    state: input.to,
    sequence: run.sequence + 1,
    ...(input.assistantMessageId === undefined
      ? {}
      : { assistantMessageId: input.assistantMessageId }),
    ...(input.failure === undefined ? {} : { failure: Object.freeze({ ...input.failure }) }),
    updatedAt: input.now,
    ...(isRunTerminal(input.to) ? { terminalAt: input.now } : {}),
  });
}

export function freezeRunSnapshot(run: Run, snapshot: RunSnapshot, now: IsoTimestamp): Run {
  assertNotBefore(now, run.updatedAt, "run snapshot update time");
  assertIsoTimestamp(snapshot.frozenAt, "run snapshot frozen time");
  assertDomain(
    Date.parse(snapshot.frozenAt) >= Date.parse(run.createdAt) &&
      Date.parse(snapshot.frozenAt) <= Date.parse(now),
    "invalid_argument",
    "Snapshot freeze time must fall inside the run lifetime.",
    { runId: run.id },
  );
  assertDomain(snapshot.version === 1, "invalid_argument", "Unsupported run snapshot version.", {
    runId: run.id,
    version: snapshot.version,
  });
  assertDomain(
    run.state === "resolving" || run.state === "awaiting-approval",
    "invalid_state_transition",
    "Run inputs can only be frozen during resolution.",
    { runId: run.id, state: run.state },
  );
  assertDomain(run.snapshot === undefined, "conflict", "Run inputs have already been frozen.", {
    runId: run.id,
    snapshotId: run.snapshot?.id,
  });

  assertDomain(
    snapshot.providerModelId.trim().length > 0,
    "invalid_argument",
    "A run snapshot must identify the provider model.",
    { runId: run.id },
  );
  assertSha256(snapshot.contentHash, "run snapshot content hash");
  for (const [parameterKey, parameter] of Object.entries(snapshot.parameters)) {
    assertDomain(
      parameter.key === parameterKey,
      "invalid_state_transition",
      "Resolved parameter key does not match its snapshot map key.",
      { runId: run.id, parameterKey, declaredKey: parameter.key },
    );
    assertDomain(
      !parameter.sent || parameter.value !== undefined,
      "invalid_state_transition",
      "A sent parameter must preserve its resolved value.",
      { runId: run.id, parameterKey },
    );
  }
  for (const hashes of [
    snapshot.contextItemHashes,
    snapshot.skillVersionHashes,
    snapshot.memoryRevisionHashes,
  ]) {
    for (const [entityId, contentHash] of Object.entries(hashes)) {
      assertSha256(contentHash, `snapshot provenance hash for ${entityId}`);
    }
  }
  if (snapshot.retrievalReceipt !== undefined) {
    assertDomain(snapshot.retrievalReceipt.runId === undefined || snapshot.retrievalReceipt.runId === run.id, "scope_violation", "Retrieval receipt belongs to another run.", { runId: run.id });
    validateRetrievalRequestReceipt(snapshot.retrievalReceipt);
  }

  const frozenSnapshot: RunSnapshot = Object.freeze({
    ...snapshot,
    parameters: Object.freeze({ ...snapshot.parameters }),
    contextItemHashes: Object.freeze({ ...snapshot.contextItemHashes }),
    skillVersionHashes: Object.freeze({ ...snapshot.skillVersionHashes }),
    memoryRevisionHashes: Object.freeze({ ...snapshot.memoryRevisionHashes }),
    policyDecisionIds: Object.freeze([...snapshot.policyDecisionIds]),
    ...(snapshot.retrievalReceipt === undefined ? {} : { retrievalReceipt: snapshot.retrievalReceipt }),
    extensions: freezeJson(snapshot.extensions),
  });
  return Object.freeze({ ...run, snapshot: frozenSnapshot, updatedAt: now });
}

export interface CreateAttemptInput {
  readonly id: AttemptId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly modelProfileId: ModelProfileId;
  readonly providerModelId: string;
  readonly idempotencySupported: boolean;
  readonly now: IsoTimestamp;
}

export function addRunAttempt(run: Run, input: CreateAttemptInput): Run {
  assertNotBefore(input.now, run.updatedAt, "attempt creation time");
  assertDomain(
    run.state === "dispatching" || run.state === "streaming" || run.state === "paused",
    "invalid_state_transition",
    "Provider attempts can only be added to a dispatching, streaming, or paused run.",
    { runId: run.id, state: run.state },
  );
  assertDomain(
    !run.attempts.some((attempt) => attempt.id === input.id),
    "conflict",
    "Attempt ID already exists.",
    { attemptId: input.id },
  );
  const previous = run.attempts.at(-1);
  if (previous !== undefined) {
    assertDomain(
      isAttemptTerminal(previous.state),
      "invalid_state_transition",
      "A new attempt cannot start while the previous attempt is nonterminal.",
      { runId: run.id, previousAttemptId: previous.id, previousState: previous.state },
    );
    assertDomain(
      previous.state !== "unknown",
      "invalid_state_transition",
      "An outcome-unknown attempt must not be retried automatically.",
      { runId: run.id, previousAttemptId: previous.id },
    );
  }

  const attempt: RunAttempt = Object.freeze({
    id: input.id,
    runId: run.id,
    ordinal: run.attempts.length + 1,
    providerConnectionId: input.providerConnectionId,
    modelProfileId: input.modelProfileId,
    providerModelId: assertNonBlank(input.providerModelId, "attempt provider model ID", 512),
    state: "created",
    createdAt: input.now,
    acceptedByProvider: false,
    idempotencySupported: input.idempotencySupported,
  });
  return Object.freeze({
    ...run,
    attempts: Object.freeze([...run.attempts, attempt]),
    updatedAt: input.now,
  });
}

export interface TransitionAttemptInput {
  readonly attemptId: AttemptId;
  readonly to: AttemptState;
  readonly now: IsoTimestamp;
  readonly remoteRequestId?: string;
  readonly errorCode?: string;
}

export function transitionRunAttempt(run: Run, input: TransitionAttemptInput): Run {
  assertNotBefore(input.now, run.updatedAt, "attempt transition time");
  const attemptIndex = run.attempts.findIndex((attempt) => attempt.id === input.attemptId);
  assertDomain(attemptIndex >= 0, "not_found", "Run attempt was not found.", {
    runId: run.id,
    attemptId: input.attemptId,
  });
  const attempt = run.attempts[attemptIndex];
  assertDomain(attempt !== undefined, "not_found", "Run attempt was not found.");
  assertDomain(
    canTransitionAttempt(attempt.state, input.to),
    "invalid_state_transition",
    `Attempt cannot transition from ${attempt.state} to ${input.to}.`,
    { attemptId: attempt.id, from: attempt.state, to: input.to },
  );
  assertDomain(
    input.errorCode === undefined || input.to === "failed" || input.to === "interrupted",
    "invalid_argument",
    "Attempt error metadata is only valid for failed or interrupted outcomes.",
    { attemptId: attempt.id, to: input.to },
  );

  const acceptedByProvider =
    input.to === "accepted" || input.to === "streaming" || input.to === "completed"
      ? true
      : input.to === "unknown"
        ? "unknown"
        : attempt.acceptedByProvider;
  const nextAttempt: RunAttempt = Object.freeze({
    ...attempt,
    state: input.to,
    acceptedByProvider,
    ...(input.remoteRequestId === undefined
      ? {}
      : { remoteRequestId: input.remoteRequestId }),
    ...(attempt.startedAt === undefined && input.to === "dispatching" ? { startedAt: input.now } : {}),
    ...(isAttemptTerminal(input.to) ? { completedAt: input.now } : {}),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  });
  return Object.freeze({
    ...run,
    attempts: Object.freeze(
      run.attempts.map((candidate, index) => (index === attemptIndex ? nextAttempt : candidate)),
    ),
    updatedAt: input.now,
  });
}

export function appendRunEvent(run: Run, event: RunEvent): Run {
  assertIsoTimestamp(event.occurredAt, "run event time");
  const previousEvent = run.events.at(-1);
  assertDomain(
    Date.parse(event.occurredAt) >= Date.parse(previousEvent?.occurredAt ?? run.createdAt),
    "invalid_argument",
    "Run event time cannot move backwards.",
    { eventId: event.id, runId: run.id },
  );
  assertDomain(event.runId === run.id, "scope_violation", "Event belongs to a different run.", {
    eventId: event.id,
    runId: run.id,
    eventRunId: event.runId,
  });
  assertDomain(
    event.conversationId === run.conversationId && event.branchId === run.branchId,
    "scope_violation",
    "Event conversation or branch does not match its run.",
    { eventId: event.id },
  );
  const expectedSequence = run.events.length + 1;
  assertDomain(
    event.sequence === expectedSequence,
    "invalid_state_transition",
    "Run event sequence must be monotonic and gap-free.",
    { eventId: event.id, expectedSequence, actualSequence: event.sequence },
  );
  assertDomain(
    !run.events.some((candidate) => candidate.id === event.id),
    "conflict",
    "Run event ID already exists.",
    { eventId: event.id },
  );

  assertDomain(event.schemaVersion === 1, "invalid_argument", "Unsupported run event schema version.", {
    eventId: event.id,
    schemaVersion: event.schemaVersion,
  });
  assertDomain(
    event.projectId === run.projectId,
    "scope_violation",
    "Event project does not match its run.",
    { eventId: event.id },
  );
  assertDomain(
    event.runSetId === run.runSetId,
    "scope_violation",
    "Event run set does not match its run.",
    { eventId: event.id },
  );
  if (event.attemptId !== undefined) {
    assertDomain(
      run.attempts.some((attempt) => attempt.id === event.attemptId),
      "scope_violation",
      "Event references an attempt outside its run.",
      { eventId: event.id, attemptId: event.attemptId },
    );
  }

  return Object.freeze({
    ...run,
    events: Object.freeze([...run.events, Object.freeze(event)]),
    updatedAt: event.occurredAt,
  });
}

export function validateRun(run: Run): void {
  if (
    run.state === "dispatching" ||
    run.state === "streaming" ||
    run.state === "paused" ||
    run.state === "cancelling" ||
    run.state === "finalizing" ||
    run.state === "completed"
  ) {
    assertDomain(run.snapshot !== undefined, "invalid_state_transition", "Active run has no frozen snapshot.", {
      runId: run.id,
    });
  }
  assertDomain(
    run.events.every((event, index) => event.sequence === index + 1),
    "invalid_state_transition",
    "Run event sequence contains a duplicate or gap.",
    { runId: run.id },
  );
  assertDomain(
    run.attempts.every((attempt, index) => attempt.ordinal === index + 1),
    "invalid_state_transition",
    "Run attempt ordinals are not contiguous.",
    { runId: run.id },
  );
  const nonterminalAttempts = run.attempts.filter((attempt) => !isAttemptTerminal(attempt.state));
  assertDomain(
    nonterminalAttempts.length <= 1,
    "invalid_state_transition",
    "A run cannot have more than one active provider attempt.",
    { runId: run.id },
  );
  if (isRunTerminal(run.state)) {
    assertDomain(run.terminalAt !== undefined, "invalid_state_transition", "Terminal run has no timestamp.", {
      runId: run.id,
    });
  }
  if (run.state === "completed") {
    assertDomain(
      run.assistantMessageId !== undefined,
      "invalid_state_transition",
      "Completed run has no finalized assistant message.",
      { runId: run.id },
    );
  }
  if (run.state === "failed") {
    assertDomain(run.failure !== undefined, "invalid_state_transition", "Failed run has no typed failure.", {
      runId: run.id,
    });
  } else {
    assertDomain(run.failure === undefined, "invalid_state_transition", "Non-failed run carries failure metadata.", {
      runId: run.id,
    });
  }
  for (const attempt of run.attempts) {
    assertDomain(attempt.runId === run.id, "scope_violation", "Attempt belongs to a different run.", {
      runId: run.id,
      attemptId: attempt.id,
    });
    assertDomain(
      isAttemptTerminal(attempt.state) === (attempt.completedAt !== undefined),
      "invalid_state_transition",
      "Attempt state and completion timestamp disagree.",
      { attemptId: attempt.id, state: attempt.state },
    );
  }
  if (run.usage !== undefined) {
    assertUsageValue(run.usage.inputTokens, "input tokens");
    assertUsageValue(run.usage.cachedInputTokens, "cached input tokens");
    assertUsageValue(run.usage.outputTokens, "output tokens");
    assertUsageValue(run.usage.reasoningTokens, "reasoning tokens");
  }
}
