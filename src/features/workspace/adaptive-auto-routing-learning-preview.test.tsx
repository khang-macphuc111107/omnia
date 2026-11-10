import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { initialProviders } from "./mock-data";
import { AdaptiveAutoRoutingLearningPreview } from "./adaptive-auto-routing-learning-preview";

describe("AdaptiveAutoRoutingLearningPreview", () => {
  it("exposes adaptive strategy, role, signal, and learning-source controls", () => {
    render(<AdaptiveAutoRoutingLearningPreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    expect(screen.getByRole("heading", { name: "Adaptive Auto routing & learning" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Auto strategy mode" })).toHaveValue("adaptive-shadow");
    expect(screen.getByRole("combobox", { name: "Adaptive routing role" })).toHaveValue("main");
    expect(screen.getByRole("checkbox", { name: /Quality score/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Evaluation scores/i })).not.toBeChecked();
    expect(screen.getByText(/Renderer-only rehearsal/i)).toBeInTheDocument();
  });

  it("recalculates the recommendation from reversible policy controls", () => {
    render(<AdaptiveAutoRoutingLearningPreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);
    const exploration = screen.getByRole("slider", { name: "Adaptive exploration percentage" });
    fireEvent.change(exploration, { target: { value: "42" } });
    expect(exploration).toHaveValue("42");

    fireEvent.click(screen.getByRole("button", { name: "Undo adaptive Auto routing change" }));
    expect(exploration).toHaveValue("12");
    fireEvent.click(screen.getByRole("button", { name: "Redo adaptive Auto routing change" }));
    expect(exploration).toHaveValue("42");

    fireEvent.change(screen.getByRole("combobox", { name: "Adaptive learning mode" }), { target: { value: "promotion-review" } });
    expect(screen.getByRole("combobox", { name: "Adaptive learning mode" })).toHaveValue("promotion-review");
  });

  it("keeps unavailable candidates visible but disables their route action", () => {
    render(<AdaptiveAutoRoutingLearningPreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    const candidates = screen.getByRole("list", { name: "Adaptive Auto candidate routes" });
    expect(candidates).toHaveTextContent("Atlas Reasoning");
    const blocked = within(candidates).getAllByRole("button", { name: /Select Orion Long Context/i });
    expect(blocked.length).toBeGreaterThan(0);
    blocked.forEach((button) => expect(button).toBeDisabled());
  });

  it("uses the connected recommendation and exports a bounded preview", () => {
    const onModelProfileChange = vi.fn();
    render(<AdaptiveAutoRoutingLearningPreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={onModelProfileChange} />);

    fireEvent.click(screen.getByRole("button", { name: /Use recommendation/i }));
    expect(onModelProfileChange).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Inspect export" }));
    const preview = screen.getByLabelText("Adaptive Auto json preview");
    expect(preview).toHaveTextContent("omnia.adaptive-auto-routing-learning-preview.v1");
    expect(preview).toHaveTextContent("renderer-session");
    expect(preview).toHaveTextContent(/no model training/i);
  });
});
