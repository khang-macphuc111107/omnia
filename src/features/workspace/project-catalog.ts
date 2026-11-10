import type { ProjectRecord, WorkspaceGrantRecord } from "@/lib/desktop";

import type {
  ConversationView,
  ProjectOverviewView,
  ProjectView,
  WorkspaceFolderView,
} from "./types";

/**
 * Project marks intentionally use a separate, readable accent family instead
 * of borrowing the semantic brand color. This keeps the shell coherent while
 * making projects easy to scan at a glance. Every value is dark enough for
 * the existing white initial-letter treatment.
 */
const PROJECT_ACCENTS = [
  "#52525b", // zinc 600
  "#71717a", // zinc 500
  "#a1a1aa", // zinc 400
  "#3f3f46", // zinc 700
  "#475569", // slate 600
  "#64748b", // slate 500
] as const;

export function accentForProject(projectId: string): string {
  let hash = 0;
  for (const character of projectId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return PROJECT_ACCENTS[hash % PROJECT_ACCENTS.length] ?? PROJECT_ACCENTS[0];
}

export function workspaceFolderFromNativeGrant(
  grant: WorkspaceGrantRecord,
): WorkspaceFolderView {
  return {
    id: grant.id,
    displayName: grant.displayName,
    canonicalPath: grant.displayPath,
    state: "referenced",
    scope: "read-only",
    fileCount: null,
    chunkCount: null,
    lastIndexedAt: null,
    localOnly: true,
  };
}

/**
 * Build a conservative overview until native overview revisions are hydrated.
 *
 * Project metadata is safe to display as a summary, but it is not a Project
 * Twin revision and it does not prove that a goal, branch, index, runtime, or
 * verified evidence exists. Those fields intentionally stay unknown.
 */
export function projectOverviewFromProject(project: {
  id: string;
  name: string;
  description: string;
  folders: readonly WorkspaceFolderView[];
}): ProjectOverviewView {
  return {
    overviewRevisionId: null,
    projectTwinRevisionId: null,
    sourceEventWatermark: null,
    status: "unknown",
    title: project.name || null,
    subtitle: null,
    summary: project.description || null,
    goal: null,
    nonGoals: [],
    phase: null,
    milestone: null,
    nextTask: null,
    activeBranch: null,
    workspaceRootCount: project.folders.length,
    repositoryBranch: null,
    worktree: null,
    verifiedEvidence: [],
    staleNodeCount: null,
    runtimeLabel: null,
    modelProfileId: null,
    contextRevisionId: null,
    budgetLabel: null,
    backgroundWorkLabel: null,
    approvalsLabel: null,
    attentionItems: [],
    recentChanges: [],
  };
}

export function projectFromNativeRecord(
  record: ProjectRecord,
  grants: readonly WorkspaceGrantRecord[],
  conversations: readonly ConversationView[],
): ProjectView {
  const folders = grants
    .filter((grant) => grant.revokedAtMs === null && grant.projectId === record.id)
    .map(workspaceFolderFromNativeGrant);

  const projectView: ProjectView = {
    id: record.id,
    name: record.name,
    description: record.description ?? "",
    accent: accentForProject(record.id),
    instructions: record.instructions ?? "",
    nativeUpdatedAtMs: record.updatedAtMs,
    modelProfileId: "auto",
    conversationCount: conversations.filter((conversation) => conversation.projectId === record.id)
      .length,
    contextHealth: "not-compiled",
    pinned: false,
    folders,
  };

  projectView.overview = projectOverviewFromProject(projectView);
  return projectView;
}

export function projectsFromNativeRecords(
  records: readonly ProjectRecord[],
  grants: readonly WorkspaceGrantRecord[],
  conversations: readonly ConversationView[],
): ProjectView[] {
  return records.map((record) => projectFromNativeRecord(record, grants, conversations));
}
