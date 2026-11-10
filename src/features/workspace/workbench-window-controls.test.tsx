import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  minimize: vi.fn<() => Promise<void>>(),
  toggleMaximize: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
  getCurrentWindow: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: native.getCurrentWindow,
}));

import { WorkbenchWindowControls } from "./workbench-window-controls";

describe("WorkbenchWindowControls", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    native.getCurrentWindow.mockReturnValue(native);
    native.minimize.mockResolvedValue(undefined);
    native.toggleMaximize.mockResolvedValue(undefined);
    native.close.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
  });

  it("does not expose inert OS window controls in the web preview", () => {
    render(<WorkbenchWindowControls />);

    expect(screen.queryByRole("group", { name: "Window controls" })).not.toBeInTheDocument();
    expect(native.getCurrentWindow).not.toHaveBeenCalled();
  });

  it("dispatches all three controls to the current native window", async () => {
    window.__TAURI_INTERNALS__ = {};
    render(<WorkbenchWindowControls />);

    const controls = screen.getByRole("group", { name: "Window controls" });
    expect(within(controls).getAllByRole("button")).toHaveLength(3);
    expect(controls.querySelectorAll("svg[aria-hidden='true']")).toHaveLength(3);
    expect(native.getCurrentWindow).not.toHaveBeenCalled();

    for (const [label, operation] of [
      ["Minimize", native.minimize],
      ["Maximize or restore", native.toggleMaximize],
      ["Close", native.close],
    ] as const) {
      fireEvent.click(within(controls).getByRole("button", { name: label }));
      await waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(controls).toHaveAttribute("aria-busy", "false"));
    }

    expect(native.getCurrentWindow).toHaveBeenCalledTimes(3);
  });

  it("keeps controls pending until the native operation finishes", async () => {
    window.__TAURI_INTERNALS__ = {};
    let finish: (() => void) | undefined;
    native.minimize.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<WorkbenchWindowControls />);

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    await waitFor(() => expect(native.minimize).toHaveBeenCalledTimes(1));
    for (const button of within(screen.getByRole("group", { name: "Window controls" })).getAllByRole("button")) {
      expect(button).toBeDisabled();
    }

    finish?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "Minimize" })).toBeEnabled());
  });

  it("surfaces native permission failures without an unhandled promise", async () => {
    window.__TAURI_INTERNALS__ = {};
    native.close.mockRejectedValue(new Error("Window close permission denied"));
    render(<WorkbenchWindowControls />);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Window action failed: Window close permission denied");
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss window control error" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not bubble double clicks into a draggable parent titlebar", () => {
    window.__TAURI_INTERNALS__ = {};
    const onDoubleClick = vi.fn();
    render(<div onDoubleClick={onDoubleClick}><WorkbenchWindowControls /></div>);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Maximize or restore" }));
    expect(onDoubleClick).not.toHaveBeenCalled();
  });
});
