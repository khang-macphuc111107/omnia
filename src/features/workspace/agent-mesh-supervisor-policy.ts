export type SupervisorChildAuthority = "subset-only" | "same-as-parent" | "review-each-expansion";
export type SupervisorWriteConflict = "serialize" | "isolated-worktree" | "hold-for-review" | "deny-overlap";
export type SupervisorOutputRoute = "fixed-parent" | "task-inbox" | "explicit-destination";
export type SupervisorStaleSnapshot = "block-and-refresh" | "read-only-review" | "manual-acknowledgement";
export type SupervisorLeaseRecovery = "native-receipt-required" | "hold-expired" | "manual-recovery-preview";

export interface AgentMeshSupervisorPolicyDraft {
  readonly childAuthority: SupervisorChildAuthority;
  readonly writeConflict: SupervisorWriteConflict;
  readonly outputRoute: SupervisorOutputRoute;
  readonly staleSnapshot: SupervisorStaleSnapshot;
  readonly leaseRecovery: SupervisorLeaseRecovery;
  readonly maxParallelTasks: number;
}

export const AGENT_MESH_SUPERVISOR_POLICY_SCHEMA = "omnia.agent-mesh-supervisor-policy.preview.v1" as const;
export const AGENT_MESH_SUPERVISOR_POLICY_BOUNDARY =
  "Renderer-local supervisor policy rehearsal only; it does not grant authority, start a scheduler, acquire or recover leases, route agent output, or persist policy." as const;

export const DEFAULT_AGENT_MESH_SUPERVISOR_POLICY: AgentMeshSupervisorPolicyDraft = {
  childAuthority: "subset-only",
  writeConflict: "serialize",
  outputRoute: "fixed-parent",
  staleSnapshot: "block-and-refresh",
  leaseRecovery: "native-receipt-required",
  maxParallelTasks: 4,
};

export const AGENT_MESH_SUPERVISOR_POLICY_OPTIONS = {
  childAuthority: ["subset-only", "same-as-parent", "review-each-expansion"],
  writeConflict: ["serialize", "isolated-worktree", "hold-for-review", "deny-overlap"],
  outputRoute: ["fixed-parent", "task-inbox", "explicit-destination"],
  staleSnapshot: ["block-and-refresh", "read-only-review", "manual-acknowledgement"],
  leaseRecovery: ["native-receipt-required", "hold-expired", "manual-recovery-preview"],
} as const;

export const AGENT_MESH_SUPERVISOR_POLICY_FIELDS = [
  ["childAuthority", "Child authority", "How child work is bounded by its parent task."],
  ["writeConflict", "Overlapping write claims", "How concurrent claims for the same resource are handled."],
  ["outputRoute", "Output destination", "How a child result is routed without following UI selection."],
  ["staleSnapshot", "Stale input snapshot", "What happens when a task's source revision changes."],
  ["leaseRecovery", "Lease recovery", "Recovery posture for an interrupted or expired worker lease."],
] as const;

export type AgentMeshSupervisorPolicyKey = typeof AGENT_MESH_SUPERVISOR_POLICY_FIELDS[number][0];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function normalizeAgentMeshSupervisorPolicy(value: Partial<AgentMeshSupervisorPolicyDraft> | undefined): AgentMeshSupervisorPolicyDraft {
  const source = value ?? {};
  const allowed = <T extends string>(candidate: unknown, values: readonly T[], fallback: T): T =>
    typeof candidate === "string" && values.includes(candidate as T) ? candidate as T : fallback;
  const parallel = typeof source.maxParallelTasks === "number" && Number.isFinite(source.maxParallelTasks)
    ? Math.min(16, Math.max(1, Math.round(source.maxParallelTasks)))
    : DEFAULT_AGENT_MESH_SUPERVISOR_POLICY.maxParallelTasks;
  return {
    childAuthority: allowed(source.childAuthority, AGENT_MESH_SUPERVISOR_POLICY_OPTIONS.childAuthority, DEFAULT_AGENT_MESH_SUPERVISOR_POLICY.childAuthority),
    writeConflict: allowed(source.writeConflict, AGENT_MESH_SUPERVISOR_POLICY_OPTIONS.writeConflict, DEFAULT_AGENT_MESH_SUPERVISOR_POLICY.writeConflict),
    outputRoute: allowed(source.outputRoute, AGENT_MESH_SUPERVISOR_POLICY_OPTIONS.outputRoute, DEFAULT_AGENT_MESH_SUPERVISOR_POLICY.outputRoute),
    staleSnapshot: allowed(source.staleSnapshot, AGENT_MESH_SUPERVISOR_POLICY_OPTIONS.staleSnapshot, DEFAULT_AGENT_MESH_SUPERVISOR_POLICY.staleSnapshot),
    leaseRecovery: allowed(source.leaseRecovery, AGENT_MESH_SUPERVISOR_POLICY_OPTIONS.leaseRecovery, DEFAULT_AGENT_MESH_SUPERVISOR_POLICY.leaseRecovery),
    maxParallelTasks: parallel,
  };
}

export function agentMeshSupervisorPolicyEqual(left: AgentMeshSupervisorPolicyDraft, right: AgentMeshSupervisorPolicyDraft): boolean {
  return (Object.keys(DEFAULT_AGENT_MESH_SUPERVISOR_POLICY) as (keyof AgentMeshSupervisorPolicyDraft)[])
    .every((key) => left[key] === right[key]);
}

export function agentMeshSupervisorPolicyDiff(policy: AgentMeshSupervisorPolicyDraft): readonly { key: keyof AgentMeshSupervisorPolicyDraft; before: string; after: string }[] {
  return (Object.keys(DEFAULT_AGENT_MESH_SUPERVISOR_POLICY) as (keyof AgentMeshSupervisorPolicyDraft)[])
    .flatMap((key) => String(DEFAULT_AGENT_MESH_SUPERVISOR_POLICY[key]) === String(policy[key])
      ? []
      : [{ key, before: String(DEFAULT_AGENT_MESH_SUPERVISOR_POLICY[key]), after: String(policy[key]) }]);
}

export function serializeAgentMeshSupervisorPolicy(policy: AgentMeshSupervisorPolicyDraft): string {
  return JSON.stringify({
    schema: AGENT_MESH_SUPERVISOR_POLICY_SCHEMA,
    version: 1,
    policy: normalizeAgentMeshSupervisorPolicy(policy),
    boundary: AGENT_MESH_SUPERVISOR_POLICY_BOUNDARY,
  }, null, 2);
}

export function serializeAgentMeshSupervisorPolicyMarkdown(policy: AgentMeshSupervisorPolicyDraft): string {
  const normalized = normalizeAgentMeshSupervisorPolicy(policy);
  return [
    "# Omnia Agent Mesh supervisor policy preview",
    "",
    `- Schema: ${AGENT_MESH_SUPERVISOR_POLICY_SCHEMA}`,
    `- Boundary: ${AGENT_MESH_SUPERVISOR_POLICY_BOUNDARY}`,
    "",
    "| Control | Preview value |",
    "| --- | --- |",
    `| Child authority | ${normalized.childAuthority} |`,
    `| Overlapping write claims | ${normalized.writeConflict} |`,
    `| Output destination | ${normalized.outputRoute} |`,
    `| Stale input snapshot | ${normalized.staleSnapshot} |`,
    `| Lease recovery | ${normalized.leaseRecovery} |`,
    `| Maximum parallel tasks | ${normalized.maxParallelTasks} |`,
    "",
    "> Renderer-local rehearsal only. This is not a scheduler configuration, authority grant, lease receipt, or durable policy.",
  ].join("\n");
}

export function parseAgentMeshSupervisorPolicy(raw: string): AgentMeshSupervisorPolicyDraft | null {
  if (raw.length > 32 * 1024) return null;
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!isRecord(parsed) || parsed.schema !== AGENT_MESH_SUPERVISOR_POLICY_SCHEMA || parsed.version !== 1 || !isRecord(parsed.policy)) return null;
    return normalizeAgentMeshSupervisorPolicy(parsed.policy as Partial<AgentMeshSupervisorPolicyDraft>);
  } catch {
    return null;
  }
}
