import { existsSync } from "node:fs";

import { chromium, expect, test } from "@playwright/test";

function resolveChannel(): string | undefined {
  const fromEnv = process.env.OMNIA_VISUAL_CHANNEL?.trim();
  if (fromEnv) return fromEnv === "chromium" ? undefined : fromEnv;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    // Bundled chromium is unavailable; fall back to system Edge.
  }
  return "msedge";
}

const channel = resolveChannel();

test.use({
  ...(channel ? { channel } : {}),
  viewport: { width: 1440, height: 900 },
  contextOptions: { reducedMotion: "reduce" },
});

/**
 * Release smoke contract for the post-redesign AgentShell:
 * - 3 primary shell surfaces (Chat, Browser, IDE) + Alt+1..3 + Settings button
 * - No legacy header disclosure row or unconditional emergency-stop pill
 * - HomeStart composer and StatusBar in the default view
 * - Consecutive finished tool calls stay collapsed inside .ag-tool-group with (/Explored \d+/ | /Ran \d+ tools/) until expanded
 */
test.describe("AgentShell release shell", () => {
  test("exposes the three-surface primary navigation, keyboard shortcuts, and settings dialog", async ({ page }) => {
    await page.goto("/?mock=long&stream=0");
    const rail = page.getByRole("navigation", { name: "Primary" });
    await expect(rail).toBeVisible();

    const views = ["Chat", "Browser", "IDE"] as const;
    for (const name of views) {
      await expect(rail.getByRole("button", { name, exact: true })).toBeVisible();
    }
    await expect(rail.getByRole("button", { name: "Settings", exact: true })).toBeVisible();

    // Legacy disclosure row is gone and Emergency Stop is hidden when no computer/browser tool is active.
    await expect(page.getByRole("button", { name: "Tools", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Emergency stop computer" })).toHaveCount(0);

    for (let index = 1; index <= views.length; index += 1) {
      await page.keyboard.press(`Alt+${index}`);
      await expect(rail.getByRole("button", { name: views[index - 1]!, exact: true })).toHaveAttribute("aria-current", "page");
    }

    await page.keyboard.press("Alt+1");
    await expect(rail.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute("aria-current", "page");

    await rail.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    // The lazy-loading placeholder also has the Settings dialog role/name.
    // Verify the real dialog is ready rather than passing on that placeholder.
    await expect(settings.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  });

  test("renders HomeStart composer and StatusBar in the default view", async ({ page }) => {
    await page.goto("/?mock=empty&stream=0");
    const homeStart = page.locator(".ag-home");
    await expect(homeStart).toBeVisible();
    await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
    await expect(page.locator(".ag-home__composer")).toBeVisible();

    const statusBar = page.locator(".ag-sb");
    await expect(statusBar).toBeVisible();
    await expect(page.getByRole("contentinfo", { name: "Status bar" })).toBeVisible();
  });

  test("keeps grouped tool rows collapsed with Explored count until expanded", async ({ page }) => {
    await page.goto("/?mock=long&stream=0");
    const transcript = page.getByRole("log", { name: "Conversation" });
    await expect(transcript).toBeVisible();

    const readRow = transcript.getByRole("button", { name: /Read src\/agent\/agent-shell\.tsx/ });
    await expect(readRow).toBeVisible();
    await expect(readRow).toHaveAttribute("aria-expanded", "false");

    await page.getByRole("button", { name: "Stop", exact: true }).click();

    const firstGroup = transcript.locator(".ag-tool-group").first();
    await expect(firstGroup).toBeVisible();
    const groupHead = firstGroup.locator(":scope > .ag-tool__head");
    await expect(groupHead).toHaveAttribute("aria-expanded", "false");
    await expect(groupHead.getByText(/Explored \d+|Ran \d+ tools/)).toBeVisible();
    await expect(firstGroup.locator(".ag-tool-group__body .ag-tool__head")).toHaveCount(0);

    await groupHead.click();
    await expect(groupHead).toHaveAttribute("aria-expanded", "true");
    await expect(firstGroup.locator(".ag-tool-group__body .ag-tool__head").first()).toBeVisible();
    expect(await firstGroup.locator(".ag-tool-group__body .ag-tool__head").count()).toBeGreaterThanOrEqual(2);
  });
});
