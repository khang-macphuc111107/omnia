import { describe, expect, it } from "vitest";

import type { ProjectView } from "./types";
import {
  buildProjectWorkbenchSnapshotFromViews,
  projectRuntimeFromViews,
} from "./project-workbench-projection";

const NOW = "2026-10-17T10:00:00.000Z";

function project(overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    id: "project-1",
    name: "Omnia",
    description: "",
    accent: "#2563EB",
    instructions: "",
    nativeUpdatedAtMs: Date.parse("2026-10-17T09:00:00.000Z"),
    modelProfileId: "auto",
    conversationCount: 3,
    contextHealth: "ready",
    pinned: false,
    folders: [{
      id: "grant-1",
      displayName: "Omnia",
      canonicalPath: "C:/workspace/omnia",
      state: "referenced",
      scope: "read-only",
      fileCount: null,
      chunkCount: null,
      lastIndexedAt: null,
      localOnly: true,
    }],
    ...overrides,
  };
}

function projectWithoutNativeTimestamp(): ProjectView {
  const value = project();
  const { nativeUpdatedAtMs: _nativeUpdatedAtMs, ...withoutNativeTimestamp } = value;
  return withoutNativeTimestamp;
}

describe("project workbench renderer bridge", () => {
  it("maps project metadata without claiming native sessions or indexes", () => {
    const snapshot = buildProjectWorkbenchSnapshotFromViews({
      projects: [project()],
      conversations: [
        { projectId: "project-1" } as never,
        { projectId: "other-project" } as never,
      ],
      activeProjectId: "project-1",
      selectedProjectId: "project-1",
      now: NOW,
    });

    expect(snapshot).toMatchObject({
      activeProjectId: "project-1",
      selectedProjectId: "project-1",
      generatedAt: NOW,
      projects: [{
        id: "project-1",
        name: "Omnia",
        rootPath: "C:/workspace/omnia",
        lifecycle: "ready",
        conversationCount: 1,
        sessions: { total: 0, active: 0, failed: 0 },
        workspace: { indexCount: 0, entryCount: 0, fileCount: 0 },
      }],
    });
  });

  it("keeps invalid active ids out of the runtime and falls back safely", () => {
    const runtime = projectRuntimeFromViews({
      projects: [projectWithoutNativeTimestamp()],
      activeProjectId: "missing",
      now: NOW,
    });

    expect(runtime.activeProjectId).toBeUndefined();
    expect(runtime.projects[0]).toMatchObject({
      createdAt: NOW,
      updatedAt: NOW,
      lifecycle: "ready",
    });
  });

  it("maps archived and indexing states while preserving explicit selection rules", () => {
    const snapshot = buildProjectWorkbenchSnapshotFromViews({
      projects: [
        project({ id: "project-1", archived: true }),
        project({ id: "project-2", contextHealth: "indexing", name: "Indexing" }),
      ],
      activeProjectId: "project-2",
      selectedProjectId: "missing",
      now: NOW,
    });

    expect(snapshot.activeProjectId).toBe("project-2");
    expect(snapshot.selectedProjectId).toBe("project-2");
    expect(snapshot.projects.map((item) => item.lifecycle)).toEqual(["archived", "running"]);
  });
});
