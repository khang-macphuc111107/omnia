import { describe, expect, it } from "vitest";

import {
  addAgentJob,
  cancelAgentJob,
  claimAgentJob,
  completeAgentJob,
  createAgentScheduler,
  deserializeAgentScheduler,
  failAgentJob,
  getReadyAgentJobs,
  getAgentJob,
  getAgentSchedulerStats,
  getBlockedAgentJobs,
  releaseAgentJob,
  retryAgentJob,
  serializeAgentScheduler,
} from "./omnia-agent-scheduler";

const t1 = "2026-10-17T00:00:01.000Z";
const t2 = "2026-10-17T00:00:02.000Z";
const t3 = "2026-10-17T00:00:03.000Z";
const t4 = "2026-10-17T00:00:04.000Z";

function rootJob() {
  return addAgentJob(createAgentScheduler(2), "Root", [], ["research"], t1);
}

describe("omnia agent scheduler contract", () => {
  it("keeps dependencies explicit and exposes only dependency-ready jobs", () => {
    const root = rootJob();
    const rootId = root.jobs[0]?.id;
    expect(rootId).toBeDefined();

    const dependent = addAgentJob(root, "Dependent", [rootId!], [], t2);
    expect(getReadyAgentJobs(dependent).map((job) => job.label)).toEqual(["Root"]);

    const running = claimAgentJob(dependent, rootId!, "worker-a", t3);
    const completed = completeAgentJob(running, rootId!, t4);
    expect(getReadyAgentJobs(completed).map((job) => job.label)).toEqual(["Dependent"]);
  });

  it("rejects unknown dependencies at enqueue and rejects malformed imported graphs", () => {
    expect(() => addAgentJob(createAgentScheduler(), "orphan", ["missing"], [], t1)).toThrow(/dependencies/i);

    const malformed = {
      version: 1,
      concurrency: 1,
      jobs: [
        {
          id: "a",
          label: "A",
          dependencies: ["missing"],
          capabilities: [],
          status: "pending",
          createdAt: t1,
          updatedAt: t1,
        },
      ],
    };
    expect(() => deserializeAgentScheduler(malformed)).toThrow(/dependency/i);
  });

  it("rejects duplicate IDs and dependency cycles during import", () => {
    const base = {
      version: 1 as const,
      concurrency: 1,
      jobs: [] as unknown[],
    };
    const duplicate = {
      ...base,
      jobs: [
        { id: "same", label: "one", dependencies: [], capabilities: [], status: "pending", createdAt: t1, updatedAt: t1 },
        { id: "same", label: "two", dependencies: [], capabilities: [], status: "pending", createdAt: t2, updatedAt: t2 },
      ],
    };
    expect(() => deserializeAgentScheduler(duplicate)).toThrow(/duplicate/i);

    const cycle = {
      ...base,
      jobs: [
        { id: "a", label: "A", dependencies: ["b"], capabilities: [], status: "pending", createdAt: t1, updatedAt: t1 },
        { id: "b", label: "B", dependencies: ["a"], capabilities: [], status: "pending", createdAt: t2, updatedAt: t2 },
      ],
    };
    expect(() => deserializeAgentScheduler(cycle)).toThrow(/cycle/i);
  });

  it("accepts a valid imported graph even when jobs are not topologically ordered", () => {
    const imported = {
      version: 1 as const,
      concurrency: 1,
      jobs: [
        { id: "leaf", label: "Leaf", dependencies: ["root"], capabilities: [], status: "pending", createdAt: t2, updatedAt: t2 },
        { id: "root", label: "Root", dependencies: [], capabilities: [], status: "completed", createdAt: t1, updatedAt: t1 },
      ],
    };
    expect(() => deserializeAgentScheduler(imported)).not.toThrow();
  });

  it("enforces lifecycle transitions, worker ownership metadata, and error semantics", () => {
    const pending = rootJob();
    const id = pending.jobs[0]?.id;
    expect(id).toBeDefined();
    expect(() => completeAgentJob(pending, id!, t2)).toThrow(/running/i);
    expect(() => failAgentJob(pending, id!, "boom", t2)).toThrow(/running/i);
    expect(() => releaseAgentJob(pending, id!, t2)).toThrow(/running/i);

    const running = claimAgentJob(pending, id!, "worker-a", t2);
    expect(running.jobs[0]?.workerId).toBe("worker-a");
    const failed = failAgentJob(running, id!, "boom", t3);
    expect(failed.jobs[0]).toMatchObject({ status: "failed", error: "boom", workerId: "worker-a" });
    expect(() => completeAgentJob(failed, id!, t4)).toThrow(/running/i);

    const retried = retryAgentJob(failed, id!, t4);
    expect(retried.jobs[0]).toMatchObject({ status: "pending" });
    expect(retried.jobs[0]?.workerId).toBeUndefined();
    expect(retried.jobs[0]?.error).toBeUndefined();
  });

  it("releases active work without retaining stale worker state and supports cancellation", () => {
    const pending = rootJob();
    const id = pending.jobs[0]?.id;
    expect(id).toBeDefined();
    const running = claimAgentJob(pending, id!, "worker-a", t2);
    const released = releaseAgentJob(running, id!, t3);
    expect(released.jobs[0]).toMatchObject({ status: "pending" });
    expect(released.jobs[0]?.workerId).toBeUndefined();

    const cancelled = cancelAgentJob(released, id!, t4);
    expect(cancelled.jobs[0]?.status).toBe("cancelled");
    expect(() => cancelAgentJob(cancelled, id!, t4)).toThrow(/terminal/i);
  });

  it("rejects stale mutation timestamps and enforces concurrency", () => {
    const scheduler = createAgentScheduler(1);
    const first = addAgentJob(scheduler, "first", [], [], t2);
    const firstId = first.jobs[0]?.id;
    expect(firstId).toBeDefined();
    expect(() => claimAgentJob(first, firstId!, "worker-a", t1)).toThrow(/time/i);

    const second = addAgentJob(first, "second", [], [], t3);
    const claimed = claimAgentJob(second, firstId!, "worker-a", t4);
    const secondId = claimed.jobs.find((job) => job.label === "second")?.id;
    expect(secondId).toBeDefined();
    expect(() => claimAgentJob(claimed, secondId!, "worker-b", t4)).toThrow(/concurrency/i);
  });

  it("round-trips a valid scheduler without dropping job metadata", () => {
    const scheduler = rootJob();
    const jobId = scheduler.jobs[0]?.id;
    expect(jobId).toBeDefined();
    const running = claimAgentJob(scheduler, jobId!, "worker-a", t2);
    const restored = deserializeAgentScheduler(serializeAgentScheduler(running));
    expect(restored).toEqual(running);
  });

  it("exposes read-side queue projections and fences stale workers", () => {
    let scheduler = rootJob();
    const rootId = scheduler.jobs[0]?.id;
    expect(rootId).toBeDefined();
    const dependent = addAgentJob(scheduler, "Dependent", [rootId!], [], t2);
    const dependentId = dependent.jobs[1]?.id;
    expect(getAgentJob(dependent, dependentId!)).toMatchObject({ label: "Dependent" });
    expect(getBlockedAgentJobs(dependent).map((job) => job.id)).toEqual([dependentId]);
    expect(getAgentSchedulerStats(dependent)).toMatchObject({
      total: 2,
      pending: 2,
      ready: 1,
      blocked: 1,
      availableSlots: 2,
    });

    scheduler = claimAgentJob(dependent, rootId!, "worker-a", t3);
    expect(() => completeAgentJob(scheduler, rootId!, t4, "stale-worker")).toThrow(/fence/i);
    scheduler = completeAgentJob(scheduler, rootId!, t4, "worker-a");
    expect(getReadyAgentJobs(scheduler).map((job) => job.id)).toEqual([dependentId]);
  });
});
