export type ThemePreference = "system" | "light" | "dark";
export type DensityPreference = "compact" | "comfortable" | "touch";
export type MotionPreference = "system" | "reduced";

export interface AppearancePreferences {
  theme: ThemePreference;
  density: DensityPreference;
  motion: MotionPreference;
}

interface PreferenceStorage {
  getItem(key: string): string | null;
}

interface StoredWorkspacePreferences {
  state?: Partial<AppearancePreferences>;
}

export const WORKSPACE_PREFERENCE_STORAGE_KEY = "omnia-workspace-preview-v1";

export const DEFAULT_APPEARANCE: AppearancePreferences = Object.freeze({
  theme: "system",
  density: "comfortable",
  motion: "system",
});

const THEME_COLORS: Record<Exclude<ThemePreference, "system">, string> = {
  dark: "#0a111c",
  light: "#f4f7fc",
};

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function isDensityPreference(value: unknown): value is DensityPreference {
  return value === "compact" || value === "comfortable" || value === "touch";
}

function isMotionPreference(value: unknown): value is MotionPreference {
  return value === "system" || value === "reduced";
}

/**
 * Normalizes appearance data at every renderer boundary. The same narrow
 * allowlist is used for bootstrap, persisted Zustand state, and UI setters so
 * a manually edited browser-storage record cannot leave invalid data-* values
 * on the application root.
 */
export function normalizeAppearance(
  value: Partial<AppearancePreferences> | null | undefined,
): AppearancePreferences {
  return {
    theme: isThemePreference(value?.theme) ? value.theme : DEFAULT_APPEARANCE.theme,
    density: isDensityPreference(value?.density) ? value.density : DEFAULT_APPEARANCE.density,
    motion: isMotionPreference(value?.motion) ? value.motion : DEFAULT_APPEARANCE.motion,
  };
}

function browserPreferenceStorage(): PreferenceStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readStoredAppearance(
  storage: PreferenceStorage | null = browserPreferenceStorage(),
  key = WORKSPACE_PREFERENCE_STORAGE_KEY,
): AppearancePreferences {
  if (!storage) return DEFAULT_APPEARANCE;

  try {
    const raw = storage.getItem(key);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as StoredWorkspacePreferences;
    const state = parsed.state;
    if (!state || typeof state !== "object") return DEFAULT_APPEARANCE;

    return normalizeAppearance(state);
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function resolveEffectiveTheme(
  preference: ThemePreference,
  prefersLight = globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ?? false,
): Exclude<ThemePreference, "system"> {
  if (preference !== "system") return preference;
  return prefersLight ? "light" : "dark";
}

export function applyAppearance(
  root: HTMLElement,
  preferences: AppearancePreferences,
  prefersLight?: boolean,
): void {
  const normalized = normalizeAppearance(preferences);
  const effectiveTheme = resolveEffectiveTheme(normalized.theme, prefersLight);
  root.dataset.theme = effectiveTheme;
  root.dataset.density = normalized.density;
  root.dataset.motion = normalized.motion;
  root.style.colorScheme = effectiveTheme;
  const themeColor = root.ownerDocument?.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = THEME_COLORS[effectiveTheme];
}
