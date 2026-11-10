import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/workspace/markdown", () => ({
  MessageMarkdown: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

import { emptyLive, reduceAgentEvent, type LiveState } from "./transcript";
import { TranscriptView } from "./transcript-view";
import type { AgentWireEvent } from "./types";

const fold = (events: AgentWireEvent[]): LiveState => events.reduce(reduceAgentEvent, emptyLive());

describe("TranscriptView", () => {
  const request = {
    tool_use_id: "t1",
    tool: "bash",
    input: { command: "rm -rf x" },
    summary: "rm -rf x",
    ordinal: 2,
    total: 3,
  };
  const live = fold([
    { type: "run_started" },
    {
      type: "assistant_message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "On it" },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "rm -rf x" } },
        ],
      },
    },
    { type: "tool_proposed", id: "t1", name: "bash", input: { command: "rm -rf x" }, summary: "rm -rf x" },
    { type: "approval_requested", request },
  ]);

  it("renders text, a compact tool row, and the approval card", async () => {
    const onDecide = vi.fn();
    render(<TranscriptView live={live} onDecide={onDecide} />);
    expect(await screen.findByTestId("md")).toHaveTextContent("On it");
    expect(screen.getByRole("button", { name: /Run rm -rf x Waiting/ })).toBeInTheDocument();
    expect(screen.getByText("2 of 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onDecide).toHaveBeenCalledWith("t1", { type: "allow_once" });
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    expect(onDecide).toHaveBeenLastCalledWith("t1", { type: "allow_always" });
  });

  it("denies with optional feedback and allows with Enter", () => {
    const onDecide = vi.fn();
    render(<TranscriptView live={live} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Add feedback" }));
    fireEvent.change(screen.getByLabelText("Feedback for the agent"), { target: { value: "use trash" } });
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith("t1", { type: "deny", feedback: "use trash" });

    fireEvent.keyDown(screen.getByRole("group", { name: "Approval required" }), { key: "Enter" });
    expect(onDecide).toHaveBeenLastCalledWith("t1", { type: "allow_once" });
  });

  it("expands a tool row to show input and streamed output", () => {
    const running = fold([
      { type: "tool_proposed", id: "t", name: "bash", input: { command: "npm test" }, summary: "npm test" },
      { type: "tool_started", id: "t" },
      { type: "tool_progress", id: "t", chunk: "PASS a" },
    ]);
    render(<TranscriptView live={running} onDecide={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Run npm test Running/ }));
    expect(screen.getByText("PASS a")).toBeInTheDocument();
    expect(screen.getByText("$ npm test")).toBeInTheDocument();
    expect(screen.queryByText(/"command": "npm test"/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText(/"command": "npm test"/)).toBeInTheDocument();
  });

  it("shows nested subagent activity inside an expandable task group", () => {
    const state = fold([
      { type: "tool_proposed", id: "task", name: "task", input: { description: "scan repo" }, summary: "scan repo" },
      {
        type: "subagent",
        parent_id: "task",
        event: { type: "tool_proposed", id: "r", name: "read", input: { path: "a.ts" }, summary: "a.ts" },
      },
    ]);
    render(<TranscriptView live={state} onDecide={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Delegate scan repo/ }));
    expect(screen.getByLabelText("Subagent activity")).toHaveTextContent("a.ts");
  });

  it("shows retry status and failed-run error", () => {
    const state = fold([
      { type: "run_started" },
      { type: "retrying", attempt: 2, delay_ms: 10, message: "x" },
    ]);
    const { rerender } = render(<TranscriptView live={state} onDecide={vi.fn()} />);
    expect(screen.getByText("Retrying (attempt 2)…")).toBeInTheDocument();
    rerender(
      <TranscriptView
        live={reduceAgentEvent(state, { type: "run_finished", status: "failed", message: "bad key" })}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("bad key");
  });
});

describe("TranscriptView rewind", () => {
  it("offers conversation-only and conversation-and-files rewind on persisted user messages", async () => {
    const { useAgentStore } = await import("./agent-store");
    const { itemsFromMessages } = await import("./transcript");
    const rewind = vi.fn().mockResolvedValue(undefined);
    const live = itemsFromMessages([
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]);
    useAgentStore.setState({ activeId: "s1", live: { s1: live }, rewind });
    render(<TranscriptView live={live} onDecide={vi.fn()} />);
    const openers = screen.getAllByRole("button", { name: "Rewind to before this message" });
    expect(openers).toHaveLength(2);

    fireEvent.click(openers[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Rewind conversation only" }));
    expect(rewind).toHaveBeenLastCalledWith("s1", 2, false);

    fireEvent.click(screen.getAllByRole("button", { name: "Rewind to before this message" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Rewind conversation and files" }));
    expect(rewind).toHaveBeenLastCalledWith("s1", 0, true);
  });
});
