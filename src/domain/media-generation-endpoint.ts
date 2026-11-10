import { assertDomain } from "./errors";
import { sha256Hex } from "./omnia-official-harness-adapters";
import {
  findProviderCapabilityMatch,
  isNativeProviderCapability,
  validateProviderEndpointCapabilitySnapshot,
  type ProviderCapabilityEvidence,
  type ProviderCapabilityModality,
  type ProviderEndpointCapabilitySnapshot,
  type ProviderEndpointOperation,
} from "./provider-endpoint-capability";
import { assertIsoTimestamp, assertNonBlank, assertSha256, type IsoTimestamp, type JsonValue } from "./shared";

/**
 * Provider-neutral metadata plan for media-generation endpoints.
 *
 * The planner consumes a native-owned capability snapshot and immutable prompt
 * and artifact references. It never accepts prompt text, file bytes, paths,
 * credentials, or provider payloads. A `ready` result means the route is
 * capability-admitted for a later native dispatch; it does not mean a request
 * was sent or a provider job was accepted.
 */
export const MEDIA_GENERATION_ENDPOINT_PLAN_SCHEMA = "omnia.media-generation-endpoint-plan.v1" as const;

export type MediaGenerationEndpointModality = "image" | "video" | "audio" | "document";
export type MediaGenerationEndpointOperation =
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
  | "text-to-audio"
  | "audio-variation"
  | "compose";

export type MediaGenerationEndpointDisposition = "ready" | "blocked" | "unsupported";
export type MediaGenerationEndpointReason =
  | "capability-not-found"
  | "capability-not-native"
  | "capability-stale"
  | "capability-direction-mismatch"
  | "model-not-authorized"
  | "constraint-exceeded"
  | "invalid-parameter"
  | "unsupported-modality"
  | "provider-payload-withheld";

export interface MediaGenerationEndpointParameters {
  readonly aspectRatio: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly fps?: number;
  readonly variantCount?: number;
  readonly seed?: number | null;
  readonly [key: string]: JsonValue | undefined;
}

export interface CreateMediaGenerationEndpointPlanInput {
  readonly schemaVersion: 1;
  readonly now: IsoTimestamp;
  readonly requestId: string;
  readonly jobId: string;
  readonly modality: MediaGenerationEndpointModality;
  readonly operation: MediaGenerationEndpointOperation;
  /** Hashes are native prompt-store revisions; prompt text is intentionally absent. */
  readonly promptRevisionId: string;
  readonly promptSha256: string;
  readonly negativePromptRevisionId?: string | null;
  readonly negativePromptSha256?: string | null;
  /** IDs are frozen native artifact selections; source bytes are resolved later by native code. */
  readonly inputArtifactIds?: readonly string[];
  readonly maskArtifactIds?: readonly string[];
  readonly parameters: MediaGenerationEndpointParameters;
  readonly modelId: string;
  readonly capabilitySnapshot: ProviderEndpointCapabilitySnapshot;
}

export interface MediaGenerationEndpointPlan {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly requestId: string;
  readonly jobId: string;
  readonly modality: MediaGenerationEndpointModality;
  readonly operation: MediaGenerationEndpointOperation;
  readonly disposition: MediaGenerationEndpointDisposition;
  readonly reasons: readonly MediaGenerationEndpointReason[];
  readonly modelId: string;
  readonly providerProfileRevisionId: string;
  readonly capabilitySnapshotId: string;
  readonly capabilitySupportLevel: "documented-native" | "model-gated" | "adapter-gated" | "bridge-required" | "unsupported" | "unknown";
  readonly capabilityEvidence: readonly Pick<ProviderCapabilityEvidence, "kind" | "reference" | "retrievedAt" | "contentHash" | "expiresAt">[];
  readonly promptRevisionId: string;
  readonly promptSha256: string;
  readonly negativePromptRevisionId: string | null;
  readonly negativePromptSha256: string | null;
  readonly inputArtifactIds: readonly string[];
  readonly maskArtifactIds: readonly string[];
  readonly parameters: MediaGenerationEndpointParameters;
  readonly requestFingerprint: string;
  readonly idempotencyKey: string;
  /** Always null: provider wire bodies and bytes are native-only and ephemeral. */
  readonly providerWirePayload: null;
  readonly createdAt: IsoTimestamp;
}

const IMAGE_OPERATIONS = new Set<MediaGenerationEndpointOperation>([
  "text-to-image", "image-variation", "inpaint", "outpaint", "background-remove",
  "background-replace", "upscale", "object-cleanup", "authorized-watermark-cleanup",
]);
const VIDEO_OPERATIONS = new Set<MediaGenerationEndpointOperation>([
  "text-to-video", "image-to-video", "video-extend", "video-interpolate", "storyboard", "lip-sync",
]);
const AUDIO_OPERATIONS = new Set<MediaGenerationEndpointOperation>(["text-to-audio", "audio-variation"]);
const ENDPOINT_BY_MODALITY: Readonly<Record<MediaGenerationEndpointModality, { operation: ProviderEndpointOperation; capabilityModality: ProviderCapabilityModality }>> = {
  image: { operation: "images", capabilityModality: "image" },
  video: { operation: "video", capabilityModality: "video" },
  audio: { operation: "audio", capabilityModality: "audio" },
  document: { operation: "files", capabilityModality: "file" },
};
const MAX_ID_BYTES = 512;
const MAX_ARTIFACTS = 256;

function uniqueIds(values: readonly string[] | undefined, label: string): readonly string[] {
  const ids = (values ?? []).map((value) => assertNonBlank(value, label, MAX_ID_BYTES));
  assertDomain(ids.length <= MAX_ARTIFACTS, "invalid_argument", `${label} list is too large.`);
  assertDomain(new Set(ids).size === ids.length, "conflict", `${label} list cannot contain duplicates.`);
  return Object.freeze(ids);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => canonicalize(entry))) as JsonValue;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalize(entry)] as const);
    return Object.freeze(Object.fromEntries(entries)) as JsonValue;
  }
  return value;
}

function modalityForOperation(operation: MediaGenerationEndpointOperation): MediaGenerationEndpointModality | null {
  if (IMAGE_OPERATIONS.has(operation)) return "image";
  if (VIDEO_OPERATIONS.has(operation)) return "video";
  if (AUDIO_OPERATIONS.has(operation)) return "audio";
  return null;
}

function assertParameters(parameters: MediaGenerationEndpointParameters): MediaGenerationEndpointParameters {
  const aspectRatio = assertNonBlank(parameters.aspectRatio, "aspectRatio", 64);
  for (const [label, value] of [["width", parameters.width], ["height", parameters.height], ["variantCount", parameters.variantCount]] as const) {
    if (value !== undefined) assertDomain(Number.isSafeInteger(value) && value > 0, "invalid_parameter", `${label} must be a positive integer.`, { label });
  }
  for (const [label, value] of [["durationSeconds", parameters.durationSeconds], ["fps", parameters.fps]] as const) {
    if (value !== undefined) assertDomain(Number.isFinite(value) && value > 0, "invalid_parameter", `${label} must be finite and greater than zero.`, { label });
  }
  if (parameters.seed !== undefined && parameters.seed !== null) assertDomain(Number.isSafeInteger(parameters.seed), "invalid_parameter", "seed must be an integer or null.");
  return Object.freeze({ ...parameters, aspectRatio });
}

function staleSnapshot(snapshot: ProviderEndpointCapabilitySnapshot, now: IsoTimestamp, matchedCapability?: NonNullable<ReturnType<typeof findProviderCapabilityMatch>>): boolean {
  if (snapshot.freshness === "cached-stale" || snapshot.freshness === "unknown") return true;
  const nowMs = Date.parse(now);
  return matchedCapability?.evidence.some((evidence) => evidence.expiresAt !== undefined && evidence.expiresAt !== null && Date.parse(evidence.expiresAt) <= nowMs) ?? false;
}

function constraintsExceeded(parameters: MediaGenerationEndpointParameters, constraints: NonNullable<ReturnType<typeof findProviderCapabilityMatch>>["constraints"]): boolean {
  if (!constraints) return false;
  if (constraints.maxItems !== undefined && constraints.maxItems !== null && parameters.variantCount !== undefined && parameters.variantCount > constraints.maxItems) return true;
  if (constraints.maxWidth !== undefined && constraints.maxWidth !== null && parameters.width !== undefined && parameters.width > constraints.maxWidth) return true;
  if (constraints.maxHeight !== undefined && constraints.maxHeight !== null && parameters.height !== undefined && parameters.height > constraints.maxHeight) return true;
  if (constraints.maxDurationSeconds !== undefined && constraints.maxDurationSeconds !== null && parameters.durationSeconds !== undefined && parameters.durationSeconds > constraints.maxDurationSeconds) return true;
  return false;
}

/**
 * Build a deterministic, capability-gated generation plan. This is safe to
 * call from the renderer because it returns metadata only and never compiles
 * or dispatches a provider request.
 */
export function createMediaGenerationEndpointPlan(input: CreateMediaGenerationEndpointPlanInput): MediaGenerationEndpointPlan {
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Unsupported media generation endpoint plan schema version.");
  assertIsoTimestamp(input.now, "now");
  const requestId = assertNonBlank(input.requestId, "requestId", MAX_ID_BYTES);
  const jobId = assertNonBlank(input.jobId, "jobId", MAX_ID_BYTES);
  const modelId = assertNonBlank(input.modelId, "modelId", MAX_ID_BYTES);
  const promptRevisionId = assertNonBlank(input.promptRevisionId, "promptRevisionId", MAX_ID_BYTES);
  const promptSha256 = assertSha256(input.promptSha256, "promptSha256");
  const negativePromptRevisionId = input.negativePromptRevisionId === undefined || input.negativePromptRevisionId === null ? null : assertNonBlank(input.negativePromptRevisionId, "negativePromptRevisionId", MAX_ID_BYTES);
  const negativePromptSha256 = input.negativePromptSha256 === undefined || input.negativePromptSha256 === null ? null : assertSha256(input.negativePromptSha256, "negativePromptSha256");
  assertDomain((negativePromptRevisionId === null) === (negativePromptSha256 === null), "invalid_argument", "Negative prompt revision and hash must be supplied together.");
  const parameters = assertParameters(input.parameters);
  const inputArtifactIds = uniqueIds(input.inputArtifactIds, "inputArtifactId");
  const maskArtifactIds = uniqueIds(input.maskArtifactIds, "maskArtifactId");
  const validated = validateProviderEndpointCapabilitySnapshot(input.capabilitySnapshot);
  const expectedModality = modalityForOperation(input.operation);
  const reasons: MediaGenerationEndpointReason[] = [];
  if (expectedModality !== null && expectedModality !== input.modality) reasons.push("unsupported-modality");
  if (input.modality === "document" && input.operation !== "compose") reasons.push("unsupported-modality");
  const endpoint = ENDPOINT_BY_MODALITY[input.modality];
  const match = expectedModality === input.modality || input.operation === "compose"
    ? findProviderCapabilityMatch(validated, { operation: endpoint.operation, modality: endpoint.capabilityModality, modelId })
    : null;
  if (match === null) reasons.push("capability-not-found");
  else {
    if (!isNativeProviderCapability(match)) reasons.push("capability-not-native");
    if (match.direction !== "generation" && match.direction !== "bidirectional") reasons.push("capability-direction-mismatch");
    if (staleSnapshot(validated, input.now, match)) reasons.push("capability-stale");
    if (constraintsExceeded(parameters, match.constraints)) reasons.push("constraint-exceeded");
  }
  const disposition: MediaGenerationEndpointDisposition = reasons.length === 0 ? "ready" : reasons.includes("capability-not-found") || reasons.includes("unsupported-modality") ? "unsupported" : "blocked";
  const canonicalInput = canonicalize({
    schemaVersion: 1,
    requestId,
    jobId,
    modality: input.modality,
    operation: input.operation,
    modelId,
    capabilitySnapshotId: validated.snapshotId,
    promptRevisionId,
    promptSha256,
    negativePromptRevisionId,
    negativePromptSha256,
    inputArtifactIds,
    maskArtifactIds,
    parameters,
  });
  const requestFingerprint = sha256Hex(JSON.stringify(canonicalInput));
  const capabilityEvidence = Object.freeze((match?.evidence ?? []).map((evidence) => Object.freeze({
    kind: evidence.kind,
    reference: evidence.reference,
    retrievedAt: evidence.retrievedAt,
    ...(evidence.contentHash === undefined ? {} : { contentHash: evidence.contentHash }),
    ...(evidence.expiresAt === undefined ? {} : { expiresAt: evidence.expiresAt }),
  })));
  return Object.freeze({
    schemaVersion: 1,
    planId: `media-plan-${requestFingerprint.slice(0, 24)}`,
    requestId,
    jobId,
    modality: input.modality,
    operation: input.operation,
    disposition,
    reasons: Object.freeze([...new Set(reasons.length ? reasons : ["provider-payload-withheld"])]) as readonly MediaGenerationEndpointReason[],
    modelId,
    providerProfileRevisionId: validated.providerProfileRevisionId,
    capabilitySnapshotId: validated.snapshotId,
    capabilitySupportLevel: match?.supportLevel ?? "unknown",
    capabilityEvidence,
    promptRevisionId,
    promptSha256,
    negativePromptRevisionId,
    negativePromptSha256,
    inputArtifactIds,
    maskArtifactIds,
    parameters,
    requestFingerprint,
    idempotencyKey: `media:${validated.providerProfileRevisionId}:${modelId}:${requestFingerprint}`,
    providerWirePayload: null,
    createdAt: input.now,
  });
}



