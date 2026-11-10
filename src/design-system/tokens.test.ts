import { describe, expect, it } from "vitest";

import {
  BREAKPOINTS,
  DENSITY_TARGETS,
  NARROW_SHELL_MEDIA_QUERY,
  maxWidthMediaQuery,
} from "./tokens.generated";

describe("generated design-token contracts", () => {
  it("keeps shell breakpoints ordered and derives the runtime media query", () => {
    expect(BREAKPOINTS.minimum).toBeLessThan(BREAKPOINTS.compact);
    expect(BREAKPOINTS.compact).toBeLessThan(BREAKPOINTS.inspectorOverlay);
    expect(BREAKPOINTS.inspectorOverlay).toBeLessThan(BREAKPOINTS.wide);
    expect(NARROW_SHELL_MEDIA_QUERY).toBe(maxWidthMediaQuery(BREAKPOINTS.compact));
  });

  it("keeps every density target at or above the compact interaction floor", () => {
    expect(DENSITY_TARGETS).toEqual({ compact: 32, comfortable: 40, touch: 44 });
    expect(DENSITY_TARGETS.compact).toBeLessThan(DENSITY_TARGETS.comfortable);
    expect(DENSITY_TARGETS.comfortable).toBeLessThan(DENSITY_TARGETS.touch);
  });
});
