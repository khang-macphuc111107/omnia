import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseURL = process.env.OMNIA_HEADLESS_BASE_URL ?? "http://127.0.0.1:1420/";
const outputDir = path.resolve(projectRoot, process.env.OMNIA_CHAT_FOCUSED_OUTPUT_DIR ?? "artifacts/headless-chat-focused");
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 900 },
  { name: "narrow", width: 390, height: 844 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
const safeError = (error) => (error instanceof Error ? error.message : String(error));

async function waitStable(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 30_000 });
  await sleep(500);
}

async function visible(page, selector) {
  return page.locator(selector).first().isVisible().catch(() => false);
}

async function rect(page, selector) {
  return page.locator(selector).first().evaluate((element, selectorName) => {
    const r = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      selector: selectorName,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      right: r.right,
      bottom: r.bottom,
      display: style.display,
      visibility: style.visibility,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      flex: style.flex,
      gridTemplateRows: style.gridTemplateRows,
    };
  }, selector).catch(() => null);
}

async function safeShot(page, selector, filePath) {
  try {
    const target = page.locator(selector).first();
    if (await target.isVisible()) {
      await target.screenshot({ path: filePath, animations: "disabled" });
      return true;
    }
  } catch {}
  return false;
}

async function visibleOverlays(page) {
  return page.evaluate(() => [...document.querySelectorAll("[role=dialog],[role=menu],[role=listbox],[role=tooltip],.composer-popover")]
    .map((element) => {
      const r = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        role: element.getAttribute("role"),
        label: element.getAttribute("aria-label"),
        text: (element.innerText || "").replace(/\s+/g, " ").trim().slice(0, 180),
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        visible: r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden",
      };
    })
    .filter((item) => item.visible));
}

async function launchPage(browser, viewport, events) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "Asia/Ho_Chi_Minh",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) events.console.push({ type: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => events.pageErrors.push(error.message));
  page.on("requestfailed", (request) => events.requestFailures.push({ url: request.url(), error: request.failure()?.errorText ?? "unknown" }));
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await waitStable(page);
  const chats = page.locator('.activity-rail button[aria-label="Chats"]').first();
  if (await chats.isVisible().catch(() => false)) {
    await chats.click().catch(() => {});
    await sleep(350);
  }
  return { context, page };
}

async function focusChatPage(browser, viewport) {
  const events = { console: [], pageErrors: [], requestFailures: [] };
  const { context, page } = await launchPage(browser, viewport, events);
  const viewportBounds = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  const selectors = [
    ".conversation-pane",
    ".conversation-timeline",
    ".composer-region",
    ".composer-shell",
    ".composer-editor-layout",
    ".composer-format-strip",
    ".composer-toolbar",
    ".composer-toolbar__left",
    ".composer-toolbar__right",
    ".composer-disclaimer",
    '[aria-label="Message Omnia"]',
    '[aria-label="Send message"]',
  ];
  const rectangles = {};
  for (const selector of selectors) rectangles[selector] = await rect(page, selector);

  const screenshotNames = [
    ["", `${viewport.name}.png`],
    [".composer-region", `${viewport.name}-composer-region.png`],
    [".composer-shell", `${viewport.name}-composer-shell.png`],
    [".composer-format-strip", `${viewport.name}-composer-format-strip.png`],
    [".composer-toolbar", `${viewport.name}-composer-toolbar.png`],
  ];
  for (const [selector, name] of screenshotNames) {
    const outputPath = path.join(outputDir, name);
    if (selector) await safeShot(page, selector, outputPath);
    else await page.screenshot({ path: outputPath, fullPage: true, animations: "disabled" });
  }

  const visibleControls = await page.evaluate(() => [...document.querySelectorAll("button,input,textarea,select,[role=button],[role=tab],[role=slider]")]
    .map((element) => {
      const r = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        label: element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent?.trim() || element.getAttribute("placeholder") || "",
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type"),
        disabled: element.matches(":disabled,[aria-disabled=true]"),
        rect: { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
        visible: r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden",
      };
    })
    .filter((item) => item.visible));
  const outOfViewport = visibleControls.filter((item) => item.rect.x < -1 || item.rect.y < -1 || item.rect.right > viewport.width + 1 || item.rect.bottom > viewport.height + 1);
  const overflow = await page.evaluate(() => ({
    documentScrollWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollHeight: document.documentElement.scrollHeight,
    documentClientHeight: document.documentElement.clientHeight,
    horizontal: document.documentElement.scrollWidth > innerWidth + 1,
    vertical: document.documentElement.scrollHeight > innerHeight + 1,
  }));

  const interaction = [];
  const recordClick = async (label, selector, action) => {
    const entry = { label, selector, status: "unavailable" };
    try {
      const target = page.locator(selector).first();
      if (!(await target.isVisible())) {
        entry.reason = "not-visible";
      } else {
        await action(target);
        await sleep(140);
        entry.status = "clicked";
        entry.overlays = await visibleOverlays(page);
        entry.containedOverlays = entry.overlays.every((item) => item.x >= -1 && item.y >= -1 && item.right <= viewport.width + 1 && item.bottom <= viewport.height + 1);
      }
    } catch (error) {
      entry.status = "error";
      entry.error = safeError(error);
    }
    interaction.push(entry);
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(100);
  };

  const input = page.locator('[aria-label="Message Omnia"]').first();
  if (await input.isVisible().catch(() => false)) {
    await input.fill("omnia-headless-probe");
    interaction.push({ label: "Fill message", selector: '[aria-label="Message Omnia"]', status: "filled", value: await input.inputValue() });
  } else {
    interaction.push({ label: "Fill message", selector: '[aria-label="Message Omnia"]', status: "unavailable", reason: "not-visible" });
  }
  await recordClick("Bold", '[aria-label="Bold"]', (target) => target.click());
  await recordClick("More formatting", '[aria-label="More formatting"]', (target) => target.click());
  await recordClick("Block insert studio", '[aria-label="Block insert studio"]', (target) => target.click());
  await recordClick("Open mode controls", '[aria-label="Open mode controls"]', (target) => target.click());
  await recordClick("Advanced parameters", '[aria-label="Open or close advanced parameters"]', (target) => target.click());
  const send = page.locator('[aria-label="Send message"]').first();
  interaction.push({
    label: "Send enabled after fill",
    selector: '[aria-label="Send message"]',
    status: await send.isVisible().catch(() => false) ? "checked" : "unavailable",
    disabled: await send.isDisabled().catch(() => null),
  });

  const payload = {
    viewport,
    viewportBounds,
    rectangles,
    visibleControls,
    outOfViewport,
    overflow,
    overlays: await visibleOverlays(page),
    interaction,
    events,
    screenshotNames: screenshotNames.map(([, name]) => path.join(outputDir, name)),
  };
  await context.close();
  return payload;
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const reports = [];
    for (const viewport of viewports) reports.push(await focusChatPage(browser, viewport));
    const report = {
      generatedAt: new Date().toISOString(),
      baseURL,
      isolatedHeadless: true,
      reports,
      summary: {
        viewports: reports.map((item) => item.viewport),
        outOfViewportCounts: reports.map((item) => ({ viewport: item.viewport.name, count: item.outOfViewport.length })),
        horizontalOverflow: reports.filter((item) => item.overflow.horizontal).map((item) => item.viewport.name),
        interactionErrors: reports.flatMap((item) => item.interaction.filter((entry) => entry.status === "error").map((entry) => ({ viewport: item.viewport.name, ...entry }))),
        consoleOrPageErrors: reports.flatMap((item) => [
          ...item.events.console.map((entry) => ({ viewport: item.viewport.name, scope: "console", ...entry })),
          ...item.events.pageErrors.map((message) => ({ viewport: item.viewport.name, scope: "pageerror", text: message })),
        ]),
      },
    };
    await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
    process.stdout.write(JSON.stringify({ outputDir, summary: report.summary }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
});
