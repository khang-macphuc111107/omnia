import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

/**
 * Reproduce the desktop Chat interaction sequence that previously left the
 * outer `.app-shell` scrolled by hundreds of pixels.  This is deliberately a
 * renderer-only regression guard: it uses a fresh headless Playwright context
 * and synthetic page input, never the user's browser profile or OS pointer.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseURL = process.env.OMNIA_HEADLESS_BASE_URL ?? "http://127.0.0.1:1420/";
const stamp = process.env.OMNIA_SHELL_SCROLL_STAMP ?? new Date().toISOString().slice(0, 10);
const outputDir = path.resolve(
  projectRoot,
  process.env.OMNIA_SHELL_SCROLL_OUTPUT_DIR ?? `artifacts/headless-shell-scroll-${stamp}`,
);
const viewport = { width: 1440, height: 900 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(page, ms = 280) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(ms);
}

async function clickIfAvailable(page, locator, label, interactions, options = {}) {
  const required = options.required ?? true;
  const target = typeof locator === "string" ? page.locator(locator).first() : locator.first();
  if (!(await target.count()) || !(await target.isVisible().catch(() => false))) {
    interactions.push({ label, status: "not-found", required });
    return false;
  }
  if (await target.isDisabled().catch(() => false)) {
    interactions.push({ label, status: "disabled", required });
    return false;
  }
  try {
    // Locator.click is intentionally used here.  Playwright's isolated page
    // input reproduces focus/scroll behavior without taking over the desktop.
    await target.click({ timeout: 4_000 });
    interactions.push({ label, status: "clicked", required });
    await settle(page);
    return true;
  } catch (error) {
    interactions.push({
      label,
      status: "error",
      required,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function rectOf(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    right: rect.right,
    bottom: rect.bottom,
  };
}

async function measureShell(page, label) {
  return page.evaluate((surface) => {
    const query = (selector) => document.querySelector(selector);
    const shell = query(".app-shell");
    const read = (selector) => {
      const element = query(selector);
      if (!element) return null;
      return {
        selector,
        rect: (() => {
          const rect = element.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            right: rect.right,
            bottom: rect.bottom,
          };
        })(),
        scrollTop: "scrollTop" in element ? element.scrollTop : null,
        scrollLeft: "scrollLeft" in element ? element.scrollLeft : null,
        scrollWidth: "scrollWidth" in element ? element.scrollWidth : null,
        scrollHeight: "scrollHeight" in element ? element.scrollHeight : null,
        clientWidth: "clientWidth" in element ? element.clientWidth : null,
        clientHeight: "clientHeight" in element ? element.clientHeight : null,
        overflowX: getComputedStyle(element).overflowX,
        overflowY: getComputedStyle(element).overflowY,
      };
    };
    const shellData = read(".app-shell");
    return {
      surface,
      viewport: { width: innerWidth, height: innerHeight },
      pageScroll: { x: scrollX, y: scrollY },
      shell: shellData,
      titleBar: read(".title-bar"),
      rail: read(".activity-rail"),
      sidebar: read(".object-sidebar"),
      workspace: read(".primary-workspace"),
      conversationPane: read(".conversation-pane"),
      toolbar: read(".conversation-toolbar"),
      timeline: read(".conversation-timeline"),
      composer: read(".composer-region"),
      inspector: read(".context-inspector, .inspector-panel"),
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
      },
    };
  }, label);
}

function checkMetrics(metrics, surface = metrics?.surface ?? "surface") {
  const shell = metrics.shell;
  const titleBottom = metrics.titleBar?.rect?.bottom ?? 46;
  const failures = [];
  const fail = (message) => failures.push(`${surface}: ${message}`);
  if (!shell) fail(".app-shell is missing");
  if (shell && shell.scrollTop > 1) {
    fail(`.app-shell.scrollTop=${shell.scrollTop} (expected <= 1)`);
  }
  if (shell && shell.scrollLeft > 1) {
    fail(`.app-shell.scrollLeft=${shell.scrollLeft} (expected <= 1)`);
  }
  if (metrics.pageScroll?.x > 1 || metrics.pageScroll?.y > 1) {
    fail(`document page scroll=${metrics.pageScroll.x},${metrics.pageScroll.y} (expected <= 1)`);
  }
  for (const [name, entry] of [
    ["activity rail", metrics.rail],
    ["workspace", metrics.workspace],
    ["conversation pane", metrics.conversationPane],
    ["conversation toolbar", metrics.toolbar],
  ]) {
    if (!entry?.rect) continue;
    if (entry.rect.y < titleBottom - 1) {
      fail(`${name}.y=${entry.rect.y} is above title bar bottom ${titleBottom}`);
    }
  }
  if (shell && shell.scrollHeight > shell.clientHeight + 1) {
    fail(`.app-shell has unexpected scroll extent ${shell.scrollHeight} > ${shell.clientHeight}`);
  }
  if (shell && shell.scrollWidth > shell.clientWidth + 1) {
    fail(`.app-shell has unexpected horizontal scroll extent ${shell.scrollWidth} > ${shell.clientWidth}`);
  }
  if (metrics.document && metrics.document.scrollHeight > metrics.document.clientHeight + 1) {
    fail(`document has unexpected scroll extent ${metrics.document.scrollHeight} > ${metrics.document.clientHeight}`);
  }
  if (metrics.document && metrics.document.scrollWidth > metrics.document.clientWidth + 1) {
    fail(`document has unexpected horizontal scroll extent ${metrics.document.scrollWidth} > ${metrics.document.clientWidth}`);
  }
  const shellBottom = shell?.rect?.bottom;
  if (Number.isFinite(shellBottom)) {
    for (const [name, entry] of [
      ["workspace", metrics.workspace],
      ["conversation pane", metrics.conversationPane],
      ["timeline", metrics.timeline],
      ["composer", metrics.composer],
    ]) {
      if (entry?.rect?.bottom > shellBottom + 1) {
        fail(`${name}.bottom=${entry.rect.bottom} exceeds app-shell bottom ${shellBottom}`);
      }
    }
  }
  return failures;
}

function interactionFailures(interactions) {
  return interactions
    .filter((item) => item.required !== false)
    .filter((item) => ["error", "not-found", "disabled", "not-visible"].includes(item.status))
    .map((item) => {
      const suffix = item.error ? `: ${item.error.split("\n")[0]}` : "";
      return `${item.label} ${item.status}${suffix}`;
    });
}

async function recordEscape(page, label, interactions) {
  await page.keyboard.press("Escape");
  await settle(page, 120);
  const overlays = await page.locator('[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]').evaluateAll((elements) =>
    elements
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      })
      .map((element) => element.getAttribute("role") || element.className || element.tagName.toLowerCase()),
  );
  interactions.push({ label, status: overlays.length ? "still-open" : "closed", required: true, overlays });
}

async function runSequence(page) {
  const interactions = [];
  const metrics = [];

  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ timeout: 30_000 });
  await settle(page, 850);
  metrics.push(await measureShell(page, "chat-initial"));
  await page.screenshot({ path: path.join(outputDir, "chat-initial.png"), animations: "disabled" });

  const railLabels = await page
    .locator('.activity-rail button[aria-label]')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")).filter(Boolean));
  const expectedRailLabels = ["Home", "Chats", "Projects", "Background work", "Library", "Memory", "Skills", "Settings"];
  for (const expected of expectedRailLabels) {
    if (!railLabels.includes(expected)) {
      interactions.push({ label: `rail:${expected}`, status: "not-found", required: true });
    }
  }
  for (const label of railLabels) {
    const clicked = await clickIfAvailable(
      page,
      page.locator(`.activity-rail button[aria-label=${JSON.stringify(label)}]`),
      `rail:${label}`,
      interactions,
      { required: true },
    );
    if (!clicked) continue;
    metrics.push(await measureShell(page, `screen-${label}`));

    if (label === "Settings") {
      const tabs = await page
        .locator(".settings-nav button[role=tab]")
        .evaluateAll((buttons) => buttons.map((button) => ({ id: button.id, text: button.innerText.trim() })));
      if (!tabs.length) {
        interactions.push({ label: "settings-tabs", status: "not-found", required: true });
      }
      for (const tab of tabs) {
        await clickIfAvailable(
          page,
          page.locator(`[id=${JSON.stringify(tab.id)}]`),
          `settings-tab:${tab.text}`,
          interactions,
          { required: true },
        );
        metrics.push(await measureShell(page, `settings-${tab.text}`));
      }
    }
  }

  await clickIfAvailable(
    page,
    page.locator('.activity-rail button[aria-label="Chats"]'),
    "rail:Chats:return",
    interactions,
    { required: true },
  );
  await settle(page, 450);

  const sidebar = page.locator(".object-sidebar");
  const resizeHandle = page.locator(".object-sidebar__resize-handle");
  const beforeSidebar = await sidebar.boundingBox();
  const handleBox = await resizeHandle.boundingBox();
  if (beforeSidebar && handleBox && (await resizeHandle.isVisible().catch(() => false))) {
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 40);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + 90, handleBox.y + 40, { steps: 5 });
    await page.mouse.up();
    await settle(page, 250);
    interactions.push({
      label: "sidebar-resize:+90px",
      status: "dragged",
      before: beforeSidebar,
      after: await sidebar.boundingBox(),
      required: true,
    });
  } else {
    interactions.push({ label: "sidebar-resize:+90px", status: "not-found", required: true });
  }
  
  await clickIfAvailable(page, page.locator("#sidebar-toggle"), "sidebar-toggle:close", interactions, { required: true });
  await clickIfAvailable(page, page.locator("#sidebar-toggle"), "sidebar-toggle:open", interactions, { required: true });
  const rowMenuOpened = await clickIfAvailable(page, page.locator(".conversation-row__actions").first(), "chat-row-actions", interactions, { required: true });
  if (rowMenuOpened) await recordEscape(page, "escape:chat-row-actions", interactions);

  await clickIfAvailable(page, page.getByRole("button", { name: "Toggle inspector", exact: true }), "inspector-open", interactions, { required: true });
  await clickIfAvailable(page, page.getByRole("button", { name: "Toggle inspector", exact: true }), "inspector-close", interactions, { required: true });
  const commandPaletteOpened = await clickIfAvailable(page, page.getByRole("button", { name: /Open commands and navigation/ }), "command-palette-open", interactions, { required: true });
  if (commandPaletteOpened) await recordEscape(page, "escape:command-palette", interactions);

  for (const tabName of ["Write", "Split", "Preview"]) {
    await clickIfAvailable(page, page.getByRole("tab", { name: tabName, exact: true }), `composer-tab:${tabName}`, interactions, { required: true });
  }
  await clickIfAvailable(page, page.getByRole("tab", { name: "Write", exact: true }), "composer-tab:Write:return", interactions, { required: true });
  const composerInput = page.locator('[aria-label="Message Omnia"]');
  if (await composerInput.isVisible().catch(() => false)) {
    await composerInput.fill("headless shell scroll regression probe");
    await settle(page, 150);
    interactions.push({
      label: "composer-input:enable-send",
      status: (await page.getByRole("button", { name: "Send message", exact: true }).isDisabled().catch(() => null)) === false
        ? "enabled"
        : "not-enabled",
      required: true,
    });
    await composerInput.fill("");
  } else {
    interactions.push({ label: "composer-input:Message Omnia", status: "not-found", required: true });
  }

  for (const label of ["More formatting", "Block insert studio", "Open mode controls", "Open or close advanced parameters"]) {
    if (await clickIfAvailable(page, page.getByRole("button", { name: label, exact: true }), `composer:${label}`, interactions, { required: true })) {
      await recordEscape(page, `escape:composer:${label}`, interactions);
    }
  }

  metrics.push(await measureShell(page, "chat-interactions-final"));
  await page.screenshot({ path: path.join(outputDir, "chat-interactions-final.png"), animations: "disabled" });
  return { metrics, interactions };
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const events = { console: [], pageErrors: [], requestFailures: [] };
  const browser = await chromium.launch({ headless: true });
  let result;
  try {
    const context = await browser.newContext({
      viewport,
      colorScheme: "dark",
      reducedMotion: "reduce",
      locale: "en-US",
      timezoneId: "Asia/Ho_Chi_Minh",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") events.console.push({ type: message.type(), text: message.text() });
    });
    page.on("pageerror", (error) => events.pageErrors.push(error.message));
    page.on("requestfailed", (request) => events.requestFailures.push({ url: request.url(), error: request.failure()?.errorText ?? "unknown" }));

    const sequence = await runSequence(page);
    const finalMetrics = sequence.metrics.at(-1);
    const failures = sequence.metrics.flatMap((metric) => checkMetrics(metric, metric.surface));
    failures.push(...interactionFailures(sequence.interactions));
    if (events.console.length || events.pageErrors.length || events.requestFailures.length) {
      failures.push(`runtime events: console=${events.console.length}, pageErrors=${events.pageErrors.length}, requestFailures=${events.requestFailures.length}`);
    }
    result = {
      generatedAt: new Date().toISOString(),
      baseURL,
      viewport,
      isolatedHeadless: true,
      pass: failures.length === 0,
      failures,
      finalMetrics,
      metrics: sequence.metrics,
      interactions: sequence.interactions,
      events,
      screenshots: [
        path.join(outputDir, "chat-initial.png"),
        path.join(outputDir, "chat-interactions-final.png"),
      ],
    };
    await context.close();
  } finally {
    await browser.close();
  }

  await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(result, null, 2), "utf8");
  const markdown = [
    "# Omnia app-shell scroll regression",
    "",
    `- Generated: ${result.generatedAt}`,
    `- Base URL: ${result.baseURL}`,
    `- Isolated headless context: ${result.isolatedHeadless}`,
    `- Result: ${result.pass ? "PASS" : "FAIL"}`,
    `- Final app-shell scrollTop: ${result.finalMetrics?.shell?.scrollTop ?? "missing"}`,
    `- Final app-shell scrollHeight/clientHeight: ${result.finalMetrics?.shell?.scrollHeight ?? "missing"}/${result.finalMetrics?.shell?.clientHeight ?? "missing"}`,
    `- Console/page/request failures: ${result.events.console.length + result.events.pageErrors.length + result.events.requestFailures.length}`,
    "",
    "## Failures",
    "",
    ...(result.failures.length ? result.failures.map((failure) => `- ${failure}`) : ["- none"]),
    "",
    "The interaction sequence is intentionally synthetic and isolated; it does not capture or move the user's desktop pointer.",
  ].join("\n");
  await fs.writeFile(path.join(outputDir, "report.md"), markdown, "utf8");
  process.stdout.write(JSON.stringify({ outputDir, pass: result.pass, failures: result.failures, finalMetrics: result.finalMetrics }, null, 2));
  if (!result.pass) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
  process.exitCode = 1;
});
