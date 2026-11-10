import { assertDomain } from "./errors";
import type { FrozenCatalogModelSelection } from "./provider-catalog-health";
import type { ResolvedParameter, ResolvedParameterSet } from "./parameters";
import type { AttemptId } from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  freezeJson,
  type IsoTimestamp,
  type JsonObject,
  type JsonValue,
} from "./shared";

/**
 * Renderer/domain-side provider execution contracts.
 *
 * This module intentionally contains no transport, credential materialization,
 * policy, fallback, or IPC authority.  A native gateway may consume a frozen
 * projection of these values, but the adapter contract itself remains pure and
 * byte-free at the renderer boundary.
 */

export const PROVIDER_ADAPTER_PROTOCOL_FAMILIES = Object.freeze([
  "openai-responses",
  "openai-chat-completions",
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
] as const);

export type ProviderAdapterProtocolFamily =
  (typeof PROVIDER_ADAPTER_PROTOCOL_FAMILIES)[number];

export const PROVIDER_ADAPTER_OPERATIONS = Object.freeze([
  "responses",
  "chat-completions",
  "messages",
  "generate-content",
  "stream-content",
  "models",
  "custom",
] as const);

export type ProviderAdapterOperation = (typeof PROVIDER_ADAPTER_OPERATIONS)[number];

export type FrozenModelSelection = FrozenCatalogModelSelection;

export interface ProviderAdapterDescriptor {
  readonly id: string;
  readonly version: string;
  readonly protocol: ProviderAdapterProtocolFamily;
  readonly operations: readonly ProviderAdapterOperation[];
  /** Namespaced, bounded feature labels; these are declarations, not policy. */
  readonly features: readonly string[];
  /** A descriptor must promise deterministic translation for a frozen input. */
  readonly deterministicTranslation: true;
}

/** Compatibility name used by the provider SPI documentation. */
export type AdapterDescriptor = ProviderAdapterDescriptor;

export type CanonicalMessageRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool";

export type CanonicalInstructionAuthority =
  | "system"
  | "developer"
  | "user_instruction"
  | "untrusted_data";

export interface InstructionLayer {
  readonly id: string;
  readonly text: string;
  readonly authority?: CanonicalInstructionAuthority;
  readonly sourceRef?: string;
}

export interface CanonicalTextContent {
  readonly type: "input_text";
  readonly text: string;
  readonly sourceRef?: string;
}

export interface CanonicalImageContent {
  readonly type: "input_image";
  /** Opaque native-owned blob/attachment reference; never bytes or a URL. */
  readonly blobRef: string;
  readonly mediaType: string;
  readonly detail?: string;
}

export interface CanonicalAudioContent {
  readonly type: "input_audio";
  readonly blobRef: string;
  readonly mediaType: string;
}

export interface CanonicalFileContent {
  readonly type: "input_file";
  readonly blobRef: string;
  readonly mediaType: string;
  readonly filename: string;
}

export interface CanonicalToolCallContent {
  readonly type: "tool_call";
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
}

export interface CanonicalToolResultContent {
  readonly type: "tool_result";
  readonly callId: string;
  readonly result: readonly CanonicalContent[];
  readonly isError: boolean;
}

export interface CanonicalRefusalContent {
  readonly type: "refusal";
  readonly text: string;
}

export type CanonicalContent =
  | CanonicalTextContent
  | CanonicalImageContent
  | CanonicalAudioContent
  | CanonicalFileContent
  | CanonicalToolCallContent
  | CanonicalToolResultContent
  | CanonicalRefusalContent;

export interface CanonicalMessage {
  readonly id: string;
  readonly role: CanonicalMessageRole;
  readonly content: readonly CanonicalContent[];
  readonly name?: string;
}

export interface CanonicalToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly parameters: JsonObject;
  readonly strict?: boolean;
}

export type ResponseContract =
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

export interface CanonicalCitation {
  readonly sourceId: string;
  readonly title?: string;
  /** URI is provider data, bounded and redacted by adapters before projection. */
  readonly uri?: string;
  readonly locator?: string;
}

export interface CanonicalModelInput {
  readonly schemaVersion: 1;
  readonly attemptId: AttemptId | string;
  readonly model: FrozenModelSelection;
  readonly instructions: readonly InstructionLayer[];
  readonly messages: readonly CanonicalMessage[];
  readonly tools: readonly CanonicalToolDefinition[];
  readonly responseContract?: ResponseContract;
  readonly parameters: ResolvedParameterSet;
  readonly contextSnapshotId: string;
  readonly requestIdempotencyKey: string;
  readonly dataClasses: readonly string[];
  readonly providerExtensions: JsonObject;
}

export interface SecretRefConnection {
  readonly schemaVersion: 1;
  readonly connectionId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  /** Fingerprint of a native-owned endpoint; no URL is required by adapters. */
  readonly endpointFingerprint: string;
  readonly authScheme: string;
  /** Opaque vault handle only; never a credential/token. */
  readonly credentialRef?: string;
}

export interface ConnectionHealth {
  readonly state: "healthy" | "degraded" | "unavailable" | "unknown";
  readonly checkedAt: IsoTimestamp;
  readonly diagnosticCode?: string;
  readonly remoteRequestId?: string;
}

export interface DiscoveryInput {
  readonly connection: SecretRefConnection;
  readonly cursor?: string;
}

export type ModelCatalogEvent =
  | {
      readonly type: "model";
      readonly providerModelId: string;
      readonly displayName?: string;
      readonly metadata?: JsonObject;
    }
  | { readonly type: "page"; readonly cursor?: string; readonly complete: boolean }
  | { readonly type: "warning"; readonly code: string; readonly message: string };

export interface CapabilityProbeInput {
  readonly connection: SecretRefConnection;
  readonly model?: FrozenModelSelection;
}

export interface CapabilitySnapshot {
  readonly id: string;
  readonly adapterVersion: string;
  readonly observedAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly operations: readonly ProviderAdapterOperation[];
  readonly features: readonly string[];
  readonly metadata?: JsonObject;
}

export interface ProviderRunInput {
  readonly canonical: CanonicalModelInput;
  readonly capabilitySnapshot?: CapabilitySnapshot;
}

export interface ProviderValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly fieldPath?: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ProviderValidationIssue[];
}

export interface TokenEstimate {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly method: "provider" | "adapter" | "local" | "unknown";
  readonly confidence: "exact" | "estimated" | "unknown";
}

export type TranslationParameterStatus =
  | "sent"
  | "translated"
  | "emulated"
  | "unsupported"
  | "not-sent";

export interface TranslationParameterDecision {
  readonly key: string;
  readonly status: TranslationParameterStatus;
  readonly valueProvided: boolean;
  readonly providerField?: string;
  readonly reason?: string;
}

export interface TranslationNote {
  readonly code: string;
  readonly message: string;
  readonly fieldPath?: string;
  readonly severity: "info" | "warning" | "error";
}

export interface TranslatedProviderRequest {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly protocol: ProviderAdapterProtocolFamily;
  /** Native-owned transport may replace this object with a prepared payload. */
  readonly payload: JsonObject;
  readonly parameterDecisions: readonly TranslationParameterDecision[];
  readonly unsupportedParameters: readonly string[];
  readonly notes: readonly TranslationNote[];
  /** Stable non-cryptographic fingerprint for deterministic test/audit joins. */
  readonly translationFingerprint: string;
}

/** Names used by the earlier harness architecture draft. */
export type TranslatedRequest = TranslatedProviderRequest;
export type ProviderRequest = TranslatedProviderRequest;

export type ProviderErrorCategory =
  | "validation"
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "transport"
  | "protocol"
  | "provider"
  | "cancelled"
  | "unknown";

export type ProviderAcceptance = "not-sent" | "rejected" | "accepted" | "unknown";

export interface ProviderError {
  readonly category: ProviderErrorCategory;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly acceptance: ProviderAcceptance;
  readonly retryAfterMs?: number;
  readonly remoteRequestId?: string;
  readonly httpStatus?: number;
  readonly fieldPath?: string;
  /** Bounded, renderer-safe diagnostic facts; never a raw body or secret. */
  readonly safeDetails?: JsonObject;
}

export interface ProviderFailureInput {
  readonly category: ProviderErrorCategory;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly acceptance: ProviderAcceptance;
  readonly retryAfterMs?: number;
  readonly remoteRequestId?: string;
  readonly httpStatus?: number;
  readonly fieldPath?: string;
  readonly safeDetails?: JsonObject;
}

export interface ProviderRequestHandle {
  readonly attemptId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly remoteRequestId?: string;
  readonly remoteResponseId?: string;
  readonly cursor?: string;
  readonly acceptance: ProviderAcceptance;
  readonly idempotencyEffective: "enforced" | "best_effort" | "unsupported" | "unknown";
}

export type CancelOutcome =
  | { readonly state: "cancelled"; readonly handle: ProviderRequestHandle }
  | { readonly state: "already_terminal"; readonly handle: ProviderRequestHandle }
  | { readonly state: "outcome_unknown"; readonly handle: ProviderRequestHandle; readonly error: ProviderError }
  | { readonly state: "not_supported"; readonly handle: ProviderRequestHandle };

export interface ProviderAdapter {
  descriptor(): ProviderAdapterDescriptor;
  validateConnection(input: SecretRefConnection): Promise<ConnectionHealth>;
  discoverModels(input: DiscoveryInput): AsyncIterable<ModelCatalogEvent>;
  probeCapabilities(input: CapabilityProbeInput): Promise<CapabilitySnapshot>;
  validateRun(input: ProviderRunInput): Promise<ValidationResult>;
  estimateTokens(input: CanonicalModelInput): Promise<TokenEstimate>;
  translate(input: CanonicalModelInput): Promise<TranslatedProviderRequest>;
  execute(input: TranslatedProviderRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent>;
  cancel?(handle: ProviderRequestHandle): Promise<CancelOutcome>;
  retrieve?(handle: ProviderRequestHandle, cursor?: string): AsyncIterable<ProviderStreamEvent>;
  classifyError(input: ProviderFailureInput): ProviderError;
}

/** Explicit execution-oriented alias for consumers that avoid the SPI name. */
export type ProviderExecutionAdapter = ProviderAdapter;

export type NormalizedFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "refusal"
  | "cancelled"
  | "error"
  | "unknown";

export interface NormalizedUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly totalTokens?: number;
  readonly providerUnits?: Readonly<Record<string, number>>;
  readonly source?: "provider_final" | "provider_incremental" | "local_estimate" | "unknown";
}

export interface NormalizedRateLimit {
  readonly scope?: string;
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetAt?: IsoTimestamp;
  readonly retryAfterMs?: number;
}

interface ProviderEventBase {
  readonly attemptId?: string;
  /** Provider identity is the only basis on which duplicate events are ignored. */
  readonly providerEventId?: string;
}

export type ProviderStreamEvent =
  | (ProviderEventBase & {
      readonly type: "response.started";
      readonly remoteRequestId?: string;
      readonly remoteResponseId?: string;
    })
  | (ProviderEventBase & { readonly type: "item.started"; readonly itemId: string; readonly itemKind: string })
  | (ProviderEventBase & { readonly type: "text.delta"; readonly itemId: string; readonly delta: string })
  | (ProviderEventBase & {
      readonly type: "reasoning_summary.delta";
      readonly itemId: string;
      readonly delta: string;
    })
  | (ProviderEventBase & { readonly type: "citation"; readonly itemId: string; readonly citation: CanonicalCitation })
  | (ProviderEventBase & {
      readonly type: "tool_call.started";
      readonly itemId: string;
      readonly callId: string;
      readonly name: string;
    })
  | (ProviderEventBase & { readonly type: "tool_call.arguments_delta"; readonly callId: string; readonly delta: string })
  | (ProviderEventBase & {
      readonly type: "tool_call.completed";
      readonly callId: string;
      readonly argumentsJson: string;
    })
  | (ProviderEventBase & { readonly type: "item.completed"; readonly itemId: string })
  | (ProviderEventBase & {
      readonly type: "usage.updated";
      readonly usage: NormalizedUsage;
      readonly authoritative: boolean;
    })
  | (ProviderEventBase & { readonly type: "rate_limit.updated"; readonly limits: readonly NormalizedRateLimit[] })
  | (ProviderEventBase & { readonly type: "provider.warning"; readonly code: string; readonly message: string })
  | (ProviderEventBase & { readonly type: "provider.unknown"; readonly name: string; readonly details?: JsonObject })
  | (ProviderEventBase & { readonly type: "response.completed"; readonly finishReason: NormalizedFinishReason })
  | (ProviderEventBase & { readonly type: "response.failed"; readonly error: ProviderError });

export interface ProviderAttemptTerminalFact {
  readonly state: "completed" | "failed" | "outcome_unknown";
  readonly finishReason?: NormalizedFinishReason;
  readonly error?: ProviderError;
  readonly evidence: "provider" | "local-interruption";
}

export interface ProviderAttemptLifecycleState {
  readonly attemptId: string;
  readonly status: "open" | "completed" | "failed" | "outcome_unknown";
  readonly responseStarted: boolean;
  readonly remoteRequestId?: string;
  readonly remoteResponseId?: string;
  readonly textByItem: Readonly<Record<string, string>>;
  readonly reasoningByItem: Readonly<Record<string, string>>;
  readonly toolArgumentsByCall: Readonly<Record<string, string>>;
  readonly startedItems: Readonly<Record<string, string>>;
  readonly completedItems: readonly string[];
  readonly citations: readonly CanonicalCitation[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly usage?: NormalizedUsage;
  readonly rateLimits: readonly NormalizedRateLimit[];
  readonly seenProviderEventIds: readonly string[];
  readonly lateEvents: readonly { readonly type: string; readonly providerEventId?: string }[];
  readonly appliedEventCount: number;
  readonly terminalEventCount: number;
  readonly terminal?: ProviderAttemptTerminalFact;
}

export interface ProviderStreamReduction {
  readonly state: ProviderAttemptLifecycleState;
  readonly applied: boolean;
  readonly duplicate: boolean;
  readonly late: boolean;
  readonly terminalCreated: boolean;
}

const MAX_ID_LENGTH = 512;
const MAX_VERSION_LENGTH = 128;
const MAX_TEXT_LENGTH = 2 * 1024 * 1024;
const MAX_MESSAGES = 2_000;
const MAX_CONTENT_PARTS = 1_000;
const MAX_TOOLS = 512;
const MAX_EXTENSIONS = 512;
const MAX_DIAGNOSTIC_LENGTH = 512;
const MAX_EVENT_DELTA_LENGTH = 2 * 1024 * 1024;
const MAX_TOOL_ARGUMENTS_LENGTH = 2 * 1024 * 1024;
const MAX_CITATIONS = 4_096;

const SENSITIVE_KEY = /(?:api[-_]?key|access[-_]?token|auth(?:orization)?|credential|password|secret|private[-_]?key|cookie)/i;
const URL_OR_PATH_VALUE = /^(?:https?:|file:|data:|blob:|\\\\|[A-Za-z]:[\\/]|[\\/])/i;
const REDACTABLE_SECRET = /(?:bearer\s+|sk-[A-Za-z0-9]|-----BEGIN|api[-_]?key\s*[:=])/i;

function bounded(value: string, label: string, maximum: number): string {
  const normalized = assertNonBlank(value, label, maximum);
  return normalized;
}

function assertFiniteCount(value: number, label: string, maximum = 10_000): void {
  assertDomain(Number.isSafeInteger(value) && value >= 0 && value <= maximum, "invalid_argument", `${label} is out of bounds.`, {
    label,
    maximum,
  });
}

function assertSafeOpaqueReference(value: string, label: string): string {
  const normalized = bounded(value, label, MAX_ID_LENGTH);
  assertDomain(!URL_OR_PATH_VALUE.test(normalized), "scope_violation", `${label} must be an opaque native reference.`, {
    label,
  });
  return normalized;
}

function sanitizeMessage(value: string): string {
  return value
    .replace(REDACTABLE_SECRET, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function assertSafeJson(value: JsonValue, path: string, depth = 0, rejectTransportValues = false): void {
  assertDomain(depth <= 16, "invalid_argument", "Provider JSON exceeds the supported nesting depth.", { path });
  if (Array.isArray(value)) {
    assertDomain(value.length <= MAX_EXTENSIONS, "invalid_argument", "Provider JSON array is too large.", { path });
    value.forEach((entry, index) => assertSafeJson(entry, `${path}[${index}]`, depth + 1, rejectTransportValues));
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    assertDomain(entries.length <= MAX_EXTENSIONS, "invalid_argument", "Provider JSON object is too large.", { path });
    for (const [key, entry] of entries) {
      bounded(key, `${path}.${key}`, MAX_ID_LENGTH);
      assertDomain(!SENSITIVE_KEY.test(key), "scope_violation", "Provider extensions cannot contain secret-bearing fields.", {
        fieldPath: `${path}.${key}`,
      });
      assertSafeJson(entry, `${path}.${key}`, depth + 1, rejectTransportValues);
    }
    return;
  }
  if (typeof value === "string") {
    assertDomain(value.length <= MAX_TEXT_LENGTH, "invalid_argument", "Provider JSON string is too large.", { path });
    assertDomain(!REDACTABLE_SECRET.test(value), "scope_violation", "Provider JSON contains a secret-like value.", { path });
    if (rejectTransportValues) {
      assertDomain(!URL_OR_PATH_VALUE.test(value), "scope_violation", "Renderer provider data cannot contain raw URLs or filesystem paths.", {
        path,
      });
    }
  }
}

function freezeParameter(parameter: ResolvedParameter): ResolvedParameter {
  const result: Record<string, unknown> = { ...parameter };
  if (parameter.value !== undefined) result.value = freezeJson(parameter.value);
  if (parameter.validRange !== undefined) {
    result.validRange = Object.freeze({
      ...parameter.validRange,
      ...(parameter.validRange.enum === undefined ? {} : { enum: Object.freeze(parameter.validRange.enum.map((entry) => freezeJson(entry))) }),
    });
  }
  return Object.freeze(result) as unknown as ResolvedParameter;
}

function freezeParameters(parameters: ResolvedParameterSet): ResolvedParameterSet {
  return Object.freeze(
    Object.fromEntries(Object.entries(parameters).map(([key, value]) => [bounded(key, "parameter key", MAX_ID_LENGTH), freezeParameter(value)])),
  ) as ResolvedParameterSet;
}

function freezeContent(content: CanonicalContent, depth = 0): CanonicalContent {
  assertDomain(depth <= 16, "invalid_argument", "Canonical content nesting is too deep.");
  switch (content.type) {
    case "input_text":
      return Object.freeze({
        type: content.type,
        text: bounded(content.text, "input text", MAX_TEXT_LENGTH),
        ...(content.sourceRef === undefined ? {} : { sourceRef: assertSafeOpaqueReference(content.sourceRef, "text sourceRef") }),
      });
    case "input_image":
      return Object.freeze({
        type: content.type,
        blobRef: assertSafeOpaqueReference(content.blobRef, "image blobRef"),
        mediaType: bounded(content.mediaType.toLowerCase(), "image mediaType", 255),
        ...(content.detail === undefined ? {} : { detail: bounded(content.detail, "image detail", 64) }),
      });
    case "input_audio":
      return Object.freeze({
        type: content.type,
        blobRef: assertSafeOpaqueReference(content.blobRef, "audio blobRef"),
        mediaType: bounded(content.mediaType.toLowerCase(), "audio mediaType", 255),
      });
    case "input_file":
      return Object.freeze({
        type: content.type,
        blobRef: assertSafeOpaqueReference(content.blobRef, "file blobRef"),
        mediaType: bounded(content.mediaType.toLowerCase(), "file mediaType", 255),
        filename: bounded(content.filename, "file filename", 512),
      });
    case "tool_call":
      return Object.freeze({
        type: content.type,
        callId: bounded(content.callId, "tool callId", MAX_ID_LENGTH),
        toolName: bounded(content.toolName, "tool name", MAX_ID_LENGTH),
        argumentsJson: bounded(content.argumentsJson, "tool argumentsJson", MAX_TOOL_ARGUMENTS_LENGTH),
      });
    case "tool_result":
      assertFiniteCount(content.result.length, "tool result parts", MAX_CONTENT_PARTS);
      return Object.freeze({
        type: content.type,
        callId: bounded(content.callId, "tool result callId", MAX_ID_LENGTH),
        result: Object.freeze(content.result.map((entry) => freezeContent(entry, depth + 1))),
        isError: content.isError,
      });
    case "refusal":
      return Object.freeze({ type: content.type, text: bounded(content.text, "refusal text", MAX_TEXT_LENGTH) });
  }
}

function freezeResponseContract(contract: ResponseContract | undefined): ResponseContract | undefined {
  if (contract === undefined) return undefined;
  switch (contract.type) {
    case "text":
    case "json_object":
      return Object.freeze({ type: contract.type });
    case "json_schema":
      assertSafeJson(contract.schema, "responseContract.schema");
      return Object.freeze({
        type: contract.type,
        name: bounded(contract.name, "response schema name", MAX_ID_LENGTH),
        schema: freezeJson(contract.schema),
        strict: contract.strict,
      });
    case "provider_native":
      bounded(contract.namespace, "response provider namespace", MAX_ID_LENGTH);
      assertSafeJson(contract.value, "responseContract.value");
      return Object.freeze({
        type: contract.type,
        namespace: contract.namespace.trim(),
        value: freezeJson(contract.value),
      });
  }
}

function freezeCanonicalModel(model: FrozenModelSelection): FrozenModelSelection {
  bounded(model.providerModelId, "model.providerModelId", MAX_ID_LENGTH);
  bounded(model.modelProfileId, "model.modelProfileId", MAX_ID_LENGTH);
  bounded(model.providerConnectionId, "model.providerConnectionId", MAX_ID_LENGTH);
  bounded(model.providerDefinitionRevisionId, "model.providerDefinitionRevisionId", MAX_ID_LENGTH);
  bounded(model.endpointFingerprintSha256, "model.endpointFingerprintSha256", 128);
  bounded(model.adapterVersion, "model.adapterVersion", MAX_VERSION_LENGTH);
  bounded(model.catalogRevision, "model.catalogRevision", MAX_ID_LENGTH);
  bounded(model.modelDescriptorRevisionId, "model.modelDescriptorRevisionId", MAX_ID_LENGTH);
  assertIsoTimestamp(model.frozenAt, "model.frozenAt");
  return Object.freeze({ ...model });
}

function freezeProviderExtensions(extensions: JsonObject): JsonObject {
  assertSafeJson(extensions, "providerExtensions", 0, true);
  return freezeJson(extensions);
}

function freezeCanonicalInstructions(instructions: readonly InstructionLayer[]): readonly InstructionLayer[] {
  assertFiniteCount(instructions.length, "instruction layers", MAX_MESSAGES);
  return Object.freeze(
    instructions.map((instruction, index) =>
      Object.freeze({
        id: bounded(instruction.id, `instructions[${index}].id`, MAX_ID_LENGTH),
        text: bounded(instruction.text, `instructions[${index}].text`, MAX_TEXT_LENGTH),
        ...(instruction.authority === undefined ? {} : { authority: instruction.authority }),
        ...(instruction.sourceRef === undefined ? {} : { sourceRef: assertSafeOpaqueReference(instruction.sourceRef, `instructions[${index}].sourceRef`) }),
      }),
    ),
  );
}

function freezeCanonicalMessages(messages: readonly CanonicalMessage[]): readonly CanonicalMessage[] {
  assertFiniteCount(messages.length, "canonical messages", MAX_MESSAGES);
  return Object.freeze(
    messages.map((message, index) => {
      assertFiniteCount(message.content.length, `messages[${index}].content`, MAX_CONTENT_PARTS);
      return Object.freeze({
        id: bounded(message.id, `messages[${index}].id`, MAX_ID_LENGTH),
        role: message.role,
        content: Object.freeze(message.content.map((entry) => freezeContent(entry))),
        ...(message.name === undefined ? {} : { name: bounded(message.name, `messages[${index}].name`, MAX_ID_LENGTH) }),
      });
    }),
  );
}

function freezeCanonicalTools(tools: readonly CanonicalToolDefinition[]): readonly CanonicalToolDefinition[] {
  assertFiniteCount(tools.length, "canonical tools", MAX_TOOLS);
  return Object.freeze(
    tools.map((tool, index) => {
      bounded(tool.name, `tools[${index}].name`, MAX_ID_LENGTH);
      if (tool.description !== undefined) bounded(tool.description, `tools[${index}].description`, MAX_TEXT_LENGTH);
      assertSafeJson(tool.parameters, `tools[${index}].parameters`);
      return Object.freeze({
        name: tool.name.trim(),
        ...(tool.description === undefined ? {} : { description: tool.description.trim() }),
        parameters: freezeJson(tool.parameters),
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      });
    }),
  );
}

/** Validates and recursively freezes a canonical input before adapter work. */
export function freezeCanonicalProviderInput(input: CanonicalModelInput): CanonicalModelInput {
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Unsupported canonical provider input schema version.");
  const attemptId = bounded(String(input.attemptId), "attemptId", MAX_ID_LENGTH);
  const contextSnapshotId = bounded(input.contextSnapshotId, "contextSnapshotId", MAX_ID_LENGTH);
  const requestIdempotencyKey = bounded(input.requestIdempotencyKey, "requestIdempotencyKey", MAX_ID_LENGTH);
  assertFiniteCount(input.dataClasses.length, "dataClasses", MAX_EXTENSIONS);
  const dataClasses = Object.freeze(input.dataClasses.map((entry, index) => bounded(entry, `dataClasses[${index}]`, MAX_ID_LENGTH)));
  const responseContract = freezeResponseContract(input.responseContract);
  return Object.freeze({
    schemaVersion: 1,
    attemptId,
    model: freezeCanonicalModel(input.model),
    instructions: freezeCanonicalInstructions(input.instructions),
    messages: freezeCanonicalMessages(input.messages),
    tools: freezeCanonicalTools(input.tools),
    ...(responseContract === undefined ? {} : { responseContract }),
    parameters: freezeParameters(input.parameters),
    contextSnapshotId,
    requestIdempotencyKey,
    dataClasses,
    providerExtensions: freezeProviderExtensions(input.providerExtensions),
  });
}

/** Alias kept explicit for callers that want a validation-named operation. */
export const validateCanonicalProviderInput = freezeCanonicalProviderInput;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Stable, non-cryptographic fingerprint for tests and deterministic joins. */
export function fingerprintCanonicalProviderInput(input: CanonicalModelInput): string {
  const frozen = freezeCanonicalProviderInput(input);
  return `fnv1a32:${fnv1a(stableJson(frozen))}`;
}

function parameterDecisions(parameters: ResolvedParameterSet): readonly TranslationParameterDecision[] {
  return Object.freeze(
    Object.entries(parameters).map(([key, parameter]) => {
      const valueProvided = parameter.value !== undefined;
      const status: TranslationParameterStatus =
        !valueProvided
          ? "not-sent"
          : parameter.support === "unsupported"
            ? "unsupported"
            : parameter.support === "emulated"
              ? "emulated"
              : parameter.support === "translated"
                ? "translated"
                : parameter.sent
                  ? "sent"
                  : "not-sent";
      return Object.freeze({
        key,
        status,
        valueProvided,
        ...(parameter.providerField === undefined ? {} : { providerField: parameter.providerField }),
        ...(parameter.warning === undefined ? {} : { reason: parameter.warning }),
      });
    }),
  );
}

function validateTranslationDecisions(input: CanonicalModelInput, decisions: readonly TranslationParameterDecision[]): readonly TranslationParameterDecision[] {
  const expected = parameterDecisions(input.parameters);
  const byKey = new Map(decisions.map((decision) => [decision.key, decision]));
  for (const expectedDecision of expected) {
    const actual = byKey.get(expectedDecision.key);
    assertDomain(actual !== undefined, "invalid_parameter", "Provider translation omitted a parameter decision.", {
      key: expectedDecision.key,
    });
    if (expectedDecision.valueProvided && expectedDecision.status === "unsupported") {
      assertDomain(actual.status === "unsupported", "unsupported_capability", "An explicitly unsupported parameter was silently dropped.", {
        key: expectedDecision.key,
      });
    }
  }
  assertDomain(byKey.size === expected.length, "invalid_parameter", "Provider translation contains an unknown parameter decision.");
  return Object.freeze(decisions.map((decision) => Object.freeze({ ...decision })));
}

/** Builds a deterministic translated request while preserving unsupported fields. */
export function createTranslatedProviderRequest(
  input: CanonicalModelInput,
  descriptor: ProviderAdapterDescriptor,
  payload: JsonObject,
  decisions: readonly TranslationParameterDecision[] = parameterDecisions(input.parameters),
  notes: readonly TranslationNote[] = [],
): TranslatedProviderRequest {
  const frozenInput = freezeCanonicalProviderInput(input);
  assertSafeJson(payload, "translated.payload", 0, true);
  const normalizedDecisions = validateTranslationDecisions(frozenInput, decisions);
  const unsupportedParameters = Object.freeze(
    normalizedDecisions.filter((decision) => decision.valueProvided && decision.status === "unsupported").map((decision) => decision.key),
  );
  const normalizedNotes = Object.freeze(
    notes.map((note) =>
      Object.freeze({
        code: bounded(note.code, "translation note code", MAX_ID_LENGTH),
        message: sanitizeMessage(note.message),
        ...(note.fieldPath === undefined ? {} : { fieldPath: bounded(note.fieldPath, "translation note fieldPath", MAX_ID_LENGTH) }),
        severity: note.severity,
      }),
    ),
  );
  const result = {
    schemaVersion: 1 as const,
    attemptId: String(frozenInput.attemptId),
    adapterId: bounded(descriptor.id, "adapter id", MAX_ID_LENGTH),
    adapterVersion: bounded(descriptor.version, "adapter version", MAX_VERSION_LENGTH),
    protocol: descriptor.protocol,
    payload: freezeJson(payload),
    parameterDecisions: normalizedDecisions,
    unsupportedParameters,
    notes: normalizedNotes,
    translationFingerprint: "",
  } satisfies Omit<TranslatedProviderRequest, "translationFingerprint"> & { translationFingerprint: string };
  return Object.freeze({ ...result, translationFingerprint: `fnv1a32:${fnv1a(stableJson(result))}` });
}

export function assertTranslatedProviderRequest(
  input: CanonicalModelInput,
  translated: TranslatedProviderRequest,
): TranslatedProviderRequest {
  const frozenInput = freezeCanonicalProviderInput(input);
  assertDomain(String(frozenInput.attemptId) === translated.attemptId, "invalid_state_transition", "Translated request attempt binding does not match canonical input.");
  validateTranslationDecisions(frozenInput, translated.parameterDecisions);
  assertDomain(
    translated.unsupportedParameters.every((key) => translated.parameterDecisions.some((decision) => decision.key === key && decision.status === "unsupported")),
    "invalid_parameter",
    "Translated unsupported-parameter metadata is inconsistent.",
  );
  return translated;
}

function normalizeProviderError(input: ProviderFailureInput): ProviderError {
  const message = sanitizeMessage(input.message);
  const safeDetails = input.safeDetails === undefined ? undefined : freezeProviderExtensions(input.safeDetails);
  if (input.retryAfterMs !== undefined) assertFiniteCount(input.retryAfterMs, "retryAfterMs", 7 * 24 * 60 * 60 * 1000);
  if (input.httpStatus !== undefined) assertDomain(Number.isInteger(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599, "invalid_argument", "HTTP status is invalid.");
  return Object.freeze({
    category: input.category,
    code: bounded(input.code, "provider error code", MAX_ID_LENGTH),
    message,
    retryable: input.retryable,
    acceptance: input.acceptance,
    ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
    ...(input.remoteRequestId === undefined ? {} : { remoteRequestId: bounded(input.remoteRequestId, "remote request id", MAX_ID_LENGTH) }),
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    ...(input.fieldPath === undefined ? {} : { fieldPath: bounded(input.fieldPath, "provider error field path", MAX_ID_LENGTH) }),
    ...(safeDetails === undefined ? {} : { safeDetails }),
  });
}

export function createProviderError(input: ProviderFailureInput): ProviderError {
  return normalizeProviderError(input);
}

function createEmptyLifecycle(attemptId: string): ProviderAttemptLifecycleState {
  return Object.freeze({
    attemptId: bounded(attemptId, "attemptId", MAX_ID_LENGTH),
    status: "open",
    responseStarted: false,
    textByItem: Object.freeze({}),
    reasoningByItem: Object.freeze({}),
    toolArgumentsByCall: Object.freeze({}),
    startedItems: Object.freeze({}),
    completedItems: Object.freeze([]),
    citations: Object.freeze([]),
    warnings: Object.freeze([]),
    rateLimits: Object.freeze([]),
    seenProviderEventIds: Object.freeze([]),
    lateEvents: Object.freeze([]),
    appliedEventCount: 0,
    terminalEventCount: 0,
  });
}

export function createProviderAttemptLifecycle(attemptId: string): ProviderAttemptLifecycleState {
  return createEmptyLifecycle(attemptId);
}

function appendText(map: Readonly<Record<string, string>>, key: string, delta: string): Readonly<Record<string, string>> {
  const previous = map[key] ?? "";
  assertDomain(previous.length + delta.length <= MAX_TEXT_LENGTH, "invalid_argument", "Provider output exceeds the bounded text limit.", { key });
  return Object.freeze({ ...map, [key]: previous + delta });
}

function mergeUsage(previous: NormalizedUsage | undefined, next: NormalizedUsage, authoritative: boolean): NormalizedUsage {
  if (authoritative) {
    return Object.freeze({
      ...next,
      ...(next.providerUnits === undefined ? {} : { providerUnits: Object.freeze({ ...next.providerUnits }) }),
      source: next.source ?? "provider_final",
    });
  }
  const merged: Record<string, unknown> = { ...(previous ?? {}), ...next };
  const numericKeys: readonly (keyof NormalizedUsage)[] = ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
  for (const key of numericKeys) {
    const oldValue = previous?.[key];
    const newValue = next[key];
    if (typeof oldValue === "number" && typeof newValue === "number") merged[key] = Math.max(oldValue, newValue);
  }
  if (previous?.providerUnits !== undefined || next.providerUnits !== undefined) {
    merged.providerUnits = Object.freeze({ ...(previous?.providerUnits ?? {}), ...(next.providerUnits ?? {}) });
  }
  return Object.freeze(merged) as NormalizedUsage;
}

function eventLate(state: ProviderAttemptLifecycleState, event: ProviderStreamEvent): ProviderStreamReduction {
  const lateEvent = Object.freeze({
    type: event.type,
    ...(event.providerEventId === undefined ? {} : { providerEventId: event.providerEventId }),
  });
  return {
    state: Object.freeze({ ...state, lateEvents: Object.freeze([...state.lateEvents, lateEvent]) }),
    applied: false,
    duplicate: false,
    late: true,
    terminalCreated: false,
  };
}

function terminalState(
  state: ProviderAttemptLifecycleState,
  terminal: ProviderAttemptTerminalFact,
): ProviderAttemptLifecycleState {
  return Object.freeze({
    ...state,
    status: terminal.state,
    terminal,
    terminalEventCount: state.terminalEventCount + 1,
    appliedEventCount: state.appliedEventCount + 1,
  });
}

/** Applies one normalized provider event and enforces one terminal fact. */
export function reduceProviderStreamEvent(
  state: ProviderAttemptLifecycleState,
  event: ProviderStreamEvent,
): ProviderStreamReduction {
  if (event.attemptId !== undefined) {
    assertDomain(event.attemptId === state.attemptId, "invalid_state_transition", "Provider event belongs to a different attempt.", {
      expectedAttemptId: state.attemptId,
    });
  }
  if (event.providerEventId !== undefined && state.seenProviderEventIds.includes(event.providerEventId)) {
    return { state, applied: false, duplicate: true, late: false, terminalCreated: false };
  }
  if (state.terminal !== undefined) return eventLate(state, event);

  const seenProviderEventIds = event.providerEventId === undefined
    ? state.seenProviderEventIds
    : Object.freeze([...state.seenProviderEventIds, bounded(event.providerEventId, "provider event id", MAX_ID_LENGTH)]);
  const base = { ...state, seenProviderEventIds, appliedEventCount: state.appliedEventCount + 1 };
  switch (event.type) {
    case "response.started":
      return {
        state: Object.freeze({
          ...base,
          responseStarted: true,
          ...(event.remoteRequestId === undefined ? {} : { remoteRequestId: bounded(event.remoteRequestId, "remote request id", MAX_ID_LENGTH) }),
          ...(event.remoteResponseId === undefined ? {} : { remoteResponseId: bounded(event.remoteResponseId, "remote response id", MAX_ID_LENGTH) }),
        }),
        applied: true,
        duplicate: false,
        late: false,
        terminalCreated: false,
      };
    case "item.started":
      return {
        state: Object.freeze({ ...base, startedItems: Object.freeze({ ...state.startedItems, [bounded(event.itemId, "item id", MAX_ID_LENGTH)]: bounded(event.itemKind, "item kind", MAX_ID_LENGTH) }) }),
        applied: true,
        duplicate: false,
        late: false,
        terminalCreated: false,
      };
    case "text.delta":
      assertDomain(event.delta.length <= MAX_EVENT_DELTA_LENGTH, "invalid_argument", "Provider text delta is too large.");
      return {
        state: Object.freeze({ ...base, textByItem: appendText(state.textByItem, bounded(event.itemId, "item id", MAX_ID_LENGTH), event.delta) }),
        applied: true,
        duplicate: false,
        late: false,
        terminalCreated: false,
      };
    case "reasoning_summary.delta":
      assertDomain(event.delta.length <= MAX_EVENT_DELTA_LENGTH, "invalid_argument", "Provider reasoning delta is too large.");
      return {
        state: Object.freeze({ ...base, reasoningByItem: appendText(state.reasoningByItem, bounded(event.itemId, "item id", MAX_ID_LENGTH), event.delta) }),
        applied: true,
        duplicate: false,
        late: false,
        terminalCreated: false,
      };
    case "citation":
      assertFiniteCount(state.citations.length + 1, "provider citations", MAX_CITATIONS);
      return {
        state: Object.freeze({ ...base, citations: Object.freeze([...state.citations, Object.freeze({ ...event.citation })]) }),
        applied: true,
        duplicate: false,
        late: false,
        terminalCreated: false,
      };
    case "tool_call.started":
      return {
        state: Object.freeze({ ...base, startedItems: Object.freeze({ ...state.startedItems, [bounded(event.itemId, "item id", MAX_ID_LENGTH)]: "tool_call", }), toolArgumentsByCall: state.toolArgumentsByCall }),
        applied: true,
        duplicate: false,
        late: false,
        terminalCreated: false,
      };
    case "tool_call.arguments_delta":
      assertDomain(event.delta.length <= MAX_EVENT_DELTA_LENGTH, "invalid_argument", "Provider tool arguments delta is too large.");
      return {
        state: Object.freeze({ ...base, toolArgumentsByCall: appendText(state.toolArgumentsByCall, bounded(event.callId, "tool callId", MAX_ID_LENGTH), event.delta) }),
        applied: true,
        duplicate: false,
        late: false,
        terminalCreated: false,
      };
    case "tool_call.completed":
      bounded(event.argumentsJson, "tool argumentsJson", MAX_TOOL_ARGUMENTS_LENGTH);
      return {
        state: Object.freeze({ ...base, toolArgumentsByCall: Object.freeze({ ...state.toolArgumentsByCall, [bounded(event.callId, "tool callId", MAX_ID_LENGTH)]: event.argumentsJson }) }),
        applied: true,
        duplicate: false,
        late: false,
        terminalCreated: false,
      };
    case "item.completed":
      return {
        state: Object.freeze({ ...base, completedItems: state.completedItems.includes(event.itemId) ? state.completedItems : Object.freeze([...state.completedItems, bounded(event.itemId, "item id", MAX_ID_LENGTH)]) }),
        applied: true,
        duplicate: false,
        late: false,
        terminalCreated: false,
      };
    case "usage.updated":
      return {
        state: Object.freeze({ ...base, usage: mergeUsage(state.usage, event.usage, event.authoritative) }),
        applied: true,
        duplicate: false,
        late: false,
        terminalCreated: false,
      };
    case "rate_limit.updated":
      return {
        state: Object.freeze({ ...base, rateLimits: Object.freeze(event.limits.map((limit) => Object.freeze({ ...limit }))) }),
        applied: true,
        duplicate: false,
        late: false,
        terminalCreated: false,
      };
    case "provider.warning":
      return {
        state: Object.freeze({ ...base, warnings: Object.freeze([...state.warnings, Object.freeze({ code: bounded(event.code, "warning code", MAX_ID_LENGTH), message: sanitizeMessage(event.message) })]) }),
        applied: true,
        duplicate: false,
        late: false,
        terminalCreated: false,
      };
    case "provider.unknown":
      return {
        state: Object.freeze({ ...base, warnings: Object.freeze([...state.warnings, Object.freeze({ code: `unknown:${bounded(event.name, "unknown event name", MAX_ID_LENGTH)}`, message: "Unknown provider event retained as a bounded diagnostic." })]) }),
        applied: true,
        duplicate: false,
        late: false,
        terminalCreated: false,
      };
    case "response.completed": {
      const next = terminalState(state, {
        state: "completed",
        finishReason: event.finishReason,
        evidence: "provider",
      });
      return { state: Object.freeze({ ...next, seenProviderEventIds }), applied: true, duplicate: false, late: false, terminalCreated: true };
    }
    case "response.failed": {
      const error = normalizeProviderError({
        category: event.error.category,
        code: event.error.code,
        message: event.error.message,
        retryable: event.error.retryable,
        acceptance: event.error.acceptance,
        ...(event.error.retryAfterMs === undefined ? {} : { retryAfterMs: event.error.retryAfterMs }),
        ...(event.error.remoteRequestId === undefined ? {} : { remoteRequestId: event.error.remoteRequestId }),
        ...(event.error.httpStatus === undefined ? {} : { httpStatus: event.error.httpStatus }),
        ...(event.error.fieldPath === undefined ? {} : { fieldPath: event.error.fieldPath }),
        ...(event.error.safeDetails === undefined ? {} : { safeDetails: event.error.safeDetails }),
      });
      const stateValue = error.acceptance === "unknown" ? "outcome_unknown" : "failed";
      const next = terminalState(state, { state: stateValue, error, evidence: "provider" });
      return { state: Object.freeze({ ...next, seenProviderEventIds }), applied: true, duplicate: false, late: false, terminalCreated: true };
    }
  }
}

/** Converts clean EOF/cancellation without terminal evidence into outcome-unknown. */
export function finalizeProviderStream(state: ProviderAttemptLifecycleState, reason = "provider_stream_interrupted"): ProviderAttemptLifecycleState {
  if (state.terminal !== undefined) return state;
  const error = normalizeProviderError({
    category: "transport",
    code: bounded(reason, "interruption code", MAX_ID_LENGTH),
    message: "Provider stream ended without terminal evidence; outcome is unknown.",
    retryable: false,
    acceptance: state.responseStarted ? "unknown" : "not-sent",
  });
  return terminalState(state, { state: "outcome_unknown", error, evidence: "local-interruption" });
}

export const finalizeProviderAttempt = finalizeProviderStream;
export const applyProviderStreamEvent = reduceProviderStreamEvent;

function descriptorKey(descriptor: ProviderAdapterDescriptor): string {
  return `${descriptor.id}@${descriptor.version}`;
}

function validateDescriptor(descriptor: ProviderAdapterDescriptor): ProviderAdapterDescriptor {
  const id = bounded(descriptor.id, "adapter id", MAX_ID_LENGTH);
  const version = bounded(descriptor.version, "adapter version", MAX_VERSION_LENGTH);
  assertDomain(PROVIDER_ADAPTER_PROTOCOL_FAMILIES.includes(descriptor.protocol), "invalid_argument", "Unknown provider adapter protocol.");
  assertDomain(descriptor.deterministicTranslation === true, "invalid_argument", "Provider adapters must promise deterministic translation.");
  const operations = Object.freeze([...new Set(descriptor.operations)]);
  assertDomain(operations.length === descriptor.operations.length, "conflict", "Provider adapter operations must be unique.");
  operations.forEach((operation) => assertDomain(PROVIDER_ADAPTER_OPERATIONS.includes(operation), "invalid_argument", "Unknown provider adapter operation."));
  const features = Object.freeze(descriptor.features.map((feature, index) => bounded(feature, `adapter feature ${index}`, MAX_ID_LENGTH)));
  return Object.freeze({ id, version, protocol: descriptor.protocol, operations, features, deterministicTranslation: true });
}

/** In-memory registry only; registration grants no network or credential authority. */
export class ProviderExecutionAdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(adapters: readonly ProviderAdapter[] = []) {
    adapters.forEach((adapter) => this.register(adapter));
  }

  register(adapter: ProviderAdapter): void {
    const descriptor = validateDescriptor(adapter.descriptor());
    const key = descriptorKey(descriptor);
    assertDomain(!this.adapters.has(key), "conflict", "Provider adapter version is already registered.", { key });
    this.adapters.set(key, adapter);
  }

  unregister(adapterId: string, version: string): boolean {
    return this.adapters.delete(descriptorKey({
      id: bounded(adapterId, "adapter id", MAX_ID_LENGTH),
      version: bounded(version, "adapter version", MAX_VERSION_LENGTH),
      protocol: "custom",
      operations: [],
      features: [],
      deterministicTranslation: true,
    }));
  }

  resolve(adapterId: string, version?: string): ProviderAdapter {
    const normalizedId = bounded(adapterId, "adapter id", MAX_ID_LENGTH);
    if (version !== undefined) {
      const adapter = this.adapters.get(`${normalizedId}@${bounded(version, "adapter version", MAX_VERSION_LENGTH)}`);
      assertDomain(adapter !== undefined, "not_found", "Provider adapter version is not registered.", { adapterId: normalizedId, version });
      return adapter;
    }
    const candidates = [...this.adapters.entries()].filter(([key]) => key.startsWith(`${normalizedId}@`));
    assertDomain(candidates.length > 0, "not_found", "Provider adapter is not registered.", { adapterId: normalizedId });
    candidates.sort(([left], [right]) => left.localeCompare(right));
    return candidates[candidates.length - 1]![1];
  }

  list(): readonly ProviderAdapterDescriptor[] {
    return Object.freeze([...this.adapters.values()].map((adapter) => validateDescriptor(adapter.descriptor())));
  }

  get size(): number {
    return this.adapters.size;
  }
}

/** Compatibility alias for callers that use the shorter registry name. */
export const ProviderAdapterRegistry = ProviderExecutionAdapterRegistry;

export function validateSecretRefConnection(input: SecretRefConnection): SecretRefConnection {
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Unsupported secret-ref connection schema version.");
  const credentialRef = input.credentialRef === undefined ? undefined : assertSafeOpaqueReference(input.credentialRef, "credentialRef");
  return Object.freeze({
    schemaVersion: 1,
    connectionId: bounded(input.connectionId, "connectionId", MAX_ID_LENGTH),
    adapterId: bounded(input.adapterId, "adapterId", MAX_ID_LENGTH),
    adapterVersion: bounded(input.adapterVersion, "adapterVersion", MAX_VERSION_LENGTH),
    endpointFingerprint: bounded(input.endpointFingerprint, "endpointFingerprint", MAX_ID_LENGTH),
    authScheme: bounded(input.authScheme, "authScheme", MAX_ID_LENGTH),
    ...(credentialRef === undefined ? {} : { credentialRef }),
  });
}

/** Bounded/sanitized error classification helper for adapter implementations. */
export function classifyProviderFailure(input: ProviderFailureInput): ProviderError {
  return normalizeProviderError(input);
}
