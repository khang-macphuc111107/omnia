import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import {
  createExecutionEnvironment,
  resolveExecutionMode,
  transitionExecutionEnvironment,
  type ExecutionRequirements,
} from "./execution";
import type {
  ApprovalId,
  ApprovalReceiptId,
  AuditEventId,
  CapabilityGrantId,
  CapabilityRequestId,
  ConversationId,
  ExecutionEnvironmentId,
  BranchId,
  IterationId,
  ProfileId,
  ProjectId,
  RunId,
  RunItemId,
  TaskId,
  AttemptId,
} from "./ids";
import {
  appendAuditEvent,
  createKernelApprovalRequest,
  createKernelCapabilityGrant,
  createKernelCapabilityRequest,
  decideKernelApproval,
  evaluateKernelCapability,
  redactAuditValue,
} from "./kernel-capability";
import {
  appendRunGraphNode,
  assertRunGraphIntegrity,
  createUnifiedRunGraph,
  lineageForRunGraphNode,
} from "./run-graph";

const id = <T extends string>(value: string) => value as T;
const now = "2026-08-13T00:00:00.000Z";
const hash = (character: string) => character.repeat(64);
const environmentId = id<ExecutionEnvironmentId>("01K2H000000000000000000101");
const runId = id<RunId>("01K2H000000000000000000102");
const capabilityRequestId = id<CapabilityRequestId>("01K2H000000000000000000103");
const profileId = id<ProfileId>("01K2H000000000000000000106");

const policy = {
  availability: { persistent: true, isolated: true, remote: true },
  defaultLocalMode: "persistent" as const,
  allowedRemoteDestinations: ["https://worker.example.com"],
  policyVersionHash: hash("a"),
};

const interactiveRequirements: ExecutionRequirements = {
  requiresExecution: true,
  inputTrust: "trusted",
  runsUnknownCode: false,
  requiresDurableState: false,
  requiresHostIntegration: false,
  requiresPrivilegedHostAccess: false,
  requiresRemoteEnvironment: false,
  durationClass: "interactive",
};

describe("execution environment selection", () => {
  it("keeps model-only chat environment-free until a tool plan requires execution", () => {
    const selected = resolveExecutionMode(
      { ...interactiveRequirements, requiresExecution: false },
      policy,
    );

    expect(selected).toMatchObject({
      requestedMode: "auto",
      selectedMode: "none",
      reasonCodes: ["no-execution-required"],
    });
    expect(() =>
      resolveExecutionMode(
        { ...interactiveRequirements, requiresExecution: false, requestedMode: "persistent" },
        policy,
      ),
    ).toThrowError(DomainError);
    expect(() =>
      createExecutionEnvironment({
        id: environmentId,
        selection: selected,
        trustBoundary: "trusted-local-host",
        enabledCapabilities: [],
        mounts: [],
        networkPolicy: { mode: "offline", allowedDestinations: [], allowInbound: false },
        resourceBudget: {
          wallClockMs: 1,
          cpuTimeMs: 1,
          memoryBytes: 1,
          storageBytes: 1,
          networkBytes: 0,
          processCount: 1,
        },
        persistencePolicy: {
          kind: "resume",
          snapshotOnSuspend: false,
          maximumSnapshotCount: 0,
        },
        now,
      }),
    ).toThrowError(DomainError);
  });

  it("uses isolation for unknown code even when the normal Auto default is persistent", () => {
    const selected = resolveExecutionMode(
      { ...interactiveRequirements, inputTrust: "untrusted", runsUnknownCode: true },
      policy,
    );
    expect(selected.requestedMode).toBe("auto");
    expect(selected.selectedMode).toBe("isolated");
    expect(selected.reasonCodes).toContain("unknown-code");
  });

  it("uses isolation when trust is mixed rather than silently treating it as trusted", () => {
    expect(
      resolveExecutionMode({ ...interactiveRequirements, inputTrust: "mixed" }, policy),
    ).toMatchObject({ selectedMode: "isolated", reasonCodes: ["untrusted-input"] });
  });

  it("rejects an explicit persistent environment for mixed-trust input", () => {
    expect(() =>
      resolveExecutionMode(
        { ...interactiveRequirements, requestedMode: "persistent", inputTrust: "mixed" },
        policy,
      ),
    ).toThrowError(DomainError);
  });

  it("does not silently widen Auto to remote execution", () => {
    const selected = resolveExecutionMode(interactiveRequirements, {
      ...policy,
      availability: { persistent: true, isolated: true, remote: true },
    });
    expect(selected.selectedMode).toBe("persistent");

    expect(() =>
      resolveExecutionMode(
        {
          ...interactiveRequirements,
          requiresRemoteEnvironment: true,
          remoteDestination: "https://unapproved.example.com",
        },
        policy,
      ),
    ).toThrowError(DomainError);
  });

  it("requires unknown code and privileged host work to be separate approved stages", () => {
    expect(() =>
      resolveExecutionMode(
        {
          ...interactiveRequirements,
          inputTrust: "untrusted",
          runsUnknownCode: true,
          requiresPrivilegedHostAccess: true,
        },
        policy,
      ),
    ).toThrowError(DomainError);
  });

  it("fails closed when the safe environment required by Auto is unavailable", () => {
    expect(() =>
      resolveExecutionMode(
        { ...interactiveRequirements, inputTrust: "untrusted", runsUnknownCode: true },
        {
          ...policy,
          availability: { persistent: true, isolated: false, remote: true },
        },
      ),
    ).toThrowError(DomainError);
  });

  it("rejects raw renderer paths and enforces lifecycle transitions", () => {
    const selection = resolveExecutionMode(interactiveRequirements, policy);
    expect(() =>
      createExecutionEnvironment({
        id: environmentId,
        selection,
        trustBoundary: "trusted-local-host",
        enabledCapabilities: ["read_workspace"],
        mounts: [
          {
            handle: "C:\\Users\\khang\\secret",
            displayName: "Workspace",
            source: "workspace-grant",
            permissions: { read: true, write: false, execute: false },
          },
        ],
        networkPolicy: { mode: "offline", allowedDestinations: [], allowInbound: false },
        resourceBudget: {
          wallClockMs: 60_000,
          cpuTimeMs: 30_000,
          memoryBytes: 1_000_000,
          storageBytes: 1_000_000,
          networkBytes: 0,
          processCount: 1,
        },
        persistencePolicy: { kind: "resume", snapshotOnSuspend: true, maximumSnapshotCount: 3 },
        now,
      }),
    ).toThrowError(DomainError);

    const environment = createExecutionEnvironment({
      id: environmentId,
      selection,
      trustBoundary: "trusted-local-host",
      enabledCapabilities: ["read_workspace"],
      mounts: [
        {
          handle: "workspace-grant:01K2H000000000000000000104",
          displayName: "Workspace",
          source: "workspace-grant",
          permissions: { read: true, write: false, execute: false },
        },
      ],
      networkPolicy: { mode: "offline", allowedDestinations: [], allowInbound: false },
      resourceBudget: {
        wallClockMs: 60_000,
        cpuTimeMs: 30_000,
        memoryBytes: 1_000_000,
        storageBytes: 1_000_000,
        networkBytes: 0,
        processCount: 1,
      },
      persistencePolicy: { kind: "resume", snapshotOnSuspend: true, maximumSnapshotCount: 3 },
      now,
    });
    const ready = transitionExecutionEnvironment(environment, {
      to: "ready",
      now: "2026-08-13T00:00:01.000Z",
    });
    expect(ready.lifecycle).toBe("ready");
    expect(() =>
      transitionExecutionEnvironment(ready, {
        to: "preparing",
        now: "2026-08-13T00:00:02.000Z",
      }),
    ).toThrowError(DomainError);
  });

  it("binds mount and network authority to enabled capabilities", () => {
    const selection = resolveExecutionMode(interactiveRequirements, policy);
    const base = {
      id: id<ExecutionEnvironmentId>("01K2H0000000000000000001AD"),
      selection,
      trustBoundary: "trusted-local-host" as const,
      resourceBudget: {
        wallClockMs: 60_000,
        cpuTimeMs: 30_000,
        memoryBytes: 1_000_000,
        storageBytes: 1_000_000,
        networkBytes: 1_000,
        processCount: 1,
      },
      persistencePolicy: { kind: "resume" as const, snapshotOnSuspend: true, maximumSnapshotCount: 1 },
      now,
    };
    expect(() =>
      createExecutionEnvironment({
        ...base,
        enabledCapabilities: [],
        mounts: [
          {
            handle: "workspace-grant:01K2H000000000000000000104",
            displayName: "Workspace",
            source: "workspace-grant",
            permissions: { read: true, write: false, execute: false },
          },
        ],
        networkPolicy: { mode: "offline", allowedDestinations: [], allowInbound: false },
      }),
    ).toThrowError(DomainError);
    expect(() =>
      createExecutionEnvironment({
        ...base,
        enabledCapabilities: ["use_network"],
        mounts: [],
        networkPolicy: { mode: "allowlist", allowedDestinations: ["https://example.com"], allowInbound: false },
      }),
    ).not.toThrowError();
    expect(() =>
      createExecutionEnvironment({
        ...base,
        enabledCapabilities: ["use_network"],
        mounts: [],
        networkPolicy: { mode: "offline", allowedDestinations: [], allowInbound: true },
      }),
    ).toThrowError(DomainError);
  });
});

describe("capability broker and exact approvals", () => {
  const request = createKernelCapabilityRequest({
    id: capabilityRequestId,
    profileId,
    runId,
    environmentId,
    subjectType: "tool-version",
    subjectId: "shell-tool@1",
    subjectContentHash: hash("b"),
    capability: "execute_process",
    operationType: "process.spawn",
    operationArgumentsHash: hash("c"),
    toolVersionHash: hash("d"),
    capabilitySetHash: hash("e"),
    resourceHandles: ["workspace-grant:01K2H000000000000000000104"],
    destinations: [],
    executableHash: hash("f"),
    dataClasses: ["source-code"],
    requiresElevation: false,
    requestedAt: now,
  });

  const grant = createKernelCapabilityGrant({
    id: id<CapabilityGrantId>("01K2H000000000000000000105"),
    profileId,
    subjectType: "tool-version",
    subjectId: "shell-tool@1",
    subjectContentHash: hash("b"),
    capability: "execute_process",
    constraints: {
      environmentIds: [environmentId],
      resourceHandles: ["workspace-grant:01K2H000000000000000000104"],
      executableHashes: [hash("f")],
      dataClasses: ["source-code"],
      allowElevation: false,
    },
    policyVersionHash: hash("a"),
    grantedAt: now,
  });

  it("allows only a request inside an active grant's exact constraints", () => {
    const result = evaluateKernelCapability({
      request,
      environmentCapabilities: ["execute_process"],
      grants: [grant],
      approvalReceipts: [],
      policyVersionHash: hash("a"),
      now,
    });
    expect(result.decision).toBe("allow");
    expect(result.reasonCode).toBe("active-grant");

    const widened = createKernelCapabilityRequest({
      ...request,
      id: id<CapabilityRequestId>("01K2H000000000000000000107"),
      resourceHandles: ["workspace-grant:01K2H000000000000000000108"],
    });
    expect(
      evaluateKernelCapability({
        request: widened,
        environmentCapabilities: ["execute_process"],
        grants: [grant],
        approvalReceipts: [],
        policyVersionHash: hash("a"),
        now,
      }),
    ).toMatchObject({ decision: "deny", reasonCode: "grant-constraint-mismatch" });
  });

  it("enforces grant invocation limits from the durable usage ledger", () => {
    const boundedGrant = createKernelCapabilityGrant({
      ...grant,
      id: id<CapabilityGrantId>("01K2H00000000000000000010S"),
      constraints: { ...grant.constraints, maximumInvocations: 1 },
    });
    expect(
      evaluateKernelCapability({
        request,
        environmentCapabilities: ["execute_process"],
        grants: [boundedGrant],
        approvalReceipts: [],
        grantInvocationCounts: { [boundedGrant.id]: 1 },
        policyVersionHash: hash("a"),
        now,
      }),
    ).toMatchObject({ decision: "deny", reasonCode: "grant-invocation-limit" });
  });

  it("fails closed when a grant omits a requested scope dimension", () => {
    const unconstrained = createKernelCapabilityGrant({
      ...grant,
      id: id<CapabilityGrantId>("01K2H00000000000000000010T"),
      constraints: {
        environmentIds: [environmentId],
        dataClasses: ["source-code"],
        executableHashes: [hash("f")],
        allowElevation: false,
      },
    });
    expect(
      evaluateKernelCapability({
        request,
        environmentCapabilities: ["execute_process"],
        grants: [unconstrained],
        approvalReceipts: [],
        policyVersionHash: hash("a"),
        now,
      }),
    ).toMatchObject({ decision: "deny", reasonCode: "grant-constraint-mismatch" });
  });

  it("rejects a grant whose versioned subject hash differs from the request", () => {
    const changedSubject = createKernelCapabilityGrant({
      ...grant,
      id: id<CapabilityGrantId>("01K2H00000000000000000010U"),
      subjectContentHash: hash("0"),
    });
    expect(
      evaluateKernelCapability({
        request,
        environmentCapabilities: ["execute_process"],
        grants: [changedSubject],
        approvalReceipts: [],
        policyVersionHash: hash("a"),
        now,
      }),
    ).toMatchObject({ decision: "deny", reasonCode: "no-active-grant" });
  });

  it("rejects unknown capabilities and unevaluated custom constraints at runtime", () => {
    expect(() =>
      createKernelCapabilityRequest({
        ...request,
        id: id<CapabilityRequestId>("01K2H00000000000000000010W"),
        capability: "unknown_capability" as never,
      }),
    ).toThrowError(DomainError);

    expect(() =>
      createKernelCapabilityGrant({
        ...grant,
        id: id<CapabilityGrantId>("01K2H00000000000000000010X"),
        constraints: {
          ...grant.constraints,
          custom: { policyPlugin: "not-registered" },
        },
      }),
    ).toThrowError(DomainError);
  });

  it("revalidates requests and grants at the trusted policy boundary", () => {
    const forgedPureCompute = {
      ...request,
      id: id<CapabilityRequestId>("01K2H0000000000000000001AN"),
      capability: "pure_compute" as const,
      resourceHandles: ["workspace-grant:01K2H000000000000000000104"],
      executableHash: undefined,
      dataClasses: [],
    } as unknown as typeof request;
    expect(() =>
      evaluateKernelCapability({
        request: forgedPureCompute,
        environmentCapabilities: ["pure_compute"],
        grants: [],
        approvalReceipts: [],
        policyVersionHash: hash("a"),
        now,
      }),
    ).toThrowError(DomainError);

    const forgedGrant = {
      ...grant,
      id: id<CapabilityGrantId>("01K2H0000000000000000001AP"),
      constraints: {
        ...grant.constraints,
        custom: { unevaluatedPolicy: true },
      },
    };
    expect(() =>
      evaluateKernelCapability({
        request,
        environmentCapabilities: ["execute_process"],
        grants: [forgedGrant],
        approvalReceipts: [],
        policyVersionHash: hash("a"),
        now,
      }),
    ).toThrowError(DomainError);
  });

  it("does not apply a grant from another profile", () => {
    expect(
      evaluateKernelCapability({
        request,
        environmentCapabilities: ["execute_process"],
        grants: [
          createKernelCapabilityGrant({
            ...grant,
            profileId: id<ProfileId>("01K2H0000000000000000001AA"),
          }),
        ],
        approvalReceipts: [],
        policyVersionHash: hash("a"),
        now,
      }),
    ).toMatchObject({ decision: "deny", reasonCode: "no-active-grant" });
  });

  it("requires an exact approval receipt for elevation and invalidates argument drift", () => {
    const elevated = createKernelCapabilityRequest({
      ...request,
      id: id<CapabilityRequestId>("01K2H000000000000000000109"),
      capability: "request_admin",
      requiresElevation: true,
    });
    expect(
      evaluateKernelCapability({
        request: elevated,
        environmentCapabilities: ["request_admin"],
        grants: [],
        approvalReceipts: [],
        policyVersionHash: hash("a"),
        now,
      }),
    ).toMatchObject({ decision: "require-approval", reasonCode: "elevation-requires-approval" });

    const approval = createKernelApprovalRequest({
      id: id<ApprovalId>("01K2H00000000000000000010A"),
      capabilityRequestId: elevated.id,
      profileId,
      runId,
      environmentId,
      subjectType: elevated.subjectType,
      subjectId: elevated.subjectId,
      ...(elevated.subjectContentHash === undefined
        ? {}
        : { subjectContentHash: elevated.subjectContentHash }),
      operationType: elevated.operationType,
      operationArgumentsHash: elevated.operationArgumentsHash,
      toolVersionHash: elevated.toolVersionHash,
      capabilitySetHash: elevated.capabilitySetHash,
      policyVersionHash: hash("a"),
      capability: elevated.capability,
      reason: "Install the user-selected package with Windows elevation.",
      destinations: [],
      resourceHandles: elevated.resourceHandles,
      ...(elevated.executableHash === undefined
        ? {}
        : { executableHash: elevated.executableHash }),
      dataClasses: elevated.dataClasses,
      requiresElevation: true,
      proposedArgumentsPreview: { executable: "package installer", scope: "machine" },
      choices: ["allow-once", "deny"],
      createdAt: now,
      expiresAt: "2026-08-13T00:05:00.000Z",
    });
    const receipt = decideKernelApproval(approval, {
      id: id<ApprovalReceiptId>("01K2H00000000000000000010B"),
      decision: "allow-once",
      operationArgumentsHash: elevated.operationArgumentsHash,
      toolVersionHash: elevated.toolVersionHash,
      capabilitySetHash: elevated.capabilitySetHash,
      environmentId,
      policyVersionHash: hash("a"),
      auditEventId: id<AuditEventId>("01K2H00000000000000000010C"),
      now: "2026-08-13T00:01:00.000Z",
    });
    expect(
      evaluateKernelCapability({
        request: elevated,
        environmentCapabilities: ["request_admin"],
        grants: [],
        approvalReceipts: [receipt],
        policyVersionHash: hash("a"),
        now: "2026-08-13T00:02:00.000Z",
      }),
    ).toMatchObject({ decision: "allow", reasonCode: "exact-approval" });

    expect(
      evaluateKernelCapability({
        request: elevated,
        environmentCapabilities: ["request_admin"],
        grants: [],
        approvalReceipts: [receipt],
        consumedApprovalReceiptIds: [receipt.id],
        policyVersionHash: hash("a"),
        now: "2026-08-13T00:02:00.000Z",
      }),
    ).toMatchObject({ decision: "require-approval", reasonCode: "approval-consumed" });

    const alteredScope = createKernelCapabilityRequest({
      ...elevated,
      id: id<CapabilityRequestId>("01K2H00000000000000000010V"),
      dataClasses: ["secret"],
    });
    expect(
      evaluateKernelCapability({
        request: alteredScope,
        environmentCapabilities: ["request_admin"],
        grants: [],
        approvalReceipts: [receipt],
        policyVersionHash: hash("a"),
        now: "2026-08-13T00:02:00.000Z",
      }),
    ).toMatchObject({
      decision: "require-approval",
      reasonCode: "elevation-requires-approval",
    });

    expect(() =>
      decideKernelApproval(approval, {
        id: id<ApprovalReceiptId>("01K2H00000000000000000010D"),
        decision: "allow-once",
        operationArgumentsHash: hash("0"),
        toolVersionHash: elevated.toolVersionHash,
        capabilitySetHash: elevated.capabilitySetHash,
        environmentId,
        policyVersionHash: hash("a"),
        auditEventId: id<AuditEventId>("01K2H00000000000000000010E"),
        now: "2026-08-13T00:01:00.000Z",
      }),
    ).toThrowError(DomainError);

    expect(
      evaluateKernelCapability({
        request: elevated,
        environmentCapabilities: ["request_admin"],
        grants: [],
        approvalReceipts: [
          { ...receipt, profileId: id<ProfileId>("01K2H0000000000000000001AB") },
        ],
        policyVersionHash: hash("a"),
        now: "2026-08-13T00:02:00.000Z",
      }),
    ).toMatchObject({ decision: "require-approval", reasonCode: "elevation-requires-approval" });

    expect(() =>
      evaluateKernelCapability({
        request: elevated,
        environmentCapabilities: ["request_admin"],
        grants: [],
        approvalReceipts: [{ ...receipt, expiresAt: "2026-08-13T00:00:30.000Z" }],
        policyVersionHash: hash("a"),
        now: "2026-08-13T00:02:00.000Z",
      }),
    ).toThrowError(DomainError);

    expect(
      evaluateKernelCapability({
        request: elevated,
        environmentCapabilities: ["request_admin"],
        grants: [],
        approvalReceipts: [
          { ...receipt, decision: "deny", expiresAt: "2026-08-13T00:01:30.000Z" },
        ],
        policyVersionHash: hash("a"),
        now: "2026-08-13T00:02:00.000Z",
      }),
    ).toMatchObject({ decision: "require-approval", reasonCode: "elevation-requires-approval" });
  });

  it("keeps audit events hash-linked and redacts secret-shaped fields", () => {
    let journal = appendAuditEvent([], {
      id: id<AuditEventId>("01K2H00000000000000000010F"),
      eventHash: hash("1"),
      occurredAt: now,
      actorType: "policy",
      actorId: "omnia-policy",
      action: "capability.evaluate",
      outcome: "allowed",
      runId,
      capabilityRequestId,
      operationArgumentsHash: request.operationArgumentsHash,
      details: redactAuditValue({ token: "never persist me", provider: "local" }, ["token"]) as {
        readonly [key: string]: string;
      },
    });
    journal = appendAuditEvent(journal, {
      id: id<AuditEventId>("01K2H00000000000000000010G"),
      eventHash: hash("2"),
      occurredAt: "2026-08-13T00:00:01.000Z",
      actorType: "tool",
      actorId: "shell-tool@1",
      action: "process.spawn",
      outcome: "succeeded",
      runId,
      environmentId,
      details: {},
    });
    expect(journal[1]?.previousEventHash).toBe(hash("1"));
    expect(journal[0]?.details).toEqual({ token: "[REDACTED]", provider: "local" });
    expect(journal.map((event) => event.sequence)).toEqual([1, 2]);
  });
});

describe("unified run graph", () => {
  it("retains project-to-item lineage and rejects invalid re-parenting", () => {
    const projectId = id<ProjectId>("01K2H00000000000000000010H");
    const conversationId = id<ConversationId>("01K2H00000000000000000010J");
    const taskId = id<TaskId>("01K2H00000000000000000010K");
    const graphRunId = id<RunId>("01K2H00000000000000000010M");
    const attemptId = id<AttemptId>("01K2H00000000000000000010N");
    const iterationId = id<IterationId>("01K2H00000000000000000010P");
    const itemId = id<RunItemId>("01K2H00000000000000000010Q");

    let graph = createUnifiedRunGraph(projectId);
    graph = appendRunGraphNode(graph, { id: projectId, kind: "project", ordinal: 0, createdAt: now, metadata: {} });
    graph = appendRunGraphNode(graph, { id: conversationId, kind: "conversation", parentId: projectId, ordinal: 0, createdAt: now, metadata: {} });
    graph = appendRunGraphNode(graph, { id: taskId, kind: "task", parentId: conversationId, ordinal: 0, createdAt: now, metadata: {} });
    graph = appendRunGraphNode(graph, { id: graphRunId, kind: "run", parentId: taskId, ordinal: 0, createdAt: now, metadata: {} });
    graph = appendRunGraphNode(graph, { id: attemptId, kind: "attempt", parentId: graphRunId, ordinal: 0, createdAt: now, metadata: {} });
    graph = appendRunGraphNode(graph, { id: iterationId, kind: "iteration", parentId: attemptId, ordinal: 0, createdAt: now, metadata: {} });
    graph = appendRunGraphNode(graph, {
      id: itemId,
      kind: "item",
      parentId: iterationId,
      ordinal: 0,
      createdAt: now,
      metadata: { type: "message", producer: "provider", status: "completed" },
    });

    expect(() => assertRunGraphIntegrity(graph)).not.toThrow();

    expect(lineageForRunGraphNode(graph, itemId).map((node) => node.kind)).toEqual([
      "project",
      "conversation",
      "task",
      "run",
      "attempt",
      "iteration",
      "item",
    ]);
    expect(() =>
      appendRunGraphNode(graph, {
        id: id<RunItemId>("01K2H00000000000000000010R"),
        kind: "item",
        parentId: graphRunId,
        ordinal: 1,
        createdAt: now,
        metadata: {},
      }),
    ).toThrowError(DomainError);

    expect(() =>
      appendRunGraphNode(graph, {
        id: id<RunItemId>("01K2H0000000000000000001AC"),
        kind: "item",
        parentId: iterationId,
        ordinal: 1,
        createdAt: now,
        metadata: { type: "tool-call" },
      }),
    ).toThrowError(DomainError);
  });

  it("supports profile-scoped branch lineage without inventing a project or task", () => {
    const scopedProfileId = id<ProfileId>("01K2H0000000000000000001AD");
    const conversationId = id<ConversationId>("01K2H0000000000000000001AE");
    const branchId = id<BranchId>("01K2H0000000000000000001AF");
    const graphRunId = id<RunId>("01K2H0000000000000000001AG");
    const iterationId = id<IterationId>("01K2H0000000000000000001AH");
    const attemptId = id<AttemptId>("01K2H0000000000000000001AJ");

    let graph = createUnifiedRunGraph({ profileId: scopedProfileId });
    graph = appendRunGraphNode(graph, {
      id: scopedProfileId,
      kind: "profile",
      ordinal: 0,
      createdAt: now,
      metadata: {},
    });
    graph = appendRunGraphNode(graph, {
      id: conversationId,
      kind: "conversation",
      parentId: scopedProfileId,
      ordinal: 0,
      createdAt: now,
      metadata: {},
    });
    graph = appendRunGraphNode(graph, {
      id: branchId,
      kind: "branch",
      parentId: conversationId,
      ordinal: 0,
      createdAt: now,
      metadata: {},
    });
    graph = appendRunGraphNode(graph, {
      id: graphRunId,
      kind: "run",
      parentId: branchId,
      ordinal: 0,
      createdAt: now,
      metadata: {},
    });
    graph = appendRunGraphNode(graph, {
      id: attemptId,
      kind: "attempt",
      parentId: graphRunId,
      ordinal: 0,
      createdAt: now,
      metadata: {},
    });
    graph = appendRunGraphNode(graph, {
      id: iterationId,
      kind: "iteration",
      parentId: attemptId,
      ordinal: 0,
      createdAt: now,
      metadata: {},
    });

    expect(lineageForRunGraphNode(graph, iterationId).map((node) => node.kind)).toEqual([
      "profile",
      "conversation",
      "branch",
      "run",
      "attempt",
      "iteration",
    ]);
    expect(graph.projectId).toBeUndefined();
  });

  it("permits a projectless conversation root but rejects ambiguous additional roots", () => {
    const conversationId = id<ConversationId>("01K2H0000000000000000001AK");
    let graph = createUnifiedRunGraph();
    graph = appendRunGraphNode(graph, {
      id: conversationId,
      kind: "conversation",
      ordinal: 0,
      createdAt: now,
      metadata: {},
    });

    expect(graph.conversationId).toBe(conversationId);
    expect(() =>
      appendRunGraphNode(graph, {
        id: id<ProjectId>("01K2H0000000000000000001AM"),
        kind: "project",
        ordinal: 0,
        createdAt: now,
        metadata: {},
      }),
    ).toThrowError(DomainError);
  });

  it("keeps forked branches inside their originating conversation lineage", () => {
    const conversationId = id<ConversationId>("01K2H0000000000000000001AN");
    const rootBranchId = id<BranchId>("01K2H0000000000000000001AP");
    const childBranchId = id<BranchId>("01K2H0000000000000000001AQ");
    const runId = id<RunId>("01K2H0000000000000000001AR");
    let graph = createUnifiedRunGraph();
    graph = appendRunGraphNode(graph, {
      id: conversationId,
      kind: "conversation",
      ordinal: 0,
      createdAt: now,
      metadata: {},
    });
    graph = appendRunGraphNode(graph, {
      id: rootBranchId,
      kind: "branch",
      parentId: conversationId,
      ordinal: 0,
      createdAt: now,
      metadata: {},
    });
    graph = appendRunGraphNode(graph, {
      id: childBranchId,
      kind: "branch",
      parentId: rootBranchId,
      ordinal: 0,
      createdAt: now,
      metadata: {},
    });
    graph = appendRunGraphNode(graph, {
      id: runId,
      kind: "run",
      parentId: childBranchId,
      ordinal: 0,
      createdAt: now,
      metadata: {},
    });

    expect(lineageForRunGraphNode(graph, runId).map((node) => node.kind)).toEqual([
      "conversation",
      "branch",
      "branch",
      "run",
    ]);
  });
});
