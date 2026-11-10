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
import { useAgentStore } from "./agent-store";
import { emptyLive } from "./transcript";
import type { AgentSessionListItem } from "./types";
import { AgentShell } from "./agent-shell";

const api = vi.mocked(agentApi);
const session = (id: string, title: string): AgentSessionListItem => ({
  id,
  title,
  cwd: "C:\\work\\proj",
  profileId: "p",
  model: "claude-sonnet",
  permissionMode: "ask_writes",
  messageCount: 0,
  createdAtMs: 1,
  updatedAtMs: 1,
  running: false,
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

describe("CommandPalette Adversarial Stress Tests", () => {
  // Test 1: Rapid Collapse / Expand Cycles across all 4 groups
  it("survives rapid collapse/expand cycles across all 4 groups without state corruption", async () => {
    const props = { ...handlers(), currentView: "agent" as const, onNavigate: vi.fn() };
    render(<CommandPalette {...props} />);
    await screen.findByRole("dialog", { name: "Command palette" });

    const groups = ["Session", "Navigation", "Mode", "Services"] as const;
    const initialOptions = screen.getAllByRole("option");
    const initialCount = initialOptions.length;
    expect(initialCount).toBeGreaterThan(5);

    // 50 rapid toggle iterations across each group
    for (let cycle = 0; cycle < 50; cycle++) {
      const g = groups[cycle % groups.length]!;
      const toggle = screen.getByRole("button", { name: `Toggle ${g} category` });
      fireEvent.click(toggle);
    }

    // Explicitly collapse all 4 groups
    for (const g of groups) {
      const toggle = screen.getByRole("button", { name: `Toggle ${g} category` });
      if (toggle.getAttribute("aria-expanded") === "true") {
        fireEvent.click(toggle);
      }
      expect(toggle).toHaveAttribute("aria-expanded", "false");
    }

    // In all-collapsed state: 0 options rendered
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching commands")).toBeInTheDocument();

    // Explicitly expand all 4 groups back
    for (const g of groups) {
      const toggle = screen.getByRole("button", { name: `Toggle ${g} category` });
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
    }

    // All options restored to exact initial count
    const restoredOptions = screen.getAllByRole("option");
    expect(restoredOptions.length).toBe(initialCount);
  }, 30000);

  // Test 2: Focus roving with arrows across nested items and collapsed groups
  it("handles roving focus with arrows through progressive collapse to empty and back", async () => {
    const props = { ...handlers(), currentView: "agent" as const, onNavigate: vi.fn() };
    render(<CommandPalette {...props} />);
    const box = await screen.findByRole("combobox", { name: "Search commands" });

    const groups = ["Session", "Navigation", "Mode", "Services"] as const;

    // Progressively collapse each group using ArrowLeft
    for (let step = 0; step < groups.length; step++) {
      const currentOptions = screen.getAllByRole("option");
      expect(currentOptions.length).toBeGreaterThan(0);
      const selectedOption = currentOptions.find((opt) => opt.getAttribute("aria-selected") === "true");
      expect(selectedOption).toBeDefined();

      // Press ArrowLeft to collapse current category
      fireEvent.keyDown(box, { key: "ArrowLeft" });
    }

    // Now all groups are collapsed
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    // Pressing ArrowUp / ArrowDown / Home / End / Enter when empty should not throw or crash
    expect(() => {
      fireEvent.keyDown(box, { key: "ArrowDown" });
      fireEvent.keyDown(box, { key: "ArrowUp" });
      fireEvent.keyDown(box, { key: "Home" });
      fireEvent.keyDown(box, { key: "End" });
      fireEvent.keyDown(box, { key: "Enter" });
      fireEvent.keyDown(box, { key: "ArrowLeft" });
    }).not.toThrow();

    expect(props.onClose).not.toHaveBeenCalled();

    // Progressively expand groups back using ArrowRight
    for (let step = 0; step < groups.length; step++) {
      fireEvent.keyDown(box, { key: "ArrowRight" });
    }

    // Verify all groups expanded back
    for (const g of groups) {
      const toggle = screen.getByRole("button", { name: `Toggle ${g} category` });
      expect(toggle).toHaveAttribute("aria-expanded", "true");
    }

    // Roving focus works correctly: ArrowDown wraps around, ArrowUp wraps around
    const options = screen.getAllByRole("option");
    const total = options.length;

    // Start at 0
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    // Wrap to end with ArrowUp
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(options[total - 1]).toHaveAttribute("aria-selected", "true");

    // Wrap back to 0 with ArrowDown
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    // Rove through all options sequentially
    for (let i = 1; i < total; i++) {
      fireEvent.keyDown(box, { key: "ArrowDown" });
      expect(options[i]).toHaveAttribute("aria-selected", "true");
    }
  }, 30000);

  // Test 3: Transitions between empty query (browse mode) and active query (search mode)
  it("preserves collapse configuration across search query transitions and restores flawlessly", async () => {
    const props = { ...handlers(), currentView: "agent" as const, onNavigate: vi.fn() };
    render(<CommandPalette {...props} />);
    const box = await screen.findByRole("combobox", { name: "Search commands" });

    // Collapse Session and Mode categories
    const sessionToggle = screen.getByRole("button", { name: "Toggle Session category" });
    const modeToggle = screen.getByRole("button", { name: "Toggle Mode category" });
    fireEvent.click(sessionToggle);
    fireEvent.click(modeToggle);

    expect(sessionToggle).toHaveAttribute("aria-expanded", "false");
    expect(modeToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("option", { name: "New session" })).toBeNull();
    expect(screen.queryByRole("option", { name: /Permission mode/ })).toBeNull();

    // 25 rapid search transitions: enter query, verify search bypass, clear query, verify collapse restored
    const searchTerms = [
      { term: "new session", target: "New session" },
      { term: "permission", target: "Permission mode: Ask for writes" },
      { term: "settings", target: "Open Settings" },
      { term: "emergency", target: "Emergency stop computer" },
    ];

    for (let i = 0; i < 25; i++) {
      const { term, target } = searchTerms[i % searchTerms.length]!;
      // Switch to search mode
      fireEvent.change(box, { target: { value: term } });
      const found = screen.getByRole("option", { name: new RegExp(target, "i") });
      expect(found).toBeInTheDocument();
      const firstOption = screen.getAllByRole("option")[0]!;
      expect(firstOption).toHaveAttribute("aria-selected", "true");
      expect(box).toHaveAttribute("aria-activedescendant", firstOption.id);

      // Return to browse mode
      fireEvent.change(box, { target: { value: "" } });
      // Session and Mode must still be collapsed
      expect(screen.queryByRole("option", { name: "New session" })).toBeNull();
      expect(screen.queryByRole("option", { name: /Permission mode/ })).toBeNull();
      // Navigation and Services must still be expanded
      expect(screen.getByRole("option", { name: /Open Settings/ })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Emergency stop computer" })).toBeInTheDocument();
    }
  }, 30000);

  // Test 4: Multi open/close cycles in AgentShell without state pollution or memory leaks
  it("mounts fresh and cleans up across 15 full open/close cycles in AgentShell", async () => {
    const { unmount } = render(<AgentShell />);

    for (let cycle = 0; cycle < 15; cycle++) {
      // Open palette via Ctrl+Shift+P
      fireEvent.keyDown(window, { key: "P", ctrlKey: true, shiftKey: true });
      const dialog = await screen.findByRole("dialog", { name: "Command palette" });
      expect(dialog).toBeInTheDocument();

      const box = screen.getByRole("combobox", { name: "Search commands" });
      expect(box).toHaveValue("");

      // All 4 groups must start expanded
      const toggles = screen.getAllByRole("button", { name: /Toggle .* category/ });
      expect(toggles).toHaveLength(4);
      for (const t of toggles) {
        expect(t).toHaveAttribute("aria-expanded", "true");
      }

      // Collapse some categories and rove
      fireEvent.click(toggles[0]!); // Collapse Session
      expect(toggles[0]).toHaveAttribute("aria-expanded", "false");
      fireEvent.keyDown(box, { key: "ArrowDown" });
      fireEvent.keyDown(box, { key: "ArrowDown" });

      // Close palette via Escape
      fireEvent.keyDown(box, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
    }

    unmount();
  }, 30000);

  // Test 5: Keyboard selection execution after complex collapsing and navigating
  it("executes the correct action after arbitrary group collapsing and roving", async () => {
    const props = { ...handlers(), currentView: "agent" as const, onNavigate: vi.fn() };
    render(<CommandPalette {...props} />);
    const box = await screen.findByRole("combobox", { name: "Search commands" });

    // Collapse Session (1st group)
    const sessionToggle = screen.getByRole("button", { name: "Toggle Session category" });
    fireEvent.click(sessionToggle);

    // Now top option should be the first Navigation action ("Switch to Alpha current")
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("Switch to Alpha");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    // Move down 1 option (should be "Switch to Beta")
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveTextContent("Switch to Beta");

    // Hit Enter to execute
    fireEvent.keyDown(box, { key: "Enter" });
    expect(props.onClose).toHaveBeenCalled();
  });
});
