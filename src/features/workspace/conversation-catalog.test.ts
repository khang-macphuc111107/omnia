import { describe, expect, it } from "vitest";

import type { ConversationSnapshot } from "@/lib/desktop";

import {
  activeMessageIds,
  conversationFromNativeSnapshot,
} from "./conversation-catalog";
import type { AttachmentView } from "./types";

const baseSnapshot: ConversationSnapshot = {
  conversation: {
    id: "conversation_0123456789abcdef0123456789abcdef",
    projectId: "project_0123456789abcdef0123456789abcdef",
    title: "Durable chat",
    activeBranchId: "branch_0123456789abcdef0123456789abcdef",
    pinnedAtMs: null,
    archivedAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 10,
  },
  branches: [
    {
      id: "branch_0123456789abcdef0123456789abcdef",
      conversationId: "conversation_0123456789abcdef0123456789abcdef",
      parentBranchId: null,
      forkedFromMessageId: null,
      name: null,
      createdAtMs: 1,
    },
  ],
  messages: [
    {
      id: "message_0123456789abcdef0123456789abcdef",
      conversationId: "conversation_0123456789abcdef0123456789abcdef",
      branchId: "branch_0123456789abcdef0123456789abcdef",
      parentMessageId: null,
      replacesMessageId: null,
      role: "user",
      status: "complete",
      sequenceNo: 0,
      contentText: "Persist me",
      providerProfileId: null,
      modelId: null,
      finishReason: null,
      createdAtMs: 2,
      updatedAtMs: 2,
      finalizedAtMs: 2,
    },
    {
      id: "message_11111111111111111111111111111111",
      conversationId: "conversation_0123456789abcdef0123456789abcdef",
      branchId: "branch_0123456789abcdef0123456789abcdef",
      parentMessageId: "message_0123456789abcdef0123456789abcdef",
      replacesMessageId: null,
      role: "assistant",
      status: "complete",
      sequenceNo: 1,
      contentText: "Persisted response",
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
      id: "run_0123456789abcdef0123456789abcdef",
      conversationId: "conversation_0123456789abcdef0123456789abcdef",
      branchId: "branch_0123456789abcdef0123456789abcdef",
      userMessageId: "message_0123456789abcdef0123456789abcdef",
      assistantMessageId: "message_11111111111111111111111111111111",
      providerProfileId: "provider_0123456789abcdef0123456789abcdef",
      modelId: "model-a",
      state: "complete",
      errorCode: null,
      startedAtMs: 3,
      completedAtMs: 4,
      createdAtMs: 3,
    },
  ],
  attempts: [],
};

describe("native conversation catalog", () => {
  it("hydrates stable message and run provenance", () => {
    const conversation = conversationFromNativeSnapshot(
      baseSnapshot,
      [
        {
          id: "project_0123456789abcdef0123456789abcdef",
          name: "Native project",
        },
      ],
      [
        {
          id: "provider_0123456789abcdef0123456789abcdef",
          name: "Local runtime",
        },
      ],
    );

    expect(conversation.activeBranchId).toBe(baseSnapshot.conversation.activeBranchId);
    expect(conversation.nativeBranches).toMatchObject([
      { id: baseSnapshot.branches[0]?.id, parentBranchId: null },
    ]);
    expect(conversation.projectName).toBe("Native project");
    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[1]).toMatchObject({
      id: "message_11111111111111111111111111111111",
      role: "assistant",
      content: "Persisted response",
      runId: "run_0123456789abcdef0123456789abcdef",
      status: "complete",
      modelLabel: "Local runtime · model-a",
    });
  });

  it("resolves an inherited branch prefix without flattening sibling history", () => {
    const forked: ConversationSnapshot = {
      ...baseSnapshot,
      conversation: {
        ...baseSnapshot.conversation,
        activeBranchId: "branch_11111111111111111111111111111111",
      },
      branches: [
        ...baseSnapshot.branches,
        {
          id: "branch_11111111111111111111111111111111",
          conversationId: baseSnapshot.conversation.id,
          parentBranchId: baseSnapshot.conversation.activeBranchId,
          forkedFromMessageId: baseSnapshot.messages[0]?.id ?? null,
          name: "Alternative",
          createdAtMs: 5,
        },
      ],
      messages: [
        ...baseSnapshot.messages,
        {
          ...baseSnapshot.messages[1]!,
          id: "message_22222222222222222222222222222222",
          branchId: "branch_11111111111111111111111111111111",
          parentMessageId: baseSnapshot.messages[0]?.id ?? null,
          contentText: "Alternative response",
          sequenceNo: 1,
        },
        {
          ...baseSnapshot.messages[1]!,
          id: "message_33333333333333333333333333333333",
          contentText: "Later sibling response",
          sequenceNo: 2,
        },
      ],
    };

    expect(activeMessageIds(forked)).toEqual([
      "message_0123456789abcdef0123456789abcdef",
      "message_22222222222222222222222222222222",
    ]);
    expect(conversationFromNativeSnapshot(forked, []).excerpt).toBe("Alternative response");
  });

  it("projects only attachments durably bound to each message", () => {
    const boundAttachment: AttachmentView = {
      id: "attachment_0123456789abcdef0123456789abcdef",
      projectId: baseSnapshot.conversation.projectId,
      messageId: baseSnapshot.messages[0]!.id,
      blobId: "a".repeat(64),
      name: "source.pdf",
      kind: "document",
      mediaType: "application/pdf",
      byteSize: 1_024,
      size: "1.0 KB",
      state: "ready",
      extractionStatus: "complete",
      contentHash: "b".repeat(64),
      extractedContentHash: "c".repeat(64),
      extractionVersion: "pdf-v1",
      origin: "picker",
      createdAt: "2026-08-12T00:00:00.000Z",
      deletedAt: null,
    };

    const conversation = conversationFromNativeSnapshot(
      baseSnapshot,
      [],
      [],
      [boundAttachment, { ...boundAttachment, id: "attachment_draft", messageId: null }],
    );

    expect(conversation.messages[0]?.attachments).toEqual([boundAttachment]);
    expect(conversation.messages[1]?.attachments).toEqual([]);
  });

});
