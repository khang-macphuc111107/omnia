import { defineConfig, devices } from "@playwright/test";

const visualPort = Number.parseInt(process.env.OMNIA_VISUAL_PORT ?? "4173", 10);
const visualBaseUrl = process.env.OMNIA_VISUAL_BASE_URL ?? `http://127.0.0.1:${visualPort}`;
const updateSnapshots = process.env.OMNIA_VISUAL_UPDATE === "1" ? "all" : "none";

export default defineConfig({
  testDir: "./tests/visual",
  // The application entrypoint now owns the original src/rebuild renderer.
  // Historical fixture/AgentShell contracts require their matching archived
  // host and remain available through tests/visual/playwright.historical.config.ts.
  testMatch: "rebuild-renderer.spec.ts",
  outputDir: "artifacts/visual/test-results",
  snapshotDir: "./tests/visual/__screenshots__",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  // Multi-state renderer contracts retain a bounded budget on Windows hosts.
  // Individual actions and assertions still fail within 10 seconds.
  timeout: 120_000,
  // Stop inside Playwright so CI can upload its report before the 20-minute
  // job limit terminates the process. This is a suite bound, not a retry policy.
  globalTimeout: 10 * 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      maxDiffPixelRatio: 0.003,
      threshold: 0.2,
    },
  },
  reporter: process.env.CI
    ? [
        ["line"],
        ["html", { outputFolder: "artifacts/visual/report", open: "never" }],
        ["junit", { outputFile: "artifacts/visual/junit.xml" }],
      ]
    : [
        ["list"],
        ["html", { outputFolder: "artifacts/visual/report", open: "never" }],
      ],
  quiet: false,
  updateSnapshots,
  use: {
    baseURL: visualBaseUrl,
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "Asia/Ho_Chi_Minh",
    serviceWorkers: "block",
    // The Windows development image may inject an installed content-filter
    // extension (for example AdGuard) into headless Chromium. CI runners have
    // no extensions, and the renderer contract must observe only app traffic,
    // so disable extension loading for deterministic local and CI runs.
    launchOptions: {
      args: ["--disable-extensions"],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  webServer: process.env.OMNIA_VISUAL_BASE_URL
    ? undefined
    : {
        // Build once and serve immutable assets. The renderer imports its
        // workspace graph; running it against Vite's transform-on-demand dev
        // server can spend minutes compiling the same graph per worker on
        // Windows. Preview keeps page.goto deterministic and bounded.
        command: `npm run build:renderer && npm run preview -- --host 127.0.0.1 --port ${visualPort} --strictPort`,
        url: visualBaseUrl,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
      },
  snapshotPathTemplate: "{snapshotDir}/{testFilePath}/{arg}-{projectName}-{platform}{ext}",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
