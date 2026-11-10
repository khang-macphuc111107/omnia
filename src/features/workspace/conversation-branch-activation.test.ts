import { afterEach, describe, expect, it, vi } from "vitest";

import { desktop, type ConversationSnapshot } from "@/lib/desktop";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();
const conversationId = "conversation_0123456789abcdef0123456789abcdef";
const rootId = "branch_0123456789abcdef0123456789abcdef";
const childId = "branch_11111111111111111111111111111111";

function selectedChat(draft = "") {
  return {
    ...initialState.conversations[0]!,
    id: conversationId,
    activeBranchId: rootId,
    projectId: null,
    draft,
    hasDraft: draft.length > 0,
    runState: null,
    nativeBranches: [
      { id: rootId, name: null, parentBranchId: null, forkedFromMessageId: null, createdAtMs: 1 },
      { id: childId, name: "Alternative", parentBranchId: rootId, forkedFromMessageId: null, createdAtMs: 2 },
    ],
  } as const;
}

const selectedSnapshot: ConversationSnapshot = {
  conversation: {
    id: conversationId,
    activeBranchId: childId,
    projectId: null,
    title: "Native branch",
    pinnedAtMs: null,
    archivedAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 2,
  },
  branches: [
    { id: rootId, conversationId, parentBranchId: null, forkedFromMessageId: null, name: null, createdAtMs: 1 },
    { id: childId, conversationId, parentBranchId: rootId, forkedFromMessageId: null, name: "Alternative", createdAtMs: 2 },
  ],
  messages: [],
  runs: [],
  attempts: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  delete window.__TAURI_INTERNALS__;
  useWorkspaceStore.setState(initialState, true);
});

describe("native Chat branch selection", () => {
  it("sends expected active branch to native and hydrates only its returned snapshot", async () => {
    window.__TAURI_INTERNALS__ = {};
    const activate = vi.spyOn(desktop, "activateConversationBranch").mockResolvedValue(selectedSnapshot);
    useWorkspaceStore.setState({
      activeConversationId: conversationId,
      conversations: [selectedChat()],
      activeRun: null,
      draftAttachmentIdsByConversation: {},
    });

    await useWorkspaceStore.getState().activateConversationBranch(childId);

    expect(activate).toHaveBeenCalledExactlyOnceWith({
      conversationId,
      branchId: childId,
      expectedActiveBranchId: rootId,
    });
    expect(useWorkspaceStore.getState().conversations[0]).toMatchObject({
      id: conversationId,
      activeBranchId: childId,
      nativeBranches: [{ id: rootId }, { id: childId }],
    });
  });

  it("rejects a branch switch with an unsent draft before any native call", async () => {
    window.__TAURI_INTERNALS__ = {};
    const activate = vi.spyOn(desktop, "activateConversationBranch");
    useWorkspaceStore.setState({
      activeConversationId: conversationId,
      conversations: [selectedChat("Do not lose this")],
      activeRun: null,
      draftAttachmentIdsByConversation: {},
    });

    await expect(useWorkspaceStore.getState().activateConversationBranch(childId))
      .rejects.toThrow(/unsent draft/i);
    expect(activate).not.toHaveBeenCalled();
  });
});
