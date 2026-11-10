import {
  evaluateComposerInput,
  type ComposerInputPolicyOptions,
  type ComposerInputThresholdResult,
} from "./composer-input-policy";

/**
 * A paste assessment is renderer evidence only. It deliberately does not
 * mint an attachment ID or claim that clipboard bytes were durably stored.
 * The native clipboard-to-file bridge must provide that authority before a
 * converted paste can be sent as an attachment.
 */
export interface ComposerPasteAssessment {
  readonly sourceText: string;
  readonly richText: string | null;
  readonly input: ComposerInputThresholdResult;
  readonly recommendedDisposition: "inline" | "convert_to_file";
  readonly fallbackDisposition: "inline" | "inline_with_warning";
}

export interface ComposerPasteFileProjection {
  /** Renderer-only name suggestion; no file is created by this projection. */
  readonly suggestedName: string;
  /** The fallback payload is deliberately plain text even when HTML was present. */
  readonly mediaType: "text/plain";
  readonly extension: "txt";
  /** Deterministic renderer hash, not a native integrity/content hash receipt. */
  readonly previewHash: string;
  readonly sourceText: string;
  readonly richClipboardDetected: boolean;
  readonly metrics: ComposerInputThresholdResult["metrics"];
}

export function assessComposerPaste(
  sourceText: string,
  richText: string | null = null,
  options: Omit<ComposerInputPolicyOptions, "mode"> = {},
): ComposerPasteAssessment {
  const input = evaluateComposerInput(sourceText, {
    ...options,
    mode: "auto",
  });
  const large = input.shouldConvertToFile;
  return Object.freeze({
    sourceText,
    richText,
    input,
    recommendedDisposition: large ? "convert_to_file" : "inline",
    // Until native clipboard ingestion exists, retaining the exact text in
    // the editor is the only truthful reversible fallback.
    fallbackDisposition: large ? "inline_with_warning" : "inline",
  });
}

function slugifyPasteHeading(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[`*_~[\]{}()<>]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 48)
    .replace(/-+$/g, "");
  return normalized || "pasted-content";
}

function stablePreviewHash(value: string): string {
  // FNV-1a is intentionally labelled as a preview hash. A native ingestion
  // receipt must provide a cryptographic content hash before file lineage can
  // be treated as authoritative.
  let hash = 0x811c9dc5;
  for (const codePoint of value) {
    hash ^= codePoint.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Projects a threshold-crossing paste into a file-like renderer preview. It
 * never allocates an attachment ID, writes a file, or changes dispatch state.
 */
export function projectComposerPasteFile(
  assessment: ComposerPasteAssessment,
): ComposerPasteFileProjection {
  const heading = assessment.sourceText.match(/^\s{0,3}#\s+(.+)$/m)?.[1]?.trim();
  return Object.freeze({
    suggestedName: `${slugifyPasteHeading(heading ?? "pasted-content")}.txt`,
    mediaType: "text/plain",
    extension: "txt",
    previewHash: stablePreviewHash(assessment.sourceText),
    sourceText: assessment.sourceText,
    richClipboardDetected: assessment.richText !== null,
    metrics: assessment.input.metrics,
  });
}

export function composerPastePreviewExcerpt(
  sourceText: string,
  maxCharacters = 640,
): string {
  if (sourceText.length <= maxCharacters) return sourceText;
  return `${sourceText.slice(0, Math.max(1, maxCharacters - 1))}…`;
}

/**
 * Browser-only download helper for the visible text fallback. Returning false
 * means the browser could not create a download; no native file receipt is
 * implied either way.
 */
export function downloadComposerPastePreview(
  projection: ComposerPasteFileProjection,
): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined") return false;
  const createObjectUrl = URL.createObjectURL;
  if (typeof createObjectUrl !== "function") return false;
  const revokeObjectUrl = URL.revokeObjectURL;
  const anchor = document.createElement("a");
  const url = createObjectUrl.call(URL, new Blob([projection.sourceText], { type: projection.mediaType }));
  anchor.href = url;
  anchor.download = projection.suggestedName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof revokeObjectUrl === "function") revokeObjectUrl.call(URL, url);
  return true;
}

const reasonLabels: Readonly<Record<ComposerInputThresholdResult["triggerReasons"][number], string>> = {
  characters: "character limit",
  estimated_tokens: "estimated-token limit",
  bytes: "UTF-8 byte limit",
  lines: "line limit",
  responsiveness: "renderer responsiveness",
};

export function composerPasteReasonLabels(
  assessment: ComposerPasteAssessment,
): readonly string[] {
  return Object.freeze(
    assessment.input.triggerReasons.map((reason) => reasonLabels[reason]),
  );
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Compact, user-facing evidence for a threshold decision. It intentionally
 * says "estimated" for tokens because provider tokenizers remain authoritative.
 */
export function formatComposerPasteMetrics(
  assessment: ComposerPasteAssessment,
): string {
  const { metrics } = assessment.input;
  return `${formatCount(metrics.characterCount)} characters · ${formatCount(metrics.byteCount)} bytes · ${formatCount(metrics.lineCount)} lines · ~${formatCount(metrics.estimatedTokenCount)} tokens`;
}

export function formatComposerPasteNotice(
  assessment: ComposerPasteAssessment,
): string {
  if (assessment.recommendedDisposition === "inline") return "";
  const reasons = composerPasteReasonLabels(assessment).join(", ");
  const richTextNote = assessment.richText !== null
    ? " Rich clipboard formatting was detected; only plain text is inserted in this fallback."
    : "";
  return `Large paste detected (${reasons}). Native paste-to-file conversion is not available in this build, so the exact plain text was kept inline. ${formatComposerPasteMetrics(assessment)}.${richTextNote}`;
}

export function insertTextAtSelection(
  value: string,
  insertedText: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; cursor: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const nextValue = `${value.slice(0, start)}${insertedText}${value.slice(end)}`;
  return Object.freeze({
    value: nextValue,
    cursor: start + insertedText.length,
  });
}
