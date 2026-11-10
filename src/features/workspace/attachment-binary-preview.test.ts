import { describe, expect, it } from "vitest";

import { createAttachmentBinaryPreview } from "./attachment-binary-preview";
import { sha256Hex } from "@/domain/omnia-official-harness-adapters";

const id = "attachment_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const bytes = Uint8Array.from([0x00, 0x41, 0x42, 0xff]);
const base64 = "AEFC/w==";

describe("native attachment binary preview", () => {
  it("validates authenticated bytes and keeps non-media bytes inert", () => {
    const preview = createAttachmentBinaryPreview({
      id,
      mediaType: "application/octet-stream",
      byteSize: bytes.length,
      contentSha256: sha256Hex(bytes),
      dataBase64: base64,
    }, id);

    expect(preview.mediaUrl).toBeNull();
    expect(preview.hex).toContain("00000000");
    expect(preview.text).toBeNull();
  });

  it("creates a data URL only for the explicit media allowlist", () => {
    const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const imageBase64 = "iVBORw==";
    const preview = createAttachmentBinaryPreview({
      id,
      mediaType: "image/png",
      byteSize: image.length,
      contentSha256: sha256Hex(image),
      dataBase64: imageBase64,
    }, id);
    expect(preview.mediaUrl).toBe(`data:image/png;base64,${imageBase64}`);
    expect(preview.mediaKind).toBe("image");
  });

  it("rejects unknown fields, hash drift, and oversized receipts", () => {
    const valid = {
      id,
      mediaType: "application/octet-stream",
      byteSize: bytes.length,
      contentSha256: sha256Hex(bytes),
      dataBase64: base64,
    };
    expect(() => createAttachmentBinaryPreview({ ...valid, nonce: "secret" }, id)).toThrow(/unknown field/i);
    expect(() => createAttachmentBinaryPreview({ ...valid, contentSha256: "0".repeat(64) }, id)).toThrow(/hash/i);
    expect(() => createAttachmentBinaryPreview({ ...valid, byteSize: 16 * 1024 * 1024 + 1 }, id)).toThrow(/limit/i);
  });
});
