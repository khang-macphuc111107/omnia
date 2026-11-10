import { describe, expect, it } from "vitest";
import { admitTieredTopology, type TieredAgentRequest, type TieredRole } from "./tiered-orchestration";

const req = (agentId: string, role: TieredRole, lanePath?: string): TieredAgentRequest => ({
  agentId, role, goalId: "goal-1", runId: "run-1",
  ...(lanePath === undefined ? {} : { lanePath }),
});

describe("tiered orchestration admission", () => {
  it("admits one supervisor, three isolated PM lanes and 41 leased workers", () => {
    const topology = admitTieredTopology({ goalId: "goal-1", runId: "run-1", now: "2026-11-10T01:00:00.000Z", supervisor: req("sup", "supervisor"), projectManagers: [req("pm-a", "project_manager", "ui"), req("pm-b", "project_manager", "runtime"), req("pm-c", "project_manager", "research")], workers: Array.from({ length: 41 }, (_, i) => req(`worker-${i}`, "worker")), workerQuota: 41 });
    expect(topology.projectManagers).toHaveLength(3);
    expect(topology.workers).toHaveLength(41);
    expect(topology.workers.every((worker) => worker.leaseId.startsWith("worker:"))).toBe(true);
    expect(topology.workers[0]?.stopConditions).toContain("lease_expired");
  });
  it("rejects overlapping PM ownership and quota overflow before dispatch", () => {
    expect(() => admitTieredTopology({ goalId: "goal-1", runId: "run-1", now: "2026-11-10T01:00:00.000Z", supervisor: req("sup", "supervisor"), projectManagers: [req("pm-a", "project_manager", "src"), req("pm-b", "project_manager", "src/rebuild")], workers: [], workerQuota: 1 })).toThrow(/overlap/i);
    expect(() => admitTieredTopology({ goalId: "goal-1", runId: "run-1", now: "2026-11-10T01:00:00.000Z", supervisor: req("sup", "supervisor"), projectManagers: [], workers: [req("w-1", "worker"), req("w-2", "worker")], workerQuota: 1 })).toThrow(/quota/i);
  });
  it("rejects duplicate identities and scope drift", () => {
    expect(() => admitTieredTopology({ goalId: "goal-1", runId: "run-1", now: "2026-11-10T01:00:00.000Z", supervisor: req("same", "supervisor"), projectManagers: [req("same", "project_manager", "a")], workers: [], workerQuota: 1 })).toThrow(/duplicate/i);
    expect(() => admitTieredTopology({ goalId: "goal-1", runId: "run-2", now: "2026-11-10T01:00:00.000Z", supervisor: req("sup", "supervisor"), projectManagers: [], workers: [], workerQuota: 1 })).toThrow(/scope/i);
  });
});
