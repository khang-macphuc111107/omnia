import {
  ArrowRight,
  AudioLines,
  Check,
  CircleAlert,
  CircleHelp,
  Eye,
  Image,
  MessageSquareText,
  Mic2,
  Radio,
  ShieldCheck,
  Sparkles,
  Video,
  Volume2,
  type LucideIcon,
} from "lucide-react";

import type { AppRuntimeInfo } from "@/lib/desktop";

import type { ModelProfileView, ProviderView } from "./types";

export type ProviderModalityId =
  | "chat"
  | "vision"
  | "audio"
  | "image-generation"
  | "video-generation"
  | "speech-to-text"
  | "text-to-speech"
  | "live-voice";

export type ProviderModalityStatus =
  | "ready"
  | "preview"
  | "needs-catalog"
  | "not-reported"
  | "unavailable";

type ModalityDefinition = {
  readonly id: ProviderModalityId;
  readonly label: string;
  readonly detail: string;
  readonly catalogCapability: "vision" | "audio" | null;
  readonly icon: LucideIcon;
};

type ModalityCard = ModalityDefinition & {
  readonly status: ProviderModalityStatus;
  readonly evidence: string;
};

export type ProviderModalityOnboardingProps = {
  readonly providers: readonly ProviderView[];
  readonly selectedProvider: ProviderView | null;
  readonly modelProfileId: string;
  readonly runtime: Pick<AppRuntimeInfo, "tauri">;
  readonly onConnectProvider: () => void;
  readonly onDiscoverModels: (provider: ProviderView) => void;
  readonly onReviewRoute: () => void;
};

const modalityDefinitions: readonly ModalityDefinition[] = [
  {
    id: "chat",
    label: "Text chat",
    detail: "Streaming text, tools, and structured responses",
    catalogCapability: null,
    icon: MessageSquareText,
  },
  {
    id: "vision",
    label: "Vision input",
    detail: "Attach images to a multimodal prompt",
    catalogCapability: "vision",
    icon: Eye,
  },
  {
    id: "audio",
    label: "Audio I/O",
    detail: "Provider-declared audio input or output",
    catalogCapability: "audio",
    icon: AudioLines,
  },
  {
    id: "image-generation",
    label: "Image generation",
    detail: "Prompt-to-image endpoint and artifact handoff",
    catalogCapability: null,
    icon: Image,
  },
  {
    id: "video-generation",
    label: "Video generation",
    detail: "Prompt/image-to-video endpoint and media handoff",
    catalogCapability: null,
    icon: Video,
  },
  {
    id: "speech-to-text",
    label: "Speech to text",
    detail: "Transcribe a microphone or uploaded audio clip",
    catalogCapability: null,
    icon: Mic2,
  },
  {
    id: "text-to-speech",
    label: "Text to speech",
    detail: "Render a response as an audio artifact",
    catalogCapability: null,
    icon: Volume2,
  },
  {
    id: "live-voice",
    label: "Live voice",
    detail: "Low-latency duplex conversation session",
    catalogCapability: null,
    icon: Radio,
  },
];

const statusLabels: Record<ProviderModalityStatus, string> = {
  ready: "Ready",
  preview: "Preview candidate",
  "needs-catalog": "Needs catalog",
  "not-reported": "Not reported",
  unavailable: "Unavailable",
};

function isEligibleProvider(provider: ProviderView): boolean {
  return provider.enabled && provider.state !== "error" && provider.state !== "not-configured";
}

function modelIsAvailable(model: ModelProfileView): boolean {
  return model.status === "available";
}

function modelsForRoute(
  providers: readonly ProviderView[],
  selectedProvider: ProviderView | null,
  modelProfileId: string,
): readonly { model: ModelProfileView; provider: ProviderView }[] {
  const visibleProviders = selectedProvider ? [selectedProvider] : providers;
  const pairs = visibleProviders.flatMap((provider) =>
    provider.models
      .filter((model) => modelProfileId === "auto" || model.id === modelProfileId)
      .map((model) => ({ model, provider })),
  );
  if (pairs.length > 0) return pairs;
  if (modelProfileId !== "auto") return [];
  return providers.flatMap((provider) => provider.models.map((model) => ({ model, provider })));
}

function statusForModality(
  definition: ModalityDefinition,
  providers: readonly ProviderView[],
  selectedProvider: ProviderView | null,
  modelProfileId: string,
  runtime: Pick<AppRuntimeInfo, "tauri">,
): { status: ProviderModalityStatus; evidence: string } {
  if (definition.catalogCapability === null && definition.id !== "chat") {
    return {
      status: "not-reported",
      evidence: "The current provider contract does not expose this endpoint yet.",
    };
  }

  if (providers.length === 0) {
    return {
      status: "needs-catalog",
      evidence: "Connect a provider and discover its model catalog first.",
    };
  }

  const routeModels = modelsForRoute(providers, selectedProvider, modelProfileId);
  if (routeModels.length === 0) {
    return {
      status: "needs-catalog",
      evidence: "No model record matches the current route selection.",
    };
  }

  const capablePairs = routeModels.filter(({ model }) =>
    definition.id === "chat" || Boolean(definition.catalogCapability && model.capabilities.includes(definition.catalogCapability)),
  );
  if (capablePairs.length === 0) {
    return {
      status: "not-reported",
      evidence: "No selected model reports the required capability.",
    };
  }

  const availablePairs = capablePairs.filter(({ model, provider }) =>
    modelIsAvailable(model) && isEligibleProvider(provider),
  );
  if (availablePairs.length === 0) {
    return {
      status: "unavailable",
      evidence: "The catalog has a capability, but its route is not currently eligible.",
    };
  }

  const hasNativeRoute = availablePairs.some(({ provider }) =>
    runtime.tauri && provider.source === "native" && provider.state === "connected",
  );
  if (hasNativeRoute) {
    return {
      status: "ready",
      evidence: "A connected native provider and available model report this route.",
    };
  }
  return {
    status: "preview",
    evidence: "Catalog metadata is visible, but browser preview does not prove provider dispatch.",
  };
}

function StatusIcon({ status }: { readonly status: ProviderModalityStatus }) {
  if (status === "ready") return <Check size={12} aria-hidden="true" />;
  if (status === "preview") return <Sparkles size={12} aria-hidden="true" />;
  if (status === "unavailable") return <CircleAlert size={12} aria-hidden="true" />;
  return <CircleHelp size={12} aria-hidden="true" />;
}

export function providerModalityStatus(
  modality: ProviderModalityId,
  providers: readonly ProviderView[],
  selectedProvider: ProviderView | null,
  modelProfileId: string,
  runtime: Pick<AppRuntimeInfo, "tauri">,
): ProviderModalityStatus {
  const definition = modalityDefinitions.find((item) => item.id === modality);
  if (!definition) return "not-reported";
  return statusForModality(definition, providers, selectedProvider, modelProfileId, runtime).status;
}

export function ProviderModalityOnboarding({
  providers,
  selectedProvider,
  modelProfileId,
  runtime,
  onConnectProvider,
  onDiscoverModels,
  onReviewRoute,
}: ProviderModalityOnboardingProps) {
  const cards: readonly ModalityCard[] = modalityDefinitions.map((definition) => ({
    ...definition,
    ...statusForModality(definition, providers, selectedProvider, modelProfileId, runtime),
  }));
  const readyCount = cards.filter((card) => card.status === "ready").length;
  const previewCount = cards.filter((card) => card.status === "preview").length;
  const discoveryProvider = selectedProvider ?? providers[0] ?? null;
  const action = providers.length === 0
    ? { label: "Connect provider", title: "Open provider connection setup", onClick: onConnectProvider }
    : discoveryProvider && discoveryProvider.models.length === 0
      ? { label: "Discover catalog", title: `Test ${discoveryProvider.name} and discover models`, onClick: () => onDiscoverModels(discoveryProvider) }
      : { label: "Review Chat route", title: "Focus the model used by Chat selector", onClick: onReviewRoute };

  return (
    <section className="provider-modality-onboarding" aria-label="Provider modality onboarding">
      <header className="provider-modality-onboarding__header">
        <div className="provider-modality-onboarding__heading">
          <span className="provider-modality-onboarding__icon" aria-hidden="true"><AudioLines size={17} /></span>
          <span>
            <span className="eyebrow">Modality route matrix</span>
            <h2>Chat, media &amp; voice readiness</h2>
            <p>See which routes have catalog evidence before opening a composer or media surface.</p>
          </span>
        </div>
        <div className="provider-modality-onboarding__summary" role="status" aria-live="polite">
          <strong>{readyCount} ready</strong>
          <span>{previewCount} preview</span>
          <span>{cards.length - readyCount - previewCount} to confirm</span>
        </div>
      </header>

      <div className="provider-modality-onboarding__grid">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <article key={card.id} className={`provider-modality-card provider-modality-card--${card.status}`}>
              <div className="provider-modality-card__topline">
                <span className="provider-modality-card__icon" aria-hidden="true"><Icon size={15} /></span>
                <span className={`provider-modality-card__status provider-modality-card__status--${card.status}`}>
                  <StatusIcon status={card.status} /> {statusLabels[card.status]}
                </span>
              </div>
              <strong>{card.label}</strong>
              <small>{card.detail}</small>
              <span className="provider-modality-card__evidence">{card.evidence}</span>
            </article>
          );
        })}
      </div>

      <footer className="provider-modality-onboarding__footer">
        <p><ShieldCheck size={14} aria-hidden="true" /> Browser preview can show catalog claims, but it does not upload media, open a microphone, or dispatch a provider request.</p>
        <button type="button" className="button button--secondary" title={action.title} onClick={action.onClick}>
          {action.label}<ArrowRight size={13} aria-hidden="true" />
        </button>
      </footer>
    </section>
  );
}

export default ProviderModalityOnboarding;
