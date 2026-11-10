import { assertDomain } from "./errors";
import type {
  AttemptId,
  BranchId,
  ConversationId,
  EntityId,
  IterationId,
  ModelProfileId,
  ProfileId,
  ProjectId,
  ProviderConnectionId,
  RunId,
  RunItemId,
} from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  freezeJson,
  type IsoTimestamp,
  type JsonObject,
} from "./shared";

export type TelemetryObservationId = EntityId<"telemetry-observation">;
export type UsageLedgerEntryId = EntityId<"usage-ledger-entry">;

export type TelemetryCoverage = "complete" | "partial" | "estimated" | "unknown";

/**
 * Correlation belongs in trace records, not in metric labels. Keeping the full
 * lineage here lets storage and the inspector remain precise without creating
 * unbounded OpenTelemetry metric cardinality.
 */
export interface TelemetryScope {
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly conversationId?: ConversationId;
  readonly branchId?: BranchId;
  readonly runId?: RunId;
  readonly attemptId?: AttemptId;
  readonly iterationId?: IterationId;
  readonly itemId?: RunItemId;
  readonly providerConnectionId?: ProviderConnectionId;
  readonly modelProfileId?: ModelProfileId;
  readonly providerModelId?: string;
}

function assertNonNegativeSafeInteger(value: number, label: string): number {
  assertDomain(
    Number.isSafeInteger(value) && value >= 0,
    "invalid_argument",
    `${label} must be a non-negative safe integer.`,
    { label, value },
  );
  return value;
}

function assertNonNegativeFinite(value: number, label: string): number {
  assertDomain(
    Number.isFinite(value) && value >= 0,
    "invalid_argument",
    `${label} must be a non-negative finite number.`,
    { label, value },
  );
  return value;
}

function normalizeScope(scope: TelemetryScope): TelemetryScope {
  assertDomain(
    scope.providerConnectionId !== undefined || scope.runId !== undefined,
    "invalid_argument",
    "Telemetry must be scoped to a provider connection or a run.",
  );
  assertDomain(
    scope.branchId === undefined || scope.conversationId !== undefined,
    "scope_violation",
    "A telemetry branch requires a conversation scope.",
  );
  assertDomain(
    scope.runId === undefined ||
      (scope.conversationId !== undefined && scope.branchId !== undefined),
    "scope_violation",
    "A run telemetry scope requires its conversation and branch lineage.",
  );
  assertDomain(
    scope.attemptId === undefined || scope.runId !== undefined,
    "scope_violation",
    "An attempt telemetry scope requires a run.",
  );
  assertDomain(
    scope.iterationId === undefined || scope.runId !== undefined,
    "scope_violation",
    "An iteration telemetry scope requires a run.",
  );
  assertDomain(
    scope.itemId === undefined || scope.runId !== undefined,
    "scope_violation",
    "An item telemetry scope requires a run.",
  );
  assertDomain(
    scope.attemptId === undefined ||
      (scope.providerConnectionId !== undefined &&
        scope.modelProfileId !== undefined &&
        scope.providerModelId !== undefined),
    "scope_violation",
    "Attempt telemetry requires the frozen provider and model route.",
  );
  assertDomain(
    scope.modelProfileId === undefined || scope.providerConnectionId !== undefined,
    "scope_violation",
    "A model profile telemetry scope requires its provider connection.",
  );
  const providerModelId =
    scope.providerModelId === undefined
      ? undefined
      : assertNonBlank(scope.providerModelId, "telemetry provider model ID", 512);
  return Object.freeze({
    ...scope,
    ...(providerModelId === undefined ? {} : { providerModelId }),
  });
}

export interface AttemptTimingMarks {
  /** All values are monotonic milliseconds relative to `originAt`. */
  readonly dispatchStartedMs: number;
  readonly requestCommittedMs?: number;
  readonly firstByteMs?: number;
  /** First provider output of any kind, including hidden reasoning. */
  readonly firstProviderOutputMs?: number;
  readonly firstReasoningMs?: number;
  /** First output that the user can actually see or hear. */
  readonly firstVisibleOutputMs?: number;
  /** First semantically complete output item, tool intent, or message block. */
  readonly firstCompleteItemMs?: number;
  readonly lastVisibleOutputMs?: number;
  readonly terminalMs?: number;
}

export interface AttemptWaitDurations {
  readonly queueMs?: number;
  readonly contextCompileMs?: number;
  readonly approvalWaitMs?: number;
  readonly providerBackoffMs?: number;
  readonly toolWaitMs?: number;
  readonly rendererBackpressureMs?: number;
}

export interface AttemptTimingSample {
  readonly schemaVersion: 1;
  readonly id: TelemetryObservationId;
  readonly scope: TelemetryScope;
  /** Identifies one monotonic clock domain/process boot. */
  readonly clockDomainId: string;
  /** Wall-clock anchor for display only; durations come from monotonic offsets. */
  readonly originAt: IsoTimestamp;
  readonly observedAt: IsoTimestamp;
  readonly coverage: TelemetryCoverage;
  readonly marks: AttemptTimingMarks;
  readonly waits: AttemptWaitDurations;
}

export interface CreateAttemptTimingSampleInput
  extends Omit<AttemptTimingSample, "schemaVersion" | "scope" | "marks" | "waits"> {
  readonly scope: TelemetryScope;
  readonly marks: AttemptTimingMarks;
  readonly waits?: AttemptWaitDurations;
}

function normalizeOptionalDuration(value: number | undefined, label: string): number | undefined {
  return value === undefined ? undefined : assertNonNegativeFinite(value, label);
}

function assertMarkOrder(
  later: number | undefined,
  earlier: number | undefined,
  label: string,
): void {
  assertDomain(
    later === undefined || earlier === undefined || later >= earlier,
    "invalid_argument",
    `${label} cannot occur before its prerequisite milestone.`,
    { earlier, later },
  );
}

/**
 * Creates an attempt timing record using monotonic offsets. TTFT is deliberately
 * distinct from first reasoning/provider output so hidden work is never shown
 * as user-perceived latency.
 */
export function createAttemptTimingSample(
  input: CreateAttemptTimingSampleInput,
): AttemptTimingSample {
  const scope = normalizeScope(input.scope);
  assertDomain(
    scope.attemptId !== undefined,
    "scope_violation",
    "Attempt timing must be scoped to one provider attempt.",
  );
  assertIsoTimestamp(input.originAt, "attempt timing origin");
  assertIsoTimestamp(input.observedAt, "attempt timing observation time");
  assertDomain(
    Date.parse(input.observedAt) >= Date.parse(input.originAt),
    "invalid_argument",
    "Attempt timing cannot be observed before its wall-clock origin.",
  );
  const marks: AttemptTimingMarks = Object.freeze({
    dispatchStartedMs: assertNonNegativeFinite(
      input.marks.dispatchStartedMs,
      "dispatch start offset",
    ),
    ...(input.marks.requestCommittedMs === undefined
      ? {}
      : {
          requestCommittedMs: assertNonNegativeFinite(
            input.marks.requestCommittedMs,
            "request committed offset",
          ),
        }),
    ...(input.marks.firstByteMs === undefined
      ? {}
      : { firstByteMs: assertNonNegativeFinite(input.marks.firstByteMs, "first byte offset") }),
    ...(input.marks.firstProviderOutputMs === undefined
      ? {}
      : {
          firstProviderOutputMs: assertNonNegativeFinite(
            input.marks.firstProviderOutputMs,
            "first provider output offset",
          ),
        }),
    ...(input.marks.firstReasoningMs === undefined
      ? {}
      : {
          firstReasoningMs: assertNonNegativeFinite(
            input.marks.firstReasoningMs,
            "first reasoning offset",
          ),
        }),
    ...(input.marks.firstVisibleOutputMs === undefined
      ? {}
      : {
          firstVisibleOutputMs: assertNonNegativeFinite(
            input.marks.firstVisibleOutputMs,
            "first visible output offset",
          ),
        }),
    ...(input.marks.firstCompleteItemMs === undefined
      ? {}
      : {
          firstCompleteItemMs: assertNonNegativeFinite(
            input.marks.firstCompleteItemMs,
            "first complete item offset",
          ),
        }),
    ...(input.marks.lastVisibleOutputMs === undefined
      ? {}
      : {
          lastVisibleOutputMs: assertNonNegativeFinite(
            input.marks.lastVisibleOutputMs,
            "last visible output offset",
          ),
        }),
    ...(input.marks.terminalMs === undefined
      ? {}
      : { terminalMs: assertNonNegativeFinite(input.marks.terminalMs, "terminal offset") }),
  });

  assertMarkOrder(marks.requestCommittedMs, marks.dispatchStartedMs, "Request commit");
  assertMarkOrder(marks.firstByteMs, marks.requestCommittedMs ?? marks.dispatchStartedMs, "First byte");
  assertMarkOrder(
    marks.firstProviderOutputMs,
    marks.firstByteMs ?? marks.dispatchStartedMs,
    "First provider output",
  );
  assertMarkOrder(
    marks.firstReasoningMs,
    marks.firstByteMs ?? marks.dispatchStartedMs,
    "First reasoning output",
  );
  assertMarkOrder(
    marks.firstVisibleOutputMs,
    marks.firstByteMs ?? marks.dispatchStartedMs,
    "First visible output",
  );
  assertMarkOrder(
    marks.firstCompleteItemMs,
    marks.firstByteMs ?? marks.dispatchStartedMs,
    "First complete item",
  );
  assertMarkOrder(marks.lastVisibleOutputMs, marks.firstVisibleOutputMs, "Last visible output");
  for (const [label, mark] of Object.entries(marks)) {
    if (label !== "terminalMs") assertMarkOrder(marks.terminalMs, mark, "Terminal milestone");
  }

  const queueMs = normalizeOptionalDuration(input.waits?.queueMs, "queue duration");
  const contextCompileMs = normalizeOptionalDuration(
    input.waits?.contextCompileMs,
    "context compilation duration",
  );
  const approvalWaitMs = normalizeOptionalDuration(
    input.waits?.approvalWaitMs,
    "approval wait duration",
  );
  const providerBackoffMs = normalizeOptionalDuration(
    input.waits?.providerBackoffMs,
    "provider backoff duration",
  );
  const toolWaitMs = normalizeOptionalDuration(input.waits?.toolWaitMs, "tool wait duration");
  const rendererBackpressureMs = normalizeOptionalDuration(
    input.waits?.rendererBackpressureMs,
    "renderer backpressure duration",
  );
  const waits: AttemptWaitDurations = Object.freeze({
    ...(queueMs === undefined ? {} : { queueMs }),
    ...(contextCompileMs === undefined ? {} : { contextCompileMs }),
    ...(approvalWaitMs === undefined ? {} : { approvalWaitMs }),
    ...(providerBackoffMs === undefined ? {} : { providerBackoffMs }),
    ...(toolWaitMs === undefined ? {} : { toolWaitMs }),
    ...(rendererBackpressureMs === undefined ? {} : { rendererBackpressureMs }),
  });

  return Object.freeze({
    schemaVersion: 1,
    id: input.id,
    scope,
    clockDomainId: assertNonBlank(input.clockDomainId, "telemetry clock domain ID", 160),
    originAt: input.originAt,
    observedAt: input.observedAt,
    coverage: input.coverage,
    marks,
    waits,
  });
}

export interface AttemptLatencyProjection {
  readonly requestUploadMs: number | null;
  readonly timeToFirstByteMs: number | null;
  readonly timeToFirstProviderOutputMs: number | null;
  readonly timeToFirstReasoningMs: number | null;
  readonly timeToFirstVisibleOutputMs: number | null;
  readonly timeToFirstCompleteItemMs: number | null;
  readonly visibleGenerationMs: number | null;
  readonly totalAttemptMs: number | null;
  readonly visibleTokensPerSecond: number | null;
}

function difference(later: number | undefined, earlier: number | undefined): number | null {
  return later === undefined || earlier === undefined ? null : later - earlier;
}

export function projectAttemptLatency(
  sample: AttemptTimingSample,
  visibleOutputTokens?: number,
): AttemptLatencyProjection {
  const tokens =
    visibleOutputTokens === undefined
      ? undefined
      : assertNonNegativeSafeInteger(visibleOutputTokens, "visible output tokens");
  const visibleGenerationMs = difference(
    sample.marks.lastVisibleOutputMs,
    sample.marks.firstVisibleOutputMs,
  );
  const visibleTokensPerSecond =
    tokens === undefined || visibleGenerationMs === null || visibleGenerationMs <= 0
      ? null
      : tokens / (visibleGenerationMs / 1_000);
  return Object.freeze({
    requestUploadMs: difference(
      sample.marks.requestCommittedMs,
      sample.marks.dispatchStartedMs,
    ),
    timeToFirstByteMs: difference(sample.marks.firstByteMs, sample.marks.dispatchStartedMs),
    timeToFirstProviderOutputMs: difference(
      sample.marks.firstProviderOutputMs,
      sample.marks.dispatchStartedMs,
    ),
    timeToFirstReasoningMs: difference(
      sample.marks.firstReasoningMs,
      sample.marks.dispatchStartedMs,
    ),
    timeToFirstVisibleOutputMs: difference(
      sample.marks.firstVisibleOutputMs,
      sample.marks.dispatchStartedMs,
    ),
    timeToFirstCompleteItemMs: difference(
      sample.marks.firstCompleteItemMs,
      sample.marks.dispatchStartedMs,
    ),
    visibleGenerationMs,
    totalAttemptMs: difference(sample.marks.terminalMs, sample.marks.dispatchStartedMs),
    visibleTokensPerSecond,
  });
}

export interface NormalizedUsageCounters {
  readonly inputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly visibleOutputTokens?: number;
  /** Non-token billing units must use provider-qualified keys. */
  readonly billableUnits?: Readonly<Record<string, number>>;
}

export type UsageObservationSource =
  | "local-estimate"
  | "provider-incremental"
  | "provider-final"
  | "provider-invoice"
  | "user-correction";

export type CostStatementKind =
  | "calculated-estimate"
  | "provider-reported"
  | "invoice"
  | "user-override";

export interface CostStatement {
  readonly kind: CostStatementKind;
  readonly component: string;
  readonly amountMicrounits: number;
  readonly currency: string;
  readonly priceSnapshotId?: string;
  readonly priceSnapshotHash?: string;
  readonly formulaVersion?: string;
}

export interface UsageLedgerEntry {
  readonly schemaVersion: 1;
  readonly id: UsageLedgerEntryId;
  readonly sequence: number;
  readonly scope: TelemetryScope;
  readonly source: UsageObservationSource;
  readonly authoritative: boolean;
  readonly coverage: TelemetryCoverage;
  readonly observedAt: IsoTimestamp;
  /** Hash of a provider request/event identity, never the raw request ID. */
  readonly responseIdentityHash?: string;
  readonly counters?: NormalizedUsageCounters;
  /** Numeric-only, provider-qualified counters preserve upstream semantics safely. */
  readonly providerCounters: Readonly<Record<string, number>>;
  readonly costs: readonly CostStatement[];
  readonly supersedesEntryId?: UsageLedgerEntryId;
}

export interface PendingUsageLedgerEntry extends Omit<UsageLedgerEntry, "schemaVersion" | "sequence" | "scope" | "providerCounters" | "costs"> {
  readonly scope: TelemetryScope;
  readonly providerCounters?: Readonly<Record<string, number>>;
  readonly costs?: readonly CostStatement[];
}

export interface UsageLedger {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly entries: readonly UsageLedgerEntry[];
}

type UsageFact = Pick<
  UsageLedgerEntry,
  | "source"
  | "authoritative"
  | "coverage"
  | "observedAt"
  | "responseIdentityHash"
  | "counters"
  | "providerCounters"
  | "costs"
  | "supersedesEntryId"
>;

// Provider-specific counters must carry an explicit provider namespace.
// A bare upstream key such as `prompt_tokens` is ambiguous and therefore
// cannot be retained in the common ledger.
const PROVIDER_COUNTER_KEY = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const CURRENCY = /^[A-Z][A-Z0-9]{2,7}$/;

function normalizeUsageCounters(
  counters: NormalizedUsageCounters | undefined,
): NormalizedUsageCounters | undefined {
  if (counters === undefined) return undefined;
  const normalized: NormalizedUsageCounters = Object.freeze({
    ...(counters.inputTokens === undefined
      ? {}
      : { inputTokens: assertNonNegativeSafeInteger(counters.inputTokens, "input tokens") }),
    ...(counters.cacheReadInputTokens === undefined
      ? {}
      : {
          cacheReadInputTokens: assertNonNegativeSafeInteger(
            counters.cacheReadInputTokens,
            "cache-read input tokens",
          ),
        }),
    ...(counters.cacheWriteInputTokens === undefined
      ? {}
      : {
          cacheWriteInputTokens: assertNonNegativeSafeInteger(
            counters.cacheWriteInputTokens,
            "cache-write input tokens",
          ),
        }),
    ...(counters.outputTokens === undefined
      ? {}
      : { outputTokens: assertNonNegativeSafeInteger(counters.outputTokens, "output tokens") }),
    ...(counters.reasoningTokens === undefined
      ? {}
      : {
          reasoningTokens: assertNonNegativeSafeInteger(
            counters.reasoningTokens,
            "reasoning tokens",
          ),
        }),
    ...(counters.visibleOutputTokens === undefined
      ? {}
      : {
          visibleOutputTokens: assertNonNegativeSafeInteger(
            counters.visibleOutputTokens,
            "visible output tokens",
          ),
        }),
    ...(counters.billableUnits === undefined
      ? {}
      : { billableUnits: normalizeNumericMap(counters.billableUnits, "billable unit") }),
  });
  assertDomain(
    Object.keys(normalized).length > 0,
    "invalid_argument",
    "A normalized usage counter set cannot be empty.",
  );
  return normalized;
}

function normalizeNumericMap(
  values: Readonly<Record<string, number>>,
  label: string,
): Readonly<Record<string, number>> {
  const entries = Object.entries(values);
  assertDomain(entries.length <= 64, "invalid_argument", `${label} map exceeds 64 entries.`);
  for (const [key, value] of entries) {
    assertDomain(
      PROVIDER_COUNTER_KEY.test(key),
      "invalid_argument",
      `${label} keys must be lowercase and provider-qualified.`,
      { key },
    );
    assertNonNegativeFinite(value, `${label} ${key}`);
  }
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))));
}

/**
 * Provider event identity is scoped to one attempt/source. The normalized fact
 * must still match before a replay is treated as idempotent; otherwise a
 * reused provider identity could silently overwrite accounting semantics.
 */
function sameUsageFact(left: UsageFact, right: UsageFact): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeCostStatement(statement: CostStatement): CostStatement {
  const component = assertNonBlank(statement.component, "cost component", 160);
  const currency = statement.currency.trim().toUpperCase();
  assertDomain(CURRENCY.test(currency), "invalid_argument", "Cost currency is invalid.", {
    currency,
  });
  const amountMicrounits = assertNonNegativeSafeInteger(
    statement.amountMicrounits,
    "cost amount",
  );
  if (statement.kind === "calculated-estimate") {
    assertDomain(
      statement.priceSnapshotId !== undefined &&
        statement.priceSnapshotHash !== undefined &&
        statement.formulaVersion !== undefined,
      "invalid_argument",
      "Calculated cost requires a frozen price snapshot and formula version.",
    );
  }
  const priceSnapshotId =
    statement.priceSnapshotId === undefined
      ? undefined
      : assertNonBlank(statement.priceSnapshotId, "price snapshot ID", 256);
  const priceSnapshotHash =
    statement.priceSnapshotHash === undefined
      ? undefined
      : assertSha256(statement.priceSnapshotHash, "price snapshot hash");
  const formulaVersion =
    statement.formulaVersion === undefined
      ? undefined
      : assertNonBlank(statement.formulaVersion, "cost formula version", 120);
  return Object.freeze({
    kind: statement.kind,
    component,
    amountMicrounits,
    currency,
    ...(priceSnapshotId === undefined ? {} : { priceSnapshotId }),
    ...(priceSnapshotHash === undefined ? {} : { priceSnapshotHash }),
    ...(formulaVersion === undefined ? {} : { formulaVersion }),
  });
}

export function createUsageLedger(runId: RunId): UsageLedger {
  return Object.freeze({ schemaVersion: 1, runId, entries: Object.freeze([]) });
}

/**
 * Appends an immutable usage fact. A provider-final correction may be lower
 * than its provisional predecessor; the predecessor remains auditable instead
 * of being overwritten or forced into a false monotonic counter.
 */
export function appendUsageLedgerEntry(
  ledger: UsageLedger,
  pending: PendingUsageLedgerEntry,
): UsageLedger {
  const scope = normalizeScope(pending.scope);
  assertDomain(scope.runId === ledger.runId, "scope_violation", "Usage belongs to another run.", {
    ledgerRunId: ledger.runId,
    entryRunId: scope.runId,
  });
  assertIsoTimestamp(pending.observedAt, "usage observation time");
  const previous = ledger.entries.at(-1);
  assertDomain(
    previous === undefined || Date.parse(pending.observedAt) >= Date.parse(previous.observedAt),
    "invalid_argument",
    "Usage observation time cannot move backwards.",
  );
  assertDomain(
    !ledger.entries.some((entry) => entry.id === pending.id),
    "conflict",
    "Usage ledger entry ID already exists.",
    { entryId: pending.id },
  );
  const providerSource =
    pending.source === "provider-incremental" ||
    pending.source === "provider-final" ||
    pending.source === "provider-invoice";
  assertDomain(
    !providerSource ||
      (scope.attemptId !== undefined && pending.responseIdentityHash !== undefined),
    "scope_violation",
    "Provider usage requires an attempt and hashed response identity.",
  );
  assertDomain(
    pending.source !== "local-estimate" || !pending.authoritative,
    "invalid_argument",
    "A local estimate cannot be marked authoritative.",
  );
  assertDomain(
    pending.source !== "provider-incremental" || !pending.authoritative,
    "invalid_argument",
    "Incremental provider usage cannot be marked authoritative.",
  );
  assertDomain(
    pending.source !== "user-correction" || pending.supersedesEntryId !== undefined,
    "invalid_argument",
    "A user correction must identify the entry it supersedes.",
  );
  const superseded =
    pending.supersedesEntryId === undefined
      ? undefined
      : ledger.entries.find((entry) => entry.id === pending.supersedesEntryId);
  assertDomain(
    pending.supersedesEntryId === undefined || superseded !== undefined,
    "not_found",
    "The superseded usage entry was not found.",
    { entryId: pending.supersedesEntryId },
  );
  assertDomain(
    superseded === undefined || superseded.scope.attemptId === scope.attemptId,
    "scope_violation",
    "A usage correction cannot cross attempt boundaries.",
  );
  const counters = normalizeUsageCounters(pending.counters);
  const providerCounters = normalizeNumericMap(
    pending.providerCounters ?? {},
    "provider counter",
  );
  assertDomain(
    providerSource || Object.keys(providerCounters).length === 0,
    "invalid_argument",
    "Only provider observations may retain provider counters.",
  );
  const costs = Object.freeze((pending.costs ?? []).map(normalizeCostStatement));
  assertDomain(
    counters !== undefined || costs.length > 0,
    "invalid_argument",
    "A usage entry must contain counters or a cost statement.",
  );
  assertDomain(
    pending.source !== "provider-invoice" || costs.some((cost) => cost.kind === "invoice"),
    "invalid_argument",
    "A provider invoice observation requires an invoice cost statement.",
  );
  const responseIdentityHash =
    pending.responseIdentityHash === undefined
      ? undefined
      : assertSha256(pending.responseIdentityHash, "provider response identity hash");
  const replay =
    providerSource && responseIdentityHash !== undefined
      ? ledger.entries.find(
          (entry) =>
            entry.scope.attemptId === scope.attemptId &&
            entry.source === pending.source &&
            entry.responseIdentityHash === responseIdentityHash,
        )
      : undefined;
  if (replay !== undefined) {
    const candidateFact: UsageFact = {
      source: pending.source,
      authoritative: pending.authoritative,
      coverage: pending.coverage,
      observedAt: pending.observedAt,
      ...(responseIdentityHash === undefined ? {} : { responseIdentityHash }),
      ...(counters === undefined ? {} : { counters }),
      providerCounters,
      costs,
      ...(pending.supersedesEntryId === undefined
        ? {}
        : { supersedesEntryId: pending.supersedesEntryId }),
    };
    const replayFact: UsageFact = {
      source: replay.source,
      authoritative: replay.authoritative,
      coverage: replay.coverage,
      observedAt: replay.observedAt,
      ...(replay.responseIdentityHash === undefined
        ? {}
        : { responseIdentityHash: replay.responseIdentityHash }),
      ...(replay.counters === undefined ? {} : { counters: replay.counters }),
      providerCounters: replay.providerCounters,
      costs: replay.costs,
      ...(replay.supersedesEntryId === undefined
        ? {}
        : { supersedesEntryId: replay.supersedesEntryId }),
    };
    assertDomain(
      sameUsageFact(replayFact, candidateFact),
      "conflict",
      "The provider event identity was already recorded with different facts.",
      { responseIdentityHash },
    );
    return ledger;
  }
  const entry: UsageLedgerEntry = Object.freeze({
    schemaVersion: 1,
    id: pending.id,
    sequence: ledger.entries.length + 1,
    scope,
    source: pending.source,
    authoritative: pending.authoritative,
    coverage: pending.coverage,
    observedAt: pending.observedAt,
    ...(responseIdentityHash === undefined ? {} : { responseIdentityHash }),
    ...(counters === undefined ? {} : { counters }),
    providerCounters,
    costs,
    ...(pending.supersedesEntryId === undefined
      ? {}
      : { supersedesEntryId: pending.supersedesEntryId }),
  });
  return Object.freeze({
    ...ledger,
    entries: Object.freeze([...ledger.entries, entry]),
  });
}

const USAGE_SOURCE_RANK: Readonly<Record<UsageObservationSource, number>> = Object.freeze({
  "local-estimate": 1,
  "provider-incremental": 2,
  "provider-final": 3,
  "provider-invoice": 0,
  "user-correction": 4,
});

export interface UsageProjection {
  readonly scopeAttemptId: AttemptId | null;
  readonly counters: NormalizedUsageCounters | null;
  readonly source: UsageObservationSource | null;
  readonly authoritative: boolean;
  readonly sourceEntryId: UsageLedgerEntryId | null;
  readonly costs: readonly CostStatement[];
}

/** Selects one current counter fact while retaining independent cost layers. */
export function projectUsage(
  ledger: UsageLedger,
  attemptId: AttemptId | null,
): UsageProjection {
  const relevant = ledger.entries.filter((entry) => (entry.scope.attemptId ?? null) === attemptId);
  const selected = relevant
    .filter((entry) => entry.counters !== undefined)
    .sort(
      (left, right) =>
        USAGE_SOURCE_RANK[right.source] - USAGE_SOURCE_RANK[left.source] ||
        right.sequence - left.sequence,
    )[0];
  const latestCostByKey = new Map<string, CostStatement>();
  for (const entry of relevant) {
    for (const cost of entry.costs) {
      latestCostByKey.set(`${cost.kind}:${cost.component}:${cost.currency}`, cost);
    }
  }
  return Object.freeze({
    scopeAttemptId: attemptId,
    counters: selected?.counters ?? null,
    source: selected?.source ?? null,
    authoritative: selected?.authoritative ?? false,
    sourceEntryId: selected?.id ?? null,
    costs: Object.freeze([...latestCostByKey.values()]),
  });
}

export type ProviderHealthDimension =
  | "dns"
  | "tls"
  | "authentication"
  | "authorization"
  | "billing"
  | "catalog"
  | "transport"
  | "protocol"
  | "streaming"
  | "model"
  | "rate-limit";

export type ProviderHealthOutcome = "pass" | "degraded" | "fail" | "unknown";

/** Canonical provider taxonomy shared with the native error boundary. */
export const PROVIDER_ERROR_CLASSES = [
  "authentication",
  "authorization",
  "billing",
  "rate-limit",
  "quota",
  "dns",
  "tls",
  "transport",
  "timeout",
  "protocol",
  "schema",
  "model-unavailable",
  "content-policy",
  "cancelled",
  "unknown",
] as const;

export type ProviderErrorClass = (typeof PROVIDER_ERROR_CLASSES)[number];

const PROVIDER_ERROR_CLASS_SET: ReadonlySet<string> = new Set(PROVIDER_ERROR_CLASSES);

/** Runtime guard for untyped IPC/provider payloads. */
export function isProviderErrorClass(value: unknown): value is ProviderErrorClass {
  return typeof value === "string" && PROVIDER_ERROR_CLASS_SET.has(value);
}

/** Return the canonical class or `undefined` for arbitrary provider text. */
export function parseProviderErrorClass(value: unknown): ProviderErrorClass | undefined {
  return isProviderErrorClass(value) ? value : undefined;
}

export interface ProviderQuotaWindow {
  readonly kind: "requests" | "input-tokens" | "output-tokens" | "total-tokens" | "concurrency";
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetAt?: IsoTimestamp;
  readonly windowSeconds?: number;
  readonly source: "provider-header" | "provider-api" | "configured" | "inferred";
  readonly authoritative: boolean;
}

export interface ProviderHealthObservation {
  readonly schemaVersion: 1;
  readonly id: TelemetryObservationId;
  readonly scope: TelemetryScope;
  readonly dimension: ProviderHealthDimension;
  readonly outcome: ProviderHealthOutcome;
  readonly errorClass?: ProviderErrorClass;
  readonly latencyMs?: number;
  readonly quota?: ProviderQuotaWindow;
  readonly observedAt: IsoTimestamp;
  readonly diagnosticCode?: string;
}

export interface CreateProviderHealthObservationInput
  extends Omit<ProviderHealthObservation, "schemaVersion" | "scope" | "quota"> {
  readonly scope: TelemetryScope;
  readonly quota?: ProviderQuotaWindow;
}

function normalizeQuotaWindow(quota: ProviderQuotaWindow): ProviderQuotaWindow {
  const limit =
    quota.limit === undefined
      ? undefined
      : assertNonNegativeSafeInteger(quota.limit, "quota limit");
  const remaining =
    quota.remaining === undefined
      ? undefined
      : assertNonNegativeSafeInteger(quota.remaining, "quota remaining");
  assertDomain(
    limit === undefined || remaining === undefined || remaining <= limit,
    "invalid_argument",
    "Quota remaining cannot exceed its limit.",
  );
  if (quota.resetAt !== undefined) assertIsoTimestamp(quota.resetAt, "quota reset time");
  const windowSeconds =
    quota.windowSeconds === undefined
      ? undefined
      : assertNonNegativeSafeInteger(quota.windowSeconds, "quota window seconds");
  assertDomain(
    quota.source !== "inferred" || !quota.authoritative,
    "invalid_argument",
    "An inferred quota window cannot be authoritative.",
  );
  return Object.freeze({
    kind: quota.kind,
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(quota.resetAt === undefined ? {} : { resetAt: quota.resetAt }),
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
    source: quota.source,
    authoritative: quota.authoritative,
  });
}

export function createProviderHealthObservation(
  input: CreateProviderHealthObservationInput,
): ProviderHealthObservation {
  const scope = normalizeScope(input.scope);
  assertDomain(
    scope.providerConnectionId !== undefined,
    "scope_violation",
    "Provider health must identify a provider connection.",
  );
  assertIsoTimestamp(input.observedAt, "provider health observation time");
  assertDomain(
    input.outcome === "pass" ? input.errorClass === undefined : true,
    "invalid_argument",
    "A passing provider health observation cannot carry an error class.",
  );
  assertDomain(
    input.outcome !== "fail" || input.errorClass !== undefined,
    "invalid_argument",
    "A failed provider health observation requires a typed error class.",
  );
  const errorClass =
    input.errorClass === undefined ? undefined : parseProviderErrorClass(input.errorClass);
  assertDomain(
    input.errorClass === undefined || errorClass !== undefined,
    "invalid_argument",
    "Provider health error class is not recognized.",
  );
  const diagnosticCode =
    input.diagnosticCode === undefined
      ? undefined
      : assertNonBlank(input.diagnosticCode, "provider diagnostic code", 160);
  return Object.freeze({
    schemaVersion: 1,
    id: input.id,
    scope,
    dimension: input.dimension,
    outcome: input.outcome,
    ...(errorClass === undefined ? {} : { errorClass }),
    ...(input.latencyMs === undefined
      ? {}
      : { latencyMs: assertNonNegativeFinite(input.latencyMs, "provider health latency") }),
    ...(input.quota === undefined ? {} : { quota: normalizeQuotaWindow(input.quota) }),
    observedAt: input.observedAt,
    ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
  });
}

export type ProviderHealthState = "healthy" | "degraded" | "unavailable" | "unknown";

export interface ProviderHealthProjection {
  readonly state: ProviderHealthState;
  readonly samples: number;
  readonly successRate: number | null;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly latestObservedAt: IsoTimestamp | null;
  readonly latestByDimension: Readonly<Partial<Record<ProviderHealthDimension, ProviderHealthOutcome>>>;
  readonly quotas: readonly ProviderQuotaWindow[];
}

export interface ProviderHealthPolicy {
  readonly now: IsoTimestamp;
  readonly freshnessMs: number;
  readonly minimumSamples: number;
  readonly degradedFailureRate: number;
  readonly unavailableFailureRate: number;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] ?? null;
}

/**
 * Projects health without collapsing auth, rate-limit, schema, and transport
 * failures into one opaque "offline" flag.
 */
export function projectProviderHealth(
  observations: readonly ProviderHealthObservation[],
  providerConnectionId: ProviderConnectionId,
  modelProfileId: ModelProfileId | null,
  policy: ProviderHealthPolicy,
): ProviderHealthProjection {
  assertIsoTimestamp(policy.now, "provider health projection time");
  assertNonNegativeSafeInteger(policy.minimumSamples, "minimum provider health samples");
  assertNonNegativeSafeInteger(policy.freshnessMs, "provider health freshness");
  assertDomain(
    policy.degradedFailureRate >= 0 &&
      policy.degradedFailureRate <= 1 &&
      policy.unavailableFailureRate >= policy.degradedFailureRate &&
      policy.unavailableFailureRate <= 1,
    "invalid_argument",
    "Provider health failure thresholds are invalid.",
  );
  const cutoff = Date.parse(policy.now) - policy.freshnessMs;
  const fresh = observations.filter(
    (observation) =>
      observation.scope.providerConnectionId === providerConnectionId &&
      (modelProfileId === null || observation.scope.modelProfileId === modelProfileId) &&
      Date.parse(observation.observedAt) >= cutoff &&
      Date.parse(observation.observedAt) <= Date.parse(policy.now),
  );
  const ordered = [...fresh].sort(
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt),
  );
  const latestByDimension: Partial<Record<ProviderHealthDimension, ProviderHealthOutcome>> = {};
  const latestQuotaByKind = new Map<ProviderQuotaWindow["kind"], ProviderQuotaWindow>();
  for (const observation of ordered) {
    latestByDimension[observation.dimension] = observation.outcome;
    if (observation.quota !== undefined) latestQuotaByKind.set(observation.quota.kind, observation.quota);
  }
  const decisive = fresh.filter((observation) => observation.outcome !== "unknown");
  const failures = decisive.filter((observation) => observation.outcome === "fail").length;
  const degraded = decisive.filter((observation) => observation.outcome === "degraded").length;
  const failureRate = decisive.length === 0 ? null : (failures + degraded * 0.5) / decisive.length;
  // A critical failure only makes the route unavailable while it remains the
  // latest observation for that dimension. Looking for any failure in the
  // window would keep a provider permanently unavailable after a successful
  // recovery probe, even though `latestByDimension` already reports `pass`.
  const criticalDimensions = new Set<ProviderHealthDimension>([
    "authentication",
    "authorization",
    "billing",
    "protocol",
    "model",
  ]);
  const latestCriticalFailure = [...criticalDimensions].some(
    (dimension) => latestByDimension[dimension] === "fail",
  );
  let state: ProviderHealthState;
  if (latestCriticalFailure) state = "unavailable";
  else if (decisive.length < policy.minimumSamples || failureRate === null) state = "unknown";
  else if (failureRate >= policy.unavailableFailureRate) state = "unavailable";
  else if (failureRate >= policy.degradedFailureRate) state = "degraded";
  else state = "healthy";
  const latencies = fresh.flatMap((observation) =>
    observation.latencyMs === undefined ? [] : [observation.latencyMs],
  );
  return Object.freeze({
    state,
    samples: fresh.length,
    successRate: decisive.length === 0 ? null : (decisive.length - failures - degraded) / decisive.length,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    latestObservedAt: ordered.at(-1)?.observedAt ?? null,
    latestByDimension: Object.freeze({ ...latestByDimension }),
    quotas: Object.freeze([...latestQuotaByKind.values()]),
  });
}

export type HarnessOperationKind =
  | "context-compile"
  | "retrieval"
  | "memory-read"
  | "skill-load"
  | "approval-wait"
  | "tool-call"
  | "subagent-run"
  | "validation"
  | "artifact-build"
  | "checkpoint";

export type HarnessOperationOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "denied"
  | "timed-out"
  | "unknown";

export interface HarnessOperationObservation {
  readonly schemaVersion: 1;
  readonly id: TelemetryObservationId;
  readonly parentId?: TelemetryObservationId;
  readonly scope: TelemetryScope;
  readonly kind: HarnessOperationKind;
  readonly operationName: string;
  readonly outcome: HarnessOperationOutcome;
  readonly startedAt: IsoTimestamp;
  readonly durationMs: number;
  readonly queueMs?: number;
  readonly approvalWaitMs?: number;
  readonly inputBytes?: number;
  readonly outputBytes?: number;
  readonly inputItems?: number;
  readonly outputItems?: number;
  readonly mutationCount?: number;
  readonly cache: "hit" | "miss" | "write" | "bypass" | "not-applicable";
  readonly verification: "passed" | "failed" | "not-run" | "not-applicable";
  readonly details: JsonObject;
}

export interface CreateHarnessOperationObservationInput
  extends Omit<HarnessOperationObservation, "schemaVersion" | "scope" | "details"> {
  readonly scope: TelemetryScope;
  readonly details?: JsonObject;
}

export function createHarnessOperationObservation(
  input: CreateHarnessOperationObservationInput,
): HarnessOperationObservation {
  assertIsoTimestamp(input.startedAt, "harness operation start time");
  const optionalInteger = (value: number | undefined, label: string): number | undefined =>
    value === undefined ? undefined : assertNonNegativeSafeInteger(value, label);
  const queueMs = normalizeOptionalDuration(input.queueMs, "operation queue duration");
  const approvalWaitMs = normalizeOptionalDuration(
    input.approvalWaitMs,
    "operation approval wait duration",
  );
  const durationMs = assertNonNegativeFinite(input.durationMs, "harness operation duration");
  assertDomain(
    queueMs === undefined || queueMs <= durationMs,
    "invalid_argument",
    "Operation queue time cannot exceed total duration.",
  );
  assertDomain(
    approvalWaitMs === undefined || approvalWaitMs <= durationMs,
    "invalid_argument",
    "Operation approval wait cannot exceed total duration.",
  );
  return Object.freeze({
    schemaVersion: 1,
    id: input.id,
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    scope: normalizeScope(input.scope),
    kind: input.kind,
    operationName: assertNonBlank(input.operationName, "harness operation name", 200),
    outcome: input.outcome,
    startedAt: input.startedAt,
    durationMs,
    ...(queueMs === undefined ? {} : { queueMs }),
    ...(approvalWaitMs === undefined ? {} : { approvalWaitMs }),
    ...(optionalInteger(input.inputBytes, "operation input bytes") === undefined
      ? {}
      : { inputBytes: input.inputBytes }),
    ...(optionalInteger(input.outputBytes, "operation output bytes") === undefined
      ? {}
      : { outputBytes: input.outputBytes }),
    ...(optionalInteger(input.inputItems, "operation input items") === undefined
      ? {}
      : { inputItems: input.inputItems }),
    ...(optionalInteger(input.outputItems, "operation output items") === undefined
      ? {}
      : { outputItems: input.outputItems }),
    ...(optionalInteger(input.mutationCount, "operation mutation count") === undefined
      ? {}
      : { mutationCount: input.mutationCount }),
    cache: input.cache,
    verification: input.verification,
    details: freezeJson(input.details ?? {}),
  });
}

export interface TelemetryPolicy {
  readonly schemaVersion: 1;
  readonly collection: "off" | "local";
  readonly remoteExport: "off" | "operational" | "diagnostic";
  readonly retainRawDays: number;
  readonly retainAggregateDays: number;
  readonly includeProviderNumericCounters: boolean;
  readonly includePromptContent: false;
  readonly includeResponseContent: false;
  readonly includeReasoningContent: false;
  readonly includeToolPayloads: false;
}

/** Rich operational telemetry is local by default; content and reasoning never enter v1 telemetry. */
export const DEFAULT_TELEMETRY_POLICY: TelemetryPolicy = Object.freeze({
  schemaVersion: 1,
  collection: "local",
  remoteExport: "off",
  retainRawDays: 30,
  retainAggregateDays: 365,
  includeProviderNumericCounters: true,
  includePromptContent: false,
  includeResponseContent: false,
  includeReasoningContent: false,
  includeToolPayloads: false,
});

export interface CreateTelemetryPolicyInput
  extends Omit<
    TelemetryPolicy,
    | "schemaVersion"
    | "includePromptContent"
    | "includeResponseContent"
    | "includeReasoningContent"
    | "includeToolPayloads"
  > {}

export function createTelemetryPolicy(input: CreateTelemetryPolicyInput): TelemetryPolicy {
  const retainRawDays = assertNonNegativeSafeInteger(input.retainRawDays, "raw telemetry retention");
  const retainAggregateDays = assertNonNegativeSafeInteger(
    input.retainAggregateDays,
    "aggregate telemetry retention",
  );
  assertDomain(
    retainAggregateDays >= retainRawDays,
    "invalid_argument",
    "Aggregate telemetry retention cannot be shorter than raw retention.",
  );
  assertDomain(
    input.collection !== "off" || input.remoteExport === "off",
    "invalid_argument",
    "Remote telemetry export requires local collection.",
  );
  return Object.freeze({
    schemaVersion: 1,
    collection: input.collection,
    remoteExport: input.remoteExport,
    retainRawDays,
    retainAggregateDays,
    includeProviderNumericCounters: input.includeProviderNumericCounters,
    includePromptContent: false,
    includeResponseContent: false,
    includeReasoningContent: false,
    includeToolPayloads: false,
  });
}
