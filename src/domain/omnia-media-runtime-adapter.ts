import { assertDomain, isDomainError } from "./errors";
import {
  createMediaGenerationJob,
  transitionMediaGenerationJob,
  type CreateMediaGenerationJobInput,
  type MediaGenerationJob,
  type MediaGenerationJobStatus,
  type MediaGenerationModality,
  type MediaGenerationProviderAcceptance,
  type MediaGenerationTransitionPatch,
} from "./media-generation-job";
import {
  createOmniaRuntimeController,
  type OmniaRuntimeController,
  type OmniaRuntimeOptions,
} from "../runtime/omnia-runtime-controller";
import type { MediaKind, MediaQueueItem, MediaQueueStatus } from "./omnia-media-queue";
import { assertIsoTimestamp, assertNonBlank, type IsoTimestamp } from "./shared";

/** Version of the renderer/native-safe media runtime tracking projection. */
export const MEDIA_RUNTIME_ADAPTER_SCHEMA_VERSION = 1 as const;

export type MediaRuntimeErrorCode =
  | "media_runtime_unavailable"
  | "unsupported_modality"
  | "not_found"
  | "conflict"
  | "invalid_state"
  | "native_rejected"
  | "native_error";

export type MediaRuntimeFailure = {
  readonly ok: false;
  readonly code: MediaRuntimeErrorCode;
  readonly reason: string;
};

export type MediaRuntimeResult<T> =
  | { readonly ok: true; readonly value: T }
  | MediaRuntimeFailure;

/** Capability evidence intentionally stays small and renderer-safe. */
export type MediaRuntimeAvailability =
  | { readonly status: "available"; readonly capabilitySnapshotId: string }
  | { readonly status: "unavailable"; readonly reason: string };

export type MediaRuntimeDispatchReceipt = {
  readonly providerJobHandle: string;
  readonly attemptId?: string | null;
  readonly acceptedAt?: IsoTimestamp;
};

export type MediaRuntimeActionReceipt = {
  readonly acknowledgedAt?: IsoTimestamp;
};

/**
 * A native reconciler may return a new lifecycle status and the observable
 * provider fields. It must not return raw provider payloads or credentials.
 */
export type MediaRuntimeReconcileReceipt = {
  readonly status: MediaGenerationJobStatus;
  readonly providerAcceptance: MediaGenerationProviderAcceptance;
  readonly providerJobHandle?: string | null;
  readonly attemptId?: string | null;
  readonly progress?: number | null;
  readonly outputArtifactIds?: readonly string[];
};

/**
 * Optional native port. The browser preview intentionally supplies no port,
 * so dispatch, cancellation, reconciliation, and capability inspection return
 * typed `media_runtime_unavailable` results instead of pretending to execute.
 */
export interface MediaRuntimePort {
  readonly inspectCapabilities?: () => Promise<MediaRuntimeAvailability>;
  readonly dispatch?: (job: MediaGenerationJob) => Promise<MediaRuntimeResult<MediaRuntimeDispatchReceipt>>;
  readonly cancel?: (job: MediaGenerationJob) => Promise<MediaRuntimeResult<MediaRuntimeActionReceipt>>;
  readonly reconcile?: (job: MediaGenerationJob) => Promise<MediaRuntimeResult<MediaRuntimeReconcileReceipt>>;
}

export type CreateMediaRuntimeJobInput = Omit<CreateMediaGenerationJobInput, "jobId" | "createdAt"> & {
  readonly prompt: string;
  readonly jobId?: string;
  readonly createdAt?: IsoTimestamp;
};

export type MediaRuntimeTransitionOptions = Omit<MediaGenerationTransitionPatch, "updatedAt"> & {
  readonly updatedAt?: IsoTimestamp;
  /** Queue-only diagnostic. It is never copied into the durable job. */
  readonly error?: string;
};

export type MediaRuntimeJobRecord = {
  readonly job: MediaGenerationJob;
  readonly queueItemId: string;
};

export type MediaRuntimeSerializedState = {
  readonly schemaVersion: typeof MEDIA_RUNTIME_ADAPTER_SCHEMA_VERSION;
  readonly records: readonly MediaRuntimeJobRecord[];
};

export type OmniaMediaRuntimeAdapterOptions = {
  readonly controller?: OmniaRuntimeController;
  readonly controllerOptions?: OmniaRuntimeOptions;
  readonly port?: MediaRuntimePort;
  readonly now?: () => IsoTimestamp;
  readonly records?: readonly MediaRuntimeJobRecord[];
};

function unavailable(reason: string): MediaRuntimeFailure {
  return { ok: false, code: "media_runtime_unavailable", reason };
}

function notFound(jobId: string): MediaRuntimeFailure {
  return { ok: false, code: "not_found", reason: `Unknown media generation job: ${jobId}.` };
}

function mediaKind(modality: MediaGenerationModality): MediaKind {
  switch (modality) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "document":
      return "document";
  }
}

function queueStatus(status: MediaGenerationJobStatus): MediaQueueStatus {
  switch (status) {
    case "draft":
    case "validating":
    case "uploading":
    case "queued":
      return "queued";
    case "accepted":
    case "generating":
    case "post-processing":
    case "downloading":
    case "verified":
      return "running";
    case "completed":
      return "completed";
    case "retry-wait":
    case "outcome-unknown":
    case "reconcile-required":
      return "paused";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function cloneRecord(record: MediaRuntimeJobRecord): MediaRuntimeJobRecord {
  return Object.freeze({ job: record.job, queueItemId: record.queueItemId });
}

function domainFailure(error: unknown): MediaRuntimeFailure {
  if (isDomainError(error)) {
    const code: MediaRuntimeErrorCode = error.code === "not_found"
      ? "not_found"
      : error.code === "conflict"
        ? "conflict"
        : error.code === "invalid_state_transition"
          ? "invalid_state"
          : "native_error";
    return { ok: false, code, reason: error.message };
  }
  return {
    ok: false,
    code: "native_error",
    reason: error instanceof Error && error.message.trim().length > 0 ? error.message : "Media runtime operation failed.",
  };
}

function assertRecordShape(value: unknown, label: string): asserts value is MediaRuntimeJobRecord {
  assertDomain(typeof value === "object" && value !== null, "invalid_argument", `${label} must be an object.`);
  const candidate = value as { job?: unknown; queueItemId?: unknown };
  assertDomain(typeof candidate.queueItemId === "string" && candidate.queueItemId.trim().length > 0, "invalid_argument", `${label}.queueItemId is required.`);
  assertDomain(typeof candidate.job === "object" && candidate.job !== null, "invalid_argument", `${label}.job is required.`);
  const job = candidate.job as Partial<MediaGenerationJob>;
  assertDomain(job.schemaVersion === 1, "invalid_argument", `${label}.job has an unsupported schema version.`);
  assertDomain(typeof job.jobId === "string" && job.jobId.trim().length > 0, "invalid_argument", `${label}.job.jobId is required.`);
  assertDomain(typeof job.status === "string", "invalid_argument", `${label}.job.status is required.`);
}

function parseSerializedState(input: string | unknown): MediaRuntimeSerializedState {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  assertDomain(typeof value === "object" && value !== null, "invalid_argument", "Invalid media runtime state.");
  const candidate = value as { schemaVersion?: unknown; records?: unknown };
  assertDomain(candidate.schemaVersion === MEDIA_RUNTIME_ADAPTER_SCHEMA_VERSION, "invalid_argument", "Unsupported media runtime state schema.");
  assertDomain(Array.isArray(candidate.records), "invalid_argument", "Media runtime state records must be an array.");
  const records = candidate.records.map((record, index) => {
    assertRecordShape(record, `records[${index}]`);
    return cloneRecord(record);
  });
  const jobIds = new Set<string>();
  const queueIds = new Set<string>();
  for (const record of records) {
    assertDomain(!jobIds.has(record.job.jobId), "conflict", `Duplicate media job ID: ${record.job.jobId}.`);
    assertDomain(!queueIds.has(record.queueItemId), "conflict", `Duplicate media queue ID: ${record.queueItemId}.`);
    jobIds.add(record.job.jobId);
    queueIds.add(record.queueItemId);
  }
  return Object.freeze({ schemaVersion: MEDIA_RUNTIME_ADAPTER_SCHEMA_VERSION, records: Object.freeze(records) });
}

/**
 * Connects the validated durable media-job contract to the shared app-state
 * controller. The adapter owns only job-to-queue bookkeeping; app revisions,
 * event log entries, undo, and redo remain controller responsibilities.
 */
export class OmniaMediaRuntimeAdapter {
  private readonly controller: OmniaRuntimeController;
  private readonly port: MediaRuntimePort;
  private readonly now: () => IsoTimestamp;
  private readonly records = new Map<string, MediaRuntimeJobRecord>();
  private idCounter = 0;

  public constructor(options: OmniaMediaRuntimeAdapterOptions = {}) {
    this.controller = options.controller ?? createOmniaRuntimeController(options.controllerOptions);
    this.port = options.port ?? {};
    this.now = options.now ?? (() => new Date().toISOString());
    for (const record of options.records ?? []) {
      assertRecordShape(record, "media runtime record");
      assertDomain(!this.records.has(record.job.jobId), "conflict", `Duplicate media job ID: ${record.job.jobId}.`);
      this.records.set(record.job.jobId, cloneRecord(record));
    }
  }

  public getController(): OmniaRuntimeController {
    return this.controller;
  }

  public inspect(jobId: string): MediaRuntimeJobRecord | undefined {
    const record = this.records.get(jobId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  public list(): readonly MediaRuntimeJobRecord[] {
    return Object.freeze([...this.records.values()].map(cloneRecord));
  }

  public async inspectCapabilities(): Promise<MediaRuntimeAvailability> {
    if (this.port.inspectCapabilities === undefined) {
      return { status: "unavailable", reason: "Media capability inspection is not connected to a native runtime." };
    }
    try {
      return await this.port.inspectCapabilities();
    } catch (error) {
      return { status: "unavailable", reason: error instanceof Error ? error.message : "Media capability inspection failed." };
    }
  }

  public create(input: CreateMediaRuntimeJobInput): MediaRuntimeJobRecord {
    const prompt = assertNonBlank(input.prompt, "prompt");
    const createdAt = input.createdAt ?? this.now();
    assertIsoTimestamp(createdAt, "createdAt");
    const jobId = input.jobId === undefined ? this.nextId("media-job") : assertNonBlank(input.jobId, "jobId");
    assertDomain(!this.records.has(jobId), "conflict", `Media generation job already exists: ${jobId}.`, { jobId });
    const { prompt: _prompt, jobId: _jobId, createdAt: _createdAt, ...jobInput } = input;
    const draft = createMediaGenerationJob({ ...jobInput, jobId, createdAt });
    const validating = transitionMediaGenerationJob(draft, "validating", { updatedAt: createdAt });
    const queued = transitionMediaGenerationJob(validating, "queued", { updatedAt: createdAt });

    const beforeIds = new Set(this.controller.getSnapshot().media.items.map((item) => item.id));
    this.controller.enqueueMedia(mediaKind(queued.modality), prompt);
    const queueItem = this.findNewQueueItem(beforeIds, prompt);
    const record = cloneRecord({ job: queued, queueItemId: queueItem.id });
    this.records.set(jobId, record);
    return record;
  }

  public transition(
    jobId: string,
    nextStatus: MediaGenerationJobStatus,
    options: MediaRuntimeTransitionOptions = {},
  ): MediaRuntimeResult<MediaRuntimeJobRecord> {
    const current = this.records.get(jobId);
    if (current === undefined) return notFound(jobId);
    try {
      const { error: queueError, updatedAt, ...patch } = options;
      const next = transitionMediaGenerationJob(current.job, nextStatus, {
        ...patch,
        updatedAt: updatedAt ?? this.now(),
      });
      const nextRecord = cloneRecord({ job: next, queueItemId: current.queueItemId });
      this.projectQueue(nextRecord, queueError);
      this.records.set(jobId, nextRecord);
      return { ok: true, value: nextRecord };
    } catch (error) {
      return domainFailure(error);
    }
  }

  /** A local cancellation is useful for browser preview and does not claim native cancellation. */
  public cancelLocal(jobId: string): MediaRuntimeResult<MediaRuntimeJobRecord> {
    return this.transition(jobId, "cancelled");
  }

  /** A retry resets the shared queue while keeping native acceptance unclaimed. */
  public retryLocal(jobId: string): MediaRuntimeResult<MediaRuntimeJobRecord> {
    const current = this.records.get(jobId);
    if (current === undefined) return notFound(jobId);
    const retried = this.transition(jobId, "retry-wait");
    if (!retried.ok) return retried;
    this.controller.retryMedia(current.queueItemId);
    return retried;
  }

  public delete(jobId: string): MediaRuntimeResult<null> {
    const current = this.records.get(jobId);
    if (current === undefined) return notFound(jobId);
    this.controller.deleteMedia(current.queueItemId);
    this.records.delete(jobId);
    return { ok: true, value: null };
  }

  public async dispatch(jobId: string): Promise<MediaRuntimeResult<MediaRuntimeJobRecord>> {
    const current = this.records.get(jobId);
    if (current === undefined) return notFound(jobId);
    if (this.port.dispatch === undefined) {
      return unavailable("Media provider dispatch is not connected to a native runtime.");
    }
    try {
      const receipt = await this.port.dispatch(current.job);
      if (!receipt.ok) return receipt;
      const providerJobHandle = assertNonBlank(receipt.value.providerJobHandle, "providerJobHandle");
      const transitioned = this.transition(jobId, "accepted", {
        providerAcceptance: "accepted",
        providerJobHandle,
        ...(receipt.value.attemptId === undefined ? {} : { attemptId: receipt.value.attemptId }),
        ...(receipt.value.acceptedAt === undefined ? {} : { updatedAt: receipt.value.acceptedAt }),
      });
      return transitioned;
    } catch (error) {
      return domainFailure(error);
    }
  }

  public async cancel(jobId: string): Promise<MediaRuntimeResult<MediaRuntimeJobRecord>> {
    const current = this.records.get(jobId);
    if (current === undefined) return notFound(jobId);
    if (this.port.cancel === undefined) {
      return unavailable("Media provider cancellation is not connected to a native runtime.");
    }
    try {
      const receipt = await this.port.cancel(current.job);
      if (!receipt.ok) return receipt;
      return this.transition(jobId, "cancelled", {
        ...(receipt.value.acknowledgedAt === undefined ? {} : { updatedAt: receipt.value.acknowledgedAt }),
      });
    } catch (error) {
      return domainFailure(error);
    }
  }

  public async reconcile(jobId: string): Promise<MediaRuntimeResult<MediaRuntimeJobRecord>> {
    const current = this.records.get(jobId);
    if (current === undefined) return notFound(jobId);
    if (this.port.reconcile === undefined) {
      return unavailable("Media provider reconciliation is not connected to a native runtime.");
    }
    try {
      const receipt = await this.port.reconcile(current.job);
      if (!receipt.ok) return receipt;
      if (receipt.value.status === current.job.status) {
        return {
          ok: false,
          code: "invalid_state",
          reason: "A reconcile response must advance the durable media lifecycle before fields are applied.",
        };
      }
      return this.transition(jobId, receipt.value.status, {
        providerAcceptance: receipt.value.providerAcceptance,
        ...(receipt.value.providerJobHandle === undefined ? {} : { providerJobHandle: receipt.value.providerJobHandle }),
        ...(receipt.value.attemptId === undefined ? {} : { attemptId: receipt.value.attemptId }),
        ...(receipt.value.progress === undefined ? {} : { progress: receipt.value.progress }),
        ...(receipt.value.outputArtifactIds === undefined ? {} : { outputArtifactIds: receipt.value.outputArtifactIds }),
      });
    } catch (error) {
      return domainFailure(error);
    }
  }

  public serialize(): string {
    return JSON.stringify({
      schemaVersion: MEDIA_RUNTIME_ADAPTER_SCHEMA_VERSION,
      records: [...this.records.values()],
    } satisfies MediaRuntimeSerializedState, null, 2);
  }

  public import(input: string | unknown): MediaRuntimeResult<number> {
    try {
      const state = parseSerializedState(input);
      this.records.clear();
      for (const record of state.records) this.records.set(record.job.jobId, cloneRecord(record));
      return { ok: true, value: state.records.length };
    } catch (error) {
      return domainFailure(error);
    }
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}:${Date.now().toString(36)}:${this.idCounter.toString(36)}`;
  }

  private findNewQueueItem(beforeIds: ReadonlySet<string>, prompt: string): MediaQueueItem {
    const item = this.controller.getSnapshot().media.items.find((candidate) => !beforeIds.has(candidate.id));
    assertDomain(item !== undefined, "conflict", "Media queue did not return the newly enqueued item.");
    assertDomain(item.prompt === prompt, "conflict", "Media queue returned an unexpected prompt for the new job.");
    return item;
  }

  private projectQueue(record: MediaRuntimeJobRecord, error?: string): void {
    const queueItem = this.controller.getSnapshot().media.items.find((item) => item.id === record.queueItemId);
    assertDomain(queueItem !== undefined, "not_found", `Media queue item is missing: ${record.queueItemId}.`);
    if (record.job.progress !== null) this.controller.updateMediaProgress(record.queueItemId, record.job.progress);
    this.controller.transitionMedia(record.queueItemId, queueStatus(record.job.status), error);
  }
}

export function createOmniaMediaRuntimeAdapter(options: OmniaMediaRuntimeAdapterOptions = {}): OmniaMediaRuntimeAdapter {
  return new OmniaMediaRuntimeAdapter(options);
}

export function deserializeMediaRuntimeState(input: string | unknown): MediaRuntimeSerializedState {
  return parseSerializedState(input);
}
