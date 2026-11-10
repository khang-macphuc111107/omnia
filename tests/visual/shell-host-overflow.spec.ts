import { existsSync } from "node:fs";

import { chromium, expect, test, type Page, type TestInfo } from "@playwright/test";

// The probe is a plain ESM helper shared with the CLI; it ships without type
// declarations, so describe the slice of it this suite relies on.
// @ts-ignore -- untyped .mjs helper (tsconfig.node.json has no allowJs)
import * as probeModule from "./shell-overflow-probe.mjs";

/**
 * Cross-view shell-host overflow regression suite.
 *
 * Hosts every workspace screen inside the agent-shell frame
 * (`/__visual?host=shell&view=<id>&state=long-content`: 44px rail + 36px bar +
 * `.ws-surface`) and, at each supported width, asserts:
 *   - no document-level horizontal overflow,
 *   - no `.ws-surface` horizontal overflow,
 *   - no element extending past the surface edge (`beyondSurface`).
 * Clipped (non-scrolling, wider-than-box) elements are reported as soft
 * annotations only, because some clipping is intentional.
 *
 * Run against an existing dev server:
 *   $env:OMNIA_VISUAL_BASE_URL='http://127.0.0.1:1431'
 *   node node_modules/@playwright/test/cli.js test --config playwright.visual.config.ts tests/visual/shell-host-overflow.spec.ts
 * Browser: bundled chromium when installed, else the `msedge` channel.
 * Override with OMNIA_VISUAL_CHANNEL=msedge|chrome|chromium.
 */

type OverflowItem = { el: string; left?: number; right?: number; width?: number; scrollWidth?: number; clientWidth?: number; overflowX?: string };
type OverflowReport = {
  viewport: { width: number; height: number };
  documentScroll: { scrollWidth: number; clientWidth: number; overflow: number };
  surface: { left: number; right: number; scrollWidth: number; clientWidth: number; overflow: number } | null;
  beyondSurface: OverflowItem[];
  clipped: OverflowItem[];
  scrollers: OverflowItem[];
};
type ProbeModule = {
  probeShellOverflow: (options?: { scope?: string; limit?: number }) => OverflowReport;
  shellHostUrl: (base: string, options: { view: string; state?: string; locale?: string; theme?: string }) => string;
};
const { probeShellOverflow, shellHostUrl } = probeModule as unknown as ProbeModule;

const VIEWS = ["home", "projects", "work", "library", "memory", "skills", "code", "browser"] as const;
type View = (typeof VIEWS)[number];
const WIDTHS = [360, 480, 768, 1024, 1366, 1920] as const;
const HEIGHT = 900;
/** Full-bleed workbenches also get a short-height sanity check. */
const SHORT_SIZES: Partial<Record<View, { width: number; height: number }[]>> = {
  code: [{ width: 360, height: 600 }],
  browser: [{ width: 360, height: 600 }],
};
const BASE_URL = process.env.OMNIA_VISUAL_BASE_URL ?? `http://127.0.0.1:${process.env.OMNIA_VISUAL_PORT ?? "4173"}`;
const MAX_CLIPPED_ANNOTATIONS = 12;

function resolveChannel(): string | undefined {
  const fromEnv = process.env.OMNIA_VISUAL_CHANNEL?.trim();
  if (fromEnv) return fromEnv === "chromium" ? undefined : fromEnv;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    // executablePath throws when no bundled browser is registered.
  }
  return "msedge";
}

const channel = resolveChannel();
test.use({
  ...(channel ? { channel } : {}),
  viewport: { width: WIDTHS[0], height: HEIGHT },
  contextOptions: { reducedMotion: "reduce" },
});
test.describe.configure({ mode: "parallel" });

/** Runs in the page: "ready" | "error" | "" (still loading). */
const READY_SCRIPT = (): string => {
  const surface = document.querySelector(".ws-surface");
  if (!document.body.hasAttribute("data-visual-fixture-ready") || !surface) return "";
  if (surface.querySelector(".activity-load-state--error")) return "error";
  // ActivityScreenHost loading card, or the code/browser Suspense fallback.
  if (surface.querySelector(".activity-load-state[role='status']")) return "";
  if (surface.querySelector(":scope > p[role='status']")) return "";
  return surface.firstElementChild ? "ready" : "";
};

async function waitForScreen(page: Page): Promise<void> {
  await page.locator("body[data-visual-fixture-ready]").waitFor({ state: "attached", timeout: 90_000 });
  await page.locator(".ws-surface").waitFor({ state: "attached", timeout: 30_000 });
  const handle = await page.waitForFunction(READY_SCRIPT, undefined, { timeout: 60_000, polling: 200 });
  const state = await handle.jsonValue();
  if (state === "error") throw new Error("activity failed to load (error state rendered)");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  // Let lazy sections / layout settle.
  await page.waitForTimeout(800);
}

async function openView(page: Page, view: View, testInfo: TestInfo): Promise<void> {
  const url = shellHostUrl(BASE_URL, { view, state: "long-content" });
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitForScreen(page);
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
      // Other teams edit sources concurrently: Vite may 500 or full-reload.
      testInfo.annotations.push({ type: "retry", description: `navigation retried for ${view}: ${String(error).split("\n")[0]}` });
      await page.waitForTimeout(5_000);
    }
  }
}

async function measure(page: Page, view: View, size: { width: number; height: number }, testInfo: TestInfo): Promise<OverflowReport> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.setViewportSize(size);
      await page.waitForTimeout(250);
      const status = await page.evaluate(READY_SCRIPT);
      if (status !== "ready") throw new Error(`screen not ready before measuring (${status})`);
      return await page.evaluate(probeShellOverflow, { limit: 40 });
    } catch (error) {
      if (attempt >= 2) throw error;
      // Most likely a Vite full reload destroyed the execution context.
      testInfo.annotations.push({ type: "retry", description: `${view}@${size.width}x${size.height} re-opened: ${String(error).split("\n")[0]}` });
      await openView(page, view, testInfo);
    }
  }
}

function violations(report: OverflowReport): string[] {
  const out: string[] = [];
  if (report.documentScroll.overflow > 0) out.push(`document overflow ${report.documentScroll.overflow}px`);
  if (!report.surface) out.push("missing .ws-surface");
  else if (report.surface.overflow > 0) out.push(`.ws-surface overflow ${report.surface.overflow}px`);
  for (const b of report.beyondSurface) out.push(`beyond surface [${b.left}..${b.right}] ${b.el}`);
  return out;
}

for (const view of VIEWS) {
  test(`shell-host ${view}: no horizontal overflow across widths`, async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await openView(page, view, testInfo);

    const sizes = [...WIDTHS.map((width) => ({ width, height: HEIGHT })), ...(SHORT_SIZES[view] ?? [])];
    const failures: string[] = [];
    const reports: (OverflowReport & { size: string })[] = [];
    for (const size of sizes) {
      const tag = `${size.width}x${size.height}`;
      const report = await measure(page, view, size, testInfo);
      reports.push({ size: tag, ...report });
      const bad = violations(report);
      if (bad.length) failures.push(`${view} @ ${tag}:\n    ${bad.join("\n    ")}`);
      for (const c of report.clipped.slice(0, MAX_CLIPPED_ANNOTATIONS)) {
        testInfo.annotations.push({ type: "clipped", description: `${tag} ${c.el} ${c.scrollWidth}>${c.clientWidth} (${c.overflowX})` });
      }
      if (report.clipped.length > MAX_CLIPPED_ANNOTATIONS) {
        testInfo.annotations.push({ type: "clipped", description: `${tag} +${report.clipped.length - MAX_CLIPPED_ANNOTATIONS} more` });
      }
      if (bad.length) {
        await testInfo.attach(`${view}-${tag}.png`, { body: await page.screenshot(), contentType: "image/png" });
      }
    }
    if (pageErrors.length) testInfo.annotations.push({ type: "page-error", description: pageErrors.slice(0, 5).join(" | ") });
    await testInfo.attach(`${view}-overflow.json`, { body: JSON.stringify(reports, null, 2), contentType: "application/json" });

    expect(failures, `horizontal overflow offenders:\n  ${failures.join("\n  ")}`).toEqual([]);
  });
}
