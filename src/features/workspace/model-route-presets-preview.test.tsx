import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { initialProviders } from "./mock-data";
import { ModelRoutePresetsPreview } from "./model-route-presets-preview";

describe("ModelRoutePresetsPreview", () => {
  it("shows a varied route preset library and keeps draft edits local until applied", () => {
    const onApplyPreset = vi.fn();
    render(<ModelRoutePresetsPreview providers={initialProviders} modelProfileId="auto" onApplyPreset={onApplyPreset} />);

    expect(screen.getByRole("heading", { name: "Model route presets" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Model route presets" })).toHaveTextContent("Coder · Fast");
    expect(screen.getByRole("list", { name: "Model route presets" })).toHaveTextContent("Research · Grounded");
    expect(screen.getByRole("list", { name: "Model route presets" })).toHaveTextContent("Private · Local");

    fireEvent.change(screen.getByRole("combobox", { name: "Preset context delivery" }), { target: { value: "manifest-only" } });
    expect(onApplyPreset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply model route preset draft" }));
    expect(onApplyPreset).toHaveBeenCalledWith(expect.objectContaining({ contextMode: "manifest-only", modelProfileId: "auto" }));
  });

  it("saves and removes a custom route preset and supports reversible draft changes", () => {
    render(<ModelRoutePresetsPreview providers={initialProviders} modelProfileId="auto" onApplyPreset={() => undefined} />);

    const effort = screen.getByRole("combobox", { name: "Preset reasoning effort" });
    fireEvent.change(effort, { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Undo route preset edit" }));
    expect(effort).toHaveValue("auto");
    fireEvent.click(screen.getByRole("button", { name: "Redo route preset edit" }));
    expect(effort).toHaveValue("high");

    fireEvent.change(screen.getByRole("textbox", { name: "Model route preset name" }), { target: { value: "CSE deep review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
    expect(screen.getByRole("button", { name: "Edit CSE deep review route preset" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove CSE deep review route preset" }));
    expect(screen.queryByRole("button", { name: "Edit CSE deep review route preset" })).not.toBeInTheDocument();
  });

  it("exports preview boundaries and requires explicit review before adding imports", () => {
    render(<ModelRoutePresetsPreview providers={initialProviders} modelProfileId="auto" onApplyPreset={() => undefined} />);

    expect(screen.getByLabelText("Model route preset export preview")).toHaveTextContent("omnia.model-route-preset-preview.v1");
    expect(screen.getByLabelText("Model route preset export preview")).toHaveTextContent("No provider request, fallback attempt, or context freeze was dispatched");

    const source = JSON.parse(screen.getByLabelText("Model route preset export preview").textContent ?? "{}") as Record<string, unknown>;
    const importArea = screen.getByRole("textbox", { name: "Model route preset JSON import" });
    fireEvent.change(importArea, { target: { value: JSON.stringify(source) } });
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    expect(screen.getByText(/Rename duplicate preset names/i)).toBeInTheDocument();

    const uniquePayload = {
      ...source,
      presets: (source.presets as Array<Record<string, unknown>>).slice(0, 1).map((preset) => ({ ...preset, name: "Imported General" })),
    };
    fireEvent.change(importArea, { target: { value: JSON.stringify(uniquePayload) } });
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    expect(screen.getByRole("list", { name: "Reviewed model route presets" })).toHaveTextContent("Imported General");
    fireEvent.click(screen.getByRole("button", { name: "Add reviewed" }));
    expect(screen.getByRole("button", { name: "Edit Imported General route preset" })).toBeInTheDocument();
  });
});
