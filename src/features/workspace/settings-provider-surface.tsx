import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode, type SyntheticEvent } from "react";

import { SettingsNestedLazySurface } from "./settings-nested-lazy-surface";
import type { ProviderView } from "./types";

const loadRoutingWorkbench = () =>
  import("./routing-workbench").then(({ RoutingWorkbench }) => ({ default: RoutingWorkbench }));

const loadProviderConnectionProfilePreview = () =>
  import("./provider-connection-profile-preview").then(({ ProviderConnectionProfilePreview }) => ({
    default: ProviderConnectionProfilePreview,
  }));

const loadModelEndpointWorkbench = () =>
  import("./model-endpoint-workbench").then(({ ModelEndpointWorkbench }) => ({
    default: ModelEndpointWorkbench,
  }));

const loadProviderModelLab = () =>
  import("./provider-model-lab-preview").then(({ ProviderModelLabPreview }) => ({
    default: ProviderModelLabPreview,
  }));

const loadPromptTemplateLab = () =>
  import("./prompt-template-lab-preview").then(({ default: PromptTemplateLabPreview }) => ({
    default: PromptTemplateLabPreview,
  }));

const loadProviderEndpointHealth = () =>
  import("./provider-endpoint-health-preview").then(({ ProviderEndpointHealthPreview }) => ({
    default: ProviderEndpointHealthPreview,
  }));

const loadProviderModelCompatibility = () =>
  import("./provider-model-compatibility-preview").then(({ ProviderModelCompatibilityPreview }) => ({
    default: ProviderModelCompatibilityPreview,
  }));

const loadLocalModelReadiness = () =>
  import("./local-model-readiness-preview").then(({ LocalModelReadinessPreview }) => ({
    default: LocalModelReadinessPreview,
  }));

const loadLocalModelCatalog = () =>
  import("./local-model-catalog-preview").then(({ LocalModelCatalogPreview }) => ({
    default: LocalModelCatalogPreview,
  }));

type ProviderDisclosureProps = {
  label: string;
  description: string;
  eyebrow: string;
  badge: string;
  children: ReactNode;
};

/**
 * Keeps the provider workbench readable without removing any capability from
 * the renderer preview. Advanced surfaces mount only after the user opens the
 * section, which avoids a long first paint and makes the primary connection
 * flow visually obvious.
 */
function ProviderDisclosure({
  label,
  description,
  eyebrow,
  badge,
  children,
}: ProviderDisclosureProps) {
  const [hasOpened, setHasOpened] = useState(false);
  const [open, setOpen] = useState(false);
  const bodyId = useId();

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const nextOpen = event.currentTarget.open;
    setOpen(nextOpen);
    if (nextOpen) setHasOpened(true);
  };

  return (
    <details className="provider-settings-disclosure" open={open} onToggle={handleToggle}>
      <summary
        className="provider-settings-disclosure__summary"
        aria-expanded={open}
        aria-controls={bodyId}
        title={`${open ? "Collapse" : "Open"} ${label}`}
        onClick={(event) => {
          // Keep the disclosure controlled so the visual state, aria-expanded,
          // and lazy surface mount all move together even in embedded WebViews
          // that do not reliably dispatch the native `toggle` event.
          event.preventDefault();
          if (!open) setHasOpened(true);
          setOpen(!open);
        }}
      >
        <span className="provider-settings-disclosure__marker" aria-hidden="true">
          <span />
        </span>
        <span className="provider-settings-disclosure__copy">
          <span className="eyebrow">{eyebrow}</span>
          <strong>{label}</strong>
          <small>{description}</small>
        </span>
        <span className="provider-settings-disclosure__badge">{badge}</span>
        <ChevronDown className="provider-settings-disclosure__chevron" size={16} aria-hidden="true" />
      </summary>
      <div id={bodyId} className="provider-settings-disclosure__body">
        {hasOpened ? children : null}
      </div>
    </details>
  );
}

export default function SettingsProviderSurface({
  providers,
  modelProfileId,
  onModelProfileChange,
}: {
  providers: ProviderView[];
  modelProfileId: string;
  onModelProfileChange: (id: string) => void;
}) {
  return (
    <section className="provider-settings-workbenches" aria-label="Provider workbenches">
      <header className="provider-settings-workbenches__header">
        <span>
          <span className="eyebrow">Optional workbenches</span>
          <h2>Explore provider tools</h2>
          <p>Connections stay upfront. Open only the routing, model, or diagnostic tool you need.</p>
        </span>
        <small>9 tools · renderer preview</small>
      </header>
      <ProviderDisclosure
        eyebrow="Core routing"
        label="Routing workbench"
        description="Choose model policy, fallback consent, and route inheritance."
        badge="Core"
      >
        <SettingsNestedLazySurface
          label="Routing workbench"
          load={loadRoutingWorkbench}
          props={{ providers, modelProfileId, onModelProfileChange }}
        />
      </ProviderDisclosure>
      <ProviderDisclosure
        eyebrow="Reusable setup"
        label="Provider connection profiles"
        description="Save endpoint, authentication, transport, and capability defaults."
        badge="Core"
      >
        <SettingsNestedLazySurface
          label="Provider connection profiles"
          load={loadProviderConnectionProfilePreview}
          props={{ providers }}
        />
      </ProviderDisclosure>
      <ProviderDisclosure
        eyebrow="Advanced"
        label="Model endpoint workbench"
        description="Define protocols, operations, request parameters, and evidence."
        badge="Advanced"
      >
        <SettingsNestedLazySurface
          label="Model endpoint workbench"
          load={loadModelEndpointWorkbench}
          props={{ providers }}
        />
      </ProviderDisclosure>
      <ProviderDisclosure
        eyebrow="Advanced"
        label="Model Lab"
        description="Compare visible models, capabilities, speed, cost, and tuning defaults."
        badge="Advanced"
      >
        <SettingsNestedLazySurface
          label="Model Lab"
          load={loadProviderModelLab}
          props={{ providers }}
        />
      </ProviderDisclosure>
      <ProviderDisclosure
        eyebrow="Advanced"
        label="Prompt template lab"
        description="Exercise reusable prompts, variables, examples, and validation."
        badge="Advanced"
      >
        <SettingsNestedLazySurface
          label="Prompt template lab"
          load={loadPromptTemplateLab}
          props={{}}
        />
      </ProviderDisclosure>
      <ProviderDisclosure
        eyebrow="Operations"
        label="Endpoint health"
        description="Review availability, latency, probe scenarios, and evidence history."
        badge="Operations"
      >
        <SettingsNestedLazySurface
          label="Endpoint health"
          load={loadProviderEndpointHealth}
          props={{ providers }}
        />
      </ProviderDisclosure>
      <ProviderDisclosure
        eyebrow="Operations"
        label="Model compatibility"
        description="Inspect capability support across the visible provider catalog."
        badge="Operations"
      >
        <SettingsNestedLazySurface
          label="Model compatibility"
          load={loadProviderModelCompatibility}
          props={{ providers }}
        />
      </ProviderDisclosure>
      <ProviderDisclosure
        eyebrow="Local runtime"
        label="Local model readiness"
        description="Review the audited host posture and gates before planning a local model."
        badge="Planning"
      >
        <SettingsNestedLazySurface
          label="Local model readiness"
          load={loadLocalModelReadiness}
          props={{}}
        />
      </ProviderDisclosure>
      <ProviderDisclosure
        eyebrow="Local runtime"
        label="Local model catalog"
        description="Search seeded candidates by task, source, hardware fit, quality, and resource estimate."
        badge="Planning"
      >
        <SettingsNestedLazySurface
          label="Local model catalog"
          load={loadLocalModelCatalog}
          props={{}}
        />
      </ProviderDisclosure>
    </section>
  );
}
