import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function testSources(directory) {
  const sources = [];
  for (const entry of fs.readdirSync(path.join(repoRoot, directory), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) sources.push(...testSources(relative));
    else if (testFilePattern.test(entry.name)) {
      sources.push({ path: relative, source: fs.readFileSync(path.join(repoRoot, relative), "utf8") });
    }
  }
  return sources;
}

const ownedSources = ["src", "scripts", "tests"].flatMap(testSources);
const listing = spawnSync(process.execPath, [
  path.join(repoRoot, "node_modules/vitest/vitest.mjs"),
  "list", "--filesOnly", "--json", "--configLoader=runner", "--maxWorkers=2", "--minWorkers=1",
], { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
assert.equal(listing.error, undefined, listing.error?.message);
assert.equal(listing.status, 0, listing.stderr || listing.stdout);
const discovered = new Set(JSON.parse(listing.stdout).map(({ file }) =>
  path.relative(repoRoot, file).split(path.sep).join("/"),
));

test("Vitest declares its application test roots explicitly", async () => {
  // Vite's default config bundler derives an esbuild target directly from
  // process.versions.node. Node nightly builds append a V8 canary suffix
  // (for example `28.0.0-v8-canary...`), which is not a valid esbuild
  // semver target. The runner loader executes the TS config without creating
  // that target and is the same loader used by the build script.
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "test" },
    path.join(repoRoot, "vite.config.ts"),
    undefined,
    undefined,
    undefined,
    "runner",
  );
  assert.ok(Array.isArray(loaded?.config.test?.include), "test.include must be explicit");
  assert.ok(loaded.config.test.include.length > 0, "test.include must not be empty");
});

test("Vitest retains every current Omnia Vitest suite", () => {
  const vitestSuites = ownedSources.filter(({ source }) => /(?:from\s*|import\s*)["']vitest["']/.test(source));
  assert.ok(vitestSuites.length > 0, "the ownership inventory must find real Vitest suites");
  const missing = vitestSuites.map(({ path: file }) => file).filter((file) => !discovered.has(file));
  assert.deepEqual(missing, [], `Omnia Vitest suites were excluded: ${missing.join(", ")}`);
});

test("Vitest does not collect Node test runner suites", () => {
  const nodeSuites = ownedSources.filter(({ source }) => /(?:from\s*|require\s*\(\s*)["']node:test["']/.test(source));
  assert.ok(nodeSuites.length > 0, "the ownership inventory must find real Node suites");
  const collected = nodeSuites.map(({ path: file }) => file).filter((file) => discovered.has(file));
  assert.deepEqual(collected, [], `Node suites belong to node --test: ${collected.join(", ")}`);
});

test("Vitest does not collect pinned research or generated test data", () => {
  const outsideRoots = [...discovered].filter((file) => !/^(?:src|scripts|tests)\//.test(file));
  assert.deepEqual(outsideRoots, [], `Non-application test data was collected: ${outsideRoots.join(", ")}`);
});

test("Vitest leaves browser suites to Playwright", () => {
  const browserSuites = ownedSources.filter(({ source }) => /(?:from\s*|import\s*)["']@playwright\/test["']/.test(source));
  assert.ok(browserSuites.length > 0, "the ownership inventory must find real Playwright suites");
  const collected = browserSuites.map(({ path: file }) => file).filter((file) => discovered.has(file));
  assert.deepEqual(collected, [], `Browser suites belong to Playwright: ${collected.join(", ")}`);
});
