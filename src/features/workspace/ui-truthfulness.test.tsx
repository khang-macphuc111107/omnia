import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandPalette } from "./command-palette";
import { ConversationView } from "./conversation-view";
import { MessageMarkdown } from "./markdown";
import { useWorkspaceStore } from "./store";
import type { ChatMessage, ConversationView as ConversationViewModel } from "./types";
import { desktop } from "@/lib/desktop";

const initialState = useWorkspaceStore.getState();

function conversation(
  overrides: Partial<ConversationViewModel> = {},
): ConversationViewModel {
  return {
    id: "conversation_truth",
    activeBranchId: "branch_truth",
    title: "Truthful preview",
    excerpt: "Preview copy",
    updatedAt: "2026-08-12T00:00:00.000Z",
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
    ...overrides,
  };
}

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message_truth",
    role: "user",
    content: "Create a branch from this message",
    createdAt: "2026-08-12T00:00:00.000Z",
    status: "complete",
    modelLabel: null,
    runId: null,
    attachments: [],
    branchIndex: 1,
    branchCount: 1,
    ...overrides,
  };
}

describe("Phase 1 UI truthfulness", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useWorkspaceStore.setState(initialState, true);
    delete window.__TAURI_INTERNALS__;
    document.body.innerHTML = "";
  });

  it("limits Ctrl+K copy to navigation and current objects", () => {
    useWorkspaceStore.setState({
      commandPaletteOpen: true,
      conversations: [],
      projects: [],
    });

    render(<CommandPalette />);

    expect(
      screen.getByPlaceholderText("Filter commands, chats, projects, memory, skills, library, providers, or models…"),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Open Memory Studio/ })).toHaveTextContent("Preview");
    expect(screen.getByRole("option", { name: /Open Skills Studio/ })).toHaveTextContent("Preview");
    expect(screen.getByText("Shortcut customization planned")).toBeInTheDocument();
    expect(screen.queryByText("Review active and suggested memories")).not.toBeInTheDocument();
    expect(screen.queryByText("Create and manage reusable workflows")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/files.*memories.*skills/i)).not.toBeInTheDocument();
  });

  it("offers only text-chat starters when no conversation is selected", () => {
    useWorkspaceStore.setState({
      activeConversationId: "",
      conversations: [],
      providers: [],
    });

    render(<ConversationView />);

    expect(screen.getByText("Plan a project")).toBeInTheDocument();
    expect(screen.getByText("Explain a topic")).toBeInTheDocument();
    expect(screen.getByText("Ask a question, share code, or attach a file.")).toBeInTheDocument();
    expect(screen.queryByText("Analyze files")).not.toBeInTheDocument();
    expect(screen.queryByText("Research deeply")).not.toBeInTheDocument();
    expect(screen.queryByText(/grounded context|citations/i)).not.toBeInTheDocument();
  });

  it("uses one honest running disclosure for an empty native stream, not invented compiled context", () => {
    const active = conversation({
      runState: "streaming",
      messages: [
        {
          id: "message_streaming",
          role: "assistant",
          content: "",
          createdAt: "2026-08-12T00:00:00.000Z",
          status: "streaming",
          modelLabel: "Local model",
          runId: "run_truth",
          attachments: [],
          branchIndex: 1,
          branchCount: 1,
        },
      ],
    });
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
    });

    render(<ConversationView />);

    const thinking = screen.getByText("Thinking...").closest("details");
    expect(thinking).toHaveAttribute("open");
    expect(screen.queryByText("Preparing context…")).not.toBeInTheDocument();
  });

  it("does not claim provider dispatch for standalone browser previews", () => {
    const active = conversation();
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
    });

    render(<ConversationView />);

    // Runtime/preview metadata is intentionally not part of the scope header.
    // Removing the badge must not replace it with a claim of provider execution.
    expect(screen.getByRole("heading", { name: "Truthful preview" })).toBeInTheDocument();
    expect(screen.queryByText(/Local history · browser preview response/)).not.toBeInTheDocument();
    expect(screen.queryByText("Private chat")).not.toBeInTheDocument();
  });

  it("keeps unavailable attachments explicit while exposing a renderer-local branch candidate", () => {
    const active = conversation({
      messages: [
        {
          id: "message_attachment",
          role: "user",
          content: "Review this file",
          createdAt: "2026-08-12T00:00:00.000Z",
          status: "complete",
          modelLabel: null,
          runId: null,
          attachments: [
            {
              id: "attachment_truth",
              name: "PRODUCT_SPEC.md",
              kind: "document",
              size: "33 KB",
              state: "ready",
            },
          ],
          branchIndex: 1,
          branchCount: 1,
        },
        {
          id: "message_branches",
          role: "assistant",
          content: "Preview answer",
          createdAt: "2026-08-12T00:00:01.000Z",
          status: "complete",
          modelLabel: "Local model",
          runId: "run_truth",
          attachments: [],
          branchIndex: 2,
          branchCount: 3,
        },
      ],
    });
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
    });

    render(<ConversationView />);

    expect(screen.getByText("PRODUCT_SPEC.md").closest("button")).toBeNull();
    expect(screen.getByLabelText(/PRODUCT_SPEC\.md, 33 KB/i)).toHaveAttribute(
      "title", expect.stringMatching(/content is unavailable/i),
    );
    fireEvent.click(screen.getByRole("button", { name: "Branch from here preview" }));
    expect(screen.getByRole("dialog", { name: "Create a branch candidate" })).toHaveTextContent(/no durable branch/i);
    expect(screen.getByRole("button", { name: /Previous visible branch/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Next visible branch/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Open branch map/i })).toBeEnabled();
    expect(screen.queryByText(/33 KB · Ready/i)).not.toBeInTheDocument();
  });

  it("offers IDE navigation without claiming artifact creation or patch application", () => {
    render(<MessageMarkdown content={"```ts\nconst preview = true;\n```"} />);

    const openButton = screen.getByRole("button", { name: "Open in IDE" });
    expect(openButton).toBeEnabled();
    expect(openButton).toHaveAttribute("title", "Open in IDE");
    expect(openButton).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /artifact|Apply Patch/i })).not.toBeInTheDocument();
  });

  it("calls the native fork action for a completed user message", async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.spyOn(desktop, "onRunEvent").mockResolvedValue(() => undefined);
    const forkConversationBranch = vi.fn().mockResolvedValue(undefined);
    const active = conversation({ messages: [userMessage({ id: "message_native_branch" })] });
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
      forkConversationBranch,
    });

    render(<ConversationView />);

    fireEvent.click(screen.getByRole("button", { name: "Branch from here" }));

    await waitFor(() =>
      expect(forkConversationBranch).toHaveBeenCalledWith("message_native_branch"),
    );
  });

  it("shows a pending native fork and ignores duplicate clicks", () => {
    window.__TAURI_INTERNALS__ = {};
    vi.spyOn(desktop, "onRunEvent").mockResolvedValue(() => undefined);
    const forkConversationBranch = vi.fn(() => new Promise<void>(() => undefined));
    const active = conversation({ messages: [userMessage({ id: "message_pending_branch" })] });
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
      forkConversationBranch,
    });

    render(<ConversationView />);

    const button = screen.getByRole("button", { name: "Branch from here" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(forkConversationBranch).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(screen.getByText("Creating branch…")).toBeInTheDocument();
  });

  it("opens the native branch map as a read-only renderer workbench", () => {
    window.__TAURI_INTERNALS__ = {};
    vi.spyOn(desktop, "onRunEvent").mockResolvedValue(() => undefined);
    const active = conversation({
      messages: [
        userMessage({
          id: "message_branch_one",
          role: "assistant",
          modelLabel: "Local model",
          content: "First path",
          branchIndex: 1,
          branchCount: 2,
        }),
        userMessage({
          id: "message_branch_two",
          role: "assistant",
          modelLabel: "Local model",
          content: "Second path",
          branchIndex: 2,
          branchCount: 2,
        }),
      ],
    });
    useWorkspaceStore.setState({ activeConversationId: active.id, conversations: [active], providers: [] });

    render(<ConversationView />);
    fireEvent.click(screen.getAllByRole("button", { name: "Open branch map" })[0]!);

    expect(screen.getByRole("dialog", { name: "Conversation branch map" })).toBeInTheDocument();
    expect(screen.getByText("Branch 1")).toBeInTheDocument();
    expect(screen.getByText("Branch 2")).toBeInTheDocument();
    expect(screen.getByText(/Branch activation requires a hydrated native desktop Chat/i)).toBeInTheDocument();
  });

  it("exposes native branch errors as an alert", async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.spyOn(desktop, "onRunEvent").mockResolvedValue(() => undefined);
    const forkConversationBranch = vi
      .fn()
      .mockRejectedValue(new Error("Native branch storage is unavailable."));
    const active = conversation({ messages: [userMessage({ id: "message_error_branch" })] });
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
      forkConversationBranch,
    });

    render(<ConversationView />);

    fireEvent.click(screen.getByRole("button", { name: "Branch from here" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Native branch storage is unavailable.",
    );
  });

  it("keeps a streaming user message's native branch control disabled", () => {
    window.__TAURI_INTERNALS__ = {};
    vi.spyOn(desktop, "onRunEvent").mockResolvedValue(() => undefined);
    const forkConversationBranch = vi.fn();
    const active = conversation({
      runState: "streaming",
      messages: [userMessage({ id: "message_streaming_branch", status: "streaming" })],
    });
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
      forkConversationBranch,
    });

    render(<ConversationView />);

    const button = screen.getByRole("button", { name: "Branch from here" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(forkConversationBranch).not.toHaveBeenCalled();
  });
});
