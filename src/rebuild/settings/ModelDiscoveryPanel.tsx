import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { RefreshCw, Search, Square } from "lucide-react";
import { ModelDiscoveryController, nativeModelDiscoveryService, type ModelDiscoveryService } from "./model-discovery";
import { CatalogRouteAdapter, createCatalogSnapshot, type CatalogRouteState, type CatalogSnapshot } from "./catalog-route-adapter";

export interface ModelDiscoveryPanelProps {
  currentModel: string;
  currentProfileId: string;
  onChooseModel: (selection: { profileId: string; modelId: string }) => void;
  service?: ModelDiscoveryService;
}

const capability = (value: boolean | null): string => value === null ? "unknown" : value ? "yes" : "no";

export function ModelDiscoveryPanel({ currentModel, currentProfileId, onChooseModel, service }: ModelDiscoveryPanelProps) {
  const [controller] = useState(() => new ModelDiscoveryController(service ?? nativeModelDiscoveryService(), currentProfileId));
  const [routeAdapter] = useState(() => new CatalogRouteAdapter());
  const [catalogSnapshot, setCatalogSnapshot] = useState<CatalogSnapshot | null>(null);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [query, setQuery] = useState("");
  useEffect(() => { void controller.refreshProfiles(); return controller.cancel; }, [controller]);
  useEffect(() => {
    let cancelled = false;
    if (!state.catalog) {
      setCatalogSnapshot(null);
      return () => { cancelled = true; };
    }
    void createCatalogSnapshot(state.catalog, routeAdapter.getSnapshot()?.snapshotId).then((snapshot) => {
      if (cancelled) return;
      routeAdapter.setSnapshot(snapshot);
      setCatalogSnapshot(snapshot);
    }).catch(() => {
      if (!cancelled) setCatalogSnapshot(null);
    });
    return () => { cancelled = true; };
  }, [routeAdapter, state.catalog]);
  const loading = state.phase === "loading-profiles" || state.phase === "loading-models";
  const available = state.phase !== "unavailable";
  const profile = state.profiles.find((entry) => entry.id === state.selectedProfileId);
  const models = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return state.catalog?.models.filter((entry) => !search || `${entry.id} ${entry.displayName}`.toLocaleLowerCase().includes(search)) ?? [];
  }, [query, state.catalog]);
  const visibleModels = models.slice(0, 100);
  const selectedModel = state.catalog?.profileId === currentProfileId ? state.catalog.models.find((entry) => entry.id === currentModel) : undefined;
  const selectedResolution = state.catalog && catalogSnapshot && currentProfileId && currentModel
    ? routeAdapter.resolve({ providerProfileId: currentProfileId, modelId: currentModel })
    : null;
  const selectedVisible = visibleModels.some((entry) => entry.id === currentModel) && Boolean(selectedModel) && selectedResolution?.state !== "unsupported" && selectedResolution?.state !== "disappeared";
  const selectedUnavailable = Boolean(currentProfileId && currentModel && currentModel !== "auto" && (!selectedModel || !selectedResolution || selectedResolution.state === "unknown" || selectedResolution.state === "disappeared" || selectedResolution.state === "unsupported"));
  const routeForModel = (modelId: string) => catalogSnapshot ? routeAdapter.resolve({ providerProfileId: state.catalog?.profileId ?? "", modelId }) : null;
  const routeLabel = (stateValue: CatalogRouteState | "unknown" | undefined): string => stateValue === "unsupported" ? " · unsupported" : stateValue === "disappeared" ? " · disappeared" : stateValue === "stale" ? " · stale" : "";
  const inspectedModel = selectedModel ?? (state.catalog?.models.length === 1 ? state.catalog.models[0] : undefined);
  const sources = [...new Set(state.catalog?.models.map((entry) => entry.capabilities.source) ?? [])];
  return <section className="settings-section settings-discovery" aria-labelledby="settings-discovery-heading">
    <div className="settings-discovery-heading"><h3 id="settings-discovery-heading">Provider model discovery</h3><button type="button" className="settings-button" disabled={!available || state.phase === "loading-profiles"} onClick={() => void controller.refreshProfiles()}><RefreshCw size={13} aria-hidden="true" /> Refresh providers</button></div>
    <p className="settings-help">Use an existing native provider profile. Credentials stay with native services. Catalog requests run only when you choose Discover models.</p>
    <div className="settings-grid">
      <label className="settings-field"><span>Discovery provider</span><select className="settings-select" aria-label="Discovery provider" disabled={!available || state.phase === "loading-profiles"} value={state.selectedProfileId} onChange={(event) => { setQuery(""); controller.selectProfile(event.target.value); }}><option value="">Choose a saved provider</option>{state.profiles.map((entry) => <option key={entry.id} value={entry.id} disabled={!entry.enabled}>{entry.displayName} · {entry.providerType}{entry.enabled ? "" : " · disabled"}</option>)}</select>{profile ? <small className="settings-help">Native credential status: {profile.credentialStatus}. Native permissions determine whether discovery is allowed.</small> : null}</label>
      <div className="settings-discovery-actions"><button type="button" className="settings-button settings-button--primary" disabled={!available || !state.selectedProfileId || loading} onClick={() => void controller.refreshModels()}><RefreshCw size={13} aria-hidden="true" /> Discover models</button>{loading ? <button type="button" className="settings-button" aria-label="Stop waiting for discovery" onClick={controller.cancel}><Square size={12} aria-hidden="true" /> Stop waiting</button> : null}</div>
    </div>
    <div className="settings-discovery-status" role={state.error ? "alert" : "status"} aria-live="polite">
      {!available ? "Native model discovery is unavailable in browser preview. No provider catalog is fabricated." : state.error ?? (state.phase === "loading-profiles" ? "Reading native provider profiles…" : state.phase === "loading-models" ? "Discovering models through the native provider gateway…" : state.phase === "cancelled" ? (state.catalog ? "Stopped waiting. Showing the last successful catalog; a native request may still finish and will be ignored." : "Stopped waiting. A native request may still finish; its result will be ignored.") : state.catalogStatus === "refresh-failed" && state.catalog ? "Discovery failed. Showing the last successful catalog until a refresh succeeds." : !state.profiles.length ? "No native provider profiles are configured. Create a profile in native provider configuration before discovery." : !state.catalog ? "Choose a provider, then discover its current model catalog." : `${state.catalog.models.length} models received from the native gateway.`)}
    </div>
    {selectedUnavailable ? <p className="settings-discovery-status" role="alert">Selected model <strong>{currentModel}</strong> is unavailable for this provider snapshot{selectedResolution?.reason ? `: ${selectedResolution.reason}` : ". Refresh the catalog or choose an available model."}</p> : null}
    {state.catalog ? <>
      <div className="settings-grid"><label className="settings-field"><span><Search size={12} aria-hidden="true" /> Filter discovered models</span><input className="settings-control" aria-label="Filter discovered models" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Model name or ID" /></label><label className="settings-field"><span>Discovered model</span><select className="settings-select" aria-label="Discovered model" disabled={!visibleModels.length} value={selectedVisible ? currentModel : ""} onChange={(event) => { const modelId = event.target.value; if (!state.catalog || !modelId) return; const profileId = state.catalog.profileId; const resolution = catalogSnapshot ? routeAdapter.resolve({ providerProfileId: profileId, modelId }) : null; if (!resolution || resolution.state === "available" || resolution.state === "stale") onChooseModel({ profileId, modelId }); }}><option value="">Choose to apply as default</option>{visibleModels.map((entry) => { const resolution = routeForModel(entry.id); const unsupported = resolution?.state === "unsupported" || resolution?.state === "disappeared"; return <option key={entry.id} value={entry.id} disabled={unsupported}>{entry.displayName} · {entry.id}{routeLabel(resolution?.state)}</option>; })}</select></label></div>
      <p className="settings-help">Showing {visibleModels.length} of {models.length} matching models. Filter to narrow large catalogs. Choosing a model updates the requested default immediately; active runs keep their current route.</p>
      <div className="settings-discovery-provenance"><span>Native discovery timestamp</span><time dateTime={state.catalog.discoveredAt}>{new Date(state.catalog.discoveredAt).toLocaleString()}</time><span>Catalog snapshot: {catalogSnapshot?.snapshotId ?? "lineage pending"} ({catalogSnapshot?.snapshotAuthority ?? "renderer"})</span><span>Capability source: {sources.join(", ") || "not supplied"}</span></div>
      {inspectedModel ? <p className="settings-help">Streaming {capability(inspectedModel.capabilities.streaming)} · Tools {capability(inspectedModel.capabilities.tools)} · Vision {capability(inspectedModel.capabilities.vision)} · Reasoning {capability(inspectedModel.capabilities.reasoning)}</p> : null}
      <p className="settings-help">Effort values are not supplied by this catalog contract. Native capability negotiation and dispatch validation remain authoritative.</p>
    </> : null}
  </section>;
}
