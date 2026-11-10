import type {
  AttemptId,
  ModelProfileId,
  ProviderConnectionId,
  RunId,
} from "@/domain/ids";
import {
  projectAttemptLatency,
  projectUsage,
  type CostStatementKind,
  type ProviderAttemptTelemetryRecord,
  type ProviderAttemptTelemetryOutcome,
  type TelemetryCoverage,
  type UsageObservationSource,
} from "@/domain";

/**
 * The request inspector is a read-only renderer projection.  Native code (or
 * a test fixture standing in for it) supplies an already-normalized attempt;
 * this module only composes display-safe sections.  In particular, it never
 * accepts prompt/response text, raw provider request IDs, credentials, URLs,
 * or arbitrary provider payloads.
 */

export type InspectorDataQuality =
  | "reported"
  | "estimated"
  | "partial"
  | "unknown"
  | "stale"
  | "reconciled"
  | "corrected";

export type InspectorLogicalRunStatus =
  | "draft"
  | "queued"
  | "preparing"
  | "dispatching"
  | "streaming"
  | "retry-scheduled"
  | "waiting-user"
  | "completed"
  | "failed"
  | "cancelled"
  | "outcome-unknown";

export type InspectorAttemptStatus =
  | "prepared"
  | "dispatching"
  | "accepted"
  | "streaming"
  | "stalled"
  | "retrying"
  | "terminal"
  | "outcome-unknown";

export type InspectorCostKind =
  | "calculated-estimate"
  | "provider-reported"
  | "invoice"
  | "user-override";

export interface RequestInspectorProjection {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly scope: {
    readonly profileId: string;
    readonly projectId?: string;
    readonly conversationId: string;
    readonly branchId: string;
    readonly runId: string;
    readonly iterationId?: string;
    readonly attemptId: string;
    readonly itemId?: string;
  };
  readonly message: {
    readonly userMessageId?: string;
    readonly userMessageRevisionId?: string;
    readonly assistantMessageId?: string;
    readonly promptRevisionId?: string;
    readonly sourceCursor?: number;
  };
  readonly route: {
    readonly requestedProvider?: string;
    readonly resolvedProvider: string;
    readonly providerConnectionRevision?: string;
    readonly adapterId?: string;
    readonly adapterVersion?: string;
    readonly requestedModel?: string;
    readonly resolvedModel: string;
    readonly modelProfileRevision?: string;
    readonly catalogSnapshotId?: string;
    readonly capabilitySnapshotHash?: string;
    readonly requestedEffort?: string;
    readonly resolvedEffort?: string;
    readonly parameterSnapshotHash?: string;
    readonly routePlanRevision?: string;
    readonly serviceTier?: string;
    readonly endpointAlias?: string;
    readonly compatibilityWarnings: readonly string[];
  };
  readonly status: {
    readonly logicalRun: InspectorLogicalRunStatus;
    readonly attempt: InspectorAttemptStatus;
    readonly terminalReason?: string;
    readonly dataQuality: InspectorDataQuality;
  };
  readonly timing: {
    readonly startedAt?: string;
    readonly queueMs?: number;
    readonly contextCompileMs?: number;
    readonly approvalWaitMs?: number;
    readonly requestUploadMs?: number;
    readonly timeToFirstByteMs?: number;
    readonly timeToFirstProviderOutputMs?: number;
    readonly timeToFirstReasoningMs?: number;
    readonly timeToFirstVisibleOutputMs?: number;
    readonly timeToFirstCompleteItemMs?: number;
    readonly visibleGenerationMs?: number;
    readonly totalAttemptMs?: number;
    readonly totalLogicalRunMs?: number;
    readonly retryBackoffMs?: number;
    readonly toolWaitMs?: number;
    readonly rendererBackpressureMs?: number;
    readonly terminalAt?: string;
  };
  readonly usage: {
    readonly inputTokens?: number;
    readonly uncachedInputTokens?: number;
    readonly cacheReadInputTokens?: number;
    readonly cacheWriteInputTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningTokens?: number;
    readonly visibleOutputTokens?: number;
    /** Provider-supplied total is not inferred from overlapping counters. */
    readonly totalTokens?: number;
    readonly providerCounters: Readonly<Record<string, number>>;
    readonly source: UsageObservationSource | "unknown";
    readonly authoritative: boolean;
    readonly coverage: TelemetryCoverage;
  };
  readonly throughput: {
    readonly visibleTokensPerSecond?: number;
    readonly endToEndTokensPerSecond?: number;
    readonly providerTokensPerSecond?: number;
    readonly reasoningTokensPerSecond?: number;
    readonly streamDeltaP50Ms?: number;
    readonly streamDeltaP95Ms?: number;
    readonly formulaVersion: "visible-generation-v1";
  };
  readonly quota: {
    readonly windows: readonly InspectorQuotaWindow[];
  };
  readonly cost: {
    readonly statements: readonly InspectorCostStatement[];
    readonly totalEstimatedMicrounits?: number;
    readonly totalReportedMicrounits?: number;
    readonly totalInvoiceMicrounits?: number;
    readonly retryWasteMicrounits?: number;
    readonly branchIncrementMicrounits?: number;
  };
  readonly retry: {
    readonly attempts: readonly InspectorRetryAttempt[];
    readonly nextRetryAt?: string;
    readonly retryWindowEndsAt?: string;
    readonly fallbackSelected?: boolean;
  };
  readonly context: {
    readonly snapshotId?: string;
    readonly compilerVersion?: string;
    readonly inputBudget?: number;
    readonly reservedOutputBudget?: number;
    readonly includedItems?: number;
    readonly omittedItems?: number;
    readonly staleItems?: number;
    readonly restrictedItems?: number;
    readonly cacheHit?: boolean;
  };
  readonly lineage: {
    readonly parentRunId?: string;
    readonly parentAttemptId?: string;
    readonly sourceBranchId?: string;
    readonly forkBoundary?: string;
    readonly derivedFromRunId?: string;
    readonly operation:
      | "original"
      | "copy"
      | "jump"
      | "branch"
      | "fork"
      | "retry"
      | "regenerate"
      | "compare"
      | "promote";
  };
}

export interface InspectorQuotaWindow {
  readonly kind:
    | "requests"
    | "input-tokens"
    | "output-tokens"
    | "total-tokens"
    | "concurrency";
  readonly scope?: string;
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetAt?: string;
  readonly windowSeconds?: number;
  readonly retryAfterMs?: number;
  readonly source: "provider-header" | "provider-api" | "configured" | "inferred";
  readonly authoritative: boolean;
  readonly observedAt: string;
}

export interface InspectorCostStatement {
  readonly kind: InspectorCostKind;
  readonly component: string;
  readonly amountMicrounits: number;
  readonly currency: string;
  readonly priceSnapshotId?: string;
  readonly formulaVersion?: string;
  readonly observedAt: string;
}

export interface InspectorRetryAttempt {
  readonly attemptId: string;
  readonly status: string;
  readonly httpStatus?: number;
  readonly normalizedError?: string;
  readonly acceptance: "not-sent" | "rejected" | "accepted" | "unknown";
  readonly startedAt?: string;
  readonly terminalAt?: string;
  readonly selectedDelayMs?: number;
  readonly decisionId?: string;
}

export interface RequestInspectorRouteInput {
  readonly requestedProvider?: string;
  readonly requestedModel?: string;
  readonly providerConnectionRevision?: string;
  readonly adapterId?: string;
  readonly adapterVersion?: string;
  readonly modelProfileRevision?: string;
  readonly catalogSnapshotId?: string;
  readonly capabilitySnapshotHash?: string;
  readonly requestedEffort?: string;
  readonly resolvedEffort?: string;
  readonly parameterSnapshotHash?: string;
  readonly routePlanRevision?: string;
  readonly serviceTier?: string;
  readonly endpointAlias?: string;
  readonly compatibilityWarnings?: readonly string[];
}

export interface RequestInspectorMessageInput {
  readonly userMessageId?: string;
  readonly userMessageRevisionId?: string;
  readonly assistantMessageId?: string;
  readonly promptRevisionId?: string;
  readonly sourceCursor?: number;
}

export interface RequestInspectorRetryInput {
  readonly attempts?: readonly InspectorRetryAttempt[];
  readonly nextRetryAt?: string;
  readonly retryWindowEndsAt?: string;
  readonly fallbackSelected?: boolean;
}

export interface RequestInspectorContextInput {
  readonly snapshotId?: string;
  readonly compilerVersion?: string;
  readonly inputBudget?: number;
  readonly reservedOutputBudget?: number;
  readonly includedItems?: number;
  readonly omittedItems?: number;
  readonly staleItems?: number;
  readonly restrictedItems?: number;
  readonly cacheHit?: boolean;
}

export interface RequestInspectorLineageInput {
  readonly parentRunId?: string;
  readonly parentAttemptId?: string;
  readonly sourceBranchId?: string;
  readonly forkBoundary?: string;
  readonly derivedFromRunId?: string;
  readonly operation?: RequestInspectorProjection["lineage"]["operation"];
}

export interface RequestInspectorProjectionInput {
  /** Durable opaque request identity. It is not a provider request ID. */
  readonly requestId: string;
  readonly record: ProviderAttemptTelemetryRecord;
  readonly route?: RequestInspectorRouteInput;
  readonly message?: RequestInspectorMessageInput;
  readonly logicalRunStatus?: InspectorLogicalRunStatus;
  readonly terminalReason?: string;
  readonly totalLogicalRunMs?: number;
  readonly quotaWindows?: readonly InspectorQuotaWindow[];
  readonly retry?: RequestInspectorRetryInput;
  readonly context?: RequestInspectorContextInput;
  readonly lineage?: RequestInspectorLineageInput;
  readonly attemptOrdinal?: number;
  readonly now?: string;
}

function optionalNonNegative(value: number | undefined, _label: string): number | undefined {
  if (value === undefined) return undefined;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalSafeInteger(value: number | undefined, _label: string): number | undefined {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be blank.`);
  return normalized;
}

function qualityForCoverage(coverage: TelemetryCoverage): InspectorDataQuality {
  if (coverage === "complete") return "reported";
  if (coverage === "estimated") return "estimated";
  if (coverage === "partial") return "partial";
  return "unknown";
}

function logicalStatusForOutcome(outcome: ProviderAttemptTelemetryOutcome): InspectorLogicalRunStatus {
  if (outcome === "dispatching") return "dispatching";
  if (outcome === "streaming") return "streaming";
  if (outcome === "completed") return "completed";
  if (outcome === "failed") return "failed";
  if (outcome === "cancelled") return "cancelled";
  return "outcome-unknown";
}

function attemptStatusForOutcome(
  outcome: ProviderAttemptTelemetryOutcome,
  acceptedByProvider: boolean | "unknown",
): InspectorAttemptStatus {
  if (outcome === "dispatching") return "dispatching";
  if (outcome === "streaming") return "streaming";
  if (outcome === "outcome-unknown" || acceptedByProvider === "unknown") return "outcome-unknown";
  if (acceptedByProvider === false) return "prepared";
  if (acceptedByProvider === true && (outcome === "completed" || outcome === "failed" || outcome === "cancelled")) {
    return "terminal";
  }
  return "accepted";
}

function terminalReasonForOutcome(outcome: ProviderAttemptTelemetryOutcome): string | undefined {
  if (outcome === "completed") return "completed";
  if (outcome === "failed") return "failed";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "outcome-unknown") return "outcome-unknown";
  return undefined;
}

function terminalAt(record: ProviderAttemptTelemetryRecord): string | undefined {
  const terminalMs = record.timing?.marks.terminalMs;
  if (terminalMs === undefined || record.timing === undefined) return undefined;
  return new Date(Date.parse(record.timing.originAt) + terminalMs).toISOString();
}

function mapCostKind(kind: CostStatementKind): InspectorCostKind {
  if (kind === "calculated-estimate") return "calculated-estimate";
  if (kind === "provider-reported") return "provider-reported";
  if (kind === "invoice") return "invoice";
  return "user-override";
}

function projectCost(
  record: ProviderAttemptTelemetryRecord,
): { statements: readonly InspectorCostStatement[]; totals: Record<string, number> } {
  const entries = record.usageLedger?.entries ?? [];
  const statements: InspectorCostStatement[] = [];
  const totals: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.scope.attemptId !== record.scope.attemptId) continue;
    for (const cost of entry.costs) {
      const statement: InspectorCostStatement = Object.freeze({
        kind: mapCostKind(cost.kind),
        component: cost.component,
        amountMicrounits: cost.amountMicrounits,
        currency: cost.currency,
        ...(cost.priceSnapshotId === undefined ? {} : { priceSnapshotId: cost.priceSnapshotId }),
        ...(cost.formulaVersion === undefined ? {} : { formulaVersion: cost.formulaVersion }),
        observedAt: entry.observedAt,
      });
      statements.push(statement);
      const key = statement.kind === "calculated-estimate"
        ? "estimated"
        : statement.kind === "provider-reported"
          ? "reported"
          : statement.kind === "invoice"
            ? "invoice"
            : "override";
      totals[key] = (totals[key] ?? 0) + statement.amountMicrounits;
    }
  }
  return { statements: Object.freeze(statements), totals };
}

function projectUsageDetails(record: ProviderAttemptTelemetryRecord): RequestInspectorProjection["usage"] {
  const ledger = record.usageLedger;
  if (ledger === undefined) {
    return Object.freeze({
      providerCounters: Object.freeze({}),
      source: "unknown",
      authoritative: false,
      coverage: "unknown",
    });
  }
  const attemptId = record.scope.attemptId;
  const selected = projectUsage(ledger, attemptId);
  const sourceEntry = selected.sourceEntryId === null
    ? undefined
    : ledger.entries.find((entry) => entry.id === selected.sourceEntryId);
  const counters = selected.counters;
  const providerCounters = sourceEntry?.providerCounters ?? {};
  const uncachedInputTokens =
    counters?.inputTokens !== undefined &&
    counters.cacheReadInputTokens !== undefined &&
    counters.inputTokens >= counters.cacheReadInputTokens
      ? counters.inputTokens - counters.cacheReadInputTokens
      : undefined;
  return Object.freeze({
    ...(counters?.inputTokens === undefined ? {} : { inputTokens: counters.inputTokens }),
    ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
    ...(counters?.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: counters.cacheReadInputTokens }),
    ...(counters?.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: counters.cacheWriteInputTokens }),
    ...(counters?.outputTokens === undefined ? {} : { outputTokens: counters.outputTokens }),
    ...(counters?.reasoningTokens === undefined ? {} : { reasoningTokens: counters.reasoningTokens }),
    ...(counters?.visibleOutputTokens === undefined ? {} : { visibleOutputTokens: counters.visibleOutputTokens }),
    providerCounters: Object.freeze({ ...providerCounters }),
    source: selected.source ?? "unknown",
    authoritative: selected.authoritative,
    coverage: sourceEntry?.coverage ?? "unknown",
  });
}

/**
 * Projects one exact provider attempt into the renderer request inspector
 * contract. Missing evidence remains absent (and is accompanied by a quality
 * state); it is never converted to a fabricated zero.
 */
export function projectRequestInspector(
  input: RequestInspectorProjectionInput,
): RequestInspectorProjection {
  const record = input.record;
  const scope = record.scope;
  const requestId = nonBlank(input.requestId, "request ID");
  const runId = nonBlank(scope.runId, "run ID");
  const attemptId = nonBlank(scope.attemptId, "attempt ID");
  const timing = record.timing;
  const usage = projectUsageDetails(record);
  const timingProjection = timing === undefined ? null : projectAttemptLatency(timing, usage.visibleOutputTokens);
  const quality = qualityForCoverage(usage.coverage);
  const route = input.route ?? {};
  const costs = projectCost(record);
  const attemptTerminalAt = terminalAt(record);
  const logicalRun = input.logicalRunStatus ?? logicalStatusForOutcome(record.outcome);
  const terminalReason = input.terminalReason ?? terminalReasonForOutcome(record.outcome);
  const totalLogicalRunMs = optionalNonNegative(input.totalLogicalRunMs, "logical run duration");
  const endToEndTokensPerSecond =
    usage.visibleOutputTokens !== undefined && totalLogicalRunMs !== undefined && totalLogicalRunMs > 0
      ? usage.visibleOutputTokens / (totalLogicalRunMs / 1_000)
      : undefined;
  const projectedTiming = {
    ...(record.dispatchStartedAt === undefined ? {} : { startedAt: record.dispatchStartedAt }),
    ...(timing?.waits.queueMs === undefined ? {} : { queueMs: timing.waits.queueMs }),
    ...(timing?.waits.contextCompileMs === undefined ? {} : { contextCompileMs: timing.waits.contextCompileMs }),
    ...(timing?.waits.approvalWaitMs === undefined ? {} : { approvalWaitMs: timing.waits.approvalWaitMs }),
    ...(timingProjection?.requestUploadMs === null || timingProjection?.requestUploadMs === undefined
      ? {}
      : { requestUploadMs: timingProjection.requestUploadMs }),
    ...(timingProjection?.timeToFirstByteMs === null || timingProjection?.timeToFirstByteMs === undefined
      ? {}
      : { timeToFirstByteMs: timingProjection.timeToFirstByteMs }),
    ...(timingProjection?.timeToFirstProviderOutputMs === null || timingProjection?.timeToFirstProviderOutputMs === undefined
      ? {}
      : { timeToFirstProviderOutputMs: timingProjection.timeToFirstProviderOutputMs }),
    ...(timingProjection?.timeToFirstReasoningMs === null || timingProjection?.timeToFirstReasoningMs === undefined
      ? {}
      : { timeToFirstReasoningMs: timingProjection.timeToFirstReasoningMs }),
    ...(timingProjection?.timeToFirstVisibleOutputMs === null || timingProjection?.timeToFirstVisibleOutputMs === undefined
      ? {}
      : { timeToFirstVisibleOutputMs: timingProjection.timeToFirstVisibleOutputMs }),
    ...(timingProjection?.timeToFirstCompleteItemMs === null || timingProjection?.timeToFirstCompleteItemMs === undefined
      ? {}
      : { timeToFirstCompleteItemMs: timingProjection.timeToFirstCompleteItemMs }),
    ...(timingProjection?.visibleGenerationMs === null || timingProjection?.visibleGenerationMs === undefined
      ? {}
      : { visibleGenerationMs: timingProjection.visibleGenerationMs }),
    ...(timingProjection?.totalAttemptMs === null || timingProjection?.totalAttemptMs === undefined
      ? {}
      : { totalAttemptMs: timingProjection.totalAttemptMs }),
    ...(totalLogicalRunMs === undefined ? {} : { totalLogicalRunMs }),
    ...(timing?.waits.providerBackoffMs === undefined ? {} : { retryBackoffMs: timing.waits.providerBackoffMs }),
    ...(timing?.waits.toolWaitMs === undefined ? {} : { toolWaitMs: timing.waits.toolWaitMs }),
    ...(timing?.waits.rendererBackpressureMs === undefined ? {} : { rendererBackpressureMs: timing.waits.rendererBackpressureMs }),
    ...(attemptTerminalAt === undefined ? {} : { terminalAt: attemptTerminalAt }),
  } satisfies RequestInspectorProjection["timing"];

  const projectedCost = {
    statements: costs.statements,
    ...(costs.totals.estimated === undefined ? {} : { totalEstimatedMicrounits: costs.totals.estimated }),
    ...(costs.totals.reported === undefined ? {} : { totalReportedMicrounits: costs.totals.reported }),
    ...(costs.totals.invoice === undefined ? {} : { totalInvoiceMicrounits: costs.totals.invoice }),
  } satisfies RequestInspectorProjection["cost"];

  const contextInputBudget = optionalSafeInteger(input.context?.inputBudget, "context input budget");
  const contextReservedOutputBudget = optionalSafeInteger(
    input.context?.reservedOutputBudget,
    "reserved output budget",
  );
  const contextIncludedItems = optionalSafeInteger(input.context?.includedItems, "included context items");
  const contextOmittedItems = optionalSafeInteger(input.context?.omittedItems, "omitted context items");
  const contextStaleItems = optionalSafeInteger(input.context?.staleItems, "stale context items");
  const contextRestrictedItems = optionalSafeInteger(input.context?.restrictedItems, "restricted context items");
  const projectedContext = {
    ...(input.context?.snapshotId === undefined ? {} : { snapshotId: input.context.snapshotId }),
    ...(input.context?.compilerVersion === undefined ? {} : { compilerVersion: input.context.compilerVersion }),
    ...(contextInputBudget === undefined ? {} : { inputBudget: contextInputBudget }),
    ...(contextReservedOutputBudget === undefined ? {} : { reservedOutputBudget: contextReservedOutputBudget }),
    ...(contextIncludedItems === undefined ? {} : { includedItems: contextIncludedItems }),
    ...(contextOmittedItems === undefined ? {} : { omittedItems: contextOmittedItems }),
    ...(contextStaleItems === undefined ? {} : { staleItems: contextStaleItems }),
    ...(contextRestrictedItems === undefined ? {} : { restrictedItems: contextRestrictedItems }),
    ...(input.context?.cacheHit === undefined ? {} : { cacheHit: input.context.cacheHit }),
  } satisfies RequestInspectorProjection["context"];

  const lineageInput = input.lineage ?? {};
  const projectedLineage = {
    ...(lineageInput.parentRunId === undefined ? {} : { parentRunId: lineageInput.parentRunId }),
    ...(lineageInput.parentAttemptId === undefined ? {} : { parentAttemptId: lineageInput.parentAttemptId }),
    ...(lineageInput.sourceBranchId === undefined ? {} : { sourceBranchId: lineageInput.sourceBranchId }),
    ...(lineageInput.forkBoundary === undefined ? {} : { forkBoundary: lineageInput.forkBoundary }),
    ...(lineageInput.derivedFromRunId === undefined ? {} : { derivedFromRunId: lineageInput.derivedFromRunId }),
    operation: lineageInput.operation ?? "original",
  } satisfies RequestInspectorProjection["lineage"];

  return Object.freeze({
    schemaVersion: 1,
    requestId,
    scope: Object.freeze({
      profileId: nonBlank(scope.profileId, "profile ID"),
      ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
      conversationId: nonBlank(scope.conversationId, "conversation ID"),
      branchId: nonBlank(scope.branchId, "branch ID"),
      runId,
      ...(scope.iterationId === undefined ? {} : { iterationId: scope.iterationId }),
      attemptId,
      ...(scope.itemId === undefined ? {} : { itemId: scope.itemId }),
    }),
    message: Object.freeze({ ...(input.message ?? {}) }),
    route: Object.freeze({
      ...(route.requestedProvider === undefined ? {} : { requestedProvider: route.requestedProvider }),
      resolvedProvider: nonBlank(scope.providerConnectionId, "provider connection ID"),
      ...(route.providerConnectionRevision === undefined ? {} : { providerConnectionRevision: route.providerConnectionRevision }),
      ...(route.adapterId === undefined ? {} : { adapterId: route.adapterId }),
      ...(route.adapterVersion === undefined ? {} : { adapterVersion: route.adapterVersion }),
      ...(route.requestedModel === undefined ? {} : { requestedModel: route.requestedModel }),
      resolvedModel: nonBlank(scope.providerModelId, "provider model ID"),
      ...(route.modelProfileRevision === undefined ? {} : { modelProfileRevision: route.modelProfileRevision }),
      ...(route.catalogSnapshotId === undefined ? {} : { catalogSnapshotId: route.catalogSnapshotId }),
      ...(route.capabilitySnapshotHash === undefined ? {} : { capabilitySnapshotHash: route.capabilitySnapshotHash }),
      ...(route.requestedEffort === undefined ? {} : { requestedEffort: route.requestedEffort }),
      ...(route.resolvedEffort === undefined ? {} : { resolvedEffort: route.resolvedEffort }),
      ...(route.parameterSnapshotHash === undefined ? {} : { parameterSnapshotHash: route.parameterSnapshotHash }),
      ...(route.routePlanRevision === undefined ? {} : { routePlanRevision: route.routePlanRevision }),
      ...(route.serviceTier === undefined ? {} : { serviceTier: route.serviceTier }),
      ...(route.endpointAlias === undefined ? {} : { endpointAlias: route.endpointAlias }),
      compatibilityWarnings: Object.freeze([...(route.compatibilityWarnings ?? [])]),
    }),
    status: Object.freeze({
      logicalRun,
      attempt: attemptStatusForOutcome(record.outcome, record.acceptedByProvider),
      ...(terminalReason === undefined ? {} : { terminalReason }),
      dataQuality: quality,
    }),
    timing: Object.freeze(projectedTiming),
    usage,
    throughput: Object.freeze({
      ...(timingProjection?.visibleTokensPerSecond === null || timingProjection?.visibleTokensPerSecond === undefined
        ? {}
        : { visibleTokensPerSecond: timingProjection.visibleTokensPerSecond }),
      ...(endToEndTokensPerSecond === undefined ? {} : { endToEndTokensPerSecond }),
      formulaVersion: "visible-generation-v1",
    }),
    quota: Object.freeze({ windows: Object.freeze([...(input.quotaWindows ?? [])]) }),
    cost: Object.freeze(projectedCost),
    retry: Object.freeze({
      attempts: Object.freeze([...(input.retry?.attempts ?? [{
        attemptId,
        status: attemptStatusForOutcome(record.outcome, record.acceptedByProvider),
        acceptance: record.acceptedByProvider === true
          ? "accepted"
          : record.acceptedByProvider === false
            ? "rejected"
            : "unknown",
        ...(record.dispatchStartedAt === undefined ? {} : { startedAt: record.dispatchStartedAt }),
        ...(attemptTerminalAt === undefined ? {} : { terminalAt: attemptTerminalAt }),
      }])]),
      ...(input.retry?.nextRetryAt === undefined ? {} : { nextRetryAt: input.retry.nextRetryAt }),
      ...(input.retry?.retryWindowEndsAt === undefined ? {} : { retryWindowEndsAt: input.retry.retryWindowEndsAt }),
      ...(input.retry?.fallbackSelected === undefined ? {} : { fallbackSelected: input.retry.fallbackSelected }),
    }),
    context: Object.freeze(projectedContext),
    lineage: Object.freeze(projectedLineage),
  });
}

export type { AttemptId, ModelProfileId, ProviderConnectionId, RunId };
