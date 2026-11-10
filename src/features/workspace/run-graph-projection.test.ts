import { describe, expect, it } from "vitest";

import type { ConversationSnapshot } from "@/lib/desktop";

import { projectNativeRunGraph } from "./run-graph-projection";

const conversationId = "conversation_0123456789abcdef0123456789abcdef";
const projectId = "project_0123456789abcdef0123456789abcdef";
const branchId = "branch_0123456789abcdef0123456789abcdef";
const runId = "run_0123456789abcdef0123456789abcdef";
const attemptId = "attempt_0123456789abcdef0123456789abcdef";
const userMessageId = "message_0123456789abcdef0123456789abcdef";
const assistantMessageId = "message_11111111111111111111111111111111";

function snapshot(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    conversation: {
      id: conversationId,
      projectId,
      title: "Durable chat",
      activeBranchId: branchId,
      pinnedAtMs: null,
      archivedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 20,
    },
    branches: [
      {
        id: branchId,
        conversationId,
        parentBranchId: null,
        forkedFromMessageId: null,
        name: null,
        createdAtMs: 1,
      },
    ],
    messages: [
      {
        id: userMessageId,
        conversationId,
        branchId,
        parentMessageId: null,
        replacesMessageId: null,
        role: "user",
        status: "complete",
        sequenceNo: 0,
        contentText: "Hello",
        providerProfileId: null,
        modelId: null,
        finishReason: null,
        createdAtMs: 2,
        updatedAtMs: 2,
        finalizedAtMs: 2,
      },
      {
        id: assistantMessageId,
        conversationId,
        branchId,
        parentMessageId: userMessageId,
        replacesMessageId: null,
        role: "assistant",
        status: "complete",
        sequenceNo: 1,
        contentText: "Hi",
        providerProfileId: "provider_0123456789abcdef0123456789abcdef",
        modelId: "model-a",
        finishReason: "stop",
        createdAtMs: 3,
        updatedAtMs: 4,
        finalizedAtMs: 4,
      },
    ],
    runs: [
      {
        id: runId,
        conversationId,
        branchId,
        userMessageId,
        assistantMessageId,
        providerProfileId: "provider_0123456789abcdef0123456789abcdef",
        modelId: "model-a",
        state: "complete",
        errorCode: null,
        startedAtMs: 3,
        completedAtMs: 4,
        createdAtMs: 3,
      },
    ],
    attempts: [
      {
        id: attemptId,
        generationId: runId,
        ordinal: 1,
        providerProfileId: "provider_0123456789abcdef0123456789abcdef",
        modelId: "model-a",
        state: "complete",
        acceptedByProvider: "true",
        idempotencySupported: true,
        remoteRequestId: "remote-1",
        errorCode: null,
        startedAtMs: 3,
        completedAtMs: 4,
        createdAtMs: 3,
      },
    ],
    ...overrides,
  };
}

describe("native run graph projection", () => {
  it("keeps only native lineage and explicitly reports omitted kernel layers", () => {
    const projection = projectNativeRunGraph(snapshot());

    expect(projection.completeness).toBe("partial");
    expect(projection.root).toMatchObject({ id: projectId, kind: "project", parentId: null });
    expect(projection.lineages).toHaveLength(1);
    expect(projection.lineages[0]).toMatchObject({
      run: { id: runId },
      branch: { id: branchId },
      userMessage: { id: userMessageId },
      assistantMessage: { id: assistantMessageId },
      attempts: [{ id: attemptId, ordinal: 1 }],
    });
    expect(projection.integrityIssues).toEqual([]);
    expect(projection.capabilityGaps.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "task",
        "iteration",
        "item-event",
        "event-journal",
        "context-snapshot",
        "execution-environment",
      ]),
    );
    expect(projection.lineages[0]?.attempts[0]?.idempotencySupported).toBe(true);
    expect(projection.nodes.some((node) => node.id === userMessageId && node.kind === "message")).toBe(true);
  });

  it("orders rows deterministically and does not trust database return order", () => {
    const olderRun = { ...snapshot().runs[0]!, id: "run_00000000000000000000000000000001", createdAtMs: 1 };
    const newerRun = { ...snapshot().runs[0]!, id: "run_ffffffffffffffffffffffffffffffff", createdAtMs: 8 };
    const olderAttempt = { ...snapshot().attempts[0]!, id: "attempt_00000000000000000000000000000001", generationId: olderRun.id };
    const newerAttempt = { ...snapshot().attempts[0]!, id: "attempt_ffffffffffffffffffffffffffffffff", generationId: newerRun.id };
    const projection = projectNativeRunGraph(
      snapshot({
        runs: [newerRun, olderRun],
        attempts: [newerAttempt, olderAttempt],
      }),
    );

    expect(projection.lineages.map((lineage) => lineage.run.id)).toEqual([
      olderRun.id,
      newerRun.id,
    ]);
    expect(projection.lineages.map((lineage) => lineage.attempts[0]?.id)).toEqual([
      olderAttempt.id,
      newerAttempt.id,
    ]);
  });

  it("reports cross-branch and orphan-attempt corruption instead of repairing it", () => {
    const foreignBranch = "branch_ffffffffffffffffffffffffffffffff";
    const orphanAttempt = {
      ...snapshot().attempts[0]!,
      id: "attempt_ffffffffffffffffffffffffffffffff",
      generationId: "run_orphan",
      ordinal: 3,
    };
    const projection = projectNativeRunGraph(
      snapshot({
        runs: [{ ...snapshot().runs[0]!, branchId: foreignBranch }],
        messages: [{ ...snapshot().messages[1]!, branchId }],
        attempts: [orphanAttempt],
      }),
    );

    expect(projection.completeness).toBe("invalid");
    expect(projection.integrityIssues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "run-branch-missing",
        "run-user-mismatch",
        "run-assistant-mismatch",
        "attempt-run-missing",
      ]),
    );
    expect(projection.lineages[0]?.branch).toBeNull();
    expect(projection.lineages[0]?.assistantMessage).toBeNull();
  });

  it("leaves invalid branch ownership detached instead of repairing lineage", () => {
    const missingParent = "branch_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const foreignConversation = "conversation_ffffffffffffffffffffffffffffffff";
    const detachedBranch = {
      ...snapshot().branches[0]!,
      conversationId: foreignConversation,
      parentBranchId: missingParent,
    };
    const projection = projectNativeRunGraph(
      snapshot({
        branches: [detachedBranch],
        messages: [{ ...snapshot().messages[0]!, conversationId: foreignConversation }],
        runs: [{ ...snapshot().runs[0]!, conversationId: foreignConversation }],
      }),
    );

    expect(projection.completeness).toBe("invalid");
    expect(projection.nodes.find((node) => node.id === branchId)?.parentId).toBeNull();
    expect(projection.nodes.find((node) => node.id === userMessageId)?.parentId).toBeNull();
    expect(projection.nodes.find((node) => node.id === runId)?.parentId).toBeNull();
    expect(projection.integrityIssues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "branch-conversation-mismatch",
        "branch-parent-missing",
        "message-conversation-mismatch",
        "run-conversation-mismatch",
      ]),
    );
  });

  it("treats projectless conversations as a supported root without inventing a project", () => {
    const projection = projectNativeRunGraph(
      snapshot({
        conversation: { ...snapshot().conversation, projectId: null },
      }),
    );

    expect(projection.root).toMatchObject({ id: conversationId, kind: "conversation", parentId: null });
    expect(projection.capabilityGaps.map((entry) => entry.code)).not.toContain("project-root");
    expect(projection.integrityIssues).toEqual([]);
  });

  it("reports branch cycles and duplicate attempt identities exactly once", () => {
    const cyclicBranch = {
      ...snapshot().branches[0]!,
      parentBranchId: branchId,
    };
    const duplicatedAttempt = snapshot().attempts[0]!;
    const projection = projectNativeRunGraph(
      snapshot({
        branches: [cyclicBranch],
        attempts: [duplicatedAttempt, { ...duplicatedAttempt }],
      }),
    );

    expect(projection.completeness).toBe("invalid");
    expect(projection.integrityIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "branch-parent-cycle", branchId }),
        expect.objectContaining({ code: "attempt-duplicate", attemptId }),
      ]),
    );
    expect(
      projection.integrityIssues.filter(
        (entry) => entry.code === "attempt-duplicate" && entry.attemptId === attemptId,
      ),
    ).toHaveLength(1);
  });
});
