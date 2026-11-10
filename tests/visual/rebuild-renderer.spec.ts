import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Page } from "@playwright/test";

type Surface = "Chat" | "Browser" | "IDE";
const VIEWPORTS = [
  { width: 800, height: 600 },
  { width: 1440, height: 900 },
] as const;

// Each test uses the actual renderer and an isolated browser profile. No native
// bridge or provider responses are installed. Remote requests fail the test.
const test = base.extend<{ runtimeFailures: string[] }>({
  runtimeFailures: [async ({ page }, use) => {
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(`page: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") failures.push(`console: ${message.text()}`); });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) await route.continue();
      // Some developer Windows images inject an AdGuard helper into
      // headless Chromium. It is outside the application and is absent from
      // GitHub runners; fulfill it locally so the app's no-remote-request
      // assertion remains deterministic without allowing any real remote
      // application resource.
      else if (url.hostname === "local.adguard.org") {
        await route.fulfill({ status: 204, contentType: "application/javascript", body: "" });
      }
      else {
        failures.push(`unexpected remote ${route.request().resourceType()} request`);
        await route.abort();
      }
    });
    await use(failures);
    expect(failures).toEqual([]);
  }, { auto: true }],
});

async function openRebuild(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-rebuild-theme", /^(dark|light)$/);
  await expect(page.getByRole("navigation", { name: "Primary surfaces" })).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
}

function primaryNavigation(page: Page) {
  return page.getByRole("navigation", { name: "Primary surfaces" });
}

async function selectSurface(page: Page, surface: Surface) {
  await primaryNavigation(page).getByRole("button", { name: surface, exact: true }).click();
  await expect(primaryNavigation(page).getByRole("button", { name: surface, exact: true })).toHaveAttribute("aria-current", "page");
}

async function expectNoDocumentOverflow(page: Page) {
  expect(await page.evaluate(() => ({
    width: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    height: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }))).toEqual({ width: 0, height: 0 });
}

async function expectBoundedDialogFocus(page: Page) {
  expect(await page.getByRole("dialog").evaluate((element) => element.contains(document.activeElement))).toBe(true);
}

test.describe("original renderer browser-preview contract", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of ["dark", "light"] as const) {
      for (const surface of ["Chat", "Browser", "IDE"] as const) {
        test(`${surface} ${theme} ${viewport.width}x${viewport.height}: bounded layout, accessible surface and real capture`, async ({ page }, testInfo) => {
          await page.setViewportSize(viewport);
          await openRebuild(page);
          if (theme === "light") await page.getByRole("button", { name: "Toggle theme" }).click();
          await expect(page.locator("html")).toHaveAttribute("data-rebuild-theme", theme);
          await selectSurface(page, surface);

          await expect(primaryNavigation(page).getByRole("button")).toHaveText(["Chat", "Browser", "IDE"]);
          await expect(page.locator("iframe")).toHaveCount(0);
          await expect(page.locator("body[data-visual-fixture-ready='true']")).toHaveCount(0);
          await expectNoDocumentOverflow(page);
          await expect(page.getByRole("banner")).toHaveCSS("height", "48px");
          await expect(page.getByRole("tablist", { name: "Open sessions", exact: true }).getByRole("tab").first()).toHaveCSS("height", "36px");

          if (surface === "Chat") {
            await expect(page.getByRole("region", { name: "Chat workspace" })).toBeVisible();
            await expect(page.getByRole("textbox", { name: "Message composer" })).toBeInViewport();
            await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
          } else if (surface === "Browser") {
            const browser = page.getByRole("region", { name: "Omnia native browser workspace" });
            await expect(browser).toContainText("Native WebView2 surface not connected");
            await expect(browser).toContainText("Preview · native surface unavailable");
          } else {
            const ide = page.getByRole("region", { name: "Omnia local IDE workspace" });
            await expect(ide).toContainText("No folder attached. Choose one to inspect local files.");
            await expect(ide).toContainText("local handles");
          }

          const duplicateIds = await page.evaluate(() => {
            const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
            return ids.filter((id, index) => ids.indexOf(id) !== index);
          });
          expect(duplicateIds).toEqual([]);
          const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
          expect(axe.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
          await page.screenshot({ path: testInfo.outputPath(`${surface.toLowerCase()}-${theme}-${viewport.width}x${viewport.height}.png`), fullPage: true });
        });
      }
    }
  }

  test("surface shortcuts preserve draft and conversation; preview send reports disconnection without inventing a reply", async ({ page }) => {
    await openRebuild(page);
    const composer = page.getByRole("textbox", { name: "Message composer" });
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await composer.fill("A local unsent draft for the visual contract");
    const selected = page.getByRole("tablist", { name: "Open sessions", exact: true }).getByRole("tab", { selected: true });
    const name = await selected.getAttribute("aria-label");
    for (const [shortcut, surface] of [["Alt+2", "Browser"], ["Alt+3", "IDE"], ["Alt+1", "Chat"]] as const) {
      await page.keyboard.press(shortcut);
      await expect(primaryNavigation(page).getByRole("button", { name: surface, exact: true })).toHaveAttribute("aria-current", "page");
      await expect(composer).toHaveValue("A local unsent draft for the visual contract");
      await expect(selected).toHaveAttribute("aria-label", name!);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(composer).toHaveValue("A local unsent draft for the visual contract");
    await composer.press("Control+Enter");
    await expect(page.getByText("Browser preview is disconnected; no assistant reply was fabricated.", { exact: true })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(page.getByRole("article")).toContainText("A local unsent draft for the visual contract");
    await expect(page.getByRole("article")).toContainText("You");
    await expect(composer).toHaveValue("");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  });

  test("theme persists through reload and settings defaults remain bounded and keyboard dismissible", async ({ page }) => {
    await openRebuild(page);
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-rebuild-theme", "light");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("data-rebuild-theme", "light");
    const trigger = page.getByRole("button", { name: "Open settings" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Advanced runtime" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("spinbutton", { name: "Compact context tokens" })).toHaveValue("200000");
    await expectBoundedDialogFocus(page);
    await page.keyboard.press("Shift+Tab");
    await expectBoundedDialogFocus(page);
    await page.keyboard.press("Tab");
    await expectBoundedDialogFocus(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("narrow workspaces retain the chat companion and Escape restores its toggle", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await openRebuild(page);
    for (const surface of ["Browser", "IDE"] as const) {
      await selectSurface(page, surface);
      const trigger = page.getByRole("button", { name: "Open chat companion" });
      await trigger.click();
      const companion = page.getByRole("complementary", { name: "Chat companion" });
      await expect(companion).toBeVisible();
      await expect(companion.getByRole("textbox", { name: "Message composer" })).toBeInViewport();
      await page.keyboard.press("Escape");
      await expect(companion).toBeHidden();
      await expect(trigger).toBeFocused();
      await expectNoDocumentOverflow(page);
    }
  });

  test("preview project and goal panels keep native mutations unavailable and close cleanly", async ({ page }) => {
    await openRebuild(page);
    const contextTrigger = page.getByRole("button", { name: "Open project context" });
    await contextTrigger.click();
    const project = page.getByRole("dialog", { name: "Project context workspace" });
    await expect(project).toBeVisible();
    await expect(project).toContainText(/preview|unavailable|desktop runtime/i);
    await page.keyboard.press("Escape");
    await expect(project).toHaveCount(0);
    await expect(contextTrigger).toBeFocused();

    const goalTrigger = page.getByRole("button", { name: "Open goals and plans" });
    await goalTrigger.click();
    const goals = page.getByRole("dialog", { name: "Goals and plans" });
    await expect(goals.getByRole("alert")).toContainText("Native workflow unavailable");
    await expect(goals.getByRole("alert")).toContainText("Code: native_unavailable");
    await expect(goals.getByRole("button", { name: "New goal", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(goals).toHaveCount(0);
    await expect(goalTrigger).toBeFocused();
  });

  test("forced colors and reduced motion preserve visible keyboard focus without active animation", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await openRebuild(page);
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return null;
      const style = getComputedStyle(active);
      const bounds = active.getBoundingClientRect();
      return { hidden: Boolean(active.closest("[inert], [hidden]")), width: bounds.width, height: bounds.height, outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) };
    });
    expect(focus).not.toBeNull();
    expect(focus!.hidden).toBe(false);
    expect(focus!.width).toBeGreaterThan(0);
    expect(focus!.height).toBeGreaterThan(0);
    expect(focus!.outlineStyle).not.toBe("none");
    expect(focus!.outlineWidth).toBeGreaterThanOrEqual(2);
    const activeAnimation = await page.locator("*:visible").evaluateAll((elements) => elements.filter((element) => {
      const style = getComputedStyle(element);
      return style.animationName !== "none" && style.animationDuration.split(",").some((duration) => parseFloat(duration) > 0.001);
    }).length);
    expect(activeAnimation).toBe(0);
    await expectNoDocumentOverflow(page);
  });
});
