import { describe, expect, it, vi } from "vitest";
import { ModelDiscoveryController, type ModelDiscoveryService } from "./model-discovery";

const profiles = [
  { id: "local", displayName: "Local model server", providerType: "openai-compatible", enabled: true, credentialStatus: "missing" },
  { id: "remote", displayName: "Remote provider", providerType: "openai", enabled: true, credentialStatus: "present" },
  { id: "disabled", displayName: "Disabled provider", providerType: "openai", enabled: false, credentialStatus: "locked" },
];
const catalog = (profileId = "local", modelId = "model-a") => ({
  profileId, discoveredAt: "2026-11-08T04:30:00.000Z", models: [{
    id: modelId, displayName: modelId, ownedBy: null, createdAt: null,
    capabilities: { streaming: true, tools: null, vision: false, reasoning: true, source: "provider-metadata" },
  }],
});
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function service(overrides: Partial<ModelDiscoveryService> = {}): ModelDiscoveryService {
  return { available: true, listProfiles: vi.fn().mockResolvedValue(profiles), listModels: vi.fn().mockResolvedValue(catalog()), ...overrides };
}

describe("clean-room native model discovery", () => {
  it("does not issue native calls or invent models in preview", async () => {
    const bridge = service({ available: false }); const controller = new ModelDiscoveryController(bridge);
    await controller.refreshProfiles(); await controller.refreshModels();
    expect(controller.getSnapshot().phase).toBe("unavailable");
    expect(controller.getSnapshot().catalog).toBeNull();
    expect(bridge.listProfiles).not.toHaveBeenCalled(); expect(bridge.listModels).not.toHaveBeenCalled();
  });

  it("loads public profile metadata without contacting a model endpoint until requested", async () => {
    const bridge = service(); const controller = new ModelDiscoveryController(bridge);
    await controller.refreshProfiles();
    expect(controller.getSnapshot().profiles).toHaveLength(3);
    expect(controller.getSnapshot().selectedProfileId).toBe("");
    expect(bridge.listModels).not.toHaveBeenCalled();
    controller.selectProfile("local"); await controller.refreshModels();
    expect(bridge.listModels).toHaveBeenCalledWith("local");
    expect(controller.getSnapshot().catalog).toEqual(catalog());
    expect(controller.getSnapshot().phase).toBe("ready");
  });

  it("rejects a stale model result after switching provider", async () => {
    const old = deferred<unknown>(); const bridge = service({ listModels: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(catalog("remote", "model-b")) });
    const controller = new ModelDiscoveryController(bridge); await controller.refreshProfiles();
    controller.selectProfile("local"); const first = controller.refreshModels();
    controller.selectProfile("remote"); await controller.refreshModels(); old.resolve(catalog()); await first;
    expect(controller.getSnapshot().selectedProfileId).toBe("remote");
    expect(controller.getSnapshot().catalog?.models[0]?.id).toBe("model-b");
  });

  it("stops waiting and ignores a late response without claiming native request cancellation", async () => {
    const pending = deferred<unknown>(); const controller = new ModelDiscoveryController(service({ listModels: () => pending.promise }));
    await controller.refreshProfiles(); controller.selectProfile("local"); const request = controller.refreshModels();
    controller.cancel(); pending.resolve(catalog()); await request;
    expect(controller.getSnapshot().phase).toBe("cancelled"); expect(controller.getSnapshot().catalog).toBeNull();
  });

  it("invalidates a pending model request when refreshing the profile list", async () => {
    const pending = deferred<unknown>(); const controller = new ModelDiscoveryController(service({ listModels: () => pending.promise }));
    await controller.refreshProfiles(); controller.selectProfile("local"); const request = controller.refreshModels();
    await controller.refreshProfiles(); pending.resolve(catalog()); await request;
    expect(controller.getSnapshot().catalog).toBeNull(); expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("fails closed for mismatched or malformed model catalogs", async () => {
    const bridge = service({ listModels: vi.fn().mockResolvedValueOnce(catalog("remote")).mockResolvedValueOnce({ ...catalog(), discoveredAt: "invalid" }) });
    const controller = new ModelDiscoveryController(bridge); await controller.refreshProfiles(); controller.selectProfile("local");
    await controller.refreshModels(); expect(controller.getSnapshot().phase).toBe("error"); expect(controller.getSnapshot().catalog).toBeNull();
    await controller.refreshModels(); expect(controller.getSnapshot().phase).toBe("error"); expect(controller.getSnapshot().catalog).toBeNull();
  });

  it("never exposes raw provider errors or credential-shaped fields", async () => {
    const controller = new ModelDiscoveryController(service({ listProfiles: async () => [{ ...profiles[0], secret: "private-key-value", normalizedBaseUrl: "https://user:password@example.test" }], listModels: async () => { throw new Error("Authorization: Bearer private-key-value"); } }));
    await controller.refreshProfiles(); controller.selectProfile("local"); await controller.refreshModels();
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("private-key-value");
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("password");
    expect(controller.getSnapshot().error).toMatch(/Check the provider/);
  });

  it("rejects disabled or missing profile selection before native dispatch", async () => {
    const bridge = service(); const controller = new ModelDiscoveryController(bridge); await controller.refreshProfiles();
    controller.selectProfile("disabled"); await controller.refreshModels(); controller.selectProfile("missing"); await controller.refreshModels();
    expect(bridge.listModels).not.toHaveBeenCalled(); expect(controller.getSnapshot().phase).toBe("error");
  });

  it("rejects duplicate models, invalid capabilities and catalogs beyond native bounds", async () => {
    const original = catalog(); const originalModel = original.models[0]!; const bridge = service({ listModels: vi.fn()
      .mockResolvedValueOnce({ ...original, models: [originalModel, originalModel] })
      .mockResolvedValueOnce({ ...original, models: [{ ...originalModel, capabilities: { ...originalModel.capabilities, tools: "yes" } }] })
      .mockResolvedValueOnce({ ...original, models: Array.from({ length: 2001 }, (_, index) => ({ ...originalModel, id: `model-${index}` })) }) });
    const controller = new ModelDiscoveryController(bridge); await controller.refreshProfiles(); controller.selectProfile("local");
    for (let attempt = 0; attempt < 3; attempt += 1) { await controller.refreshModels(); expect(controller.getSnapshot().phase).toBe("error"); expect(controller.getSnapshot().catalog).toBeNull(); }
  });

  it("ignores a late failure from a superseded discovery request", async () => {
    const old = deferred<unknown>(); const bridge = service({ listModels: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(catalog("remote", "model-b")) });
    const controller = new ModelDiscoveryController(bridge); await controller.refreshProfiles();
    controller.selectProfile("local"); const first = controller.refreshModels(); controller.selectProfile("remote"); await controller.refreshModels();
    old.reject(new Error("old private error")); await first;
    expect(controller.getSnapshot().phase).toBe("ready"); expect(controller.getSnapshot().error).toBeNull();
    expect(controller.getSnapshot().catalog?.profileId).toBe("remote");
  });

  it("keeps the last successful catalog and active attempt metadata when refresh fails", async () => {
    const bridge = service({ listModels: vi.fn().mockResolvedValueOnce(catalog()).mockRejectedValueOnce(new Error("provider timeout")) });
    const controller = new ModelDiscoveryController(bridge); await controller.refreshProfiles();
    controller.selectProfile("local"); await controller.refreshModels();
    controller.setActiveAttempt({
      attemptId: "attempt_1234567890abcdef",
      providerProfileId: "local",
      modelId: "model-a",
      snapshotId: "catalog_snapshot_0123456789abcdef0123456789abcdef",
      snapshotSha256: "a".repeat(64),
      startedAt: "2026-11-08T04:31:00.000Z",
    });
    await controller.refreshModels();
    expect(controller.getSnapshot()).toMatchObject({ phase: "error", catalogStatus: "refresh-failed", error: expect.stringMatching(/Check the provider/), activeAttempt: { attemptId: "attempt_1234567890abcdef", modelId: "model-a" } });
    expect(controller.getSnapshot().catalog?.models[0]?.id).toBe("model-a");
  });

  it("retains the last successful catalog when the user cancels a refresh", async () => {
    const pending = deferred<unknown>();
    const bridge = service({ listModels: vi.fn().mockResolvedValueOnce(catalog()).mockReturnValueOnce(pending.promise) });
    const controller = new ModelDiscoveryController(bridge); await controller.refreshProfiles(); controller.selectProfile("local"); await controller.refreshModels();
    const request = controller.refreshModels(); controller.cancel(); pending.resolve(catalog("local", "late-model")); await request;
    expect(controller.getSnapshot().phase).toBe("cancelled");
    expect(controller.getSnapshot().catalog?.models[0]?.id).toBe("model-a");
    expect(controller.getSnapshot().catalogStatus).toBe("cancelled");
  });

  it("accepts native catalog snapshot lineage while preserving the model rows", async () => {
    const nativeSnapshot = {
      ...catalog(),
      snapshotId: "catalog_snapshot_0123456789abcdef0123456789abcdef",
      snapshotSha256: "b".repeat(64),
    };
    const controller = new ModelDiscoveryController(service({ listModels: vi.fn().mockResolvedValue(nativeSnapshot) }));
    await controller.refreshProfiles(); controller.selectProfile("local"); await controller.refreshModels();
    expect(controller.getSnapshot().catalog).toMatchObject({ snapshotId: nativeSnapshot.snapshotId, snapshotSha256: nativeSnapshot.snapshotSha256 });
  });
});
