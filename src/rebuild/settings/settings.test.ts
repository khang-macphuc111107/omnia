import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_REBUILD_SETTINGS, SETTINGS_STORAGE_KEY, normalizeRebuildSettings, parseStoredSettings, rebuildSettingsStore, serializeSettings } from "./settings";

describe("rebuild settings contract", () => {
  beforeEach(() => { window.localStorage?.clear?.(); rebuildSettingsStore.reset(); });
  it("keeps requested context and retry defaults", () => {
    const settings = rebuildSettingsStore.get();
    expect(settings.context.compactTokens).toBe(200_000);
    expect(settings.context.toolOutputTokens).toBe(10_000);
    expect(settings.retry.delaySeconds).toBe(5);
    expect(settings.retry.multiplier).toBe(1);
    expect(settings.retry.maxAttempts).toBe(0);
  });
  it("normalizes corrupt, partial and unsafe values without throwing", () => {
    const settings = normalizeRebuildSettings({ context: { compactTokens: -4, toolOutputTokens: Infinity }, retry: { multiplier: 40 }, privacyPermissions: { allowOsAutomation: "yes" } });
    expect(settings.context.compactTokens).toBe(10_000);
    expect(settings.context.toolOutputTokens).toBe(10_000);
    expect(settings.retry.multiplier).toBe(10);
    expect(settings.privacyPermissions.allowOsAutomation).toBe(false);
  });
  it("round-trips versioned JSON and rejects malformed data to defaults", () => {
    const raw = serializeSettings({ ...DEFAULT_REBUILD_SETTINGS, model: { ...DEFAULT_REBUILD_SETTINGS.model, defaultEffort: "ultra" } });
    expect(parseStoredSettings(raw).model.defaultEffort).toBe("ultra");
    expect(parseStoredSettings("{not json")).toEqual(DEFAULT_REBUILD_SETTINGS);
  });
  it("persists updates and emits a subscription notification", () => {
    let calls = 0; const unsubscribe = rebuildSettingsStore.subscribe(() => { calls += 1; });
    rebuildSettingsStore.update((current) => ({ ...current, theme: "light" })); unsubscribe();
    expect(rebuildSettingsStore.get().theme).toBe("light");
    const persisted = typeof window.localStorage?.getItem === "function" ? window.localStorage.getItem(SETTINGS_STORAGE_KEY) : rebuildSettingsStore.exportSettings();
    expect(JSON.parse(persisted ?? "{}").theme).toBe("light");
    expect(calls).toBeGreaterThan(0);
  });
  it("clamps workflow passes to the finite 0-10 brainstorm contract", () => {
    expect(normalizeRebuildSettings({ workflow: { brainstormPasses: 99, planPasses: -3 } }).workflow).toMatchObject({ brainstormPasses: 10, planPasses: 0 });
  });
  it("accepts ultra as a workflow policy while preserving provider-safe values", () => {
    const settings = normalizeRebuildSettings({ model: { defaultEffort: "ultra", ultraDynamicWorkflow: true } });
    expect(settings.model.defaultEffort).toBe("ultra");
    expect(settings.model.ultraDynamicWorkflow).toBe(true);
    expect(normalizeRebuildSettings({ model: { defaultEffort: "unsupported" } }).model.defaultEffort).toBe("high");
  });
  it("round-trips a discovered provider and full native-length model ID without restart", () => {
    const modelId = "model-" + "x".repeat(480);
    rebuildSettingsStore.update((current) => ({ ...current, model: { ...current.model, providerProfileId: "native-profile", defaultModel: modelId } }));
    expect(rebuildSettingsStore.get().model).toMatchObject({ providerProfileId: "native-profile", defaultModel: modelId });
    expect(parseStoredSettings(rebuildSettingsStore.exportSettings()).model).toMatchObject({ providerProfileId: "native-profile", defaultModel: modelId });
    expect(normalizeRebuildSettings({ model: { providerProfileId: "profile\ninvalid", defaultModel: "model\u0000invalid" } }).model).toMatchObject({ providerProfileId: "", defaultModel: "auto" });
  });
  it("persists an accepted newer cross-tab revision and rejects stale updates", () => {
    const unsubscribe = rebuildSettingsStore.subscribe(() => undefined);
    const newer = JSON.stringify({ ...DEFAULT_REBUILD_SETTINGS, theme: "light", ["__omniaMeta"]: { revision: 999, writerId: "remote-window", updatedAt: new Date().toISOString() } });
    window.dispatchEvent(new StorageEvent("storage", { key: SETTINGS_STORAGE_KEY, newValue: newer }));
    expect(rebuildSettingsStore.get().theme).toBe("light");
    const persisted = window.localStorage?.getItem?.(SETTINGS_STORAGE_KEY);
    if (persisted) expect(JSON.parse(persisted).theme).toBe("light");
    const stale = JSON.stringify({ ...DEFAULT_REBUILD_SETTINGS, theme: "dark", ["__omniaMeta"]: { revision: 1, writerId: "older-window", updatedAt: new Date().toISOString() } });
    window.dispatchEvent(new StorageEvent("storage", { key: SETTINGS_STORAGE_KEY, newValue: stale }));
    expect(rebuildSettingsStore.get().theme).toBe("light");
    unsubscribe();
  });
});

