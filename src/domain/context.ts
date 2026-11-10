import { assertDomain } from "./errors";
import type { ContextItemId, ContextSnapshotId } from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  freezeJson,
  stableSort,
  type IsoTimestamp,
  type JsonObject,
} from "./shared";

export type ContextItemKind =
  | "product_instruction"
  | "organization_instruction"
  | "mode_instruction"
  | "assistant_instruction"
  | "project_instruction"
  | "skill_instruction"
  | "skill_resource"
  | "user_message"
  | "assistant_message"
  | "conversation_summary"
  | "memory"
  | "state_capsule"
  | "attachment_chunk"
  | "workspace_chunk"
  | "connected_source"
  | "tool_result";

/**
 * Semantic authority is intentionally independent from provider roles. A
 * provider adapter may encode several authorities in a `system` message, but
 * that encoding never changes the authority recorded here.
 */
export type ContextAuthority =
  | "platform_invariant"
  | "organization_policy"
  | "mode_contract"
  | "user_instruction"
  | "workflow_guidance"
  | "model_output"
  | "derived_summary"
  | "untrusted_data";

export type ContextSemanticRole =
  | "instruction"
  | "conversation_user"
  | "conversation_assistant"
  | "conversation_tool"
  | "evidence"
  | "memory_background"
  | "state_capsule";

export type ContextSurvivalPolicy =
  | "verbatim_always"
  | "verbatim_recent_tail"
  | "structured_digest_only"
  | "summarizable"
  | "evictable";

export type ContextScope =
  "global" | "project" | "assistant" | "conversation" | "run";
export type ContextCacheClass = "static" | "slow" | "dynamic" | "never_cache";

export interface ContextItem {
  readonly id: ContextItemId;
  readonly kind: ContextItemKind;
  readonly contentRef: string;
  readonly contentHash: string;
  readonly sourceRef: string;
  readonly authority: ContextAuthority;
  readonly semanticRole: ContextSemanticRole;
  readonly survivalPolicy: ContextSurvivalPolicy;
  readonly scope: ContextScope;
  readonly sensitivity: readonly string[];
  readonly tokenEstimate: number;
  readonly relevance: number;
  readonly priority: number;
  readonly pinned: boolean;
  readonly required: boolean;
  readonly summarizable: boolean;
  readonly cacheClass: ContextCacheClass;
  readonly dependencyItemIds: readonly ContextItemId[];
  readonly dependencyGroupId?: string;
  readonly citationRef?: string;
  readonly createdAt?: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly parentItemId?: ContextItemId;
}

export type ContextDecisionDisposition =
  "selected" | "omitted" | "replaced" | "failed";

export type ContextDecisionStage =
  | "resolved"
  | "eligibility"
  | "conflict_resolution"
  | "deduplication"
  | "retrieval_frontier"
  | "budget_allocation"
  | "compaction"
  | "serialization";

export type ContextSelectionReason =
  | "selected.required"
  | "selected.pinned"
  | "selected.by_tier"
  | "selected.retrieval_utility"
  | "selected.memory_utility"
  | "selected.skill_binding";

export type ContextOmissionReason =
  | "omitted.user_excluded"
  | "omitted.expired"
  | "omitted.wrong_scope"
  | "omitted.source_invalidated"
  | "omitted.egress_denied"
  | "omitted.superseded"
  | "omitted.unresolved_contradiction"
  | "omitted.redundant_content"
  | "omitted.frontier_cap"
  | "omitted.per_source_cap"
  | "omitted.dependency_missing"
  | "omitted.budget_exceeded"
  | "omitted.serialization_unsupported";

export type ContextReplacementReason =
  "replaced.structured_digest" | "replaced.compaction_checkpoint";

export type ContextFailureReason =
  "failed.protected_content_overflow" | "failed.integrity_mismatch";

export type ContextDecisionReason =
  | ContextSelectionReason
  | ContextOmissionReason
  | ContextReplacementReason
  | ContextFailureReason;

export interface ContextDecisionScore {
  readonly priority: number;
  readonly relevance: number;
  readonly utility: number;
}

export interface ContextItemDecision {
  readonly item: ContextItem;
  readonly disposition: ContextDecisionDisposition;
  /** Compatibility projection for current inspectors. */
  readonly selected: boolean;
  readonly reason: ContextDecisionReason;
  readonly stage: ContextDecisionStage;
  readonly relatedItemIds: readonly ContextItemId[];
  readonly estimatedTokens: number;
  readonly score: ContextDecisionScore;
  readonly selectionOrder?: number;
  readonly semanticOrder?: number;
  readonly adapterOrder?: number;
  /** @deprecated Use adapterOrder. */
  readonly serializedOrder?: number;
}

export interface ContextPreselectionOmission {
  readonly itemId: ContextItemId;
  readonly reason: ContextOmissionReason;
  readonly stage:
    | "eligibility"
    | "conflict_resolution"
    | "deduplication"
    | "retrieval_frontier";
  readonly relatedItemIds?: readonly ContextItemId[];
}

export interface ContextBudget {
  readonly modelContextLimit: number;
  readonly reservedOutputTokens: number;
  readonly providerOverheadTokens: number;
  readonly toolSchemaTokens: number;
  readonly safetyMarginTokens: number;
  readonly availableInputTokens: number;
}

export interface CompileContextInput {
  readonly snapshotId: ContextSnapshotId;
  readonly candidates: readonly ContextItem[];
  readonly modelContextLimit: number;
  readonly reservedOutputTokens: number;
  readonly providerOverheadTokens: number;
  readonly toolSchemaTokens: number;
  readonly safetyMarginTokens: number;
  readonly excludedItemIds?: readonly ContextItemId[];
  readonly preselectionOmissions?: readonly ContextPreselectionOmission[];
  /** Full candidate permutation defining canonical semantic placement. */
  readonly semanticOrderItemIds?: readonly ContextItemId[];
  /** Full candidate permutation defining provider-adapter item placement. */
  readonly adapterOrderItemIds?: readonly ContextItemId[];
  readonly now: IsoTimestamp;
  readonly tokenizer: string;
  readonly estimatorUncertain: boolean;
  readonly metadata?: JsonObject;
}

export interface CompiledContextSnapshot {
  readonly schemaVersion: 2;
  readonly id: ContextSnapshotId;
  readonly candidates: readonly ContextItemDecision[];
  readonly candidateItemIds: readonly ContextItemId[];
  /** Budget-allocation order, not semantic or provider order. */
  readonly selectedItemIds: readonly ContextItemId[];
  readonly semanticItemIds: readonly ContextItemId[];
  readonly adapterItemIds: readonly ContextItemId[];
  /** @deprecated Use adapterItemIds. */
  readonly serializedItemIds: readonly ContextItemId[];
  readonly budget: ContextBudget;
  readonly consumedInputTokens: number;
  readonly tokenizer: string;
  readonly estimatorUncertain: boolean;
  readonly frozenAt: IsoTimestamp;
  readonly metadata: JsonObject;
}

const RETRIEVED_KINDS = new Set<ContextItemKind>([
  "attachment_chunk",
  "workspace_chunk",
  "connected_source",
  "skill_resource",
]);

const EXPECTED_AUTHORITY_BY_KIND: Readonly<
  Record<ContextItemKind, ContextAuthority>
> = Object.freeze({
  product_instruction: "platform_invariant",
  organization_instruction: "organization_policy",
  mode_instruction: "mode_contract",
  assistant_instruction: "user_instruction",
  project_instruction: "user_instruction",
  skill_instruction: "workflow_guidance",
  skill_resource: "untrusted_data",
  user_message: "user_instruction",
  assistant_message: "model_output",
  conversation_summary: "derived_summary",
  memory: "derived_summary",
  state_capsule: "derived_summary",
  attachment_chunk: "untrusted_data",
  workspace_chunk: "untrusted_data",
  connected_source: "untrusted_data",
  tool_result: "untrusted_data",
});

const EXPECTED_ROLE_BY_KIND: Readonly<
  Record<ContextItemKind, ContextSemanticRole>
> = Object.freeze({
  product_instruction: "instruction",
  organization_instruction: "instruction",
  mode_instruction: "instruction",
  assistant_instruction: "instruction",
  project_instruction: "instruction",
  skill_instruction: "instruction",
  skill_resource: "evidence",
  user_message: "conversation_user",
  assistant_message: "conversation_assistant",
  conversation_summary: "state_capsule",
  memory: "memory_background",
  state_capsule: "state_capsule",
  attachment_chunk: "evidence",
  workspace_chunk: "evidence",
  connected_source: "evidence",
  tool_result: "conversation_tool",
});

const PRESELECTION_OMISSION_REASONS = new Set<ContextOmissionReason>([
  "omitted.wrong_scope",
  "omitted.source_invalidated",
  "omitted.egress_denied",
  "omitted.superseded",
  "omitted.unresolved_contradiction",
  "omitted.redundant_content",
  "omitted.frontier_cap",
  "omitted.per_source_cap",
  "omitted.dependency_missing",
]);

function contextTier(item: ContextItem): number {
  if (
    item.authority === "platform_invariant" ||
    item.authority === "organization_policy" ||
    item.authority === "mode_contract"
  ) {
    return 0;
  }
  if (item.kind === "user_message" && (item.required || item.pinned)) return 1;
  if (
    item.kind === "assistant_instruction" ||
    item.kind === "project_instruction"
  )
    return 2;
  if (item.kind === "skill_instruction") return 3;
  if (
    item.kind === "user_message" ||
    item.kind === "assistant_message" ||
    item.kind === "tool_result"
  )
    return 4;
  if (
    item.kind === "memory" ||
    item.kind === "state_capsule" ||
    RETRIEVED_KINDS.has(item.kind)
  )
    return 5;
  return 6;
}

function utility(item: ContextItem): number {
  const denominator = Math.max(item.tokenEstimate, 1);
  return (
    (item.priority * 2 + item.relevance + (item.pinned ? 100 : 0)) / denominator
  );
}

function decisionScore(item: ContextItem): ContextDecisionScore {
  return Object.freeze({
    priority: item.priority,
    relevance: item.relevance,
    utility: utility(item),
  });
}

function selectedReason(item: ContextItem): ContextSelectionReason {
  if (item.required) return "selected.required";
  if (item.pinned) return "selected.pinned";
  if (RETRIEVED_KINDS.has(item.kind)) return "selected.retrieval_utility";
  if (item.kind === "memory") return "selected.memory_utility";
  if (item.kind === "skill_instruction") return "selected.skill_binding";
  return "selected.by_tier";
}

function freezeContextItem(item: ContextItem): ContextItem {
  return Object.freeze({
    ...item,
    sensitivity: Object.freeze([...item.sensitivity]),
    dependencyItemIds: Object.freeze([...item.dependencyItemIds]),
  });
}

function assertContextItem(item: ContextItem): void {
  assertNonBlank(item.contentRef, "Context content reference");
  assertNonBlank(item.sourceRef, "Context source reference");
  assertSha256(item.contentHash, "context content hash");
  assertDomain(
    Number.isSafeInteger(item.tokenEstimate) && item.tokenEstimate >= 0,
    "invalid_argument",
    "Context token estimate must be a non-negative integer.",
    { itemId: item.id },
  );
  assertDomain(
    Number.isFinite(item.relevance) && item.relevance >= 0,
    "invalid_argument",
    "Context relevance must be a finite non-negative number.",
    { itemId: item.id },
  );
  assertDomain(
    Number.isFinite(item.priority),
    "invalid_argument",
    "Context priority must be finite.",
    { itemId: item.id },
  );
  if (item.createdAt !== undefined)
    assertIsoTimestamp(item.createdAt, "Context creation time");
  if (item.expiresAt !== undefined)
    assertIsoTimestamp(item.expiresAt, "Context expiry time");
  if (item.dependencyGroupId !== undefined)
    assertNonBlank(item.dependencyGroupId, "Context dependency group ID");

  const expectedAuthority = EXPECTED_AUTHORITY_BY_KIND[item.kind];
  assertDomain(
    item.authority === expectedAuthority,
    "scope_violation",
    "Context authority does not match the native source kind.",
    {
      itemId: item.id,
      kind: item.kind,
      authority: item.authority,
      expectedAuthority,
    },
  );
  const expectedRole = EXPECTED_ROLE_BY_KIND[item.kind];
  assertDomain(
    item.semanticRole === expectedRole,
    "scope_violation",
    "Context semantic role does not match the native source kind.",
    {
      itemId: item.id,
      kind: item.kind,
      semanticRole: item.semanticRole,
      expectedRole,
    },
  );
  assertDomain(
    item.survivalPolicy !== "structured_digest_only" ||
      item.semanticRole === "state_capsule" ||
      item.semanticRole === "memory_background",
    "scope_violation",
    "Structured-digest survival is limited to summaries, memory, and state capsules.",
    { itemId: item.id, semanticRole: item.semanticRole },
  );
  assertDomain(
    !item.required ||
      item.survivalPolicy === "verbatim_always" ||
      item.survivalPolicy === "structured_digest_only",
    "scope_violation",
    "Required context must have a protected survival policy.",
    { itemId: item.id, survivalPolicy: item.survivalPolicy },
  );

  const dependencies = new Set<ContextItemId>();
  for (const dependencyId of item.dependencyItemIds) {
    assertDomain(
      dependencyId !== item.id,
      "invalid_argument",
      "A context item cannot depend on itself.",
      {
        itemId: item.id,
      },
    );
    assertDomain(
      !dependencies.has(dependencyId),
      "conflict",
      "Context dependency ID appears more than once.",
      {
        itemId: item.id,
        dependencyId,
      },
    );
    dependencies.add(dependencyId);
  }
}

function assertDependencyGraph(
  items: readonly ContextItem[],
  byId: ReadonlyMap<ContextItemId, ContextItem>,
): void {
  for (const item of items) {
    for (const dependencyId of item.dependencyItemIds) {
      assertDomain(
        byId.has(dependencyId),
        "invalid_argument",
        "Context dependency does not exist in the candidate set.",
        {
          itemId: item.id,
          dependencyId,
        },
      );
    }
  }

  const visiting = new Set<ContextItemId>();
  const visited = new Set<ContextItemId>();
  const visit = (item: ContextItem): void => {
    if (visited.has(item.id)) return;
    assertDomain(
      !visiting.has(item.id),
      "conflict",
      "Context dependency graph contains a cycle.",
      {
        itemId: item.id,
      },
    );
    visiting.add(item.id);
    for (const dependencyId of item.dependencyItemIds) {
      const dependency = byId.get(dependencyId);
      assertDomain(
        dependency !== undefined,
        "invalid_state_transition",
        "Validated context dependency disappeared.",
      );
      visit(dependency);
    }
    visiting.delete(item.id);
    visited.add(item.id);
  };
  for (const item of items) visit(item);
}

function normalizedCandidateOrder(
  label: string,
  requested: readonly ContextItemId[] | undefined,
  candidates: readonly ContextItem[],
  candidateById: ReadonlyMap<ContextItemId, ContextItem>,
): readonly ContextItemId[] {
  const order = requested ?? candidates.map((candidate) => candidate.id);
  assertDomain(
    order.length === candidates.length,
    "invalid_argument",
    `${label} must include every context candidate exactly once.`,
  );
  const seen = new Set<ContextItemId>();
  for (const id of order) {
    assertDomain(
      candidateById.has(id),
      "invalid_argument",
      `${label} references an unknown context candidate.`,
      {
        itemId: id,
      },
    );
    assertDomain(
      !seen.has(id),
      "conflict",
      `${label} contains a duplicate context candidate.`,
      { itemId: id },
    );
    seen.add(id);
  }
  return Object.freeze([...order]);
}

function omittedDecision(
  item: ContextItem,
  reason: ContextOmissionReason,
  stage: ContextDecisionStage,
  relatedItemIds: readonly ContextItemId[] = [],
): ContextItemDecision {
  return Object.freeze({
    item,
    disposition: "omitted",
    selected: false,
    reason,
    stage,
    relatedItemIds: Object.freeze([...relatedItemIds]),
    estimatedTokens: item.tokenEstimate,
    score: decisionScore(item),
  });
}

export function createContextBudget(
  input: Omit<
    CompileContextInput,
    | "snapshotId"
    | "candidates"
    | "excludedItemIds"
    | "preselectionOmissions"
    | "semanticOrderItemIds"
    | "adapterOrderItemIds"
    | "now"
    | "tokenizer"
    | "estimatorUncertain"
    | "metadata"
  >,
): ContextBudget {
  const values = [
    input.modelContextLimit,
    input.reservedOutputTokens,
    input.providerOverheadTokens,
    input.toolSchemaTokens,
    input.safetyMarginTokens,
  ];
  assertDomain(
    values.every((value) => Number.isSafeInteger(value) && value >= 0),
    "invalid_argument",
    "Context token budgets must be non-negative safe integers.",
  );
  const availableInputTokens =
    input.modelContextLimit -
    input.reservedOutputTokens -
    input.providerOverheadTokens -
    input.toolSchemaTokens -
    input.safetyMarginTokens;
  assertDomain(
    availableInputTokens >= 0,
    "context_overflow",
    "Reserved output and overhead exceed the model context window.",
    { modelContextLimit: input.modelContextLimit },
  );
  return Object.freeze({ ...input, availableInputTokens });
}

/**
 * Pure reference compiler for the C0 contract. Production dispatch must use a
 * native-owned compiler and frozen repository; this function cannot create a
 * dispatchable provider input.
 */
export function compileContext(
  input: CompileContextInput,
): CompiledContextSnapshot {
  assertIsoTimestamp(input.now, "Context compile time");
  assertNonBlank(input.tokenizer, "Context tokenizer");
  const budget = createContextBudget(input);
  const excluded = new Set(input.excludedItemIds ?? []);
  const candidates = input.candidates.map(freezeContextItem);
  const candidateById = new Map<ContextItemId, ContextItem>();
  for (const item of candidates) {
    assertDomain(
      !candidateById.has(item.id),
      "conflict",
      "Context item ID appears more than once.",
      {
        itemId: item.id,
      },
    );
    assertContextItem(item);
    candidateById.set(item.id, item);
  }
  for (const excludedId of excluded) {
    assertDomain(
      candidateById.has(excludedId),
      "invalid_argument",
      "Excluded context item does not exist.",
      {
        itemId: excludedId,
      },
    );
  }
  assertDependencyGraph(candidates, candidateById);

  const semanticCandidateOrder = normalizedCandidateOrder(
    "Semantic context order",
    input.semanticOrderItemIds,
    candidates,
    candidateById,
  );
  const adapterCandidateOrder = normalizedCandidateOrder(
    "Adapter context order",
    input.adapterOrderItemIds ?? semanticCandidateOrder,
    candidates,
    candidateById,
  );

  const preselectionById = new Map<
    ContextItemId,
    ContextPreselectionOmission
  >();
  for (const omission of input.preselectionOmissions ?? []) {
    assertDomain(
      candidateById.has(omission.itemId),
      "invalid_argument",
      "Preselection omission references an unknown candidate.",
      {
        itemId: omission.itemId,
      },
    );
    assertDomain(
      !preselectionById.has(omission.itemId),
      "conflict",
      "Context candidate has more than one preselection omission.",
      {
        itemId: omission.itemId,
      },
    );
    assertDomain(
      PRESELECTION_OMISSION_REASONS.has(omission.reason),
      "invalid_argument",
      "Preselection omission uses a reason owned by a later compiler stage.",
      { itemId: omission.itemId, reason: omission.reason },
    );
    preselectionById.set(
      omission.itemId,
      Object.freeze({
        ...omission,
        relatedItemIds: Object.freeze([...(omission.relatedItemIds ?? [])]),
      }),
    );
  }

  const now = Date.parse(input.now);
  const decisions = new Map<ContextItemId, ContextItemDecision>();
  const eligible: ContextItem[] = [];
  for (const item of candidates) {
    if (excluded.has(item.id)) {
      assertDomain(
        !item.required,
        "permission_denied",
        "A required context item cannot be excluded.",
        {
          itemId: item.id,
        },
      );
      decisions.set(
        item.id,
        omittedDecision(item, "omitted.user_excluded", "eligibility"),
      );
      continue;
    }
    if (item.expiresAt !== undefined && Date.parse(item.expiresAt) <= now) {
      assertDomain(
        !item.required,
        "context_overflow",
        "A required context item has expired.",
        {
          itemId: item.id,
        },
      );
      decisions.set(
        item.id,
        omittedDecision(item, "omitted.expired", "eligibility"),
      );
      continue;
    }
    const preselection = preselectionById.get(item.id);
    if (preselection !== undefined) {
      assertDomain(
        !item.required && !item.pinned,
        "context_overflow",
        "A required or pinned context item was omitted before budget allocation.",
        { itemId: item.id, reason: preselection.reason },
      );
      decisions.set(
        item.id,
        omittedDecision(
          item,
          preselection.reason,
          preselection.stage,
          preselection.relatedItemIds,
        ),
      );
      continue;
    }
    eligible.push(item);
  }

  const ordered = stableSort(eligible, (left, right) => {
    const tier = contextTier(left) - contextTier(right);
    if (tier !== 0) return tier;
    if (left.required !== right.required) return left.required ? -1 : 1;
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return utility(right) - utility(left);
  });
  const selectionIndex = new Map(
    ordered.map((item, index) => [item.id, index]),
  );
  const groupMembers = new Map<string, ContextItem[]>();
  for (const item of candidates) {
    if (item.dependencyGroupId === undefined) continue;
    const group = groupMembers.get(item.dependencyGroupId) ?? [];
    group.push(item);
    groupMembers.set(item.dependencyGroupId, group);
  }

  const selectionUnit = (root: ContextItem): readonly ContextItem[] => {
    const collected = new Map<ContextItemId, ContextItem>();
    const collect = (item: ContextItem): void => {
      if (collected.has(item.id)) return;
      collected.set(item.id, item);
      if (item.dependencyGroupId !== undefined) {
        for (const member of groupMembers.get(item.dependencyGroupId) ?? [])
          collect(member);
      }
      for (const dependencyId of item.dependencyItemIds) {
        const dependency = candidateById.get(dependencyId);
        assertDomain(
          dependency !== undefined,
          "invalid_state_transition",
          "Validated context dependency disappeared.",
        );
        collect(dependency);
      }
    };
    collect(root);
    return stableSort([...collected.values()], (left, right) => {
      const leftIndex = selectionIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex =
        selectionIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    });
  };

  let consumed = 0;
  const selected: ContextItem[] = [];
  for (const item of ordered) {
    if (decisions.has(item.id)) continue;
    const unit = selectionUnit(item);
    const unavailableDependencies = unit.filter((member) => {
      const decision = decisions.get(member.id);
      return decision !== undefined && !decision.selected;
    });
    if (unavailableDependencies.length > 0) {
      const protectedMember = unit.find(
        (member) => member.required || member.pinned,
      );
      assertDomain(
        protectedMember === undefined,
        "context_overflow",
        "A protected context dependency is unavailable.",
        {
          itemId: protectedMember?.id,
          unavailableDependencyIds: unavailableDependencies.map(
            (member) => member.id,
          ),
        },
      );
      const missingIds = Object.freeze(
        unavailableDependencies.map((member) => member.id),
      );
      for (const member of unit) {
        if (!decisions.has(member.id)) {
          decisions.set(
            member.id,
            omittedDecision(
              member,
              "omitted.dependency_missing",
              "eligibility",
              missingIds,
            ),
          );
        }
      }
      continue;
    }

    const pending = unit.filter((member) => !decisions.has(member.id));
    const unitTokens = pending.reduce(
      (sum, member) => sum + member.tokenEstimate,
      0,
    );
    const fits = consumed + unitTokens <= budget.availableInputTokens;
    const protectedMember = pending.find(
      (member) => member.required || member.pinned,
    );
    assertDomain(
      fits || protectedMember === undefined,
      "context_overflow",
      "Required or pinned context cannot fit without destructive truncation.",
      {
        itemId: protectedMember?.id,
        availableInputTokens: budget.availableInputTokens,
        consumed,
        requiredUnitTokens: unitTokens,
      },
    );
    if (!fits) {
      for (const member of pending) {
        decisions.set(
          member.id,
          omittedDecision(
            member,
            "omitted.budget_exceeded",
            "budget_allocation",
          ),
        );
      }
      continue;
    }

    for (const member of pending) {
      const selectionOrder = selected.length;
      selected.push(member);
      consumed += member.tokenEstimate;
      decisions.set(
        member.id,
        Object.freeze({
          item: member,
          disposition: "selected",
          selected: true,
          reason: selectedReason(member),
          stage: "budget_allocation",
          relatedItemIds: Object.freeze([...member.dependencyItemIds]),
          estimatedTokens: member.tokenEstimate,
          score: decisionScore(member),
          selectionOrder,
        }),
      );
    }
  }

  const selectedSet = new Set(selected.map((item) => item.id));
  const semanticItemIds = Object.freeze(
    semanticCandidateOrder.filter((id) => selectedSet.has(id)),
  );
  const adapterItemIds = Object.freeze(
    adapterCandidateOrder.filter((id) => selectedSet.has(id)),
  );
  const semanticOrderById = new Map(
    semanticItemIds.map((id, index) => [id, index]),
  );
  const adapterOrderById = new Map(
    adapterItemIds.map((id, index) => [id, index]),
  );

  for (const item of selected) {
    const decision = decisions.get(item.id);
    const semanticOrder = semanticOrderById.get(item.id);
    const adapterOrder = adapterOrderById.get(item.id);
    assertDomain(
      decision?.selected === true &&
        semanticOrder !== undefined &&
        adapterOrder !== undefined,
      "invalid_state_transition",
      "Selected context item is missing an order projection.",
      { itemId: item.id },
    );
    decisions.set(
      item.id,
      Object.freeze({
        ...decision,
        semanticOrder,
        adapterOrder,
        serializedOrder: adapterOrder,
      }),
    );
  }

  const candidateDecisions = candidates.map((item) => {
    const decision = decisions.get(item.id);
    assertDomain(
      decision !== undefined,
      "invalid_state_transition",
      "Context candidate has no decision.",
      {
        itemId: item.id,
      },
    );
    return decision;
  });

  return Object.freeze({
    schemaVersion: 2,
    id: input.snapshotId,
    candidates: Object.freeze(candidateDecisions),
    candidateItemIds: Object.freeze(candidates.map((item) => item.id)),
    selectedItemIds: Object.freeze(selected.map((item) => item.id)),
    semanticItemIds,
    adapterItemIds,
    serializedItemIds: adapterItemIds,
    budget,
    consumedInputTokens: consumed,
    tokenizer: input.tokenizer,
    estimatorUncertain: input.estimatorUncertain,
    frozenAt: input.now,
    metadata: freezeJson({ ...(input.metadata ?? {}) }),
  });
}
