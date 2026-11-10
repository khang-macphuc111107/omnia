import { assertDomain } from "./errors";
import { assertNonBlank } from "./shared";

export type TieredRole = "supervisor" | "project_manager" | "worker";
export type WorkerStopCondition = "goal_complete" | "goal_cancelled" | "lease_expired" | "resource_backpressure";

export interface TieredAgentRequest {
  readonly agentId: string;
  readonly role: TieredRole;
  readonly goalId: string;
  readonly runId: string;
  readonly lanePath?: string;
  readonly leaseSeconds?: number;
}

export interface TieredLeaseRecord {
  readonly agentId: string;
  readonly role: TieredRole;
  readonly goalId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly stopConditions: readonly WorkerStopCondition[];
}

export interface TieredTopology {
  readonly goalId: string;
  readonly runId: string;
  readonly supervisor: TieredLeaseRecord;
  readonly projectManagers: readonly TieredLeaseRecord[];
  readonly workers: readonly TieredLeaseRecord[];
  readonly requestedWorkers: number;
  readonly admittedWorkers: number;
  readonly workerQuota: number;
}

const MAX_PROJECT_MANAGERS = 3;
const DEFAULT_LEASE_SECONDS = 300;
const MAX_LEASE_SECONDS = 86_400;

function clean(value: string, label: string): string {
  return assertNonBlank(value, label, 256);
}

function parsePath(value: string): string {
  const normalized = clean(value, "lane path").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  assertDomain(normalized.length > 0, "invalid_argument", "Lane path cannot be empty.");
  return normalized;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function makeLease(request: TieredAgentRequest, now: Date, role: TieredRole): TieredLeaseRecord {
  const seconds = request.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  assertDomain(Number.isInteger(seconds) && seconds > 0 && seconds <= MAX_LEASE_SECONDS, "invalid_argument", "Lease duration is outside the bounded range.", { seconds });
  const acquiredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + seconds * 1000).toISOString();
  return Object.freeze({
    agentId: clean(request.agentId, "agent ID"),
    role,
    goalId: clean(request.goalId, "goal ID"),
    runId: clean(request.runId, "run ID"),
    leaseId: `${role}:${request.goalId}:${request.runId}:${request.agentId}`,
    acquiredAt,
    expiresAt,
    stopConditions: Object.freeze(["goal_complete", "goal_cancelled", "lease_expired", "resource_backpressure"] as const),
  });
}

/**
 * Admits a complete three-tier topology before any dispatch occurs. It is a
 * deterministic renderer/domain contract; native persistence must commit the
 * returned records atomically with its goal/run version.
 */
export function admitTieredTopology(input: {
  readonly goalId: string;
  readonly runId: string;
  readonly now: string;
  readonly supervisor: TieredAgentRequest;
  readonly projectManagers: readonly TieredAgentRequest[];
  readonly workers: readonly TieredAgentRequest[];
  readonly workerQuota: number;
}): TieredTopology {
  const goalId = clean(input.goalId, "goal ID");
  const runId = clean(input.runId, "run ID");
  const now = new Date(input.now);
  assertDomain(!Number.isNaN(now.getTime()), "invalid_argument", "Topology timestamp must be ISO-parseable.");
  assertDomain(input.supervisor.role === "supervisor", "invalid_argument", "Exactly one supervisor is required.");
  assertDomain(input.supervisor.goalId === goalId && input.supervisor.runId === runId, "scope_violation", "Supervisor scope does not match goal/run.");
  assertDomain(input.projectManagers.length <= MAX_PROJECT_MANAGERS, "invalid_argument", "At most three project-manager lanes are allowed.", { count: input.projectManagers.length });
  assertDomain(Number.isInteger(input.workerQuota) && input.workerQuota > 0, "invalid_argument", "Worker quota must be a positive integer.");
  assertDomain(input.workers.length <= input.workerQuota, "invalid_argument", "Worker request exceeds the admitted quota.", { requested: input.workers.length, quota: input.workerQuota });
  const ids = new Set<string>();
  const checkCommon = (request: TieredAgentRequest, expected: TieredRole) => {
    assertDomain(request.role === expected, "invalid_argument", `Expected ${expected} role.`);
    assertDomain(request.goalId === goalId && request.runId === runId, "scope_violation", "Agent scope does not match goal/run.");
    const id = clean(request.agentId, "agent ID");
    assertDomain(!ids.has(id), "conflict", "Duplicate agent identity in topology.", { agentId: id });
    ids.add(id);
  };
  checkCommon(input.supervisor, "supervisor");
  input.projectManagers.forEach((request) => checkCommon(request, "project_manager"));
  input.workers.forEach((request) => checkCommon(request, "worker"));
  const lanes = input.projectManagers.map((request) => parsePath(request.lanePath ?? ""));
  for (const [index, left] of lanes.entries()) for (const right of lanes.slice(index + 1)) {
    assertDomain(!overlaps(left, right), "conflict", "Project-manager lanes overlap.", { left, right });
  }
  const supervisor = makeLease(input.supervisor, now, "supervisor");
  const projectManagers = input.projectManagers.map((request) => makeLease(request, now, "project_manager"));
  const workers = input.workers.map((request) => makeLease(request, now, "worker"));
  return Object.freeze({ goalId, runId, supervisor, projectManagers: Object.freeze(projectManagers), workers: Object.freeze(workers), requestedWorkers: input.workers.length, admittedWorkers: workers.length, workerQuota: input.workerQuota });
}
