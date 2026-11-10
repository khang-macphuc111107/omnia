import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "./store";
import SovereignBrowserWorkbench, {
  SovereignBrowserWorkbench as NamedSovereignBrowserWorkbench,
} from "./sovereign-browser-workbench";

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

function sendPageShortcut(
  frame: HTMLIFrameElement,
  keyboard: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  source: MessageEventSource | null = frame.contentWindow,
) {
  fireEvent(window, new MessageEvent("message", {
    source,
    data: {
      channel: "omnia:browser-context", type: "shortcut", url: "https://news.ycombinator.com",
      keyboard: { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...keyboard },
      ...extra,
    },
  }));
}

describe("SovereignBrowserWorkbench", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "sessionStorage", {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it("exports both named SovereignBrowserWorkbench and default component", () => {
    expect(NamedSovereignBrowserWorkbench).toBeDefined();
    expect(SovereignBrowserWorkbench).toBe(NamedSovereignBrowserWorkbench);
  });

  it("restores the selected tab and AI sidebar layout after leaving and remounting the browser", () => {
    const firstMount = render(<SovereignBrowserWorkbench />);
    const tabs = within(screen.getByRole("tablist", { name: "Browser tabs" })).getAllByRole("tab");
    fireEvent.click(tabs[1]!);
    const selectedTabId = tabs[1]!.id;
    const selectedUrl = (screen.getByTestId("omnibox-input") as HTMLInputElement).value;
    fireEvent.click(screen.getByTestId("browser-copilot-toggle-btn"));
    const resizer = screen.getByRole("separator", { name: "Resize Browser AI Sidebar" });
    fireEvent.keyDown(resizer, { key: "End" });
    fireEvent.keyDown(resizer, { key: "ArrowRight" });
    expect(resizer).toHaveAttribute("aria-valuenow", "620");
    firstMount.unmount();

    const secondMount = render(<SovereignBrowserWorkbench />);
    expect(screen.getByRole("tab", { selected: true })).toHaveAttribute("id", selectedTabId);
    expect(screen.getByTestId("omnibox-input")).toHaveValue(selectedUrl);
    expect(screen.getByTestId("browser-copilot-toggle-btn")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("separator", { name: "Resize Browser AI Sidebar" })).toHaveAttribute("aria-valuenow", "620");
    expect(screen.getByTestId("sovereign-browser-workbench").style.getPropertyValue("--browser-ai-sidebar-width")).toBe("620px");

    fireEvent.click(screen.getByRole("button", { name: "Close AI side panel" }));
    secondMount.unmount();
    render(<SovereignBrowserWorkbench />);
    expect(screen.getByRole("tab", { selected: true })).toHaveAttribute("id", selectedTabId);
    expect(screen.queryByTestId("browser-ai-copilot-sidebar")).not.toBeInTheDocument();
    expect(screen.getByTestId("browser-copilot-toggle-btn")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTestId("browser-copilot-toggle-btn"));
    expect(screen.getByRole("separator", { name: "Resize Browser AI Sidebar" })).toHaveAttribute("aria-valuenow", "620");
  }, 20000);

  it("loads existing v1 browser data that predates persisted selection and sidebar layout", () => {
    const firstMount = render(<SovereignBrowserWorkbench />);
    const persisted = JSON.parse(window.localStorage.getItem("omnia.sovereign.browser.v1")!) as Record<string, unknown>;
    firstMount.unmount();
    delete persisted.activeTabId;
    delete persisted.copilotSidebarOpen;
    delete persisted.copilotSidebarWidth;
    window.localStorage.setItem("omnia.sovereign.browser.v1", JSON.stringify(persisted));

    render(<SovereignBrowserWorkbench />);
    const tabs = within(screen.getByRole("tablist", { name: "Browser tabs" })).getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("browser-ai-copilot-sidebar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("browser-copilot-toggle-btn"));
    expect(screen.getByRole("separator", { name: "Resize Browser AI Sidebar" })).toHaveAttribute("aria-valuenow", "340");
    const saved = JSON.parse(window.localStorage.getItem("omnia.sovereign.browser.v1")!) as Record<string, unknown>;
    expect(saved.tabs).toEqual(persisted.tabs);
    expect(saved.bookmarks).toEqual(persisted.bookmarks);
    expect(saved.userscripts).toEqual(persisted.userscripts);
    expect(saved.permissionPolicy).toEqual(persisted.permissionPolicy);
  });

  it("preserves deliberately empty bookmarks and userscripts after remount", () => {
    const firstMount = render(<SovereignBrowserWorkbench />);
    const persisted = JSON.parse(window.localStorage.getItem("omnia.sovereign.browser.v1")!) as Record<string, unknown>;
    firstMount.unmount();
    window.localStorage.setItem("omnia.sovereign.browser.v1", JSON.stringify({
      ...persisted,
      bookmarks: [],
      userscripts: [],
    }));

    render(<SovereignBrowserWorkbench />);
    expect(screen.queryByTestId("bookmark-item-bm-stream-vault")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bookmark-item-bm-github")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("toggle-devtools-btn"));
    fireEvent.click(screen.getByTestId("devtools-tab-userscripts"));
    expect(screen.getByTestId("devtools-panel-userscripts")).toHaveTextContent("Tampermonkey Userscripts (0)");

    const saved = JSON.parse(window.localStorage.getItem("omnia.sovereign.browser.v1")!) as Record<string, unknown>;
    expect(saved.bookmarks).toEqual([]);
    expect(saved.userscripts).toEqual([]);
  });

  it("filters malformed persisted bookmark and userscript entries without restoring defaults", () => {
    const firstMount = render(<SovereignBrowserWorkbench />);
    const persisted = JSON.parse(window.localStorage.getItem("omnia.sovereign.browser.v1")!) as Record<string, unknown>;
    firstMount.unmount();
    window.localStorage.setItem("omnia.sovereign.browser.v1", JSON.stringify({
      ...persisted,
      bookmarks: [
        { id: "valid-bookmark", title: "Saved", url: "https://example.com", category: "Saved" },
        { id: "broken-bookmark", title: "Missing URL", category: "Saved" },
      ],
      userscripts: [
        { id: "valid-script", name: "Saved script", matchPattern: "*://*/*", runAt: "document-idle", enabled: true, description: "Saved", code: "" },
        { id: "broken-script", name: "Broken", runAt: "document-idle", enabled: true },
      ],
    }));

    render(<SovereignBrowserWorkbench />);
    expect(screen.getByTestId("bookmark-item-valid-bookmark")).toBeInTheDocument();
    expect(screen.queryByTestId("bookmark-item-broken-bookmark")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("toggle-devtools-btn"));
    fireEvent.click(screen.getByTestId("devtools-tab-userscripts"));
    expect(screen.getByTestId("userscript-row-valid-script")).toBeInTheDocument();
    expect(screen.queryByTestId("userscript-row-broken-script")).not.toBeInTheDocument();
    expect(screen.getByTestId("devtools-panel-userscripts")).toHaveTextContent("Tampermonkey Userscripts (1)");
  });

  it("falls back to defaults when a non-empty persisted collection has no valid entries", () => {
    const firstMount = render(<SovereignBrowserWorkbench />);
    const persisted = JSON.parse(window.localStorage.getItem("omnia.sovereign.browser.v1")!) as Record<string, unknown>;
    firstMount.unmount();
    window.localStorage.setItem("omnia.sovereign.browser.v1", JSON.stringify({
      ...persisted,
      bookmarks: [{ id: 7, title: null }],
      userscripts: [{ id: "broken", runAt: "unknown" }],
    }));

    render(<SovereignBrowserWorkbench />);
    expect(screen.getByTestId("bookmark-item-bm-stream-vault")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("toggle-devtools-btn"));
    fireEvent.click(screen.getByTestId("devtools-tab-userscripts"));
    expect(screen.getByTestId("devtools-panel-userscripts")).toHaveTextContent("Tampermonkey Userscripts (3)");
  });

  it.each([
    { width: -100, expectedWidth: 260 },
    { width: 10000, expectedWidth: 640 },
    { width: 420.7, expectedWidth: 421 },
    { width: "420", expectedWidth: 340 },
    { width: null, expectedWidth: 340 },
  ])("validates a stale selected tab and persisted sidebar width $width", ({ width, expectedWidth }) => {
    const firstMount = render(<SovereignBrowserWorkbench />);
    const persisted = JSON.parse(window.localStorage.getItem("omnia.sovereign.browser.v1")!) as Record<string, unknown>;
    firstMount.unmount();
    window.localStorage.setItem("omnia.sovereign.browser.v1", JSON.stringify({
      ...persisted, activeTabId: "closed-tab", copilotSidebarOpen: true, copilotSidebarWidth: width,
    }));

    render(<SovereignBrowserWorkbench />);
    const tabs = within(screen.getByRole("tablist", { name: "Browser tabs" })).getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("separator", { name: "Resize Browser AI Sidebar" })).toHaveAttribute("aria-valuenow", String(expectedWidth));
  });

  it("ignores a malformed sidebar flag and non-finite width without losing valid saved tabs", () => {
    const firstMount = render(<SovereignBrowserWorkbench />);
    const persisted = JSON.parse(window.localStorage.getItem("omnia.sovereign.browser.v1")!) as Record<string, unknown>;
    const tabId = screen.getByRole("tab", { selected: true }).id;
    firstMount.unmount();
    const raw = JSON.stringify({ ...persisted, copilotSidebarOpen: "true", copilotSidebarWidth: "NON_FINITE" })
      .replace('"NON_FINITE"', "1e309");
    window.localStorage.setItem("omnia.sovereign.browser.v1", raw);

    render(<SovereignBrowserWorkbench />);
    expect(screen.getByRole("tab", { selected: true })).toHaveAttribute("id", tabId);
    expect(screen.queryByTestId("browser-ai-copilot-sidebar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("browser-copilot-toggle-btn"));
    expect(screen.getByRole("separator", { name: "Resize Browser AI Sidebar" })).toHaveAttribute("aria-valuenow", "340");
  });

  it("uses a single tab stop and wraps arrow, Home and End navigation through browser tabs", () => {
    render(<SovereignBrowserWorkbench />);
    const tabs = within(screen.getByRole("tablist", { name: "Browser tabs" })).getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs.slice(1).every((tab) => tab.tabIndex === -1)).toBe(true);
    expect(within(screen.getByRole("tablist", { name: "Browser tabs" })).getAllByRole("button")
      .every((button) => button.tabIndex === -1)).toBe(true);
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("tabindex", "-1");
    expect(screen.getByTestId("sovereign-browser-viewport")).toHaveAttribute("aria-labelledby", tabs[1]!.id);
    fireEvent.keyDown(tabs[1]!, { key: "End" });
    expect(tabs.at(-1)).toHaveFocus();
    fireEvent.keyDown(tabs.at(-1)!, { key: "ArrowRight" });
    expect(tabs[0]).toHaveFocus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
    expect(tabs.at(-1)).toHaveFocus();
    fireEvent.keyDown(tabs.at(-1)!, { key: "Home" });
    expect(tabs[0]).toHaveFocus();
  });

  it("closes to the adjacent tab and restores keyboard focus while retaining the final tab", () => {
    render(<SovereignBrowserWorkbench />);
    const tablist = screen.getByRole("tablist", { name: "Browser tabs" });
    const originalTabs = within(tablist).getAllByRole("tab");
    fireEvent.click(originalTabs[1]!);
    originalTabs[1]!.focus();
    fireEvent.keyDown(originalTabs[1]!, { key: "Delete" });
    expect(originalTabs[1]).not.toBeInTheDocument();
    expect(originalTabs[2]).toHaveAttribute("aria-selected", "true");
    expect(originalTabs[2]).toHaveFocus();
    fireEvent.keyDown(originalTabs[2]!, { key: "Delete" });
    expect(originalTabs[0]).toHaveFocus();
    expect(within(tablist).getAllByRole("tab")).toHaveLength(1);
    fireEvent.keyDown(originalTabs[0]!, { key: "Delete" });
    expect(originalTabs[0]).toHaveFocus();
    expect(within(tablist).getAllByRole("tab")).toHaveLength(1);
  });

  it("opens the tab action menu from ContextMenu and Shift+F10 with roving keyboard focus", () => {
    render(<SovereignBrowserWorkbench />);
    const tabs = within(screen.getByRole("tablist", { name: "Browser tabs" })).getAllByRole("tab");
    const target = tabs[1]!;
    fireEvent.click(target);
    target.focus();

    fireEvent.keyDown(target, { key: "ContextMenu" });
    const menu = screen.getByRole("menu", { name: "Tab actions" });
    const pin = within(menu).getByRole("menuitem", { name: /Pin \/ unpin tab/i });
    const duplicate = within(menu).getByRole("menuitem", { name: /Duplicate tab/i });
    const close = within(menu).getByRole("menuitem", { name: /Close menu/i });
    expect(pin).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(duplicate).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(pin).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Tab actions" })).not.toBeInTheDocument();
    expect(target).toHaveFocus();

    fireEvent.keyDown(target, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: /Pin \/ unpin tab/i })).toHaveFocus();
    fireEvent.click(screen.getByRole("menuitem", { name: /Pin \/ unpin tab/i }));
    expect(target).toHaveFocus();
    expect(target.querySelector("svg.lucide-pin")).toBeInTheDocument();

    fireEvent.contextMenu(target);
    expect(screen.getByRole("menuitem", { name: /Pin \/ unpin tab/i })).toHaveFocus();
    fireEvent.click(screen.getByRole("menuitem", { name: /Duplicate tab/i }));
    const selected = screen.getByRole("tab", { selected: true });
    expect(selected).not.toBe(target);
    expect(selected).toHaveFocus();

    fireEvent.contextMenu(selected);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "Tab actions" })).not.toBeInTheDocument();
  });

  it("does not close another tab when Ctrl+W autorepeat arrives after native focus transfer", () => {
    render(<SovereignBrowserWorkbench />);
    const initialTabs = within(screen.getByRole("tablist", { name: "Browser tabs" })).getAllByRole("tab");
    initialTabs[0]!.focus();
    fireEvent.keyDown(initialTabs[0]!, { key: "w", ctrlKey: true });
    expect(screen.getAllByRole("tab")).toHaveLength(initialTabs.length - 1);
    const focusedNeighbor = screen.getByRole("tab", { selected: true });
    expect(focusedNeighbor).toHaveFocus();

    // The native accelerator has already moved focus back to the main WebView;
    // this repeated DOM keydown must not close the next tab as well.
    fireEvent.keyDown(focusedNeighbor, { key: "w", ctrlKey: true, repeat: true });
    expect(screen.getAllByRole("tab")).toHaveLength(initialTabs.length - 1);
  });

  it("keeps the last tab focused when Ctrl+W is ignored", () => {
    render(<SovereignBrowserWorkbench />);
    const workbench = screen.getByTestId("sovereign-browser-workbench");
    for (const label of ["Close github.com/tauri-apps/tauri", "Close news.ycombinator.com"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
    }
    const lastTab = screen.getByRole("tab", { selected: true });
    lastTab.blur();
    expect(document.activeElement).not.toBe(lastTab);
    fireEvent.keyDown(workbench, { key: "w", ctrlKey: true });
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(document.body.contains(lastTab)).toBe(true);
    expect(lastTab).toHaveFocus();
  });

  it.each([
    { key: "l", ctrlKey: true },
    { key: "l", metaKey: true },
    { key: "d", altKey: true },
    { key: "F6" },
  ])("focuses and selects the address with $key and restores the current URL on Escape", (shortcut) => {
    render(<SovereignBrowserWorkbench />);
    const input = screen.getByTestId("omnibox-input") as HTMLInputElement;
    const originalUrl = input.value;
    fireEvent.keyDown(screen.getByTestId("sovereign-browser-workbench"), shortcut);
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    fireEvent.change(input, { target: { value: "unfinished address" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue(originalUrl);
  });

  it("creates distinct tabs with Ctrl+T, selects the address and closes the active tab with Ctrl+W", () => {
    render(<SovereignBrowserWorkbench />);
    const workbench = screen.getByTestId("sovereign-browser-workbench");
    const tablist = screen.getByRole("tablist", { name: "Browser tabs" });
    const originalCount = within(tablist).getAllByRole("tab").length;
    vi.spyOn(Date, "now").mockReturnValue(1000);
    fireEvent.keyDown(workbench, { key: "t", ctrlKey: true });
    const input = screen.getByTestId("omnibox-input") as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(input.selectionEnd).toBe(input.value.length);
    fireEvent.keyDown(input, { key: "t", ctrlKey: true });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs).toHaveLength(originalCount + 2);
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(tabs.length);
    fireEvent.keyDown(input, { key: "w", ctrlKey: true });
    expect(within(tablist).getAllByRole("tab")).toHaveLength(originalCount + 1);
    expect(tabs.at(-2)).toHaveAttribute("aria-selected", "true");
    expect(tabs.at(-2)).toHaveFocus();
  });

  it("cycles tabs with Ctrl+Tab/PageUp/PageDown", () => {
    render(<SovereignBrowserWorkbench />);
    const workbench = screen.getByTestId("sovereign-browser-workbench");
    const tabs = within(screen.getByRole("tablist", { name: "Browser tabs" })).getAllByRole("tab");
    fireEvent.keyDown(workbench, { key: "Tab", ctrlKey: true });
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tabs[1]!, { key: "Tab", ctrlKey: true, shiftKey: true });
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(workbench, { key: "PageUp", ctrlKey: true });
    expect(tabs.at(-1)).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(workbench, { key: "PageDown", ctrlKey: true });
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveFocus();
  });

  it("limits shortcuts to the browser and does not intercept composition or shifted tab movement", () => {
    render(<><input aria-label="Outside browser" /><SovereignBrowserWorkbench /></>);
    const workbench = screen.getByTestId("sovereign-browser-workbench");
    const tablist = screen.getByRole("tablist", { name: "Browser tabs" });
    const tabs = within(tablist).getAllByRole("tab");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Outside browser" }), { key: "t", ctrlKey: true });
    fireEvent.keyDown(workbench, { key: "t", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(workbench, { key: "PageDown", ctrlKey: true, shiftKey: true });
    expect(within(tablist).getAllByRole("tab")).toHaveLength(tabs.length);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("connects Alt+Left and Alt+Right to the active tab history", () => {
    render(<SovereignBrowserWorkbench />);
    const input = screen.getByTestId("omnibox-input") as HTMLInputElement;
    const originalUrl = input.value;
    fireEvent.change(input, { target: { value: "https://stream-vault.omnia.local/watch/second-page" } });
    fireEvent.submit(input.closest("form")!);
    expect(input).toHaveValue("https://stream-vault.omnia.local/watch/second-page");
    fireEvent.keyDown(input, { key: "ArrowLeft", altKey: true });
    expect(input).toHaveValue(originalUrl);
    fireEvent.keyDown(input, { key: "ArrowRight", altKey: true });
    expect(input).toHaveValue("https://stream-vault.omnia.local/watch/second-page");
  });

  it("reloads the live frame with Ctrl+R without reloading the surrounding workspace", () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36");
    try {
      render(<SovereignBrowserWorkbench />);
      const workbench = screen.getByTestId("sovereign-browser-workbench");
      const frame = screen.getByTestId("sovereign-live-iframe");
      const source = frame.getAttribute("src");
      fireEvent.keyDown(screen.getByTestId("omnibox-input"), { key: "r", ctrlKey: true });
      expect(screen.getByTestId("sovereign-browser-workbench")).toBe(workbench);
      expect(frame).not.toBeInTheDocument();
      expect(screen.getByTestId("sovereign-live-iframe")).toHaveAttribute("src", source);
    } finally {
      userAgent.mockRestore();
    }
  });

  it("preserves each live tab's browsing context across tab changes and reloads only the active tab", () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36");
    try {
      render(<SovereignBrowserWorkbench />);
      const firstFrame = screen.getByTestId("sovereign-live-iframe") as HTMLIFrameElement;
      const firstContext = firstFrame.contentWindow;
      const firstTab = within(screen.getByRole("tablist", { name: "Browser tabs" })).getAllByRole("tab")[0]!;
      fireEvent.click(screen.getByTestId("new-tab-btn"));
      const secondFrame = screen.getByTestId("sovereign-live-iframe");
      const secondTab = within(screen.getByRole("tablist", { name: "Browser tabs" })).getAllByRole("tab").at(-1)!;
      expect(firstFrame).toBeInTheDocument();
      expect(firstFrame.closest("[hidden]")).toHaveAttribute("inert");
      expect(firstFrame.closest("[hidden]")).toHaveAttribute("aria-hidden", "true");
      fireEvent.click(firstTab);
      expect(screen.getByTestId("sovereign-live-iframe")).toBe(firstFrame);
      expect(firstFrame.contentWindow).toBe(firstContext);
      expect(secondFrame).toBeInTheDocument();
      fireEvent.keyDown(screen.getByTestId("omnibox-input"), { key: "r", ctrlKey: true });
      expect(firstFrame).not.toBeInTheDocument();
      expect(secondFrame).toBeInTheDocument();
      fireEvent.click(secondTab);
      expect(screen.getByTestId("sovereign-live-iframe")).toBe(secondFrame);
      fireEvent.keyDown(secondTab, { key: "Delete" });
      expect(secondFrame).not.toBeInTheDocument();
    } finally {
      userAgent.mockRestore();
    }
  });

  it("keeps the live page mounted while DevTools is maximized", () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36");
    try {
      render(<SovereignBrowserWorkbench initialDevToolsOpen />);
      const page = screen.getByTestId("sovereign-live-iframe");
      fireEvent.click(screen.getByTestId("dock-pos-maximized"));
      expect(page).toBeInTheDocument();
      expect(screen.getByTestId("sovereign-browser-viewport")).toHaveAttribute("hidden");
      expect(screen.getByTestId("sovereign-browser-viewport")).toHaveAttribute("inert");
      fireEvent.click(screen.getByTestId("dock-pos-bottom"));
      expect(screen.getByTestId("sovereign-live-iframe")).toBe(page);
      expect(screen.getByTestId("sovereign-browser-viewport")).not.toHaveAttribute("hidden");
    } finally {
      userAgent.mockRestore();
    }
  });

  it("ignores page messages from a still-mounted inactive tab", () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36");
    try {
      render(<SovereignBrowserWorkbench />);
      const firstFrame = screen.getByTestId("sovereign-live-iframe") as HTMLIFrameElement;
      fireEvent.click(screen.getByTestId("new-tab-btn"));
      const secondFrame = screen.getByTestId("sovereign-live-iframe") as HTMLIFrameElement;
      const snapshot = { channel: "omnia:browser-context", type: "loaded", url: "https://news.ycombinator.com", title: "Inactive stale title", html: "<h1>Inactive page</h1>" };
      expect(firstFrame).toBeInTheDocument();
      fireEvent(window, new MessageEvent("message", { source: firstFrame.contentWindow, data: snapshot }));
      fireEvent(window, new MessageEvent("message", { source: firstFrame.contentWindow, data: { channel: "omnia:browser-context", type: "navigate", url: "https://example.com/stale" } }));
      expect(screen.queryByText("Inactive stale title")).not.toBeInTheDocument();
      expect(screen.getByTestId("omnibox-input")).toHaveValue("https://news.ycombinator.com");
      fireEvent(window, new MessageEvent("message", { source: secondFrame.contentWindow, data: { ...snapshot, title: "Current live title" } }));
      expect(screen.getByRole("tab", { name: "Current live title" })).toHaveAttribute("aria-selected", "true");
    } finally {
      userAgent.mockRestore();
    }
  });

  it("scopes DevTools and sidebar shortcuts to an active browser workbench", () => {
    const { rerender } = render(<><input aria-label="Unrelated input" /><SovereignBrowserWorkbench /></>);
    const workbench = screen.getByTestId("sovereign-browser-workbench");
    for (const target of [window, screen.getByRole("textbox", { name: "Unrelated input" })]) {
      fireEvent.keyDown(target, { key: "F12" });
      fireEvent.keyDown(target, { key: "b", ctrlKey: true, altKey: true });
      fireEvent.keyDown(target, { key: "m", ctrlKey: true, shiftKey: true });
      expect(screen.queryByTestId("sovereign-f12-devtools-dock")).not.toBeInTheDocument();
      expect(screen.queryByTestId("browser-copilot-prompt-input")).not.toBeInTheDocument();
      expect(screen.getByTestId("device-emulation-bar")).not.toHaveAttribute("open");
    }
    expect(screen.queryByTestId("sovereign-f12-devtools-dock")).not.toBeInTheDocument();
    expect(screen.queryByTestId("browser-copilot-prompt-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("device-emulation-bar")).not.toHaveAttribute("open");
    fireEvent.keyDown(workbench, { key: "F12", isComposing: true });
    const handled = new KeyboardEvent("keydown", { key: "F12", bubbles: true, cancelable: true });
    handled.preventDefault();
    fireEvent(workbench, handled);
    expect(screen.queryByTestId("sovereign-f12-devtools-dock")).not.toBeInTheDocument();
    fireEvent.keyDown(workbench, { key: "F12" });
    expect(screen.getByTestId("sovereign-f12-devtools-dock")).toBeInTheDocument();
    rerender(<div hidden><SovereignBrowserWorkbench /></div>);
    fireEvent.keyDown(screen.getByTestId("sovereign-browser-workbench"), { key: "F12" });
    expect(screen.queryByTestId("sovereign-f12-devtools-dock")).not.toBeInTheDocument();
    rerender(<div role="dialog"><SovereignBrowserWorkbench /></div>);
    fireEvent.keyDown(screen.getByTestId("sovereign-browser-workbench"), { key: "F12" });
    expect(screen.queryByTestId("sovereign-f12-devtools-dock")).not.toBeInTheDocument();
  });

  it("handles whitelisted shortcuts forwarded by the focused active sandboxed page", () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36");
    try {
      render(<SovereignBrowserWorkbench />);
      const frame = screen.getByTestId("sovereign-live-iframe") as HTMLIFrameElement;
      const input = screen.getByTestId("omnibox-input") as HTMLInputElement;
      frame.focus();
      sendPageShortcut(frame, { key: "l", ctrlKey: true });
      expect(input).toHaveFocus();
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(input.value.length);
      frame.focus();
      sendPageShortcut(frame, { key: "F12" });
      expect(screen.getByTestId("sovereign-f12-devtools-dock")).toBeInTheDocument();
      frame.focus();
      sendPageShortcut(frame, { key: "M", metaKey: true, shiftKey: true });
      expect(screen.getByTestId("device-emulation-bar")).toHaveAttribute("open");
      frame.focus();
      sendPageShortcut(frame, { key: "c", ctrlKey: true, shiftKey: true });
      expect(screen.getByTestId("devtools-inspect-element-btn")).toHaveAttribute("aria-pressed", "true");
      frame.focus();
      sendPageShortcut(frame, { key: "b", ctrlKey: true, altKey: true });
      expect(screen.getByTestId("browser-copilot-prompt-input")).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("toggle-shield-config-btn"));
      frame.focus();
      sendPageShortcut(frame, { key: "Escape" });
      expect(screen.getByTestId("sovereign-shield-config-drawer")).not.toHaveAttribute("open");
      expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-modals allow-downloads");
    } finally {
      userAgent.mockRestore();
    }
  });

  it("creates, reloads, cycles and closes only the active tab through the page bridge", () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36");
    try {
      render(<SovereignBrowserWorkbench />);
      const tablist = screen.getByRole("tablist", { name: "Browser tabs" });
      const originalTabs = within(tablist).getAllByRole("tab");
      const firstFrame = screen.getByTestId("sovereign-live-iframe") as HTMLIFrameElement;
      firstFrame.focus();
      sendPageShortcut(firstFrame, { key: "t", ctrlKey: true });
      expect(within(tablist).getAllByRole("tab")).toHaveLength(originalTabs.length + 1);
      expect(screen.getByTestId("omnibox-input")).toHaveFocus();
      const secondFrame = screen.getByTestId("sovereign-live-iframe") as HTMLIFrameElement;
      secondFrame.focus();
      sendPageShortcut(secondFrame, { key: "r", ctrlKey: true });
      expect(firstFrame).toBeInTheDocument();
      expect(secondFrame).not.toBeInTheDocument();
      const reloadedFrame = screen.getByTestId("sovereign-live-iframe") as HTMLIFrameElement;
      reloadedFrame.focus();
      sendPageShortcut(reloadedFrame, { key: "Tab", ctrlKey: true });
      expect(originalTabs[0]).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("sovereign-live-iframe")).toBe(firstFrame);
      firstFrame.focus();
      sendPageShortcut(firstFrame, { key: "Tab", ctrlKey: true, shiftKey: true });
      expect(screen.getByTestId("sovereign-live-iframe")).toBe(reloadedFrame);
      reloadedFrame.focus();
      sendPageShortcut(reloadedFrame, { key: "w", ctrlKey: true });
      expect(reloadedFrame).not.toBeInTheDocument();
      expect(within(tablist).getAllByRole("tab")).toHaveLength(originalTabs.length);
      expect(originalTabs.at(-1)).toHaveAttribute("aria-selected", "true");
      expect(originalTabs.at(-1)).toHaveFocus();
    } finally {
      userAgent.mockRestore();
    }
  });

  it("ignores spoofed, stale, malformed and non-whitelisted page shortcut messages", () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36");
    try {
      render(<SovereignBrowserWorkbench />);
      const frame = screen.getByTestId("sovereign-live-iframe") as HTMLIFrameElement;
      const tablist = screen.getByRole("tablist", { name: "Browser tabs" });
      const originalCount = within(tablist).getAllByRole("tab").length;
      frame.focus();
      const shortcut = { key: "t", ctrlKey: true };
      sendPageShortcut(frame, shortcut, {}, window);
      sendPageShortcut(frame, shortcut, { url: "https://example.com/stale" });
      sendPageShortcut(frame, shortcut, { channel: "omnia:native-tools" });
      sendPageShortcut(frame, shortcut, { type: "execute" });
      for (const keyboard of [null, [], { key: "t", ctrlKey: true }, { action: "new-tab" }]) {
        sendPageShortcut(frame, shortcut, { keyboard });
      }
      for (const keyboard of [
        { key: "t", ctrlKey: "true" }, { key: "t", ctrlKey: true, metaKey: true },
        { key: "t", ctrlKey: true, isComposing: true }, { key: "t", ctrlKey: true, defaultPrevented: true },
        { key: "t", ctrlKey: true, keyCode: 229 }, { key: "a" },
        { key: "c", ctrlKey: true }, { key: "v", ctrlKey: true },
        { key: "1", ctrlKey: true }, { key: "2", ctrlKey: true }, { key: "3", ctrlKey: true },
      ]) sendPageShortcut(frame, keyboard);
      expect(within(tablist).getAllByRole("tab")).toHaveLength(originalCount);
      expect(screen.queryByTestId("sovereign-f12-devtools-dock")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("new-tab-btn"));
      frame.focus();
      sendPageShortcut(frame, shortcut);
      expect(within(tablist).getAllByRole("tab")).toHaveLength(originalCount + 1);
    } finally {
      userAgent.mockRestore();
    }
  });

  it("ignores queued page shortcuts after focus moves, while hidden or behind a dialog", () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36");
    const dialog = document.createElement("div");
    try {
      render(<><input aria-label="Outside browser" /><div data-testid="browser-wrapper"><SovereignBrowserWorkbench /></div></>);
      const frame = screen.getByTestId("sovereign-live-iframe") as HTMLIFrameElement;
      const wrapper = screen.getByTestId("browser-wrapper");
      const input = screen.getByTestId("omnibox-input");
      const attempt = () => {
        sendPageShortcut(frame, { key: "l", ctrlKey: true });
        sendPageShortcut(frame, { key: "F12" });
        expect(input).not.toHaveFocus();
        expect(screen.queryByTestId("sovereign-f12-devtools-dock")).not.toBeInTheDocument();
      };
      screen.getByRole("textbox", { name: "Outside browser" }).focus();
      attempt();
      for (const [attribute, value] of [["hidden", ""], ["inert", ""], ["aria-hidden", "true"]]) {
        wrapper.setAttribute(attribute!, value!);
        frame.focus();
        attempt();
        wrapper.removeAttribute(attribute!);
      }
      for (const style of ["display: none", "visibility: hidden"]) {
        wrapper.setAttribute("style", style);
        frame.focus();
        attempt();
        wrapper.removeAttribute("style");
      }
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      document.body.appendChild(dialog);
      frame.focus();
      attempt();
      dialog.hidden = true;
      frame.focus();
      sendPageShortcut(frame, { key: "l", ctrlKey: true });
      expect(input).toHaveFocus();
    } finally {
      dialog.remove();
      userAgent.mockRestore();
    }
  });

  it("ignores page shortcuts while the viewport is hidden by maximized DevTools", () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36");
    try {
      render(<SovereignBrowserWorkbench initialDevToolsOpen />);
      const frame = screen.getByTestId("sovereign-live-iframe") as HTMLIFrameElement;
      fireEvent.click(screen.getByTestId("dock-pos-maximized"));
      frame.focus();
      sendPageShortcut(frame, { key: "l", ctrlKey: true });
      sendPageShortcut(frame, { key: "F12" });
      expect(screen.getByTestId("omnibox-input")).not.toHaveFocus();
      expect(screen.getByTestId("sovereign-f12-devtools-dock")).toBeInTheDocument();
    } finally {
      userAgent.mockRestore();
    }
  });

  it("renders multi-tab bar, navigates via omnibox, switches render modes, and toggles F12 via button and F12 key", () => {
    render(<SovereignBrowserWorkbench initialDevToolsOpen />);

    expect(
      screen.getByTestId("sovereign-browser-workbench"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("sovereign-f12-devtools-dock"),
    ).toBeInTheDocument();

    // Verify Shield & Config <details className="sw-accordion"> drawer is collapsed by default
    const shieldDrawer = screen.getByTestId("sovereign-shield-config-drawer");
    expect(shieldDrawer).not.toHaveAttribute("open");
    expect(shieldDrawer).toContainElement(
      screen.getByTestId("load-mode-select"),
    );
    expect(shieldDrawer).toContainElement(
      screen.getByTestId("linked-browser-profile-select"),
    );
    expect(shieldDrawer).toContainElement(
      screen.getByTestId("user-agent-select"),
    );
    expect(shieldDrawer).toContainElement(
      screen.getByTestId("sovereign-allow-all-toggle"),
    );
    expect(shieldDrawer).toContainElement(
      screen.getByTestId("isolated-virtual-input-toggle"),
    );

    // Toggle Shield & Config drawer from Row 1 Tab Bar button
    fireEvent.click(screen.getByTestId("toggle-shield-config-btn"));
    expect(shieldDrawer).toHaveAttribute("open");
    fireEvent.click(screen.getByTestId("toggle-shield-config-btn"));
    expect(shieldDrawer).not.toHaveAttribute("open");

    // Verify Reader toggle in Row 2 Omnibox Bar
    const readerBtn = screen.getByTestId("reader-mode-toggle-btn");
    expect(readerBtn).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(readerBtn);
    expect(readerBtn).toHaveAttribute("aria-pressed", "true");

    // Press F12 key to close DevTools, then press F12 again to re-open
    fireEvent.keyDown(screen.getByTestId("sovereign-browser-workbench"), { key: "F12" });
    expect(
      screen.queryByTestId("sovereign-f12-devtools-dock"),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId("sovereign-browser-workbench"), { key: "F12" });
    expect(
      screen.getByTestId("sovereign-f12-devtools-dock"),
    ).toBeInTheDocument();

    // Add a new tab
    fireEvent.click(screen.getByTestId("new-browser-tab-btn"));
    const omnibox = screen.getByTestId(
      "omnibox-input",
    ) as HTMLInputElement;
    expect(omnibox.value).toContain("new-session");

    // Navigate via omnibox shorthand
    fireEvent.change(omnibox, { target: { value: "news.ycombinator.com" } });
    fireEvent.submit(omnibox.closest("form")!);
    expect(omnibox.value).toBe("https://news.ycombinator.com");

    // Switch render mode to Live Iframe and verify unrestricted allow attribute
    fireEvent.change(screen.getByTestId("load-mode-select"), {
      target: { value: "interactive-frame" },
    });
    const iframe = screen.getByTestId("sovereign-live-iframe");
    expect(iframe).toHaveAttribute("src", "https://news.ycombinator.com");
    expect(iframe.getAttribute("allow")).toContain("clipboard-read");
    expect(iframe.getAttribute("allow")).toContain("camera; microphone");
    expect(iframe.getAttribute("allow")).toContain("geolocation");
  });

  it("sniffs HLS/DASH/Blob streams and dispatches omnia:enqueue-download on 1-click IDM+ handoff", () => {
    render(<SovereignBrowserWorkbench initialDevToolsOpen />);

    const receivedEvents: CustomEvent[] = [];
    const listener = (event: Event) => {
      receivedEvents.push(event as CustomEvent);
    };
    window.addEventListener("omnia:enqueue-download", listener);

    const badge = screen.getByTestId("sniffed-media-badge");
    expect(badge).toHaveTextContent(/Sniffed Media \/ Streams \([4-9]\)/);

    // Click quick 1-click Download with Omnia IDM+
    fireEvent.click(screen.getByTestId("quick-idm-download-top-stream-btn"));

    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0]?.detail).toMatchObject({
      streamKind: "hls-m3u8",
      source: "sovereign-browser",
    });
    expect(screen.getByTestId("idm-enqueue-receipt")).toHaveTextContent(
      "Enqueued in Omnia Ultra IDM+:",
    );

    // Open sniffed media drawer and trigger another candidate download
    fireEvent.click(badge);
    expect(screen.getByTestId("sniffed-media-drawer")).toBeInTheDocument();

    window.removeEventListener("omnia:enqueue-download", listener);
  });

  it("supports all 6 F12 DevTools tabs: Elements, Console, Network, Application, Userscripts, and Sovereign Permissions", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<SovereignBrowserWorkbench initialDevToolsOpen />);

    // 1. Elements Tab: search by CSS selector, mutate attribute & inline CSS, inspect box model
    expect(screen.getByTestId("devtools-panel-elements")).toBeInTheDocument();
    expect(screen.getByTestId("css-box-model-diagram")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("elements-selector-search"), {
      target: { value: "video#primary-video-stream" },
    });
    expect(
      screen.getByTestId("elements-selector-match-count"),
    ).toHaveTextContent("1 match(es)");

    fireEvent.change(screen.getByTestId("style-key-input"), {
      target: { value: "width" },
    });
    fireEvent.change(screen.getByTestId("style-value-input"), {
      target: { value: "1440px" },
    });
    fireEvent.click(screen.getByTestId("apply-style-btn"));
    expect(
      screen.getByTestId("box-model-content-dimensions"),
    ).toHaveTextContent("content: 1440 ×");

    // 2. Console Tab: execute helper button and custom JS expression
    fireEvent.click(screen.getByTestId("devtools-tab-console"));
    expect(screen.getByTestId("devtools-panel-console")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("console-helper-extractLinks()"));
    expect(screen.getByTestId("console-log-output")).toHaveTextContent(
      "master-4k-hdr.m3u8",
    );

    const replInput = screen.getByTestId("console-repl-input");
    fireEvent.change(replInput, { target: { value: "21 * 2" } });
    fireEvent.click(screen.getByTestId("console-repl-run-btn"));
    expect(screen.getByTestId("console-log-output")).toHaveTextContent("42");

    // 3. Network Tab: filter media, copy cURL, replay request, and hand off to IDM+
    fireEvent.click(screen.getByTestId("devtools-tab-network"));
    expect(screen.getByTestId("devtools-panel-network")).toBeInTheDocument();
    expect(screen.getByTestId("network-timing-waterfall")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("copy-curl-btn"));
    expect(screen.getByTestId("devtools-status-banner")).toHaveTextContent(
      "Copied cURL command",
    );

    fireEvent.click(screen.getByTestId("replay-request-btn"));
    expect(screen.getByTestId("devtools-status-banner")).toHaveTextContent(
      "200 OK (CORS Bypassed)",
    );

    fireEvent.click(screen.getByTestId("network-download-idm-btn"));
    expect(screen.getByTestId("idm-enqueue-receipt")).toBeInTheDocument();

    // 4. Application Tab: add Cookie and LocalStorage entry
    fireEvent.click(screen.getByTestId("devtools-tab-application"));
    expect(
      screen.getByTestId("devtools-panel-application"),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("cookie-name-input"), {
      target: { value: "sov_token" },
    });
    fireEvent.change(screen.getByTestId("cookie-value-input"), {
      target: { value: "alpha_99" },
    });
    fireEvent.click(screen.getByTestId("add-cookie-btn"));
    expect(screen.getByTestId("cookie-row-sov_token")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("storage-key-input"), {
      target: { value: "sovereign.customKey" },
    });
    fireEvent.change(screen.getByTestId("storage-value-input"), {
      target: { value: "enabled" },
    });
    fireEvent.click(screen.getByTestId("add-storage-btn"));
    expect(
      screen.getByTestId("storage-row-sovereign.customKey"),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem("sovereign.customKey")).toBe("enabled");

    // 5. Userscripts & Overrides Tab: install userscript and custom header
    fireEvent.click(screen.getByTestId("devtools-tab-userscripts"));
    expect(
      screen.getByTestId("devtools-panel-userscripts"),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("new-userscript-name"), {
      target: { value: "Bypass Paywall & Anti-Adblock" },
    });
    fireEvent.click(screen.getByTestId("add-userscript-btn"));
    expect(screen.getByTestId("devtools-panel-userscripts")).toHaveTextContent(
      "Bypass Paywall & Anti-Adblock",
    );

    fireEvent.change(screen.getByTestId("custom-header-name-input"), {
      target: { value: "X-Custom-Sovereign" },
    });
    fireEvent.change(screen.getByTestId("custom-header-value-input"), {
      target: { value: "unrestricted-1" },
    });
    fireEvent.click(screen.getByTestId("add-custom-header-btn"));
    expect(
      screen.getByTestId("custom-header-row-X-Custom-Sovereign"),
    ).toBeInTheDocument();

    // 6. Sovereign Permissions & Security Tab: toggle permissions and launch External Native F12 Window
    fireEvent.click(screen.getByTestId("devtools-tab-permissions"));
    expect(
      screen.getByTestId("devtools-panel-permissions"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("open-external-native-f12-btn"));
    expect(screen.getByTestId("external-native-f12-receipt")).toHaveTextContent(
      "Native Unrestricted Window with Chromium F12",
    );

    openSpy.mockRestore();
  });

  it("fetches live page HTML via fetch-live-page-dom-btn, renders live srcDoc preview, sniffs real media links into Network tab, and replays real network requests", async () => {
    const liveHtml = [
      "<!DOCTYPE html>",
      '<html lang="en">',
      "<head><title>Real Sovereign Live Endpoint</title></head>",
      "<body>",
      '  <main id="live-fetched-main">',
      "    <h1>Real Live Fetched DOM</h1>",
      '    <video id="live-video" src="https://cdn.example.com/streams/live-8k-master.m3u8"></video>',
      "  </main>",
      "</body>",
      "</html>",
    ].join("\n");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(liveHtml, {
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-sovereign-edge": "live-verified",
        },
      }),
    );

    render(<SovereignBrowserWorkbench initialDevToolsOpen />);

    // Verify localStorage persistence of browser state
    expect(window.localStorage.getItem("omnia.sovereign.browser.v1")).toBeTruthy();

    // Click Fetch Live DOM button in address bar
    fireEvent.click(screen.getByTestId("fetch-live-page-dom-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("devtools-status-banner")).toHaveTextContent(
        /Fetched live DOM from .* \(200 OK/i,
      );
    });

    // Verify live srcDoc iframe is rendered in synthesized-dom-bypass mode with the real HTML
    const srcDocIframe = screen.getByTestId("sovereign-live-srcdoc-iframe");
    expect(srcDocIframe).toBeInTheDocument();
    expect(srcDocIframe.getAttribute("srcdoc")).toContain("Real Live Fetched DOM");

    // Verify DOM Inspector tree parsed the real HTML (#live-fetched-main)
    fireEvent.change(screen.getByTestId("elements-selector-search"), {
      target: { value: "main#live-fetched-main" },
    });
    expect(
      screen.getByTestId("elements-selector-match-count"),
    ).toHaveTextContent("1 match(es)");

    // Open sniffed media drawer and verify live-8k-master.m3u8 was automatically sniffed from live HTML
    fireEvent.click(screen.getByTestId("sniffed-media-badge"));
    expect(screen.getByTestId("sniffed-media-drawer")).toHaveTextContent(
      "live-8k-master.m3u8",
    );

    fetchSpy.mockRestore();
  });

  it("links Edge / Chrome Canary browser profiles with anti-automation F12 flags and imports/exports cookies into Browser & Ultra IDM+", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<SovereignBrowserWorkbench initialDevToolsOpen />);

    // Switch top-bar linked browser profile selector to Google Chrome Canary
    const topProfileSelect = screen.getByTestId(
      "linked-browser-profile-select",
    ) as HTMLSelectElement;
    fireEvent.change(topProfileSelect, {
      target: { value: "profile-chrome-canary-default" },
    });
    expect(topProfileSelect.value).toBe("profile-chrome-canary-default");

    // Open Application tab to access the Browser Profile Linker & Universal Cookie Importer Studio
    fireEvent.click(screen.getByTestId("devtools-tab-application"));
    expect(
      screen.getByTestId("browser-profile-cookie-studio"),
    ).toBeInTheDocument();

    const launchCmdPre = screen.getByTestId("browser-profile-launch-cmd");
    expect(launchCmdPre.textContent).toContain(
      "Chrome SxS\\Application\\chrome.exe",
    );
    expect(launchCmdPre.textContent).toContain(
      "--disable-blink-features=AutomationControlled",
    );
    expect(launchCmdPre.textContent).toContain("--auto-open-devtools-for-tabs");

    // Customize profile directory to Profile 2 and CDP port to 9333
    fireEvent.change(screen.getByTestId("browser-profile-directory-input"), {
      target: { value: "Profile 2" },
    });
    fireEvent.change(screen.getByTestId("browser-profile-port-input"), {
      target: { value: "9333" },
    });
    expect(launchCmdPre.textContent).toContain('--profile-directory="Profile 2"');
    expect(launchCmdPre.textContent).toContain("--remote-debugging-port=9333");

    // Click Launch & Link Profile with Native F12
    fireEvent.click(screen.getByTestId("launch-linked-browser-profile-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("devtools-status-banner")).toHaveTextContent(
        "Google Chrome Canary (Default) (Profile 2)",
      );
    });

    // Load sample Chrome Canary / Edge session & Turnstile clearance cookies and import them
    fireEvent.click(screen.getByTestId("load-sample-cookies-btn"));
    const cookieTextarea = screen.getByTestId(
      "cookie-import-textarea",
    ) as HTMLTextAreaElement;
    expect(cookieTextarea.value).toContain("cf_clearance");
    expect(cookieTextarea.value).toContain("__Secure-1PSID");

    fireEvent.click(screen.getByTestId("import-cookies-btn"));
    expect(screen.getByTestId("cookie-row-cf_clearance")).toBeInTheDocument();
    expect(screen.getByTestId("cookie-row-__Secure-1PSID")).toBeInTheDocument();

    // Export Netscape cookies.txt
    fireEvent.click(screen.getByTestId("export-cookies-btn"));
    expect(cookieTextarea.value).toContain("# Netscape HTTP Cookie File");
    expect(cookieTextarea.value).toContain("cf_clearance");

    // Verify omnia:enqueue-download carries the imported cookies in detail.cookieHeader
    const receivedEvents: CustomEvent[] = [];
    const listener = (event: Event) => {
      receivedEvents.push(event as CustomEvent);
    };
    window.addEventListener("omnia:enqueue-download", listener);

    fireEvent.click(screen.getByTestId("quick-idm-download-top-stream-btn"));
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]?.detail.cookieHeader).toContain(
      "cf_clearance=human_turnstile_verified_edge_canary_9981",
    );
    expect(receivedEvents[0]?.detail.cookieHeader).toContain(
      "__Secure-1PSID=g.a000sovereign_google_canary_session_token",
    );

    window.removeEventListener("omnia:enqueue-download", listener);
    openSpy.mockRestore();
  });

  it("supports Chrome DevTools Device Emulation presets, Set-of-Marks [SoM #N] Accessibility tree, Web Vitals, and Anti-Detect Stealth spoofing", () => {
    render(<SovereignBrowserWorkbench initialDevToolsOpen />);

    // Verify Device Emulation Bar is collapsed by default and supports preset switching (iPhone 16 Pro)
    const deviceEmulationBar = screen.getByTestId("device-emulation-bar");
    expect(deviceEmulationBar).toBeInTheDocument();
    expect(deviceEmulationBar).not.toHaveAttribute("open");
    const presetSelect = screen.getByTestId(
      "device-preset-select",
    ) as HTMLSelectElement;
    fireEvent.change(presetSelect, { target: { value: "iphone-16-pro" } });
    expect(presetSelect.value).toBe("iphone-16-pro");
    expect(deviceEmulationBar).toHaveTextContent(
      "402×874",
    );
    expect(deviceEmulationBar).toHaveTextContent(
      "DPR 3x · Touch Mobile",
    );

    // Toggle SoM overlay in viewport
    expect(screen.getByTestId("canvas-som-badge-1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("toggle-som-overlay-btn"));
    expect(screen.queryByTestId("canvas-som-badge-1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("toggle-som-overlay-btn"));
    expect(screen.getByTestId("canvas-som-badge-1")).toBeInTheDocument();

    // Verify Web Vitals bar in DevTools header
    expect(screen.getByTestId("performance-vitals-bar")).toHaveTextContent(
      /LCP \d+ms/,
    );

    // Switch Elements right-pane sub-tab to Accessibility & Set-of-Marks (SoM)
    fireEvent.click(screen.getByTestId("elements-subtab-a11y-som"));
    const somPanel = screen.getByTestId("accessibility-som-tree-panel");
    expect(somPanel).toBeInTheDocument();
    expect(somPanel).toHaveTextContent("[SoM #1]");
    expect(
      screen.getByTestId("som-mark-row-1"),
    ).toBeInTheDocument();

    // Open Permissions & Stealth tab and verify Anti-Detect Stealth script & toggle
    fireEvent.click(screen.getByTestId("devtools-tab-permissions"));
    expect(screen.getByTestId("anti-detect-stealth-panel")).toBeInTheDocument();
    expect(screen.getByTestId("stealth-script-preview")).toHaveTextContent(
      "NVIDIA GeForce GTX 1650 Ti",
    );
    fireEvent.click(screen.getByTestId("toggle-stealth-mode-btn"));
    expect(screen.getByTestId("stealth-script-preview")).toHaveTextContent(
      "// Omnia Anti-Detect Stealth Injection Disabled",
    );
  });

  it("renders the Omnia AI Browser Copilot Right Sidebar, summarizes pages, extracts media to IDM+, and toggles live proxy bypass", () => {
    render(<SovereignBrowserWorkbench initialDevToolsOpen />);

    fireEvent.click(screen.getByTestId("browser-copilot-toggle-btn"));
    const copilotSidebar = screen.getByTestId("browser-ai-copilot-sidebar");
    expect(copilotSidebar).toBeInTheDocument();
    expect(copilotSidebar).toHaveAttribute("aria-label", "Browser AI side panel");
    expect(copilotSidebar).not.toHaveTextContent("Local Cache Active");
    expect(within(copilotSidebar).queryByRole("tablist")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Page actions" }));
    fireEvent.click(screen.getByTestId("browser-copilot-summarize-btn"));
    expect(screen.getByTestId("browser-copilot-messages")).toHaveTextContent(
      /Read @active-tab/i,
    );

    fireEvent.click(screen.getByRole("button", { name: "Page actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "More page actions" }));
    fireEvent.click(screen.getByTestId("browser-copilot-extract-idm-btn"));
    expect(screen.getByTestId("browser-copilot-messages")).toHaveTextContent(
      /Queued \d+ media links/i,
    );

    fireEvent.click(screen.getByTestId("browser-copilot-inject-userscript-btn"));
    expect(screen.getByTestId("browser-copilot-messages")).toHaveTextContent(
      /Added "Omnia AI Copilot Enhancer/i,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    fireEvent.change(screen.getByTestId("browser-copilot-prompt-input"), {
      target: { value: "Inspect all interactive buttons" },
    });
    fireEvent.click(screen.getByTestId("browser-copilot-send-btn"));
    expect(screen.getByTestId("browser-copilot-messages")).toHaveTextContent(
      "Inspect all interactive buttons",
    );

    const proxyBtn = screen.getByTestId("browser-proxy-bypass-toggle");
    expect(proxyBtn).toBeInTheDocument();
    fireEvent.click(proxyBtn);
    expect(proxyBtn).toHaveAttribute("aria-pressed", "true");
  }, 20000);

  it("defaults real runtime to everyday browsing with F12 closed and no synthetic network streams", () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36");
    try {
      render(<SovereignBrowserWorkbench />);
      expect(screen.getByTestId("omnibox-input")).toHaveValue("https://news.ycombinator.com");
      expect(screen.queryByTestId("sovereign-f12-devtools-dock")).not.toBeInTheDocument();
      expect(screen.getByTestId("toggle-devtools-btn")).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByTestId("sniffed-media-badge")).toHaveTextContent("Streams (0)");
      const page = screen.getByTestId("sovereign-live-iframe");
      expect(page).toHaveAttribute("src", "/__omnia_browser_proxy?url=https%3A%2F%2Fnews.ycombinator.com");
      expect(page).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-modals allow-downloads");
      expect(page.getAttribute("sandbox")).not.toContain("allow-same-origin");
      expect(screen.getByTestId("workspace-mode-switcher")).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("toggle-devtools-btn"));
      expect(screen.getByTestId("sovereign-f12-devtools-dock")).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("new-tab-btn"));
      expect(screen.getByTestId("omnibox-input")).toHaveValue("https://news.ycombinator.com");
    } finally {
      userAgent.mockRestore();
    }
  });

  it("accepts page context only from the active sandboxed frame and navigates intercepted links", async () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36");
    try {
      render(<SovereignBrowserWorkbench />);
      const frame = screen.getByTestId("sovereign-live-iframe") as HTMLIFrameElement;
      const snapshot = { channel: "omnia:browser-context", type: "loaded", url: "https://news.ycombinator.com", title: "Live browser page", html: '<html><head><title>Live browser page</title></head><body><h1>Verified capture</h1><a href="https://example.com">Example</a></body></html>' };
      fireEvent(window, new MessageEvent("message", { source: window, data: snapshot }));
      expect(screen.queryByText("Live browser page")).not.toBeInTheDocument();
      fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data: snapshot }));
      fireEvent.click(screen.getByTestId("browser-copilot-toggle-btn"));
      fireEvent.click(screen.getByRole("button", { name: "Page actions" }));
      await waitFor(() => expect(screen.getByTestId("browser-copilot-summarize-btn")).toBeInTheDocument());
      fireEvent.click(screen.getByTestId("browser-copilot-summarize-btn"));
      expect(screen.getByTestId("browser-copilot-messages")).toHaveTextContent("Verified capture");
      fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data: { channel: "omnia:browser-context", type: "navigate", url: "https://example.com" } }));
      expect(screen.getByTestId("omnibox-input")).toHaveValue("https://example.com");
    } finally {
      userAgent.mockRestore();
    }
  });

  it("stages browser preview requests in Chat instead of fabricating AI analysis", () => {
    render(<SovereignBrowserWorkbench initialDevToolsOpen />);
    fireEvent.click(screen.getByTestId("browser-copilot-toggle-btn"));
    const prompt = "Inspect all interactive buttons without inventing evidence";
    fireEvent.change(screen.getByTestId("browser-copilot-prompt-input"), { target: { value: prompt } });
    fireEvent.click(screen.getByTestId("browser-copilot-send-btn"));
    const messages = screen.getByTestId("browser-copilot-messages");
    expect(messages).toHaveTextContent("No message was sent");
    expect(messages).not.toHaveTextContent("Omnia AI Copilot analyzed");
    const state = useWorkspaceStore.getState();
    expect(state.conversations.find((conversation) => conversation.id === state.activeConversationId)?.draft).toContain(prompt);
  });

  it("implements Images 0-2 with a lock/URL/bookmark-only omnibox and click-only utility drawers", () => {
    render(<SovereignBrowserWorkbench />);
    expect(screen.queryByTestId("sovereign-f12-devtools-dock")).not.toBeInTheDocument();
    const address = screen.getByTestId("omnibox-input").closest("form")!;
    expect(address.children).toHaveLength(3);
    expect(address.querySelector("svg.lucide-lock-keyhole")).toBeInTheDocument();
    expect(within(address).getAllByRole("button")).toHaveLength(1);
    const bookmark = screen.getByTestId("omnibox-bookmark-btn");
    const wasBookmarked = bookmark.getAttribute("aria-pressed");
    fireEvent.click(bookmark);
    expect(bookmark).toHaveAttribute("aria-pressed", wasBookmarked === "true" ? "false" : "true");
    expect(screen.queryByTestId("browser-profile-select")).not.toBeInTheDocument();
    const profile = screen.getByTestId("browser-profile-btn");
    expect(profile).toHaveAttribute("title", "Browser profile (click to switch profile or import cookies)");
    expect(profile).toHaveTextContent("");
    expect(profile.querySelector("svg")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Browser profile" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("browser-copilot-toggle-btn"));
    fireEvent.click(screen.getByRole("button", { name: "Close AI side panel" }));
    fireEvent.click(profile);
    expect(screen.getByRole("dialog", { name: "Browser profile" })).toBeInTheDocument();
    expect(screen.getByTestId("browser-profile-select")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Browser profile" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Browser profile" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("sniffed-media-badge"));
    expect(screen.getByTestId("sniffed-media-drawer")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("browser-download-tools-btn"));
    expect(screen.getByRole("dialog", { name: "Downloads" })).toBeInTheDocument();
    expect(screen.queryByTestId("browser-ai-copilot-sidebar")).not.toBeInTheDocument();
  });

});

describe("SovereignBrowserWorkbench inside the shell", () => {
  it("keeps one tab strip and one address row without a duplicate mode switcher", () => {
    const host = document.createElement("section");
    host.className = "ag-workspace";
    document.body.appendChild(host);
    render(<SovereignBrowserWorkbench />, { container: host });
    const workbench = screen.getByTestId("sovereign-browser-workbench");
    expect(workbench).toHaveAttribute("data-embedded-shell", "true");
    expect(within(workbench).queryByTestId("workspace-mode-switcher")).not.toBeInTheDocument();
    expect(within(workbench).getAllByTestId("omnibox-input")).toHaveLength(1);
    expect(within(workbench).getAllByTestId("sovereign-address-bar")).toHaveLength(1);
    host.remove();
  });
});
