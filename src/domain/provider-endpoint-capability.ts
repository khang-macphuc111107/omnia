import { assertDomain } from "./errors";
import { assertIsoTimestamp, assertNonBlank, assertSha256, type IsoTimestamp } from "./shared";

/**
 * Provider endpoint capability snapshots are native-owned evidence, not a
 * renderer-side list of what a provider brand is expected to support.  The
 * shape mirrors `docs/omnia-ultra/schemas/provider-endpoint-capability.schema.json`
 * and adds the cross-field invariants that JSON Schema alone cannot express.
 */

export const PROVIDER_PROTOCOL_FAMILIES = [
  "openai-responses",
  "openai-chat-completions",
  "openai-completions",
  "openai-compatible",
  "anthropic-messages",
  "anthropic-compatible",
  "google-gemini",
  "ollama-native",
  "lmstudio-native",
  "llama-cpp",
  "vllm",
  "tgi",
  "litellm",
  "custom",
] as const;

export type ProviderProtocolFamily = (typeof PROVIDER_PROTOCOL_FAMILIES)[number];

export const PROVIDER_OPERATIONS = [
  "responses",
  "chat-completions",
  "completions",
  "messages",
  "generate-content",
  "stream-content",
  "live",
  "embeddings",
  "rerank",
  "token-count",
  "models",
  "files",
  "batches",
  "realtime",
  "audio",
  "images",
  "video",
  "moderation",
  "vector-store",
  "fine-tuning",
  "usage",
  "custom",
] as const;

export type ProviderEndpointOperation = (typeof PROVIDER_OPERATIONS)[number];

export const PROVIDER_TRANSPORTS = [
  "http",
  "sse",
  "websocket",
  "polling",
  "webhook",
  "local-ipc",
] as const;

export type ProviderEndpointTransport = (typeof PROVIDER_TRANSPORTS)[number];

export const PROVIDER_AUTH_SCHEMES = [
  "none",
  "bearer",
  "api-key-header",
  "query-key",
  "oauth2",
  "aws-sigv4",
  "azure",
  "custom",
] as const;

export type ProviderEndpointAuthScheme = (typeof PROVIDER_AUTH_SCHEMES)[number];

export const PROVIDER_ENDPOINT_MODALITIES = [
  "text",
  "image",
  "audio",
  "video",
  "embedding",
  "reranking",
  "tool",
  "file",
] as const;

export type ProviderEndpointModality = (typeof PROVIDER_ENDPOINT_MODALITIES)[number];

export const PROVIDER_CAPABILITY_MODALITIES = [
  "text",
  "image",
  "audio",
  "video",
  "pdf",
  "document",
  "spreadsheet",
  "archive",
  "code",
  "structured-data",
  "scientific-artifact",
  "embedding",
  "reranking",
  "tool",
  "file",
] as const;

export type ProviderCapabilityModality = (typeof PROVIDER_CAPABILITY_MODALITIES)[number];

export const PROVIDER_CAPABILITY_DIRECTIONS = [
  "input",
  "output",
  "analysis",
  "generation",
  "bidirectional",
] as const;

export type ProviderCapabilityDirection = (typeof PROVIDER_CAPABILITY_DIRECTIONS)[number];

export const PROVIDER_SUPPORT_LEVELS = [
  "documented-native",
  "model-gated",
  "adapter-gated",
  "bridge-required",
  "unsupported",
  "unknown",
] as const;

export type ProviderCapabilitySupportLevel = (typeof PROVIDER_SUPPORT_LEVELS)[number];

export const PROVIDER_MODEL_SCOPES = [
  "all-advertised",
  "model-family",
  "model-snapshot",
  "runtime-profile",
  "backend-model",
  "none",
  "unknown",
] as const;

export type ProviderCapabilityModelScope = (typeof PROVIDER_MODEL_SCOPES)[number];

export const PROVIDER_CARRIER_FORMATS = [
  "inline-data",
  "url",
  "provider-file-id",
  "multipart",
  "content-block",
  "realtime-frame",
  "server-path",
  "tool-result",
  "custom",
] as const;

export type ProviderCapabilityCarrierFormat = (typeof PROVIDER_CARRIER_FORMATS)[number];

export const PROVIDER_MIME_FAMILIES = [
  "text",
  "image",
  "audio",
  "video",
  "pdf",
  "office",
  "spreadsheet",
  "archive",
  "code",
  "structured-data",
  "scientific",
  "other",
] as const;

export type ProviderCapabilityMimeFamily = (typeof PROVIDER_MIME_FAMILIES)[number];

export const PROVIDER_FIDELITY_PROFILES = [
  "semantic-and-visual",
  "semantic-only",
  "render-required",
  "model-specific",
  "not-applicable",
  "unknown",
] as const;

export type ProviderCapabilityFidelity = (typeof PROVIDER_FIDELITY_PROFILES)[number];

export const PROVIDER_PROBE_REQUIREMENTS = [
  "not-required",
  "recommended",
  "required",
  "not-permitted",
] as const;

export type ProviderCapabilityProbeRequirement = (typeof PROVIDER_PROBE_REQUIREMENTS)[number];

export const PROVIDER_EVIDENCE_KINDS = [
  "official-documentation",
  "model-registry",
  "capability-probe",
  "adapter-fixture",
  "user-override",
] as const;

export type ProviderCapabilityEvidenceKind = (typeof PROVIDER_EVIDENCE_KINDS)[number];

export const PROVIDER_USAGE_AUTHORITIES = [
  "none",
  "estimated",
  "provider-incremental",
  "provider-final",
  "invoice",
] as const;

export type ProviderUsageAuthority = (typeof PROVIDER_USAGE_AUTHORITIES)[number];

export const PROVIDER_CAPABILITY_FRESHNESS = [
  "live-probe",
  "cached-fresh",
  "cached-stale",
  "manual",
  "unknown",
] as const;

export type ProviderCapabilityFreshness = (typeof PROVIDER_CAPABILITY_FRESHNESS)[number];

export interface ProviderCapabilityConstraints {
  readonly maxBytes?: number | null;
  readonly maxItems?: number | null;
  readonly maxPages?: number | null;
  readonly maxDurationSeconds?: number | null;
  readonly maxWidth?: number | null;
  readonly maxHeight?: number | null;
  readonly notes?: string | null;
}

export interface ProviderCapabilityEvidence {
  readonly kind: ProviderCapabilityEvidenceKind;
  readonly reference: string;
  readonly retrievedAt: IsoTimestamp;
  readonly contentHash?: string | null;
  readonly expiresAt?: IsoTimestamp | null;
}

export interface ProviderOperationCapability {
  readonly operation: ProviderEndpointOperation;
  readonly direction: ProviderCapabilityDirection;
  readonly modality: ProviderCapabilityModality;
  readonly supportLevel: ProviderCapabilitySupportLevel;
  readonly modelScope: ProviderCapabilityModelScope;
  readonly modelSelectors?: readonly string[];
  readonly carrierFormats: readonly ProviderCapabilityCarrierFormat[];
  readonly mimeFamilies: readonly ProviderCapabilityMimeFamily[];
  readonly fidelity: ProviderCapabilityFidelity;
  readonly probeRequirement: ProviderCapabilityProbeRequirement;
  readonly constraints?: ProviderCapabilityConstraints;
  readonly evidence: readonly ProviderCapabilityEvidence[];
}

export interface ProviderEndpointCapabilitySnapshot {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly providerProfileRevisionId: string;
  readonly adapterRevision: string;
  readonly protocolFamily: ProviderProtocolFamily;
  readonly apiVersion: string;
  readonly baseUrlHash?: string;
  readonly operations: readonly ProviderEndpointOperation[];
  readonly transports: readonly ProviderEndpointTransport[];
  readonly authSchemes: readonly ProviderEndpointAuthScheme[];
  readonly modalities?: readonly ProviderEndpointModality[];
  readonly operationCapabilities?: readonly ProviderOperationCapability[];
  readonly parameterSchemaId: string | null;
  readonly errorPolicyRevisionId: string;
  readonly usageAuthority?: ProviderUsageAuthority;
  readonly freshness: ProviderCapabilityFreshness;
  readonly createdAt: IsoTimestamp;
}

export interface ProviderCapabilityMatchQuery {
  readonly operation: ProviderEndpointOperation;
  readonly modality?: ProviderCapabilityModality;
  readonly modelId?: string;
  readonly carrierFormat?: ProviderCapabilityCarrierFormat;
  readonly mimeFamily?: ProviderCapabilityMimeFamily;
}

const MAX_ID_BYTES = 512;
const MAX_REVISION_BYTES = 256;
const MAX_API_VERSION_BYTES = 128;
const MAX_REFERENCE_BYTES = 2_048;
const MAX_SELECTOR_BYTES = 512;
const MAX_CAPABILITIES = 2_000;

function assertEnum<T extends string>(value: string, allowed: readonly T[], label: string): T {
  assertDomain(
    (allowed as readonly string[]).includes(value),
    "invalid_argument",
    `${label} is not a supported provider capability value.`,
    { label, value },
  );
  return value as T;
}

function uniqueStrings(values: readonly string[], label: string, maxItems = 256): readonly string[] {
  assertDomain(Array.isArray(values), "invalid_argument", `${label} must be an array.`);
  assertDomain(values.length <= maxItems, "invalid_argument", `${label} is too large.`, { label, maxItems });
  const normalized = values.map((value) => assertNonBlank(value, `${label} item`, MAX_SELECTOR_BYTES));
  assertDomain(new Set(normalized).size === normalized.length, "invalid_argument", `${label} must be unique.`);
  return Object.freeze([...normalized]);
}

function boundedEnumArray<T extends string>(
  values: readonly string[],
  allowed: readonly T[],
  label: string,
): readonly T[] {
  const normalized = uniqueStrings(values, label, 128).map((value) => assertEnum(value, allowed, `${label} item`));
  assertDomain(normalized.length > 0, "invalid_argument", `${label} cannot be empty.`);
  return Object.freeze(normalized);
}

function assertBoundedNumber(value: number | null | undefined, label: string, allowFraction: boolean): number | null | undefined {
  if (value === undefined || value === null) return value;
  assertDomain(Number.isFinite(value), "invalid_argument", `${label} must be finite.`);
  assertDomain(value >= 0, "invalid_argument", `${label} cannot be negative.`);
  assertDomain(allowFraction || Number.isSafeInteger(value), "invalid_argument", `${label} must be a safe integer.`);
  return value;
}

function normalizeConstraints(value: ProviderCapabilityConstraints | undefined): ProviderCapabilityConstraints | undefined {
  if (value === undefined) return undefined;
  const maxBytes = assertBoundedNumber(value.maxBytes, "maxBytes", false);
  const maxItems = assertBoundedNumber(value.maxItems, "maxItems", false);
  const maxPages = assertBoundedNumber(value.maxPages, "maxPages", false);
  const maxDurationSeconds = assertBoundedNumber(value.maxDurationSeconds, "maxDurationSeconds", true);
  const maxWidth = assertBoundedNumber(value.maxWidth, "maxWidth", false);
  const maxHeight = assertBoundedNumber(value.maxHeight, "maxHeight", false);
  const notes = value.notes === undefined || value.notes === null
    ? value.notes
    : assertNonBlank(value.notes, "constraint notes", 4_096);
  const result: ProviderCapabilityConstraints = {
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(maxItems === undefined ? {} : { maxItems }),
    ...(maxPages === undefined ? {} : { maxPages }),
    ...(maxDurationSeconds === undefined ? {} : { maxDurationSeconds }),
    ...(maxWidth === undefined ? {} : { maxWidth }),
    ...(maxHeight === undefined ? {} : { maxHeight }),
    ...(notes === undefined ? {} : { notes }),
  };
  return Object.freeze(result);
}

function normalizeEvidence(evidence: readonly ProviderCapabilityEvidence[]): readonly ProviderCapabilityEvidence[] {
  assertDomain(evidence.length > 0, "invalid_argument", "A capability claim requires at least one evidence record.");
  const references = new Set<string>();
  const normalized = evidence.map((entry) => {
    const kind = assertEnum(entry.kind, PROVIDER_EVIDENCE_KINDS, "evidence kind");
    const reference = assertNonBlank(entry.reference, "evidence reference", MAX_REFERENCE_BYTES);
    assertDomain(!references.has(reference), "invalid_argument", "Evidence references must be unique within a capability claim.");
    references.add(reference);
    assertIsoTimestamp(entry.retrievedAt, "evidence retrievedAt");
    const contentHash = entry.contentHash === undefined || entry.contentHash === null
      ? entry.contentHash
      : assertSha256(entry.contentHash, "evidence contentHash");
    const expiresAt = entry.expiresAt === undefined || entry.expiresAt === null
      ? entry.expiresAt
      : assertIsoTimestamp(entry.expiresAt, "evidence expiresAt");
    if (expiresAt !== undefined && expiresAt !== null) {
      assertDomain(Date.parse(expiresAt) > Date.parse(entry.retrievedAt), "invalid_argument", "Evidence expiry must follow retrieval time.");
    }
    return Object.freeze({
      kind,
      reference,
      retrievedAt: entry.retrievedAt,
      ...(contentHash === undefined ? {} : { contentHash }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
  });
  return Object.freeze(normalized);
}

function normalizeCapability(entry: ProviderOperationCapability, operations: ReadonlySet<string>): ProviderOperationCapability {
  const operation = assertEnum(entry.operation, PROVIDER_OPERATIONS, "capability operation");
  assertDomain(operations.has(operation), "invalid_argument", "A capability claim must reference an operation declared by its endpoint snapshot.", { operation });
  const direction = assertEnum(entry.direction, PROVIDER_CAPABILITY_DIRECTIONS, "capability direction");
  const modality = assertEnum(entry.modality, PROVIDER_CAPABILITY_MODALITIES, "capability modality");
  const supportLevel = assertEnum(entry.supportLevel, PROVIDER_SUPPORT_LEVELS, "capability support level");
  const modelScope = assertEnum(entry.modelScope, PROVIDER_MODEL_SCOPES, "capability model scope");
  const modelSelectors = entry.modelSelectors === undefined ? undefined : uniqueStrings(entry.modelSelectors, "model selectors", 256);
  const modelScoped = ["model-family", "model-snapshot", "runtime-profile", "backend-model"].includes(modelScope);
  assertDomain(!modelScoped || (modelSelectors !== undefined && modelSelectors.length > 0), "invalid_argument", "Model-scoped capability claims require at least one model selector.", { modelScope });
  assertDomain(modelScope !== "none" || modelSelectors === undefined || modelSelectors.length === 0, "invalid_argument", "A capability with modelScope=none cannot carry model selectors.");
  const carrierFormats = boundedEnumArray(entry.carrierFormats, PROVIDER_CARRIER_FORMATS, "carrier formats");
  const mimeFamilies = boundedEnumArray(entry.mimeFamilies, PROVIDER_MIME_FAMILIES, "MIME families");
  const fidelity = assertEnum(entry.fidelity, PROVIDER_FIDELITY_PROFILES, "capability fidelity");
  const probeRequirement = assertEnum(entry.probeRequirement, PROVIDER_PROBE_REQUIREMENTS, "probe requirement");
  const constraints = normalizeConstraints(entry.constraints);
  const evidence = normalizeEvidence(entry.evidence);
  return Object.freeze({
    operation,
    direction,
    modality,
    supportLevel,
    modelScope,
    ...(modelSelectors === undefined ? {} : { modelSelectors }),
    carrierFormats,
    mimeFamilies,
    fidelity,
    probeRequirement,
    ...(constraints === undefined ? {} : { constraints }),
    evidence,
  });
}

function assertProtocolOperationCompatibility(protocolFamily: ProviderProtocolFamily, operations: ReadonlySet<string>): void {
  const requiredOperation = protocolFamily === "openai-responses"
    ? "responses"
    : protocolFamily === "openai-chat-completions"
      ? "chat-completions"
      : protocolFamily === "openai-completions"
        ? "completions"
        : protocolFamily === "anthropic-messages"
          ? "messages"
          : protocolFamily === "google-gemini"
            ? (operations.has("generate-content") || operations.has("stream-content") ? undefined : "generate-content")
            : undefined;
  if (requiredOperation !== undefined) {
    assertDomain(operations.has(requiredOperation), "invalid_argument", "The endpoint protocol family must declare its native operation.", { protocolFamily, requiredOperation });
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child !== null && typeof child === "object") deepFreeze(child);
  }
  return Object.freeze(value);
}

/**
 * Validates and returns a deeply immutable capability snapshot.  This is
 * intentionally a pure contract helper; it does not probe a provider, persist
 * a snapshot, or grant dispatch authority by itself.
 */
export function validateProviderEndpointCapabilitySnapshot(
  input: ProviderEndpointCapabilitySnapshot,
): ProviderEndpointCapabilitySnapshot {
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Unsupported provider capability schema version.");
  const snapshotId = assertNonBlank(input.snapshotId, "capability snapshot ID", MAX_ID_BYTES);
  const providerProfileRevisionId = assertNonBlank(input.providerProfileRevisionId, "provider profile revision ID", MAX_REVISION_BYTES);
  const adapterRevision = assertNonBlank(input.adapterRevision, "adapter revision", MAX_REVISION_BYTES);
  const protocolFamily = assertEnum(input.protocolFamily, PROVIDER_PROTOCOL_FAMILIES, "protocol family");
  const apiVersion = assertNonBlank(input.apiVersion, "provider API version", MAX_API_VERSION_BYTES);
  const baseUrlHash = input.baseUrlHash === undefined ? undefined : assertSha256(input.baseUrlHash, "provider base URL hash");
  const operations = boundedEnumArray(input.operations, PROVIDER_OPERATIONS, "endpoint operations");
  const operationSet = new Set(operations);
  assertProtocolOperationCompatibility(protocolFamily, operationSet);
  const transports = boundedEnumArray(input.transports, PROVIDER_TRANSPORTS, "endpoint transports");
  const authSchemes = boundedEnumArray(input.authSchemes, PROVIDER_AUTH_SCHEMES, "endpoint auth schemes");
  const modalities = input.modalities === undefined ? undefined : boundedEnumArray(input.modalities, PROVIDER_ENDPOINT_MODALITIES, "endpoint modalities");
  const rawCapabilities = input.operationCapabilities ?? [];
  assertDomain(rawCapabilities.length <= MAX_CAPABILITIES, "invalid_argument", "Endpoint capability snapshot contains too many operation claims.");
  const capabilities = rawCapabilities.map((entry) => normalizeCapability(entry, operationSet));
  const keys = capabilities.map((entry) => JSON.stringify([entry.operation, entry.direction, entry.modality, entry.modelScope, entry.modelSelectors ?? [], entry.carrierFormats, entry.mimeFamilies]));
  assertDomain(new Set(keys).size === keys.length, "invalid_argument", "Operation capability claims must be unique.");
  const parameterSchemaId = input.parameterSchemaId === null ? null : assertNonBlank(input.parameterSchemaId, "parameter schema ID", MAX_REVISION_BYTES);
  const errorPolicyRevisionId = assertNonBlank(input.errorPolicyRevisionId, "error policy revision ID", MAX_REVISION_BYTES);
  const usageAuthority = input.usageAuthority === undefined ? undefined : assertEnum(input.usageAuthority, PROVIDER_USAGE_AUTHORITIES, "usage authority");
  const freshness = assertEnum(input.freshness, PROVIDER_CAPABILITY_FRESHNESS, "capability freshness");
  assertIsoTimestamp(input.createdAt, "capability snapshot createdAt");
  return deepFreeze({
    schemaVersion: 1,
    snapshotId,
    providerProfileRevisionId,
    adapterRevision,
    protocolFamily,
    apiVersion,
    ...(baseUrlHash === undefined ? {} : { baseUrlHash }),
    operations,
    transports,
    authSchemes,
    ...(modalities === undefined ? {} : { modalities }),
    operationCapabilities: Object.freeze(capabilities),
    parameterSchemaId,
    errorPolicyRevisionId,
    ...(usageAuthority === undefined ? {} : { usageAuthority }),
    freshness,
    createdAt: input.createdAt,
  });
}

function modelSelectorMatches(scope: ProviderCapabilityModelScope, selectors: readonly string[] | undefined, modelId: string | undefined): boolean {
  if (scope === "none") return modelId === undefined;
  if (scope === "all-advertised") return modelId !== undefined;
  return modelId !== undefined && selectors?.includes(modelId) === true;
}

/**
 * Returns the exact evidence row that matches the requested operation/carrier.
 * This does not bypass policy, freshness, consent, quota, or native dispatch
 * preparation; callers must still compile a route and freeze provider input.
 */
export function findProviderCapabilityMatch(
  snapshot: ProviderEndpointCapabilitySnapshot,
  query: ProviderCapabilityMatchQuery,
): ProviderOperationCapability | null {
  const validated = validateProviderEndpointCapabilitySnapshot(snapshot);
  const modelId = query.modelId === undefined ? undefined : assertNonBlank(query.modelId, "model ID", MAX_SELECTOR_BYTES);
  return validated.operationCapabilities?.find((entry) => {
    if (entry.operation !== query.operation) return false;
    if (query.modality !== undefined && entry.modality !== query.modality) return false;
    if (query.carrierFormat !== undefined && !entry.carrierFormats.includes(query.carrierFormat)) return false;
    if (query.mimeFamily !== undefined && !entry.mimeFamilies.includes(query.mimeFamily)) return false;
    return modelSelectorMatches(entry.modelScope, entry.modelSelectors, modelId);
  }) ?? null;
}

/** Native direct dispatch is narrower than a generic adapter/bridge match. */
export function isNativeProviderCapability(candidate: ProviderOperationCapability | null): boolean {
  return candidate !== null && (candidate.supportLevel === "documented-native" || candidate.supportLevel === "model-gated");
}
