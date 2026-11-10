import type { MediaGalleryCollectionExport } from "./media-gallery-collections";
import type { MediaGalleryKind, MediaGalleryStatus } from "./media-gallery-preview";

export type MediaGalleryExportFormat = "json" | "markdown";

export const MEDIA_GALLERY_EXPORT_FORMAT = "omnia.media-gallery.reference-manifest.v1" as const;
export const MEDIA_GALLERY_EXPORT_VERSION = 1 as const;
export const MEDIA_GALLERY_EXPORT_SCOPE = "renderer-session" as const;
export const MEDIA_GALLERY_EXPORT_BOUNDARY =
  "Portable metadata preview only. This manifest contains renderer references, not generated media bytes, provider results, native files, or durable artifact records.";

export interface MediaGalleryExportItem {
  readonly id: string;
  readonly title: string;
  readonly kind: MediaGalleryKind;
  readonly subtitle: string;
  readonly detail: string;
  readonly prompt: string;
  readonly createdAt: string;
  readonly status: MediaGalleryStatus;
  readonly source: "sample" | "history";
  readonly collectionIds?: readonly string[];
}

function markdownValue(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\n", " ");
}

/**
 * Serializes selected gallery references only. The schema explicitly records
 * that these are metadata-only renderer references rather than media files.
 */
export function serializeMediaGalleryExport(input: {
  readonly items: readonly MediaGalleryExportItem[];
  readonly format: MediaGalleryExportFormat;
  readonly collections?: readonly MediaGalleryCollectionExport[];
  readonly generatedAt?: string;
}): string {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const items = input.items.map((item) => ({
    id: item.id,
    title: item.title,
    kind: item.kind,
    status: item.status,
    preset: item.subtitle,
    shape: item.detail,
    promptReference: item.prompt,
    createdAt: item.createdAt,
    source: item.source,
    collectionIds: [...(item.collectionIds ?? [])],
    assetPresent: false as const,
    bytesIncluded: false as const,
  }));
  const counts = {
    total: items.length,
    image: items.filter((item) => item.kind === "image").length,
    video: items.filter((item) => item.kind === "video").length,
    audio: items.filter((item) => item.kind === "audio").length,
  };

  if (input.format === "json") {
    return JSON.stringify({
      format: MEDIA_GALLERY_EXPORT_FORMAT,
      version: MEDIA_GALLERY_EXPORT_VERSION,
      scope: MEDIA_GALLERY_EXPORT_SCOPE,
      generatedAt,
      boundary: MEDIA_GALLERY_EXPORT_BOUNDARY,
      counts,
      collections: input.collections ?? [],
      items,
    }, null, 2);
  }

  const sections = items.flatMap((item) => [
    `### ${markdownValue(item.title)}`,
    "",
    `- Type: ${item.kind}`,
    `- Status: ${item.status}`,
    `- Preset: ${markdownValue(item.preset)}`,
    `- Shape: ${markdownValue(item.shape)}`,
    `- Source: ${item.source}`,
    `- Collections: ${item.collectionIds.length ? item.collectionIds.map(markdownValue).join(", ") : "Unsorted"}`,
    `- Created: ${markdownValue(item.createdAt)}`,
    `- Asset present: ${item.assetPresent ? "yes" : "no"}`,
    `- Bytes included: ${item.bytesIncluded ? "yes" : "no"}`,
    `- Reference ID: ${markdownValue(item.id)}`,
    "",
    `Prompt reference: ${markdownValue(item.promptReference)}`,
    "",
  ]);

  return [
    "# Omnia media gallery reference manifest",
    "",
    `> ${MEDIA_GALLERY_EXPORT_BOUNDARY}`,
    "",
    `- Generated: ${markdownValue(generatedAt)}`,
    `- Selected references: ${counts.total}`,
    `- Images: ${counts.image}`,
    `- Videos: ${counts.video}`,
    `- Audio: ${counts.audio}`,
    "",
    "## Collections",
    "",
    ...((input.collections ?? []).length > 0
      ? (input.collections ?? []).flatMap((collection) => [
        `### ${markdownValue(collection.name)}`,
        "",
        `- Collection ID: ${markdownValue(collection.id)}`,
        `- References: ${collection.itemCount ?? 0}`,
        `- Description: ${markdownValue(collection.description)}`,
        "",
      ])
      : ["No collections were defined in this renderer session.", ""]),
    "",
    "## References",
    "",
    ...(sections.length > 0 ? sections : ["No references were selected.", ""]),
  ].join("\n");
}

export function downloadMediaGalleryExport(payload: string, format: MediaGalleryExportFormat): boolean {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function" || typeof document === "undefined") return false;
  const url = URL.createObjectURL(new Blob([payload], {
    type: format === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8",
  }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-media-references-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function" && typeof window !== "undefined") {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return true;
}
