import { describe, expect, it } from "vitest";
import {
  REASONING_EFFORTS,
  highestSupportedEffort,
  resolveReasoningEffort,
} from "./effort-resolution";

describe("resolveReasoningEffort", () => {
  it("represents all eight persisted request values", () => {
    expect(REASONING_EFFORTS).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("accepts a directly advertised effort", () => {
    const result = resolveReasoningEffort("high", { supportedEfforts: ["low", "high"], source: "native:test" });
    expect(result).toMatchObject({ requested: "high", effective: "high", status: "supported" });
    expect(result.evidence).toMatchObject({ source: "explicit-list", supportsRequested: true, capabilitySource: "native:test" });
  });

  it("rejects a requested effort that is not advertised", () => {
    const result = resolveReasoningEffort("xhigh", { supportedEfforts: ["low", "high"] });
    expect(result.status).toBe("unsupported");
    expect(result.effective).toBeNull();
    expect(result.evidence.supportsRequested).toBe(false);
  });

  it("resolves ultra to the highest explicit capability", () => {
    const result = resolveReasoningEffort("ultra", { supportedEfforts: ["low", "xhigh", "medium"] });
    expect(result).toMatchObject({ requested: "ultra", effective: "xhigh", status: "ultra-resolved" });
    expect(result.evidence.dynamicWorkflow).toBe(true);
  });

  it("derives an ordered range from a documented maximum", () => {
    const result = resolveReasoningEffort("high", { maxEffort: "high" });
    expect(result.status).toBe("supported");
    expect(result.evidence.supportedEfforts).toEqual(["none", "minimal", "low", "medium", "high"]);
    expect(highestSupportedEffort({ maxEffort: "high" })).toBe("high");
  });

  it("keeps reasoning-disabled models at the no-op baseline", () => {
    expect(resolveReasoningEffort("none", { reasoning: false }).status).toBe("supported");
    expect(resolveReasoningEffort("low", { reasoning: false }).status).toBe("unsupported");
  });

  it("does not infer high effort from an unknown capability payload", () => {
    const result = resolveReasoningEffort("high", {});
    expect(result.status).toBe("unsupported");
    expect(result.evidence.source).toBe("none");
    expect(highestSupportedEffort({})).toBeNull();
  });

  it("records the baseline explicitly when reasoning is known but unqualified", () => {
    const result = resolveReasoningEffort("none", { reasoning: true, source: "catalog" });
    expect(result.status).toBe("supported");
    expect(result.evidence.source).toBe("baseline-none");
    expect(result.evidence.explanation).toContain("advertised");
  });

  it("rejects unknown and malformed requests without throwing", () => {
    for (const value of ["MAX", "", null, 7, {}, "super"]) {
      const result = resolveReasoningEffort(value);
      expect(result.status).toBe("invalid");
      expect(result.requested).toBeNull();
      expect(result.effective).toBeNull();
    }
  });

  it("deduplicates and deterministically orders explicit capabilities", () => {
    const result = resolveReasoningEffort("ultra", { supportedEfforts: ["max", "low", "low", "none", "bad", "medium"] });
    expect(result.effective).toBe("max");
    expect(result.evidence.supportedEfforts).toEqual(["none", "low", "medium", "max"]);
  });

  it("keeps ultra unresolved when no effective capability is known", () => {
    const result = resolveReasoningEffort("ultra");
    expect(result).toMatchObject({ status: "unsupported", requested: "ultra", effective: null });
    expect(result.evidence.dynamicWorkflow).toBe(true);
  });
});
