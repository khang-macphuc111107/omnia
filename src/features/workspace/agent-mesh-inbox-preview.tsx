import {
  Archive,
  Check,
  ChevronRight,
  Clock3,
  Inbox,
  Info,
  ListFilter,
  MailCheck,
  MessageCircleMore,
  Search,
  Send,
  ShieldAlert,
  Tag,
  Users,
  X,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";

export type AgentMeshInboxPriority = "urgent" | "high" | "normal" | "low";
export type AgentMeshInboxStatus = "new" | "triaged" | "snoozed" | "escalated";
export type AgentMeshInboxKind = "finding" | "question" | "handoff" | "progress" | "control";
export type AgentMeshInboxSensitivity = "normal" | "sensitive" | "restricted";
export type AgentMeshInboxTab = "queue" | "routes" | "activity";
export type AgentMeshInboxFilter = "all" | "new" | "needs-decision" | "triaged" | "snoozed" | "escalated";
export type AgentMeshInboxSort = "priority" | "newest" | "oldest" | "sender";

export interface AgentMeshInboxItem {
  readonly id: string;
  readonly subject: string;
  readonly summary: string;
  readonly sender: string;
  readonly recipient: string;
  readonly kind: AgentMeshInboxKind;
  readonly priority: AgentMeshInboxPriority;
  readonly status: AgentMeshInboxStatus;
  readonly sensitivity: AgentMeshInboxSensitivity;
  readonly createdAt: string;
  readonly ageMinutes: number;
  readonly requiresDecision: boolean;
  readonly taskId: string;
  readonly tags: readonly string[];
}

export const AGENT_MESH_INBOX_ITEMS: readonly AgentMeshInboxItem[] = [
  {
    id: "inbox:source-ledger-drift",
    subject: "Source-ledger projections are stale",
    summary: "Three renderer projections no longer match the current shared tree and need a same-snapshot refresh.",
    sender: "Evidence researcher",
    recipient: "Omnia orchestrator",
    kind: "finding",
    priority: "urgent",
    status: "new",
    sensitivity: "normal",
    createdAt: "09:18",
    ageMinutes: 7,
    requiresDecision: true,
    taskId: "task:source-audit",
    tags: ["evidence", "snapshot", "source-ledger"],
  },
  {
    id: "inbox:blocked-child",
    subject: "Blocked child needs lease recovery review",
    summary: "The verifier child is blocked on the native boundary; the renderer can only rehearse a recovery decision.",
    sender: "Truthfulness verifier",
    recipient: "UI builder",
    kind: "question",
    priority: "high",
    status: "new",
    sensitivity: "sensitive",
    createdAt: "09:14",
    ageMinutes: 11,
    requiresDecision: true,
    taskId: "task:stale-verifier",
    tags: ["blocked", "lease", "boundary"],
  },
  {
    id: "inbox:preview-ready",
    subject: "Agent Mesh preview is ready",
    summary: "The coordination surface is available for user inspection; no agent was dispatched by the preview.",
    sender: "UI builder",
    recipient: "Omnia orchestrator",
    kind: "progress",
    priority: "normal",
    status: "triaged",
    sensitivity: "normal",
    createdAt: "09:12",
    ageMinutes: 13,
    requiresDecision: false,
    taskId: "task:ui-preview",
    tags: ["renderer", "preview"],
  },
  {
    id: "inbox:handoff-contract",
    subject: "Keep this slice renderer-local",
    summary: "Handoff notes request a focused smoke check while preserving the preview-only boundary.",
    sender: "Omnia orchestrator",
    recipient: "UI builder",
    kind: "handoff",
    priority: "high",
    status: "triaged",
    sensitivity: "normal",
    createdAt: "09:16",
    ageMinutes: 9,
    requiresDecision: false,
    taskId: "task:ui-preview",
    tags: ["handoff", "scope"],
  },
  {
    id: "inbox:policy-draft",
    subject: "Supervisor policy draft needs review",
    summary: "A renderer-local policy draft is ready to compare against guarded defaults before native promotion.",
    sender: "UX reviewer",
    recipient: "Omnia orchestrator",
    kind: "control",
    priority: "normal",
    status: "snoozed",
    sensitivity: "restricted",
    createdAt: "08:58",
    ageMinutes: 27,
    requiresDecision: true,
    taskId: "task:policy-review",
    tags: ["policy", "review", "preview"],
  },
  {
    id: "inbox:logo-study",
    subject: "Prior logo study is complete",
    summary: "The visual direction is archived as a reference and does not change the current appearance selection.",
    sender: "UX reviewer",
    recipient: "Omnia orchestrator",
    kind: "finding",
    priority: "low",
    status: "triaged",
    sensitivity: "normal",
    createdAt: "08:44",
    ageMinutes: 41,
    requiresDecision: false,
    taskId: "task:prior-logo-study",
    tags: ["design", "archive"],
  },
] as const;

const PRIORITY_ORDER: Record<AgentMeshInboxPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const PRIORITY_LABELS: Record<AgentMeshInboxPriority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

const STATUS_LABELS: Record<AgentMeshInboxStatus, string> = {
  new: "New",
  triaged: "Triaged",
  snoozed: "Snoozed",
  escalated: "Escalated",
};

const KIND_LABELS: Record<AgentMeshInboxKind, string> = {
  finding: "Finding",
  question: "Question",
  handoff: "Handoff",
  progress: "Progress",
  control: "Control",
};

const FILTER_LABELS: Record<AgentMeshInboxFilter, string> = {
  all: "All messages",
  new: "New",
  "needs-decision": "Needs decision",
  triaged: "Triaged",
  snoozed: "Snoozed",
  escalated: "Escalated",
};

const TAB_LABELS: Record<AgentMeshInboxTab, string> = {
  queue: "Triage queue",
  routes: "Routes",
  activity: "Session activity",
};

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function itemMatchesSearch(item: AgentMeshInboxItem, query: string): boolean {
  if (!query) return true;
  return normalized([
    item.id,
    item.subject,
    item.summary,
    item.sender,
    item.recipient,
    `${item.sender} → ${item.recipient}`,
    item.kind,
    item.priority,
    item.status,
    item.sensitivity,
    item.taskId,
    ...item.tags,
  ].join(" ")).includes(query);
}

function itemMatchesFilter(item: AgentMeshInboxItem, filter: AgentMeshInboxFilter, status: AgentMeshInboxStatus): boolean {
  if (filter === "all") return true;
  if (filter === "needs-decision") return item.requiresDecision && status !== "triaged";
  return status === filter;
}

function itemSort(items: readonly AgentMeshInboxItem[], sort: AgentMeshInboxSort): AgentMeshInboxItem[] {
  return [...items].sort((left, right) => {
    if (sort === "priority") {
      return PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] || left.ageMinutes - right.ageMinutes;
    }
    if (sort === "newest") return left.ageMinutes - right.ageMinutes;
    if (sort === "oldest") return right.ageMinutes - left.ageMinutes;
    return left.sender.localeCompare(right.sender) || left.subject.localeCompare(right.subject);
  });
}

function statusTone(status: AgentMeshInboxStatus): string {
  if (status === "new") return "new";
  if (status === "escalated") return "escalated";
  if (status === "snoozed") return "snoozed";
  return "triaged";
}

function priorityTone(priority: AgentMeshInboxPriority): string {
  return priority;
}

export interface AgentMeshInboxPreviewProps {
  readonly linkedWorkCount?: number;
}

interface RouteSummary {
  readonly route: string;
  readonly count: number;
  readonly unread: number;
  readonly decisionCount: number;
  readonly priorities: readonly AgentMeshInboxPriority[];
}

export function AgentMeshInboxPreview({ linkedWorkCount = 0 }: AgentMeshInboxPreviewProps) {
  const [tab, setTab] = useState<AgentMeshInboxTab>("queue");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AgentMeshInboxFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<AgentMeshInboxPriority | "all">("all");
  const [sort, setSort] = useState<AgentMeshInboxSort>("priority");
  const [decisionOnly, setDecisionOnly] = useState(false);
  const [selectedId, setSelectedId] = useState(AGENT_MESH_INBOX_ITEMS[0]?.id ?? null);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [statusOverrides, setStatusOverrides] = useState<Readonly<Record<string, AgentMeshInboxStatus>>>({});
  const [tagOverrides, setTagOverrides] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [tagDraft, setTagDraft] = useState("");
  const [note, setNote] = useState("");
  const [announcement, setAnnouncement] = useState("Renderer-local inbox preview; no mailbox delivery or native triage occurred.");
  const [activity, setActivity] = useState<readonly string[]>([
    "Inbox opened with six seeded coordination messages.",
    "Preview boundary locked to renderer session.",
  ]);

  const items = useMemo(
    () => AGENT_MESH_INBOX_ITEMS.map((item) => ({
      ...item,
      status: statusOverrides[item.id] ?? item.status,
      tags: tagOverrides[item.id] ?? item.tags,
    })),
    [statusOverrides, tagOverrides],
  );
  const normalizedQuery = normalized(query);
  const visibleItems = useMemo(() => itemSort(
    items.filter((item) => itemMatchesSearch(item, normalizedQuery)
      && itemMatchesFilter(item, filter, item.status)
      && (priorityFilter === "all" || item.priority === priorityFilter)
      && (!decisionOnly || item.requiresDecision)),
    sort,
  ), [decisionOnly, filter, items, normalizedQuery, priorityFilter, sort]);
  const selectedItem = items.find((item) => item.id === selectedId) ?? null;
  const selectedVisibleIds = visibleItems.filter((item) => selectedIds.includes(item.id)).map((item) => item.id);
  const unreadCount = items.filter((item) => item.status === "new").length;
  const decisionCount = items.filter((item) => item.requiresDecision && item.status !== "triaged").length;
  const escalatedCount = items.filter((item) => item.status === "escalated").length;
  const routeSummaries = useMemo<RouteSummary[]>(() => {
    const byRoute = new Map<string, { count: number; unread: number; decisionCount: number; priorities: Set<AgentMeshInboxPriority> }>();
    for (const item of items) {
      const route = `${item.sender} → ${item.recipient}`;
      const current = byRoute.get(route) ?? { count: 0, unread: 0, decisionCount: 0, priorities: new Set<AgentMeshInboxPriority>() };
      current.count += 1;
      current.unread += item.status === "new" ? 1 : 0;
      current.decisionCount += item.requiresDecision && item.status !== "triaged" ? 1 : 0;
      current.priorities.add(item.priority);
      byRoute.set(route, current);
    }
    return [...byRoute.entries()]
      .map(([route, value]) => ({ route, ...value, priorities: [...value.priorities].sort((left, right) => PRIORITY_ORDER[left] - PRIORITY_ORDER[right]) }))
      .sort((left, right) => right.count - left.count || left.route.localeCompare(right.route));
  }, [items]);

  const appendActivity = (entry: string) => {
    setActivity((current) => [entry, ...current].slice(0, 8));
  };

  const updateStatus = (ids: readonly string[], status: AgentMeshInboxStatus, label: string) => {
    if (ids.length === 0) {
      setAnnouncement("Select at least one message first; no native mutation was made.");
      return;
    }
    setStatusOverrides((current) => Object.fromEntries([
      ...Object.entries(current),
      ...ids.map((id) => [id, status] as const),
    ]));
    const detail = `${label} ${ids.length} message${ids.length === 1 ? "" : "s"} in this renderer session.`;
    setAnnouncement(`${detail} No native mailbox mutation was made.`);
    appendActivity(detail);
  };

  const toggleSelection = (id: string) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]);
  };

  const selectVisible = () => {
    setSelectedIds((current) => Array.from(new Set([...current, ...visibleItems.map((item) => item.id)])));
    setAnnouncement(`${visibleItems.length} visible message${visibleItems.length === 1 ? "" : "s"} selected in this renderer session.`);
  };

  const clearSelection = () => {
    setSelectedIds([]);
    setAnnouncement("Inbox selection cleared; no native mutation was made.");
  };

  const addTag = () => {
    if (!selectedItem) {
      setAnnouncement("Select a message before adding a session tag.");
      return;
    }
    const tag = normalized(tagDraft).replace(/\s+/g, "-").slice(0, 32);
    if (!tag) {
      setAnnouncement("Enter a tag first; no native mutation was made.");
      return;
    }
    const existing = tagOverrides[selectedItem.id] ?? selectedItem.tags;
    if (existing.includes(tag)) {
      setAnnouncement(`The ${tag} tag is already present on this message.`);
      return;
    }
    setTagOverrides((current) => ({ ...current, [selectedItem.id]: [...existing, tag] }));
    setTagDraft("");
    setAnnouncement(`Added the ${tag} tag to ${selectedItem.id} for this renderer session.`);
    appendActivity(`Added session tag #${tag} to ${selectedItem.subject}.`);
  };

  const clearFilters = () => {
    setQuery("");
    setFilter("all");
    setPriorityFilter("all");
    setSort("priority");
    setDecisionOnly(false);
    setAnnouncement("Inbox filters reset to defaults.");
  };

  return (
    <section className="agent-mesh-inbox-preview" aria-label="Agent Mesh inbox preview">
      <header className="agent-mesh-inbox-preview__header">
        <div>
          <span className="eyebrow"><Inbox size={13} /> Agent Mesh · inbox</span>
          <h2>Inbox triage cockpit</h2>
          <p>Sort, inspect and rehearse message handling across the mesh before any native mailbox bridge exists.</p>
        </div>
        <span className="agent-mesh-inbox-preview__badge"><Zap size={12} /> Preview only · renderer-local</span>
      </header>

      <div className="agent-mesh-inbox-preview__metrics" aria-label="Inbox metrics">
        <div><strong>{unreadCount}</strong><span>new</span></div>
        <div><strong>{decisionCount}</strong><span>needs decision</span></div>
        <div><strong>{escalatedCount}</strong><span>escalated</span></div>
        <div><strong>{routeSummaries.length}</strong><span>routes</span></div>
      </div>

      <nav className="agent-mesh-inbox-preview__tabs" role="tablist" aria-label="Agent Mesh inbox view">
        {(Object.keys(TAB_LABELS) as AgentMeshInboxTab[]).map((tabId) => (
          <button
            key={tabId}
            type="button"
            role="tab"
            aria-selected={tab === tabId}
            aria-controls={`agent-mesh-inbox-panel-${tabId}`}
            className={tab === tabId ? "is-active" : ""}
            onClick={() => setTab(tabId)}
          >
            {tabId === "queue" ? <ListFilter size={13} /> : tabId === "routes" ? <Users size={13} /> : <Clock3 size={13} />}
            {TAB_LABELS[tabId]}
          </button>
        ))}
      </nav>

      {tab === "queue" ? (
        <div id="agent-mesh-inbox-panel-queue" className="agent-mesh-inbox-preview__queue" role="tabpanel" aria-label="Triage queue" tabIndex={0}>
          <div className="agent-mesh-inbox-preview__toolbar" role="toolbar" aria-label="Inbox triage filters">
            <label className="agent-mesh-inbox-preview__search"><span>Search</span><span className="agent-mesh-inbox-preview__input"><Search size={13} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="subject, agent, task or tag" aria-label="Search inbox messages" />{query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear inbox search"><X size={12} /></button> : null}</span></label>
            <label><span>Status</span><select aria-label="Inbox status filter" value={filter} onChange={(event) => setFilter(event.target.value as AgentMeshInboxFilter)}>{(Object.keys(FILTER_LABELS) as AgentMeshInboxFilter[]).map((value) => <option key={value} value={value}>{FILTER_LABELS[value]}</option>)}</select></label>
            <label><span>Priority</span><select aria-label="Inbox priority filter" value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as AgentMeshInboxPriority | "all")}><option value="all">All priorities</option>{(Object.keys(PRIORITY_LABELS) as AgentMeshInboxPriority[]).map((value) => <option key={value} value={value}>{PRIORITY_LABELS[value]}</option>)}</select></label>
            <label><span>Sort</span><select aria-label="Inbox sort order" value={sort} onChange={(event) => setSort(event.target.value as AgentMeshInboxSort)}><option value="priority">Priority first</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="sender">Sender A–Z</option></select></label>
            <label className="agent-mesh-inbox-preview__check"><input type="checkbox" checked={decisionOnly} onChange={(event) => setDecisionOnly(event.target.checked)} /> Needs decision</label>
            <button type="button" className="button button--ghost" onClick={clearFilters}>Reset</button>
          </div>

          <div className="agent-mesh-inbox-preview__bulk" role="toolbar" aria-label="Inbox bulk actions">
            <span>{selectedVisibleIds.length} selected · {visibleItems.length} visible</span>
            <button type="button" className="button button--ghost" onClick={selectVisible} disabled={!visibleItems.length}>Select visible</button>
            <button type="button" className="button button--ghost" onClick={() => updateStatus(selectedVisibleIds, "triaged", "Triaged")} disabled={!selectedVisibleIds.length}><MailCheck size={13} /> Triage selected</button>
            <button type="button" className="button button--ghost" onClick={() => updateStatus(selectedVisibleIds, "snoozed", "Snoozed")} disabled={!selectedVisibleIds.length}><Archive size={13} /> Snooze selected</button>
            <button type="button" className="button button--ghost" onClick={clearSelection} disabled={!selectedIds.length}>Clear</button>
          </div>

          <div className="agent-mesh-inbox-preview__queue-layout">
            <div className="agent-mesh-inbox-preview__list" role="list" aria-label="Agent Mesh inbox messages">
              {visibleItems.length ? visibleItems.map((item) => (
                <div key={item.id} className={`agent-mesh-inbox-preview__row ${selectedIds.includes(item.id) ? "is-checked" : ""}`} role="listitem">
                  <input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => toggleSelection(item.id)} aria-label={`Select inbox message ${item.subject}`} />
                  <button type="button" className={`agent-mesh-inbox-preview__item ${selectedId === item.id ? "is-selected" : ""}`} onClick={() => setSelectedId(item.id)}>
                    <span className={`agent-mesh-inbox-preview__priority agent-mesh-inbox-preview__priority--${priorityTone(item.priority)}`}>{item.priority === "urgent" ? <ShieldAlert size={13} /> : <span aria-hidden="true" />}</span>
                    <span className="agent-mesh-inbox-preview__item-copy"><strong>{item.subject}</strong><small>{item.sender} → {item.recipient} · {item.createdAt} · {KIND_LABELS[item.kind]}</small><span>{item.summary}</span><em>{item.tags.slice(0, 3).map((tag) => `#${tag}`).join(" ")}</em></span>
                    <span className={`agent-mesh-inbox-preview__status agent-mesh-inbox-preview__status--${statusTone(item.status)}`}>{STATUS_LABELS[item.status]}</span>
                  </button>
                </div>
              )) : <p className="agent-mesh-inbox-preview__empty">No inbox messages match the current filters.</p>}
            </div>

            <aside className="agent-mesh-inbox-preview__detail" aria-label="Selected inbox message">
              {selectedItem ? (
                <>
                  <div className="agent-mesh-inbox-preview__detail-top"><span className={`agent-mesh-inbox-preview__status agent-mesh-inbox-preview__status--${statusTone(selectedItem.status)}`}>{STATUS_LABELS[selectedItem.status]}</span><span className={`agent-mesh-inbox-preview__priority-label agent-mesh-inbox-preview__priority-label--${selectedItem.priority}`}>{PRIORITY_LABELS[selectedItem.priority]}</span></div>
                  <span className="eyebrow">{selectedItem.id}</span>
                  <h3>{selectedItem.subject}</h3>
                  <p>{selectedItem.summary}</p>
                  <dl><div><dt>Route</dt><dd>{selectedItem.sender} → {selectedItem.recipient}</dd></div><div><dt>Kind</dt><dd>{KIND_LABELS[selectedItem.kind]}</dd></div><div><dt>Task</dt><dd>{selectedItem.taskId}</dd></div><div><dt>Sensitivity</dt><dd>{selectedItem.sensitivity}</dd></div><div><dt>Created</dt><dd>{selectedItem.createdAt} · {selectedItem.ageMinutes} min ago</dd></div></dl>
                  <div className="agent-mesh-inbox-preview__tags" aria-label="Session message tags">{selectedItem.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
                  <div className="agent-mesh-inbox-preview__actions" role="toolbar" aria-label="Selected message actions">
                    <button type="button" className="button button--secondary" onClick={() => updateStatus([selectedItem.id], selectedItem.status === "triaged" ? "new" : "triaged", selectedItem.status === "triaged" ? "Marked unread" : "Triaged")}><Check size={13} /> {selectedItem.status === "triaged" ? "Mark unread" : "Triage"}</button>
                    <button type="button" className="button button--ghost" onClick={() => updateStatus([selectedItem.id], "escalated", "Escalated")}><ShieldAlert size={13} /> Escalate</button>
                    <button type="button" className="button button--ghost" onClick={() => updateStatus([selectedItem.id], "snoozed", "Snoozed")}><Archive size={13} /> Snooze</button>
                  </div>
                  <div className="agent-mesh-inbox-preview__detail-tools">
                    <label><span>Session tag</span><span className="agent-mesh-inbox-preview__tag-input"><Tag size={13} /><input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="add a tag" aria-label="Session tag" /><button type="button" onClick={addTag} aria-label="Add session tag"><ChevronRight size={13} /></button></span></label>
                    <label><span>Triage note</span><textarea value={note} onChange={(event) => setNote(event.target.value.slice(0, 280))} placeholder="Optional note for this preview session" aria-label="Session triage note" /></label>
                    <div className="agent-mesh-inbox-preview__detail-tool-actions"><button type="button" className="button button--ghost" onClick={() => { setAnnouncement(`Prepared a reply draft for ${selectedItem.subject}; no message was sent.`); appendActivity(`Prepared a reply draft for ${selectedItem.subject}.`); }}><MessageCircleMore size={13} /> Prepare reply</button><button type="button" className="button button--ghost" onClick={() => { setAnnouncement(`Prepared a follow-up for ${selectedItem.taskId}; no task was created.`); appendActivity(`Prepared a follow-up for ${selectedItem.taskId}.`); }}><Send size={13} /> Follow-up</button></div>
                  </div>
                </>
              ) : <p className="agent-mesh-inbox-preview__empty">Select a message to inspect its bounded route.</p>}
            </aside>
          </div>
        </div>
      ) : null}

      {tab === "routes" ? (
        <div id="agent-mesh-inbox-panel-routes" className="agent-mesh-inbox-preview__routes" role="tabpanel" aria-label="Inbox routes" tabIndex={0}>
          <div className="agent-mesh-inbox-preview__panel-heading"><div><span className="eyebrow"><Users size={13} /> Route density</span><h3>Who is waiting on whom?</h3><p>Route summaries are derived from the seeded messages and stay inside this renderer session.</p></div><span className="agent-mesh-inbox-preview__panel-count">{routeSummaries.length} routes</span></div>
          <div className="agent-mesh-inbox-preview__route-grid">{routeSummaries.map((route) => <article className="agent-mesh-inbox-preview__route-card" key={route.route}><div className="agent-mesh-inbox-preview__route-heading"><strong>{route.route}</strong><span>{route.count} message{route.count === 1 ? "" : "s"}</span></div><div className="agent-mesh-inbox-preview__route-stats"><span><b>{route.unread}</b> new</span><span><b>{route.decisionCount}</b> decisions</span></div><div className="agent-mesh-inbox-preview__route-priorities">{route.priorities.map((priority) => <span key={priority} className={`agent-mesh-inbox-preview__priority-label agent-mesh-inbox-preview__priority-label--${priority}`}>{PRIORITY_LABELS[priority]}</span>)}</div><button type="button" className="button button--ghost" aria-label={`Open route ${route.route}`} onClick={() => { setTab("queue"); setQuery(route.route); setAnnouncement(`Filtered the triage queue to ${route.route}.`); }}>Open route <ChevronRight size={13} /></button></article>)}</div>
        </div>
      ) : null}

      {tab === "activity" ? (
        <div id="agent-mesh-inbox-panel-activity" className="agent-mesh-inbox-preview__activity" role="tabpanel" aria-label="Inbox session activity" tabIndex={0}>
          <div className="agent-mesh-inbox-preview__panel-heading"><div><span className="eyebrow"><Clock3 size={13} /> Session activity</span><h3>Rehearsal trail</h3><p>Actions below are local UI intent only; they are not mailbox or scheduler receipts.</p></div><button type="button" className="button button--ghost" onClick={() => { setActivity([]); setAnnouncement("Session activity cleared; no native journal was changed."); }} disabled={!activity.length}>Clear activity</button></div>
          <ol className="agent-mesh-inbox-preview__activity-list">{activity.length ? activity.map((entry, index) => <li key={`${entry}-${index}`}><span className="agent-mesh-inbox-preview__activity-icon"><MailCheck size={13} /></span><div><strong>{entry}</strong><small>Renderer session · no durable receipt</small></div></li>) : <li className="agent-mesh-inbox-preview__activity-empty">No session actions yet.</li>}</ol>
          {note ? <div className="agent-mesh-inbox-preview__saved-note"><strong>Current note draft</strong><p>{note}</p><small>Not saved and not attached to a native message.</small></div> : null}
        </div>
      ) : null}

      <p className="agent-mesh-inbox-preview__status-line" role="status" aria-live="polite">{announcement}</p>
      <p className="agent-mesh-inbox-preview__boundary"><Info size={14} /><span>Renderer-local inbox rehearsal. It does not send or acknowledge native mailbox messages, spawn agents, acquire leases, dispatch providers, execute tools, persist notes/tags, or read the filesystem. {linkedWorkCount ? `${linkedWorkCount} linked background item${linkedWorkCount === 1 ? "" : "s"} are shown only as contextual input.` : "No native background projection is linked."}</span></p>
    </section>
  );
}
