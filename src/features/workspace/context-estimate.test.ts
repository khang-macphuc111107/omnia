import { describe, expect, it } from "vitest";

import { buildContextEstimate, contextEstimateInline } from "./context-estimate";

describe("context estimate evidence contract", () => {
  it("labels numeric renderer calculations as heuristic", () => {
    const estimate = buildContextEstimate({ estimatedTokens: 1240, projectHealth: "ready" });
    expect(estimate).toMatchObject({
      status: "heuristic",
      tokens: 1240,
      source: "renderer-heuristic",
    });
    expect(contextEstimateInline(estimate, 3200)).toMatch(/Heuristic/);
  });

  it("withholds the aggregate estimate when access is blocked", () => {
    const estimate = buildContextEstimate({ estimatedTokens: 1240, projectHealth: "missing-access" });
    expect(estimate).toMatchObject({
      status: "withheld",
      tokens: null,
      source: "not-available",
    });
    expect(contextEstimateInline(estimate)).toMatch(/Withheld/);
  });

  it("withholds aggregate admission when the preview is over budget", () => {
    const estimate = buildContextEstimate({ estimatedTokens: 6400, projectHealth: "over-budget" });
    expect(estimate).toMatchObject({
      status: "withheld",
      tokens: null,
      source: "not-available",
    });
    expect(estimate.reason).toMatch(/over the preview budget/i);
  });

  it("keeps absent estimates unknown instead of converting them to zero", () => {
    const estimate = buildContextEstimate({ estimatedTokens: null, projectHealth: "ready" });
    expect(estimate).toMatchObject({
      status: "unknown",
      tokens: null,
      source: "not-available",
    });
  });
});
