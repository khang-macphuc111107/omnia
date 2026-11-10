import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import DataIntakeLearningReview, {
  initialIntakeReview,
  isIntakeRecordEligible,
  parseIntakeReviewPayload,
  selectEligibleIntakeRecords,
  serializeIntakeReview,
} from "./data-intake-learning-review";

describe("DataIntakeLearningReview", () => {
  it("renders provenance, policy metrics, and truthful renderer boundary", () => {
    render(<DataIntakeLearningReview />);

    expect(screen.getByRole("region", { name: "Data intake and learning review" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Data intake review summary" })).toHaveTextContent(/records/i);
    expect(screen.getByText(/no hidden user-data collection/i)).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: /helpful answer signal/i })).toBeInTheDocument();
  });

  it("updates policy and record review actions through renderer-local history", () => {
    render(<DataIntakeLearningReview />);

    fireEvent.click(screen.getByRole("listitem", { name: /ui-first workflow preference/i }));
    expect(screen.getByRole("complementary", { name: "Selected data intake record" })).toHaveTextContent(/UI-first workflow preference/i);

    fireEvent.click(screen.getByRole("button", { name: /approve in preview/i }));
    expect(screen.getByRole("complementary", { name: "Selected data intake record" })).toHaveTextContent(/eligible|held/i);

    fireEvent.click(screen.getByRole("button", { name: "Undo intake review change" }));
    expect(within(screen.getByRole("complementary", { name: "Selected data intake record" })).getByText(/Pending review|Consent pending/i)).toBeInTheDocument();
  });

  it("opens portable export and import previews", () => {
    render(<DataIntakeLearningReview />);

    fireEvent.click(screen.getByRole("button", { name: /preview export/i }));
    const exportRegion = screen.getByRole("region", { name: "Data intake export preview" });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/omnia\.data-intake-learning-review\.v1/i);

    fireEvent.click(screen.getByRole("button", { name: /import bundle/i }));
    const importRegion = screen.getByRole("region", { name: "Data intake import preview" });
    fireEvent.change(within(importRegion).getByRole("textbox", { name: "Data intake import payload" }), {
      target: {
        value: JSON.stringify({
          schema: "omnia.data-intake-learning-review.v1",
          records: [{ id: "portable-new", title: "Imported review note", source: "portable", excerpt: "Review me" }],
        }),
      },
    });
    fireEvent.click(within(importRegion).getByRole("button", { name: /stage valid records/i }));
    expect(screen.getByText(/staged 1 imported intake record/i)).toBeInTheDocument();
  });
});

describe("data-intake learning review helpers", () => {
  it("keeps sensitive and pending-consent records out of the default eligible set", () => {
    const eligible = selectEligibleIntakeRecords(initialIntakeReview);
    expect(eligible.map((record) => record.id)).toEqual(["intake-feedback-001", "intake-feedback-002", "intake-run-001"]);
    expect(isIntakeRecordEligible(initialIntakeReview, initialIntakeReview.records[2]!)).toBe(false);
  });

  it("round-trips the portable JSON bundle and rejects the wrong schema", () => {
    const payload = serializeIntakeReview(initialIntakeReview, "json");
    const records = parseIntakeReviewPayload(payload);
    expect(records).toHaveLength(initialIntakeReview.records.length);
    expect(records[0]?.title).toBe("Helpful answer signal");
    expect(() => parseIntakeReviewPayload('{"schema":"other","records":[]}')).toThrow(/expected an omnia data-intake/i);
  });
});
