import { lazy, Suspense, useEffect } from "react";

import { BootScreen } from "@/components/boot-screen";
import { PanelScrim } from "@/components/panel-scrim";
import { applyAppearance } from "@/design-system/appearance";
import { ActivityRail } from "@/features/workspace/activity-rail";
import { resolveSessionShortcut } from "@/features/workspace/keyboard-shortcut-session";
import { ActivityScreenHost } from "@/features/workspace/activity-screen-host";
import type { ActivityModuleLoader } from "@/features/workspace/activity-screen-host";
import { CommandPaletteHost } from "@/features/workspace/command-palette-host";
import { ConversationView } from "@/features/workspace/conversation-view";
import { GlobalDialogsHost } from "@/features/workspace/global-dialogs-host";
import { ObjectSidebar } from "@/features/workspace/sidebar";
import {
  modelProfileFromProviderModel,
  providerModelRecordFromNativeModel,
  providerFromNativeProfile,
} from "@/features/workspace/provider-catalog";
import { useNarrowPanelViewport } from "@/features/workspace/panel-layout";
import { useWorkspaceStore } from "@/features/workspace/store";
import { openWorkspaceOverlay } from "@/features/workspace/overlay-store";
import { TitleBar } from "@/features/workspace/title-bar";
import { useWorkspaceSurface } from "@/features/workspace/workspace-mode-switcher";
import { applyRunStreamEventToStore, subscribeRunEvents } from "@/features/workspace/run-event-broker";
import type { CoreRuntimeInfo } from "@/lib/core-protocol";
import { desktop, type AppRuntimeInfo } from "@/lib/desktop";

import { useWorkspaceRuntime } from "./workspace-runtime";

import "@/styles/index.css";
import "@/styles/review-chat-shell.css";

const SovereignIdeRemoteWorkbench = lazy(
  () => import("@/features/workspace/sovereign-ide-remote-workbench"),
);
const SovereignBrowserWorkbench = lazy(
  () => import("@/features/workspace/sovereign-browser-workbench"),
);

function FullBleedSurfaceLoading({ label }: { label: string }) {
  return (
    <div className="activity-load-state" role="status" aria-live="polite">
      <div>
        <span className="eyebrow">Opening workspace</span>
        <h1>{label}</h1>
        <p>Loading the embedded surface without opening another utility tab.</p>
      </div>
      <span className="activity-load-progress" aria-hidden="true" />
    </div>
  );
}

// Re-exported for the focused startup regression test; the implementation
// lives with the shared, once-per-process workspace runtime helper.
export { hydrateNativeWorkspace } from "./workspace-runtime";

export function Workspace({
  runtime,
  coreRuntime,
  activityLoadScreen,
}: {
  runtime: AppRuntimeInfo;
  coreRuntime?: CoreRuntimeInfo | null | undefined;
  activityLoadScreen?: ActivityModuleLoader;
}) {
  const activeActivity = useWorkspaceStore((state) => state.activeActivity);
  const theme = useWorkspaceStore((state) => state.theme);
  const density = useWorkspaceStore((state) => state.density);
  const motion = useWorkspaceStore((state) => state.motion);
  const sidebarOpen = useWorkspaceStore((state) => state.sidebarOpen);
  const closeNarrowPanels = useWorkspaceStore((state) => state.closeNarrowPanels);
  const setCommandPaletteOpen = useWorkspaceStore((state) => state.setCommandPaletteOpen);
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);
  const narrowPanels = useNarrowPanelViewport();
  const workspaceSurface = useWorkspaceSurface();
  const workspaceSurfaceOverride = workspaceSurface === "code" || workspaceSurface === "browser";
  // Context-only activities own their navigation; do not reserve an empty
  // object-list column (or drawer) outside the Chat and Project surfaces.
  const objectSidebarAvailable =
    !workspaceSurfaceOverride && (activeActivity === "chats" || activeActivity === "projects");
  const objectSidebarOpen = objectSidebarAvailable && sidebarOpen;
  const sidebarDrawerOpen = narrowPanels && objectSidebarOpen;

  // Native turns must keep projecting while the Chat composer and either AI
  // panel are unmounted. The broker reference-counts this shared callback so
  // opening/closing a surface never duplicates deltas or loses terminal state.
  useEffect(() => {
    if (!runtime.tauri) return;
    return subscribeRunEvents(applyRunStreamEventToStore);
  }, [runtime.tauri]);

  useEffect(() => {
    if (!runtime.tauri) return;
    let disposed = false;
    void (async () => {
      const profiles = await desktop.listProviderProfiles();
      const providers = await Promise.all(
        profiles.map(async (profile) => {
          const provider = providerFromNativeProfile(profile);
          try {
            const [health, catalog] = await Promise.all([
              desktop.testProviderConnection(profile.id),
              desktop.listProviderModels(profile.id),
            ]);
            const models = catalog.models.map((model) =>
              modelProfileFromProviderModel(
                provider,
                providerModelRecordFromNativeModel(model),
              ),
            );
            return {
              ...provider,
              state: "connected" as const,
              modelCount: models.length,
              lastCheckedAt: health.checkedAt,
              latencyMs: health.latencyMs,
              models,
            };
          } catch (cause) {
            return {
              ...provider,
              state: "error" as const,
              lastCheckedAt: new Date().toISOString(),
              errorMessage:
                cause instanceof Error ? cause.message : "Provider validation failed.",
            };
          }
        }),
      );
      if (!disposed) useWorkspaceStore.getState().replaceProviders(providers);
    })().catch(() => {
      if (!disposed) useWorkspaceStore.getState().replaceProviders([]);
    });
    return () => {
      disposed = true;
    };
  }, [runtime.tauri]);

  useEffect(() => {
    const root = document.documentElement;
    const media =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: light)")
        : null;
    const apply = () => applyAppearance(root, { theme, density, motion }, media?.matches ?? false);
    apply();
    const update = () => {
      if (theme === "system") apply();
    };
    media?.addEventListener?.("change", update);
    return () => media?.removeEventListener?.("change", update);
  }, [density, motion, theme]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // Let the command palette/modal own its keyboard loop. Preserve native
      // text-editing chords when focus is already inside an editable control;
      // Ctrl+K remains the intentional global escape hatch to search/commands.
      if (useWorkspaceStore.getState().commandPaletteOpen) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('[role="dialog"]')) return;
      const editableTarget = Boolean(
        target?.closest("input, textarea, select, [contenteditable='true']"),
      );
      const action = resolveSessionShortcut(event);
      if (!action) return;
      // Chat no longer has an inspector. Do not reserve a shortcut that can
      // open hidden state or interfere with browser/native developer tools.
      if (editableTarget && !(action.kind === "command" && action.id === "open-commands")) return;
      event.preventDefault();
      if (action.kind === "activity") {
        useWorkspaceStore.getState().setActivity(action.id);
      } else if (action.id === "open-commands") {
        setCommandPaletteOpen(true);
      } else if (action.id === "new-chat") {
        openWorkspaceOverlay({ kind: "start-conversation" });
      } else if (action.id === "new-project") {
        openWorkspaceOverlay({ kind: "create-project" });
      } else if (action.id === "focus-search") {
        const state = useWorkspaceStore.getState();
        if (state.activeActivity !== "chats") state.setActivity("chats");
        const nextState = useWorkspaceStore.getState();
        if (!nextState.sidebarOpen) nextState.toggleSidebar();
        window.requestAnimationFrame(() => document.getElementById("conversation-search")?.focus());
      } else if (action.id === "focus-composer") {
        const state = useWorkspaceStore.getState();
        if (state.activeActivity !== "chats") state.setActivity("chats");
        window.requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="Message Omnia"]')?.focus());
      } else if (action.id === "toggle-sidebar") {
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [setCommandPaletteOpen, toggleSidebar]);

  const classes = [
    "app-shell",
    ...(workspaceSurfaceOverride ? ["app-shell--full-window-surface"] : []),
    objectSidebarOpen ? "app-shell--sidebar" : "app-shell--no-sidebar",
    "app-shell--no-inspector",
  ].join(" ");

  return (
    <div
      className={classes}
      data-workspace-surface={workspaceSurface}
      data-panel-layout={narrowPanels ? "drawer" : "docked"}
      data-drawer-open={sidebarDrawerOpen ? "sidebar" : undefined}
    >
      {!workspaceSurfaceOverride ? (
        <>
          <TitleBar />
          <ActivityRail />
          <PanelScrim open={sidebarDrawerOpen} onClose={closeNarrowPanels} />
        </>
      ) : null}
      {objectSidebarAvailable ? <ObjectSidebar /> : null}
      <main
        className={`primary-workspace${workspaceSurfaceOverride ? " primary-workspace--full-bleed" : ""}`}
        aria-label={
          workspaceSurface === "code"
            ? "Embedded VS Code workspace"
            : workspaceSurface === "browser"
              ? "Sovereign Browser workspace"
              : activeActivity === "chats"
                ? "Conversation"
                : "Omnia workspace"
        }
      >
        {workspaceSurface === "code" ? (
          <Suspense fallback={<FullBleedSurfaceLoading label="Embedded VS Code" />}>
            <SovereignIdeRemoteWorkbench />
          </Suspense>
        ) : workspaceSurface === "browser" ? (
          <Suspense fallback={<FullBleedSurfaceLoading label="Sovereign Browser" />}>
            <SovereignBrowserWorkbench />
          </Suspense>
        ) : activeActivity === "chats" ? (
          <ConversationView />
        ) : (
          <ActivityScreenHost
            activity={activeActivity}
            runtime={runtime}
            coreRuntime={coreRuntime}
            {...(activityLoadScreen ? { loadScreen: activityLoadScreen } : {})}
          />
        )}
      </main>
      <CommandPaletteHost />
      <GlobalDialogsHost />
    </div>
  );
}

export default function LabsApp() {
  const { runtime, coreRuntime, error } = useWorkspaceRuntime();

  // Keep hover guidance available even for renderer-local preview controls
  // authored by a workbench that has not yet supplied an explicit `title`.
  // The observer is intentionally scoped to buttons only and never changes
  // labels, disabled state, or event handlers; it simply mirrors the
  // accessible name (or visible text) into the browser's native tooltip.
  useEffect(() => {
    if (typeof document === "undefined") return;

    const describeButtons = (root: ParentNode) => {
      const buttons: HTMLButtonElement[] = [];
      if (root instanceof HTMLButtonElement) buttons.push(root);
      buttons.push(...root.querySelectorAll<HTMLButtonElement>("button"));
      buttons.forEach((button) => {
        // Preserve authored titles. Titles marked as auto-generated are
        // refreshed when a toggle changes its visible action label.
        if (button.title.trim() && button.dataset.autoTitle !== "true") return;
        const accessibleName = button.getAttribute("aria-label")?.trim();
        const visibleText = button.textContent?.replace(/\s+/g, " ").trim();
        const description = accessibleName || visibleText;
        if (!description) return;
        button.title = description.length > 140 ? `${description.slice(0, 137)}…` : description;
        button.dataset.autoTitle = "true";
      });
    };

    describeButtons(document);
    const observer = new MutationObserver((records) => {
      let hasChildChanges = false;
      records.forEach((record) => {
        if (record.type === "childList") {
          hasChildChanges = true;
          return;
        }
        if (record.type === "attributes" && record.target instanceof HTMLElement) {
          describeButtons(record.target);
        }
      });
      // React often updates button text in-place (for example, Pause →
      // Resume). Re-scan once after child changes so the tooltip follows the
      // current action instead of the initial label.
      if (hasChildChanges) describeButtons(document);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label"],
    });
    return () => observer.disconnect();
  }, []);

  if (error) return <BootScreen runtime={runtime} error={error} />;
  if (!runtime) return <BootScreen runtime={runtime} error={null} />;
  return <Workspace runtime={runtime} coreRuntime={coreRuntime} />;
}
