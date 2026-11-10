import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatFirstCanvas } from "./chat-first-canvas";
import { initialConversations } from "./mock-data";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("ChatFirstCanvas", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
  });

  it("makes the advertised Alt+Enter shortcut focus the message composer", async () => {
    const conversation = initialConversations.find((item) => item.messages.length === 0)!;
    useWorkspaceStore.setState({ conversations: initialConversations, activeConversationId: conversation.id });

    render(
      <>
        <ChatFirstCanvas
          conversation={conversation}
          inspectorOpen={false}
          onToggleInspector={() => undefined}
        />
        <textarea aria-label="Message Omnia" />
      </>,
    );

    expect(screen.getByLabelText(/focus the message composer: alt plus enter/i)).toHaveAttribute(
      "aria-keyshortcuts",
      "Alt+Enter",
    );

    fireEvent.keyDown(window, { key: "Enter", altKey: true });

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message Omnia" })).toHaveFocus());
  });

  it("keeps starter prompts out of the default Chat row and opens them on demand", async () => {
    const conversation = initialConversations.find((item) => item.messages.length === 0)!;
    useWorkspaceStore.setState({ conversations: initialConversations, activeConversationId: conversation.id });

    render(
      <>
        <ChatFirstCanvas
          conversation={conversation}
          inspectorOpen={false}
          onToggleInspector={() => undefined}
        />
        <textarea aria-label="Message Omnia" />
      </>,
    );

    expect(screen.queryByRole("toolbar", { name: "Chat starter prompts" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show starter prompts" }));

    const starters = screen.getByRole("toolbar", { name: "Chat starter prompts" });
    expect(starters).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide starter prompts" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Insert chat starter: Explain code" }));

    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === conversation.id)?.draft).toBe(
      "Explain this code clearly, then show a small example.\n\n",
    );
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message Omnia" })).toHaveFocus());
  });

  it("removes the starter banner after a Chat has messages", () => {
    const conversation = initialConversations.find((item) => item.messages.length > 0)!;
    render(
      <ChatFirstCanvas
        conversation={conversation}
        inspectorOpen={false}
        onToggleInspector={() => undefined}
      />,
    );

    expect(screen.queryByRole("region", { name: "Chat entry" })).toBeNull();
  });
});
