import { afterEach, describe, expect, it } from "vitest";

import { initialConversations, initialProjects } from "./mock-data";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

afterEach(() => {
  useWorkspaceStore.setState(initialState, true);
});

describe("Project / Chat navigation actions", () => {
  it("renames and toggles a Chat without changing its ownership", () => {
    const conversation = initialConversations[0]!;
    useWorkspaceStore.getState().renameConversation(conversation.id, "  Harness renamed  ");
    useWorkspaceStore.getState().toggleConversationPinned(conversation.id);

    const next = useWorkspaceStore.getState().conversations.find((item) => item.id === conversation.id);
    expect(next).toMatchObject({
      title: "Harness renamed",
      pinned: false,
      projectId: conversation.projectId,
    });
  });

  it("archives completed Chats and refuses to archive a streaming Chat", () => {
    const completed = initialConversations[0]!;
    const streaming = { ...initialConversations[1]!, runState: "streaming" as const };
    useWorkspaceStore.setState({ conversations: [completed, streaming] });

    useWorkspaceStore.getState().setConversationArchived(completed.id, true);
    useWorkspaceStore.getState().setConversationArchived(streaming.id, true);

    const state = useWorkspaceStore.getState();
    expect(state.conversations.find((item) => item.id === completed.id)?.archived).toBe(true);
    expect(state.conversations.find((item) => item.id === streaming.id)?.archived).toBe(false);
  });

  it("moves a Chat between a Project and standalone Inbox", () => {
    const conversation = initialConversations[0]!;
    const project = initialProjects.find((item) => item.id === "project-research")!;
    useWorkspaceStore.getState().moveConversationToProject(conversation.id, project.id);

    let next = useWorkspaceStore.getState().conversations.find((item) => item.id === conversation.id);
    expect(next).toMatchObject({ projectId: project.id, projectName: project.name });

    useWorkspaceStore.getState().moveConversationToProject(conversation.id, null);
    next = useWorkspaceStore.getState().conversations.find((item) => item.id === conversation.id);
    expect(next).toMatchObject({ projectId: null, projectName: null });
  });

  it("keeps Chat ownership when a move target is no longer present", () => {
    const conversation = initialConversations[0]!;
    useWorkspaceStore.setState({ projects: initialProjects.filter((item) => item.id !== "project-research") });

    useWorkspaceStore.getState().moveConversationToProject(conversation.id, "project-research");

    const next = useWorkspaceStore.getState().conversations.find((item) => item.id === conversation.id);
    expect(next).toMatchObject({ projectId: conversation.projectId, projectName: conversation.projectName });
  });

  it("keeps Chat ownership when a move target is unavailable", () => {
    const conversation = initialConversations[0]!;
    const unavailableProject = initialProjects.find((item) => item.id === "project-research")!;
    useWorkspaceStore.setState({
      projects: initialProjects.map((project) =>
        project.id === unavailableProject.id
          ? { ...project, contextHealth: "missing-access" as const }
          : project,
      ),
    });

    useWorkspaceStore.getState().moveConversationToProject(conversation.id, unavailableProject.id);

    const next = useWorkspaceStore.getState().conversations.find((item) => item.id === conversation.id);
    expect(next).toMatchObject({ projectId: conversation.projectId, projectName: conversation.projectName });
  });

  it("keeps Chat ownership when a move target is archived", () => {
    const conversation = initialConversations[0]!;
    const archivedProject = initialProjects.find((item) => item.id === "project-research")!;
    useWorkspaceStore.setState({
      projects: initialProjects.map((project) =>
        project.id === archivedProject.id ? { ...project, archived: true } : project,
      ),
    });

    useWorkspaceStore.getState().moveConversationToProject(conversation.id, archivedProject.id);

    const next = useWorkspaceStore.getState().conversations.find((item) => item.id === conversation.id);
    expect(next).toMatchObject({ projectId: conversation.projectId, projectName: conversation.projectName });
  });

  it("keeps the Project breadcrumb in sync when selecting a nested Chat", () => {
    const conversation = initialConversations[0]!;
    useWorkspaceStore.setState({ activeProjectId: "" });
    useWorkspaceStore.getState().selectConversation(conversation.id);

    expect(useWorkspaceStore.getState()).toMatchObject({
      activeConversationId: conversation.id,
      activeProjectId: conversation.projectId,
      activeActivity: "chats",
    });
  });

  it("does not clear the selected Project while Chat hydration runs on the Project surface", () => {
    const selectedProject = initialProjects.find((item) => item.id === "project-research")!;
    useWorkspaceStore.setState({
      activeActivity: "projects",
      activeProjectId: selectedProject.id,
      activeConversationId: "conversation-harness",
    });
    useWorkspaceStore.getState().replaceConversations(initialConversations);

    expect(useWorkspaceStore.getState()).toMatchObject({
      activeActivity: "projects",
      activeProjectId: selectedProject.id,
    });
  });
});
