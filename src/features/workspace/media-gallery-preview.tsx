import {
  AudioLines,
  BookmarkPlus,
  Check,
  Clipboard,
  Columns2,
  Download,
  FileJson2,
  Film,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  Image as ImageIcon,
  Info,
  List,
  Pencil,
  Play,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  addItemsToMediaGalleryCollection,
  collectionIdsForItem,
  collectionItemCounts,
  DEFAULT_MEDIA_GALLERY_COLLECTION_IDS,
  DEFAULT_MEDIA_GALLERY_COLLECTIONS,
  normalizeMediaGalleryCollectionName,
  removeItemsFromMediaGalleryCollection,
  type MediaGalleryCollection,
  type MediaGalleryCollectionExport,
} from "./media-gallery-collections";
import {
  downloadMediaGalleryExport,
  serializeMediaGalleryExport,
  type MediaGalleryExportFormat,
  type MediaGalleryExportItem,
} from "./media-gallery-export";
import { MediaAssetInspector } from "./media-asset-inspector";

export type MediaGalleryKind = "image" | "video" | "audio";
export type MediaGalleryStatus = "ready" | "queued" | "attention";

export type MediaGalleryRecentItem = {
  readonly id: string;
  readonly title: string;
  readonly kind: MediaGalleryKind;
  readonly subtitle: string;
  readonly detail: string;
  readonly prompt: string;
  readonly createdAt: string;
  readonly status?: MediaGalleryStatus;
  readonly collectionIds?: readonly string[];
};

type GalleryFilter = "all" | MediaGalleryKind;
type GalleryLayout = "grid" | "list";
type GalleryStatusFilter = "all" | MediaGalleryStatus;
type GallerySort = "recent" | "title" | "type";
type GalleryCollectionFilter = "all" | "unassigned" | string;

type GalleryItem = MediaGalleryRecentItem & {
  readonly accent: "blue" | "coral" | "teal" | "amber";
  readonly source: "sample" | "history";
  readonly collectionIds: readonly string[];
};

export type MediaGalleryPreviewProps = {
  /** Recent renderer-session history is projected into the gallery without reading bytes. */
  readonly recentItems?: readonly MediaGalleryRecentItem[];
  /** Optional renderer-local handoff to a draft editor; it must not dispatch generation. */
  readonly onUseAsNextDirection?: (item: MediaGalleryRecentItem) => void;
};

const sampleItems: readonly GalleryItem[] = [
  {
    id: "gallery-command-ring",
    title: "Command ring logo study",
    kind: "image",
    subtitle: "Coder visuals",
    detail: "1:1 · 2048 px · 2 variants",
    prompt: "A luminous command ring logo for a calm dark coder workspace",
    createdAt: "Renderer sample · today",
    status: "ready",
    collectionIds: ["collection-brand-direction"],
    accent: "blue",
    source: "sample",
  },
  {
    id: "gallery-dark-ide",
    title: "Dark IDE moodboard",
    kind: "image",
    subtitle: "Fast ideation",
    detail: "1:1 · 1024 px · 4 variants",
    prompt: "A modern dark IDE moodboard with graphite surfaces and restrained color accents",
    createdAt: "Renderer sample · yesterday",
    status: "ready",
    collectionIds: ["collection-brand-direction"],
    accent: "amber",
    source: "sample",
  },
  {
    id: "gallery-launch-loop",
    title: "Omnia launch loop",
    kind: "video",
    subtitle: "Cinematic motion",
    detail: "16:9 · 8 s · 24 fps",
    prompt: "A precise camera move through a dark developer workspace with warm desk light",
    createdAt: "Renderer sample · this week",
    status: "queued",
    collectionIds: ["collection-motion-studies"],
    accent: "coral",
    source: "sample",
  },
  {
    id: "gallery-architecture-voice",
    title: "Architecture narration",
    kind: "audio",
    subtitle: "Research voice",
    detail: "60 s · neutral narrator · WAV",
    prompt: "A calm narrated explanation of the Omnia architecture and its evidence boundaries",
    createdAt: "Renderer sample · this week",
    status: "attention",
    collectionIds: ["collection-research-notes"],
    accent: "teal",
    source: "sample",
  },
  {
    id: "gallery-context-map",
    title: "Context map variants",
    kind: "image",
    subtitle: "Coder visuals",
    detail: "16:9 · 1536 px · 3 variants",
    prompt: "A crisp visual map of project context, chats, files, memory, and skills",
    createdAt: "Renderer sample · earlier",
    status: "ready",
    collectionIds: ["collection-research-notes"],
    accent: "teal",
    source: "sample",
  },
  {
    id: "gallery-research-storyboard",
    title: "Research storyboard",
    kind: "video",
    subtitle: "Cinematic motion",
    detail: "9:16 · 12 s · 30 fps",
    prompt: "A compact vertical storyboard that moves from question to evidence to conclusion",
    createdAt: "Renderer sample · earlier",
    status: "queued",
    collectionIds: ["collection-motion-studies"],
    accent: "coral",
    source: "sample",
  },
];

const kindLabels: Record<MediaGalleryKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
};

const statusLabels: Record<MediaGalleryStatus, string> = {
  ready: "Ready preview",
  queued: "Queued preview",
  attention: "Needs endpoint",
};

const statusFilterLabels: Record<GalleryStatusFilter, string> = {
  all: "Any status",
  ready: statusLabels.ready,
  queued: statusLabels.queued,
  attention: statusLabels.attention,
};

function kindIcon(kind: MediaGalleryKind, size = 14): ReactNode {
  if (kind === "image") return <ImageIcon size={size} aria-hidden="true" />;
  if (kind === "video") return <Film size={size} aria-hidden="true" />;
  return <AudioLines size={size} aria-hidden="true" />;
}

function normaliseRecentItem(item: MediaGalleryRecentItem): GalleryItem {
  const accent = item.kind === "image" ? "blue" : item.kind === "video" ? "coral" : "teal";
  return { ...item, accent, source: "history", collectionIds: item.collectionIds ?? [] };
}

function GalleryArtwork({ item }: { item: GalleryItem }) {
  return (
    <div className={`media-gallery-preview__art media-gallery-preview__art--${item.kind} media-gallery-preview__art--${item.accent}`} aria-hidden="true">
      {item.kind === "image" ? (
        <>
          <span className="media-gallery-preview__art-orbit" />
          <span className="media-gallery-preview__art-grid" />
          <strong>OMNIA</strong>
          <small>{item.detail.split("·")[0]?.trim()}</small>
        </>
      ) : null}
      {item.kind === "video" ? (
        <>
          <div className="media-gallery-preview__art-frames"><span>01</span><span>02</span><span>03</span><span>04</span></div>
          <span className="media-gallery-preview__art-play"><Play size={16} fill="currentColor" /></span>
          <small>{item.detail.split("·").slice(0, 2).join(" · ").trim()}</small>
        </>
      ) : null}
      {item.kind === "audio" ? (
        <>
          <div className="media-gallery-preview__art-wave">{[22, 46, 32, 68, 42, 80, 55, 34, 73, 44, 61, 28, 52, 38].map((height, index) => <i key={`${height}-${index}`} style={{ height: `${height}%` }} />)}</div>
          <small>{item.detail.split("·").slice(0, 2).join(" · ").trim()}</small>
        </>
      ) : null}
      <span className="media-gallery-preview__art-watermark">Preview</span>
    </div>
  );
}

function GalleryCard({
  item,
  selected,
  exportSelected,
  collectionSelected,
  compareSelected,
  compareDisabled,
  onSelect,
  onToggleExport,
  onToggleCollection,
  onToggleCompare,
}: {
  readonly item: GalleryItem;
  readonly selected: boolean;
  readonly exportSelected: boolean;
  readonly collectionSelected: boolean;
  readonly compareSelected: boolean;
  readonly compareDisabled: boolean;
  readonly onSelect: () => void;
  readonly onToggleExport: () => void;
  readonly onToggleCollection: () => void;
  readonly onToggleCompare: () => void;
}) {
  return (
    <article className={`media-gallery-preview__card${selected ? " is-selected" : ""}`}>
      <button type="button" className="media-gallery-preview__card-select" onClick={onSelect} aria-pressed={selected} aria-label={`Inspect ${item.title}`}>
        <GalleryArtwork item={item} />
        <span className="media-gallery-preview__card-copy">
          <span className="media-gallery-preview__card-title"><strong>{item.title}</strong>{selected ? <Check size={13} aria-hidden="true" /> : null}</span>
          <small>{item.subtitle} · {item.detail}</small>
          <span className={`media-gallery-preview__status media-gallery-preview__status--${item.status ?? "ready"}`}>{statusLabels[item.status ?? "ready"]}</span>
        </span>
      </button>
      <button
        type="button"
        className={`media-gallery-preview__export-toggle${exportSelected ? " is-selected" : ""}`}
        onClick={onToggleExport}
        aria-pressed={exportSelected}
        aria-label={`${exportSelected ? "Remove" : "Select"} ${item.title} for export`}
      >
        <span className="media-gallery-preview__export-toggle-box" aria-hidden="true">{exportSelected ? <Check size={11} /> : null}</span>
        {exportSelected ? "Selected for export" : "Select for export"}
      </button>
      <button
        type="button"
        className={`media-gallery-preview__collection-toggle${collectionSelected ? " is-selected" : ""}`}
        onClick={onToggleCollection}
        aria-pressed={collectionSelected}
        aria-label={`${collectionSelected ? "Remove" : "Select"} ${item.title} for collection`}
      >
        <BookmarkPlus size={12} aria-hidden="true" />
        {collectionSelected ? "Selected for collection" : "Select for collection"}
      </button>
      <button
        type="button"
        className={`media-gallery-preview__compare-toggle${compareSelected ? " is-selected" : ""}`}
        onClick={onToggleCompare}
        disabled={compareDisabled}
        aria-pressed={compareSelected}
        aria-label={`${compareSelected ? "Remove" : "Add"} ${item.title} ${compareSelected ? "from" : "to"} comparison`}
      >
        <Columns2 size={12} aria-hidden="true" />
        {compareSelected ? "In comparison" : "Compare"}
      </button>
    </article>
  );
}

/**
 * A renderer-only output gallery for comparing media directions before any
 * provider artifact or native file exists. The artwork is intentionally CSS
 * rehearsal content, never a claim that generated bytes were produced.
 */
export function MediaGalleryPreview({ recentItems = [], onUseAsNextDirection }: MediaGalleryPreviewProps) {
  const [filter, setFilter] = useState<GalleryFilter>("all");
  const [statusFilter, setStatusFilter] = useState<GalleryStatusFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<GallerySort>("recent");
  const [layout, setLayout] = useState<GalleryLayout>("grid");
  const [selectedId, setSelectedId] = useState(sampleItems[0]?.id ?? "");
  const [status, setStatus] = useState("Select an output to inspect its renderer-local reference.");
  const [exportSelectedIds, setExportSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<MediaGalleryExportFormat>("json");
  const [exportScope, setExportScope] = useState<"selected" | "visible">("selected");
  const [exportStatus, setExportStatus] = useState("Select references to prepare a portable manifest.");
  const [collections, setCollections] = useState<MediaGalleryCollection[]>(() => [...DEFAULT_MEDIA_GALLERY_COLLECTIONS]);
  const [collectionAssignments, setCollectionAssignments] = useState<Record<string, readonly string[]>>(() => ({
    ...DEFAULT_MEDIA_GALLERY_COLLECTION_IDS,
  }));
  const [collectionFilter, setCollectionFilter] = useState<GalleryCollectionFilter>("all");
  const [collectionSelectedIds, setCollectionSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [compareSelectedIds, setCompareSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [compareOpen, setCompareOpen] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [collectionStatus, setCollectionStatus] = useState("Collections are session-only labels for renderer references.");
  const [editingCollectionId, setEditingCollectionId] = useState<string | null>(null);
  const [editingCollectionName, setEditingCollectionName] = useState("");

  const items = useMemo(() => {
    const merged = new Map<string, GalleryItem>(sampleItems.map((item) => [item.id, item]));
    recentItems.forEach((item) => merged.set(item.id, normaliseRecentItem(item)));
    return [...merged.values()];
  }, [recentItems]);

  const effectiveAssignments = useMemo(() => {
    const next: Record<string, readonly string[]> = { ...collectionAssignments };
    items.forEach((item) => {
      if (!(item.id in next) && item.collectionIds.length) next[item.id] = item.collectionIds;
    });
    return next;
  }, [collectionAssignments, items]);

  const activeCollection = collectionFilter !== "all" && collectionFilter !== "unassigned"
    ? collections.find((collection) => collection.id === collectionFilter)
    : undefined;
  const activeCollectionFilter = activeCollection ? activeCollection.id : collectionFilter === "unassigned" ? "unassigned" : "all";

  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matching = items.filter((item) => {
      if (filter !== "all" && item.kind !== filter) return false;
      if (statusFilter !== "all" && (item.status ?? "ready") !== statusFilter) return false;
      const itemCollectionIds = collectionIdsForItem(item.id, effectiveAssignments);
      if (activeCollectionFilter === "unassigned" && itemCollectionIds.length > 0) return false;
      if (activeCollectionFilter !== "all" && activeCollectionFilter !== "unassigned" && !itemCollectionIds.includes(activeCollectionFilter)) return false;
      if (!normalizedQuery) return true;
      const collectionText = itemCollectionIds
        .map((collectionId) => collections.find((collection) => collection.id === collectionId)?.name ?? collectionId)
        .join(" ");
      return [item.title, item.subtitle, item.detail, item.prompt, item.createdAt, collectionText, kindLabels[item.kind], statusLabels[item.status ?? "ready"]]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });

    if (sort === "recent") return matching;
    return [...matching].sort((left, right) => {
      if (sort === "title") return left.title.localeCompare(right.title);
      return `${left.kind}:${left.subtitle}:${left.title}`.localeCompare(`${right.kind}:${right.subtitle}:${right.title}`);
    });
  }, [activeCollectionFilter, collections, effectiveAssignments, filter, items, query, sort, statusFilter]);
  const selectedItem = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];
  const compareItems = [...compareSelectedIds]
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is GalleryItem => Boolean(item))
    .slice(0, 2);
  const counts = useMemo(() => ({
    all: items.length,
    image: items.filter((item) => item.kind === "image").length,
    video: items.filter((item) => item.kind === "video").length,
    audio: items.filter((item) => item.kind === "audio").length,
  }), [items]);

  const collectionCounts = useMemo(
    () => collectionItemCounts(items.map((item) => item.id), effectiveAssignments),
    [effectiveAssignments, items],
  );
  const unassignedCount = useMemo(
    () => items.filter((item) => collectionIdsForItem(item.id, effectiveAssignments).length === 0).length,
    [effectiveAssignments, items],
  );

  const exportItems = useMemo<MediaGalleryExportItem[]>(() => {
    const source = exportScope === "visible"
      ? visibleItems
      : items.filter((item) => exportSelectedIds.has(item.id));
    return source.map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      subtitle: item.subtitle,
      detail: item.detail,
      prompt: item.prompt,
      createdAt: item.createdAt,
      status: item.status ?? "ready",
      source: item.source,
      collectionIds: collectionIdsForItem(item.id, effectiveAssignments),
    }));
  }, [effectiveAssignments, exportScope, exportSelectedIds, items, visibleItems]);

  const exportCollectionIds = useMemo(
    () => new Set(exportItems.flatMap((item) => item.collectionIds ?? [])),
    [exportItems],
  );
  const exportCollections = useMemo<MediaGalleryCollectionExport[]>(
    () => collections
      .filter((collection) => exportCollectionIds.has(collection.id))
      .map((collection) => ({ ...collection, itemCount: collectionCounts[collection.id] ?? 0 })),
    [collectionCounts, collections, exportCollectionIds],
  );

  const exportPayload = useMemo(
    () => serializeMediaGalleryExport({ items: exportItems, collections: exportCollections, format: exportFormat }),
    [exportCollections, exportFormat, exportItems],
  );

  const selectItem = (item: GalleryItem) => {
    setSelectedId(item.id);
    setStatus(`Inspecting ${item.title}; no media bytes were loaded.`);
  };

  const hasRefinement = query.trim().length > 0 || filter !== "all" || statusFilter !== "all" || sort !== "recent" || activeCollectionFilter !== "all";
  const clearRefinement = () => {
    setQuery("");
    setFilter("all");
    setStatusFilter("all");
    setSort("recent");
    setCollectionFilter("all");
    setStatus("Showing all renderer-local references in their recent order.");
  };

  const toggleExportSelection = (id: string) => {
    setExportSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setExportStatus("Selection changed; manifest remains renderer-local.");
  };

  const selectVisibleForExport = () => {
    setExportSelectedIds((current) => {
      const next = new Set(current);
      visibleItems.forEach((item) => next.add(item.id));
      return next;
    });
    setExportStatus(`Selected ${visibleItems.length} visible reference${visibleItems.length === 1 ? "" : "s"} for export.`);
  };

  const clearExportSelection = () => {
    setExportSelectedIds(new Set());
    setExportStatus("Export selection cleared; no durable write was made.");
  };

  const toggleCollectionSelection = (id: string) => {
    setCollectionSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setCollectionStatus("Collection selection changed; references remain renderer-local.");
  };

  const selectVisibleForCollection = () => {
    setCollectionSelectedIds((current) => {
      const next = new Set(current);
      visibleItems.forEach((item) => next.add(item.id));
      return next;
    });
    setCollectionStatus(`Selected ${visibleItems.length} visible reference${visibleItems.length === 1 ? "" : "s"} for collection editing.`);
  };

  const clearCollectionSelection = () => {
    setCollectionSelectedIds(new Set());
    setCollectionStatus("Collection selection cleared; no durable write was made.");
  };

  const toggleCompareSelection = (item: GalleryItem) => {
    setCompareSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else if (next.size < 2) next.add(item.id);
      return next;
    });
  };

  const createCollection = () => {
    const name = normalizeMediaGalleryCollectionName(newCollectionName);
    if (!name) {
      setCollectionStatus("Enter a collection name before creating it.");
      return;
    }
    if (collections.some((collection) => collection.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setCollectionStatus("A collection with that name already exists.");
      return;
    }
    const slug = name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "collection";
    const baseId = `collection-${slug}`;
    let id = baseId;
    let suffix = 2;
    while (collections.some((collection) => collection.id === id)) id = `${baseId}-${suffix++}`;
    const tones = ["blue", "teal", "amber", "coral"] as const;
    const tone = tones[collections.length % tones.length] ?? "blue";
    const collection: MediaGalleryCollection = {
      id,
      name,
      description: "Created in this renderer session.",
      tone,
    };
    setCollections((current) => [...current, collection]);
    setCollectionFilter(id);
    setNewCollectionName("");
    setCollectionStatus(`Created ${name}; it has no assigned references yet.`);
  };

  const startRenameCollection = (collection: MediaGalleryCollection) => {
    setEditingCollectionId(collection.id);
    setEditingCollectionName(collection.name);
  };

  const saveRenameCollection = (collectionId: string) => {
    const name = normalizeMediaGalleryCollectionName(editingCollectionName);
    if (!name) {
      setCollectionStatus("Enter a collection name before saving.");
      return;
    }
    if (collections.some((collection) => collection.id !== collectionId && collection.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setCollectionStatus("A collection with that name already exists.");
      return;
    }
    setCollections((current) => current.map((collection) => collection.id === collectionId ? { ...collection, name } : collection));
    setEditingCollectionId(null);
    setEditingCollectionName("");
    setCollectionStatus(`Renamed collection to ${name}.`);
  };

  const deleteCollection = (collection: MediaGalleryCollection) => {
    setCollections((current) => current.filter((candidate) => candidate.id !== collection.id));
    setCollectionAssignments((current) => removeItemsFromMediaGalleryCollection(current, items.map((item) => item.id), collection.id));
    if (collectionFilter === collection.id) setCollectionFilter("all");
    if (editingCollectionId === collection.id) setEditingCollectionId(null);
    setCollectionStatus(`Deleted ${collection.name}; references remain available as unsorted.`);
  };

  const addSelectedToCollection = () => {
    if (!activeCollection || !collectionSelectedIds.size) return;
    const itemIds = [...collectionSelectedIds];
    setCollectionAssignments((current) => addItemsToMediaGalleryCollection(current, itemIds, activeCollection.id));
    setCollectionStatus(`Added ${itemIds.length} reference${itemIds.length === 1 ? "" : "s"} to ${activeCollection.name}.`);
  };

  const removeSelectedFromCollection = () => {
    if (!activeCollection || !collectionSelectedIds.size) return;
    const itemIds = [...collectionSelectedIds];
    setCollectionAssignments((current) => removeItemsFromMediaGalleryCollection(current, itemIds, activeCollection.id));
    setCollectionStatus(`Removed ${itemIds.length} reference${itemIds.length === 1 ? "" : "s"} from ${activeCollection.name}.`);
  };

  const copyExport = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setExportStatus("Clipboard is unavailable; the visible manifest remains available.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setExportStatus(`${exportFormat.toUpperCase()} manifest copied; no durable write was made.`);
    } catch {
      setExportStatus("Clipboard access was denied; no manifest was copied.");
    }
  };

  const downloadExport = () => {
    setExportStatus(
      downloadMediaGalleryExport(exportPayload, exportFormat)
        ? `Downloaded a ${exportFormat.toUpperCase()} metadata preview; media bytes were not included.`
        : "Download is unavailable in this preview environment.",
    );
  };

  return (
    <section className="media-gallery-preview" aria-label="Media output gallery preview">
      <header className="media-gallery-preview__header">
        <div>
          <span className="eyebrow"><Sparkles size={13} aria-hidden="true" /> Output gallery</span>
          <h3>Compare visual directions</h3>
          <p>Review image, video, and audio references together before a provider endpoint is connected.</p>
        </div>
        <span className="media-gallery-preview__badge"><Sparkles size={12} aria-hidden="true" /> Preview only</span>
      </header>

      <div className="media-gallery-preview__metrics" aria-label="Gallery output counts">
        <span><strong>{counts.all}</strong><small>all references</small></span>
        <span><strong>{counts.image}</strong><small>images</small></span>
        <span><strong>{counts.video}</strong><small>videos</small></span>
        <span><strong>{counts.audio}</strong><small>audio</small></span>
      </div>

      <div className="media-gallery-preview__toolbar">
        <div className="media-gallery-preview__filters" role="group" aria-label="Gallery media filter">
          {(["all", "image", "video", "audio"] as const).map((entry) => (
            <button key={entry} type="button" className={filter === entry ? "is-selected" : ""} aria-pressed={filter === entry} onClick={() => setFilter(entry)}>
              {entry === "all" ? <Grid2X2 size={13} aria-hidden="true" /> : kindIcon(entry, 13)}
              {entry === "all" ? "All" : kindLabels[entry]}
              <span>{counts[entry]}</span>
            </button>
            ))}
        </div>
        <label className="media-gallery-preview__search">
          <Search size={13} aria-hidden="true" />
          <span className="sr-only">Search gallery references</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search references"
            aria-label="Search gallery references"
          />
          {query ? <button type="button" aria-label="Clear gallery search" onClick={() => setQuery("")}><X size={13} /></button> : null}
        </label>
        <label className="media-gallery-preview__select-control">
          <SlidersHorizontal size={13} aria-hidden="true" />
          <span className="sr-only">Gallery status filter</span>
          <select aria-label="Gallery status filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as GalleryStatusFilter)}>
            {(Object.keys(statusFilterLabels) as GalleryStatusFilter[]).map((entry) => <option key={entry} value={entry}>{statusFilterLabels[entry]}</option>)}
          </select>
        </label>
        <label className="media-gallery-preview__select-control">
          <span className="sr-only">Gallery sort</span>
          <select aria-label="Gallery sort" value={sort} onChange={(event) => setSort(event.target.value as GallerySort)}>
            <option value="recent">Recent first</option>
            <option value="title">Title A–Z</option>
            <option value="type">Media type</option>
          </select>
        </label>
        {hasRefinement ? <button type="button" className="media-gallery-preview__clear" onClick={clearRefinement}><X size={13} aria-hidden="true" /> Clear</button> : null}
        <button type="button" className="media-gallery-preview__selection-action" onClick={selectVisibleForExport} disabled={!visibleItems.length}><Check size={13} aria-hidden="true" /> Select visible</button>
        <button type="button" className="media-gallery-preview__selection-action" onClick={clearExportSelection} disabled={!exportSelectedIds.size}><X size={13} aria-hidden="true" /> Clear selected</button>
        <button type="button" className="media-gallery-preview__export-open" onClick={() => setExportOpen((current) => !current)} aria-expanded={exportOpen} aria-controls="media-gallery-export-preview"><FileJson2 size={13} aria-hidden="true" /> {exportOpen ? "Hide export" : "Export references"}<span>{exportSelectedIds.size}</span></button>
        <button type="button" className="media-gallery-preview__selection-action" onClick={() => setCompareOpen((current) => !current)} aria-expanded={compareOpen} aria-controls="media-gallery-compare-preview"><Columns2 size={13} aria-hidden="true" /> Compare <span>{compareSelectedIds.size}/2</span></button>
        <div className="media-gallery-preview__layout" role="group" aria-label="Gallery layout">
          <button type="button" aria-pressed={layout === "grid"} className={layout === "grid" ? "is-selected" : ""} onClick={() => setLayout("grid")} aria-label="Grid view"><Grid2X2 size={14} /></button>
          <button type="button" aria-pressed={layout === "list"} className={layout === "list" ? "is-selected" : ""} onClick={() => setLayout("list")} aria-label="List view"><List size={14} /></button>
        </div>
      </div>

      <section className="media-gallery-preview__collections" aria-label="Gallery collections">
        <header className="media-gallery-preview__collections-header">
          <div>
            <span className="eyebrow"><FolderOpen size={13} aria-hidden="true" /> Collections</span>
            <p>Group prompt and media references for this session.</p>
          </div>
          <form className="media-gallery-preview__collection-create" onSubmit={(event) => { event.preventDefault(); createCollection(); }}>
            <label className="sr-only" htmlFor="media-gallery-new-collection">New collection name</label>
            <input
              id="media-gallery-new-collection"
              value={newCollectionName}
              onChange={(event) => setNewCollectionName(event.target.value)}
              maxLength={48}
              placeholder="New collection…"
            />
            <button type="submit" aria-label="Create collection" disabled={!newCollectionName.trim()}><FolderPlus size={13} aria-hidden="true" /> Create</button>
          </form>
        </header>
        <div className="media-gallery-preview__collection-filters" role="group" aria-label="Filter by collection">
          <button type="button" className={collectionFilter === "all" ? "is-selected" : ""} aria-pressed={collectionFilter === "all"} onClick={() => setCollectionFilter("all")}>
            All references <span>{items.length}</span>
          </button>
          <button type="button" className={collectionFilter === "unassigned" ? "is-selected" : ""} aria-pressed={collectionFilter === "unassigned"} onClick={() => setCollectionFilter("unassigned")}>
            Unsorted <span>{unassignedCount}</span>
          </button>
          {collections.map((collection) => (
            <div key={collection.id} className={`media-gallery-preview__collection-option media-gallery-preview__collection-option--${collection.tone}`}>
              {editingCollectionId === collection.id ? (
                <form className="media-gallery-preview__collection-rename" onSubmit={(event) => { event.preventDefault(); saveRenameCollection(collection.id); }}>
                  <label className="sr-only" htmlFor={`media-gallery-rename-${collection.id}`}>Rename {collection.name}</label>
                  <input id={`media-gallery-rename-${collection.id}`} value={editingCollectionName} onChange={(event) => setEditingCollectionName(event.target.value)} maxLength={48} autoFocus />
                  <button type="submit" aria-label={`Save ${collection.name}`}><Check size={12} aria-hidden="true" /></button>
                  <button type="button" aria-label={`Cancel renaming ${collection.name}`} onClick={() => { setEditingCollectionId(null); setEditingCollectionName(""); }}><X size={12} aria-hidden="true" /></button>
                </form>
              ) : (
                <>
                  <button type="button" className={`media-gallery-preview__collection-filter${collectionFilter === collection.id ? " is-selected" : ""}`} aria-pressed={collectionFilter === collection.id} onClick={() => setCollectionFilter(collection.id)}>
                    <span className="media-gallery-preview__collection-dot" aria-hidden="true" />
                    {collection.name} <span>{collectionCounts[collection.id] ?? 0}</span>
                  </button>
                  <button type="button" className="media-gallery-preview__collection-manage" aria-label={`Rename ${collection.name}`} onClick={() => startRenameCollection(collection)}><Pencil size={12} aria-hidden="true" /></button>
                  <button type="button" className="media-gallery-preview__collection-manage" aria-label={`Delete ${collection.name}`} onClick={() => deleteCollection(collection)}><Trash2 size={12} aria-hidden="true" /></button>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="media-gallery-preview__collection-actions">
          <span>{collectionSelectedIds.size} selected for collection edits</span>
          <button type="button" className="media-gallery-preview__selection-action" onClick={selectVisibleForCollection} disabled={!visibleItems.length}><Check size={13} aria-hidden="true" /> Select visible</button>
          <button type="button" className="media-gallery-preview__selection-action" onClick={clearCollectionSelection} disabled={!collectionSelectedIds.size}><X size={13} aria-hidden="true" /> Clear collection selection</button>
          <button type="button" className="media-gallery-preview__selection-action" onClick={addSelectedToCollection} disabled={!activeCollection || !collectionSelectedIds.size}><FolderPlus size={13} aria-hidden="true" /> Add to {activeCollection?.name ?? "collection"}</button>
          <button type="button" className="media-gallery-preview__selection-action" onClick={removeSelectedFromCollection} disabled={!activeCollection || !collectionSelectedIds.size}><X size={13} aria-hidden="true" /> Remove from {activeCollection?.name ?? "collection"}</button>
        </div>
        <p className="media-gallery-preview__collection-status" aria-live="polite" aria-atomic="true">{collectionStatus} This is renderer-session metadata only.</p>
      </section>

      <div className="media-gallery-preview__results-summary" aria-live="polite" aria-atomic="true">
        <span>{visibleItems.length} of {items.length} references shown</span>
        {activeCollection ? <span>Collection: {activeCollection.name}</span> : collectionFilter === "unassigned" ? <span>Collection: Unsorted</span> : null}
        {query.trim() ? <span>Search: “{query.trim()}”</span> : null}
        {statusFilter !== "all" ? <span>Status: {statusFilterLabels[statusFilter]}</span> : null}
      </div>

      {compareOpen ? (
        <section id="media-gallery-compare-preview" className="media-gallery-preview__compare" aria-label="Media reference comparison">
          <header>
            <div><span className="eyebrow"><Columns2 size={12} aria-hidden="true" /> Direction workbench</span><h4>Compare references</h4><p>Compare prompt and metadata side by side. This does not compare generated media bytes.</p></div>
            <button type="button" className="media-gallery-preview__clear" onClick={() => setCompareSelectedIds(new Set())} disabled={!compareSelectedIds.size}><X size={13} aria-hidden="true" /> Clear pair</button>
          </header>
          {compareItems.length < 2 ? (
            <div className="media-gallery-preview__compare-empty" role="status" aria-live="polite">
              <strong>{compareItems.length === 1 ? "Choose one more reference" : "Choose two references"}</strong>
              <span>{compareItems.length === 1 ? `${compareItems[0]?.title ?? "One reference"} is ready. Add another card to see the comparison.` : "Use the Compare button on any two gallery cards to review their direction and metadata."}</span>
            </div>
          ) : (() => {
            const [left, right] = compareItems as [GalleryItem, GalleryItem];
            const comparisonRows = [
              { label: "Type", left: kindLabels[left.kind], right: kindLabels[right.kind] },
              { label: "Preset", left: left.subtitle, right: right.subtitle },
              { label: "Format", left: left.detail, right: right.detail },
              { label: "Status", left: statusLabels[left.status ?? "ready"], right: statusLabels[right.status ?? "ready"] },
              { label: "Source", left: left.source === "history" ? "Renderer history" : "Gallery sample", right: right.source === "history" ? "Renderer history" : "Gallery sample" },
              { label: "Prompt", left: left.prompt, right: right.prompt },
            ];
            return (
              <div className="media-gallery-preview__compare-grid">
                {[left, right].map((item, index) => (
                  <article key={item.id} className="media-gallery-preview__compare-item">
                    <div className="media-gallery-preview__compare-title"><span>{index === 0 ? "A" : "B"}</span><div><strong>{item.title}</strong><small>{kindLabels[item.kind]} · {item.source === "history" ? "Renderer history" : "Sample reference"}</small></div><button type="button" aria-label={`Remove ${item.title} from comparison`} onClick={() => toggleCompareSelection(item)}><X size={13} aria-hidden="true" /></button></div>
                    <dl>{comparisonRows.map((row) => {
                      const value = index === 0 ? row.left : row.right;
                      const differs = row.left !== row.right;
                      return <div key={row.label} className={differs ? "is-different" : "is-matching"}><dt>{row.label}<span>{differs ? "Different" : "Same"}</span></dt><dd>{value}</dd></div>;
                    })}</dl>
                  </article>
                ))}
                <p className="media-gallery-preview__compare-boundary"><Info size={13} aria-hidden="true" /> Comparison is renderer-local metadata only; preview art and prompts do not prove provider output or artifact quality.</p>
              </div>
            );
          })()}
        </section>
      ) : null}

      <div className={`media-gallery-preview__body media-gallery-preview__body--${layout}`}>
        <div className="media-gallery-preview__collection" role="list" aria-label={`${kindLabels[filter as MediaGalleryKind] ?? "All"} gallery references`}>
          {visibleItems.length ? visibleItems.map((item) => <GalleryCard key={item.id} item={item} selected={item.id === selectedItem?.id} exportSelected={exportSelectedIds.has(item.id)} collectionSelected={collectionSelectedIds.has(item.id)} compareSelected={compareSelectedIds.has(item.id)} compareDisabled={compareSelectedIds.size >= 2 && !compareSelectedIds.has(item.id)} onSelect={() => selectItem(item)} onToggleExport={() => toggleExportSelection(item.id)} onToggleCollection={() => toggleCollectionSelection(item.id)} onToggleCompare={() => toggleCompareSelection(item)} />) : (
            <div className="media-gallery-preview__empty"><Info size={18} aria-hidden="true" /><strong>No references match these refinements</strong><span>Clear the search or choose another media type/status to keep exploring the preview.</span><button type="button" className="button button--ghost button--compact" onClick={clearRefinement}><X size={13} aria-hidden="true" /> Clear refinements</button></div>
          )}
        </div>

        {selectedItem ? (
          <aside className="media-gallery-preview__detail" aria-label="Selected media output details">
            <div className="media-gallery-preview__detail-heading"><span className={`media-gallery-preview__detail-icon media-gallery-preview__detail-icon--${selectedItem.kind}`}>{kindIcon(selectedItem.kind, 16)}</span><div><span className="eyebrow">Selected reference</span><h4>{selectedItem.title}</h4></div></div>
            <dl>
              <div><dt>Type</dt><dd>{kindLabels[selectedItem.kind]}</dd></div>
              <div><dt>Preset</dt><dd>{selectedItem.subtitle}</dd></div>
              <div><dt>Shape</dt><dd>{selectedItem.detail}</dd></div>
              <div><dt>Source</dt><dd>{selectedItem.source === "history" ? "Renderer history" : "Gallery sample"}</dd></div>
            </dl>
            <div className="media-gallery-preview__prompt"><span>Prompt reference</span><p>{selectedItem.prompt}</p></div>
            <button type="button" className="button button--ghost button--compact" onClick={() => {
              setStatus(`Marked ${selectedItem.title} as the next direction; no request was sent.`);
              onUseAsNextDirection?.(selectedItem);
            }}><Play size={13} aria-hidden="true" /> Use as next direction</button>
            <p className="media-gallery-preview__status-line" role="status" aria-live="polite">{status}</p>
            <MediaAssetInspector
              item={{
                id: selectedItem.id,
                title: selectedItem.title,
                kind: selectedItem.kind,
                subtitle: selectedItem.subtitle,
                detail: selectedItem.detail,
                prompt: selectedItem.prompt,
                createdAt: selectedItem.createdAt,
                status: selectedItem.status ?? "ready",
                source: selectedItem.source,
              }}
              exportSelected={exportSelectedIds.has(selectedItem.id)}
              onToggleExport={() => toggleExportSelection(selectedItem.id)}
            />
          </aside>
        ) : null}
      </div>

      {exportOpen ? (
        <section id="media-gallery-export-preview" className="media-gallery-preview__export" aria-label="Media gallery export preview">
          <header>
            <div><span className="eyebrow"><FileJson2 size={12} aria-hidden="true" /> Portable manifest</span><h4>Export reference metadata</h4><p>Carry selected directions into another renderer session without implying that an artifact exists.</p></div>
            <div className="media-gallery-preview__export-toolbar">
              <label><span>Rows</span><select aria-label="Media gallery export rows" value={exportScope} onChange={(event) => setExportScope(event.target.value as "selected" | "visible")}><option value="selected">Selected ({exportSelectedIds.size})</option><option value="visible">Visible ({visibleItems.length})</option></select></label>
              <label><span>Format</span><select aria-label="Media gallery export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as MediaGalleryExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
              <button type="button" className="button button--ghost button--compact" onClick={() => void copyExport()}><Clipboard size={13} aria-hidden="true" /> Copy</button>
              <button type="button" className="button button--secondary button--compact" onClick={downloadExport}><Download size={13} aria-hidden="true" /> Download</button>
            </div>
          </header>
          <div className="media-gallery-preview__export-summary"><span><strong>{exportItems.length}</strong> reference{exportItems.length === 1 ? "" : "s"} included</span><span role="status" aria-live="polite">{exportStatus}</span></div>
          <pre tabIndex={0}><code>{exportPayload}</code></pre>
          <p className="media-gallery-preview__boundary"><Info size={14} aria-hidden="true" /> Export is browser-session only. The manifest contains metadata and prompt references, never generated bytes, credentials, provider responses, or a native artifact receipt.</p>
        </section>
      ) : null}

      <p className="media-gallery-preview__boundary"><Info size={14} aria-hidden="true" /> Gallery cards are CSS references only. No generated bytes, provider result, upload, native file, or durable asset record is present.</p>
    </section>
  );
}

export default MediaGalleryPreview;
