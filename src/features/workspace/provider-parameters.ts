import { resolveAutoModel } from "./provider-catalog";
import type {
  ModelProfileView,
  ParameterSettings,
  ProviderView,
} from "./types";

export type ProviderParameterFamily =
  | "openai-responses"
  | "openai-chat"
  | "anthropic"
  | "gemini"
  | "unsupported";

export interface RoutedProviderModel {
  model: ModelProfileView;
  provider: ProviderView;
  family: ProviderParameterFamily;
}

export interface ProviderParameterPreflight {
  parameters: PreparedProviderParameters;
  errors: string[];
}

/**
 * Parameters validated in the renderer before native run preparation freezes
 * them. Dispatch never accepts this structure; it only receives opaque IDs.
 */
export interface PreparedProviderParameters {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  seed?: number;
  stop?: string[];
  reasoningEffort?: string;
  jsonMode?: boolean;
  native?: Record<string, unknown>;
}

export type ParameterCapabilityKey = "reasoning" | "json" | "topK" | "seed";

const DEFAULT_PARAMETERS: Readonly<ParameterSettings> = Object.freeze({
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  minP: 0,
  maxOutputTokens: 4096,
  reasoningEffort: "medium",
  reasoningBudgetTokens: null,
  frequencyPenalty: 0,
  presencePenalty: 0,
  seed: null,
  stopSequences: "",
  streaming: true,
  jsonMode: false,
  jsonSchema: "",
  logprobs: false,
  topLogprobs: 0,
  parallelToolCalls: true,
  promptCaching: true,
  toolChoice: "auto",
  serviceTier: "auto",
  timeoutMs: 120000,
  maxRetries: 2,
  providerExtensions: "{}",
});

function normalizeProviderType(value: string): string {
  return value.trim().toLowerCase().replaceAll("-", "_");
}

export function providerParameterFamily(provider: Pick<ProviderView, "providerType" | "kind">): ProviderParameterFamily {
  switch (normalizeProviderType(provider.providerType)) {
    case "openai":
      return "openai-responses";
    case "openai_compatible":
    case "deepseek":
    case "local":
      return "openai-chat";
    case "anthropic":
      return "anthropic";
    case "gemini":
    case "google":
    case "google_gemini":
      return "gemini";
    default:
      break;
  }

  if (provider.kind === "OpenAI" || provider.kind === "OpenAI-compatible" || provider.kind === "Local") {
    return provider.kind === "OpenAI" ? "openai-responses" : "openai-chat";
  }
  if (provider.kind === "Anthropic") return "anthropic";
  if (provider.kind === "Gemini") return "gemini";
  return "unsupported";
}

export function resolveRoutedProviderModel(
  providers: ProviderView[],
  selectedModel: ModelProfileView | undefined,
): RoutedProviderModel | null {
  const model = selectedModel?.connectionId ? selectedModel : resolveAutoModel(providers);
  if (!model?.connectionId) return null;
  const provider = providers.find((item) => item.id === model.connectionId);
  if (!provider || !provider.enabled || provider.state !== "connected") return null;

  // An explicit model profile can outlive a provider refresh or be supplied by
  // a stale renderer catalog. Verify both the provider-owned model identity and
  // its availability before exposing a route to parameter preflight or native
  // dispatch. Auto routing already applies the same connected/available gate.
  const providerModel = provider.models.find((candidate) => candidate.id === model.id);
  if (!providerModel || providerModel.status !== "available" || model.status !== "available") return null;

  return { model: providerModel, provider, family: providerParameterFamily(provider) };
}

export function supportsProviderParameter(
  route: RoutedProviderModel | null,
  parameter: ParameterCapabilityKey,
): boolean {
  if (!route) return false;
  switch (parameter) {
    case "reasoning":
      return route.model.capabilities.includes("reasoning");
    case "json":
      return route.family !== "anthropic" && route.model.capabilities.includes("json");
    case "topK":
      return route.family === "anthropic" || route.family === "gemini";
    case "seed":
      return route.family === "openai-chat";
  }
}

function wasChanged<K extends keyof ParameterSettings>(
  parameters: ParameterSettings,
  key: K,
): boolean {
  return parameters[key] !== DEFAULT_PARAMETERS[key];
}

function nonEmptyLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function unsupported(errors: string[], label: string, provider: ProviderView): void {
  errors.push(`${label} is not supported by ${provider.name} (${provider.kind}). Reset it before sending.`);
}

/**
 * Builds the exact parameter object understood by the current native provider
 * gateway. Any explicitly changed control that cannot be represented is a
 * preflight error instead of being silently dropped.
 */
export function preflightProviderParameters(
  parameters: ParameterSettings,
  route: RoutedProviderModel,
): ProviderParameterPreflight {
  const errors: string[] = [];
  const { family, model, provider } = route;
  const output: PreparedProviderParameters = {
    temperature: parameters.temperature,
    topP: parameters.topP,
    maxOutputTokens: parameters.maxOutputTokens,
  };

  if (family === "unsupported") {
    errors.push(`${provider.name} does not have a runnable chat adapter in this preview.`);
    return { parameters: output, errors };
  }

  if (family === "anthropic" || family === "gemini") {
    output.topK = parameters.topK;
  } else if (wasChanged(parameters, "topK")) {
    unsupported(errors, "Top K", provider);
  }

  if (parameters.seed !== null) {
    if (family === "openai-chat") output.seed = parameters.seed;
    else unsupported(errors, "Seed", provider);
  }

  const stop = nonEmptyLines(parameters.stopSequences);
  if (stop.length > 0) {
    if (family === "openai-responses") unsupported(errors, "Stop sequences", provider);
    else output.stop = stop;
  }

  if (parameters.reasoningEffort !== "off") {
    if (model.capabilities.includes("reasoning")) {
      output.reasoningEffort = parameters.reasoningEffort;
    } else if (wasChanged(parameters, "reasoningEffort")) {
      unsupported(errors, "Reasoning effort", provider);
    }
  }

  if (parameters.jsonMode) {
    if (!model.capabilities.includes("json")) unsupported(errors, "JSON response", provider);
    else if (family === "anthropic") unsupported(errors, "JSON response", provider);
    else output.jsonMode = true;
  }

  if (parameters.reasoningBudgetTokens !== null) unsupported(errors, "Reasoning budget", provider);
  if (wasChanged(parameters, "minP")) unsupported(errors, "Min P", provider);
  if (wasChanged(parameters, "frequencyPenalty")) unsupported(errors, "Frequency penalty", provider);
  if (wasChanged(parameters, "presencePenalty")) unsupported(errors, "Presence penalty", provider);
  if (parameters.logprobs) unsupported(errors, "Log probabilities", provider);
  if (wasChanged(parameters, "topLogprobs")) unsupported(errors, "Top log probabilities", provider);
  if (parameters.jsonSchema.trim()) {
    errors.push("JSON schema is not connected to the Phase 1 provider gateway yet. Clear it before sending.");
  }
  if (!parameters.streaming) unsupported(errors, "Non-streaming response", provider);
  if (wasChanged(parameters, "parallelToolCalls")) unsupported(errors, "Parallel tool calls", provider);
  if (wasChanged(parameters, "promptCaching")) unsupported(errors, "Prompt caching", provider);
  if (wasChanged(parameters, "toolChoice")) unsupported(errors, "Tool choice", provider);
  if (wasChanged(parameters, "serviceTier")) unsupported(errors, "Service tier", provider);
  if (wasChanged(parameters, "timeoutMs")) unsupported(errors, "Per-run timeout", provider);
  if (wasChanged(parameters, "maxRetries")) unsupported(errors, "Retry policy", provider);
  if (parameters.providerExtensions.trim() && parameters.providerExtensions.trim() !== DEFAULT_PARAMETERS.providerExtensions) {
    unsupported(errors, "Provider extensions", provider);
  }

  return { parameters: output, errors };
}
