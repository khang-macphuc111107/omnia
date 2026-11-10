import { assertDomain } from "./errors";
import type { JsonObject } from "./shared";

/**
 * Renderer-safe provider transport contracts.
 *
 * This module owns the loss-aware shape exchanged between the harness and a
 * provider adapter. It intentionally does not perform I/O, resolve secrets,
 * build URLs, or decide egress policy. Those responsibilities belong to the
 * native provider gateway.
 */

export const CHAT_TRANSPORT_PROTOCOLS = [
  "responses",
  "messages",
  "chat-completions",
  "custom",
] as const;

export type ChatTransportProtocol = (typeof CHAT_TRANSPORT_PROTOCOLS)[number];

export const CHAT_TRANSPORT_ROLES = [
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
] as const;

export type ChatTransportRole = (typeof CHAT_TRANSPORT_ROLES)[number];

export const CHAT_TRANSPORT_CAPABILITIES = [
  "streaming",
  "reasoning-summary",
  "citations",
  "tools",
  "usage",
  "rate-limits",
  "cancellation",
  "retrieval",
] as const;

export type ChatTransportCapability = (typeof CHAT_TRANSPORT_CAPABILITIES)[number];

export type ChatTransportContentBlock =
  | { readonly type: "input_text"; readonly text: string }
  | { readonly type: "output_text"; readonly text: string }
  | {
      readonly type: "input_image";
      readonly blobRef: string;
      readonly mediaType: string;
      readonly detail?: string;
    }
  | { readonly type: "input_audio"; readonly blobRef: string; readonly mediaType: string }
  | {
      readonly type: "input_file";
      readonly blobRef: string;
      readonly mediaType: string;
      readonly filename: string;
    }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly toolName: string;
      readonly argumentsJson: string;
    }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly result: readonly ChatTransportContentBlock[];
      readonly isError: boolean;
    }
  | { readonly type: "refusal"; readonly text: string };

export type CanonicalContent = ChatTransportContentBlock;

export interface ChatTransportMessage {
  readonly id?: string;
  readonly role: ChatTransportRole;
  readonly content: readonly ChatTransportContentBlock[];
  readonly name?: string;
}

export interface ChatTransportInstruction {
  readonly id?: string;
  readonly role: "system" | "developer";
  readonly content: readonly ChatTransportContentBlock[];
}

export interface ChatTransportToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
}

export type ChatTransportResponseContract =
  | { readonly type: "text" }
  | { readonly type: "json_object" }
  | {
      readonly type: "json_schema";
      readonly name: string;
      readonly schema: JsonObject;
      readonly strict: boolean;
    }
  | {
      readonly type: "provider_native";
      readonly namespace: string;
      readonly value: JsonObject;
    };

export interface ChatTransportRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly attemptId: string;
  readonly protocol: ChatTransportProtocol;
  readonly model: string;
  readonly instructions?: readonly ChatTransportInstruction[];
  readonly messages: readonly ChatTransportMessage[];
  readonly tools?: readonly ChatTransportToolDefinition[];
  readonly responseContract?: ChatTransportResponseContract;
  /** Resolved parameters are already policy checked and frozen by the harness. */
  readonly parameters?: JsonObject;
  readonly contextSnapshotId?: string;
  readonly requestIdempotencyKey?: string;
  /** Provider-native fields must be namespaced by the adapter. */
  readonly providerExtensions?: JsonObject;
}

export interface ChatTransportAdapterDescriptor {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: string;
  readonly protocol: ChatTransportProtocol;
  readonly displayName: string;
  readonly capabilities: readonly ChatTransportCapability[];
}

export interface ChatTransportTranslation {
  readonly schemaVersion: 1;
  readonly adapterId: string;
  readonly adapterRevision: string;
  readonly protocol: ChatTransportProtocol;
  readonly requestId: string;
  readonly attemptId: string;
  /** Provider-shaped JSON only; no URL, header, credential, or secret material. */
  readonly body: JsonObject;
  readonly notes: readonly ChatTransportTranslationNote[];
}

export interface ChatTransportTranslationNote {
  readonly code: string;
  readonly message: string;
  readonly support: "native" | "translated" | "emulated" | "rejected";
  readonly sourceField?: string;
  readonly destinationField?: string;
}

export interface ChatTransportConnectionInput {
  readonly connectionId: string;
  readonly adapterId: string;
  readonly endpointFingerprint?: string;
  readonly credentialConfigured: boolean;
}

export interface ChatTransportConnectionHealth {
  readonly connectionId: string;
  readonly status: "ready" | "degraded" | "failed";
  readonly observedAt: string;
  readonly diagnostic?: string;
}

export interface ChatTransportModelDescriptor {
  readonly id: string;
  readonly label?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export type ChatTransportModelEvent =
  | { readonly type: "model.discovered"; readonly model: ChatTransportModelDescriptor }
  | { readonly type: "model.discovery.warning"; readonly message: string };

export interface ChatTransportCapabilitySnapshot {
  readonly adapterId: string;
  readonly modelId: string;
  readonly observedAt: string;
  readonly capabilities: Readonly<Record<string, "supported" | "unsupported" | "unknown">>;
}

export interface ChatTransportValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface ChatTransportTokenEstimate {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly confidence: "provider" | "local" | "unknown";
}

export interface ChatTransportExecutionContext {
  readonly signal: AbortSignal;
  /** Opaque native handle, never a URL or credential. */
  readonly transportHandle?: string;
}

export interface ChatTransportRequestHandle {
  readonly requestId: string;
  readonly attemptId: string;
  readonly opaqueHandle: string;
}

export interface ChatTransportCancelOutcome {
  readonly accepted: boolean | "unknown";
  readonly observedAt: string;
  readonly diagnostic?: string;
}

export interface ChatTransportFailureInput {
  readonly category?: ChatTransportErrorCategory;
  readonly code?: string;
  readonly status?: number;
  readonly message?: string;
  readonly retryAfterMs?: number;
  readonly acceptedByProvider?: boolean | "unknown";
}

export const CHAT_TRANSPORT_ERROR_CATEGORIES = [
  "authentication",
  "authorization",
  "validation",
  "rate-limit",
  "network",
  "timeout",
  "protocol",
  "content-filter",
  "cancelled",
  "provider",
  "unknown",
] as const;

export type ChatTransportErrorCategory = (typeof CHAT_TRANSPORT_ERROR_CATEGORIES)[number];

export interface ChatTransportError {
  readonly code: string;
  readonly category: ChatTransportErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
  readonly acceptedByProvider: boolean | "unknown";
  readonly providerCode?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
}

export type ProviderError = ChatTransportError;

export interface ChatTransportAdapter {
  descriptor(): ChatTransportAdapterDescriptor;
  validateConnection?(input: ChatTransportConnectionInput): Promise<ChatTransportConnectionHealth>;
  discoverModels?(input: ChatTransportConnectionInput): AsyncIterable<ChatTransportModelEvent>;
  probeCapabilities?(input: {
    readonly connectionId: string;
    readonly modelId: string;
  }): Promise<ChatTransportCapabilitySnapshot>;
  validateRun?(input: ChatTransportRequest): Promise<ChatTransportValidationResult>;
  estimateTokens?(input: ChatTransportRequest): Promise<ChatTransportTokenEstimate>;
  translate(input: ChatTransportRequest): ChatTransportTranslation;
  normalizeEvent(input: unknown): ChatTransportEvent;
  execute?(
    input: ChatTransportTranslation,
    context: ChatTransportExecutionContext,
  ): AsyncIterable<ChatTransportEvent>;
  cancel?(
    handle: ChatTransportRequestHandle,
    signal?: AbortSignal,
  ): Promise<ChatTransportCancelOutcome>;
  retrieve?(
    handle: ChatTransportRequestHandle,
    cursor?: string,
  ): AsyncIterable<ChatTransportEvent>;
  classifyError(input: ChatTransportFailureInput): ChatTransportError;
}

export type ProviderAdapter = ChatTransportAdapter;

export interface ProviderStreamEventMetadata {
  readonly requestId?: string;
  readonly attemptId?: string;
  /** Provider-issued identity. Required before an event can be deduplicated. */
  readonly providerEventId?: string;
  /** Provider-issued replay cursor. Required before a replay can be deduplicated. */
  readonly cursor?: string;
}

export interface CanonicalCitation {
  readonly sourceId?: string;
  readonly uri?: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly locator?: string;
}

export interface NormalizedUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly totalTokens?: number;
  readonly providerUnits?: Readonly<Record<string, number>>;
}

export interface NormalizedRateLimit {
  readonly name: string;
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetAt?: string;
}

export const CHAT_TRANSPORT_FINISH_REASONS = [
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "refusal",
  "cancelled",
  "error",
  "unknown",
] as const;

export type ChatTransportFinishReason = (typeof CHAT_TRANSPORT_FINISH_REASONS)[number];

export type ChatTransportEvent = ProviderStreamEventMetadata &
  (
    | { readonly type: "response.started"; readonly remoteRequestId?: string; readonly remoteResponseId?: string }
    | { readonly type: "item.started"; readonly itemId: string; readonly itemKind: string }
    | { readonly type: "text.delta"; readonly itemId: string; readonly delta: string }
    | { readonly type: "reasoning_summary.delta"; readonly itemId: string; readonly delta: string }
    | { readonly type: "citation"; readonly itemId: string; readonly citation: CanonicalCitation }
    | { readonly type: "tool_call.started"; readonly itemId: string; readonly callId: string; readonly name: string }
    | { readonly type: "tool_call.arguments_delta"; readonly callId: string; readonly delta: string }
    | { readonly type: "tool_call.completed"; readonly callId: string; readonly argumentsJson: string }
    | { readonly type: "item.completed"; readonly itemId: string }
    | { readonly type: "usage.updated"; readonly usage: NormalizedUsage; readonly authoritative: boolean }
    | { readonly type: "rate_limit.updated"; readonly limits: readonly NormalizedRateLimit[] }
    | { readonly type: "provider.warning"; readonly code: string; readonly message: string }
    | { readonly type: "response.completed"; readonly finishReason: ChatTransportFinishReason }
    | { readonly type: "response.failed"; readonly error: ChatTransportError }
  );

export interface ChatTransportUnknownEvent extends ProviderStreamEventMetadata {
  readonly type: "provider.unknown";
  readonly providerType: string;
  /** Bounded diagnostic text; raw provider payloads are never retained. */
  readonly diagnostic: string;
}

export type NormalizedProviderStreamEvent = ChatTransportEvent;

export interface ChatTransportItemState {
  readonly itemId: string;
  readonly itemKind: string;
  readonly completed: boolean;
  readonly text: string;
  readonly reasoningSummary: string;
  readonly citations: readonly CanonicalCitation[];
}

export interface ChatTransportToolCallState {
  readonly callId: string;
  readonly itemId?: string;
  readonly name?: string;
  readonly argumentsText: string;
  readonly argumentsJson?: string;
  readonly completed: boolean;
}

export type ChatTransportStreamStatus =
  | "open"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted"
  | "unknown";

export interface ChatTransportEventIdentity {
  readonly kind: "provider-event-id" | "cursor";
  readonly value: string;
  readonly fingerprint: string;
}

export interface ChatTransportStreamState {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly attemptId: string;
  readonly status: ChatTransportStreamStatus;
  readonly responseStarted: boolean;
  readonly remoteRequestId?: string;
  readonly remoteResponseId?: string;
  readonly items: readonly ChatTransportItemState[];
  readonly toolCalls: readonly ChatTransportToolCallState[];
  readonly text: string;
  readonly reasoningSummary: string;
  readonly citations: readonly CanonicalCitation[];
  readonly usage?: NormalizedUsage;
  readonly provisionalUsage?: NormalizedUsage;
  readonly authoritativeUsage?: NormalizedUsage;
  readonly rateLimits: readonly NormalizedRateLimit[];
  readonly warnings: readonly string[];
  readonly unknownEvents: readonly ChatTransportUnknownEvent[];
  readonly eventCount: number;
  readonly identities: readonly ChatTransportEventIdentity[];
  readonly finishReason?: ChatTransportFinishReason;
  readonly error?: ChatTransportError;
  readonly terminalEventType?: "response.completed" | "response.failed" | "stream.closed";
}

const MAX_DIAGNOSTICS = 128;
const MAX_WARNING_LENGTH = 2_000;
const MAX_UNKNOWN_TYPE_LENGTH = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string, maximum: number): string {
  const normalized = value.trim();
  return normalized.length <= maximum ? normalized : normalized.slice(0, maximum);
}

function requireText(value: string, label: string, maximum = 4_096): string {
  assertDomain(typeof value === "string" && value.trim().length > 0, "invalid_argument", `${label} cannot be empty.`);
  return boundedText(value, maximum);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function contentToJson(block: ChatTransportContentBlock): JsonObject {
  switch (block.type) {
    case "input_text":
    case "output_text":
    case "refusal":
      return { type: block.type, text: block.text };
    case "input_image":
      return {
        type: block.type,
        blobRef: block.blobRef,
        mediaType: block.mediaType,
        ...(block.detail === undefined ? {} : { detail: block.detail }),
      };
    case "input_audio":
      return { type: block.type, blobRef: block.blobRef, mediaType: block.mediaType };
    case "input_file":
      return {
        type: block.type,
        blobRef: block.blobRef,
        mediaType: block.mediaType,
        filename: block.filename,
      };
    case "tool_call":
      return {
        type: block.type,
        callId: block.callId,
        toolName: block.toolName,
        argumentsJson: block.argumentsJson,
      };
    case "tool_result":
      return {
        type: block.type,
        callId: block.callId,
        result: block.result.map(contentToJson),
        isError: block.isError,
      };
  }
}

function messageToJson(message: ChatTransportMessage): JsonObject {
  return {
    ...(message.id === undefined ? {} : { id: message.id }),
    role: message.role,
    content: message.content.map(contentToJson),
    ...(message.name === undefined ? {} : { name: message.name }),
  };
}

function instructionToJson(instruction: ChatTransportInstruction): JsonObject {
  return {
    ...(instruction.id === undefined ? {} : { id: instruction.id }),
    role: instruction.role,
    content: instruction.content.map(contentToJson),
  };
}

function toolToJson(tool: ChatTransportToolDefinition): JsonObject {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema,
  };
}

function responseContractToJson(contract: ChatTransportResponseContract): JsonObject {
  switch (contract.type) {
    case "text":
    case "json_object":
      return { type: contract.type };
    case "json_schema":
      return { type: contract.type, name: contract.name, schema: contract.schema, strict: contract.strict };
    case "provider_native":
      return { type: contract.type, namespace: contract.namespace, value: contract.value };
  }
}

function baseTranslationBody(input: ChatTransportRequest): JsonObject {
  const parameters = input.parameters ?? {};
  return {
    ...parameters,
    model: input.model,
    stream: true,
    messages: input.messages.map(messageToJson),
    ...(input.instructions === undefined
      ? {}
      : { instructions: input.instructions.map(instructionToJson) }),
    ...(input.tools === undefined ? {} : { tools: input.tools.map(toolToJson) }),
    ...(input.responseContract === undefined
      ? {}
      : { responseContract: responseContractToJson(input.responseContract) }),
    ...(input.contextSnapshotId === undefined ? {} : { contextSnapshotId: input.contextSnapshotId }),
    ...(input.requestIdempotencyKey === undefined
      ? {}
      : { requestIdempotencyKey: input.requestIdempotencyKey }),
    ...(input.providerExtensions === undefined ? {} : input.providerExtensions),
  };
}

function translateRequest(
  input: ChatTransportRequest,
  descriptor: ChatTransportAdapterDescriptor,
): ChatTransportTranslation {
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Unsupported chat transport request schema.");
  assertDomain(input.protocol === descriptor.protocol, "invalid_argument", "Request protocol does not match adapter protocol.", {
    expected: descriptor.protocol,
    received: input.protocol,
  });
  const canonical = baseTranslationBody(input);
  const notes: ChatTransportTranslationNote[] = [];
  let body: JsonObject;
  switch (descriptor.protocol) {
    case "responses":
      // Build the Responses body directly from the canonical input messages.
      // `JsonObject` deliberately exposes an index signature as read-only, so
      // reading/deleting `canonical.messages` would widen to `JsonValue |`
      // `undefined` and violate exact optional property typing.  Keeping the
      // source array here also avoids mutating the frozen canonical object.
      body = {
        ...canonical,
        input: input.messages.map(messageToJson),
      };
      // `messages` is a canonical-only field and must not leak into the
      // provider-shaped Responses payload.  Rebuild the object without it;
      // JsonObject's readonly index signature intentionally disallows delete.
      {
        const { messages: _canonicalMessages, ...withoutMessages } = body;
        body = withoutMessages;
      }
      notes.push({ code: "responses.input", message: "Canonical messages mapped to Responses input.", support: "translated", sourceField: "messages", destinationField: "input" });
      break;
    case "messages": {
      const system = (input.instructions ?? []).filter((instruction) => instruction.role === "system");
      const messages = input.messages.filter((message) => message.role !== "system" && message.role !== "developer");
      body = {
        ...canonical,
        messages: messages.map(messageToJson),
        ...(system.length === 0 ? {} : { system: system.map(instructionToJson) }),
      };
      notes.push({ code: "messages.system", message: "System instructions are sent through the Messages system field.", support: "translated", sourceField: "instructions", destinationField: "system" });
      break;
    }
    case "chat-completions":
      body = canonical;
      break;
    case "custom":
      body = { canonical };
      notes.push({ code: "custom.canonical", message: "Custom adapters receive a namespaced canonical envelope.", support: "native", destinationField: "canonical" });
      break;
  }
  return Object.freeze({
    schemaVersion: 1,
    adapterId: descriptor.id,
    adapterRevision: descriptor.revision,
    protocol: descriptor.protocol,
    requestId: input.requestId,
    attemptId: input.attemptId,
    body: Object.freeze(body),
    notes: Object.freeze(notes),
  });
}

function isNormalizedType(value: unknown): value is ChatTransportEvent["type"] {
  return isOneOf(
    [
      "response.started",
      "item.started",
      "text.delta",
      "reasoning_summary.delta",
      "citation",
      "tool_call.started",
      "tool_call.arguments_delta",
      "tool_call.completed",
      "item.completed",
      "usage.updated",
      "rate_limit.updated",
      "provider.warning",
      "response.completed",
      "response.failed",
    ] as const,
    value,
  );
}

function unknownEvent(input: unknown): ChatTransportUnknownEvent {
  const providerType = isRecord(input) && typeof input.type === "string"
    ? boundedText(input.type, MAX_UNKNOWN_TYPE_LENGTH)
    : "unknown";
  return {
    type: "provider.unknown",
    providerType,
    diagnostic: boundedText(`Unrecognized provider event type: ${providerType}`, MAX_WARNING_LENGTH),
  };
}

function normalizeCanonicalEvent(input: unknown): ChatTransportEvent | undefined {
  if (!isRecord(input) || !isNormalizedType(input.type)) return undefined;
  return input as unknown as ChatTransportEvent;
}

function stringProperty(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function numberProperty(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function eventMetadata(record: Record<string, unknown>): ProviderStreamEventMetadata {
  const providerEventId = stringProperty(record, "providerEventId", "event_id", "eventId", "id");
  const cursor = stringProperty(record, "cursor", "sequence");
  return {
    ...(providerEventId === undefined ? {} : { providerEventId }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function usageFromUnknown(value: unknown): NormalizedUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = numberProperty(value, "inputTokens", "input_tokens", "prompt_tokens");
  const cachedInputTokens = numberProperty(value, "cachedInputTokens", "cached_input_tokens", "cache_read_input_tokens");
  const cacheWriteTokens = numberProperty(value, "cacheWriteTokens", "cache_write_tokens", "cache_creation_input_tokens");
  const outputTokens = numberProperty(value, "outputTokens", "output_tokens", "completion_tokens");
  const reasoningOutputTokens = numberProperty(value, "reasoningOutputTokens", "reasoning_tokens");
  const totalTokens = numberProperty(value, "totalTokens", "total_tokens");
  const result: NormalizedUsage = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

function normalizeRawProviderEvent(input: unknown, protocol: ChatTransportProtocol): ChatTransportEvent | ChatTransportUnknownEvent {
  const canonical = normalizeCanonicalEvent(input);
  if (canonical !== undefined) return canonical;
  if (!isRecord(input)) return unknownEvent(input);
  const metadata = eventMetadata(input);
  const type = typeof input.type === "string" ? input.type : "unknown";

  if (protocol === "responses") {
    if (type === "response.created" || type === "response.in_progress") {
      const response = isRecord(input.response) ? input.response : input;
      const remoteResponseId = stringProperty(response, "id", "response_id");
      const remoteRequestId = stringProperty(response, "request_id", "requestId");
      return {
        ...metadata,
        type: "response.started",
        ...(remoteResponseId === undefined ? {} : { remoteResponseId }),
        ...(remoteRequestId === undefined ? {} : { remoteRequestId }),
      };
    }
    if (type === "response.output_item.added") {
      const item = isRecord(input.item) ? input.item : input;
      const itemId = stringProperty(item, "id", "item_id");
      if (itemId === undefined) return unknownEvent(input);
      return { ...metadata, type: "item.started", itemId, itemKind: stringProperty(item, "type", "item_type") ?? "unknown" };
    }
    if (type === "response.output_text.delta") {
      const delta = stringProperty(input, "delta", "text");
      const itemId = stringProperty(input, "item_id", "itemId");
      if (delta === undefined || itemId === undefined) return unknownEvent(input);
      return { ...metadata, type: "text.delta", itemId, delta };
    }
    if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_summary.delta") {
      const delta = stringProperty(input, "delta", "text");
      const itemId = stringProperty(input, "item_id", "itemId") ?? "reasoning";
      if (delta === undefined) return unknownEvent(input);
      return { ...metadata, type: "reasoning_summary.delta", itemId, delta };
    }
    if (type === "response.function_call_arguments.delta") {
      const delta = stringProperty(input, "delta") ?? "";
      const callId = stringProperty(input, "call_id", "callId");
      if (callId === undefined) return unknownEvent(input);
      return { ...metadata, type: "tool_call.arguments_delta", callId, delta };
    }
    if (type === "response.function_call_arguments.done") {
      const callId = stringProperty(input, "call_id", "callId");
      const argumentsJson = stringProperty(input, "arguments", "argumentsJson") ?? "";
      if (callId === undefined) return unknownEvent(input);
      return { ...metadata, type: "tool_call.completed", callId, argumentsJson };
    }
    if (type === "response.output_item.done") {
      const itemId = stringProperty(input, "item_id", "itemId") ?? (isRecord(input.item) ? stringProperty(input.item, "id") : undefined);
      if (itemId === undefined) return unknownEvent(input);
      return { ...metadata, type: "item.completed", itemId };
    }
    if (type === "response.completed" || type === "response.done") {
      const response = isRecord(input.response) ? input.response : input;
      const usage = usageFromUnknown(response.usage);
      const finish = stringProperty(response, "finish_reason", "finishReason", "status");
      const finishReason = finish === "cancelled" || finish === "incomplete" ? "cancelled" : finish === "failed" ? "error" : "stop";
      return {
        ...metadata,
        ...(usage === undefined ? {} : { usageEvent: { type: "usage.updated" as const, usage, authoritative: true } }),
        type: "response.completed",
        finishReason,
      } as ChatTransportEvent;
    }
    if (type === "response.failed") {
      return { ...metadata, type: "response.failed", error: classifyChatTransportError({ category: "provider", message: "Provider response failed.", acceptedByProvider: "unknown" }) };
    }
  }

  if (protocol === "messages") {
    if (type === "message_start") {
      const message = isRecord(input.message) ? input.message : input;
      const remoteResponseId = stringProperty(message, "id");
      return { ...metadata, type: "response.started", ...(remoteResponseId === undefined ? {} : { remoteResponseId }) };
    }
    if (type === "content_block_start") {
      const block = isRecord(input.content_block) ? input.content_block : input;
      const itemId = stringProperty(input, "index", "item_id") ?? "item";
      const itemKind = stringProperty(block, "type") ?? "unknown";
      const callId = stringProperty(block, "id", "tool_use_id");
      if (itemKind === "tool_use" && callId !== undefined) return { ...metadata, type: "tool_call.started", itemId, callId, name: stringProperty(block, "name") ?? "tool" };
      return { ...metadata, type: "item.started", itemId, itemKind };
    }
    if (type === "content_block_delta") {
      const delta = isRecord(input.delta) ? input.delta : input;
      const itemId = stringProperty(input, "index", "item_id") ?? "item";
      const deltaType = stringProperty(delta, "type") ?? "";
      const value = stringProperty(delta, "text", "thinking", "partial_json", "delta") ?? "";
      if (deltaType === "input_json_delta") return { ...metadata, type: "tool_call.arguments_delta", callId: stringProperty(input, "call_id", "tool_use_id") ?? itemId, delta: value };
      if (deltaType === "thinking_delta") return { ...metadata, type: "reasoning_summary.delta", itemId, delta: value };
      return { ...metadata, type: "text.delta", itemId, delta: value };
    }
    if (type === "content_block_stop") {
      return { ...metadata, type: "item.completed", itemId: stringProperty(input, "index", "item_id") ?? "item" };
    }
    if (type === "message_delta") {
      const usage = usageFromUnknown(input.usage);
      const stopReason = stringProperty(input, "stop_reason", "finish_reason");
      if (usage !== undefined) return { ...metadata, type: "usage.updated", usage, authoritative: false };
      if (stopReason !== undefined) return { ...metadata, type: "response.completed", finishReason: normalizeFinishReason(stopReason) };
    }
    if (type === "message_stop") return { ...metadata, type: "response.completed", finishReason: "stop" };
  }

  if (protocol === "chat-completions" && type === "chat.completion.chunk") {
    const choice = Array.isArray(input.choices) && isRecord(input.choices[0]) ? input.choices[0] : undefined;
    const delta = choice !== undefined && isRecord(choice.delta) ? choice.delta : undefined;
    const itemId = stringProperty(choice ?? {}, "index") ?? "message";
    const finishReason = stringProperty(choice ?? {}, "finish_reason");
    const content = delta === undefined ? undefined : stringProperty(delta, "content");
    if (content !== undefined) return { ...metadata, type: "text.delta", itemId, delta: content };
    const reasoning = delta === undefined ? undefined : stringProperty(delta, "reasoning_content", "reasoning");
    if (reasoning !== undefined) return { ...metadata, type: "reasoning_summary.delta", itemId, delta: reasoning };
    if (finishReason !== undefined) return { ...metadata, type: "response.completed", finishReason: normalizeFinishReason(finishReason) };
    const usage = usageFromUnknown(input.usage);
    if (usage !== undefined) return { ...metadata, type: "usage.updated", usage, authoritative: true };
  }

  return unknownEvent(input);
}

function normalizeFinishReason(value: string): ChatTransportFinishReason {
  if (value === "length" || value === "tool_calls" || value === "content_filter" || value === "refusal" || value === "cancelled" || value === "error" || value === "stop") return value;
  return "unknown";
}

function validateUsage(usage: NormalizedUsage): void {
  for (const [key, value] of Object.entries(usage)) {
    if (key === "providerUnits") {
      for (const [unit, unitValue] of Object.entries(value as Readonly<Record<string, number>>)) {
        assertDomain(Number.isSafeInteger(unitValue) && unitValue >= 0, "invalid_argument", `Usage unit ${unit} must be a non-negative safe integer.`);
      }
    } else {
      assertDomain(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, "invalid_argument", `Usage ${key} must be a non-negative safe integer.`);
    }
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

function eventFingerprint(event: ChatTransportEvent): string {
  return stableSerialize(event);
}

function freezeState(state: ChatTransportStreamState): ChatTransportStreamState {
  return Object.freeze({
    ...state,
    items: Object.freeze(state.items.map((item) => Object.freeze({ ...item, citations: Object.freeze([...item.citations]) }))),
    toolCalls: Object.freeze(state.toolCalls.map((call) => Object.freeze({ ...call }))),
    citations: Object.freeze([...state.citations]),
    rateLimits: Object.freeze(state.rateLimits.map((limit) => Object.freeze({ ...limit }))),
    warnings: Object.freeze([...state.warnings]),
    unknownEvents: Object.freeze(state.unknownEvents.map((event) => Object.freeze({ ...event }))),
    identities: Object.freeze(state.identities.map((identity) => Object.freeze({ ...identity }))),
  });
}

export function createChatTransportStreamState(input: {
  readonly requestId: string;
  readonly attemptId: string;
}): ChatTransportStreamState {
  return freezeState({
    schemaVersion: 1,
    requestId: requireText(input.requestId, "requestId", 512),
    attemptId: requireText(input.attemptId, "attemptId", 512),
    status: "open",
    responseStarted: false,
    items: [],
    toolCalls: [],
    text: "",
    reasoningSummary: "",
    citations: [],
    rateLimits: [],
    warnings: [],
    unknownEvents: [],
    eventCount: 0,
    identities: [],
  });
}

function terminalStatus(event: ChatTransportEvent): ChatTransportStreamStatus | undefined {
  if (event.type === "response.failed") return "failed";
  if (event.type !== "response.completed") return undefined;
  if (event.finishReason === "cancelled") return "cancelled";
  if (event.finishReason === "error") return "failed";
  return "completed";
}

function effectiveUsage(state: ChatTransportStreamState, usage: NormalizedUsage, authoritative: boolean): NormalizedUsage {
  if (authoritative) return usage;
  if (state.authoritativeUsage !== undefined) return state.authoritativeUsage;
  return usage;
}

function mergeUsage(previous: NormalizedUsage | undefined, next: NormalizedUsage): NormalizedUsage {
  validateUsage(next);
  if (previous === undefined) return Object.freeze({ ...next });
  for (const key of ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const) {
    const previousValue = previous[key];
    const nextValue = next[key];
    assertDomain(nextValue === undefined || previousValue === undefined || nextValue >= previousValue, "invalid_state_transition", `Usage ${key} cannot decrease.`);
  }
  const providerUnits = { ...(previous.providerUnits ?? {}), ...(next.providerUnits ?? {}) };
  return Object.freeze({
    ...(previous.inputTokens === undefined && next.inputTokens === undefined ? {} : { inputTokens: next.inputTokens ?? previous.inputTokens }),
    ...(previous.cachedInputTokens === undefined && next.cachedInputTokens === undefined ? {} : { cachedInputTokens: next.cachedInputTokens ?? previous.cachedInputTokens }),
    ...(previous.cacheWriteTokens === undefined && next.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: next.cacheWriteTokens ?? previous.cacheWriteTokens }),
    ...(previous.outputTokens === undefined && next.outputTokens === undefined ? {} : { outputTokens: next.outputTokens ?? previous.outputTokens }),
    ...(previous.reasoningOutputTokens === undefined && next.reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens: next.reasoningOutputTokens ?? previous.reasoningOutputTokens }),
    ...(previous.totalTokens === undefined && next.totalTokens === undefined ? {} : { totalTokens: next.totalTokens ?? previous.totalTokens }),
    ...(Object.keys(providerUnits).length === 0 ? {} : { providerUnits: Object.freeze(providerUnits) }),
  });
}

function updateItem(items: readonly ChatTransportItemState[], itemId: string, update: (item: ChatTransportItemState) => ChatTransportItemState): readonly ChatTransportItemState[] {
  const index = items.findIndex((item) => item.itemId === itemId);
  if (index < 0) {
    const created: ChatTransportItemState = { itemId, itemKind: "unknown", completed: false, text: "", reasoningSummary: "", citations: [] };
    return [...items, update(created)];
  }
  return items.map((item, itemIndex) => (itemIndex === index ? update(item) : item));
}

function applyIdentity(state: ChatTransportStreamState, event: ChatTransportEvent): { state: ChatTransportStreamState; duplicate: boolean } {
  const fingerprint = eventFingerprint(event);
  const candidates: ChatTransportEventIdentity[] = [];
  if (event.providerEventId !== undefined && event.providerEventId.trim().length > 0) candidates.push({ kind: "provider-event-id", value: event.providerEventId, fingerprint });
  if (event.cursor !== undefined && event.cursor.trim().length > 0) candidates.push({ kind: "cursor", value: event.cursor, fingerprint });
  if (candidates.length === 0) return { state, duplicate: false };
  let duplicate = false;
  for (const candidate of candidates) {
    const existing = state.identities.find((identity) => identity.kind === candidate.kind && identity.value === candidate.value);
    if (existing !== undefined) {
      assertDomain(existing.fingerprint === fingerprint, "conflict", "Provider event identity was reused with different content.", { kind: candidate.kind, value: candidate.value });
      duplicate = true;
    }
  }
  if (duplicate) return { state, duplicate: true };
  return { state: { ...state, identities: [...state.identities, ...candidates] }, duplicate: false };
}

export function applyChatTransportEvent(
  state: ChatTransportStreamState,
  input: ChatTransportEvent | ChatTransportUnknownEvent,
): ChatTransportStreamState {
  const identityResult = input.type === "provider.unknown"
    ? { state, duplicate: false }
    : applyIdentity(state, input);
  if (identityResult.duplicate) return state;
  if (state.status !== "open") {
    throw new Error(`Cannot apply ${input.type} after stream terminalization.`);
  }
  if (input.type === "provider.unknown") {
    const unknownEvents = [...state.unknownEvents, input].slice(-MAX_DIAGNOSTICS);
    return freezeState({ ...identityResult.state, unknownEvents, eventCount: state.eventCount + 1 });
  }

  let next: ChatTransportStreamState = { ...identityResult.state, eventCount: state.eventCount + 1 };
  switch (input.type) {
    case "response.started":
      next = {
        ...next,
        responseStarted: true,
        ...(input.remoteRequestId === undefined ? {} : { remoteRequestId: input.remoteRequestId }),
        ...(input.remoteResponseId === undefined ? {} : { remoteResponseId: input.remoteResponseId }),
      };
      break;
    case "item.started":
      next = {
        ...next,
        items: updateItem(next.items, input.itemId, (item) => ({ ...item, itemKind: input.itemKind })),
      };
      break;
    case "text.delta":
      next = {
        ...next,
        text: `${next.text}${input.delta}`,
        items: updateItem(next.items, input.itemId, (item) => ({ ...item, text: `${item.text}${input.delta}` })),
      };
      break;
    case "reasoning_summary.delta":
      next = {
        ...next,
        reasoningSummary: `${next.reasoningSummary}${input.delta}`,
        items: updateItem(next.items, input.itemId, (item) => ({ ...item, reasoningSummary: `${item.reasoningSummary}${input.delta}` })),
      };
      break;
    case "citation":
      next = {
        ...next,
        citations: [...next.citations, input.citation],
        items: updateItem(next.items, input.itemId, (item) => ({ ...item, citations: [...item.citations, input.citation] })),
      };
      break;
    case "tool_call.started": {
      const existing = next.toolCalls.find((call) => call.callId === input.callId);
      assertDomain(existing === undefined, "conflict", `Tool call already started: ${input.callId}`);
      next = { ...next, toolCalls: [...next.toolCalls, { callId: input.callId, itemId: input.itemId, name: input.name, argumentsText: "", completed: false }] };
      break;
    }
    case "tool_call.arguments_delta": {
      const index = next.toolCalls.findIndex((call) => call.callId === input.callId);
      const calls = index < 0
        ? [...next.toolCalls, { callId: input.callId, argumentsText: input.delta, completed: false }]
        : next.toolCalls.map((call, callIndex) => callIndex === index ? { ...call, argumentsText: `${call.argumentsText}${input.delta}` } : call);
      next = { ...next, toolCalls: calls };
      break;
    }
    case "tool_call.completed": {
      const index = next.toolCalls.findIndex((call) => call.callId === input.callId);
      const calls = index < 0
        ? [...next.toolCalls, { callId: input.callId, argumentsText: input.argumentsJson, argumentsJson: input.argumentsJson, completed: true }]
        : next.toolCalls.map((call, callIndex) => callIndex === index ? { ...call, argumentsJson: input.argumentsJson, argumentsText: call.argumentsText || input.argumentsJson, completed: true } : call);
      next = { ...next, toolCalls: calls };
      break;
    }
    case "item.completed":
      next = { ...next, items: updateItem(next.items, input.itemId, (item) => ({ ...item, completed: true })) };
      break;
    case "usage.updated": {
      validateUsage(input.usage);
      if (input.authoritative) {
        next = { ...next, authoritativeUsage: Object.freeze({ ...input.usage }), usage: effectiveUsage(next, input.usage, true) };
      } else {
        const provisionalUsage = mergeUsage(next.provisionalUsage, input.usage);
        next = { ...next, provisionalUsage, usage: effectiveUsage(next, provisionalUsage, false) };
      }
      break;
    }
    case "rate_limit.updated":
      next = { ...next, rateLimits: input.limits };
      break;
    case "provider.warning":
      next = { ...next, warnings: [...next.warnings, boundedText(`${input.code}: ${input.message}`, MAX_WARNING_LENGTH)].slice(-MAX_DIAGNOSTICS) };
      break;
    case "response.completed":
      next = { ...next, status: terminalStatus(input) ?? "completed", finishReason: input.finishReason, terminalEventType: "response.completed" };
      break;
    case "response.failed":
      next = { ...next, status: "failed", error: input.error, finishReason: "error", terminalEventType: "response.failed" };
      break;
  }
  return freezeState(next);
}

export function closeChatTransportStream(
  state: ChatTransportStreamState,
  outcome: "interrupted" | "unknown" | "cancelled" = "unknown",
): ChatTransportStreamState {
  if (state.status !== "open") return state;
  return freezeState({ ...state, status: outcome, terminalEventType: "stream.closed" });
}

export const finalizeChatTransportStream = closeChatTransportStream;

export function normalizeProviderStreamEvent(
  input: unknown,
  protocol: ChatTransportProtocol = "custom",
): ChatTransportEvent | ChatTransportUnknownEvent {
  return normalizeRawProviderEvent(input, protocol);
}

export function classifyChatTransportError(input: ChatTransportFailureInput = {}): ChatTransportError {
  const category = input.category ?? (input.status === 401 || input.status === 403 ? "authentication" : input.status === 429 ? "rate-limit" : input.status !== undefined && input.status >= 500 ? "provider" : "unknown");
  const retryable = category === "network" || category === "timeout" || category === "rate-limit" || category === "provider";
  const acceptedByProvider = input.acceptedByProvider ?? (category === "authentication" || category === "validation" ? false : "unknown");
  return Object.freeze({
    code: boundedText(input.code ?? category, 160),
    category,
    message: boundedText(input.message ?? "Provider transport failed.", MAX_WARNING_LENGTH),
    retryable,
    acceptedByProvider,
    ...(input.code === undefined ? {} : { providerCode: boundedText(input.code, 160) }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
  });
}

function descriptor(
  id: string,
  protocol: ChatTransportProtocol,
  displayName: string,
  capabilities: readonly ChatTransportCapability[],
): ChatTransportAdapterDescriptor {
  return Object.freeze({ schemaVersion: 1, id, revision: "1", protocol, displayName, capabilities: Object.freeze([...capabilities]) });
}

function createDeclarativeAdapter(
  adapterDescriptor: ChatTransportAdapterDescriptor,
): ChatTransportAdapter {
  return {
    descriptor: () => adapterDescriptor,
    translate: (input) => translateRequest(input, adapterDescriptor),
    normalizeEvent: (input) => normalizeRawProviderEvent(input, adapterDescriptor.protocol) as ChatTransportEvent,
    classifyError: classifyChatTransportError,
  };
}

export function createBuiltInChatTransportAdapters(): readonly ChatTransportAdapter[] {
  return Object.freeze([
    createDeclarativeAdapter(descriptor("openai.responses", "responses", "OpenAI Responses", ["streaming", "reasoning-summary", "citations", "tools", "usage", "rate-limits", "cancellation", "retrieval"])),
    createDeclarativeAdapter(descriptor("anthropic.messages", "messages", "Anthropic Messages", ["streaming", "reasoning-summary", "tools", "usage", "rate-limits", "cancellation"])),
    createDeclarativeAdapter(descriptor("openai.chat-completions", "chat-completions", "OpenAI-compatible Chat Completions", ["streaming", "tools", "usage", "rate-limits", "cancellation"])),
    createDeclarativeAdapter(descriptor("custom.declarative", "custom", "Declarative custom adapter", ["streaming", "usage"])),
  ]);
}

export class ChatTransportAdapterRegistry {
  private readonly adapters = new Map<string, ChatTransportAdapter>();

  constructor(adapters: readonly ChatTransportAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ChatTransportAdapter): this {
    const adapterDescriptor = adapter.descriptor();
    assertDomain(adapterDescriptor.schemaVersion === 1, "invalid_argument", "Unsupported adapter descriptor schema.");
    assertDomain(adapterDescriptor.id.trim().length > 0, "invalid_argument", "Adapter id cannot be empty.");
    assertDomain(!this.adapters.has(adapterDescriptor.id), "conflict", `Adapter already registered: ${adapterDescriptor.id}`);
    this.adapters.set(adapterDescriptor.id, adapter);
    return this;
  }

  unregister(adapterId: string): boolean {
    return this.adapters.delete(adapterId);
  }

  resolve(adapterId: string): ChatTransportAdapter {
    const adapter = this.adapters.get(adapterId);
    assertDomain(adapter !== undefined, "not_found", `Unknown chat transport adapter: ${adapterId}`);
    return adapter;
  }

  resolveProtocol(protocol: ChatTransportProtocol): ChatTransportAdapter {
    const matches = [...this.adapters.values()].filter((adapter) => adapter.descriptor().protocol === protocol);
    assertDomain(matches.length === 1, matches.length === 0 ? "not_found" : "conflict", matches.length === 0 ? `No adapter registered for protocol: ${protocol}` : `Multiple adapters registered for protocol: ${protocol}`);
    return matches[0] as ChatTransportAdapter;
  }

  list(): readonly ChatTransportAdapter[] {
    return Object.freeze([...this.adapters.values()]);
  }
}

export function createChatTransportAdapterRegistry(includeBuiltIns = true): ChatTransportAdapterRegistry {
  return new ChatTransportAdapterRegistry(includeBuiltIns ? createBuiltInChatTransportAdapters() : []);
}
