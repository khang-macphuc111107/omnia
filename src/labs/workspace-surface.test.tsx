import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceStore } from "@/features/workspace/store";

const bridgeMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  dispose: vi.fn(async () => undefined),
  create: vi.fn(),
  startBuffer: vi.fn(async () => undefined),
}));

vi.mock("@/runtime/omnia-runtime-bridge", () => ({
  createOmniaRuntimeBridge: (...args: unknown[]) => {
    bridgeMocks.create(...args);
    return { initialize: bridgeMocks.initialize, dispose: bridgeMocks.dispose };
  },
}));
vi.mock("@/features/workspace/run-event-broker", () => ({
  startRunEventJournalBuffer: bridgeMocks.startBuffer,
  subscribeRunEvents: () => () => undefined,
  applyRunStreamEventToStore: () => undefined,
}));
vi.mock("@/features/workspace/activity-screen-host", () => ({
  ActivityScreenHost: ({ activity }: { activity: string }) => (
    <section data-testid="activity-screen" data-activity={activity} />
  ),
}));
vi.mock("@/features/workspace/sovereign-ide-remote-workbench", () => ({
  default: () => <section data-testid="full-window-ide" />,
}));
vi.mock("@/features/workspace/sovereign-browser-workbench", () => ({
  default: () => <section data-testid="full-window-browser" />,
}));
vi.mock("@/features/workspace/command-palette-host", () => ({
  CommandPaletteHost: () => <div data-testid="command-host" />,
}));
vi.mock("@/features/workspace/global-dialogs-host", () => ({
  GlobalDialogsHost: () => <div data-testid="dialog-host" />,
}));

import WorkspaceSurface, { resetLibraryTabForTests } from "./workspace-surface";
import { resetWorkspaceRuntimeForTests } from "./workspace-runtime";

const initialState = useWorkspaceStore.getState();

const browserSnapshot = {
  snapshot: {
    runtimeInfo: { appName: "Omnia", appVersion: "0.1.0", platform: "web", tauri: false, debug: true },
    core: { protocolVersion: 1 },
  },
};

describe("WorkspaceSurface", () => {
  beforeEach(() => {
    resetWorkspaceRuntimeForTests();
    resetLibraryTabForTests();
    bridgeMocks.initialize.mockReset();
    bridgeMocks.create.mockClear();
    bridgeMocks.startBuffer.mockClear();
    useWorkspaceStore.setState({ activeActivity: "chats" });
  });

  afterEach(() => {
    act(() => useWorkspaceStore.setState(initialState, true));
  });

  it("initializes the runtime once across view switches and remounts", async () => {
    bridgeMocks.initialize.mockResolvedValue(browserSnapshot);
    const { rerender, unmount, container } = render(<WorkspaceSurface view="projects" />);

    expect(await screen.findByTestId("activity-screen")).toHaveAttribute("data-activity", "projects");
    expect(container.firstElementChild).toHaveClass("ws-surface");
    expect(container.firstElementChild).toHaveAttribute("data-view", "projects");
    expect(screen.getByTestId("dialog-host")).toBeInTheDocument();

    for (const view of ["work", "library"] as const) {
      rerender(<WorkspaceSurface view={view} />);
      expect(screen.getByTestId("activity-screen")).toHaveAttribute("data-activity", view);
      expect(useWorkspaceStore.getState().activeActivity).toBe(view);
    }
    unmount();
    render(<WorkspaceSurface view="projects" />);
    expect(screen.getByTestId("activity-screen")).toHaveAttribute("data-activity", "projects");

    expect(bridgeMocks.create).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.initialize).toHaveBeenCalledTimes(1);
    // Browser preview: no native hydration path.
    expect(bridgeMocks.startBuffer).not.toHaveBeenCalled();
  });

  it.each([
    ["code", "full-window-ide"],
    ["browser", "full-window-browser"],
  ] as const)("renders the %s workbench full-bleed", async (view, testId) => {
    bridgeMocks.initialize.mockResolvedValue(browserSnapshot);
    const { container } = render(<WorkspaceSurface view={view} />);

    expect(await screen.findByTestId(testId)).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("ws-surface--full-bleed");
    expect(screen.queryByTestId("activity-screen")).not.toBeInTheDocument();
  });

  it("shows startup errors with a retry that re-attempts initialization", async () => {
    bridgeMocks.initialize
      .mockRejectedValueOnce(new Error("core offline"))
      .mockResolvedValueOnce(browserSnapshot);
    render(<WorkspaceSurface view="library" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("core offline");
    expect(screen.queryByTestId("dialog-host")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(await screen.findByTestId("activity-screen")).toHaveAttribute("data-activity", "library");
    expect(bridgeMocks.initialize).toHaveBeenCalledTimes(2);
  });

  it("maps in-screen activity changes to shell views", async () => {
    bridgeMocks.initialize.mockResolvedValue(browserSnapshot);
    const onNavigate = vi.fn();
    render(<WorkspaceSurface view="work" onNavigate={onNavigate} />);
    await screen.findByTestId("activity-screen");

    act(() => useWorkspaceStore.getState().setActivity("projects"));
    act(() => useWorkspaceStore.getState().setActivity("chats"));
    act(() => useWorkspaceStore.getState().setActivity("home"));
    act(() => useWorkspaceStore.getState().setActivity("settings"));
    act(() => useWorkspaceStore.getState().setActivity("memory"));
    act(() => useWorkspaceStore.getState().setActivity("skills"));

    expect(onNavigate.mock.calls.map((call) => call[0])).toEqual([
      "projects",
      "agent",
      "agent",
      "library",
      "library",
    ]);
  });

  it("hosts Library, Memory and Skills as tabs and remembers the last tab in memory", async () => {
    bridgeMocks.initialize.mockResolvedValue(browserSnapshot);
    const onNavigate = vi.fn();
    const { rerender } = render(<WorkspaceSurface view="library" onNavigate={onNavigate} />);
    await screen.findByTestId("activity-screen");

    const tablist = screen.getByRole("tablist");
    const tabs = screen.getAllByRole("tab") as [HTMLElement, HTMLElement, HTMLElement];
    expect(tablist).toBeInTheDocument();
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Library", "Memory", "Skills"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("activity-screen")).toHaveAttribute("data-activity", "library");

    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(screen.getByTestId("activity-screen")).toHaveAttribute("data-activity", "memory");
    expect(useWorkspaceStore.getState().activeActivity).toBe("memory");
    expect(tabs[1]).toHaveFocus();

    fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
    expect(screen.getByTestId("activity-screen")).toHaveAttribute("data-activity", "skills");
    fireEvent.keyDown(tabs[2], { key: "ArrowRight" });
    expect(screen.getByTestId("activity-screen")).toHaveAttribute("data-activity", "library");
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(screen.getByTestId("activity-screen")).toHaveAttribute("data-activity", "skills");

    // Switching tabs never navigates the shell away from Library.
    expect(onNavigate).not.toHaveBeenCalled();

    rerender(<WorkspaceSurface view="work" onNavigate={onNavigate} />);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    rerender(<WorkspaceSurface view="library" onNavigate={onNavigate} />);
    expect(screen.getByTestId("activity-screen")).toHaveAttribute("data-activity", "skills");
    expect(useWorkspaceStore.getState().activeActivity).toBe("skills");
  });

  it("opens the matching Library tab when a screen links to memory", async () => {
    bridgeMocks.initialize.mockResolvedValue(browserSnapshot);
    const onNavigate = vi.fn();
    const { rerender } = render(<WorkspaceSurface view="projects" onNavigate={onNavigate} />);
    await screen.findByTestId("activity-screen");

    act(() => useWorkspaceStore.getState().setActivity("memory"));
    expect(onNavigate).toHaveBeenCalledWith("library");

    rerender(<WorkspaceSurface view="library" onNavigate={onNavigate} />);
    expect(screen.getByTestId("activity-screen")).toHaveAttribute("data-activity", "memory");
    expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute("aria-selected", "true");
  });

  it("does not install global Alt+digit shortcuts", async () => {
    bridgeMocks.initialize.mockResolvedValue(browserSnapshot);
    render(<WorkspaceSurface view="projects" />);
    await screen.findByTestId("activity-screen");

    fireEvent.keyDown(window, { key: "3", altKey: true });

    expect(useWorkspaceStore.getState().activeActivity).toBe("projects");
  });
});
