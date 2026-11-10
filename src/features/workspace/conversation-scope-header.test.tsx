import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConversationScopeHeader } from "./conversation-scope-header";
import { initialConversations, initialProjects } from "./mock-data";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("ConversationScopeHeader", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("shows one Folder / chat-title breadcrumb without URI, counters, or diagnostic metadata", () => {
    const conversation = initialConversations[0]!;
    useWorkspaceStore.setState({
      conversations: initialConversations,
      projects: initialProjects,
      activeConversationId: conversation.id,
      activeProjectId: conversation.projectId ?? "",
    });

    const { container } = render(<ConversationScopeHeader conversation={conversation} />);

    expect(screen.getByText("Omnia Desktop")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: conversation.title })).toBeInTheDocument();
    const breadcrumb = screen.getByLabelText("Chat location");
    expect(breadcrumb).toHaveTextContent(`Omnia Desktop/${conversation.title}`);
    expect(breadcrumb.querySelector("svg")).toHaveAttribute("stroke-width", "1.75");
    expect(container.textContent).not.toMatch(/omnia:\/\/sessions\/|Cache Hit|DFS:|tok\/s|Local history|Project scope|Preview/);
    expect(container.querySelector(".conversation-scope-header__meta")).not.toBeInTheDocument();
    expect(screen.queryByText("UI preview")).not.toBeInTheDocument();
    expect(screen.queryByText("Not compiled")).not.toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("switches visible Chat and Project selections from the scope menu", () => {
    const conversation = initialConversations[0]!;
    useWorkspaceStore.setState({
      conversations: initialConversations,
      projects: initialProjects,
      activeConversationId: conversation.id,
      activeProjectId: conversation.projectId ?? "",
    });

    render(<ConversationScopeHeader conversation={conversation} />);
    const trigger = screen.getByRole("button", { name: "Change Project or Chat scope" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls", "scope-switcher-menu");
    fireEvent.click(trigger);

    const menu = screen.getByRole("menu", { name: "Switch Project or Chat scope" });
    expect(menu).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(menu).toHaveAttribute("id", "scope-switcher-menu");
    expect(screen.getByRole("menuitem", { name: /Research notebook/ })).toHaveTextContent("Switch");
    fireEvent.click(screen.getByRole("menuitem", { name: /Provider capability matrix/ }));
    expect(useWorkspaceStore.getState().activeConversationId).toBe("conversation-provider-matrix");
    expect(trigger).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Change Project or Chat scope" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Research notebook/ }));
    expect(useWorkspaceStore.getState().activeProjectId).toBe("project-research");
    expect(useWorkspaceStore.getState().activeActivity).toBe("projects");
    expect(trigger).toHaveFocus();
  });

  it("uses a clean Inbox breadcrumb for standalone chats without claiming provider dispatch", () => {
    delete window.__TAURI_INTERNALS__;
    const conversation = initialConversations.find((item) => item.projectId === null)!;
    useWorkspaceStore.setState({
      conversations: initialConversations,
      projects: initialProjects,
      activeConversationId: conversation.id,
      activeProjectId: "",
    });

    render(<ConversationScopeHeader conversation={conversation} />);

    expect(screen.getByText("Inbox")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: conversation.title })).toBeInTheDocument();
    expect(screen.queryByText("Local history · browser preview response")).not.toBeInTheDocument();
    expect(screen.queryByText("Local history · sent to selected provider")).not.toBeInTheDocument();
  });

  it("does not turn temporary preview policy into persistent breadcrumb badges", () => {
    const conversation = { ...initialConversations[0]!, temporary: true };
    useWorkspaceStore.setState({
      conversations: [conversation],
      projects: initialProjects,
      activeConversationId: conversation.id,
      activeProjectId: conversation.projectId ?? "",
    });

    render(<ConversationScopeHeader conversation={conversation} />);

    expect(screen.queryByLabelText("Temporary Chat preview")).not.toBeInTheDocument();
    expect(screen.queryByText(/native retention policy planned/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: conversation.title })).toBeInTheDocument();
    expect(conversation.temporary).toBe(true);
  });

  it("supports roving keyboard navigation and focus restoration in the scope menu", () => {
    const conversation = initialConversations[0]!;
    useWorkspaceStore.setState({
      conversations: initialConversations,
      projects: initialProjects,
      activeConversationId: conversation.id,
      activeProjectId: conversation.projectId ?? "",
    });

    render(<ConversationScopeHeader conversation={conversation} />);
    const trigger = screen.getByRole("button", { name: "Change Project or Chat scope" });
    fireEvent.click(trigger);
    const items = screen.getAllByRole("menuitem");
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1]!, { key: "End" });
    expect(items.at(-1)).toHaveFocus();
    fireEvent.keyDown(items.at(-1)!, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Switch Project or Chat scope" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
