import { assertDomain } from "./errors";
import type { ProfileId, ProjectId, RetrievalSnapshotId, RunId, SourceChunkId } from "./ids";
import { assertIsoTimestamp, assertNonBlank, assertSha256, type IsoTimestamp } from "./shared";
import { sha256Hex } from "./omnia-official-harness-adapters";

/** Versioned, renderer-safe boundary for provider-backed semantic retrieval. */
export const RAG_PROVIDER_CONTRACT_VERSION = 1 as const;

export type RagProviderOperation = "embed-query" | "embed-documents" | "rerank";
export type RagProviderCapability = "embedding" | "reranking";
export type RagProviderRequestState = "prepared" | "accepted" | "completed" | "failed" | "unknown";

export interface RagProviderDescriptor {
  readonly providerId: string;
  readonly modelId: string;
  readonly adapterRevision: string;
  readonly capabilities: readonly RagProviderCapability[];
  readonly embeddingDimensions?: number;
  readonly maxBatchSize: number;
  readonly supportsCancellation: boolean;
}

/** Candidate identity only; source text is resolved inside the native boundary. */
export interface RagProviderCandidate {
  readonly id: string;
  readonly sourceChunkId?: SourceChunkId;
  readonly contentSha256: string;
  readonly tokenEstimate: number;
}

export interface RagProviderRequest {
  readonly schemaVersion: typeof RAG_PROVIDER_CONTRACT_VERSION;
  readonly requestId: string;
  readonly operation: RagProviderOperation;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly runId?: RunId;
  readonly contextSnapshotId: RetrievalSnapshotId;
  readonly contextSnapshotSha256: string;
  readonly querySha256: string;
  readonly candidates: readonly RagProviderCandidate[];
  readonly topK?: number;
  readonly tokenBudget: number;
  readonly idempotencyKey: string;
  readonly createdAt: IsoTimestamp;
  /** Fingerprint covers only canonical metadata and hashes, never source text. */
  readonly requestFingerprintSha256: string;
}

export interface RagProviderScore {
  readonly candidateId: string;
  readonly scorePpm: number;
  readonly rank: number;
}

export interface RagProviderReceipt {
  readonly schemaVersion: typeof RAG_PROVIDER_CONTRACT_VERSION;
  readonly requestId: string;
  readonly state: RagProviderRequestState;
  readonly providerId: string;
  readonly modelId: string;
  readonly adapterRevision: string;
  readonly providerRequestId?: string;
  readonly scores: readonly RagProviderScore[];
  readonly responseSha256?: string;
  readonly errorCode?: string;
  readonly observedAt: IsoTimestamp;
}

const OPERATIONS: readonly RagProviderOperation[] = ["embed-query", "embed-documents", "rerank"];
const CAPABILITIES: readonly RagProviderCapability[] = ["embedding", "reranking"];

function isCapabilityForOperation(operation: RagProviderOperation, capability: RagProviderCapability): boolean {
  return operation === "rerank" ? capability === "reranking" : capability === "embedding";
}

function positiveInteger(value: number, label: string): number {
  assertDomain(Number.isSafeInteger(value) && value > 0, "invalid_argument", `${label} must be a positive safe integer.`);
  return value;
}

function validateDescriptor(descriptor: RagProviderDescriptor): RagProviderDescriptor {
  const providerId = assertNonBlank(descriptor.providerId, "RAG provider ID", 256);
  const modelId = assertNonBlank(descriptor.modelId, "RAG provider model ID", 256);
  const adapterRevision = assertNonBlank(descriptor.adapterRevision, "RAG provider adapter revision", 128);
  const capabilities = [...new Set(descriptor.capabilities)];
  assertDomain(capabilities.length > 0, "unsupported_capability", "RAG provider must advertise at least one capability.");
  assertDomain(capabilities.every((value) => CAPABILITIES.includes(value)), "invalid_argument", "RAG provider capability is unknown.");
  const maxBatchSize = positiveInteger(descriptor.maxBatchSize, "RAG provider batch size");
  if (descriptor.embeddingDimensions !== undefined) positiveInteger(descriptor.embeddingDimensions, "RAG embedding dimensions");
  return Object.freeze({
    providerId,
    modelId,
    adapterRevision,
    capabilities: Object.freeze(capabilities),
    ...(descriptor.embeddingDimensions === undefined ? {} : { embeddingDimensions: descriptor.embeddingDimensions }),
    maxBatchSize,
    supportsCancellation: descriptor.supportsCancellation === true,
  });
}

function validateCandidate(candidate: RagProviderCandidate): RagProviderCandidate {
  const id = assertNonBlank(candidate.id, "RAG candidate ID", 256);
  if (candidate.sourceChunkId !== undefined) assertNonBlank(candidate.sourceChunkId, "RAG source chunk ID", 256);
  const contentSha256 = assertSha256(candidate.contentSha256, "RAG candidate content hash");
  const tokenEstimate = positiveInteger(candidate.tokenEstimate, "RAG candidate token estimate");
  return Object.freeze({
    id,
    ...(candidate.sourceChunkId === undefined ? {} : { sourceChunkId: candidate.sourceChunkId }),
    contentSha256,
    tokenEstimate,
  });
}

function canonicalFingerprint(input: {
  operation: RagProviderOperation;
  descriptor: RagProviderDescriptor;
  contextSnapshotId: string;
  contextSnapshotSha256: string;
  querySha256: string;
  candidates: readonly RagProviderCandidate[];
  topK?: number;
  tokenBudget: number;
}): string {
  return sha256Hex(JSON.stringify({
    schemaVersion: RAG_PROVIDER_CONTRACT_VERSION,
    operation: input.operation,
    providerId: input.descriptor.providerId,
    modelId: input.descriptor.modelId,
    adapterRevision: input.descriptor.adapterRevision,
    contextSnapshotId: input.contextSnapshotId,
    contextSnapshotSha256: input.contextSnapshotSha256,
    querySha256: input.querySha256,
    candidates: input.candidates.map(({ id, sourceChunkId, contentSha256, tokenEstimate }) => ({ id, sourceChunkId, contentSha256, tokenEstimate })),
    ...(input.topK === undefined ? {} : { topK: input.topK }),
    tokenBudget: input.tokenBudget,
  }));
}

export function createRagProviderRequest(input: {
  readonly requestId: string;
  readonly operation: RagProviderOperation;
  readonly descriptor: RagProviderDescriptor;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly runId?: RunId;
  readonly contextSnapshotId: RetrievalSnapshotId;
  readonly contextSnapshotSha256: string;
  readonly querySha256: string;
  readonly candidates: readonly RagProviderCandidate[];
  readonly topK?: number;
  readonly tokenBudget: number;
  readonly idempotencyKey: string;
  readonly createdAt: IsoTimestamp;
}): RagProviderRequest {
  const descriptor = validateDescriptor(input.descriptor);
  assertDomain(OPERATIONS.includes(input.operation), "invalid_argument", "RAG provider operation is unknown.");
  assertDomain(descriptor.capabilities.some((capability) => isCapabilityForOperation(input.operation, capability)), "unsupported_capability", "RAG provider does not advertise the requested RAG operation.");
  const requestId = assertNonBlank(input.requestId, "RAG request ID", 256);
  const profileId = assertNonBlank(input.profileId, "RAG profile ID", 256) as ProfileId;
  if (input.projectId !== undefined) assertNonBlank(input.projectId, "RAG project ID", 256);
  if (input.runId !== undefined) assertNonBlank(input.runId, "RAG run ID", 256);
  const contextSnapshotId = assertNonBlank(input.contextSnapshotId, "RAG context snapshot ID", 256) as RetrievalSnapshotId;
  const contextSnapshotSha256 = assertSha256(input.contextSnapshotSha256, "RAG context snapshot hash");
  const querySha256 = assertSha256(input.querySha256, "RAG query hash");
  assertIsoTimestamp(input.createdAt, "RAG request creation time");
  const tokenBudget = positiveInteger(input.tokenBudget, "RAG token budget");
  const idempotencyKey = assertNonBlank(input.idempotencyKey, "RAG idempotency key", 512);
  const candidates = input.candidates.map(validateCandidate);
  assertDomain(input.operation === "embed-query" || candidates.length > 0, "invalid_argument", "This RAG provider operation requires at least one candidate.");
  assertDomain(candidates.length <= descriptor.maxBatchSize, "context_overflow", "RAG candidate batch exceeds the provider limit.");
  assertDomain(new Set(candidates.map((candidate) => candidate.id)).size === candidates.length, "conflict", "RAG candidate IDs must be unique.");
  const totalTokens = candidates.reduce((sum, candidate) => sum + candidate.tokenEstimate, 0);
  assertDomain(totalTokens <= tokenBudget, "context_overflow", "RAG candidates exceed the request token budget.");
  if (input.topK !== undefined) {
    const topK = positiveInteger(input.topK, "RAG topK");
    assertDomain(topK <= candidates.length, "invalid_argument", "RAG topK cannot exceed the candidate count.");
  }
  const requestFingerprintSha256 = canonicalFingerprint({
    operation: input.operation,
    descriptor,
    contextSnapshotId,
    contextSnapshotSha256,
    querySha256,
    candidates,
    ...(input.topK === undefined ? {} : { topK: input.topK }),
    tokenBudget,
  });
  return Object.freeze({
    schemaVersion: RAG_PROVIDER_CONTRACT_VERSION,
    requestId,
    operation: input.operation,
    profileId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    contextSnapshotId,
    contextSnapshotSha256,
    querySha256,
    candidates: Object.freeze(candidates),
    ...(input.topK === undefined ? {} : { topK: input.topK }),
    tokenBudget,
    idempotencyKey,
    createdAt: input.createdAt,
    requestFingerprintSha256,
  });
}

export function validateRagProviderReceipt(receipt: RagProviderReceipt, request: RagProviderRequest, descriptor: RagProviderDescriptor): void {
  const normalizedDescriptor = validateDescriptor(descriptor);
  assertDomain(receipt.schemaVersion === RAG_PROVIDER_CONTRACT_VERSION, "invalid_argument", "Unsupported RAG provider receipt version.");
  assertDomain(receipt.requestId === request.requestId, "conflict", "RAG receipt belongs to another request.");
  assertNonBlank(receipt.providerId, "RAG receipt provider ID", 256);
  assertNonBlank(receipt.modelId, "RAG receipt model ID", 256);
  assertNonBlank(receipt.adapterRevision, "RAG receipt adapter revision", 128);
  assertDomain(receipt.providerId === normalizedDescriptor.providerId && receipt.modelId === normalizedDescriptor.modelId && receipt.adapterRevision === normalizedDescriptor.adapterRevision, "conflict", "RAG receipt provider lineage does not match the request descriptor.");
  assertDomain(["prepared", "accepted", "completed", "failed", "unknown"].includes(receipt.state), "invalid_argument", "RAG receipt state is unknown.");
  assertIsoTimestamp(receipt.observedAt, "RAG receipt observation time");
  if (receipt.providerRequestId !== undefined) assertNonBlank(receipt.providerRequestId, "RAG provider request ID", 512);
  if (receipt.responseSha256 !== undefined) assertSha256(receipt.responseSha256, "RAG response hash");
  if (receipt.errorCode !== undefined) assertNonBlank(receipt.errorCode, "RAG provider error code", 128);
  const candidates = new Set(request.candidates.map((candidate) => candidate.id));
  const seen = new Set<string>();
  for (const score of receipt.scores) {
    assertDomain(candidates.has(score.candidateId), "conflict", "RAG score references an unknown candidate.");
    assertDomain(!seen.has(score.candidateId), "conflict", "RAG scores contain a duplicate candidate.");
    seen.add(score.candidateId);
    assertDomain(Number.isSafeInteger(score.rank) && score.rank > 0, "invalid_argument", "RAG score rank must be positive.");
    assertDomain(Number.isSafeInteger(score.scorePpm) && score.scorePpm >= 0 && score.scorePpm <= 1_000_000, "invalid_argument", "RAG score must be between zero and one million.");
  }
  if (receipt.state === "completed") {
    // Query-only embedding is valid with no document candidates; the response
    // hash is the completion evidence in that case. Ranking/document
    // operations must still return at least one candidate score.
    const queryOnlyEmbedding = request.operation === "embed-query" && request.candidates.length === 0;
    assertDomain(queryOnlyEmbedding || receipt.scores.length > 0, "invalid_argument", "Completed RAG receipts require scores unless this is a query-only embedding.");
    if (queryOnlyEmbedding) assertDomain(receipt.responseSha256 !== undefined, "invalid_argument", "Query-only embedding receipts require a response hash.");
  }
  if (receipt.state === "failed") assertDomain(receipt.errorCode !== undefined, "invalid_argument", "Failed RAG receipts require an error code.");
}
