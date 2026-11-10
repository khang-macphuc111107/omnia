import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

// Focused, non-desktop scroll evidence. This uses only a new headless
// Playwright context and never attaches to the user's browser or OS input.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseURL = process.env.OMNIA_HEADLESS_BASE_URL ?? "http://127.0.0.1:1420/";
const outputDir = path.resolve(
  projectRoot,
  process.env.OMNIA_SCROLL_OUTPUT_DIR ?? `artifacts/headless-scroll-${new Date().toISOString().slice(0, 10)}`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "surface";
}

async function inspectSurface(page, selector, name) {
  const locator = page.locator(selector).first();
  const exists = await locator.count() > 0;
  if (!exists) return { name, selector, status: "unavailable" };

  const before = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      overflowY: getComputedStyle(element).overflowY,
      overflowX: getComputedStyle(element).overflowX,
    };
  });

  await locator.evaluate((element) => {
    element.scrollTo({ top: element.scrollHeight, left: element.scrollWidth, behavior: "auto" });
  });
  await sleep(100);

  const after = await locator.evaluate((element) => {
    const containerRect = element.getBoundingClientRect();
    const candidateSelectors = [
      "[data-message-id]",
      "[data-conversation-id]",
      ".conversation-row",
      ".project-tree__group",
      ".project-tree__children > *",
      ".sidebar-footer-link",
      "button",
    ];
    const candidates = [...element.querySelectorAll(candidateSelectors.join(","))]
      .filter((candidate, index, all) => all.indexOf(candidate) === index)
      .map((candidate) => {
        const rect = candidate.getBoundingClientRect();
        const label = candidate.getAttribute("aria-label") || candidate.textContent?.replace(/\s+/g, " ").trim() || candidate.className || candidate.tagName;
        return {
          label: label.slice(0, 160),
          className: typeof candidate.className === "string" ? candidate.className : "",
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
          fullyWithinContainer: rect.width > 0 && rect.height > 0 && rect.left >= containerRect.left - 1 && rect.right <= containerRect.right + 1 && rect.top >= containerRect.top - 1 && rect.bottom <= containerRect.bottom + 1,
          visibleInContainer: rect.width > 0 && rect.height > 0 && rect.bottom > containerRect.top && rect.top < containerRect.bottom && rect.right > containerRect.left && rect.left < containerRect.right,
        };
      });
    const visibleCandidates = candidates.filter((candidate) => candidate.visibleInContainer);
    const lastCandidate = candidates.at(-1) ?? null;
    const lastVisibleCandidate = visibleCandidates.at(-1) ?? null;
    return {
      rect: { x: containerRect.x, y: containerRect.y, width: containerRect.width, height: containerRect.height, right: containerRect.right, bottom: containerRect.bottom },
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      overflowY: getComputedStyle(element).overflowY,
      overflowX: getComputedStyle(element).overflowX,
      verticalOverflow: element.scrollHeight > element.clientHeight + 1,
      horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
      reachedVerticalEnd: element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
      reachedHorizontalEnd: element.scrollLeft + element.clientWidth >= element.scrollWidth - 1,
      candidateCount: candidates.length,
      lastCandidate,
      lastVisibleCandidate,
      lastCandidateFullyWithinContainer: Boolean(lastCandidate?.fullyWithinContainer),
    };
  });

  const screenshot = path.join(outputDir, `${safeName(name)}.png`);
  await locator.screenshot({ path: screenshot, animations: "disabled" }).catch(() => {});
  return { name, selector, status: "ok", before, after, screenshot };
}

async function inspectFilterRow(page) {
  const locator = page.locator(".sidebar-filter-row").first();
  if (await locator.count() === 0) return { name: "sidebar-filter-row", selector: ".sidebar-filter-row", status: "unavailable" };
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const pills = [...element.querySelectorAll("button")].map((button) => {
      const buttonRect = button.getBoundingClientRect();
      return {
        label: button.textContent?.replace(/\s+/g, " ").trim() || button.getAttribute("aria-label") || "",
        rect: { x: buttonRect.x, y: buttonRect.y, width: buttonRect.width, height: buttonRect.height, right: buttonRect.right, bottom: buttonRect.bottom },
        fullyWithinRow: buttonRect.left >= rect.left - 1 && buttonRect.right <= rect.right + 1 && buttonRect.top >= rect.top - 1 && buttonRect.bottom <= rect.bottom + 1,
      };
    });
    return {
      name: "sidebar-filter-row",
      selector: ".sidebar-filter-row",
      status: "ok",
      row: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
      pills,
      allPillsWithinRow: pills.every((pill) => pill.fullyWithinRow),
    };
  });
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({
        viewport,
        colorScheme: "dark",
        reducedMotion: "reduce",
        locale: "en-US",
        timezoneId: "Asia/Ho_Chi_Minh",
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      const errors = [];
      page.on("console", (message) => { if (["error", "warning"].includes(message.type())) errors.push({ type: message.type(), text: message.text() }); });
      page.on("pageerror", (error) => errors.push({ type: "pageerror", text: error.message }));
      await page.goto(baseURL, { waitUntil: "domcontentloaded" });
      await page.locator(".app-shell").waitFor({ timeout: 30_000 });
      await sleep(500);
      const title = `${viewport.width}x${viewport.height}`;
      results.push({
        viewport,
        errors,
        filterRow: await inspectFilterRow(page),
        surfaces: [
          await inspectSurface(page, ".conversation-list", `${title}-conversation-list`),
          await inspectSurface(page, ".conversation-timeline", `${title}-conversation-timeline`),
        ],
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const report = { generatedAt: new Date().toISOString(), baseURL, isolatedHeadless: true, results };
  await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  const lines = [
    "# Omnia headless scroll-end probe",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Base URL: ${baseURL}`,
    `- Isolated headless: ${report.isolatedHeadless}`,
    "",
  ];
  for (const result of results) {
    lines.push(`## ${result.viewport.width}x${result.viewport.height}`, "");
    lines.push(`- Console/page errors: ${result.errors.length}`);
    const filter = result.filterRow;
    if (filter.status === "ok") lines.push(`- Filter row horizontal overflow: ${filter.horizontalOverflow}; pills inside row: ${filter.allPillsWithinRow}`);
    else lines.push(`- Filter row: ${filter.status}`);
    for (const surface of result.surfaces) {
      if (surface.status !== "ok") { lines.push(`- ${surface.name}: ${surface.status}`); continue; }
      lines.push(`- ${surface.name}: verticalOverflow=${surface.after.verticalOverflow}, reachedEnd=${surface.after.reachedVerticalEnd}, lastCandidateFullyWithinContainer=${surface.after.lastCandidateFullyWithinContainer}, horizontalOverflow=${surface.after.horizontalOverflow}`);
    }
    lines.push("");
  }
  await fs.writeFile(path.join(outputDir, "report.md"), `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(JSON.stringify({ outputDir, report }, null, 2));
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
  process.exitCode = 1;
});
