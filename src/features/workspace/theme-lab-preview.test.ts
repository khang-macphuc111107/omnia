import { describe, expect, it } from "vitest";

import {
  buildThemeLabSnapshot,
  contrastRatio,
  relativeLuminance,
  themeLabSurfaceLabel,
} from "./theme-lab-preview-contract";

describe("Theme Lab preview contract", () => {
  it("calculates stable WCAG-style luminance and contrast values", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#FFFFFF")).toBe(1);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
  });

  it("summarizes a varied dark-first palette without claiming durable validation", () => {
    const snapshot = buildThemeLabSnapshot(
      ["#2563EB", "#0F766E", "#D97706", "#E11D48"],
      "graphite",
    );

    expect(snapshot.surfaceColor).toBe("#111923");
    expect(snapshot.checks).toHaveLength(4);
    expect(snapshot.diversityLabel).toBe("Expressive");
    expect(snapshot.passingChecks).toBeGreaterThanOrEqual(1);
    expect(snapshot.recommendation).toMatch(/spectrum/i);
    expect(themeLabSurfaceLabel("ink")).toBe("Ink");
  });

  it("keeps simulated vision modes explicit and deterministic", () => {
    const normal = buildThemeLabSnapshot(
      ["#2563EB", "#0F766E", "#D97706", "#E11D48"],
      "ink",
      "default",
    );
    const simulated = buildThemeLabSnapshot(
      ["#2563EB", "#0F766E", "#D97706", "#E11D48"],
      "ink",
      "protanopia",
    );

    expect(simulated.vision).toBe("protanopia");
    expect(simulated.checks[0]?.displayColor).not.toBe(normal.checks[0]?.displayColor);
    expect(simulated.checks.every((check) => check.displayColor.startsWith("#"))).toBe(true);
  });
});
