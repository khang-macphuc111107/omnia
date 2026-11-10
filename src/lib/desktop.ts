import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  assertCompatibleNativeCore,
  createDesktopInitializeRequest,
  OMNIA_PROTOCOL_VERSION,
  type CoreRuntimeInfo,
} from "@/lib/core-protocol";
import type { ProviderErrorClass } from "@/domain/telemetry";

const CORE_SESSION_HEADER = "x-omnia-session";

let coreSessionToken: string | null = null;
let coreInitialization: Promise<CoreRuntimeInfo> | null = null;

export function invokeCore<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!coreSessionToken) {
    return Promise.reject({
      code: "core_not_initialized",
      message: "Initialize Omnia Core before invoking application commands",
      retryable: false,
    } satisfies NativeCommandError);
  }
  return invoke<T>(command, args, {
    headers: { [CORE_SESSION_HEADER]: coreSessionToken },
  });
}

export function __resetCoreSessionForTests(): void {
  coreSessionToken = null;
  coreInitialization = null;
}

export type RuntimePlatform = "windows" | "macos" | "linux" | "web" | "unknown";

export interface AppRuntimeInfo {
  appName: string;
  appVersion: string;
  platform: RuntimePlatform;
  tauri: boolean;
  debug: boolean;
}

export interface NativeCommandError {
  code: string;
  message: string;
  retryable: boolean;
  /** Opaque native correlation handle; never contains request or secret text. */
  diagnosticId?: string;
  /** Coarse, allowlisted origin used for safe recovery copy. */
  source?:
    | "app"
    | "provider"
    | "network"
    | "storage"
    | "permission"
    | "parser"
    | "sync"
    | "native"
    | string;
  /** Normalized provider status, when the failure came from a provider. */
  status?: number;
  /** Bounded Retry-After value normalized to milliseconds. */
  retryAfterMs?: number;
  /** Whether the provider accepted the request before failing. */
  acceptance?: "false" | "true" | "unknown";
  /** Canonical provider failure taxonomy, when the error originated upstream. */
  errorClass?: ProviderErrorClass;
}

/** Serialized renderer composition snapshot exchanged with native storage. */
export interface LoadAppStateSnapshotRequest {
  minimumRevision?: number;
}

export type AppStateSnapshotLoadResponse =
  | {
      status: "empty";
      receiptId?: string;
    }
  | {
      status: "loaded";
      snapshot: string;
      revision: number;
      receiptId?: string;
    };

export interface SaveAppStateSnapshotRequest {
  snapshot: string;
  expectedRevision?: number;
}

export type AppStateSnapshotSaveResponse =
  | {
      status: "saved";
      revision: number;
      receiptId?: string;
    }
  | {
      status: "conflict";
      currentRevision: number | null;
      expectedRevision: number | null;
      receiptId?: string;
    };

/** Portable `omnia.transfer` envelope exchanged with the native boundary. */
export interface AppStateTransferRequest {
  bundle: string;
}

export interface AppStateTransferResponse {
  status: "exported" | "imported";
  bundle: string;
  receiptId?: string;
}

export interface AppStatePersistenceHealth {
  status: "available" | "unavailable";
  backend: "native" | "memory" | "custom";
  durable: boolean;
  schemaVersion: number;
}

/** Serialized renderer settings + permission policy exchanged with native. */
export interface LoadSettingsPermissionsSnapshotRequest {
  minimumRevision?: number;
}

export type SettingsPermissionsSnapshotLoadResponse =
  | {
      status: "empty";
      receiptId?: string;
    }
  | {
      status: "loaded";
      snapshot: string;
      revision: number;
      receiptId?: string;
    };

export interface SaveSettingsPermissionsSnapshotRequest {
  snapshot: string;
  expectedRevision?: number;
}

export type SettingsPermissionsSnapshotSaveResponse =
  | {
      status: "saved";
      revision: number;
      receiptId?: string;
    }
  | {
      status: "conflict";
      currentRevision: number | null;
      expectedRevision: number | null;
      receiptId?: string;
    };

export interface SettingsPermissionsPersistenceHealth {
  status: "available" | "unavailable";
  backend: "native" | "memory" | "custom";
  durable: boolean;
  schemaVersion: number;
}

export interface StorageHealth {
  schemaVersion: number;
  integrity: string;
  profileId: string;
}

export type RuntimeTargetKind = "goal" | "plan" | "task" | "session" | "run";
export type RuntimeOperationKind =
  | "queue"
  | "start"
  | "steer"
  | "pause"
  | "resume"
  | "cancel"
  | "retry"
  | "reconcile"
  | "reprioritize";
export type RuntimeEffectClass =
  | "read_only"
  | "analysis_only"
  | "reversible_write"
  | "provider_dispatch"
  | "process_control"
  | "external_effect";
export type RuntimeOperationState =
  | "accepted"
  | "delivered"
  | "safe_boundary_acknowledged"
  | "completed"
  | "failed"
  | "outcome_unknown"
  | "cancel_requested"
  | "cancel_completed";
export type RuntimeOutboxDeliveryState =
  | "queued"
  | "leased"
  | "delivered"
  | "outcome_unknown"
  | "superseded";

/** Native admission request. Acceptance persists intent; it does not dispatch work. */
export interface RuntimeOperationAppendRequest {
  operationId: string;
  targetKind: RuntimeTargetKind;
  targetId: string;
  operationKind: RuntimeOperationKind;
  effectClass: RuntimeEffectClass;
  /** Authenticated caller envelope; required by native for live-effect classes. */
  actorId?: string;
  authorityKind?: string;
  delegationId?: string;
  goalId?: string;
  planRevisionId?: string;
  taskId?: string;
  taskRevisionId?: string;
  sessionId?: string;
  runId?: string;
  runGeneration?: number;
  expectedHeadVersion?: number;
  idempotencyKey: string;
  payloadJson: string;
}

export interface RuntimeOperationReceipt {
  operationId: string;
  targetKind: RuntimeTargetKind;
  targetId: string;
  operationKind: RuntimeOperationKind;
  effectClass: RuntimeEffectClass;
  resultingHeadVersion: number;
  operationState: RuntimeOperationState;
  outboxId: string;
  deliveryAttempt: number;
  deliveryState: RuntimeOutboxDeliveryState;
  canonicalPayloadSha256: string;
  durable: true;
  replayed: boolean;
}

export interface RuntimeOutboxRecord {
  outboxId: string;
  operationId: string;
  deliveryAttempt: number;
  previousOutboxId: string | null;
  payloadSha256: string;
  payloadJson: string;
  deliveryState: RuntimeOutboxDeliveryState;
  leaseOwner: string | null;
  leaseExpiresAtMs: number | null;
  createdAtMs: number;
}

export interface RuntimeOutboxLeaseRequest {
  operationId: string;
  leaseOwner: string;
  leaseDurationMs: number;
  renew?: boolean;
}

export interface RuntimeOutboxLeaseReceipt {
  outboxId: string;
  operationId: string;
  deliveryAttempt: number;
  leaseOwner: string;
  leaseExpiresAtMs: number;
  deliveryState: "leased";
  durable: true;
  replayed: boolean;
}

export interface RuntimeOutboxSettlementReceipt {
  outboxId: string;
  operationId: string;
  deliveryAttempt: number;
  deliveryState: "delivered" | "outcome_unknown";
  durable: true;
  replayed: boolean;
}

export interface RuntimeOutboxSettleRequest {
  operationId: string;
  leaseOwner: string;
  deliveryState: "delivered" | "outcome_unknown";
}

export type RuntimeEventType =
  | "accepted"
  | "delivered"
  | "safe_boundary_acknowledged"
  | "completed"
  | "failed"
  | "cancel_requested"
  | "cancel_completed"
  | "outcome_unknown"
  | "reconciled";

export interface RuntimeEventAppendRequest {
  eventId: string;
  operationId: string;
  eventType: RuntimeEventType;
  actorId: string;
  authorityKind: string;
  delegationId?: string;
  payloadJson: string;
}

export interface RuntimeEventReceipt {
  eventId: string;
  operationId: string;
  eventType: RuntimeEventType;
  payloadSha256: string;
  createdAtMs: number;
  durable: true;
  replayed: boolean;
}

export interface ProjectRecord {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  instructions?: string;
}

export interface UpdateProjectMetadataRequest {
  projectId: string;
  name: string;
  description?: string;
  instructions?: string;
  expectedUpdatedAtMs: number;
}

/** Renderer-safe projection of one native-authoritative Goal root. */
export interface GoalRecord {
  id: string;
  profileId: string;
  projectId: string | null;
  conversationId: string | null;
  branchId: string | null;
  currentRevisionId: string;
  stateRevisionId: string | null;
  status: "draft" | "active" | "paused" | "completed" | "archived" | "cancelled";
  title: string;
  description: string | null;
  acceptanceCriteriaJson: string;
  roadmapJson: string;
  metadataJson: string;
  canonicalPayloadSha256: string;
  createdAtMs: number;
  updatedAtMs: number;
  deletedAtMs: number | null;
}

export interface GoalRevisionRecord {
  revisionId: string;
  goalId: string;
  revisionNo: number;
  payloadJson: string;
  contentSha256: string;
  stateRevisionId: string | null;
  createdAtMs: number;
}

export interface GoalSnapshot {
  goal: GoalRecord;
  currentRevision: GoalRevisionRecord;
  /** Immutable historical revision selected by a revision read or replay. */
  selectedRevision?: GoalRevisionRecord | null;
  executionDisposition: "preview-only";
  integrity: "valid";
  replayed: boolean;
}

export interface GoalSummary {
  id: string;
  profileId: string;
  projectId: string | null;
  conversationId: string | null;
  branchId: string | null;
  currentRevisionId: string;
  stateRevisionId: string | null;
  status: GoalRecord["status"];
  title: string;
  canonicalPayloadSha256: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CreateGoalRequest {
  projectId?: string;
  conversationId?: string;
  branchId?: string;
  stateRevisionId?: string;
  title: string;
  description?: string;
  acceptanceCriteriaJson?: string;
  roadmapJson?: string;
  metadataJson?: string;
  status?: GoalRecord["status"];
  idempotencyKey: string;
}

export interface CreateGoalRevisionRequest {
  goalId: string;
  /** Optional optimistic compare-and-swap guard for the native current pointer. */
  expectedCurrentRevisionId?: string;
  stateRevisionId?: string;
  payloadJson: string;
  idempotencyKey: string;
}

export interface ReadGoalRequest {
  goalId: string;
}

export interface ReadGoalRevisionRequest {
  goalId: string;
  revisionId: string;
}

export interface ListGoalsRequest {
  projectId?: string;
  conversationId?: string;
  branchId?: string;
  status?: GoalRecord["status"];
  includeArchived?: boolean;
  limit?: number;
}

export interface UpdateGoalStatusRequest {
  goalId: string;
  status: GoalRecord["status"];
  expectedUpdatedAtMs?: number;
  idempotencyKey: string;
}

/** Renderer-safe projection of one native-authoritative Task root. */
export type TaskStatus =
  | "pending"
  | "ready"
  | "in_progress"
  | "blocked"
  | "completed"
  | "cancelled"
  | "archived";

export interface TaskRecord {
  id: string;
  profileId: string;
  goalId: string;
  projectId: string | null;
  conversationId: string | null;
  branchId: string | null;
  currentRevisionId: string;
  stateRevisionId: string | null;
  status: TaskStatus;
  title: string;
  description: string | null;
  metadataJson: string;
  canonicalPayloadSha256: string;
  createdAtMs: number;
  updatedAtMs: number;
  deletedAtMs: number | null;
}

export interface TaskRevisionRecord {
  revisionId: string;
  taskId: string;
  revisionNo: number;
  payloadJson: string;
  contentSha256: string;
  stateRevisionId: string | null;
  createdAtMs: number;
}

export type TaskDependencyKind = "blocks" | "requires" | "related";

export interface TaskDependencyRecord {
  id: string;
  profileId: string;
  fromTaskId: string;
  toTaskId: string;
  dependencyKind: TaskDependencyKind;
  createdAtMs: number;
}

export interface TaskSnapshot {
  task: TaskRecord;
  currentRevision: TaskRevisionRecord;
  selectedRevision: TaskRevisionRecord | null;
  dependencies: TaskDependencyRecord[];
  executionDisposition: "preview-only";
  integrity: "valid";
  replayed: boolean;
}

export interface TaskSummary {
  id: string;
  profileId: string;
  goalId: string;
  projectId: string | null;
  conversationId: string | null;
  branchId: string | null;
  currentRevisionId: string;
  stateRevisionId: string | null;
  status: TaskStatus;
  title: string;
  canonicalPayloadSha256: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CreateTaskRequest {
  goalId: string;
  projectId?: string;
  conversationId?: string;
  branchId?: string;
  stateRevisionId?: string;
  title: string;
  description?: string;
  metadataJson?: string;
  status?: TaskStatus;
  idempotencyKey: string;
}

export interface ReadTaskRequest {
  taskId: string;
}

export interface ReadTaskRevisionRequest {
  taskId: string;
  revisionId: string;
}

export interface ListTasksRequest {
  goalId?: string;
  projectId?: string;
  conversationId?: string;
  branchId?: string;
  status?: TaskStatus;
  includeArchived?: boolean;
  limit?: number;
}

export interface CreateTaskRevisionRequest {
  taskId: string;
  /** Optional optimistic compare-and-swap guard for the native current pointer. */
  expectedCurrentRevisionId?: string;
  stateRevisionId?: string;
  payloadJson: string;
  idempotencyKey: string;
}

export interface UpdateTaskStatusRequest {
  taskId: string;
  status: TaskStatus;
  expectedUpdatedAtMs?: number;
  idempotencyKey: string;
}

export interface CreateTaskDependencyRequest {
  fromTaskId: string;
  toTaskId: string;
  dependencyKind: TaskDependencyKind;
}

export interface ListTaskDependenciesRequest {
  taskId: string;
}

/** Renderer-safe projection of one native-authoritative starter workflow. */
export type StarterWorkflowStatus = "draft" | "active" | "archived";

export interface StarterWorkflowRecord {
  id: string;
  profileId: string;
  projectId: string | null;
  conversationId: string | null;
  branchId: string | null;
  currentRevisionId: string;
  stateRevisionId: string | null;
  status: StarterWorkflowStatus;
  enabled: boolean;
  name: string;
  title: string;
  description: string | null;
  definitionJson: string;
  canonicalPayloadSha256: string;
  createdAtMs: number;
  updatedAtMs: number;
  deletedAtMs: number | null;
}

export interface StarterWorkflowRevisionRecord {
  revisionId: string;
  starterWorkflowId: string;
  revisionNo: number;
  definitionJson: string;
  contentSha256: string;
  stateRevisionId: string | null;
  createdAtMs: number;
}

export interface StarterWorkflowSnapshot {
  workflow: StarterWorkflowRecord;
  currentRevision: StarterWorkflowRevisionRecord;
  /** Immutable revision selected by an exact historical read or mutation replay. */
  selectedRevision: StarterWorkflowRevisionRecord | null;
  executionDisposition: "preview-only";
  integrity: "valid";
  replayed: boolean;
}

export interface StarterWorkflowSummary {
  id: string;
  profileId: string;
  projectId: string | null;
  conversationId: string | null;
  branchId: string | null;
  currentRevisionId: string;
  stateRevisionId: string | null;
  status: StarterWorkflowStatus;
  enabled: boolean;
  name: string;
  title: string;
  canonicalPayloadSha256: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CreateStarterWorkflowRequest {
  projectId?: string;
  conversationId?: string;
  branchId?: string;
  stateRevisionId?: string;
  name: string;
  title: string;
  description?: string;
  definitionJson: string;
  status?: StarterWorkflowStatus;
  enabled?: boolean;
  idempotencyKey: string;
}

export interface CreateStarterWorkflowRevisionRequest {
  starterWorkflowId: string;
  /** Optional optimistic compare-and-swap guard for the native current pointer. */
  expectedCurrentRevisionId?: string;
  stateRevisionId?: string;
  definitionJson: string;
  idempotencyKey: string;
}

export interface ReadStarterWorkflowRequest {
  starterWorkflowId: string;
}

export interface ReadStarterWorkflowRevisionRequest {
  starterWorkflowId: string;
  revisionId: string;
}

export interface ListStarterWorkflowsRequest {
  projectId?: string;
  conversationId?: string;
  branchId?: string;
  status?: StarterWorkflowStatus;
  enabled?: boolean;
  includeArchived?: boolean;
  limit?: number;
}

export interface UpdateStarterWorkflowStatusRequest {
  starterWorkflowId: string;
  status: StarterWorkflowStatus;
  enabled?: boolean;
  expectedUpdatedAtMs?: number;
  idempotencyKey: string;
}

/** Enables or disables a Starter Workflow without changing its lifecycle status. */
export interface UpdateStarterWorkflowEnabledRequest {
  starterWorkflowId: string;
  enabled: boolean;
  expectedUpdatedAtMs?: number;
  idempotencyKey: string;
}

export interface ConversationRecord {
  id: string;
  projectId: string | null;
  title: string;
  activeBranchId: string;
  pinnedAtMs: number | null;
  archivedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ConversationBranchRecord {
  id: string;
  conversationId: string;
  parentBranchId: string | null;
  forkedFromMessageId: string | null;
  name: string | null;
  createdAtMs: number;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  branchId: string;
  parentMessageId: string | null;
  replacesMessageId: string | null;
  role: "system" | "developer" | "user" | "assistant" | "tool";
  status: "draft" | "complete" | "cancelled" | "failed";
  sequenceNo: number;
  contentText: string;
  providerProfileId: string | null;
  modelId: string | null;
  finishReason: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  finalizedAtMs: number | null;
}

export interface RunRecord {
  id: string;
  conversationId: string;
  branchId: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  providerProfileId: string | null;
  modelId: string;
  state: "queued" | "running" | "complete" | "cancelled" | "failed";
  errorCode: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  createdAtMs: number;
}

export interface RunAttemptRecord {
  id: string;
  generationId: string;
  ordinal: number;
  providerProfileId: string | null;
  modelId: string;
  state:
    | "created"
    | "dispatching"
    | "accepted"
    | "streaming"
    | "complete"
    | "interrupted"
    | "failed"
    | "outcome_unknown";
  acceptedByProvider: "false" | "true" | "unknown";
  idempotencySupported: boolean;
  remoteRequestId: string | null;
  errorCode: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  createdAtMs: number;
}

export interface ConversationSnapshot {
  conversation: ConversationRecord;
  branches: ConversationBranchRecord[];
  messages: MessageRecord[];
  runs: RunRecord[];
  attempts: RunAttemptRecord[];
}

export interface ForkConversationBranchRequest {
  conversationId: string;
  parentBranchId: string;
  forkedFromMessageId: string;
  name?: string;
  activate?: boolean;
}

/** Native branch selection is compare-and-swap against the branch the user saw. */
export interface ActivateConversationBranchRequest {
  conversationId: string;
  branchId: string;
  expectedActiveBranchId: string;
}

/** The native vocabulary for immutable state-revision facts. */
export type StateRevisionKind =
  | "root"
  | "checkpoint"
  | "continuation"
  | "resume"
  | "prompt-edit"
  | "retry-result"
  | "branch"
  | "fork"
  | "merge"
  | "promotion"
  | "compaction"
  | "reconciliation"
  | "recovery";

/** Statuses are intentionally distinct: candidates and unknown outcomes are
 * never implicitly promoted into the accepted branch head. */
export type StateRevisionStatus =
  | "candidate"
  | "accepted"
  | "rejected"
  | "superseded"
  | "outcome-unknown"
  | "conflicted"
  | "blocked"
  | "discarded"
  | "invalid";

export type StateRevisionEdgeKind =
  | "inherits-from"
  | "checkpoint-of"
  | "continues-from"
  | "resumes-from-checkpoint"
  | "edits"
  | "retries"
  | "branches-from"
  | "forks-from"
  | "merges-from"
  | "promotes"
  | "compacts"
  | "reconciles-external-effect"
  | "supersedes"
  | "conflicts-with"
  | "derives-selected-delta-from";

export type StateRevisionMutationOutcome =
  | "applied"
  | "already-applied"
  | "stale-head"
  | "payload-drift"
  | "branch-conflict"
  | "unauthorized"
  | "invalid-state-base"
  | "policy-stale"
  | "reconciliation-required";

export type StateRevisionIntegrity = "valid" | "recovering" | "invalid";

/** Native immutable state-revision mutation request. JSON manifest fields are
 * redacted/bounded envelopes; the native kernel owns canonicalization, scope,
 * idempotency and branch-head CAS. */
export interface StateRevisionAppendRequest {
  conversationId: string;
  branchId: string;
  kind: StateRevisionKind;
  status: StateRevisionStatus;
  expectedHeadStateRevisionId?: string | null;
  idempotencyKey: string;
  parentStateRevisionIds?: string[];
  watermarkJson?: string;
  actorJson?: string;
  causationJson?: string;
  manifestJson?: string;
  authorityJson?: string;
  routingCacheJson?: string;
  stateDigest?: string | null;
  canonicalizationRevision?: string;
  edgeKind?: StateRevisionEdgeKind | null;
  operationId?: string | null;
  causalCursorJson?: string;
  policyRevisionId?: string;
}

export interface StateRevisionMutationResult {
  outcome: StateRevisionMutationOutcome;
  streamId: string;
  revisionId: string | null;
  acceptedHeadStateRevisionId: string | null;
  currentHeadStateRevisionId: string | null;
  expectedHeadStateRevisionId: string | null;
  branchSequence: number;
  canonicalPayloadHash: string;
  safeDiff: string | null;
  /** Cursor of the matching append-only state-revision journal fact. */
  journalEpoch: string | null;
  journalSequence: number | null;
  journalEventId: string | null;
}

export interface StateRevisionProjection {
  id: string;
  kind: StateRevisionKind;
  status: StateRevisionStatus;
  branchSequence: number;
  stateDigest: string;
  parentStateRevisionIds: string[];
  observedHeadStateRevisionId: string | null;
  expectedHeadStateRevisionId: string | null;
  createdAtMs: number;
}

export interface StateRevisionEdgeProjection {
  id: string;
  kind: StateRevisionEdgeKind;
  fromStateRevisionId: string;
  toStateRevisionId: string;
  operationId: string | null;
  policyRevisionId: string;
  createdAtMs: number;
}

/**
 * Bounded native IPC graph-read projection (runtime contract v1).
 *
 * This intentionally compact DTO is not an instance of the richer
 * `docs/omnia-ultra/schemas/state-revision-graph.schema.json` export target.
 * It is a fixed-watermark, redacted branch read. A future export adapter must
 * load the immutable typed facts it needs at one snapshot and must not invent
 * the target schema's projection, authority, manifest or diagnostic fields.
 */
export interface StateRevisionGraphSnapshot {
  schemaVersion: number;
  streamId: string;
  conversationId: string;
  branchId: string;
  acceptedHeadStateRevisionId: string | null;
  acceptedHeadBranchSequence: number;
  throughBranchSequence: number;
  revisions: StateRevisionProjection[];
  edges: StateRevisionEdgeProjection[];
  integrity: StateRevisionIntegrity;
  /** True when another page of revisions is available at the fixed watermark. */
  revisionsHasMore: boolean;
  /** True when another page of edges is available at the fixed watermark. */
  edgesHasMore: boolean;
  /** Signed native continuation cursor for the revision collection. */
  nextRevisionsCursor: string | null;
  /** Signed native continuation cursor for the edge collection. */
  nextEdgesCursor: string | null;
  /** Effective bounded page size used by native storage for revisions. */
  revisionsLimit: number;
  /** Effective bounded page size used by native storage for edges. */
  edgesLimit: number;
  /** UTF-8 serialized response size reported by native storage. */
  responseBytes: number;
}

export interface ReadStateRevisionGraphRequest {
  conversationId: string;
  branchId: string;
  /**
   * Optional inclusive branch-sequence watermark. When present, native
   * reconstruction must return only facts at or before this sequence and
   * report the resolved value in `StateRevisionGraphSnapshot.throughBranchSequence`.
   * The native layer validates/clamps this value against the stream; the
   * renderer never treats a locally supplied value as an authority grant.
   */
  throughBranchSequence?: number | null;
  /** Optional bounded page size for revision projections. */
  revisionsLimit?: number | null;
  /** Optional bounded page size for edge projections. */
  edgesLimit?: number | null;
  /** Native continuation cursor returned by a prior page. */
  revisionsCursor?: string | null;
  /** Native continuation cursor returned by a prior page. */
  edgesCursor?: string | null;
}

/**
 * Run-control wire vocabulary. These types mirror the normative
 * `run-control-operation.schema.json`, `run-checkpoint.schema.json`,
 * `continuation-intent.schema.json` and `message-revision.schema.json`
 * contracts. The renderer may construct intents, but native resolves the
 * state base, owns idempotency and returns the immutable receipt.
 */
export type RunControlKind =
  | "pause"
  | "resume"
  | "continue"
  | "edit"
  | "retry"
  | "copy"
  | "duplicate"
  | "branch"
  | "fork"
  | "compare"
  | "promote"
  | "merge";

export type RunControlOperationState =
  | "resolved"
  | "applied"
  | "blocked"
  | "rejected"
  | "cancelled"
  | "failed";

export type RunControlStateBaseMode =
  | "exact-historical"
  | "current-state"
  | "historical-plus-selected-deltas"
  | "fresh-branch"
  | "fresh-goal-start";

export type RunControlStateBaseResolutionReason =
  | "exact-frozen"
  | "current-branch-head"
  | "historical-selected-deltas"
  | "fresh-isolated-bootstrap"
  | "fresh-goal-bootstrap";

export type RunControlContinuationIntent =
  | "none"
  | "next-best-action"
  | "unfinished-answer"
  | "next-plan-task"
  | "resume-checkpoint"
  | "bootstrap-active-goal"
  | "starter-workflow";

export type RunControlActiveRunPolicy =
  | "apply-at-safe-boundary"
  | "interrupt-new-attempt"
  | "queue-after-terminal"
  | "fork-parallel"
  | "not-applicable";

export type RunControlActorKind = "user" | "agent" | "automation" | "recovery";

export interface RunControlActor {
  kind: RunControlActorKind;
  id: string;
}

/**
 * State-digest wire vocabulary shared with the native run-control resolver
 * and `state-revision-graph.schema.json`. Keep the hyphenated spellings here
 * instead of normalising to provider/library names such as `sha256`: these
 * values cross the Tauri IPC boundary and must remain schema-identical.
 */
export type StateDigestAlgorithm = "sha-256" | "sha-384" | "sha-512" | "blake3";

export interface StateDigest {
  algorithm: StateDigestAlgorithm;
  canonicalizationRevision: string;
  value: string;
}

export type RunControlCursorStreamKind =
  | "conversation"
  | "branch"
  | "run"
  | "task"
  | "project"
  | "provider"
  | "recovery";

export interface RunControlJournalCursor {
  streamKind: RunControlCursorStreamKind;
  streamId: string;
  journalEpoch?: string | null;
  sequence: number;
  eventId?: string | null;
  payloadHash?: string | null;
}

export interface RunControlStateBase {
  mode: RunControlStateBaseMode;
  sourceStateRevisionId: string | null;
  requestedHeadStateRevisionId: string | null;
  resolvedStateRevisionId: string;
  resolvedStateDigest: StateDigest;
  selectedDeltaIds: string[];
  contextManifestId: string | null;
  resolutionReason: RunControlStateBaseResolutionReason;
  resolvedAt: string;
  resolvedAtCursors: RunControlJournalCursor[];
}

/**
 * Renderer-authored run-control intent.  `stateBase` is deliberately
 * optional: native resolves the authoritative state base inside the same
 * immediate transaction that persists the immutable operation receipt.  A
 * legacy caller may still include a resolved state base as a selector/shape
 * hint; native must never treat its digest, timestamp, or cursor values as
 * authoritative.
 */
export interface RunControlOperationIntent {
  schemaVersion?: 2;
  operationId: string;
  conversationId: string;
  branchId: string;
  kind: RunControlKind;
  stateBase?: RunControlStateBase | null;
  actor: RunControlActor;
  idempotencyKey: string;
  createdAt: string;
  sourceRunId?: string | null;
  sourceAttemptId?: string | null;
  sourceMessageId?: string | null;
  sourcePromptRevisionId?: string | null;
  editRevisionId?: string | null;
  continuationIntent: RunControlContinuationIntent;
  activeRunPolicy: RunControlActiveRunPolicy;
  expectedActiveRunId?: string | null;
  expectedConversationVersion?: number | null;
  expectedBranchCursor?: RunControlJournalCursor | null;
  compareStateRevisionIds: string[];
  mergeStateRevisionIds: string[];
}

/**
 * Compatibility envelope for code paths that already carry a locally
 * prepared state base.  It remains structurally assignable to an intent, but
 * the native resolver is the authority for all state-base facts.
 */
export type RunControlOperationRequest = RunControlOperationIntent & {
  stateBase: RunControlStateBase;
};

export interface ResolvedRunControlOperation {
  schemaVersion: 2;
  operationId: string;
  receiptId?: string | null;
  authorityContinuityRecordId?: string | null;
  kind: RunControlKind;
  operationState: RunControlOperationState;
  conversationId: string;
  branchId: string;
  sourceRunId: string | null;
  sourceAttemptId: string | null;
  sourceMessageId: string | null;
  sourcePromptRevisionId: string | null;
  stateBase: RunControlStateBase;
  editRevisionId: string | null;
  continuationIntent: RunControlContinuationIntent;
  activeRunPolicy: RunControlActiveRunPolicy;
  expectedActiveRunId: string | null;
  expectedConversationVersion: number | null;
  expectedBranchCursor: RunControlJournalCursor | null;
  compareStateRevisionIds: string[];
  mergeStateRevisionIds: string[];
  result: RunControlOperationResult | null;
  actor: RunControlActor;
  idempotencyKey: string;
  createdAt: string;
}

export interface RunControlOperationResult {
  resultStateRevisionId?: string | null;
  resultRunId?: string | null;
  resultAttemptId?: string | null;
  resultCheckpointId?: string | null;
  resultBranchId?: string | null;
  sourceBranchCursor?: RunControlJournalCursor | null;
  destinationBranchCursor?: RunControlJournalCursor | null;
  blockedReason?: string | null;
  diagnosticId?: string | null;
}

export type RunControlApplyOutcome =
  | "applied"
  | "already-applied"
  | "blocked"
  | "rejected"
  | "cancelled"
  | "failed"
  | "stale-head"
  | "payload-drift"
  | "reconciliation-required";

export interface RunControlApplyRequest {
  operationId: string;
  idempotencyKey: string;
  expectedOperationState?: RunControlOperationState;
  expectedHeadStateRevisionId?: string | null;
}

export interface RunControlApplyResult {
  operation: ResolvedRunControlOperation;
  durable: boolean;
  stateRevisionId: string | null;
  replayed: boolean;
  diagnostic: string | null;
}

export type RunCheckpointStatus =
  | "requested"
  | "checkpointing"
  | "paused"
  | "resuming"
  | "expired"
  | "blocked"
  | "invalidated";

export type RunCheckpointDisposition =
  | "cooperative-checkpoint"
  | "provider-supported-suspend"
  | "cancel-then-reconcile"
  | "pending-effect-checkpoint"
  | "held"
  | "outcome-unknown";

export type RunCheckpointPartialOutputPolicy =
  | "exclude"
  | "durable-only"
  | "include-as-interrupted-artifact"
  | "wait-safe-boundary";

export type RunCheckpointProviderAcceptance = "not-sent" | "accepted" | "rejected" | "unknown";

export interface RunCheckpointRecord {
  schemaVersion: 1;
  checkpointId: string;
  runId: string;
  attemptId: string | null;
  agentInstanceId: string | null;
  stateRevisionId: string;
  status: RunCheckpointStatus;
  disposition: RunCheckpointDisposition;
  cursor: number;
  partialOutputPolicy: RunCheckpointPartialOutputPolicy | null;
  frozenProviderInputId: string | null;
  providerAcceptance: RunCheckpointProviderAcceptance | null;
  pendingReconciliationIds: string[];
  leaseEpoch: number | null;
  telemetryWatermark: number | null;
  contentHash: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface CreateRunCheckpointRequest {
  runId: string;
  attemptId?: string | null;
  agentInstanceId?: string | null;
  stateRevisionId: string;
  status: RunCheckpointStatus;
  disposition: RunCheckpointDisposition;
  cursor: number;
  partialOutputPolicy?: RunCheckpointPartialOutputPolicy | null;
  frozenProviderInputId?: string | null;
  providerAcceptance?: RunCheckpointProviderAcceptance | null;
  pendingReconciliationIds?: string[];
  leaseEpoch?: number | null;
  telemetryWatermark?: number | null;
  contentHash: string;
  idempotencyKey: string;
}

export interface ReadRunCheckpointRequest {
  runId: string;
  checkpointId?: string;
}

export type ContinuationIntentRootKind = "run" | "task" | "goal" | "branch" | "checkpoint" | "starter-workflow";

export type ContinuationIntentKind =
  | "unfinished-answer"
  | "next-plan-task"
  | "resume-checkpoint"
  | "bootstrap-active-goal"
  | "research-next"
  | "test-next"
  | "review-next"
  | "plan-only"
  | "draft-only";

export type ContinuationExecutionMode = "preview" | "plan-only" | "draft-only" | "execute";

export interface ContinuationIntentBudget {
  maxTokens?: number | null;
  /**
   * Decimal/scientific cost text, kept as a string so native persistence and
   * idempotent replay never round through IEEE-754 floating point.
   */
  maxCost?: string | null;
  maxDurationSeconds?: number | null;
  maxSegments?: number | null;
}

export interface ContinuationLoopGuard {
  chainId: string;
  duplicateSignature: string;
  maxAutomaticSegments: number;
  /**
   * Decimal/scientific progress score text, kept as a string so native
   * persistence and idempotent replay never round through IEEE-754.
   */
  progressScore?: string | null;
  noProgressCount?: number | null;
}

export interface ContinuationIntent {
  schemaVersion: 1;
  intentId: string;
  rootKind: ContinuationIntentRootKind;
  rootId: string;
  intentKind: ContinuationIntentKind;
  stateRevisionId: string;
  executionMode: ContinuationExecutionMode;
  modelProfileId: string | null;
  effort: "fast" | "balanced" | "deep" | "ultra" | "custom";
  allowedToolIds: string[];
  budget: ContinuationIntentBudget | null;
  loopGuard: ContinuationLoopGuard;
  approvalPolicyRevision: string | null;
  createdAt: string;
}

export interface ResolveContinuationIntentRequest {
  conversationId: string;
  branchId: string;
  rootKind: ContinuationIntentRootKind;
  rootId: string;
  intentKind: ContinuationIntentKind;
  stateRevisionId: string;
  executionMode?: ContinuationExecutionMode;
  modelProfileId?: string | null;
  effort?: "fast" | "balanced" | "deep" | "ultra" | "custom";
  allowedToolIds?: string[];
  budget?: ContinuationIntentBudget;
  loopGuard?: ContinuationLoopGuard;
  approvalPolicyRevision?: string | null;
  idempotencyKey: string;
}

export type MessageRevisionKind = "draft" | "user" | "assistant" | "tool" | "system" | "annotation";

export type MessageRevisionEffect =
  | "edit-draft"
  | "replace-queued"
  | "edit-as-branch"
  | "replay-historical"
  | "retry-current-state"
  | "selected-delta-retry"
  | "annotation-or-correction";

export interface MessageRevision {
  schemaVersion: 1;
  revisionId: string;
  messageId: string;
  kind: MessageRevisionKind;
  effect: MessageRevisionEffect;
  parentRevisionId: string | null;
  sourceCursor: number;
  destinationBranchId: string | null;
  contentHash: string;
  redactionClass: string;
  createdAt: string;
}

export interface ResolveMessageRevisionRequest {
  conversationId: string;
  branchId: string;
  messageId: string;
  kind: MessageRevisionKind;
  effect: MessageRevisionEffect;
  sourceCursor: number;
  parentRevisionId?: string | null;
  destinationBranchId?: string | null;
  contentHash: string;
  redactionClass: string;
  idempotencyKey: string;
}

export interface PreparedProviderInputReceipt {
  id: string;
  attemptId: string;
  runId: string;
  providerProfileId: string;
  model: string;
  contentSha256: string;
  messageCount: number;
  createdAtMs: number;
}

export interface PreparedConversationRun {
  conversation: ConversationSnapshot;
  providerInput: PreparedProviderInputReceipt;
}

export interface RunJournalCursor {
  schemaVersion: 1;
  runId: string;
  journalEpoch: string;
  sequence: number;
  eventId: string | null;
}

export interface RunJournalEventRecord {
  schemaVersion: 1;
  id: string;
  runId: string;
  journalEpoch: string;
  attemptId: string | null;
  frozenProviderInputId: string | null;
  sequence: number;
  eventType: string;
  source: string;
  visibility: string;
  sensitivity: string;
  payload: unknown;
  occurredAtMs: number;
  committedAtMs: number;
}

export interface ReadRunJournalRequest {
  runId: string;
  journalEpoch?: string;
  afterSequence?: number;
  afterEventId?: string;
  throughSequence?: number;
  throughEventId?: string;
  limit?: number;
}

export interface RunJournalReplayPage {
  runId: string;
  journalEpoch: string;
  coverage: "complete" | "legacy-partial" | "recovered-partial";
  coverageReason: string | null;
  events: RunJournalEventRecord[];
  nextCursor: RunJournalCursor;
  throughCursor: RunJournalCursor;
  complete: boolean;
}

/**
 * Read-only, content-free telemetry DTOs returned by the native kernel. These
 * intentionally do not mirror the durable storage rows: prompt/response text,
 * reasoning content, remote identities, price metadata, journal payloads, and
 * provider extension fields remain outside renderer IPC.
 */
export type TelemetryCoverage = "complete" | "partial" | "estimated" | "unknown";

export interface ReadRunTelemetryRequest {
  runId: string;
  attemptId?: string;
}

export interface RunTelemetryTimingMarks {
  dispatchStartedMs: number;
  requestCommittedMs: number | null;
  firstByteMs: number | null;
  firstProviderOutputMs: number | null;
  firstReasoningMs: number | null;
  firstVisibleOutputMs: number | null;
  firstCompleteItemMs: number | null;
  lastVisibleOutputMs: number | null;
  terminalMs: number | null;
}

export interface RunTelemetryTimingWaits {
  queueMs: number | null;
  contextCompileMs: number | null;
  approvalWaitMs: number | null;
  providerBackoffMs: number | null;
  toolWaitMs: number | null;
  rendererBackpressureMs: number | null;
}

export interface RendererTimingObservation {
  observedAtMs: number;
  coverage: TelemetryCoverage;
  marks: RunTelemetryTimingMarks;
  waits: RunTelemetryTimingWaits;
}

export interface RendererUsageCounters {
  inputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  visibleOutputTokens: number | null;
}

export interface RendererUsageObservation {
  sequence: number;
  source:
    | "local-estimate"
    | "provider-incremental"
    | "provider-final"
    | "provider-invoice"
    | "user-correction";
  authoritative: boolean;
  coverage: TelemetryCoverage;
  observedAtMs: number;
  counters: RendererUsageCounters;
  costStatementCount: number;
}

export interface RunTelemetryAttemptSnapshot {
  attemptId: string;
  ordinal: number;
  providerProfileId: string | null;
  modelId: string;
  state:
    | "created"
    | "dispatching"
    | "accepted"
    | "streaming"
    | "complete"
    | "interrupted"
    | "failed"
    | "outcome_unknown";
  acceptedByProvider: "false" | "true" | "unknown";
  errorCode: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  createdAtMs: number;
  timingObservations: RendererTimingObservation[];
  usageLedger: RendererUsageObservation[];
}

export interface RunTelemetrySnapshot {
  schemaVersion: 1;
  runId: string;
  attempts: RunTelemetryAttemptSnapshot[];
  readAtMs: number;
}

/** Exact historical address; a lineage read confers no dispatch authority. */
export interface ReadProviderAttemptLineageRequest {
  conversationId: string;
  branchId: string;
  runId: string;
  attemptId: string;
}

/** Content-free immutable native fact projection (not the mutable profile). */
export interface ProviderAttemptLineageReceipt {
  schemaVersion: 1;
  lineageFactId: string;
  frozenProviderInputId: string;
  runId: string;
  attemptId: string;
  providerProfileId: string;
  modelId: string;
  providerDefinitionSchemaVersion: 1;
  providerDefinitionSha256: string;
  endpointFingerprintSha256: string;
  adapterRevision: string;
  requestedEffort: "fast" | "balanced" | "deep" | "ultra" | "custom" | null;
  effectiveEffort: string | null;
  resolvedParametersSha256: string;
  contextManifestId?: string | null;
  contextManifestSha256?: string | null;
  inputContentSha256: string;
  createdAtMs: number;
}

export interface PrepareConversationRunRequest {
  conversationId: string;
  branchId: string;
  runId: string;
  attemptId: string;
  userMessageId: string;
  assistantMessageId: string;
  prompt: string;
  providerProfileId: string;
  model: string;
  requestParametersJson: string;
  contextAdmission?: {
    grantId: string;
    query: string;
    indexOptions?: WorkspaceIndexOptions;
    retrievalOptions?: WorkspaceRetrievalOptions;
  };
}

export type AttachmentDraftState = "open" | "bound" | "abandoned" | "expired";

export interface AttachmentRecord {
  id: string;
  draftId: string | null;
  messageId: string | null;
  projectId: string | null;
  filename: string;
  mediaType: string;
  byteSize: number;
  extractionStatus: "pending" | "running" | "complete" | "failed" | "skipped";
  createdAtMs: number;
  deletedAtMs: number | null;
}

export interface AttachmentTextRecord {
  id: string;
  mediaType: string;
  byteSize: number;
  text: string;
}

/** Authenticated bounded bytes; blob paths, keys and nonces stay native-only. */
export interface AttachmentBinaryPreviewRecord {
  id: string;
  mediaType: string;
  byteSize: number;
  contentSha256: string;
  dataBase64: string;
}

/**
 * Renderer-safe projection of a native-owned attachment draft. File paths,
 * blob descriptors, key material, nonces, and decrypted bytes are deliberately
 * absent from this contract.
 */
export interface AttachmentDraftRecord {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  branchId: string | null;
  state: AttachmentDraftState;
  expiresAtMs: number;
  bindingKey: string | null;
  boundMessageId: string | null;
  boundRunId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  boundAtMs: number | null;
  abandonedAtMs: number | null;
  expiredAtMs: number | null;
  attachments: AttachmentRecord[];
}

export interface PickAttachmentsRequest {
  conversationId: string;
  branchId: string;
  acceptedMediaTypes?: string[];
  maxFiles?: number;
}

export interface ListAttachmentDraftsRequest {
  conversationId: string;
  branchId?: string;
  includeTerminal?: boolean;
}

export interface ListAttachmentsRequest {
  projectId?: string;
  messageId?: string;
  includeDeleted?: boolean;
}

export interface ReadAttachmentTextRequest {
  attachmentId: string;
  maxBytes?: number;
}

export interface ReadAttachmentBinaryPreviewRequest {
  attachmentId: string;
  /** Full-file limit, not a truncation point; native returns an error above it. */
  maxBytes?: number;
}

export interface NativeProjectFilePointer {
  id: string;
  projectId: string;
  sourcePath: string;
  displayName: string;
  sourceIdentitySha256: string;
  contentSha256: string;
  byteSize: number;
  sourceExists: boolean;
  sourceUpdatedAtMs: number | null;
  snapshotUpdatedAtMs: number;
  revision: number;
}

export interface NativeProjectFilePointerReceipt {
  id: string;
  pointerId: string;
  projectId: string;
  revision: number;
  outcome: "imported" | "updated" | "renamed" | "unchanged" | "source_missing";
  watcherVersion: string;
  sourceIdentitySha256: string;
  contentSha256: string;
  sourceExists: boolean;
  renamed: boolean;
  contentChanged: boolean;
  scannedEntries: number;
  observedAtMs: number;
}

export interface NativeProjectFilePointerMutation {
  pointer: NativeProjectFilePointer;
  receipt: NativeProjectFilePointerReceipt;
}

export interface NativeProjectFilePointerBody {
  pointerId: string;
  revision: number;
  contentSha256: string;
  byteSize: number;
  encoding: "base64";
  content: string;
}

export interface WorkspaceGrantRecord {
  id: string;
  projectId: string | null;
  displayPath: string;
  displayName: string;
  readOnly: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  revokedAtMs: number | null;
}

export interface WorkspaceEntry {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  byteSize: number | null;
  modifiedAtMs: number | null;
}

export interface WorkspaceDirectoryListing {
  grantId: string;
  relativePath: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export interface WorkspaceTextFile {
  grantId: string;
  relativePath: string;
  content: string;
  byteSize: number;
  contentSha256: string;
}

/** Native lexical workspace index policy. Values are bounded again by Rust. */
export interface WorkspaceIndexOptions {
  maxScannedEntries?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
  maxChunks?: number;
  maxReportedSkips?: number;
  maxDepth?: number;
  chunkTargetBytes?: number;
  chunkOverlapBytes?: number;
  includeUnknownText?: boolean;
  ignorePatterns?: string[];
}

export type WorkspaceSkipReason =
  | "ignored_path"
  | "sensitive_path"
  | "sensitive_content"
  | "unsupported_type"
  | "extractor_required"
  | "reparse_point"
  | "scope_violation"
  | "permission_denied"
  | "unreadable"
  | "invalid_utf8"
  | "binary_content"
  | "empty_text"
  | "file_too_large"
  | "changed_during_read"
  | "max_depth_reached"
  | "max_scanned_entries_reached"
  | "max_files_reached"
  | "max_total_bytes_reached"
  | "max_chunks_reached";

export interface IndexedWorkspaceSource {
  sourceId: string;
  versionId: string;
  grantId: string;
  projectId?: string;
  relativePath: string;
  mediaType: string;
  language?: string;
  byteSize: number;
  modifiedAtMs?: number;
  contentSha256: string;
  chunkCount: number;
  tokenEstimate: number;
  truncated: boolean;
  extractorVersion: string;
}

export interface IndexedWorkspaceChunk {
  chunkId: string;
  sourceId: string;
  sourceVersionId: string;
  grantId: string;
  projectId?: string;
  relativePath: string;
  ordinal: number;
  content: string;
  contentSha256: string;
  sourceContentSha256: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  tokenEstimate: number;
  tokenEstimatorVersion: string;
}

export interface WorkspaceSkippedPath {
  relativePath: string;
  reason: WorkspaceSkipReason;
  byteSize?: number;
}

export interface WorkspaceIndexStats {
  scannedEntries: number;
  filesSeen: number;
  directoriesSeen: number;
  indexedFiles: number;
  indexedChunks: number;
  discoveredFileBytes: number;
  indexedFileBytes: number;
  indexedTokenEstimate: number;
  skippedPaths: number;
  reportedSkips: number;
}

export interface WorkspaceIndexSnapshot {
  snapshotId: string;
  snapshotSha256: string;
  indexerVersion: string;
  grantId: string;
  projectId?: string;
  startedAtMs: number;
  completedAtMs: number;
  truncated: boolean;
  hasErrors: boolean;
  skipReportTruncated: boolean;
  stats: WorkspaceIndexStats;
  sources: IndexedWorkspaceSource[];
  chunks: IndexedWorkspaceChunk[];
  skipped: WorkspaceSkippedPath[];
}

export interface WorkspaceRetrievalOptions {
  tokenBudget?: number;
  maxResults?: number;
  maxResultsPerSource?: number;
  minimumScore?: number;
  diversityLambda?: number;
  maxReportedOmissions?: number;
}

export type WorkspaceRetrievalReason =
  | "query_terms"
  | "exact_phrase"
  | "path_match"
  | "diversity_selected";

export type WorkspaceRetrievalOmissionReason =
  | "no_query_match"
  | "below_threshold"
  | "duplicate_content"
  | "source_limit"
  | "token_budget"
  | "max_results";

export interface WorkspaceRetrievalMatch {
  rank: number;
  score: number;
  reasons: WorkspaceRetrievalReason[];
  chunk: IndexedWorkspaceChunk;
}

export interface WorkspaceRetrievalOmission {
  chunkId: string;
  reason: WorkspaceRetrievalOmissionReason;
}

export interface WorkspaceRetrievalResult {
  querySha256: string;
  scorerVersion: string;
  tokenBudget: number;
  consumedTokens: number;
  totalChunks: number;
  matchedCandidates: number;
  omissionReportTruncated: boolean;
  matches: WorkspaceRetrievalMatch[];
  omissions: WorkspaceRetrievalOmission[];
}

export interface RetrieveWorkspaceForRunRequest {
  runId: string;
  attemptId: string;
  frozenProviderInputId: string;
  grantId: string;
  query: string;
  indexOptions?: WorkspaceIndexOptions;
  retrievalOptions?: WorkspaceRetrievalOptions;
}

export interface RunWorkspaceRetrievalResult {
  retrieval: WorkspaceRetrievalResult;
  indexSnapshotId: string;
  indexSnapshotSha256: string;
  indexTruncated: boolean;
  indexHasErrors: boolean;
  indexStats: WorkspaceIndexStats;
  journalEvent: RunJournalEventRecord;
  providerInputAdmission: "not_admitted";
}

export type SecretStatus = "present" | "missing" | "locked";

export interface ProviderProfileRecord {
  id: string;
  providerType: string;
  displayName: string;
  normalizedBaseUrl: string;
  authScheme: string;
  organizationId: string | null;
  remoteProjectId: string | null;
  credentialStatus: SecretStatus;
  localNetworkGrant: boolean;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SaveProviderProfileRequest {
  providerType: string;
  displayName: string;
  baseUrl: string;
  authScheme?: string;
  organizationId?: string;
  remoteProjectId?: string;
  secret?: string;
  allowLocalNetwork?: boolean;
}

export interface ProviderProfileReceipt {
  profile: ProviderProfileRecord;
  secretStatus: SecretStatus;
}

export interface ProviderConnectionProbeRequest extends SaveProviderProfileRequest {
  profileId?: string;
  credentialRef?: string;
  modelHint?: string;
}

export interface ProviderModelRecord {
  id: string;
  displayName: string;
  ownedBy?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  capabilities: string[];
}

export interface ProviderConnectionProbeResult {
  healthy: boolean;
  normalizedBaseUrl: string;
  latencyMs: number | null;
  models: ProviderModelRecord[];
  warning?: string;
}

export interface ProviderConnectionHealth {
  profileId: string;
  healthy: boolean;
  latencyMs: number;
  modelCount: number;
  checkedAt: string;
}

export interface NativeProviderModel {
  id: string;
  displayName: string;
  ownedBy: string | null;
  createdAt: number | null;
  capabilities: {
    streaming: boolean;
    tools: boolean | null;
    vision: boolean | null;
    reasoning: boolean | null;
    source: string;
  };
}

export interface ProviderModelList {
  profileId: string;
  models: NativeProviderModel[];
  discoveredAt: string;
}

export interface StartPreparedAttemptRequest {
  attemptId: string;
  frozenProviderInputId: string;
}

export interface NativeComparePreparedRoute {
  routeId: string;
  attemptId: string;
  frozenProviderInputId: string;
}

export type NativeCompareAttemptStatus = "completed" | "failed" | "cancelled" | "unknown";

export interface NativeCompareUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface NativeCompareAttemptResult {
  attemptId: string;
  routeId: string;
  preparedAttemptId: string;
  providerId: string;
  adapterId: string;
  modelId: string;
  status: NativeCompareAttemptStatus;
  output?: string;
  outputSha256?: string;
  usage: NativeCompareUsage;
  stopReason?: string;
  errorCode?: string;
}

export interface NativeCompareExecutePreparedRequest {
  compareId: string;
  routes: NativeComparePreparedRoute[];
}

export interface NativeCompareExecutePreparedResult {
  schemaVersion: number;
  compareId: string;
  logicalInputSha256: string;
  attempts: NativeCompareAttemptResult[];
  completedAtMs: number;
}

/**
 * Renderer policy for a completed native compare fan-out.
 *
 * A compare attempt can have reached a provider before its terminal outcome
 * was observed.  The native projection marks that attempt `unknown`; the
 * renderer must keep the compare visible for reconciliation and must never
 * turn the result into an automatic retry.  Definitive failures are also
 * returned with `no_automatic_replay`: retrying is a user/workflow decision
 * that must create a fresh prepared attempt rather than replaying opaque
 * identifiers from this result.
 */
export type NativeCompareReplayDisposition =
  | "no_automatic_replay"
  | "reconciliation_required";

export interface NativeCompareReplayAssessment {
  compareId: string;
  disposition: NativeCompareReplayDisposition;
  automaticRetryAllowed: false;
  unknownAttemptIds: string[];
  definitiveFailureAttemptIds: string[];
  completedAttemptIds: string[];
  cancelledAttemptIds: string[];
  reason: string;
}

/**
 * Derives the fail-closed replay policy from a native compare projection.
 *
 * This is intentionally a pure reducer so it can be applied after a native
 * response, after journal replay, and in browser-preview tests without
 * fabricating a provider result.  The native command remains authoritative
 * for attempt state; this helper only decides whether the renderer may offer
 * an automatic replay affordance.
 */
export function assessNativeCompareReplay(
  result: NativeCompareExecutePreparedResult,
): NativeCompareReplayAssessment {
  const unknownAttemptIds: string[] = [];
  const definitiveFailureAttemptIds: string[] = [];
  const completedAttemptIds: string[] = [];
  const cancelledAttemptIds: string[] = [];

  for (const attempt of result.attempts) {
    if (attempt.status === "unknown") unknownAttemptIds.push(attempt.attemptId);
    else if (attempt.status === "failed") definitiveFailureAttemptIds.push(attempt.attemptId);
    else if (attempt.status === "completed") completedAttemptIds.push(attempt.attemptId);
    else if (attempt.status === "cancelled") cancelledAttemptIds.push(attempt.attemptId);
  }

  const reconciliationRequired = unknownAttemptIds.length > 0;
  return {
    compareId: result.compareId,
    disposition: reconciliationRequired ? "reconciliation_required" : "no_automatic_replay",
    automaticRetryAllowed: false,
    unknownAttemptIds,
    definitiveFailureAttemptIds,
    completedAttemptIds,
    cancelledAttemptIds,
    reason: reconciliationRequired
      ? "One or more provider attempts were accepted but their terminal outcome is unknown. Reconcile the durable attempt before creating any new side effect."
      : "The compare is terminal. Any retry must be an explicit new prepared attempt; opaque compare attempt identities are never replayed automatically.",
  };
}

/**
 * Guard used by renderer flows before exposing a replay action.  Unknown
 * outcomes are a hard stop: callers must reconcile the native journal first.
 * The return value for definitive terminal results is still a policy object so
 * a caller cannot accidentally interpret this helper as permission to replay.
 */
export function requireNativeCompareReconciliation(
  result: NativeCompareExecutePreparedResult,
): NativeCompareReplayAssessment {
  const assessment = assessNativeCompareReplay(result);
  if (assessment.disposition === "reconciliation_required") {
    const error = new Error(assessment.reason) as Error & Partial<NativeCommandError>;
    error.name = "NativeCompareOutcomeUnknown";
    error.code = "compare_outcome_unknown";
    error.retryable = false;
    error.acceptance = "unknown";
    throw error;
  }
  return assessment;
}

/** Renderer-safe projection of one broker-fed native download job. */
export type DownloadJobState =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface DownloadJobView {
  jobId: string;
  sourceReceiptId: string;
  outputFilename: string;
  mediaType: string;
  state: DownloadJobState;
  receivedBytes: number;
  expectedBytes: number | null;
  checkpointBytes: number;
  createdAt: string;
  updatedAt: string;
  outputBlobId: string | null;
  errorCode: string | null;
}

export interface CreateDownloadJobRequest {
  sourceReceiptId: string;
  outputFilename: string;
  mediaType: string;
  expectedBytes?: number;
}

export interface DownloadJobRequest {
  jobId: string;
}

export interface AppendDownloadChunkRequest {
  jobId: string;
  /** Bounded broker-authorized bytes; native enforces the chunk limit. */
  chunk: readonly number[];
}

/** Native isolated-input capability and lease DTOs. */
export type IsolatedInputCapability =
  | "detached-input"
  | "cursor-overlay"
  | "frame-capture"
  | "unfocused-capture"
  | "headless-capture";

export type IsolatedInputTargetKind = "process" | "window" | "surface";
export type IsolatedInputMode = "visible" | "unfocused" | "headless";
export type IsolatedInputSessionState =
  | "starting"
  | "active"
  | "paused"
  | "stopped"
  | "failed";
export type IsolatedInputChannelState = "active" | "paused" | "closed";
export type IsolatedInputAvailability = "available" | "degraded" | "unavailable";
export type IsolatedInputPointerPhase = "move" | "down" | "up" | "wheel";
export type IsolatedInputPointerButton = "left" | "middle" | "right" | "back" | "forward";
export type IsolatedInputKeyboardPhase = "down" | "up" | "text";
export type IsolatedInputModifier = "alt" | "ctrl" | "meta" | "shift";

export interface IsolatedInputCapabilityDescriptor {
  capability: IsolatedInputCapability;
  availability: IsolatedInputAvailability;
  reason: string;
}

export interface IsolatedInputCapabilitiesReceipt {
  schemaVersion: number;
  capabilitySnapshotId: string;
  platform: string;
  backend: string;
  capabilities: IsolatedInputCapabilityDescriptor[];
}

export interface IsolatedInputSessionCreateRequest {
  targetKind: IsolatedInputTargetKind;
  targetRef: string;
  mode: IsolatedInputMode;
  leaseMs: number;
  userAuthorized: boolean;
  authorizationReceiptId: string;
  requestedCapabilities?: readonly IsolatedInputCapability[];
  runId?: string;
}

export interface IsolatedInputSessionReadRequest {
  sessionId: string;
}

export interface IsolatedInputSessionStopRequest {
  sessionId: string;
}

export interface IsolatedInputSessionReceipt {
  schemaVersion: number;
  sessionId: string;
  targetKind: IsolatedInputTargetKind;
  mode: IsolatedInputMode;
  state: IsolatedInputSessionState;
  routing: string;
  expiresAt: string;
  capabilities: IsolatedInputCapability[];
  lastErrorCode?: string;
}

export interface IsolatedInputChannelAttachRequest {
  sessionId: string;
}

export interface IsolatedInputChannelDetachRequest {
  channelId: string;
}

export interface IsolatedInputChannelReceipt {
  schemaVersion: number;
  channelId: string;
  sessionId: string;
  targetKind: IsolatedInputTargetKind;
  state: IsolatedInputChannelState;
  routing: string;
  cursor: string;
  createdAt: string;
}

export type IsolatedInputEvent =
  | {
      kind: "pointer";
      phase: IsolatedInputPointerPhase;
      x: number;
      y: number;
      button?: IsolatedInputPointerButton;
      deltaX?: number;
      deltaY?: number;
      modifiers?: readonly IsolatedInputModifier[];
    }
  | {
      kind: "keyboard";
      phase: IsolatedInputKeyboardPhase;
      code: string;
      key: string;
      text?: string;
      modifiers?: readonly IsolatedInputModifier[];
    };

export interface IsolatedInputEventSendRequest {
  channelId: string;
  event: IsolatedInputEvent;
}

export interface IsolatedInputEventReceipt {
  accepted: boolean;
  channelId: string;
  reason: string;
}

const browserPreviewModels: Record<string, ProviderModelRecord[]> = {
  openai: [
    { id: "gpt-5", displayName: "GPT-5", capabilities: ["text", "vision", "tools", "reasoning", "json-schema"] },
  ],
  deepseek: [
    { id: "deepseek-chat", displayName: "DeepSeek Chat", capabilities: ["text", "tools", "json-schema"] },
    { id: "deepseek-reasoner", displayName: "DeepSeek Reasoner", capabilities: ["text", "reasoning"] },
  ],
  anthropic: [
    { id: "claude-opus-4-1", displayName: "Claude Opus 4.1", capabilities: ["text", "vision", "tools", "reasoning"] },
  ],
  gemini: [
    { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", capabilities: ["text", "vision", "audio", "tools", "reasoning", "json-schema"] },
  ],
  "openai-compatible": [
    { id: "custom-model", displayName: "Discovered compatible model", capabilities: ["text", "tools", "json-schema"] },
  ],
  openai_compatible: [
    { id: "custom-model", displayName: "Discovered compatible model", capabilities: ["text", "tools", "json-schema"] },
  ],
  local: [
    { id: "local-model", displayName: "Local compatible model", capabilities: ["text", "tools", "json-schema"] },
  ],
};

export type RunStreamEvent =
  | {
      type: "started";
      runId: string;
      createdAt: string;
      providerProfileId?: string;
      model?: string;
      journalEvents?: RunJournalEventRecord[];
    }
  | {
      type: "delta";
      runId: string;
      sequence: number;
      text: string;
      journalEvents?: RunJournalEventRecord[];
    }
  | {
      type: "reasoningDelta";
      runId: string;
      sequence: number;
      text: string;
      journalEvents?: RunJournalEventRecord[];
    }
  | {
      type: "usage";
      runId: string;
      inputTokens: number | null;
      outputTokens: number | null;
      cachedInputTokens: number | null;
      /** Provider-native cache read tokens when the adapter reports them. */
      cacheReadInputTokens?: number | null;
      /** Provider-native cache creation/write tokens when reported. */
      cacheWriteInputTokens?: number | null;
      reasoningTokens: number | null;
      journalEvents?: RunJournalEventRecord[];
    }
  | { type: "warning"; runId: string; code: string; message: string }
  | {
      type: "completed";
      runId: string;
      finishReason: string;
      journalEvents?: RunJournalEventRecord[];
    }
  | {
      type: "error";
      runId: string;
      code: string;
      message: string;
      retryable: boolean;
      errorClass: ProviderErrorClass;
      status?: number | null;
      retryAfterMs?: number | null;
      journalEvents?: RunJournalEventRecord[];
    };

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

function browserRuntimeInfo(): AppRuntimeInfo {
  return {
    appName: "Omnia",
    appVersion: import.meta.env.PACKAGE_VERSION ?? "0.1.0-dev",
    platform: "web",
    tauri: false,
    debug: import.meta.env.DEV,
  };
}

export const desktop = {
  async runtimeInfo(): Promise<AppRuntimeInfo> {
    if (!isDesktopRuntime()) return browserRuntimeInfo();
    return invoke<AppRuntimeInfo>("runtime_info");
  },

  async initializeCore(appVersion: string): Promise<CoreRuntimeInfo> {
    if (!isDesktopRuntime()) {
      return {
        protocolVersion: OMNIA_PROTOCOL_VERSION,
        serverInfo: { name: "omnia-browser-preview", title: "Omnia Browser Preview", version: appVersion },
        capabilities: [
          "run.stream.v1",
          "project.v1",
          "provider.capability-negotiation.v1",
        ],
        unavailableCapabilities: [
          "run.replay-cursor",
          "server-request.resolve",
          "skill.prompt-only",
          "memory.read-write",
          "workspace.write",
          "process.execute",
          "browser.control",
          "computer.control",
        ],
        sessionToken: null,
        sessionEpoch: null,
      };
    }
    if (!coreInitialization) {
      coreSessionToken = null;
      coreInitialization = invoke<CoreRuntimeInfo>("core_initialize", {
        request: createDesktopInitializeRequest(appVersion),
      }).then((response) => {
        assertCompatibleNativeCore(response);
        coreSessionToken = response.sessionToken;
        return response;
      }).catch((error: unknown) => {
        coreSessionToken = null;
        coreInitialization = null;
        throw error;
      });
    }
    return coreInitialization;
  },

  async storageHealth(): Promise<StorageHealth> {
    requireDesktop("Local storage health");
    return invokeCore<StorageHealth>("storage_health");
  },

  /** Atomically admits one runtime intent and its first queued outbox row. */
  async runtimeOperationAppend(
    request: RuntimeOperationAppendRequest,
  ): Promise<RuntimeOperationReceipt> {
    requireDesktop("Runtime operation admission");
    return invokeCore<RuntimeOperationReceipt>("runtime_operation_append", { request });
  },

  /** Reads the immutable first outbox attempt for an admitted runtime intent. */
  async readRuntimeOutbox(operationId: string): Promise<RuntimeOutboxRecord | null> {
    requireDesktop("Runtime outbox reads");
    return invokeCore<RuntimeOutboxRecord | null>("runtime_outbox_read", { operationId });
  },

  async leaseRuntimeOutbox(
    request: RuntimeOutboxLeaseRequest,
  ): Promise<RuntimeOutboxLeaseReceipt> {
    requireDesktop("Runtime outbox leasing");
    return invokeCore<RuntimeOutboxLeaseReceipt>("runtime_outbox_lease", { request });
  },

  async settleRuntimeOutbox(
    request: RuntimeOutboxSettleRequest,
  ): Promise<RuntimeOutboxSettlementReceipt> {
    requireDesktop("Runtime outbox settlement");
    return invokeCore<RuntimeOutboxSettlementReceipt>("runtime_outbox_settle", { request });
  },

  async runtimeEventAppend(
    request: RuntimeEventAppendRequest,
  ): Promise<RuntimeEventReceipt> {
    requireDesktop("Runtime lifecycle receipt admission");
    return invokeCore<RuntimeEventReceipt>("runtime_event_append", { request });
  },

  async readRuntimeEvents(operationId: string): Promise<RuntimeEventReceipt[]> {
    requireDesktop("Runtime lifecycle receipt reads");
    return invokeCore<RuntimeEventReceipt[]>("runtime_events_read", { operationId });
  },

  /** Loads the renderer-owned composition snapshot from the native JSON store. */
  async loadAppStateSnapshot(
    request: LoadAppStateSnapshotRequest = {},
  ): Promise<AppStateSnapshotLoadResponse> {
    requireDesktop("App-state snapshot loading");
    return invokeCore<AppStateSnapshotLoadResponse>("app_state_snapshot_load", {
      request,
    });
  },

  /** Saves the renderer-owned composition snapshot with optional compare-and-swap. */
  async saveAppStateSnapshot(
    request: SaveAppStateSnapshotRequest,
  ): Promise<AppStateSnapshotSaveResponse> {
    requireDesktop("App-state snapshot saving");
    return invokeCore<AppStateSnapshotSaveResponse>("app_state_snapshot_save", {
      request,
    });
  },

  /** Validates and returns a detached transfer bundle without applying it. */
  async exportAppStateTransfer(
    request: AppStateTransferRequest,
  ): Promise<AppStateTransferResponse> {
    requireDesktop("App-state transfer export");
    return invokeCore<AppStateTransferResponse>("app_state_transfer_export", {
      request,
    });
  },

  /** Validates and returns a detached transfer bundle for domain-level merge. */
  async importAppStateTransfer(
    request: AppStateTransferRequest,
  ): Promise<AppStateTransferResponse> {
    requireDesktop("App-state transfer import");
    return invokeCore<AppStateTransferResponse>("app_state_transfer_import", {
      request,
    });
  },

  async appStatePersistenceHealth(): Promise<AppStatePersistenceHealth> {
    requireDesktop("App-state persistence health");
    return invokeCore<AppStatePersistenceHealth>("app_state_persistence_health");
  },

  /** Loads the durable settings/permission document from the native store. */
  async loadSettingsPermissionsSnapshot(
    request: LoadSettingsPermissionsSnapshotRequest = {},
  ): Promise<SettingsPermissionsSnapshotLoadResponse> {
    requireDesktop("Settings and permission snapshot loading");
    return invokeCore<SettingsPermissionsSnapshotLoadResponse>(
      "settings_permissions_snapshot_load",
      { request },
    );
  },

  /** Saves settings/permission JSON with optional compare-and-swap. */
  async saveSettingsPermissionsSnapshot(
    request: SaveSettingsPermissionsSnapshotRequest,
  ): Promise<SettingsPermissionsSnapshotSaveResponse> {
    requireDesktop("Settings and permission snapshot saving");
    return invokeCore<SettingsPermissionsSnapshotSaveResponse>(
      "settings_permissions_snapshot_save",
      { request },
    );
  },

  async settingsPermissionsPersistenceHealth(): Promise<SettingsPermissionsPersistenceHealth> {
    requireDesktop("Settings and permission persistence health");
    return invokeCore<SettingsPermissionsPersistenceHealth>(
      "settings_permissions_persistence_health",
    );
  },

  /** Lists native isolated-input/capture capabilities without opening a lease. */
  async isolatedInputCapabilities(): Promise<IsolatedInputCapabilitiesReceipt> {
    requireDesktop("Isolated input capability discovery");
    return invokeCore<IsolatedInputCapabilitiesReceipt>("isolated_input_capabilities");
  },

  /** Opens an explicitly authorized, target-scoped isolated-input lease. */
  async createIsolatedInputSession(
    request: IsolatedInputSessionCreateRequest,
  ): Promise<IsolatedInputSessionReceipt> {
    requireDesktop("Isolated input session creation");
    return invokeCore<IsolatedInputSessionReceipt>("isolated_input_session_create", { request });
  },

  async readIsolatedInputSession(
    request: IsolatedInputSessionReadRequest,
  ): Promise<IsolatedInputSessionReceipt> {
    requireDesktop("Isolated input session reads");
    return invokeCore<IsolatedInputSessionReceipt>("isolated_input_session_read", { request });
  },

  async stopIsolatedInputSession(
    request: IsolatedInputSessionStopRequest,
  ): Promise<IsolatedInputSessionReceipt> {
    requireDesktop("Isolated input session stop");
    return invokeCore<IsolatedInputSessionReceipt>("isolated_input_session_stop", { request });
  },

  async attachIsolatedInputChannel(
    request: IsolatedInputChannelAttachRequest,
  ): Promise<IsolatedInputChannelReceipt> {
    requireDesktop("Isolated input channel attach");
    return invokeCore<IsolatedInputChannelReceipt>("isolated_input_channel_attach", { request });
  },

  async detachIsolatedInputChannel(
    request: IsolatedInputChannelDetachRequest,
  ): Promise<IsolatedInputEventReceipt> {
    requireDesktop("Isolated input channel detach");
    return invokeCore<IsolatedInputEventReceipt>("isolated_input_channel_detach", { request });
  },

  async sendIsolatedInputEvent(
    request: IsolatedInputEventSendRequest,
  ): Promise<IsolatedInputEventReceipt> {
    requireDesktop("Isolated input event dispatch");
    return invokeCore<IsolatedInputEventReceipt>("isolated_input_event_send", { request });
  },

  /** Creates an IDM-like broker-fed download job from an opaque source lease. */
  async createDownloadJob(request: CreateDownloadJobRequest): Promise<DownloadJobView> {
    requireDesktop("Download job creation");
    return invokeCore<DownloadJobView>("download_job_create", { request });
  },

  async startDownloadJob(request: DownloadJobRequest): Promise<DownloadJobView> {
    requireDesktop("Download job start");
    return invokeCore<DownloadJobView>("download_job_start", { request });
  },

  async pauseDownloadJob(request: DownloadJobRequest): Promise<DownloadJobView> {
    requireDesktop("Download job pause");
    return invokeCore<DownloadJobView>("download_job_pause", { request });
  },

  async resumeDownloadJob(request: DownloadJobRequest): Promise<DownloadJobView> {
    requireDesktop("Download job resume");
    return invokeCore<DownloadJobView>("download_job_resume", { request });
  },

  async cancelDownloadJob(request: DownloadJobRequest): Promise<DownloadJobView> {
    requireDesktop("Download job cancellation");
    return invokeCore<DownloadJobView>("download_job_cancel", { request });
  },

  async appendDownloadChunk(request: AppendDownloadChunkRequest): Promise<DownloadJobView> {
    requireDesktop("Download chunk append");
    return invokeCore<DownloadJobView>("download_job_append_chunk", { request });
  },

  async completeDownloadJob(request: DownloadJobRequest): Promise<DownloadJobView> {
    requireDesktop("Download job completion");
    return invokeCore<DownloadJobView>("download_job_complete", { request });
  },

  async getDownloadJob(request: DownloadJobRequest): Promise<DownloadJobView> {
    requireDesktop("Download job reads");
    return invokeCore<DownloadJobView>("download_job_get", { request });
  },

  async listDownloadJobs(): Promise<DownloadJobView[]> {
    requireDesktop("Download job listing");
    return invokeCore<DownloadJobView[]>("download_job_list");
  },

  async createProject(request: CreateProjectRequest): Promise<ProjectRecord> {
    requireDesktop("Project creation");
    return invokeCore<ProjectRecord>("project_create", { request });
  },

  async updateProjectMetadata(
    request: UpdateProjectMetadataRequest,
  ): Promise<ProjectRecord> {
    requireDesktop("Project metadata updates");
    return invokeCore<ProjectRecord>("project_update", { request });
  },

  async listProjects(): Promise<ProjectRecord[]> {
    requireDesktop("Project listing");
    return invokeCore<ProjectRecord[]>("project_list");
  },

  /** Creates one native-authoritative Goal and its first immutable revision. */
  async createGoal(request: CreateGoalRequest): Promise<GoalSnapshot> {
    requireDesktop("Goal creation");
    return invokeCore<GoalSnapshot>("goal_create", { request });
  },

  /** Reads the verified current Goal projection and revision. */
  async readGoal(request: ReadGoalRequest): Promise<GoalSnapshot> {
    requireDesktop("Goal reads");
    return invokeCore<GoalSnapshot>("goal_read", { request });
  },

  /** Lists bounded, hash-verified Goal summaries. */
  async listGoals(request: ListGoalsRequest = {}): Promise<GoalSummary[]> {
    requireDesktop("Goal listing");
    return invokeCore<GoalSummary[]>("goal_list", { request });
  },

  /** Reads one immutable Goal revision after native ownership checks. */
  async readGoalRevision(request: ReadGoalRevisionRequest): Promise<GoalRevisionRecord> {
    requireDesktop("Goal revision reads");
    return invokeCore<GoalRevisionRecord>("goal_revision_read", { request });
  },

  /** Appends one immutable Goal revision and advances its root projection. */
  async createGoalRevision(request: CreateGoalRevisionRequest): Promise<GoalSnapshot> {
    requireDesktop("Goal revision creation");
    return invokeCore<GoalSnapshot>("goal_revision_create", { request });
  },

  /** Applies one validated Goal lifecycle transition as an immutable revision. */
  async updateGoalStatus(request: UpdateGoalStatusRequest): Promise<GoalSnapshot> {
    requireDesktop("Goal status updates");
    return invokeCore<GoalSnapshot>("goal_status_update", { request });
  },

  /** Creates one native-authoritative Task under an existing Goal. */
  async createTask(request: CreateTaskRequest): Promise<TaskSnapshot> {
    requireDesktop("Task creation");
    return invokeCore<TaskSnapshot>("task_create", { request });
  },

  /** Reads a verified Task projection, revision, and dependency summary. */
  async readTask(request: ReadTaskRequest): Promise<TaskSnapshot> {
    requireDesktop("Task reads");
    return invokeCore<TaskSnapshot>("task_read", { request });
  },

  /** Lists bounded Task summaries within the supplied native scope filters. */
  async listTasks(request: ListTasksRequest = {}): Promise<TaskSummary[]> {
    requireDesktop("Task listing");
    return invokeCore<TaskSummary[]>("task_list", { request });
  },

  /** Reads one immutable historical Task revision. */
  async readTaskRevision(request: ReadTaskRevisionRequest): Promise<TaskRevisionRecord> {
    requireDesktop("Task revision reads");
    return invokeCore<TaskRevisionRecord>("task_revision_read", { request });
  },

  /** Appends one immutable Task revision and advances its root projection. */
  async createTaskRevision(request: CreateTaskRevisionRequest): Promise<TaskSnapshot> {
    requireDesktop("Task revision creation");
    return invokeCore<TaskSnapshot>("task_revision_create", { request });
  },

  /** Applies one validated Task lifecycle transition as an immutable revision. */
  async updateTaskStatus(request: UpdateTaskStatusRequest): Promise<TaskSnapshot> {
    requireDesktop("Task status updates");
    return invokeCore<TaskSnapshot>("task_status_update", { request });
  },

  /** Adds one native cycle-checked Task dependency. */
  async createTaskDependency(
    request: CreateTaskDependencyRequest,
  ): Promise<TaskDependencyRecord> {
    requireDesktop("Task dependency creation");
    return invokeCore<TaskDependencyRecord>("task_dependency_create", { request });
  },

  /** Lists the bounded dependency projection for one Task. */
  async listTaskDependencies(
    request: ListTaskDependenciesRequest,
  ): Promise<TaskDependencyRecord[]> {
    requireDesktop("Task dependencies");
    return invokeCore<TaskDependencyRecord[]>("task_dependency_list", { request });
  },

  /** Creates one native-authoritative, preview-only Starter Workflow. */
  async createStarterWorkflow(
    request: CreateStarterWorkflowRequest,
  ): Promise<StarterWorkflowSnapshot> {
    requireDesktop("Starter Workflow creation");
    return invokeCore<StarterWorkflowSnapshot>("starter_workflow_create", { request });
  },

  /** Reads a verified Starter Workflow projection and current revision. */
  async readStarterWorkflow(
    request: ReadStarterWorkflowRequest,
  ): Promise<StarterWorkflowSnapshot> {
    requireDesktop("Starter Workflow reads");
    return invokeCore<StarterWorkflowSnapshot>("starter_workflow_read", { request });
  },

  /** Lists bounded Starter Workflow summaries. */
  async listStarterWorkflows(
    request: ListStarterWorkflowsRequest = {},
  ): Promise<StarterWorkflowSummary[]> {
    requireDesktop("Starter Workflow listing");
    return invokeCore<StarterWorkflowSummary[]>("starter_workflow_list", { request });
  },

  /** Reads one immutable historical Starter Workflow revision. */
  async readStarterWorkflowRevision(
    request: ReadStarterWorkflowRevisionRequest,
  ): Promise<StarterWorkflowRevisionRecord> {
    requireDesktop("Starter Workflow revision reads");
    return invokeCore<StarterWorkflowRevisionRecord>("starter_workflow_revision_read", { request });
  },

  /** Appends one immutable Starter Workflow revision. */
  async createStarterWorkflowRevision(
    request: CreateStarterWorkflowRevisionRequest,
  ): Promise<StarterWorkflowSnapshot> {
    requireDesktop("Starter Workflow revision creation");
    return invokeCore<StarterWorkflowSnapshot>("starter_workflow_revision_create", { request });
  },

  /** Applies one validated Starter Workflow lifecycle transition. */
  async updateStarterWorkflowStatus(
    request: UpdateStarterWorkflowStatusRequest,
  ): Promise<StarterWorkflowSnapshot> {
    requireDesktop("Starter Workflow status updates");
    return invokeCore<StarterWorkflowSnapshot>("starter_workflow_status_update", { request });
  },

  /** Applies an enabled-only Starter Workflow lifecycle mutation. */
  async updateStarterWorkflowEnabled(
    request: UpdateStarterWorkflowEnabledRequest,
  ): Promise<StarterWorkflowSnapshot> {
    requireDesktop("Starter Workflow enabled updates");
    return invokeCore<StarterWorkflowSnapshot>("starter_workflow_enabled_update", { request });
  },

  async createConversation(projectId?: string, title?: string): Promise<ConversationSnapshot> {
    requireDesktop("Conversation creation");
    return invokeCore<ConversationSnapshot>("conversation_create", {
      request: { projectId, title },
    });
  },

  async listConversations(): Promise<ConversationSnapshot[]> {
    requireDesktop("Conversation listing");
    return invokeCore<ConversationSnapshot[]>("conversation_list");
  },

  async forkConversationBranch(
    request: ForkConversationBranchRequest,
  ): Promise<ConversationSnapshot> {
    requireDesktop("Conversation branching");
    return invokeCore<ConversationSnapshot>("conversation_branch_fork", { request });
  },

  async activateConversationBranch(
    request: ActivateConversationBranchRequest,
  ): Promise<ConversationSnapshot> {
    requireDesktop("Conversation branch activation");
    return invokeCore<ConversationSnapshot>("conversation_branch_activate", { request });
  },

  async appendStateRevision(
    request: StateRevisionAppendRequest,
  ): Promise<StateRevisionMutationResult> {
    requireDesktop("Immutable state revisions");
    return invokeCore<StateRevisionMutationResult>("state_revision_append", { request });
  },

  async readStateRevisionGraph(
    request: ReadStateRevisionGraphRequest,
  ): Promise<StateRevisionGraphSnapshot> {
    requireDesktop("State-revision graph inspection");
    return invokeCore<StateRevisionGraphSnapshot>("state_revision_graph_read", { request });
  },

  /** Resolves a user/agent run-control intent against one immutable state base. */
  async resolveRunControl(
    request: RunControlOperationIntent,
  ): Promise<ResolvedRunControlOperation> {
    requireDesktop("Run-control resolution");
    return invokeCore<ResolvedRunControlOperation>("run_control_resolve", { request });
  },

  /** Applies a previously resolved operation at the native commit boundary. */
  async applyRunControl(request: RunControlApplyRequest): Promise<RunControlApplyResult> {
    requireDesktop("Run-control application");
    return invokeCore<RunControlApplyResult>("run_control_apply", { request });
  },

  /** Persists a typed checkpoint; native decides whether it is cooperative,
   * provider-supported, or requires reconciliation. */
  async createRunCheckpoint(request: CreateRunCheckpointRequest): Promise<RunCheckpointRecord> {
    requireDesktop("Run checkpoints");
    return invokeCore<RunCheckpointRecord>("checkpoint_create", { request });
  },

  async readRunCheckpoint(
    request: ReadRunCheckpointRequest,
  ): Promise<RunCheckpointRecord | null> {
    requireDesktop("Run checkpoints");
    return invokeCore<RunCheckpointRecord | null>("checkpoint_read", { request });
  },

  /** Resolves no-text continuation into a bounded, loop-guarded intent. */
  async resolveContinuationIntent(
    request: ResolveContinuationIntentRequest,
  ): Promise<ContinuationIntent> {
    requireDesktop("Continuation intents");
    return invokeCore<ContinuationIntent>("continuation_intent_resolve", { request });
  },

  /** Creates an immutable message/prompt revision without overwriting the
   * original message or implicitly rebasing an active provider request. */
  async resolveMessageRevision(
    request: ResolveMessageRevisionRequest,
  ): Promise<MessageRevision> {
    requireDesktop("Message revisions");
    return invokeCore<MessageRevision>("message_revision_resolve", { request });
  },

  async prepareConversationRun(
    request: PrepareConversationRunRequest,
  ): Promise<PreparedConversationRun> {
    requireDesktop("Durable chat runs");
    return invokeCore<PreparedConversationRun>("conversation_run_prepare", { request });
  },

  async pickAttachments(request: PickAttachmentsRequest): Promise<AttachmentDraftRecord | null> {
    requireDesktop("Attachment selection");
    return invokeCore<AttachmentDraftRecord | null>("attachment_pick", { request });
  },

  async getAttachmentDraft(draftId: string): Promise<AttachmentDraftRecord> {
    requireDesktop("Attachment drafts");
    return invokeCore<AttachmentDraftRecord>("attachment_draft_get", {
      request: { draftId },
    });
  },

  async listAttachmentDrafts(
    request: ListAttachmentDraftsRequest,
  ): Promise<AttachmentDraftRecord[]> {
    requireDesktop("Attachment drafts");
    return invokeCore<AttachmentDraftRecord[]>("attachment_draft_list", { request });
  },

  async removeAttachmentFromDraft(
    draftId: string,
    attachmentId: string,
  ): Promise<AttachmentDraftRecord> {
    requireDesktop("Attachment drafts");
    return invokeCore<AttachmentDraftRecord>("attachment_draft_remove", {
      request: { draftId, attachmentId },
    });
  },

  async abandonAttachmentDraft(draftId: string): Promise<AttachmentDraftRecord> {
    requireDesktop("Attachment drafts");
    return invokeCore<AttachmentDraftRecord>("attachment_draft_abandon", {
      request: { draftId },
    });
  },

  async listAttachments(request: ListAttachmentsRequest = {}): Promise<AttachmentRecord[]> {
    requireDesktop("Attachment metadata");
    return invokeCore<AttachmentRecord[]>("attachment_list", { request });
  },

  async readAttachmentText(
    request: ReadAttachmentTextRequest,
  ): Promise<AttachmentTextRecord> {
    requireDesktop("Attachment text reading");
    return invokeCore<AttachmentTextRecord>("attachment_text_read", { request });
  },

  async readAttachmentBinaryPreview(
    request: ReadAttachmentBinaryPreviewRequest,
  ): Promise<AttachmentBinaryPreviewRecord> {
    requireDesktop("Attachment binary preview");
    return invokeCore<AttachmentBinaryPreviewRecord>("attachment_binary_preview", { request });
  },

  async pickProjectFiles(projectId: string): Promise<NativeProjectFilePointerMutation[] | null> {
    requireDesktop("Project file pointers");
    return invokeCore<NativeProjectFilePointerMutation[] | null>("project_file_pointer_pick", { request: { projectId } });
  },

  async listProjectFilePointers(projectId: string): Promise<NativeProjectFilePointer[]> {
    requireDesktop("Project file pointers");
    return invokeCore<NativeProjectFilePointer[]>("project_file_pointer_list", { request: { projectId } });
  },

  async refreshProjectFilePointer(projectId: string, pointerId: string, expectedRevision: number): Promise<NativeProjectFilePointerMutation> {
    requireDesktop("Project file synchronization");
    return invokeCore<NativeProjectFilePointerMutation>("project_file_pointer_refresh", { request: { projectId, pointerId, expectedRevision } });
  },

  async readProjectFilePointer(projectId: string, pointerId: string, expectedRevision: number): Promise<NativeProjectFilePointerBody> {
    requireDesktop("Retained project file content");
    return invokeCore<NativeProjectFilePointerBody>("project_file_pointer_read", { request: { projectId, pointerId, expectedRevision } });
  },

  async listProjectFilePointerReceipts(projectId: string, pointerId: string): Promise<NativeProjectFilePointerReceipt[]> {
    requireDesktop("Project file receipts");
    return invokeCore<NativeProjectFilePointerReceipt[]>("project_file_pointer_receipts", { request: { projectId, pointerId } });
  },

  async pickWorkspaceFolder(projectId?: string): Promise<WorkspaceGrantRecord | null> {
    requireDesktop("Workspace folders");
    return invokeCore<WorkspaceGrantRecord | null>("workspace_grant_pick", {
      request: { projectId },
    });
  },

  async listWorkspaceGrants(projectId?: string): Promise<WorkspaceGrantRecord[]> {
    requireDesktop("Workspace folders");
    return invokeCore<WorkspaceGrantRecord[]>("workspace_grant_list", { projectId });
  },

  async revokeWorkspaceGrant(grantId: string): Promise<boolean> {
    requireDesktop("Workspace folders");
    return invokeCore<boolean>("workspace_grant_revoke", { grantId });
  },

  async listWorkspaceDirectory(
    grantId: string,
    relativePath?: string,
  ): Promise<WorkspaceDirectoryListing> {
    requireDesktop("Workspace file access");
    return invokeCore<WorkspaceDirectoryListing>("workspace_directory_list", {
      request: { grantId, relativePath },
    });
  },

  async readWorkspaceTextFile(grantId: string, relativePath: string): Promise<WorkspaceTextFile> {
    requireDesktop("Workspace file access");
    return invokeCore<WorkspaceTextFile>("workspace_text_file_read", {
      request: { grantId, relativePath },
    });
  },

  async buildWorkspaceIndex(
    grantId: string,
    projectId?: string,
    options?: WorkspaceIndexOptions,
  ): Promise<WorkspaceIndexSnapshot> {
    requireDesktop("Workspace indexing");
    return invokeCore<WorkspaceIndexSnapshot>("workspace_index_build", {
      request: {
        grantId,
        ...(projectId === undefined ? {} : { projectId }),
        ...(options === undefined ? {} : { options }),
      },
    });
  },

  async retrieveWorkspaceChunks(
    chunks: IndexedWorkspaceChunk[],
    query: string,
    options?: WorkspaceRetrievalOptions,
  ): Promise<WorkspaceRetrievalResult> {
    requireDesktop("Workspace retrieval");
    return invokeCore<WorkspaceRetrievalResult>("workspace_index_retrieve", {
      request: {
        chunks,
        query,
        ...(options === undefined ? {} : { options }),
      },
    });
  },

  async retrieveWorkspaceForRun(
    request: RetrieveWorkspaceForRunRequest,
  ): Promise<RunWorkspaceRetrievalResult> {
    requireDesktop("Run-scoped workspace retrieval");
    return invokeCore<RunWorkspaceRetrievalResult>("workspace_index_retrieve_for_run", { request });
  },

  async saveProviderProfile(request: SaveProviderProfileRequest): Promise<ProviderProfileReceipt> {
    requireDesktop("Provider connections");
    return invokeCore<ProviderProfileReceipt>("provider_profile_save", { request });
  },

  async listProviderProfiles(): Promise<ProviderProfileRecord[]> {
    requireDesktop("Provider connections");
    return invokeCore<ProviderProfileRecord[]>("provider_profile_list");
  },

  async deleteProviderProfile(profileId: string): Promise<boolean> {
    requireDesktop("Provider connections");
    return invokeCore<boolean>("provider_profile_delete", { profileId });
  },

  async preflightProviderConnection(
    request: ProviderConnectionProbeRequest,
  ): Promise<ProviderConnectionProbeResult> {
    const result = await previewProviderProbe(request);
    if (!isDesktopRuntime()) return result;
    return {
      ...result,
      latencyMs: null,
      models: [],
      warning:
        "Configuration preflight checked endpoint policy and request shape without contacting the provider. Live model discovery runs after the native profile is saved.",
    };
  },

  async testProviderConnection(profileId: string): Promise<ProviderConnectionHealth> {
    requireDesktop("Live provider connection tests");
    return invokeCore<ProviderConnectionHealth>("provider_connection_test", {
      request: { profileId },
    });
  },

  async listProviderModels(profileId: string): Promise<ProviderModelList> {
    requireDesktop("Live provider model discovery");
    return invokeCore<ProviderModelList>("provider_models_list", {
      request: { profileId },
    });
  },

  async startPreparedAttempt(request: StartPreparedAttemptRequest): Promise<void> {
    requireDesktop("Live provider runs");
    await invokeCore("start_prepared_attempt", { request });
  },

  /** Executes two to four already prepared provider inputs through native
   * adapters. The renderer supplies opaque attempt/input ids only. */
  async executeNativeComparePrepared(
    request: NativeCompareExecutePreparedRequest,
  ): Promise<NativeCompareExecutePreparedResult> {
    requireDesktop("Native model compare");
    return invokeCore<NativeCompareExecutePreparedResult>("native_compare_execute_prepared", {
      request,
    });
  },

  async readRunJournal(request: ReadRunJournalRequest): Promise<RunJournalReplayPage> {
    requireDesktop("Run journal replay");
    return invokeCore<RunJournalReplayPage>("run_journal_read", { request });
  },

  async readRunTelemetry(request: ReadRunTelemetryRequest): Promise<RunTelemetrySnapshot> {
    requireDesktop("Run telemetry");
    return invokeCore<RunTelemetrySnapshot>("run_telemetry_read", { request });
  },

  async readProviderAttemptLineage(
    request: ReadProviderAttemptLineageRequest,
  ): Promise<ProviderAttemptLineageReceipt> {
    requireDesktop("Provider attempt lineage");
    return invokeCore<ProviderAttemptLineageReceipt>("provider_attempt_lineage_read", { request });
  },

  async cancelRun(runId: string): Promise<boolean> {
    if (!isDesktopRuntime()) return false;
    return invokeCore<boolean>("cancel_run", { runId });
  },

  async onRunEvent(handler: (event: RunStreamEvent) => void): Promise<UnlistenFn> {
    if (!isDesktopRuntime()) return () => undefined;
    return listen<RunStreamEvent>("omnia://run-event", ({ payload }) => handler(payload));
  },
};

function requireDesktop(operation: string): void {
  if (!isDesktopRuntime()) {
    throw new Error(`${operation} requires the Tauri desktop runtime.`);
  }
}

async function previewProviderProbe(
  request: ProviderConnectionProbeRequest,
): Promise<ProviderConnectionProbeResult> {
  const providerType = request.providerType.trim().toLowerCase().replaceAll("-", "_");
  if (providerType === "azure_openai") {
    throw new Error(
      "Azure OpenAI is planned and unavailable in this preview: deployment-path and API-version routing are not implemented.",
    );
  }
  if (providerType === "custom_adapter") {
    throw new Error(
      "Custom adapters are planned and unavailable in this preview: declarative adapter manifests and custom-header policy are not implemented.",
    );
  }
  const startedAt = performance.now();
  const url = new URL(request.baseUrl.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider base URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Provider base URL must not contain credentials.");
  }
  const isLocal =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname.endsWith(".local");
  if (url.protocol === "http:" && !isLocal) {
    throw new Error("Public provider endpoints must use HTTPS.");
  }
  if (isLocal && !request.allowLocalNetwork) {
    throw new Error("Local and private network access requires an explicit grant.");
  }
  const authScheme = request.authScheme ?? "bearer";
  if (authScheme !== "none" && !request.secret && !request.credentialRef) {
    throw new Error("Enter a credential before testing this connection.");
  }

  await new Promise((resolve) => window.setTimeout(resolve, 420));
  const models = [...(browserPreviewModels[request.providerType] ?? browserPreviewModels[providerType] ?? [])];
  if (request.modelHint?.trim()) {
    const hintedId = request.modelHint.trim();
    models.unshift({ id: hintedId, displayName: hintedId, capabilities: ["text"] });
  }
  url.hash = "";
  return {
    healthy: true,
    normalizedBaseUrl: url.toString().replace(/\/$/, ""),
    latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    models,
    warning: "Preview validation checked endpoint policy and request shape without contacting the provider.",
  };
}
