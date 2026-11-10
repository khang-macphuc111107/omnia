import { assertDomain } from "./errors";
import { assertIsoTimestamp, assertNonBlank, type IsoTimestamp, type JsonValue } from "./shared";

/** The durable media-generation contract is intentionally narrower than the
 * renderer studio preview. Audio-only requests remain a provider/renderer
 * extension until the native schema is revised. */
export type MediaGenerationModality = "image" | "video" | "document";

export type MediaGenerationOperation =
  | "text-to-image"
  | "image-variation"
  | "inpaint"
  | "outpaint"
  | "background-remove"
  | "background-replace"
  | "upscale"
  | "object-cleanup"
  | "authorized-watermark-cleanup"
  | "text-to-video"
  | "image-to-video"
  | "video-extend"
  | "video-interpolate"
  | "storyboard"
  | "lip-sync"
  | "compose";

export type MediaGenerationJobStatus =
  | "draft"
  | "validating"
  | "uploading"
  | "queued"
  | "accepted"
  | "generating"
  | "post-processing"
  | "downloading"
  | "verified"
  | "completed"
  | "retry-wait"
  | "cancelled"
  | "failed"
  | "outcome-unknown"
  | "reconcile-required";

export type MediaGenerationProviderAcceptance = "not-sent" | "accepted" | "rejected" | "unknown";

export type MediaGenerationWatermarkAuthorization =
  | "not-applicable"
  | "user-owned"
  | "licensed"
  | "explicit-permission"
  | "denied"
  | "unknown";

export interface MediaGenerationParameters {
  readonly aspectRatio: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly fps?: number;
  readonly seed?: number | null;
  readonly variantCount?: number;
  readonly [key: string]: JsonValue | undefined;
}

export interface MediaGenerationAuthority {
  readonly policyRevisionId: string;
  readonly watermarkAuthorization: MediaGenerationWatermarkAuthorization;
}

export interface MediaGenerationJob {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly attemptId: string | null;
  readonly modality: MediaGenerationModality;
  readonly operation: MediaGenerationOperation;
  readonly status: MediaGenerationJobStatus;
  readonly providerProfileRevisionId: string;
  readonly modelProfileRevisionId: string;
  readonly capabilitySnapshotRevisionId: string;
  readonly promptRevisionId: string;
  readonly negativePromptRevisionId: string | null;
  readonly inputArtifactIds: readonly string[];
  readonly maskArtifactIds: readonly string[];
  readonly parameters: MediaGenerationParameters;
  readonly providerJobHandle: string | null;
  readonly providerAcceptance: MediaGenerationProviderAcceptance;
  readonly progress: number | null;
  readonly outputArtifactIds: readonly string[];
  readonly authority: MediaGenerationAuthority;
  readonly idempotencyKey: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp | null;
}

export interface CreateMediaGenerationJobInput {
  readonly jobId: string;
  readonly attemptId?: string | null;
  readonly modality: MediaGenerationModality;
  readonly operation: MediaGenerationOperation;
  readonly providerProfileRevisionId: string;
  readonly modelProfileRevisionId: string;
  readonly capabilitySnapshotRevisionId: string;
  readonly promptRevisionId: string;
  readonly negativePromptRevisionId?: string | null;
  readonly inputArtifactIds?: readonly string[];
  readonly maskArtifactIds?: readonly string[];
  readonly parameters: MediaGenerationParameters;
  readonly providerJobHandle?: string | null;
  readonly providerAcceptance?: MediaGenerationProviderAcceptance;
  readonly progress?: number | null;
  readonly outputArtifactIds?: readonly string[];
  readonly authority: MediaGenerationAuthority;
  readonly idempotencyKey: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt?: IsoTimestamp | null;
}

export interface MediaGenerationTransitionPatch {
  readonly attemptId?: string | null;
  readonly providerJobHandle?: string | null;
  readonly providerAcceptance?: MediaGenerationProviderAcceptance;
  readonly progress?: number | null;
  readonly outputArtifactIds?: readonly string[];
  readonly updatedAt: IsoTimestamp;
}

export const MEDIA_GENERATION_JOB_SCHEMA_VERSION = 1 as const;

const imageOperations = new Set<MediaGenerationOperation>([
  "text-to-image", "image-variation", "inpaint", "outpaint", "background-remove",
  "background-replace", "upscale", "object-cleanup", "authorized-watermark-cleanup",
]);
const videoOperations = new Set<MediaGenerationOperation>([
  "text-to-video", "image-to-video", "video-extend", "video-interpolate", "storyboard", "lip-sync",
]);
const transitions: Readonly<Record<MediaGenerationJobStatus, readonly MediaGenerationJobStatus[]>> = {
  draft: ["validating", "cancelled"],
  validating: ["uploading", "queued", "failed", "cancelled"],
  uploading: ["queued", "failed", "outcome-unknown", "cancelled"],
  queued: ["accepted", "generating", "failed", "outcome-unknown", "cancelled"],
  accepted: ["generating", "failed", "outcome-unknown", "cancelled"],
  generating: ["post-processing", "failed", "outcome-unknown", "cancelled"],
  "post-processing": ["downloading", "failed", "outcome-unknown"],
  downloading: ["verified", "failed", "outcome-unknown"],
  verified: ["completed", "failed"],
  completed: [],
  "retry-wait": ["validating", "cancelled"],
  cancelled: [],
  failed: ["retry-wait", "cancelled"],
  "outcome-unknown": ["reconcile-required"],
  "reconcile-required": [],
};

function uniqueIds(values: readonly string[] | undefined, label: string): readonly string[] {
  const ids = (values ?? []).map((value) => assertNonBlank(value, label));
  assertDomain(new Set(ids).size === ids.length, "invalid_argument", `${label} cannot contain duplicates.`, { label });
  return Object.freeze(ids);
}

function operationMatchesModality(modality: MediaGenerationModality, operation: MediaGenerationOperation): boolean {
  if (modality === "image") return imageOperations.has(operation) || operation === "compose";
  if (modality === "video") return videoOperations.has(operation) || operation === "compose";
  return operation === "compose";
}

function assertFinitePositive(value: number | undefined, label: string): void {
  if (value === undefined) return;
  assertDomain(Number.isFinite(value) && value > 0, "invalid_parameter", `${label} must be finite and greater than zero.`, { label, value });
}

function validateParameters(parameters: MediaGenerationParameters, modality: MediaGenerationModality): MediaGenerationParameters {
  const aspectRatio = assertNonBlank(parameters.aspectRatio, "aspectRatio");
  for (const [label, value] of [["width", parameters.width], ["height", parameters.height], ["variantCount", parameters.variantCount]] as const) {
    if (value !== undefined) assertDomain(Number.isInteger(value) && value > 0, "invalid_parameter", `${label} must be a positive integer.`, { label, value });
  }
  assertFinitePositive(parameters.durationSeconds, "durationSeconds");
  assertFinitePositive(parameters.fps, "fps");
  if (parameters.seed !== undefined && parameters.seed !== null) {
    assertDomain(Number.isInteger(parameters.seed), "invalid_parameter", "seed must be an integer or null.", { value: parameters.seed });
  }
  if (modality === "video") {
    assertFinitePositive(parameters.durationSeconds, "durationSeconds");
    assertFinitePositive(parameters.fps, "fps");
  }
  return Object.freeze({ ...parameters, aspectRatio });
}

function validateProgress(progress: number | null | undefined): number | null {
  if (progress === undefined || progress === null) return null;
  assertDomain(Number.isFinite(progress) && progress >= 0 && progress <= 1, "invalid_parameter", "progress must be between 0 and 1.", { progress });
  return progress;
}

function validateAuthority(authority: MediaGenerationAuthority): MediaGenerationAuthority {
  const policyRevisionId = assertNonBlank(authority.policyRevisionId, "policyRevisionId");
  const watermarkAuthorization = authority.watermarkAuthorization;
  assertDomain(
    ["not-applicable", "user-owned", "licensed", "explicit-permission", "denied", "unknown"].includes(watermarkAuthorization),
    "invalid_argument",
    "watermarkAuthorization is not recognized.",
  );
  return Object.freeze({ policyRevisionId, watermarkAuthorization });
}

function assertCrossFieldInvariants(job: Omit<MediaGenerationJob, "schemaVersion">): void {
  assertDomain(operationMatchesModality(job.modality, job.operation), "invalid_argument", `${job.operation} is not compatible with ${job.modality}.`);
  if (job.operation === "authorized-watermark-cleanup") {
    assertDomain(["user-owned", "licensed", "explicit-permission"].includes(job.authority.watermarkAuthorization), "permission_denied", "Watermark cleanup requires explicit ownership or permission.");
  }
  if (job.providerAcceptance === "accepted") assertDomain(job.providerJobHandle !== null, "invalid_state_transition", "Accepted provider work must include a provider job handle.");
  if (job.providerAcceptance === "not-sent") assertDomain(job.providerJobHandle === null, "invalid_state_transition", "An unsent job cannot include a provider job handle.");
  if (job.status === "completed") {
    assertDomain(job.progress === 1, "invalid_state_transition", "A completed media job must have progress 1.");
    assertDomain(job.outputArtifactIds.length > 0, "invalid_state_transition", "A completed media job must include an output artifact.");
  }
  if (["outcome-unknown", "reconcile-required"].includes(job.status)) {
    assertDomain(job.providerAcceptance === "unknown", "invalid_state_transition", "An unknown outcome must retain unknown provider acceptance.");
  }
}

export function createMediaGenerationJob(input: CreateMediaGenerationJobInput): MediaGenerationJob {
  const job: Omit<MediaGenerationJob, "schemaVersion"> = {
    jobId: assertNonBlank(input.jobId, "jobId"),
    attemptId: input.attemptId === undefined || input.attemptId === null ? null : assertNonBlank(input.attemptId, "attemptId"),
    modality: input.modality,
    operation: input.operation,
    status: "draft",
    providerProfileRevisionId: assertNonBlank(input.providerProfileRevisionId, "providerProfileRevisionId"),
    modelProfileRevisionId: assertNonBlank(input.modelProfileRevisionId, "modelProfileRevisionId"),
    capabilitySnapshotRevisionId: assertNonBlank(input.capabilitySnapshotRevisionId, "capabilitySnapshotRevisionId"),
    promptRevisionId: assertNonBlank(input.promptRevisionId, "promptRevisionId"),
    negativePromptRevisionId: input.negativePromptRevisionId === undefined || input.negativePromptRevisionId === null ? null : assertNonBlank(input.negativePromptRevisionId, "negativePromptRevisionId"),
    inputArtifactIds: uniqueIds(input.inputArtifactIds, "inputArtifactId"),
    maskArtifactIds: uniqueIds(input.maskArtifactIds, "maskArtifactId"),
    parameters: validateParameters(input.parameters, input.modality),
    providerJobHandle: input.providerJobHandle === undefined || input.providerJobHandle === null ? null : assertNonBlank(input.providerJobHandle, "providerJobHandle"),
    providerAcceptance: input.providerAcceptance ?? "not-sent",
    progress: validateProgress(input.progress),
    outputArtifactIds: uniqueIds(input.outputArtifactIds, "outputArtifactId"),
    authority: validateAuthority(input.authority),
    idempotencyKey: assertNonBlank(input.idempotencyKey, "idempotencyKey"),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt === undefined || input.updatedAt === null ? null : input.updatedAt,
  };
  assertIsoTimestamp(job.createdAt, "createdAt");
  if (job.updatedAt !== null) assertIsoTimestamp(job.updatedAt, "updatedAt");
  assertCrossFieldInvariants(job);
  return Object.freeze({ schemaVersion: MEDIA_GENERATION_JOB_SCHEMA_VERSION, ...job });
}

export function allowedMediaGenerationTransitions(status: MediaGenerationJobStatus): readonly MediaGenerationJobStatus[] {
  return transitions[status];
}

export function canTransitionMediaGenerationJob(from: MediaGenerationJobStatus, to: MediaGenerationJobStatus): boolean {
  return transitions[from].includes(to);
}

export function transitionMediaGenerationJob(
  job: MediaGenerationJob,
  nextStatus: MediaGenerationJobStatus,
  patch: MediaGenerationTransitionPatch,
): MediaGenerationJob {
  assertDomain(canTransitionMediaGenerationJob(job.status, nextStatus), "invalid_state_transition", `${job.status} cannot transition to ${nextStatus}.`, { from: job.status, to: nextStatus });
  assertIsoTimestamp(patch.updatedAt, "updatedAt");
  const next = {
    ...job,
    status: nextStatus,
    attemptId: patch.attemptId === undefined ? job.attemptId : patch.attemptId,
    providerJobHandle: patch.providerJobHandle === undefined ? job.providerJobHandle : patch.providerJobHandle,
    providerAcceptance: patch.providerAcceptance === undefined ? job.providerAcceptance : patch.providerAcceptance,
    progress: patch.progress === undefined ? (nextStatus === "completed" ? 1 : nextStatus === "failed" || nextStatus === "cancelled" ? null : job.progress) : patch.progress,
    outputArtifactIds: patch.outputArtifactIds === undefined ? job.outputArtifactIds : uniqueIds(patch.outputArtifactIds, "outputArtifactId"),
    updatedAt: patch.updatedAt,
  } satisfies Omit<MediaGenerationJob, "schemaVersion">;
  if (nextStatus === "outcome-unknown") next.providerAcceptance = "unknown";
  if (nextStatus === "reconcile-required") next.providerAcceptance = "unknown";
  if (nextStatus === "cancelled" || nextStatus === "failed") next.progress = null;
  if (nextStatus === "completed") next.progress = 1;
  assertCrossFieldInvariants(next);
  // Parameters and authority are immutable values carried forward from the
  // validated job. The transition only replaces lifecycle fields and the
  // artifact/handle projections, so a shallow freeze preserves the same
  // durable boundary without widening those domain types to generic JSON.
  return Object.freeze({ ...next }) as MediaGenerationJob;
}

export function isTerminalMediaGenerationJobStatus(status: MediaGenerationJobStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "reconcile-required";
}

export function serializeMediaGenerationJob(job: MediaGenerationJob): string {
  return JSON.stringify(job, null, 2);
}
