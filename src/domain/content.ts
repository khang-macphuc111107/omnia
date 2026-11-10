import { assertDomain } from "./errors";
import type {
  ArtifactId,
  ArtifactRevisionId,
  AttachmentId,
  ConversationId,
  MessageId,
  ProfileId,
  ProjectId,
  RunId,
} from "./ids";
import { assertNonBlank, assertSha256, type IsoTimestamp, type JsonObject } from "./shared";

export type ExtractionStatus = "pending" | "running" | "complete" | "failed" | "skipped";
export type AttachmentOrigin = "picker" | "drag-drop" | "clipboard" | "workspace" | "provider";

export interface Attachment {
  readonly id: AttachmentId;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly messageId?: MessageId;
  readonly blobId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly origin: AttachmentOrigin;
  readonly extractionStatus: ExtractionStatus;
  readonly extractedContentHash?: string;
  readonly extractionVersion?: string;
  readonly createdAt: IsoTimestamp;
  readonly deletedAt?: IsoTimestamp;
  readonly metadata: JsonObject;
}

export interface CreateAttachmentInput extends Omit<Attachment, "filename" | "mediaType" | "contentHash" | "createdAt" | "extractionStatus" | "metadata"> {
  readonly filename: string;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly extractionStatus?: ExtractionStatus;
  readonly now: IsoTimestamp;
  readonly metadata?: JsonObject;
}

export function createAttachment(input: CreateAttachmentInput): Attachment {
  assertDomain(
    input.projectId !== undefined || input.messageId !== undefined,
    "invalid_argument",
    "Attachment must belong to a message or project.",
  );
  assertDomain(
    Number.isSafeInteger(input.byteSize) && input.byteSize >= 0,
    "invalid_argument",
    "Attachment byte size must be a non-negative integer.",
  );
  return Object.freeze({
    id: input.id,
    profileId: input.profileId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    blobId: assertNonBlank(input.blobId, "attachment blob ID", 256),
    filename: assertNonBlank(input.filename, "attachment filename", 512),
    mediaType: assertNonBlank(input.mediaType, "attachment media type", 255).toLowerCase(),
    byteSize: input.byteSize,
    contentHash: assertSha256(input.contentHash, "attachment content hash"),
    origin: input.origin,
    extractionStatus: input.extractionStatus ?? "pending",
    ...(input.extractedContentHash === undefined
      ? {}
      : { extractedContentHash: assertSha256(input.extractedContentHash, "extracted content hash") }),
    ...(input.extractionVersion === undefined ? {} : { extractionVersion: input.extractionVersion }),
    createdAt: input.now,
    ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

export function transitionExtraction(
  attachment: Attachment,
  status: ExtractionStatus,
  extractedContentHash?: string,
  extractionVersion?: string,
): Attachment {
  assertDomain(
    attachment.deletedAt === undefined,
    "invalid_state_transition",
    "Deleted attachment cannot be extracted.",
    { attachmentId: attachment.id },
  );
  const allowed: Readonly<Record<ExtractionStatus, readonly ExtractionStatus[]>> = {
    pending: ["running", "skipped", "failed"],
    running: ["complete", "failed", "skipped"],
    complete: [],
    failed: ["running", "skipped"],
    skipped: ["running"],
  };
  assertDomain(
    allowed[attachment.extractionStatus].includes(status),
    "invalid_state_transition",
    `Attachment extraction cannot transition from ${attachment.extractionStatus} to ${status}.`,
  );
  assertDomain(
    status !== "complete" || (extractedContentHash !== undefined && extractionVersion !== undefined),
    "invalid_argument",
    "Completed extraction requires a content hash and extraction version.",
  );
  assertDomain(
    status === "complete" || extractedContentHash === undefined,
    "invalid_argument",
    "Only a completed extraction may set an extracted content hash.",
  );
  assertDomain(
    status === "complete" || extractionVersion === undefined,
    "invalid_argument",
    "Only a completed extraction may set an extraction version.",
  );
  return Object.freeze({
    ...attachment,
    extractionStatus: status,
    ...(extractedContentHash === undefined
      ? {}
      : { extractedContentHash: assertSha256(extractedContentHash, "extracted content hash") }),
    ...(extractionVersion === undefined ? {} : { extractionVersion }),
  });
}

export type ArtifactKind = "document" | "code" | "table" | "diagram" | "html" | "svg" | "json" | "csv" | "text";

export interface ArtifactRevision {
  readonly id: ArtifactRevisionId;
  readonly artifactId: ArtifactId;
  readonly revision: number;
  readonly blobId: string;
  readonly contentHash: string;
  readonly sourceMessageId?: MessageId;
  readonly sourceRunId?: RunId;
  readonly createdAt: IsoTimestamp;
}

export interface Artifact {
  readonly id: ArtifactId;
  readonly conversationId: ConversationId;
  readonly sourceMessageId?: MessageId;
  readonly producingRunId: RunId;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly language?: string;
  readonly revisions: readonly ArtifactRevision[];
  readonly currentRevisionId: ArtifactRevisionId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly deletedAt?: IsoTimestamp;
}

export function createArtifact(
  input: Omit<Artifact, "title" | "revisions" | "currentRevisionId" | "createdAt" | "updatedAt"> & {
    readonly title: string;
    readonly initialRevision: ArtifactRevision;
    readonly now: IsoTimestamp;
  },
): Artifact {
  assertDomain(input.initialRevision.artifactId === input.id, "scope_violation", "Artifact revision belongs to another artifact.");
  assertDomain(input.initialRevision.revision === 1, "invalid_argument", "Initial artifact revision must be number one.");
  assertNonBlank(input.initialRevision.blobId, "artifact blob ID", 256);
  assertSha256(input.initialRevision.contentHash, "artifact content hash");
  return Object.freeze({
    id: input.id,
    conversationId: input.conversationId,
    ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
    producingRunId: input.producingRunId,
    kind: input.kind,
    title: assertNonBlank(input.title, "artifact title", 500),
    ...(input.language === undefined ? {} : { language: input.language }),
    revisions: Object.freeze([Object.freeze(input.initialRevision)]),
    currentRevisionId: input.initialRevision.id,
    createdAt: input.now,
    updatedAt: input.now,
    ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
  });
}

export function addArtifactRevision(
  artifact: Artifact,
  revision: ArtifactRevision,
  now: IsoTimestamp,
): Artifact {
  assertDomain(artifact.deletedAt === undefined, "invalid_state_transition", "Deleted artifact cannot be revised.");
  assertDomain(revision.artifactId === artifact.id, "scope_violation", "Revision belongs to another artifact.");
  assertDomain(
    revision.revision === artifact.revisions.length + 1,
    "invalid_state_transition",
    "Artifact revision numbers must be contiguous.",
  );
  assertDomain(!artifact.revisions.some((candidate) => candidate.id === revision.id), "conflict", "Artifact revision ID already exists.");
  assertNonBlank(revision.blobId, "artifact blob ID", 256);
  assertSha256(revision.contentHash, "artifact content hash");
  return Object.freeze({
    ...artifact,
    revisions: Object.freeze([...artifact.revisions, Object.freeze(revision)]),
    currentRevisionId: revision.id,
    updatedAt: now,
  });
}

export interface CitationSpan {
  readonly sourceId: string;
  readonly sourceContentHash: string;
  readonly start: number;
  readonly end: number;
  readonly sourceAvailableInSnapshot: boolean;
}

export function validateCitationSpan(span: CitationSpan, sourceText: string): void {
  assertSha256(span.sourceContentHash, "citation source hash");
  assertDomain(span.sourceAvailableInSnapshot, "scope_violation", "Citation source was not present in the frozen context snapshot.");
  assertDomain(
    Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.end > span.start && span.end <= sourceText.length,
    "invalid_argument",
    "Citation span is outside its persisted source.",
    { start: span.start, end: span.end, sourceLength: sourceText.length },
  );
}
