import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConversationProjectBridge } from "./conversation-project-bridge";
import { initialConversations, initialProjects } from "./mock-data";
import { useWorkspaceOverlayStore } from "./overlay-store";
import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";

const initialWorkspaceState = useWorkspaceStore.getState();
const initialOverlayState = useWorkspaceOverlayStore.getState();

function standaloneConversation(): ConversationView {
  return {
    id: "conversation-standalone-continuity",
    activeBranchId: "branch-standalone-continuity",
    title: "Standalone continuity",
    excerpt: "No Project scope attached.",
    updatedAt: "2026-09-21T00:00:00.000Z",
    updatedLabel: "Now",
    projectId: null,
    projectName: null,
    pinned: false,
    archived: false,
    hasDraft: true,
    unread: false,
    runState: null,
    draft: "Keep this local.",
    messages: [],
  };
}

describe("ConversationProjectBridge", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialWorkspaceState, true);
    useWorkspaceOverlayStore.setState(initialOverlayState, true);
    document.body.innerHTML = "";
  });

  it("makes a Project-scoped Chat continuity and its renderer-only actions inspectable", () => {
    const project = initialProjects[0]!;
    const conversation = initialConversations.find((candidate) => candidate.projectId === project.id)!;
    useWorkspaceStore.setState({
      projects: initialProjects,
      conversations: initialConversations,
      activeConversationId: conversation.id,
      activeProjectId: project.id,
      activeActivity: "chats",
    });

    render(<ConversationProjectBridge conversation={conversation} />);

    expect(screen.getByText(`Project continuity · ${project.name}`)).toBeInTheDocument();
    expect(screen.getByText("Read-only workspace grants")).toBeInTheDocument();
    expect(screen.getByText(/does not compile context, read or write workspace files/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open project overview" }));
    expect(useWorkspaceStore.getState().activeProjectId).toBe(project.id);
    expect(useWorkspaceStore.getState().activeActivity).toBe("projects");

    fireEvent.click(screen.getByRole("button", { name: "New project Chat" }));
    expect(useWorkspaceOverlayStore.getState().activeOverlay).toEqual({
      kind: "start-conversation",
      projectId: project.id,
    });
  });

  it("gives a standalone Chat a truthful route to the visible Project workspace", () => {
    const conversation = standaloneConversation();
    useWorkspaceStore.setState({
      projects: initialProjects,
      conversations: [conversation],
      activeConversationId: conversation.id,
      activeProjectId: "",
      activeActivity: "chats",
    });

    render(<ConversationProjectBridge conversation={conversation} />);

    expect(screen.getByText("Standalone continuity")).toBeInTheDocument();
    expect(screen.getByText("No Project folder scope attached")).toBeInTheDocument();
    expect(screen.getByText(/does not attach the Chat, compile context/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Browse Projects" }));
    expect(useWorkspaceStore.getState().activeActivity).toBe("projects");

    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));
    expect(useWorkspaceOverlayStore.getState().activeOverlay).toEqual({ kind: "create-project" });
  });
});
