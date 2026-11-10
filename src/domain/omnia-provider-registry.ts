export type ProviderKind = "openai" | "anthropic" | "google" | "deepseek" | "local" | "custom";
export type ProviderCapability = "chat" | "vision" | "tools" | "reasoning" | "image" | "video" | "embedding";

/**
 * Stable operation names used by the model catalog.  The legacy
 * `ProviderCapability` list above remains intentionally small for existing
 * callers; this profile is the richer multimodal contract used for routing
 * image, audio, video, speech, embedding, and LLM workloads.
 */
export type ProviderModelOperation =
  | "chat"
  | "vision"
  | "image-generation"
  | "image-editing"
  | "speech-to-text"
  | "text-to-speech"
  | "audio-generation"
  | "video-generation"
  | "embedding"
  | "rerank"
  | "moderation"
  | "realtime";

export type ProviderModelModality = "text" | "image" | "audio" | "video" | "file" | "embedding";
export type ProviderModelCapabilityDirection = "input" | "output" | "bidirectional";
export type ProviderModelCapabilitySupport = "native" | "adapter" | "preview" | "unsupported" | "unknown";

export interface ProviderModelCapability {
  readonly operation: ProviderModelOperation;
  readonly direction: ProviderModelCapabilityDirection;
  readonly support: ProviderModelCapabilitySupport;
  readonly inputModalities?: readonly ProviderModelModality[];
  readonly outputModalities?: readonly ProviderModelModality[];
  readonly inputMimeTypes?: readonly string[];
  readonly outputMimeTypes?: readonly string[];
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxDurationSeconds?: number;
  readonly notes?: string;
}

export interface ProviderModelModalityProfile {
  readonly version: 1;
  readonly capabilities: readonly ProviderModelCapability[];
}

/** Options used when matching a model against a multimodal operation. */
export type ProviderModelOperationQueryOptions = {
  /** Include capabilities that are marked as preview-only. */
  readonly includePreview?: boolean;
  /** Include capabilities whose support level is not yet verified. */
  readonly includeUnknown?: boolean;
};

/** Options used when searching the complete provider registry. */
export type ProviderModelRegistryQueryOptions = ProviderModelOperationQueryOptions & {
  /** Include disabled providers and models in the result set. */
  readonly includeDisabled?: boolean;
};

export type ProviderModelMatch = {
  readonly provider: ProviderDefinition;
  readonly model: ProviderModel;
};

export type ProviderModel = {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly ProviderCapability[];
  /** Optional richer profile. Older persisted models may omit it. */
  readonly modalityProfile?: ProviderModelModalityProfile;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly enabled: boolean;
};

export type ProviderEndpoint = {
  readonly baseUrl: string;
  readonly protocol: "responses" | "messages" | "chat-completions" | "custom";
  readonly auth: "api-key" | "bearer" | "none";
};

export type ProviderDefinition = {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly endpoint: ProviderEndpoint;
  readonly models: readonly ProviderModel[];
  readonly enabled: boolean;
  readonly selectedModelId?: string;
  readonly updatedAt: string;
};

export type ProviderRegistry = {
  readonly version: 1;
  readonly providers: readonly ProviderDefinition[];
  readonly selectedProviderId?: string;
};

const kinds: readonly ProviderKind[] = ["openai", "anthropic", "google", "deepseek", "local", "custom"];
const protocols: readonly ProviderEndpoint["protocol"][] = ["responses", "messages", "chat-completions", "custom"];
const authModes: readonly ProviderEndpoint["auth"][] = ["api-key", "bearer", "none"];
const capabilityValues: readonly ProviderCapability[] = ["chat", "vision", "tools", "reasoning", "image", "video", "embedding"];
const modelOperations: readonly ProviderModelOperation[] = [
  "chat", "vision", "image-generation", "image-editing", "speech-to-text", "text-to-speech",
  "audio-generation", "video-generation", "embedding", "rerank", "moderation", "realtime",
];
const modelModalities: readonly ProviderModelModality[] = ["text", "image", "audio", "video", "file", "embedding"];
const modelCapabilityDirections: readonly ProviderModelCapabilityDirection[] = ["input", "output", "bidirectional"];
const modelCapabilitySupport: readonly ProviderModelCapabilitySupport[] = ["native", "adapter", "preview", "unsupported", "unknown"];
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\+[-a-z0-9.]+)?$/;
const MAX_MODALITY_CAPABILITIES = 64;
const MAX_MIME_TYPES = 64;
const MAX_NOTES_LENGTH = 2_048;

const MAX_ID_LENGTH = 160;
const MAX_LABEL_LENGTH = 240;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_CONTEXT_TOKENS = 10_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function fail(message: string): never {
  throw new Error(message);
}

function stamp(): string {
  return new Date().toISOString();
}

function normalizeText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0) fail(`${label} is required`);
  if (normalized.length > maxLength) fail(`${label} must be at most ${maxLength} characters`);
  return normalized;
}

function normalizeId(value: string, label: string): string {
  return normalizeText(value, label, MAX_ID_LENGTH);
}

function normalizeTimestamp(value: string, label: string): string {
  const normalized = value.trim();
  // Keep the original precision/offset, but reject values that Date cannot
  // parse or that are not an ISO-8601 date-time. This catches accidental
  // locale strings while remaining compatible with older snapshots.
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!iso.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    fail(`${label} must be an ISO-8601 timestamp`);
  }
  return normalized;
}

function normalizePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_CONTEXT_TOKENS) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} must not contain duplicates`);
}

function hasSensitiveQueryKey(url: URL): boolean {
  const sensitive = /(?:^|[-_.])(api[-_]?key|token|secret|signature|credential|password|auth)(?:$|[-_.])/i;
  return [...url.searchParams.keys()].some((key) => sensitive.test(key));
}

function cloneModel(model: ProviderModel): ProviderModel {
  return {
    id: model.id,
    label: model.label,
    capabilities: [...model.capabilities],
    ...(model.modalityProfile === undefined ? {} : {
      modalityProfile: {
        version: 1,
        capabilities: model.modalityProfile.capabilities.map((capability) => ({
          ...capability,
          ...(capability.inputModalities === undefined ? {} : { inputModalities: [...capability.inputModalities] }),
          ...(capability.outputModalities === undefined ? {} : { outputModalities: [...capability.outputModalities] }),
          ...(capability.inputMimeTypes === undefined ? {} : { inputMimeTypes: [...capability.inputMimeTypes] }),
          ...(capability.outputMimeTypes === undefined ? {} : { outputMimeTypes: [...capability.outputMimeTypes] }),
        })),
      },
    }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
    enabled: model.enabled,
  };
}

function normalizeMimeTypes(values: readonly string[] | undefined, label: string): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (values.length > MAX_MIME_TYPES) fail(`${label} must contain at most ${MAX_MIME_TYPES} values`);
  const normalized = values.map((value) => {
    if (!isString(value)) fail(`${label} must contain strings`);
    const item = value.trim().toLowerCase();
    if (item.length === 0 || item.length > MAX_ENDPOINT_LENGTH || !MIME_TYPE_PATTERN.test(item)) {
      fail(`${label} must contain canonical MIME types`);
    }
    return item;
  });
  assertUnique(normalized, label);
  return [...normalized].sort();
}

function normalizeModalityList(values: readonly ProviderModelModality[] | undefined, label: string): readonly ProviderModelModality[] | undefined {
  if (values === undefined) return undefined;
  if (values.length > modelModalities.length) fail(`${label} is too large`);
  const normalized = values.map((value) => {
    if (!isOneOf(modelModalities, value)) fail(`Unknown provider model modality: ${String(value)}`);
    return value;
  });
  assertUnique(normalized, label);
  return [...normalized];
}

function normalizeCapabilityEntry(input: ProviderModelCapability): ProviderModelCapability {
  if (!isRecord(input) || !isOneOf(modelOperations, input.operation) || !isOneOf(modelCapabilityDirections, input.direction) || !isOneOf(modelCapabilitySupport, input.support)) {
    fail("Invalid provider model modality capability");
  }
  const maxInputBytes = input.maxInputBytes === undefined ? undefined : normalizePositiveInteger(input.maxInputBytes, "Provider capability max input bytes");
  const maxOutputBytes = input.maxOutputBytes === undefined ? undefined : normalizePositiveInteger(input.maxOutputBytes, "Provider capability max output bytes");
  const maxDurationSeconds = input.maxDurationSeconds === undefined ? undefined : normalizePositiveInteger(input.maxDurationSeconds, "Provider capability max duration seconds");
  const notes = input.notes === undefined ? undefined : normalizeText(input.notes, "Provider capability notes", MAX_NOTES_LENGTH);
  const inputModalities = input.inputModalities === undefined
    ? undefined
    : normalizeModalityList(input.inputModalities, "Provider capability input modalities");
  const outputModalities = input.outputModalities === undefined
    ? undefined
    : normalizeModalityList(input.outputModalities, "Provider capability output modalities");
  const inputMimeTypes = input.inputMimeTypes === undefined
    ? undefined
    : normalizeMimeTypes(input.inputMimeTypes, "Provider capability input MIME types");
  const outputMimeTypes = input.outputMimeTypes === undefined
    ? undefined
    : normalizeMimeTypes(input.outputMimeTypes, "Provider capability output MIME types");

  return {
    operation: input.operation,
    direction: input.direction,
    support: input.support,
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(outputModalities === undefined ? {} : { outputModalities }),
    ...(inputMimeTypes === undefined ? {} : { inputMimeTypes }),
    ...(outputMimeTypes === undefined ? {} : { outputMimeTypes }),
    ...(maxInputBytes === undefined ? {} : { maxInputBytes }),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    ...(maxDurationSeconds === undefined ? {} : { maxDurationSeconds }),
    ...(notes === undefined ? {} : { notes }),
  };
}

function normalizeModalityProfile(input: ProviderModelModalityProfile | undefined): ProviderModelModalityProfile | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input) || input.version !== 1 || !Array.isArray(input.capabilities)) fail("Invalid provider model modality profile");
  if (input.capabilities.length > MAX_MODALITY_CAPABILITIES) fail(`Provider model modality profile must contain at most ${MAX_MODALITY_CAPABILITIES} capabilities`);
  const capabilities = input.capabilities.map((capability) => normalizeCapabilityEntry(capability));
  const keys = capabilities.map((capability) => `${capability.operation}:${capability.direction}`);
  assertUnique(keys, "Provider model modality capabilities");
  return { version: 1, capabilities };
}

function cloneProvider(provider: ProviderDefinition): ProviderDefinition {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    endpoint: { ...provider.endpoint },
    models: provider.models.map(cloneModel),
    enabled: provider.enabled,
    ...(provider.selectedModelId === undefined ? {} : { selectedModelId: provider.selectedModelId }),
    updatedAt: provider.updatedAt,
  };
}

function normalizeModel(input: ProviderModel): ProviderModel {
  if (!isRecord(input)) fail("Invalid provider model");
  if (!isString(input.id) || !isString(input.label) || !Array.isArray(input.capabilities) || typeof input.enabled !== "boolean") {
    fail("Invalid provider model");
  }
  const id = normalizeId(input.id, "Provider model id");
  const label = normalizeText(input.label, "Provider model label", MAX_LABEL_LENGTH);
  const capabilities = input.capabilities.map((capability) => {
    if (!isOneOf(capabilityValues, capability)) fail(`Unknown provider capability: ${String(capability)}`);
    return capability;
  });
  assertUnique(capabilities, "Provider model capabilities");
  const contextWindow = input.contextWindow === undefined
    ? undefined
    : normalizePositiveInteger(input.contextWindow, "Provider model context window");
  const maxOutputTokens = input.maxOutputTokens === undefined
    ? undefined
    : normalizePositiveInteger(input.maxOutputTokens, "Provider model max output tokens");
  const modalityProfile = normalizeModalityProfile(input.modalityProfile as ProviderModelModalityProfile | undefined);
  return {
    id,
    label,
    capabilities: [...capabilities],
    ...(modalityProfile === undefined ? {} : { modalityProfile }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    enabled: input.enabled,
  };
}

/** Normalize and validate a model at the renderer/persistence boundary. */
export function normalizeProviderModel(input: ProviderModel): ProviderModel {
  return cloneModel(normalizeModel(input));
}

function normalizeEndpoint(input: ProviderEndpoint): ProviderEndpoint {
  if (!isRecord(input) || !isString(input.baseUrl) || !isOneOf(protocols, input.protocol) || !isOneOf(authModes, input.auth)) {
    fail("Invalid provider endpoint");
  }
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (baseUrl.length === 0 || baseUrl.length > MAX_ENDPOINT_LENGTH) fail("Provider endpoint is required and must be reasonably sized");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    fail("Provider endpoint must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") fail("Provider endpoint must use HTTP or HTTPS");
  if (parsed.username.length > 0 || parsed.password.length > 0) fail("Provider endpoint must not contain credentials");
  if (parsed.hash.length > 0) fail("Provider endpoint must not contain a URL fragment");
  if (hasSensitiveQueryKey(parsed)) fail("Provider endpoint must not contain sensitive query parameters");
  return { baseUrl, protocol: input.protocol, auth: input.auth };
}

/** Normalize an endpoint without retaining caller-owned object references. */
export function normalizeProviderEndpoint(endpoint: ProviderEndpoint): ProviderEndpoint {
  return { ...normalizeEndpoint(endpoint) };
}

function normalizeProvider(input: ProviderDefinition): ProviderDefinition {
  if (!isRecord(input) || !isString(input.id) || !isString(input.name) || !isOneOf(kinds, input.kind) || !isRecord(input.endpoint) || !Array.isArray(input.models) || typeof input.enabled !== "boolean" || !isString(input.updatedAt)) {
    fail("Invalid provider definition");
  }
  const id = normalizeId(input.id, "Provider id");
  const name = normalizeText(input.name, "Provider name", MAX_LABEL_LENGTH);
  const endpoint = normalizeEndpoint(input.endpoint as ProviderEndpoint);
  const models = input.models.map((model) => normalizeModel(model));
  assertUnique(models.map((model) => model.id), "Provider model ids");
  const selectedModelId = input.selectedModelId === undefined
    ? undefined
    : (() => {
      if (!isString(input.selectedModelId)) fail("Provider selected model id must be a string");
      return normalizeId(input.selectedModelId, "Provider selected model id");
    })();
  if (selectedModelId !== undefined) {
    const selectedModel = models.find((model) => model.id === selectedModelId);
    if (selectedModel === undefined) fail(`Unknown selected provider model: ${selectedModelId}`);
    if (!selectedModel.enabled) fail(`Selected provider model is disabled: ${selectedModelId}`);
  }
  return {
    id,
    name,
    kind: input.kind,
    endpoint,
    models: models.map(cloneModel),
    enabled: input.enabled,
    ...(selectedModelId === undefined ? {} : { selectedModelId }),
    updatedAt: normalizeTimestamp(input.updatedAt, "Provider updatedAt"),
  };
}

function firstEnabledProvider(providers: readonly ProviderDefinition[]): ProviderDefinition | undefined {
  return providers.find((provider) => provider.enabled);
}

function firstEnabledModel(provider: ProviderDefinition): ProviderModel | undefined {
  return provider.models.find((model) => model.enabled);
}

function providerWithModels(
  provider: ProviderDefinition,
  models: readonly ProviderModel[],
  selectedModelId: string | undefined,
): ProviderDefinition {
  const base = { ...cloneProvider(provider), models: models.map(cloneModel) };
  if (selectedModelId === undefined) {
    const { selectedModelId: _selectedModelId, ...withoutSelection } = base;
    return withoutSelection;
  }
  return { ...base, selectedModelId };
}

function normalizeSelection(registry: ProviderRegistry): ProviderRegistry {
  const providers = registry.providers.map((provider) => cloneProvider(provider));
  const requested = registry.selectedProviderId === undefined
    ? undefined
    : normalizeId(registry.selectedProviderId, "Selected provider id");
  const selected = requested === undefined ? undefined : providers.find((provider) => provider.id === requested && provider.enabled);
  const fallback = selected ?? firstEnabledProvider(providers);
  if (fallback === undefined) return { version: 1, providers };
  return { version: 1, providers, selectedProviderId: fallback.id };
}

function validateRegistryShape(registry: ProviderRegistry): void {
  if (!isRecord(registry) || registry.version !== 1 || !Array.isArray(registry.providers)) fail("Invalid provider registry");
  if (registry.selectedProviderId !== undefined && !isString(registry.selectedProviderId)) fail("Selected provider id must be a string");
}

/** Validate all provider/model invariants and selection references. */
export function validateProviderRegistry(registry: ProviderRegistry): void {
  validateRegistryShape(registry);
  const normalized = registry.providers.map(normalizeProvider);
  assertUnique(normalized.map((provider) => provider.id), "Provider ids");
  const selectedId = registry.selectedProviderId === undefined
    ? undefined
    : normalizeId(registry.selectedProviderId, "Selected provider id");
  if (selectedId === undefined) return;
  const selected = normalized.find((provider) => provider.id === selectedId);
  if (selected === undefined) fail(`Unknown selected provider: ${selectedId}`);
  if (!selected.enabled) fail(`Selected provider is disabled: ${selectedId}`);
}

/** Build a registry from definitions, rejecting duplicate ids and invalid selections. */
export function createProviderRegistry(providers: readonly ProviderDefinition[] = []): ProviderRegistry {
  if (!Array.isArray(providers)) fail("Provider list must be an array");
  const normalized = providers.map((provider) => normalizeProvider(provider));
  assertUnique(normalized.map((provider) => provider.id), "Provider ids");
  return { version: 1, providers: normalized.map(cloneProvider) };
}

/** Insert or replace one provider while retaining a valid active selection. */
export function upsertProvider(registry: ProviderRegistry, provider: ProviderDefinition): ProviderRegistry {
  validateProviderRegistry(registry);
  const normalized = normalizeProvider({ ...provider, updatedAt: provider.updatedAt || stamp() });
  const providers = registry.providers
    .filter((candidate) => candidate.id !== normalized.id)
    .map(cloneProvider)
    .concat(normalized);
  return normalizeSelection({
    version: 1,
    providers,
    ...(registry.selectedProviderId === undefined ? {} : { selectedProviderId: registry.selectedProviderId }),
  });
}

/** Enable/disable a provider. Disabling the active provider selects the first enabled fallback. */
export function setProviderEnabled(registry: ProviderRegistry, providerId: string, enabled: boolean): ProviderRegistry {
  validateProviderRegistry(registry);
  const id = normalizeId(providerId, "Provider id");
  if (!registry.providers.some((provider) => provider.id === id)) fail(`Unknown provider: ${id}`);
  const providers = registry.providers.map((provider) => provider.id === id ? { ...cloneProvider(provider), enabled } : cloneProvider(provider));
  return normalizeSelection({
    version: 1,
    providers,
    ...(registry.selectedProviderId === undefined ? {} : { selectedProviderId: registry.selectedProviderId }),
  });
}

export function removeProvider(registry: ProviderRegistry, providerId: string): ProviderRegistry {
  validateProviderRegistry(registry);
  const id = normalizeId(providerId, "Provider id");
  if (!registry.providers.some((provider) => provider.id === id)) fail(`Unknown provider: ${id}`);
  const providers = registry.providers.filter((provider) => provider.id !== id).map(cloneProvider);
  return normalizeSelection({ version: 1, providers });
}

export function selectProvider(registry: ProviderRegistry, providerId: string, modelId?: string): ProviderRegistry {
  validateProviderRegistry(registry);
  const id = normalizeId(providerId, "Provider id");
  const provider = registry.providers.find((candidate) => candidate.id === id);
  if (!provider) fail(`Unknown provider: ${id}`);
  if (!provider.enabled) fail(`Provider is disabled: ${id}`);
  let selectedModelId = provider.selectedModelId;
  if (modelId !== undefined) {
    const normalizedModelId = normalizeId(modelId, "Provider model id");
    const model = provider.models.find((candidate) => candidate.id === normalizedModelId);
    if (!model) fail(`Unknown model: ${normalizedModelId}`);
    if (!model.enabled) fail(`Model is disabled: ${normalizedModelId}`);
    selectedModelId = model.id;
  }
  const providers = registry.providers.map((candidate) => candidate.id !== id
    ? cloneProvider(candidate)
    : providerWithModels(candidate, candidate.models, selectedModelId));
  return { version: 1, providers, selectedProviderId: id };
}

/** Insert or replace one model inside a provider. */
export function upsertProviderModel(registry: ProviderRegistry, providerId: string, model: ProviderModel): ProviderRegistry {
  validateProviderRegistry(registry);
  const id = normalizeId(providerId, "Provider id");
  const provider = registry.providers.find((candidate) => candidate.id === id);
  if (!provider) fail(`Unknown provider: ${id}`);
  const normalized = normalizeModel(model);
  const models = provider.models.filter((candidate) => candidate.id !== normalized.id).map(cloneModel).concat(normalized);
  const selectedModelId = provider.selectedModelId === normalized.id && !normalized.enabled
    ? firstEnabledModel(providerWithModels(provider, models, undefined))?.id
    : provider.selectedModelId;
  return upsertProvider(registry, { ...providerWithModels(provider, models, selectedModelId), updatedAt: stamp() });
}

export function setProviderModelEnabled(registry: ProviderRegistry, providerId: string, modelId: string, enabled: boolean): ProviderRegistry {
  validateProviderRegistry(registry);
  const id = normalizeId(providerId, "Provider id");
  const provider = registry.providers.find((candidate) => candidate.id === id);
  if (!provider) fail(`Unknown provider: ${id}`);
  const normalizedModelId = normalizeId(modelId, "Provider model id");
  const model = provider.models.find((candidate) => candidate.id === normalizedModelId);
  if (!model) fail(`Unknown model: ${normalizedModelId}`);
  return upsertProviderModel(registry, id, { ...cloneModel(model), enabled });
}

export function removeProviderModel(registry: ProviderRegistry, providerId: string, modelId: string): ProviderRegistry {
  validateProviderRegistry(registry);
  const id = normalizeId(providerId, "Provider id");
  const provider = registry.providers.find((candidate) => candidate.id === id);
  if (!provider) fail(`Unknown provider: ${id}`);
  const normalizedModelId = normalizeId(modelId, "Provider model id");
  if (!provider.models.some((model) => model.id === normalizedModelId)) fail(`Unknown model: ${normalizedModelId}`);
  const models = provider.models.filter((model) => model.id !== normalizedModelId).map(cloneModel);
  const selectedModelId = provider.selectedModelId === normalizedModelId ? firstEnabledModel(providerWithModels(provider, models, undefined))?.id : provider.selectedModelId;
  return upsertProvider(registry, { ...providerWithModels(provider, models, selectedModelId), updatedAt: stamp() });
}

export function getSelectedProvider(registry: ProviderRegistry): ProviderDefinition | undefined {
  validateProviderRegistry(registry);
  const provider = registry.selectedProviderId === undefined
    ? undefined
    : registry.providers.find((candidate) => candidate.id === normalizeId(registry.selectedProviderId!, "Selected provider id"));
  return provider === undefined ? undefined : cloneProvider(provider);
}

export function getSelectedModel(registry: ProviderRegistry): ProviderModel | undefined {
  const provider = getSelectedProvider(registry);
  if (provider === undefined || provider.selectedModelId === undefined) return undefined;
  const model = provider.models.find((candidate) => candidate.id === provider.selectedModelId);
  return model === undefined ? undefined : cloneModel(model);
}

function legacyCapabilityForOperation(operation: ProviderModelOperation): ProviderCapability | undefined {
  switch (operation) {
    case "chat":
      return "chat";
    case "vision":
      return "vision";
    case "image-generation":
    case "image-editing":
      return "image";
    case "video-generation":
      return "video";
    case "embedding":
      return "embedding";
    default:
      return undefined;
  }
}

function capabilitySupportMatches(
  support: ProviderModelCapabilitySupport,
  options: ProviderModelOperationQueryOptions,
): boolean {
  if (support === "unsupported") return false;
  if (support === "preview") return options.includePreview === true;
  if (support === "unknown") return options.includeUnknown === true;
  return true;
}

/**
 * Return whether a model can perform an operation according to its explicit
 * multimodal profile or, for older models, its legacy capability list.
 *
 * A profile is authoritative for operations it explicitly describes.  This
 * lets a catalog mark a previously broad legacy capability as unsupported or
 * preview-only without silently routing work to it.  Operations absent from a
 * partial profile retain the legacy fallback for backwards compatibility.
 */
export function modelSupportsOperation(
  model: ProviderModel,
  operation: ProviderModelOperation,
  options: ProviderModelOperationQueryOptions = {},
): boolean {
  if (!isOneOf(modelOperations, operation)) return false;
  const explicit = model.modalityProfile?.capabilities.filter((capability) => capability.operation === operation) ?? [];
  if (explicit.length > 0) return explicit.some((capability) => capabilitySupportMatches(capability.support, options));
  const legacy = legacyCapabilityForOperation(operation);
  return legacy === undefined ? false : model.capabilities.includes(legacy);
}

/** List provider/model pairs that can perform an operation in registry order. */
export function listProviderModelsByOperation(
  registry: ProviderRegistry,
  operation: ProviderModelOperation,
  options: ProviderModelRegistryQueryOptions = {},
): readonly ProviderModelMatch[] {
  validateProviderRegistry(registry);
  if (!isOneOf(modelOperations, operation)) return [];
  const includeDisabled = options.includeDisabled === true;
  const matches: ProviderModelMatch[] = [];
  for (const provider of registry.providers) {
    if (!includeDisabled && !provider.enabled) continue;
    for (const model of provider.models) {
      if (!includeDisabled && !model.enabled) continue;
      if (!modelSupportsOperation(model, operation, options)) continue;
      matches.push({ provider: cloneProvider(provider), model: cloneModel(model) });
    }
  }
  return matches;
}

/**
 * Resolve one deterministic provider/model route for an operation.
 * Enabled selected entries win, followed by the selected provider's first
 * matching model, then the first matching pair in registry order.
 */
export function resolveProviderModelForOperation(
  registry: ProviderRegistry,
  operation: ProviderModelOperation,
  options: ProviderModelRegistryQueryOptions = {},
): ProviderModelMatch | undefined {
  const matches = listProviderModelsByOperation(registry, operation, options);
  if (matches.length === 0) return undefined;

  const selectedProviderId = registry.selectedProviderId;
  const selectedProvider = selectedProviderId === undefined
    ? undefined
    : registry.providers.find((provider) => provider.id === selectedProviderId);
  if (selectedProvider !== undefined) {
    const selectedModelId = selectedProvider.selectedModelId;
    if (selectedModelId !== undefined) {
      const selected = matches.find((match) => match.provider.id === selectedProvider.id && match.model.id === selectedModelId);
      if (selected !== undefined) return selected;
    }
    const providerMatch = matches.find((match) => match.provider.id === selectedProvider.id);
    if (providerMatch !== undefined) return providerMatch;
  }
  return matches[0];
}

function parseModel(value: unknown): ProviderModel {
  if (!isRecord(value) || !isString(value.id) || !isString(value.label) || !Array.isArray(value.capabilities) || typeof value.enabled !== "boolean") {
    fail("Invalid provider model");
  }
  if (value.contextWindow !== undefined && typeof value.contextWindow !== "number") fail("Invalid provider model context window");
  if (value.maxOutputTokens !== undefined && typeof value.maxOutputTokens !== "number") fail("Invalid provider model max output tokens");
  return normalizeModel({
    id: value.id,
    label: value.label,
    capabilities: value.capabilities as ProviderCapability[],
    ...(value.contextWindow === undefined ? {} : { contextWindow: value.contextWindow }),
    ...(value.maxOutputTokens === undefined ? {} : { maxOutputTokens: value.maxOutputTokens }),
    ...(value.modalityProfile === undefined ? {} : { modalityProfile: value.modalityProfile as ProviderModelModalityProfile }),
    enabled: value.enabled,
  });
}

function parseProvider(value: unknown): ProviderDefinition {
  if (!isRecord(value) || !isString(value.id) || !isString(value.name) || !isOneOf(kinds, value.kind) || !isRecord(value.endpoint) || !isString(value.endpoint.baseUrl) || !isOneOf(protocols, value.endpoint.protocol) || !isOneOf(authModes, value.endpoint.auth) || !Array.isArray(value.models) || !isString(value.updatedAt) || typeof value.enabled !== "boolean") {
    fail("Invalid provider definition");
  }
  if (value.selectedModelId !== undefined && !isString(value.selectedModelId)) fail("Invalid selected provider model id");
  return normalizeProvider({
    id: value.id,
    name: value.name,
    kind: value.kind,
    endpoint: { baseUrl: value.endpoint.baseUrl, protocol: value.endpoint.protocol, auth: value.endpoint.auth },
    models: value.models.map(parseModel),
    enabled: value.enabled,
    ...(value.selectedModelId === undefined ? {} : { selectedModelId: value.selectedModelId }),
    updatedAt: value.updatedAt,
  });
}

export function deserializeProviderRegistry(input: string | unknown): ProviderRegistry {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.providers)) fail("Invalid provider registry");
  if (value.selectedProviderId !== undefined && !isString(value.selectedProviderId)) fail("Invalid selected provider id");
  const providers = value.providers.map(parseProvider);
  assertUnique(providers.map((provider) => provider.id), "Provider ids");
  return normalizeSelection({
    version: 1,
    providers,
    ...(value.selectedProviderId === undefined ? {} : { selectedProviderId: value.selectedProviderId }),
  });
}

export function serializeProviderRegistry(registry: ProviderRegistry): string {
  validateProviderRegistry(registry);
  return JSON.stringify({
    version: 1,
    providers: registry.providers.map(cloneProvider),
    ...(registry.selectedProviderId === undefined ? {} : { selectedProviderId: registry.selectedProviderId }),
  }, null, 2);
}
