import { readPrefs, writePrefs } from "./prefs";

/** Agent-shell appearance: theme, density and font scale, applied as attributes/variables on <html>. */

export type AgentTheme = "system" | "light" | "dark" | "high-contrast";
export type AgentDensity = "comfortable" | "compact";

export const THEMES: ReadonlyArray<{ value: AgentTheme; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "high-contrast", label: "High contrast" },
];
export const DENSITIES: ReadonlyArray<{ value: AgentDensity; label: string }> = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];
export const FONT_SCALE_MIN = 90;
export const FONT_SCALE_MAX = 125;
export const FONT_SCALE_STEP = 5;

export interface AgentAppearance {
  theme: AgentTheme;
  density: AgentDensity;
  fontScale: number;
}

export const DEFAULT_AGENT_APPEARANCE: AgentAppearance = { theme: "system", density: "comfortable", fontScale: 100 };

export function normalizeAgentAppearance(value: { theme?: unknown; density?: unknown; fontScale?: unknown }): AgentAppearance {
  const theme = THEMES.some((entry) => entry.value === value.theme) ? (value.theme as AgentTheme) : "system";
  const density = value.density === "compact" ? "compact" : "comfortable";
  const raw = typeof value.fontScale === "number" && Number.isFinite(value.fontScale) ? value.fontScale : 100;
  const fontScale = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(raw)));
  return { theme, density, fontScale };
}

export function readAgentAppearance(): AgentAppearance {
  return normalizeAgentAppearance(readPrefs());
}

export function writeAgentAppearance(patch: Partial<AgentAppearance>): AgentAppearance {
  const next = normalizeAgentAppearance({ ...readAgentAppearance(), ...patch });
  writePrefs({ theme: next.theme, density: next.density, fontScale: next.fontScale });
  return next;
}

export interface MediaState {
  prefersLight: boolean;
  prefersMoreContrast: boolean;
}

function queryMedia(): MediaState {
  const match = (query: string) => {
    try {
      return globalThis.matchMedia?.(query).matches ?? false;
    } catch {
      return false;
    }
  };
  return { prefersLight: match("(prefers-color-scheme: light)"), prefersMoreContrast: match("(prefers-contrast: more)") };
}

/**
 * data-theme is always "light" or "dark" (the token sets). data-contrast="more" layers the
 * high-contrast overrides on top: for High contrast, and whenever the OS asks for more contrast (any theme).
 */
export function applyAgentAppearance(root: HTMLElement, appearance: AgentAppearance, media: MediaState = queryMedia()): void {
  const { theme, density, fontScale } = normalizeAgentAppearance(appearance);
  const scheme = theme === "high-contrast" ? "dark" : theme === "system" ? (media.prefersLight ? "light" : "dark") : theme;
  const more = theme === "high-contrast" || media.prefersMoreContrast;
  root.dataset.theme = scheme;
  root.dataset.agentTheme = theme;
  if (more) root.dataset.contrast = "more";
  else delete root.dataset.contrast;
  root.dataset.agentDensity = density;
  root.style.colorScheme = scheme;
  root.style.setProperty("--ag-font-scale", String(fontScale / 100));
}

/** Apply the stored appearance and follow OS changes while in System mode. Returns a cleanup. */
export function startAgentAppearance(root: HTMLElement = document.documentElement): () => void {
  const reapply = () => applyAgentAppearance(root, readAgentAppearance());
  reapply();
  const lists: MediaQueryList[] = [];
  try {
    for (const query of ["(prefers-color-scheme: light)", "(prefers-contrast: more)"]) {
      const list = globalThis.matchMedia?.(query);
      if (list) {
        list.addEventListener?.("change", reapply);
        lists.push(list);
      }
    }
  } catch {
    /* media queries unavailable */
  }
  return () => lists.forEach((list) => list.removeEventListener?.("change", reapply));
}
