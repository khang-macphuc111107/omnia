import {
  Activity,
  AlertTriangle,
  Check,
  KeyRound,
  Plus,
  RefreshCw,
  Route,
  Search,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";

import { LazyLoadBoundary } from "@/components/lazy-load-boundary";
import { desktop, isDesktopRuntime, type AppRuntimeInfo } from "@/lib/desktop";

import { openWorkspaceOverlay } from "./overlay-store";
import {
  formatProviderCheckTime,
  modelProfileFromProviderModel,
  providerFromNativeProfile,
  providerModelRecordFromNativeModel,
  providerStateLabel,
} from "./provider-catalog";
import { ModelCatalogOnboarding } from "./model-catalog-onboarding";
import { ProviderModalityOnboarding } from "./provider-modality-onboarding";
import { useWorkspaceStore } from "./store";
import type { ProviderView } from "./types";

type ProviderSurfaceModule = typeof import("./settings-provider-surface");

type ProviderRouteTone = "ready" | "review" | "blocked" | "pending";

function routeToneForProvider(provider: ProviderView): ProviderRouteTone {
  if (provider.state === "validating") return "pending";
  if (provider.state === "error" || provider.state === "degraded" || provider.state === "not-configured") {
    return "blocked";
  }
  if (provider.state === "connected") return "ready";
  return "review";
}

function routeSummaryForProvider(provider: ProviderView): { label: string; detail: string } {
  if (provider.state === "validating") {
    return {
      label: "Checking route",
      detail: "A provider health and model discovery check is already in progress.",
    };
  }
  if (provider.state === "connected") {
    return {
      label: "Ready for chat",
      detail: "A native health receipt and model catalog are available for this session.",
    };
  }
  if (provider.state === "configuration-validated") {
    return {
      label: "Configuration validated",
      detail: "The profile shape passed local validation; run Test & discover before treating it as a live route.",
    };
  }
  if (provider.state === "not-configured") {
    return {
      label: "Credential review required",
      detail: "The provider profile is enabled, but its native credential boundary is missing or locked.",
    };
  }
  return {
    label: "Route needs attention",
    detail: "The provider is not currently eligible for chat; inspect the error and validate again after repair.",
  };
}

const loadProviderSurface = () => import("./settings-provider-surface");

function SurfaceLoading({ label }: { label: string }) {
  return (
    <div className="settings-surface-loading" role="status" aria-live="polite">
      <span className="settings-surface-loading__dot" aria-hidden="true" />
      <span>Loading {label} preview…</span>
    </div>
  );
}

type ProviderSurfaceProps = {
  providers: ProviderView[];
  modelProfileId: string;
  onModelProfileChange: (id: string) => void;
};

/**
 * Resolve the optional provider workbenches after the Settings surface has
 * committed. A render-time React.lazy resource could remain suspended when a
 * user changed Settings categories quickly; the effect loader keeps the
 * loading/retry path deterministic in the browser preview and embedded
 * WebViews.
 */
function ProviderSurfaceLoader({
  props,
}: {
  props: ProviderSurfaceProps;
}) {
  const [surface, setSurface] = useState<ComponentType<ProviderSurfaceProps> | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    setSurface(null);
    setLoadError(null);

    void (loadProviderSurface() as Promise<ProviderSurfaceModule>)
      .then((module) => {
        if (active) setSurface(() => module.default);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error : new Error("Provider workbenches could not be loaded."));
      });

    return () => {
      active = false;
    };
  }, []);

  if (loadError) throw loadError;
  if (!surface) return <SurfaceLoading label="Provider workbenches" />;

  const Surface = surface;
  return <Surface {...props} />;
}

function ProviderWorkbenchSurface({
  providers,
  modelProfileId,
  onModelProfileChange,
}: {
  providers: ProviderView[];
  modelProfileId: string;
  onModelProfileChange: (id: string) => void;
}) {
  const [retryKey, setRetryKey] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <LazyLoadBoundary
      label="Provider workbenches"
      resetKey={`provider-workbenches:${retryKey}`}
      onDismiss={() => setDismissed(true)}
      onRetry={() => setRetryKey((value) => value + 1)}
    >
      <ProviderSurfaceLoader
        key={`provider-workbenches:${retryKey}`}
        props={{
          providers,
          modelProfileId,
          onModelProfileChange,
        }}
      />
    </LazyLoadBoundary>
  );
}

export default function SettingsProviderPanel({ runtime }: { runtime: AppRuntimeInfo }) {
  const providers = useWorkspaceStore((state) => state.providers);
  const modelProfileId = useWorkspaceStore((state) => state.modelProfileId);
  const setModelProfile = useWorkspaceStore((state) => state.setModelProfile);
  const replaceProviders = useWorkspaceStore((state) => state.replaceProviders);
  const updateProvider = useWorkspaceStore((state) => state.updateProvider);
  const removeProvider = useWorkspaceStore((state) => state.removeProvider);
  const [providerQuery, setProviderQuery] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    providers[0]?.id ?? null,
  );
  const [syncingProviders, setSyncingProviders] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerStatus, setProviderStatus] = useState<string | null>(null);
  const routeModelSelectRef = useRef<HTMLSelectElement | null>(null);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const filteredProviders = useMemo(() => {
    const normalized = providerQuery.trim().toLowerCase();
    if (!normalized) return providers;
    return providers.filter((provider) =>
      `${provider.name} ${provider.kind} ${provider.endpoint} ${provider.models
        .map((model) => model.displayName)
        .join(" ")}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [providerQuery, providers]);
  const connectedProviders = providers.filter(
    (provider) => provider.source === "native" && provider.state === "connected",
  ).length;
  const availableModels = providers.reduce((total, provider) => total + provider.models.length, 0);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    setSyncingProviders(true);
    void desktop
      .listProviderProfiles()
      .then((records) => {
        if (disposed || records.length === 0) return;
        const existing = new Map(providers.map((provider) => [provider.id, provider]));
        const nativeProviders = records.map((record) => {
          const cached = existing.get(record.id);
          return cached
            ? { ...providerFromNativeProfile(record), ...cached, source: "native" as const }
            : providerFromNativeProfile(record);
        });
        replaceProviders(nativeProviders);
        setSelectedProviderId((current) =>
          current && nativeProviders.some((provider) => provider.id === current)
            ? current
            : nativeProviders[0]?.id ?? null,
        );
      })
      .catch((cause: unknown) => {
        if (!disposed) {
          setProviderError(
            cause instanceof Error ? cause.message : "Provider profiles could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!disposed) setSyncingProviders(false);
      });
    return () => {
      disposed = true;
    };
    // Native metadata is loaded once per settings mount; local store changes remain renderer-driven afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaceProviders]);

  const testProvider = async (provider: ProviderView) => {
    updateProvider(provider.id, { state: "validating", errorMessage: null });
    setProviderError(null);
    setProviderStatus(
      provider.source === "native" && isDesktopRuntime()
        ? "Live provider check in progress."
        : "Configuration preflight in progress. No live provider request is sent.",
    );
    try {
      const result =
        provider.source === "native" && isDesktopRuntime()
          ? await (async () => {
              const [health, catalog] = await Promise.all([
                desktop.testProviderConnection(provider.id),
                desktop.listProviderModels(provider.id),
              ]);
              return {
                healthy: health.healthy,
                normalizedBaseUrl: provider.endpoint,
                latencyMs: health.latencyMs,
                models: catalog.models.map(providerModelRecordFromNativeModel),
              };
            })()
          : await desktop.preflightProviderConnection({
              providerType: provider.providerType,
              displayName: provider.name,
              baseUrl: provider.endpoint,
              authScheme: provider.authScheme,
              ...(provider.organizationId ? { organizationId: provider.organizationId } : {}),
              ...(provider.remoteProjectId ? { remoteProjectId: provider.remoteProjectId } : {}),
              allowLocalNetwork: provider.kind === "Local",
              ...(provider.credentialState === "present" ? { credentialRef: provider.id } : {}),
            });
      updateProvider(provider.id, {
        state: result.healthy
          ? provider.source === "native" && isDesktopRuntime()
            ? "connected"
            : "configuration-validated"
          : "degraded",
        endpoint: result.normalizedBaseUrl,
        lastCheckedAt: new Date().toISOString(),
        latencyMs: result.latencyMs,
        modelCount: result.models.length,
        models: result.models.map((model) => modelProfileFromProviderModel(provider, model)),
        errorMessage:
          "warning" in result && typeof result.warning === "string" ? result.warning : null,
      });
      setProviderStatus(
        provider.source === "native" && isDesktopRuntime()
          ? "Provider connection and model discovery completed."
          : "Configuration validated in browser preview. No live provider request was sent.",
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Connection test failed.";
      updateProvider(provider.id, {
        state: "error",
        errorMessage: message,
        lastCheckedAt: new Date().toISOString(),
      });
      setProviderError(message);
      setProviderStatus(`Provider validation failed: ${message}`);
    }
  };

  const deleteProvider = async (provider: ProviderView) => {
    if (
      !window.confirm(
        `Remove ${provider.name}? This removes the connection metadata and its stored credential, but never deletes provider-side data.`,
      )
    ) {
      return;
    }
    try {
      if (provider.source === "native" && isDesktopRuntime()) {
        await desktop.deleteProviderProfile(provider.id);
      }
      removeProvider(provider.id);
      setSelectedProviderId((current) => (current === provider.id ? null : current));
    } catch (cause) {
      setProviderError(cause instanceof Error ? cause.message : "Provider could not be removed.");
    }
  };

  const selectedRouteModel = selectedProvider?.models.find((model) => model.id === modelProfileId) ?? null;
  const selectedRouteEligible = Boolean(
    selectedProvider
    && selectedProvider.enabled
    && selectedProvider.state === "connected"
    && selectedRouteModel?.status === "available"
    && selectedProvider.models.some((model) => model.id === selectedRouteModel.id && model.status === "available"),
  );
  const selectedRouteBlocked = Boolean(selectedRouteModel && !selectedRouteEligible);
  const selectedRouteValue = selectedRouteModel || modelProfileId === "auto" ? modelProfileId : "auto";
  const selectedRouteSummary = selectedProvider ? routeSummaryForProvider(selectedProvider) : null;
  const selectRouteModel = (nextModelId: string) => {
    setModelProfile(nextModelId);
    const nextModel = selectedProvider?.models.find((model) => model.id === nextModelId);
    setProviderStatus(
      nextModelId === "auto"
        ? "Automatic route selected for chat."
        : `${nextModel?.displayName ?? "Model route"} selected for chat preview.`,
    );
  };
  const focusModelRoute = () => {
    const routeSelect = routeModelSelectRef.current;
    if (!routeSelect) return;
    routeSelect.focus();
    if (typeof routeSelect.scrollIntoView === "function") {
      routeSelect.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    setProviderStatus("Choose the model used by Chat, or keep Automatic route.");
  };

  return (
    <>
      <section className="provider-hero">
        <div>
          <span className="provider-hero__icon">
            <KeyRound size={21} />
          </span>
          <span>
            <span className="eyebrow">Bring your own keys</span>
            <h2>Provider text chat preview</h2>
            <p>
              Available native adapters stream text through one normalized event path. Advanced
              harness context, replay, memory, skills, tools, and fallback routing are planned.
            </p>
          </span>
        </div>
        <button
          type="button"
          className="button button--primary"
          onClick={() => openWorkspaceOverlay({ kind: "connect-provider" })}
        >
          <Plus size={15} /> Connect provider
        </button>
        <div className="provider-hero__stats">
          <span>
            <strong>{connectedProviders}</strong>
            <small>Connected</small>
          </span>
          <span>
            <strong>{availableModels}</strong>
            <small>Models</small>
          </span>
          <span>
            <strong>0</strong>
            <small>Secrets in UI storage</small>
          </span>
        </div>
      </section>
      <ModelCatalogOnboarding
        providers={providers}
        selectedProvider={selectedProvider}
        modelProfileId={modelProfileId}
        runtime={runtime}
        onConnectProvider={() => openWorkspaceOverlay({ kind: "connect-provider" })}
        onDiscoverModels={(provider) => void testProvider(provider)}
        onReviewRoute={focusModelRoute}
      />
      <ProviderModalityOnboarding
        providers={providers}
        selectedProvider={selectedProvider}
        modelProfileId={modelProfileId}
        runtime={runtime}
        onConnectProvider={() => openWorkspaceOverlay({ kind: "connect-provider" })}
        onDiscoverModels={(provider) => void testProvider(provider)}
        onReviewRoute={focusModelRoute}
      />
      <section className="settings-section provider-manager">
        <header>
          <div>
            <h2>Provider connections</h2>
            <p>
              {syncingProviders
                ? "Syncing native connection metadata…"
                : "Credentials stay behind the native secret boundary."}
            </p>
          </div>
          <label className="provider-search">
            <Search size={14} />
            <input
              value={providerQuery}
              onChange={(event) => setProviderQuery(event.target.value)}
              placeholder="Filter providers or models"
              aria-label="Filter providers or models"
            />
          </label>
        </header>
        {providerError ? (
          <div className="provider-inline-error" role="alert">
            <AlertTriangle size={15} />
            <span>{providerError}</span>
          </div>
        ) : null}
        {providerStatus ? (
          <div className="provider-inline-status" role="status" aria-live="polite">
            <Activity size={15} />
            <span>{providerStatus}</span>
          </div>
        ) : null}
        <div className="provider-manager__layout">
          <div className="provider-list" role="list" aria-label="Provider connections">
            {filteredProviders.map((provider) => (
              <div role="listitem" key={provider.id}>
                <button
                  type="button"
                  className={
                    selectedProvider?.id === provider.id
                      ? "provider-list-row provider-list-row--active"
                      : "provider-list-row"
                  }
                  aria-pressed={selectedProvider?.id === provider.id}
                  onClick={() => setSelectedProviderId(provider.id)}
                >
                  <span className="provider-mark">
                    {provider.kind === "Local" ? <Server size={15} /> : provider.name.slice(0, 1)}
                  </span>
                  <span className="provider-list-row__copy">
                    <strong>{provider.name}</strong>
                    <small>
                      {provider.kind} · {provider.modelCount} models
                    </small>
                  </span>
                  <span className={`provider-state provider-state--${provider.state}`}>
                    {providerStateLabel(provider)}
                  </span>
                </button>
              </div>
            ))}
            {filteredProviders.length === 0 ? (
              <div className="provider-empty">
                <Server size={22} />
                <strong>
                  {providers.length === 0 ? "No providers connected" : "No matching providers"}
                </strong>
                <p>
                  {providers.length === 0
                    ? "Connect a cloud or local provider to make its models available in chat."
                    : "Try a provider name, endpoint, or model ID."}
                </p>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => openWorkspaceOverlay({ kind: "connect-provider" })}
                >
                  <Plus size={14} /> Connect provider
                </button>
              </div>
            ) : null}
            {selectedProvider && !filteredProviders.some((provider) => provider.id === selectedProvider.id) ? (
              <p className="provider-filter-note" role="status">
                The selected provider is hidden by the current filter.
              </p>
            ) : null}
          </div>
          <div className="provider-detail">
            {selectedProvider ? (
              <>
                <header className="provider-detail__header">
                  <span className="provider-mark provider-mark--large">
                    {selectedProvider.kind === "Local" ? (
                      <Server size={19} />
                    ) : (
                      selectedProvider.name.slice(0, 1)
                    )}
                  </span>
                  <span>
                    <span className="eyebrow">{selectedProvider.kind}</span>
                    <h3>{selectedProvider.name}</h3>
                    <p>{selectedProvider.endpoint}</p>
                  </span>
                  <label
                    className="mini-toggle hit-target-control"
                    title="Provider enable/disable is planned"
                  >
                    <input
                      type="checkbox"
                      checked={selectedProvider.enabled}
                      disabled
                      aria-label="Provider enable or disable (planned)"
                    />
                    <span />
                  </label>
                </header>
                <div className="provider-health-grid">
                  <article>
                    <ShieldCheck size={15} />
                    <span>Credential</span>
                    <strong>{selectedProvider.credentialState.replaceAll("-", " ")}</strong>
                  </article>
                  <article>
                    <Activity size={15} />
                    <span>Latency</span>
                    <strong>
                      {selectedProvider.latencyMs === null
                        ? "Not reported"
                        : `${selectedProvider.latencyMs} ms`}
                    </strong>
                  </article>
                  <article>
                    <Server size={15} />
                    <span>Models</span>
                    <strong>{selectedProvider.modelCount}</strong>
                  </article>
                </div>
                <div className="provider-detail__meta">
                  <span>
                    <strong>Authentication</strong>
                    {selectedProvider.authScheme.replaceAll("-", " ")}
                  </span>
                  <span>
                    <strong>Last validation</strong>
                    {formatProviderCheckTime(selectedProvider.lastCheckedAt)}
                  </span>
                  <span>
                    <strong>Storage boundary</strong>
                    {selectedProvider.source === "native"
                      ? "Windows credential vault"
                      : "Preview metadata only"}
                  </span>
                </div>
                {selectedRouteSummary ? (
                  <section
                    className={`provider-route-summary provider-route-summary--${routeToneForProvider(selectedProvider)}`}
                    aria-label="Provider route readiness"
                  >
                    <header>
                      <span>
                        <strong><Route size={13} /> Chat route</strong>
                        <small>{selectedRouteSummary.detail}</small>
                      </span>
                      <em>{selectedRouteSummary.label}</em>
                    </header>
                    <label>
                      <span>Model used by Chat</span>
                      <select
                        ref={routeModelSelectRef}
                        value={selectedRouteValue}
                        onChange={(event) => selectRouteModel(event.target.value)}
                        aria-label="Model used by Chat"
                        disabled={selectedProvider.state === "validating"}
                      >
                        <option value="auto">Automatic route</option>
                        {selectedProvider.models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.displayName} · {model.providerModelId}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className={selectedRouteBlocked ? "provider-route-summary__selection provider-route-summary__selection--blocked" : "provider-route-summary__selection"}>
                      {selectedRouteModel && selectedRouteBlocked ? (
                        <><AlertTriangle size={13} /> {selectedRouteModel.displayName} is selected but currently blocked; validate the provider before sending.</>
                      ) : selectedRouteModel ? (
                        <><Check size={13} /> {selectedRouteModel.displayName} is the active chat model.</>
                      ) : (
                        <><Route size={13} /> Automatic routing will choose from eligible models.</>
                      )}
                    </p>
                  </section>
                ) : null}
                {selectedProvider.errorMessage ? (
                  <div
                    className={
                      selectedProvider.state === "error"
                        ? "provider-detail__notice provider-detail__notice--error"
                        : "provider-detail__notice"
                    }
                  >
                    <AlertTriangle size={15} />
                    <p>{selectedProvider.errorMessage}</p>
                  </div>
                ) : null}
                <section className="provider-model-catalog">
                  <header>
                    <span>
                      <strong>Discovered models</strong>
                      <small>Capabilities drive model selection and parameter visibility</small>
                    </span>
                    <button
                      type="button"
                      className="icon-button icon-button--small"
                      aria-label="Refresh models"
                      title="Refresh models"
                      disabled={selectedProvider.state === "validating"}
                      onClick={() => void testProvider(selectedProvider)}
                    >
                      <RefreshCw size={14} />
                    </button>
                  </header>
                  {selectedProvider.models.length > 0 ? (
                    selectedProvider.models.map((model) => (
                      <article key={model.id}>
                        <span className="model-status-dot" />
                        <span>
                          <strong>{model.displayName}</strong>
                          <small>
                            {model.providerModelId} · {model.contextLabel}
                          </small>
                        </span>
                        <span className="provider-model-tags">
                          {model.capabilities.slice(0, 4).map((capability) => (
                            <small key={capability}>{capability}</small>
                          ))}
                        </span>
                      </article>
                    ))
                  ) : (
                    <p className="provider-model-empty">
                      Run validation to discover models, or reconnect with a model ID hint.
                    </p>
                  )}
                </section>
                <footer className="provider-detail__actions">
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={selectedProvider.state === "validating"}
                    onClick={() => void testProvider(selectedProvider)}
                  >
                    {selectedProvider.state === "validating" ? (
                      <RefreshCw className="spin" size={14} />
                    ) : (
                      <Activity size={14} />
                    )}
                    {selectedProvider.state === "validating"
                      ? "Testing…"
                      : selectedProvider.source === "native" && runtime.tauri
                        ? "Test & discover"
                        : "Validate configuration (preview)"}
                  </button>
                  <button
                    type="button"
                    className="button button--danger-ghost"
                    onClick={() => void deleteProvider(selectedProvider)}
                  >
                    <Trash2 size={14} /> Remove
                  </button>
                </footer>
              </>
            ) : (
              <div className="provider-detail-empty">
                <KeyRound size={26} />
                <h3>Select a provider</h3>
                <p>Inspect credentials, health, models, capabilities, and network policy.</p>
              </div>
            )}
          </div>
        </div>
      </section>
      <ProviderWorkbenchSurface
        providers={providers}
        modelProfileId={modelProfileId}
        onModelProfileChange={setModelProfile}
      />
    </>
  );
}
