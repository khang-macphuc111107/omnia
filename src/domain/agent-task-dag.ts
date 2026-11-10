import { assertDomain } from "./errors";
import type { RunId, TaskId } from "./ids";
import type { KernelCapability } from "./kernel-capability";
import { assertOpaqueResourceHandle } from "./resource-handle";
import {
  assertIsoTimestamp,
  assertNonBlank,
  type IsoTimestamp,
} from "./shared";
import type { AgentGraph } from "./agent-graph";
import {
  KERNEL_CAPABILITY_VALUES,
  type AgentInstanceId,
  type AgentResultId,
  type ToolVersionId,
  uniqueValues,
  valuesAreSubset,
} from "./agent-tool-contract-shared";

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
  // A blocked task may return to the scheduler, but the previous process
  // assignment is not authority for a later execution. Resuming the same
  // assignment uses startAgentTask() directly from `blocked`; requeueing via
  // this function deliberately requires an exact new assignment.
  const next: AgentTask = Object.freeze({
    id: task.id,
    objective: task.objective,
    dependencyIds: task.dependencyIds,
    requiredCapabilities: task.requiredCapabilities,
    requiredToolVersionIds: task.requiredToolVersionIds,
    resourceClaims: task.resourceClaims,
    state: "ready" as const,
    createdAt: task.createdAt,
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
