import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import {
  openVisualScenario,
  visualScenario,
  visualScenarioSearch,
  visualScenarioUrl,
  VISUAL_OVERLAYS,
  VISUAL_SCREENS,
  VISUAL_STATES,
  type VisualScenario,
} from "./visual-fixture";

const NETWORK_ALLOWLIST = new Set(["document", "script", "stylesheet", "image", "font"]);

function watchRuntimeFailures(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const disallowedRequests: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    const localOrigin = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (!localOrigin || !NETWORK_ALLOWLIST.has(request.resourceType())) {
      disallowedRequests.push(`${request.method()} ${request.resourceType()} ${url.origin}${url.pathname}`);
    }
  });

  return { consoleErrors, pageErrors, disallowedRequests };
}

async function expectHealthyFixture(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-visual-warnings", "0");
  await expect(page.locator("body")).toHaveAttribute("data-visual-fixture-ready", "true");
  await expect(page.locator("html")).toHaveAttribute("data-visual-fixture", "true");
}

test.describe("deterministic visual fixture contract", () => {
  test("loads every canonical screen without provider, native, or external requests", async ({ page }) => {
    const failures = watchRuntimeFailures(page);

    for (const screen of VISUAL_SCREENS) {
      await openVisualScenario(page, {
        screen,
        state: screen === "boot" ? "loading" : "populated",
      });
      await expectHealthyFixture(page);
      if (screen === "boot") {
        await expect(page.getByRole("status")).toContainText("Opening your workspace");
      } else if (screen === "chat") {
        await expect(page.getByRole("main", { name: "Conversation" })).toBeVisible();
      } else {
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      }
    }

    expect(failures.consoleErrors).toEqual([]);
    expect(failures.pageErrors).toEqual([]);
    expect(failures.disallowedRequests).toEqual([]);
  });

  test("exposes every state with an exact canonical query and zero parser warnings", async ({ page }) => {
    for (const state of VISUAL_STATES) {
      const scenario = await openVisualScenario(page, { screen: "chat", state });
      await expectHealthyFixture(page);
      await expect(page.locator("html")).toHaveAttribute(
        "data-visual-canonical-search",
        visualScenarioSearch(scenario),
      );
      await expect(page.locator("html")).toHaveAttribute(
        "data-visual-scenario",
        `${scenario.screen}:${scenario.state}`,
      );
    }
  });

  test("falls back deterministically and surfaces invalid-query warnings", async ({ page }) => {
    const expected = visualScenario();
    await page.goto(
      "/__visual?screen=unknown&state=unknown&theme=neon&density=tiny&motion=fast&scale=400&locale=xx&overlay=popup",
      { waitUntil: "domcontentloaded" },
    );
    await page.locator('body[data-visual-fixture-ready="true"]').waitFor();

    await expect(page.locator("html")).toHaveAttribute("data-visual-warnings", "8");
    await expect(page.locator("html")).toHaveAttribute(
      "data-visual-canonical-search",
      visualScenarioSearch(expected),
    );
    await expect(page.getByRole("main", { name: "Conversation" })).toBeVisible();
  });

  test("renders all overlay fixtures as visible, bounded surfaces", async ({ page }) => {
    await page.setViewportSize({ width: 899, height: 700 });

    for (const overlay of VISUAL_OVERLAYS.filter((value) => value !== "none")) {
      if (overlay === "sidebar-drawer" || overlay === "inspector-drawer") {
        await page.setViewportSize({ width: 898, height: 700 });
      }
      const scenario: VisualScenario = visualScenario({ overlay });
      await openVisualScenario(page, scenario);
      await expectHealthyFixture(page);

      if (overlay === "command-palette") {
        await expect(page.getByRole("dialog", { name: /command palette/i })).toBeVisible();
      } else if (overlay === "create-project") {
        await expect(page.getByRole("dialog", { name: /create a project/i })).toBeVisible();
      } else if (overlay === "connect-provider") {
        await expect(page.getByRole("dialog", { name: /connect your ai provider/i })).toBeVisible();
      } else if (overlay === "folder-grant") {
        await expect(page.getByRole("dialog", { name: /add workspace folder/i })).toBeVisible();
      } else if (overlay === "sidebar-drawer") {
        await expect(page.getByRole("dialog", { name: /chats sidebar/i })).toBeVisible();
      } else {
        await expect(page.getByRole("dialog", { name: /context and run inspector/i })).toBeVisible();
      }

      const surface = page.getByRole("dialog").first();
      const bounds = await surface.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(899);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700);
    }
  });

  test("keeps the document within every supported logical viewport", async ({ page }) => {
    for (const viewport of [
      { width: 800, height: 600 },
      { width: 1024, height: 720 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport);
      await openVisualScenario(page, {
        screen: "chat",
        state: "long-content",
        locale: "vi",
      });
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
      }));
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
      expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight);
    }
  });

  test("keeps duplicate IDs and serious axe violations out of representative surfaces", async ({ page }) => {
    for (const scenario of [
      visualScenario({ screen: "chat", state: "long-content", locale: "vi" }),
      visualScenario({ screen: "settings", state: "offline", theme: "light" }),
      visualScenario({ screen: "projects", state: "populated", density: "touch" }),
      visualScenario({ screen: "chat", overlay: "command-palette" }),
      visualScenario({ screen: "chat", overlay: "create-project" }),
    ]) {
      await page.goto(visualScenarioUrl(scenario), { waitUntil: "domcontentloaded" });
      await page.locator('body[data-visual-fixture-ready="true"]').waitFor();

      const duplicateIds = await page.evaluate(() => {
        const counts = new Map<string, number>();
        for (const element of document.querySelectorAll<HTMLElement>("[id]")) {
          counts.set(element.id, (counts.get(element.id) ?? 0) + 1);
        }
        return [...counts.entries()].filter(([, count]) => count > 1);
      });
      expect(duplicateIds).toEqual([]);

      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const serious = result.violations.filter(
        (violation) => violation.impact === "critical" || violation.impact === "serious",
      );
      expect(serious).toEqual([]);
    }
  });

  test("applies forced colors and reduced motion without active animation", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await openVisualScenario(page, {
      screen: "chat",
      state: "streaming",
      motion: "reduced",
    });

    expect(
      await page.evaluate(() => ({
        forcedColors: matchMedia("(forced-colors: active)").matches,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      })),
    ).toEqual({ forcedColors: true, reducedMotion: true });

    const animated = await page.locator("*:visible").evaluateAll((elements) =>
      elements
        .map((element) => {
          const style = getComputedStyle(element);
          return {
            className: element.getAttribute("class") ?? element.tagName,
            animationName: style.animationName,
            animationDuration: style.animationDuration,
          };
        })
        .filter(
          (entry) =>
            entry.animationName !== "none" &&
            entry.animationDuration.split(",").some((duration) => Number.parseFloat(duration) > 0.001),
        ),
    );
    expect(animated).toEqual([]);
  });

  test("keeps the active overlay keyboard-bounded and dismissible", async ({ page }) => {
    await openVisualScenario(page, { overlay: "command-palette" });
    const dialog = page.getByRole("dialog", { name: /command palette/i });
    // The shell intentionally exposes native selects as comboboxes as well;
    // scope the assertion to the active command-palette dialog so the test
    // checks the overlay's focus trap rather than unrelated page controls.
    const input = dialog.getByRole("combobox");
    await expect(input).toBeFocused();

    await page.keyboard.press("Shift+Tab");
    await expect(dialog).toContainText("Shortcut customization planned");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
