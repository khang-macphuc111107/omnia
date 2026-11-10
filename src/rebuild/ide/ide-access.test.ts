import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdeAccess } from "./ide-access";
import type { IdeDocument } from "./ide-model";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listGrants: vi.fn(), initialize: vi.fn() }));
vi.mock("@/lib/desktop", () => ({
  invokeCore: mocks.invoke,
  desktop: {
    runtimeInfo: vi.fn(async () => ({ appVersion: "test" })),
    initializeCore: mocks.initialize,
    listWorkspaceGrants: mocks.listGrants,
  },
}));

const hash1 = "1".repeat(64);
const hash2 = "2".repeat(64);
const nativeFile = { grantId: "workspace_test", relativePath: "file.txt", content: "before\r\n", contentSha256: hash1, byteSize: 8 };
const nativeDoc: IdeDocument = { id: "workspace_test:file.txt", rootId: "workspace_test", relativePath: "file.txt", name: "file.txt", origin: "native", content: nativeFile.content, version: hash1, saveMode: "original" };

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: vi.fn() } });
  mocks.initialize.mockResolvedValue({});
  mocks.listGrants.mockResolvedValue([{ id: "workspace_test", displayName: "sample", displayPath: "C:/sample", readOnly: true, revokedAtMs: null }]);
});
afterEach(() => { vi.resetAllMocks(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

describe("native IDE access", () => {
  it("keeps reads read-only until explicit session write approval succeeds", async () => {
    mocks.invoke.mockResolvedValueOnce(nativeFile).mockResolvedValueOnce({ grantId: "workspace_test", permissionId: "approval", scope: "session" }).mockResolvedValueOnce(nativeFile);
    const access = createIdeAccess();
    const first = await access.readFile({ rootId: "workspace_test", relativePath: "file.txt" });
    expect(first.saveMode).toBe("copy");
    expect(await access.requestWriteAccess?.("workspace_test")).toBe(true);
    expect((await access.readFile({ rootId: "workspace_test", relativePath: "file.txt" })).saveMode).toBe("original");
    expect(mocks.invoke).toHaveBeenCalledWith("ide_write_permission_request", { request: { grantId: "workspace_test" } });
    expect((await access.listRoots())[0]?.readOnly).toBe(false);
  });

  it("treats a canceled native permission dialog as read-only", async () => {
    mocks.invoke.mockResolvedValueOnce(null);
    const access = createIdeAccess();
    expect(await access.requestWriteAccess?.("workspace_test")).toBe(false);
    await expect(access.saveFile(nativeDoc, nativeDoc.content, "after")).rejects.toMatchObject({ code: "permission_denied" });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("submits the expected disk hash and verifies the native saved receipt", async () => {
    mocks.invoke.mockResolvedValueOnce({ grantId: "workspace_test", permissionId: "approval", scope: "session" }).mockResolvedValueOnce({ status: "saved", file: { ...nativeFile, content: "after", byteSize: 5, contentSha256: hash2 }, receiptId: "save-1" });
    const access = createIdeAccess();
    await access.requestWriteAccess?.("workspace_test");
    const saved = await access.saveFile(nativeDoc, nativeDoc.content, "after");
    expect(saved.content).toBe("after");
    expect(saved.version).toBe(hash2);
    expect(mocks.invoke).toHaveBeenCalledWith("ide_text_file_write", { request: { grantId: "workspace_test", permissionId: "approval", relativePath: "file.txt", expectedContentSha256: hash1, content: "after" } });
  });

  it.each([['conflict', 'save_conflict'], ['missing', 'source_missing']] as const)("retains a typed %s result without retry", async (status, code) => {
    mocks.invoke.mockResolvedValueOnce({ grantId: "workspace_test", permissionId: "approval", scope: "session" }).mockResolvedValueOnce({ status, receiptId: "rejected" });
    const access = createIdeAccess();
    await access.requestWriteAccess?.("workspace_test");
    await expect(access.saveFile(nativeDoc, nativeDoc.content, "after")).rejects.toMatchObject({ code });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("rejects a native success receipt for a different path or submitted content", async () => {
    mocks.invoke.mockResolvedValueOnce({ grantId: "workspace_test", permissionId: "approval", scope: "session" }).mockResolvedValueOnce({ status: "saved", file: { ...nativeFile, relativePath: "other.txt", content: "after" }, receiptId: "save" });
    const access = createIdeAccess();
    await access.requestWriteAccess?.("workspace_test");
    await expect(access.saveFile(nativeDoc, nativeDoc.content, "after")).rejects.toMatchObject({ code: "scope_mismatch" });
  });

  it("rejects traversal before invoking native and fails closed on stale local baselines", async () => {
    const access = createIdeAccess();
    await expect(access.readFile({ rootId: "workspace_test", relativePath: "../file.txt" })).rejects.toMatchObject({ code: "invalid_path" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
