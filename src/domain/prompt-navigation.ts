import { assertDomain } from "./errors";
import {
  getConversationBranch,
  resolveBranchMessages,
  type Conversation,
  type Message,
  type MessageRole,
  type MessageStatus,
} from "./conversation";
import type {
  BranchId,
  ConversationId,
  MessageId,
  ModelProfileId,
  ProviderConnectionId,
  RunId,
} from "./ids";
import {
  assertIntegerInRange,
  assertIsoTimestamp,
  assertNonBlank,
  type IsoTimestamp,
} from "./shared";

/**
 * Stable, message-backed navigation kinds. The larger conversation-navigation
 * schema contains additional artifact/run/source kinds; those require a native
 * evidence index and are intentionally not fabricated by this local resolver.
 */
export type JumpTargetKind =
  | "user-prompt"
  | "assistant-response"
  | "message-revision"
  | "first-message"
  | "last-message"
  | "next-prompt"
  | "previous-prompt"
  | "first-visible-output"
  | "latest-output"
  | "query";

export type JumpDirection = "forward" | "backward";

export interface JumpAnchor {
  readonly conversationId: ConversationId;
  readonly branchId: BranchId;
  /** Native event cursor when available; message sequence is used by the local projection. */
  readonly eventCursor: number;
  readonly messageId?: MessageId;
  readonly messageRevisionId?: string;
  readonly selectionId?: string;
  readonly timestampMs?: number;
  /** A bounded, content-free fingerprint used to detect stale targets. */
  readonly semanticFingerprint?: string;
}

export interface JumpTarget {
  readonly targetId: string;
  readonly kind: JumpTargetKind;
  readonly source: JumpAnchor;
  readonly query?: string;
  readonly sourceRevision?: string;
  readonly createdAt: IsoTimestamp;
  readonly stale: boolean;
}

export interface CreateMessageJumpTargetInput {
  readonly targetId?: string;
  readonly kind?: Extract<JumpTargetKind, "user-prompt" | "assistant-response" | "message-revision">;
  readonly conversation: Conversation;
  readonly branchId: BranchId;
  readonly messageId: MessageId;
  readonly eventCursor?: number;
  readonly messageRevisionId?: string;
  readonly selectionId?: string;
  readonly sourceRevision?: string;
  readonly now: IsoTimestamp;
}

export interface CreateBoundaryJumpTargetInput {
  readonly targetId?: string;
  readonly kind: Extract<JumpTargetKind, "first-message" | "last-message" | "first-visible-output" | "latest-output">;
  readonly conversation: Conversation;
  readonly branchId: BranchId;
  readonly eventCursor?: number;
  readonly sourceRevision?: string;
  readonly now: IsoTimestamp;
}

export interface CreateRelativeJumpTargetInput {
  readonly targetId?: string;
  readonly kind: Extract<JumpTargetKind, "next-prompt" | "previous-prompt">;
  readonly conversation: Conversation;
  readonly branchId: BranchId;
  /** Optional message to navigate relative to; omitted means branch start/end. */
  readonly fromMessageId?: MessageId;
  readonly eventCursor?: number;
  readonly sourceRevision?: string;
  readonly now: IsoTimestamp;
}

export interface CreateQueryJumpTargetInput {
  readonly targetId?: string;
  readonly conversation: Conversation;
  readonly branchId: BranchId;
  readonly query: string;
  readonly eventCursor?: number;
  readonly sourceRevision?: string;
  readonly now: IsoTimestamp;
}

export interface JumpSearchFilter {
  readonly text?: string;
  readonly role?: MessageRole;
  readonly status?: MessageStatus;
  /** Match only messages produced through this provider connection. */
  readonly providerConnectionId?: ProviderConnectionId;
  /** Match only messages attributed to this model profile. */
  readonly modelProfileId?: ModelProfileId;
  /** Match the provider-native model identifier recorded on the message. */
  readonly providerModelId?: string;
  /** Match messages emitted by a particular run. */
  readonly producingRunId?: RunId;
  /** Inclusive lower bound for message creation time in epoch milliseconds. */
  readonly createdAfterMs?: number;
  /** Inclusive upper bound for message creation time in epoch milliseconds. */
  readonly createdBeforeMs?: number;
  readonly includeSuperseded?: boolean;
  readonly limit?: number;
}

export interface JumpSearchResult {
  readonly target: JumpTarget;
  readonly message: Message;
  readonly branchIndex: number;
}

export type JumpResolutionStatus = "resolved" | "stale" | "unsupported";

export interface JumpResolution {
  readonly status: JumpResolutionStatus;
  readonly target: JumpTarget;
  readonly message?: Message;
  readonly branchIndex?: number;
  readonly reason?:
    | "target-marked-stale"
    | "message-not-visible-on-branch"
    | "message-superseded"
    | "semantic-fingerprint-mismatch"
    | "no-match"
    | "unsupported-target-kind";
}

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 500;
const MAX_FINGERPRINT_LENGTH = 256;

const JUMP_TARGET_KINDS: readonly JumpTargetKind[] = [
  "user-prompt",
  "assistant-response",
  "message-revision",
  "first-message",
  "last-message",
  "next-prompt",
  "previous-prompt",
  "first-visible-output",
  "latest-output",
  "query",
];

const BOUNDARY_JUMP_KINDS: readonly Extract<
  JumpTargetKind,
  "first-message" | "last-message" | "first-visible-output" | "latest-output"
>[] = [
  "first-message",
  "last-message",
  "first-visible-output",
  "latest-output",
];

const RELATIVE_JUMP_KINDS: readonly Extract<JumpTargetKind, "next-prompt" | "previous-prompt">[] = [
  "next-prompt",
  "previous-prompt",
];

const MESSAGE_ROLES: readonly MessageRole[] = ["system", "developer", "user", "assistant", "tool"];
const MESSAGE_STATUSES: readonly MessageStatus[] = [
  "pending-local",
  "queued",
  "streaming",
  "complete",
  "stopped",
  "failed",
  "superseded",
];

function isBoundaryJumpKind(
  value: unknown,
): value is Extract<JumpTargetKind, "first-message" | "last-message" | "first-visible-output" | "latest-output"> {
  return typeof value === "string" && BOUNDARY_JUMP_KINDS.includes(value as never);
}

function isRelativeJumpKind(value: unknown): value is Extract<JumpTargetKind, "next-prompt" | "previous-prompt"> {
  return typeof value === "string" && RELATIVE_JUMP_KINDS.includes(value as never);
}

function isMessageRole(value: unknown): value is MessageRole {
  return typeof value === "string" && MESSAGE_ROLES.includes(value as MessageRole);
}

function isMessageStatus(value: unknown): value is MessageStatus {
  return typeof value === "string" && MESSAGE_STATUSES.includes(value as MessageStatus);
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function isJumpTargetKind(value: unknown): value is JumpTargetKind {
  return typeof value === "string" && JUMP_TARGET_KINDS.includes(value as JumpTargetKind);
}

/**
 * Produces a deterministic, bounded, content-free digest for local stale
 * detection. Native state-revision hashes remain authoritative for durable
 * replay and cross-process deep links.
 */
function boundedTextDigest(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b1;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    first = Math.imul(first ^ codeUnit, 0x01000193);
    second = Math.imul(second ^ (codeUnit + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

/**
 * Creates a bounded fingerprint without retaining the prompt text in the
 * navigation record. This is deliberately not a cryptographic hash; native
 * state-revision hashes remain authoritative for durable replay.
 */
export function messageSemanticFingerprint(message: Message): string {
  const normalizedText = normalizeSearchText(message.contentText);
  const sample =
    normalizedText.length <= 512
      ? normalizedText
      : `${normalizedText.slice(0, 256)}|${normalizedText.slice(-256)}`;
  const fingerprint = `${message.id}|${message.role}|${message.sequence}|${normalizedText.length}|${boundedTextDigest(sample)}`;
  return fingerprint.slice(0, MAX_FINGERPRINT_LENGTH);
}

function messageKind(message: Message): Extract<JumpTargetKind, "user-prompt" | "assistant-response" | "message-revision"> {
  if (message.role === "user") return "user-prompt";
  if (message.role === "assistant") return "assistant-response";
  return "message-revision";
}

function assertTargetIdentity(targetId: string | undefined, fallback: string): string {
  return assertString(targetId ?? fallback, "targetId", 256);
}

function assertString(value: unknown, label: string, maxLength: number): string {
  assertDomain(typeof value === "string", "invalid_argument", `${label} must be a string.`, { label });
  return assertNonBlank(value, label, maxLength);
}

function assertAnchorValues(anchor: JumpAnchor): void {
  assertDomain(anchor !== null && typeof anchor === "object", "invalid_argument", "Jump anchor must be an object.");
  assertString(anchor.conversationId, "anchor conversationId", 256);
  assertString(anchor.branchId, "anchor branchId", 256);
  assertIntegerInRange(anchor.eventCursor, "anchor eventCursor", 0, Number.MAX_SAFE_INTEGER);
  if (anchor.messageId !== undefined) assertString(anchor.messageId, "anchor messageId", 256);
  if (anchor.messageRevisionId !== undefined) assertString(anchor.messageRevisionId, "anchor messageRevisionId", 256);
  if (anchor.selectionId !== undefined) assertString(anchor.selectionId, "anchor selectionId", 256);
  if (anchor.semanticFingerprint !== undefined) {
    assertString(anchor.semanticFingerprint, "anchor semanticFingerprint", MAX_FINGERPRINT_LENGTH);
  }
  if (anchor.timestampMs !== undefined) {
    assertIntegerInRange(anchor.timestampMs, "anchor timestampMs", 0, Number.MAX_SAFE_INTEGER);
  }
}

function assertJumpTarget(target: JumpTarget): void {
  assertDomain(target !== null && typeof target === "object", "invalid_argument", "Jump target must be an object.");
  assertString(target.targetId, "targetId", 256);
  assertDomain(isJumpTargetKind(target.kind), "invalid_argument", "Unsupported jump target kind.", {
    kind: target.kind,
  });
  assertIsoTimestamp(target.createdAt, "jump target creation time");
  assertAnchorValues(target.source);
  if (target.query !== undefined) assertString(target.query, "target query", 4096);
  if (target.sourceRevision !== undefined) {
    assertString(target.sourceRevision, "sourceRevision", 256);
  }
  assertDomain(typeof target.stale === "boolean", "invalid_argument", "Jump target stale flag must be boolean.");
  const boundaryKind =
    target.kind === "first-message" ||
    target.kind === "last-message" ||
    target.kind === "first-visible-output" ||
    target.kind === "latest-output";
  const messageKind =
    target.kind === "user-prompt" ||
    target.kind === "assistant-response" ||
    target.kind === "message-revision";
  const relativeKind = target.kind === "next-prompt" || target.kind === "previous-prompt";
  if (messageKind) {
    assertDomain(target.source.messageId !== undefined, "invalid_argument", "Message jump target requires messageId.", {
      targetId: target.targetId,
      kind: target.kind,
    });
  }
  if (target.kind === "query") {
    assertDomain(target.query !== undefined, "invalid_argument", "Query jump targets require a query.", {
      targetId: target.targetId,
    });
    assertDomain(target.source.messageId === undefined, "invalid_argument", "Query jump targets cannot carry a messageId.", {
      targetId: target.targetId,
    });
  }
  if (relativeKind && target.query !== undefined) {
    assertDomain(false, "invalid_argument", "Relative prompt targets cannot carry a query.", {
      targetId: target.targetId,
      kind: target.kind,
    });
  }
  if (boundaryKind && target.query !== undefined) {
    assertDomain(false, "invalid_argument", "Boundary jump targets cannot carry a query.", {
      targetId: target.targetId,
      kind: target.kind,
    });
  }
}

function assertConversationScope(conversation: Conversation, branchId: BranchId): void {
  getConversationBranch(conversation, branchId);
}

function assertSearchFilter(filter: JumpSearchFilter): void {
  assertDomain(filter !== null && typeof filter === "object" && !Array.isArray(filter), "invalid_argument", "Jump search filter must be an object.");
  if (filter.text !== undefined) {
    assertDomain(typeof filter.text === "string", "invalid_argument", "Jump search text must be a string.");
    assertDomain(filter.text.length <= 4096, "invalid_argument", "Jump search text cannot exceed 4096 characters.");
  }
  if (filter.role !== undefined) {
    assertDomain(isMessageRole(filter.role), "invalid_argument", "Jump search role is unsupported.", { role: filter.role });
  }
  if (filter.status !== undefined) {
    assertDomain(isMessageStatus(filter.status), "invalid_argument", "Jump search status is unsupported.", { status: filter.status });
  }
  if (filter.providerConnectionId !== undefined) assertString(filter.providerConnectionId, "providerConnectionId", 256);
  if (filter.modelProfileId !== undefined) assertString(filter.modelProfileId, "modelProfileId", 256);
  if (filter.providerModelId !== undefined) assertString(filter.providerModelId, "providerModelId", 256);
  if (filter.producingRunId !== undefined) assertString(filter.producingRunId, "producingRunId", 256);
  if (filter.createdAfterMs !== undefined) {
    assertIntegerInRange(filter.createdAfterMs, "createdAfterMs", 0, Number.MAX_SAFE_INTEGER);
  }
  if (filter.createdBeforeMs !== undefined) {
    assertIntegerInRange(filter.createdBeforeMs, "createdBeforeMs", 0, Number.MAX_SAFE_INTEGER);
  }
  if (filter.createdAfterMs !== undefined && filter.createdBeforeMs !== undefined) {
    assertDomain(
      filter.createdAfterMs <= filter.createdBeforeMs,
      "invalid_argument",
      "createdAfterMs must be less than or equal to createdBeforeMs.",
      { createdAfterMs: filter.createdAfterMs, createdBeforeMs: filter.createdBeforeMs },
    );
  }
}

function visibleMessageAt(
  conversation: Conversation,
  branchId: BranchId,
  messageId: MessageId,
): { message: Message; branchIndex: number } {
  const path = resolveBranchMessages(conversation, branchId);
  const branchIndex = path.findIndex((message) => message.id === messageId);
  assertDomain(
    branchIndex >= 0,
    "scope_violation",
    "The requested jump message is not visible on the selected branch.",
    { conversationId: conversation.id, branchId, messageId },
  );
  const message = path[branchIndex];
  assertDomain(message !== undefined, "not_found", "The requested jump message was not found.", { messageId });
  return { message, branchIndex };
}

export function createMessageJumpTarget(input: CreateMessageJumpTargetInput): JumpTarget {
  assertIsoTimestamp(input.now, "jump target creation time");
  assertConversationScope(input.conversation, input.branchId);
  const { message } = visibleMessageAt(input.conversation, input.branchId, input.messageId);
  const kind = input.kind ?? messageKind(message);
  assertDomain(
    (kind === "user-prompt" && message.role === "user") ||
      (kind === "assistant-response" && message.role === "assistant") ||
      kind === "message-revision",
    "invalid_argument",
    "Jump target kind does not match the message role.",
    { messageId: message.id, kind, role: message.role },
  );
  const eventCursor = input.eventCursor ?? message.sequence;
  assertIntegerInRange(eventCursor, "jump eventCursor", 0, Number.MAX_SAFE_INTEGER);
  const source: JumpAnchor = Object.freeze({
    conversationId: input.conversation.id,
    branchId: input.branchId,
    eventCursor,
    messageId: message.id,
    ...(input.messageRevisionId === undefined ? {} : { messageRevisionId: input.messageRevisionId }),
    ...(input.selectionId === undefined ? {} : { selectionId: input.selectionId }),
    semanticFingerprint: messageSemanticFingerprint(message),
  });
  assertAnchorValues(source);
  return Object.freeze({
    targetId: assertTargetIdentity(
      input.targetId,
      `jump:${input.conversation.id}:${input.branchId}:${message.id}:${kind}`,
    ),
    kind,
    source,
    createdAt: input.now,
    ...(input.sourceRevision === undefined ? {} : { sourceRevision: assertString(input.sourceRevision, "sourceRevision", 256) }),
    stale: message.status === "superseded",
  });
}

export function createBoundaryJumpTarget(input: CreateBoundaryJumpTargetInput): JumpTarget {
  assertIsoTimestamp(input.now, "jump target creation time");
  assertDomain(isBoundaryJumpKind(input.kind), "invalid_argument", "Unsupported boundary jump target kind.", {
    kind: input.kind,
  });
  assertConversationScope(input.conversation, input.branchId);
  const selected = boundaryMessageForKind(input.conversation, input.branchId, input.kind);
  const eventCursor = input.eventCursor ?? selected?.message.sequence ?? 0;
  assertIntegerInRange(eventCursor, "jump eventCursor", 0, Number.MAX_SAFE_INTEGER);
  const source: JumpAnchor = Object.freeze({
    conversationId: input.conversation.id,
    branchId: input.branchId,
    eventCursor,
    ...(selected === undefined
      ? {}
      : {
          messageId: selected.message.id,
          semanticFingerprint: messageSemanticFingerprint(selected.message),
        }),
  });
  assertAnchorValues(source);
  return Object.freeze({
    targetId: assertTargetIdentity(input.targetId, `jump:${input.conversation.id}:${input.branchId}:${input.kind}`),
    kind: input.kind,
    source,
    createdAt: input.now,
    ...(input.sourceRevision === undefined ? {} : { sourceRevision: assertString(input.sourceRevision, "sourceRevision", 256) }),
    stale: selected?.message.status === "superseded",
  });
}

export function createRelativeJumpTarget(input: CreateRelativeJumpTargetInput): JumpTarget {
  assertIsoTimestamp(input.now, "jump target creation time");
  assertDomain(isRelativeJumpKind(input.kind), "invalid_argument", "Unsupported relative jump target kind.", {
    kind: input.kind,
  });
  assertConversationScope(input.conversation, input.branchId);
  let selected: { message: Message; branchIndex: number } | undefined;
  if (input.fromMessageId !== undefined) {
    selected = visibleMessageAt(input.conversation, input.branchId, input.fromMessageId);
  }
  const eventCursor = input.eventCursor ?? selected?.message.sequence ?? 0;
  assertIntegerInRange(eventCursor, "jump eventCursor", 0, Number.MAX_SAFE_INTEGER);
  const source: JumpAnchor = Object.freeze({
    conversationId: input.conversation.id,
    branchId: input.branchId,
    eventCursor,
    ...(selected === undefined
      ? {}
      : {
          messageId: selected.message.id,
          semanticFingerprint: messageSemanticFingerprint(selected.message),
        }),
  });
  assertAnchorValues(source);
  return Object.freeze({
    targetId: assertTargetIdentity(
      input.targetId,
      `jump:${input.conversation.id}:${input.branchId}:${input.kind}:${selected?.message.id ?? "boundary"}`,
    ),
    kind: input.kind,
    source,
    createdAt: input.now,
    ...(input.sourceRevision === undefined ? {} : { sourceRevision: assertString(input.sourceRevision, "sourceRevision", 256) }),
    stale: false,
  });
}

export function createQueryJumpTarget(input: CreateQueryJumpTargetInput): JumpTarget {
  assertIsoTimestamp(input.now, "jump target creation time");
  assertConversationScope(input.conversation, input.branchId);
  const query = assertString(input.query, "jump query", 4096);
  const eventCursor = input.eventCursor ?? 0;
  assertIntegerInRange(eventCursor, "jump eventCursor", 0, Number.MAX_SAFE_INTEGER);
  const source: JumpAnchor = Object.freeze({
    conversationId: input.conversation.id,
    branchId: input.branchId,
    eventCursor,
  });
  assertAnchorValues(source);
  return Object.freeze({
    targetId: assertTargetIdentity(
      input.targetId,
      `jump:${input.conversation.id}:${input.branchId}:query:${boundedTextDigest(normalizeSearchText(query))}`,
    ),
    kind: "query",
    source,
    query,
    createdAt: input.now,
    ...(input.sourceRevision === undefined ? {} : { sourceRevision: assertString(input.sourceRevision, "sourceRevision", 256) }),
    stale: false,
  });
}

function isVisibleOutput(message: Message): boolean {
  return message.status !== "superseded" &&
    (message.role === "assistant" || message.role === "tool") &&
    message.contentText.trim().length > 0;
}

function boundaryMessageForKind(
  conversation: Conversation,
  branchId: BranchId,
  kind: Extract<JumpTargetKind, "first-message" | "last-message" | "first-visible-output" | "latest-output">,
): { message: Message; branchIndex: number } | undefined {
  const path = resolveBranchMessages(conversation, branchId);
  if (path.length === 0) return undefined;
  if (kind === "first-message") return { message: path[0]!, branchIndex: 0 };
  if (kind === "last-message") return { message: path.at(-1)!, branchIndex: path.length - 1 };
  if (kind === "first-visible-output") {
    const branchIndex = path.findIndex(isVisibleOutput);
    return branchIndex < 0 ? undefined : { message: path[branchIndex]!, branchIndex };
  }
  if (kind === "latest-output") {
    for (let branchIndex = path.length - 1; branchIndex >= 0; branchIndex -= 1) {
      const message = path[branchIndex];
      if (message !== undefined && isVisibleOutput(message)) return { message, branchIndex };
    }
  }
  return undefined;
}

function boundaryMessage(
  conversation: Conversation,
  target: JumpTarget,
): { message: Message; branchIndex: number } | undefined {
  if (
    target.kind !== "first-message" &&
    target.kind !== "last-message" &&
    target.kind !== "first-visible-output" &&
    target.kind !== "latest-output"
  ) {
    return undefined;
  }
  return boundaryMessageForKind(conversation, target.source.branchId, target.kind);
}

/** Resolves only local, message-backed targets and never jumps to an unrelated message. */
export function resolveJumpTarget(conversation: Conversation, target: JumpTarget): JumpResolution {
  assertJumpTarget(target);
  assertDomain(
    target.source.conversationId === conversation.id,
    "scope_violation",
    "Jump target belongs to another conversation.",
    { targetId: target.targetId, targetConversationId: target.source.conversationId, conversationId: conversation.id },
  );
  assertConversationScope(conversation, target.source.branchId);
  if (target.stale) return Object.freeze({ status: "stale", target, reason: "target-marked-stale" });

  if (target.kind === "query") {
    const query = target.query;
    if (query === undefined) {
      return Object.freeze({ status: "unsupported", target, reason: "unsupported-target-kind" });
    }
    const result = searchJumpTargets(conversation, target.source.branchId, { text: query }, target.createdAt)[0];
    return result === undefined
      ? Object.freeze({ status: "stale", target, reason: "no-match" })
      : Object.freeze({ status: "resolved", target, message: result.message, branchIndex: result.branchIndex });
  }

  if (target.kind === "next-prompt" || target.kind === "previous-prompt") {
    const path = resolveBranchMessages(conversation, target.source.branchId);
    const sourceIndex =
      target.source.messageId === undefined
        ? target.kind === "next-prompt"
          ? -1
          : path.length
        : path.findIndex((message) => message.id === target.source.messageId);
    if (target.source.messageId !== undefined && sourceIndex < 0) {
      return Object.freeze({ status: "stale", target, reason: "message-not-visible-on-branch" });
    }
    if (
      target.source.messageId !== undefined &&
      target.source.semanticFingerprint !== undefined &&
      messageSemanticFingerprint(path[sourceIndex]!) !== target.source.semanticFingerprint
    ) {
      return Object.freeze({ status: "stale", target, reason: "semantic-fingerprint-mismatch" });
    }
    const step = target.kind === "next-prompt" ? 1 : -1;
    for (let index = sourceIndex + step; index >= 0 && index < path.length; index += step) {
      const message = path[index];
      if (message !== undefined && message.role === "user" && message.status !== "superseded") {
        return Object.freeze({ status: "resolved", target, message, branchIndex: index });
      }
    }
    return Object.freeze({ status: "stale", target, reason: "no-match" });
  }

  let resolved: { message: Message; branchIndex: number } | undefined;
  if (target.source.messageId !== undefined) {
    const path = resolveBranchMessages(conversation, target.source.branchId);
    const branchIndex = path.findIndex((message) => message.id === target.source.messageId);
    if (branchIndex < 0) {
      return Object.freeze({ status: "stale", target, reason: "message-not-visible-on-branch" });
    }
    const message = path[branchIndex]!;
    if (message.status === "superseded") {
      return Object.freeze({ status: "stale", target, reason: "message-superseded" });
    }
    const messageKind =
      target.kind === "user-prompt" ||
      target.kind === "assistant-response" ||
      target.kind === "message-revision";
    const boundaryKind =
      target.kind === "first-message" ||
      target.kind === "last-message" ||
      target.kind === "first-visible-output" ||
      target.kind === "latest-output";
    if (!messageKind && !boundaryKind) {
      return Object.freeze({ status: "unsupported", target, reason: "unsupported-target-kind" });
    }
    if (
      (target.kind === "user-prompt" && message.role !== "user") ||
      (target.kind === "assistant-response" && message.role !== "assistant")
    ) {
      return Object.freeze({ status: "unsupported", target, reason: "unsupported-target-kind" });
    }
    if (
      (target.kind === "first-visible-output" || target.kind === "latest-output") &&
      !isVisibleOutput(message)
    ) {
      return Object.freeze({ status: "stale", target, reason: "message-not-visible-on-branch" });
    }
    if (
      target.source.semanticFingerprint !== undefined &&
      target.source.semanticFingerprint !== messageSemanticFingerprint(message)
    ) {
      return Object.freeze({ status: "stale", target, reason: "semantic-fingerprint-mismatch" });
    }
    resolved = { message, branchIndex };
  } else {
    resolved = boundaryMessage(conversation, target);
  }

  if (resolved !== undefined) return Object.freeze({ status: "resolved", target, ...resolved });
  if (
    target.kind === "first-message" ||
    target.kind === "last-message" ||
    target.kind === "first-visible-output" ||
    target.kind === "latest-output"
  ) {
    return Object.freeze({ status: "stale", target, reason: "message-not-visible-on-branch" });
  }
  return Object.freeze({ status: "unsupported", target, reason: "unsupported-target-kind" });
}

export function searchJumpTargets(
  conversation: Conversation,
  branchId: BranchId,
  filter: JumpSearchFilter = {},
  now: IsoTimestamp,
): readonly JumpSearchResult[] {
  assertIsoTimestamp(now, "jump search time");
  assertConversationScope(conversation, branchId);
  assertSearchFilter(filter);
  const limit = filter.limit ?? DEFAULT_SEARCH_LIMIT;
  assertIntegerInRange(limit, "jump search limit", 1, MAX_SEARCH_LIMIT);
  const normalizedText = filter.text === undefined ? "" : normalizeSearchText(filter.text);
  const path = resolveBranchMessages(conversation, branchId);
  const results: JumpSearchResult[] = [];
  path.forEach((message, branchIndex) => {
    if (!matchesSearchFilter(message, filter, normalizedText)) return;
    results.push({
      target: createMessageJumpTarget({ conversation, branchId, messageId: message.id, now }),
      message,
      branchIndex,
    });
  });
  return Object.freeze(results.slice(0, limit));
}

function matchesSearchFilter(message: Message, filter: JumpSearchFilter, normalizedText: string): boolean {
  if (!filter.includeSuperseded && message.status === "superseded") return false;
  if (filter.role !== undefined && message.role !== filter.role) return false;
  if (filter.status !== undefined && message.status !== filter.status) return false;
  if (filter.providerConnectionId !== undefined && message.model?.providerConnectionId !== filter.providerConnectionId) return false;
  if (filter.modelProfileId !== undefined && message.model?.modelProfileId !== filter.modelProfileId) return false;
  if (filter.providerModelId !== undefined && message.model?.providerModelId !== filter.providerModelId) return false;
  if (filter.producingRunId !== undefined && message.producingRunId !== filter.producingRunId) return false;
  const createdAtMs = Date.parse(message.createdAt);
  if (filter.createdAfterMs !== undefined && createdAtMs < filter.createdAfterMs) return false;
  if (filter.createdBeforeMs !== undefined && createdAtMs > filter.createdBeforeMs) return false;
  if (normalizedText && !normalizeSearchText(message.contentText).includes(normalizedText)) return false;
  return true;
}

export function findAdjacentJumpTarget(
  conversation: Conversation,
  branchId: BranchId,
  fromMessageId: MessageId | undefined,
  direction: JumpDirection,
  filter: Omit<JumpSearchFilter, "limit"> = {},
  now: IsoTimestamp,
): JumpTarget | undefined {
  assertIsoTimestamp(now, "jump search time");
  assertDomain(direction === "forward" || direction === "backward", "invalid_argument", "Unsupported jump direction.", {
    direction,
  });
  assertConversationScope(conversation, branchId);
  assertSearchFilter(filter);
  const normalizedText = filter.text === undefined ? "" : normalizeSearchText(filter.text);
  const path = resolveBranchMessages(conversation, branchId);
  const fromIndex =
    fromMessageId === undefined
      ? direction === "forward"
        ? -1
        : path.length
      : path.findIndex((message) => message.id === fromMessageId);
  if (fromMessageId !== undefined && fromIndex < 0) return undefined;
  const start =
    fromIndex < 0
      ? direction === "forward"
        ? -1
        : path.length
      : fromIndex;
  const step = direction === "forward" ? 1 : -1;
  for (let index = start + step; index >= 0 && index < path.length; index += step) {
    const message = path[index];
    if (message !== undefined && matchesSearchFilter(message, filter, normalizedText)) {
      return createMessageJumpTarget({ conversation, branchId, messageId: message.id, now });
    }
  }
  return undefined;
}
