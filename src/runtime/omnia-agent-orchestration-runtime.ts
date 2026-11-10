import { assertDomain } from "../domain/errors";
import {
  assertAgentGraphIntegrity,
  type AgentGraph,
} from "../domain/agent-graph";
import {
  addAgentTask,
  agentTasksCanRunInParallel,
  assignAgentTask,
  createAgentTaskDag,
  markAgentTaskReady,
  startAgentTask,
  transitionAgentTask,
  type AddAgentTaskInput,
  type AgentTask,
  type AgentTaskDag,
  type AgentTaskState,
  type TransitionAgentTaskInput,
} from "../domain/agent-task-dag";
import {
  claimAgentTaskLease,
  completeAgentTaskLease,
  createAgentTaskCoordinationState,
  expireAgentTaskLeases,
  heartbeatAgentTaskLease,
  releaseAgentTaskLease,
  validateAgentTaskCoordinationState,
  type AgentTaskCompletionReceipt,
  type AgentTaskCoordinationState,
  type AgentTaskLease,
  type ClaimAgentTaskLeaseInput,
  type CompleteAgentTaskLeaseInput,
  type ExpireAgentTaskLeasesResult,
  type HeartbeatAgentTaskLeaseInput,
  type ReleaseAgentTaskLeaseInput,
} from "../domain/agent-task-coordination";
import {
  KERNEL_CAPABILITY_VALUES,
  type AgentInstanceId,
  type AgentResultId,
} from "../domain/agent-tool-contract-shared";
import type { TaskId } from "../domain/ids";
import { assertOpaqueResourceHandle } from "../domain/resource-handle";
import {
  assertIntegerInRange,
  assertIsoTimestamp,
  assertNonBlank,
  type IsoTimestamp,
} from "../domain/shared";

/**
 * Renderer/domain-only orchestration snapshot.
 *
 * The snapshot intentionally keeps the agent graph, task DAG, and lease
 * ledger separate. A future native coordinator can persist this exact shape
 * and atomically apply the same immutable operations without coupling React
 * state to worker execution.
 */
export interface OmniaAgentOrchestrationSnapshot {
  readonly schemaVersion: 1;
  readonly graph: AgentGraph;
  readonly taskDag: AgentTaskDag;
  readonly coordination: AgentTaskCoordinationState;
}

export interface CreateOmniaAgentOrchestrationRuntimeInput {
  readonly graph: AgentGraph;
  readonly taskDag?: AgentTaskDag;
  readonly coordination?: AgentTaskCoordinationState;
}

export interface AgentOrchestrationSummary {
  readonly revision: number;
  readonly taskCount: number;
  readonly readyTaskIds: readonly TaskId[];
  readonly runningTaskIds: readonly TaskId[];
  readonly activeLeaseCount: number;
  readonly completedReceiptCount: number;
}

export interface ClaimLeaseRuntimeResult {
  readonly runtime: OmniaAgentOrchestrationRuntime;
  readonly lease: AgentTaskLease;
  readonly reclaimedExpiredCount: number;
}

export interface CompleteLeaseRuntimeResult {
  readonly runtime: OmniaAgentOrchestrationRuntime;
  readonly receipt: AgentTaskCompletionReceipt;
  readonly replayed: boolean;
}

function freezeTask(task: AgentTask): AgentTask {
  return Object.freeze({
    ...task,
    dependencyIds: Object.freeze([...task.dependencyIds]),
    requiredCapabilities: Object.freeze([...task.requiredCapabilities]),
    requiredToolVersionIds: Object.freeze([...task.requiredToolVersionIds]),
    resourceClaims: Object.freeze(
      task.resourceClaims.map((claim) => Object.freeze({ ...claim })),
    ),
  });
}

const TASK_STATES: readonly AgentTaskState[] = [
  "planned",
  "ready",
  "assigned",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

function assertText(value: unknown, label: string, maxLength: number): string {
  assertDomain(typeof value === "string", "invalid_argument", `${label} must be a string.`, { label });
  return assertNonBlank(value, label, maxLength);
}

function assertTaskStateShape(task: AgentTask): void {
  const assigned = task.assignedAgentId !== undefined;
  const terminal = task.state === "completed" || task.state === "failed" || task.state === "cancelled";
  assertDomain(
    (task.state === "assigned" || task.state === "running" || task.state === "blocked" || task.state === "completed") === assigned,
    "invalid_state_transition",
    "Task assignment metadata does not match its lifecycle state.",
    { taskId: task.id, state: task.state },
  );
  assertDomain(
    terminal === (task.terminalReason !== undefined),
    "invalid_state_transition",
    "Task terminal metadata does not match its lifecycle state.",
    { taskId: task.id, state: task.state },
  );
  assertDomain(
    (task.state === "completed") === (task.resultId !== undefined),
    "invalid_state_transition",
    "Task result metadata does not match its lifecycle state.",
    { taskId: task.id, state: task.state },
  );
}

function assertTaskDagAcyclic(tasks: readonly AgentTask[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (task: AgentTask): void => {
    if (visited.has(task.id)) return;
    assertDomain(!visiting.has(task.id), "invalid_state_transition", "Agent task DAG contains a dependency cycle.", { taskId: task.id });
    visiting.add(task.id);
    for (const dependencyId of task.dependencyIds) {
      const dependency = byId.get(dependencyId);
      assertDomain(dependency !== undefined, "not_found", "Task dependencies must exist in the durable DAG.", { taskId: task.id, dependencyId });
      visit(dependency);
    }
    visiting.delete(task.id);
    visited.add(task.id);
  };

  for (const task of tasks) visit(task);
}

function normalizeTaskDag(dag: AgentTaskDag, graph: AgentGraph): AgentTaskDag {
  assertDomain(dag !== null && typeof dag === "object", "invalid_argument", "Agent task DAG must be an object.");
  assertDomain(dag.version === 1, "invalid_argument", "Unsupported agent task DAG version.");
  assertDomain(dag.rootRunId === graph.rootRunId, "scope_violation", "Task DAG and agent graph belong to different logical runs.");
  assertDomain(Array.isArray(dag.tasks), "invalid_argument", "Agent task DAG tasks must be an array.");

  const ids = new Set<string>();
  const tasks = dag.tasks.map((task) => {
    assertDomain(task !== null && typeof task === "object", "invalid_argument", "Agent task must be an object.");
    assertText(task.id, "task ID", 256);
    assertDomain(!ids.has(task.id), "conflict", "Agent task IDs must be unique.", { taskId: task.id });
    ids.add(task.id);
    assertText(task.objective, "task objective", 8_000);
    assertIsoTimestamp(task.createdAt, "agent task creation time");
    assertIsoTimestamp(task.updatedAt, "agent task update time");
    assertDomain(Date.parse(task.updatedAt) >= Date.parse(task.createdAt), "invalid_argument", "Task update time cannot predate creation time.", { taskId: task.id });
    assertDomain(Array.isArray(task.dependencyIds), "invalid_argument", "Task dependencies must be an array.", { taskId: task.id });
    assertDomain(new Set(task.dependencyIds).size === task.dependencyIds.length, "invalid_argument", "Task dependencies must be unique.", { taskId: task.id });
    assertDomain(!task.dependencyIds.includes(task.id), "scope_violation", "A task cannot depend on itself.", { taskId: task.id });
    assertDomain(Array.isArray(task.requiredCapabilities), "invalid_argument", "Task capabilities must be an array.", { taskId: task.id });
    assertDomain(Array.isArray(task.requiredToolVersionIds), "invalid_argument", "Task tool requirements must be an array.", { taskId: task.id });
    assertDomain(Array.isArray(task.resourceClaims), "invalid_argument", "Task resource claims must be an array.", { taskId: task.id });
    for (const dependencyId of task.dependencyIds) assertText(dependencyId, "task dependency ID", 256);
    for (const capability of task.requiredCapabilities) {
      assertText(capability, "task capability", 256);
      assertDomain(KERNEL_CAPABILITY_VALUES.has(capability), "invalid_argument", "Task contains an unknown kernel capability.", { taskId: task.id, capability });
    }
    assertDomain(new Set(task.requiredCapabilities).size === task.requiredCapabilities.length, "invalid_argument", "Task capabilities must be unique.", { taskId: task.id });
    for (const toolVersionId of task.requiredToolVersionIds) assertText(toolVersionId, "task tool version ID", 256);
    assertDomain(new Set(task.requiredToolVersionIds).size === task.requiredToolVersionIds.length, "invalid_argument", "Task tool requirements must be unique.", { taskId: task.id });
    for (const claim of task.resourceClaims) {
      assertDomain(claim !== null && typeof claim === "object", "invalid_argument", "Task resource claims must be objects.", { taskId: task.id });
      assertOpaqueResourceHandle(claim.handle, "task resource handle");
      assertDomain(claim.access === "read" || claim.access === "write", "invalid_argument", "Task resource access must be read or write.", { taskId: task.id });
    }
    const claimKeys = task.resourceClaims.map(
      (claim: AgentTask["resourceClaims"][number]) => `${claim.handle}\u0000${claim.access}`,
    );
    assertDomain(new Set(claimKeys).size === claimKeys.length, "invalid_argument", "Task resource claims must be unique.", { taskId: task.id });
    assertDomain(TASK_STATES.includes(task.state), "invalid_argument", "Unknown agent task state.", { taskId: task.id, state: task.state });
    if (task.assignedAgentId !== undefined) assertText(task.assignedAgentId, "assigned agent ID", 256);
    if (task.resultId !== undefined) assertText(task.resultId, "task result ID", 256);
    if (task.terminalReason !== undefined) assertText(task.terminalReason, "task terminal reason", 1_000);
    const normalized = freezeTask(task);
    assertTaskStateShape(normalized);
    return normalized;
  });

  for (const task of tasks) {
    for (const dependencyId of task.dependencyIds) {
      assertDomain(ids.has(dependencyId), "not_found", "Task dependencies must exist in the durable DAG.", { taskId: task.id, dependencyId });
      const dependency = tasks.find((candidate) => candidate.id === dependencyId);
      assertDomain(dependency !== undefined, "not_found", "Task dependencies must exist in the durable DAG.", { taskId: task.id, dependencyId });
      assertDomain(Date.parse(task.createdAt) >= Date.parse(dependency.createdAt), "invalid_argument", "A task cannot predate one of its dependencies.", { taskId: task.id, dependencyId });
    }
  }

  assertTaskDagAcyclic(tasks);
  return Object.freeze({ version: 1, rootRunId: dag.rootRunId, tasks: Object.freeze(tasks) });
}

function normalizeGraph(graph: AgentGraph): AgentGraph {
  assertDomain(graph !== null && typeof graph === "object", "invalid_argument", "Agent graph must be an object.");
  assertDomain(graph.version === 1, "invalid_argument", "Unsupported agent graph version.");
  assertText(graph.rootRunId, "agent graph root run ID", 256);
  assertText(graph.branchId, "agent graph branch ID", 256);
  assertIntegerInRange(graph.maximumAgents, "maximum agent count", 1, 10_000);
  assertIntegerInRange(graph.maximumDepth, "maximum agent depth", 0, 128);
  assertDomain(Array.isArray(graph.agents), "invalid_argument", "Agent graph agents must be an array.");
  const ids = new Set<string>();
  const agents = graph.agents.map((agent) => {
    assertDomain(agent !== null && typeof agent === "object", "invalid_argument", "Agent graph entries must be objects.");
    assertText(agent.id, "agent ID", 256);
    assertDomain(!ids.has(agent.id), "conflict", "Agent IDs must be unique.", { agentId: agent.id });
    ids.add(agent.id);
    assertIsoTimestamp(agent.createdAt, "agent creation time");
    assertIsoTimestamp(agent.updatedAt, "agent update time");
    assertDomain(agent.authority !== null && typeof agent.authority === "object", "invalid_argument", "Agent authority must be an object.", { agentId: agent.id });
    assertDomain(Array.isArray(agent.authority.capabilities), "invalid_argument", "Agent capabilities must be an array.", { agentId: agent.id });
    assertDomain(Array.isArray(agent.authority.toolVersionIds), "invalid_argument", "Agent tool versions must be an array.", { agentId: agent.id });
    assertDomain(Array.isArray(agent.authority.workspaceGrantIds), "invalid_argument", "Agent workspace grants must be an array.", { agentId: agent.id });
    assertDomain(Array.isArray(agent.authority.environmentIds), "invalid_argument", "Agent environments must be an array.", { agentId: agent.id });
    assertDomain(agent.budget !== null && typeof agent.budget === "object", "invalid_argument", "Agent budget must be an object.", { agentId: agent.id });
    assertDomain(agent.outputRoute !== null && typeof agent.outputRoute === "object", "invalid_argument", "Agent output route must be an object.", { agentId: agent.id });
    return Object.freeze({
      ...agent,
      authority: Object.freeze({
        ...agent.authority,
        capabilities: Object.freeze([...agent.authority.capabilities]),
        toolVersionIds: Object.freeze([...agent.authority.toolVersionIds]),
        workspaceGrantIds: Object.freeze([...agent.authority.workspaceGrantIds]),
        environmentIds: Object.freeze([...agent.authority.environmentIds]),
      }),
      budget: Object.freeze({ ...agent.budget }),
      outputRoute: Object.freeze({ ...agent.outputRoute }),
    });
  });
  const normalized = Object.freeze({ ...graph, agents: Object.freeze(agents) });
  assertAgentGraphIntegrity(normalized);
  return normalized;
}

function assertTaskCoordinationScope(
  taskDag: AgentTaskDag,
  coordination: AgentTaskCoordinationState,
): void {
  const byId = new Map(taskDag.tasks.map((task) => [task.id, task]));
  for (const lease of coordination.leases) {
    const task = byId.get(lease.taskId);
    assertDomain(task !== undefined, "not_found", "A task lease must reference an existing task.", { taskId: lease.taskId, leaseEpoch: lease.leaseEpoch });
    if (lease.status === "active") {
      assertDomain(task.assignedAgentId !== undefined && task.assignedAgentId === lease.ownerAgentId, "scope_violation", "An active task lease owner must match the task assignment.", { taskId: lease.taskId, leaseEpoch: lease.leaseEpoch });
    }
  }
  for (const receipt of coordination.completionReceipts) {
    const task = byId.get(receipt.taskId);
    assertDomain(task !== undefined, "not_found", "A completion receipt must reference an existing task.", { taskId: receipt.taskId, receiptId: receipt.receiptId });
    assertDomain(task.assignedAgentId === receipt.ownerAgentId, "scope_violation", "Completion receipt owner must match the task assignment.", { taskId: receipt.taskId, receiptId: receipt.receiptId });
    assertDomain(task.state === receipt.outcome, "invalid_state_transition", "Completion receipt outcome must match the task state.", { taskId: receipt.taskId, receiptId: receipt.receiptId, state: task.state, outcome: receipt.outcome });
  }
}

function normalizeSnapshot(snapshot: OmniaAgentOrchestrationSnapshot): OmniaAgentOrchestrationSnapshot {
  assertDomain(snapshot !== null && typeof snapshot === "object", "invalid_argument", "Agent orchestration snapshot must be an object.");
  assertDomain(snapshot.schemaVersion === 1, "invalid_argument", "Unsupported agent orchestration snapshot version.");
  const graph = normalizeGraph(snapshot.graph);
  const taskDag = normalizeTaskDag(snapshot.taskDag, graph);
  const coordination = validateAgentTaskCoordinationState(snapshot.coordination);
  assertTaskCoordinationScope(taskDag, coordination);
  return Object.freeze({ schemaVersion: 1, graph, taskDag, coordination });
}

function taskOrThrow(dag: AgentTaskDag, taskId: TaskId): AgentTask {
  const task = dag.tasks.find((candidate) => candidate.id === taskId);
  assertDomain(task !== undefined, "not_found", "Agent task was not found.", { taskId });
  return task;
}

function assertLeaseTaskExists(dag: AgentTaskDag, taskId: TaskId): AgentTask {
  return taskOrThrow(dag, taskId);
}

function assertLeaseOwnerMatchesTask(task: AgentTask, ownerAgentId: AgentInstanceId): void {
  assertDomain(task.assignedAgentId !== undefined, "invalid_state_transition", "Only an assigned task can own a lease.", { taskId: task.id });
  assertDomain(task.assignedAgentId === ownerAgentId, "permission_denied", "The worker identity does not match the task assignment.", { taskId: task.id, assignedAgentId: task.assignedAgentId, ownerAgentId });
}

/** Immutable coordinator facade over the typed DAG and fencing ledger. */
export class OmniaAgentOrchestrationRuntime {
  private constructor(private readonly current: OmniaAgentOrchestrationSnapshot) {}

  static create(input: CreateOmniaAgentOrchestrationRuntimeInput): OmniaAgentOrchestrationRuntime {
    const graph = normalizeGraph(input.graph);
    const taskDag = normalizeTaskDag(input.taskDag ?? createAgentTaskDag(graph.rootRunId), graph);
    const coordination = validateAgentTaskCoordinationState(input.coordination ?? createAgentTaskCoordinationState());
    return new OmniaAgentOrchestrationRuntime(normalizeSnapshot({ schemaVersion: 1, graph, taskDag, coordination }));
  }

  static fromJSON(input: string | unknown): OmniaAgentOrchestrationRuntime {
    let value: unknown = input;
    if (typeof input === "string") {
      try {
        value = JSON.parse(input) as unknown;
      } catch {
        throw new Error("Invalid agent orchestration JSON.");
      }
    }
    return new OmniaAgentOrchestrationRuntime(normalizeSnapshot(value as OmniaAgentOrchestrationSnapshot));
  }

  get snapshot(): OmniaAgentOrchestrationSnapshot {
    return this.current;
  }

  get graph(): AgentGraph {
    return this.current.graph;
  }

  get taskDag(): AgentTaskDag {
    return this.current.taskDag;
  }

  get coordination(): AgentTaskCoordinationState {
    return this.current.coordination;
  }

  summary(): AgentOrchestrationSummary {
    return Object.freeze({
      revision: this.coordination.revision,
      taskCount: this.taskDag.tasks.length,
      readyTaskIds: Object.freeze(this.readyTasks().map((task) => task.id)),
      runningTaskIds: Object.freeze(this.taskDag.tasks.filter((task) => task.state === "running").map((task) => task.id)),
      activeLeaseCount: this.coordination.leases.filter((lease) => lease.status === "active").length,
      completedReceiptCount: this.coordination.completionReceipts.length,
    });
  }

  readyTasks(): readonly AgentTask[] {
    return Object.freeze(this.taskDag.tasks.filter((task) => {
      if (task.state !== "planned" && task.state !== "ready" && task.state !== "blocked") return false;
      return task.dependencyIds.every((dependencyId) => this.taskDag.tasks.find((candidate) => candidate.id === dependencyId)?.state === "completed");
    }));
  }

  activeLeaseForTask(taskId: TaskId): AgentTaskLease | undefined {
    taskOrThrow(this.taskDag, taskId);
    return this.coordination.leases.find((lease) => lease.taskId === taskId && lease.status === "active");
  }

  addTask(input: AddAgentTaskInput): OmniaAgentOrchestrationRuntime {
    return this.withTaskDag(addAgentTask(this.taskDag, input));
  }

  markTaskReady(taskId: TaskId, now: IsoTimestamp): OmniaAgentOrchestrationRuntime {
    return this.withTaskDag(markAgentTaskReady(this.taskDag, taskId, now));
  }

  assignTask(taskId: TaskId, agentId: AgentInstanceId, now: IsoTimestamp): OmniaAgentOrchestrationRuntime {
    return this.withTaskDag(assignAgentTask(this.taskDag, this.graph, taskId, agentId, now));
  }

  startTask(taskId: TaskId, now: IsoTimestamp): OmniaAgentOrchestrationRuntime {
    return this.withTaskDag(startAgentTask(this.taskDag, this.graph, taskId, now));
  }

  transitionTask(input: TransitionAgentTaskInput): OmniaAgentOrchestrationRuntime {
    return this.withTaskDag(transitionAgentTask(this.taskDag, input));
  }

  claimLease(input: ClaimAgentTaskLeaseInput): ClaimLeaseRuntimeResult {
    const task = assertLeaseTaskExists(this.taskDag, input.taskId);
    assertDomain(task.state === "assigned" || task.state === "running", "invalid_state_transition", "Only assigned or running tasks can acquire a lease.", { taskId: input.taskId, state: task.state });
    assertLeaseOwnerMatchesTask(task, input.ownerAgentId);
    const result = claimAgentTaskLease(this.coordination, input);
    return { runtime: this.withCoordination(result.state), lease: result.lease, reclaimedExpiredCount: result.reclaimedExpiredCount };
  }

  heartbeatLease(input: HeartbeatAgentTaskLeaseInput): OmniaAgentOrchestrationRuntime {
    const task = assertLeaseTaskExists(this.taskDag, input.taskId);
    assertLeaseOwnerMatchesTask(task, input.ownerAgentId);
    return this.withCoordination(heartbeatAgentTaskLease(this.coordination, input));
  }

  releaseLease(input: ReleaseAgentTaskLeaseInput): OmniaAgentOrchestrationRuntime {
    const task = assertLeaseTaskExists(this.taskDag, input.taskId);
    assertLeaseOwnerMatchesTask(task, input.ownerAgentId);
    return this.withCoordination(releaseAgentTaskLease(this.coordination, input));
  }

  expireLeases(expectedRevision: number, now: IsoTimestamp): { readonly runtime: OmniaAgentOrchestrationRuntime; readonly expiredLeaseEpochs: readonly number[] } {
    const result: ExpireAgentTaskLeasesResult = expireAgentTaskLeases(this.coordination, expectedRevision, now);
    return { runtime: this.withCoordination(result.state), expiredLeaseEpochs: result.expiredLeaseEpochs };
  }

  completeLease(input: CompleteAgentTaskLeaseInput): CompleteLeaseRuntimeResult {
    const task = assertLeaseTaskExists(this.taskDag, input.taskId);
    assertLeaseOwnerMatchesTask(task, input.ownerAgentId);
    const result = completeAgentTaskLease(this.coordination, input);
    if (result.replayed) {
      return { runtime: this, receipt: result.receipt, replayed: true };
    }
    const taskState: Extract<AgentTaskState, "completed" | "failed" | "cancelled"> = input.outcome;
    // The DAG keeps a terminal reason for every terminal task, while the
    // completion receipt intentionally omits a reason for successful output.
    // Preserve both contracts by deriving a stable success reason locally.
    const terminalReason = input.terminalReason ?? (input.outcome === "completed" ? "completed" : undefined);
    const taskDag = transitionAgentTask(this.taskDag, {
      taskId: input.taskId,
      to: taskState,
      now: input.now,
      ...(input.resultId === undefined ? {} : { resultId: input.resultId as AgentResultId }),
      ...(terminalReason === undefined ? {} : { terminalReason }),
    });
    return { runtime: this.withSnapshot(taskDag, result.state), receipt: result.receipt, replayed: false };
  }

  canRunInParallel(leftTaskId: TaskId, rightTaskId: TaskId): boolean {
    const left = taskOrThrow(this.taskDag, leftTaskId);
    const right = taskOrThrow(this.taskDag, rightTaskId);
    return agentTasksCanRunInParallel(left, right);
  }

  serialize(): string {
    return JSON.stringify(this.snapshot, null, 2);
  }

  private withTaskDag(taskDag: AgentTaskDag): OmniaAgentOrchestrationRuntime {
    return this.withSnapshot(taskDag, this.coordination);
  }

  private withCoordination(coordination: AgentTaskCoordinationState): OmniaAgentOrchestrationRuntime {
    return this.withSnapshot(this.taskDag, coordination);
  }

  private withSnapshot(taskDag: AgentTaskDag, coordination: AgentTaskCoordinationState): OmniaAgentOrchestrationRuntime {
    return new OmniaAgentOrchestrationRuntime(normalizeSnapshot({ schemaVersion: 1, graph: this.graph, taskDag, coordination }));
  }
}

export function createOmniaAgentOrchestrationRuntime(
  input: CreateOmniaAgentOrchestrationRuntimeInput,
): OmniaAgentOrchestrationRuntime {
  return OmniaAgentOrchestrationRuntime.create(input);
}

export function deserializeOmniaAgentOrchestrationRuntime(
  input: string | unknown,
): OmniaAgentOrchestrationRuntime {
  return OmniaAgentOrchestrationRuntime.fromJSON(input);
}

export function serializeOmniaAgentOrchestrationRuntime(
  runtime: OmniaAgentOrchestrationRuntime,
): string {
  return runtime.serialize();
}
