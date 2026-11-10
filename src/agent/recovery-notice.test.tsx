import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecoveryNotice } from "./recovery-notice";
import { emptyLive } from "./transcript";
import { ConfirmDialog, Popover } from "./ui";

const recovery = () => ({ ...emptyLive(), recoveryRequired: true, unknownSideEffects: ["tool/" + "x".repeat(300)] });

describe("RecoveryNotice", () => {
  it("requires review and reports failures without losing the retry action", async () => {
    const onFork = vi.fn().mockRejectedValue(new Error("offline"));
    render(<RecoveryNotice live={recovery()} onFork={onFork} />);
    const button = screen.getByRole("button", { name: "Fork after reconciliation" });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not fork: offline");
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
  });

  it("prevents duplicate submissions and invalidates review when recovery changes", async () => {
    let resolve!: () => void;
    const onFork = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const live = recovery();
    const { rerender } = render(<RecoveryNotice live={live} onFork={onFork} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button"));
    expect(onFork).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Creating a fork");
    await act(async () => { resolve(); });
    rerender(<RecoveryNotice live={{ ...live, unknownSideEffects: ["another tool"] }} onFork={onFork} />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button")).toBeDisabled();
  });
});

describe("shared UI keyboard and viewport behavior", () => {
  function Example() {
    return <><Popover label="Actions" trigger="Open" placement="down">{(close) => <div role="menu">
      <button role="menuitem" onClick={close}>First</button>
      <button role="menuitem" onClick={close}>Second</button>
    </div>}</Popover><button>After</button></>;
  }

  it("portals outside clipping ancestors and supports arrows, Escape and focus return", () => {
    const { container } = render(<Example />);
    const trigger = screen.getByRole("button", { name: "Actions" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const panel = screen.getByRole("group", { name: "Actions" });
    expect(container).not.toContainElement(panel);
    expect(trigger).toHaveAttribute("aria-controls", panel.id);
    expect(panel.style.position).toBe("fixed");
    expect(panel.style.minWidth).toBe("0");
    const first = screen.getByRole("menuitem", { name: "First" });
    const second = screen.getByRole("menuitem", { name: "Second" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "Escape" });
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("tabs out in logical trigger order and does not steal outside focus", () => {
    render(<Example />);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    const second = screen.getByRole("menuitem", { name: "Second" });
    second.focus();
    fireEvent.keyDown(second, { key: "Tab" });
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    act(() => { screen.getByRole("button", { name: "After" }).focus(); });
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("clamps the panel to a narrow viewport and flips when space below is insufficient", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 290, y: 690, left: 290, right: 310, top: 690, bottom: 710, width: 20, height: 20, toJSON() {},
    });
    const height = vi.spyOn(window, "innerHeight", "get").mockReturnValue(720);
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200);
    const width = vi.spyOn(window, "innerWidth", "get").mockReturnValue(320);
    render(<Example />);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    const panel = screen.getByRole("group");
    expect(parseFloat(panel.style.left) + parseFloat(panel.style.width)).toBeLessThanOrEqual(312);
    expect(panel.style.overflow).toBe("auto");
    expect(parseFloat(panel.style.top)).toBeLessThan(690);
    rect.mockRestore();
    height.mockRestore();
    scrollHeight.mockRestore();
    width.mockRestore();
  });

  it("describes confirmations and initially focuses the safe cancel action", async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Delete" body="Cannot undo" confirmLabel="Delete forever" onCancel={onCancel} onConfirm={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription("Cannot undo");
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
