import { assertDomain } from "./errors";
import {
  appendMemoryRevision,
  approveMemoryRevision,
  createMemory,
  createMemoryRevision,
  type Memory,
  type MemoryKind,
  type MemoryProposal,
  type MemoryRevision,
  type MemoryRevisionStatus,
  type MemoryScope,
  type MemoryScopeRef,
  type MemorySensitivity,
} from "./memory";
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
  freezeJson,
  type IsoTimestamp,
  type JsonObject,
  type JsonValue,
} from "./shared";

/** Durable, profile-scoped memory index owned by the native persistence layer. */
export interface OmniaMemoryStore {
  readonly version: 1;
  readonly profileId: ProfileId;
  readonly memories: readonly Memory[];
  readonly proposals: readonly MemoryProposal[];
  readonly updatedAt: IsoTimestamp;
}

export interface MemoryStoreExport {
  readonly schema: "omnia.memory-store";
  readonly version: 1;
  readonly exportedAt: IsoTimestamp;
  readonly profileId: ProfileId;
  readonly memories: readonly Memory[];
  readonly proposals: readonly MemoryProposal[];
  readonly metadata: JsonObject;
}

export type MemoryImportMode = "merge" | "replace";
export type MemoryConflictPolicy = "keep-existing" | "replace-existing" | "reject";

export interface MemoryImportOptions {
  readonly mode?: MemoryImportMode;
  readonly memoryConflict?: MemoryConflictPolicy;
  readonly proposalConflict?: MemoryConflictPolicy;
  readonly now?: IsoTimestamp;
}

export interface MemoryImportPreview {
  readonly mode: MemoryImportMode;
  readonly memoryAdds: number;
  readonly memoryReplacements: number;
  readonly memorySkips: number;
  readonly proposalAdds: number;
  readonly proposalReplacements: number;
  readonly proposalSkips: number;
  readonly conflicts: readonly string[];
}

export interface MemoryStoreQuery {
  readonly text?: string;
  readonly scope?: MemoryScope;
  readonly kind?: MemoryKind;
  readonly includeInactive?: boolean;
  readonly includeDeleted?: boolean;
  readonly includeDisabled?: boolean;
  readonly limit?: number;
}

export interface PruneMemoryStoreOptions {
  readonly now: IsoTimestamp;
  /** Permanently remove soft-deleted memories older than this timestamp. */
  readonly deleteBefore?: IsoTimestamp;
  readonly removeExpiredProposals?: boolean;
}

const MEMORY_KINDS: readonly MemoryKind[] = [
  "preference",
  "fact",
  "goal",
  "constraint",
  "decision",
  "procedure",
  "glossary",
  "summary",
];
const MEMORY_SCOPES: readonly MemoryScope[] = ["global", "project", "assistant", "conversation"];
const MEMORY_STATUSES: readonly MemoryRevisionStatus[] = [
  "proposed",
  "active",
  "superseded",
  "rejected",
  "expired",
];
const MEMORY_SENSITIVITIES: readonly MemorySensitivity[] = [
  "normal",
  "personal",
  "financial",
  "health",
  "authentication",
  "secret",
  "private-key",
];
const PROPOSAL_DECISIONS = ["pending", "approved", "rejected"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function parseString(value: unknown, label: string, maxLength = 100_000): string {
  assertDomain(isString(value), "invalid_argument", `${label} must be a string.`);
  return assertNonBlank(value, label, maxLength);
}

function parseOptionalString(value: unknown, label: string, maxLength = 100_000): string | undefined {
  if (value === undefined) return undefined;
  return parseString(value, label, maxLength);
}

function parseTimestamp(value: unknown, label: string): IsoTimestamp {
  const timestamp = parseString(value, label, 64);
  assertIsoTimestamp(timestamp, label);
  return timestamp;
}

function parseStringArray(value: unknown, label: string, maxItems = 10_000): readonly string[] {
  assertDomain(Array.isArray(value), "invalid_argument", `${label} must be an array.`);
  assertDomain(value.length <= maxItems, "invalid_argument", `${label} contains too many entries.`);
  const parsed = value.map((entry) => parseString(entry, label, 10_000));
  assertDomain(new Set(parsed).size === parsed.length, "conflict", `${label} must contain unique values.`);
  return Object.freeze(parsed);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function parseJsonObject(value: unknown, label: string): JsonObject {
  assertDomain(isRecord(value) && isJsonValue(value), "invalid_argument", `${label} must be JSON object data.`);
  return freezeJson(value as JsonObject);
}

function parseScope(value: unknown): MemoryScopeRef {
  assertDomain(isRecord(value), "invalid_argument", "Memory scope must be an object.");
  const scope = parseString(value.scope, "memory scope", 32);
  assertDomain(isOneOf(MEMORY_SCOPES, scope), "invalid_argument", "Memory scope is not recognized.");
  const profileId = parseString(value.profileId, "memory profile ID", 256) as ProfileId;
  const projectId = parseOptionalString(value.projectId, "memory project ID", 256) as ProjectId | undefined;
  const assistantProfileId = parseOptionalString(
    value.assistantProfileId,
    "memory assistant profile ID",
    256,
  ) as AssistantProfileId | undefined;
  const conversationId = parseOptionalString(
    value.conversationId,
    "memory conversation ID",
    256,
  ) as ConversationId | undefined;
  const result: MemoryScopeRef = {
    scope,
    profileId,
    ...(projectId === undefined ? {} : { projectId }),
    ...(assistantProfileId === undefined ? {} : { assistantProfileId }),
    ...(conversationId === undefined ? {} : { conversationId }),
  };
  return Object.freeze(result);
}

function parseMemoryRevision(value: unknown): MemoryRevision {
  assertDomain(isRecord(value), "invalid_argument", "Memory revision must be an object.");
  const sensitivity = parseStringArray(value.sensitivity, "memory sensitivity", 16) as readonly MemorySensitivity[];
  assertDomain(
    sensitivity.every((entry) => isOneOf(MEMORY_SENSITIVITIES, entry)),
    "invalid_argument",
    "Memory sensitivity contains an unsupported category.",
  );
  const kind = parseString(value.kind, "memory kind", 32);
  assertDomain(isOneOf(MEMORY_KINDS, kind), "invalid_argument", "Memory kind is not recognized.");
  const status = parseString(value.status, "memory revision status", 32);
  assertDomain(isOneOf(MEMORY_STATUSES, status), "invalid_argument", "Memory revision status is not recognized.");
  const origin = parseString(value.origin, "memory origin", 32);
  assertDomain(
    isOneOf(["user", "assistant", "import", "system"] as const, origin),
    "invalid_argument",
    "Memory origin is not recognized.",
  );
  const confidence = value.confidence;
  assertDomain(
    typeof confidence === "number" && Number.isFinite(confidence),
    "invalid_argument",
    "Memory confidence must be a finite number.",
  );
  const userApproved = value.userApproved;
  assertDomain(typeof userApproved === "boolean", "invalid_argument", "Memory approval must be boolean.");
  const pinned = value.pinned;
  assertDomain(typeof pinned === "boolean", "invalid_argument", "Memory pin state must be boolean.");
  return createMemoryRevision({
    id: parseString(value.id, "memory revision ID", 256) as MemoryRevisionId,
    memoryId: parseString(value.memoryId, "memory ID", 256) as MemoryId,
    scope: parseScope(value.scope),
    kind,
    content: parseString(value.content, "memory content", 32_000),
    contentHash: parseString(value.contentHash, "memory content hash", 128),
    evidenceMessageIds: parseStringArray(value.evidenceMessageIds, "memory evidence message IDs") as readonly MessageId[],
    sourceRunIds: parseStringArray(value.sourceRunIds, "memory source run IDs") as readonly RunId[],
    confidence,
    sensitivity,
    origin,
    status,
    userApproved,
    pinned,
    validFrom: parseTimestamp(value.validFrom, "memory validity start"),
    ...(value.expiresAt === undefined ? {} : { expiresAt: parseTimestamp(value.expiresAt, "memory expiry time") }),
    ...(value.supersedesRevisionId === undefined
      ? {}
      : { supersedesRevisionId: parseString(value.supersedesRevisionId, "superseded memory revision ID", 256) as MemoryRevisionId }),
    createdAt: parseTimestamp(value.createdAt, "memory creation time"),
    metadata: parseJsonObject(value.metadata, "memory metadata"),
  });
}

function validateMemoryRecord(memory: Memory): void {
  assertNonBlank(memory.id, "memory ID", 256);
  assertNonBlank(memory.profileId, "memory profile ID", 256);
  assertIsoTimestamp(memory.createdAt, "memory creation time");
  assertIsoTimestamp(memory.updatedAt, "memory update time");
  assertDomain(memory.revisions.length > 0, "invalid_state_transition", "Memory must contain at least one revision.");
  const seenRevisionIds = new Set<MemoryRevisionId>();
  const activeRevisionIds: MemoryRevisionId[] = [];
  for (const revision of memory.revisions) {
    assertDomain(revision.memoryId === memory.id, "scope_violation", "Memory revision belongs to another memory.");
    assertDomain(revision.scope.profileId === memory.profileId, "scope_violation", "Memory revision belongs to another profile.");
    assertDomain(!seenRevisionIds.has(revision.id), "conflict", "Memory contains a duplicate revision ID.");
    seenRevisionIds.add(revision.id);
    createMemoryRevision({
      id: revision.id,
      memoryId: revision.memoryId,
      scope: revision.scope,
      kind: revision.kind,
      content: revision.content,
      contentHash: revision.contentHash,
      evidenceMessageIds: revision.evidenceMessageIds,
      sourceRunIds: revision.sourceRunIds,
      confidence: revision.confidence,
      sensitivity: revision.sensitivity,
      origin: revision.origin,
      status: revision.status,
      userApproved: revision.userApproved,
      pinned: revision.pinned,
      validFrom: revision.validFrom,
      ...(revision.expiresAt === undefined ? {} : { expiresAt: revision.expiresAt }),
      ...(revision.supersedesRevisionId === undefined ? {} : { supersedesRevisionId: revision.supersedesRevisionId }),
      createdAt: revision.createdAt,
      metadata: revision.metadata,
    });
    if (revision.status === "active") activeRevisionIds.push(revision.id);
  }
  assertDomain(activeRevisionIds.length <= 1, "invalid_state_transition", "Memory cannot have two active revisions.");
  assertDomain(
    memory.activeRevisionId === undefined
      ? activeRevisionIds.length === 0
      : activeRevisionIds.length === 1 && activeRevisionIds[0] === memory.activeRevisionId,
    "invalid_state_transition",
    "Memory active revision pointer is inconsistent.",
  );
  if (memory.disabledAt !== undefined) assertIsoTimestamp(memory.disabledAt, "memory disabled time");
  if (memory.deletedAt !== undefined) assertIsoTimestamp(memory.deletedAt, "memory deleted time");
}

function parseMemory(value: unknown): Memory {
  assertDomain(isRecord(value), "invalid_argument", "Memory must be an object.");
  assertDomain(Array.isArray(value.revisions), "invalid_argument", "Memory revisions must be an array.");
  const revisions = Object.freeze(value.revisions.map(parseMemoryRevision));
  const memoryId = parseString(value.id, "memory ID", 256) as MemoryId;
  const profileId = parseString(value.profileId, "memory profile ID", 256) as ProfileId;
  const activeRevisionId = value.activeRevisionId === undefined
    ? undefined
    : parseString(value.activeRevisionId, "active memory revision ID", 256) as MemoryRevisionId;
  const result: Memory = Object.freeze({
    id: memoryId,
    profileId,
    revisions,
    ...(activeRevisionId === undefined ? {} : { activeRevisionId }),
    ...(value.disabledAt === undefined ? {} : { disabledAt: parseTimestamp(value.disabledAt, "memory disabled time") }),
    ...(value.deletedAt === undefined ? {} : { deletedAt: parseTimestamp(value.deletedAt, "memory deleted time") }),
    createdAt: parseTimestamp(value.createdAt, "memory creation time"),
    updatedAt: parseTimestamp(value.updatedAt, "memory update time"),
  });
  validateMemoryRecord(result);
  return result;
}

function validateMemoryProposal(proposal: MemoryProposal): void {
  assertNonBlank(proposal.id, "memory proposal ID", 256);
  assertIsoTimestamp(proposal.createdAt, "memory proposal creation time");
  assertIsoTimestamp(proposal.retainUntil, "memory proposal retention time");
  assertDomain(Date.parse(proposal.retainUntil) >= Date.parse(proposal.createdAt), "invalid_argument", "Proposal retention must not precede creation.");
  assertDomain(Number.isFinite(proposal.qualityScore) && proposal.qualityScore >= 0 && proposal.qualityScore <= 1, "invalid_argument", "Proposal quality score must be between zero and one.");
  assertDomain(isOneOf(PROPOSAL_DECISIONS, proposal.decision), "invalid_argument", "Memory proposal decision is not recognized.");
  assertDomain(
    proposal.proposedRevision.status === "proposed" && !proposal.proposedRevision.userApproved,
    "invalid_state_transition",
    "A memory proposal must contain an unapproved proposed revision.",
    { proposalId: proposal.id },
  );
  createMemoryRevision({
    id: proposal.proposedRevision.id,
    memoryId: proposal.proposedRevision.memoryId,
    scope: proposal.proposedRevision.scope,
    kind: proposal.proposedRevision.kind,
    content: proposal.proposedRevision.content,
    contentHash: proposal.proposedRevision.contentHash,
    evidenceMessageIds: proposal.proposedRevision.evidenceMessageIds,
    sourceRunIds: proposal.proposedRevision.sourceRunIds,
    confidence: proposal.proposedRevision.confidence,
    sensitivity: proposal.proposedRevision.sensitivity,
    origin: proposal.proposedRevision.origin,
    status: "proposed",
    userApproved: false,
    pinned: proposal.proposedRevision.pinned,
    validFrom: proposal.proposedRevision.validFrom,
    ...(proposal.proposedRevision.expiresAt === undefined ? {} : { expiresAt: proposal.proposedRevision.expiresAt }),
    ...(proposal.proposedRevision.supersedesRevisionId === undefined ? {} : { supersedesRevisionId: proposal.proposedRevision.supersedesRevisionId }),
    createdAt: proposal.proposedRevision.createdAt,
    metadata: proposal.proposedRevision.metadata,
  });
  assertDomain(new Set(proposal.contradictionRevisionIds).size === proposal.contradictionRevisionIds.length, "conflict", "Proposal contradiction IDs must be unique.");
  assertDomain(new Set(proposal.duplicateRevisionIds).size === proposal.duplicateRevisionIds.length, "conflict", "Proposal duplicate IDs must be unique.");
}

function createStore(
  profileId: ProfileId,
  memories: readonly Memory[],
  proposals: readonly MemoryProposal[],
  updatedAt: IsoTimestamp,
): OmniaMemoryStore {
  assertNonBlank(profileId, "memory profile ID", 256);
  assertIsoTimestamp(updatedAt, "memory store update time");
  const memoryIds = new Set<MemoryId>();
  for (const memory of memories) {
    validateMemoryRecord(memory);
    assertDomain(memory.profileId === profileId, "scope_violation", "Memory belongs to another profile.");
    assertDomain(!memoryIds.has(memory.id), "conflict", "Memory store contains a duplicate memory ID.");
    memoryIds.add(memory.id);
  }
  const proposalIds = new Set<MemoryProposalId>();
  for (const proposal of proposals) {
    validateMemoryProposal(proposal);
    assertDomain(proposal.proposedRevision.scope.profileId === profileId, "scope_violation", "Memory proposal belongs to another profile.");
    assertDomain(!proposalIds.has(proposal.id), "conflict", "Memory store contains a duplicate proposal ID.");
    proposalIds.add(proposal.id);
  }
  return Object.freeze({
    version: 1,
    profileId,
    memories: Object.freeze([...memories]),
    proposals: Object.freeze([...proposals]),
    updatedAt,
  });
}

function withStoreContents(store: OmniaMemoryStore, memories: readonly Memory[], proposals: readonly MemoryProposal[], now: IsoTimestamp): OmniaMemoryStore {
  return createStore(store.profileId, memories, proposals, now);
}

function getMemoryOrThrow(store: OmniaMemoryStore, memoryId: MemoryId): Memory {
  const memory = store.memories.find((candidate) => candidate.id === memoryId);
  assertDomain(memory !== undefined, "not_found", "Memory was not found.", { memoryId });
  return memory;
}

function getProposalOrThrow(store: OmniaMemoryStore, proposalId: MemoryProposalId): MemoryProposal {
  const proposal = store.proposals.find((candidate) => candidate.id === proposalId);
  assertDomain(proposal !== undefined, "not_found", "Memory proposal was not found.", { proposalId });
  return proposal;
}

export function createOmniaMemoryStore(profileId: ProfileId, now = new Date().toISOString()): OmniaMemoryStore {
  return createStore(profileId, [], [], now);
}

export function validateOmniaMemoryStore(store: OmniaMemoryStore): void {
  createStore(store.profileId, store.memories, store.proposals, store.updatedAt);
}

export function getStoredMemory(store: OmniaMemoryStore, memoryId: MemoryId): Memory | undefined {
  return store.memories.find((memory) => memory.id === memoryId);
}

export function getActiveMemoryRevision(memory: Memory): MemoryRevision | undefined {
  if (memory.activeRevisionId === undefined) return undefined;
  return memory.revisions.find((revision) => revision.id === memory.activeRevisionId);
}

export function addMemoryToStore(store: OmniaMemoryStore, memory: Memory, now = new Date().toISOString()): OmniaMemoryStore {
  validateMemoryRecord(memory);
  assertDomain(memory.profileId === store.profileId, "scope_violation", "Memory belongs to another profile.");
  assertDomain(!store.memories.some((candidate) => candidate.id === memory.id), "conflict", "Memory ID already exists.", { memoryId: memory.id });
  return withStoreContents(store, [...store.memories, memory], store.proposals, now);
}

export function upsertMemoryInStore(store: OmniaMemoryStore, memory: Memory, now = new Date().toISOString()): OmniaMemoryStore {
  validateMemoryRecord(memory);
  assertDomain(memory.profileId === store.profileId, "scope_violation", "Memory belongs to another profile.");
  const memories = store.memories.some((candidate) => candidate.id === memory.id)
    ? store.memories.map((candidate) => candidate.id === memory.id ? memory : candidate)
    : [...store.memories, memory];
  return withStoreContents(store, memories, store.proposals, now);
}

export function appendMemoryRevisionToStore(store: OmniaMemoryStore, revision: MemoryRevision, now = new Date().toISOString()): OmniaMemoryStore {
  assertDomain(revision.scope.profileId === store.profileId, "scope_violation", "Memory revision belongs to another profile.");
  const existing = getStoredMemory(store, revision.memoryId);
  const memory = existing === undefined ? createMemory(revision) : appendMemoryRevision(existing, revision, now);
  return upsertMemoryInStore(store, memory, now);
}

export function disableStoredMemory(store: OmniaMemoryStore, memoryId: MemoryId, now = new Date().toISOString()): OmniaMemoryStore {
  const memory = getMemoryOrThrow(store, memoryId);
  assertDomain(memory.disabledAt === undefined, "conflict", "Memory is already disabled.", { memoryId });
  return upsertMemoryInStore(store, Object.freeze({ ...memory, disabledAt: now, updatedAt: now }), now);
}

export function enableStoredMemory(store: OmniaMemoryStore, memoryId: MemoryId, now = new Date().toISOString()): OmniaMemoryStore {
  const memory = getMemoryOrThrow(store, memoryId);
  assertDomain(memory.disabledAt !== undefined, "invalid_state_transition", "Memory is not disabled.", { memoryId });
  const { disabledAt: _disabledAt, ...rest } = memory;
  return upsertMemoryInStore(store, Object.freeze({ ...rest, updatedAt: now }), now);
}

export function deleteStoredMemory(store: OmniaMemoryStore, memoryId: MemoryId, now = new Date().toISOString()): OmniaMemoryStore {
  const memory = getMemoryOrThrow(store, memoryId);
  assertDomain(memory.deletedAt === undefined, "conflict", "Memory is already deleted.", { memoryId });
  return upsertMemoryInStore(store, Object.freeze({ ...memory, deletedAt: now, updatedAt: now }), now);
}

export function restoreStoredMemory(store: OmniaMemoryStore, memoryId: MemoryId, now = new Date().toISOString()): OmniaMemoryStore {
  const memory = getMemoryOrThrow(store, memoryId);
  assertDomain(memory.deletedAt !== undefined, "invalid_state_transition", "Memory is not deleted.", { memoryId });
  const { deletedAt: _deletedAt, ...rest } = memory;
  return upsertMemoryInStore(store, Object.freeze({ ...rest, updatedAt: now }), now);
}

export function addMemoryProposal(store: OmniaMemoryStore, proposal: MemoryProposal, now = new Date().toISOString()): OmniaMemoryStore {
  validateMemoryProposal(proposal);
  assertDomain(proposal.proposedRevision.scope.profileId === store.profileId, "scope_violation", "Memory proposal belongs to another profile.");
  assertDomain(!store.proposals.some((candidate) => candidate.id === proposal.id), "conflict", "Memory proposal ID already exists.", { proposalId: proposal.id });
  return withStoreContents(store, store.memories, [...store.proposals, proposal], now);
}

function updateProposalDecision(store: OmniaMemoryStore, proposalId: MemoryProposalId, decision: "approved" | "rejected", now: IsoTimestamp): OmniaMemoryStore {
  const proposal = getProposalOrThrow(store, proposalId);
  assertDomain(proposal.decision === "pending", "invalid_state_transition", "Memory proposal has already been decided.", { proposalId });
  const proposals = store.proposals.map((candidate) => candidate.id === proposalId ? Object.freeze({ ...candidate, decision }) : candidate);
  return withStoreContents(store, store.memories, proposals, now);
}

export function approveMemoryProposal(store: OmniaMemoryStore, proposalId: MemoryProposalId, now = new Date().toISOString()): OmniaMemoryStore {
  const proposal = getProposalOrThrow(store, proposalId);
  assertDomain(proposal.decision === "pending", "invalid_state_transition", "Memory proposal has already been decided.", { proposalId });
  const source = proposal.proposedRevision;
  const approvedRevision = createMemoryRevision({
    id: source.id,
    memoryId: source.memoryId,
    scope: source.scope,
    kind: source.kind,
    content: source.content,
    contentHash: source.contentHash,
    evidenceMessageIds: source.evidenceMessageIds,
    sourceRunIds: source.sourceRunIds,
    confidence: source.confidence,
    sensitivity: source.sensitivity,
    origin: source.origin,
    status: "active",
    userApproved: true,
    pinned: source.pinned,
    validFrom: source.validFrom,
    ...(source.expiresAt === undefined ? {} : { expiresAt: source.expiresAt }),
    ...(source.supersedesRevisionId === undefined ? {} : { supersedesRevisionId: source.supersedesRevisionId }),
    createdAt: source.createdAt,
    metadata: source.metadata,
  });
  const existing = getStoredMemory(store, source.memoryId);
  const memory = existing === undefined
    ? createMemory(approvedRevision)
    : existing.revisions.some((revision) => revision.id === approvedRevision.id)
      ? approveMemoryRevision(existing, approvedRevision.id, now)
      : appendMemoryRevision(existing, approvedRevision, now);
  const proposals = store.proposals.map((candidate) => candidate.id === proposalId ? Object.freeze({ ...candidate, decision: "approved" as const }) : candidate);
  return withStoreContents(store, store.memories.some((candidate) => candidate.id === memory.id) ? store.memories.map((candidate) => candidate.id === memory.id ? memory : candidate) : [...store.memories, memory], proposals, now);
}

export function rejectMemoryProposal(store: OmniaMemoryStore, proposalId: MemoryProposalId, now = new Date().toISOString()): OmniaMemoryStore {
  return updateProposalDecision(store, proposalId, "rejected", now);
}

export function queryMemoryStore(store: OmniaMemoryStore, query: MemoryStoreQuery = {}): readonly Memory[] {
  const normalizedText = query.text?.trim().toLocaleLowerCase("en-US");
  const limit = query.limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.floor(query.limit));
  assertDomain(Number.isSafeInteger(limit), "invalid_argument", "Memory query limit must be a non-negative integer.");
  return Object.freeze(store.memories.filter((memory) => {
    if (!query.includeDeleted && memory.deletedAt !== undefined) return false;
    if (!query.includeDisabled && memory.disabledAt !== undefined) return false;
    const revisions = query.includeInactive ? memory.revisions : memory.activeRevisionId === undefined ? [] : memory.revisions.filter((revision) => revision.id === memory.activeRevisionId);
    if (query.kind !== undefined && !revisions.some((revision) => revision.kind === query.kind)) return false;
    if (query.scope !== undefined && !revisions.some((revision) => revision.scope.scope === query.scope)) return false;
    if (normalizedText !== undefined && normalizedText.length > 0 && !revisions.some((revision) => revision.content.toLocaleLowerCase("en-US").includes(normalizedText))) return false;
    return true;
  }).slice(0, limit));
}

export function pruneOmniaMemoryStore(store: OmniaMemoryStore, options: PruneMemoryStoreOptions): OmniaMemoryStore {
  assertIsoTimestamp(options.now, "memory prune time");
  if (options.deleteBefore !== undefined) assertIsoTimestamp(options.deleteBefore, "memory deletion cutoff");
  const nowMs = Date.parse(options.now);
  const memories = store.memories.flatMap((memory) => {
    if (memory.deletedAt !== undefined && options.deleteBefore !== undefined && Date.parse(memory.deletedAt) <= Date.parse(options.deleteBefore)) return [];
    let activeRevisionId = memory.activeRevisionId;
    const revisions = memory.revisions.map((revision) => {
      if (revision.expiresAt !== undefined && Date.parse(revision.expiresAt) <= nowMs && (revision.status === "active" || revision.status === "proposed")) {
        if (activeRevisionId === revision.id) activeRevisionId = undefined;
        return Object.freeze({ ...revision, status: "expired" as const });
      }
      return revision;
    });
    const { activeRevisionId: _previousActiveRevisionId, ...memoryWithoutActiveRevision } = memory;
    const nextMemory = Object.freeze({
      ...memoryWithoutActiveRevision,
      revisions: Object.freeze(revisions),
      ...(activeRevisionId === undefined ? {} : { activeRevisionId }),
      updatedAt: options.now,
    });
    validateMemoryRecord(nextMemory);
    return [nextMemory];
  });
  const proposals = options.removeExpiredProposals
    ? store.proposals.filter((proposal) => Date.parse(proposal.retainUntil) > nowMs)
    : store.proposals;
  return withStoreContents(store, memories, proposals, options.now);
}

function parseMemoryProposal(value: unknown): MemoryProposal {
  assertDomain(isRecord(value), "invalid_argument", "Memory proposal must be an object.");
  const decision = parseString(value.decision, "memory proposal decision", 32);
  assertDomain(isOneOf(PROPOSAL_DECISIONS, decision), "invalid_argument", "Memory proposal decision is not recognized.");
  const qualityScore = value.qualityScore;
  assertDomain(typeof qualityScore === "number" && Number.isFinite(qualityScore), "invalid_argument", "Memory proposal quality score must be finite.");
  const proposal: MemoryProposal = Object.freeze({
    id: parseString(value.id, "memory proposal ID", 256) as MemoryProposalId,
    proposedRevision: parseMemoryRevision(value.proposedRevision),
    createdAt: parseTimestamp(value.createdAt, "memory proposal creation time"),
    retainUntil: parseTimestamp(value.retainUntil, "memory proposal retention time"),
    qualityScore,
    contradictionRevisionIds: parseStringArray(value.contradictionRevisionIds, "proposal contradiction IDs") as readonly MemoryRevisionId[],
    duplicateRevisionIds: parseStringArray(value.duplicateRevisionIds, "proposal duplicate IDs") as readonly MemoryRevisionId[],
    decision,
  });
  validateMemoryProposal(proposal);
  return proposal;
}

function parseStore(value: unknown): OmniaMemoryStore {
  assertDomain(isRecord(value) && value.version === 1, "invalid_argument", "Invalid Omnia memory store.");
  assertDomain(Array.isArray(value.memories) && Array.isArray(value.proposals), "invalid_argument", "Memory store collections are invalid.");
  return createStore(
    parseString(value.profileId, "memory profile ID", 256) as ProfileId,
    value.memories.map(parseMemory),
    value.proposals.map(parseMemoryProposal),
    parseTimestamp(value.updatedAt, "memory store update time"),
  );
}

function parseExport(value: unknown): MemoryStoreExport {
  assertDomain(isRecord(value) && value.schema === "omnia.memory-store" && value.version === 1, "invalid_argument", "Invalid Omnia memory export.");
  const store = parseStore({
    version: 1,
    profileId: value.profileId,
    memories: value.memories,
    proposals: value.proposals,
    updatedAt: value.exportedAt,
  });
  return Object.freeze({
    schema: "omnia.memory-store",
    version: 1,
    exportedAt: store.updatedAt,
    profileId: store.profileId,
    memories: store.memories,
    proposals: store.proposals,
    metadata: parseJsonObject(value.metadata, "memory export metadata"),
  });
}

export function serializeOmniaMemoryStore(store: OmniaMemoryStore): string {
  validateOmniaMemoryStore(store);
  return JSON.stringify(store, null, 2);
}

export function deserializeOmniaMemoryStore(input: string | unknown): OmniaMemoryStore {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  return parseStore(value);
}

export interface MemoryStoreExportOptions {
  readonly includeProposals?: boolean;
  readonly includeDeleted?: boolean;
  readonly metadata?: JsonObject;
  readonly exportedAt?: IsoTimestamp;
}

export function exportOmniaMemoryStore(store: OmniaMemoryStore, options: MemoryStoreExportOptions = {}): MemoryStoreExport {
  validateOmniaMemoryStore(store);
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  assertIsoTimestamp(exportedAt, "memory export time");
  return Object.freeze({
    schema: "omnia.memory-store",
    version: 1,
    exportedAt,
    profileId: store.profileId,
    memories: Object.freeze(options.includeDeleted === false ? store.memories.filter((memory) => memory.deletedAt === undefined) : [...store.memories]),
    proposals: Object.freeze(options.includeProposals === false ? [] : [...store.proposals]),
    metadata: freezeJson(options.metadata ?? {}),
  });
}

export function serializeOmniaMemoryExport(exported: MemoryStoreExport): string {
  return JSON.stringify(exported, null, 2);
}

export function deserializeOmniaMemoryExport(input: string | unknown): MemoryStoreExport {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  return parseExport(value);
}

function resolveImportDocument(input: string | unknown): MemoryStoreExport {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  if (isRecord(value) && value.schema === "omnia.memory-store") return parseExport(value);
  const store = parseStore(value);
  return Object.freeze({
    schema: "omnia.memory-store",
    version: 1,
    exportedAt: store.updatedAt,
    profileId: store.profileId,
    memories: store.memories,
    proposals: store.proposals,
    metadata: {},
  });
}

export function previewOmniaMemoryImport(store: OmniaMemoryStore, input: string | unknown, options: MemoryImportOptions = {}): MemoryImportPreview {
  const document = resolveImportDocument(input);
  assertDomain(document.profileId === store.profileId, "scope_violation", "Memory export belongs to another profile.");
  const mode = options.mode ?? "merge";
  const memoryConflict = options.memoryConflict ?? "keep-existing";
  const proposalConflict = options.proposalConflict ?? "keep-existing";
  let memoryAdds = mode === "replace" ? document.memories.length : 0;
  let memoryReplacements = 0;
  let memorySkips = 0;
  let proposalAdds = mode === "replace" ? document.proposals.length : 0;
  let proposalReplacements = 0;
  let proposalSkips = 0;
  const conflicts: string[] = [];
  if (mode === "merge") {
    for (const memory of document.memories) {
      if (!store.memories.some((candidate) => candidate.id === memory.id)) memoryAdds += 1;
      else if (memoryConflict === "replace-existing") memoryReplacements += 1;
      else if (memoryConflict === "keep-existing") memorySkips += 1;
      else conflicts.push(`memory:${memory.id}`);
    }
    for (const proposal of document.proposals) {
      if (!store.proposals.some((candidate) => candidate.id === proposal.id)) proposalAdds += 1;
      else if (proposalConflict === "replace-existing") proposalReplacements += 1;
      else if (proposalConflict === "keep-existing") proposalSkips += 1;
      else conflicts.push(`proposal:${proposal.id}`);
    }
  }
  return Object.freeze({ mode, memoryAdds, memoryReplacements, memorySkips, proposalAdds, proposalReplacements, proposalSkips, conflicts: Object.freeze(conflicts) });
}

export function importOmniaMemoryStore(store: OmniaMemoryStore, input: string | unknown, options: MemoryImportOptions = {}): OmniaMemoryStore {
  const document = resolveImportDocument(input);
  assertDomain(document.profileId === store.profileId, "scope_violation", "Memory export belongs to another profile.");
  const mode = options.mode ?? "merge";
  const memoryConflict = options.memoryConflict ?? "keep-existing";
  const proposalConflict = options.proposalConflict ?? "keep-existing";
  const now = options.now ?? new Date().toISOString();
  assertIsoTimestamp(now, "memory import time");
  if (mode === "replace") return createStore(store.profileId, document.memories, document.proposals, now);
  let memories = [...store.memories];
  for (const memory of document.memories) {
    const existing = memories.findIndex((candidate) => candidate.id === memory.id);
    if (existing < 0) memories.push(memory);
    else if (memoryConflict === "replace-existing") memories[existing] = memory;
    else if (memoryConflict === "reject") assertDomain(false, "conflict", "Imported memory conflicts with an existing memory.", { memoryId: memory.id });
  }
  let proposals = [...store.proposals];
  for (const proposal of document.proposals) {
    const existing = proposals.findIndex((candidate) => candidate.id === proposal.id);
    if (existing < 0) proposals.push(proposal);
    else if (proposalConflict === "replace-existing") proposals[existing] = proposal;
    else if (proposalConflict === "reject") assertDomain(false, "conflict", "Imported memory proposal conflicts with an existing proposal.", { proposalId: proposal.id });
  }
  return createStore(store.profileId, memories, proposals, now);
}
