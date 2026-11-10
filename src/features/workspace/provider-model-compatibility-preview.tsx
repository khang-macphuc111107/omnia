import {
  CheckCircle2,
  Clipboard,
  Download,
  FileJson2,
  Info,
  LockKeyhole,
  RotateCcw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Undo2,
  Redo2,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { ProviderView } from "./types";
import {
  buildCompatibilityRows,
  compatibilityRules,
  compatibilityStatusLabel,
  exportCompatibilityJson,
  type CompatibilityCapability,
  type CompatibilityMode,
  type CompatibilityStatus,
  type ModelCompatibilityRow,
} from "./provider-model-compatibility";

type History = { past: CompatibilityMode[]; present: CompatibilityMode; future: CompatibilityMode[] };

function statusIcon(status: CompatibilityStatus) {
  if (status === "compatible") return <CheckCircle2 size={13} />;
  if (status === "blocked") return <XCircle size={13} />;
  return <ShieldAlert size={13} />;
}

function statusTone(status: CompatibilityStatus): string {
  return `provider-model-compatibility__status provider-model-compatibility__status--${status}`;
}

function exportMarkdown(rows: readonly ModelCompatibilityRow[], mode: CompatibilityMode): string {
  const lines = rows.map((row) => {
    const states = compatibilityRules.map((rule) => `${rule.label}: ${compatibilityStatusLabel(row.statuses[rule.id])}`).join(" · ");
    return `| ${row.model.displayName} | ${row.providerName} | ${states} |`;
  });
  return [
    "# Omnia provider/model compatibility preview",
    "",
    `> Mode: ${mode} · Preview only · Renderer-local · No provider request · No durable write`,
    "",
    "| Model | Provider | Capability assessment |",
    "| --- | --- | --- |",
    ...(lines.length ? lines : ["| No models | — | — |"]),
  ].join("\n");
}

function downloadText(filename: string, content: string, mime: string): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined") return false;
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}

async function copyText(content: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
  await navigator.clipboard.writeText(content);
  return true;
}

export function ProviderModelCompatibilityPreview({ providers }: { readonly providers: ProviderView[] }) {
  const [history, setHistory] = useState<History>({ past: [], present: "strict", future: [] });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | CompatibilityStatus>("all");
  const [capabilityFilter, setCapabilityFilter] = useState<CompatibilityCapability | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState("Compatibility is inferred from visible catalog metadata.");
  const mode = history.present;
  const rows = useMemo(() => buildCompatibilityRows(providers, mode), [mode, providers]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesQuery = !normalized || `${row.model.displayName} ${row.model.providerName} ${row.model.providerModelId}`.toLowerCase().includes(normalized);
      const matchesCapability = capabilityFilter === "all" || row.model.capabilities.includes(capabilityFilter);
      const statuses = Object.values(row.statuses);
      const matchesStatus = statusFilter === "all" || statuses.includes(statusFilter);
      return matchesQuery && matchesCapability && matchesStatus;
    });
  }, [capabilityFilter, query, rows, statusFilter]);
  const selected = visible.find((row) => row.id === selectedId) ?? rows.find((row) => row.id === selectedId) ?? visible[0] ?? rows[0] ?? null;
  const compatibleCount = rows.reduce((total, row) => total + row.compatibleCount, 0);
  const blockedCount = rows.reduce((total, row) => total + row.blockedCount, 0);
  const reviewCount = rows.reduce((total, row) => total + row.reviewCount, 0);
  const json = exportCompatibilityJson(rows, mode);
  const markdown = exportMarkdown(rows, mode);

  const setMode = (next: CompatibilityMode) => {
    if (next === mode) return;
    setHistory((current) => ({ past: [...current.past, current.present], present: next, future: [] }));
    setExportStatus(`Compatibility mode changed to ${next}; no native policy changed.`);
  };
  const undo = () => setHistory((current) => {
    const previous = current.past.at(-1);
    if (!previous) return current;
    setExportStatus("Undid the last compatibility mode change.");
    return { past: current.past.slice(0, -1), present: previous, future: [current.present, ...current.future] };
  });
  const redo = () => setHistory((current) => {
    const next = current.future[0];
    if (!next) return current;
    setExportStatus("Reapplied the next compatibility mode change.");
    return { past: [...current.past, current.present], present: next, future: current.future.slice(1) };
  });
  const reset = () => {
    setHistory((current) => ({ past: [...current.past, current.present], present: "strict", future: [] }));
    setExportStatus("Compatibility mode reset to strict preview defaults.");
  };

  return (
    <section className="provider-model-compatibility" aria-labelledby="provider-model-compatibility-title">
      <header className="provider-model-compatibility__header">
        <span className="provider-model-compatibility__icon" aria-hidden="true"><SlidersHorizontal size={17} /></span>
        <span><span className="eyebrow">Provider/model contract</span><h2 id="provider-model-compatibility-title">Compatibility Matrix</h2><p>See which visible model declarations can satisfy common request intents before a native adapter receipt exists.</p></span>
        <span className="provider-model-compatibility__badge">Preview only</span>
      </header>

      <div className="provider-model-compatibility__metrics" aria-label="Compatibility summary">
        <span><strong>{rows.length}</strong><small>catalog models</small></span>
        <span><strong>{compatibleCount}</strong><small>compatible signals</small></span>
        <span><strong>{reviewCount}</strong><small>review signals</small></span>
        <span><strong>{blockedCount}</strong><small>blocked by catalog</small></span>
      </div>

      <div className="provider-model-compatibility__history" role="toolbar" aria-label="Compatibility preview history">
        <span><strong>Reversible gate rehearsal</strong><small>{exportStatus}</small></span>
        <span className="provider-model-compatibility__history-count">{history.past.length + history.future.length} steps</span>
        <span className="provider-model-compatibility__history-actions">
          <button type="button" className="button button--ghost" onClick={undo} disabled={!history.past.length} aria-label="Undo compatibility mode change"><Undo2 size={12} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={!history.future.length} aria-label="Redo compatibility mode change"><Redo2 size={12} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset compatibility preview"><RotateCcw size={12} /> Reset</button>
        </span>
      </div>

      <div className="provider-model-compatibility__controls">
        <label><span>Assessment mode</span><select value={mode} onChange={(event) => setMode(event.target.value as CompatibilityMode)} aria-label="Compatibility assessment mode"><option value="strict">Strict · missing declaration blocks</option><option value="advisory">Advisory · missing declaration needs review</option></select></label>
        <label className="provider-model-compatibility__search"><Search size={14} /><span className="sr-only">Search compatibility matrix</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search model or provider" aria-label="Search compatibility matrix" /></label>
        <label><span>Capability</span><select value={capabilityFilter} onChange={(event) => setCapabilityFilter(event.target.value as CompatibilityCapability | "all")} aria-label="Filter compatibility by capability"><option value="all">All capabilities</option>{compatibilityRules.map((rule) => <option key={rule.id} value={rule.id}>{rule.label}</option>)}</select></label>
        <label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | CompatibilityStatus)} aria-label="Filter compatibility by status"><option value="all">All statuses</option><option value="compatible">Compatible</option><option value="review">Review evidence</option><option value="blocked">Blocked by catalog</option></select></label>
      </div>

      <div className="provider-model-compatibility__body">
        <div className="provider-model-compatibility__table-wrap">
          <div className="provider-model-compatibility__table" role="table" aria-label="Provider model compatibility matrix">
            <div className="provider-model-compatibility__row provider-model-compatibility__row--head" role="row"><span role="columnheader">Model</span>{compatibilityRules.map((rule) => <span role="columnheader" key={rule.id}>{rule.label}</span>)}</div>
            {visible.map((row) => <button type="button" className={selected?.id === row.id ? "provider-model-compatibility__row is-selected" : "provider-model-compatibility__row"} role="row" key={row.id} onClick={() => setSelectedId(row.id)} aria-label={`Inspect compatibility for ${row.model.displayName}`}>
              <span><strong>{row.model.displayName}</strong><small>{row.providerName} · {row.model.contextLabel}</small></span>
              {compatibilityRules.map((rule) => <span key={rule.id} className={statusTone(row.statuses[rule.id])}>{statusIcon(row.statuses[rule.id])}<small>{compatibilityStatusLabel(row.statuses[rule.id])}</small></span>)}
            </button>)}
            {!visible.length ? <div className="provider-model-compatibility__empty"><Search size={16} /><strong>No compatibility rows match</strong><span>Adjust the model, capability, or status filter.</span></div> : null}
          </div>
        </div>
        {selected ? <aside className="provider-model-compatibility__detail" aria-label="Selected model compatibility details">
          <span className="eyebrow">Selected model</span><h3>{selected.model.displayName}</h3><p>{selected.providerName} · {selected.model.providerModelId}</p>
          <div className="provider-model-compatibility__score"><strong>{selected.compatibleCount}/{compatibilityRules.length}</strong><span>compatible signals</span></div>
          <div className="provider-model-compatibility__detail-list">{compatibilityRules.map((rule) => <article key={rule.id}><span className={statusTone(selected.statuses[rule.id])}>{statusIcon(selected.statuses[rule.id])}{compatibilityStatusLabel(selected.statuses[rule.id])}</span><div><strong>{rule.label}</strong><small>{rule.detail}</small></div></article>)}</div>
          <p className="provider-model-compatibility__evidence"><Info size={14} /> Source: {selected.providerSource} provider catalog · provider state: {selected.providerState}. A compatible signal is not a live endpoint acceptance receipt.</p>
        </aside> : <div className="provider-model-compatibility__empty provider-model-compatibility__empty--detail"><Info size={17} /><strong>No model selected</strong><span>Connect or expose a catalog model to inspect its compatibility signals.</span></div>}
      </div>

      <section className="provider-model-compatibility__export" aria-label="Compatibility export">
        <header><div><span className="eyebrow">Portable review</span><h3>Export compatibility assessment</h3><p>Use this matrix for design review; credentials, prompts, payloads, and native receipts are excluded.</p></div><div className="provider-model-compatibility__export-actions"><button type="button" className="button button--ghost" onClick={() => void copyText(json)}><FileJson2 size={13} /> Copy JSON</button><button type="button" className="button button--ghost" onClick={() => void copyText(markdown)}><Clipboard size={13} /> Copy Markdown</button><button type="button" className="button button--ghost" onClick={() => downloadText("omnia-provider-model-compatibility.preview.json", json, "application/json")}><Download size={13} /> Download</button></div></header>
        <pre aria-label="Compatibility export preview">{json}</pre>
      </section>

      <p className="provider-model-compatibility__boundary"><LockKeyhole size={13} /> Renderer-local preview · no provider request · no endpoint probe · no credential lookup · no native route decision · no durable write. Missing capabilities are catalog assessments, not security or availability guarantees.</p>
    </section>
  );
}
