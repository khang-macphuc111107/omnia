import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatComposer } from "./composer";
import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";

const initialState = useWorkspaceStore.getState();

function conversation(draft: string): ConversationView {
  return {
    id: "conversation_paste_component",
    activeBranchId: "branch_paste_component",
    title: "Paste handling",
    excerpt: draft.slice(0, 90),
    updatedAt: "2026-08-13T00:00:00.000Z",
    updatedLabel: "Now",
    projectId: null,
    projectName: null,
    pinned: false,
    archived: false,
    hasDraft: draft.length > 0,
    unread: false,
    runState: null,
    draft,
    messages: [],
  };
}

function dispatchPaste(
  textarea: HTMLTextAreaElement,
  plainText: string,
  richText = "",
): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: {
      getData: vi.fn((format: string) => {
        if (format === "text/plain") return plainText;
        if (format === "text/html") return richText;
        return "";
      }),
    },
  });
  textarea.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  useWorkspaceStore.setState({
    activeConversationId: "conversation_paste_component",
    conversations: [conversation("Hello world")],
    activeRun: null,
    attachments: [],
    draftAttachmentIdsByConversation: {},
  });
});

afterEach(() => {
  useWorkspaceStore.setState(initialState, true);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ChatComposer paste handling", () => {
  it("prevents browser interpretation and restores the cursor after selection replacement", async () => {
    render(<ChatComposer />);
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    textarea.setSelectionRange(6, 11);

    const event = dispatchPaste(textarea, "Omnia");

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(textarea).toHaveValue("Hello Omnia"));
    expect(textarea.selectionStart).toBe("Hello Omnia".length);
    expect(textarea.selectionEnd).toBe("Hello Omnia".length);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps a large paste inline and exposes a truthful warning with metrics", async () => {
    const largeText = "x".repeat(40_000);
    useWorkspaceStore.setState({ conversations: [conversation("")] });

    render(<ChatComposer />);
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    const event = dispatchPaste(textarea, largeText, "<p>rich clipboard</p>");

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(textarea).toHaveValue(largeText));
    expect(screen.getByRole("status")).toHaveTextContent(/Large paste detected/i);
    expect(screen.getByRole("status")).toHaveTextContent(/exact plain text was kept inline/i);
    expect(screen.getByRole("status")).toHaveTextContent(/40,000 characters/i);
    expect(screen.getByRole("status")).toHaveTextContent(/Rich clipboard formatting was detected/i);
  });

  it("warns when a small paste pushes the resulting draft over a threshold", async () => {
    const nearLimitDraft = "x".repeat(32_768);
    useWorkspaceStore.setState({ conversations: [conversation(nearLimitDraft)] });

    render(<ChatComposer />);
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    textarea.setSelectionRange(nearLimitDraft.length, nearLimitDraft.length);
    const event = dispatchPaste(textarea, "!");

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(textarea).toHaveValue(`${nearLimitDraft}!`));
    expect(screen.getByRole("status")).toHaveTextContent(/Large paste detected/i);
    expect(screen.getByRole("status")).toHaveTextContent(/32,769 characters/i);
  });

  it("opens the renderer-local file projection and keeps native file actions planned", async () => {
    const largeText = "# Build notes\n\n" + "x".repeat(40_000);
    useWorkspaceStore.setState({ conversations: [conversation("")] });

    render(<ChatComposer />);
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    dispatchPaste(textarea, largeText);

    await waitFor(() => expect(screen.getByText("build-notes.txt")).toBeInTheDocument());
    expect(screen.getByText(/Preview hash: fnv1a-/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send full file" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send selected range" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Summarize first" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
    const pastePreview = screen.getByRole("status", { name: "Large paste conversion preview" });
    expect(pastePreview).toBeInTheDocument();
    expect(within(pastePreview).getByText(/# Build notes/)).toBeInTheDocument();
  });
});
