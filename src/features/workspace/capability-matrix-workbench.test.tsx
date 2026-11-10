import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { initialProviders } from "./mock-data";
import { CapabilityMatrixWorkbench } from "./capability-matrix-workbench";

describe("CapabilityMatrixWorkbench", () => {
  it("compares provider-reported capabilities and keeps future endpoints planned", () => {
    render(<CapabilityMatrixWorkbench providers={initialProviders} />);

    expect(screen.getByRole("heading", { name: "Capability matrix" })).toBeInTheDocument();
    expect(screen.getByText("Custom lab")).toBeInTheDocument();
    expect(screen.getByText("Local runtime")).toBeInTheDocument();
    expect(screen.getAllByText("Supported").length).toBeGreaterThan(0);
    expect(screen.queryByText("Image generation")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Show planned columns"));
    expect(screen.getByText("Image generation")).toBeInTheDocument();
    expect(screen.getAllByText("Planned").length).toBeGreaterThan(1);
    expect(screen.getByText(/does not grant permissions/i)).toBeInTheDocument();
  });

  it("filters local models and lets the caller select a model column", () => {
    const onModelProfileChange = vi.fn();
    render(
      <CapabilityMatrixWorkbench
        providers={initialProviders}
        modelProfileId="auto"
        onModelProfileChange={onModelProfileChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Capability matrix comparison mode"), { target: { value: "models" } });
    expect(screen.getByText("Atlas Reasoning")).toBeInTheDocument();
    expect(screen.getByText("Local Fast")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Capability matrix scope"), { target: { value: "local" } });
    expect(screen.queryByText("Atlas Reasoning")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Local Fast").closest("button")!);
    expect(onModelProfileChange).toHaveBeenCalledWith("local-fast");
  });

  it("filters capability rows by text and reported status, then resets the matrix", () => {
    render(<CapabilityMatrixWorkbench providers={initialProviders} />);

    fireEvent.change(screen.getByLabelText("Filter capabilities"), { target: { value: "vision" } });
    expect(screen.getByText("Vision input")).toBeInTheDocument();
    expect(screen.queryByText("Tool calls")).not.toBeInTheDocument();
    expect(screen.getByLabelText("1 of 6 capabilities")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Capability matrix status filter"), { target: { value: "planned" } });
    expect(screen.getByText("No matching capabilities")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(screen.getByText("Tool calls")).toBeInTheDocument();
    expect(screen.queryByText("Image generation")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset filters" })).toBeDisabled();
  });
});
