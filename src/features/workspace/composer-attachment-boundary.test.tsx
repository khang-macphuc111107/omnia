import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttachmentDraftRecord } from "@/lib/desktop";
import { desktop } from "@/lib/desktop";
import { ChatComposer } from "./composer";
import { useWorkspaceStore } from "./store";
import type { AttachmentView, ConversationView } from "./types";

const initialState = useWorkspaceStore.getState();

const attachment: AttachmentView = {
  id: "attachment_0123456789abcdef0123456789abcdef",
  projectId: null,
  messageId: null,
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
  createdAt: "2026-08-13T00:00:00.000Z",
  deletedAt: null,
};

function conversation(): ConversationView {
  return {
    id: "conversation_attachment_boundary",
    activeBranchId: "branch_attachment_boundary",
    title: "Attachment boundary",
    excerpt: "Review the selected source",
    updatedAt: "2026-08-13T00:00:00.000Z",
    updatedLabel: "Now",
    projectId: null,
    projectName: null,
    pinned: false,
    archived: false,
    hasDraft: true,
    unread: false,
    runState: null,
    draft: "Review the selected source",
    messages: [],
  };
}

afterEach(() => {
  useWorkspaceStore.setState(initialState, true);
  delete window.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("composer attachment dispatch boundary", () => {
  it("fails closed instead of silently sending a text-only provider request", () => {
    const activeConversation = conversation();
    useWorkspaceStore.setState({
      activeConversationId: activeConversation.id,
      conversations: [activeConversation],
      attachments: [attachment],
      draftAttachmentIdsByConversation: {
        [activeConversation.id]: [attachment.id],
      },
      activeRun: null,
    });

    render(<ChatComposer />);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/Attachment dispatch is fail-closed/i);
    expect(useWorkspaceStore.getState().activeRun).toBeNull();
    expect(useWorkspaceStore.getState().conversations[0]?.messages).toEqual([]);
  });

  it("hydrates native picker metadata into the draft without enabling provider dispatch", async () => {
    const activeConversation = conversation();
    const draft: AttachmentDraftRecord = {
      id: "attachment_draft_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      projectId: null,
      conversationId: activeConversation.id,
      branchId: activeConversation.activeBranchId,
      state: "open",
      expiresAtMs: Date.now() + 60_000,
      bindingKey: null,
      boundMessageId: null,
      boundRunId: null,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      boundAtMs: null,
      abandonedAtMs: null,
      expiredAtMs: null,
      attachments: [
        {
          id: "attachment_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          draftId: "attachment_draft_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          messageId: null,
          projectId: null,
          filename: "research.pdf",
          mediaType: "application/pdf",
          byteSize: 2_500,
          extractionStatus: "pending",
          createdAtMs: Date.now(),
          deletedAtMs: null,
        },
      ],
    };

    window.__TAURI_INTERNALS__ = {};
    useWorkspaceStore.setState({
      activeConversationId: activeConversation.id,
      conversations: [activeConversation],
      attachments: [],
      draftAttachmentIdsByConversation: {},
      activeRun: null,
    });
    vi.spyOn(desktop, "onRunEvent").mockResolvedValue(() => undefined);
    const picker = vi.spyOn(desktop, "pickAttachments").mockResolvedValue(draft);

    render(<ChatComposer />);
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Attach files" }));

    await waitFor(() => expect(picker).toHaveBeenCalledWith({
      conversationId: activeConversation.id,
      branchId: activeConversation.activeBranchId,
      maxFiles: 20,
    }));
    expect(await screen.findByText("research.pdf")).toBeInTheDocument();
    expect(useWorkspaceStore.getState().draftAttachmentIdsByConversation[activeConversation.id]).toEqual([
      "attachment_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
    expect(useWorkspaceStore.getState().attachments[0]).toMatchObject({
      id: "attachment_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      draftId: "attachment_draft_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "research.pdf",
      state: "processing",
    });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("lets browser users select local preview files without persisting or sending them", async () => {
    const activeConversation = conversation();
    useWorkspaceStore.setState({
      activeConversationId: activeConversation.id,
      conversations: [activeConversation],
      attachments: [],
      draftAttachmentIdsByConversation: {},
      activeRun: null,
    });
    const browserMock = vi.spyOn(desktop, "pickAttachments");
    render(<ChatComposer />);

    const file = new File(["local preview"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Choose files for browser preview"), {
      target: { files: [file] },
    });

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText(/Preview only. These files stay in this tab/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(useWorkspaceStore.getState().attachments).toEqual([]);
    expect(useWorkspaceStore.getState().draftAttachmentIdsByConversation[activeConversation.id]).toBeUndefined();
    expect(browserMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
  });

  it("accepts browser drag-and-drop and shows an honest preview boundary", async () => {
    const activeConversation = conversation();
    useWorkspaceStore.setState({
      activeConversationId: activeConversation.id,
      conversations: [activeConversation],
      attachments: [],
      draftAttachmentIdsByConversation: {},
      activeRun: null,
    });
    render(<ChatComposer />);

    const composerRegion = screen.getByRole("region", { name: "Message composer" });
    const composerShell = composerRegion.querySelector(".composer-shell");
    expect(composerShell).not.toBeNull();
    const file = new File(["dropped locally"], "design.md", { type: "text/markdown" });
    const dataTransfer = { types: ["Files"], files: [file], dropEffect: "none" };
    const dragEnter = createEvent.dragEnter(composerShell as HTMLElement);
    Object.defineProperty(dragEnter, "dataTransfer", { value: dataTransfer });
    fireEvent(composerShell as HTMLElement, dragEnter);
    expect(screen.getByText("Drop files to preview")).toBeInTheDocument();

    const drop = createEvent.drop(composerShell as HTMLElement);
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    fireEvent(composerShell as HTMLElement, drop);

    expect(await screen.findByText("design.md")).toBeInTheDocument();
    expect(screen.queryByText("Drop files to preview")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(useWorkspaceStore.getState().attachments).toEqual([]);
  });
});
