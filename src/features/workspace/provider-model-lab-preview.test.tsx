import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { initialProviders } from "./mock-data";
import { ProviderModelLabPreview } from "./provider-model-lab-preview";

describe("ProviderModelLabPreview", () => {
  it("shows a searchable model portfolio with explicit preview boundaries", () => {
    render(<ProviderModelLabPreview providers={initialProviders} />);

    expect(screen.getByRole("heading", { name: "Model Lab" })).toBeInTheDocument();
    expect(screen.getAllByText(/no provider request/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Atlas Reasoning").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole("textbox", { name: "Search models" }), { target: { value: "local" } });
    expect(screen.getByText("Local Fast")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Model portfolio" })).queryByText("Atlas Reasoning")).not.toBeInTheDocument();
  });

  it("filters and sorts the catalog, then clears the whole view back to defaults", () => {
    render(<ProviderModelLabPreview providers={initialProviders} />);

    const portfolio = screen.getByRole("list", { name: "Model portfolio" });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter models by status" }), { target: { value: "degraded" } });
    expect(within(portfolio).getByText("Orion Long Context")).toBeInTheDocument();
    expect(within(portfolio).queryByText("Local Fast")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Filter models by status" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Sort models" }), { target: { value: "context-high" } });
    expect(within(portfolio).getAllByRole("listitem")[0]).toHaveTextContent("Orion Long Context");

    fireEvent.click(screen.getByRole("checkbox", { name: "Show favorites only" }));
    expect(within(portfolio).queryByText("Local Fast")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter models by status" }), { target: { value: "unavailable" } });
    expect(within(portfolio).getByText("No model matches")).toBeInTheDocument();
    fireEvent.click(within(portfolio).getByRole("button", { name: "Clear catalog filters" }));

    expect(within(portfolio).getByText("Local Fast")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("0 filters");
    expect(screen.getByRole("combobox", { name: "Sort models" })).toHaveValue("catalog");
  });

  it("edits a model draft and supports undo", () => {
    render(<ProviderModelLabPreview providers={initialProviders} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit Atlas Reasoning" }));
    const editor = screen.getByRole("heading", { name: "Atlas Reasoning" }).closest("section");
    expect(editor).not.toBeNull();
    const displayName = within(editor!).getByRole("textbox", { name: "Model display name" });
    fireEvent.change(displayName, { target: { value: "Atlas Pro" } });
    expect(displayName).toHaveValue("Atlas Pro");
    fireEvent.click(screen.getByRole("button", { name: "Undo model lab change" }));
    expect(within(editor!).getByRole("textbox", { name: "Model display name" })).toHaveValue("Atlas Reasoning");
  });

  it("builds a compare set and exposes export controls", () => {
    render(<ProviderModelLabPreview providers={initialProviders} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Compare" })[0]!);
    fireEvent.click(screen.getByRole("tab", { name: /Compare/ }));
    expect(screen.getByRole("heading", { name: "Compare selected models" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy JSON" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Markdown" })).toBeInTheDocument();
  });
});
