import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/workspace/markdown", () => ({
  MessageMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("./agent-api", () => ({
  errorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
  agentApi: {
    ensureReady: vi.fn(async () => undefined),
    onEvent: vi.fn(async () => () => undefined),
    list: vi.fn(),
    read: vi.fn(),
    send: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    decide: vi.fn(async () => undefined),
    update: vi.fn(),
    remove: vi.fn(async () => undefined),
    commandsList: vi.fn(async () => []),
    workspaceFiles: vi.fn(async () => []),
  },
}));

import { agentApi } from "./agent-api";
import { useAgentStore } from "./agent-store";
import { readPrefs } from "./prefs";
import { SessionPane } from "./session-pane";
import { initialSplit } from "./split";
import { emptyLive, reduceAgentEvent } from "./transcript";
import type { AgentSessionListItem, AgentWireEvent } from "./types";

function installStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    },
  });
}
installStorage();

const api = vi.mocked(agentApi);
const session = (id: string, patch: Partial<AgentSessionListItem> = {}): AgentSessionListItem => ({
  id,
  title: `Session ${id.toUpperCase()}`,
  cwd: "C:\\proj",
  profileId: "p",
  model: "m",
  permissionMode: "ask_writes",
  messageCount: 0,
  createdAtMs: 1,
  updatedAtMs: 1,
  running: false,
  ...patch,
});
const store = () => useAgentStore.getState();
const request = (id: string, tool: string) => ({
  tool_use_id: id,
  tool,
  input: {},
  summary: `${tool} summary`,
  ordinal: 1,
  total: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useAgentStore.setState({
    ready: true,
    startupError: null,
    sessions: [session("a", { updatedAtMs: 3 }), session("b", { updatedAtMs: 2 }), session("c", { updatedAtMs: 1 })],
    activeId: "a",
    live: { a: emptyLive(), b: emptyLive(), c: emptyLive() },
    notice: null,
    drafts: {},
    deciding: {},
    split: initialSplit(),
    narrow: false,
  });
  api.read.mockImplementation(async (id: string) => ({ summary: session(id), running: false, messages: [] }) as never);
});

describe("split store", () => {
  it("opens a session in a split, loads it without losing the other, and focuses it", async () => {
    store().openInSplit("b");
    expect(store().split.panes).toEqual(["a", "b"]);
    expect(store().activeId).toBe("b");
    store().focusSplitPane(0);
    expect(store().activeId).toBe("a");
  });

  it("loads the second session's transcript only if it is not already live", async () => {
    useAgentStore.setState({ live: { a: emptyLive() } });
    store().openInSplit("b");
    await store().load("b");
    expect(api.read).toHaveBeenCalledWith("b");
    expect(store().live.b).toBeDefined();
    api.read.mockClear();
    await store().load("b");
    expect(api.read).not.toHaveBeenCalled();
  });

  it("routes events by sessionId to both visible panes", () => {
    store().openInSplit("b");
    const start: AgentWireEvent = { type: "run_started" };
    store().applyEvent({ sessionId: "b", event: start });
    expect(store().live.b?.running).toBe(true);
    expect(store().live.a?.running).toBe(false);
    store().applyEvent({ sessionId: "a", event: start });
    expect(store().live.a?.running).toBe(true);
  });

  it("addresses send, interrupt and decide to the pane's session, not the focused one", async () => {
    store().openInSplit("b"); // b focused
    await store().send("hi a", [], "a");
    expect(api.send).toHaveBeenCalledWith("a", "hi a", []);
    await store().interrupt("a");
    expect(api.interrupt).toHaveBeenCalledWith("a");
    await store().decide("t1", { type: "allow_once" }, "a");
    expect(api.decide).toHaveBeenCalledWith("a", "t1", { type: "allow_once" });
    await store().decide("t2", { type: "allow_once" });
    expect(api.decide).toHaveBeenLastCalledWith("b", "t2", { type: "allow_once" });
  });

  it("closes a pane leaving the other focused, then Ctrl+\\ toggle reopens the last partner", () => {
    store().openInSplit("b");
    store().closeSplitPane(1);
    expect(store().split.panes).toBeNull();
    expect(store().activeId).toBe("a");
    store().toggleSplit();
    expect(store().split.panes).toEqual(["a", "b"]);
    store().toggleSplit(); // close: keeps the focused session (b)
    expect(store().split.panes).toBeNull();
    expect(store().activeId).toBe("b");
  });

  it("toggle with no remembered partner picks the most recent other session", () => {
    store().toggleSplit();
    expect(store().split.panes).toEqual(["a", "b"]);
  });

  it("swaps panes keeping the focused session", () => {
    store().openInSplit("b");
    store().swapSplit();
    expect(store().split.panes).toEqual(["b", "a"]);
    expect(store().activeId).toBe("b");
  });

  it("opening a session from the sidebar while split replaces the focused pane", async () => {
    store().openInSplit("b");
    await store().open("c");
    expect(store().split.panes).toEqual(["a", "c"]);
    expect(store().activeId).toBe("c");
  });

  it("persists the divider ratio only when asked, clamped", () => {
    store().openInSplit("b");
    store().setSplitRatio(0.4, false);
    expect(store().split.ratio).toBe(0.4);
    expect(readPrefs().splitRatio).toBeUndefined();
    store().setSplitRatio(0.9);
    expect(store().split.ratio).toBe(0.75);
    expect(readPrefs().splitRatio).toBe(0.75);
  });

  it("collapses the split when a pane's session is deleted", async () => {
    store().openInSplit("b");
    await store().remove("b");
    expect(store().split.panes).toBeNull();
    expect(store().activeId).toBe("a");
  });

  it("collapses on refresh when a session vanished", async () => {
    store().openInSplit("b");
    api.list.mockResolvedValue([session("a"), session("c")]);
    await store().refresh();
    expect(store().split.panes).toBeNull();
    expect(store().activeId).toBe("a");
  });

  it("falls back to a single visible pane when narrow but keeps the split state", () => {
    store().openInSplit("b");
    store().setNarrow(true);
    expect(store().narrow).toBe(true);
    expect(store().split.panes).toEqual(["a", "b"]);
    expect(store().activeId).toBe("b");
  });
});

describe("approval cards per pane", () => {
  it("renders session B's approval only in pane B", () => {
    const withApproval = ([
      { type: "run_started" },
      { type: "approval_requested", request: request("tb", "bash-for-b") },
    ] as AgentWireEvent[]).reduce(reduceAgentEvent, emptyLive());
    useAgentStore.setState({ live: { a: emptyLive(), b: withApproval, c: emptyLive() } });
    store().openInSplit("b");
    render(
      <>
        <SessionPane sessionId="a" focused={false} split />
        <SessionPane sessionId="b" focused split />
      </>,
    );
    const paneA = screen.getByRole("tabpanel", { name: "Session Session A" });
    const paneB = screen.getByRole("tabpanel", { name: "Session Session B" });
    expect(within(paneB).getByText("Allow bash-for-b?")).toBeInTheDocument();
    expect(within(paneA).queryByText("Allow bash-for-b?")).toBeNull();
  });

  it("decides an unfocused pane's approval against that pane's session", async () => {
    const live = ([{ type: "approval_requested", request: request("ta", "write-a") }] as AgentWireEvent[]).reduce(reduceAgentEvent, emptyLive());
    useAgentStore.setState({ live: { a: live, b: emptyLive(), c: emptyLive() } });
    store().openInSplit("b"); // b focused, a has the approval
    render(
      <>
        <SessionPane sessionId="a" focused={false} split />
        <SessionPane sessionId="b" focused split />
      </>,
    );
    const paneA = screen.getByRole("tabpanel", { name: "Session Session A" });
    within(paneA).getByRole("button", { name: "Allow once" }).click();
    await vi.waitFor(() => expect(api.decide).toHaveBeenCalledWith("a", "ta", { type: "allow_once" }));
  });

  it("does not steal keyboard focus for an approval in an unfocused pane", () => {
    const live = ([{ type: "approval_requested", request: request("ta", "write-a") }] as AgentWireEvent[]).reduce(reduceAgentEvent, emptyLive());
    useAgentStore.setState({ live: { a: live, b: emptyLive(), c: emptyLive() } });
    store().openInSplit("b");
    render(
      <>
        <SessionPane sessionId="a" focused={false} split />
        <SessionPane sessionId="b" focused split />
      </>,
    );
    const approval = within(screen.getByRole("tabpanel", { name: "Session Session A" })).getByRole("group", { name: "Approval required" });
    expect(document.activeElement).not.toBe(approval);
  });

  it("close and swap buttons on a pane act on the store", () => {
    store().openInSplit("b");
    const onClose = vi.fn();
    render(<SessionPane sessionId="a" focused={false} split onClose={onClose} />);
    screen.getByRole("button", { name: "Close pane Session A" }).click();
    expect(onClose).toHaveBeenCalled();
  });
});
