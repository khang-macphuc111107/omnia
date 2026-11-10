import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ThemePresetStudio from "./theme-preset-studio";

describe("ThemePresetStudio renderer preview", () => {
  it("filters and tunes a built-in preset with reversible history", () => {
    render(<ThemePresetStudio />);
    expect(screen.getByRole("heading", { name: "Compose a complete Omnia look" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select Coder Night theme preset" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Theme preset surface" }), { target: { value: "ink" } });
    expect(screen.getByRole("combobox", { name: "Theme preset surface" })).toHaveValue("ink");
    fireEvent.click(screen.getByRole("button", { name: "Undo theme preset change" }));
    expect(screen.getByRole("combobox", { name: "Theme preset surface" })).toHaveValue("graphite");
    fireEvent.click(screen.getByRole("button", { name: "Redo theme preset change" }));
    expect(screen.getByRole("combobox", { name: "Theme preset surface" })).toHaveValue("ink");
    fireEvent.change(screen.getByRole("textbox", { name: "Search theme presets" }), { target: { value: "terminal" } });
    expect(screen.getByRole("button", { name: "Select Terminal Mint theme preset" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Select Coder Night theme preset" })).not.toBeInTheDocument();
  });

  it("saves a session copy, compares it, and keeps the boundary visible", () => {
    render(<ThemePresetStudio />);
    fireEvent.change(screen.getByRole("textbox", { name: "Custom theme preset name" }), { target: { value: "My coding desk" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Custom theme preset tags" }), { target: { value: "typescript, local" } });
    fireEvent.click(screen.getByRole("button", { name: "Save session preset" }));
    expect(screen.getByRole("button", { name: "Select My coding desk theme preset" })).toBeInTheDocument();
    expect(screen.getByText(/no durable write/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Compare theme preset with" }), { target: { value: "theme-coder-night" } });
    expect(screen.getByRole("region", { name: "Theme preset comparison" })).toHaveTextContent(/style differences/i);
  });

  it("opens a portable export preview and resets the catalog", () => {
    render(<ThemePresetStudio />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect bundle" }));
    expect(screen.getByLabelText("Theme preset bundle payload")).toHaveTextContent(/omnia\.theme-preset-studio\.v1/);
    fireEvent.change(screen.getByRole("combobox", { name: "Theme preset export format" }), { target: { value: "markdown" } });
    expect(screen.getByLabelText("Theme preset bundle payload")).toHaveTextContent(/theme preset studio preview/i);
    fireEvent.click(screen.getByRole("button", { name: "Reset theme preset studio" }));
    expect(screen.getByRole("button", { name: "Select Coder Night theme preset" })).toBeInTheDocument();
  });
});
