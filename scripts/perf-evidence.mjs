import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/**
 * Converts measured performance samples into a small, reviewable receipt.
 *
 * This script deliberately does not launch the app or invent measurements.
 * A platform-specific runner (browser, packaged Tauri, or a Windows test
 * harness) owns collection. This script only validates the fixture, computes
 * deterministic statistics, applies the documented p95 gates, and records
 * the claim boundary. That separation prevents a green synthetic benchmark
 * from being mistaken for Windows desktop evidence.
 */

const METRICS = Object.freeze({
  warmInteractiveShellMs: {
    label: "warm interactive shell",
    unit: "ms",
    targetP95: 1_500,
    targetText: "p95 <= 1,500 ms",
  },
  coldLaunchMs: {
    label: "cold launch",
    unit: "ms",
    targetP95: 3_000,
    targetText: "p95 <= 3,000 ms",
  },
  localSendFeedbackMs: {
    label: "local send feedback",
    unit: "ms",
    targetP95: 100,
    targetText: "p95 <= 100 ms",
  },
  indexedSearch10kMs: {
    label: "indexed search over 10,000 conversations",
    unit: "ms",
    targetP95: 300,
    targetText: "p95 <= 300 ms",
  },
});

const REQUIRED_METADATA = Object.freeze([
  "fixtureVersion",
  "measurementDate",
  "buildMode",
  "gitRevision",
]);

function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/perf-evidence.mjs --input <fixture.json> [options]",
      "",
      "Options:",
      "  --input <path>       JSON fixture containing metadata and metrics.",
      "  --output <path>      Write the generated receipt to this path.",
      "  --require-complete   Fail if any target metric has no samples.",
      "  --help               Show this help.",
      "",
      "The script never creates measurements. It computes p50/p95 from supplied",
      "samples and keeps missing metrics explicitly not-measured.",
    ].join("\n") + "\n",
  );
}

function parseArgs(argv) {
  const options = { requireComplete: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--require-complete") {
      options.requireComplete = true;
      continue;
    }
    if (argument === "--input" || argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a path`);
      }
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

function finiteSamples(value, metricName) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`metrics.${metricName} must be an array of durations in milliseconds`);
  }
  return value.map((sample, index) => {
    const numeric = typeof sample === "number" ? sample : sample?.value;
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new Error(`metrics.${metricName}[${index}] must be a finite non-negative number`);
    }
    return numeric;
  });
}

function normalizeMetadata(input) {
  const metadata = input && typeof input.metadata === "object" ? input.metadata : {};
  const missing = REQUIRED_METADATA.filter((key) => {
    const value = metadata[key];
    return typeof value !== "string" || value.trim().length === 0;
  });
  return { metadata, missing };
}

function makeReceipt(fixture, { requireComplete }) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new Error("Fixture root must be a JSON object");
  }

  const { metadata, missing: missingMetadata } = normalizeMetadata(fixture);
  const sourceMetrics = fixture.metrics ?? fixture.samples;
  if (!sourceMetrics || typeof sourceMetrics !== "object" || Array.isArray(sourceMetrics)) {
    throw new Error("Fixture must contain a metrics object (or the legacy samples object)");
  }

  const metrics = {};
  const missingMetrics = [];
  const failedMetrics = [];

  for (const [metricName, policy] of Object.entries(METRICS)) {
    const values = finiteSamples(sourceMetrics[metricName], metricName);
    if (values.length === 0) {
      missingMetrics.push(metricName);
      metrics[metricName] = {
        label: policy.label,
        unit: policy.unit,
        sampleCount: 0,
        p50: null,
        p95: null,
        minimum: null,
        maximum: null,
        targetP95: policy.targetP95,
        target: policy.targetText,
        status: "not-measured",
      };
      continue;
    }

    const p50 = percentile(values, 0.5);
    const p95 = percentile(values, 0.95);
    const passed = p95 <= policy.targetP95;
    if (!passed) failedMetrics.push(metricName);
    metrics[metricName] = {
      label: policy.label,
      unit: policy.unit,
      sampleCount: values.length,
      p50,
      p95,
      minimum: Math.min(...values),
      maximum: Math.max(...values),
      targetP95: policy.targetP95,
      target: policy.targetText,
      status: passed ? "pass" : "fail",
    };
  }

  const status =
    failedMetrics.length > 0
      ? "fail"
      : requireComplete && (missingMetrics.length > 0 || missingMetadata.length > 0)
        ? "incomplete"
        : missingMetrics.length > 0 || missingMetadata.length > 0
          ? "not-measured"
          : "pass";

  return {
    schemaVersion: "omnia.performance-evidence.v1",
    generatedAt: new Date().toISOString(),
    status,
    metadata,
    metadataMissing: missingMetadata,
    metrics,
    missingMetrics,
    failedMetrics,
    claimBoundary: [
      "This receipt summarizes only the supplied samples.",
      "It does not prove packaged Tauri/WebView2, Windows 11, clean-VM, or release performance unless metadata and samples say so.",
      "Missing samples remain not-measured; they are never treated as passing.",
      "Memory, handles, threads, long tasks, dropped frames, event backlog, and endurance require separate samples.",
    ],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.input) {
    printHelp();
    process.stderr.write("Performance evidence requires an explicit --input fixture; no measurements are generated.\n");
    process.exitCode = 2;
    return;
  }

  let fixture;
  try {
    fixture = JSON.parse(await readFile(path.resolve(process.cwd(), options.input), "utf8"));
  } catch (cause) {
    process.stderr.write(
      `Performance evidence failed: unable to read/parse ${options.input} (${cause instanceof Error ? cause.message : "unknown error"})\n`,
    );
    process.exitCode = 2;
    return;
  }

  let receipt;
  try {
    receipt = makeReceipt(fixture, options);
  } catch (cause) {
    process.stderr.write(
      `Performance evidence failed: ${cause instanceof Error ? cause.message : "unknown error"}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (options.output) {
    const outputPath = path.resolve(process.cwd(), options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, "utf8");
  }

  process.stdout.write(
    [
      `Performance evidence ${receipt.status}.`,
      `- measured target metrics: ${Object.values(receipt.metrics).filter((metric) => metric.sampleCount > 0).length}/${Object.keys(METRICS).length}`,
      `- missing target metrics: ${receipt.missingMetrics.length}`,
      `- threshold failures: ${receipt.failedMetrics.length}`,
      options.output ? `- receipt: ${options.output}` : "- receipt: stdout only",
    ].join("\n") + "\n",
  );

  if (receipt.status === "fail" || receipt.status === "incomplete") {
    process.exitCode = 1;
  }
}

await main();
