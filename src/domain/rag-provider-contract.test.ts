import { describe, expect, it } from "vitest";
import { createRagProviderRequest, validateRagProviderReceipt, type RagProviderDescriptor } from "./rag-provider-contract";

const hash = "a".repeat(64);
const descriptor: RagProviderDescriptor = {
  providerId: "provider_local",
  modelId: "embed-rerank-1",
  adapterRevision: "adapter-7",
  capabilities: ["embedding", "reranking"],
  embeddingDimensions: 768,
  maxBatchSize: 4,
  supportsCancellation: true,
};
const base = {
  requestId: "rag_request_1",
  operation: "rerank" as const,
  descriptor,
  profileId: "profile_1" as never,
  projectId: "project_1" as never,
  runId: "run_1" as never,
  contextSnapshotId: "snapshot_1" as never,
  contextSnapshotSha256: hash,
  querySha256: hash,
  candidates: [{ id: "chunk_1", sourceChunkId: "chunk_1" as never, contentSha256: hash, tokenEstimate: 10 }],
  topK: 1,
  tokenBudget: 20,
  idempotencyKey: "idem_1",
  createdAt: "2026-11-08T00:00:00Z",
};

describe("RAG provider contract", () => {
  it("creates a content-free request fingerprint from frozen candidate metadata", () => {
    const request = createRagProviderRequest(base);
    expect(request.requestFingerprintSha256).toHaveLength(64);
    expect(JSON.stringify(request)).not.toContain("source text");
    expect(request.candidates[0]?.contentSha256).toBe(hash);
  });

  it("rejects an operation the provider did not advertise", () => {
    expect(() => createRagProviderRequest({ ...base, operation: "rerank", descriptor: { ...descriptor, capabilities: ["embedding"] } })).toThrow(/does not advertise/);
  });

  it("rejects duplicate candidates and over-budget batches", () => {
    expect(() => createRagProviderRequest({ ...base, candidates: [base.candidates[0]!, base.candidates[0]!] })).toThrow(/unique/);
    expect(() => createRagProviderRequest({ ...base, tokenBudget: 5 })).toThrow(/token budget/);
  });

  it("accepts a completed score receipt only for the exact provider lineage", () => {
    const request = createRagProviderRequest(base);
    const receipt = {
      schemaVersion: 1 as const,
      requestId: request.requestId,
      state: "completed" as const,
      providerId: descriptor.providerId,
      modelId: descriptor.modelId,
      adapterRevision: descriptor.adapterRevision,
      providerRequestId: "remote_1",
      scores: [{ candidateId: "chunk_1", rank: 1, scorePpm: 812_000 }],
      responseSha256: hash,
      observedAt: "2026-11-08T00:00:01Z",
    };
    expect(() => validateRagProviderReceipt(receipt, request, descriptor)).not.toThrow();
    expect(() => validateRagProviderReceipt({ ...receipt, modelId: "other" }, request, descriptor)).toThrow(/lineage/);
  });

  it("requires an error code for failed receipts and scores for completed receipts", () => {
    const request = createRagProviderRequest(base);
    const failed = {
      schemaVersion: 1 as const,
      requestId: request.requestId,
      state: "failed" as const,
      providerId: descriptor.providerId,
      modelId: descriptor.modelId,
      adapterRevision: descriptor.adapterRevision,
      scores: [],
      observedAt: "2026-11-08T00:00:01Z",
    };
    expect(() => validateRagProviderReceipt(failed, request, descriptor)).toThrow(/error code/);
    expect(() => validateRagProviderReceipt({ ...failed, state: "completed", scores: [] }, request, descriptor)).toThrow(/scores/);
  });
  it("allows a query embedding request without document candidates", () => {
    const { topK: _topK, ...withoutTopK } = base;
    void _topK;
    const request = createRagProviderRequest({ ...withoutTopK, operation: "embed-query", candidates: [] });
    expect(request.candidates).toHaveLength(0);
  });
});
