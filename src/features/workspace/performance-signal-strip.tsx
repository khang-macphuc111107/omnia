import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Download,
  Gauge,
  Info,
  ListFilter,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  buildPerformanceSignalProjection,
  performanceSignalSummary,
  serializePerformanceSignalProjection,
  type PerformanceSignalEvidence,
  type PerformanceSignalFormat,
  type PerformanceSignalMetricInput,
  type PerformanceSignalProjection,
  type PerformanceSignalRecord,
  type PerformanceSignalStatus,
} from "./performance-signal-contract";

export type PerformanceSignalFilter = "all" | "measured" | "attention" | "unknown" | "planned";

const EMPTY_METRICS: readonly PerformanceSignalMetricInput[] = [];
const FILTERS: readonly { readonly id: PerformanceSignalFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "measured", label: "Measured" },
  { id: "attention", label: "Attention" },
  { id: "unknown", label: "Unknown" },
  { id: "planned", label: "Planned" },
];

export interface PerformanceSignalStripProps {
  readonly metrics?: readonly PerformanceSignalMetricInput[];
  readonly generatedAt?: string;
  readonly sourceSnapshot?: string;
  readonly title?: string;
  readonly onOpenDiagnostics?: () => void;
}

function filterSignals(signals: readonly PerformanceSignalRecord[], filter: PerformanceSignalFilter): PerformanceSignalRecord[] {
  if (filter === "measured") return signals.filter((signal) => signal.evidence === "measured" || signal.evidence === "estimated");
  if (filter === "attention") return signals.filter((signal) => signal.status === "fail" || signal.status === "watch");
  if (filter === "unknown") return signals.filter((signal) => signal.status === "unknown");
  if (filter === "planned") return signals.filter((signal) => signal.status === "planned");
  return [...signals];
}

function filterCount(projection: PerformanceSignalProjection, filter: PerformanceSignalFilter): number {
  if (filter === "all") return projection.counts.total;
  if (filter === "measured") return projection.counts.measured;
  if (filter === "attention") return projection.counts.fail + projection.counts.watch;
  if (filter === "unknown") return projection.counts.unknown;
  return projection.counts.planned;
}

function statusIcon(status: PerformanceSignalStatus) {
  if (status === "pass") return <CheckCircle2 size={14} aria-hidden="true" />;
  if (status === "fail") return <XCircle size={14} aria-hidden="true" />;
  if (status === "watch") return <TriangleAlert size={14} aria-hidden="true" />;
  if (status === "planned") return <Gauge size={14} aria-hidden="true" />;
  return <Info size={14} aria-hidden="true" />;
}

function formatValue(value: number | null, unit: string): string {
  if (value === null) return "Unknown";
  return `${Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(2)} ${unit}`;
}

function evidenceLabel(evidence: PerformanceSignalEvidence): string {
  if (evidence === "measured") return "Measured";
  if (evidence === "estimated") return "Estimated";
  if (evidence === "planned") return "Planned";
  return "Unknown";
}

function signalStatusLabel(status: PerformanceSignalStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function countSummary(projection: PerformanceSignalProjection): string {
  if (projection.counts.fail > 0) return `${projection.counts.fail} signal${projection.counts.fail === 1 ? "" : "s"} need review`;
  if (projection.counts.watch > 0) return `${projection.counts.watch} runner-defined signal${projection.counts.watch === 1 ? "" : "s"} to watch`;
  if (projection.counts.measured === 0) return "No runner samples supplied";
  return "Measured signals are within the available targets";
}

export function PerformanceSignalStrip({
  metrics = EMPTY_METRICS,
  generatedAt,
  sourceSnapshot,
  title = "Performance signals",
  onOpenDiagnostics,
}: PerformanceSignalStripProps) {
  const [filter, setFilter] = useState<PerformanceSignalFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [format, setFormat] = useState<PerformanceSignalFormat>("json");
  const [status, setStatus] = useState("Renderer-local performance projection; no runtime collection started.");
  const projection = useMemo(
    () => buildPerformanceSignalProjection({ metrics, generatedAt, sourceSnapshot }),
    [generatedAt, metrics, sourceSnapshot],
  );
  const visibleSignals = useMemo(() => filterSignals(projection.signals, filter), [filter, projection.signals]);
  const selected = visibleSignals.find((signal) => signal.id === selectedId) ?? visibleSignals[0] ?? null;
  const payload = useMemo(() => serializePerformanceSignalProjection(projection, format), [format, projection]);

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard is unavailable; no performance export was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(`${format.toUpperCase()} performance projection copied; no durable write was made.`);
    } catch {
      setStatus("Clipboard access was denied; the performance projection remains renderer-local.");
    }
  };

  const download = () => {
    if (typeof URL.createObjectURL !== "function") {
      setStatus("Browser download is unavailable; no performance export was created.");
      return;
    }
    const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `omnia-performance-signals-preview.${format === "json" ? "json" : "md"}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(`Started a renderer-local ${format.toUpperCase()} performance export.`);
  };

  return (
    <section className="performance-signal-strip" aria-label="Performance signals">
      <header className="performance-signal-strip__header">
        <div className="performance-signal-strip__title">
          <span className="performance-signal-strip__mark"><Sparkles size={13} aria-hidden="true" /></span>
          <span><strong>{title}</strong><small>{countSummary(projection)} · {projection.counts.total} signal{projection.counts.total === 1 ? "" : "s"}</small></span>
        </div>
        <span className="performance-signal-strip__boundary"><ShieldCheck size={12} aria-hidden="true" /> Renderer preview</span>
      </header>

      <div className="performance-signal-strip__metrics" aria-label="Performance signal counts">
        <span className="performance-signal-strip__metric performance-signal-strip__metric--good"><strong>{projection.counts.pass}</strong><small>Pass</small></span>
        <span className="performance-signal-strip__metric performance-signal-strip__metric--warn"><strong>{projection.counts.watch}</strong><small>Watch</small></span>
        <span className="performance-signal-strip__metric performance-signal-strip__metric--bad"><strong>{projection.counts.fail}</strong><small>Fail</small></span>
        <span className="performance-signal-strip__metric"><strong>{projection.counts.unknown}</strong><small>Unknown</small></span>
      </div>

      <nav className="performance-signal-strip__filters" aria-label="Performance signal filters" role="tablist">
        <ListFilter size={12} aria-hidden="true" />
        {FILTERS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} className={filter === item.id ? "is-active" : ""} onClick={() => setFilter(item.id)}>
            {item.label}<span>{filterCount(projection, item.id)}</span>
          </button>
        ))}
      </nav>

      <div className="performance-signal-strip__events" role="list" aria-label={`${visibleSignals.length} visible performance signal${visibleSignals.length === 1 ? "" : "s"}`}>
        {visibleSignals.length === 0 ? <p className="performance-signal-strip__empty">No signals match this filter. Supply a runner receipt to inspect performance evidence.</p> : null}
        {visibleSignals.slice(0, 6).map((signal) => (
          <button key={signal.id} type="button" role="listitem" className={`performance-signal-strip__event performance-signal-strip__event--${signal.status} ${selected?.id === signal.id ? "is-selected" : ""}`} onClick={() => setSelectedId(signal.id)} aria-pressed={selected?.id === signal.id}>
            <span className="performance-signal-strip__event-icon">{statusIcon(signal.status)}</span>
            <span className="performance-signal-strip__event-copy"><strong>{signal.label}</strong><small>{signal.reason}</small></span>
            <span className="performance-signal-strip__event-value"><strong>{formatValue(signal.p95, signal.unit)}</strong><small>{signalStatusLabel(signal.status)} · {evidenceLabel(signal.evidence)}</small></span>
          </button>
        ))}
      </div>

      {selected ? <div className="performance-signal-strip__detail" aria-label="Selected performance signal">
        <div><span className="eyebrow">Selected signal</span><strong>{selected.label}</strong><small>{selected.coverage} · {selected.freshness}</small></div>
        <dl><div><dt>p50</dt><dd>{formatValue(selected.p50, selected.unit)}</dd></div><div><dt>p95</dt><dd>{formatValue(selected.p95, selected.unit)}</dd></div><div><dt>Target</dt><dd>{selected.targetP95 === null ? "Runner-defined" : formatValue(selected.targetP95, selected.unit)}</dd></div><div><dt>Source</dt><dd>{selected.source}</dd></div></dl>
      </div> : null}

      <div className="performance-signal-strip__export">
        <label><span>Format</span><select aria-label="Performance signal export format" value={format} onChange={(event) => setFormat(event.target.value as PerformanceSignalFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
        <button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button>
        <button type="button" className="button button--secondary" onClick={download}><Download size={13} /> Download</button>
        {onOpenDiagnostics ? <button type="button" className="button button--ghost" onClick={onOpenDiagnostics}><AlertTriangle size={13} /> Open diagnostics</button> : null}
        <span role="status" aria-live="polite">{status}</span>
      </div>

      <footer className="performance-signal-strip__footer"><Info size={13} aria-hidden="true" /><span>{performanceSignalSummary(projection)} · Samples must come from an external runner.</span><span>UI projection only · no native telemetry write.</span></footer>
    </section>
  );
}

export default PerformanceSignalStrip;

