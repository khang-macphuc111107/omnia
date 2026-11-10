import { describe, expect, it } from "vitest";

import {
  buildRlaifBlindOrderPreview,
  buildRlaifReviewExport,
  buildRlaifSwapTestPreview,
  deriveRlaifBlindOrder,
  serializeRlaifReviewExport,
  validateRlaifReviewExport,
} from "./rlaif-review-export";

const input = {
  algorithm: "DPO" as const,
  evaluatorRoute: "Preview evaluator",
  rewardRecipe: "Correctness + usefulness",
  judgeCount: 3 as const,
  agreementThreshold: 67,
  disagreementPolicy: "human-review" as const,
  blindJudging: true,
  holdoutPercent: 20,
  comparisons: [
    { id: "a", preference: "prefer-a" as const },
    { id: "b", preference: null },
    { id: "c", preference: "abstain" as const },
  ],
};

describe("RLAIF review checkpoint export", () => {
  it("preserves reviewed and unresolved IDs without source content", () => {
    const manifest = buildRlaifReviewExport(input);

    expect(manifest.checkpointKey).toMatch(/^preview:rlaif:2-1:dpo$/);
    expect(manifest.review.reviewedComparisonIds).toEqual(["a", "c"]);
    expect(manifest.review.unresolvedComparisonIds).toEqual(["b"]);
    expect(manifest.boundary.preferenceDatasetWrite).toBe(false);
    expect(JSON.stringify(manifest)).not.toMatch(/response|prompt/i);
  });

  it("serializes markdown with an explicit preview boundary", () => {
    const markdown = serializeRlaifReviewExport(buildRlaifReviewExport(input), "markdown");

    expect(markdown).toMatch(/RLAIF review checkpoint preview/);
    expect(markdown).toMatch(/No evaluator request/);
    expect(markdown).toMatch(/Unresolved: 1/);
  });

  it("rejects boundary drift on import", () => {
    const manifest = buildRlaifReviewExport(input);
    expect(validateRlaifReviewExport(JSON.parse(serializeRlaifReviewExport(manifest)))).toEqual(manifest);
    expect(() => validateRlaifReviewExport({
      ...manifest,
      boundary: { ...manifest.boundary, evaluatorRequest: true },
    })).toThrow(/boundary\.evaluatorRequest must remain false/i);
  });

  it("keeps blind order deterministic and records a planned swap rehearsal", () => {
    const comparisons = input.comparisons.map(({ id }) => ({ id }));
    expect(deriveRlaifBlindOrder("seed-1", "a")).toBe(deriveRlaifBlindOrder("seed-1", "a"));
    expect(buildRlaifBlindOrderPreview(comparisons, "seed-1", false)).toMatchObject({
      enabled: false,
      seed: "seed-1",
      counts: { ab: 3, ba: 0 },
    });
    expect(buildRlaifSwapTestPreview(comparisons)).toMatchObject({
      enabled: true,
      status: "not-run",
      pairedComparisonIds: ["a", "b", "c"],
    });
  });

  it("includes pairwise rehearsal metadata without source content", () => {
    const manifest = buildRlaifReviewExport({ ...input, blindOrderSeed: "audit-seed", swapTestEnabled: true });
    expect(manifest.config.blindOrderSeed).toBe("audit-seed");
    expect(manifest.pairwise.blindOrder.assignments).toHaveLength(3);
    expect(manifest.pairwise.swapTest.status).toBe("not-run");
    expect(JSON.stringify(manifest)).not.toMatch(/response|prompt/i);
  });
});
