import { describe, expect, it } from "vitest";

import {
  parseProjectAdvancedSettings,
  PROJECT_ADVANCED_SETTINGS_SCHEMA,
  PROJECT_ADVANCED_DEFAULTS,
  serializeProjectAdvancedSettings,
} from "./project-advanced-settings-contract";

describe("project advanced settings contract", () => {
  it("round-trips the portable envelope and keeps only the typed vector", () => {
    const envelope = serializeProjectAdvancedSettings("project-1", "Research", {
      ...PROJECT_ADVANCED_DEFAULTS,
      route: "quality-first",
      contextMode: "selected-files",
    });

    expect(envelope.schema).toBe(PROJECT_ADVANCED_SETTINGS_SCHEMA);
    expect(parseProjectAdvancedSettings(envelope)).toMatchObject({
      route: "quality-first",
      contextMode: "selected-files",
    });
  });

  it("fails closed on a foreign schema and normalizes malformed fields to safe defaults", () => {
    expect(parseProjectAdvancedSettings({ schema: "foreign.v9", route: "quality-first" })).toBeNull();
    expect(parseProjectAdvancedSettings({ schema: PROJECT_ADVANCED_SETTINGS_SCHEMA, settings: {} })).toBeNull();
    expect(parseProjectAdvancedSettings({ route: "unknown", accent: "url(https://example.invalid)" })).toMatchObject({
      route: PROJECT_ADVANCED_DEFAULTS.route,
      accent: PROJECT_ADVANCED_DEFAULTS.accent,
    });
  });
});
