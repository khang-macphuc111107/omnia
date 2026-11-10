import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./agent-api", () => ({
  errorMessage: (cause: unknown) => String(cause),
  agentApi: {
    ensureReady: vi.fn(async () => undefined),
    onEvent: vi.fn(async () => () => undefined),
    list: vi.fn(async () => []),
    update: vi.fn(),
    interrupt: vi.fn(async () => undefined),
    emergencyStopComputer: vi.fn(async () => undefined),
  },
}));

import { agentApi } from "./agent-api";
import { CommandPalette } from "./command-palette";
import { SHELL_VIEWS, type ShellView } from "./shell-view";
import { useAgentStore } from "./agent-store";
import { emptyLive } from "./transcript";
import type { AgentSessionListItem } from "./types";

const api = vi.mocked(agentApi);
const session = (id: string, title: string): AgentSessionListItem => ({
  id, title, cwd: "C:\\work\\proj", profileId: "p", model: "claude-sonnet", permissionMode: "ask_writes",
  messageCount: 0, createdAtMs: 1, updatedAtMs: 1, running: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.update.mockImplementation(async (id: string, patch: object) => ({ ...session(id, "Alpha"), ...patch }));
  useAgentStore.setState({
    ready: true,
    startupError: null,
    sessions: [session("a", "Alpha"), session("b", "Beta")],
    activeId: "a",
    live: { a: emptyLive(), b: emptyLive() },
    notice: null,
  });
});

const handlers = () => ({
  onClose: vi.fn(),
  onNewSession: vi.fn(),
  onToggleSidebar: vi.fn(),
  onOpenDownloads: vi.fn(),
  onOpenChanges: vi.fn(),
  onOpenArtifacts: vi.fn(),
  onOpenWorkspaceTrust: vi.fn(),
  onOpenServices: vi.fn(),
  onOpenSessionSettings: vi.fn(),
  onOpenSettings: vi.fn(),
  onDeleteCurrent: vi.fn(),
});
const renderPalette = (currentView: ShellView = "agent") => {
  const props = { ...handlers(), currentView, onNavigate: vi.fn() };
  render(<CommandPalette {...props} />);
  return props;
};

describe("CommandPalette", () => {
  it("renders with dialog and listbox roles and closes on Escape", async () => {
    const props = renderPalette();
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByRole("option").length).toBeGreaterThan(5);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  });

  it("traps Tab in both directions and closes once on Escape", async () => {
    const close = vi.fn();
    const { unmount } = render(
      <><button>Launcher</button><CommandPalette {...handlers()} currentView="agent" onNavigate={vi.fn()} onClose={close} /></>,
    );
    const box = screen.getByRole("combobox");
    await waitFor(() => expect(box).toHaveFocus());
    const toggles = screen.getAllByRole("button", { name: /Toggle .* category/ });
    const last = toggles[toggles.length - 1]!;
    fireEvent.keyDown(box, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: "zzzzqq" } });
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box).toHaveFocus();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("restores the launcher's focus when unmounted", async () => {
    const launcher = document.createElement("button");
    document.body.appendChild(launcher);
    launcher.focus();
    const { unmount } = render(<CommandPalette {...handlers()} currentView="agent" onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());
    unmount();
    expect(launcher).toHaveFocus();
    launcher.remove();
  });

  it("wraps selection, supports Home/End and scrolls only the results viewport", () => {
    renderPalette();
    const box = screen.getByRole("combobox");
    const list = screen.getByRole("listbox");
    const options = screen.getAllByRole("option");
    const last = options[options.length - 1]!;
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({ top: 20, bottom: 120 } as DOMRect);
    vi.spyOn(last, "getBoundingClientRect").mockReturnValue({ top: 160, bottom: 190 } as DOMRect);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(last).toHaveAttribute("aria-selected", "true");
    expect(list.scrollTop).toBe(70);
    expect(box).toHaveAttribute("aria-activedescendant", last.id);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "End" });
    expect(last).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "Home" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("does not execute commands during IME composition or when no results match", () => {
    const props = renderPalette();
    const box = screen.getByRole("combobox");
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(props.onNewSession).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "zzzzqq" } });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box).not.toHaveAttribute("aria-activedescendant");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("keeps rename editing independent of command navigation, including an empty title", async () => {
    const props = renderPalette();
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "Rename current session" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box).toHaveAccessibleName("New session title");
    fireEvent.change(box, { target: { value: "" } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    fireEvent.keyDown(box, { key: "ArrowLeft" });
    fireEvent.keyDown(box, { key: "ArrowRight" });
    fireEvent.change(box, { target: { value: "Renamed" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("a", { title: "Renamed" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("preserves the full text of long session labels inside a wrappable label", () => {
    const title = "VeryLongSession".repeat(100);
    useAgentStore.setState({ sessions: [session("a", title)] });
    renderPalette();
    const option = screen.getByRole("option", { name: `Switch to ${title} current` });
    expect(option.querySelector(".ag-palette__label")).toHaveTextContent(`Switch to ${title}`);
    expect(screen.getByRole("dialog").parentElement).toHaveClass("ag-palette-scrim");
  });

  it("filters fuzzily, including switch-to-session entries", async () => {
    renderPalette();
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(box, { target: { value: "beta" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Switch to Beta");
    fireEvent.change(box, { target: { value: "pmfl" } });
    expect(screen.getByRole("option", { name: /Permission mode: Full access/ })).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "zzzzqq" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("runs the highlighted action on Enter and closes", async () => {
    const props = renderPalette();
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(box, { target: { value: "mode: full" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("a", { permissionMode: "full" }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("moves the selection with arrows", async () => {
    renderPalette();
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  });

  it("exposes Changes, Artifacts, and Workspace trust commands", async () => {
    renderPalette();
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    for (const command of ["Open Changes panel", "Open Artifacts panel", "Workspace trust"]) {
      fireEvent.change(box, { target: { value: command } });
      expect(screen.getByRole("option", { name: command })).toBeInTheDocument();
    }
  });

  it("runs emergency stop from the palette", async () => {
    renderPalette();
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(box, { target: { value: "emergency" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.emergencyStopComputer).toHaveBeenCalled());
  });

  it("collapses a category to hide child options and expands to restore them", async () => {
    renderPalette();
    await screen.findByRole("dialog", { name: "Command palette" });

    // Initial state: Session category is expanded, child options are visible
    expect(screen.getByRole("option", { name: "New session" })).toBeInTheDocument();
    const sessionToggle = screen.getByRole("button", { name: "Toggle Session category" });
    expect(sessionToggle).toHaveAttribute("aria-expanded", "true");

    // Click to collapse Session category
    fireEvent.click(sessionToggle);
    expect(sessionToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("option", { name: "New session" })).toBeNull();

    // Click to expand Session category back
    fireEvent.click(sessionToggle);
    expect(sessionToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("option", { name: "New session" })).toBeInTheDocument();
  });

  it("collapses focused category with ArrowLeft and expands with ArrowRight", async () => {
    renderPalette();
    const box = await screen.findByRole("combobox", { name: "Search commands" });

    // First option belongs to Session group
    const firstOption = screen.getAllByRole("option")[0];
    expect(firstOption).toHaveTextContent("New session");
    const sessionToggle = screen.getByRole("button", { name: "Toggle Session category" });
    expect(sessionToggle).toHaveAttribute("aria-expanded", "true");

    // Press ArrowLeft to collapse current group
    fireEvent.keyDown(box, { key: "ArrowLeft" });
    expect(sessionToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("option", { name: "New session" })).toBeNull();

    // Press ArrowRight to expand group back
    fireEvent.keyDown(box, { key: "ArrowRight" });
    expect(sessionToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("option", { name: "New session" })).toBeInTheDocument();
  });

  it("displays all matching options across groups in search mode regardless of collapse state", async () => {
    renderPalette();
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    const sessionToggle = screen.getByRole("button", { name: "Toggle Session category" });

    // Collapse Session category
    fireEvent.click(sessionToggle);
    expect(screen.queryByRole("option", { name: "New session" })).toBeNull();

    // Search Mode reveals matching actions across all groups
    fireEvent.change(box, { target: { value: "New session" } });
    expect(screen.getByRole("option", { name: "New session" })).toBeInTheDocument();

    // Clearing search restores collapsed state
    fireEvent.change(box, { target: { value: "" } });
    expect(screen.queryByRole("option", { name: "New session" })).toBeNull();
  });

  it("lists a navigation entry per shell view and calls onNavigate with its id", async () => {
    const props = renderPalette("agent");
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(box, { target: { value: "Go to Chat" } });
    expect(screen.getByRole("option", { name: /Go to Chat/ })).toHaveTextContent("current");
    for (const view of SHELL_VIEWS) {
      const label = `Go to ${view.label}`;
      fireEvent.change(box, { target: { value: label } });
      const option = screen.getByRole("option", { name: new RegExp(label) });
      expect(option).toHaveTextContent(view.id === "agent" ? "current" : view.shortcut);
    }
    fireEvent.change(box, { target: { value: "Go to Projects" } });
    expect(screen.getByRole("option", { name: /Go to Projects/ })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(props.onNavigate).toHaveBeenCalledWith("projects");
    expect(props.onClose).toHaveBeenCalled();
  });

  it("finds Chat and Library by their surface and tab keywords", async () => {
    renderPalette("code");
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    for (const [term, name] of [["chat", /Go to Chat/], ["sessions", /Go to Chat/], ["memory", /Go to Library/], ["skills", /Go to Library/]] as const) {
      fireEvent.change(box, { target: { value: term } });
      expect(screen.getByRole("option", { name })).toBeInTheDocument();
    }
    fireEvent.change(box, { target: { value: "Go to Library" } });
    expect(screen.getByRole("option", { name: /Go to Library/ })).toHaveTextContent("Memory, Skills");
    expect(screen.queryByRole("option", { name: /Agent chat/ })).toBeNull();
  });

  it("lists Settings, split view, services, schedules and emergency stop always", async () => {
    const props = renderPalette("browser");
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(box, { target: { value: "Open Settings" } });
    expect(screen.getByRole("option", { name: /Open Settings/ })).toHaveTextContent("Ctrl+,");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(props.onOpenSettings).toHaveBeenCalled();
    for (const label of ["split view", "Open Services", "Session settings", "Scheduled tasks", "Emergency stop computer", "Workspace trust"]) {
      fireEvent.change(box, { target: { value: label } });
      expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    }
  });

  it("marks the current workspace view and finds views by keyword", async () => {
    const props = renderPalette("code");
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(box, { target: { value: "Go to IDE" } });
    expect(screen.getByRole("option", { name: /Go to IDE/ })).toHaveTextContent("current");
    fireEvent.change(box, { target: { value: "vs code" } });
    expect(screen.getByRole("option", { name: /Go to IDE/ })).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "web" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(props.onNavigate).toHaveBeenCalledWith("browser");
    // The active session is not "current" outside the agent view.
    fireEvent.change(box, { target: { value: "Switch to Alpha" } });
    expect(screen.getByRole("option", { name: /Switch to Alpha/ })).not.toHaveTextContent("current");
  });

  it("opening a session from a workspace view navigates to agent", async () => {
    const props = renderPalette("library");
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(box, { target: { value: "Switch to Beta" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(props.onNavigate).toHaveBeenCalledWith("agent");
  });

  it("opening a session from the agent view does not navigate", async () => {
    const props = renderPalette("agent");
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    expect(screen.getByRole("option", { name: /Switch to Alpha/ })).toHaveTextContent("current");
    fireEvent.change(box, { target: { value: "Switch to Beta" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(props.onNavigate).not.toHaveBeenCalled();
  });
});
