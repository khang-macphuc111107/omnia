import {
  Activity,
  Bot,
  Braces,
  CircleDollarSign,
  FileCode2,
  FileText,
  HeartPulse,
  History,
  LayoutDashboard,
  ListRestart,
  ListTree,
  PackageOpen,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  Timer,
  Wrench,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import type {
  RendererTimingObservation,
  RendererUsageObservation,
  RunTelemetrySnapshot,
} from "@/lib/desktop";
import { isDesktopRuntime } from "@/lib/desktop";

import type { RunControlOperationProjection } from "./run-control-projection";
import type { RunTimelineEventView } from "./evidence-types";
import { buildProjectContextAvailabilityForProject } from "./project-context-availability-contract";
import { providerStateLabel } from "./provider-catalog";
import { useWorkspaceStore } from "./store";
import type { ActiveRunView, ArtifactView, SkillView } from "./types";

export type InspectorPreviewView =
  | "overview"
  | "timeline"
  | "attempts"
  | "usage"
  | "timing"
  | "provider-health"
  | "agents-tools"
  | "artifacts"
  | "receipts";

const previewTabs: Array<{
  id: InspectorPreviewView;
  label: string;
  icon: typeof LayoutDashboard;
}> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "timeline", label: "Timeline", icon: Activity },
  { id: "attempts", label: "Attempts", icon: ListRestart },
  { id: "usage", label: "Usage & cost", icon: CircleDollarSign },
  { id: "timing", label: "Timing", icon: Timer },
  { id: "provider-health", label: "Provider health", icon: HeartPulse },
  { id: "agents-tools", label: "Agents & tools", icon: Bot },
  { id: "artifacts", label: "Artifacts", icon: PackageOpen },
  { id: "receipts", label: "Receipts", icon: ReceiptText },
];

function formatUnknown(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "Unknown";
  return typeof value === "number" ? value.toLocaleString() : value;
}

function formatState(value: string | null | undefined): string {
  return value ? value.replaceAll("-", " ") : "Unknown";
}

function formatTime(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatIsoTime(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(start: number | null | undefined, end: number | null | undefined): string {
  if (start === null || start === undefined || end === null || end === undefined || end < start) return "Unknown";
  const duration = end - start;
  return duration < 1_000 ? `${duration.toLocaleString()} ms` : `${(duration / 1_000).toFixed(2)} s`;
}

function PreviewBadge({ tone = "neutral", children }: { tone?: string; children: ReactNode }) {
  return <span className={`inspector-preview-badge inspector-preview-badge--${tone}`}>{children}</span>;
}

function PreviewHeader({
  eyebrow,
  title,
  description,
  status = "preview",
}: {
  eyebrow: string;
  title: string;
  description: string;
  status?: string;
}) {
  return (
    <header className="inspector-preview-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <PreviewBadge tone={status === "reported" ? "reported" : status === "unknown" ? "unknown" : "planned"}>
        {status}
      </PreviewBadge>
    </header>
  );
}

function PreviewStat({ label, value, detail, icon }: { label: string; value: string; detail?: string; icon: ReactNode }) {
  return (
    <article className="inspector-preview-stat">
      <span className="inspector-preview-stat__icon">{icon}</span>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </article>
  );
}

function PreviewEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="inspector-preview-empty">
      <Sparkles size={17} />
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function PreviewSection({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="inspector-preview-section">
      <header>
        <div>
          <strong>{title}</strong>
          {subtitle ? <small>{subtitle}</small> : null}
        </div>
      </header>
      {children}
    </section>
  );
}

function PreviewRow({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: string }) {
  return (
    <div className="inspector-preview-row">
      <span>{label}</span>
      <div>
        <strong className={tone ? `inspector-preview-text--${tone}` : undefined}>{value}</strong>
        {detail ? <small>{detail}</small> : null}
      </div>
    </div>
  );
}

function latestUsage(snapshot: RunTelemetrySnapshot | null): RendererUsageObservation | null {
  const attempts = snapshot?.attempts ?? [];
  return attempts[attempts.length - 1]?.usageLedger.at(-1) ?? null;
}

function latestTiming(snapshot: RunTelemetrySnapshot | null): RendererTimingObservation | null {
  const attempts = snapshot?.attempts ?? [];
  return attempts[attempts.length - 1]?.timingObservations.at(-1) ?? null;
}

function OverviewPanel({
  conversation,
  project,
  runId,
  activeRun,
  runState,
  events,
  providers,
  artifacts,
  skills,
  nativeEvidenceAvailable,
}: {
  conversation: ReturnType<typeof useWorkspaceStore.getState>["conversations"][number] | undefined;
  project: ReturnType<typeof useWorkspaceStore.getState>["projects"][number] | undefined;
  runId: string | null;
  activeRun: ActiveRunView | null;
  runState: string | null;
  events: RunTimelineEventView[];
  providers: ReturnType<typeof useWorkspaceStore.getState>["providers"];
  artifacts: ArtifactView[];
  skills: SkillView[];
  nativeEvidenceAvailable: boolean;
}) {
  const messageCount = conversation?.messages.length ?? 0;
  const attachmentCount = conversation?.messages.reduce((count, message) => count + message.attachments.length, 0) ?? 0;
  const enabledSkills = skills.filter((skill) => skill.enabled).length;
  const rendererRunLabel = isDesktopRuntime() ? "Active renderer-observed run" : "Active renderer preview run";
  const contextAvailability = project
    ? buildProjectContextAvailabilityForProject(project)
    : null;
  return (
    <>
      <PreviewHeader
        eyebrow="Workspace observability"
        title={conversation?.title ?? "No active chat"}
        description="A compact map of the current Chat scope and the evidence available in this renderer preview."
        status={nativeEvidenceAvailable ? "reported" : "preview"}
      />
      <div className="inspector-preview-grid">
        <PreviewStat label="Messages" value={formatUnknown(messageCount)} detail="In-session" icon={<FileText size={15} />} />
        <PreviewStat label="Attachments" value={formatUnknown(attachmentCount)} detail="Message metadata" icon={<FileCode2 size={15} />} />
        <PreviewStat label="Timeline" value={formatUnknown(events.length)} detail="Journal events" icon={<ListTree size={15} />} />
        <PreviewStat label="Providers" value={formatUnknown(providers.length)} detail="Configured profiles" icon={<ShieldCheck size={15} />} />
      </div>
      <PreviewSection title="Scope" subtitle="Inherited renderer state · native compilation remains separate">
        <div className="inspector-preview-list">
          <PreviewRow label="Project" value={project?.name ?? "Standalone Inbox"} detail={contextAvailability?.label ?? "No project owner"} />
          <PreviewRow label="Chat" value={conversation?.id ?? "Unknown"} detail={conversation?.unread ? "Unread" : "Read"} />
          <PreviewRow label="Run" value={runId ?? "No model run"} detail={nativeEvidenceAvailable ? (activeRun ? "Active native-backed run" : "Stored native projection") : activeRun ? rendererRunLabel : "Renderer projection only"} />
          <PreviewRow label="Lifecycle" value={formatState(runState)} detail={activeRun ? "Live renderer state" : "No active run"} />
        </div>
      </PreviewSection>
      <PreviewSection title="Capability signals" subtitle="Status is intentionally explicit; missing is not success">
        <div className="inspector-preview-list">
          <PreviewRow label="Context compiler" value="Planned" detail="Retrieval and token budgeting are not compiled" tone="planned" />
          <PreviewRow label="Native telemetry" value={nativeEvidenceAvailable ? "Observed" : "No native receipt"} detail={nativeEvidenceAvailable ? "Native evidence is available" : "Browser preview runs do not contact providers"} tone={nativeEvidenceAvailable ? "reported" : "unknown"} />
          <PreviewRow label="Memory" value="Planned" detail="No memory injection is claimed" tone="planned" />
          <PreviewRow label="Artifacts" value={artifacts.length ? `${artifacts.length} available` : "None linked"} detail={enabledSkills ? `${enabledSkills} enabled skill${enabledSkills === 1 ? "" : "s"}` : "Skills are separate from run evidence"} />
        </div>
      </PreviewSection>
    </>
  );
}

function TimelinePanel({ events, runId, nativeEvidenceAvailable }: { events: RunTimelineEventView[]; runId: string | null; nativeEvidenceAvailable: boolean }) {
  return (
    <>
      <PreviewHeader
        eyebrow="Run evidence"
        title="Timeline"
        description="Journal events are shown in sequence when the native replay has supplied them."
        status={events.length ? "reported" : "unknown"}
      />
      {events.length === 0 ? (
        <PreviewEmpty title="No timeline events" detail={runId ? nativeEvidenceAvailable ? "The run exists, but no native journal events are available yet." : "Browser preview runs have no native journal events." : "Start a model run to make a timeline available."} />
      ) : (
        <div className="inspector-preview-event-list">
          {events.map((event) => (
            <article className={`inspector-preview-event inspector-preview-event--${event.status}`} key={event.id}>
              <span className="inspector-preview-event__dot" />
              <div>
                <div className="inspector-preview-event__title">
                  <strong>{event.summary}</strong>
                  <PreviewBadge tone={event.status === "complete" ? "reported" : event.status === "failed" ? "warning" : "neutral"}>{formatState(event.status)}</PreviewBadge>
                </div>
                <p>{event.detail ?? `${event.stage} · ${event.source}`}</p>
                <time>{formatIsoTime(event.startedAt)}{event.endedAt ? ` → ${formatIsoTime(event.endedAt)}` : " · ongoing"}</time>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

function AttemptsPanel({ telemetry, runId, nativeEvidenceAvailable }: { telemetry: RunTelemetrySnapshot | null; runId: string | null; nativeEvidenceAvailable: boolean }) {
  const attempts = telemetry?.attempts ?? [];
  return (
    <>
      <PreviewHeader
        eyebrow="Provider lifecycle"
        title="Attempts"
        description="Retry and fallback attempts remain distinct from the logical run."
        status={attempts.length ? "reported" : "unknown"}
      />
      {attempts.length === 0 ? (
        <PreviewEmpty title="No attempt projection" detail={runId ? nativeEvidenceAvailable ? "The run has no attempt telemetry in this preview." : "Browser preview runs do not dispatch provider attempts." : "Attempts appear after a provider dispatch."} />
      ) : (
        <div className="inspector-preview-card-list">
          {attempts.map((attempt) => (
            <article className="inspector-preview-attempt" key={attempt.attemptId}>
              <div className="inspector-preview-event__title">
                <div>
                  <strong>Attempt {attempt.ordinal}</strong>
                  <small>{attempt.attemptId}</small>
                </div>
                <PreviewBadge tone={attempt.state === "complete" ? "reported" : attempt.state === "failed" ? "warning" : "neutral"}>{formatState(attempt.state)}</PreviewBadge>
              </div>
              <div className="inspector-preview-list">
                <PreviewRow label="Model" value={attempt.modelId} detail={attempt.providerProfileId ?? "Provider unknown"} />
                <PreviewRow label="Accepted" value={formatState(attempt.acceptedByProvider)} detail={attempt.errorCode ?? "No error code"} tone={attempt.acceptedByProvider === "true" ? "reported" : attempt.acceptedByProvider === "unknown" ? "unknown" : "warning"} />
                <PreviewRow label="Duration" value={formatDuration(attempt.startedAtMs, attempt.completedAtMs)} detail={`${attempt.usageLedger.length} usage observation${attempt.usageLedger.length === 1 ? "" : "s"}`} />
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

function UsagePanel({ telemetry, runId, nativeEvidenceAvailable }: { telemetry: RunTelemetrySnapshot | null; runId: string | null; nativeEvidenceAvailable: boolean }) {
  const usage = latestUsage(telemetry);
  return (
    <>
      <PreviewHeader
        eyebrow="Usage ledger"
        title="Usage & cost"
        description="Provider usage observations are displayed with their coverage and authority instead of inferred totals."
        status={usage ? "reported" : "unknown"}
      />
      {!usage ? (
        <PreviewEmpty title="No usage observation" detail={runId ? nativeEvidenceAvailable ? "The run has no provider usage record yet. Missing is not zero." : "Browser preview runs do not contact providers or produce usage records." : "Usage will appear when a provider run is observed."} />
      ) : (
        <>
          <div className="inspector-preview-grid inspector-preview-grid--compact">
            <PreviewStat label="Input" value={formatUnknown(usage.counters.inputTokens)} icon={<Braces size={15} />} />
            <PreviewStat label="Output" value={formatUnknown(usage.counters.outputTokens)} icon={<Braces size={15} />} />
            <PreviewStat label="Cache read" value={formatUnknown(usage.counters.cacheReadInputTokens)} icon={<Braces size={15} />} />
            <PreviewStat label="Reasoning" value={formatUnknown(usage.counters.reasoningTokens)} icon={<Braces size={15} />} />
          </div>
          <PreviewSection title="Observation provenance" subtitle={`Sequence ${usage.sequence} · observed ${formatTime(usage.observedAtMs)}`}>
            <div className="inspector-preview-list">
              <PreviewRow label="Source" value={usage.source.replaceAll("-", " ")} detail={usage.authoritative ? "Marked authoritative" : "Non-authoritative"} tone={usage.authoritative ? "reported" : "unknown"} />
              <PreviewRow label="Coverage" value={usage.coverage} detail="Native payload coverage" />
              <PreviewRow label="Visible output" value={formatUnknown(usage.counters.visibleOutputTokens)} detail="Hidden reasoning is never exposed" />
              <PreviewRow label="Cost statement" value={usage.costStatementCount ? `${usage.costStatementCount} present` : "No native statement"} detail="Final or invoice cost is not estimated" tone={usage.costStatementCount ? "reported" : "unknown"} />
            </div>
          </PreviewSection>
        </>
      )}
    </>
  );
}

function TimingPanel({ telemetry, runId, nativeEvidenceAvailable }: { telemetry: RunTelemetrySnapshot | null; runId: string | null; nativeEvidenceAvailable: boolean }) {
  const timing = latestTiming(telemetry);
  const marks = timing
    ? Object.entries(timing.marks).filter(([, value]) => value !== null)
    : [];
  const waits = timing ? Object.entries(timing.waits) : [];
  return (
    <>
      <PreviewHeader
        eyebrow="Latency evidence"
        title="Timing"
        description="Only observed marks are shown. Missing marks remain unknown instead of being converted to zero."
        status={timing ? "reported" : "unknown"}
      />
      {!timing ? (
        <PreviewEmpty title="Timing not captured" detail={runId ? nativeEvidenceAvailable ? "The run has no timing observation yet." : "Browser preview runs do not produce native timing observations." : "Timing will appear after a provider run is recorded."} />
      ) : (
        <>
          <PreviewSection title="Observed marks" subtitle={`${timing.coverage} coverage · captured ${formatTime(timing.observedAtMs)}`}>
            <div className="inspector-preview-list">
              {marks.map(([key, value]) => (
                <PreviewRow key={key} label={key.replace(/([A-Z])/g, " $1")} value={formatTime(value)} />
              ))}
              {marks.length === 0 ? <p className="inspector-muted-copy">No timing marks are available.</p> : null}
            </div>
          </PreviewSection>
          <PreviewSection title="Wait buckets" subtitle="Queueing and backpressure are separate from provider latency">
            <div className="inspector-preview-list">
              {waits.map(([key, value]) => (
                <PreviewRow key={key} label={key.replace(/([A-Z])/g, " $1")} value={value === null ? "Unknown" : `${value.toLocaleString()} ms`} />
              ))}
            </div>
          </PreviewSection>
        </>
      )}
    </>
  );
}

function ProviderHealthPanel({ providers }: { providers: ReturnType<typeof useWorkspaceStore.getState>["providers"] }) {
  return (
    <>
      <PreviewHeader eyebrow="Routing surface" title="Provider health" description="Connection state is a reported profile value, not a synthetic health score." status={providers.length ? "reported" : "unknown"} />
      {providers.length === 0 ? (
        <PreviewEmpty title="No provider profiles" detail="Connect a provider to inspect its reported state and model catalog." />
      ) : (
        <div className="inspector-preview-card-list">
          {providers.map((provider) => (
            <article className="inspector-preview-provider" key={provider.id}>
              <div className="inspector-preview-event__title">
                <div>
                  <strong>{provider.name}</strong>
                  <small>{provider.kind} · {provider.modelCount.toLocaleString()} models</small>
                </div>
                <PreviewBadge tone={provider.source === "native" && provider.state === "connected" ? "reported" : provider.state === "error" ? "warning" : "unknown"}>{providerStateLabel(provider)}</PreviewBadge>
              </div>
              <div className="inspector-preview-list">
                <PreviewRow label="Latency" value={provider.latencyMs === null ? "Unknown" : `${provider.latencyMs.toLocaleString()} ms`} detail="Last reported check" />
                <PreviewRow label="Credentials" value={formatState(provider.credentialState)} detail={provider.lastCheckedAt ? `Checked ${formatIsoTime(provider.lastCheckedAt)}` : "Never checked"} />
                {provider.errorMessage ? <PreviewRow label="Diagnostic" value={provider.errorMessage} tone="warning" /> : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

function AgentsToolsPanel({ skills, receiptCount }: { skills: SkillView[]; receiptCount: number }) {
  const enabledSkills = skills.filter((skill) => skill.enabled);
  return (
    <>
      <PreviewHeader eyebrow="Capability surface" title="Agents & tools" description="Skills and native tool receipts are shown as separate evidence tracks; autonomous execution is not claimed here." status={enabledSkills.length || receiptCount ? "reported" : "planned"} />
      <PreviewSection title="Skills" subtitle={`${enabledSkills.length} enabled · ${skills.length} catalogued`}>
        {skills.length === 0 ? (
          <PreviewEmpty title="No skills catalogued" detail="Skill hydration is not available in this preview." />
        ) : (
          <div className="inspector-preview-card-list">
            {skills.slice(0, 8).map((skill) => (
              <article className="inspector-preview-skill" key={skill.id}>
                <span className="inspector-preview-skill__icon">{skill.icon || "◇"}</span>
                <div>
                  <strong>{skill.name}</strong>
                  <small>{skill.source} · {skill.scope} · {skill.enabled ? "enabled" : "disabled"}</small>
                </div>
                <PreviewBadge tone={skill.enabled ? "reported" : "neutral"}>{skill.enabled ? "On" : "Off"}</PreviewBadge>
              </article>
            ))}
          </div>
        )}
      </PreviewSection>
      <PreviewSection title="Native tools" subtitle="Receipt-backed evidence only">
        <div className="inspector-preview-list">
          <PreviewRow label="Run-control receipts" value={receiptCount.toLocaleString()} detail={receiptCount ? "Linked to the current Chat" : "No receipt linked"} />
          <PreviewRow label="Autonomous tool execution" value="Planned" detail="Requires a complete native capability and permission path" tone="planned" />
          <PreviewRow label="Subagent graph" value="Planned" detail="Agent lineage is not synthesized from UI state" tone="planned" />
        </div>
      </PreviewSection>
    </>
  );
}

function ArtifactsPanel({ artifacts, projectName }: { artifacts: ArtifactView[]; projectName: string | null }) {
  const visible = projectName ? artifacts.filter((artifact) => artifact.projectName === projectName) : artifacts;
  return (
    <>
      <PreviewHeader eyebrow="Output library" title="Artifacts" description="Artifacts are renderer catalog entries; opening and exporting remain separate actions." status={visible.length ? "reported" : "unknown"} />
      {visible.length === 0 ? (
        <PreviewEmpty title="No linked artifacts" detail="Generated files and durable revisions are not linked to this Chat yet." />
      ) : (
        <div className="inspector-preview-card-list">
          {visible.map((artifact) => (
            <article className="inspector-preview-artifact" key={artifact.id}>
              <span className="inspector-preview-artifact__icon"><FileText size={15} /></span>
              <div>
                <strong>{artifact.name}</strong>
                <small>{artifact.type} · {artifact.sizeLabel} · {artifact.versionCount} version{artifact.versionCount === 1 ? "" : "s"}</small>
              </div>
              <span className="inspector-preview-artifact__time">{artifact.updatedLabel}</span>
            </article>
          ))}
        </div>
      )}
      <div className="inspector-preview-note"><Wrench size={14} /><span>Artifact preview and export actions remain planned until a durable native artifact bridge is available.</span></div>
    </>
  );
}

function ReceiptsPanel({ operations, checkpoints, runId, nativeEvidenceAvailable }: { operations: RunControlOperationProjection[]; checkpoints: ReturnType<typeof useWorkspaceStore.getState>["checkpointsByRunId"]; runId: string | null; nativeEvidenceAvailable: boolean }) {
  const checkpointEntries = runId ? Object.values(checkpoints).filter((projection) => projection.checkpoint.runId === runId) : [];
  return (
    <>
      <PreviewHeader eyebrow="Durability evidence" title="Receipts" description="Receipts are read-only native projections. A UI click is never presented as a successful native operation." status={operations.length || checkpointEntries.length ? "reported" : "unknown"} />
      {operations.length === 0 && checkpointEntries.length === 0 ? (
        <PreviewEmpty title="No receipts linked" detail={runId ? nativeEvidenceAvailable ? "This run has no native control or checkpoint receipt yet." : "Browser preview runs do not create native control or checkpoint receipts." : "Receipts appear after native run-control activity."} />
      ) : (
        <div className="inspector-preview-card-list">
          {operations.map((projection) => (
            <article className="inspector-preview-receipt" key={projection.operation.operationId}>
              <div className="inspector-preview-event__title">
                <div><strong>{formatState(projection.operation.kind)}</strong><small>{projection.operation.operationId}</small></div>
                <PreviewBadge tone={projection.status === "applied" || projection.status === "already-applied" ? "reported" : projection.status === "blocked" || projection.status === "failed" ? "warning" : "unknown"}>{formatState(projection.status)}</PreviewBadge>
              </div>
              <div className="inspector-preview-list">
                <PreviewRow label="Durability" value={projection.durability} detail={projection.operation.receiptId ?? "No receipt ID"} />
                <PreviewRow label="State revision" value={projection.stateRevisionId ?? "Unknown"} detail={projection.operation.stateBase.resolutionReason} />
                <PreviewRow label="Result" value={projection.resultRunId ?? "No result run"} detail={projection.diagnostic ?? projection.blockedReason ?? "No diagnostic"} />
              </div>
            </article>
          ))}
          {checkpointEntries.map((projection) => (
            <article className="inspector-preview-receipt" key={projection.checkpoint.checkpointId}>
              <div className="inspector-preview-event__title">
                <div><strong>Checkpoint</strong><small>{projection.checkpoint.checkpointId}</small></div>
                <PreviewBadge tone={projection.resumable ? "reported" : "unknown"}>{formatState(projection.checkpoint.status)}</PreviewBadge>
              </div>
              <PreviewRow label="Resume" value={projection.resumable ? "Available" : "Unavailable"} detail={projection.warning ?? "Native evidence is sufficient"} tone={projection.resumable ? "reported" : "unknown"} />
            </article>
          ))}
        </div>
      )}
      <div className="inspector-preview-note"><History size={14} /><span>Receipt reconciliation, checkpoint recovery, and export remain native-boundary work.</span></div>
    </>
  );
}

export function InspectorPreview({ runId, runState, activeRun, observedRunId, nativeEvidenceAvailable = false }: { runId: string | null; runState: string | null; activeRun: ActiveRunView | null; observedRunId?: string | null; nativeEvidenceAvailable?: boolean }) {
  const [view, setView] = useState<InspectorPreviewView>("overview");
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const conversation = useWorkspaceStore((state) => state.conversations.find((item) => item.id === activeConversationId));
  const project = useWorkspaceStore((state) => state.projects.find((item) => item.id === conversation?.projectId));
  const providers = useWorkspaceStore((state) => state.providers);
  const artifacts = useWorkspaceStore((state) => state.artifacts);
  const skills = useWorkspaceStore((state) => state.skills);
  const telemetryByRunId = useWorkspaceStore((state) => state.runTelemetryByRunId);
  const timelineEvents = useWorkspaceStore((state) => state.runTimelineEvents);
  const runControlOperations = useWorkspaceStore((state) => state.runControlOperationsById);
  const checkpoints = useWorkspaceStore((state) => state.checkpointsByRunId);
  const selectedRunId = observedRunId ?? runId;
  const telemetry = selectedRunId ? telemetryByRunId[selectedRunId] ?? null : null;
  const events = useMemo(
    () => (selectedRunId ? timelineEvents.filter((event) => event.runId === selectedRunId).sort((left, right) => left.sequence - right.sequence) : []),
    [selectedRunId, timelineEvents],
  );
  const operations = useMemo(
    () => Object.values(runControlOperations).filter((projection) => {
      if (projection.operation.conversationId !== activeConversationId) return false;
      if (!selectedRunId) return true;
      return projection.operation.sourceRunId === selectedRunId || projection.resultRunId === selectedRunId;
    }),
    [activeConversationId, runControlOperations, selectedRunId],
  );

  const selectAdjacentPreviewTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? previewTabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + previewTabs.length) % previewTabs.length;
    const nextTab = previewTabs[nextIndex]!;
    setView(nextTab.id);
    document.getElementById(`inspector-preview-tab-${nextTab.id}`)?.focus();
  };

  return (
    <section className="inspector-preview" data-testid="inspector-preview">
      <div className="inspector-preview-nav" role="tablist" aria-label="Run evidence preview">
        {previewTabs.map(({ id, label, icon: Icon }, index) => (
          <button
            key={id}
            id={`inspector-preview-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={view === id}
            aria-controls={`inspector-preview-panel-${id}`}
            tabIndex={view === id ? 0 : -1}
            className={view === id ? "inspector-preview-tab inspector-preview-tab--active" : "inspector-preview-tab"}
            title={`Show ${label.toLowerCase()} inspector preview`}
            onClick={() => setView(id)}
            onKeyDown={(event) => selectAdjacentPreviewTab(event, index)}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>
      <div
        className="inspector-preview-panel"
        id={`inspector-preview-panel-${view}`}
        role="tabpanel"
        aria-labelledby={`inspector-preview-tab-${view}`}
        tabIndex={0}
      >
        {view === "overview" ? <OverviewPanel conversation={conversation} project={project} runId={selectedRunId} activeRun={activeRun} runState={runState} events={events} providers={providers} artifacts={artifacts} skills={skills} nativeEvidenceAvailable={nativeEvidenceAvailable} /> : null}
        {view === "timeline" ? <TimelinePanel events={events} runId={selectedRunId} nativeEvidenceAvailable={nativeEvidenceAvailable} /> : null}
        {view === "attempts" ? <AttemptsPanel telemetry={telemetry} runId={selectedRunId} nativeEvidenceAvailable={nativeEvidenceAvailable} /> : null}
        {view === "usage" ? <UsagePanel telemetry={telemetry} runId={selectedRunId} nativeEvidenceAvailable={nativeEvidenceAvailable} /> : null}
        {view === "timing" ? <TimingPanel telemetry={telemetry} runId={selectedRunId} nativeEvidenceAvailable={nativeEvidenceAvailable} /> : null}
        {view === "provider-health" ? <ProviderHealthPanel providers={providers} /> : null}
        {view === "agents-tools" ? <AgentsToolsPanel skills={skills} receiptCount={operations.length} /> : null}
        {view === "artifacts" ? <ArtifactsPanel artifacts={artifacts} projectName={project?.name ?? null} /> : null}
        {view === "receipts" ? <ReceiptsPanel operations={operations} checkpoints={checkpoints} runId={selectedRunId} nativeEvidenceAvailable={nativeEvidenceAvailable} /> : null}
      </div>
    </section>
  );
}
