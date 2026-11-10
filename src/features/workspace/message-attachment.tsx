import { FileAudio, FileVideo, Image as ImageIcon } from "lucide-react";

import { isDesktopRuntime } from "@/lib/desktop";
import { ComposerFileTypeIcon } from "./ai-panel-composer";
import { NativeAttachmentPreview } from "./native-attachment-preview";
import type { AttachmentPreviewType, AttachmentView } from "./types";

const RENDERER_LOCAL_URL_PREFIXES = ["blob:", "data:"] as const;

function normalizedMediaType(mediaType: string | undefined): string {
  return mediaType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isRendererLocalPreviewUrl(url: string | undefined): url is string {
  return Boolean(url && RENDERER_LOCAL_URL_PREFIXES.some((prefix) => url.startsWith(prefix)));
}

/**
 * Resolves a media element only when the attachment carries an explicit,
 * renderer-local URL. A MIME type by itself is not enough: native attachment
 * projections are metadata-only until the user explicitly opens the bounded
 * native binary-preview bridge below.
 */
export function attachmentPreviewType(
  attachment: Pick<AttachmentView, "previewUrl" | "previewType" | "mediaType">,
): AttachmentPreviewType | null {
  if (!isRendererLocalPreviewUrl(attachment.previewUrl)) return null;
  if (attachment.previewType) return attachment.previewType;

  const mediaType = normalizedMediaType(attachment.mediaType);
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return null;
}

function AttachmentFallbackIcon({
  attachment,
}: {
  attachment: Pick<AttachmentView, "mediaType" | "name">;
}) {
  const mediaType = normalizedMediaType(attachment.mediaType);
  if (mediaType.startsWith("image/")) return <ImageIcon size={17} strokeWidth={1.75} aria-hidden="true" />;
  if (mediaType.startsWith("video/")) return <FileVideo size={17} strokeWidth={1.75} aria-hidden="true" />;
  if (mediaType.startsWith("audio/")) return <FileAudio size={17} strokeWidth={1.75} aria-hidden="true" />;
  return <ComposerFileTypeIcon name={attachment.name} />;
}

export function MessageAttachmentCard({ attachment }: { attachment: AttachmentView }) {
  const previewType = attachmentPreviewType(attachment);
  const previewUrl = previewType ? attachment.previewUrl : undefined;
  const previewOnly = Boolean(previewType && previewUrl);
  const boundaryCopy = previewOnly
    ? "Local file preview."
    : "File content is unavailable in this preview.";

  return (
    <div
      className={`message-attachment${previewOnly ? " message-attachment--preview" : ""}`}
      aria-label={`${attachment.name}, ${attachment.size}. ${boundaryCopy}`}
      title={`${attachment.name}. ${boundaryCopy}`}
      data-preview-type={previewType ?? undefined}
    >
      <span className={`message-attachment__icon${previewOnly ? " message-attachment__icon--preview" : ""}`}>
        {previewType === "image" && previewUrl ? (
          <img src={previewUrl} alt={`Preview of ${attachment.name}`} />
        ) : previewType === "video" && previewUrl ? (
          <video
            src={previewUrl}
            aria-label={`Preview of ${attachment.name}`}
            preload="metadata"
            controls
          />
        ) : previewType === "audio" && previewUrl ? (
          <audio
            src={previewUrl}
            aria-label={`Preview of ${attachment.name}`}
            preload="metadata"
            controls
          />
        ) : (
          <AttachmentFallbackIcon attachment={attachment} />
        )}
      </span>
      <span className="message-attachment__body">
        <strong title={attachment.name}>{attachment.name}</strong>
        <small>{attachment.size}</small>
      </span>
      {!previewOnly && isDesktopRuntime() && /^attachment_[a-f0-9]{32}$/i.test(attachment.id) ? <NativeAttachmentPreview attachmentId={attachment.id} name={attachment.name} /> : null}
    </div>
  );
}
