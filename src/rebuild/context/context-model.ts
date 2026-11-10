import type { IndexedWorkspaceChunk, IndexedWorkspaceSource, NativeProjectFilePointer, NativeProjectFilePointerMutation, NativeProjectFilePointerReceipt, WorkspaceGrantRecord, WorkspaceIndexOptions, WorkspaceIndexSnapshot, WorkspaceIndexStats, WorkspaceRetrievalOptions, WorkspaceRetrievalResult, WorkspaceSkipReason } from "@/lib/desktop";

export const CONTEXT_INDEX_OPTIONS: Readonly<WorkspaceIndexOptions> = Object.freeze({ maxScannedEntries: 20_000, maxFiles: 2_000, maxTotalBytes: 32 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024, maxChunks: 8_000, maxReportedSkips: 200, maxDepth: 16, chunkTargetBytes: 4_096, chunkOverlapBytes: 256, includeUnknownText: false });
export const CONTEXT_RETRIEVAL_OPTIONS: Readonly<WorkspaceRetrievalOptions> = Object.freeze({ tokenBudget: 8_000, maxResults: 12, maxResultsPerSource: 3, minimumScore: 0.15, diversityLambda: 0.82, maxReportedOmissions: 200 });
export const SNAPSHOT_TEXT_LIMIT = 128_000;
const MAX_POINTER_BYTES = 64 * 1024 * 1024;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class ContextError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ContextError"; }
}
export interface ContextFailure { code: string; message: string }
export interface RetainedPointerBody { pointerId: string; revision: number; contentSha256: string; byteSize: number; text: string | null; truncated: boolean; textUnavailable: string | null }
export interface ProjectContextCitation {
  projectId: string; sessionId: string | null; grantId: string; indexSnapshotId: string; indexSnapshotSha256: string;
  chunkId: string; sourceId: string; sourceVersionId: string; relativePath: string; contentSha256: string;
  sourceContentSha256: string; startByte: number; endByte: number; startLine: number; endLine: number;
}

export function contextFailure(error: unknown): ContextFailure {
  if (error instanceof ContextError) return { code: error.code, message: error.message };
  const row = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof row.code === "string" && /^[a-z0-9_.:-]{1,128}$/i.test(row.code) ? row.code : "native_request_failed";
  const message = error instanceof Error ? error.message : typeof row.message === "string" ? row.message : "Native project context request failed. Reload the native receipts before trying again.";
  return { code, message: message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1_024) };
}
export const invalid = (message: string): never => { throw new ContextError("invalid_native_response", message); };
export const scopeMismatch = (): never => { throw new ContextError("scope_mismatch", "The native response did not match the selected project, grant or prepared run. Reload before continuing."); };
export function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Expected a native receipt object."); return value as Record<string, unknown>; }
export function text(value: unknown, limit = 512): string { if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) return invalid("Invalid text in native project context response."); return value; }
export function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER, minimum = 0): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid("Invalid number in native project context response."); return value; }
export function bool(value: unknown): boolean { if (typeof value !== "boolean") return invalid("Invalid flag in native project context response."); return value; }
export function hash(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) return invalid("Missing or invalid native SHA-256 receipt."); return value.toLowerCase(); }
function rows(value: unknown, maximum: number): unknown[] { if (!Array.isArray(value) || value.length > maximum) return invalid("Native project context response exceeded its bounded list size."); return value; }
function unique<T>(values: T[], key: (value: T) => string): T[] { const seen = new Set<string>(); for (const value of values) { const id = key(value); if (seen.has(id)) return invalid("Duplicate native identity in project context response."); seen.add(id); } return values; }
function expected(actual: unknown, wanted: string): void { if (actual !== wanted) scopeMismatch(); }
export function relativePath(value: unknown): string { const path = text(value, 8_192); if (/^[\\/]|^[a-z]:|[\u0000-\u001f<>:"|?*]/i.test(path) || path.split(/[\\/]/).some((part) => part === ".." || part === "." || !part)) return invalid("A citation path was not a safe relative path."); return path; }

export function decodePointer(value: unknown, projectId: string): NativeProjectFilePointer {
  const row = record(value); expected(row.projectId, projectId);
  return { id: text(row.id, 256), projectId, sourcePath: text(row.sourcePath, 32_768), displayName: text(row.displayName),
    sourceIdentitySha256: hash(row.sourceIdentitySha256), contentSha256: hash(row.contentSha256), byteSize: integer(row.byteSize, MAX_POINTER_BYTES),
    sourceExists: bool(row.sourceExists), sourceUpdatedAtMs: row.sourceUpdatedAtMs == null ? null : integer(row.sourceUpdatedAtMs),
    snapshotUpdatedAtMs: integer(row.snapshotUpdatedAtMs), revision: integer(row.revision, Number.MAX_SAFE_INTEGER, 1) };
}
export function decodePointers(value: unknown, projectId: string): NativeProjectFilePointer[] { return unique(rows(value, 1_000).map((row) => decodePointer(row, projectId)), (row) => row.id); }
export function decodePointerReceipt(value: unknown, projectId: string, pointerId: string): NativeProjectFilePointerReceipt {
  const row = record(value); expected(row.projectId, projectId); expected(row.pointerId, pointerId);
  const outcome = text(row.outcome, 32);
  if (!["imported", "updated", "renamed", "unchanged", "source_missing"].includes(outcome)) return invalid("Unknown native file synchronization outcome.");
  const sourceExists = bool(row.sourceExists);
  if ((outcome === "source_missing") !== !sourceExists) return invalid("Native source availability and receipt outcome disagree.");
  return { id: text(row.id, 256), projectId, pointerId, revision: integer(row.revision, Number.MAX_SAFE_INTEGER, 1),
    outcome: outcome as NativeProjectFilePointerReceipt["outcome"], watcherVersion: text(row.watcherVersion, 128),
    sourceIdentitySha256: hash(row.sourceIdentitySha256), contentSha256: hash(row.contentSha256), sourceExists,
    renamed: bool(row.renamed), contentChanged: bool(row.contentChanged), scannedEntries: integer(row.scannedEntries, 10_000), observedAtMs: integer(row.observedAtMs) };
}
export function decodePointerReceipts(value: unknown, pointer: NativeProjectFilePointer): NativeProjectFilePointerReceipt[] {
  return unique(rows(value, 10_000).map((row) => decodePointerReceipt(row, pointer.projectId, pointer.id)), (row) => row.id)
    .sort((left, right) => right.revision - left.revision);
}
export function decodeMutation(value: unknown, projectId: string, previous?: NativeProjectFilePointer): NativeProjectFilePointerMutation {
  const row = record(value); const pointer = decodePointer(row.pointer, projectId); const receipt = decodePointerReceipt(row.receipt, projectId, pointer.id);
  if (receipt.revision !== pointer.revision || receipt.contentSha256 !== pointer.contentSha256 || receipt.sourceIdentitySha256 !== pointer.sourceIdentitySha256 || receipt.sourceExists !== pointer.sourceExists) return invalid("Native pointer mutation and receipt do not agree.");
  if (previous && (pointer.id !== previous.id || pointer.sourceIdentitySha256 !== previous.sourceIdentitySha256)) scopeMismatch();
  if (previous && pointer.revision <= previous.revision) throw new ContextError("stale_revision", "File synchronization returned a stale revision. Reload the pointer list.");
  return { pointer, receipt };
}
export function decodeMutations(value: unknown, projectId: string): NativeProjectFilePointerMutation[] { return unique(rows(value, 64).map((row) => decodeMutation(row, projectId)), (row) => row.pointer.id); }

export function decodeGrant(value: unknown, projectId: string): WorkspaceGrantRecord {
  const row = record(value); expected(row.projectId, projectId);
  return { id: text(row.id, 256), projectId, displayPath: text(row.displayPath, 32_768), displayName: text(row.displayName), readOnly: bool(row.readOnly),
    createdAtMs: integer(row.createdAtMs), updatedAtMs: integer(row.updatedAtMs), revokedAtMs: row.revokedAtMs == null ? null : integer(row.revokedAtMs) };
}
export function decodeGrants(value: unknown, projectId: string): WorkspaceGrantRecord[] { return unique(rows(value, 1_000).map((row) => decodeGrant(row, projectId)), (row) => row.id).filter((row) => row.revokedAtMs === null); }

export async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new ContextError("integrity_unavailable", "SHA-256 verification is unavailable. The snapshot was not displayed.");
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function decodePointerBody(value: unknown, pointer: NativeProjectFilePointer): Promise<RetainedPointerBody> {
  const row = record(value); expected(row.pointerId, pointer.id);
  if (row.revision !== pointer.revision) throw new ContextError("stale_revision", "The retained snapshot revision changed. Reload the pointer before reading it.");
  if (hash(row.contentSha256) !== pointer.contentSha256 || row.byteSize !== pointer.byteSize || row.encoding !== "base64") throw new ContextError("snapshot_integrity", "The retained snapshot metadata did not match its pointer receipt.");
  const size = integer(row.byteSize, MAX_BODY_BYTES);
  if (typeof row.content !== "string" || row.content.length > 4 * Math.ceil(MAX_BODY_BYTES / 3) || row.content.length !== 4 * Math.ceil(size / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.content)) throw new ContextError("snapshot_integrity", "The retained snapshot bytes were not valid bounded base64.");
  const raw = atob(row.content); const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
  if (bytes.length !== size || await sha256(bytes) !== pointer.contentSha256) throw new ContextError("snapshot_integrity", "The retained snapshot bytes did not match the native SHA-256 receipt.");
  let decoded: string | null = null; let textUnavailable: string | null = null;
  try {
    if (bytes.includes(0)) textUnavailable = "Binary snapshot verified. Text preview is unavailable; original bytes remain in native storage.";
    else decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { textUnavailable = "Snapshot verified. This encoding is not UTF-8, so text preview is unavailable."; }
  return { pointerId: pointer.id, revision: pointer.revision, contentSha256: pointer.contentSha256, byteSize: size,
    text: decoded?.slice(0, SNAPSHOT_TEXT_LIMIT) ?? null, truncated: (decoded?.length ?? 0) > SNAPSHOT_TEXT_LIMIT, textUnavailable };
}

export function decodeStats(value: unknown): WorkspaceIndexStats {
  const row = record(value);
  return { scannedEntries: integer(row.scannedEntries, 20_000), filesSeen: integer(row.filesSeen, 20_000), directoriesSeen: integer(row.directoriesSeen, 20_000),
    indexedFiles: integer(row.indexedFiles, 2_000), indexedChunks: integer(row.indexedChunks, 8_000), discoveredFileBytes: integer(row.discoveredFileBytes),
    indexedFileBytes: integer(row.indexedFileBytes, 32 * 1024 * 1024), indexedTokenEstimate: integer(row.indexedTokenEstimate),
    // Native diagnostic skips also include a scan-limit sentinel and unreadable directories.
    skippedPaths: integer(row.skippedPaths), reportedSkips: integer(row.reportedSkips, 200) };
}
function decodeSource(value: unknown, projectId: string, grantId: string): IndexedWorkspaceSource {
  const row = record(value); expected(row.projectId, projectId); expected(row.grantId, grantId);
  return { sourceId: text(row.sourceId, 256), versionId: text(row.versionId, 256), projectId, grantId, relativePath: relativePath(row.relativePath), mediaType: text(row.mediaType, 128),
    ...(row.language == null ? {} : { language: text(row.language, 128) }), ...(row.modifiedAtMs == null ? {} : { modifiedAtMs: integer(row.modifiedAtMs) }),
    byteSize: integer(row.byteSize, 2 * 1024 * 1024), contentSha256: hash(row.contentSha256), chunkCount: integer(row.chunkCount, 8_000),
    tokenEstimate: integer(row.tokenEstimate), truncated: bool(row.truncated), extractorVersion: text(row.extractorVersion, 128) };
}
export function decodeChunk(value: unknown, projectId: string, grantId: string): IndexedWorkspaceChunk {
  const row = record(value); expected(row.projectId, projectId); expected(row.grantId, grantId);
  const startByte = integer(row.startByte, 2 * 1024 * 1024); const endByte = integer(row.endByte, 2 * 1024 * 1024, startByte);
  const startLine = integer(row.startLine, Number.MAX_SAFE_INTEGER, 1); const endLine = integer(row.endLine, Number.MAX_SAFE_INTEGER, startLine);
  if (typeof row.content !== "string" || row.content.length > 2 * 1024 * 1024 || new TextEncoder().encode(row.content).length !== endByte - startByte) return invalid("Chunk bytes and citation range did not agree.");
  return { chunkId: text(row.chunkId, 256), sourceId: text(row.sourceId, 256), sourceVersionId: text(row.sourceVersionId, 256), projectId, grantId, relativePath: relativePath(row.relativePath),
    ordinal: integer(row.ordinal, 8_000), content: row.content, contentSha256: hash(row.contentSha256), sourceContentSha256: hash(row.sourceContentSha256),
    startByte, endByte, startLine, endLine, tokenEstimate: integer(row.tokenEstimate, 256_000), tokenEstimatorVersion: text(row.tokenEstimatorVersion, 128) };
}
const SKIP_REASONS = new Set(["ignored_path", "sensitive_path", "sensitive_content", "unsupported_type", "extractor_required", "reparse_point", "scope_violation", "permission_denied", "unreadable", "invalid_utf8", "binary_content", "empty_text", "file_too_large", "changed_during_read", "max_depth_reached", "max_scanned_entries_reached", "max_files_reached", "max_total_bytes_reached", "max_chunks_reached"]);
export function decodeIndex(value: unknown, projectId: string, grantId: string): WorkspaceIndexSnapshot {
  const row = record(value); expected(row.projectId, projectId); expected(row.grantId, grantId);
  const sources = unique(rows(row.sources, 2_000).map((source) => decodeSource(source, projectId, grantId)), (source) => source.sourceId);
  const chunks = unique(rows(row.chunks, 8_000).map((chunk) => decodeChunk(chunk, projectId, grantId)), (chunk) => chunk.chunkId);
  const bySource = new Map(sources.map((source) => [source.sourceId, source]));
  for (const chunk of chunks) {
    const source = bySource.get(chunk.sourceId);
    if (!source || chunk.sourceVersionId !== source.versionId || chunk.sourceContentSha256 !== source.contentSha256 || chunk.relativePath !== source.relativePath || chunk.endByte > source.byteSize) return invalid("Index chunk source/version provenance did not match.");
  }
  const stats = decodeStats(row.stats);
  if (stats.indexedChunks !== chunks.length || stats.indexedFiles !== sources.length) return invalid("Index source/chunk counts did not match the native receipt.");
  const skipped = rows(row.skipped, 200).map((entry) => { const item = record(entry); const reason = text(item.reason, 64); if (!SKIP_REASONS.has(reason)) return invalid("Unknown native index omission reason."); return { relativePath: text(item.relativePath, 8_192), reason: reason as WorkspaceSkipReason, ...(item.byteSize == null ? {} : { byteSize: integer(item.byteSize) }) }; });
  const startedAtMs = integer(row.startedAtMs); const completedAtMs = integer(row.completedAtMs, Number.MAX_SAFE_INTEGER, startedAtMs);
  return { snapshotId: text(row.snapshotId, 256), snapshotSha256: hash(row.snapshotSha256), indexerVersion: text(row.indexerVersion, 128), projectId, grantId,
    startedAtMs, completedAtMs, truncated: bool(row.truncated), hasErrors: bool(row.hasErrors), skipReportTruncated: bool(row.skipReportTruncated), stats, sources, chunks, skipped };
}
export function validQuery(value: string): string {
  const query = value.trim();
  if (!query || new TextEncoder().encode(query).length > 8_192 || !/[\p{L}\p{N}]/u.test(query) || /[\u0000\u007f]/.test(query)) throw new ContextError("invalid_query", "Enter a query with a letter or number, up to 8,192 UTF-8 bytes.");
  return query;
}
export async function decodeRetrieval(value: unknown, projectId: string, grantId: string, query: string, index?: WorkspaceIndexSnapshot): Promise<WorkspaceRetrievalResult> {
  const row = record(value); const querySha256 = hash(row.querySha256);
  if (querySha256 !== await sha256(new TextEncoder().encode(query))) return invalid("Retrieval query hash did not match this request.");
  const tokenBudget = integer(row.tokenBudget, 8_000, 1); const consumedTokens = integer(row.consumedTokens, tokenBudget);
  const seen = new Set<string>(); const perSource = new Map<string, number>();
  const matches = rows(row.matches, 12).map((entry, position) => {
    const item = record(entry); const chunk = decodeChunk(item.chunk, projectId, grantId); const rank = integer(item.rank, 12, 1);
    if (rank !== position + 1 || seen.has(chunk.chunkId) || typeof item.score !== "number" || !Number.isFinite(item.score) || item.score < 0) return invalid("Retrieval rank, score or chunk identity was invalid.");
    seen.add(chunk.chunkId); perSource.set(chunk.sourceId, (perSource.get(chunk.sourceId) ?? 0) + 1);
    if ((perSource.get(chunk.sourceId) ?? 0) > 3) return invalid("Retrieval exceeded the requested per-source limit.");
    const reasons = rows(item.reasons, 4).map((reason) => { if (!["query_terms", "exact_phrase", "path_match", "diversity_selected"].includes(String(reason))) return invalid("Unknown native retrieval reason."); return reason as "query_terms" | "exact_phrase" | "path_match" | "diversity_selected"; });
    if (index) { const original = index.chunks.find((candidate) => candidate.chunkId === chunk.chunkId); if (!original || JSON.stringify(original) !== JSON.stringify(chunk)) return invalid("Retrieval citation was not part of the selected index revision."); }
    return { rank, score: item.score, reasons, chunk };
  });
  if (matches.reduce((total, match) => total + match.chunk.tokenEstimate, 0) !== consumedTokens) return invalid("Retrieval token receipt did not match admitted chunks.");
  for (const match of matches) if (await sha256(new TextEncoder().encode(match.chunk.content)) !== match.chunk.contentSha256) return invalid("Retrieval citation content did not match its SHA-256 receipt.");
  const omissions = rows(row.omissions, 200).map((entry) => { const item = record(entry); const reason = text(item.reason, 32); if (!["no_query_match", "below_threshold", "duplicate_content", "source_limit", "token_budget", "max_results"].includes(reason)) return invalid("Unknown native retrieval omission reason."); return { chunkId: text(item.chunkId, 256), reason: reason as WorkspaceRetrievalResult["omissions"][number]["reason"] }; });
  return { querySha256, scorerVersion: text(row.scorerVersion, 128), tokenBudget, consumedTokens, totalChunks: integer(row.totalChunks, 8_000),
    matchedCandidates: integer(row.matchedCandidates, 8_000), omissionReportTruncated: bool(row.omissionReportTruncated), matches, omissions };
}
