import { create } from "zustand";

import type { InspectorTab } from "./types";

type CitationReturnTab = Exclude<InspectorTab, "sources">;

interface CitationSelectionStore {
  selectedCitationId: string | null;
  returnTargetId: string | null;
  returnTab: CitationReturnTab;
  openCitation: (
    citationId: string,
    returnTargetId: string,
    returnTab: CitationReturnTab,
  ) => void;
  clearCitation: () => void;
}

export const useCitationSelectionStore = create<CitationSelectionStore>((set) => ({
  selectedCitationId: null,
  returnTargetId: null,
  returnTab: "context",
  openCitation: (selectedCitationId, returnTargetId, returnTab) =>
    set({ selectedCitationId, returnTargetId, returnTab }),
  clearCitation: () =>
    set({ selectedCitationId: null, returnTargetId: null, returnTab: "context" }),
}));

export function focusCitationReturnTarget(targetId: string | null): void {
  if (!targetId) return;
  const focus = () => document.getElementById(targetId)?.focus();
  if (typeof globalThis.requestAnimationFrame === "function") {
    globalThis.requestAnimationFrame(focus);
  } else {
    globalThis.setTimeout(focus, 0);
  }
}
