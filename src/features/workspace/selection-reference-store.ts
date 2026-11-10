import { create } from "zustand";

import type { SelectionReferenceDraft } from "./selection-reference";

interface SelectionReferenceStore {
  /** Draft references are local UI state until native context binding exists. */
  references: SelectionReferenceDraft[];
  activeSelectionId: string | null;
  /** References are scoped to the active conversation and never leak across chats. */
  conversationId: string | null;
  setConversation: (conversationId: string | null) => void;
  setActiveSelection: (selectionId: string | null) => void;
  addReference: (reference: SelectionReferenceDraft) => void;
  removeReference: (referenceId: string) => void;
  clearReferences: () => void;
  reorderReference: (referenceId: string, direction: "up" | "down") => void;
}

export const useSelectionReferenceStore = create<SelectionReferenceStore>((set) => ({
  references: [],
  activeSelectionId: null,
  conversationId: null,
  setConversation: (conversationId) =>
    set((state) =>
      state.conversationId === conversationId
        ? state
        : { conversationId, references: [], activeSelectionId: null },
    ),
  setActiveSelection: (activeSelectionId) => set({ activeSelectionId }),
  addReference: (reference) =>
    set((state) => ({
      references: state.references.some((candidate) => candidate.id === reference.id)
        ? state.references
        : [...state.references, reference],
    })),
  removeReference: (referenceId) =>
    set((state) => ({
      references: state.references.filter((reference) => reference.id !== referenceId),
      activeSelectionId:
        state.references.find((reference) => reference.id === referenceId)?.anchor.selectionId === state.activeSelectionId
          ? null
          : state.activeSelectionId,
    })),
  clearReferences: () => set({ references: [], activeSelectionId: null }),
  reorderReference: (referenceId, direction) =>
    set((state) => {
      const index = state.references.findIndex((reference) => reference.id === referenceId);
      if (index < 0) return state;
      const nextIndex = direction === "up" ? index - 1 : index + 1;
      if (nextIndex < 0 || nextIndex >= state.references.length) return state;
      const references = [...state.references];
      const [reference] = references.splice(index, 1);
      if (!reference) return state;
      references.splice(nextIndex, 0, reference);
      return { references };
    }),
}));
