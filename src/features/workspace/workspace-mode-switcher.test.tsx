import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MODE_ORDER, setWorkspaceSurface, WORKSPACE_MODES, WorkspaceModeSwitcher } from "./workspace-mode-switcher";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("WorkspaceModeSwitcher", () => {
  afterEach(() => {
    setWorkspaceSurface("chat");
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
    delete document.documentElement.dataset.workspaceSurface;
  });

  it("exposes only the three requested Chat, IDE, and Browser modes", () => {
    useWorkspaceStore.setState({ activeActivity: "chats" });
    render(<WorkspaceModeSwitcher />);

    expect(WORKSPACE_MODES).toEqual([
      { id: "chats", label: "Chat", modeAttr: "chat", shortcut: "Ctrl+1" },
      { id: "ide-remote", label: "IDE", modeAttr: "code", shortcut: "Ctrl+2" },
      { id: "browser", label: "Browser", modeAttr: "browser", shortcut: "Ctrl+3" },
    ]);
    expect(MODE_ORDER).toEqual(["chat", "code", "browser"]);
    expect(screen.getByRole("group", { name: "Primary workspace mode" })).toBe(screen.getByTestId("workspace-mode-switcher"));
    expect(screen.getByTestId("workspace-mode-tab-chat")).toHaveAccessibleName("Chat");
    expect(screen.getByTestId("workspace-mode-tab-code")).toHaveAccessibleName("IDE");
    expect(screen.getByTestId("workspace-mode-tab-browser")).toHaveAccessibleName("Browser");
    for (const svg of screen.getByTestId("workspace-mode-switcher").querySelectorAll("svg")) {
      expect(svg).toHaveAttribute("width", "14");
      expect(svg).toHaveAttribute("height", "14");
      expect(svg).toHaveAttribute("aria-hidden", "true");
    }
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "IDE" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Browser" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(document.querySelectorAll(".workspace-mode-switcher__count")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Project" })).not.toBeInTheDocument();
  });

  it("routes the Chat mode back to chats, including from the Projects activity", () => {
    useWorkspaceStore.setState({ activeActivity: "projects" });
    render(<WorkspaceModeSwitcher />);

    const chatButton = screen.getByRole("button", { name: "Chat" });
    expect(chatButton).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(chatButton);
    expect(useWorkspaceStore.getState().activeActivity).toBe("chats");
  });

  it("activates the advertised Ctrl+1, Ctrl+2, and Ctrl+3 shortcuts", () => {
    useWorkspaceStore.setState({ activeActivity: "projects" });
    render(<WorkspaceModeSwitcher />);

    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(document.documentElement.dataset.workspaceSurface).toBe("code");
    expect(screen.getByRole("button", { name: "IDE" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "3", ctrlKey: true });
    expect(document.documentElement.dataset.workspaceSurface).toBe("browser");
    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    expect(document.documentElement.dataset.workspaceSurface).toBe("chat");
    expect(useWorkspaceStore.getState().activeActivity).toBe("chats");
  });

  it("leaves editable controls and dialogs in control of their keyboard input", () => {
    useWorkspaceStore.setState({ activeActivity: "chats" });
    render(<><WorkspaceModeSwitcher /><input aria-label="Draft input" /><div role="dialog"><button type="button">Dialog action</button></div></>);

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Draft input" }), { key: "2", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("button", { name: "Dialog action" }), { key: "3", ctrlKey: true });
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
  });

  it("supports roving arrow-key navigation across exactly three modes", () => {
    useWorkspaceStore.setState({ activeActivity: "chats" });
    render(<WorkspaceModeSwitcher />);

    const chatButton = screen.getByRole("button", { name: "Chat" });
    const ideButton = screen.getByRole("button", { name: "IDE" });
    const browserButton = screen.getByRole("button", { name: "Browser" });

    chatButton.focus();
    fireEvent.keyDown(screen.getByRole("group", { name: "Primary workspace mode" }), { key: "ArrowRight" });
    expect(document.documentElement.dataset.workspaceSurface).toBe("code");
    expect(ideButton).toHaveAttribute("aria-pressed", "true");
    expect(ideButton).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("group", { name: "Primary workspace mode" }), { key: "ArrowRight" });
    expect(document.documentElement.dataset.workspaceSurface).toBe("browser");
    expect(browserButton).toHaveAttribute("aria-pressed", "true");
    expect(browserButton).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("group", { name: "Primary workspace mode" }), { key: "End" });
    expect(browserButton).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("group", { name: "Primary workspace mode" }), { key: "Home" });
    expect(useWorkspaceStore.getState().activeActivity).toBe("chats");
    expect(chatButton).toHaveAttribute("aria-pressed", "true");
    expect(chatButton).toHaveFocus();
  });

  it("exposes IDE and Browser as full-bleed modes and resets on activity navigation", () => {
    useWorkspaceStore.setState({ activeActivity: "chats" });
    const changes: string[] = [];
    const handleSurfaceChange = (event: Event) => {
      changes.push((event as CustomEvent<string>).detail);
    };
    window.addEventListener("omnia:workspace-mode-change", handleSurfaceChange);

    render(<WorkspaceModeSwitcher />);

    const ideButton = screen.getByRole("button", { name: "IDE" });
    const browserButton = screen.getByRole("button", { name: "Browser" });
    expect(ideButton).toHaveAttribute("data-mode", "code");
    expect(ideButton).toHaveAttribute("title", "IDE workspace · Ctrl+2");
    expect(ideButton).toHaveAttribute("aria-keyshortcuts", "Control+2");
    expect(browserButton).toHaveAttribute("data-mode", "browser");
    expect(browserButton).toHaveAttribute("title", "Browser workspace · Ctrl+3");

    fireEvent.click(ideButton);
    expect(document.documentElement.dataset.workspaceSurface).toBe("code");
    expect(ideButton).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(browserButton);
    expect(document.documentElement.dataset.workspaceSurface).toBe("browser");
    expect(browserButton).toHaveAttribute("aria-pressed", "true");

    useWorkspaceStore.setState({ activeActivity: "projects" });
    expect(document.documentElement.dataset.workspaceSurface).toBe("chat");
    expect(changes).toEqual(["code", "browser", "chat"]);

    useWorkspaceStore.setState({ activeActivity: "library" });
    expect(document.documentElement.dataset.workspaceSurface).toBe("chat");
    expect(changes).toEqual(["code", "browser", "chat"]);

    window.removeEventListener("omnia:workspace-mode-change", handleSurfaceChange);
  });
});
