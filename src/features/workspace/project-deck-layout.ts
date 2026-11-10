/**
 * Renderer-local Project Control Deck layout presets.
 *
 * The snapshot deliberately contains navigation and display state only. It
 * never carries project metadata, provider credentials, workspace paths, or
 * any other native authority. A future native projection can reuse this
 * shape, but this module currently has no persistence side effects.
 */

export type ProjectDeckLayoutSnapshot = {
  readonly activeTab: string;
  readonly showMetadata: boolean;
  readonly chatFilter: string;
  readonly chatQuery: string;
  readonly chatSort: string;
  readonly chatGrouping: string;
  readonly chatVisibleLimit: number;
};

export type SavedProjectDeckLayout = {
  readonly id: string;
  readonly name: string;
  readonly snapshot: ProjectDeckLayoutSnapshot;
  readonly updatedAt: string;
};

export const PROJECT_DECK_LAYOUT_SCHEMA = "omnia.project-deck-layout.v1";
export const PROJECT_DECK_LAYOUT_LIMIT = 12;

export function cloneProjectDeckLayoutSnapshot(snapshot: ProjectDeckLayoutSnapshot): ProjectDeckLayoutSnapshot {
  return { ...snapshot };
}

export function sameProjectDeckLayoutSnapshot(
  left: ProjectDeckLayoutSnapshot,
  right: ProjectDeckLayoutSnapshot,
): boolean {
  return left.activeTab === right.activeTab
    && left.showMetadata === right.showMetadata
    && left.chatFilter === right.chatFilter
    && left.chatQuery === right.chatQuery
    && left.chatSort === right.chatSort
    && left.chatGrouping === right.chatGrouping
    && left.chatVisibleLimit === right.chatVisibleLimit;
}

export function createProjectDeckLayoutId(name: string, now = Date.now()): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "layout";
  return `project-deck-layout-${slug}-${now}`;
}

export function upsertProjectDeckLayout(
  layouts: readonly SavedProjectDeckLayout[],
  name: string,
  snapshot: ProjectDeckLayoutSnapshot,
  options: { readonly id?: string; readonly now?: number } = {},
): { readonly layouts: SavedProjectDeckLayout[]; readonly activeId: string | null; readonly error?: string } {
  const trimmedName = name.trim();
  if (!trimmedName) return { layouts: [...layouts], activeId: null, error: "Enter a name before saving this layout." };

  const matchingIndex = layouts.findIndex((layout) => layout.name.toLowerCase() === trimmedName.toLowerCase());
  const existingId = options.id ?? (matchingIndex >= 0 ? layouts[matchingIndex]!.id : undefined);
  if (matchingIndex < 0 && layouts.length >= PROJECT_DECK_LAYOUT_LIMIT) {
    return {
      layouts: [...layouts],
      activeId: null,
      error: `This renderer session already has ${PROJECT_DECK_LAYOUT_LIMIT} saved layouts. Delete one before saving another.`,
    };
  }

  const saved: SavedProjectDeckLayout = {
    id: existingId ?? createProjectDeckLayoutId(trimmedName, options.now),
    name: trimmedName,
    snapshot: cloneProjectDeckLayoutSnapshot(snapshot),
    updatedAt: new Date(options.now ?? Date.now()).toISOString(),
  };
  const next = matchingIndex >= 0
    ? layouts.map((layout, index) => index === matchingIndex ? saved : layout)
    : [...layouts, saved];
  return { layouts: next, activeId: saved.id };
}

export function removeProjectDeckLayout(
  layouts: readonly SavedProjectDeckLayout[],
  id: string,
): { readonly layouts: SavedProjectDeckLayout[]; readonly removed?: SavedProjectDeckLayout } {
  const removed = layouts.find((layout) => layout.id === id);
  return {
    layouts: layouts.filter((layout) => layout.id !== id),
    ...(removed ? { removed } : {}),
  };
}

