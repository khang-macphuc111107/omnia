import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

/**
 * Safe, isolated interaction sweep for the renderer preview.
 *
 * This intentionally uses a new headless Playwright context and synthetic page
 * input only. It never attaches to the user's browser/profile and never sends
 * OS-level mouse or keyboard events. The existing audit remains the source of
 * truth for broad layout metrics; this script records per-control interactions
 * and focused Library workbench evidence.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseURL = process.env.OMNIA_HEADLESS_BASE_URL ?? "http://127.0.0.1:1420/";
const stamp = process.env.OMNIA_INTERACTIVE_SWEEP_STAMP ?? new Date().toISOString().slice(0, 10);
const outputDir = path.resolve(
  projectRoot,
  process.env.OMNIA_INTERACTIVE_OUTPUT_DIR ?? `artifacts/headless-interactive-${stamp}`,
);
const desktopViewport = { width: 1440, height: 900 };
const narrowViewport = { width: 390, height: 844 };
const interactionTimeoutMs = Math.max(750, Number(process.env.OMNIA_INTERACTION_TIMEOUT_MS ?? 6_000));
const popupTimeoutMs = Math.max(40, Number(process.env.OMNIA_POPUP_TIMEOUT_MS ?? 120));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeName = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "surface";
const textOf = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 180);

function isDestructive(label) {
  return /\b(delete|remove|clear all|reset all|revoke|destroy|discard|overwrite|wipe|purge)\b/i.test(label);
}

function isExternalOrDownload(label, href = "") {
  return /\b(download|export|open in|external|github|http|https)\b/i.test(`${label} ${href}`);
}

function isSafeNeutralAction(label) {
  return /\b(copy|clipboard|download|export|refresh|retry|close|dismiss|cancel|back|undo|redo)\b/i.test(label);
}

function classifyControl(control) {
  const label = textOf(control.label || control.text || control.name || control.id);
  if (!control.visible) return "not-visible";
  if (control.disabled) return "disabled";
  if (control.tag === "input" && control.type === "file") return "file-picker-fixture-required";
  if (isDestructive(label)) return "destructive-skipped";
  if (isExternalOrDownload(label, control.href)) return "external-or-download-skipped";
  return null;
}

async function settle(page, ms = 240) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(ms);
}

async function installListeners(page) {
  const events = { console: [], pageErrors: [], requestFailures: [], downloads: [], popups: [] };
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") events.console.push({ type: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => events.pageErrors.push(error.message));
  page.on("requestfailed", (request) => events.requestFailures.push({ url: request.url(), error: request.failure()?.errorText ?? "unknown" }));
  page.on("download", (download) => events.downloads.push({ suggestedFilename: download.suggestedFilename(), url: download.url() }));
  page.on("popup", (popup) => events.popups.push(popup.url()));
  return events;
}

async function inventory(page, rootSelector = null) {
  return page.evaluate((scopeSelector) => {
    const scope = scopeSelector ? document.querySelector(scopeSelector) : document;
    if (!scope) return [];
    const selectors = [
      "button",
      "input",
      "textarea",
      "select",
      "a[href]",
      "details",
      "summary",
      "[role=button]",
      "[role=tab]",
      "[role=menuitem]",
      "[role=option]",
      "[role=slider]",
      "[role=separator]",
      "[draggable=true]",
      ".object-sidebar__resize-handle",
    ];
    const seen = new Set();
    const elements = [...scope.querySelectorAll(selectors.join(","))].filter((element) => {
      if (seen.has(element)) return false;
      seen.add(element);
      return true;
    });
    const selectorOf = (element) => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const classes = [...element.classList].filter(Boolean).slice(0, 3).map((name) => `.${CSS.escape(name)}`).join("");
      return `${element.tagName.toLowerCase()}${classes}`;
    };
    const labelOf = (element) => {
      const aria = element.getAttribute("aria-label");
      if (aria) return aria;
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) return labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      const associated = element.labels?.[0]?.textContent;
      return associated || element.getAttribute("title") || element.getAttribute("name") || element.textContent || element.getAttribute("placeholder") || "";
    };
    return elements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const tag = element.tagName.toLowerCase();
      const type = element.getAttribute("type") || "";
      const visible = Boolean(rect.width && rect.height && style.display !== "none" && style.visibility !== "hidden");
      const label = labelOf(element).replace(/\s+/g, " ").trim().slice(0, 180);
      const id = `headless-interactive-${index}`;
      element.setAttribute("data-headless-interactive-id", id);
      return {
        index,
        id,
        selector: selectorOf(element),
        tag,
        type,
        role: element.getAttribute("role") || (tag === "button" ? "button" : null),
        label,
        text: (element.innerText || element.value || "").replace(/\s+/g, " ").trim().slice(0, 180),
        href: element.getAttribute("href") || "",
        visible,
        disabled: element.matches(":disabled,[aria-disabled=true]"),
        checked: "checked" in element ? Boolean(element.checked) : null,
        selected: element.getAttribute("aria-selected"),
        pressed: element.getAttribute("aria-pressed"),
        expanded: element.getAttribute("aria-expanded"),
        open: tag === "details" ? Boolean(element.open) : null,
        value: "value" in element ? String(element.value ?? "") : null,
        options: tag === "select" ? [...element.options].map((option) => ({ value: option.value, label: option.textContent?.trim() || "", disabled: option.disabled })) : [],
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
        hasTitle: Boolean(element.getAttribute("title")),
      };
    });
  }, rootSelector);
}

async function snapshotTarget(page, id) {
  return page.locator(`[data-headless-interactive-id=${JSON.stringify(id)}]`).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      text: (element.innerText || element.value || "").replace(/\s+/g, " ").trim().slice(0, 180),
      value: "value" in element ? String(element.value ?? "") : null,
      checked: "checked" in element ? Boolean(element.checked) : null,
      selected: element.getAttribute("aria-selected"),
      pressed: element.getAttribute("aria-pressed"),
      expanded: element.getAttribute("aria-expanded"),
      open: element.tagName.toLowerCase() === "details" ? Boolean(element.open) : null,
      visible: Boolean(rect.width && rect.height && getComputedStyle(element).display !== "none"),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
    };
  }).catch(() => null);
}

async function visibleOverlays(page) {
  return page.evaluate(() => [...document.querySelectorAll("[role=dialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper],.popover,.menu,.modal,.modal-scrim")]
    .filter((element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"; })
    .map((element) => ({ role: element.getAttribute("role"), text: (element.innerText || "").replace(/\s+/g, " ").trim().slice(0, 180) })));
}

async function safeScreenshot(page, filePath, selector = null) {
  try {
    if (selector) {
      const target = page.locator(selector).first();
      if (await target.isVisible().catch(() => false)) {
        await target.screenshot({ path: filePath, animations: "disabled" });
        return true;
      }
    }
    await page.screenshot({ path: filePath, fullPage: true, animations: "disabled" });
    return true;
  } catch {
    return false;
  }
}

async function openActivity(page, label) {
  if (label === "Chats") return;
  const rail = page.locator(`.activity-rail button[aria-label=${JSON.stringify(label)}]`).first();
  if (!(await rail.count()) || !(await rail.isVisible().catch(() => false))) throw new Error(`Activity rail button not found: ${label}`);
  await rail.click({ timeout: 4_000 });
  await settle(page, 400);
}

async function openFreshPage(browser, viewport, activityLabel) {
  const context = await browser.newContext({
    viewport,
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "Asia/Ho_Chi_Minh",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const events = await installListeners(page);
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ timeout: 30_000 });
  await settle(page, 700);
  await openActivity(page, activityLabel);
  return { context, page, events };
}

async function restoreOverlay(page) {
  // Lazy overlays (notably the command palette) briefly mount a loading
  // scrim before their ModalSurface is ready.  An Escape sent during that
  // window is intentionally ignored by the fallback, which used to leave a
  // scrim mounted and contaminate the next control interaction.  Wait for
  // the lazy surface to settle, then dismiss the topmost modal repeatedly.
  const loadingScrim = page.locator(".command-scrim--loading").first();
  if (await loadingScrim.count() && await loadingScrim.isVisible().catch(() => false)) {
    await loadingScrim.waitFor({ state: "detached", timeout: 2_500 }).catch(() => {});
  }
  // A keyboard-shortcuts dialog is lazy-loaded with a null Suspense fallback,
  // so there is no loading marker to await.  Give React's import/update queue
  // one bounded grace window before deciding that the page is clean.
  await sleep(220);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const overlays = await visibleOverlays(page);
    if (overlays.length === 0) return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 100);
  }

  // A few renderer-only fallback surfaces are presentation scrims without a
  // keydown listener.  If one is still visible after the normal modal escape
  // path, click its empty corner so a ModalSurface can handle its scrim
  // dismissal.  This remains a synthetic page action inside the isolated
  // context; it never targets the user's desktop window.
  const scrim = page.locator(".modal-scrim").last();
  if (await scrim.count() && await scrim.isVisible().catch(() => false)) {
    await scrim.click({ position: { x: 2, y: 2 }, timeout: 1_000 }).catch(() => {});
    await settle(page, 120);
  }
}

async function interactTarget(page, control, interactions) {
  const skipReason = classifyControl(control);
  if (skipReason) {
    interactions.push({ id: control.id, kind: control.role || control.tag, label: control.label, status: "skipped", reason: skipReason });
    return;
  }
  const locator = page.locator(`[data-headless-interactive-id=${JSON.stringify(control.id)}]`).first();
  if (!(await locator.count()) || !(await locator.isVisible().catch(() => false))) {
    interactions.push({ id: control.id, kind: control.role || control.tag, label: control.label, status: "not-found" });
    return;
  }
  // Every control starts from a clean overlay state.  This is deliberately
  // done before the action as well as in finally: a prior lazy modal can finish
  // mounting after its previous interaction returned.
  await restoreOverlay(page);
  if (!(await locator.isVisible().catch(() => false))) {
    interactions.push({ id: control.id, kind: control.role || control.tag, label: control.label, status: "not-found-after-overlay-cleanup" });
    return;
  }
  const before = await snapshotTarget(page, control.id);
  const beforeOverlays = await visibleOverlays(page);
  const action = {
    id: control.id,
    kind: control.role || control.tag,
    type: control.type,
    label: control.label,
    before,
    beforeOverlays,
  };
  try {
    if (control.tag === "select") {
      const option = control.options.find((item) => !item.disabled && item.value !== control.value);
      if (!option) {
        action.status = "no-alternate-option";
      } else {
        await locator.selectOption(option.value, { timeout: 3_500 });
        await settle(page, 180);
        action.status = "changed";
        action.selectedOption = option;
      }
    } else if (control.tag === "input" && ["checkbox", "radio"].includes(control.type)) {
      if (control.type === "checkbox") await locator.setChecked(!control.checked, { timeout: 3_500 });
      else await locator.check({ timeout: 3_500 });
      await settle(page, 160);
      action.status = "changed";
    } else if (control.tag === "input" && control.type === "range" || control.role === "slider") {
      await locator.evaluate((element) => {
        if (element instanceof HTMLInputElement) {
          const min = Number(element.min || 0); const max = Number(element.max || 100);
          element.value = String(min + (max - min) / 2);
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      await settle(page, 160);
      action.status = "changed";
    } else if (control.tag === "input" || control.tag === "textarea") {
      if (control.type === "password") {
        action.status = "skipped";
        action.reason = "password-field-not-filled";
      } else {
        const probe = "omnia-headless-probe";
        await locator.fill(probe, { timeout: 3_500 });
        await settle(page, 120);
        action.status = "changed";
        action.probe = probe;
        await locator.fill(control.value ?? "", { timeout: 3_500 }).catch(() => {});
      }
    } else if (control.tag === "details") {
      await locator.locator("summary").click({ timeout: 3_500 });
      await settle(page, 120);
      action.status = "toggled";
      action.openAfterToggle = await snapshotTarget(page, control.id);
      await locator.locator("summary").click({ timeout: 3_500 }).catch(() => {});
    } else if (control.role === "separator" || control.selector.includes("resize-handle")) {
      const box = await locator.boundingBox();
      if (!box) {
        action.status = "no-box";
      } else {
        await page.mouse.move(box.x + Math.max(1, box.width / 2), box.y + Math.max(1, box.height / 2));
        await page.mouse.down();
        await page.mouse.move(box.x + 40, box.y + Math.max(1, box.height / 2), { steps: 3 });
        await page.mouse.up();
        await settle(page, 180);
        action.status = "dragged";
      }
    } else if (control.tag === "a") {
      await locator.click({ timeout: 3_500 });
      await settle(page, 180);
      action.status = "clicked";
    } else {
      const targetHref = page.waitForEvent("popup", { timeout: popupTimeoutMs }).catch(() => null);
      await locator.click({ timeout: 3_500 });
      const popup = await targetHref;
      await settle(page, 180);
      action.status = "clicked";
      action.popup = popup ? popup.url() : null;
    }
    action.after = await snapshotTarget(page, control.id);
    action.afterOverlays = await visibleOverlays(page);
    action.changed = JSON.stringify({ target: action.before, overlays: action.beforeOverlays }) !== JSON.stringify({ target: action.after, overlays: action.afterOverlays });
    action.focused = await page.evaluate(() => document.activeElement?.getAttribute("data-headless-interactive-id") ?? document.activeElement?.tagName?.toLowerCase() ?? null);
  } catch (error) {
    action.status = "error";
    action.error = error instanceof Error ? error.message : String(error);
  } finally {
    await restoreOverlay(page);
  }
  interactions.push(action);
}

async function sweepActivity(browser, activityLabel, viewport = desktopViewport) {
  const { context, page, events } = await openFreshPage(browser, viewport, activityLabel);
  const controls = await inventory(page);
  const interactions = [];
  const surfaceName = `${viewport.width}x${viewport.height}-${activityLabel}`;
  const screenshotPath = path.join(outputDir, `${safeName(surfaceName)}.png`);
  await safeScreenshot(page, screenshotPath);
  for (const control of controls) {
    await interactTarget(page, control, interactions);
  }
  const afterInventory = await inventory(page);
  const summary = {
    activity: activityLabel,
    viewport,
    controls: controls.length,
    visibleControls: controls.filter((control) => control.visible).length,
    attempted: interactions.filter((item) => !["skipped", "not-found"].includes(item.status)).length,
    changed: interactions.filter((item) => item.changed || ["changed", "toggled", "dragged"].includes(item.status)).length,
    clicked: interactions.filter((item) => item.status === "clicked").length,
    errors: interactions.filter((item) => item.status === "error").length,
    skipped: interactions.filter((item) => item.status === "skipped").length,
    afterControls: afterInventory.length,
    screenshot: screenshotPath,
  };
  await context.close();
  return { summary, controls, interactions, events };
}

async function sweepLibraryWorkbenches(browser) {
  const pickerSession = await openFreshPage(browser, desktopViewport, "Library");
  const { context: pickerContext, page: pickerPage, events: pickerEvents } = pickerSession;
  const select = pickerPage.locator("#library-workbench-select");
  let pickerReady = false;
  let pickerError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await select.waitFor({ state: "visible", timeout: 5_000 });
      pickerReady = true;
      break;
    } catch (error) {
      pickerError = error instanceof Error ? error.message : String(error);
      await openActivity(pickerPage, "Library").catch(() => {});
      await settle(pickerPage, 500);
    }
  }
  if (!pickerReady) {
    const unavailable = {
      status: "unavailable",
      reason: `Library workbench picker did not mount after 3 isolated attempts: ${pickerError ?? "unknown error"}`,
    };
    const screenshot = path.join(outputDir, "library-unavailable.png");
    await safeScreenshot(pickerPage, screenshot);
    await pickerContext.close();
    return { workbenches: [], unavailable, events: pickerEvents };
  }
  const options = await select.locator("option").evaluateAll((items) => items.map((item) => ({ value: item.value, label: item.textContent?.trim() || "" })));
  await pickerContext.close();

  const workbenches = [];
  const maxControls = Math.max(1, Number(process.env.OMNIA_LIBRARY_MAX_CONTROLS ?? 24));
  const onlyWorkbenches = new Set(
    String(process.env.OMNIA_LIBRARY_ONLY ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const selectedOptions = onlyWorkbenches.size ? options.filter((option) => onlyWorkbenches.has(option.value)) : options;
  for (const option of selectedOptions) {
    const { context, page, events } = await openFreshPage(browser, desktopViewport, "Library");
    const record = {
      id: option.value,
      label: option.label,
      status: "ok",
      panelVisible: false,
      controls: 0,
      attempted: 0,
      changed: 0,
      errors: 0,
      skipped: 0,
      screenshot: null,
      panelScreenshot: null,
      interactions: [],
      events,
    };
    try {
      const workbenchSelect = page.locator("#library-workbench-select");
      await workbenchSelect.waitFor({ state: "visible", timeout: 5_000 });
      await workbenchSelect.selectOption(option.value, { timeout: 5_000 });
      await settle(page, 900);
      const panel = page.locator("#library-workbench-panel");
      record.panelVisible = await panel.isVisible().catch(() => false);
      const surfaceName = `library-${option.value}`;
      record.screenshot = path.join(outputDir, `${safeName(surfaceName)}.png`);
      record.panelScreenshot = path.join(outputDir, `${safeName(surfaceName)}--panel.png`);
      await safeScreenshot(page, record.screenshot);
      await safeScreenshot(page, record.panelScreenshot, "#library-workbench-panel");
      const controls = record.panelVisible ? await inventory(page, "#library-workbench-panel") : [];
      record.controls = controls.length;
      const candidates = controls.filter((item) => item.visible && !item.selector.includes("activity-rail"));
      for (const [index, control] of candidates.entries()) {
        if (index >= maxControls) {
          record.interactions.push({ id: control.id, kind: control.role || control.tag, label: control.label, status: "skipped", reason: `library-control-budget-${maxControls}` });
          continue;
        }
        try {
          // `interactTarget` already uses bounded Playwright action timeouts.
          // Do not race it against a second timer: closing the context while
          // an in-flight click is still settling produces a false
          // "Target page ... closed" error and hides the real control result.
          const interaction = interactTarget(page, control, record.interactions);
          // Some preview controls intentionally model long-running work. Keep
          // the audit bounded for classification, but always let the action
          // settle before closing its isolated context. Closing a context
          // while Playwright is still inside locator.click() creates a false
          // secondary "Target page, context or browser has been closed"
          // error, which obscures the real control result.
          let timedOut = false;
          await Promise.race([
            interaction,
            sleep(interactionTimeoutMs).then(() => { timedOut = true; }),
          ]);
          if (timedOut) {
            await interaction;
            const settled = record.interactions.at(-1);
            if (settled && settled.id === control.id) {
              settled.status = "partial-timeboxed";
              settled.reason = `interaction-budget-${interactionTimeoutMs}ms`;
              settled.timedOut = true;
              settled.underlyingStatus = settled.error ? "error" : "settled";
            } else {
              record.interactions.push({
                id: control.id,
                kind: control.role || control.tag,
                label: control.label,
                status: "partial-timeboxed",
                reason: `interaction-budget-${interactionTimeoutMs}ms`,
                timedOut: true,
              });
            }
            record.status = "partial-timeboxed";
            break;
          }
        } catch (error) {
          record.interactions.push({ id: control.id, kind: control.role || control.tag, label: control.label, status: "error", error: error instanceof Error ? error.message : String(error) });
          record.status = error instanceof Error && error.message.startsWith("interaction-timeout-") ? "partial-timeboxed" : "partial-error";
          break;
        }
      }
      record.attempted = record.interactions.filter((item) => !["skipped", "not-found"].includes(item.status)).length;
      record.changed = record.interactions.filter((item) => item.changed || ["changed", "toggled", "dragged"].includes(item.status)).length;
      record.errors = record.interactions.filter((item) => item.status === "error").length;
      record.skipped = record.interactions.filter((item) => item.status === "skipped").length;
    } catch (error) {
      record.status = "unavailable";
      record.reason = error instanceof Error ? error.message : String(error);
    } finally {
      await context.close();
    }
    workbenches.push(record);
  }
  return { workbenches, events: pickerEvents };
}

async function runNavigationMatrix(browser) {
  const { context, page, events } = await openFreshPage(browser, desktopViewport, "Chats");
  const labels = await page.locator(".activity-rail button[aria-label]").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")).filter(Boolean));
  const matrix = [];
  for (const label of labels) {
    const button = page.locator(`.activity-rail button[aria-label=${JSON.stringify(label)}]`).first();
    const before = await page.locator(".primary-workspace").evaluate((element) => ({ className: element.className, text: (element.innerText || "").slice(0, 120) })).catch(() => null);
    try {
      await button.click({ timeout: 4_000 });
      await settle(page, 420);
      const after = await page.locator(".primary-workspace").evaluate((element) => ({ className: element.className, text: (element.innerText || "").slice(0, 120) })).catch(() => null);
      matrix.push({ label, status: "clicked", before, after, changed: JSON.stringify(before) !== JSON.stringify(after) });
    } catch (error) {
      matrix.push({ label, status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }
  await context.close();
  return { matrix, events };
}

async function narrowReachability(browser) {
  const surfaces = [];
  for (const activity of ["Chats", "Library", "Settings"]) {
    const { context, page, events } = await openFreshPage(browser, narrowViewport, activity);
    const controls = await inventory(page);
    const overflow = await page.evaluate(() => ({
      document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      visiblePartials: [...document.querySelectorAll("button,input,textarea,select,[role=tab]")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { label: element.getAttribute("aria-label") || element.textContent?.trim() || element.getAttribute("placeholder") || "", left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      }).filter((item) => item.width > 0 && item.height > 0 && item.right > 0 && item.bottom > 0 && (item.left < 0 || item.right > innerWidth || item.top < 0 || item.bottom > innerHeight)),
    }));
    const screenshot = path.join(outputDir, `${safeName(`narrow-${activity}`)}.png`);
    await safeScreenshot(page, screenshot);
    surfaces.push({ activity, controls: controls.length, visibleControls: controls.filter((control) => control.visible).length, overflow, screenshot, events });
    await context.close();
  }
  return surfaces;
}

function summarize(activities, library, navigation, narrow) {
  const allInteractions = activities.flatMap((item) => item.interactions);
  const libraryInteractions = library.workbenches.flatMap((item) => item.interactions);
  const allErrors = [
    ...allInteractions.filter((item) => item.status === "error").map((item) => ({ scope: "activity", ...item })),
    ...libraryInteractions.filter((item) => item.status === "error").map((item) => ({ scope: "library", ...item })),
  ];
  return {
    generatedAt: new Date().toISOString(),
    baseURL,
    isolatedHeadless: true,
    activities: activities.length,
    workbenches: library.workbenches.length,
    controlsInventoried: activities.reduce((sum, item) => sum + item.summary.controls, 0) + library.workbenches.reduce((sum, item) => sum + item.controls, 0),
    interactionsAttempted: allInteractions.filter((item) => !["skipped", "not-found"].includes(item.status)).length + libraryInteractions.filter((item) => !["skipped", "not-found"].includes(item.status)).length,
    stateChanges: allInteractions.filter((item) => item.changed || ["changed", "toggled", "dragged"].includes(item.status)).length + libraryInteractions.filter((item) => item.changed || ["changed", "toggled", "dragged"].includes(item.status)).length,
    interactionErrors: allErrors.length,
    skippedSafety: allInteractions.filter((item) => item.status === "skipped").length + libraryInteractions.filter((item) => item.status === "skipped").length,
    navigationErrors: navigation.matrix.filter((item) => item.status === "error").length,
    narrowHorizontalOverflow: narrow.filter((item) => item.overflow.horizontalOverflow).map((item) => item.activity),
    libraryUnavailable: library.unavailable ?? null,
    errors: allErrors.slice(0, 100),
  };
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const navigation = process.env.OMNIA_SKIP_NAVIGATION === "1" ? { matrix: [], events: { console: [], pageErrors: [], requestFailures: [] } } : await runNavigationMatrix(browser);
    const allActivityLabels = ["Home", "Chats", "Projects", "Background work", "Memory", "Skills", "Settings"];
    const requestedActivities = new Set(String(process.env.OMNIA_ACTIVITY_ONLY ?? "").split(",").map((value) => value.trim()).filter(Boolean));
    const activityLabels = process.env.OMNIA_SKIP_ACTIVITIES === "1"
      ? []
      : requestedActivities.size ? allActivityLabels.filter((label) => requestedActivities.has(label)) : allActivityLabels;
    const activities = [];
    for (const label of activityLabels) {
      process.stderr.write(`[headless-sweep] activity ${label}\n`);
      activities.push(await sweepActivity(browser, label));
    }
    const library = process.env.OMNIA_SKIP_LIBRARY === "1"
      ? { workbenches: [], unavailable: { status: "skipped", reason: "OMNIA_SKIP_LIBRARY=1" }, events: { console: [], pageErrors: [], requestFailures: [] } }
      : await sweepLibraryWorkbenches(browser);
    process.stderr.write(`[headless-sweep] library ${library.workbenches.length} workbenches\n`);
    const narrow = process.env.OMNIA_SKIP_NARROW === "1" ? [] : await narrowReachability(browser);
    const summary = summarize(activities, library, navigation, narrow);
    const report = { summary, navigation, activities, library, narrow };
    await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
    const markdown = [
      "# Omnia headless interactive sweep",
      "",
      `- Generated: ${summary.generatedAt}`,
      `- Base URL: ${summary.baseURL}`,
      `- Isolated headless context: ${summary.isolatedHeadless}`,
      `- Activity surfaces: ${summary.activities}`,
      `- Library workbenches: ${summary.workbenches}`,
      `- Library picker unavailable: ${summary.libraryUnavailable ? summary.libraryUnavailable.reason : "no"}`,
      `- Controls inventoried: ${summary.controlsInventoried}`,
      `- Interaction attempts: ${summary.interactionsAttempted}`,
      `- Observed state changes: ${summary.stateChanges}`,
      `- Interaction errors: ${summary.interactionErrors}`,
      `- Safety skips (destructive/external/file/password/disabled): ${summary.skippedSafety}`,
      `- Navigation errors: ${summary.navigationErrors}`,
      `- Narrow horizontal-overflow surfaces: ${summary.narrowHorizontalOverflow.join(", ") || "none observed"}`,
      "",
      "## Activity matrix",
      "",
      ...activities.map((item) => `- ${item.summary.activity}: ${item.summary.controls} controls, ${item.summary.attempted} attempts, ${item.summary.changed} state changes, ${item.summary.errors} errors`),
      "",
      "## Library workbenches",
      "",
      ...library.workbenches.map((item) => `- ${item.id}: ${item.controls} controls, ${item.attempted} attempts, ${item.changed} state changes, ${item.errors} errors`),
      "",
      "## Boundaries",
      "",
      "- Actions that delete, revoke, reset, overwrite, open external URLs, download/export, or require a file/password fixture are recorded as safety skips; the sweep does not mutate durable data.",
      "- `state change` means a visible DOM/value/overlay/focus change was observed. Copy/download and idempotent buttons can be functional without changing the DOM; those are retained as clicked/neutral evidence rather than called failures.",
      "- Renderer preview evidence does not prove native/Tauri command wiring or provider availability.",
      "",
      "## Evidence",
      "",
      "Screenshots, focused Library panel captures, per-control interaction records, and narrow reachability data are beside this report in the same directory.",
    ].join("\n");
    await fs.writeFile(path.join(outputDir, "report.md"), markdown, "utf8");
    process.stdout.write(JSON.stringify({ outputDir, summary }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
  process.exitCode = 1;
});
