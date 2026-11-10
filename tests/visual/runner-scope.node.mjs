import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const playwrightCli = require.resolve("@playwright/test/cli");

function listTests(configPath, overrides = {}) {
  const env = { ...process.env, CI: "1", ...overrides };
  delete env.OMNIA_VISUAL_BASE_URL;
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [playwrightCli, "test", "--config", configPath, "--list", "--reporter=json"], {
    cwd: repositoryRoot,
    env,
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
}

test("default discovery cannot run retired fixture or external editor contracts against the rebuild", () => {
  const result = listTests("playwright.visual.config.ts");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.suites.map((suite) => suite.file), ["rebuild-renderer.spec.ts"]);
});

test("CI suite stops before the job deadline and does not create missing screenshot baselines", () => {
  const result = listTests("playwright.visual.config.ts");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(report.config.globalTimeout > 0, "A broken host must not consume the whole CI job");
  assert.ok(report.config.globalTimeout <= 15 * 60_000, "Leave time for the 20-minute job to upload evidence");
  assert.equal(report.config.updateSnapshots, "none");
});

test("historical discovery requires an explicit matching host", () => {
  const result = listTests("tests/visual/playwright.historical.config.ts");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /OMNIA_VISUAL_BASE_URL.*historical renderer\/fixture host/);
});

test("an explicit historical host selects every retained legacy spec and excludes current renderer claims", () => {
  const result = listTests("tests/visual/playwright.historical.config.ts", { OMNIA_VISUAL_BASE_URL: "http://127.0.0.1:4174" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.suites.map((suite) => suite.file).sort(), [
    "accessibility-matrix.spec.ts",
    "agent-shell-release.spec.ts",
    "full-window-workbenches.spec.ts",
    "shell-host-overflow.spec.ts",
    "visual-fixture-contract.spec.ts",
    "visual-regression.spec.ts",
  ]);
});
