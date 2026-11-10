import {
  AudioLines,
  BrainCircuit,
  Braces,
  Check,
  CircleAlert,
  CircleHelp,
  Code2,
  Cpu,
  Database,
  Eye,
  Image,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
  Video,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { ModelProfileView, ProviderView } from "./types";

export type CapabilityMatrixStatus =
  | "supported"
  | "partial"
  | "not-reported"
  | "unavailable"
  | "planned";

export type CapabilityMatrixView = "providers" | "models";
export type CapabilityMatrixScope = "all" | "connected" | "local";
export type CapabilityMatrixStatusFilter = "all" | CapabilityMatrixStatus;

type CapabilityId =
  | "text"
  | "vision"
  | "tools"
  | "json"
  | "reasoning"
  | "audio"
  | "image-generation"
  | "video-generation"
  | "embeddings"
  | "computer-use";

type CapabilityDefinition = {
  readonly id: CapabilityId;
  readonly label: string;
  readonly detail: string;
  readonly icon: LucideIcon;
  readonly catalogReported: boolean;
};

const capabilityDefinitions: readonly CapabilityDefinition[] = [
  { id: "text", label: "Text streaming", detail: "Normalized text generation and streaming", icon: Code2, catalogReported: true },
  { id: "vision", label: "Vision input", detail: "Image-aware input for multimodal prompts", icon: Eye, catalogReported: true },
  { id: "tools", label: "Tool calls", detail: "Function/tool invocation metadata", icon: Wrench, catalogReported: true },
  { id: "json", label: "Structured output", detail: "JSON or JSON-schema constrained output", icon: Braces, catalogReported: true },
  { id: "reasoning", label: "Reasoning", detail: "Provider-reported deliberate reasoning mode", icon: BrainCircuit, catalogReported: true },
  { id: "audio", label: "Audio I/O", detail: "Audio input or output capability metadata", icon: AudioLines, catalogReported: true },
  { id: "image-generation", label: "Image generation", detail: "Image generation endpoint and artifact handoff", icon: Image, catalogReported: false },
  { id: "video-generation", label: "Video generation", detail: "Video generation endpoint and media handoff", icon: Video, catalogReported: false },
  { id: "embeddings", label: "Embeddings", detail: "Embedding/vector endpoint for retrieval", icon: Database, catalogReported: false },
  { id: "computer-use", label: "Computer use", detail: "Interactive desktop control capability", icon: TerminalSquare, catalogReported: false },
];

const statusLabels: Record<CapabilityMatrixStatus, string> = {
  supported: "Supported",
  partial: "Partial",
  "not-reported": "Not reported",
  unavailable: "Unavailable",
  planned: "Planned",
};

const statusDescriptions: Record<CapabilityMatrixStatus, string> = {
  supported: "At least one eligible model reports this capability.",
  partial: "Some eligible models report it, or the connection is degraded.",
  "not-reported": "The current catalog does not report enough metadata to decide.",
  unavailable: "The connection is disabled, not configured, or in an error state.",
  planned: "The capability column is reserved for a future native/provider contract.",
};

type MatrixColumn = {
  readonly id: string;
  readonly label: string;
  readonly subtitle: string;
  readonly provider: ProviderView;
  readonly model?: ModelProfileView;
};

function providerIsVisible(provider: ProviderView, scope: CapabilityMatrixScope): boolean {
  if (scope === "connected") return provider.state === "connected" && provider.enabled;
  if (scope === "local") return provider.kind === "Local";
  return true;
}

function modelSupports(model: ModelProfileView, capability: CapabilityId): boolean {
  if (capability === "text") return true;
  return model.capabilities.includes(capability as (typeof model.capabilities)[number]);
}

function providerStatus(provider: ProviderView, capability: CapabilityDefinition): CapabilityMatrixStatus {
  if (!capability.catalogReported) return "planned";
  if (!provider.enabled || provider.state === "error" || provider.state === "not-configured") return "unavailable";
  if (provider.models.length === 0 || provider.state === "validating") return "not-reported";
  const supportedModels = provider.models.filter((model) => modelSupports(model, capability.id));
  if (supportedModels.length === provider.models.length && provider.state === "connected") return "supported";
  if (supportedModels.length > 0 || provider.state === "degraded") return "partial";
  return "not-reported";
}

function modelStatus(model: ModelProfileView, capability: CapabilityDefinition): CapabilityMatrixStatus {
  if (!capability.catalogReported) return "planned";
  if (model.status === "unavailable") return "unavailable";
  if (!modelSupports(model, capability.id)) return "not-reported";
  return model.status === "degraded" ? "partial" : "supported";
}

function summarizeStatus(columns: MatrixColumn[], capabilities: CapabilityDefinition[], status: CapabilityMatrixStatus): number {
  return capabilities.reduce(
    (count, capability) =>
      count +
      columns.filter((column) =>
        column.model ? modelStatus(column.model, capability) === status : providerStatus(column.provider, capability) === status,
      ).length,
    0,
  );
}

function StatusMark({ status }: { readonly status: CapabilityMatrixStatus }) {
  if (status === "supported") return <span className="capability-matrix__mark capability-matrix__mark--supported"><Check size={13} /></span>;
  if (status === "partial") return <span className="capability-matrix__mark capability-matrix__mark--partial"><span aria-hidden="true">~</span></span>;
  if (status === "planned") return <span className="capability-matrix__mark capability-matrix__mark--planned"><Sparkles size={12} /></span>;
  if (status === "unavailable") return <span className="capability-matrix__mark capability-matrix__mark--unavailable"><span aria-hidden="true">×</span></span>;
  return <span className="capability-matrix__mark capability-matrix__mark--unknown"><CircleHelp size={12} /></span>;
}

export function capabilityMatrixStatus(
  provider: ProviderView,
  capabilityId: CapabilityId,
  view: CapabilityMatrixView = "providers",
): CapabilityMatrixStatus {
  const definition = capabilityDefinitions.find((item) => item.id === capabilityId);
  if (!definition) return "not-reported";
  if (view === "models") {
    const model = provider.models[0];
    return model ? modelStatus(model, definition) : providerStatus(provider, definition);
  }
  return providerStatus(provider, definition);
}

export function CapabilityMatrixWorkbench({
  providers,
  modelProfileId,
  onModelProfileChange,
}: {
  readonly providers: ProviderView[];
  readonly modelProfileId?: string;
  readonly onModelProfileChange?: (profileId: string) => void;
}) {
  const [view, setView] = useState<CapabilityMatrixView>("providers");
  const [scope, setScope] = useState<CapabilityMatrixScope>("all");
  const [query, setQuery] = useState("");
  const [capabilityQuery, setCapabilityQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<CapabilityMatrixStatusFilter>("all");
  const [showPlanned, setShowPlanned] = useState(false);

  const catalogCapabilities = useMemo(
    () => capabilityDefinitions.filter((capability) => showPlanned || capability.catalogReported),
    [showPlanned],
  );
  const visibleProviders = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return providers.filter((provider) => {
      if (!providerIsVisible(provider, scope)) return false;
      if (!normalized) return true;
      return `${provider.name} ${provider.kind} ${provider.endpoint} ${provider.models.map((model) => `${model.displayName} ${model.providerModelId}`).join(" ")}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [providers, query, scope]);
  const columns = useMemo<MatrixColumn[]>(() => {
    if (view === "providers") {
      return visibleProviders.map((provider) => ({
        id: provider.id,
        label: provider.name,
        subtitle: `${provider.kind} · ${provider.models.length} models`,
        provider,
      }));
    }
    return visibleProviders.flatMap((provider) =>
      provider.models
        .filter((model) => {
          const normalized = query.trim().toLowerCase();
          if (!normalized) return true;
          return `${model.displayName} ${model.providerModelId} ${provider.name}`.toLowerCase().includes(normalized);
        })
        .map((model) => ({
          id: model.id,
          label: model.displayName,
          subtitle: `${provider.name} · ${model.contextLabel}`,
          provider,
          model,
        })),
    );
  }, [query, view, visibleProviders]);
  const visibleCapabilities = useMemo(() => {
    const normalized = capabilityQuery.trim().toLowerCase();
    return catalogCapabilities.filter((capability) => {
      const matchesQuery = !normalized || `${capability.label} ${capability.detail}`.toLowerCase().includes(normalized);
      if (!matchesQuery || statusFilter === "all") return matchesQuery;
      return columns.some((column) => {
        const status = column.model ? modelStatus(column.model, capability) : providerStatus(column.provider, capability);
        return status === statusFilter;
      });
    });
  }, [capabilityQuery, catalogCapabilities, columns, statusFilter]);
  const supportedCount = summarizeStatus(columns, visibleCapabilities, "supported");
  const partialCount = summarizeStatus(columns, visibleCapabilities, "partial");
  const unknownCount = summarizeStatus(columns, visibleCapabilities, "not-reported");
  const filtersAreDefault =
    view === "providers" &&
    scope === "all" &&
    query.length === 0 &&
    capabilityQuery.length === 0 &&
    statusFilter === "all" &&
    !showPlanned;

  function resetFilters(): void {
    setView("providers");
    setScope("all");
    setQuery("");
    setCapabilityQuery("");
    setStatusFilter("all");
    setShowPlanned(false);
  }

  return (
    <section className="capability-matrix-workbench" aria-labelledby="capability-matrix-title">
      <header className="capability-matrix-workbench__header">
        <span className="capability-matrix-workbench__icon"><Cpu size={18} /></span>
        <span>
          <span className="eyebrow">Renderer preview</span>
          <h2 id="capability-matrix-title">Capability matrix</h2>
          <p>Compare what each connection or model reports before choosing a route. Missing metadata is kept visible instead of being treated as unsupported.</p>
        </span>
        <span className="capability-matrix-workbench__status"><CircleAlert size={13} /> Preview only</span>
      </header>

      <div className="capability-matrix__controls" role="group" aria-label="Capability matrix filters">
        <label className="capability-matrix__search">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter providers or models" aria-label="Filter providers or models" />
        </label>
        <label className="capability-matrix__search">
          <Search size={14} />
          <input value={capabilityQuery} onChange={(event) => setCapabilityQuery(event.target.value)} placeholder="Filter capabilities" aria-label="Filter capabilities" />
        </label>
        <label>
          <span>Compare</span>
          <select value={view} onChange={(event) => setView(event.target.value as CapabilityMatrixView)} aria-label="Capability matrix comparison mode">
            <option value="providers">Providers</option>
            <option value="models">Models</option>
          </select>
        </label>
        <label>
          <span>Scope</span>
          <select value={scope} onChange={(event) => setScope(event.target.value as CapabilityMatrixScope)} aria-label="Capability matrix scope">
            <option value="all">All connections</option>
            <option value="connected">Connected only</option>
            <option value="local">Local only</option>
          </select>
        </label>
        <label>
          <span>Rows with</span>
          <select
            value={statusFilter}
            onChange={(event) => {
              const nextFilter = event.target.value as CapabilityMatrixStatusFilter;
              setStatusFilter(nextFilter);
              if (nextFilter === "planned") setShowPlanned(true);
            }}
            aria-label="Capability matrix status filter"
          >
            <option value="all">Any status</option>
            <option value="supported">Supported</option>
            <option value="partial">Partial</option>
            <option value="not-reported">Metadata gap</option>
            <option value="unavailable">Unavailable</option>
            <option value="planned">Planned</option>
          </select>
        </label>
        <label className="capability-matrix__toggle">
          <input type="checkbox" checked={showPlanned} onChange={(event) => setShowPlanned(event.target.checked)} />
          <span>Show planned columns</span>
        </label>
        <button type="button" className="button button--ghost capability-matrix__reset" onClick={resetFilters} disabled={filtersAreDefault}>
          Reset filters
        </button>
      </div>

      <div className="capability-matrix__summary" aria-live="polite">
        <span><strong>{columns.length}</strong> {view === "providers" ? "connections" : "models"}</span>
        <span aria-label={`${visibleCapabilities.length} of ${catalogCapabilities.length} capabilities`}><strong>{visibleCapabilities.length}</strong> of {catalogCapabilities.length} capabilities</span>
        <span className="capability-matrix__summary-item capability-matrix__summary-item--supported"><Check size={12} /> {supportedCount} supported</span>
        <span className="capability-matrix__summary-item capability-matrix__summary-item--partial"><span aria-hidden="true">~</span> {partialCount} partial</span>
        <span className="capability-matrix__summary-item capability-matrix__summary-item--unknown"><CircleHelp size={12} /> {unknownCount} metadata gaps</span>
      </div>

      {columns.length > 0 && visibleCapabilities.length > 0 ? (
        <div className="capability-matrix__scroll" role="region" aria-label="Capability comparison grid" tabIndex={0}>
          <div
            className="capability-matrix__grid"
            role="grid"
            aria-rowcount={visibleCapabilities.length + 1}
            aria-colcount={columns.length + 1}
            style={{ gridTemplateColumns: `minmax(158px, 1.2fr) repeat(${columns.length}, minmax(134px, 1fr))` }}
          >
            <div className="capability-matrix__corner" role="columnheader"><SlidersHorizontal size={13} /> Capability</div>
            {columns.map((column) => {
              const selected = column.model?.id === modelProfileId;
              return (
                <div className="capability-matrix__column" role="columnheader" key={column.id}>
                  {column.model && onModelProfileChange ? (
                    <button type="button" className={selected ? "capability-matrix__column-button capability-matrix__column-button--selected" : "capability-matrix__column-button"} onClick={() => onModelProfileChange(column.model!.id)} aria-pressed={selected}>
                      <strong>{column.label}</strong>
                      <small>{column.subtitle}</small>
                    </button>
                  ) : (
                    <span><strong>{column.label}</strong><small>{column.subtitle}</small></span>
                  )}
                </div>
              );
            })}
            {visibleCapabilities.map((capability) => {
              const Icon = capability.icon;
              return (
                <div className="capability-matrix__row" role="row" key={capability.id}>
                  <div className="capability-matrix__label" role="rowheader">
                    <span className="capability-matrix__label-icon"><Icon size={14} /></span>
                    <span><strong>{capability.label}</strong><small>{capability.detail}</small></span>
                  </div>
                  {columns.map((column) => {
                    const status = column.model ? modelStatus(column.model, capability) : providerStatus(column.provider, capability);
                    return (
                      <div className="capability-matrix__cell" role="gridcell" key={`${capability.id}-${column.id}`} title={`${column.label}: ${statusLabels[status]}. ${statusDescriptions[status]}`}>
                        <StatusMark status={status} />
                        <span>{statusLabels[status]}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="capability-matrix__empty">
          <ShieldCheck size={18} />
          <span>
            <strong>{columns.length === 0 ? "No matching connections" : "No matching capabilities"}</strong>
            <small>{columns.length === 0 ? "Adjust the scope or connection filter to inspect provider capability metadata." : "Adjust the capability search or status filter to reveal additional rows."}</small>
          </span>
        </div>
      )}

      <div className="capability-matrix__legend" aria-label="Capability status legend">
        {(Object.keys(statusLabels) as CapabilityMatrixStatus[]).map((status) => <span key={status}><StatusMark status={status} /> {statusLabels[status]}</span>)}
      </div>
      <p className="capability-matrix__boundary"><ShieldCheck size={14} /> This matrix is a renderer projection of the current catalog. It does not grant permissions, enable a provider, or claim that planned endpoints are implemented.</p>
    </section>
  );
}

export { capabilityDefinitions };
