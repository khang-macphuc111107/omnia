import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PaletteHarmonyLab } from "./palette-harmony-lab";

describe("PaletteHarmonyLab", () => {
  it("renders a varied four-role recipe and keeps the boundary explicit", () => {
    render(<PaletteHarmonyLab seedColor="#23C6B8" onApply={vi.fn()} />);

    expect(screen.getByRole("heading", { name: /Generate a richer role palette/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Palette harmony family" })).toHaveValue("split-complementary");
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText(/Renderer-local color math and preview only/i)).toBeInTheDocument();
  });

  it("updates harmony settings and applies generated role colors", () => {
    const onApply = vi.fn();
    render(<PaletteHarmonyLab seedColor="#23C6B8" onApply={onApply} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Palette harmony family" }), { target: { value: "triadic" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Palette harmony temperature" }), { target: { value: "warm" } });
    fireEvent.click(screen.getByRole("button", { name: /Apply roles/i }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]?.[0]).toHaveLength(4);
    expect(screen.getByText(/Triadic harmony applied/i)).toHaveAttribute("aria-live", "polite");
  });

  it("rejects malformed seeds without applying a recipe", () => {
    const onApply = vi.fn();
    render(<PaletteHarmonyLab seedColor="#23C6B8" onApply={onApply} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Harmony seed color hex" }), { target: { value: "teal" } });
    fireEvent.click(screen.getByRole("button", { name: /Apply roles/i }));

    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText(/six-digit hex seed/i)).toHaveAttribute("aria-live", "polite");
  });
});
