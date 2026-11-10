import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { initialProviders } from "./mock-data";
import { ProviderModelCompatibilityPreview } from "./provider-model-compatibility-preview";

describe("ProviderModelCompatibilityPreview", () => {
  it("shows the matrix and explicit preview boundary", () => {
    render(<ProviderModelCompatibilityPreview providers={initialProviders} />);

    expect(screen.getByRole("heading", { name: "Compatibility Matrix" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Provider model compatibility matrix" })).toBeInTheDocument();
    expect(screen.getByText(/Renderer-local preview · no provider request/i)).toBeInTheDocument();
  });

  it("supports mode switching, search, selection, and undo", () => {
    render(<ProviderModelCompatibilityPreview providers={initialProviders} />);

    const mode = screen.getByRole("combobox", { name: "Compatibility assessment mode" });
    fireEvent.change(mode, { target: { value: "advisory" } });
    expect(mode).toHaveValue("advisory");
    fireEvent.click(screen.getByRole("button", { name: "Undo compatibility mode change" }));
    expect(mode).toHaveValue("strict");

    fireEvent.change(screen.getByRole("textbox", { name: "Search compatibility matrix" }), { target: { value: "local" } });
    expect(screen.getAllByText("Local Fast").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("row", { name: "Inspect compatibility for Local Fast" }));
    expect(screen.getByRole("heading", { name: "Local Fast" })).toBeInTheDocument();
  });
});
