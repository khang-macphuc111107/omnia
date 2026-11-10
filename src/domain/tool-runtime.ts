import { assertDomain } from "./errors";
import type {
  BranchId,
  ExecutionEnvironmentId,
  RunId,
  TaskId,
} from "./ids";
import type { KernelCapability } from "./kernel-capability";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";
import type { AgentGraph } from "./agent-graph";
import type { AgentTaskDag } from "./agent-task-dag";
import {
  type AgentInstanceId,
  type ToolAuthorizationDecisionId,
  type ToolInvocationId,
  type ToolVersionId,
  uniqueValues,
  valuesAreSubset,
} from "./agent-tool-contract-shared";
import {
  resolveToolVersion,
  type ToolRegistry,
} from "./tool-registry";

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

