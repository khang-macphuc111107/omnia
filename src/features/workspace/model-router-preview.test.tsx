import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { initialProviders } from "./mock-data";
import { ModelRouterPreview } from "./model-router-preview";

describe("ModelRouterPreview", () => {
  it("shows strategy presets and a deterministic ranking preview", () => {
    render(<ModelRouterPreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    expect(screen.getByRole("heading", { name: "Auto router strategy" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Quality first/i })).toBeChecked();
    expect(screen.getByRole("list", { name: "Auto router ranking preview" })).toHaveTextContent("Atlas Reasoning");
    expect(screen.getAllByText(/Illustrative score/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/deterministic UI heuristics/i)).toBeInTheDocument();
  });

  it("applies a local-only strategy and keeps cloud candidates visibly blocked", () => {
    render(<ModelRouterPreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    fireEvent.click(screen.getByRole("radio", { name: /Private \/ local/i }));

    expect(screen.getByRole("radio", { name: /Private \/ local/i })).toBeChecked();
    expect(screen.getByText(/1 eligible route/i)).toBeInTheDocument();
    const localBlocked = screen.getAllByTitle("Local-only policy");
    expect(localBlocked.length).toBeGreaterThan(0);
    localBlocked.forEach((button) => expect(button).toBeDisabled());
    expect(screen.getByTitle("Select Local Fast")).toBeEnabled();
  });

  it("keeps degraded catalog entries visible but excludes them from Auto eligibility", () => {
    render(<ModelRouterPreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    const degradedRoute = screen.getByTitle("Model reports degraded status");
    expect(degradedRoute).toBeDisabled();
    expect(degradedRoute).toHaveTextContent("Orion Long Context");
    expect(screen.getByText(/3 eligible routes/i)).toBeInTheDocument();
  });

  it("does not treat configuration-validated providers as live-connected routes", () => {
    const providers = initialProviders.map((provider) => provider.id === "provider-custom"
      ? { ...provider, state: "configuration-validated" as const }
      : provider);
    render(<ModelRouterPreview providers={providers} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    const unvalidatedRoutes = screen.getAllByTitle("Provider is configuration-validated; live connection required");
    expect(unvalidatedRoutes).toHaveLength(2);
    unvalidatedRoutes.forEach((route) => expect(route).toBeDisabled());
    expect(screen.getByTitle("Model reports degraded status")).toBeDisabled();
    expect(screen.getByText(/1 eligible route/i)).toBeInTheDocument();
  });

  it("supports hard capability constraints and context requirements", () => {
    render(<ModelRouterPreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Minimum context requirement" }), { target: { value: "200k" } });

    expect(screen.getByText(/eligible route/i)).toBeInTheDocument();
    const contextBlocked = screen.getAllByTitle("Context below 200k");
    expect(contextBlocked).toHaveLength(2);
    contextBlocked.forEach((button) => expect(button).toBeDisabled());
  });

  it("keeps policy changes reversible", () => {
    render(<ModelRouterPreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);
    const qualityWeight = screen.getByLabelText("quality score weight");

    fireEvent.change(qualityWeight, { target: { value: "20" } });
    expect(qualityWeight).toHaveValue("20");
    fireEvent.click(screen.getByRole("button", { name: "Undo router policy change" }));
    expect(qualityWeight).toHaveValue("60");
    fireEvent.click(screen.getByRole("button", { name: "Redo router policy change" }));
    expect(qualityWeight).toHaveValue("20");
    fireEvent.click(screen.getByRole("button", { name: "Reset router policy" }));
    expect(qualityWeight).toHaveValue("60");
  });

  it("lets the caller pin the recommended route", () => {
    const onModelProfileChange = vi.fn();
    render(<ModelRouterPreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={onModelProfileChange} />);

    fireEvent.click(screen.getByRole("button", { name: /Use recommended/i }));
    expect(onModelProfileChange).toHaveBeenCalledWith("quality");
  });
});
