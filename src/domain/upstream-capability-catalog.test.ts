import { describe, expect, it } from "vitest";

import {
  createUpstreamAdapterPlan,
  findUpstreamCapability,
  listRunnableUpstreamCapabilities,
  listUpstreamCapabilities,
  listUpstreamCapabilitiesByCategory,
  upstreamCapabilitySummary,
} from "./upstream-capability-catalog";

describe("upstream capability catalog", () => {
  it("keeps the extracted inventory bounded and uniquely addressable", () => {
    const catalog = listUpstreamCapabilities();
    const ids = catalog.map((item) => item.id);
    expect(catalog.length).toBeGreaterThanOrEqual(55);
    expect(new Set(ids).size).toBe(ids.length);
    expect(catalog.every((item) => item.root.startsWith("upstream_extractions/"))).toBe(true);
    expect(catalog.every((item) => item.manifests.length <= 32 && item.entryCandidates.length <= 32)).toBe(true);
  });

  it("separates runnable adapters from evidence-only runtime material", () => {
    const runnable = listRunnableUpstreamCapabilities();
    const summary = upstreamCapabilitySummary();
    expect(summary.total).toBe(listUpstreamCapabilities().length);
    expect(summary.categories).toBeGreaterThanOrEqual(10);
    expect(summary.runnable).toBe(runnable.length);
    expect(runnable.every((item) => item.sensitiveFileCount === 0)).toBe(true);
    expect(listUpstreamCapabilitiesByCategory("HARNESS")).toHaveLength(0);
    expect(listUpstreamCapabilitiesByCategory("harnesses").length).toBeGreaterThan(0);
  });

  it("creates an explicit adapter plan without exposing executable credentials", () => {
    const item = listUpstreamCapabilities().find((candidate) => candidate.integrationMode === "process-adapter");
    expect(item).toBeDefined();
    const plan = createUpstreamAdapterPlan(item!.id);
    expect(plan.capabilityId).toBe(item!.id);
    expect(plan.mode).toBe("process-adapter");
    expect(plan.root).toContain("upstream_extractions/");
    expect(plan.entryCandidates.every((entry) => entry.startsWith("upstream_extractions/"))).toBe(true);
    expect(findUpstreamCapability(item!.id)?.id).toBe(item!.id);
  });

  it("rejects traversal-like capability identifiers", () => {
    expect(() => findUpstreamCapability("../secrets")).toThrow(/Invalid upstream capability id/i);
    expect(() => findUpstreamCapability("C:\\temp\\entry")).toThrow(/Invalid upstream capability id/i);
  });
});
