import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChatController, ChatSession } from "./chat-controller";
import { ChatView } from "./chat-view";

const session: ChatSession = {
  id: "session-a",
  title: "New conversation",
  scope: "non-project",
  profileId: "unconfigured",
  model: "unconfigured",
  permissionMode: "ask_writes",
  settingsRevision: 1,
  messageCount: 0,
  updatedAtMs: 0,
  localOnly: true,
  running: false,
};

function controller(overrides: Partial<ChatController> = {}): ChatController {
  return {
    sessions: [session],
    activeId: session.id,
    activeSession: session,
    messages: [],
    status: "ready",
    error: null,
    draft: "",
    setDraft: vi.fn(),
    selectSession: vi.fn(),
    createSession: vi.fn(async () => session),
    renameSession: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    approve: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    approvals: [],
    questions: [],
    refresh: vi.fn(async () => undefined),
    native: false,
    ...overrides,
  };
}

describe("rebuild chat view", () => {
  it("starts in a non-project draft without inventing an assistant response", () => {
    render(<ChatView controller={controller()} />);
    expect(screen.getByText("Non-project chat")).toBeInTheDocument();
    expect(screen.getByText("Ask for a plan")).toBeInTheDocument();
    expect(screen.getByText(/attach folders or files/)).toBeInTheDocument();
    expect(screen.queryByText("Omnia", { selector: ".rb-message__meta" })).not.toBeInTheDocument();
  });

  it("sends the current draft through the controller", () => {
    const send = vi.fn(async () => undefined);
    render(<ChatView controller={controller({ draft: "Inspect this repository", send })} />);
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("shows an approval and routes an allow decision", () => {
    const approve = vi.fn(async () => undefined);
    render(<ChatView controller={controller({ approve, approvals: [{ id: "tool-1", tool: "write_file", summary: "Write a file", input: {} }] })} />);
    expect(screen.getByText(/Permission requested · write_file/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /allow once/i }));
    expect(approve).toHaveBeenCalledWith("tool-1", "allow_once");
  });

  it("submits a recommended option and a free-text ask-user answer", () => {
    const answerQuestion = vi.fn(async () => undefined);
    render(<ChatView controller={controller({ answerQuestion, questions: [{ id: "q-1", prompt: "Which scope?", options: ["Repository", "Single file"], recommended: ["Repository"], allowFreeText: true }] })} />);
    fireEvent.click(screen.getByRole("button", { name: /Recommended · Repository/i }));
    expect(answerQuestion).toHaveBeenCalledWith("q-1", "Repository");
    const input = screen.getByRole("textbox", { name: "Answer q-1" });
    fireEvent.change(input, { target: { value: "A custom scope" } });
    fireEvent.click(screen.getByRole("button", { name: /^Submit$/i }));
    expect(answerQuestion).toHaveBeenCalledWith("q-1", "A custom scope");
  });

  it("cancels an ask-user request explicitly", () => {
    const answerQuestion = vi.fn(async () => undefined);
    render(<ChatView controller={controller({ answerQuestion, questions: [{ id: "q-2", prompt: "Continue?", options: ["Yes"] }] })} />);
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(answerQuestion).toHaveBeenCalledWith("q-2", null);
  });

  it("fails closed when native ask-user metadata disables free text", () => {
    const answerQuestion = vi.fn(async () => undefined);
    render(<ChatView controller={controller({ answerQuestion, questions: [{ id: "q-3", prompt: "Choose a mode", options: ["Safe"], allowFreeText: false }] })} />);
    expect(screen.queryByRole("textbox", { name: "Answer q-3" })).not.toBeInTheDocument();
    expect(screen.getByText("Free-text answers are disabled for this question.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Safe/i })).toBeInTheDocument();
  });

  it("labels the rename field, traps focus, and closes the dialog with Escape", () => {
    render(<ChatView controller={controller()} />);
    const renameTrigger = screen.getByRole("button", { name: /rename session/i });
    fireEvent.click(renameTrigger);

    const dialog = screen.getByRole("dialog", { name: "Rename session" });
    const input = screen.getByRole("textbox", { name: "Session name" });
    const close = screen.getByRole("button", { name: "Close rename dialog" });
    const save = screen.getByRole("button", { name: "Save name" });
    expect(dialog).toBeInTheDocument();
    expect(input).toBeInTheDocument();
    expect(document.activeElement).toBe(input);
    screen.getByRole("textbox", { name: "Message composer" }).focus();
    expect(document.activeElement).toBe(input);

    save.focus();
    fireEvent.keyDown(save, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Rename session" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(renameTrigger);
  });
});

