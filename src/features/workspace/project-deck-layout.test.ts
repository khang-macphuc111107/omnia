import { describe, expect, it } from "vitest";

import {
  PROJECT_DECK_LAYOUT_LIMIT,
  createProjectDeckLayoutId,
  removeProjectDeckLayout,
  sameProjectDeckLayoutSnapshot,
  upsertProjectDeckLayout,
  type ProjectDeckLayoutSnapshot,
  type SavedProjectDeckLayout,
} from "./project-deck-layout";

const snapshot: ProjectDeckLayoutSnapshot = {
  activeTab: "chats",
  showMetadata: true,
  chatFilter: "active",
  chatQuery: "handoff",
  chatSort: "attention",
  chatGrouping: "state",
  chatVisibleLimit: 8,
};

describe("Project Deck renderer-local layout contract", () => {
  it("creates a stable, human-readable id and preserves equivalent snapshots", () => {
    expect(createProjectDeckLayoutId(" Focus / handoff ", 1700000000000)).toBe("project-deck-layout-focus-handoff-1700000000000");
    expect(sameProjectDeckLayoutSnapshot(snapshot, { ...snapshot })).toBe(true);
    expect(sameProjectDeckLayoutSnapshot(snapshot, { ...snapshot, chatQuery: "other" })).toBe(false);
  });

  it("upserts case-insensitively and clones the snapshot", () => {
    const first = upsertProjectDeckLayout([], "Focus", snapshot, { now: 1700000000000 });
    expect(first.error).toBeUndefined();
    expect(first.activeId).toBe("project-deck-layout-focus-1700000000000");
    expect(first.layouts).toHaveLength(1);

    const changed = { ...snapshot, showMetadata: false };
    const second = upsertProjectDeckLayout(first.layouts, " focus ", changed, { now: 1700000001000 });
    expect(second.layouts).toHaveLength(1);
    expect(second.layouts[0]?.id).toBe(first.activeId);
    expect(second.layouts[0]?.snapshot).toEqual(changed);
    expect(second.layouts[0]?.snapshot).not.toBe(changed);
  });

  it("enforces the bounded renderer-session limit and removes by id", () => {
    const layouts: SavedProjectDeckLayout[] = Array.from({ length: PROJECT_DECK_LAYOUT_LIMIT }, (_, index) => ({
      id: `layout-${index}`,
      name: `Layout ${index}`,
      snapshot,
      updatedAt: "2026-09-27T00:00:00.000Z",
    }));
    const rejected = upsertProjectDeckLayout(layouts, "Overflow", snapshot, { now: 1700000000000 });
    expect(rejected.error).toMatch(/already has 12 saved layouts/i);
    expect(rejected.layouts).toHaveLength(PROJECT_DECK_LAYOUT_LIMIT);

    const removed = removeProjectDeckLayout(layouts, "layout-3");
    expect(removed.removed?.name).toBe("Layout 3");
    expect(removed.layouts).toHaveLength(PROJECT_DECK_LAYOUT_LIMIT - 1);
  });
});

