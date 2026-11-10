import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clipboard,
  CircleDot,
  Columns3,
  Clock3,
  Download,
  FileJson2,
  History,
  Info,
  Mail,
  Network,
  Pause,
  RotateCcw,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

import {
  downloadAgentMeshExport,
  serializeAgentMeshExport,
  type AgentMeshExportFormat,
  type AgentMeshExportScope,
} from "./agent-mesh-export";

export type AgentMeshView = "mesh" | "board" | "mailbox" | "leases";
export type AgentMeshFilter = "all" | "active" | "attention" | "terminal";
export type AgentMeshMailboxDeliveryFilter = "all" | "unread" | "acknowledged";
export type AgentMeshMailboxSensitivityFilter = "all" | "normal" | "sensitive" | "restricted";
export type AgentMeshAgentState =
  | "created"
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "orphaned"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentMeshAgent {
  readonly id: string;
  readonly label: string;
  readonly role: string;
  readonly state: AgentMeshAgentState;
  readonly depth: number;
  readonly parentId?: string;
  readonly objective: string;
  readonly contextMode: string;
  readonly outputRoute: string;
  readonly authority: string;
  readonly budgetUsed: number;
  readonly budgetLimit: number;
  readonly mailboxUnread: number;
}

export interface AgentMeshMessage {
  readonly id: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly kind: "finding" | "question" | "answer" | "handoff" | "progress" | "control";
  readonly summary: string;
  readonly createdAt: string;
  readonly acknowledged: boolean;
  readonly sensitivity: "normal" | "sensitive" | "restricted";
}

export interface AgentMeshLease {
  readonly id: string;
  readonly taskId: string;
  readonly ownerId: string;
  readonly status: "active" | "released" | "expired";
  readonly epoch: number;
  readonly heartbeat: string;
  readonly expires: string;
}

export type AgentMeshLeaseEventKind = "acquired" | "heartbeat" | "renewed" | "released" | "expired";

export interface AgentMeshLeaseEvent {
  readonly id: string;
  readonly leaseId: string;
  readonly kind: AgentMeshLeaseEventKind;
  readonly occurredAt: string;
  readonly epoch: number;
  readonly summary: string;
}

const AGENTS: readonly AgentMeshAgent[] = [
  {
    id: "agent:orchestrator",
    label: "Omnia orchestrator",
    role: "orchestrator",
    state: "running",
    depth: 0,
    objective: "Break the current goal into bounded, reviewable work slices.",
    contextMode: "team",
    outputRoute: "fixed → parent run",
    authority: "No new authority",
    budgetUsed: 42,
    budgetLimit: 100,
    mailboxUnread: 2,
  },
  {
    id: "agent:researcher",
    label: "Evidence researcher",
    role: "researcher",
    state: "waiting",
    depth: 1,
    parentId: "agent:orchestrator",
    objective: "Collect source-backed findings and unresolved questions.",
    contextMode: "fork",
    outputRoute: "inbox-only",
    authority: "Read-only references",
    budgetUsed: 68,
    budgetLimit: 80,
    mailboxUnread: 1,
  },
  {
    id: "agent:builder",
    label: "UI builder",
    role: "builder",
    state: "running",
    depth: 1,
    parentId: "agent:orchestrator",
    objective: "Implement a visible, reversible renderer slice.",
    contextMode: "persistent",
    outputRoute: "fixed → project branch",
    authority: "Renderer source only",
    budgetUsed: 54,
    budgetLimit: 90,
    mailboxUnread: 0,
  },
  {
    id: "agent:verifier",
    label: "Truthfulness verifier",
    role: "verifier",
    state: "blocked",
    depth: 2,
    parentId: "agent:builder",
    objective: "Check that preview wording does not imply native execution.",
    contextMode: "fresh",
    outputRoute: "follow-active (preview)",
    authority: "No provider or filesystem access",
    budgetUsed: 31,
    budgetLimit: 40,
    mailboxUnread: 1,
  },
  {
    id: "agent:reviewer",
    label: "UX reviewer",
    role: "reviewer",
    state: "completed",
    depth: 1,
    parentId: "agent:orchestrator",
    objective: "Review information hierarchy and interaction affordances.",
    contextMode: "fork",
    outputRoute: "inbox-only",
    authority: "Renderer observation only",
    budgetUsed: 73,
    budgetLimit: 75,
    mailboxUnread: 0,
  },
] as const;

const MESSAGES: readonly AgentMeshMessage[] = [
  { id: "mail:1", senderId: "agent:researcher", recipientId: "agent:orchestrator", kind: "finding", summary: "Three source-ledger projections are stale on the current tree.", createdAt: "09:18", acknowledged: false, sensitivity: "normal" },
  { id: "mail:2", senderId: "agent:orchestrator", recipientId: "agent:builder", kind: "handoff", summary: "Keep this slice renderer-local and add a focused smoke test.", createdAt: "09:16", acknowledged: true, sensitivity: "normal" },
  { id: "mail:3", senderId: "agent:verifier", recipientId: "agent:builder", kind: "question", summary: "Should a blocked child expose a reclaim-lease affordance?", createdAt: "09:14", acknowledged: false, sensitivity: "sensitive" },
  { id: "mail:4", senderId: "agent:builder", recipientId: "agent:orchestrator", kind: "progress", summary: "Agent Mesh preview is ready for user inspection.", createdAt: "09:12", acknowledged: true, sensitivity: "normal" },
] as const;

const LEASES: readonly AgentMeshLease[] = [
  { id: "lease:1", taskId: "task:ui-preview", ownerId: "agent:builder", status: "active", epoch: 2, heartbeat: "09:19", expires: "09:29" },
  { id: "lease:2", taskId: "task:source-audit", ownerId: "agent:researcher", status: "active", epoch: 1, heartbeat: "09:18", expires: "09:24" },
  { id: "lease:3", taskId: "task:prior-logo-study", ownerId: "agent:reviewer", status: "released", epoch: 1, heartbeat: "08:58", expires: "09:03" },
  { id: "lease:4", taskId: "task:stale-verifier", ownerId: "agent:verifier", status: "expired", epoch: 3, heartbeat: "08:52", expires: "08:57" },
] as const;

/**
 * Illustrative lifecycle entries for the visible lease fixtures. These are not
 * native journal events and cannot be used to acquire, renew, reclaim, or
 * release a durable lease.
 */
export const LEASE_EVENTS: readonly AgentMeshLeaseEvent[] = [
  { id: "lease-event:1", leaseId: "lease:1", kind: "acquired", occurredAt: "09:00", epoch: 1, summary: "Lease acquired for the UI preview task." },
  { id: "lease-event:2", leaseId: "lease:1", kind: "heartbeat", occurredAt: "09:05", epoch: 1, summary: "Owner heartbeat observed before the fencing epoch advanced." },
  { id: "lease-event:3", leaseId: "lease:1", kind: "renewed", occurredAt: "09:10", epoch: 2, summary: "Fixture renewal advanced the fencing epoch to 2." },
  { id: "lease-event:4", leaseId: "lease:1", kind: "heartbeat", occurredAt: "09:19", epoch: 2, summary: "Latest illustrative heartbeat for the active lease." },
  { id: "lease-event:5", leaseId: "lease:2", kind: "acquired", occurredAt: "09:06", epoch: 1, summary: "Lease acquired for the source audit task." },
  { id: "lease-event:6", leaseId: "lease:2", kind: "heartbeat", occurredAt: "09:18", epoch: 1, summary: "Owner heartbeat observed for the active lease." },
  { id: "lease-event:7", leaseId: "lease:3", kind: "acquired", occurredAt: "08:44", epoch: 1, summary: "Lease acquired for the prior logo study." },
  { id: "lease-event:8", leaseId: "lease:3", kind: "heartbeat", occurredAt: "08:52", epoch: 1, summary: "Final heartbeat before the lease was released." },
  { id: "lease-event:9", leaseId: "lease:3", kind: "released", occurredAt: "08:58", epoch: 1, summary: "Fixture release closed the completed task lease." },
  { id: "lease-event:10", leaseId: "lease:4", kind: "acquired", occurredAt: "08:31", epoch: 3, summary: "Lease acquired for the stale verifier task." },
  { id: "lease-event:11", leaseId: "lease:4", kind: "heartbeat", occurredAt: "08:52", epoch: 3, summary: "Last owner heartbeat recorded before expiry." },
  { id: "lease-event:12", leaseId: "lease:4", kind: "expired", occurredAt: "08:57", epoch: 3, summary: "Fixture expiry marked the lease as requiring native recovery review." },
] as const;

const agentById = new Map(AGENTS.map((agent) => [agent.id, agent]));

const AGENT_BOARD_LANES = [
  { id: "intake", label: "Intake", detail: "Created or queued", states: ["created", "queued"] },
  { id: "running", label: "Running", detail: "Actively working", states: ["running"] },
  { id: "waiting", label: "Waiting", detail: "Paused on a dependency or response", states: ["waiting"] },
  { id: "attention", label: "Attention", detail: "Blocked, orphaned, or failed", states: ["blocked", "orphaned", "failed"] },
  { id: "done", label: "Done", detail: "Completed or cancelled", states: ["completed", "cancelled"] },
] as const;

const stateLabels: Record<AgentMeshAgentState, string> = {
  created: "Created",
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  blocked: "Blocked",
  orphaned: "Orphaned",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function filterMatches(agent: AgentMeshAgent, filter: AgentMeshFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return agent.state === "running" || agent.state === "queued" || agent.state === "waiting";
  if (filter === "attention") return agent.state === "blocked" || agent.state === "orphaned" || agent.state === "failed";
  return agent.state === "completed" || agent.state === "cancelled";
}

function stateIcon(state: AgentMeshAgentState) {
  if (state === "completed") return <CheckCircle2 size={13} aria-hidden="true" />;
  if (state === "blocked" || state === "failed" || state === "orphaned") return <AlertTriangle size={13} aria-hidden="true" />;
  if (state === "running") return <CircleDot size={13} aria-hidden="true" />;
  return <Clock3 size={13} aria-hidden="true" />;
}

function stateTone(state: AgentMeshAgentState): string {
  if (state === "running") return "running";
  if (state === "completed") return "completed";
  if (state === "blocked" || state === "failed" || state === "orphaned") return "attention";
  return "neutral";
}

function agentLabel(id: string): string {
  return agentById.get(id)?.label ?? id;
}

function searchableText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function agentMatchesSearch(agent: AgentMeshAgent, query: string): boolean {
  if (!query) return true;
  const haystack = [
    agent.id,
    agent.label,
    agent.role,
    agent.state,
    agent.objective,
    agent.contextMode,
    agent.outputRoute,
    agent.authority,
  ].join(" ");
  return searchableText(haystack).includes(query);
}

function messageMatchesSearch(message: AgentMeshMessage, query: string): boolean {
  if (!query) return true;
  const haystack = [
    message.id,
    message.senderId,
    agentLabel(message.senderId),
    message.recipientId,
    agentLabel(message.recipientId),
    message.kind,
    message.summary,
    message.createdAt,
    message.sensitivity,
  ].join(" ");
  return searchableText(haystack).includes(query);
}

function messageMatchesFilters(
  message: AgentMeshMessage,
  deliveryFilter: AgentMeshMailboxDeliveryFilter,
  sensitivityFilter: AgentMeshMailboxSensitivityFilter,
): boolean {
  const matchesDelivery = deliveryFilter === "all"
    || (deliveryFilter === "unread" && !message.acknowledged)
    || (deliveryFilter === "acknowledged" && message.acknowledged);
  const matchesSensitivity = sensitivityFilter === "all" || message.sensitivity === sensitivityFilter;
  return matchesDelivery && matchesSensitivity;
}

function leaseMatchesSearch(lease: AgentMeshLease, query: string): boolean {
  if (!query) return true;
  const haystack = [
    lease.id,
    lease.taskId,
    lease.ownerId,
    agentLabel(lease.ownerId),
    lease.status,
    String(lease.epoch),
    lease.heartbeat,
    lease.expires,
  ].join(" ");
  return searchableText(haystack).includes(query);
}

function leaseEventIcon(kind: AgentMeshLeaseEventKind) {
  if (kind === "released") return <Pause size={13} aria-hidden="true" />;
  if (kind === "expired") return <AlertTriangle size={13} aria-hidden="true" />;
  if (kind === "heartbeat") return <Clock3 size={13} aria-hidden="true" />;
  return <History size={13} aria-hidden="true" />;
}

function leaseEventTone(kind: AgentMeshLeaseEventKind): string {
  if (kind === "released") return "released";
  if (kind === "expired") return "expired";
  if (kind === "heartbeat") return "heartbeat";
  return "neutral";
}

function leaseEventLabel(kind: AgentMeshLeaseEventKind): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export interface AgentMeshPreviewProps {
  readonly linkedWorkCount?: number;
}

function AgentDetail({
  agent,
  onPreviewAction,
}: {
  readonly agent: AgentMeshAgent | null;
  readonly onPreviewAction: (message: string) => void;
}) {
  return (
    <aside className="agent-mesh-preview__detail" aria-label="Selected agent detail">
      {agent ? <>
        <div className="agent-mesh-preview__detail-heading"><span className={`agent-mesh-preview__state agent-mesh-preview__state--${stateTone(agent.state)}`}>{stateIcon(agent.state)} {stateLabels[agent.state]}</span><small>depth {agent.depth}</small></div>
        <h3>{agent.label}</h3>
        <p>{agent.objective}</p>
        <dl><div><dt>Parent</dt><dd>{agent.parentId ? agentLabel(agent.parentId) : "Graph root"}</dd></div><div><dt>Context</dt><dd>{agent.contextMode}</dd></div><div><dt>Output route</dt><dd>{agent.outputRoute}</dd></div><div><dt>Authority</dt><dd>{agent.authority}</dd></div><div><dt>Budget</dt><dd>{agent.budgetUsed} / {agent.budgetLimit}</dd></div><div><dt>Unread</dt><dd>{agent.mailboxUnread}</dd></div></dl>
        <div className="agent-mesh-preview__actions"><button type="button" className="button button--secondary" onClick={() => onPreviewAction(`Queue child under ${agent.label}.`)}><Send size={13} /> Queue child</button><button type="button" className="button button--secondary" onClick={() => onPreviewAction(`Prepare handoff from ${agent.label}.`)}><Mail size={13} /> Handoff</button><button type="button" className="button button--secondary" onClick={() => onPreviewAction(`Rehearse lease recovery for ${agent.label}.`)}><RotateCcw size={13} /> Reclaim lease</button></div>
      </> : <p className="agent-mesh-preview__empty">Select an agent to inspect its bounded contract.</p>}
    </aside>
  );
}

/**
 * Renderer-local rehearsal of the agent graph, mailbox and lease ledger.
 *
 * The domain contracts already model these records, but no native scheduler,
 * durable mailbox, lease authority or agent executor is wired to this view.
 */
export function AgentMeshPreview({ linkedWorkCount = 0 }: AgentMeshPreviewProps) {
  const [view, setView] = useState<AgentMeshView>("mesh");
  const [filter, setFilter] = useState<AgentMeshFilter>("all");
  const [selectedAgentId, setSelectedAgentId] = useState(AGENTS[0]?.id ?? null);
  const [selectedMessageId, setSelectedMessageId] = useState(MESSAGES[0]?.id ?? null);
  const [selectedLeaseId, setSelectedLeaseId] = useState(LEASES[0]?.id ?? null);
  const [searchQuery, setSearchQuery] = useState("");
  const [mailboxDeliveryFilter, setMailboxDeliveryFilter] = useState<AgentMeshMailboxDeliveryFilter>("all");
  const [mailboxSensitivityFilter, setMailboxSensitivityFilter] = useState<AgentMeshMailboxSensitivityFilter>("all");
  const [selectedMessageIds, setSelectedMessageIds] = useState<readonly string[]>([]);
  const [messageAcknowledgementOverrides, setMessageAcknowledgementOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const [announcement, setAnnouncement] = useState("Renderer-local mesh preview; no agent was dispatched.");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<AgentMeshExportFormat>("json");
  const [exportScope, setExportScope] = useState<AgentMeshExportScope>("all");
  const [exportStatus, setExportStatus] = useState("Renderer-session export preview; no durable write.");

  const normalizedSearch = searchableText(searchQuery);
  const sessionMessages = useMemo(
    () => MESSAGES.map((message) => Object.prototype.hasOwnProperty.call(messageAcknowledgementOverrides, message.id)
      ? { ...message, acknowledged: messageAcknowledgementOverrides[message.id] ?? message.acknowledged }
      : message),
    [messageAcknowledgementOverrides],
  );
  const visibleAgents = useMemo(
    () => AGENTS.filter((agent) => filterMatches(agent, filter) && agentMatchesSearch(agent, normalizedSearch)),
    [filter, normalizedSearch],
  );
  const visibleMessages = useMemo(
    () => sessionMessages.filter((message) => messageMatchesSearch(message, normalizedSearch) && messageMatchesFilters(message, mailboxDeliveryFilter, mailboxSensitivityFilter)),
    [mailboxDeliveryFilter, mailboxSensitivityFilter, normalizedSearch, sessionMessages],
  );
  const visibleLeases = useMemo(
    () => LEASES.filter((lease) => leaseMatchesSearch(lease, normalizedSearch)),
    [normalizedSearch],
  );
  const selectedAgent = visibleAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedMessage = visibleMessages.find((message) => message.id === selectedMessageId) ?? null;
  const selectedLease = visibleLeases.find((lease) => lease.id === selectedLeaseId) ?? null;
  const selectedLeaseEvents = selectedLease
    ? LEASE_EVENTS.filter((event) => event.leaseId === selectedLease.id)
    : [];
  const activeCount = AGENTS.filter((agent) => agent.state === "running" || agent.state === "waiting").length;
  const attentionCount = AGENTS.filter((agent) => filterMatches(agent, "attention")).length;
  const unreadCount = sessionMessages.filter((message) => !message.acknowledged).length;
  const activeLeaseCount = LEASES.filter((lease) => lease.status === "active").length;
  const selectedVisibleMessageIds = visibleMessages.filter((message) => selectedMessageIds.includes(message.id)).map((message) => message.id);
  const meshViews: readonly AgentMeshView[] = ["mesh", "board", "mailbox", "leases"];
  const exportPayload = useMemo(
    () => serializeAgentMeshExport({
      agents: AGENTS,
      messages: sessionMessages,
      leases: LEASES,
      leaseEvents: LEASE_EVENTS,
      format: exportFormat,
      scope: exportScope,
      selectedAgentId,
    }),
    [exportFormat, exportScope, selectedAgentId, sessionMessages],
  );

  const previewAction = (message: string) => setAnnouncement(`${message} Renderer-local preview only; no native mutation was made.`);
  const toggleMessageSelection = (messageId: string) => {
    setSelectedMessageIds((current) => current.includes(messageId)
      ? current.filter((id) => id !== messageId)
      : [...current, messageId]);
  };
  const selectVisibleMessages = () => {
    setSelectedMessageIds((current) => Array.from(new Set([...current, ...visibleMessages.map((message) => message.id)])));
    setAnnouncement(`${visibleMessages.length} visible mailbox message${visibleMessages.length === 1 ? "" : "s"} selected in this renderer session.`);
  };
  const clearVisibleMessageSelection = () => {
    const visibleIds = new Set(visibleMessages.map((message) => message.id));
    setSelectedMessageIds((current) => current.filter((id) => !visibleIds.has(id)));
    setAnnouncement(`${visibleMessages.length} visible mailbox message${visibleMessages.length === 1 ? "" : "s"} removed from the session selection.`);
  };
  const updateMessageAcknowledgement = (messageIds: readonly string[], acknowledged: boolean) => {
    if (!messageIds.length) {
      setAnnouncement("Select at least one visible mailbox message first; no native mutation was made.");
      return;
    }
    setMessageAcknowledgementOverrides((current) => {
      const next = { ...current };
      messageIds.forEach((messageId) => { next[messageId] = acknowledged; });
      return next;
    });
    setAnnouncement(`${acknowledged ? "Acknowledged" : "Marked unread"} ${messageIds.length} mailbox message${messageIds.length === 1 ? "" : "s"} in this renderer session; no native mutation was made.`);
  };
  const clearMessageSelection = () => {
    setSelectedMessageIds([]);
    setAnnouncement("Mailbox selection cleared in this renderer session.");
  };
  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard is unavailable; the visible export preview remains available.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setExportStatus(`${exportFormat.toUpperCase()} agent mesh preview copied; no durable write was made.`);
    } catch {
      setExportStatus("Clipboard access was denied; no agent mesh preview was copied.");
    }
  };
  const downloadExport = () => {
    setExportStatus(
      downloadAgentMeshExport(exportPayload, exportFormat)
        ? `${exportFormat.toUpperCase()} browser download started; no native export receipt was created.`
        : "Download is unavailable in this preview; copy the visible export instead.",
    );
  };
  const moveViewTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? meshViews.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + meshViews.length) % meshViews.length;
    const nextView = meshViews[nextIndex];
    if (!nextView) return;
    setView(nextView);
    document.getElementById(`agent-mesh-tab-${nextView}`)?.focus();
  };

  return (
    <section className="agent-mesh-preview" aria-label="Agent mesh coordination preview">
      <header className="agent-mesh-preview__header">
        <div>
          <span className="eyebrow"><Network size={13} /> Agent harness</span>
          <h2>Agent Mesh &amp; coordination</h2>
          <p>Inspect graph lineage, bounded handoffs, and lease signals in one place. The surface is a rehearsal of the native contracts, not an executor.</p>
        </div>
        <div className="agent-mesh-preview__header-actions">
          <span className="agent-mesh-preview__badge"><Bot size={12} /> Preview</span>
          <button type="button" className="button button--ghost" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="agent-mesh-export-preview">
            <FileJson2 size={13} /> {exportOpen ? "Hide export" : "Export"}
          </button>
        </div>
      </header>

      <div className="agent-mesh-preview__metrics" aria-label="Agent mesh summary">
        <div><strong>{AGENTS.length}</strong><span>graph members</span></div>
        <div><strong>{activeCount}</strong><span>active / waiting</span></div>
        <div><strong>{attentionCount}</strong><span>needs attention</span></div>
        <div><strong>{unreadCount}</strong><span>unread mailbox</span></div>
        <div><strong>{activeLeaseCount}</strong><span>active leases</span></div>
      </div>

      <div className="agent-mesh-preview__toolbar" role="toolbar" aria-label="Agent mesh controls">
        <div className="agent-mesh-preview__tabs" role="tablist" aria-label="Agent mesh view" aria-orientation="horizontal">
          <button id="agent-mesh-tab-mesh" type="button" role="tab" aria-selected={view === "mesh"} aria-controls="agent-mesh-panel-mesh" tabIndex={view === "mesh" ? 0 : -1} className={view === "mesh" ? "is-active" : ""} onClick={() => setView("mesh")} onKeyDown={(event) => moveViewTab(event, 0)}><Network size={13} /> Mesh</button>
          <button id="agent-mesh-tab-board" type="button" role="tab" aria-selected={view === "board"} aria-controls="agent-mesh-panel-board" tabIndex={view === "board" ? 0 : -1} className={view === "board" ? "is-active" : ""} onClick={() => setView("board")} onKeyDown={(event) => moveViewTab(event, 1)}><Columns3 size={13} /> Board</button>
          <button id="agent-mesh-tab-mailbox" type="button" role="tab" aria-selected={view === "mailbox"} aria-controls="agent-mesh-panel-mailbox" tabIndex={view === "mailbox" ? 0 : -1} className={view === "mailbox" ? "is-active" : ""} onClick={() => setView("mailbox")} onKeyDown={(event) => moveViewTab(event, 2)}><Mail size={13} /> Mailbox <span>{unreadCount}</span></button>
          <button id="agent-mesh-tab-leases" type="button" role="tab" aria-selected={view === "leases"} aria-controls="agent-mesh-panel-leases" tabIndex={view === "leases" ? 0 : -1} className={view === "leases" ? "is-active" : ""} onClick={() => setView("leases")} onKeyDown={(event) => moveViewTab(event, 3)}><ShieldCheck size={13} /> Leases</button>
        </div>
        <div className="agent-mesh-preview__toolbar-filters">
          <label className="agent-mesh-preview__search"><span>Search</span><input aria-label="Search mesh records" type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="agent, task, message…" /></label>
          {searchQuery ? <button type="button" className="button button--ghost agent-mesh-preview__clear-search" onClick={() => setSearchQuery("")}>Clear</button> : null}
          <label className="agent-mesh-preview__filter"><span>Focus</span><select aria-label="Agent mesh focus" value={filter} onChange={(event) => setFilter(event.target.value as AgentMeshFilter)}><option value="all">All agents</option><option value="active">Active / waiting</option><option value="attention">Needs attention</option><option value="terminal">Terminal</option></select></label>
        </div>
      </div>

      {exportOpen ? (
        <section id="agent-mesh-export-preview" className="agent-mesh-preview__export" aria-label="Agent mesh export preview">
          <header className="agent-mesh-preview__export-heading">
            <div><span className="eyebrow"><Download size={12} /> Portable coordination view</span><h3>Export a scoped mesh projection</h3></div>
            <span className="agent-mesh-preview__export-boundary">No durable write</span>
          </header>
          <div className="agent-mesh-preview__export-toolbar" role="toolbar" aria-label="Agent mesh export actions">
            <label><span>Format</span><select aria-label="Agent mesh export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as AgentMeshExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
            <label><span>Scope</span><select aria-label="Agent mesh export scope" value={exportScope} onChange={(event) => setExportScope(event.target.value as AgentMeshExportScope)}><option value="all">All mesh records</option><option value="active">Active / waiting</option><option value="attention">Needs attention</option><option value="terminal">Terminal records</option><option value="selected">Selected agent</option></select></label>
            <button type="button" className="button button--ghost" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button>
            <button type="button" className="button button--secondary" onClick={downloadExport}><Download size={13} /> Download</button>
          </div>
          <p className="agent-mesh-preview__export-hint">Export uses its own scope selector; Search and Focus only narrow the on-screen rows.</p>
          <pre tabIndex={0} aria-label={`${exportFormat === "json" ? "JSON" : "Markdown"} Agent mesh export preview`}><code>{exportPayload}</code></pre>
          <p className="agent-mesh-preview__export-status" role="status" aria-live="polite">{exportStatus}</p>
        </section>
      ) : null}

      {view === "mesh" ? (
        <div id="agent-mesh-panel-mesh" className="agent-mesh-preview__mesh-layout" role="tabpanel" aria-labelledby="agent-mesh-tab-mesh" tabIndex={0}>
          <div className="agent-mesh-preview__graph" role="list" aria-label="Agent graph">
            {[0, 1, 2].map((depth) => {
              const depthAgents = visibleAgents.filter((agent) => agent.depth === depth);
            return <div className="agent-mesh-preview__depth" key={depth}><span className="agent-mesh-preview__depth-label">Depth {depth}</span><div>{depthAgents.length ? depthAgents.map((agent) => <button type="button" key={agent.id} className={`agent-mesh-preview__node agent-mesh-preview__node--${stateTone(agent.state)} ${selectedAgentId === agent.id ? "is-selected" : ""}`} onClick={() => setSelectedAgentId(agent.id)} aria-label={`${agent.label}. ${stateLabels[agent.state]}`}><span className="agent-mesh-preview__node-icon">{stateIcon(agent.state)}</span><span><strong>{agent.label}</strong><small>{agent.role} · {stateLabels[agent.state]}</small></span><ChevronRight size={13} aria-hidden="true" /></button>) : <p className="agent-mesh-preview__empty">No agents in this focus.</p>}</div></div>;
            })}
          </div>
          <AgentDetail agent={selectedAgent} onPreviewAction={previewAction} />
        </div>
      ) : null}

      {view === "board" ? (
        <div id="agent-mesh-panel-board" className="agent-mesh-preview__board-layout" role="tabpanel" aria-labelledby="agent-mesh-tab-board" tabIndex={0}>
          <div className="agent-mesh-preview__board" role="list" aria-label="Agent lifecycle board">
            {AGENT_BOARD_LANES.map((lane) => {
              const laneAgents = visibleAgents.filter((agent) => (lane.states as readonly string[]).includes(agent.state));
              return <section className={`agent-mesh-preview__lane agent-mesh-preview__lane--${lane.id}`} key={lane.id} aria-label={`${lane.label} agents`}>
                <header><span><strong>{lane.label}</strong><small>{lane.detail}</small></span><b>{laneAgents.length}</b></header>
                <div className="agent-mesh-preview__lane-cards">{laneAgents.length ? laneAgents.map((agent) => <button key={agent.id} type="button" className={`agent-mesh-preview__card ${selectedAgentId === agent.id ? "is-selected" : ""}`} onClick={() => setSelectedAgentId(agent.id)} aria-label={`${agent.label}. ${stateLabels[agent.state]}`}><span className={`agent-mesh-preview__node-icon agent-mesh-preview__node--${stateTone(agent.state)}`}>{stateIcon(agent.state)}</span><span><strong>{agent.label}</strong><small>{agent.role} · depth {agent.depth}</small><small>{agent.budgetUsed}/{agent.budgetLimit} budget · {agent.mailboxUnread} unread</small></span></button>) : <p className="agent-mesh-preview__empty">No agents in this lane.</p>}</div>
              </section>;
            })}
          </div>
          <AgentDetail agent={selectedAgent} onPreviewAction={previewAction} />
        </div>
      ) : null}

      {view === "mailbox" ? (
        <div id="agent-mesh-panel-mailbox" className="agent-mesh-preview__mailbox-panel" role="tabpanel" aria-labelledby="agent-mesh-tab-mailbox" tabIndex={0}>
          <div className="agent-mesh-preview__mailbox-toolbar" role="toolbar" aria-label="Mailbox triage controls">
            <div className="agent-mesh-preview__mailbox-filters">
              <label><span>Delivery</span><select aria-label="Mailbox delivery filter" value={mailboxDeliveryFilter} onChange={(event) => setMailboxDeliveryFilter(event.target.value as AgentMeshMailboxDeliveryFilter)}><option value="all">All delivery states</option><option value="unread">Unread</option><option value="acknowledged">Acknowledged</option></select></label>
              <label><span>Sensitivity</span><select aria-label="Mailbox sensitivity filter" value={mailboxSensitivityFilter} onChange={(event) => setMailboxSensitivityFilter(event.target.value as AgentMeshMailboxSensitivityFilter)}><option value="all">All sensitivity</option><option value="normal">Normal</option><option value="sensitive">Sensitive</option><option value="restricted">Restricted</option></select></label>
            </div>
            <div className="agent-mesh-preview__mailbox-actions">
              <span className="agent-mesh-preview__mailbox-count">{selectedVisibleMessageIds.length} selected · {visibleMessages.length} visible</span>
              <button type="button" className="button button--ghost" onClick={selectVisibleMessages}>Select visible</button>
              <button type="button" className="button button--ghost" onClick={clearVisibleMessageSelection}>Clear visible</button>
              <button type="button" className="button button--ghost" onClick={clearMessageSelection} disabled={!selectedMessageIds.length}>Clear selection</button>
              <button type="button" className="button button--secondary" onClick={() => updateMessageAcknowledgement(selectedVisibleMessageIds, true)} disabled={!selectedVisibleMessageIds.length}><CheckCircle2 size={13} /> Acknowledge selected</button>
              <button type="button" className="button button--secondary" onClick={() => updateMessageAcknowledgement(selectedVisibleMessageIds, false)} disabled={!selectedVisibleMessageIds.length}><RotateCcw size={13} /> Mark selected unread</button>
            </div>
          </div>
          <div className="agent-mesh-preview__ledger" role="list" aria-label="Agent mailbox messages">
            {visibleMessages.length ? visibleMessages.map((message) => (
              <div className={`agent-mesh-preview__message-row ${selectedMessageIds.includes(message.id) ? "is-selected" : ""}`} key={message.id} role="listitem">
                <input type="checkbox" aria-label={`Select mailbox message ${message.id}`} checked={selectedMessageIds.includes(message.id)} onChange={() => toggleMessageSelection(message.id)} />
                <button type="button" className={`agent-mesh-preview__message ${selectedMessageId === message.id ? "is-selected" : ""}`} onClick={() => setSelectedMessageId(message.id)}>
                  <span className={`agent-mesh-preview__message-dot ${message.acknowledged ? "is-read" : ""}`} />
                  <span><strong>{message.summary}</strong><small>{message.kind} · {agentLabel(message.senderId)} → {agentLabel(message.recipientId)} · {message.createdAt}</small></span>
                  <span className="agent-mesh-preview__message-sensitivity">{message.sensitivity}</span>
                </button>
              </div>
            )) : <p className="agent-mesh-preview__empty">No mailbox messages match the current search and filters.</p>}
          </div>
          <aside className="agent-mesh-preview__detail" aria-label="Selected mailbox message">
            {selectedMessage ? <>
              <span className="eyebrow">Message {selectedMessage.id}</span>
              <h3>{selectedMessage.summary}</h3>
              <p>{agentLabel(selectedMessage.senderId)} sent a {selectedMessage.kind} to {agentLabel(selectedMessage.recipientId)}.</p>
              <dl><div><dt>Delivery</dt><dd>{selectedMessage.acknowledged ? "Acknowledged" : "Awaiting acknowledgement"}</dd></div><div><dt>Sensitivity</dt><dd>{selectedMessage.sensitivity}</dd></div><div><dt>Created</dt><dd>{selectedMessage.createdAt}</dd></div></dl>
              <div className="agent-mesh-preview__actions">
                <button type="button" className="button button--secondary" onClick={() => updateMessageAcknowledgement([selectedMessage.id], !selectedMessage.acknowledged)}><CheckCircle2 size={13} /> {selectedMessage.acknowledged ? "Mark unread" : "Acknowledge"}</button>
                <button type="button" className="button button--ghost" onClick={() => toggleMessageSelection(selectedMessage.id)}>{selectedMessageIds.includes(selectedMessage.id) ? "Remove from selection" : "Select message"}</button>
              </div>
            </> : <p className="agent-mesh-preview__empty">Select a mailbox message.</p>}
          </aside>
        </div>
      ) : null}

      {view === "leases" ? <div id="agent-mesh-panel-leases" className="agent-mesh-preview__ledger-layout" role="tabpanel" aria-labelledby="agent-mesh-tab-leases" tabIndex={0}><div className="agent-mesh-preview__lease-list" role="list" aria-label="Agent task leases">{visibleLeases.length ? visibleLeases.map((lease) => <button type="button" key={lease.id} className={`agent-mesh-preview__lease agent-mesh-preview__lease--${lease.status} ${selectedLeaseId === lease.id ? "is-selected" : ""}`} onClick={() => setSelectedLeaseId(lease.id)}><span><strong>{lease.taskId}</strong><small>{agentLabel(lease.ownerId)} · epoch {lease.epoch}</small></span><span>{lease.status}</span></button>) : <p className="agent-mesh-preview__empty">No leases match this search.</p>}</div><aside className="agent-mesh-preview__detail" aria-label="Selected agent lease">{selectedLease ? <><span className="eyebrow">Lease {selectedLease.id}</span><h3>{selectedLease.taskId}</h3><p>Fencing epoch {selectedLease.epoch} is shown for review; this panel cannot acquire, heartbeat, or release a native lease.</p><dl><div><dt>Owner</dt><dd>{agentLabel(selectedLease.ownerId)}</dd></div><div><dt>Status</dt><dd>{selectedLease.status}</dd></div><div><dt>Heartbeat</dt><dd>{selectedLease.heartbeat}</dd></div><div><dt>Expires</dt><dd>{selectedLease.expires}</dd></div></dl><section className="agent-mesh-preview__timeline" aria-label="Lease lifecycle timeline"><header><span><History size={13} /> Lifecycle timeline</span><small>{selectedLeaseEvents.length} illustrative events</small></header>{selectedLeaseEvents.length ? <ol>{selectedLeaseEvents.map((event) => <li key={event.id} className={`agent-mesh-preview__timeline-event agent-mesh-preview__timeline-event--${leaseEventTone(event.kind)}`}><span className="agent-mesh-preview__timeline-icon">{leaseEventIcon(event.kind)}</span><div><strong>{leaseEventLabel(event.kind)}</strong><small>{event.occurredAt} · epoch {event.epoch}</small><p>{event.summary}</p></div></li>)}</ol> : <p className="agent-mesh-preview__empty">No illustrative lifecycle events are available for this lease.</p>}<p className="agent-mesh-preview__timeline-boundary">Fixture timeline only; it is not a native journal, lease receipt, or recovery authority.</p></section><div className="agent-mesh-preview__actions"><button type="button" className="button button--secondary" onClick={() => previewAction(`Heartbeat ${selectedLease.id}.`)}><Clock3 size={13} /> Heartbeat</button><button type="button" className="button button--secondary" onClick={() => previewAction(`Release ${selectedLease.id}.`)}><Pause size={13} /> Release</button></div></> : <p className="agent-mesh-preview__empty">Select a lease.</p>}</aside></div> : null}

      <p className="agent-mesh-preview__status" role="status" aria-live="polite">{announcement}</p>
      <p className="agent-mesh-preview__boundary"><Info size={14} /><span>Renderer-local coordination preview. It does not spawn agents, send mailbox messages, acquire leases, dispatch providers, execute tools, persist state, or read the filesystem. The board is read-only: Moving agents between lanes is not available until a native scheduler and lease authority exist. {linkedWorkCount ? `${linkedWorkCount} visible background item${linkedWorkCount === 1 ? "" : "s"} are available in the adjacent work projection.` : "No native work projection is linked yet."}</span></p>
    </section>
  );
}
