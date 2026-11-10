import { assertDomain } from "./errors";
import { assertIsoTimestamp, assertSha256, freezeJson, type JsonValue } from "./shared";

/**
 * Durable, provider agnostic state for a multi model comparison.  A compare
 * run owns one frozen logical input and a separate attempt/receipt for every
 * candidate.  Keeping the two concerns separate prevents usage or provenance
 * from one provider being accidentally attributed to another candidate.
 */
export const MODEL_COMPARE_SCHEMA = "omnia.model-compare.v1" as const;
export const MODEL_COMPARE_MAX_CANDIDATES = 4;
const MAX_COMPARE_CONTENT_BYTES = 4 * 1024 * 1024;
const TERMINAL_ATTEMPT_STATUSES: readonly ModelCompareAttemptStatus[] = ["completed", "failed", "cancelled", "unknown"];
const ATTEMPT_STATUSES: readonly ModelCompareAttemptStatus[] = ["planned", "running", ...TERMINAL_ATTEMPT_STATUSES];
const MERGE_STRATEGIES: readonly ModelCompareMergeStrategy[] = ["best-of", "consensus", "manual", "weighted"];

export type ModelCompareRunStatus = "planned" | "running" | "completed" | "partial" | "failed";
export type ModelCompareAttemptStatus = "planned" | "running" | "completed" | "failed" | "cancelled" | "unknown";
export type ModelCompareMergeStrategy = "best-of" | "consensus" | "manual" | "weighted";

export interface ModelCompareLogicalInput {
  readonly id: string;
  /** Canonical input digest supplied by the context compiler. */
  readonly digest: string;
  readonly messages: readonly unknown[];
  readonly contextSnapshotId?: string | null;
  readonly promptRevisionId?: string | null;
}

export interface ModelCompareCandidate {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly label?: string;
}

export interface ModelCompareUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly totalTokens?: number;
  readonly costMicros?: number;
}

export interface ModelCompareProvenance {
  readonly providerRequestId?: string | null;
  readonly providerResponseId?: string | null;
  readonly providerModel?: string | null;
  readonly adapterId?: string | null;
  readonly receiptId?: string | null;
}

export interface ModelCompareAttempt {
  readonly id: string;
  readonly candidate: ModelCompareCandidate;
  readonly status: ModelCompareAttemptStatus;
  readonly output?: string | null;
  readonly usage?: ModelCompareUsage | null;
  readonly provenance?: ModelCompareProvenance | null;
  readonly error?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

export interface ModelCompareRun {
  readonly schema: typeof MODEL_COMPARE_SCHEMA;
  readonly id: string;
  readonly status: ModelCompareRunStatus;
  readonly logicalInput: ModelCompareLogicalInput;
  readonly candidates: readonly ModelCompareCandidate[];
  readonly attempts: readonly ModelCompareAttempt[];
  readonly createdAt: string;
  readonly completedAt?: string | null;
  readonly mergeReceipt?: ModelCompareMergeReceipt;
}

/** Immutable proof of how independent candidate attempts became one answer. */
export interface ModelCompareMergeReceipt {
  readonly schema: typeof MODEL_COMPARE_SCHEMA;
  readonly compareRunId: string;
  readonly logicalInputDigest: string;
  readonly attemptIds: readonly string[];
  readonly selectedAttemptIds: readonly string[];
  readonly strategy: ModelCompareMergeStrategy;
  readonly rationale: string;
  readonly finalOutputSha256: string;
  readonly createdAt: string;
  readonly receiptSha256?: string;
}

function text(value: unknown, label: string, max = 512): string {
  assertDomain(typeof value === "string" && value.trim().length > 0, "invalid_argument", `${label} cannot be empty.`);
  const normalized = value.trim();
  assertDomain(normalized.length <= max, "invalid_argument", `${label} exceeds its ${max}-character limit.`);
  return normalized;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assertDomain(typeof value === "object" && value !== null && !Array.isArray(value), "invalid_argument", `${label} must be an object.`);
}

function assertKnownKeys(value: unknown, keys: readonly string[], label: string): void {
  assertRecord(value, label);
  assertDomain(Object.keys(value).every((key) => keys.includes(key)), "invalid_argument", `${label} contains an unknown field.`);
}

function normalizedTimestamp(value: unknown, label: string): string {
  assertDomain(typeof value === "string", "invalid_argument", `${label} must be an ISO-8601 timestamp.`);
  assertIsoTimestamp(value, label);
  return value;
}

/** Reject lossy JSON values before cloning; callers cannot mutate a frozen input through a nested reference. */
function snapshotMessages(messages: readonly unknown[]): readonly unknown[] {
  assertDomain(Array.isArray(messages), "invalid_argument", "Compare logical input messages must be an array.");
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    assertDomain(depth <= 64 && ++nodes <= 100_000, "invalid_argument", "Compare logical input exceeds its structural limit.");
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      assertDomain(Number.isFinite(value), "invalid_argument", "Compare logical input contains a non-finite number.");
      return;
    }
    assertDomain(typeof value === "object" && value !== null, "invalid_argument", "Compare logical input must contain JSON values only.");
    assertDomain(!ancestors.has(value), "invalid_argument", "Compare logical input cannot contain cycles.");
    assertDomain(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "invalid_argument", "Compare logical input must contain plain JSON objects.");
    ancestors.add(value);
    for (const entry of Object.values(value)) visit(entry, depth + 1);
    ancestors.delete(value);
  };
  visit(messages, 0);
  const serialized = JSON.stringify(messages);
  assertDomain(new TextEncoder().encode(serialized).byteLength <= MAX_COMPARE_CONTENT_BYTES, "invalid_argument", "Compare logical input exceeds its byte limit.");
  return freezeJson(JSON.parse(serialized) as JsonValue[]) as readonly unknown[];
}

function validateUsage(usage: ModelCompareUsage | null | undefined): ModelCompareUsage | null | undefined {
  if (usage == null) return usage;
  assertKnownKeys(usage, ["inputTokens", "outputTokens", "cachedInputTokens", "totalTokens", "costMicros"], "Compare usage");
  for (const [key, value] of Object.entries(usage)) {
    assertDomain(value === undefined || (Number.isSafeInteger(value) && value >= 0), "invalid_argument", `${key} must be a non-negative integer.`);
  }
  if (usage.totalTokens !== undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    assertDomain(usage.totalTokens >= usage.inputTokens + usage.outputTokens, "invalid_argument", "Compare total tokens cannot be smaller than input plus output tokens.");
  }
  return Object.freeze(Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)));
}

function validateProvenance(provenance: ModelCompareProvenance | null | undefined): ModelCompareProvenance | null | undefined {
  if (provenance == null) return provenance;
  assertKnownKeys(provenance, ["providerRequestId", "providerResponseId", "providerModel", "adapterId", "receiptId"], "Compare provenance");
  return Object.freeze(Object.fromEntries(Object.entries(provenance)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, value === null ? null : text(value, `Compare provenance ${key}`)])));
}

function normalizeCandidate(candidate: ModelCompareCandidate): ModelCompareCandidate {
  assertKnownKeys(candidate, ["id", "providerId", "modelId", "label"], "Compare candidate");
  return Object.freeze({
    id: text(candidate.id, "candidate id"),
    providerId: text(candidate.providerId, "candidate provider id"),
    modelId: text(candidate.modelId, "candidate model id"),
    ...(candidate.label === undefined ? {} : { label: text(candidate.label, "candidate label") }),
  });
}

function aggregateStatus(attempts: readonly ModelCompareAttempt[]): ModelCompareRunStatus {
  if (attempts.every((attempt) => attempt.status === "planned")) return "planned";
  if (attempts.some((attempt) => !TERMINAL_ATTEMPT_STATUSES.includes(attempt.status))) return "running";
  return attempts.every((attempt) => attempt.status === "completed") ? "completed"
    : attempts.some((attempt) => attempt.status === "completed") ? "partial" : "failed";
}

function validateAttempt(attempt: ModelCompareAttempt, createdAt: string): ModelCompareAttempt {
  assertKnownKeys(attempt, ["id", "candidate", "status", "output", "usage", "provenance", "error", "startedAt", "completedAt"], "Compare attempt");
  assertDomain(ATTEMPT_STATUSES.includes(attempt.status), "invalid_argument", "Compare attempt status is invalid.");
  const terminal = TERMINAL_ATTEMPT_STATUSES.includes(attempt.status);
  if (attempt.startedAt != null) {
    normalizedTimestamp(attempt.startedAt, "Compare attempt start time");
    assertDomain(Date.parse(attempt.startedAt) >= Date.parse(createdAt), "invalid_argument", "Compare attempt cannot start before run creation.");
  }
  if (terminal) {
    assertDomain(attempt.completedAt != null, "invalid_argument", "A terminal compare attempt requires a completion time.");
    normalizedTimestamp(attempt.completedAt, "Compare attempt completion time");
    assertDomain(Date.parse(attempt.completedAt) >= Date.parse(attempt.startedAt ?? createdAt), "invalid_argument", "Compare attempt completion cannot precede its start.");
  } else {
    assertDomain(attempt.completedAt == null, "invalid_argument", "An active compare attempt cannot carry a completion time.");
  }
  if (attempt.output != null) {
    assertDomain(typeof attempt.output === "string" && new TextEncoder().encode(attempt.output).byteLength <= MAX_COMPARE_CONTENT_BYTES, "invalid_argument", "Compare output must be bounded text.");
  }
  if (attempt.error != null) text(attempt.error, "Compare attempt error", 8_000);
  assertDomain(attempt.status !== "completed" || attempt.error == null, "invalid_argument", "A completed compare attempt cannot carry an error.");
  if (attempt.status === "planned") {
    assertDomain(attempt.output == null && attempt.usage == null && attempt.provenance == null && attempt.error == null && attempt.startedAt == null, "invalid_argument", "A planned compare attempt cannot carry execution facts.");
  }
  const usage = validateUsage(attempt.usage);
  const provenance = validateProvenance(attempt.provenance);
  return Object.freeze({
    ...attempt,
    ...(usage === undefined ? {} : { usage }),
    ...(provenance === undefined ? {} : { provenance }),
  });
}

function validateRunLineage(run: ModelCompareRun): void {
  assertKnownKeys(run, ["schema", "id", "status", "logicalInput", "candidates", "attempts", "createdAt", "completedAt", "mergeReceipt"], "Compare run");
  assertDomain(run.schema === MODEL_COMPARE_SCHEMA, "invalid_argument", "Unsupported compare run schema.");
  text(run.id, "Compare run id");
  normalizedTimestamp(run.createdAt, "Compare run creation time");
  assertKnownKeys(run.logicalInput, ["id", "digest", "messages", "contextSnapshotId", "promptRevisionId"], "Compare logical input");
  assertSha256(run.logicalInput.digest, "Compare logical input digest");
  assertDomain(Array.isArray(run.candidates) && run.candidates.length >= 2 && run.candidates.length <= MODEL_COMPARE_MAX_CANDIDATES, "invalid_argument", "A compare run requires two to four candidates.");
  assertDomain(Array.isArray(run.attempts) && run.attempts.length === run.candidates.length, "conflict", "Compare attempt count must match its candidates.");
  assertDomain(new Set(run.candidates.map((candidate) => candidate.id)).size === run.candidates.length, "conflict", "Compare candidate ids must be unique.");
  for (let index = 0; index < run.candidates.length; index += 1) {
    const candidate = normalizeCandidate(run.candidates[index]!);
    const attempt = validateAttempt(run.attempts[index]!, run.createdAt);
    assertDomain(attempt.id === `${run.id}:${candidate.id}` && JSON.stringify(normalizeCandidate(attempt.candidate)) === JSON.stringify(candidate), "conflict", "Compare attempt candidate lineage does not match its run.");
  }
  const status = aggregateStatus(run.attempts);
  assertDomain(run.status === status, "conflict", "Compare run status does not match its attempt outcomes.");
  if (["completed", "partial", "failed"].includes(status)) {
    assertDomain(run.completedAt != null, "invalid_argument", "A terminal compare run requires a completion time.");
    normalizedTimestamp(run.completedAt, "Compare run completion time");
    assertDomain(run.attempts.every((attempt) => Date.parse(attempt.completedAt!) <= Date.parse(run.completedAt!)), "invalid_argument", "Compare run completion cannot precede an attempt completion.");
  } else {
    assertDomain(run.completedAt == null, "invalid_argument", "An active compare run cannot carry a completion time.");
  }
}

/** Creates a compare run with a single immutable logical input and 2–4 candidates. */
export function createModelCompareRun(input: {
  readonly id: string;
  readonly logicalInput: ModelCompareLogicalInput;
  readonly candidates: readonly ModelCompareCandidate[];
  readonly createdAt?: string;
}): ModelCompareRun {
  assertKnownKeys(input, ["id", "logicalInput", "candidates", "createdAt"], "Compare creation input");
  assertKnownKeys(input.logicalInput, ["id", "digest", "messages", "contextSnapshotId", "promptRevisionId"], "Compare logical input");
  const id = text(input.id, "compare run id");
  const createdAt = normalizedTimestamp(input.createdAt ?? new Date().toISOString(), "Compare run creation time");
  assertDomain(Array.isArray(input.candidates), "invalid_argument", "Compare candidates must be an array.");
  const candidates = input.candidates.map(normalizeCandidate);
  assertDomain(candidates.length >= 2 && candidates.length <= MODEL_COMPARE_MAX_CANDIDATES, "invalid_argument", `A compare run requires two to ${MODEL_COMPARE_MAX_CANDIDATES} candidates.`);
  assertDomain(new Set(candidates.map((candidate) => candidate.id)).size === candidates.length, "invalid_argument", "Compare candidate ids must be unique.");
  const logicalInput: ModelCompareLogicalInput = Object.freeze({
    id: text(input.logicalInput.id, "logical input id"),
    digest: assertSha256(input.logicalInput.digest, "Compare logical input digest"),
    messages: snapshotMessages(input.logicalInput.messages),
    ...(input.logicalInput.contextSnapshotId === undefined ? {} : { contextSnapshotId: input.logicalInput.contextSnapshotId === null ? null : text(input.logicalInput.contextSnapshotId, "Context snapshot id") }),
    ...(input.logicalInput.promptRevisionId === undefined ? {} : { promptRevisionId: input.logicalInput.promptRevisionId === null ? null : text(input.logicalInput.promptRevisionId, "Prompt revision id") }),
  });
  const attempts = candidates.map((candidate) => Object.freeze({ id: `${id}:${candidate.id}`, candidate, status: "planned" as const }));
  return Object.freeze({
    schema: MODEL_COMPARE_SCHEMA,
    id,
    status: "planned",
    logicalInput,
    candidates: Object.freeze(candidates),
    attempts: Object.freeze(attempts),
    createdAt,
    completedAt: null,
  });
}

/** Records one candidate outcome while preserving all other attempts. */
export function recordModelCompareAttempt(
  run: ModelCompareRun,
  attemptId: string,
  patch: Omit<Partial<ModelCompareAttempt>, "id" | "candidate"> & { readonly status: ModelCompareAttemptStatus },
): ModelCompareRun {
  validateRunLineage(run);
  assertDomain(run.mergeReceipt === undefined, "invalid_state_transition", "A merged compare run is immutable.");
  assertKnownKeys(patch, ["status", "output", "usage", "provenance", "error", "startedAt", "completedAt"], "Compare attempt patch");
  assertDomain(ATTEMPT_STATUSES.includes(patch.status), "invalid_argument", "Compare attempt status is invalid.");
  const index = run.attempts.findIndex((attempt) => attempt.id === attemptId);
  assertDomain(index >= 0, "not_found", `Compare attempt was not found: ${attemptId}`);
  const previous = run.attempts[index]!;
  assertDomain(!TERMINAL_ATTEMPT_STATUSES.includes(previous.status), "invalid_state_transition", "A terminal compare attempt is immutable; retry requires a new compare run.");
  assertDomain(previous.status !== "running" || patch.status !== "planned", "invalid_state_transition", "A running compare attempt cannot return to planned.");
  const patchRecord = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Omit<Partial<ModelCompareAttempt>, "id" | "candidate"> & { readonly status: ModelCompareAttemptStatus };
  if (previous.startedAt != null && patchRecord.startedAt !== undefined) {
    assertDomain(patchRecord.startedAt === previous.startedAt, "conflict", "Compare attempt start time is immutable after recording.");
  }
  let usage = previous.usage;
  if (patchRecord.usage !== undefined) {
    const update = validateUsage(patchRecord.usage);
    assertDomain(previous.usage == null || update != null, "conflict", "Recorded compare usage cannot be cleared.");
    if (update != null) {
      for (const [key, value] of Object.entries(update)) {
        const before = previous.usage?.[key as keyof ModelCompareUsage];
        assertDomain(before === undefined || value >= before, "conflict", "Recorded compare usage cannot decrease.");
      }
      usage = validateUsage({ ...previous.usage, ...update });
    } else usage = update;
  }
  let provenance = previous.provenance;
  if (patchRecord.provenance !== undefined) {
    const update = validateProvenance(patchRecord.provenance);
    assertDomain(previous.provenance == null || update != null, "conflict", "Recorded compare provenance cannot be cleared.");
    if (update != null) {
      for (const [key, value] of Object.entries(update)) {
        const before = previous.provenance?.[key as keyof ModelCompareProvenance];
        assertDomain(before == null || value === before, "conflict", "Recorded compare provenance cannot change identity.");
      }
      provenance = validateProvenance({ ...previous.provenance, ...update });
    } else provenance = update;
  }
  const terminal = TERMINAL_ATTEMPT_STATUSES.includes(patchRecord.status);
  const attempt = validateAttempt({
    ...previous,
    ...patchRecord,
    id: previous.id,
    candidate: previous.candidate,
    ...(usage === undefined ? {} : { usage }),
    ...(provenance === undefined ? {} : { provenance }),
    ...(terminal ? { completedAt: patchRecord.completedAt ?? new Date().toISOString() } : {}),
  }, run.createdAt);
  const attempts = run.attempts.map((item, itemIndex) => itemIndex === index ? attempt : item);
  const status = aggregateStatus(attempts);
  const completedAt = ["completed", "partial", "failed"].includes(status)
    ? attempts.reduce((latest, item) => Date.parse(item.completedAt!) > Date.parse(latest) ? item.completedAt! : latest, run.createdAt)
    : null;
  return Object.freeze({ ...run, status, attempts: Object.freeze(attempts), completedAt });
}

export function modelCompareIsTerminal(run: ModelCompareRun): boolean {
  validateRunLineage(run);
  return run.status === "completed" || run.status === "partial" || run.status === "failed";
}

/**
 * Creates a merge receipt only after every fan-out attempt reached a terminal
 * state and every selected candidate completed successfully. The receipt is
 * content-free apart from hashes so it can be safely persisted in telemetry.
 */
export function createModelCompareMergeReceipt(input: {
  readonly run: ModelCompareRun;
  readonly selectedAttemptIds: readonly string[];
  readonly strategy: ModelCompareMergeStrategy;
  readonly rationale: string;
  readonly finalOutputSha256: string;
  readonly createdAt: string;
  readonly receiptSha256?: string;
}): ModelCompareMergeReceipt {
  assertKnownKeys(input, ["run", "selectedAttemptIds", "strategy", "rationale", "finalOutputSha256", "createdAt", "receiptSha256"], "Compare merge input");
  assertDomain(modelCompareIsTerminal(input.run), "invalid_state_transition", "A compare run must be terminal before merge receipt creation.");
  assertIsoTimestamp(input.createdAt, "compare merge receipt creation time");
  assertDomain(Date.parse(input.createdAt) >= Date.parse(input.run.completedAt!), "invalid_argument", "Compare merge receipt cannot precede fan-out completion.");
  assertDomain(MERGE_STRATEGIES.includes(input.strategy), "invalid_argument", "Unsupported compare merge strategy.");
  const attemptIds = input.run.attempts.map((attempt) => attempt.id);
  assertDomain(Array.isArray(input.selectedAttemptIds), "invalid_argument", "Selected compare attempt ids must be an array.");
  const selectedAttemptIds = input.selectedAttemptIds.map((id) => text(id, "Selected compare attempt id", 1_025));
  assertDomain(new Set(selectedAttemptIds).size === selectedAttemptIds.length, "conflict", "Selected compare attempt ids must be unique.");
  assertDomain(selectedAttemptIds.length > 0, "invalid_argument", "A compare merge must select at least one attempt.");
  assertDomain(input.strategy !== "best-of" || selectedAttemptIds.length === 1, "invalid_argument", "A best-of compare merge must select exactly one attempt.");
  assertDomain(selectedAttemptIds.every((id) => attemptIds.includes(id)), "not_found", "Merge receipt references an attempt outside the compare run.");
  assertDomain(selectedAttemptIds.every((id) => input.run.attempts.find((attempt) => attempt.id === id)?.status === "completed"), "invalid_state_transition", "Only completed attempts can be selected for a merge.");
  assertSha256(input.finalOutputSha256, "compare final output hash");
  const rationale = text(input.rationale, "compare merge rationale", 8_000);
  if (input.receiptSha256 !== undefined) assertSha256(input.receiptSha256, "compare merge receipt hash");
  return Object.freeze({
    schema: MODEL_COMPARE_SCHEMA,
    compareRunId: input.run.id,
    logicalInputDigest: input.run.logicalInput.digest,
    attemptIds: Object.freeze(attemptIds),
    selectedAttemptIds: Object.freeze(selectedAttemptIds),
    strategy: input.strategy,
    rationale,
    finalOutputSha256: input.finalOutputSha256.trim().toLowerCase(),
    createdAt: input.createdAt,
    ...(input.receiptSha256 === undefined ? {} : { receiptSha256: input.receiptSha256.trim().toLowerCase() }),
  });
}

export function attachModelCompareMergeReceipt(run: ModelCompareRun, receipt: ModelCompareMergeReceipt): ModelCompareRun {
  assertKnownKeys(receipt, ["schema", "compareRunId", "logicalInputDigest", "attemptIds", "selectedAttemptIds", "strategy", "rationale", "finalOutputSha256", "createdAt", "receiptSha256"], "Compare merge receipt");
  assertDomain(receipt.schema === MODEL_COMPARE_SCHEMA, "invalid_argument", "Unsupported compare merge receipt schema.");
  assertDomain(receipt.compareRunId === run.id, "scope_violation", "Merge receipt belongs to another compare run.");
  assertDomain(receipt.logicalInputDigest === run.logicalInput.digest, "scope_violation", "Merge receipt input digest does not match the compare run.");
  assertDomain(Array.isArray(receipt.attemptIds), "invalid_argument", "Compare merge receipt attempt ids must be an array.");
  assertDomain(receipt.attemptIds.length === run.attempts.length && receipt.attemptIds.every((id, index) => id === run.attempts[index]?.id), "conflict", "Merge receipt attempt lineage does not match the compare run.");
  const normalized = createModelCompareMergeReceipt({
    run,
    selectedAttemptIds: receipt.selectedAttemptIds,
    strategy: receipt.strategy,
    rationale: receipt.rationale,
    finalOutputSha256: receipt.finalOutputSha256,
    createdAt: receipt.createdAt,
    ...(receipt.receiptSha256 === undefined ? {} : { receiptSha256: receipt.receiptSha256 }),
  });
  if (run.mergeReceipt !== undefined) {
    assertDomain(JSON.stringify(run.mergeReceipt) === JSON.stringify(normalized), "conflict", "A compare run already owns another immutable merge receipt.");
    return run;
  }
  return Object.freeze({ ...run, mergeReceipt: normalized });
}

export function serializeModelCompareMergeReceipt(receipt: ModelCompareMergeReceipt): string {
  return JSON.stringify(receipt, null, 2);
}

/** Export-safe projection: independent receipts remain attached to each attempt. */
export function serializeModelCompareRun(run: ModelCompareRun): string {
  validateRunLineage(run);
  if (run.mergeReceipt !== undefined) attachModelCompareMergeReceipt(run, run.mergeReceipt);
  return JSON.stringify(run, null, 2);
}

/** Restores a compare snapshot through the same invariants as live recording. */
export function deserializeModelCompareRun(serialized: string): ModelCompareRun {
  assertDomain(typeof serialized === "string" && new TextEncoder().encode(serialized).byteLength <= MAX_COMPARE_CONTENT_BYTES * 6, "invalid_argument", "Compare snapshot exceeds its byte limit.");
  let value: unknown;
  try { value = JSON.parse(serialized) as unknown; }
  catch { assertDomain(false, "invalid_argument", "Compare snapshot must be valid JSON."); }
  assertRecord(value, "Compare snapshot");
  const input = value as unknown as ModelCompareRun;
  validateRunLineage(input);
  const initial = createModelCompareRun({ id: input.id, logicalInput: input.logicalInput, candidates: input.candidates, createdAt: input.createdAt });
  const attempts = input.attempts.map((attempt, index) => validateAttempt({ ...attempt, candidate: initial.candidates[index]! }, input.createdAt));
  const restored: ModelCompareRun = Object.freeze({ ...initial, status: input.status, attempts: Object.freeze(attempts), completedAt: input.completedAt ?? null });
  return input.mergeReceipt === undefined ? restored : attachModelCompareMergeReceipt(restored, input.mergeReceipt);
}

