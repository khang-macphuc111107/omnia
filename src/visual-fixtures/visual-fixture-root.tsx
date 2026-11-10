import { lazy, Suspense, useEffect } from "react";

import { BootScreen } from "@/components/boot-screen";
import { applyAppearance } from "@/design-system/appearance";
import { useCitationSelectionStore } from "@/features/workspace/citation-selection-store";
import { useWorkspaceOverlayStore } from "@/features/workspace/overlay-store";
import { useWorkspaceStore } from "@/features/workspace/store";
import type { AppRuntimeInfo } from "@/lib/desktop";
import { Workspace } from "@/labs/labs-app";
import {
  loadActivityScreen,
  type ActivityScreenModule,
  type NonChatActivityId,
} from "@/features/workspace/activity-registry";
import type { ActivityModuleLoader } from "@/features/workspace/activity-screen-host";

import { createVisualFixtureState } from "./visual-fixture-data";
import {
  activityForVisualScreen,
  parseShellHostView,
  parseVisualScenario,
  visualOverlayToWorkspaceOverlay,
  type VisualScenario,
} from "./visual-scenario";

import "./visual-fixture.css";

const VISUAL_RUNTIME: AppRuntimeInfo = Object.freeze({
  appName: "Omnia",
  appVersion: "visual-fixture",
  platform: "web",
  tauri: false,
  debug: true,
});

const BOOT_ERRORS: Partial<Record<VisualScenario["state"], string>> = {
  denied: "Startup was blocked by the deterministic capability-policy fixture.",
  error: "Storage initialization failed in the deterministic visual fixture.",
  offline: "The local workspace is unavailable in the deterministic offline fixture.",
};

function applyVisualDocumentState(scenario: VisualScenario): void {
  const root = document.documentElement;
  applyAppearance(root, {
    theme: scenario.theme,
    density: scenario.density,
    motion: scenario.motion,
  });
  root.dataset.visualFixture = "true";
  root.dataset.visualScenario = `${scenario.screen}:${scenario.state}`;
  root.dataset.visualScale = String(scenario.scale);
  root.dataset.visualLocale = scenario.locale;
  root.lang = scenario.locale === "vi" ? "vi" : scenario.locale === "rtl-test" ? "ar" : "en";
  root.dir = scenario.locale === "rtl-test" ? "rtl" : "ltr";
}

const NEVER_RESOLVING_ACTIVITY_LOADER: ActivityModuleLoader = () =>
  new Promise<ActivityScreenModule>(() => undefined);

const visualActivityLoader: ActivityModuleLoader = async (
  activity: NonChatActivityId,
): Promise<ActivityScreenModule> => loadActivityScreen(activity);

export function resetVisualFixtureState(scenario: VisualScenario): void {
  const baseline = useWorkspaceStore.getInitialState();
  const fixture = createVisualFixtureState(scenario.state, scenario.locale);
  const activity = activityForVisualScreen(scenario.screen);
  const overlay = visualOverlayToWorkspaceOverlay(scenario.overlay);
  const sidebarDrawer = scenario.overlay === "sidebar-drawer";
  const inspectorDrawer = scenario.overlay === "inspector-drawer";

  useWorkspaceStore.setState({
    ...baseline,
    ...fixture,
    activeActivity: activity ?? "chats",
    theme: scenario.theme,
    density: scenario.density,
    motion: scenario.motion,
    sidebarOpen: sidebarDrawer ? true : !inspectorDrawer,
    inspectorOpen: inspectorDrawer ? true : !sidebarDrawer,
    inspectorTab: fixture.activeRun ? "run" : "context",
    commandPaletteOpen: scenario.overlay === "command-palette",
  }, true);
  useWorkspaceOverlayStore.setState({
    ...useWorkspaceOverlayStore.getInitialState(),
    activeOverlay: overlay,
  }, true);
  useCitationSelectionStore.setState({
    ...useCitationSelectionStore.getInitialState(),
    selectedCitationId: null,
    returnTargetId: null,
    returnTab: "context",
  }, true);
}

export function VisualFixtureRoot({ scenario }: { scenario: VisualScenario }) {
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document.body.dataset.visualFixtureReady = "true";
    });
    return () => {
      window.cancelAnimationFrame(frame);
      delete document.body.dataset.visualFixtureReady;
    };
  }, []);

  if (scenario.screen === "boot") {
    return (
      <BootScreen
        runtime={scenario.state === "loading" ? null : VISUAL_RUNTIME}
        error={BOOT_ERRORS[scenario.state] ?? null}
      />
    );
  }

  return (
    <Workspace
      runtime={VISUAL_RUNTIME}
      activityLoadScreen={
        scenario.state === "loading"
          ? NEVER_RESOLVING_ACTIVITY_LOADER
          : visualActivityLoader
      }
    />
  );
}

const parsed = parseVisualScenario(window.location.search);
applyVisualDocumentState(parsed.scenario);
resetVisualFixtureState(parsed.scenario);

document.documentElement.dataset.visualWarnings = String(parsed.warnings.length);
document.documentElement.dataset.visualCanonicalSearch = parsed.canonicalSearch;

// `?host=shell&view=<id>` hosts one workspace screen inside an agent-shell-like
// frame (44px rail + 36px bar + `.ws-surface`) for overflow/layout audits.
const shellHostView = parseShellHostView(window.location.search);
const ShellHostFixture = lazy(async () => ({
  default: (await import("./shell-host-fixture")).ShellHostFixture,
}));

export default function VisualFixtureEntry() {
  if (shellHostView) {
    return (
      <Suspense fallback={null}>
        <ShellHostFixture view={shellHostView} runtime={VISUAL_RUNTIME} loadScreen={visualActivityLoader} />
        <VisualFixtureReady />
      </Suspense>
    );
  }
  return <VisualFixtureRoot scenario={parsed.scenario} />;
}

function VisualFixtureReady() {
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document.body.dataset.visualFixtureReady = "true";
    });
    return () => {
      window.cancelAnimationFrame(frame);
      delete document.body.dataset.visualFixtureReady;
    };
  }, []);
  return null;
}
