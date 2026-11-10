import { assertDomain } from "./errors";
import {
  assertIntegerInRange,
  assertIsoTimestamp,
  assertNonBlank,
  stableSort,
  type IsoTimestamp,
} from "./shared";

/**
 * Queue semantics are intentionally kept separate from provider-run state.
 * This module is a renderer/domain planner: it validates and projects an
 * immutable queue snapshot, but it does not grant execution authority or
 * persist work in the native runtime.
 */
export type QueueMode =
  | "interrupt"
  | "steer"
  | "queue"
  | "btw"
  | "parallel"
  | "scheduled"
  | "draft";

export type QueueItemStatus =
  | "draft"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed"
  | "removed";

export type QueueContextPolicy = "none" | "partial" | "full" | "auto";
export type QueueEffort = "fast" | "balanced" | "deep" | "ultra" | "custom";
export type QueueMachineMode =
  | "none"
  | "local_interactive"
  | "local_background"
  | "isolated"
  | "persistent"
  | "remote"
  | "hybrid"
  | "auto";

export interface QueueRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs?: number;
  readonly maxBackoffMs?: number;
}

export interface QueueApprovalPolicy {
  readonly required: boolean;
  readonly scope?: "item" | "batch" | "queue";
}

export interface QueueProvenance {
  readonly actorId: string;
  readonly sourceOperationId?: string;
  readonly conversationId?: string;
  readonly branchId?: string;
  readonly stateRevisionId?: string;
}

/**
 * A queue item contains only a prompt revision reference, never the mutable
 * prompt body. Frozen prompt/context content belongs to a run snapshot.
 */
export interface QueueItem {
  readonly itemId: string;
  readonly batchId?: string;
  readonly mode: QueueMode;
  readonly status: QueueItemStatus;
  readonly orderKey: string;
  readonly priority: number;
  readonly dependencyIds: readonly string[];
  readonly conflictSet: readonly string[];
  readonly promptRevision?: string;
  readonly contextPolicy?: QueueContextPolicy;
  readonly modelProfileId?: string;
  readonly providerConnectionId?: string;
  readonly providerModelId?: string;
  readonly effort?: QueueEffort;
  readonly machineMode?: QueueMachineMode;
  readonly approvalPolicy?: QueueApprovalPolicy;
  readonly retryPolicy?: QueueRetryPolicy;
  readonly scheduledAt?: IsoTimestamp;
  readonly deadlineAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly provenance?: QueueProvenance;
}

export type QueueStatus = "active" | "paused" | "archived";

export interface QueueMutationReceipt {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly queueId: string;
  readonly operation:
    | "enqueue"
    | "reorder"
    | "bulk-status"
    | "promote-btw"
    | "queue-status"
    | "undo-reorder";
  readonly previousRevision: number;
  readonly nextRevision: number;
  readonly changedItemIds: readonly string[];
  readonly createdAt: IsoTimestamp;
  /** Renderer receipts are evidence of a preview mutation, not authority. */
  readonly executionDisposition: "preview-only";
  readonly previousOrderKeys?: Readonly<Record<string, string>>;
  readonly nextOrderKeys?: Readonly<Record<string, string>>;
}

export interface QueueState {
  readonly schemaVersion: 1;
  readonly queueId: string;
  readonly revision: number;
  readonly status: QueueStatus;
  readonly items: readonly QueueItem[];
  readonly receipts: readonly QueueMutationReceipt[];
  readonly updatedAt: IsoTimestamp;
}

export interface QueueMutationResult {
  readonly state: QueueState;
  readonly receipt: QueueMutationReceipt;
}

export interface CreateQueueItemInput {
  readonly itemId: string;
  readonly batchId?: string;
  readonly mode: QueueMode;
  readonly status?: QueueItemStatus;
  readonly orderKey: string;
  readonly priority?: number;
  readonly dependencyIds?: readonly string[];
  readonly conflictSet?: readonly string[];
  readonly promptRevision?: string;
  readonly contextPolicy?: QueueContextPolicy;
  readonly modelProfileId?: string;
  readonly providerConnectionId?: string;
  readonly providerModelId?: string;
  readonly effort?: QueueEffort;
  readonly machineMode?: QueueMachineMode;
  readonly approvalPolicy?: QueueApprovalPolicy;
  readonly retryPolicy?: QueueRetryPolicy;
  readonly scheduledAt?: IsoTimestamp;
  readonly deadlineAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt?: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly provenance?: QueueProvenance;
}

const QUEUE_MODES: readonly QueueMode[] = Object.freeze([
  "interrupt",
  "steer",
  "queue",
  "btw",
  "parallel",
  "scheduled",
  "draft",
]);
const QUEUE_STATUSES: readonly QueueItemStatus[] = Object.freeze([
  "draft",
  "queued",
  "running",
  "paused",
  "completed",
  "cancelled",
  "failed",
  "removed",
]);
const REORDERABLE_STATUSES: readonly QueueItemStatus[] = Object.freeze([
  "draft",
  "queued",
  "paused",
]);
const TERMINAL_STATUSES: readonly QueueItemStatus[] = Object.freeze([
  "completed",
  "cancelled",
  "failed",
  "removed",
]);
const MAX_RECEIPTS = 256;
const MAX_QUEUE_ITEMS = 4096;
const MAX_DEPENDENCIES = 128;
const MAX_CONFLICTS = 128;
const MAX_CHANGED_ITEM_IDS = 1024;
const MAX_ID_LENGTH = 256;
const QUEUE_RECEIPT_OPERATIONS: readonly QueueMutationReceipt["operation"][] = Object.freeze([
  "enqueue",
  "reorder",
  "bulk-status",
  "promote-btw",
  "queue-status",
  "undo-reorder",
]);
const QUEUE_ITEM_KEYS: readonly string[] = Object.freeze([
  "itemId",
  "batchId",
  "mode",
  "status",
  "orderKey",
  "priority",
  "dependencyIds",
  "conflictSet",
  "promptRevision",
  "contextPolicy",
  "modelProfileId",
  "providerConnectionId",
  "providerModelId",
  "effort",
  "machineMode",
  "approvalPolicy",
  "retryPolicy",
  "scheduledAt",
  "deadlineAt",
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "provenance",
]);
const QUEUE_APPROVAL_POLICY_KEYS: readonly string[] = Object.freeze(["required", "scope"]);
const QUEUE_RETRY_POLICY_KEYS: readonly string[] = Object.freeze(["maxAttempts", "backoffMs", "maxBackoffMs"]);
const QUEUE_PROVENANCE_KEYS: readonly string[] = Object.freeze([
  "actorId",
  "sourceOperationId",
  "conversationId",
  "branchId",
  "stateRevisionId",
]);
const QUEUE_STATE_KEYS: readonly string[] = Object.freeze([
  "schemaVersion",
  "queueId",
  "revision",
  "status",
  "items",
  "receipts",
  "updatedAt",
]);
const CREATE_QUEUE_STATE_INPUT_KEYS: readonly string[] = Object.freeze(["queueId", "now", "status", "items"]);
const QUEUE_RECEIPT_KEYS: readonly string[] = Object.freeze([
  "schemaVersion",
  "operationId",
  "queueId",
  "operation",
  "previousRevision",
  "nextRevision",
  "changedItemIds",
  "createdAt",
  "executionDisposition",
  "previousOrderKeys",
  "nextOrderKeys",
]);

function isQueueMode(value: unknown): value is QueueMode {
  return typeof value === "string" && (QUEUE_MODES as readonly string[]).includes(value);
}

function isQueueItemStatus(value: unknown): value is QueueItemStatus {
  return typeof value === "string" && (QUEUE_STATUSES as readonly string[]).includes(value);
}

function isQueueReceiptOperation(value: unknown): value is QueueMutationReceipt["operation"] {
  return typeof value === "string" && (QUEUE_RECEIPT_OPERATIONS as readonly string[]).includes(value);
}

function assertId(value: unknown, label: string): string {
  assertDomain(typeof value === "string", "invalid_argument", `${label} must be a string.`, { label });
  return assertNonBlank(value, label, MAX_ID_LENGTH);
}

function assertQueueNonBlank(value: unknown, label: string, maxLength?: number): string {
  assertDomain(typeof value === "string", "invalid_argument", `${label} must be a string.`, { label });
  return assertNonBlank(value, label, maxLength);
}

function assertQueueIsoTimestamp(value: unknown, label: string): asserts value is IsoTimestamp {
  assertDomain(typeof value === "string", "invalid_argument", `${label} must be an ISO-8601 timestamp.`, { label });
  assertIsoTimestamp(value, label);
}

function assertObject<T>(value: T, label: string): asserts value is T & Record<string, unknown> {
  assertDomain(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_argument", `${label} must be an object.`);
}

function assertKnownKeys(value: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    assertDomain(allowed.has(key), "invalid_argument", `${label} contains an unsupported field.`, { label, key });
  }
}

function assertOptionalId(value: unknown, label: string): void {
  if (value !== undefined) assertId(value, label);
}

function assertStringList(values: readonly string[], label: string, max: number): readonly string[] {
  assertDomain(Array.isArray(values), "invalid_argument", `${label} must be an array.`);
  assertDomain(values.length <= max, "invalid_argument", `${label} cannot contain more than ${max} entries.`, {
    label,
    max,
  });
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = assertId(value, `${label} entry`);
    assertDomain(!seen.has(normalized), "conflict", `${label} cannot contain duplicates.`, {
      label,
      value: normalized,
    });
    seen.add(normalized);
  }
  return Object.freeze([...seen]);
}

function assertQueueMode(value: unknown, label = "queue mode"): asserts value is QueueMode {
  assertDomain(isQueueMode(value), "invalid_argument", `${label} is unsupported.`, { value });
}

function assertQueueStatus(value: unknown, label = "queue item status"): asserts value is QueueItemStatus {
  assertDomain(isQueueItemStatus(value), "invalid_argument", `${label} is unsupported.`, { value });
}

function assertContextPolicy(value: unknown): void {
  if (value !== undefined) {
    assertDomain(typeof value === "string", "invalid_argument", "Unsupported queue context policy.", { value });
    assertDomain(["none", "partial", "full", "auto"].includes(value), "invalid_argument", "Unsupported queue context policy.", { value });
  }
}

function assertEffort(value: unknown): void {
  if (value !== undefined) {
    assertDomain(typeof value === "string", "invalid_argument", "Unsupported queue effort.", { value });
    assertDomain(["fast", "balanced", "deep", "ultra", "custom"].includes(value), "invalid_argument", "Unsupported queue effort.", { value });
  }
}

function assertMachineMode(value: unknown): void {
  if (value !== undefined) {
    assertDomain(typeof value === "string", "invalid_argument", "Unsupported queue machine mode.", { value });
    assertDomain(
      ["none", "local_interactive", "local_background", "isolated", "persistent", "remote", "hybrid", "auto"].includes(value),
      "invalid_argument",
      "Unsupported queue machine mode.",
      { value },
    );
  }
}

function assertApprovalPolicy(value: unknown, label = "queue approval policy"): void {
  if (value === undefined) return;
  assertDomain(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_argument", `${label} must be an object.`);
  assertKnownKeys(value as Record<string, unknown>, QUEUE_APPROVAL_POLICY_KEYS, label);
  const policy = value as Partial<QueueApprovalPolicy>;
  assertDomain(typeof policy.required === "boolean", "invalid_argument", "Queue approval policy requires a boolean.");
  if (policy.scope !== undefined) {
    assertDomain(["item", "batch", "queue"].includes(policy.scope), "invalid_argument", "Unsupported queue approval scope.", { scope: policy.scope });
  }
}

function assertRetryPolicy(value: unknown, label = "queue retry policy"): void {
  if (value === undefined) return;
  assertDomain(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_argument", `${label} must be an object.`);
  assertKnownKeys(value as Record<string, unknown>, QUEUE_RETRY_POLICY_KEYS, label);
  const policy = value as Partial<QueueRetryPolicy>;
  assertDomain(typeof policy.maxAttempts === "number", "invalid_argument", "Queue retry policy requires maxAttempts.");
  assertIntegerInRange(policy.maxAttempts, "queue retry maximum", 0, 100);
  if (policy.backoffMs !== undefined) assertIntegerInRange(policy.backoffMs, "queue retry backoff", 0, 86_400_000);
  if (policy.maxBackoffMs !== undefined) assertIntegerInRange(policy.maxBackoffMs, "queue retry maximum backoff", 0, 86_400_000);
  if (policy.backoffMs !== undefined && policy.maxBackoffMs !== undefined) {
    assertDomain(policy.maxBackoffMs >= policy.backoffMs, "invalid_argument", "Queue maximum backoff cannot be below base backoff.");
  }
}

function assertProvenance(value: unknown, label = "queue provenance"): void {
  if (value === undefined) return;
  assertDomain(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_argument", `${label} must be an object.`);
  assertKnownKeys(value as Record<string, unknown>, QUEUE_PROVENANCE_KEYS, label);
  const provenance = value as Partial<QueueProvenance>;
  assertId(provenance.actorId, "queue provenance actor ID");
  assertOptionalId(provenance.sourceOperationId, "queue source operation ID");
  assertOptionalId(provenance.conversationId, "queue provenance conversation ID");
  assertOptionalId(provenance.branchId, "queue provenance branch ID");
  assertOptionalId(provenance.stateRevisionId, "queue provenance state revision ID");
}

function assertQueueItemRecord(value: unknown): asserts value is QueueItem {
  assertObject(value, "Queue item");
  assertKnownKeys(value, QUEUE_ITEM_KEYS, "Queue item");
  const item = value as unknown as QueueItem;
  assertId(item.itemId, "queue item ID");
  assertQueueMode(item.mode);
  assertQueueStatus(item.status);
  assertQueueNonBlank(item.orderKey, "queue order key", MAX_ID_LENGTH);
  assertIntegerInRange(item.priority, "queue priority", -1000, 1000);
  assertStringList(item.dependencyIds, "queue dependencies", MAX_DEPENDENCIES);
  assertStringList(item.conflictSet, "queue conflicts", MAX_CONFLICTS);
  assertDomain(!item.conflictSet.includes(item.itemId), "invalid_argument", "A queue item cannot conflict with itself.", { itemId: item.itemId });
  assertOptionalId(item.batchId, "queue batch ID");
  assertOptionalId(item.promptRevision, "queue prompt revision");
  assertOptionalId(item.modelProfileId, "queue model profile ID");
  assertOptionalId(item.providerConnectionId, "queue provider connection ID");
  if (item.providerModelId !== undefined) assertQueueNonBlank(item.providerModelId, "queue provider model ID", 512);
  assertContextPolicy(item.contextPolicy);
  assertEffort(item.effort);
  assertMachineMode(item.machineMode);
  assertApprovalPolicy(item.approvalPolicy);
  assertRetryPolicy(item.retryPolicy);
  assertProvenance(item.provenance);
  assertDomain(item.mode === "scheduled" ? item.scheduledAt !== undefined : item.scheduledAt === undefined, "invalid_argument", "Only scheduled queue items may carry scheduledAt.", { itemId: item.itemId });
  assertQueueItemStatusInvariants(item);
  assertTemporalOrder(item);
}

function assertQueueItemStatusInvariants(item: Pick<QueueItem, "itemId" | "mode" | "status" | "startedAt" | "completedAt">): void {
  assertDomain(
    item.mode === "draft" ? item.status === "draft" : item.status !== "draft",
    "invalid_argument",
    "Draft queue mode and status must agree.",
    { itemId: item.itemId },
  );
  if (item.status === "running") {
    assertDomain(item.startedAt !== undefined, "invalid_argument", "Running queue items require startedAt.", { itemId: item.itemId });
  } else if (!TERMINAL_STATUSES.includes(item.status)) {
    assertDomain(item.startedAt === undefined, "invalid_argument", "Only running queue items may carry startedAt.", { itemId: item.itemId });
  }
  if (item.status === "removed") {
    assertDomain(item.completedAt === undefined, "invalid_argument", "Removed queue items cannot carry completedAt.", { itemId: item.itemId });
  } else if (TERMINAL_STATUSES.includes(item.status)) {
    assertDomain(item.completedAt !== undefined, "invalid_argument", "Terminal queue items require completedAt.", { itemId: item.itemId });
  } else {
    assertDomain(item.completedAt === undefined, "invalid_argument", "Only terminal queue items may carry completedAt.", { itemId: item.itemId });
  }
}

function assertQueueItemObservedAt(item: QueueItem, now: IsoTimestamp, label: string): void {
  assertQueueIsoTimestamp(now, label);
  const observedAt = Date.parse(now);
  for (const [field, value] of [
    ["createdAt", item.createdAt],
    ["updatedAt", item.updatedAt],
    ["startedAt", item.startedAt],
    ["completedAt", item.completedAt],
  ] as const) {
    if (value !== undefined) {
      assertDomain(Date.parse(value) <= observedAt, "invalid_argument", `Queue item ${field} cannot be after ${label}.`, {
        itemId: item.itemId,
        field,
        value,
        observedAt: now,
      });
    }
  }
}

function assertTemporalOrder(item: Pick<QueueItem, "createdAt" | "updatedAt" | "scheduledAt" | "deadlineAt" | "startedAt" | "completedAt">): void {
  assertQueueIsoTimestamp(item.createdAt, "queue item creation time");
  assertQueueIsoTimestamp(item.updatedAt, "queue item update time");
  const createdAt = Date.parse(item.createdAt);
  const updatedAt = Date.parse(item.updatedAt);
  assertDomain(updatedAt >= createdAt, "invalid_argument", "Queue item update time cannot precede creation time.");
  if (item.scheduledAt !== undefined) {
    assertQueueIsoTimestamp(item.scheduledAt, "queue scheduled time");
    assertDomain(Date.parse(item.scheduledAt) >= createdAt, "invalid_argument", "Queue scheduled time cannot precede creation time.");
  }
  if (item.deadlineAt !== undefined) {
    assertQueueIsoTimestamp(item.deadlineAt, "queue deadline");
    assertDomain(Date.parse(item.deadlineAt) >= createdAt, "invalid_argument", "Queue deadline cannot precede creation time.");
    if (item.scheduledAt !== undefined) {
      assertDomain(Date.parse(item.deadlineAt) >= Date.parse(item.scheduledAt), "invalid_argument", "Queue deadline cannot precede scheduled time.");
    }
  }
  if (item.startedAt !== undefined) {
    assertQueueIsoTimestamp(item.startedAt, "queue start time");
    assertDomain(Date.parse(item.startedAt) >= createdAt, "invalid_argument", "Queue start time cannot precede creation time.");
    assertDomain(Date.parse(item.startedAt) <= updatedAt, "invalid_argument", "Queue start time cannot be after the latest update.");
  }
  if (item.completedAt !== undefined) {
    assertQueueIsoTimestamp(item.completedAt, "queue completion time");
    assertDomain(Date.parse(item.completedAt) >= createdAt, "invalid_argument", "Queue completion time cannot precede creation time.");
    assertDomain(Date.parse(item.completedAt) >= (item.startedAt === undefined ? createdAt : Date.parse(item.startedAt)), "invalid_argument", "Queue completion time cannot precede start time.");
    assertDomain(Date.parse(item.completedAt) <= updatedAt, "invalid_argument", "Queue completion time cannot be after the latest update.");
  }
}

function freezeQueueItem(item: QueueItem): QueueItem {
  return Object.freeze({
    ...item,
    dependencyIds: Object.freeze([...item.dependencyIds]),
    conflictSet: Object.freeze([...item.conflictSet]),
    ...(item.approvalPolicy === undefined ? {} : { approvalPolicy: Object.freeze({ ...item.approvalPolicy }) }),
    ...(item.retryPolicy === undefined ? {} : { retryPolicy: Object.freeze({ ...item.retryPolicy }) }),
    ...(item.provenance === undefined ? {} : { provenance: Object.freeze({ ...item.provenance }) }),
  });
}

function freezeOrderKeyMap(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const copy = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(value)) copy[key] = value[key]!;
  return Object.freeze(copy);
}

function freezeReceipt(receipt: QueueMutationReceipt): QueueMutationReceipt {
  return Object.freeze({
    ...receipt,
    changedItemIds: Object.freeze([...receipt.changedItemIds]),
    ...(receipt.previousOrderKeys === undefined ? {} : { previousOrderKeys: freezeOrderKeyMap(receipt.previousOrderKeys) }),
    ...(receipt.nextOrderKeys === undefined ? {} : { nextOrderKeys: freezeOrderKeyMap(receipt.nextOrderKeys) }),
  });
}

/**
 * Compares the immutable receipt fields that establish a reorder's identity
 * and proof.  Receipts may cross a JSON boundary, so this deliberately uses
 * structural equality instead of object identity.
 */
function sameStringSequence(left: readonly string[], right: readonly string[]): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameOrderKeyMap(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) || Array.isArray(right)) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (!sameStringSequence(leftKeys, rightKeys)) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function sameQueueReceipt(left: QueueMutationReceipt, right: QueueMutationReceipt): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.operationId === right.operationId &&
    left.queueId === right.queueId &&
    left.operation === right.operation &&
    left.previousRevision === right.previousRevision &&
    left.nextRevision === right.nextRevision &&
    sameStringSequence(left.changedItemIds, right.changedItemIds) &&
    left.createdAt === right.createdAt &&
    left.executionDisposition === right.executionDisposition &&
    sameOrderKeyMap(left.previousOrderKeys, right.previousOrderKeys) &&
    sameOrderKeyMap(left.nextOrderKeys, right.nextOrderKeys)
  );
}

function freezeState(state: QueueState): QueueState {
  return Object.freeze({
    ...state,
    items: Object.freeze(state.items.map(freezeQueueItem)),
    receipts: Object.freeze(state.receipts.map(freezeReceipt)),
  });
}

function assertExpectedRevision(state: QueueState, expectedRevision: number): void {
  assertIntegerInRange(expectedRevision, "expected queue revision", 0, Number.MAX_SAFE_INTEGER);
  assertDomain(
    state.revision === expectedRevision,
    "conflict",
    "Queue revision is stale; refresh the queue before applying the mutation.",
    { queueId: state.queueId, expectedRevision, actualRevision: state.revision },
  );
}

function assertQueueMutable(state: QueueState, operation: string): void {
  assertDomain(
    state.status !== "archived",
    "invalid_state_transition",
    "Archived queues are immutable.",
    { queueId: state.queueId, operation },
  );
}

function nextReceipt(
  state: QueueState,
  operation: QueueMutationReceipt["operation"],
  operationId: string,
  changedItemIds: readonly string[],
  now: IsoTimestamp,
  extras: Pick<QueueMutationReceipt, "previousOrderKeys" | "nextOrderKeys"> = {},
): QueueMutationReceipt {
  assertId(operationId, "queue operation ID");
  assertQueueIsoTimestamp(now, "queue operation time");
  assertDomain(
    Date.parse(now) >= Date.parse(state.updatedAt),
    "invalid_argument",
    "Queue operation time cannot precede the current queue update time.",
    { queueId: state.queueId, operationTime: now, currentUpdateTime: state.updatedAt },
  );
  assertDomain(
    !state.receipts.some((receipt) => receipt.operationId === operationId),
    "conflict",
    "Queue operation ID has already been used in the retained receipt history.",
    { queueId: state.queueId, operationId },
  );
  return freezeReceipt({
    schemaVersion: 1,
    operationId,
    queueId: state.queueId,
    operation,
    previousRevision: state.revision,
    nextRevision: state.revision + 1,
    changedItemIds: [...new Set(changedItemIds)],
    createdAt: now,
    executionDisposition: "preview-only",
    ...extras,
  });
}

function withMutation(
  state: QueueState,
  receipt: QueueMutationReceipt,
  items: readonly QueueItem[],
  status: QueueStatus = state.status,
): QueueMutationResult {
  const nextState = freezeState({
    ...state,
    revision: receipt.nextRevision,
    status,
    items,
    receipts: [...state.receipts, receipt].slice(-MAX_RECEIPTS),
    updatedAt: receipt.createdAt,
  });
  validateQueueState(nextState);
  return Object.freeze({ state: nextState, receipt });
}

/** Creates a validated immutable queue item. */
export function createQueueItem(input: CreateQueueItemInput): QueueItem {
  assertObject(input, "Queue item input");
  assertKnownKeys(input, QUEUE_ITEM_KEYS, "Queue item input");
  const itemId = assertId(input.itemId, "queue item ID");
  assertQueueMode(input.mode);
  const status = input.status === undefined ? (input.mode === "draft" ? "draft" : "queued") : input.status;
  assertQueueStatus(status);
  assertId(input.orderKey, "queue order key");
  const priority = input.priority === undefined ? 0 : input.priority;
  assertIntegerInRange(priority, "queue priority", -1000, 1000);
  const dependencyIds = assertStringList(input.dependencyIds === undefined ? [] : input.dependencyIds, "queue dependencies", MAX_DEPENDENCIES);
  const conflictSet = assertStringList(input.conflictSet === undefined ? [] : input.conflictSet, "queue conflicts", MAX_CONFLICTS);
  assertDomain(!conflictSet.includes(itemId), "invalid_argument", "A queue item cannot conflict with itself.", { itemId });
  assertOptionalId(input.batchId, "queue batch ID");
  assertOptionalId(input.promptRevision, "queue prompt revision");
  assertOptionalId(input.modelProfileId, "queue model profile ID");
  assertOptionalId(input.providerConnectionId, "queue provider connection ID");
  if (input.providerModelId !== undefined) assertQueueNonBlank(input.providerModelId, "queue provider model ID", 512);
  assertContextPolicy(input.contextPolicy);
  assertEffort(input.effort);
  assertMachineMode(input.machineMode);
  assertApprovalPolicy(input.approvalPolicy);
  assertRetryPolicy(input.retryPolicy);
  assertProvenance(input.provenance);
  const updatedAt = input.updatedAt === undefined ? input.createdAt : input.updatedAt;
  const item: QueueItem = {
    itemId,
    ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
    mode: input.mode,
    status,
    orderKey: assertNonBlank(input.orderKey, "queue order key", MAX_ID_LENGTH),
    priority,
    dependencyIds,
    conflictSet,
    ...(input.promptRevision === undefined ? {} : { promptRevision: input.promptRevision }),
    ...(input.contextPolicy === undefined ? {} : { contextPolicy: input.contextPolicy }),
    ...(input.modelProfileId === undefined ? {} : { modelProfileId: input.modelProfileId }),
    ...(input.providerConnectionId === undefined ? {} : { providerConnectionId: input.providerConnectionId }),
    ...(input.providerModelId === undefined ? {} : { providerModelId: assertQueueNonBlank(input.providerModelId, "queue provider model ID", 512) }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.machineMode === undefined ? {} : { machineMode: input.machineMode }),
    ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: { ...input.approvalPolicy } }),
    ...(input.retryPolicy === undefined ? {} : { retryPolicy: { ...input.retryPolicy } }),
    ...(input.scheduledAt === undefined ? {} : { scheduledAt: input.scheduledAt }),
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
    createdAt: input.createdAt,
    updatedAt,
    ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
    ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
    ...(input.provenance === undefined ? {} : { provenance: { ...input.provenance } }),
  };
  assertDomain(item.mode === "scheduled" ? item.scheduledAt !== undefined : item.scheduledAt === undefined, "invalid_argument", "Only scheduled queue items may carry scheduledAt.", { itemId });
  assertQueueItemStatusInvariants(item);
  assertTemporalOrder(item);
  return freezeQueueItem(item);
}

/** Throws on malformed items, duplicate IDs, missing dependencies, or cycles. */
export function validateQueueItems(items: readonly QueueItem[]): void {
  assertDomain(Array.isArray(items), "invalid_argument", "Queue items must be an array.");
  assertDomain(items.length <= MAX_QUEUE_ITEMS, "invalid_argument", `Queue cannot contain more than ${MAX_QUEUE_ITEMS} items.`, {
    max: MAX_QUEUE_ITEMS,
  });
  const byId = new Map<string, QueueItem>();
  for (const item of items) {
    assertQueueItemRecord(item);
    assertDomain(!byId.has(item.itemId), "conflict", "Queue contains duplicate item IDs.", { itemId: item.itemId });
    byId.set(item.itemId, item);
  }
  for (const item of items) {
    for (const dependencyId of item.dependencyIds) {
      assertDomain(byId.has(dependencyId), "not_found", "Queue item depends on an unknown item.", { itemId: item.itemId, dependencyId });
      assertDomain(dependencyId !== item.itemId, "conflict", "Queue item cannot depend on itself.", { itemId: item.itemId });
    }
  }
  const visitState = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();
  type DependencyFrame = { readonly itemId: string; dependencyIndex: number };
  const frames: DependencyFrame[] = [];
  for (const root of items) {
    if (visitState.get(root.itemId) === "done") continue;
    visitState.set(root.itemId, "visiting");
    stack.push(root.itemId);
    stackIndex.set(root.itemId, stack.length - 1);
    frames.push({ itemId: root.itemId, dependencyIndex: 0 });
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const item = byId.get(frame.itemId)!;
      if (frame.dependencyIndex >= item.dependencyIds.length) {
        frames.pop();
        stack.pop();
        stackIndex.delete(frame.itemId);
        visitState.set(frame.itemId, "done");
        continue;
      }
      const dependencyId = item.dependencyIds[frame.dependencyIndex]!;
      frame.dependencyIndex += 1;
      const dependencyState = visitState.get(dependencyId);
      if (dependencyState === "done") continue;
      if (dependencyState === "visiting") {
        const cycleStart = stackIndex.get(dependencyId);
        assertDomain(cycleStart !== undefined, "invalid_state_transition", "Queue dependency traversal lost its active stack frame.");
        const cycle = [...stack.slice(cycleStart), dependencyId];
        assertDomain(false, "conflict", `Queue dependency cycle: ${cycle.join(" -> ")}`, { cycle });
      }
      visitState.set(dependencyId, "visiting");
      stack.push(dependencyId);
      stackIndex.set(dependencyId, stack.length - 1);
      frames.push({ itemId: dependencyId, dependencyIndex: 0 });
    }
  }
}

export interface CreateQueueStateInput {
  readonly queueId: string;
  readonly now: IsoTimestamp;
  readonly status?: QueueStatus;
  readonly items?: readonly QueueItem[];
}

export function createQueueState(input: CreateQueueStateInput): QueueState {
  assertObject(input, "Queue state input");
  assertKnownKeys(input, CREATE_QUEUE_STATE_INPUT_KEYS, "Queue state input");
  const queueId = assertId(input.queueId, "queue ID");
  assertQueueIsoTimestamp(input.now, "queue creation time");
  const status = input.status === undefined ? "active" : input.status;
  assertDomain(["active", "paused", "archived"].includes(status), "invalid_argument", "Unsupported queue status.", { status });
  assertDomain(input.items === undefined || Array.isArray(input.items), "invalid_argument", "Queue items must be an array.");
  const items = Object.freeze([...(input.items ?? [])]);
  validateQueueItems(items);
  for (const item of items) assertQueueItemObservedAt(item, input.now, "queue snapshot time");
  return freezeState({ schemaVersion: 1, queueId, revision: 0, status, items, receipts: [], updatedAt: input.now });
}

export function enqueueQueueItem(
  state: QueueState,
  item: QueueItem,
  input: { readonly expectedRevision: number; readonly operationId: string; readonly now: IsoTimestamp },
): QueueMutationResult {
  validateQueueState(state);
  assertObject(input, "Queue enqueue input");
  assertExpectedRevision(state, input.expectedRevision);
  assertQueueIsoTimestamp(input.now, "queue enqueue time");
  assertQueueMutable(state, "enqueue");
  assertDomain(state.items.length < MAX_QUEUE_ITEMS, "invalid_argument", `Queue cannot contain more than ${MAX_QUEUE_ITEMS} items.`, {
    max: MAX_QUEUE_ITEMS,
  });
  assertQueueItemRecord(item);
  assertQueueItemObservedAt(item, input.now, "queue enqueue time");
  assertDomain(!state.items.some((candidate) => candidate.itemId === item.itemId), "conflict", "Queue item ID already exists.", { itemId: item.itemId });
  assertDomain(item.status === "draft" || item.status === "queued", "invalid_state_transition", "Only draft or queued items may be enqueued.", { itemId: item.itemId, status: item.status });
  assertDomain(Date.parse(item.createdAt) <= Date.parse(input.now), "invalid_argument", "Queue item cannot be enqueued before its creation time.", { itemId: item.itemId });
  assertQueueItemObservedAt(item, input.now, "enqueue time");
  const receipt = nextReceipt(state, "enqueue", input.operationId, [item.itemId], input.now);
  return withMutation(state, receipt, [...state.items, item]);
}

export interface QueueReadiness {
  readonly item: QueueItem;
  readonly eligible: boolean;
  readonly reason:
    | "ready"
    | "queue-paused"
    | "not-queued"
    | "dependency-pending"
    | "dependency-failed"
    | "scheduled-for-later"
    | "deadline-expired"
    | "conflict-active";
  readonly blockedBy: readonly string[];
}

const MODE_RANK: Readonly<Record<QueueMode, number>> = Object.freeze({
  interrupt: 0,
  steer: 1,
  btw: 2,
  queue: 3,
  parallel: 4,
  scheduled: 5,
  draft: 6,
});

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

/**
 * Computes deterministic renderer-side readiness. It never starts a run and
 * never treats `eligible` as native execution authority.
 */
export function projectQueueReadiness(
  state: QueueState,
  now: IsoTimestamp,
  activeItemIds: readonly string[] = [],
): readonly QueueReadiness[] {
  assertQueueIsoTimestamp(now, "queue readiness time");
  assertDomain(Array.isArray(activeItemIds), "invalid_argument", "Active queue item IDs must be an array.");
  validateQueueState(state);
  const activeIds = assertStringList(activeItemIds, "active queue item IDs", MAX_CHANGED_ITEM_IDS);
  const active = new Set(activeIds);
  for (const itemId of active) {
    const activeItem = state.items.find((item) => item.itemId === itemId);
    assertDomain(activeItem !== undefined, "not_found", "Active queue item was not found.", { itemId });
    assertDomain(activeItem.status === "running", "invalid_argument", "Only running items may be active.", { itemId });
  }
  const byId = new Map(state.items.map((item) => [item.itemId, item]));
  const projections = state.items.map((item): QueueReadiness => {
    if (state.status !== "active") return { item, eligible: false, reason: "queue-paused", blockedBy: [] };
    if (item.status !== "queued") return { item, eligible: false, reason: "not-queued", blockedBy: [] };
    const dependencies = item.dependencyIds.map((dependencyId) => byId.get(dependencyId)!);
    const failedDependencies = dependencies.filter((dependency) => TERMINAL_STATUSES.includes(dependency.status) && dependency.status !== "completed");
    if (failedDependencies.length > 0) return { item, eligible: false, reason: "dependency-failed", blockedBy: failedDependencies.map((dependency) => dependency.itemId) };
    const pendingDependencies = dependencies.filter((dependency) => dependency.status !== "completed");
    if (pendingDependencies.length > 0) return { item, eligible: false, reason: "dependency-pending", blockedBy: pendingDependencies.map((dependency) => dependency.itemId) };
    if (item.scheduledAt !== undefined && Date.parse(item.scheduledAt) > Date.parse(now)) return { item, eligible: false, reason: "scheduled-for-later", blockedBy: [] };
    if (item.deadlineAt !== undefined && Date.parse(item.deadlineAt) < Date.parse(now)) return { item, eligible: false, reason: "deadline-expired", blockedBy: [] };
    const conflicting = state.items.filter((candidate) => active.has(candidate.itemId) && (intersects(item.conflictSet, candidate.conflictSet) || item.conflictSet.includes(candidate.itemId) || candidate.conflictSet.includes(item.itemId))).map((candidate) => candidate.itemId);
    if (conflicting.length > 0) return { item, eligible: false, reason: "conflict-active", blockedBy: conflicting };
    return { item, eligible: true, reason: "ready", blockedBy: [] };
  });
  return Object.freeze(stableSort(projections, (left, right) => {
    if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
    if (left.eligible && right.eligible) {
      const modeDelta = MODE_RANK[left.item.mode] - MODE_RANK[right.item.mode];
      if (modeDelta !== 0) return modeDelta;
      const priorityDelta = right.item.priority - left.item.priority;
      if (priorityDelta !== 0) return priorityDelta;
    }
    const orderDelta = left.item.orderKey.localeCompare(right.item.orderKey);
    return orderDelta || left.item.itemId.localeCompare(right.item.itemId);
  }));
}

export function readyQueueItems(state: QueueState, now: IsoTimestamp, activeItemIds: readonly string[] = []): readonly QueueItem[] {
  return Object.freeze(projectQueueReadiness(state, now, activeItemIds).filter((entry) => entry.eligible).map((entry) => entry.item));
}

export interface ReorderQueueInput {
  readonly expectedRevision: number;
  readonly operationId: string;
  readonly orderedItemIds: readonly string[];
  readonly now: IsoTimestamp;
}

function reorderableItems(state: QueueState): readonly QueueItem[] {
  return state.items.filter((item) => REORDERABLE_STATUSES.includes(item.status));
}

export function reorderQueueItems(state: QueueState, input: ReorderQueueInput): QueueMutationResult {
  validateQueueState(state);
  assertObject(input, "Queue reorder input");
  assertExpectedRevision(state, input.expectedRevision);
  assertQueueIsoTimestamp(input.now, "queue reorder time");
  assertQueueMutable(state, "reorder");
  assertDomain(Array.isArray(input.orderedItemIds), "invalid_argument", "Queue reorder item IDs must be an array.");
  const orderedItemIds = assertStringList(input.orderedItemIds, "queue reorder item IDs", MAX_CHANGED_ITEM_IDS);
  const reorderable = reorderableItems(state);
  assertDomain(orderedItemIds.length === reorderable.length, "invalid_argument", "Reorder must include every pending queue item exactly once.");
  const expectedIds = new Set(reorderable.map((item) => item.itemId));
  const providedIds = new Set(orderedItemIds);
  assertDomain(providedIds.size === orderedItemIds.length, "conflict", "Reorder contains duplicate queue item IDs.");
  assertDomain(orderedItemIds.every((itemId) => expectedIds.has(itemId)), "scope_violation", "Reorder references an item outside the pending queue.");
  assertDomain([...expectedIds].every((itemId) => providedIds.has(itemId)), "invalid_argument", "Reorder omits a pending queue item.");
  const previousOrderKeys = Object.create(null) as Record<string, string>;
  const nextOrderKeys = Object.create(null) as Record<string, string>;
  const keyWidth = Math.max(4, String(orderedItemIds.length).length);
  const keyFor = (index: number): string => String(index + 1).padStart(keyWidth, "0");
  const orderById = new Map(orderedItemIds.map((itemId, index) => [itemId, keyFor(index)]));
  const items = state.items.map((item) => {
    const nextOrderKey = orderById.get(item.itemId);
    if (nextOrderKey === undefined) return item;
    previousOrderKeys[item.itemId] = item.orderKey;
    nextOrderKeys[item.itemId] = nextOrderKey;
    return freezeQueueItem({ ...item, orderKey: nextOrderKey, updatedAt: input.now });
  });
  const receipt = nextReceipt(state, "reorder", input.operationId, orderedItemIds, input.now, { previousOrderKeys, nextOrderKeys });
  return withMutation(state, receipt, items);
}

export function undoQueueReorder(
  state: QueueState,
  receipt: QueueMutationReceipt,
  input: { readonly expectedRevision: number; readonly operationId: string; readonly now: IsoTimestamp },
): QueueMutationResult {
  validateQueueState(state);
  assertObject(input, "Queue undo input");
  assertObject(receipt, "Queue reorder receipt");
  assertQueueMutable(state, "undo-reorder");
  assertExpectedRevision(state, input.expectedRevision);
  assertQueueIsoTimestamp(input.now, "queue undo time");
  assertDomain(isQueueReceiptOperation(receipt.operation), "invalid_argument", "Queue receipt operation is unsupported.", { operation: receipt.operation });
  assertDomain(receipt.queueId === state.queueId, "scope_violation", "Reorder receipt belongs to another queue.");
  assertDomain(receipt.operation === "reorder", "invalid_argument", "Only reorder receipts can be undone.");
  assertDomain(receipt.nextRevision === state.revision, "conflict", "Reorder receipt is not the current queue revision.");
  assertDomain(receipt.nextOrderKeys !== undefined && receipt.previousOrderKeys !== undefined, "invalid_argument", "Reorder receipt is missing its order-key proof.");
  const latestReceipt = state.receipts.at(-1);
  assertDomain(
    latestReceipt !== undefined && latestReceipt.operation === "reorder",
    "conflict",
    "Only the latest retained reorder receipt can be undone.",
    { queueId: state.queueId, revision: state.revision },
  );
  assertDomain(
    sameQueueReceipt(receipt, latestReceipt),
    "conflict",
    "Reorder receipt does not match the latest retained queue receipt.",
    { queueId: state.queueId, revision: state.revision, operationId: receipt.operationId },
  );
  const previousOrderKeys = receipt.previousOrderKeys;
  const nextOrderKeys = receipt.nextOrderKeys;
  for (const item of state.items) {
    if (Object.prototype.hasOwnProperty.call(nextOrderKeys, item.itemId)) {
      const expectedCurrent = nextOrderKeys[item.itemId];
      assertDomain(item.orderKey === expectedCurrent, "conflict", "Queue order changed after the reorder; undo is stale.", { itemId: item.itemId });
    }
  }
  const items = state.items.map((item) => {
    if (!Object.prototype.hasOwnProperty.call(previousOrderKeys, item.itemId)) return item;
    const previousOrderKey = previousOrderKeys[item.itemId]!;
    return freezeQueueItem({ ...item, orderKey: previousOrderKey, updatedAt: input.now });
  });
  const undoReceipt = nextReceipt(state, "undo-reorder", input.operationId, Object.keys(previousOrderKeys), input.now, {
    previousOrderKeys: nextOrderKeys,
    nextOrderKeys: previousOrderKeys,
  });
  return withMutation(state, undoReceipt, items);
}

export type QueueBulkAction =
  | "pause"
  | "resume"
  | "cancel"
  | "remove";

export function applyQueueBulkAction(
  state: QueueState,
  input: {
    readonly expectedRevision: number;
    readonly operationId: string;
    readonly itemIds: readonly string[];
    readonly action: QueueBulkAction;
    readonly now: IsoTimestamp;
  },
): QueueMutationResult {
  validateQueueState(state);
  assertObject(input, "Queue bulk action input");
  assertExpectedRevision(state, input.expectedRevision);
  assertQueueIsoTimestamp(input.now, "queue bulk action time");
  assertQueueMutable(state, "bulk-status");
  assertDomain(Array.isArray(input.itemIds), "invalid_argument", "Bulk queue item IDs must be an array.");
  assertDomain(typeof input.action === "string" && ["pause", "resume", "cancel", "remove"].includes(input.action), "invalid_argument", "Unsupported queue bulk action.", { action: input.action });
  assertDomain(input.itemIds.length > 0, "invalid_argument", "A bulk action requires at least one queue item.");
  const ids = assertStringList(input.itemIds, "bulk queue item IDs", 256);
  const existingIds = new Set(state.items.map((item) => item.itemId));
  for (const itemId of ids) {
    assertDomain(existingIds.has(itemId), "not_found", "Bulk action references an unknown queue item.", { itemId });
  }
  const selected = new Set(ids);
  const items = state.items.map((item) => {
    if (!selected.has(item.itemId)) return item;
    let nextStatus: QueueItemStatus = item.status;
    if (input.action === "pause") {
      assertDomain(item.status === "queued" || item.status === "paused", "invalid_state_transition", "Only queued items may be paused by the queue planner.", { itemId: item.itemId, status: item.status });
      nextStatus = "paused";
    } else if (input.action === "resume") {
      assertDomain(item.status === "paused", "invalid_state_transition", "Only paused items may be resumed.", { itemId: item.itemId, status: item.status });
      nextStatus = "queued";
    } else if (input.action === "cancel") {
      assertDomain(item.status === "queued" || item.status === "paused", "invalid_state_transition", "Running items require run-control cancellation, not queue cancellation.", { itemId: item.itemId, status: item.status });
      nextStatus = "cancelled";
    } else if (input.action === "remove") {
      assertDomain(item.status !== "running", "invalid_state_transition", "Running items cannot be removed from the queue planner.", { itemId: item.itemId });
      nextStatus = "removed";
    }
    const nextItem = { ...item, status: nextStatus, updatedAt: input.now };
    if (nextStatus === "cancelled" && nextItem.completedAt === undefined) nextItem.completedAt = input.now;
    if (nextStatus === "removed") delete nextItem.completedAt;
    return freezeQueueItem(nextItem);
  });
  const receipt = nextReceipt(state, "bulk-status", input.operationId, ids, input.now);
  return withMutation(state, receipt, items);
}

export function promoteBtwItem(
  state: QueueState,
  input: { readonly expectedRevision: number; readonly operationId: string; readonly itemId: string; readonly now: IsoTimestamp },
): QueueMutationResult {
  validateQueueState(state);
  assertObject(input, "Queue promotion input");
  assertExpectedRevision(state, input.expectedRevision);
  assertQueueIsoTimestamp(input.now, "queue promotion time");
  assertQueueMutable(state, "promote-btw");
  assertId(input.itemId, "queue item ID");
  const itemIndex = state.items.findIndex((item) => item.itemId === input.itemId);
  assertDomain(itemIndex >= 0, "not_found", "Queue item was not found.", { itemId: input.itemId });
  const item = state.items[itemIndex]!;
  assertDomain(item.mode === "btw", "invalid_argument", "Only Btw items can be promoted.", { itemId: input.itemId, mode: item.mode });
  assertDomain(item.status === "queued", "invalid_state_transition", "Only queued Btw items can be promoted.", { itemId: input.itemId, status: item.status });
  const items = state.items.map((candidate, index) => index === itemIndex ? freezeQueueItem({ ...candidate, mode: "queue", updatedAt: input.now }) : candidate);
  const receipt = nextReceipt(state, "promote-btw", input.operationId, [input.itemId], input.now);
  return withMutation(state, receipt, items);
}

export function setQueueStatus(
  state: QueueState,
  input: { readonly expectedRevision: number; readonly operationId: string; readonly status: QueueStatus; readonly now: IsoTimestamp },
): QueueMutationResult {
  validateQueueState(state);
  assertObject(input, "Queue status input");
  assertExpectedRevision(state, input.expectedRevision);
  assertQueueIsoTimestamp(input.now, "queue status update time");
  assertQueueMutable(state, "queue-status");
  assertDomain(["active", "paused", "archived"].includes(input.status), "invalid_argument", "Unsupported queue status.", { status: input.status });
  assertDomain(input.status !== state.status, "conflict", "Queue already has the requested status.", { status: input.status });
  const receipt = nextReceipt(state, "queue-status", input.operationId, [], input.now);
  return withMutation(state, receipt, state.items, input.status);
}

export function validateQueueState(state: QueueState): void {
  assertObject(state, "Queue state");
  assertKnownKeys(state, QUEUE_STATE_KEYS, "Queue state");
  assertDomain(state.schemaVersion === 1, "invalid_argument", "Unsupported queue state schema version.");
  assertId(state.queueId, "queue ID");
  assertIntegerInRange(state.revision, "queue revision", 0, Number.MAX_SAFE_INTEGER);
  assertDomain(["active", "paused", "archived"].includes(state.status), "invalid_argument", "Unsupported queue status.");
  assertQueueIsoTimestamp(state.updatedAt, "queue update time");
  validateQueueItems(state.items);
  for (const item of state.items) assertQueueItemObservedAt(item, state.updatedAt, "queue state update time");
  assertDomain(Array.isArray(state.receipts), "invalid_argument", "Queue receipts must be an array.");
  assertDomain(state.receipts.length <= MAX_RECEIPTS, "invalid_argument", "Queue receipt history exceeds its bound.");
  let expectedRevision = Math.max(0, state.revision - state.receipts.length);
  const itemIds = new Set(state.items.map((item) => item.itemId));
  const operationIds = new Set<string>();
  let previousReceiptTime: number | undefined;
  const assertOrderKeyMap = (value: Readonly<Record<string, string>> | undefined, label: string): readonly string[] => {
    assertDomain(value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value), "invalid_argument", `${label} must be an object.`);
    const keys = Object.keys(value);
    assertDomain(keys.length <= MAX_CHANGED_ITEM_IDS, "invalid_argument", `${label} contains too many entries.`);
    const values = keys.map((key) => {
      assertDomain(itemIds.has(key), "not_found", `${label} references an unknown queue item.`, { itemId: key });
      return assertQueueNonBlank(value[key], `${label} order key`, MAX_ID_LENGTH);
    });
    assertDomain(new Set(values).size === values.length, "conflict", `${label} contains duplicate order keys.`);
    return keys;
  };
  for (const receipt of state.receipts) {
    assertObject(receipt, "Queue receipt");
    assertKnownKeys(receipt, QUEUE_RECEIPT_KEYS, "Queue receipt");
    assertDomain(receipt.schemaVersion === 1, "invalid_argument", "Unsupported queue receipt schema version.");
    assertId(receipt.operationId, "queue operation ID");
    assertDomain(isQueueReceiptOperation(receipt.operation), "invalid_argument", "Queue receipt operation is unsupported.", { operation: receipt.operation });
    assertDomain(receipt.queueId === state.queueId, "scope_violation", "Queue receipt belongs to another queue.");
    assertDomain(!operationIds.has(receipt.operationId), "conflict", "Queue receipt operation IDs must be unique.", { operationId: receipt.operationId });
    operationIds.add(receipt.operationId);
    assertIntegerInRange(receipt.previousRevision, "queue receipt previous revision", 0, Number.MAX_SAFE_INTEGER);
    assertIntegerInRange(receipt.nextRevision, "queue receipt next revision", 1, Number.MAX_SAFE_INTEGER);
    assertDomain(receipt.nextRevision === receipt.previousRevision + 1, "invalid_state_transition", "Queue receipt revisions must be contiguous.");
    assertDomain(receipt.previousRevision === expectedRevision, "invalid_state_transition", "Queue receipt history is not contiguous.");
    assertQueueIsoTimestamp(receipt.createdAt, "queue receipt time");
    const receiptTime = Date.parse(receipt.createdAt);
    assertDomain(receiptTime <= Date.parse(state.updatedAt), "invalid_argument", "Queue receipt time cannot be after the queue state update time.");
    if (previousReceiptTime !== undefined) {
      assertDomain(receiptTime >= previousReceiptTime, "invalid_state_transition", "Queue receipt times must be monotonic.");
    }
    previousReceiptTime = receiptTime;
    assertDomain(receipt.executionDisposition === "preview-only", "invalid_argument", "Queue receipt execution disposition is unsupported.");
    assertDomain(Array.isArray(receipt.changedItemIds), "invalid_argument", "Queue receipt changed item IDs must be an array.");
    assertDomain(receipt.changedItemIds.length <= MAX_CHANGED_ITEM_IDS, "invalid_argument", "Queue receipt changed item IDs exceed their bound.");
    const changedItemIds = assertStringList(receipt.changedItemIds, "queue receipt changed item IDs", MAX_CHANGED_ITEM_IDS);
    for (const itemId of changedItemIds) assertDomain(itemIds.has(itemId), "not_found", "Queue receipt references an unknown item.", { itemId });
    if (receipt.operation === "enqueue" || receipt.operation === "promote-btw") {
      assertDomain(changedItemIds.length === 1, "invalid_state_transition", `${receipt.operation} receipts must identify exactly one changed item.`);
    } else if (receipt.operation === "queue-status") {
      assertDomain(changedItemIds.length === 0, "invalid_state_transition", "Queue status receipts cannot identify changed items.");
    } else if (receipt.operation === "bulk-status") {
      assertDomain(changedItemIds.length > 0, "invalid_state_transition", "Bulk status receipts must identify at least one changed item.");
    }
    if (receipt.operation === "reorder" || receipt.operation === "undo-reorder") {
      const previousKeys = assertOrderKeyMap(receipt.previousOrderKeys, "Queue receipt previous order keys");
      const nextKeys = assertOrderKeyMap(receipt.nextOrderKeys, "Queue receipt next order keys");
      assertDomain(new Set(previousKeys).size === changedItemIds.length, "invalid_state_transition", "Queue reorder receipt changed IDs do not match its previous order-key proof.");
      assertDomain(new Set(nextKeys).size === changedItemIds.length, "invalid_state_transition", "Queue reorder receipt changed IDs do not match its next order-key proof.");
      assertDomain(new Set(previousKeys).size === new Set(changedItemIds).size && previousKeys.every((itemId) => changedItemIds.includes(itemId)), "invalid_state_transition", "Queue reorder receipt previous order-key proof is incomplete.");
      assertDomain(new Set(nextKeys).size === new Set(changedItemIds).size && nextKeys.every((itemId) => changedItemIds.includes(itemId)), "invalid_state_transition", "Queue reorder receipt next order-key proof is incomplete.");
    } else {
      assertDomain(receipt.previousOrderKeys === undefined && receipt.nextOrderKeys === undefined, "invalid_argument", "Only reorder receipts may carry order-key proofs.");
    }
    expectedRevision = receipt.nextRevision;
  }
  if (state.receipts.length > 0) {
    assertDomain(state.receipts.at(-1)!.nextRevision === state.revision, "invalid_state_transition", "Queue revision does not match its latest receipt.");
  } else {
    assertDomain(state.revision === 0, "invalid_state_transition", "A queue without receipts must be at revision zero.");
  }
}
