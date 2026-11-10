import { assertDomain } from "./errors";
import type {
  CitationId,
  ConversationId,
  ProfileId,
  ProjectId,
  RetrievalSnapshotId,
  RunId,
  SourceChunkId,
} from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";
import type { RetrievalMemoryPlan } from "./omnia-retrieval-memory-adapter";

/**
 * Renderer/native boundary receipt for one retrieval decision.  It contains
 * hashes and bounded metadata only; raw prompts, memory text and chunk text
 * never belong in this record.
 */
export const RETRIEVAL_REQUEST_RECEIPT_VERSION = 1 as const;

export type RetrievalReceiptItemKind = "memory" | "retrieval";
export type RetrievalReceiptDisposition = "selected" | "omitted";
export type RetrievalReceiptOmissionReason =
  | "budget"
  | "duplicate"
  | "scope"
  | "disabled"
  | "stale"
  | "low-score"
  | "source-cap"
  | "excluded"
  | "unmatched";

export interface RetrievalRequestReceiptItem {
  readonly id: string;
  readonly kind: RetrievalReceiptItemKind;
  readonly sourceId: string;
  readonly sourceChunkId?: SourceChunkId;
  readonly contentHash: string;
  readonly tokenEstimate: number;
  readonly disposition: RetrievalReceiptDisposition;
  readonly reason: "selected" | RetrievalReceiptOmissionReason;
  readonly rank?: number;
  readonly scorePpm?: number;
  readonly citationId?: CitationId;
}

export interface RetrievalRequestReceipt {
  readonly schemaVersion: typeof RETRIEVAL_REQUEST_RECEIPT_VERSION;
  readonly id: string;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly conversationId?: ConversationId;
  readonly runId?: RunId;
  readonly querySha256: string;
  readonly snapshotId?: RetrievalSnapshotId;
  readonly snapshotSha256?: string;
  readonly retrieverVersion: string;
  readonly tokenBudget: number;
  readonly consumedTokens: number;
  readonly items: readonly RetrievalRequestReceiptItem[];
  readonly citationIds: readonly CitationId[];
  readonly createdAt: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly receiptSha256?: string;
}

export interface CreateRetrievalRequestReceiptInput {
  readonly id: string;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly conversationId?: ConversationId;
  readonly runId?: RunId;
  readonly querySha256: string;
  readonly snapshotId?: RetrievalSnapshotId;
  readonly snapshotSha256?: string;
  readonly retrieverVersion: string;
  readonly tokenBudget: number;
  readonly items: readonly RetrievalRequestReceiptItem[];
  readonly citationIds?: readonly CitationId[];
  readonly createdAt: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly receiptSha256?: string;
}

/** Builds the durable receipt directly from the deterministic memory/RAG plan. */
export function createRetrievalRequestReceiptFromPlan(input: {
  readonly id: string;
  readonly plan: RetrievalMemoryPlan;
  readonly querySha256: string;
  readonly retrieverVersion: string;
  readonly createdAt: IsoTimestamp;
  readonly conversationId?: ConversationId;
  readonly runId?: RunId;
  readonly snapshotId?: RetrievalSnapshotId;
  readonly snapshotSha256?: string;
  readonly citationIdsByCandidateId?: Readonly<Record<string, CitationId>>;
  readonly receiptSha256?: string;
}): RetrievalRequestReceipt {
  const items = input.plan.items.map((entry) => {
    const candidate = entry.candidate;
    const retrieval = candidate.retrievalCandidate;
    const citationId = entry.disposition === "selected" ? input.citationIdsByCandidateId?.[candidate.id] : undefined;
    return {
      id: candidate.id,
      kind: candidate.kind,
      sourceId: candidate.sourceId,
      ...(retrieval === undefined ? {} : { sourceChunkId: retrieval.chunk.id }),
      contentHash: candidate.contentHash,
      tokenEstimate: candidate.tokenEstimate,
      disposition: entry.disposition,
      reason: entry.reason,
      ...(entry.selectionOrder === undefined ? {} : { rank: entry.selectionOrder + 1, scorePpm: Math.round(candidate.score * 1_000_000) }),
      ...(citationId === undefined ? {} : { citationId }),
    } satisfies RetrievalRequestReceiptItem;
  });
  // A caller may keep a candidate->citation lookup for the complete planner
  // result, including omitted candidates.  Omitted candidates are not part of
  // the provider context and their citations must not make it into the
  // receipt: validation requires every declared citation to point at one
  // selected item.  Derive this list from the already ordered receipt items so
  // the durable citation order is deterministic and cannot depend on object
  // insertion order in the lookup map.
  const citationIds = items
    .filter((item) => item.disposition === "selected" && item.citationId !== undefined)
    .map((item) => item.citationId as CitationId);
  return createRetrievalRequestReceipt({
    id: input.id,
    profileId: input.plan.profileId,
    ...(input.plan.projectId === undefined ? {} : { projectId: input.plan.projectId }),
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    querySha256: input.querySha256,
    ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
    ...(input.snapshotSha256 === undefined ? {} : { snapshotSha256: input.snapshotSha256 }),
    retrieverVersion: input.retrieverVersion,
    tokenBudget: input.plan.tokenBudget,
    items,
    citationIds,
    createdAt: input.createdAt,
    ...(input.receiptSha256 === undefined ? {} : { receiptSha256: input.receiptSha256 }),
  });
}

const ITEM_KEYS = [
  "id", "kind", "sourceId", "sourceChunkId", "contentHash", "tokenEstimate",
  "disposition", "reason", "rank", "scorePpm", "citationId",
] as const;
const RECEIPT_KEYS = [
  "schemaVersion", "id", "profileId", "projectId", "conversationId", "runId",
  "querySha256", "snapshotId", "snapshotSha256", "retrieverVersion", "tokenBudget",
  "consumedTokens", "items", "citationIds", "createdAt", "completedAt", "receiptSha256",
] as const;
const OMISSION_REASONS: readonly RetrievalReceiptOmissionReason[] = [
  "budget", "duplicate", "scope", "disabled", "stale", "low-score", "source-cap", "excluded", "unmatched",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    assertDomain(keys.has(key), "invalid_argument", `${label} contains an unknown field.`, { key });
  }
}

function nonBlank(value: string, label: string, max = 512): string {
  return assertNonBlank(value, label, max);
}

function nonNegativeInteger(value: number, label: string): number {
  assertDomain(Number.isSafeInteger(value) && value >= 0, "invalid_argument", `${label} must be a non-negative safe integer.`);
  return value;
}

function validateItem(input: RetrievalRequestReceiptItem): RetrievalRequestReceiptItem {
  const id = nonBlank(input.id, "retrieval receipt item ID");
  const sourceId = nonBlank(input.sourceId, "retrieval receipt source ID");
  assertDomain(input.kind === "memory" || input.kind === "retrieval", "invalid_argument", "Retrieval receipt item kind is invalid.");
  assertSha256(input.contentHash, "retrieval receipt content hash");
  const tokenEstimate = nonNegativeInteger(input.tokenEstimate, "retrieval receipt token estimate");
  assertDomain(input.disposition === "selected" || input.disposition === "omitted", "invalid_argument", "Retrieval receipt disposition is invalid.");
  if (input.disposition === "selected") {
    assertDomain(input.reason === "selected", "invalid_argument", "Selected retrieval items must use the selected reason.");
    assertDomain(input.rank !== undefined && Number.isSafeInteger(input.rank) && input.rank >= 1, "invalid_argument", "Selected retrieval items require a positive rank.");
  } else {
    assertDomain(input.reason !== "selected" && OMISSION_REASONS.includes(input.reason), "invalid_argument", "Omitted retrieval items require a valid omission reason.");
    assertDomain(input.rank === undefined, "invalid_argument", "Omitted retrieval items cannot carry a rank.");
    assertDomain(input.citationId === undefined, "invalid_argument", "Omitted retrieval items cannot carry a citation.");
  }
  if (input.sourceChunkId !== undefined) nonBlank(input.sourceChunkId, "retrieval receipt source chunk ID");
  if (input.scorePpm !== undefined) assertDomain(Number.isSafeInteger(input.scorePpm) && input.scorePpm >= 0 && input.scorePpm <= 1_000_000, "invalid_argument", "Retrieval receipt score must be between zero and one million.");
  if (input.citationId !== undefined) nonBlank(input.citationId, "retrieval receipt citation ID");
  return Object.freeze({
    id,
    kind: input.kind,
    sourceId,
    ...(input.sourceChunkId === undefined ? {} : { sourceChunkId: input.sourceChunkId }),
    contentHash: input.contentHash.trim().toLowerCase(),
    tokenEstimate,
    disposition: input.disposition,
    reason: input.reason,
    ...(input.rank === undefined ? {} : { rank: input.rank }),
    ...(input.scorePpm === undefined ? {} : { scorePpm: input.scorePpm }),
    ...(input.citationId === undefined ? {} : { citationId: input.citationId }),
  });
}

function validateReceipt(receipt: RetrievalRequestReceipt): RetrievalRequestReceipt {
  assertDomain(receipt.schemaVersion === RETRIEVAL_REQUEST_RECEIPT_VERSION, "invalid_argument", "Unsupported retrieval request receipt version.");
  nonBlank(receipt.id, "retrieval request receipt ID");
  nonBlank(receipt.profileId, "retrieval request receipt profile ID");
  if (receipt.projectId !== undefined) nonBlank(receipt.projectId, "retrieval request receipt project ID");
  if (receipt.conversationId !== undefined) nonBlank(receipt.conversationId, "retrieval request receipt conversation ID");
  if (receipt.runId !== undefined) nonBlank(receipt.runId, "retrieval request receipt run ID");
  assertSha256(receipt.querySha256, "retrieval request query hash");
  if (receipt.snapshotId === undefined) assertDomain(receipt.snapshotSha256 === undefined, "invalid_argument", "A retrieval snapshot hash requires a snapshot ID.");
  if (receipt.snapshotId !== undefined) nonBlank(receipt.snapshotId, "retrieval snapshot ID");
  if (receipt.snapshotSha256 !== undefined) assertSha256(receipt.snapshotSha256, "retrieval snapshot hash");
  nonBlank(receipt.retrieverVersion, "retriever version", 128);
  const tokenBudget = nonNegativeInteger(receipt.tokenBudget, "retrieval receipt token budget");
  assertDomain(tokenBudget > 0, "invalid_argument", "Retrieval receipt token budget must be positive.");
  const consumedTokens = nonNegativeInteger(receipt.consumedTokens, "retrieval receipt consumed tokens");
  assertDomain(consumedTokens <= tokenBudget, "invalid_argument", "Retrieval receipt consumed tokens exceed the budget.");
  assertIsoTimestamp(receipt.createdAt, "retrieval receipt creation time");
  if (receipt.completedAt !== undefined) {
    assertIsoTimestamp(receipt.completedAt, "retrieval receipt completion time");
    assertDomain(Date.parse(receipt.completedAt) >= Date.parse(receipt.createdAt), "invalid_argument", "Retrieval receipt completion cannot precede creation.");
  }
  if (receipt.receiptSha256 !== undefined) assertSha256(receipt.receiptSha256, "retrieval receipt hash");
  const items = receipt.items.map(validateItem);
  const ids = new Set<string>();
  const citationIds = receipt.citationIds.map((id) => nonBlank(id, "retrieval receipt citation ID") as CitationId);
  assertDomain(new Set(citationIds).size === citationIds.length, "conflict", "Retrieval receipt citation IDs must be unique.");
  let selectedTokens = 0;
  let selectedCount = 0;
  const itemCitations = new Set<string>();
  for (const item of items) {
    assertDomain(!ids.has(item.id), "conflict", "Retrieval receipt item IDs must be unique.");
    ids.add(item.id);
    if (item.disposition === "selected") {
      selectedCount += 1;
      selectedTokens += item.tokenEstimate;
      if (item.citationId !== undefined) {
        assertDomain(!itemCitations.has(item.citationId), "conflict", "A citation may only be attached to one selected retrieval item.");
        itemCitations.add(item.citationId);
        assertDomain(citationIds.includes(item.citationId), "not_found", "Selected retrieval item references an undeclared citation.");
      }
    }
  }
  assertDomain(selectedTokens === consumedTokens, "invalid_argument", "Retrieval receipt consumed tokens must equal selected item tokens.", { selectedTokens, consumedTokens });
  assertDomain(itemCitations.size === citationIds.length, "invalid_argument", "Every declared citation must reference a selected retrieval item.");
  void selectedCount;
  return Object.freeze({ ...receipt, id: receipt.id.trim(), profileId: receipt.profileId.trim() as ProfileId, retrieverVersion: receipt.retrieverVersion.trim(), querySha256: receipt.querySha256.trim().toLowerCase(), tokenBudget, consumedTokens, items: Object.freeze(items), citationIds: Object.freeze(citationIds) });
}

export function createRetrievalRequestReceipt(input: CreateRetrievalRequestReceiptInput): RetrievalRequestReceipt {
  const receipt: RetrievalRequestReceipt = {
    schemaVersion: RETRIEVAL_REQUEST_RECEIPT_VERSION,
    id: nonBlank(input.id, "retrieval request receipt ID"),
    profileId: input.profileId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    querySha256: input.querySha256,
    ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
    ...(input.snapshotSha256 === undefined ? {} : { snapshotSha256: input.snapshotSha256 }),
    retrieverVersion: input.retrieverVersion,
    tokenBudget: input.tokenBudget,
    consumedTokens: input.items.filter((item) => item.disposition === "selected").reduce((sum, item) => sum + item.tokenEstimate, 0),
    items: input.items,
    citationIds: input.citationIds ?? [],
    createdAt: input.createdAt,
    ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
    ...(input.receiptSha256 === undefined ? {} : { receiptSha256: input.receiptSha256 }),
  };
  return validateReceipt(receipt);
}

export function validateRetrievalRequestReceipt(receipt: RetrievalRequestReceipt): void {
  validateReceipt(receipt);
}

export function serializeRetrievalRequestReceipt(receipt: RetrievalRequestReceipt): string {
  validateReceipt(receipt);
  return JSON.stringify(receipt, null, 2);
}

function parseItem(value: unknown): RetrievalRequestReceiptItem {
  assertDomain(isRecord(value), "invalid_argument", "Retrieval receipt item must be an object.");
  assertKnownKeys(value, ITEM_KEYS, "Retrieval receipt item");
  assertDomain(isString(value.id) && isString(value.kind) && isString(value.sourceId) && isString(value.contentHash) && typeof value.tokenEstimate === "number" && isString(value.disposition) && isString(value.reason), "invalid_argument", "Retrieval receipt item is malformed.");
  return validateItem({
    id: value.id,
    kind: value.kind as RetrievalReceiptItemKind,
    sourceId: value.sourceId,
    ...(value.sourceChunkId === undefined ? {} : { sourceChunkId: value.sourceChunkId as SourceChunkId }),
    contentHash: value.contentHash,
    tokenEstimate: value.tokenEstimate,
    disposition: value.disposition as RetrievalReceiptDisposition,
    reason: value.reason as RetrievalRequestReceiptItem["reason"],
    ...(value.rank === undefined ? {} : { rank: value.rank as number }),
    ...(value.scorePpm === undefined ? {} : { scorePpm: value.scorePpm as number }),
    ...(value.citationId === undefined ? {} : { citationId: value.citationId as CitationId }),
  });
}

/** Strict persistence/IPC parser. Unknown fields are rejected at every item boundary. */
export function deserializeRetrievalRequestReceipt(input: string | unknown): RetrievalRequestReceipt {
  let value: unknown;
  try { value = typeof input === "string" ? JSON.parse(input) as unknown : input; } catch { assertDomain(false, "invalid_argument", "Retrieval request receipt JSON is malformed."); }
  assertDomain(isRecord(value), "invalid_argument", "Retrieval request receipt must be an object.");
  assertKnownKeys(value, RECEIPT_KEYS, "Retrieval request receipt");
  assertDomain(value.schemaVersion === RETRIEVAL_REQUEST_RECEIPT_VERSION && isString(value.id) && isString(value.profileId) && isString(value.querySha256) && isString(value.retrieverVersion) && typeof value.tokenBudget === "number" && typeof value.consumedTokens === "number" && Array.isArray(value.items) && Array.isArray(value.citationIds) && isString(value.createdAt), "invalid_argument", "Retrieval request receipt is malformed.");
  const receipt: RetrievalRequestReceipt = {
    schemaVersion: RETRIEVAL_REQUEST_RECEIPT_VERSION,
    id: value.id,
    profileId: value.profileId as ProfileId,
    ...(value.projectId === undefined ? {} : { projectId: value.projectId as ProjectId }),
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId as ConversationId }),
    ...(value.runId === undefined ? {} : { runId: value.runId as RunId }),
    querySha256: value.querySha256,
    ...(value.snapshotId === undefined ? {} : { snapshotId: value.snapshotId as RetrievalSnapshotId }),
    ...(value.snapshotSha256 === undefined ? {} : { snapshotSha256: value.snapshotSha256 as string }),
    retrieverVersion: value.retrieverVersion,
    tokenBudget: value.tokenBudget,
    consumedTokens: value.consumedTokens,
    items: Object.freeze(value.items.map(parseItem)),
    citationIds: Object.freeze(value.citationIds.map((id) => { assertDomain(isString(id), "invalid_argument", "Retrieval receipt citation IDs must be strings."); return id as CitationId; })),
    createdAt: value.createdAt,
    ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt as IsoTimestamp }),
    ...(value.receiptSha256 === undefined ? {} : { receiptSha256: value.receiptSha256 as string }),
  };
  return validateReceipt(receipt);
}

