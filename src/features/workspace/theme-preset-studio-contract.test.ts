import { describe, expect, it } from "vitest";

import {
  buildThemePresetBundle,
  parseThemePresetBundle,
  serializeThemePresetBundle,
  themePresetDifferenceKeys,
  THEME_PRESET_SCHEMA,
  type ThemePreset,
} from "./theme-preset-studio-contract";

const preset: ThemePreset = {
  id: "theme-coder",
  name: "Coder Night",
  description: "Dark-first coding surface.",
  tags: ["coding", "dark"],
  logoId: "logo-01-open-aperture",
  logoName: "Open aperture",
  paletteName: "Tidal Spectrum",
  surface: "graphite",
  geometry: "soft",
  signal: "soft-glow",
  energy: "balanced",
  roleColors: ["#2563EB", "#0F766E", "#D97706", "#E11D48"],
  source: "session",
  status: "preview",
  updatedAt: "2026-09-27T00:00:00.000Z",
};

describe("theme preset studio contract", () => {
  it("builds a truthful renderer-session bundle and serializes JSON/Markdown", () => {
    const bundle = buildThemePresetBundle({ presets: [preset], selectedPresetId: preset.id, generatedAt: "2026-09-27T00:00:00.000Z" });
    expect(bundle.schema).toBe(THEME_PRESET_SCHEMA);
    expect(bundle.boundary.noNativeThemeMutation).toBe(true);
    expect(JSON.parse(serializeThemePresetBundle(bundle)).selectedPresetId).toBe("theme-coder");
    expect(serializeThemePresetBundle(bundle, "markdown")).toMatch(/Preview only/);
  });

  it("round-trips valid JSON and rejects invalid schema or malformed colors", () => {
    const bundle = buildThemePresetBundle({ presets: [preset], selectedPresetId: preset.id });
    const parsed = parseThemePresetBundle(serializeThemePresetBundle(bundle));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.bundle.presets[0]?.roleColors[0]).toBe("#2563EB");

    expect(parseThemePresetBundle(JSON.stringify({ ...bundle, schema: "other" }))).toEqual({ ok: false, error: "Unsupported Omnia theme preset schema or version." });
    expect(parseThemePresetBundle(JSON.stringify({ ...bundle, presets: [{ ...preset, roleColors: ["purple", "#0F766E", "#D97706", "#E11D48"] }] }))).toEqual({ ok: false, error: "Theme preset 1 is invalid." });
  });

  it("reports style differences without treating role-color differences as structural metadata", () => {
    const other = { ...preset, surface: "ink" as const, geometry: "sharp" as const, roleColors: ["#38BDF8", "#0E9ED5", "#F5B94C", "#6EE7B7"] as ThemePreset["roleColors"] };
    expect(themePresetDifferenceKeys(preset, other)).toEqual(["surface", "geometry"]);
  });
});
