import { describe, expect, it } from "vitest";

import { createProjectRuntime, startProjectSession } from "./omnia-project-runtime";
import {
  buildProjectWorkbenchSnapshot,
  deserializeProjectWorkbenchSnapshot,
  selectProjectWorkbenchProject,
  serializeProjectWorkbenchSnapshot,
} from "./omnia-project-workbench-adapter";

describe("project workbench adapter", () => {
  it("projects the active runtime project and preserves unknown metadata", () => {
    const created = createProjectRuntime();
    const runtime = startProjectSession(
      {
        ...created,
        projects: [{
          id: "project-1",
          name: "Omnia",
          rootPath: "C:/workspace/omnia",
          lifecycle: "created",
          sessions: [],
          environmentKeys: ["NODE_ENV"],
          createdAt: "2026-10-17T00:00:00.000Z",
          updatedAt: "2026-10-17T00:00:00.000Z",
        }],
      },
      "project-1",
      "session-1",
      "runtime-1",
      "2026-10-17T01:00:00.000Z",
    );
    const snapshot = buildProjectWorkbenchSnapshot({
      runtime,
      now: "2026-10-17T01:01:00.000Z",
    });

    expect(snapshot.activeProjectId).toBe("project-1");
    expect(snapshot.selectedProjectId).toBe("project-1");
    expect(snapshot.projects[0]).toMatchObject({
      id: "project-1",
      name: "Omnia",
      conversationCount: null,
      environmentKeyCount: 1,
      sessions: { total: 1, active: 1, latestStatus: "running" },
      workspace: { indexCount: 0, entryCount: 0 },
    });
  });

  it("selects, serializes, and validates cards without granting authority", () => {
    const snapshot = buildProjectWorkbenchSnapshot({
      runtime: {
        version: 1,
        projects: [{
          id: "project-1",
          name: "Omnia",
          rootPath: "C:/workspace/omnia",
          lifecycle: "ready",
          sessions: [],
          environmentKeys: [],
          createdAt: "2026-10-17T00:00:00.000Z",
          updatedAt: "2026-10-17T00:00:00.000Z",
        }],
        activeProjectId: "project-1",
      },
      now: "2026-10-17T01:01:00.000Z",
    });
    const selected = selectProjectWorkbenchProject(snapshot, null);
    expect(selected.selectedProjectId).toBeNull();
    expect(deserializeProjectWorkbenchSnapshot(serializeProjectWorkbenchSnapshot(selected))).toEqual(selected);
    expect(() => selectProjectWorkbenchProject(snapshot, "missing")).toThrow(/Unknown project/);
    expect(() => deserializeProjectWorkbenchSnapshot({ ...selected, selectedProjectId: "missing" })).toThrow(/Selected project/);
  });
});
