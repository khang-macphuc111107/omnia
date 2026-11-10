import { assertDomain } from "./errors";
import type { ConcreteExecutionMode } from "./execution";
import type {
  ArtifactId,
  BranchId,
  ContextSnapshotId,
  EntityId,
  ExecutionEnvironmentId,
  RunId,
  RunItemId,
  TaskId,
  WorkspaceGrantId,
} from "./ids";
import type { KernelCapability } from "./kernel-capability";
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

export type ToolVersionId = EntityId<"tool-version">;
export type ToolInvocationId = EntityId<"tool-invocation">;
export type ToolAuthorizationDecisionId =
  EntityId<"tool-authorization-decision">;
export type AgentInstanceId = EntityId<"agent-instance">;
export type AgentMailboxMessageId = EntityId<"agent-mailbox-message">;
export type AgentResultId = EntityId<"agent-result">;

export type ToolTrust =
  "built-in" | "signed-extension" | "local-unverified" | "remote";
export type ToolExposure = "eager" | "deferred" | "harness-only";
export type ToolEffect =
  | "pure-compute"
  | "app-data-read"
  | "workspace-read"
  | "workspace-write"
  | "process-execution"
  | "network"
  | "external-side-effect"
  | "browser-control"
  | "computer-control"
  | "privileged-operation"
  | "secret-use";

export interface ToolResourceLimits {
  readonly maximumInputBytes: number;
  readonly maximumOutputBytes: number;
  readonly defaultTimeoutMs: number;
}

/**
 * Immutable identity and authority declaration for one exact tool version.
 * Tool descriptions, aliases, skills, models, and agents never add authority;
 * the required capability list is only a request to the kernel broker.
 */
export interface ToolVersionManifest {
  readonly schemaVersion: 1;
  readonly id: ToolVersionId;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly version: string;
  readonly origin: ToolTrust;
  readonly exposure: ToolExposure;
  readonly manifestHash: string;
  readonly implementationHash: string;
  readonly inputSchemaHash: string;
  readonly outputSchemaHash: string;
  readonly capabilitySetHash: string;
  readonly requiredCapabilities: readonly KernelCapability[];
  readonly effects: readonly ToolEffect[];
  readonly supportedEnvironments: readonly (
    "persistent" | "isolated" | "remote"
  )[];
  readonly limits: ToolResourceLimits;
  readonly cancellation: "cooperative" | "forceable" | "unsupported";
  readonly idempotency: "none" | "same-invocation-key";
  readonly registeredAt: IsoTimestamp;
  readonly disabledAt?: IsoTimestamp;
}

export interface ToolRegistry {
  readonly version: 1;
  readonly tools: readonly ToolVersionManifest[];
}

const TOOL_EFFECT_CAPABILITY = {
  "pure-compute": "pure_compute",
  "app-data-read": "read_app_data",
  "workspace-read": "read_workspace",
  "workspace-write": "write_workspace",
  "process-execution": "execute_process",
  network: "use_network",
  "external-side-effect": "external_side_effect",
  "browser-control": "control_browser",
  "computer-control": "control_computer",
  "privileged-operation": "request_admin",
  "secret-use": "access_secret_handle",
} as const satisfies Readonly<Record<ToolEffect, KernelCapability>>;

const RESERVED_TOOL_NAMESPACES = new Set(["kernel", "omnia", "system"]);
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const TOOL_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const TOOL_TRUST_VALUES: ReadonlySet<ToolTrust> = new Set([
  "built-in",
  "signed-extension",
  "local-unverified",
  "remote",
]);
const TOOL_EXPOSURE_VALUES: ReadonlySet<ToolExposure> = new Set([
  "eager",
  "deferred",
  "harness-only",
]);
const TOOL_EFFECT_VALUES: ReadonlySet<ToolEffect> = new Set(
  Object.keys(TOOL_EFFECT_CAPABILITY) as ToolEffect[],
);
const KERNEL_CAPABILITY_VALUES: ReadonlySet<KernelCapability> = new Set(
  Object.values(TOOL_EFFECT_CAPABILITY),
);
const EXECUTION_MODE_VALUES: ReadonlySet<ConcreteExecutionMode> = new Set([
  "persistent",
  "isolated",
  "remote",
]);
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

function uniqueValues<T>(values: readonly T[], label: string): readonly T[] {
  assertDomain(
    new Set(values).size === values.length,
    "invalid_argument",
    `${label} must be unique.`,
  );
  return Object.freeze([...values]);
}

function assertPositiveSafeInteger(value: number, label: string): number {
  assertDomain(
    Number.isSafeInteger(value) && value > 0,
    "invalid_argument",
    `${label} must be a positive safe integer.`,
    { label, value },
  );
  return value;
}

function assertNonNegativeSafeInteger(value: number, label: string): number {
  assertDomain(
    Number.isSafeInteger(value) && value >= 0,
    "invalid_argument",
    `${label} must be a non-negative safe integer.`,
    { label, value },
  );
  return value;
}

function normalizeToolName(value: string): string {
  const canonicalName = assertNonBlank(
    value,
    "tool canonical name",
    160,
  ).toLowerCase();
  assertDomain(
    TOOL_NAME_PATTERN.test(canonicalName),
    "invalid_argument",
    "Tool names must be lowercase and namespace-qualified.",
    { canonicalName },
  );
  return canonicalName;
}

function validateToolManifest(input: ToolVersionManifest): ToolVersionManifest {
  assertDomain(
    input.schemaVersion === 1,
    "invalid_argument",
    "Unsupported tool manifest version.",
  );
  assertDomain(
    TOOL_TRUST_VALUES.has(input.origin),
    "invalid_argument",
    "Unknown tool trust class.",
  );
  assertDomain(
    TOOL_EXPOSURE_VALUES.has(input.exposure),
    "invalid_argument",
    "Unknown tool exposure policy.",
  );
  assertDomain(
    input.cancellation === "cooperative" ||
      input.cancellation === "forceable" ||
      input.cancellation === "unsupported",
    "invalid_argument",
    "Unknown tool cancellation contract.",
  );
  assertDomain(
    input.idempotency === "none" || input.idempotency === "same-invocation-key",
    "invalid_argument",
    "Unknown tool idempotency contract.",
  );
  const canonicalName = normalizeToolName(input.canonicalName);
  const namespace = canonicalName.split(".")[0] ?? "";
  assertDomain(
    input.origin === "built-in" || !RESERVED_TOOL_NAMESPACES.has(namespace),
    "permission_denied",
    "Extensions cannot register tools inside a reserved namespace.",
    { namespace },
  );
  const version = assertNonBlank(input.version, "tool version", 64);
  assertDomain(
    TOOL_VERSION_PATTERN.test(version),
    "invalid_argument",
    "Tool version is malformed.",
  );
  assertIsoTimestamp(input.registeredAt, "tool registration time");
  if (input.disabledAt !== undefined) {
    assertIsoTimestamp(input.disabledAt, "tool disable time");
    assertDomain(
      Date.parse(input.disabledAt) >= Date.parse(input.registeredAt),
      "invalid_argument",
      "Tool disable time cannot precede registration.",
    );
  }

  const requiredCapabilities = uniqueValues(
    input.requiredCapabilities,
    "Tool capabilities",
  );
  assertDomain(
    requiredCapabilities.every((capability) =>
      KERNEL_CAPABILITY_VALUES.has(capability),
    ),
    "invalid_argument",
    "Tool manifest contains an unknown kernel capability.",
  );
  const capabilitySet = new Set(requiredCapabilities);
  const effects = uniqueValues(input.effects, "Tool effects");
  assertDomain(
    effects.length > 0,
    "invalid_argument",
    "A tool must declare at least one effect.",
  );
  assertDomain(
    effects.every((effect) => TOOL_EFFECT_VALUES.has(effect)),
    "invalid_argument",
    "Tool manifest contains an unknown effect.",
  );
  for (const effect of effects) {
    const requiredCapability = TOOL_EFFECT_CAPABILITY[effect];
    assertDomain(
      capabilitySet.has(requiredCapability),
      "scope_violation",
      "Every declared tool effect must have its matching kernel capability.",
      { effect, requiredCapability },
    );
  }
  const expectedCapabilities = new Set(
    effects.map((effect) => TOOL_EFFECT_CAPABILITY[effect]),
  );
  assertDomain(
    expectedCapabilities.size === capabilitySet.size &&
      requiredCapabilities.every((capability) =>
        expectedCapabilities.has(capability),
      ),
    "scope_violation",
    "Tool effects and requested kernel capabilities must describe the same authority set.",
  );

  const supportedEnvironments = uniqueValues(
    input.supportedEnvironments,
    "Supported tool environments",
  );
  assertDomain(
    supportedEnvironments.length > 0,
    "invalid_argument",
    "A callable tool must support at least one execution environment.",
  );
  assertDomain(
    supportedEnvironments.every((mode) => EXECUTION_MODE_VALUES.has(mode)),
    "invalid_argument",
    "Tool manifest contains an unknown execution mode.",
  );
  assertPositiveSafeInteger(
    input.limits.maximumInputBytes,
    "Tool input byte limit",
  );
  assertPositiveSafeInteger(
    input.limits.maximumOutputBytes,
    "Tool output byte limit",
  );
  assertPositiveSafeInteger(input.limits.defaultTimeoutMs, "Tool timeout");
  const manifestHash = assertSha256(input.manifestHash, "tool manifest hash");
  const implementationHash = assertSha256(
    input.implementationHash,
    "tool implementation hash",
  );
  const inputSchemaHash = assertSha256(
    input.inputSchemaHash,
    "tool input schema hash",
  );
  const outputSchemaHash = assertSha256(
    input.outputSchemaHash,
    "tool output schema hash",
  );
  const capabilitySetHash = assertSha256(
    input.capabilitySetHash,
    "tool capability-set hash",
  );
  return Object.freeze({
    ...input,
    canonicalName,
    displayName: assertNonBlank(input.displayName, "tool display name", 160),
    version,
    manifestHash,
    implementationHash,
    inputSchemaHash,
    outputSchemaHash,
    capabilitySetHash,
    requiredCapabilities,
    effects,
    supportedEnvironments,
    limits: Object.freeze({ ...input.limits }),
  });
}

export function createToolRegistry(): ToolRegistry {
  return Object.freeze({ version: 1, tools: Object.freeze([]) });
}

export function registerToolVersion(
  registry: ToolRegistry,
  input: ToolVersionManifest,
): ToolRegistry {
  assertDomain(
    registry.version === 1,
    "invalid_argument",
    "Unsupported tool registry version.",
  );
  const manifest = validateToolManifest(input);
  assertDomain(
    !registry.tools.some((tool) => tool.id === manifest.id),
    "conflict",
    "Tool version ID is already registered.",
    { toolVersionId: manifest.id },
  );
  assertDomain(
    !registry.tools.some(
      (tool) =>
        tool.canonicalName === manifest.canonicalName &&
        tool.version === manifest.version,
    ),
    "conflict",
    "The exact tool name and version are already registered.",
    { canonicalName: manifest.canonicalName, version: manifest.version },
  );
  return Object.freeze({
    ...registry,
    tools: Object.freeze([...registry.tools, manifest]),
  });
}

export function resolveToolVersion(
  registry: ToolRegistry,
  toolVersionId: ToolVersionId,
  caller: "model" | "harness",
  now: IsoTimestamp,
): ToolVersionManifest {
  assertIsoTimestamp(now, "tool resolution time");
  const tool = registry.tools.find(
    (candidate) => candidate.id === toolVersionId,
  );
  assertDomain(tool !== undefined, "not_found", "Tool version was not found.", {
    toolVersionId,
  });
  assertDomain(
    tool.disabledAt === undefined ||
      Date.parse(tool.disabledAt) > Date.parse(now),
    "unsupported_capability",
    "Tool version is disabled.",
    { toolVersionId },
  );
  assertDomain(
    caller === "harness" || tool.exposure !== "harness-only",
    "permission_denied",
    "This tool is not exposed to model-authored calls.",
    { toolVersionId },
  );
  return tool;
}

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

function valuesAreSubset<T>(
  child: readonly T[],
  parent: readonly T[],
): boolean {
  const parentSet = new Set(parent);
  return child.every((value) => parentSet.has(value));
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
      "An agent cannot complete while a child process is still active.",
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

export type AgentTaskState =
  | "planned"
  | "ready"
  | "assigned"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentTaskResourceClaim {
  readonly handle: string;
  readonly access: "read" | "write";
}

export interface AgentTask {
  readonly id: TaskId;
  readonly objective: string;
  readonly dependencyIds: readonly TaskId[];
  readonly requiredCapabilities: readonly KernelCapability[];
  readonly requiredToolVersionIds: readonly ToolVersionId[];
  readonly resourceClaims: readonly AgentTaskResourceClaim[];
  readonly assignedAgentId?: AgentInstanceId;
  readonly state: AgentTaskState;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly resultId?: AgentResultId;
  readonly terminalReason?: string;
}

export interface AgentTaskDag {
  readonly version: 1;
  readonly rootRunId: RunId;
  readonly tasks: readonly AgentTask[];
}

export function createAgentTaskDag(rootRunId: RunId): AgentTaskDag {
  return Object.freeze({ version: 1, rootRunId, tasks: Object.freeze([]) });
}

export type AddAgentTaskInput = Omit<
  AgentTask,
  "state" | "updatedAt" | "assignedAgentId" | "resultId" | "terminalReason"
>;

function freezeResourceClaims(
  claims: readonly AgentTaskResourceClaim[],
): readonly AgentTaskResourceClaim[] {
  const normalized = claims.map((claim) => {
    assertDomain(
      claim.access === "read" || claim.access === "write",
      "invalid_argument",
      "Task resource access must be read or write.",
    );
    return Object.freeze({
      handle: assertOpaqueResourceHandle(claim.handle, "task resource handle"),
      access: claim.access,
    });
  });
  const keys = normalized.map(
    (claim) => `${claim.handle}\u0000${claim.access}`,
  );
  assertDomain(
    new Set(keys).size === keys.length,
    "invalid_argument",
    "Task resource claims must be unique.",
  );
  return Object.freeze(normalized);
}

export function addAgentTask(
  dag: AgentTaskDag,
  input: AddAgentTaskInput,
): AgentTaskDag {
  assertDomain(
    dag.version === 1,
    "invalid_argument",
    "Unsupported agent task DAG version.",
  );
  assertDomain(
    !dag.tasks.some((task) => task.id === input.id),
    "conflict",
    "Agent task ID already exists.",
    { taskId: input.id },
  );
  assertIsoTimestamp(input.createdAt, "agent task creation time");
  const dependencyIds = uniqueValues(input.dependencyIds, "Task dependencies");
  assertDomain(
    !dependencyIds.includes(input.id),
    "scope_violation",
    "A task cannot depend on itself.",
  );
  for (const dependencyId of dependencyIds) {
    const dependency = dag.tasks.find((task) => task.id === dependencyId);
    assertDomain(
      dependency !== undefined,
      "not_found",
      "Task dependencies must already exist in the durable DAG.",
      { dependencyId },
    );
    assertDomain(
      Date.parse(input.createdAt) >= Date.parse(dependency.createdAt),
      "invalid_argument",
      "A task cannot predate one of its dependencies.",
      { taskId: input.id, dependencyId },
    );
  }
  const requiredCapabilities = uniqueValues(
    input.requiredCapabilities,
    "Task required capabilities",
  );
  assertDomain(
    requiredCapabilities.every((capability) =>
      KERNEL_CAPABILITY_VALUES.has(capability),
    ),
    "invalid_argument",
    "Task contains an unknown kernel capability.",
  );
  const task: AgentTask = Object.freeze({
    id: input.id,
    objective: assertNonBlank(input.objective, "task objective", 8_000),
    dependencyIds,
    requiredCapabilities,
    requiredToolVersionIds: uniqueValues(
      input.requiredToolVersionIds,
      "Task required tool versions",
    ),
    resourceClaims: freezeResourceClaims(input.resourceClaims),
    state: "planned",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
  return Object.freeze({ ...dag, tasks: Object.freeze([...dag.tasks, task]) });
}

export function markAgentTaskReady(
  dag: AgentTaskDag,
  taskId: TaskId,
  now: IsoTimestamp,
): AgentTaskDag {
  assertIsoTimestamp(now, "task readiness time");
  const index = dag.tasks.findIndex((task) => task.id === taskId);
  assertDomain(index >= 0, "not_found", "Agent task was not found.", {
    taskId,
  });
  const task = dag.tasks[index];
  assertDomain(task !== undefined, "not_found", "Agent task was not found.");
  assertDomain(
    task.state === "planned" || task.state === "blocked",
    "invalid_state_transition",
    "Only planned or blocked tasks can become ready.",
  );
  assertDomain(
    Date.parse(now) >= Date.parse(task.updatedAt),
    "invalid_argument",
    "Task readiness time cannot move backwards.",
  );
  const incompleteDependencies = task.dependencyIds.filter(
    (dependencyId) =>
      dag.tasks.find((candidate) => candidate.id === dependencyId)?.state !==
      "completed",
  );
  assertDomain(
    incompleteDependencies.length === 0,
    "invalid_state_transition",
    "Task dependencies are not complete.",
    { taskId, incompleteDependencies },
  );
  // A blocked task may have been assigned to an agent that is no longer
  // eligible. Returning it to the ready queue must release that stale
  // assignment so the scheduler can make a fresh authority decision. Omit
  // the optional property instead of storing `undefined`; exact optional
  // property semantics intentionally distinguish both states.
  const { assignedAgentId, ...unassignedTask } = task;
  void assignedAgentId;
  const next: AgentTask = Object.freeze({
    ...unassignedTask,
    state: "ready",
    updatedAt: now,
  });
  return Object.freeze({
    ...dag,
    tasks: Object.freeze(
      dag.tasks.map((candidate, i) => (i === index ? next : candidate)),
    ),
  });
}

export function assignAgentTask(
  dag: AgentTaskDag,
  graph: AgentGraph,
  taskId: TaskId,
  agentId: AgentInstanceId,
  now: IsoTimestamp,
): AgentTaskDag {
  assertIsoTimestamp(now, "task assignment time");
  assertDomain(
    dag.rootRunId === graph.rootRunId,
    "scope_violation",
    "Task DAG and agent graph belong to different logical runs.",
  );
  const index = dag.tasks.findIndex((task) => task.id === taskId);
  const task = dag.tasks[index];
  assertDomain(task !== undefined, "not_found", "Agent task was not found.", {
    taskId,
  });
  assertDomain(
    task.state === "ready",
    "invalid_state_transition",
    "Only a ready task can be assigned.",
  );
  assertDomain(
    Date.parse(now) >= Date.parse(task.updatedAt),
    "invalid_argument",
    "Task assignment time cannot move backwards.",
  );
  const agent = graph.agents.find((candidate) => candidate.id === agentId);
  assertDomain(
    agent !== undefined,
    "not_found",
    "Assigned agent was not found.",
    { agentId },
  );
  assertDomain(
    agent.state === "queued" ||
      agent.state === "running" ||
      agent.state === "waiting",
    "invalid_state_transition",
    "Task assignment requires a schedulable agent.",
    { agentId, state: agent.state },
  );
  assertDomain(
    valuesAreSubset(task.requiredCapabilities, agent.authority.capabilities) &&
      valuesAreSubset(
        task.requiredToolVersionIds,
        agent.authority.toolVersionIds,
      ),
    "permission_denied",
    "Task requirements exceed the assigned agent's authority ceiling.",
    { taskId, agentId },
  );
  const next: AgentTask = Object.freeze({
    ...task,
    assignedAgentId: agentId,
    state: "assigned",
    updatedAt: now,
  });
  return Object.freeze({
    ...dag,
    tasks: Object.freeze(
      dag.tasks.map((candidate, i) => (i === index ? next : candidate)),
    ),
  });
}

export interface TransitionAgentTaskInput {
  readonly taskId: TaskId;
  readonly to: Extract<
    AgentTaskState,
    "blocked" | "completed" | "failed" | "cancelled"
  >;
  readonly now: IsoTimestamp;
  readonly resultId?: AgentResultId;
  readonly terminalReason?: string;
}

export function transitionAgentTask(
  dag: AgentTaskDag,
  input: TransitionAgentTaskInput,
): AgentTaskDag {
  assertIsoTimestamp(input.now, "task transition time");
  const index = dag.tasks.findIndex((task) => task.id === input.taskId);
  const task = dag.tasks[index];
  assertDomain(task !== undefined, "not_found", "Agent task was not found.", {
    taskId: input.taskId,
  });
  const allowed: Readonly<Record<AgentTaskState, readonly AgentTaskState[]>> = {
    planned: ["cancelled"],
    ready: ["cancelled"],
    assigned: ["cancelled"],
    running: ["blocked", "completed", "failed", "cancelled"],
    blocked: ["failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  };
  assertDomain(
    allowed[task.state].includes(input.to),
    "invalid_state_transition",
    `Task cannot transition from ${task.state} to ${input.to}.`,
  );
  assertDomain(
    Date.parse(input.now) >= Date.parse(task.updatedAt),
    "invalid_argument",
    "Task transition time cannot move backwards.",
  );
  const terminal =
    input.to === "completed" ||
    input.to === "failed" ||
    input.to === "cancelled";
  assertDomain(
    (input.to === "completed") === (input.resultId !== undefined),
    "invalid_argument",
    "Exactly completed tasks require a structured result ID.",
  );
  assertDomain(
    terminal === (input.terminalReason !== undefined),
    "invalid_argument",
    "Exactly terminal tasks require a terminal reason.",
  );
  const next: AgentTask = Object.freeze({
    ...task,
    state: input.to,
    updatedAt: input.now,
    ...(input.resultId === undefined ? {} : { resultId: input.resultId }),
    ...(input.terminalReason === undefined
      ? {}
      : {
          terminalReason: assertNonBlank(
            input.terminalReason,
            "task terminal reason",
            1_000,
          ),
        }),
  });
  return Object.freeze({
    ...dag,
    tasks: Object.freeze(
      dag.tasks.map((candidate, i) => (i === index ? next : candidate)),
    ),
  });
}

export function startAgentTask(
  dag: AgentTaskDag,
  graph: AgentGraph,
  taskId: TaskId,
  now: IsoTimestamp,
): AgentTaskDag {
  assertIsoTimestamp(now, "task start time");
  assertDomain(
    dag.rootRunId === graph.rootRunId,
    "scope_violation",
    "Task DAG and agent graph belong to different logical runs.",
  );
  const index = dag.tasks.findIndex((task) => task.id === taskId);
  const task = dag.tasks[index];
  assertDomain(task !== undefined, "not_found", "Agent task was not found.", {
    taskId,
  });
  assertDomain(
    task.state === "assigned" || task.state === "blocked",
    "invalid_state_transition",
    "Only an assigned or blocked task may start or resume.",
  );
  assertDomain(
    Date.parse(now) >= Date.parse(task.updatedAt),
    "invalid_argument",
    "Task start time cannot move backwards.",
  );
  assertDomain(
    task.dependencyIds.every(
      (dependencyId) =>
        dag.tasks.find((candidate) => candidate.id === dependencyId)?.state ===
        "completed",
    ),
    "invalid_state_transition",
    "Task dependencies are no longer complete.",
  );
  const agent = graph.agents.find(
    (candidate) => candidate.id === task.assignedAgentId,
  );
  assertDomain(
    agent !== undefined,
    "not_found",
    "Assigned task agent was not found.",
  );
  assertDomain(
    agent.state === "running" &&
      valuesAreSubset(
        task.requiredCapabilities,
        agent.authority.capabilities,
      ) &&
      valuesAreSubset(
        task.requiredToolVersionIds,
        agent.authority.toolVersionIds,
      ),
    "permission_denied",
    "Task no longer fits a running assigned agent's authority ceiling.",
    { taskId, assignedAgentId: task.assignedAgentId },
  );
  const next: AgentTask = Object.freeze({
    ...task,
    state: "running",
    updatedAt: now,
  });
  return Object.freeze({
    ...dag,
    tasks: Object.freeze(
      dag.tasks.map((candidate, i) => (i === index ? next : candidate)),
    ),
  });
}

/** Read-heavy tasks can run together; any overlapping write claim is serialized or isolated. */
export function agentTasksCanRunInParallel(
  left: AgentTask,
  right: AgentTask,
): boolean {
  const rightClaims = new Map<string, Set<AgentTaskResourceClaim["access"]>>();
  for (const claim of right.resourceClaims) {
    const accesses = rightClaims.get(claim.handle) ?? new Set();
    accesses.add(claim.access);
    rightClaims.set(claim.handle, accesses);
  }
  return left.resourceClaims.every((claim) => {
    const otherAccesses = rightClaims.get(claim.handle);
    return (
      otherAccesses === undefined ||
      (claim.access === "read" &&
        otherAccesses.size === 1 &&
        otherAccesses.has("read"))
    );
  });
}

export type ToolInvocationState =
  | "proposed"
  | "awaiting-approval"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "denied"
  | "outcome-unknown";

export type ToolInvocationProducer = "model" | "harness";

export interface ToolAuthorizationBinding {
  readonly id: ToolAuthorizationDecisionId;
  readonly decision: "allow" | "deny" | "require-approval";
  readonly invocationId: ToolInvocationId;
  readonly toolVersionId: ToolVersionId;
  readonly toolVersionHash: string;
  readonly operationArgumentsHash: string;
  readonly capabilitySetHash: string;
  readonly policyVersionHash: string;
  readonly environmentId: ExecutionEnvironmentId;
  readonly approvalReceiptIds: readonly string[];
  readonly evaluatedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface ToolInvocation {
  readonly id: ToolInvocationId;
  readonly agentId: AgentInstanceId;
  readonly taskId?: TaskId;
  readonly runId: RunId;
  readonly branchId: BranchId;
  readonly environmentId: ExecutionEnvironmentId;
  readonly toolVersionId: ToolVersionId;
  readonly toolVersionHash: string;
  readonly operationType: string;
  readonly operationArgumentsHash: string;
  readonly capabilitySetHash: string;
  readonly requiredCapabilities: readonly KernelCapability[];
  readonly producer: ToolInvocationProducer;
  readonly state: ToolInvocationState;
  readonly authorization?: ToolAuthorizationBinding;
  readonly idempotencyKeyHash?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly terminalAt?: IsoTimestamp;
  readonly outputHash?: string;
  readonly terminalReason?: string;
}

export interface CreateToolInvocationInput {
  readonly id: ToolInvocationId;
  readonly agentId: AgentInstanceId;
  readonly taskId?: TaskId;
  readonly runId: RunId;
  readonly branchId: BranchId;
  readonly environmentId: ExecutionEnvironmentId;
  readonly toolVersionId: ToolVersionId;
  readonly operationType: string;
  readonly operationArgumentsHash: string;
  readonly capabilitySetHash: string;
  readonly idempotencyKeyHash?: string;
  readonly createdAt: IsoTimestamp;
}

export function createToolInvocation(
  graph: AgentGraph,
  registry: ToolRegistry,
  input: CreateToolInvocationInput,
  caller: "model" | "harness" = "model",
  taskDag?: AgentTaskDag,
): ToolInvocation {
  assertIsoTimestamp(input.createdAt, "tool invocation creation time");
  const agent = graph.agents.find(
    (candidate) => candidate.id === input.agentId,
  );
  assertDomain(
    agent !== undefined,
    "not_found",
    "Tool invocation agent was not found.",
  );
  assertDomain(
    agent.state === "running",
    "invalid_state_transition",
    "Only a running agent can propose a tool invocation.",
    { agentId: agent.id, state: agent.state },
  );
  assertDomain(
    input.branchId === graph.branchId && input.runId === agent.runId,
    "scope_violation",
    "Tool invocation scope does not match its agent and captured branch.",
  );
  if (input.taskId !== undefined) {
    assertDomain(
      taskDag !== undefined && taskDag.rootRunId === graph.rootRunId,
      "scope_violation",
      "Task-bound tool invocation requires the exact run-scoped task DAG.",
    );
    const task = taskDag.tasks.find(
      (candidate) => candidate.id === input.taskId,
    );
    assertDomain(
      task !== undefined,
      "not_found",
      "Tool invocation task was not found.",
    );
    assertDomain(
      task.assignedAgentId === agent.id && task.state === "running",
      "invalid_state_transition",
      "Tool invocation task is not actively assigned to this agent.",
      { taskId: task.id, agentId: agent.id, state: task.state },
    );
    assertDomain(
      task.requiredToolVersionIds.includes(input.toolVersionId),
      "permission_denied",
      "Task did not declare this tool version as an execution dependency.",
      { taskId: task.id, toolVersionId: input.toolVersionId },
    );
  }
  assertDomain(
    input.environmentId === agent.executionEnvironmentId &&
      agent.authority.environmentIds.includes(input.environmentId),
    "scope_violation",
    "Tool invocation environment is outside the agent authority ceiling.",
  );
  assertDomain(
    agent.authority.toolVersionIds.includes(input.toolVersionId),
    "permission_denied",
    "Agent is not permitted to invoke this tool version.",
    { agentId: agent.id, toolVersionId: input.toolVersionId },
  );
  const tool = resolveToolVersion(
    registry,
    input.toolVersionId,
    caller,
    input.createdAt,
  );
  assertDomain(
    valuesAreSubset(tool.requiredCapabilities, agent.authority.capabilities),
    "permission_denied",
    "Tool capabilities exceed the agent authority ceiling.",
  );
  assertDomain(
    agent.executionMode !== undefined &&
      tool.supportedEnvironments.includes(agent.executionMode),
    "unsupported_capability",
    "Tool version does not support the agent's captured execution mode.",
    { toolVersionId: tool.id, executionMode: agent.executionMode },
  );
  assertDomain(
    tool.capabilitySetHash ===
      assertSha256(input.capabilitySetHash, "tool capability-set hash"),
    "invalid_state_transition",
    "Tool capability-set hash does not match the registered immutable tool version.",
  );
  if (tool.idempotency === "same-invocation-key") {
    assertDomain(
      input.idempotencyKeyHash !== undefined,
      "invalid_argument",
      "This tool requires an idempotency key frozen before dispatch.",
    );
  } else {
    assertDomain(
      input.idempotencyKeyHash === undefined,
      "invalid_argument",
      "A non-idempotent tool cannot carry a misleading idempotency key.",
    );
  }

  return Object.freeze({
    ...input,
    toolVersionHash: tool.manifestHash,
    operationType: assertNonBlank(
      input.operationType,
      "tool operation type",
      160,
    ),
    operationArgumentsHash: assertSha256(
      input.operationArgumentsHash,
      "tool operation arguments hash",
    ),
    capabilitySetHash: tool.capabilitySetHash,
    requiredCapabilities: Object.freeze([...tool.requiredCapabilities]),
    producer: caller,
    ...(input.idempotencyKeyHash === undefined
      ? {}
      : {
          idempotencyKeyHash: assertSha256(
            input.idempotencyKeyHash,
            "tool idempotency key hash",
          ),
        }),
    state: "proposed",
    updatedAt: input.createdAt,
  });
}

function validateAuthorizationBinding(
  invocation: ToolInvocation,
  input: ToolAuthorizationBinding,
  now: IsoTimestamp,
): ToolAuthorizationBinding {
  assertIsoTimestamp(input.evaluatedAt, "tool authorization evaluation time");
  assertIsoTimestamp(input.expiresAt, "tool authorization expiry time");
  assertIsoTimestamp(now, "tool authorization application time");
  assertDomain(
    input.decision === "allow" ||
      input.decision === "deny" ||
      input.decision === "require-approval",
    "invalid_argument",
    "Unknown tool authorization decision.",
  );
  assertDomain(
    Date.parse(input.evaluatedAt) >= Date.parse(invocation.createdAt) &&
      Date.parse(input.evaluatedAt) <= Date.parse(now) &&
      Date.parse(input.expiresAt) > Date.parse(now),
    "invalid_state_transition",
    "Tool authorization is stale, expired, or predates the invocation.",
  );
  assertDomain(
    input.invocationId === invocation.id &&
      input.toolVersionId === invocation.toolVersionId &&
      input.toolVersionHash === invocation.toolVersionHash &&
      input.operationArgumentsHash === invocation.operationArgumentsHash &&
      input.capabilitySetHash === invocation.capabilitySetHash &&
      input.environmentId === invocation.environmentId,
    "scope_violation",
    "Tool authorization does not bind the exact invocation, arguments, version, capability set, and environment.",
  );
  return Object.freeze({
    ...input,
    toolVersionHash: assertSha256(
      input.toolVersionHash,
      "authorized tool version hash",
    ),
    operationArgumentsHash: assertSha256(
      input.operationArgumentsHash,
      "authorized operation arguments hash",
    ),
    capabilitySetHash: assertSha256(
      input.capabilitySetHash,
      "authorized capability-set hash",
    ),
    policyVersionHash: assertSha256(
      input.policyVersionHash,
      "authorization policy hash",
    ),
    approvalReceiptIds: Object.freeze(
      uniqueValues(input.approvalReceiptIds, "Approval receipt IDs").map(
        (receiptId) => assertNonBlank(receiptId, "approval receipt ID", 256),
      ),
    ),
  });
}

export function applyToolAuthorization(
  invocation: ToolInvocation,
  input: ToolAuthorizationBinding,
  now: IsoTimestamp,
): ToolInvocation {
  assertDomain(
    invocation.state === "proposed" || invocation.state === "awaiting-approval",
    "invalid_state_transition",
    "Tool authorization can only resolve a proposed or approval-waiting invocation.",
  );
  const authorization = validateAuthorizationBinding(invocation, input, now);
  if (authorization.decision === "allow") {
    assertDomain(
      invocation.state === "proposed" ||
        (invocation.state === "awaiting-approval" &&
          authorization.approvalReceiptIds.length > 0),
      "permission_denied",
      "An approval-waiting invocation requires at least one exact approval receipt.",
    );
  } else if (authorization.decision === "require-approval") {
    assertDomain(
      authorization.approvalReceiptIds.length === 0,
      "invalid_argument",
      "An unresolved approval request cannot already carry approval receipts.",
    );
  }
  const state: ToolInvocationState =
    authorization.decision === "allow"
      ? "ready"
      : authorization.decision === "deny"
        ? "denied"
        : "awaiting-approval";
  return Object.freeze({
    ...invocation,
    authorization,
    state,
    updatedAt: now,
    ...(state === "denied"
      ? { terminalAt: now, terminalReason: "Authorization was denied." }
      : {}),
  });
}

export interface AssertToolInvocationDispatchableInput {
  readonly agentGraph: AgentGraph;
  readonly registry: ToolRegistry;
  readonly now: IsoTimestamp;
}

/**
 * Revalidates all mutable state immediately before an executor starts. This is
 * the fail-closed boundary that detects tool disablement, parent cancellation,
 * authorization expiry, manifest replacement, or authority drift after the
 * invocation was proposed.
 */
export function assertToolInvocationDispatchable(
  invocation: ToolInvocation,
  input: AssertToolInvocationDispatchableInput,
): void {
  assertIsoTimestamp(input.now, "tool dispatch validation time");
  assertDomain(
    invocation.state === "ready",
    "invalid_state_transition",
    "Only an authorized ready invocation may start execution.",
  );
  const agent = input.agentGraph.agents.find(
    (candidate) => candidate.id === invocation.agentId,
  );
  assertDomain(
    agent !== undefined,
    "not_found",
    "Tool invocation agent was not found.",
  );
  assertDomain(
    agent.state === "running" &&
      agent.runId === invocation.runId &&
      input.agentGraph.branchId === invocation.branchId,
    "invalid_state_transition",
    "Tool invocation agent is no longer active in the captured run and branch.",
  );
  assertDomain(
    agent.executionEnvironmentId === invocation.environmentId &&
      agent.executionMode !== undefined &&
      agent.authority.environmentIds.includes(invocation.environmentId) &&
      agent.authority.toolVersionIds.includes(invocation.toolVersionId) &&
      valuesAreSubset(
        invocation.requiredCapabilities,
        agent.authority.capabilities,
      ),
    "permission_denied",
    "Tool invocation no longer fits the agent authority ceiling.",
  );
  const tool = resolveToolVersion(
    input.registry,
    invocation.toolVersionId,
    invocation.producer,
    input.now,
  );
  assertDomain(
    tool.manifestHash === invocation.toolVersionHash &&
      tool.capabilitySetHash === invocation.capabilitySetHash &&
      agent.executionMode !== undefined &&
      tool.supportedEnvironments.includes(agent.executionMode) &&
      tool.requiredCapabilities.length ===
        invocation.requiredCapabilities.length &&
      tool.requiredCapabilities.every(
        (capability, index) =>
          capability === invocation.requiredCapabilities[index],
      ),
    "invalid_state_transition",
    "Tool version or capability declaration changed after the invocation was frozen.",
  );
  const authorization = invocation.authorization;
  assertDomain(
    authorization !== undefined &&
      authorization.decision === "allow" &&
      authorization.invocationId === invocation.id &&
      Date.parse(authorization.evaluatedAt) <= Date.parse(input.now) &&
      Date.parse(authorization.expiresAt) > Date.parse(input.now),
    "permission_denied",
    "Tool authorization is missing, stale, or expired at dispatch.",
  );
}

export function startToolInvocation(
  invocation: ToolInvocation,
  validation: AssertToolInvocationDispatchableInput,
): ToolInvocation {
  assertToolInvocationDispatchable(invocation, validation);
  return transitionToolInvocationState(invocation, {
    to: "running",
    now: validation.now,
  });
}

export interface TransitionToolInvocationInput {
  readonly to: Extract<
    ToolInvocationState,
    "completed" | "failed" | "cancelled" | "outcome-unknown"
  >;
  readonly now: IsoTimestamp;
  readonly outputHash?: string;
  readonly terminalReason?: string;
}

export function transitionToolInvocation(
  invocation: ToolInvocation,
  input: TransitionToolInvocationInput,
): ToolInvocation {
  return transitionToolInvocationState(invocation, input);
}

interface TransitionToolInvocationStateInput {
  readonly to: Extract<
    ToolInvocationState,
    "running" | "completed" | "failed" | "cancelled" | "outcome-unknown"
  >;
  readonly now: IsoTimestamp;
  readonly outputHash?: string;
  readonly terminalReason?: string;
}

function transitionToolInvocationState(
  invocation: ToolInvocation,
  input: TransitionToolInvocationStateInput,
): ToolInvocation {
  assertIsoTimestamp(input.now, "tool invocation transition time");
  assertDomain(
    Date.parse(input.now) >= Date.parse(invocation.updatedAt),
    "invalid_argument",
    "Tool invocation transition time cannot move backwards.",
  );
  const allowed: Readonly<
    Record<ToolInvocationState, readonly ToolInvocationState[]>
  > = {
    proposed: ["cancelled"],
    "awaiting-approval": ["cancelled"],
    ready: ["running", "cancelled"],
    running: ["completed", "failed", "cancelled", "outcome-unknown"],
    completed: [],
    failed: [],
    cancelled: [],
    denied: [],
    "outcome-unknown": [],
  };
  assertDomain(
    allowed[invocation.state].includes(input.to),
    "invalid_state_transition",
    `Tool invocation cannot transition from ${invocation.state} to ${input.to}.`,
  );
  const terminal = input.to !== "running";
  assertDomain(
    terminal === (input.terminalReason !== undefined),
    "invalid_argument",
    "Exactly terminal tool outcomes require a terminal reason.",
  );
  assertDomain(
    (input.to === "completed") === (input.outputHash !== undefined),
    "invalid_argument",
    "Exactly successful tool completion requires an output hash.",
  );
  return Object.freeze({
    ...invocation,
    state: input.to,
    updatedAt: input.now,
    ...(input.to === "running" && invocation.startedAt === undefined
      ? { startedAt: input.now }
      : {}),
    ...(terminal ? { terminalAt: input.now } : {}),
    ...(input.outputHash === undefined
      ? {}
      : { outputHash: assertSha256(input.outputHash, "tool output hash") }),
    ...(input.terminalReason === undefined
      ? {}
      : {
          terminalReason: assertNonBlank(
            input.terminalReason,
            "tool terminal reason",
            1_000,
          ),
        }),
  });
}

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
