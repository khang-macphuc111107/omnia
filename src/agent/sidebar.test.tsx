import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readPrefs } from "./prefs";
import { Sidebar } from "./sidebar";
import type { AgentSessionListItem } from "./types";

const NOW = Date.now();
const PREFS_KEY = "omnia.agent.prefs.v1";

function make(id: string, title: string, cwd: string, updatedAtMs = NOW): AgentSessionListItem {
  return {
    id, title, cwd, profileId: "p", model: "m", permissionMode: "default" as never,
    messageCount: 1, createdAtMs: updatedAtMs, updatedAtMs, running: false,
  };
}

const sessions = [
  make("a", "Fix login bug", "C:\\work\\alpha"),
  make("b", "Write docs", "C:\\work\\beta"),
  make("c", "Refactor router", "C:\\work\\alpha", NOW - 3 * 86_400_000),
];

function setup(list = sessions, activeId: string | null = null, awaitingIds: string[] = []) {
  const props = {
    sessions: list, activeId, awaitingIds, onNew: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onFork: vi.fn(),
    onDelete: vi.fn(), onUpdates: vi.fn(), onCollapse: vi.fn(),
  };
  return { props, ...render(<Sidebar {...props} />) };
}

function seedLastSeen() {
  window.localStorage.setItem(
    PREFS_KEY,
    JSON.stringify({ recentFolders: [], lastSeen: { a: NOW - 1000, b: NOW, c: NOW - 3 * 86_400_000 } }),
  );
}

// The test runtime may not provide a working localStorage; install an in-memory one.
beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
});
afterEach(cleanup);

describe("Sidebar", () => {
  it("groups by project and day bucket", () => {
    setup();
    const alpha = screen.getByRole("region", { name: "alpha" });
    expect(screen.getByRole("region", { name: "beta" })).toBeTruthy();
    expect(screen.getAllByText("Today", { selector: "h3" })).toHaveLength(2);
    expect(screen.getByText("Earlier", { selector: "h3" })).toBeTruthy();
    expect(alpha.querySelector("h2")?.getAttribute("title")).toBe("C:\\work\\alpha");
  });

  it("filters by title and folder, Esc clears", () => {
    setup();
    const box = screen.getByLabelText("Search sessions") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "DOCS" } });
    expect(screen.queryByText("Fix login bug")).toBeNull();
    expect(screen.getByText("Write docs")).toBeTruthy();
    fireEvent.change(box, { target: { value: "alpha" } });
    expect(screen.getByText("Fix login bug")).toBeTruthy();
    expect(screen.queryByText("Write docs")).toBeNull();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box.value).toBe("");
    expect(screen.getByText("Write docs")).toBeTruthy();
  });

  it("pins to the top and persists", () => {
    const { unmount } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Pin Write docs" }));
    expect(screen.getByRole("region", { name: "Pinned" }).textContent).toContain("Write docs");
    expect(readPrefs().pinnedSessions).toEqual(["b"]);
    unmount();
    setup();
    expect(screen.getByRole("region", { name: "Pinned" }).textContent).toContain("Write docs");
    fireEvent.click(screen.getByRole("button", { name: "Unpin Write docs" }));
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
  });

  it("collapses a project and persists it", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Collapse beta" }));
    expect(screen.queryByText("Write docs")).toBeNull();
    expect(readPrefs().collapsedProjects).toEqual(["C:\\work\\beta"]);
  });

  it("shows an unread dot when updated after last seen", () => {
    seedLastSeen();
    setup();
    expect(screen.getAllByRole("img", { name: "Unread" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^Fix login bug/ }).querySelector(".ag-unread")).not.toBeNull();
  });

  it("does not flag the active session as unread", () => {
    seedLastSeen();
    setup(sessions, "a");
    expect(screen.queryByRole("img", { name: "Unread" })).toBeNull();
  });
  it("keeps long titles truncated with a full-title tooltip and opens a clamped, fixed actions menu", () => {
    const long = "Một tiêu đề rất dài ".repeat(12) + "x".repeat(80);
    setup([make("l", long, "C:\work\\" + "very-long-folder-name-".repeat(6))]);
    expect(screen.getByText(long).getAttribute("title")).toBe(long);
    fireEvent.click(screen.getByRole("button", { name: `Actions for ${long}` }));
    const panel = screen.getByRole("menu", { name: `Actions for ${long}` });
    expect(panel.className).toContain("ag-session__panel");
    expect(panel.style.visibility).not.toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: `Actions for ${long}` })).toBeNull();
  });

  it("enters the actions menu with ArrowDown and restores the trigger on Escape", () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Actions for Fix login bug" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "Actions for Fix login bug" });
    expect(trigger).toHaveAttribute("aria-controls", menu.id);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("aria-controls");
  });

  it("opens at the last action with ArrowUp and wraps past disabled items", () => {
    const { props, rerender } = setup(sessions, "a");
    rerender(<Sidebar {...props} onOpenInSplit={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Actions for Fix login bug" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const menu = screen.getByRole("menu", { name: "Actions for Fix login bug" });
    const rename = within(menu).getByRole("menuitem", { name: "Rename" });
    const fork = within(menu).getByRole("menuitem", { name: "Fork" });
    const remove = within(menu).getByRole("menuitem", { name: "Delete" });
    expect(within(menu).getByRole("menuitem", { name: "Open in split" })).toBeDisabled();
    expect(remove).toHaveFocus();
    fireEvent.keyDown(remove, { key: "ArrowDown" });
    expect(rename).toHaveFocus();
    fireEvent.keyDown(rename, { key: "ArrowDown" });
    expect(fork).toHaveFocus();
    fireEvent.keyDown(fork, { key: "Home" });
    expect(rename).toHaveFocus();
    fireEvent.keyDown(rename, { key: "ArrowUp" });
    expect(remove).toHaveFocus();
    fireEvent.keyDown(remove, { key: "End" });
    expect(remove).toHaveFocus();
    expect(within(menu).getAllByRole("menuitem").every((item) => item.tabIndex === -1)).toBe(true);
  });

  it("dismisses when focus leaves or an outside control is pressed without stealing focus", () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Actions for Fix login bug" });
    const search = screen.getByRole("searchbox", { name: "Search sessions" });
    fireEvent.click(trigger);
    act(() => search.focus());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(search).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.pointerDown(search);
    act(() => search.focus());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(search).toHaveFocus();
  });

  it("keeps menu scrolling local and dismisses stale positions on anchor scroll or resize", () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Actions for Fix login bug" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Actions for Fix login bug" });
    fireEvent.scroll(menu);
    expect(menu).toBeInTheDocument();
    fireEvent.scroll(screen.getByRole("navigation", { name: "Session list" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).not.toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.resize(window);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).not.toHaveFocus();
  });

  it.each([false, true])("closes on Tab (shift=$0) from the trigger's normal tab order", (shiftKey) => {
    setup();
    const trigger = screen.getByRole("button", { name: "Actions for Fix login bug" });
    fireEvent.click(trigger);
    const rename = screen.getByRole("menuitem", { name: "Rename" });
    fireEvent.keyDown(rename, { key: "Tab", shiftKey });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("hands focus to Rename and retains real Fork and delete-confirmation actions", () => {
    const { props } = setup();
    const trigger = screen.getByRole("button", { name: "Actions for Fix login bug" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const title = screen.getByRole("textbox", { name: "Session title" });
    expect(title).toHaveFocus();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.change(title, { target: { value: "New title" } });
    fireEvent.keyDown(title, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith("a", "New title");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork" }));
    expect(props.onFork).toHaveBeenCalledWith("a");
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: "Delete session?" })).toBeInTheDocument();
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(trigger).toHaveFocus();
  });

  it("leaves composition and already-handled Escape events to their owning control", () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Actions for Fix login bug" });
    fireEvent.keyDown(trigger, { key: "ArrowDown", isComposing: true });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger);
    const rename = screen.getByRole("menuitem", { name: "Rename" });
    fireEvent.keyDown(rename, { key: "Escape", isComposing: true });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    escape.preventDefault();
    fireEvent(rename, escape);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("has a single New chat button and search at the top, and no Settings entry", () => {
    const { props } = setup();
    const newChat = screen.getAllByRole("button", { name: /new (chat|session)/i });
    expect(newChat).toHaveLength(1);
    expect(newChat[0]).toHaveTextContent("New chat");
    fireEvent.click(newChat[0]!);
    expect(props.onNew).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Search sessions")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /settings/i })).toBeNull();
    // The footer only hosts the update badge, which renders nothing without an update.
    expect(document.querySelector(".ag-sidebar__foot")?.childElementCount).toBe(0);
  });

  it("marks sessions awaiting approval instead of running/unread", () => {
    setup([{ ...make("a", "Fix login bug", "C:\work\alpha"), running: true }, make("b", "Write docs", "C:\work\beta")], null, ["a"]);
    expect(screen.getByRole("img", { name: "Awaiting approval" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Running" })).toBeNull();
  });
});
