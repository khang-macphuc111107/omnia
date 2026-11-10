import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHeadlessReceipt,
  isAllowedRequestUrl,
  nearestRankPercentile,
  parseRunnerOptions,
} from "./perf-headless-runner-lib.mjs";

test("nearest rank percentile is deterministic and rejects empty samples", () => {
  assert.equal(nearestRankPercentile([], 0.95), null);
  assert.equal(nearestRankPercentile([30, 10, 20], 0.5), 20);
  assert.equal(nearestRankPercentile([30, 10, 20], 0.95), 30);
});

test("request policy only permits the measured origin and matching WebSocket origin", () => {
  assert.equal(isAllowedRequestUrl("http://127.0.0.1:4173/assets/app.js", "http://127.0.0.1:4173"), true);
  assert.equal(isAllowedRequestUrl("ws://127.0.0.1:4173/hmr", "http://127.0.0.1:4173"), true);
  assert.equal(isAllowedRequestUrl("http://127.0.0.1:9999/other", "http://127.0.0.1:4173"), false);
  assert.equal(isAllowedRequestUrl("wss://example.test/socket", "http://127.0.0.1:4173"), false);
  assert.equal(isAllowedRequestUrl("not a URL", "http://127.0.0.1:4173"), false);
});

test("runner options clamp bounded endurance controls", () => {
  const options = parseRunnerOptions(["--pages", "100", "--duration-ms", "999999", "--interval-ms", "1", "--scenario", "chat:populated"]);
  assert.equal(options.pages, 8);
  assert.equal(options.durationMs, 60_000);
  assert.equal(options.intervalMs, 50);
  assert.deepEqual(options.scenarios, [{ screen: "chat", state: "populated" }]);
});

test("receipt keeps missing memory and native measurements explicit", () => {
  const receipt = buildHeadlessReceipt({
    metadata: { buildMode: "renderer-preview", gitRevision: "test" },
    samples: [{ scenario: { screen: "chat", state: "populated" }, metrics: { pageReadyMs: 100, domNodeCount: 50 } }],
    events: { requestCount: 1, requests: [], consoleErrors: [], pageErrors: [], requestFailures: [] },
    options: { pages: 1, durationMs: 500, intervalMs: 100, scenarios: [{ screen: "chat", state: "populated" }] },
  });
  assert.equal(receipt.status, "pass");
  assert.equal(receipt.metrics.pageReadyMs.status, "pass");
  assert.equal(receipt.metrics.jsHeapUsedMiB.status, "not-measured");
  assert.match(receipt.claimBoundary.join(" "), /packaged Tauri\/WebView2/);
  assert.deepEqual(receipt.metadata.measuredScenarios, ["chat:populated"]);
});

test("runner rejects nonlocal origins and credentials", () => {
  assert.throws(() => parseRunnerOptions(["--base-url", "https://example.com"]), /loopback HTTP/);
  assert.throws(() => parseRunnerOptions(["--base-url", "http://user:password@127.0.0.1:1420"]), /credential-free/);
  assert.throws(() => parseRunnerOptions(["--scenario", "not-real:populated"]), /Unsupported visual screen/);
  assert.throws(() => parseRunnerOptions(["--scenario", "chat:not-real"]), /Unsupported visual state/);
});

test("external requests are a deterministic failure", () => {
  const receipt = buildHeadlessReceipt({
    metadata: {},
    samples: [{ metrics: { pageReadyMs: 100 } }],
    events: { requestCount: 1, requests: [{ external: true, url: "https://example.test" }], consoleErrors: [], pageErrors: [], requestFailures: [] },
    options: { pages: 1, durationMs: 500, intervalMs: 100, scenarios: [] },
  });
  assert.equal(receipt.status, "fail");
  assert.equal(receipt.events.externalRequests.length, 1);
});

test("threshold failures and per-page heap observations retain raw evidence", () => {
  const samples = [
    { pageIndex: 0, scenario: { screen: "chat", state: "populated" }, measuredAtMs: 1, metrics: { pageReadyMs: 4000 } },
    { pageIndex: 0, scenario: { screen: "chat", state: "populated" }, measuredAtMs: 2, metrics: { jsHeapUsedMiB: 20 } },
    { pageIndex: 0, scenario: { screen: "chat", state: "populated" }, measuredAtMs: 3, metrics: { jsHeapUsedMiB: 21 } },
  ];
  const receipt = buildHeadlessReceipt({ metadata: {}, samples, events: {}, options: {} });
  assert.equal(receipt.status, "fail");
  assert.deepEqual(receipt.thresholdFailures, ["pageReadyMs"]);
  assert.equal(receipt.metrics.pageReadyMs.sampleCount, 1);
  assert.equal(receipt.pages[0].heapDeltaMiB, 1);
  assert.deepEqual(receipt.samples, samples);
});

