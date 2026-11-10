export type MediaGalleryCollectionTone = "blue" | "teal" | "amber" | "coral";

export type MediaGalleryCollection = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tone: MediaGalleryCollectionTone;
};

export type MediaGalleryCollectionExport = MediaGalleryCollection & {
  readonly itemCount: number;
};

export const MEDIA_GALLERY_COLLECTION_SCHEMA = "omnia.media-gallery.collections.preview.v1" as const;
export const MEDIA_GALLERY_COLLECTION_SCOPE = "renderer-session" as const;
export const MEDIA_GALLERY_COLLECTION_BOUNDARY =
  "Renderer-local collection metadata only. Collections do not store media bytes, provider outputs, native files, or durable asset records.";

export const DEFAULT_MEDIA_GALLERY_COLLECTIONS: readonly MediaGalleryCollection[] = [
  {
    id: "collection-brand-direction",
    name: "Brand direction",
    description: "Logo, palette, and visual language references.",
    tone: "blue",
  },
  {
    id: "collection-motion-studies",
    name: "Motion studies",
    description: "Video and sequence directions to compare before generation.",
    tone: "coral",
  },
  {
    id: "collection-research-notes",
    name: "Research notes",
    description: "Narration, context maps, and evidence-oriented references.",
    tone: "teal",
  },
];

export const DEFAULT_MEDIA_GALLERY_COLLECTION_IDS: Readonly<Record<string, readonly string[]>> = {
  "gallery-command-ring": ["collection-brand-direction"],
  "gallery-dark-ide": ["collection-brand-direction"],
  "gallery-launch-loop": ["collection-motion-studies"],
  "gallery-architecture-voice": ["collection-research-notes"],
  "gallery-context-map": ["collection-research-notes"],
  "gallery-research-storyboard": ["collection-motion-studies"],
};

export function normalizeMediaGalleryCollectionName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 48);
}

export function collectionIdsForItem(
  itemId: string,
  assignments: Readonly<Record<string, readonly string[]>>,
): readonly string[] {
  return assignments[itemId] ?? [];
}

export function collectionItemCounts(
  itemIds: readonly string[],
  assignments: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  itemIds.forEach((itemId) => {
    collectionIdsForItem(itemId, assignments).forEach((collectionId) => {
      counts[collectionId] = (counts[collectionId] ?? 0) + 1;
    });
  });
  return counts;
}

export function addItemsToMediaGalleryCollection(
  assignments: Readonly<Record<string, readonly string[]>>,
  itemIds: readonly string[],
  collectionId: string,
): Record<string, readonly string[]> {
  const next: Record<string, readonly string[]> = { ...assignments };
  itemIds.forEach((itemId) => {
    const current = new Set(next[itemId] ?? []);
    current.add(collectionId);
    next[itemId] = [...current];
  });
  return next;
}

export function removeItemsFromMediaGalleryCollection(
  assignments: Readonly<Record<string, readonly string[]>>,
  itemIds: readonly string[],
  collectionId: string,
): Record<string, readonly string[]> {
  const next: Record<string, readonly string[]> = { ...assignments };
  itemIds.forEach((itemId) => {
    const remaining = (next[itemId] ?? []).filter((candidate) => candidate !== collectionId);
    if (remaining.length) next[itemId] = remaining;
    else delete next[itemId];
  });
  return next;
}

export function serializeMediaGalleryCollectionPreview(input: {
  readonly collections: readonly MediaGalleryCollectionExport[];
  readonly assignments: Readonly<Record<string, readonly string[]>>;
  readonly generatedAt?: string;
}): string {
  return JSON.stringify({
    schema: MEDIA_GALLERY_COLLECTION_SCHEMA,
    scope: MEDIA_GALLERY_COLLECTION_SCOPE,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    boundary: MEDIA_GALLERY_COLLECTION_BOUNDARY,
    collections: input.collections,
    assignments: Object.fromEntries(Object.entries(input.assignments).map(([itemId, ids]) => [itemId, [...ids]])),
  }, null, 2);
}
