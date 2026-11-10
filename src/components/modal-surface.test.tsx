import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModalSurface } from "./modal-surface";

function ModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open modal</button>
      {open ? (
        <ModalSurface
          className="test-modal"
          title="Create project"
          description="Project details"
          onClose={() => setOpen(false)}
        >
          <button type="button" data-dialog-initial-focus>First action</button>
          <button type="button">Last action</button>
        </ModalSurface>
      ) : null}
    </>
  );
}

function HiddenDescendantHarness() {
  return (
    <ModalSurface className="hidden-descendant-modal" ariaLabel="Visibility modal" onClose={() => undefined}>
      <button type="button" data-testid="visible-first">First</button>
      <div hidden><button type="button" data-testid="hidden-button">Hidden</button></div>
      <button type="button" data-testid="visible-last">Last</button>
    </ModalSurface>
  );
}

function StackedModalHarness() {
  const [baseOpen, setBaseOpen] = useState(false);
  const [nestedOpen, setNestedOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setBaseOpen(true)}>Open base</button>
      {baseOpen ? (
        <ModalSurface className="base-modal" ariaLabel="Base modal" onClose={() => setBaseOpen(false)}>
          <button type="button" onClick={() => setNestedOpen(true)}>Open nested</button>
        </ModalSurface>
      ) : null}
      {nestedOpen ? (
        <ModalSurface className="nested-modal" ariaLabel="Nested modal" onClose={() => setNestedOpen(false)}>
          <button type="button">Nested action</button>
        </ModalSurface>
      ) : null}
    </>
  );
}

describe("modal surface", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("owns accessible naming, initial focus, focus wrapping, and focus restoration", async () => {
    render(<ModalHarness />);
    const opener = screen.getByRole("button", { name: "Open modal" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Create project" });
    expect(dialog).toHaveAccessibleDescription("Project details");

    const first = screen.getByRole("button", { name: "First action" });
    const last = screen.getByRole("button", { name: "Last action" });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(first).toHaveFocus();

    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("keeps the surface inside the visual viewport and scrolls overflowing content", () => {
    render(
      <ModalSurface className="test-modal" ariaLabel="Tall modal" onClose={() => undefined}>
        <div data-testid="modal-content" style={{ height: "2000px" }}>Tall content</div>
      </ModalSurface>,
    );

    const dialog = screen.getByRole("dialog", { name: "Tall modal" });
    const scrim = dialog.parentElement!;
    expect(dialog.style.maxWidth).toBe("calc(100vw - 2 * 26px)");
    expect(dialog.style.maxHeight).toBe("calc(100dvh - 2 * 26px)");
    expect(dialog.style.overflow).toBe("auto");
    expect(scrim).toHaveStyle({ overflow: "auto", overscrollBehavior: "contain" });
  });
  it("only dismisses when the scrim itself is pressed", () => {
    render(<ModalHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open modal" }));

    const dialog = screen.getByRole("dialog");
    fireEvent.mouseDown(dialog);
    expect(dialog).toBeInTheDocument();

    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("excludes hidden descendants from the Tab sequence", () => {
    render(<HiddenDescendantHarness />);
    const first = screen.getByTestId("visible-first");
    const last = screen.getByTestId("visible-last");
    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(first).toHaveFocus();
  });

  it.each([
    ["editing host", <div key="editable" contentEditable data-testid="native-control" />],
    ["details summary", <details key="details"><summary data-testid="native-control">More</summary></details>],
    ["iframe", <iframe key="frame" title="Document preview" data-testid="native-control" />],
    ["audio controls", <audio key="audio" controls data-testid="native-control" />],
    ["video controls", <video key="video" controls data-testid="native-control" />],
  ])("keeps an implicit %s reachable after the first button", (_label, control) => {
    render(
      <ModalSurface className="native-controls-modal" ariaLabel="Native controls" onClose={() => undefined}>
        <button type="button">First action</button>
        {control}
      </ModalSurface>,
    );
    const first = screen.getByRole("button", { name: "First action" });
    const native = screen.getByTestId("native-control");
    const focus = vi.spyOn(native, "focus");
    first.focus();
    const forwardTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    first.dispatchEvent(forwardTab);
    // The browser must be allowed to enter the following native control.
    expect(forwardTab.defaultPrevented).toBe(false);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("honors positive tabindex order for initial focus and wrapping", async () => {
    render(
      <ModalSurface className="ordered-controls-modal" ariaLabel="Ordered controls" onClose={() => undefined}>
        <button type="button" tabIndex={2}>Second in sequence</button>
        <button type="button" tabIndex={1}>First in sequence</button>
        <button type="button">Last in sequence</button>
      </ModalSurface>,
    );
    const first = screen.getByRole("button", { name: "First in sequence" });
    const last = screen.getByRole("button", { name: "Last in sequence" });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
  });

  it("excludes negative, hidden, inert and disabled controls, and nested editing hosts", () => {
    render(
      <ModalSurface className="native-visibility-modal" ariaLabel="Native visibility" onClose={() => undefined}>
        <button type="button">First action</button>
        <details>
          <summary>Visible summary</summary>
          <button type="button">Closed details action</button>
          <summary>Later summary</summary>
        </details>
        <div contentEditable suppressContentEditableWarning data-testid="editing-host">
          <div contentEditable data-testid="nested-editable" />
        </div>
        <div contentEditable tabIndex={-1} data-testid="negative-editable" />
        <audio controls tabIndex={-1} />
        <input type="hidden" tabIndex={0} />
        <div inert><iframe title="Inert frame" /></div>
        <div aria-hidden="true"><video controls /></div>
        <fieldset disabled><input aria-label="Disabled field" /></fieldset>
      </ModalSurface>,
    );
    const first = screen.getByRole("button", { name: "First action" });
    const hostFocus = vi.spyOn(screen.getByTestId("editing-host"), "focus");
    const nestedFocus = vi.spyOn(screen.getByTestId("nested-editable"), "focus");
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(hostFocus).toHaveBeenCalledTimes(1);
    expect(nestedFocus).not.toHaveBeenCalled();
  });

  it("keeps the first summary reachable while excluding content in closed details", () => {
    render(
      <ModalSurface className="closed-details-modal" ariaLabel="Closed details" onClose={() => undefined}>
        <button type="button">First action</button>
        <details>
          <summary data-testid="summary">Details</summary>
          <button type="button">Hidden details action</button>
          <div contentEditable />
        </details>
      </ModalSurface>,
    );
    const first = screen.getByRole("button", { name: "First action" });
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(screen.getByTestId("summary")).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId("summary"), { key: "Tab" });
    expect(first).toHaveFocus();
  });

  it("does not add later summaries to the implicit Tab sequence", () => {
    render(
      <ModalSurface className="open-details-modal" ariaLabel="Open details" onClose={() => undefined}>
        <button type="button">First action</button>
        <details open>
          <summary data-testid="summary">First summary</summary>
          <summary>Later summary</summary>
        </details>
      </ModalSurface>,
    );
    const first = screen.getByRole("button", { name: "First action" });
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(screen.getByTestId("summary")).toHaveFocus();
  });

  it("lets a nested control consume Tab before applying the dialog boundary", () => {
    render(<ModalHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open modal" }));
    const last = screen.getByRole("button", { name: "Last action" });
    last.focus();
    document.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    fireEvent.keyDown(last, { key: "Tab" });
    expect(last).toHaveFocus();
  });

  it("lets a nested popover consume Escape before closing the modal", () => {
    render(<ModalHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open modal" }));
    const dialog = screen.getByRole("dialog", { name: "Create project" });
    const nestedEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    dialog.dispatchEvent(nestedEscape);
    expect(dialog).toBeInTheDocument();
  });

  it("only lets the topmost modal handle Escape", async () => {
    render(<StackedModalHarness />);
    const baseOpener = screen.getByRole("button", { name: "Open base" });
    baseOpener.focus();
    fireEvent.click(baseOpener);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const nestedOpener = screen.getByRole("button", { name: "Open nested" });
    fireEvent.click(nestedOpener);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Nested modal" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Base modal" })).toBeInTheDocument();
    expect(nestedOpener).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(baseOpener).toHaveFocus();
  });
});
