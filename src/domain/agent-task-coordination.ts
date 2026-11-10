import { assertDomain } from "./errors";
import type { AgentInstanceId, AgentResultId } from "./agent-tool-contract-shared";
import type { TaskId } from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";
import {
  assertNonNegativeSafeInteger,
  assertPositiveSafeInteger,
} from "./agent-tool-contract-shared";

/**
 * Renderer/domain coordination contract for durable task claims.
 *
 * This module deliberately does not transition `AgentTask` itself. A native
 * scheduler can persist this state beside the task DAG and atomically commit
 * both records later. Keeping the lease ledger separate makes stale worker
 * identities impossible to confuse with a durable task outcome.
 */

export type AgentTaskLeaseStatus = "active" | "released" | "expired";

export type AgentTaskCompletionOutcome = "completed" | "failed" | "cancelled";

export interface AgentTaskLease {
  readonly taskId: TaskId;
  readonly ownerAgentId: AgentInstanceId;
  /** A process incarnation; a restarted worker must receive a new value. */
  readonly workerIncarnationId: string;
  /** Monotonic per-task fencing token. Old epochs can never complete a task. */
  readonly leaseEpoch: number;
  readonly acquiredAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly lastHeartbeatAt: IsoTimestamp;
  /** Coordinator revision that created this lease. */
  readonly acquiredAtRevision: number;
  readonly status: AgentTaskLeaseStatus;
  readonly releasedAt?: IsoTimestamp;
  readonly releaseReason?: string;
}

export interface AgentTaskCompletionReceipt {
  readonly schemaVersion: 1;
  /** Caller-supplied stable idempotency key for the completion fact. */
  readonly receiptId: string;
  readonly taskId: TaskId;
  readonly ownerAgentId: AgentInstanceId;
  readonly workerIncarnationId: string;
  readonly leaseEpoch: number;
  readonly outcome: AgentTaskCompletionOutcome;
  readonly completedAt: IsoTimestamp;
  /** Evidence is required for every terminal outcome, including failure. */
  readonly evidenceHash: string;
  readonly resultId?: AgentResultId;
  readonly terminalReason?: string;
  /** Coordinator revision that committed this receipt. */
  readonly committedAtRevision: number;
}

export interface AgentTaskCoordinationState {
  readonly schemaVersion: 1;
  /** Monotonic CAS revision for every lease/receipt mutation. */
  readonly revision: number;
  readonly leases: readonly AgentTaskLease[];
  readonly completionReceipts: readonly AgentTaskCompletionReceipt[];
}

export interface ClaimAgentTaskLeaseInput {
  readonly expectedRevision: number;
  readonly taskId: TaskId;
  readonly ownerAgentId: AgentInstanceId;
  readonly workerIncarnationId: string;
  readonly now: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface AgentTaskLeaseMutationInput {
  readonly expectedRevision: number;
  readonly taskId: TaskId;
  readonly ownerAgentId: AgentInstanceId;
  readonly workerIncarnationId: string;
  readonly leaseEpoch: number;
  readonly now: IsoTimestamp;
}

export interface HeartbeatAgentTaskLeaseInput extends AgentTaskLeaseMutationInput {
  readonly expiresAt: IsoTimestamp;
}

export interface ReleaseAgentTaskLeaseInput extends AgentTaskLeaseMutationInput {
  readonly reason: string;
}

export interface CompleteAgentTaskLeaseInput extends AgentTaskLeaseMutationInput {
  readonly receiptId: string;
  readonly outcome: AgentTaskCompletionOutcome;
  readonly evidenceHash: string;
  readonly resultId?: AgentResultId;
  readonly terminalReason?: string;
}

export interface ClaimAgentTaskLeaseResult {
  readonly state: AgentTaskCoordinationState;
  readonly lease: AgentTaskLease;
  /** Number of stale active leases fenced during this atomic claim. */
  readonly reclaimedExpiredCount: number;
}

export interface CompleteAgentTaskLeaseResult {
  readonly state: AgentTaskCoordinationState;
  readonly receipt: AgentTaskCompletionReceipt;
  /** True when the exact receipt was already committed (lost-response retry). */
  readonly replayed: boolean;
}

export interface ExpireAgentTaskLeasesResult {
  readonly state: AgentTaskCoordinationState;
  readonly expiredLeaseEpochs: readonly number[];
}

const MAX_WORKER_INCARNATION_LENGTH = 256;
const MAX_RECEIPT_ID_LENGTH = 256;
const MAX_RELEASE_REASON_LENGTH = 1_000;
const MAX_TERMINAL_REASON_LENGTH = 1_000;
const MAX_LEASE_HISTORY = 8_192;
const MAX_COMPLETION_RECEIPTS = 8_192;
const LEASE_STATUSES: readonly AgentTaskLeaseStatus[] = Object.freeze([
  "active",
  "released",
  "expired",
]);
const COMPLETION_OUTCOMES: readonly AgentTaskCompletionOutcome[] = Object.freeze([
  "completed",
  "failed",
  "cancelled",
]);

function assertTimestampOrder(
  earlier: IsoTimestamp,
  later: IsoTimestamp,
  message: string,
  details: Record<string, unknown> = {},
): void {
  assertDomain(
    Date.parse(later) >= Date.parse(earlier),
    "invalid_argument",
    message,
    details,
  );
}

function assertLeaseStatus(value: unknown): asserts value is AgentTaskLeaseStatus {
  assertDomain(
    typeof value === "string" && LEASE_STATUSES.includes(value as AgentTaskLeaseStatus),
    "invalid_argument",
    "Unsupported task lease status.",
    { value },
  );
}

function assertCompletionOutcome(
  value: unknown,
): asserts value is AgentTaskCompletionOutcome {
  assertDomain(
    typeof value === "string" &&
      COMPLETION_OUTCOMES.includes(value as AgentTaskCompletionOutcome),
    "invalid_argument",
    "Unsupported task completion outcome.",
    { value },
  );
}

function assertWorkerIncarnation(value: string): string {
  return assertNonBlank(
    value,
    "worker incarnation ID",
    MAX_WORKER_INCARNATION_LENGTH,
  );
}

function assertReceiptId(value: string): string {
  return assertNonBlank(value, "completion receipt ID", MAX_RECEIPT_ID_LENGTH);
}

function freezeLease(lease: AgentTaskLease): AgentTaskLease {
  return Object.freeze({ ...lease });
}

function freezeReceipt(
  receipt: AgentTaskCompletionReceipt,
): AgentTaskCompletionReceipt {
  return Object.freeze({ ...receipt });
}

function freezeState(
  state: AgentTaskCoordinationState,
): AgentTaskCoordinationState {
  return Object.freeze({
    ...state,
    leases: Object.freeze(state.leases.map(freezeLease)),
    completionReceipts: Object.freeze(
      state.completionReceipts.map(freezeReceipt),
    ),
  });
}

/** Creates an empty immutable lease/receipt ledger. */
export function createAgentTaskCoordinationState(): AgentTaskCoordinationState {
  return freezeState({
    schemaVersion: 1,
    revision: 0,
    leases: [],
    completionReceipts: [],
  });
}

function assertExpectedRevision(
  state: AgentTaskCoordinationState,
  expectedRevision: number,
): void {
  assertNonNegativeSafeInteger(expectedRevision, "expected coordination revision");
  assertDomain(
    expectedRevision === state.revision,
    "conflict",
    "Task coordination state changed; refresh before retrying the mutation.",
    { expectedRevision, currentRevision: state.revision },
  );
}

function assertMutationIdentity(
  input: AgentTaskLeaseMutationInput,
): void {
  assertNonBlank(input.taskId, "task ID", 256);
  assertNonBlank(input.ownerAgentId, "owner agent ID", 256);
  assertWorkerIncarnation(input.workerIncarnationId);
  assertPositiveSafeInteger(input.leaseEpoch, "lease epoch");
  assertIsoTimestamp(input.now, "lease mutation time");
}

function findLease(
  state: AgentTaskCoordinationState,
  taskId: TaskId,
  leaseEpoch: number,
): AgentTaskLease | undefined {
  return state.leases.find(
    (lease) => lease.taskId === taskId && lease.leaseEpoch === leaseEpoch,
  );
}

function findActiveLease(
  state: AgentTaskCoordinationState,
  taskId: TaskId,
): AgentTaskLease | undefined {
  return state.leases.find(
    (lease) => lease.taskId === taskId && lease.status === "active",
  );
}

function assertLeaseOwner(
  lease: AgentTaskLease | undefined,
  input: AgentTaskLeaseMutationInput,
): AgentTaskLease {
  assertDomain(
    lease !== undefined,
    "not_found",
    "Task lease was not found for the supplied epoch.",
    { taskId: input.taskId, leaseEpoch: input.leaseEpoch },
  );
  assertDomain(
    lease.ownerAgentId === input.ownerAgentId &&
      lease.workerIncarnationId === input.workerIncarnationId,
    "permission_denied",
    "The worker identity does not own this task lease.",
    { taskId: input.taskId, leaseEpoch: input.leaseEpoch },
  );
  assertDomain(
    lease.status === "active",
    "invalid_state_transition",
    "Only an active task lease can be mutated.",
    { taskId: input.taskId, leaseEpoch: input.leaseEpoch, status: lease.status },
  );
  return lease;
}

function assertLeaseUsableAt(lease: AgentTaskLease, now: IsoTimestamp): void {
  assertDomain(
    Date.parse(now) < Date.parse(lease.expiresAt),
    "invalid_state_transition",
    "The task lease has expired and must be reclaimed before use.",
    { taskId: lease.taskId, leaseEpoch: lease.leaseEpoch },
  );
  assertTimestampOrder(
    lease.lastHeartbeatAt,
    now,
    "Lease mutation time cannot move backwards.",
    { taskId: lease.taskId, leaseEpoch: lease.leaseEpoch },
  );
}

function nextLeaseEpoch(
  state: AgentTaskCoordinationState,
  taskId: TaskId,
): number {
  const maximum = state.leases.reduce(
    (current, lease) =>
      lease.taskId === taskId ? Math.max(current, lease.leaseEpoch) : current,
    0,
  );
  assertDomain(
    maximum < Number.MAX_SAFE_INTEGER,
    "invalid_state_transition",
    "Task lease epoch exhausted its safe integer range.",
    { taskId },
  );
  return maximum + 1;
}

function assertHistoryCapacity(
  state: AgentTaskCoordinationState,
  additionalLeases: number,
  additionalReceipts: number,
): void {
  assertDomain(
    state.leases.length + additionalLeases <= MAX_LEASE_HISTORY,
    "invalid_state_transition",
    "Task lease history has reached its configured bound.",
    { maximum: MAX_LEASE_HISTORY },
  );
  assertDomain(
    state.completionReceipts.length + additionalReceipts <=
      MAX_COMPLETION_RECEIPTS,
    "invalid_state_transition",
    "Task completion receipt history has reached its configured bound.",
    { maximum: MAX_COMPLETION_RECEIPTS },
  );
}

function sameOptionalValue(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return left === right;
}

function completionReceiptMatchesInput(
  receipt: AgentTaskCompletionReceipt,
  input: CompleteAgentTaskLeaseInput,
): boolean {
  return (
    receipt.receiptId === input.receiptId &&
    receipt.taskId === input.taskId &&
    receipt.ownerAgentId === input.ownerAgentId &&
    receipt.workerIncarnationId === input.workerIncarnationId &&
    receipt.leaseEpoch === input.leaseEpoch &&
    receipt.outcome === input.outcome &&
    receipt.completedAt === input.now &&
    receipt.evidenceHash === input.evidenceHash &&
    sameOptionalValue(receipt.resultId, input.resultId) &&
    sameOptionalValue(receipt.terminalReason, input.terminalReason)
  );
}

/**
 * Validates a state restored from native persistence or an import boundary.
 * The returned snapshot is deeply frozen and safe to expose to a renderer.
 */
export function validateAgentTaskCoordinationState(
  state: AgentTaskCoordinationState,
): AgentTaskCoordinationState {
  assertDomain(state !== null && typeof state === "object", "invalid_argument", "Task coordination state must be an object.");
  assertDomain(state.schemaVersion === 1, "invalid_argument", "Unsupported task coordination schema version.");
  assertNonNegativeSafeInteger(state.revision, "coordination revision");
  assertDomain(Array.isArray(state.leases), "invalid_argument", "Task lease history must be an array.");
  assertDomain(Array.isArray(state.completionReceipts), "invalid_argument", "Completion receipt history must be an array.");
  assertDomain(state.leases.length <= MAX_LEASE_HISTORY, "invalid_argument", "Task lease history exceeds its configured bound.");
  assertDomain(state.completionReceipts.length <= MAX_COMPLETION_RECEIPTS, "invalid_argument", "Completion receipt history exceeds its configured bound.");

  const activeByTask = new Set<string>();
  const epochsByTask = new Map<string, number>();
  const leaseKeys = new Set<string>();
  for (const lease of state.leases) {
    assertNonBlank(lease.taskId, "task ID", 256);
    assertNonBlank(lease.ownerAgentId, "owner agent ID", 256);
    assertWorkerIncarnation(lease.workerIncarnationId);
    assertPositiveSafeInteger(lease.leaseEpoch, "lease epoch");
    assertIsoTimestamp(lease.acquiredAt, "lease acquisition time");
    assertIsoTimestamp(lease.expiresAt, "lease expiry time");
    assertIsoTimestamp(lease.lastHeartbeatAt, "lease heartbeat time");
    assertPositiveSafeInteger(lease.acquiredAtRevision, "lease acquisition revision");
    assertDomain(
      lease.acquiredAtRevision <= state.revision,
      "invalid_argument",
      "Lease acquisition revision cannot be ahead of the coordination snapshot.",
      { taskId: lease.taskId, leaseEpoch: lease.leaseEpoch },
    );
    assertLeaseStatus(lease.status);
    assertTimestampOrder(lease.acquiredAt, lease.lastHeartbeatAt, "Lease heartbeat cannot predate acquisition.");
    assertTimestampOrder(lease.lastHeartbeatAt, lease.expiresAt, "Lease expiry must be after the latest heartbeat.");
    assertDomain(lease.expiresAt !== lease.lastHeartbeatAt, "invalid_argument", "Lease expiry must be strictly after the latest heartbeat.");
    const leaseKey = `${lease.taskId}\u0000${lease.leaseEpoch}`;
    assertDomain(!leaseKeys.has(leaseKey), "conflict", "Task lease epochs must be unique.", { taskId: lease.taskId, leaseEpoch: lease.leaseEpoch });
    leaseKeys.add(leaseKey);
    const previousEpoch = epochsByTask.get(lease.taskId);
    assertDomain(previousEpoch === undefined || lease.leaseEpoch > previousEpoch, "invalid_argument", "Task lease epochs must increase within a task history.", { taskId: lease.taskId });
    epochsByTask.set(lease.taskId, lease.leaseEpoch);
    if (lease.status === "active") {
      assertDomain(!activeByTask.has(lease.taskId), "conflict", "A task cannot have more than one active lease.", { taskId: lease.taskId });
      assertDomain(lease.releasedAt === undefined && lease.releaseReason === undefined, "invalid_argument", "Active leases cannot carry release metadata.", { taskId: lease.taskId, leaseEpoch: lease.leaseEpoch });
      activeByTask.add(lease.taskId);
    } else {
      assertIsoTimestamp(lease.releasedAt ?? "", "lease release time");
      assertNonBlank(lease.releaseReason ?? "", "lease release reason", MAX_RELEASE_REASON_LENGTH);
      assertTimestampOrder(lease.lastHeartbeatAt, lease.releasedAt!, "Lease release cannot predate its heartbeat.");
    }
  }

  const receiptIds = new Set<string>();
  for (const receipt of state.completionReceipts) {
    assertDomain(receipt.schemaVersion === 1, "invalid_argument", "Unsupported completion receipt schema version.");
    assertReceiptId(receipt.receiptId);
    assertNonBlank(receipt.taskId, "task ID", 256);
    assertNonBlank(receipt.ownerAgentId, "owner agent ID", 256);
    assertWorkerIncarnation(receipt.workerIncarnationId);
    assertPositiveSafeInteger(receipt.leaseEpoch, "receipt lease epoch");
    assertCompletionOutcome(receipt.outcome);
    assertIsoTimestamp(receipt.completedAt, "task completion time");
    assertSha256(receipt.evidenceHash, "completion evidence hash");
    assertPositiveSafeInteger(receipt.committedAtRevision, "receipt committed revision");
    assertDomain(
      receipt.committedAtRevision <= state.revision,
      "invalid_argument",
      "Receipt committed revision cannot be ahead of the coordination snapshot.",
      { receiptId: receipt.receiptId },
    );
    assertDomain(!receiptIds.has(receipt.receiptId), "conflict", "Completion receipt IDs must be unique.", { receiptId: receipt.receiptId });
    receiptIds.add(receipt.receiptId);
    const lease = findLease(state, receipt.taskId, receipt.leaseEpoch);
    assertDomain(lease !== undefined, "not_found", "A completion receipt must reference an existing lease epoch.", { taskId: receipt.taskId, leaseEpoch: receipt.leaseEpoch });
    assertDomain(lease.ownerAgentId === receipt.ownerAgentId && lease.workerIncarnationId === receipt.workerIncarnationId, "scope_violation", "Completion receipt identity does not match its lease.", { taskId: receipt.taskId, leaseEpoch: receipt.leaseEpoch });
    assertDomain(
      lease.status === "released" &&
        lease.releaseReason === `terminal:${receipt.outcome}` &&
        lease.releasedAt === receipt.completedAt,
      "scope_violation",
      "Completion receipt must close its exact lease epoch.",
      { taskId: receipt.taskId, leaseEpoch: receipt.leaseEpoch },
    );
    assertTimestampOrder(lease.acquiredAt, receipt.completedAt, "Task completion cannot predate lease acquisition.");
    if (receipt.outcome === "completed") {
      assertDomain(receipt.resultId !== undefined, "invalid_argument", "Completed tasks require a result ID.", { receiptId: receipt.receiptId });
      assertDomain(receipt.terminalReason === undefined, "invalid_argument", "Completed tasks cannot carry a terminal failure reason.", { receiptId: receipt.receiptId });
    } else {
      assertDomain(receipt.terminalReason !== undefined, "invalid_argument", "Failed or cancelled tasks require a terminal reason.", { receiptId: receipt.receiptId });
      assertNonBlank(receipt.terminalReason, "task terminal reason", MAX_TERMINAL_REASON_LENGTH);
      assertDomain(receipt.resultId === undefined, "invalid_argument", "Only completed tasks may carry a result ID.", { receiptId: receipt.receiptId });
    }
  }

  return freezeState(state);
}

/** Claims a task with a new fencing epoch, reclaiming only already-expired leases. */
export function claimAgentTaskLease(
  state: AgentTaskCoordinationState,
  input: ClaimAgentTaskLeaseInput,
): ClaimAgentTaskLeaseResult {
  validateAgentTaskCoordinationState(state);
  assertExpectedRevision(state, input.expectedRevision);
  assertNonBlank(input.taskId, "task ID", 256);
  assertNonBlank(input.ownerAgentId, "owner agent ID", 256);
  assertWorkerIncarnation(input.workerIncarnationId);
  assertIsoTimestamp(input.now, "lease acquisition time");
  assertIsoTimestamp(input.expiresAt, "lease expiry time");
  assertDomain(Date.parse(input.expiresAt) > Date.parse(input.now), "invalid_argument", "A task lease must expire after acquisition.");

  const active = findActiveLease(state, input.taskId);
  let reclaimedExpiredCount = 0;
  let leases = [...state.leases];
  if (active !== undefined) {
    assertDomain(
      Date.parse(active.expiresAt) <= Date.parse(input.now),
      "conflict",
      "The task is already owned by a live lease.",
      { taskId: input.taskId, leaseEpoch: active.leaseEpoch },
    );
    const expired = freezeLease({
      ...active,
      status: "expired",
      releasedAt: input.now,
      releaseReason: "lease-expired",
    });
    leases = leases.map((candidate) =>
      candidate.taskId === active.taskId && candidate.leaseEpoch === active.leaseEpoch
        ? expired
        : candidate,
    );
    reclaimedExpiredCount = 1;
  }
  assertHistoryCapacity(state, 1, 0);
  const nextRevision = state.revision + 1;
  assertNonNegativeSafeInteger(nextRevision, "next coordination revision");
  const lease = freezeLease({
    taskId: input.taskId,
    ownerAgentId: input.ownerAgentId,
    workerIncarnationId: input.workerIncarnationId,
    leaseEpoch: nextLeaseEpoch(state, input.taskId),
    acquiredAt: input.now,
    expiresAt: input.expiresAt,
    lastHeartbeatAt: input.now,
    acquiredAtRevision: nextRevision,
    status: "active",
  });
  const next = freezeState({
    schemaVersion: 1,
    revision: nextRevision,
    leases: [...leases, lease],
    completionReceipts: state.completionReceipts,
  });
  return { state: next, lease, reclaimedExpiredCount };
}

/** Records liveness and optionally extends a lease, fenced by owner and epoch. */
export function heartbeatAgentTaskLease(
  state: AgentTaskCoordinationState,
  input: HeartbeatAgentTaskLeaseInput,
): AgentTaskCoordinationState {
  validateAgentTaskCoordinationState(state);
  assertExpectedRevision(state, input.expectedRevision);
  assertMutationIdentity(input);
  assertIsoTimestamp(input.expiresAt, "lease expiry time");
  const lease = assertLeaseOwner(findLease(state, input.taskId, input.leaseEpoch), input);
  assertLeaseUsableAt(lease, input.now);
  assertDomain(Date.parse(input.expiresAt) > Date.parse(input.now), "invalid_argument", "A heartbeat expiry must be after the heartbeat time.");
  assertDomain(Date.parse(input.expiresAt) >= Date.parse(lease.expiresAt), "invalid_argument", "A heartbeat cannot shorten the task lease.");
  const nextRevision = state.revision + 1;
  const nextLease = freezeLease({
    ...lease,
    expiresAt: input.expiresAt,
    lastHeartbeatAt: input.now,
  });
  return freezeState({
    schemaVersion: 1,
    revision: nextRevision,
    leases: state.leases.map((candidate) =>
      candidate.taskId === lease.taskId && candidate.leaseEpoch === lease.leaseEpoch
        ? nextLease
        : candidate,
    ),
    completionReceipts: state.completionReceipts,
  });
}

/** Releases a live lease without producing a task outcome. */
export function releaseAgentTaskLease(
  state: AgentTaskCoordinationState,
  input: ReleaseAgentTaskLeaseInput,
): AgentTaskCoordinationState {
  validateAgentTaskCoordinationState(state);
  assertExpectedRevision(state, input.expectedRevision);
  assertMutationIdentity(input);
  const lease = assertLeaseOwner(findLease(state, input.taskId, input.leaseEpoch), input);
  assertLeaseUsableAt(lease, input.now);
  const reason = assertNonBlank(input.reason, "lease release reason", MAX_RELEASE_REASON_LENGTH);
  const nextRevision = state.revision + 1;
  const nextLease = freezeLease({
    ...lease,
    status: "released",
    releasedAt: input.now,
    releaseReason: reason,
  });
  return freezeState({
    schemaVersion: 1,
    revision: nextRevision,
    leases: state.leases.map((candidate) =>
      candidate.taskId === lease.taskId && candidate.leaseEpoch === lease.leaseEpoch
        ? nextLease
        : candidate,
    ),
    completionReceipts: state.completionReceipts,
  });
}

/** Fences all active leases whose expiry is at or before `now`. */
export function expireAgentTaskLeases(
  state: AgentTaskCoordinationState,
  expectedRevision: number,
  now: IsoTimestamp,
): ExpireAgentTaskLeasesResult {
  validateAgentTaskCoordinationState(state);
  assertExpectedRevision(state, expectedRevision);
  assertIsoTimestamp(now, "lease expiry observation time");
  const expiredLeases = state.leases
    .filter(
      (lease) =>
        lease.status === "active" && Date.parse(lease.expiresAt) <= Date.parse(now),
    );
  if (expiredLeases.length === 0) {
    return { state, expiredLeaseEpochs: [] };
  }
  const nextRevision = state.revision + 1;
  const expiredSet = new Set(
    expiredLeases.map((lease) => `${lease.taskId}\u0000${lease.leaseEpoch}`),
  );
  const next = freezeState({
    schemaVersion: 1,
    revision: nextRevision,
    leases: state.leases.map((lease) =>
      expiredSet.has(`${lease.taskId}\u0000${lease.leaseEpoch}`) &&
      lease.status === "active"
        ? freezeLease({
            ...lease,
            status: "expired",
            releasedAt: now,
            releaseReason: "lease-expired",
          })
        : lease,
    ),
    completionReceipts: state.completionReceipts,
  });
  return {
    state: next,
    expiredLeaseEpochs: Object.freeze(expiredLeases.map((lease) => lease.leaseEpoch)),
  };
}

/**
 * Commits exactly one terminal receipt. Reusing the same receipt ID with the
 * same content is idempotent; changing any content is a conflict.
 */
export function completeAgentTaskLease(
  state: AgentTaskCoordinationState,
  input: CompleteAgentTaskLeaseInput,
): CompleteAgentTaskLeaseResult {
  validateAgentTaskCoordinationState(state);
  assertMutationIdentity(input);
  assertReceiptId(input.receiptId);
  assertCompletionOutcome(input.outcome);
  const evidenceHash = assertSha256(input.evidenceHash, "completion evidence hash");
  if (input.outcome === "completed") {
    assertDomain(input.resultId !== undefined, "invalid_argument", "Completed tasks require a result ID.");
    assertDomain(input.terminalReason === undefined, "invalid_argument", "Completed tasks cannot carry a terminal failure reason.");
  } else {
    assertDomain(input.resultId === undefined, "invalid_argument", "Only completed tasks may carry a result ID.");
    assertNonBlank(input.terminalReason ?? "", "task terminal reason", MAX_TERMINAL_REASON_LENGTH);
  }
  const existing = state.completionReceipts.find(
    (receipt) => receipt.receiptId === input.receiptId,
  );
  if (existing !== undefined) {
    assertDomain(
      completionReceiptMatchesInput(existing, input),
      "conflict",
      "Completion receipt ID was already used with different content.",
      { receiptId: input.receiptId },
    );
    return { state, receipt: existing, replayed: true };
  }
  assertExpectedRevision(state, input.expectedRevision);
  const lease = assertLeaseOwner(findLease(state, input.taskId, input.leaseEpoch), input);
  assertLeaseUsableAt(lease, input.now);
  assertTimestampOrder(lease.acquiredAt, input.now, "Task completion cannot predate lease acquisition.");
  assertHistoryCapacity(state, 0, 1);
  const nextRevision = state.revision + 1;
  const receipt = freezeReceipt({
    schemaVersion: 1,
    receiptId: input.receiptId,
    taskId: input.taskId,
    ownerAgentId: input.ownerAgentId,
    workerIncarnationId: input.workerIncarnationId,
    leaseEpoch: input.leaseEpoch,
    outcome: input.outcome,
    completedAt: input.now,
    evidenceHash,
    ...(input.resultId === undefined ? {} : { resultId: input.resultId }),
    ...(input.terminalReason === undefined
      ? {}
      : { terminalReason: assertNonBlank(input.terminalReason, "task terminal reason", MAX_TERMINAL_REASON_LENGTH) }),
    committedAtRevision: nextRevision,
  });
  const nextLease = freezeLease({
    ...lease,
    status: "released",
    releasedAt: input.now,
    releaseReason: `terminal:${input.outcome}`,
  });
  const next = freezeState({
    schemaVersion: 1,
    revision: nextRevision,
    leases: state.leases.map((candidate) =>
      candidate.taskId === lease.taskId && candidate.leaseEpoch === lease.leaseEpoch
        ? nextLease
        : candidate,
    ),
    completionReceipts: [...state.completionReceipts, receipt],
  });
  return { state: next, receipt, replayed: false };
}
