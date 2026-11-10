import { describe, expect, it } from "vitest";
import {
  attachModelCompareMergeReceipt,
  createModelCompareMergeReceipt,
  createModelCompareRun,
  deserializeModelCompareRun,
  modelCompareIsTerminal,
  recordModelCompareAttempt,
  serializeModelCompareRun,
  type ModelCompareRun,
} from "./model-compare";

const digest = "a".repeat(64);
const outputHash = "b".repeat(64);

function run() {
  return createModelCompareRun({
    id: "compare-1",
    logicalInput: { id: "input-1", digest, messages: [{ role: "user", content: "hello" }] },
    candidates: [
      { id: "candidate-a", providerId: "provider-a", modelId: "model-a" },
      { id: "candidate-b", providerId: "provider-b", modelId: "model-b" },
    ],
    createdAt: "2026-11-07T10:00:00.000Z",
  });
}

describe("model compare fan-out and merge receipts", () => {
  it("keeps attempts independent and preserves per-attempt usage/provenance", () => {
    const initial = run();
    const first = recordModelCompareAttempt(initial, initial.attempts[0]!.id, {
      status: "completed",
      output: "answer a",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, costMicros: 2 },
      provenance: { providerRequestId: "req-a", adapterId: "adapter-a" },
      completedAt: "2026-11-07T10:00:01.000Z",
    });
    const final = recordModelCompareAttempt(first, first.attempts[1]!.id, {
      status: "failed",
      error: "provider unavailable",
      completedAt: "2026-11-07T10:00:02.000Z",
    });
    expect(modelCompareIsTerminal(final)).toBe(true);
    expect(final.status).toBe("partial");
    expect(final.attempts[0]?.usage?.outputTokens).toBe(4);
    expect(final.attempts[1]?.provenance).toBeUndefined();
  });

  it("requires terminal fan-out and completed selected attempts before merge", () => {
    const initial = run();
    expect(() => createModelCompareMergeReceipt({ run: initial, selectedAttemptIds: [initial.attempts[0]!.id], strategy: "best-of", rationale: "best quality", finalOutputSha256: outputHash, createdAt: "2026-11-07T10:00:03.000Z" })).toThrow(/terminal/i);
    const completedA = recordModelCompareAttempt(initial, initial.attempts[0]!.id, { status: "completed", completedAt: "2026-11-07T10:00:01.000Z" });
    const completed = recordModelCompareAttempt(completedA, completedA.attempts[1]!.id, { status: "completed", completedAt: "2026-11-07T10:00:02.000Z" });
    const receipt = createModelCompareMergeReceipt({ run: completed, selectedAttemptIds: [completed.attempts[0]!.id], strategy: "best-of", rationale: "best quality", finalOutputSha256: outputHash, createdAt: "2026-11-07T10:00:03.000Z" });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(attachModelCompareMergeReceipt(completed, receipt).mergeReceipt?.selectedAttemptIds).toEqual([completed.attempts[0]!.id]);
  });

  it("rejects unknown selected attempts and non-hash final outputs", () => {
    const initial = run();
    const a = recordModelCompareAttempt(initial, initial.attempts[0]!.id, { status: "completed", completedAt: "2026-11-07T10:00:01.000Z" });
    const completed = recordModelCompareAttempt(a, a.attempts[1]!.id, { status: "completed", completedAt: "2026-11-07T10:00:02.000Z" });
    expect(() => createModelCompareMergeReceipt({ run: completed, selectedAttemptIds: ["missing"], strategy: "manual", rationale: "manual", finalOutputSha256: outputHash, createdAt: "2026-11-07T10:00:03.000Z" })).toThrow(/outside/i);
    expect(() => createModelCompareMergeReceipt({ run: completed, selectedAttemptIds: [completed.attempts[0]!.id], strategy: "manual", rationale: "manual", finalOutputSha256: "bad", createdAt: "2026-11-07T10:00:03.000Z" })).toThrow(/hash/i);
  });

  it("owns a deep immutable copy of the frozen logical input", () => {
    const message = { role: "user", content: [{ text: "original" }] };
    const initial = createModelCompareRun({
      id: " compare-1 ", logicalInput: { id: "input-1", digest: digest.toUpperCase(), messages: [message] },
      candidates: run().candidates, createdAt: "2026-11-07T10:00:00.000Z",
    });
    message.content[0]!.text = "changed externally";
    expect(initial.logicalInput.messages).toEqual([{ role: "user", content: [{ text: "original" }] }]);
    expect(Object.isFrozen((initial.logicalInput.messages[0] as typeof message).content[0])).toBe(true);
    expect(initial.attempts[0]!.id).toBe("compare-1:candidate-a");
    expect(initial.logicalInput.digest).toBe(digest);
  });

  it("rejects lossy JSON input, malformed hashes, invalid dates and overlong identifiers", () => {
    const make = (messages: readonly unknown[]) => createModelCompareRun({ id: "compare", logicalInput: { id: "input", digest, messages }, candidates: run().candidates });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const messages of [[undefined], [Number.NaN], [new Date()], [cyclic]]) expect(() => make(messages)).toThrow();
    expect(() => createModelCompareRun({ id: "x".repeat(513), logicalInput: run().logicalInput, candidates: run().candidates })).toThrow(/limit/i);
    expect(() => createModelCompareRun({ id: "compare", logicalInput: { ...run().logicalInput, digest: "not-a-hash" }, candidates: run().candidates })).toThrow(/digest/i);
    expect(() => createModelCompareRun({ id: "compare", logicalInput: run().logicalInput, candidates: run().candidates, createdAt: "yesterday" })).toThrow(/timestamp/i);
  });

  it("preserves planned state and rejects invalid attempt transitions or execution facts", () => {
    const initial = run();
    expect(recordModelCompareAttempt(initial, initial.attempts[0]!.id, { status: "planned" }).status).toBe("planned");
    expect(() => recordModelCompareAttempt(initial, initial.attempts[0]!.id, { status: "planned", output: "invented" })).toThrow(/execution facts/i);
    const running = recordModelCompareAttempt(initial, initial.attempts[0]!.id, { status: "running", startedAt: "2026-11-07T10:00:01.000Z" });
    expect(() => recordModelCompareAttempt(running, running.attempts[0]!.id, { status: "planned" })).toThrow(/return to planned/i);
    expect(() => recordModelCompareAttempt(running, running.attempts[0]!.id, { status: "completed", completedAt: "2026-11-07T10:00:00.500Z" })).toThrow(/precede/i);
    const completed = recordModelCompareAttempt(running, running.attempts[0]!.id, { status: "completed", completedAt: "2026-11-07T10:00:02.000Z" });
    expect(() => recordModelCompareAttempt(completed, completed.attempts[0]!.id, { status: "running" })).toThrow(/terminal compare attempt is immutable/i);
  });

  it("keeps per-attempt usage bounded and rejects extra metadata or contradictory outcomes", () => {
    const initial = run();
    const attempt = initial.attempts[0]!.id;
    expect(() => recordModelCompareAttempt(initial, attempt, { status: "running", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 11 } })).toThrow(/smaller/i);
    expect(() => recordModelCompareAttempt(initial, attempt, { status: "running", usage: { inputTokens: 1, rawResponse: "secret" } as never })).toThrow(/unknown field/i);
    expect(() => recordModelCompareAttempt(initial, attempt, { status: "running", provenance: { adapterId: "a", apiKey: "secret" } as never })).toThrow(/unknown field/i);
    expect(() => recordModelCompareAttempt(initial, attempt, { status: "completed", error: "failed" })).toThrow(/cannot carry an error/i);
  });

  it("derives completion from the latest terminal attempt when callbacks arrive out of order", () => {
    const initial = run();
    const later = recordModelCompareAttempt(initial, initial.attempts[0]!.id, { status: "completed", completedAt: "2026-11-07T10:00:05.000Z" });
    const completed = recordModelCompareAttempt(later, later.attempts[1]!.id, { status: "completed", completedAt: "2026-11-07T10:00:02.000Z" });
    expect(completed.completedAt).toBe("2026-11-07T10:00:05.000Z");
    expect(() => createModelCompareMergeReceipt({ run: completed, selectedAttemptIds: [completed.attempts[0]!.id], strategy: "manual", rationale: "selected", finalOutputSha256: outputHash, createdAt: "2026-11-07T10:00:03.000Z" })).toThrow(/precede fan-out/i);
  });

  it("revalidates caller-supplied merge receipts and refuses replacement or post-merge edits", () => {
    const initial = run();
    const first = recordModelCompareAttempt(initial, initial.attempts[0]!.id, { status: "completed", completedAt: "2026-11-07T10:00:01.000Z" });
    const completed = recordModelCompareAttempt(first, first.attempts[1]!.id, { status: "failed", completedAt: "2026-11-07T10:00:02.000Z" });
    const receipt = createModelCompareMergeReceipt({ run: completed, selectedAttemptIds: [completed.attempts[0]!.id], strategy: "manual", rationale: "selected", finalOutputSha256: outputHash, createdAt: "2026-11-07T10:00:03.000Z" });
    expect(() => attachModelCompareMergeReceipt(completed, { ...receipt, selectedAttemptIds: [completed.attempts[1]!.id] })).toThrow(/Only completed/i);
    expect(() => attachModelCompareMergeReceipt(initial, { ...receipt, attemptIds: initial.attempts.map((attempt) => attempt.id) })).toThrow(/terminal/i);
    expect(() => attachModelCompareMergeReceipt(completed, { ...receipt, selectedAttemptIds: [completed.attempts[0]!.id, completed.attempts[0]!.id] })).toThrow(/unique/i);
    const merged = attachModelCompareMergeReceipt(completed, { ...receipt, selectedAttemptIds: [...receipt.selectedAttemptIds] });
    expect(Object.isFrozen(merged.mergeReceipt!.selectedAttemptIds)).toBe(true);
    expect(attachModelCompareMergeReceipt(merged, receipt)).toBe(merged);
    expect(() => attachModelCompareMergeReceipt(merged, { ...receipt, rationale: "rewritten" })).toThrow(/already owns/i);
    expect(() => recordModelCompareAttempt(merged, merged.attempts[0]!.id, { status: "completed" })).toThrow(/merged compare run is immutable/i);
  });

  it("round-trips snapshots through strict lineage validation", () => {
    const initial = run();
    const first = recordModelCompareAttempt(initial, initial.attempts[0]!.id, { status: "completed", completedAt: "2026-11-07T10:00:01.000Z" });
    const completed = recordModelCompareAttempt(first, first.attempts[1]!.id, { status: "completed", completedAt: "2026-11-07T10:00:02.000Z" });
    const receipt = createModelCompareMergeReceipt({ run: completed, selectedAttemptIds: [completed.attempts[0]!.id], strategy: "best-of", rationale: "selected", finalOutputSha256: outputHash, createdAt: "2026-11-07T10:00:03.000Z" });
    const merged = attachModelCompareMergeReceipt(completed, receipt);
    expect(deserializeModelCompareRun(serializeModelCompareRun(merged))).toEqual(merged);
    const tampered = JSON.parse(serializeModelCompareRun(merged)) as ModelCompareRun;
    expect(() => deserializeModelCompareRun(JSON.stringify({ ...tampered, status: "planned" }))).toThrow(/status does not match/i);
    expect(() => deserializeModelCompareRun(JSON.stringify({ ...tampered, attempts: tampered.attempts.map((attempt, index) => index === 0 ? { ...attempt, candidate: tampered.candidates[1] } : attempt) }))).toThrow(/lineage/i);
    expect(() => deserializeModelCompareRun(JSON.stringify({ ...tampered, unknown: true }))).toThrow(/unknown field/i);
  });
});

