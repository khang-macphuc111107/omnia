import { describe, expect, it } from "vitest";

import billingFixture from "./__fixtures__/provider-billing-reconciliation.v1.json";
import { DomainError } from "./errors";
import type { AttemptId, BranchId, ConversationId, ModelProfileId, ProfileId, ProviderConnectionId, RunId } from "./ids";
import {
  createProviderBillingReconciliation,
  reconcileProviderTelemetryBilling,
  type CreateProviderBillingReconciliationInput,
  type ExpectedProviderCharge,
  type ProviderInvoiceLine,
} from "./provider-billing-reconciliation";
import { createProviderAttemptTelemetryRecord } from "./provider-telemetry-projection";
import { appendUsageLedgerEntry, createUsageLedger, type TelemetryScope, type UsageLedgerEntryId } from "./telemetry";

const id = <T extends string>(value: string) => value as T;
const providerId = id<ProviderConnectionId>("provider_01");
const attemptId = id<AttemptId>("attempt_01");
const hash = (character: string) => character.repeat(64);
const observedAt = "2026-11-07T10:00:00.000Z";

function expected(amountMicrounits = 100): ExpectedProviderCharge {
  return {
    providerConnectionId: providerId,
    attemptId,
    responseIdentityHash: hash("a"),
    component: "model tokens",
    amountMicrounits,
    currency: "usd",
    source: "provider-reported",
    observedAt,
  };
}

function line(
  amountMicrounits = 100,
  overrides: Partial<Omit<ProviderInvoiceLine, "attemptId" | "responseIdentityHash">> & {
    readonly attemptId?: AttemptId | undefined;
    readonly responseIdentityHash?: string | undefined;
  } = {},
): ProviderInvoiceLine {
  const data = {
    lineIdHash: hash("b"),
    providerConnectionId: providerId,
    kind: "request",
    component: "model tokens",
    amountMicrounits,
    currency: "USD",
    attemptId,
    responseIdentityHash: hash("a"),
    observedAt,
    ...overrides,
  };
  return {
    lineIdHash: data.lineIdHash,
    providerConnectionId: data.providerConnectionId,
    kind: data.kind as ProviderInvoiceLine["kind"],
    component: data.component,
    amountMicrounits: data.amountMicrounits,
    currency: data.currency,
    observedAt: data.observedAt,
    ...(data.attemptId === undefined ? {} : { attemptId: data.attemptId }),
    ...(data.responseIdentityHash === undefined ? {} : { responseIdentityHash: data.responseIdentityHash }),
  };
}

describe("provider billing reconciliation", () => {
  it("replays a content-free deterministic invoice fixture without claiming live evidence", () => {
    const receipt = createProviderBillingReconciliation(
      billingFixture.input as unknown as CreateProviderBillingReconciliationInput,
    );
    expect(receipt.coverage).toBe(billingFixture.expected.coverage);
    expect(receipt.lines.map((entry) => entry.disposition)).toEqual(billingFixture.expected.dispositions);
    expect(receipt.totals).toEqual(billingFixture.expected.totals);
    expect(receipt.verification).toBe("local-reconciliation");
    expect(receipt.evidenceSource).toBe("sanitized-fixture");
    expect(receipt.lines[1]?.deltaMicrounits).toBe(-20);
    expect(receipt.lines[4]?.invoiceAmountMicrounits).toBe(-50);
    expect(JSON.stringify(receipt)).not.toMatch(/rawRequestId|accountId|apiKey|prompt|responseText/u);
  });

  it("matches a request invoice line by exact redacted identity and preserves an excluded tax line", () => {
    const receipt = createProviderBillingReconciliation({
      receiptId: "billing_receipt_01",
      providerConnectionId: providerId,
      currency: "USD",
      evidenceSource: "sanitized-fixture",
      invoiceIdHash: hash("c"),
      observedAt,
      invoiceLines: [line(), line(20, {
        lineIdHash: hash("d"),
        kind: "tax",
        component: "sales tax",
        attemptId: undefined,
        responseIdentityHash: undefined,
      })],
      expectedCharges: [expected()],
    });

    expect(receipt.coverage).toBe("complete");
    expect(receipt.totals).toMatchObject({
      invoiceMicrounits: 120,
      requestInvoiceMicrounits: 100,
      matchedMicrounits: 100,
      excludedMicrounits: 20,
      matchedLines: 1,
      excludedLines: 1,
      unmatchedExpectedCharges: 0,
    });
    expect(receipt.lines.map((entry) => entry.disposition)).toEqual(["matched", "excluded"]);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.lines)).toBe(true);
  });

  it("reports amount mismatches and unallocated lines without guessing by amount", () => {
    const receipt = createProviderBillingReconciliation({
      receiptId: "billing_receipt_02",
      providerConnectionId: providerId,
      currency: "USD",
      evidenceSource: "sanitized-fixture",
      invoiceIdHash: hash("e"),
      observedAt,
      invoiceLines: [
        line(125),
        line(90, {
          lineIdHash: hash("f"),
          responseIdentityHash: hash("9"),
        }),
        line(50, {
          lineIdHash: hash("0"),
          attemptId: undefined,
          responseIdentityHash: undefined,
        }),
      ],
      expectedCharges: [expected()],
    });

    expect(receipt.coverage).toBe("partial");
    expect(receipt.lines.map((entry) => entry.disposition)).toEqual([
      "amount-mismatch",
      "unallocated",
      "unallocated",
    ]);
    expect(receipt.lines[0]).toMatchObject({
      expectedAmountMicrounits: 100,
      invoiceAmountMicrounits: 125,
      deltaMicrounits: 25,
      reason: "amount-differs",
    });
    expect(receipt.totals.unallocatedMicrounits).toBe(140);
    expect(receipt.totals.unmatchedExpectedCharges).toBe(0);
  });

  it("rejects duplicate invoice identities, cross-provider charges and invalid hashes", () => {
    expect(() => createProviderBillingReconciliation({
      receiptId: "billing_receipt_03",
      providerConnectionId: providerId,
      currency: "USD",
      evidenceSource: "sanitized-fixture",
      invoiceIdHash: hash("1"),
      observedAt,
      invoiceLines: [line(), line()],
      expectedCharges: [expected()],
    })).toThrowError(DomainError);

    expect(() => createProviderBillingReconciliation({
      receiptId: "billing_receipt_04",
      providerConnectionId: providerId,
      currency: "USD",
      evidenceSource: "sanitized-fixture",
      invoiceIdHash: hash("2"),
      observedAt,
      invoiceLines: [line()],
      expectedCharges: [{ ...expected(), providerConnectionId: id<ProviderConnectionId>("provider_02") }],
    })).toThrowError(/another provider connection/i);

    expect(() => createProviderBillingReconciliation({
      receiptId: "billing_receipt_05",
      providerConnectionId: providerId,
      currency: "USD",
      evidenceSource: "sanitized-fixture",
      invoiceIdHash: "not-a-hash",
      observedAt,
      invoiceLines: [line()],
      expectedCharges: [expected()],
    })).toThrowError(DomainError);
  });

  it("returns unknown when neither invoice nor expected charges are available", () => {
    const receipt = createProviderBillingReconciliation({
      receiptId: "billing_receipt_06",
      providerConnectionId: providerId,
      currency: "USD",
      evidenceSource: "sanitized-fixture",
      invoiceIdHash: hash("3"),
      observedAt,
      invoiceLines: [],
      expectedCharges: [],
    });
    expect(receipt.coverage).toBe("unknown");
    expect(receipt.totals.invoiceMicrounits).toBe(0);
    expect(receipt.totals.unmatchedExpectedCharges).toBe(0);
  });

  it("marks missing expected charges as partial and leaves unrelated account lines excluded", () => {
    const receipt = createProviderBillingReconciliation({
      receiptId: "billing_receipt_07",
      providerConnectionId: providerId,
      currency: "USD",
      evidenceSource: "user-import",
      invoiceIdHash: hash("4"),
      observedAt,
      invoiceLines: [line(10, {
        kind: "subscription",
        component: "account subscription",
        attemptId: undefined,
        responseIdentityHash: undefined,
      })],
      expectedCharges: [expected()],
    });
    expect(receipt.coverage).toBe("partial");
    expect(receipt.totals.unmatchedExpectedCharges).toBe(1);
    expect(receipt.totals.requestInvoiceMicrounits).toBe(0);
  });

  it("rejects mixed currencies, duplicate request allocation and partial allocation identities", () => {
    const base: CreateProviderBillingReconciliationInput = {
      receiptId: "billing_receipt_08",
      providerConnectionId: providerId,
      currency: "USD",
      evidenceSource: "provider-export",
      invoiceIdHash: hash("5"),
      observedAt,
      invoiceLines: [line()],
      expectedCharges: [expected()],
    };
    expect(() => createProviderBillingReconciliation({ ...base, invoiceLines: [line(100, { currency: "EUR" })] }))
      .toThrowError(/currency differs/u);
    expect(() => createProviderBillingReconciliation({ ...base, invoiceLines: [line(), line(100, { lineIdHash: hash("6") })] }))
      .toThrowError(/repeats one request charge identity/u);
    expect(() => createProviderBillingReconciliation({ ...base, expectedCharges: [expected(), expected()] }))
      .toThrowError(/duplicate identity/u);
    expect(() => createProviderBillingReconciliation({ ...base, invoiceLines: [line(100, { responseIdentityHash: undefined })] }))
      .toThrowError(/both attempt and response identity/u);
  });

  it("rejects unknown fields, future observations and unsafe accounting totals", () => {
    const base: CreateProviderBillingReconciliationInput = {
      receiptId: "billing_receipt_09",
      providerConnectionId: providerId,
      currency: "USD",
      evidenceSource: "sanitized-fixture",
      invoiceIdHash: hash("7"),
      observedAt,
      invoiceLines: [line()],
      expectedCharges: [expected()],
    };
    expect(() => createProviderBillingReconciliation({ ...base, accountId: "private" } as CreateProviderBillingReconciliationInput))
      .toThrowError(/unsupported fields/u);
    expect(() => createProviderBillingReconciliation({
      ...base,
      invoiceLines: [{ ...line(), rawRequestId: "private" } as ProviderInvoiceLine],
    })).toThrowError(/unsupported fields/u);
    expect(() => createProviderBillingReconciliation({
      ...base,
      invoiceLines: [line(100, { observedAt: "2026-11-08T10:00:00.000Z" })],
    })).toThrowError(/after reconciliation/u);
    expect(() => createProviderBillingReconciliation({
      ...base,
      invoiceLines: [line(Number.MAX_SAFE_INTEGER), line(1, { lineIdHash: hash("8") })],
    })).toThrowError(/safe accounting range/u);
    expect(() => createProviderBillingReconciliation({ ...base, invoiceLines: [line(-1)] }))
      .toThrowError(/non-negative safe integer/u);
  });

  it("composes with immutable attempt telemetry, selecting provider-reported charges and excluding invoice self-validation", () => {
    const scope: TelemetryScope = {
      profileId: id<ProfileId>("profile_01"),
      conversationId: id<ConversationId>("conversation_01"),
      branchId: id<BranchId>("branch_01"),
      runId: id<RunId>("run_01"),
      attemptId,
      providerConnectionId: providerId,
      modelProfileId: id<ModelProfileId>("model_01"),
      providerModelId: "fixture-model",
    };
    let usageLedger = createUsageLedger(scope.runId!);
    usageLedger = appendUsageLedgerEntry(usageLedger, {
      id: id<UsageLedgerEntryId>("usage_estimate"),
      scope,
      source: "local-estimate",
      authoritative: false,
      coverage: "estimated",
      observedAt: "2026-11-07T09:00:00.000Z",
      costs: [{
        kind: "calculated-estimate",
        component: "model tokens",
        amountMicrounits: 110,
        currency: "USD",
        priceSnapshotId: "prices_fixture",
        priceSnapshotHash: hash("1"),
        formulaVersion: "cost-fixture-v1",
      }],
    });
    usageLedger = appendUsageLedgerEntry(usageLedger, {
      id: id<UsageLedgerEntryId>("usage_final"),
      scope,
      source: "provider-final",
      authoritative: true,
      coverage: "complete",
      observedAt: "2026-11-07T09:01:00.000Z",
      responseIdentityHash: hash("a"),
      counters: { inputTokens: 200, outputTokens: 40 },
      costs: [{ kind: "provider-reported", component: "model tokens", amountMicrounits: 100, currency: "USD" }],
    });
    usageLedger = appendUsageLedgerEntry(usageLedger, {
      id: id<UsageLedgerEntryId>("usage_invoice"),
      scope,
      source: "provider-invoice",
      authoritative: true,
      coverage: "complete",
      observedAt: "2026-11-07T09:02:00.000Z",
      responseIdentityHash: hash("a"),
      costs: [{ kind: "invoice", component: "model tokens", amountMicrounits: 999, currency: "USD" }],
    });
    const attempt = createProviderAttemptTelemetryRecord({
      scope,
      dispatchStartedAt: "2026-11-07T08:59:00.000Z",
      outcome: "completed",
      acceptedByProvider: true,
      usageLedger,
    });
    const input = {
      receiptId: "billing_receipt_10",
      providerConnectionId: providerId,
      currency: "USD",
      evidenceSource: "sanitized-fixture" as const,
      invoiceIdHash: hash("c"),
      observedAt,
      invoiceLines: [line()],
      attempts: [attempt],
    };
    const projection = reconcileProviderTelemetryBilling(input);
    expect(projection.coverage).toBe("complete");
    expect(projection.receipt.totals.expectedMicrounits).toBe(100);
    expect(projection.receipt.lines[0]?.expectedSource).toBe("provider-reported");
    expect(projection.omittedAttempts).toEqual([]);

    const missing = createProviderAttemptTelemetryRecord({
      scope: { ...scope, attemptId: id<AttemptId>("attempt_02") },
      dispatchStartedAt: "2026-11-07T08:59:00.000Z",
      outcome: "failed",
      acceptedByProvider: false,
    });
    const partial = reconcileProviderTelemetryBilling({ ...input, attempts: [attempt, missing] });
    expect(partial.coverage).toBe("partial");
    expect(partial.omittedAttempts).toEqual([{ attemptId: "attempt_02", reason: "missing-usage-ledger" }]);
    expect(Object.isFrozen(partial.omittedAttempts[0])).toBe(true);
    expect(() => reconcileProviderTelemetryBilling({ ...input, attempts: [attempt, attempt] }))
      .toThrowError(/duplicate identity/u);
  });
});

