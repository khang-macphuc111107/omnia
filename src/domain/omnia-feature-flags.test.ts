import { describe, expect, it } from "vitest";

import {
  createFeatureFlag,
  createFeatureFlagRegistry,
  evaluateAllFeatureFlags,
  evaluateFeatureFlags,
  inspectFeatureFlagRegistry,
  type FeatureFlagDefinition,
} from "./omnia-feature-flags";

const updatedAt = "2026-10-17T00:00:00.000Z";

function booleanFlag(key: string, defaultValue = false, prerequisites: FeatureFlagDefinition["prerequisites"] = []) {
  return createFeatureFlag({
    key,
    name: key,
    kind: "boolean",
    defaultValue,
    prerequisites,
  }, updatedAt);
}

describe("Omnia feature flag batch evaluation", () => {
  it("deduplicates keys without changing first-seen order", () => {
    const registry = createFeatureFlagRegistry([
      booleanFlag("chat.streaming", true),
      booleanFlag("editor.preview", false),
    ]);

    const evaluations = evaluateFeatureFlags(registry, ["CHAT.STREAMING", "editor.preview", "chat.streaming"]);
    expect(evaluations.map((evaluation) => evaluation.key)).toEqual(["chat.streaming", "editor.preview"]);
    expect(evaluations.map((evaluation) => evaluation.value)).toEqual([true, false]);
  });

  it("evaluates the complete registry into a stable key map", () => {
    const registry = createFeatureFlagRegistry([
      booleanFlag("chat.streaming", true),
      booleanFlag("editor.preview", false),
    ]);

    const evaluations = evaluateAllFeatureFlags(registry);
    expect(Object.keys(evaluations)).toEqual(["chat.streaming", "editor.preview"]);
    expect(evaluations["chat.streaming"]?.enabled).toBe(true);
    expect(evaluations["editor.preview"]?.source).toBe("default");
  });
});

describe("Omnia feature flag registry health", () => {
  it("reports missing prerequisite references", () => {
    const registry = createFeatureFlagRegistry([
      booleanFlag("chat.streaming", false, [{ key: "provider.ready", expected: true }]),
    ]);

    const health = inspectFeatureFlagRegistry(registry);
    expect(health.healthy).toBe(false);
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "missing-prerequisite",
        flagKey: "chat.streaming",
        prerequisiteKey: "provider.ready",
      }),
    ]));
  });

  it("reports prerequisite cycles without throwing", () => {
    const first = booleanFlag("flag.a", false, [{ key: "flag.b", expected: true }]);
    const second = booleanFlag("flag.b", false, [{ key: "flag.a", expected: true }]);
    const health = inspectFeatureFlagRegistry(createFeatureFlagRegistry([first, second]));

    expect(health.healthy).toBe(false);
    expect(health.issues.some((issue) => issue.kind === "prerequisite-cycle")).toBe(true);
  });
});
