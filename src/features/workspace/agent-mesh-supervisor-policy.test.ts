import { describe, expect, it } from "vitest";

import {
  AGENT_MESH_SUPERVISOR_POLICY_SCHEMA,
  DEFAULT_AGENT_MESH_SUPERVISOR_POLICY,
  agentMeshSupervisorPolicyDiff,
  agentMeshSupervisorPolicyEqual,
  normalizeAgentMeshSupervisorPolicy,
  parseAgentMeshSupervisorPolicy,
  serializeAgentMeshSupervisorPolicy,
  serializeAgentMeshSupervisorPolicyMarkdown,
} from "./agent-mesh-supervisor-policy";

describe("Agent Mesh supervisor policy preview contract", () => {
  it("normalizes unknown values and clamps the parallel task bound", () => {
    const normalized = normalizeAgentMeshSupervisorPolicy({
      childAuthority: "unknown" as never,
      maxParallelTasks: 99,
    });

    expect(normalized.childAuthority).toBe(DEFAULT_AGENT_MESH_SUPERVISOR_POLICY.childAuthority);
    expect(normalized.maxParallelTasks).toBe(16);
    expect(agentMeshSupervisorPolicyEqual(normalized, DEFAULT_AGENT_MESH_SUPERVISOR_POLICY)).toBe(false);
  });

  it("round-trips a bounded preview payload and reports only changed fields", () => {
    const draft = normalizeAgentMeshSupervisorPolicy({
      writeConflict: "hold-for-review",
      outputRoute: "task-inbox",
      maxParallelTasks: 2,
    });
    const parsed = parseAgentMeshSupervisorPolicy(serializeAgentMeshSupervisorPolicy(draft));

    expect(parsed).toEqual(draft);
    expect(agentMeshSupervisorPolicyDiff(draft).map((entry) => entry.key)).toEqual([
      "writeConflict",
      "outputRoute",
      "maxParallelTasks",
    ]);
    expect(serializeAgentMeshSupervisorPolicyMarkdown(draft)).toContain("| Maximum parallel tasks | 2 |");
  });

  it("fails closed for a wrong schema, version, or oversized payload", () => {
    expect(parseAgentMeshSupervisorPolicy(JSON.stringify({ schema: "other", version: 1, policy: {} }))).toBeNull();
    expect(parseAgentMeshSupervisorPolicy(JSON.stringify({ schema: AGENT_MESH_SUPERVISOR_POLICY_SCHEMA, version: 2, policy: {} }))).toBeNull();
    expect(parseAgentMeshSupervisorPolicy("x".repeat(32 * 1024 + 1))).toBeNull();
  });
});
