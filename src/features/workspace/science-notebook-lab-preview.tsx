import {
  Beaker,
  Check,
  CheckCircle2,
  Clipboard,
  Download,
  FlaskConical,
  Gauge,
  Info,
  ListChecks,
  Search,
  RotateCcw,
  Sparkles,
  Target,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

type LabTab = "protocol" | "observations" | "model" | "sensitivity" | "export";
type ScienceDomain = "physics" | "chemistry" | "math" | "biology";
type ExportFormat = "json" | "markdown";
type ObservationFilter = "all" | "reviewed" | "open";
type ObservationSortKey = "input" | "measured" | "predicted" | "residual" | "note";
type ObservationSortDirection = "asc" | "desc";
type ObservationExportScope = "visible" | "selected";
type ObservationColumn = "input" | "measured" | "predicted" | "residual" | "note" | "review";
type ObservationViewPreset = "full" | "review" | "compact" | "custom";
type TableDensity = "comfortable" | "compact";

type Observation = {
  id: string;
  input: string;
  measured: string;
  note: string;
  reviewed: boolean;
};

export type ScienceObservationRow = Observation & {
  predicted: number;
  residual: number;
};

type ProtocolStep = {
  id: string;
  label: string;
  detail: string;
  done: boolean;
};

const tabs: readonly [LabTab, string][] = [
  ["protocol", "Protocol"],
  ["observations", "Observations"],
  ["model", "Model review"],
  ["sensitivity", "Sensitivity"],
  ["export", "Export"],
];

const domainMeta: Record<ScienceDomain, { label: string; description: string; status: "available" | "planned" }> = {
  physics: { label: "Physics", description: "Dimensional checks and a simple pendulum model", status: "available" },
  chemistry: { label: "Chemistry", description: "Stoichiometry and concentration templates", status: "planned" },
  math: { label: "Mathematics", description: "Symbolic and numerical model templates", status: "planned" },
  biology: { label: "Biology", description: "Growth and assay observation templates", status: "planned" },
};

const initialObservations: Observation[] = [
  { id: "obs-1", input: "0.50", measured: "1.42", note: "Three-run average", reviewed: true },
  { id: "obs-2", input: "0.80", measured: "1.79", note: "Room temperature", reviewed: true },
  { id: "obs-3", input: "1.00", measured: "2.01", note: "Longer string", reviewed: false },
];

const initialProtocol: ProtocolStep[] = [
  { id: "question", label: "Define the question", detail: "State the measurable relationship and target output.", done: true },
  { id: "units", label: "Declare units and regime", detail: "Keep SI units visible and state approximation limits.", done: true },
  { id: "observations", label: "Capture observations", detail: "Record input, measurement, note, and review status.", done: false },
  { id: "validate", label: "Validate the model", detail: "Compare predicted values, residuals, and sensitivity.", done: false },
  { id: "handoff", label: "Prepare a handoff", detail: "Export a portable experiment plan for the next chat turn.", done: false },
];

const observationColumns: readonly { key: ObservationColumn; label: string; description: string }[] = [
  { key: "input", label: "Length", description: "Independent variable in metres" },
  { key: "measured", label: "Measured period", description: "Observed period in seconds" },
  { key: "predicted", label: "Predicted period", description: "Model output in seconds" },
  { key: "residual", label: "Residual", description: "Measured minus predicted" },
  { key: "note", label: "Note", description: "Operator annotation" },
  { key: "review", label: "Review", description: "Review state" },
];

const observationPresetColumns: Record<Exclude<ObservationViewPreset, "custom">, readonly ObservationColumn[]> = {
  full: observationColumns.map(({ key }) => key),
  review: ["input", "measured", "residual", "note", "review"],
  compact: ["input", "measured", "residual"],
};

function numberOf(value: string): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function formatNumber(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "Unavailable";
}

function pendulumPeriod(length: number, gravity: number): number {
  return Number.isFinite(length) && length > 0 && Number.isFinite(gravity) && gravity > 0
    ? 2 * Math.PI * Math.sqrt(length / gravity)
    : Number.NaN;
}

export type ScienceSensitivityRow = {
  key: "length" | "gravity";
  label: string;
  unit: string;
  low: number;
  baseline: number;
  high: number;
  spread: number;
  relativeSpread: number;
};

export function buildPendulumSensitivity({
  baselineLength,
  gravity,
  lengthDelta,
  gravityDelta,
}: {
  baselineLength: number;
  gravity: number;
  lengthDelta: number;
  gravityDelta: number;
}): ScienceSensitivityRow[] {
  const baseline = pendulumPeriod(baselineLength, gravity);
  const lengthLow = pendulumPeriod(baselineLength - lengthDelta, gravity);
  const lengthHigh = pendulumPeriod(baselineLength + lengthDelta, gravity);
  const gravityLow = pendulumPeriod(baselineLength, gravity - gravityDelta);
  const gravityHigh = pendulumPeriod(baselineLength, gravity + gravityDelta);

  return [
    {
      key: "length",
      label: "Length",
      unit: "m",
      low: lengthLow,
      baseline,
      high: lengthHigh,
      spread: Math.abs(lengthHigh - lengthLow),
      relativeSpread: Math.abs(lengthHigh - lengthLow) / Math.abs(baseline),
    },
    {
      key: "gravity",
      label: "Gravity",
      unit: "m/s²",
      low: gravityLow,
      baseline,
      high: gravityHigh,
      spread: Math.abs(gravityHigh - gravityLow),
      relativeSpread: Math.abs(gravityHigh - gravityLow) / Math.abs(baseline),
    },
  ];
}

function escapeCsv(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function buildObservationCsv(rows: readonly ScienceObservationRow[]): string {
  const header = ["id", "length_m", "measured_period_s", "predicted_period_s", "residual_s", "note", "reviewed"];
  const body = rows.map((row) => [
    row.id,
    row.input,
    row.measured,
    formatNumber(row.predicted),
    formatNumber(row.residual),
    row.note,
    row.reviewed ? "true" : "false",
  ].map(escapeCsv).join(","));
  return [header.join(","), ...body].join("\n");
}

export function ScienceNotebookLabPreview() {
  const [tab, setTab] = useState<LabTab>("protocol");
  const [domain, setDomain] = useState<ScienceDomain>("physics");
  const [question, setQuestion] = useState("How does pendulum length change its oscillation period?");
  const [gravity, setGravity] = useState("9.81");
  const [observations, setObservations] = useState<Observation[]>(initialObservations);
  const [protocol, setProtocol] = useState<ProtocolStep[]>(initialProtocol);
  const [selectedModel, setSelectedModel] = useState("simple-pendulum");
  const [format, setFormat] = useState<ExportFormat>("json");
  const [observationQuery, setObservationQuery] = useState("");
  const [observationFilter, setObservationFilter] = useState<ObservationFilter>("all");
  const [observationSort, setObservationSort] = useState<{ key: ObservationSortKey; direction: ObservationSortDirection }>({ key: "input", direction: "asc" });
  const [selectedObservationIds, setSelectedObservationIds] = useState<Set<string>>(new Set());
  const [observationExportScope, setObservationExportScope] = useState<ObservationExportScope>("visible");
  const [visibleObservationColumns, setVisibleObservationColumns] = useState<Set<ObservationColumn>>(
    () => new Set(observationPresetColumns.full),
  );
  const [observationViewPreset, setObservationViewPreset] = useState<ObservationViewPreset>("full");
  const [tableDensity, setTableDensity] = useState<TableDensity>("comfortable");
  const [residualThreshold, setResidualThreshold] = useState("0.05");
  const [sensitivityLength, setSensitivityLength] = useState("0.80");
  const [sensitivityLengthDelta, setSensitivityLengthDelta] = useState("0.10");
  const [sensitivityGravityDelta, setSensitivityGravityDelta] = useState("0.50");
  const [status, setStatus] = useState("Science notebook is a renderer-local preview.");
  const [copied, setCopied] = useState(false);

  const warnings = useMemo(() => {
    const messages: string[] = [];
    if (domain !== "physics") messages.push(`${domainMeta[domain].label} model templates are planned; physics preview remains the active deterministic calculation.`);
    const g = numberOf(gravity);
    if (!Number.isFinite(g) || g <= 0) messages.push("Gravity must be a finite value greater than zero.");
    const threshold = numberOf(residualThreshold);
    if (!Number.isFinite(threshold) || threshold <= 0) messages.push("Residual flag threshold must be a finite value greater than zero.");
    observations.forEach((observation, index) => {
      const input = numberOf(observation.input);
      const measured = numberOf(observation.measured);
      if (!Number.isFinite(input) || input <= 0) messages.push(`Observation ${index + 1}: length must be greater than zero.`);
      if (!Number.isFinite(measured) || measured < 0) messages.push(`Observation ${index + 1}: measured period must be zero or greater.`);
    });
    return messages;
  }, [domain, gravity, observations, residualThreshold]);

  const rows = useMemo<ScienceObservationRow[]>(() => {
    const g = numberOf(gravity);
    return observations.map((observation) => {
      const length = numberOf(observation.input);
      const measured = numberOf(observation.measured);
      const predicted = pendulumPeriod(length, g);
      const residual = Number.isFinite(predicted) && Number.isFinite(measured) ? measured - predicted : Number.NaN;
      return { ...observation, predicted, residual };
    });
  }, [gravity, observations]);

  const sensitivityRows = useMemo(() => buildPendulumSensitivity({
    baselineLength: numberOf(sensitivityLength),
    gravity: numberOf(gravity),
    lengthDelta: numberOf(sensitivityLengthDelta),
    gravityDelta: numberOf(sensitivityGravityDelta),
  }), [gravity, sensitivityGravityDelta, sensitivityLength, sensitivityLengthDelta]);

  const sensitivityWarnings = useMemo(() => {
    const messages: string[] = [];
    const baselineLength = numberOf(sensitivityLength);
    const lengthDelta = numberOf(sensitivityLengthDelta);
    const gravityDelta = numberOf(sensitivityGravityDelta);
    const g = numberOf(gravity);
    if (!Number.isFinite(baselineLength) || baselineLength <= 0) messages.push("Sensitivity baseline length must be greater than zero.");
    if (!Number.isFinite(lengthDelta) || lengthDelta < 0) messages.push("Length delta must be a finite value greater than or equal to zero.");
    if (Number.isFinite(baselineLength) && Number.isFinite(lengthDelta) && baselineLength - lengthDelta <= 0) messages.push("Length delta must stay below the baseline length.");
    if (!Number.isFinite(gravityDelta) || gravityDelta < 0) messages.push("Gravity delta must be a finite value greater than or equal to zero.");
    if (Number.isFinite(g) && Number.isFinite(gravityDelta) && g - gravityDelta <= 0) messages.push("Gravity delta must stay below the current gravity.");
    return messages;
  }, [gravity, sensitivityGravityDelta, sensitivityLength, sensitivityLengthDelta]);

  const visibleRows = useMemo(() => {
    const query = observationQuery.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      const matchesFilter = observationFilter === "all" || (observationFilter === "reviewed" ? row.reviewed : !row.reviewed);
      if (!matchesFilter) return false;
      if (!query) return true;
      return [row.id, row.input, row.measured, row.note, formatNumber(row.predicted), formatNumber(row.residual)]
        .some((value) => value.toLowerCase().includes(query));
    });

    const sorted = [...filtered].sort((a, b) => {
      const key = observationSort.key;
      if (key === "note") {
        const result = a.note.localeCompare(b.note, undefined, { sensitivity: "base" });
        return observationSort.direction === "asc" ? result : -result;
      }
      const aValue = key === "input" ? numberOf(a.input) : key === "measured" ? numberOf(a.measured) : key === "predicted" ? a.predicted : a.residual;
      const bValue = key === "input" ? numberOf(b.input) : key === "measured" ? numberOf(b.measured) : key === "predicted" ? b.predicted : b.residual;
      const aFinite = Number.isFinite(aValue);
      const bFinite = Number.isFinite(bValue);
      if (aFinite !== bFinite) return aFinite ? -1 : 1;
      if (!aFinite && !bFinite) return a.id.localeCompare(b.id);
      const result = aValue - bValue;
      return result === 0 ? a.id.localeCompare(b.id) : observationSort.direction === "asc" ? result : -result;
    });
    return sorted;
  }, [observationFilter, observationQuery, observationSort, rows]);

  const visibleObservationIds = useMemo(() => visibleRows.map((row) => row.id), [visibleRows]);
  const selectedVisibleCount = visibleObservationIds.filter((id) => selectedObservationIds.has(id)).length;
  const selectedCount = selectedObservationIds.size;
  const allVisibleSelected = visibleObservationIds.length > 0 && selectedVisibleCount === visibleObservationIds.length;
  const visibleColumnCount = visibleObservationColumns.size;
  const residualThresholdValue = numberOf(residualThreshold);

  const exportRows = useMemo(
    () => observationExportScope === "selected" ? rows.filter((row) => selectedObservationIds.has(row.id)) : visibleRows,
    [observationExportScope, rows, selectedObservationIds, visibleRows],
  );
  const observationCsv = useMemo(() => buildObservationCsv(exportRows), [exportRows]);

  const rmse = useMemo(() => {
    const valid = rows.filter((row) => Number.isFinite(row.residual));
    if (!valid.length) return Number.NaN;
    return Math.sqrt(valid.reduce((sum, row) => sum + row.residual ** 2, 0) / valid.length);
  }, [rows]);

  const reviewedCount = observations.filter((observation) => observation.reviewed).length;
  const doneProtocol = protocol.filter((step) => step.done).length;
  const coverage = observations.length ? Math.round((reviewedCount / observations.length) * 100) : 0;

  const payload = useMemo(() => {
    const data = {
      schema: "omnia.science-notebook-lab.preview.v1",
      scope: "renderer-session",
      question,
      domain,
      model: selectedModel,
      parameters: { gravity, units: "SI" },
      observations: rows.map(({ id, input, measured, note, reviewed, predicted, residual }) => ({ id, lengthMeters: input, periodSeconds: measured, note, reviewed, predictedSeconds: formatNumber(predicted), residualSeconds: formatNumber(residual) })),
      validation: { rmseSeconds: formatNumber(rmse), reviewedCount, totalObservations: observations.length, protocolComplete: doneProtocol === protocol.length },
      sensitivity: {
        baselineLengthMeters: sensitivityLength,
        lengthDeltaMeters: sensitivityLengthDelta,
        gravityDeltaMetersPerSecondSquared: sensitivityGravityDelta,
        rows: sensitivityRows.map((row) => ({ parameter: row.key, lowPeriodSeconds: formatNumber(row.low), baselinePeriodSeconds: formatNumber(row.baseline), highPeriodSeconds: formatNumber(row.high), spreadSeconds: formatNumber(row.spread), relativeSpread: `${formatNumber(row.relativeSpread * 100, 1)}%` })),
        status: sensitivityWarnings.length ? "needs-review" : "ready-in-preview",
      },
      nativeRuntime: "not-tested-by-this-preview",
      retrieval: "not-run-in-preview",
      durableWrite: "not-performed",
    };
    if (format === "json") return JSON.stringify(data, null, 2);
    return `# Omnia science notebook lab preview\n\n- **Question:** ${question}\n- **Domain:** ${domainMeta[domain].label}\n- **Model:** Simple pendulum (SI units)\n- **RMSE:** ${formatNumber(rmse)} s\n- **Observation review:** ${reviewedCount}/${observations.length}\n\n## Assumptions\n\n- Small-angle approximation\n- Constant gravity: ${gravity} m/s²\n- One-at-a-time sensitivity around ${sensitivityLength} m (±${sensitivityLengthDelta} m) and ${gravity} m/s² (±${sensitivityGravityDelta} m/s²)\n- No provider, retrieval, hardware, or filesystem operation was run\n\n## Observation table\n\n| Length (m) | Measured period (s) | Predicted (s) | Residual (s) | Review |\n| ---: | ---: | ---: | ---: | :--- |\n${rows.map((row) => `| ${row.input} | ${row.measured} | ${formatNumber(row.predicted)} | ${formatNumber(row.residual)} | ${row.reviewed ? "reviewed" : "open"} |`).join("\n")}\n\n## Sensitivity preview\n\n| Parameter | Low period (s) | Baseline (s) | High period (s) | Spread (s) | Relative spread |\n| :--- | ---: | ---: | ---: | ---: | ---: |\n${sensitivityRows.map((row) => `| ${row.label} (${row.unit}) | ${formatNumber(row.low)} | ${formatNumber(row.baseline)} | ${formatNumber(row.high)} | ${formatNumber(row.spread)} | ${formatNumber(row.relativeSpread * 100, 1)}% |`).join("\n")}\n\nPreview only · renderer-local · no durable write.\n`;
  }, [domain, doneProtocol, format, gravity, observations.length, question, reviewedCount, rmse, rows, selectedModel, sensitivityGravityDelta, sensitivityLength, sensitivityLengthDelta, sensitivityRows, sensitivityWarnings.length, protocol.length]);

  const updateObservation = (id: string, patch: Partial<Observation>) => {
    setObservations((current) => current.map((observation) => observation.id === id ? { ...observation, ...patch } : observation));
  };

  const addObservation = () => {
    const baseId = `obs-${Date.now()}`;
    const existingIds = new Set(observations.map((observation) => observation.id));
    let id = baseId;
    let suffix = 2;
    while (existingIds.has(id)) id = `${baseId}-${suffix++}`;
    setObservations((current) => [...current, { id, input: "1.20", measured: "2.20", note: "New renderer-local observation", reviewed: false }]);
    setStatus("Added an observation row in the renderer session; no file or lab instrument was accessed.");
  };

  const removeObservation = (id: string) => {
    setObservations((current) => current.filter((observation) => observation.id !== id));
    setSelectedObservationIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setStatus("Removed an observation row from the renderer session; no source file or instrument was changed.");
  };

  const duplicateSelected = () => {
    if (!selectedCount) return;
    const existingIds = new Set(observations.map((observation) => observation.id));
    const copies = observations.filter((observation) => selectedObservationIds.has(observation.id)).map((observation) => {
      const baseId = `${observation.id}-copy`;
      let id = baseId;
      let suffix = 2;
      while (existingIds.has(id)) id = `${baseId}-${suffix++}`;
      existingIds.add(id);
      return { ...observation, id, reviewed: false, note: observation.note ? `${observation.note} (copy)` : "Duplicated renderer-local observation" };
    });
    setObservations((current) => [...current, ...copies]);
    setSelectedObservationIds(new Set(copies.map((observation) => observation.id)));
    setStatus(`Duplicated ${copies.length} selected observation${copies.length === 1 ? "" : "s"} in the renderer session.`);
  };

  const removeSelected = () => {
    if (!selectedCount) return;
    setObservations((current) => current.filter((observation) => !selectedObservationIds.has(observation.id)));
    setSelectedObservationIds(new Set());
    setStatus(`Removed ${selectedCount} selected observation${selectedCount === 1 ? "" : "s"} from the renderer session.`);
  };

  const toggleObservationSelection = (id: string) => {
    setSelectedObservationIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleVisibleSelection = () => {
    setSelectedObservationIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleObservationIds.forEach((id) => next.delete(id));
      else visibleObservationIds.forEach((id) => next.add(id));
      return next;
    });
    setStatus(allVisibleSelected ? "Cleared the visible observation selection in this renderer session." : "Selected all visible observations in this renderer session.");
  };

  const markSelected = (reviewed: boolean) => {
    if (!selectedCount) return;
    setObservations((current) => current.map((observation) => selectedObservationIds.has(observation.id) ? { ...observation, reviewed } : observation));
    setStatus(`${reviewed ? "Marked" : "Reopened"} ${selectedCount} selected observation${selectedCount === 1 ? "" : "s"} in the renderer session.`);
  };

  const clearSelection = () => {
    setSelectedObservationIds(new Set());
    setStatus("Cleared observation selection in this renderer session.");
  };

  const applyObservationViewPreset = (preset: Exclude<ObservationViewPreset, "custom">) => {
    setObservationViewPreset(preset);
    setVisibleObservationColumns(new Set(observationPresetColumns[preset]));
    setTableDensity(preset === "compact" ? "compact" : "comfortable");
    setStatus(`Applied the ${preset} observation table view in this renderer session.`);
  };

  const toggleObservationColumn = (column: ObservationColumn) => {
    if (visibleObservationColumns.has(column) && visibleObservationColumns.size === 1) {
      setStatus("Keep at least one observation column visible in the renderer table.");
      return;
    }
    setVisibleObservationColumns((current) => {
      const next = new Set(current);
      if (next.has(column)) {
        next.delete(column);
      } else {
        next.add(column);
      }
      return next;
    });
    setObservationViewPreset("custom");
  };

  const resetObservationTableView = () => {
    setObservationViewPreset("full");
    setVisibleObservationColumns(new Set(observationPresetColumns.full));
    setTableDensity("comfortable");
    setResidualThreshold("0.05");
    setStatus("Reset observation table columns, density, and residual threshold.");
  };

  const downloadObservationCsv = () => {
    const url = URL.createObjectURL(new Blob([observationCsv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "omnia-science-observations-preview.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(`Downloaded ${exportRows.length} observation row${exportRows.length === 1 ? "" : "s"} as a browser CSV preview; no workspace or native notebook write was performed.`);
  };

  const setObservationSortKey = (key: ObservationSortKey) => {
    setObservationSort((current) => current.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" });
  };

  const reset = () => {
    setQuestion("How does pendulum length change its oscillation period?");
    setDomain("physics");
    setGravity("9.81");
    setObservations(initialObservations);
    setProtocol(initialProtocol);
    setSelectedModel("simple-pendulum");
    setObservationQuery("");
    setObservationFilter("all");
    setObservationSort({ key: "input", direction: "asc" });
    setSelectedObservationIds(new Set());
    setObservationExportScope("visible");
    setObservationViewPreset("full");
    setVisibleObservationColumns(new Set(observationPresetColumns.full));
    setTableDensity("comfortable");
    setResidualThreshold("0.05");
    setSensitivityLength("0.80");
    setSensitivityLengthDelta("0.10");
    setSensitivityGravityDelta("0.50");
    setStatus("Science notebook preview reset to its deterministic example.");
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) { setStatus("Clipboard access is unavailable in this preview."); return; }
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setStatus(`Copied ${format.toUpperCase()} science notebook preview.`);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setStatus("Clipboard access was denied; nothing was copied.");
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `omnia-science-notebook-preview.${format === "json" ? "json" : "md"}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("Downloaded a renderer-local science notebook preview; no durable export was written.");
  };

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex]?.[0];
    if (!next) return;
    setTab(next);
    document.getElementById(`science-notebook-tab-${next}`)?.focus();
  };

  return (
    <section className="science-notebook-lab" aria-labelledby="science-notebook-lab-heading">
      <header className="science-notebook-lab__header">
        <div>
          <span className="eyebrow"><FlaskConical size={14} /> Research · experiment protocol</span>
          <h2 id="science-notebook-lab-heading">Science notebook lab</h2>
          <p>Turn a question into a reproducible experiment plan, typed observations, model checks, and a portable handoff.</p>
        </div>
        <div className="science-notebook-lab__actions">
          <span className="science-notebook-lab__badge"><Sparkles size={12} /> Preview only</span>
          <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={13} /> Reset</button>
          <button type="button" className="button button--secondary" onClick={() => setTab("export")}><Download size={13} /> Export</button>
        </div>
      </header>

      <div className="science-notebook-lab__boundary" role="note">
        <Info size={15} />
        <span><strong>Renderer-local science preview.</strong> Calculations are deterministic and use the values shown here. No provider call, retrieval, filesystem read, compiler, hardware control, or durable write is performed.</span>
      </div>

      <div className="science-notebook-lab__summary" aria-label="Science notebook summary">
        <div><Gauge size={16} /><span><small>Protocol</small><strong>{doneProtocol}/{protocol.length}</strong><em>steps checked</em></span></div>
        <div><Beaker size={16} /><span><small>Observations</small><strong>{observations.length}</strong><em>{reviewedCount} reviewed</em></span></div>
        <div><Target size={16} /><span><small>Coverage</small><strong>{coverage}%</strong><em>reviewed rows</em></span></div>
        <div><CheckCircle2 size={16} /><span><small>RMSE</small><strong>{formatNumber(rmse, 3)}</strong><em>seconds</em></span></div>
      </div>

      <nav className="science-notebook-lab__tabs" role="tablist" aria-label="Science notebook lab views">
        {tabs.map(([value, label], index) => <button key={value} id={`science-notebook-tab-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`science-notebook-panel-${value}`} tabIndex={tab === value ? 0 : -1} className={tab === value ? "is-active" : ""} onClick={() => setTab(value)} onKeyDown={(event) => moveTab(event, index)}>{label}{value === "observations" ? <small>{observations.length}</small> : null}</button>)}
      </nav>

      {tab === "protocol" ? (
        <div id="science-notebook-panel-protocol" className="science-notebook-lab__grid" role="tabpanel" aria-labelledby="science-notebook-tab-protocol">
          <section className="science-notebook-lab__card">
            <div className="science-notebook-lab__card-heading"><span><ListChecks size={15} /><strong>Experiment protocol</strong></span><small>Editable preview</small></div>
            <label className="science-notebook-lab__field science-notebook-lab__field--wide"><span>Research question</span><textarea value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} aria-label="Science research question" /></label>
            <div className="science-notebook-lab__field-grid">
              <label className="science-notebook-lab__field"><span>Domain</span><select aria-label="Science domain" value={domain} onChange={(event) => setDomain(event.target.value as ScienceDomain)}>{(Object.keys(domainMeta) as ScienceDomain[]).map((entry) => <option key={entry} value={entry}>{domainMeta[entry].label}{domainMeta[entry].status === "planned" ? " · planned" : ""}</option>)}</select></label>
              <label className="science-notebook-lab__field"><span>Gravity (m/s²)</span><input aria-label="Gravity" inputMode="decimal" value={gravity} onChange={(event) => setGravity(event.target.value)} /></label>
            </div>
            <div className="science-notebook-lab__protocol-list">{protocol.map((step) => <label key={step.id} className={step.done ? "is-done" : ""}><input type="checkbox" checked={step.done} onChange={(event) => setProtocol((current) => current.map((item) => item.id === step.id ? { ...item, done: event.target.checked } : item))} /><span><strong>{step.label}</strong><small>{step.detail}</small></span></label>)}</div>
          </section>
          <aside className="science-notebook-lab__card science-notebook-lab__card--side"><div className="science-notebook-lab__card-heading"><span><Undo2 size={15} /><strong>Model candidates</strong></span><small>{domainMeta[domain].status}</small></div><button type="button" className={`science-notebook-lab__model-option ${selectedModel === "simple-pendulum" ? "is-active" : ""}`} aria-pressed={selectedModel === "simple-pendulum"} onClick={() => setSelectedModel("simple-pendulum")}><strong>Simple pendulum</strong><span>T = 2π√(L/g)</span><small>Available for deterministic preview</small></button><button type="button" className="science-notebook-lab__model-option is-planned" disabled title="Custom fitting is unavailable until a native symbolic or numerical solver is connected"><strong>Fit a custom model</strong><span>Symbolic / numerical fitting</span><small>Planned · no solver connected</small></button><p className="science-notebook-lab__muted">The scientific role contract expects explicit assumptions, units, validation, sensitivity, and limits. This surface exposes those slots before native compute is connected.</p></aside>
        </div>
      ) : null}

      {tab === "observations" ? (
        <div id="science-notebook-panel-observations" className="science-notebook-lab__card" role="tabpanel" aria-labelledby="science-notebook-tab-observations">
          <div className="science-notebook-lab__card-heading"><span><Beaker size={15} /><strong>Observed data</strong></span><div><small>{reviewedCount}/{observations.length} reviewed</small><button type="button" className="button button--secondary" onClick={addObservation}>Add row</button></div></div>
          <div className="science-notebook-lab__observation-toolbar" aria-label="Observation table controls">
            <label className="science-notebook-lab__search-field"><Search size={14} /><span className="science-notebook-lab__sr-only">Search observations</span><input aria-label="Search observations" value={observationQuery} onChange={(event) => setObservationQuery(event.target.value)} placeholder="Search note, value, or row ID" /></label>
            <label className="science-notebook-lab__filter-field"><span>Review</span><select aria-label="Observation review filter" value={observationFilter} onChange={(event) => setObservationFilter(event.target.value as ObservationFilter)}><option value="all">All rows</option><option value="reviewed">Reviewed only</option><option value="open">Open only</option></select></label>
            <span className="science-notebook-lab__table-scope" role="status" aria-live="polite">{visibleRows.length} visible · {observations.length} total · {selectedCount} selected · {visibleColumnCount}/{observationColumns.length} columns</span>
          </div>
          <details className="science-notebook-lab__table-settings">
            <summary>Table view · {observationViewPreset === "custom" ? "Custom" : observationViewPreset}</summary>
            <div className="science-notebook-lab__table-settings-grid">
              <label className="science-notebook-lab__field"><span>View preset</span><select aria-label="Observation table view preset" value={observationViewPreset} onChange={(event) => { const next = event.target.value as ObservationViewPreset; if (next !== "custom") applyObservationViewPreset(next); }}><option value="full">Full table</option><option value="review">Review focus</option><option value="compact">Compact data</option><option value="custom">Custom columns</option></select></label>
              <label className="science-notebook-lab__field"><span>Density</span><select aria-label="Observation table density" value={tableDensity} onChange={(event) => { setTableDensity(event.target.value as TableDensity); setObservationViewPreset("custom"); }}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
              <label className="science-notebook-lab__field"><span>Residual flag threshold (s)</span><input aria-label="Residual flag threshold" inputMode="decimal" value={residualThreshold} onChange={(event) => { setResidualThreshold(event.target.value); setObservationViewPreset("custom"); }} /></label>
              <button type="button" className="button button--ghost" onClick={resetObservationTableView}>Reset table view</button>
            </div>
            <div className="science-notebook-lab__column-list" aria-label="Observation column visibility">
              {observationColumns.map((column) => <label key={column.key}><input type="checkbox" aria-label={`Observation column ${column.label}`} checked={visibleObservationColumns.has(column.key)} disabled={visibleObservationColumns.size === 1 && visibleObservationColumns.has(column.key)} onChange={() => toggleObservationColumn(column.key)} /><span><strong>{column.label}</strong><small>{column.description}</small></span></label>)}
            </div>
            <p className="science-notebook-lab__muted">Column visibility, density, and threshold are renderer-local preferences for this session. They are not persisted to a project.</p>
          </details>
          <div className="science-notebook-lab__selection-toolbar" aria-label="Observation selection actions">
            <button type="button" className="button button--ghost" aria-pressed={allVisibleSelected} onClick={toggleVisibleSelection}>{allVisibleSelected ? "Clear visible" : "Select visible"}</button>
            <button type="button" className="button button--ghost" disabled={!selectedCount} onClick={duplicateSelected}>Duplicate selected</button>
            <button type="button" className="button button--ghost" disabled={!selectedCount} onClick={removeSelected}>Delete selected</button>
            <button type="button" className="button button--ghost" disabled={!selectedCount} onClick={() => markSelected(true)}>Mark reviewed</button>
            <button type="button" className="button button--ghost" disabled={!selectedCount} onClick={() => markSelected(false)}>Reopen</button>
            <button type="button" className="button button--ghost" disabled={!selectedCount} onClick={clearSelection}>Clear selection</button>
          </div>
          <div className="science-notebook-lab__table-wrap"><table className={`science-notebook-lab__table science-notebook-lab__table--${tableDensity}`} aria-label="Science notebook observations"><thead><tr><th aria-label="Select observations" />
            {visibleObservationColumns.has("input") ? <th><button type="button" className="science-notebook-lab__sort-button" onClick={() => setObservationSortKey("input")} aria-label="Sort by Length (m)">Length (m){observationSort.key === "input" ? ` ${observationSort.direction === "asc" ? "↑" : "↓"}` : ""}</button></th> : null}
            {visibleObservationColumns.has("measured") ? <th><button type="button" className="science-notebook-lab__sort-button" onClick={() => setObservationSortKey("measured")} aria-label="Sort by Measured period (s)">Measured period (s){observationSort.key === "measured" ? ` ${observationSort.direction === "asc" ? "↑" : "↓"}` : ""}</button></th> : null}
            {visibleObservationColumns.has("predicted") ? <th><button type="button" className="science-notebook-lab__sort-button" onClick={() => setObservationSortKey("predicted")} aria-label="Sort by Predicted (s)">Predicted (s){observationSort.key === "predicted" ? ` ${observationSort.direction === "asc" ? "↑" : "↓"}` : ""}</button></th> : null}
            {visibleObservationColumns.has("residual") ? <th><button type="button" className="science-notebook-lab__sort-button" onClick={() => setObservationSortKey("residual")} aria-label="Sort by Residual (s)">Residual (s){observationSort.key === "residual" ? ` ${observationSort.direction === "asc" ? "↑" : "↓"}` : ""}</button></th> : null}
            {visibleObservationColumns.has("note") ? <th><button type="button" className="science-notebook-lab__sort-button" onClick={() => setObservationSortKey("note")} aria-label="Sort by Note">Note{observationSort.key === "note" ? ` ${observationSort.direction === "asc" ? "↑" : "↓"}` : ""}</button></th> : null}
            {visibleObservationColumns.has("review") ? <th>Review</th> : null}
            <th aria-label="Observation actions" /></tr></thead><tbody>{visibleRows.length ? visibleRows.map((row) => <tr key={row.id}><td><input type="checkbox" aria-label={`Select observation ${row.id}`} checked={selectedObservationIds.has(row.id)} onChange={() => toggleObservationSelection(row.id)} /></td>
              {visibleObservationColumns.has("input") ? <td><input aria-label={`Length for ${row.id}`} inputMode="decimal" value={row.input} onChange={(event) => updateObservation(row.id, { input: event.target.value })} /></td> : null}
              {visibleObservationColumns.has("measured") ? <td><input aria-label={`Measured period for ${row.id}`} inputMode="decimal" value={row.measured} onChange={(event) => updateObservation(row.id, { measured: event.target.value })} /></td> : null}
              {visibleObservationColumns.has("predicted") ? <td>{formatNumber(row.predicted)}</td> : null}
              {visibleObservationColumns.has("residual") ? <td className={Number.isFinite(residualThresholdValue) && Math.abs(row.residual) > residualThresholdValue ? "is-warning" : ""}>{formatNumber(row.residual)}</td> : null}
              {visibleObservationColumns.has("note") ? <td><input aria-label={`Observation note for ${row.id}`} value={row.note} onChange={(event) => updateObservation(row.id, { note: event.target.value })} /></td> : null}
              {visibleObservationColumns.has("review") ? <td><label className="science-notebook-lab__review-toggle"><input type="checkbox" checked={row.reviewed} onChange={(event) => updateObservation(row.id, { reviewed: event.target.checked })} /><span>{row.reviewed ? "Reviewed" : "Open"}</span></label></td> : null}
              <td><button type="button" className="button button--ghost" aria-label={`Delete ${row.id}`} onClick={() => removeObservation(row.id)}><Trash2 size={13} /></button></td></tr>) : <tr><td colSpan={visibleColumnCount + 2} className="science-notebook-lab__empty-row">No observations match the current search or review filter.</td></tr>}</tbody></table></div>
           <div className="science-notebook-lab__csv-export" aria-label="Observation CSV export">
             <div className="science-notebook-lab__csv-toolbar">
               <label><span>CSV scope</span><select aria-label="Observation CSV scope" value={observationExportScope} onChange={(event) => setObservationExportScope(event.target.value as ObservationExportScope)}><option value="visible">Visible rows ({visibleRows.length})</option><option value="selected">Selected rows ({selectedCount})</option></select></label>
               <span role="status" aria-live="polite">{exportRows.length} row{exportRows.length === 1 ? "" : "s"} ready · preview only</span>
               <button type="button" className="button button--secondary" onClick={downloadObservationCsv}>Download CSV</button>
             </div>
             <details>
               <summary>Preview CSV ({exportRows.length} rows)</summary>
               <pre aria-label="Observation CSV preview"><code>{observationCsv}</code></pre>
             </details>
           </div>
           <div className="science-notebook-lab__input-review" role="status" aria-label="Science notebook input review">{warnings.length ? <><strong>Review before handoff</strong><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></> : <><Check size={14} /><span>Units and numeric inputs pass the local preview checks.</span></>}</div>
        </div>
      ) : null}

      {tab === "model" ? (
        <div id="science-notebook-panel-model" className="science-notebook-lab__model-grid" role="tabpanel" aria-labelledby="science-notebook-tab-model">
          <section className="science-notebook-lab__card"><div className="science-notebook-lab__card-heading"><span><Sparkles size={15} /><strong>Model review</strong></span><small>{selectedModel}</small></div><div className="science-notebook-lab__formula">T = 2π√(L / g)</div><div className="science-notebook-lab__assumptions"><strong>Assumptions</strong><ul><li>Small-angle approximation.</li><li>Constant gravitational acceleration: {gravity} m/s².</li><li>Length is measured in metres and period in seconds.</li><li>Air drag, pivot friction, and amplitude drift are not modelled.</li></ul></div><div className="science-notebook-lab__metric-grid"><div><small>RMSE</small><strong>{formatNumber(rmse)} s</strong></div><div><small>Reviewed rows</small><strong>{reviewedCount}/{observations.length}</strong></div><div><small>Model status</small><strong>{warnings.length ? "Needs review" : "Ready in preview"}</strong></div></div></section>
          <aside className="science-notebook-lab__card science-notebook-lab__validation"><div className="science-notebook-lab__card-heading"><span><CheckCircle2 size={15} /><strong>Validation and limits</strong></span><small>Heuristic preview</small></div>{rows.map((row) => <div className="science-notebook-lab__residual" key={row.id}><span>{row.input} m</span><span className="science-notebook-lab__residual-track"><i style={{ width: `${Math.min(100, Math.abs(row.residual) * 600)}%` }} /></span><strong>{formatNumber(row.residual)} s</strong></div>)}<p className="science-notebook-lab__muted">Residuals are calculated in the browser from the visible rows. They are not a calibration result, lab certification, or provider-generated conclusion.</p><div className="science-notebook-lab__limit-list"><span><CheckCircle2 size={13} /> Deterministic formula</span><span><CheckCircle2 size={13} /> Explicit unit assumptions</span><span><X size={13} /> No instrument or hardware access</span><span><X size={13} /> No solver, plotter, or external data</span></div></aside>
        </div>
      ) : null}

      {tab === "sensitivity" ? (
        <div id="science-notebook-panel-sensitivity" className="science-notebook-lab__model-grid" role="tabpanel" aria-labelledby="science-notebook-tab-sensitivity">
          <section className="science-notebook-lab__card">
            <div className="science-notebook-lab__card-heading"><span><Gauge size={15} /><strong>Sensitivity analysis</strong></span><small>One-at-a-time preview</small></div>
            <p className="science-notebook-lab__muted">Change one parameter around a baseline to see how the deterministic pendulum period responds. This is a browser calculation, not uncertainty calibration or a lab result.</p>
            <div className="science-notebook-lab__field-grid">
              <label className="science-notebook-lab__field"><span>Baseline length (m)</span><input aria-label="Sensitivity baseline length" inputMode="decimal" value={sensitivityLength} onChange={(event) => setSensitivityLength(event.target.value)} /></label>
              <label className="science-notebook-lab__field"><span>Length delta (±m)</span><input aria-label="Sensitivity length delta" inputMode="decimal" value={sensitivityLengthDelta} onChange={(event) => setSensitivityLengthDelta(event.target.value)} /></label>
              <label className="science-notebook-lab__field"><span>Gravity delta (±m/s²)</span><input aria-label="Sensitivity gravity delta" inputMode="decimal" value={sensitivityGravityDelta} onChange={(event) => setSensitivityGravityDelta(event.target.value)} /></label>
            </div>
            <div className="science-notebook-lab__table-wrap science-notebook-lab__sensitivity-wrap">
              <table className="science-notebook-lab__sensitivity-table" aria-label="Pendulum sensitivity analysis">
                <thead><tr><th>Parameter</th><th>At low value (s)</th><th>Baseline (s)</th><th>At high value (s)</th><th>Spread (s)</th><th>Relative spread</th></tr></thead>
                <tbody>{sensitivityRows.map((row) => <tr key={row.key}><th scope="row">{row.label}<small>{row.unit}</small></th><td>{formatNumber(row.low)}</td><td>{formatNumber(row.baseline)}</td><td>{formatNumber(row.high)}</td><td>{formatNumber(row.spread)}</td><td>{formatNumber(row.relativeSpread * 100, 1)}%</td></tr>)}</tbody>
              </table>
            </div>
            <div className="science-notebook-lab__input-review" role="status" aria-label="Sensitivity input review">{sensitivityWarnings.length ? <><strong>Review sensitivity inputs</strong><ul>{sensitivityWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></> : <><Check size={14} /><span>Baseline and perturbations produce a finite local response.</span></>}</div>
          </section>
          <aside className="science-notebook-lab__card science-notebook-lab__validation">
            <div className="science-notebook-lab__card-heading"><span><Target size={15} /><strong>Sensitivity reading</strong></span><small>{sensitivityWarnings.length ? "Needs review" : "Ready in preview"}</small></div>
            {sensitivityRows.map((row) => <div className="science-notebook-lab__sensitivity-meter" key={row.key}><div><span>{row.label}</span><strong>{formatNumber(row.relativeSpread * 100, 1)}%</strong></div><span className="science-notebook-lab__residual-track"><i style={{ width: `${Math.min(100, Math.max(0, Math.abs(row.relativeSpread) * 100))}%` }} /></span><small>period span across the selected ± delta</small></div>)}
            <p className="science-notebook-lab__muted">The comparison uses the same SI formula as the model review and keeps perturbations independent so the direction of influence stays visible.</p>
            <div className="science-notebook-lab__limit-list"><span><CheckCircle2 size={13} /> Reproducible deterministic formula</span><span><CheckCircle2 size={13} /> Explicit perturbation values</span><span><X size={13} /> No error bars or instrument calibration</span><span><X size={13} /> No solver, plotter, or external data</span></div>
          </aside>
        </div>
      ) : null}

      {tab === "export" ? <section id="science-notebook-panel-export" className="science-notebook-lab__card" role="tabpanel" aria-labelledby="science-notebook-tab-export"><div className="science-notebook-lab__card-heading"><span><Clipboard size={15} /><strong>Portable experiment handoff</strong></span><small>Renderer-local · no durable write</small></div><div className="science-notebook-lab__export-toolbar"><label><span>Format</span><select aria-label="Science notebook export format" value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><span role="status" aria-live="polite">{status}</span><button type="button" className="button button--ghost" onClick={() => void copy()}>{copied ? <Check size={13} /> : <Clipboard size={13} />} {copied ? "Copied" : "Copy"}</button><button type="button" className="button button--secondary" onClick={download}><Download size={13} /> Download</button></div><pre aria-label="Science notebook export payload" tabIndex={0}><code>{payload}</code></pre></section> : null}

      <footer className="science-notebook-lab__footer" role="status" aria-live="polite"><span>{status}</span><span>Preview only · renderer-local · no durable write</span></footer>
    </section>
  );
}

export default ScienceNotebookLabPreview;
