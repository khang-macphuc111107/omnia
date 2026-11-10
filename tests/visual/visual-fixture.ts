import type { Page } from "@playwright/test";

export const VISUAL_SCREENS = [
  "boot",
  "chat",
  "home",
  "projects",
  "library",
  "memory",
  "skills",
  "settings",
] as const;

export type VisualScreen = (typeof VISUAL_SCREENS)[number];

export const VISUAL_STATES = [
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

export type VisualState = (typeof VISUAL_STATES)[number];

export const VISUAL_OVERLAYS = [
  "none",
  "command-palette",
  "create-project",
  "connect-provider",
  "folder-grant",
  "sidebar-drawer",
  "inspector-drawer",
] as const;

export type VisualOverlay = (typeof VISUAL_OVERLAYS)[number];
export type VisualTheme = "light" | "dark";
export type VisualDensity = "compact" | "comfortable" | "touch";
export type VisualMotion = "system" | "reduced";
export type VisualScale = 100 | 200;
export type VisualLocale = "en" | "vi" | "rtl-test";

export interface VisualScenario {
  screen: VisualScreen;
  state: VisualState;
  theme: VisualTheme;
  density: VisualDensity;
  motion: VisualMotion;
  scale: VisualScale;
  locale: VisualLocale;
  overlay: VisualOverlay;
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

export function visualScenario(overrides: Partial<VisualScenario> = {}): VisualScenario {
  return { ...DEFAULT_VISUAL_SCENARIO, ...overrides };
}

export function visualScenarioSearch(scenario: VisualScenario): string {
  const search = new URLSearchParams();
  search.set("screen", scenario.screen);
  search.set("state", scenario.state);
  search.set("theme", scenario.theme);
  search.set("density", scenario.density);
  search.set("motion", scenario.motion);
  search.set("scale", String(scenario.scale));
  search.set("locale", scenario.locale);
  search.set("overlay", scenario.overlay);
  return search.toString();
}

export function visualScenarioUrl(scenario: VisualScenario): string {
  return `/__visual?${visualScenarioSearch(scenario)}`;
}

export async function openVisualScenario(
  page: Page,
  overrides: Partial<VisualScenario> = {},
): Promise<VisualScenario> {
  const scenario = visualScenario(overrides);
  await page.goto(visualScenarioUrl(scenario), { waitUntil: "domcontentloaded" });
  await page.locator('body[data-visual-fixture-ready="true"]').waitFor();
  await page.locator("html").waitFor();
  await page.waitForFunction(() => document.fonts.status === "loaded");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  return scenario;
}

export function visualScreenshotName(
  scenario: VisualScenario,
  viewport: { width: number; height: number },
  suffix?: string,
): string {
  const parts = [
    scenario.screen,
    scenario.state,
    scenario.theme,
    scenario.density,
    `${scenario.scale}pct`,
    scenario.locale,
    scenario.overlay,
    `${viewport.width}x${viewport.height}`,
  ];
  if (suffix) parts.push(suffix);
  return `${parts.join("-")}.png`;
}
