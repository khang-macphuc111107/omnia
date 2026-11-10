import { assertDomain } from "./errors";

declare const entityIdBrand: unique symbol;

export type EntityId<TKind extends string> = string & {
  readonly [entityIdBrand]: TKind;
};

export type ProfileId = EntityId<"profile">;
export type ProjectId = EntityId<"project">;
export type WorkspaceGrantId = EntityId<"workspace-grant">;
export type ProviderConnectionId = EntityId<"provider-connection">;
export type ModelProfileId = EntityId<"model-profile">;
export type ConversationId = EntityId<"conversation">;
export type BranchId = EntityId<"branch">;
export type MessageId = EntityId<"message">;
export type RunSetId = EntityId<"run-set">;
export type RunId = EntityId<"run">;
export type AttemptId = EntityId<"attempt">;
export type RunEventId = EntityId<"run-event">;
export type ContextSnapshotId = EntityId<"context-snapshot">;
export type ContextItemId = EntityId<"context-item">;
export type MemoryId = EntityId<"memory">;
export type MemoryRevisionId = EntityId<"memory-revision">;
export type SkillId = EntityId<"skill">;
export type SkillVersionId = EntityId<"skill-version">;
/** Stable identity for one logical extension/integration across versions. */
export type IntegrationId = EntityId<"integration">;
/** Stable identity for one immutable integration manifest version. */
export type IntegrationVersionId = EntityId<"integration-version">;
export type CapabilityGrantId = EntityId<"capability-grant">;
export type AttachmentId = EntityId<"attachment">;
/** Durable native-owned selection scope used before a user message exists. */
export type AttachmentDraftId = EntityId<"attachment-draft">;
export type AttachmentIngestionId = EntityId<"attachment-ingestion">;
export type ExtractionAttemptId = EntityId<"extraction-attempt">;
export type ArtifactId = EntityId<"artifact">;
export type CommandId = EntityId<"command">;
export type ProviderModelId = EntityId<"provider-model">;
export type ParameterPresetId = EntityId<"parameter-preset">;
export type AssistantProfileId = EntityId<"assistant-profile">;
export type PromptTemplateId = EntityId<"prompt-template">;
export type IndexedSourceId = EntityId<"indexed-source">;
export type FileVersionId = EntityId<"file-version">;
export type SourceChunkId = EntityId<"source-chunk">;
export type RetrievalSnapshotId = EntityId<"retrieval-snapshot">;
export type CitationId = EntityId<"citation">;
export type ArtifactRevisionId = EntityId<"artifact-revision">;
export type MemoryProposalId = EntityId<"memory-proposal">;
export type ApprovalId = EntityId<"approval">;
export type ExecutionEnvironmentId = EntityId<"execution-environment">;
export type CapabilityRequestId = EntityId<"capability-request">;
export type ApprovalReceiptId = EntityId<"approval-receipt">;
export type AuditEventId = EntityId<"audit-event">;
export type TaskId = EntityId<"task">;
export type IterationId = EntityId<"iteration">;
export type RunItemId = EntityId<"run-item">;
export type LearningPlanId = EntityId<"learning-plan">;
export type LearningObjectiveId = EntityId<"learning-objective">;
export type LearningEvidenceId = EntityId<"learning-evidence">;
export type LearningAssessmentId = EntityId<"learning-assessment">;
export type ResearchQuestionId = EntityId<"research-question">;
export type ResearchClaimId = EntityId<"research-claim">;
export type BrowserAttachmentId = EntityId<"browser-attachment">;
export type CaptureAuthorizationId = EntityId<"capture-authorization">;
export type CapturePlanId = EntityId<"capture-plan">;
export type CaptureSourceId = EntityId<"capture-source">;
export type CaptureCompletionId = EntityId<"capture-completion">;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ULID_TIME = 281_474_976_710_655;

function encodeTime(timestampMs: number): string {
  assertDomain(
    Number.isSafeInteger(timestampMs) && timestampMs >= 0 && timestampMs <= MAX_ULID_TIME,
    "invalid_argument",
    "ULID timestamp must be a non-negative 48-bit integer.",
    { timestampMs },
  );

  let remaining = timestampMs;
  const characters = Array<string>(10);
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    characters[index] = CROCKFORD_BASE32[remaining % 32] ?? "0";
    remaining = Math.floor(remaining / 32);
  }
  return characters.join("");
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoApi = globalThis.crypto;
  assertDomain(
    cryptoApi !== undefined && typeof cryptoApi.getRandomValues === "function",
    "invalid_state_transition",
    "A cryptographically secure random source is required to create durable IDs.",
  );
  cryptoApi.getRandomValues(bytes);
  return bytes;
}

function encodeRandom(bytes: Uint8Array): string {
  // A ULID carries 80 random bits, represented by 16 Crockford base32 digits.
  let accumulator = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of bytes) {
    accumulator = accumulator * 256 + byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const divisor = 2 ** bits;
      const digit = Math.floor(accumulator / divisor) % 32;
      encoded += CROCKFORD_BASE32[digit];
      accumulator %= divisor;
    }
  }
  if (bits > 0) {
    encoded += CROCKFORD_BASE32[(accumulator * 2 ** (5 - bits)) % 32];
  }
  return encoded.slice(0, 16);
}

/** Creates a sortable, provider-independent ULID for a durable entity. */
export function createEntityId<TKind extends string>(timestampMs = Date.now()): EntityId<TKind> {
  return `${encodeTime(timestampMs)}${encodeRandom(randomBytes(10))}` as EntityId<TKind>;
}

/** Validates an ID when it crosses IPC, import, or persistence boundaries. */
export function parseEntityId<TKind extends string>(value: string, label = "id"): EntityId<TKind> {
  const normalized = value.trim().toUpperCase();
  assertDomain(ULID_PATTERN.test(normalized), "invalid_argument", `${label} must be a valid ULID.`, {
    label,
  });
  return normalized as EntityId<TKind>;
}

export function isEntityId(value: unknown): value is EntityId<string> {
  return typeof value === "string" && ULID_PATTERN.test(value);
}
