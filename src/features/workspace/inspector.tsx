import {
  AlertTriangle,
  Braces,
  Check,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  FileSearch,
  FileText,
  FolderOpen,
  Gauge,
  History,
  Info,
  PanelRightClose,
  RotateCcw,
  ShieldCheck,
  Timer,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { ProductIcon } from "@/components/product-icons";

import { usePanelDrawerFocus } from "@/components/panel-drawer";

import {
  focusCitationReturnTarget,
  useCitationSelectionStore,
} from "./citation-selection-store";
import { RunTimeline, SourcesInspector } from "./citation-timeline";
import { MultimodalBridgeInspector } from "./multimodal-bridge-inspector";
import { ContextAnswerReceipt } from "./context-answer-receipt";
import { ContextMemorySkillReceipt } from "./context-memory-skill-receipt";
import { ContextRunEvidenceCard } from "./context-run-evidence";
import { buildProjectContextAvailabilityForProject } from "./project-context-availability-contract";
import { InspectorPreview } from "./inspector-preview";
import { useNarrowPanelViewport } from "./panel-layout";
import { ParameterHistoryControls } from "./parameter-history";
import { WorkbenchDeck } from "./workbench-deck";
import { ProfilePresetsWorkbench } from "./profile-presets-workbench";
import { selectableModelProfiles } from "./provider-catalog";
import {
  preflightProviderParameters,
  resolveRoutedProviderModel,
  supportsProviderParameter,
} from "./provider-parameters";
import { useWorkspaceStore } from "./store";
import type { InspectorTab } from "./types";
import type {
  ProviderAttemptLineageReceipt,
  RendererUsageObservation,
  RunTelemetrySnapshot,
} from "@/lib/desktop";
import { desktop, isDesktopRuntime } from "@/lib/desktop";
import type { RunControlOperationProjection } from "./run-control-projection";

const tabs: Array<{ id: InspectorTab; label: string }> = [
  { id: "context", label: "Context" },
  { id: "run", label: "Run" },
  { id: "parameters", label: "Controls" },
];

function formatCounter(value: number | null | undefined): string {
  return value === null || value === undefined ? "Unknown" : value.toLocaleString();
}

function latestUsageObservation(snapshot: RunTelemetrySnapshot | null): RendererUsageObservation | null {
  const attempt = snapshot?.attempts[snapshot.attempts.length - 1];
  if (!attempt || attempt.usageLedger.length === 0) return null;
  const sourceRank: Record<RendererUsageObservation["source"], number> = {
    "user-correction": 5,
    "provider-invoice": 4,
    "provider-final": 3,
    "provider-incremental": 2,
    "local-estimate": 1,
  };
  const hasCounters = (observation: RendererUsageObservation): boolean =>
    Object.values(observation.counters).some((value) => typeof value === "number" && Number.isFinite(value));
  // An invoice may be authoritative for billing while carrying no token
  // counters. Keep the most recent usable counter observation visible rather
  // than replacing it with a cost-only row.
  const usable = attempt.usageLedger.filter(hasCounters);
  const candidates = usable.length > 0 ? usable : attempt.usageLedger;
  return [...candidates].sort((left, right) =>
    right.sequence - left.sequence || sourceRank[right.source] - sourceRank[left.source],
  )[0] ?? null;
}

function formatObservedTime(timestampMs: number | null | undefined): string | null {
  if (timestampMs === null || timestampMs === undefined) return null;
  return new Date(timestampMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatReceiptTime(timestamp: string | null | undefined): string {
  if (!timestamp) return "Unknown";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatReceiptIdentifier(value: string | null | undefined, fallback = "Unknown"): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function formatRunControlKind(kind: RunControlOperationProjection["operation"]["kind"]): string {
  return kind.replaceAll("-", " ");
}

function formatRunControlStatus(status: RunControlOperationProjection["status"]): string {
  return status.replaceAll("-", " ");
}

function NativeRunControlReceipts({
  operations,
}: {
  operations: RunControlOperationProjection[];
}) {
  return (
    <section className="inspector-section run-control-card" data-testid="run-control-receipts">
      <header>
        <div>
          <span className="inspector-section__icon inspector-section__icon--blue">
            <History size={15} />
          </span>
          <span>
            <strong>Run-control receipts</strong>
            <small>Native resolution and apply evidence</small>
          </span>
        </div>
        <span className="run-control-card__count" aria-label={`${operations.length} run-control receipts`}>
          {operations.length}
        </span>
      </header>
      {operations.length === 0 ? (
        <p className="inspector-muted-copy">
          No native pause, resume, continue, retry, or checkpoint receipt is linked to this run yet.
        </p>
      ) : (
        <div className="run-control-list">
          {operations.map((projection) => {
            const operation = projection.operation;
            const result = operation.result;
            return (
              <article
                className="run-control-operation"
                data-testid={`run-control-operation-${operation.operationId}`}
                key={operation.operationId}
              >
                <div className="run-control-operation__header">
                  <strong>{formatRunControlKind(operation.kind)}</strong>
                  <span className={`run-control-status run-control-status--${projection.status}`}>
                    {formatRunControlStatus(projection.status)}
                  </span>
                </div>
                <p className="run-control-operation__id">Operation {operation.operationId}</p>
                <dl className="run-control-operation__facts">
                  <div>
                    <dt>Receipt</dt>
                    <dd>{formatReceiptIdentifier(operation.receiptId)}</dd>
                  </div>
                  <div>
                    <dt>Durability</dt>
                    <dd>{projection.durability}</dd>
                  </div>
                  <div>
                    <dt>State base</dt>
                    <dd>{operation.stateBase.mode}</dd>
                  </div>
                  <div>
                    <dt>State revision</dt>
                    <dd>{projection.stateRevisionId ?? operation.stateBase.resolvedStateRevisionId ?? "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>Resolution</dt>
                    <dd>{operation.stateBase.resolutionReason}</dd>
                  </div>
                  <div>
                    <dt>Checkpoint</dt>
                    <dd>{formatReceiptIdentifier(projection.checkpointId ?? result?.resultCheckpointId, "None recorded")}</dd>
                  </div>
                  <div>
                    <dt>Result run</dt>
                    <dd>{formatReceiptIdentifier(projection.resultRunId ?? result?.resultRunId, "None recorded")}</dd>
                  </div>
                  <div>
                    <dt>Result attempt</dt>
                    <dd>{formatReceiptIdentifier(projection.resultAttemptId ?? result?.resultAttemptId, "None recorded")}</dd>
                  </div>
                  <div>
                    <dt>Diagnostic ID</dt>
                    <dd>{formatReceiptIdentifier(result?.diagnosticId, "None recorded")}</dd>
                  </div>
                  <div>
                    <dt>Cursors</dt>
                    <dd>{operation.stateBase.resolvedAtCursors.length.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{formatReceiptTime(operation.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Resolved</dt>
                    <dd>{formatReceiptTime(operation.stateBase.resolvedAt)}</dd>
                  </div>
                </dl>
                {projection.blockedReason ? <p className="run-control-operation__diagnostic">Blocked: {projection.blockedReason}</p> : null}
                {projection.diagnostic ? <p className="run-control-operation__diagnostic">Diagnostic: {projection.diagnostic}</p> : null}
              </article>
            );
          })}
        </div>
      )}
      <p className="inspector-muted-copy run-control-card__notice">
        These are read-only native projections. Controls remain unavailable until a complete native receipt and reconciliation path exists.
      </p>
    </section>
  );
}

function ContextInspector() {
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const conversation = useWorkspaceStore((state) =>
    state.conversations.find((item) => item.id === activeConversationId),
  );
  const project = useWorkspaceStore((state) =>
    state.projects.find((item) => item.id === conversation?.projectId),
  );
  const contextAvailability = project ? buildProjectContextAvailabilityForProject(project) : null;
  const memories = useWorkspaceStore((state) => state.memories);
  const skills = useWorkspaceStore((state) => state.skills);
  const citations = useWorkspaceStore((state) => state.citations);
  const latestAssistant = [...(conversation?.messages ?? [])]
    .reverse()
    .find((message) => message.role === "assistant");
  return (
    <div className="inspector-scroll" tabIndex={0}>
      <section className="context-meter-card">
        <div className="context-meter-card__header">
          <div>
            <span className="eyebrow">Context compiler</span>
            <strong>Not compiled in this preview</strong>
          </div>
          <span className="context-percent">Planned</span>
        </div>
        <div
          className="context-meter"
          role="progressbar"
          aria-label="Context compiler not available"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
        >
          <span style={{ width: "0%" }} />
        </div>
        <p>Retrieval, token budgeting, omission reasons, and frozen context snapshots are not wired yet.</p>
        <button type="button" className="button button--secondary button--full" disabled>
          <FileSearch size={15} />
          Exact context preview planned
        </button>
      </section>

      <ContextRunEvidenceCard
        surface="context"
        project={project}
        conversationId={conversation?.id ?? null}
        memories={memories}
        skills={skills}
        contextAvailability={contextAvailability}
        contextRevisionId={project?.overview?.contextRevisionId ?? null}
      />

      <ContextAnswerReceipt
        citations={citations}
        messageId={latestAssistant?.id ?? null}
        runId={latestAssistant?.runId ?? null}
      />

      <ContextMemorySkillReceipt
        project={project}
        memories={memories}
        skills={skills}
        messageId={latestAssistant?.id ?? null}
        runId={latestAssistant?.runId ?? null}
        contextRevisionId={project?.overview?.contextRevisionId ?? null}
      />

      <WorkbenchDeck />

      <section className="inspector-section">
        <header>
          <div>
            <span className="inspector-section__icon inspector-section__icon--violet">
              <ShieldCheck size={15} />
            </span>
            <span>
              <strong>Instructions</strong>
              <small>Configured sources · inclusion not yet compiled</small>
            </span>
          </div>
          <ChevronDown size={15} />
        </header>
        <div className="context-source-list">
          <article>
            <span className="source-order">1</span>
            <div>
              <strong>Native policy boundary</strong>
              <p>Core capability and provider security checks are active</p>
            </div>
            <Check size={14} className="success-icon" />
          </article>
          {project ? (
            <article>
              <span className="source-order">2</span>
              <div>
                <strong>{project.name} instructions</strong>
                <p>{project.instructions}</p>
              </div>
              <button type="button" aria-label="Project instruction controls are planned" disabled>
                <X size={13} />
              </button>
            </article>
          ) : null}
        </div>
      </section>

      <section className="inspector-section">
        <header>
          <div>
            <span className="inspector-section__icon inspector-section__icon--blue">
              <History size={15} />
            </span>
            <span>
              <strong>Conversation</strong>
              <small>{conversation?.messages.length ?? 0} in-session messages available</small>
            </span>
          </div>
          <span className="token-badge">Not compiled</span>
        </header>
        <p className="inspector-muted-copy">The live text adapter currently forwards this session history. Durable branching, compaction, and omission audit are planned.</p>
      </section>

      <section className="inspector-section">
        <header>
          <div>
            <span className="inspector-section__icon inspector-section__icon--amber">
              <FolderOpen size={15} />
            </span>
            <span>
              <strong>Project sources</strong>
              <small>{project?.folders.length ?? 0} workspace folders</small>
            </span>
          </div>
          <span className="token-badge">Not retrieved</span>
        </header>
        {project?.folders.map((folder) => (
          <article className="source-file-row" key={folder.id}>
            <FileText size={15} />
            <span>
              <strong>{folder.displayName}</strong>
              <small>
                {folder.fileCount === null ? "Read-only grant · not indexed" : `${folder.fileCount} files · read-only`}
              </small>
            </span>
            <Info size={14} />
          </article>
        ))}
        {project?.folders.length === 0 ? <p className="inspector-muted-copy">No workspace sources selected.</p> : null}
      </section>

      <section className="inspector-section inspector-section--split">
        <header>
          <div>
            <span className="inspector-section__icon inspector-section__icon--green">
              <ProductIcon name="memory" size={15} />
            </span>
            <span>
              <strong>Memory</strong>
              <small>Not enabled</small>
            </span>
          </div>
          <span className="token-badge">Planned</span>
        </header>
        <header>
          <div>
            <span className="inspector-section__icon inspector-section__icon--violet">
              <ProductIcon name="skill" size={15} />
            </span>
            <span>
              <strong>Skills</strong>
              <small>Not enabled</small>
            </span>
          </div>
          <span className="token-badge">Planned</span>
        </header>
      </section>

      <div className="inspector-notice">
        <Info size={15} />
        <p>
          Workspace folders are read-only grants only. They are not indexed or injected into provider requests in this preview.
        </p>
      </div>
    </div>
  );
}

function RunInspector() {
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const project = useWorkspaceStore((state) => {
    const conversation = state.conversations.find((item) => item.id === state.activeConversationId);
    return state.projects.find((item) => item.id === conversation?.projectId);
  });
  const contextAvailability = project ? buildProjectContextAvailabilityForProject(project) : null;
  const memories = useWorkspaceStore((state) => state.memories);
  const skills = useWorkspaceStore((state) => state.skills);
  const citations = useWorkspaceStore((state) => state.citations);
  const activeBranchId = useWorkspaceStore((state) =>
    state.conversations.find((conversation) => conversation.id === activeConversationId)?.activeBranchId ?? null,
  );
  const runControlOperations = useWorkspaceStore((state) => state.runControlOperationsById);
  const activeRun = useWorkspaceStore((state) =>
    state.activeRun?.conversationId === state.activeConversationId ? state.activeRun : null,
  );
  const latestMessage = useWorkspaceStore((state) => {
    const conversation = state.conversations.find((item) => item.id === activeConversationId);
    return [...(conversation?.messages ?? [])].reverse().find((message) => message.role === "assistant");
  });
  const observedRunId = activeRun?.id ?? latestMessage?.runId ?? null;
  const telemetrySnapshot = useWorkspaceStore((state) =>
    observedRunId ? state.runTelemetryByRunId[observedRunId] ?? null : null,
  );
  const bridgePlan = useWorkspaceStore((state) =>
    observedRunId ? state.multimodalBridgePlansByRunId[observedRunId] ?? null : null,
  );
  const observedAttempt = telemetrySnapshot?.attempts[telemetrySnapshot.attempts.length - 1] ?? null;
  const observedAttemptId = observedAttempt?.attemptId ?? null;
  const lineageKey = isDesktopRuntime() && activeConversationId && activeBranchId && observedRunId && observedAttemptId
    ? `${activeConversationId}:${activeBranchId}:${observedRunId}:${observedAttemptId}`
    : null;
  const [lineageRead, setLineageRead] = useState<{
    key: string;
    status: "loading" | "ready" | "unavailable";
    receipt: ProviderAttemptLineageReceipt | null;
  } | null>(null);
  useEffect(() => {
    if (!lineageKey || !activeConversationId || !activeBranchId || !observedRunId || !observedAttemptId) return;
    let cancelled = false;
    setLineageRead({ key: lineageKey, status: "loading", receipt: null });
    void desktop.readProviderAttemptLineage({
      conversationId: activeConversationId,
      branchId: activeBranchId,
      runId: observedRunId,
      attemptId: observedAttemptId,
    }).then((receipt) => {
      if (!cancelled) setLineageRead({ key: lineageKey, status: "ready", receipt });
    }).catch(() => {
      if (!cancelled) setLineageRead({ key: lineageKey, status: "unavailable", receipt: null });
    });
    return () => { cancelled = true; };
  }, [activeBranchId, activeConversationId, lineageKey, observedAttemptId, observedRunId]);
  const visibleLineage = lineageRead?.key === lineageKey ? lineageRead : null;
  const latestUsage = latestUsageObservation(telemetrySnapshot);
  const timelineEvents = useWorkspaceStore((state) => state.runTimelineEvents);
  const runJournalCoverage = useWorkspaceStore((state) => state.runJournalCoverage);
  const persistedEvents = useMemo(
    () =>
      observedRunId
        ? timelineEvents.filter((event) => event.runId === observedRunId)
        : [],
    [observedRunId, timelineEvents],
  );
  const runState = observedAttempt?.state ?? activeRun?.stage ?? latestMessage?.status ?? null;
  const observedJournalCoverage = observedRunId ? runJournalCoverage[observedRunId] : undefined;
  const nativeStartedAt = formatObservedTime(observedAttempt?.startedAtMs);
  const relevantRunControlOperations = useMemo(
    () =>
      Object.values(runControlOperations)
        .filter((projection) => {
          const operation = projection.operation;
          if (operation.conversationId !== activeConversationId) return false;
          if (activeBranchId && operation.branchId !== activeBranchId) return false;
          if (!observedRunId) return true;
          return operation.sourceRunId === observedRunId || operation.result?.resultRunId === observedRunId;
        })
        .sort((left, right) => right.operation.createdAt.localeCompare(left.operation.createdAt)),
    [activeBranchId, activeConversationId, observedRunId, runControlOperations],
  );
  const hasNativeRunEvidence = isDesktopRuntime() && Boolean(
    telemetrySnapshot ||
      persistedEvents.length > 0 ||
      relevantRunControlOperations.length > 0 ||
      observedJournalCoverage,
  );
  const rendererRunLabel = isDesktopRuntime() ? "Renderer observed run" : "Renderer preview run";

  if (!observedRunId) {
    return (
      <div className="inspector-scroll" tabIndex={0}>
        <section className="run-hero">
          <span className="run-hero__glyph">
            <Gauge size={21} />
          </span>
          <div>
            <span className="eyebrow">Run inspector</span>
            <h3>No model run yet</h3>
            <p>{isDesktopRuntime() ? "Send a message after connecting a provider to inspect the live run state." : "Send a message to create a renderer preview run; provider dispatch is not used in this browser surface."}</p>
          </div>
        </section>
        <div className="inspector-notice">
          <Info size={15} />
          <p>
            Native run-journal replay is available after a native run. This preview run has no native telemetry snapshot; missing values are not treated as zero.
          </p>
        </div>
        <InspectorPreview runId={null} observedRunId={null} runState={null} activeRun={null} nativeEvidenceAvailable={false} />
      </div>
    );
  }

  return (
    <div className="inspector-scroll" tabIndex={0}>
      <section className="run-hero">
        <span className={activeRun ? "run-hero__glyph run-hero__glyph--active" : "run-hero__glyph"}>
          <Gauge size={21} />
        </span>
        <div>
          <span className="eyebrow">Latest model run</span>
          <h3>{activeRun ? (hasNativeRunEvidence ? "Running now" : rendererRunLabel) : hasNativeRunEvidence ? "Latest stored projection" : "Renderer run projection"}</h3>
          <p>{runState ? String(runState).replaceAll("-", " ") : "State unavailable"}</p>
        </div>
      </section>
      <InspectorPreview
        runId={observedRunId}
        observedRunId={observedRunId}
        runState={runState ? String(runState) : null}
        activeRun={activeRun}
        nativeEvidenceAvailable={hasNativeRunEvidence}
      />
      <div className="run-stat-grid">
        <article>
          <Timer size={15} />
          <span>Started</span>
          <strong>{nativeStartedAt ?? (activeRun ? "Renderer observed" : "Not captured natively")}</strong>
        </article>
        <article>
          <Clock3 size={15} />
          <span>Lifecycle</span>
          <strong>{activeRun ? "In progress" : "Stored projection"}</strong>
        </article>
        <article>
          <Braces size={15} />
          <span>Tokens</span>
          <strong>
            {latestUsage
              ? `${formatCounter(latestUsage.counters.inputTokens)} in · ${formatCounter(latestUsage.counters.outputTokens)} out`
              : "Not reported"}
          </strong>
        </article>
        <article>
          <CircleDollarSign size={15} />
          <span>Cost</span>
          <strong>{latestUsage?.costStatementCount ? "Statement present" : "No native statement"}</strong>
        </article>
      </div>
      <section className="inspector-section run-route-card">
        <span className="eyebrow">{hasNativeRunEvidence ? "Observed renderer state" : "Renderer preview state"}</span>
        <h3>{observedAttempt?.modelId ?? latestMessage?.modelLabel ?? "Route details unavailable"}</h3>
        <p>Run ID: {observedRunId}</p>
        {observedAttempt?.providerProfileId ? <p>Provider profile: {observedAttempt.providerProfileId}</p> : null}
      </section>
      <section className="inspector-section run-lineage-card" data-testid="provider-attempt-lineage">
        <span className="eyebrow">Frozen provider attempt</span>
        <h3>Preparation provenance</h3>
        {visibleLineage?.status === "ready" && visibleLineage.receipt ? (
          <>
            <dl className="run-lineage-card__facts">
              <div><dt>Attempt</dt><dd>{visibleLineage.receipt.attemptId}</dd></div>
              <div><dt>Input</dt><dd>{visibleLineage.receipt.frozenProviderInputId}</dd></div>
              <div><dt>Model</dt><dd>{visibleLineage.receipt.modelId}</dd></div>
              <div><dt>Adapter revision</dt><dd>{visibleLineage.receipt.adapterRevision}</dd></div>
              <div><dt>Requested / effective effort</dt><dd>{visibleLineage.receipt.requestedEffort ?? "Unknown"} / {visibleLineage.receipt.effectiveEffort ?? "Unknown"}</dd></div>
              <div><dt>Definition SHA-256</dt><dd>{visibleLineage.receipt.providerDefinitionSha256}</dd></div>
              <div><dt>Endpoint fingerprint</dt><dd>{visibleLineage.receipt.endpointFingerprintSha256}</dd></div>
              <div><dt>Parameters SHA-256</dt><dd>{visibleLineage.receipt.resolvedParametersSha256}</dd></div>
            </dl>
            <p className="inspector-muted-copy">Historical native receipt only. This does not prove the current provider configuration is dispatchable or grant authority to retry.</p>
          </>
        ) : (
          <p className="inspector-muted-copy">
            {visibleLineage?.status === "loading"
              ? "Reading the exact native attempt…"
              : visibleLineage?.status === "unavailable"
                ? "Native attempt lineage unavailable for this run. No current provider values are substituted."
                : isDesktopRuntime()
                  ? "An exact native run and attempt must be observed before lineage can be read."
                  : "Browser preview has no native provider-attempt lineage."}
          </p>
        )}
      </section>
      <ContextRunEvidenceCard
        surface="run"
        project={project}
        conversationId={activeConversationId}
        runId={observedRunId}
        memories={memories}
        skills={skills}
        contextAvailability={contextAvailability}
        contextRevisionId={project?.overview?.contextRevisionId ?? null}
      />
      <ContextAnswerReceipt
        citations={citations}
        messageId={latestMessage?.id ?? null}
        runId={latestMessage?.runId ?? observedRunId}
      />
      <ContextMemorySkillReceipt
        project={project}
        memories={memories}
        skills={skills}
        messageId={latestMessage?.id ?? null}
        runId={latestMessage?.runId ?? observedRunId}
        contextRevisionId={project?.overview?.contextRevisionId ?? null}
        surface="run"
      />
      <NativeRunControlReceipts operations={relevantRunControlOperations} />
      {bridgePlan ? <MultimodalBridgeInspector projection={bridgePlan} active={activeRun !== null} /> : null}
      <section className="inspector-section run-usage-card" data-testid="run-usage-observation">
        <span className="eyebrow">{hasNativeRunEvidence ? "Native usage observation" : "Renderer usage boundary"}</span>
        {latestUsage ? (
          <>
            <h3>{latestUsage.source === "provider-incremental" ? "Provider stream usage" : "Usage observation"}</h3>
            <p>
              {latestUsage.source} · {latestUsage.coverage} · {latestUsage.authoritative ? "authoritative" : "non-authoritative"} · sequence {latestUsage.sequence}
            </p>
            <div className="run-stat-grid">
              <article>
                <Braces size={15} />
                <span>Input</span>
                <strong>{formatCounter(latestUsage.counters.inputTokens)}</strong>
              </article>
              <article>
                <Braces size={15} />
                <span>Cache read</span>
                <strong>{formatCounter(latestUsage.counters.cacheReadInputTokens)}</strong>
              </article>
              <article>
                <Braces size={15} />
                <span>Output</span>
                <strong>{formatCounter(latestUsage.counters.outputTokens)}</strong>
              </article>
              <article>
                <Braces size={15} />
                <span>Reasoning tokens</span>
                <strong>{formatCounter(latestUsage.counters.reasoningTokens)}</strong>
              </article>
            </div>
            <p className="inspector-muted-copy">
              Cache write and visible-output counters remain {formatCounter(latestUsage.counters.cacheWriteInputTokens).toLowerCase()} / {formatCounter(latestUsage.counters.visibleOutputTokens).toLowerCase()}; no hidden chain-of-thought is exposed.
            </p>
          </>
        ) : (
            <p className="inspector-muted-copy">{hasNativeRunEvidence ? "No native usage observation is available for this run yet. Missing is not zero." : "Browser preview runs do not send provider requests or expose native usage."}</p>
        )}
      </section>
      <section className="inspector-section run-timeline-card">
        <span className="eyebrow">Event availability</span>
        <article className={activeRun ? "run-event run-event--active" : "run-event"}>
          <span className="run-event__dot" />
          <div>
            <strong>{activeRun ? "Current stage" : "Terminal state observed"}</strong>
            <p>{runState ? String(runState).replaceAll("-", " ") : "State unavailable"}</p>
            <time>{nativeStartedAt ? `Native started ${nativeStartedAt}` : persistedEvents.length > 0 ? "Replayed from native journal" : "Renderer-only · not durably journaled"}</time>
          </div>
        </article>
      </section>
      <RunTimeline
        runId={observedRunId}
        events={persistedEvents}
        coverage={observedJournalCoverage?.coverage ?? "unknown"}
        coverageReason={observedJournalCoverage?.reason ?? null}
        handoff={observedJournalCoverage?.handoff ?? null}
      />
      <div className="inspector-notice">
        <Info size={15} />
        <p>{hasNativeRunEvidence ? "Event timelines and provider-stream usage are replayed from native storage." : "This browser preview has no native run receipt or provider telemetry."} Timing, throughput, RPM/TPM, quota/health, final/invoice cost, and retry telemetry remain unavailable until their native observations are implemented.</p>
      </div>
      <button type="button" className="button button--secondary button--full" disabled title="Full request snapshot and cost reconciliation are planned">
        Full request snapshot planned
      </button>
    </div>
  );
}

function ParameterInspector() {
  const parameters = useWorkspaceStore((state) => state.parameters);
  const modelProfileId = useWorkspaceStore((state) => state.modelProfileId);
  const providers = useWorkspaceStore((state) => state.providers);
  const setParameter = useWorkspaceStore((state) => state.setParameter);
  const resetParameters = useWorkspaceStore((state) => state.resetParameters);
  const setModelProfile = useWorkspaceStore((state) => state.setModelProfile);
  const modelProfiles = selectableModelProfiles(providers);
  const selectedModel =
    modelProfiles.find((profile) => profile.id === modelProfileId) ?? modelProfiles[0];
  const route = resolveRoutedProviderModel(providers, selectedModel);
  const supports = (capability: "reasoning" | "json" | "tools" | "topK" | "seed") => {
    if (capability === "tools") return route?.model.capabilities.includes("tools") === true;
    return supportsProviderParameter(route, capability);
  };
  const parameterPreflight = route ? preflightProviderParameters(parameters, route) : null;

  return (
    <div className="inspector-scroll" tabIndex={0}>
      <ParameterHistoryControls />
      <ProfilePresetsWorkbench showHistoryControls={false} />

      <label className="parameter-field parameter-field--select">
        <span>
          <strong>Model profile</strong>
          <small>Conversation override</small>
        </span>
        <select value={modelProfileId} onChange={(event) => setModelProfile(event.target.value)}>
          {modelProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.displayName} · {profile.providerName}
            </option>
          ))}
        </select>
      </label>

      <label className="parameter-field">
        <span>
          <strong id="temperature-label">Temperature</strong>
          <small>Model default: 0.7</small>
        </span>
        <output id="temperature-value" htmlFor="temperature-input">{parameters.temperature.toFixed(2)}</output>
        <input
          id="temperature-input"
          type="range"
          min="0"
          max="2"
          step="0.05"
          value={parameters.temperature}
          aria-labelledby="temperature-label"
          aria-describedby="temperature-value"
          onChange={(event) => setParameter("temperature", Number(event.target.value))}
        />
      </label>
      <label className="parameter-field">
        <span>
          <strong id="top-p-label">Top P</strong>
          <small>Model default: 0.95</small>
        </span>
        <output id="top-p-value" htmlFor="top-p-input">{parameters.topP.toFixed(2)}</output>
        <input
          id="top-p-input"
          type="range"
          min="0.05"
          max="1"
          step="0.05"
          value={parameters.topP}
          aria-labelledby="top-p-label"
          aria-describedby="top-p-value"
          onChange={(event) => setParameter("topP", Number(event.target.value))}
        />
      </label>
      <label className="parameter-field parameter-field--number">
        <span>
          <strong>Max output tokens</strong>
          <small>Provider range: 1–32,768</small>
        </span>
        <input
          type="number"
          min={1}
          max={32768}
          value={parameters.maxOutputTokens}
          onChange={(event) => setParameter("maxOutputTokens", Number(event.target.value))}
        />
      </label>
      <label className="parameter-field parameter-field--select">
        <span>
          <strong>Reasoning effort</strong>
          <small>{route ? `${route.provider.name} · provider-native control` : "No routed model available"}</small>
        </span>
        <select
          value={parameters.reasoningEffort}
          onChange={(event) =>
            setParameter(
              "reasoningEffort",
              event.target.value as "off" | "low" | "medium" | "high" | "max",
            )
          }
          disabled={!supports("reasoning")}
        >
          <option value="off">Off</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="max">Maximum</option>
        </select>
      </label>

      <label className="parameter-field parameter-field--number">
        <span>
          <strong>Reasoning budget</strong>
          <small>{supports("reasoning") ? "Optional provider-native token budget" : "Unsupported by routed model"}</small>
        </span>
        <input
          type="number"
          min={0}
          max={200000}
          disabled={!supports("reasoning")}
          value={parameters.reasoningBudgetTokens ?? ""}
          placeholder="Auto"
          onChange={(event) =>
            setParameter("reasoningBudgetTokens", event.target.value ? Number(event.target.value) : null)
          }
        />
      </label>

      <label className="toggle-row hit-target-control">
        <span>
          <strong>Stream response</strong>
          <small>Required by the Phase 1 provider adapter</small>
        </span>
        <input
          type="checkbox"
          checked={parameters.streaming}
          disabled
          aria-label="Stream response required in this preview"
        />
        <span className="toggle-track" />
      </label>
      <label className="toggle-row hit-target-control">
        <span>
          <strong>JSON response</strong>
          <small>Validate provider structured output</small>
        </span>
        <input
          type="checkbox"
          checked={parameters.jsonMode}
          disabled={!supports("json")}
          onChange={(event) => setParameter("jsonMode", event.target.checked)}
        />
        <span className="toggle-track" />
      </label>

      <label className="toggle-row hit-target-control">
        <span>
          <strong>Parallel tool calls</strong>
          <small>{supports("tools") ? "Allow compatible providers to issue independent calls together" : "Unsupported by selected model"}</small>
        </span>
        <input
          type="checkbox"
          checked={parameters.parallelToolCalls}
          disabled={!supports("tools")}
          onChange={(event) => setParameter("parallelToolCalls", event.target.checked)}
        />
        <span className="toggle-track" />
      </label>

      <details className="expert-parameter-panel">
        <summary>
          <span>
            <strong>Expert parameters</strong>
            <small>Sampling, penalties, tool policy, transport, schema, and provider extensions</small>
          </span>
          <ChevronDown size={15} />
        </summary>
        <div className="expert-parameter-panel__body">
          <div className="expert-parameter-grid">
            <label><span>Top K<small>{supports("topK") ? "Native for routed provider" : "Unsupported by routed provider"}</small></span><input type="number" min={0} max={500} disabled={!supports("topK")} value={parameters.topK} onChange={(event) => setParameter("topK", Number(event.target.value))} /></label>
            <label><span>Min P<small>0–1</small></span><input type="number" min={0} max={1} step={0.01} value={parameters.minP} onChange={(event) => setParameter("minP", Number(event.target.value))} /></label>
            <label><span>Frequency penalty<small>−2 to 2</small></span><input type="number" min={-2} max={2} step={0.1} value={parameters.frequencyPenalty} onChange={(event) => setParameter("frequencyPenalty", Number(event.target.value))} /></label>
            <label><span>Presence penalty<small>−2 to 2</small></span><input type="number" min={-2} max={2} step={0.1} value={parameters.presencePenalty} onChange={(event) => setParameter("presencePenalty", Number(event.target.value))} /></label>
            <label><span>Seed<small>{supports("seed") ? "OpenAI-compatible only" : "Unsupported by routed provider"}</small></span><input type="number" disabled={!supports("seed")} value={parameters.seed ?? ""} placeholder="Auto" onChange={(event) => setParameter("seed", event.target.value ? Number(event.target.value) : null)} /></label>
            <label><span>Top logprobs<small>0–20</small></span><input type="number" min={0} max={20} disabled={!parameters.logprobs} value={parameters.topLogprobs} onChange={(event) => setParameter("topLogprobs", Number(event.target.value))} /></label>
            <label><span>Tool choice<small>Canonical policy</small></span><select value={parameters.toolChoice} onChange={(event) => setParameter("toolChoice", event.target.value as "auto" | "none" | "required")}><option value="auto">Auto</option><option value="none">None</option><option value="required">Required</option></select></label>
            <label><span>Service tier<small>Sent only when supported</small></span><select value={parameters.serviceTier} onChange={(event) => setParameter("serviceTier", event.target.value as "auto" | "default" | "priority" | "flex")}><option value="auto">Auto</option><option value="default">Default</option><option value="priority">Priority</option><option value="flex">Flex</option></select></label>
            <label><span>Timeout<small>Milliseconds</small></span><input type="number" min={1000} max={1800000} step={1000} value={parameters.timeoutMs} onChange={(event) => setParameter("timeoutMs", Number(event.target.value))} /></label>
            <label><span>Max retries<small>0–8 · retry safety still applies</small></span><input type="number" min={0} max={8} value={parameters.maxRetries} onChange={(event) => setParameter("maxRetries", Number(event.target.value))} /></label>
          </div>
          <label className="expert-toggle hit-target-control"><input type="checkbox" checked={parameters.logprobs} onChange={(event) => setParameter("logprobs", event.target.checked)} /><span><strong>Return log probabilities</strong><small>May increase latency and payload size</small></span></label>
          <label className="expert-toggle hit-target-control"><input type="checkbox" checked={parameters.promptCaching} onChange={(event) => setParameter("promptCaching", event.target.checked)} /><span><strong>Prompt caching</strong><small>Use provider-native cache hints when available</small></span></label>
          <label className="expert-textarea"><span><strong>Stop sequences</strong><small>One per line</small></span><textarea rows={3} value={parameters.stopSequences} onChange={(event) => setParameter("stopSequences", event.target.value)} /></label>
          <label className="expert-textarea"><span><strong>JSON schema</strong><small>Planned · not sent by this preview</small></span><textarea rows={5} spellCheck={false} value={parameters.jsonSchema} disabled onChange={(event) => setParameter("jsonSchema", event.target.value)} placeholder={'{"type":"object","properties":{}}'} /></label>
          <label className="expert-textarea"><span><strong>Provider extensions</strong><small>Namespaced JSON merged only after capability validation</small></span><textarea rows={4} spellCheck={false} value={parameters.providerExtensions} onChange={(event) => setParameter("providerExtensions", event.target.value)} /></label>
        </div>
      </details>

      {parameterPreflight?.errors.length ? (
        <div className="parameter-warning parameter-warning--error" role="alert">
          <AlertTriangle size={15} />
          <p>{parameterPreflight.errors.join(" ")}</p>
        </div>
      ) : (
        <div className="parameter-warning">
          <AlertTriangle size={15} />
          <p>Temperature and Top P are both overridden. Some providers recommend changing only one sampling control.</p>
        </div>
      )}
      <button type="button" className="button button--secondary button--full" onClick={resetParameters}>
        <RotateCcw size={15} />
        Reset conversation overrides
      </button>
    </div>
  );
}

export function ContextInspectorPanel() {
  const inspectorOpen = useWorkspaceStore((state) => state.inspectorOpen);
  const inspectorTab = useWorkspaceStore((state) => state.inspectorTab);
  const setInspectorTab = useWorkspaceStore((state) => state.setInspectorTab);
  const toggleInspector = useWorkspaceStore((state) => state.toggleInspector);
  const narrowPanels = useNarrowPanelViewport();
  const panelRef = usePanelDrawerFocus<HTMLElement>(
    inspectorOpen,
    narrowPanels,
    toggleInspector,
    "inspector-toggle",
  );
  const citations = useWorkspaceStore((state) => state.citations);
  const selectedCitationId = useCitationSelectionStore((state) => state.selectedCitationId);
  const returnTargetId = useCitationSelectionStore((state) => state.returnTargetId);
  const returnTab = useCitationSelectionStore((state) => state.returnTab);
  const clearCitation = useCitationSelectionStore((state) => state.clearCitation);
  const selectedCitation = useMemo(
    () => citations.find((citation) => citation.id === selectedCitationId) ?? null,
    [citations, selectedCitationId],
  );
  const selectedAnswerCitations = useMemo(
    () =>
      selectedCitation === null
        ? []
        : citations.filter(
            (citation) =>
              citation.messageId === selectedCitation.messageId &&
              citation.runId === selectedCitation.runId,
          ),
    [citations, selectedCitation],
  );

  if (!inspectorOpen) return null;

  const selectAdjacentTab = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex]!;
    setInspectorTab(nextTab.id);
    document.getElementById(`inspector-tab-${nextTab.id}`)?.focus();
  };

  const panelId = `inspector-panel-${inspectorTab}`;

  return (
    <aside
      ref={panelRef}
      id="context-inspector"
      className="context-inspector"
      aria-label="Context and run inspector"
      aria-modal={narrowPanels ? "true" : undefined}
      role={narrowPanels ? "dialog" : "complementary"}
      tabIndex={-1}
    >
      <div className="inspector-header">
        <div className="inspector-tabs" role="tablist" aria-label="Inspector view">
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              id={`inspector-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={inspectorTab === tab.id}
              aria-controls={`inspector-panel-${tab.id}`}
              tabIndex={inspectorTab === tab.id ? 0 : -1}
              className={inspectorTab === tab.id ? "inspector-tab inspector-tab--active" : "inspector-tab"}
              title={`Show ${tab.label.toLowerCase()} inspector`}
              onClick={() => setInspectorTab(tab.id)}
              onKeyDown={(event) => selectAdjacentTab(event, index)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button type="button" className="icon-button icon-button--small" onClick={toggleInspector} aria-label="Close inspector" title="Close inspector">
          <PanelRightClose size={16} />
        </button>
      </div>
      <div
        className="inspector-tabpanel"
        id={panelId}
        role="tabpanel"
        aria-labelledby={`inspector-tab-${inspectorTab}`}
        tabIndex={0}
      >
        {selectedCitationId !== null ? (
          <SourcesInspector
            citations={selectedAnswerCitations}
            selectedCitationId={selectedCitationId}
            onReturn={() => {
              setInspectorTab(returnTab);
              clearCitation();
              focusCitationReturnTarget(returnTargetId);
            }}
          />
        ) : (
          <>
            {inspectorTab === "context" ? <ContextInspector /> : null}
            {inspectorTab === "run" ? <RunInspector /> : null}
            {inspectorTab === "parameters" ? <ParameterInspector /> : null}
          </>
        )}
      </div>
    </aside>
  );
}
