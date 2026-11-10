import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Independent live-renderer evidence. This script never installs a native mock,
// dispatches a provider request or opens a user filesystem grant.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseURL = process.env.OMNIA_REBUILD_AUDIT_URL ?? "http://127.0.0.1:1432/";
const outputRelative = process.env.OMNIA_REBUILD_AUDIT_DIR ?? "docs/rebuild/audit/ui-browser-20261108-current";
const out = path.join(root, outputRelative);
await fs.mkdir(out, { recursive: true });
const checks = [];
const states = [];
const sourcePaths = [
  "src/main.tsx", "src/rebuild/rebuild-app.tsx", "src/rebuild/rebuild-app.css",
  "src/rebuild/chat/chat-controller.ts", "src/rebuild/chat/chat-view.tsx", "src/rebuild/chat/chat-view.css",
  "src/rebuild/browser/browser-workspace.tsx", "src/rebuild/browser/browser-workspace.css",
  "src/rebuild/ide/ide-workspace.tsx", "src/rebuild/ide/ide-workspace.css",
  "src/rebuild/settings/settings.ts", "src/rebuild/settings/SettingsPanel.tsx", "src/rebuild/settings/settings.css",
  "src/rebuild/use-modal-boundary.ts", "src/rebuild/settings/ModelDiscoveryPanel.tsx", "src/rebuild/settings/model-discovery.ts",
];
const sha = async (relativePath) => createHash("sha256").update(await fs.readFile(path.join(root, relativePath))).digest("hex");
const sourceFiles = await Promise.all(sourcePaths.map(async (sourcePath) => ({ path: sourcePath, sha256: await sha(sourcePath) })));
const check = (id, pass, detail) => checks.push({ id, pass: Boolean(pass), detail });

async function inspect(page) {
  return page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const label = (el) => el.getAttribute("aria-label") || el.getAttribute("title") || el.labels?.[0]?.innerText?.trim() || el.innerText?.replace(/\s+/g, " ").trim() || el.getAttribute("placeholder") || el.tagName;
    const visible = (el) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
    const controls = [...document.querySelectorAll("button,input,textarea,select,[role=tab],[role=button],summary")].filter(visible).map((el) => ({
      tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), name: label(el), disabled: Boolean(el.disabled), tabIndex: el.tabIndex,
      box: box(el), fontFamily: getComputedStyle(el).fontFamily,
      withinViewport: (() => { const b = el.getBoundingClientRect(); return b.x >= -1 && b.y >= -1 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1; })(),
    }));
    const styleBox = (selector) => { const el = document.querySelector(selector); if (!el) return null; const s = getComputedStyle(el); return { box: box(el), display: s.display, fontFamily: s.fontFamily, borderRadius: s.borderRadius, gap: s.gap, padding: s.padding }; };
    return {
      viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.rebuildTheme,
      documentOverflow: { x: document.documentElement.scrollWidth - document.documentElement.clientWidth, y: document.documentElement.scrollHeight - document.documentElement.clientHeight },
      landmarks: [...document.querySelectorAll("main,nav,aside,[role=dialog]")].filter(visible).map((el) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), label: el.getAttribute("aria-label"), box: box(el) })),
      header: styleBox(".rb-topbar"), sessionSidebar: styleBox(".rb-session-list"), companion: styleBox(".rb-companion-chat"),
      browserTab: styleBox(".rb-browser__tab"), settingsTabs: styleBox(".settings-tabs"),
      composer: styleBox("textarea[aria-label='Message composer']"), controls,
    };
  });
}

async function snapshot(page, key) {
  await page.evaluate(() => document.fonts.ready);
  const layout = await inspect(page);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const violations = axe.violations.map((v) => ({ id: v.id, impact: v.impact, description: v.description, helpUrl: v.helpUrl, nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })) }));
  const screenshot = `${outputRelative}/${key}.png`;
  await page.screenshot({ path: path.join(root, screenshot), fullPage: false, animations: "disabled" });
  states.push({ key, layout, accessibility: { violations, passes: axe.passes.length, incomplete: axe.incomplete.map((i) => ({ id: i.id, impact: i.impact, targets: i.nodes.map((n) => n.target) })) }, screenshot: { path: screenshot, sha256: await sha(screenshot) } });
  check(`${key}/document-overflow`, layout.documentOverflow.x === 0 && layout.documentOverflow.y === 0, layout.documentOverflow);
  check(`${key}/axe-serious-critical`, !violations.some((v) => v.impact === "serious" || v.impact === "critical"), violations);
  check(`${key}/header-48px`, Math.abs((layout.header?.box.height ?? 0) - 48) < 1, layout.header);
  if (layout.browserTab) {
    check(`${key}/browser-tab-36px`, Math.abs((layout.browserTab.box.height ?? 0) - 36) < 1, layout.browserTab);
  }
  if (layout.sessionSidebar && layout.viewport.width >= 1200) {
    check(`${key}/session-sidebar-240px`, Math.abs((layout.sessionSidebar.box.width ?? 0) - 240) < 1, layout.sessionSidebar);
  }
  if (!key.endsWith("settings")) {
    const composer = layout.controls.find((c) => c.name === "Message composer");
    check(`${key}/composer-visible`, Boolean(composer?.withinViewport), composer ?? "No visible composer");
  }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 800, height: 600 }]) {
    for (const theme of ["dark", "light"]) {
      const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(baseURL, { waitUntil: "networkidle" });
      await page.getByRole("textbox", { name: "Message composer", exact: true }).waitFor();
      if (theme === "light") await page.getByRole("button", { name: "Toggle theme", exact: true }).click();
      const prefix = `${viewport.width}x${viewport.height}-${theme}`;
      await snapshot(page, `${prefix}-chat`);
      const nav = page.getByRole("navigation", { name: "Primary surfaces", exact: true });
      check(`${prefix}/three-primary-surfaces`, await nav.getByRole("button").count() === 3, await nav.innerText());
      await page.getByRole("textbox", { name: "Message composer", exact: true }).fill("Independent audit draft continuity");
      for (const surface of ["Browser", "IDE"]) {
        await nav.getByRole("button", { name: surface, exact: true }).click();
        const composer = page.locator('textarea[aria-label="Message composer"]');
        if (!await composer.isVisible()) {
          const toggle = page.getByRole("button", { name: "Open chat companion", exact: true });
          const reachable = await toggle.count() && await toggle.isVisible();
          check(`${prefix}/${surface}/companion-open-route`, reachable, "Compact workspace must expose a visible companion-chat action");
          if (reachable) await toggle.click();
        }
        await snapshot(page, `${prefix}-${surface.toLowerCase()}`);
        // Inspect the retained control even when CSS hides the companion at
        // compact width; visibility is a separate failing acceptance check.
        check(`${prefix}/${surface}/draft-continuity`, await composer.inputValue() === "Independent audit draft continuity", await composer.inputValue());
        if (viewport.width === 800 && await page.getByRole("button", { name: "Hide chat companion", exact: true }).count()) {
          await page.keyboard.press("Escape");
          const toggle = page.getByRole("button", { name: "Open chat companion", exact: true });
          check(`${prefix}/${surface}/companion-escape-close`, !await composer.isVisible(), "Escape closes the compact companion");
          check(`${prefix}/${surface}/companion-focus-restore`, await toggle.evaluate((el) => el === document.activeElement), "Focus returns to the companion toggle");
        }
      }
      await nav.getByRole("button", { name: "Chat", exact: true }).click();
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await snapshot(page, `${prefix}-settings`);
      const dialog = page.getByRole("dialog", { name: "Advanced runtime", exact: true });
      const focusInsideOnOpen = await dialog.evaluate((el) => el.contains(document.activeElement));
      check(`${prefix}/settings-focus-on-open`, focusInsideOnOpen, await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 600)));
      for (const name of ["Runtime", "Workflow", "Tools & RAG", "Privacy", "Appearance"]) {
        try {
          const tab = dialog.getByRole("tab", { name, exact: true });
          await tab.click({ timeout: 1500 });
          const panel = tab.getAttribute("aria-controls");
          check(`${prefix}/settings-tab-${name}-receives-pointer`, await tab.getAttribute("aria-selected") === "true" && await dialog.locator(`[id="${await panel}"]`).isVisible(), "Unforced click selected and revealed its panel");
        } catch (error) {
          check(`${prefix}/settings-tab-${name}-receives-pointer`, false, error.message.slice(0, 1200));
        }
      }
      await dialog.getByRole("textbox", { name: "Search settings", exact: true }).focus();
      const focusTrail = [];
      for (let index = 0; index < 4; index += 1) {
        await page.keyboard.press("Shift+Tab");
        focusTrail.push(await dialog.evaluate((el) => ({ inside: el.contains(document.activeElement), target: document.activeElement?.outerHTML.slice(0, 240) })));
      }
      check(`${prefix}/settings-keyboard-trap`, focusTrail.every((entry) => entry.inside), focusTrail);
      await page.keyboard.press("Escape");
      check(`${prefix}/settings-escape-close`, await dialog.count() === 0, "Escape should close the settings dialog and restore its origin");
      if (await dialog.count()) await page.getByRole("button", { name: "Close settings", exact: true }).click();
      const focusOrigin = page.getByRole("button", { name: "Open settings", exact: true });
      check(`${prefix}/settings-focus-restore`, await focusOrigin.evaluate((el) => el === document.activeElement), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 600)));
      // Capture visible keyboard focus and prove the mode shortcuts from a
      // composer instead of only proving click handlers.
      // Tab establishes keyboard modality before focusing the representative
      // nav control, so :focus-visible is measured under keyboard input.
      await page.keyboard.press("Tab");
      await nav.getByRole("button", { name: "Chat", exact: true }).focus();
      const focus = await nav.getByRole("button", { name: "Chat", exact: true }).evaluate((el) => ({ width: getComputedStyle(el).outlineWidth, style: getComputedStyle(el).outlineStyle }));
      check(`${prefix}/primary-visible-focus`, Number.parseFloat(focus.width) >= 1 && focus.style !== "none", focus);
      await page.keyboard.press("Alt+2");
      check(`${prefix}/alt-2-browser`, await nav.getByRole("button", { name: "Browser", exact: true }).getAttribute("aria-current") === "page", "Alt+2");
      await page.keyboard.press("Alt+3");
      check(`${prefix}/alt-3-ide`, await nav.getByRole("button", { name: "IDE", exact: true }).getAttribute("aria-current") === "page", "Alt+3");
      await page.keyboard.press("Alt+1");
      check(`${prefix}/alt-1-chat`, await nav.getByRole("button", { name: "Chat", exact: true }).getAttribute("aria-current") === "page", "Alt+1");
      check(`${prefix}/no-page-errors`, errors.length === 0, errors);
      await context.close();
    }
  }
} finally {
  await browser.close();
}

const sourceFilesAfter = await Promise.all(sourcePaths.map(async (sourcePath) => ({ path: sourcePath, sha256: await sha(sourcePath) })));
check("audit-source-stability", sourceFiles.every((file, index) => file.sha256 === sourceFilesAfter[index].sha256), sourceFilesAfter.filter((file, index) => file.sha256 !== sourceFiles[index].sha256));

const report = {
  schemaVersion: 1, reviewer: "/root/rebuild_independent_audit", recordedAt: new Date().toISOString(),
  scope: "Live browser renderer only; fresh local Vite source, no native mocks, no provider dispatch, no packaged/native/permission claim",
  baseURL, command: "node tests/rebuild-ui-browser-independent.mjs", sourceFiles, sourceFilesAfter,
  result: checks.every((c) => c.pass) ? "passed" : "failed_with_findings",
  summary: { checks: checks.length, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length, states: states.length },
  checks, states,
};
await fs.writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ result: report.result, summary: report.summary, failed: checks.filter((c) => !c.pass).map((c) => c.id), report: `${outputRelative}/report.json` }, null, 2));
process.exitCode = report.result === "passed" ? 0 : 1;
