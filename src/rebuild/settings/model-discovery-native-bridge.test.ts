import { describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ runtime: true, profiles: vi.fn().mockResolvedValue([]), models: vi.fn().mockResolvedValue({ profileId: "opaque-id", models: [], discoveredAt: "2026-11-08T04:30:00Z" }) }));
vi.mock("@/lib/desktop", () => ({ isDesktopRuntime: () => bridge.runtime, desktop: { listProviderProfiles: bridge.profiles, listProviderModels: bridge.models } }));
import { ModelDiscoveryController, nativeModelDiscoveryService } from "./model-discovery";

describe("native model discovery bridge", () => {
  it("delegates catalog discovery using only an opaque profile ID", async () => {
    bridge.runtime = true;
    const service = nativeModelDiscoveryService();
    expect(service.available).toBe(true); await service.listProfiles(); await service.listModels("opaque-id");
    expect(bridge.profiles).toHaveBeenCalledWith(); expect(bridge.models).toHaveBeenCalledWith("opaque-id");
  });
  it("does not cross native boundary when runtime is absent", async () => {
    bridge.runtime = false; bridge.profiles.mockClear(); bridge.models.mockClear();
    const controller = new ModelDiscoveryController(nativeModelDiscoveryService());
    await controller.refreshProfiles(); await controller.refreshModels();
    expect(bridge.profiles).not.toHaveBeenCalled(); expect(bridge.models).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("unavailable");
  });
});
