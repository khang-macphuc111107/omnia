import type { RoutedProviderModel } from "./provider-parameters";
import type { ComposerAttachmentItem } from "./composer-attachments";

export type ComposerAttachmentCompatibilityStatus =
  | "compatible"
  | "review"
  | "blocked"
  | "preview-only";

export type ComposerAttachmentCompatibilityKind =
  | "image"
  | "video"
  | "audio"
  | "document";

export interface ComposerAttachmentCompatibilityRow {
  readonly attachmentId: string;
  readonly name: string;
  readonly kind: ComposerAttachmentCompatibilityKind;
  readonly modalityLabel: string;
  readonly status: ComposerAttachmentCompatibilityStatus;
  readonly label: string;
  readonly detail: string;
  readonly capability: "vision" | "audio" | null;
}

export interface ComposerAttachmentCompatibilitySummary {
  readonly total: number;
  readonly compatible: number;
  readonly review: number;
  readonly blocked: number;
  readonly previewOnly: number;
  /**
   * This is deliberately true whenever an attachment exists. The current
   * provider gateway is text-only, so a catalog-compatible signal must not be
   * mistaken for an upload or dispatch receipt.
   */
  readonly dispatchGated: boolean;
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/bmp"]);
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4", "audio/aac", "audio/ogg", "audio/webm"]);

function normalizedMediaType(mediaType: string | undefined): string {
  return mediaType?.trim().toLowerCase().split(";", 1)[0] ?? "";
}

export function composerAttachmentCompatibilityKind(
  attachment: Pick<ComposerAttachmentItem, "kind" | "mediaType" | "previewType">,
): ComposerAttachmentCompatibilityKind {
  const mediaType = normalizedMediaType(attachment.mediaType);
  if (attachment.previewType === "image" || mediaType.startsWith("image/") || attachment.kind === "image") return "image";
  if (attachment.previewType === "video" || mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/") || AUDIO_TYPES.has(mediaType)) return "audio";
  return "document";
}

function providerReady(route: RoutedProviderModel): boolean {
  return route.provider.state === "connected" || route.provider.state === "configuration-validated";
}

function providerObserved(route: RoutedProviderModel): boolean {
  return route.provider.source === "native" && route.provider.state === "connected";
}

function modelAvailable(route: RoutedProviderModel): boolean {
  return route.model.status === "available";
}

function kindLabel(kind: ComposerAttachmentCompatibilityKind): string {
  if (kind === "image") return "Image";
  if (kind === "video") return "Video";
  if (kind === "audio") return "Audio";
  return "Document / data";
}

function capabilityForKind(kind: ComposerAttachmentCompatibilityKind): "vision" | "audio" | null {
  if (kind === "image" || kind === "video") return "vision";
  if (kind === "audio") return "audio";
  return null;
}

function rowForAttachment(
  attachment: ComposerAttachmentItem,
  route: RoutedProviderModel | null,
): ComposerAttachmentCompatibilityRow {
  const kind = composerAttachmentCompatibilityKind(attachment);
  const modalityLabel = kindLabel(kind);
  const capability = capabilityForKind(kind);

  if (attachment.state === "preview") {
    return {
      attachmentId: attachment.id,
      name: attachment.name,
      kind,
      modalityLabel,
      capability,
      status: "preview-only",
      label: "Preview only",
      detail: "This browser file stays in the current tab and cannot be uploaded or sent.",
    };
  }

  if (attachment.state !== "ready") {
    return {
      attachmentId: attachment.id,
      name: attachment.name,
      kind,
      modalityLabel,
      capability,
      status: "blocked",
      label: "Finish ingestion",
      detail: "Attachment extraction or review is incomplete; sending remains fail-closed.",
    };
  }

  if (!route) {
    return {
      attachmentId: attachment.id,
      name: attachment.name,
      kind,
      modalityLabel,
      capability,
      status: "blocked",
      label: "No route",
      detail: "Choose a provider model before assessing attachment compatibility.",
    };
  }

  if (!providerReady(route) || !modelAvailable(route)) {
    return {
      attachmentId: attachment.id,
      name: attachment.name,
      kind,
      modalityLabel,
      capability,
      status: "blocked",
      label: "Route unavailable",
      detail: "The selected provider or model is not ready for a compatibility assessment.",
    };
  }

  if (kind === "document") {
    return {
      attachmentId: attachment.id,
      name: attachment.name,
      kind,
      modalityLabel,
      capability,
      status: "review",
      label: "Transform review",
      detail: "Document/code/data delivery needs an extraction and carrier plan; the current gateway has no attachment carrier receipt.",
    };
  }

  if (kind === "video") {
    return {
      attachmentId: attachment.id,
      name: attachment.name,
      kind,
      modalityLabel,
      capability,
      status: "review",
      label: "Adapter review",
      detail: route.model.capabilities.includes("vision")
        ? "The model declares vision, but video carrier support is provider-operation specific and unobserved."
        : "The selected model does not declare vision; a video carrier is not established.",
    };
  }

  if (!route.model.capabilities.includes(capability!)) {
    return {
      attachmentId: attachment.id,
      name: attachment.name,
      kind,
      modalityLabel,
      capability,
      status: "blocked",
      label: "Capability missing",
      detail: `${modalityLabel} input requires a ${capability} capability declaration on the selected model.`,
    };
  }

  if (!providerObserved(route)) {
    return {
      attachmentId: attachment.id,
      name: attachment.name,
      kind,
      modalityLabel,
      capability,
      status: "review",
      label: "Review evidence",
      detail: "The model declares this capability, but the provider endpoint has not produced an observed native acceptance receipt.",
    };
  }

  return {
    attachmentId: attachment.id,
    name: attachment.name,
    kind,
    modalityLabel,
    capability,
    status: "compatible",
    label: "Catalog compatible",
    detail: "The selected native provider/model declares the required capability. Upload and dispatch remain separately gated.",
  };
}

export function assessComposerAttachmentCompatibility(
  attachments: readonly ComposerAttachmentItem[],
  route: RoutedProviderModel | null,
): ComposerAttachmentCompatibilityRow[] {
  return attachments.map((attachment) => rowForAttachment(attachment, route));
}

export function summarizeComposerAttachmentCompatibility(
  rows: readonly ComposerAttachmentCompatibilityRow[],
): ComposerAttachmentCompatibilitySummary {
  return {
    total: rows.length,
    compatible: rows.filter((row) => row.status === "compatible").length,
    review: rows.filter((row) => row.status === "review").length,
    blocked: rows.filter((row) => row.status === "blocked").length,
    previewOnly: rows.filter((row) => row.status === "preview-only").length,
    dispatchGated: rows.length > 0,
  };
}

export function composerAttachmentCompatibilityReason(
  summary: ComposerAttachmentCompatibilitySummary,
): string | null {
  if (summary.total === 0) return null;
  if (summary.previewOnly > 0) {
    return summary.previewOnly === 1
      ? "One browser-preview file is not uploadable in this build."
      : `${summary.previewOnly} browser-preview files are not uploadable in this build.`;
  }
  if (summary.blocked > 0) {
    return summary.blocked === 1
      ? "One attachment is blocked by the current route or ingestion state."
      : `${summary.blocked} attachments are blocked by the current route or ingestion state.`;
  }
  if (summary.review > 0) {
    return summary.review === 1
      ? "One attachment needs provider/carrier review before dispatch."
      : `${summary.review} attachments need provider/carrier review before dispatch.`;
  }
  return "Catalog compatibility is visible; provider upload and dispatch are still gated.";
}

export const composerAttachmentCompatibilityMimeHints = Object.freeze({
  image: [...IMAGE_TYPES],
  audio: [...AUDIO_TYPES],
});
