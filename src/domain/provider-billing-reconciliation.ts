import { assertDomain } from "./errors";
import type { AttemptId, ProviderConnectionId, RunId } from "./ids";
import { createProviderAttemptTelemetryRecord, type ProviderAttemptTelemetryRecord } from "./provider-telemetry-projection";
import { assertIsoTimestamp, assertNonBlank, assertSha256, type IsoTimestamp } from "./shared";
import type { CostStatement, UsageLedgerEntry } from "./telemetry";

/**
 * A provider invoice line after the provider's account and invoice identities
 * have been hashed by the connector. Raw invoice IDs, request IDs and account
 * metadata must never cross into the renderer or durable receipt.
 */
export type ProviderInvoiceLineKind =
  | "request"
  | "tax"
  | "credit"
  | "subscription"
  | "adjustment";

export type BillingReconciliationDisposition =
  | "matched"
  | "amount-mismatch"
  | "unallocated"
  | "excluded";

export type BillingReconciliationCoverage = "complete" | "partial" | "unknown";
export type ProviderInvoiceEvidenceSource = "sanitized-fixture" | "provider-export" | "user-import";

export interface ProviderInvoiceLine {
  /** Stable connector hash for one line, not the provider's raw line ID. */
  readonly lineIdHash: string;
  readonly providerConnectionId: ProviderConnectionId;
  readonly kind: ProviderInvoiceLineKind;
  readonly component: string;
  /** Positive magnitude. Credit lines subtract this amount from invoice totals. */
  readonly amountMicrounits: number;
  readonly currency: string;
  /** A request line may identify its exact Omnia attempt. */
  readonly attemptId?: AttemptId;
  /** Hash of the provider response/request identity from the usage ledger. */
  readonly responseIdentityHash?: string;
  readonly observedAt: IsoTimestamp;
}

/**
 * Expected charge materialized from an immutable usage observation. The
 * amount is deliberately explicit: estimated and provider-reported layers
 * can be reconciled without re-running a pricing formula.
 */
export interface ExpectedProviderCharge {
  readonly providerConnectionId: ProviderConnectionId;
  readonly attemptId: AttemptId;
  readonly responseIdentityHash: string;
  readonly component: string;
  readonly amountMicrounits: number;
  readonly currency: string;
  readonly source: "calculated-estimate" | "provider-reported";
  readonly observedAt: IsoTimestamp;
}

export interface BillingReconciliationLineResult {
  readonly lineIdHash: string;
  readonly kind: ProviderInvoiceLineKind;
  readonly component: string;
  readonly disposition: BillingReconciliationDisposition;
  readonly attemptId?: AttemptId;
  readonly responseIdentityHash?: string;
  readonly expectedSource?: ExpectedProviderCharge["source"];
  readonly expectedAmountMicrounits?: number;
  readonly invoiceAmountMicrounits: number;
  readonly deltaMicrounits?: number;
  readonly reason?:
    | "non-request-line"
    | "missing-attempt-reference"
    | "missing-expected-charge"
    | "amount-differs";
}

export interface BillingReconciliationTotals {
  /** Net invoice amount: credit lines reduce the total. */
  readonly invoiceMicrounits: number;
  readonly requestInvoiceMicrounits: number;
  readonly matchedMicrounits: number;
  readonly mismatchMicrounits: number;
  /** Net non-request lines, including negative credit magnitudes. */
  readonly excludedMicrounits: number;
  readonly unallocatedMicrounits: number;
  readonly expectedMicrounits: number;
  readonly matchedLines: number;
  readonly mismatchLines: number;
  readonly excludedLines: number;
  readonly unallocatedLines: number;
  readonly unmatchedExpectedCharges: number;
}

export interface ProviderBillingReconciliationReceipt {
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly providerConnectionId: ProviderConnectionId;
  /** Hash of the provider invoice identity; raw invoice IDs stay connector-local. */
  readonly invoiceIdHash: string;
  readonly runId?: RunId;
  readonly currency: string;
  /** Local reconciliation does not authenticate a provider export. */
  readonly evidenceSource: ProviderInvoiceEvidenceSource;
  readonly verification: "local-reconciliation";
  readonly observedAt: IsoTimestamp;
  readonly coverage: BillingReconciliationCoverage;
  readonly lines: readonly BillingReconciliationLineResult[];
  readonly totals: BillingReconciliationTotals;
}

export interface CreateProviderBillingReconciliationInput {
  readonly receiptId: string;
  readonly providerConnectionId: ProviderConnectionId;
  readonly invoiceIdHash: string;
  readonly runId?: RunId;
  readonly currency: string;
  readonly evidenceSource: ProviderInvoiceEvidenceSource;
  readonly observedAt: IsoTimestamp;
  readonly invoiceLines: readonly ProviderInvoiceLine[];
  readonly expectedCharges: readonly ExpectedProviderCharge[];
}

export interface ProviderTelemetryBillingProjection {
  readonly receipt: ProviderBillingReconciliationReceipt;
  /** Includes missing attempt evidence as well as the explicit invoice result. */
  readonly coverage: BillingReconciliationCoverage;
  readonly omittedAttempts: readonly {
    readonly attemptId: AttemptId;
    readonly reason: "missing-usage-ledger" | "missing-cost-observation" | "missing-response-identity";
  }[];
}

const CURRENCY = /^[A-Z][A-Z0-9]{2,7}$/u;
const MAX_LINES = 4096;

function exactKeys(value: unknown, allowed: readonly string[], label: string): void {
  assertDomain(value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid_argument", `${label} must be an object.`);
  assertDomain(Object.keys(value).every((key) => allowed.includes(key)),
    "invalid_argument", `${label} contains unsupported fields.`);
}

function text(value: unknown, label: string, maximum = 160): string {
  assertDomain(typeof value === "string", "invalid_argument", `${label} must be text.`);
  const normalized = assertNonBlank(value, label, maximum);
  assertDomain(!/[\u0000-\u001f\u007f]/u.test(normalized), "invalid_argument", `${label} contains control characters.`);
  return normalized;
}

function sha256(value: unknown, label: string): string {
  return assertSha256(text(value, label, 64), label);
}

function safeInteger(value: number, label: string): number {
  assertDomain(
    Number.isSafeInteger(value) && value >= 0,
    "invalid_argument",
    `${label} must be a non-negative safe integer.`,
    { label, value },
  );
  return value;
}

function currency(value: string, label: string): string {
  const normalized = text(value, label, 8).toUpperCase();
  assertDomain(CURRENCY.test(normalized), "invalid_argument", `${label} has an invalid currency.`, {
    label,
    value,
  });
  return normalized;
}

function component(value: string, label: string): string {
  return text(value, label, 160);
}

function lineKey(
  providerConnectionId: ProviderConnectionId,
  attemptId: AttemptId,
  responseIdentityHash: string,
  componentName: string,
  currencyCode: string,
): string {
  return [providerConnectionId, attemptId, responseIdentityHash, componentName, currencyCode].join("\u0000");
}

function add(left: number, right: number, label: string): number {
  const result = left + right;
  assertDomain(Number.isSafeInteger(result), "invalid_argument", `${label} exceeds safe accounting range.`);
  return result;
}

function subtract(left: number, right: number, label: string): number {
  const result = left - right;
  assertDomain(Number.isSafeInteger(result), "invalid_argument", `${label} exceeds safe accounting range.`);
  return result;
}

/**
 * Reconciles redacted provider invoice lines with explicit expected charges.
 * Matching is exact on provider, attempt, response identity, component and
 * currency. A missing identity never gets guessed from amount alone.
 */
export function createProviderBillingReconciliation(
  input: CreateProviderBillingReconciliationInput,
): ProviderBillingReconciliationReceipt {
  exactKeys(input, ["receiptId", "providerConnectionId", "invoiceIdHash", "runId", "currency", "evidenceSource", "observedAt", "invoiceLines", "expectedCharges"], "Billing reconciliation input");
  const receiptId = text(input.receiptId, "billing receipt ID");
  text(input.providerConnectionId, "provider connection ID");
  if (input.runId !== undefined) text(input.runId, "billing run ID");
  const invoiceIdHash = sha256(input.invoiceIdHash, "invoice ID hash");
  const receiptCurrency = currency(input.currency, "billing receipt currency");
  assertDomain(["sanitized-fixture", "provider-export", "user-import"].includes(input.evidenceSource),
    "invalid_argument", "Billing evidence source is unsupported.");
  text(input.observedAt, "billing observation time", 64);
  assertIsoTimestamp(input.observedAt, "billing observation time");
  assertDomain(Array.isArray(input.invoiceLines) && Array.isArray(input.expectedCharges),
    "invalid_argument", "Billing reconciliation requires invoice and expected charge arrays.");
  assertDomain(input.invoiceLines.length <= MAX_LINES, "invalid_argument", "Invoice has too many lines.");
  assertDomain(input.expectedCharges.length <= MAX_LINES, "invalid_argument", "Expected charge set is too large.");

  const lineIds = new Set<string>();
  const expectedByKey = new Map<string, ExpectedProviderCharge>();
  const expectedKeys = new Set<string>();
  for (const expected of input.expectedCharges) {
    exactKeys(expected, ["providerConnectionId", "attemptId", "responseIdentityHash", "component", "amountMicrounits", "currency", "source", "observedAt"], "Expected provider charge");
    assertDomain(
      expected.providerConnectionId === input.providerConnectionId,
      "scope_violation",
      "Expected charge belongs to another provider connection.",
    );
    const attemptId = text(expected.attemptId, "expected charge attempt ID") as AttemptId;
    const responseIdentityHash = sha256(expected.responseIdentityHash, "expected response identity hash");
    const expectedComponent = component(expected.component, "expected charge component");
    const expectedCurrency = currency(expected.currency, "expected charge currency");
    const amountMicrounits = safeInteger(expected.amountMicrounits, "expected charge amount");
    assertDomain(expectedCurrency === receiptCurrency, "scope_violation", "Expected charge currency differs from receipt currency.");
    assertDomain(expected.source === "calculated-estimate" || expected.source === "provider-reported",
      "invalid_argument", "Expected provider charge source is unsupported.");
    text(expected.observedAt, "expected charge observation time", 64);
    assertIsoTimestamp(expected.observedAt, "expected charge observation time");
    assertDomain(Date.parse(expected.observedAt) <= Date.parse(input.observedAt), "invalid_argument", "Expected charge was observed after reconciliation.");
    const key = lineKey(
      expected.providerConnectionId,
      attemptId,
      responseIdentityHash,
      expectedComponent,
      expectedCurrency,
    );
    assertDomain(!expectedKeys.has(key), "conflict", "Expected charges contain a duplicate identity.", { key });
    expectedKeys.add(key);
    expectedByKey.set(key, Object.freeze({
      ...expected,
      attemptId,
      responseIdentityHash,
      component: expectedComponent,
      currency: expectedCurrency,
      amountMicrounits,
    }));
  }

  const matchedExpected = new Set<string>();
  const invoiceRequestKeys = new Set<string>();
  let invoiceMicrounits = 0;
  let requestInvoiceMicrounits = 0;
  let matchedMicrounits = 0;
  let mismatchMicrounits = 0;
  let excludedMicrounits = 0;
  let unallocatedMicrounits = 0;
  const results: BillingReconciliationLineResult[] = [];

  for (const line of input.invoiceLines) {
    exactKeys(line, ["lineIdHash", "providerConnectionId", "kind", "component", "amountMicrounits", "currency", "attemptId", "responseIdentityHash", "observedAt"], "Invoice line");
    const lineIdHash = sha256(line.lineIdHash, "invoice line ID hash");
    assertDomain(!lineIds.has(lineIdHash), "conflict", "Invoice contains a duplicate line identity.", {
      lineIdHash,
    });
    lineIds.add(lineIdHash);
    assertDomain(
      line.providerConnectionId === input.providerConnectionId,
      "scope_violation",
      "Invoice line belongs to another provider connection.",
    );
    const amountMicrounits = safeInteger(line.amountMicrounits, "invoice line amount");
    const lineCurrency = currency(line.currency, "invoice line currency");
    const lineComponent = component(line.component, "invoice line component");
    assertDomain(lineCurrency === receiptCurrency, "scope_violation", "Invoice line currency differs from receipt currency.");
    assertDomain(["request", "tax", "credit", "subscription", "adjustment"].includes(line.kind),
      "invalid_argument", "Invoice line kind is unsupported.");
    text(line.observedAt, "invoice line observation time", 64);
    assertIsoTimestamp(line.observedAt, "invoice line observation time");
    assertDomain(Date.parse(line.observedAt) <= Date.parse(input.observedAt), "invalid_argument", "Invoice line was observed after reconciliation.");
    const signedInvoiceAmount = line.kind === "credit" ? -amountMicrounits : amountMicrounits;
    invoiceMicrounits = add(invoiceMicrounits, signedInvoiceAmount, "invoice total");

    if (line.kind !== "request") {
      assertDomain(line.attemptId === undefined && line.responseIdentityHash === undefined,
        "invalid_argument", "Non-request invoice lines cannot carry attempt identity.");
      excludedMicrounits = add(excludedMicrounits, signedInvoiceAmount, "excluded invoice total");
      results.push(Object.freeze({
        lineIdHash,
        kind: line.kind,
        component: lineComponent,
        disposition: "excluded",
        invoiceAmountMicrounits: signedInvoiceAmount,
        reason: "non-request-line",
      }));
      continue;
    }

    requestInvoiceMicrounits = add(requestInvoiceMicrounits, amountMicrounits, "request invoice total");
    assertDomain((line.attemptId === undefined) === (line.responseIdentityHash === undefined),
      "invalid_argument", "Request allocation requires both attempt and response identity.");
    if (line.attemptId === undefined || line.responseIdentityHash === undefined) {
      unallocatedMicrounits = add(unallocatedMicrounits, amountMicrounits, "unallocated invoice total");
      results.push(Object.freeze({
        lineIdHash,
        kind: line.kind,
        component: lineComponent,
        disposition: "unallocated",
        invoiceAmountMicrounits: amountMicrounits,
        reason: "missing-attempt-reference",
      }));
      continue;
    }
    const attemptId = text(line.attemptId, "invoice attempt ID") as AttemptId;
    const responseIdentityHash = sha256(line.responseIdentityHash, "invoice response identity hash");
    const key = lineKey(input.providerConnectionId, attemptId, responseIdentityHash, lineComponent, lineCurrency);
    assertDomain(!invoiceRequestKeys.has(key), "conflict", "Invoice repeats one request charge identity; connector aggregation is required.");
    invoiceRequestKeys.add(key);
    const expected = expectedByKey.get(key);
    if (expected === undefined) {
      unallocatedMicrounits = add(unallocatedMicrounits, amountMicrounits, "unallocated invoice total");
      results.push(Object.freeze({
        lineIdHash,
        kind: line.kind,
        component: lineComponent,
        disposition: "unallocated",
        attemptId,
        responseIdentityHash,
        invoiceAmountMicrounits: amountMicrounits,
        reason: "missing-expected-charge",
      }));
      continue;
    }
    matchedExpected.add(key);
    if (amountMicrounits === expected.amountMicrounits) {
      matchedMicrounits = add(matchedMicrounits, amountMicrounits, "matched invoice total");
      results.push(Object.freeze({
        lineIdHash,
        kind: line.kind,
        component: lineComponent,
        disposition: "matched",
        attemptId,
        responseIdentityHash,
        expectedSource: expected.source,
        expectedAmountMicrounits: expected.amountMicrounits,
        invoiceAmountMicrounits: amountMicrounits,
        deltaMicrounits: 0,
      }));
    } else {
      const deltaMicrounits = subtract(amountMicrounits, expected.amountMicrounits, "invoice delta");
      mismatchMicrounits = add(mismatchMicrounits, amountMicrounits, "mismatched invoice total");
      results.push(Object.freeze({
        lineIdHash,
        kind: line.kind,
        component: lineComponent,
        disposition: "amount-mismatch",
        attemptId,
        responseIdentityHash,
        expectedSource: expected.source,
        expectedAmountMicrounits: expected.amountMicrounits,
        invoiceAmountMicrounits: amountMicrounits,
        deltaMicrounits,
        reason: "amount-differs",
      }));
    }
  }

  const expectedMicrounits = [...expectedByKey.values()].reduce(
    (total, expected) => add(total, safeInteger(expected.amountMicrounits, "expected charge amount"), "expected total"),
    0,
  );
  const unmatchedExpectedCharges = [...expectedByKey.values()].filter((expected) => {
    const key = lineKey(
      expected.providerConnectionId,
      expected.attemptId,
      expected.responseIdentityHash,
      expected.component.trim(),
      expected.currency.trim().toUpperCase(),
    );
    return !matchedExpected.has(key);
  }).length;
  const coverage: BillingReconciliationCoverage =
    results.every((result) => result.disposition === "excluded") && input.expectedCharges.length === 0
      ? "unknown"
      : results.some((result) => result.disposition === "unallocated" || result.disposition === "amount-mismatch") || unmatchedExpectedCharges > 0
        ? "partial"
        : "complete";
  return Object.freeze({
    schemaVersion: 1,
    receiptId,
    providerConnectionId: input.providerConnectionId,
    invoiceIdHash,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    currency: receiptCurrency,
    evidenceSource: input.evidenceSource,
    verification: "local-reconciliation",
    observedAt: input.observedAt,
    coverage,
    lines: Object.freeze(results),
    totals: Object.freeze({
      invoiceMicrounits,
      requestInvoiceMicrounits,
      matchedMicrounits,
      mismatchMicrounits,
      excludedMicrounits,
      unallocatedMicrounits,
      expectedMicrounits,
      matchedLines: results.filter((result) => result.disposition === "matched").length,
      mismatchLines: results.filter((result) => result.disposition === "amount-mismatch").length,
      excludedLines: results.filter((result) => result.disposition === "excluded").length,
      unallocatedLines: results.filter((result) => result.disposition === "unallocated").length,
      unmatchedExpectedCharges,
    }),
  });
}

/**
 * Production composition for the attempt telemetry read model. Invoice costs
 * are excluded from expected charges so an imported invoice cannot validate
 * itself. A provider-reported component outranks its local estimate; latest
 * immutable sequence breaks ties. Missing usage/identity stays explicit.
 */
export function reconcileProviderTelemetryBilling(
  input: Omit<CreateProviderBillingReconciliationInput, "expectedCharges"> & {
    readonly attempts: readonly ProviderAttemptTelemetryRecord[];
  },
): ProviderTelemetryBillingProjection {
  exactKeys(input, ["receiptId", "providerConnectionId", "invoiceIdHash", "runId", "currency", "evidenceSource", "observedAt", "invoiceLines", "attempts"], "Provider telemetry billing input");
  assertDomain(Array.isArray(input.attempts) && input.attempts.length <= MAX_LINES,
    "invalid_argument", "Provider billing attempt collection is invalid or too large.");
  const expectedCharges: ExpectedProviderCharge[] = [];
  const omittedAttempts: Array<ProviderTelemetryBillingProjection["omittedAttempts"][number]> = [];
  const attemptIds = new Set<AttemptId>();
  let usageEntries = 0;
  let costStatements = 0;
  for (const raw of input.attempts) {
    if (raw.usageLedger !== undefined) {
      usageEntries += raw.usageLedger.entries.length;
      assertDomain(usageEntries <= MAX_LINES, "invalid_argument", "Provider billing usage evidence exceeds its read budget.");
      for (const entry of raw.usageLedger.entries) {
        costStatements += entry.costs.length;
        assertDomain(costStatements <= MAX_LINES, "invalid_argument", "Provider billing cost evidence exceeds its read budget.");
      }
    }
    const record = createProviderAttemptTelemetryRecord(raw);
    assertDomain(record.scope.providerConnectionId === input.providerConnectionId,
      "scope_violation", "Provider billing attempt belongs to another provider connection.");
    const attemptId = record.scope.attemptId;
    assertDomain(!attemptIds.has(attemptId), "conflict", "Provider billing attempts contain duplicate identity.");
    attemptIds.add(attemptId);
    if (record.usageLedger === undefined) {
      omittedAttempts.push(Object.freeze({ attemptId, reason: "missing-usage-ledger" }));
      continue;
    }
    const candidates = new Map<string, { readonly cost: CostStatement; readonly entry: UsageLedgerEntry }>();
    for (const entry of record.usageLedger.entries) {
      if (entry.scope.attemptId !== attemptId || entry.source === "provider-invoice") continue;
      for (const cost of entry.costs) {
        if (cost.kind !== "calculated-estimate" && cost.kind !== "provider-reported") continue;
        const key = JSON.stringify([cost.component.trim(), cost.currency.trim().toUpperCase()]);
        const current = candidates.get(key);
        const rank = cost.kind === "provider-reported" ? 2 : 1;
        const currentRank = current?.cost.kind === "provider-reported" ? 2 : 1;
        if (current !== undefined && (currentRank > rank || (currentRank === rank && current.entry.sequence > entry.sequence))) continue;
        candidates.set(key, { cost, entry });
      }
    }
    if (candidates.size === 0) {
      omittedAttempts.push(Object.freeze({ attemptId, reason: "missing-cost-observation" }));
    } else if ([...candidates.values()].some(({ entry }) => entry.responseIdentityHash === undefined)) {
      omittedAttempts.push(Object.freeze({ attemptId, reason: "missing-response-identity" }));
    }
    for (const { cost, entry } of candidates.values()) {
      if (entry.responseIdentityHash === undefined) continue;
      assertDomain(cost.kind === "calculated-estimate" || cost.kind === "provider-reported",
        "invalid_argument", "Expected provider cost kind is unsupported.");
      expectedCharges.push({
        providerConnectionId: record.scope.providerConnectionId,
        attemptId,
        responseIdentityHash: entry.responseIdentityHash,
        component: cost.component,
        amountMicrounits: cost.amountMicrounits,
        currency: cost.currency,
        source: cost.kind,
        observedAt: entry.observedAt,
      });
    }
  }
  const receipt = createProviderBillingReconciliation({
    receiptId: input.receiptId,
    providerConnectionId: input.providerConnectionId,
    invoiceIdHash: input.invoiceIdHash,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    currency: input.currency,
    evidenceSource: input.evidenceSource,
    observedAt: input.observedAt,
    invoiceLines: input.invoiceLines,
    expectedCharges,
  });
  return Object.freeze({
    receipt,
    coverage: omittedAttempts.length === 0 ? receipt.coverage : "partial",
    omittedAttempts: Object.freeze(omittedAttempts),
  });
}

