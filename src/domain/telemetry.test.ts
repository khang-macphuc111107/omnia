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
  appendUsageLedgerEntry,
  createAttemptTimingSample,
  createHarnessOperationObservation,
  createProviderHealthObservation,
  createTelemetryPolicy,
  createUsageLedger,
  projectAttemptLatency,
  projectProviderHealth,
  projectUsage,
  type PendingUsageLedgerEntry,
  type TelemetryObservationId,
  type TelemetryScope,
  type UsageLedgerEntryId,
} from "./telemetry";

const id = <T extends string>(value: string) => value as T;
const profileId = id<ProfileId>("profile_01");
const providerConnectionId = id<ProviderConnectionId>("provider_01");
const modelProfileId = id<ModelProfileId>("model_01");
const conversationId = id<ConversationId>("conversation_01");
const branchId = id<BranchId>("branch_01");
const runId = id<RunId>("run_01");
const attemptId = id<AttemptId>("attempt_01");
const t0 = "2026-08-13T00:00:00.000Z";
const t1 = "2026-08-13T00:00:01.000Z";
const t2 = "2026-08-13T00:00:02.000Z";
const hash = (character: string): string => character.repeat(64);

type UsageEntryOverrides = {
  readonly [Key in keyof PendingUsageLedgerEntry]?: PendingUsageLedgerEntry[Key] | undefined;
};

const attemptScope: TelemetryScope = {
  profileId,
  conversationId,
  branchId,
  runId,
  attemptId,
  providerConnectionId,
  modelProfileId,
  providerModelId: "omni-model",
};

function usageEntry(
  entryId: string,
  input: UsageEntryOverrides = {},
): PendingUsageLedgerEntry {
  return Object.fromEntries(Object.entries({
    id: id<UsageLedgerEntryId>(entryId),
    scope: attemptScope,
    source: "provider-final",
    authoritative: true,
    coverage: "complete",
    observedAt: t1,
    responseIdentityHash: hash("a"),
    counters: { inputTokens: 100, outputTokens: 20 },
    ...input,
  }).filter(([, value]) => value !== undefined)) as unknown as PendingUsageLedgerEntry;
}

describe("telemetry architecture contracts", () => {
  it("separates first provider output, reasoning, visible output, and complete-item latency", () => {
    const sample = createAttemptTimingSample({
      id: id<TelemetryObservationId>("timing_01"),
      scope: attemptScope,
      clockDomainId: "native-boot-01",
      originAt: t0,
      observedAt: t1,
      coverage: "complete",
      marks: {
        dispatchStartedMs: 100,
        requestCommittedMs: 120,
        firstByteMs: 150,
        firstProviderOutputMs: 180,
        firstReasoningMs: 180,
        firstVisibleOutputMs: 420,
        firstCompleteItemMs: 900,
        lastVisibleOutputMs: 1_420,
        terminalMs: 1_500,
      },
      waits: { queueMs: 25, approvalWaitMs: 0 },
    });
    const projection = projectAttemptLatency(sample, 50);

    expect(projection.timeToFirstProviderOutputMs).toBe(80);
    expect(projection.timeToFirstReasoningMs).toBe(80);
    expect(projection.timeToFirstVisibleOutputMs).toBe(320);
    expect(projection.timeToFirstCompleteItemMs).toBe(800);
    expect(projection.totalAttemptMs).toBe(1_400);
    expect(projection.visibleTokensPerSecond).toBe(50);
  });

  it("rejects impossible timing order instead of emitting negative latency", () => {
    expect(() =>
      createAttemptTimingSample({
        id: id<TelemetryObservationId>("timing_02"),
        scope: attemptScope,
        clockDomainId: "native-boot-01",
        originAt: t0,
        observedAt: t1,
        coverage: "partial",
        marks: {
          dispatchStartedMs: 100,
          firstByteMs: 300,
          firstVisibleOutputMs: 250,
        },
      }),
    ).toThrowError(DomainError);
  });

  it("keeps provisional and final usage immutable and accepts a lower provider correction", () => {
    const empty = createUsageLedger(runId);
    const provisional = appendUsageLedgerEntry(
      empty,
      usageEntry("usage_01", {
        source: "provider-incremental",
        authoritative: false,
        coverage: "partial",
        counters: { inputTokens: 120, outputTokens: 24 },
      }),
    );
    const final = appendUsageLedgerEntry(
      provisional,
      usageEntry("usage_02", {
        observedAt: t2,
        supersedesEntryId: id<UsageLedgerEntryId>("usage_01"),
        counters: {
          inputTokens: 100,
          cacheReadInputTokens: 40,
          outputTokens: 20,
          reasoningTokens: 8,
          visibleOutputTokens: 12,
        },
      }),
    );
    const projection = projectUsage(final, attemptId);

    expect(final.entries).toHaveLength(2);
    expect(final.entries[0]?.counters?.inputTokens).toBe(120);
    expect(projection.counters?.inputTokens).toBe(100);
    expect(projection.counters?.visibleOutputTokens).toBe(12);
    expect(projection.source).toBe("provider-final");
    expect(projection.authoritative).toBe(true);
  });

  it("replays an identical provider event idempotently and rejects fact drift", () => {
    const first = appendUsageLedgerEntry(createUsageLedger(runId), usageEntry("usage_01"));
    const replay = appendUsageLedgerEntry(first, usageEntry("usage_02"));

    expect(replay).toBe(first);
    expect(replay.entries).toHaveLength(1);

    expect(() =>
      appendUsageLedgerEntry(
        first,
        usageEntry("usage_03", {
          counters: { inputTokens: 101, outputTokens: 20 },
        }),
      ),
    ).toThrowError(DomainError);
  });

  it("keeps estimated, reported, and invoiced costs as distinct provenance layers", () => {
    let ledger = createUsageLedger(runId);
    ledger = appendUsageLedgerEntry(
      ledger,
      usageEntry("usage_01", {
        source: "local-estimate",
        authoritative: false,
        responseIdentityHash: undefined,
        costs: [
          {
            kind: "calculated-estimate",
            component: "model tokens",
            amountMicrounits: 130,
            currency: "USD",
            priceSnapshotId: "price-2026-08-13",
            priceSnapshotHash: hash("b"),
            formulaVersion: "cost-v1",
          },
        ],
      }),
    );
    ledger = appendUsageLedgerEntry(
      ledger,
      usageEntry("usage_02", {
        observedAt: t2,
        costs: [
          {
            kind: "provider-reported",
            component: "model tokens",
            amountMicrounits: 125,
            currency: "USD",
          },
        ],
      }),
    );

    expect(projectUsage(ledger, attemptId).costs.map((cost) => cost.kind)).toEqual([
      "calculated-estimate",
      "provider-reported",
    ]);
  });

  it("rejects estimated cost without a frozen price/formula receipt", () => {
    expect(() =>
      appendUsageLedgerEntry(
        createUsageLedger(runId),
        usageEntry("usage_01", {
          source: "local-estimate",
          authoritative: false,
          responseIdentityHash: "",
          costs: [
            {
              kind: "calculated-estimate",
              component: "model tokens",
              amountMicrounits: 130,
              currency: "USD",
            },
          ],
        }),
      ),
    ).toThrowError(DomainError);
  });

  it("requires provider usage to bind to one attempt and a hashed response identity", () => {
    expect(() =>
      appendUsageLedgerEntry(
        createUsageLedger(runId),
        usageEntry("usage_01", { responseIdentityHash: "" }),
      ),
    ).toThrowError(DomainError);

    const { attemptId: omittedAttemptId, ...scopeWithoutAttempt } = attemptScope;
    void omittedAttemptId;
    expect(() =>
      appendUsageLedgerEntry(
        createUsageLedger(runId),
        usageEntry("usage_02", {
          scope: scopeWithoutAttempt,
        }),
      ),
    ).toThrowError(DomainError);
  });

  it("retains only provider-qualified numeric counters", () => {
    expect(() =>
      appendUsageLedgerEntry(
        createUsageLedger(runId),
        usageEntry("usage_01", {
          providerCounters: { prompt_tokens: 12 },
        }),
      ),
    ).toThrowError(DomainError);

    const ledger = appendUsageLedgerEntry(
      createUsageLedger(runId),
      usageEntry("usage_02", {
        providerCounters: { "openai.prompt_tokens": 12 },
      }),
    );
    expect(ledger.entries[0]?.providerCounters).toEqual({ "openai.prompt_tokens": 12 });
  });

  it("classifies auth failure independently from rate limits and latency", () => {
    const authFailure = createProviderHealthObservation({
      id: id<TelemetryObservationId>("health_01"),
      scope: { profileId, providerConnectionId, modelProfileId },
      dimension: "authentication",
      outcome: "fail",
      errorClass: "authentication",
      observedAt: t1,
      diagnosticCode: "credential-rejected",
    });
    const rateLimit = createProviderHealthObservation({
      id: id<TelemetryObservationId>("health_02"),
      scope: { profileId, providerConnectionId, modelProfileId },
      dimension: "rate-limit",
      outcome: "degraded",
      errorClass: "rate-limit",
      latencyMs: 180,
      observedAt: t2,
      quota: {
        kind: "requests",
        limit: 60,
        remaining: 4,
        windowSeconds: 60,
        source: "provider-header",
        authoritative: true,
      },
    });
    const projection = projectProviderHealth(
      [authFailure, rateLimit],
      providerConnectionId,
      modelProfileId,
      {
        now: t2,
        freshnessMs: 5_000,
        minimumSamples: 1,
        degradedFailureRate: 0.1,
        unavailableFailureRate: 0.7,
      },
    );

    expect(projection.state).toBe("unavailable");
    expect(projection.latestByDimension.authentication).toBe("fail");
    expect(projection.latestByDimension["rate-limit"]).toBe("degraded");
    expect(projection.quotas[0]?.remaining).toBe(4);
  });

  it("rejects arbitrary runtime provider error classes", () => {
    expect(() =>
      createProviderHealthObservation({
        id: id<TelemetryObservationId>("health_invalid_class"),
        scope: { profileId, providerConnectionId, modelProfileId },
        dimension: "transport",
        outcome: "fail",
        errorClass: "provider-owned-upstream-code" as never,
        observedAt: t1,
      }),
    ).toThrowError(DomainError);
  });

  it("allows a newer critical-dimension pass to recover availability", () => {
    const authFailure = createProviderHealthObservation({
      id: id<TelemetryObservationId>("health_recovery_fail"),
      scope: { profileId, providerConnectionId, modelProfileId },
      dimension: "authentication",
      outcome: "fail",
      errorClass: "authentication",
      observedAt: t1,
    });
    const authRecovery = createProviderHealthObservation({
      id: id<TelemetryObservationId>("health_recovery_pass"),
      scope: { profileId, providerConnectionId, modelProfileId },
      dimension: "authentication",
      outcome: "pass",
      observedAt: t2,
    });

    const projection = projectProviderHealth(
      [authFailure, authRecovery],
      providerConnectionId,
      modelProfileId,
      {
        now: t2,
        freshnessMs: 5_000,
        minimumSamples: 1,
        degradedFailureRate: 0.6,
        unavailableFailureRate: 0.7,
      },
    );

    expect(projection.latestByDimension.authentication).toBe("pass");
    expect(projection.state).toBe("healthy");
  });

  it("returns unknown for stale or statistically insufficient provider health", () => {
    const observation = createProviderHealthObservation({
      id: id<TelemetryObservationId>("health_01"),
      scope: { profileId, providerConnectionId },
      dimension: "transport",
      outcome: "pass",
      observedAt: t0,
    });
    const projection = projectProviderHealth(
      [observation],
      providerConnectionId,
      null,
      {
        now: t2,
        freshnessMs: 500,
        minimumSamples: 2,
        degradedFailureRate: 0.1,
        unavailableFailureRate: 0.5,
      },
    );
    expect(projection.state).toBe("unknown");
    expect(projection.successRate).toBeNull();
  });

  it("captures tool/subagent efficiency without accepting impossible wait durations", () => {
    const observation = createHarnessOperationObservation({
      id: id<TelemetryObservationId>("operation_01"),
      scope: attemptScope,
      kind: "tool-call",
      operationName: "workspace.search",
      outcome: "succeeded",
      startedAt: t1,
      durationMs: 200,
      queueMs: 20,
      inputItems: 1,
      outputItems: 8,
      outputBytes: 2_048,
      cache: "miss",
      verification: "passed",
      details: { resultClass: "source-matches" },
    });
    expect(observation.outputItems).toBe(8);
    expect(Object.isFrozen(observation.details)).toBe(true);

    expect(() =>
      createHarnessOperationObservation({
        ...observation,
        id: id<TelemetryObservationId>("operation_02"),
        durationMs: 100,
        approvalWaitMs: 101,
      }),
    ).toThrowError(DomainError);
  });

  it("keeps v1 telemetry content-free and local-first by construction", () => {
    const policy = createTelemetryPolicy({
      collection: "local",
      remoteExport: "operational",
      retainRawDays: 30,
      retainAggregateDays: 365,
      includeProviderNumericCounters: true,
    });
    expect(policy.includePromptContent).toBe(false);
    expect(policy.includeResponseContent).toBe(false);
    expect(policy.includeReasoningContent).toBe(false);
    expect(policy.includeToolPayloads).toBe(false);

    expect(() =>
      createTelemetryPolicy({
        collection: "off",
        remoteExport: "diagnostic",
        retainRawDays: 0,
        retainAggregateDays: 0,
        includeProviderNumericCounters: false,
      }),
    ).toThrowError(DomainError);
  });
});
