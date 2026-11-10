import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ObservabilityEvidenceDashboard, {
  OBSERVABILITY_EVIDENCE_ITEMS,
  OBSERVABILITY_LIFECYCLE_STAGES,
  serializeObservabilityEvidence,
} from "./observability-evidence-dashboard";

describe("ObservabilityEvidenceDashboard", () => {
  it("renders a truthful lifecycle and evidence summary", () => {
    render(<ObservabilityEvidenceDashboard />);

    expect(screen.getByRole("heading", { name: "Observability evidence dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Request lifecycle stages" }).querySelectorAll("[role=\"listitem\"]")).toHaveLength(OBSERVABILITY_LIFECYCLE_STAGES.length);
    expect(screen.getByRole("list", { name: "Observability evidence items" }).querySelectorAll("[role=\"listitem\"]")).toHaveLength(OBSERVABILITY_EVIDENCE_ITEMS.length);
    expect(screen.getByRole("complementary", { name: "Selected observability evidence detail" })).toHaveTextContent(/Request lifecycle envelope/i);
    expect(screen.getByRole("note", { name: "Observability evidence dashboard boundary" })).toHaveTextContent(/Unknown is not pass/i);
    expect(screen.getByText(/Preview only/i)).toBeInTheDocument();
  });

  it("filters by area and status while keeping unknown evidence explicit", () => {
    render(<ObservabilityEvidenceDashboard />);

    fireEvent.change(screen.getByRole("combobox", { name: "Filter observability evidence area" }), { target: { value: "lineage" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter observability evidence status" }), { target: { value: "unknown" } });

    const list = screen.getByRole("list", { name: "Observability evidence items" });
    expect(within(list).getByText(/Frozen provider attempt lineage/i)).toBeInTheDocument();
    expect(within(list).getByText(/Provider acceptance and outcome/i)).toBeInTheDocument();
    expect(within(list).queryByText(/Usage ledger and token classes/i)).not.toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "Observability evidence filters" })).toHaveTextContent("2 of 8 items");
    expect(screen.getByRole("complementary", { name: "Selected observability evidence detail" })).toHaveTextContent(/current provider profile must never be substituted/i);
  });

  it("supports search, Markdown export, and renderer-local copy status", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ObservabilityEvidenceDashboard />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search observability evidence" }), { target: { value: "cost" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Observability evidence export format" }), { target: { value: "markdown" } });
    expect(screen.getByRole("code")).toHaveTextContent(/# Omnia observability evidence dashboard/);
    expect(screen.getByRole("code")).toHaveTextContent(/Cost provenance and reconciliation/i);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0]?.[0]).toContain("omnia.observability-evidence-dashboard.preview.v1");
      expect(screen.getByRole("status")).toHaveTextContent(/Copied Markdown observability evidence preview/i);
    });
  });

  it("resets scope and filters without changing the fixture", () => {
    render(<ObservabilityEvidenceDashboard />);

    fireEvent.change(screen.getByRole("combobox", { name: "Observability evidence scope" }), { target: { value: "run" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter observability evidence area" }), { target: { value: "safety" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter observability evidence status" }), { target: { value: "planned" } });
    fireEvent.click(screen.getByRole("button", { name: /Reset view/i }));

    expect(screen.getByRole("combobox", { name: "Observability evidence scope" })).toHaveValue("workspace");
    expect(screen.getByRole("combobox", { name: "Filter observability evidence area" })).toHaveValue("all");
    expect(screen.getByRole("combobox", { name: "Filter observability evidence status" })).toHaveValue("all");
    expect(screen.getByRole("toolbar", { name: "Observability evidence filters" })).toHaveTextContent(`${OBSERVABILITY_EVIDENCE_ITEMS.length} of ${OBSERVABILITY_EVIDENCE_ITEMS.length} items`);
  });

  it("keeps evidence triage annotations renderer-local and includes them in export previews", () => {
    render(<ObservabilityEvidenceDashboard />);

    expect(screen.getByRole("region", { name: "Session evidence triage summary" })).toHaveTextContent(/8/);
    fireEvent.change(screen.getByRole("combobox", { name: "Evidence triage disposition" }), { target: { value: "gate-requested" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Evidence review owner" }), { target: { value: "Platform team" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Evidence review note" }), { target: { value: "Join native cursor before release review." } });

    fireEvent.change(screen.getByRole("combobox", { name: "Observability evidence export format" }), { target: { value: "json" } });
    const preview = screen.getByRole("code");
    expect(preview).toHaveTextContent(/sessionReview/);
    expect(preview).toHaveTextContent(/gate-requested/);
    expect(preview).toHaveTextContent(/Platform team/);
    expect(preview).toHaveTextContent(/Join native cursor before release review/);
    expect(screen.getByRole("region", { name: "Session-only evidence triage" })).toHaveTextContent(/not saved to the native journal/i);
  });

  it("serializes lifecycle, filters, and the explicit native boundary", () => {
    const markdown = serializeObservabilityEvidence(OBSERVABILITY_EVIDENCE_ITEMS.slice(0, 2), OBSERVABILITY_LIFECYCLE_STAGES, {
      scope: "run",
      area: "lineage",
      status: "unknown",
      query: "provider",
      format: "markdown",
    });

    expect(markdown).toContain("# Omnia observability evidence dashboard");
    expect(markdown).toContain("- Scope: run");
    expect(markdown).toContain("## Request lifecycle");
    expect(markdown).toContain("Frozen provider attempt lineage");
    expect(markdown).toContain("No provider request, native journal read");
  });
});
