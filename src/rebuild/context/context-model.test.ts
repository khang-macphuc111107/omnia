import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeIndex, decodePointerBody, decodePointerReceipts, decodeRetrieval, sha256, validQuery } from "./context-model";
import { CONTENT_HASH, GRANT, PROJECT, indexSnapshot, pointer, receipt, retrieval } from "./__tests__/context-fixtures";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
const body = { pointerId: "pointer-a", revision: 1, contentSha256: CONTENT_HASH, byteSize: 5, encoding: "base64", content: "aGVsbG8=" };

describe("bounded native context receipt validation", () => {
  it("rejects oversized, malformed and wrong identity retained bodies", async () => {
    await expect(decodePointerBody({ ...body, pointerId: "other-pointer" }, pointer())).rejects.toMatchObject({ code: "scope_mismatch" });
    await expect(decodePointerBody({ ...body, content: "aGVsbG8@" }, pointer())).rejects.toMatchObject({ code: "snapshot_integrity" });
    await expect(decodePointerBody({ ...body, contentSha256: "a".repeat(64) }, pointer())).rejects.toMatchObject({ code: "snapshot_integrity" });
    const huge = pointer({ byteSize: 8 * 1024 * 1024 + 1 });
    await expect(decodePointerBody({ ...body, byteSize: huge.byteSize }, huge)).rejects.toMatchObject({ code: "invalid_native_response" });
  });

  it("verifies binary/non-UTF8 bodies without inventing text and bounds long text display", async () => {
    const binaryHash = await sha256(new Uint8Array([0, 1, 2]));
    const binary = await decodePointerBody({ ...body, content: "AAEC", byteSize: 3, contentSha256: binaryHash }, pointer({ byteSize: 3, contentSha256: binaryHash }));
    expect(binary.text).toBeNull(); expect(binary.textUnavailable).toMatch(/Binary snapshot verified/);
    const invalidHash = await sha256(new Uint8Array([255]));
    const invalid = await decodePointerBody({ ...body, content: "/w==", byteSize: 1, contentSha256: invalidHash }, pointer({ byteSize: 1, contentSha256: invalidHash }));
    expect(invalid.text).toBeNull(); expect(invalid.textUnavailable).toMatch(/not UTF-8/);
    const content = "x".repeat(128_001); const fullHash = await sha256(new TextEncoder().encode(content));
    const long = await decodePointerBody({ ...body, content: btoa(content), byteSize: content.length, contentSha256: fullHash }, pointer({ byteSize: content.length, contentSha256: fullHash }));
    expect(long.text).toHaveLength(128_000); expect(long.truncated).toBe(true);
  });

  it("rejects cross-pointer receipts and stale index provenance, while preserving explicit skipped formats", () => {
    expect(() => decodePointerReceipts([receipt({ pointerId: "other" })], pointer())).toThrow(/did not match/);
    const index = indexSnapshot(); index.chunks[0]!.sourceVersionId = "stale-version"; expect(() => decodeIndex(index, PROJECT, GRANT)).toThrow(/provenance/);
    const omissions = indexSnapshot(); omissions.skipped = [{ relativePath: "manual.pdf", reason: "extractor_required" }, { relativePath: "private.env", reason: "sensitive_path" }];
    omissions.stats.skippedPaths = 2; omissions.stats.reportedSkips = 2;
    expect(decodeIndex(omissions, PROJECT, GRANT).skipped.map((skip) => skip.reason)).toEqual(["extractor_required", "sensitive_path"]);
    const traversal = indexSnapshot(); traversal.sources[0]!.relativePath = "../outside.txt";
    expect(() => decodeIndex(traversal, PROJECT, GRANT)).toThrow(/safe relative path/);
  });

  it("rejects query mismatch, citation byte/hash mismatch and token inconsistencies", async () => {
    const wrongQuery = retrieval(); wrongQuery.querySha256 = "a".repeat(64);
    await expect(decodeRetrieval(wrongQuery, PROJECT, GRANT, "hello")).rejects.toThrow(/query hash/);
    const badBytes = retrieval(); badBytes.matches[0]!.chunk.endByte = 6;
    await expect(decodeRetrieval(badBytes, PROJECT, GRANT, "hello")).rejects.toThrow(/citation range/);
    const badHash = retrieval(); badHash.matches[0]!.chunk.contentSha256 = "a".repeat(64);
    await expect(decodeRetrieval(badHash, PROJECT, GRANT, "hello")).rejects.toThrow(/SHA-256/);
    const badTokens = retrieval(); badTokens.consumedTokens = 3;
    await expect(decodeRetrieval(badTokens, PROJECT, GRANT, "hello")).rejects.toThrow(/token receipt/);
  });

  it("accepts only bounded searchable UTF-8 queries", () => {
    expect(validQuery("  hello  ")).toBe("hello"); expect(validQuery("Tiếng Việt")).toBe("Tiếng Việt");
    expect(() => validQuery("!!!")).toThrow(/letter or number/); expect(() => validQuery("🔥".repeat(2_049))).toThrow(/8,192/);
  });

  it("verifies a multi-megabyte retained snapshot without an unbounded text render", async () => {
    const content = "x".repeat(2 * 1024 * 1024); const fullHash = await sha256(new TextEncoder().encode(content));
    const verified = await decodePointerBody({ ...body, content: btoa(content), byteSize: content.length, contentSha256: fullHash }, pointer({ byteSize: content.length, contentSha256: fullHash }));
    expect(verified.text).toHaveLength(128_000); expect(verified.truncated).toBe(true);
  });

  it("accepts native scan-limit diagnostic counts beyond the number of scanned entries", () => {
    const index = indexSnapshot(); index.stats.scannedEntries = 20_000; index.stats.skippedPaths = 20_001;
    index.sources = []; index.chunks = []; index.stats.indexedFiles = 0; index.stats.indexedChunks = 0;
    index.truncated = true; index.skipReportTruncated = true; index.skipped = [{ relativePath: ".", reason: "max_scanned_entries_reached" }]; index.stats.reportedSkips = 1;
    expect(decodeIndex(index, PROJECT, GRANT).stats.skippedPaths).toBe(20_001);
  });
});
