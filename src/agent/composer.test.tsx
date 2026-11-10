import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const commandsList = vi.hoisted(() => vi.fn(async () => [
  { name: "review", description: "Review code", argumentHint: "<file>" },
  { name: "refactor", description: "Refactor", argumentHint: "" },
  { name: "test", description: "Run tests", argumentHint: "" },
]));
const workspaceFiles = vi.hoisted(() => vi.fn(async () => [
  { path: "src/main.ts", isDir: false },
  { path: "src/", isDir: true },
]));
vi.mock("./agent-api", () => ({ agentApi: { commandsList, workspaceFiles }, errorMessage: (cause: unknown) => cause instanceof Error ? cause.message : String(cause) }));
import { Composer } from "./composer";
import { useAgentStore } from "./agent-store";
import type { AgentSessionListItem } from "./types";
const session: AgentSessionListItem = { id: "s", title: "s", cwd: "C:\\project", profileId: "p", model: "m", permissionMode: "ask_writes", running: false, messageCount: 0, createdAtMs: 1, updatedAtMs: 1 };
beforeEach(() => { useAgentStore.setState({ drafts: { s: { text: "keep my work", images: [] } } }); });
const props = { session, running: false, usage: null, onStop: vi.fn(), onModel: vi.fn(), onMode: vi.fn() };
describe("Composer asynchronous sending", () => {
  it("preserves draft and reports rejected sends", async () => {
    render(<Composer {...props} onSend={vi.fn(async () => { throw new Error("offline"); })} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(useAgentStore.getState().drafts.s?.text).toBe("keep my work");
  });
  it("does not clear newer edits while a send is pending", async () => {
    let finish!: () => void;
    const onSend = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<Composer {...props} onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "newer draft" } });
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    expect(useAgentStore.getState().drafts.s?.text).toBe("newer draft");
  });
  it("never submits a recovery-blocked session", () => {
    const onSend = vi.fn();
    render(<Composer {...props} blocked onSend={onSend} />);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });
});
const listOptions = () => {
  const list = screen.queryByRole("listbox", { name: "Slash commands" });
  return list ? within(list).getAllByRole("option") : [];
};

describe("Composer slash commands", () => {
  const typeDraft = (value: string) => {
    useAgentStore.setState({ drafts: { s: { text: value, images: [] } } });
  };
  it("lists matching commands, navigates and completes with Tab/Enter", async () => {
    typeDraft("/re");
    const onSend = vi.fn();
    render(<Composer {...props} session={{ ...session, id: "s" }} onSend={onSend} />);
    await screen.findByRole("listbox", { name: "Slash commands" });
    const options = listOptions();
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("/review <file>"),
      expect.stringContaining("/refactor"),
    ]);
    expect(commandsList).toHaveBeenCalledWith("s");
    const box = screen.getByRole("textbox");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(listOptions()[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "Tab" });
    expect(useAgentStore.getState().drafts.s?.text).toBe("/refactor ");
    expect(onSend).not.toHaveBeenCalled();
    expect(listOptions()).toHaveLength(0);
  });
  it("Enter completes a partial name, Escape dismisses", async () => {
    typeDraft("/te");
    const onSend = vi.fn();
    render(<Composer {...props} onSend={onSend} />);
    await screen.findByRole("listbox", { name: "Slash commands" });
    const box = screen.getByRole("textbox");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(listOptions()).toHaveLength(0);
    fireEvent.change(box, { target: { value: "/tes" } });
    await screen.findByRole("listbox", { name: "Slash commands" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(useAgentStore.getState().drafts.s?.text).toBe("/test ");
    expect(onSend).not.toHaveBeenCalled();
  });
  it("shows nothing for non-slash drafts", () => {
    typeDraft("hello");
    render(<Composer {...props} onSend={vi.fn()} />);
    expect(listOptions()).toHaveLength(0);
  });
});

describe("Composer @mentions", () => {
  const mentionOptions = () => {
    const list = screen.queryByRole("listbox", { name: "Workspace files" });
    return list ? within(list).getAllByRole("option") : [];
  };
  it("lists files for @query, Enter inserts the path, Esc closes", async () => {
    useAgentStore.setState({ drafts: { s: { text: "look at @src", images: [] } } });
    const onSend = vi.fn();
    render(<Composer {...props} onSend={onSend} />);
    await screen.findByRole("listbox", { name: "Workspace files" });
    expect(workspaceFiles).toHaveBeenCalledWith("s", "src", 50);
    expect(mentionOptions().map((option) => option.textContent)).toEqual(["src/main.ts", "src/"]);
    const box = screen.getByRole("textbox");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(useAgentStore.getState().drafts.s?.text).toBe("look at @src/main.ts ");
    expect(onSend).not.toHaveBeenCalled();
    expect(mentionOptions()).toHaveLength(0);
    fireEvent.change(box, { target: { value: "@sr" } });
    await screen.findByRole("listbox", { name: "Workspace files" });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(mentionOptions()).toHaveLength(0);
  });
});
