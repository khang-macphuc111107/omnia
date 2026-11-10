import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeCore, listen, stopListening, stopShortcuts, navigation, policy, shortcuts } = vi.hoisted(() => ({
  invokeCore: vi.fn(), listen: vi.fn(), stopListening: vi.fn(), stopShortcuts: vi.fn(), navigation: { handler: null as ((event: { payload: unknown }) => void) | null },
  policy: { handler: null as ((event: { payload: unknown }) => void) | null },
  shortcuts: { handler: null as ((event: { payload: unknown }) => void) | null },
}));
vi.mock("@/lib/desktop", () => ({ invokeCore }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { NativeBrowserSurface, validNativeBrowserUrl, type NativeBrowserController } from "./native-browser-surface";

const rect = (x: number, y: number, width: number, height: number): DOMRect => ({
  x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}),
});
const onController = vi.fn();
const onNavigation = vi.fn();
const onPolicyNotice = vi.fn();
const onShortcut = vi.fn();
const props = { tabKey: "tab-one", url: "https://example.com/", active: true, onController, onNavigation, onPolicyNotice, onShortcut };

beforeEach(() => {
  vi.clearAllMocks();
  navigation.handler = null;
  policy.handler = null;
  shortcuts.handler = null;
  invokeCore.mockImplementation(async (command: string) => command === "browser_surface_attach" ? { leaseId: "lease-one" } : undefined);
  listen.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => {
    if (name === "omnia-native-browser-shortcut") { shortcuts.handler = handler; return stopShortcuts; }
    if (name === "omnia-browser-surface-policy") { policy.handler = handler; return stopListening; }
    navigation.handler = handler;
    return stopListening;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => rect(20, 30, 500, 350));
});
afterEach(() => { cleanup(); document.querySelectorAll('[data-test-native-overlay]').forEach((node) => node.remove()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function attached() {
  await waitFor(() => expect(screen.getByRole("button", { name: "Focus page" })).toBeEnabled());
}

describe("NativeBrowserSurface", () => {
  it("releases outside a blocked update queue when its deadline expires under an overlay", async () => {
    render(<NativeBrowserSurface {...props} />);
    await attached();
    vi.useFakeTimers();
    let finish!: () => void;
    invokeCore.mockImplementation((command: string) => command === "browser_surface_update"
      ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve());
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(rect(40, 30, 500, 350));
    await act(async () => { fireEvent(window, new Event("resize")); });
    expect(invokeCore).toHaveBeenLastCalledWith("browser_surface_update", expect.objectContaining({ visible: true, bounds: expect.objectContaining({ x: 40 }) }));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-test-native-overlay", "");
    await act(async () => { document.body.append(dialog); });
    const updatesBeforeTimeout = invokeCore.mock.calls.filter(([command]) => command === "browser_surface_update").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByText("The browser page did not respond. Retry the page.")).toBeVisible();
    expect(invokeCore).toHaveBeenLastCalledWith("browser_surface_release", { leaseId: "lease-one" });
    expect(stopListening).toHaveBeenCalledOnce();
    expect(stopShortcuts).toHaveBeenCalledOnce();
    await act(async () => { finish(); });
    expect(invokeCore.mock.calls.filter(([command]) => command === "browser_surface_update")).toHaveLength(updatesBeforeTimeout);
    expect(screen.getByRole("button", { name: "Focus page" })).toBeDisabled();
  });

  it("times out attach, retries with a new lease and releases the late attachment without showing it", async () => {
    vi.useFakeTimers();
    let finish!: (value: { leaseId: string }) => void;
    let attaches = 0;
    invokeCore.mockImplementation((command: string) => {
      if (command !== "browser_surface_attach") return Promise.resolve();
      attaches += 1;
      return attaches === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ leaseId: "new-lease" });
    });
    render(<NativeBrowserSurface {...props} />);
    await act(async () => { await Promise.resolve(); });
    expect(attaches).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByRole("button", { name: "Retry page" })).toBeVisible();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry page" })); });
    expect(screen.getByRole("button", { name: "Focus page" })).toBeEnabled();
    expect(attaches).toBe(2);
    await act(async () => { finish({ leaseId: "late-lease" }); });
    expect(invokeCore).toHaveBeenCalledWith("browser_surface_release", { leaseId: "late-lease" });
    expect(invokeCore).not.toHaveBeenCalledWith("browser_surface_release", { leaseId: "new-lease" });
    expect(invokeCore.mock.calls.filter(([command]) => command === "browser_surface_update").every(([, args]) => args.leaseId === "new-lease")).toBe(true);
    expect(screen.getByRole("button", { name: "Focus page" })).toBeEnabled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["browser_surface_navigate", "browser_surface_action"])("bounds a pending %s and consumes its late rejection", async (pendingCommand) => {
    const view = render(<NativeBrowserSurface {...props} />);
    await attached();
    vi.useFakeTimers();
    let reject!: (reason: Error) => void;
    invokeCore.mockImplementation((command: string) => command === pendingCommand
      ? new Promise((_resolve, fail) => { reject = fail; }) : Promise.resolve());
    let actionResult: Promise<unknown> | undefined;
    await act(async () => {
      if (pendingCommand === "browser_surface_navigate") view.rerender(<NativeBrowserSurface {...props} url="https://example.org/new" />);
      else {
        const controller = onController.mock.calls.find(([, value]) => value)?.[1] as NativeBrowserController;
        actionResult = controller.action("back").catch((reason: unknown) => reason);
      }
    });
    expect(invokeCore).toHaveBeenLastCalledWith(pendingCommand, expect.any(Object));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByText("The browser page did not respond. Retry the page.")).toBeVisible();
    expect(invokeCore).toHaveBeenLastCalledWith("browser_surface_release", { leaseId: "lease-one" });
    if (actionResult) expect(await actionResult).toBeInstanceOf(Error);
    await act(async () => { reject(new Error("late IPC rejection")); });
    expect(screen.getByRole("button", { name: "Retry page" })).toBeVisible();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels pending request deadlines on unmount and keeps late completion retired", async () => {
    const view = render(<NativeBrowserSurface {...props} />);
    await attached();
    vi.useFakeTimers();
    let finish!: () => void;
    invokeCore.mockImplementation((command: string) => command === "browser_surface_update"
      ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve());
    await act(async () => { view.rerender(<NativeBrowserSurface {...props} active={false} />); });
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(invokeCore).toHaveBeenLastCalledWith("browser_surface_release", { leaseId: "lease-one" });
    const callsAfterUnmount = invokeCore.mock.calls.length;
    await act(async () => { finish(); });
    expect(invokeCore).toHaveBeenCalledTimes(callsAfterUnmount);
  });

  it("resynchronizes when an existing element becomes a native overlay without a layout event", async () => {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-test-native-overlay", "");
    document.body.append(overlay);
    render(<NativeBrowserSurface {...props} />);
    await attached();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { overlay.setAttribute("data-native-surface-overlay", "true"); });
    await waitFor(() => expect(invokeCore).toHaveBeenLastCalledWith("browser_surface_update", expect.objectContaining({ visible: false })));
    await act(async () => { overlay.removeAttribute("data-native-surface-overlay"); });
    await waitFor(() => expect(invokeCore).toHaveBeenLastCalledWith("browser_surface_update", expect.objectContaining({ visible: true })));
  });

  it("listens before attachment and uses physical bounds without an iframe or proxy", async () => {
    vi.stubGlobal("devicePixelRatio", 2);
    render(<NativeBrowserSurface {...props} />);
    await attached();
    expect(listen).toHaveBeenCalledWith("omnia-browser-surface-navigation", expect.any(Function));
    expect(listen.mock.invocationCallOrder[0]).toBeLessThan(invokeCore.mock.invocationCallOrder[0]!);
    expect(invokeCore).toHaveBeenCalledWith("browser_surface_attach", {
      tabKey: "tab-one", url: "https://example.com/", bounds: { x: 40, y: 60, width: 1000, height: 700 },
    });
    expect(invokeCore).toHaveBeenCalledWith("browser_surface_update", expect.objectContaining({ leaseId: "lease-one", visible: true }));
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("hides inactive tabs and restores the same native document", async () => {
    const view = render(<NativeBrowserSurface {...props} />);
    await attached();
    view.rerender(<NativeBrowserSurface {...props} active={false} />);
    await waitFor(() => expect(invokeCore).toHaveBeenLastCalledWith("browser_surface_update", expect.objectContaining({ visible: false })));
    view.rerender(<NativeBrowserSurface {...props} />);
    await waitFor(() => expect(invokeCore).toHaveBeenLastCalledWith("browser_surface_update", expect.objectContaining({ visible: true })));
    expect(invokeCore.mock.calls.filter(([command]) => command === "browser_surface_attach")).toHaveLength(1);
    expect(invokeCore.mock.calls.filter(([command]) => command === "browser_surface_release")).toHaveLength(0);
  });

  it("ignores closed shell popover anchors and hides only for an open panel", async () => {
    const anchor = document.createElement("span");
    anchor.className = "ag-popover";
    anchor.setAttribute("data-test-native-overlay", "");
    document.body.append(anchor);
    render(<NativeBrowserSurface {...props} />);
    await attached();
    const panel = document.createElement("div");
    panel.className = "ag-popover__panel";
    panel.setAttribute("data-test-native-overlay", "");
    await act(async () => { document.body.append(panel); });
    await waitFor(() => expect(invokeCore).toHaveBeenLastCalledWith("browser_surface_update", expect.objectContaining({ visible: false })));
    await act(async () => { panel.remove(); });
    await waitFor(() => expect(invokeCore).toHaveBeenLastCalledWith("browser_surface_update", expect.objectContaining({ visible: true })));
  });

  it("hides the native surface under a root dialog and restores it after dismissal", async () => {
    render(<NativeBrowserSurface {...props} />);
    await attached();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    await act(async () => { document.body.append(dialog); });
    await waitFor(() => expect(invokeCore).toHaveBeenLastCalledWith("browser_surface_update", expect.objectContaining({ visible: false })));
    await act(async () => { dialog.remove(); });
    await waitFor(() => expect(invokeCore).toHaveBeenLastCalledWith("browser_surface_update", expect.objectContaining({ visible: true })));
  });

  it("hides a page when its parent route becomes inactive", async () => {
    render(<section data-testid="route"><NativeBrowserSurface {...props} /></section>);
    await attached();
    await act(async () => { screen.getByTestId("route").setAttribute("inert", ""); });
    await waitFor(() => expect(invokeCore).toHaveBeenLastCalledWith("browser_surface_update", expect.objectContaining({ visible: false })));
    await act(async () => { screen.getByTestId("route").removeAttribute("inert"); });
    await waitFor(() => expect(invokeCore).toHaveBeenLastCalledWith("browser_surface_update", expect.objectContaining({ visible: true })));
    expect(invokeCore.mock.calls.filter(([command]) => command === "browser_surface_attach")).toHaveLength(1);
  });

  it("releases an attachment which resolves after unmount", async () => {
    let finish!: (value: { leaseId: string }) => void;
    invokeCore.mockImplementation((command: string) => command === "browser_surface_attach"
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve());
    const view = render(<NativeBrowserSurface {...props} />);
    await waitFor(() => expect(invokeCore).toHaveBeenCalledWith("browser_surface_attach", expect.any(Object)));
    view.unmount();
    await act(async () => { finish({ leaseId: "late-lease" }); });
    expect(invokeCore).toHaveBeenCalledWith("browser_surface_release", { leaseId: "late-lease" });
    expect(invokeCore.mock.calls.some(([command]) => command === "browser_surface_update")).toBe(false);
    expect(stopListening).toHaveBeenCalledOnce();
    expect(stopShortcuts).toHaveBeenCalledOnce();
  });

  it("forwards only the active native lease's allowed shortcuts and cleans up its listener", async () => {
    const view = render(<NativeBrowserSurface {...props} />);
    await attached();
    const shortcut = { tabKey: "tab-one", leaseId: "lease-one", label: "omnia-browser-owned", epoch: 1, action: "focus-address" };
    await act(async () => { shortcuts.handler?.({ payload: shortcut }); });
    expect(onShortcut).toHaveBeenCalledWith("tab-one", "focus-address");
    for (const change of [{ tabKey: "another-tab" }, { leaseId: "stale-lease" }, { action: "arbitrary-command" }, { label: "main" }, { epoch: -1 }, { epoch: NaN }]) {
      await act(async () => { shortcuts.handler?.({ payload: { ...shortcut, ...change } }); });
    }
    view.rerender(<NativeBrowserSurface {...props} active={false} />);
    await act(async () => { shortcuts.handler?.({ payload: shortcut }); });
    expect(onShortcut).toHaveBeenCalledTimes(1);
    view.rerender(<NativeBrowserSurface {...props} />);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-test-native-overlay", "");
    await act(async () => { document.body.append(dialog); shortcuts.handler?.({ payload: shortcut }); });
    expect(onShortcut).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => { shortcuts.handler?.({ payload: shortcut }); });
    expect(onShortcut).toHaveBeenCalledTimes(1);
    expect(stopShortcuts).toHaveBeenCalledOnce();
  });

  it("uses the latest shortcut callback without replacing the native document", async () => {
    const view = render(<NativeBrowserSurface {...props} />);
    await attached();
    const latest = vi.fn();
    view.rerender(<NativeBrowserSurface {...props} onShortcut={latest} />);
    await act(async () => { shortcuts.handler?.({ payload: { tabKey: "tab-one", leaseId: "lease-one", label: "omnia-browser-owned", epoch: 1, action: "new-tab" } }); });
    expect(latest).toHaveBeenCalledWith("tab-one", "new-tab");
    expect(onShortcut).not.toHaveBeenCalled();
    expect(invokeCore.mock.calls.filter(([command]) => command === "browser_surface_attach")).toHaveLength(1);
  });

  it("navigates only a changed requested URL and does not echo native navigation", async () => {
    const view = render(<NativeBrowserSurface {...props} />);
    await attached();
    view.rerender(<NativeBrowserSurface {...props} url="https://example.org/new" />);
    await waitFor(() => expect(invokeCore).toHaveBeenCalledWith("browser_surface_navigate", { leaseId: "lease-one", url: "https://example.org/new" }));
    await act(async () => { navigation.handler?.({ payload: { tabKey: "tab-one", leaseId: "lease-one", url: "https://example.org/redirected", title: "Redirected" } }); });
    expect(onNavigation).toHaveBeenCalledWith("tab-one", "https://example.org/redirected", "Redirected");
    view.rerender(<NativeBrowserSurface {...props} url="https://example.org/redirected" />);
    await act(async () => { await Promise.resolve(); });
    expect(invokeCore.mock.calls.filter(([command]) => command === "browser_surface_navigate")).toHaveLength(1);
    await act(async () => { navigation.handler?.({ payload: { tabKey: "another-tab", url: "https://example.net/" } }); });
    await act(async () => { navigation.handler?.({ payload: { tabKey: "tab-one", url: "https://example.net/missing-lease" } }); });
    await act(async () => { navigation.handler?.({ payload: { tabKey: "tab-one", leaseId: "old-lease", url: "https://example.net/old" } }); });
    expect(onNavigation).toHaveBeenCalledTimes(1);
  });

  it("uses the typed native actions for keyboard focus and browser controls", async () => {
    render(<NativeBrowserSurface {...props} />);
    await attached();
    fireEvent.click(screen.getByRole("button", { name: "Focus page" }));
    await waitFor(() => expect(invokeCore).toHaveBeenCalledWith("browser_surface_action", { leaseId: "lease-one", action: "focus" }));
    const controller = onController.mock.calls.find(([, value]) => value)?.[1] as NativeBrowserController;
    await act(async () => { await controller.action("back"); await controller.action("reload"); await controller.action("devtools"); });
    for (const action of ["back", "reload", "devtools"]) expect(invokeCore).toHaveBeenCalledWith("browser_surface_action", { leaseId: "lease-one", action });
  });

  it("forwards valid policy receipts and ignores malformed success types", async () => {
    render(<NativeBrowserSurface {...props} />);
    await attached();
    await act(async () => {
      policy.handler?.({ payload: {
        receiptId: "browser_policy_valid",
        tabKey: "tab-one",
        leaseId: "lease-one",
        kind: "download-finished",
        url: "https://example.com/file.zip",
        success: true,
        reason: "Download request completed.",
        occurredAtMs: 1_735_000_000_000,
      } });
      policy.handler?.({ payload: {
        receiptId: "browser_policy_new-window",
        tabKey: "tab-one",
        leaseId: "lease-one",
        kind: "new-window-denied",
        url: "https://example.com/new-window",
        reason: "New windows are managed as Omnia browser tabs.",
        occurredAtMs: 1_735_000_000_001,
      } });
      policy.handler?.({ payload: {
        receiptId: "browser_policy_download-failed",
        tabKey: "tab-one",
        leaseId: "lease-one",
        kind: "download-finished",
        url: "https://example.com/file.zip",
        success: false,
        reason: "The native browser reported the download result.",
        occurredAtMs: 1_735_000_000_002,
      } });
      policy.handler?.({ payload: {
        receiptId: "browser_policy_malformed",
        tabKey: "tab-one",
        leaseId: "lease-one",
        kind: "download-finished",
        success: "true",
        reason: "Download request completed.",
        occurredAtMs: 1_735_000_000_000,
      } });
    });
    expect(onPolicyNotice).toHaveBeenCalledTimes(3);
    expect(onPolicyNotice).toHaveBeenCalledWith(expect.objectContaining({ receiptId: "browser_policy_valid", success: true }));
    expect(onPolicyNotice).toHaveBeenCalledWith(expect.objectContaining({ receiptId: "browser_policy_new-window", kind: "new-window-denied" }));
    expect(onPolicyNotice).toHaveBeenCalledWith(expect.objectContaining({ receiptId: "browser_policy_download-failed", success: false }));
  });

  it("forwards the persisted native zoom when an existing tab is reattached", async () => {
    invokeCore.mockImplementation(async (command: string) => command === "browser_surface_attach"
      ? { leaseId: "lease-one", url: "https://example.com/", zoomPercent: 125 }
      : undefined);
    render(<NativeBrowserSurface {...props} />);
    await attached();
    expect(onNavigation).toHaveBeenCalledWith("tab-one", "https://example.com/", undefined, undefined, 125);
  });

  it("rejects an out-of-range zoom in the native attach receipt", async () => {
    invokeCore.mockImplementation(async (command: string) => command === "browser_surface_attach"
      ? { leaseId: "lease-one", url: "https://example.com/", zoomPercent: 999 }
      : undefined);
    render(<NativeBrowserSurface {...props} />);
    expect(await screen.findByText("The page returned an invalid zoom level.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry page" })).toBeVisible();
  });

  it("accepts only lease-bound native capture receipts and forwards the bounded text", async () => {
    render(<NativeBrowserSurface {...props} />);
    await attached();
    const controller = onController.mock.calls.find(([, value]) => value)?.[1] as NativeBrowserController;
    invokeCore.mockImplementation((command: string) => command === "browser_surface_capture"
      ? Promise.resolve({
        receiptId: "browser_capture_receipt-one",
        tabKey: "tab-one",
        leaseId: "lease-one",
        url: "https://example.com/",
        title: "Example",
        mode: "page",
        text: "hello from the native page",
        contentSha256: "a".repeat(64),
        byteSize: 27,
        truncated: false,
        capturedAtMs: 1_735_000_000_000,
        source: "native-dom-text",
      })
      : Promise.resolve());
    await expect(controller.capture?.("page")).resolves.toMatchObject({
      leaseId: "lease-one",
      tabKey: "tab-one",
      text: "hello from the native page",
      source: "native-dom-text",
    });
    expect(invokeCore).toHaveBeenCalledWith("browser_surface_capture", { leaseId: "lease-one", mode: "page" });
  });

  it("rejects a capture receipt from a stale lease", async () => {
    render(<NativeBrowserSurface {...props} />);
    await attached();
    const controller = onController.mock.calls.find(([, value]) => value)?.[1] as NativeBrowserController;
    invokeCore.mockResolvedValue({
      receiptId: "browser_capture_receipt-stale",
      tabKey: "tab-one",
      leaseId: "old-lease",
      url: "https://example.com/",
      title: "Example",
      mode: "page",
      text: "stale",
      contentSha256: "a".repeat(64),
      byteSize: 5,
      truncated: false,
      capturedAtMs: 1_735_000_000_000,
      source: "native-dom-text",
    });
    await expect(controller.capture?.("page")).rejects.toThrow("invalid text capture receipt");
  });

  it("rejects malformed native capture receipts before they reach the browser copilot", async () => {
    render(<NativeBrowserSurface {...props} />);
    await attached();
    const controller = onController.mock.calls.find(([, value]) => value)?.[1] as NativeBrowserController;
    const valid = {
      receiptId: "browser_capture_receipt-valid",
      tabKey: "tab-one",
      leaseId: "lease-one",
      url: "https://example.com/",
      title: "Example",
      mode: "page" as const,
      text: "hello",
      contentSha256: "a".repeat(64),
      byteSize: 5,
      truncated: false,
      capturedAtMs: 1_735_000_000_000,
      source: "native-dom-text" as const,
    };
    for (const malformed of [
      { ...valid, receiptId: "capture-no-prefix" },
      { ...valid, contentSha256: "not-a-sha" },
      { ...valid, byteSize: 262145 },
      { ...valid, capturedAtMs: 0 },
      { ...valid, source: "iframe-text" as const },
      { ...valid, mode: "selection" as const },
    ]) {
      invokeCore.mockResolvedValue(malformed);
      await expect(controller.capture?.("page")).rejects.toThrow("invalid text capture receipt");
    }
  });

  it("surfaces native errors and explicitly retries the page", async () => {
    invokeCore.mockRejectedValueOnce({ message: "The page service is unavailable." });
    render(<NativeBrowserSurface {...props} />);
    expect(await screen.findByText("The page service is unavailable.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
    await attached();
    expect(invokeCore.mock.calls.filter(([command]) => command === "browser_surface_attach")).toHaveLength(2);
  });

  it("rejects unsupported page schemes and ignores malformed native events", async () => {
    expect(validNativeBrowserUrl("file:///C:/private.txt")).toBe(false);
    expect(validNativeBrowserUrl("javascript:alert(1)")).toBe(false);
    expect(validNativeBrowserUrl("https://user:password@example.com/")).toBe(false);
    expect(validNativeBrowserUrl("https://example.com/")).toBe(true);
    render(<NativeBrowserSurface {...props} url="file:///C:/private.txt" />);
    expect(await screen.findByText("Enter an HTTP or HTTPS page address.")).toBeVisible();
    expect(invokeCore).not.toHaveBeenCalled();
  });

  it("can navigate to a new valid address after an unsupported page fails", async () => {
    const view = render(<NativeBrowserSurface {...props} url="file:///C:/private.txt" />);
    expect(await screen.findByText("Enter an HTTP or HTTPS page address.")).toBeVisible();
    view.rerender(<NativeBrowserSurface {...props} />);
    await attached();
    expect(invokeCore).toHaveBeenCalledWith("browser_surface_attach", expect.objectContaining({ url: "https://example.com/" }));
  });

  it("preserves a newer requested address when an old initial navigation arrives during attachment", async () => {
    let finish!: (value: { leaseId: string; url: string }) => void;
    invokeCore.mockImplementation((command: string) => command === "browser_surface_attach"
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve());
    const view = render(<NativeBrowserSurface {...props} />);
    await waitFor(() => expect(invokeCore).toHaveBeenCalledWith("browser_surface_attach", expect.any(Object)));
    view.rerender(<NativeBrowserSurface {...props} url="https://example.org/requested" />);
    await act(async () => { navigation.handler?.({ payload: { tabKey: "tab-one", leaseId: "lease-one", url: "https://example.com/old-redirect" } }); });
    await act(async () => { finish({ leaseId: "lease-one", url: "https://example.com/old-redirect" }); });
    await attached();
    expect(onNavigation).not.toHaveBeenCalled();
    expect(invokeCore).toHaveBeenCalledWith("browser_surface_navigate", { leaseId: "lease-one", url: "https://example.org/requested" });
  });
});
