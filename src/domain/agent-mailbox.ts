import { assertDomain } from "./errors";
import type { ArtifactId, TaskId } from "./ids";
import { assertOpaqueResourceHandle } from "./resource-handle";
import {
  assertIntegerInRange,
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  freezeJson,
  type IsoTimestamp,
  type JsonObject,
} from "./shared";
import type { AgentGraph } from "./agent-graph";
import {
  assertPositiveSafeInteger,
  type AgentInstanceId,
  type AgentMailboxMessageId,
  type AgentResultId,
  uniqueValues,
} from "./agent-tool-contract-shared";

export type AgentMailboxMessageKind =
  | "finding"
  | "question"
  | "answer"
  | "handoff"
  | "progress"
  | "artifact-reference"
  | "control";

export interface AgentMailboxMessage {
  readonly id: AgentMailboxMessageId;
  readonly senderAgentId: AgentInstanceId;
  readonly recipientAgentId: AgentInstanceId;
  readonly taskId?: TaskId;
  readonly kind: AgentMailboxMessageKind;
  /** Agent messages are evidence/data and never inherit user-instruction authority. */
  readonly authority: "agent";
  readonly contentHash: string;
  readonly deliveryKeyHash: string;
  /** Monotonic sequence assigned by the mailbox at append time. */
  readonly deliverySequence: number;
  readonly sensitivity: "normal" | "sensitive" | "restricted";
  readonly payload: JsonObject;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly acknowledgedAt?: IsoTimestamp;
}

export interface AgentMailbox {
  readonly version: 1;
  readonly maximumMessages: number;
  readonly maximumBytes: number;
  readonly messages: readonly AgentMailboxMessage[];
}

export interface AppendAgentMailboxResult {
  readonly mailbox: AgentMailbox;
  readonly message: AgentMailboxMessage;
  readonly replayed: boolean;
}

export type AppendAgentMailboxMessageInput = Omit<
  AgentMailboxMessage,
  "deliverySequence" | "acknowledgedAt"
>;

export function createAgentMailbox(
  maximumMessages: number,
  maximumBytes: number,
): AgentMailbox {
  assertIntegerInRange(maximumMessages, "mailbox message limit", 1, 100_000);
  assertPositiveSafeInteger(maximumBytes, "mailbox byte limit");
  return Object.freeze({
    version: 1,
    maximumMessages,
    maximumBytes,
    messages: Object.freeze([]),
  });
}

function mailboxSerializedBytes(
  messages: readonly AgentMailboxMessage[],
): number {
  return new TextEncoder().encode(JSON.stringify(messages)).byteLength;
}

export function appendAgentMailboxMessage(
  mailbox: AgentMailbox,
  graph: AgentGraph,
  input: AppendAgentMailboxMessageInput,
): AppendAgentMailboxResult {
  assertDomain(
    mailbox.version === 1,
    "invalid_argument",
    "Unsupported mailbox version.",
  );
  assertIsoTimestamp(input.createdAt, "mailbox message creation time");
  assertDomain(
    input.kind === "finding" ||
      input.kind === "question" ||
      input.kind === "answer" ||
      input.kind === "handoff" ||
      input.kind === "progress" ||
      input.kind === "artifact-reference" ||
      input.kind === "control",
    "invalid_argument",
    "Unknown mailbox message kind.",
  );
  assertDomain(
    input.sensitivity === "normal" ||
      input.sensitivity === "sensitive" ||
      input.sensitivity === "restricted",
    "invalid_argument",
    "Unknown mailbox sensitivity class.",
  );
  if (input.expiresAt !== undefined) {
    assertIsoTimestamp(input.expiresAt, "mailbox message expiry time");
    assertDomain(
      Date.parse(input.expiresAt) > Date.parse(input.createdAt),
      "invalid_argument",
      "Mailbox message expiry must follow creation.",
    );
  }
  assertDomain(
    input.authority === "agent",
    "permission_denied",
    "Agent mail cannot claim user authority.",
  );
  assertDomain(
    input.senderAgentId !== input.recipientAgentId &&
      graph.agents.some((agent) => agent.id === input.senderAgentId) &&
      graph.agents.some((agent) => agent.id === input.recipientAgentId),
    "scope_violation",
    "Mailbox sender and recipient must be distinct members of the same agent graph.",
  );
  const contentHash = assertSha256(input.contentHash, "mailbox content hash");
  const deliveryKeyHash = assertSha256(
    input.deliveryKeyHash,
    "mailbox delivery-key hash",
  );
  const existing = mailbox.messages.find(
    (message) =>
      message.senderAgentId === input.senderAgentId &&
      message.recipientAgentId === input.recipientAgentId &&
      message.deliveryKeyHash === deliveryKeyHash,
  );
  if (existing !== undefined) {
    assertDomain(
      existing.contentHash === contentHash &&
        existing.kind === input.kind &&
        existing.taskId === input.taskId &&
        existing.sensitivity === input.sensitivity &&
        existing.expiresAt === input.expiresAt,
      "conflict",
      "Mailbox delivery key was reused for different content.",
    );
    return Object.freeze({ mailbox, message: existing, replayed: true });
  }
  assertDomain(
    !mailbox.messages.some((message) => message.id === input.id),
    "conflict",
    "Mailbox message ID already exists.",
  );
  assertDomain(
    mailbox.messages.length < mailbox.maximumMessages,
    "unsupported_capability",
    "Mailbox message limit has been reached.",
  );
  const message: AgentMailboxMessage = Object.freeze({
    ...input,
    contentHash,
    deliveryKeyHash,
    deliverySequence: mailbox.messages.length + 1,
    payload: freezeJson(input.payload),
  });
  const messages = Object.freeze([...mailbox.messages, message]);
  assertDomain(
    mailboxSerializedBytes(messages) <= mailbox.maximumBytes,
    "unsupported_capability",
    "Mailbox byte budget would be exceeded.",
  );
  return Object.freeze({
    mailbox: Object.freeze({ ...mailbox, messages }),
    message,
    replayed: false,
  });
}

export function acknowledgeAgentMailboxMessage(
  mailbox: AgentMailbox,
  messageId: AgentMailboxMessageId,
  recipientAgentId: AgentInstanceId,
  now: IsoTimestamp,
): AgentMailbox {
  assertIsoTimestamp(now, "mailbox acknowledgement time");
  const index = mailbox.messages.findIndex(
    (message) => message.id === messageId,
  );
  const message = mailbox.messages[index];
  assertDomain(
    message !== undefined,
    "not_found",
    "Mailbox message was not found.",
  );
  assertDomain(
    message.recipientAgentId === recipientAgentId,
    "permission_denied",
    "Only the exact recipient may acknowledge a mailbox message.",
  );
  if (message.acknowledgedAt !== undefined) return mailbox;
  assertDomain(
    Date.parse(now) >= Date.parse(message.createdAt),
    "invalid_argument",
    "Mailbox acknowledgement cannot precede message creation.",
  );
  assertDomain(
    message.expiresAt === undefined ||
      Date.parse(now) < Date.parse(message.expiresAt),
    "invalid_state_transition",
    "Expired mailbox messages cannot be acknowledged as delivered.",
  );
  const acknowledged = Object.freeze({ ...message, acknowledgedAt: now });
  return Object.freeze({
    ...mailbox,
    messages: Object.freeze(
      mailbox.messages.map((candidate, i) =>
        i === index ? acknowledged : candidate,
      ),
    ),
  });
}

export interface AgentFinding {
  readonly claim: string;
  readonly evidenceIds: readonly string[];
  readonly confidence: "low" | "medium" | "high";
}

export interface AgentResultEnvelope {
  readonly schemaVersion: 1;
  readonly id: AgentResultId;
  readonly agentId: AgentInstanceId;
  readonly taskId: TaskId;
  readonly summary: string;
  readonly findings: readonly AgentFinding[];
  readonly artifactIds: readonly ArtifactId[];
  readonly inspectedResourceHandles: readonly string[];
  readonly risks: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly contentHash: string;
  readonly createdAt: IsoTimestamp;
}

/**
 * Creates the bounded handoff that may be selected into parent context. The
 * child transcript remains separately inspectable and is never appended here.
 */
export function createAgentResultEnvelope(
  input: AgentResultEnvelope,
): AgentResultEnvelope {
  assertDomain(
    input.schemaVersion === 1,
    "invalid_argument",
    "Unsupported agent result version.",
  );
  assertIsoTimestamp(input.createdAt, "agent result creation time");
  const findings = input.findings.map((finding) => {
    assertDomain(
      finding.confidence === "low" ||
        finding.confidence === "medium" ||
        finding.confidence === "high",
      "invalid_argument",
      "Unknown agent finding confidence.",
    );
    return Object.freeze({
      claim: assertNonBlank(finding.claim, "agent finding", 8_000),
      evidenceIds: uniqueValues(
        finding.evidenceIds.map((evidenceId) =>
          assertNonBlank(evidenceId, "agent evidence ID", 256),
        ),
        "Agent evidence IDs",
      ),
      confidence: finding.confidence,
    });
  });
  return Object.freeze({
    ...input,
    summary: assertNonBlank(input.summary, "agent result summary", 16_000),
    findings: Object.freeze(findings),
    artifactIds: uniqueValues(input.artifactIds, "Agent result artifacts"),
    inspectedResourceHandles: uniqueValues(
      input.inspectedResourceHandles.map((handle) =>
        assertOpaqueResourceHandle(handle, "inspected resource handle"),
      ),
      "Inspected resource handles",
    ),
    risks: Object.freeze(
      input.risks.map((risk) =>
        assertNonBlank(risk, "agent result risk", 2_000),
      ),
    ),
    unresolvedQuestions: Object.freeze(
      input.unresolvedQuestions.map((question) =>
        assertNonBlank(question, "unresolved agent question", 2_000),
      ),
    ),
    contentHash: assertSha256(input.contentHash, "agent result content hash"),
  });
}

