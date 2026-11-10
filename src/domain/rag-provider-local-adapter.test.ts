import { describe, expect, it } from "vitest";
import {
  createLocalRagProviderRequest,
  executeLocalRagProvider,
  LOCAL_RAG_PROVIDER_DESCRIPTOR,
} from "./rag-provider-local-adapter";
import { validateRagProviderReceipt } from "./rag-provider-contract";

const queryHash = "a".repeat(64);
const strongCandidate = "a".repeat(64);
const weakCandidate = "b".repeat(64);

function request(operation: "rerank" | "embed-query" = "rerank", candidates = [
  { id: "chunk-strong", sourceChunkId: "chunk-strong" as never, contentSha256: strongCandidate, tokenEstimate: 8 },
  { id: "chunk-weak", sourceChunkId: "chunk-weak" as never, contentSha256: weakCandidate, tokenEstimate: 8 },
]) {
  return createLocalRagProviderRequest({
    requestId: `local-rag-${operation}`,
    operation,
    profileId: "profile-local" as never,
    projectId: "project-local" as never,
    runId: "run-local" as never,
    contextSnapshotId: "snapshot-local" as never,
    contextSnapshotSha256: queryHash,
    querySha256: queryHash,
    candidates,
    ...(operation === "rerank" ? { topK: 2 } : {}),
    tokenBudget: 32,
    idempotencyKey: `idem-${operation}`,
    createdAt: "2026-11-08T00:00:00Z",
  });
}

describe("local RAG provider adapter", () => {
  it("executes a content-free deterministic rerank with lineage-bound receipt", () => {
    const result = executeLocalRagProvider({ request: request(), observedAt: "2026-11-08T00:00:01Z" });
    expect(result.executionBoundary).toBe("local-deterministic");
    expect(result.receipt.providerId).toBe(LOCAL_RAG_PROVIDER_DESCRIPTOR.providerId);
    expect(result.receipt.scores.map((score) => score.candidateId)).toEqual(["chunk-strong", "chunk-weak"]);
    expect(result.receipt.responseSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => validateRagProviderReceipt(result.receipt, result.request, LOCAL_RAG_PROVIDER_DESCRIPTOR)).not.toThrow();
  });

  it("is replay-stable for the same frozen request", () => {
    const first = executeLocalRagProvider({ request: request(), observedAt: "2026-11-08T00:00:01Z" });
    const second = executeLocalRagProvider({ request: request(), observedAt: "2026-11-08T00:00:01Z" });
    expect(second.receipt.responseSha256).toBe(first.receipt.responseSha256);
    expect(second.receipt.providerRequestId).toBe(first.receipt.providerRequestId);
  });

  it("allows a completed query-only embedding with response-hash evidence", () => {
    const result = executeLocalRagProvider({ request: request("embed-query", []), observedAt: "2026-11-08T00:00:01Z" });
    expect(result.receipt.scores).toEqual([]);
    expect(result.receipt.responseSha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
