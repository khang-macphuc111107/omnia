import { chromium } from "@playwright/test";
const b = await chromium.launch({ headless: true }); const c = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await c.newPage();
await p.goto("http://127.0.0.1:1420/", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(500);
console.log((await p.locator("head").innerHTML()).slice(0, 5000));
await b.close();
