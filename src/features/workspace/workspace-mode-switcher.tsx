import { Code2, Globe2, MessageSquareText } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { useWorkspaceStore } from "./store";
import type { ActivityId } from "./types";

export const WORKSPACE_MODES = [
  { id: "chats", label: "Chat", modeAttr: "chat", shortcut: "Ctrl+1" },
  { id: "ide-remote", label: "IDE", modeAttr: "code", shortcut: "Ctrl+2" },
  { id: "browser", label: "Browser", modeAttr: "browser", shortcut: "Ctrl+3" },
] as const;

export type WorkspaceMode = (typeof WORKSPACE_MODES)[number]["modeAttr"];

/** The mode switcher intentionally exposes only the three primary surfaces. */
export const MODE_ORDER: readonly WorkspaceMode[] = ["chat", "code", "browser"];

const modeIcon: Record<WorkspaceMode, ReactNode> = {
  chat: <MessageSquareText size={14} aria-hidden="true" />,
  code: <Code2 size={14} aria-hidden="true" />,
  browser: <Globe2 size={14} aria-hidden="true" />,
};

export const WORKSPACE_MODE_CHANGE_EVENT = "omnia:workspace-mode-change";

type WorkspaceSurfaceListener = () => void;

const workspaceSurfaceListeners = new Set<WorkspaceSurfaceListener>();

function writeWorkspaceSurfaceDataset(surface: WorkspaceMode) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.workspaceSurface = surface;
  }
}

let workspaceSurface: WorkspaceMode = "chat";

/**
 * Read the renderer-local surface override used by App to switch the stage to
 * the embedded Code or Browser workbench. It is intentionally not persisted:
 * changing the normal activity always returns the stage to Chat.
 */
export function getWorkspaceSurface(): WorkspaceMode {
  return workspaceSurface;
}

export function subscribeWorkspaceSurface(listener: WorkspaceSurfaceListener): () => void {
  workspaceSurfaceListeners.add(listener);
  return () => workspaceSurfaceListeners.delete(listener);
}

export function useWorkspaceSurface(): WorkspaceMode {
  return useSyncExternalStore(subscribeWorkspaceSurface, getWorkspaceSurface, () => "chat");
}

export function setWorkspaceSurface(surface: WorkspaceMode) {
  const datasetAlreadyMatches =
    typeof document === "undefined" || document.documentElement.dataset.workspaceSurface === surface;
  const changed = workspaceSurface !== surface || !datasetAlreadyMatches;
  workspaceSurface = surface;
  writeWorkspaceSurfaceDataset(surface);
  if (!changed) return;
  workspaceSurfaceListeners.forEach((listener) => listener());

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<WorkspaceMode>(WORKSPACE_MODE_CHANGE_EVENT, { detail: surface }),
    );
  }
}

function modeForActivity(activity: ActivityId): WorkspaceMode | null {
  // Projects share the ordinary Chat surface; they are no longer a separate
  // top-level mode in the title bar.
  if (activity === "chats" || activity === "projects") return "chat";
  return null;
}

function resetWorkspaceSurfaceForActivity(activity: ActivityId) {
  const activityMode = modeForActivity(activity);
  // Non-workspace activities render in the standard stage as well. Keep the
  // dataset deterministic instead of leaking the last full-bleed surface into
  // Library, Settings, or another activity.
  setWorkspaceSurface(activityMode ?? "chat");
}

const initialActivityMode = modeForActivity(useWorkspaceStore.getState().activeActivity);
if (initialActivityMode === "chat") {
  workspaceSurface = initialActivityMode;
}
writeWorkspaceSurfaceDataset(workspaceSurface);

// Zustand changes can come from the activity rail, command palette, or tests,
// not just from this control. Keep the full-bleed override honest across all
// navigation paths.
useWorkspaceStore.subscribe((state, previousState) => {
  if (state.activeActivity !== previousState.activeActivity) {
    resetWorkspaceSurfaceForActivity(state.activeActivity);
  }
});

/** Three primary Omnia work surfaces: Chat, IDE, and Browser. */
export function WorkspaceModeSwitcher() {
  const activeActivity = useWorkspaceStore((state) => state.activeActivity);
  const setActivity = useWorkspaceStore((state) => state.setActivity);
  const workspaceSurfaceOverride = useWorkspaceSurface();
  const activityMode = modeForActivity(activeActivity);
  const activeMode = workspaceSurfaceOverride === "code" || workspaceSurfaceOverride === "browser"
    ? workspaceSurfaceOverride
    : activityMode;
  const buttonRefs = useRef<Partial<Record<WorkspaceMode, HTMLButtonElement | null>>>({});

  useEffect(() => {
    const onModeShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      const state = useWorkspaceStore.getState();
      if (state.commandPaletteOpen) return;
      const mode = WORKSPACE_MODES.find((candidate) => candidate.shortcut === `Ctrl+${event.key}`);
      if (!mode) return;
      event.preventDefault();
      if (mode.modeAttr === "chat" && state.activeActivity !== "chats") state.setActivity("chats");
      setWorkspaceSurface(mode.modeAttr);
    };
    // Reserve the mode chords before the legacy activity shortcut handler,
    // whose Ctrl+2 binding otherwise navigates back to Projects.
    window.addEventListener("keydown", onModeShortcut, true);
    return () => window.removeEventListener("keydown", onModeShortcut, true);
  }, []);

  const focusMode = (mode: WorkspaceMode) => {
    buttonRefs.current[mode]?.focus();
  };

  const selectMode = (mode: WorkspaceMode) => {
    if (mode === "code" || mode === "browser") {
      if (getWorkspaceSurface() !== mode) setWorkspaceSurface(mode);
      return;
    }

    if (activeActivity !== "chats") setActivity("chats");
    // Explicitly normalize the surface when Chat was already active; the
    // activity subscription handles it when navigation changed.
    if (getWorkspaceSurface() !== mode) setWorkspaceSurface(mode);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") {
      return;
    }

    event.preventDefault();
    const focusedMode = (event.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.mode as
      | WorkspaceMode
      | undefined;
    const currentIndex = Math.max(0, MODE_ORDER.indexOf(focusedMode ?? activeMode ?? "chat"));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? MODE_ORDER.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + MODE_ORDER.length) % MODE_ORDER.length;
    const nextMode: WorkspaceMode = MODE_ORDER[nextIndex] ?? "chat";
    selectMode(nextMode);
    focusMode(nextMode);
  };

  const activeLabel = WORKSPACE_MODES.find((mode) => mode.modeAttr === activeMode)?.label ?? "Other surface";

  return (
    <div
      className="workspace-mode-switcher"
      data-testid="workspace-mode-switcher"
      role="group"
      aria-label="Primary workspace mode"
      aria-describedby="workspace-mode-switcher-help"
      data-active-mode={activeMode ?? "other"}
      onKeyDown={handleKeyDown}
    >
      {WORKSPACE_MODES.map(({ id, label, modeAttr, shortcut }) => (
        <button
          key={id}
          type="button"
          ref={(element) => {
            buttonRefs.current[modeAttr] = element;
          }}
          data-mode={modeAttr}
          data-testid={`workspace-mode-tab-${modeAttr}`}
          className={activeMode === modeAttr ? "workspace-mode-switcher__button workspace-mode-switcher__button--active" : "workspace-mode-switcher__button"}
          aria-pressed={activeMode === modeAttr}
          aria-keyshortcuts={shortcut.replace("Ctrl", "Control")}
          title={`${label} workspace · ${shortcut}`}
          onClick={() => selectMode(modeAttr)}
        >
          {modeIcon[modeAttr]}
          <span>{label}</span>
        </button>
      ))}
      <span id="workspace-mode-switcher-help" className="sr-only">
        Use Arrow Left or Arrow Right to move between Chat, IDE, and Browser, or Home and End to jump to an edge.
      </span>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {activeLabel} workspace selected.
      </span>
    </div>
  );
}
