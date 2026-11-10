import { afterEach, describe, expect, it } from "vitest";

import {
  applySessionPalettePreview,
  clearSessionPalettePreview,
  isSessionPalettePreviewActive,
  readableDarkAccent,
} from "./session-palette-preview";

afterEach(() => clearSessionPalettePreview());

describe("reversible dark-only palette trial", () => {
  it("applies a palette without changing durable storage or generated theme tokens", () => {
    const root = document.documentElement;
    applySessionPalettePreview(["#2563EB", "#0F766E", "#D97706", "#E11D48"]);
    expect(isSessionPalettePreviewActive()).toBe(true);
    expect(root.style.getPropertyValue("--omnia-session-primary")).toMatch(/^#[0-9A-F]{6}$/);
    expect(root.style.getPropertyValue("--omnia-session-support")).toMatch(/^#[0-9A-F]{6}$/);
    expect(root.style.getPropertyValue("--brand")).toBe("");
    clearSessionPalettePreview();
    expect(isSessionPalettePreviewActive()).toBe(false);
    expect(root.style.getPropertyValue("--omnia-session-primary")).toBe("");
  });

  it("lifts a dim dark-theme accent and rejects invalid imported role colors", () => {
    expect(readableDarkAccent("#000000")).not.toBe("#000000");
    expect(readableDarkAccent("#D6DEE8")).toBe("#D6DEE8");
    expect(() => applySessionPalettePreview(["red", "#0F766E", "#D97706", "#E11D48"])).toThrow();
    expect(isSessionPalettePreviewActive()).toBe(false);
  });
});
