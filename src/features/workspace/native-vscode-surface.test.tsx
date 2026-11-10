import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";

const { invokeCore } = vi.hoisted(() => ({ invokeCore: vi.fn() }));
vi.mock("@/lib/desktop", () => ({ invokeCore }));

import {
  NativeVscodeSurface,
  nativeEditorBounds,
} from "./native-vscode-surface";

const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
): DOMRect => ({
  x,
  y,
  left: x,
  top: y,
  width,
  height,
  right: x + width,
  bottom: y + height,
  toJSON: () => ({}),
});
let viewportRect = rect(100, 80, 600, 400);
let resizes: ResizeObserverCallback[] = [];
let leaseNumber = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function commandCalls(command: string) {
  return invokeCore.mock.calls.filter(([name]) => name === command);
}

function notifyResize() {
  for (const callback of resizes) callback([], {} as ResizeObserver);
}

async function attached() {
  await waitFor(() =>
    expect(invokeCore).toHaveBeenCalledWith(
      "editor_surface_update",
      expect.objectContaining({ visible: true }),
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Focus editor" })).toBeEnabled(),
  );
}

function appendOverlay(role = "dialog") {
  const overlay = document.createElement("div");
  overlay.dataset.testOverlay = "true";
  overlay.setAttribute("role", role);
  document.body.appendChild(overlay);
  return overlay;
}

beforeEach(() => {
  viewportRect = rect(100, 80, 600, 400);
  resizes = [];
  leaseNumber = 0;
  invokeCore.mockReset();
  invokeCore.mockImplementation(async (command: string) =>
    command === "editor_surface_attach"
      ? { leaseId: `lease-${++leaseNumber}` }
      : undefined,
  );
  vi.stubGlobal("devicePixelRatio", 2);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizes.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.testid === "native-vscode-viewport") return viewportRect;
      if (this.dataset.testOverlay === "true") return rect(20, 20, 200, 100);
      return rect(0, 0, 0, 0);
    },
  );
});

afterEach(() => {
  cleanup();
  document
    .querySelectorAll("[data-test-overlay]")
    .forEach((element) => element.remove());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("NativeVscodeSurface", () => {
  it("resynchronizes when an existing element becomes a native overlay without a layout event", async () => {
    const overlay = document.createElement("div");
    overlay.dataset.testOverlay = "true";
    document.body.append(overlay);
    render(<NativeVscodeSurface revision="workspace-1" active />);
    await attached();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      overlay.setAttribute("data-native-surface-overlay", "true");
    });
    await waitFor(() =>
      expect(invokeCore).toHaveBeenLastCalledWith(
        "editor_surface_update",
        expect.objectContaining({ visible: false }),
      ),
    );
    await act(async () => {
      overlay.removeAttribute("data-native-surface-overlay");
    });
    await waitFor(() =>
      expect(invokeCore).toHaveBeenLastCalledWith(
        "editor_surface_update",
        expect.objectContaining({ visible: true }),
      ),
    );
  });

  it("attaches a native-owned folder with physical bounds and explicitly shows the lease", async () => {
    render(
      <NativeVscodeSurface
        folderId="editor_selected"
        revision="workspace-1"
        active
      />,
    );
    await attached();
    expect(invokeCore).toHaveBeenCalledWith("editor_surface_attach", {
      folderId: "editor_selected",
      bounds: { x: 200, y: 160, width: 1200, height: 800 },
      reconnect: false,
    });
    expect(invokeCore).toHaveBeenCalledWith("editor_surface_update", {
      leaseId: "lease-1",
      bounds: { x: 200, y: 160, width: 1200, height: 800 },
      visible: true,
    });
    expect(commandCalls("editor_surface_focus")).toHaveLength(0);
    expect(document.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Focus editor" }));
    expect(invokeCore).toHaveBeenCalledWith("editor_surface_focus", {
      leaseId: "lease-1",
    });
  });

  it("updates bounds after layout movement and coalesces unchanged observations", async () => {
    render(<NativeVscodeSurface revision="workspace-1" active />);
    await attached();
    const updateCount = commandCalls("editor_surface_update").length;
    await act(async () => {
      notifyResize();
      notifyResize();
    });
    expect(commandCalls("editor_surface_update")).toHaveLength(updateCount);
    viewportRect = rect(125, 100, 500, 320);
    await act(async () => {
      notifyResize();
    });
    expect(invokeCore).toHaveBeenLastCalledWith("editor_surface_update", {
      leaseId: "lease-1",
      bounds: { x: 250, y: 200, width: 1000, height: 640 },
      visible: true,
    });
  });

  it("hides and restores an inactive editor without reattaching its document", async () => {
    const view = render(<NativeVscodeSurface revision="workspace-1" active />);
    await attached();
    view.rerender(
      <NativeVscodeSurface revision="workspace-1" active={false} />,
    );
    await waitFor(() =>
      expect(invokeCore).toHaveBeenLastCalledWith(
        "editor_surface_update",
        expect.objectContaining({ leaseId: "lease-1", visible: false }),
      ),
    );
    expect(screen.getByTestId("native-vscode-surface")).toHaveAttribute(
      "hidden",
    );
    view.rerender(<NativeVscodeSurface revision="workspace-1" active />);
    await waitFor(() =>
      expect(invokeCore).toHaveBeenLastCalledWith(
        "editor_surface_update",
        expect.objectContaining({ leaseId: "lease-1", visible: true }),
      ),
    );
    expect(commandCalls("editor_surface_attach")).toHaveLength(1);
    expect(commandCalls("editor_surface_release")).toHaveLength(0);
  });

  it("hides behind root overlays and ignores overlays with hidden or inert ancestors", async () => {
    render(<NativeVscodeSurface revision="workspace-1" active />);
    await attached();
    const overlay = appendOverlay("menu");
    await waitFor(() =>
      expect(invokeCore).toHaveBeenLastCalledWith(
        "editor_surface_update",
        expect.objectContaining({ visible: false }),
      ),
    );
    overlay.hidden = true;
    await waitFor(() =>
      expect(invokeCore).toHaveBeenLastCalledWith(
        "editor_surface_update",
        expect.objectContaining({ visible: true }),
      ),
    );
    overlay.hidden = false;
    overlay.setAttribute("inert", "");
    await act(async () => {
      await Promise.resolve();
    });
    expect(invokeCore).toHaveBeenLastCalledWith(
      "editor_surface_update",
      expect.objectContaining({ visible: true }),
    );
    expect(commandCalls("editor_surface_attach")).toHaveLength(1);
  });

  it("ignores a closed popover anchor and hides only while its panel is mounted", async () => {
    const anchor = document.createElement("span");
    anchor.className = "ag-popover";
    anchor.dataset.testOverlay = "true";
    document.body.appendChild(anchor);
    render(<NativeVscodeSurface revision="workspace-1" active />);
    await attached();
    const panel = appendOverlay("group");
    panel.className = "ag-popover__panel";
    await waitFor(() =>
      expect(invokeCore).toHaveBeenLastCalledWith(
        "editor_surface_update",
        expect.objectContaining({ visible: false }),
      ),
    );
    panel.remove();
    await waitFor(() =>
      expect(invokeCore).toHaveBeenLastCalledWith(
        "editor_surface_update",
        expect.objectContaining({ visible: true }),
      ),
    );
  });

  it("hides when its parent route or document is hidden", async () => {
    const view = render(
      <section data-testid="route">
        <NativeVscodeSurface revision="workspace-1" active />
      </section>,
    );
    await attached();
    screen.getByTestId("route").setAttribute("aria-hidden", "true");
    await waitFor(() =>
      expect(invokeCore).toHaveBeenLastCalledWith(
        "editor_surface_update",
        expect.objectContaining({ visible: false }),
      ),
    );
    screen.getByTestId("route").removeAttribute("aria-hidden");
    await waitFor(() =>
      expect(invokeCore).toHaveBeenLastCalledWith(
        "editor_surface_update",
        expect.objectContaining({ visible: true }),
      ),
    );
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(invokeCore).toHaveBeenLastCalledWith(
        "editor_surface_update",
        expect.objectContaining({ visible: false }),
      ),
    );
    view.unmount();
    expect(invokeCore).toHaveBeenCalledWith("editor_surface_release", {
      leaseId: "lease-1",
    });
  });

  it("rechecks overlays after asynchronous attach before showing the native view", async () => {
    const pending = deferred<{ leaseId: string }>();
    invokeCore.mockImplementation(async (command: string) =>
      command === "editor_surface_attach" ? pending.promise : undefined,
    );
    render(<NativeVscodeSurface revision="workspace-1" active />);
    expect(commandCalls("editor_surface_attach")).toHaveLength(1);
    appendOverlay();
    await act(async () => {
      pending.resolve({ leaseId: "late-lease" });
    });
    expect(commandCalls("editor_surface_update")).toEqual([
      [
        "editor_surface_update",
        expect.objectContaining({ leaseId: "late-lease", visible: false }),
      ],
    ]);
  });

  it("serializes StrictMode reattachment behind the retired asynchronous native attach", async () => {
    const pending = deferred<{ leaseId: string }>();
    let attaches = 0;
    invokeCore.mockImplementation(async (command: string) => {
      if (command !== "editor_surface_attach") return undefined;
      attaches += 1;
      return attaches === 1 ? pending.promise : { leaseId: "current-lease" };
    });
    render(
      <StrictMode>
        <NativeVscodeSurface revision="workspace-1" active />
      </StrictMode>,
    );
    expect(commandCalls("editor_surface_attach")).toHaveLength(1);
    await act(async () => {
      pending.resolve({ leaseId: "retired-lease" });
    });
    await attached();
    expect(commandCalls("editor_surface_attach")).toHaveLength(2);
    expect(invokeCore).toHaveBeenCalledWith("editor_surface_release", {
      leaseId: "retired-lease",
    });
    expect(
      commandCalls("editor_surface_update").every(
        (call) => call[1].leaseId === "current-lease",
      ),
    ).toBe(true);
  });

  it("releases an attach that finishes after unmount without showing or focusing it", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ leaseId: string }>();
    invokeCore.mockImplementation(async (command: string) =>
      command === "editor_surface_attach" ? pending.promise : undefined,
    );
    const view = render(<NativeVscodeSurface revision="workspace-1" active />);
    expect(commandCalls("editor_surface_attach")).toHaveLength(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      pending.resolve({ leaseId: "late-lease" });
    });
    expect(commandCalls("editor_surface_release")).toEqual([
      ["editor_surface_release", { leaseId: "late-lease" }],
    ]);
    expect(commandCalls("editor_surface_update")).toHaveLength(0);
    expect(commandCalls("editor_surface_focus")).toHaveLength(0);
  });

  it("releases the old lease when workspace selection changes and keeps updates scoped to the new lease", async () => {
    const view = render(
      <NativeVscodeSurface
        folderId="editor_one"
        revision="workspace-1"
        active
      />,
    );
    await attached();
    view.rerender(
      <NativeVscodeSurface
        folderId="editor_two"
        revision="workspace-2"
        active
      />,
    );
    await waitFor(() =>
      expect(invokeCore).toHaveBeenCalledWith(
        "editor_surface_update",
        expect.objectContaining({ leaseId: "lease-2", visible: true }),
      ),
    );
    expect(invokeCore).toHaveBeenCalledWith("editor_surface_release", {
      leaseId: "lease-1",
    });
    expect(commandCalls("editor_surface_attach")).toHaveLength(2);
    expect(commandCalls("editor_surface_attach")[1]?.[1]).toMatchObject({
      folderId: "editor_two",
      reconnect: false,
    });
  });

  it("reports attach errors and reconnects only after an explicit retry", async () => {
    invokeCore.mockRejectedValueOnce({
      message: "The editor window could not be created.",
    });
    render(<NativeVscodeSurface revision="workspace-1" active />);
    expect(
      await screen.findByText("The editor window could not be created."),
    ).toBeVisible();
    expect(commandCalls("editor_surface_update")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry editor view" }));
    await attached();
    expect(commandCalls("editor_surface_attach")[1]?.[1]).toMatchObject({
      reconnect: true,
    });
  });

  it("consumes reconnect once per connection epoch and does not reload on later workspace revisions", async () => {
    const view = render(
      <NativeVscodeSurface
        revision="workspace-1"
        reconnect
        reconnectEpoch={1}
        active
      />,
    );
    await attached();
    view.rerender(
      <NativeVscodeSurface
        revision="workspace-2"
        reconnect
        reconnectEpoch={1}
        active
      />,
    );
    await waitFor(() =>
      expect(commandCalls("editor_surface_attach")).toHaveLength(2),
    );
    expect(commandCalls("editor_surface_attach")[0]?.[1]).toMatchObject({
      reconnect: true,
    });
    expect(commandCalls("editor_surface_attach")[1]?.[1]).toMatchObject({
      reconnect: false,
    });
  });

  it("releases and reports failed native updates instead of leaving a live surface over the error", async () => {
    invokeCore.mockImplementation(async (command: string) => {
      if (command === "editor_surface_attach") return { leaseId: "lease-1" };
      if (command === "editor_surface_update")
        throw { message: "The editor view is unavailable." };
      return undefined;
    });
    render(<NativeVscodeSurface revision="workspace-1" active />);
    expect(
      await screen.findByText("The editor view is unavailable."),
    ).toBeVisible();
    expect(invokeCore).toHaveBeenCalledWith("editor_surface_release", {
      leaseId: "lease-1",
    });
    expect(screen.getByRole("button", { name: "Focus editor" })).toBeDisabled();
  });

  it("bounds an unresponsive attach and releases its eventual late lease", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ leaseId: string }>();
    invokeCore.mockImplementation(async (command: string) =>
      command === "editor_surface_attach" ? pending.promise : undefined,
    );
    render(<NativeVscodeSurface revision="workspace-1" active />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(
      screen.getByText(
        "The editor view did not respond. Retry the connection.",
      ),
    ).toBeVisible();
    await act(async () => {
      pending.resolve({ leaseId: "late-lease" });
    });
    expect(invokeCore).toHaveBeenCalledWith("editor_surface_release", {
      leaseId: "late-lease",
    });
    expect(commandCalls("editor_surface_update")).toHaveLength(0);
  });

  it("waits for measurable visible bounds before attaching", async () => {
    viewportRect = rect(100, 80, 0, 0);
    render(<NativeVscodeSurface revision="workspace-1" active />);
    expect(commandCalls("editor_surface_attach")).toHaveLength(0);
    viewportRect = rect(100, 80, 600, 400);
    await act(async () => {
      notifyResize();
    });
    await attached();
  });
});

describe("nativeEditorBounds", () => {
  it("clips to the viewport, rounds physical edges consistently, and rejects invalid geometry", () => {
    const element = document.createElement("div");
    element.dataset.testid = "native-vscode-viewport";
    viewportRect = rect(-20, -10, 150, 100);
    vi.stubGlobal("devicePixelRatio", 1.25);
    expect(nativeEditorBounds(element)).toEqual({
      x: 0,
      y: 0,
      width: 163,
      height: 113,
    });
    viewportRect = rect(Number.NaN, 0, 100, 100);
    expect(nativeEditorBounds(element)).toBeNull();
    viewportRect = rect(2000, 0, 100, 100);
    expect(nativeEditorBounds(element)).toBeNull();
  });
});
