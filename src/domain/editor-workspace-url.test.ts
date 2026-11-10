import { describe, expect, it } from "vitest";

import { EDITOR_SERVER_ORIGIN, editorWorkspaceUrl } from "./editor-workspace-url";

describe("editorWorkspaceUrl", () => {
  it("uses the actual workspace path and keeps special characters in one query value", () => {
    const path = "D:\\Projects\\Ứng dụng #1 & tools\\current.code-workspace";
    const url = new URL(editorWorkspaceUrl({ workspacePath: path }));
    expect(url.origin).toBe(EDITOR_SERVER_ORIGIN);
    expect(url.searchParams.get("workspace")).toBe("/d:/Projects/Ứng dụng #1 & tools/current.code-workspace");
    expect([...url.searchParams.keys()]).toEqual(["workspace"]);
    expect(url.hash).toBe("");
  });

  it("encodes a selected folder without treating its ampersand or fragment as navigation", () => {
    const url = new URL(editorWorkspaceUrl({ folderPath: "C:\\Work\\a & b#c" }));
    expect(url.searchParams.get("folder")).toBe("/c:/Work/a & b#c");
    expect(url.searchParams.size).toBe(1);
    expect(url.hash).toBe("");
  });

  it("retains POSIX paths and opens the editor start page when no workspace is available", () => {
    expect(new URL(editorWorkspaceUrl({ folderPath: "/home/user/Project One" })).searchParams.get("folder")).toBe("/home/user/Project One");
    expect(editorWorkspaceUrl({})).toBe(`${EDITOR_SERVER_ORIGIN}/`);
  });
});
