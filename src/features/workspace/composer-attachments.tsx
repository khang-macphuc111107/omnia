import {
  AlertTriangle,
  Check,
  Eye,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";

import type { AttachmentView } from "./types";
import { ComposerFileTypeIcon } from "./ai-panel-composer";
import "../../styles/review-composer.css";

export type ComposerAttachmentKind = AttachmentView["kind"];

export type ComposerAttachmentState =
  | "queued"
  | "reading"
  | "hashing"
  | "storing"
  | "extracting"
  | "ready"
  | "preview"
  | "warning"
  | "failed";

export interface ComposerAttachmentItem {
  id: string;
  name: string;
  kind: ComposerAttachmentKind;
  /**
   * MIME metadata is optional because browser previews can only infer a
   * best-effort value. Native records remain the authoritative source when
   * they are hydrated through the attachment catalog.
   */
  mediaType?: string;
  sizeLabel: string;
  state: ComposerAttachmentState;
  statusDetail?: string;
  previewUrl?: string;
  previewType?: "image" | "video";
  /** Included only when an actual source selection supplies line metadata. */
  lineRange?: string;
}

export interface ComposerAttachmentSummary {
  total: number;
  ready: number;
  processing: number;
  preview: number;
  warning: number;
  failed: number;
  blocksSubmission: boolean;
}

interface ComposerAttachmentTrayProps {
  attachments: readonly ComposerAttachmentItem[];
  onRemove: (attachmentId: string) => void;
  onRetry?: (attachmentId: string) => void;
  disabled?: boolean;
  boundaryMessage?: string | undefined;
}

const stateMetadata: Readonly<
  Record<
    ComposerAttachmentState,
    { label: string; fallbackDetail: string; tone: "neutral" | "progress" | "success" | "warning" | "danger" }
  >
> = {
  queued: {
    label: "Queued",
    fallbackDetail: "Waiting for native ingestion",
    tone: "neutral",
  },
  reading: {
    label: "Reading",
    fallbackDetail: "Reading through the native file boundary",
    tone: "progress",
  },
  hashing: {
    label: "Verifying",
    fallbackDetail: "Computing the content fingerprint",
    tone: "progress",
  },
  storing: {
    label: "Saving locally",
    fallbackDetail: "Writing a content-addressed local copy",
    tone: "progress",
  },
  extracting: {
    label: "Extracting",
    fallbackDetail: "Preparing searchable local content",
    tone: "progress",
  },
  ready: {
    label: "Ready",
    fallbackDetail: "Stored locally and ready for this message",
    tone: "success",
  },
  preview: {
    label: "Preview only",
    fallbackDetail: "Available only in this browser session; not stored or sent",
    tone: "warning",
  },
  warning: {
    label: "Needs review",
    fallbackDetail: "Review this attachment before sending",
    tone: "warning",
  },
  failed: {
    label: "Failed",
    fallbackDetail: "The attachment could not be prepared",
    tone: "danger",
  },
};

const processingStates = new Set<ComposerAttachmentState>([
  "queued",
  "reading",
  "hashing",
  "storing",
  "extracting",
]);

export function composerAttachmentFromView(attachment: AttachmentView): ComposerAttachmentItem {
  const state: ComposerAttachmentState =
    attachment.extractionStatus === "pending"
      ? "queued"
      : attachment.extractionStatus === "running"
        ? "extracting"
        : attachment.extractionStatus === "complete"
          ? "ready"
          : attachment.extractionStatus === "skipped"
            ? "warning"
            : attachment.extractionStatus === "failed"
              ? "failed"
              : attachment.state === "processing"
                ? "queued"
                : attachment.state;

  return {
    id: attachment.id,
    name: attachment.name,
    kind: attachment.kind,
    ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
    sizeLabel: attachment.size,
    state,
  };
}

function AttachmentStateIcon({ state }: { state: ComposerAttachmentState }) {
  if (processingStates.has(state)) {
    return <LoaderCircle className="composer-attachment__spinner" size={12} aria-hidden="true" />;
  }
  if (state === "ready") return <Check size={12} aria-hidden="true" />;
  if (state === "preview") return <Eye size={12} aria-hidden="true" />;
  return <AlertTriangle size={12} aria-hidden="true" />;
}

export function summarizeComposerAttachments(
  attachments: readonly ComposerAttachmentItem[],
): ComposerAttachmentSummary {
  const summary: ComposerAttachmentSummary = {
    total: attachments.length,
    ready: 0,
    processing: 0,
    preview: 0,
    warning: 0,
    failed: 0,
    blocksSubmission: false,
  };

  for (const attachment of attachments) {
    if (attachment.state === "ready") summary.ready += 1;
    else if (attachment.state === "preview") summary.preview += 1;
    else if (attachment.state === "warning") summary.warning += 1;
    else if (attachment.state === "failed") summary.failed += 1;
    else summary.processing += 1;
  }

  summary.blocksSubmission = summary.processing > 0 || summary.preview > 0 || summary.warning > 0 || summary.failed > 0;
  return summary;
}

export function composerAttachmentBlockReason(summary: ComposerAttachmentSummary): string | null {
  if (!summary.blocksSubmission) return null;
  if (summary.processing > 0) {
    return summary.processing === 1
      ? "Wait for the attachment to finish processing before sending."
      : `Wait for ${summary.processing} attachments to finish processing before sending.`;
  }
  if (summary.failed > 0) {
    return summary.failed === 1
      ? "Remove or retry the failed attachment before sending."
      : `Remove or retry the ${summary.failed} failed attachments before sending.`;
  }
  if (summary.preview > 0) {
    return summary.preview === 1
      ? "This browser-preview file is not stored or uploadable. Remove it to send a text-only message."
      : `These ${summary.preview} browser-preview files are not stored or uploadable. Remove them to send a text-only message.`;
  }
  return summary.warning === 1
    ? "Review or remove the attachment warning before sending."
    : `Review or remove the ${summary.warning} attachment warnings before sending.`;
}

export function ComposerAttachmentTray({
  attachments,
  onRemove,
  onRetry,
  disabled = false,
  boundaryMessage,
}: ComposerAttachmentTrayProps) {
  if (attachments.length === 0) return null;

  const summary = summarizeComposerAttachments(attachments);
  const statusCopy = composerAttachmentBlockReason(summary);

  return (
    <div className="composer-attachment-tray composer-attachment-tray--compact" aria-label="Attachments for the next message">
      <ul className="composer-attachment-list">
        {attachments.map((attachment) => {
          const metadata = stateMetadata[attachment.state];
          const detail = attachment.statusDetail ?? metadata.fallbackDetail;
          const filenameMatch = /^(.*?)(:\d+(?:[–-]\d+)?)$/.exec(attachment.name);
          const filename = filenameMatch?.[1] ?? attachment.name;
          const lineRange = attachment.lineRange ?? filenameMatch?.[2];
          return (
            <li
              className={`composer-attachment composer-attachment--${metadata.tone}${attachment.previewUrl ? " composer-attachment--has-preview" : ""}`}
              key={attachment.id}
              aria-label={`${attachment.name}, ${attachment.sizeLabel}, ${metadata.label}. ${detail}`}
            >
              <span className="composer-attachment__kind">
                <ComposerFileTypeIcon name={filename} kind={attachment.kind} />
              </span>
              <span className="composer-attachment__body">
                {attachment.previewUrl ? (
                  <details className="review-composer-attachment-preview">
                    <summary title={attachment.name}>{filename}</summary>
                    <span className="review-composer-attachment-preview__content">
                      {attachment.previewType === "image" ? <img src={attachment.previewUrl} alt={`Preview of ${attachment.name}`} /> : <video src={attachment.previewUrl} aria-label={`Preview of ${attachment.name}`} preload="metadata" controls />}
                    </span>
                  </details>
                ) : <strong title={attachment.name}>{filename}</strong>}
                {lineRange ? <span className="review-composer-chip__lines">{lineRange.startsWith(":") ? lineRange : `:${lineRange}`}</span> : null}
                <span className={attachment.state === "ready" ? "review-composer-sr-only" : "composer-attachment__state"} title={detail}>
                    <AttachmentStateIcon state={attachment.state} />
                    {metadata.label}
                </span>
              </span>
              <span className="composer-attachment__actions">
                {attachment.state === "failed" && onRetry ? (
                  <button
                    type="button"
                    onClick={() => onRetry(attachment.id)}
                    disabled={disabled}
                    aria-label={`Retry ${attachment.name}`}
                    title="Retry attachment ingestion"
                  >
                    <RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => onRemove(attachment.id)}
                  disabled={disabled}
                  aria-label={`Remove ${attachment.name}`}
                  title="Remove from the next message"
                >
                  <X size={13} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {statusCopy ? <p className="composer-attachment-tray__boundary" role="status" aria-live="polite">{boundaryMessage ?? statusCopy}</p> : null}
    </div>
  );
}
