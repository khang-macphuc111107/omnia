import {
  createChatTransportAdapterRegistry,
  type ChatTransportAdapter,
  type ChatTransportAdapterRegistry,
  type ChatTransportContentBlock,
  type ChatTransportInstruction,
  type ChatTransportMessage,
  type ChatTransportProtocol,
  type ChatTransportRequest,
  type ChatTransportResponseContract,
  type ChatTransportToolDefinition,
  type ChatTransportTranslation,
} from "./omnia-chat-transport";
import type { ChatMessage, ChatSession } from "./omnia-chat-runtime";
import {
  validateProviderRegistry,
  type ProviderDefinition,
  type ProviderModel,
  type ProviderRegistry,
} from "./omnia-provider-registry";
import type { JsonObject } from "./shared";

/**
 * Renderer-safe preparation boundary for chat execution.
 *
 * This module deliberately stops before network I/O. The native provider
 * gateway remains the only component that can resolve credentials, endpoints,
 * and egress policy. Callers can use the returned translation to hand the
 * request to that gateway, while browser previews can keep an explicit
 * `unavailable` result instead of pretending that a provider call happened.
 */

export const CHAT_RUNTIME_UNAVAILABLE_REASONS = [
  "no-provider-selected",
  "provider-not-found",
  "provider-disabled",
  "no-model-selected",
  "model-not-found",
  "model-disabled",
  "model-not-chat-capable",
  "unsupported-protocol",
  "adapter-not-registered",
  "browser-provider-execution-unavailable",
] as const;

export type ChatRuntimeUnavailableReason = (typeof CHAT_RUNTIME_UNAVAILABLE_REASONS)[number];

export type ChatRuntimeSelection = {
  readonly providerId?: string;
  readonly modelId?: string;
};

export type ChatRuntimeRoute = {
  readonly provider: ProviderDefinition;
  readonly model: ProviderModel;
  readonly protocol: ChatTransportProtocol;
  readonly adapterId: string;
};

export type ChatRuntimeRouteResolution =
  | { readonly status: "ready"; readonly route: ChatRuntimeRoute }
  | {
      readonly status: "unavailable";
      readonly reason: ChatRuntimeUnavailableReason;
      readonly message: string;
      readonly providerId?: string;
      readonly modelId?: string;
    }
  | {
      readonly status: "invalid";
      readonly message: string;
    };

export type ChatRuntimeRequestInput = {
  readonly session: ChatSession;
  readonly requestId: string;
  readonly attemptId: string;
  readonly route: Pick<ChatRuntimeRoute, "protocol" | "model">;
  readonly parameters?: JsonObject;
  readonly tools?: readonly ChatTransportToolDefinition[];
  readonly responseContract?: ChatTransportResponseContract;
  readonly contextSnapshotId?: string;
  readonly requestIdempotencyKey?: string;
  readonly providerExtensions?: JsonObject;
};

export type ChatRuntimePreparationInput = ChatRuntimeRequestInput & {
  readonly registry: ProviderRegistry;
  readonly selection?: ChatRuntimeSelection;
  readonly adapters?: ChatTransportAdapterRegistry;
};

export type ChatRuntimePreparation =
  | {
      readonly status: "ready";
      readonly route: ChatRuntimeRoute;
      readonly request: ChatTransportRequest;
      readonly adapter: ChatTransportAdapter;
      readonly translation: ChatTransportTranslation;
    }
  | {
      readonly status: "unavailable";
      readonly reason: ChatRuntimeUnavailableReason;
      readonly message: string;
      readonly providerId?: string;
      readonly modelId?: string;
    }
  | { readonly status: "invalid"; readonly message: string };

const PROTOCOL_ADAPTER_IDS: Readonly<Record<ChatTransportProtocol, string>> = Object.freeze({
  responses: "openai.responses",
  messages: "anthropic.messages",
  "chat-completions": "openai.chat-completions",
  custom: "custom.declarative",
});

function nonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} cannot be blank.`);
  return normalized;
}

function unavailable(
  reason: ChatRuntimeUnavailableReason,
  message: string,
  providerId?: string,
  modelId?: string,
): ChatRuntimeRouteResolution {
  return {
    status: "unavailable",
    reason,
    message,
    ...(providerId === undefined ? {} : { providerId }),
    ...(modelId === undefined ? {} : { modelId }),
  };
}

function requestUnavailable(
  resolution: Exclude<ChatRuntimeRouteResolution, { readonly status: "ready" }>,
): ChatRuntimePreparation {
  return resolution.status === "unavailable"
    ? resolution
    : { status: "invalid", message: resolution.message };
}

/** Return the built-in adapter id for a provider endpoint protocol. */
export function chatTransportAdapterIdForProtocol(protocol: ChatTransportProtocol): string {
  return PROTOCOL_ADAPTER_IDS[protocol];
}

/**
 * Resolve the selected provider/model without touching credentials or network.
 * An enabled model must advertise `chat`; otherwise the route is explicitely
 * unavailable and should not be sent to a provider gateway.
 */
export function resolveChatRuntimeRoute(
  registry: ProviderRegistry,
  selection: ChatRuntimeSelection = {},
): ChatRuntimeRouteResolution {
  try {
    validateProviderRegistry(registry);
    const requestedProviderId = selection.providerId?.trim() || registry.selectedProviderId;
    if (!requestedProviderId) return unavailable("no-provider-selected", "No provider is selected for this chat.");

    const provider = registry.providers.find((candidate) => candidate.id === requestedProviderId);
    if (!provider) return unavailable("provider-not-found", `Provider was not found: ${requestedProviderId}`, requestedProviderId);
    if (!provider.enabled) return unavailable("provider-disabled", `Provider is disabled: ${provider.name}`, provider.id);

    const requestedModelId = selection.modelId?.trim() || provider.selectedModelId;
    if (!requestedModelId) return unavailable("no-model-selected", `No model is selected for provider ${provider.name}.`, provider.id);
    const model = provider.models.find((candidate) => candidate.id === requestedModelId);
    if (!model) return unavailable("model-not-found", `Model was not found: ${requestedModelId}`, provider.id, requestedModelId);
    if (!model.enabled) return unavailable("model-disabled", `Model is disabled: ${model.label}`, provider.id, model.id);
    if (!model.capabilities.includes("chat")) {
      return unavailable("model-not-chat-capable", `Model does not advertise chat capability: ${model.label}`, provider.id, model.id);
    }

    return {
      status: "ready",
      route: {
        provider,
        model,
        protocol: provider.endpoint.protocol,
        adapterId: chatTransportAdapterIdForProtocol(provider.endpoint.protocol),
      },
    };
  } catch (error) {
    return { status: "invalid", message: error instanceof Error ? error.message : "Invalid provider registry." };
  }
}

function contentBlockForMessage(message: ChatMessage): ChatTransportContentBlock {
  return {
    type: message.role === "assistant" ? "output_text" : "input_text",
    text: message.content,
  };
}

function toMessage(message: ChatMessage): ChatTransportMessage | null {
  const text = message.content.trim();
  if (!text || message.role === "system") return null;
  return {
    id: message.id,
    role: message.role,
    content: [contentBlockForMessage({ ...message, content: text })],
  };
}

function toInstruction(message: ChatMessage): ChatTransportInstruction | null {
  const text = message.content.trim();
  if (!text || message.role !== "system") return null;
  return {
    id: message.id,
    role: "system",
    content: [{ type: "input_text", text }],
  };
}

/** Convert a lightweight chat session into the canonical transport request. */
export function buildChatTransportRequest(input: ChatRuntimeRequestInput): ChatTransportRequest {
  const requestId = nonBlank(input.requestId, "Chat request id");
  const attemptId = nonBlank(input.attemptId, "Chat attempt id");
  const model = nonBlank(input.route.model.id, "Chat model id");
  const instructions = input.session.messages.flatMap((message) => {
    const instruction = toInstruction(message);
    return instruction === null ? [] : [instruction];
  });
  const messages = input.session.messages.flatMap((message) => {
    const converted = toMessage(message);
    return converted === null ? [] : [converted];
  });
  if (instructions.length === 0 && messages.length === 0) throw new Error("Chat session has no non-empty messages.");

  return Object.freeze({
    schemaVersion: 1,
    requestId,
    attemptId,
    protocol: input.route.protocol,
    model,
    ...(instructions.length === 0 ? {} : { instructions: Object.freeze(instructions) }),
    messages: Object.freeze(messages),
    ...(input.tools === undefined ? {} : { tools: Object.freeze([...input.tools]) }),
    ...(input.responseContract === undefined ? {} : { responseContract: input.responseContract }),
    ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
    ...(input.contextSnapshotId === undefined ? {} : { contextSnapshotId: input.contextSnapshotId }),
    ...(input.requestIdempotencyKey === undefined ? {} : { requestIdempotencyKey: input.requestIdempotencyKey }),
    ...(input.providerExtensions === undefined ? {} : { providerExtensions: input.providerExtensions }),
  });
}

/** Resolve, translate, and return a native-safe preparation receipt. */
export function prepareChatRuntime(input: ChatRuntimePreparationInput): ChatRuntimePreparation {
  const resolution = resolveChatRuntimeRoute(input.registry, input.selection);
  if (resolution.status !== "ready") return requestUnavailable(resolution);

  const adapters = input.adapters ?? createChatTransportAdapterRegistry();
  let adapter: ChatTransportAdapter;
  try {
    adapter = adapters.resolve(resolution.route.adapterId);
  } catch (error) {
    return {
      status: "unavailable",
      reason: "adapter-not-registered",
      message: error instanceof Error ? error.message : `Adapter is not registered: ${resolution.route.adapterId}`,
      providerId: resolution.route.provider.id,
      modelId: resolution.route.model.id,
    };
  }

  try {
    const request = buildChatTransportRequest({ ...input, route: resolution.route });
    return {
      status: "ready",
      route: resolution.route,
      request,
      adapter,
      translation: adapter.translate(request),
    };
  } catch (error) {
    return { status: "invalid", message: error instanceof Error ? error.message : "Invalid chat request." };
  }
}

