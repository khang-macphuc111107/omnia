import { chromium } from "@playwright/test";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto("http://127.0.0.1:1420/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(700);
console.log((await page.locator("body").innerText()).slice(0, 1000));
console.log("message-count", await page.locator('[aria-label="Message Omnia"]').count());
console.log("conversation", await page.locator("[class*=conversation-pane]").evaluateAll((elements) => elements.map((element) => {
  const r = element.getBoundingClientRect();
  return { className: element.className, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
})));
console.log("composer", await page.locator("[class*=composer]").evaluateAll((elements) => elements.slice(0, 30).map((element) => {
  const r = element.getBoundingClientRect();
  return { className: element.className, tag: element.tagName, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
})));
await browser.close();
