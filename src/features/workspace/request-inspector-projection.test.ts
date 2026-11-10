import { describe, expect, it } from "vitest";

import type {
  AttemptId,
  BranchId,
  ConversationId,
  ModelProfileId,
  ProfileId,
  ProviderConnectionId,
  RunId,
} from "@/domain/ids";
import {
  appendUsageLedgerEntry,
  createAttemptTimingSample,
  createProviderAttemptTelemetryRecord,
  createUsageLedger,
  type TelemetryObservationId,
  type TelemetryScope,
  type UsageLedgerEntryId,
} from "@/domain";

import { projectRequestInspector } from "./request-inspector-projection";

const id = <T extends string>(value: string) => value as T;
const profileId = id<ProfileId>("profile_01");
const providerConnectionId = id<ProviderConnectionId>("provider_01");
const modelProfileId = id<ModelProfileId>("model_profile_01");
const conversationId = id<ConversationId>("conversation_01");
const branchId = id<BranchId>("branch_01");

function scope(attempt: number, providerModelId = "model-x"): TelemetryScope {
  return {
    profileId,
    conversationId,
    branchId,
    runId: id<RunId>(`run_${attempt}`),
    attemptId: id<AttemptId>(`attempt_${attempt}`),
    providerConnectionId,
    modelProfileId,
    providerModelId,
  };
}

function record(
  attempt: number,
  options: {
    readonly counters?: {
      readonly inputTokens?: number;
      readonly cacheReadInputTokens?: number;
      readonly outputTokens?: number;
      readonly reasoningTokens?: number;
      readonly visibleOutputTokens?: number;
    };
    readonly providerCounters?: Readonly<Record<string, number>>;
    readonly coverage?: "complete" | "partial" | "estimated" | "unknown";
    readonly outcome?: "dispatching" | "streaming" | "completed" | "failed" | "cancelled" | "outcome-unknown";
    readonly acceptedByProvider?: boolean | "unknown";
    readonly costs?: readonly {
      readonly kind: "calculated-estimate" | "provider-reported" | "invoice" | "user-override";
      readonly amountMicrounits: number;
      readonly component?: string;
      readonly priceSnapshotId?: string;
      readonly priceSnapshotHash?: string;
      readonly formulaVersion?: string;
    }[];
    readonly withTiming?: boolean;
  } = {},
) {
  const attemptScope = scope(attempt);
  const dispatchStartedAt = `2026-08-13T00:00:${String(attempt).padStart(2, "0")}.000Z`;
  let usageLedger = createUsageLedger(attemptScope.runId!);
  if (options.counters !== undefined || options.costs !== undefined) {
    usageLedger = appendUsageLedgerEntry(usageLedger, {
      id: id<UsageLedgerEntryId>(`usage_${attempt}`),
      scope: attemptScope,
      source: options.coverage === "estimated" ? "local-estimate" : "provider-final",
      authoritative: options.coverage !== "estimated",
      coverage: options.coverage ?? "complete",
      observedAt: "2026-08-13T00:00:30.000Z",
      ...(options.coverage === "estimated" ? {} : { responseIdentityHash: "a".repeat(64) }),
      ...(options.counters === undefined ? {} : { counters: options.counters }),
      ...(options.providerCounters === undefined ? {} : { providerCounters: options.providerCounters }),
      costs: (options.costs ?? []).map((cost) => ({
        kind: cost.kind,
        component: cost.component ?? "model tokens",
        amountMicrounits: cost.amountMicrounits,
        currency: "USD",
        ...(cost.priceSnapshotId === undefined ? {} : { priceSnapshotId: cost.priceSnapshotId }),
        ...(cost.priceSnapshotHash === undefined ? {} : { priceSnapshotHash: cost.priceSnapshotHash }),
        ...(cost.formulaVersion === undefined ? {} : { formulaVersion: cost.formulaVersion }),
      })),
    });
  }
  const timing = options.withTiming === false
    ? undefined
    : createAttemptTimingSample({
        id: id<TelemetryObservationId>(`timing_${attempt}`),
        scope: attemptScope,
        clockDomainId: "boot_01",
        originAt: dispatchStartedAt,
        observedAt: "2026-08-13T00:01:00.000Z",
        coverage: options.coverage ?? "complete",
        marks: {
          dispatchStartedMs: 0,
          requestCommittedMs: 20,
          firstByteMs: 50,
          firstProviderOutputMs: 100,
          firstReasoningMs: 120,
          firstVisibleOutputMs: 200,
          firstCompleteItemMs: 250,
          lastVisibleOutputMs: 1_200,
          terminalMs: 1_300,
        },
        waits: {
          queueMs: 10,
          contextCompileMs: 25,
          approvalWaitMs: 5,
          toolWaitMs: 8,
          providerBackoffMs: 3,
          rendererBackpressureMs: 2,
        },
      });
  return createProviderAttemptTelemetryRecord({
    scope: attemptScope,
    dispatchStartedAt,
    outcome: options.outcome ?? "completed",
    acceptedByProvider: options.acceptedByProvider ?? true,
    ...(timing === undefined ? {} : { timing }),
    ...(usageLedger.entries.length === 0 ? {} : { usageLedger }),
  });
}

describe("renderer request inspector projection", () => {
  it("uses monotonic timing and visible output for throughput", () => {
    const projection = projectRequestInspector({
      requestId: "request_01",
      record: record(1, {
        counters: {
          inputTokens: 100,
          cacheReadInputTokens: 25,
          outputTokens: 40,
          reasoningTokens: 30,
          visibleOutputTokens: 10,
        },
        providerCounters: { "provider.thinking_tokens": 30 },
      }),
      route: {
        requestedProvider: "Anthropic",
        requestedModel: "friendly-model",
        requestedEffort: "ultra",
        resolvedEffort: "max",
      },
      totalLogicalRunMs: 2_000,
    });

    expect(projection.status.logicalRun).toBe("completed");
    expect(projection.status.attempt).toBe("terminal");
    expect(projection.timing.timeToFirstReasoningMs).toBe(120);
    expect(projection.timing.timeToFirstVisibleOutputMs).toBe(200);
    expect(projection.timing.visibleGenerationMs).toBe(1_000);
    expect(projection.throughput.visibleTokensPerSecond).toBe(10);
    expect(projection.throughput.endToEndTokensPerSecond).toBe(5);
    expect(projection.usage.reasoningTokens).toBe(30);
    expect(projection.usage.visibleOutputTokens).toBe(10);
    expect(projection.usage.providerCounters["provider.thinking_tokens"]).toBe(30);
    expect(projection.usage.totalTokens).toBeUndefined();
    expect(projection.timing.queueMs).toBe(10);
    expect(projection.timing.terminalAt).toBe("2026-08-13T00:00:02.300Z");
  });

  it("keeps absent usage and context counts unknown instead of zero", () => {
    const projection = projectRequestInspector({
      requestId: "request_02",
      record: record(2, { withTiming: false }),
    });

    expect(projection.usage.source).toBe("unknown");
    expect(projection.usage.coverage).toBe("unknown");
    expect(projection.usage.inputTokens).toBeUndefined();
    expect(projection.usage.providerCounters).toEqual({});
    expect(projection.timing.timeToFirstByteMs).toBeUndefined();
    expect(projection.context.includedItems).toBeUndefined();
    expect(projection.context.omittedItems).toBeUndefined();
    expect(projection.status.dataQuality).toBe("unknown");
  });

  it("preserves estimated, reported, and invoice cost statements independently", () => {
    const projection = projectRequestInspector({
      requestId: "request_03",
      record: record(3, {
        counters: { inputTokens: 10, outputTokens: 2 },
        costs: [
          {
            kind: "calculated-estimate",
            amountMicrounits: 130,
            priceSnapshotId: "prices_v1",
            priceSnapshotHash: "b".repeat(64),
            formulaVersion: "formula_v1",
          },
          { kind: "provider-reported", amountMicrounits: 125 },
          { kind: "invoice", amountMicrounits: 123 },
        ],
      }),
    });

    expect(projection.cost.statements.map((statement) => statement.kind)).toEqual([
      "calculated-estimate",
      "provider-reported",
      "invoice",
    ]);
    expect(projection.cost.totalEstimatedMicrounits).toBe(130);
    expect(projection.cost.totalReportedMicrounits).toBe(125);
    expect(projection.cost.totalInvoiceMicrounits).toBe(123);
    expect(projection.cost.statements[0]?.priceSnapshotId).toBe("prices_v1");
  });

  it("keeps an ambiguous provider outcome visibly distinct from failure", () => {
    const projection = projectRequestInspector({
      requestId: "request_04",
      record: record(4, {
        outcome: "outcome-unknown",
        acceptedByProvider: "unknown",
        counters: { inputTokens: 5 },
        coverage: "partial",
      }),
    });

    expect(projection.status.logicalRun).toBe("outcome-unknown");
    expect(projection.status.attempt).toBe("outcome-unknown");
    expect(projection.status.terminalReason).toBe("outcome-unknown");
    expect(projection.retry.attempts[0]?.acceptance).toBe("unknown");
    expect(projection.status.dataQuality).toBe("partial");
  });

  it("does not derive an impossible uncached counter", () => {
    const projection = projectRequestInspector({
      requestId: "request_05",
      record: record(5, {
        counters: { inputTokens: 5, cacheReadInputTokens: 8 },
      }),
    });

    expect(projection.usage.inputTokens).toBe(5);
    expect(projection.usage.cacheReadInputTokens).toBe(8);
    expect(projection.usage.uncachedInputTokens).toBeUndefined();
  });
});
