import { assertDomain } from "./errors";
import type { ConcreteExecutionMode } from "./execution";
import type {
  BranchId,
  ContextSnapshotId,
  ExecutionEnvironmentId,
  RunId,
  RunItemId,
  WorkspaceGrantId,
} from "./ids";
import type { KernelCapability } from "./kernel-capability";
import {
  assertIntegerInRange,
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";
import {
  assertNonNegativeSafeInteger,
  EXECUTION_MODE_VALUES,
  KERNEL_CAPABILITY_VALUES,
  type AgentInstanceId,
  type ToolVersionId,
  uniqueValues,
  valuesAreSubset,
} from "./agent-tool-contract-shared";

export interface AgentResourceBudget {
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly maximumCostMicrounits: number;
  readonly maximumWallClockMs: number;
  readonly maximumToolInvocations: number;
  readonly maximumChildren: number;
  readonly maximumMutationOperations: number;
  readonly maximumMailboxBytes: number;
}

export interface AgentAuthorityCeiling {
  readonly capabilities: readonly KernelCapability[];
  readonly toolVersionIds: readonly ToolVersionId[];
  readonly workspaceGrantIds: readonly WorkspaceGrantId[];
  readonly environmentIds: readonly ExecutionEnvironmentId[];
}

export type AgentContextMode = "fresh" | "fork" | "persistent" | "team";
export type AgentRole =
  | "orchestrator"
  | "planner"
  | "explorer"
  | "builder"
  | "reviewer"
  | "verifier"
  | "researcher"
  | "specialist";

export type AgentState =
  | "created"
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "orphaned"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentTerminalState = Extract<
  AgentState,
  "completed" | "failed" | "cancelled"
>;

export type AgentOutputRoute =
  | {
      readonly kind: "fixed";
      readonly branchId: BranchId;
      readonly expectedParentItemId?: RunItemId;
    }
  | { readonly kind: "inbox-only" }
  | {
      readonly kind: "follow-active";
      /** Explicit user or policy authorization for this non-default routing behavior. */
      readonly authorizationHash: string;
    };

export interface AgentInstance {
  readonly id: AgentInstanceId;
  readonly parentAgentId?: AgentInstanceId;
  readonly spawnOrdinal: number;
  readonly depth: number;
  readonly role: AgentRole;
  readonly label: string;
  readonly objective: string;
  readonly completionContractHash: string;
  readonly templateVersionHash: string;
  readonly providerPolicyHash: string;
  readonly contextMode: AgentContextMode;
  readonly contextSnapshotId: ContextSnapshotId;
  readonly runId: RunId;
  readonly executionEnvironmentId?: ExecutionEnvironmentId;
  readonly executionMode?: ConcreteExecutionMode;
  readonly authority: AgentAuthorityCeiling;
  readonly budget: AgentResourceBudget;
  readonly outputRoute: AgentOutputRoute;
  readonly state: AgentState;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly terminalAt?: IsoTimestamp;
  readonly terminalReason?: string;
}

export interface AgentGraph {
  readonly version: 1;
  readonly rootRunId: RunId;
  readonly branchId: BranchId;
  readonly maximumAgents: number;
  readonly maximumDepth: number;
  readonly agents: readonly AgentInstance[];
}

export interface CreateAgentGraphInput {
  readonly rootRunId: RunId;
  readonly branchId: BranchId;
  readonly maximumAgents: number;
  readonly maximumDepth: number;
}

const AGENT_CONTEXT_MODE_VALUES: ReadonlySet<AgentContextMode> = new Set([
  "fresh",
  "fork",
  "persistent",
  "team",
]);
const AGENT_ROLE_VALUES: ReadonlySet<AgentRole> = new Set([
  "orchestrator",
  "planner",
  "explorer",
  "builder",
  "reviewer",
  "verifier",
  "researcher",
  "specialist",
]);
const AGENT_STATE_VALUES: ReadonlySet<AgentState> = new Set([
  "created",
  "queued",
  "running",
  "waiting",
  "blocked",
  "orphaned",
  "completed",
  "failed",
  "cancelled",
]);

const AGENT_TRANSITIONS = {
  created: ["queued", "cancelled"],
  queued: ["running", "cancelled", "failed", "orphaned"],
  running: [
    "waiting",
    "blocked",
    "completed",
    "failed",
    "cancelled",
    "orphaned",
  ],
  waiting: [
    "running",
    "blocked",
    "completed",
    "failed",
    "cancelled",
    "orphaned",
  ],
  blocked: ["running", "failed", "cancelled", "orphaned"],
  orphaned: ["queued", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies Readonly<Record<AgentState, readonly AgentState[]>>;

const AGENT_BUDGET_KEYS = [
  "maximumInputTokens",
  "maximumOutputTokens",
  "maximumCostMicrounits",
  "maximumWallClockMs",
  "maximumToolInvocations",
  "maximumChildren",
  "maximumMutationOperations",
  "maximumMailboxBytes",
] as const satisfies readonly (keyof AgentResourceBudget)[];

function freezeAgentBudget(input: AgentResourceBudget): AgentResourceBudget {
  for (const key of AGENT_BUDGET_KEYS) {
    assertNonNegativeSafeInteger(input[key], `Agent budget ${key}`);
  }
  return Object.freeze({ ...input });
}

function normalizeAuthority(
  input: AgentAuthorityCeiling,
): AgentAuthorityCeiling {
  assertDomain(
    input.capabilities.every((capability) =>
      KERNEL_CAPABILITY_VALUES.has(capability),
    ),
    "invalid_argument",
    "Agent authority contains an unknown kernel capability.",
  );
  return Object.freeze({
    capabilities: uniqueValues(input.capabilities, "Agent capabilities"),
    toolVersionIds: uniqueValues(input.toolVersionIds, "Agent tool versions"),
    workspaceGrantIds: uniqueValues(
      input.workspaceGrantIds,
      "Agent workspace grants",
    ),
    environmentIds: uniqueValues(input.environmentIds, "Agent environments"),
  });
}

function assertAuthorityNarrows(
  child: AgentAuthorityCeiling,
  parent: AgentAuthorityCeiling,
): void {
  assertDomain(
    valuesAreSubset(child.capabilities, parent.capabilities) &&
      valuesAreSubset(child.toolVersionIds, parent.toolVersionIds) &&
      valuesAreSubset(child.workspaceGrantIds, parent.workspaceGrantIds) &&
      valuesAreSubset(child.environmentIds, parent.environmentIds),
    "permission_denied",
    "A child agent cannot widen its parent's authority ceiling.",
  );
}

function assertBudgetNarrows(
  child: AgentResourceBudget,
  parent: AgentResourceBudget,
): void {
  for (const key of AGENT_BUDGET_KEYS) {
    assertDomain(
      child[key] <= parent[key],
      "scope_violation",
      "A child agent cannot widen its parent's resource budget.",
      { key, child: child[key], parent: parent[key] },
    );
  }
}

function freezeOutputRoute(route: AgentOutputRoute): AgentOutputRoute {
  if (route.kind === "follow-active") {
    return Object.freeze({
      ...route,
      authorizationHash: assertSha256(
        route.authorizationHash,
        "follow-active authorization hash",
      ),
    });
  }
  if (route.kind === "fixed" || route.kind === "inbox-only") {
    return Object.freeze({ ...route });
  }
  assertDomain(
    false,
    "invalid_argument",
    "Unknown agent output routing policy.",
  );
}

function isAgentTerminal(state: AgentState): state is AgentTerminalState {
  return state === "completed" || state === "failed" || state === "cancelled";
}

export function createAgentGraph(input: CreateAgentGraphInput): AgentGraph {
  assertIntegerInRange(input.maximumAgents, "maximum agent count", 1, 10_000);
  assertIntegerInRange(input.maximumDepth, "maximum agent depth", 0, 128);
  return Object.freeze({ ...input, version: 1, agents: Object.freeze([]) });
}

export type AddAgentInput = Omit<
  AgentInstance,
  "depth" | "state" | "updatedAt" | "terminalAt" | "terminalReason"
>;

export function addAgentInstance(
  graph: AgentGraph,
  input: AddAgentInput,
): AgentGraph {
  assertDomain(
    graph.version === 1,
    "invalid_argument",
    "Unsupported agent graph version.",
  );
  assertDomain(
    graph.agents.length < graph.maximumAgents,
    "unsupported_capability",
    "Agent graph has reached its configured thread limit.",
  );
  assertDomain(
    !graph.agents.some((agent) => agent.id === input.id),
    "conflict",
    "Agent instance ID already exists.",
    { agentId: input.id },
  );
  assertIsoTimestamp(input.createdAt, "agent creation time");
  assertDomain(
    AGENT_ROLE_VALUES.has(input.role),
    "invalid_argument",
    "Unknown agent role.",
  );
  assertDomain(
    AGENT_CONTEXT_MODE_VALUES.has(input.contextMode),
    "invalid_argument",
    "Unknown agent context mode.",
  );
  if (input.executionMode !== undefined) {
    assertDomain(
      EXECUTION_MODE_VALUES.has(input.executionMode),
      "invalid_argument",
      "Unknown agent execution mode.",
    );
  }
  const authority = normalizeAuthority(input.authority);
  const budget = freezeAgentBudget(input.budget);
  let depth = 0;

  if (input.parentAgentId === undefined) {
    assertDomain(
      graph.agents.length === 0,
      "conflict",
      "An agent graph can contain only one root agent.",
    );
    assertDomain(
      input.spawnOrdinal === 0,
      "invalid_argument",
      "Root agent ordinal must be zero.",
    );
    assertDomain(
      input.runId === graph.rootRunId,
      "scope_violation",
      "Root agent must own the graph root run.",
    );
  } else {
    const parent = graph.agents.find(
      (agent) => agent.id === input.parentAgentId,
    );
    assertDomain(
      parent !== undefined,
      "not_found",
      "Parent agent was not found.",
      {
        parentAgentId: input.parentAgentId,
      },
    );
    assertDomain(
      parent.state === "running" || parent.state === "waiting",
      "invalid_state_transition",
      "Only a running or waiting parent may spawn a child agent.",
      { parentAgentId: parent.id, parentState: parent.state },
    );
    const currentChildren = graph.agents.filter(
      (agent) => agent.parentAgentId === parent.id,
    );
    assertDomain(
      currentChildren.length < parent.budget.maximumChildren,
      "unsupported_capability",
      "Parent agent has reached its child budget.",
      { parentAgentId: parent.id },
    );
    assertDomain(
      input.spawnOrdinal > 0 &&
        !currentChildren.some(
          (agent) => agent.spawnOrdinal === input.spawnOrdinal,
        ),
      "conflict",
      "Sibling agent spawn ordinals must be positive and unique.",
    );
    depth = parent.depth + 1;
    assertAuthorityNarrows(authority, parent.authority);
    assertBudgetNarrows(budget, parent.budget);
    assertDomain(
      input.runId === graph.rootRunId,
      "scope_violation",
      "Every agent instance in a graph must bind the graph root logical run.",
      { agentId: input.id, runId: input.runId, rootRunId: graph.rootRunId },
    );
  }

  assertDomain(
    depth <= graph.maximumDepth,
    "unsupported_capability",
    "Agent spawn would exceed the graph depth limit.",
    { depth, maximumDepth: graph.maximumDepth },
  );
  if (input.executionEnvironmentId !== undefined) {
    assertDomain(
      authority.environmentIds.includes(input.executionEnvironmentId),
      "scope_violation",
      "Agent execution environment is outside its authority ceiling.",
      { agentId: input.id, environmentId: input.executionEnvironmentId },
    );
  }
  assertDomain(
    (input.executionEnvironmentId === undefined) ===
      (input.executionMode === undefined),
    "invalid_argument",
    "Agent execution environment ID and mode must be captured together.",
  );
  const outputRoute = freezeOutputRoute(input.outputRoute);
  if (outputRoute.kind === "fixed") {
    assertDomain(
      outputRoute.branchId === graph.branchId,
      "scope_violation",
      "Fixed child output must return to the graph's captured branch.",
      { branchId: outputRoute.branchId, graphBranchId: graph.branchId },
    );
  }

  const agent: AgentInstance = Object.freeze({
    ...input,
    spawnOrdinal: assertIntegerInRange(
      input.spawnOrdinal,
      "agent spawn ordinal",
      0,
      1_000_000,
    ),
    depth,
    label: assertNonBlank(input.label, "agent label", 160),
    objective: assertNonBlank(input.objective, "agent objective", 8_000),
    completionContractHash: assertSha256(
      input.completionContractHash,
      "agent completion-contract hash",
    ),
    templateVersionHash: assertSha256(
      input.templateVersionHash,
      "agent template hash",
    ),
    providerPolicyHash: assertSha256(
      input.providerPolicyHash,
      "agent provider-policy hash",
    ),
    authority,
    budget,
    outputRoute,
    state: "created",
    updatedAt: input.createdAt,
  });
  return Object.freeze({
    ...graph,
    agents: Object.freeze([...graph.agents, agent]),
  });
}

export interface TransitionAgentInput {
  readonly agentId: AgentInstanceId;
  readonly to: AgentState;
  readonly now: IsoTimestamp;
  readonly terminalReason?: string;
}

export function transitionAgent(
  graph: AgentGraph,
  input: TransitionAgentInput,
): AgentGraph {
  assertIsoTimestamp(input.now, "agent transition time");
  const index = graph.agents.findIndex((agent) => agent.id === input.agentId);
  assertDomain(index >= 0, "not_found", "Agent instance was not found.", {
    agentId: input.agentId,
  });
  const agent = graph.agents[index];
  assertDomain(
    agent !== undefined,
    "not_found",
    "Agent instance was not found.",
  );
  assertDomain(
    (AGENT_TRANSITIONS[agent.state] as readonly AgentState[]).includes(
      input.to,
    ),
    "invalid_state_transition",
    `Agent cannot transition from ${agent.state} to ${input.to}.`,
    { agentId: agent.id, from: agent.state, to: input.to },
  );
  assertDomain(
    Date.parse(input.now) >= Date.parse(agent.updatedAt),
    "invalid_argument",
    "Agent transition time cannot move backwards.",
  );
  const terminal = isAgentTerminal(input.to);
  assertDomain(
    terminal === (input.terminalReason !== undefined),
    "invalid_argument",
    "Exactly terminal agent transitions require a terminal reason.",
  );
  if (terminal) {
    const activeChildren = graph.agents.filter(
      (candidate) =>
        candidate.parentAgentId === agent.id &&
        !isAgentTerminal(candidate.state),
    );
    assertDomain(
      activeChildren.length === 0,
      "invalid_state_transition",
      "An agent cannot become terminal while a child process is still active.",
      {
        agentId: agent.id,
        activeChildIds: activeChildren.map((child) => child.id),
      },
    );
  }

  const next: AgentInstance = Object.freeze({
    ...agent,
    state: input.to,
    updatedAt: input.now,
    ...(terminal
      ? {
          terminalAt: input.now,
          terminalReason: assertNonBlank(
            input.terminalReason ?? "",
            "agent terminal reason",
            1_000,
          ),
        }
      : {}),
  });
  return Object.freeze({
    ...graph,
    agents: Object.freeze(
      graph.agents.map((candidate, candidateIndex) =>
        candidateIndex === index ? next : candidate,
      ),
    ),
  });
}

export function assertAgentGraphIntegrity(graph: AgentGraph): void {
  assertDomain(
    graph.version === 1,
    "invalid_argument",
    "Unsupported agent graph version.",
  );
  assertDomain(
    graph.agents.length <= graph.maximumAgents,
    "invalid_state_transition",
    "Agent graph exceeds its configured limit.",
  );
  const rootAgents = graph.agents.filter(
    (agent) => agent.parentAgentId === undefined,
  );
  assertDomain(
    rootAgents.length <= 1,
    "conflict",
    "Agent graph contains multiple root agents.",
  );
  const seen = new Set<AgentInstanceId>();
  const byId = new Map(graph.agents.map((agent) => [agent.id, agent]));
  for (const agent of graph.agents) {
    assertDomain(
      !seen.has(agent.id),
      "conflict",
      "Agent graph contains a duplicate ID.",
    );
    seen.add(agent.id);
    assertNonBlank(agent.label, "agent label", 160);
    assertNonBlank(agent.objective, "agent objective", 8_000);
    assertDomain(
      AGENT_ROLE_VALUES.has(agent.role),
      "invalid_state_transition",
      "Agent has an unknown role.",
    );
    assertDomain(
      AGENT_CONTEXT_MODE_VALUES.has(agent.contextMode),
      "invalid_state_transition",
      "Agent has an unknown context mode.",
    );
    assertDomain(
      AGENT_STATE_VALUES.has(agent.state),
      "invalid_state_transition",
      "Agent has an unknown lifecycle state.",
    );
    assertSha256(
      agent.completionContractHash,
      "agent completion-contract hash",
    );
    assertSha256(agent.templateVersionHash, "agent template hash");
    assertSha256(agent.providerPolicyHash, "agent provider-policy hash");
    normalizeAuthority(agent.authority);
    freezeAgentBudget(agent.budget);
    const outputRoute = freezeOutputRoute(agent.outputRoute);
    if (outputRoute.kind === "fixed") {
      assertDomain(
        outputRoute.branchId === graph.branchId,
        "scope_violation",
        "Fixed agent output route does not match the graph branch.",
      );
    }
    assertDomain(
      agent.runId === graph.rootRunId,
      "scope_violation",
      "Agent instance belongs to a different logical run.",
    );
    assertDomain(
      (agent.executionEnvironmentId === undefined) ===
        (agent.executionMode === undefined),
      "invalid_state_transition",
      "Agent environment ID and mode disagree.",
    );
    if (agent.executionEnvironmentId !== undefined) {
      assertDomain(
        agent.authority.environmentIds.includes(agent.executionEnvironmentId),
        "scope_violation",
        "Agent environment lies outside its authority ceiling.",
      );
    }
    assertIsoTimestamp(agent.createdAt, "agent creation time");
    assertIsoTimestamp(agent.updatedAt, "agent update time");
    assertDomain(
      Date.parse(agent.updatedAt) >= Date.parse(agent.createdAt),
      "invalid_state_transition",
      "Agent update time precedes creation.",
    );
    assertDomain(
      isAgentTerminal(agent.state) ===
        (agent.terminalAt !== undefined && agent.terminalReason !== undefined),
      "invalid_state_transition",
      "Agent terminal state and terminal metadata disagree.",
      { agentId: agent.id },
    );
    if (agent.terminalAt !== undefined) {
      assertIsoTimestamp(agent.terminalAt, "agent terminal time");
      assertDomain(
        agent.terminalAt === agent.updatedAt,
        "invalid_state_transition",
        "Agent terminal time must equal its final update time.",
      );
    }
  }
  for (const agent of graph.agents) {
    if (agent.parentAgentId === undefined) {
      assertDomain(
        agent.depth === 0 && agent.spawnOrdinal === 0,
        "invalid_state_transition",
        "Root agent depth or ordinal is invalid.",
      );
      continue;
    }
    const visited = new Set<AgentInstanceId>([agent.id]);
    let current: AgentInstance | undefined = agent;
    let expectedDepth = 0;
    while (current.parentAgentId !== undefined) {
      assertDomain(
        !visited.has(current.parentAgentId),
        "invalid_state_transition",
        "Agent graph contains a parent cycle.",
        { agentId: agent.id, repeatedAgentId: current.parentAgentId },
      );
      visited.add(current.parentAgentId);
      const parent = byId.get(current.parentAgentId);
      assertDomain(
        parent !== undefined,
        "invalid_state_transition",
        "Agent parent is missing.",
        {
          agentId: current.id,
          parentAgentId: current.parentAgentId,
        },
      );
      assertDomain(
        Date.parse(current.createdAt) >= Date.parse(parent.createdAt),
        "invalid_state_transition",
        "Child agent predates its parent.",
      );
      assertAuthorityNarrows(current.authority, parent.authority);
      assertBudgetNarrows(current.budget, parent.budget);
      expectedDepth += 1;
      current = parent;
    }
    assertDomain(
      agent.depth === expectedDepth && agent.depth <= graph.maximumDepth,
      "invalid_state_transition",
      "Agent depth does not match its parent lineage.",
      { agentId: agent.id, expectedDepth, actualDepth: agent.depth },
    );
    const siblingOrdinals = graph.agents
      .filter((candidate) => candidate.parentAgentId === agent.parentAgentId)
      .map((candidate) => candidate.spawnOrdinal);
    assertDomain(
      agent.spawnOrdinal > 0 &&
        new Set(siblingOrdinals).size === siblingOrdinals.length,
      "conflict",
      "Sibling agent spawn ordinals must be positive and unique.",
    );
    const parent = byId.get(agent.parentAgentId);
    assertDomain(
      parent !== undefined,
      "invalid_state_transition",
      "Agent parent is missing.",
    );
    assertDomain(
      !isAgentTerminal(parent.state) || isAgentTerminal(agent.state),
      "invalid_state_transition",
      "A terminal parent cannot retain a nonterminal child.",
      { parentAgentId: parent.id, childAgentId: agent.id },
    );
  }
}
