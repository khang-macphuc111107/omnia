import type { AppRuntimeInfo } from "@/lib/desktop";
import type { MouseEvent } from "react";

import { SettingsNestedLazySurface } from "./settings-nested-lazy-surface";

export const SETTINGS_DIAGNOSTICS_SURFACES = [
  {
    id: "settings-diagnostics-session",
    label: "Session logs",
    description: "Redacted session events and export scope",
  },
  {
    id: "settings-diagnostics-signals",
    label: "Signal preferences",
    description: "Attention, review, and voice rehearsal",
  },
  {
    id: "settings-diagnostics-observability",
    label: "Observability",
    description: "Usage, cost, and evidence posture",
  },
  {
    id: "settings-diagnostics-evidence",
    label: "Evidence dashboard",
    description: "Request lifecycle and receipt coverage",
  },
  {
    id: "settings-diagnostics-telemetry-inspector",
    label: "Telemetry inspector",
    description: "Event filters, field provenance, and pinned review",
  },
  {
    id: "settings-diagnostics-workspace-export",
    label: "Workspace export / import",
    description: "Portable metadata bundles and profiles",
  },
] as const;

const loadDiagnosticsSessionWorkbench = () =>
  import("./diagnostics-session-workbench").then(({ DiagnosticsSessionWorkbench }) => ({
    default: DiagnosticsSessionWorkbench,
  }));

const loadSignalPreferencesPreview = () =>
  import("./signal-preferences-preview").then(({ default: SignalPreferencesPreview }) => ({
    default: SignalPreferencesPreview,
  }));

const loadObservabilityPreview = () =>
  import("./observability-preview").then(({ default: ObservabilityPreview }) => ({
    default: ObservabilityPreview,
  }));

const loadObservabilityEvidenceDashboard = () =>
  import("./observability-evidence-dashboard").then(({ default: ObservabilityEvidenceDashboard }) => ({
    default: ObservabilityEvidenceDashboard,
  }));

const loadTelemetryInspectorPreview = () =>
  import("./telemetry-inspector-preview").then(({ default: TelemetryInspectorPreview }) => ({
    default: TelemetryInspectorPreview,
  }));

const loadWorkspaceExportCenter = () =>
  import("./workspace-export-center").then(({ default: WorkspaceExportCenter }) => ({
    default: WorkspaceExportCenter,
  }));

export default function SettingsDiagnosticsSurface({
  runtime,
}: {
  runtime: AppRuntimeInfo;
}) {
  const jumpToSurface = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    // Keep the href as a no-JS/accessibility fallback, but route the normal
    // interaction through Settings' own scroll host. A document-level anchor
    // can otherwise move the app shell underneath sticky chrome in WebViews.
    const target = document.getElementById(id);
    const host = target?.closest<HTMLElement>(".settings-screen");
    if (!target || !host) return;

    event.preventDefault();
    const nextTop = Math.max(
      0,
      target.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop - 12,
    );
    const prefersReducedMotion = window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
    const behavior: ScrollBehavior = prefersReducedMotion ? "auto" : "smooth";
    if (typeof host.scrollTo === "function") {
      host.scrollTo({ top: nextTop, behavior });
    } else {
      host.scrollTop = nextTop;
    }
    target.focus({ preventScroll: true });
  };

  return (
    <section className="settings-diagnostics-surface" aria-labelledby="settings-diagnostics-surface-title">
      <header className="settings-diagnostics-surface__header">
        <div>
          <span className="eyebrow">Portable evidence and configuration</span>
          <h2 id="settings-diagnostics-surface-title">Diagnostics &amp; export workbenches</h2>
          <p>Jump directly to a renderer-local workbench. Import, export, and review actions stay session-only; no native bundle or provider request is created.</p>
        </div>
        <span className="settings-preview-chip">Renderer-local</span>
      </header>

      <nav className="settings-diagnostics-surface__nav" aria-label="Diagnostics and export workbench navigation">
        <span className="settings-diagnostics-surface__nav-label">Jump to</span>
        {SETTINGS_DIAGNOSTICS_SURFACES.map((surface) => (
          <a key={surface.id} href={`#${surface.id}`} onClick={(event) => jumpToSurface(event, surface.id)}>
            <strong>{surface.label}</strong>
            <small>{surface.description}</small>
          </a>
        ))}
      </nav>

      <div className="settings-diagnostics-surface__list">
        <div id="settings-diagnostics-session" className="settings-diagnostics-surface__anchor" tabIndex={-1}>
          <SettingsNestedLazySurface
            label="Session log workbench"
            load={loadDiagnosticsSessionWorkbench}
            props={{ runtime }}
          />
        </div>
        <div id="settings-diagnostics-signals" className="settings-diagnostics-surface__anchor" tabIndex={-1}>
          <SettingsNestedLazySurface
            label="Signal preferences"
            load={loadSignalPreferencesPreview}
            props={{}}
          />
        </div>
        <div id="settings-diagnostics-observability" className="settings-diagnostics-surface__anchor" tabIndex={-1}>
          <SettingsNestedLazySurface
            label="Observability preview"
            load={loadObservabilityPreview}
            props={{}}
          />
        </div>
        <div id="settings-diagnostics-evidence" className="settings-diagnostics-surface__anchor" tabIndex={-1}>
          <SettingsNestedLazySurface
            label="Observability evidence dashboard"
            load={loadObservabilityEvidenceDashboard}
            props={{}}
          />
        </div>
        <div id="settings-diagnostics-telemetry-inspector" className="settings-diagnostics-surface__anchor" tabIndex={-1}>
          <SettingsNestedLazySurface
            label="Telemetry inspector"
            load={loadTelemetryInspectorPreview}
            props={{}}
          />
        </div>
        <div id="settings-diagnostics-workspace-export" className="settings-diagnostics-surface__anchor" tabIndex={-1}>
          <SettingsNestedLazySurface
            label="Workspace export center"
            load={loadWorkspaceExportCenter}
            props={{}}
          />
        </div>
      </div>

      <p className="settings-diagnostics-surface__boundary" role="note">
        Import and export controls only inspect or stage renderer-visible metadata in this session. They do not restore app data, write files, persist settings, or create native receipts.
      </p>
    </section>
  );
}
