import {
  Check,
  Clipboard,
  Download,
  Eye,
  LockKeyhole,
  RotateCcw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { selectableModelProfiles } from "./provider-catalog";
import { ModelCompareReceiptInspector } from "./model-compare-receipt-inspector";
import type { ModelProfileView, ProviderView } from "./types";

export const PROVIDER_ROUTE_COMPARE_SCHEMA = "omnia.provider-route-comparison.preview.v1" as const;
export const MAX_PROVIDER_ROUTE_COMPARE_SELECTION = 4;

export type ProviderRouteCompareFormat = "json" | "markdown";
export type ProviderRouteCompareSort = "catalog" | "model-az" | "provider-az" | "latency-low";
export type ProviderRouteCompareFilters = {
  readonly query?: string;
  readonly provider?: string;
  readonly disposition?: ProviderRouteCompareRow["routeDisposition"] | "all";
  readonly sort?: ProviderRouteCompareSort;
};

export type ProviderRouteCompareRow = {
  readonly id: string;
  readonly modelLabel: string;
  readonly providerLabel: string;
  readonly providerKind: ProviderView["kind"] | "Unknown";
  readonly providerState: ProviderView["state"] | "unknown";
  readonly providerSource: ProviderView["source"] | "unknown";
  readonly providerEnabled: boolean;
  readonly modelId: string;
  readonly modelStatus: ModelProfileView["status"];
  readonly contextLabel: string;
  readonly speed: ModelProfileView["speed"];
  readonly latencyMs: number | null;
  readonly capabilities: readonly ModelProfileView["capabilities"][number][];
  readonly routeDisposition: "eligible-preview" | "review-required" | "blocked-preview";
  readonly dispositionReason: string;
};

type ProviderRouteCompareExport = {
  readonly schema: typeof PROVIDER_ROUTE_COMPARE_SCHEMA;
  readonly scope: "renderer-session";
  readonly executionDisposition: "preview-only";
  readonly selectedRouteIds: readonly string[];
  readonly fanoutPlan: {
    readonly state: "not-prepared" | "prepared-not-run";
    readonly routeCount: number;
    readonly attempts: readonly {
      readonly routeId: string;
      readonly outcome: "not-run";
    }[];
  };
  readonly routes: readonly ProviderRouteCompareRow[];
  readonly boundary: readonly string[];
};

const comparisonBoundary = [
  "Renderer-local route metadata comparison only",
  "No provider request, fan-out, retry, fallback, or credential lookup was performed",
  "Planned attempts remain not-run until a native dispatch contract exists",
  "No context freeze, durable route receipt, or native routing policy was created",
] as const;

const initialSelection = (rows: readonly ProviderRouteCompareRow[], activeModelProfileId: string): string[] => {
  const preferred = activeModelProfileId !== "auto" && rows.some((row) => row.id === activeModelProfileId)
    ? [activeModelProfileId]
    : [];
  return [...preferred, ...rows.map((row) => row.id).filter((id) => !preferred.includes(id))].slice(0, 2);
};

function routeDisposition(
  provider: ProviderView | undefined,
  model: ModelProfileView,
): Pick<ProviderRouteCompareRow, "routeDisposition" | "dispositionReason"> {
  if (!provider || !provider.enabled || provider.state === "error" || provider.state === "not-configured") {
    return {
      routeDisposition: "blocked-preview",
      dispositionReason: !provider
        ? "Provider metadata is unavailable in this catalog snapshot."
        : provider.state === "not-configured"
          ? "Provider configuration is not reported as ready."
          : provider.state === "error"
            ? "Provider reports an error state."
            : "Provider is disabled in the visible catalog.",
    };
  }
  if (model.status === "available" && provider.state === "connected") {
    return { routeDisposition: "eligible-preview", dispositionReason: "Catalog metadata is available for preview comparison." };
  }
  return {
    routeDisposition: "review-required",
    dispositionReason: model.status === "degraded" || provider.state === "degraded"
      ? "A degraded status needs native health evidence before dispatch."
      : "Availability is not confirmed by a native route receipt.",
  };
}

export function buildProviderRouteCompareRows(providers: readonly ProviderView[]): ProviderRouteCompareRow[] {
  return selectableModelProfiles([...providers])
    .filter((model) => model.id !== "auto")
    .map((model) => {
      const provider = providers.find((candidate) => candidate.id === model.connectionId);
      const disposition = routeDisposition(provider, model);
      return {
        id: model.id,
        modelLabel: model.displayName,
        providerLabel: model.providerName,
        providerKind: provider?.kind ?? "Unknown",
        providerState: provider?.state ?? "unknown",
        providerSource: provider?.source ?? "unknown",
        providerEnabled: provider?.enabled ?? false,
        modelId: model.providerModelId,
        modelStatus: model.status,
        contextLabel: model.contextLabel,
        speed: model.speed,
        latencyMs: provider?.latencyMs ?? null,
        capabilities: [...model.capabilities],
        ...disposition,
      } satisfies ProviderRouteCompareRow;
    });
}

function reportedLatency(row: ProviderRouteCompareRow): number {
  return row.latencyMs ?? Number.POSITIVE_INFINITY;
}

export function filterProviderRouteCompareRows(
  rows: readonly ProviderRouteCompareRow[],
  filters: ProviderRouteCompareFilters = {},
): ProviderRouteCompareRow[] {
  const normalizedQuery = filters.query?.trim().toLowerCase() ?? "";
  const filtered = rows.filter((row) => {
    const matchesQuery = !normalizedQuery || `${row.modelLabel} ${row.providerLabel} ${row.modelId} ${row.providerKind} ${row.capabilities.join(" ")}`.toLowerCase().includes(normalizedQuery);
    const matchesProvider = !filters.provider || row.providerLabel === filters.provider;
    const matchesDisposition = !filters.disposition || filters.disposition === "all" || row.routeDisposition === filters.disposition;
    return matchesQuery && matchesProvider && matchesDisposition;
  });
  const sort = filters.sort ?? "catalog";
  if (sort === "catalog") return filtered;
  return filtered.sort((left, right) => {
    if (sort === "model-az") return left.modelLabel.localeCompare(right.modelLabel) || left.id.localeCompare(right.id);
    if (sort === "provider-az") return left.providerLabel.localeCompare(right.providerLabel) || left.modelLabel.localeCompare(right.modelLabel);
    return reportedLatency(left) - reportedLatency(right) || left.modelLabel.localeCompare(right.modelLabel);
  });
}

export function serializeProviderRouteComparison(
  rows: readonly ProviderRouteCompareRow[],
  selectedRouteIds: readonly string[],
  prepared: boolean,
  format: ProviderRouteCompareFormat,
): string {
  const selected = rows.filter((row) => selectedRouteIds.includes(row.id));
  const payload: ProviderRouteCompareExport = {
    schema: PROVIDER_ROUTE_COMPARE_SCHEMA,
    scope: "renderer-session",
    executionDisposition: "preview-only",
    selectedRouteIds: selected.map((row) => row.id),
    fanoutPlan: {
      state: prepared ? "prepared-not-run" : "not-prepared",
      routeCount: selected.length,
      attempts: selected.map((row) => ({ routeId: row.id, outcome: "not-run" as const })),
    },
    routes: selected,
    boundary: comparisonBoundary,
  };

  if (format === "json") return JSON.stringify(payload, null, 2);

  const routeLines = selected.length
    ? selected.map((row) => `- ${row.modelLabel} · ${row.providerLabel} — ${row.routeDisposition}; ${row.contextLabel}; ${row.latencyMs === null ? "latency not reported" : `${row.latencyMs} ms`}`).join("\n")
    : "- No routes selected.";
  const attemptLines = selected.length
    ? selected.map((row) => `- ${row.modelLabel}: not run`).join("\n")
    : "- No planned attempts.";
  return [
    "# Omnia provider route comparison (preview)",
    "",
    `- Selected routes: ${selected.length}`,
    `- Fan-out plan: ${prepared ? "prepared · not run" : "not prepared"}`,
    "",
    "## Routes",
    routeLines,
    "",
    "## Planned attempts",
    attemptLines,
    "",
    "## Boundary",
    ...comparisonBoundary.map((entry) => `- ${entry}`),
  ].join("\n");
}

function downloadComparison(payload: string, format: ProviderRouteCompareFormat): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-provider-route-comparison.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function ProviderRouteComparePreview({
  providers,
  modelProfileId,
  onModelProfileChange,
}: {
  readonly providers: ProviderView[];
  readonly modelProfileId: string;
  readonly onModelProfileChange: (profileId: string) => void;
}) {
  const rows = useMemo(() => buildProviderRouteCompareRows(providers), [providers]);
  const [selectedRouteIds, setSelectedRouteIds] = useState<string[]>(() => initialSelection(rows, modelProfileId));
  const [query, setQuery] = useState("");
  const [preparedSelectionKey, setPreparedSelectionKey] = useState<string | null>(null);
  const [status, setStatus] = useState("Select two to four routes to compare metadata side by side.");
  const [format, setFormat] = useState<ProviderRouteCompareFormat>("json");
  const [exportStatus, setExportStatus] = useState("Export includes selected route metadata only.");
  const [providerFilter, setProviderFilter] = useState("");
  const [dispositionFilter, setDispositionFilter] = useState<NonNullable<ProviderRouteCompareFilters["disposition"]>>("all");
  const [sort, setSort] = useState<ProviderRouteCompareSort>("catalog");

  const selectedKey = selectedRouteIds.join("|");
  const prepared = preparedSelectionKey === selectedKey && selectedRouteIds.length >= 2;
  const providerOptions = useMemo(() => [...new Set(rows.map((row) => row.providerLabel))].sort((left, right) => left.localeCompare(right)), [rows]);
  const visibleRows = useMemo(
    () => filterProviderRouteCompareRows(rows, { query, provider: providerFilter, disposition: dispositionFilter, sort }),
    [dispositionFilter, providerFilter, query, rows, sort],
  );
  const selectedRows = useMemo(() => rows.filter((row) => selectedRouteIds.includes(row.id)), [rows, selectedRouteIds]);
  const payload = useMemo(
    () => serializeProviderRouteComparison(rows, selectedRouteIds, prepared, format),
    [format, prepared, rows, selectedRouteIds],
  );

  useEffect(() => {
    const validIds = new Set(rows.map((row) => row.id));
    setSelectedRouteIds((current) => {
      const next = current.filter((id) => validIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [rows]);

  const toggleSelection = (id: string) => {
    setSelectedRouteIds((current) => {
      if (current.includes(id)) {
        const next = current.filter((candidate) => candidate !== id);
        setPreparedSelectionKey(null);
        setStatus(next.length >= 2 ? "Comparison set changed; prepare the fan-out plan again." : "Select at least two routes before preparing a comparison.");
        return next;
      }
      if (current.length >= MAX_PROVIDER_ROUTE_COMPARE_SELECTION) {
        setStatus(`Choose up to ${MAX_PROVIDER_ROUTE_COMPARE_SELECTION} routes for one bounded comparison.`);
        return current;
      }
      const next = [...current, id];
      setPreparedSelectionKey(null);
      setStatus("Comparison set changed; prepare the fan-out plan again.");
      return next;
    });
  };

  const prepareFanout = () => {
    if (selectedRouteIds.length < 2) {
      setStatus("Select at least two routes before preparing a comparison.");
      return;
    }
    setPreparedSelectionKey(selectedKey);
    setStatus(`Prepared ${selectedRouteIds.length} renderer-only route attempts. No provider request was sent.`);
  };

  const selectVisible = () => {
    const currentIds = new Set(selectedRouteIds);
    const additions = visibleRows.map((row) => row.id).filter((id) => !currentIds.has(id));
    const capacity = MAX_PROVIDER_ROUTE_COMPARE_SELECTION - selectedRouteIds.length;
    const next = [...selectedRouteIds, ...additions.slice(0, capacity)];
    setSelectedRouteIds(next);
    setPreparedSelectionKey(null);
    setStatus(next.length === selectedRouteIds.length
      ? `All visible routes are selected or the ${MAX_PROVIDER_ROUTE_COMPARE_SELECTION}-route limit is full.`
      : `Added ${next.length - selectedRouteIds.length} visible route${next.length - selectedRouteIds.length === 1 ? "" : "s"}; prepare again to refresh the preview plan.`);
  };

  const reset = () => {
    const next = initialSelection(rows, modelProfileId);
    setSelectedRouteIds(next);
    setPreparedSelectionKey(null);
    setQuery("");
    setProviderFilter("");
    setDispositionFilter("all");
    setSort("catalog");
    setStatus("Route comparison reset to the visible catalog defaults.");
  };

  const copyPayload = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setExportStatus("Clipboard is unavailable; no comparison preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setExportStatus(`Copied ${format === "json" ? "JSON" : "Markdown"} route comparison. No durable write was made.`);
    } catch {
      setExportStatus("Clipboard access was denied; no comparison preview was copied.");
    }
  };

  return (
    <section className="provider-route-compare" aria-labelledby="provider-route-compare-title">
      <header className="provider-route-compare__header">
        <span className="provider-route-compare__icon" aria-hidden="true"><Eye size={16} /></span>
        <span><span className="eyebrow">Provider route evidence</span><h3 id="provider-route-compare-title">Compare provider routes</h3><p>Inspect bounded route metadata before a future native compare/fan-out operation.</p></span>
        <span className="provider-route-compare__badge"><ShieldCheck size={12} /> Preview only</span>
      </header>

      <div className="provider-route-compare__toolbar">
        <label className="provider-route-compare__search"><Search size={14} /><span className="sr-only">Search provider routes</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search model, provider, capability" aria-label="Search provider routes" />{query ? <button type="button" aria-label="Clear provider route search" onClick={() => setQuery("")}><X size={13} /></button> : null}</label>
        <span className="provider-route-compare__count" role="status" aria-label="Provider route visibility summary">{selectedRows.length} selected · {visibleRows.length} visible</span>
        <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset provider route comparison"><RotateCcw size={13} /> Reset</button>
      </div>

      <div className="provider-route-compare__filters" aria-label="Route comparison filters">
        <label><span>Provider</span><select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)} aria-label="Filter routes by provider"><option value="">All providers</option>{providerOptions.map((provider) => <option value={provider} key={provider}>{provider}</option>)}</select></label>
        <label><span>Readiness</span><select value={dispositionFilter} onChange={(event) => setDispositionFilter(event.target.value as NonNullable<ProviderRouteCompareFilters["disposition"]>)} aria-label="Filter routes by readiness"><option value="all">All states</option><option value="eligible-preview">Eligible preview</option><option value="review-required">Review required</option><option value="blocked-preview">Blocked preview</option></select></label>
        <label><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value as ProviderRouteCompareSort)} aria-label="Sort provider routes"><option value="catalog">Catalog order</option><option value="model-az">Model name A–Z</option><option value="provider-az">Provider A–Z</option><option value="latency-low">Reported latency · low first</option></select></label>
        <button type="button" className="button button--ghost" onClick={selectVisible} disabled={!visibleRows.length} aria-label="Select visible provider routes">Select visible</button>
      </div>

      <div className="provider-route-compare__selection" role="list" aria-label="Provider routes available for comparison">
        {visibleRows.map((row) => {
          const checked = selectedRouteIds.includes(row.id);
          const active = modelProfileId === row.id;
          return (
            <label
              key={row.id}
              role="listitem"
              className={checked ? "provider-route-compare__route provider-route-compare__route--selected" : "provider-route-compare__route"}
            >
              <input type="checkbox" checked={checked} onChange={() => toggleSelection(row.id)} aria-label={`Compare ${row.modelLabel} route`} />
              <span className="provider-route-compare__route-copy"><strong>{row.modelLabel}</strong><small>{row.providerLabel} · {row.modelId}</small></span>
              <span className={`provider-route-compare__state provider-route-compare__state--${row.routeDisposition}`}><span />{row.routeDisposition.replace("-", " ")}</span>
              {active ? <span className="provider-route-compare__active">Active</span> : null}
            </label>
          );
        })}
        {!visibleRows.length ? <div className="provider-route-compare__empty"><Search size={16} /><strong>No route matches</strong><span>Adjust the search to see another catalog route.</span></div> : null}
      </div>

      <div className="provider-route-compare__actions" role="toolbar" aria-label="Provider route comparison actions">
        <span><strong>{selectedRows.length} route{selectedRows.length === 1 ? "" : "s"} in comparison</strong><small>{status}</small></span>
        <button type="button" className="button button--secondary" onClick={prepareFanout} disabled={selectedRouteIds.length < 2}><Eye size={13} /> Prepare fan-out plan</button>
      </div>

      <div className="provider-route-compare__table-wrap">
        <table className="provider-route-compare__table"><caption>Selected provider route metadata</caption><thead><tr><th scope="col">Route</th><th scope="col">Provider</th><th scope="col">State</th><th scope="col">Context</th><th scope="col">Latency</th><th scope="col">Capabilities</th><th scope="col">Action</th></tr></thead><tbody>
          {selectedRows.map((row) => <tr key={row.id}><th scope="row"><strong>{row.modelLabel}</strong><small>{row.modelId}</small></th><td>{row.providerLabel}<small>{row.providerKind} · {row.providerSource}</small></td><td><span className={`provider-route-compare__state provider-route-compare__state--${row.routeDisposition}`}><span />{row.routeDisposition.replace("-", " ")}</span><small>{row.dispositionReason}</small></td><td>{row.contextLabel}<small>{row.speed} speed</small></td><td>{row.latencyMs === null ? "Not reported" : `${row.latencyMs} ms`}</td><td>{row.capabilities.length ? row.capabilities.join(" · ") : "None reported"}</td><td><button type="button" className="button button--ghost" onClick={() => onModelProfileChange(row.id)} disabled={modelProfileId === row.id} aria-label={`Use ${row.modelLabel} as active route`}><Check size={12} /> {modelProfileId === row.id ? "Active" : "Use route"}</button></td></tr>)}
          {!selectedRows.length ? <tr><td colSpan={7} className="provider-route-compare__table-empty">Select at least one route to inspect metadata.</td></tr> : null}
        </tbody></table>
      </div>

      <div className="provider-route-compare__fanout" aria-label="Provider route fan-out rehearsal">
        <div><span><strong>Fan-out rehearsal</strong><small>{prepared ? "Prepared renderer plan · attempts not run" : "Not prepared"}</small></span><span className={prepared ? "provider-route-compare__plan-status provider-route-compare__plan-status--prepared" : "provider-route-compare__plan-status"}>{prepared ? "Planned · not run" : "Review required"}</span></div>
        <ul>{selectedRows.map((row) => <li key={row.id}><span>{row.modelLabel}</span><small>{prepared ? "Not run · no provider request" : "Awaiting preparation"}</small></li>)}</ul>
      </div>

      <ModelCompareReceiptInspector />

      <div className="provider-route-compare__export">
        <div><span><strong>Portable comparison preview</strong><small>Copy or download selected metadata and the not-run plan; credentials and provider payloads are excluded.</small></span><label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value as ProviderRouteCompareFormat)} aria-label="Provider route comparison export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label></div>
        <div className="provider-route-compare__export-actions"><button type="button" className="button button--ghost" onClick={() => void copyPayload()}><Clipboard size={12} /> Copy</button><button type="button" className="button button--ghost" onClick={() => setExportStatus(downloadComparison(payload, format) ? "Downloaded the renderer-local route comparison." : "Browser download is unavailable; no comparison was downloaded.")}><Download size={12} /> Download</button><span role="status">{exportStatus}</span></div>
        <pre tabIndex={0} aria-label="Provider route comparison export preview">{payload}</pre>
      </div>

      <p className="provider-route-compare__boundary"><LockKeyhole size={13} /> Comparison and fan-out preparation are renderer-local. They do not call a provider, authorize a retry, freeze context, mutate a route, or create a durable receipt.</p>
    </section>
  );
}
