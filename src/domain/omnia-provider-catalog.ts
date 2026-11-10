/**
 * Bundled provider/model capability catalog.
 *
 * This module is deliberately metadata-only.  It never stores credentials,
 * performs network requests, or authorizes a route.  Live discovery and the
 * provider egress policy remain authoritative at dispatch time.  Keeping this
 * distinction explicit lets the UI expose a broad provider surface without
 * accidentally turning a stale catalog entry into a capability assertion.
 */

export type OmniaProviderFamily =
  | "llm"
  | "multimodal"
  | "image"
  | "video"
  | "audio"
  | "embedding"
  | "gateway"
  | "local";

export type OmniaCatalogCapability =
  | "chat"
  | "vision"
  | "tools"
  | "reasoning"
  | "structured-output"
  | "image-generation"
  | "image-editing"
  | "video-generation"
  | "speech-to-text"
  | "text-to-speech"
  | "audio-understanding"
  | "embeddings"
  | "rerank"
  | "moderation";

export type OmniaCatalogTransport =
  | "responses"
  | "messages"
  | "chat-completions"
  | "rest"
  | "local-http"
  | "custom";

export type OmniaCatalogModel = {
  readonly id: string;
  readonly label: string;
  readonly family: OmniaProviderFamily;
  readonly capabilities: readonly OmniaCatalogCapability[];
  /** A bounded, approximate context label for UI filtering only. */
  readonly contextWindowTokens?: number;
  /** Catalog entries are examples/families until a provider discovery receipt exists. */
  readonly catalogOnly: true;
};

export type OmniaProviderCatalogEntry = {
  readonly id: string;
  readonly label: string;
  readonly family: OmniaProviderFamily;
  readonly aliases: readonly string[];
  readonly transports: readonly OmniaCatalogTransport[];
  readonly capabilities: readonly OmniaCatalogCapability[];
  readonly models: readonly OmniaCatalogModel[];
  /** Static catalog metadata is not live capability evidence. */
  readonly source: "bundled-static";
  readonly revision: string;
};

export type OmniaProviderCatalog = {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly providers: readonly OmniaProviderCatalogEntry[];
};

const CAPABILITIES: readonly OmniaCatalogCapability[] = [
  "chat",
  "vision",
  "tools",
  "reasoning",
  "structured-output",
  "image-generation",
  "image-editing",
  "video-generation",
  "speech-to-text",
  "text-to-speech",
  "audio-understanding",
  "embeddings",
  "rerank",
  "moderation",
];

const TRANSPORTS: readonly OmniaCatalogTransport[] = [
  "responses",
  "messages",
  "chat-completions",
  "rest",
  "local-http",
  "custom",
];

function assertNonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required`);
  if (normalized.length > 240) throw new Error(`${label} is too long`);
  return normalized;
}

function assertCapability(value: string): asserts value is OmniaCatalogCapability {
  if (!CAPABILITIES.includes(value as OmniaCatalogCapability)) {
    throw new Error(`Unknown catalog capability: ${value}`);
  }
}

function assertTransport(value: string): asserts value is OmniaCatalogTransport {
  if (!TRANSPORTS.includes(value as OmniaCatalogTransport)) {
    throw new Error(`Unknown catalog transport: ${value}`);
  }
}

function uniqueStrings<T extends string>(values: readonly T[], label: string): readonly T[] {
  // Keep the normalized runtime value while preserving the caller's literal
  // union. `assertNonBlank` returns a plain `string`, so a direct map widens
  // `T` to `string` and fails strict checks for `as const` catalog tuples.
  const normalized = values.map((value) => assertNonBlank(value, label) as T);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must be unique`);
  return Object.freeze([...normalized]);
}

function normalizeModel(model: OmniaCatalogModel): OmniaCatalogModel {
  const id = assertNonBlank(model.id, "catalog model id");
  const label = assertNonBlank(model.label, "catalog model label");
  if (model.catalogOnly !== true) throw new Error("Catalog models must be marked catalogOnly");
  const capabilities = uniqueStrings(model.capabilities, "catalog model capabilities");
  capabilities.forEach(assertCapability);
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error("catalog model capabilities must be unique");
  }
  if (model.contextWindowTokens !== undefined &&
      (!Number.isSafeInteger(model.contextWindowTokens) || model.contextWindowTokens <= 0)) {
    throw new Error("catalog model context window must be a positive safe integer");
  }
  return Object.freeze({
    id,
    label,
    family: model.family,
    capabilities,
    ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens }),
    catalogOnly: true,
  });
}

function normalizeProvider(entry: OmniaProviderCatalogEntry): OmniaProviderCatalogEntry {
  const id = assertNonBlank(entry.id, "catalog provider id");
  const label = assertNonBlank(entry.label, "catalog provider label");
  const aliases = uniqueStrings(entry.aliases, "catalog provider aliases");
  const transports = uniqueStrings(entry.transports, "catalog provider transports");
  transports.forEach(assertTransport);
  const capabilities = uniqueStrings(entry.capabilities, "catalog provider capabilities");
  capabilities.forEach(assertCapability);
  const models = entry.models.map(normalizeModel);
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error("catalog provider model ids must be unique");
  }
  const modelCapabilities = new Set(models.flatMap((model) => model.capabilities));
  const missing = capabilities.filter((capability) => !modelCapabilities.has(capability));
  if (missing.length > 0) {
    throw new Error(`catalog provider capabilities are not represented by models: ${missing.join(", ")}`);
  }
  if (entry.source !== "bundled-static") throw new Error("Unsupported catalog source");
  const revision = assertNonBlank(entry.revision, "catalog provider revision");
  return Object.freeze({
    id,
    label,
    family: entry.family,
    aliases,
    transports,
    capabilities,
    models: Object.freeze(models),
    source: "bundled-static",
    revision,
  });
}

function provider(
  id: string,
  label: string,
  family: OmniaProviderFamily,
  transports: readonly OmniaCatalogTransport[],
  models: readonly OmniaCatalogModel[],
  aliases: readonly string[] = [],
): OmniaProviderCatalogEntry {
  const capabilities = [...new Set(models.flatMap((model) => model.capabilities))];
  return normalizeProvider({
    id,
    label,
    family,
    aliases,
    transports,
    capabilities,
    models,
    source: "bundled-static",
    revision: "2026-10-17",
  });
}

const textVisionToolsReasoning = ["chat", "vision", "tools", "reasoning", "structured-output"] as const;
const textTools = ["chat", "tools", "structured-output"] as const;

/**
 * Broad, intentionally conservative catalog used to seed onboarding and
 * filtering.  Exact IDs/capabilities must be refreshed through live discovery
 * before a billable request is prepared.
 */
export const OMNIA_BUNDLED_PROVIDER_CATALOG: OmniaProviderCatalog = Object.freeze({
  schemaVersion: 1,
  revision: "2026-10-17",
  providers: Object.freeze([
    provider("openai", "OpenAI", "multimodal", ["responses", "chat-completions", "rest"], [
      { id: "gpt-5", label: "GPT-5 family", family: "multimodal", capabilities: textVisionToolsReasoning, catalogOnly: true, contextWindowTokens: 400_000 },
      { id: "gpt-4.1", label: "GPT-4.1 family", family: "multimodal", capabilities: textVisionToolsReasoning, catalogOnly: true, contextWindowTokens: 1_000_000 },
      { id: "gpt-image", label: "GPT Image family", family: "image", capabilities: ["image-generation", "image-editing"], catalogOnly: true },
      { id: "gpt-realtime", label: "Realtime audio family", family: "audio", capabilities: ["chat", "audio-understanding", "text-to-speech", "speech-to-text", "tools"], catalogOnly: true },
      { id: "text-embedding", label: "Text embedding family", family: "embedding", capabilities: ["embeddings"], catalogOnly: true },
      { id: "moderation", label: "Moderation family", family: "llm", capabilities: ["moderation"], catalogOnly: true },
    ], ["openai-api"]),
    provider("anthropic", "Anthropic", "multimodal", ["messages", "rest"], [
      { id: "claude-opus", label: "Claude Opus family", family: "multimodal", capabilities: textVisionToolsReasoning, catalogOnly: true, contextWindowTokens: 200_000 },
      { id: "claude-sonnet", label: "Claude Sonnet family", family: "multimodal", capabilities: textVisionToolsReasoning, catalogOnly: true, contextWindowTokens: 200_000 },
      { id: "claude-haiku", label: "Claude Haiku family", family: "multimodal", capabilities: ["chat", "vision", "tools", "structured-output"], catalogOnly: true, contextWindowTokens: 200_000 },
    ]),
    provider("google", "Google AI", "multimodal", ["rest", "chat-completions"], [
      { id: "gemini-pro", label: "Gemini Pro family", family: "multimodal", capabilities: ["chat", "vision", "audio-understanding", "tools", "reasoning", "structured-output"], catalogOnly: true, contextWindowTokens: 1_000_000 },
      { id: "gemini-flash", label: "Gemini Flash family", family: "multimodal", capabilities: ["chat", "vision", "audio-understanding", "tools", "structured-output"], catalogOnly: true, contextWindowTokens: 1_000_000 },
      { id: "imagen", label: "Imagen family", family: "image", capabilities: ["image-generation", "image-editing"], catalogOnly: true },
      { id: "veo", label: "Veo family", family: "video", capabilities: ["video-generation"], catalogOnly: true },
      { id: "embedding", label: "Embedding family", family: "embedding", capabilities: ["embeddings"], catalogOnly: true },
    ], ["gemini"]),
    provider("deepseek", "DeepSeek", "llm", ["chat-completions", "rest"], [
      { id: "deepseek-chat", label: "DeepSeek Chat family", family: "llm", capabilities: textTools, catalogOnly: true },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner family", family: "llm", capabilities: ["chat", "reasoning", "structured-output"], catalogOnly: true },
    ]),
    provider("mistral", "Mistral AI", "multimodal", ["chat-completions", "rest"], [
      { id: "mistral-large", label: "Mistral Large family", family: "multimodal", capabilities: ["chat", "vision", "tools", "reasoning", "structured-output"], catalogOnly: true },
      { id: "pixtral", label: "Pixtral family", family: "multimodal", capabilities: ["chat", "vision", "tools", "structured-output"], catalogOnly: true },
      { id: "mistral-embed", label: "Mistral embedding family", family: "embedding", capabilities: ["embeddings"], catalogOnly: true },
    ]),
    provider("xai", "xAI", "llm", ["chat-completions", "rest"], [
      { id: "grok", label: "Grok family", family: "multimodal", capabilities: ["chat", "vision", "tools", "reasoning", "structured-output"], catalogOnly: true },
    ]),
    provider("cohere", "Cohere", "embedding", ["rest"], [
      { id: "command", label: "Command family", family: "llm", capabilities: ["chat", "tools", "structured-output"], catalogOnly: true },
      { id: "embed", label: "Embed family", family: "embedding", capabilities: ["embeddings"], catalogOnly: true },
      { id: "rerank", label: "Rerank family", family: "embedding", capabilities: ["rerank"], catalogOnly: true },
    ]),
    provider("elevenlabs", "ElevenLabs", "audio", ["rest"], [
      { id: "speech-to-text", label: "Speech-to-text family", family: "audio", capabilities: ["speech-to-text"], catalogOnly: true },
      { id: "text-to-speech", label: "Text-to-speech family", family: "audio", capabilities: ["text-to-speech"], catalogOnly: true },
    ]),
    provider("stability", "Stability AI", "image", ["rest"], [
      { id: "stable-image", label: "Stable Image family", family: "image", capabilities: ["image-generation", "image-editing"], catalogOnly: true },
    ]),
    provider("replicate", "Replicate", "gateway", ["rest"], [
      { id: "replicate-model", label: "Hosted model catalog", family: "gateway", capabilities: ["chat", "image-generation", "video-generation", "speech-to-text", "text-to-speech"], catalogOnly: true },
    ]),
    provider("openrouter", "OpenRouter", "gateway", ["chat-completions", "rest"], [
      { id: "routed-llm", label: "Routed LLM catalog", family: "gateway", capabilities: ["chat", "vision", "tools", "reasoning", "structured-output"], catalogOnly: true },
    ]),
    provider("ollama", "Ollama", "local", ["local-http", "chat-completions"], [
      { id: "local-llm", label: "Local text model", family: "local", capabilities: ["chat", "tools", "structured-output"], catalogOnly: true },
      { id: "local-vision", label: "Local vision model", family: "local", capabilities: ["chat", "vision"], catalogOnly: true },
      { id: "local-embedding", label: "Local embedding model", family: "embedding", capabilities: ["embeddings"], catalogOnly: true },
    ], ["local-ollama"]),
    provider("lm-studio", "LM Studio", "local", ["local-http", "chat-completions"], [
      { id: "local-model", label: "Local compatible model", family: "local", capabilities: ["chat", "tools", "structured-output"], catalogOnly: true },
    ]),
    provider("openai-compatible", "OpenAI-compatible endpoint", "gateway", ["chat-completions", "custom"], [
      { id: "discovered-model", label: "Discovered model", family: "gateway", capabilities: ["chat"], catalogOnly: true },
    ], ["custom", "openai_compatible"]),
  ]),
});

export function validateOmniaProviderCatalog(catalog: OmniaProviderCatalog): void {
  if (catalog.schemaVersion !== 1) throw new Error("Unsupported Omnia provider catalog version");
  assertNonBlank(catalog.revision, "catalog revision");
  const providers = catalog.providers.map(normalizeProvider);
  if (new Set(providers.map((entry) => entry.id)).size !== providers.length) {
    throw new Error("catalog provider ids must be unique");
  }
}

export function listOmniaCatalogModels(
  catalog: OmniaProviderCatalog = OMNIA_BUNDLED_PROVIDER_CATALOG,
  capability?: OmniaCatalogCapability,
): readonly (OmniaCatalogModel & { readonly providerId: string; readonly providerLabel: string })[] {
  validateOmniaProviderCatalog(catalog);
  const models = catalog.providers.flatMap((providerEntry) => providerEntry.models.map((model) => ({
    ...model,
    providerId: providerEntry.id,
    providerLabel: providerEntry.label,
  })));
  return Object.freeze(capability === undefined
    ? models
    : models.filter((model) => model.capabilities.includes(capability)));
}

export function findOmniaCatalogProvider(
  idOrAlias: string,
  catalog: OmniaProviderCatalog = OMNIA_BUNDLED_PROVIDER_CATALOG,
): OmniaProviderCatalogEntry | undefined {
  const normalized = idOrAlias.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  validateOmniaProviderCatalog(catalog);
  const entry = catalog.providers.find((providerEntry) =>
    providerEntry.id.toLowerCase() === normalized ||
    providerEntry.aliases.some((alias) => alias.toLowerCase() === normalized),
  );
  return entry;
}

export function mergeOmniaProviderCatalog(
  base: OmniaProviderCatalog,
  additions: readonly OmniaProviderCatalogEntry[],
): OmniaProviderCatalog {
  validateOmniaProviderCatalog(base);
  const normalizedAdditions = additions.map(normalizeProvider);
  const byId = new Map(base.providers.map((entry) => [entry.id, entry]));
  for (const entry of normalizedAdditions) byId.set(entry.id, entry);
  const providers = [...byId.values()].sort((left, right) => left.label.localeCompare(right.label));
  return Object.freeze({
    schemaVersion: 1,
    revision: base.revision,
    providers: Object.freeze(providers),
  });
}

validateOmniaProviderCatalog(OMNIA_BUNDLED_PROVIDER_CATALOG);
