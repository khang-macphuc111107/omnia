import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Download,
  Eraser,
  FileJson2,
  History,
  LockKeyhole,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { AppRuntimeInfo } from "@/lib/desktop";

import {
  createDiagnosticPreviewEvents,
  buildDiagnosticExportPreview,
  redactDiagnosticText,
  serializeDiagnosticPreview,
  type DiagnosticPreviewCategory,
  type DiagnosticPreviewEvent,
  type DiagnosticPreviewFormat,
  type DiagnosticPreviewLevel,
} from "./diagnostics-session-contract";
import { appendSessionTelemetryEntry } from "./session-telemetry-log";

type LevelFilter = "all" | DiagnosticPreviewLevel;
type CategoryFilter = "all" | DiagnosticPreviewCategory;
type DiagnosticsExportScope = "visible" | "all";

export type DiagnosticsHistoryAction = "checkpoint" | "copy" | "export" | "clear" | "reset" | "view";

export type DiagnosticsHistoryEntry = {
  id: string;
  occurredAt: string;
  action: DiagnosticsHistoryAction;
  summary: string;
  eventCount: number;
  query: string;
  level: LevelFilter;
  category: CategoryFilter;
  format: DiagnosticPreviewFormat;
  exportScope: DiagnosticsExportScope;
};

export const DIAGNOSTICS_HISTORY_ACTION_LABELS: Record<DiagnosticsHistoryAction, string> = {
  checkpoint: "Checkpoint",
  copy: "Copied preview",
  export: "Exported preview",
  clear: "Cleared timeline",
  reset: "Reset timeline",
  view: "View change",
};

/** Filter only redacted, renderer-local history metadata. */
export function filterDiagnosticsHistory(
  entries: readonly DiagnosticsHistoryEntry[],
  query: string,
  action: DiagnosticsHistoryAction | "all",
): DiagnosticsHistoryEntry[] {
  const normalized = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (action !== "all" && entry.action !== action) return false;
    if (!normalized) return true;
    return `${entry.summary} ${entry.action} ${entry.format} ${entry.exportScope} ${entry.query}`
      .toLowerCase()
      .includes(normalized);
  });
}

type DiagnosticsViewPreset = {
  id: string;
  name: string;
  query: string;
  level: LevelFilter;
  category: CategoryFilter;
  format: DiagnosticPreviewFormat;
  exportScope: DiagnosticsExportScope;
  builtIn?: boolean;
};

const builtInViewPresets: DiagnosticsViewPreset[] = [
  { id: "all-events", name: "All events", query: "", level: "all", category: "all", format: "json", exportScope: "visible", builtIn: true },
  { id: "provider-boundary", name: "Provider boundaries", query: "", level: "warning", category: "provider", format: "jsonl", exportScope: "visible", builtIn: true },
  { id: "attention", name: "Warnings & errors", query: "", level: "warning", category: "all", format: "json", exportScope: "visible", builtIn: true },
];

const LEVEL_LABELS: Record<DiagnosticPreviewLevel, string> = {
  info: "Info",
  success: "Success",
  warning: "Warning",
  error: "Error",
};

const CATEGORY_LABELS: Record<DiagnosticPreviewCategory, string> = {
  runtime: "Runtime",
  navigation: "Navigation",
  composer: "Composer",
  provider: "Provider",
  storage: "Storage",
};

function LevelIcon({ level }: { level: DiagnosticPreviewLevel }) {
  if (level === "success") return <CheckCircle2 size={15} />;
  if (level === "warning") return <AlertTriangle size={15} />;
  if (level === "error") return <XCircle size={15} />;
  return <Activity size={15} />;
}

function downloadPreview(payload: string, format: DiagnosticPreviewFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(
    new Blob([payload], { type: format === "jsonl" ? "application/x-ndjson" : "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-renderer-diagnostics.${format}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export interface DiagnosticsSessionWorkbenchProps {
  runtime: AppRuntimeInfo;
}

export function DiagnosticsSessionWorkbench({ runtime }: DiagnosticsSessionWorkbenchProps) {
  const seedEvents = useMemo(
    () => createDiagnosticPreviewEvents(runtime),
    [runtime.appName, runtime.appVersion, runtime.tauri],
  );
  const [events, setEvents] = useState<DiagnosticPreviewEvent[]>(seedEvents);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [format, setFormat] = useState<DiagnosticPreviewFormat>("json");
  const [exportScope, setExportScope] = useState<DiagnosticsExportScope>("visible");
  const [viewPresets, setViewPresets] = useState<DiagnosticsViewPreset[]>(builtInViewPresets);
  const [selectedPresetId, setSelectedPresetId] = useState("all-events");
  const [presetName, setPresetName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(seedEvents[0]?.id ?? null);
  const [history, setHistory] = useState<DiagnosticsHistoryEntry[]>([]);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyAction, setHistoryAction] = useState<DiagnosticsHistoryAction | "all">("all");
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [status, setStatus] = useState(
    "Renderer preview timeline ready. No native diagnostic collector is connected.",
  );

  const recordHistory = (
    action: DiagnosticsHistoryAction,
    summary: string,
    eventCount: number,
  ) => {
    const id = `diagnostics-history-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const entry: DiagnosticsHistoryEntry = {
      id,
      occurredAt: new Date().toISOString(),
      action,
      // Search terms can contain a path, token, or email. Keep history redacted.
      summary: redactDiagnosticText(summary).slice(0, 240),
      eventCount,
      query: redactDiagnosticText(query.trim()).slice(0, 160),
      level,
      category,
      format,
      exportScope,
    };
    setHistory((current) => [entry, ...current].slice(0, 24));
    setSelectedHistoryId(id);
  };

  const markManualView = () => setSelectedPresetId("manual");

  const applyPreset = (preset: DiagnosticsViewPreset) => {
    setQuery(preset.query);
    setLevel(preset.level);
    setCategory(preset.category);
    setFormat(preset.format);
    setExportScope(preset.exportScope);
    setSelectedPresetId(preset.id);
    setStatus(`Applied the renderer-local diagnostics view “${preset.name}”.`);
  };

  const saveViewPreset = () => {
    const name = presetName.trim();
    if (!name) {
      setStatus("Enter a name before saving a diagnostics view.");
      return;
    }
    const existing = viewPresets.find((preset) => preset.name.toLowerCase() === name.toLowerCase() && !preset.builtIn);
    const preset: DiagnosticsViewPreset = {
      id: existing?.id ?? `custom-${Date.now()}`,
      name,
      query,
      level,
      category,
      format,
      exportScope,
    };
    setViewPresets((current) => existing
      ? current.map((item) => item.id === existing.id ? preset : item)
      : [...current, preset].slice(-12));
    setSelectedPresetId(preset.id);
    setPresetName("");
    setStatus(`Saved “${name}” as a renderer-local diagnostics view.`);
  };

  const deleteSelectedPreset = () => {
    const selected = viewPresets.find((preset) => preset.id === selectedPresetId);
    if (!selected || selected.builtIn) return;
    setViewPresets((current) => current.filter((preset) => preset.id !== selected.id));
    setSelectedPresetId("manual");
    setStatus(`Removed the renderer-local diagnostics view “${selected.name}”.`);
  };

  const filteredEvents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return events.filter((event) => {
      if (level !== "all" && event.level !== level) return false;
      if (category !== "all" && event.category !== category) return false;
      if (!normalized) return true;
      return `${event.title} ${event.detail} ${event.source} ${event.category}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [category, events, level, query]);

  const selectedEvent =
    events.find((event) => event.id === selectedId) ?? filteredEvents[0] ?? null;
  const warningCount = events.filter((event) => event.level === "warning").length;
  const errorCount = events.filter((event) => event.level === "error").length;
  const exportEvents = exportScope === "all" ? events : filteredEvents;
  const exportPreview = useMemo(
    () => buildDiagnosticExportPreview({ events: exportEvents, scope: exportScope, format }),
    [exportEvents, exportScope, format],
  );
  const visibleHistory = useMemo(
    () => filterDiagnosticsHistory(history, historyQuery, historyAction),
    [history, historyAction, historyQuery],
  );
  const selectedHistory = visibleHistory.find((entry) => entry.id === selectedHistoryId) ?? visibleHistory[0] ?? null;

  const addCheckpoint = () => {
    const checkpoint: DiagnosticPreviewEvent = {
      id: `preview-checkpoint-${Date.now()}`,
      occurredAt: new Date().toISOString(),
      level: "info",
      category: "runtime",
      title: "Manual renderer checkpoint",
      detail: "A local UI checkpoint was added. This does not capture native state, prompt content, provider payloads, or filesystem evidence.",
      source: "diagnostics-workbench",
    };
    setEvents((current) => {
      const next: DiagnosticPreviewEvent[] = [...appendSessionTelemetryEntry(current, checkpoint, { maxEntries: 200 })];
      return next;
    });
    setSelectedId(checkpoint.id);
    recordHistory("checkpoint", "Added a renderer-local checkpoint.", events.length + 1);
    setStatus("Added one renderer-local checkpoint to the preview timeline.");
  };

  const clearTimeline = () => {
    setEvents([]);
    setSelectedId(null);
    recordHistory("clear", "Cleared renderer preview events; native logs were untouched.", 0);
    setStatus("Cleared renderer preview events. No native logs were deleted.");
  };

  const resetTimeline = () => {
    setEvents(seedEvents);
    setSelectedId(seedEvents[0]?.id ?? null);
    recordHistory("reset", "Restored the renderer preview event set.", seedEvents.length);
    setStatus("Restored the renderer preview event set.");
  };

  const copyTimeline = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no diagnostic preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(serializeDiagnosticPreview(exportEvents, format));
      recordHistory("copy", `Copied ${exportEvents.length} redacted ${exportScope} events as ${format.toUpperCase()}.`, exportEvents.length);
      setStatus(`Copied ${exportEvents.length} redacted ${exportScope === "all" ? "preview" : "visible"} events as ${format.toUpperCase()}.`);
    } catch {
      setStatus("Clipboard access was denied; no diagnostic preview was copied.");
    }
  };

  const exportTimeline = () => {
    const exported = downloadPreview(serializeDiagnosticPreview(exportEvents, format), format);
    if (exported) recordHistory("export", `Exported ${exportEvents.length} redacted ${exportScope} events as ${format.toUpperCase()}.`, exportEvents.length);
    setStatus(
      exported
        ? `Exported ${exportEvents.length} redacted ${exportScope === "all" ? "preview" : "visible"} events. Native diagnostics remain untouched.`
        : "File download is unavailable in this surface; no diagnostic preview was exported.",
    );
  };

  return (
    <section className="diagnostics-workbench" aria-labelledby="diagnostics-workbench-title">
      <header className="diagnostics-workbench__header">
        <span className="diagnostics-workbench__hero-icon" aria-hidden="true">
          <FileJson2 size={21} />
        </span>
        <div>
          <span className="eyebrow">Evidence without payload exposure</span>
          <h2 id="diagnostics-workbench-title">Session Log Workbench</h2>
          <p>Explore and export a redacted renderer-local event timeline before the native collector exists.</p>
        </div>
        <span className="diagnostics-workbench__mode"><Activity size={13} /> Renderer preview</span>
      </header>

      <div className="diagnostics-workbench__metrics" aria-label="Diagnostics preview summary">
        <article><strong>{events.length}</strong><small>Preview events</small></article>
        <article><strong>{filteredEvents.length}</strong><small>Visible</small></article>
        <article className="diagnostics-workbench__metric--warning"><strong>{warningCount}</strong><small>Warnings</small></article>
        <article className="diagnostics-workbench__metric--danger"><strong>{errorCount}</strong><small>Errors</small></article>
      </div>

      <div className="diagnostics-workbench__toolbar" aria-label="Diagnostics timeline controls">
        <label className="diagnostics-workbench__search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => { setQuery(event.target.value); markManualView(); }}
            placeholder="Search safe event summaries"
            aria-label="Search diagnostic preview events"
          />
        </label>
        <label>
          <span>Level</span>
          <select value={level} onChange={(event) => { setLevel(event.target.value as LevelFilter); markManualView(); }} aria-label="Diagnostic level">
            <option value="all">All levels</option>
            {Object.entries(LEVEL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>Category</span>
          <select value={category} onChange={(event) => { setCategory(event.target.value as CategoryFilter); markManualView(); }} aria-label="Diagnostic category">
            <option value="all">All categories</option>
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>Format</span>
          <select value={format} onChange={(event) => { setFormat(event.target.value as DiagnosticPreviewFormat); markManualView(); }} aria-label="Diagnostic export format">
            <option value="json">JSON bundle</option>
            <option value="jsonl">JSONL stream</option>
          </select>
        </label>
        <label>
          <span>Export scope</span>
          <select
            value={exportScope}
            onChange={(event) => setExportScope(event.target.value as DiagnosticsExportScope)}
            aria-label="Diagnostic export scope"
          >
            <option value="visible">Visible events</option>
            <option value="all">All preview events</option>
          </select>
        </label>
      </div>

      <div className="diagnostics-workbench__presets" aria-label="Saved diagnostics views">
        <label className="diagnostics-workbench__preset-select">
          <span>Saved view</span>
          <select
            value={selectedPresetId}
            onChange={(event) => {
              const value = event.target.value;
              setSelectedPresetId(value);
              const preset = viewPresets.find((item) => item.id === value);
              if (preset) applyPreset(preset);
            }}
            aria-label="Saved diagnostics view"
          >
            <option value="manual">Manual current filters</option>
            {viewPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}{preset.builtIn ? " · built-in" : ""}</option>)}
          </select>
        </label>
        <label className="diagnostics-workbench__preset-name">
          <span>Save current as</span>
          <input value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="e.g. provider handoff" aria-label="Saved view name" />
        </label>
        <button type="button" className="button button--ghost" onClick={saveViewPreset}><Save size={14} /> Save view</button>
        <button type="button" className="button button--ghost" onClick={deleteSelectedPreset} disabled={!viewPresets.some((preset) => preset.id === selectedPresetId && !preset.builtIn)} aria-label="Delete saved diagnostics view" title="Delete selected custom view"><Trash2 size={14} /> Delete</button>
      </div>

      <div className="diagnostics-workbench__actions" role="toolbar" aria-label="Diagnostics preview actions">
        <button type="button" className="button button--secondary" onClick={addCheckpoint}>
          <Plus size={14} /> Add checkpoint
        </button>
        <button type="button" className="button button--secondary" onClick={() => void copyTimeline()}>
          <Clipboard size={14} /> Copy {exportScope === "all" ? "all" : "visible"}
        </button>
        <button type="button" className="button button--primary" onClick={exportTimeline}>
          <Download size={14} /> Export {exportScope === "all" ? "all" : "visible"} {format.toUpperCase()}
        </button>
        <span className="diagnostics-workbench__action-spacer" />
        <button type="button" className="button button--ghost" onClick={resetTimeline} disabled={events === seedEvents}>
          <RefreshCw size={14} /> Reset preview
        </button>
        <button type="button" className="button button--danger-ghost" onClick={clearTimeline} disabled={events.length === 0}>
          <Eraser size={14} /> Clear preview
        </button>
      </div>

      <section className="diagnostics-export-preview" aria-label="Diagnostics export preview">
        <header className="diagnostics-export-preview__header">
          <div>
            <span className="eyebrow">Review before download</span>
            <h3>Export preview</h3>
          </div>
          <span className="diagnostics-export-preview__ready"><ShieldCheck size={14} /> Redaction ready</span>
        </header>
        <div className="diagnostics-export-preview__facts">
          <div><small>Scope</small><strong>{exportPreview.scope === "all" ? "All preview events" : "Visible filtered events"}</strong></div>
          <div><small>Payload</small><strong>{exportPreview.eventCount} events · {exportPreview.format.toUpperCase()}</strong></div>
          <div><small>Retention</small><strong>Download only</strong></div>
          <div><small>Policy</small><strong>{exportPreview.redactionPolicy}</strong></div>
        </div>
        <div className="diagnostics-export-preview__columns">
          <div>
            <span className="diagnostics-export-preview__label">Included data planes</span>
            {exportPreview.dataPlanes.map((item) => <p key={item}>✓ {item}</p>)}
          </div>
          <div>
            <span className="diagnostics-export-preview__label">Excluded by contract</span>
            {exportPreview.excludedData.map((item) => <p key={item}>× {item}</p>)}
          </div>
          <div>
            <span className="diagnostics-export-preview__label">Validation checks</span>
            {exportPreview.validation.checks.map((item) => <p key={item}>✓ {item}</p>)}
          </div>
        </div>
        <p className="diagnostics-export-preview__note">
          This review describes the renderer-local payload that the Copy and Export buttons will produce. It does not authorize native log collection, provider upload, or durable storage.
        </p>
      </section>

      <section className="diagnostics-history" aria-label="Diagnostics activity history">
        <header className="diagnostics-history__header">
          <div>
            <span className="eyebrow">Session-only activity ledger</span>
            <h3><History size={15} /> Diagnostics activity history</h3>
            <p>Review recent preview actions and restore their filter context without replaying logs.</p>
          </div>
          <span className="diagnostics-history__count">{history.length} / 24 retained</span>
        </header>
        <div className="diagnostics-history__toolbar" role="toolbar" aria-label="Diagnostics history filters">
          <label className="diagnostics-history__search">
            <Search size={13} />
            <input
              value={historyQuery}
              onChange={(event) => setHistoryQuery(event.target.value)}
              placeholder="Search activity"
              aria-label="Search diagnostics activity history"
            />
          </label>
          <label>
            <span>Action</span>
            <select value={historyAction} onChange={(event) => setHistoryAction(event.target.value as DiagnosticsHistoryAction | "all")} aria-label="Diagnostics history action">
              <option value="all">All actions</option>
              {Object.entries(DIAGNOSTICS_HISTORY_ACTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <button type="button" className="button button--ghost" onClick={() => { setHistory([]); setSelectedHistoryId(null); setStatus("Cleared renderer activity history. Native logs were untouched."); }} disabled={history.length === 0}>
            <Eraser size={13} /> Clear history
          </button>
        </div>
        <div className="diagnostics-history__layout">
          <div className="diagnostics-history__list" aria-label="Diagnostics activity entries">
            {visibleHistory.map((entry) => (
              <article key={entry.id} className={selectedHistory?.id === entry.id ? "diagnostics-history__entry diagnostics-history__entry--active" : "diagnostics-history__entry"}>
                <button type="button" onClick={() => setSelectedHistoryId(entry.id)} aria-pressed={selectedHistory?.id === entry.id}>
                  <span className="diagnostics-history__entry-icon"><History size={13} /></span>
                  <span className="diagnostics-history__entry-copy"><strong>{DIAGNOSTICS_HISTORY_ACTION_LABELS[entry.action]}</strong><small>{entry.summary}</small></span>
                  <time dateTime={entry.occurredAt}>{new Date(entry.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                </button>
              </article>
            ))}
            {visibleHistory.length === 0 ? <p className="diagnostics-history__empty">No activity entries match this filter. Actions stay in this renderer session only.</p> : null}
          </div>
          <aside className="diagnostics-history__detail" aria-label="Selected diagnostics activity">
            {selectedHistory ? (
              <>
                <span className="diagnostics-history__detail-label">Selected activity</span>
                <h4>{DIAGNOSTICS_HISTORY_ACTION_LABELS[selectedHistory.action]}</h4>
                <p>{selectedHistory.summary}</p>
                <dl>
                  <div><dt>Events</dt><dd>{selectedHistory.eventCount}</dd></div>
                  <div><dt>Filters</dt><dd>{selectedHistory.level} · {selectedHistory.category}</dd></div>
                  <div><dt>Format</dt><dd>{selectedHistory.format.toUpperCase()} · {selectedHistory.exportScope}</dd></div>
                </dl>
                <button type="button" className="button button--secondary" onClick={() => { setQuery(selectedHistory.query); setLevel(selectedHistory.level); setCategory(selectedHistory.category); setFormat(selectedHistory.format); setExportScope(selectedHistory.exportScope); setSelectedPresetId("manual"); setStatus("Restored diagnostics filters from a renderer-local activity entry."); }}>
                  <RefreshCw size={13} /> Restore filters
                </button>
              </>
            ) : <p className="diagnostics-history__empty">Select an activity entry to inspect its redacted filter context.</p>}
          </aside>
        </div>
        <p className="diagnostics-history__boundary">Preview only · renderer-local. History stores action metadata, not raw payloads, prompt bodies, files, native receipts, or durable logs.</p>
      </section>

      <div className="diagnostics-workbench__body">
        <div className="diagnostics-timeline" role="list" aria-label="Diagnostic preview event timeline">
          {filteredEvents.map((event) => (
            <div role="listitem" key={event.id}>
              <button
                type="button"
                className={selectedEvent?.id === event.id ? `diagnostics-event diagnostics-event--${event.level} diagnostics-event--active` : `diagnostics-event diagnostics-event--${event.level}`}
                aria-pressed={selectedEvent?.id === event.id}
                onClick={() => setSelectedId(event.id)}
              >
                <span className="diagnostics-event__icon"><LevelIcon level={event.level} /></span>
                <span className="diagnostics-event__copy">
                  <strong>{event.title}</strong>
                  <small>{CATEGORY_LABELS[event.category]} · {event.source}</small>
                </span>
                <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
              </button>
            </div>
          ))}
          {filteredEvents.length === 0 ? (
            <div className="diagnostics-workbench__empty" role="note" aria-label="Empty diagnostics preview">
              <Search size={20} />
              <strong>No preview events match</strong>
              <span>Change the filters or reset the renderer preview timeline.</span>
            </div>
          ) : null}
        </div>

        <aside className="diagnostics-detail" aria-label="Selected diagnostic event">
          {selectedEvent ? (
            <>
              <div className={`diagnostics-detail__level diagnostics-detail__level--${selectedEvent.level}`}>
                <LevelIcon level={selectedEvent.level} /> {LEVEL_LABELS[selectedEvent.level]}
              </div>
              <h3>{selectedEvent.title}</h3>
              <p>{selectedEvent.detail}</p>
              <dl>
                <div><dt>Category</dt><dd>{CATEGORY_LABELS[selectedEvent.category]}</dd></div>
                <div><dt>Source</dt><dd>{selectedEvent.source}</dd></div>
                <div><dt>Scope</dt><dd>Renderer session</dd></div>
                <div><dt>Native receipt</dt><dd>Unavailable</dd></div>
              </dl>
            </>
          ) : (
            <div className="diagnostics-detail__empty">
              <ShieldCheck size={24} />
              <strong>No event selected</strong>
              <span>The preview timeline contains no native or durable evidence.</span>
            </div>
          )}
        </aside>
      </div>

      <div className="diagnostics-workbench__boundary" role="note" aria-label="Diagnostics privacy boundary">
        <LockKeyhole size={14} />
        <span><strong>Redacted by contract.</strong> Prompt bodies, credentials, cookies, raw secrets, and raw local paths are excluded. Native crash logs, storage evidence, and durable receipts remain planned.</span>
      </div>
      <p className="diagnostics-workbench__status" role="status" aria-live="polite">{status}</p>
    </section>
  );
}
