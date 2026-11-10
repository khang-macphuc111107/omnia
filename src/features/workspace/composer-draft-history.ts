import { useCallback, useRef, useState } from "react";

export type DraftChangeKind = "typing" | "voice" | "paste" | "format" | "studio";

export interface ComposerDraftHistoryController {
  undoCount: number;
  redoCount: number;
  canUndo: boolean;
  canRedo: boolean;
  update: (nextValue: string, kind?: DraftChangeKind) => void;
  undo: () => void;
  redo: () => void;
  reset: () => void;
  clearHistory: () => void;
}

type HistoryEntry = {
  past: string[];
  future: string[];
  lastKind: DraftChangeKind | null;
  lastChangedAt: number;
};

const MAX_HISTORY = 80;
const TYPING_COALESCE_MS = 900;

function emptyEntry(): HistoryEntry {
  return { past: [], future: [], lastKind: null, lastChangedAt: 0 };
}

function pushBounded(values: string[], value: string): string[] {
  return [...values, value].slice(-MAX_HISTORY);
}

export function useComposerDraftHistory(options: {
  conversationId: string;
  value: string;
  onChange: (value: string) => void;
}): ComposerDraftHistoryController {
  const historiesRef = useRef<Record<string, HistoryEntry>>({});
  const [, forceRender] = useState(0);
  const getEntry = useCallback(() => {
    const current = historiesRef.current[options.conversationId];
    if (current) return current;
    const created = emptyEntry();
    historiesRef.current[options.conversationId] = created;
    return created;
  }, [options.conversationId]);

  const update = useCallback(
    (nextValue: string, kind: DraftChangeKind = "studio") => {
      if (nextValue === options.value) return;
      const entry = getEntry();
      const now = Date.now();
      const coalesceTyping =
        kind === "typing" &&
        entry.lastKind === "typing" &&
        now - entry.lastChangedAt < TYPING_COALESCE_MS;
      if (!coalesceTyping) entry.past = pushBounded(entry.past, options.value);
      entry.future = [];
      entry.lastKind = kind;
      entry.lastChangedAt = now;
      options.onChange(nextValue);
      forceRender((value) => value + 1);
    },
    [getEntry, options],
  );

  const undo = useCallback(() => {
    const entry = getEntry();
    const previous = entry.past.pop();
    if (previous === undefined) return;
    entry.future = [options.value, ...entry.future].slice(0, MAX_HISTORY);
    entry.lastKind = "studio";
    entry.lastChangedAt = Date.now();
    options.onChange(previous);
    forceRender((value) => value + 1);
  }, [getEntry, options]);

  const redo = useCallback(() => {
    const entry = getEntry();
    const next = entry.future.shift();
    if (next === undefined) return;
    entry.past = pushBounded(entry.past, options.value);
    entry.lastKind = "studio";
    entry.lastChangedAt = Date.now();
    options.onChange(next);
    forceRender((value) => value + 1);
  }, [getEntry, options]);

  const reset = useCallback(() => update("", "studio"), [update]);

  const clearHistory = useCallback(() => {
    historiesRef.current[options.conversationId] = emptyEntry();
    forceRender((value) => value + 1);
  }, [options.conversationId]);

  const entry = getEntry();
  return {
    undoCount: entry.past.length,
    redoCount: entry.future.length,
    canUndo: entry.past.length > 0,
    canRedo: entry.future.length > 0,
    update,
    undo,
    redo,
    reset,
    clearHistory,
  };
}

