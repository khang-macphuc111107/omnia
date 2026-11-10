import { describe, expect, it } from "vitest";

import { serializeAgentMeshExport } from "./agent-mesh-export";
import type { AgentMeshAgent, AgentMeshLease, AgentMeshLeaseEvent, AgentMeshMessage } from "./agent-mesh-preview";

const agents: readonly AgentMeshAgent[] = [
  {
    id: "agent:root",
    label: "Root",
    role: "orchestrator",
    state: "running",
    depth: 0,
    objective: "Coordinate work",
    contextMode: "team",
    outputRoute: "parent",
    authority: "Renderer only",
    budgetUsed: 1,
    budgetLimit: 2,
    mailboxUnread: 0,
  },
  {
    id: "agent:blocked",
    label: "Blocked child",
    role: "verifier",
    state: "blocked",
    depth: 1,
    parentId: "agent:root",
    objective: "Wait for evidence",
    contextMode: "fresh",
    outputRoute: "inbox",
    authority: "No native access",
    budgetUsed: 1,
    budgetLimit: 1,
    mailboxUnread: 1,
  },
];

const messages: readonly AgentMeshMessage[] = [
  {
    id: "mail:1",
    senderId: "agent:blocked",
    recipientId: "agent:root",
    kind: "question",
    summary: "Should the lease be reclaimed?",
    createdAt: "09:00",
    acknowledged: false,
    sensitivity: "sensitive",
  },
];

const leases: readonly AgentMeshLease[] = [
  { id: "lease:1", taskId: "task:verify", ownerId: "agent:blocked", status: "expired", epoch: 2, heartbeat: "08:50", expires: "08:55" },
];

const leaseEvents: readonly AgentMeshLeaseEvent[] = [
  { id: "event:1", leaseId: "lease:1", kind: "acquired", occurredAt: "08:40", epoch: 1, summary: "Fixture acquired" },
  { id: "event:2", leaseId: "lease:1", kind: "expired", occurredAt: "08:55", epoch: 2, summary: "Fixture expired" },
];

describe("agent mesh export", () => {
  it("serializes a bounded JSON envelope with explicit renderer scope", () => {
    const payload = serializeAgentMeshExport({ agents, messages, leases, format: "json", scope: "attention", generatedAt: "2026-09-21T00:00:00.000Z" });
    const parsed = JSON.parse(payload) as Record<string, unknown>;

    expect(parsed.format).toBe("omnia.agent-mesh.preview.v1");
    expect(parsed.scope).toBe("renderer-session");
    expect(parsed.selection).toBe("attention");
    expect(parsed.generatedAt).toBe("2026-09-21T00:00:00.000Z");
    expect(payload).toContain("Renderer-local preview only");
    expect(payload).toContain("Blocked child");
    expect(payload).not.toContain('"label": "Root"');
  });

  it("keeps Markdown export readable for selected records", () => {
    const payload = serializeAgentMeshExport({ agents, messages, leases, leaseEvents, format: "markdown", scope: "selected", selectedAgentId: "agent:blocked", generatedAt: "2026-09-21T00:00:00.000Z" });

    expect(payload).toContain("# Omnia agent mesh preview");
    expect(payload).toContain("- Selection: selected");
    expect(payload).toContain("## Mailbox");
    expect(payload).toContain("## Leases");
    expect(payload).toContain("Blocked child");
    expect(payload).toContain("task:verify");
    expect(payload).toContain("## Lease lifecycle timeline");
    expect(payload).toContain("Fixture expired");
    expect(payload).not.toContain("### Root");
  });

  it("keeps JSON lease timeline events scoped to exported leases", () => {
    const payload = serializeAgentMeshExport({
      agents,
      messages,
      leases,
      leaseEvents: [...leaseEvents, { id: "event:other", leaseId: "lease:missing", kind: "heartbeat", occurredAt: "08:00", epoch: 1, summary: "Should be omitted" }],
      format: "json",
      scope: "attention",
      generatedAt: "2026-09-21T00:00:00.000Z",
    });
    const parsed = JSON.parse(payload) as { leaseEvents?: Array<{ leaseId: string; summary: string }> };

    expect(parsed.leaseEvents).toHaveLength(2);
    expect(parsed.leaseEvents?.every((event) => event.leaseId === "lease:1")).toBe(true);
    expect(payload).not.toContain("Should be omitted");
  });
});
