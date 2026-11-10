/**
 * Renderer-local orchestration contract for the Media Generation Studio.
 *
 * This module mirrors the normative media-job lifecycle closely enough for UI
 * rehearsal, while deliberately refusing to mint provider acceptance, native
 * job handles, artifact writes, or durable recovery receipts. The native
 * harness remains the authority for all of those facts.
 */

export const MEDIA_GENERATION_ORCHESTRATION_SCHEMA = "omnia.media-generation-orchestration.preview.v1" as const;

// `audio` is intentionally a renderer-only studio extension for the current
// UI. The normative durable job schema currently covers image/video/document;
// native audio jobs must not be inferred from this preview type.
export type MediaGenerationModality = "image" | "video" | "audio";

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
  | "compose"
  // Renderer-only extension until the durable media schema covers audio.
  | "audio-compose";

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

export type MediaGenerationParameters = {
  readonly aspectRatio: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly fps?: number;
  readonly seed?: number | null;
  readonly variantCount?: number;
  readonly quality?: string;
  readonly [key: string]: unknown;
};

export type MediaGenerationDraft = {
  readonly modality: MediaGenerationModality;
  readonly operation: MediaGenerationOperation;
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly parameters: MediaGenerationParameters;
  readonly inputArtifactIds?: readonly string[];
  readonly maskArtifactIds?: readonly string[];
  readonly providerProfileRevisionId?: string | null;
  readonly modelProfileRevisionId?: string | null;
  readonly capabilitySnapshotRevisionId?: string | null;
  readonly authority?: {
    readonly policyRevisionId?: string | null;
    readonly watermarkAuthorization?: MediaGenerationWatermarkAuthorization;
  };
};

export type MediaGenerationPreviewJob = {
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
  readonly authority: {
    readonly policyRevisionId: string;
    readonly watermarkAuthorization: MediaGenerationWatermarkAuthorization;
  };
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly scope: "renderer-session";
  readonly executionDisposition: "preview-only";
};

export type MediaGenerationValidation = {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
};

export type MediaGenerationTransitionResult =
  | { readonly ok: true; readonly job: MediaGenerationPreviewJob }
  | { readonly ok: false; readonly job: MediaGenerationPreviewJob; readonly reason: string };

export type MediaGenerationActionAvailability = {
  readonly inspect: { readonly available: true; readonly reason: null };
  readonly dispatch: { readonly available: false; readonly reason: string };
  readonly cancel: { readonly available: boolean; readonly reason: string | null };
  readonly retry: { readonly available: boolean; readonly reason: string };
  readonly reconcile: { readonly available: false; readonly reason: string };
};

const imageOperations = new Set<MediaGenerationOperation>([
  "text-to-image",
  "image-variation",
  "inpaint",
  "outpaint",
  "background-remove",
  "background-replace",
  "upscale",
  "object-cleanup",
  "authorized-watermark-cleanup",
]);

const videoOperations = new Set<MediaGenerationOperation>([
  "text-to-video",
  "image-to-video",
  "video-extend",
  "video-interpolate",
  "storyboard",
  "lip-sync",
]);

const transitions: Readonly<Record<MediaGenerationJobStatus, readonly MediaGenerationJobStatus[]>> = {
  draft: ["validating", "cancelled"],
  validating: ["uploading", "queued", "failed", "cancelled"],
  uploading: ["queued", "failed", "outcome-unknown", "cancelled"],
  queued: ["accepted", "failed", "outcome-unknown", "cancelled"],
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

export const MEDIA_GENERATION_LIFECYCLE: readonly MediaGenerationJobStatus[] = [
  "draft",
  "validating",
  "uploading",
  "queued",
  "accepted",
  "generating",
  "post-processing",
  "downloading",
  "verified",
  "completed",
];

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(values: readonly string[] | undefined): readonly string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function isPositiveFiniteNumber(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function operationMatchesModality(
  modality: MediaGenerationModality,
  operation: MediaGenerationOperation,
): boolean {
  if (modality === "image") return imageOperations.has(operation) || operation === "compose";
  if (modality === "video") return videoOperations.has(operation) || operation === "compose";
  return operation === "audio-compose" || operation === "compose";
}

/**
 * Validates only request shape and explicit authorization fields. It does not
 * probe an endpoint, read a file, or infer that a capability exists.
 */
export function validateMediaGenerationDraft(draft: MediaGenerationDraft): MediaGenerationValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prompt = draft.prompt.trim();
  const parameters = draft.parameters;

  if (!prompt) errors.push("A prompt is required before a media request can enter validation.");
  if (!operationMatchesModality(draft.modality, draft.operation)) {
    errors.push(`${draft.operation} is not compatible with ${draft.modality} mode in this preview.`);
  }
  if (!nonEmpty(parameters.aspectRatio)) errors.push("An aspect ratio is required.");
  if (parameters.width !== undefined && (!Number.isInteger(parameters.width) || parameters.width < 1)) {
    errors.push("Width must be a positive integer when supplied.");
  }
  if (parameters.height !== undefined && (!Number.isInteger(parameters.height) || parameters.height < 1)) {
    errors.push("Height must be a positive integer when supplied.");
  }
  if (draft.modality === "video" && !isPositiveFiniteNumber(parameters.durationSeconds)) {
    errors.push("Video duration must be greater than zero.");
  }
  if (draft.modality === "video" && !isPositiveFiniteNumber(parameters.fps)) {
    errors.push("Video frame rate must be greater than zero.");
  }
  if (parameters.durationSeconds !== undefined && !isPositiveFiniteNumber(parameters.durationSeconds)) {
    errors.push("Duration must be a finite positive number when supplied.");
  }
  if (parameters.fps !== undefined && !isPositiveFiniteNumber(parameters.fps)) {
    errors.push("Frame rate must be a finite positive number when supplied.");
  }
  if (parameters.seed !== undefined && parameters.seed !== null && !Number.isInteger(parameters.seed)) {
    errors.push("Seed must be an integer or null.");
  }
  if (parameters.variantCount !== undefined && (!Number.isInteger(parameters.variantCount) || parameters.variantCount < 1)) {
    errors.push("Variant count must be a positive integer.");
  }
  if (draft.operation === "authorized-watermark-cleanup") {
    const authorization = draft.authority?.watermarkAuthorization ?? "unknown";
    if (!["user-owned", "licensed", "explicit-permission"].includes(authorization)) {
      errors.push("Watermark cleanup requires user-owned, licensed, or explicit-permission authority.");
    }
  }

  if (!nonEmpty(draft.providerProfileRevisionId)) warnings.push("Provider profile evidence is not observed in the renderer preview.");
  if (!nonEmpty(draft.modelProfileRevisionId)) warnings.push("Model profile evidence is not observed in the renderer preview.");
  if (!nonEmpty(draft.capabilitySnapshotRevisionId)) warnings.push("Capability snapshot evidence is not observed; endpoint support remains unknown.");
  if (!nonEmpty(draft.authority?.policyRevisionId)) warnings.push("Policy revision evidence is not observed in the renderer preview.");
  if ((draft.inputArtifactIds?.length ?? 0) > 0) warnings.push("Input artifacts are referenced by ID only; no upload occurs in this preview.");

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors), warnings: Object.freeze(warnings) });
}

function nowIso(now: string | Date | undefined): string {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && !Number.isNaN(Date.parse(now))) return new Date(now).toISOString();
  return new Date().toISOString();
}

function previewId(value: string | null | undefined, fallback: string): string {
  return nonEmpty(value) ? value!.trim() : fallback;
}

/**
 * Creates a copy-safe job projection. Placeholder revision IDs are explicitly
 * prefixed as preview values so consumers cannot mistake them for native
 * revisions or provider handles.
 */
export function buildMediaGenerationPreviewJob(
  draft: MediaGenerationDraft,
  options: { readonly jobId?: string; readonly now?: string | Date; readonly idempotencyKey?: string } = {},
): MediaGenerationPreviewJob {
  const createdAt = nowIso(options.now);
  const inputArtifactIds = uniqueStrings(draft.inputArtifactIds);
  const maskArtifactIds = uniqueStrings(draft.maskArtifactIds);
  return Object.freeze({
    schemaVersion: 1,
    jobId: previewId(options.jobId, "preview:media-job"),
    attemptId: null,
    modality: draft.modality,
    operation: draft.operation,
    status: "draft",
    providerProfileRevisionId: previewId(draft.providerProfileRevisionId, "preview:provider-profile"),
    modelProfileRevisionId: previewId(draft.modelProfileRevisionId, "preview:model-profile"),
    capabilitySnapshotRevisionId: previewId(draft.capabilitySnapshotRevisionId, "preview:capability-snapshot"),
    promptRevisionId: "preview:prompt-revision",
    negativePromptRevisionId: nonEmpty(draft.negativePrompt) ? "preview:negative-prompt-revision" : null,
    inputArtifactIds: Object.freeze(inputArtifactIds),
    maskArtifactIds: Object.freeze(maskArtifactIds),
    parameters: Object.freeze({ ...draft.parameters }),
    providerJobHandle: null,
    providerAcceptance: "not-sent",
    progress: null,
    outputArtifactIds: Object.freeze([]),
    authority: Object.freeze({
      policyRevisionId: previewId(draft.authority?.policyRevisionId, "preview:policy-revision"),
      watermarkAuthorization: draft.authority?.watermarkAuthorization ?? "not-applicable",
    }),
    idempotencyKey: previewId(options.idempotencyKey, `preview:idempotency:${previewId(options.jobId, "media-job")}`),
    createdAt,
    updatedAt: null,
    scope: "renderer-session",
    executionDisposition: "preview-only",
  });
}

export function allowedMediaGenerationTransitions(
  status: MediaGenerationJobStatus,
): readonly MediaGenerationJobStatus[] {
  return transitions[status];
}

export function canTransitionMediaGenerationJob(
  from: MediaGenerationJobStatus,
  to: MediaGenerationJobStatus,
): boolean {
  return transitions[from].includes(to);
}

/**
 * Applies a renderer rehearsal transition. It intentionally keeps provider
 * acceptance at `not-sent` and providerJobHandle null for every status.
 */
export function transitionMediaGenerationPreviewJob(
  job: MediaGenerationPreviewJob,
  nextStatus: MediaGenerationJobStatus,
  options: { readonly now?: string | Date; readonly progress?: number | null } = {},
): MediaGenerationTransitionResult {
  if (!canTransitionMediaGenerationJob(job.status, nextStatus)) {
    return Object.freeze({
      ok: false as const,
      job,
      reason: `${job.status} cannot transition to ${nextStatus} in the media preview lifecycle.`,
    });
  }
  const progress = nextStatus === "completed"
    ? 1
    : nextStatus === "draft" || nextStatus === "cancelled" || nextStatus === "failed" || nextStatus === "outcome-unknown" || nextStatus === "reconcile-required"
      ? null
      : options.progress ?? job.progress;
  return Object.freeze({
    ok: true as const,
    job: Object.freeze({
      ...job,
      status: nextStatus,
      progress,
      providerAcceptance: "not-sent" as const,
      providerJobHandle: null,
      updatedAt: nowIso(options.now),
    }),
  });
}

export function mediaGenerationActionAvailability(
  job: MediaGenerationPreviewJob,
): MediaGenerationActionAvailability {
  const terminal = job.status === "completed" || job.status === "cancelled";
  const retryAvailable = job.status === "failed";
  const cancelAvailable = !terminal && job.status !== "outcome-unknown" && job.status !== "reconcile-required";
  return Object.freeze({
    inspect: Object.freeze({ available: true as const, reason: null }),
    dispatch: Object.freeze({ available: false as const, reason: "Provider dispatch is native-owned and is not connected in this preview." }),
    cancel: Object.freeze({
      available: cancelAvailable,
      reason: cancelAvailable ? null : terminal ? "The preview job is already terminal." : "Cancellation remains native-owned after the external outcome is unknown.",
    }),
    retry: Object.freeze({
      available: retryAvailable,
      reason: retryAvailable
        ? "Retry is only rehearsed locally; native idempotency and provider outcome checks are still required."
        : job.status === "outcome-unknown" || job.status === "reconcile-required"
          ? "Blind retry is disabled until native reconciliation proves the provider outcome."
          : "Retry is available only after a known failure state.",
    }),
    reconcile: Object.freeze({ available: false as const, reason: "Reconciliation is native-owned and no renderer command is connected." }),
  });
}

export function mediaGenerationStatusLabel(status: MediaGenerationJobStatus): string {
  const labels: Record<MediaGenerationJobStatus, string> = {
    draft: "Draft preview",
    validating: "Validating preview",
    uploading: "Upload planned",
    queued: "Queued preview",
    accepted: "Acceptance not observed",
    generating: "Generation planned",
    "post-processing": "Post-processing planned",
    downloading: "Download planned",
    verified: "Verification planned",
    completed: "Completed preview",
    "retry-wait": "Retry wait preview",
    cancelled: "Cancelled preview",
    failed: "Failed preview",
    "outcome-unknown": "Outcome unknown",
    "reconcile-required": "Reconciliation required",
  };
  return labels[status];
}

export function serializeMediaGenerationPreviewJob(job: MediaGenerationPreviewJob): string {
  return JSON.stringify({
    schema: MEDIA_GENERATION_ORCHESTRATION_SCHEMA,
    scope: job.scope,
    executionDisposition: job.executionDisposition,
    job,
    providerCall: "not-called-in-preview",
    nativeWrite: "planned",
    generatedBytes: "not-generated-in-preview",
  }, null, 2);
}
