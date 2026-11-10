import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  buildHeadlessReceipt,
  isAllowedRequestUrl,
  parseRunnerOptions,
} from "./perf-headless-runner-lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function printHelp() {
  process.stdout.write([
    "Usage: node scripts/perf-headless-runner.mjs [options]",
    "",
    "Collects bounded renderer metrics from local visual fixtures.",
    "  --base-url <url>       Local Omnia preview URL (default: http://127.0.0.1:1420/)",
    "  --output <path>        Receipt path (default: artifacts/performance/headless-receipt.json)",
    "  --pages <n>            Concurrent isolated pages, 1-8 (default: 1)",
    "  --duration-ms <n>      Sampling duration, 500-60000 ms (default: 5000)",
    "  --interval-ms <n>      Sampling interval, 50-5000 ms (default: 250)",
    "  --scenario <s:s>       Measure one visual scenario, e.g. chat:populated",
    "  --scenarios <a,b>      Comma-separated visual scenarios",
    "  --headed               Show Chromium instead of headless mode",
    "",
    "The runner blocks external requests and exits non-zero on runtime errors, external requests, or threshold failures.",
  ].join("\n") + "\n");
}

const errorText = (error) => error instanceof Error ? error.message : String(error);

function visualUrl(baseUrl, scenario) {
  const url = new URL("__visual", baseUrl);
  url.searchParams.set("screen", scenario.screen);
  url.searchParams.set("state", scenario.state);
  url.searchParams.set("theme", "dark");
  url.searchParams.set("density", "comfortable");
  url.searchParams.set("motion", "reduced");
  url.searchParams.set("scale", "100");
  url.searchParams.set("locale", "en");
  url.searchParams.set("overlay", "none");
  return url.toString();
}

async function collectPage(page, { baseUrl, scenario, pageIndex, durationMs, intervalMs, samples, events }) {
  const allowedOrigin = new URL(baseUrl).origin;
  const requestListener = (request) => {
    try {
      const url = new URL(request.url());
      const local = isAllowedRequestUrl(request.url(), allowedOrigin);
      events.requestCount += 1;
      if (!local) events.requests.push({ pageIndex, url: url.origin + url.pathname, resourceType: request.resourceType(), external: true });
    } catch {
      events.requestFailures.push({ pageIndex, url: request.url(), error: "invalid request URL" });
    }
  };
  const failureListener = (request) => events.requestFailures.push({ pageIndex, url: request.url(), error: request.failure()?.errorText ?? "unknown" });
  const consoleListener = (message) => { if (message.type() === "error") events.consoleErrors.push({ pageIndex, text: message.text().slice(0, 500) }); };
  const pageErrorListener = (error) => events.pageErrors.push({ pageIndex, text: error.message.slice(0, 500) });
  const socketListener = (socket) => {
    events.requestCount += 1;
    if (!isAllowedRequestUrl(socket.url(), allowedOrigin)) events.requests.push({ pageIndex, url: socket.url(), resourceType: "websocket", external: true });
  };
  page.on("request", requestListener);
  page.on("requestfailed", failureListener);
  page.on("console", consoleListener);
  page.on("pageerror", pageErrorListener);
  page.on("websocket", socketListener);
  const startedAt = Date.now();
  let session;
  try {
    await page.goto(visualUrl(baseUrl, scenario), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator('body[data-visual-fixture-ready="true"]').waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.fonts.status === "loaded", undefined, { timeout: 10_000 });
    if (await page.locator("html").getAttribute("data-visual-warnings") !== "0") throw new Error("Visual fixture reported parser warnings");
    const pageReadyMs = Date.now() - startedAt;
    session = await page.context().newCDPSession(page);
    await session.send("Performance.enable");
    samples.push({ pageIndex, scenario, measuredAtMs: Date.now(), metrics: { pageReadyMs } });
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      const metrics = await page.evaluate(() => {
        const perf = window.__omniaHeadlessPerf ?? { longTasks: [], frameGaps: [], longTasksSupported: false };
        const resources = performance.getEntriesByType("resource").reduce((total, entry) => total + (Number(entry.transferSize) || 0), 0);
        const frameGaps = Array.isArray(perf.frameGaps) ? perf.frameGaps : [];
        const longTasks = Array.isArray(perf.longTasks) ? perf.longTasks : [];
        return {
          domNodeCount: document.getElementsByTagName("*").length,
          longTaskCount: perf.longTasksSupported ? longTasks.length : null,
          longTaskTotalMs: perf.longTasksSupported ? longTasks.reduce((sum, item) => sum + (Number(item.duration) || 0), 0) : null,
          frameGapP95Ms: frameGaps.length ? frameGaps.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(frameGaps.length * 0.95) - 1)] : null,
          resourceTransferKiB: resources / 1024,
        };
      });
      const performanceMetrics = await session.send("Performance.getMetrics");
      const cdpMetrics = new Map(performanceMetrics.metrics.map((metric) => [metric.name, metric.value]));
      const heapBytes = cdpMetrics.get("JSHeapUsedSize");
      const milliseconds = (name) => typeof cdpMetrics.get(name) === "number" ? cdpMetrics.get(name) * 1_000 : null;
      samples.push({ pageIndex, scenario, measuredAtMs: Date.now(), metrics: {
        ...metrics,
        jsHeapUsedMiB: typeof heapBytes === "number" && Number.isFinite(heapBytes) ? heapBytes / (1024 * 1024) : null,
        rendererTaskDurationMs: milliseconds("TaskDuration"),
        rendererScriptDurationMs: milliseconds("ScriptDuration"),
        rendererLayoutDurationMs: milliseconds("LayoutDuration"),
      } });
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
    }
  } catch (error) {
    events.pageErrors.push({ pageIndex, text: `${scenario.screen}:${scenario.state}: ${errorText(error).slice(0, 500)}` });
  } finally {
    await session?.detach().catch(() => {});
    page.off("request", requestListener);
    page.off("requestfailed", failureListener);
    page.off("console", consoleListener);
    page.off("pageerror", pageErrorListener);
    page.off("websocket", socketListener);
  }
}

async function main() {
  const options = parseRunnerOptions(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  const samples = [];
  const events = { consoleErrors: [], pageErrors: [], requestFailures: [], requests: [], requestCount: 0 };
  const browser = await chromium.launch({ headless: options.headless });
  try {
    const pages = await Promise.all(Array.from({ length: options.pages }, async (_, pageIndex) => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: "dark",
        reducedMotion: "reduce",
        locale: "en-US",
        timezoneId: "Asia/Ho_Chi_Minh",
        serviceWorkers: "block",
      });
      const allowedOrigin = new URL(options.baseUrl).origin;
      await context.route("**/*", async (route) => {
        if (isAllowedRequestUrl(route.request().url(), allowedOrigin)) await route.continue();
        else await route.abort("blockedbyclient");
      });
      await context.routeWebSocket("**/*", (socket) => {
        if (isAllowedRequestUrl(socket.url(), allowedOrigin)) socket.connectToServer();
        else {
          events.requests.push({ pageIndex, url: socket.url(), resourceType: "websocket", external: true });
          socket.close({ code: 1008, reason: "External requests are disabled for performance collection" });
        }
      });
      await context.addInitScript(() => {
        const state = { longTasks: [], frameGaps: [], lastFrameAt: performance.now(), longTasksSupported: false };
        window.__omniaHeadlessPerf = state;
        if (typeof PerformanceObserver === "function" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
          try {
            const observer = new PerformanceObserver((list) => {
              state.longTasks.push(...list.getEntries().map((entry) => ({ duration: entry.duration })));
              if (state.longTasks.length > 2000) state.longTasks.splice(0, state.longTasks.length - 2000);
            });
            observer.observe({ type: "longtask", buffered: true });
            state.longTasksSupported = true;
          } catch { /* browser does not expose longtask */ }
        }
        const tick = (timestamp) => {
          const gap = timestamp - state.lastFrameAt;
          if (gap >= 0) state.frameGaps.push(gap);
          state.lastFrameAt = timestamp;
          if (state.frameGaps.length > 2000) state.frameGaps.splice(0, state.frameGaps.length - 2000);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const page = await context.newPage();
      await collectPage(page, {
        baseUrl: options.baseUrl,
        scenario: options.scenarios[pageIndex % options.scenarios.length],
        pageIndex,
        durationMs: options.durationMs,
        intervalMs: options.intervalMs,
        samples,
        events,
      });
      await context.close();
      return pageIndex;
    }));
    const metadata = {
      baseUrl: options.baseUrl,
      headless: options.headless,
      chromium: "playwright",
      pageCount: pages.length,
      measuredAt: new Date().toISOString(),
      gitRevision: process.env.GITHUB_SHA ?? process.env.OMNIA_GIT_REVISION ?? "working-tree",
    };
    const receipt = buildHeadlessReceipt({ metadata, samples, events, options });
    const output = path.resolve(projectRoot, options.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    process.stdout.write(`Headless performance ${receipt.status}.\n`);
    process.stdout.write(`- pages: ${options.pages}\n- samples: ${receipt.sampleCount}\n- runtime errors: ${receipt.events.consoleErrors.length + receipt.events.pageErrors.length + receipt.events.requestFailures.length}\n- external requests: ${receipt.events.externalRequests.length}\n- receipt: ${path.relative(projectRoot, output)}\n`);
    if (receipt.status === "fail") process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Headless performance failed: ${errorText(error)}\n`);
  process.exitCode = 2;
});

