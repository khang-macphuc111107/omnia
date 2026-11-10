import { expect, test, type Page } from "@playwright/test";

const forbiddenChrome = /Cache Hit|28,410 tok|28\.4k cached|Cache 94%|154\.2 tok\/s|150\+ tok\/s|Harness: Custom|DFS: 4 Nodes|Local Cache Proxy|Anthropic\/OpenAI Cache Harness|9 Official Harnesses Ready|Verified: Math & Citations Pass|builtin_numeric_claim_verifier|ANTI-HALLUCINATION AUDIT|LOCAL SOVEREIGN AI|Patched VS Code|omnia\.code-workspace \(Multi-Root|Stealth: Turnstile Pass|Browser Use Ready|Isolated 2nd Input Ready|10x Human-Seek Pacing|HOST BROWSER PROFILE & COOKIE BRIDGE|ULTRA IDM\+ & CLOUD\/PDF GRABBER|Ask in \/btw|@all-3-tabs/i;

test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: "reduce" } });

async function expectSendInViewport(page: Page) {
  const send = page.getByRole("button", { name: /^Send(?: message)?$/ });
  await expect(send).toBeInViewport();
  const bounds = await send.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.height).toBe(28);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
}

async function expectCompactAiPanel(page: Page, panelTestId: string) {
  const panel = page.getByTestId(panelTestId);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("tab")).toHaveCount(0);
  await expect(panel.getByPlaceholder("Ask anything...", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  for (const title of ["New chat", "Chat history", "Attach files"]) {
    const control = panel.getByRole("button", { name: title, exact: true });
    await expect(control).toHaveAttribute("title", title);
    await expect(control.locator("svg")).toHaveCount(1);
    await expect(control.locator("svg")).toHaveCSS("stroke-width", "1.75px");
    const bounds = await control.boundingBox();
    expect(bounds?.width).toBe(28);
    expect(bounds?.height).toBe(28);
  }
  expect(await panel.innerText()).not.toMatch(forbiddenChrome);
}

async function expectFullViewport(page: Page, testId: string) {
  const viewport = page.viewportSize();
  const workbench = page.getByTestId(testId);
  await expect(workbench).toBeVisible();
  const shell = await page.locator(".app-shell--full-window-surface").boundingBox();
  const bounds = await workbench.boundingBox();
  expect(shell).toEqual({ x: 0, y: 0, width: viewport?.width, height: viewport?.height });
  expect(bounds).toEqual(shell);
  await expect(page.locator(".title-bar, .activity-rail, .object-sidebar, .context-inspector, .global-status-strip")).toHaveCount(0);
  await expect(page.getByTestId("workspace-mode-switcher")).toBeVisible();
}

test.describe("Real-runtime full-window workbenches", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("workspace-mode-tab-code")).toBeVisible();
  });

  test("embeds the available Microsoft VS Code host across the full-window IDE stage", async ({ page }, testInfo) => {
    await page.getByTestId("workspace-mode-tab-code").click();
    await expectFullViewport(page, "sovereign-ide-remote-workbench");
    const frame = page.getByTestId("real-vscode-workbench-iframe");
    await expect(frame).toHaveAttribute("src", /127\.0\.0\.1:1430\/\?workspace=.*omnia\.code-workspace/);
    await expect(frame).toBeVisible();
    // No synthetic VS Code fixture is installed here. The real local host must
    // supply its workbench before this additional runtime smoke can pass.
    await expect(page.frameLocator('[data-testid="real-vscode-workbench-iframe"]').locator(".monaco-workbench")).toBeVisible({ timeout: 60_000 });
    await expectCompactAiPanel(page, "ide-agy-ai-sidebar");
    const projects = page.getByTestId("ide-project-pills");
    await expect(projects.getByRole("button")).toHaveCount(4);
    const colors: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const pill = page.getByTestId(`ide-project-pill-${index}`);
      await expect(pill.locator("svg")).toHaveCount(1);
      colors.push(await pill.evaluate((node) => getComputedStyle(node).getPropertyValue("--project-accent").trim()));
    }
    expect(colors).toEqual(["#60a5fa", "#34d399", "#a78bfa"]);
    expect(await page.getByTestId("vscode-title-command-bar").innerText()).not.toMatch(forbiddenChrome);
    await page.screenshot({ path: testInfo.outputPath("ide-full-window.png") });
    await page.getByTestId("workspace-mode-tab-chat").click();
    await expect(page.locator(".title-bar")).toBeVisible();
  });

  test("opens a real everyday page with F12 closed and one clean independent AI panel", async ({ page }, testInfo) => {
    await page.getByTestId("workspace-mode-tab-browser").click();
    await expectFullViewport(page, "sovereign-browser-workbench");
    await expect(page.getByTestId("omnibox-input")).toHaveValue(/news\.ycombinator\.com/);
    await expect(page.getByTestId("toggle-devtools-btn")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("sovereign-f12-devtools-dock")).toHaveCount(0);
    await expectCompactAiPanel(page, "browser-ai-copilot-sidebar");
    const profile = page.getByRole("button", { name: "Browser profile (click to switch profile or import cookies)", exact: true });
    await expect(profile).toHaveAttribute("title", "Browser profile (click to switch profile or import cookies)");
    expect((await profile.innerText()).trim()).toBe("");
    await expect(page.getByTestId("omnibox-input").locator("..")).not.toContainText(/Stealth|Turnstile|Chrome Canary/);
    const frame = page.getByTestId("sovereign-live-iframe");
    await expect(frame).toHaveAttribute("sandbox", /allow-scripts/);
    expect(await frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    await expect(page.frameLocator('[data-testid="sovereign-live-iframe"]').getByRole("link", { name: "Hacker News", exact: true })).toBeVisible({ timeout: 45_000 });
    await page.screenshot({ path: testInfo.outputPath("browser-full-window.png") });
    await page.getByTestId("toggle-devtools-btn").click();
    await expect(page.getByTestId("sovereign-f12-devtools-dock")).toBeVisible();
    await page.getByTestId("toggle-devtools-btn").click();
    await page.getByTestId("toggle-browser-ai-sidebar-btn").click();
    await expect(page.getByTestId("browser-ai-copilot-sidebar")).toHaveCount(0);
    await expectFullViewport(page, "sovereign-browser-workbench");
  });

  test("Images 3–9 and 20 retain the 42px rail, 248px chats sidebar and unencumbered Chat canvas", async ({ page }, testInfo) => {
    const rail = page.locator(".activity-rail");
    const sidebar = page.locator(".object-sidebar");
    await expect(rail).toBeVisible();
    await expect(sidebar).toBeVisible();
    expect((await rail.boundingBox())?.width).toBe(42);
    expect((await sidebar.boundingBox())?.width).toBe(248);
    await expectSendInViewport(page);
    await expect(page.locator(".context-inspector, .global-status-strip")).toHaveCount(0);
    const titlebar = page.locator(".title-bar");
    await expect(titlebar.getByTestId("workspace-mode-switcher")).toBeVisible();
    await expect(titlebar).not.toContainText(/omnia:\/\/sessions\//);
    expect(await page.locator(".app-shell").innerText()).not.toMatch(forbiddenChrome);
    await expect(sidebar.getByPlaceholder("Search chats...", { exact: true })).toBeVisible();
    for (const button of await rail.locator(".rail-button").all()) {
      await expect(button).toHaveAttribute("title", /.+/);
      await expect(button).toHaveAttribute("aria-label", /.+/);
      expect((await button.innerText()).trim()).toBe("");
    }
    await page.screenshot({ path: testInfo.outputPath("chat-clean-canvas.png") });
  });

  test("Images 11–13 provide keyboard slash selection without accidentally sending", async ({ page }) => {
    for (const mode of ["chat", "code", "browser"]) {
      await page.getByTestId(`workspace-mode-tab-${mode}`).click();
      const input = page.getByPlaceholder("Ask anything...", { exact: true });
      await input.fill("/");
      const commands = page.getByRole("listbox", { name: /commands/i });
      await expect(commands).toBeVisible();
      await expect(commands.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
      await input.press("ArrowDown");
      await expect(commands.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
      await input.press("Tab");
      await expect(commands).toHaveCount(0);
      await expect(input).toHaveValue("```typescript\n\n```");
      await input.fill("/");
      await expect(commands).toBeVisible();
      await input.press("Escape");
      await expect(commands).toHaveCount(0);
      await expect(input).toHaveValue("/");
      await expect(page.getByRole("button", { name: /^Send(?: message)?$/ })).toBeVisible();
      expect(await page.locator(".app-shell").innerText()).not.toMatch(forbiddenChrome);
    }
  });

  test("retains the full viewport and mode escape route at the supported compact desktop size", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await expectSendInViewport(page);
    await page.getByTestId("workspace-mode-tab-browser").click();
    await expectFullViewport(page, "sovereign-browser-workbench");
    await expectSendInViewport(page);
    await expect(page.getByTestId("workspace-mode-tab-chat")).toBeInViewport();
    await expect(page.getByTestId("toggle-browser-ai-sidebar-btn")).toBeInViewport();
    await page.getByTestId("workspace-mode-tab-code").click();
    await expectFullViewport(page, "sovereign-ide-remote-workbench");
    await expectSendInViewport(page);
    await expect(page.getByTestId("workspace-mode-tab-chat")).toBeInViewport();
  });
});
