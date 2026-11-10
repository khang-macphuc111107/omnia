import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import WorkspacePresetLab from "./workspace-preset-lab";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("WorkspacePresetLab renderer preview", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("uses monochrome SVG category and catalog icons instead of font glyphs", () => {
    const { container } = render(<WorkspacePresetLab />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(7);
    for (const tab of tabs) {
      expect(tab.textContent).not.toMatch(/[\p{Extended_Pictographic}☆✦●⌘◆◌◇◈⇧]/u);
      const icon = tab.querySelector("svg");
      expect(icon).toHaveAttribute("stroke", "currentColor");
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect(icon).toHaveAttribute("width", "14");
    }
    for (const mark of container.querySelectorAll(".workspace-preset-card__icon")) {
      expect(mark.textContent).toBe("");
      expect(mark.querySelector("svg")).toHaveAttribute("width", "16");
    }
  });

  it("filters categories, selects presets, and compares values", () => {
    render(<WorkspacePresetLab />);
    expect(screen.getByRole("heading", { name: "Workspace Preset Lab" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Appearance/ }));
    expect(screen.getByRole("button", { name: "Select Build Amber preset" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select Build Amber preset" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Compare selected preset with" }), { target: { value: "workspace-coder" } });
    expect(screen.getByRole("region", { name: "Selected workspace preset detail" })).toHaveTextContent(/Compare values/);
  });

  it("saves and removes a custom session preset with undo/redo", () => {
    render(<WorkspacePresetLab />);
    fireEvent.change(screen.getByRole("textbox", { name: "Custom preset name" }), { target: { value: "TS reviewer" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Custom preset tags" }), { target: { value: "typescript, review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save from selected" }));
    expect(screen.getByRole("button", { name: "Select TS reviewer preset" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo workspace preset change" }));
    expect(screen.queryByRole("button", { name: "Select TS reviewer preset" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Redo workspace preset change" }));
    expect(screen.getByRole("button", { name: "Select TS reviewer preset" })).toBeInTheDocument();
  });

  it("shows a renderer-session lifecycle timeline and keeps clearing it separate from catalog reset", () => {
    render(<WorkspacePresetLab />);
    const history = screen.getByRole("region", { name: "Preset lifecycle history" });
    expect(history).toHaveTextContent(/Preset catalog initialized from built-in defaults/);

    fireEvent.change(screen.getByRole("textbox", { name: "Custom preset name" }), { target: { value: "Timeline desk" } });
    fireEvent.click(screen.getByRole("button", { name: "Save from selected" }));
    expect(history).toHaveTextContent(/Timeline desk saved as a renderer-local custom preset/);

    fireEvent.click(screen.getByRole("button", { name: "Undo workspace preset change" }));
    expect(history).toHaveTextContent(/Undid the last workspace preset change/);
    fireEvent.click(screen.getByRole("button", { name: "Redo workspace preset change" }));
    expect(history).toHaveTextContent(/Reapplied the next workspace preset change/);

    fireEvent.click(screen.getByRole("button", { name: "Clear workspace preset lifecycle history" }));
    expect(history).toHaveTextContent(/No lifecycle events retained/);
    expect(screen.getByRole("button", { name: "Select Timeline desk preset" })).toBeInTheDocument();
  });

  it("opens a truthful portable export preview", () => {
    render(<WorkspacePresetLab />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect bundle" }));
    expect(screen.getByLabelText("Workspace preset bundle payload")).toHaveTextContent(/omnia\.workspace-preset-preview\.v1/);
    expect(screen.getByText(/no durable write/i)).toBeInTheDocument();
  });

  it("stages a valid import before applying it", async () => {
    render(<WorkspacePresetLab />);
    const bundle = JSON.stringify({
      schema: "omnia.workspace-preset-preview.v1",
      version: 1,
      generatedAt: "2026-09-21T00:00:00.000Z",
      scope: "renderer-session",
      selectedPresetId: "imported",
      presets: [{
        id: "imported",
        name: "Imported desk",
        kind: "project",
        description: "Imported",
        tags: ["imported"],
        updatedAt: "2026-09-21T00:00:00.000Z",
        values: { Route: "Quality first" },
        status: "preview",
        source: "session",
      }],
      boundary: { rendererOnly: true, noDurableWrite: true, noProviderRequest: true, noPermissionGrant: true },
    });
    const file = new File([bundle], "preset.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("Import workspace preset bundle"), { target: { files: [file] } });
    expect(await screen.findByRole("heading", { name: /1 preset staged/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply to renderer session" }));
    expect(screen.getByRole("button", { name: "Select Imported desk preset" })).toBeInTheDocument();
  });

  it("previews conflicts and can skip a matching built-in without mutating it", async () => {
    render(<WorkspacePresetLab />);
    const bundle = JSON.stringify({
      schema: "omnia.workspace-preset-preview.v1",
      version: 1,
      generatedAt: "2026-09-21T00:00:00.000Z",
      scope: "renderer-session",
      selectedPresetId: "conflicting",
      presets: [{
        id: "conflicting",
        name: "Coder cockpit",
        kind: "workspace",
        description: "Imported replacement candidate",
        tags: ["imported"],
        updatedAt: "2026-09-21T00:00:00.000Z",
        values: { Theme: "Ink" },
        status: "preview",
        source: "imported",
      }],
      boundary: { rendererOnly: true, noDurableWrite: true, noProviderRequest: true, noPermissionGrant: true },
    });
    const file = new File([bundle], "conflict.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("Import workspace preset bundle"), { target: { files: [file] } });
    expect(await screen.findByText(/1 conflict detected/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Workspace preset import conflict policy" }), { target: { value: "skip-duplicates" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply to renderer session" }));
    expect(screen.getByRole("status")).toHaveTextContent(/skipped 1/i);
    expect(screen.getAllByRole("button", { name: "Select Coder cockpit preset" })).toHaveLength(1);
  });
});
