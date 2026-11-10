import { describe, expect, it } from "vitest";

import type { ProjectRecord, WorkspaceGrantRecord } from "@/lib/desktop";

import { projectsFromNativeRecords, workspaceFolderFromNativeGrant } from "./project-catalog";
import type { ConversationView } from "./types";

const project: ProjectRecord = {
  id: "project_0123456789abcdef0123456789abcdef",
  name: "Native project",
  description: null,
  instructions: "Prefer primary sources.",
  createdAtMs: 1,
  updatedAtMs: 2,
};

const activeGrant: WorkspaceGrantRecord = {
  id: "workspace_0123456789abcdef0123456789abcdef",
  projectId: project.id,
  displayPath: "C:\\Work\\Omnia",
  displayName: "Omnia",
  readOnly: true,
  createdAtMs: 3,
  updatedAtMs: 4,
  revokedAtMs: null,
};

describe("native project catalog", () => {
  it("maps an active native grant without claiming that indexing has run", () => {
    expect(workspaceFolderFromNativeGrant(activeGrant)).toEqual({
      id: activeGrant.id,
      displayName: "Omnia",
      canonicalPath: "C:\\Work\\Omnia",
      state: "referenced",
      scope: "read-only",
      fileCount: null,
      chunkCount: null,
      lastIndexedAt: null,
      localOnly: true,
    });
  });

  it("hydrates only grants assigned to each project and derives persisted conversation counts", () => {
    const revokedGrant: WorkspaceGrantRecord = {
      ...activeGrant,
      id: "workspace_11111111111111111111111111111111",
      revokedAtMs: 5,
    };
    const unrelatedGrant: WorkspaceGrantRecord = {
      ...activeGrant,
      id: "workspace_22222222222222222222222222222222",
      projectId: "project_22222222222222222222222222222222",
    };
    const conversations = [
      { projectId: project.id },
      { projectId: project.id },
      { projectId: null },
    ] as ConversationView[];

    const [hydrated] = projectsFromNativeRecords(
      [project],
      [activeGrant, revokedGrant, unrelatedGrant],
      conversations,
    );

    expect(hydrated).toMatchObject({
      id: project.id,
      name: "Native project",
      description: "",
      instructions: "Prefer primary sources.",
      conversationCount: 2,
      contextHealth: "not-compiled",
    });
    expect(hydrated?.folders.map((folder) => folder.id)).toEqual([activeGrant.id]);
  });

  it("does not imply that skills, retrieval, or context compilation ran for native projects", () => {
    const [hydrated] = projectsFromNativeRecords([project], [activeGrant], []);

    expect(hydrated).toMatchObject({
      contextHealth: "not-compiled",
      folders: [
        expect.objectContaining({
          state: "referenced",
          fileCount: null,
          chunkCount: null,
          lastIndexedAt: null,
        }),
      ],
    });
  });
});
