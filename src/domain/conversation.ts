import { assertDomain } from "./errors";
import type {
  AttachmentId,
  BranchId,
  ConversationId,
  MessageId,
  ModelProfileId,
  ProfileId,
  ProjectId,
  ProviderConnectionId,
  RunId,
} from "./ids";
import { assertNonBlank, type IsoTimestamp, type JsonObject } from "./shared";

export type MessageRole = "system" | "developer" | "user" | "assistant" | "tool";

export type MessageStatus =
  | "pending-local"
  | "queued"
  | "streaming"
  | "complete"
  | "stopped"
  | "failed"
  | "superseded";

export type MessageContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "markdown"; readonly markdown: string }
  | {
      readonly type: "code";
      readonly code: string;
      readonly language?: string;
      readonly filename?: string;
    }
  | {
      readonly type: "image";
      readonly attachmentId: AttachmentId;
      readonly alt?: string;
    }
  | {
      readonly type: "file";
      readonly attachmentId: AttachmentId;
      readonly displayName: string;
    }
  | {
      readonly type: "citation";
      readonly sourceId: string;
      readonly displayIndex: number;
      readonly start?: number;
      readonly end?: number;
    };

export interface ModelAttribution {
  readonly providerConnectionId: ProviderConnectionId;
  readonly modelProfileId: ModelProfileId;
  readonly providerModelId: string;
}

/**
 * A message is an immutable content record. Streaming updates are projections
 * owned by a run; finalization creates/replaces the projected message value in
 * storage but never mutates an already-finalized historical message.
 */
export interface Message {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly branchId: BranchId;
  readonly parentMessageId?: MessageId;
  readonly replacesMessageId?: MessageId;
  readonly producingRunId?: RunId;
  readonly role: MessageRole;
  readonly status: MessageStatus;
  readonly sequence: number;
  readonly content: readonly MessageContentBlock[];
  readonly contentText: string;
  readonly attachmentIds: readonly AttachmentId[];
  readonly model?: ModelAttribution;
  readonly createdAt: IsoTimestamp;
  readonly finalizedAt?: IsoTimestamp;
  readonly finishReason?: string;
  readonly metadata: JsonObject;
}

export interface ConversationBranch {
  readonly id: BranchId;
  readonly conversationId: ConversationId;
  readonly parentBranchId?: BranchId;
  readonly forkedFromMessageId?: MessageId;
  readonly name?: string;
  /** IDs created directly on this branch; inherited prefix IDs are resolved. */
  readonly localMessageIds: readonly MessageId[];
  readonly createdAt: IsoTimestamp;
}

export interface Conversation {
  readonly id: ConversationId;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly title: string;
  readonly tags: readonly string[];
  readonly activeBranchId: BranchId;
  readonly branches: readonly ConversationBranch[];
  readonly messages: readonly Message[];
  readonly pinnedAt?: IsoTimestamp;
  readonly archivedAt?: IsoTimestamp;
  readonly deletedAt?: IsoTimestamp;
  readonly temporary: boolean;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly metadata: JsonObject;
}

export interface CreateConversationInput {
  readonly id: ConversationId;
  readonly rootBranchId: BranchId;
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly temporary?: boolean;
  readonly now: IsoTimestamp;
  readonly metadata?: JsonObject;
}

export function createConversation(input: CreateConversationInput): Conversation {
  const title = input.title === undefined ? "New chat" : assertNonBlank(input.title, "title", 500);
  const rootBranch: ConversationBranch = Object.freeze({
    id: input.rootBranchId,
    conversationId: input.id,
    localMessageIds: Object.freeze([]),
    createdAt: input.now,
  });

  return Object.freeze({
    id: input.id,
    profileId: input.profileId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    title,
    tags: Object.freeze([...(input.tags ?? [])].map((tag) => assertNonBlank(tag, "tag", 80))),
    activeBranchId: rootBranch.id,
    branches: Object.freeze([rootBranch]),
    messages: Object.freeze([]),
    temporary: input.temporary ?? false,
    createdAt: input.now,
    updatedAt: input.now,
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

export function getConversationBranch(
  conversation: Conversation,
  branchId: BranchId,
): ConversationBranch {
  const branch = conversation.branches.find((candidate) => candidate.id === branchId);
  assertDomain(branch !== undefined, "not_found", "Conversation branch was not found.", {
    conversationId: conversation.id,
    branchId,
  });
  return branch;
}

export function getConversationMessage(conversation: Conversation, messageId: MessageId): Message {
  const message = conversation.messages.find((candidate) => candidate.id === messageId);
  assertDomain(message !== undefined, "not_found", "Conversation message was not found.", {
    conversationId: conversation.id,
    messageId,
  });
  return message;
}

/** Resolves the immutable prefix inherited by a branch plus its local nodes. */
export function resolveBranchMessageIds(
  conversation: Conversation,
  branchId: BranchId,
): readonly MessageId[] {
  const visiting = new Set<BranchId>();

  const visit = (currentBranchId: BranchId): readonly MessageId[] => {
    assertDomain(
      !visiting.has(currentBranchId),
      "invalid_state_transition",
      "Conversation branch ancestry contains a cycle.",
      { conversationId: conversation.id, branchId: currentBranchId },
    );
    visiting.add(currentBranchId);
    const branch = getConversationBranch(conversation, currentBranchId);
    let inherited: readonly MessageId[] = [];

    if (branch.parentBranchId !== undefined) {
      const parentPath = visit(branch.parentBranchId);
      if (branch.forkedFromMessageId !== undefined) {
        const forkIndex = parentPath.indexOf(branch.forkedFromMessageId);
        assertDomain(
          forkIndex >= 0,
          "scope_violation",
          "Branch fork point is not visible on its parent branch.",
          {
            branchId: branch.id,
            parentBranchId: branch.parentBranchId,
            forkedFromMessageId: branch.forkedFromMessageId,
          },
        );
        inherited = parentPath.slice(0, forkIndex + 1);
      }
    } else {
      assertDomain(
        branch.forkedFromMessageId === undefined,
        "invalid_state_transition",
        "A root branch cannot declare a fork point.",
        { branchId: branch.id },
      );
    }

    visiting.delete(currentBranchId);
    return Object.freeze([...inherited, ...branch.localMessageIds]);
  };

  return visit(branchId);
}

export function resolveBranchMessages(
  conversation: Conversation,
  branchId: BranchId,
): readonly Message[] {
  const byId = new Map(conversation.messages.map((message) => [message.id, message]));
  return Object.freeze(
    resolveBranchMessageIds(conversation, branchId).map((messageId) => {
      const message = byId.get(messageId);
      assertDomain(message !== undefined, "not_found", "A branch references a missing message.", {
        branchId,
        messageId,
      });
      return message;
    }),
  );
}

export interface ForkConversationInput {
  readonly branchId: BranchId;
  readonly parentBranchId: BranchId;
  readonly forkedFromMessageId?: MessageId;
  readonly name?: string;
  readonly now: IsoTimestamp;
  readonly activate?: boolean;
}

export function forkConversation(
  conversation: Conversation,
  input: ForkConversationInput,
): Conversation {
  assertDomain(
    !conversation.branches.some((branch) => branch.id === input.branchId),
    "conflict",
    "Conversation branch ID already exists.",
    { branchId: input.branchId },
  );
  getConversationBranch(conversation, input.parentBranchId);

  if (input.forkedFromMessageId !== undefined) {
    assertDomain(
      resolveBranchMessageIds(conversation, input.parentBranchId).includes(input.forkedFromMessageId),
      "scope_violation",
      "The requested fork point is not visible on the parent branch.",
      { parentBranchId: input.parentBranchId, forkedFromMessageId: input.forkedFromMessageId },
    );
  }

  const branch: ConversationBranch = Object.freeze({
    id: input.branchId,
    conversationId: conversation.id,
    parentBranchId: input.parentBranchId,
    ...(input.forkedFromMessageId === undefined
      ? {}
      : { forkedFromMessageId: input.forkedFromMessageId }),
    ...(input.name === undefined ? {} : { name: assertNonBlank(input.name, "branch name", 120) }),
    localMessageIds: Object.freeze([]),
    createdAt: input.now,
  });

  return Object.freeze({
    ...conversation,
    activeBranchId: input.activate === false ? conversation.activeBranchId : branch.id,
    branches: Object.freeze([...conversation.branches, branch]),
    updatedAt: input.now,
  });
}

export interface DuplicateBranchInput {
  readonly branchId: BranchId;
  readonly sourceBranchId: BranchId;
  readonly name?: string;
  readonly now: IsoTimestamp;
  readonly activate?: boolean;
}

/** Creates a named checkpoint that inherits the complete source branch path. */
export function duplicateConversationBranch(
  conversation: Conversation,
  input: DuplicateBranchInput,
): Conversation {
  const sourcePath = resolveBranchMessageIds(conversation, input.sourceBranchId);
  const forkPoint = sourcePath.at(-1);
  return forkConversation(conversation, {
    branchId: input.branchId,
    parentBranchId: input.sourceBranchId,
    ...(forkPoint === undefined ? {} : { forkedFromMessageId: forkPoint }),
    ...(input.name === undefined ? {} : { name: input.name }),
    now: input.now,
    ...(input.activate === undefined ? {} : { activate: input.activate }),
  });
}

export interface AppendMessageInput {
  readonly id: MessageId;
  readonly branchId: BranchId;
  readonly role: MessageRole;
  readonly status?: MessageStatus;
  readonly content: readonly MessageContentBlock[];
  readonly contentText: string;
  readonly attachmentIds?: readonly AttachmentId[];
  readonly replacesMessageId?: MessageId;
  readonly producingRunId?: RunId;
  readonly model?: ModelAttribution;
  readonly now: IsoTimestamp;
  readonly finalizedAt?: IsoTimestamp;
  readonly finishReason?: string;
  readonly metadata?: JsonObject;
}

export interface AppendMessageResult {
  readonly conversation: Conversation;
  readonly message: Message;
}

const FINAL_MESSAGE_STATES = new Set<MessageStatus>([
  "complete",
  "stopped",
  "failed",
  "superseded",
]);

export function appendMessage(
  conversation: Conversation,
  input: AppendMessageInput,
): AppendMessageResult {
  assertDomain(
    !conversation.messages.some((message) => message.id === input.id),
    "conflict",
    "Message ID already exists.",
    { messageId: input.id },
  );
  const branch = getConversationBranch(conversation, input.branchId);
  const path = resolveBranchMessages(conversation, branch.id);
  const parentMessage = path.at(-1);
  const status = input.status ?? "complete";

  assertDomain(
    input.content.length > 0 ||
      (input.attachmentIds?.length ?? 0) > 0 ||
      input.contentText.trim().length > 0 ||
      (input.role === "assistant" && status === "failed"),
    "invalid_argument",
    "A message must contain text, a content block, or an attachment.",
    { messageId: input.id },
  );
  assertDomain(
    input.role !== "assistant" || input.model !== undefined,
    "invalid_argument",
    "Assistant messages must preserve model attribution.",
    { messageId: input.id },
  );

  if (input.replacesMessageId !== undefined) {
    const replaced = getConversationMessage(conversation, input.replacesMessageId);
    assertDomain(
      replaced.conversationId === conversation.id,
      "scope_violation",
      "Replacement target belongs to another conversation.",
      { messageId: input.id, replacesMessageId: replaced.id },
    );
  }
  if (input.role === "assistant") {
    assertDomain(
      input.producingRunId !== undefined,
      "invalid_argument",
      "Assistant messages must reference their producing run.",
      { messageId: input.id },
    );
  }
  if (FINAL_MESSAGE_STATES.has(status)) {
    assertDomain(
      input.finalizedAt !== undefined,
      "invalid_argument",
      "A terminal message must have a finalization timestamp.",
      { messageId: input.id, status },
    );
  } else {
    assertDomain(
      input.finalizedAt === undefined,
      "invalid_argument",
      "A nonterminal message cannot have a finalization timestamp.",
      { messageId: input.id, status },
    );
  }

  const message: Message = Object.freeze({
    id: input.id,
    conversationId: conversation.id,
    branchId: branch.id,
    ...(parentMessage === undefined ? {} : { parentMessageId: parentMessage.id }),
    ...(input.replacesMessageId === undefined
      ? {}
      : { replacesMessageId: input.replacesMessageId }),
    ...(input.producingRunId === undefined ? {} : { producingRunId: input.producingRunId }),
    role: input.role,
    status,
    sequence: path.length,
    content: Object.freeze([...input.content]),
    contentText: input.contentText,
    attachmentIds: Object.freeze([...(input.attachmentIds ?? [])]),
    ...(input.model === undefined ? {} : { model: Object.freeze({ ...input.model }) }),
    createdAt: input.now,
    ...(input.finalizedAt === undefined ? {} : { finalizedAt: input.finalizedAt }),
    ...(input.finishReason === undefined ? {} : { finishReason: input.finishReason }),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
  const nextBranch: ConversationBranch = Object.freeze({
    ...branch,
    localMessageIds: Object.freeze([...branch.localMessageIds, message.id]),
  });

  return Object.freeze({
    message,
    conversation: Object.freeze({
      ...conversation,
      activeBranchId: branch.id,
      branches: Object.freeze(
        conversation.branches.map((candidate) =>
          candidate.id === branch.id ? nextBranch : candidate,
        ),
      ),
      messages: Object.freeze([...conversation.messages, message]),
      updatedAt: input.now,
    }),
  });
}

export interface EditMessageInput {
  readonly branchId: BranchId;
  readonly replacementMessageId: MessageId;
  readonly targetMessageId: MessageId;
  readonly content: readonly MessageContentBlock[];
  readonly contentText: string;
  readonly attachmentIds?: readonly AttachmentId[];
  readonly now: IsoTimestamp;
  readonly branchName?: string;
}

/** Editing forks before the target and appends a replacement immutable node. */
export function editMessage(
  conversation: Conversation,
  input: EditMessageInput,
): AppendMessageResult {
  const target = getConversationMessage(conversation, input.targetMessageId);
  assertDomain(
    target.role === "user",
    "invalid_argument",
    "Only user messages can be edited directly.",
    { messageId: target.id, role: target.role },
  );
  const sourcePath = resolveBranchMessageIds(conversation, target.branchId);
  assertDomain(
    sourcePath.includes(target.id),
    "scope_violation",
    "The edited message is not visible on its source branch.",
    { messageId: target.id, branchId: target.branchId },
  );

  const forked = forkConversation(conversation, {
    branchId: input.branchId,
    parentBranchId: target.branchId,
    ...(target.parentMessageId === undefined
      ? {}
      : { forkedFromMessageId: target.parentMessageId }),
    ...(input.branchName === undefined ? {} : { name: input.branchName }),
    now: input.now,
  });

  return appendMessage(forked, {
    id: input.replacementMessageId,
    branchId: input.branchId,
    role: "user",
    status: "complete",
    content: input.content,
    contentText: input.contentText,
    ...(input.attachmentIds === undefined ? {} : { attachmentIds: input.attachmentIds }),
    replacesMessageId: target.id,
    now: input.now,
    finalizedAt: input.now,
  });
}

export function activateConversationBranch(
  conversation: Conversation,
  branchId: BranchId,
  now: IsoTimestamp,
): Conversation {
  getConversationBranch(conversation, branchId);
  return Object.freeze({ ...conversation, activeBranchId: branchId, updatedAt: now });
}

export interface UpdateConversationInput {
  readonly title?: string;
  readonly projectId?: ProjectId | null;
  readonly tags?: readonly string[];
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly now: IsoTimestamp;
}

export function updateConversation(
  conversation: Conversation,
  input: UpdateConversationInput,
): Conversation {
  assertDomain(conversation.deletedAt === undefined, "invalid_state_transition", "Deleted conversation cannot be updated.", {
    conversationId: conversation.id,
  });
  const tags =
    input.tags === undefined
      ? conversation.tags
      : Object.freeze(
          [...new Set(input.tags.map((tag) => assertNonBlank(tag, "tag", 80)))].slice(0, 100),
        );
  const { projectId: currentProjectId, pinnedAt, archivedAt, ...baseConversation } = conversation;
  const projectFields =
    input.projectId === undefined
      ? currentProjectId === undefined
        ? {}
        : { projectId: currentProjectId }
      : input.projectId === null
        ? {}
        : { projectId: input.projectId };
  const pinFields =
    input.pinned === undefined
      ? pinnedAt === undefined
        ? {}
        : { pinnedAt }
      : input.pinned
        ? { pinnedAt: input.now }
        : {};
  const archiveFields =
    input.archived === undefined
      ? archivedAt === undefined
        ? {}
        : { archivedAt }
      : input.archived
        ? { archivedAt: input.now }
        : {};
  return Object.freeze({
    ...baseConversation,
    ...(input.title === undefined ? {} : { title: assertNonBlank(input.title, "title", 500) }),
    ...projectFields,
    tags,
    ...pinFields,
    ...archiveFields,
    updatedAt: input.now,
  });
}

export function softDeleteConversation(
  conversation: Conversation,
  now: IsoTimestamp,
): Conversation {
  assertDomain(conversation.deletedAt === undefined, "conflict", "Conversation is already deleted.", {
    conversationId: conversation.id,
  });
  return Object.freeze({ ...conversation, deletedAt: now, updatedAt: now });
}

export function restoreConversation(conversation: Conversation, now: IsoTimestamp): Conversation {
  assertDomain(conversation.deletedAt !== undefined, "invalid_state_transition", "Conversation is not deleted.", {
    conversationId: conversation.id,
  });
  const restored = { ...conversation } as Omit<Conversation, "deletedAt"> & {
    deletedAt?: never;
  };
  delete restored.deletedAt;
  return Object.freeze({ ...restored, updatedAt: now });
}

export interface ConversationSearchDocument {
  readonly conversationId: ConversationId;
  readonly title: string;
  readonly messageText: string;
  readonly tags: readonly string[];
  readonly projectId?: ProjectId;
  readonly providerConnectionIds: readonly ProviderConnectionId[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** Builds the non-secret projection used by a local FTS/search index. */
export function createConversationSearchDocument(
  conversation: Conversation,
): ConversationSearchDocument | undefined {
  if (conversation.temporary || conversation.deletedAt !== undefined) return undefined;
  const providerConnectionIds = new Set<ProviderConnectionId>();
  for (const message of conversation.messages) {
    if (message.model !== undefined) providerConnectionIds.add(message.model.providerConnectionId);
  }
  return Object.freeze({
    conversationId: conversation.id,
    title: conversation.title,
    messageText: conversation.messages.map((message) => message.contentText).join("\n"),
    tags: Object.freeze([...conversation.tags]),
    ...(conversation.projectId === undefined ? {} : { projectId: conversation.projectId }),
    providerConnectionIds: Object.freeze([...providerConnectionIds]),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  });
}

export function validateConversation(conversation: Conversation): void {
  assertDomain(conversation.branches.length > 0, "invalid_state_transition", "Conversation has no branch.");
  getConversationBranch(conversation, conversation.activeBranchId);

  const seenMessageIds = new Set<MessageId>();
  for (const message of conversation.messages) {
    assertDomain(
      message.conversationId === conversation.id,
      "scope_violation",
      "Message belongs to a different conversation.",
      { messageId: message.id },
    );
    assertDomain(!seenMessageIds.has(message.id), "conflict", "Duplicate message ID.", {
      messageId: message.id,
    });
    seenMessageIds.add(message.id);
    getConversationBranch(conversation, message.branchId);
    assertDomain(
      Number.isSafeInteger(message.sequence) && message.sequence >= 0,
      "invalid_state_transition",
      "Message sequence must be a non-negative integer.",
      { messageId: message.id, sequence: message.sequence },
    );
    assertDomain(
      message.role !== "assistant" ||
        (message.producingRunId !== undefined && message.model !== undefined),
      "invalid_state_transition",
      "Assistant message is missing run/model provenance.",
      { messageId: message.id },
    );
    assertDomain(
      FINAL_MESSAGE_STATES.has(message.status) === (message.finalizedAt !== undefined),
      "invalid_state_transition",
      "Message status and finalization timestamp disagree.",
      { messageId: message.id, status: message.status },
    );
  }

  const seenBranchIds = new Set<BranchId>();
  for (const branch of conversation.branches) {
    assertDomain(
      branch.conversationId === conversation.id,
      "scope_violation",
      "Branch belongs to a different conversation.",
      { branchId: branch.id },
    );
    assertDomain(!seenBranchIds.has(branch.id), "conflict", "Duplicate conversation branch ID.", {
      branchId: branch.id,
    });
    seenBranchIds.add(branch.id);
    if (branch.parentBranchId !== undefined) {
      assertDomain(
        branch.parentBranchId !== branch.id,
        "invalid_state_transition",
        "A conversation branch cannot parent itself.",
        { branchId: branch.id },
      );
      getConversationBranch(conversation, branch.parentBranchId);
    }
    const localIds = new Set<MessageId>();
    for (const messageId of branch.localMessageIds) {
      assertDomain(!localIds.has(messageId), "conflict", "Branch contains a duplicate local message ID.", {
        branchId: branch.id,
        messageId,
      });
      localIds.add(messageId);
      const localMessage = getConversationMessage(conversation, messageId);
      assertDomain(
        localMessage.branchId === branch.id,
        "scope_violation",
        "Branch local message belongs to another branch.",
        { branchId: branch.id, messageId },
      );
    }
    const path = resolveBranchMessages(conversation, branch.id);
    path.forEach((message, sequence) => {
      assertDomain(
        message.sequence === sequence,
        "invalid_state_transition",
        "Message sequence does not match its resolved branch path.",
        { messageId: message.id, expected: sequence, actual: message.sequence },
      );
    });
  }
}
