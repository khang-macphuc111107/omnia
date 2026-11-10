import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleDashed,
  Clock3,
  Eye,
  Info,
  Pause,
  Search,
  Square,
  UserRound,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ProductIcon, type ProductIconName } from "@/components/product-icons";

import type { RunTimelineEventView } from "./evidence-types";
import type { BackgroundWorkProjection, BackgroundWorkItem } from "./background-work-projection";
import type { ActiveRunView, ConversationView } from "./types";

export type BackgroundWorkKind = "agent" | "run" | "tool-process" | "goal" | "checkpoint";
export type BackgroundWorkRole =
  | "explorer"
  | "researcher"
  | "architect"
  | "implementer"
  | "tester"
  | "reviewer"
  | "security"
  | "operator";
export type BackgroundWorkState =
  | "queued"
  | "waiting"
  | "working"
  | "needs-input"
  | "ready-for-review"
  | "completed"
  | "failed"
  | "stopped"
  | "outcome-unknown";

export interface BackgroundWorkRow {
  readonly id: string;
  readonly kind: BackgroundWorkKind;
  readonly role?: BackgroundWorkRole;
  readonly name: string;
  readonly state: BackgroundWorkState;
  readonly summary: string;
  readonly createdAt: string;
  readonly terminalAt?: string;
  readonly sourceThreadId?: string;
  readonly environmentLabel?: string;
  readonly branchLabel?: string;
  readonly approvalId?: string;
  readonly resultArtifactId?: string;
  readonly stageLabel?: string;
  readonly eventCount?: number;
}

export interface BackgroundWorkProjectionInput {
  readonly conversations: readonly ConversationView[];
  readonly activeRun: ActiveRunView | null;
  readonly timelineEvents: readonly RunTimelineEventView[];
}

function canonicalState(item: BackgroundWorkItem): BackgroundWorkState {
  if (item.state === "queued") return "queued";
  if (item.state === "waiting") return "waiting";
  if (item.state === "running") return "working";
  if (item.state === "completed") return "completed";
  if (item.state === "cancelled") return "stopped";
  if (item.state === "attention") {
    const detail = `${item.title} ${item.subtitle} ${item.detail ?? ""}`.toLowerCase();
    if (detail.includes("unknown") || detail.includes("outcome")) return "outcome-unknown";
    if (detail.includes("approval") || detail.includes("blocked") || detail.includes("reconciliation")) return "needs-input";
    return "failed";
  }
  return "needs-input";
}

/**
 * Adapts the canonical background-work projection to the inspector's visual
 * row shape. This keeps the UI reusable for a compact strip while preserving
 * the projection's durability and native-boundary semantics for its callers.
 */
export function backgroundWorkRowsFromProjection(
  projection: BackgroundWorkProjection,
): BackgroundWorkRow[] {
  return projection.items.map((item) => {
    const kind: BackgroundWorkKind =
      item.kind === "conversation-run" || item.kind === "run-timeline"
        ? "run"
        : item.kind === "run-control"
          ? "tool-process"
          : item.kind === "checkpoint"
            ? "checkpoint"
            : "goal";
    const base = {
      id: item.id,
      kind,
      name: item.title,
      state: canonicalState(item),
      summary: item.detail ?? item.subtitle,
      createdAt: item.updatedAt,
      stageLabel: item.subtitle,
    } satisfies BackgroundWorkRow;
    return {
      ...base,
      ...(item.state === "completed" || item.state === "cancelled" ? { terminalAt: item.updatedAt } : {}),
      ...(item.conversationId !== null ? { sourceThreadId: item.conversationId } : {}),
    } satisfies BackgroundWorkRow;
  });
}

export type BackgroundWorkFilter = "all" | "active" | "attention" | "done";

export type BackgroundWorkFacetState = "observed" | "preview" | "unknown" | "planned";
export type BackgroundWorkFacetKey =
  | "goal"
  | "phase"
  | "agent"
  | "tool"
  | "approval"
  | "queue"
  | "checkpoint";

export interface BackgroundWorkTaskInspectorFacet {
  readonly key: BackgroundWorkFacetKey;
  readonly label: string;
  readonly value: string;
  readonly state: BackgroundWorkFacetState;
  readonly detail: string;
}

export interface BackgroundWorkTaskInspectorMilestone {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly state: BackgroundWorkFacetState;
}

export type BackgroundWorkInspectorDetailTab = "summary" | "task" | "timeline";

const facetCopy: Record<BackgroundWorkFacetState, string> = {
  observed: "Observed",
  preview: "Preview",
  unknown: "Unknown",
  planned: "Planned",
};

const facetLabels: Record<BackgroundWorkFacetKey, string> = {
  goal: "Goal",
  phase: "Phase",
  agent: "Agent",
  tool: "Tool",
  approval: "Approval",
  queue: "Queue",
  checkpoint: "Checkpoint",
};

const stateCopy: Record<BackgroundWorkState, string> = {
  queued: "Queued",
  waiting: "Waiting",
  working: "Working",
  "needs-input": "Needs input",
  "ready-for-review": "Ready for review",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  "outcome-unknown": "Outcome unknown",
};

const roleCopy: Record<BackgroundWorkRole, string> = {
  explorer: "Explorer",
  researcher: "Researcher",
  architect: "Architect",
  implementer: "Implementer",
  tester: "Tester",
  reviewer: "Reviewer",
  security: "Security",
  operator: "Operator",
};

const roleIcons: Record<BackgroundWorkRole, ProductIconName> = {
  explorer: "browser",
  researcher: "citation",
  architect: "plan",
  implementer: "terminal",
  tester: "task",
  reviewer: "artifact",
  security: "environment",
  operator: "terminal",
};

const kindCopy: Record<BackgroundWorkKind, string> = {
  agent: "Agent",
  run: "Run",
  "tool-process": "Tool process",
  goal: "Goal",
  checkpoint: "Checkpoint",
};

function stateFromConversation(conversation: ConversationView): BackgroundWorkState | null {
  if (conversation.runState === "streaming") return "working";
  if (conversation.runState === "queued") return "queued";
  if (conversation.runState === "failed") return "failed";
  return null;
}

function terminalState(event: RunTimelineEventView): BackgroundWorkState | null {
  if (event.status === "running") return "working";
  if (event.status === "pending") return "queued";
  if (event.status === "complete") return "completed";
  if (event.status === "stopped") return "stopped";
  if (event.status === "failed") return "failed";
  if (event.status === "warning") return "outcome-unknown";
  return null;
}

function latestEvent(events: readonly RunTimelineEventView[]): RunTimelineEventView | null {
  return [...events].sort((left, right) => right.sequence - left.sequence || right.id.localeCompare(left.id))[0] ?? null;
}

function displayState(value: string): string {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function facet(
  key: BackgroundWorkFacetKey,
  value: string,
  state: BackgroundWorkFacetState,
  detail: string,
): BackgroundWorkTaskInspectorFacet {
  return { key, label: facetLabels[key], value, state, detail };
}

/**
 * Builds a task-inspector lens from the bounded row facts already available in
 * the renderer. Missing native identities stay Unknown/Planned instead of
 * being filled with synthetic agent, queue, approval, or checkpoint claims.
 */
export function buildBackgroundWorkTaskFacets(
  row: BackgroundWorkRow,
): BackgroundWorkTaskInspectorFacet[] {
  return [
    facet(
      "goal",
      row.kind === "goal" ? row.name : "No goal identity",
      row.kind === "goal" ? "preview" : "unknown",
      row.kind === "goal"
        ? "Goal label comes from the renderer projection."
        : "A durable goal/task identity is not present in this projection.",
    ),
    facet(
      "phase",
      row.stageLabel ?? "Phase not reported",
      row.stageLabel ? "preview" : "unknown",
      row.stageLabel
        ? "Derived from the projected stage label; no native phase receipt is attached."
        : "The native phase/checkpoint stream is not hydrated.",
    ),
    facet(
      "agent",
      row.role ? roleCopy[row.role] : "Agent identity not hydrated",
      row.role ? "preview" : "planned",
      row.role
        ? "Role is a renderer label, not proof of a spawned worker or lease."
        : "Agent identity, lease, and child authority remain planned.",
    ),
    facet(
      "tool",
      row.kind === "tool-process" ? row.name : "Tool route not connected",
      row.kind === "tool-process" ? "preview" : "planned",
      row.kind === "tool-process"
        ? "Tool/process label is projected; no process was started."
        : "Tool invocation identity and execution receipt are not available here.",
    ),
    facet(
      "approval",
      row.approvalId ? `Approval ${row.approvalId}` : "Approval not hydrated",
      row.approvalId ? "preview" : "unknown",
      row.approvalId
        ? "Approval reference is carried as a preview field; native decision evidence is not shown."
        : "No approval request/decision receipt is attached to this row.",
    ),
    facet(
      "queue",
      row.state === "queued" ? "Queued preview" : "Queue state unavailable",
      row.state === "queued" ? "preview" : "unknown",
      row.state === "queued"
        ? "Queue membership is visible, but position, lease, and retry policy are not hydrated."
        : "A native queue position/lease is not available in this renderer projection.",
    ),
    facet(
      "checkpoint",
      row.eventCount === undefined ? "Checkpoint not reported" : `${row.eventCount} projected events`,
      row.eventCount === undefined ? "unknown" : "preview",
      row.eventCount === undefined
        ? "Checkpoint identity, cursor, and durable resume state are not available."
        : "Event count is a renderer projection, not a durable checkpoint receipt.",
    ),
  ];
}

export function buildBackgroundWorkTaskMilestones(
  row: BackgroundWorkRow,
): BackgroundWorkTaskInspectorMilestone[] {
  return [
    {
      id: `${row.id}:created`,
      label: "First projected observation",
      value: row.createdAt,
      state: "preview",
    },
    {
      id: `${row.id}:state`,
      label: "Current state",
      value: stateCopy[row.state],
      state: "preview",
    },
    {
      id: `${row.id}:terminal`,
      label: "Terminal observation",
      value: row.terminalAt ?? "Not terminal",
      state: row.terminalAt ? "preview" : "unknown",
    },
    {
      id: `${row.id}:events`,
      label: "Projected event count",
      value: row.eventCount === undefined ? "Not reported" : String(row.eventCount),
      state: row.eventCount === undefined ? "unknown" : "preview",
    },
  ];
}

/**
 * Projects the bounded renderer data already available to the workspace into
 * attention rows. It deliberately does not invent agent/task IDs or treat a
 * conversation flag as proof of a durable background worker.
 */
export function buildBackgroundWorkRows({
  conversations,
  activeRun,
  timelineEvents,
}: BackgroundWorkProjectionInput): BackgroundWorkRow[] {
  const rows = new Map<string, BackgroundWorkRow>();

  for (const conversation of conversations) {
    const state = stateFromConversation(conversation);
    if (state === null) continue;
    const run = activeRun?.conversationId === conversation.id ? activeRun : null;
    const id = run?.id ?? `conversation-run:${conversation.id}`;
    rows.set(id, {
      id,
      kind: "run",
      name: conversation.title || "Untitled conversation",
      state,
      summary: conversation.excerpt || "Conversation run is awaiting a durable summary.",
      createdAt: run?.startedAt ?? conversation.updatedAt,
      sourceThreadId: conversation.id,
      stageLabel: run?.stage ? displayState(run.stage) : stateCopy[state],
    });
  }

  const eventsByRun = new Map<string, RunTimelineEventView[]>();
  for (const event of timelineEvents) {
    const events = eventsByRun.get(event.runId) ?? [];
    events.push(event);
    eventsByRun.set(event.runId, events);
  }

  for (const [runId, events] of eventsByRun) {
    const latest = latestEvent(events);
    if (!latest) continue;
    const state = terminalState(latest);
    const conversation = conversations.find((candidate) =>
      candidate.messages.some((message) => message.runId === runId),
    );
    if (state === null || rows.has(runId)) continue;
    const existingConversationRow = conversation
      ? [...rows.values()].find((row) => row.sourceThreadId === conversation.id)
      : undefined;
    if (existingConversationRow) rows.delete(existingConversationRow.id);
    rows.set(runId, {
      id: runId,
      kind: "run",
      name: conversation?.title || (latest.providerLabel ? `${latest.providerLabel} run` : "Stored run"),
      state,
      summary: latest.summary,
      createdAt: events.slice().sort((left, right) => left.sequence - right.sequence)[0]?.startedAt ?? latest.startedAt,
      terminalAt: latest.endedAt ?? latest.startedAt,
      stageLabel: displayState(latest.stage),
      eventCount: events.length,
    });
  }

  const stateOrder: Record<BackgroundWorkState, number> = {
    "needs-input": 0,
    "ready-for-review": 1,
    working: 2,
    queued: 3,
    waiting: 4,
    "outcome-unknown": 5,
    failed: 6,
    completed: 7,
    stopped: 8,
  };
  return [...rows.values()].sort(
    (left, right) =>
      stateOrder[left.state] - stateOrder[right.state] ||
      right.createdAt.localeCompare(left.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

function filterRows(rows: readonly BackgroundWorkRow[], filter: BackgroundWorkFilter): BackgroundWorkRow[] {
  if (filter === "all") return [...rows];
  if (filter === "active") return rows.filter((row) => row.state === "queued" || row.state === "waiting" || row.state === "working");
  if (filter === "attention") return rows.filter((row) => row.state === "needs-input" || row.state === "ready-for-review" || row.state === "failed" || row.state === "outcome-unknown");
  return rows.filter((row) => row.state === "completed" || row.state === "stopped");
}

function stateIcon(state: BackgroundWorkState) {
  if (state === "completed") return <Check size={14} />;
  if (state === "failed" || state === "outcome-unknown") return <XCircle size={14} />;
  if (state === "needs-input" || state === "ready-for-review") return <AlertTriangle size={14} />;
  if (state === "working") return <CircleDashed size={14} />;
  if (state === "queued" || state === "waiting") return <Clock3 size={14} />;
  return <Pause size={14} />;
}

function formatAge(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Time unavailable";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export interface BackgroundWorkInspectorProps {
  readonly rows: readonly BackgroundWorkRow[];
  readonly onOpenThread?: (row: BackgroundWorkRow) => void;
  readonly onPeek?: (row: BackgroundWorkRow) => void;
  readonly title?: string;
  readonly compact?: boolean;
}

export function BackgroundWorkInspector({
  rows,
  onOpenThread,
  onPeek,
  title = "Background work",
  compact = false,
}: BackgroundWorkInspectorProps) {
  const [filter, setFilter] = useState<BackgroundWorkFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(rows[0]?.id ?? null);
  const [detailTab, setDetailTab] = useState<BackgroundWorkInspectorDetailTab>("summary");
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const visibleRows = useMemo(() => {
    const filtered = filterRows(rows, filter);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return filtered;
    return filtered.filter((row) => [row.name, row.summary, row.stageLabel, row.role, row.kind, stateCopy[row.state]].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery)));
  }, [filter, query, rows]);
  const selected = visibleRows.find((row) => row.id === selectedId) ?? visibleRows[0] ?? null;
  const activeCount = rows.filter((row) => row.state === "working" || row.state === "queued" || row.state === "waiting").length;
  const needsInputCount = rows.filter((row) => row.state === "needs-input" || row.state === "ready-for-review").length;
  const completedCount = rows.filter((row) => row.state === "completed" || row.state === "stopped").length;
  const selectedFacets = selected ? buildBackgroundWorkTaskFacets(selected) : [];
  const selectedMilestones = selected ? buildBackgroundWorkTaskMilestones(selected) : [];
  const detailPanelId = selected
    ? `background-work-detail-${selected.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`
    : "background-work-detail-panel";

  useEffect(() => {
    if (visibleRows.length > 0 && !visibleRows.some((row) => row.id === selectedId)) {
      setSelectedId(visibleRows[0]?.id ?? null);
    }
  }, [selectedId, visibleRows]);

  const focusRow = (index: number) => {
    const row = visibleRows[Math.max(0, Math.min(index, visibleRows.length - 1))];
    if (!row) return;
    setSelectedId(row.id);
    rowRefs.current[row.id]?.focus();
  };

  return (
    <section className={compact ? "background-work-inspector background-work-inspector--compact" : "background-work-inspector"} aria-label={title}>
      <header className="background-work-inspector__header">
        <div className="background-work-inspector__heading">
          <span className="background-work-inspector__mark"><ProductIcon name="agent" size={18} /></span>
          <span><span className="eyebrow">Attention queue</span><h2>{title}</h2></span>
        </div>
        <span className="background-work-inspector__badge"><Eye size={12} /> Preview</span>
      </header>

      <div className="background-work-inspector__metrics" aria-label="Background work counts">
        <button type="button" className={filter === "active" ? "is-active" : ""} title={`Show active work (${activeCount})`} aria-label={`Show active work (${activeCount})`} onClick={() => setFilter("active")}><strong>{activeCount}</strong><span>Active</span></button>
        <button type="button" className={filter === "attention" ? "is-active" : ""} title={`Show work needing input (${needsInputCount})`} aria-label={`Show work needing input (${needsInputCount})`} onClick={() => setFilter("attention")}><strong>{needsInputCount}</strong><span>Needs input</span></button>
        <button type="button" className={filter === "done" ? "is-active" : ""} title={`Show completed work (${completedCount})`} aria-label={`Show completed work (${completedCount})`} onClick={() => setFilter("done")}><strong>{completedCount}</strong><span>Done</span></button>
      </div>

      <nav className="background-work-inspector__filters" aria-label="Background work filters">
        {(["all", "active", "attention", "done"] as const).map((value) => (
          <button key={value} type="button" className={filter === value ? "is-active" : ""} title={`Filter background work: ${value === "all" ? "All" : value === "attention" ? "Attention" : value === "active" ? "Active" : "Done"}`} aria-label={`Filter background work: ${value === "all" ? "All" : value === "attention" ? "Attention" : value === "active" ? "Active" : "Done"}`} onClick={() => setFilter(value)} aria-pressed={filter === value}>
            <Search size={12} /> {value === "all" ? "All" : value === "attention" ? "Attention" : value === "active" ? "Active" : "Done"}
          </button>
        ))}
      </nav>

      <div className="background-work-inspector__search">
        <label htmlFor="background-work-search">Search work</label>
        <div className="background-work-inspector__search-control">
          <Search size={13} aria-hidden="true" />
          <input
            id="background-work-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, stage, state, or role"
            aria-label="Search background work"
          />
          {query ? <button type="button" className="background-work-inspector__clear" title="Clear background work search" aria-label="Clear background work search" onClick={() => setQuery("")}>Clear</button> : null}
        </div>
      </div>

      <div className="background-work-inspector__body">
        <div className="background-work-inspector__list" role="list" aria-label={`${visibleRows.length} background work item${visibleRows.length === 1 ? "" : "s"}${query.trim() ? ` matching ${query.trim()}` : ""}`}>
          {visibleRows.length === 0 ? (
            <div className="background-work-inspector__empty" role="status"><UserRound size={18} /><strong>{rows.length === 0 ? "No background work" : "No items in this view"}</strong><small>{rows.length === 0 ? "Active runs and attention items will appear here when a trusted projection exists." : "Try another filter to inspect the remaining work."}</small></div>
          ) : visibleRows.map((row, rowIndex) => {
            const role = row.role ? roleCopy[row.role] : kindCopy[row.kind];
            const selectedRow = selected?.id === row.id;
            return (
              <button
                key={row.id}
                id={`background-work-row-${row.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`}
                ref={(element) => { rowRefs.current[row.id] = element; }}
                type="button"
                role="listitem"
                tabIndex={selectedRow ? 0 : -1}
                aria-label={`${row.name}. ${stateCopy[row.state]}. ${row.summary}`}
                title={`Inspect ${row.name}. ${stateCopy[row.state]}. ${row.summary}`}
                aria-pressed={selectedRow}
                className={selectedRow ? "background-work-row is-selected" : "background-work-row"}
                onKeyDown={(event) => {
                  if (!visibleRows.length) return;
                  if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); focusRow(rowIndex + 1); }
                  if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); focusRow(rowIndex - 1); }
                  if (event.key === "Home") { event.preventDefault(); focusRow(0); }
                  if (event.key === "End") { event.preventDefault(); focusRow(visibleRows.length - 1); }
                }}
                onClick={() => { setSelectedId(row.id); onPeek?.(row); }}
              >
                <span className={`background-work-row__role background-work-row__role--${row.state}`} title={`${role} · ${stateCopy[row.state]}`}><ProductIcon name={row.role ? roleIcons[row.role] : row.kind === "run" ? "run" : row.kind === "tool-process" ? "terminal" : row.kind === "checkpoint" ? "artifact" : "task"} size={18} /></span>
                <span className="background-work-row__copy"><strong>{row.name}</strong><small>{row.summary}</small><em>{role} · {formatAge(row.createdAt)}</em></span>
                <span className={`background-work-row__state background-work-row__state--${row.state}`}>{stateIcon(row.state)}<span>{stateCopy[row.state]}</span></span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            );
          })}
        </div>

        {selected ? (
          <aside className="background-work-inspector__detail" aria-label={`Details for ${selected.name}`}>
            <div className="background-work-inspector__detail-heading"><span className="eyebrow">Selected work</span><span className={`background-work-inspector__detail-state background-work-inspector__detail-state--${selected.state}`}>{stateIcon(selected.state)} {stateCopy[selected.state]}</span></div>
            <h3>{selected.name}</h3>
            <p>{selected.summary}</p>
            <nav className="background-work-inspector__detail-tabs" aria-label="Background work detail views" role="tablist">
              {([
                ["summary", "Summary"],
                ["task", "Task inspector"],
                ["timeline", "Timeline"],
              ] as const).map(([value, label]) => {
                const tabId = `background-work-detail-tab-${value}`;
                return (
                  <button
                    key={value}
                    id={tabId}
                    type="button"
                    role="tab"
                    title={`Open background work ${label.toLowerCase()} view`}
                    aria-selected={detailTab === value}
                    aria-controls={detailPanelId}
                    className={detailTab === value ? "is-active" : ""}
                    onClick={() => setDetailTab(value)}
                  >
                    {label}
                  </button>
                );
              })}
            </nav>
            <div id={detailPanelId} className="background-work-inspector__detail-panel" role="tabpanel" tabIndex={0} aria-labelledby={`background-work-detail-tab-${detailTab}`}>
              {detailTab === "summary" ? (
                <dl>
                  <div><dt>Role</dt><dd>{selected.role ? roleCopy[selected.role] : kindCopy[selected.kind]}</dd></div>
                  <div><dt>Stage</dt><dd>{selected.stageLabel ?? "Not reported"}</dd></div>
                  <div><dt>Source thread</dt><dd>{selected.sourceThreadId ?? "Not retained"}</dd></div>
                  <div><dt>Events</dt><dd>{selected.eventCount ?? "Not reported"}</dd></div>
                </dl>
              ) : detailTab === "task" ? (
                <div className="background-work-inspector__facet-grid" aria-label="Task inspector facets">
                  {selectedFacets.map((item) => (
                    <article key={item.key} className="background-work-inspector__facet">
                      <div className="background-work-inspector__facet-heading"><span>{item.label}</span><b className={`background-work-inspector__facet-state background-work-inspector__facet-state--${item.state}`}>{facetCopy[item.state]}</b></div>
                      <strong>{item.value}</strong>
                      <small>{item.detail}</small>
                    </article>
                  ))}
                </div>
              ) : (
                <ol className="background-work-inspector__milestones" aria-label="Projected work timeline">
                  {selectedMilestones.map((item) => (
                    <li key={item.id} className={`background-work-inspector__milestone background-work-inspector__milestone--${item.state}`}>
                      <span aria-hidden="true" />
                      <div><strong>{item.label}</strong><small>{item.value}</small></div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="background-work-inspector__detail-actions">
              <button type="button" className="button button--secondary" title={onOpenThread ? "Open the source conversation thread" : "Opening a source thread is unavailable in this preview"} onClick={() => onOpenThread?.(selected)} disabled={!onOpenThread}><ChevronRight size={14} /> Open thread</button>
              <button type="button" className="button button--ghost" disabled title="Stop requires a native run-control bridge"><Square size={13} /> Stop unavailable</button>
            </div>
          </aside>
        ) : null}
      </div>

      <p className="background-work-inspector__boundary"><Info size={14} /><span>Renderer projection only. Opening, peeking, filtering, or closing this surface does not start, stop, reprioritize, or persist background work.</span></p>
    </section>
  );
}
