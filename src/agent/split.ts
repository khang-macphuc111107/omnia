/** Pure split-view state: two session panes side by side, one of them focused. */

export const SPLIT_MIN_WINDOW = 900;
export const SPLIT_MIN_PANE = 360;
export const SPLIT_MIN_RATIO = 0.25;
export const SPLIT_MAX_RATIO = 0.75;
export const SPLIT_DEFAULT_RATIO = 0.5;

export type PaneIndex = 0 | 1;

export interface SplitState {
  /** [left, right] session ids, or null when a single pane is shown. */
  panes: [string, string] | null;
  focused: PaneIndex;
  /** Width share of the left pane. */
  ratio: number;
  /** The session most recently closed out of the split; Ctrl+\ reopens it. */
  last: string | null;
}

export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_DEFAULT_RATIO;
  return Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, value));
}

/** Clamp so each pane keeps at least `SPLIT_MIN_PANE` px for the given container width. */
export function clampRatioForWidth(value: number, width: number): number {
  const ratio = clampRatio(value);
  if (!(width > 0)) return ratio;
  const floor = Math.min(0.5, SPLIT_MIN_PANE / width);
  return Math.min(1 - floor, Math.max(floor, ratio));
}

export function initialSplit(ratio?: number): SplitState {
  return { panes: null, focused: 0, ratio: clampRatio(ratio ?? SPLIT_DEFAULT_RATIO), last: null };
}

export function focusedId(split: SplitState): string | null {
  return split.panes ? split.panes[split.focused] : null;
}

/** Open `sessionId` in a split beside `activeId`; with a split already open it replaces the unfocused pane. */
export function openInSplit(split: SplitState, activeId: string | null, sessionId: string): SplitState {
  if (split.panes) {
    const at = split.panes.indexOf(sessionId);
    if (at >= 0) return { ...split, focused: at as PaneIndex };
    const other: PaneIndex = split.focused === 0 ? 1 : 0;
    const panes: [string, string] = [...split.panes];
    panes[other] = sessionId;
    return { ...split, panes, focused: other, last: split.panes[other] };
  }
  if (!activeId || activeId === sessionId) return split;
  return { ...split, panes: [activeId, sessionId], focused: 1 };
}

/** Make `sessionId` the focused pane's session (sidebar click while split). */
export function showInFocused(split: SplitState, sessionId: string): SplitState {
  if (!split.panes) return split;
  const at = split.panes.indexOf(sessionId);
  if (at >= 0) return { ...split, focused: at as PaneIndex };
  const panes: [string, string] = [...split.panes];
  panes[split.focused] = sessionId;
  return { ...split, panes };
}

/** Close one pane; the other becomes the single, focused session. */
export function closePane(split: SplitState, index: PaneIndex): SplitState {
  if (!split.panes) return split;
  return { ...split, panes: null, focused: 0, last: split.panes[index] };
}

/** Which session stays when a pane is closed. */
export function survivorOf(split: SplitState, index: PaneIndex): string | null {
  return split.panes ? split.panes[index === 0 ? 1 : 0] : null;
}

export function swapPanes(split: SplitState): SplitState {
  if (!split.panes) return split;
  return { ...split, panes: [split.panes[1], split.panes[0]], focused: split.focused === 0 ? 1 : 0 };
}

export function focusPane(split: SplitState, index: PaneIndex): SplitState {
  if (!split.panes || split.focused === index) return split;
  return { ...split, focused: index };
}

export function setRatio(split: SplitState, ratio: number): SplitState {
  return { ...split, ratio: clampRatio(ratio) };
}

/**
 * Drop panes whose session no longer exists. The survivor (if any) becomes the single session,
 * returned as `activeId` so callers can keep the store consistent.
 */
export function pruneSplit(split: SplitState, existing: ReadonlySet<string>): SplitState {
  if (!split.panes) return split;
  const [a, b] = split.panes;
  const aGone = !existing.has(a);
  const bGone = !existing.has(b);
  if (!aGone && !bGone) return split.last && !existing.has(split.last) ? { ...split, last: null } : split;
  return { ...split, panes: null, focused: 0, last: null };
}

/** Candidate for Ctrl+\ when no split is open: the remembered session, else the most recent other one. */
export function pickPartner(
  split: SplitState,
  activeId: string | null,
  sessions: ReadonlyArray<{ id: string; updatedAtMs: number }>,
): string | null {
  if (!activeId) return null;
  if (split.last && split.last !== activeId && sessions.some((s) => s.id === split.last)) return split.last;
  let best: { id: string; updatedAtMs: number } | null = null;
  for (const s of sessions) if (s.id !== activeId && (!best || s.updatedAtMs > best.updatedAtMs)) best = s;
  return best?.id ?? null;
}

/** Sessions visible on screen; a narrow window shows only the focused pane. */
export function visibleSessionIds(split: SplitState, activeId: string | null, narrow: boolean): string[] {
  if (!split.panes || narrow) return activeId ? [activeId] : [];
  return [...split.panes];
}

export const NARROW_PANEL_VIEWPORT = 720;

export function isNarrowWidth(width: number): boolean {
  return width < SPLIT_MIN_WINDOW;
}

export function isNarrowPanelViewport(width: number): boolean {
  return width <= NARROW_PANEL_VIEWPORT;
}
