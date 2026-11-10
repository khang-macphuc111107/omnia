import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ReleaseEvidenceDashboard, { RELEASE_EVIDENCE_GATES } from "./release-evidence-dashboard";

describe("ReleaseEvidenceDashboard", () => {
  it("renders the release lane, phase strip, honest counts, and selected gate detail", () => {
    render(<ReleaseEvidenceDashboard />);

    expect(screen.getByRole("heading", { name: "Release evidence dashboard" })).toBeInTheDocument();
    expect(screen.getByText(/Omnia 0\.1\.0 · Phase 1 Provider Preview/i)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Release evidence gates" }).querySelectorAll("[role=\"listitem\"]")).toHaveLength(RELEASE_EVIDENCE_GATES.length);
    expect(screen.getByRole("complementary", { name: "Selected release evidence detail" })).toHaveTextContent(/Spec and schema contract/i);
    expect(screen.getByRole("note", { name: "Release evidence dashboard boundary" })).toHaveTextContent(/does not run validators/i);
    expect(screen.getByText(/Internal preview · gates open/i)).toBeInTheDocument();
  });

  it("filters by phase and status without changing the fixture", () => {
    render(<ReleaseEvidenceDashboard />);

    fireEvent.change(screen.getByRole("combobox", { name: "Filter release evidence phase" }), { target: { value: "package" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter release evidence status" }), { target: { value: "attention" } });

    const list = screen.getByRole("list", { name: "Release evidence gates" });
    expect(within(list).getByText(/Packaged Windows artifact/i)).toBeInTheDocument();
    expect(within(list).getByText(/Promotion and rollback policy/i)).toBeInTheDocument();
    expect(within(list).queryByText(/Renderer typecheck/i)).not.toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "Release evidence filters" })).toHaveTextContent("2 of 8 gates");
  });

  it("supports search and a portable JSON export preview", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ReleaseEvidenceDashboard />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search release evidence" }), { target: { value: "Rust, Tauri" } });
    expect(screen.getByRole("list", { name: "Release evidence gates" })).toHaveTextContent(/Rust, Tauri, and provider runtime/i);
    fireEvent.click(screen.getByRole("button", { name: /Copy/i }));

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0]?.[0]).toContain('"schema": "omnia.release-evidence-dashboard.preview.v1"');
      expect(screen.getByRole("status")).toHaveTextContent(/Copied JSON release evidence brief/i);
    });
  });

  it("switches to Markdown and resets the view", () => {
    render(<ReleaseEvidenceDashboard />);

    fireEvent.change(screen.getByRole("combobox", { name: "Release evidence export format" }), { target: { value: "markdown" } });
    expect(screen.getByRole("code")).toHaveTextContent(/# Omnia release evidence dashboard/);
    fireEvent.change(screen.getByRole("textbox", { name: "Search release evidence" }), { target: { value: "package" } });
    fireEvent.click(screen.getByRole("button", { name: /Reset view/i }));
    expect(screen.getByRole("toolbar", { name: "Release evidence filters" })).toHaveTextContent(`${RELEASE_EVIDENCE_GATES.length} of ${RELEASE_EVIDENCE_GATES.length} gates`);
    expect(screen.getByRole("code")).toHaveTextContent(/Spec and schema contract/);
  });
});
