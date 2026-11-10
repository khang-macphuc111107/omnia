import {
  Activity,
  ArrowUpRight,
  Database,
  Gauge,
  Layers3,
  ShieldCheck,
} from "lucide-react";
import { useId } from "react";

import type { RunTelemetrySnapshot } from "@/lib/desktop";

import type { ProjectContextAvailability } from "./project-context-availability-contract";

export type ProjectRuntimePostureTarget = "context" | "signals";
export type ProjectProviderCacheAuthority =
  | "authoritative"
  | "mixed"
  | "not-authoritative"
  | "not-observed";

export interface ProjectRuntimePostureProps {
  readonly projectName: string;
  readonly contextAvailability: ProjectContextAvailability;
  readonly runCount: number;
  readonly timelineEventCount: number;
  readonly telemetrySnapshots: readonly RunTelemetrySnapshot[];
  readonly onNavigate: (target: ProjectRuntimePostureTarget) => void;
}

export interface ProjectRuntimePostureProjection {
  readonly context: {
    readonly label: string;
    readonly detail: string;
    readonly tone: "neutral" | "info" | "warning" | "danger" | "success";
  };
  readonly cache: {
    readonly label: string;
    readonly detail: string;
    readonly providerReadTokens: number | null;
    readonly providerWriteTokens: number | null;
    /** Authority of the latest provider usage observations included here. */
    readonly authority: ProjectProviderCacheAuthority;
    readonly authoritative: boolean;
  };
  readonly telemetry: {
    readonly label: string;
    readonly detail: string;
    readonly attemptCount: number;
    readonly usageObservationCount: number;
  };
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function sumNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return present.length > 0 ? present.reduce((total, value) => total + Math.max(0, value), 0) : null;
}

function providerUsageRank(source: string): number {
  if (source === "provider-invoice") return 4;
  if (source === "provider-final") return 3;
  if (source === "provider-incremental") return 2;
  return 1;
}

function hasProviderCounters(observation: RunTelemetrySnapshot["attempts"][number]["usageLedger"][number]): boolean {
  return Object.values(observation.counters).some((value) => typeof value === "number" && Number.isFinite(value));
}

function latestProviderUsage(telemetrySnapshots: readonly RunTelemetrySnapshot[]) {
  return telemetrySnapshots.flatMap((snapshot) => snapshot.attempts.flatMap((attempt) => {
    const providerUsage = attempt.usageLedger.filter((observation) => observation.source.startsWith("provider-"));
    if (providerUsage.length === 0) return [];
    // Billing invoices can be authoritative but cost-only. Prefer the newest
    // provider observation that actually carries cache counters so an invoice
    // cannot erase a provider-final read/write report.
    const withCounters = providerUsage.filter(hasProviderCounters);
    const candidates = withCounters.length > 0 ? withCounters : providerUsage;
    const latest = candidates.reduce((current, candidate) => {
      if (candidate.sequence !== current.sequence) return candidate.sequence > current.sequence ? candidate : current;
      return providerUsageRank(candidate.source) >= providerUsageRank(current.source) ? candidate : current;
    });
    return [latest];
  }));
}

function contextDetail(contextAvailability: ProjectContextAvailability): string {
  if (contextAvailability.evidence.state === "native-current" && contextAvailability.evidence.revisionId) {
    return `Native revision ${contextAvailability.evidence.revisionId} is available for inspection.`;
  }
  if (contextAvailability.evidence.state === "native-stale" && contextAvailability.evidence.revisionId) {
    return `Historical revision ${contextAvailability.evidence.revisionId}; refresh before delivery.`;
  }
  return contextAvailability.reason;
}

export function buildProjectRuntimePosture(
  contextAvailability: ProjectContextAvailability,
  runCount: number,
  timelineEventCount: number,
  telemetrySnapshots: readonly RunTelemetrySnapshot[],
): ProjectRuntimePostureProjection {
  const attempts = telemetrySnapshots.flatMap((snapshot) => snapshot.attempts);
  const usage = attempts.flatMap((attempt) => attempt.usageLedger);
  const providerUsage = latestProviderUsage(telemetrySnapshots);
  const providerReadTokens = sumNullable(providerUsage.map((observation) => observation.counters.cacheReadInputTokens));
  const providerWriteTokens = sumNullable(providerUsage.map((observation) => observation.counters.cacheWriteInputTokens));
  const authoritativeCount = providerUsage.filter((observation) => observation.authoritative).length;
  const cacheAuthority: ProjectProviderCacheAuthority = providerUsage.length === 0
    ? "not-observed"
    : authoritativeCount === providerUsage.length
      ? "authoritative"
      : authoritativeCount > 0
        ? "mixed"
        : "not-authoritative";
  const authoritative = cacheAuthority === "authoritative";

  const telemetryLabel = telemetrySnapshots.length > 0
    ? `${formatCount(telemetrySnapshots.length)} run${telemetrySnapshots.length === 1 ? "" : "s"} observed`
    : timelineEventCount > 0
      ? "Timeline only"
      : "No telemetry observed";
  const telemetryDetail = telemetrySnapshots.length > 0
    ? `${formatCount(attempts.length)} attempt${attempts.length === 1 ? "" : "s"} · ${formatCount(usage.length)} usage observation${usage.length === 1 ? "" : "s"}`
    : timelineEventCount > 0
      ? `${formatCount(timelineEventCount)} timeline event${timelineEventCount === 1 ? "" : "s"}; usage counters are unavailable.`
      : `${formatCount(runCount)} run reference${runCount === 1 ? "" : "s"}; no native telemetry snapshot is hydrated.`;

  const cacheLabel = providerReadTokens !== null || providerWriteTokens !== null
    ? "Provider cache reported"
    : "No provider cache evidence";
  const cacheDetail = providerReadTokens !== null || providerWriteTokens !== null
    ? `${providerReadTokens === null ? "Read unavailable" : `${formatCount(providerReadTokens)} read`} · ${providerWriteTokens === null ? "write unavailable" : `${formatCount(providerWriteTokens)} written`} input tokens · ${cacheAuthority === "authoritative" ? "authoritative" : cacheAuthority === "mixed" ? "mixed authority" : "not authoritative"}`
    : "Local reuse is not instrumented here; renderer reuse must not be called provider cache.";

  return {
    context: {
      label: contextAvailability.label,
      detail: contextDetail(contextAvailability),
      tone: contextAvailability.tone,
    },
    cache: {
      label: cacheLabel,
      detail: cacheDetail,
      providerReadTokens,
      providerWriteTokens,
      authority: cacheAuthority,
      authoritative,
    },
    telemetry: {
      label: telemetryLabel,
      detail: telemetryDetail,
      attemptCount: attempts.length,
      usageObservationCount: usage.length,
    },
  };
}

function postureToneClass(tone: ProjectRuntimePostureProjection["context"]["tone"]): string {
  return `project-runtime-posture__card--${tone}`;
}

export function ProjectRuntimePosture({
  projectName,
  contextAvailability,
  runCount,
  timelineEventCount,
  telemetrySnapshots,
  onNavigate,
}: ProjectRuntimePostureProps) {
  const titleId = useId();
  const posture = buildProjectRuntimePosture(
    contextAvailability,
    runCount,
    timelineEventCount,
    telemetrySnapshots,
  );

  return (
    <section
      className="project-runtime-posture"
      aria-labelledby={titleId}
      data-project-runtime-posture={projectName}
    >
      <header className="project-runtime-posture__header">
        <div>
          <span className="eyebrow"><Gauge size={12} aria-hidden="true" /> Runtime posture</span>
          <h3 id={titleId}>What is actually observable right now</h3>
          <p>Compact evidence for context delivery, cache accounting, and run telemetry. Unknown stays unknown.</p>
        </div>
        <span className="project-runtime-posture__badge"><ShieldCheck size={12} aria-hidden="true" /> Renderer-aware</span>
      </header>

      <div className="project-runtime-posture__grid" aria-label="Project runtime posture facts">
        <button
          type="button"
          className={`project-runtime-posture__card ${postureToneClass(posture.context.tone)}`}
          onClick={() => onNavigate("context")}
          title="Open the Project Context workbench"
          aria-label={`Open context workbench: ${posture.context.label}`}
        >
          <span className="project-runtime-posture__icon"><Layers3 size={15} aria-hidden="true" /></span>
          <span className="project-runtime-posture__copy"><span>Context delivery</span><strong>{posture.context.label}</strong><small>{posture.context.detail}</small></span>
          <ArrowUpRight size={14} aria-hidden="true" />
        </button>

        <button
          type="button"
          className="project-runtime-posture__card project-runtime-posture__card--info"
          onClick={() => onNavigate("signals")}
          title="Open the Project signal center"
          aria-label={`Open signal center: ${posture.cache.label}`}
        >
          <span className="project-runtime-posture__icon"><Database size={15} aria-hidden="true" /></span>
          <span className="project-runtime-posture__copy"><span>Cache evidence</span><strong>{posture.cache.label}</strong><small>{posture.cache.detail}</small></span>
          <ArrowUpRight size={14} aria-hidden="true" />
        </button>

        <button
          type="button"
          className="project-runtime-posture__card project-runtime-posture__card--neutral"
          onClick={() => onNavigate("signals")}
          title="Open the Project signal center"
          aria-label={`Open signal center: ${posture.telemetry.label}`}
        >
          <span className="project-runtime-posture__icon"><Activity size={15} aria-hidden="true" /></span>
          <span className="project-runtime-posture__copy"><span>Telemetry coverage</span><strong>{posture.telemetry.label}</strong><small>{posture.telemetry.detail}</small></span>
          <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      </div>

      <p className="project-runtime-posture__boundary" role="note">
        <ShieldCheck size={13} aria-hidden="true" />
        <span>Provider cache is claimed only from provider-reported counters. No cache write, route change, context compile, or provider run is initiated by this strip.</span>
      </p>
    </section>
  );
}

export default ProjectRuntimePosture;
