import { useEffect, useMemo, useRef, useState } from "react";
import type {
  RendererTimingObservation,
  RendererUsageObservation,
  RunTelemetryAttemptSnapshot,
  RunTelemetrySnapshot,
} from "@/lib/desktop";
import {
  aggregateGlobalPromptTelemetry,
  buildPromptTelemetryRecord,
  formatDetailedPromptTimestamp,
  formatTelemetryDurationMs,
  formatTelemetryUsd,
  type PromptTelemetryRecord,
  type PromptSurfaceKind,
} from "../../domain/omnia-prompt-telemetry";
import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";

export interface PromptTelemetryInspectorProps {
  readonly record?: PromptTelemetryRecord;
  readonly globalRecords?: readonly PromptTelemetryRecord[];
  readonly surface?: PromptSurfaceKind;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly buttonLabel?: string;
  readonly testId?: string;
  readonly defaultOpen?: boolean;
  readonly conversationId?: string;
}

/** Explicit preview fixture; production inspectors never create a sample implicitly. */
export function createSamplePromptTelemetryRecord(options?: {
  readonly promptId?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly surface?: PromptSurfaceKind | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly promptSummary?: string | undefined;
}): PromptTelemetryRecord {
  const provider = options?.provider ?? "Anthropic";
  const model = options?.model ?? "claude-opus-4-6";
  const effort = options?.effort ?? "high";
  const surface = options?.surface ?? "main-chat";
  return buildPromptTelemetryRecord({
    promptId: options?.promptId ?? "prompt-turn-1",
    conversationId: options?.conversationId ?? "conv-active",
    surface,
    promptSummary: options?.promptSummary ?? "Execute verification and inspect workspace state",
    promptSentAtIso: "2026-04-12T10:14:00.000Z",
    promptFinishedAtIso: "2026-04-12T10:14:03.420Z",
    ttftMs: 310,
    latencyMs: 3420,
    provider,
    model,
    effort,
    tokensIn: 1840,
    tokensOut: 620,
    cacheTokensIn: 14200,
    cacheTokensOut: 480,
    requestCount: 3,
    agentCount: 2,
    commands: [
      {
        commandId: "cmd-rg-search",
        commandLabel: "rg --files src/domain",
        agentId: "agent-main",
        startedAtIso: "2026-04-12T10:14:00.450Z",
        finishedAtIso: "2026-04-12T10:14:01.190Z",
        durationMs: 740,
        status: "completed",
      },
      {
        commandId: "cmd-vitest-check",
        commandLabel: "npx vitest run src/domain",
        agentId: "agent-verifier",
        startedAtIso: "2026-04-12T10:14:01.250Z",
        finishedAtIso: "2026-04-12T10:14:02.980Z",
        durationMs: 1730,
        status: "completed",
      },
    ],
    agents: [
      {
        agentId: "agent-main",
        agentLabel: "Main Coordinator",
        role: "main",
        provider,
        model,
        effort,
        tokensIn: 1120,
        tokensOut: 390,
        cacheTokensIn: 9400,
        cacheTokensOut: 320,
        costTotalUsd: 0.0221,
        durationMs: 2150,
        requestCount: 2,
      },
      {
        agentId: "agent-verifier",
        agentLabel: "Peer Verifier",
        role: "verifier",
        provider,
        model,
        effort,
        tokensIn: 720,
        tokensOut: 230,
        cacheTokensIn: 4800,
        cacheTokensOut: 160,
        costTotalUsd: 0.0128,
        durationMs: 1270,
        requestCount: 1,
      },
    ],
  });
}

export function PromptTelemetryInspector(props: PromptTelemetryInspectorProps) {
  const [isOpen, setIsOpen] = useState(Boolean(props.defaultOpen));
  const [viewScope, setViewScope] = useState<"prompt" | "global">("prompt");
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);

  const conversations = useWorkspaceStore((state) => state.conversations);
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const runTelemetryByRunId = useWorkspaceStore((state) => state.runTelemetryByRunId);
  const conversationId = props.conversationId ?? activeConversationId;
  const nativeRuns = useMemo(() => {
    const conversation = conversations.find((item) => item.id === conversationId);
    const runIds = new Set(conversation?.messages.map((message) => message.runId).filter(Boolean));
    return [...runIds].reverse().flatMap((runId) => {
      const snapshot = runId ? runTelemetryByRunId[runId] : undefined;
      return snapshot?.runId === runId ? [snapshot] : [];
    });
  }, [conversations, conversationId, runTelemetryByRunId]);

  const allRecords = useMemo<readonly PromptTelemetryRecord[]>(() => {
    if (props.globalRecords && props.globalRecords.length > 0) {
      return props.globalRecords;
    }
    if (props.record) {
      return [props.record];
    }
    return [];
  }, [props.globalRecords, props.record]);

  const activeRecord = useMemo(() => {
    if (props.record) return props.record;
    if (selectedPromptId) {
      const matched = allRecords.find((r) => r.promptId === selectedPromptId);
      if (matched) return matched;
    }
    return allRecords[0];
  }, [props.record, selectedPromptId, allRecords]);
  const activeNativeRun = nativeRuns.find((snapshot) => snapshot.runId === selectedPromptId) ?? nativeRuns[0];

  const globalSummary = useMemo(
    () => aggregateGlobalPromptTelemetry(allRecords),
    [allRecords],
  );

  const testId = props.testId ?? "prompt-telemetry-inspector";
  const floatingSourceId = `telemetry-${testId}`;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    window.dispatchEvent(
      new CustomEvent("omnia:close-floating-menus", { detail: { source: floatingSourceId } }),
    );
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, floatingSourceId]);

  useEffect(() => {
    const handleCloseFloating = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string }>).detail;
      if (detail?.source !== floatingSourceId) {
        setIsOpen(false);
      }
    };
    window.addEventListener("omnia:close-floating-menus", handleCloseFloating);
    return () => window.removeEventListener("omnia:close-floating-menus", handleCloseFloating);
  }, [floatingSourceId]);

  return (
    <div
      ref={rootRef}
      className="prompt-telemetry-inspector-anchor"
      data-testid={testId}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setIsOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="workspace-SystemStripAction prompt-telemetry-trigger"
        data-testid={`${testId}-toggle`}
        aria-expanded={isOpen}
        aria-label={props.buttonLabel ?? "Inspect prompt telemetry and cost"}
        title="Inspect observed run telemetry"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 3v18h18" />
          <path d="m19 9-5 5-4-4-3 3" />
        </svg>
        <span>{props.buttonLabel ?? "Metrics"}</span>
      </button>

      {isOpen ? (
        <section
          className="prompt-telemetry-popover"
          data-testid={`${testId}-panel`}
          aria-label={activeRecord ? "Prompt and Global Telemetry Inspector" : "Native run telemetry inspector"}
        >
          <div className="prompt-telemetry-popover__header prompt-telemetry-popover-header">
            <strong>Telemetry &amp; Cost Inspector</strong>
            <div className="prompt-telemetry-popover__scopes prompt-telemetry-tabs">
              <button
                type="button"
                className={`workspace-SystemStripAction${viewScope === "prompt" ? " is-active" : ""}`}
                data-testid={`${testId}-scope-prompt`}
                onClick={() => setViewScope("prompt")}
              >
                Per-Prompt
              </button>
              {activeRecord ? <button
                type="button"
                className={`workspace-SystemStripAction${viewScope === "global" ? " is-active" : ""}`}
                data-testid={`${testId}-scope-global`}
                onClick={() => setViewScope("global")}
              >
                Global ({globalSummary.totalPrompts})
              </button> : null}
              <button
                type="button"
                className="workspace-SystemStripAction prompt-telemetry-close"
                data-testid={`${testId}-close`}
                aria-label="Close telemetry inspector"
                onClick={() => setIsOpen(false)}
              >
                Close
              </button>
            </div>
          </div>

          {!activeRecord ? (
            <div className="prompt-telemetry-popover__body" data-testid={`${testId}-prompt-view`}>
              {nativeRuns.length > 1 ? (
                <select
                  className="prompt-telemetry-select"
                  aria-label="Select observed run"
                  data-testid={`${testId}-turn-select`}
                  value={activeNativeRun?.runId ?? ""}
                  onChange={(event) => setSelectedPromptId(event.target.value)}
                >
                  {nativeRuns.map((snapshot) => <option key={snapshot.runId} value={snapshot.runId}>{snapshot.runId}</option>)}
                </select>
              ) : null}
              {activeNativeRun ? (
                <NativeRunTelemetryDetails snapshot={activeNativeRun} testId={testId} />
              ) : (
                <p data-testid={`${testId}-unavailable`}>No native telemetry is available for this conversation.</p>
              )}
            </div>
          ) : viewScope === "prompt" ? (
            <div className="prompt-telemetry-popover__body" data-testid={`${testId}-prompt-view`}>
              {allRecords.length > 1 && !props.record ? (
                <div className="prompt-telemetry-turn-selector">
                  <select
                    className="prompt-telemetry-select"
                    aria-label="Select prompt turn for telemetry inspection"
                    data-testid={`${testId}-turn-select`}
                    value={activeRecord.promptId}
                    onChange={(event) => setSelectedPromptId(event.target.value)}
                  >
                    {allRecords.map((rec, idx) => (
                      <option key={rec.promptId} value={rec.promptId}>
                        Turn #{idx + 1}: {rec.promptSummary.slice(0, 60)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <dl className="prompt-telemetry-grid">
                <div className="prompt-telemetry-cell">
                  <dt>Sent / Finished</dt>
                  <dd data-testid={`${testId}-timestamps`}>
                    {formatDetailedPromptTimestamp(activeRecord.promptSentAtIso)} →{" "}
                    {formatDetailedPromptTimestamp(activeRecord.promptFinishedAtIso)} (
                    {formatTelemetryDurationMs(activeRecord.durationMs)})
                  </dd>
                </div>
                <div className="prompt-telemetry-cell">
                  <dt>TTFT / Latency / Speed</dt>
                  <dd data-testid={`${testId}-speed`}>
                    TTFT {activeRecord.ttftMs}ms · Latency{" "}
                    {formatTelemetryDurationMs(activeRecord.latencyMs)} ·{" "}
                    {activeRecord.tokensPerSecond} tok/s
                  </dd>
                </div>
                <div className="prompt-telemetry-cell">
                  <dt>Provider / Model / Effort</dt>
                  <dd data-testid={`${testId}-model-spec`}>
                    {activeRecord.provider} · {activeRecord.model} · Effort:{" "}
                    {activeRecord.effort}
                  </dd>
                </div>
                <div className="prompt-telemetry-cell">
                  <dt>Tokens In / Out</dt>
                  <dd data-testid={`${testId}-tokens`}>
                    In: {activeRecord.tokensIn.toLocaleString()} · Out:{" "}
                    {activeRecord.tokensOut.toLocaleString()}
                  </dd>
                </div>
                <div className="prompt-telemetry-cell">
                  <dt>Cache In / Out / Cache Hit %</dt>
                  <dd data-testid={`${testId}-cache`}>
                    Cache In: {activeRecord.cacheTokensIn.toLocaleString()} · Cache Out:{" "}
                    {activeRecord.cacheTokensOut.toLocaleString()} · Cache Hit:{" "}
                    {activeRecord.cacheHitPercent}%
                  </dd>
                </div>
                <div className="prompt-telemetry-cell">
                  <dt>Cost In / Out / Cache In / Cache Out / Total</dt>
                  <dd data-testid={`${testId}-cost`}>
                    In {formatTelemetryUsd(activeRecord.costInUsd)} · Out{" "}
                    {formatTelemetryUsd(activeRecord.costOutUsd)} · Cache In{" "}
                    {formatTelemetryUsd(activeRecord.costCacheInUsd)} · Cache Out{" "}
                    {formatTelemetryUsd(activeRecord.costCacheOutUsd)} · Cache{" "}
                    {formatTelemetryUsd(activeRecord.costCacheUsd)} · Total{" "}
                    {formatTelemetryUsd(activeRecord.costTotalUsd)}
                  </dd>
                </div>
                <div className="prompt-telemetry-cell">
                  <dt>Requests (req) / RPM / Agents</dt>
                  <dd data-testid={`${testId}-req-rpm-agents`}>
                    {activeRecord.requestCount} req · {activeRecord.requestsPerMinute} RPM ·{" "}
                    {activeRecord.agentCount} Agents
                  </dd>
                </div>
              </dl>

              {activeRecord.commands.length > 0 ? (
                <div className="prompt-telemetry-subtable prompt-telemetry-stage-list" data-testid={`${testId}-commands`}>
                  <div className="prompt-telemetry-subtable__title">
                    Per-Command Execution Duration ({activeRecord.commands.length})
                  </div>
                  {activeRecord.commands.map((cmd) => (
                    <div key={cmd.commandId} className="prompt-telemetry-row prompt-telemetry-stage-row">
                      <code>{cmd.commandLabel}</code>
                      <span className="prompt-telemetry-badge">
                        {cmd.agentId} · {formatTelemetryDurationMs(cmd.durationMs)} ({cmd.status})
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              {activeRecord.agents.length > 0 ? (
                <div className="prompt-telemetry-subtable prompt-telemetry-stage-list" data-testid={`${testId}-agents`}>
                  <div className="prompt-telemetry-subtable__title">
                    Per-Agent Telemetry ({activeRecord.agents.length})
                  </div>
                  {activeRecord.agents.map((agent) => (
                    <div key={agent.agentId} className="prompt-telemetry-row prompt-telemetry-stage-row">
                      <span>
                        <strong>{agent.agentLabel}</strong> ({agent.role}) · {agent.provider}/
                        {agent.model} ({agent.effort})
                      </span>
                      <span className="prompt-telemetry-badge">
                        {agent.tokensIn}/{agent.tokensOut} tok · Cache {agent.cacheTokensIn} ·{" "}
                        {formatTelemetryUsd(agent.costTotalUsd)} ·{" "}
                        {formatTelemetryDurationMs(agent.durationMs)} · {agent.requestCount} req
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="prompt-telemetry-popover__body" data-testid={`${testId}-global-view`}>
              <dl className="prompt-telemetry-grid">
                <div className="prompt-telemetry-cell">
                  <dt>Global Prompts / Requests / RPM / Agents</dt>
                  <dd data-testid={`${testId}-global-summary`}>
                    {globalSummary.totalPrompts} prompts · {globalSummary.totalRequests} req ·{" "}
                    {globalSummary.averageRequestsPerMinute} RPM ·{" "}
                    {globalSummary.totalAgentsInvolved} Agents
                  </dd>
                </div>
                <div className="prompt-telemetry-cell">
                  <dt>Avg TTFT / Avg Latency / Avg Speed</dt>
                  <dd>
                    TTFT {globalSummary.averageTtftMs}ms · Latency{" "}
                    {formatTelemetryDurationMs(globalSummary.averageLatencyMs)} ·{" "}
                    {globalSummary.averageTokensPerSecond} tok/s
                  </dd>
                </div>
                <div className="prompt-telemetry-cell">
                  <dt>Total Tokens &amp; Cache Hit %</dt>
                  <dd>
                    In {globalSummary.totalTokensIn.toLocaleString()} · Out{" "}
                    {globalSummary.totalTokensOut.toLocaleString()} · Cache In{" "}
                    {globalSummary.totalCacheTokensIn.toLocaleString()} · Cache Out{" "}
                    {globalSummary.totalCacheTokensOut.toLocaleString()} (
                    {globalSummary.overallCacheHitPercent}% Hit)
                  </dd>
                </div>
                <div className="prompt-telemetry-cell">
                  <dt>Total Cost In / Out / Cache In / Cache Out / Total</dt>
                  <dd data-testid={`${testId}-global-cost`}>
                    In {formatTelemetryUsd(globalSummary.totalCostInUsd)} · Out{" "}
                    {formatTelemetryUsd(globalSummary.totalCostOutUsd)} · Cache In{" "}
                    {formatTelemetryUsd(globalSummary.totalCostCacheInUsd)} · Cache Out{" "}
                    {formatTelemetryUsd(globalSummary.totalCostCacheOutUsd)} · Cache{" "}
                    {formatTelemetryUsd(globalSummary.totalCostCacheUsd)} · Total{" "}
                    {formatTelemetryUsd(globalSummary.totalCostUsd)}
                  </dd>
                </div>
                <div className="prompt-telemetry-cell">
                  <dt>Commands Executed</dt>
                  <dd>
                    {globalSummary.totalCommandsExecuted} commands ·{" "}
                    {formatTelemetryDurationMs(globalSummary.totalCommandDurationMs)} total work
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

const USAGE_SOURCE_RANK: Record<RendererUsageObservation["source"], number> = {
  "local-estimate": 1,
  "provider-incremental": 2,
  "provider-final": 3,
  "provider-invoice": 0,
  "user-correction": 4,
};

/** Ledger observations are cumulative alternatives, never token deltas to add. */
function selectUsageObservation(observations: readonly RendererUsageObservation[]) {
  return observations.reduce<RendererUsageObservation | undefined>((selected, observation) => {
    if (!selected) return observation;
    const sourcePriority = USAGE_SOURCE_RANK[observation.source] - USAGE_SOURCE_RANK[selected.source];
    return sourcePriority > 0 || (sourcePriority === 0 && observation.sequence > selected.sequence)
      ? observation
      : selected;
  }, undefined);
}

function latestTimingObservation(observations: readonly RendererTimingObservation[]) {
  return observations.reduce<RendererTimingObservation | undefined>((selected, observation) =>
    !selected || observation.observedAtMs > selected.observedAtMs ? observation : selected,
  undefined);
}

function formatObservedCounter(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString()
    : "Not reported";
}

function observedDuration(start: number | null | undefined, end: number | null | undefined) {
  return start !== null && start !== undefined && end !== null && end !== undefined &&
    Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start
    ? end - start
    : null;
}

function formatObservedDuration(value: number | null) {
  return value === null ? "Not reported" : formatTelemetryDurationMs(value);
}

function formatObservedTimestamp(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 8.64e15) return "Not reported";
  return formatDetailedPromptTimestamp(new Date(value).toISOString());
}

function NativeAttemptTelemetryDetails({ attempt, testId }: {
  readonly attempt: RunTelemetryAttemptSnapshot;
  readonly testId: string;
}) {
  const usage = selectUsageObservation(attempt.usageLedger);
  const timing = latestTimingObservation(attempt.timingObservations);
  const duration = timing
    ? observedDuration(timing.marks.dispatchStartedMs, timing.marks.terminalMs)
    : observedDuration(attempt.startedAtMs, attempt.completedAtMs);
  return (
    <section className="prompt-telemetry-subtable" data-testid={`${testId}-attempt`}>
      <strong>Attempt {attempt.ordinal} · {attempt.state}</strong>
      <p data-testid={`${testId}-coverage`}>
        {usage ? `${usage.source} · ${usage.coverage} · ${usage.authoritative ? "authoritative" : "non-authoritative"}` : "No native usage observation"}
      </p>
      <dl className="prompt-telemetry-grid">
        <div className="prompt-telemetry-cell">
          <dt>Provider route / Model</dt>
          <dd data-testid={`${testId}-model-spec`}>{attempt.providerProfileId ?? "Provider not reported"} · {attempt.modelId || "Model not reported"}</dd>
        </div>
        <div className="prompt-telemetry-cell">
          <dt>Attempt started / Finished</dt>
          <dd data-testid={`${testId}-timestamps`}>{formatObservedTimestamp(attempt.startedAtMs)} → {formatObservedTimestamp(attempt.completedAtMs)}</dd>
        </div>
        <div className="prompt-telemetry-cell">
          <dt>Observed timing</dt>
          <dd data-testid={`${testId}-speed`}>
            Duration: {formatObservedDuration(duration)} · First provider output: {formatObservedDuration(timing ? observedDuration(timing.marks.dispatchStartedMs, timing.marks.firstProviderOutputMs) : null)} · First visible output: {formatObservedDuration(timing ? observedDuration(timing.marks.dispatchStartedMs, timing.marks.firstVisibleOutputMs) : null)}
            {timing ? ` · ${timing.coverage}` : null}
          </dd>
        </div>
        <div className="prompt-telemetry-cell">
          <dt>Tokens In / Out</dt>
          <dd data-testid={`${testId}-tokens`}>In: {formatObservedCounter(usage?.counters.inputTokens)} · Out: {formatObservedCounter(usage?.counters.outputTokens)}</dd>
        </div>
        <div className="prompt-telemetry-cell">
          <dt>Cache read / Write</dt>
          <dd data-testid={`${testId}-cache`}>Cache read: {formatObservedCounter(usage?.counters.cacheReadInputTokens)} · Cache write: {formatObservedCounter(usage?.counters.cacheWriteInputTokens)}</dd>
        </div>
        <div className="prompt-telemetry-cell">
          <dt>Reasoning / Visible output tokens</dt>
          <dd data-testid={`${testId}-reasoning`}>Reasoning: {formatObservedCounter(usage?.counters.reasoningTokens)} · Visible: {formatObservedCounter(usage?.counters.visibleOutputTokens)}</dd>
        </div>
        <div className="prompt-telemetry-cell">
          <dt>Cost</dt>
          <dd data-testid={`${testId}-cost`}>{attempt.usageLedger.some((observation) => observation.costStatementCount > 0) ? "Native statement present; amount not reported" : "No native cost amount reported"}</dd>
        </div>
        <div className="prompt-telemetry-cell">
          <dt>Provider acceptance</dt>
          <dd>{attempt.acceptedByProvider}</dd>
        </div>
      </dl>
    </section>
  );
}

function NativeRunTelemetryDetails({ snapshot, testId }: {
  readonly snapshot: RunTelemetrySnapshot;
  readonly testId: string;
}) {
  return (
    <div data-testid={`${testId}-native-run`}>
      <p>Run: {snapshot.runId} · {snapshot.attempts.length} observed attempts</p>
      {snapshot.attempts.length ? snapshot.attempts.map((attempt) => (
        <NativeAttemptTelemetryDetails key={attempt.attemptId} attempt={attempt} testId={`${testId}-${attempt.attemptId}`} />
      )) : <p>No native attempts reported.</p>}
      <p>Request rate, command work, and agent activity are not reported by this telemetry snapshot.</p>
    </div>
  );
}

function resolveTurnRunId(conversations: readonly ConversationView[], props: Pick<TurnTelemetryHudProps, "turnId" | "conversationId" | "runId" | "surface">) {
  const scoped = props.conversationId === undefined
    ? conversations
    : conversations.filter((conversation) => conversation.id === props.conversationId);
  // Local browser utility messages do not correspond to provider turns.
  if (props.surface === "browser-sidebar" && props.turnId.startsWith("browser-local-")) return null;
  const prefix = props.surface === "ide-sidebar" ? "ide-" : props.surface === "browser-sidebar" ? "browser-chat-" : null;
  const candidates = [props.turnId, ...(prefix && props.turnId.startsWith(prefix) ? [props.turnId.slice(prefix.length)] : [])];
  const matchingMessages = scoped.flatMap((conversation) => conversation.messages.filter((message) => candidates.includes(message.id)));
  if (matchingMessages.length > 1) return null;
  const messageRunId = matchingMessages[0]?.runId;
  if (props.runId) {
    if (matchingMessages.length && messageRunId !== props.runId) return null;
    if (props.conversationId !== undefined && !scoped.some((conversation) => conversation.messages.some((message) => message.runId === props.runId))) return null;
    return props.runId;
  }
  return messageRunId ?? null;
}

export interface TurnTelemetryHudProps {
  readonly turnId: string;
  /** Exact owning conversation, when the surface supplies one. */
  readonly conversationId?: string | undefined;
  readonly runId?: string | null | undefined;
  readonly promptText?: string;
  readonly responseText?: string;
  readonly createdAt?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly surface?: "main-chat" | "ide-sidebar" | "browser-sidebar";
}

export function TurnTelemetryHud({
  turnId,
  conversationId,
  runId,
  surface = "main-chat",
}: TurnTelemetryHudProps) {
  const [expanded, setExpanded] = useState(false);
  const conversations = useWorkspaceStore((state) => state.conversations);
  const runTelemetryByRunId = useWorkspaceStore((state) => state.runTelemetryByRunId);
  const snapshot = useMemo(() => {
    const resolvedRunId = resolveTurnRunId(conversations, { turnId, conversationId, runId, surface });
    const observed = resolvedRunId ? runTelemetryByRunId[resolvedRunId] : undefined;
    return observed?.runId === resolvedRunId ? observed : undefined;
  }, [conversations, conversationId, runId, runTelemetryByRunId, surface, turnId]);
  const attempt = snapshot?.attempts.reduce<RunTelemetryAttemptSnapshot | undefined>(
    (latest, current) => !latest || current.ordinal > latest.ordinal ? current : latest,
    undefined,
  );
  const usage = attempt ? selectUsageObservation(attempt.usageLedger) : undefined;

  if (!snapshot || !attempt) {
    return <div className="turn-telemetry-hud" data-testid={`turn-telemetry-hud-${turnId}`} data-telemetry-status="unavailable" style={{ marginTop: 6, fontSize: 11, color: "var(--text-tertiary, #94a3b8)" }}>
      <span>Native telemetry unavailable for this turn.</span>
    </div>;
  }

  return (
    <div className="turn-telemetry-hud" data-testid={`turn-telemetry-hud-${turnId}`} data-telemetry-status="observed" style={{ marginTop: 6, fontSize: 11, color: "var(--text-secondary, #cbd5e1)" }}>
      <button
        type="button"
        data-testid={`turn-telemetry-hud-toggle-${turnId}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((previous) => !previous)}
        style={{ display: "inline-flex", flexWrap: "wrap", background: "transparent", border: "none", padding: 0, color: "inherit", fontSize: "inherit", cursor: "pointer", textAlign: "left" }}
      >
        <span>{attempt.modelId || "Model not reported"}</span>
        <span> · Latest attempt {attempt.ordinal} · {attempt.state}</span>
        <span> · In {formatObservedCounter(usage?.counters.inputTokens)} / Out {formatObservedCounter(usage?.counters.outputTokens)} tokens</span>
        {usage ? <span> · {usage.source} · {usage.coverage}</span> : null}
        <span> · {expanded ? "Hide details" : "Details"}</span>
      </button>
      {expanded ? (
        <div data-testid={`turn-telemetry-hud-details-${turnId}`}>
          <NativeRunTelemetryDetails snapshot={snapshot} testId={`turn-telemetry-${turnId}`} />
        </div>
      ) : null}
    </div>
  );
}

export interface TurnComparisonCandidate {
  readonly id: string;
  readonly modelLabel: string;
  readonly content: string;
}

type TurnStudioAction = () => void | Promise<void>;

export interface TurnStudioActionsBarProps {
  readonly turnId: string;
  readonly responseText: string;
  readonly modelLabel?: string;
  readonly branchIndex?: number;
  readonly branchCount?: number;
  readonly onSwitchBranch?: (direction: "prev" | "next") => void | Promise<void>;
  readonly onRerun?: TurnStudioAction;
  readonly onClone?: TurnStudioAction;
  readonly onBranch?: TurnStudioAction;
  /** Actual alternative outputs supplied by the caller; never generated by this view. */
  readonly comparisonCandidates?: readonly TurnComparisonCandidate[];
  readonly onSelectCompareWinner?: (winnerContent: string, winnerModel: string) => void | Promise<void>;
}

const turnStudioButtonStyle = {
  padding: "2px 7px",
  borderRadius: "6px",
  border: "1px solid rgba(148, 163, 184, 0.24)",
  background: "rgba(30, 41, 59, 0.55)",
  color: "var(--text-secondary, #cbd5e1)",
  fontSize: "11px",
  cursor: "pointer",
} as const;

export function TurnStudioActionsBar({
  turnId,
  responseText,
  modelLabel,
  branchIndex,
  branchCount,
  onSwitchBranch,
  onRerun,
  onClone,
  onBranch,
  comparisonCandidates,
  onSelectCompareWinner,
}: TurnStudioActionsBarProps) {
  const [compareOpen, setCompareOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionState = useRef({ generation: 0, pending: false });

  useEffect(() => {
    actionState.current.generation += 1;
    actionState.current.pending = false;
    setPendingAction(null);
    setActionError(null);
    setCompareOpen(false);
    return () => {
      actionState.current.generation += 1;
      actionState.current.pending = false;
    };
  }, [turnId]);

  const seenCandidateIds = new Set(["current"]);
  const alternatives = (comparisonCandidates ?? []).filter((candidate) => {
    if (!candidate.id.trim() || seenCandidateIds.has(candidate.id)
      || !candidate.modelLabel.trim() || !candidate.content.trim()) return false;
    seenCandidateIds.add(candidate.id);
    return true;
  });
  const canCompare = responseText.trim().length > 0 && alternatives.length > 0;
  const hasBranchNavigation = typeof onSwitchBranch === "function"
    && typeof branchCount === "number" && Number.isSafeInteger(branchCount) && branchCount > 1
    && typeof branchIndex === "number" && Number.isSafeInteger(branchIndex)
    && branchIndex >= 1 && branchIndex <= branchCount;
  const candidates: readonly TurnComparisonCandidate[] = canCompare ? [
    { id: "current", modelLabel: modelLabel?.trim() ? modelLabel : "Model not reported", content: responseText },
    ...alternatives,
  ] : [];

  async function requestAction(label: string, operation: TurnStudioAction, onAccepted?: () => void) {
    if (actionState.current.pending) return;
    const generation = ++actionState.current.generation;
    actionState.current.pending = true;
    setPendingAction(label);
    setActionError(null);
    try {
      await operation();
      if (generation === actionState.current.generation) onAccepted?.();
    } catch {
      if (generation === actionState.current.generation) setActionError(`${label} failed. Try again.`);
    } finally {
      if (generation === actionState.current.generation) {
        actionState.current.pending = false;
        setPendingAction(null);
      }
    }
  }

  if (!onRerun && !onClone && !onBranch && !canCompare && !hasBranchNavigation) return null;

  return (
    <div
      className="turn-studio-actions"
      data-testid={`turn-studio-actions-${turnId}`}
      style={{ marginTop: "6px", display: "flex", flexDirection: "column", gap: "6px" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
        {onRerun ? <button
          type="button"
          className="turn-studio-action-btn"
          data-testid={`turn-action-rerun-${turnId}`}
          aria-label="Rerun turn"
          disabled={pendingAction !== null}
          onClick={() => { void requestAction("Rerun", onRerun); }}
          style={turnStudioButtonStyle}
        >↻ Rerun</button> : null}
        {canCompare ? <button
          type="button"
          className="turn-studio-action-btn"
          data-testid={`turn-action-compare-${turnId}`}
          aria-label="Compare models on this turn"
          aria-expanded={compareOpen}
          disabled={pendingAction !== null}
          onClick={() => setCompareOpen((previous) => !previous)}
          style={turnStudioButtonStyle}
        >⇄ Compare</button> : null}
        {onClone ? <button
          type="button"
          className="turn-studio-action-btn"
          data-testid={`turn-action-clone-${turnId}`}
          aria-label="Clone conversation from this turn"
          disabled={pendingAction !== null}
          onClick={() => { void requestAction("Clone", onClone); }}
          style={turnStudioButtonStyle}
        >⧉ Clone</button> : null}
        {onBranch ? <button
          type="button"
          className="turn-studio-action-btn"
          data-testid={`turn-action-branch-${turnId}`}
          aria-label="Branch conversation from this turn"
          disabled={pendingAction !== null}
          onClick={() => { void requestAction("Branch", onBranch); }}
          style={turnStudioButtonStyle}
        >⑂ Branch</button> : null}
        {hasBranchNavigation ? <div
          className="turn-branch-switcher"
          data-testid={`turn-branch-switcher-${turnId}`}
          style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px" }}
        >
          <button
            type="button"
            aria-label="Previous branch"
            data-testid={`turn-branch-prev-${turnId}`}
            disabled={pendingAction !== null}
            onClick={() => { void requestAction("Branch navigation", () => onSwitchBranch?.("prev")); }}
            style={turnStudioButtonStyle}
          >&lt;</button>
          <span>{branchIndex} / {branchCount}</span>
          <button
            type="button"
            aria-label="Next branch"
            data-testid={`turn-branch-next-${turnId}`}
            disabled={pendingAction !== null}
            onClick={() => { void requestAction("Branch navigation", () => onSwitchBranch?.("next")); }}
            style={turnStudioButtonStyle}
          >&gt;</button>
        </div> : null}
      </div>
      {pendingAction ? <span role="status">{pendingAction} requested</span> : null}
      {actionError ? <span role="alert">{actionError}</span> : null}
      {compareOpen && canCompare ? <div
        className="turn-compare-card"
        data-testid={`turn-compare-card-${turnId}`}
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "8px", padding: "8px", borderRadius: "8px", border: "1px solid rgba(56, 189, 248, 0.28)", fontSize: "11px" }}
      >
        {candidates.map((candidate) => <div
          key={candidate.id}
          data-testid={`turn-compare-candidate-${candidate.id}-${turnId}`}
          style={{ padding: "6px 8px", borderRadius: "6px", border: "1px solid rgba(148, 163, 184, 0.2)", display: "flex", flexDirection: "column", gap: "4px" }}
        >
          <strong>{candidate.modelLabel}</strong>
          <p style={{ margin: 0, color: "var(--text-secondary, #cbd5e1)", whiteSpace: "pre-wrap" }}>{candidate.content}</p>
          {onSelectCompareWinner ? <button
            type="button"
            data-testid={`turn-compare-use-${candidate.id}-${turnId}`}
            aria-label={`Use response from ${candidate.modelLabel}`}
            disabled={pendingAction !== null}
            onClick={() => { void requestAction("Response selection", () => onSelectCompareWinner(candidate.content, candidate.modelLabel), () => setCompareOpen(false)); }}
            style={{ ...turnStudioButtonStyle, alignSelf: "flex-start", marginTop: "4px" }}
          >Use this response</button> : null}
        </div>)}
      </div> : null}
    </div>
  );
}
