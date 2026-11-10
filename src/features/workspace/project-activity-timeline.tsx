import {
  CalendarClock,
  CheckCircle2,
  Clipboard,
  Download,
  ArrowUpRight,
  Bookmark,
  BookmarkCheck,
  Filter,
  FolderOpen,
  History,
  LockKeyhole,
  MessageSquareText,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Waypoints,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ConversationView, ProjectView } from "./types";
import { buildProjectContextAvailabilityForProject } from "./project-context-availability-contract";

export type ProjectActivityKind = "project" | "chat" | "workspace" | "context";
export type ProjectActivityStatus = "preview" | "planned";
export type ProjectActivityExportFormat = "json" | "markdown";
export type ProjectActivitySort = "default" | "title" | "kind" | "status";

export interface ProjectActivityFilters {
  readonly query?: string;
  readonly kind?: ProjectActivityKind | "all";
  readonly status?: ProjectActivityStatus | "all";
  readonly sourceLabel?: string | "all";
  readonly bookmarkedOnly?: boolean;
  readonly bookmarkedIds?: ReadonlySet<string>;
}

/**
 * Renderer-local bookmark notes keyed by the stable activity event id.
 * An entry is a bookmark even when its note is an empty string.
 */
export type ProjectActivityBookmarks = Readonly<Record<string, string>>;

export interface ProjectActivityEvent {
  readonly id: string;
  readonly kind: ProjectActivityKind;
  readonly type: string;
  readonly title: string;
  readonly detail: string;
  readonly occurredAt: string;
  readonly actor: string;
  readonly status: ProjectActivityStatus;
  readonly sourceLabel: string;
  readonly relatedId: string | null;
  readonly relatedLabel: string | null;
}

export interface ProjectActivityTimelineProps {
  readonly project: ProjectView;
  readonly conversations: readonly ConversationView[];
  readonly onOpenRelated?: (event: ProjectActivityEvent) => void;
}

const PROJECT_ACTIVITY_EXPORT_FORMAT = "omnia.project-activity.preview.v1" as const;
const PROJECT_ACTIVITY_BOUNDARY =
  "Renderer-local activity projection only. It is not a durable run journal, security audit chain, or native Project Twin revision.";

const KIND_LABELS: Record<ProjectActivityKind, string> = {
  project: "Project",
  chat: "Chat",
  workspace: "Workspace",
  context: "Context",
};

const KIND_ICONS: Record<ProjectActivityKind, typeof Sparkles> = {
  project: Sparkles,
  chat: MessageSquareText,
  workspace: FolderOpen,
  context: Waypoints,
};

function contextLabel(project: ProjectView): string {
  return buildProjectContextAvailabilityForProject(project).label;
}

function chatDetail(chat: ConversationView): string {
  const state = chat.archived
    ? "Archived"
    : chat.runState === "streaming"
      ? "Run in progress"
      : chat.runState === "queued"
        ? "Queued"
        : chat.runState === "failed"
          ? "Needs attention"
          : chat.hasDraft
            ? "Draft present"
            : "Ready to continue";
  return [state, chat.excerpt || "No message preview yet."].join(" · ");
}

/**
 * Builds a bounded, renderer-safe activity feed from the facts already visible
 * in the Project surface. It intentionally does not invent durable timestamps
 * or claim that a native activity journal has been hydrated.
 */
export function buildProjectActivityEvents(
  project: ProjectView,
  conversations: readonly ConversationView[],
): ProjectActivityEvent[] {
  const projectConversations = conversations
    .filter((conversation) => conversation.projectId === project.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const events: ProjectActivityEvent[] = [
    {
      id: `${project.id}:project-metadata`,
      kind: "project",
      type: "project.snapshot",
      title: "Project metadata is visible",
      detail: `${project.name} is selected in the browser preview. Exact durable creation and rename receipts are not hydrated.`,
      occurredAt: "Current selection",
      actor: "Renderer projection",
      status: "preview",
      sourceLabel: "Project metadata",
      relatedId: project.id,
      relatedLabel: project.name,
    },
    {
      id: `${project.id}:context-status`,
      kind: "context",
      type: "context.status",
      title: "Context readiness inspected",
      detail: `${contextLabel(project)} · ${project.folders.length} visible folder grant${project.folders.length === 1 ? "" : "s"}.`,
      occurredAt: "Current selection",
      actor: "Renderer projection",
      status: "preview",
      sourceLabel: "Context health",
      relatedId: project.id,
      relatedLabel: project.name,
    },
    {
      id: `${project.id}:twin-pending`,
      kind: "context",
      type: "project.twin.pending",
      title: "Project Twin refresh remains pending",
      detail: "Goal, phase, task, evidence, and dependency lineage need native hydration before they become activity facts.",
      occurredAt: "Planned next",
      actor: "Omnia boundary",
      status: "planned",
      sourceLabel: "Project Twin boundary",
      relatedId: project.id,
      relatedLabel: project.name,
    },
  ];

  for (const folder of project.folders.slice(0, 8)) {
    events.push({
      id: `${project.id}:folder:${folder.id}`,
      kind: "workspace",
      type: "workspace.grant.preview",
      title: `Workspace grant visible: ${folder.displayName}`,
      detail: `${folder.scope} · ${folder.state}${folder.localOnly ? " · local-only" : ""}. File indexing and grant receipts remain unavailable in this preview.`,
      occurredAt: "Visible in project scope",
      actor: "Renderer projection",
      status: "preview",
      sourceLabel: "Workspace folder projection",
      relatedId: folder.id,
      relatedLabel: folder.displayName,
    });
  }

  for (const chat of projectConversations) {
    events.push({
      id: `${project.id}:chat:${chat.id}`,
      kind: "chat",
      type: "chat.metadata",
      title: chat.title,
      detail: chatDetail(chat),
      occurredAt: chat.updatedLabel,
      actor: "Conversation projection",
      status: "preview",
      sourceLabel: "Project chat metadata",
      relatedId: chat.id,
      relatedLabel: chat.title,
    });
  }

  if (projectConversations.length === 0) {
    events.push({
      id: `${project.id}:chat-empty`,
      kind: "chat",
      type: "chat.empty",
      title: "No project chats are visible",
      detail: "Create a Project Chat from Quick actions to add a renderer-visible work item.",
      occurredAt: "Waiting for input",
      actor: "Renderer projection",
      status: "planned",
      sourceLabel: "Project chat boundary",
      relatedId: project.id,
      relatedLabel: project.name,
    });
  }

  return events;
}

function safeText(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function markdownValue(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function serializeProjectActivity(
  events: readonly ProjectActivityEvent[],
  format: ProjectActivityExportFormat,
  bookmarks: ProjectActivityBookmarks = {},
): string {
  const safeEvents = events.map((event) => ({
    id: safeText(event.id, 160),
    kind: event.kind,
    type: safeText(event.type, 120),
    title: safeText(event.title, 240),
    detail: safeText(event.detail, 1_000),
    occurredAt: safeText(event.occurredAt, 120),
    actor: safeText(event.actor, 120),
    status: event.status,
    sourceLabel: safeText(event.sourceLabel, 160),
    relatedId: event.relatedId ? safeText(event.relatedId, 160) : null,
    relatedLabel: event.relatedLabel ? safeText(event.relatedLabel, 240) : null,
    bookmarked: Object.prototype.hasOwnProperty.call(bookmarks, event.id),
    bookmarkNote: Object.prototype.hasOwnProperty.call(bookmarks, event.id)
      ? safeText(bookmarks[event.id] ?? "", 500)
      : null,
  }));
  const bookmarkCount = safeEvents.filter((event) => event.bookmarked).length;

  if (format === "json") {
    return JSON.stringify(
      {
        format: PROJECT_ACTIVITY_EXPORT_FORMAT,
        version: 1,
        scope: "renderer-session",
        boundary: PROJECT_ACTIVITY_BOUNDARY,
        eventCount: safeEvents.length,
        bookmarkCount,
        bookmarks: Object.fromEntries(
          safeEvents
            .filter((event) => event.bookmarked)
            .map((event) => [event.id, event.bookmarkNote ?? ""]),
        ),
        events: safeEvents,
      },
      null,
      2,
    );
  }

  return [
    "# Omnia project activity preview",
    "",
    `> ${PROJECT_ACTIVITY_BOUNDARY}`,
    "",
    `- Events: ${safeEvents.length}`,
    `- Bookmarked: ${bookmarkCount}`,
    "",
    ...(safeEvents.length > 0
      ? safeEvents.flatMap((event) => [
          `## ${markdownValue(event.title)}`,
          "",
          `- Kind: ${event.kind}`,
          `- Type: ${markdownValue(event.type)}`,
          `- Status: ${event.status}`,
          `- Observed: ${markdownValue(event.occurredAt)}`,
          `- Source: ${markdownValue(event.sourceLabel)}`,
          `- Actor: ${markdownValue(event.actor)}`,
          `- Bookmarked: ${event.bookmarked ? "yes" : "no"}`,
          ...(event.bookmarked && event.bookmarkNote
            ? [`- Bookmark note: ${markdownValue(event.bookmarkNote)}`]
            : []),
          "",
          markdownValue(event.detail),
          "",
        ])
      : ["No activity is visible for this Project preview.", ""]),
  ].join("\n");
}

export function downloadProjectActivity(
  payload: string,
  format: ProjectActivityExportFormat,
): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(
    new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-project-activity-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function eventIcon(kind: ProjectActivityKind) {
  const Icon = KIND_ICONS[kind];
  return <Icon size={14} aria-hidden="true" />;
}

/**
 * Applies the Project activity filters to the renderer-visible projection.
 * Keeping this pure makes it possible to reason about the UI without implying
 * that a native activity query or durable journal read has happened.
 */
export function filterProjectActivityEvents(
  events: readonly ProjectActivityEvent[],
  filters: ProjectActivityFilters,
): ProjectActivityEvent[] {
  const normalizedQuery = filters.query?.trim().toLowerCase() ?? "";
  const kind = filters.kind ?? "all";
  const status = filters.status ?? "all";
  const sourceLabel = filters.sourceLabel ?? "all";
  const bookmarkedOnly = filters.bookmarkedOnly ?? false;
  const bookmarkedIds = filters.bookmarkedIds;

  return events.filter((event) => {
    if (kind !== "all" && event.kind !== kind) return false;
    if (status !== "all" && event.status !== status) return false;
    if (sourceLabel !== "all" && event.sourceLabel !== sourceLabel) return false;
    if (bookmarkedOnly && !bookmarkedIds?.has(event.id)) return false;
    if (!normalizedQuery) return true;
    return [
      event.title,
      event.detail,
      event.type,
      event.sourceLabel,
      event.actor,
      event.relatedLabel ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });
}

/**
 * Sorts only the current renderer projection. `default` preserves the bounded
 * source order assembled by buildProjectActivityEvents.
 */
export function sortProjectActivityEvents(
  events: readonly ProjectActivityEvent[],
  sort: ProjectActivitySort,
): ProjectActivityEvent[] {
  const sorted = [...events];
  if (sort === "default") return sorted;

  const kindOrder = Object.keys(KIND_LABELS) as ProjectActivityKind[];
  const statusOrder: ProjectActivityStatus[] = ["preview", "planned"];
  const compareText = (left: string, right: string) =>
    left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });

  sorted.sort((left, right) => {
    if (sort === "title") return compareText(left.title, right.title);
    if (sort === "kind") {
      return (
        kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind) ||
        compareText(left.title, right.title)
      );
    }
    return (
      statusOrder.indexOf(left.status) - statusOrder.indexOf(right.status) ||
      compareText(left.title, right.title)
    );
  });
  return sorted;
}

export function ProjectActivityTimeline({ project, conversations, onOpenRelated }: ProjectActivityTimelineProps) {
  const events = useMemo(() => buildProjectActivityEvents(project, conversations), [project, conversations]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ProjectActivityKind | "all">("all");
  const [status, setStatus] = useState<ProjectActivityStatus | "all">("all");
  const [sourceLabel, setSourceLabel] = useState<string | "all">("all");
  const [sort, setSort] = useState<ProjectActivitySort>("default");
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);
  const [bookmarks, setBookmarks] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(events[0]?.id ?? null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ProjectActivityExportFormat>("json");
  const [exportStatus, setExportStatus] = useState("Activity export is renderer-local and redacted to visible metadata.");

  const sourceOptions = useMemo(
    () => [...new Set(events.map((event) => event.sourceLabel))].sort((left, right) => left.localeCompare(right)),
    [events],
  );

  const filteredEvents = useMemo(() => {
    return sortProjectActivityEvents(
      filterProjectActivityEvents(events, {
        query,
        kind,
        status,
        sourceLabel,
        bookmarkedOnly,
        bookmarkedIds: new Set(Object.keys(bookmarks)),
      }),
      sort,
    );
  }, [bookmarkedOnly, bookmarks, events, kind, query, sort, sourceLabel, status]);

  useEffect(() => {
    if (sourceLabel !== "all" && !sourceOptions.includes(sourceLabel)) setSourceLabel("all");
    if (selectedId && !events.some((event) => event.id === selectedId)) {
      setSelectedId(events[0]?.id ?? null);
    }
  }, [events, selectedId, sourceLabel, sourceOptions]);

  const selectedEvent = filteredEvents.find((event) => event.id === selectedId) ?? filteredEvents[0] ?? null;
  const exportPayload = useMemo(
    () => serializeProjectActivity(filteredEvents, exportFormat, bookmarks),
    [bookmarks, exportFormat, filteredEvents],
  );

  const resetFilters = () => {
    setQuery("");
    setKind("all");
    setStatus("all");
    setSourceLabel("all");
    setSort("default");
    setBookmarkedOnly(false);
    setSelectedId(events[0]?.id ?? null);
    setExportStatus("Activity filters reset to the full renderer projection.");
  };

  const activeFilterCount = [
    query.trim(),
    kind !== "all" ? kind : "",
    status !== "all" ? status : "",
    sourceLabel !== "all" ? sourceLabel : "",
    sort !== "default" ? sort : "",
    bookmarkedOnly ? "bookmarked" : "",
  ].filter(Boolean).length;
  const hasActiveFilters = activeFilterCount > 0;
  const bookmarkCount = Object.keys(bookmarks).filter((id) => events.some((event) => event.id === id)).length;

  const toggleBookmark = (eventId: string) => {
    setBookmarks((current) => {
      if (Object.prototype.hasOwnProperty.call(current, eventId)) {
        const next = { ...current };
        delete next[eventId];
        return next;
      }
      return { ...current, [eventId]: "" };
    });
    setExportStatus("Bookmark changed in this renderer session; no durable activity record was written.");
  };

  const updateBookmarkNote = (eventId: string, note: string) => {
    setBookmarks((current) => ({ ...current, [eventId]: note.slice(0, 500) }));
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard access is unavailable; no activity preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setExportStatus(`Copied ${filteredEvents.length} renderer-local activity event${filteredEvents.length === 1 ? "" : "s"}.`);
    } catch {
      setExportStatus("Clipboard access was denied; no activity preview was copied.");
    }
  };

  const downloadExport = () => {
    setExportStatus(
      downloadProjectActivity(exportPayload, exportFormat)
        ? "Downloaded the renderer-local activity preview; no native history changed."
        : "Browser download is unavailable; no activity preview was written.",
    );
  };

  return (
    <section className="project-activity-timeline" aria-labelledby={`project-activity-title-${project.id}`}>
      <header className="project-activity-timeline__header">
        <div>
          <span className="eyebrow"><History size={13} /> Project activity</span>
          <h3 id={`project-activity-title-${project.id}`}>A readable trail of Project work</h3>
          <p>Review visible Project, Chat, workspace, and context signals without confusing this preview with the durable run journal.</p>
        </div>
        <span className="project-activity-timeline__badge"><ShieldCheck size={13} /> Preview only</span>
      </header>

      <div className="project-activity-timeline__metrics" aria-label="Project activity summary">
        <span><strong>{events.length}</strong><small>visible events</small></span>
        <span><strong>{events.filter((event) => event.status === "preview").length}</strong><small>preview facts</small></span>
        <span><strong>{events.filter((event) => event.status === "planned").length}</strong><small>planned gaps</small></span>
        <span><strong>{project.folders.length + projectConversationsCount(project, conversations)}</strong><small>linked items</small></span>
        <span><strong>{bookmarkCount}</strong><small>session bookmarks</small></span>
      </div>

      <div className="project-activity-timeline__controls" role="toolbar" aria-label="Project activity filters">
        <label className="project-activity-timeline__search"><Search size={14} /><span className="sr-only">Search project activity</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search activity" aria-label="Search project activity" /></label>
        <label><span>Kind</span><select value={kind} onChange={(event) => setKind(event.target.value as ProjectActivityKind | "all")} aria-label="Filter project activity kind"><option value="all">All kinds</option>{Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as ProjectActivityStatus | "all")} aria-label="Filter project activity status"><option value="all">All statuses</option><option value="preview">Preview facts</option><option value="planned">Planned gaps</option></select></label>
        <label><span>Source</span><select value={sourceLabel} onChange={(event) => setSourceLabel(event.target.value)} aria-label="Filter project activity source"><option value="all">All sources</option>{sourceOptions.map((source) => <option key={source} value={source}>{source}</option>)}</select></label>
        <label><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value as ProjectActivitySort)} aria-label="Sort project activity"><option value="default">Default order</option><option value="title">Title A–Z</option><option value="kind">Kind</option><option value="status">Status</option></select></label>
        <button type="button" className={`button ${bookmarkedOnly ? "button--secondary" : "button--ghost"}`} onClick={() => setBookmarkedOnly((value) => !value)} aria-pressed={bookmarkedOnly}><BookmarkCheck size={13} /> {bookmarkedOnly ? "Bookmarked only" : `Bookmarks${bookmarkCount ? ` (${bookmarkCount})` : ""}`}</button>
        <button type="button" className="button button--ghost" onClick={resetFilters} disabled={!hasActiveFilters}><RotateCcw size={13} /> Reset{hasActiveFilters ? ` (${activeFilterCount})` : ""}</button>
        <button type="button" className="button button--secondary" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls={`project-activity-export-${project.id}`}><Download size={13} /> {exportOpen ? "Hide export" : "Export preview"}</button>
      </div>

      <div className="project-activity-timeline__body">
        <div className="project-activity-timeline__list-wrap">
          <div className="project-activity-timeline__list-heading"><span><Filter size={13} /> Activity feed</span><small aria-live="polite">{filteredEvents.length} shown · {events.length} total{hasActiveFilters ? ` · ${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"}` : ""}</small></div>
          {filteredEvents.length > 0 ? (
            <ol className="project-activity-timeline__list" aria-label="Project activity events">
              {filteredEvents.map((event) => (
                <li key={event.id}>
                  <div className="project-activity-timeline__item-row">
                    <button type="button" className={`project-activity-timeline__item${selectedEvent?.id === event.id ? " is-selected" : ""}`} onClick={() => setSelectedId(event.id)} aria-current={selectedEvent?.id === event.id ? "true" : undefined}>
                      <span className={`project-activity-timeline__marker project-activity-timeline__marker--${event.kind}`}>{eventIcon(event.kind)}</span>
                      <span className="project-activity-timeline__item-copy"><span className="project-activity-timeline__item-topline"><strong>{event.title}</strong><em className={`is-${event.status}`}>{event.status === "preview" ? "Preview" : "Planned"}</em></span><small>{KIND_LABELS[event.kind]} · {event.occurredAt}{Object.prototype.hasOwnProperty.call(bookmarks, event.id) ? " · Bookmarked" : ""}</small><span>{event.detail}</span></span>
                    </button>
                    <button type="button" className={`icon-button icon-button--small project-activity-timeline__bookmark${Object.prototype.hasOwnProperty.call(bookmarks, event.id) ? " is-active" : ""}`} onClick={() => toggleBookmark(event.id)} aria-pressed={Object.prototype.hasOwnProperty.call(bookmarks, event.id)} aria-label={Object.prototype.hasOwnProperty.call(bookmarks, event.id) ? "Remove activity bookmark" : "Bookmark activity"} title={Object.prototype.hasOwnProperty.call(bookmarks, event.id) ? `Remove bookmark from ${event.title}` : `Bookmark ${event.title}`}>
                      {Object.prototype.hasOwnProperty.call(bookmarks, event.id) ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="project-activity-timeline__empty"><Search size={18} /><strong>No matching activity</strong><small>Try another search or reset the filters.</small>{hasActiveFilters ? <button type="button" className="button button--ghost" onClick={resetFilters}><RotateCcw size={13} /> Clear filters</button> : null}</div>
          )}
        </div>

        <aside className="project-activity-timeline__detail" aria-label="Selected project activity detail">
          {selectedEvent ? (
            <>
              <header><span className={`project-activity-timeline__detail-icon project-activity-timeline__detail-icon--${selectedEvent.kind}`}>{eventIcon(selectedEvent.kind)}</span><div><span className="eyebrow">Selected activity</span><h4>{selectedEvent.title}</h4></div><span className={`project-activity-timeline__detail-status is-${selectedEvent.status}`}>{selectedEvent.status === "preview" ? "Preview" : "Planned"}</span></header>
              <p>{selectedEvent.detail}</p>
              <dl><div><dt>Event type</dt><dd>{selectedEvent.type}</dd></div><div><dt>Observed</dt><dd>{selectedEvent.occurredAt}</dd></div><div><dt>Source</dt><dd>{selectedEvent.sourceLabel}</dd></div><div><dt>Actor</dt><dd>{selectedEvent.actor}</dd></div>{selectedEvent.relatedLabel ? <div><dt>Related item</dt><dd>{selectedEvent.relatedLabel}</dd></div> : null}</dl>
              <div className="project-activity-timeline__bookmark-editor">
                <div className="project-activity-timeline__bookmark-heading"><span><BookmarkCheck size={13} /> Session bookmark</span><button type="button" className={`button button--ghost${Object.prototype.hasOwnProperty.call(bookmarks, selectedEvent.id) ? " is-active" : ""}`} onClick={() => toggleBookmark(selectedEvent.id)} aria-pressed={Object.prototype.hasOwnProperty.call(bookmarks, selectedEvent.id)}>{Object.prototype.hasOwnProperty.call(bookmarks, selectedEvent.id) ? "Bookmarked" : "Bookmark"}</button></div>
                {Object.prototype.hasOwnProperty.call(bookmarks, selectedEvent.id) ? <label><span className="sr-only">Bookmark note</span><textarea value={bookmarks[selectedEvent.id] ?? ""} onChange={(event) => updateBookmarkNote(selectedEvent.id, event.target.value)} placeholder="Add a short note for this session bookmark" maxLength={500} aria-label="Bookmark note" /></label> : <small>Pin this visible event for quick review. Bookmark state is session-only.</small>}
              </div>
              {selectedEvent.kind === "chat" && selectedEvent.relatedId && onOpenRelated ? (
                <button type="button" className="button button--secondary project-activity-timeline__open-related" onClick={() => onOpenRelated(selectedEvent)}>
                  <ArrowUpRight size={13} /> Open related chat preview
                </button>
              ) : null}
              <div className="project-activity-timeline__detail-note"><LockKeyhole size={13} /><span>Selection is renderer-local. No activity receipt, run journal mutation, security audit entry, or Project Twin write was created.</span></div>
            </>
          ) : <div className="project-activity-timeline__detail-empty"><CalendarClock size={20} /><strong>Select an activity</strong><small>The detail view will show its visible source and boundary.</small></div>}
        </aside>
      </div>

      {exportOpen ? <section id={`project-activity-export-${project.id}`} className="project-activity-timeline__export" aria-label="Project activity export preview"><header><div><span className="eyebrow">Portable preview</span><h4>Activity export</h4></div><button type="button" className="icon-button icon-button--small" onClick={() => setExportOpen(false)} aria-label="Close activity export"><X size={13} /></button></header><div className="project-activity-timeline__export-toolbar" role="toolbar" aria-label="Project activity export actions"><label><span>Format</span><select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ProjectActivityExportFormat)} aria-label="Project activity export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><span className="project-activity-timeline__export-status" role="status" aria-live="polite">{exportStatus}</span><button type="button" className="button button--ghost" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={downloadExport}><Download size={13} /> Download</button></div><pre tabIndex={0}><code>{exportPayload}</code></pre></section> : null}

      <p className="project-activity-timeline__boundary"><CheckCircle2 size={14} /> {PROJECT_ACTIVITY_BOUNDARY} Product activity is intentionally separate from run lifecycle events and security decisions.</p>
    </section>
  );
}

function projectConversationsCount(project: ProjectView, conversations: readonly ConversationView[]): number {
  return conversations.filter((conversation) => conversation.projectId === project.id).length;
}
