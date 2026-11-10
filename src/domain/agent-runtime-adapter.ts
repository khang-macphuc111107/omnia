import { assertDomain } from "./errors";
import {
  assertAgentGraphIntegrity,
  type AgentAuthorityCeiling,
  type AgentContextMode,
  type AgentGraph,
  type AgentInstance,
  type AgentOutputRoute,
  type AgentResourceBudget,
  type AgentRole,
  type AgentState,
} from "./agent-graph";
import {
  validateAgentTaskCoordinationState,
  type AgentTaskCoordinationState,
  type AgentTaskLease,
  type AgentTaskLeaseStatus,
} from "./agent-task-coordination";
import type {
  AgentTask,
  AgentTaskDag,
  AgentTaskResourceClaim,
  AgentTaskState,
} from "./agent-task-dag";
import type {
  AgentMailbox,
  AgentMailboxMessage,
  AgentMailboxMessageKind,
} from "./agent-mailbox";
import type {
  AgentInstanceId,
  AgentMailboxMessageId,
  AgentResultId,
} from "./agent-tool-contract-shared";
import type {
  BranchId,
  ExecutionEnvironmentId,
  RunId,
  RunItemId,
  TaskId,
} from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";
import type { ConcreteExecutionMode } from "./execution";
import type { KernelCapability } from "./kernel-capability";

/**
 * Version of the renderer/native-safe projection emitted by this adapter.
 * This is deliberately different from the durable graph and task versions.
 */
export const AGENT_RUNTIME_ADAPTER_SCHEMA_VERSION = 1 as const;

export interface AgentRuntimeAuthorityProjection {
  readonly capabilities: readonly KernelCapability[];
  readonly toolVersionIds: readonly string[];
  readonly workspaceGrantIds: readonly string[];
  readonly environmentIds: readonly ExecutionEnvironmentId[];
}

export interface AgentRuntimeBudgetProjection extends AgentResourceBudget {}

export interface AgentRuntimeOutputRouteProjection {
  readonly kind: AgentOutputRoute["kind"];
  readonly branchId?: BranchId;
  readonly expectedParentItemId?: RunItemId;
  readonly authorizationHash?: string;
}

/** Identity and lifecycle are separate so a display label can never act as an address. */
export interface AgentRuntimeAgentProjection {
  readonly identity: {
    readonly id: AgentInstanceId;
    readonly parentAgentId?: AgentInstanceId;
    readonly spawnOrdinal: number;
    readonly depth: number;
    readonly role: AgentRole;
    readonly label: string;
    readonly runId: RunId;
  };
  readonly objective: string;
  readonly contextMode: AgentContextMode;
  readonly execution?: {
    readonly environmentId: ExecutionEnvironmentId;
    readonly mode: ConcreteExecutionMode;
  };
  readonly authority: AgentRuntimeAuthorityProjection;
  readonly budget: AgentRuntimeBudgetProjection;
  readonly outputRoute: AgentRuntimeOutputRouteProjection;
  readonly lifecycle: {
    readonly state: AgentState;
    readonly createdAt: IsoTimestamp;
    readonly updatedAt: IsoTimestamp;
    readonly terminalAt?: IsoTimestamp;
    readonly terminalReason?: string;
  };
  readonly activeChildCount: number;
  readonly terminalChildCount: number;
}

export interface AgentRuntimeTaskProjection {
  readonly id: TaskId;
  readonly objective: string;
  readonly dependencyIds: readonly TaskId[];
  readonly dependencySummary: {
    readonly total: number;
    readonly completed: number;
    readonly pending: number;
  };
  readonly requiredCapabilities: readonly KernelCapability[];
  readonly requiredToolVersionIds: readonly string[];
  readonly resourceClaims: readonly AgentTaskResourceClaim[];
  readonly assignedAgentId?: AgentInstanceId;
  readonly state: AgentTaskState;
  readonly resultId?: AgentResultId;
  readonly terminalReason?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  /** Eligibility only; native scheduling still owns lease, budget and policy checks. */
  readonly schedulerEligible: boolean;
}

export interface AgentRuntimeLeaseProjection {
  readonly taskId: TaskId;
  readonly ownerAgentId: AgentInstanceId;
  readonly workerIncarnationId: string;
  readonly leaseEpoch: number;
  readonly acquiredAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly lastHeartbeatAt: IsoTimestamp;
  readonly acquiredAtRevision: number;
  readonly status: AgentTaskLeaseStatus;
  readonly expiredAtProjectionTime: boolean;
  readonly releasedAt?: IsoTimestamp;
  readonly releaseReason?: string;
}

export interface AgentRuntimeMailboxMessageProjection {
  readonly id: AgentMailboxMessageId;
  readonly senderAgentId: AgentInstanceId;
  readonly recipientAgentId: AgentInstanceId;
  readonly taskId?: TaskId;
  readonly kind: AgentMailboxMessageKind;
  readonly sensitivity: AgentMailboxMessage["sensitivity"];
  readonly contentHash: string;
  readonly deliveryKeyHash: string;
  readonly deliverySequence: number;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly acknowledgedAt?: IsoTimestamp;
  readonly expiredAtProjectionTime: boolean;
  /** Payload is intentionally omitted at this boundary. */
  readonly payloadBytes: number;
}

export interface AgentRuntimeMailboxProjection {
  readonly maximumMessages: number;
  readonly maximumBytes: number;
  readonly messageCount: number;
  readonly acknowledgedCount: number;
  readonly unreadCount: number;
  readonly expiredCount: number;
  readonly byKind: Readonly<Record<AgentMailboxMessageKind, number>>;
  readonly bySensitivity: Readonly<Record<AgentMailboxMessage["sensitivity"], number>>;
  readonly messages: readonly AgentRuntimeMailboxMessageProjection[];
}

export interface AgentRuntimeCoordinationProjection {
  readonly revision: number;
  readonly activeLeaseCount: number;
  readonly releasedLeaseCount: number;
  readonly expiredLeaseCount: number;
  readonly completionReceiptCount: number;
  readonly leases: readonly AgentRuntimeLeaseProjection[];
}

export interface AgentRuntimeProjection {
  readonly schemaVersion: typeof AGENT_RUNTIME_ADAPTER_SCHEMA_VERSION;
  readonly rootRunId: RunId;
  readonly branchId: BranchId;
  readonly generatedAt: IsoTimestamp;
  readonly graph: {
    readonly maximumAgents: number;
    readonly maximumDepth: number;
    readonly agentCount: number;
    readonly activeAgentCount: number;
    readonly terminalAgentCount: number;
    readonly agents: readonly AgentRuntimeAgentProjection[];
  };
  readonly tasks: {
    readonly taskCount: number;
    readonly byState: Readonly<Record<AgentTaskState, number>>;
    readonly readyTaskIds: readonly TaskId[];
    readonly runningTaskIds: readonly TaskId[];
    readonly blockedTaskIds: readonly TaskId[];
    readonly tasks: readonly AgentRuntimeTaskProjection[];
  };
  readonly coordination?: AgentRuntimeCoordinationProjection;
  readonly mailbox?: AgentRuntimeMailboxProjection;
}

export interface CreateAgentRuntimeProjectionInput {
  readonly graph: AgentGraph;
  readonly taskDag: AgentTaskDag;
  readonly coordination?: AgentTaskCoordinationState;
  readonly mailbox?: AgentMailbox;
  readonly now: IsoTimestamp;
}

const AGENT_STATES: readonly AgentState[] = [
  "created",
  "queued",
  "running",
  "waiting",
  "blocked",
  "orphaned",
  "completed",
  "failed",
  "cancelled",
];
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
const MAILBOX_KINDS: readonly AgentMailboxMessageKind[] = [
  "finding",
  "question",
  "answer",
  "handoff",
  "progress",
  "artifact-reference",
  "control",
];
const MAILBOX_SENSITIVITIES: readonly AgentMailboxMessage["sensitivity"][] = [
  "normal",
  "sensitive",
  "restricted",
];

function freezeRecord<T extends Record<string, number>>(record: T): Readonly<T> {
  return Object.freeze({ ...record });
}

function createAgentCounts(): Record<AgentState, number> {
  return Object.fromEntries(AGENT_STATES.map((state) => [state, 0])) as Record<
    AgentState,
    number
  >;
}

function createTaskCounts(): Record<AgentTaskState, number> {
  return Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as Record<
    AgentTaskState,
    number
  >;
}

function createKindCounts(): Record<AgentMailboxMessageKind, number> {
  return Object.fromEntries(MAILBOX_KINDS.map((kind) => [kind, 0])) as Record<
    AgentMailboxMessageKind,
    number
  >;
}

function createSensitivityCounts(): Record<AgentMailboxMessage["sensitivity"], number> {
  return Object.fromEntries(
    MAILBOX_SENSITIVITIES.map((sensitivity) => [sensitivity, 0]),
  ) as Record<AgentMailboxMessage["sensitivity"], number>;
}

function isTerminalAgentState(state: AgentState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function assertNonNegativeCount(value: number, label: string): number {
  assertDomain(
    Number.isSafeInteger(value) && value >= 0,
    "invalid_argument",
    `${label} must be a non-negative safe integer.`,
  );
  return value;
}

function payloadBytes(message: AgentMailboxMessage): number {
  return new TextEncoder().encode(JSON.stringify(message.payload)).byteLength;
}

function cloneAuthority(authority: AgentAuthorityCeiling): AgentRuntimeAuthorityProjection {
  return Object.freeze({
    capabilities: Object.freeze([...authority.capabilities]),
    toolVersionIds: Object.freeze([...authority.toolVersionIds]),
    workspaceGrantIds: Object.freeze([...authority.workspaceGrantIds]),
    environmentIds: Object.freeze([...authority.environmentIds]),
  });
}

function cloneBudget(budget: AgentResourceBudget): AgentRuntimeBudgetProjection {
  return Object.freeze({ ...budget });
}

function cloneOutputRoute(route: AgentOutputRoute): AgentRuntimeOutputRouteProjection {
  if (route.kind === "fixed") {
    return Object.freeze({
      kind: route.kind,
      branchId: route.branchId,
      ...(route.expectedParentItemId === undefined
        ? {}
        : { expectedParentItemId: route.expectedParentItemId }),
    });
  }
  if (route.kind === "follow-active") {
    return Object.freeze({
      kind: route.kind,
      authorizationHash: route.authorizationHash,
    });
  }
  return Object.freeze({ kind: route.kind });
}

function cloneAgent(agent: AgentInstance, graph: AgentGraph): AgentRuntimeAgentProjection {
  const children = graph.agents.filter(
    (candidate) => candidate.parentAgentId === agent.id,
  );
  const execution =
    agent.executionEnvironmentId === undefined || agent.executionMode === undefined
      ? undefined
      : Object.freeze({
          environmentId: agent.executionEnvironmentId,
          mode: agent.executionMode,
        });
  return Object.freeze({
    identity: Object.freeze({
      id: agent.id,
      ...(agent.parentAgentId === undefined
        ? {}
        : { parentAgentId: agent.parentAgentId }),
      spawnOrdinal: agent.spawnOrdinal,
      depth: agent.depth,
      role: agent.role,
      label: agent.label,
      runId: agent.runId,
    }),
    objective: agent.objective,
    contextMode: agent.contextMode,
    ...(execution === undefined ? {} : { execution }),
    authority: cloneAuthority(agent.authority),
    budget: cloneBudget(agent.budget),
    outputRoute: cloneOutputRoute(agent.outputRoute),
    lifecycle: Object.freeze({
      state: agent.state,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      ...(agent.terminalAt === undefined ? {} : { terminalAt: agent.terminalAt }),
      ...(agent.terminalReason === undefined
        ? {}
        : { terminalReason: agent.terminalReason }),
    }),
    activeChildCount: children.filter(
      (child) => !isTerminalAgentState(child.state),
    ).length,
    terminalChildCount: children.filter((child) => isTerminalAgentState(child.state))
      .length,
  });
}

function assertRuntimeInputIntegrity(input: CreateAgentRuntimeProjectionInput): void {
  assertIsoTimestamp(input.now, "agent runtime projection time");
  assertAgentGraphIntegrity(input.graph);
  assertDomain(
    input.taskDag.version === 1,
    "invalid_argument",
    "Unsupported agent task DAG version.",
  );
  assertDomain(
    input.taskDag.rootRunId === input.graph.rootRunId,
    "scope_violation",
    "Agent graph and task DAG belong to different logical runs.",
  );

  const agents = new Set(input.graph.agents.map((agent) => agent.id));
  const tasks = new Set(input.taskDag.tasks.map((task) => task.id));
  for (const task of input.taskDag.tasks) {
    assertDomain(
      task.assignedAgentId === undefined || agents.has(task.assignedAgentId),
      "scope_violation",
      "Task assignment points outside the agent graph.",
      { taskId: task.id, assignedAgentId: task.assignedAgentId },
    );
    assertDomain(
      task.dependencyIds.every((dependencyId) => tasks.has(dependencyId)),
      "invalid_state_transition",
      "Task dependency points outside the durable DAG.",
      { taskId: task.id },
    );
    if (task.state === "running" || task.state === "assigned") {
      assertDomain(
        task.assignedAgentId !== undefined,
        "invalid_state_transition",
        "Assigned or running tasks require an agent identity.",
        { taskId: task.id },
      );
    }
  }

  if (input.coordination !== undefined) {
    validateAgentTaskCoordinationState(input.coordination);
    const activeTaskLeases = new Set<TaskId>();
    for (const lease of input.coordination.leases) {
      assertDomain(tasks.has(lease.taskId), "scope_violation", "Lease points outside the task DAG.", {
        taskId: lease.taskId,
      });
      assertDomain(agents.has(lease.ownerAgentId), "scope_violation", "Lease owner points outside the agent graph.", {
        ownerAgentId: lease.ownerAgentId,
      });
      if (lease.status === "active") {
        assertDomain(
          !activeTaskLeases.has(lease.taskId),
          "conflict",
          "A task cannot have multiple active leases in one projection.",
          { taskId: lease.taskId },
        );
        activeTaskLeases.add(lease.taskId);
      }
    }
  }

  if (input.mailbox !== undefined) {
    assertDomain(input.mailbox.version === 1, "invalid_argument", "Unsupported agent mailbox version.");
    assertNonNegativeCount(input.mailbox.maximumMessages, "mailbox maximum messages");
    assertNonNegativeCount(input.mailbox.maximumBytes, "mailbox maximum bytes");
    const messageIds = new Set<AgentMailboxMessageId>();
    const deliveryKeys = new Set<string>();
    for (const message of input.mailbox.messages) {
      assertDomain(!messageIds.has(message.id), "conflict", "Mailbox contains a duplicate message ID.", {
        messageId: message.id,
      });
      messageIds.add(message.id);
      assertDomain(agents.has(message.senderAgentId) && agents.has(message.recipientAgentId), "scope_violation", "Mailbox message points outside the agent graph.", {
        messageId: message.id,
      });
      assertDomain(message.senderAgentId !== message.recipientAgentId, "scope_violation", "Mailbox sender and recipient must differ.");
      if (message.taskId !== undefined) {
        assertDomain(tasks.has(message.taskId), "scope_violation", "Mailbox task points outside the task DAG.", {
          messageId: message.id,
        });
      }
      assertIsoTimestamp(message.createdAt, "mailbox message creation time");
      if (message.expiresAt !== undefined) {
        assertIsoTimestamp(message.expiresAt, "mailbox message expiry time");
        assertDomain(Date.parse(message.expiresAt) > Date.parse(message.createdAt), "invalid_argument", "Mailbox expiry must follow creation.");
      }
      assertDomain(!deliveryKeys.has(`${message.senderAgentId}\u0000${message.recipientAgentId}\u0000${message.deliveryKeyHash}`), "conflict", "Mailbox delivery key is duplicated.");
      deliveryKeys.add(`${message.senderAgentId}\u0000${message.recipientAgentId}\u0000${message.deliveryKeyHash}`);
      assertSha256(message.contentHash, "mailbox content hash");
      assertSha256(message.deliveryKeyHash, "mailbox delivery-key hash");
    }
  }
}

function projectTask(task: AgentTask, dag: AgentTaskDag): AgentRuntimeTaskProjection {
  const completed = task.dependencyIds.filter(
    (dependencyId) =>
      dag.tasks.find((candidate) => candidate.id === dependencyId)?.state ===
      "completed",
  ).length;
  return Object.freeze({
    id: task.id,
    objective: task.objective,
    dependencyIds: Object.freeze([...task.dependencyIds]),
    dependencySummary: Object.freeze({
      total: task.dependencyIds.length,
      completed,
      pending: task.dependencyIds.length - completed,
    }),
    requiredCapabilities: Object.freeze([...task.requiredCapabilities]),
    requiredToolVersionIds: Object.freeze([...task.requiredToolVersionIds]),
    resourceClaims: Object.freeze(
      task.resourceClaims.map((claim) => Object.freeze({ ...claim })),
    ),
    ...(task.assignedAgentId === undefined
      ? {}
      : { assignedAgentId: task.assignedAgentId }),
    state: task.state,
    ...(task.resultId === undefined ? {} : { resultId: task.resultId }),
    ...(task.terminalReason === undefined
      ? {}
      : { terminalReason: task.terminalReason }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    schedulerEligible: task.state === "ready" && completed === task.dependencyIds.length,
  });
}

function projectLease(lease: AgentTaskLease, now: IsoTimestamp): AgentRuntimeLeaseProjection {
  const expiredAtProjectionTime = Date.parse(lease.expiresAt) <= Date.parse(now);
  return Object.freeze({ ...lease, expiredAtProjectionTime });
}

function projectMailboxMessage(
  message: AgentMailboxMessage,
  now: IsoTimestamp,
): AgentRuntimeMailboxMessageProjection {
  return Object.freeze({
    id: message.id,
    senderAgentId: message.senderAgentId,
    recipientAgentId: message.recipientAgentId,
    ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
    kind: message.kind,
    sensitivity: message.sensitivity,
    contentHash: message.contentHash,
    deliveryKeyHash: message.deliveryKeyHash,
    deliverySequence: message.deliverySequence,
    createdAt: message.createdAt,
    ...(message.expiresAt === undefined ? {} : { expiresAt: message.expiresAt }),
    ...(message.acknowledgedAt === undefined
      ? {}
      : { acknowledgedAt: message.acknowledgedAt }),
    expiredAtProjectionTime:
      message.expiresAt !== undefined && Date.parse(message.expiresAt) <= Date.parse(now),
    payloadBytes: payloadBytes(message),
  });
}

/** Build a bounded projection; this function never starts or schedules execution. */
export function createAgentRuntimeProjection(
  input: CreateAgentRuntimeProjectionInput,
): AgentRuntimeProjection {
  assertRuntimeInputIntegrity(input);
  const agentCounts = createAgentCounts();
  const agents = input.graph.agents.map((agent) => {
    agentCounts[agent.state] += 1;
    return cloneAgent(agent, input.graph);
  });
  const taskCounts = createTaskCounts();
  const tasks = input.taskDag.tasks.map((task) => {
    taskCounts[task.state] += 1;
    return projectTask(task, input.taskDag);
  });
  const coordination =
    input.coordination === undefined
      ? undefined
      : (() => {
          const leases = input.coordination.leases.map((lease) =>
            projectLease(lease, input.now),
          );
          return Object.freeze({
            revision: input.coordination.revision,
            activeLeaseCount: leases.filter((lease) => lease.status === "active").length,
            releasedLeaseCount: leases.filter((lease) => lease.status === "released").length,
            expiredLeaseCount: leases.filter(
              (lease) => lease.status === "expired" || lease.expiredAtProjectionTime,
            ).length,
            completionReceiptCount: input.coordination.completionReceipts.length,
            leases: Object.freeze(leases),
          });
        })();
  const mailbox =
    input.mailbox === undefined
      ? undefined
      : (() => {
          const kindCounts = createKindCounts();
          const sensitivityCounts = createSensitivityCounts();
          const messages = input.mailbox.messages.map((message) => {
            kindCounts[message.kind] += 1;
            sensitivityCounts[message.sensitivity] += 1;
            return projectMailboxMessage(message, input.now);
          });
          const expiredCount = messages.filter((message) => message.expiredAtProjectionTime).length;
          const acknowledgedCount = messages.filter((message) => message.acknowledgedAt !== undefined).length;
          return Object.freeze({
            maximumMessages: input.mailbox.maximumMessages,
            maximumBytes: input.mailbox.maximumBytes,
            messageCount: messages.length,
            acknowledgedCount,
            unreadCount: messages.filter(
              (message) => message.acknowledgedAt === undefined && !message.expiredAtProjectionTime,
            ).length,
            expiredCount,
            byKind: freezeRecord(kindCounts),
            bySensitivity: freezeRecord(sensitivityCounts),
            messages: Object.freeze(messages),
          });
        })();

  const projection: AgentRuntimeProjection = {
    schemaVersion: AGENT_RUNTIME_ADAPTER_SCHEMA_VERSION,
    rootRunId: input.graph.rootRunId,
    branchId: input.graph.branchId,
    generatedAt: input.now,
    graph: Object.freeze({
      maximumAgents: input.graph.maximumAgents,
      maximumDepth: input.graph.maximumDepth,
      agentCount: agents.length,
      activeAgentCount: agents.filter((agent) => !isTerminalAgentState(agent.lifecycle.state)).length,
      terminalAgentCount: agents.filter((agent) => isTerminalAgentState(agent.lifecycle.state)).length,
      agents: Object.freeze(agents),
    }),
    tasks: Object.freeze({
      taskCount: tasks.length,
      byState: freezeRecord(taskCounts),
      readyTaskIds: Object.freeze(tasks.filter((task) => task.state === "ready").map((task) => task.id)),
      runningTaskIds: Object.freeze(tasks.filter((task) => task.state === "running").map((task) => task.id)),
      blockedTaskIds: Object.freeze(tasks.filter((task) => task.state === "blocked").map((task) => task.id)),
      tasks: Object.freeze(tasks),
    }),
    ...(coordination === undefined ? {} : { coordination }),
    ...(mailbox === undefined ? {} : { mailbox }),
  };
  return Object.freeze(projection);
}

/** Alias useful to callers that treat the adapter as a pure builder. */
export const buildAgentRuntimeProjection = createAgentRuntimeProjection;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function parseCount(value: unknown, label: string): number {
  assertDomain(typeof value === "number", "invalid_argument", `${label} must be a number.`);
  return assertNonNegativeCount(value, label);
}

function parseStringArray(value: unknown, label: string): readonly string[] {
  assertDomain(Array.isArray(value) && value.every(isString), "invalid_argument", `${label} must be an array of strings.`);
  return Object.freeze(value.map((item) => assertNonBlank(item, label, 4_096)));
}

function parseOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  assertDomain(isString(value), "invalid_argument", `${label} must be a string.`);
  return assertNonBlank(value, label, 8_000);
}

function parseTimestamp(value: unknown, label: string): IsoTimestamp {
  assertDomain(isString(value), "invalid_argument", `${label} must be a string.`);
  assertIsoTimestamp(value, label);
  return value;
}

function parseOptionalTimestamp(
  value: unknown,
  label: string,
): IsoTimestamp | undefined {
  if (value === undefined) return undefined;
  return parseTimestamp(value, label);
}

function parseOutputRoute(value: unknown): AgentRuntimeOutputRouteProjection {
  assertDomain(isRecord(value), "invalid_argument", "Invalid agent output route projection.");
  assertDomain(isOneOf(["fixed", "inbox-only", "follow-active"] as const, value.kind), "invalid_argument", "Unknown agent output route kind.");
  if (value.kind === "fixed") {
    assertDomain(isString(value.branchId), "invalid_argument", "Fixed output route requires a branch ID.");
    return Object.freeze({
      kind: "fixed",
      branchId: assertNonBlank(value.branchId, "output route branch ID", 256) as BranchId,
      ...(value.expectedParentItemId === undefined
        ? {}
        : { expectedParentItemId: assertNonBlank(String(value.expectedParentItemId), "output route parent item ID", 256) as RunItemId }),
    });
  }
  if (value.kind === "follow-active") {
    assertDomain(isString(value.authorizationHash), "invalid_argument", "Follow-active output route requires authorization.");
    return Object.freeze({
      kind: "follow-active",
      authorizationHash: assertSha256(value.authorizationHash, "output route authorization hash"),
    });
  }
  return Object.freeze({ kind: "inbox-only" });
}

function parseAgent(value: unknown): AgentRuntimeAgentProjection {
  assertDomain(isRecord(value), "invalid_argument", "Invalid agent runtime agent projection.");
  assertDomain(isRecord(value.identity), "invalid_argument", "Agent projection identity is required.");
  const identity = value.identity;
  assertDomain(isString(identity.id), "invalid_argument", "Agent projection ID is required.");
  assertDomain(isString(identity.runId), "invalid_argument", "Agent projection run ID is required.");
  assertDomain(isString(identity.label), "invalid_argument", "Agent projection label is required.");
  assertDomain(isOneOf(["orchestrator", "planner", "explorer", "builder", "reviewer", "verifier", "researcher", "specialist"] as const, identity.role), "invalid_argument", "Unknown agent projection role.");
  assertDomain(isOneOf(["fresh", "fork", "persistent", "team"] as const, identity.contextMode ?? value.contextMode), "invalid_argument", "Unknown agent projection context mode.");
  assertDomain(isRecord(value.lifecycle), "invalid_argument", "Agent projection lifecycle is required.");
  const lifecycle = value.lifecycle;
  assertDomain(isOneOf(AGENT_STATES, lifecycle.state), "invalid_argument", "Unknown agent projection state.");
  assertDomain(isString(lifecycle.createdAt) && isString(lifecycle.updatedAt), "invalid_argument", "Agent projection timestamps are required.");
  assertIsoTimestamp(lifecycle.createdAt, "agent projection creation time");
  assertIsoTimestamp(lifecycle.updatedAt, "agent projection update time");
  const execution = value.execution;
  let parsedExecution: AgentRuntimeAgentProjection["execution"];
  if (execution !== undefined) {
    assertDomain(isRecord(execution) && isString(execution.environmentId) && isOneOf(["persistent", "isolated", "remote"] as const, execution.mode), "invalid_argument", "Invalid agent projection execution binding.");
    parsedExecution = Object.freeze({
      environmentId: execution.environmentId as ExecutionEnvironmentId,
      mode: execution.mode,
    });
  }
  assertDomain(isRecord(value.authority) && isRecord(value.budget), "invalid_argument", "Agent authority and budget are required.");
  const authority = value.authority;
  const budget = value.budget;
  const capabilities = parseStringArray(authority.capabilities, "agent authority capabilities") as readonly KernelCapability[];
  const toolVersionIds = parseStringArray(authority.toolVersionIds, "agent authority tool versions");
  const workspaceGrantIds = parseStringArray(authority.workspaceGrantIds, "agent authority workspace grants");
  const environmentIds = parseStringArray(authority.environmentIds, "agent authority environments") as readonly ExecutionEnvironmentId[];
  const parsedBudget: AgentResourceBudget = Object.freeze({
    maximumInputTokens: parseCount(
      budget.maximumInputTokens,
      "agent budget maximumInputTokens",
    ),
    maximumOutputTokens: parseCount(
      budget.maximumOutputTokens,
      "agent budget maximumOutputTokens",
    ),
    maximumCostMicrounits: parseCount(
      budget.maximumCostMicrounits,
      "agent budget maximumCostMicrounits",
    ),
    maximumWallClockMs: parseCount(
      budget.maximumWallClockMs,
      "agent budget maximumWallClockMs",
    ),
    maximumToolInvocations: parseCount(
      budget.maximumToolInvocations,
      "agent budget maximumToolInvocations",
    ),
    maximumChildren: parseCount(
      budget.maximumChildren,
      "agent budget maximumChildren",
    ),
    maximumMutationOperations: parseCount(
      budget.maximumMutationOperations,
      "agent budget maximumMutationOperations",
    ),
    maximumMailboxBytes: parseCount(
      budget.maximumMailboxBytes,
      "agent budget maximumMailboxBytes",
    ),
  });
  const route = parseOutputRoute(value.outputRoute);
  const terminalAt = parseOptionalTimestamp(
    lifecycle.terminalAt,
    "agent projection terminal time",
  );
  const terminalReason = parseOptionalString(
    lifecycle.terminalReason,
    "agent terminal reason",
  );
  return Object.freeze({
    identity: Object.freeze({
      id: identity.id as AgentInstanceId,
      ...(identity.parentAgentId === undefined ? {} : { parentAgentId: assertNonBlank(String(identity.parentAgentId), "agent parent ID", 256) as AgentInstanceId }),
      spawnOrdinal: parseCount(identity.spawnOrdinal, "agent spawn ordinal"),
      depth: parseCount(identity.depth, "agent depth"),
      role: identity.role,
      label: assertNonBlank(identity.label, "agent label", 160),
      runId: identity.runId as RunId,
    }),
    objective: assertNonBlank(String(value.objective ?? ""), "agent objective", 8_000),
    contextMode: (identity.contextMode ?? value.contextMode) as AgentContextMode,
    ...(parsedExecution === undefined ? {} : { execution: parsedExecution }),
    authority: Object.freeze({ capabilities, toolVersionIds, workspaceGrantIds, environmentIds }),
    budget: Object.freeze(parsedBudget),
    outputRoute: route,
    lifecycle: Object.freeze({
      state: lifecycle.state,
      createdAt: parseTimestamp(lifecycle.createdAt, "agent projection creation time"),
      updatedAt: parseTimestamp(lifecycle.updatedAt, "agent projection update time"),
      ...(terminalAt === undefined ? {} : { terminalAt }),
      ...(terminalReason === undefined ? {} : { terminalReason }),
    }),
    activeChildCount: parseCount(value.activeChildCount, "active child count"),
    terminalChildCount: parseCount(value.terminalChildCount, "terminal child count"),
  });
}

function parseTask(value: unknown): AgentRuntimeTaskProjection {
  assertDomain(isRecord(value), "invalid_argument", "Invalid task runtime projection.");
  assertDomain(isString(value.id) && isString(value.objective), "invalid_argument", "Task projection ID and objective are required.");
  assertDomain(isOneOf(TASK_STATES, value.state), "invalid_argument", "Unknown task projection state.");
  const dependencies = parseStringArray(value.dependencyIds, "task dependency IDs") as readonly TaskId[];
  assertDomain(isRecord(value.dependencySummary), "invalid_argument", "Task dependency summary is required.");
  const dependencySummary = Object.freeze({
    total: parseCount(value.dependencySummary.total, "task dependency total"),
    completed: parseCount(value.dependencySummary.completed, "task dependency completed count"),
    pending: parseCount(value.dependencySummary.pending, "task dependency pending count"),
  });
  assertDomain(dependencySummary.total === dependencies.length && dependencySummary.completed + dependencySummary.pending === dependencySummary.total, "invalid_argument", "Task dependency summary is inconsistent.");
  assertDomain(isString(value.createdAt) && isString(value.updatedAt), "invalid_argument", "Task projection timestamps are required.");
  assertIsoTimestamp(value.createdAt, "task projection creation time");
  assertIsoTimestamp(value.updatedAt, "task projection update time");
  assertDomain(
    Array.isArray(value.resourceClaims),
    "invalid_argument",
    "Invalid task resource claims projection.",
  );
  const resourceClaims = Object.freeze(
    value.resourceClaims.map((claim) => {
      assertDomain(
        isRecord(claim) &&
          isString(claim.handle) &&
          (claim.access === "read" || claim.access === "write"),
        "invalid_argument",
        "Invalid task resource claim projection.",
      );
      return Object.freeze({
        handle: assertNonBlank(claim.handle, "task resource handle", 4_096),
        access: claim.access,
      });
    }),
  );
  const terminalReason = parseOptionalString(
    value.terminalReason,
    "task terminal reason",
  );
  return Object.freeze({
    id: value.id as TaskId,
    objective: assertNonBlank(value.objective, "task objective", 8_000),
    dependencyIds: dependencies,
    dependencySummary,
    requiredCapabilities: parseStringArray(value.requiredCapabilities, "task required capabilities") as readonly KernelCapability[],
    requiredToolVersionIds: parseStringArray(value.requiredToolVersionIds, "task required tool versions"),
    resourceClaims,
    ...(value.assignedAgentId === undefined ? {} : { assignedAgentId: assertNonBlank(String(value.assignedAgentId), "task assigned agent ID", 256) as AgentInstanceId }),
    state: value.state,
    ...(value.resultId === undefined ? {} : { resultId: assertNonBlank(String(value.resultId), "task result ID", 256) as AgentResultId }),
    ...(terminalReason === undefined ? {} : { terminalReason }),
    createdAt: parseTimestamp(value.createdAt, "task projection creation time"),
    updatedAt: parseTimestamp(value.updatedAt, "task projection update time"),
    schedulerEligible: value.schedulerEligible === true,
  });
}

function parseLease(value: unknown): AgentRuntimeLeaseProjection {
  assertDomain(isRecord(value), "invalid_argument", "Invalid lease runtime projection.");
  assertDomain(
    isString(value.taskId) && isString(value.ownerAgentId),
    "invalid_argument",
    "Lease task and owner IDs are required.",
  );
  assertDomain(
    isString(value.workerIncarnationId),
    "invalid_argument",
    "Lease worker incarnation is required.",
  );
  assertDomain(
    isOneOf(["active", "released", "expired"] as const, value.status),
    "invalid_argument",
    "Unknown lease projection status.",
  );
  const releasedAt = parseOptionalTimestamp(
    value.releasedAt,
    "lease release time",
  );
  const releaseReason = parseOptionalString(
    value.releaseReason,
    "lease release reason",
  );
  assertDomain(
    typeof value.expiredAtProjectionTime === "boolean",
    "invalid_argument",
    "Lease expiry projection flag must be boolean.",
  );
  return Object.freeze({
    taskId: assertNonBlank(value.taskId, "lease task ID", 256) as TaskId,
    ownerAgentId: assertNonBlank(
      value.ownerAgentId,
      "lease owner agent ID",
      256,
    ) as AgentInstanceId,
    workerIncarnationId: assertNonBlank(
      value.workerIncarnationId,
      "lease worker incarnation ID",
      256,
    ),
    leaseEpoch: parseCount(value.leaseEpoch, "lease epoch"),
    acquiredAt: parseTimestamp(value.acquiredAt, "lease acquisition time"),
    expiresAt: parseTimestamp(value.expiresAt, "lease expiry time"),
    lastHeartbeatAt: parseTimestamp(
      value.lastHeartbeatAt,
      "lease heartbeat time",
    ),
    acquiredAtRevision: parseCount(
      value.acquiredAtRevision,
      "lease acquisition revision",
    ),
    status: value.status,
    expiredAtProjectionTime: value.expiredAtProjectionTime,
    ...(releasedAt === undefined ? {} : { releasedAt }),
    ...(releaseReason === undefined ? {} : { releaseReason }),
  });
}

function parseCoordination(
  value: unknown,
): AgentRuntimeCoordinationProjection {
  assertDomain(
    isRecord(value),
    "invalid_argument",
    "Invalid coordination runtime projection.",
  );
  assertDomain(
    Array.isArray(value.leases),
    "invalid_argument",
    "Coordination lease projections must be an array.",
  );
  const leases = Object.freeze(value.leases.map(parseLease));
  const projection = Object.freeze({
    revision: parseCount(value.revision, "coordination revision"),
    activeLeaseCount: parseCount(
      value.activeLeaseCount,
      "active coordination lease count",
    ),
    releasedLeaseCount: parseCount(
      value.releasedLeaseCount,
      "released coordination lease count",
    ),
    expiredLeaseCount: parseCount(
      value.expiredLeaseCount,
      "expired coordination lease count",
    ),
    completionReceiptCount: parseCount(
      value.completionReceiptCount,
      "completion receipt count",
    ),
    leases,
  });
  assertDomain(
    projection.activeLeaseCount ===
      leases.filter((lease) => lease.status === "active").length,
    "invalid_argument",
    "Active coordination lease count is inconsistent.",
  );
  assertDomain(
    projection.releasedLeaseCount ===
      leases.filter((lease) => lease.status === "released").length,
    "invalid_argument",
    "Released coordination lease count is inconsistent.",
  );
  assertDomain(
    projection.expiredLeaseCount ===
      leases.filter(
        (lease) => lease.status === "expired" || lease.expiredAtProjectionTime,
      ).length,
    "invalid_argument",
    "Expired coordination lease count is inconsistent.",
  );
  return projection;
}

function parseMailboxMessage(
  value: unknown,
): AgentRuntimeMailboxMessageProjection {
  assertDomain(
    isRecord(value),
    "invalid_argument",
    "Invalid mailbox message runtime projection.",
  );
  assertDomain(
    isString(value.id) &&
      isString(value.senderAgentId) &&
      isString(value.recipientAgentId),
    "invalid_argument",
    "Mailbox message identity is incomplete.",
  );
  assertDomain(
    isOneOf(MAILBOX_KINDS, value.kind),
    "invalid_argument",
    "Unknown mailbox message kind.",
  );
  assertDomain(
    isOneOf(MAILBOX_SENSITIVITIES, value.sensitivity),
    "invalid_argument",
    "Unknown mailbox message sensitivity.",
  );
  assertDomain(
    typeof value.expiredAtProjectionTime === "boolean",
    "invalid_argument",
    "Mailbox expiry projection flag must be boolean.",
  );
  const expiresAt = parseOptionalTimestamp(
    value.expiresAt,
    "mailbox message expiry time",
  );
  const acknowledgedAt = parseOptionalTimestamp(
    value.acknowledgedAt,
    "mailbox message acknowledgement time",
  );
  const createdAt = parseTimestamp(
    value.createdAt,
    "mailbox message creation time",
  );
  if (expiresAt !== undefined) {
    assertDomain(
      Date.parse(expiresAt) > Date.parse(createdAt),
      "invalid_argument",
      "Mailbox expiry must follow creation.",
    );
  }
  assertDomain(
    isString(value.contentHash) && isString(value.deliveryKeyHash),
    "invalid_argument",
    "Mailbox message hashes are required.",
  );
  return Object.freeze({
    id: assertNonBlank(value.id, "mailbox projection message ID", 256) as AgentMailboxMessageId,
    senderAgentId: assertNonBlank(
      value.senderAgentId,
      "mailbox sender agent ID",
      256,
    ) as AgentInstanceId,
    recipientAgentId: assertNonBlank(
      value.recipientAgentId,
      "mailbox recipient agent ID",
      256,
    ) as AgentInstanceId,
    ...(value.taskId === undefined
      ? {}
      : {
          taskId: assertNonBlank(
            String(value.taskId),
            "mailbox task ID",
            256,
          ) as TaskId,
        }),
    kind: value.kind,
    sensitivity: value.sensitivity,
    contentHash: assertSha256(value.contentHash, "mailbox content hash"),
    deliveryKeyHash: assertSha256(
      value.deliveryKeyHash,
      "mailbox delivery-key hash",
    ),
    deliverySequence: parseCount(
      value.deliverySequence,
      "mailbox delivery sequence",
    ),
    createdAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(acknowledgedAt === undefined ? {} : { acknowledgedAt }),
    expiredAtProjectionTime: value.expiredAtProjectionTime,
    payloadBytes: parseCount(value.payloadBytes, "mailbox payload bytes"),
  });
}

function parseMailbox(value: unknown): AgentRuntimeMailboxProjection {
  assertDomain(isRecord(value), "invalid_argument", "Invalid mailbox runtime projection.");
  assertDomain(
    Array.isArray(value.messages),
    "invalid_argument",
    "Mailbox message projections must be an array.",
  );
  assertDomain(isRecord(value.byKind), "invalid_argument", "Mailbox kind counts are required.");
  assertDomain(
    isRecord(value.bySensitivity),
    "invalid_argument",
    "Mailbox sensitivity counts are required.",
  );
  const messages = Object.freeze(value.messages.map(parseMailboxMessage));
  const byKind = createKindCounts();
  const bySensitivity = createSensitivityCounts();
  for (const message of messages) {
    byKind[message.kind] += 1;
    bySensitivity[message.sensitivity] += 1;
  }
  for (const kind of MAILBOX_KINDS) {
    assertDomain(
      parseCount(value.byKind[kind], `mailbox ${kind} count`) === byKind[kind],
      "invalid_argument",
      "Mailbox kind count is inconsistent.",
      { kind },
    );
  }
  for (const sensitivity of MAILBOX_SENSITIVITIES) {
    assertDomain(
      parseCount(
        value.bySensitivity[sensitivity],
        `mailbox ${sensitivity} count`,
      ) === bySensitivity[sensitivity],
      "invalid_argument",
      "Mailbox sensitivity count is inconsistent.",
      { sensitivity },
    );
  }
  const acknowledgedCount = messages.filter(
    (message) => message.acknowledgedAt !== undefined,
  ).length;
  const expiredCount = messages.filter(
    (message) => message.expiredAtProjectionTime,
  ).length;
  const unreadCount = messages.filter(
    (message) =>
      message.acknowledgedAt === undefined && !message.expiredAtProjectionTime,
  ).length;
  const projection = Object.freeze({
    maximumMessages: parseCount(
      value.maximumMessages,
      "mailbox maximum messages",
    ),
    maximumBytes: parseCount(value.maximumBytes, "mailbox maximum bytes"),
    messageCount: parseCount(value.messageCount, "mailbox message count"),
    acknowledgedCount: parseCount(
      value.acknowledgedCount,
      "mailbox acknowledged count",
    ),
    unreadCount: parseCount(value.unreadCount, "mailbox unread count"),
    expiredCount: parseCount(value.expiredCount, "mailbox expired count"),
    byKind: freezeRecord(byKind),
    bySensitivity: freezeRecord(bySensitivity),
    messages,
  });
  assertDomain(
    projection.messageCount === messages.length &&
      projection.acknowledgedCount === acknowledgedCount &&
      projection.unreadCount === unreadCount &&
      projection.expiredCount === expiredCount,
    "invalid_argument",
    "Mailbox aggregate counts are inconsistent.",
  );
  return projection;
}

/** Validate a projection received from persistence or IPC before rendering it. */
export function assertAgentRuntimeProjection(value: AgentRuntimeProjection): void {
  assertDomain(value.schemaVersion === AGENT_RUNTIME_ADAPTER_SCHEMA_VERSION, "invalid_argument", "Unsupported agent runtime projection version.");
  assertIsoTimestamp(value.generatedAt, "agent runtime projection generation time");
  assertNonBlank(value.rootRunId, "agent runtime root run ID", 256);
  assertNonBlank(value.branchId, "agent runtime branch ID", 256);
  assertDomain(value.graph.agentCount === value.graph.agents.length, "invalid_argument", "Agent projection count is inconsistent.");
  assertDomain(value.tasks.taskCount === value.tasks.tasks.length, "invalid_argument", "Task projection count is inconsistent.");
  for (const agent of value.graph.agents) {
    assertNonBlank(agent.identity.id, "agent projection ID", 256);
    assertNonBlank(agent.identity.label, "agent projection label", 160);
    assertDomain(AGENT_STATES.includes(agent.lifecycle.state), "invalid_argument", "Unknown agent projection state.");
  }
  for (const task of value.tasks.tasks) {
    assertNonBlank(task.id, "task projection ID", 256);
    assertDomain(TASK_STATES.includes(task.state), "invalid_argument", "Unknown task projection state.");
  }
  if (value.coordination !== undefined) {
    assertNonNegativeCount(value.coordination.revision, "coordination revision");
    for (const lease of value.coordination.leases) {
      assertNonBlank(lease.taskId, "lease task ID", 256);
      assertNonBlank(lease.ownerAgentId, "lease owner agent ID", 256);
      assertIsoTimestamp(lease.expiresAt, "lease expiry time");
    }
  }
  if (value.mailbox !== undefined) {
    assertNonNegativeCount(value.mailbox.maximumMessages, "mailbox maximum messages");
    assertNonNegativeCount(value.mailbox.maximumBytes, "mailbox maximum bytes");
    for (const message of value.mailbox.messages) {
      assertNonBlank(message.id, "mailbox projection message ID", 256);
      assertSha256(message.contentHash, "mailbox projection content hash");
      assertSha256(message.deliveryKeyHash, "mailbox projection delivery key hash");
    }
  }
}

/** JSON serialization is intentionally projection-only; mailbox payloads are not serialized here. */
export function serializeAgentRuntimeProjection(projection: AgentRuntimeProjection): string {
  assertAgentRuntimeProjection(projection);
  return JSON.stringify(projection);
}

export function deserializeAgentRuntimeProjection(input: string | unknown): AgentRuntimeProjection {
  let value: unknown;
  try {
    value = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  } catch {
    throw new Error("Invalid agent runtime projection JSON.");
  }
  assertDomain(isRecord(value), "invalid_argument", "Agent runtime projection must be an object.");
  assertDomain(value.schemaVersion === AGENT_RUNTIME_ADAPTER_SCHEMA_VERSION, "invalid_argument", "Unsupported agent runtime projection version.");
  assertDomain(isString(value.rootRunId) && isString(value.branchId) && isString(value.generatedAt), "invalid_argument", "Agent runtime projection identity is incomplete.");
  assertDomain(isRecord(value.graph) && isRecord(value.tasks), "invalid_argument", "Agent runtime projection graph and tasks are required.");
  const graph = value.graph;
  const tasks = value.tasks;
  assertDomain(Array.isArray(graph.agents) && Array.isArray(tasks.tasks), "invalid_argument", "Agent runtime projection collections are required.");
  const agents = Object.freeze(graph.agents.map(parseAgent));
  const parsedTasks = Object.freeze(tasks.tasks.map(parseTask));
  const byState = createTaskCounts();
  for (const task of parsedTasks) byState[task.state] += 1;
  const coordination =
    value.coordination === undefined
      ? undefined
      : parseCoordination(value.coordination);
  const mailbox =
    value.mailbox === undefined ? undefined : parseMailbox(value.mailbox);
  const parsed: AgentRuntimeProjection = {
    schemaVersion: AGENT_RUNTIME_ADAPTER_SCHEMA_VERSION,
    rootRunId: value.rootRunId as RunId,
    branchId: value.branchId as BranchId,
    generatedAt: parseTimestamp(
      value.generatedAt,
      "agent runtime projection generation time",
    ),
    graph: Object.freeze({
      maximumAgents: parseCount(graph.maximumAgents, "maximum agents"),
      maximumDepth: parseCount(graph.maximumDepth, "maximum depth"),
      agentCount: parseCount(graph.agentCount, "agent count"),
      activeAgentCount: parseCount(graph.activeAgentCount, "active agent count"),
      terminalAgentCount: parseCount(graph.terminalAgentCount, "terminal agent count"),
      agents,
    }),
    tasks: Object.freeze({
      taskCount: parseCount(tasks.taskCount, "task count"),
      byState: freezeRecord(byState),
      readyTaskIds: parseStringArray(tasks.readyTaskIds, "ready task IDs") as readonly TaskId[],
      runningTaskIds: parseStringArray(tasks.runningTaskIds, "running task IDs") as readonly TaskId[],
      blockedTaskIds: parseStringArray(tasks.blockedTaskIds, "blocked task IDs") as readonly TaskId[],
      tasks: parsedTasks,
    }),
    ...(coordination === undefined ? {} : { coordination }),
    ...(mailbox === undefined ? {} : { mailbox }),
  };
  assertAgentRuntimeProjection(parsed);
  return Object.freeze(parsed);
}
