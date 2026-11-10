import { redactDiagnosticText } from "./diagnostics-session-contract";

import type {
  AgentMeshAgent,
  AgentMeshAgentState,
  AgentMeshLease,
  AgentMeshLeaseEvent,
  AgentMeshMessage,
} from "./agent-mesh-preview";

export type AgentMeshExportFormat = "json" | "markdown";
export type AgentMeshExportScope = "all" | "active" | "attention" | "terminal" | "selected";

export const AGENT_MESH_EXPORT_FORMAT = "omnia.agent-mesh.preview.v1" as const;
export const AGENT_MESH_EXPORT_VERSION = 1 as const;
export const AGENT_MESH_EXPORT_SCOPE = "renderer-session" as const;
export const AGENT_MESH_EXPORT_BOUNDARY =
  "Renderer-local preview only. Agent dispatch, mailbox delivery, lease authority, provider calls, filesystem access, and durable export receipts remain unavailable.";

const ACTIVE_STATES: readonly AgentMeshAgentState[] = ["created", "queued", "running", "waiting"];
const ATTENTION_STATES: readonly AgentMeshAgentState[] = ["blocked", "orphaned", "failed"];
const TERMINAL_STATES: readonly AgentMeshAgentState[] = ["completed", "cancelled"];

function safeText(value: unknown, maxLength: number): string {
  return redactDiagnosticText(value).slice(0, maxLength);
}

function safeAgent(agent: AgentMeshAgent) {
  return {
    id: safeText(agent.id, 180),
    label: safeText(agent.label, 240),
    role: safeText(agent.role, 100),
    state: agent.state,
    depth: agent.depth,
    parentId: agent.parentId ? safeText(agent.parentId, 180) : null,
    objective: safeText(agent.objective, 2_000),
    contextMode: safeText(agent.contextMode, 120),
    outputRoute: safeText(agent.outputRoute, 180),
    authority: safeText(agent.authority, 240),
    budgetUsed: agent.budgetUsed,
    budgetLimit: agent.budgetLimit,
    mailboxUnread: agent.mailboxUnread,
  };
}

function safeMessage(message: AgentMeshMessage) {
  return {
    id: safeText(message.id, 180),
    senderId: safeText(message.senderId, 180),
    recipientId: safeText(message.recipientId, 180),
    kind: message.kind,
    summary: safeText(message.summary, 2_000),
    createdAt: safeText(message.createdAt, 80),
    acknowledged: message.acknowledged,
    sensitivity: message.sensitivity,
  };
}

function safeLease(lease: AgentMeshLease) {
  return {
    id: safeText(lease.id, 180),
    taskId: safeText(lease.taskId, 180),
    ownerId: safeText(lease.ownerId, 180),
    status: lease.status,
    epoch: lease.epoch,
    heartbeat: safeText(lease.heartbeat, 80),
    expires: safeText(lease.expires, 80),
  };
}

function safeLeaseEvent(event: AgentMeshLeaseEvent) {
  return {
    id: safeText(event.id, 180),
    leaseId: safeText(event.leaseId, 180),
    kind: event.kind,
    occurredAt: safeText(event.occurredAt, 80),
    epoch: event.epoch,
    summary: safeText(event.summary, 2_000),
  };
}

function agentMatchesScope(agent: AgentMeshAgent, scope: AgentMeshExportScope, selectedAgentId: string | null): boolean {
  if (scope === "all") return true;
  if (scope === "selected") return agent.id === selectedAgentId;
  if (scope === "active") return ACTIVE_STATES.includes(agent.state);
  if (scope === "attention") return ATTENTION_STATES.includes(agent.state);
  return TERMINAL_STATES.includes(agent.state);
}

function leaseMatchesScope(lease: AgentMeshLease, scope: AgentMeshExportScope): boolean {
  if (scope === "all" || scope === "selected") return true;
  if (scope === "active") return lease.status === "active";
  if (scope === "attention") return lease.status === "expired";
  return lease.status === "released";
}

function markdownValue(value: string | number | boolean | null): string {
  if (value === null) return "Not retained";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function serializeAgentMeshExport(input: {
  readonly agents: readonly AgentMeshAgent[];
  readonly messages: readonly AgentMeshMessage[];
  readonly leases: readonly AgentMeshLease[];
  readonly leaseEvents?: readonly AgentMeshLeaseEvent[];
  readonly format: AgentMeshExportFormat;
  readonly scope: AgentMeshExportScope;
  readonly selectedAgentId?: string | null;
  readonly generatedAt?: string;
}): string {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const selectedAgentId = input.selectedAgentId ?? null;
  const agents = input.agents.filter((agent) => agentMatchesScope(agent, input.scope, selectedAgentId));
  const agentIds = new Set(agents.map((agent) => agent.id));
  const messages = input.messages.filter((message) => {
    if (input.scope === "all") return true;
    if (input.scope === "selected" || input.scope === "active" || input.scope === "attention" || input.scope === "terminal") {
      return agentIds.has(message.senderId) || agentIds.has(message.recipientId);
    }
    return false;
  });
  const leases = input.leases.filter((lease) => {
    if (!leaseMatchesScope(lease, input.scope)) return false;
    return input.scope === "all" || agentIds.has(lease.ownerId);
  });
  const safeAgents = agents.map(safeAgent);
  const safeMessages = messages.map(safeMessage);
  const safeLeases = leases.map(safeLease);
  const leaseIds = new Set(safeLeases.map((lease) => lease.id));
  const safeLeaseEvents = (input.leaseEvents ?? [])
    .filter((event) => leaseIds.has(event.leaseId))
    .map(safeLeaseEvent);

  if (input.format === "json") {
    return JSON.stringify({
      format: AGENT_MESH_EXPORT_FORMAT,
      version: AGENT_MESH_EXPORT_VERSION,
      scope: AGENT_MESH_EXPORT_SCOPE,
      selection: input.scope,
      selectedAgentId: selectedAgentId ? safeText(selectedAgentId, 180) : null,
      generatedAt,
      boundary: AGENT_MESH_EXPORT_BOUNDARY,
      counts: {
        agents: safeAgents.length,
        messages: safeMessages.length,
        leases: safeLeases.length,
        leaseEvents: safeLeaseEvents.length,
      },
      agents: safeAgents,
      messages: safeMessages,
      leases: safeLeases,
      leaseEvents: safeLeaseEvents,
    }, null, 2);
  }

  const agentSections = safeAgents.flatMap((agent) => [
    `### ${markdownValue(agent.label)}`,
    "",
    `- State: ${agent.state}`,
    `- Role: ${markdownValue(agent.role)}`,
    `- Depth: ${agent.depth}`,
    `- Parent: ${markdownValue(agent.parentId)}`,
    `- Objective: ${markdownValue(agent.objective)}`,
    `- Context: ${markdownValue(agent.contextMode)}`,
    `- Output route: ${markdownValue(agent.outputRoute)}`,
    `- Authority: ${markdownValue(agent.authority)}`,
    `- Budget: ${agent.budgetUsed} / ${agent.budgetLimit}`,
    `- Unread mailbox: ${agent.mailboxUnread}`,
    `- Agent ID: ${markdownValue(agent.id)}`,
    "",
  ]);
  const messageSections = safeMessages.flatMap((message) => [
    `### ${markdownValue(message.summary)}`,
    "",
    `- Kind: ${message.kind}`,
    `- Route: ${markdownValue(message.senderId)} → ${markdownValue(message.recipientId)}`,
    `- Created: ${markdownValue(message.createdAt)}`,
    `- Delivery: ${message.acknowledged ? "Acknowledged" : "Awaiting acknowledgement"}`,
    `- Sensitivity: ${message.sensitivity}`,
    `- Message ID: ${markdownValue(message.id)}`,
    "",
  ]);
  const leaseSections = safeLeases.flatMap((lease) => [
    `### ${markdownValue(lease.taskId)}`,
    "",
    `- Owner: ${markdownValue(lease.ownerId)}`,
    `- Status: ${lease.status}`,
    `- Epoch: ${lease.epoch}`,
    `- Heartbeat: ${markdownValue(lease.heartbeat)}`,
    `- Expires: ${markdownValue(lease.expires)}`,
    `- Lease ID: ${markdownValue(lease.id)}`,
    "",
  ]);

  return [
    "# Omnia agent mesh preview",
    "",
    `> ${AGENT_MESH_EXPORT_BOUNDARY}`,
    "",
    `- Generated: ${markdownValue(generatedAt)}`,
    `- Selection: ${input.scope}`,
    `- Agents: ${safeAgents.length}`,
    `- Messages: ${safeMessages.length}`,
    `- Leases: ${safeLeases.length}`,
    `- Lease events: ${safeLeaseEvents.length}`,
    "",
    "## Agents",
    "",
    ...(agentSections.length > 0 ? agentSections : ["No agents match this selection.", ""]),
    "## Mailbox",
    "",
    ...(messageSections.length > 0 ? messageSections : ["No messages match this selection.", ""]),
    "## Leases",
    "",
    ...(leaseSections.length > 0 ? leaseSections : ["No leases match this selection.", ""]),
    "## Lease lifecycle timeline",
    "",
    ...(safeLeaseEvents.length > 0
      ? safeLeaseEvents.flatMap((event) => [
        `### ${markdownValue(event.kind)} · ${markdownValue(event.leaseId)}`,
        "",
        `- Occurred: ${markdownValue(event.occurredAt)}`,
        `- Epoch: ${event.epoch}`,
        `- Summary: ${markdownValue(event.summary)}`,
        `- Event ID: ${markdownValue(event.id)}`,
        "",
      ])
      : ["No lease lifecycle events match this selection.", ""]),
  ].join("\n");
}

export function downloadAgentMeshExport(payload: string, format: AgentMeshExportFormat): boolean {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], {
    type: format === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8",
  }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-agent-mesh-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") {
    window.setTimeout(() => URL.revokeObjectURL?.(url), 0);
  }
  return true;
}
