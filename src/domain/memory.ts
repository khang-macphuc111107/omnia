import { assertDomain } from "./errors";
import type {
  AssistantProfileId,
  ConversationId,
  MemoryId,
  MemoryProposalId,
  MemoryRevisionId,
  MessageId,
  ProfileId,
  ProjectId,
  RunId,
} from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  freezeJson,
  type IsoTimestamp,
  type JsonObject,
} from "./shared";

export type MemoryScope = "global" | "project" | "assistant" | "conversation";
export type MemoryKind =
  | "preference"
  | "fact"
  | "goal"
  | "constraint"
  | "decision"
  | "procedure"
  | "glossary"
  | "summary";
export type MemoryRevisionStatus = "proposed" | "active" | "superseded" | "rejected" | "expired";
export type MemoryOrigin = "user" | "assistant" | "import" | "system";
export type MemorySensitivity =
  | "normal"
  | "personal"
  | "financial"
  | "health"
  | "authentication"
  | "secret"
  | "private-key";

export interface MemoryScopeRef {
  readonly scope: MemoryScope;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly assistantProfileId?: AssistantProfileId;
  readonly conversationId?: ConversationId;
}

export interface MemoryRevision {
  readonly id: MemoryRevisionId;
  readonly memoryId: MemoryId;
  readonly scope: MemoryScopeRef;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly contentHash: string;
  readonly evidenceMessageIds: readonly MessageId[];
  readonly sourceRunIds: readonly RunId[];
  readonly confidence: number;
  readonly sensitivity: readonly MemorySensitivity[];
  readonly origin: MemoryOrigin;
  readonly status: MemoryRevisionStatus;
  readonly userApproved: boolean;
  readonly pinned: boolean;
  readonly validFrom: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly supersedesRevisionId?: MemoryRevisionId;
  readonly createdAt: IsoTimestamp;
  readonly metadata: JsonObject;
}

export interface Memory {
  readonly id: MemoryId;
  readonly profileId: ProfileId;
  readonly revisions: readonly MemoryRevision[];
  readonly activeRevisionId?: MemoryRevisionId;
  readonly disabledAt?: IsoTimestamp;
  readonly deletedAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface MemoryProposal {
  readonly id: MemoryProposalId;
  readonly proposedRevision: MemoryRevision;
  readonly createdAt: IsoTimestamp;
  readonly retainUntil: IsoTimestamp;
  readonly qualityScore: number;
  readonly contradictionRevisionIds: readonly MemoryRevisionId[];
  readonly duplicateRevisionIds: readonly MemoryRevisionId[];
  readonly decision: "pending" | "approved" | "rejected";
}

const FORBIDDEN_MEMORY_SENSITIVITY = new Set<MemorySensitivity>([
  "authentication",
  "secret",
  "private-key",
]);

const MEMORY_SCOPES: ReadonlySet<MemoryScope> = new Set([
  "global",
  "project",
  "assistant",
  "conversation",
]);
const MEMORY_KINDS: ReadonlySet<MemoryKind> = new Set([
  "preference",
  "fact",
  "goal",
  "constraint",
  "decision",
  "procedure",
  "glossary",
  "summary",
]);
const MEMORY_REVISION_STATUSES: ReadonlySet<MemoryRevisionStatus> = new Set([
  "proposed",
  "active",
  "superseded",
  "rejected",
  "expired",
]);
const MEMORY_ORIGINS: ReadonlySet<MemoryOrigin> = new Set([
  "user",
  "assistant",
  "import",
  "system",
]);
const MEMORY_SENSITIVITIES: ReadonlySet<MemorySensitivity> = new Set([
  "normal",
  "personal",
  "financial",
  "health",
  "authentication",
  "secret",
  "private-key",
]);

function uniqueIds<T extends string>(values: readonly T[], label: string): readonly T[] {
  assertDomain(new Set(values).size === values.length, "invalid_argument", `${label} must be unique.`);
  return Object.freeze([...values]);
}

function sameMemoryScope(left: MemoryScopeRef, right: MemoryScopeRef): boolean {
  return (
    left.scope === right.scope &&
    left.profileId === right.profileId &&
    left.projectId === right.projectId &&
    left.assistantProfileId === right.assistantProfileId &&
    left.conversationId === right.conversationId
  );
}

/**
 * A memory can have many immutable revisions, but at most one revision may
 * be active at a time.  Keep this invariant at the domain boundary so a
 * malformed hydrated record cannot leak two competing facts into retrieval.
 */
function assertMemoryActiveRevision(memory: Memory): MemoryRevision | undefined {
  const active = memory.revisions.filter((candidate) => candidate.status === "active");
  assertDomain(
    active.length <= 1,
    "invalid_state_transition",
    "A memory cannot have more than one active revision.",
    { memoryId: memory.id },
  );
  if (memory.activeRevisionId === undefined) {
    assertDomain(
      active.length === 0,
      "invalid_state_transition",
      "An active memory revision requires an active revision pointer.",
      { memoryId: memory.id },
    );
    return undefined;
  }
  assertDomain(
    active.length === 1 && active[0]?.id === memory.activeRevisionId,
    "invalid_state_transition",
    "The active memory revision pointer is inconsistent with revision status.",
    { memoryId: memory.id, activeRevisionId: memory.activeRevisionId },
  );
  return active[0];
}

export function assertMemoryScope(scope: MemoryScopeRef): void {
  assertDomain(MEMORY_SCOPES.has(scope.scope), "invalid_argument", "Memory scope is not recognized.");
  assertNonBlank(scope.profileId, "memory profile ID", 256);
  const project = scope.projectId !== undefined;
  const assistant = scope.assistantProfileId !== undefined;
  const conversation = scope.conversationId !== undefined;
  assertDomain(
    (scope.scope === "global" && !project && !assistant && !conversation) ||
      (scope.scope === "project" && project && !assistant && !conversation) ||
      (scope.scope === "assistant" && !project && assistant && !conversation) ||
      (scope.scope === "conversation" && !project && !assistant && conversation),
    "invalid_argument",
    "Memory scope identifiers do not match the declared scope.",
    { scope: scope.scope },
  );
  if (scope.projectId !== undefined) assertNonBlank(scope.projectId, "memory project ID", 256);
  if (scope.assistantProfileId !== undefined) {
    assertNonBlank(scope.assistantProfileId, "memory assistant profile ID", 256);
  }
  if (scope.conversationId !== undefined) {
    assertNonBlank(scope.conversationId, "memory conversation ID", 256);
  }
}

export interface CreateMemoryRevisionInput {
  readonly id: MemoryRevisionId;
  readonly memoryId: MemoryId;
  readonly scope: MemoryScopeRef;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly contentHash: string;
  readonly evidenceMessageIds?: readonly MessageId[];
  readonly sourceRunIds?: readonly RunId[];
  readonly confidence: number;
  readonly sensitivity?: readonly MemorySensitivity[];
  readonly origin?: MemoryOrigin;
  readonly status?: MemoryRevisionStatus;
  readonly userApproved?: boolean;
  readonly pinned?: boolean;
  readonly validFrom: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly supersedesRevisionId?: MemoryRevisionId;
  readonly createdAt: IsoTimestamp;
  readonly metadata?: JsonObject;
}

export function createMemoryRevision(input: CreateMemoryRevisionInput): MemoryRevision {
  assertMemoryScope(input.scope);
  assertDomain(MEMORY_KINDS.has(input.kind), "invalid_argument", "Memory kind is not recognized.");
  assertIsoTimestamp(input.validFrom, "memory validity start");
  assertIsoTimestamp(input.createdAt, "memory creation time");
  assertDomain(
    Number.isFinite(input.confidence) && input.confidence >= 0 && input.confidence <= 1,
    "invalid_argument",
    "Memory confidence must be between zero and one.",
    { confidence: input.confidence },
  );
  const sensitivity = uniqueIds(input.sensitivity ?? ["normal"], "Memory sensitivity categories");
  assertDomain(
    sensitivity.length > 0 && sensitivity.every((category) => MEMORY_SENSITIVITIES.has(category)),
    "invalid_argument",
    "Memory sensitivity contains an unsupported category.",
  );
  assertDomain(
    sensitivity.length === 1 || !sensitivity.includes("normal"),
    "invalid_argument",
    "Normal sensitivity cannot be combined with sensitive categories.",
  );
  assertDomain(
    !sensitivity.some((category) => FORBIDDEN_MEMORY_SENSITIVITY.has(category)),
    "permission_denied",
    "Credentials and secrets cannot be stored as memory.",
    { memoryId: input.memoryId },
  );
  const status = input.status ?? "proposed";
  assertDomain(
    MEMORY_REVISION_STATUSES.has(status),
    "invalid_argument",
    "Memory revision status is not recognized.",
  );
  const origin = input.origin ?? "user";
  assertDomain(MEMORY_ORIGINS.has(origin), "invalid_argument", "Memory origin is not recognized.");
  const userApproved = input.userApproved ?? false;
  assertDomain(
    status !== "active" || userApproved,
    "permission_denied",
    "An active memory revision must have an explicit approval decision.",
    { memoryId: input.memoryId },
  );
  if (input.expiresAt !== undefined) {
    assertIsoTimestamp(input.expiresAt, "memory expiry time");
    assertDomain(
      Date.parse(input.expiresAt) > Date.parse(input.validFrom),
      "invalid_argument",
      "Memory expiry must be later than its validity start.",
    );
  }
  assertDomain(
    input.supersedesRevisionId === undefined || input.supersedesRevisionId !== input.id,
    "invalid_argument",
    "A memory revision cannot supersede itself.",
  );
  const evidenceMessageIds = uniqueIds(
    input.evidenceMessageIds ?? [],
    "Memory evidence message IDs",
  );
  const sourceRunIds = uniqueIds(input.sourceRunIds ?? [], "Memory source run IDs");
  assertDomain(
    origin === "user" || evidenceMessageIds.length > 0 || sourceRunIds.length > 0,
    "invalid_argument",
    "Assistant, imported, and system memories require source evidence.",
    { memoryId: input.memoryId, origin },
  );
  return Object.freeze({
    id: input.id,
    memoryId: input.memoryId,
    scope: Object.freeze({ ...input.scope }),
    kind: input.kind,
    content: assertNonBlank(input.content, "memory content", 32_000),
    contentHash: assertSha256(input.contentHash, "memory content hash"),
    evidenceMessageIds,
    sourceRunIds,
    confidence: input.confidence,
    sensitivity,
    origin,
    status,
    userApproved,
    pinned: input.pinned ?? false,
    validFrom: input.validFrom,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.supersedesRevisionId === undefined
      ? {}
      : { supersedesRevisionId: input.supersedesRevisionId }),
    createdAt: input.createdAt,
    metadata: freezeJson(input.metadata ?? {}),
  });
}

export function createMemory(revision: MemoryRevision): Memory {
  assertDomain(revision.supersedesRevisionId === undefined, "invalid_argument", "Initial memory revision cannot supersede another revision.");
  const memory = Object.freeze({
    id: revision.memoryId,
    profileId: revision.scope.profileId,
    revisions: Object.freeze([revision]),
    ...(revision.status === "active" ? { activeRevisionId: revision.id } : {}),
    createdAt: revision.createdAt,
    updatedAt: revision.createdAt,
  });
  assertMemoryActiveRevision(memory);
  return memory;
}

export function appendMemoryRevision(
  memory: Memory,
  revision: MemoryRevision,
  now: IsoTimestamp,
): Memory {
  assertIsoTimestamp(now, "memory update time");
  assertDomain(memory.deletedAt === undefined, "invalid_state_transition", "Deleted memory cannot be revised.");
  const currentActive = assertMemoryActiveRevision(memory);
  assertDomain(revision.memoryId === memory.id, "scope_violation", "Revision belongs to another memory.");
  assertDomain(revision.scope.profileId === memory.profileId, "scope_violation", "Revision belongs to another profile.");
  const initialScope = memory.revisions[0]?.scope;
  assertDomain(initialScope !== undefined, "invalid_state_transition", "Memory has no initial revision.");
  assertDomain(
    sameMemoryScope(revision.scope, initialScope),
    "scope_violation",
    "A memory revision cannot silently move to another scope.",
    { memoryId: memory.id },
  );
  assertDomain(
    !memory.revisions.some((candidate) => candidate.id === revision.id),
    "conflict",
    "Memory revision ID already exists.",
  );
  if (revision.supersedesRevisionId !== undefined) {
    assertDomain(
      memory.revisions.some((candidate) => candidate.id === revision.supersedesRevisionId),
      "not_found",
      "Superseded memory revision was not found.",
    );
  }
  if (revision.status === "active" && currentActive !== undefined) {
    assertDomain(
      revision.supersedesRevisionId === currentActive.id,
      "conflict",
      "An active memory revision must supersede the current active revision.",
      { memoryId: memory.id, activeRevisionId: currentActive.id },
    );
  }
  const supersededId = revision.supersedesRevisionId ?? currentActive?.id;
  const nextRevisions = memory.revisions.map((candidate) =>
    revision.status === "active" && candidate.id === supersededId
      ? Object.freeze({ ...candidate, status: "superseded" as const })
      : candidate,
  );
  nextRevisions.push(revision);
  return Object.freeze({
    ...memory,
    revisions: Object.freeze(nextRevisions),
    ...(revision.status === "active" ? { activeRevisionId: revision.id } : {}),
    updatedAt: now,
  });
}

export function approveMemoryRevision(
  memory: Memory,
  revisionId: MemoryRevisionId,
  now: IsoTimestamp,
): Memory {
  assertIsoTimestamp(now, "memory update time");
  const currentActive = assertMemoryActiveRevision(memory);
  const revision = memory.revisions.find((candidate) => candidate.id === revisionId);
  assertDomain(revision !== undefined, "not_found", "Memory revision was not found.");
  assertDomain(memory.deletedAt === undefined, "invalid_state_transition", "Deleted memory cannot be approved.");
  assertDomain(memory.disabledAt === undefined, "invalid_state_transition", "Disabled memory cannot be approved.");
  assertDomain(revision.status === "proposed", "invalid_state_transition", "Only proposed memory can be approved.");
  assertDomain(
    revision.supersedesRevisionId !== revision.id,
    "invalid_argument",
    "A memory revision cannot supersede itself.",
  );
  if (revision.supersedesRevisionId !== undefined && currentActive !== undefined) {
    assertDomain(
      revision.supersedesRevisionId === currentActive.id,
      "conflict",
      "An approved memory revision must supersede the current active revision.",
      { memoryId: memory.id, activeRevisionId: currentActive.id },
    );
  }
  if (revision.supersedesRevisionId !== undefined && currentActive === undefined) {
    assertDomain(
      false,
      "conflict",
      "An approved memory revision cannot supersede a non-active revision.",
      { memoryId: memory.id, supersedesRevisionId: revision.supersedesRevisionId },
    );
  }
  const supersededId = revision.supersedesRevisionId ?? currentActive?.id;
  const revisions = memory.revisions.map((candidate) => {
    if (candidate.id === revision.id) {
      return Object.freeze({ ...candidate, status: "active" as const, userApproved: true });
    }
    if (candidate.id === supersededId && candidate.status === "active") {
      return Object.freeze({ ...candidate, status: "superseded" as const });
    }
    return candidate;
  });
  return Object.freeze({
    ...memory,
    revisions: Object.freeze(revisions),
    activeRevisionId: revision.id,
    updatedAt: now,
  });
}

export interface MemoryRetrievalCandidate {
  readonly revision: MemoryRevision;
  readonly relevance: number;
  readonly recency: number;
  readonly utility: number;
  readonly tokenEstimate: number;
  readonly reasons: readonly (
    | "query-match"
    | "project-match"
    | "assistant-match"
    | "pinned"
    | "recent-active-goal"
    | "explicit-user-mention"
  )[];
}

export interface SelectMemoriesInput {
  readonly candidates: readonly MemoryRetrievalCandidate[];
  readonly tokenBudget: number;
  readonly now: IsoTimestamp;
  readonly temporaryChat: boolean;
  readonly mode: "off" | "read-only" | "propose" | "auto-low-risk" | "custom";
  readonly excludedRevisionIds?: readonly MemoryRevisionId[];
}

export function selectMemories(input: SelectMemoriesInput): readonly MemoryRetrievalCandidate[] {
  if (input.mode === "off" || input.temporaryChat) return Object.freeze([]);
  assertDomain(
    Number.isSafeInteger(input.tokenBudget) && input.tokenBudget >= 0,
    "invalid_argument",
    "Memory token budget must be a non-negative integer.",
  );
  assertIsoTimestamp(input.now, "memory retrieval time");
  assertDomain(
    new Set(input.candidates.map(({ revision }) => revision.id)).size === input.candidates.length,
    "conflict",
    "Memory retrieval candidates must not repeat a revision.",
  );
  for (const candidate of input.candidates) {
    assertDomain(
      Number.isSafeInteger(candidate.tokenEstimate) && candidate.tokenEstimate >= 0,
      "invalid_argument",
      "Memory token estimate must be a non-negative integer.",
      { revisionId: candidate.revision.id },
    );
    for (const [label, value] of [
      ["relevance", candidate.relevance],
      ["recency", candidate.recency],
      ["utility", candidate.utility],
    ] as const) {
      assertDomain(
        Number.isFinite(value) && value >= 0 && value <= 1,
        "invalid_argument",
        `Memory ${label} score must be between zero and one.`,
        { revisionId: candidate.revision.id, label, value },
      );
    }
  }
  const excluded = new Set(input.excludedRevisionIds ?? []);
  const now = Date.parse(input.now);
  const eligible = input.candidates.filter(({ revision }) => {
    if (excluded.has(revision.id) || revision.status !== "active") return false;
    if (revision.expiresAt !== undefined && Date.parse(revision.expiresAt) <= now) return false;
    return !revision.sensitivity.some((category) => FORBIDDEN_MEMORY_SENSITIVITY.has(category));
  });
  const ranked = eligible
    .map((candidate, index) => ({
      candidate,
      index,
      score:
        candidate.relevance * 0.5 +
        candidate.utility * 0.3 +
        candidate.recency * 0.2 +
        (candidate.revision.pinned ? 1 : 0),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected: MemoryRetrievalCandidate[] = [];
  let usedTokens = 0;
  for (const { candidate } of ranked) {
    if (candidate.tokenEstimate > input.tokenBudget - usedTokens) continue;
    selected.push(candidate);
    usedTokens += candidate.tokenEstimate;
  }
  return Object.freeze(selected);
}
