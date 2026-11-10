#!/usr/bin/env node
// Shell-hosted overflow probe for Omnia workspace screens.
//
// Renders /__visual?host=shell&view=<view> (44px rail + 36px bar + .ws-surface)
// at several widths and reports horizontal overflow:
//   - document-level horizontal scroll
//   - .ws-surface horizontal scroll
//   - elements whose box extends past the .ws-surface right/left edge
//   - non-scrollable elements whose content is wider than their box
//     (clipped text/controls), excluding intentional scrollers and ellipsis
//
// Usage:
//   node tests/visual/shell-overflow-probe.mjs --view memory [--state long-content]
//     [--locale vi] [--widths 360,480,768,1024,1366,1920] [--height 900]
//     [--base http://127.0.0.1:1431] [--click "Tab label" --click "#selector"]
//     [--shots <dir>] [--scope ".some-root"] [--json]
//
// `--click` accepts either a CSS selector (starts with . # [ or contains >)
// or visible text of a button/tab/link to click before measuring.
//
// The browser-side probe (`probeShellOverflow`) is exported for Playwright specs.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_WIDTHS = [360, 480, 768, 1024, 1366, 1920];

/**
 * Runs inside the page. Returns a JSON-serializable report.
 * @param {{ scope?: string, limit?: number }} options
 */
export function probeShellOverflow(options = {}) {
  const limit = options.limit ?? 40;
  const surface = document.querySelector(".ws-surface");
  const root = (options.scope && document.querySelector(options.scope)) || surface || document.body;
  const doc = document.documentElement;
  const result = {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentScroll: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, overflow: doc.scrollWidth - doc.clientWidth },
    surface: null,
    beyondSurface: [],
    clipped: [],
    scrollers: [],
  };
  if (!surface) return result;
  const s = surface.getBoundingClientRect();
  result.surface = {
    left: Math.round(s.left),
    right: Math.round(s.right),
    scrollWidth: surface.scrollWidth,
    clientWidth: surface.clientWidth,
    overflow: surface.scrollWidth - surface.clientWidth,
  };

  const describe = (el) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
    const id = el.id ? `#${el.id}` : "";
    const testId = el.getAttribute("data-testid");
    const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    return `${el.tagName.toLowerCase()}${id}${cls ? "." + cls : ""}${testId ? `[data-testid=${testId}]` : ""}${text ? ` "${text}"` : ""}`;
  };
  const isHiddenByAncestorClip = (el) => {
    // Elements inside an intentional horizontal scroller (overflow-x auto/scroll)
    // are allowed to extend past the surface edge.
    for (let p = el.parentElement; p && p !== surface; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === "auto" || cs.overflowX === "scroll" || cs.overflowX === "hidden" || cs.overflowX === "clip") {
        const r = p.getBoundingClientRect();
        if (r.right <= s.right + 1 && r.left >= s.left - 1) return true;
      }
    }
    return false;
  };

  const all = root.querySelectorAll("*");
  for (const el of all) {
    if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) continue;
    if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (cs.position === "fixed") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // Visually-hidden helpers (sr-only) are 1px clipped boxes.
    if (r.width <= 1 && r.height <= 1) continue;

    if ((r.right > s.right + 1 || r.left < s.left - 1) && !isHiddenByAncestorClip(el)) {
      if (result.beyondSurface.length < limit) {
        result.beyondSurface.push({ el: describe(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
      }
    }

    if (el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 2) {
      const ox = cs.overflowX;
      if (ox === "auto" || ox === "scroll") {
        if (result.scrollers.length < limit) {
          result.scrollers.push({ el: describe(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
        }
      } else if (ox === "hidden" || ox === "clip" || ox === "visible") {
        const ellipsis = cs.textOverflow === "ellipsis";
        if (!ellipsis && result.clipped.length < limit) {
          result.clipped.push({ el: describe(el), overflowX: ox, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
        }
      }
    }
  }
  return result;
}

function parseArgs(argv) {
  const args = { clicks: [], widths: DEFAULT_WIDTHS, height: 900, base: "http://127.0.0.1:1431", view: "home", state: "long-content", locale: "en", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--view") args.view = next();
    else if (a === "--state") args.state = next();
    else if (a === "--locale") args.locale = next();
    else if (a === "--theme") args.theme = next();
    else if (a === "--widths") args.widths = next().split(",").map(Number);
    else if (a === "--height") args.height = Number(next());
    else if (a === "--base") args.base = next();
    else if (a === "--click") args.clicks.push(next());
    else if (a === "--shots") args.shots = next();
    else if (a === "--scope") args.scope = next();
    else if (a === "--json") args.json = true;
  }
  return args;
}

export function shellHostUrl(base, { view, state = "long-content", locale = "en", theme = "dark" }) {
  const q = new URLSearchParams({ host: "shell", view, state, locale, theme, motion: "reduced" });
  return `${base.replace(/\/$/, "")}/__visual?${q}`;
}

async function clickTarget(page, target) {
  const looksLikeSelector = /^[.#[]/.test(target) || target.includes(">") || target.includes("[");
  const locator = looksLikeSelector
    ? page.locator(target).first()
    : page.getByRole("tab", { name: target }).or(page.getByRole("button", { name: target })).or(page.getByRole("link", { name: target })).first();
  await locator.click({ timeout: 5000 });
  await page.waitForTimeout(300);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { chromium } = await import("playwright");
  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    browser = await chromium.launch({ channel: "msedge" });
  }
  const page = await browser.newPage({ viewport: { width: args.widths[0], height: args.height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(shellHostUrl(args.base, args), { waitUntil: "domcontentloaded" });
  await page.locator('body[data-visual-fixture-ready="true"]').waitFor({ state: "attached", timeout: 90000 });
  await page.locator(".ws-surface").waitFor({ state: "attached", timeout: 30000 });
  await page.waitForTimeout(1500);
  for (const c of args.clicks) await clickTarget(page, c);
  const reports = [];
  for (const width of args.widths) {
    await page.setViewportSize({ width, height: args.height });
    await page.waitForTimeout(250);
    const report = await page.evaluate(probeShellOverflow, { scope: args.scope });
    reports.push({ width, ...report });
    if (args.shots) {
      mkdirSync(args.shots, { recursive: true });
      const tag = [args.view, ...args.clicks.map((c) => c.replace(/[^a-z0-9]+/gi, "_"))].join("-");
      await page.screenshot({ path: path.join(args.shots, `${tag}-${width}.png`), fullPage: false });
    }
  }
  await browser.close();
  if (args.json) {
    console.log(JSON.stringify({ args, errors, reports }, null, 2));
    return;
  }
  if (errors.length) console.log(`page errors:\n  ${errors.join("\n  ")}`);
  for (const r of reports) {
    const bad = r.documentScroll.overflow > 0 || (r.surface?.overflow ?? 0) > 0 || r.beyondSurface.length || r.clipped.length;
    console.log(`\n=== ${args.view} @ ${r.width}px ${bad ? "FAIL" : "ok"}  docOverflow=${r.documentScroll.overflow} surfaceOverflow=${r.surface?.overflow ?? "n/a"}`);
    for (const b of r.beyondSurface) console.log(`  beyond  ${b.el}  [${b.left}..${b.right}]`);
    for (const c of r.clipped) console.log(`  clipped ${c.el}  ${c.scrollWidth}>${c.clientWidth} (${c.overflowX})`);
    for (const c of r.scrollers) console.log(`  scroller ${c.el}  ${c.scrollWidth}>${c.clientWidth}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
