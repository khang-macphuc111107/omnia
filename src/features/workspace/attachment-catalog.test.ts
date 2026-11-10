import { describe, expect, it } from "vitest";

import {
  attachmentFromNativeRecord,
  attachmentKind,
  attachmentViewFromDesktopRecord,
  attachmentViewsFromDraftRecord,
  attachmentViewsFromDesktopRecords,
  attachmentsForMessage,
  attachmentsForProject,
  attachmentsFromNativeRecords,
  formatAttachmentSize,
  openDraftAttachmentIds,
  type NativeAttachmentRecord,
} from "./attachment-catalog";

const digest = "a".repeat(64);

function nativeAttachment(
  patch: Partial<NativeAttachmentRecord> = {},
): NativeAttachmentRecord {
  return {
    id: "attachment_0123456789abcdef0123456789abcdef",
    projectId: "project_0123456789abcdef0123456789abcdef",
    messageId: null,
    blobId: digest,
    filename: "architecture.pdf",
    mediaType: "application/pdf",
    byteSize: 2_500_000,
    contentHash: digest,
    origin: "picker",
    extractionStatus: "pending",
    extractedContentHash: null,
    extractionVersion: null,
    createdAtMs: 10,
    deletedAtMs: null,
    ...patch,
  };
}

describe("native attachment catalog", () => {
  it("maps the renderer-safe desktop record and preserves open-draft ownership", () => {
    const attachment = attachmentViewFromDesktopRecord({
      id: "attachment_33333333333333333333333333333333",
      draftId: "attachment_draft_33333333333333333333333333333333",
      projectId: null,
      messageId: null,
      filename: "notes.md",
      mediaType: "text/markdown; charset=utf-8",
      byteSize: 1_250,
      extractionStatus: "complete",
      createdAtMs: 25,
      deletedAtMs: null,
    });

    expect(attachment).toMatchObject({
      id: "attachment_33333333333333333333333333333333",
      draftId: "attachment_draft_33333333333333333333333333333333",
      name: "notes.md",
      kind: "code",
      mediaType: "text/markdown",
      state: "ready",
      extractionStatus: "complete",
    });
    expect(attachment).not.toHaveProperty("blobId");
    expect(attachment).not.toHaveProperty("contentHash");
    expect(attachment).not.toHaveProperty("path");
  });

  it("deduplicates desktop rows and removes tombstones without leaking private metadata", () => {
    const active = {
      id: "attachment_44444444444444444444444444444444",
      draftId: null,
      projectId: null,
      messageId: null,
      filename: "scan.pdf",
      mediaType: "application/pdf",
      byteSize: 4_000,
      extractionStatus: "failed" as const,
      createdAtMs: 10,
      deletedAtMs: null,
    };
    const deleted = { ...active, deletedAtMs: 20 };
    const views = attachmentViewsFromDesktopRecords([active, deleted]);
    expect(views).toEqual([]);
  });

  it("restores only live open-draft attachments in the exact conversation and branch", () => {
    const openDraftId = "attachment_draft_55555555555555555555555555555555";
    const ids = openDraftAttachmentIds(
      [
        {
          id: openDraftId,
          conversationId: "conversation_catalog",
          branchId: "branch_catalog",
          state: "open",
          attachments: [
            {
              id: "attachment_55555555555555555555555555555555",
              draftId: openDraftId,
              projectId: null,
              messageId: null,
              filename: "live.pdf",
              mediaType: "application/pdf",
              byteSize: 10,
              extractionStatus: "pending",
              createdAtMs: 1,
              deletedAtMs: null,
            },
            {
              id: "attachment_66666666666666666666666666666666",
              draftId: openDraftId,
              projectId: null,
              messageId: null,
              filename: "deleted.pdf",
              mediaType: "application/pdf",
              byteSize: 10,
              extractionStatus: "pending",
              createdAtMs: 1,
              deletedAtMs: 2,
            },
          ],
        },
        {
          id: "attachment_draft_77777777777777777777777777777777",
          conversationId: "conversation_catalog",
          branchId: "branch_foreign",
          state: "open",
          attachments: [
            {
              id: "attachment_77777777777777777777777777777777",
              draftId: "attachment_draft_77777777777777777777777777777777",
              projectId: null,
              messageId: null,
              filename: "foreign.pdf",
              mediaType: "application/pdf",
              byteSize: 10,
              extractionStatus: "pending",
              createdAtMs: 1,
              deletedAtMs: null,
            },
          ],
        },
        {
          id: "attachment_draft_88888888888888888888888888888888",
          conversationId: "conversation_catalog",
          branchId: "branch_catalog",
          state: "abandoned",
          attachments: [
            {
              id: "attachment_88888888888888888888888888888888",
              draftId: "attachment_draft_88888888888888888888888888888888",
              projectId: null,
              messageId: null,
              filename: "abandoned.pdf",
              mediaType: "application/pdf",
              byteSize: 10,
              extractionStatus: "pending",
              createdAtMs: 1,
              deletedAtMs: null,
            },
          ],
        },
      ],
      { conversationId: "conversation_catalog", branchId: "branch_catalog" },
    );

    expect(ids).toEqual(["attachment_55555555555555555555555555555555"]);
  });

  it("maps a draft projection using the same tombstone and metadata boundary", () => {
    const draftId = "attachment_draft_99999999999999999999999999999999";
    const views = attachmentViewsFromDraftRecord({
      attachments: [
        {
          id: "attachment_99999999999999999999999999999999",
          draftId,
          projectId: null,
          messageId: null,
          filename: "figure.png",
          mediaType: "image/png",
          byteSize: 9_000,
          extractionStatus: "skipped",
          createdAtMs: 3,
          deletedAtMs: null,
        },
        {
          id: "attachment_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          draftId,
          projectId: null,
          messageId: null,
          filename: "removed.png",
          mediaType: "image/png",
          byteSize: 9_000,
          extractionStatus: "failed",
          createdAtMs: 4,
          deletedAtMs: 5,
        },
      ],
    });

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      id: "attachment_99999999999999999999999999999999",
      draftId,
      kind: "image",
      state: "warning",
      extractionStatus: "skipped",
    });
    expect(views[0]).not.toHaveProperty("blobId");
    expect(views[0]).not.toHaveProperty("contentHash");
  });

  it("maps durable metadata without exposing a native filesystem path", () => {
    const attachment = attachmentFromNativeRecord(
      nativeAttachment({ mediaType: "Application/PDF; charset=binary" }),
    );

    expect(attachment).toMatchObject({
      name: "architecture.pdf",
      kind: "document",
      mediaType: "application/pdf",
      byteSize: 2_500_000,
      size: "2.5 MB",
      state: "processing",
      extractionStatus: "pending",
      contentHash: digest,
      origin: "picker",
      deletedAt: null,
    });
    expect(attachment).not.toHaveProperty("path");
    expect(attachment).not.toHaveProperty("storageRelpath");
  });

  it("classifies content conservatively from MIME type and filename", () => {
    expect(attachmentKind("photo.bin", "image/png")).toBe("image");
    expect(attachmentKind("table.csv", "application/octet-stream")).toBe("data");
    expect(attachmentKind("component.tsx", "text/plain")).toBe("code");
    expect(attachmentKind("report.docx", "application/octet-stream")).toBe("document");
  });

  it("formats byte sizes using stable decimal labels", () => {
    expect(formatAttachmentSize(0)).toBe("0 B");
    expect(formatAttachmentSize(999)).toBe("999 B");
    expect(formatAttachmentSize(1_500)).toBe("1.5 KB");
    expect(formatAttachmentSize(25_000)).toBe("25 KB");
    expect(formatAttachmentSize(2_500_000)).toBe("2.5 MB");
    expect(formatAttachmentSize(-1)).toBe("Unknown size");
  });

  it("deduplicates by durable ID, removes tombstones, and sorts newest first", () => {
    const first = nativeAttachment({ extractionStatus: "pending", createdAtMs: 10 });
    const updated = nativeAttachment({ extractionStatus: "complete", createdAtMs: 10 });
    const newest = nativeAttachment({
      id: "attachment_11111111111111111111111111111111",
      filename: "latest.png",
      mediaType: "image/png",
      createdAtMs: 30,
    });
    const removed = nativeAttachment({
      id: "attachment_22222222222222222222222222222222",
      deletedAtMs: 40,
    });

    const catalog = attachmentsFromNativeRecords([first, newest, updated, removed]);

    expect(catalog.map((attachment) => attachment.id)).toEqual([newest.id, first.id]);
    expect(catalog[1]?.state).toBe("ready");
  });

  it("selects only active attachments in the requested scope", () => {
    const projectId = "project_0123456789abcdef0123456789abcdef";
    const messageId = "message_0123456789abcdef0123456789abcdef";
    const projectAttachment = attachmentFromNativeRecord(nativeAttachment({ projectId }));
    const messageAttachment = attachmentFromNativeRecord(
      nativeAttachment({
        id: "attachment_11111111111111111111111111111111",
        projectId: null,
        messageId,
      }),
    );

    expect(attachmentsForProject([projectAttachment, messageAttachment], projectId)).toEqual([
      projectAttachment,
    ]);
    expect(attachmentsForMessage([projectAttachment, messageAttachment], messageId)).toEqual([
      messageAttachment,
    ]);
  });
});
