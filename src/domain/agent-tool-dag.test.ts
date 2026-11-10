import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import type {
  BranchId,
  ContextSnapshotId,
  EntityId,
  ExecutionEnvironmentId,
  RunId,
  TaskId,
  WorkspaceGrantId,
} from "./ids";
import {
  acknowledgeAgentMailboxMessage,
  addAgentInstance,
  addAgentTask,
  agentTasksCanRunInParallel,
  appendAgentMailboxMessage,
  applyToolAuthorization,
  assertToolInvocationDispatchable,
  assignAgentTask,
  createAgentGraph,
  createAgentMailbox,
  createAgentResultEnvelope,
  createAgentTaskDag,
  createToolInvocation,
  createToolRegistry,
  markAgentTaskReady,
  registerToolVersion,
  resolveToolVersion,
  startAgentTask,
  startToolInvocation,
  transitionAgent,
  transitionAgentTask,
  transitionToolInvocation,
  type AgentInstanceId,
  type AppendAgentMailboxMessageInput,
  type AgentMailboxMessageId,
  type AgentResourceBudget,
  type AgentResultId,
  type ToolAuthorizationDecisionId,
  type ToolInvocationId,
  type ToolVersionId,
  type ToolVersionManifest,
} from "./agent-tool-dag";

const id = <TKind extends string>(value: string) => value as EntityId<TKind>;
const sha = (character: string) => character.repeat(64);
const t1 = "2026-08-13T00:00:01.000Z";
const t2 = "2026-08-13T00:00:02.000Z";
const t3 = "2026-08-13T00:00:03.000Z";
const runId = id<"run">("01K2H000000000000000001001") as RunId;
const branchId = id<"branch">("01K2H000000000000000001002") as BranchId;
const contextSnapshotId = id<"context-snapshot">(
  "01K2H000000000000000001003",
) as ContextSnapshotId;
const environmentId = id<"execution-environment">(
  "01K2H000000000000000001004",
) as ExecutionEnvironmentId;
const workspaceGrantId = id<"workspace-grant">(
  "01K2H000000000000000001005",
) as WorkspaceGrantId;
const toolVersionId = id<"tool-version">(
  "01K2H000000000000000001006",
) as ToolVersionId;
const rootAgentId = id<"agent-instance">(
  "01K2H000000000000000001007",
) as AgentInstanceId;
const childAgentId = id<"agent-instance">(
  "01K2H000000000000000001008",
) as AgentInstanceId;

const rootBudget: AgentResourceBudget = {
  maximumInputTokens: 100_000,
  maximumOutputTokens: 50_000,
  maximumCostMicrounits: 2_000_000,
  maximumWallClockMs: 60_000,
  maximumToolInvocations: 100,
  maximumChildren: 4,
  maximumMutationOperations: 20,
  maximumMailboxBytes: 100_000,
};

function toolManifest(
  overrides: Partial<ToolVersionManifest> = {},
): ToolVersionManifest {
  return {
    schemaVersion: 1,
    id: toolVersionId,
    canonicalName: "workspace.search",
    displayName: "Workspace search",
    version: "1.0.0",
    origin: "built-in",
    exposure: "deferred",
    manifestHash: sha("a"),
    implementationHash: sha("b"),
    inputSchemaHash: sha("c"),
    outputSchemaHash: sha("d"),
    capabilitySetHash: sha("e"),
    requiredCapabilities: ["read_workspace"],
    effects: ["workspace-read"],
    supportedEnvironments: ["persistent", "isolated"],
    limits: {
      maximumInputBytes: 1_000_000,
      maximumOutputBytes: 1_000_000,
      defaultTimeoutMs: 30_000,
    },
    cancellation: "cooperative",
    idempotency: "none",
    registeredAt: t1,
    ...overrides,
  };
}

function registry() {
  return registerToolVersion(createToolRegistry(), toolManifest());
}

function rootAgentInput() {
  return {
    id: rootAgentId,
    spawnOrdinal: 0,
    role: "orchestrator" as const,
    label: "Main orchestrator",
    objective:
      "Coordinate a bounded implementation and independent verification pass.",
    completionContractHash: sha("f"),
    templateVersionHash: sha("1"),
    providerPolicyHash: sha("2"),
    contextMode: "fork" as const,
    contextSnapshotId,
    runId,
    executionEnvironmentId: environmentId,
    executionMode: "persistent" as const,
    authority: {
      capabilities: [
        "pure_compute",
        "read_workspace",
        "write_workspace",
      ] as const,
      toolVersionIds: [toolVersionId],
      workspaceGrantIds: [workspaceGrantId],
      environmentIds: [environmentId],
    },
    budget: rootBudget,
    outputRoute: { kind: "fixed" as const, branchId },
    createdAt: t1,
  };
}

function runningGraph() {
  let graph = createAgentGraph({
    rootRunId: runId,
    branchId,
    maximumAgents: 8,
    maximumDepth: 3,
  });
  graph = addAgentInstance(graph, rootAgentInput());
  graph = transitionAgent(graph, {
    agentId: rootAgentId,
    to: "queued",
    now: t2,
  });
  return transitionAgent(graph, {
    agentId: rootAgentId,
    to: "running",
    now: t3,
  });
}

function childInput() {
  return {
    id: childAgentId,
    parentAgentId: rootAgentId,
    spawnOrdinal: 1,
    role: "reviewer" as const,
    label: "Independent reviewer",
    objective:
      "Review the bounded contract and return evidence-backed findings.",
    completionContractHash: sha("3"),
    templateVersionHash: sha("4"),
    providerPolicyHash: sha("5"),
    contextMode: "fresh" as const,
    contextSnapshotId,
    runId,
    executionEnvironmentId: environmentId,
    executionMode: "persistent" as const,
    authority: {
      capabilities: ["pure_compute", "read_workspace"] as const,
      toolVersionIds: [toolVersionId],
      workspaceGrantIds: [workspaceGrantId],
      environmentIds: [environmentId],
    },
    budget: { ...rootBudget, maximumChildren: 1, maximumMutationOperations: 1 },
    outputRoute: { kind: "fixed" as const, branchId },
    createdAt: t3,
  };
}

describe("tool registry and invocation lifecycle", () => {
  it("requires namespace-qualified names, explicit effect capabilities, and reserved ownership", () => {
    expect(() =>
      registerToolVersion(
        createToolRegistry(),
        toolManifest({ canonicalName: "search" }),
      ),
    ).toThrowError(DomainError);
    expect(() =>
      registerToolVersion(
        createToolRegistry(),
        toolManifest({
          canonicalName: "extension.write",
          origin: "signed-extension",
          effects: ["workspace-write"],
          requiredCapabilities: ["read_workspace"],
        }),
      ),
    ).toThrowError(DomainError);
    expect(() =>
      registerToolVersion(
        createToolRegistry(),
        toolManifest({
          canonicalName: "kernel.shadow",
          origin: "signed-extension",
        }),
      ),
    ).toThrowError(DomainError);
  });

  it("keeps harness-only tools out of model exposure and disables exact versions deterministically", () => {
    const harnessTool = toolManifest({ exposure: "harness-only" });
    const tools = registerToolVersion(createToolRegistry(), harnessTool);
    expect(() =>
      resolveToolVersion(tools, toolVersionId, "model", t2),
    ).toThrowError(DomainError);
    expect(resolveToolVersion(tools, toolVersionId, "harness", t2).id).toBe(
      toolVersionId,
    );

    const disabled = registerToolVersion(
      createToolRegistry(),
      toolManifest({ disabledAt: t2 }),
    );
    expect(() =>
      resolveToolVersion(disabled, toolVersionId, "harness", t2),
    ).toThrowError(DomainError);
  });

  it("binds exact authorization and keeps outcome-unknown terminal and non-retryable", () => {
    const graph = runningGraph();
    const invocationId = id<"tool-invocation">(
      "01K2H000000000000000001009",
    ) as ToolInvocationId;
    const invocation = createToolInvocation(graph, registry(), {
      id: invocationId,
      agentId: rootAgentId,
      runId,
      branchId,
      environmentId,
      toolVersionId,
      operationType: "workspace.search",
      operationArgumentsHash: sha("6"),
      capabilitySetHash: sha("e"),
      createdAt: t3,
    });
    expect(() =>
      applyToolAuthorization(
        invocation,
        {
          id: id<"tool-authorization-decision">(
            "01K2H000000000000000001010",
          ) as ToolAuthorizationDecisionId,
          decision: "allow",
          invocationId,
          toolVersionId,
          toolVersionHash: sha("a"),
          operationArgumentsHash: sha("7"),
          capabilitySetHash: sha("e"),
          policyVersionHash: sha("8"),
          environmentId,
          approvalReceiptIds: [],
          evaluatedAt: t3,
          expiresAt: "2026-08-13T01:00:00.000Z",
        },
        t3,
      ),
    ).toThrowError(DomainError);

    const ready = applyToolAuthorization(
      invocation,
      {
        id: id<"tool-authorization-decision">(
          "01K2H000000000000000001011",
        ) as ToolAuthorizationDecisionId,
        decision: "allow",
        invocationId,
        toolVersionId,
        toolVersionHash: sha("a"),
        operationArgumentsHash: sha("6"),
        capabilitySetHash: sha("e"),
        policyVersionHash: sha("8"),
        environmentId,
        approvalReceiptIds: [],
        evaluatedAt: t3,
        expiresAt: "2026-08-13T01:00:00.000Z",
      },
      t3,
    );
    expect(() =>
      assertToolInvocationDispatchable(ready, {
        agentGraph: graph,
        registry: registry(),
        now: t3,
      }),
    ).not.toThrow();
    const expiredAt = "2026-08-13T02:00:00.000Z";
    expect(() =>
      assertToolInvocationDispatchable(ready, {
        agentGraph: graph,
        registry: registry(),
        now: expiredAt,
      }),
    ).toThrowError(DomainError);
    const running = startToolInvocation(ready, {
      agentGraph: graph,
      registry: registry(),
      now: t3,
    });
    const unknown = transitionToolInvocation(running, {
      to: "outcome-unknown",
      now: t3,
      terminalReason:
        "Executor disconnected after the operation may have started.",
    });
    expect(unknown.state).toBe("outcome-unknown");
    expect(() =>
      transitionToolInvocation(unknown, {
        to: "completed",
        now: t3,
        outputHash: sha("f"),
        terminalReason: "A second terminal outcome is invalid.",
      }),
    ).toThrowError(DomainError);
  });
});

describe("durable agent graph and task DAG", () => {
  it("lets child agents narrow authority and budget but never widen them", () => {
    const graph = runningGraph();
    const withChild = addAgentInstance(graph, childInput());
    expect(withChild.agents.at(-1)).toMatchObject({
      id: childAgentId,
      depth: 1,
      state: "created",
    });
    expect(() =>
      addAgentInstance(graph, {
        ...childInput(),
        authority: {
          ...childInput().authority,
          capabilities: ["pure_compute", "read_workspace", "request_admin"],
        },
      }),
    ).toThrowError(DomainError);
    expect(() =>
      addAgentInstance(graph, {
        ...childInput(),
        budget: {
          ...rootBudget,
          maximumWallClockMs: rootBudget.maximumWallClockMs + 1,
        },
      }),
    ).toThrowError(DomainError);
  });

  it("keeps the captured output branch fixed unless a separate authorization is supplied", () => {
    const graph = runningGraph();
    expect(() =>
      addAgentInstance(graph, {
        ...childInput(),
        outputRoute: {
          kind: "fixed",
          branchId: id<"branch">("01K2H000000000000000001099") as BranchId,
        },
      }),
    ).toThrowError(DomainError);
    expect(() =>
      addAgentInstance(graph, {
        ...childInput(),
        outputRoute: { kind: "follow-active", authorizationHash: "not-a-hash" },
      }),
    ).toThrowError(DomainError);
  });

  it("does not let a parent become terminal while a child process remains active", () => {
    let graph = addAgentInstance(runningGraph(), childInput());
    graph = transitionAgent(graph, {
      agentId: childAgentId,
      to: "queued",
      now: t3,
    });
    graph = transitionAgent(graph, {
      agentId: childAgentId,
      to: "running",
      now: t3,
    });
    for (const to of ["completed", "failed", "cancelled"] as const) {
      expect(() =>
        transitionAgent(graph, {
          agentId: rootAgentId,
          to,
          now: t3,
          terminalReason: `Parent attempted to become ${to}.`,
        }),
      ).toThrowError(DomainError);
    }
  });

  it("keeps task dependencies independent from process assignment and enforces authority at scheduling", () => {
    let graph = addAgentInstance(runningGraph(), childInput());
    graph = transitionAgent(graph, {
      agentId: childAgentId,
      to: "queued",
      now: t3,
    });
    const taskOneId = id<"task">("01K2H000000000000000001020") as TaskId;
    const taskTwoId = id<"task">("01K2H000000000000000001021") as TaskId;
    let dag = createAgentTaskDag(runId);
    dag = addAgentTask(dag, {
      id: taskOneId,
      objective: "Inspect the source contract.",
      dependencyIds: [],
      requiredCapabilities: ["read_workspace"],
      requiredToolVersionIds: [toolVersionId],
      resourceClaims: [{ handle: "workspace-grant:source", access: "read" }],
      createdAt: t1,
    });
    dag = addAgentTask(dag, {
      id: taskTwoId,
      objective: "Write the verified result.",
      dependencyIds: [taskOneId],
      requiredCapabilities: ["write_workspace"],
      requiredToolVersionIds: [toolVersionId],
      resourceClaims: [{ handle: "workspace-grant:source", access: "write" }],
      createdAt: t1,
    });
    dag = markAgentTaskReady(dag, taskOneId, t2);
    dag = assignAgentTask(dag, graph, taskOneId, childAgentId, t2);
    let runningGraphForTask = transitionAgent(graph, {
      agentId: childAgentId,
      to: "running",
      now: t3,
    });
    dag = startAgentTask(dag, runningGraphForTask, taskOneId, t3);
    dag = transitionAgentTask(dag, {
      taskId: taskOneId,
      to: "completed",
      now: t3,
      resultId: id<"agent-result">(
        "01K2H000000000000000001022",
      ) as AgentResultId,
      terminalReason: "Inspection completed.",
    });
    dag = markAgentTaskReady(dag, taskTwoId, t3);
    expect(() =>
      assignAgentTask(dag, graph, taskTwoId, childAgentId, t3),
    ).toThrowError(DomainError);
    expect(agentTasksCanRunInParallel(dag.tasks[0]!, dag.tasks[1]!)).toBe(
      false,
    );
  });

  it("requires a task-bound tool call to match the exact active task assignment", () => {
    const taskId = id<"task">("01K2H000000000000000001024") as TaskId;
    const graph = runningGraph();
    let dag = createAgentTaskDag(runId);
    dag = addAgentTask(dag, {
      id: taskId,
      objective: "Search the captured workspace scope.",
      dependencyIds: [],
      requiredCapabilities: ["read_workspace"],
      requiredToolVersionIds: [toolVersionId],
      resourceClaims: [{ handle: "workspace-grant:source", access: "read" }],
      createdAt: t1,
    });
    dag = markAgentTaskReady(dag, taskId, t2);
    dag = assignAgentTask(dag, graph, taskId, rootAgentId, t2);
    const invocationInput = {
      id: id<"tool-invocation">(
        "01K2H000000000000000001025",
      ) as ToolInvocationId,
      agentId: rootAgentId,
      taskId,
      runId,
      branchId,
      environmentId,
      toolVersionId,
      operationType: "workspace.search",
      operationArgumentsHash: sha("c"),
      capabilitySetHash: sha("e"),
      createdAt: t3,
    };
    expect(() =>
      createToolInvocation(graph, registry(), invocationInput, "model", dag),
    ).toThrowError(DomainError);
    dag = startAgentTask(dag, graph, taskId, t3);
    expect(
      createToolInvocation(graph, registry(), invocationInput, "model", dag)
        .taskId,
    ).toBe(taskId);
    dag = transitionAgentTask(dag, {
      taskId,
      to: "blocked",
      now: t3,
    });
    dag = markAgentTaskReady(dag, taskId, t3);
    expect(dag.tasks[0]?.state).toBe("ready");
    expect(dag.tasks[0]?.assignedAgentId).toBeUndefined();
  });
});

describe("transactional agent mailbox and structured handoff", () => {
  function graphWithChild() {
    return addAgentInstance(runningGraph(), childInput());
  }

  function mailboxMessage(
    overrides: Partial<AppendAgentMailboxMessageInput> = {},
  ): AppendAgentMailboxMessageInput {
    return {
      id: id<"agent-mailbox-message">(
        "01K2H000000000000000001030",
      ) as AgentMailboxMessageId,
      senderAgentId: childAgentId,
      recipientAgentId: rootAgentId,
      kind: "finding",
      authority: "agent",
      contentHash: sha("9"),
      deliveryKeyHash: sha("0"),
      sensitivity: "normal",
      payload: { summary: "The contract is internally consistent." },
      createdAt: t3,
      ...overrides,
    };
  }

  it("deduplicates exact lost delivery and conflicts on changed content", () => {
    const empty = createAgentMailbox(10, 10_000);
    const first = appendAgentMailboxMessage(
      empty,
      graphWithChild(),
      mailboxMessage(),
    );
    const replay = appendAgentMailboxMessage(
      first.mailbox,
      graphWithChild(),
      mailboxMessage({
        id: id<"agent-mailbox-message">(
          "01K2H000000000000000001031",
        ) as AgentMailboxMessageId,
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.mailbox.messages).toHaveLength(1);
    expect(replay.message.deliverySequence).toBe(1);
    expect(() =>
      appendAgentMailboxMessage(
        first.mailbox,
        graphWithChild(),
        mailboxMessage({ contentHash: sha("a") }),
      ),
    ).toThrowError(DomainError);
  });

  it("does not allow an agent message to claim user authority and only lets the recipient acknowledge", () => {
    const empty = createAgentMailbox(10, 10_000);
    expect(() =>
      appendAgentMailboxMessage(empty, graphWithChild(), {
        ...mailboxMessage(),
        authority: "user" as never,
      }),
    ).toThrowError(DomainError);
    const first = appendAgentMailboxMessage(
      empty,
      graphWithChild(),
      mailboxMessage(),
    );
    expect(() =>
      acknowledgeAgentMailboxMessage(
        first.mailbox,
        first.message.id,
        childAgentId,
        t3,
      ),
    ).toThrowError(DomainError);
    const acknowledged = acknowledgeAgentMailboxMessage(
      first.mailbox,
      first.message.id,
      rootAgentId,
      t3,
    );
    expect(acknowledged.messages[0]?.acknowledgedAt).toBe(t3);
  });

  it("returns a bounded structured handoff instead of copying raw child transcripts", () => {
    const result = createAgentResultEnvelope({
      schemaVersion: 1,
      id: id<"agent-result">("01K2H000000000000000001040") as AgentResultId,
      agentId: childAgentId,
      taskId: id<"task">("01K2H000000000000000001041") as TaskId,
      summary: "The denial-path matrix passed for the contract slice.",
      findings: [
        {
          claim:
            "Child authority remains a strict subset of the parent ceiling.",
          evidenceIds: ["test:child-authority-narrows"],
          confidence: "high",
        },
      ],
      artifactIds: [],
      inspectedResourceHandles: ["workspace-grant:source"],
      risks: ["Native persistence is not wired yet."],
      unresolvedQuestions: [
        "Which schema version should add the durable tables?",
      ],
      contentHash: sha("b"),
      createdAt: t3,
    });
    expect(result.findings[0]?.confidence).toBe("high");
    expect(Object.isFrozen(result.findings)).toBe(true);
    expect("transcript" in result).toBe(false);
  });
});
