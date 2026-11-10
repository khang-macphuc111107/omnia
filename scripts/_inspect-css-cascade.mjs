import { chromium } from "@playwright/test";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto("http://127.0.0.1:1420/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(700);
const result = await page.locator(".composer-region").evaluate((element) => {
  const computed = getComputedStyle(element);
  const rules = [];
  for (const sheet of document.styleSheets) {
    let cssRules;
    try { cssRules = [...sheet.cssRules]; } catch { continue; }
    const walk = (items, parent = "") => {
      for (const rule of items) {
        if (rule.cssRules) { walk([...rule.cssRules], `${parent}${rule.conditionText ? `${rule.conditionText} ` : ""}`); continue; }
        if (rule.selectorText?.includes("composer-region") && element.matches(rule.selectorText)) rules.push({ href: sheet.href, selector: `${parent}${rule.selectorText}`, cssText: rule.cssText });
      }
    };
    walk(cssRules);
  }
  const allComposerRules = [];
  for (const sheet of document.styleSheets) {
    let cssRules;
    try { cssRules = [...sheet.cssRules]; } catch { continue; }
    const collect = (items, parent = "") => {
      for (const rule of items) {
        if (rule.cssRules) { collect([...rule.cssRules], `${parent}${rule.conditionText ? `${rule.conditionText} ` : ""}`); continue; }
        if (rule.cssText?.includes("composer-region")) allComposerRules.push({ selector: `${parent}${rule.selectorText ?? ""}`, cssText: rule.cssText });
      }
    };
    collect(cssRules);
  }
  return { className: element.className, computedFlex: computed.flex, computedMaxHeight: computed.maxHeight, rules, allComposerRules, sheets: [...document.styleSheets].map((sheet) => ({ href: sheet.href, count: sheet.cssRules?.length ?? -1 })) };
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
