#!/usr/bin/env node
/**
 * UI overflow scanner for the Omnia AgentShell (dev only, browser mock backend).
 *
 * Usage:
 *   npm run dev:fast                      # in another terminal (http://127.0.0.1:1420)
 *   node scripts/ui-overflow-scan.mjs [--url http://127.0.0.1:1420] [--out <dir>]
 *        [--widths 800,1366] [--height 800] [--states agent,settings,rail:home] [--no-shots]
 *
 * Loads `/?mock=long&stream=0` (see src/agent/dev-mock/README.md) at each width
 * (default 800 900 1024 1280 1366 1920 2560; the window minimum is 800x600, plus
 * one 800x600 pass), opens each state (rail views, right panels, split view,
 * dialogs, settings sections, empty/error scenarios; rail views are discovered from
 * nav[aria-label=Primary]; a state whose control no longer exists is "skipped") and reports:
 *   - doc-hscroll: the document scrolls horizontally
 *   - offscreen: a visible element extends past the viewport (after ancestor clipping)
 *   - spill: scrollWidth > clientWidth+1 on an overflow:visible box (content spills out)
 *   - clipped-text: text cut by overflow hidden/clip without text-overflow: ellipsis
 *   - overlap: two visible text leaves overlap
 *   - console: console errors / page errors
 * Writes <out>/report.json (findings + summary grouped by selector) and PNGs.
 * Browser: bundled Chromium; if missing it tries `npx playwright install chromium`
 * once, then falls back to the installed Microsoft Edge (channel "msedge").
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const BASE = arg("url", "http://127.0.0.1:1420").replace(/\/$/, "");
const OUT = arg("out", join(tmpdir(), "omnia-ui-scan"));
const WIDTHS = arg("widths", "800,900,1024,1280,1366,1920,2560").split(",").map(Number);
const HEIGHT = Number(arg("height", "800"));
const STATE_FILTER = arg("states", "")?.split(",").filter(Boolean) ?? [];
const SHOTS = !argv.includes("--no-shots");
mkdirSync(OUT, { recursive: true });

async function launch() {
  try {
    return await chromium.launch();
  } catch {
    try {
      execSync("npx playwright install chromium", { stdio: "inherit", timeout: 240_000 });
      return await chromium.launch();
    } catch {
      console.warn("[scan] bundled Chromium unavailable; using Microsoft Edge (channel msedge)");
      return chromium.launch({ channel: "msedge" });
    }
  }
}

/** Clicks the first visible match; throws SKIP when the control does not exist in the current UI. */
async function clickFirst(page, locators) {
  for (const locator of locators) {
    const all = await locator.all();
    for (const candidate of all) {
      if (await candidate.isVisible()) { await candidate.click(); return; }
    }
  }
  throw new Error("SKIP: control not present in current UI");
}
const btn = (p, name) => p.getByRole("button", { name, exact: typeof name === "string" });
const rail = (p) => p.getByRole("navigation", { name: "Primary" });

/** Each state: optional query, then an async opener. Names are stable keys for --states. Rail views are discovered at runtime. */
const STATES = [
  { name: "agent" },
  { name: "agent-sidebar-hidden", open: (p) => clickFirst(p, [btn(p, "Hide sidebar")]) },
  { name: "panel:changes", open: (p) => clickFirst(p, [btn(p, "Changes")]) },
  { name: "panel:artifacts", open: (p) => clickFirst(p, [btn(p, "Artifacts")]) },
  { name: "panel:downloads", open: (p) => clickFirst(p, [btn(p, "Downloads")]) },
  { name: "split", query: "&split=1" },
  { name: "menu:session-actions", open: (p) => clickFirst(p, [btn(p, "More session actions")]) },
  { name: "dialog:settings", open: (p) => clickFirst(p, [rail(p).getByRole("button", { name: "Settings", exact: true }), btn(p, "Settings")]), settle: "dialog" },
  { name: "dialog:settings-sections", open: (p) => clickFirst(p, [rail(p).getByRole("button", { name: "Settings", exact: true }), btn(p, "Settings")]), sections: true },
  { name: "dialog:palette", open: (p) => p.keyboard.press("Control+K"), settle: "dialog" },
  { name: "dialog:new-session", open: (p) => clickFirst(p, [btn(p, /^\s*New (session|chat)/i), p.locator(".ag-sidebar__new")]), settle: "dialog" },
  { name: "dialog:session-settings", open: (p) => menu(p, "Session settings"), settle: "dialog" },
  { name: "dialog:services", open: (p) => menu(p, "Services"), settle: "dialog" },
  { name: "dialog:trust", open: (p) => menu(p, "Workspace trust"), settle: "dialog" },
  { name: "scenario:empty", query: "", mock: "empty" },
  { name: "scenario:error", query: "", mock: "error" },
];

async function menu(page, item) {
  await clickFirst(page, [btn(page, "More session actions")]);
  await clickFirst(page, [page.getByRole("menuitem", { name: item })]);
}

/** Runs in the page: returns findings for the current DOM. */
function collect() {
  const vw = window.innerWidth;
  const out = [];
  const sel = (el) => {
    const parts = [];
    for (let node = el; node && node !== document.body && parts.length < 4; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      const cls = [...node.classList].filter((c) => !/^(ag-spin|is-|active)/.test(c)).slice(0, 2);
      if (cls.length) part += "." + cls.join(".");
      const label = node.getAttribute("aria-label");
      if (label) part += `[aria-label="${label.slice(0, 40)}"]`;
      parts.unshift(part);
      if (node.id) { parts[0] = `#${node.id}`; break; }
    }
    return parts.join(" > ");
  };
  const textOf = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const styles = new Map();
  const style = (el) => { let cs = styles.get(el); if (!cs) { cs = getComputedStyle(el); styles.set(el, cs); } return cs; };
  const srOnly = (el, r) => r.width <= 2 || r.height <= 2 || /sr-only|visually-hidden/.test(el.className?.baseVal ?? el.className ?? "");
  const visible = (el, cs) => {
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    if (el.closest("[hidden],[aria-hidden='true'],.sr-only")) return false;
    const details = el.closest("details:not([open])");
    if (details && !el.closest("summary")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !srOnly(el, r);
  };
  /** Visible rect after clipping by overflow ancestors (null when fully clipped). */
  const clippedRect = (el) => {
    const r = el.getBoundingClientRect();
    let { left, right, top, bottom } = r;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = style(a);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const ar = a.getBoundingClientRect();
        if (cs.overflowX !== "visible") { left = Math.max(left, ar.left); right = Math.min(right, ar.right); }
        if (cs.overflowY !== "visible") { top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom); }
      }
      if (cs.position === "fixed") break;
    }
    top = Math.max(top, 0); bottom = Math.min(bottom, window.innerHeight);
    return right - left > 0 && bottom - top > 0 ? { left, right, top, bottom } : null;
  };
  const doc = document.scrollingElement;
  if (doc && doc.scrollWidth > vw + 1) out.push({ kind: "doc-hscroll", selector: "html", detail: `scrollWidth ${doc.scrollWidth} > ${vw}` });

  const all = [...document.body.querySelectorAll("*")].filter((el) => !["SCRIPT", "STYLE", "svg", "path", "OPTION"].includes(el.tagName) && !(el instanceof SVGElement));
  const offscreen = new Set();
  const leaves = [];
  for (const el of all) {
    const cs = style(el);
    if (!visible(el, cs)) continue;
    const clip = clippedRect(el);
    if (!clip) continue;
    const { left, right } = clip;
    if (right > vw + 1 || left < -1) {
      if (!el.parentElement || !offscreen.has(el.parentElement)) {
        out.push({ kind: "offscreen", selector: sel(el), detail: `visible ${Math.round(left)}..${Math.round(right)} of viewport ${vw}`, text: textOf(el) });
      }
      offscreen.add(el);
    }
    const sw = el.scrollWidth, cw = el.clientWidth;
    if (cw > 0 && sw > cw + 1 && !["HTML", "BODY", "TEXTAREA", "INPUT", "SELECT", "IFRAME"].includes(el.tagName)) {
      const parentScrolls = el.parentElement && /auto|scroll/.test(style(el.parentElement).overflowX);
      if (cs.overflowX === "visible" && !parentScrolls) {
        out.push({ kind: "spill", selector: sel(el), detail: `scrollWidth ${sw} > clientWidth ${cw} (overflow visible)`, text: textOf(el) });
      } else if ((cs.overflowX === "hidden" || cs.overflowX === "clip") && cs.textOverflow !== "ellipsis") {
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (hasText) out.push({ kind: "clipped-text", selector: sel(el), detail: `text clipped ${sw}>${cw} without ellipsis`, text: textOf(el) });
      }
    }
    if (cs.display !== "inline" && !el.closest("pre,code,table") && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
      leaves.push({ el, r: clip, cs });
    }
  }
  // Overlapping text leaves (same layer only: skip anything inside fixed/absolute overlays vs. the base).
  // Same layer only: a dialog/menu/positioned overlay legitimately covers the base layer.
  const layer = (el) => {
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const role = a.getAttribute("role");
      if (role && /^(dialog|menu|tooltip|listbox)$/.test(role)) return a;
      const cs = style(a);
      if ((cs.position === "fixed" || cs.position === "absolute") && cs.zIndex !== "auto") return a;
    }
    return null;
  };
  let overlaps = 0;
  for (let i = 0; i < leaves.length && overlaps < 30; i += 1) {
    for (let j = i + 1; j < leaves.length && overlaps < 30; j += 1) {
      const a = leaves[i], b = leaves[j];
      if (a.el.contains(b.el) || b.el.contains(a.el) || layer(a.el) !== layer(b.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 4 && h > 4) {
        overlaps += 1;
        out.push({ kind: "overlap", selector: `${sel(a.el)}  ×  ${sel(b.el)}`, detail: `overlap ${Math.round(w)}x${Math.round(h)}px`, text: `${textOf(a.el)} | ${textOf(b.el)}` });
      }
    }
  }
  return out;
}

const findings = [];
const browser = await launch();
const started = Date.now();
const passes = [...WIDTHS.map((w) => [w, HEIGHT]), [800, 600]];
for (const [width, height] of passes) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  let consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 300)}`));
  // Discover rail destinations (labels change as the UI evolves); Settings is covered by the dialog states.
  await page.goto(`${BASE}/?mock=long&stream=0`, { waitUntil: "domcontentloaded" });
  await rail(page).waitFor({ timeout: 15_000 });
  const railLabels = (await rail(page).getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") || e.textContent.trim())))
    .filter((label) => label && !/^(settings|agent|chat)$/i.test(label));
  const states = [...STATES, ...railLabels.map((label) => ({ name: `rail:${label.toLowerCase().replace(/\s+/g, "-")}`, open: (p) => rail(p).getByRole("button", { name: label, exact: true }).click() }))];
  for (const state of states) {
    if (STATE_FILTER.length && !STATE_FILTER.some((f) => state.name === f || state.name.startsWith(f))) continue;
    if (height === 600 && !["agent", "dialog:settings", "dialog:new-session", "panel:downloads"].includes(state.name)) continue;
    consoleErrors = [];
    const url = `${BASE}/?mock=${state.mock ?? "long"}&stream=0${state.query ?? ""}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = findings.length;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.getByRole("navigation", { name: "Primary" }).waitFor({ timeout: 15_000 });
      if (!state.mock) await page.locator(".ag-composer, [aria-label='Run status']").first().waitFor({ timeout: 6_000 }).catch(() => undefined);
      await page.waitForTimeout(400);
      if (state.open) await state.open(page);
      if (state.settle === "dialog" || state.sections) await page.getByRole("dialog").first().waitFor({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(state.name.startsWith("rail:") ? 1500 : 500);
      const shoot = async (suffix) => {
        const items = await page.evaluate(collect);
        for (const item of items) findings.push({ width, height, state: state.name + suffix, ...item });
        if (SHOTS) await page.screenshot({ path: join(OUT, `${width}x${height}__${(state.name + suffix).replace(/[^a-z0-9-]+/gi, "_")}.png`) });
        return items.length;
      };
      if (state.sections) {
        const nav = page.getByRole("navigation", { name: "Settings sections" }).or(page.getByRole("tablist", { name: "Settings sections" }));
        const buttons = nav.first().locator("button, [role='tab']");
        const count = await buttons.count();
        if (count === 0) await shoot("");
        for (let i = 0; i < count; i += 1) {
          const label = ((await buttons.nth(i).innerText()).trim() || `s${i}`).toLowerCase().replace(/\s+/g, "-");
          await buttons.nth(i).click();
          await page.waitForTimeout(300);
          await shoot(`/${label}`);
        }
      } else {
        await shoot("");
      }
      break;
    } catch (cause) {
      if (String(cause?.message).includes("SKIP:")) { findings.push({ width, height, state: state.name, kind: "skipped", selector: "-", detail: "control not present" }); break; }
      if (attempt === 0 && findings.length === before) { consoleErrors = []; continue; }
      findings.push({ width, height, state: state.name, kind: "scan-error", selector: "-", detail: String(cause?.message ?? cause).split("\n")[0] });
    }
    }
    for (const message of consoleErrors) findings.push({ width, height, state: state.name, kind: "console", selector: "-", detail: message });
  }
  await context.close();
  process.stdout.write(`[scan] ${width}x${height} done (${findings.length} findings so far)\n`);
}
await browser.close();

// Summary: group by kind + selector (+ state), list widths; most widespread first.
const groups = new Map();
for (const f of findings) {
  const key = `${f.kind}|${f.selector}|${f.kind === "console" || f.kind === "scan-error" ? f.detail : ""}`;
  const g = groups.get(key) ?? { kind: f.kind, selector: f.selector, detail: f.detail, text: f.text, widths: new Set(), states: new Set(), count: 0 };
  g.widths.add(`${f.width}x${f.height}`);
  g.states.add(f.state);
  g.count += 1;
  groups.set(key, g);
}
const rank = { "doc-hscroll": 0, console: 1, "scan-error": 1, skipped: 8, offscreen: 2, "clipped-text": 3, overlap: 4, spill: 5 };
const summary = [...groups.values()]
  .map((g) => ({ ...g, widths: [...g.widths], states: [...g.states] }))
  .sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || b.states.length * b.widths.length - a.states.length * a.widths.length);
const report = { base: BASE, generatedAt: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), totals: Object.fromEntries(Object.keys(rank).map((k) => [k, findings.filter((f) => f.kind === k).length])), summary, findings };
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(`[scan] ${findings.length} findings, ${summary.length} distinct → ${join(OUT, "report.json")}`);
for (const g of summary.slice(0, 40)) {
  console.log(`- ${g.kind.padEnd(12)} ${g.selector}\n    ${g.detail}${g.text ? ` — "${g.text.slice(0, 60)}"` : ""}\n    widths: ${g.widths.join(" ")} | states: ${g.states.slice(0, 6).join(", ")}${g.states.length > 6 ? ` (+${g.states.length - 6})` : ""}`);
}
