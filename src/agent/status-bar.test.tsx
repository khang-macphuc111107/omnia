import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./agent-api", () => ({
  errorMessage: (cause: unknown) => String(cause),
  agentApi: {},
}));

import { useAgentStore } from "./agent-store";
import { StatusBar, agoLabel, clockLabel } from "./status-bar";
import { emptyLive, type LiveState } from "./transcript";
import type { AgentSessionListItem, ApprovalRequest } from "./types";

const T0 = new Date("2026-11-01T10:00:00").getTime();

const session = (id: string, patch: Partial<AgentSessionListItem> = {}): AgentSessionListItem => ({
  id, title: id, cwd: "C:\\proj", profileId: "anthropic", model: "claude-sonnet-4", permissionMode: "ask_writes",
  messageCount: 0, createdAtMs: 1, updatedAtMs: 1, running: false, ...patch,
});
const usage = { input_tokens: 10_000, output_tokens: 2_300, cache_read_tokens: 2_300, cache_write_tokens: 0 };
const approval: ApprovalRequest = { tool_use_id: "t1", tool: "bash", input: {}, summary: "ls", ordinal: 1, total: 1 };

function seed(live: Partial<LiveState>, extra: Partial<ReturnType<typeof useAgentStore.getState>> = {}) {
  useAgentStore.setState({
    sessions: [session("a", { tokensUsed: 50_000, tokenBudget: 200_000 }), session("b")],
    activeId: "a",
    live: { a: { ...emptyLive(), ...live } },
    activity: { a: { lastRequestAt: T0 - 12_000, runStartedAt: null, lastRunMs: 65_000 } },
    lastRequestAt: T0 - 12_000,
    notice: null,
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("status bar helpers", () => {
  it("formats relative and clock times", () => {
    expect(agoLabel(T0 - 12_000, T0)).toBe("12s ago");
    expect(agoLabel(T0 - 5 * 60_000, T0)).toBe("5m ago");
    expect(agoLabel(T0 - 3 * 3_600_000, T0)).toBe("3h ago");
    expect(clockLabel(42_000)).toBe("0:42");
    expect(clockLabel(3_723_000)).toBe("1:02:03");
  });
});

describe("StatusBar", () => {
  it("renders the session segments from store state", () => {
    seed({ usage, contextUsage: usage, items: [{ key: "e1", kind: "error", message: "boom" }] });
    render(<StatusBar view="agent" />);
    expect(screen.getByRole("button", { name: "Run state: Idle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Model claude-sonnet-4, profile anthropic/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Context/ })).toHaveTextContent("12.3k / 200k (6.2%)");
    expect(screen.getByRole("button", { name: /^Last run tokens/ })).toHaveTextContent("10k in · 2.3k out");
    expect(screen.getByRole("button", { name: "Token budget 25% used" })).toHaveTextContent("Budget 25%");
    expect(screen.getByRole("button", { name: /^Last request 12s ago/ })).toHaveTextContent("Last request 12s ago");
    expect(screen.getByRole("button", { name: /^1 error/ })).toBeInTheDocument();
  });

  it("does not display cumulative run totals as prompt context", () => {
    seed({ usage: { ...usage, input_tokens: 500_000 }, contextUsage: null });
    render(<StatusBar view="agent" />);
    expect(screen.queryByRole("button", { name: /^Context/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Last run tokens/ })).toHaveTextContent("500k in");
  });

  it("uses the fallback model's default window and explains configured limits may differ", () => {
    seed({ activeModel: "gpt-5", contextUsage: { ...usage, input_tokens: 100_000, cache_read_tokens: 0 } });
    render(<StatusBar view="agent" />);
    expect(screen.getByRole("button", { name: /^Model gpt-5/ })).toBeInTheDocument();
    const context = screen.getByRole("button", { name: /^Context/ });
    expect(context).toHaveTextContent("100k / 400k (25%)");
    fireEvent.click(context);
    expect(screen.getByRole("group", { name: /^Context/ })).toHaveTextContent("Configured limits may differ");
    expect(screen.queryByText(/auto-compaction at 80%/)).not.toBeInTheDocument();
  });

  it("discloses saved budget timing instead of implying streamed usage is live", () => {
    seed({ running: true });
    render(<StatusBar view="agent" />);
    fireEvent.click(screen.getByRole("button", { name: "Token budget 25% used" }));
    expect(screen.getByRole("group", { name: "Token budget 25% used" })).toHaveTextContent("Saved session total; refreshes when the run finishes.");
  });

  it("puts the absolute time in the last-request tooltip and updates the relative time live", () => {
    seed({});
    render(<StatusBar view="agent" />);
    const button = screen.getByRole("button", { name: /^Last request/ });
    expect(button.querySelector("[title]")).toHaveAttribute("title", new Date(T0 - 12_000).toLocaleString());
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(button).toHaveTextContent("15s ago");
    // Past a minute it slows to 30s ticks.
    act(() => { vi.advanceTimersByTime(45_000); });
    expect(button).toHaveTextContent("1m ago");
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(button).toHaveTextContent("2m ago");
  });

  it("shows a live running timer and the waiting-for-approval state", () => {
    seed({ running: true }, { activity: { a: { lastRequestAt: T0, runStartedAt: T0 - 40_000, lastRunMs: null } } });
    const { rerender } = render(<StatusBar view="agent" />);
    expect(screen.getByRole("button", { name: /^Run state/ })).toHaveTextContent("Running 0:40");
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByRole("button", { name: /^Run state/ })).toHaveTextContent("Running 0:42");
    act(() => { useAgentStore.setState({ live: { a: { ...emptyLive(), running: true, approvals: [approval] } } }); });
    rerender(<StatusBar view="agent" />);
    expect(screen.getByRole("button", { name: "Run state: Waiting for approval" })).toBeInTheDocument();
  });

  it("shows global running count and last request in workspace views", () => {
    seed({}, {
      sessions: [session("a", { running: true }), session("b", { running: true }), session("c")],
      lastRequestAt: T0 - 5_000,
    });
    render(<StatusBar view="code" />);
    expect(screen.getByRole("button", { name: /^2 running sessions/ })).toHaveTextContent("2 running");
    expect(screen.getByRole("button", { name: /^Last request 5s ago/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Model/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Context/ })).toBeNull();
  });

  it("opens a details popover on click", () => {
    seed({ usage, contextUsage: usage });
    render(<StatusBar view="agent" />);
    fireEvent.click(screen.getByRole("button", { name: /^Context/ }));
    const panel = screen.getByRole("group", { name: /^Context/ });
    expect(panel).toHaveTextContent("Cache reads2,300");
    expect(panel).toHaveTextContent("Context window200,000");
    fireEvent.click(screen.getByRole("button", { name: /^Last request/ }));
    const details = screen.getByRole("group", { name: /^Last request/ });
    expect(details).toHaveTextContent(new Date(T0 - 12_000).toLocaleString());
    expect(details).toHaveTextContent("Last run took1:05");
  });
});
