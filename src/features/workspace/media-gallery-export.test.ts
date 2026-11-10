import { describe, expect, it } from "vitest";

import {
  MEDIA_GALLERY_EXPORT_BOUNDARY,
  MEDIA_GALLERY_EXPORT_FORMAT,
  serializeMediaGalleryExport,
} from "./media-gallery-export";

const items = [{
  id: "ref-1",
  title: "Launch loop",
  kind: "video" as const,
  subtitle: "Cinematic motion",
  detail: "16:9 · 8 s · 24 fps",
  prompt: "A precise launch loop",
  createdAt: "Renderer sample · today",
  status: "queued" as const,
  source: "sample" as const,
}];

describe("media gallery reference export", () => {
  it("serializes a metadata-only JSON manifest with explicit boundaries", () => {
    const parsed = JSON.parse(serializeMediaGalleryExport({ items, format: "json", generatedAt: "2026-09-24T00:00:00.000Z" }));

    expect(parsed.format).toBe(MEDIA_GALLERY_EXPORT_FORMAT);
    expect(parsed.generatedAt).toBe("2026-09-24T00:00:00.000Z");
    expect(parsed.boundary).toBe(MEDIA_GALLERY_EXPORT_BOUNDARY);
    expect(parsed.counts).toEqual({ total: 1, image: 0, video: 1, audio: 0 });
    expect(parsed.items[0]).toMatchObject({ title: "Launch loop", assetPresent: false, bytesIncluded: false });
  });

  it("serializes a readable Markdown manifest without treating a reference as an artifact", () => {
    const markdown = serializeMediaGalleryExport({ items, format: "markdown", generatedAt: "2026-09-24T00:00:00.000Z" });

    expect(markdown).toContain("# Omnia media gallery reference manifest");
    expect(markdown).toContain("Asset present: no");
    expect(markdown).toContain("Bytes included: no");
    expect(markdown).toContain("Prompt reference: A precise launch loop");
    expect(markdown).toContain(MEDIA_GALLERY_EXPORT_BOUNDARY);
  });

  it("handles an empty selection explicitly", () => {
    const parsed = JSON.parse(serializeMediaGalleryExport({ items: [], format: "json", generatedAt: "2026-09-24T00:00:00.000Z" }));

    expect(parsed.counts).toEqual({ total: 0, image: 0, video: 0, audio: 0 });
    expect(parsed.items).toEqual([]);
  });
});
