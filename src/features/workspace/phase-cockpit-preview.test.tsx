import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import PhaseCockpitPreview, { PHASE_COCKPIT_PHASES } from "./phase-cockpit-preview";

describe("PhaseCockpitPreview", () => {
  it("shows the current phase arc and selected detail", () => {
    render(<PhaseCockpitPreview />);

    expect(screen.getByRole("heading", { name: "Phase cockpit" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Phase cockpit phases" }).querySelectorAll("[role=\"listitem\"]")).toHaveLength(PHASE_COCKPIT_PHASES.length);
    expect(screen.getByRole("complementary", { name: "Selected phase detail" })).toHaveTextContent(/Capability studios/i);
    expect(screen.getByRole("note", { name: "Phase cockpit boundary" })).toHaveTextContent(/renderer-local and preview-only/i);
  });

  it("filters phases and moves selection to a visible phase", () => {
    render(<PhaseCockpitPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Filter phase cockpit status" }), { target: { value: "attention" } });
    const list = screen.getByRole("list", { name: "Phase cockpit phases" });
    expect(within(list).getByText("Evidence and handoff")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Capability studios/i })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Selected phase detail" })).toHaveTextContent(/Evidence and handoff/i);
  });

  it("supports search and deterministic JSON copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<PhaseCockpitPreview />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search phase cockpit" }), { target: { value: "rustc" } });
    expect(screen.getByRole("list", { name: "Phase cockpit phases" })).toHaveTextContent(/Native vertical slice/i);
    expect(screen.getByRole("status")).toHaveTextContent(/Phase cues are renderer-local/i);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0]?.[0]).toContain('"schema": "omnia.phase-cockpit.preview.v1"');
      expect(screen.getByRole("status")).toHaveTextContent(/Copied JSON phase cockpit preview/i);
    });
  });

  it("switches export format and resets the view", () => {
    render(<PhaseCockpitPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Phase cockpit export format" }), { target: { value: "markdown" } });
    expect(screen.getByRole("code")).toHaveTextContent(/# Omnia phase cockpit preview/);
    fireEvent.change(screen.getByRole("textbox", { name: "Search phase cockpit" }), { target: { value: "native" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    expect(screen.getByRole("toolbar", { name: "Phase cockpit filters" })).toHaveTextContent(`${PHASE_COCKPIT_PHASES.length} of ${PHASE_COCKPIT_PHASES.length} phases`);
    expect(screen.getByRole("code")).toHaveTextContent(/Foundation/);
  });
});
