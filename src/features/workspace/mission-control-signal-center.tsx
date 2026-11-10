import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BellRing,
  Check,
  CheckCircle2,
  Clipboard,
  Clock3,
  Download,
  Eye,
  Info,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import type { RunTimelineEventView } from "./evidence-types";
import type { BackgroundWorkItem } from "./background-work-projection";
import {
  buildUnifiedEventProjection,
  dedupeUnifiedEvents,
  serializeUnifiedEventProjection,
  unifiedEventsFromSources,
  type UnifiedEventFilter,
  type UnifiedEventKind,
  type UnifiedEventRecord,
  type UnifiedEventSource,
  type UnifiedEventDurability,
  type UnifiedEventPriority,
} from "./unified-event-contract";
import type { NotificationItem } from "./notification-center-contract";
import { applySignalPreferencesToEvents, useSignalPreferences } from "./session-signal-contract";
import type { ConversationView, ProjectView } from "./types";

export interface MissionControlSignalCenterInput {
  readonly conversations?: readonly ConversationView[];
  readonly projects?: readonly ProjectView[];
  readonly backgroundWork?: readonly BackgroundWorkItem[];
  readonly notifications?: readonly NotificationItem[];
  readonly runTimeline?: readonly RunTimelineEventView[];
  readonly projectActivity?: readonly UnifiedEventRecord[];
}

export interface MissionControlSignalCenterProps extends MissionControlSignalCenterInput {
  readonly events?: readonly UnifiedEventRecord[];
  readonly onOpenEvent?: (event: UnifiedEventRecord) => void;
  readonly title?: string;
}

export const MISSION_CONTROL_BOUNDARY =
  "Renderer-local signal center. It is not a durable run journal or Project Twin revision. Review state is session-local; native scheduling, durable acknowledgement, provider dispatch, and OS notifications are not connected.";

const FILTER_LABELS: Record<UnifiedEventFilter, string> = {
  all: "All",
  unread: "Unread",
  attention: "Attention",
  active: "Active",
  completed: "Completed",
  failures: "Failures",
  planned: "Planned",
  chat: "Chat",
  project: "Project",
  background: "Background",
  notification: "Notifications",
  run: "Runs",
};

const FILTERS: readonly UnifiedEventFilter[] = [
  "all",
  "unread",
  "attention",
  "active",
  "completed",
  "planned",
  "chat",
  "project",
  "background",
  "notification",
  "run",
];

/**
 * Refinements are intentionally separate from the primary signal tabs. The
 * tabs answer "what kind of signal is this?" while these controls answer
 * "which slice should I inspect right now?". Keeping the shape exported makes
 * the Project Control Deck and other future workbenches able to reuse the
 * same renderer-local filtering contract without claiming a native query.
 */
export type MissionControlSignalPriorityFilter = "all" | UnifiedEventPriority;
export type MissionControlSignalInputFilter = "all" | "required" | "not-required";
export type MissionControlSignalDurabilityFilter = "all" | UnifiedEventDurability;
export type MissionControlSignalReviewFilter = "all" | "reviewed" | "unreviewed";

export interface MissionControlSignalRefinements {
  readonly priority: MissionControlSignalPriorityFilter;
  readonly input: MissionControlSignalInputFilter;
  readonly durability: MissionControlSignalDurabilityFilter;
  readonly review: MissionControlSignalReviewFilter;
}

export const DEFAULT_MISSION_CONTROL_SIGNAL_REFINEMENTS: MissionControlSignalRefinements = {
  priority: "all",
  input: "all",
  durability: "all",
  review: "all",
};

export function hasMissionControlSignalRefinements(
  refinements: MissionControlSignalRefinements,
): boolean {
  return refinements.priority !== "all"
    || refinements.input !== "all"
    || refinements.durability !== "all"
    || refinements.review !== "all";
}

/**
 * Apply only explicit, deterministic metadata refinements. Snooze and text
 * search remain component concerns because they depend on session clocks and
 * transient input. `reviewedIds` is also session-local by design.
 */
export function matchesMissionControlSignalRefinements(
  event: UnifiedEventRecord,
  refinements: MissionControlSignalRefinements,
  reviewedIds: ReadonlySet<string> = new Set(),
): boolean {
  if (refinements.priority !== "all" && event.priority !== refinements.priority) return false;
  if (refinements.input === "required" && !event.requiresInput) return false;
  if (refinements.input === "not-required" && event.requiresInput) return false;
  if (refinements.durability !== "all" && event.durability !== refinements.durability) return false;
  if (refinements.review === "reviewed" && !reviewedIds.has(event.id)) return false;
  if (refinements.review === "unreviewed" && reviewedIds.has(event.id)) return false;
  return true;
}

const SOURCE_LABELS: Record<UnifiedEventSource, string> = {
  chat: "Chat",
  project: "Project",
  background: "Background",
  notification: "Notification",
  run: "Run",
  system: "System",
};

const KIND_LABELS: Record<UnifiedEventKind, string> = {
  activity: "Activity",
  attention: "Attention",
  approval: "Approval",
  completion: "Completion",
  failure: "Failure",
  indexing: "Indexing",
  progress: "Progress",
  info: "Info",
};

const KIND_ICONS: Record<UnifiedEventKind, LucideIcon> = {
  activity: Activity,
  attention: AlertTriangle,
  approval: BellRing,
  completion: CheckCircle2,
  failure: AlertTriangle,
  indexing: Clock3,
  progress: Play,
  info: Info,
};

const PREVIEW_GENERATED_AT = "2026-09-21T10:00:00.000Z";

function textForConversation(conversation: ConversationView): string {
  if (conversation.runState === "failed") return "The latest visible run needs attention.";
  if (conversation.runState === "streaming") return "Assistant response is streaming in this Chat.";
  if (conversation.runState === "queued") return "This Chat is queued for its next visible run.";
  if (conversation.hasDraft) return "A local draft is waiting to be continued.";
  return conversation.excerpt || "No message preview is available.";
}

/**
 * Adapts visible Chat and Project metadata into the shared event vocabulary.
 * This is intentionally bounded and does not claim a durable event journal.
 */
export function unifiedEventsFromMissionControlSources(
  input: MissionControlSignalCenterInput,
): UnifiedEventRecord[] {
  const conversationEvents: UnifiedEventRecord[] = (input.conversations ?? [])
    .filter((conversation) => !conversation.archived)
    .filter((conversation) => conversation.unread || conversation.runState !== null || conversation.hasDraft)
    .slice(0, 24)
    .map((conversation) => {
      const failed = conversation.runState === "failed";
      const active = conversation.runState === "streaming" || conversation.runState === "queued";
      return {
        id: `chat:${conversation.id}`,
        dedupeKey: `chat:${conversation.id}`,
        source: "chat",
        kind: failed ? "attention" : active ? "progress" : "activity",
        state: failed ? "failed" : conversation.runState === "streaming" ? "running" : conversation.runState === "queued" ? "queued" : "info",
        visibility: conversation.unread || failed ? "unread" : "read",
        durability: "renderer-session",
        priority: failed ? "urgent" : conversation.runState === "streaming" ? "high" : "normal",
        title: conversation.title || "Untitled Chat",
        summary: textForConversation(conversation),
        detail: conversation.excerpt || null,
        occurredAt: conversation.updatedAt,
        sourceLabel: conversation.projectName ? `${conversation.projectName} · Chat` : "Chat workspace",
        sourceType: conversation.runState ? `chat.${conversation.runState}` : "chat.metadata",
        projectId: conversation.projectId,
        conversationId: conversation.id,
        runId: null,
        parentEventId: null,
        requiresInput: failed,
        actions: [
          { id: `chat:${conversation.id}:open`, label: "Open chat", kind: "open-chat", disposition: "available" },
        ],
        occurrenceCount: 1,
      } satisfies UnifiedEventRecord;
    });

  const projectEvents: UnifiedEventRecord[] = (input.projects ?? [])
    .filter((project) => !project.archived)
    .slice(0, 16)
    .map((project) => {
      const attention = (project.overview?.attentionItems.length ?? 0) > 0 || project.contextHealth === "missing-access" || project.contextHealth === "over-budget";
      const planned = project.contextHealth === "not-compiled" || project.contextHealth === "indexing";
      return {
        id: `project:${project.id}`,
        dedupeKey: `project:${project.id}`,
        source: "project",
        kind: attention ? "attention" : planned ? "progress" : "activity",
        state: attention ? "attention" : planned ? "planned" : "info",
        visibility: attention ? "unread" : "read",
        durability: planned ? "planned" : "renderer-session",
        priority: attention ? "high" : "normal",
        title: project.name || "Untitled Project",
        summary: attention
          ? project.overview?.attentionItems[0] ?? "Project context needs review."
          : planned
            ? `${project.contextHealth === "indexing" ? "Context indexing" : "Context compilation"} remains in preview.`
            : project.description || "Project metadata is visible in the renderer preview.",
        detail: `${project.conversationCount} conversation${project.conversationCount === 1 ? "" : "s"} · ${project.folders.length} workspace grant${project.folders.length === 1 ? "" : "s"}`,
        occurredAt: "Current selection",
        sourceLabel: "Project workspace",
        sourceType: "project.snapshot",
        projectId: project.id,
        conversationId: null,
        runId: null,
        parentEventId: null,
        requiresInput: attention,
        actions: [
          { id: `project:${project.id}:open`, label: "Open project", kind: "open-project", disposition: "available" },
        ],
        occurrenceCount: 1,
      } satisfies UnifiedEventRecord;
    });

  const sourceEvents = unifiedEventsFromSources({
    projectActivity: [],
    ...(input.notifications ? { notifications: input.notifications } : {}),
    ...(input.backgroundWork ? { backgroundWork: input.backgroundWork } : {}),
    ...(input.runTimeline ? { runTimeline: input.runTimeline } : {}),
  });

  return dedupeUnifiedEvents([
    ...sourceEvents,
    ...conversationEvents,
    ...projectEvents,
    ...(input.projectActivity ?? []),
  ]);
}

function readableOccurredAt(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(parsed));
}

function eventIcon(kind: UnifiedEventKind) {
  const Icon = KIND_ICONS[kind];
  return <Icon size={14} aria-hidden="true" />;
}

function eventActionLabel(event: UnifiedEventRecord): string {
  if (event.conversationId) return "Open chat preview";
  if (event.projectId) return "Open project preview";
  if (event.source === "background" || event.source === "run") return "Inspect work preview";
  return "Inspect signal";
}

/**
 * Session-only snooze predicate. Keeping the expiry timestamp in the
 * component means a snooze never masquerades as a durable acknowledgement or
 * a native notification mutation.
 */
export function isSignalSnoozed(expiresAt: number | undefined, now: number): boolean {
  return typeof expiresAt === "number" && expiresAt > now;
}

export function MissionControlSignalCenter({
  events: explicitEvents,
  onOpenEvent,
  title = "Mission Control signal center",
  ...input
}: MissionControlSignalCenterProps) {
  // A signal center can appear in Home and inside a Project deck during
  // transitions. Keep the heading relationship unique per instance so the
  // lazy Project surface never creates duplicate labelled regions.
  const titleId = useId();
  const signalSession = useSignalPreferences();
  const derivedEvents = useMemo(
    () => explicitEvents ? dedupeUnifiedEvents(explicitEvents) : unifiedEventsFromMissionControlSources(input),
    [explicitEvents, input.backgroundWork, input.conversations, input.notifications, input.projectActivity, input.projects, input.runTimeline],
  );
  const sessionEvents = useMemo(
    () => applySignalPreferencesToEvents(derivedEvents, signalSession.present),
    [derivedEvents, signalSession.present],
  );
  const [filter, setFilter] = useState<UnifiedEventFilter>(() => signalSession.present.defaultFilter);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(sessionEvents[0]?.id ?? null);
  const [reviewedIds, setReviewedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [snoozedUntil, setSnoozedUntil] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());
  const [status, setStatus] = useState("Session-local signal view; no durable acknowledgement.");
  const [exportOpen, setExportOpen] = useState(false);
  const [format, setFormat] = useState<"json" | "markdown">("json");
  const [refinements, setRefinements] = useState<MissionControlSignalRefinements>(
    DEFAULT_MISSION_CONTROL_SIGNAL_REFINEMENTS,
  );

  useEffect(() => {
    setFilter(signalSession.present.defaultFilter);
  }, [signalSession.present.defaultFilter]);

  useEffect(() => {
    if (selectedId && sessionEvents.some((event) => event.id === selectedId)) return;
    setSelectedId(sessionEvents[0]?.id ?? null);
  }, [selectedId, sessionEvents]);

  useEffect(() => {
    // Changing source preferences is a new visible session slice. Reset the
    // local refinement controls so a hidden stale filter never looks like a
    // native query or silently removes newly enabled sources.
    setRefinements(DEFAULT_MISSION_CONTROL_SIGNAL_REFINEMENTS);
  }, [
    signalSession.present.enabledSources.chat,
    signalSession.present.enabledSources.project,
    signalSession.present.enabledSources.background,
    signalSession.present.enabledSources.notification,
    signalSession.present.enabledSources.run,
  ]);

  useEffect(() => {
    if (snoozedUntil.size === 0) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [snoozedUntil]);

  useEffect(() => {
    const expired = [...snoozedUntil].filter(([, expiresAt]) => !isSignalSnoozed(expiresAt, now));
    if (expired.length === 0) return;
    setSnoozedUntil((current) => {
      const next = new Map(current);
      expired.forEach(([id]) => next.delete(id));
      return next;
    });
  }, [now, snoozedUntil]);

  const projection = useMemo(
    () => buildUnifiedEventProjection({ events: sessionEvents, generatedAt: PREVIEW_GENERATED_AT, selectedFilter: filter }),
    [sessionEvents, filter],
  );
  const visibleEvents = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return projection.events.filter((event) => {
      if (!matchesMissionControlSignalRefinements(event, refinements, reviewedIds)) return false;
      if (isSignalSnoozed(snoozedUntil.get(event.id), now)) return false;
      if (!normalized) return true;
      return [event.title, event.summary, event.detail ?? "", event.sourceLabel, event.source, event.state]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalized);
    });
  }, [now, projection.events, query, refinements, reviewedIds, snoozedUntil]);
  const selectedEvent = visibleEvents.find((event) => event.id === selectedId) ?? visibleEvents[0] ?? null;
  const exportProjection = useMemo(
    () => signalSession.present.includeDetails
      ? projection
      : { ...projection, events: projection.events.map((event) => ({ ...event, detail: null })) },
    [projection, signalSession.present.includeDetails],
  );
  const exportPayload = useMemo(() => serializeUnifiedEventProjection(exportProjection, format), [exportProjection, format]);

  const markReviewed = (event: UnifiedEventRecord) => {
    setReviewedIds((current) => new Set([...current, event.id]));
    setStatus(`Marked “${event.title}” reviewed in this renderer session.`);
  };

  const snooze = (event: UnifiedEventRecord) => {
    const expiresAt = Date.now() + signalSession.present.snoozeMinutes * 60_000;
    setNow(Date.now());
    setSnoozedUntil((current) => new Map(current).set(event.id, expiresAt));
    setStatus(`Snoozed “${event.title}” for ${signalSession.present.snoozeMinutes} minutes in this renderer session only.`);
  };

  const handleOpen = (event: UnifiedEventRecord) => {
    setSelectedId(event.id);
    if (signalSession.present.reviewMode === "on-open") {
      setReviewedIds((current) => new Set([...current, event.id]));
    }
    setStatus(`${eventActionLabel(event)} requested; no native dispatch was started.`);
    onOpenEvent?.(event);
  };

  const selectEvent = (event: UnifiedEventRecord) => {
    setSelectedId(event.id);
    if (signalSession.present.reviewMode === "after-open") {
      setReviewedIds((current) => new Set([...current, event.id]));
    }
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard is unavailable; no signal export was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatus(`${format.toUpperCase()} signal projection copied; no durable write was made.`);
    } catch {
      setStatus("Clipboard access was denied; the signal projection remains renderer-local.");
    }
  };

  return (
    <section className={`mission-control-signal-center${signalSession.present.compactMode ? " is-compact" : ""}`} aria-labelledby={titleId}>
      <header className="mission-control-signal-center__header">
        <div>
          <span className="eyebrow"><Sparkles size={13} /> Mission Control</span>
          <h2 id={titleId}>{title}</h2>
          <p>One bounded stream for Chat, Project, Background Work, Run, and Notification signals.</p>
        </div>
        <span className="mission-control-signal-center__badge"><Eye size={12} /> Renderer-local</span>
      </header>

      <div className="mission-control-signal-center__metrics" aria-label="Mission Control signal counts">
        <button type="button" className={filter === "all" ? "is-active" : ""} title="Show all workspace signals" aria-label={`Show all workspace signals (${projection.counts.total})`} onClick={() => setFilter("all")}><strong>{projection.counts.total}</strong><span>Signals</span></button>
        <button type="button" className={filter === "unread" ? "is-active" : ""} title="Show unread workspace signals" aria-label={`Show unread workspace signals (${projection.counts.unread})`} onClick={() => setFilter("unread")}><strong>{projection.counts.unread}</strong><span>Unread</span></button>
        <button type="button" className={filter === "attention" ? "is-active" : ""} title="Show signals needing attention" aria-label={`Show signals needing attention (${projection.counts.attention})`} onClick={() => setFilter("attention")}><strong>{projection.counts.attention}</strong><span>Attention</span></button>
        <button type="button" className={filter === "active" ? "is-active" : ""} title="Show active workspace signals" aria-label={`Show active workspace signals (${projection.counts.active})`} onClick={() => setFilter("active")}><strong>{projection.counts.active}</strong><span>Active</span></button>
        <button type="button" className={filter === "planned" ? "is-active" : ""} title="Show planned workspace signals" aria-label={`Show planned workspace signals (${projection.counts.planned})`} onClick={() => setFilter("planned")}><strong>{projection.counts.planned}</strong><span>Planned</span></button>
      </div>

      <nav className="mission-control-signal-center__filters" aria-label="Mission Control signal filters" role="tablist">
        {FILTERS.map((value) => <button key={value} type="button" role="tab" title={`Filter signals: ${FILTER_LABELS[value]}`} aria-label={FILTER_LABELS[value]} aria-selected={filter === value} className={filter === value ? "is-active" : ""} onClick={() => setFilter(value)}>{FILTER_LABELS[value]}</button>)}
      </nav>

      <div className="mission-control-signal-center__search">
        <Search size={13} aria-hidden="true" />
        <label className="sr-only" htmlFor="mission-control-signal-search">Search Mission Control signals</label>
        <input id="mission-control-signal-search" type="search" title="Search Mission Control signals by title, source, state, or detail" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, source, state, or detail" />
        {query ? <button type="button" title="Clear Mission Control signal search" aria-label="Clear Mission Control signal search" onClick={() => setQuery("")}><X size={13} /></button> : null}
      </div>

      <div className="mission-control-signal-center__refinements" role="group" aria-label="Mission Control signal refinements">
        <span className="mission-control-signal-center__refinements-label"><Sparkles size={12} /> Refine this signal slice</span>
        <label>
          <span>Priority</span>
          <select
            aria-label="Signal priority filter"
            value={refinements.priority}
            onChange={(event) => setRefinements((current) => ({ ...current, priority: event.target.value as MissionControlSignalPriorityFilter }))}
          >
            <option value="all">Any priority</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label>
          <span>Input</span>
          <select
            aria-label="Signal input filter"
            value={refinements.input}
            onChange={(event) => setRefinements((current) => ({ ...current, input: event.target.value as MissionControlSignalInputFilter }))}
          >
            <option value="all">Any input state</option>
            <option value="required">Needs my input</option>
            <option value="not-required">No input needed</option>
          </select>
        </label>
        <label>
          <span>Boundary</span>
          <select
            aria-label="Signal durability filter"
            value={refinements.durability}
            onChange={(event) => setRefinements((current) => ({ ...current, durability: event.target.value as MissionControlSignalDurabilityFilter }))}
          >
            <option value="all">Any boundary</option>
            <option value="renderer-session">Renderer session</option>
            <option value="native-projection">Native projection</option>
            <option value="planned">Planned</option>
          </select>
        </label>
        <label>
          <span>Review</span>
          <select
            aria-label="Signal review filter"
            value={refinements.review}
            onChange={(event) => setRefinements((current) => ({ ...current, review: event.target.value as MissionControlSignalReviewFilter }))}
          >
            <option value="all">All review states</option>
            <option value="unreviewed">Unreviewed</option>
            <option value="reviewed">Reviewed</option>
          </select>
        </label>
        {hasMissionControlSignalRefinements(refinements) ? (
          <button
            type="button"
            className="button button--ghost"
            title="Clear priority, input, boundary, and review refinements"
            onClick={() => setRefinements(DEFAULT_MISSION_CONTROL_SIGNAL_REFINEMENTS)}
            aria-label="Clear Mission Control signal refinements"
          >
            Clear refinements
          </button>
        ) : null}
        <span className="mission-control-signal-center__refinements-count" aria-live="polite">
          {visibleEvents.length} visible after refinements
        </span>
      </div>

      <div className="mission-control-signal-center__body">
        <div className="mission-control-signal-center__list-wrap">
          <div className="mission-control-signal-center__list-heading"><span><BellRing size={13} /> Signal feed</span><small>{visibleEvents.length} of {projection.events.length} in this view</small></div>
          {visibleEvents.length > 0 ? (
            <div className="mission-control-signal-center__list" role="list" aria-label="Mission Control signals">
              {visibleEvents.map((event) => {
                const reviewed = reviewedIds.has(event.id);
                return (
                  <article key={event.id} role="listitem" className={`mission-control-signal-center__item mission-control-signal-center__item--${event.kind}${selectedEvent?.id === event.id ? " is-selected" : ""}${reviewed ? " is-reviewed" : ""}`}>
                    <button type="button" className="mission-control-signal-center__item-main" title={`Inspect signal: ${event.title}`} onClick={() => selectEvent(event)} aria-pressed={selectedEvent?.id === event.id}>
                      <span className="mission-control-signal-center__item-icon">{eventIcon(event.kind)}</span>
                      <span className="mission-control-signal-center__item-copy"><span className="mission-control-signal-center__item-topline"><strong>{event.title}</strong><em>{reviewed ? "Reviewed" : event.state}</em></span><span>{event.summary}</span><small>{SOURCE_LABELS[event.source]} · {readableOccurredAt(event.occurredAt)}</small></span>
                      <span className={`mission-control-signal-center__priority mission-control-signal-center__priority--${event.priority}`}>{event.priority}</span>
                    </button>
                    <div className="mission-control-signal-center__item-actions" aria-label={`${event.title} signal actions`}>
                      <button type="button" className="button button--ghost" title={eventActionLabel(event)} onClick={() => handleOpen(event)}><ArrowUpRight size={12} /> {eventActionLabel(event)}</button>
                      <button type="button" className="button button--ghost" title={reviewed ? "This signal is already reviewed" : "Mark this signal reviewed in the renderer session"} onClick={() => markReviewed(event)} disabled={reviewed}><Check size={12} /> {reviewed ? "Reviewed" : "Mark reviewed"}</button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : <p className="mission-control-signal-center__empty">No signals match this view. Try another filter or clear the search.</p>}
        </div>

        <aside className="mission-control-signal-center__detail" aria-label={selectedEvent ? `Selected signal ${selectedEvent.title}` : "Selected signal detail"}>
          {selectedEvent ? <>
            <header><span className={`mission-control-signal-center__detail-icon mission-control-signal-center__detail-icon--${selectedEvent.kind}`}>{eventIcon(selectedEvent.kind)}</span><div><span className="eyebrow">Selected signal</span><h3>{selectedEvent.title}</h3></div></header>
            <p>{selectedEvent.summary}</p>
            <dl><div><dt>Source</dt><dd>{SOURCE_LABELS[selectedEvent.source]}</dd></div><div><dt>Kind / state</dt><dd>{KIND_LABELS[selectedEvent.kind]} · {selectedEvent.state}</dd></div><div><dt>Priority</dt><dd>{selectedEvent.priority}</dd></div><div><dt>Durability</dt><dd>{selectedEvent.durability}</dd></div><div><dt>Observed</dt><dd>{readableOccurredAt(selectedEvent.occurredAt)}</dd></div><div><dt>Requires input</dt><dd>{selectedEvent.requiresInput ? "Yes" : "No"}</dd></div></dl>
            {signalSession.present.includeDetails && selectedEvent.detail ? <p className="mission-control-signal-center__detail-copy">{selectedEvent.detail}</p> : null}
            <div className="mission-control-signal-center__detail-actions">
              <button type="button" className="button button--secondary" title={`${eventActionLabel(selectedEvent)} in the renderer preview`} onClick={() => handleOpen(selectedEvent)}><ArrowUpRight size={13} /> {eventActionLabel(selectedEvent)}</button>
              <button type="button" className="button button--ghost" title={reviewedIds.has(selectedEvent.id) ? "This signal is already reviewed" : "Mark this signal reviewed in the renderer session"} onClick={() => markReviewed(selectedEvent)} disabled={reviewedIds.has(selectedEvent.id)}><Check size={13} /> {reviewedIds.has(selectedEvent.id) ? "Reviewed" : "Mark reviewed"}</button>
              <button type="button" className="button button--ghost" title={`Snooze this signal for ${signalSession.present.snoozeMinutes} minutes in the renderer session`} onClick={() => snooze(selectedEvent)}><Clock3 size={13} /> Snooze session</button>
            </div>
          </> : <p className="mission-control-signal-center__empty">Select a signal to inspect its source, state, and boundary.</p>}
        </aside>
      </div>

      <p className="mission-control-signal-center__status" role="status" aria-live="polite">{status}</p>
      <section className="mission-control-signal-center__export" aria-label="Mission Control signal export preview">
        <header><div><span className="eyebrow"><Clipboard size={13} /> Portable projection</span><h3>Export the visible signal set</h3></div><button type="button" className="button button--secondary" title={exportOpen ? "Hide the Mission Control export preview" : "Preview the renderer-local Mission Control export"} onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="mission-control-signal-export"><Download size={13} /> {exportOpen ? "Hide export" : "Preview export"}</button></header>
        {exportOpen ? <div id="mission-control-signal-export" className="mission-control-signal-center__export-body"><div className="mission-control-signal-center__export-toolbar"><label><span>Format</span><select aria-label="Mission Control signal export format" value={format} onChange={(event) => setFormat(event.target.value as "json" | "markdown")}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" title="Copy the renderer-local Mission Control export" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button></div><pre tabIndex={0} aria-label={`${format === "json" ? "JSON" : "Markdown"} Mission Control signal export preview`}>{exportPayload}</pre></div> : null}
      </section>
      <p className="mission-control-signal-center__boundary"><ShieldCheck size={14} /> {MISSION_CONTROL_BOUNDARY}</p>
    </section>
  );
}

export default MissionControlSignalCenter;
