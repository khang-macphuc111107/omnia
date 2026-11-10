import { assertDomain } from "./errors";
import { assertIsoTimestamp, assertNonBlank, assertSha256, type IsoTimestamp, type JsonObject, type JsonValue } from "./shared";

/**
 * Renderer/native-neutral media pipeline contract.
 *
 * A pipeline describes the work graph only. It does not perform provider
 * calls, read filesystem paths, or assume that an asset is trusted. Native
 * adapters can persist this value and attach their own execution receipts.
 */
export const OMNIA_MEDIA_PIPELINE_SCHEMA_VERSION = 1 as const;

export type MediaPipelineModality = "image" | "video" | "audio" | "document";

export type MediaPipelineAssetOrigin = "input" | "generated" | "derived" | "remote";

export interface MediaPipelineAsset {
  readonly assetId: string;
  readonly modality: MediaPipelineModality;
  readonly mediaType: string;
  readonly filename?: string;
  /** Null means that the provider/native bridge has not measured the bytes. */
  readonly byteSize: number | null;
  readonly contentSha256?: string;
  readonly origin: MediaPipelineAssetOrigin;
  readonly metadata: JsonObject;
}

export type MediaPipelineStageKind =
  | "ingest"
  | "validate"
  | "transform"
  | "generate"
  | "compose"
  | "encode"
  | "preview"
  | "persist"
  | "deliver";

export type MediaPipelineStageStatus =
  | "pending"
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export type MediaPipelineStatus =
  | "draft"
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface MediaPipelineStageSpec {
  readonly stageId: string;
  readonly kind: MediaPipelineStageKind;
  readonly dependsOn?: readonly string[];
  readonly inputAssetIds?: readonly string[];
  readonly outputAssetIds?: readonly string[];
}

export interface MediaPipelineStage extends Omit<MediaPipelineStageSpec, "dependsOn" | "inputAssetIds" | "outputAssetIds"> {
  readonly dependsOn: readonly string[];
  readonly inputAssetIds: readonly string[];
  readonly outputAssetIds: readonly string[];
  readonly status: MediaPipelineStageStatus;
  readonly progress: number;
  readonly attempt: number;
  readonly error?: string;
  readonly startedAt?: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
}

export interface MediaPipeline {
  readonly schemaVersion: typeof OMNIA_MEDIA_PIPELINE_SCHEMA_VERSION;
  readonly pipelineId: string;
  readonly name: string;
  readonly modality: MediaPipelineModality;
  readonly status: MediaPipelineStatus;
  readonly assets: readonly MediaPipelineAsset[];
  readonly stages: readonly MediaPipelineStage[];
  readonly progress: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly metadata: JsonObject;
}

export interface CreateMediaPipelineInput {
  readonly pipelineId: string;
  readonly name: string;
  readonly modality: MediaPipelineModality;
  readonly assets?: readonly MediaPipelineAsset[];
  readonly stages: readonly MediaPipelineStageSpec[];
  readonly now: IsoTimestamp;
  readonly metadata?: JsonObject;
}

export interface MediaPipelineStagePatch {
  readonly status: MediaPipelineStageStatus;
  readonly progress?: number;
  readonly error?: string;
  readonly startedAt?: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
  readonly attempt?: number;
}

const MODALITIES: readonly MediaPipelineModality[] = ["image", "video", "audio", "document"];
const ASSET_ORIGINS: readonly MediaPipelineAssetOrigin[] = ["input", "generated", "derived", "remote"];
const STAGE_KINDS: readonly MediaPipelineStageKind[] = [
  "ingest",
  "validate",
  "transform",
  "generate",
  "compose",
  "encode",
  "preview",
  "persist",
  "deliver",
];
const STAGE_STATUSES: readonly MediaPipelineStageStatus[] = [
  "pending",
  "ready",
  "running",
  "paused",
  "completed",
  "failed",
  "skipped",
  "cancelled",
];
const PIPELINE_STATUSES: readonly MediaPipelineStatus[] = [
  "draft",
  "ready",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function parseJsonObject(value: unknown): JsonObject {
  assertDomain(isRecord(value) && Object.values(value).every(isJsonValue), "invalid_argument", "Media pipeline metadata must be JSON-compatible.");
  return Object.fromEntries(Object.entries(value)) as JsonObject;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function normalizeIds(values: readonly string[] | undefined, label: string): readonly string[] {
  const normalized = (values ?? []).map((value) => assertNonBlank(value, label, 256));
  assertDomain(new Set(normalized).size === normalized.length, "invalid_argument", `${label} cannot contain duplicates.`);
  return Object.freeze(normalized);
}

function assertProgress(value: number, label = "progress"): number {
  assertDomain(Number.isFinite(value) && value >= 0 && value <= 1, "invalid_parameter", `${label} must be between 0 and 1.`, { value });
  return value;
}

function assertAttempt(value: number): number {
  assertDomain(Number.isSafeInteger(value) && value >= 0, "invalid_parameter", "attempt must be a non-negative safe integer.", { value });
  return value;
}

function assertAsset(asset: MediaPipelineAsset): MediaPipelineAsset {
  const assetId = assertNonBlank(asset.assetId, "asset ID", 256);
  const mediaType = assertNonBlank(asset.mediaType, "asset media type", 255).toLowerCase();
  assertDomain(isOneOf(MODALITIES, asset.modality), "invalid_argument", "Unsupported media asset modality.", { modality: asset.modality });
  assertDomain(isOneOf(ASSET_ORIGINS, asset.origin), "invalid_argument", "Unsupported media asset origin.", { origin: asset.origin });
  assertDomain(asset.byteSize === null || (Number.isSafeInteger(asset.byteSize) && asset.byteSize >= 0), "invalid_argument", "Asset byte size must be null or a non-negative safe integer.", { assetId });
  const filename = asset.filename === undefined ? undefined : assertNonBlank(asset.filename, "asset filename", 512);
  const contentSha256 = asset.contentSha256 === undefined ? undefined : assertSha256(asset.contentSha256, "asset content hash");
  assertDomain(isJsonValue(asset.metadata), "invalid_argument", "Media pipeline asset metadata must be JSON-compatible.", { assetId });
  return Object.freeze({
    assetId,
    modality: asset.modality,
    mediaType,
    ...(filename === undefined ? {} : { filename }),
    byteSize: asset.byteSize,
    ...(contentSha256 === undefined ? {} : { contentSha256 }),
    origin: asset.origin,
    metadata: Object.freeze({ ...asset.metadata }),
  });
}

function assertAcyclic(stages: readonly MediaPipelineStage[]): void {
  const byId = new Map(stages.map((stage) => [stage.stageId, stage]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stageId: string): void => {
    assertDomain(!visiting.has(stageId), "invalid_argument", `Media pipeline stage dependency cycle includes ${stageId}.`, { stageId });
    if (visited.has(stageId)) return;
    const stage = byId.get(stageId);
    assertDomain(stage !== undefined, "invalid_argument", "Media pipeline dependency references an unknown stage.", { stageId });
    visiting.add(stageId);
    for (const dependency of stage.dependsOn) visit(dependency);
    visiting.delete(stageId);
    visited.add(stageId);
  };
  for (const stage of stages) visit(stage.stageId);
}

function assertStageGraph(stages: readonly MediaPipelineStage[], assets: readonly MediaPipelineAsset[]): void {
  assertDomain(stages.length > 0, "invalid_argument", "A media pipeline requires at least one stage.");
  const stageIds = new Set<string>();
  const assetIds = new Set(assets.map((asset) => asset.assetId));
  for (const stage of stages) {
    assertDomain(!stageIds.has(stage.stageId), "conflict", "Media pipeline stage IDs must be unique.", { stageId: stage.stageId });
    stageIds.add(stage.stageId);
    for (const dependency of stage.dependsOn) {
      assertDomain(dependency !== stage.stageId, "invalid_argument", "A stage cannot depend on itself.", { stageId: stage.stageId });
      assertDomain(stageIds.has(dependency) || stages.some((candidate) => candidate.stageId === dependency), "invalid_argument", "Media pipeline dependency references an unknown stage.", { dependency });
    }
    for (const assetId of [...stage.inputAssetIds, ...stage.outputAssetIds]) {
      assertDomain(assetIds.has(assetId), "invalid_argument", "Media pipeline stage references an unknown asset.", { stageId: stage.stageId, assetId });
    }
  }
  assertAcyclic(stages);
}

function buildStage(spec: MediaPipelineStageSpec): MediaPipelineStage {
  const stageId = assertNonBlank(spec.stageId, "stage ID", 256);
  assertDomain(isOneOf(STAGE_KINDS, spec.kind), "invalid_argument", "Unsupported media pipeline stage kind.", { kind: spec.kind });
  const dependsOn = normalizeIds(spec.dependsOn, "stage dependency ID");
  const inputAssetIds = normalizeIds(spec.inputAssetIds, "input asset ID");
  const outputAssetIds = normalizeIds(spec.outputAssetIds, "output asset ID");
  const stage: MediaPipelineStage = Object.freeze({
    stageId,
    kind: spec.kind,
    dependsOn,
    inputAssetIds,
    outputAssetIds,
    status: dependsOn.length === 0 ? "ready" : "pending",
    progress: 0,
    attempt: 0,
  });
  return stage;
}

function aggregateProgress(stages: readonly MediaPipelineStage[]): number {
  if (stages.length === 0) return 0;
  return Number((stages.reduce((total, stage) => total + (stage.status === "skipped" || stage.status === "completed" ? 1 : stage.progress), 0) / stages.length).toFixed(4));
}

function pipelineStatusForStages(current: MediaPipelineStatus, stages: readonly MediaPipelineStage[]): MediaPipelineStatus {
  if (current === "cancelled") return current;
  if (stages.some((stage) => stage.status === "failed")) return "failed";
  if (stages.every((stage) => stage.status === "completed" || stage.status === "skipped")) return "completed";
  if (current === "paused") return current;
  if (stages.some((stage) => stage.status === "running")) return "running";
  if (stages.some((stage) => stage.status === "ready")) return "ready";
  return current === "draft" ? "draft" : "ready";
}

export function createMediaPipeline(input: CreateMediaPipelineInput): MediaPipeline {
  const pipelineId = assertNonBlank(input.pipelineId, "pipeline ID", 256);
  const name = assertNonBlank(input.name, "pipeline name", 512);
  assertDomain(isOneOf(MODALITIES, input.modality), "invalid_argument", "Unsupported media pipeline modality.", { modality: input.modality });
  assertIsoTimestamp(input.now, "now");
  const assets = Object.freeze((input.assets ?? []).map(assertAsset));
  assertDomain(new Set(assets.map((asset) => asset.assetId)).size === assets.length, "conflict", "Media pipeline asset IDs must be unique.");
  const stages = Object.freeze(input.stages.map((spec) => buildStage(spec)));
  assertStageGraph(stages, assets);
  return Object.freeze({
    schemaVersion: OMNIA_MEDIA_PIPELINE_SCHEMA_VERSION,
    pipelineId,
    name,
    modality: input.modality,
    status: "ready",
    assets,
    stages: Object.freeze(stages),
    progress: aggregateProgress(stages),
    createdAt: input.now,
    updatedAt: input.now,
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

export function readyMediaPipelineStages(pipeline: MediaPipeline): readonly string[] {
  const completed = new Set(pipeline.stages.filter((stage) => stage.status === "completed" || stage.status === "skipped").map((stage) => stage.stageId));
  return Object.freeze(pipeline.stages.filter((stage) => stage.status === "pending" && stage.dependsOn.every((dependency) => completed.has(dependency))).map((stage) => stage.stageId));
}

export function refreshMediaPipeline(pipeline: MediaPipeline, now: IsoTimestamp): MediaPipeline {
  assertIsoTimestamp(now, "now");
  const ready = new Set(readyMediaPipelineStages(pipeline));
  const stages = Object.freeze(pipeline.stages.map((stage) => stage.status === "pending" && ready.has(stage.stageId) ? Object.freeze({ ...stage, status: "ready" as const }) : stage));
  return Object.freeze({ ...pipeline, stages, status: pipelineStatusForStages(pipeline.status, stages), progress: aggregateProgress(stages), updatedAt: now });
}

export function updateMediaPipelineStage(pipeline: MediaPipeline, stageId: string, patch: MediaPipelineStagePatch, now: IsoTimestamp): MediaPipeline {
  const normalizedStageId = assertNonBlank(stageId, "stage ID", 256);
  assertIsoTimestamp(now, "now");
  assertDomain(pipeline.status !== "completed" && pipeline.status !== "cancelled", "invalid_state_transition", "A terminal media pipeline cannot be changed.", { pipelineId: pipeline.pipelineId });
  assertDomain(isOneOf(STAGE_STATUSES, patch.status), "invalid_argument", "Unsupported media pipeline stage status.", { status: patch.status });
  const existing = pipeline.stages.find((stage) => stage.stageId === normalizedStageId);
  assertDomain(existing !== undefined, "not_found", "Media pipeline stage was not found.", { stageId: normalizedStageId });
  const allowed: Readonly<Record<MediaPipelineStageStatus, readonly MediaPipelineStageStatus[]>> = {
    pending: ["ready", "cancelled", "skipped"],
    ready: ["running", "cancelled", "skipped"],
    running: ["paused", "completed", "failed", "cancelled"],
    paused: ["ready", "cancelled"],
    completed: [],
    failed: ["ready", "cancelled"],
    skipped: [],
    cancelled: [],
  };
  assertDomain(existing.status === patch.status || allowed[existing.status].includes(patch.status), "invalid_state_transition", `${existing.status} cannot transition to ${patch.status}.`, { stageId: normalizedStageId });
  if (patch.status === "ready" || patch.status === "running") {
    const completed = new Set(pipeline.stages.filter((candidate) => candidate.status === "completed" || candidate.status === "skipped").map((candidate) => candidate.stageId));
    assertDomain(existing.dependsOn.every((dependency) => completed.has(dependency)), "invalid_state_transition", "A media pipeline stage cannot start before all dependencies complete.", { stageId: normalizedStageId });
  }
  const progress = assertProgress(patch.progress ?? (patch.status === "completed" || patch.status === "skipped" ? 1 : patch.status === "failed" || patch.status === "cancelled" ? 0 : existing.progress));
  if (patch.status === "completed" || patch.status === "skipped") assertDomain(progress === 1, "invalid_state_transition", "Completed media stages must have progress 1.");
  if (patch.status === "failed") assertDomain(patch.error !== undefined && patch.error.trim().length > 0, "invalid_argument", "Failed media stages require an error message.");
  if (patch.startedAt !== undefined) assertIsoTimestamp(patch.startedAt, "startedAt");
  if (patch.finishedAt !== undefined) assertIsoTimestamp(patch.finishedAt, "finishedAt");
  const stage: MediaPipelineStage = Object.freeze({
    ...existing,
    status: patch.status,
    progress,
    attempt: patch.attempt === undefined ? existing.attempt + (patch.status === "running" && existing.status !== "running" ? 1 : 0) : assertAttempt(patch.attempt),
    ...(patch.error === undefined ? {} : { error: patch.error.trim() }),
    ...(patch.startedAt === undefined ? {} : { startedAt: patch.startedAt }),
    ...(patch.finishedAt === undefined ? {} : { finishedAt: patch.finishedAt }),
  });
  const stages = Object.freeze(pipeline.stages.map((candidate) => candidate.stageId === normalizedStageId ? stage : candidate));
  assertStageGraph(stages, pipeline.assets);
  return Object.freeze({ ...pipeline, stages, status: pipelineStatusForStages(pipeline.status, stages), progress: aggregateProgress(stages), updatedAt: now });
}

export function addMediaPipelineAsset(pipeline: MediaPipeline, asset: MediaPipelineAsset, now: IsoTimestamp): MediaPipeline {
  assertIsoTimestamp(now, "now");
  const normalized = assertAsset(asset);
  assertDomain(!pipeline.assets.some((candidate) => candidate.assetId === normalized.assetId), "conflict", "Media pipeline asset ID already exists.", { assetId: normalized.assetId });
  return Object.freeze({ ...pipeline, assets: Object.freeze([...pipeline.assets, normalized]), updatedAt: now });
}

export function attachMediaPipelineStageOutput(pipeline: MediaPipeline, stageId: string, assetIds: readonly string[], now: IsoTimestamp): MediaPipeline {
  const normalizedStageId = assertNonBlank(stageId, "stage ID", 256);
  assertIsoTimestamp(now, "now");
  const stage = pipeline.stages.find((candidate) => candidate.stageId === normalizedStageId);
  assertDomain(stage !== undefined, "not_found", "Media pipeline stage was not found.", { stageId: normalizedStageId });
  const normalizedAssetIds = normalizeIds(assetIds, "output asset ID");
  const known = new Set(pipeline.assets.map((asset) => asset.assetId));
  for (const assetId of normalizedAssetIds) assertDomain(known.has(assetId), "invalid_argument", "Stage output references an unknown asset.", { assetId });
  const stages = Object.freeze(pipeline.stages.map((candidate) => candidate.stageId === normalizedStageId ? Object.freeze({ ...candidate, outputAssetIds: normalizedAssetIds }) : candidate));
  return Object.freeze({ ...pipeline, stages, updatedAt: now });
}

function parseAsset(value: unknown): MediaPipelineAsset {
  assertDomain(isRecord(value) && isString(value.assetId) && isString(value.modality) && isString(value.mediaType) && (value.byteSize === null || typeof value.byteSize === "number") && isString(value.origin) && isRecord(value.metadata), "invalid_argument", "Invalid media pipeline asset.");
  return assertAsset({
    assetId: value.assetId,
    modality: value.modality as MediaPipelineModality,
    mediaType: value.mediaType,
    ...(isString(value.filename) ? { filename: value.filename } : {}),
    byteSize: value.byteSize,
    ...(isString(value.contentSha256) ? { contentSha256: value.contentSha256 } : {}),
    origin: value.origin as MediaPipelineAssetOrigin,
    metadata: parseJsonObject(value.metadata),
  });
}

function parseStage(value: unknown): MediaPipelineStage {
  assertDomain(isRecord(value) && isString(value.stageId) && isString(value.kind) && Array.isArray(value.dependsOn) && Array.isArray(value.inputAssetIds) && Array.isArray(value.outputAssetIds) && isString(value.status) && typeof value.progress === "number" && typeof value.attempt === "number", "invalid_argument", "Invalid media pipeline stage.");
  assertDomain(value.dependsOn.every(isString) && value.inputAssetIds.every(isString) && value.outputAssetIds.every(isString), "invalid_argument", "Invalid media pipeline stage references.");
  assertDomain(isOneOf(STAGE_KINDS, value.kind) && isOneOf(STAGE_STATUSES, value.status), "invalid_argument", "Invalid media pipeline stage kind or status.");
  if (isString(value.startedAt)) assertIsoTimestamp(value.startedAt, "startedAt");
  if (isString(value.finishedAt)) assertIsoTimestamp(value.finishedAt, "finishedAt");
  return Object.freeze({
    stageId: value.stageId,
    kind: value.kind,
    dependsOn: normalizeIds(value.dependsOn, "stage dependency ID"),
    inputAssetIds: normalizeIds(value.inputAssetIds, "input asset ID"),
    outputAssetIds: normalizeIds(value.outputAssetIds, "output asset ID"),
    status: value.status,
    progress: assertProgress(value.progress),
    attempt: assertAttempt(value.attempt),
    ...(isString(value.error) ? { error: value.error } : {}),
    ...(isString(value.startedAt) ? { startedAt: value.startedAt } : {}),
    ...(isString(value.finishedAt) ? { finishedAt: value.finishedAt } : {}),
  });
}

export function deserializeMediaPipeline(input: string | unknown): MediaPipeline {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  assertDomain(isRecord(value) && value.schemaVersion === OMNIA_MEDIA_PIPELINE_SCHEMA_VERSION && isString(value.pipelineId) && isString(value.name) && isString(value.modality) && isString(value.status) && Array.isArray(value.assets) && Array.isArray(value.stages) && typeof value.progress === "number" && isString(value.createdAt) && isString(value.updatedAt) && isRecord(value.metadata), "invalid_argument", "Invalid media pipeline.");
  assertDomain(isOneOf(MODALITIES, value.modality) && isOneOf(PIPELINE_STATUSES, value.status), "invalid_argument", "Invalid media pipeline modality or status.");
  const assets = Object.freeze(value.assets.map(parseAsset));
  assertDomain(new Set(assets.map((asset) => asset.assetId)).size === assets.length, "conflict", "Media pipeline asset IDs must be unique.");
  const stages = Object.freeze(value.stages.map(parseStage));
  assertStageGraph(stages, assets);
  assertIsoTimestamp(value.createdAt, "createdAt");
  assertIsoTimestamp(value.updatedAt, "updatedAt");
  return Object.freeze({
    schemaVersion: OMNIA_MEDIA_PIPELINE_SCHEMA_VERSION,
    pipelineId: assertNonBlank(value.pipelineId, "pipeline ID", 256),
    name: assertNonBlank(value.name, "pipeline name", 512),
    modality: value.modality,
    status: value.status,
    assets,
    stages,
    progress: assertProgress(value.progress),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    metadata: Object.freeze(parseJsonObject(value.metadata)),
  });
}

export function serializeMediaPipeline(pipeline: MediaPipeline): string {
  return JSON.stringify(pipeline, null, 2);
}
