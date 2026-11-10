import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Download,
  Eye,
  Filter,
  Info,
  Pin,
  PinOff,
  RotateCcw,
  Save,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
} from "lucide-react";

export type TelemetryInspectorStatus = "observed" | "partial" | "unknown" | "planned";
export type TelemetryInspectorKind = "run" | "attempt" | "usage" | "timing" | "health" | "checkpoint";
export type TelemetryInspectorScope = "all" | "workspace" | "project" | "chat" | "run";
export type TelemetryInspectorFormat = "json" | "markdown";

export interface TelemetryInspectorFilters {
  readonly scope: TelemetryInspectorScope;
  readonly kind: TelemetryInspectorKind | "all";
  readonly status: TelemetryInspectorStatus | "all";
  readonly query: string;
}

export interface TelemetryInspectorSavedView {
  readonly id: string;
  readonly name: string;
  readonly filters: TelemetryInspectorFilters;
  readonly builtIn: boolean;
}

export interface TelemetryInspectorField {
  readonly label: string;
  readonly value: string;
  readonly state: "observed" | "unknown";
}

export interface TelemetryInspectorRecord {
  readonly id: string;
  readonly kind: TelemetryInspectorKind;
  readonly title: string;
  readonly scope: Exclude<TelemetryInspectorScope, "all">;
  readonly status: TelemetryInspectorStatus;
  readonly source: string;
  readonly observedAt: string;
  readonly summary: string;
  readonly fields: readonly TelemetryInspectorField[];
}

export const TELEMETRY_INSPECTOR_RECORDS: readonly TelemetryInspectorRecord[] = Object.freeze([
  {
    id: "telemetry-run-lifecycle",
    kind: "run",
    title: "Run lifecycle envelope",
    scope: "workspace",
    status: "partial",
    source: "renderer-demo",
    observedAt: "session-only",
    summary: "A content-free run shape is visible, but no native journal cursor is joined.",
    fields: [
      { label: "Run ID", value: "run-preview-001", state: "observed" },
      { label: "Lifecycle", value: "preparing → streaming", state: "observed" },
      { label: "Native cursor", value: "Unknown", state: "unknown" },
      { label: "Freshness", value: "Session-only", state: "observed" },
    ],
  },
  {
    id: "telemetry-provider-attempt",
    kind: "attempt",
    title: "Provider attempt boundary",
    scope: "project",
    status: "partial",
    source: "renderer-demo",
    observedAt: "session-only",
    summary: "Retry and fallback slots are represented without making a provider request.",
    fields: [
      { label: "Attempt", value: "attempt-preview-01", state: "observed" },
      { label: "Provider acceptance", value: "Unknown", state: "unknown" },
      { label: "Fallback successor", value: "Not connected", state: "unknown" },
      { label: "Dispatch authority", value: "None", state: "observed" },
    ],
  },
  {
    id: "telemetry-usage-ledger",
    kind: "usage",
    title: "Usage ledger observation",
    scope: "chat",
    status: "partial",
    source: "renderer-demo",
    observedAt: "session-only",
    summary: "Synthetic usage units are visible; provider-reported counters remain separate.",
    fields: [
      { label: "Input units", value: "38 demo units", state: "observed" },
      { label: "Output units", value: "Unknown", state: "unknown" },
      { label: "Cost statement", value: "No native statement", state: "unknown" },
      { label: "Authority", value: "Renderer estimate", state: "observed" },
    ],
  },
  {
    id: "telemetry-timing-marks",
    kind: "timing",
    title: "Timing marks",
    scope: "run",
    status: "unknown",
    source: "not-collected",
    observedAt: "not collected",
    summary: "No monotonic dispatch, first-byte, or terminal marks are available in this preview.",
    fields: [
      { label: "Dispatch started", value: "Unknown", state: "unknown" },
      { label: "First visible output", value: "Unknown", state: "unknown" },
      { label: "Terminal mark", value: "Unknown", state: "unknown" },
      { label: "Clock domain", value: "Not established", state: "unknown" },
    ],
  },
  {
    id: "telemetry-provider-health",
    kind: "health",
    title: "Provider health snapshot",
    scope: "project",
    status: "unknown",
    source: "not-collected",
    observedAt: "not collected",
    summary: "The browser preview does not query credentials, transport, or model health.",
    fields: [
      { label: "Connection", value: "Unknown", state: "unknown" },
      { label: "Latency", value: "Unknown", state: "unknown" },
      { label: "Model catalog", value: "Unknown", state: "unknown" },
      { label: "Quota", value: "Unknown", state: "unknown" },
    ],
  },
  {
    id: "telemetry-checkpoint-receipt",
    kind: "checkpoint",
    title: "Durable checkpoint receipt",
    scope: "run",
    status: "planned",
    source: "native-runtime",
    observedAt: "not collected",
    summary: "Native retention, replay cursor, and export checkpoint wiring are planned.",
    fields: [
      { label: "Checkpoint ID", value: "Planned", state: "unknown" },
      { label: "Retention", value: "Planned", state: "unknown" },
      { label: "Replay cursor", value: "Planned", state: "unknown" },
      { label: "Export receipt", value: "Planned", state: "unknown" },
    ],
  },
]);

const KIND_LABELS: Record<TelemetryInspectorKind, string> = {
  run: "Run lifecycle",
  attempt: "Provider attempt",
  usage: "Usage",
  timing: "Timing",
  health: "Provider health",
  checkpoint: "Checkpoint",
};

const STATUS_LABELS: Record<TelemetryInspectorStatus, string> = {
  observed: "Observed in preview",
  partial: "Partial evidence",
  unknown: "Unknown",
  planned: "Planned",
};

function statusIcon(status: TelemetryInspectorStatus) {
  if (status === "observed") return <CheckCircle2 size={14} aria-hidden="true" />;
  if (status === "partial") return <Info size={14} aria-hidden="true" />;
  if (status === "unknown") return <AlertTriangle size={14} aria-hidden="true" />;
  return <Sparkles size={14} aria-hidden="true" />;
}

function statusClass(status: TelemetryInspectorStatus): string {
  return `telemetry-inspector__status telemetry-inspector__status--${status}`;
}

function titleForKind(kind: TelemetryInspectorKind): string {
  return KIND_LABELS[kind];
}

function downloadPreview(payload: string, format: TelemetryInspectorFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-telemetry-inspector.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

const BUILT_IN_VIEWS: readonly TelemetryInspectorSavedView[] = Object.freeze([
  { id: "all-records", name: "All records", filters: { scope: "all", kind: "all", status: "all", query: "" }, builtIn: true },
  { id: "evidence-gaps", name: "Evidence gaps", filters: { scope: "all", kind: "all", status: "unknown", query: "" }, builtIn: true },
  { id: "provider-boundaries", name: "Provider boundaries", filters: { scope: "all", kind: "attempt", status: "all", query: "" }, builtIn: true },
]);

export function serializeTelemetryInspector(
  records: readonly TelemetryInspectorRecord[],
  input: {
    readonly scope: TelemetryInspectorScope;
    readonly kind: TelemetryInspectorKind | "all";
    readonly status: TelemetryInspectorStatus | "all";
    readonly query: string;
    readonly selectedId: string | null;
    readonly pinnedIds: readonly string[];
    readonly format: TelemetryInspectorFormat;
  },
): string {
  const payload = {
    schema: "omnia.telemetry-inspector.preview.v1",
    scope: "renderer-session",
    filters: {
      scope: input.scope,
      kind: input.kind,
      status: input.status,
      query: input.query.trim() || null,
    },
    selectedId: input.selectedId,
    pinnedIds: input.pinnedIds,
    records,
    boundary: [
      "This is a renderer-local telemetry inspection preview, not a native telemetry receipt.",
      "Observed means visible in this preview; it does not mean provider-reported or durable.",
      "Unknown is not zero, healthy, accepted, unlimited, or successful.",
      "No provider request, native journal read, filesystem write, or durable export was created.",
      "Prompt bodies, responses, credentials, cookies, raw paths, and raw tool payloads are excluded.",
    ],
  };
  if (input.format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia telemetry inspector preview",
    "",
    "> Renderer-session inspection only. This is not a native telemetry receipt.",
    "",
    `- Schema: ${payload.schema}`,
    `- Scope filter: ${input.scope}`,
    `- Kind filter: ${input.kind}`,
    `- Status filter: ${input.status}`,
    `- Query: ${input.query.trim() || "(none)"}`,
    `- Selected: ${input.selectedId ?? "(none)"}`,
    `- Pinned: ${input.pinnedIds.length}`,
    "",
    "## Records",
    ...records.flatMap((record) => [
      `### ${record.title}`,
      `- Kind: ${titleForKind(record.kind)}`,
      `- Scope: ${record.scope}`,
      `- Status: ${STATUS_LABELS[record.status]}`,
      `- Source: ${record.source}`,
      `- Summary: ${record.summary}`,
      ...record.fields.map((field) => `- ${field.label}: ${field.value} (${field.state})`),
      "",
    ]),
    "## Boundary",
    ...payload.boundary.map((line) => `- ${line}`),
  ].join("\n");
}

export function TelemetryInspectorPreview() {
  const [scope, setScope] = useState<TelemetryInspectorScope>("all");
  const [kind, setKind] = useState<TelemetryInspectorKind | "all">("all");
  const [status, setStatus] = useState<TelemetryInspectorStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [savedViews, setSavedViews] = useState<TelemetryInspectorSavedView[]>([...BUILT_IN_VIEWS]);
  const [activeViewId, setActiveViewId] = useState<string | null>(BUILT_IN_VIEWS[0]?.id ?? null);
  const [viewName, setViewName] = useState("");
  const [format, setFormat] = useState<TelemetryInspectorFormat>("json");
  const [selectedId, setSelectedId] = useState<string | null>(TELEMETRY_INSPECTOR_RECORDS[0]?.id ?? null);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [notice, setNotice] = useState("Renderer-local telemetry stream ready. No native collector is connected.");

  const visibleRecords = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return TELEMETRY_INSPECTOR_RECORDS.filter((record) => {
      if (scope !== "all" && record.scope !== scope) return false;
      if (kind !== "all" && record.kind !== kind) return false;
      if (status !== "all" && record.status !== status) return false;
      if (!normalized) return true;
      return `${record.title} ${record.kind} ${record.scope} ${record.status} ${record.source} ${record.summary} ${record.fields.map((field) => `${field.label} ${field.value}`).join(" ")}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [kind, query, scope, status]);

  const selected = visibleRecords.find((record) => record.id === selectedId) ?? visibleRecords[0] ?? null;
  const counts = useMemo(() => visibleRecords.reduce<Record<TelemetryInspectorStatus, number>>(
    (result, record) => {
      result[record.status] += 1;
      return result;
    },
    { observed: 0, partial: 0, unknown: 0, planned: 0 },
  ), [visibleRecords]);
  const payload = useMemo(() => serializeTelemetryInspector(visibleRecords, { scope, kind, status, query, selectedId: selected?.id ?? null, pinnedIds, format }), [format, kind, pinnedIds, query, scope, selected, selectedId, status, visibleRecords]);

  const updateFilters = (next: Partial<TelemetryInspectorFilters>) => {
    if (next.scope !== undefined) setScope(next.scope);
    if (next.kind !== undefined) setKind(next.kind);
    if (next.status !== undefined) setStatus(next.status);
    if (next.query !== undefined) setQuery(next.query);
    setActiveViewId(null);
  };

  const applySavedView = (id: string) => {
    const view = savedViews.find((candidate) => candidate.id === id);
    if (!view) {
      setActiveViewId(null);
      return;
    }
    setScope(view.filters.scope);
    setKind(view.filters.kind);
    setStatus(view.filters.status);
    setQuery(view.filters.query);
    setActiveViewId(view.id);
    setNotice(`Loaded “${view.name}” filters for this session.`);
  };

  const saveCurrentView = () => {
    const name = viewName.trim();
    if (!name) {
      setNotice("Add a name before saving this telemetry view.");
      return;
    }
    const id = `telemetry-custom-${Date.now()}-${savedViews.length}`;
    const view: TelemetryInspectorSavedView = {
      id,
      name,
      filters: { scope, kind, status, query },
      builtIn: false,
    };
    setSavedViews((current) => [...current, view]);
    setActiveViewId(id);
    setViewName("");
    setNotice(`Saved “${name}” as a renderer-session view.`);
  };

  const deleteActiveView = () => {
    const active = savedViews.find((view) => view.id === activeViewId);
    if (!active || active.builtIn) return;
    setSavedViews((current) => current.filter((view) => view.id !== active.id));
    setActiveViewId(null);
    setNotice(`Removed “${active.name}” from this session. Current filters are unchanged.`);
  };

  const reset = () => {
    setScope("all");
    setKind("all");
    setStatus("all");
    setQuery("");
    setActiveViewId(BUILT_IN_VIEWS[0]?.id ?? null);
    setSelectedId(TELEMETRY_INSPECTOR_RECORDS[0]?.id ?? null);
    setPinnedIds([]);
    setNotice("Reset the renderer-local telemetry inspector view.");
  };

  const togglePinned = () => {
    if (!selected) {
      setNotice("No visible telemetry record is selected.");
      return;
    }
    setPinnedIds((current) => current.includes(selected.id) ? current.filter((id) => id !== selected.id) : [...current, selected.id]);
    setNotice(pinnedIds.includes(selected.id) ? `Unpinned ${selected.title}.` : `Pinned ${selected.title} in this session.`);
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setNotice("Clipboard unavailable; nothing was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setNotice(`Copied ${format.toUpperCase()} telemetry inspector preview.`);
    } catch {
      setNotice("Clipboard access was denied; nothing was copied.");
    }
  };

  const download = () => {
    setNotice(downloadPreview(payload, format) ? "Downloaded a renderer-local telemetry snapshot." : "Download unavailable in this preview.");
  };

  return (
    <section className="telemetry-inspector" aria-labelledby="telemetry-inspector-heading">
      <header className="telemetry-inspector__header">
        <div>
          <span className="eyebrow">Telemetry · event stream · provenance</span>
          <h2 id="telemetry-inspector-heading">Telemetry inspector</h2>
          <p>Filter one bounded event stream, inspect field-level evidence, and pin the records you want to revisit.</p>
        </div>
        <span className="telemetry-inspector__badge"><Eye size={13} /> Renderer preview</span>
      </header>

      <div className="telemetry-inspector__summary" aria-label="Telemetry inspector summary">
        <article><Activity size={15} /><span>Visible records</span><strong>{visibleRecords.length}</strong><small>session fixture</small></article>
        <article><CheckCircle2 size={15} /><span>Observed</span><strong>{counts.observed}</strong><small>preview-visible</small></article>
        <article><Info size={15} /><span>Partial</span><strong>{counts.partial}</strong><small>evidence gap</small></article>
        <article><AlertTriangle size={15} /><span>Unknown / planned</span><strong>{counts.unknown + counts.planned}</strong><small>not success</small></article>
      </div>

      <section className="telemetry-inspector__views" aria-label="Saved telemetry triage views">
        <div className="telemetry-inspector__views-heading"><div><span className="eyebrow">Reusable triage</span><strong>Saved filter views</strong><small>Built-in and custom views stay in this renderer session.</small></div><label><span>Load view</span><select aria-label="Load saved telemetry view" value={activeViewId ?? ""} onChange={(event) => applySavedView(event.target.value)}><option value="">Custom filters</option>{savedViews.map((view) => <option key={view.id} value={view.id}>{view.name}{view.builtIn ? " · built-in" : " · session"}</option>)}</select></label></div>
        <div className="telemetry-inspector__views-actions"><label><span className="sr-only">Saved telemetry view name</span><input aria-label="Saved telemetry view name" value={viewName} onChange={(event) => setViewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveCurrentView(); }} placeholder="Name this filter view…" /></label><button type="button" className="button button--secondary" onClick={saveCurrentView} disabled={!viewName.trim()}><Save size={13} /> Save current filters</button><button type="button" className="button button--ghost" onClick={deleteActiveView} disabled={!savedViews.some((view) => view.id === activeViewId && !view.builtIn)}><Trash2 size={13} /> Delete custom view</button><span className="telemetry-inspector__view-state" aria-live="polite">{activeViewId ? `Active: ${savedViews.find((view) => view.id === activeViewId)?.name ?? "saved view"}` : "Unsaved filter combination"}</span></div>
      </section>

      <div className="telemetry-inspector__toolbar" role="toolbar" aria-label="Telemetry inspector filters">
        <label className="telemetry-inspector__search"><Search size={14} aria-hidden="true" /><span className="sr-only">Search telemetry records</span><input aria-label="Search telemetry records" value={query} onChange={(event) => updateFilters({ query: event.target.value })} placeholder="Search event, source, field…" /></label>
        <label><span>Scope</span><select aria-label="Telemetry inspector scope" value={scope} onChange={(event) => updateFilters({ scope: event.target.value as TelemetryInspectorScope })}><option value="all">All scopes</option><option value="workspace">Workspace</option><option value="project">Project</option><option value="chat">Chat</option><option value="run">Run</option></select></label>
        <label><span>Kind</span><select aria-label="Telemetry inspector kind" value={kind} onChange={(event) => updateFilters({ kind: event.target.value as TelemetryInspectorKind | "all" })}><option value="all">All kinds</option>{Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Status</span><select aria-label="Telemetry inspector status" value={status} onChange={(event) => updateFilters({ status: event.target.value as TelemetryInspectorStatus | "all" })}><option value="all">All statuses</option><option value="observed">Observed in preview</option><option value="partial">Partial evidence</option><option value="unknown">Unknown</option><option value="planned">Planned</option></select></label>
        <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={13} /> Reset view</button>
        <span className="telemetry-inspector__result" role="status" aria-live="polite">{visibleRecords.length} of {TELEMETRY_INSPECTOR_RECORDS.length} records · {notice}</span>
      </div>

      <div className="telemetry-inspector__layout">
        <div className="telemetry-inspector__list" role="list" aria-label="Telemetry inspector events">
          {visibleRecords.length === 0 ? <div className="telemetry-inspector__empty"><Filter size={18} /><strong>No telemetry records match</strong><p>Try resetting the filters. Unknown data remains absent instead of becoming zero.</p></div> : null}
          {visibleRecords.map((record) => {
            const isSelected = selected?.id === record.id;
            const isPinned = pinnedIds.includes(record.id);
            return <button key={record.id} type="button" role="listitem" className={`telemetry-inspector__record${isSelected ? " is-selected" : ""}`} aria-pressed={isSelected} onClick={() => setSelectedId(record.id)}>
              <span className="telemetry-inspector__record-icon">{statusIcon(record.status)}</span>
              <span className="telemetry-inspector__record-copy"><strong>{record.title}</strong><small>{titleForKind(record.kind)} · {record.scope} · {record.source}</small><span>{record.summary}</span></span>
              <span className="telemetry-inspector__record-meta">{isPinned ? <Pin size={13} aria-label="Pinned" /> : null}<span className={statusClass(record.status)}>{STATUS_LABELS[record.status]}</span></span>
            </button>;
          })}
        </div>

        <aside className="telemetry-inspector__detail" aria-label="Selected telemetry record">
          {selected ? <>
            <header><div><span className="eyebrow">Selected record</span><h3>{selected.title}</h3><p>{selected.summary}</p></div><span className={statusClass(selected.status)}>{statusIcon(selected.status)} {STATUS_LABELS[selected.status]}</span></header>
            <div className="telemetry-inspector__detail-meta"><span>{titleForKind(selected.kind)}</span><span>Scope: {selected.scope}</span><span>Source: {selected.source}</span><span>Freshness: {selected.observedAt}</span></div>
            <div className="telemetry-inspector__fields"><h4>Fields</h4>{selected.fields.map((field) => <div key={field.label}><span>{field.label}</span><strong className={field.state === "unknown" ? "is-unknown" : undefined}>{field.value}</strong><small>{field.state === "observed" ? "Visible in renderer preview" : "No observation collected"}</small></div>)}</div>
            <button type="button" className="button button--ghost" onClick={togglePinned}>{pinnedIds.includes(selected.id) ? <PinOff size={13} /> : <Pin size={13} />}{pinnedIds.includes(selected.id) ? "Unpin record" : "Pin record"}</button>
          </> : <div className="telemetry-inspector__empty"><ShieldAlert size={18} /><strong>No selected record</strong><p>There is no visible telemetry evidence for this filter.</p></div>}
        </aside>
      </div>

      <section className="telemetry-inspector__export" aria-label="Telemetry inspector export preview">
        <div className="telemetry-inspector__export-toolbar"><div><span className="eyebrow">Portable snapshot</span><strong>Export the visible inspection view</strong></div><label><span>Format</span><select aria-label="Telemetry inspector export format" value={format} onChange={(event) => setFormat(event.target.value as TelemetryInspectorFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={download}><Download size={13} /> Download</button></div>
        <pre tabIndex={0}><code>{payload}</code></pre>
      </section>

      <p className="telemetry-inspector__boundary" role="note" aria-label="Telemetry inspector boundary"><ShieldAlert size={14} /> Observed means renderer-visible only. Unknown is not pass, zero, healthy, accepted, unlimited, or successful. This workbench does not query providers, read a native journal, write files, persist pins, or create a durable receipt.</p>
    </section>
  );
}

export default TelemetryInspectorPreview;
