import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  CircleDot,
  Download,
  Info,
  ListFilter,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { RunCheckpointProjection, RunControlOperationProjection } from "./run-control-projection";
import type { RunTimelineEventView } from "./evidence-types";
import {
  buildUnifiedEventProjection,
  dedupeUnifiedEvents,
  unifiedEventFromRunTimeline,
  unifiedEventsFromSources,
  serializeUnifiedEventProjection,
  type UnifiedEventFilter,
  type UnifiedEventFormat,
  type UnifiedEventRecord,
  type UnifiedEventProjection,
} from "./unified-event-contract";
import { projectBackgroundWork } from "./background-work-projection";
import { useWorkspaceStore } from "./store";
import { applySignalPreferencesToEvents, useSignalPreferences } from "./session-signal-contract";
import type { ConversationView } from "./types";

export type ChatSignalFilter = "all" | "unread" | "attention" | "active" | "completed" | "planned" | "failures";

const filters: readonly { id: ChatSignalFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "attention", label: "Attention" },
  { id: "active", label: "Active" },
  { id: "completed", label: "Done" },
  { id: "planned", label: "Planned" },
  { id: "failures", label: "Failures" },
];

const filterToUnified: Record<ChatSignalFilter, UnifiedEventFilter> = {
  all: "all",
  unread: "unread",
  attention: "attention",
  active: "active",
  completed: "completed",
  planned: "planned",
  failures: "failures",
};

export interface ChatSignalProjectionInput {
  readonly conversation: ConversationView;
  readonly conversations: readonly ConversationView[];
  readonly runTimelineEvents?: readonly RunTimelineEventView[];
  readonly runControlOperations?: readonly RunControlOperationProjection[];
  readonly checkpoints?: readonly RunCheckpointProjection[];
  readonly generatedAt?: string;
}

function localEvent(
  conversation: ConversationView,
  input: Pick<UnifiedEventRecord, "id" | "kind" | "state" | "visibility" | "priority" | "title" | "summary" | "requiresInput">,
): UnifiedEventRecord {
  return {
    id: input.id,
    dedupeKey: input.id,
    source: "chat",
    kind: input.kind,
    state: input.state,
    visibility: input.visibility,
    durability: "renderer-session",
    priority: input.priority,
    title: input.title,
    summary: input.summary,
    detail: conversation.excerpt || null,
    occurredAt: conversation.updatedAt,
    sourceLabel: "Chat state",
    sourceType: "conversation",
    projectId: conversation.projectId,
    conversationId: conversation.id,
    runId: null,
    parentEventId: null,
    requiresInput: input.requiresInput,
    actions: [],
    occurrenceCount: 1,
  };
}

/**
 * Builds the bounded signal projection for one Chat. The projection is made
 * exclusively from facts already visible in the renderer store. Native event
 * journals, durable acknowledgement, provider dispatch, and scheduling stay
 * outside this helper by design.
 */
export function buildChatSignalProjection(
  input: ChatSignalProjectionInput,
  filter: ChatSignalFilter = "all",
): UnifiedEventProjection {
  const runTimelineEvents = input.runTimelineEvents ?? [];
  const runIds = new Set(
    input.conversation.messages
      .map((message) => message.runId)
      .filter((runId): runId is string => runId !== null),
  );
  const backgroundProjection = projectBackgroundWork({
    conversations: input.conversations,
    runTimelineEvents,
    runControlOperations: input.runControlOperations ?? [],
    checkpoints: input.checkpoints ?? [],
    generatedAt: input.generatedAt ?? input.conversation.updatedAt,
  });
  const backgroundEvents = unifiedEventsFromSources({ backgroundWork: backgroundProjection.items });
  const timelineEvents = runTimelineEvents
    .filter((event) => runIds.has(event.runId))
    .map(unifiedEventFromRunTimeline);

  const localEvents: UnifiedEventRecord[] = [];
  if (input.conversation.unread) {
    localEvents.push(localEvent(input.conversation, {
      id: `chat:${input.conversation.id}:unread`,
      kind: "attention",
      state: "attention",
      visibility: "unread",
      priority: "high",
      title: "Unread chat activity",
      summary: "This conversation has unread activity in the current renderer projection.",
      requiresInput: false,
    }));
  }
  if (input.conversation.hasDraft) {
    localEvents.push(localEvent(input.conversation, {
      id: `chat:${input.conversation.id}:draft`,
      kind: "info",
      state: "waiting",
      visibility: "read",
      priority: "normal",
      title: "Draft ready to continue",
      summary: "A local draft is waiting in the composer; sending remains a separate user action.",
      requiresInput: false,
    }));
  }

  const scopedEvents = [...backgroundEvents, ...timelineEvents, ...localEvents].filter((event) => (
    event.conversationId === input.conversation.id ||
    (event.runId !== null && runIds.has(event.runId))
  ));
  return buildUnifiedEventProjection({
    events: dedupeUnifiedEvents(scopedEvents),
    generatedAt: input.generatedAt ?? input.conversation.updatedAt,
    selectedFilter: filterToUnified[filter],
  });
}

function eventIcon(event: UnifiedEventRecord) {
  if (event.state === "failed" || event.kind === "failure") return <XCircle size={14} aria-hidden="true" />;
  if (event.kind === "attention" || event.requiresInput || event.state === "attention") return <AlertTriangle size={14} aria-hidden="true" />;
  if (event.state === "completed") return <CheckCircle2 size={14} aria-hidden="true" />;
  if (event.state === "running" || event.state === "queued" || event.state === "waiting") return <CircleDot size={14} aria-hidden="true" />;
  return <Info size={14} aria-hidden="true" />;
}

function eventTone(event: UnifiedEventRecord): string {
  if (event.state === "failed" || event.kind === "failure") return "failure";
  if (event.kind === "attention" || event.requiresInput || event.state === "attention") return "attention";
  if (event.state === "completed") return "completed";
  if (event.state === "running" || event.state === "queued" || event.state === "waiting") return "active";
  return "info";
}

function eventStateLabel(event: UnifiedEventRecord): string {
  if (event.state === "running") return "Active";
  if (event.state === "queued") return "Queued";
  if (event.state === "waiting") return "Waiting";
  if (event.state === "completed") return "Done";
  if (event.state === "failed") return "Failed";
  if (event.state === "attention") return "Attention";
  if (event.state === "planned") return "Planned";
  return "Info";
}

function primarySignalLabel(projection: UnifiedEventProjection): string {
  if (projection.counts.attention > 0) return `${projection.counts.attention} needs attention`;
  if (projection.counts.active > 0) return `${projection.counts.active} active`;
  if (projection.counts.failures > 0) return `${projection.counts.failures} failed`;
  if (projection.counts.completed > 0) return `${projection.counts.completed} completed`;
  return "Quiet signal stream";
}

function countForFilter(projection: UnifiedEventProjection, filter: ChatSignalFilter): number {
  if (filter === "all") return projection.counts.total;
  if (filter === "unread") return projection.counts.unread;
  if (filter === "attention") return projection.counts.attention;
  if (filter === "active") return projection.counts.active;
  if (filter === "completed") return projection.counts.completed;
  if (filter === "planned") return projection.counts.planned;
  return projection.counts.failures;
}

export interface ChatSignalStripProps {
  readonly conversation: ConversationView;
  readonly onOpenRunInspector?: () => void;
}

/** Compact Chat-local view of the shared unified event projection. */
export function ChatSignalStrip({ conversation, onOpenRunInspector }: ChatSignalStripProps) {
  const conversations = useWorkspaceStore((state) => state.conversations);
  const runTimelineEvents = useWorkspaceStore((state) => state.runTimelineEvents);
  const runControlOperationsById = useWorkspaceStore((state) => state.runControlOperationsById);
  const checkpointsByRunId = useWorkspaceStore((state) => state.checkpointsByRunId);
  const signalSession = useSignalPreferences();
  const defaultChatFilter: ChatSignalFilter = signalSession.present.defaultFilter;
  const [filter, setFilter] = useState<ChatSignalFilter>(defaultChatFilter);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState("Renderer-local signal projection; no acknowledgement was sent.");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<UnifiedEventFormat>("json");
  const [showAllEvents, setShowAllEvents] = useState(false);
  const filterButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    setFilter(defaultChatFilter);
    setShowAllEvents(false);
  }, [defaultChatFilter]);
  const projection = useMemo(
    () => {
      const base = buildChatSignalProjection({
        conversation,
        conversations,
        runTimelineEvents,
        runControlOperations: Object.values(runControlOperationsById),
        checkpoints: Object.values(checkpointsByRunId),
        generatedAt: conversation.updatedAt,
      }, "all");
      const events = applySignalPreferencesToEvents(base.events, signalSession.present);
      return buildUnifiedEventProjection({
        events: signalSession.present.includeDetails ? events : events.map((event) => ({ ...event, detail: null })),
        generatedAt: base.generatedAt,
        selectedFilter: filterToUnified[filter],
      });
    },
    [checkpointsByRunId, conversation, conversations, filter, runControlOperationsById, runTimelineEvents, signalSession.present],
  );
  const selected = projection.events.find((event) => event.id === selectedId) ?? projection.events[0] ?? null;
  const visibleEvents = showAllEvents ? projection.events : projection.events.slice(0, 4);
  const hasHiddenEvents = projection.events.length > visibleEvents.length;
  const visibleCountLabel = projection.events.length > visibleEvents.length
    ? `showing ${visibleEvents.length} of ${projection.events.length}`
    : `showing ${projection.events.length}`;
  const exportPayload = useMemo(
    () => serializeUnifiedEventProjection(projection, exportFormat),
    [exportFormat, projection],
  );

  const inspectEvent = (event: UnifiedEventRecord) => {
    setSelectedId(event.id);
    if (event.runId && onOpenRunInspector) {
      onOpenRunInspector();
      setStatus("Run inspector selected in this renderer session; no native acknowledgement was sent.");
      return;
    }
    setStatus(`${event.title} selected in the renderer projection; no durable state changed.`);
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; the export preview remains available below.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatus(`${exportFormat.toUpperCase()} signal export copied; no durable state changed.`);
    } catch {
      setStatus("Clipboard access was denied; the export preview remains available below.");
    }
  };

  const downloadExport = () => {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      setStatus("Download is unavailable in this preview; copy the export from the visible payload instead.");
      return;
    }
    const blob = new Blob([exportPayload], {
      type: exportFormat === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `omnia-chat-signals-${conversation.id}.${exportFormat === "json" ? "json" : "md"}`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL?.(url), 0);
    setStatus(`${exportFormat.toUpperCase()} signal export prepared for download; no durable state changed.`);
  };

  const selectFilter = (nextFilter: ChatSignalFilter) => {
    setFilter(nextFilter);
    setShowAllEvents(false);
  };

  const moveFilter = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? filters.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + filters.length) % filters.length;
    const next = filters[nextIndex];
    if (!next) return;
    selectFilter(next.id);
    filterButtonRefs.current[nextIndex]?.focus({ preventScroll: true });
  };

  return (
    <section className={`chat-signal-strip${signalSession.present.compactMode ? " is-compact" : ""}`} aria-label="Chat signal strip">
      <header className="chat-signal-strip__header">
        <div className="chat-signal-strip__title">
          <span className="chat-signal-strip__mark"><Sparkles size={13} aria-hidden="true" /></span>
          <span><strong>Chat signals</strong><small>{primarySignalLabel(projection)} · {visibleCountLabel}</small></span>
        </div>
        <div className="chat-signal-strip__header-actions">
          <span className="chat-signal-strip__boundary"><ShieldCheck size={12} aria-hidden="true" /> Renderer-local</span>
          <button
            type="button"
            className="button button--ghost chat-signal-strip__export-toggle"
            aria-expanded={exportOpen}
            aria-controls="chat-signal-export"
            title={exportOpen ? "Hide the Chat signal export preview" : "Open the Chat signal export preview"}
            onClick={() => setExportOpen((value) => !value)}
          >
            <Download size={12} aria-hidden="true" /> {exportOpen ? "Hide export" : "Export"}
          </button>
        </div>
      </header>

      <div className="chat-signal-strip__metrics" aria-label="Chat signal counts">
        <span className="chat-signal-strip__metric"><strong>{projection.counts.attention}</strong><small>Attention</small></span>
        <span className="chat-signal-strip__metric"><strong>{projection.counts.active}</strong><small>Active</small></span>
        <span className="chat-signal-strip__metric"><strong>{projection.counts.completed}</strong><small>Done</small></span>
        <span className="chat-signal-strip__metric"><strong>{projection.counts.failures}</strong><small>Failed</small></span>
      </div>

      <nav className="chat-signal-strip__filters" aria-label="Chat signal filters" role="tablist">
        <ListFilter size={12} aria-hidden="true" />
        {filters.map((item, index) => (
          <button
            key={item.id}
            id={`chat-signal-filter-${item.id}`}
            ref={(element) => { filterButtonRefs.current[index] = element; }}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            aria-controls="chat-signal-events"
            tabIndex={filter === item.id ? 0 : -1}
            className={filter === item.id ? "is-active" : ""}
            title={`Show ${item.label.toLowerCase()} Chat signals`}
            onClick={() => selectFilter(item.id)}
            onKeyDown={(event) => moveFilter(event, index)}
          >
            {item.label}
            <span>{countForFilter(projection, item.id)}</span>
          </button>
        ))}
      </nav>

      <div id="chat-signal-events" className="chat-signal-strip__events" role="list" aria-label={`Chat signals, ${visibleCountLabel}`}>
        {projection.events.length === 0 ? <p className="chat-signal-strip__empty">No signals match this filter. The conversation remains renderer-local and ready for input.</p> : null}
        {visibleEvents.map((event) => (
          <button key={event.id} type="button" role="listitem" aria-label={`${event.title}: ${event.summary}`} title={`${event.title}: ${event.summary}`} className={`chat-signal-strip__event chat-signal-strip__event--${eventTone(event)} ${selected?.id === event.id ? "is-selected" : ""}`} onClick={() => inspectEvent(event)} aria-pressed={selected?.id === event.id}>
            <span className="chat-signal-strip__event-icon">{eventIcon(event)}</span>
            <span className="chat-signal-strip__event-copy"><strong>{event.title}</strong><small>{event.summary}</small></span>
            <span className="chat-signal-strip__event-state">{eventStateLabel(event)}{event.occurrenceCount > 1 ? ` · ${event.occurrenceCount}` : ""}</span>
          </button>
        ))}
      </div>

      {projection.events.length > 4 ? (
        <button
          type="button"
          className="button button--ghost chat-signal-strip__expand"
          aria-expanded={showAllEvents}
          title={showAllEvents ? "Collapse the Chat signal list" : "Show all Chat signals"}
          onClick={() => setShowAllEvents((value) => !value)}
        >
          {showAllEvents ? "Show fewer signals" : `Show all ${projection.events.length} signals`}
          {!showAllEvents && hasHiddenEvents ? ` · ${projection.events.length - visibleEvents.length} more` : ""}
        </button>
      ) : null}

      {exportOpen ? (
        <div id="chat-signal-export" className="chat-signal-strip__export" role="group" aria-label="Chat signal export preview">
          <div className="chat-signal-strip__export-toolbar">
            <label>
              <span>Format</span>
              <select
                aria-label="Chat signal export format"
                value={exportFormat}
                onChange={(event) => setExportFormat(event.target.value as UnifiedEventFormat)}
              >
                <option value="json">JSON</option>
                <option value="markdown">Markdown</option>
              </select>
            </label>
            <button type="button" className="button button--ghost" onClick={() => void copyExport()} title="Copy the Chat signal export preview">
              <Clipboard size={12} aria-hidden="true" /> Copy
            </button>
            <button type="button" className="button button--ghost" onClick={downloadExport} title="Download the Chat signal export preview">
              <Download size={12} aria-hidden="true" /> Download
            </button>
          </div>
          <pre tabIndex={0} aria-label={`${exportFormat === "json" ? "JSON" : "Markdown"} Chat signal export preview`}>
            {exportPayload}
          </pre>
          <small>Preview only · renderer-local · no durable write.</small>
        </div>
      ) : null}

      <footer className="chat-signal-strip__footer" role="status" aria-live="polite">
        <span>{status}</span>
        {selected?.runId && onOpenRunInspector ? <button type="button" className="button button--ghost" onClick={() => onOpenRunInspector()} title="Open the selected run inspector">Open run inspector</button> : null}
      </footer>
    </section>
  );
}
