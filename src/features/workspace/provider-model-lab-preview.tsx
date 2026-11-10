import {
  BarChart3,
  Check,
  Clipboard,
  Download,
  Eye,
  FileJson2,
  LockKeyhole,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  Redo2,
  Wrench,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { ModelProfileView, ProviderView } from "./types";

type LabTab = "portfolio" | "profile" | "compare";
type SpeedBand = ModelProfileView["speed"];
type ModelLabSort = "catalog" | "model-az" | "provider-az" | "context-high" | "latency-low" | "cost-low";
type ModelLabStatusFilter = ModelProfileView["status"] | "all";
type ModelLabSpeedFilter = SpeedBand | "all";
type CostTier = "Low" | "Medium" | "High" | "Unknown";
type EvidenceState = "Native profile metadata" | "Seeded catalog" | "Manual draft";

type ModelLabDraft = {
  id: string;
  connectionId: string | null;
  displayName: string;
  providerName: string;
  providerModelId: string;
  status: ModelProfileView["status"];
  contextLabel: string;
  capabilities: ModelProfileView["capabilities"];
  speed: SpeedBand;
  favorite: boolean;
  fallbackEnabled: boolean;
  costTier: CostTier;
  latencyMs: number | null;
  evidence: EvidenceState;
  temperature: number;
  maxOutputTokens: number;
  notes: string;
};

type LabHistory = {
  past: ModelLabDraft[][];
  present: ModelLabDraft[];
  future: ModelLabDraft[][];
};

const LAB_FORMAT = "omnia.provider-model-lab.preview.v1";

const cloneDrafts = (drafts: ModelLabDraft[]): ModelLabDraft[] => drafts.map((draft) => ({
  ...draft,
  capabilities: [...draft.capabilities],
}));

function costTierForModel(model: ModelProfileView): CostTier {
  if (model.speed === "Fast") return "Low";
  if (model.speed === "Thorough") return "High";
  return "Medium";
}

function draftsFromProviders(providers: ProviderView[]): ModelLabDraft[] {
  return providers.flatMap((provider) => provider.models.map((model) => ({
    id: model.id,
    connectionId: model.connectionId,
    displayName: model.displayName,
    providerName: model.providerName,
    providerModelId: model.providerModelId,
    status: model.status,
    contextLabel: model.contextLabel,
    capabilities: [...model.capabilities],
    speed: model.speed,
    favorite: model.favorite,
    fallbackEnabled: model.status === "available",
    costTier: costTierForModel(model),
    latencyMs: provider.latencyMs,
    evidence: provider.source === "native" ? "Native profile metadata" : "Seeded catalog",
    temperature: model.capabilities.includes("reasoning") ? 0.4 : 0.7,
    maxOutputTokens: model.capabilities.includes("reasoning") ? 8192 : 4096,
    notes: "Inherited from the visible model catalog. Adjustments stay in this preview session.",
  })));
}

function fallbackDraft(): ModelLabDraft {
  return {
    id: "model-lab-empty",
    connectionId: null,
    displayName: "No model selected",
    providerName: "Connect a provider to populate the lab",
    providerModelId: "—",
    status: "unknown",
    contextLabel: "Not reported",
    capabilities: [],
    speed: "Balanced",
    favorite: false,
    fallbackEnabled: false,
    costTier: "Unknown",
    latencyMs: null,
    evidence: "Manual draft",
    temperature: 0.7,
    maxOutputTokens: 4096,
    notes: "This placeholder is renderer-local and is not sent anywhere.",
  };
}

function exportJson(drafts: ModelLabDraft[], compareIds: string[]): string {
  return JSON.stringify({
    format: LAB_FORMAT,
    generatedAt: new Date().toISOString(),
    boundary: "Renderer-local preview. No provider request, secret, native receipt, or durable write.",
    compareIds,
    models: drafts,
  }, null, 2);
}

function exportMarkdown(drafts: ModelLabDraft[], compareIds: string[]): string {
  const rows = drafts.map((draft) => `| ${draft.displayName} | ${draft.providerName} | ${draft.contextLabel} | ${draft.capabilities.join(", ")} | ${draft.fallbackEnabled ? "yes" : "no"} |`).join("\n");
  return [
    "# Omnia model portfolio lab (preview)",
    "",
    "> Renderer-local · no provider request · no durable write · no credentials",
    "",
    `Compared models: ${compareIds.length || "none"}`,
    "",
    "| Model | Provider | Context | Capabilities | Fallback |",
    "| --- | --- | --- | --- | --- |",
    rows || "| No models | — | — | — | — |",
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

async function copyText(value: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
  await navigator.clipboard.writeText(value);
  return true;
}

function capabilityTone(capability: string): string {
  return `provider-model-lab__capability provider-model-lab__capability--${capability.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

function contextTokens(label: string): number | null {
  const match = /([\d,.]+)\s*([kKmM])?/.exec(label);
  if (!match || /not reported/i.test(label)) return null;
  const amountText = match[1];
  if (!amountText) return null;
  const amount = Number(amountText.replaceAll(",", ""));
  if (!Number.isFinite(amount)) return null;
  const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
  return amount * multiplier;
}

function compareNullableNumber(left: number | null, right: number | null, direction: "asc" | "desc"): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction === "asc" ? left - right : right - left;
}

export function ProviderModelLabPreview({ providers }: { readonly providers: ProviderView[] }) {
  const initialDrafts = useMemo(() => draftsFromProviders(providers), [providers]);
  const [history, setHistory] = useState<LabHistory>(() => ({ past: [], present: initialDrafts, future: [] }));
  const [selectedId, setSelectedId] = useState(initialDrafts[0]?.id ?? "model-lab-empty");
  const [compareIds, setCompareIds] = useState<string[]>(initialDrafts.slice(0, 2).map((draft) => draft.id));
  const [activeTab, setActiveTab] = useState<LabTab>("portfolio");
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [capabilityFilter, setCapabilityFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<ModelLabStatusFilter>("all");
  const [speedFilter, setSpeedFilter] = useState<ModelLabSpeedFilter>("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [sort, setSort] = useState<ModelLabSort>("catalog");
  const [status, setStatus] = useState("Model metadata is a renderer-local draft; no provider request was sent.");
  const drafts = history.present;
  const selected = drafts.find((draft) => draft.id === selectedId) ?? drafts[0] ?? fallbackDraft();
  const providerNames = useMemo(() => [...new Set(drafts.map((draft) => draft.providerName))].sort(), [drafts]);
  const capabilities = useMemo(() => [...new Set(drafts.flatMap((draft) => draft.capabilities))].sort(), [drafts]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const result = drafts.filter((draft) => {
      const matchesQuery = !normalized || `${draft.displayName} ${draft.providerName} ${draft.providerModelId} ${draft.contextLabel}`.toLowerCase().includes(normalized);
      const matchesProvider = providerFilter === "all" || draft.providerName === providerFilter;
      const matchesCapability = capabilityFilter === "all" || draft.capabilities.includes(capabilityFilter as ModelProfileView["capabilities"][number]);
      const matchesStatus = statusFilter === "all" || draft.status === statusFilter;
      const matchesSpeed = speedFilter === "all" || draft.speed === speedFilter;
      const matchesFavorite = !favoritesOnly || draft.favorite;
      return matchesQuery && matchesProvider && matchesCapability && matchesStatus && matchesSpeed && matchesFavorite;
    });
    if (sort === "catalog") return result;
    return result.sort((left, right) => {
      if (sort === "model-az") return left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id);
      if (sort === "provider-az") return left.providerName.localeCompare(right.providerName) || left.displayName.localeCompare(right.displayName);
      if (sort === "context-high") return compareNullableNumber(contextTokens(left.contextLabel), contextTokens(right.contextLabel), "desc") || left.displayName.localeCompare(right.displayName);
      if (sort === "latency-low") return compareNullableNumber(left.latencyMs, right.latencyMs, "asc") || left.displayName.localeCompare(right.displayName);
      const costRank: Record<CostTier, number> = { Low: 0, Medium: 1, High: 2, Unknown: 3 };
      return costRank[left.costTier] - costRank[right.costTier] || left.displayName.localeCompare(right.displayName);
    });
  }, [capabilityFilter, drafts, favoritesOnly, providerFilter, query, sort, speedFilter, statusFilter]);
  const activeFilterCount = [
    query.trim() ? "query" : "",
    providerFilter !== "all" ? "provider" : "",
    capabilityFilter !== "all" ? "capability" : "",
    statusFilter !== "all" ? "status" : "",
    speedFilter !== "all" ? "speed" : "",
    favoritesOnly ? "favorites" : "",
  ].filter(Boolean).length;
  const compareDrafts = compareIds.map((id) => drafts.find((draft) => draft.id === id)).filter((draft): draft is ModelLabDraft => Boolean(draft));
  const payload = activeTab === "compare" ? exportMarkdown(drafts, compareIds) : exportJson(drafts, compareIds);

  const commit = (nextDrafts: ModelLabDraft[], message: string) => {
    setHistory((current) => ({ past: [...current.past, cloneDrafts(current.present)], present: cloneDrafts(nextDrafts), future: [] }));
    setStatus(message);
  };

  const updateSelected = (patch: Partial<ModelLabDraft>, message = "Model draft updated in the renderer preview.") => {
    const next = drafts.map((draft) => draft.id === selected.id ? { ...draft, ...patch } : draft);
    commit(next, message);
  };

  const toggleCompare = (id: string) => {
    setCompareIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    setStatus("Comparison set changed in the renderer preview.");
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return { past: current.past.slice(0, -1), present: cloneDrafts(previous), future: [cloneDrafts(current.present), ...current.future] };
    });
    setStatus("Undid the last model-lab change.");
  };

  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return { past: [...current.past, cloneDrafts(current.present)], present: cloneDrafts(next), future: current.future.slice(1) };
    });
    setStatus("Reapplied the next model-lab change.");
  };

  const reset = () => {
    const next = draftsFromProviders(providers);
    commit(next, "Model-lab drafts reset to visible provider metadata.");
    setCompareIds(next.slice(0, 2).map((draft) => draft.id));
    setSelectedId(next[0]?.id ?? "model-lab-empty");
  };

  const resetFilters = () => {
    setQuery("");
    setProviderFilter("all");
    setCapabilityFilter("all");
    setStatusFilter("all");
    setSpeedFilter("all");
    setFavoritesOnly(false);
    setSort("catalog");
  };

  return (
    <section className="provider-model-lab" aria-labelledby="provider-model-lab-title">
      <header className="provider-model-lab__header">
        <span className="provider-model-lab__icon" aria-hidden="true"><SlidersHorizontal size={17} /></span>
        <span><span className="eyebrow">Model portfolio</span><h2 id="provider-model-lab-title">Model Lab</h2><p>Shape model profiles, fallback intent, and request defaults before native routing is connected.</p></span>
        <span className="provider-model-lab__badge"><Sparkles size={12} /> Preview only</span>
      </header>

      <div className="provider-model-lab__metrics" aria-label="Model lab summary">
        <span><strong>{drafts.length}</strong><small>catalog models</small></span>
        <span><strong>{drafts.filter((draft) => draft.fallbackEnabled).length}</strong><small>fallback-ready</small></span>
        <span><strong>{drafts.filter((draft) => draft.capabilities.includes("tools")).length}</strong><small>tool-capable</small></span>
        <span><strong>{compareIds.length}</strong><small>in compare set</small></span>
      </div>

      <div className="provider-model-lab__history" role="toolbar" aria-label="Model lab history">
        <span><strong>Reversible profile draft</strong><small>{status}</small></span>
        <span className="provider-model-lab__history-count">{history.past.length + history.future.length} steps</span>
        <span className="provider-model-lab__history-actions">
          <button type="button" className="button button--ghost" onClick={undo} disabled={!history.past.length} aria-label="Undo model lab change"><Undo2 size={12} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={!history.future.length} aria-label="Redo model lab change"><Redo2 size={12} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset model lab"><RotateCcw size={12} /> Reset</button>
        </span>
      </div>

      <nav className="provider-model-lab__tabs" role="tablist" aria-label="Model lab views">
        {(["portfolio", "profile", "compare"] as const).map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? "is-active" : ""} onClick={() => setActiveTab(tab)}>
            {tab === "portfolio" ? <BarChart3 size={14} /> : tab === "profile" ? <SlidersHorizontal size={14} /> : <Eye size={14} />}
            {tab === "portfolio" ? "Portfolio" : tab === "profile" ? "Profile editor" : "Compare"}
          </button>
        ))}
      </nav>

      {activeTab === "portfolio" ? (
        <div className="provider-model-lab__portfolio">
          <div className="provider-model-lab__filters" role="search">
            <label className="provider-model-lab__search"><Search size={14} /><span className="sr-only">Search models</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search model, provider, context" aria-label="Search models" />{query ? <button type="button" aria-label="Clear model search" onClick={() => setQuery("")}><X size={13} /></button> : null}</label>
            <label><span>Provider</span><select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)} aria-label="Filter models by provider"><option value="all">All providers</option>{providerNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
            <label><span>Capability</span><select value={capabilityFilter} onChange={(event) => setCapabilityFilter(event.target.value)} aria-label="Filter models by capability"><option value="all">All capabilities</option>{capabilities.map((capability) => <option key={capability} value={capability}>{capability}</option>)}</select></label>
            <label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ModelLabStatusFilter)} aria-label="Filter models by status"><option value="all">All statuses</option><option value="available">Available</option><option value="degraded">Degraded</option><option value="unavailable">Unavailable</option><option value="unknown">Unknown</option></select></label>
            <label><span>Speed</span><select value={speedFilter} onChange={(event) => setSpeedFilter(event.target.value as ModelLabSpeedFilter)} aria-label="Filter models by speed"><option value="all">Any speed</option><option value="Fast">Fast</option><option value="Balanced">Balanced</option><option value="Thorough">Thorough</option></select></label>
            <label><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value as ModelLabSort)} aria-label="Sort models"><option value="catalog">Catalog order</option><option value="model-az">Model name A–Z</option><option value="provider-az">Provider A–Z</option><option value="context-high">Context · largest first</option><option value="latency-low">Reported latency · low first</option><option value="cost-low">Cost heuristic · low first</option></select></label>
            <label className="provider-model-lab__favorite-filter"><input type="checkbox" checked={favoritesOnly} onChange={(event) => setFavoritesOnly(event.target.checked)} aria-label="Show favorites only" /><span>Favorites only</span></label>
            <span className="provider-model-lab__count" role="status">{filtered.length} of {drafts.length} models · {activeFilterCount} filters</span>
            {activeFilterCount ? <button type="button" className="button button--ghost" onClick={resetFilters} aria-label="Clear model catalog filters"><RotateCcw size={13} /> Clear filters</button> : null}
          </div>
          <div className="provider-model-lab__body">
            <div className="provider-model-lab__list" role="list" aria-label="Model portfolio">
              {filtered.map((draft) => {
                const selectedCard = selected.id === draft.id;
                const comparing = compareIds.includes(draft.id);
                return <article key={draft.id} className={selectedCard ? "provider-model-card is-selected" : "provider-model-card"} role="listitem">
                  <button type="button" className="provider-model-card__main" onClick={() => { setSelectedId(draft.id); setActiveTab("profile"); }} aria-label={`Edit ${draft.displayName}`}>
                    <span className={`provider-model-card__status provider-model-card__status--${draft.status}`}><span />{draft.status}</span>
                    <span className="provider-model-card__copy"><strong>{draft.displayName}</strong><small>{draft.providerName} · {draft.contextLabel}</small></span>
                    <span className="provider-model-card__meta"><b>{draft.capabilities.length}</b><small>caps</small></span>
                  </button>
                  <div className="provider-model-card__footer"><span>{draft.evidence}</span><button type="button" className={comparing ? "provider-model-card__compare is-active" : "provider-model-card__compare"} onClick={() => toggleCompare(draft.id)} aria-pressed={comparing}>{comparing ? <Check size={12} /> : null} Compare</button></div>
                </article>;
              })}
              {!filtered.length ? <div className="provider-model-lab__empty"><Search size={17} /><strong>No model matches</strong><span>Adjust the query or filters.</span>{activeFilterCount ? <button type="button" className="button button--ghost" onClick={resetFilters}>Clear catalog filters</button> : null}</div> : null}
            </div>
            <aside className="provider-model-lab__summary" aria-label="Selected model summary">
              <span className="eyebrow">Selected profile</span><h3>{selected.displayName}</h3><p>{selected.providerName} · {selected.providerModelId}</p>
              <div className="provider-model-lab__signal-grid"><span><strong>{selected.contextLabel}</strong><small>context</small></span><span><strong>{selected.speed}</strong><small>speed band</small></span><span><strong>{selected.latencyMs === null ? "—" : `${selected.latencyMs} ms`}</strong><small>catalog latency</small></span><span><strong>{selected.costTier}</strong><small>cost heuristic</small></span></div>
              <div className="provider-model-lab__capabilities">{selected.capabilities.map((capability) => <span key={capability} className={capabilityTone(capability)}>{capability}</span>)}</div>
              <button type="button" className="button button--secondary" onClick={() => setActiveTab("profile")}><SlidersHorizontal size={13} /> Open profile editor</button>
            </aside>
          </div>
        </div>
      ) : null}

      {activeTab === "profile" ? (
        <div className="provider-model-lab__editor">
          <header><div><span className="eyebrow">Editable renderer draft</span><h3>{selected.displayName}</h3><p>Changes affect this model-lab session only; provider catalog metadata remains unchanged.</p></div><span className="provider-model-lab__evidence"><ShieldCheck size={13} /> {selected.evidence}</span></header>
          <div className="provider-model-lab__editor-grid">
            <label><span>Display name</span><input value={selected.displayName} onChange={(event) => updateSelected({ displayName: event.target.value })} aria-label="Model display name" /></label>
            <label><span>Provider model ID</span><input value={selected.providerModelId} onChange={(event) => updateSelected({ providerModelId: event.target.value })} aria-label="Provider model ID" /></label>
            <label><span>Speed band</span><select value={selected.speed} onChange={(event) => updateSelected({ speed: event.target.value as SpeedBand })} aria-label="Model speed band"><option>Fast</option><option>Balanced</option><option>Thorough</option></select></label>
            <label><span>Cost heuristic</span><select value={selected.costTier} onChange={(event) => updateSelected({ costTier: event.target.value as CostTier })} aria-label="Model cost heuristic"><option>Low</option><option>Medium</option><option>High</option><option>Unknown</option></select></label>
            <label><span>Temperature default <output>{selected.temperature.toFixed(1)}</output></span><input type="range" min="0" max="2" step="0.1" value={selected.temperature} onChange={(event) => updateSelected({ temperature: Number(event.target.value) })} aria-label="Model temperature default" /></label>
            <label><span>Max output tokens</span><input type="number" min="256" max="200000" step="256" value={selected.maxOutputTokens} onChange={(event) => updateSelected({ maxOutputTokens: Math.max(256, Number(event.target.value) || 256) })} aria-label="Model max output tokens" /></label>
            <label className="provider-model-lab__toggle"><input type="checkbox" checked={selected.favorite} onChange={(event) => updateSelected({ favorite: event.target.checked })} /><span><strong>Favorite in picker</strong><small>Renderer preference only</small></span></label>
            <label className="provider-model-lab__toggle"><input type="checkbox" checked={selected.fallbackEnabled} onChange={(event) => updateSelected({ fallbackEnabled: event.target.checked })} /><span><strong>Allow as fallback</strong><small>Does not authorize a native retry</small></span></label>
            <fieldset className="provider-model-lab__capability-editor provider-model-lab__field-wide"><legend>Capability profile</legend>{(["vision", "tools", "json", "reasoning", "audio"] as const).map((capability) => <label key={capability}><input type="checkbox" checked={selected.capabilities.includes(capability)} onChange={(event) => updateSelected({ capabilities: event.target.checked ? [...selected.capabilities, capability] : selected.capabilities.filter((item) => item !== capability) }, `${capability} capability ${event.target.checked ? "added to" : "removed from"} the renderer profile draft.`)} /><span>{capability}</span></label>)}</fieldset>
            <label className="provider-model-lab__field-wide"><span>Profile notes</span><textarea rows={4} value={selected.notes} onChange={(event) => updateSelected({ notes: event.target.value })} aria-label="Model profile notes" /></label>
          </div>
          <div className="provider-model-lab__editor-actions"><button type="button" className="button button--secondary" onClick={() => updateSelected({ fallbackEnabled: !selected.fallbackEnabled }, `${selected.fallbackEnabled ? "Disabled" : "Enabled"} fallback intent in the renderer preview.`)}><Wrench size={13} /> Toggle fallback intent</button><button type="button" className="button button--ghost" onClick={() => setActiveTab("compare")}><Eye size={13} /> Compare this model</button></div>
        </div>
      ) : null}

      {activeTab === "compare" ? (
        <div className="provider-model-lab__compare">
          <header><div><span className="eyebrow">Decision table</span><h3>Compare selected models</h3><p>Use the table to inspect trade-offs before choosing a route.</p></div><span>{compareDrafts.length} selected</span></header>
          {compareDrafts.length ? <div className="provider-model-lab__compare-table" role="table" aria-label="Model comparison"><div className="provider-model-lab__compare-row provider-model-lab__compare-row--head" role="row"><span role="columnheader">Model</span><span role="columnheader">Context</span><span role="columnheader">Capabilities</span><span role="columnheader">Defaults</span><span role="columnheader">Fallback</span><span role="columnheader" aria-label="Remove" /></div>{compareDrafts.map((draft) => <div className="provider-model-lab__compare-row" role="row" key={draft.id}><span><strong>{draft.displayName}</strong><small>{draft.providerName}</small></span><span>{draft.contextLabel}</span><span>{draft.capabilities.join(" · ")}</span><span>{draft.temperature.toFixed(1)} temp · {draft.maxOutputTokens.toLocaleString()} max</span><span>{draft.fallbackEnabled ? <Check size={13} /> : <X size={13} />}</span><button type="button" className="icon-button icon-button--small" onClick={() => toggleCompare(draft.id)} aria-label={`Remove ${draft.displayName} from compare`}><X size={13} /></button></div>)}</div> : <div className="provider-model-lab__empty"><Eye size={17} /><strong>No models in compare</strong><span>Choose Compare from the portfolio list.</span></div>}
          <div className="provider-model-lab__export"><div><span className="eyebrow">Portable preview</span><h3>Export the model plan</h3><p>Secrets, prompts, provider payloads, and native receipts are excluded.</p></div><div className="provider-model-lab__export-actions"><button type="button" className="button button--ghost" onClick={() => void copyText(exportJson(drafts, compareIds))}><FileJson2 size={13} /> Copy JSON</button><button type="button" className="button button--ghost" onClick={() => void copyText(exportMarkdown(drafts, compareIds))}><Clipboard size={13} /> Copy Markdown</button><button type="button" className="button button--ghost" onClick={() => downloadText("omnia-model-lab.preview.json", exportJson(drafts, compareIds), "application/json")}><Download size={13} /> Download</button></div><pre aria-label="Model lab export preview">{payload}</pre></div>
        </div>
      ) : null}

      <p className="provider-model-lab__boundary"><LockKeyhole size={13} /> Renderer-local preview · no provider request · no credential lookup · no native route decision · no durable write. Catalog and latency values are illustrative unless a native receipt labels them observed.</p>
    </section>
  );
}
