import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CommandPalette } from "./command-palette";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("Phase 2 command palette", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("supports prefix-scoped search for commands, chats, and projects", () => {
    useWorkspaceStore.setState({
      commandPaletteOpen: true,
      conversations: [
        {
          id: "conversation_phase2",
          activeBranchId: "branch_phase2",
          title: "Harness chat",
          excerpt: "Review command palette behavior",
          updatedAt: "2026-09-16T00:00:00.000Z",
          updatedLabel: "Now",
          projectId: null,
          projectName: null,
          pinned: false,
          archived: false,
          hasDraft: false,
          unread: false,
          runState: null,
          draft: "",
          messages: [],
        },
      ],
      projects: [
        {
          id: "project_phase2",
          name: "Palette project",
          description: "Command palette acceptance surface",
          accent: "#2563eb",
          instructions: "",
          modelProfileId: "auto",
          conversationCount: 1,
          contextHealth: "not-compiled",
          pinned: false,
          folders: [],
        },
      ],
    });

    render(<CommandPalette />);
    const input = screen.getByRole("combobox", { name: "Filter commands, chats, projects, memory, skills, library, providers, and models" });

    fireEvent.change(input, { target: { value: "@harness" } });
    expect(screen.getByRole("option", { name: /Harness chat/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Palette project/ })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "#palette" } });
    expect(screen.getByRole("option", { name: /Palette project/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Harness chat/ })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: ">parameters" } });
    expect(screen.getByRole("option", { name: /Open model parameters/ })).toBeInTheDocument();
    expect(screen.getByText("> Commands")).toBeInTheDocument();
  });

  it("opens the selected inspector tab and closes the palette", () => {
    useWorkspaceStore.setState({ commandPaletteOpen: true });
    render(<CommandPalette />);

    const input = screen.getByRole("combobox", { name: "Filter commands, chats, projects, memory, skills, library, providers, and models" });
    fireEvent.change(input, { target: { value: ">parameters" } });
    fireEvent.click(screen.getByRole("option", { name: /Open model parameters/ }));

    expect(useWorkspaceStore.getState().inspectorTab).toBe("parameters");
    expect(useWorkspaceStore.getState().inspectorOpen).toBe(true);
    expect(useWorkspaceStore.getState().commandPaletteOpen).toBe(false);
  });

  it("keeps a message-scoped search result as a one-shot exact jump intent", () => {
    useWorkspaceStore.setState({
      commandPaletteOpen: true,
      activeConversationId: "conversation-jump",
      conversations: [{
        id: "conversation-jump",
        activeBranchId: "branch-jump",
        title: "Jump target chat",
        excerpt: "Search to an exact mounted message",
        updatedAt: "2026-09-20T00:00:00.000Z",
        updatedLabel: "Today",
        projectId: null,
        projectName: null,
        pinned: false,
        archived: false,
        hasDraft: false,
        unread: false,
        runState: null,
        draft: "",
        messages: [{
          id: "message-jump-target",
          role: "assistant",
          content: "Navigate to this exact message anchor",
          createdAt: "2026-09-20T00:00:00.000Z",
          status: "complete",
          modelLabel: "Preview model",
          runId: null,
          attachments: [],
          branchIndex: 1,
          branchCount: 1,
        }],
      }],
    });

    render(<CommandPalette />);
    const input = screen.getByRole("combobox", { name: "Filter commands, chats, projects, memory, skills, library, providers, and models" });
    fireEvent.change(input, { target: { value: "?exact message anchor" } });
    fireEvent.click(screen.getByRole("option", { name: /Navigate to this exact message anchor/ }));

    expect(useWorkspaceStore.getState().activeConversationId).toBe("conversation-jump");
    expect(useWorkspaceStore.getState().pendingMessageNavigation).toMatchObject({
      conversationId: "conversation-jump",
      messageId: "message-jump-target",
    });
    expect(useWorkspaceStore.getState().commandPaletteOpen).toBe(false);
  });

  it("exposes scope tabs and labels studio surfaces as previews", () => {
    useWorkspaceStore.setState({ commandPaletteOpen: true });
    render(<CommandPalette />);

    expect(screen.getByRole("tab", { name: /All/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Chats/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Projects/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Open Memory Studio/ })).toHaveTextContent("Preview");
  });

  it("exposes the P1 navigation shortcuts in command search", () => {
    useWorkspaceStore.setState({ commandPaletteOpen: true });
    render(<CommandPalette />);

    const input = screen.getByRole("combobox", { name: "Filter commands, chats, projects, memory, skills, library, providers, and models" });
    fireEvent.change(input, { target: { value: ">new project" } });
    expect(screen.getByRole("option", { name: /New project/ })).toHaveTextContent("Ctrl+Shift+P");

    fireEvent.change(input, { target: { value: ">focus Chat search" } });
    expect(screen.getByRole("option", { name: /Focus Chat search/ })).toHaveTextContent("Ctrl+Shift+F");

    fireEvent.change(input, { target: { value: ">focus composer" } });
    expect(screen.getByRole("option", { name: /Focus composer/ })).toHaveTextContent("Ctrl+L");
  });

  it("requires an explicit destination confirmation for active Chat moves", () => {
    const activeConversation = {
      id: "conversation_move_palette",
      activeBranchId: "branch_move_palette",
      title: "Move me from Palette",
      excerpt: "Command Palette move preview",
      updatedAt: "2026-09-19T00:00:00.000Z",
      updatedLabel: "Now",
      projectId: "project_source",
      projectName: "Source Project",
      pinned: false,
      archived: false,
      hasDraft: false,
      unread: false,
      runState: null,
      draft: "",
      messages: [],
    };
    useWorkspaceStore.setState({
      commandPaletteOpen: true,
      activeConversationId: activeConversation.id,
      activeProjectId: activeConversation.projectId,
      conversations: [activeConversation],
      projects: [
        {
          id: "project_source",
          name: "Source Project",
          description: "Current destination",
          accent: "#2563eb",
          instructions: "",
          modelProfileId: "auto",
          conversationCount: 1,
          contextHealth: "ready",
          pinned: false,
          folders: [],
        },
        {
          id: "project_target",
          name: "Target Project",
          description: "Move destination",
          accent: "#14b8a6",
          instructions: "",
          modelProfileId: "auto",
          conversationCount: 0,
          contextHealth: "ready",
          pinned: true,
          folders: [],
        },
      ],
    });

    render(<CommandPalette />);
    const input = screen.getByRole("combobox", { name: "Filter commands, chats, projects, memory, skills, library, providers, and models" });
    fireEvent.change(input, { target: { value: ">move active chat" } });
    fireEvent.click(screen.getByRole("option", { name: /Move active chat/ }));

    expect(useWorkspaceStore.getState().conversations[0]?.projectId).toBe("project_source");
    expect(screen.getByRole("listbox", { name: "Chat move destinations" })).toBeInTheDocument();
    expect(screen.getByText(/Ownership changes only after Confirm move/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /Target Project/ }));
    expect(useWorkspaceStore.getState().conversations[0]?.projectId).toBe("project_source");

    fireEvent.click(screen.getByRole("button", { name: "Confirm move" }));
    expect(useWorkspaceStore.getState().conversations[0]?.projectId).toBe("project_target");
    expect(useWorkspaceStore.getState().commandPaletteOpen).toBe(false);
  });

  it("keeps unavailable Project destinations fail-closed in the palette picker", () => {
    useWorkspaceStore.setState({
      commandPaletteOpen: true,
      activeConversationId: "conversation-harness",
      activeProjectId: "project-omnia",
      projects: [
        {
          id: "project-omnia",
          name: "Omnia",
          description: "Current project",
          accent: "#2563eb",
          instructions: "",
          modelProfileId: "auto",
          conversationCount: 1,
          contextHealth: "ready",
          pinned: false,
          folders: [],
        },
        {
          id: "project-locked",
          name: "Locked Project",
          description: "No workspace access",
          accent: "#ef4444",
          instructions: "",
          modelProfileId: "auto",
          conversationCount: 0,
          contextHealth: "missing-access",
          pinned: false,
          folders: [],
        },
      ],
    });

    render(<CommandPalette />);
    const input = screen.getByRole("combobox", { name: "Filter commands, chats, projects, memory, skills, library, providers, and models" });
    fireEvent.change(input, { target: { value: ">move active chat" } });
    fireEvent.click(screen.getByRole("option", { name: /Move active chat/ }));

    const locked = screen.getByRole("option", { name: /Locked Project/ });
    expect(locked).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(locked);
    expect(useWorkspaceStore.getState().conversations.find((conversation) => conversation.id === "conversation-harness")?.projectId).toBe("project-omnia");
    expect(screen.getByText(/workspace access is unavailable/i)).toBeInTheDocument();
  });

  it("keeps archived Project destinations fail-closed in the palette picker", () => {
    useWorkspaceStore.setState({
      commandPaletteOpen: true,
      activeConversationId: "conversation-harness",
      activeProjectId: "project-omnia",
      projects: [
        {
          id: "project-omnia",
          name: "Omnia",
          description: "Current project",
          accent: "#2563eb",
          instructions: "",
          modelProfileId: "auto",
          conversationCount: 1,
          contextHealth: "ready",
          pinned: false,
          folders: [],
        },
        {
          id: "project-archived",
          name: "Archived Project",
          description: "Closed project",
          accent: "#64748b",
          instructions: "",
          modelProfileId: "auto",
          conversationCount: 0,
          contextHealth: "ready",
          archived: true,
          pinned: false,
          folders: [],
        },
      ],
    });

    render(<CommandPalette />);
    const input = screen.getByRole("combobox", { name: "Filter commands, chats, projects, memory, skills, library, providers, and models" });
    fireEvent.change(input, { target: { value: ">move active chat" } });
    fireEvent.click(screen.getByRole("option", { name: /Move active chat/ }));

    const archived = screen.getByRole("option", { name: /Archived Project/ });
    expect(archived).toHaveAttribute("aria-disabled", "true");
    expect(archived).toHaveTextContent(/archived/i);
    fireEvent.click(archived);
    expect(useWorkspaceStore.getState().conversations.find((conversation) => conversation.id === "conversation-harness")?.projectId).toBe("project-omnia");
    expect(screen.getByText(/archived and cannot receive Chat ownership/i)).toBeInTheDocument();
  });
});
