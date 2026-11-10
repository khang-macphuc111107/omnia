import { expect, test } from "@playwright/test";

import {
  openVisualScenario,
  visualScreenshotName,
  type VisualScenario,
} from "./visual-fixture";

const CORE_SCREEN_MATRIX: readonly {
  viewport: { width: number; height: number };
  scenario: Partial<VisualScenario>;
}[] = [
  {
    viewport: { width: 800, height: 600 },
    scenario: { screen: "chat", state: "populated", theme: "dark", density: "compact" },
  },
  {
    viewport: { width: 1024, height: 720 },
    scenario: { screen: "projects", state: "populated", theme: "light", density: "comfortable" },
  },
  {
    viewport: { width: 1440, height: 900 },
    scenario: { screen: "library", state: "long-content", theme: "dark", density: "comfortable", locale: "vi" },
  },
  {
    viewport: { width: 1920, height: 1080 },
    scenario: { screen: "settings", state: "offline", theme: "light", density: "touch" },
  },
];

for (const entry of CORE_SCREEN_MATRIX) {
  test(`core matrix ${entry.viewport.width}x${entry.viewport.height} ${entry.scenario.screen}`, async ({ page }) => {
    await page.setViewportSize(entry.viewport);
    const scenario = await openVisualScenario(page, entry.scenario);
    await expect(page).toHaveScreenshot(visualScreenshotName(scenario, entry.viewport), {
      fullPage: true,
    });
  });
}

const STATE_MATRIX: readonly Partial<VisualScenario>[] = [
  { screen: "boot", state: "loading" },
  { screen: "boot", state: "error" },
  { screen: "chat", state: "empty" },
  { screen: "chat", state: "streaming" },
  { screen: "chat", state: "partial" },
  { screen: "chat", state: "denied" },
  { screen: "chat", state: "error" },
  { screen: "chat", state: "long-content", locale: "vi" },
  { screen: "chat", state: "long-content", locale: "rtl-test" },
  { screen: "home", state: "populated" },
  { screen: "memory", state: "empty" },
  { screen: "skills", state: "empty" },
];

for (const entry of STATE_MATRIX) {
  test(`state matrix ${entry.screen}-${entry.state}-${entry.locale ?? "en"}`, async ({ page }) => {
    const viewport = { width: 1440, height: 900 };
    await page.setViewportSize(viewport);
    const scenario = await openVisualScenario(page, entry);
    await expect(page).toHaveScreenshot(visualScreenshotName(scenario, viewport), {
      fullPage: true,
    });
  });
}

const OVERLAY_MATRIX: readonly Partial<VisualScenario>[] = [
  { overlay: "command-palette" },
  { overlay: "create-project" },
  { overlay: "connect-provider" },
  { overlay: "folder-grant" },
];

for (const entry of OVERLAY_MATRIX) {
  test(`overlay matrix ${entry.overlay}`, async ({ page }) => {
    const viewport = { width: 800, height: 600 };
    await page.setViewportSize(viewport);
    const scenario = await openVisualScenario(page, entry);
    await expect(page).toHaveScreenshot(visualScreenshotName(scenario, viewport), {
      fullPage: true,
    });
  });
}

for (const overlay of ["sidebar-drawer", "inspector-drawer"] as const) {
  test(`overlay matrix ${overlay}`, async ({ page }) => {
    const viewport = { width: 898, height: 700 };
    await page.setViewportSize(viewport);
    const scenario = await openVisualScenario(page, { overlay });
    await expect(page).toHaveScreenshot(visualScreenshotName(scenario, viewport), {
      fullPage: true,
    });
  });
}

test("200 percent text-scale fixture", async ({ page }) => {
  const viewport = { width: 1440, height: 900 };
  await page.setViewportSize(viewport);
  const scenario = await openVisualScenario(page, {
    screen: "chat",
    state: "long-content",
    scale: 200,
    locale: "vi",
    density: "touch",
  });
  await expect(page).toHaveScreenshot(visualScreenshotName(scenario, viewport), {
    fullPage: true,
  });
});

test("forced-colors representative surface", async ({ page }) => {
  const viewport = { width: 1024, height: 720 };
  await page.setViewportSize(viewport);
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  const scenario = await openVisualScenario(page, {
    screen: "chat",
    state: "partial",
    density: "comfortable",
  });
  await expect(page).toHaveScreenshot(visualScreenshotName(scenario, viewport, "forced-colors"), {
    fullPage: true,
  });
});
