import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationMessageActionPreview } from "./conversation-message-actions-preview";
import { MessageActionHistoryPreview } from "./message-action-history-preview";
import { MessageActionsMenu } from "./message-actions-menu";
import {
  clearMessageActionHistory,
  getMessageActionHistory,
  recordMessageAction,
} from "./message-action-history-session";
import type { ChatMessage } from "./types";

const message: ChatMessage = {
  id: "message-action-history",
  role: "assistant",
  content: "A response for action history.",
  createdAt: "2026-09-27T00:00:00.000Z",
  status: "complete",
  modelLabel: "Atlas Reasoning",
  runId: "run-action-history",
  attachments: [],
  branchIndex: 1,
  branchCount: 1,
};

describe("message action history preview", () => {
  afterEach(() => {
    clearMessageActionHistory();
    document.body.innerHTML = "";
  });

  it("keeps bounded, newest-first entries and supports per-chat clearing", () => {
    recordMessageAction({ conversationId: "chat-a", messageId: "message-a", role: "user", action: "copy", label: "Copied" });
    recordMessageAction({ conversationId: "chat-b", messageId: "message-b", role: "assistant", action: "artifact", label: "Artifact staged" });
    expect(getMessageActionHistory()).toHaveLength(2);
    expect(getMessageActionHistory()[0]?.conversationId).toBe("chat-b");

    clearMessageActionHistory("chat-a");
    expect(getMessageActionHistory()).toHaveLength(1);
    expect(getMessageActionHistory()[0]?.conversationId).toBe("chat-b");
  });

  it("records action previews and exposes searchable Chat history", async () => {
    render(
      <>
        <ConversationMessageActionPreview action="continue" message={message} conversationId="chat-history" />
        <MessageActionHistoryPreview conversationId="chat-history" />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Continue response preview/i }));
    fireEvent.click(screen.getByRole("button", { name: /Prepare continuation preview/i }));

    expect(getMessageActionHistory()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Message action history, 1 actions/i }));
    expect(screen.getByRole("dialog", { name: "Message action history" })).toBeInTheDocument();
    expect(screen.getByText(/Continuation prepared/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Search message action history" }), { target: { value: "does-not-match" } });
    expect(screen.getByText(/No matching actions/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search message action history" }), { target: { value: "continue" } });
    expect(screen.getByText(/Continuation prepared/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close message action history" }));
    expect(screen.queryByRole("dialog", { name: "Message action history" })).not.toBeInTheDocument();
  });

  it("records message menu actions without storing message bodies", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <MessageActionsMenu
        content="A private body that must not enter history"
        messageKind="assistant"
        conversationId="chat-menu"
        messageId="message-menu"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "More response actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy as Markdown/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const entry = getMessageActionHistory()[0];
    expect(entry?.action).toBe("copy");
    expect(entry?.label).toMatch(/Copied message/);
    expect(entry?.label).not.toContain("private body");
  });
});
