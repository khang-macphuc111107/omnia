import type { ProjectRecord, ProjectRuntime, ProjectSession, ProjectSessionStatus } from "./omnia-project-runtime";
import type { WorkspaceIndex } from "./omnia-workspace-index";

/** Version of the renderer/native-safe project workbench projection. */
export const PROJECT_WORKBENCH_ADAPTER_SCHEMA_VERSION = 1 as const;

export type ProjectWorkbenchLifecycle = ProjectRecord["lifecycle"];

export interface ProjectWorkbenchProjectInput extends ProjectRecord {
  /** Optional read-only indexes hydrated by the native workspace layer. */
  readonly workspaceIndexes?: readonly WorkspaceIndex[];
  /** Optional count from the conversation projection; never inferred here. */
  readonly conversationCount?: number;
}

export interface ProjectWorkbenchWorkspaceSummary {
  readonly indexCount: number;
  readonly readyCount: number;
  readonly staleCount: number;
  readonly failedCount: number;
  readonly entryCount: number;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface ProjectWorkbenchSessionSummary {
  readonly total: number;
  readonly active: number;
  readonly failed: number;
  readonly latestStatus: ProjectSessionStatus | null;
  readonly latestStartedAt: string | null;
  readonly latestEndedAt: string | null;
}

export interface ProjectWorkbenchCard {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly lifecycle: ProjectWorkbenchLifecycle;
  readonly environmentKeyCount: number;
  readonly conversationCount: number | null;
  readonly sessions: ProjectWorkbenchSessionSummary;
  readonly workspace: ProjectWorkbenchWorkspaceSummary;
  readonly updatedAt: string;
}

export interface ProjectWorkbenchSnapshot {
  readonly version: typeof PROJECT_WORKBENCH_ADAPTER_SCHEMA_VERSION;
  readonly activeProjectId: string | null;
  readonly selectedProjectId: string | null;
  readonly projects: readonly ProjectWorkbenchCard[];
  readonly generatedAt: string;
}

export interface BuildProjectWorkbenchSnapshotInput {
  readonly runtime: ProjectRuntime;
  readonly projects?: readonly ProjectWorkbenchProjectInput[];
  readonly selectedProjectId?: string | null;
  readonly now: string;
}

const PROJECT_LIFECYCLES: readonly ProjectWorkbenchLifecycle[] = [
  "created",
  "ready",
  "running",
  "paused",
  "stopped",
  "archived",
];

const PROJECT_SESSION_STATUSES: readonly ProjectSessionStatus[] = [
  "idle",
  "running",
  "paused",
  "stopped",
  "failed",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function assertTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be a valid ISO timestamp`);
  }
  return value;
}

function assertNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function assertProjectId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-blank string`);
  }
  return value;
}

function assertOptionalTimestamp(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return assertTimestamp(value as string, label);
}

function assertSession(session: unknown, label: string): ProjectSession {
  if (!isRecord(session)) throw new Error(`${label} must be an object`);
  const id = assertProjectId(session.id, `${label}.id`);
  if (!isOneOf(PROJECT_SESSION_STATUSES, session.status)) {
    throw new Error(`${label}.status is invalid`);
  }
  const startedAt = assertOptionalTimestamp(session.startedAt, `${label}.startedAt`);
  const endedAt = assertOptionalTimestamp(session.endedAt, `${label}.endedAt`);
  const runtimeId = session.runtimeId === undefined
    ? undefined
    : assertProjectId(session.runtimeId, `${label}.runtimeId`);
  return {
    id,
    status: session.status,
    ...(startedAt === null ? {} : { startedAt }),
    ...(endedAt === null ? {} : { endedAt }),
    ...(runtimeId === undefined ? {} : { runtimeId }),
  };
}

function assertWorkspaceStats(stats: unknown, label: string): WorkspaceIndex["stats"] {
  if (!isRecord(stats)) throw new Error(`${label} must be an object`);
  return {
    entryCount: assertNonNegativeInteger(stats.entryCount as number, `${label}.entryCount`),
    fileCount: assertNonNegativeInteger(stats.fileCount as number, `${label}.fileCount`),
    directoryCount: assertNonNegativeInteger(stats.directoryCount as number, `${label}.directoryCount`),
    symlinkCount: assertNonNegativeInteger(stats.symlinkCount as number, `${label}.symlinkCount`),
    otherCount: assertNonNegativeInteger(stats.otherCount as number, `${label}.otherCount`),
    ignoredCount: assertNonNegativeInteger(stats.ignoredCount as number, `${label}.ignoredCount`),
    totalBytes: assertNonNegativeInteger(stats.totalBytes as number, `${label}.totalBytes`),
  };
}

function assertWorkspaceIndex(index: unknown, label: string): WorkspaceIndex {
  if (!isRecord(index)) throw new Error(`${label} must be an object`);
  if (index.version !== 1) throw new Error(`${label}.version is invalid`);
  if (!isOneOf(["idle", "indexing", "ready", "stale", "failed"] as const, index.status)) {
    throw new Error(`${label}.status is invalid`);
  }
  assertProjectId(index.grantId, `${label}.grantId`);
  if (typeof index.displayPath !== "string") throw new Error(`${label}.displayPath must be a string`);
  if (!Array.isArray(index.entries)) throw new Error(`${label}.entries must be an array`);
  if (!Array.isArray(index.ignorePatterns) || !index.ignorePatterns.every((value) => typeof value === "string")) {
    throw new Error(`${label}.ignorePatterns must be a string array`);
  }
  const generation = assertNonNegativeInteger(index.generation as number, `${label}.generation`);
  const stats = assertWorkspaceStats(index.stats, `${label}.stats`);
  const createdAt = assertTimestamp(index.createdAt as string, `${label}.createdAt`);
  const updatedAt = assertTimestamp(index.updatedAt as string, `${label}.updatedAt`);
  const indexedAt = assertOptionalTimestamp(index.indexedAt, `${label}.indexedAt`);
  const lastError = index.lastError === undefined ? undefined : String(index.lastError);
  return {
    version: 1,
    grantId: index.grantId as WorkspaceIndex["grantId"],
    displayPath: index.displayPath,
    status: index.status,
    entries: index.entries as WorkspaceIndex["entries"],
    ignorePatterns: index.ignorePatterns,
    generation,
    stats,
    createdAt,
    updatedAt,
    ...(indexedAt === null ? {} : { indexedAt }),
    ...(lastError === undefined ? {} : { lastError }),
  };
}

function latestSession(sessions: readonly ProjectSession[]): ProjectSession | null {
  return sessions.reduce<ProjectSession | null>((latest, session) => {
    if (!latest) return session;
    const latestStamp = latest.startedAt ?? latest.endedAt ?? "";
    const sessionStamp = session.startedAt ?? session.endedAt ?? "";
    return sessionStamp >= latestStamp ? session : latest;
  }, null);
}

function buildSessionSummary(sessions: readonly ProjectSession[]): ProjectWorkbenchSessionSummary {
  const latest = latestSession(sessions);
  return {
    total: sessions.length,
    active: sessions.filter((session) => session.status === "running" || session.status === "paused").length,
    failed: sessions.filter((session) => session.status === "failed").length,
    latestStatus: latest?.status ?? null,
    latestStartedAt: latest?.startedAt ?? null,
    latestEndedAt: latest?.endedAt ?? null,
  };
}

function buildWorkspaceSummary(indexes: readonly WorkspaceIndex[]): ProjectWorkbenchWorkspaceSummary {
  indexes.forEach((index, indexPosition) => {
    assertWorkspaceIndex(index, `Project workspace index ${indexPosition}`);
  });
  return {
    indexCount: indexes.length,
    readyCount: indexes.filter((index) => index.status === "ready").length,
    staleCount: indexes.filter((index) => index.status === "stale").length,
    failedCount: indexes.filter((index) => index.status === "failed").length,
    entryCount: indexes.reduce((total, index) => total + index.stats.entryCount, 0),
    fileCount: indexes.reduce((total, index) => total + index.stats.fileCount, 0),
    totalBytes: indexes.reduce((total, index) => total + index.stats.totalBytes, 0),
  };
}

function cardFromProject(project: ProjectWorkbenchProjectInput): ProjectWorkbenchCard {
  assertProjectId(project.id, "Project workbench project id");
  if (!project.name.trim()) throw new Error("Project workbench project name cannot be blank");
  if (typeof project.rootPath !== "string") throw new Error("Project workbench project rootPath must be a string");
  if (!isOneOf(PROJECT_LIFECYCLES, project.lifecycle)) throw new Error("Project workbench project lifecycle is invalid");
  if (!Array.isArray(project.sessions)) throw new Error("Project workbench project sessions must be an array");
  if (!Array.isArray(project.environmentKeys) || !project.environmentKeys.every((key) => typeof key === "string")) {
    throw new Error("Project workbench project environment keys must be a string array");
  }
  project.sessions.forEach((session, index) => assertSession(session, `Project session ${index}`));
  const sessionIds = new Set(project.sessions.map((session) => session.id));
  if (sessionIds.size !== project.sessions.length) throw new Error("Project workbench project session ids must be unique");
  assertTimestamp(project.updatedAt, "Project updatedAt");
  const conversationCount = project.conversationCount === undefined
    ? null
    : assertNonNegativeInteger(project.conversationCount, "Project conversation count");
  return Object.freeze({
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    lifecycle: project.lifecycle,
    environmentKeyCount: project.environmentKeys.length,
    conversationCount,
    sessions: buildSessionSummary(project.sessions),
    workspace: buildWorkspaceSummary(project.workspaceIndexes ?? []),
    updatedAt: project.updatedAt,
  });
}

/**
 * Build a deterministic, renderer-safe workbench projection. The optional
 * project metadata array can enrich runtime records with workspace indexes
 * and conversation counts, but omitted values remain explicitly unknown.
 */
export function buildProjectWorkbenchSnapshot(input: BuildProjectWorkbenchSnapshotInput): ProjectWorkbenchSnapshot {
  assertTimestamp(input.now, "Project workbench snapshot time");
  const runtimeProjectIds = new Set<string>();
  input.runtime.projects.forEach((project, index) => {
    assertProjectId(project.id, `Project runtime project ${index}.id`);
    if (runtimeProjectIds.has(project.id)) throw new Error(`Duplicate project runtime id: ${project.id}`);
    runtimeProjectIds.add(project.id);
  });
  const metadataById = new Map<string, ProjectWorkbenchProjectInput>();
  for (const [index, project] of (input.projects ?? []).entries()) {
    assertProjectId(project.id, `Project workbench metadata ${index}.id`);
    if (metadataById.has(project.id)) throw new Error(`Duplicate project workbench metadata id: ${project.id}`);
    if (!runtimeProjectIds.has(project.id)) throw new Error(`Unknown project workbench metadata id: ${project.id}`);
    metadataById.set(project.id, project);
  }
  const projects = input.runtime.projects.map((record) => {
    const metadata = metadataById.get(record.id);
    // Use explicit branches so an omitted optional field is truly omitted
    // (rather than represented as `field: undefined` under exact optional
    // property semantics).
    if (!metadata) return cardFromProject(record);
    if (metadata.workspaceIndexes !== undefined && metadata.conversationCount !== undefined) {
      return cardFromProject({
        ...record,
        workspaceIndexes: metadata.workspaceIndexes,
        conversationCount: metadata.conversationCount,
      });
    }
    if (metadata.workspaceIndexes !== undefined) {
      return cardFromProject({ ...record, workspaceIndexes: metadata.workspaceIndexes });
    }
    if (metadata.conversationCount !== undefined) {
      return cardFromProject({ ...record, conversationCount: metadata.conversationCount });
    }
    return cardFromProject(record);
  });
  const activeProjectId = input.runtime.activeProjectId ?? null;
  if (activeProjectId !== null && !projects.some((project) => project.id === activeProjectId)) {
    throw new Error(`Active project is not present in runtime: ${activeProjectId}`);
  }
  const selectedProjectId = input.selectedProjectId && projects.some((project) => project.id === input.selectedProjectId)
    ? input.selectedProjectId
    : activeProjectId && projects.some((project) => project.id === activeProjectId)
      ? activeProjectId
      : projects[0]?.id ?? null;
  return Object.freeze({
    version: PROJECT_WORKBENCH_ADAPTER_SCHEMA_VERSION,
    activeProjectId,
    selectedProjectId,
    projects: Object.freeze(projects),
    generatedAt: input.now,
  });
}

export function selectProjectWorkbenchProject(
  snapshot: ProjectWorkbenchSnapshot,
  projectId: string | null,
): ProjectWorkbenchSnapshot {
  if (projectId !== null && !snapshot.projects.some((project) => project.id === projectId)) {
    throw new Error(`Unknown project workbench project: ${projectId}`);
  }
  return Object.freeze({ ...snapshot, selectedProjectId: projectId });
}

export function serializeProjectWorkbenchSnapshot(snapshot: ProjectWorkbenchSnapshot): string {
  return JSON.stringify(snapshot);
}

export function deserializeProjectWorkbenchSnapshot(input: string | unknown): ProjectWorkbenchSnapshot {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid project workbench snapshot");
  const record = value as Record<string, unknown>;
  if (record.version !== PROJECT_WORKBENCH_ADAPTER_SCHEMA_VERSION || !Array.isArray(record.projects)) {
    throw new Error("Invalid project workbench snapshot version or projects");
  }
  if (record.activeProjectId !== null && typeof record.activeProjectId !== "string") throw new Error("Invalid active project id");
  if (record.selectedProjectId !== null && typeof record.selectedProjectId !== "string") throw new Error("Invalid selected project id");
  assertTimestamp(String(record.generatedAt), "Project workbench generatedAt");
  const ids = new Set<string>();
  const cards = record.projects.map((project, index) => {
    if (!isRecord(project)) throw new Error("Invalid project workbench card");
    const id = assertProjectId(project.id, `Project workbench card ${index}.id`);
    if (ids.has(id)) throw new Error("Invalid or duplicate project workbench card id");
    ids.add(id);
    if (typeof project.name !== "string" || !project.name.trim()) throw new Error(`Project workbench card ${index}.name is invalid`);
    if (typeof project.rootPath !== "string") throw new Error(`Project workbench card ${index}.rootPath is invalid`);
    if (!isOneOf(PROJECT_LIFECYCLES, project.lifecycle)) throw new Error(`Project workbench card ${index}.lifecycle is invalid`);
    const environmentKeyCount = assertNonNegativeInteger(project.environmentKeyCount as number, `Project workbench card ${index}.environmentKeyCount`);
    const conversationCount = project.conversationCount === null
      ? null
      : assertNonNegativeInteger(project.conversationCount as number, `Project workbench card ${index}.conversationCount`);
    const sessionsValue = project.sessions;
    if (!isRecord(sessionsValue)) throw new Error(`Project workbench card ${index}.sessions is invalid`);
    const total = assertNonNegativeInteger(sessionsValue.total as number, `Project workbench card ${index}.sessions.total`);
    const active = assertNonNegativeInteger(sessionsValue.active as number, `Project workbench card ${index}.sessions.active`);
    const failed = assertNonNegativeInteger(sessionsValue.failed as number, `Project workbench card ${index}.sessions.failed`);
    if (active > total || failed > total) throw new Error(`Project workbench card ${index}.sessions counts are invalid`);
    if (sessionsValue.latestStatus !== null && !isOneOf(PROJECT_SESSION_STATUSES, sessionsValue.latestStatus)) {
      throw new Error(`Project workbench card ${index}.sessions.latestStatus is invalid`);
    }
    const latestStartedAt = assertOptionalTimestamp(sessionsValue.latestStartedAt, `Project workbench card ${index}.sessions.latestStartedAt`);
    const latestEndedAt = assertOptionalTimestamp(sessionsValue.latestEndedAt, `Project workbench card ${index}.sessions.latestEndedAt`);
    const workspaceValue = project.workspace;
    if (!isRecord(workspaceValue)) throw new Error(`Project workbench card ${index}.workspace is invalid`);
    const workspace = {
      indexCount: assertNonNegativeInteger(workspaceValue.indexCount as number, `Project workbench card ${index}.workspace.indexCount`),
      readyCount: assertNonNegativeInteger(workspaceValue.readyCount as number, `Project workbench card ${index}.workspace.readyCount`),
      staleCount: assertNonNegativeInteger(workspaceValue.staleCount as number, `Project workbench card ${index}.workspace.staleCount`),
      failedCount: assertNonNegativeInteger(workspaceValue.failedCount as number, `Project workbench card ${index}.workspace.failedCount`),
      entryCount: assertNonNegativeInteger(workspaceValue.entryCount as number, `Project workbench card ${index}.workspace.entryCount`),
      fileCount: assertNonNegativeInteger(workspaceValue.fileCount as number, `Project workbench card ${index}.workspace.fileCount`),
      totalBytes: assertNonNegativeInteger(workspaceValue.totalBytes as number, `Project workbench card ${index}.workspace.totalBytes`),
    };
    if (workspace.readyCount + workspace.staleCount + workspace.failedCount > workspace.indexCount) {
      throw new Error(`Project workbench card ${index}.workspace status counts are invalid`);
    }
    return Object.freeze({
      id,
      name: project.name,
      rootPath: project.rootPath,
      lifecycle: project.lifecycle,
      environmentKeyCount,
      conversationCount,
      sessions: Object.freeze({
        total,
        active,
        failed,
        latestStatus: sessionsValue.latestStatus,
        latestStartedAt,
        latestEndedAt,
      }),
      workspace: Object.freeze(workspace),
      updatedAt: assertTimestamp(project.updatedAt as string, `Project workbench card ${index}.updatedAt`),
    });
  });
  if (record.activeProjectId !== null && !ids.has(record.activeProjectId)) throw new Error("Active project is not present in snapshot");
  if (record.selectedProjectId !== null && !ids.has(record.selectedProjectId)) throw new Error("Selected project is not present in snapshot");
  return Object.freeze({
    version: PROJECT_WORKBENCH_ADAPTER_SCHEMA_VERSION,
    activeProjectId: record.activeProjectId as string | null,
    selectedProjectId: record.selectedProjectId as string | null,
    projects: Object.freeze(cards),
    generatedAt: record.generatedAt as string,
  });
}

export interface ProjectWorkbenchAdapter {
  readonly version: typeof PROJECT_WORKBENCH_ADAPTER_SCHEMA_VERSION;
  readonly build: (input: BuildProjectWorkbenchSnapshotInput) => ProjectWorkbenchSnapshot;
  readonly select: (snapshot: ProjectWorkbenchSnapshot, projectId: string | null) => ProjectWorkbenchSnapshot;
}

export function createProjectWorkbenchAdapter(): ProjectWorkbenchAdapter {
  return Object.freeze({
    version: PROJECT_WORKBENCH_ADAPTER_SCHEMA_VERSION,
    build: buildProjectWorkbenchSnapshot,
    select: selectProjectWorkbenchProject,
  });
}
