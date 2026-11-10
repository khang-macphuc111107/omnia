import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseURL = process.env.OMNIA_HEADLESS_BASE_URL ?? "http://127.0.0.1:1420/";
const stamp = process.env.OMNIA_HEADLESS_AUDIT_STAMP ?? "2026-10-14";
const outputDir = path.resolve(
  projectRoot,
  process.env.OMNIA_HEADLESS_OUTPUT_DIR ?? `artifacts/headless-actual-app-${stamp}`,
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeName = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || "surface";

function mergeBox(box, padding, viewport) {
  if (!box) return null;
  const left = Math.max(0, Math.floor(box.x - padding));
  const top = Math.max(0, Math.floor(box.y - padding));
  const right = Math.min(viewport.width, Math.ceil(box.x + box.width + padding));
  const bottom = Math.min(viewport.height, Math.ceil(box.y + box.height + padding));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

async function settle(page, ms = 500) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(ms);
}

async function visibleBox(page, selector) {
  const locator = page.locator(selector).first();
  if (!(await locator.count()) || !(await locator.isVisible().catch(() => false))) return null;
  return locator.boundingBox().catch(() => null);
}

async function captureSurface(page, name, selectors, captures, viewport) {
  const normalized = safeName(name);
  const fullPath = path.join(outputDir, `${normalized}.png`);
  await page.screenshot({ path: fullPath, fullPage: true, animations: "disabled" });
  captures.push({ kind: "full", name, path: fullPath });

  for (const [regionName, selector] of selectors) {
    const box = mergeBox(await visibleBox(page, selector), 14, viewport);
    if (!box) continue;
    const regionPath = path.join(outputDir, `${normalized}--${safeName(regionName)}.png`);
    await page.screenshot({ path: regionPath, clip: box, animations: "disabled" });
    captures.push({ kind: "region", name: `${name} / ${regionName}`, selector, path: regionPath, box });
  }
}

async function inspectLayout(page, surface) {
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const result = await page.evaluate(() => {
    const selectors = [
      "button",
      "input",
      "textarea",
      "select",
      "[role=button]",
      "[role=tab]",
      "[role=menuitem]",
      "[role=slider]",
      "[role=separator]",
    ];
    const elements = [...document.querySelectorAll(selectors.join(","))];
    const textOf = (el) => (el.innerText || el.getAttribute("value") || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const labelOf = (el) =>
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("name") ||
      textOf(el);
    const rectOf = (rect) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    });
    const intersectsViewport = (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight;
    const selectorOf = (el) => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const classes = [...el.classList].filter(Boolean).slice(0, 3).map((name) => `.${CSS.escape(name)}`).join("");
      return `${el.tagName.toLowerCase()}${classes}`;
    };
    const clippingAncestorsOf = (el, rect) => {
      const clipping = [];
      let ancestor = el.parentElement;
      while (ancestor && ancestor !== document.documentElement) {
        const style = getComputedStyle(ancestor);
        const clipsX = ["hidden", "clip", "scroll", "auto"].includes(style.overflowX);
        const clipsY = ["hidden", "clip", "scroll", "auto"].includes(style.overflowY);
        const hasClipPath = style.clipPath && style.clipPath !== "none";
        if (clipsX || clipsY || hasClipPath) {
          const ancestorRect = ancestor.getBoundingClientRect();
          const clippedByX = clipsX && (rect.left < ancestorRect.left - 1 || rect.right > ancestorRect.right + 1);
          const clippedByY = clipsY && (rect.top < ancestorRect.top - 1 || rect.bottom > ancestorRect.bottom + 1);
          if (clippedByX || clippedByY || hasClipPath) {
            // `body`, `#root`, and the app shell commonly use overflow:hidden
            // and have the exact viewport bounds. They describe the browser
            // viewport boundary, not an additional layout region that clips a
            // control. Keep them in the diagnostic trail, but do not count
            // them as true ancestor clipping below.
            const viewportEquivalent =
              !hasClipPath &&
              Math.abs(ancestorRect.left) <= 1 &&
              Math.abs(ancestorRect.top) <= 1 &&
              Math.abs(ancestorRect.right - window.innerWidth) <= 1 &&
              Math.abs(ancestorRect.bottom - window.innerHeight) <= 1;
            clipping.push({
              selector: selectorOf(ancestor),
              overflowX: style.overflowX,
              overflowY: style.overflowY,
              clipPath: style.clipPath || "none",
              rect: rectOf(ancestorRect),
              clippedByX,
              clippedByY,
              viewportEquivalent,
            });
          }
        }
        ancestor = ancestor.parentElement;
      }
      return clipping;
    };
    const nearestScrollContainerOf = (el) => {
      let ancestor = el.parentElement;
      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        if (ancestor.scrollHeight > ancestor.clientHeight + 1 || ancestor.scrollWidth > ancestor.clientWidth + 1) {
          return selectorOf(ancestor);
        }
        ancestor = ancestor.parentElement;
      }
      return null;
    };
    const rows = elements.map((el, index) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible = Boolean(rect.width && rect.height && style.display !== "none" && style.visibility !== "hidden");
      const disabled = el.matches(":disabled,[aria-disabled=true]");
      const inViewport = visible && intersectsViewport(rect);
      const partiallyVisible = inViewport && (rect.left < -1 || rect.top < -1 || rect.right > window.innerWidth + 1 || rect.bottom > window.innerHeight + 1);
      const clippingAncestors = inViewport ? clippingAncestorsOf(el, rect) : [];
      const effectiveClippingAncestors = clippingAncestors.filter((ancestor) => !ancestor.viewportEquivalent);
      const clientWidth = el.clientWidth;
      const clientHeight = el.clientHeight;
      const hasUsefulBox = clientWidth > 1 || clientHeight > 1;
      const scrollWidth = el.scrollWidth;
      const scrollHeight = el.scrollHeight;
      const overflowX = hasUsefulBox && scrollWidth > clientWidth + 1;
      const overflowY = hasUsefulBox && scrollHeight > clientHeight + 1;
      // Chromium exposes an input's internal editing buffer through
      // `scrollWidth`, even when the control is intentionally clipped with
      // ellipsis. That is not a visual layout overflow: there is no child box
      // escaping the authored control bounds. Keep the raw metric for
      // diagnostics, but classify this narrow native-control case separately
      // so the summary only reports overflow a user can actually see.
      const isTextLikeControl =
        (el.tagName === "INPUT" && !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes((el.getAttribute("type") || "text").toLowerCase())) ||
        el.tagName === "TEXTAREA";
      const expectedInternalTextControlOverflow =
        isTextLikeControl &&
        overflowX &&
        ["hidden", "clip", "auto", "scroll"].includes(style.overflowX) &&
        (style.textOverflow === "ellipsis" || style.whiteSpace === "nowrap");
      const visualContentOverflow = (overflowX || overflowY) && !expectedInternalTextControlOverflow;
      return {
        index,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        label: labelOf(el),
        text: textOf(el),
        visible,
        inViewport,
        partiallyVisible,
        offscreen: visible && !inViewport,
        disabled,
        rect: rectOf(rect),
        clippingAncestors,
        effectiveClippingAncestors,
        clipped: inViewport && effectiveClippingAncestors.length > 0,
        clipReason: effectiveClippingAncestors.length > 0 ? "ancestor" : partiallyVisible ? "viewport-edge" : null,
        contentOverflow: overflowX || overflowY,
        visualContentOverflow,
        expectedInternalTextControlOverflow,
        overflowX,
        overflowY,
        clientSize: { width: clientWidth, height: clientHeight },
        scrollSize: { width: scrollWidth, height: scrollHeight },
        horizontalOverflow: style.overflowX === "visible" && overflowX,
        nearestScrollContainer: nearestScrollContainerOf(el),
        hasAccessibleName: Boolean(labelOf(el)),
      };
    });
    const body = document.body;
    const root = document.documentElement;
    const scrollContainers = [...document.querySelectorAll("*")]
      .map((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const vertical = el.scrollHeight > el.clientHeight + 1;
        const horizontal = el.scrollWidth > el.clientWidth + 1;
        if ((!vertical && !horizontal) || style.display === "none" || style.visibility === "hidden") return null;
        return {
          selector: selectorOf(el),
          tag: el.tagName.toLowerCase(),
          rect: rectOf(rect),
          clientSize: { width: el.clientWidth, height: el.clientHeight },
          scrollSize: { width: el.scrollWidth, height: el.scrollHeight },
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          inViewport: intersectsViewport(rect),
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.scrollSize.height - b.clientSize.height) - (a.scrollSize.height - a.clientSize.height))
      .slice(0, 80);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      pageScroll: { x: window.scrollX, y: window.scrollY },
      document: {
        scrollWidth: Math.max(body.scrollWidth, root.scrollWidth),
        clientWidth: root.clientWidth,
        scrollHeight: Math.max(body.scrollHeight, root.scrollHeight),
        clientHeight: root.clientHeight,
        horizontalOverflow: Math.max(body.scrollWidth, root.scrollWidth) > root.clientWidth + 1,
      },
      elements: rows,
      missingNames: rows.filter((row) => row.visible && ["button", "input", "textarea", "select"].includes(row.tag) && !row.hasAccessibleName),
      missingNamesInViewport: rows.filter((row) => row.inViewport && ["button", "input", "textarea", "select"].includes(row.tag) && !row.hasAccessibleName),
      clipped: rows.filter((row) => row.clipped),
      partiallyVisible: rows.filter((row) => row.partiallyVisible),
      offscreen: rows.filter((row) => row.offscreen),
      // `contentOverflow` preserves the raw DOM metric. The visual variants
      // are what feed the summary and the actionable follow-up list.
      contentOverflow: rows.filter((row) => row.contentOverflow),
      contentOverflowInViewport: rows.filter((row) => row.inViewport && row.visualContentOverflow),
      rawContentOverflowInViewport: rows.filter((row) => row.inViewport && row.contentOverflow),
      scrollContainers,
      enabledPlannedLabels: rows.filter((row) => row.visible && !row.disabled && /planned|unavailable|not compiled/i.test(`${row.label} ${row.text}`)),
    };
  });
  return { surface, ...result, viewport };
}

async function runAxe(page) {
  try {
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    const axe = await new AxeBuilder({ page }).analyze();
    return {
      violations: axe.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        description: violation.description,
        helpUrl: violation.helpUrl,
        nodes: violation.nodes.length,
        nodeDetails: violation.nodes.slice(0, 20).map((node) => ({
          target: node.target,
          html: node.html?.slice(0, 1200),
          failureSummary: node.failureSummary,
          any: node.any?.map((check) => ({ id: check.id, impact: check.impact, message: check.message })),
          all: node.all?.map((check) => ({ id: check.id, impact: check.impact, message: check.message })),
          none: node.none?.map((check) => ({ id: check.id, impact: check.impact, message: check.message })),
        })),
      })),
      passes: axe.passes.length,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function clickIfAvailable(page, locator, label, interactions) {
  const target = typeof locator === "string" ? page.locator(locator).first() : locator.first();
  if (!(await target.count()) || !(await target.isVisible().catch(() => false))) {
    interactions.push({ label, status: "not-found" });
    return false;
  }
  const disabled = await target.isDisabled().catch(() => false);
  if (disabled) {
    interactions.push({ label, status: "disabled" });
    return false;
  }
  try {
    await target.click({ timeout: 3500 });
    interactions.push({ label, status: "clicked" });
    await settle(page, 300);
    return true;
  } catch (error) {
    interactions.push({ label, status: "error", error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

async function runDesktopAudit(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "Asia/Ho_Chi_Minh",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const requestFailures = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleMessages.push({ type: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => requestFailures.push({ url: request.url(), failure: request.failure()?.errorText ?? "unknown" }));
  const captures = [];
  const layouts = [];
  const interactions = [];
  const regions = [
    ["rail", ".activity-rail"],
    ["sidebar", ".object-sidebar"],
    ["sidebar-resize", ".object-sidebar__resize-handle"],
    ["chat-header", ".conversation-toolbar"],
    ["workbench", ".chat-workbench-compact"],
    ["message-canvas", ".conversation-timeline"],
    ["composer", ".composer-region"],
    ["composer-format", ".composer-format-strip"],
    ["composer-toolbar", ".composer-toolbar"],
    ["inspector", ".context-inspector, .inspector-panel"],
    ["settings-nav", ".settings-nav"],
    ["settings-content", ".settings-content"],
    ["project-surface", ".projects-screen, .project-screen, .project-control-deck"],
  ];

  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ timeout: 30_000 });
  await settle(page, 900);
  await captureSurface(page, "00-chat-initial", regions, captures, { width: 1440, height: 900 });
  layouts.push(await inspectLayout(page, "chat-initial"));

  const railLabels = await page.locator(".activity-rail button[aria-label]").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")).filter(Boolean));
  for (const label of railLabels) {
    const clicked = await clickIfAvailable(page, page.locator(`.activity-rail button[aria-label=${JSON.stringify(label)}]`), `rail:${label}`, interactions);
    if (!clicked) continue;
    await captureSurface(page, `screen-${label}`, regions, captures, { width: 1440, height: 900 });
    layouts.push(await inspectLayout(page, `screen-${label}`));

    if (label === "Settings") {
      const tabs = await page.locator(".settings-nav button[role=tab]").evaluateAll((buttons) => buttons.map((button) => ({ id: button.id, text: button.innerText.trim() })));
      for (const tab of tabs) {
        const before = await page.locator(".settings-screen").evaluate((el) => ({ top: el.scrollTop, contentTop: el.querySelector(".settings-content")?.scrollTop ?? null })).catch(() => null);
        await clickIfAvailable(page, page.locator(`[id=${JSON.stringify(tab.id)}]`), `settings-tab:${tab.text}`, interactions);
        await settle(page, 450);
        const after = await page.locator(".settings-screen").evaluate((el) => ({ top: el.scrollTop, contentTop: el.querySelector(".settings-content")?.scrollTop ?? null })).catch(() => null);
        interactions.push({ label: `settings-tab-scroll:${tab.text}`, status: "measured", before, after });
        await captureSurface(page, `settings-${tab.text}`, regions, captures, { width: 1440, height: 900 });
        layouts.push(await inspectLayout(page, `settings-${tab.text}`));
      }
    }
  }

  // Return to Chat for the interaction matrix. Rail clicks are intentional and
  // stay inside this temporary headless context.
  await clickIfAvailable(page, page.locator('.activity-rail button[aria-label="Chats"]'), "rail:Chats:return", interactions);
  await settle(page, 450);

  // Sidebar open/close and synthetic resize (no desktop/global pointer input).
  const sidebar = page.locator(".object-sidebar");
  const resizeHandle = page.locator(".object-sidebar__resize-handle");
  const beforeSidebar = await sidebar.boundingBox();
  if (beforeSidebar && await resizeHandle.isVisible().catch(() => false)) {
    const handleBox = await resizeHandle.boundingBox();
    if (handleBox) {
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 40);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + 90, handleBox.y + 40, { steps: 5 });
      await page.mouse.up();
      await settle(page, 250);
      const afterSidebar = await sidebar.boundingBox();
      interactions.push({ label: "sidebar-resize:+90px", status: afterSidebar && beforeSidebar ? "measured" : "no-box", before: beforeSidebar, after: afterSidebar });
    }
  }
  await clickIfAvailable(page, page.locator('#sidebar-toggle'), "sidebar-toggle:close", interactions);
  await captureSurface(page, "chat-sidebar-closed", regions, captures, { width: 1440, height: 900 });
  await clickIfAvailable(page, page.locator('#sidebar-toggle'), "sidebar-toggle:open", interactions);

  // Chat list action menu, inspector drawer, command palette and composer.
  await clickIfAvailable(page, page.locator(".conversation-row__actions").first(), "chat-row-actions", interactions);
  await captureSurface(page, "chat-row-actions-open", regions, captures, { width: 1440, height: 900 });
  await page.keyboard.press("Escape");
  interactions.push({ label: "escape:chat-row-actions", status: "sent" });

  await clickIfAvailable(page, page.getByRole("button", { name: "Toggle inspector", exact: true }), "inspector-open", interactions);
  await captureSurface(page, "chat-inspector-open", regions, captures, { width: 1440, height: 900 });
  await clickIfAvailable(page, page.getByRole("button", { name: "Toggle inspector", exact: true }), "inspector-close", interactions);

  await clickIfAvailable(page, page.getByRole("button", { name: /Open commands and navigation/ }), "command-palette-open", interactions);
  await captureSurface(page, "command-palette-open", regions, captures, { width: 1440, height: 900 });
  await page.keyboard.press("Escape");
  interactions.push({ label: "escape:command-palette", status: "sent" });

  for (const tabName of ["Write", "Split", "Preview"]) {
    await clickIfAvailable(page, page.getByRole("tab", { name: tabName, exact: true }), `composer-tab:${tabName}`, interactions);
    await captureSurface(page, `composer-${tabName}`, regions, captures, { width: 1440, height: 900 });
  }
  await clickIfAvailable(page, page.getByRole("tab", { name: "Write", exact: true }), "composer-tab:Write:return", interactions);
  const composerInput = page.locator('[aria-label="Message Omnia"]');
  if (await composerInput.isVisible().catch(() => false)) {
    await composerInput.fill("headless UI audit draft");
    await settle(page, 150);
    const sendDisabled = await page.getByRole("button", { name: "Send message", exact: true }).isDisabled().catch(() => null);
    interactions.push({ label: "composer-input:enable-send", status: sendDisabled === false ? "enabled" : sendDisabled === true ? "still-disabled" : "missing" });
    await composerInput.fill("");
  }
  for (const label of ["More formatting", "Block insert studio", "Open mode controls", "Open or close advanced parameters"]) {
    const didClick = await clickIfAvailable(page, page.getByRole("button", { name: label, exact: true }), `composer:${label}`, interactions);
    if (didClick) {
      await captureSurface(page, `composer-${label}`, regions, captures, { width: 1440, height: 900 });
      await page.keyboard.press("Escape");
      await settle(page, 200);
    }
  }

  layouts.push(await inspectLayout(page, "chat-interactions-final"));
  const axe = await runAxe(page);
  await context.close();
  return { viewport: { width: 1440, height: 900 }, captures, layouts, interactions, axe, consoleMessages, pageErrors, requestFailures };
}

async function runNarrowAudit(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "Asia/Ho_Chi_Minh",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleMessages.push({ type: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const captures = [];
  const layouts = [];
  const interactions = [];
  const regions = [
    ["rail", ".activity-rail"],
    ["sidebar", ".object-sidebar"],
    ["chat-header", ".conversation-toolbar"],
    ["message-canvas", ".conversation-timeline"],
    ["composer", ".composer-region"],
    ["settings-nav", ".settings-nav"],
    ["settings-content", ".settings-content"],
  ];
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ timeout: 30_000 });
  await settle(page, 850);
  await captureSurface(page, "narrow-chat-initial", regions, captures, { width: 390, height: 844 });
  layouts.push(await inspectLayout(page, "narrow-chat-initial"));
  await clickIfAvailable(page, page.locator('#sidebar-toggle'), "narrow-sidebar-toggle", interactions);
  await captureSurface(page, "narrow-chat-sidebar-drawer", regions, captures, { width: 390, height: 844 });
  await page.keyboard.press("Escape");
  await clickIfAvailable(page, page.locator('.activity-rail button[aria-label="Settings"]'), "narrow-settings", interactions);
  await settle(page, 600);
  await captureSurface(page, "narrow-settings", regions, captures, { width: 390, height: 844 });
  layouts.push(await inspectLayout(page, "narrow-settings"));
  const axe = await runAxe(page);
  await context.close();
  return { viewport: { width: 390, height: 844 }, captures, layouts, interactions, axe, consoleMessages, pageErrors };
}

function summarize(report) {
  const allLayouts = [...report.desktop.layouts, ...report.narrow.layouts];
  const clipped = allLayouts.flatMap((layout) => layout.clipped.map((item) => ({ surface: layout.surface, ...item })));
  const partiallyVisible = allLayouts.flatMap((layout) => layout.partiallyVisible.map((item) => ({ surface: layout.surface, ...item })));
  const overflow = allLayouts.flatMap((layout) => layout.contentOverflowInViewport.map((item) => ({ surface: layout.surface, ...item })));
  const missingNames = allLayouts.flatMap((layout) => layout.missingNames.map((item) => ({ surface: layout.surface, ...item })));
  const missingNamesInViewport = allLayouts.flatMap((layout) => layout.missingNamesInViewport.map((item) => ({ surface: layout.surface, ...item })));
  const errors = [
    ...report.desktop.consoleMessages,
    ...report.narrow.consoleMessages,
    ...report.desktop.pageErrors.map((text) => ({ type: "pageerror", text })),
    ...report.narrow.pageErrors.map((text) => ({ type: "pageerror", text })),
  ];
  const axeViolations = [...(report.desktop.axe.violations ?? []), ...(report.narrow.axe.violations ?? [])];
  const axeViolationNodeCount = axeViolations.reduce((total, violation) => total + (violation.nodes ?? 0), 0);
  return {
    generatedAt: new Date().toISOString(),
    baseURL,
    captures: report.desktop.captures.length + report.narrow.captures.length,
    surfaces: allLayouts.length,
    trueClippedCount: clipped.length,
    partiallyVisibleCount: partiallyVisible.length,
    offscreenControlCount: allLayouts.reduce((total, layout) => total + layout.offscreen.length, 0),
    overflowCount: overflow.length,
    missingAccessibleNameCount: missingNames.length,
    missingAccessibleNameInViewportCount: missingNamesInViewport.length,
    consoleOrPageErrorCount: errors.length,
    axeViolationCount: axeViolations.length,
    axeViolationNodeCount,
    clipped: clipped.slice(0, 80),
    partiallyVisible: partiallyVisible.slice(0, 80),
    overflow: overflow.slice(0, 80),
    missingNames: missingNames.slice(0, 80),
    missingNamesInViewport: missingNamesInViewport.slice(0, 80),
    errors: errors.slice(0, 80),
    axeViolations,
    interactionErrors: [...report.desktop.interactions, ...report.narrow.interactions].filter((item) => item.status === "error"),
  };
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const desktop = await runDesktopAudit(browser);
    const narrow = await runNarrowAudit(browser);
    const report = { summary: summarize({ desktop, narrow }), desktop, narrow };
    await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
    const markdown = [
      `# Omnia actual-app headless audit`,
      ``,
      `- Generated: ${report.summary.generatedAt}`,
      `- Base URL: ${baseURL}`,
      `- Captures: ${report.summary.captures}`,
      `- Surfaces inspected: ${report.summary.surfaces}`,
      `- True ancestor-clipped controls (in viewport): ${report.summary.trueClippedCount}`,
      `- Partially visible controls at a viewport edge: ${report.summary.partiallyVisibleCount}`,
      `- Offscreen controls excluded from clipping count: ${report.summary.offscreenControlCount}`,
      `- Visual content overflow controls in viewport: ${report.summary.overflowCount}`,
      `- Missing accessible names (all mounted controls): ${report.summary.missingAccessibleNameCount}`,
      `- Missing accessible names (in viewport): ${report.summary.missingAccessibleNameInViewportCount}`,
      `- Console/page errors: ${report.summary.consoleOrPageErrorCount}`,
      `- Axe violations: ${report.summary.axeViolationCount} groups / ${report.summary.axeViolationNodeCount} nodes`,
      `- Interaction errors: ${report.summary.interactionErrors.length}`,
      ``,
      `Clipping counts intentionally exclude controls fully below/above the active scroll viewport. The raw native text-control editing-buffer metric is retained in \`rawContentOverflowInViewport\`, while \`overflow\` contains only visual overflow that can escape authored bounds. Inspect \`partiallyVisible\`, \`overflow\`, and \`scrollContainers\` in report.json for layout follow-up.`,
      ``,
      `## Interaction matrix`,
      ``,
      ...[...desktopInteractions(report.desktop), ...desktopInteractions(report.narrow)].map((item) => `- ${item.label}: ${item.status}${item.error ? ` — ${item.error}` : ""}`),
      ``,
      `## Evidence`,
      ``,
      `Screenshots and cropped regions are stored beside this report in the same directory.`,
    ].join("\n");
    await fs.writeFile(path.join(outputDir, "report.md"), markdown, "utf8");
    process.stdout.write(JSON.stringify({ outputDir, summary: report.summary }, null, 2));
  } finally {
    await browser.close();
  }
}

function desktopInteractions(section) {
  return section?.interactions ?? [];
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
  process.exitCode = 1;
});
