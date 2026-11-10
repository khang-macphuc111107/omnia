import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatComposer } from "./composer";
import { useWorkspaceStore } from "./store";
import type { AttachmentView, ConversationView } from "./types";

function renderWithEditorTools() {
  const result = render(<ChatComposer />);
  fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Show more composer tools" }));
  return result;
}

const initialState = useWorkspaceStore.getState();

function conversation(draft: string): ConversationView {
  return {
    id: "conversation_context_preflight",
    activeBranchId: "branch_context_preflight",
    title: "Context preflight",
    excerpt: draft,
    updatedAt: "2026-09-19T00:00:00.000Z",
    updatedLabel: "Now",
    projectId: "project-omnia",
    projectName: "Omnia Desktop",
    pinned: false,
    archived: false,
    hasDraft: draft.length > 0,
    unread: false,
    runState: null,
    draft,
    messages: [],
  };
}

afterEach(() => {
  useWorkspaceStore.setState(initialState, true);
  document.body.innerHTML = "";
});

describe("ChatComposer context preflight entry", () => {
  it("surfaces selected native attachments as a planned, renderer-only context source", () => {
    const activeConversation: ConversationView = {
      ...conversation("Review the selected source."),
      projectId: null,
      projectName: null,
    };
    const selectedAttachment: AttachmentView = {
      id: "attachment_context_preflight",
      draftId: "draft_context_preflight",
      projectId: null,
      messageId: null,
      blobId: "a".repeat(64),
      name: "source.pdf",
      kind: "document",
      mediaType: "application/pdf",
      byteSize: 4_096,
      size: "4.1 KB",
      state: "ready",
      extractionStatus: "complete",
      contentHash: "b".repeat(64),
      extractedContentHash: "c".repeat(64),
      extractionVersion: "pdf-v1",
      origin: "picker",
      createdAt: "2026-09-19T00:00:00.000Z",
      deletedAt: null,
    };
    useWorkspaceStore.setState({
      activeConversationId: activeConversation.id,
      conversations: [activeConversation],
      attachments: [selectedAttachment],
      draftAttachmentIdsByConversation: {
        [activeConversation.id]: [selectedAttachment.id],
      },
      activeRun: null,
    });

    renderWithEditorTools();
    fireEvent.click(screen.getByRole("button", { name: /context preflight/i }));

    const region = screen.getByRole("region", { name: /preflight before compile/i });
    expect(region).toHaveTextContent("Attachments");
    expect(region).toHaveTextContent("1 item");
    expect(region).toHaveTextContent("Planned");
    expect(region).toHaveTextContent(/immutable context freeze remain unverified/i);
    expect(region).toHaveTextContent(/~1[,.]024 renderer-est\. tokens/i);
  });

  it("keeps a standalone Chat local even when another Project is active in navigation", () => {
    const activeConversation: ConversationView = {
      ...conversation("Keep this conversation local."),
      projectId: null,
      projectName: null,
    };
    useWorkspaceStore.setState({
      activeConversationId: activeConversation.id,
      activeProjectId: "project-omnia",
      conversations: [activeConversation],
      activeRun: null,
    });

    renderWithEditorTools();

    const scope = screen.getByRole("button", { name: "Context scope: Standalone chat" });
    expect(scope).toHaveTextContent("Standalone chat");
    expect(scope).toHaveTextContent("Conversation-local");
    fireEvent.click(scope);

    const region = screen.getByRole("region", { name: /preflight before compile/i });
    expect(region).toHaveTextContent("Standalone chat");
    expect(region).not.toHaveTextContent("Omnia Desktop");
  });

  it("opens a renderer-local context admission rehearsal for the active draft", () => {
    const activeConversation = conversation("Summarize the current harness plan.");
    useWorkspaceStore.setState({
      activeConversationId: activeConversation.id,
      activeProjectId: "project-omnia",
      conversations: [activeConversation],
      activeRun: null,
    });

    renderWithEditorTools();

    const trigger = screen.getByRole("button", { name: /context preflight/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);

    const region = screen.getByRole("region", { name: /preflight before compile/i });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(region).toHaveTextContent("Omnia Desktop");
    expect(region).toHaveTextContent("Current draft");
    expect(region).toHaveTextContent("Renderer-local");
    expect(region).toHaveTextContent("Immutable context freeze");
    expect(screen.getByRole("button", { name: /run preflight/i })).toBeInTheDocument();
  });

  it("keeps context and formatter popovers mutually exclusive", () => {
    const activeConversation = conversation("Keep the composer overlays readable.");
    useWorkspaceStore.setState({
      activeConversationId: activeConversation.id,
      activeProjectId: "project-omnia",
      conversations: [activeConversation],
      activeRun: null,
    });

    renderWithEditorTools();

    fireEvent.click(screen.getByRole("button", { name: "More formatting" }));
    expect(screen.getByRole("menu", { name: "More Markdown formatting" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Context scope:/i }));
    expect(screen.queryByRole("menu", { name: "More Markdown formatting" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: /preflight before compile/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More formatting" }));
    expect(screen.queryByRole("region", { name: /preflight before compile/i })).not.toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "More Markdown formatting" })).toBeInTheDocument();
  });

  it("shows the Chat's Project health in the scope chip without claiming compilation", () => {
    const activeConversation = conversation("Review the project context.");
    useWorkspaceStore.setState({
      activeConversationId: activeConversation.id,
      activeProjectId: "project-omnia",
      conversations: [activeConversation],
      activeRun: null,
    });

    renderWithEditorTools();

    const scope = screen.getByRole("button", { name: "Context scope: Omnia Desktop" });
    expect(scope).toHaveTextContent("Omnia Desktop");
    expect(scope).toHaveTextContent("Not compiled");
    expect(scope).toHaveAttribute("title", expect.stringMatching(/no native context compiler revision/i));
  });

  it("keeps a stale Project reference visible without treating it as active context", () => {
    const activeConversation: ConversationView = {
      ...conversation("Recover the missing project link."),
      projectName: "Archived Project",
    };
    useWorkspaceStore.setState({
      activeConversationId: activeConversation.id,
      activeProjectId: "project-missing",
      conversations: [{ ...activeConversation, projectId: "project-missing" }],
      projects: [],
      activeRun: null,
    });

    renderWithEditorTools();

    const scope = screen.getByRole("button", { name: "Context scope: Archived Project" });
    expect(scope).toHaveTextContent("Project not in snapshot");
    expect(scope).toHaveAttribute("title", expect.stringMatching(/missing from the current renderer snapshot/i));
    fireEvent.click(scope);
    expect(screen.getByRole("region", { name: /preflight before compile/i })).toHaveTextContent("Archived Project · unavailable");
  });

  it("can evaluate and close the rehearsal without starting a run", () => {
    const activeConversation = conversation("Check the provider routing notes.");
    useWorkspaceStore.setState({
      activeConversationId: activeConversation.id,
      activeProjectId: "project-omnia",
      conversations: [activeConversation],
      activeRun: null,
    });

    renderWithEditorTools();
    fireEvent.click(screen.getByRole("button", { name: /context preflight/i }));
    const region = screen.getByRole("region", { name: /preflight before compile/i });
    fireEvent.click(within(region).getByRole("button", { name: /run preflight/i }));
    expect(region).toHaveTextContent(/preflight evaluated from the current renderer snapshot/i);
    expect(useWorkspaceStore.getState().activeRun).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /hide context preflight/i }));
    expect(screen.queryByRole("region", { name: /preflight before compile/i })).not.toBeInTheDocument();
  });

  it("keeps the selected delivery mode while the preflight panel is toggled", () => {
    const activeConversation = conversation("Choose a compact context route.");
    useWorkspaceStore.setState({
      activeConversationId: activeConversation.id,
      activeProjectId: "project-omnia",
      conversations: [activeConversation],
      activeRun: null,
    });

    renderWithEditorTools();
    fireEvent.click(screen.getByRole("button", { name: /context preflight/i }));
    const region = screen.getByRole("region", { name: /preflight before compile/i });
    const deliveryMode = within(region).getByRole("combobox", { name: "Context delivery mode" });

    fireEvent.change(deliveryMode, { target: { value: "summary-plus-sources" } });
    expect(deliveryMode).toHaveValue("summary-plus-sources");
    fireEvent.click(screen.getByRole("button", { name: /hide context preflight/i }));
    expect(screen.queryByRole("region", { name: /preflight before compile/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /context preflight/i }));
    expect(within(screen.getByRole("region", { name: /preflight before compile/i })).getByRole("combobox", { name: "Context delivery mode" })).toHaveValue("summary-plus-sources");
  });
});
