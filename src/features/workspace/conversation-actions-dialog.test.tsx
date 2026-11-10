import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationView } from "./conversation-view";
import { useWorkspaceStore } from "./store";
import type { ConversationView as ConversationViewModel } from "./types";

const initialState = useWorkspaceStore.getState();

function conversation(overrides: Partial<ConversationViewModel> = {}): ConversationViewModel {
  return {
    id: "conversation-actions",
    activeBranchId: "branch-actions",
    title: "Actionable Chat",
    excerpt: "Renderer controls",
    updatedAt: "2026-09-16T00:00:00.000Z",
    updatedLabel: "Now",
    projectId: null,
    projectName: null,
    pinned: false,
    archived: false,
    hasDraft: true,
    unread: false,
    runState: null,
    draft: "Keep this draft",
    messages: [
      {
        id: "message-actions",
        role: "user",
        content: "Show the action surface",
        createdAt: "2026-09-16T00:00:00.000Z",
        status: "complete",
        modelLabel: null,
        runId: null,
        attachments: [],
        branchIndex: 1,
        branchCount: 1,
      },
    ],
    ...overrides,
  };
}

describe("conversation action surface", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    // Unmount subscribers and lazy boundaries before restoring their store.
    cleanup();
    vi.restoreAllMocks();
    useWorkspaceStore.setState(initialState, true);
  });

  it("renames, pins, and resets the active Chat draft from the manage view", async () => {
    const active = conversation();
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
    });

    render(<ConversationView />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "More conversation actions" }));
    });

    expect(await screen.findByRole("dialog", { name: "Conversation actions" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Chat title" }), {
      target: { value: "Renamed Chat" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Rename/ }));
    fireEvent.click(screen.getByRole("button", { name: /Pin Chat/ }));
    fireEvent.click(screen.getByRole("button", { name: /Reset active draft/ }));

    const next = useWorkspaceStore.getState().conversations[0]!;
    expect(next.title).toBe("Renamed Chat");
    expect(next.pinned).toBe(true);
    expect(next.draft).toBe("");
    expect(next.hasDraft).toBe(false);
    expect(within(screen.getByRole("dialog", { name: "Conversation actions" })).getByRole("status")).toHaveTextContent(/reset/i);
  });

  it("opens a truthful renderer-local transcript export preview", async () => {
    const active = conversation();
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
    });

    render(<ConversationView />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Share or export conversation" }));
    });

    expect(await screen.findByRole("dialog", { name: "Conversation actions" })).toBeInTheDocument();
    expect(screen.getByText(/omnia\.conversation\.preview\.v1/)).toBeInTheDocument();
    expect(screen.getByText(/browser download optional/i)).toBeInTheDocument();
    expect(screen.getByText(/Native export.*remain planned/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Include active draft" })).toBeChecked();
    expect(screen.getByRole("code")).toHaveTextContent(/Keep this draft/);

    fireEvent.change(screen.getByRole("combobox", { name: "Conversation export format" }), {
      target: { value: "markdown" },
    });
    expect(screen.getByRole("code")).toHaveTextContent(/# Actionable Chat conversation preview/i);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(within(screen.getByRole("dialog", { name: "Conversation actions" })).getByRole("status")).toHaveTextContent(/browser download/i);
  });

  it("lets the user omit the active draft from a portable transcript preview", async () => {
    const active = conversation();
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
    });

    render(<ConversationView />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Share or export conversation" }));
    });

    await screen.findByRole("dialog", { name: "Conversation actions" });
    const includeDraft = screen.getByRole("checkbox", { name: "Include active draft" });
    fireEvent.click(includeDraft);

    expect(includeDraft).not.toBeChecked();
    expect(screen.getByRole("code")).toHaveTextContent(/draftIncluded["']?: false/i);
    expect(screen.getByRole("code")).not.toHaveTextContent("Keep this draft");

    fireEvent.change(screen.getByRole("combobox", { name: "Conversation export format" }), {
      target: { value: "markdown" },
    });
    expect(screen.getByRole("code")).toHaveTextContent(/Active draft omitted by export option/i);
  });

  it("keeps action tabs keyboard-navigable with labelled panels", async () => {
    const active = conversation();
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
    });

    render(<ConversationView />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "More conversation actions" }));
    });

    await screen.findByRole("dialog", { name: "Conversation actions" });
    const manageTab = screen.getByRole("tab", { name: /Manage Chat/ });
    const exportTab = screen.getByRole("tab", { name: /Export preview/ });
    fireEvent.keyDown(manageTab, { key: "ArrowRight" });

    expect(exportTab).toHaveFocus();
    expect(exportTab).toHaveAttribute("aria-selected", "true");
    const dialog = screen.getByRole("dialog", { name: "Conversation actions" });
    expect(within(dialog).getByRole("tabpanel")).toHaveAttribute("aria-labelledby", exportTab.id);

    fireEvent.keyDown(exportTab, { key: "Home" });
    expect(manageTab).toHaveFocus();
    expect(manageTab).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("tabpanel")).toHaveAttribute("aria-labelledby", manageTab.id);
  });
});
