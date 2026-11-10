import { describe, expect, it } from "vitest";
import type { DiscoveryCatalog } from "./model-discovery";
import {
  CatalogRouteAdapter,
  createCatalogSnapshot,
  reconcileCatalogRoutes,
  resolveCatalogRoute,
} from "./catalog-route-adapter";

const model = (id: string, patch: Partial<DiscoveryCatalog["models"][number]> = {}) => ({
  id,
  displayName: id.toUpperCase(),
  ownedBy: null,
  createdAt: null,
  capabilities: { streaming: true, tools: true, vision: false, reasoning: true, source: "test" },
  ...patch,
});
const catalog = (models = [model("alpha")], discoveredAt = "2026-11-08T07:00:00.000Z"): DiscoveryCatalog => ({
  profileId: "profile-local",
  discoveredAt,
  models,
});

describe("catalog route adapter", () => {
  it("creates stable profile/model identity and snapshot lineage", async () => {
    const first = await createCatalogSnapshot(catalog());
    const second = await createCatalogSnapshot(catalog());
    expect(first.profileId).toBe("profile-local");
    expect(first.snapshotId).toMatch(/^catalog:profile-local:/);
    expect(first.snapshotHash).toBe(second.snapshotHash);
    expect(first.snapshotId).toBe(second.snapshotId);
    expect(first.models[0]?.id).toBe("alpha");
  });

  it("sorts model order before hashing so provider order does not change lineage", async () => {
    const one = await createCatalogSnapshot(catalog([model("alpha"), model("beta")]));
    const two = await createCatalogSnapshot(catalog([model("beta"), model("alpha")]));
    expect(one.snapshotHash).toBe(two.snapshotHash);
  });

  it("rejects duplicate model identifiers before a route can be created", async () => {
    await expect(createCatalogSnapshot(catalog([model("alpha"), model("alpha")]))).rejects.toThrow(/Duplicate model id/);
  });

  it("rejects malformed timestamps and capability values", async () => {
    await expect(createCatalogSnapshot(catalog([model("alpha")], "not-a-date"))).rejects.toThrow(/timestamp/);
    await expect(createCatalogSnapshot(catalog([model("alpha", { capabilities: { streaming: true, tools: "yes" as never, vision: false, reasoning: true, source: "test" } })]))).rejects.toThrow(/tools capability/);
  });

  it("marks a model present in an old snapshot but absent from the new one as disappeared", async () => {
    const previous = await createCatalogSnapshot(catalog([model("alpha"), model("beta")]));
    const current = await createCatalogSnapshot(catalog([model("alpha")], "2026-11-08T07:05:00.000Z"), previous.snapshotId);
    const routes = reconcileCatalogRoutes(current, previous, Date.parse(current.discoveredAt));
    expect(routes.find((entry) => entry.identity.modelId === "alpha")?.state).toBe("available");
    expect(routes.find((entry) => entry.identity.modelId === "beta")).toMatchObject({ state: "disappeared", identity: { providerProfileId: "profile-local", modelId: "beta" } });
  });

  it("marks old current snapshots stale and keeps them non-dispatchable", async () => {
    const snapshot = await createCatalogSnapshot(catalog());
    const routes = reconcileCatalogRoutes(snapshot, undefined, Date.parse(snapshot.discoveredAt) + 16 * 60_000);
    const resolution = resolveCatalogRoute(routes, { providerProfileId: "profile-local", modelId: "alpha" });
    expect(resolution).toMatchObject({ dispatchable: false, state: "stale" });
  });

  it("resolves an available route for the exact provider/model pair", async () => {
    const snapshot = await createCatalogSnapshot(catalog());
    const routes = reconcileCatalogRoutes(snapshot, undefined, Date.parse(snapshot.discoveredAt));
    expect(resolveCatalogRoute(routes, { providerProfileId: "profile-local", modelId: "alpha" })).toMatchObject({ dispatchable: true, state: "available" });
  });

  it("marks models without streaming support unsupported and non-dispatchable", async () => {
    const snapshot = await createCatalogSnapshot(catalog([model("alpha", { capabilities: { streaming: false, tools: null, vision: null, reasoning: null, source: "provider-metadata" } })]));
    const routes = reconcileCatalogRoutes(snapshot, undefined, Date.parse(snapshot.discoveredAt));
    expect(resolveCatalogRoute(routes, { providerProfileId: "profile-local", modelId: "alpha" })).toMatchObject({ dispatchable: false, state: "unsupported" });
  });

  it("uses native snapshot identity and hash when the catalog supplies them", async () => {
    const nativeId = "catalog_snapshot_0123456789abcdef0123456789abcdef";
    const nativeHash = "c".repeat(64);
    const snapshot = await createCatalogSnapshot({ ...catalog(), snapshotId: nativeId, snapshotSha256: nativeHash });
    expect(snapshot).toMatchObject({ snapshotId: nativeId, snapshotHash: nativeHash, snapshotAuthority: "native" });
  });

  it("does not resolve a model from a different provider profile", async () => {
    const snapshot = await createCatalogSnapshot(catalog());
    const routes = reconcileCatalogRoutes(snapshot, undefined, Date.parse(snapshot.discoveredAt));
    expect(resolveCatalogRoute(routes, { providerProfileId: "profile-remote", modelId: "alpha" })).toMatchObject({ dispatchable: false, state: "unknown", route: null });
  });

  it("clears disappeared history when the provider profile changes", async () => {
    const first = await createCatalogSnapshot(catalog([model("alpha")]));
    const second = await createCatalogSnapshot({ profileId: "profile-remote", discoveredAt: "2026-11-08T07:05:00.000Z", models: [model("alpha")] });
    const adapter = new CatalogRouteAdapter();
    adapter.setSnapshot(first, Date.parse(first.discoveredAt));
    adapter.setSnapshot(second, Date.parse(second.discoveredAt));
    expect(adapter.getRoutes()).toHaveLength(1);
    expect(adapter.resolve({ providerProfileId: "profile-local", modelId: "alpha" }).state).toBe("unknown");
  });

  it("retains an explicit previous snapshot id for lineage debugging", async () => {
    const first = await createCatalogSnapshot(catalog());
    const second = await createCatalogSnapshot(catalog([model("alpha"), model("beta")], "2026-11-08T07:06:00.000Z"), first.snapshotId);
    expect(second.previousSnapshotId).toBe(first.snapshotId);
  });
});
