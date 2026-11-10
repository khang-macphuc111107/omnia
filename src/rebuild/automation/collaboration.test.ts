import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { CollaborationRun } from "./collaboration";

describe("multi-model collaboration lineage", () => {
  it("keeps selected attempts and a separate synthesis with input/output hashes", async () => {
    const run = new CollaborationRun("task-1");
    const first = await run.recordAttempt({ id: "a1", model: "model-a", prompt: "Solve", status: "succeeded", output: "Answer A" }, 0);
    const second = await run.recordAttempt({ id: "a2", model: "model-b", prompt: "Solve", status: "succeeded", output: "Answer B" }, 1);
    const synthesis = await run.synthesize({ id: "s1", selectedAttemptIds: [first.id, second.id], output: "Combined answer", rationale: "Both agree" }, 2);
    expect(new Set(run.snapshot().attempts.map((attempt) => attempt.model))).toEqual(new Set(["model-a", "model-b"]));
    expect(synthesis).toMatchObject({ id: "s1", selectedAttemptIds: ["a1", "a2"], output: "Combined answer" });
    expect(synthesis.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(synthesis.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(synthesis.outputHash).toBe(createHash("sha256").update("Combined answer").digest("hex"));
    expect(synthesis.selectedAttempts).toEqual([
      { attemptId: first.id, model: first.model, inputHash: first.inputHash, outputHash: first.outputHash },
      { attemptId: second.id, model: second.model, inputHash: second.inputHash, outputHash: second.outputHash },
    ]);
    expect((await CollaborationRun.restore(run.serialize())).snapshot()).toEqual(run.snapshot());
  });

  it("retains failed attempts, rejects selecting failures, and supports cancel", async () => {
    const run = new CollaborationRun("task-1");
    const failed = await run.recordAttempt({ id: "failed", model: "model-a", prompt: "Solve", status: "failed", output: "", error: "rate limited" }, 0);
    expect(failed).toMatchObject({ status: "failed", error: "rate limited" });
    await expect(run.synthesize({ id: "bad", selectedAttemptIds: [failed.id], output: "No", rationale: "No" }, 1)).rejects.toThrow(/succeeded/);
    run.cancel("user stopped", 1);
    expect(() => run.cancel("again", 2)).toThrow(/terminal/);
  });

  it("rejects duplicate/conflicting IDs, stale revisions, and preserves reload lineage", async () => {
    const run = new CollaborationRun("task-1");
    const result = await run.recordAttempt({ id: "a1", model: "model-a", prompt: "Solve", status: "succeeded", output: "A" }, 0);
    await expect(run.recordAttempt({ id: "a1", model: "model-a", prompt: "Different", status: "succeeded", output: "B" }, 1)).rejects.toThrow(/duplicate/);
    await expect(run.recordAttempt({ id: "stale", model: "model-b", prompt: "Solve", status: "succeeded", output: "B" }, 0)).rejects.toThrow(/stale/);
    const restored = await CollaborationRun.restore(run.serialize());
    expect(restored.snapshot()).toEqual(run.snapshot());
    expect(restored.snapshot().attempts[0]?.inputHash).toBe(result.inputHash);
  });

  it("detects an async revision race before committing either stale result", async () => {
    const run = new CollaborationRun("task-1");
    const first = run.recordAttempt({ id: "a1", model: "a", prompt: "p", status: "succeeded", output: "A" }, 0);
    const second = run.recordAttempt({ id: "a2", model: "b", prompt: "p", status: "succeeded", output: "B" }, 0);
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({ reason: expect.objectContaining({ code: "stale_revision" }) });
  });

  it("allows a partial failure followed by a successful model and verifies hashes on reload", async () => {
    const run = new CollaborationRun("task-1");
    await run.recordAttempt({ id: "failed", model: "a", prompt: "Solve", status: "failed", output: "", error: "Unavailable" }, 0);
    await run.recordAttempt({ id: "a2", model: "b", prompt: "Solve", status: "succeeded", output: "Good answer" }, 1);
    const synthesis = await run.synthesize({ id: "s1", selectedAttemptIds: ["a2"], output: "Good answer with conclusion", rationale: "Only successful attempt" }, 2);
    expect(synthesis.selectedAttemptIds).toEqual(["a2"]);
    const corrupt = JSON.parse(run.serialize()); corrupt.state.attempts[1].output = "Tampered";
    await expect(CollaborationRun.restore(JSON.stringify(corrupt))).rejects.toThrow(/replay|snapshot|hash/);
  });

  it("cancels in-flight hashes and rejects an explicitly different task identity", async () => {
    const run = new CollaborationRun("task-1");
    const pending = run.recordAttempt({ id: "a1", model: "a", prompt: "Solve", status: "succeeded", output: "Answer" }, 0);
    run.cancel("User cancelled", 0);
    await expect(pending).rejects.toThrow(/terminal|stale/);
    expect(run.snapshot().attempts).toHaveLength(0);
    const sameTask = new CollaborationRun("task-1");
    await sameTask.recordAttempt({ id: "a1", model: "a", prompt: "Solve", status: "succeeded", output: "Answer" }, 0);
    await expect(sameTask.recordAttempt({ id: "a2", taskId: "other-task", model: "b", prompt: "Unrelated task", status: "succeeded", output: "Answer" }, 1)).rejects.toThrow(/task/);
  });

  it("rejects reused synthesis IDs and mutation through returned records", async () => {
    const run = new CollaborationRun("task-1");
    const attempt = await run.recordAttempt({ id: "a1", model: "a", prompt: "Solve", status: "succeeded", output: "Answer" }, 0);
    attempt.output = "Mutated";
    expect(run.snapshot().attempts[0]?.output).toBe("Answer");
    await expect(run.synthesize({ id: "a1", selectedAttemptIds: ["a1"], output: "Merged", rationale: "Reason" }, 1)).rejects.toThrow(/duplicate/);
    await expect(run.synthesize({ id: "s", selectedAttemptIds: ["a1", "a1"], output: "Merged", rationale: "Reason" }, 1)).rejects.toThrow(/duplicate/);
    await expect(run.synthesize({ id: "s", selectedAttemptIds: ["missing"], output: "Merged", rationale: "Reason" }, 1)).rejects.toThrow(/unknown_attempt/);
  });
});
