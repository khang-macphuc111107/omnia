import { create } from "zustand";

import type { PlanChatOperationPreview } from "./plan-chat-operation";

export type WorkspaceOverlay =
  | { kind: "create-project" }
  | { kind: "start-conversation"; projectId?: string; planDraft?: {
      projectId: string;
      taskId?: string;
      taskTitle: string;
      text: string;
      operation?: PlanChatOperationPreview;
    } }
  | { kind: "connect-provider" }
  | { kind: "grant-folder"; projectId: string };

interface WorkspaceOverlayStore {
  activeOverlay: WorkspaceOverlay | null;
  openOverlay: (overlay: WorkspaceOverlay) => void;
  closeOverlay: () => void;
}

export const useWorkspaceOverlayStore = create<WorkspaceOverlayStore>()((set) => ({
  activeOverlay: null,
  openOverlay: (activeOverlay) => set({ activeOverlay }),
  closeOverlay: () => set({ activeOverlay: null }),
}));

export function openWorkspaceOverlay(overlay: WorkspaceOverlay): void {
  useWorkspaceOverlayStore.getState().openOverlay(overlay);
}

export function closeWorkspaceOverlay(): void {
  useWorkspaceOverlayStore.getState().closeOverlay();
}
