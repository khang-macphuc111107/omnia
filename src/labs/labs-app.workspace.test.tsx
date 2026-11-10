import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceStore } from "@/features/workspace/store";
import { setWorkspaceSurface } from "@/features/workspace/workspace-mode-switcher";
import type { AppRuntimeInfo } from "@/lib/desktop";

import { Workspace } from "./labs-app";

// Exercise the application composition boundary independently from the large
// workbench implementation suites. These sentinels distinguish an unmounted
// Chat shell from chrome that was merely hidden with CSS.
vi.mock("@/features/workspace/title-bar", () => ({
  TitleBar: () => <header data-testid="chat-title-bar" />,
}));
vi.mock("@/features/workspace/activity-rail", () => ({
  ActivityRail: () => <nav data-testid="chat-activity-rail" />,
}));
vi.mock("@/features/workspace/sidebar", () => ({
  ObjectSidebar: () => <aside data-testid="chat-object-sidebar" />,
}));
vi.mock("@/features/workspace/context-inspector-host", () => ({
  ContextInspectorHost: () => <aside data-testid="chat-context-inspector" />,
}));
vi.mock("@/components/panel-scrim", () => ({
  PanelScrim: () => <div data-testid="chat-panel-scrim" />,
}));
vi.mock("@/features/workspace/conversation-view", () => ({
  ConversationView: () => <section data-testid="chat-conversation" />,
}));
vi.mock("@/features/workspace/activity-screen-host", () => ({
  ActivityScreenHost: () => <section data-testid="activity-screen" />,
}));
vi.mock("@/features/workspace/sovereign-ide-remote-workbench", () => ({
  default: () => <section data-testid="full-window-ide" />,
}));
vi.mock("@/features/workspace/sovereign-browser-workbench", () => ({
  default: () => <section data-testid="full-window-browser" />,
}));
vi.mock("@/features/workspace/command-palette-host", () => ({
  CommandPaletteHost: () => {
    const open = useWorkspaceStore((state) => state.commandPaletteOpen);
    return <div data-testid="global-command-host" data-open={open} />;
  },
}));
vi.mock("@/features/workspace/global-dialogs-host", () => ({
  GlobalDialogsHost: () => <div data-testid="global-dialog-host" />,
}));

const initialState = useWorkspaceStore.getState();
const runtime: AppRuntimeInfo = {
  appName: "Omnia",
  appVersion: "0.1.0",
  platform: "web",
  tauri: false,
  debug: true,
};

describe("Workspace full-window surfaces", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      activeActivity: "chats",
      sidebarOpen: true,
      inspectorOpen: true,
      commandPaletteOpen: false,
    });
    setWorkspaceSurface("chat");
  });

  afterEach(() => {
    act(() => {
      setWorkspaceSurface("chat");
      useWorkspaceStore.setState(initialState, true);
    });
  });

  it.each([
    ["code", "Embedded VS Code workspace", "full-window-ide"],
    ["browser", "Sovereign Browser workspace", "full-window-browser"],
  ] as const)("unmounts all Chat chrome in %s while retaining global hosts and Ctrl+K", async (surface, label, testId) => {
    setWorkspaceSurface(surface);
    const { container } = render(<Workspace runtime={runtime} />);

    expect(await screen.findByTestId(testId)).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("app-shell--full-window-surface");
    expect(screen.getByRole("main", { name: label })).toHaveClass("primary-workspace--full-bleed");
    expect(screen.queryByTestId("chat-title-bar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-activity-rail")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-object-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-context-inspector")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-panel-scrim")).not.toBeInTheDocument();
    expect(container.querySelector(".global-status-strip")).not.toBeInTheDocument();
    expect(screen.getByTestId("global-dialog-host")).toBeInTheDocument();
    expect(screen.getByTestId("global-command-host")).toHaveAttribute("data-open", "false");

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(screen.getByTestId("global-command-host")).toHaveAttribute("data-open", "true");
  });

  it("restores the ordinary Chat layout without remounting global overlay hosts", async () => {
    const { container } = render(<Workspace runtime={runtime} />);
    const commandHost = screen.getByTestId("global-command-host");
    const dialogHost = screen.getByTestId("global-dialog-host");

    act(() => setWorkspaceSurface("code"));
    expect(await screen.findByTestId("full-window-ide")).toBeInTheDocument();
    act(() => setWorkspaceSurface("browser"));
    expect(await screen.findByTestId("full-window-browser")).toBeInTheDocument();
    act(() => setWorkspaceSurface("chat"));

    expect(container.firstElementChild).not.toHaveClass("app-shell--full-window-surface");
    expect(screen.getByRole("main", { name: "Conversation" })).not.toHaveClass("primary-workspace--full-bleed");
    expect(screen.getByTestId("chat-title-bar")).toBeInTheDocument();
    expect(screen.getByTestId("chat-activity-rail")).toBeInTheDocument();
    expect(screen.getByTestId("chat-object-sidebar")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-context-inspector")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-conversation")).toBeInTheDocument();
    expect(container.querySelector(".global-status-strip")).not.toBeInTheDocument();
    expect(screen.getByTestId("global-command-host")).toBe(commandHost);
    expect(screen.getByTestId("global-dialog-host")).toBe(dialogHost);
  });

  it.each([false, true])("never mounts a Chat inspector or backend status chrome with saved inspectorOpen=%s", (inspectorOpen) => {
    useWorkspaceStore.setState({ inspectorOpen });
    const { container } = render(<Workspace runtime={runtime} />);

    expect(container.firstElementChild).toHaveClass("app-shell--sidebar", "app-shell--no-inspector");
    expect(container.firstElementChild).not.toHaveClass("app-shell--inspector");
    expect(screen.getByTestId("chat-activity-rail")).toBeInTheDocument();
    expect(screen.getByTestId("chat-object-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("chat-conversation")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-context-inspector")).not.toBeInTheDocument();
    expect(container.querySelector(".global-status-strip")).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/Provider Preview|Mock data|Unsigned internal|Local Cache Proxy/);

    fireEvent.keyDown(window, { key: "I", ctrlKey: true, shiftKey: true });
    expect(screen.queryByTestId("chat-context-inspector")).not.toBeInTheDocument();
  });
});
