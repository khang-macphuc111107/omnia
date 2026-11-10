import { vi } from "vitest";
import type { NativeProjectFilePointer, NativeProjectFilePointerReceipt, RunWorkspaceRetrievalResult, WorkspaceGrantRecord, WorkspaceIndexSnapshot, WorkspaceRetrievalResult } from "@/lib/desktop";
import type { ProjectContextService } from "../context-service";

export const CONTENT_HASH = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
export const PROJECT = "project-a";
export const SESSION = "session-a";
export const GRANT = `workspace_${"a".repeat(32)}`;
export const preparedRun = { runId: "run-a", attemptId: "attempt-a", frozenProviderInputId: "input-a" };
export const pointer = (overrides: Partial<NativeProjectFilePointer> = {}): NativeProjectFilePointer => ({
  id: "pointer-a", projectId: PROJECT, sourcePath: "C:\\approved\\hello.txt", displayName: "hello.txt",
  sourceIdentitySha256: "b".repeat(64), contentSha256: CONTENT_HASH, byteSize: 5, sourceExists: true,
  sourceUpdatedAtMs: 1, snapshotUpdatedAtMs: 2, revision: 1, ...overrides,
});
export const receipt = (overrides: Partial<NativeProjectFilePointerReceipt> = {}): NativeProjectFilePointerReceipt => ({
  id: "receipt-a", pointerId: "pointer-a", projectId: PROJECT, revision: 1, outcome: "imported",
  watcherVersion: "native-file-identity-poll-v1", sourceIdentitySha256: "b".repeat(64), contentSha256: CONTENT_HASH,
  sourceExists: true, renamed: false, contentChanged: false, scannedEntries: 0, observedAtMs: 2, ...overrides,
});
export const grant = (overrides: Partial<WorkspaceGrantRecord> = {}): WorkspaceGrantRecord => ({
  id: GRANT, projectId: PROJECT, displayPath: "C:\\approved", displayName: "approved", readOnly: true,
  createdAtMs: 1, updatedAtMs: 1, revokedAtMs: null, ...overrides,
});
export const indexSnapshot = (): WorkspaceIndexSnapshot => ({
  snapshotId: "index-a", snapshotSha256: "c".repeat(64), indexerVersion: "workspace-text-v1", grantId: GRANT, projectId: PROJECT,
  startedAtMs: 10, completedAtMs: 20, truncated: false, hasErrors: false, skipReportTruncated: false,
  stats: { scannedEntries: 2, filesSeen: 1, directoriesSeen: 1, indexedFiles: 1, indexedChunks: 1,
    discoveredFileBytes: 5, indexedFileBytes: 5, indexedTokenEstimate: 2, skippedPaths: 0, reportedSkips: 0 },
  sources: [{ sourceId: "source-a", versionId: "version-a", grantId: GRANT, projectId: PROJECT, relativePath: "hello.txt",
    mediaType: "text/plain", byteSize: 5, contentSha256: CONTENT_HASH, chunkCount: 1, tokenEstimate: 2, truncated: false, extractorVersion: "utf8-v1" }],
  chunks: [{ chunkId: "chunk-a", sourceId: "source-a", sourceVersionId: "version-a", grantId: GRANT, projectId: PROJECT,
    relativePath: "hello.txt", ordinal: 0, content: "hello", contentSha256: CONTENT_HASH, sourceContentSha256: CONTENT_HASH,
    startByte: 0, endByte: 5, startLine: 1, endLine: 1, tokenEstimate: 2, tokenEstimatorVersion: "utf8-bytes-div-3-v1" }], skipped: [],
});
export const retrieval = (): WorkspaceRetrievalResult => ({
  querySha256: CONTENT_HASH, scorerVersion: "workspace-lexical-mmr-v1", tokenBudget: 8_000, consumedTokens: 2,
  totalChunks: 1, matchedCandidates: 1, omissionReportTruncated: false,
  matches: [{ rank: 1, score: 0.8, reasons: ["query_terms", "diversity_selected"], chunk: indexSnapshot().chunks[0]! }], omissions: [],
});
export const runRetrieval = (): RunWorkspaceRetrievalResult => ({
  retrieval: retrieval(), indexSnapshotId: "run-index-a", indexSnapshotSha256: "d".repeat(64), indexTruncated: false,
  indexHasErrors: false, indexStats: indexSnapshot().stats, providerInputAdmission: "not_admitted",
  journalEvent: { schemaVersion: 1, id: "event-a", ...preparedRun, journalEpoch: "epoch-a", sequence: 1,
    eventType: "context.retrieval_receipt", source: "native", visibility: "internal", sensitivity: "metadata",
    payload: {}, occurredAtMs: 30, committedAtMs: 31 },
});
export const contextService = (available = true): ProjectContextService => ({
  available, initialize: vi.fn().mockResolvedValue(undefined),
  pickFiles: vi.fn().mockResolvedValue([{ pointer: pointer(), receipt: receipt() }]),
  listPointers: vi.fn().mockResolvedValue([pointer()]),
  refreshPointer: vi.fn().mockResolvedValue({ pointer: pointer({ revision: 2, sourceExists: false }), receipt: receipt({ id: "receipt-b", revision: 2, outcome: "source_missing", sourceExists: false }) }),
  readPointer: vi.fn().mockResolvedValue({ pointerId: "pointer-a", revision: 1, contentSha256: CONTENT_HASH, byteSize: 5, encoding: "base64", content: "aGVsbG8=" }),
  listPointerReceipts: vi.fn().mockResolvedValue([receipt()]),
  pickFolder: vi.fn().mockResolvedValue(grant()), listGrants: vi.fn().mockResolvedValue([grant()]),
  buildIndex: vi.fn().mockResolvedValue(indexSnapshot()), retrieve: vi.fn().mockResolvedValue(retrieval()),
  retrieveForRun: vi.fn().mockResolvedValue(runRetrieval()),
});
export function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
