import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PanelScrim } from "@/components/panel-scrim";

import { ContextInspectorPanel } from "./inspector";
import { ObjectSidebar } from "./sidebar";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();
const originalMatchMedia = window.matchMedia;

function setNarrowViewport(width: number) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string): MediaQueryList => {
      const minimum = Number(query.match(/min-width:\s*(\d+)px/)?.[1] ?? 0);
      const maximum = Number(query.match(/max-width:\s*(\d+)px/)?.[1] ?? Number.POSITIVE_INFINITY);
      return {
        matches: width >= minimum && width <= maximum,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

afterEach(() => {
  useWorkspaceStore.setState(initialState, true);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: originalMatchMedia,
  });
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("temporary shell drawer contract", () => {
  it("moves focus into the sidebar, wraps Tab, closes on Escape, and restores focus", () => {
    setNarrowViewport(800);
    useWorkspaceStore.setState({ sidebarOpen: true, inspectorOpen: false });
    const opener = document.createElement("button");
    opener.id = "sidebar-toggle";
    document.body.append(opener);
    opener.focus();

    render(<ObjectSidebar />);

    const drawer = screen.getByRole("dialog", { name: "Chats sidebar" });
    const close = screen.getByRole("button", { name: "Close sidebar" });
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(close).toHaveFocus();

    const last = screen.getByRole("button", { name: "Show archived Chats" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(close).toHaveFocus();

    fireEvent.keyDown(close, { key: "Escape" });
    expect(useWorkspaceStore.getState().sidebarOpen).toBe(false);
    expect(opener).toHaveFocus();
  });

  it("presents the inspector as a modal drawer only at the narrow breakpoint", () => {
    setNarrowViewport(800);
    useWorkspaceStore.setState({ inspectorOpen: true, inspectorTab: "context" });

    render(<ContextInspectorPanel />);

    const drawer = screen.getByRole("dialog", { name: "Context and run inspector" });
    expect(drawer).toHaveAttribute("id", "context-inspector");
    expect(drawer).toHaveAttribute("aria-modal", "true");
  });

  it("dismisses the active drawer through the pointer scrim", () => {
    const onClose = vi.fn();
    render(<PanelScrim open onClose={onClose} />);

    fireEvent.pointerDown(document.querySelector('[data-panel-scrim="true"]')!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes temporary panels after navigating to an object or activity", () => {
    setNarrowViewport(800);
    useWorkspaceStore.setState({ sidebarOpen: true, inspectorOpen: false });

    useWorkspaceStore.getState().selectConversation(initialState.activeConversationId);
    expect(useWorkspaceStore.getState()).toMatchObject({ sidebarOpen: false, inspectorOpen: false });

    useWorkspaceStore.setState({ sidebarOpen: true, inspectorOpen: false });
    useWorkspaceStore.getState().setActivity("projects");
    expect(useWorkspaceStore.getState()).toMatchObject({
      activeActivity: "projects",
      sidebarOpen: false,
      inspectorOpen: false,
    });
  });

  it("preserves one intentional narrow drawer while resolving an impossible dual-panel state", () => {
    setNarrowViewport(898);
    useWorkspaceStore.setState({ sidebarOpen: true, inspectorOpen: false });

    useWorkspaceStore.getState().reconcileNarrowPanels();
    expect(useWorkspaceStore.getState()).toMatchObject({
      sidebarOpen: true,
      inspectorOpen: false,
    });

    useWorkspaceStore.setState({ sidebarOpen: true, inspectorOpen: true, activeActivity: "chats" });
    useWorkspaceStore.getState().reconcileNarrowPanels();
    expect(useWorkspaceStore.getState()).toMatchObject({
      sidebarOpen: false,
      inspectorOpen: true,
    });
  });

  it("keeps docked panels non-modal above the drawer breakpoint", () => {
    setNarrowViewport(1024);
    useWorkspaceStore.setState({ sidebarOpen: true, inspectorOpen: false });

    render(<ObjectSidebar />);

    expect(screen.getByRole("complementary", { name: "Chats sidebar" })).not.toHaveAttribute(
      "aria-modal",
    );
  });
});
