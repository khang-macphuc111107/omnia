import { describe, expect, it } from "vitest";
import {
  createRetrievalRequestReceipt,
  deserializeRetrievalRequestReceipt,
  serializeRetrievalRequestReceipt,
} from "./retrieval-request-receipt";

const hash = "a".repeat(64);
const hashB = "b".repeat(64);

function base() {
  return createRetrievalRequestReceipt({
    id: "retrieval-receipt-1",
    profileId: "profile-1" as never,
    projectId: "project-1" as never,
    runId: "run-1" as never,
    querySha256: hash,
    snapshotId: "snapshot-1" as never,
    snapshotSha256: hashB,
    retrieverVersion: "catalog-v1",
    tokenBudget: 20,
    items: [
      { id: "chunk-1", kind: "retrieval", sourceId: "source-1", sourceChunkId: "chunk-1" as never, contentHash: hash, tokenEstimate: 8, disposition: "selected", reason: "selected", rank: 1, scorePpm: 900_000, citationId: "citation-1" as never },
      { id: "memory-2", kind: "memory", sourceId: "memory-1", contentHash: hashB, tokenEstimate: 2, disposition: "omitted", reason: "budget" },
    ],
    citationIds: ["citation-1" as never],
    createdAt: "2026-11-07T10:00:00.000Z",
    completedAt: "2026-11-07T10:00:01.000Z",
  });
}

describe("retrieval request receipt", () => {
  it("freezes a bounded selected/omitted receipt and derives consumed tokens", () => {
    const receipt = base();
    expect(receipt.consumedTokens).toBe(8);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.items)).toBe(true);
    expect(receipt.items[1]?.reason).toBe("budget");
  });

  it("round trips through strict JSON persistence", () => {
    expect(deserializeRetrievalRequestReceipt(serializeRetrievalRequestReceipt(base()))).toEqual(base());
  });

  it("rejects selected token mismatch, undeclared citations and unknown fields", () => {
    const receipt = base();
    expect(() => deserializeRetrievalRequestReceipt({ ...receipt, consumedTokens: 9 })).toThrow(/consumed tokens/i);
    expect(() => deserializeRetrievalRequestReceipt({ ...receipt, citationIds: [] })).toThrow(/citation/i);
    expect(() => deserializeRetrievalRequestReceipt({ ...receipt, extra: true })).toThrow(/unknown field/i);
  });
});

