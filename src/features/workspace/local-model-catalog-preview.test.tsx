import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LocalModelCatalogPreview } from "./local-model-catalog-preview";

describe("LocalModelCatalogPreview", () => {
  it("shows a hardware-aware seeded catalog with an explicit renderer boundary", () => {
    render(<LocalModelCatalogPreview />);

    expect(screen.getByRole("heading", { name: "Local Model Catalog" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Local model candidates" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Local model candidates" })).getByText("Llama 3.2 3B Instruct")).toBeInTheDocument();
    expect(screen.getByText(/no network catalog, filesystem, download/i)).toBeInTheDocument();
    expect(screen.getAllByText("Recommended").length).toBeGreaterThan(0);
  });

  it("filters by task and source, then resets the catalog", () => {
    render(<LocalModelCatalogPreview />);
    const list = screen.getByRole("list", { name: "Local model candidates" });

    fireEvent.change(screen.getByRole("combobox", { name: "Filter local models by task" }), { target: { value: "embedding" } });
    expect(within(list).getByRole("button", { name: "Inspect BGE-small-en-v1.5" })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "Inspect Llama 3.2 3B Instruct" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear local model catalog filters" }));
    expect(within(list).getByRole("button", { name: "Inspect Llama 3.2 3B Instruct" })).toBeInTheDocument();
    expect(screen.getByText(/catalog filters reset/i)).toBeInTheDocument();
  });

  it("updates selected details and compare view", () => {
    render(<LocalModelCatalogPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect Qwen2.5 Coder 7B Instruct" }));
    expect(screen.getByRole("heading", { name: "Qwen2.5 Coder 7B Instruct" })).toBeInTheDocument();
    expect(screen.getByText(/partial GPU offload/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Open compare/ }));
    expect(screen.getByRole("heading", { name: "Compare candidates" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Compared local models" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Llama 3.2 3B Instruct from compare" })).toBeInTheDocument();
  });

  it("keeps plan and manifest actions renderer-local", () => {
    render(<LocalModelCatalogPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Plan download" }));
    expect(screen.getByText(/Download plan staged/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export catalog JSON" })).toBeInTheDocument();
    expect(screen.getByLabelText("Import local model manifest")).toBeInTheDocument();
    expect(screen.getByText(/no runtime install\/launch/i)).toBeInTheDocument();
  });
});
