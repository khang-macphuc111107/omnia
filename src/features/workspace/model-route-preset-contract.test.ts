import { describe, expect, it } from "vitest";

import {
  BUILT_IN_MODEL_ROUTE_PRESETS,
  MODEL_ROUTE_PRESET_SCHEMA,
  parseModelRoutePresetPreviewImport,
  serializeModelRoutePresetPreview,
} from "./model-route-preset-contract";

describe("model route preset contract", () => {
  it("serializes a bounded JSON and Markdown preview with an explicit boundary", () => {
    const json = serializeModelRoutePresetPreview(BUILT_IN_MODEL_ROUTE_PRESETS, "route-general", "json");
    expect(json).toContain(MODEL_ROUTE_PRESET_SCHEMA);
    expect(json).toContain("No provider request, fallback attempt, or context freeze was dispatched");

    const markdown = serializeModelRoutePresetPreview(BUILT_IN_MODEL_ROUTE_PRESETS, "route-general", "markdown");
    expect(markdown).toContain("# Omnia model route preset preview");
    expect(markdown).toContain("Research · Grounded");
  });

  it("fails closed on unsupported or unsafe imports and accepts a valid preview", () => {
    expect(parseModelRoutePresetPreviewImport("not-json")).toEqual({ ok: false, reason: "Import must be valid JSON." });
    expect(parseModelRoutePresetPreviewImport(JSON.stringify({ schema: MODEL_ROUTE_PRESET_SCHEMA, presets: [] }))).toEqual({
      ok: false,
      reason: "This is not a supported Omnia model route preset preview bundle.",
    });

    const payload = JSON.stringify({
      schema: MODEL_ROUTE_PRESET_SCHEMA,
      scope: "renderer-session",
      executionDisposition: "preview-only",
      currentPresetId: "route-general",
      presets: [{
        id: "incoming",
        name: "Imported CSE route",
        description: "Reviewable route draft",
        tone: "custom",
        modelProfileId: "quality",
        preference: "quality",
        consent: "never",
        contextMode: "summary-plus-sources",
        reasoningEffort: "high",
        dataResidency: "same-region",
        qualityFloor: 80,
        maxLatencyMs: 1200,
      }],
      boundary: [],
    });
    const result = parseModelRoutePresetPreviewImport(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.presets[0]).toMatchObject({ name: "Imported CSE route", custom: true, tone: "custom" });
    }
  });
});
