import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PERMISSION_VALUES,
  diffPermissionValues,
  getPermissionSession,
  permissionHistoryDiffs,
  permissionScopeExpansions,
  resetPermissionSession,
  redoPermissionPreview,
  replacePermissionValuesForAllScopes,
  setPermissionScope,
  undoPermissionPreview,
  updatePermissionValues,
} from "./session-permission-contract";

describe("session permission contract", () => {
  afterEach(() => resetPermissionSession());

  it("keeps an independent undo and redo history for each renderer scope", () => {
    updatePermissionValues({ "execution.terminal": "allow" });
    setPermissionScope("project");
    updatePermissionValues({ "execution.terminal": "deny" });

    undoPermissionPreview();
    expect(getPermissionSession().present["execution.terminal"]).toBe("prompt");

    setPermissionScope("workspace");
    expect(getPermissionSession().present["execution.terminal"]).toBe("allow");
    undoPermissionPreview();
    expect(getPermissionSession().present["execution.terminal"]).toBe("prompt");

    setPermissionScope("project");
    redoPermissionPreview();
    expect(getPermissionSession().present["execution.terminal"]).toBe("deny");
  });

  it("flags a narrower draft that becomes more permissive without treating it as a grant", () => {
    setPermissionScope("project");
    updatePermissionValues({ "execution.terminal": "allow" });

    const expansions = permissionScopeExpansions(getPermissionSession().valuesByScope);
    expect(expansions).toContainEqual({
      scope: "project",
      parentScope: "workspace",
      permissionId: "execution.terminal",
      parentMode: "prompt",
      mode: "allow",
    });
  });

  it("applies a preview preset to every scope while preserving per-scope undo", () => {
    setPermissionScope("project");
    updatePermissionValues({ "execution.terminal": "allow" });
    setPermissionScope("workspace");

    replacePermissionValuesForAllScopes({ "execution.terminal": "deny" });

    const afterApply = getPermissionSession();
    expect(afterApply.valuesByScope.workspace["execution.terminal"]).toBe("deny");
    expect(afterApply.valuesByScope.project["execution.terminal"]).toBe("deny");
    expect(afterApply.historyByScope.workspace.past).toHaveLength(1);
    expect(afterApply.historyByScope.project.past).toHaveLength(2);

    undoPermissionPreview();
    expect(getPermissionSession().present["execution.terminal"]).toBe("prompt");
    setPermissionScope("project");
    undoPermissionPreview();
    expect(getPermissionSession().present["execution.terminal"]).toBe("allow");
  });

  it("groups permission changes into added, removed, and mode-changed entries", () => {
    const diff = diffPermissionValues(DEFAULT_PERMISSION_VALUES, {
      ...DEFAULT_PERMISSION_VALUES,
      "files.delete": "allow",
      "files.read": "deny",
      "network.public": "allow",
    });

    expect(diff.added.map((entry) => entry.permissionId)).toEqual(["files.delete"]);
    expect(diff.removed.map((entry) => entry.permissionId)).toEqual(["files.read"]);
    expect(diff.changed.map((entry) => entry.permissionId)).toEqual(["network.public"]);
    expect(diff.highRiskIncreases.map((entry) => entry.permissionId)).toEqual(["files.delete"]);
    expect(diff.changedCount).toBe(3);
  });

  it("projects newest-last renderer history diffs without mutating the session", () => {
    updatePermissionValues({ "execution.terminal": "allow" });
    updatePermissionValues({ "network.public": "allow" });

    const session = getPermissionSession();
    const diffs = permissionHistoryDiffs(session.historyByScope.workspace, session.present);

    expect(diffs).toHaveLength(2);
    expect(diffs[0]?.diff.changed.map((entry) => entry.permissionId)).toEqual(["execution.terminal"]);
    expect(diffs[1]?.diff.changed.map((entry) => entry.permissionId)).toEqual(["network.public"]);
    expect(getPermissionSession().present["execution.terminal"]).toBe("allow");
  });

  it("keeps each Project renderer draft and undo history isolated", () => {
    const alpha = "project:alpha";
    const beta = "project:beta";
    setPermissionScope("project", alpha);
    updatePermissionValues({ "execution.terminal": "allow" }, alpha);

    expect(getPermissionSession(alpha).present["execution.terminal"]).toBe("allow");
    expect(getPermissionSession(beta).present["execution.terminal"]).toBe("prompt");
    expect(getPermissionSession().present["execution.terminal"]).toBe("prompt");

    undoPermissionPreview(alpha);
    expect(getPermissionSession(alpha).present["execution.terminal"]).toBe("prompt");
    expect(getPermissionSession(beta).historyByScope.project.past).toHaveLength(0);
  });
});
