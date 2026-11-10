import { describe, expect, it } from "vitest";

import {
  buildCacheContextRouteProjection,
  DEFAULT_CACHE_CONTEXT_ROUTE_DRAFT,
  filterUserManagedCacheInventory,
  serializeCacheContextRoutePreview,
  type CacheContextSegment,
  type UserManagedCacheObject,
} from "./cache-context-routing-contract";

const segments: readonly CacheContextSegment[] = [
  { id: "system", label: "System", kind: "stable-instruction", cacheClass: "static", selected: true, tokenEstimate: 100 },
  { id: "project", label: "Project", kind: "project-instruction", cacheClass: "slow", selected: true, tokenEstimate: 50 },
  { id: "prompt", label: "Prompt", kind: "user-input", cacheClass: "dynamic", selected: true, tokenEstimate: 20 },
];

const localObjects: readonly UserManagedCacheObject[] = [
  {
    id: "context",
    kind: "compiled-context",
    label: "Context manifest",
    scope: "project",
    dataClass: "internal",
    bytes: 1000,
    tokenEstimate: 100,
    lineage: "project revision",
    status: "warm",
    hitCount: 4,
    missCount: 1,
    lastUsedAt: "2026-09-30T00:00:00Z",
    ttlSeconds: 3600,
    pinned: true,
  },
  {
    id: "ocr",
    kind: "ocr",
    label: "OCR result",
    scope: "chat",
    dataClass: "confidential",
    bytes: 2000,
    tokenEstimate: 200,
    lineage: "attachment revision",
    status: "stale",
    hitCount: 2,
    missCount: 3,
    lastUsedAt: null,
    ttlSeconds: 3600,
    pinned: false,
  },
];

describe("cache/context route preview contract", () => {
  it("plans stable selected segments without calling them provider hits", () => {
    const projection = buildCacheContextRouteProjection({ segments });

    expect(projection.provider.planState).toBe("planned");
    expect(projection.stablePrefix.includedSegmentIds).toEqual(["system", "project"]);
    expect(projection.stablePrefix.omittedSegmentIds).toEqual(["prompt"]);
    expect(projection.provider.evidenceStatus).toBe("unknown");
    expect(projection.provider.detail).toMatch(/not counted as a hit/i);
  });

  it("keeps local reuse separate from provider-reported evidence", () => {
    const projection = buildCacheContextRouteProjection({
      draft: { localMode: "aggressive-reuse" },
      segments,
    });

    expect(projection.local.enabled).toBe(true);
    expect(projection.provider.evidenceStatus).toBe("unknown");
    expect(projection.provider.evidenceSource).toBe("not-observed");
  });

  it("surfaces provider counters only when evidence is supplied", () => {
    const projection = buildCacheContextRouteProjection({
      segments,
      providerEvidence: { status: "reported-hit", source: "provider-reported", readTokens: 140, writeTokens: 30 },
      providerLabel: "Gateway A",
    });

    expect(projection.provider.evidenceStatus).toBe("reported-hit");
    expect(projection.provider.evidenceSource).toBe("provider-reported");
    expect(projection.provider.readTokens).toBe(140);
    expect(projection.provider.detail).toContain("Gateway A");
  });

  it("fails closed when a non-authoritative source claims a provider cache hit", () => {
    const projection = buildCacheContextRouteProjection({
      segments,
      providerEvidence: { status: "reported-hit", source: "not-observed", readTokens: 120 },
    });

    expect(projection.provider.evidenceStatus).toBe("unknown");
    expect(projection.provider.evidenceSource).toBe("not-observed");
    expect(projection.provider.readTokens).toBeNull();
    expect(projection.provider.detail).toMatch(/unknown/i);
  });

  it("withholds malformed provider counters instead of exporting invalid usage", () => {
    const projection = buildCacheContextRouteProjection({
      segments,
      providerEvidence: {
        status: "reported-partial",
        source: "adapter-verified",
        readTokens: -1,
        writeTokens: Number.NaN,
      },
    });

    expect(projection.provider.evidenceStatus).toBe("reported-partial");
    expect(projection.provider.readTokens).toBeNull();
    expect(projection.provider.writeTokens).toBeNull();
    expect(projection.provider.detail).toMatch(/withheld because it was invalid/i);
  });

  it("distinguishes project-key encryption from native-profile encryption", () => {
    const projection = buildCacheContextRouteProjection({
      draft: { localEncryption: "project-key" },
      segments,
    });

    expect(projection.local.detail).toMatch(/Project-key encrypted/);
    expect(projection.local.detail).not.toMatch(/^Native-encrypted/);
  });

  it("blocks the provider plan when native hints are disabled", () => {
    const projection = buildCacheContextRouteProjection({ draft: { providerMode: "disabled" }, segments });

    expect(projection.provider.planState).toBe("blocked");
    expect(projection.stablePrefix.planned).toBe(false);
    expect(projection.stablePrefix.reasons.join(" ")).toMatch(/disabled/i);
  });

  it("withholds a prefix token total when all selected stable estimates are unknown", () => {
    const projection = buildCacheContextRouteProjection({
      segments: [{ ...segments[0]!, tokenEstimate: null }],
    });

    expect(projection.stablePrefix.estimatedTokens).toBeNull();
  });

  it("withholds a partial prefix token total when any included estimate is unknown", () => {
    const projection = buildCacheContextRouteProjection({
      segments: [segments[0]!, { ...segments[1]!, tokenEstimate: null }],
    });

    expect(projection.stablePrefix.includedSegmentIds).toEqual(["system", "project"]);
    expect(projection.stablePrefix.estimatedTokens).toBeNull();
  });

  it("withholds an aggregate that overflows despite individually finite estimates", () => {
    const projection = buildCacheContextRouteProjection({
      segments: [
        { ...segments[0]!, tokenEstimate: Number.MAX_VALUE },
        { ...segments[1]!, tokenEstimate: Number.MAX_VALUE },
      ],
    });

    expect(projection.stablePrefix.estimatedTokens).toBeNull();
  });

  it("serializes an explicit preview boundary", () => {
    const projection = buildCacheContextRouteProjection({ segments });
    const payload = serializeCacheContextRoutePreview(projection, "json");
    const parsed = JSON.parse(payload) as typeof projection;

    expect(parsed.schema).toBe("omnia.cache-context-route-preview.v1");
    expect(parsed.boundary.join(" ")).toMatch(/provider cache billing/i);
    expect(serializeCacheContextRoutePreview(projection, "markdown")).toContain("## Boundary");
    expect(DEFAULT_CACHE_CONTEXT_ROUTE_DRAFT.providerMode).toBe("auto");
  });

  it("projects a redacted local inventory and excludes stale or disallowed objects", () => {
    const projection = buildCacheContextRouteProjection({ segments, localObjects });

    expect(projection.local.inventory.objectCount).toBe(2);
    expect(projection.local.inventory.totalBytes).toBe(3000);
    expect(projection.local.inventory.pinnedCount).toBe(1);
    expect(projection.local.inventory.hitCount).toBe(6);
    expect(projection.local.inventory.eligibleCount).toBe(1);
    expect(projection.local.inventory.excludedByPolicyCount).toBe(1);
    expect(projection.local.inventory.objects[1]).toMatchObject({ eligible: false, eligibilityReason: "Data class excluded by policy" });
  });

  it("keeps inventory usage unknown when byte counters are incomplete", () => {
    const projection = buildCacheContextRouteProjection({
      segments,
      localObjects: [{ ...localObjects[0]!, bytes: null }, localObjects[1]!],
    });

    expect(projection.local.inventory.totalBytes).toBeNull();
    expect(projection.local.inventory.usagePercent).toBeNull();
  });

  it("filters only evidenced local states without calling stale, blocked, or missing rows reusable", () => {
    const projection = buildCacheContextRouteProjection({
      localObjects: [
        ...localObjects,
        { ...localObjects[0]!, id: "invalidated", status: "invalidated" },
        { ...localObjects[0]!, id: "unknown", status: "unknown" },
        { ...localObjects[0]!, id: "blocked", status: "blocked" },
      ],
    });
    const inventory = projection.local.inventory;
    expect(filterUserManagedCacheInventory(inventory.objects, "all")).toHaveLength(5);
    expect(filterUserManagedCacheInventory(inventory.objects, "reusable").map((object) => object.id)).toEqual(["context"]);
    expect(filterUserManagedCacheInventory(inventory.objects, "invalidated").map((object) => object.id)).toEqual(["invalidated"]);
    expect(filterUserManagedCacheInventory(inventory.objects, "unknown").map((object) => object.id)).toEqual(["unknown"]);
    expect(inventory.invalidatedCount).toBe(1);
    expect(inventory.unknownCount).toBe(1);
    expect(projection.provider.evidenceStatus).toBe("unknown");
  });
});
