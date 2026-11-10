import { describe, expect, it } from "vitest";

import {
  createFeatureFlag,
  type FeatureFlagDefinition,
} from "../domain/omnia-feature-flags";
import { createOmniaRuntimeController } from "./omnia-runtime-controller";

const now = "2026-10-17T00:00:00.000Z";

function booleanFlag(
  key: string,
  defaultValue = false,
  prerequisites: FeatureFlagDefinition["prerequisites"] = [],
): FeatureFlagDefinition {
  return createFeatureFlag({
    key,
    name: key,
    kind: "boolean",
    defaultValue,
    prerequisites,
  }, now);
}

describe("Omnia runtime controller feature flags", () => {
  it("mutates the registry atomically and records undoable configuration events", () => {
    const controller = createOmniaRuntimeController({ now: () => now });

    controller.upsertFeatureFlag(booleanFlag("chat.streaming", true));
    expect(controller.getSnapshot().featureFlags.flags.map((flag) => flag.key)).toEqual(["chat.streaming"]);
    expect(controller.getSnapshot().events.events.at(-1)).toMatchObject({
      kind: "system",
      type: "feature-flag.upserted",
      payload: { key: "chat.streaming" },
    });

    controller.setFeatureFlagState("CHAT.STREAMING", "disabled");
    expect(controller.getFeatureFlag("chat.streaming")).toMatchObject({
      state: "disabled",
      revision: 2,
    });
    expect(controller.evaluateFeatureFlag("chat.streaming").source).toBe("disabled");

    controller.setFeatureFlagRollout("chat.streaming", 25);
    expect(controller.getFeatureFlag("chat.streaming")).toMatchObject({
      rolloutPercentage: 25,
      revision: 3,
    });

    controller.undo();
    const undone = controller.getFeatureFlag("chat.streaming");
    expect(undone).toMatchObject({ revision: 2 });
    expect(undone).not.toHaveProperty("rolloutPercentage");
    controller.redo();
    expect(controller.getFeatureFlag("chat.streaming")).toMatchObject({ rolloutPercentage: 25 });
  });

  it("evaluates selected/all flags and exposes registry health without mutating state", () => {
    const controller = createOmniaRuntimeController({ now: () => now });
    controller.upsertFeatureFlag(booleanFlag("provider.ready", true));
    controller.upsertFeatureFlag(booleanFlag("chat.streaming", false, [{ key: "provider.ready", expected: true }]));

    const before = controller.getSnapshot();
    expect(controller.evaluateFeatureFlags(["CHAT.STREAMING", "provider.ready", "chat.streaming"]).map((item) => item.key))
      .toEqual(["chat.streaming", "provider.ready"]);
    expect(controller.evaluateAllFeatureFlags()["chat.streaming"]).toMatchObject({
      found: true,
      source: "default",
      value: false,
    });
    expect(controller.getFeatureFlagSummary()).toMatchObject({
      schema: "omnia.feature-flags.summary.v1",
      total: 2,
      active: 2,
    });
    expect(controller.inspectFeatureFlagRegistry()).toMatchObject({ healthy: true, flagCount: 2 });
    expect(controller.getSnapshot().revision).toBe(before.revision);
  });

  it("removes a flag and restores it through controller history", () => {
    const controller = createOmniaRuntimeController({ now: () => now });
    controller.upsertFeatureFlag(booleanFlag("editor.preview", true));

    controller.removeFeatureFlag("EDITOR.PREVIEW");
    expect(controller.getFeatureFlag("editor.preview")).toBeUndefined();
    expect(controller.evaluateFeatureFlag("editor.preview")).toMatchObject({
      found: false,
      source: "missing",
    });

    controller.undo();
    expect(controller.getFeatureFlag("editor.preview")).toMatchObject({ defaultValue: true });
    controller.redo();
    expect(controller.getFeatureFlag("editor.preview")).toBeUndefined();
  });
});
