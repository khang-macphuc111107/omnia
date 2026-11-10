import {
  BellRing,
  Check,
  Clipboard,
  Download,
  Eye,
  Filter,
  LockKeyhole,
  Redo2,
  RotateCcw,
  SlidersHorizontal,
  Undo2,
  Volume2,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  parseSignalPreferences,
  replaceSignalPreferences,
  resetSignalPreferences,
  redoSignalPreferences,
  SIGNAL_FILTER_OPTIONS,
  SIGNAL_SOURCE_OPTIONS,
  serializeSignalPreferences,
  undoSignalPreferences,
  updateSignalPreferences,
  useSignalPreferences,
  type SignalDefaultFilter,
  type SignalExportFormat,
  type SignalGrouping,
  type SignalPreferences,
  type SignalReviewMode,
  type SignalSource,
  type SignalVoiceMode,
  type SignalVoicePreset,
  type SignalVoicePriority,
  type SignalVoiceRate,
} from "./session-signal-contract";

function downloadPreferences(payload: string, format: SignalExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-signal-preferences-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function SignalPreferencesPreview() {
  const session = useSignalPreferences();
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importPayload, setImportPayload] = useState("");
  const [importFormat, setImportFormat] = useState<SignalExportFormat>("json");
  const [format, setFormat] = useState<SignalExportFormat>("json");
  const [status, setStatus] = useState("Preferences stay in this renderer session until a native settings bridge exists.");
  const preferences = session.present;
  const enabledCount = SIGNAL_SOURCE_OPTIONS.filter(({ id }) => preferences.enabledSources[id]).length;
  const payload = useMemo(() => serializeSignalPreferences(preferences, format), [format, preferences]);

  const update = (patch: Partial<SignalPreferences>, message: string) => {
    updateSignalPreferences(patch);
    setStatus(message);
  };

  const toggleSource = (source: SignalSource) => {
    const enabledSources = { ...preferences.enabledSources, [source]: !preferences.enabledSources[source] };
    update({ enabledSources }, `${source} signals ${enabledSources[source] ? "enabled" : "hidden"} in the renderer preview.`);
  };

  const undo = () => {
    undoSignalPreferences();
    setStatus("Undid the last signal preference change.");
  };

  const redo = () => {
    redoSignalPreferences();
    setStatus("Reapplied the next signal preference change.");
  };

  const reset = () => {
    resetSignalPreferences();
    setStatus("Signal preferences reset to renderer defaults.");
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard is unavailable; no preferences were copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(`Copied the renderer-local ${format.toUpperCase()} signal preference preview.`);
    } catch {
      setStatus("Clipboard access was denied; the preview remains renderer-local.");
    }
  };

  const importPreview = () => {
    const imported = parseSignalPreferences(importPayload, importFormat, preferences);
    if (!imported) {
      setStatus("The import preview could not parse a supported signal preference payload.");
      return;
    }
    replaceSignalPreferences(imported);
    setImportOpen(false);
    setStatus(`Imported ${importFormat.toUpperCase()} signal preferences into this renderer session; no durable write was made.`);
  };

  return (
    <section className="signal-preferences-preview" aria-labelledby="signal-preferences-title">
      <header className="signal-preferences-preview__header">
        <div>
          <span className="eyebrow"><BellRing size={13} /> Signal preferences</span>
          <h2 id="signal-preferences-title">Tune the signal stream for this session</h2>
          <p>Choose sources, ordering, review behavior, and export shape without changing native notifications or durable workspace settings.</p>
        </div>
        <span className="signal-preferences-preview__badge"><Eye size={12} /> Preview only</span>
      </header>

      <div className="signal-preferences-preview__metrics" aria-label="Signal preference summary">
        <article><span><Filter size={14} /></span><strong>{enabledCount}/{SIGNAL_SOURCE_OPTIONS.length}</strong><small>sources visible</small></article>
        <article><span><SlidersHorizontal size={14} /></span><strong>{preferences.defaultFilter}</strong><small>default filter</small></article>
        <article><span><BellRing size={14} /></span><strong>{preferences.snoozeMinutes}m</strong><small>session snooze</small></article>
        <article><span><Undo2 size={14} /></span><strong>{session.past.length}</strong><small>undo steps</small></article>
      </div>

      <div className="signal-preferences-preview__grid">
        <fieldset className="signal-preferences-preview__panel">
          <legend>Visible signal sources</legend>
          <p>These switches affect the renderer projection only.</p>
          <div className="signal-preferences-preview__source-list">
            {SIGNAL_SOURCE_OPTIONS.map(({ id, label, detail }) => (
              <label key={id} className={preferences.enabledSources[id] ? "is-enabled" : ""}>
                <input type="checkbox" checked={preferences.enabledSources[id]} onChange={() => toggleSource(id)} />
                <span><strong>{label}</strong><small>{detail}</small></span>
                {preferences.enabledSources[id] ? <Check size={14} aria-hidden="true" /> : null}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="signal-preferences-preview__panel">
          <legend>Ordering and review</legend>
          <label className="signal-preferences-preview__select"><span>Default filter</span><select value={preferences.defaultFilter} onChange={(event) => update({ defaultFilter: event.target.value as SignalDefaultFilter }, "Default filter changed in the renderer preview.")} aria-label="Signal default filter">{SIGNAL_FILTER_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <label className="signal-preferences-preview__select"><span>Group signals by</span><select value={preferences.grouping} onChange={(event) => update({ grouping: event.target.value as SignalGrouping }, "Signal grouping changed in the renderer preview.")} aria-label="Signal grouping"><option value="priority">Priority</option><option value="source">Source</option><option value="recent">Most recent</option></select></label>
          <label className="signal-preferences-preview__select"><span>Review behavior</span><select value={preferences.reviewMode} onChange={(event) => update({ reviewMode: event.target.value as SignalReviewMode }, "Review behavior changed in the renderer preview.")} aria-label="Signal review behavior"><option value="manual">Manual review</option><option value="on-open">Mark on open</option><option value="after-open">Mark after opening details</option></select></label>
          <label className="signal-preferences-preview__select"><span>Snooze duration</span><select value={preferences.snoozeMinutes} onChange={(event) => update({ snoozeMinutes: Number(event.target.value) as SignalPreferences["snoozeMinutes"] }, "Snooze duration changed in the renderer preview.")} aria-label="Signal snooze duration"><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option></select></label>
        </fieldset>
      </div>

      <fieldset className="signal-preferences-preview__panel signal-preferences-preview__voice-panel">
        <legend><Volume2 size={14} aria-hidden="true" /> Voice delivery rehearsal</legend>
        <p>Choose how attention signals could be spoken later. Changing this preview never starts speech or opens microphone access.</p>
        <div className="signal-preferences-preview__voice-grid">
          <label className="signal-preferences-preview__select">
            <span>Voice delivery mode</span>
            <select
              value={preferences.voiceMode}
              aria-label="Signal voice mode"
              onChange={(event) => update({ voiceMode: event.target.value as SignalVoiceMode }, "Voice delivery mode changed in the renderer preview.")}
            >
              <option value="off">Off</option>
              <option value="queue-preview">Queue a voice preview</option>
              <option value="browser-speech">Browser speech · planned</option>
            </select>
          </label>
          <label className="signal-preferences-preview__select">
            <span>Voice preset</span>
            <select
              value={preferences.voicePreset}
              aria-label="Signal voice preset"
              onChange={(event) => update({ voicePreset: event.target.value as SignalVoicePreset }, "Voice preset changed in the renderer preview.")}
            >
              <option value="browser-default">Browser default</option>
              <option value="calm">Calm narrator</option>
              <option value="bright">Bright explainer</option>
            </select>
          </label>
          <label className="signal-preferences-preview__select">
            <span>Speech rate</span>
            <select
              value={String(preferences.voiceRate)}
              aria-label="Signal voice rate"
              onChange={(event) => update({ voiceRate: Number(event.target.value) as SignalVoiceRate }, "Voice rate changed in the renderer preview.")}
            >
              <option value="0.8">0.8× slower</option>
              <option value="1">1× natural</option>
              <option value="1.2">1.2× faster</option>
            </select>
          </label>
          <label className="signal-preferences-preview__select">
            <span>Announce priority</span>
            <select
              value={preferences.voicePriority}
              aria-label="Signal voice priority"
              onChange={(event) => update({ voicePriority: event.target.value as SignalVoicePriority }, "Voice announcement priority changed in the renderer preview.")}
            >
              <option value="urgent">Urgent only</option>
              <option value="high-or-urgent">High and urgent</option>
              <option value="all">All visible signals</option>
            </select>
          </label>
        </div>
        <div className="signal-preferences-preview__voice-summary">
          <span>{preferences.voiceMode === "off" ? "Voice announcements are off." : preferences.voiceMode === "queue-preview" ? "Signals would be queued for a later voice preview." : "Browser speech is planned; this setting does not invoke it."}</span>
          <button type="button" className="button button--ghost" onClick={() => setStatus("Voice delivery settings rehearsed in the renderer session; no speech was started.")}>
            <Volume2 size={13} /> Rehearse settings
          </button>
        </div>
      </fieldset>

      <div className="signal-preferences-preview__toggles" role="group" aria-label="Signal display options">
        <label><input type="checkbox" checked={preferences.compactMode} onChange={(event) => update({ compactMode: event.target.checked }, "Compact signal mode changed in the renderer preview.")} /> Compact signal cards</label>
        <label><input type="checkbox" checked={preferences.includeDetails} onChange={(event) => update({ includeDetails: event.target.checked }, "Signal detail visibility changed in the renderer preview.")} /> Include detail text in exports</label>
      </div>

      <div className="signal-preferences-preview__toolbar" role="toolbar" aria-label="Signal preference history and export">
        <span className="signal-preferences-preview__status" role="status" aria-live="polite">{status}</span>
        <span className="signal-preferences-preview__history-count">{session.past.length + session.future.length} history steps</span>
        <button type="button" className="button button--ghost" onClick={undo} disabled={session.past.length === 0} aria-label="Undo signal preference change"><Undo2 size={13} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={session.future.length === 0} aria-label="Redo signal preference change"><Redo2 size={13} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset signal preferences"><RotateCcw size={13} /> Reset</button>
        <button type="button" className="button button--secondary" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="signal-preferences-export"><Download size={13} /> {exportOpen ? "Hide export" : "Preview export"}</button>
      </div>

      {exportOpen ? (
        <section id="signal-preferences-export" className="signal-preferences-preview__export" aria-label="Signal preferences export preview">
          <header><div><span className="eyebrow">Portable settings preview</span><h3>Signal preference package</h3></div><span className="signal-preferences-preview__export-chip"><LockKeyhole size={12} /> No durable write</span></header>
          <div className="signal-preferences-preview__export-toolbar"><label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value as SignalExportFormat)} aria-label="Signal preferences export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><span><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--ghost" onClick={() => setStatus(downloadPreferences(payload, format) ? "Downloaded the renderer-local signal preference preview." : "File download is unavailable in this surface.")}><Download size={13} /> Download</button><button type="button" className="button button--ghost" onClick={() => setImportOpen((value) => !value)} aria-expanded={importOpen}>{importOpen ? "Hide import" : "Import preview"}</button></span></div>
          {importOpen ? <div className="signal-preferences-preview__import"><label><span>Import format</span><select value={importFormat} onChange={(event) => setImportFormat(event.target.value as SignalExportFormat)} aria-label="Signal preferences import format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><textarea value={importPayload} onChange={(event) => setImportPayload(event.target.value)} rows={5} aria-label="Signal preferences import payload" placeholder="Paste a JSON or Markdown signal preference package here." /><button type="button" className="button button--secondary" onClick={importPreview}>Apply import preview</button></div> : null}
          <pre tabIndex={0}><code>{payload}</code></pre>
        </section>
      ) : null}

      <p className="signal-preferences-preview__boundary"><LockKeyhole size={14} /> This is a renderer-session preference rehearsal. It does not persist settings, acknowledge notifications, change scheduler behavior, or subscribe to native event streams.</p>
    </section>
  );
}

export default SignalPreferencesPreview;
