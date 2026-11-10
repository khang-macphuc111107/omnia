import { chromium } from "@playwright/test";

const baseURL = process.env.OMNIA_HEADLESS_BASE_URL ?? "http://127.0.0.1:1420/";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
  reducedMotion: "reduce",
  serviceWorkers: "block",
});
const page = await context.newPage();

const snapshot = async (label) => {
  const value = await page.evaluate((name) => {
    const summary = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        overflowY: style.overflowY,
        position: style.position,
      };
    };
    return {
      label: name,
      viewport: { width: innerWidth, height: innerHeight },
      pageScroll: { x: scrollX, y: scrollY },
      app: summary(".app-shell"),
      root: summary("#root"),
      main: summary(".primary-workspace"),
      toolbar: summary(".conversation-toolbar"),
      timeline: summary(".conversation-timeline"),
      composer: summary(".composer-region"),
      inspector: summary("#context-inspector"),
      sidebar: summary(".object-sidebar"),
    };
  }, label);
  console.log(JSON.stringify(value));
  return value;
};

const click = async (locator, label) => {
  const target = page.locator(locator).first();
  if (!(await target.count()) || !(await target.isVisible().catch(() => false))) {
    console.log(JSON.stringify({ label, status: "missing" }));
    return false;
  }
  if (await target.isDisabled().catch(() => false)) {
    console.log(JSON.stringify({ label, status: "disabled" }));
    return false;
  }
  try {
    await target.click({ timeout: 5000 });
    await page.waitForTimeout(300);
    await snapshot(label);
    return true;
  } catch (error) {
    console.log(JSON.stringify({ label, status: "error", error: String(error) }));
    return false;
  }
};

try {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(800);
  await snapshot("initial");

  const railLabels = await page.locator(".activity-rail button[aria-label]").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label")).filter(Boolean),
  );
  for (const label of railLabels) {
    await click(`.activity-rail button[aria-label=${JSON.stringify(label)}]`, `rail:${label}`);
    if (label !== "Settings") continue;
    const tabs = await page.locator(".settings-nav button[role=tab]").evaluateAll((buttons) =>
      buttons.map((button) => ({ id: button.id, text: button.innerText.trim() })),
    );
    for (const tab of tabs) {
      await click(`[id=${JSON.stringify(tab.id)}]`, `settings:${tab.text}`);
    }
  }

  await click('.activity-rail button[aria-label="Chats"]', "return:Chats");
  const resizeHandle = page.locator(".object-sidebar__resize-handle");
  const handleBox = await resizeHandle.boundingBox();
  if (handleBox && (await resizeHandle.isVisible().catch(() => false))) {
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 40);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + 90, handleBox.y + 40, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    await snapshot("sidebar:resize");
  }

  await click("#sidebar-toggle", "sidebar:close");
  await click("#sidebar-toggle", "sidebar:open");
  await click(".conversation-row__actions", "chat:row-actions");
  await page.keyboard.press("Escape");
  await click('button[aria-label="Toggle inspector"]', "inspector:open");
  await click('button[aria-label="Toggle inspector"]', "inspector:close");
  await click('button[aria-label*="Open commands and navigation"]', "command-palette:open");
  await page.keyboard.press("Escape");

  for (const tab of ["Write", "Split", "Preview"]) {
    await click(`button[role=tab]:has-text(${JSON.stringify(tab)})`, `composer:${tab}`);
  }
  await click('button[role=tab]:has-text("Write")', "composer:Write:return");
  for (const label of ["More formatting", "Block insert studio", "Open mode controls", "Open or close advanced parameters"]) {
    await click(`button[aria-label=${JSON.stringify(label)}]`, `composer:${label}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
  }
  await snapshot("final");
} finally {
  await context.close();
  await browser.close();
}
