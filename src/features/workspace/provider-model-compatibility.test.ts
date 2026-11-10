import { describe, expect, it } from "vitest";

import { buildCompatibilityRows, evaluateModelCompatibility } from "./provider-model-compatibility";
import { initialProviders } from "./mock-data";

describe("provider model compatibility contract", () => {
  it("blocks undeclared capabilities in strict mode and keeps them reviewable in advisory mode", () => {
    const provider = initialProviders[0]!;
    const model = provider.models[0]!;
    const strict = evaluateModelCompatibility(provider, model, "strict");
    const advisory = evaluateModelCompatibility(provider, model, "advisory");

    expect(strict.tools).toBe(model.capabilities.includes("tools") ? "review" : "blocked");
    expect(advisory.tools).toBe(model.capabilities.includes("tools") ? "review" : "review");
  });

  it("emits one compatibility row per visible provider model with summary counts", () => {
    const rows = buildCompatibilityRows(initialProviders, "strict");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ providerName: expect.any(String), compatibleCount: expect.any(Number), blockedCount: expect.any(Number) });
    expect(rows[0]!.compatibleCount + rows[0]!.reviewCount + rows[0]!.blockedCount).toBe(5);
  });
});
