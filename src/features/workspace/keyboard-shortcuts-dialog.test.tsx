import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KeyboardShortcutsDialog } from "./keyboard-shortcuts-dialog";
import { resolveSessionShortcut, setSessionShortcutOverrides } from "./keyboard-shortcut-session";

describe("keyboard shortcuts dialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    setSessionShortcutOverrides({});
  });

  it("shows the current renderer shortcuts and closes from the footer", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsDialog onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByText("Open commands and navigation")).toBeInTheDocument();
    expect(screen.getByLabelText("Shortcut: Ctrl plus K")).toBeInTheDocument();
    expect(screen.getByText(/Composer and native\/global shortcut registration remain separately gated/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("supports renderer-local shortcut customization and reset", () => {
    render(<KeyboardShortcutsDialog onClose={vi.fn()} />);

    const customize = screen.getByRole("button", { name: "Customize shortcut for Open commands and navigation" });
    fireEvent.click(customize);
    fireEvent.keyDown(customize, { key: "j", ctrlKey: true });

    expect(screen.getByLabelText("Shortcut: Ctrl plus J")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/uses Ctrl \+ J.*renderer tab/i);
    expect(resolveSessionShortcut(new KeyboardEvent("keydown", { key: "j", ctrlKey: true })))
      .toEqual({ kind: "command", id: "open-commands" });

    fireEvent.click(screen.getByRole("button", { name: "Reset defaults" }));
    expect(screen.getByLabelText("Shortcut: Ctrl plus K")).toBeInTheDocument();
  });

  it("reports shortcut conflicts without claiming native registration", () => {
    render(<KeyboardShortcutsDialog onClose={vi.fn()} />);

    const customize = screen.getByRole("button", { name: "Customize shortcut for Start a new Chat" });
    fireEvent.click(customize);
    fireEvent.keyDown(customize, { key: "k", ctrlKey: true });

    expect(screen.getByRole("status")).toHaveTextContent(/conflict: already used by Open commands and navigation/i);
    expect(screen.getByText("Conflicts with Open commands and navigation")).toBeInTheDocument();
    expect(screen.getByText("1 conflict")).toBeInTheDocument();
    expect(screen.getByText(/Composer and native\/global shortcut registration remain separately gated/i)).toBeInTheDocument();
  });

  it("supports Escape cancellation and clearing a customized shortcut", () => {
    render(<KeyboardShortcutsDialog onClose={vi.fn()} />);

    const customize = screen.getByRole("button", { name: "Customize shortcut for Open commands and navigation" });
    fireEvent.click(customize);
    fireEvent.keyDown(customize, { key: "j", ctrlKey: true });
    expect(screen.getByLabelText("Shortcut: Ctrl plus J")).toBeInTheDocument();

    const clear = screen.getByRole("button", { name: "Clear shortcut for Open commands and navigation" });
    fireEvent.click(clear);
    expect(screen.getByLabelText("Shortcut: Ctrl plus K")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear shortcut for Open commands and navigation" })).not.toBeInTheDocument();

    const customizeAgain = screen.getByRole("button", { name: "Customize shortcut for Open commands and navigation" });
    fireEvent.click(customizeAgain);
    fireEvent.keyDown(customizeAgain, { key: "x", ctrlKey: true });
    expect(screen.getByLabelText("Shortcut: Ctrl plus X")).toBeInTheDocument();

    const editingTrigger = screen.getByRole("button", { name: "Customize shortcut for Open commands and navigation" });
    fireEvent.click(editingTrigger);
    const editing = screen.getByRole("button", { name: "Stop editing shortcut for Open commands and navigation" });
    fireEvent.keyDown(editing, { key: "Escape" });
    expect(screen.getByLabelText("Shortcut: Ctrl plus X")).toBeInTheDocument();
  });

  it("undoes and redoes shortcut drafts, including reset to defaults", () => {
    render(<KeyboardShortcutsDialog onClose={vi.fn()} />);
    const customize = screen.getByRole("button", { name: "Customize shortcut for Open commands and navigation" });
    fireEvent.click(customize);
    fireEvent.keyDown(customize, { key: "j", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Reset defaults" }));
    expect(screen.getByLabelText("Shortcut: Ctrl plus K")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByLabelText("Shortcut: Ctrl plus J")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(screen.getByLabelText("Shortcut: Ctrl plus K")).toBeInTheDocument();
  });

  it("imports a bounded preview bundle and rejects unknown shortcut IDs without changing state", () => {
    render(<KeyboardShortcutsDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Import / export shortcut preview"));
    const input = screen.getByLabelText("Shortcut JSON bundle");
    fireEvent.change(input, { target: { value: JSON.stringify({ schema: "omnia.keyboard-shortcuts.preview.v1", overrides: { "open-commands": ["Ctrl", "J"] } }) } });
    fireEvent.click(screen.getByRole("button", { name: "Import JSON preview" }));
    expect(screen.getByLabelText("Shortcut: Ctrl plus J")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/supported renderer commands now use these keys/i);
    fireEvent.change(input, { target: { value: JSON.stringify({ schema: "omnia.keyboard-shortcuts.preview.v1", overrides: { "unknown-shortcut": ["Ctrl", "T"] } }) } });
    fireEvent.click(screen.getByRole("button", { name: "Import JSON preview" }));
    expect(screen.getByLabelText("Shortcut: Ctrl plus J")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Invalid shortcut override/i);
  });

  it("keeps global command customization across closing and reopening the dialog", () => {
    const view = render(<KeyboardShortcutsDialog onClose={vi.fn()} />);
    const customize = screen.getByRole("button", { name: "Customize shortcut for Open commands and navigation" });
    fireEvent.click(customize);
    fireEvent.keyDown(customize, { key: "j", ctrlKey: true });
    view.unmount();
    render(<KeyboardShortcutsDialog onClose={vi.fn()} />);
    expect(screen.getByLabelText("Shortcut: Ctrl plus J")).toBeInTheDocument();
  });

  it("applies workflow presets through the renderer-local history", () => {
    render(<KeyboardShortcutsDialog onClose={vi.fn()} />);

    expect(screen.getByRole("combobox", { name: "Shortcut preset" })).toHaveValue("default");
    fireEvent.change(screen.getByRole("combobox", { name: "Shortcut preset" }), { target: { value: "coder" } });

    expect(screen.getByRole("combobox", { name: "Shortcut preset" })).toHaveValue("coder");
    expect(screen.getByLabelText("Shortcut: Ctrl plus P")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/coder shortcut preset applied/i);

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("combobox", { name: "Shortcut preset" })).toHaveValue("default");
    expect(screen.getByLabelText("Shortcut: Ctrl plus Shift plus F")).toBeInTheDocument();
  });

  it("returns to a custom draft label after a manual preset adjustment", () => {
    render(<KeyboardShortcutsDialog onClose={vi.fn()} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Shortcut preset" }), { target: { value: "research" } });
    const customize = screen.getByRole("button", { name: "Customize shortcut for Open commands and navigation" });
    fireEvent.click(customize);
    fireEvent.keyDown(customize, { key: "j", ctrlKey: true });

    expect(screen.getByRole("combobox", { name: "Shortcut preset" })).toHaveValue("custom");
    expect(screen.getByText(/Manual changes are kept in this renderer tab/i)).toBeInTheDocument();
  });
});
