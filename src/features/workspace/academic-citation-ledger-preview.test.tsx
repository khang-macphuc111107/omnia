import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AcademicCitationLedgerPreview, { buildCitationQualityReview, buildCitationQualitySummary, sortCitationQualityReviews } from "./academic-citation-ledger-preview";

describe("AcademicCitationLedgerPreview", () => {
  it("keeps the evidence boundary visible and summarizes the preview ledger", () => {
    render(<AcademicCitationLedgerPreview />);
    expect(screen.getByRole("heading", { name: "Citation ledger" })).toBeInTheDocument();
    expect(screen.getByText(/No URL retrieval, source verification/i)).toBeInTheDocument();
    expect(screen.getByText("50%", { selector: ".academic-citation-ledger__metrics strong" })).toBeInTheDocument();
    expect(screen.getByText("4 of 4 claims")).toBeInTheDocument();
  });

  it("filters claims and updates the selected claim evidence state", () => {
    render(<AcademicCitationLedgerPreview />);
    fireEvent.change(screen.getByLabelText("Search claims and sources"), { target: { value: "freshness" } });
    expect(screen.getAllByText(/A citation can become stale/i)).toHaveLength(2);
    expect(screen.queryByText(/Provenance should survive synthesis/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Selected claim evidence status"), { target: { value: "supported" } });
    expect(screen.getByText("Supported", { selector: ".academic-citation-ledger__detail .academic-citation-ledger__status" })).toBeInTheDocument();
  });

  it("supports source linking, source filtering, and adding a renderer-local record", () => {
    render(<AcademicCitationLedgerPreview />);
    const sourceCheckbox = screen.getByRole("checkbox", { name: /Provider freshness scratchpad/i });
    expect(sourceCheckbox).not.toBeChecked();
    fireEvent.click(sourceCheckbox);
    expect(sourceCheckbox).toBeChecked();
    fireEvent.click(screen.getByRole("tab", { name: /^Sources/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Source type filter" }), { target: { value: "conversation" } });
    expect(within(screen.getByRole("tabpanel")).getAllByText("Local-first memory discussion")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("New source title"), { target: { value: "Scratch source" } });
    fireEvent.change(screen.getByLabelText("New source locator"), { target: { value: "Notebook · local" } });
    fireEvent.click(screen.getByRole("button", { name: /add source/i }));
    expect(screen.getByText("Added a renderer-local source record; no source was fetched.")).toBeInTheDocument();
  });

  it("shows coverage rows and exports a markdown ledger preview", () => {
    render(<AcademicCitationLedgerPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /coverage/i }));
    expect(screen.getByRole("heading", { name: "Coverage review" })).toBeInTheDocument();
    expect(screen.getByText(/Coverage is a review heuristic/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /export/i }));
    fireEvent.change(screen.getByLabelText("Citation ledger export format"), { target: { value: "markdown" } });
    const code = within(screen.getByRole("tabpanel")).getByRole("code");
    expect(code).toHaveTextContent(/Academic citation ledger preview/);
    expect(code).toHaveTextContent(/Harness architecture notes/);
    expect(code).toHaveTextContent(/Preview only/);
  });

  it("surfaces metadata-based citation quality triage without claiming verification", () => {
    render(<AcademicCitationLedgerPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /^Quality/ }));
    expect(screen.getByRole("heading", { name: "Citation quality triage" })).toBeInTheDocument();
    expect(screen.getAllByText("Ready for human check").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Claim review").length).toBeGreaterThan(0);
    expect(screen.getByText(/never decides that a source is true/i)).toBeInTheDocument();
    expect(screen.getByText(/Quality triage is renderer-local and metadata-based/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /export/i }));
    expect(within(screen.getByRole("tabpanel")).getByRole("code")).toHaveTextContent(/qualitySummary/);
    expect(within(screen.getByRole("tabpanel")).getByRole("code")).toHaveTextContent(/qualitySignals/);
  });

  it("keeps quality signals fail-closed for missing, dated, and contradictory evidence", () => {
    const source = {
      id: "dated-source",
      title: "Dated paper",
      kind: "paper" as const,
      locator: "Notebook · paper 1",
      author: "Example author",
      year: "2022",
      excerpt: "Metadata-only source fixture.",
      quality: "primary" as const,
      freshness: "dated" as const,
    };
    const supportedClaim = {
      id: "dated-claim",
      claim: "A dated source should require source review.",
      section: "Quality",
      sourceIds: [source.id],
      status: "supported" as const,
      confidence: 75,
      statementType: "inferred" as const,
      note: "",
    };
    const blockedClaim = { ...supportedClaim, id: "blocked-claim", sourceIds: ["missing"], status: "supported" as const };
    const contradictoryClaim = { ...supportedClaim, id: "contradictory-claim", status: "contradicts" as const };
    expect(buildCitationQualityReview(supportedClaim, [source]).signal).toBe("source-review");
    expect(buildCitationQualityReview(blockedClaim, [source]).signal).toBe("blocked");
    expect(buildCitationQualityReview(contradictoryClaim, [source]).signal).toBe("claim-review");
    expect(buildCitationQualitySummary([supportedClaim, blockedClaim, contradictoryClaim], [source])).toMatchObject({
      totalClaims: 3,
      sourceReview: 1,
      claimReview: 1,
      blocked: 1,
    });
  });

  it("sorts review signals by priority and supports claim and section ordering", () => {
    const source = {
      id: "primary-current",
      title: "Primary source",
      kind: "paper" as const,
      locator: "Notebook · paper 2",
      author: "Example author",
      year: "2026",
      excerpt: "Metadata-only source fixture.",
      quality: "primary" as const,
      freshness: "current" as const,
    };
    const makeClaim = (id: string, claim: string, section: string, status: "supported" | "unresolved") => ({
      id,
      claim,
      section,
      sourceIds: status === "unresolved" ? [] : [source.id],
      status,
      confidence: 70,
      statementType: "inferred" as const,
      note: "",
    });
    const claims = [
      makeClaim("zeta", "Zeta claim", "Zeta section", "supported"),
      makeClaim("alpha", "Alpha claim", "Beta section", "unresolved"),
      makeClaim("beta", "Beta claim", "Alpha section", "supported"),
    ];
    const reviews = claims.map((claim) => buildCitationQualityReview(claim, [source]));

    expect(sortCitationQualityReviews(reviews, "priority").map((review) => review.claimId)).toEqual(["alpha", "beta", "zeta"]);
    expect(sortCitationQualityReviews(reviews, "claim").map((review) => review.claimId)).toEqual(["alpha", "beta", "zeta"]);
    expect(sortCitationQualityReviews(reviews, "section").map((review) => review.claimId)).toEqual(["beta", "alpha", "zeta"]);
  });

  it("filters triage signals and jumps directly to the matching claim for review", () => {
    render(<AcademicCitationLedgerPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /^Quality/ }));
    fireEvent.change(screen.getByLabelText("Citation quality signal filter"), { target: { value: "claim-review" } });
    expect(screen.getByText("2 of 4 claims")).toBeInTheDocument();
    expect(screen.queryByText(/Provenance should survive synthesis/i)).not.toBeInTheDocument();

    const firstReviewButton = screen.getAllByRole("button", { name: "Review claim" })[0];
    expect(firstReviewButton).toBeDefined();
    if (!firstReviewButton) throw new Error("Expected at least one citation review action.");
    fireEvent.click(firstReviewButton);
    expect(screen.getByRole("tab", { name: /^Claims/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("article", { name: "Selected claim details" })).toHaveTextContent(/A citation can become stale/i);
    expect(screen.getByText("Opened the selected claim for renderer-local human review.")).toBeInTheDocument();
  });

  it("keeps claim status changes undoable and resettable", () => {
    render(<AcademicCitationLedgerPreview />);
    fireEvent.change(screen.getByLabelText("Selected claim evidence status"), { target: { value: "contradicts" } });
    expect(screen.getByRole("combobox", { name: "Selected claim evidence status" })).toHaveValue("contradicts");
    fireEvent.click(screen.getByRole("button", { name: /undo citation ledger action/i }));
    expect(screen.getByRole("combobox", { name: "Selected claim evidence status" })).toHaveValue("supported");
    fireEvent.click(screen.getByRole("button", { name: /reset/i }));
    expect(screen.getByText("Citation ledger preview reset.")).toBeInTheDocument();
  });

  it("validates a pasted package before replacing the ledger and keeps import undoable", () => {
    render(<AcademicCitationLedgerPreview />);
    const packageText = JSON.stringify({
      schema: "omnia.academic-citation-ledger.preview.v1",
      claims: [{
        id: "imported-claim",
        claim: "Imported statement for the new draft.",
        section: "Imported section",
        sourceIds: ["imported-source"],
        status: "needs review",
        confidence: 57,
        statementType: "inferred",
        note: "Imported reviewer note.",
      }],
      sources: [{
        id: "imported-source",
        title: "Imported paper",
        kind: "paper",
        locator: "Research notebook · entry 4",
        author: "Example author",
        year: "2026",
        excerpt: "Example metadata only.",
        quality: "primary",
        freshness: "unknown",
      }],
    });

    fireEvent.click(screen.getByRole("tab", { name: "Import" }));
    fireEvent.change(screen.getByLabelText("Citation ledger import mode"), { target: { value: "replace" } });
    fireEvent.change(screen.getByLabelText("Citation ledger JSON import"), { target: { value: packageText } });
    expect(screen.getByText("Package ready · 1 claims · 1 sources")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Replace ledger" }));
    expect(screen.getByText(/Replaced 1 claims and 1 sources/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /^Claims/ }));
    expect(screen.getAllByText("Imported statement for the new draft.")).toHaveLength(2);
    expect(screen.getByText("1 of 1 claims")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /undo citation ledger action/i }));
    expect(screen.getByText("4 of 4 claims")).toBeInTheDocument();
  });

  it("rejects malformed or dangling-reference packages without changing ledger records", () => {
    render(<AcademicCitationLedgerPreview />);
    fireEvent.click(screen.getByRole("tab", { name: "Import" }));
    fireEvent.change(screen.getByLabelText("Citation ledger JSON import"), { target: { value: "{not json" } });
    expect(screen.getByText("This is not valid JSON. Check the pasted text or export a fresh ledger package.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge into ledger" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Citation ledger JSON import"), { target: { value: JSON.stringify({
      schema: "omnia.academic-citation-ledger.preview.v1",
      claims: [{ id: "orphan", claim: "An orphaned claim", section: "Tests", sourceIds: ["missing-source"], status: "unresolved", confidence: 25, statementType: "planned", note: "" }],
      sources: [],
    }) } });
    expect(screen.getByText(/links to a source that is missing from this package/i)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Claims/ })).toHaveTextContent("4");
  });

  it("rejects an oversized pasted ledger before parsing or applying it", () => {
    render(<AcademicCitationLedgerPreview />);
    fireEvent.click(screen.getByRole("tab", { name: "Import" }));
    fireEvent.change(screen.getByLabelText("Citation ledger JSON import"), { target: { value: "x".repeat(65_537) } });
    expect(screen.getByText(/exceeds the 64 KB import limit/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge into ledger" })).toBeDisabled();
  });
});
