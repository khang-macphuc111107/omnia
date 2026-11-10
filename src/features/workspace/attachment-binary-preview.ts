import { sha256Hex } from "@/domain/omnia-official-harness-adapters";
import type { AttachmentBinaryPreviewRecord } from "@/lib/desktop";

export const ATTACHMENT_BINARY_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
export const ATTACHMENT_BINARY_PREVIEW_DEFAULT_BYTES = 4 * 1024 * 1024;
const MAX_HEX_BYTES = 4 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MEDIA_TYPES = new Map<string, "image" | "audio" | "video">([
  ["image/png", "image"], ["image/jpeg", "image"], ["image/gif", "image"],
  ["image/webp", "image"], ["image/avif", "image"], ["image/bmp", "image"],
  ["audio/wav", "audio"], ["audio/x-wav", "audio"], ["audio/mpeg", "audio"],
  ["audio/ogg", "audio"], ["audio/flac", "audio"], ["audio/aac", "audio"],
  ["audio/mp4", "audio"], ["audio/webm", "audio"],
  ["video/mp4", "video"], ["video/webm", "video"], ["video/ogg", "video"],
]);

export interface AttachmentBinaryPreview {
  readonly attachmentId: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly contentSha256: string;
  readonly mediaKind: "image" | "audio" | "video" | null;
  readonly mediaUrl: string | null;
  readonly hex: string;
  readonly hexTruncated: boolean;
  readonly text: string | null;
  readonly textTruncated: boolean;
}

function invalid(message: string): never {
  throw new Error(`Attachment preview rejected: ${message}`);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatHex(bytes: Uint8Array): string {
  const rows: string[] = [];
  const visible = bytes.subarray(0, MAX_HEX_BYTES);
  for (let offset = 0; offset < visible.length; offset += 16) {
    const row = visible.subarray(offset, offset + 16);
    const hex = [...row].map((byte) => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47);
    const ascii = [...row].map((byte) => byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".").join("");
    rows.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return rows.join("\n");
}

function decodeText(bytes: Uint8Array): string | null {
  const visible = bytes.subarray(0, MAX_TEXT_BYTES);
  // Binary controls make a misleading text view worse than no text view.
  if (visible.some((byte) => byte < 0x20 && ![0x09, 0x0a, 0x0c, 0x0d].includes(byte))) return null;
  for (let end = visible.length; end >= Math.max(0, visible.length - 3); end -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(visible.subarray(0, end));
    } catch {
      // A bounded preview can end in the middle of one UTF-8 code point. Only
      // trim that final code point when the complete file is larger.
      if (bytes.length <= MAX_TEXT_BYTES) return null;
    }
  }
  return null;
}

/**
 * Validates the native binary receipt again before rendering. Arbitrary
 * HTML/SVG/PDF/archive bytes remain inert text/hex; only a small media allowlist
 * can create a data URL. Password-protected formats require a separate decoder
 * and are never labelled decrypted by this projection.
 */
export function createAttachmentBinaryPreview(
  input: AttachmentBinaryPreviewRecord | unknown,
  expectedAttachmentId: string,
): AttachmentBinaryPreview {
  if (!plainObject(input)) invalid("receipt must be an object.");
  const allowed = new Set(["id", "mediaType", "byteSize", "contentSha256", "dataBase64"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) invalid("receipt has an unknown field.");
  if (typeof input.id !== "string" || input.id !== expectedAttachmentId || !/^attachment_[a-f0-9]{32}$/i.test(input.id)) invalid("attachment identity changed.");
  if (typeof input.mediaType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(input.mediaType) || input.mediaType.length > 255) invalid("media type is not canonical.");
  if (typeof input.byteSize !== "number" || !Number.isSafeInteger(input.byteSize) || input.byteSize < 0 || input.byteSize > ATTACHMENT_BINARY_PREVIEW_MAX_BYTES) invalid("byte size exceeds the preview limit.");
  if (typeof input.contentSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(input.contentSha256)) invalid("content hash is invalid.");
  if (typeof input.dataBase64 !== "string" || input.dataBase64.length !== Math.ceil(input.byteSize / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.dataBase64)) invalid("base64 framing is invalid.");
  let decoded: string;
  try { decoded = atob(input.dataBase64); } catch { invalid("base64 decoding failed."); }
  if (decoded.length !== input.byteSize || btoa(decoded) !== input.dataBase64) invalid("byte count or base64 canonical form changed.");
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (sha256Hex(bytes) !== input.contentSha256.toLowerCase()) invalid("content hash does not match the authenticated bytes.");
  const mediaKind = MEDIA_TYPES.get(input.mediaType) ?? null;
  return Object.freeze({
    attachmentId: input.id,
    mediaType: input.mediaType,
    byteSize: input.byteSize,
    contentSha256: input.contentSha256.toLowerCase(),
    mediaKind,
    mediaUrl: mediaKind ? `data:${input.mediaType};base64,${input.dataBase64}` : null,
    hex: formatHex(bytes),
    hexTruncated: bytes.length > MAX_HEX_BYTES,
    text: mediaKind ? null : decodeText(bytes),
    textTruncated: bytes.length > MAX_TEXT_BYTES,
  });
}
