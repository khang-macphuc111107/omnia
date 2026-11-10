import { assertDomain } from "./errors";
import type {
  AttemptId,
  BranchId,
  ConversationId,
  ModelProfileId,
  ProviderConnectionId,
  RunId,
} from "./ids";
import { assertIsoTimestamp, assertNonBlank, type IsoTimestamp } from "./shared";
import {
  projectAttemptLatency,
  projectProviderHealth,
  projectUsage,
  type AttemptLatencyProjection,
  type AttemptTimingSample,
  type CostStatement,
  type CostStatementKind,
  type NormalizedUsageCounters,
  type ProviderHealthObservation,
  type ProviderHealthPolicy,
  type ProviderHealthProjection,
  type TelemetryCoverage,
  type TelemetryScope,
  type UsageLedger,
  type UsageObservationSource,
} from "./telemetry";

export type ProviderAttemptTelemetryOutcome =
  | "dispatching"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled"
  | "outcome-unknown";

export type ProviderAcceptanceEvidence = boolean | "unknown";

export interface ProviderAttemptTelemetryScope extends TelemetryScope {
  readonly conversationId: ConversationId;
  readonly branchId: BranchId;
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly modelProfileId: ModelProfileId;
  readonly providerModelId: string;
}

/**
 * A renderer-safe, normalized record for one provider HTTP dispatch.
 *
 * The native journal/projection layer is expected to construct this record.
 * It intentionally carries no prompt, output, reasoning, raw request ID,
 * credential, endpoint, or provider payload.
 */
export interface ProviderAttemptTelemetryRecord {
  readonly schemaVersion: 1;
  readonly scope: ProviderAttemptTelemetryScope;
  readonly dispatchStartedAt: IsoTimestamp;
  readonly outcome: ProviderAttemptTelemetryOutcome;
  readonly acceptedByProvider: ProviderAcceptanceEvidence;
  readonly timing?: AttemptTimingSample;
  readonly usageLedger?: UsageLedger;
}

export interface CreateProviderAttemptTelemetryRecordInput
  extends Omit<ProviderAttemptTelemetryRecord, "schemaVersion" | "scope"> {
  readonly scope: TelemetryScope;
}

function normalizeExactAttemptScope(scope: TelemetryScope): ProviderAttemptTelemetryScope {
  assertDomain(
    scope.runId !== undefined &&
      scope.conversationId !== undefined &&
      scope.branchId !== undefined &&
      scope.attemptId !== undefined &&
      scope.providerConnectionId !== undefined &&
      scope.modelProfileId !== undefined &&
      scope.providerModelId !== undefined,
    "scope_violation",
    "Provider attempt telemetry requires an exact run, attempt, provider, and model route.",
  );
  const providerModelId = assertNonBlank(
    scope.providerModelId,
    "provider telemetry model ID",
    512,
  );
  assertDomain(
    !/[\u0000-\u001f\u007f]/u.test(providerModelId),
    "invalid_argument",
    "Provider telemetry model ID cannot contain control characters.",
  );
  return Object.freeze({
    ...scope,
    conversationId: scope.conversationId,
    branchId: scope.branchId,
    runId: scope.runId,
    attemptId: scope.attemptId,
    providerConnectionId: scope.providerConnectionId,
    modelProfileId: scope.modelProfileId,
    providerModelId,
  });
}

const SCOPE_ID_KEYS = [
  "profileId",
  "projectId",
  "conversationId",
  "branchId",
  "runId",
  "attemptId",
  "iterationId",
  "itemId",
  "providerConnectionId",
  "modelProfileId",
  "providerModelId",
] as const satisfies readonly (keyof TelemetryScope)[];

function assertSameTelemetryScope(
  expected: TelemetryScope,
  actual: TelemetryScope,
  label: string,
): void {
  for (const key of SCOPE_ID_KEYS) {
    assertDomain(
      expected[key] === actual[key],
      "scope_violation",
      `${label} does not match the provider attempt scope.`,
      { key, expected: expected[key], actual: actual[key] },
    );
  }
}

/**
 * Validates the exact lineage used by the provider telemetry read model.
 * Outcome ambiguity remains explicit: an unknown provider outcome is never
 * rewritten into a definitive failure.
 */
export function createProviderAttemptTelemetryRecord(
  input: CreateProviderAttemptTelemetryRecordInput,
): ProviderAttemptTelemetryRecord {
  const scope = normalizeExactAttemptScope(input.scope);
  assertIsoTimestamp(input.dispatchStartedAt, "provider dispatch start time");
  assertDomain(
    input.outcome !== "completed" || input.acceptedByProvider === true,
    "invalid_argument",
    "A completed provider attempt requires positive provider-acceptance evidence.",
  );
  assertDomain(
    input.outcome !== "streaming" || input.acceptedByProvider === true,
    "invalid_argument",
    "A streaming provider attempt requires positive provider-acceptance evidence.",
  );
  assertDomain(
    input.outcome !== "outcome-unknown" || input.acceptedByProvider !== false,
    "invalid_argument",
    "An outcome-unknown attempt cannot claim definitive provider non-acceptance.",
  );
  if (input.timing !== undefined) {
    assertSameTelemetryScope(scope, input.timing.scope, "Attempt timing");
    const timingDispatchAt =
      Date.parse(input.timing.originAt) + input.timing.marks.dispatchStartedMs;
    assertDomain(
      Math.abs(timingDispatchAt - Date.parse(input.dispatchStartedAt)) <= 1,
      "invalid_argument",
      "Attempt timing and provider dispatch use different wall-clock anchors.",
      { timingDispatchAt, dispatchStartedAt: Date.parse(input.dispatchStartedAt) },
    );
    assertDomain(
      Date.parse(input.timing.observedAt) >= Date.parse(input.dispatchStartedAt),
      "invalid_argument",
      "Attempt timing cannot be observed before provider dispatch.",
    );
    assertDomain(
      (input.outcome !== "dispatching" && input.outcome !== "streaming") ||
        input.timing.marks.terminalMs === undefined,
      "invalid_argument",
      "An active provider attempt cannot carry a terminal timing mark.",
    );
  }
  if (input.usageLedger !== undefined) {
    assertDomain(
      input.usageLedger.runId === scope.runId,
      "scope_violation",
      "The usage ledger belongs to another logical run.",
      { expectedRunId: scope.runId, actualRunId: input.usageLedger.runId },
    );
    const entryIds = new Set<string>();
    for (const [index, entry] of input.usageLedger.entries.entries()) {
      assertDomain(
        entry.sequence === index + 1,
        "invalid_argument",
        "Usage ledger sequence must be contiguous and ordered.",
        { expectedSequence: index + 1, actualSequence: entry.sequence },
      );
      assertDomain(
        !entryIds.has(entry.id),
        "conflict",
        "Usage ledger contains a duplicate entry ID.",
        { entryId: entry.id },
      );
      entryIds.add(entry.id);
      assertDomain(
        entry.scope.runId === input.usageLedger.runId,
        "scope_violation",
        "A usage entry belongs to another logical run.",
      );
      if (entry.scope.attemptId === scope.attemptId) {
        assertSameTelemetryScope(scope, entry.scope, "Usage entry");
      }
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    scope,
    dispatchStartedAt: input.dispatchStartedAt,
    outcome: input.outcome,
    acceptedByProvider: input.acceptedByProvider,
    ...(input.timing === undefined ? {} : { timing: input.timing }),
    ...(input.usageLedger === undefined ? {} : { usageLedger: input.usageLedger }),
  });
}

export interface ProviderTelemetryProjectionPolicy {
  readonly now: IsoTimestamp;
  /** Fixed observation window used for attempt, RPM, TPM, latency, and cost. */
  readonly windowMs: number;
  readonly health: Omit<ProviderHealthPolicy, "now">;
}

export interface ProviderTelemetryProjectionInput {
  readonly providerConnectionId: ProviderConnectionId;
  /** Null creates a provider-wide projection; a value creates one exact model projection. */
  readonly modelProfileId: ModelProfileId | null;
  /** Completeness of the attempt collection for the requested fixed window. */
  readonly attemptCollectionCoverage: TelemetryCoverage;
  readonly attempts: readonly ProviderAttemptTelemetryRecord[];
  readonly healthObservations: readonly ProviderHealthObservation[];
  readonly policy: ProviderTelemetryProjectionPolicy;
}

export interface TelemetryCoverageSummary {
  readonly status: TelemetryCoverage;
  readonly expectedSamples: number;
  readonly observedSamples: number;
  readonly completeSamples: number;
  readonly partialSamples: number;
  readonly estimatedSamples: number;
  readonly unknownSamples: number;
}

export interface ProviderMetricDistribution {
  readonly samples: number;
  readonly mean: number | null;
  readonly minimum: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly maximum: number | null;
  readonly coverage: TelemetryCoverageSummary;
}

export interface ObservedCounterRate {
  /** Sum of reported values only; inspect coverage before treating it as a total. */
  readonly observed: number | null;
  readonly averagePerSample: number | null;
  readonly perMinute: number | null;
  readonly samples: number;
  readonly coverage: TelemetryCoverageSummary;
}

export interface ProviderTokenProjection {
  readonly inputTokens: ObservedCounterRate;
  readonly cacheReadInputTokens: ObservedCounterRate;
  readonly cacheWriteInputTokens: ObservedCounterRate;
  readonly outputTokens: ObservedCounterRate;
  readonly reasoningTokens: ObservedCounterRate;
  readonly visibleOutputTokens: ObservedCounterRate;
  readonly billableUnits: Readonly<Record<string, ObservedCounterRate>>;
  readonly selectedSourceCounts: Readonly<Partial<Record<UsageObservationSource, number>>>;
  readonly authoritativeAttempts: number;
}

export interface ProviderCostLayerProjection {
  readonly kind: CostStatementKind;
  readonly amountMicrounits: number;
  readonly statements: number;
  readonly attempts: number;
}

export interface ProviderCostCurrencyProjection {
  readonly currency: string;
  /**
   * One best-provenance statement per attempt/component. This avoids adding an
   * estimate, provider report, and invoice for the same charge together.
   */
  readonly effectiveAmountMicrounits: number | null;
  readonly costedAttempts: number;
  readonly potentiallyBillableAttempts: number;
  readonly averagePerCostedAttemptMicrounits: number | null;
  readonly effectiveKindCounts: Readonly<Partial<Record<CostStatementKind, number>>>;
  /** Independent provenance layers remain inspectable and are not summed as one bill. */
  readonly layers: readonly ProviderCostLayerProjection[];
  readonly coverage: TelemetryCoverageSummary;
}

export interface ProviderAttemptActivityProjection {
  readonly observedAttempts: number;
  readonly dispatching: number;
  readonly streaming: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly outcomeUnknown: number;
  readonly accepted: number;
  readonly notAccepted: number;
  readonly acceptanceUnknown: number;
  /** Completed / (completed + definitively failed); cancellation and ambiguity are excluded. */
  readonly definitiveCompletionRate: number | null;
  /** Harness dispatch decisions per minute, whether or not a provider request was sent. */
  readonly attemptsPerMinute: number;
  /** Requests proven by request-commit or positive provider-acceptance evidence. */
  readonly providerRequestsObserved: number;
  readonly observedRequestsPerMinute: number | null;
  readonly requestRateCoverage: TelemetryCoverageSummary;
  readonly coverage: TelemetryCoverage;
  readonly latestAttempt: {
    readonly attemptId: AttemptId;
    readonly dispatchStartedAt: IsoTimestamp;
    readonly outcome: ProviderAttemptTelemetryOutcome;
    readonly acceptedByProvider: ProviderAcceptanceEvidence;
  } | null;
}

export interface ProviderLatencyProjection {
  readonly requestUploadMs: ProviderMetricDistribution;
  readonly timeToFirstByteMs: ProviderMetricDistribution;
  readonly timeToFirstProviderOutputMs: ProviderMetricDistribution;
  readonly timeToFirstReasoningMs: ProviderMetricDistribution;
  /** User-perceived TTFT: first visible output, never hidden reasoning. */
  readonly timeToFirstVisibleOutputMs: ProviderMetricDistribution;
  readonly timeToFirstCompleteItemMs: ProviderMetricDistribution;
  readonly visibleGenerationMs: ProviderMetricDistribution;
  readonly totalAttemptMs: ProviderMetricDistribution;
  readonly visibleTokensPerSecond: ProviderMetricDistribution;
}

export interface ProviderTelemetryProjection {
  readonly schemaVersion: 1;
  readonly providerConnectionId: ProviderConnectionId;
  readonly modelProfileId: ModelProfileId | null;
  readonly providerModelIds: readonly string[];
  readonly generatedAt: IsoTimestamp;
  readonly window: {
    readonly startedAt: IsoTimestamp;
    readonly endedAt: IsoTimestamp;
    readonly durationMs: number;
  };
  readonly activity: ProviderAttemptActivityProjection;
  readonly latency: ProviderLatencyProjection;
  readonly tokens: ProviderTokenProjection;
  readonly costs: readonly ProviderCostCurrencyProjection[];
  readonly timingCoverage: TelemetryCoverageSummary;
  readonly usageCoverage: TelemetryCoverageSummary;
  readonly costCoverage: TelemetryCoverageSummary;
  /** Probe/observation health remains separate from the last attempt outcome. */
  readonly health: ProviderHealthProjection;
  readonly latestObservedAt: IsoTimestamp | null;
}

function assertPositiveSafeInteger(value: number, label: string): number {
  assertDomain(
    Number.isSafeInteger(value) && value > 0,
    "invalid_argument",
    `${label} must be a positive safe integer.`,
    { value },
  );
  return value;
}

function sumSafeIntegers(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    assertDomain(
      Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - total,
      "invalid_argument",
      `${label} exceeds the safe integer range.`,
    );
    total += value;
  }
  return total;
}

function sumFinite(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    const next = total + value;
    assertDomain(
      Number.isFinite(value) && value >= 0 && Number.isFinite(next),
      "invalid_argument",
      `${label} exceeds the finite numeric range.`,
    );
    total = next;
  }
  return total;
}

function statusForCoverage(
  collectionCoverage: TelemetryCoverage,
  expectedSamples: number,
  coverages: readonly TelemetryCoverage[],
): TelemetryCoverage {
  if (collectionCoverage === "unknown") return "unknown";
  if (collectionCoverage === "partial") return "partial";
  if (expectedSamples === 0) return collectionCoverage;
  if (coverages.length < expectedSamples) return "partial";
  if (coverages.every((coverage) => coverage === "complete")) {
    return collectionCoverage === "estimated" ? "estimated" : "complete";
  }
  if (coverages.every((coverage) => coverage === "estimated")) return "estimated";
  return "partial";
}

function summarizeCoverage(
  collectionCoverage: TelemetryCoverage,
  expectedSamples: number,
  coverages: readonly TelemetryCoverage[],
): TelemetryCoverageSummary {
  const count = (coverage: TelemetryCoverage) =>
    coverages.filter((candidate) => candidate === coverage).length;
  return Object.freeze({
    status: statusForCoverage(collectionCoverage, expectedSamples, coverages),
    expectedSamples,
    observedSamples: coverages.length,
    completeSamples: count("complete"),
    partialSamples: count("partial"),
    estimatedSamples: count("estimated"),
    unknownSamples: count("unknown") + Math.max(0, expectedSamples - coverages.length),
  });
}

function combineCoverage(
  left: TelemetryCoverage,
  right: TelemetryCoverage,
): TelemetryCoverage {
  if (left === "unknown" || right === "unknown") return "unknown";
  if (left === "partial" || right === "partial") return "partial";
  if (left === "estimated" || right === "estimated") return "estimated";
  return "complete";
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

interface ObservedMetricValue {
  readonly value: number;
  readonly coverage: TelemetryCoverage;
}

function distribute(
  values: readonly ObservedMetricValue[],
  expectedSamples: number,
  collectionCoverage: TelemetryCoverage,
): ProviderMetricDistribution {
  const numbers = values.map((value) => value.value);
  const total = sumFinite(numbers, "provider metric distribution");
  return Object.freeze({
    samples: numbers.length,
    mean: numbers.length === 0 ? null : total / numbers.length,
    minimum: numbers.length === 0 ? null : Math.min(...numbers),
    p50: percentile(numbers, 0.5),
    p95: percentile(numbers, 0.95),
    maximum: numbers.length === 0 ? null : Math.max(...numbers),
    coverage: summarizeCoverage(
      collectionCoverage,
      expectedSamples,
      values.map((value) => value.coverage),
    ),
  });
}

interface SelectedAttemptUsage {
  readonly counters: NormalizedUsageCounters | null;
  readonly source: UsageObservationSource | null;
  readonly authoritative: boolean;
  readonly coverage: TelemetryCoverage | null;
}

function selectedAttemptUsage(record: ProviderAttemptTelemetryRecord): SelectedAttemptUsage {
  if (record.usageLedger === undefined) {
    return Object.freeze({
      counters: null,
      source: null,
      authoritative: false,
      coverage: null,
    });
  }
  const attemptId = record.scope.attemptId;
  assertDomain(
    attemptId !== undefined,
    "scope_violation",
    "Provider telemetry usage requires an attempt ID.",
  );
  const projection = projectUsage(record.usageLedger, attemptId);
  const sourceEntry =
    projection.sourceEntryId === null
      ? undefined
      : record.usageLedger.entries.find((entry) => entry.id === projection.sourceEntryId);
  return Object.freeze({
    counters: projection.counters,
    source: projection.source,
    authoritative: projection.authoritative,
    coverage: sourceEntry?.coverage ?? null,
  });
}

const COUNTER_KEYS = [
  "inputTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningTokens",
  "visibleOutputTokens",
] as const satisfies readonly (keyof NormalizedUsageCounters)[];

type TokenCounterKey = (typeof COUNTER_KEYS)[number];

function counterRate(
  records: readonly ProviderAttemptTelemetryRecord[],
  selectedUsage: ReadonlyMap<AttemptId, SelectedAttemptUsage>,
  key: TokenCounterKey,
  windowMinutes: number,
  collectionCoverage: TelemetryCoverage,
): ObservedCounterRate {
  const observed: ObservedMetricValue[] = [];
  for (const record of records) {
    const attemptId = record.scope.attemptId;
    if (attemptId === undefined) continue;
    const usage = selectedUsage.get(attemptId);
    const value = usage?.counters?.[key];
    if (typeof value === "number" && usage?.coverage !== null && usage?.coverage !== undefined) {
      observed.push({ value, coverage: usage.coverage });
    }
  }
  const value =
    observed.length === 0
      ? null
      : sumSafeIntegers(
          observed.map((item) => item.value),
          `provider ${key} total`,
        );
  return Object.freeze({
    observed: value,
    averagePerSample: value === null ? null : value / observed.length,
    perMinute: value === null ? null : value / windowMinutes,
    samples: observed.length,
    coverage: summarizeCoverage(
      collectionCoverage,
      records.length,
      observed.map((item) => item.coverage),
    ),
  });
}

function billableUnitRates(
  records: readonly ProviderAttemptTelemetryRecord[],
  selectedUsage: ReadonlyMap<AttemptId, SelectedAttemptUsage>,
  windowMinutes: number,
  collectionCoverage: TelemetryCoverage,
): Readonly<Record<string, ObservedCounterRate>> {
  const keys = new Set<string>();
  for (const usage of selectedUsage.values()) {
    for (const key of Object.keys(usage.counters?.billableUnits ?? {})) keys.add(key);
  }
  const result: Record<string, ObservedCounterRate> = {};
  for (const key of [...keys].sort()) {
    const observed: ObservedMetricValue[] = [];
    for (const record of records) {
      const attemptId = record.scope.attemptId;
      if (attemptId === undefined) continue;
      const usage = selectedUsage.get(attemptId);
      const value = usage?.counters?.billableUnits?.[key];
      if (value !== undefined && usage?.coverage !== null && usage?.coverage !== undefined) {
        observed.push({ value, coverage: usage.coverage });
      }
    }
    const value =
      observed.length === 0
        ? null
        : sumFinite(
            observed.map((item) => item.value),
            `provider billable unit ${key} total`,
          );
    result[key] = Object.freeze({
      observed: value,
      averagePerSample: value === null ? null : value / observed.length,
      perMinute: value === null ? null : value / windowMinutes,
      samples: observed.length,
      coverage: summarizeCoverage(
        collectionCoverage,
        records.length,
        observed.map((item) => item.coverage),
      ),
    });
  }
  return Object.freeze(result);
}

interface CostCandidate {
  readonly attemptId: AttemptId;
  readonly statement: CostStatement;
  readonly sequence: number;
  readonly coverage: TelemetryCoverage;
}

const COST_KIND_RANK: Readonly<Record<CostStatementKind, number>> = Object.freeze({
  "calculated-estimate": 1,
  "provider-reported": 2,
  invoice: 3,
  "user-override": 4,
});

function costCandidates(records: readonly ProviderAttemptTelemetryRecord[]): readonly CostCandidate[] {
  const latestByExactLayer = new Map<string, CostCandidate>();
  for (const record of records) {
    const attemptId = record.scope.attemptId;
    if (attemptId === undefined || record.usageLedger === undefined) continue;
    for (const entry of record.usageLedger.entries) {
      if (entry.scope.attemptId !== attemptId) continue;
      for (const statement of entry.costs) {
        const key = [
          attemptId,
          statement.kind,
          statement.component,
          statement.currency,
        ].join("\u0000");
        const current = latestByExactLayer.get(key);
        if (current === undefined || entry.sequence > current.sequence) {
          latestByExactLayer.set(key, {
            attemptId,
            statement,
            sequence: entry.sequence,
            coverage: entry.coverage,
          });
        }
      }
    }
  }
  return Object.freeze([...latestByExactLayer.values()]);
}

function projectCosts(
  records: readonly ProviderAttemptTelemetryRecord[],
  collectionCoverage: TelemetryCoverage,
): readonly ProviderCostCurrencyProjection[] {
  const candidates = costCandidates(records);
  const currencies = new Set(candidates.map((candidate) => candidate.statement.currency));
  const result: ProviderCostCurrencyProjection[] = [];
  for (const currency of [...currencies].sort()) {
    const inCurrency = candidates.filter((candidate) => candidate.statement.currency === currency);
    const byAttempt = new Map<AttemptId, CostCandidate[]>();
    for (const candidate of inCurrency) {
      const group = byAttempt.get(candidate.attemptId) ?? [];
      group.push(candidate);
      byAttempt.set(candidate.attemptId, group);
    }
    const effective: CostCandidate[] = [];
    for (const candidates of byAttempt.values()) {
      const highestRank = Math.max(
        ...candidates.map((candidate) => COST_KIND_RANK[candidate.statement.kind]),
      );
      effective.push(
        ...candidates.filter(
          (candidate) => COST_KIND_RANK[candidate.statement.kind] === highestRank,
        ),
      );
    }
    const costedAttempts = new Set(effective.map((candidate) => candidate.attemptId));
    const recordsWithCost = new Set(inCurrency.map((candidate) => candidate.attemptId));
    const potentiallyBillableAttempts = records.filter(
      (record) =>
        record.acceptedByProvider !== false ||
        (record.scope.attemptId !== undefined && recordsWithCost.has(record.scope.attemptId)),
    ).length;
    const effectiveAmount = sumSafeIntegers(
      effective.map((candidate) => candidate.statement.amountMicrounits),
      `effective ${currency} cost`,
    );
    const effectiveKindCounts: Partial<Record<CostStatementKind, number>> = {};
    for (const candidate of effective) {
      effectiveKindCounts[candidate.statement.kind] =
        (effectiveKindCounts[candidate.statement.kind] ?? 0) + 1;
    }
    const layers: ProviderCostLayerProjection[] = [];
    for (const kind of Object.keys(COST_KIND_RANK) as CostStatementKind[]) {
      const matching = inCurrency.filter((candidate) => candidate.statement.kind === kind);
      if (matching.length === 0) continue;
      layers.push(
        Object.freeze({
          kind,
          amountMicrounits: sumSafeIntegers(
            matching.map((candidate) => candidate.statement.amountMicrounits),
            `${kind} ${currency} cost layer`,
          ),
          statements: matching.length,
          attempts: new Set(matching.map((candidate) => candidate.attemptId)).size,
        }),
      );
    }
    const attemptCoverages = [...costedAttempts].map((attemptId) => {
      const selected = effective.filter((candidate) => candidate.attemptId === attemptId);
      if (selected.every((candidate) => candidate.statement.kind === "calculated-estimate")) {
        return "estimated" as const;
      }
      if (selected.every((candidate) => candidate.coverage === "complete")) return "complete";
      if (selected.some((candidate) => candidate.coverage === "unknown")) return "unknown";
      return "partial";
    });
    result.push(
      Object.freeze({
        currency,
        effectiveAmountMicrounits: effective.length === 0 ? null : effectiveAmount,
        costedAttempts: costedAttempts.size,
        potentiallyBillableAttempts,
        averagePerCostedAttemptMicrounits:
          costedAttempts.size === 0 ? null : effectiveAmount / costedAttempts.size,
        effectiveKindCounts: Object.freeze({ ...effectiveKindCounts }),
        layers: Object.freeze(layers),
        coverage: summarizeCoverage(
          collectionCoverage,
          potentiallyBillableAttempts,
          attemptCoverages,
        ),
      }),
    );
  }
  return Object.freeze(result);
}

function latestTimestamp(values: readonly (IsoTimestamp | undefined)[]): IsoTimestamp | null {
  const present = values.filter((value): value is IsoTimestamp => value !== undefined);
  if (present.length === 0) return null;
  return [...present].sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function latencyValues(
  records: readonly ProviderAttemptTelemetryRecord[],
  selectedUsage: ReadonlyMap<AttemptId, SelectedAttemptUsage>,
  selector: (projection: AttemptLatencyProjection) => number | null,
  requiresVisibleTokenUsage = false,
): readonly ObservedMetricValue[] {
  const values: ObservedMetricValue[] = [];
  for (const record of records) {
    if (record.timing === undefined || record.scope.attemptId === undefined) continue;
    const visibleTokens = selectedUsage.get(record.scope.attemptId)?.counters?.visibleOutputTokens;
    const projection = projectAttemptLatency(record.timing, visibleTokens);
    const value = selector(projection);
    if (value !== null) {
      const usageCoverage = selectedUsage.get(record.scope.attemptId)?.coverage;
      values.push({
        value,
        coverage:
          requiresVisibleTokenUsage && usageCoverage !== null && usageCoverage !== undefined
            ? combineCoverage(record.timing.coverage, usageCoverage)
            : record.timing.coverage,
      });
    }
  }
  return values;
}

/**
 * Builds the deterministic provider/model observability read model consumed by
 * the Settings, model picker, usage inspector, and future evaluation surfaces.
 * Every rate is tied to one explicit fixed window and every observed total is
 * paired with coverage, so incomplete telemetry cannot masquerade as zero.
 */
export function projectProviderTelemetry(
  input: ProviderTelemetryProjectionInput,
): ProviderTelemetryProjection {
  assertIsoTimestamp(input.policy.now, "provider telemetry projection time");
  const windowMs = assertPositiveSafeInteger(input.policy.windowMs, "provider telemetry window");
  const nowMs = Date.parse(input.policy.now);
  const windowStartedMs = nowMs - windowMs;
  assertDomain(
    windowStartedMs >= -8_640_000_000_000_000,
    "invalid_argument",
    "Provider telemetry window begins outside the ISO timestamp range.",
  );
  const seenAttemptIds = new Set<AttemptId>();
  const normalizedRecords = input.attempts.map((record) =>
    createProviderAttemptTelemetryRecord(record),
  );
  for (const record of normalizedRecords) {
    assertDomain(
      !seenAttemptIds.has(record.scope.attemptId),
      "conflict",
      "Provider telemetry contains a duplicate attempt.",
      { attemptId: record.scope.attemptId },
    );
    seenAttemptIds.add(record.scope.attemptId);
  }
  const records = normalizedRecords
    .filter(
      (record) =>
        record.scope.providerConnectionId === input.providerConnectionId &&
        (input.modelProfileId === null || record.scope.modelProfileId === input.modelProfileId) &&
        Date.parse(record.dispatchStartedAt) >= windowStartedMs &&
        Date.parse(record.dispatchStartedAt) <= nowMs,
    )
    .sort(
      (left, right) =>
        Date.parse(left.dispatchStartedAt) - Date.parse(right.dispatchStartedAt) ||
        (left.scope.attemptId ?? "").localeCompare(right.scope.attemptId ?? ""),
    );
  const windowMinutes = windowMs / 60_000;
  const selectedUsage = new Map<AttemptId, SelectedAttemptUsage>();
  for (const record of records) {
    if (record.scope.attemptId !== undefined) {
      selectedUsage.set(record.scope.attemptId, selectedAttemptUsage(record));
    }
  }
  const timingCoverages = records.flatMap((record) =>
    record.timing === undefined ? [] : [record.timing.coverage],
  );
  const usageCoverages = [...selectedUsage.values()].flatMap((usage) =>
    usage.coverage === null ? [] : [usage.coverage],
  );
  const outcomeCount = (outcome: ProviderAttemptTelemetryOutcome) =>
    records.filter((record) => record.outcome === outcome).length;
  const completed = outcomeCount("completed");
  const failed = outcomeCount("failed");
  const requestEvidence = records.filter(
    (record) =>
      record.timing?.marks.requestCommittedMs !== undefined ||
      record.acceptedByProvider === true,
  );
  const requestEvidenceCoverage = requestEvidence.map((record) =>
    record.timing?.marks.requestCommittedMs !== undefined
      ? (record.timing.coverage)
      : ("complete" as const),
  );
  const latest = records.at(-1);
  const providerModelIds = Object.freeze(
    [...new Set(records.map((record) => record.scope.providerModelId))]
      .filter((value): value is string => value !== undefined)
      .sort(),
  );

  const latency = Object.freeze({
    requestUploadMs: distribute(
      latencyValues(records, selectedUsage, (projection) => projection.requestUploadMs),
      records.length,
      input.attemptCollectionCoverage,
    ),
    timeToFirstByteMs: distribute(
      latencyValues(records, selectedUsage, (projection) => projection.timeToFirstByteMs),
      records.length,
      input.attemptCollectionCoverage,
    ),
    timeToFirstProviderOutputMs: distribute(
      latencyValues(
        records,
        selectedUsage,
        (projection) => projection.timeToFirstProviderOutputMs,
      ),
      records.length,
      input.attemptCollectionCoverage,
    ),
    timeToFirstReasoningMs: distribute(
      latencyValues(records, selectedUsage, (projection) => projection.timeToFirstReasoningMs),
      records.length,
      input.attemptCollectionCoverage,
    ),
    timeToFirstVisibleOutputMs: distribute(
      latencyValues(
        records,
        selectedUsage,
        (projection) => projection.timeToFirstVisibleOutputMs,
      ),
      records.length,
      input.attemptCollectionCoverage,
    ),
    timeToFirstCompleteItemMs: distribute(
      latencyValues(
        records,
        selectedUsage,
        (projection) => projection.timeToFirstCompleteItemMs,
      ),
      records.length,
      input.attemptCollectionCoverage,
    ),
    visibleGenerationMs: distribute(
      latencyValues(records, selectedUsage, (projection) => projection.visibleGenerationMs),
      records.length,
      input.attemptCollectionCoverage,
    ),
    totalAttemptMs: distribute(
      latencyValues(records, selectedUsage, (projection) => projection.totalAttemptMs),
      records.length,
      input.attemptCollectionCoverage,
    ),
    visibleTokensPerSecond: distribute(
      latencyValues(
        records,
        selectedUsage,
        (projection) => projection.visibleTokensPerSecond,
        true,
      ),
      records.length,
      input.attemptCollectionCoverage,
    ),
  } satisfies ProviderLatencyProjection);

  const selectedSourceCounts: Partial<Record<UsageObservationSource, number>> = {};
  for (const usage of selectedUsage.values()) {
    if (usage.source === null) continue;
    selectedSourceCounts[usage.source] = (selectedSourceCounts[usage.source] ?? 0) + 1;
  }
  const tokens = Object.freeze({
    inputTokens: counterRate(
      records,
      selectedUsage,
      "inputTokens",
      windowMinutes,
      input.attemptCollectionCoverage,
    ),
    cacheReadInputTokens: counterRate(
      records,
      selectedUsage,
      "cacheReadInputTokens",
      windowMinutes,
      input.attemptCollectionCoverage,
    ),
    cacheWriteInputTokens: counterRate(
      records,
      selectedUsage,
      "cacheWriteInputTokens",
      windowMinutes,
      input.attemptCollectionCoverage,
    ),
    outputTokens: counterRate(
      records,
      selectedUsage,
      "outputTokens",
      windowMinutes,
      input.attemptCollectionCoverage,
    ),
    reasoningTokens: counterRate(
      records,
      selectedUsage,
      "reasoningTokens",
      windowMinutes,
      input.attemptCollectionCoverage,
    ),
    visibleOutputTokens: counterRate(
      records,
      selectedUsage,
      "visibleOutputTokens",
      windowMinutes,
      input.attemptCollectionCoverage,
    ),
    billableUnits: billableUnitRates(
      records,
      selectedUsage,
      windowMinutes,
      input.attemptCollectionCoverage,
    ),
    selectedSourceCounts: Object.freeze({ ...selectedSourceCounts }),
    authoritativeAttempts: [...selectedUsage.values()].filter((usage) => usage.authoritative).length,
  } satisfies ProviderTokenProjection);

  const costs = projectCosts(records, input.attemptCollectionCoverage);
  const potentiallyBillableAttemptIds = new Set(
    records.flatMap((record) =>
      record.acceptedByProvider !== false && record.scope.attemptId !== undefined
        ? [record.scope.attemptId]
        : [],
    ),
  );
  const costedAttemptIds = new Set(
    costCandidates(records).map((candidate) => candidate.attemptId),
  );
  for (const attemptId of costedAttemptIds) potentiallyBillableAttemptIds.add(attemptId);
  const costCoverageValues = records.flatMap((record) => {
    const attemptId = record.scope.attemptId;
    if (attemptId === undefined || !costedAttemptIds.has(attemptId)) return [];
    const attemptCosts = costCandidates([record]);
    if (attemptCosts.every((candidate) => candidate.statement.kind === "calculated-estimate")) {
      return ["estimated" as const];
    }
    if (attemptCosts.every((candidate) => candidate.coverage === "complete")) {
      return ["complete" as const];
    }
    return ["partial" as const];
  });

  const health = projectProviderHealth(
    input.healthObservations,
    input.providerConnectionId,
    input.modelProfileId,
    { ...input.policy.health, now: input.policy.now },
  );
  const latestObservedAt = latestTimestamp([
    ...records.map((record) => record.dispatchStartedAt),
    ...records.map((record) => record.timing?.observedAt),
    ...records.flatMap((record) =>
      record.usageLedger?.entries.map((entry) => entry.observedAt) ?? [],
    ),
    health.latestObservedAt ?? undefined,
  ]);

  return Object.freeze({
    schemaVersion: 1,
    providerConnectionId: input.providerConnectionId,
    modelProfileId: input.modelProfileId,
    providerModelIds,
    generatedAt: input.policy.now,
    window: Object.freeze({
      startedAt: new Date(windowStartedMs).toISOString(),
      endedAt: input.policy.now,
      durationMs: windowMs,
    }),
    activity: Object.freeze({
      observedAttempts: records.length,
      dispatching: outcomeCount("dispatching"),
      streaming: outcomeCount("streaming"),
      completed,
      failed,
      cancelled: outcomeCount("cancelled"),
      outcomeUnknown: outcomeCount("outcome-unknown"),
      accepted: records.filter((record) => record.acceptedByProvider === true).length,
      notAccepted: records.filter((record) => record.acceptedByProvider === false).length,
      acceptanceUnknown: records.filter(
        (record) => record.acceptedByProvider === "unknown",
      ).length,
      definitiveCompletionRate:
        completed + failed === 0 ? null : completed / (completed + failed),
      attemptsPerMinute: records.length / windowMinutes,
      providerRequestsObserved: requestEvidence.length,
      observedRequestsPerMinute:
        requestEvidence.length === 0 ? null : requestEvidence.length / windowMinutes,
      requestRateCoverage: summarizeCoverage(
        input.attemptCollectionCoverage,
        records.length,
        requestEvidenceCoverage,
      ),
      coverage: input.attemptCollectionCoverage,
      latestAttempt:
        latest === undefined || latest.scope.attemptId === undefined
          ? null
          : Object.freeze({
              attemptId: latest.scope.attemptId,
              dispatchStartedAt: latest.dispatchStartedAt,
              outcome: latest.outcome,
              acceptedByProvider: latest.acceptedByProvider,
            }),
    }),
    latency,
    tokens,
    costs,
    timingCoverage: summarizeCoverage(
      input.attemptCollectionCoverage,
      records.length,
      timingCoverages,
    ),
    usageCoverage: summarizeCoverage(
      input.attemptCollectionCoverage,
      records.length,
      usageCoverages,
    ),
    costCoverage: summarizeCoverage(
      input.attemptCollectionCoverage,
      potentiallyBillableAttemptIds.size,
      costCoverageValues,
    ),
    health,
    latestObservedAt,
  });
}
