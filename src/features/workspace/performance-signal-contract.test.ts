import { describe, expect, it } from "vitest";

import {
  buildPerformanceSignalProjection,
  PERFORMANCE_SIGNAL_BOUNDARY,
  parsePerformanceSignalPreview,
  performanceSignalSummary,
  serializePerformanceSignalProjection,
} from "./performance-signal-contract";

const GENERATED_AT = "2026-09-21T10:00:00.000Z";

describe("performance-signal-contract", () => {
  it("normalizes measured samples, uses nearest-rank p95, and keeps missing metrics explicit", () => {
    const projection = buildPerformanceSignalProjection({
      generatedAt: GENERATED_AT,
      sourceSnapshot: "revision-performance-preview",
      metrics: [
        {
          id: "localSendFeedbackMs",
          samples: [38, 44, 52, 110],
          source: "runner fixture",
          coverage: "complete",
          freshness: "same snapshot",
        },
        {
          id: "entryJavaScriptBytes",
          samples: [{ value: 480_000 }, 490_000],
          source: "Vite manifest",
          evidence: "estimated",
        },
      ],
    });

    const localSend = projection.signals.find((signal) => signal.id === "localSendFeedbackMs");
    const entry = projection.signals.find((signal) => signal.id === "entryJavaScriptBytes");
    const cold = projection.signals.find((signal) => signal.id === "coldLaunchMs");

    expect(localSend).toMatchObject({ sampleCount: 4, p50: 44, p95: 110, status: "fail", evidence: "measured" });
    expect(entry).toMatchObject({ sampleCount: 2, p95: 490_000, status: "pass", evidence: "estimated" });
    expect(cold).toMatchObject({ sampleCount: 0, p50: null, p95: null, status: "unknown", evidence: "unknown" });
    expect(projection.counts).toMatchObject({ total: 10, measured: 2, pass: 1, fail: 1, unknown: 8, planned: 0 });
    expect(performanceSignalSummary(projection)).toBe("2 measured · 1 pass · 1 fail · 8 unknown · 0 planned");
  });

  it("marks runner-defined metrics as watch instead of inventing a universal target", () => {
    const projection = buildPerformanceSignalProjection({
      generatedAt: GENERATED_AT,
      metrics: [{ id: "longTaskCount", samples: [0, 1, 0], source: "PerformanceObserver" }],
    });
    expect(projection.signals.find((signal) => signal.id === "longTaskCount")).toMatchObject({
      status: "watch",
      evidence: "measured",
      p95: 1,
      targetP95: null,
    });
    expect(projection.boundary).toEqual({
      rendererOnly: true,
      noRuntimeCollection: true,
      noDurableWrite: true,
      noProviderRequest: true,
      noNativePerformanceClaim: true,
    });
  });

  it("round-trips JSON, redacts unsafe text, and rejects boundary/schema tampering", () => {
    const projection = buildPerformanceSignalProjection({
      generatedAt: GENERATED_AT,
      sourceSnapshot: "C:\\Users\\khang\\source\\repos\\omnia",
      metrics: [{
        id: "warmInteractiveShellMs",
        samples: [1_100, 1_240, 1_480],
        source: "Bearer sk-test-secret",
        reason: "Read C:\\Users\\khang\\secret.txt",
      }],
    });
    const json = serializePerformanceSignalProjection(projection, "json");
    const markdown = serializePerformanceSignalProjection(projection, "markdown");
    const roundTrip = parsePerformanceSignalPreview(json);

    expect(json).toContain("[REDACTED_TOKEN]");
    expect(json).not.toContain("sk-test-secret");
    expect(json).not.toContain("C:\\\\Users\\\\khang");
    expect(markdown).toContain(PERFORMANCE_SIGNAL_BOUNDARY);
    expect(roundTrip?.signals).toHaveLength(10);
    expect(roundTrip?.signals.find((signal) => signal.id === "warmInteractiveShellMs")).toMatchObject({
      p95: 1_480,
      status: "pass",
    });
    expect(parsePerformanceSignalPreview(json.replace('"noNativePerformanceClaim": true', '"noNativePerformanceClaim": false'))).toBeNull();
    expect(parsePerformanceSignalPreview(json.replace("omnia.performance-signal.preview.v1", "unknown.schema"))).toBeNull();
  });

  it("fails closed on malformed imported samples and duplicate records", () => {
    const projection = buildPerformanceSignalProjection({ generatedAt: GENERATED_AT });
    const json = serializePerformanceSignalProjection(projection, "json");
    const malformed = json.replace('"sampleCount": 0', '"sampleCount": -1');
    const duplicate = json.replace('"id": "coldLaunchMs"', '"id": "warmInteractiveShellMs"');

    expect(parsePerformanceSignalPreview(`\uFEFF${json}`)?.schema).toBe("omnia.performance-signal.preview.v1");
    expect(parsePerformanceSignalPreview(malformed)).toBeNull();
    expect(parsePerformanceSignalPreview(duplicate)).toBeNull();
    expect(parsePerformanceSignalPreview(`${json}${"x".repeat(300_000)}`)).toBeNull();
  });
});

