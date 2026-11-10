import {
  desktop,
  type ContinuationIntent,
  type CreateRunCheckpointRequest,
  type MessageRevision,
  type ResolveContinuationIntentRequest,
  type ResolveMessageRevisionRequest,
  type ResolvedRunControlOperation,
  type RunCheckpointRecord,
  type RunControlApplyRequest,
  type RunControlApplyResult,
  type RunControlOperationIntent,
} from "@/lib/desktop";

import { useWorkspaceStore } from "./store";
import {
  projectResolvedRunControlOperation,
  projectRunCheckpoint,
  projectRunControlApply,
  type RunCheckpointProjection,
  type RunControlOperationProjection,
} from "./run-control-projection";

/**
 * The sync adapter deliberately depends on the smallest native/store surface
 * it needs. Tests and future native-session implementations can inject these
 * dependencies without mocking the entire desktop API or Zustand store.
 */
export interface RunControlNativeClient {
  resolveRunControl(request: RunControlOperationIntent): Promise<ResolvedRunControlOperation>;
  applyRunControl(request: RunControlApplyRequest): Promise<RunControlApplyResult>;
  createRunCheckpoint(request: CreateRunCheckpointRequest): Promise<RunCheckpointRecord>;
  readRunCheckpoint(request: { runId: string; checkpointId?: string }): Promise<RunCheckpointRecord | null>;
  resolveContinuationIntent(request: ResolveContinuationIntentRequest): Promise<ContinuationIntent>;
  resolveMessageRevision(request: ResolveMessageRevisionRequest): Promise<MessageRevision>;
}

export interface RunControlProjectionStore {
  upsertRunControlOperation(projection: RunControlOperationProjection): void;
  upsertRunCheckpoint(record: RunCheckpointRecord): void;
  upsertContinuationIntent(intent: ContinuationIntent): void;
  upsertMessageRevision(revision: MessageRevision): void;
}

export interface RunControlSyncDependencies {
  native?: RunControlNativeClient;
  store?: RunControlProjectionStore;
}

export interface RunControlOperationSyncOptions extends RunControlSyncDependencies {
  /**
   * Must only be true after native state-base preparation/resolution. The
   * renderer cannot establish this fact from a locally assembled digest,
   * cursor, or branch-head read. Keeping this gate explicit prevents callers
   * from accidentally enabling durable controls against the legacy request
   * contract.
  */
  canonicalStateBasePrepared: boolean;
}

const defaultNative: RunControlNativeClient = desktop;

function dependencies(options: RunControlSyncDependencies): {
  native: RunControlNativeClient;
  store: RunControlProjectionStore;
} {
  return {
    native: options.native ?? defaultNative,
    store: options.store ?? useWorkspaceStore.getState(),
  };
}

function operationDependencies(options: RunControlOperationSyncOptions): {
  native: RunControlNativeClient;
  store: RunControlProjectionStore;
} {
  if (!options.canonicalStateBasePrepared) {
    throw new Error(
      "Native canonical state-base preparation is required before durable run-control sync.",
    );
  }
  return dependencies(options);
}

/** Resolves a native operation and projects only the returned receipt. */
export async function resolveRunControlIntoStore(
  request: RunControlOperationIntent,
  options: RunControlOperationSyncOptions,
): Promise<RunControlOperationProjection> {
  const { native, store } = operationDependencies(options);
  const operation = await native.resolveRunControl(request);
  const projection = projectResolvedRunControlOperation(operation);
  store.upsertRunControlOperation(projection);
  return projection;
}

/**
 * Applies a native receipt and projects the result. No optimistic state is
 * written before this call resolves, and rejected IPC calls leave the store
 * untouched.
 */
export async function applyRunControlIntoStore(
  request: RunControlApplyRequest,
  options: RunControlOperationSyncOptions,
): Promise<RunControlOperationProjection> {
  const { native, store } = operationDependencies(options);
  const result = await native.applyRunControl(request);
  const projection = projectRunControlApply(result);
  store.upsertRunControlOperation(projection);
  return projection;
}

/**
 * Resolves then applies one operation using the immutable identity returned
 * by native resolution. Expectations may add CAS guards but may not replace
 * the operation address or idempotency key returned by native.
 */
export async function resolveAndApplyRunControlIntoStore(
  request: RunControlOperationIntent,
  expectations: Omit<RunControlApplyRequest, "operationId" | "idempotencyKey"> = {},
  options: RunControlOperationSyncOptions,
): Promise<{
  resolved: RunControlOperationProjection;
  applied: RunControlOperationProjection;
}> {
  const { native, store } = operationDependencies(options);
  const operation = await native.resolveRunControl(request);
  const resolved = projectResolvedRunControlOperation(operation);
  store.upsertRunControlOperation(resolved);

  const result = await native.applyRunControl({
    ...expectations,
    operationId: operation.operationId,
    idempotencyKey: operation.idempotencyKey,
  });
  const applied = projectRunControlApply(result);
  store.upsertRunControlOperation(applied);
  return { resolved, applied };
}

/** Creates and projects an immutable native checkpoint. */
export async function createRunCheckpointIntoStore(
  request: CreateRunCheckpointRequest,
  options: RunControlSyncDependencies,
): Promise<RunCheckpointProjection> {
  const { native, store } = dependencies(options);
  const record = await native.createRunCheckpoint(request);
  const projection = projectRunCheckpoint(record);
  store.upsertRunCheckpoint(record);
  return projection;
}

/** Reads and projects an immutable checkpoint, if native storage has one. */
export async function readRunCheckpointIntoStore(
  request: { runId: string; checkpointId?: string },
  options: RunControlSyncDependencies,
): Promise<RunCheckpointProjection | null> {
  const { native, store } = dependencies(options);
  const record = await native.readRunCheckpoint(request);
  if (!record) return null;
  const projection = projectRunCheckpoint(record);
  store.upsertRunCheckpoint(record);
  return projection;
}

/** Resolves and projects a loop-guarded continuation intent. */
export async function resolveContinuationIntentIntoStore(
  request: ResolveContinuationIntentRequest,
  options: RunControlSyncDependencies,
): Promise<ContinuationIntent> {
  const { native, store } = dependencies(options);
  const intent = await native.resolveContinuationIntent(request);
  store.upsertContinuationIntent(intent);
  return intent;
}

/** Resolves and projects an immutable message/prompt revision. */
export async function resolveMessageRevisionIntoStore(
  request: ResolveMessageRevisionRequest,
  options: RunControlSyncDependencies,
): Promise<MessageRevision> {
  const { native, store } = dependencies(options);
  const revision = await native.resolveMessageRevision(request);
  store.upsertMessageRevision(revision);
  return revision;
}
