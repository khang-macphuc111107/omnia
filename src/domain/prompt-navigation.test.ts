import { describe, expect, it } from "vitest";

import {
  appendMessage,
  createConversation,
  forkConversation,
  type Conversation,
} from "./conversation";
import { DomainError } from "./errors";
import type {
  BranchId,
  ConversationId,
  MessageId,
  ModelProfileId,
  ProfileId,
  ProviderConnectionId,
  RunId,
} from "./ids";
import {
  createBoundaryJumpTarget,
  createMessageJumpTarget,
  createQueryJumpTarget,
  createRelativeJumpTarget,
  findAdjacentJumpTarget,
  messageSemanticFingerprint,
  resolveJumpTarget,
  searchJumpTargets,
} from "./prompt-navigation";

const id = <T extends string>(value: string) => value as T;
const now = "2026-09-15T00:00:00.000Z";
const conversationId = id<ConversationId>("01K2H000000000000000000001");
const rootBranchId = id<BranchId>("01K2H000000000000000000002");
const profileId = id<ProfileId>("01K2H000000000000000000003");
const providerConnectionId = id<ProviderConnectionId>("01K2H000000000000000000004");
const modelProfileId = id<ModelProfileId>("01K2H000000000000000000005");
const runId = id<RunId>("01K2H000000000000000000006");

function conversationWithMessages(): Conversation {
  let conversation = createConversation({ id: conversationId, rootBranchId, profileId, now });
  conversation = appendMessage(conversation, {
    id: id<MessageId>("01K2H000000000000000000007"),
    branchId: rootBranchId,
    role: "user",
    content: [{ type: "text", text: "Explain branch-safe navigation." }],
    contentText: "Explain branch-safe navigation.",
    now,
    finalizedAt: now,
  }).conversation;
  conversation = appendMessage(conversation, {
    id: id<MessageId>("01K2H000000000000000000008"),
    branchId: rootBranchId,
    role: "assistant",
    content: [{ type: "markdown", markdown: "Use immutable anchors." }],
    contentText: "Use immutable anchors.",
    model: { providerConnectionId, modelProfileId, providerModelId: "model" },
    producingRunId: runId,
    now,
    finalizedAt: now,
  }).conversation;
  conversation = appendMessage(conversation, {
    id: id<MessageId>("01K2H000000000000000000009"),
    branchId: rootBranchId,
    role: "user",
    content: [{ type: "text", text: "Now add stale-target handling." }],
    contentText: "Now add stale-target handling.",
    now,
    finalizedAt: now,
  }).conversation;
  return conversation;
}

describe("prompt navigation domain", () => {
  it("resolves an immutable message target and preserves its fingerprint", () => {
    const conversation = conversationWithMessages();
    const messageId = id<MessageId>("01K2H000000000000000000008");
    const target = createMessageJumpTarget({ conversation, branchId: rootBranchId, messageId, now });
    const result = resolveJumpTarget(conversation, target);

    expect(result.status).toBe("resolved");
    expect(result.message?.id).toBe(messageId);
    expect(target.source.semanticFingerprint).toBe(messageSemanticFingerprint(result.message!));
    expect(target.source.semanticFingerprint).not.toContain(result.message!.contentText);
    expect(target.source.semanticFingerprint?.length).toBeLessThanOrEqual(256);
  });

  it("resolves inherited targets on a child branch but rejects an unrelated branch", () => {
    const conversation = conversationWithMessages();
    const target = createMessageJumpTarget({
      conversation,
      branchId: rootBranchId,
      messageId: id<MessageId>("01K2H000000000000000000007"),
      now,
    });
    const childBranchId = id<BranchId>("01K2H000000000000000000010");
    const forked = forkConversation(conversation, {
      branchId: childBranchId,
      parentBranchId: rootBranchId,
      forkedFromMessageId: id<MessageId>("01K2H000000000000000000008"),
      now,
    });
    const childTarget = { ...target, source: { ...target.source, branchId: childBranchId } };
    expect(resolveJumpTarget(forked, childTarget).status).toBe("resolved");

    const otherBranchId = id<BranchId>("01K2H000000000000000000011");
    const unrelated = forkConversation(forked, { branchId: otherBranchId, parentBranchId: childBranchId, now });
    const staleTarget = { ...target, source: { ...target.source, branchId: otherBranchId } };
    expect(resolveJumpTarget(unrelated, staleTarget).status).toBe("stale");
  });

  it("fails closed for stale, superseded, and fingerprint-drifted targets", () => {
    const conversation = conversationWithMessages();
    const messageId = id<MessageId>("01K2H000000000000000000008");
    const target = createMessageJumpTarget({ conversation, branchId: rootBranchId, messageId, now });
    expect(resolveJumpTarget(conversation, { ...target, stale: true }).reason).toBe("target-marked-stale");

    const drifted = { ...target, source: { ...target.source, semanticFingerprint: "different" } };
    expect(resolveJumpTarget(conversation, drifted).reason).toBe("semantic-fingerprint-mismatch");
  });

  it("supports boundary targets, text/role filters, and deterministic adjacency", () => {
    const conversation = conversationWithMessages();
    const first = createBoundaryJumpTarget({ conversation, branchId: rootBranchId, kind: "first-message", now });
    const latest = createBoundaryJumpTarget({ conversation, branchId: rootBranchId, kind: "latest-output", now });
    expect(resolveJumpTarget(conversation, first).message?.sequence).toBe(0);
    expect(resolveJumpTarget(conversation, latest).message?.role).toBe("assistant");
    expect(first.source.messageId).toBe(id<MessageId>("01K2H000000000000000000007"));
    expect(latest.source.messageId).toBe(id<MessageId>("01K2H000000000000000000008"));

    const extended = appendMessage(conversation, {
      id: id<MessageId>("01K2H000000000000000000014"),
      branchId: rootBranchId,
      role: "assistant",
      content: [{ type: "markdown", markdown: "A newer response." }],
      contentText: "A newer response.",
      model: { providerConnectionId, modelProfileId, providerModelId: "model" },
      producingRunId: runId,
      now,
      finalizedAt: now,
    }).conversation;
    expect(resolveJumpTarget(extended, latest).message?.id).toBe(latest.source.messageId);

    const search = searchJumpTargets(conversation, rootBranchId, { text: "navigation", role: "user" }, now);
    expect(search).toHaveLength(1);
    expect(search[0]?.message.contentText).toContain("navigation");

    const next = findAdjacentJumpTarget(
      conversation,
      rootBranchId,
      id<MessageId>("01K2H000000000000000000007"),
      "forward",
      { role: "user" },
      now,
    );
    expect(next?.source.messageId).toBe(id<MessageId>("01K2H000000000000000000009"));
  });

  it("filters targets by provider/model/run attribution and creation window", () => {
    const conversation = conversationWithMessages();
    const assistant = searchJumpTargets(
      conversation,
      rootBranchId,
      {
        providerConnectionId,
        modelProfileId,
        providerModelId: "model",
        producingRunId: runId,
        createdAfterMs: Date.parse("2026-09-14T23:59:59.000Z"),
        createdBeforeMs: Date.parse("2026-09-15T00:00:01.000Z"),
      },
      now,
    );
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.message.role).toBe("assistant");

    expect(
      searchJumpTargets(
        conversation,
        rootBranchId,
        { providerModelId: "missing-model" },
        now,
      ),
    ).toHaveLength(0);
    expect(() =>
      searchJumpTargets(
        conversation,
        rootBranchId,
        { createdAfterMs: 10, createdBeforeMs: 9 },
        now,
      ),
    ).toThrowError(DomainError);
  });

  it("resolves relative prompt and query targets without fabricating a message", () => {
    const conversation = conversationWithMessages();
    const next = createRelativeJumpTarget({
      conversation,
      branchId: rootBranchId,
      kind: "next-prompt",
      fromMessageId: id<MessageId>("01K2H000000000000000000007"),
      now,
    });
    const previous = createRelativeJumpTarget({
      conversation,
      branchId: rootBranchId,
      kind: "previous-prompt",
      fromMessageId: id<MessageId>("01K2H000000000000000000009"),
      now,
    });
    expect(resolveJumpTarget(conversation, next).message?.id).toBe(id<MessageId>("01K2H000000000000000000009"));
    expect(resolveJumpTarget(conversation, previous).message?.id).toBe(id<MessageId>("01K2H000000000000000000007"));

    const query = createQueryJumpTarget({
      conversation,
      branchId: rootBranchId,
      query: "stale-target",
      now,
    });
    expect(resolveJumpTarget(conversation, query).message?.id).toBe(id<MessageId>("01K2H000000000000000000009"));
    expect(resolveJumpTarget(conversation, { ...query, query: "not present" }).reason).toBe("no-match");
    expect(() => resolveJumpTarget(conversation, { ...query, query: "   " })).toThrowError(DomainError);
  });

  it("rejects malformed targets and does not fall back to the first result", () => {
    const conversation = conversationWithMessages();
    const target = createMessageJumpTarget({
      conversation,
      branchId: rootBranchId,
      messageId: id<MessageId>("01K2H000000000000000000008"),
      now,
    });
    expect(() => resolveJumpTarget(conversation, { ...target, targetId: "   " })).toThrowError(DomainError);
    expect(() =>
      resolveJumpTarget(conversation, {
        ...target,
        source: { ...target.source, messageId: "" as MessageId },
      }),
    ).toThrowError(DomainError);

    let large = conversation;
    let lastMessageId = id<MessageId>("01K2H000000000000000000009");
    for (let index = 0; index < 510; index += 1) {
      lastMessageId = id<MessageId>(`large-user-${index}`);
      large = appendMessage(large, {
        id: lastMessageId,
        branchId: rootBranchId,
        role: "user",
        content: [{ type: "text", text: `Large prompt ${index}` }],
        contentText: `Large prompt ${index}`,
        now,
        finalizedAt: now,
      }).conversation;
    }
    expect(findAdjacentJumpTarget(large, rootBranchId, lastMessageId, "forward", { role: "user" }, now)).toBeUndefined();
  });

  it("fails closed for erased creator and filter unions", () => {
    const conversation = conversationWithMessages();
    expect(() =>
      createBoundaryJumpTarget({
        conversation,
        branchId: rootBranchId,
        kind: "query" as never,
        now,
      }),
    ).toThrowError(DomainError);
    expect(() =>
      createRelativeJumpTarget({
        conversation,
        branchId: rootBranchId,
        kind: "first-message" as never,
        now,
      }),
    ).toThrowError(DomainError);
    expect(() =>
      findAdjacentJumpTarget(
        conversation,
        rootBranchId,
        undefined,
        "sideways" as never,
        {},
        now,
      ),
    ).toThrowError(DomainError);
    expect(() => searchJumpTargets(conversation, rootBranchId, { role: "invalid" as never }, now)).toThrowError(DomainError);
    expect(() => searchJumpTargets(conversation, rootBranchId, null as never, now)).toThrowError(DomainError);
  });

  it("rejects cross-conversation targets before resolution", () => {
    const conversation = conversationWithMessages();
    const target = createMessageJumpTarget({ conversation, branchId: rootBranchId, messageId: id<MessageId>("01K2H000000000000000000007"), now });
    const other = createConversation({
      id: id<ConversationId>("01K2H000000000000000000012"),
      rootBranchId: id<BranchId>("01K2H000000000000000000013"),
      profileId,
      now,
    });
    expect(() => resolveJumpTarget(other, target)).toThrowError(DomainError);
  });
});
