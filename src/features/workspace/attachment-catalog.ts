import type { AttachmentRecord as DesktopAttachmentRecord, AttachmentDraftRecord } from "@/lib/desktop";

import type { AttachmentView } from "./types";

/**
 * Stable renderer-side shape accepted from the native attachment catalog.
 * This intentionally mirrors only durable, non-secret attachment metadata;
 * blob bodies and native storage paths never cross the IPC boundary.
 */
export interface NativeAttachmentRecord {
  id: string;
  draftId?: string | null;
  projectId: string | null;
  messageId: string | null;
  blobId: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  contentHash: string;
  origin: "picker" | "drag-drop" | "clipboard" | "workspace" | "provider";
  extractionStatus: "pending" | "running" | "complete" | "failed" | "skipped";
  extractedContentHash: string | null;
  extractionVersion: string | null;
  createdAtMs: number;
  deletedAtMs: number | null;
}

const CODE_MEDIA_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/sql",
  "application/toml",
  "application/typescript",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-latex",
  "application/x-perl",
  "application/x-ruby",
  "application/x-sh",
  "application/x-yaml",
  "text/css",
  "text/html",
  "text/javascript",
  "text/markdown",
  "text/x-c",
  "text/x-c++",
  "text/x-csharp",
  "text/x-go",
  "text/x-java-source",
  "text/x-python",
  "text/x-rust",
  "text/xml",
  "text/yaml",
]);

const CODE_EXTENSIONS = new Set([
  "bat",
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "jsx",
  "json",
  "kt",
  "kts",
  "lua",
  "md",
  "php",
  "pl",
  "ps1",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

const DATA_MEDIA_TYPES = new Set([
  "application/vnd.apache.arrow.file",
  "application/vnd.apache.parquet",
  "application/x-ndjson",
  "text/csv",
  "text/tab-separated-values",
]);

const DATA_EXTENSIONS = new Set(["arrow", "csv", "ndjson", "parquet", "tsv"]);

function normalizedMediaType(mediaType: string): string {
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function extensionOf(filename: string): string {
  const leaf = filename.replaceAll("\\", "/").split("/").at(-1) ?? filename;
  const separator = leaf.lastIndexOf(".");
  return separator > 0 && separator < leaf.length - 1
    ? leaf.slice(separator + 1).toLowerCase()
    : "";
}

export function attachmentKind(
  filename: string,
  mediaType: string,
): AttachmentView["kind"] {
  const normalized = normalizedMediaType(mediaType);
  const extension = extensionOf(filename);
  if (normalized.startsWith("image/")) return "image";
  if (DATA_MEDIA_TYPES.has(normalized) || DATA_EXTENSIONS.has(extension)) return "data";
  if (CODE_MEDIA_TYPES.has(normalized) || CODE_EXTENSIONS.has(extension)) return "code";
  return "document";
}

export function attachmentState(
  extractionStatus: NativeAttachmentRecord["extractionStatus"],
): AttachmentView["state"] {
  switch (extractionStatus) {
    case "pending":
    case "running":
      return "processing";
    case "complete":
      return "ready";
    case "skipped":
      return "warning";
    case "failed":
      return "failed";
  }
  return "failed";
}

export function formatAttachmentSize(byteSize: number): string {
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) return "Unknown size";
  if (byteSize < 1_000) return `${byteSize} B`;
  if (byteSize < 1_000_000) return `${(byteSize / 1_000).toFixed(byteSize < 10_000 ? 1 : 0)} KB`;
  if (byteSize < 1_000_000_000) {
    return `${(byteSize / 1_000_000).toFixed(byteSize < 10_000_000 ? 1 : 0)} MB`;
  }
  return `${(byteSize / 1_000_000_000).toFixed(byteSize < 10_000_000_000 ? 1 : 0)} GB`;
}

export function attachmentFromNativeRecord(record: NativeAttachmentRecord): AttachmentView {
  return {
    id: record.id,
    ...(record.draftId === undefined ? {} : { draftId: record.draftId }),
    projectId: record.projectId,
    messageId: record.messageId,
    blobId: record.blobId,
    name: record.filename,
    kind: attachmentKind(record.filename, record.mediaType),
    mediaType: normalizedMediaType(record.mediaType),
    byteSize: record.byteSize,
    size: formatAttachmentSize(record.byteSize),
    state: attachmentState(record.extractionStatus),
    extractionStatus: record.extractionStatus,
    contentHash: record.contentHash.toLowerCase(),
    extractedContentHash: record.extractedContentHash?.toLowerCase() ?? null,
    extractionVersion: record.extractionVersion,
    origin: record.origin,
    createdAt: new Date(record.createdAtMs).toISOString(),
    deletedAt: record.deletedAtMs === null ? null : new Date(record.deletedAtMs).toISOString(),
  };
}

/**
 * Converts the deliberately smaller native attachment-list projection into a
 * renderer attachment view. The list/draft IPC records do not expose blob
 * hashes, storage paths, or extraction-version internals, so those optional
 * fields remain absent rather than being fabricated in the renderer.
 */
export function attachmentViewFromDesktopRecord(
  record: DesktopAttachmentRecord,
): AttachmentView {
  return {
    id: record.id,
    draftId: record.draftId,
    projectId: record.projectId,
    messageId: record.messageId,
    name: record.filename,
    kind: attachmentKind(record.filename, record.mediaType),
    mediaType: normalizedMediaType(record.mediaType),
    byteSize: record.byteSize,
    size: formatAttachmentSize(record.byteSize),
    state: attachmentState(
      record.extractionStatus as NativeAttachmentRecord["extractionStatus"],
    ),
    extractionStatus: record.extractionStatus as NativeAttachmentRecord["extractionStatus"],
    createdAt: new Date(record.createdAtMs).toISOString(),
    deletedAt: record.deletedAtMs === null ? null : new Date(record.deletedAtMs).toISOString(),
  };
}

/** Maps a native attachment list without exposing private blob metadata. */
export function attachmentViewsFromDesktopRecords(
  records: readonly DesktopAttachmentRecord[],
): AttachmentView[] {
  const byId = new Map<string, AttachmentView>();
  for (const record of records) {
    const attachment = attachmentViewFromDesktopRecord(record);
    if (attachment.deletedAt === null) byId.set(attachment.id, attachment);
    else byId.delete(attachment.id);
  }
  return [...byId.values()].sort(
    (left, right) =>
      (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || left.id.localeCompare(right.id),
  );
}

/** Maps the attachment members returned by one native picker draft. */
export function attachmentViewsFromDraftRecord(
  draft: Pick<AttachmentDraftRecord, "attachments">,
): AttachmentView[] {
  return attachmentViewsFromDesktopRecords(draft.attachments);
}

/**
 * Returns only live attachment IDs from open drafts in one exact
 * conversation/branch scope. Native draft listing is authoritative, but the
 * renderer still re-checks the scope and draft ownership before restoring a
 * selection after restart. This prevents a terminal, foreign-branch, or
 * tampered attachment row from becoming selectable merely because its ID was
 * present in an IPC response.
 */
export function openDraftAttachmentIds(
  drafts: readonly Pick<
    AttachmentDraftRecord,
    "id" | "conversationId" | "branchId" | "state" | "attachments"
  >[],
  scope: { conversationId: string; branchId: string },
): string[] {
  const ids = new Set<string>();
  for (const draft of drafts) {
    if (
      draft.state !== "open" ||
      draft.conversationId !== scope.conversationId ||
      draft.branchId !== scope.branchId
    ) {
      continue;
    }
    for (const attachment of draft.attachments) {
      if (attachment.deletedAtMs !== null || attachment.draftId !== draft.id) continue;
      ids.add(attachment.id);
    }
  }
  return [...ids];
}

/**
 * Reconciles a native snapshot into deterministic newest-first renderer state.
 * Duplicate IDs are resolved by the last native row so incremental refreshes
 * cannot leave two projections of the same durable object on screen.
 */
export function attachmentsFromNativeRecords(
  records: readonly NativeAttachmentRecord[],
): AttachmentView[] {
  const byId = new Map<string, AttachmentView>();
  for (const record of records) {
    const attachment = attachmentFromNativeRecord(record);
    if (attachment.deletedAt === null) byId.set(attachment.id, attachment);
    else byId.delete(attachment.id);
  }
  return [...byId.values()].sort(
    (left, right) =>
      (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || left.id.localeCompare(right.id),
  );
}

export function attachmentsForMessage(
  attachments: readonly AttachmentView[],
  messageId: string,
): AttachmentView[] {
  return attachments.filter(
    (attachment) => attachment.deletedAt === null && attachment.messageId === messageId,
  );
}

export function attachmentsForProject(
  attachments: readonly AttachmentView[],
  projectId: string,
): AttachmentView[] {
  return attachments.filter(
    (attachment) => attachment.deletedAt === null && attachment.projectId === projectId,
  );
}
