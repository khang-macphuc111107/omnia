import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { openVisualScenario, type VisualScreen } from "./visual-fixture";

/** Renderer evidence only. Browser media/device emulation is kept separate from
 * packaged Windows DPI, Narrator, and WebView2 evidence in the QA receipt. */
async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    height: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(metrics).toEqual({ width: 0, height: 0 });
}

async function expectVisibleFocus(page: Page): Promise<void> {
  const focus = await page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return null;
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      hiddenAncestor: Boolean(element.closest('[hidden], [inert], [aria-hidden="true"]')),
      visible: bounds.width > 0 && bounds.height > 0 && style.visibility !== "hidden" && style.display !== "none",
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(focus).not.toBeNull();
  expect(focus!.hiddenAncestor).toBe(false);
  expect(focus!.visible).toBe(true);
  expect(focus!.outlineStyle).not.toBe("none");
  expect(focus!.outlineWidth).toBeGreaterThanOrEqual(1);
}

test.describe("renderer accessibility matrix", () => {
  test("keeps the primary rail keyboard reachable with visible focus in forced colors", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await page.goto("/?mock=empty&stream=0", { waitUntil: "domcontentloaded" });
    const rail = page.getByRole("navigation", { name: "Primary", exact: true });
    const chat = rail.getByRole("button", { name: "Chat", exact: true });
    await chat.focus();
    await page.keyboard.press("End");
    await expect(rail.getByRole("button", { name: "IDE", exact: true })).toBeFocused();
    await expectVisibleFocus(page);
    await page.keyboard.press("ArrowDown");
    await expect(chat).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(rail.getByRole("button", { name: "IDE", exact: true })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(chat).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(rail.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
    await expectVisibleFocus(page);
    await page.keyboard.press("Enter");
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(settings.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    expect(await settings.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(rail.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
    await expectNoDocumentOverflow(page);
  });

  for (const fontScale of [100, 125]) {
    test(`keeps command palette focus bounded and restores its origin at ${fontScale}% text`, async ({ page }) => {
      await page.addInitScript((scale) => {
        localStorage.setItem("omnia.agent.prefs.v1", JSON.stringify({ recentFolders: [], theme: "high-contrast", density: "compact", fontScale: scale }));
      }, fontScale);
      await page.goto("/?mock=empty&stream=0", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeVisible();
      const origin = page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("button", { name: "Chat", exact: true });
      await origin.focus();
      await page.keyboard.press("Control+k");
      const dialog = page.getByRole("dialog", { name: "Command palette", exact: true });
      await expect(dialog).toBeVisible();
      const box = dialog.getByRole("combobox", { name: "Search commands" });
      await expect(box).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await expectVisibleFocus(page);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(origin).toBeFocused();
      await expect(page.locator("html")).toHaveAttribute("data-contrast", "more");
      await expectNoDocumentOverflow(page);
    });
  }

  for (const scale of [100, 200] as const) {
    for (const forcedColors of ["none", "active"] as const) {
      test(`keeps names, roles, and layout at ${scale}% text with forced colors ${forcedColors}`, async ({ page }) => {
        await page.emulateMedia({ forcedColors, reducedMotion: "reduce" });
        await page.setViewportSize({ width: 1440, height: 900 });
        for (const screen of ["chat", "projects", "settings"] as const satisfies readonly VisualScreen[]) {
          await openVisualScenario(page, { screen, state: "populated", scale, locale: "vi", motion: "reduced" });
          await expectNoDocumentOverflow(page);
          const result = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
          expect(result.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
        }
      });
    }
  }
});
