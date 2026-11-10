import { describe, expect, it } from "vitest";

import {
  addAgentInstance,
  createAgentGraph,
  transitionAgent,
} from "../domain/agent-graph";
import type {
  AgentInstanceId,
  AgentResultId,
  ToolVersionId,
} from "../domain/agent-tool-contract-shared";
import type {
  BranchId,
  ContextSnapshotId,
  ExecutionEnvironmentId,
  RunId,
  TaskId,
  WorkspaceGrantId,
} from "../domain/ids";
import type { AgentResourceBudget } from "../domain/agent-graph";
import {
  createOmniaAgentOrchestrationRuntime,
  deserializeOmniaAgentOrchestrationRuntime,
} from "./omnia-agent-orchestration-runtime";

const id = <T extends string>(value: string) => value as T;
const sha = (value: string) => value.repeat(64);
const runId = id<RunId>("01K2H000000000000000001001");
const branchId = id<BranchId>("01K2H000000000000000001002");
const contextSnapshotId = id<ContextSnapshotId>("01K2H000000000000000001003");
const environmentId = id<ExecutionEnvironmentId>("01K2H000000000000000001004");
const workspaceGrantId = id<WorkspaceGrantId>("01K2H000000000000000001005");
const toolVersionId = id<ToolVersionId>("01K2H000000000000000001006");
const agentId = id<AgentInstanceId>("01K2H000000000000000001007");
const taskId = id<TaskId>("01K2H000000000000000001008");
const resultId = id<AgentResultId>("01K2H000000000000000001009");
const t1 = "2026-10-17T00:00:01.000Z";
const t2 = "2026-10-17T00:00:02.000Z";
const t3 = "2026-10-17T00:00:03.000Z";
const t4 = "2026-10-17T00:00:04.000Z";
const t5 = "2026-10-17T00:00:05.000Z";
const t6 = "2026-10-17T00:00:06.000Z";
const t7 = "2026-10-17T00:00:07.000Z";
const t8 = "2026-10-17T00:00:08.000Z";

const budget: AgentResourceBudget = {
  maximumInputTokens: 10_000,
  maximumOutputTokens: 10_000,
  maximumCostMicrounits: 100_000,
  maximumWallClockMs: 30_000,
  maximumToolInvocations: 10,
  maximumChildren: 2,
  maximumMutationOperations: 10,
  maximumMailboxBytes: 10_000,
};

function runningGraph() {
  let graph = createAgentGraph({
    rootRunId: runId,
    branchId,
    maximumAgents: 4,
    maximumDepth: 2,
  });
  graph = addAgentInstance(graph, {
    id: agentId,
    spawnOrdinal: 0,
    role: "orchestrator",
    label: "Root orchestrator",
    objective: "Coordinate the runtime orchestration test.",
    completionContractHash: sha("a"),
    templateVersionHash: sha("b"),
    providerPolicyHash: sha("c"),
    contextMode: "fresh",
    contextSnapshotId,
    runId,
    executionEnvironmentId: environmentId,
    executionMode: "persistent",
    authority: {
      capabilities: ["pure_compute", "read_workspace", "write_workspace"],
      toolVersionIds: [toolVersionId],
      workspaceGrantIds: [workspaceGrantId],
      environmentIds: [environmentId],
    },
    budget,
    outputRoute: { kind: "fixed", branchId },
    createdAt: t1,
  });
  graph = transitionAgent(graph, { agentId, to: "queued", now: t2 });
  return transitionAgent(graph, { agentId, to: "running", now: t3 });
}

function runtime() {
  return createOmniaAgentOrchestrationRuntime({ graph: runningGraph() })
    .addTask({
      id: taskId,
      objective: "Run a bounded orchestration task.",
      dependencyIds: [],
      requiredCapabilities: ["read_workspace"],
      requiredToolVersionIds: [toolVersionId],
      resourceClaims: [{ handle: "workspace:source", access: "read" }],
      createdAt: t4,
    })
    .markTaskReady(taskId, t5)
    .assignTask(taskId, agentId, t6)
    .startTask(taskId, t7);
}

describe("Omnia agent orchestration runtime", () => {
  it("composes task readiness, assignment, start, lease, and completion", () => {
    const prepared = runtime();
    expect(prepared.summary()).toMatchObject({
      taskCount: 1,
      readyTaskIds: [],
      runningTaskIds: [taskId],
      revision: 0,
    });

    const claimed = prepared.claimLease({
      expectedRevision: 0,
      taskId,
      ownerAgentId: agentId,
      workerIncarnationId: "worker-1",
      now: t8,
      expiresAt: "2026-10-17T00:00:20.000Z",
    });
    expect(claimed.lease.leaseEpoch).toBe(1);

    const completed = claimed.runtime.completeLease({
      expectedRevision: 1,
      taskId,
      ownerAgentId: agentId,
      workerIncarnationId: "worker-1",
      leaseEpoch: 1,
      now: "2026-10-17T00:00:09.000Z",
      receiptId: "receipt-1",
      outcome: "completed",
      evidenceHash: sha("d"),
      resultId,
    });
    expect(completed.runtime.taskDag.tasks[0]?.state).toBe("completed");
    expect(completed.receipt.resultId).toBe(resultId);

    const replay = completed.runtime.completeLease({
      expectedRevision: 0,
      taskId,
      ownerAgentId: agentId,
      workerIncarnationId: "worker-1",
      leaseEpoch: 1,
      now: "2026-10-17T00:00:09.000Z",
      receiptId: "receipt-1",
      outcome: "completed",
      evidenceHash: sha("d"),
      resultId,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.runtime).toBe(completed.runtime);
  });

  it("serializes, restores, and exposes resource-conflict decisions", () => {
    const first = runtime();
    const restored = deserializeOmniaAgentOrchestrationRuntime(first.serialize());
    expect(restored.serialize()).toBe(first.serialize());
    expect(restored.canRunInParallel(taskId, taskId)).toBe(true);
    expect(Object.isFrozen(restored.snapshot)).toBe(true);
    expect(Object.isFrozen(restored.taskDag.tasks)).toBe(true);
  });

  it("expires a lease without changing the task DAG", () => {
    const claimed = runtime().claimLease({
      expectedRevision: 0,
      taskId,
      ownerAgentId: agentId,
      workerIncarnationId: "worker-1",
      now: t8,
      expiresAt: "2026-10-17T00:00:10.000Z",
    });
    const expired = claimed.runtime.expireLeases(1, "2026-10-17T00:00:11.000Z");
    expect(expired.expiredLeaseEpochs).toEqual([1]);
    expect(expired.runtime.coordination.leases[0]?.status).toBe("expired");
    expect(expired.runtime.taskDag.tasks[0]?.state).toBe("running");
  });

  it("includes tasks transitioned to 'ready' via markTaskReady in readyTasks()", () => {
    const rt = createOmniaAgentOrchestrationRuntime({ graph: runningGraph() })
      .addTask({
        id: taskId,
        objective: "Check readyTasks after markTaskReady.",
        dependencyIds: [],
        requiredCapabilities: ["read_workspace"],
        requiredToolVersionIds: [toolVersionId],
        resourceClaims: [{ handle: "workspace:source", access: "read" }],
        createdAt: t4,
      })
      .markTaskReady(taskId, t5);
    expect(rt.readyTasks().map((t) => t.id)).toEqual([taskId]);
    expect(rt.summary().readyTaskIds).toEqual([taskId]);
  });
});
