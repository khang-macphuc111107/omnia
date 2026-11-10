import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/workspace/workbench-window-controls", () => ({ WorkbenchWindowControls: () => null }));
const surfaceMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/labs/workspace-surface", async () => {
  const { useEffect } = await import("react");
  function WorkspaceSurface({ view }: { view: string }) {
    useEffect(() => {
      surfaceMounts.count += 1;
    }, []);
    return <div data-testid="workspace-surface" data-view={view} />;
  }
  return { default: WorkspaceSurface };
});
vi.mock("./session-pane", () => ({ SessionPane: () => <div data-testid="session-pane" /> }));
vi.mock("./diff-pane", () => ({ DiffPane: () => <aside aria-label="Changes panel" /> }));
vi.mock("./artifacts-panel", () => ({ ArtifactsPanel: () => <aside aria-label="Artifacts panel" /> }));
vi.mock("./downloads-panel", () => ({ DownloadsPanel: () => <aside aria-label="Downloads panel" /> }));
vi.mock("./workspace-trust-dialog", () => ({ WorkspaceTrustDialog: () => <div role="dialog" aria-label="Workspace trust dialog" /> }));
vi.mock("./services-dialog", () => ({ ServicesDialog: () => <div role="dialog" aria-label="Services dialog" /> }));
vi.mock("./settings-dialog", () => ({ SettingsDialog: () => <div role="dialog" aria-label="Settings dialog" /> }));
vi.mock("./home-start", () => ({
  HomeStart: ({ onNavigate }: { onNavigate: (view: string) => void }) => (
    <section data-testid="home-start">
      <button type="button" onClick={() => onNavigate("projects")}>Start projects</button>
    </section>
  ),
}));
vi.mock("./status-bar", () => ({ StatusBar: ({ view }: { view: string }) => <footer data-testid="status-bar" data-view={view} /> }));

import { AgentShell, COMPUTER_CONTROL_TOOLS } from "./agent-shell";
import { agentApi } from "./agent-api";
import { useAgentStore } from "./agent-store";
import { emptyLive } from "./transcript";
import type { AgentSessionListItem } from "./types";

const session = {
  id: "session-1",
  title: "Test session",
  cwd: "D:/work/project",
  profileId: "provider-1",
  model: "test-model",
  reasoningEffort: null,
  permissionMode: "ask_writes",
  messageCount: 0,
  createdAtMs: 1,
  updatedAtMs: 1,
  running: false,
} satisfies AgentSessionListItem;

beforeEach(() => {
  surfaceMounts.count = 0;
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
  useAgentStore.setState({
    ready: true,
    startupError: null,
    sessions: [session],
    activeId: session.id,
    live: {},
    notice: null,
    artifactRequest: null,
  });
});

describe("AgentShell session panels", () => {
  it("keeps at most one right-side panel open and lets the active panel close", async () => {
    render(<AgentShell />);

    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Artifacts" }));
    expect(screen.getByRole("button", { name: "Artifacts" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Artifacts" }));
    expect(screen.getByRole("button", { name: "Artifacts" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("session-pane")).toBeInTheDocument();
  });

  it("keeps Changes open when an artifact is created in the active session", async () => {
    render(<AgentShell />);
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    useAgentStore.setState({ artifactRequest: { sessionId: session.id, id: "artifact-1", reason: "created", n: 1 } });
    expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Artifacts" })).toHaveAttribute("aria-pressed", "false");
  });

  it("opens Changes and Artifacts from the command palette", async () => {
    render(<AgentShell />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(await screen.findByRole("combobox", { name: "Search commands" }), { target: { value: "Open Changes panel" } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search commands" }), { key: "Enter" });
    expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(await screen.findByRole("combobox", { name: "Search commands" }), { target: { value: "Open Artifacts panel" } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search commands" }), { key: "Enter" });
    expect(screen.getByRole("button", { name: "Artifacts" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens Workspace trust from the command palette", async () => {
    render(<AgentShell />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(box, { target: { value: "Workspace trust" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows an accessible loading placeholder while a lazy panel loads, then the panel", async () => {
    // Downloads is opened only here, so its lazy module is still unresolved on this click.
    render(<AgentShell />);
    fireEvent.click(screen.getByRole("button", { name: "Downloads" }));
    expect(screen.getByRole("complementary", { name: "Downloads loading" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Loading downloads…");
    expect(screen.getByRole("button", { name: "Downloads" })).toHaveAttribute("aria-pressed", "true");

    expect(await screen.findByRole("complementary", { name: "Downloads panel" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Downloads loading" })).not.toBeInTheDocument();
  });

  it("opens Services from the session actions menu", async () => {
    render(<AgentShell />);
    fireEvent.click(screen.getByRole("button", { name: "More session actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Services" }));
    expect(await screen.findByRole("dialog", { name: "Services dialog" })).toBeInTheDocument();
  });

  it("opens Settings from the command palette", async () => {
    render(<AgentShell />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(box, { target: { value: "Open Settings" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByRole("dialog", { name: "Settings dialog" })).toBeInTheDocument();
  });

  it("opens Artifacts when an artifact is created and no panel is open", async () => {
    render(<AgentShell />);
    useAgentStore.setState({ artifactRequest: { sessionId: session.id, id: "artifact-1", reason: "created", n: 1 } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Artifacts" })).toHaveAttribute("aria-pressed", "true"));
  });

  it("keeps the agent view mounted and hidden while a workspace view is open, and restores it", async () => {
    const { container } = render(<AgentShell />);
    const paneNode = screen.getByTestId("session-pane");
    const appRoot = container.querySelector(".ag-app");
    expect(appRoot).not.toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-current", "page");
    // The workspace surface is lazy: nothing mounts until a workspace view is opened.
    expect(screen.queryByTestId("workspace-surface")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    expect(await screen.findByTestId("workspace-surface")).toHaveAttribute("data-view", "browser");
    expect(screen.getByRole("button", { name: "Browser" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Browser" })).toBeInTheDocument();
    expect(appRoot).toHaveAttribute("hidden");
    expect(screen.getByTestId("session-pane")).toBe(paneNode);

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(appRoot).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("session-pane")).toBe(paneNode);
  });

  it("mounts the workspace surface once and keeps it mounted (hidden) across view switches", async () => {
    const { container } = render(<AgentShell />);
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    const surface = await screen.findByTestId("workspace-surface");
    expect(surfaceMounts.count).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    const workspace = container.querySelector(".ag-workspace");
    expect(workspace).toHaveAttribute("hidden");
    expect(screen.getByTestId("workspace-surface")).toBe(surface);

    fireEvent.click(screen.getByRole("button", { name: "IDE" }));
    expect(workspace).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("workspace-surface")).toBe(surface);
    expect(surface).toHaveAttribute("data-view", "code");
    expect(surfaceMounts.count).toBe(1);
  });

  it("switches the three primary surfaces with Alt+1..3, also from inside text fields", async () => {
    const { container } = render(<AgentShell />);
    const appRoot = container.querySelector(".ag-app");

    fireEvent.keyDown(window, { key: "2", code: "Digit2", altKey: true });
    expect(await screen.findByTestId("workspace-surface")).toHaveAttribute("data-view", "browser");
    expect(appRoot).toHaveAttribute("hidden");

    fireEvent.keyDown(window, { key: "3", code: "Digit3", altKey: true });
    expect(screen.getByTestId("workspace-surface")).toHaveAttribute("data-view", "code");

    // Past the last view nothing happens.
    fireEvent.keyDown(window, { key: "7", code: "Digit7", altKey: true });
    expect(screen.getByTestId("workspace-surface")).toHaveAttribute("data-view", "code");

    // Modified combos are left alone.
    fireEvent.keyDown(window, { key: "1", code: "Digit1", altKey: true, ctrlKey: true });
    expect(appRoot).toHaveAttribute("hidden");

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "1", code: "Digit1", altKey: true });
    expect(appRoot).not.toHaveAttribute("hidden");
    input.remove();
  });

  it("ignores Alt+digit while a dialog is open", async () => {
    const { container } = render(<AgentShell />);
    fireEvent.click(screen.getByRole("button", { name: "More session actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Services" }));
    await screen.findByRole("dialog", { name: "Services dialog" });
    fireEvent.keyDown(window, { key: "3", code: "Digit3", altKey: true });
    expect(container.querySelector(".ag-app")).not.toHaveAttribute("hidden");
    expect(screen.queryByTestId("workspace-surface")).not.toBeInTheDocument();
  });

  it("has no disclosure row; panels are header icon buttons and the rest live in one overflow menu", async () => {
    render(<AgentShell />);
    expect(screen.queryByRole("navigation", { name: "Workspace navigation" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Toggle .* group$/ })).toBeNull();

    const panels = screen.getByRole("group", { name: "Session panels" });
    for (const label of ["Changes", "Artifacts", "Downloads"]) {
      const button = screen.getByRole("button", { name: label });
      expect(panels).toContainElement(button);
      expect(button).toHaveAttribute("title", label);
      expect(button).toHaveAttribute("aria-pressed", "false");
    }
    // Each panel has exactly one button in the shell.
    expect(screen.getAllByRole("button", { name: /changes/i })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "More session actions" }));
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    expect(items).toEqual(["Open split view", "Rename session", "Session settings", "Workspace trust", "Services", "Delete session"]);
    // Settings is not duplicated in the overflow menu: it lives in the rail.
    expect(screen.queryByRole("menuitem", { name: "Settings" })).toBeNull();
  });

  it("shows a Changes count badge from finished edit tools in the active session", () => {
    const edit = (id: string, name: string, path: string) => ({
      key: id, kind: "tool" as const, id, name, input: { path }, summary: "", status: "ok" as const, output: "", progress: "", partialJson: "", sub: null,
    });
    useAgentStore.setState({
      live: {
        [session.id]: {
          ...emptyLive(),
          items: [edit("t1", "edit_file", "a.ts"), edit("t2", "write_file", "b.ts"), edit("t3", "edit_file", "a.ts"), edit("t4", "read_file", "c.ts")],
        },
      },
    });
    render(<AgentShell />);
    const changes = screen.getByRole("button", { name: "Changes" });
    expect(changes).toHaveAttribute("title", "Changes (2)");
    expect(changes).toHaveTextContent("2");
  });

  it("toggles split view and deletes the session from the overflow menu", async () => {
    const toggleSplit = vi.fn();
    const remove = vi.fn().mockResolvedValue(undefined);
    useAgentStore.setState({ toggleSplit, remove });
    render(<AgentShell />);
    fireEvent.click(screen.getByRole("button", { name: "More session actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open split view" }));
    expect(toggleSplit).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "More session actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete session" }));
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    expect(remove).toHaveBeenCalledWith(session.id);
  });

  it("renames the session inline from the overflow menu", async () => {
    const rename = vi.fn().mockResolvedValue(undefined);
    useAgentStore.setState({ rename });
    render(<AgentShell />);
    fireEvent.click(screen.getByRole("button", { name: "More session actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename session" }));
    const box = screen.getByRole("textbox", { name: "Session title" });
    fireEvent.change(box, { target: { value: "Renamed" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(rename).toHaveBeenCalledWith(session.id, "Renamed");
    expect(screen.queryByRole("textbox", { name: "Session title" })).toBeNull();
  });

  it("shows the session title with a full-title tooltip and the folder as a breadcrumb", () => {
    render(<AgentShell />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("project");
    expect(heading).toHaveTextContent("Test session");
    expect(heading.querySelector(".ag-header__session-title")).toHaveAttribute("title", "Test session");
    expect(heading.querySelector(".ag-header__breadcrumb")).toHaveAttribute("title", "D:/work/project");
  });

  it("opens Settings from the rail button", async () => {
    render(<AgentShell />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings dialog" })).toBeInTheDocument();
  });

  it("opens Settings with Ctrl+, in a workspace view", async () => {
    render(<AgentShell />);
    fireEvent.click(screen.getByRole("button", { name: "IDE" }));
    await screen.findByTestId("workspace-surface");
    fireEvent.keyDown(window, { key: ",", code: "Comma", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Settings dialog" })).toBeInTheDocument();
  });

  it("opens the Changes panel on the omnia:open-changes window event, also from a workspace view", async () => {
    const { container } = render(<AgentShell />);
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    await screen.findByTestId("workspace-surface");
    act(() => {
      window.dispatchEvent(new CustomEvent("omnia:open-changes", { detail: { path: "src/a.ts" } }));
    });
    expect(container.querySelector(".ag-app")).not.toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("complementary", { name: "Changes panel" })).toBeInTheDocument();
  });

  it("renders the status bar in every view", async () => {
    render(<AgentShell />);
    expect(screen.getAllByTestId("status-bar")).toHaveLength(1);
    expect(screen.getByTestId("status-bar")).toHaveAttribute("data-view", "agent");
    for (const label of ["Browser", "IDE"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await screen.findByTestId("workspace-surface");
      expect(screen.getAllByTestId("status-bar")).toHaveLength(1);
      expect(screen.getByTestId("status-bar")).toHaveAttribute("data-view", label === "IDE" ? "code" : "browser");
    }
  });

  it("keeps agent-only shortcuts inactive in workspace views and renders dialogs outside the hidden agent view", async () => {
    const interruptSpy = vi.fn().mockResolvedValue(undefined);
    const toggleSplitSpy = vi.fn();
    useAgentStore.setState({
      interrupt: interruptSpy,
      toggleSplit: toggleSplitSpy,
      live: {
        [session.id]: {
          ...emptyLive(),
          running: true,
        },
      },
    });

    const { container } = render(<AgentShell />);
    const appRoot = container.querySelector(".ag-app")!;

    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    expect(await screen.findByTestId("workspace-surface")).toBeInTheDocument();
    expect(appRoot).toHaveAttribute("hidden");

    // Escape and Ctrl+\ must not reach the background agent session.
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "\\", code: "Backslash", ctrlKey: true });
    expect(interruptSpy).not.toHaveBeenCalled();
    expect(toggleSplitSpy).not.toHaveBeenCalled();

    // Ctrl+K works in every view; Settings renders outside the hidden agent view.
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(box, { target: { value: "Open Settings" } });
    fireEvent.keyDown(box, { key: "Enter" });

    const settingsDialog = await screen.findByRole("dialog", { name: "Settings dialog" });
    expect(appRoot.contains(settingsDialog)).toBe(false);
    // Alt+digit is ignored while the dialog is open.
    fireEvent.keyDown(window, { key: "1", code: "Digit1", altKey: true });
    expect(appRoot).toHaveAttribute("hidden");
  });

  it("returns to the agent view when an agent panel is opened from the command palette", async () => {
    const { container } = render(<AgentShell />);
    const appRoot = container.querySelector(".ag-app")!;
    fireEvent.click(screen.getByRole("button", { name: "IDE" }));
    expect(await screen.findByTestId("workspace-surface")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(box, { target: { value: "Open Artifacts panel" } });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(appRoot).not.toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "Artifacts" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-current", "page");
  });
});

describe("AgentShell empty state", () => {
  it("renders HomeStart when no session is active and navigates from it", async () => {
    useAgentStore.setState({ activeId: null });
    render(<AgentShell />);
    expect(screen.getByTestId("home-start")).toBeInTheDocument();
    expect(screen.queryByText("What should we work on?")).toBeNull();
    expect(screen.queryByRole("group", { name: "Session panels" })).toBeNull();
    expect(screen.getByTestId("status-bar")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start projects" }));
    expect(await screen.findByTestId("workspace-surface")).toHaveAttribute("data-view", "projects");
  });
});

describe("AgentShell emergency stop", () => {
  const tool = (name: string, status: "running" | "ok" | "pending") => ({
    key: "k-" + name + "-" + status, kind: "tool" as const, id: name + "-" + status, name, input: {}, summary: "", status,
    output: "", progress: "", partialJson: "", sub: null,
  });

  it("is hidden while no computer or browser tool is live", () => {
    useAgentStore.setState({ live: { [session.id]: { ...emptyLive(), running: true, items: [tool("bash", "running"), tool("computer_click", "ok")] } } });
    render(<AgentShell />);
    expect(screen.queryByRole("button", { name: "Emergency stop computer" })).toBeNull();
  });

  it("shows a compact Stop pill while a computer tool runs in any session, and calls the stop API", () => {
    const stop = vi.spyOn(agentApi, "emergencyStopComputer").mockResolvedValue(undefined);
    useAgentStore.setState({ live: { other: { ...emptyLive(), running: true, items: [tool("computer_click", "running")] } } });
    render(<AgentShell />);
    const pill = screen.getByRole("button", { name: "Emergency stop computer" });
    expect(pill).toHaveTextContent("Stop");
    fireEvent.click(pill);
    expect(stop).toHaveBeenCalledTimes(1);
    stop.mockRestore();

    act(() => useAgentStore.setState({ live: { other: { ...emptyLive(), running: false, items: [tool("computer_click", "ok")] } } }));
    expect(screen.queryByRole("button", { name: "Emergency stop computer" })).toBeNull();
  });

  it("shows while a browser-control tool waits for approval or runs inside a subagent", () => {
    useAgentStore.setState({
      live: {
        [session.id]: {
          ...emptyLive(),
          approvals: [{ tool_use_id: "a1", tool: "browser_navigate", input: {}, summary: "", ordinal: 1, total: 1 }],
        },
      },
    });
    const { unmount } = render(<AgentShell />);
    expect(screen.getByRole("button", { name: "Emergency stop computer" })).toBeInTheDocument();
    unmount();

    useAgentStore.setState({
      live: {
        [session.id]: {
          ...emptyLive(),
          running: true,
          items: [{ ...tool("task", "running"), sub: { ...emptyLive(), running: true, items: [tool("browser_click", "running")] } }],
        },
      },
    });
    render(<AgentShell />);
    expect(screen.getByRole("button", { name: "Emergency stop computer" })).toBeInTheDocument();
  });

  it("keeps every harness computer/browser tool name in one constant", () => {
    expect(COMPUTER_CONTROL_TOOLS.has("computer_act")).toBe(true);
    expect(COMPUTER_CONTROL_TOOLS.has("browser_save_page")).toBe(true);
    expect(COMPUTER_CONTROL_TOOLS.has("bash")).toBe(false);
  });
});

describe("AgentShell narrow sidebar drawer", () => {
  it("shows a scrim on narrow windows that closes the drawer on click and Escape", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 600 });
    render(<AgentShell />);
    const scrim = await screen.findByTestId("sidebar-scrim");
    fireEvent.click(scrim);
    expect(screen.queryByTestId("sidebar-scrim")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(screen.getByTestId("sidebar-scrim")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("sidebar-scrim")).toBeNull();
  });

  it("has no scrim on wide windows", () => {
    render(<AgentShell />);
    expect(screen.queryByTestId("sidebar-scrim")).toBeNull();
  });
});
