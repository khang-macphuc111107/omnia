import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConversationMessageActionPreview } from "./conversation-message-actions-preview";
import { useWorkspaceStore } from "./store";
import type { ChatMessage, ConversationView } from "./types";

const initialState = useWorkspaceStore.getState();

const message: ChatMessage = {
  id: "message-action-preview",
  role: "assistant",
  content: "A response that can be edited, retried, spoken, branched, or shaped into an artifact.",
  createdAt: "2026-09-19T00:00:00.000Z",
  status: "complete",
  modelLabel: "Atlas Reasoning",
  runId: "run-action-preview",
  attachments: [],
  branchIndex: 1,
  branchCount: 1,
};

const conversation: ConversationView = {
  id: "conversation-action-preview",
  activeBranchId: "branch-action-preview",
  title: "Action preview",
  excerpt: "Renderer-local message action rehearsal",
  updatedAt: "2026-09-19T00:00:00.000Z",
  updatedLabel: "Now",
  projectId: null,
  projectName: null,
  pinned: false,
  archived: false,
  hasDraft: false,
  unread: false,
  runState: null,
  draft: "",
  messages: [message],
};

describe("conversation message action preview", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("rehearses editing without mutating the transcript and can load the draft", () => {
    useWorkspaceStore.setState({ activeConversationId: conversation.id, conversations: [conversation] });
    render(<ConversationMessageActionPreview action="edit" message={message} />);

    fireEvent.click(screen.getByRole("button", { name: /Edit and branch preview/i }));
    const editor = screen.getByRole("textbox", { name: "Edited message" });
    fireEvent.change(editor, { target: { value: "Edited locally" } });
    fireEvent.click(screen.getByRole("button", { name: /Load edited draft/i }));

    expect(useWorkspaceStore.getState().conversations[0]?.messages[0]?.content).toBe(message.content);
    expect(useWorkspaceStore.getState().conversations[0]?.draft).toBe("Edited locally");
    expect(screen.getByRole("status")).toHaveTextContent(/renderer-local preview only/i);
  });

  it("shows branch and retry controls while keeping native dispatch planned", () => {
    render(
      <>
        <ConversationMessageActionPreview action="branch" message={message} />
        <ConversationMessageActionPreview action="regenerate" message={message} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Branch from here preview/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "Branch name" }), { target: { value: "Local route" } });
    fireEvent.click(screen.getByRole("button", { name: /Stage branch preview/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/no native branch was created/i);

    fireEvent.click(screen.getByRole("button", { name: /Regenerate response preview/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Retry style" }), { target: { value: "deeper" } });
    fireEvent.click(screen.getByRole("button", { name: /Prepare retry preview/i }));
    expect(screen.getAllByRole("status").at(-1)).toHaveTextContent(/provider dispatch remains planned/i);
  });

  it("prepares a continuation direction without creating a provider run", () => {
    render(<ConversationMessageActionPreview action="continue" message={message} />);

    fireEvent.click(screen.getByRole("button", { name: /Continue response preview/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Continuation style" }), { target: { value: "add-examples" } });
    fireEvent.click(screen.getByRole("button", { name: /Prepare continuation preview/i }));

    expect(screen.getByRole("status")).toHaveTextContent(/add examples and edge cases/i);
    expect(screen.getByRole("status")).toHaveTextContent(/provider dispatch remains planned/i);
    expect(screen.getByRole("status")).toHaveTextContent(/provider request/i);
  });

  it("exposes voice and artifact options with explicit no-write boundaries", () => {
    render(
      <>
        <ConversationMessageActionPreview action="read-aloud" message={message} />
        <ConversationMessageActionPreview action="artifact" message={message} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Read aloud preview/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Voice preset" }), { target: { value: "calm" } });
    fireEvent.click(screen.getByRole("button", { name: /Queue voice preview/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/no audio was generated/i);

    fireEvent.click(screen.getByRole("button", { name: /Save as artifact preview/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "Artifact title" }), { target: { value: "Answer note" } });
    fireEvent.click(screen.getByRole("button", { name: /Stage artifact preview/i }));
    expect(screen.getAllByRole("status").at(-1)).toHaveTextContent(/durable save remains planned/i);
  });
});
