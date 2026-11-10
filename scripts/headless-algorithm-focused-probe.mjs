import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseURL = process.env.OMNIA_HEADLESS_BASE_URL ?? "http://127.0.0.1:1420/";
const outputDir = path.resolve(projectRoot, process.env.OMNIA_ALGORITHM_OUTPUT_DIR ?? "artifacts/headless-algorithm-focused");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (error) => (error instanceof Error ? error.message : String(error));

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "Asia/Ho_Chi_Minh",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const events = { console: [], pageErrors: [], requestFailures: [] };
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) events.console.push({ type: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => events.pageErrors.push(error.message));
  page.on("requestfailed", (request) => events.requestFailures.push({ url: request.url(), error: request.failure()?.errorText ?? "unknown" }));
  const report = {
    generatedAt: new Date().toISOString(),
    baseURL,
    isolatedHeadless: true,
    events,
    steps: [],
  };
  try {
    await page.goto(baseURL, { waitUntil: "domcontentloaded" });
    await page.locator(".app-shell").waitFor({ state: "visible", timeout: 30_000 });
    await sleep(500);
    await page.locator('.activity-rail button[aria-label="Library"]').click({ timeout: 5_000 });
    await sleep(400);
    const select = page.locator("#library-workbench-select");
    await select.waitFor({ state: "visible", timeout: 5_000 });
    await select.selectOption("algorithms", { timeout: 5_000 });
    await sleep(300);
    const panel = page.locator("#library-workbench-panel");
    await panel.waitFor({ state: "visible", timeout: 5_000 });
    const button = panel.getByRole("button", { name: /Dijkstra shortest path/i }).first();
    await button.waitFor({ state: "visible", timeout: 5_000 });
    report.steps.push({ step: "mounted", buttonCount: await button.count(), beforePressed: await button.getAttribute("aria-pressed") });
    const normalStart = Date.now();
    let normalError = null;
    try {
      await button.click({ timeout: 5_000 });
    } catch (error) {
      normalError = errorText(error);
    }
    const normalElapsedMs = Date.now() - normalStart;
    await sleep(120);
    report.steps.push({
      step: "normal-click",
      elapsedMs: normalElapsedMs,
      error: normalError,
      pressed: await button.getAttribute("aria-pressed"),
      heading: await panel.locator("h3").first().textContent().catch(() => null),
    });
    const dispatchStart = Date.now();
    const dispatchResult = await button.dispatchEvent("click").then(() => ({ ok: true })).catch((error) => ({ ok: false, error: errorText(error) }));
    await sleep(120);
    report.steps.push({
      step: "dispatch-click",
      elapsedMs: Date.now() - dispatchStart,
      ...dispatchResult,
      pressed: await button.getAttribute("aria-pressed"),
      heading: await panel.locator("h3").first().textContent().catch(() => null),
    });
    await page.screenshot({ path: path.join(outputDir, "algorithms-panel.png"), fullPage: true, animations: "disabled" });
    report.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    report.success = report.steps.some((step) => step.step === "normal-click" && step.pressed === "true") || report.steps.some((step) => step.step === "dispatch-click" && step.pressed === "true");
  } catch (error) {
    report.error = errorText(error);
    report.success = false;
  } finally {
    report.events = events;
    await context.close();
    await browser.close();
  }
  await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  process.stdout.write(JSON.stringify({ outputDir, success: report.success, steps: report.steps, error: report.error ?? null, events: report.events }, null, 2));
  if (!report.success) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${errorText(error)}\n`);
  process.exitCode = 1;
});
