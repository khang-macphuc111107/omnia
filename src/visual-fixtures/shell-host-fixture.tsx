import { lazy, Suspense, type JSX } from "react";

import { ActivityScreenHost, type ActivityModuleLoader } from "@/features/workspace/activity-screen-host";
import type { NonChatActivityId } from "@/features/workspace/activity-registry";
import { CommandPaletteHost } from "@/features/workspace/command-palette-host";
import { GlobalDialogsHost } from "@/features/workspace/global-dialogs-host";
import type { AppRuntimeInfo } from "@/lib/desktop";

import type { ShellHostView } from "./visual-scenario";

import "@/styles/index.css";
import "@/styles/review-chat-shell.css";
import "@/labs/workspace-surface.css";
import "./shell-host-fixture.css";

/**
 * Dev-only fixture that hosts a workspace screen the way the agent shell does:
 * a 44px activity rail, a thin 36px title bar, and `.ws-surface` filling the
 * remaining area. Screens must never assume full-window width/height, so
 * layout audits run against this frame rather than the legacy Labs shell.
 *
 * URL: /__visual?host=shell&view=<home|projects|work|library|memory|skills|code|browser>
 */

const SovereignIdeRemoteWorkbench = lazy(
  () => import("@/features/workspace/sovereign-ide-remote-workbench"),
);
const SovereignBrowserWorkbench = lazy(
  () => import("@/features/workspace/sovereign-browser-workbench"),
);

const VIEW_LABELS: Record<ShellHostView, string> = {
  home: "Home",
  projects: "Projects",
  work: "Background work",
  library: "Library",
  memory: "Memory",
  skills: "Skills",
  code: "Code",
  browser: "Browser",
};

export function ShellHostFixture({
  view,
  runtime,
  loadScreen,
}: {
  view: ShellHostView;
  runtime: AppRuntimeInfo;
  loadScreen?: ActivityModuleLoader;
}): JSX.Element {
  const fullBleed = view === "code" || view === "browser";
  let body: JSX.Element;
  if (view === "code") {
    body = (
      <Suspense fallback={<p role="status">Loading code…</p>}>
        <SovereignIdeRemoteWorkbench />
      </Suspense>
    );
  } else if (view === "browser") {
    body = (
      <Suspense fallback={<p role="status">Loading browser…</p>}>
        <SovereignBrowserWorkbench />
      </Suspense>
    );
  } else {
    body = (
      <ActivityScreenHost
        activity={view as NonChatActivityId}
        runtime={runtime}
        {...(loadScreen ? { loadScreen } : {})}
      />
    );
  }
  return (
    <div className="vf-shell" data-shell-host-view={view}>
      <nav className="vf-shell__rail" aria-label="Activities (fixture)" />
      <section className="vf-shell__workspace" aria-label={VIEW_LABELS[view]}>
        <header className="vf-shell__bar">
          <h1 className="vf-shell__title">{VIEW_LABELS[view]}</h1>
        </header>
        <div className="vf-shell__body">
          <div className={`ws-surface${fullBleed ? " ws-surface--full-bleed" : ""}`} data-view={view}>
            {body}
            {/* Same dialog hosts WorkspaceSurface mounts; `&overlay=<id>` opens one. */}
            <CommandPaletteHost />
            <GlobalDialogsHost />
          </div>
        </div>
      </section>
    </div>
  );
}
