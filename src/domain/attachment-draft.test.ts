import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import {
  abandonAttachmentDraft,
  addAttachmentToDraft,
  bindAttachmentDraft,
  createAttachmentDraft,
  expireAttachmentDraft,
  removeAttachmentFromDraft,
} from "./attachment-draft";
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

const id = <T extends string>(value: string) => value as T;
const now = "2026-08-13T00:00:00.000Z";
const later = "2026-08-13T00:05:00.000Z";
const expiry = "2026-08-13T01:00:00.000Z";
const expired = "2026-08-13T01:00:00.000Z";

function draft() {
  return createAttachmentDraft({
    id: id<AttachmentDraftId>("draft_1"),
    profileId: id<ProfileId>("profile_1"),
    scope: {
      projectId: id<ProjectId>("project_1"),
      conversationId: id<ConversationId>("conversation_1"),
      branchId: id<BranchId>("branch_1"),
    },
    attachmentIds: [id<AttachmentId>("attachment_1")],
    now,
    expiresAt: expiry,
  });
}

describe("attachment draft ownership", () => {
  it("creates an open durable scope with immutable attachment identities", () => {
    const value = draft();
    expect(value.state).toBe("open");
    expect(value.attachmentIds).toEqual(["attachment_1"]);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.attachmentIds)).toBe(true);
  });

  it("rejects duplicate or empty selections", () => {
    expect(() => createAttachmentDraft({
      id: id<AttachmentDraftId>("draft_2"),
      profileId: id<ProfileId>("profile_1"),
      scope: { conversationId: id<ConversationId>("conversation_1") },
      attachmentIds: [],
      now,
      expiresAt: expiry,
    })).toThrow(DomainError);
    expect(() => createAttachmentDraft({
      id: id<AttachmentDraftId>("draft_3"),
      profileId: id<ProfileId>("profile_1"),
      scope: { conversationId: id<ConversationId>("conversation_1") },
      attachmentIds: [id<AttachmentId>("attachment_1"), id<AttachmentId>("attachment_1")],
      now,
      expiresAt: expiry,
    })).toThrow(DomainError);
  });

  it("rejects invalid or non-forward expiry timestamps", () => {
    expect(() => createAttachmentDraft({
      id: id<AttachmentDraftId>("draft_4"),
      profileId: id<ProfileId>("profile_1"),
      scope: { conversationId: id<ConversationId>("conversation_1") },
      attachmentIds: [id<AttachmentId>("attachment_1")],
      now: "not-a-time",
      expiresAt: expiry,
    })).toThrow(DomainError);
    expect(() => createAttachmentDraft({
      id: id<AttachmentDraftId>("draft_5"),
      profileId: id<ProfileId>("profile_1"),
      scope: { conversationId: id<ConversationId>("conversation_1") },
      attachmentIds: [id<AttachmentId>("attachment_1")],
      now,
      expiresAt: now,
    })).toThrow(DomainError);
  });

  it("rejects an unscoped draft and a branch without a conversation", () => {
    expect(() => createAttachmentDraft({
      id: id<AttachmentDraftId>("draft_6"),
      profileId: id<ProfileId>("profile_1"),
      attachmentIds: [id<AttachmentId>("attachment_1")],
      now,
      expiresAt: expiry,
    })).toThrow(DomainError);
    expect(() => createAttachmentDraft({
      id: id<AttachmentDraftId>("draft_7"),
      profileId: id<ProfileId>("profile_1"),
      scope: { branchId: id<BranchId>("branch_1") },
      attachmentIds: [id<AttachmentId>("attachment_1")],
      now,
      expiresAt: expiry,
    })).toThrow(DomainError);
  });

  it("supports selection edits without allowing an empty draft", () => {
    const selected = addAttachmentToDraft(draft(), id<AttachmentId>("attachment_2"), later);
    expect(selected.attachmentIds).toEqual(["attachment_1", "attachment_2"]);
    const removed = removeAttachmentFromDraft(selected, id<AttachmentId>("attachment_2"), later);
    expect(removed.attachmentIds).toEqual(["attachment_1"]);
    expect(() => removeAttachmentFromDraft(removed, id<AttachmentId>("attachment_1"), later)).toThrow(DomainError);
  });

  it("binds atomically to the exact message/run target and allows identical replay", () => {
    const input = {
      profileId: id<ProfileId>("profile_1"),
      projectId: id<ProjectId>("project_1"),
      conversationId: id<ConversationId>("conversation_1"),
      branchId: id<BranchId>("branch_1"),
      messageId: id<MessageId>("message_1"),
      runId: id<RunId>("run_1"),
      bindingKey: "run_1:message_1",
      now: later,
    };
    const bound = bindAttachmentDraft(draft(), input);
    expect(bound.state).toBe("bound");
    expect(bound.binding?.messageId).toBe("message_1");
    expect(bindAttachmentDraft(bound, input)).toBe(bound);
    expect(() => bindAttachmentDraft(bound, { ...input, runId: id<RunId>("run_2") })).toThrow(DomainError);
    expect(() => bindAttachmentDraft(bound, { ...input, profileId: id<ProfileId>("profile_other") })).toThrow(DomainError);
  });

  it("rejects profile/scope drift before message creation", () => {
    const input = {
      profileId: id<ProfileId>("profile_other"),
      projectId: id<ProjectId>("project_1"),
      conversationId: id<ConversationId>("conversation_1"),
      branchId: id<BranchId>("branch_1"),
      messageId: id<MessageId>("message_1"),
      runId: id<RunId>("run_1"),
      bindingKey: "run_1:message_1",
      now: later,
    };
    expect(() => bindAttachmentDraft(draft(), input)).toThrow(DomainError);
    expect(() => bindAttachmentDraft(draft(), { ...input, profileId: id<ProfileId>("profile_1"), projectId: id<ProjectId>("project_other") })).toThrow(DomainError);
  });

  it("expires and abandons only before binding", () => {
    const expiredDraft = expireAttachmentDraft(draft(), expired);
    expect(expiredDraft.state).toBe("expired");
    expect(() => addAttachmentToDraft(expiredDraft, id<AttachmentId>("attachment_2"), later)).toThrow(DomainError);
    const abandoned = abandonAttachmentDraft(draft(), later);
    expect(abandoned.state).toBe("abandoned");
    expect(() => bindAttachmentDraft(abandoned, {
      profileId: id<ProfileId>("profile_1"),
      projectId: id<ProjectId>("project_1"),
      conversationId: id<ConversationId>("conversation_1"),
      branchId: id<BranchId>("branch_1"),
      messageId: id<MessageId>("message_1"),
      runId: id<RunId>("run_1"),
      bindingKey: "run_1:message_1",
      now: later,
    })).toThrow(DomainError);
    expect(() => abandonAttachmentDraft(draft(), expired)).toThrow(DomainError);
  });
});
