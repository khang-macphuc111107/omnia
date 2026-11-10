import { describe, expect, it } from "vitest";

import {
  buildPlanChatIdempotencyKey,
  claimPlanChatIdempotencyKey,
  createPlanChatOperationPreview,
  evaluatePlanChatOperationPreflight,
  fingerprintPlanChatDraft,
  resolvePlanChatOperation,
  updatePlanChatOperationPhase,
} from "./plan-chat-operation";

describe("Plan -> Chat operation preview", () => {
  it("creates a scoped, renderer-local operation envelope with a stable draft fingerprint", () => {
    const draft = "Task: Map scope\nAcceptance: Review the output.";
    const operation = createPlanChatOperationPreview({
      projectId: "project-omnia",
      taskId: "task-scope",
      taskTitle: "Map scope",
      draft,
      expectedPlanRevisionId: null,
      now: 1_000,
    });

    expect(operation).toMatchObject({
      schema: "omnia.plan-chat-operation.preview.v1",
      operationType: "project-plan.new-chat",
      expectedProjectId: "project-omnia",
      expectedTaskId: "task-scope",
      expectedPlanRevisionId: null,
      taskTitle: "Map scope",
      draftLength: draft.length,
      draftHash: fingerprintPlanChatDraft(draft),
      idempotencyKey: expect.stringMatching(/^plan-chat-key-/),
      atomicContract: {
        steps: ["create-chat", "stage-draft"],
        destinationRule: "same-project",
        draftRule: "empty-only",
        partialFailurePolicy: "retain-chat-report-draft-failure",
        nativeAtomicity: "planned",
      },
      phase: "ready",
      outcome: "pending",
    });
    expect(operation.operationId).toMatch(/^plan-chat-op-/);
    expect(operation.boundary).toMatch(/no atomic native receipt/i);
  });

  it("keeps retry identity stable for the same intent and changes it for a new revision", () => {
    const input = {
      projectId: "project-omnia",
      taskId: "task-scope",
      draft: "Review scope.",
      expectedPlanRevisionId: "revision-3",
    } as const;
    expect(buildPlanChatIdempotencyKey(input)).toBe(buildPlanChatIdempotencyKey({ ...input }));
    expect(buildPlanChatIdempotencyKey({ ...input, expectedPlanRevisionId: "revision-4" })).not.toBe(buildPlanChatIdempotencyKey(input));
    expect(buildPlanChatIdempotencyKey({ ...input, draft: "Review scope and risks." })).not.toBe(buildPlanChatIdempotencyKey(input));
  });

  it("claims a stable idempotency key once per renderer session intent", () => {
    const claimed = new Set<string>();
    const key = buildPlanChatIdempotencyKey({
      projectId: "project-omnia",
      taskId: "task-scope",
      draft: "Review scope.",
    });

    expect(claimPlanChatIdempotencyKey(claimed, key)).toBe(true);
    expect(claimPlanChatIdempotencyKey(claimed, key)).toBe(false);
    expect(claimPlanChatIdempotencyKey(claimed, `${key}-new-intent`)).toBe(true);
    expect(claimed.size).toBe(2);
  });

  it("tracks the two renderer steps before resolving the operation", () => {
    const operation = createPlanChatOperationPreview({
      projectId: "project-omnia",
      taskId: "task-scope",
      taskTitle: "Map scope",
      draft: "Review scope.",
      now: 2_000,
    });

    const creating = updatePlanChatOperationPhase(operation, "creating-chat");
    expect(creating).toMatchObject({ phase: "creating-chat", outcome: "pending", createdChat: false });
    const staging = updatePlanChatOperationPhase(creating, "staging-draft");
    expect(staging).toMatchObject({ phase: "staging-draft", outcome: "pending", createdChat: false });
  });

  it("distinguishes a completed handoff from a Chat-created partial failure", () => {
    const operation = createPlanChatOperationPreview({
      projectId: "project-omnia",
      taskId: "task-scope",
      taskTitle: "Map scope",
      draft: "Review scope.",
      now: 3_000,
    });

    expect(resolvePlanChatOperation(operation, "staged", { conversationId: "conversation-1" })).toMatchObject({
      phase: "staged",
      outcome: "staged",
      conversationId: "conversation-1",
      createdChat: true,
      draftStaged: true,
    });
    expect(resolvePlanChatOperation(operation, "chat-created-draft-failed", {
      conversationId: "conversation-2",
      diagnostic: "The destination became occupied.",
    })).toMatchObject({
      phase: "partial",
      outcome: "chat-created-draft-failed",
      conversationId: "conversation-2",
      createdChat: true,
      draftStaged: false,
      diagnostic: "The destination became occupied.",
    });
  });

  it("requires the visible Project, task, draft, destination, and empty-target facts before proceeding", () => {
    const draft = "Review scope.";
    const operation = createPlanChatOperationPreview({
      projectId: "project-omnia",
      taskId: "task-scope",
      taskTitle: "Map scope",
      draft,
      now: 4_000,
    });

    const ready = evaluatePlanChatOperationPreflight(operation, {
      currentProjectId: "project-omnia",
      currentTaskId: "task-scope",
      currentDraft: draft,
      destinationProjectExists: true,
      destinationProjectArchived: false,
      targetConversationDraft: "",
    });
    expect(ready.status).toBe("ready");
    expect(ready.canProceed).toBe(true);
    expect(ready.checks.every((check) => check.state === "pass")).toBe(true);

    const stale = evaluatePlanChatOperationPreflight(operation, {
      currentProjectId: "project-other",
      currentTaskId: "task-other",
      currentDraft: "Review scope and risks.",
      destinationProjectExists: true,
      targetConversationDraft: "Existing draft",
    });
    expect(stale.status).toBe("blocked");
    expect(stale.canProceed).toBe(false);
    expect(stale.blockingReason).toMatch(/Expected Project/);
    expect(stale.checks.filter((check) => check.state === "blocked").map((check) => check.id)).toEqual([
      "same-project",
      "same-task",
      "draft-unchanged",
      "empty-target",
    ]);
  });

  it("keeps missing host facts in review instead of claiming atomic readiness", () => {
    const operation = createPlanChatOperationPreview({
      projectId: "project-omnia",
      taskId: "task-scope",
      taskTitle: "Map scope",
      draft: "Review scope.",
      now: 5_000,
    });
    const result = evaluatePlanChatOperationPreflight(operation);
    expect(result.status).toBe("review");
    expect(result.canProceed).toBe(false);
    expect(result.checks.filter((check) => check.state === "review").map((check) => check.id)).toEqual([
      "same-project",
      "same-task",
      "draft-unchanged",
      "destination-available",
      "empty-target",
    ]);
    expect(result.boundary).toMatch(/does not prove native transaction atomicity/i);
  });

  it("treats explicit null host facts as unknown instead of dereferencing them", () => {
    const operation = createPlanChatOperationPreview({
      projectId: "project-omnia",
      taskId: "task-scope",
      taskTitle: "Map scope",
      draft: "Review scope.",
      now: 5_500,
    });
    const result = evaluatePlanChatOperationPreflight(operation, {
      currentProjectId: null,
      currentDraft: null,
      targetConversationDraft: null,
    });
    expect(result.status).toBe("blocked");
    expect(result.checks.find((check) => check.id === "draft-unchanged")?.state).toBe("review");
    expect(result.checks.find((check) => check.id === "empty-target")?.state).toBe("review");
  });

  it("rejects a receipt that has already advanced, preventing preview replay", () => {
    const operation = createPlanChatOperationPreview({
      projectId: "project-omnia",
      taskId: "task-scope",
      taskTitle: "Map scope",
      draft: "Review scope.",
      now: 6_000,
    });
    const advanced = updatePlanChatOperationPhase(operation, "creating-chat");
    const result = evaluatePlanChatOperationPreflight(advanced, {
      currentProjectId: "project-omnia",
      currentTaskId: "task-scope",
      currentDraft: "Review scope.",
      destinationProjectExists: true,
      targetConversationDraft: "",
    });
    expect(result.status).toBe("blocked");
    expect(result.blockingReason).toMatch(/already advanced or resolved/i);
  });
});
