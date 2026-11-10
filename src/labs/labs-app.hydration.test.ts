import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AttachmentDraftRecord,
  AttachmentRecord,
  ConversationSnapshot,
} from "@/lib/desktop";
import { desktop } from "@/lib/desktop";

import { hydrateNativeWorkspace } from "./labs-app";
import { useWorkspaceStore } from "@/features/workspace/store";

const initialState = useWorkspaceStore.getState();

function snapshot(
  conversationId = "conversation_hydration",
  branchId = "branch_hydration",
): ConversationSnapshot {
  return {
    conversation: {
      id: conversationId,
      projectId: null,
      title: "Hydration test",
      activeBranchId: branchId,
      pinnedAtMs: null,
      archivedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 2,
    },
    branches: [
      {
        id: branchId,
        conversationId,
        parentBranchId: null,
        forkedFromMessageId: null,
        name: "Main",
        createdAtMs: 1,
      },
    ],
    messages: [],
    runs: [],
    attempts: [],
  };
}

function attachment(
  id: string,
  patch: Partial<AttachmentRecord> = {},
): AttachmentRecord {
  return {
    id,
    draftId: "draft_hydration",
    messageId: null,
    projectId: null,
    filename: `${id}.pdf`,
    mediaType: "application/pdf",
    byteSize: 128,
    extractionStatus: "complete",
    createdAtMs: 10,
    deletedAtMs: null,
    ...patch,
  };
}

function draft(
  attachments: AttachmentRecord[],
  patch: Partial<AttachmentDraftRecord> = {},
): AttachmentDraftRecord {
  return {
    id: "draft_hydration",
    projectId: null,
    conversationId: "conversation_hydration",
    branchId: "branch_hydration",
    state: "open",
    expiresAtMs: 60_000,
    bindingKey: null,
    boundMessageId: null,
    boundRunId: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    boundAtMs: null,
    abandonedAtMs: null,
    expiredAtMs: null,
    attachments,
    ...patch,
  };
}

function mockNativeCatalog(
  snapshots: ConversationSnapshot[],
  attachments: AttachmentRecord[],
  drafts: AttachmentDraftRecord[] | Error,
): void {
  vi.spyOn(desktop, "listProjects").mockResolvedValue([]);
  vi.spyOn(desktop, "listWorkspaceGrants").mockResolvedValue([]);
  vi.spyOn(desktop, "listConversations").mockResolvedValue(snapshots);
  vi.spyOn(desktop, "listProviderProfiles").mockResolvedValue([]);
  vi.spyOn(desktop, "listAttachments").mockResolvedValue(attachments);
  vi.spyOn(desktop, "listAttachmentDrafts").mockImplementation(async () => {
    if (drafts instanceof Error) throw drafts;
    return drafts;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  useWorkspaceStore.setState(initialState, true);
  document.body.innerHTML = "";
});

describe("native workspace startup hydration", () => {
  it("restores only live attachments from an open draft in the exact active branch", async () => {
    const active = snapshot();
    const liveId = "attachment_live";
    const missingId = "attachment_missing";
    const foreignBranch = draft(
      [attachment("attachment_foreign", { draftId: "draft_foreign" })],
      { id: "draft_foreign", branchId: "branch_other" },
    );
    const terminal = draft(
      [attachment("attachment_terminal", { draftId: "draft_terminal" })],
      { id: "draft_terminal", state: "abandoned" },
    );
    const open = draft([
      attachment(liveId),
      attachment(missingId),
      attachment("attachment_deleted", { deletedAtMs: 99 }),
    ]);
    mockNativeCatalog(
      [active],
      [attachment(liveId)],
      [open, foreignBranch, terminal],
    );

    useWorkspaceStore.getState().prepareDesktopPreview();
    await hydrateNativeWorkspace();

    const state = useWorkspaceStore.getState();
    expect(state.activeConversationId).toBe(active.conversation.id);
    expect(state.attachments.map((item) => item.id)).toEqual([liveId]);
    expect(state.draftAttachmentIdsByConversation).toEqual({
      [active.conversation.id]: [liveId],
    });
  });

  it("fails closed when draft metadata cannot be read and keeps the conversation usable", async () => {
    const active = snapshot("conversation_metadata_error", "branch_metadata_error");
    mockNativeCatalog(
      [active],
      [attachment("attachment_catalogued")],
      new Error("native draft metadata unavailable"),
    );

    useWorkspaceStore.getState().prepareDesktopPreview();
    await hydrateNativeWorkspace();

    const state = useWorkspaceStore.getState();
    expect(state.activeConversationId).toBe(active.conversation.id);
    expect(state.conversations).toHaveLength(1);
    expect(state.draftAttachmentIdsByConversation).toEqual({});
  });

  it("clears stale attachment state when the native workspace snapshot fails", async () => {
    vi.spyOn(desktop, "listProjects").mockResolvedValue([]);
    vi.spyOn(desktop, "listWorkspaceGrants").mockResolvedValue([]);
    vi.spyOn(desktop, "listConversations").mockRejectedValue(
      new Error("native conversation snapshot unavailable"),
    );
    vi.spyOn(desktop, "listProviderProfiles").mockResolvedValue([]);
    vi.spyOn(desktop, "listAttachments").mockResolvedValue([
      attachment("attachment_should_not_survive"),
    ]);

    useWorkspaceStore.setState({
      activeConversationId: "conversation_stale",
      attachments: [
        {
          id: "attachment_stale",
          projectId: null,
          messageId: null,
          blobId: "blob_stale",
          name: "stale.pdf",
          kind: "document",
          mediaType: "application/pdf",
          byteSize: 10,
          size: "10 B",
          state: "ready",
          extractionStatus: "complete",
          contentHash: "hash_stale",
          extractedContentHash: null,
          extractionVersion: null,
          origin: "picker",
          createdAt: "2026-09-12T00:00:00.000Z",
          deletedAt: null,
        },
      ],
      draftAttachmentIdsByConversation: {
        conversation_stale: ["attachment_stale"],
      },
    });

    await hydrateNativeWorkspace();

    const state = useWorkspaceStore.getState();
    expect(state.conversations).toEqual([]);
    expect(state.attachments).toEqual([]);
    expect(state.draftAttachmentIdsByConversation).toEqual({});
  });
});
