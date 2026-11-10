import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const baseURL = process.env.OMNIA_HEADLESS_BASE_URL ?? "http://127.0.0.1:1420/";
const outputDir = path.resolve(process.env.OMNIA_MEDIA_GEOMETRY_OUTPUT ?? "artifacts/media-geometry-probe");
const viewports = [
  { width: 1440, height: 900 },
  { width: 1014, height: 900 },
  { width: 900, height: 900 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(page, ms = 500) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(ms);
}

async function openLibraryMedia(page) {
  const library = page.locator('.activity-rail button[aria-label="Library"]');
  if (await library.count() === 1) {
    await library.click();
    await settle(page, 500);
  }
  const picker = page.locator("#library-workbench-select");
  await picker.waitFor({ state: "visible", timeout: 10_000 });
  const mediaOption = picker.locator('option[value="media"]');
  if (await mediaOption.count() !== 1) throw new Error("Library media option missing");
  await picker.selectOption("media");
  await settle(page, 800);
}

async function inspect(page) {
  return page.evaluate(() => {
    const panel = document.querySelector("#library-workbench-panel");
    const grid = document.querySelector(".media-generation__create-grid");
    const presets = [...document.querySelectorAll(".media-generation__preset")];
    const rect = (element) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        overflowX: style.overflowX,
        display: style.display,
        gridTemplateColumns: style.gridTemplateColumns,
      };
    };
    const panelRect = rect(panel);
    const gridRect = rect(grid);
    const presetRects = presets.map((element) => ({
      text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
      ...rect(element),
      styles: {
        minWidth: getComputedStyle(element).minWidth,
        maxWidth: getComputedStyle(element).maxWidth,
        width: getComputedStyle(element).width,
        boxSizing: getComputedStyle(element).boxSizing,
        gridTemplateColumns: getComputedStyle(element).gridTemplateColumns,
      },
      ancestors: (() => {
        const items = [];
        let current = element.parentElement;
        for (let index = 0; current && index < 5; index += 1, current = current.parentElement) {
          const style = getComputedStyle(current);
          const currentRect = current.getBoundingClientRect();
          items.push({
            tag: current.tagName.toLowerCase(),
            id: current.id,
            className: current.className,
            rect: { x: currentRect.x, width: currentRect.width, right: currentRect.right },
            scrollWidth: current.scrollWidth,
            clientWidth: current.clientWidth,
            display: style.display,
            gridTemplateColumns: style.gridTemplateColumns,
            minWidth: style.minWidth,
            width: style.width,
          });
        }
        return items;
      })(),
    }));
    const overflowOffenders = [...(panel?.querySelectorAll("*") ?? [])]
      .map((element) => {
        const r = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id,
          className: element.className,
          text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
          x: r.x,
          width: r.width,
          right: r.right,
          display: style.display,
          minWidth: style.minWidth,
          whiteSpace: style.whiteSpace,
        };
      })
      .filter((item) => item.width > 0 && (item.x < panelRect.x - 1 || item.right > panelRect.right + 1))
      .sort((a, b) => (b.right - panelRect.right) - (a.right - panelRect.right))
      .slice(0, 30);
    const parent = grid?.parentElement ?? null;
    const scrollContainers = [...document.querySelectorAll("body, #root, .app-shell, .primary-workspace, #library-workbench-panel, .media-generation-studio, .media-generation__create-grid")]
      .filter((element, index, all) => all.indexOf(element) === index)
      .map((element) => ({
        selector: element.id ? `#${element.id}` : `.${[...element.classList].slice(0, 2).join(".")}`,
        ...rect(element),
      }));
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
      },
      panel: panelRect,
      grid: gridRect,
      gridParent: rect(parent),
      presets: presetRects,
      overflowOffenders,
      scrollContainers,
    };
  });
}

await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport, colorScheme: "dark", reducedMotion: "reduce", locale: "en-US", timezoneId: "Asia/Ho_Chi_Minh", serviceWorkers: "block" });
    const page = await context.newPage();
    const events = { console: [], pageErrors: [], requestFailures: [] };
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") events.console.push({ type: message.type(), text: message.text() });
    });
    page.on("pageerror", (error) => events.pageErrors.push(error.message));
    page.on("requestfailed", (request) => events.requestFailures.push({ url: request.url(), error: request.failure()?.errorText ?? "unknown" }));
    await page.goto(baseURL, { waitUntil: "domcontentloaded" });
    await page.locator(".app-shell").waitFor({ timeout: 30_000 });
    await settle(page, 700);
    await openLibraryMedia(page);
    const geometry = await inspect(page);
    const fileStem = `media-${viewport.width}x${viewport.height}`;
    const screenshot = path.join(outputDir, `${fileStem}.png`);
    const panelScreenshot = path.join(outputDir, `${fileStem}-panel.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
    const panel = page.locator("#library-workbench-panel");
    if (await panel.isVisible().catch(() => false)) await panel.screenshot({ path: panelScreenshot, animations: "disabled" });
    results.push({ viewport, geometry, events, screenshot, panelScreenshot });
    await context.close();
  }
} finally {
  await browser.close();
}

const reportPath = path.join(outputDir, "report.json");
await fs.writeFile(reportPath, JSON.stringify({ baseURL, results }, null, 2));
process.stdout.write(JSON.stringify({ reportPath, results }, null, 2));
