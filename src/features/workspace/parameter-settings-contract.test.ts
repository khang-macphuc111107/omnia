import { describe, expect, it } from "vitest";

import {
  DEFAULT_PARAMETER_SETTINGS,
  PARAMETER_SETTINGS_FIELDS,
  PARAMETER_SETTINGS_GROUPS,
  changedParameterKeys,
  createDefaultParameterSettings,
  createParameterSettingsBundle,
  importParameterSettings,
  parameterFieldsForGroup,
  resetParameterGroup,
  resetParameterSetting,
  serializeParameterSettings,
} from "./parameter-settings-contract";

describe("parameter settings contract", () => {
  it("declares every ParameterSettings key exactly once", () => {
    const keys = PARAMETER_SETTINGS_FIELDS.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(Object.keys(DEFAULT_PARAMETER_SETTINGS).length);
  });

  it("keeps groups ordered and exposes compact versus advanced controls", () => {
    expect(PARAMETER_SETTINGS_GROUPS.map((group) => group.order)).toEqual([10, 20, 30, 40, 50, 60]);
    expect(parameterFieldsForGroup("sampling", { advanced: false }).map((field) => field.key)).toEqual([
      "temperature",
      "topP",
    ]);
    expect(parameterFieldsForGroup("sampling", { advanced: true }).map((field) => field.key)).toEqual([
      "topK",
      "minP",
      "frequencyPenalty",
      "presencePenalty",
      "seed",
      "stopSequences",
    ]);
  });

  it("resets a single setting or a whole group without mutating the input", () => {
    const input = {
      ...createDefaultParameterSettings(),
      temperature: 1.4,
      topP: 0.4,
      topK: 64,
      maxOutputTokens: 2048,
    };

    const single = resetParameterSetting(input, "temperature");
    expect(single.temperature).toBe(DEFAULT_PARAMETER_SETTINGS.temperature);
    expect(input.temperature).toBe(1.4);

    const sampling = resetParameterGroup(input, "sampling");
    expect(sampling.temperature).toBe(DEFAULT_PARAMETER_SETTINGS.temperature);
    expect(sampling.topP).toBe(DEFAULT_PARAMETER_SETTINGS.topP);
    expect(sampling.topK).toBe(DEFAULT_PARAMETER_SETTINGS.topK);
    expect(sampling.maxOutputTokens).toBe(2048);
    expect(changedParameterKeys(sampling)).toEqual(["maxOutputTokens"]);
  });

  it("round-trips a versioned bundle", () => {
    const parameters = {
      ...createDefaultParameterSettings(),
      temperature: 1.1,
      jsonMode: true,
      stopSequences: "END\nDONE",
    };
    const serialized = serializeParameterSettings(parameters, {
      scope: "project",
      name: "Research defaults",
      exportedAt: "2026-09-16T00:00:00.000Z",
    });

    const bundle = createParameterSettingsBundle(parameters, {
      scope: "project",
      name: "Research defaults",
      exportedAt: "2026-09-16T00:00:00.000Z",
    });
    expect(bundle.scope).toBe("project");
    expect(bundle.parameters).toEqual(parameters);

    const imported = importParameterSettings(serialized);
    expect(imported.ok).toBe(true);
    expect(imported.sourceVersion).toBe(1);
    expect(imported.parameters).toEqual(parameters);
    expect(imported.changedKeys).toEqual(["temperature", "stopSequences", "jsonMode"]);
    expect(imported.errors).toEqual([]);
  });

  it("accepts a flat object, warns on unknown fields, and preserves the baseline for invalid values", () => {
    const baseline = createDefaultParameterSettings();
    const imported = importParameterSettings(
      {
        temperature: 1.25,
        maxOutputTokens: 0,
        futureControl: true,
      },
      baseline,
    );

    expect(imported.ok).toBe(false);
    expect(imported.parameters.temperature).toBe(1.25);
    expect(imported.parameters.maxOutputTokens).toBe(baseline.maxOutputTokens);
    expect(imported.changedKeys).toEqual(["temperature"]);
    expect(imported.warnings.join(" ")).toContain("futureControl");
    expect(imported.errors.join(" ")).toContain("maxOutputTokens");
  });

  it("rejects malformed JSON and bundles newer than the current schema", () => {
    const malformed = importParameterSettings("{not-json");
    expect(malformed.ok).toBe(false);
    expect(malformed.errors[0]).toContain("invalid");

    const future = importParameterSettings({
      kind: "omnia.parameter-settings",
      schemaVersion: 99,
      parameters: { temperature: 1 },
    });
    expect(future.ok).toBe(false);
    expect(future.sourceVersion).toBe(99);
    expect(future.errors.join(" ")).toContain("newer");
  });
});
