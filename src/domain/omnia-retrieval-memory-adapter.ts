import { assertDomain } from "./errors";
import type {
  AssistantProfileId,
  ContextItemId,
  ConversationId,
  MemoryRevisionId,
  ProfileId,
  ProjectId,
  SourceChunkId,
} from "./ids";
import type { ContextItem, ContextScope } from "./context";
import {
  selectMemories,
  type MemoryRetrievalCandidate,
  type MemoryScope,
} from "./memory";
import type { MemoryRevision } from "./memory";
import {
  getActiveMemoryRevision,
  queryMemoryStore,
  type OmniaMemoryStore,
} from "./omnia-memory-store";
import {
  searchRetrievalCatalog,
  type RetrievalCandidate,
  type RetrievalCatalog,
  type RetrievalSearchOptions,
  type RetrievalSourceKind,
} from "./omnia-retrieval-registry";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";

/**
 * Renderer-safe bridge options. Native adapters may construct the memory
 * store/catalog, while this adapter only joins already indexed records.
 */
export interface RetrievalMemoryBridgeInput {
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly assistantProfileId?: AssistantProfileId;
  readonly conversationId?: ConversationId;
  readonly query: string;
  readonly tokenBudget: number;
  readonly now: IsoTimestamp;
  readonly memoryMode?: "off" | "read-only" | "propose" | "auto-low-risk" | "custom";
  readonly temporaryChat?: boolean;
  readonly connectorIds?: readonly string[];
  readonly sourceKinds?: readonly RetrievalSourceKind[];
  readonly minRetrievalScore?: number;
  readonly retrievalLimit?: number;
  readonly maxPerSource?: number;
  readonly excludedMemoryRevisionIds?: readonly MemoryRevisionId[];
  readonly excludedSourceChunkIds?: readonly SourceChunkId[];
}

export type RetrievalMemoryCandidateKind = "memory" | "retrieval";

/** A single provenance-preserving unit before context compilation. */
export interface RetrievalMemoryCandidate {
  readonly id: string;
  readonly kind: RetrievalMemoryCandidateKind;
  readonly content: string;
  readonly contentHash: string;
  readonly tokenEstimate: number;
  readonly relevance: number;
  readonly utility: number;
  readonly recency: number;
  readonly score: number;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly memoryRevision?: MemoryRevision;
  readonly retrievalCandidate?: RetrievalCandidate;
}

export type RetrievalMemoryPlanReason =
  | "selected"
  | "budget"
  | "duplicate"
  | "source-cap";

export interface RetrievalMemoryPlanItem {
  readonly candidate: RetrievalMemoryCandidate;
  readonly disposition: "selected" | "omitted";
  readonly reason: RetrievalMemoryPlanReason;
  readonly selectionOrder?: number;
}

export interface RetrievalMemoryPlan {
  readonly version: 1;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly query: string;
  readonly tokenBudget: number;
  readonly consumedTokens: number;
  readonly items: readonly RetrievalMemoryPlanItem[];
  readonly selected: readonly RetrievalMemoryCandidate[];
  readonly stats: Readonly<{
    candidateCount: number;
    selectedCount: number;
    omittedCount: number;
    distinctSourceCount: number;
    memoryCandidateCount: number;
    retrievalCandidateCount: number;
  }>;
}

const FORBIDDEN_SENSITIVITIES = new Set(["authentication", "secret", "private-key"]);

function tokenize(value: string): readonly string[] {
  return [...new Set(value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_./:-]+/gu) ?? [])];
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function memoryScopeMatches(
  scope: { readonly scope: MemoryScope; readonly profileId: ProfileId; readonly projectId?: ProjectId; readonly assistantProfileId?: AssistantProfileId; readonly conversationId?: ConversationId },
  input: RetrievalMemoryBridgeInput,
): boolean {
  if (scope.profileId !== input.profileId) return false;
  if (scope.scope === "global") return true;
  if (scope.scope === "project") return input.projectId !== undefined && scope.projectId === input.projectId;
  if (scope.scope === "assistant") return input.assistantProfileId !== undefined && scope.assistantProfileId === input.assistantProfileId;
  return input.conversationId !== undefined && scope.conversationId === input.conversationId;
}

function memoryCandidate(
  revision: MemoryRevision,
  queryTerms: readonly string[],
  now: IsoTimestamp,
): MemoryRetrievalCandidate {
  const terms = new Set(tokenize(revision.content));
  const matched = queryTerms.filter((term) => terms.has(term));
  const relevance = queryTerms.length === 0 ? 0 : clamp(matched.length / queryTerms.length);
  const ageDays = Math.max(0, (Date.parse(now) - Date.parse(revision.validFrom)) / 86_400_000);
  const recency = clamp(1 / (1 + ageDays / 30));
  const utility = clamp(revision.confidence);
  const reasons: MemoryRetrievalCandidate["reasons"] = [
    ...(relevance > 0 ? (["query-match"] as const) : []),
    ...(revision.pinned ? (["pinned"] as const) : []),
    ...(revision.kind === "goal" && recency >= 0.5 ? (["recent-active-goal"] as const) : []),
  ];
  return Object.freeze({
    revision,
    relevance,
    recency,
    utility,
    tokenEstimate: estimateTokens(revision.content),
    reasons: Object.freeze(reasons),
  });
}

function sourceScopeMatches(candidate: RetrievalCandidate, input: RetrievalMemoryBridgeInput): boolean {
  return candidate.source.profileId === input.profileId &&
    (input.projectId === undefined
      ? candidate.source.projectId === undefined
      : candidate.source.projectId === undefined || candidate.source.projectId === input.projectId);
}

function toMemoryBridgeCandidate(candidate: MemoryRetrievalCandidate): RetrievalMemoryCandidate {
  const revision = candidate.revision;
  const score = clamp(
    candidate.relevance * 0.5 + candidate.utility * 0.3 + candidate.recency * 0.2 + (revision.pinned ? 0.15 : 0),
  );
  return Object.freeze({
    id: revision.id,
    kind: "memory",
    content: revision.content,
    contentHash: revision.contentHash,
    tokenEstimate: candidate.tokenEstimate,
    relevance: candidate.relevance,
    utility: candidate.utility,
    recency: candidate.recency,
    score,
    sourceId: revision.memoryId,
    sourceLabel: `${revision.kind}: ${revision.content.slice(0, 96)}`,
    profileId: revision.scope.profileId,
    ...(revision.scope.projectId === undefined ? {} : { projectId: revision.scope.projectId }),
    memoryRevision: revision,
  });
}

function toRetrievalBridgeCandidate(candidate: RetrievalCandidate): RetrievalMemoryCandidate {
  return Object.freeze({
    id: candidate.chunk.id,
    kind: "retrieval",
    content: candidate.chunk.text,
    contentHash: candidate.chunk.contentSha256,
    tokenEstimate: candidate.chunk.tokenEstimate,
    relevance: candidate.score,
    utility: candidate.score,
    recency: 1,
    score: candidate.score,
    sourceId: candidate.source.id,
    sourceLabel: candidate.source.displayName,
    profileId: candidate.source.profileId,
    ...(candidate.source.projectId === undefined ? {} : { projectId: candidate.source.projectId }),
    retrievalCandidate: candidate,
  });
}

/**
 * Joins active memory revisions and indexed retrieval chunks into one
 * deterministic plan. No provider, filesystem, network, or native calls are
 * made here; those remain adapter responsibilities.
 */
export function buildRetrievalMemoryPlan(
  input: RetrievalMemoryBridgeInput,
  memoryStore: OmniaMemoryStore,
  retrievalCatalog: RetrievalCatalog,
): RetrievalMemoryPlan {
  const query = assertNonBlank(input.query, "retrieval memory query", 16_000);
  assertIsoTimestamp(input.now, "retrieval memory plan time");
  assertDomain(Number.isSafeInteger(input.tokenBudget) && input.tokenBudget >= 0, "invalid_argument", "Retrieval memory token budget must be a non-negative integer.");
  assertDomain(memoryStore.profileId === input.profileId, "scope_violation", "Memory store belongs to another profile.");
  const maxPerSource = input.maxPerSource ?? Number.MAX_SAFE_INTEGER;
  assertDomain(Number.isSafeInteger(maxPerSource) && maxPerSource > 0, "invalid_argument", "Maximum candidates per source must be positive.");

  const queryTerms = tokenize(query);
  const excludedMemories = new Set(input.excludedMemoryRevisionIds ?? []);
  const excludedChunks = new Set(input.excludedSourceChunkIds ?? []);
  const memoryCandidates = input.memoryMode === "off" || input.temporaryChat
    ? []
    // Query by scope/state first, then score terms locally. The memory-store
    // text filter is a contiguous substring filter and would silently drop a
    // useful memory for a multi-term query such as "release citations".
    : queryMemoryStore(memoryStore, { includeInactive: false, includeDeleted: false, includeDisabled: false })
      .flatMap((memory) => {
        const revision = getActiveMemoryRevision(memory);
        if (revision === undefined || excludedMemories.has(revision.id) || !memoryScopeMatches(revision.scope, input)) return [];
        if (Date.parse(revision.validFrom) > Date.parse(input.now)) return [];
        if (revision.sensitivity.some((category) => FORBIDDEN_SENSITIVITIES.has(category))) return [];
        const candidate = memoryCandidate(revision, queryTerms, input.now);
        // Unmatched memories are not retrieval hits, except for explicitly
        // pinned memories and recent active goals that are intentionally part
        // of the ambient context contract.
        const ambient = revision.pinned || (revision.kind === "goal" && candidate.recency >= 0.5);
        return candidate.relevance > 0 || ambient ? [candidate] : [];
      });
  const selectedMemoryCandidates = selectMemories({
    candidates: memoryCandidates,
    tokenBudget: Number.MAX_SAFE_INTEGER,
    now: input.now,
    temporaryChat: input.temporaryChat ?? false,
    mode: input.memoryMode ?? "read-only",
    excludedRevisionIds: [...excludedMemories],
  });
  const retrievalOptions: RetrievalSearchOptions = {
    profileId: input.profileId,
    ...(input.connectorIds === undefined ? {} : { connectorIds: input.connectorIds }),
    ...(input.sourceKinds === undefined ? {} : { sourceKinds: input.sourceKinds }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.minRetrievalScore === undefined ? {} : { minScore: input.minRetrievalScore }),
    ...(input.retrievalLimit === undefined ? {} : { limit: input.retrievalLimit }),
  };
  const retrievalCandidates = searchRetrievalCatalog(retrievalCatalog, query, retrievalOptions)
    .filter((candidate) => !excludedChunks.has(candidate.chunk.id) && sourceScopeMatches(candidate, input))
    .map(toRetrievalBridgeCandidate);
  const allCandidates = [...selectedMemoryCandidates.map(toMemoryBridgeCandidate), ...retrievalCandidates]
    .sort((left, right) => right.score - left.score || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));

  const seenContent = new Set<string>();
  const sourceCounts = new Map<string, number>();
  const items: RetrievalMemoryPlanItem[] = [];
  const selected: RetrievalMemoryCandidate[] = [];
  let consumedTokens = 0;
  for (const candidate of allCandidates) {
    if (seenContent.has(candidate.contentHash)) {
      items.push(Object.freeze({ candidate, disposition: "omitted", reason: "duplicate" }));
      continue;
    }
    const sourceCount = sourceCounts.get(candidate.sourceId) ?? 0;
    if (sourceCount >= maxPerSource) {
      items.push(Object.freeze({ candidate, disposition: "omitted", reason: "source-cap" }));
      continue;
    }
    if (consumedTokens + candidate.tokenEstimate > input.tokenBudget) {
      items.push(Object.freeze({ candidate, disposition: "omitted", reason: "budget" }));
      continue;
    }
    seenContent.add(candidate.contentHash);
    sourceCounts.set(candidate.sourceId, sourceCount + 1);
    consumedTokens += candidate.tokenEstimate;
    selected.push(candidate);
    items.push(Object.freeze({ candidate, disposition: "selected", reason: "selected", selectionOrder: selected.length - 1 }));
  }
  const memoryCount = allCandidates.filter((candidate) => candidate.kind === "memory").length;
  const retrievalCount = allCandidates.length - memoryCount;
  return Object.freeze({
    version: 1,
    profileId: input.profileId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    query,
    tokenBudget: input.tokenBudget,
    consumedTokens,
    items: Object.freeze(items),
    selected: Object.freeze(selected),
    stats: Object.freeze({
      candidateCount: allCandidates.length,
      selectedCount: selected.length,
      omittedCount: items.length - selected.length,
      distinctSourceCount: sourceCounts.size,
      memoryCandidateCount: memoryCount,
      retrievalCandidateCount: retrievalCount,
    }),
  });
}

function retrievalContextKind(candidate: RetrievalCandidate): ContextItem["kind"] {
  switch (candidate.source.kind) {
    case "workspace_file": return "workspace_chunk";
    case "attachment": return "attachment_chunk";
    case "conversation": return "conversation_summary";
    default: return "connected_source";
  }
}

function contextScope(candidate: RetrievalMemoryCandidate): ContextScope {
  if (candidate.memoryRevision !== undefined) return candidate.memoryRevision.scope.scope;
  return candidate.projectId === undefined ? "global" : "project";
}

/** Projects selected bridge records into the existing context compiler shape. */
export function projectRetrievalMemoryPlanToContextItems(plan: RetrievalMemoryPlan): readonly ContextItem[] {
  return Object.freeze(plan.selected.map((candidate) => {
    const isMemory = candidate.kind === "memory";
    const retrieval = candidate.retrievalCandidate;
    const id = candidate.id as ContextItemId;
    const item: ContextItem = {
      id,
      kind: isMemory ? "memory" : retrievalContextKind(retrieval as RetrievalCandidate),
      contentRef: `${candidate.kind}:${candidate.id}`,
      contentHash: candidate.contentHash,
      sourceRef: candidate.sourceId,
      authority: isMemory ? "derived_summary" : "untrusted_data",
      semanticRole: isMemory ? "memory_background" : "evidence",
      survivalPolicy: isMemory ? "summarizable" : "evictable",
      scope: contextScope(candidate),
      sensitivity: isMemory ? [...(candidate.memoryRevision?.sensitivity ?? [])] : [],
      tokenEstimate: candidate.tokenEstimate,
      relevance: candidate.relevance,
      priority: candidate.score,
      pinned: candidate.memoryRevision?.pinned ?? false,
      required: false,
      summarizable: true,
      cacheClass: isMemory ? "slow" : "dynamic",
      dependencyItemIds: [],
      ...(retrieval === undefined ? {} : { citationRef: retrieval.chunk.id }),
      ...(isMemory
        ? {
            ...(candidate.memoryRevision?.createdAt === undefined ? {} : { createdAt: candidate.memoryRevision.createdAt }),
            ...(candidate.memoryRevision?.expiresAt === undefined ? {} : { expiresAt: candidate.memoryRevision.expiresAt }),
          }
        : {
            ...(retrieval?.chunk.createdAt === undefined ? {} : { createdAt: retrieval.chunk.createdAt }),
          }),
    };
    assertSha256(item.contentHash, "retrieval memory context content hash");
    return Object.freeze(item);
  }));
}
