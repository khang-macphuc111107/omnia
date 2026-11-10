import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { serializeParameterSettings } from "./parameter-settings-contract";
import { ProfilePresetsWorkbench } from "./profile-presets-workbench";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("Profile Presets Workbench renderer preview", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("applies presets and exposes store-backed undo, redo, and reset", () => {
    render(<ProfilePresetsWorkbench />);

    const presetList = screen.getByRole("list", { name: "Generation presets" });
    fireEvent.click(within(presetList).getByRole("button", { name: /Creative/ }));
    expect(useWorkspaceStore.getState().parameters.temperature).toBe(1.1);
    expect(screen.getByRole("button", { name: "Undo profile parameter change" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Undo profile parameter change" }));
    expect(useWorkspaceStore.getState().parameters.temperature).toBe(0.7);
    fireEvent.click(screen.getByRole("button", { name: "Redo profile parameter change" }));
    expect(useWorkspaceStore.getState().parameters.temperature).toBe(1.1);

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(useWorkspaceStore.getState().parameters.temperature).toBe(0.7);
    expect(screen.getByRole("status")).toHaveTextContent(/reset to defaults/i);
  });

  it("captures and removes custom presets inside the renderer session", () => {
    useWorkspaceStore.getState().replaceParameters({ temperature: 0.35, maxOutputTokens: 7000 });
    render(<ProfilePresetsWorkbench />);

    fireEvent.change(screen.getByRole("textbox", { name: "Save a custom preset" }), {
      target: { value: "TypeScript reviewer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save preset" }));

    const presetList = screen.getByRole("list", { name: "Generation presets" });
    expect(within(presetList).getByRole("button", { name: "Apply TypeScript reviewer preset" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent(/saved for this renderer session/i);

    fireEvent.click(screen.getByRole("button", { name: "Remove TypeScript reviewer custom preset" }));
    expect(within(presetList).queryByRole("button", { name: "Apply TypeScript reviewer preset" })).not.toBeInTheDocument();
  });

  it("imports a validated profile bundle and keeps native persistence untouched", async () => {
    render(<ProfilePresetsWorkbench />);
    const imported = {
      ...useWorkspaceStore.getState().parameters,
      temperature: 0.25,
      topP: 0.8,
      maxOutputTokens: 9000,
      reasoningEffort: "high" as const,
    };
    const file = new File([
      serializeParameterSettings(imported, {
        scope: "profile",
        name: "Imported reviewer",
        exportedAt: "2026-09-17T00:00:00.000Z",
      }),
    ], "imported-reviewer.json", { type: "application/json" });

    fireEvent.change(screen.getByLabelText("Import profile parameter JSON"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(useWorkspaceStore.getState().parameters.temperature).toBe(0.25));
    expect(useWorkspaceStore.getState().parameters.maxOutputTokens).toBe(9000);
    expect(screen.getByRole("button", { name: "Apply Imported profile preset" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/parameter values changed in the renderer/i);
    expect(screen.getByText(/Native profile persistence.*planned contracts/i)).toBeInTheDocument();
  });
});
