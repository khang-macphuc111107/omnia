import { assertDomain } from "./errors";
import {
  createRagProviderRequest,
  validateRagProviderReceipt,
  type RagProviderDescriptor,
  type RagProviderReceipt,
  type RagProviderRequest,
  type RagProviderScore,
} from "./rag-provider-contract";
import { sha256Hex } from "./omnia-official-harness-adapters";
import { assertIsoTimestamp, assertNonBlank, type IsoTimestamp } from "./shared";

/**
 * A bounded, offline RAG adapter used for local-first retrieval rehearsals.
 *
 * It deliberately consumes only the frozen query/candidate hashes from the
 * provider contract. It never reads source text, paths, credentials or a
 * network endpoint. The score is a deterministic hash similarity projection,
 * useful for proving dispatch, receipt and replay behavior before a live
 * embedding/reranker connector is configured.
 */
export const LOCAL_RAG_PROVIDER_DESCRIPTOR: RagProviderDescriptor = Object.freeze({
  providerId: "omnia-local-rag",
  modelId: "omnia-rag-local-v1",
  adapterRevision: "local-rag-adapter-1",
  capabilities: Object.freeze(["embedding", "reranking"] as const),
  embeddingDimensions: 64,
  maxBatchSize: 128,
  supportsCancellation: false,
});

export interface LocalRagProviderExecutionInput {
  readonly request: RagProviderRequest;
  readonly observedAt: IsoTimestamp;
}

export interface LocalRagProviderExecutionResult {
  readonly request: RagProviderRequest;
  readonly receipt: RagProviderReceipt;
  /** Stable marker for UI/telemetry to keep local proof separate from live API evidence. */
  readonly executionBoundary: "local-deterministic";
}

function boundedHash(value: string, label: string): string {
  const normalized = assertNonBlank(value, label, 128).toLowerCase();
  assertDomain(/^[a-f0-9]{64}$/u.test(normalized), "invalid_argument", `${label} must be a SHA-256 hash.`);
  return normalized;
}

function hashSimilarityPpm(querySha256: string, candidateSha256: string): number {
  const query = boundedHash(querySha256, "RAG query hash");
  const candidate = boundedHash(candidateSha256, "RAG candidate hash");
  let matchingNibbles = 0;
  for (let index = 0; index < query.length; index += 1) {
    if (query[index] === candidate[index]) matchingNibbles += 1;
  }
  // Keep a non-zero floor so every admitted candidate remains observable in a
  // completed local receipt, while preserving a deterministic 0..1e6 scale.
  return Math.max(1, Math.round((matchingNibbles / query.length) * 1_000_000));
}

function projectScores(request: RagProviderRequest): readonly RagProviderScore[] {
  const ranked = request.candidates
    .map((candidate) => ({
      candidateId: candidate.id,
      scorePpm: hashSimilarityPpm(request.querySha256, candidate.contentSha256),
    }))
    .sort((left, right) => right.scorePpm - left.scorePpm || left.candidateId.localeCompare(right.candidateId));
  const limited = request.topK === undefined ? ranked : ranked.slice(0, request.topK);
  return Object.freeze(limited.map((score, index) => Object.freeze({ ...score, rank: index + 1 })));
}

/**
 * Executes the local adapter after the request has already crossed the
 * content-free contract. Callers should create requests with
 * `createRagProviderRequest` rather than constructing unvalidated objects.
 */
export function executeLocalRagProvider(input: LocalRagProviderExecutionInput): LocalRagProviderExecutionResult {
  assertIsoTimestamp(input.observedAt, "local RAG observation time");
  const request = input.request;
  const scores = projectScores(request);
  const responseMaterial = {
    schemaVersion: 1,
    operation: request.operation,
    requestFingerprintSha256: request.requestFingerprintSha256,
    querySha256: request.querySha256,
    scores,
  };
  const responseSha256 = sha256Hex(JSON.stringify(responseMaterial));
  const receipt: RagProviderReceipt = Object.freeze({
    schemaVersion: 1,
    requestId: request.requestId,
    state: "completed",
    providerId: LOCAL_RAG_PROVIDER_DESCRIPTOR.providerId,
    modelId: LOCAL_RAG_PROVIDER_DESCRIPTOR.modelId,
    adapterRevision: LOCAL_RAG_PROVIDER_DESCRIPTOR.adapterRevision,
    providerRequestId: `local:${request.requestFingerprintSha256.slice(0, 24)}`,
    scores,
    responseSha256,
    observedAt: input.observedAt,
  });
  validateRagProviderReceipt(receipt, request, LOCAL_RAG_PROVIDER_DESCRIPTOR);
  return Object.freeze({ request, receipt, executionBoundary: "local-deterministic" });
}

/** Creates a request already pinned to the local adapter descriptor. */
export function createLocalRagProviderRequest(
  input: Omit<Parameters<typeof createRagProviderRequest>[0], "descriptor">,
): RagProviderRequest {
  return createRagProviderRequest({ ...input, descriptor: LOCAL_RAG_PROVIDER_DESCRIPTOR });
}
