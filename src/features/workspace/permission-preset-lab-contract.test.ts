import { describe, expect, it } from "vitest";

import {
  DEFAULT_PERMISSION_PRESET_LAB_DRAFT,
  PERMISSION_PRESET_LAB_SCHEMA,
  parsePermissionPresetLab,
  permissionPresetExpiryLabel,
  permissionPresetLabDiff,
  permissionPresetQuotaLabel,
  permissionPresetScopeLabel,
  safePermissionPresetLabPayload,
  serializePermissionPresetLab,
} from "./permission-preset-lab-contract";

describe("permission preset lifecycle contract", () => {
  it("serializes a scoped lifecycle preview without native authority", () => {
    const draft = {
      ...DEFAULT_PERMISSION_PRESET_LAB_DRAFT,
      presetId: "allow-all",
      permissionScope: "project" as const,
      scopeMode: "all" as const,
      expiry: "one-hour" as const,
      quota: "daily" as const,
      quotaValue: 12,
      state: "staged" as const,
    };
    const payload = safePermissionPresetLabPayload(draft);

    expect(payload.scope).toBe(PERMISSION_PRESET_LAB_SCHEMA);
    expect(payload.presetLabel).toMatch(/Allow all/);
    expect(payload.scopeMode).toBe("all");
    expect(payload.lifecycle).toMatchObject({ state: "staged", expiry: "one-hour", quota: "daily", quotaValue: 12 });
    expect(payload.boundary).toMatch(/no native grant/i);
    expect(permissionPresetScopeLabel(draft)).toBe("All preview scopes");
    expect(permissionPresetExpiryLabel(draft)).toBe("1 hour");
    expect(permissionPresetQuotaLabel(draft)).toBe("12 actions / day");
  });

  it("round-trips JSON and rejects an unrelated schema", () => {
    const draft = { ...DEFAULT_PERMISSION_PRESET_LAB_DRAFT, note: "review before use" };
    const raw = serializePermissionPresetLab(draft, "json");
    expect(parsePermissionPresetLab(raw)).toMatchObject({ presetId: "balanced", note: "review before use" });
    expect(parsePermissionPresetLab(JSON.stringify({ scope: "other", version: 1 }))).toBeNull();
  });

  it("round-trips the portable Markdown lifecycle preview", () => {
    const draft = {
      ...DEFAULT_PERMISSION_PRESET_LAB_DRAFT,
      presetId: "research",
      permissionScope: "project" as const,
      scopeMode: "all" as const,
      expiry: "custom" as const,
      customExpiry: "2026-09-30T12:00",
      quota: "daily" as const,
      quotaValue: 8,
      audit: "verbose" as const,
      revoke: "on-expiry" as const,
      state: "staged" as const,
      note: "reviewed Markdown import",
    };
    const parsed = parsePermissionPresetLab(serializePermissionPresetLab(draft, "markdown"));
    expect(parsed).toMatchObject(draft);
  });

  it("normalizes invalid lifecycle values to safe defaults while preserving valid custom values", () => {
    const parsed = parsePermissionPresetLab(JSON.stringify({
      scope: PERMISSION_PRESET_LAB_SCHEMA,
      version: 1,
      presetId: "research",
      permissionScope: "chat",
      scopeMode: "selected",
      lifecycle: { expiry: "custom", customExpiry: "2026-09-21T12:00", quota: "custom", quotaValue: 7, audit: "verbose", revoke: "on-error" },
      note: "test",
    }));
    expect(parsed).toMatchObject({ presetId: "research", permissionScope: "chat", expiry: "custom", customExpiry: "2026-09-21T12:00", quota: "custom", quotaValue: 7, audit: "verbose", revoke: "on-error" });
    expect(parsePermissionPresetLab(JSON.stringify({ scope: PERMISSION_PRESET_LAB_SCHEMA, version: 1, presetId: "unknown" }))).toBeNull();
  });

  it("describes renderer-session changes without implying native policy mutation", () => {
    const before = DEFAULT_PERMISSION_PRESET_LAB_DRAFT;
    const after = { ...before, quota: "daily" as const, quotaValue: 12, state: "staged" as const };
    expect(permissionPresetLabDiff(before, after)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Quota", before: "No quota", after: "Daily quota" }),
      expect.objectContaining({ label: "Quota amount", before: "100", after: "12" }),
      expect.objectContaining({ label: "Lifecycle state", before: "draft", after: "staged" }),
    ]));
  });
});
