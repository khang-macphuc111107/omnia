import {
  ArrowRight,
  Check,
  CircleAlert,
  Compass,
  Database,
  KeyRound,
  Route,
  ShieldCheck,
} from "lucide-react";

import type { AppRuntimeInfo } from "@/lib/desktop";

import type { ProviderView } from "./types";

type OnboardingStepId = "provider" | "catalog" | "route";
type OnboardingStepState = "complete" | "current" | "waiting";

export type ModelCatalogOnboardingProps = {
  readonly providers: readonly ProviderView[];
  readonly selectedProvider: ProviderView | null;
  readonly modelProfileId: string;
  readonly runtime: Pick<AppRuntimeInfo, "tauri">;
  readonly onConnectProvider: () => void;
  readonly onDiscoverModels: (provider: ProviderView) => void;
  readonly onReviewRoute: () => void;
};

type OnboardingStep = {
  readonly id: OnboardingStepId;
  readonly label: string;
  readonly detail: string;
  readonly state: OnboardingStepState;
  readonly actionLabel?: string;
  readonly actionTitle?: string;
  readonly onAction?: () => void;
};

function providerHasVisibleCatalog(provider: ProviderView): boolean {
  // A count alone is not a selectable catalog. Keep discovery current until
  // model records are actually hydrated into the renderer view.
  return provider.models.length > 0;
}

function providerHasAvailableModel(provider: ProviderView): boolean {
  return provider.enabled
    && provider.state === "connected"
    && provider.models.some((model) => model.status === "available");
}

function selectedRouteEvidence(
  providers: readonly ProviderView[],
  modelProfileId: string,
  runtime: Pick<AppRuntimeInfo, "tauri">,
): "native-candidate" | "preview" | "unknown" {
  const matchingProvider = providers.find((provider) => provider.enabled && provider.models.some(
    (model) => model.status === "available" && (modelProfileId === "auto" || model.id === modelProfileId),
  ));
  if (!matchingProvider) return "unknown";
  if (runtime.tauri && matchingProvider.source === "native" && providerHasAvailableModel(matchingProvider)) {
    return "native-candidate";
  }
  if (matchingProvider.source === "demo" || matchingProvider.source === "preview" || !runtime.tauri) return "preview";
  return "unknown";
}

function onboardingBoundary(runtime: Pick<AppRuntimeInfo, "tauri">): string {
  return runtime.tauri
    ? "Desktop onboarding can test native connections and refresh the native model catalog; choosing a route still happens in the existing Chat control."
    : "Browser preview onboarding uses session metadata only; no credential is stored and no provider request is sent."
}

export function ModelCatalogOnboarding({
  providers,
  selectedProvider,
  modelProfileId,
  runtime,
  onConnectProvider,
  onDiscoverModels,
  onReviewRoute,
}: ModelCatalogOnboardingProps) {
  const providerStepComplete = providers.length > 0;
  const catalogProviders = providers.filter(providerHasVisibleCatalog);
  const catalogStepComplete = catalogProviders.length > 0;
  const routeEvidence = selectedRouteEvidence(providers, modelProfileId, runtime);
  const routeStepComplete = routeEvidence !== "unknown";
  const discoveredProvider = selectedProvider ?? catalogProviders[0] ?? providers[0] ?? null;
  const currentStep: OnboardingStepId = !providerStepComplete
    ? "provider"
    : !catalogStepComplete
      ? "catalog"
      : !routeStepComplete
        ? "route"
        : "route";
  const completedCount = [providerStepComplete, catalogStepComplete, routeStepComplete].filter(Boolean).length;
  const routeLabel = modelProfileId === "auto" ? "Automatic route" : "Selected model";

  const steps: readonly OnboardingStep[] = [
    {
      id: "provider",
      label: "Connect a provider",
      detail: providerStepComplete
        ? `${providers.length} provider profile${providers.length === 1 ? "" : "s"} visible in this session.`
        : "Add a cloud, compatible, or local provider before selecting a model.",
      state: providerStepComplete ? "complete" : "current",
      ...(!providerStepComplete ? {
        actionLabel: "Connect provider",
        actionTitle: "Open provider connection setup",
        onAction: onConnectProvider,
      } : {}),
    },
    {
      id: "catalog",
      label: "Discover the model catalog",
      detail: catalogStepComplete
        ? `${catalogProviders.reduce((total, provider) => total + provider.models.length, 0)} model entr${catalogProviders.reduce((total, provider) => total + provider.models.length, 0) === 1 ? "y" : "ies"} visible; review its evidence state before use.`
        : "Validate the selected provider to fetch or preview its available models.",
      state: catalogStepComplete ? "complete" : providerStepComplete ? "current" : "waiting",
      ...(!catalogStepComplete && discoveredProvider ? {
        actionLabel: discoveredProvider.state === "validating" ? "Discovering…" : "Test & discover",
        actionTitle: `Test ${discoveredProvider.name} and refresh its model catalog`,
        onAction: () => onDiscoverModels(discoveredProvider),
      } : {}),
    },
    {
      id: "route",
      label: "Choose the Chat route",
      detail: routeStepComplete
        ? routeEvidence === "native-candidate"
          ? `${routeLabel} has a connected native catalog candidate; sending still starts from Chat.`
          : `${routeLabel} is visible in the renderer preview; no provider request or dispatch is proven here.`
        : "Review the route selector and choose a model or accept Automatic route.",
      state: routeStepComplete ? "complete" : catalogStepComplete ? "current" : "waiting",
      actionLabel: routeStepComplete ? "Review Chat route" : "Choose a model",
      actionTitle: "Focus the model used by Chat selector",
      onAction: onReviewRoute,
    },
  ];

  return (
    <section className="provider-onboarding" aria-label="Model catalog onboarding">
      <header className="provider-onboarding__header">
        <span className="provider-onboarding__icon" aria-hidden="true"><Compass size={17} /></span>
        <span>
          <span className="eyebrow">Model catalog onboarding</span>
          <h2>{completedCount === steps.length ? "Model route visible" : "Set up your first model route"}</h2>
          <p>{completedCount === steps.length ? "The provider, catalog, and Chat route are visible. Keep the evidence boundary in view as you continue." : "Follow the three short checks below; each action lands in the existing provider or Chat control."}</p>
        </span>
        <span className={`provider-onboarding__progress${completedCount === steps.length ? " is-complete" : ""}`} role="status" aria-live="polite">
          {completedCount}/{steps.length} complete
        </span>
      </header>

      <ol className="provider-onboarding__steps">
        {steps.map((step, index) => (
          <li
            key={step.id}
            className={`provider-onboarding__step provider-onboarding__step--${step.state}`}
            aria-current={currentStep === step.id ? "step" : undefined}
          >
            <span className="provider-onboarding__step-index" aria-hidden="true">
              {step.state === "complete" ? <Check size={13} /> : index + 1}
            </span>
            <span className="provider-onboarding__step-copy">
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </span>
            {step.onAction ? (
              <button
                type="button"
                className={step.state === "current" ? "button button--secondary" : "button button--ghost"}
                title={step.actionTitle}
                disabled={step.id === "catalog" && discoveredProvider?.state === "validating"}
                onClick={step.onAction}
              >
                {step.actionLabel}
                <ArrowRight size={13} aria-hidden="true" />
              </button>
            ) : null}
          </li>
        ))}
      </ol>

      <p className="provider-onboarding__boundary" role="note">
        <ShieldCheck size={14} aria-hidden="true" />
        <span>{onboardingBoundary(runtime)}</span>
      </p>
      {completedCount === steps.length ? (
        <div className="provider-onboarding__signals" aria-label="Model catalog onboarding evidence">
          <span><KeyRound size={13} aria-hidden="true" /><small>Provider</small><strong>{providers.length} profile{providers.length === 1 ? "" : "s"}</strong></span>
          <span><Database size={13} aria-hidden="true" /><small>Catalog</small><strong>{catalogProviders.reduce((total, provider) => total + provider.models.length, 0)} visible</strong></span>
          <span><Route size={13} aria-hidden="true" /><small>{routeEvidence === "native-candidate" ? "Route evidence" : "Route preview"}</small><strong>{routeLabel}</strong></span>
        </div>
      ) : currentStep === "route" ? (
        <p className="provider-onboarding__hint"><CircleAlert size={13} aria-hidden="true" /> Catalog metadata is present; route eligibility still depends on the selected provider state and model capability record.</p>
      ) : null}
    </section>
  );
}
