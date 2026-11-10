import type { WorkspaceIndex } from "@/domain/omnia-workspace-index";
import {
  buildProjectWorkbenchSnapshot,
  type ProjectWorkbenchProjectInput,
  type ProjectWorkbenchSnapshot,
} from "@/domain/omnia-project-workbench-adapter";
import type { ProjectRecord, ProjectRuntime } from "@/domain/omnia-project-runtime";

import type { ConversationView, ProjectView } from "./types";

/**
 * Inputs needed to build the renderer-side Project Workbench projection.
 *
 * The workbench adapter deliberately consumes the small domain runtime shape,
 * while the renderer owns a richer `ProjectView`. This bridge keeps that
 * conversion explicit and preview-safe: folders are not treated as indexed
 * workspaces unless a real `WorkspaceIndex` is supplied by the caller.
 */
export interface ProjectWorkbenchProjectionInput {
  readonly projects: readonly ProjectView[];
  readonly conversations?: readonly ConversationView[];
  readonly workspaceIndexesByProjectId?: Readonly<Record<string, readonly WorkspaceIndex[]>>;
  readonly activeProjectId?: string | null;
  readonly selectedProjectId?: string | null;
  /** Fixed timestamp used for deterministic previews and tests. */
  readonly now: string;
}

function assertTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be a valid ISO timestamp`);
  }
  return value;
}

function timestampFromProject(project: ProjectView, fallback: string): string {
  const nativeUpdatedAtMs = project.nativeUpdatedAtMs;
  if (typeof nativeUpdatedAtMs !== "number" || !Number.isFinite(nativeUpdatedAtMs)) return fallback;
  const date = new Date(nativeUpdatedAtMs);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function lifecycleFromProject(project: ProjectView): ProjectRecord["lifecycle"] {
  if (project.archived === true) return "archived";
  // Context readiness is renderer metadata, not proof that a native process is
  // running. The `running` mapping is retained only for the visible indexing
  // state; all other non-authoritative states remain `created`.
  if (project.contextHealth === "indexing") return "running";
  if (project.contextHealth === "ready") return "ready";
  return "created";
}

function rootPathFromProject(project: ProjectView): string {
  return project.folders.find((folder) => folder.canonicalPath.trim().length > 0)?.canonicalPath.trim() ?? "";
}

function projectRecordFromView(project: ProjectView, now: string): ProjectRecord {
  if (!project.id.trim()) throw new Error("Project workbench project id cannot be blank");
  const name = project.name.trim() || "Untitled project";
  const updatedAt = timestampFromProject(project, now);
  return {
    id: project.id,
    name,
    rootPath: rootPathFromProject(project),
    lifecycle: lifecycleFromProject(project),
    sessions: [],
    environmentKeys: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

function activeProjectIdForRuntime(
  projects: readonly ProjectRecord[],
  requested: string | null | undefined,
): string | undefined {
  if (requested === null || requested === undefined) return undefined;
  return projects.some((project) => project.id === requested) ? requested : undefined;
}

function runtimeAndMetadata(input: ProjectWorkbenchProjectionInput): {
  readonly runtime: ProjectRuntime;
  readonly metadata: readonly ProjectWorkbenchProjectInput[];
} {
  const now = assertTimestamp(input.now, "Project workbench projection time");
  const records = input.projects.map((project) => projectRecordFromView(project, now));
  const recordIds = new Set(records.map((project) => project.id));
  if (recordIds.size !== records.length) throw new Error("Project workbench project ids must be unique");

  const activeProjectId = activeProjectIdForRuntime(records, input.activeProjectId);
  const runtime: ProjectRuntime = {
    version: 1,
    projects: records,
    ...(activeProjectId === undefined ? {} : { activeProjectId }),
  };
  const indexesByProjectId = input.workspaceIndexesByProjectId;
  const metadata = input.projects.map((project, index) => {
    const record = records[index]!;
    const conversationCount = input.conversations === undefined
      ? Math.max(0, Math.trunc(project.conversationCount))
      : input.conversations.filter((conversation) => conversation.projectId === project.id).length;
    const workspaceIndexes = indexesByProjectId?.[project.id];
    return {
      ...record,
      conversationCount,
      ...(workspaceIndexes === undefined ? {} : { workspaceIndexes }),
    } satisfies ProjectWorkbenchProjectInput;
  });
  return { runtime, metadata };
}

/**
 * Convert renderer projects into the domain runtime shape used by the
 * workbench adapter. This is a projection only; it never writes native state.
 */
export function projectRuntimeFromViews(
  input: Pick<ProjectWorkbenchProjectionInput, "projects" | "activeProjectId" | "now">,
): ProjectRuntime {
  return runtimeAndMetadata(input).runtime;
}

/**
 * Build a complete workbench snapshot from renderer projects and conversations.
 * Native runtime/session/index data stays unknown unless explicitly supplied.
 */
export function buildProjectWorkbenchSnapshotFromViews(
  input: ProjectWorkbenchProjectionInput,
): ProjectWorkbenchSnapshot {
  const { runtime, metadata } = runtimeAndMetadata(input);
  return buildProjectWorkbenchSnapshot({
    runtime,
    projects: metadata,
    ...(input.selectedProjectId === undefined ? {} : { selectedProjectId: input.selectedProjectId }),
    now: input.now,
  });
}

