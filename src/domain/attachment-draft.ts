import { assertDomain } from "./errors";
import type {
  AttachmentDraftId,
  AttachmentId,
  BranchId,
  ConversationId,
  MessageId,
  ProfileId,
  ProjectId,
  RunId,
} from "./ids";
import { assertIsoTimestamp, assertNonBlank, type IsoTimestamp } from "./shared";

/**
 * A draft is the durable ownership scope between native file selection and
 * creation of the user message. It deliberately contains only attachment
 * identities; bodies and filesystem paths never enter the renderer contract.
 */
export type AttachmentDraftState = "open" | "bound" | "abandoned" | "expired";

export interface AttachmentDraftScope {
  readonly projectId?: ProjectId;
  readonly conversationId?: ConversationId;
  readonly branchId?: BranchId;
}

export interface AttachmentDraftBinding {
  readonly conversationId: ConversationId;
  readonly branchId: BranchId;
  readonly messageId: MessageId;
  readonly runId: RunId;
  /** Stable operation key used to make a retried bind idempotent. */
  readonly bindingKey: string;
  readonly boundAt: IsoTimestamp;
}

export interface AttachmentDraft {
  readonly id: AttachmentDraftId;
  readonly profileId: ProfileId;
  readonly scope: AttachmentDraftScope;
  readonly attachmentIds: readonly AttachmentId[];
  readonly state: AttachmentDraftState;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly binding?: AttachmentDraftBinding;
  readonly abandonedAt?: IsoTimestamp;
  readonly expiredAt?: IsoTimestamp;
}

export interface CreateAttachmentDraftInput {
  readonly id: AttachmentDraftId;
  readonly profileId: ProfileId;
  readonly scope?: AttachmentDraftScope;
  readonly attachmentIds: readonly AttachmentId[];
  readonly now: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface BindAttachmentDraftInput {
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly conversationId: ConversationId;
  readonly branchId: BranchId;
  readonly messageId: MessageId;
  readonly runId: RunId;
  readonly bindingKey: string;
  readonly now: IsoTimestamp;
}

function uniqueAttachmentIds(ids: readonly AttachmentId[]): readonly AttachmentId[] {
  const unique = [...new Set(ids)];
  assertDomain(unique.length === ids.length, "invalid_argument", "An attachment draft cannot contain duplicate attachment IDs.");
  assertDomain(unique.length > 0, "invalid_argument", "An attachment draft must contain at least one attachment.");
  return Object.freeze(unique);
}

function validateScope(scope: AttachmentDraftScope): AttachmentDraftScope {
  assertDomain(
    scope.projectId !== undefined || scope.conversationId !== undefined,
    "invalid_argument",
    "An attachment draft must be scoped to a project or conversation.",
  );
  assertDomain(
    scope.branchId === undefined || scope.conversationId !== undefined,
    "invalid_argument",
    "A branch-scoped attachment draft must also identify its conversation.",
  );
  return Object.freeze({
    ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
    ...(scope.conversationId === undefined ? {} : { conversationId: scope.conversationId }),
    ...(scope.branchId === undefined ? {} : { branchId: scope.branchId }),
  });
}

function assertTimestampOrder(now: IsoTimestamp, expiresAt: IsoTimestamp): void {
  assertIsoTimestamp(now, "attachment draft creation time");
  assertIsoTimestamp(expiresAt, "attachment draft expiry");
  assertDomain(Date.parse(expiresAt) > Date.parse(now), "invalid_argument", "Attachment draft expiry must be after creation.");
}

export function createAttachmentDraft(input: CreateAttachmentDraftInput): AttachmentDraft {
  assertTimestampOrder(input.now, input.expiresAt);
  const scope = validateScope(input.scope ?? {});
  return Object.freeze({
    id: input.id,
    profileId: input.profileId,
    scope,
    attachmentIds: uniqueAttachmentIds(input.attachmentIds),
    state: "open" as const,
    createdAt: input.now,
    expiresAt: input.expiresAt,
  });
}

function assertOpen(draft: AttachmentDraft, now: IsoTimestamp): void {
  assertIsoTimestamp(now, "attachment draft operation time");
  assertDomain(draft.state === "open", "invalid_state_transition", "Only an open attachment draft can be changed.", {
    draftId: draft.id,
    state: draft.state,
  });
  assertDomain(Date.parse(now) < Date.parse(draft.expiresAt), "invalid_state_transition", "The attachment draft has expired.", {
    draftId: draft.id,
  });
  assertDomain(Date.parse(now) >= Date.parse(draft.createdAt), "invalid_argument", "Attachment draft operations cannot predate creation.", {
    draftId: draft.id,
  });
}

export function addAttachmentToDraft(
  draft: AttachmentDraft,
  attachmentId: AttachmentId,
  now: IsoTimestamp,
): AttachmentDraft {
  assertOpen(draft, now);
  assertDomain(!draft.attachmentIds.includes(attachmentId), "conflict", "The attachment is already selected in this draft.", {
    draftId: draft.id,
    attachmentId,
  });
  return Object.freeze({
    ...draft,
    attachmentIds: Object.freeze([...draft.attachmentIds, attachmentId]),
  });
}

export function removeAttachmentFromDraft(
  draft: AttachmentDraft,
  attachmentId: AttachmentId,
  now: IsoTimestamp,
): AttachmentDraft {
  assertOpen(draft, now);
  assertDomain(draft.attachmentIds.includes(attachmentId), "not_found", "The attachment is not selected in this draft.", {
    draftId: draft.id,
    attachmentId,
  });
  const attachmentIds = draft.attachmentIds.filter((candidate) => candidate !== attachmentId);
  assertDomain(attachmentIds.length > 0, "invalid_argument", "Removing this attachment would leave an empty draft.", {
    draftId: draft.id,
  });
  return Object.freeze({ ...draft, attachmentIds: Object.freeze(attachmentIds) });
}

export function expireAttachmentDraft(draft: AttachmentDraft, now: IsoTimestamp): AttachmentDraft {
  assertIsoTimestamp(now, "attachment draft expiry evaluation time");
  if (draft.state !== "open") return draft;
  if (Date.parse(now) < Date.parse(draft.expiresAt)) return draft;
  return Object.freeze({
    ...draft,
    state: "expired" as const,
    expiredAt: now,
  });
}

export function abandonAttachmentDraft(draft: AttachmentDraft, now: IsoTimestamp): AttachmentDraft {
  assertOpen(draft, now);
  return Object.freeze({
    ...draft,
    state: "abandoned" as const,
    abandonedAt: now,
  });
}

function bindingMatches(draft: AttachmentDraft, input: BindAttachmentDraftInput): boolean {
  const binding = draft.binding;
  return binding !== undefined
    && binding.bindingKey === input.bindingKey
    && binding.conversationId === input.conversationId
    && binding.branchId === input.branchId
    && binding.messageId === input.messageId
    && binding.runId === input.runId;
}

export function bindAttachmentDraft(
  draft: AttachmentDraft,
  input: BindAttachmentDraftInput,
): AttachmentDraft {
  const bindingKey = assertNonBlank(input.bindingKey, "attachment draft binding key", 256);
  assertDomain(draft.profileId === input.profileId, "scope_violation", "The attachment draft belongs to another profile.", {
    draftId: draft.id,
  });
  assertDomain(
    draft.scope.projectId === undefined || draft.scope.projectId === input.projectId,
    "scope_violation",
    "The attachment draft belongs to another project.",
    { draftId: draft.id },
  );
  assertDomain(
    draft.scope.conversationId === undefined || draft.scope.conversationId === input.conversationId,
    "scope_violation",
    "The attachment draft belongs to another conversation.",
    { draftId: draft.id },
  );
  assertDomain(
    draft.scope.branchId === undefined || draft.scope.branchId === input.branchId,
    "scope_violation",
    "The attachment draft belongs to another branch.",
    { draftId: draft.id },
  );
  if (draft.state === "bound") {
    assertDomain(bindingMatches(draft, { ...input, bindingKey }), "conflict", "The attachment draft is already bound to another message or run.", {
      draftId: draft.id,
    });
    return draft;
  }
  assertOpen(draft, input.now);
  return Object.freeze({
    ...draft,
    state: "bound" as const,
    binding: Object.freeze({
      conversationId: input.conversationId,
      branchId: input.branchId,
      messageId: input.messageId,
      runId: input.runId,
      bindingKey,
      boundAt: input.now,
    }),
  });
}

export function isAttachmentDraftExpired(draft: AttachmentDraft, now: IsoTimestamp): boolean {
  assertIsoTimestamp(now, "attachment draft expiry evaluation time");
  return draft.state === "expired" || Date.parse(now) >= Date.parse(draft.expiresAt);
}
