import { assertDomain } from "./errors";
import type {
  AuthorizedCapturePlan,
  CaptureAssembly,
  CaptureSourceReceipt,
} from "./browser-capture";
import {
  assertIntegerInRange,
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";

/**
 * Native/renderer-neutral download orchestration contract.
 *
 * The manager is deliberately a broker-facing queue rather than a network
 * client. It stores only the source receipt IDs and hashes issued by the
 * authorized browser-capture broker; raw URLs, request headers, cookies and
 * response bytes never cross this boundary. Native code can use this state to
 * schedule bounded requests, persist checkpoints, and hand the final output
 * to the existing capture completion receipt contract.
 */
export const OMNIA_DOWNLOAD_MANAGER_SCHEMA_VERSION = 1 as const;

export type OmniaDownloadAssemblyKind = CaptureAssembly["kind"];
export type OmniaDownloadJobStatus =
  | "draft"
  | "queued"
  | "running"
  | "paused"
  | "assembling"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export type OmniaDownloadSourceStatus =
  | "pending"
  | "leased"
  | "downloading"
  | "received"
  | "failed"
  | "cancelled";

export type OmniaDownloadPriority = "low" | "normal" | "high" | "urgent";

export interface OmniaDownloadSource {
  readonly sourceId: string;
  readonly role: CaptureSourceReceipt["role"];
  readonly ordinal?: number;
  readonly expectedBytes?: number;
  readonly receivedBytes: number;
  readonly status: OmniaDownloadSourceStatus;
  readonly attempt: number;
  readonly leaseId?: string;
  readonly contentSha256?: string;
  readonly error?: string;
  readonly updatedAt: IsoTimestamp;
}

export interface OmniaDownloadOutput {
  readonly blobId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly contentSha256: string;
}

export interface OmniaDownloadJob {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly capturePlanId: string;
  readonly capturePlanSha256: string;
  readonly browserAttachmentId: string;
  readonly browserAttachmentEpoch: string;
  readonly assemblyKind: OmniaDownloadAssemblyKind;
  readonly outputFilename: string;
  readonly outputMediaType: string;
  readonly priority: OmniaDownloadPriority;
  readonly status: OmniaDownloadJobStatus;
  readonly maxConcurrentSources: number;
  readonly maxAttemptsPerSource: number;
  readonly sources: readonly OmniaDownloadSource[];
  readonly bytesTotal: number | null;
  readonly bytesReceived: number;
  readonly progress: number;
  readonly activeLeases: number;
  readonly attempt: number;
  readonly error?: string;
  readonly output?: OmniaDownloadOutput;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface CreateOmniaDownloadJobInput {
  readonly id: string;
  readonly capturePlan: AuthorizedCapturePlan;
  readonly capturePlanSha256: string;
  readonly outputFilename?: string;
  readonly outputMediaType?: string;
  readonly priority?: OmniaDownloadPriority;
  readonly maxConcurrentSources?: number;
  readonly maxAttemptsPerSource?: number;
  readonly now: IsoTimestamp;
}

export interface DownloadSourceLease {
  readonly sourceId: string;
  readonly leaseId: string;
  readonly attempt: number;
}

export interface LeaseDownloadSourcesResult {
  readonly job: OmniaDownloadJob;
  readonly leases: readonly DownloadSourceLease[];
}

export interface DownloadJobSummary {
  readonly sourceCount: number;
  readonly pendingCount: number;
  readonly activeCount: number;
  readonly receivedCount: number;
  readonly failedCount: number;
  readonly cancelledCount: number;
  readonly bytesTotal: number | null;
  readonly bytesReceived: number;
  readonly progress: number;
  readonly terminal: boolean;
}

const JOB_STATUSES: readonly OmniaDownloadJobStatus[] = [
  "draft",
  "queued",
  "running",
  "paused",
  "assembling",
  "verifying",
  "completed",
  "failed",
  "cancelled",
];
const SOURCE_STATUSES: readonly OmniaDownloadSourceStatus[] = [
  "pending",
  "leased",
  "downloading",
  "received",
  "failed",
  "cancelled",
];
const PRIORITIES: readonly OmniaDownloadPriority[] = ["low", "normal", "high", "urgent"];
const SOURCE_ROLES: readonly CaptureSourceReceipt["role"][] = [
  "primary",
  "range",
  "manifest",
  "initialization",
  "media-segment",
  "page",
  "tile",
];
const ASSEMBLY_KINDS: readonly OmniaDownloadAssemblyKind[] = [
  "single-response",
  "byte-range",
  "segmented-media",
  "paged-document",
];
const MAX_JOB_SOURCES = 10_000;
const MAX_ERROR_LENGTH = 512;
const DEFAULT_MAX_CONCURRENT_SOURCES = 4;
const DEFAULT_MAX_ATTEMPTS_PER_SOURCE = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function makeLeaseId(jobId: string, sourceId: string, attempt: number): string {
  return `download_lease_${jobId}_${sourceId}_${attempt}_${Math.random().toString(36).slice(2, 8)}`;
}

function assertSafeError(error: string | undefined): string | undefined {
  if (error === undefined) return undefined;
  const normalized = error.trim();
  assertDomain(normalized.length > 0, "invalid_argument", "Download error cannot be blank.");
  assertDomain(normalized.length <= MAX_ERROR_LENGTH, "invalid_argument", "Download error is too long.");
  // Raw credentials and request material must never be copied into a durable
  // renderer-safe error. Native adapters should log redacted diagnostics.
  assertDomain(!/(authorization|cookie|set-cookie|api[-_ ]?key|bearer|password|secret)\s*[:=]/i.test(normalized), "permission_denied", "Download error contains secret-like request material.");
  return normalized;
}

function normalizeSource(source: CaptureSourceReceipt, now: IsoTimestamp): OmniaDownloadSource {
  const expectedBytes = source.expectedBytes;
  if (expectedBytes !== undefined) {
    assertDomain(Number.isSafeInteger(expectedBytes) && expectedBytes > 0, "invalid_argument", "Capture source expected bytes must be a positive safe integer.", { sourceId: source.id });
  }
  return Object.freeze({
    sourceId: assertNonBlank(source.id, "capture source ID", 256),
    role: source.role,
    ...(source.ordinal === undefined ? {} : { ordinal: assertIntegerInRange(source.ordinal, "capture source ordinal", 0, MAX_JOB_SOURCES - 1) }),
    ...(expectedBytes === undefined ? {} : { expectedBytes }),
    receivedBytes: 0,
    status: "pending",
    attempt: 0,
    updatedAt: now,
  });
}

function sourceMap(job: OmniaDownloadJob): ReadonlyMap<string, OmniaDownloadSource> {
  return new Map(job.sources.map((source) => [source.sourceId, source]));
}

function requireSource(job: OmniaDownloadJob, sourceId: string): OmniaDownloadSource {
  const normalized = assertNonBlank(sourceId, "download source ID", 256);
  const source = sourceMap(job).get(normalized);
  assertDomain(source !== undefined, "not_found", "Download source was not found.", { sourceId: normalized });
  return source;
}

function normalizePriority(priority: OmniaDownloadPriority | undefined): OmniaDownloadPriority {
  const value = priority ?? "normal";
  assertDomain(isOneOf(PRIORITIES, value), "invalid_argument", "Unsupported download priority.", { priority: value });
  return value;
}

function assertMutable(job: OmniaDownloadJob): void {
  assertDomain(!["completed", "cancelled"].includes(job.status), "invalid_state_transition", "A terminal download job cannot be changed.", { jobId: job.id, status: job.status });
}

function computeTotals(sources: readonly OmniaDownloadSource[]): { readonly bytesTotal: number | null; readonly bytesReceived: number; readonly progress: number } {
  const knownTotal = sources.every((source) => source.expectedBytes !== undefined);
  const bytesTotal = knownTotal ? sources.reduce((sum, source) => sum + (source.expectedBytes ?? 0), 0) : null;
  const bytesReceived = sources.reduce((sum, source) => sum + source.receivedBytes, 0);
  const progress = bytesTotal === null
    ? sources.length === 0 ? 0 : Number((sources.filter((source) => source.status === "received").length / sources.length).toFixed(4))
    : bytesTotal === 0 ? 0 : Number(Math.min(1, bytesReceived / bytesTotal).toFixed(4));
  return { bytesTotal, bytesReceived, progress };
}

type DownloadJobPatch = Partial<Pick<OmniaDownloadJob, "status" | "output" | "attempt">> & { readonly error?: string };

function withSources(
  job: OmniaDownloadJob,
  sources: readonly OmniaDownloadSource[],
  now: IsoTimestamp,
  patch: DownloadJobPatch = {},
  options: { readonly clearError?: boolean } = {},
): OmniaDownloadJob {
  const totals = computeTotals(sources);
  const activeLeases = sources.filter((source) => source.status === "leased" || source.status === "downloading").length;
  const next: OmniaDownloadJob = {
    ...job,
    ...patch,
    sources: Object.freeze(sources),
    ...totals,
    activeLeases,
    updatedAt: now,
  };
  if (options.clearError) {
    const { error: _error, ...withoutError } = next;
    return Object.freeze(withoutError);
  }
  return Object.freeze(next);
}

function sourceOrder(job: OmniaDownloadJob): readonly OmniaDownloadSource[] {
  // Preserve the plan's deterministic source order. Priority belongs to the
  // job queue; within one job, ordinal order is required for range/segment
  // assembly and must not be randomized.
  return job.sources;
}

function parseSource(value: unknown): OmniaDownloadSource {
  assertDomain(isRecord(value), "invalid_argument", "Invalid download source.");
  assertDomain(isString(value.sourceId) && isOneOf(SOURCE_STATUSES, value.status) && isOneOf(SOURCE_ROLES, value.role) && isString(value.updatedAt), "invalid_argument", "Invalid download source shape.");
  assertDomain(typeof value.receivedBytes === "number" && Number.isSafeInteger(value.receivedBytes) && value.receivedBytes >= 0, "invalid_argument", "Invalid download source byte count.");
  assertDomain(typeof value.attempt === "number" && Number.isInteger(value.attempt) && value.attempt >= 0, "invalid_argument", "Invalid download source attempt.");
  assertIsoTimestamp(value.updatedAt, "download source updatedAt");
  const expectedBytes = value.expectedBytes;
  if (expectedBytes !== undefined) assertDomain(typeof expectedBytes === "number" && Number.isSafeInteger(expectedBytes) && expectedBytes > 0, "invalid_argument", "Invalid download source expected byte count.");
  const ordinal = value.ordinal;
  if (ordinal !== undefined) assertDomain(typeof ordinal === "number" && Number.isInteger(ordinal) && ordinal >= 0 && ordinal < MAX_JOB_SOURCES, "invalid_argument", "Invalid download source ordinal.");
  const contentSha256 = value.contentSha256;
  if (contentSha256 !== undefined) assertDomain(isString(contentSha256), "invalid_argument", "Invalid download source content hash.");
  const error = value.error;
  if (error !== undefined) assertDomain(isString(error), "invalid_argument", "Invalid download source error.");
  const leaseId = value.leaseId;
  if (leaseId !== undefined) assertDomain(isString(leaseId), "invalid_argument", "Invalid download source lease.");
  if (expectedBytes !== undefined) {
    assertDomain(value.receivedBytes <= expectedBytes, "conflict", "Download source progress exceeds its expected byte count.");
  }
  if (value.status === "received") {
    assertDomain(contentSha256 !== undefined, "conflict", "Received download sources require a content hash.");
    assertDomain(value.receivedBytes > 0, "conflict", "Received download sources require positive byte progress.");
    assertDomain(leaseId === undefined, "conflict", "Received download sources cannot retain an active lease.");
    if (expectedBytes !== undefined) assertDomain(value.receivedBytes === expectedBytes, "conflict", "Received source bytes do not match the expected byte count.");
  }
  if (value.status === "leased" || value.status === "downloading") {
    assertDomain(isString(leaseId) && leaseId.trim().length > 0, "conflict", "Active download sources require a lease.");
  }
  if (value.status === "pending" || value.status === "cancelled") {
    assertDomain(leaseId === undefined, "conflict", "Pending or cancelled download sources cannot retain a lease.");
  }
  return Object.freeze({
    sourceId: assertNonBlank(value.sourceId, "download source ID", 256),
    role: value.role as CaptureSourceReceipt["role"],
    ...(ordinal === undefined ? {} : { ordinal: ordinal as number }),
    ...(expectedBytes === undefined ? {} : { expectedBytes: expectedBytes as number }),
    receivedBytes: value.receivedBytes,
    status: value.status as OmniaDownloadSourceStatus,
    attempt: value.attempt,
    ...(leaseId === undefined ? {} : { leaseId: assertNonBlank(leaseId, "download source lease", 512) }),
    ...(contentSha256 === undefined ? {} : { contentSha256: assertSha256(contentSha256, "download source content hash") }),
    ...(error === undefined ? {} : { error: assertSafeError(error) as string }),
    updatedAt: value.updatedAt,
  });
}

export function createOmniaDownloadJob(input: CreateOmniaDownloadJobInput): OmniaDownloadJob {
  assertIsoTimestamp(input.now, "download job now");
  const capturePlan = input.capturePlan;
  assertDomain(capturePlan.schemaVersion === 1, "invalid_argument", "Unsupported authorized capture plan schema.");
  const id = assertNonBlank(input.id, "download job ID", 256);
  const capturePlanSha256 = assertSha256(input.capturePlanSha256, "capture plan hash");
  const outputFilename = assertNonBlank(input.outputFilename ?? capturePlan.assembly.outputFilename, "download output filename", 512);
  const outputMediaType = assertNonBlank(input.outputMediaType ?? "application/octet-stream", "download output media type", 256);
  const maxConcurrentSources = input.maxConcurrentSources ?? DEFAULT_MAX_CONCURRENT_SOURCES;
  const maxAttemptsPerSource = input.maxAttemptsPerSource ?? DEFAULT_MAX_ATTEMPTS_PER_SOURCE;
  assertIntegerInRange(maxConcurrentSources, "max concurrent download sources", 1, 64);
  assertIntegerInRange(maxAttemptsPerSource, "max attempts per download source", 1, 20);
  const priority = normalizePriority(input.priority);
  assertDomain(capturePlan.sources.length > 0 && capturePlan.sources.length <= MAX_JOB_SOURCES, "invalid_argument", "Authorized capture plan source count is outside download bounds.");
  const sources = Object.freeze(capturePlan.orderedSourceIds.map((sourceId) => {
    const source = capturePlan.sources.find((candidate) => candidate.id === sourceId);
    assertDomain(source !== undefined, "scope_violation", "Capture plan ordered source is missing from its source receipts.", { sourceId });
    return normalizeSource(source, input.now);
  }));
  const totals = computeTotals(sources);
  return Object.freeze({
    schemaVersion: OMNIA_DOWNLOAD_MANAGER_SCHEMA_VERSION,
    id,
    capturePlanId: assertNonBlank(capturePlan.id, "capture plan ID", 256),
    capturePlanSha256,
    browserAttachmentId: assertNonBlank(capturePlan.browserAttachment.id, "browser attachment ID", 256),
    browserAttachmentEpoch: assertNonBlank(capturePlan.browserAttachment.epoch, "browser attachment epoch", 256),
    assemblyKind: capturePlan.assembly.kind,
    outputFilename,
    outputMediaType,
    priority,
    status: "draft",
    maxConcurrentSources,
    maxAttemptsPerSource,
    sources,
    ...totals,
    activeLeases: 0,
    attempt: 0,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function queueOmniaDownload(job: OmniaDownloadJob, now: IsoTimestamp): OmniaDownloadJob {
  assertIsoTimestamp(now, "download queue time");
  assertDomain(job.status === "draft" || job.status === "failed", "invalid_state_transition", "Only draft or failed download jobs can be queued.", { jobId: job.id, status: job.status });
  return withSources(job, job.sources, now, { status: "queued" }, { clearError: true });
}

export function leaseOmniaDownloadSources(job: OmniaDownloadJob, now: IsoTimestamp): LeaseDownloadSourcesResult {
  assertIsoTimestamp(now, "download lease time");
  assertDomain(job.status === "queued" || job.status === "running", "invalid_state_transition", "Download sources can only be leased from a queued or running job.", { jobId: job.id, status: job.status });
  const available = Math.max(0, job.maxConcurrentSources - job.activeLeases);
  const candidates = sourceOrder(job).filter((source) => source.status === "pending" || (source.status === "failed" && source.attempt < job.maxAttemptsPerSource)).slice(0, available);
  const leases: DownloadSourceLease[] = [];
  const sourceUpdates = new Map<string, OmniaDownloadSource>();
  for (const source of job.sources) sourceUpdates.set(source.sourceId, source);
  for (const source of candidates) {
    const attempt = source.attempt + 1;
    const leaseId = makeLeaseId(job.id, source.sourceId, attempt);
    leases.push(Object.freeze({ sourceId: source.sourceId, leaseId, attempt }));
    const { error: _error, ...withoutError } = source;
    sourceUpdates.set(source.sourceId, Object.freeze({ ...withoutError, status: "leased", attempt, leaseId, updatedAt: now }));
  }
  const nextStatus: OmniaDownloadJobStatus = leases.length > 0 || job.activeLeases > 0 ? "running" : job.status;
  return { job: withSources(job, job.sources.map((source) => sourceUpdates.get(source.sourceId) ?? source), now, { status: nextStatus, attempt: job.attempt + (leases.length > 0 ? 1 : 0) }), leases: Object.freeze(leases) };
}

export function beginOmniaDownloadSource(job: OmniaDownloadJob, sourceId: string, leaseId: string, now: IsoTimestamp): OmniaDownloadJob {
  assertIsoTimestamp(now, "download source start time");
  assertMutable(job);
  const source = requireSource(job, sourceId);
  assertDomain(source.status === "leased" && source.leaseId === leaseId, "conflict", "Download source lease is missing or stale.", { sourceId });
  const sources = job.sources.map((candidate) => candidate.sourceId === source.sourceId ? Object.freeze({ ...candidate, status: "downloading" as const, updatedAt: now }) : candidate);
  return withSources(job, sources, now, { status: "running" });
}

export function updateOmniaDownloadSourceProgress(job: OmniaDownloadJob, sourceId: string, receivedBytes: number, now: IsoTimestamp): OmniaDownloadJob {
  assertIsoTimestamp(now, "download progress time");
  assertMutable(job);
  const source = requireSource(job, sourceId);
  assertDomain(source.status === "leased" || source.status === "downloading", "invalid_state_transition", "Only an active download source can report progress.", { sourceId, status: source.status });
  assertDomain(Number.isSafeInteger(receivedBytes) && receivedBytes >= source.receivedBytes, "invalid_argument", "Download source progress cannot move backwards.", { sourceId });
  if (source.expectedBytes !== undefined) assertDomain(receivedBytes <= source.expectedBytes, "invalid_argument", "Download source progress exceeds expected bytes.", { sourceId });
  const sources = job.sources.map((candidate) => candidate.sourceId === source.sourceId ? Object.freeze({ ...candidate, receivedBytes, status: "downloading" as const, updatedAt: now }) : candidate);
  return withSources(job, sources, now, { status: "running" });
}

export function completeOmniaDownloadSource(job: OmniaDownloadJob, sourceId: string, contentSha256: string, byteSize: number, now: IsoTimestamp): OmniaDownloadJob {
  assertIsoTimestamp(now, "download source completion time");
  assertMutable(job);
  const source = requireSource(job, sourceId);
  assertDomain(source.status === "leased" || source.status === "downloading", "invalid_state_transition", "Only an active download source can complete.", { sourceId, status: source.status });
  assertDomain(Number.isSafeInteger(byteSize) && byteSize > 0, "invalid_argument", "Completed download source must have a positive byte size.", { sourceId });
  if (source.expectedBytes !== undefined) assertDomain(byteSize === source.expectedBytes, "conflict", "Completed source byte size does not match the authorized response receipt.", { sourceId, expectedBytes: source.expectedBytes, byteSize });
  const normalizedHash = assertSha256(contentSha256, "download source content hash");
  const sources = job.sources.map((candidate) => {
    if (candidate.sourceId !== source.sourceId) return candidate;
    const { leaseId: _leaseId, ...withoutLease } = candidate;
    return Object.freeze({ ...withoutLease, receivedBytes: byteSize, status: "received" as const, contentSha256: normalizedHash, updatedAt: now });
  });
  const allReceived = sources.every((candidate) => candidate.status === "received");
  return withSources(job, sources, now, { status: allReceived ? "assembling" : "running" });
}

export function failOmniaDownloadSource(job: OmniaDownloadJob, sourceId: string, error: string, now: IsoTimestamp): OmniaDownloadJob {
  assertIsoTimestamp(now, "download source failure time");
  assertMutable(job);
  const source = requireSource(job, sourceId);
  assertDomain(source.status === "leased" || source.status === "downloading", "invalid_state_transition", "Only an active download source can fail.", { sourceId, status: source.status });
  const normalizedError = assertSafeError(error) as string;
  const exhausted = source.attempt >= job.maxAttemptsPerSource;
  const sources = job.sources.map((candidate) => {
    if (candidate.sourceId !== source.sourceId) return candidate;
    const { leaseId: _leaseId, ...withoutLease } = candidate;
    return Object.freeze({ ...withoutLease, status: "failed" as const, error: normalizedError, updatedAt: now });
  });
  const status: OmniaDownloadJobStatus = exhausted && sources.every((candidate) => candidate.status === "failed" || candidate.status === "cancelled" || candidate.status === "received") ? "failed" : "queued";
  return status === "failed"
    ? withSources(job, sources, now, { status, error: normalizedError })
    : withSources(job, sources, now, { status }, { clearError: true });
}

export function pauseOmniaDownload(job: OmniaDownloadJob, now: IsoTimestamp): OmniaDownloadJob {
  assertIsoTimestamp(now, "download pause time");
  assertDomain(job.status === "queued" || job.status === "running", "invalid_state_transition", "Only queued or running download jobs can be paused.", { jobId: job.id, status: job.status });
  return withSources(job, job.sources, now, { status: "paused" });
}

export function resumeOmniaDownload(job: OmniaDownloadJob, now: IsoTimestamp): OmniaDownloadJob {
  assertIsoTimestamp(now, "download resume time");
  assertDomain(job.status === "paused", "invalid_state_transition", "Only paused download jobs can be resumed.", { jobId: job.id, status: job.status });
  const sources = job.sources.map((source) => {
    if (source.status !== "leased" && source.status !== "downloading") return source;
    const { leaseId: _leaseId, ...withoutLease } = source;
    return Object.freeze({ ...withoutLease, status: "pending" as const, updatedAt: now });
  });
  return withSources(job, sources, now, { status: "queued" }, { clearError: true });
}

export function cancelOmniaDownload(job: OmniaDownloadJob, now: IsoTimestamp, reason = "Cancelled by user."): OmniaDownloadJob {
  assertIsoTimestamp(now, "download cancellation time");
  assertMutable(job);
  const normalizedReason = assertSafeError(reason) as string;
  const sources = job.sources.map((source) => {
    if (source.status === "received") return source;
    const { leaseId: _leaseId, ...withoutLease } = source;
    return Object.freeze({ ...withoutLease, status: "cancelled" as const, updatedAt: now });
  });
  return withSources(job, sources, now, { status: "cancelled", error: normalizedReason });
}

export function retryOmniaDownload(job: OmniaDownloadJob, now: IsoTimestamp): OmniaDownloadJob {
  assertIsoTimestamp(now, "download retry time");
  assertDomain(job.status === "failed", "invalid_state_transition", "Only failed download jobs can be retried.", { jobId: job.id, status: job.status });
  const sources = job.sources.map((source) => {
    if (source.status !== "failed" || source.attempt >= job.maxAttemptsPerSource) return source;
    const { error: _error, ...withoutError } = source;
    return Object.freeze({ ...withoutError, status: "pending" as const, updatedAt: now });
  });
  assertDomain(sources.some((source) => source.status === "pending"), "invalid_state_transition", "No retryable download source remains.", { jobId: job.id });
  return withSources(job, sources, now, { status: "queued" }, { clearError: true });
}

export function beginOmniaDownloadAssembly(job: OmniaDownloadJob, now: IsoTimestamp): OmniaDownloadJob {
  assertIsoTimestamp(now, "download assembly start time");
  assertDomain(job.status === "assembling", "invalid_state_transition", "Download assembly requires all sources to be received.", { jobId: job.id, status: job.status });
  assertDomain(job.sources.every((source) => source.status === "received"), "invalid_state_transition", "Download assembly requires every source to be received.", { jobId: job.id });
  return withSources(job, job.sources, now, { status: "verifying" });
}

export function completeOmniaDownload(job: OmniaDownloadJob, output: OmniaDownloadOutput, now: IsoTimestamp): OmniaDownloadJob {
  assertIsoTimestamp(now, "download completion time");
  assertDomain(job.status === "verifying", "invalid_state_transition", "A download must be verifying before completion.", { jobId: job.id, status: job.status });
  const normalizedOutput: OmniaDownloadOutput = Object.freeze({
    blobId: assertNonBlank(output.blobId, "download output blob ID", 256),
    filename: assertNonBlank(output.filename, "download output filename", 512),
    mediaType: assertNonBlank(output.mediaType, "download output media type", 256),
    byteSize: assertIntegerInRange(output.byteSize, "download output byte size", 1, Number.MAX_SAFE_INTEGER),
    contentSha256: assertSha256(output.contentSha256, "download output content hash"),
  });
  return withSources(job, job.sources, now, { status: "completed", output: normalizedOutput });
}

export function summarizeOmniaDownload(job: OmniaDownloadJob): DownloadJobSummary {
  const pendingCount = job.sources.filter((source) => source.status === "pending").length;
  const activeCount = job.sources.filter((source) => source.status === "leased" || source.status === "downloading").length;
  const receivedCount = job.sources.filter((source) => source.status === "received").length;
  const failedCount = job.sources.filter((source) => source.status === "failed").length;
  const cancelledCount = job.sources.filter((source) => source.status === "cancelled").length;
  return Object.freeze({
    sourceCount: job.sources.length,
    pendingCount,
    activeCount,
    receivedCount,
    failedCount,
    cancelledCount,
    bytesTotal: job.bytesTotal,
    bytesReceived: job.bytesReceived,
    progress: job.progress,
    terminal: job.status === "completed" || job.status === "cancelled" || job.status === "failed",
  });
}

export function serializeOmniaDownloadJob(job: OmniaDownloadJob): string {
  return JSON.stringify(job, null, 2);
}

export function deserializeOmniaDownloadJob(input: string | unknown): OmniaDownloadJob {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  assertDomain(isRecord(value), "invalid_argument", "Invalid Omnia download job.");
  assertDomain(value.schemaVersion === 1 && isString(value.id) && isString(value.capturePlanId) && isString(value.capturePlanSha256) && isString(value.browserAttachmentId) && isString(value.browserAttachmentEpoch) && isOneOf(ASSEMBLY_KINDS, value.assemblyKind) && isString(value.outputFilename) && isString(value.outputMediaType) && isOneOf(PRIORITIES, value.priority) && isOneOf(JOB_STATUSES, value.status) && Array.isArray(value.sources) && isString(value.createdAt) && isString(value.updatedAt), "invalid_argument", "Invalid Omnia download job shape.");
  assertIsoTimestamp(value.createdAt, "download job createdAt");
  assertIsoTimestamp(value.updatedAt, "download job updatedAt");
  const maxConcurrentSources = value.maxConcurrentSources;
  const maxAttemptsPerSource = value.maxAttemptsPerSource;
  assertDomain(typeof maxConcurrentSources === "number" && Number.isInteger(maxConcurrentSources) && maxConcurrentSources >= 1 && maxConcurrentSources <= 64, "invalid_argument", "Invalid download concurrency.");
  assertDomain(typeof maxAttemptsPerSource === "number" && Number.isInteger(maxAttemptsPerSource) && maxAttemptsPerSource >= 1 && maxAttemptsPerSource <= 20, "invalid_argument", "Invalid download retry limit.");
  const sources = Object.freeze(value.sources.map(parseSource));
  assertDomain(sources.length > 0 && sources.length <= MAX_JOB_SOURCES, "invalid_argument", "Invalid download source count.");
  assertDomain(new Set(sources.map((source) => source.sourceId)).size === sources.length, "conflict", "Download source IDs must be unique.");
  const totals = computeTotals(sources);
  if (value.bytesTotal !== null) assertDomain(typeof value.bytesTotal === "number" && Number.isSafeInteger(value.bytesTotal) && value.bytesTotal >= 0, "invalid_argument", "Invalid download total bytes.");
  assertDomain(typeof value.bytesReceived === "number" && Number.isSafeInteger(value.bytesReceived) && value.bytesReceived >= 0, "invalid_argument", "Invalid download received bytes.");
  assertDomain(typeof value.progress === "number" && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 1, "invalid_argument", "Invalid download progress.");
  assertDomain(value.bytesReceived === totals.bytesReceived && value.progress === totals.progress && value.bytesTotal === totals.bytesTotal, "conflict", "Download totals do not match source checkpoints.");
  const output = value.output;
  if (output !== undefined) {
    assertDomain(isRecord(output) && isString(output.blobId) && isString(output.filename) && isString(output.mediaType) && typeof output.byteSize === "number" && Number.isSafeInteger(output.byteSize) && output.byteSize > 0 && isString(output.contentSha256), "invalid_argument", "Invalid download output.");
  }
  const error = value.error;
  if (error !== undefined) assertSafeError(String(error));
  const activeLeases = sources.filter((source) => source.status === "leased" || source.status === "downloading").length;
  assertDomain(value.activeLeases === activeLeases, "conflict", "Download active lease count does not match source checkpoints.");
  return Object.freeze({
    schemaVersion: 1,
    id: assertNonBlank(value.id, "download job ID", 256),
    capturePlanId: assertNonBlank(value.capturePlanId, "capture plan ID", 256),
    capturePlanSha256: assertSha256(value.capturePlanSha256, "capture plan hash"),
    browserAttachmentId: assertNonBlank(value.browserAttachmentId, "browser attachment ID", 256),
    browserAttachmentEpoch: assertNonBlank(value.browserAttachmentEpoch, "browser attachment epoch", 256),
    assemblyKind: value.assemblyKind as OmniaDownloadAssemblyKind,
    outputFilename: assertNonBlank(value.outputFilename, "download output filename", 512),
    outputMediaType: assertNonBlank(value.outputMediaType, "download output media type", 256),
    priority: value.priority as OmniaDownloadPriority,
    status: value.status as OmniaDownloadJobStatus,
    maxConcurrentSources,
    maxAttemptsPerSource,
    sources,
    bytesTotal: totals.bytesTotal,
    bytesReceived: totals.bytesReceived,
    progress: totals.progress,
    activeLeases,
    attempt: typeof value.attempt === "number" && Number.isInteger(value.attempt) && value.attempt >= 0 ? value.attempt : 0,
    ...(error === undefined ? {} : { error: assertSafeError(String(error)) as string }),
    ...(output === undefined ? {} : { output: Object.freeze({ blobId: assertNonBlank(output.blobId as string, "download output blob ID", 256), filename: assertNonBlank(output.filename as string, "download output filename", 512), mediaType: assertNonBlank(output.mediaType as string, "download output media type", 256), byteSize: output.byteSize as number, contentSha256: assertSha256(output.contentSha256 as string, "download output content hash") }) }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}
