import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeBrowserController, NativeBrowserShortcutAction } from "./native-browser-surface";

interface StubSurfaceProps {
  tabKey: string; url: string; active: boolean;
  onController: (tabKey: string, controller: NativeBrowserController | null) => void;
  onNavigation: (tabKey: string, url: string, title?: string) => void;
  onShortcut: (tabKey: string, action: NativeBrowserShortcutAction) => void;
}
const { nativeAction, nativeRuntime, surfaces } = vi.hoisted(() => ({ nativeAction: vi.fn(), nativeRuntime: { enabled: true }, surfaces: new Map<string, StubSurfaceProps>() }));
vi.mock("./ide-editor-transport", () => ({ usesNativeEditorTransport: () => nativeRuntime.enabled }));
vi.mock("./native-browser-surface", async (importOriginal) => {
  const original = await importOriginal<typeof import("./native-browser-surface")>();
  const { useEffect } = await import("react");
  return { ...original, NativeBrowserSurface: (props: StubSurfaceProps) => {
    surfaces.set(props.tabKey, props);
    useEffect(() => {
      props.onController(props.tabKey, { action: nativeAction });
      return () => { props.onController(props.tabKey, null); surfaces.delete(props.tabKey); };
    }, [props.tabKey, props.onController]);
    return <div data-testid={`native-browser-stub-${props.tabKey}`} data-url={props.url} data-active={props.active ? "true" : "false"} />;
  } };
});

import { SovereignBrowserWorkbench } from "./sovereign-browser-workbench";

beforeEach(() => {
  vi.clearAllMocks();
  nativeRuntime.enabled = true;
  nativeAction.mockResolvedValue(undefined);
  surfaces.clear();
  const memory = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("packaged native browser workbench", () => {
  it("uses the host shell navigation without rendering a second workspace switcher", () => {
    render(<div className="ws-surface" data-view="browser"><SovereignBrowserWorkbench initialUrl="https://example.com/" /></div>);
    expect(screen.queryByRole("group", { name: "Primary workspace mode" })).toBeNull();
    expect(screen.getByRole("tablist", { name: "Browser tabs" })).toBeVisible();
  });

  it("reserves a native resize gutter without overlapping the child page", () => {
    render(<SovereignBrowserWorkbench initialUrl="https://example.com/" />);
    fireEvent.click(screen.getByRole("button", { name: "Omnia Browser AI side panel" }));
    expect(screen.getByRole("separator", { name: "Resize Browser AI Sidebar" })).toHaveStyle({ marginInline: "0" });
    cleanup();

    nativeRuntime.enabled = false;
    render(<SovereignBrowserWorkbench initialUrl="https://example.com/" />);
    fireEvent.click(screen.getByRole("button", { name: "Omnia Browser AI side panel" }));
    expect(screen.getByRole("separator", { name: "Resize Browser AI Sidebar" }).style.marginInline).toBe("");
  });

  it("resizes the right sidebar from the keyboard with controlled bounds", () => {
    render(<SovereignBrowserWorkbench initialUrl="https://example.com/" />);
    fireEvent.click(screen.getByRole("button", { name: "Omnia Browser AI side panel" }));
    const resizer = screen.getByRole("separator", { name: "Resize Browser AI Sidebar" });
    expect(resizer).toHaveAttribute("tabindex", "0");
    expect(resizer).toHaveAttribute("aria-valuemin", "260");
    expect(resizer).toHaveAttribute("aria-valuemax", "640");
    expect(resizer).toHaveAttribute("aria-valuenow", "340");
    act(() => resizer.focus());

    fireEvent.keyDown(resizer, { key: "ArrowLeft" });
    expect(resizer).toHaveAttribute("aria-valuenow", "360");
    expect(screen.getByTestId("sovereign-browser-workbench")).toHaveStyle({ "--browser-ai-sidebar-width": "360px" });
    fireEvent.keyDown(resizer, { key: "ArrowRight" });
    expect(resizer).toHaveAttribute("aria-valuenow", "340");
    fireEvent.keyDown(resizer, { key: "Home" });
    fireEvent.keyDown(resizer, { key: "ArrowRight" });
    expect(resizer).toHaveAttribute("aria-valuenow", "260");
    fireEvent.keyDown(resizer, { key: "End" });
    fireEvent.keyDown(resizer, { key: "ArrowLeft" });
    expect(resizer).toHaveAttribute("aria-valuenow", "640");
    expect(resizer).toHaveFocus();
    expect(surfaces.get("tab-sovereign-hub")!.active).toBe(true);
  });

  it("leaves modified, composing and already handled resize keys alone", () => {
    render(<SovereignBrowserWorkbench initialUrl="https://example.com/" />);
    fireEvent.click(screen.getByRole("button", { name: "Omnia Browser AI side panel" }));
    const resizer = screen.getByRole("separator", { name: "Resize Browser AI Sidebar" });
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      fireEvent.keyDown(resizer, { key: "ArrowLeft", ...modifiers });
      expect(resizer).toHaveAttribute("aria-valuenow", "340");
    }
    expect(nativeAction).toHaveBeenCalledWith("back");
    const handled = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
    handled.preventDefault();
    fireEvent(resizer, handled);
    expect(fireEvent.keyDown(resizer, { key: "ArrowUp" })).toBe(true);
    expect(resizer).toHaveAttribute("aria-valuenow", "340");
  });

  it("keeps native pointer resizing bounded and restores the page after dragging", () => {
    render(<SovereignBrowserWorkbench initialUrl="https://example.com/" />);
    fireEvent.click(screen.getByRole("button", { name: "Omnia Browser AI side panel" }));
    const resizer = screen.getByRole("separator", { name: "Resize Browser AI Sidebar" });
    fireEvent(resizer, new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 1000, clientY: 400 }));
    expect(resizer).toHaveFocus();
    expect(surfaces.get("tab-sovereign-hub")!.active).toBe(false);
    fireEvent(window, new MouseEvent("pointermove", { clientX: 850, clientY: 400 }));
    expect(resizer).toHaveAttribute("aria-valuenow", "490");
    fireEvent(window, new MouseEvent("pointermove", { clientX: 0, clientY: 400 }));
    expect(resizer).toHaveAttribute("aria-valuenow", "640");
    fireEvent(window, new MouseEvent("pointermove", { clientX: 2000, clientY: 400 }));
    expect(resizer).toHaveAttribute("aria-valuenow", "260");
    fireEvent(window, new MouseEvent("pointerup"));
    expect(surfaces.get("tab-sovereign-hub")!.active).toBe(true);
    expect(screen.getByTestId("sovereign-browser-workbench")).not.toHaveAttribute("data-resizing");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(resizer).toHaveAttribute("aria-valuenow", "260");
  });

  it("opens the native page and sends toolbar and keyboard actions to that document", async () => {
    const fetchPage = vi.fn();
    vi.stubGlobal("fetch", fetchPage);
    render(<SovereignBrowserWorkbench initialUrl="https://example.com/" />);
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByTestId("native-browser-stub-tab-sovereign-hub")).toHaveAttribute("data-url", "https://example.com/");
    fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
    fireEvent.click(screen.getByRole("button", { name: "Developer tools" }));
    expect(nativeAction).toHaveBeenCalledWith("reload");
    expect(nativeAction).toHaveBeenCalledWith("devtools");
    const address = screen.getByRole("textbox", { name: "Address or search" });
    fireEvent.change(address, { target: { value: "https://example.org/next" } });
    fireEvent.submit(address.closest("form")!);
    expect(screen.getByTestId("native-browser-stub-tab-sovereign-hub")).toHaveAttribute("data-url", "https://example.org/next");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(nativeAction).toHaveBeenCalledWith("back");
    fireEvent.keyDown(address, { key: "r", ctrlKey: true });
    expect(nativeAction.mock.calls.filter(([action]) => action === "reload")).toHaveLength(2);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("updates the omnibox and tab title from native navigation without inventing a DOM capture", async () => {
    render(<SovereignBrowserWorkbench initialUrl="https://example.com/" />);
    const first = surfaces.get("tab-sovereign-hub")!;
    await act(async () => { first.onNavigation(first.tabKey, "https://example.org/final", "Example final"); });
    expect(screen.getByRole("textbox", { name: "Address or search" })).toHaveValue("https://example.org/final");
    expect(within(screen.getByRole("tablist", { name: "Browser tabs" })).getByRole("tab", { name: "Example final" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.queryByText("Fetched live DOM", { exact: false })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Browser settings" }));
    for (const id of ["fetch-live-page-dom-btn", "reader-mode-toggle-btn", "browser-proxy-bypass-toggle", "nav-stop-btn", "load-mode-select"]) expect(screen.getByTestId(id)).toBeDisabled();
    expect(screen.getByText("Pages open directly in the browser. Reader mode and page text capture are not available yet.")).toBeVisible();
  });


  it("keeps a new tab address selected while native navigation normalizes its URL", async () => {
    render(<SovereignBrowserWorkbench initialUrl="https://example.com/" />);
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    const next = Array.from(surfaces.values()).find((item) => item.active)!;
    const address = screen.getByRole("textbox", { name: "Address or search" }) as HTMLInputElement;
    expect(address).toHaveFocus();
    const selectedUrl = address.value;
    expect(address.selectionStart).toBe(0);
    expect(address.selectionEnd).toBe(selectedUrl.length);

    await act(async () => { next.onNavigation(next.tabKey, `${next.url}/`, "Hacker News"); });
    expect(address).toHaveValue(selectedUrl);
    expect(address.selectionStart).toBe(0);
    expect(address.selectionEnd).toBe(selectedUrl.length);
    act(() => address.blur());
    expect(address).toHaveValue(`${next.url}/`);
  });

  it("preserves a focused address draft and selection until Escape or submission", async () => {
    render(<SovereignBrowserWorkbench initialUrl="https://example.com/" />);
    const first = surfaces.get("tab-sovereign-hub")!;
    const address = screen.getByRole("textbox", { name: "Address or search" }) as HTMLInputElement;
    act(() => address.focus());
    fireEvent.change(address, { target: { value: "tìm browser Unicode" } });
    address.setSelectionRange(4, 11);

    await act(async () => { first.onNavigation(first.tabKey, "https://example.org/redirected", "Redirected"); });
    expect(address).toHaveValue("tìm browser Unicode");
    expect(address.selectionStart).toBe(4);
    expect(address.selectionEnd).toBe(11);
    expect(within(screen.getByRole("tablist", { name: "Browser tabs" })).getByRole("tab", { name: "Redirected" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(address, { key: "Escape" });
    expect(address).toHaveValue("https://example.org/redirected");
    fireEvent.change(address, { target: { value: "https://example.net/next" } });
    fireEvent.submit(address.closest("form")!);
    expect(screen.getByTestId("native-browser-stub-tab-sovereign-hub")).toHaveAttribute("data-url", "https://example.net/next");
    expect(address).toHaveValue("https://example.net/next");
  });

  it("replaces a focused draft when switching tabs and protects the new tab selection", async () => {
    render(<SovereignBrowserWorkbench initialUrl="https://example.com/" />);
    const first = surfaces.get("tab-sovereign-hub")!;
    const firstTab = within(screen.getByRole("tablist", { name: "Browser tabs" })).getAllByRole("tab")[0]!;
    const address = screen.getByRole("textbox", { name: "Address or search" }) as HTMLInputElement;
    act(() => address.focus());
    fireEvent.change(address, { target: { value: "unfinished draft" } });
    await act(async () => { first.onShortcut(first.tabKey, "new-tab"); });
    const next = Array.from(surfaces.values()).find((item) => item.active)!;
    expect(address).toHaveValue(next.url);
    expect(address).toHaveFocus();
    await act(async () => { next.onNavigation(next.tabKey, `${next.url}/`, "Hacker News"); });
    expect(address).toHaveValue(next.url);
    expect(address.selectionStart).toBe(0);
    expect(address.selectionEnd).toBe(next.url.length);
    fireEvent.click(firstTab);
    expect(address).toHaveValue(first.url);
  });

  it("retains a background native tab and releases its controller when closed", async () => {
    render(<SovereignBrowserWorkbench initialUrl="https://example.com/" />);
    const first = screen.getByTestId("native-browser-stub-tab-sovereign-hub");
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    const next = Array.from(surfaces.values()).find((item) => item.active)!;
    expect(next.tabKey).not.toBe("tab-sovereign-hub");
    expect(first).toBeInTheDocument();
    expect(first).toHaveAttribute("data-active", "false");
    fireEvent.click(screen.getByRole("button", { name: "Close Hacker News" }));
    await waitFor(() => expect(surfaces.has(next.tabKey)).toBe(false));
    expect(first).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("tablist", { name: "Browser tabs" })).getAllByRole("tab")[0]!);
    expect(first).toHaveAttribute("data-active", "true");
  });

  it("reports unavailable native media capture without inventing a scan or queued handoff", () => {
    const enqueue = vi.fn();
    window.addEventListener("omnia:enqueue-download", enqueue);
    try {
      render(<SovereignBrowserWorkbench initialUrl="https://example.com/" />);
      fireEvent.click(screen.getByRole("button", { name: "Downloads" }));
      expect(screen.getByText("Media capture is not available for this browser yet. No media links have been captured.")).toBeVisible();
      expect(screen.queryByText("No active downloads or media streams detected on this page yet.")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Close downloads" }));
      fireEvent.click(screen.getByRole("button", { name: "Omnia Browser AI side panel" }));
      fireEvent.click(screen.getByRole("button", { name: "Page actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "More page actions" }));
      fireEvent.click(screen.getByRole("button", { name: "Queue detected media" }));
      expect(screen.getByText("Media capture is not available for this browser yet. No media links were queued.")).toBeVisible();
      expect(screen.queryByText("Queued detected media")).not.toBeInTheDocument();
      expect(screen.queryByText("No downloadable media was detected on this page.")).not.toBeInTheDocument();
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("omnia:enqueue-download", enqueue);
    }
  });

  it("restores browser focus after a native close so the next shortcut reaches the omnibox", async () => {
    render(<SovereignBrowserWorkbench initialUrl="https://example.com/" />);
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    const tabs = screen.getAllByRole("tab");
    const neighbour = tabs[tabs.length - 2]!;
    const closing = Array.from(surfaces.values()).find((item) => item.active)!;
    const address = screen.getByRole("textbox", { name: "Address or search" }) as HTMLInputElement;
    address.blur();
    expect(document.activeElement).toBe(document.body);

    await act(async () => { closing.onShortcut(closing.tabKey, "close-tab"); });
    expect(neighbour).toHaveAttribute("aria-selected", "true");
    expect(neighbour).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "l", ctrlKey: true });
    expect(address).toHaveFocus();
    expect(address.selectionStart).toBe(0);
    expect(address.selectionEnd).toBe(address.value.length);
  });

  it("does not steal address focus when an inactive native tab is closed", () => {
    render(<SovereignBrowserWorkbench initialUrl="https://example.com/" />);
    const address = screen.getByRole("textbox", { name: "Address or search" });
    address.focus();
    fireEvent.click(screen.getByRole("button", { name: "Close github.com/tauri-apps/tauri" }));
    expect(address).toHaveFocus();
    expect(screen.getByRole("tab", { name: "example.com" })).toHaveAttribute("aria-selected", "true");
  });

  it("routes native shortcuts through selected-tab actions and ignores background tab events", async () => {
    render(<SovereignBrowserWorkbench initialUrl="https://example.com/" />);
    const first = surfaces.get("tab-sovereign-hub")!;
    const address = screen.getByRole("textbox", { name: "Address or search" });
    await act(async () => { first.onShortcut(first.tabKey, "focus-address"); });
    expect(address).toHaveFocus();
    await act(async () => { first.onShortcut(first.tabKey, "new-tab"); });
    const tabs = screen.getAllByRole("tab");
    const next = Array.from(surfaces.values()).find((item) => item.active)!;
    await act(async () => { surfaces.get(first.tabKey)!.onShortcut(first.tabKey, "new-tab"); });
    expect(screen.getAllByRole("tab")).toHaveLength(tabs.length);
    await act(async () => { next.onShortcut(next.tabKey, "reload"); });
    expect(nativeAction).toHaveBeenCalledWith("reload");
    await act(async () => { next.onShortcut(next.tabKey, "previous-tab"); });
    expect(tabs[tabs.length - 2]).toHaveAttribute("aria-selected", "true");
  });
});
