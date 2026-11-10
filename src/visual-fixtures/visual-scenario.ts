import type { WorkspaceOverlay } from "@/features/workspace/overlay-store";
import type {
  ActivityId,
  DensityPreference,
  MotionPreference,
  ThemePreference,
} from "@/features/workspace/types";

export const VISUAL_FIXTURE_PATH = "/__visual";

export const VISUAL_SCREEN_IDS = [
  "boot",
  "chat",
  "home",
  "projects",
  "library",
  "memory",
  "skills",
  "settings",
] as const;

export type VisualScreenId = (typeof VISUAL_SCREEN_IDS)[number];

export const VISUAL_STATE_IDS = [
  "empty",
  "loading",
  "populated",
  "streaming",
  "partial",
  "offline",
  "denied",
  "error",
  "long-content",
] as const;

export type VisualStateId = (typeof VISUAL_STATE_IDS)[number];

export const VISUAL_OVERLAY_IDS = [
  "none",
  "command-palette",
  "create-project",
  "connect-provider",
  "folder-grant",
  "sidebar-drawer",
  "inspector-drawer",
] as const;

export type VisualOverlayId = (typeof VISUAL_OVERLAY_IDS)[number];

export const VISUAL_LOCALE_IDS = ["en", "vi", "rtl-test"] as const;

export type VisualLocaleId = (typeof VISUAL_LOCALE_IDS)[number];
export type VisualScale = 100 | 200;

export interface VisualScenario {
  screen: VisualScreenId;
  state: VisualStateId;
  theme: Exclude<ThemePreference, "system">;
  density: DensityPreference;
  motion: MotionPreference;
  scale: VisualScale;
  locale: VisualLocaleId;
  overlay: VisualOverlayId;
}

export interface VisualScenarioParseResult {
  scenario: VisualScenario;
  canonicalSearch: string;
  warnings: readonly string[];
}

export const DEFAULT_VISUAL_SCENARIO: Readonly<VisualScenario> = Object.freeze({
  screen: "chat",
  state: "populated",
  theme: "dark",
  density: "comfortable",
  motion: "reduced",
  scale: 100,
  locale: "en",
  overlay: "none",
});

const SCREEN_ACTIVITY: Record<Exclude<VisualScreenId, "boot">, ActivityId> = {
  chat: "chats",
  home: "home",
  projects: "projects",
  library: "library",
  memory: "memory",
  skills: "skills",
  settings: "settings",
};

const SCENARIO_KEYS = [
  "screen",
  "state",
  "theme",
  "density",
  "motion",
  "scale",
  "locale",
  "overlay",
] as const satisfies readonly (keyof VisualScenario)[];

function parseEnum<T extends string>(
  search: URLSearchParams,
  key: string,
  allowed: readonly T[],
  fallback: T,
  warnings: string[],
): T {
  const value = search.get(key);
  if (value === null || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  warnings.push(`${key}=${value} is unsupported; using ${fallback}.`);
  return fallback;
}

function canonicalSearchFor(scenario: VisualScenario): string {
  const search = new URLSearchParams();
  for (const key of SCENARIO_KEYS) search.set(key, String(scenario[key]));
  return search.toString();
}

export function parseVisualScenario(
  searchInput: string | URLSearchParams,
): VisualScenarioParseResult {
  const search =
    searchInput instanceof URLSearchParams
      ? new URLSearchParams(searchInput)
      : new URLSearchParams(searchInput.startsWith("?") ? searchInput.slice(1) : searchInput);
  const warnings: string[] = [];
  const screen = parseEnum(
    search,
    "screen",
    VISUAL_SCREEN_IDS,
    DEFAULT_VISUAL_SCENARIO.screen,
    warnings,
  );
  const state = parseEnum(
    search,
    "state",
    VISUAL_STATE_IDS,
    DEFAULT_VISUAL_SCENARIO.state,
    warnings,
  );
  const theme = parseEnum(
    search,
    "theme",
    ["light", "dark"] as const,
    DEFAULT_VISUAL_SCENARIO.theme,
    warnings,
  );
  const density = parseEnum(
    search,
    "density",
    ["compact", "comfortable", "touch"] as const,
    DEFAULT_VISUAL_SCENARIO.density,
    warnings,
  );
  const motion = parseEnum(
    search,
    "motion",
    ["system", "reduced"] as const,
    DEFAULT_VISUAL_SCENARIO.motion,
    warnings,
  );
  const locale = parseEnum(
    search,
    "locale",
    VISUAL_LOCALE_IDS,
    DEFAULT_VISUAL_SCENARIO.locale,
    warnings,
  );
  const overlay = parseEnum(
    search,
    "overlay",
    VISUAL_OVERLAY_IDS,
    DEFAULT_VISUAL_SCENARIO.overlay,
    warnings,
  );
  const rawScale = search.get("scale");
  const scale: VisualScale = rawScale === "200" ? 200 : 100;
  if (rawScale !== null && rawScale !== "" && rawScale !== "100" && rawScale !== "200") {
    warnings.push(`scale=${rawScale} is unsupported; using 100.`);
  }

  const scenario: VisualScenario = {
    screen,
    state,
    theme,
    density,
    motion,
    scale,
    locale,
    overlay,
  };
  return {
    scenario,
    canonicalSearch: canonicalSearchFor(scenario),
    warnings: Object.freeze(warnings),
  };
}

export function activityForVisualScreen(screen: VisualScreenId): ActivityId | null {
  return screen === "boot" ? null : SCREEN_ACTIVITY[screen];
}

export function visualOverlayToWorkspaceOverlay(
  overlay: VisualOverlayId,
): WorkspaceOverlay | null {
  if (overlay === "create-project") return { kind: "create-project" };
  if (overlay === "connect-provider") return { kind: "connect-provider" };
  if (overlay === "folder-grant") return { kind: "grant-folder", projectId: "project-omnia" };
  return null;
}

export function isVisualFixtureLocation(
  location: Pick<Location, "pathname"> = window.location,
): boolean {
  // The fixture is deterministic and contains no provider/native side effects,
  // so it is safe to run from both Vite dev and the production preview. The
  // production path is the default for Playwright visual QA because it avoids
  // repeatedly compiling the entire workspace graph in every worker.
  return (import.meta.env.DEV || import.meta.env.PROD) && location.pathname === VISUAL_FIXTURE_PATH;
}

/** Views hostable by the shell-host fixture (`?host=shell&view=<id>`). */
export const SHELL_HOST_VIEWS = [
  "home",
  "projects",
  "work",
  "library",
  "memory",
  "skills",
  "code",
  "browser",
] as const;

export type ShellHostView = (typeof SHELL_HOST_VIEWS)[number];

export function parseShellHostView(search: string): ShellHostView | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (params.get("host") !== "shell") return null;
  const view = params.get("view") ?? "";
  return (SHELL_HOST_VIEWS as readonly string[]).includes(view) ? (view as ShellHostView) : "home";
}
