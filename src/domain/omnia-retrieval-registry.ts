import { assertDomain } from "./errors";
import type {
  CitationId,
  IndexedSourceId,
  ProfileId,
  ProjectId,
  RetrievalSnapshotId,
  RunId,
  SourceChunkId,
  FileVersionId,
} from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
  type JsonObject,
  type JsonValue,
} from "./shared";

/**
 * Renderer-safe retrieval contracts.  Connectors describe authority and
 * provenance; they do not execute network or filesystem operations here.
 * Native adapters can hydrate this catalog without changing the renderer
 * shape.
 */
export type RetrievalConnectorKind =
  | "workspace"
  | "attachment"
  | "web"
  | "conversation"
  | "memory"
  | "artifact"
  | "custom";

export type RetrievalCapability = "lexical" | "semantic" | "graph" | "metadata" | "remote";

export interface RetrievalConnector {
  readonly id: string;
  readonly label: string;
  readonly kind: RetrievalConnectorKind;
  readonly version: string;
  readonly capabilities: readonly RetrievalCapability[];
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly scope: "local" | "project" | "profile" | "remote";
  readonly updatedAt: IsoTimestamp;
  readonly metadata: JsonObject;
}

export type RetrievalSourceKind = "workspace_file" | "attachment" | "artifact" | "conversation" | "memory" | "web_page" | "custom";
export type RetrievalSourceState = "active" | "superseded" | "revoked" | "deleted";

export interface IndexedRetrievalSource {
  readonly id: IndexedSourceId;
  readonly connectorId: string;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly kind: RetrievalSourceKind;
  readonly displayName: string;
  readonly sourceKeySha256: string;
  readonly relativePath?: string;
  readonly state: RetrievalSourceState;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly invalidatedAt?: IsoTimestamp;
  readonly metadata: JsonObject;
}

export interface RetrievalSourceVersion {
  readonly id: FileVersionId;
  readonly sourceId: IndexedSourceId;
  readonly ordinal: number;
  readonly contentSha256: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly createdAt: IsoTimestamp;
  readonly supersededAt?: IsoTimestamp;
  readonly invalidatedAt?: IsoTimestamp;
  readonly metadata: JsonObject;
}

export interface RetrievalSourceChunk {
  readonly id: SourceChunkId;
  readonly sourceVersionId: FileVersionId;
  readonly sourceId: IndexedSourceId;
  readonly ordinal: number;
  readonly text: string;
  readonly contentSha256: string;
  readonly sourceContentSha256: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly pageStart?: number;
  readonly pageEnd?: number;
  readonly tokenEstimate: number;
  readonly tokenEstimatorVersion: string;
  readonly createdAt: IsoTimestamp;
  readonly invalidatedAt?: IsoTimestamp;
  readonly metadata: JsonObject;
}

export interface RetrievalCatalog {
  readonly version: 1;
  readonly connectors: readonly RetrievalConnector[];
  readonly sources: readonly IndexedRetrievalSource[];
  readonly sourceVersions: readonly RetrievalSourceVersion[];
  readonly chunks: readonly RetrievalSourceChunk[];
}

export interface RetrievalSearchOptions {
  /** Restrict results to one profile before applying the result limit. */
  readonly profileId?: ProfileId;
  readonly connectorIds?: readonly string[];
  readonly sourceKinds?: readonly RetrievalSourceKind[];
  readonly projectId?: ProjectId;
  readonly limit?: number;
  readonly minScore?: number;
}

export interface RetrievalCandidate {
  readonly chunk: RetrievalSourceChunk;
  readonly source: IndexedRetrievalSource;
  readonly connector: RetrievalConnector;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly rank: number;
}

export type RetrievalSnapshotState = "building" | "frozen" | "failed" | "invalidated";
export type RetrievalDisposition = "selected" | "omitted";
export type RetrievalOmissionReason =
  | "budget"
  | "duplicate"
  | "scope"
  | "disabled"
  | "stale"
  | "low-score"
  | "source-cap";

export interface RetrievalSnapshotItem {
  readonly snapshotId: RetrievalSnapshotId;
  readonly sourceChunkId: SourceChunkId;
  readonly ordinal: number;
  readonly disposition: RetrievalDisposition;
  readonly reason: string;
  readonly rank?: number;
  readonly scorePpm?: number;
  readonly tokenEstimate: number;
  readonly chunkContentSha256: string;
}

export interface RetrievalSnapshot {
  readonly version: 1;
  readonly id: RetrievalSnapshotId;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly runId?: RunId;
  readonly query: string;
  readonly querySha256: string;
  readonly retrieverVersion: string;
  readonly tokenBudget: number;
  readonly consumedTokens: number;
  readonly state: RetrievalSnapshotState;
  readonly items: readonly RetrievalSnapshotItem[];
  readonly createdAt: IsoTimestamp;
  readonly frozenAt?: IsoTimestamp;
  readonly invalidatedAt?: IsoTimestamp;
  readonly snapshotSha256?: string;
  readonly stats: Readonly<{
    candidateCount: number;
    selectedCount: number;
    omittedCount: number;
    distinctSourceCount: number;
  }>;
}

export interface RetrievalCitation {
  readonly id: CitationId;
  readonly snapshotId: RetrievalSnapshotId;
  readonly sourceChunkId: SourceChunkId;
  readonly sourceId: IndexedSourceId;
  readonly label: string;
  readonly excerpt: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly createdAt: IsoTimestamp;
}

const CONNECTOR_KINDS: readonly RetrievalConnectorKind[] = [
  "workspace",
  "attachment",
  "web",
  "conversation",
  "memory",
  "artifact",
  "custom",
];
const CAPABILITIES: readonly RetrievalCapability[] = ["lexical", "semantic", "graph", "metadata", "remote"];
const SOURCE_KINDS: readonly RetrievalSourceKind[] = [
  "workspace_file",
  "attachment",
  "artifact",
  "conversation",
  "memory",
  "web_page",
  "custom",
];
const SOURCE_STATES: readonly RetrievalSourceState[] = ["active", "superseded", "revoked", "deleted"];
const SNAPSHOT_STATES: readonly RetrievalSnapshotState[] = ["building", "frozen", "failed", "invalidated"];
const OMIT_REASONS: readonly RetrievalOmissionReason[] = [
  "budget",
  "duplicate",
  "scope",
  "disabled",
  "stale",
  "low-score",
  "source-cap",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function parseJsonObject(value: unknown, label: string): JsonObject {
  assertDomain(isRecord(value) && isJsonValue(value), "invalid_argument", `${label} must be JSON object data.`);
  return value as JsonObject;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function stamp(): IsoTimestamp {
  return new Date().toISOString();
}

function uniqueStrings(values: readonly string[], label: string): readonly string[] {
  const normalized = values.map((value) => assertNonBlank(value, label, 256));
  assertDomain(new Set(normalized).size === normalized.length, "conflict", `${label} values must be unique.`);
  return Object.freeze(normalized);
}

function normalizeConnector(input: RetrievalConnector): RetrievalConnector {
  assertNonBlank(input.id, "retrieval connector ID", 256);
  assertNonBlank(input.label, "retrieval connector label", 256);
  assertNonBlank(input.version, "retrieval connector version", 128);
  assertDomain(isOneOf(CONNECTOR_KINDS, input.kind), "invalid_argument", "Unknown retrieval connector kind.");
  assertDomain(Array.isArray(input.capabilities), "invalid_argument", "Retrieval connector capabilities must be an array.");
  assertDomain(input.capabilities.length > 0, "invalid_argument", "A retrieval connector needs one capability.");
  assertDomain(input.capabilities.every((capability) => isOneOf(CAPABILITIES, capability)), "invalid_argument", "Unknown retrieval connector capability.");
  assertDomain(new Set(input.capabilities).size === input.capabilities.length, "conflict", "Retrieval connector capabilities must be unique.");
  assertDomain(input.readOnly, "scope_violation", "Retrieval connectors are read-only in the domain registry.");
  assertIsoTimestamp(input.updatedAt, "retrieval connector update time");
  const metadata = parseJsonObject(input.metadata, "retrieval connector metadata");
  return Object.freeze({
    ...input,
    id: input.id.trim(),
    label: input.label.trim(),
    version: input.version.trim(),
    capabilities: Object.freeze([...input.capabilities]),
    metadata: Object.freeze({ ...metadata }),
  });
}

function assertCatalog(catalog: RetrievalCatalog): void {
  assertDomain(catalog.version === 1, "invalid_argument", "Unsupported retrieval catalog version.");
  assertDomain(new Set(catalog.connectors.map((connector) => connector.id)).size === catalog.connectors.length, "conflict", "Retrieval connector IDs must be unique.");
  assertDomain(new Set(catalog.sources.map((source) => source.id)).size === catalog.sources.length, "conflict", "Indexed source IDs must be unique.");
  assertDomain(new Set(catalog.sourceVersions.map((version) => version.id)).size === catalog.sourceVersions.length, "conflict", "Source version IDs must be unique.");
  assertDomain(new Set(catalog.chunks.map((chunk) => chunk.id)).size === catalog.chunks.length, "conflict", "Source chunk IDs must be unique.");

  const connectorIds = new Set<string>();
  for (const connector of catalog.connectors) {
    normalizeConnector(connector);
    connectorIds.add(connector.id);
  }
  const sourceIds = new Set<IndexedSourceId>();
  for (const source of catalog.sources) {
    validateIndexedRetrievalSource(source);
    assertDomain(connectorIds.has(source.connectorId), "not_found", "Indexed source connector was not found.", { connectorId: source.connectorId });
    sourceIds.add(source.id);
  }
  const sourceVersions = new Map<FileVersionId, RetrievalSourceVersion>();
  const sourceVersionOrdinals = new Set<string>();
  for (const version of catalog.sourceVersions) {
    validateRetrievalSourceVersion(version);
    assertDomain(sourceIds.has(version.sourceId), "not_found", "Source version parent source was not found.", { sourceId: version.sourceId });
    assertDomain(!sourceVersions.has(version.id), "conflict", "Source version IDs must be unique.");
    const ordinalKey = JSON.stringify([version.sourceId, version.ordinal]);
    assertDomain(!sourceVersionOrdinals.has(ordinalKey), "conflict", "Source version ordinals must be unique for each source.", { sourceId: version.sourceId, ordinal: version.ordinal });
    sourceVersionOrdinals.add(ordinalKey);
    sourceVersions.set(version.id, version);
  }
  const chunkOrdinals = new Set<string>();
  for (const chunk of catalog.chunks) {
    validateRetrievalSourceChunk(chunk);
    const version = sourceVersions.get(chunk.sourceVersionId);
    assertDomain(version !== undefined, "not_found", "Source chunk parent version was not found.", { sourceVersionId: chunk.sourceVersionId });
    assertDomain(version.sourceId === chunk.sourceId, "conflict", "Source chunk source does not match its version.");
    assertDomain(chunk.endByte <= version.byteSize, "invalid_argument", "Source chunk byte range exceeds its source version.", { sourceChunkId: chunk.id, sourceVersionId: version.id });
    const ordinalKey = JSON.stringify([chunk.sourceVersionId, chunk.ordinal]);
    assertDomain(!chunkOrdinals.has(ordinalKey), "conflict", "Source chunk ordinals must be unique for each source version.", { sourceVersionId: chunk.sourceVersionId, ordinal: chunk.ordinal });
    chunkOrdinals.add(ordinalKey);
  }
}

function validateIndexedRetrievalSource(source: IndexedRetrievalSource): void {
  assertNonBlank(source.id, "indexed source ID", 256);
  assertNonBlank(source.connectorId, "indexed source connector ID", 256);
  assertNonBlank(source.profileId, "indexed source profile ID", 256);
  if (source.projectId !== undefined) assertNonBlank(source.projectId, "indexed source project ID", 256);
  assertNonBlank(source.displayName, "indexed source display name", 1_000);
  assertSha256(source.sourceKeySha256, "indexed source key");
  assertDomain(isOneOf(SOURCE_KINDS, source.kind), "invalid_argument", "Unknown indexed source kind.");
  assertDomain(isOneOf(SOURCE_STATES, source.state), "invalid_argument", "Unknown indexed source state.");
  assertIsoTimestamp(source.createdAt, "indexed source creation time");
  assertIsoTimestamp(source.updatedAt, "indexed source update time");
  if (source.invalidatedAt !== undefined) assertIsoTimestamp(source.invalidatedAt, "indexed source invalidation time");
  assertDomain(source.state === "active" ? source.invalidatedAt === undefined : source.invalidatedAt !== undefined, "invalid_argument", "Indexed source invalidation state is inconsistent.");
  if (source.relativePath !== undefined) assertNonBlank(source.relativePath, "indexed source relative path", 16_000);
  parseJsonObject(source.metadata, "indexed source metadata");
}

function validateRetrievalSourceVersion(version: RetrievalSourceVersion): void {
  assertNonBlank(version.id, "source version ID", 256);
  assertNonBlank(version.sourceId, "source version source ID", 256);
  assertDomain(Number.isSafeInteger(version.ordinal) && version.ordinal >= 1, "invalid_argument", "Source version ordinal must be a positive integer.");
  assertSha256(version.contentSha256, "source version content hash");
  assertDomain(Number.isSafeInteger(version.byteSize) && version.byteSize >= 0, "invalid_argument", "Source version byte size must be non-negative.");
  assertNonBlank(version.mediaType, "source version media type", 256);
  assertNonBlank(version.extractorId, "source extractor ID", 256);
  assertNonBlank(version.extractorVersion, "source extractor version", 128);
  assertIsoTimestamp(version.createdAt, "source version creation time");
  if (version.supersededAt !== undefined) assertIsoTimestamp(version.supersededAt, "source version superseded time");
  if (version.invalidatedAt !== undefined) assertIsoTimestamp(version.invalidatedAt, "source version invalidation time");
  parseJsonObject(version.metadata, "source version metadata");
}

function validateRetrievalSourceChunk(chunk: RetrievalSourceChunk): void {
  assertNonBlank(chunk.id, "source chunk ID", 256);
  assertNonBlank(chunk.sourceVersionId, "source chunk source version ID", 256);
  assertNonBlank(chunk.sourceId, "source chunk source ID", 256);
  assertNonBlank(chunk.text, "source chunk text", 250_000);
  assertSha256(chunk.contentSha256, "source chunk content hash");
  assertSha256(chunk.sourceContentSha256, "source chunk source hash");
  assertDomain(Number.isSafeInteger(chunk.ordinal) && chunk.ordinal >= 0, "invalid_argument", "Source chunk ordinal must be non-negative.");
  assertDomain(Number.isSafeInteger(chunk.startByte) && Number.isSafeInteger(chunk.endByte) && chunk.startByte >= 0 && chunk.endByte > chunk.startByte, "invalid_argument", "Source chunk byte range is invalid.");
  for (const [label, value] of [["startLine", chunk.startLine], ["endLine", chunk.endLine], ["pageStart", chunk.pageStart], ["pageEnd", chunk.pageEnd]] as const) {
    if (value !== undefined) assertDomain(Number.isSafeInteger(value) && value >= 0, "invalid_argument", `Source chunk ${label} must be a non-negative integer.`);
  }
  assertDomain(chunk.startLine === undefined || chunk.endLine === undefined || chunk.endLine >= chunk.startLine, "invalid_argument", "Source chunk line range is invalid.");
  assertDomain(chunk.pageStart === undefined || chunk.pageEnd === undefined || chunk.pageEnd >= chunk.pageStart, "invalid_argument", "Source chunk page range is invalid.");
  assertDomain(Number.isSafeInteger(chunk.tokenEstimate) && chunk.tokenEstimate >= 0, "invalid_argument", "Source chunk token estimate must be non-negative.");
  assertNonBlank(chunk.tokenEstimatorVersion, "source chunk token estimator version", 128);
  assertIsoTimestamp(chunk.createdAt, "source chunk creation time");
  if (chunk.invalidatedAt !== undefined) assertIsoTimestamp(chunk.invalidatedAt, "source chunk invalidation time");
  parseJsonObject(chunk.metadata, "source chunk metadata");
}

function parseIndexedRetrievalSource(value: unknown): IndexedRetrievalSource {
  assertDomain(
    isRecord(value) && isString(value.id) && isString(value.connectorId) && isString(value.profileId) &&
      (value.projectId === undefined || isString(value.projectId)) && isOneOf(SOURCE_KINDS, value.kind) &&
      isString(value.displayName) && isString(value.sourceKeySha256) && (value.relativePath === undefined || isString(value.relativePath)) &&
      isOneOf(SOURCE_STATES, value.state) && isString(value.createdAt) && isString(value.updatedAt) &&
      (value.invalidatedAt === undefined || isString(value.invalidatedAt)) && isRecord(value.metadata),
    "invalid_argument",
    "Invalid indexed retrieval source payload.",
  );
  const source: IndexedRetrievalSource = {
    id: value.id.trim() as IndexedSourceId,
    connectorId: value.connectorId.trim(),
    profileId: value.profileId.trim() as ProfileId,
    ...(value.projectId === undefined ? {} : { projectId: value.projectId.trim() as ProjectId }),
    kind: value.kind,
    displayName: value.displayName.trim(),
    sourceKeySha256: value.sourceKeySha256.trim().toLowerCase(),
    ...(value.relativePath === undefined ? {} : { relativePath: value.relativePath.trim() }),
    state: value.state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.invalidatedAt === undefined ? {} : { invalidatedAt: value.invalidatedAt }),
    metadata: parseJsonObject(value.metadata, "indexed source metadata"),
  };
  validateIndexedRetrievalSource(source);
  return Object.freeze({ ...source, metadata: Object.freeze({ ...source.metadata }) });
}

function parseRetrievalSourceVersion(value: unknown): RetrievalSourceVersion {
  assertDomain(
    isRecord(value) && isString(value.id) && isString(value.sourceId) && typeof value.ordinal === "number" &&
      isString(value.contentSha256) && isString(value.mediaType) && typeof value.byteSize === "number" &&
      isString(value.extractorId) && isString(value.extractorVersion) && isString(value.createdAt) && isRecord(value.metadata) &&
      (value.supersededAt === undefined || isString(value.supersededAt)) && (value.invalidatedAt === undefined || isString(value.invalidatedAt)),
    "invalid_argument",
    "Invalid retrieval source version payload.",
  );
  const version: RetrievalSourceVersion = {
    id: value.id.trim() as FileVersionId,
    sourceId: value.sourceId.trim() as IndexedSourceId,
    ordinal: value.ordinal,
    contentSha256: value.contentSha256.trim().toLowerCase(),
    mediaType: value.mediaType.trim(),
    byteSize: value.byteSize,
    extractorId: value.extractorId.trim(),
    extractorVersion: value.extractorVersion.trim(),
    createdAt: value.createdAt,
    ...(value.supersededAt === undefined ? {} : { supersededAt: value.supersededAt }),
    ...(value.invalidatedAt === undefined ? {} : { invalidatedAt: value.invalidatedAt }),
    metadata: parseJsonObject(value.metadata, "source version metadata"),
  };
  validateRetrievalSourceVersion(version);
  return Object.freeze({ ...version, metadata: Object.freeze({ ...version.metadata }) });
}

function parseRetrievalSourceChunk(value: unknown): RetrievalSourceChunk {
  assertDomain(
    isRecord(value) && isString(value.id) && isString(value.sourceVersionId) && isString(value.sourceId) && isString(value.text) &&
      isString(value.contentSha256) && isString(value.sourceContentSha256) && typeof value.ordinal === "number" &&
      typeof value.startByte === "number" && typeof value.endByte === "number" && typeof value.tokenEstimate === "number" &&
      isString(value.tokenEstimatorVersion) && isString(value.createdAt) && isRecord(value.metadata) &&
      (value.startLine === undefined || typeof value.startLine === "number") && (value.endLine === undefined || typeof value.endLine === "number") &&
      (value.pageStart === undefined || typeof value.pageStart === "number") && (value.pageEnd === undefined || typeof value.pageEnd === "number") &&
      (value.invalidatedAt === undefined || isString(value.invalidatedAt)),
    "invalid_argument",
    "Invalid retrieval source chunk payload.",
  );
  const chunk: RetrievalSourceChunk = {
    id: value.id.trim() as SourceChunkId,
    sourceVersionId: value.sourceVersionId.trim() as FileVersionId,
    sourceId: value.sourceId.trim() as IndexedSourceId,
    ordinal: value.ordinal,
    text: value.text.trim(),
    contentSha256: value.contentSha256.trim().toLowerCase(),
    sourceContentSha256: value.sourceContentSha256.trim().toLowerCase(),
    startByte: value.startByte,
    endByte: value.endByte,
    ...(value.startLine === undefined ? {} : { startLine: value.startLine }),
    ...(value.endLine === undefined ? {} : { endLine: value.endLine }),
    ...(value.pageStart === undefined ? {} : { pageStart: value.pageStart }),
    ...(value.pageEnd === undefined ? {} : { pageEnd: value.pageEnd }),
    tokenEstimate: value.tokenEstimate,
    tokenEstimatorVersion: value.tokenEstimatorVersion.trim(),
    createdAt: value.createdAt,
    ...(value.invalidatedAt === undefined ? {} : { invalidatedAt: value.invalidatedAt }),
    metadata: parseJsonObject(value.metadata, "source chunk metadata"),
  };
  validateRetrievalSourceChunk(chunk);
  return Object.freeze({ ...chunk, metadata: Object.freeze({ ...chunk.metadata }) });
}

/** Creates an empty, renderer-safe retrieval catalog. */
export function createRetrievalCatalog(): RetrievalCatalog {
  return Object.freeze({ version: 1, connectors: Object.freeze([]), sources: Object.freeze([]), sourceVersions: Object.freeze([]), chunks: Object.freeze([]) });
}

export function registerRetrievalConnector(catalog: RetrievalCatalog, connector: RetrievalConnector): RetrievalCatalog {
  assertCatalog(catalog);
  const normalized = normalizeConnector(connector);
  assertDomain(!catalog.connectors.some((candidate) => candidate.id === normalized.id), "conflict", "Retrieval connector ID is already registered.");
  return Object.freeze({ ...catalog, connectors: Object.freeze([...catalog.connectors, normalized]) });
}

export function updateRetrievalConnector(catalog: RetrievalCatalog, connector: RetrievalConnector): RetrievalCatalog {
  assertCatalog(catalog);
  const normalized = normalizeConnector(connector);
  const index = catalog.connectors.findIndex((candidate) => candidate.id === normalized.id);
  assertDomain(index >= 0, "not_found", "Retrieval connector was not found.", { connectorId: normalized.id });
  const connectors = [...catalog.connectors];
  connectors[index] = normalized;
  return Object.freeze({ ...catalog, connectors: Object.freeze(connectors) });
}

export function setRetrievalConnectorEnabled(catalog: RetrievalCatalog, connectorId: string, enabled: boolean): RetrievalCatalog {
  assertCatalog(catalog);
  const connector = catalog.connectors.find((candidate) => candidate.id === connectorId);
  assertDomain(connector !== undefined, "not_found", "Retrieval connector was not found.", { connectorId });
  return updateRetrievalConnector(catalog, { ...connector, enabled, updatedAt: stamp() });
}

export function upsertIndexedRetrievalSource(catalog: RetrievalCatalog, source: IndexedRetrievalSource): RetrievalCatalog {
  assertCatalog(catalog);
  const sourceId = source.id.trim() as IndexedSourceId;
  const connectorId = source.connectorId.trim();
  const connector = catalog.connectors.find((candidate) => candidate.id === connectorId);
  assertDomain(connector !== undefined, "not_found", "Source connector was not found.", { connectorId: source.connectorId });
  validateIndexedRetrievalSource(source);
  const normalized = Object.freeze({
    ...source,
    id: sourceId,
    connectorId,
    profileId: source.profileId.trim() as ProfileId,
    ...(source.projectId === undefined ? {} : { projectId: source.projectId.trim() as ProjectId }),
    displayName: source.displayName.trim(),
    sourceKeySha256: source.sourceKeySha256.trim().toLowerCase(),
    ...(source.relativePath === undefined ? {} : { relativePath: source.relativePath.trim() }),
    metadata: Object.freeze({ ...source.metadata }),
  });
  const sources = catalog.sources.filter((candidate) => candidate.id !== sourceId);
  return Object.freeze({ ...catalog, sources: Object.freeze([...sources, normalized]) });
}

export function upsertRetrievalSourceVersion(catalog: RetrievalCatalog, version: RetrievalSourceVersion): RetrievalCatalog {
  assertCatalog(catalog);
  const versionId = version.id.trim() as FileVersionId;
  const sourceId = version.sourceId.trim() as IndexedSourceId;
  assertDomain(catalog.sources.some((source) => source.id === sourceId), "not_found", "Source version parent source was not found.", { sourceId: version.sourceId });
  validateRetrievalSourceVersion(version);
  assertDomain(!catalog.sourceVersions.some((candidate) => candidate.id !== versionId && candidate.sourceId === sourceId && candidate.ordinal === version.ordinal), "conflict", "Source version ordinal is already used for this source.", { sourceId: version.sourceId, ordinal: version.ordinal });
  const normalized = Object.freeze({
    ...version,
    id: versionId,
    sourceId,
    contentSha256: version.contentSha256.trim().toLowerCase(),
    mediaType: version.mediaType.trim(),
    extractorId: version.extractorId.trim(),
    extractorVersion: version.extractorVersion.trim(),
    metadata: Object.freeze({ ...version.metadata }),
  });
  const versions = catalog.sourceVersions.filter((candidate) => candidate.id !== versionId);
  return Object.freeze({ ...catalog, sourceVersions: Object.freeze([...versions, normalized]) });
}

export function upsertRetrievalSourceChunk(catalog: RetrievalCatalog, chunk: RetrievalSourceChunk): RetrievalCatalog {
  assertCatalog(catalog);
  const chunkId = chunk.id.trim() as SourceChunkId;
  const sourceVersionId = chunk.sourceVersionId.trim() as FileVersionId;
  const sourceId = chunk.sourceId.trim() as IndexedSourceId;
  const version = catalog.sourceVersions.find((candidate) => candidate.id === sourceVersionId);
  assertDomain(version !== undefined, "not_found", "Source chunk parent version was not found.", { sourceVersionId: chunk.sourceVersionId });
  assertDomain(version.sourceId === sourceId, "conflict", "Source chunk source does not match its version.");
  assertDomain(chunk.endByte <= version.byteSize, "invalid_argument", "Source chunk byte range exceeds its source version.", { sourceChunkId: chunk.id, sourceVersionId: version.id });
  validateRetrievalSourceChunk(chunk);
  assertDomain(!catalog.chunks.some((candidate) => candidate.id !== chunkId && candidate.sourceVersionId === sourceVersionId && candidate.ordinal === chunk.ordinal), "conflict", "Source chunk ordinal is already used for this source version.", { sourceVersionId: chunk.sourceVersionId, ordinal: chunk.ordinal });
  const normalized = Object.freeze({
    ...chunk,
    id: chunkId,
    sourceVersionId,
    sourceId,
    text: chunk.text.trim(),
    contentSha256: chunk.contentSha256.trim().toLowerCase(),
    sourceContentSha256: chunk.sourceContentSha256.trim().toLowerCase(),
    tokenEstimatorVersion: chunk.tokenEstimatorVersion.trim(),
    metadata: Object.freeze({ ...chunk.metadata }),
  });
  const chunks = catalog.chunks.filter((candidate) => candidate.id !== chunkId);
  return Object.freeze({ ...catalog, chunks: Object.freeze([...chunks, normalized]) });
}

function tokenize(value: string): readonly string[] {
  return Object.freeze([...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? [])]);
}

/** Deterministic lexical fallback used until native sparse/vector adapters are wired. */
export function searchRetrievalCatalog(catalog: RetrievalCatalog, query: string, options: RetrievalSearchOptions = {}): readonly RetrievalCandidate[] {
  assertCatalog(catalog);
  const normalizedQuery = assertNonBlank(query, "retrieval query", 16_000);
  const queryTerms = tokenize(normalizedQuery);
  assertDomain(queryTerms.length > 0, "invalid_argument", "Retrieval query must contain searchable terms.");
  const connectorFilter = options.connectorIds === undefined ? undefined : new Set(uniqueStrings(options.connectorIds, "connector ID"));
  const sourceKindFilter = options.sourceKinds === undefined ? undefined : new Set(options.sourceKinds);
  const minScore = options.minScore ?? 0;
  assertDomain(Number.isFinite(minScore) && minScore >= 0 && minScore <= 1, "invalid_argument", "Minimum retrieval score must be between zero and one.");
  const limit = options.limit ?? 20;
  assertDomain(Number.isSafeInteger(limit) && limit > 0 && limit <= 1_000, "invalid_argument", "Retrieval result limit must be between one and one thousand.");
  const connectors = new Map(catalog.connectors.map((connector) => [connector.id, connector]));
  const sources = new Map(catalog.sources.map((source) => [source.id, source]));
  const versions = new Map(catalog.sourceVersions.map((version) => [version.id, version]));
  const candidates: RetrievalCandidate[] = [];
  for (const chunk of catalog.chunks) {
    const source = sources.get(chunk.sourceId);
    const connector = source === undefined ? undefined : connectors.get(source.connectorId);
    const version = versions.get(chunk.sourceVersionId);
    if (source === undefined || connector === undefined || version === undefined || version.sourceId !== source.id) continue;
    if (!connector.enabled || source.state !== "active" || chunk.invalidatedAt !== undefined) continue;
    if (version.supersededAt !== undefined || version.invalidatedAt !== undefined) continue;
    if (connectorFilter !== undefined && !connectorFilter.has(connector.id)) continue;
    if (sourceKindFilter !== undefined && !sourceKindFilter.has(source.kind)) continue;
    if (options.profileId !== undefined && source.profileId !== options.profileId) continue;
    // A project query may consume global sources, but it must not consume a
    // different project's source. A profile-scoped query without a project is
    // limited to global sources so callers cannot accidentally broaden a
    // private conversation to every indexed project.
    if (source.projectId !== undefined) {
      if (options.projectId !== undefined && source.projectId !== options.projectId) continue;
      if (options.projectId === undefined && options.profileId !== undefined) continue;
    }
    const textTerms = tokenize(`${source.displayName} ${source.relativePath ?? ""} ${chunk.text}`);
    const termSet = new Set(textTerms);
    const matchedTerms = queryTerms.filter((term) => termSet.has(term));
    if (matchedTerms.length === 0) continue;
    const coverage = matchedTerms.length / queryTerms.length;
    const phraseBoost = chunk.text.toLocaleLowerCase().includes(normalizedQuery.toLocaleLowerCase()) ? 0.25 : 0;
    const titleBoost = `${source.displayName} ${source.relativePath ?? ""}`.toLocaleLowerCase().includes(queryTerms[0] ?? "") ? 0.1 : 0;
    const score = Math.min(1, coverage * 0.65 + phraseBoost + titleBoost);
    if (score < minScore) continue;
    candidates.push({ chunk, source, connector, score, matchedTerms: Object.freeze(matchedTerms), rank: 0 });
  }
  candidates.sort((left, right) => right.score - left.score || left.chunk.ordinal - right.chunk.ordinal || left.chunk.id.localeCompare(right.chunk.id));
  return Object.freeze(candidates.slice(0, limit).map((candidate, index) => Object.freeze({ ...candidate, rank: index + 1 })));
}

export interface BuildRetrievalSnapshotInput {
  readonly id: RetrievalSnapshotId;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly runId?: RunId;
  readonly query: string;
  readonly querySha256: string;
  readonly retrieverVersion: string;
  readonly tokenBudget: number;
  readonly candidates: readonly RetrievalCandidate[];
  readonly now: IsoTimestamp;
}

/** Creates a building snapshot while retaining selected and omitted candidates. */
export function buildRetrievalSnapshot(input: BuildRetrievalSnapshotInput): RetrievalSnapshot {
  assertNonBlank(input.id, "retrieval snapshot ID", 256);
  assertNonBlank(input.retrieverVersion, "retriever version", 128);
  assertNonBlank(input.query, "retrieval query", 16_000);
  assertSha256(input.querySha256, "retrieval query hash");
  assertDomain(Number.isSafeInteger(input.tokenBudget) && input.tokenBudget > 0, "invalid_argument", "Retrieval token budget must be positive.");
  assertIsoTimestamp(input.now, "retrieval snapshot creation time");
  const seenContent = new Set<string>();
  let consumedTokens = 0;
  const items: RetrievalSnapshotItem[] = [];
  const selectedSourceIds = new Set<IndexedSourceId>();
  for (const [index, candidate] of input.candidates.entries()) {
    const scorePpm = Math.max(0, Math.min(1_000_000, Math.round(candidate.score * 1_000_000)));
    const base = {
      snapshotId: input.id,
      sourceChunkId: candidate.chunk.id,
      ordinal: index,
      tokenEstimate: candidate.chunk.tokenEstimate,
      chunkContentSha256: candidate.chunk.contentSha256,
    };
    if (seenContent.has(candidate.chunk.contentSha256)) {
      items.push(Object.freeze({ ...base, disposition: "omitted", reason: "duplicate", scorePpm }));
      continue;
    }
    if (consumedTokens + candidate.chunk.tokenEstimate > input.tokenBudget) {
      items.push(Object.freeze({ ...base, disposition: "omitted", reason: "budget", scorePpm }));
      continue;
    }
    seenContent.add(candidate.chunk.contentSha256);
    consumedTokens += candidate.chunk.tokenEstimate;
    selectedSourceIds.add(candidate.source.id);
    items.push(Object.freeze({ ...base, disposition: "selected", reason: "selected", rank: candidate.rank, scorePpm }));
  }
  const selectedCount = items.filter((item) => item.disposition === "selected").length;
  return Object.freeze({
    version: 1,
    id: input.id,
    profileId: input.profileId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    query: input.query.trim(),
    querySha256: input.querySha256,
    retrieverVersion: input.retrieverVersion.trim(),
    tokenBudget: input.tokenBudget,
    consumedTokens,
    state: "building",
    items: Object.freeze(items),
    createdAt: input.now,
    stats: Object.freeze({ candidateCount: input.candidates.length, selectedCount, omittedCount: items.length - selectedCount, distinctSourceCount: selectedSourceIds.size }),
  });
}

export function freezeRetrievalSnapshot(snapshot: RetrievalSnapshot, at: IsoTimestamp, snapshotSha256: string): RetrievalSnapshot {
  assertDomain(snapshot.state === "building", "invalid_state_transition", "Only a building retrieval snapshot can be frozen.");
  assertIsoTimestamp(at, "retrieval snapshot freeze time");
  assertSha256(snapshotSha256, "retrieval snapshot hash");
  assertDomain(Date.parse(at) >= Date.parse(snapshot.createdAt), "invalid_argument", "Retrieval snapshot freeze time cannot precede creation time.");
  return Object.freeze({ ...snapshot, state: "frozen", frozenAt: at, snapshotSha256 });
}

export function invalidateRetrievalSnapshot(snapshot: RetrievalSnapshot, at: IsoTimestamp): RetrievalSnapshot {
  assertDomain(snapshot.state !== "invalidated", "invalid_state_transition", "Retrieval snapshot is already invalidated.");
  assertIsoTimestamp(at, "retrieval snapshot invalidation time");
  return Object.freeze({ ...snapshot, state: "invalidated", invalidatedAt: at });
}

export function createRetrievalCitation(snapshot: RetrievalSnapshot, candidate: RetrievalCandidate, id: CitationId, at: IsoTimestamp, label?: string): RetrievalCitation {
  assertDomain(snapshot.state === "frozen", "invalid_state_transition", "Citations require a frozen retrieval snapshot.");
  assertIsoTimestamp(at, "retrieval citation creation time");
  const item = snapshot.items.find((entry) => entry.sourceChunkId === candidate.chunk.id && entry.disposition === "selected");
  assertDomain(item !== undefined, "not_found", "Citation candidate is not selected in the retrieval snapshot.", { sourceChunkId: candidate.chunk.id });
  const excerpt = candidate.chunk.text.trim();
  assertDomain(excerpt.length > 0, "invalid_argument", "Citation excerpt cannot be empty.");
  return Object.freeze({ id, snapshotId: snapshot.id, sourceChunkId: candidate.chunk.id, sourceId: candidate.source.id, label: (label ?? candidate.source.displayName).trim(), excerpt, startByte: candidate.chunk.startByte, endByte: candidate.chunk.endByte, createdAt: at });
}

function parseConnector(value: unknown): RetrievalConnector {
  assertDomain(isRecord(value) && isString(value.id) && isString(value.label) && isOneOf(CONNECTOR_KINDS, value.kind) && isString(value.version) && Array.isArray(value.capabilities) && value.capabilities.every((capability) => isOneOf(CAPABILITIES, capability)) && typeof value.enabled === "boolean" && value.readOnly === true && (value.scope === "local" || value.scope === "project" || value.scope === "profile" || value.scope === "remote") && isString(value.updatedAt) && isRecord(value.metadata), "invalid_argument", "Invalid retrieval connector payload.");
  return normalizeConnector({ id: value.id, label: value.label, kind: value.kind, version: value.version, capabilities: value.capabilities, enabled: value.enabled, readOnly: true, scope: value.scope, updatedAt: value.updatedAt, metadata: parseJsonObject(value.metadata, "retrieval connector metadata") });
}

/** JSON boundary for persistence/import. Unknown or malformed records are rejected. */
export function deserializeRetrievalCatalog(input: string | unknown): RetrievalCatalog {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  assertDomain(isRecord(value) && value.version === 1 && Array.isArray(value.connectors) && Array.isArray(value.sources) && Array.isArray(value.sourceVersions) && Array.isArray(value.chunks), "invalid_argument", "Invalid retrieval catalog payload.");
  const catalog: RetrievalCatalog = Object.freeze({
    version: 1,
    connectors: Object.freeze(value.connectors.map(parseConnector)),
    sources: Object.freeze(value.sources.map(parseIndexedRetrievalSource)),
    sourceVersions: Object.freeze(value.sourceVersions.map(parseRetrievalSourceVersion)),
    chunks: Object.freeze(value.chunks.map(parseRetrievalSourceChunk)),
  });
  assertCatalog(catalog);
  return catalog;
}

export function serializeRetrievalCatalog(catalog: RetrievalCatalog): string {
  assertCatalog(catalog);
  return JSON.stringify(catalog, null, 2);
}

export function serializeRetrievalSnapshot(snapshot: RetrievalSnapshot): string {
  assertDomain(snapshot.version === 1, "invalid_argument", "Unsupported retrieval snapshot version.");
  return JSON.stringify(snapshot, null, 2);
}

function parseSnapshotItem(value: unknown, snapshotId: RetrievalSnapshotId): RetrievalSnapshotItem {
  assertDomain(
    isRecord(value) &&
      value.snapshotId === snapshotId &&
      isString(value.sourceChunkId) &&
      typeof value.ordinal === "number" &&
      Number.isSafeInteger(value.ordinal) &&
      value.ordinal >= 0 &&
      (value.disposition === "selected" || value.disposition === "omitted") &&
      isString(value.reason) &&
      typeof value.tokenEstimate === "number" &&
      Number.isSafeInteger(value.tokenEstimate) &&
      value.tokenEstimate >= 0 &&
      isString(value.chunkContentSha256),
    "invalid_argument",
    "Invalid retrieval snapshot item payload.",
  );
  assertSha256(value.chunkContentSha256, "retrieval snapshot chunk hash");
  const rank = value.rank;
  const scorePpm = value.scorePpm;
  assertDomain(
    rank === undefined || (typeof rank === "number" && Number.isSafeInteger(rank) && rank >= 1),
    "invalid_argument",
    "Retrieval snapshot item rank must be a positive integer when provided.",
  );
  assertDomain(
    scorePpm === undefined || (typeof scorePpm === "number" && Number.isSafeInteger(scorePpm) && scorePpm >= 0 && scorePpm <= 1_000_000),
    "invalid_argument",
    "Retrieval snapshot item score must be between zero and one million when provided.",
  );
  assertDomain(
    value.disposition === "selected" ? rank !== undefined : rank === undefined,
    "invalid_argument",
    "Selected retrieval items require a rank and omitted items cannot have one.",
  );
  return Object.freeze({
    snapshotId,
    sourceChunkId: value.sourceChunkId as SourceChunkId,
    ordinal: value.ordinal,
    disposition: value.disposition,
    reason: value.reason,
    ...(rank === undefined ? {} : { rank }),
    ...(scorePpm === undefined ? {} : { scorePpm }),
    tokenEstimate: value.tokenEstimate,
    chunkContentSha256: value.chunkContentSha256,
  });
}

/** Reads a durable snapshot without treating it as executable retrieval state. */
export function deserializeRetrievalSnapshot(input: string | unknown): RetrievalSnapshot {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  assertDomain(
    isRecord(value) &&
      value.version === 1 &&
      isString(value.id) &&
      isString(value.profileId) &&
      isString(value.query) &&
      isString(value.querySha256) &&
      isString(value.retrieverVersion) &&
      typeof value.tokenBudget === "number" &&
      typeof value.consumedTokens === "number" &&
      isOneOf(SNAPSHOT_STATES, value.state) &&
      Array.isArray(value.items) &&
      isString(value.createdAt) &&
      isRecord(value.stats),
    "invalid_argument",
    "Invalid retrieval snapshot payload.",
  );
  assertSha256(value.querySha256, "retrieval query hash");
  assertIsoTimestamp(value.createdAt, "retrieval snapshot creation time");
  assertDomain(Number.isSafeInteger(value.tokenBudget) && value.tokenBudget > 0, "invalid_argument", "Retrieval token budget must be positive.");
  assertDomain(Number.isSafeInteger(value.consumedTokens) && value.consumedTokens >= 0 && value.consumedTokens <= value.tokenBudget, "invalid_argument", "Retrieval consumed tokens exceed the budget.");
  const snapshotId = value.id as RetrievalSnapshotId;
  const items = Object.freeze(value.items.map((item) => parseSnapshotItem(item, snapshotId)));
  const frozenAt = value.frozenAt;
  const invalidatedAt = value.invalidatedAt;
  const snapshotSha256 = value.snapshotSha256;
  if (frozenAt !== undefined) assertIsoTimestamp(frozenAt as string, "retrieval snapshot freeze time");
  if (invalidatedAt !== undefined) assertIsoTimestamp(invalidatedAt as string, "retrieval snapshot invalidation time");
  if (snapshotSha256 !== undefined) assertSha256(snapshotSha256 as string, "retrieval snapshot hash");
  assertDomain(
    value.state === "frozen" ? frozenAt !== undefined && snapshotSha256 !== undefined : true,
    "invalid_argument",
    "Frozen retrieval snapshots require freeze time and a snapshot hash.",
  );
  assertDomain(
    value.state === "invalidated" ? invalidatedAt !== undefined : true,
    "invalid_argument",
    "Invalidated retrieval snapshots require invalidation time.",
  );
  const statsValue = value.stats;
  assertDomain(
    typeof statsValue.candidateCount === "number" && Number.isSafeInteger(statsValue.candidateCount) && statsValue.candidateCount >= 0 &&
      typeof statsValue.selectedCount === "number" && Number.isSafeInteger(statsValue.selectedCount) && statsValue.selectedCount >= 0 &&
      typeof statsValue.omittedCount === "number" && Number.isSafeInteger(statsValue.omittedCount) && statsValue.omittedCount >= 0 &&
      typeof statsValue.distinctSourceCount === "number" && Number.isSafeInteger(statsValue.distinctSourceCount) && statsValue.distinctSourceCount >= 0,
    "invalid_argument",
    "Invalid retrieval snapshot statistics.",
  );
  return Object.freeze({
    version: 1,
    id: snapshotId,
    profileId: value.profileId as ProfileId,
    ...(typeof value.projectId === "string" ? { projectId: value.projectId as ProjectId } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId as RunId } : {}),
    query: value.query,
    querySha256: value.querySha256,
    retrieverVersion: value.retrieverVersion,
    tokenBudget: value.tokenBudget,
    consumedTokens: value.consumedTokens,
    state: value.state,
    items,
    createdAt: value.createdAt,
    ...(typeof frozenAt === "string" ? { frozenAt } : {}),
    ...(typeof invalidatedAt === "string" ? { invalidatedAt } : {}),
    ...(typeof snapshotSha256 === "string" ? { snapshotSha256 } : {}),
    stats: Object.freeze({
      candidateCount: statsValue.candidateCount,
      selectedCount: statsValue.selectedCount,
      omittedCount: statsValue.omittedCount,
      distinctSourceCount: statsValue.distinctSourceCount,
    }),
  });
}

export function isRetrievalOmissionReason(value: string): value is RetrievalOmissionReason {
  return OMIT_REASONS.includes(value as RetrievalOmissionReason);
}

export function isRetrievalSnapshotState(value: string): value is RetrievalSnapshotState {
  return SNAPSHOT_STATES.includes(value as RetrievalSnapshotState);
}
