import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ObjectSidebar } from "./sidebar";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

afterEach(() => {
  useWorkspaceStore.setState(initialState, true);
  document.body.innerHTML = "";
});

describe("Project / Chat sidebar preview", () => {
  it("exposes a focusable row action button and restores focus after closing its menu", () => {
    render(<ObjectSidebar />);

    const actions = screen.getAllByRole("button", { name: "Open Chat actions menu" })[0]!;
    actions.focus();
    fireEvent.click(actions);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(actions).toHaveAttribute("aria-expanded", "true");
    expect(actions).toHaveAttribute("aria-controls", expect.stringMatching(/^chat-actions-menu-/));
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(actions).toHaveAttribute("aria-expanded", "false");
    expect(actions).not.toHaveAttribute("aria-controls");
    expect(document.activeElement).toBe(actions);
  });

  it("supports roving keyboard navigation across enabled Chat actions", () => {
    render(<ObjectSidebar />);

    const actions = screen.getAllByRole("button", { name: "Open Chat actions menu" })[0]!;
    fireEvent.click(actions);
    const menu = screen.getByRole("menu");
    const rename = screen.getByRole("menuitem", { name: "Rename" });
    const pin = screen.getByRole("menuitem", { name: "Pin" });
    const deepLink = screen.getByRole("menuitem", { name: "Copy deep link (preview)" });

    expect(document.activeElement).toBe(rename);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(pin);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(deepLink);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(rename);
  });

  it("re-seeds menu focus when switching directly to another Chat row", () => {
    render(<ObjectSidebar />);

    const actionButtons = screen.getAllByRole("button", { name: "Open Chat actions menu" });
    fireEvent.click(actionButtons[0]!);
    expect(screen.getByRole("menu").getAttribute("aria-label")).toMatch(/Portable replay bundle/);

    fireEvent.click(actionButtons[1]!);
    expect(screen.getByRole("menu").getAttribute("aria-label")).toMatch(/Windows shell accessibility/);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));
  });

  it("announces the renderer-only clipboard boundary when deep-link copy is unavailable", () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    try {
      render(<ObjectSidebar />);
      fireEvent.click(screen.getAllByRole("button", { name: "Open Chat actions menu" })[0]!);
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy deep link (preview)" }));

      expect(screen.getByRole("status")).toHaveTextContent(/Clipboard access is unavailable/i);
      expect(screen.getByRole("menu")).toBeInTheDocument();
    } finally {
      if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      else Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    }
  });

  it("opens a Chat context menu and keeps it interactive on pointer down", () => {
    render(<ObjectSidebar />);

    const chat = screen.getByRole("button", { name: /Designing the Omnia harness/ });
    fireEvent.contextMenu(chat);

    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();

    const pin = screen.getByRole("menuitem", { name: "Unpin" });
    fireEvent.pointerDown(pin);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(pin);

    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === "conversation-harness")?.pinned).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("projects the shared action contract into streaming and planned menu states", () => {
    useWorkspaceStore.setState((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === "conversation-harness" ? { ...conversation, runState: "streaming" as const } : conversation,
      ),
    }));
    render(<ObjectSidebar />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Designing the Omnia harness/ }));

    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveAttribute(
      "title",
      "Stop or finish the active run before archiving this Chat.",
    );
    expect(screen.getByRole("menuitem", { name: "Export preview…" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Export preview…" })).toHaveAttribute(
      "title",
      expect.stringMatching(/native export.*planned/i),
    );
    expect(screen.getByRole("menuitem", { name: "Open in new window (planned)" })).toHaveAttribute(
      "title",
      "A native window host is required.",
    );
    expect(screen.getByRole("menuitem", { name: "Continue in new worktree (unavailable)" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Continue in new worktree (unavailable)" })).toHaveAttribute(
      "title", "A filesystem Project and native Git runtime are required.",
    );
    expect(screen.getByRole("menuitem", { name: "Compare models (planned)" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Compare models (planned)" })).toHaveAttribute(
      "title", "Compare runs are not wired in this preview.",
    );
    expect(screen.getByRole("menuitem", { name: "Delete permanently (planned)" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Delete permanently (planned)" })).toHaveAttribute(
      "title", "Permanent deletion requires native tombstone/receipt support.",
    );
  });

  it("opens the shared export-only Chat preview from the sidebar menu", async () => {
    render(<ObjectSidebar />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Designing the Omnia harness/ }));

    fireEvent.click(screen.getByRole("menuitem", { name: "Export preview…" }));
    const dialog = await screen.findByRole("dialog", { name: "Conversation actions" });

    expect(within(dialog).getByRole("tab", { name: "Export preview" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("tab", { name: "Manage Chat" })).toBeNull();
    expect(within(dialog).getByRole("code")).toHaveTextContent("omnia.conversation.preview.v1");
    expect(within(dialog).getByRole("code")).toHaveTextContent("Designing the Omnia harness");
    expect(within(dialog).getByText(/Native export.*remain planned/i)).toBeInTheDocument();
  });

  it("uses a searchable destination picker, explicit confirmation, and renderer-local Undo for Chat moves", () => {
    render(<ObjectSidebar />);

    const chat = screen.getByRole("button", { name: /Designing the Omnia harness/ });
    fireEvent.contextMenu(chat);
    const moveTrigger = screen.getByRole("menuitem", { name: /Move to Project/ });
    fireEvent.click(moveTrigger);

    expect(moveTrigger).toHaveAttribute("aria-expanded", "true");
    expect(moveTrigger).toHaveAttribute("aria-controls", expect.stringMatching(/-move-panel$/));
    expect(screen.getByRole("group", { name: "Move Chat destination picker" })).toHaveAttribute(
      "id",
      moveTrigger.getAttribute("aria-controls"),
    );

    const search = screen.getByRole("textbox", { name: "Search project destinations" });
    expect(search).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Research notebook/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: "Confirm move" })).toBeDisabled();

    fireEvent.change(search, { target: { value: "Research" } });
    fireEvent.click(screen.getByRole("option", { name: /Research notebook/ }));
    expect(screen.getByRole("button", { name: "Confirm move" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm move" }));
    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === "conversation-harness")?.projectId).toBe("project-research");
    expect(screen.getByRole("status")).toHaveTextContent(/Chat history was not duplicated/i);
    expect(screen.getByRole("menuitem", { name: "Undo move" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Undo move" }));
    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === "conversation-harness")?.projectId).toBe("project-omnia");
    expect(screen.getByRole("status")).toHaveTextContent(/Undid the move/i);
  });

  it("keeps move destination selection local until confirmation", () => {
    render(<ObjectSidebar />);

    const chat = screen.getByRole("button", { name: /Designing the Omnia harness/ });
    fireEvent.contextMenu(chat);
    fireEvent.click(screen.getByRole("menuitem", { name: /Move to Project/ }));
    fireEvent.click(screen.getByRole("option", { name: /Research notebook/ }));

    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === "conversation-harness")?.projectId).toBe("project-omnia");
    expect(screen.getByText(/no native write is performed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Search project destinations" })).toBeNull();
    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === "conversation-harness")?.projectId).toBe("project-omnia");
  });

  it("supports roving keyboard navigation and Escape focus return in the move picker", () => {
    render(<ObjectSidebar />);

    const chat = screen.getByRole("button", { name: /Designing the Omnia harness/ });
    fireEvent.contextMenu(chat);
    fireEvent.click(screen.getByRole("menuitem", { name: /Move to Project/ }));

    const current = screen.getByRole("option", { name: /Omnia Desktop/ });
    const research = screen.getByRole("option", { name: /Research notebook/ });
    const standalone = screen.getByRole("option", { name: /Inbox \/ standalone/ });

    expect(current).toHaveAttribute("aria-selected", "true");
    expect(current).toHaveAttribute("tabindex", "0");
    current.focus();
    fireEvent.keyDown(current, { key: "ArrowDown" });
    expect(document.activeElement).toBe(research);
    expect(research).toHaveAttribute("aria-selected", "true");
    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === "conversation-harness")?.projectId).toBe("project-omnia");

    fireEvent.keyDown(research, { key: "Home" });
    expect(document.activeElement).toBe(standalone);
    expect(standalone).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(standalone, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Search project destinations" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Move to Project/ }));
  });

  it("fails closed when a selected Project disappears before confirmation", () => {
    render(<ObjectSidebar />);

    const chat = screen.getByRole("button", { name: /Designing the Omnia harness/ });
    fireEvent.contextMenu(chat);
    fireEvent.click(screen.getByRole("menuitem", { name: /Move to Project/ }));
    fireEvent.click(screen.getByRole("option", { name: /Research notebook/ }));

    useWorkspaceStore.setState((state) => ({
      projects: state.projects.filter((project) => project.id !== "project-research"),
    }));

    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === "conversation-harness")?.projectId).toBe("project-omnia");
    expect(screen.getByRole("button", { name: "Confirm move" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm move" }));

    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === "conversation-harness")?.projectId).toBe("project-omnia");
    const announcements = screen.getAllByRole("status");
    expect(announcements.find((node) => /no longer available/i.test(node.textContent ?? ""))).toHaveTextContent(/no longer available/i);
    expect(announcements.find((node) => /no Chat ownership change/i.test(node.textContent ?? ""))).toHaveTextContent(/no Chat ownership change/i);
  });

  it("labels a Project with missing workspace access as unavailable", () => {
    useWorkspaceStore.setState((state) => ({
      projects: state.projects.map((project) =>
        project.id === "project-research" ? { ...project, contextHealth: "missing-access" as const } : project,
      ),
    }));
    render(<ObjectSidebar />);

    const chat = screen.getByRole("button", { name: /Designing the Omnia harness/ });
    fireEvent.contextMenu(chat);
    fireEvent.click(screen.getByRole("menuitem", { name: /Move to Project/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search project destinations" }), { target: { value: "Research" } });

    const destination = screen.getByRole("option", { name: /Research notebook/ });
    expect(destination).toHaveAttribute("aria-disabled", "true");
    expect(destination).toHaveTextContent("Unavailable");
    fireEvent.click(destination);

    expect(screen.getByText(/workspace access is unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm move" })).toBeDisabled();
    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === "conversation-harness")?.projectId).toBe("project-omnia");
  });

  it("renders Projects as expandable groups with nested Chats", () => {
    render(<ObjectSidebar />);

    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Collapse Omnia Desktop/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Designing the Omnia harness/ })).toBeInTheDocument();
  });

  it("makes the Chat list overflow menu actionable instead of rendering a dead disabled button", () => {
    render(<ObjectSidebar />);

    const trigger = screen.getByRole("button", { name: "Open Chat list actions" });
    expect(trigger).toBeEnabled();
    fireEvent.click(trigger);

    const menu = screen.getByRole("menu", { name: "Chat list actions" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", "chat-list-actions-menu");
    expect(within(menu).getByRole("menuitem", { name: "Collapse all Projects" })).toBeEnabled();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Collapse all Projects" }));
    expect(screen.getByRole("button", { name: /Expand Omnia Desktop/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /Designing the Omnia harness/ })).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Expand all Projects" }));
    expect(screen.getByRole("button", { name: /Collapse Omnia Desktop/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Designing the Omnia harness/ })).toBeInTheDocument();
  });

  it("keeps overflow-menu keyboard focus and Escape semantics explicit", async () => {
    render(<ObjectSidebar />);

    const trigger = screen.getByRole("button", { name: "Open Chat list actions" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Chat list actions" });
    const expand = within(menu).getByRole("menuitem", { name: "Expand all Projects" });
    const collapse = within(menu).getByRole("menuitem", { name: "Collapse all Projects" });
    await waitFor(() => expect(document.activeElement).toBe(expand));

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(collapse);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Chat list actions" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("searches message content through an explicit renderer-local scope", () => {
    render(<ObjectSidebar />);

    const search = screen.getByRole("searchbox", { name: "Search chats" });
    const scope = screen.getByRole("combobox", { name: "Search Chat fields" });
    fireEvent.change(scope, { target: { value: "messages" } });
    fireEvent.change(search, { target: { value: "provider-neutral harness" } });

    expect(screen.getByRole("button", { name: /Designing the Omnia harness/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Portable replay bundle/ })).toBeNull();
    expect(screen.getByText(/1 Chat shown from 1 matching messages search result/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear Chat search and filters" })).toBeEnabled();
  });

  it("uses Escape in the search field to clear query and scope", () => {
    render(<ObjectSidebar />);

    const search = screen.getByRole("searchbox", { name: "Search chats" });
    const scope = screen.getByRole("combobox", { name: "Search Chat fields" });
    fireEvent.change(scope, { target: { value: "models" } });
    fireEvent.change(search, { target: { value: "quality route" } });
    fireEvent.keyDown(search, { key: "Escape" });

    expect(search).toHaveValue("");
    expect(scope).toHaveValue("all");
    expect(screen.getByRole("button", { name: "Chat filters" })).toBeDisabled();
    expect(screen.getByText(/Chats shown\./i)).toHaveClass("sr-only");
  });

  it("uses chats vocabulary with correct singular counts and no diagnostic footer", () => {
    const { container } = render(<ObjectSidebar />);
    expect(screen.getByRole("searchbox", { name: "Search chats" })).toHaveAttribute("placeholder", "Search chats...");
    expect(screen.getByRole("button", { name: /New chat/ })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\bthreads?\b|Local Cache Proxy|Cache Hit|renderer-local/i);
    for (const count of container.querySelectorAll(".project-tree__project-button small")) {
      expect(count.textContent).toMatch(/^\d+ chats?$/);
      if (count.textContent?.startsWith("1 ")) expect(count).toHaveTextContent(/^1 chat$/);
    }
    expect(container.querySelector(".project-mini__mark--folder svg")).toHaveAttribute("stroke-width", "1.75");
  });

  it("copies the actual session URI only from a chat item action menu", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(<ObjectSidebar />);
      expect(screen.queryByRole("menuitem", { name: "Copy Session URI" })).not.toBeInTheDocument();
      expect(screen.queryByText(/omnia:\/\/sessions\//)).not.toBeInTheDocument();

      fireEvent.contextMenu(screen.getByRole("button", { name: /Designing the Omnia harness/ }));
      const copy = within(screen.getByRole("menu")).getByRole("menuitem", { name: "Copy Session URI" });
      fireEvent.click(copy);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("omnia://sessions/conversation-harness"));
      expect(screen.getByRole("status")).toHaveTextContent("Session URI copied to the clipboard.");
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    }
  });
});
