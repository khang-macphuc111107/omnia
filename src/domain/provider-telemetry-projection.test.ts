import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import type {
  AttemptId,
  BranchId,
  ConversationId,
  ModelProfileId,
  ProfileId,
  ProviderConnectionId,
  RunId,
} from "./ids";
import {
  createProviderAttemptTelemetryRecord,
  projectProviderTelemetry,
  type ProviderAttemptTelemetryOutcome,
} from "./provider-telemetry-projection";
import {
  appendUsageLedgerEntry,
  createAttemptTimingSample,
  createProviderHealthObservation,
  createUsageLedger,
  type TelemetryObservationId,
  type TelemetryScope,
  type UsageLedgerEntryId,
} from "./telemetry";

const id = <T extends string>(value: string) => value as T;
const profileId = id<ProfileId>("profile_01");
const providerId = id<ProviderConnectionId>("provider_01");
const otherProviderId = id<ProviderConnectionId>("provider_02");
const modelId = id<ModelProfileId>("model_01");
const otherModelId = id<ModelProfileId>("model_02");
const conversationId = id<ConversationId>("conversation_01");
const branchId = id<BranchId>("branch_01");
const hash = (character: string): string => character.repeat(64);

function scope(
  attempt: number,
  options: {
    readonly providerConnectionId?: ProviderConnectionId;
    readonly modelProfileId?: ModelProfileId;
    readonly providerModelId?: string;
  } = {},
): TelemetryScope {
  return {
    profileId,
    conversationId,
    branchId,
    runId: id<RunId>(`run_${attempt}`),
    attemptId: id<AttemptId>(`attempt_${attempt}`),
    providerConnectionId: options.providerConnectionId ?? providerId,
    modelProfileId: options.modelProfileId ?? modelId,
    providerModelId: options.providerModelId ?? "omnia-model",
  };
}

function usageLedger(
  attemptScope: TelemetryScope,
  counters: {
    readonly inputTokens?: number;
    readonly cacheReadInputTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningTokens?: number;
    readonly visibleOutputTokens?: number;
  },
  costs: readonly {
    readonly kind: "calculated-estimate" | "provider-reported" | "invoice" | "user-override";
    readonly amountMicrounits: number;
    readonly priceSnapshotId?: string;
    readonly priceSnapshotHash?: string;
    readonly formulaVersion?: string;
  }[] = [],
) {
  const attempt = Number(attemptScope.attemptId?.split("_").at(-1) ?? 0);
  let ledger = createUsageLedger(attemptScope.runId!);
  ledger = appendUsageLedgerEntry(ledger, {
    id: id<UsageLedgerEntryId>(`usage_${attempt}_final`),
    scope: attemptScope,
    source: "provider-final",
    authoritative: true,
    coverage: "complete",
    observedAt: `2026-08-13T00:01:${String(attempt).padStart(2, "0")}.000Z`,
    responseIdentityHash: hash(String(attempt)),
    counters,
    costs: costs.map((cost) => ({
      ...cost,
      component: "model tokens",
      currency: "USD",
    })),
  });
  return ledger;
}

function record(
  attempt: number,
  options: {
    readonly dispatchStartedAt?: string;
    readonly outcome?: ProviderAttemptTelemetryOutcome;
    readonly acceptedByProvider?: boolean | "unknown";
    readonly ttftMs?: number;
    readonly totalMs?: number;
    readonly visibleGenerationMs?: number;
    readonly counters?: {
      readonly inputTokens?: number;
      readonly cacheReadInputTokens?: number;
      readonly outputTokens?: number;
      readonly reasoningTokens?: number;
      readonly visibleOutputTokens?: number;
    };
    readonly providerConnectionId?: ProviderConnectionId;
    readonly modelProfileId?: ModelProfileId;
    readonly providerModelId?: string;
  } = {},
) {
  const attemptScope = scope(attempt, options);
  const dispatchStartedAt =
    options.dispatchStartedAt ?? `2026-08-13T00:00:${String(attempt * 10).padStart(2, "0")}.000Z`;
  const ttftMs = options.ttftMs ?? 200;
  const visibleGenerationMs = options.visibleGenerationMs ?? 1_000;
  const totalMs = options.totalMs ?? ttftMs + visibleGenerationMs + 100;
  const timing = createAttemptTimingSample({
    id: id<TelemetryObservationId>(`timing_${attempt}`),
    scope: attemptScope,
    clockDomainId: "native-boot-01",
    originAt: dispatchStartedAt,
    observedAt: "2026-08-13T00:01:50.000Z",
    coverage: "complete",
    marks: {
      dispatchStartedMs: 0,
      requestCommittedMs: 10,
      firstByteMs: 50,
      firstProviderOutputMs: 100,
      firstReasoningMs: 100,
      firstVisibleOutputMs: ttftMs,
      firstCompleteItemMs: ttftMs + 100,
      lastVisibleOutputMs: ttftMs + visibleGenerationMs,
      terminalMs: totalMs,
    },
  });
  return createProviderAttemptTelemetryRecord({
    scope: attemptScope,
    dispatchStartedAt,
    outcome: options.outcome ?? "completed",
    acceptedByProvider: options.acceptedByProvider ?? true,
    timing,
    usageLedger: usageLedger(
      attemptScope,
      options.counters ?? {
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 8,
        visibleOutputTokens: 10,
      },
    ),
  });
}

const policy = {
  now: "2026-08-13T00:02:00.000Z",
  windowMs: 120_000,
  health: {
    freshnessMs: 60_000,
    minimumSamples: 1,
    degradedFailureRate: 0.2,
    unavailableFailureRate: 0.7,
  },
} as const;

describe("provider telemetry projection", () => {
  it("projects fixed-window RPM, token rates, latency distributions, and visible throughput", () => {
    const projection = projectProviderTelemetry({
      providerConnectionId: providerId,
      modelProfileId: modelId,
      attemptCollectionCoverage: "complete",
      attempts: [
        record(1, {
          ttftMs: 200,
          visibleGenerationMs: 1_000,
          counters: {
            inputTokens: 100,
            cacheReadInputTokens: 40,
            outputTokens: 20,
            reasoningTokens: 8,
            visibleOutputTokens: 10,
          },
        }),
        record(2, {
          ttftMs: 400,
          visibleGenerationMs: 2_000,
          counters: {
            inputTokens: 300,
            cacheReadInputTokens: 60,
            outputTokens: 60,
            reasoningTokens: 20,
            visibleOutputTokens: 30,
          },
        }),
      ],
      healthObservations: [],
      policy,
    });

    expect(projection.activity.attemptsPerMinute).toBe(1);
    expect(projection.activity.providerRequestsObserved).toBe(2);
    expect(projection.activity.observedRequestsPerMinute).toBe(1);
    expect(projection.activity.requestRateCoverage.status).toBe("complete");
    expect(projection.activity.definitiveCompletionRate).toBe(1);
    expect(projection.tokens.inputTokens.observed).toBe(400);
    expect(projection.tokens.inputTokens.averagePerSample).toBe(200);
    expect(projection.tokens.inputTokens.perMinute).toBe(200);
    expect(projection.tokens.outputTokens.perMinute).toBe(40);
    expect(projection.tokens.reasoningTokens.observed).toBe(28);
    expect(projection.tokens.cacheReadInputTokens.observed).toBe(100);
    expect(projection.latency.timeToFirstVisibleOutputMs.mean).toBe(300);
    expect(projection.latency.timeToFirstVisibleOutputMs.p50).toBe(200);
    expect(projection.latency.timeToFirstVisibleOutputMs.p95).toBe(400);
    expect(projection.latency.visibleTokensPerSecond.mean).toBe(12.5);
    expect(projection.health.state).toBe("unknown");
  });

  it("keeps provider probes separate from operational attempt outcomes", () => {
    const health = createProviderHealthObservation({
      id: id<TelemetryObservationId>("health_01"),
      scope: { profileId, providerConnectionId: providerId, modelProfileId: modelId },
      dimension: "streaming",
      outcome: "pass",
      latencyMs: 80,
      observedAt: "2026-08-13T00:01:55.000Z",
    });
    const projection = projectProviderTelemetry({
      providerConnectionId: providerId,
      modelProfileId: modelId,
      attemptCollectionCoverage: "complete",
      attempts: [record(1)],
      healthObservations: [health],
      policy,
    });

    expect(projection.health.state).toBe("healthy");
    expect(projection.health.latencyP50Ms).toBe(80);
    expect(projection.activity.latestAttempt?.outcome).toBe("completed");
  });

  it("does not count outcome-unknown as a definitive provider failure", () => {
    const ambiguous = record(1, {
      outcome: "outcome-unknown",
      acceptedByProvider: "unknown",
    });
    const projection = projectProviderTelemetry({
      providerConnectionId: providerId,
      modelProfileId: modelId,
      attemptCollectionCoverage: "complete",
      attempts: [ambiguous],
      healthObservations: [],
      policy,
    });

    expect(projection.activity.outcomeUnknown).toBe(1);
    expect(projection.activity.failed).toBe(0);
    expect(projection.activity.definitiveCompletionRate).toBeNull();
    expect(projection.activity.acceptanceUnknown).toBe(1);
  });

  it("keeps cost provenance layers but selects one effective charge per component", () => {
    const attemptScope = scope(1);
    let ledger = createUsageLedger(attemptScope.runId!);
    ledger = appendUsageLedgerEntry(ledger, {
      id: id<UsageLedgerEntryId>("usage_estimate"),
      scope: attemptScope,
      source: "local-estimate",
      authoritative: false,
      coverage: "estimated",
      observedAt: "2026-08-13T00:00:20.000Z",
      counters: { inputTokens: 100, outputTokens: 20 },
      costs: [
        {
          kind: "calculated-estimate",
          component: "model tokens",
          amountMicrounits: 130,
          currency: "USD",
          priceSnapshotId: "prices-v1",
          priceSnapshotHash: hash("a"),
          formulaVersion: "cost-v1",
        },
      ],
    });
    ledger = appendUsageLedgerEntry(ledger, {
      id: id<UsageLedgerEntryId>("usage_reported"),
      scope: attemptScope,
      source: "provider-final",
      authoritative: true,
      coverage: "complete",
      observedAt: "2026-08-13T00:00:30.000Z",
      responseIdentityHash: hash("b"),
      counters: { inputTokens: 100, outputTokens: 20 },
      costs: [
        {
          kind: "provider-reported",
          component: "reported model tokens",
          amountMicrounits: 125,
          currency: "USD",
        },
      ],
    });
    ledger = appendUsageLedgerEntry(ledger, {
      id: id<UsageLedgerEntryId>("usage_invoice"),
      scope: attemptScope,
      source: "provider-invoice",
      authoritative: true,
      coverage: "complete",
      observedAt: "2026-08-13T00:01:00.000Z",
      responseIdentityHash: hash("c"),
      costs: [
        {
          kind: "invoice",
          component: "model tokens",
          amountMicrounits: 123,
          currency: "USD",
        },
      ],
    });
    const base = record(1);
    const projection = projectProviderTelemetry({
      providerConnectionId: providerId,
      modelProfileId: modelId,
      attemptCollectionCoverage: "complete",
      attempts: [createProviderAttemptTelemetryRecord({ ...base, usageLedger: ledger })],
      healthObservations: [],
      policy,
    });

    expect(projection.costs[0]?.effectiveAmountMicrounits).toBe(123);
    expect(projection.costs[0]?.effectiveKindCounts.invoice).toBe(1);
    expect(projection.costs[0]?.layers.map((layer) => [layer.kind, layer.amountMicrounits])).toEqual([
      ["calculated-estimate", 130],
      ["provider-reported", 125],
      ["invoice", 123],
    ]);
  });

  it("reports missing counters as partial coverage rather than fabricated zero", () => {
    const projection = projectProviderTelemetry({
      providerConnectionId: providerId,
      modelProfileId: modelId,
      attemptCollectionCoverage: "complete",
      attempts: [record(1, { counters: { inputTokens: 100 } }), record(2)],
      healthObservations: [],
      policy,
    });

    expect(projection.tokens.cacheReadInputTokens.observed).toBeNull();
    expect(projection.tokens.cacheReadInputTokens.perMinute).toBeNull();
    expect(projection.tokens.cacheReadInputTokens.coverage.status).toBe("partial");
    expect(projection.tokens.cacheReadInputTokens.coverage.unknownSamples).toBe(2);
  });

  it("propagates estimated usage coverage into visible-throughput coverage", () => {
    const attemptScope = scope(1);
    let ledger = createUsageLedger(attemptScope.runId!);
    ledger = appendUsageLedgerEntry(ledger, {
      id: id<UsageLedgerEntryId>("usage_estimated"),
      scope: attemptScope,
      source: "local-estimate",
      authoritative: false,
      coverage: "estimated",
      observedAt: "2026-08-13T00:00:30.000Z",
      counters: { visibleOutputTokens: 10 },
    });
    const base = record(1);
    const projection = projectProviderTelemetry({
      providerConnectionId: providerId,
      modelProfileId: modelId,
      attemptCollectionCoverage: "complete",
      attempts: [createProviderAttemptTelemetryRecord({ ...base, usageLedger: ledger })],
      healthObservations: [],
      policy,
    });

    expect(projection.latency.visibleTokensPerSecond.mean).toBe(10);
    expect(projection.latency.visibleTokensPerSecond.coverage.status).toBe("estimated");
  });

  it("does not call an attempt provider RPM without request evidence", () => {
    const base = record(1, { outcome: "failed", acceptedByProvider: false });
    const noRequestEvidence = createProviderAttemptTelemetryRecord({
      scope: base.scope,
      dispatchStartedAt: base.dispatchStartedAt,
      outcome: base.outcome,
      acceptedByProvider: base.acceptedByProvider,
    });
    const projection = projectProviderTelemetry({
      providerConnectionId: providerId,
      modelProfileId: modelId,
      attemptCollectionCoverage: "complete",
      attempts: [noRequestEvidence],
      healthObservations: [],
      policy,
    });

    expect(projection.activity.attemptsPerMinute).toBe(0.5);
    expect(projection.activity.providerRequestsObserved).toBe(0);
    expect(projection.activity.observedRequestsPerMinute).toBeNull();
    expect(projection.activity.requestRateCoverage.status).toBe("partial");
  });

  it("filters by exact provider, model, and fixed time window", () => {
    const projection = projectProviderTelemetry({
      providerConnectionId: providerId,
      modelProfileId: modelId,
      attemptCollectionCoverage: "complete",
      attempts: [
        record(1),
        record(2, { providerConnectionId: otherProviderId }),
        record(3, { modelProfileId: otherModelId, providerModelId: "other-model" }),
        record(4, { dispatchStartedAt: "2026-08-12T23:59:00.000Z" }),
      ],
      healthObservations: [],
      policy,
    });

    expect(projection.activity.observedAttempts).toBe(1);
    expect(projection.providerModelIds).toEqual(["omnia-model"]);
    expect(projection.activity.latestAttempt?.attemptId).toBe("attempt_1");
  });

  it("rejects mismatched timing, ledger lineage, and impossible acceptance claims", () => {
    const attemptScope = scope(1);
    const foreignTiming = createAttemptTimingSample({
      id: id<TelemetryObservationId>("timing_foreign"),
      scope: scope(2),
      clockDomainId: "native-boot-01",
      originAt: "2026-08-13T00:00:10.000Z",
      observedAt: "2026-08-13T00:00:20.000Z",
      coverage: "partial",
      marks: { dispatchStartedMs: 0 },
    });
    expect(() =>
      createProviderAttemptTelemetryRecord({
        scope: attemptScope,
        dispatchStartedAt: "2026-08-13T00:00:10.000Z",
        outcome: "failed",
        acceptedByProvider: false,
        timing: foreignTiming,
      }),
    ).toThrowError(DomainError);

    expect(() =>
      createProviderAttemptTelemetryRecord({
        scope: attemptScope,
        dispatchStartedAt: "2026-08-13T00:00:10.000Z",
        outcome: "completed",
        acceptedByProvider: "unknown",
      }),
    ).toThrowError(DomainError);

    expect(() =>
      createProviderAttemptTelemetryRecord({
        scope: attemptScope,
        dispatchStartedAt: "2026-08-13T00:00:10.000Z",
        outcome: "outcome-unknown",
        acceptedByProvider: false,
      }),
    ).toThrowError(DomainError);

    expect(() =>
      createProviderAttemptTelemetryRecord({
        scope: { ...attemptScope, providerModelId: "model\nsecret" },
        dispatchStartedAt: "2026-08-13T00:00:10.000Z",
        outcome: "failed",
        acceptedByProvider: false,
      }),
    ).toThrowError(DomainError);
  });

  it("rejects duplicate attempt records before they can double-count usage or cost", () => {
    const duplicate = record(1);
    expect(() =>
      projectProviderTelemetry({
        providerConnectionId: providerId,
        modelProfileId: modelId,
        attemptCollectionCoverage: "complete",
        attempts: [duplicate, duplicate],
        healthObservations: [],
        policy,
      }),
    ).toThrowError(DomainError);
  });
});
