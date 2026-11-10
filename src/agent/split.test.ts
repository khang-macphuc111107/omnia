import { describe, expect, it } from "vitest";

import {
  NARROW_PANEL_VIEWPORT,
  SPLIT_DEFAULT_RATIO,
  SPLIT_MAX_RATIO,
  SPLIT_MIN_RATIO,
  clampRatio,
  clampRatioForWidth,
  closePane,
  focusPane,
  focusedId,
  initialSplit,
  isNarrowPanelViewport,
  isNarrowWidth,
  openInSplit,
  pickPartner,
  pruneSplit,
  setRatio,
  showInFocused,
  survivorOf,
  swapPanes,
  visibleSessionIds,
} from "./split";

const opened = () => openInSplit(initialSplit(), "a", "b");

describe("split reducer", () => {
  it("opens a second session beside the active one and focuses it", () => {
    const split = opened();
    expect(split.panes).toEqual(["a", "b"]);
    expect(split.focused).toBe(1);
    expect(focusedId(split)).toBe("b");
  });

  it("ignores opening the active session against itself or with nothing active", () => {
    const empty = initialSplit();
    expect(openInSplit(empty, "a", "a")).toBe(empty);
    expect(openInSplit(empty, null, "a")).toBe(empty);
  });

  it("replaces the unfocused pane when a split is already open, and focuses an already-shown session", () => {
    const next = openInSplit(opened(), "b", "c"); // b focused (right) -> replace left
    expect(next.panes).toEqual(["c", "b"]);
    expect(next.focused).toBe(0);
    expect(next.last).toBe("a");
    expect(openInSplit(next, "c", "b").focused).toBe(1);
  });

  it("showInFocused swaps the focused pane or focuses the pane that already has it", () => {
    const split = opened();
    expect(showInFocused(split, "z").panes).toEqual(["a", "z"]);
    expect(showInFocused(split, "a").focused).toBe(0);
    expect(showInFocused(initialSplit(), "z").panes).toBeNull();
  });

  it("closes a pane, keeps the other as the survivor and remembers the closed one", () => {
    const split = opened();
    expect(survivorOf(split, 0)).toBe("b");
    const closed = closePane(split, 0);
    expect(closed.panes).toBeNull();
    expect(closed.last).toBe("a");
    expect(closePane(initialSplit(), 0).panes).toBeNull();
  });

  it("swaps panes and keeps the same session focused", () => {
    const swapped = swapPanes(opened());
    expect(swapped.panes).toEqual(["b", "a"]);
    expect(swapped.focused).toBe(0);
    expect(focusedId(swapped)).toBe("b");
  });

  it("changes focus only with a split open", () => {
    expect(focusPane(opened(), 0).focused).toBe(0);
    const single = initialSplit();
    expect(focusPane(single, 1)).toBe(single);
  });

  it("clamps the ratio", () => {
    expect(clampRatio(0.01)).toBe(SPLIT_MIN_RATIO);
    expect(clampRatio(0.99)).toBe(SPLIT_MAX_RATIO);
    expect(clampRatio(Number.NaN)).toBe(SPLIT_DEFAULT_RATIO);
    expect(setRatio(opened(), 0.6).ratio).toBe(0.6);
    expect(initialSplit(5).ratio).toBe(SPLIT_MAX_RATIO);
  });

  it("keeps a minimum pane width for the container", () => {
    // 1000px: 360px min pane => ratio within [0.36, 0.64].
    expect(clampRatioForWidth(0.3, 1000)).toBeCloseTo(0.36);
    expect(clampRatioForWidth(0.7, 1000)).toBeCloseTo(0.64);
    expect(clampRatioForWidth(0.5, 0)).toBe(0.5);
  });

  it("collapses when a pane's session disappears", () => {
    const split = opened();
    expect(pruneSplit(split, new Set(["a", "b"]))).toBe(split);
    expect(pruneSplit(split, new Set(["a"])).panes).toBeNull();
  });

  it("picks the remembered partner, else the most recent other session", () => {
    const sessions = [
      { id: "a", updatedAtMs: 5 },
      { id: "b", updatedAtMs: 1 },
      { id: "c", updatedAtMs: 9 },
    ];
    expect(pickPartner(initialSplit(), "a", sessions)).toBe("c");
    expect(pickPartner({ ...initialSplit(), last: "b" }, "a", sessions)).toBe("b");
    expect(pickPartner({ ...initialSplit(), last: "gone" }, "a", sessions)).toBe("c");
    expect(pickPartner(initialSplit(), "a", [{ id: "a", updatedAtMs: 1 }])).toBeNull();
    expect(pickPartner(initialSplit(), null, sessions)).toBeNull();
  });

  it("falls back to the focused pane only below 900px and identifies narrow panel viewports", () => {
    expect(isNarrowWidth(899)).toBe(true);
    expect(isNarrowWidth(900)).toBe(false);
    expect(isNarrowPanelViewport(NARROW_PANEL_VIEWPORT)).toBe(true);
    expect(isNarrowPanelViewport(NARROW_PANEL_VIEWPORT + 1)).toBe(false);
    const split = opened();
    expect(visibleSessionIds(split, "b", false)).toEqual(["a", "b"]);
    expect(visibleSessionIds(split, "b", true)).toEqual(["b"]);
    expect(visibleSessionIds(initialSplit(), "a", false)).toEqual(["a"]);
    expect(visibleSessionIds(initialSplit(), null, false)).toEqual([]);
  });
});
