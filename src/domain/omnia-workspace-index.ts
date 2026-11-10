import { assertDomain } from "./errors";
import type { WorkspaceGrantId } from "./ids";
import {
  assertIntegerInRange,
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";

/** Lifecycle of a renderer-safe projection of a native workspace index. */
export type WorkspaceIndexStatus = "idle" | "indexing" | "ready" | "stale" | "failed";

/** Entry kinds are deliberately broader than files/directories for native portability. */
export type WorkspaceIndexEntryKind = "file" | "directory" | "symlink" | "other";

const WORKSPACE_INDEX_STATUSES: readonly WorkspaceIndexStatus[] = [
  "idle",
  "indexing",
  "ready",
  "stale",
  "failed",
];
const WORKSPACE_INDEX_ENTRY_KINDS: readonly WorkspaceIndexEntryKind[] = [
  "file",
  "directory",
  "symlink",
  "other",
];

/** Input projection returned by a native directory walker. No absolute path is accepted here. */
export interface WorkspaceIndexEntryInput {
  readonly relativePath: string;
  readonly kind: WorkspaceIndexEntryKind;
  readonly byteSize?: number | null;
  readonly modifiedAt?: IsoTimestamp | null;
  readonly contentSha256?: string | null;
  readonly language?: string;
  readonly ignored?: boolean;
}

/** Renderer-safe, normalized metadata for one workspace entry. */
export interface WorkspaceIndexEntry {
  readonly relativePath: string;
  readonly name: string;
  readonly kind: WorkspaceIndexEntryKind;
  readonly byteSize?: number;
  readonly modifiedAt?: IsoTimestamp;
  readonly contentSha256?: string;
  readonly language?: string;
  readonly ignored: boolean;
}

export interface WorkspaceIndexStats {
  readonly entryCount: number;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly symlinkCount: number;
  readonly otherCount: number;
  readonly ignoredCount: number;
  readonly totalBytes: number;
}

/**
 * Native-owned paths and file contents must not be copied into this object. The index only
 * contains the display root and relative metadata, making it safe to hydrate in the renderer.
 */
export interface WorkspaceIndex {
  readonly version: 1;
  readonly grantId: WorkspaceGrantId;
  readonly displayPath: string;
  readonly status: WorkspaceIndexStatus;
  readonly entries: readonly WorkspaceIndexEntry[];
  readonly ignorePatterns: readonly string[];
  readonly generation: number;
  readonly stats: WorkspaceIndexStats;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly indexedAt?: IsoTimestamp | undefined;
  readonly lastError?: string | undefined;
}

export interface CreateWorkspaceIndexInput {
  readonly grantId: WorkspaceGrantId;
  readonly displayPath: string;
  readonly ignorePatterns?: readonly string[];
  readonly now: IsoTimestamp;
}

export interface WorkspaceIndexQuery {
  readonly query?: string;
  readonly kinds?: readonly WorkspaceIndexEntryKind[];
  readonly includeIgnored?: boolean;
  readonly maxResults?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function freezeEntry(entry: WorkspaceIndexEntry): WorkspaceIndexEntry {
  return Object.freeze(entry);
}

function freezeStats(stats: WorkspaceIndexStats): WorkspaceIndexStats {
  return Object.freeze(stats);
}

function normalizeIgnorePatterns(patterns: readonly string[] | undefined): readonly string[] {
  const normalized = [...new Set((patterns ?? []).map((pattern) => pattern.trim()).filter(Boolean))];
  return Object.freeze(normalized);
}

/**
 * Converts slash styles and rejects absolute/escaping paths. A native caller should perform
 * canonical-path checks separately with the workspace grant before producing this projection.
 */
export function normalizeWorkspaceRelativePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  assertDomain(normalized.length > 0, "invalid_argument", "Workspace relative path cannot be empty.");
  assertDomain(
    !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized),
    "scope_violation",
    "Workspace index paths must be relative.",
  );
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  assertDomain(
    segments.length > 0 && segments.every((segment) => segment !== ".."),
    "scope_violation",
    "Workspace index path escapes the granted root.",
  );
  return segments.join("/");
}

function normalizeEntryName(relativePath: string): string {
  const separator = relativePath.lastIndexOf("/");
  return relativePath.slice(separator + 1);
}

function assertByteSize(value: number, label: string): number {
  assertDomain(
    Number.isSafeInteger(value) && value >= 0,
    "invalid_argument",
    `${label} must be a non-negative safe integer.`,
  );
  return value;
}

/** Builds one normalized entry from a native directory-walker projection. */
export function createWorkspaceIndexEntry(input: WorkspaceIndexEntryInput): WorkspaceIndexEntry {
  assertDomain(
    WORKSPACE_INDEX_ENTRY_KINDS.includes(input.kind),
    "invalid_argument",
    "Workspace index entry kind is not recognized.",
  );
  const relativePath = normalizeWorkspaceRelativePath(input.relativePath);
  const byteSize = input.byteSize === undefined || input.byteSize === null
    ? undefined
    : assertByteSize(input.byteSize, "Workspace index byte size");
  const modifiedAt = input.modifiedAt === undefined || input.modifiedAt === null
    ? undefined
    : (assertIsoTimestamp(input.modifiedAt, "Workspace index modified time"), input.modifiedAt);
  const contentSha256 = input.contentSha256 === undefined || input.contentSha256 === null
    ? undefined
    : assertSha256(input.contentSha256, "Workspace index content hash");
  const language = input.language === undefined ? undefined : assertNonBlank(input.language, "Workspace index language", 80);
  return freezeEntry({
    relativePath,
    name: normalizeEntryName(relativePath),
    kind: input.kind,
    ...(byteSize === undefined ? {} : { byteSize }),
    ...(modifiedAt === undefined ? {} : { modifiedAt }),
    ...(contentSha256 === undefined ? {} : { contentSha256 }),
    ...(language === undefined ? {} : { language }),
    ignored: input.ignored ?? false,
  });
}

function createEmptyStats(): WorkspaceIndexStats {
  return freezeStats({
    entryCount: 0,
    fileCount: 0,
    directoryCount: 0,
    symlinkCount: 0,
    otherCount: 0,
    ignoredCount: 0,
    totalBytes: 0,
  });
}

function calculateStats(entries: readonly WorkspaceIndexEntry[]): WorkspaceIndexStats {
  let fileCount = 0;
  let directoryCount = 0;
  let symlinkCount = 0;
  let otherCount = 0;
  let ignoredCount = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.kind === "file") fileCount += 1;
    else if (entry.kind === "directory") directoryCount += 1;
    else if (entry.kind === "symlink") symlinkCount += 1;
    else otherCount += 1;
    if (entry.ignored) ignoredCount += 1;
    if (entry.byteSize !== undefined) totalBytes += entry.byteSize;
  }
  return freezeStats({
    entryCount: entries.length,
    fileCount,
    directoryCount,
    symlinkCount,
    otherCount,
    ignoredCount,
    totalBytes,
  });
}

function freezeEntries(entries: readonly WorkspaceIndexEntry[]): readonly WorkspaceIndexEntry[] {
  return Object.freeze([...entries].sort((left, right) => left.relativePath.localeCompare(right.relativePath)));
}

function withEntries(
  index: WorkspaceIndex,
  entries: readonly WorkspaceIndexEntry[],
  patch: Partial<Pick<WorkspaceIndex, "status" | "generation" | "updatedAt" | "indexedAt" | "lastError">>,
): WorkspaceIndex {
  const nextEntries = freezeEntries(entries);
  return Object.freeze({
    ...index,
    ...patch,
    entries: nextEntries,
    stats: calculateStats(nextEntries),
  });
}

function assertUniqueEntries(entries: readonly WorkspaceIndexEntry[]): void {
  const paths = new Set<string>();
  for (const entry of entries) {
    assertDomain(!paths.has(entry.relativePath), "conflict", "Workspace index contains duplicate paths.", {
      relativePath: entry.relativePath,
    });
    paths.add(entry.relativePath);
  }
}

export function createWorkspaceIndex(input: CreateWorkspaceIndexInput): WorkspaceIndex {
  assertNonBlank(input.grantId, "Workspace grant ID", 256);
  assertIsoTimestamp(input.now, "Workspace index creation time");
  return Object.freeze({
    version: 1,
    grantId: input.grantId,
    displayPath: assertNonBlank(input.displayPath, "Workspace display path", 4096),
    status: "idle",
    entries: Object.freeze([]),
    ignorePatterns: normalizeIgnorePatterns(input.ignorePatterns),
    generation: 0,
    stats: createEmptyStats(),
    createdAt: input.now,
    updatedAt: input.now,
  });
}

/** Marks an index as actively rebuilding. The generation changes at the start of every rebuild. */
export function beginWorkspaceIndexing(index: WorkspaceIndex, now: IsoTimestamp): WorkspaceIndex {
  assertIsoTimestamp(now, "Workspace index start time");
  assertDomain(index.status !== "indexing", "conflict", "Workspace index is already indexing.");
  return Object.freeze({
    ...index,
    status: "indexing",
    generation: index.generation + 1,
    updatedAt: now,
    ...(index.lastError === undefined ? {} : { lastError: undefined }),
  });
}

/** Replaces the complete index after a native scan has finished. */
export function replaceWorkspaceIndex(
  index: WorkspaceIndex,
  entries: readonly WorkspaceIndexEntryInput[],
  now: IsoTimestamp,
): WorkspaceIndex {
  assertIsoTimestamp(now, "Workspace index completion time");
  const normalized = entries.map(createWorkspaceIndexEntry);
  assertUniqueEntries(normalized);
  return withEntries(index, normalized, {
    status: "ready",
    generation: index.generation + (index.status === "indexing" ? 0 : 1),
    indexedAt: now,
    updatedAt: now,
    lastError: undefined,
  });
}

/** Applies a bounded incremental batch without requiring a complete directory rescan. */
export function upsertWorkspaceIndexEntries(
  index: WorkspaceIndex,
  entries: readonly WorkspaceIndexEntryInput[],
  now: IsoTimestamp,
): WorkspaceIndex {
  assertIsoTimestamp(now, "Workspace index update time");
  const updates = entries.map(createWorkspaceIndexEntry);
  const byPath = new Map(index.entries.map((entry) => [entry.relativePath, entry]));
  for (const entry of updates) byPath.set(entry.relativePath, entry);
  return withEntries(index, [...byPath.values()], {
    status: "ready",
    generation: index.generation + 1,
    indexedAt: now,
    updatedAt: now,
    lastError: undefined,
  });
}

export function removeWorkspaceIndexEntries(
  index: WorkspaceIndex,
  relativePaths: readonly string[],
  now: IsoTimestamp,
): WorkspaceIndex {
  assertIsoTimestamp(now, "Workspace index removal time");
  const removals = new Set(relativePaths.map(normalizeWorkspaceRelativePath));
  return withEntries(index, index.entries.filter((entry) => !removals.has(entry.relativePath)), {
    status: "ready",
    generation: index.generation + 1,
    indexedAt: now,
    updatedAt: now,
    lastError: undefined,
  });
}

export function markWorkspaceIndexStale(index: WorkspaceIndex, now: IsoTimestamp): WorkspaceIndex {
  assertIsoTimestamp(now, "Workspace index stale time");
  return Object.freeze({ ...index, status: "stale", updatedAt: now });
}

export function setWorkspaceIndexIgnorePatterns(
  index: WorkspaceIndex,
  ignorePatterns: readonly string[],
  now: IsoTimestamp,
): WorkspaceIndex {
  assertIsoTimestamp(now, "Workspace index settings time");
  return Object.freeze({
    ...index,
    ignorePatterns: normalizeIgnorePatterns(ignorePatterns),
    updatedAt: now,
  });
}

export function failWorkspaceIndex(index: WorkspaceIndex, error: string, now: IsoTimestamp): WorkspaceIndex {
  assertIsoTimestamp(now, "Workspace index failure time");
  return Object.freeze({
    ...index,
    status: "failed",
    updatedAt: now,
    lastError: assertNonBlank(error, "Workspace index failure", 1000),
  });
}

export function getWorkspaceIndexEntry(index: WorkspaceIndex, relativePath: string): WorkspaceIndexEntry | undefined {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  return index.entries.find((entry) => entry.relativePath === normalized);
}

/** Lists immediate children for a file-tree sidebar without leaking absolute paths. */
export function listWorkspaceIndexChildren(
  index: WorkspaceIndex,
  relativeDirectory?: string,
  includeIgnored = false,
): readonly WorkspaceIndexEntry[] {
  const directory = relativeDirectory === undefined || relativeDirectory.trim() === ""
    ? ""
    : normalizeWorkspaceRelativePath(relativeDirectory);
  const prefix = directory.length === 0 ? "" : `${directory}/`;
  const children = index.entries.filter((entry) => {
    if (!includeIgnored && entry.ignored) return false;
    if (!entry.relativePath.startsWith(prefix)) return false;
    const remainder = entry.relativePath.slice(prefix.length);
    return remainder.length > 0 && !remainder.includes("/");
  });
  return Object.freeze([...children]);
}

/**
 * Performs a deterministic path/name query. This is intentionally lexical; semantic retrieval
 * and content chunking belong to the retrieval layer and can consume this index later.
 */
export function queryWorkspaceIndex(
  index: WorkspaceIndex,
  options: WorkspaceIndexQuery = {},
): readonly WorkspaceIndexEntry[] {
  const query = options.query?.trim().toLocaleLowerCase("en-US") ?? "";
  const kinds = options.kinds === undefined ? undefined : new Set(options.kinds);
  const maxResults = options.maxResults === undefined
    ? Number.MAX_SAFE_INTEGER
    : assertIntegerInRange(options.maxResults, "Workspace index result limit", 1, 10_000);
  const ranked = index.entries
    .filter((entry) => options.includeIgnored === true || !entry.ignored)
    .filter((entry) => kinds === undefined || kinds.has(entry.kind))
    .map((entry) => {
      if (!query) return { entry, rank: 0 };
      const path = entry.relativePath.toLocaleLowerCase("en-US");
      const name = entry.name.toLocaleLowerCase("en-US");
      if (name === query || path === query) return { entry, rank: 0 };
      if (name.startsWith(query) || path.startsWith(query)) return { entry, rank: 1 };
      if (name.includes(query)) return { entry, rank: 2 };
      if (path.includes(query)) return { entry, rank: 3 };
      return undefined;
    })
    .filter((candidate): candidate is { entry: WorkspaceIndexEntry; rank: number } => candidate !== undefined)
    .sort((left, right) => left.rank - right.rank || left.entry.relativePath.localeCompare(right.entry.relativePath));
  return Object.freeze(ranked.slice(0, maxResults).map((candidate) => candidate.entry));
}

function parseEntry(value: unknown): WorkspaceIndexEntry {
  assertDomain(isRecord(value), "invalid_argument", "Invalid workspace index entry.");
  assertDomain(isString(value.relativePath), "invalid_argument", "Workspace index entry path is invalid.");
  assertDomain(isOneOf(WORKSPACE_INDEX_ENTRY_KINDS, value.kind), "invalid_argument", "Workspace index entry kind is invalid.");
  let byteSize: number | null | undefined;
  if (value.byteSize === undefined || value.byteSize === null) byteSize = value.byteSize as number | null | undefined;
  else {
    assertDomain(isNumber(value.byteSize), "invalid_argument", "Workspace index byte size is invalid.");
    byteSize = value.byteSize as number;
  }
  let modifiedAt: string | null | undefined;
  if (value.modifiedAt === undefined || value.modifiedAt === null) modifiedAt = value.modifiedAt as string | null | undefined;
  else {
    assertDomain(isString(value.modifiedAt), "invalid_argument", "Workspace index modified time is invalid.");
    modifiedAt = value.modifiedAt as string;
  }
  let contentSha256: string | null | undefined;
  if (value.contentSha256 === undefined || value.contentSha256 === null) contentSha256 = value.contentSha256 as string | null | undefined;
  else {
    assertDomain(isString(value.contentSha256), "invalid_argument", "Workspace index content hash is invalid.");
    contentSha256 = value.contentSha256 as string;
  }
  let language: string | undefined;
  if (value.language !== undefined) {
    assertDomain(isString(value.language), "invalid_argument", "Workspace index language is invalid.");
    language = value.language as string;
  }
  let ignored: boolean | undefined;
  if (value.ignored !== undefined) {
    assertDomain(typeof value.ignored === "boolean", "invalid_argument", "Workspace index ignored flag is invalid.");
    ignored = value.ignored as boolean;
  }
  const entry = createWorkspaceIndexEntry({
    relativePath: value.relativePath,
    kind: value.kind,
    ...(byteSize === undefined ? {} : { byteSize }),
    ...(modifiedAt === undefined ? {} : { modifiedAt }),
    ...(contentSha256 === undefined ? {} : { contentSha256 }),
    ...(language === undefined ? {} : { language }),
    ...(ignored === undefined ? {} : { ignored }),
  });
  assertDomain(value.name === undefined || value.name === entry.name, "invalid_argument", "Workspace index entry name is inconsistent.");
  return entry;
}

function parseStats(value: unknown, entries: readonly WorkspaceIndexEntry[]): WorkspaceIndexStats {
  if (value !== undefined) {
    assertDomain(isRecord(value), "invalid_argument", "Workspace index stats are invalid.");
    for (const key of ["entryCount", "fileCount", "directoryCount", "symlinkCount", "otherCount", "ignoredCount", "totalBytes"]) {
      assertDomain(isNumber(value[key]), "invalid_argument", `Workspace index stat ${key} is invalid.`);
    }
  }
  return calculateStats(entries);
}

export function deserializeWorkspaceIndex(input: string | unknown): WorkspaceIndex {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  assertDomain(isRecord(value), "invalid_argument", "Invalid workspace index.");
  assertDomain(value.version === 1, "invalid_argument", "Unsupported workspace index version.");
  assertDomain(isString(value.grantId), "invalid_argument", "Workspace index grant ID is invalid.");
  assertDomain(isString(value.displayPath), "invalid_argument", "Workspace index display path is invalid.");
  assertDomain(isOneOf(WORKSPACE_INDEX_STATUSES, value.status), "invalid_argument", "Workspace index status is invalid.");
  assertDomain(Array.isArray(value.entries), "invalid_argument", "Workspace index entries are invalid.");
  assertDomain(isNumber(value.generation) && Number.isSafeInteger(value.generation) && value.generation >= 0, "invalid_argument", "Workspace index generation is invalid.");
  assertDomain(isString(value.createdAt) && isString(value.updatedAt), "invalid_argument", "Workspace index timestamps are invalid.");
  assertIsoTimestamp(value.createdAt, "Workspace index creation time");
  assertIsoTimestamp(value.updatedAt, "Workspace index update time");
  const entries = value.entries.map(parseEntry);
  assertUniqueEntries(entries);
  const ignorePatterns = value.ignorePatterns === undefined ? [] : value.ignorePatterns;
  assertDomain(Array.isArray(ignorePatterns) && ignorePatterns.every(isString), "invalid_argument", "Workspace index ignore patterns are invalid.");
  const stats = parseStats(value.stats, entries);
  const indexedAt = value.indexedAt === undefined ? undefined : value.indexedAt;
  if (indexedAt !== undefined) assertDomain(isString(indexedAt), "invalid_argument", "Workspace index indexedAt is invalid.");
  if (indexedAt !== undefined) assertIsoTimestamp(indexedAt, "Workspace index indexed time");
  const lastError = value.lastError === undefined ? undefined : value.lastError;
  if (lastError !== undefined) assertDomain(isString(lastError), "invalid_argument", "Workspace index error is invalid.");
  return Object.freeze({
    version: 1,
    grantId: value.grantId as WorkspaceGrantId,
    displayPath: assertNonBlank(value.displayPath, "Workspace display path", 4096),
    status: value.status,
    entries: freezeEntries(entries),
    ignorePatterns: normalizeIgnorePatterns(ignorePatterns),
    generation: value.generation,
    stats,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(indexedAt === undefined ? {} : { indexedAt }),
    ...(lastError === undefined ? {} : { lastError }),
  });
}

export function serializeWorkspaceIndex(index: WorkspaceIndex): string {
  return JSON.stringify(index, null, 2);
}
