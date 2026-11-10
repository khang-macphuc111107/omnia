import { useMemo, useState } from "react";
import { Activity, BarChart3, Clipboard, Cloud, Download, Gauge, ShieldCheck, Sparkles, TrendingUp } from "lucide-react";

import { PerformanceSignalStrip } from "./performance-signal-strip";

type Scope = "workspace" | "project" | "chat";
type ExportFormat = "json" | "markdown";
type EvidenceState = "estimated" | "unknown" | "planned";
type SeriesMetric = "usage" | "cost" | "active-runs" | "coverage" | "generated-tps" | "input-tpm" | "requests-rps" | "requests-rpm" | "visible-characters-per-second" | "cost-per-second" | "cost-per-minute" | "cost-per-hour";
type SeriesWindow = "30m" | "1h" | "2h" | "3h" | "5h" | "6h" | "8h" | "10h" | "12h" | "24h" | "1d" | "2d" | "3d" | "5d" | "1w" | "custom" | "absolute";
type SeriesAggregation = "raw" | "count" | "sum" | "min" | "max" | "mean" | "median" | "p50" | "p75" | "p90" | "p95" | "p99" | "rate" | "moving-average" | "exponential-smoothing" | "cumulative" | "histogram" | "anomaly";
type SeriesAnchor = "now" | "latest-run" | "scope-start" | "prompt" | "request" | "attempt" | "message" | "checkpoint" | "bookmark";
type SeriesComparison = "none" | "previous-window" | "baseline";
type SeriesBucket = "auto" | "5m" | "1h" | "1d";
type SeriesTimezone = "local" | "utc";
type SeriesDimension = "none" | "provider" | "model" | "role" | "project" | "conversation" | "branch" | "tool" | "error";
type CustomWindowUnit = "m" | "h" | "d";

type AbsoluteRangeResolution = {
  readonly valid: boolean;
  readonly start: string | null;
  readonly end: string | null;
  readonly error: string | null;
};

type EvidenceRow = {
  readonly metric: string;
  readonly value: string;
  readonly state: EvidenceState;
  readonly source: string;
  readonly coverage: string;
  readonly freshness: string;
  readonly reason: string;
};

const seedRows = [
  { id: "run-1", label: "Research notebook draft", provider: "Preview route", status: "active", usage: 38, cost: 0.12, source: "renderer-demo", coverage: "partial", freshness: "session" },
  { id: "run-2", label: "Project control review", provider: "Local route", status: "completed", usage: 74, cost: 0.24, source: "renderer-demo", coverage: "unknown", freshness: "session" },
  { id: "run-3", label: "Memory policy rehearsal", provider: "No provider", status: "planned", usage: 0, cost: 0, source: "renderer-demo", coverage: "not-available", freshness: "static" },
];

const seriesMetricMeta: Record<SeriesMetric, { readonly label: string; readonly unit: string; readonly description: string }> = {
  usage: { label: "Usage units", unit: "demo units", description: "Renderer-estimated usage, not provider token counters." },
  cost: { label: "Cost estimate", unit: "demo credits", description: "Synthetic cost estimate, not an invoice or provider price snapshot." },
  "active-runs": { label: "Active runs", unit: "runs", description: "Visible run cards in the renderer preview." },
  coverage: { label: "Evidence coverage", unit: "%", description: "Share of visible rows with partial or better evidence in this preview." },
  "generated-tps": { label: "Generated output token rate", unit: "demo tokens/s", description: "Illustrative generated-output TPS; synthetic renderer values, not a provider timing observation." },
  "input-tpm": { label: "Input token rate", unit: "demo tokens/min", description: "Illustrative input TPM; synthetic renderer values, not a provider-reported token counter." },
  "requests-rps": { label: "Request rate", unit: "demo requests/s", description: "Illustrative RPS; synthetic renderer values, not observed dispatch or acceptance events." },
  "requests-rpm": { label: "Request rate", unit: "demo requests/min", description: "Illustrative RPM; synthetic renderer values, not observed dispatch or acceptance events." },
  "visible-characters-per-second": { label: "Visible output character rate", unit: "demo characters/s", description: "Illustrative visible-character throughput; this is named explicitly instead of using an ambiguous CPS abbreviation." },
  "cost-per-second": { label: "Estimated cost rate", unit: "demo credits/s", description: "Illustrative cost/s concept using demo credits; currency, provider pricing, and invoice evidence are not connected." },
  "cost-per-minute": { label: "Estimated cost rate", unit: "demo credits/min", description: "Illustrative cost/min concept using demo credits; currency, provider pricing, and invoice evidence are not connected." },
  "cost-per-hour": { label: "Estimated cost rate", unit: "demo credits/hour", description: "Illustrative cost/hour concept using demo credits; currency, provider pricing, and invoice evidence are not connected." },
};

const seriesMetricNamespace: Record<SeriesMetric, string> = {
  usage: "usage.demo_units",
  cost: "cost.demo_credits",
  "active-runs": "runs.active_visible",
  coverage: "evidence.coverage_percent",
  "generated-tps": "tokens.generated_per_second",
  "input-tpm": "tokens.input_per_minute",
  "requests-rps": "requests.per_second",
  "requests-rpm": "requests.per_minute",
  "visible-characters-per-second": "characters.visible_per_second",
  "cost-per-second": "cost.currency_per_second",
  "cost-per-minute": "cost.currency_per_minute",
  "cost-per-hour": "cost.currency_per_hour",
};

const seriesSeeds: Record<SeriesMetric, readonly number[]> = {
  usage: [18, 26, 41, 34, 52, 74],
  cost: [0.04, 0.07, 0.11, 0.09, 0.16, 0.24],
  "active-runs": [0, 1, 2, 1, 2, 1],
  coverage: [25, 32, 31, 43, 50, 50],
  "generated-tps": [19, 22, 28, 25, 34, 38],
  "input-tpm": [180, 240, 310, 280, 420, 510],
  "requests-rps": [0.1, 0.2, 0.4, 0.3, 0.5, 0.6],
  "requests-rpm": [4, 7, 12, 9, 16, 19],
  "visible-characters-per-second": [62, 74, 88, 81, 103, 117],
  "cost-per-second": [0.001, 0.002, 0.003, 0.003, 0.004, 0.006],
  "cost-per-minute": [0.06, 0.12, 0.18, 0.16, 0.23, 0.31],
  "cost-per-hour": [2.1, 4.3, 6.7, 5.9, 8.4, 11.2],
};

const seriesLabels: Record<Exclude<SeriesWindow, "custom" | "absolute">, readonly string[]> = {
  "30m": ["-25m", "-20m", "-15m", "-10m", "-5m", "now"],
  "1h": ["-50m", "-40m", "-30m", "-20m", "-10m", "now"],
  "2h": ["-120m", "-96m", "-72m", "-48m", "-24m", "now"],
  "3h": ["-180m", "-144m", "-108m", "-72m", "-36m", "now"],
  "5h": ["-5h", "-4h", "-3h", "-2h", "-1h", "now"],
  "6h": ["-6h", "-5h", "-4h", "-3h", "-2h", "now"],
  "8h": ["-8h", "-6h", "-4h", "-3h", "-1h", "now"],
  "10h": ["-10h", "-8h", "-6h", "-4h", "-2h", "now"],
  "12h": ["-12h", "-10h", "-8h", "-6h", "-3h", "now"],
  "24h": ["-24h", "-20h", "-16h", "-12h", "-8h", "now"],
  "1d": ["-24h", "-20h", "-16h", "-12h", "-8h", "now"],
  "2d": ["-2d", "-36h", "-24h", "-12h", "-6h", "now"],
  "3d": ["-3d", "-60h", "-48h", "-24h", "-12h", "now"],
  "5d": ["-5d", "-4d", "-3d", "-2d", "-1d", "now"],
  "1w": ["-7d", "-6d", "-5d", "-3d", "-1d", "now"],
};

function customWindowLabel(value: number, unit: CustomWindowUnit): string {
  const safeValue = Math.max(1, Math.round(value));
  const unitLabel = unit === "m" ? "minute" : unit === "h" ? "hour" : "day";
  return `${safeValue} ${unitLabel}${safeValue === 1 ? "" : "s"}`;
}

function resolveAbsoluteRange(start: string, end: string): AbsoluteRangeResolution {
  const normalizedStart = start.trim() || null;
  const normalizedEnd = end.trim() || null;
  if (normalizedStart === null || normalizedEnd === null) {
    return { valid: false, start: normalizedStart, end: normalizedEnd, error: "start-and-end-required" };
  }
  const startMs = Date.parse(normalizedStart);
  const endMs = Date.parse(normalizedEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { valid: false, start: normalizedStart, end: normalizedEnd, error: "invalid-date-time" };
  }
  if (startMs >= endMs) {
    return { valid: false, start: normalizedStart, end: normalizedEnd, error: "start-must-precede-end" };
  }
  return { valid: true, start: normalizedStart, end: normalizedEnd, error: null };
}

function absoluteDateLabel(value: string | null): string {
  if (!value) return "unset";
  return value.replace("T", " ");
}

function labelsForAbsoluteRange(range: AbsoluteRangeResolution): readonly string[] {
  if (!range.valid || !range.start || !range.end) return ["invalid-start", "unresolved-1", "unresolved-2", "unresolved-3", "unresolved-4", "invalid-end"];
  const startMs = Date.parse(range.start);
  const endMs = Date.parse(range.end);
  const span = endMs - startMs;
  return [0, .2, .4, .6, .8, 1].map((fraction, index) => {
    if (index === 0) return absoluteDateLabel(range.start);
    if (index === 5) return absoluteDateLabel(range.end);
    return absoluteDateLabel(new Date(startMs + (span * fraction)).toISOString().slice(0, 16));
  });
}

function labelsForWindow(window: SeriesWindow, customValue: number, customUnit: CustomWindowUnit, absoluteRange: AbsoluteRangeResolution): readonly string[] {
  if (window === "absolute") return labelsForAbsoluteRange(absoluteRange);
  if (window !== "custom") return seriesLabels[window];
  const value = Math.max(1, Math.round(customValue));
  const points = [1, .8, .6, .4, .2, 0].map((fraction) => Math.max(0, Math.round(value * fraction)));
  return points.map((point, index) => index === points.length - 1 ? "now" : `-${point}${customUnit}`);
}

function aggregateSeries(values: readonly number[], aggregation: SeriesAggregation): readonly number[] {
  if (aggregation === "raw") return values;
  if (aggregation === "count") return values.map(() => 1);
  if (aggregation === "cumulative") {
    let running = 0;
    return values.map((value) => { running += value; return Number(running.toFixed(2)); });
  }
  if (aggregation === "sum") {
    let running = 0;
    return values.map((value) => { running += value; return Number(running.toFixed(2)); });
  }
  if (aggregation === "rate") {
    return values.map((value, index) => Number((index === 0 ? value : value - (values[index - 1] ?? 0)).toFixed(2)));
  }
  if (aggregation === "histogram") return values.map((value) => Math.max(1, Math.round(value / Math.max(...values, 1) * 5)));
  if (aggregation === "anomaly") {
    const baseline = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    return values.map((value) => Number((value - baseline).toFixed(2)));
  }
  if (aggregation === "exponential-smoothing") {
    let smoothed = values[0] ?? 0;
    return values.map((value, index) => {
      if (index > 0) smoothed = (value * .4) + (smoothed * .6);
      return Number(smoothed.toFixed(2));
    });
  }
  if (aggregation === "min" || aggregation === "max" || aggregation === "mean" || aggregation === "median" || aggregation.startsWith("p")) {
    return values.map((_, index) => {
      const window = [...values.slice(Math.max(0, index - 2), index + 1)].sort((left, right) => left - right);
      if (aggregation === "min") return window[0] ?? 0;
      if (aggregation === "max") return window.at(-1) ?? 0;
      if (aggregation === "mean") return Number((window.reduce((sum, point) => sum + point, 0) / window.length).toFixed(2));
      const percentile = aggregation === "median" || aggregation === "p50" ? .5 : Number(aggregation.slice(1)) / 100;
      return Number((window[Math.min(window.length - 1, Math.round((window.length - 1) * percentile))] ?? 0).toFixed(2));
    });
  }
  return values.map((_, index) => {
    const window = values.slice(Math.max(0, index - 2), index + 1);
    return Number((window.reduce((sum, point) => sum + point, 0) / window.length).toFixed(2));
  });
}

function formatSeriesValue(value: number, metric: SeriesMetric): string {
  if (metric === "cost") return value.toFixed(2);
  if (metric === "cost-per-second") return value.toFixed(4);
  if (metric === "requests-rps") return value.toFixed(2);
  if (metric === "coverage") return `${Math.round(value)}%`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function comparisonLabel(comparison: SeriesComparison): string {
  if (comparison === "previous-window") return "Previous window";
  if (comparison === "baseline") return "Renderer baseline";
  return "No comparison";
}

function anchorLabelFor(anchor: SeriesAnchor): string {
  const labels: Record<SeriesAnchor, string> = {
    now: "Now",
    "latest-run": "Latest visible run",
    "scope-start": "Scope start",
    prompt: "Prompt",
    request: "Request",
    attempt: "Provider attempt",
    message: "Message",
    checkpoint: "Checkpoint",
    bookmark: "User bookmark",
  };
  return labels[anchor];
}

function dimensionLabelFor(dimension: SeriesDimension): string {
  if (dimension === "none") return "No split";
  return dimension.charAt(0).toUpperCase() + dimension.slice(1);
}

export function ObservabilityPreview() {
  const [scope, setScope] = useState<Scope>("workspace");
  const [filter, setFilter] = useState("all");
  const [format, setFormat] = useState<ExportFormat>("json");
  const [seriesMetric, setSeriesMetric] = useState<SeriesMetric>("usage");
  const [seriesWindow, setSeriesWindow] = useState<SeriesWindow>("2h");
  const [seriesAggregation, setSeriesAggregation] = useState<SeriesAggregation>("raw");
  const [seriesAnchor, setSeriesAnchor] = useState<SeriesAnchor>("now");
  const [seriesComparison, setSeriesComparison] = useState<SeriesComparison>("none");
  const [seriesBucket, setSeriesBucket] = useState<SeriesBucket>("auto");
  const [seriesTimezone, setSeriesTimezone] = useState<SeriesTimezone>("local");
  const [seriesDimension, setSeriesDimension] = useState<SeriesDimension>("none");
  const [customWindowValue, setCustomWindowValue] = useState(90);
  const [customWindowUnit, setCustomWindowUnit] = useState<CustomWindowUnit>("m");
  const [seriesAnchorReference, setSeriesAnchorReference] = useState("");
  const [absoluteRangeStart, setAbsoluteRangeStart] = useState("");
  const [absoluteRangeEnd, setAbsoluteRangeEnd] = useState("");
  const [absoluteStartAnchor, setAbsoluteStartAnchor] = useState<SeriesAnchor>("scope-start");
  const [absoluteEndAnchor, setAbsoluteEndAnchor] = useState<SeriesAnchor>("now");
  const [absoluteStartReference, setAbsoluteStartReference] = useState("");
  const [absoluteEndReference, setAbsoluteEndReference] = useState("");
  const [status, setStatus] = useState("Demo metrics are renderer-local and session-scoped.");
  const rows = useMemo(() => filter === "all" ? seedRows : seedRows.filter((row) => row.status === filter), [filter]);
  const totals = useMemo(() => ({ usage: rows.reduce((sum, row) => sum + row.usage, 0), cost: rows.reduce((sum, row) => sum + row.cost, 0), quota: null as number | null }), [rows]);
  const absoluteRange = useMemo(() => resolveAbsoluteRange(absoluteRangeStart, absoluteRangeEnd), [absoluteRangeEnd, absoluteRangeStart]);
  const selectedSeries = useMemo(() => {
    const metric = seriesMetricMeta[seriesMetric];
    const base = seriesSeeds[seriesMetric].map((value) => {
      if (seriesMetric === "usage" && rows.length !== seedRows.length) return Number((value * rows.length / seedRows.length).toFixed(2));
      if (seriesMetric === "cost" && rows.length !== seedRows.length) return Number((value * rows.length / seedRows.length).toFixed(2));
      if (seriesMetric === "active-runs") return rows.filter((row) => row.status === "active").length > 0 ? value : 0;
      return value;
    });
    return { metric, values: aggregateSeries(base, seriesAggregation), labels: labelsForWindow(seriesWindow, customWindowValue, customWindowUnit, absoluteRange) };
  }, [absoluteRange, customWindowUnit, customWindowValue, rows, seriesAggregation, seriesMetric, seriesWindow]);
  const seriesMax = Math.max(...selectedSeries.values, 1);
  const anchorLabel = anchorLabelFor(seriesAnchor);
  const dimensionLabel = dimensionLabelFor(seriesDimension);
  const aggregationLabel = seriesAggregation === "raw" ? "Raw observations" : seriesAggregation.replaceAll("-", " ");
  const absoluteRangeLabel = absoluteRange.valid
    ? `${absoluteDateLabel(absoluteRange.start)} → ${absoluteDateLabel(absoluteRange.end)}`
    : "Incomplete absolute range";
  const absoluteRangeErrorLabel = absoluteRange.error === "start-and-end-required"
    ? "Choose both a start and end date-time."
    : absoluteRange.error === "invalid-date-time"
      ? "Enter valid date-time values."
      : absoluteRange.error === "start-must-precede-end"
        ? "Start must be earlier than end."
        : null;
  const absoluteQueryUnavailable = seriesWindow === "absolute" && !absoluteRange.valid;
  const comparisonSeries = useMemo(() => {
    if (seriesComparison === "none" || (seriesWindow === "absolute" && !absoluteRange.valid)) return null;
    const multiplier = seriesComparison === "previous-window" ? 0.82 : 0.68;
    const values = selectedSeries.values.map((value, index) => value === 0
      ? 0
      : Number((Math.max(0, value * multiplier + (index % 2 === 0 ? 0 : 0.01))).toFixed(2)));
    return { label: comparisonLabel(seriesComparison), values };
  }, [absoluteRange.valid, selectedSeries.values, seriesComparison, seriesWindow]);
  const latestDelta = comparisonSeries === null ? null : Number((selectedSeries.values.at(-1)! - comparisonSeries.values.at(-1)!).toFixed(2));
  const latestDeltaPercent = comparisonSeries === null || comparisonSeries.values.at(-1) === 0
    ? null
    : Number(((latestDelta! / comparisonSeries.values.at(-1)!) * 100).toFixed(1));
  const latestDeltaSummary = comparisonSeries === null
    ? "Unknown"
    : latestDeltaPercent === null
      ? `${formatSeriesValue(latestDelta ?? 0, seriesMetric)} (percentage unavailable: comparison denominator is zero)`
      : `${formatSeriesValue(latestDelta ?? 0, seriesMetric)} (${latestDeltaPercent}% vs ${comparisonSeries.label.toLowerCase()})`;
  const evidenceRows = useMemo<readonly EvidenceRow[]>(() => [
    {
      metric: "Usage counters",
      value: `${totals.usage} demo units`,
      state: "estimated",
      source: "renderer-demo",
      coverage: "partial",
      freshness: "session-only",
      reason: "Not provider-reported token counters; missing counters stay unknown.",
    },
    {
      metric: "Cost",
      value: `${totals.cost.toFixed(2)} demo credits`,
      state: "estimated",
      source: "renderer-demo",
      coverage: "partial",
      freshness: "session-only",
      reason: "No frozen price snapshot, provider report, or invoice is connected.",
    },
    {
      metric: "Quota headroom",
      value: "Unknown",
      state: "unknown",
      source: "not-collected",
      coverage: "unknown",
      freshness: "not-collected",
      reason: "No provider quota snapshot is available; unknown is not unlimited.",
    },
    {
      metric: "Provider health",
      value: "Unknown",
      state: "unknown",
      source: "not-collected",
      coverage: "unknown",
      freshness: "not-collected",
      reason: "Browser preview does not query authentication, transport, or model health.",
    },
    {
      metric: "Visible throughput",
      value: "Unknown",
      state: "unknown",
      source: "not-collected",
      coverage: "unknown",
      freshness: "not-collected",
      reason: "No monotonic timing marks or visible-output token observation is connected.",
    },
    {
      metric: "Durable telemetry receipt",
      value: "Planned",
      state: "planned",
      source: "native-runtime",
      coverage: "unknown",
      freshness: "not-collected",
      reason: "Native journal, ledger, retention, and export checkpoint are not wired to this preview.",
    },
  ], [totals]);
  const payload = useMemo(() => {
    const data = {
      schema: "omnia.observability.preview.v1",
      scope: "renderer-session",
      selectedScope: scope,
      source: "renderer-demo",
      coverage: "partial",
      freshness: "session-only",
      rows,
      totals,
      evidence: evidenceRows,
      timeSeries: {
        metric: seriesMetric,
        namespace: seriesMetricNamespace[seriesMetric],
        unit: selectedSeries.metric.unit,
        window: seriesWindow,
        customWindow: seriesWindow === "custom" ? { value: Math.max(1, Math.round(customWindowValue)), unit: customWindowUnit, label: customWindowLabel(customWindowValue, customWindowUnit) } : null,
        absoluteRange: seriesWindow === "absolute" ? {
          start: absoluteRange.start,
          end: absoluteRange.end,
          valid: absoluteRange.valid,
          error: absoluteRange.error,
          leftBoundary: { anchor: absoluteStartAnchor, label: anchorLabelFor(absoluteStartAnchor), reference: absoluteStartReference.trim() || null },
          rightBoundary: { anchor: absoluteEndAnchor, label: anchorLabelFor(absoluteEndAnchor), reference: absoluteEndReference.trim() || null },
          resolution: "renderer-preview-only",
        } : null,
        bucket: seriesBucket,
        timezone: seriesTimezone,
        anchor: { kind: seriesAnchor, label: anchorLabel, reference: seriesAnchorReference.trim() || null, resolution: "renderer-preview-only" },
        aggregation: seriesAggregation,
        dimension: { kind: seriesDimension, label: dimensionLabel, resolution: "renderer-preview-only" },
        values: selectedSeries.values,
        labels: selectedSeries.labels,
        comparison: comparisonSeries === null ? null : {
          period: seriesComparison,
          label: comparisonSeries.label,
          values: comparisonSeries.values,
          latestDelta: {
            value: latestDelta,
            percentage: latestDeltaPercent,
            unknownReason: latestDeltaPercent === null ? "comparison-denominator-zero" : null,
          },
          source: "renderer-demo",
          coverage: "partial",
          freshness: "session-only",
        },
        source: "renderer-demo",
        coverage: "partial",
        freshness: "session-only",
      },
      missing: ["provider health", "durable usage ledger", "quota receipts", "native export checkpoint", "native anchor resolution", "metric query engine", "native dimension cardinality guard", "native absolute range resolver"],
    };
    if (format === "json") return JSON.stringify(data, null, 2);
    return `# Omnia observability preview\n\n- Scope: ${scope}\n- Usage units: ${totals.usage}\n- Cost estimate: ${totals.cost.toFixed(2)}\n- Quota headroom: Unknown\n\n## Time-series query preview\n\n- Metric: ${selectedSeries.metric.label} (${selectedSeries.metric.unit})\n- Namespace: ${seriesMetricNamespace[seriesMetric]}\n- Window: ${seriesWindow === "custom" ? customWindowLabel(customWindowValue, customWindowUnit) : seriesWindow === "absolute" ? absoluteRangeLabel : seriesWindow}\n- Bucket: ${seriesBucket}\n- Timezone: ${seriesTimezone}\n- Anchor: ${anchorLabel}${seriesAnchorReference.trim() ? ` · reference ${seriesAnchorReference.trim()}` : ""} (renderer preview only)\n${seriesWindow === "absolute" ? `- Absolute left boundary: ${anchorLabelFor(absoluteStartAnchor)}${absoluteStartReference.trim() ? ` · reference ${absoluteStartReference.trim()}` : ""}\n- Absolute right boundary: ${anchorLabelFor(absoluteEndAnchor)}${absoluteEndReference.trim() ? ` · reference ${absoluteEndReference.trim()}` : ""}\n- Absolute range validation: ${absoluteRangeErrorLabel ?? "valid"} (renderer preview only)\n` : ""}- Aggregation: ${aggregationLabel}\n- Dimension: ${dimensionLabel}\n- Comparison: ${comparisonSeries?.label ?? "None"}\n- Latest delta: ${latestDeltaSummary}\n- Values: ${selectedSeries.values.map((value) => formatSeriesValue(value, seriesMetric)).join(", ")}\n\n## Evidence truth surface\n\n${evidenceRows.map((entry) => `- ${entry.metric}: ${entry.value} (${entry.state}; source: ${entry.source}; coverage: ${entry.coverage}; freshness: ${entry.freshness})`).join("\n")}\n\nSource: renderer-demo · coverage: partial · freshness: session-only\nNative telemetry, provider quota, anchor resolution, timezone conversion, bucket rollups, dimension cardinality, comparison receipts, and durable export receipts are not connected.\n`;
  }, [absoluteEndAnchor, absoluteEndReference, absoluteRange, absoluteRangeErrorLabel, absoluteRangeLabel, absoluteStartAnchor, absoluteStartReference, aggregationLabel, anchorLabel, comparisonSeries, customWindowUnit, customWindowValue, dimensionLabel, evidenceRows, format, latestDeltaSummary, rows, scope, selectedSeries, seriesAnchorReference, seriesAggregation, seriesBucket, seriesMetric, seriesTimezone, seriesWindow, totals]);
  const copy = async () => {
    if (!navigator.clipboard?.writeText) { setStatus("Clipboard unavailable; no observability preview was copied."); return; }
    try { await navigator.clipboard.writeText(payload); setStatus(`Copied ${format.toUpperCase()} observability preview.`); } catch { setStatus("Clipboard access was denied; nothing was copied."); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `omnia-observability-preview.${format === "json" ? "json" : "md"}`; anchor.click(); URL.revokeObjectURL(url); setStatus("Downloaded a renderer-local observability preview.");
  };
  const resetSeriesQuery = () => {
    setSeriesMetric("usage");
    setSeriesWindow("2h");
    setSeriesAggregation("raw");
    setSeriesAnchor("now");
    setSeriesAnchorReference("");
    setSeriesComparison("none");
    setSeriesBucket("auto");
    setSeriesTimezone("local");
    setSeriesDimension("none");
    setCustomWindowValue(90);
    setCustomWindowUnit("m");
    setAbsoluteRangeStart("");
    setAbsoluteRangeEnd("");
    setAbsoluteStartAnchor("scope-start");
    setAbsoluteEndAnchor("now");
    setAbsoluteStartReference("");
    setAbsoluteEndReference("");
    setStatus("Reset the renderer-local time-series query to defaults.");
  };
  return <section className="observability-preview" aria-labelledby="observability-preview-heading">
    <header className="observability-preview__header"><div><span className="eyebrow">Telemetry · usage · quota</span><h2 id="observability-preview-heading">Observability &amp; cost</h2><p>One place to inspect what a run would report, how fresh it is, and what evidence is still missing.</p></div><span className="observability-preview__badge"><Sparkles size={13} /> Renderer demo</span></header>
    <PerformanceSignalStrip />
    <div className="observability-preview__toolbar"><label><span>Scope</span><select value={scope} onChange={(event) => setScope(event.target.value as Scope)}><option value="workspace">Workspace</option><option value="project">Project</option><option value="chat">Chat</option></select></label><label><span>Status</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All rows</option><option value="active">Active</option><option value="completed">Completed</option><option value="planned">Planned</option></select></label><span className="observability-preview__status" role="status" aria-live="polite">{status}</span></div>
    <div className="observability-preview__metrics"><article><Activity size={16} /><span>Usage units</span><strong>{totals.usage}</strong><small>renderer estimate</small></article><article><BarChart3 size={16} /><span>Cost estimate</span><strong>{totals.cost.toFixed(2)}</strong><small>not provider invoiced</small></article><article><Gauge size={16} /><span>Quota headroom</span><strong>Unknown</strong><small>no provider snapshot</small></article><article><ShieldCheck size={16} /><span>Evidence coverage</span><strong>Partial</strong><small>native read planned</small></article></div>
    <div className="observability-preview__table-wrap"><table><caption>Run observations for {scope}</caption><thead><tr><th>Run</th><th>State</th><th>Usage</th><th>Cost</th><th>Coverage</th><th>Freshness</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><strong>{row.label}</strong><small>{row.provider} · {row.source}</small></td><td><span className={`observability-preview__state observability-preview__state--${row.status}`}>{row.status}</span></td><td>{row.usage}</td><td>{row.cost.toFixed(2)}</td><td>{row.coverage}</td><td>{row.freshness}</td></tr>)}</tbody></table></div>
    <section className="observability-preview__series" aria-label="Observability time-series analytics preview" aria-describedby="observability-series-boundary">
      <header>
        <div><span className="eyebrow">Trend explorer · query rehearsal</span><h3>Time-series analytics preview</h3><p>Explore exact units, windows, anchors, comparison periods, bucket size, timezone, dimensions and aggregation before a native telemetry query engine is connected.</p></div>
        <span className="observability-preview__truth-badge"><TrendingUp size={13} /> Renderer-local</span>
      </header>
      <div className="observability-preview__series-controls">
        <label><span>Metric</span><select aria-label="Series metric" value={seriesMetric} onChange={(event) => setSeriesMetric(event.target.value as SeriesMetric)}>
          <optgroup label="Usage and throughput">
            <option value="usage">Usage units · demo units</option>
            <option value="generated-tps">Generated output tokens / second · TPS</option>
            <option value="input-tpm">Input tokens / minute · TPM</option>
            <option value="requests-rps">Requests / second · RPS</option>
            <option value="requests-rpm">Requests / minute · RPM</option>
            <option value="visible-characters-per-second">Visible output characters / second</option>
          </optgroup>
          <optgroup label="Cost (illustrative demo credits)">
            <option value="cost">Estimated total · demo credits</option>
            <option value="cost-per-second">Estimated cost / second · demo credits/s</option>
            <option value="cost-per-minute">Estimated cost / minute · demo credits/min</option>
            <option value="cost-per-hour">Estimated cost / hour · demo credits/hour</option>
          </optgroup>
          <optgroup label="Preview context">
            <option value="active-runs">Active runs · runs</option>
            <option value="coverage">Evidence coverage · %</option>
          </optgroup>
        </select></label>
        <label><span>Window</span><select aria-label="Series window" value={seriesWindow} onChange={(event) => setSeriesWindow(event.target.value as SeriesWindow)}><option value="30m">30 minutes</option><option value="1h">1 hour</option><option value="2h">2 hours</option><option value="3h">3 hours</option><option value="5h">5 hours</option><option value="6h">6 hours</option><option value="8h">8 hours</option><option value="10h">10 hours</option><option value="12h">12 hours</option><option value="24h">24 hours</option><option value="1d">1 day</option><option value="2d">2 days</option><option value="3d">3 days</option><option value="5d">5 days</option><option value="1w">1 week</option><option value="custom">Custom relative duration</option><option value="absolute">Absolute start / end</option></select></label>
        {seriesWindow === "custom" ? <><label><span>Length</span><input aria-label="Custom series window length" type="number" min={1} max={365} value={customWindowValue} onChange={(event) => setCustomWindowValue(Math.max(1, Math.min(365, Number(event.target.value) || 1)))} /></label><label><span>Length unit</span><select aria-label="Custom series window unit" value={customWindowUnit} onChange={(event) => setCustomWindowUnit(event.target.value as CustomWindowUnit)}><option value="m">Minutes</option><option value="h">Hours</option><option value="d">Days</option></select></label></> : null}
        {seriesWindow === "absolute" ? <div className="observability-preview__absolute-range" role="group" aria-label="Absolute series range controls">
          <div className="observability-preview__absolute-range-heading"><strong>Absolute range</strong><span>Independent left and right boundaries</span></div>
          <label><span>Start date-time</span><input aria-label="Absolute range start" type="datetime-local" value={absoluteRangeStart} onChange={(event) => setAbsoluteRangeStart(event.target.value)} /></label>
          <label><span>End date-time</span><input aria-label="Absolute range end" type="datetime-local" min={absoluteRangeStart || undefined} value={absoluteRangeEnd} onChange={(event) => setAbsoluteRangeEnd(event.target.value)} /></label>
          <label><span>Start anchor</span><select aria-label="Absolute range start anchor" value={absoluteStartAnchor} onChange={(event) => setAbsoluteStartAnchor(event.target.value as SeriesAnchor)}><option value="scope-start">Scope start</option><option value="now">Now</option><option value="latest-run">Latest visible run</option><option value="prompt">Prompt</option><option value="request">Request</option><option value="attempt">Provider attempt</option><option value="message">Message</option><option value="checkpoint">Checkpoint</option><option value="bookmark">User bookmark</option></select></label>
          <label><span>Start reference</span><input aria-label="Absolute range start reference" value={absoluteStartReference} onChange={(event) => setAbsoluteStartReference(event.target.value)} placeholder="prompt-3 or scope id" /></label>
          <label><span>End anchor</span><select aria-label="Absolute range end anchor" value={absoluteEndAnchor} onChange={(event) => setAbsoluteEndAnchor(event.target.value as SeriesAnchor)}><option value="now">Now</option><option value="latest-run">Latest visible run</option><option value="scope-start">Scope start</option><option value="prompt">Prompt</option><option value="request">Request</option><option value="attempt">Provider attempt</option><option value="message">Message</option><option value="checkpoint">Checkpoint</option><option value="bookmark">User bookmark</option></select></label>
          <label><span>End reference</span><input aria-label="Absolute range end reference" value={absoluteEndReference} onChange={(event) => setAbsoluteEndReference(event.target.value)} placeholder="run-7 or bookmark id" /></label>
          <p className={`observability-preview__absolute-range-validation${absoluteRange.valid ? " is-valid" : ""}`} role="status" aria-live="polite">{absoluteRange.valid ? `Valid preview range: ${absoluteRangeLabel}` : absoluteRangeErrorLabel}</p>
        </div> : null}
        <label><span>Bucket</span><select aria-label="Series bucket" value={seriesBucket} onChange={(event) => setSeriesBucket(event.target.value as SeriesBucket)}><option value="auto">Auto</option><option value="5m">5 minutes</option><option value="1h">1 hour</option><option value="1d">1 day</option></select></label>
        <label><span>Timezone</span><select aria-label="Series timezone" value={seriesTimezone} onChange={(event) => setSeriesTimezone(event.target.value as SeriesTimezone)}><option value="local">Local</option><option value="utc">UTC</option></select></label>
        <label><span>Anchor</span><select aria-label="Series anchor" value={seriesAnchor} onChange={(event) => setSeriesAnchor(event.target.value as SeriesAnchor)}><option value="now">Now</option><option value="latest-run">Latest visible run</option><option value="scope-start">Scope start</option><option value="prompt">Prompt</option><option value="request">Request</option><option value="attempt">Provider attempt</option><option value="message">Message</option><option value="checkpoint">Checkpoint</option><option value="bookmark">User bookmark</option></select></label>
        <label><span>Anchor reference</span><input aria-label="Series anchor reference" value={seriesAnchorReference} onChange={(event) => setSeriesAnchorReference(event.target.value)} placeholder="run-2 or bookmark id" /></label>
        <label><span>Aggregation</span><select aria-label="Series aggregation" value={seriesAggregation} onChange={(event) => setSeriesAggregation(event.target.value as SeriesAggregation)}><option value="raw">Raw observations</option><option value="count">Count</option><option value="sum">Sum</option><option value="min">Minimum</option><option value="max">Maximum</option><option value="mean">Mean</option><option value="median">Median</option><option value="p50">P50</option><option value="p75">P75</option><option value="p90">P90</option><option value="p95">P95</option><option value="p99">P99</option><option value="rate">Rate</option><option value="moving-average">Moving average</option><option value="exponential-smoothing">Exponential smoothing</option><option value="cumulative">Cumulative total</option><option value="histogram">Histogram buckets</option><option value="anomaly">Anomaly delta</option></select></label>
        <label><span>Compare</span><select aria-label="Series comparison" value={seriesComparison} onChange={(event) => setSeriesComparison(event.target.value as SeriesComparison)}><option value="none">None</option><option value="previous-window">Previous window</option><option value="baseline">Renderer baseline</option></select></label>
        <label><span>Dimension</span><select aria-label="Series dimension" value={seriesDimension} onChange={(event) => setSeriesDimension(event.target.value as SeriesDimension)}><option value="none">No split</option><option value="provider">Provider</option><option value="model">Model/profile</option><option value="role">Main/subagent/role</option><option value="project">Project</option><option value="conversation">Conversation</option><option value="branch">Branch/fork</option><option value="tool">Tool</option><option value="error">Error/retry/fallback</option></select></label>
        <button type="button" className="button button--ghost" aria-label="Reset time-series query" onClick={resetSeriesQuery}>Reset query</button>
      </div>
      <div className="observability-preview__series-meta"><strong>{selectedSeries.metric.label}</strong><span title={seriesMetricNamespace[seriesMetric]}>Namespace: {seriesMetricNamespace[seriesMetric]}</span><span>Unit: {selectedSeries.metric.unit}</span><span>Window: {seriesWindow === "custom" ? customWindowLabel(customWindowValue, customWindowUnit) : seriesWindow === "absolute" ? absoluteRangeLabel : seriesWindow}</span><span>Bucket: {seriesBucket}</span><span>Timezone: {seriesTimezone}</span><span>Anchor: {seriesWindow === "absolute" ? `${anchorLabelFor(absoluteStartAnchor)} → ${anchorLabelFor(absoluteEndAnchor)}` : anchorLabel}</span><span>Dimension: {dimensionLabel}</span><span>Compare: {comparisonSeries?.label ?? "None"}</span><span className="observability-preview__series-resolution">{absoluteQueryUnavailable ? "Absolute range unresolved" : "Unresolved preview anchor"}</span></div>
      <div className="observability-preview__series-delta" role="status" aria-live="polite">{comparisonSeries === null ? "No comparison period selected." : `Latest delta: ${latestDeltaSummary}`}</div>
      <div className="observability-preview__chart" role="img" aria-label={`${selectedSeries.metric.label} ${seriesAggregation} chart in ${seriesWindow} window`}>
        {selectedSeries.values.map((value, index) => <div className="observability-preview__chart-column" key={`${selectedSeries.labels[index]}-${value}`}><span className="observability-preview__chart-value">{formatSeriesValue(value, seriesMetric)}</span><div className="observability-preview__chart-track"><div className="observability-preview__chart-bar" style={{ height: `${Math.max(8, (value / seriesMax) * 100)}%` }} /></div><span className="observability-preview__chart-label">{selectedSeries.labels[index]}</span></div>)}
      </div>
      <div className="observability-preview__series-table-wrap"><table><caption>Exact preview values for {selectedSeries.metric.label} ({selectedSeries.metric.unit})</caption><thead><tr>{selectedSeries.labels.map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody><tr>{selectedSeries.values.map((value, index) => <td key={`${selectedSeries.labels[index]}-${value}`}>{formatSeriesValue(value, seriesMetric)}</td>)}</tr>{comparisonSeries === null ? null : <tr className="observability-preview__series-comparison-row"><th scope="row">{comparisonSeries.label}</th>{comparisonSeries.values.map((value, index) => <td key={`${selectedSeries.labels[index]}-${value}-comparison`}>{formatSeriesValue(value, seriesMetric)}</td>)}</tr>}</tbody></table></div>
      <p className="observability-preview__series-note" id="observability-series-boundary">{selectedSeries.metric.description} This series is synthetic, session-scoped and partial; anchor IDs, native buckets, provider observations, dimensions, comparison receipts and quantile sketches are not connected.</p>
    </section>
    <section className="observability-preview__truth" aria-label="Observability evidence truth surface"><header><div><span className="eyebrow">Evidence contract</span><h3>What each number means</h3><p>Every value keeps its provenance visible. Estimated values are not provider reports, and unknown values are not zero or unlimited.</p></div><span className="observability-preview__truth-badge">Renderer-local</span></header><div className="observability-preview__truth-table-wrap"><table><caption>Metric evidence for {scope}</caption><thead><tr><th>Metric</th><th>Value</th><th>State</th><th>Source</th><th>Coverage</th><th>Freshness</th><th>Reason</th></tr></thead><tbody>{evidenceRows.map((entry) => <tr key={entry.metric}><th scope="row">{entry.metric}</th><td><strong>{entry.value}</strong></td><td><span className={`observability-preview__truth-state observability-preview__truth-state--${entry.state}`}>{entry.state}</span></td><td>{entry.source}</td><td>{entry.coverage}</td><td>{entry.freshness}</td><td>{entry.reason}</td></tr>)}</tbody></table></div></section>
    <section className="observability-preview__export" aria-label="Observability export preview"><div className="observability-preview__export-toolbar"><label><span>Format</span><select aria-label="Observability export format" value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={download}><Download size={13} /> Download</button></div><pre tabIndex={0}><code>{payload}</code></pre></section>
    <p className="observability-preview__boundary"><Cloud size={14} /> This is a renderer-local projection. It does not query provider health, persist usage, reserve quota, or produce a native telemetry receipt.</p>
  </section>;
}

export default ObservabilityPreview;
