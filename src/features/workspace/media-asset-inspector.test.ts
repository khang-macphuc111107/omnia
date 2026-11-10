import { describe, expect, it } from "vitest";

import { buildMediaAssetInspection, serializeMediaAssetInspection } from "./media-asset-inspector";

const sample = {
  id: "gallery-command-ring",
  title: "Command ring logo study",
  kind: "image" as const,
  subtitle: "Coder visuals",
  detail: "1:1 · 2048 px · 2 variants",
  prompt: "A luminous command ring logo for a calm dark coder workspace",
  createdAt: "Renderer sample · today",
  status: "ready" as const,
  source: "sample" as const,
};

describe("media asset inspector contract", () => {
  it("builds a deterministic metadata-only inspection", () => {
    const first = buildMediaAssetInspection(sample);
    const second = buildMediaAssetInspection({ ...sample });

    expect(first).toEqual(second);
    expect(first.schema).toBe("omnia.media-asset-inspector.preview.v1");
    expect(first.referenceHash).toMatch(/^preview-[0-9a-f]{8}$/);
    expect(first.bytesIncluded).toBe(false);
    expect(first.providerResult).toBe("not-observed");
    expect(first.checks).toHaveLength(4);
  });

  it("fails closed into review when the reference needs an endpoint", () => {
    const inspection = buildMediaAssetInspection({ ...sample, status: "attention", kind: "audio" });

    expect(inspection.readiness).toBe("review");
    expect(inspection.checks.find((check) => check.id === "media-bytes")?.state).toBe("not-observed");
    expect(inspection.nativeReceipt).toBe("not-observed");
  });

  it("serializes a portable inspection without asset bytes", () => {
    const payload = serializeMediaAssetInspection(buildMediaAssetInspection(sample));
    const parsed = JSON.parse(payload) as Record<string, unknown>;

    expect(parsed.schema).toBe("omnia.media-asset-inspector.preview.v1");
    expect(parsed).toMatchObject({ bytesIncluded: false, durableArtifact: false, providerResult: "not-observed" });
    expect(payload).not.toContain("data:");
  });
});
