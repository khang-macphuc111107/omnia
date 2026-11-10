import { redactDiagnosticText } from "./diagnostics-session-contract";

/**
 * A small, source-neutral performance vocabulary for the visible workbench
 * surfaces. The contract intentionally accepts measurements supplied by an
 * external runner; it never measures the browser, desktop runtime, provider,
 * or operating system by itself.
 */
export const PERFORMANCE_SIGNAL_SCHEMA = "omnia.performance-signal.preview.v1" as const;
export const PERFORMANCE_SIGNAL_VERSION = 1 as const;
export const PERFORMANCE_SIGNAL_SCOPE = "renderer-session" as const;
export const PERFORMANCE_SIGNAL_MAX_BYTES = 256 * 1024;
export const PERFORMANCE_SIGNAL_BOUNDARY =
  "Renderer-local performance signal projection only. It does not collect runtime measurements, prove packaged desktop performance, persist telemetry, dispatch providers, or replace the performance evidence runner.";

export type PerformanceSignalFormat = "json" | "markdown";
export type PerformanceSignalStatus = "pass" | "watch" | "fail" | "unknown" | "planned";
export type PerformanceSignalEvidence = "measured" | "estimated" | "unknown" | "planned";
export type PerformanceSignalDirection = "max" | "none";

export type PerformanceMetricId =
  | "warmInteractiveShellMs"
  | "coldLaunchMs"
  | "localSendFeedbackMs"
  | "indexedSearch10kMs"
  | "entryJavaScriptBytes"
  | "largestAsyncChunkBytes"
  | "totalJavaScriptBytes"
  | "longTaskCount"
  | "droppedFrames"
  | "memoryWorkingSetMiB";

export interface PerformanceMetricPolicy {
  readonly id: PerformanceMetricId;
  readonly label: string;
  readonly unit: string;
  readonly targetP95: number | null;
  readonly direction: PerformanceSignalDirection;
  readonly description: string;
}

export const PERFORMANCE_METRIC_POLICIES: readonly PerformanceMetricPolicy[] = [
  {
    id: "warmInteractiveShellMs",
    label: "Warm interactive shell",
    unit: "ms",
    targetP95: 1_500,
    direction: "max",
    description: "Warm Windows shell to first usable interactive surface.",
  },
  {
    id: "coldLaunchMs",
    label: "Cold launch",
    unit: "ms",
    targetP95: 3_000,
    direction: "max",
    description: "Cold launch excluding first-install OS/runtime work.",
  },
  {
    id: "localSendFeedbackMs",
    label: "Local send feedback",
    unit: "ms",
    targetP95: 100,
    direction: "max",
    description: "Accepted local send action to visible local acknowledgement.",
  },
  {
    id: "indexedSearch10kMs",
    label: "Indexed search over 10,000 conversations",
    unit: "ms",
    targetP95: 300,
    direction: "max",
    description: "Search over the fixed, warmed 10,000-conversation corpus.",
  },
  {
    id: "entryJavaScriptBytes",
    label: "Startup entry JavaScript",
    unit: "bytes",
    targetP95: 500_000,
    direction: "max",
    description: "Static entry chunk budget; not a runtime launch measurement.",
  },
  {
    id: "largestAsyncChunkBytes",
    label: "Largest async chunk",
    unit: "bytes",
    targetP95: 307_200,
    direction: "max",
    description: "Largest lazy renderer chunk in the production manifest.",
  },
  {
    id: "totalJavaScriptBytes",
    label: "Total JavaScript",
    unit: "bytes",
    targetP95: 2_150_400,
    direction: "max",
    description: "Total JavaScript asset budget in the production manifest.",
  },
  {
    id: "longTaskCount",
    label: "Long tasks",
    unit: "tasks",
    targetP95: null,
    direction: "none",
    description: "Browser PerformanceObserver long-task count; target is runner-defined.",
  },
  {
    id: "droppedFrames",
    label: "Dropped frames",
    unit: "frames",
    targetP95: null,
    direction: "none",
    description: "Frame cadence observation; target is runner/display-defined.",
  },
  {
    id: "memoryWorkingSetMiB",
    label: "Memory working set",
    unit: "MiB",
    targetP95: null,
    direction: "none",
    description: "Process working-set observation; packaged runtime collection is separate.",
  },
] as const;

export interface PerformanceSignalRecord {
  readonly id: PerformanceMetricId;
  readonly label: string;
  readonly unit: string;
  readonly targetP95: number | null;
  readonly direction: PerformanceSignalDirection;
  readonly sampleCount: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly status: PerformanceSignalStatus;
  readonly evidence: PerformanceSignalEvidence;
  readonly source: string;
  readonly coverage: string;
  readonly freshness: string;
  readonly reason: string;
}

export interface PerformanceSignalCounts {
  readonly total: number;
  readonly measured: number;
  readonly pass: number;
  readonly watch: number;
  readonly fail: number;
  readonly unknown: number;
  readonly planned: number;
}

export interface PerformanceSignalProjection {
  readonly schema: typeof PERFORMANCE_SIGNAL_SCHEMA;
  readonly version: typeof PERFORMANCE_SIGNAL_VERSION;
  readonly scope: typeof PERFORMANCE_SIGNAL_SCOPE;
  readonly generatedAt: string;
  readonly sourceSnapshot: string | null;
  readonly signals: readonly PerformanceSignalRecord[];
  readonly counts: PerformanceSignalCounts;
  readonly boundary: {
    readonly rendererOnly: true;
    readonly noRuntimeCollection: true;
    readonly noDurableWrite: true;
    readonly noProviderRequest: true;
    readonly noNativePerformanceClaim: true;
  };
}

export interface PerformanceSignalMetricInput {
  readonly id: PerformanceMetricId;
  readonly samples?: readonly unknown[];
  readonly evidence?: PerformanceSignalEvidence;
  readonly source?: unknown;
  readonly coverage?: unknown;
  readonly freshness?: unknown;
  readonly reason?: unknown;
}

export interface PerformanceSignalProjectionInput {
  readonly metrics?: readonly PerformanceSignalMetricInput[];
  readonly sourceSnapshot?: unknown;
  readonly generatedAt?: unknown;
}

const METRIC_IDS = PERFORMANCE_METRIC_POLICIES.map((policy) => policy.id);
const STATUS_VALUES: readonly PerformanceSignalStatus[] = ["pass", "watch", "fail", "unknown", "planned"];
const EVIDENCE_VALUES: readonly PerformanceSignalEvidence[] = ["measured", "estimated", "unknown", "planned"];
const DIRECTION_VALUES: readonly PerformanceSignalDirection[] = ["max", "none"];
const POLICY_BY_ID = new Map(PERFORMANCE_METRIC_POLICIES.map((policy) => [policy.id, policy]));

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;
}

function safeText(value: unknown, maxLength: number, fallback: string): string {
  const text = redactDiagnosticText(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
  return text || fallback;
}

function safeGeneratedAt(value: unknown): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function finiteSamples(value: readonly unknown[] | undefined): number[] {
  if (!value) return [];
  return value.flatMap((sample) => {
    const numeric = typeof sample === "number"
      ? sample
      : sample && typeof sample === "object" && "value" in sample
        ? (sample as { readonly value?: unknown }).value
        : Number.NaN;
    return typeof numeric === "number" && Number.isFinite(numeric) && numeric >= 0 ? [numeric] : [];
  });
}

/** Nearest-rank percentile, matching scripts/perf-evidence.mjs. */
export function nearestRankPercentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(Math.min(1, Math.max(0, fraction)) * sorted.length));
  return sorted[rank - 1] ?? null;
}

function statusFor(policy: PerformanceMetricPolicy, p95: number | null, evidence: PerformanceSignalEvidence): PerformanceSignalStatus {
  if (evidence === "planned") return "planned";
  if (p95 === null) return evidence === "unknown" ? "unknown" : "planned";
  if (policy.targetP95 === null) return "watch";
  return p95 <= policy.targetP95 ? "pass" : "fail";
}

function normalizeMetric(input: PerformanceSignalMetricInput): PerformanceSignalRecord | null {
  const policy = POLICY_BY_ID.get(input.id);
  if (!policy) return null;
  const values = finiteSamples(input.samples);
  const evidence = enumValue(input.evidence, EVIDENCE_VALUES, values.length > 0 ? "measured" : "unknown");
  const p50 = nearestRankPercentile(values, 0.5);
  const p95 = nearestRankPercentile(values, 0.95);
  return {
    id: policy.id,
    label: policy.label,
    unit: policy.unit,
    targetP95: policy.targetP95,
    direction: policy.direction,
    sampleCount: values.length,
    p50,
    p95,
    minimum: values.length > 0 ? Math.min(...values) : null,
    maximum: values.length > 0 ? Math.max(...values) : null,
    status: statusFor(policy, p95, evidence),
    evidence,
    source: safeText(input.source, 160, values.length > 0 ? "external runner" : "not-collected"),
    coverage: safeText(input.coverage, 120, values.length > 0 ? "partial" : "unknown"),
    freshness: safeText(input.freshness, 120, values.length > 0 ? "supplied sample" : "not-collected"),
    reason: safeText(
      input.reason,
      360,
      values.length > 0
        ? policy.targetP95 === null
          ? "Measured sample has no universal threshold; keep the runner/display target visible."
          : `Nearest-rank p95 is compared with the ${policy.targetP95} ${policy.unit} target.`
        : "No finite sample was supplied; unknown is not zero or a passing result.",
    ),
  };
}

function buildCounts(signals: readonly PerformanceSignalRecord[]): PerformanceSignalCounts {
  return {
    total: signals.length,
    measured: signals.filter((signal) => signal.evidence === "measured" || signal.evidence === "estimated").length,
    pass: signals.filter((signal) => signal.status === "pass").length,
    watch: signals.filter((signal) => signal.status === "watch").length,
    fail: signals.filter((signal) => signal.status === "fail").length,
    unknown: signals.filter((signal) => signal.status === "unknown").length,
    planned: signals.filter((signal) => signal.status === "planned").length,
  };
}

function normalizeSignalRecord(value: unknown): PerformanceSignalRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = enumValue(record.id, METRIC_IDS, "warmInteractiveShellMs");
  if (typeof record.id !== "string" || !METRIC_IDS.includes(record.id as PerformanceMetricId)) return null;
  const policy = POLICY_BY_ID.get(id)!;
  const numericOrNull = (candidate: unknown): number | null =>
    candidate === null ? null : typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : null;
  const sampleCount = typeof record.sampleCount === "number" && Number.isInteger(record.sampleCount) && record.sampleCount >= 0
    ? record.sampleCount
    : -1;
  if (sampleCount < 0) return null;
  const p50 = numericOrNull(record.p50);
  const p95 = numericOrNull(record.p95);
  const minimum = numericOrNull(record.minimum);
  const maximum = numericOrNull(record.maximum);
  if (sampleCount > 0 && (p50 === null || p95 === null || minimum === null || maximum === null)) return null;
  if (sampleCount === 0 && (p50 !== null || p95 !== null || minimum !== null || maximum !== null)) return null;
  if (typeof record.label !== "string" || typeof record.unit !== "string") return null;
  if (record.targetP95 !== null && (typeof record.targetP95 !== "number" || !Number.isFinite(record.targetP95) || record.targetP95 < 0)) return null;
  if (record.targetP95 !== policy.targetP95 || record.unit !== policy.unit || record.direction !== policy.direction) return null;
  if (!STATUS_VALUES.includes(record.status as PerformanceSignalStatus) || !EVIDENCE_VALUES.includes(record.evidence as PerformanceSignalEvidence)) return null;
  if (!DIRECTION_VALUES.includes(record.direction as PerformanceSignalDirection)) return null;
  if (["source", "coverage", "freshness", "reason"].some((key) => typeof record[key] !== "string")) return null;
  return {
    id,
    label: safeText(record.label, 180, policy.label),
    unit: policy.unit,
    targetP95: policy.targetP95,
    direction: policy.direction,
    sampleCount,
    p50,
    p95,
    minimum,
    maximum,
    status: record.status as PerformanceSignalStatus,
    evidence: record.evidence as PerformanceSignalEvidence,
    source: safeText(record.source, 160, "unknown"),
    coverage: safeText(record.coverage, 120, "unknown"),
    freshness: safeText(record.freshness, 120, "unknown"),
    reason: safeText(record.reason, 360, "No additional evidence supplied."),
  };
}

export function buildPerformanceSignalProjection(input: PerformanceSignalProjectionInput): PerformanceSignalProjection {
  const provided = new Map((input.metrics ?? []).map((metric) => [metric.id, metric]));
  const signals = PERFORMANCE_METRIC_POLICIES.map((policy) => normalizeMetric(provided.get(policy.id) ?? { id: policy.id })).filter(
    (signal): signal is PerformanceSignalRecord => signal !== null,
  );
  return {
    schema: PERFORMANCE_SIGNAL_SCHEMA,
    version: PERFORMANCE_SIGNAL_VERSION,
    scope: PERFORMANCE_SIGNAL_SCOPE,
    generatedAt: safeGeneratedAt(input.generatedAt),
    sourceSnapshot: input.sourceSnapshot === undefined || input.sourceSnapshot === null
      ? null
      : safeText(input.sourceSnapshot, 240, "unknown"),
    signals,
    counts: buildCounts(signals),
    boundary: {
      rendererOnly: true,
      noRuntimeCollection: true,
      noDurableWrite: true,
      noProviderRequest: true,
      noNativePerformanceClaim: true,
    },
  };
}

export function performanceSignalSummary(projection: PerformanceSignalProjection): string {
  const { measured, pass, fail, unknown, planned } = projection.counts;
  return `${measured} measured · ${pass} pass · ${fail} fail · ${unknown} unknown · ${planned} planned`;
}

function markdownValue(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

export function serializePerformanceSignalProjection(
  projection: PerformanceSignalProjection,
  format: PerformanceSignalFormat,
): string {
  if (format === "json") return `${JSON.stringify(projection, null, 2)}\n`;
  const lines = [
    "# Omnia performance signals preview",
    "",
    `> ${PERFORMANCE_SIGNAL_BOUNDARY}`,
    "",
    `- Schema: ${projection.schema}`,
    `- Generated: ${markdownValue(projection.generatedAt)}`,
    `- Source snapshot: ${markdownValue(projection.sourceSnapshot ?? "unknown")}`,
    `- Summary: ${performanceSignalSummary(projection)}`,
    "",
    "| Signal | p50 | p95 | Target | Status | Evidence | Source |",
    "| --- | ---: | ---: | ---: | --- | --- | --- |",
  ];
  for (const signal of projection.signals) {
    const p50 = signal.p50 === null ? "unknown" : `${signal.p50} ${signal.unit}`;
    const p95 = signal.p95 === null ? "unknown" : `${signal.p95} ${signal.unit}`;
    const target = signal.targetP95 === null ? "runner-defined" : `${signal.targetP95} ${signal.unit}`;
    lines.push(`| ${markdownValue(signal.label)} | ${p50} | ${p95} | ${target} | ${signal.status} | ${signal.evidence} | ${markdownValue(signal.source)} |`);
  }
  lines.push("", `> ${markdownValue(PERFORMANCE_SIGNAL_BOUNDARY)}`, "");
  return lines.join("\n");
}

export function parsePerformanceSignalPreview(payload: string): PerformanceSignalProjection | null {
  const text = payload.replace(/^\uFEFF/, "");
  if (new TextEncoder().encode(text).byteLength > PERFORMANCE_SIGNAL_MAX_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.schema !== PERFORMANCE_SIGNAL_SCHEMA || record.version !== PERFORMANCE_SIGNAL_VERSION || record.scope !== PERFORMANCE_SIGNAL_SCOPE) return null;
    if (typeof record.generatedAt !== "string" || !Number.isFinite(Date.parse(record.generatedAt))) return null;
    if (typeof record.sourceSnapshot !== "string" && record.sourceSnapshot !== null) return null;
    const boundary = record.boundary;
    if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) return null;
    const boundaryRecord = boundary as Record<string, unknown>;
    const boundaryKeys = ["rendererOnly", "noRuntimeCollection", "noDurableWrite", "noProviderRequest", "noNativePerformanceClaim"];
    if (!boundaryKeys.every((key) => boundaryRecord[key] === true)) return null;
    if (!Array.isArray(record.signals)) return null;
    const signals = record.signals.map(normalizeSignalRecord);
    if (signals.some((signal) => signal === null)) return null;
    const normalized = signals.filter((signal): signal is PerformanceSignalRecord => signal !== null);
    if (new Set(normalized.map((signal) => signal.id)).size !== normalized.length) return null;
    return {
      schema: PERFORMANCE_SIGNAL_SCHEMA,
      version: PERFORMANCE_SIGNAL_VERSION,
      scope: PERFORMANCE_SIGNAL_SCOPE,
      generatedAt: new Date(record.generatedAt).toISOString(),
      sourceSnapshot: record.sourceSnapshot === null ? null : safeText(record.sourceSnapshot, 240, "unknown"),
      signals: normalized,
      counts: buildCounts(normalized),
      boundary: {
        rendererOnly: true,
        noRuntimeCollection: true,
        noDurableWrite: true,
        noProviderRequest: true,
        noNativePerformanceClaim: true,
      },
    };
  } catch {
    return null;
  }
}

