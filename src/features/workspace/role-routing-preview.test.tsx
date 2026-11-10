import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { initialProviders } from "./mock-data";
import { RoleRoutingPreview } from "./role-routing-preview";

describe("RoleRoutingPreview", () => {
  it("shows bounded role rows with separate mode and effort controls", () => {
    render(<RoleRoutingPreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    expect(screen.getByRole("heading", { name: "Role routing assignments" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Role route overrides" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Planner routing mode" })).toHaveValue("auto");
    expect(screen.getByRole("combobox", { name: "Planner effort" })).toHaveValue("deep");
    expect(screen.getByText("Higher-priority request and task choices can override this role default.")).toBeInTheDocument();
  });

  it("supports explicit and pool routes while keeping main route selection shared", () => {
    const onModelProfileChange = vi.fn();
    render(<RoleRoutingPreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={onModelProfileChange} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Builder routing mode" }), { target: { value: "explicit" } });
    expect(screen.getByRole("combobox", { name: "Builder model route" })).toHaveValue("quality");
    fireEvent.change(screen.getByRole("combobox", { name: "Builder model route" }), { target: { value: "local-fast" } });

    fireEvent.change(screen.getByRole("combobox", { name: "Main chat routing mode" }), { target: { value: "explicit" } });
    expect(onModelProfileChange).toHaveBeenCalledWith("quality");

    fireEvent.change(screen.getByRole("combobox", { name: "Main chat routing mode" }), { target: { value: "pool" } });
    expect(screen.getAllByRole("group", { name: "Candidate pool" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("combobox", { name: "Main chat routing mode" })).toHaveValue("pool");

    fireEvent.change(screen.getByRole("combobox", { name: "Reviewer routing mode" }), { target: { value: "pool" } });
    const candidatePools = screen.getAllByRole("group", { name: "Candidate pool" });
    expect(candidatePools.length).toBeGreaterThan(1);
    fireEvent.click(within(candidatePools.at(-1)!).getByLabelText("Atlas Reasoning"));
    expect(screen.getAllByText("Preview route is available").length).toBeGreaterThan(0);
  });

  it("keeps unavailable model routes blocked and exposes a renderer-only copy boundary", () => {
    render(<RoleRoutingPreview providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Verifier routing mode" }), { target: { value: "explicit" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Verifier model route" }), { target: { value: "long-context" } });
    expect(screen.getByText("Selected route is unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Renderer-only role overrides/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy JSON" })).toBeInTheDocument();
  });
});
