import { assertDomain } from "./errors";
import type {
  AttemptId,
  BranchId,
  ConversationId,
  IterationId,
  ProjectId,
  ProfileId,
  RunId,
  RunItemId,
  TaskId,
} from "./ids";
import { assertIsoTimestamp, assertNonBlank, freezeJson, type IsoTimestamp, type JsonObject } from "./shared";

export type RunGraphNodeKind =
  | "profile"
  | "project"
  | "conversation"
  | "branch"
  | "task"
  | "run"
  | "attempt"
  | "iteration"
  | "item";

export type RunGraphNodeId =
  | ProfileId
  | ProjectId
  | ConversationId
  | BranchId
  | TaskId
  | RunId
  | AttemptId
  | IterationId
  | RunItemId;

export type RunGraphNodeMetadata =
  | { readonly kind: "profile"; readonly metadata: JsonObject }
  | { readonly kind: "project"; readonly metadata: JsonObject }
  | { readonly kind: "conversation"; readonly metadata: JsonObject }
  | { readonly kind: "branch"; readonly metadata: JsonObject }
  | { readonly kind: "task"; readonly metadata: JsonObject }
  | { readonly kind: "run"; readonly metadata: JsonObject }
  | { readonly kind: "attempt"; readonly metadata: JsonObject }
  | { readonly kind: "iteration"; readonly metadata: JsonObject }
  | {
      readonly kind: "item";
      readonly metadata: JsonObject & {
        /** Stable item category, for example message, tool-call, artifact, or approval. */
        readonly type: string;
        /** Component that produced this item; never inferred from UI placement. */
        readonly producer: string;
        /** Durable lifecycle state such as started, completed, interrupted, or failed. */
        readonly status: string;
      };
    };

export interface RunGraphNode {
  readonly id: RunGraphNodeId;
  readonly kind: RunGraphNodeKind;
  readonly parentId?: RunGraphNodeId;
  readonly ordinal: number;
  readonly createdAt: IsoTimestamp;
  readonly metadata: JsonObject;
}

function validateNodeMetadata(input: RunGraphNode): void {
  if (input.kind !== "item") return;
  assertNonBlank(String(input.metadata.type ?? ""), "run item type", 160);
  assertNonBlank(String(input.metadata.producer ?? ""), "run item producer", 256);
  assertNonBlank(String(input.metadata.status ?? ""), "run item status", 80);
}

export interface UnifiedRunGraph {
  readonly version: 1;
  /** Optional scope roots. A project and profile root are mutually exclusive. */
  readonly projectId?: ProjectId;
  readonly profileId?: ProfileId;
  /** Present only for an explicitly project/profile-less conversation root. */
  readonly conversationId?: ConversationId;
  readonly nodes: readonly RunGraphNode[];
}

type ParentKind = RunGraphNodeKind | undefined;

/**
 * Task is intentionally optional for ordinary chat. A run may attach directly
 * to a conversation or branch; task nodes remain available for explicit goals,
 * plans, and background work. Branch is a durable routing boundary, not UI
 * metadata, so branch-scoped runs can be projected without guessing lineage.
 */
const ALLOWED_PARENT_KIND: Readonly<Record<RunGraphNodeKind, readonly ParentKind[]>> = {
  profile: [undefined],
  project: [undefined],
  conversation: ["profile", "project", undefined],
  branch: ["conversation", "branch"],
  task: ["conversation", "branch"],
  run: ["task", "conversation", "branch"],
  attempt: ["run"],
  iteration: ["attempt"],
  item: ["iteration"],
};

export interface UnifiedRunGraphScope {
  readonly projectId?: ProjectId;
  readonly profileId?: ProfileId;
}

/**
 * Creates a graph with an optional project/profile scope. Passing no scope is
 * retained for backwards compatibility and permits one explicit conversation
 * root; callers should pass a profile ID for durable projectless chat.
 */
export function createUnifiedRunGraph(
  scope?: ProjectId | UnifiedRunGraphScope,
): UnifiedRunGraph {
  const normalizedScope: UnifiedRunGraphScope =
    typeof scope === "string" ? { projectId: scope } : (scope ?? {});
  assertDomain(
    !(normalizedScope.projectId !== undefined && normalizedScope.profileId !== undefined),
    "invalid_argument",
    "A unified run graph cannot have both project and profile scope roots.",
  );
  return Object.freeze({
    version: 1,
    ...(normalizedScope.projectId === undefined ? {} : { projectId: normalizedScope.projectId }),
    ...(normalizedScope.profileId === undefined ? {} : { profileId: normalizedScope.profileId }),
    nodes: Object.freeze([]),
  });
}

function hasAncestor(
  nodes: readonly RunGraphNode[],
  startId: RunGraphNodeId,
  candidateAncestorId: RunGraphNodeId,
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let current = byId.get(startId);
  while (current?.parentId !== undefined) {
    if (current.parentId === candidateAncestorId) return true;
    current = byId.get(current.parentId);
  }
  return false;
}

/** Appends a durable graph node without allowing re-parenting or cycles. */
export function appendRunGraphNode(
  graph: UnifiedRunGraph,
  input: RunGraphNode,
): UnifiedRunGraph {
  assertIsoTimestamp(input.createdAt, "run graph node creation time");
  validateNodeMetadata(input);
  assertDomain(
    Number.isSafeInteger(input.ordinal) && input.ordinal >= 0,
    "invalid_argument",
    "Run graph ordinal must be a non-negative safe integer.",
  );
  assertDomain(
    !graph.nodes.some((node) => node.id === input.id),
    "conflict",
    "Run graph node ID already exists.",
    { nodeId: input.id },
  );

  const expectedParentKinds = ALLOWED_PARENT_KIND[input.kind];
  let projectId = graph.projectId;
  let profileId = graph.profileId;
  let conversationId = graph.conversationId;
  if (input.parentId === undefined) {
    assertDomain(
      expectedParentKinds.includes(undefined),
      "invalid_argument",
      `${input.kind} nodes require a parent.`,
    );
    assertDomain(
      !graph.nodes.some((node) => node.parentId === undefined),
      "conflict",
      "A unified run graph can contain only one scope root.",
    );
    if (input.kind === "project") {
      assertDomain(
        graph.projectId === undefined || graph.projectId === input.id,
        "scope_violation",
        "Project node does not match the graph project scope.",
      );
      assertDomain(graph.profileId === undefined, "scope_violation", "Project scope conflicts with profile scope.");
      projectId = input.id as ProjectId;
    } else if (input.kind === "profile") {
      assertDomain(
        graph.profileId === undefined || graph.profileId === input.id,
        "scope_violation",
        "Profile node does not match the graph profile scope.",
      );
      assertDomain(graph.projectId === undefined, "scope_violation", "Profile scope conflicts with project scope.");
      profileId = input.id as ProfileId;
    } else {
      assertDomain(
        graph.projectId === undefined && graph.profileId === undefined,
        "scope_violation",
        "A conversation root cannot be added to a project/profile-scoped graph.",
      );
      conversationId = input.id as ConversationId;
    }
  } else {
    const parent = graph.nodes.find((node) => node.id === input.parentId);
    assertDomain(parent !== undefined, "not_found", "Run graph parent was not found.", {
      parentId: input.parentId,
    });
    assertDomain(
      expectedParentKinds.includes(parent.kind),
      "scope_violation",
      `${input.kind} node has an invalid parent kind.`,
      { parentKind: parent.kind },
    );
    assertDomain(
      Date.parse(input.createdAt) >= Date.parse(parent.createdAt),
      "invalid_argument",
      "A run graph child cannot be created before its parent.",
      { parentId: parent.id, nodeId: input.id },
    );
    assertDomain(
      !hasAncestor(graph.nodes, parent.id, input.id),
      "scope_violation",
      "Run graph edges cannot create a cycle.",
    );
    const siblingOrdinals = graph.nodes
      .filter((node) => node.parentId === input.parentId && node.kind === input.kind)
      .map((node) => node.ordinal);
    assertDomain(
      !siblingOrdinals.includes(input.ordinal),
      "conflict",
      "Sibling run graph ordinals must be unique.",
      { parentId: input.parentId, ordinal: input.ordinal },
    );
  }

  const node = Object.freeze({
    ...input,
    metadata: freezeJson(input.metadata),
  });
  return Object.freeze({
    ...graph,
    ...(projectId === undefined ? {} : { projectId }),
    ...(profileId === undefined ? {} : { profileId }),
    ...(conversationId === undefined ? {} : { conversationId }),
    nodes: Object.freeze([...graph.nodes, node]),
  });
}

export function assertRunGraphIntegrity(graph: UnifiedRunGraph): void {
  assertDomain(graph.version === 1, "invalid_argument", "Unsupported run graph version.");
  const seen = new Set<RunGraphNodeId>();
  for (const [index, node] of graph.nodes.entries()) {
    assertNonBlank(node.id, "run graph node ID", 128);
    assertDomain(!seen.has(node.id), "conflict", "Run graph contains a duplicate node ID.");
    seen.add(node.id);
    const prefix = graph.nodes.slice(0, index);
    appendRunGraphNode(Object.freeze({ ...graph, nodes: Object.freeze(prefix) }), node);
  }
  const roots = graph.nodes.filter((node) => node.parentId === undefined);
  assertDomain(roots.length <= 1, "conflict", "Run graph contains multiple scope roots.");
  if (graph.projectId !== undefined) {
    assertDomain(
      roots.length === 1 && roots[0]?.kind === "project" && roots[0]?.id === graph.projectId,
      "invalid_state_transition",
      "Run graph project scope and root node disagree.",
    );
  }
  if (graph.profileId !== undefined) {
    assertDomain(
      roots.length === 1 && roots[0]?.kind === "profile" && roots[0]?.id === graph.profileId,
      "invalid_state_transition",
      "Run graph profile scope and root node disagree.",
    );
  }
  if (graph.conversationId !== undefined) {
    assertDomain(
      roots.length === 1 && roots[0]?.kind === "conversation" && roots[0]?.id === graph.conversationId,
      "invalid_state_transition",
      "Run graph conversation root and scope disagree.",
    );
  }
}

export function lineageForRunGraphNode(
  graph: UnifiedRunGraph,
  nodeId: RunGraphNodeId,
): readonly RunGraphNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const node = byId.get(nodeId);
  assertDomain(node !== undefined, "not_found", "Run graph node was not found.", { nodeId });
  const lineage: RunGraphNode[] = [node];
  const visited = new Set<RunGraphNodeId>([node.id]);
  let current = node;
  while (current.parentId !== undefined) {
    assertDomain(
      !visited.has(current.parentId),
      "invalid_state_transition",
      "Run graph lineage contains a cycle.",
      { nodeId, repeatedNodeId: current.parentId },
    );
    visited.add(current.parentId);
    const parent = byId.get(current.parentId);
    assertDomain(parent !== undefined, "invalid_state_transition", "Run graph parent is missing.");
    lineage.unshift(parent);
    current = parent;
  }
  return Object.freeze(lineage);
}
