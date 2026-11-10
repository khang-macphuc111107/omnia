import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { initialProviders } from "./mock-data";
import { ModelRouteFitLab } from "./model-route-fit-lab";

describe("ModelRouteFitLab", () => {
  it("matches a task profile against catalog capabilities and keeps route selection explicit", () => {
    const onModelProfileChange = vi.fn();
    render(<ModelRouteFitLab providers={initialProviders} modelProfileId="auto" onModelProfileChange={onModelProfileChange} />);

    expect(screen.getByRole("heading", { name: "Model fit lab" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /best metadata fit/i })).toHaveTextContent("Atlas Reasoning");
    expect(screen.getByText(/Input is evaluated locally in this renderer/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Select route" }));
    expect(onModelProfileChange).toHaveBeenCalledWith("quality");
    expect(screen.getByText(/No model\/provider request/i)).toBeInTheDocument();
  });

  it("marks context overflow and missing capability candidates blocked without selecting them", () => {
    const onModelProfileChange = vi.fn();
    const smallContextProviders = initialProviders.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({ ...model, contextLabel: "1K context" })),
    }));
    render(<ModelRouteFitLab providers={smallContextProviders} modelProfileId="auto" onModelProfileChange={onModelProfileChange} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Route task preview" }), { target: { value: "x".repeat(18_000) } });
    expect(screen.getAllByText("Blocked").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/exceeds reported context/i).length).toBeGreaterThan(0);
    const localSelection = screen.getByRole("button", { name: "Select Local Fast route" });
    expect(localSelection).toBeDisabled();
    expect(onModelProfileChange).not.toHaveBeenCalled();
  });

  it("supports local-only destination and hiding blocked routes", () => {
    render(<ModelRouteFitLab providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Route destination privacy" }), { target: { value: "local" } });
    expect(screen.getAllByText(/Local-only destination required/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show blocked routes" }));
    expect(screen.queryByText(/Local-only destination required/i)).not.toBeInTheDocument();
  });
});
