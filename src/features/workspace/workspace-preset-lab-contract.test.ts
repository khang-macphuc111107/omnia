import { describe, expect, it } from "vitest";

import {
  buildWorkspacePresetBundle,
  findWorkspacePresetImportConflicts,
  parseWorkspacePresetBundle,
  serializeWorkspacePresetBundle,
  WORKSPACE_PRESET_SCHEMA,
  type WorkspacePreset,
} from "./workspace-preset-lab-contract";

const preset: WorkspacePreset = {
  id: "coder",
  name: "Coder",
  kind: "workspace",
  description: "A coding preview",
  tags: ["coding", "dark"],
  updatedAt: "2026-09-21T00:00:00.000Z",
  values: { Theme: "Dark", Route: "Balanced" },
  status: "preview",
  source: "session",
};

describe("workspace preset lab contract", () => {
  it("builds a bounded renderer-session bundle and serializes JSON/Markdown", () => {
    const bundle = buildWorkspacePresetBundle({ presets: [preset], selectedPresetId: preset.id, generatedAt: "2026-09-21T00:00:00.000Z" });
    expect(bundle.schema).toBe(WORKSPACE_PRESET_SCHEMA);
    expect(bundle.boundary.noDurableWrite).toBe(true);
    expect(JSON.parse(serializeWorkspacePresetBundle(bundle, "json")).selectedPresetId).toBe("coder");
    expect(serializeWorkspacePresetBundle(bundle, "markdown")).toMatch(/Preview only/);
  });

  it("round-trips a bundle and rejects unsupported or oversized input", () => {
    const bundle = buildWorkspacePresetBundle({ presets: [preset], selectedPresetId: preset.id });
    const parsed = parseWorkspacePresetBundle(serializeWorkspacePresetBundle(bundle));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.bundle.presets[0]?.name).toBe("Coder");

    const wrongSchema = parseWorkspacePresetBundle(JSON.stringify({ ...bundle, schema: "other" }));
    expect(wrongSchema).toEqual({ ok: false, error: "Unsupported Omnia preset schema or version." });

    const tooLarge = parseWorkspacePresetBundle(`{"schema":"${WORKSPACE_PRESET_SCHEMA}","version":1,"scope":"renderer-session","generatedAt":"2026-09-21T00:00:00.000Z","selectedPresetId":"","presets":[],"padding":"${"x".repeat(512 * 1024)}"}`);
    expect(tooLarge.ok).toBe(false);
  });

  it("detects ID and name/category conflicts while keeping built-ins immutable", () => {
    const builtin: WorkspacePreset = { ...preset, id: "builtin-coder", source: "builtin" };
    const sessionCopy: WorkspacePreset = { ...preset, id: "session-coder", source: "session", name: "Review desk" };
    const incoming: WorkspacePreset[] = [
      { ...preset, id: "builtin-coder", name: "Imported coder", source: "imported" },
      { ...preset, id: "new-id", name: "Review desk", source: "imported" },
    ];
    const conflicts = findWorkspacePresetImportConflicts([builtin, sessionCopy], incoming);
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]).toMatchObject({ reason: "matching-id", canReplace: false });
    expect(conflicts[1]).toMatchObject({ reason: "matching-name-and-kind", canReplace: true });
  });
});
