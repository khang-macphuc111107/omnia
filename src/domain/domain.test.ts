import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import type {
  AssistantProfileId,
  ApprovalId,
  AttemptId,
  BranchId,
  CapabilityGrantId,
  ContextItemId,
  ContextSnapshotId,
  ConversationId,
  MemoryId,
  MemoryRevisionId,
  MessageId,
  ModelProfileId,
  ProfileId,
  ProjectId,
  ProviderConnectionId,
  RunEventId,
  RunId,
  SkillId,
  SkillVersionId,
  WorkspaceGrantId,
} from "./ids";
import {
  createApprovalRequest,
  createCapabilityGrant,
  decideApproval,
  isCapabilityGrantActive,
} from "./capability";
import { compileContext } from "./context";
import {
  appendMessage,
  createConversation,
  editMessage,
  resolveBranchMessages,
} from "./conversation";
import {
  appendMemoryRevision,
  approveMemoryRevision,
  createMemory,
  createMemoryRevision,
  selectMemories,
} from "./memory";
import { resolveParameters } from "./parameters";
import {
  assertPathInsideWorkspace,
  createWorkspaceGrant,
  revokeWorkspaceGrant,
} from "./project";
import { createProviderConnection } from "./provider";
import {
  addRunAttempt,
  appendRunEvent,
  createRun,
  freezeRunSnapshot,
  transitionRun,
  transitionRunAttempt,
} from "./run";
import { createSkillVersion, selectSkillVersions } from "./skill";
import { assertIsoTimestamp } from "./shared";

const id = <T extends string>(value: string) => value as T;
const now = "2026-08-12T00:00:00.000Z";

describe("shared domain validation", () => {
  it("rejects locale and numeric dates that Date.parse would otherwise accept", () => {
    expect(() => assertIsoTimestamp("0", "timestamp")).toThrowError(
      DomainError,
    );
    expect(() =>
      assertIsoTimestamp("August 13, 2026", "timestamp"),
    ).toThrowError(DomainError);
    expect(() =>
      assertIsoTimestamp("2026-08-13T00:00:00.000Z", "timestamp"),
    ).not.toThrow();
  });
});

describe("conversation domain", () => {
  it("preserves the original branch when a user message is edited", () => {
    const conversationId = id<ConversationId>("01K2H000000000000000000001");
    const rootBranchId = id<BranchId>("01K2H000000000000000000002");
    const firstMessageId = id<MessageId>("01K2H000000000000000000003");
    const editedBranchId = id<BranchId>("01K2H000000000000000000004");
    const replacementId = id<MessageId>("01K2H000000000000000000005");
    let conversation = createConversation({
      id: conversationId,
      rootBranchId,
      profileId: id<ProfileId>("01K2H000000000000000000006"),
      now,
    });
    conversation = appendMessage(conversation, {
      id: firstMessageId,
      branchId: rootBranchId,
      role: "user",
      content: [{ type: "text", text: "original" }],
      contentText: "original",
      now,
      finalizedAt: now,
    }).conversation;

    conversation = editMessage(conversation, {
      branchId: editedBranchId,
      targetMessageId: firstMessageId,
      replacementMessageId: replacementId,
      content: [{ type: "text", text: "edited" }],
      contentText: "edited",
      now,
    }).conversation;

    expect(
      resolveBranchMessages(conversation, rootBranchId).map(
        (message) => message.id,
      ),
    ).toEqual([firstMessageId]);
    expect(
      resolveBranchMessages(conversation, editedBranchId).map(
        (message) => message.id,
      ),
    ).toEqual([replacementId]);
  });
});

describe("parameter resolution", () => {
  it("keeps the winning layer and rejects unsupported explicit values", () => {
    const capabilities = {
      temperature: {
        key: "temperature",
        valueType: "number" as const,
        support: "native" as const,
        validRange: { min: 0, max: 2 },
      },
      top_k: {
        key: "top_k",
        valueType: "integer" as const,
        support: "unsupported" as const,
      },
    };
    const resolved = resolveParameters({
      capabilities,
      layers: [
        { name: "product-default", values: { temperature: 0.7 } },
        { name: "single-run-override", values: { temperature: 0.2 } },
      ],
    });
    expect(resolved.temperature?.value).toBe(0.2);
    expect(resolved.temperature?.sourceLayer).toBe("single-run-override");
    expect(() =>
      resolveParameters({
        capabilities,
        layers: [{ name: "single-run-override", values: { top_k: 20 } }],
      }),
    ).toThrowError(DomainError);
  });
});

describe("provider security", () => {
  it("requires an explicit local-provider grant for loopback HTTP endpoints", () => {
    const common = {
      id: id<ProviderConnectionId>("01K2H000000000000000000007"),
      profileId: id<ProfileId>("01K2H000000000000000000008"),
      type: "openai-compatible" as const,
      displayName: "Local runtime",
      baseUrl: "http://localhost:11434/v1",
      authScheme: "none" as const,
      now,
    };
    expect(() =>
      createProviderConnection({
        ...common,
        egressPolicy: {
          allowedHosts: ["localhost"],
          destinationClass: "loopback",
          allowInsecureHttp: true,
          allowCrossOriginRedirects: false,
          localProviderGrant: false,
          dataClasses: ["standard"],
        },
      }),
    ).toThrowError(DomainError);

    expect(
      createProviderConnection({
        ...common,
        egressPolicy: {
          allowedHosts: ["localhost"],
          destinationClass: "loopback",
          allowInsecureHttp: true,
          allowCrossOriginRedirects: false,
          localProviderGrant: true,
          dataClasses: ["standard"],
        },
      }).baseUrl,
    ).toBe("http://localhost:11434/v1");
  });

  it("does not keep a credential handle on an explicitly no-auth connection", () => {
    expect(() =>
      createProviderConnection({
        id: id<ProviderConnectionId>("01K2H00000000000000000000G"),
        profileId: id<ProfileId>("01K2H00000000000000000000H"),
        type: "openai-compatible",
        displayName: "Unexpected credential",
        baseUrl: "https://example.com/v1",
        authScheme: "none",
        credentialRef: "vault:should-not-exist",
        egressPolicy: {
          allowedHosts: ["example.com"],
          destinationClass: "public-internet",
          allowInsecureHttp: false,
          allowCrossOriginRedirects: false,
          localProviderGrant: false,
          dataClasses: ["standard"],
        },
        now,
      }),
    ).toThrowError(DomainError);
  });
});

describe("context compiler", () => {
  it("treats retrieved data as untrusted and records budget omissions", () => {
    const hash = "a".repeat(64);
    const snapshot = compileContext({
      snapshotId: id<ContextSnapshotId>("01K2H000000000000000000009"),
      candidates: [
        {
          id: id<ContextItemId>("01K2H00000000000000000000A"),
          kind: "product_instruction",
          contentRef: "blob:system",
          contentHash: hash,
          sourceRef: "product",
          authority: "platform_invariant",
          semanticRole: "instruction",
          survivalPolicy: "verbatim_always",
          scope: "global",
          sensitivity: [],
          tokenEstimate: 20,
          relevance: 1,
          priority: 10,
          pinned: true,
          required: true,
          summarizable: false,
          cacheClass: "static",
          dependencyItemIds: [],
        },
        {
          id: id<ContextItemId>("01K2H00000000000000000000B"),
          kind: "workspace_chunk",
          contentRef: "blob:file",
          contentHash: hash,
          sourceRef: "workspace:file.txt",
          authority: "untrusted_data",
          semanticRole: "evidence",
          survivalPolicy: "evictable",
          scope: "project",
          sensitivity: [],
          tokenEstimate: 90,
          relevance: 0.8,
          priority: 1,
          pinned: false,
          required: false,
          summarizable: true,
          cacheClass: "dynamic",
          dependencyItemIds: [],
        },
      ],
      modelContextLimit: 100,
      reservedOutputTokens: 20,
      providerOverheadTokens: 5,
      toolSchemaTokens: 0,
      safetyMarginTokens: 5,
      now,
      tokenizer: "estimated",
      estimatorUncertain: true,
    });
    expect(snapshot.selectedItemIds).toHaveLength(1);
    expect(snapshot.candidates[1]?.reason).toBe("omitted.budget_exceeded");
  });

  it("rejects a workspace chunk promoted to instruction authority", () => {
    expect(() =>
      compileContext({
        snapshotId: id<ContextSnapshotId>("01K2H00000000000000000000C"),
        candidates: [
          {
            id: id<ContextItemId>("01K2H00000000000000000000D"),
            kind: "workspace_chunk",
            contentRef: "blob:file",
            contentHash: "b".repeat(64),
            sourceRef: "workspace:file.txt",
            authority: "platform_invariant",
            semanticRole: "evidence",
            survivalPolicy: "evictable",
            scope: "project",
            sensitivity: [],
            tokenEstimate: 1,
            relevance: 1,
            priority: 1,
            pinned: false,
            required: false,
            summarizable: true,
            cacheClass: "dynamic",
            dependencyItemIds: [],
          },
        ],
        modelContextLimit: 100,
        reservedOutputTokens: 10,
        providerOverheadTokens: 0,
        toolSchemaTokens: 0,
        safetyMarginTokens: 0,
        now,
        tokenizer: "estimated",
        estimatorUncertain: true,
      }),
    ).toThrowError(DomainError);
  });
});

describe("run state machines", () => {
  const runId = id<RunId>("01K2H00000000000000000000J");
  const providerConnectionId = id<ProviderConnectionId>(
    "01K2H00000000000000000000K",
  );
  const modelProfileId = id<ModelProfileId>("01K2H00000000000000000000M");

  function frozenRun() {
    let run = createRun({
      id: runId,
      conversationId: id<ConversationId>("01K2H00000000000000000000N"),
      branchId: id<BranchId>("01K2H00000000000000000000P"),
      userMessageId: id<MessageId>("01K2H00000000000000000000Q"),
      now,
    });
    run = transitionRun(run, { to: "resolving", now });
    run = freezeRunSnapshot(
      run,
      {
        id: id<ContextSnapshotId>("01K2H00000000000000000000R"),
        version: 1,
        contentHash: "c".repeat(64),
        providerConnectionId,
        modelProfileId,
        providerModelId: "omnia-test-model",
        parameters: {},
        contextItemHashes: {},
        skillVersionHashes: {},
        memoryRevisionHashes: {},
        policyDecisionIds: [],
        frozenAt: now,
        extensions: {},
      },
      now,
    );
    return transitionRun(run, { to: "dispatching", now });
  }

  it("requires a frozen snapshot before dispatch", () => {
    const resolving = transitionRun(
      createRun({
        id: runId,
        conversationId: id<ConversationId>("01K2H00000000000000000000S"),
        branchId: id<BranchId>("01K2H00000000000000000000T"),
        userMessageId: id<MessageId>("01K2H00000000000000000000V"),
        now,
      }),
      { to: "resolving", now },
    );
    expect(() =>
      transitionRun(resolving, { to: "dispatching", now }),
    ).toThrowError(DomainError);
  });

  it("never auto-retries an outcome-unknown attempt", () => {
    const attemptId = id<AttemptId>("01K2H00000000000000000000W");
    let run = addRunAttempt(frozenRun(), {
      id: attemptId,
      providerConnectionId,
      modelProfileId,
      providerModelId: "omnia-test-model",
      idempotencySupported: false,
      now,
    });
    run = transitionRunAttempt(run, { attemptId, to: "dispatching", now });
    run = transitionRunAttempt(run, { attemptId, to: "unknown", now });
    expect(() =>
      addRunAttempt(run, {
        id: id<AttemptId>("01K2H00000000000000000000X"),
        providerConnectionId,
        modelProfileId,
        providerModelId: "omnia-test-model",
        idempotencySupported: false,
        now,
      }),
    ).toThrowError(DomainError);
  });

  it("rejects backwards run and attempt timestamps", () => {
    const run = frozenRun();
    expect(() =>
      addRunAttempt(run, {
        id: id<AttemptId>("01K2H0000000000000000000XA"),
        providerConnectionId,
        modelProfileId,
        providerModelId: "omnia-test-model",
        idempotencySupported: false,
        now: "2026-08-11T23:59:59.000Z",
      }),
    ).toThrowError(DomainError);
    expect(() =>
      transitionRun(run, { to: "streaming", now: "2026-08-11T23:59:59.000Z" }),
    ).toThrowError(DomainError);
  });

  it("advances the run watermark when a journal event is appended", () => {
    const run = frozenRun();
    const event = {
      schemaVersion: 1 as const,
      id: id<RunEventId>("01K2H0000000000000000000XB"),
      sequence: 1,
      type: "run.dispatching" as const,
      occurredAt: "2026-08-13T00:00:02.000Z",
      conversationId: run.conversationId,
      branchId: run.branchId,
      runId: run.id,
      source: "harness" as const,
      visibility: "diagnostic" as const,
      sensitivity: "normal" as const,
      payload: {},
    };
    const next = appendRunEvent(run, event);
    expect(next.updatedAt).toBe(event.occurredAt);
  });
});

describe("workspace and capability boundaries", () => {
  it("keeps chat-phase workspace grants read-only and blocks escapes after revocation", () => {
    const grant = createWorkspaceGrant({
      id: id<WorkspaceGrantId>("01K2H00000000000000000000Y"),
      profileId: id<ProfileId>("01K2H00000000000000000000Z"),
      projectId: id<ProjectId>("01K2H000000000000000000010"),
      pathRef: "native:path:1",
      canonicalPathHash: "d".repeat(64),
      displayPath: "C:\\Work\\Omnia",
      now,
    });
    expect(grant.permissions.write).toBe(false);
    expect(grant.permissions.execute).toBe(false);
    expect(() =>
      assertPathInsideWorkspace(grant, "C:\\Work\\Omnia", "C:\\Work\\Other"),
    ).toThrowError(DomainError);
    expect(() =>
      assertPathInsideWorkspace(
        revokeWorkspaceGrant(grant, "2026-08-12T00:01:00.000Z"),
        "C:\\Work\\Omnia",
        "C:\\Work\\Omnia\\README.md",
      ),
    ).toThrowError(DomainError);
  });

  it("binds a skill capability grant to the approved content hash", () => {
    const grant = createCapabilityGrant({
      id: id<CapabilityGrantId>("01K2H000000000000000000011"),
      profileId: id<ProfileId>("01K2H000000000000000000012"),
      subjectType: "skill-version",
      subjectId: "01K2H000000000000000000013",
      subjectContentHash: "e".repeat(64),
      capability: "read_workspace",
      constraints: {},
      grantedAt: now,
    });
    expect(isCapabilityGrantActive(grant, "e".repeat(64), now)).toBe(true);
    expect(isCapabilityGrantActive(grant, "f".repeat(64), now)).toBe(false);
  });

  it("rejects malformed approval windows and stale or changed operations", () => {
    const base = {
      id: id<ApprovalId>("01K2H00000000000000000003A"),
      runId: id<RunId>("01K2H00000000000000000003B"),
      toolCallId: "tool-call-1",
      toolVersionHash: "a".repeat(64),
      argumentsHash: "b".repeat(64),
      effect: "write_workspace" as const,
      reason: "Write the reviewed patch to the selected workspace.",
      paths: ["src/main.ts"],
      dataClasses: ["source-code"],
      proposedArgumentsPreview: { patch: { files: ["src/main.ts"] } },
      choices: ["allow-once", "deny"] as const,
      createdAt: now,
      expiresAt: "2026-08-12T00:05:00.000Z",
    };

    const request = createApprovalRequest(base);
    expect(Object.isFrozen(request.proposedArgumentsPreview)).toBe(true);
    expect(Object.isFrozen(request.proposedArgumentsPreview.patch)).toBe(true);
    expect(() =>
      decideApproval(
        request,
        "allow-once",
        "c".repeat(64),
        request.toolVersionHash,
        "2026-08-12T00:01:00.000Z",
      ),
    ).toThrowError(DomainError);
    expect(() =>
      decideApproval(
        request,
        "allow-once",
        request.argumentsHash,
        request.toolVersionHash,
        request.expiresAt,
      ),
    ).toThrowError(DomainError);
    expect(() =>
      createApprovalRequest({
        ...base,
        choices: ["deny", "deny"],
      }),
    ).toThrowError(DomainError);
    expect(() =>
      createApprovalRequest({
        ...base,
        expiresAt: "not-a-time",
      }),
    ).toThrowError(DomainError);
  });
});

describe("memory and skill safety", () => {
  it("never reads memory in temporary chats and rejects cross-scope revisions", () => {
    const memoryId = id<MemoryId>("01K2H000000000000000000014");
    const profileId = id<ProfileId>("01K2H000000000000000000015");
    const projectId = id<ProjectId>("01K2H000000000000000000016");
    const initial = createMemoryRevision({
      id: id<MemoryRevisionId>("01K2H000000000000000000017"),
      memoryId,
      scope: { scope: "project", profileId, projectId },
      kind: "decision",
      content: "Use citations for every research answer.",
      contentHash: "1".repeat(64),
      confidence: 1,
      status: "active",
      userApproved: true,
      validFrom: now,
      createdAt: now,
    });
    const memory = createMemory(initial);
    expect(
      selectMemories({
        candidates: [
          {
            revision: initial,
            relevance: 1,
            recency: 1,
            utility: 1,
            tokenEstimate: 8,
            reasons: ["project-match"],
          },
        ],
        tokenBudget: 100,
        now,
        temporaryChat: true,
        mode: "auto-low-risk",
      }),
    ).toEqual([]);

    const moved = createMemoryRevision({
      id: id<MemoryRevisionId>("01K2H000000000000000000018"),
      memoryId,
      scope: {
        scope: "assistant",
        profileId,
        assistantProfileId: id<AssistantProfileId>(
          "01K2H000000000000000000019",
        ),
      },
      kind: "decision",
      content: "Use citations for every research answer.",
      contentHash: "2".repeat(64),
      confidence: 1,
      status: "proposed",
      supersedesRevisionId: initial.id,
      validFrom: now,
      createdAt: now,
    });
    expect(() => appendMemoryRevision(memory, moved, now)).toThrowError(
      DomainError,
    );
  });

  it("keeps exactly one active revision and supersedes the current fact", () => {
    const memoryId = id<MemoryId>("01K2H000000000000000000020");
    const profileId = id<ProfileId>("01K2H000000000000000000021");
    const initial = createMemoryRevision({
      id: id<MemoryRevisionId>("01K2H000000000000000000022"),
      memoryId,
      scope: { scope: "global", profileId },
      kind: "fact",
      content: "The release is planned for Friday.",
      contentHash: "5".repeat(64),
      confidence: 0.8,
      status: "active",
      userApproved: true,
      validFrom: now,
      createdAt: now,
    });
    const memory = createMemory(initial);
    const correction = createMemoryRevision({
      id: id<MemoryRevisionId>("01K2H000000000000000000023"),
      memoryId,
      scope: { scope: "global", profileId },
      kind: "fact",
      content: "The release moved to Monday.",
      contentHash: "6".repeat(64),
      confidence: 1,
      status: "proposed",
      supersedesRevisionId: initial.id,
      validFrom: "2026-08-13T00:00:00.000Z",
      createdAt: "2026-08-13T00:00:00.000Z",
    });
    const approved = approveMemoryRevision(
      appendMemoryRevision(memory, correction, "2026-08-13T00:00:00.000Z"),
      correction.id,
      "2026-08-13T00:00:00.000Z",
    );
    expect(approved.activeRevisionId).toBe(correction.id);
    expect(approved.revisions.filter((revision) => revision.status === "active")).toHaveLength(1);
    expect(approved.revisions.find((revision) => revision.id === initial.id)?.status).toBe(
      "superseded",
    );
  });

  it("rejects competing active revisions and duplicate retrieval candidates", () => {
    const memoryId = id<MemoryId>("01K2H000000000000000000024");
    const profileId = id<ProfileId>("01K2H000000000000000000025");
    const initial = createMemoryRevision({
      id: id<MemoryRevisionId>("01K2H000000000000000000026"),
      memoryId,
      scope: { scope: "global", profileId },
      kind: "preference",
      content: "Use concise answers.",
      contentHash: "7".repeat(64),
      confidence: 1,
      status: "active",
      userApproved: true,
      validFrom: now,
      createdAt: now,
    });
    const memory = createMemory(initial);
    const competing = createMemoryRevision({
      id: id<MemoryRevisionId>("01K2H000000000000000000027"),
      memoryId,
      scope: { scope: "global", profileId },
      kind: "preference",
      content: "Use detailed answers.",
      contentHash: "8".repeat(64),
      confidence: 1,
      status: "active",
      userApproved: true,
      validFrom: "2026-08-13T00:00:00.000Z",
      createdAt: "2026-08-13T00:00:00.000Z",
    });
    expect(() => appendMemoryRevision(memory, competing, "2026-08-13T00:00:00.000Z")).toThrowError(
      DomainError,
    );
    const candidate = {
      revision: initial,
      relevance: 1,
      recency: 1,
      utility: 1,
      tokenEstimate: 1,
      reasons: ["pinned" as const],
    };
    expect(() =>
      selectMemories({
        candidates: [candidate, candidate],
        tokenBudget: 2,
        now,
        temporaryChat: false,
        mode: "read-only",
      }),
    ).toThrowError(DomainError);
  });

  it("filters expired revisions and honors a zero token budget", () => {
    const memoryId = id<MemoryId>("01K2H000000000000000000028");
    const profileId = id<ProfileId>("01K2H000000000000000000029");
    const expired = createMemoryRevision({
      id: id<MemoryRevisionId>("01K2H00000000000000000002A"),
      memoryId,
      scope: { scope: "global", profileId },
      kind: "summary",
      content: "An expired summary.",
      contentHash: "9".repeat(64),
      confidence: 1,
      status: "active",
      userApproved: true,
      validFrom: now,
      expiresAt: "2026-08-12T01:00:00.000Z",
      createdAt: now,
    });
    const candidate = {
      revision: expired,
      relevance: 1,
      recency: 1,
      utility: 1,
      tokenEstimate: 0,
      reasons: ["query-match" as const],
    };
    expect(
      selectMemories({
        candidates: [candidate],
        tokenBudget: 0,
        now: "2026-08-12T02:00:00.000Z",
        temporaryChat: false,
        mode: "read-only",
      }),
    ).toEqual([]);
  });

  it("rejects chat-phase skills that request write or execute capabilities", () => {
    expect(() =>
      createSkillVersion({
        id: id<SkillVersionId>("01K2H00000000000000000001A"),
        skillId: id<SkillId>("01K2H00000000000000000001B"),
        version: "1.0.0",
        state: "published",
        contentHash: "3".repeat(64),
        manifest: {
          schemaVersion: 1,
          slug: "unsafe-writer",
          displayName: "Unsafe writer",
          description: "Attempts to write files during the chat-only phase.",
          activationGuidance: "Never activate this in chat mode.",
          activationModes: ["manual"],
          requestedCapabilities: ["write_workspace", "execute_process"],
          entrypoint: "SKILL.md",
          resourcePaths: [],
          tags: ["unsafe"],
          negativeExamples: ["Ordinary chat"],
          parameters: {},
        },
        sourceType: "local",
        tokenFootprint: 20,
        availablePaths: ["SKILL.md"],
        maximumTokenFootprint: 1_000,
        now,
      }),
    ).toThrowError(DomainError);
  });

  it("selects published skills deterministically inside the token budget", () => {
    const version = createSkillVersion({
      id: id<SkillVersionId>("01K2H00000000000000000001C"),
      skillId: id<SkillId>("01K2H00000000000000000001D"),
      version: "1.0.0",
      state: "published",
      contentHash: "4".repeat(64),
      manifest: {
        schemaVersion: 1,
        slug: "research-citations",
        displayName: "Research citations",
        description: "Produces transparent, source-grounded research answers.",
        activationGuidance: "Activate for research requests needing citations.",
        activationModes: ["manual", "model-selected"],
        requestedCapabilities: ["read_app_data"],
        entrypoint: "SKILL.md",
        resourcePaths: [],
        tags: ["research"],
        negativeExamples: ["Creative fiction without sources"],
        parameters: {},
      },
      sourceType: "local",
      tokenFootprint: 40,
      availablePaths: ["SKILL.md"],
      maximumTokenFootprint: 1_000,
      now,
    });
    expect(
      selectSkillVersions(
        [{ version, reason: "model-selection", confidence: 0.9 }],
        0.8,
        40,
      ).map((candidate) => candidate.version.id),
    ).toEqual([version.id]);
  });
});

void (id<ModelProfileId>(
  "01K2H00000000000000000000E",
) satisfies ModelProfileId);
void (id<RunId>("01K2H00000000000000000000F") satisfies RunId);
