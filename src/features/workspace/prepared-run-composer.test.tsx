import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationSnapshot,
  PrepareConversationRunRequest,
  PreparedConversationRun,
} from "@/lib/desktop";
import { desktop } from "@/lib/desktop";

import { ChatComposer } from "./composer";
import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";

const frozenProviderInputId = "provider_input_0123456789abcdef0123456789abcdef";

function preparedSnapshot(request: PrepareConversationRunRequest): PreparedConversationRun {
  const createdAtMs = 1_786_582_800_000;
  const conversation: ConversationSnapshot = {
    conversation: {
      id: request.conversationId,
      projectId: null,
      title: "Hydrated from native preparation",
      activeBranchId: request.branchId,
      pinnedAtMs: null,
      archivedAtMs: null,
      createdAtMs,
      updatedAtMs: createdAtMs + 1,
    },
    branches: [
      {
        id: request.branchId,
        conversationId: request.conversationId,
        parentBranchId: null,
        forkedFromMessageId: null,
        name: null,
        createdAtMs,
      },
    ],
    messages: [
      {
        id: "message_11111111111111111111111111111111",
        conversationId: request.conversationId,
        branchId: request.branchId,
        parentMessageId: null,
        replacesMessageId: null,
        role: "user",
        status: "complete",
        sequenceNo: 0,
        contentText: "History loaded only from the native snapshot",
        providerProfileId: null,
        modelId: null,
        finishReason: null,
        createdAtMs,
        updatedAtMs: createdAtMs,
        finalizedAtMs: createdAtMs,
      },
      {
        id: request.userMessageId,
        conversationId: request.conversationId,
        branchId: request.branchId,
        parentMessageId: "message_11111111111111111111111111111111",
        replacesMessageId: null,
        role: "user",
        status: "complete",
        sequenceNo: 1,
        contentText: request.prompt,
        providerProfileId: null,
        modelId: null,
        finishReason: null,
        createdAtMs: createdAtMs + 1,
        updatedAtMs: createdAtMs + 1,
        finalizedAtMs: createdAtMs + 1,
      },
      {
        id: request.assistantMessageId,
        conversationId: request.conversationId,
        branchId: request.branchId,
        parentMessageId: request.userMessageId,
        replacesMessageId: null,
        role: "assistant",
        status: "draft",
        sequenceNo: 2,
        contentText: "",
        providerProfileId: request.providerProfileId,
        modelId: request.model,
        finishReason: null,
        createdAtMs: createdAtMs + 1,
        updatedAtMs: createdAtMs + 1,
        finalizedAtMs: null,
      },
    ],
    runs: [
      {
        id: request.runId,
        conversationId: request.conversationId,
        branchId: request.branchId,
        userMessageId: request.userMessageId,
        assistantMessageId: request.assistantMessageId,
        providerProfileId: request.providerProfileId,
        modelId: request.model,
        state: "queued",
        errorCode: null,
        startedAtMs: null,
        completedAtMs: null,
        createdAtMs: createdAtMs + 1,
      },
    ],
    attempts: [
      {
        id: request.attemptId,
        generationId: request.runId,
        ordinal: 1,
        providerProfileId: request.providerProfileId,
        modelId: request.model,
        state: "created",
        acceptedByProvider: "false",
        idempotencySupported: false,
        remoteRequestId: null,
        errorCode: null,
        startedAtMs: null,
        completedAtMs: null,
        createdAtMs: createdAtMs + 1,
      },
    ],
  };

  return {
    conversation,
    providerInput: {
      id: frozenProviderInputId,
      attemptId: request.attemptId,
      runId: request.runId,
      providerProfileId: request.providerProfileId,
      model: request.model,
      contentSha256: "a".repeat(64),
      messageCount: 2,
      createdAtMs: createdAtMs + 1,
    },
  };
}

describe("prepared run composer dispatch", () => {
  let originalState: ReturnType<typeof useWorkspaceStore.getState>;

  beforeEach(() => {
    originalState = useWorkspaceStore.getState();
    window.__TAURI_INTERNALS__ = {};

    const conversation: ConversationView = {
      id: "conversation_22222222222222222222222222222222",
      activeBranchId: "branch_22222222222222222222222222222222",
      title: "Renderer copy that native will replace",
      excerpt: "Stale renderer history",
      updatedAt: "2026-08-13T00:00:00.000Z",
      updatedLabel: "Now",
      projectId: null,
      projectName: null,
      pinned: false,
      archived: false,
      hasDraft: true,
      unread: false,
      runState: null,
      draft: "Dispatch the prepared provider input",
      messages: [],
    };

    useWorkspaceStore.setState({
      activeConversationId: conversation.id,
      conversations: [conversation],
      activeRun: null,
      attachments: [],
      draftAttachmentIdsByConversation: {},
      modelProfileId: "quality",
    });
  });

  afterEach(() => {
    useWorkspaceStore.setState(originalState, true);
    delete window.__TAURI_INTERNALS__;
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("hydrates the native snapshot and dispatches only the two opaque identifiers", async () => {
    vi.spyOn(desktop, "onRunEvent").mockResolvedValue(() => undefined);
    const prepare = vi
      .spyOn(desktop, "prepareConversationRun")
      .mockImplementation(async (request) => preparedSnapshot(request));
    const dispatch = vi.spyOn(desktop, "startPreparedAttempt").mockResolvedValue();

    render(<ChatComposer />);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

    const preparedRequest = prepare.mock.calls[0]?.[0];
    const dispatchRequest = dispatch.mock.calls[0]?.[0];
    expect(preparedRequest).toBeDefined();
    expect(dispatchRequest).toEqual({
      attemptId: preparedRequest?.attemptId,
      frozenProviderInputId,
    });
    expect(Object.keys(dispatchRequest ?? {}).sort()).toEqual([
      "attemptId",
      "frozenProviderInputId",
    ]);
    expect(dispatchRequest).not.toHaveProperty("messages");
    expect(dispatchRequest).not.toHaveProperty("parameters");
    expect(dispatchRequest).not.toHaveProperty("model");
    expect(dispatchRequest).not.toHaveProperty("profileId");
    expect(dispatchRequest).not.toHaveProperty("runId");

    const hydrated = useWorkspaceStore
      .getState()
      .conversations.find((candidate) => candidate.id === preparedRequest?.conversationId);
    expect(hydrated?.title).toBe("Hydrated from native preparation");
    expect(hydrated?.messages.map((message) => message.content)).toContain(
      "History loaded only from the native snapshot",
    );
  });
});
