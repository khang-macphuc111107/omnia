import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageActionsMenu } from "./message-actions-menu";
import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";

const initialState = useWorkspaceStore.getState();
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function activeConversation(): ConversationView {
  return {
    id: "message-actions-test",
    activeBranchId: "branch-message-actions-test",
    title: "Message actions",
    excerpt: "Test",
    updatedAt: "2026-09-16T00:00:00.000Z",
    updatedLabel: "Now",
    projectId: null,
    projectName: null,
    pinned: false,
    archived: false,
    hasDraft: true,
    unread: false,
    runState: null,
    draft: "Existing thought",
    messages: [],
  };
}

describe("message actions menu", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
    } else {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    }
    document.body.innerHTML = "";
  });

  it("quotes into the active renderer draft and keeps durable save truthful", () => {
    const conversation = activeConversation();
    useWorkspaceStore.setState({ activeConversationId: conversation.id, conversations: [conversation] });
    render(<MessageActionsMenu content={"First line\nSecond line"} messageKind="user" />);

    fireEvent.click(screen.getByRole("button", { name: "More message actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Quote into composer/ }));

    expect(useWorkspaceStore.getState().conversations[0]?.draft).toBe(
      "Existing thought\n\n> First line\n> Second line\n\n",
    );
    expect(screen.getByRole("status")).toHaveTextContent(/renderer-local only/i);

    fireEvent.click(screen.getByRole("menuitem", { name: /Preview excerpt/ }));
    expect(screen.getByRole("status")).toHaveTextContent(/durable artifact save remains planned/i);
  });

  it("keeps provider-bound regeneration disabled in the assistant menu", () => {
    render(<MessageActionsMenu content="An answer" messageKind="assistant" />);

    fireEvent.click(screen.getByRole("button", { name: "More response actions" }));

    fireEvent.click(screen.getByRole("menuitem", { name: /Continue response \(preview\)/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/no provider request or continuation run/i);

    expect(screen.getByRole("menuitem", { name: /Regenerate response/ })).toBeDisabled();
    expect(screen.getByText(/Provider dispatch remains planned/i)).toBeInTheDocument();
  });

  it("copies a typed renderer message link without embedding message content", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(
      <MessageActionsMenu
        content="A private answer that must stay out of the link"
        messageKind="assistant"
        conversationId="conversation-actions"
        projectId="project-actions"
        branchId="branch-actions"
        messageId="message-actions"
        messageRevisionId="message:message-actions:2026-09-19T00:00:00.000Z"
        runId="run-actions"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "More response actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy message link \(preview\)/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toBe(
      "omnia://project/project-actions/chat/conversation-actions?branch=branch-actions&message=message-actions&messageRevision=message%3Amessage-actions%3A2026-09-19T00%3A00%3A00.000Z&run=run-actions&target=message",
    );
    expect(copied).not.toContain("private answer");
    expect(screen.getByRole("status")).toHaveTextContent(/renderer-local message link preview/i);
  });

  it("moves through enabled menu items and restores focus to the trigger on Escape", () => {
    render(<MessageActionsMenu content="Keyboard actions" messageKind="user" />);

    const trigger = screen.getByRole("button", { name: "More message actions" });
    fireEvent.click(trigger);

    const quote = screen.getByRole("menuitem", { name: /Quote into composer/ });
    const copy = screen.getByRole("menuitem", { name: /Copy as Markdown/ });
    const preview = screen.getByRole("menuitem", { name: /Preview excerpt/ });

    quote.focus();
    fireEvent.keyDown(quote, { key: "ArrowDown" });
    expect(copy).toHaveFocus();
    fireEvent.keyDown(copy, { key: "End" });
    expect(preview).toHaveFocus();
    fireEvent.keyDown(preview, { key: "Home" });
    expect(quote).toHaveFocus();

    fireEvent.keyDown(quote, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).not.toHaveAttribute("aria-controls");
  });

  it("exposes the open menu relationship and keeps live status outside the menu role", () => {
    render(<MessageActionsMenu content="Status semantics" messageKind="user" />);

    const trigger = screen.getByRole("button", { name: "More message actions" });
    fireEvent.click(trigger);

    const menu = screen.getByRole("menu", { name: "Message actions" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", menu.id);

    fireEvent.click(screen.getByRole("menuitem", { name: /Preview excerpt/ }));
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/durable artifact save remains planned/i);
    expect(menu.contains(status)).toBe(false);
  });
});
