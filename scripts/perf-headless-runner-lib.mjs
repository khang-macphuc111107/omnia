import path from "node:path";

export const HEADLESS_PERFORMANCE_SCHEMA = "omnia.performance-headless.v1";
export const DEFAULT_HEADLESS_DURATION_MS = 5_000;
export const DEFAULT_HEADLESS_INTERVAL_MS = 250;
export const DEFAULT_HEADLESS_PAGES = 1;
export const MAX_HEADLESS_DURATION_MS = 60_000;
export const MAX_HEADLESS_INTERVAL_MS = 5_000;
export const MAX_HEADLESS_PAGES = 8;

export const DEFAULT_SCENARIOS = Object.freeze([
  { screen: "chat", state: "populated" },
]);

export const METRIC_POLICIES = Object.freeze({
  pageReadyMs: Object.freeze({ label: "headless page ready", unit: "ms", targetP95: 3_000 }),
  jsHeapUsedMiB: Object.freeze({ label: "renderer JavaScript heap", unit: "MiB", targetP95: null }),
  domNodeCount: Object.freeze({ label: "DOM node count", unit: "nodes", targetP95: null }),
  longTaskCount: Object.freeze({ label: "long task count", unit: "tasks", targetP95: null }),
  longTaskTotalMs: Object.freeze({ label: "long task duration", unit: "ms", targetP95: null }),
  frameGapP95Ms: Object.freeze({ label: "animation frame gap", unit: "ms", targetP95: null }),
  resourceTransferKiB: Object.freeze({ label: "renderer resource transfer", unit: "KiB", targetP95: null }),
  rendererTaskDurationMs: Object.freeze({ label: "renderer main-thread task duration", unit: "ms", targetP95: null }),
  rendererScriptDurationMs: Object.freeze({ label: "renderer script duration", unit: "ms", targetP95: null }),
  rendererLayoutDurationMs: Object.freeze({ label: "renderer layout duration", unit: "ms", targetP95: null }),
});

export function finiteInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

export function parseScenario(value) {
  const [screen, state = "populated"] = String(value ?? "").split(":");
  if (!screen || !/^[a-z][a-z0-9-]{0,40}$/.test(screen) || !/^[a-z][a-z0-9-]{0,40}$/.test(state)) {
    throw new Error(`Invalid scenario ${JSON.stringify(value)}; use screen:state, for example chat:populated`);
  }
  if (!["boot", "chat", "home", "projects", "library", "memory", "skills", "settings"].includes(screen)) throw new Error(`Unsupported visual screen ${screen}`);
  if (!["empty", "loading", "populated", "streaming", "partial", "offline", "denied", "error", "long-content"].includes(state)) throw new Error(`Unsupported visual state ${state}`);
  return { screen, state };
}

export function parseRunnerOptions(argv) {
  const options = {
    baseUrl: process.env.OMNIA_HEADLESS_BASE_URL ?? "http://127.0.0.1:1420/",
    output: process.env.OMNIA_HEADLESS_PERF_OUTPUT ?? "artifacts/performance/headless-receipt.json",
    pages: DEFAULT_HEADLESS_PAGES,
    durationMs: DEFAULT_HEADLESS_DURATION_MS,
    intervalMs: DEFAULT_HEADLESS_INTERVAL_MS,
    scenarios: [...DEFAULT_SCENARIOS],
    headless: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      return value;
    };
    if (argument === "--base-url") options.baseUrl = next();
    else if (argument === "--output") options.output = next();
    else if (argument === "--pages") options.pages = finiteInt(next(), DEFAULT_HEADLESS_PAGES, 1, MAX_HEADLESS_PAGES);
    else if (argument === "--duration-ms") options.durationMs = finiteInt(next(), DEFAULT_HEADLESS_DURATION_MS, 500, MAX_HEADLESS_DURATION_MS);
    else if (argument === "--interval-ms") options.intervalMs = finiteInt(next(), DEFAULT_HEADLESS_INTERVAL_MS, 50, MAX_HEADLESS_INTERVAL_MS);
    else if (argument === "--scenario") options.scenarios = [parseScenario(next())];
    else if (argument === "--scenarios") options.scenarios = next().split(",").map(parseScenario);
    else if (argument === "--headed") options.headless = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option ${argument}`);
  }
  if (options.intervalMs > options.durationMs) options.intervalMs = Math.min(options.intervalMs, options.durationMs);
  options.baseUrl = new URL(options.baseUrl).toString();
  const parsedUrl = new URL(options.baseUrl);
  if (parsedUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsedUrl.hostname) || parsedUrl.username || parsedUrl.password) {
    throw new Error("--base-url must be a credential-free loopback HTTP URL");
  }
  options.output = path.normalize(options.output);
  if (options.scenarios.length === 0) throw new Error("At least one scenario is required");
  return options;
}

export function nearestRankPercentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(Math.min(1, Math.max(0, fraction)) * sorted.length));
  return sorted[rank - 1] ?? null;
}

export function isAllowedRequestUrl(value, allowedOrigin) {
  try {
    const url = new URL(value);
    if (url.protocol === "data:") return true;
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    return url.origin === allowedOrigin;
  } catch { return false; }
}

function summarizeMetric(id, values) {
  const policy = METRIC_POLICIES[id];
  const numeric = values.filter((value) => Number.isFinite(value) && value >= 0);
  const p50 = nearestRankPercentile(numeric, 0.5);
  const p95 = nearestRankPercentile(numeric, 0.95);
  const status = p95 === null ? "not-measured" : policy.targetP95 === null ? "observed" : p95 <= policy.targetP95 ? "pass" : "fail";
  return {
    id,
    label: policy.label,
    unit: policy.unit,
    sampleCount: numeric.length,
    p50,
    p95,
    minimum: numeric.length ? Math.min(...numeric) : null,
    maximum: numeric.length ? Math.max(...numeric) : null,
    targetP95: policy.targetP95,
    status,
  };
}

export function buildHeadlessReceipt({ metadata, samples, events, options, generatedAt = new Date().toISOString() }) {
  const metricSamples = Object.fromEntries(Object.keys(METRIC_POLICIES).map((id) => [id, []]));
  for (const sample of samples ?? []) {
    for (const id of Object.keys(METRIC_POLICIES)) {
      const value = sample?.metrics?.[id];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) metricSamples[id].push(value);
    }
  }
  const metrics = Object.fromEntries(Object.entries(metricSamples).map(([id, values]) => [id, summarizeMetric(id, values)]));
  const thresholdFailures = Object.values(metrics).filter((metric) => metric.status === "fail").map((metric) => metric.id);
  const externalRequests = (events?.requests ?? []).filter((event) => event.external === true);
  const runtimeErrors = (events?.consoleErrors ?? []).length + (events?.pageErrors ?? []).length + (events?.requestFailures ?? []).length;
  const measuredCount = Object.values(metrics).filter((metric) => metric.sampleCount > 0).length;
  const status = thresholdFailures.length > 0 || externalRequests.length > 0 || runtimeErrors > 0 ? "fail" : measuredCount === 0 ? "not-measured" : "pass";
  return {
    schemaVersion: HEADLESS_PERFORMANCE_SCHEMA,
    generatedAt,
    status,
    metadata: {
      runner: "playwright-chromium-headless",
      ...metadata,
      pages: options?.pages ?? null,
      durationMs: options?.durationMs ?? null,
      intervalMs: options?.intervalMs ?? null,
      scenarios: options?.scenarios ?? [],
      measuredScenarios: [...new Set((samples ?? []).map((sample) => `${sample.scenario?.screen ?? "unknown"}:${sample.scenario?.state ?? "unknown"}`))],
    },
    metrics,
    events: {
      consoleErrors: events?.consoleErrors ?? [],
      pageErrors: events?.pageErrors ?? [],
      requestFailures: events?.requestFailures ?? [],
      externalRequests,
      requestCount: events?.requestCount ?? 0,
    },
    sampleCount: samples?.length ?? 0,
    samples: samples ?? [],
    pages: Array.from(new Set((samples ?? []).map((sample) => sample.pageIndex))).map((pageIndex) => {
      const pageSamples = (samples ?? []).filter((sample) => sample.pageIndex === pageIndex);
      const heaps = pageSamples.map((sample) => sample.metrics?.jsHeapUsedMiB).filter((value) => typeof value === "number" && Number.isFinite(value));
      return {
        pageIndex,
        scenario: pageSamples[0]?.scenario ?? null,
        sampleCount: pageSamples.length,
        firstSampleAtMs: pageSamples[0]?.measuredAtMs ?? null,
        lastSampleAtMs: pageSamples.at(-1)?.measuredAtMs ?? null,
        heapFirstMiB: heaps[0] ?? null,
        heapLastMiB: heaps.at(-1) ?? null,
        heapDeltaMiB: heaps.length ? heaps.at(-1) - heaps[0] : null,
      };
    }),
    thresholdFailures,
    claimBoundary: [
      "This receipt measures the renderer in isolated headless Chromium against the supplied local URL.",
      "It does not prove packaged Tauri/WebView2, Windows desktop, GPU, native process working-set, provider, or clean-VM performance.",
      "External requests are failures; native and provider work are not silently substituted with synthetic samples.",
      "Missing native, GPU, memory-working-set, and endurance evidence remains outside this receipt.",
      "Page-ready duration is a fixture navigation measurement, not a cold or warm desktop launch measurement. Each page contributes one page-ready sample.",
      "Heap deltas include ordinary garbage collection and are observations, not a memory-leak verdict. Renderer task durations are CDP counters, not operating-system CPU percentages.",
    ],
  };
}

