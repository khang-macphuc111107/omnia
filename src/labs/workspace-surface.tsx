import { AlertTriangle, RefreshCw } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";

import type { ShellView, WorkspaceView } from "@/agent/shell-view";
import { ActivityScreenHost } from "@/features/workspace/activity-screen-host";
import type { ActivityId } from "@/features/workspace/activity-registry";
import { CommandPaletteHost } from "@/features/workspace/command-palette-host";
import { GlobalDialogsHost } from "@/features/workspace/global-dialogs-host";
import { applyRunStreamEventToStore, subscribeRunEvents } from "@/features/workspace/run-event-broker";
import { useWorkspaceStore } from "@/features/workspace/store";

import { useWorkspaceRuntime } from "./workspace-runtime";

import "@/styles/index.css";
import "@/styles/review-chat-shell.css";
import "./workspace-surface.css";

const SovereignIdeRemoteWorkbench = lazy(
  () => import("@/features/workspace/sovereign-ide-remote-workbench"),
);
const SovereignBrowserWorkbench = lazy(
  () => import("@/features/workspace/sovereign-browser-workbench"),
);

function SurfaceStatus({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="activity-load-state" role="status" aria-live="polite">
      <div>
        <span className="eyebrow">Opening workspace</span>
        <h1>{label}</h1>
        <p>{detail}</p>
      </div>
      <span className="activity-load-progress" aria-hidden="true" />
    </div>
  );
}

function SurfaceError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="activity-load-state activity-load-state--error" role="alert">
      <span className="activity-load-state__icon">
        <AlertTriangle size={22} />
      </span>
      <div>
        <span className="eyebrow">Workspace unavailable</span>
        <h1>The workspace runtime could not start</h1>
        <p>{error}</p>
      </div>
      <button type="button" className="button button--secondary" onClick={onRetry}>
        <RefreshCw size={15} /> Retry
      </button>
    </div>
  );
}

export const LIBRARY_TABS = [
  { id: "library", label: "Library" },
  { id: "memory", label: "Memory" },
  { id: "skills", label: "Skills" },
] as const;

export type LibraryTab = (typeof LIBRARY_TABS)[number]["id"];

function isLibraryTab(activity: ActivityId): activity is LibraryTab {
  return LIBRARY_TABS.some((tab) => tab.id === activity);
}

/** Last Library tab; kept in memory only (not persisted) so it survives view switches. */
let rememberedLibraryTab: LibraryTab = "library";

/**
 * Maps a workspace-store activity (set by screens' own links) to a shell view.
 * Memory and Skills live inside Library; "home" and "chats" are the Home hub.
 */
function shellViewForActivity(activity: ActivityId): ShellView | null {
  if (activity === "home" || activity === "chats") return "agent";
  if (activity === "settings") return null;
  if (isLibraryTab(activity)) return "library";
  return activity;
}

export function resetLibraryTabForTests(): void {
  rememberedLibraryTab = "library";
}

function LibraryTabs({ tab, onSelect }: { tab: LibraryTab; onSelect: (tab: LibraryTab) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = LIBRARY_TABS.length - 1;
    let next = index;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else return;
    event.preventDefault();
    onSelect(LIBRARY_TABS[next]?.id ?? "library");
    refs.current[next]?.focus();
  };
  return (
    <div className="ws-library-tabs" role="tablist" aria-label="Library sections">
      {LIBRARY_TABS.map((entry, index) => (
        <button
          key={entry.id}
          ref={(node) => {
            refs.current[index] = node;
          }}
          type="button"
          role="tab"
          id={`ws-library-tab-${entry.id}`}
          aria-selected={tab === entry.id}
          aria-controls="ws-library-panel"
          tabIndex={tab === entry.id ? 0 : -1}
          className="ws-library-tabs__tab"
          onClick={() => onSelect(entry.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

export interface WorkspaceSurfaceProps {
  view: WorkspaceView;
  /**
   * Called when a screen navigates elsewhere through the workspace store
   * (e.g. "Open projects", "Open chat"). "home" and "chats" map to "agent";
   * "memory" and "skills" map to "library" (the tab is switched here). "settings"
   * is ignored. Optional: without it, such links are ignored by the shell.
   */
  onNavigate?: (view: ShellView) => void;
}

/**
 * Former Labs workspace screens, hosted inside the agent shell's main area.
 * Navigation chrome (rail, title bar, Alt+digit, Ctrl+K) belongs to the shell;
 * this surface only renders the selected screen plus the dialog hosts the
 * screens open through the workspace overlay store.
 */
export default function WorkspaceSurface({ view, onNavigate }: WorkspaceSurfaceProps): JSX.Element {
  const { runtime, coreRuntime, error, retry } = useWorkspaceRuntime();
  const viewRef = useRef(view);
  const onNavigateRef = useRef(onNavigate);
  viewRef.current = view;
  onNavigateRef.current = onNavigate;

  const [libraryTab, setLibraryTabState] = useState<LibraryTab>(rememberedLibraryTab);
  const setLibraryTab = useCallback((tab: LibraryTab) => {
    rememberedLibraryTab = tab;
    setLibraryTabState(tab);
  }, []);

  // Keep the workspace store's activity aligned with the shell view (and the
  // Library tab) so screens and the command palette see the right context.
  useEffect(() => {
    if (view === "code" || view === "browser") return;
    const activity: ActivityId = view === "library" ? libraryTab : view;
    if (useWorkspaceStore.getState().activeActivity !== activity) {
      useWorkspaceStore.getState().setActivity(activity);
    }
  }, [view, libraryTab]);

  useEffect(
    () =>
      useWorkspaceStore.subscribe((state, previous) => {
        if (state.activeActivity === previous.activeActivity) return;
        const activity = state.activeActivity;
        if (isLibraryTab(activity)) setLibraryTab(activity);
        const target = shellViewForActivity(activity);
        if (!target || target === viewRef.current) return;
        onNavigateRef.current?.(target);
      }),
    [setLibraryTab],
  );

  // Native turns keep projecting into the store while screens are visible.
  // The broker reference-counts this shared callback, so it never duplicates
  // deltas with the Labs workspace or other subscribers.
  useEffect(() => {
    if (!runtime?.tauri) return;
    return subscribeRunEvents(applyRunStreamEventToStore);
  }, [runtime?.tauri]);

  let body: JSX.Element;
  if (error) {
    body = <SurfaceError error={error} onRetry={retry} />;
  } else if (!runtime) {
    body = <SurfaceStatus label="Workspace" detail="Connecting to the Omnia runtime…" />;
  } else if (view === "code") {
    body = (
      <Suspense fallback={<SurfaceStatus label="Embedded VS Code" detail="Loading the embedded editor surface." />}>
        <SovereignIdeRemoteWorkbench />
      </Suspense>
    );
  } else if (view === "browser") {
    body = (
      <Suspense fallback={<SurfaceStatus label="Sovereign Browser" detail="Loading the embedded browser surface." />}>
        <SovereignBrowserWorkbench />
      </Suspense>
    );
  } else if (view === "library") {
    body = (
      <div className="ws-library">
        <LibraryTabs tab={libraryTab} onSelect={setLibraryTab} />
        <div className="ws-library__panel" role="tabpanel" id="ws-library-panel" aria-labelledby={`ws-library-tab-${libraryTab}`}>
          <ActivityScreenHost activity={libraryTab} runtime={runtime} coreRuntime={coreRuntime} />
        </div>
      </div>
    );
  } else {
    body = <ActivityScreenHost activity={view} runtime={runtime} coreRuntime={coreRuntime} />;
  }

  const fullBleed = view === "code" || view === "browser";
  return (
    <div className={`ws-surface${fullBleed ? " ws-surface--full-bleed" : ""}`} data-view={view}>
      {body}
      {runtime ? (
        <>
          {/* No global key handler: renders only while the store says open. */}
          <CommandPaletteHost />
          <GlobalDialogsHost />
        </>
      ) : null}
    </div>
  );
}
