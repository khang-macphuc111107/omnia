import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import type { AgentInstanceId, AgentResultId } from "./agent-tool-contract-shared";
import type { TaskId } from "./ids";
import {
  claimAgentTaskLease,
  completeAgentTaskLease,
  createAgentTaskCoordinationState,
  expireAgentTaskLeases,
  heartbeatAgentTaskLease,
  releaseAgentTaskLease,
  validateAgentTaskCoordinationState,
} from "./agent-task-coordination";

const taskId = "task:coordination" as TaskId;
const firstAgent = "agent:first" as AgentInstanceId;
const secondAgent = "agent:second" as AgentInstanceId;
const resultId = "result:one" as AgentResultId;
const t1 = "2026-09-16T00:00:01.000Z";
const t2 = "2026-09-16T00:00:02.000Z";
const t3 = "2026-09-16T00:00:03.000Z";
const t4 = "2026-09-16T00:00:04.000Z";
const t5 = "2026-09-16T00:00:05.000Z";
const t6 = "2026-09-16T00:00:06.000Z";
const hash = (character: string) => character.repeat(64);

function claimFirst() {
  return claimAgentTaskLease(createAgentTaskCoordinationState(), {
    expectedRevision: 0,
    taskId,
    ownerAgentId: firstAgent,
    workerIncarnationId: "worker-1",
    now: t1,
    expiresAt: t3,
  });
}

describe("durable task lease coordination", () => {
  it("fences a live owner and uses a new epoch after expiry", () => {
    const first = claimFirst();
    expect(first.lease.leaseEpoch).toBe(1);
    expect(first.state.revision).toBe(1);
    expect(() =>
      claimAgentTaskLease(first.state, {
        expectedRevision: 1,
        taskId,
        ownerAgentId: secondAgent,
        workerIncarnationId: "worker-2",
        now: t2,
        expiresAt: t4,
      }),
    ).toThrowError(DomainError);

    const expired = expireAgentTaskLeases(first.state, 1, t3);
    expect(expired.expiredLeaseEpochs).toEqual([1]);
    const second = claimAgentTaskLease(expired.state, {
      expectedRevision: expired.state.revision,
      taskId,
      ownerAgentId: secondAgent,
      workerIncarnationId: "worker-2",
      now: t4,
      expiresAt: t6,
    });
    expect(second.reclaimedExpiredCount).toBe(0);
    expect(second.lease.leaseEpoch).toBe(2);
    expect(second.state.leases.map((lease) => lease.status)).toEqual([
      "expired",
      "active",
    ]);
  });

  it("requires the exact owner, worker incarnation, epoch, and CAS revision", () => {
    const first = claimFirst();
    expect(() =>
      heartbeatAgentTaskLease(first.state, {
        expectedRevision: 0,
        taskId,
        ownerAgentId: firstAgent,
        workerIncarnationId: "worker-1",
        leaseEpoch: 1,
        now: t2,
        expiresAt: t4,
      }),
    ).toThrowError(DomainError);
    expect(() =>
      heartbeatAgentTaskLease(first.state, {
        expectedRevision: 1,
        taskId,
        ownerAgentId: firstAgent,
        workerIncarnationId: "restarted-worker",
        leaseEpoch: 1,
        now: t2,
        expiresAt: t4,
      }),
    ).toThrowError(DomainError);
    const heartbeated = heartbeatAgentTaskLease(first.state, {
      expectedRevision: 1,
      taskId,
      ownerAgentId: firstAgent,
      workerIncarnationId: "worker-1",
      leaseEpoch: 1,
      now: t2,
      expiresAt: t4,
    });
    expect(heartbeated.revision).toBe(2);
    expect(heartbeated.leases[0]?.expiresAt).toBe(t4);
  });

  it("commits evidence-backed completion once and deduplicates a lost response", () => {
    const first = claimFirst();
    const completed = completeAgentTaskLease(first.state, {
      expectedRevision: 1,
      taskId,
      ownerAgentId: firstAgent,
      workerIncarnationId: "worker-1",
      leaseEpoch: 1,
      now: t2,
      receiptId: "receipt:one",
      outcome: "completed",
      evidenceHash: hash("a"),
      resultId,
    });
    expect(completed.replayed).toBe(false);
    expect(completed.receipt.committedAtRevision).toBe(2);
    expect(completed.state.leases[0]?.status).toBe("released");

    const replay = completeAgentTaskLease(completed.state, {
      expectedRevision: 0,
      taskId,
      ownerAgentId: firstAgent,
      workerIncarnationId: "worker-1",
      leaseEpoch: 1,
      now: t2,
      receiptId: "receipt:one",
      outcome: "completed",
      evidenceHash: hash("a"),
      resultId,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.state).toBe(completed.state);
    expect(() =>
      completeAgentTaskLease(completed.state, {
        expectedRevision: 2,
        taskId,
        ownerAgentId: firstAgent,
        workerIncarnationId: "worker-1",
        leaseEpoch: 1,
        now: t2,
        receiptId: "receipt:one",
        outcome: "completed",
        evidenceHash: hash("b"),
        resultId,
      }),
    ).toThrowError(DomainError);
  });

  it("rejects completion from a reclaimed stale worker", () => {
    const first = claimFirst();
    const second = claimAgentTaskLease(first.state, {
      expectedRevision: 1,
      taskId,
      ownerAgentId: secondAgent,
      workerIncarnationId: "worker-2",
      now: t3,
      expiresAt: t5,
    });
    expect(second.lease.leaseEpoch).toBe(2);
    expect(() =>
      completeAgentTaskLease(second.state, {
        expectedRevision: second.state.revision,
        taskId,
        ownerAgentId: firstAgent,
        workerIncarnationId: "worker-1",
        leaseEpoch: 1,
        now: t4,
        receiptId: "receipt:stale",
        outcome: "completed",
        evidenceHash: hash("c"),
        resultId,
      }),
    ).toThrowError(DomainError);
  });

  it("releases without completion and validates restored state", () => {
    const first = claimFirst();
    const released = releaseAgentTaskLease(first.state, {
      expectedRevision: 1,
      taskId,
      ownerAgentId: firstAgent,
      workerIncarnationId: "worker-1",
      leaseEpoch: 1,
      now: t2,
      reason: "worker-paused",
    });
    expect(released.leases[0]).toMatchObject({
      status: "released",
      releaseReason: "worker-paused",
    });
    expect(Object.isFrozen(released)).toBe(true);
    expect(Object.isFrozen(released.leases)).toBe(true);
    expect(validateAgentTaskCoordinationState(released)).toStrictEqual(released);
  });
});
