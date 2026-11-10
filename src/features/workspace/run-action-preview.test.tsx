import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RunActionPreview } from "./run-action-preview";

describe("RunActionPreview", () => {
  it("shows the broad renderer-only action palette and state-aware availability", () => {
    render(<RunActionPreview state="streaming" />);

    const region = screen.getByRole("region", { name: "Run actions preview" });
    const toggle = within(region).getByRole("button", { name: /Hide/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toHaveAttribute("role", "group");
    expect(within(region).getByRole("button", { name: "Pause" })).toBeEnabled();
    expect(within(region).getByRole("button", { name: "Steer" })).toBeEnabled();
    expect(within(region).getByRole("button", { name: "Retry" })).toBeDisabled();
    expect(within(region).getByRole("button", { name: "Merge" })).toBeDisabled();
    expect(within(region).getByText(/nothing is sent or persisted/i)).toBeInTheDocument();
  });

  it("reports a local preview selection without mutating a store", () => {
    const onSelect = vi.fn();
    render(<RunActionPreview state="completed" onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onSelect).toHaveBeenCalledWith("retry");
    expect(screen.getByRole("status")).toHaveTextContent(/Retry is a renderer preview/i);
    expect(screen.getByRole("status")).toHaveTextContent(/native dispatch is not connected/i);
  });

  it("can collapse to a compact affordance without losing its boundary", () => {
    render(<RunActionPreview compact state="idle" />);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show/i }));
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByText(/native run-control bridge/i)).toBeInTheDocument();
  });

  it("keeps paused-run recovery actions visible while preserving preview boundaries", () => {
    render(<RunActionPreview state="paused" />);

    const region = screen.getByRole("region", { name: "Run actions preview" });
    expect(within(region).getByText("Paused")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Resume" })).toBeEnabled();
    expect(within(region).getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(within(region).getByRole("button", { name: "Branch" })).toBeEnabled();
    expect(within(region).getByText(/nothing is sent or persisted/i)).toBeInTheDocument();
  });
});
