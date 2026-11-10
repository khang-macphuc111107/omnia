import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktop } from "@/lib/desktop";
import { nativeProjectContextService } from "./context-service";
import { CONTEXT_INDEX_OPTIONS, CONTEXT_RETRIEVAL_OPTIONS } from "./context-model";
import { GRANT, PROJECT, indexSnapshot, preparedRun } from "./__tests__/context-fixtures";

vi.mock("@/lib/desktop", () => ({
  isDesktopRuntime: () => true,
  desktop: {
    runtimeInfo: vi.fn().mockResolvedValue({ appVersion: "test-native" }), initializeCore: vi.fn().mockResolvedValue({}),
    pickProjectFiles: vi.fn(), listProjectFilePointers: vi.fn(), refreshProjectFilePointer: vi.fn(), readProjectFilePointer: vi.fn(), listProjectFilePointerReceipts: vi.fn(),
    pickWorkspaceFolder: vi.fn(), listWorkspaceGrants: vi.fn(), buildWorkspaceIndex: vi.fn(), retrieveWorkspaceChunks: vi.fn(), retrieveWorkspaceForRun: vi.fn(),
  },
}));

beforeEach(() => { vi.clearAllMocks(); window.__TAURI_INTERNALS__ = { invoke: () => undefined }; });

describe("native project context service adapter", () => {
  it("maps every supported operation to the existing typed desktop method", async () => {
    const service = nativeProjectContextService(); expect(service.available).toBe(true);
    await service.initialize(); await service.initialize(); expect(desktop.initializeCore).toHaveBeenCalledOnce();
    await service.pickFiles(PROJECT); expect(desktop.pickProjectFiles).toHaveBeenCalledWith(PROJECT);
    await service.listPointers(PROJECT); expect(desktop.listProjectFilePointers).toHaveBeenCalledWith(PROJECT);
    await service.refreshPointer(PROJECT, "pointer-a", 3); expect(desktop.refreshProjectFilePointer).toHaveBeenCalledWith(PROJECT, "pointer-a", 3);
    await service.readPointer(PROJECT, "pointer-a", 3); expect(desktop.readProjectFilePointer).toHaveBeenCalledWith(PROJECT, "pointer-a", 3);
    await service.listPointerReceipts(PROJECT, "pointer-a"); expect(desktop.listProjectFilePointerReceipts).toHaveBeenCalledWith(PROJECT, "pointer-a");
    await service.pickFolder(PROJECT); expect(desktop.pickWorkspaceFolder).toHaveBeenCalledWith(PROJECT);
    await service.listGrants(PROJECT); expect(desktop.listWorkspaceGrants).toHaveBeenCalledWith(PROJECT);
    await service.buildIndex(GRANT, PROJECT, CONTEXT_INDEX_OPTIONS); expect(desktop.buildWorkspaceIndex).toHaveBeenCalledWith(GRANT, PROJECT, CONTEXT_INDEX_OPTIONS);
    await service.retrieve(indexSnapshot().chunks, "hello", CONTEXT_RETRIEVAL_OPTIONS); expect(desktop.retrieveWorkspaceChunks).toHaveBeenCalledWith(indexSnapshot().chunks, "hello", CONTEXT_RETRIEVAL_OPTIONS);
    const request = { ...preparedRun, grantId: GRANT, query: "hello" }; await service.retrieveForRun(request); expect(desktop.retrieveWorkspaceForRun).toHaveBeenCalledWith(request);
  });

  it("reinitializes after an explicit later attempt when bootstrap failed", async () => {
    vi.mocked(desktop.initializeCore).mockRejectedValueOnce(new Error("locked core")); const service = nativeProjectContextService();
    await expect(service.initialize()).rejects.toThrow("locked core"); await service.initialize();
    expect(desktop.initializeCore).toHaveBeenCalledTimes(2);
  });

  it("shares native mutation authority across adapter instances created by reopened panels", () => {
    const first = nativeProjectContextService(); const reopened = nativeProjectContextService();
    expect(first).not.toBe(reopened); expect(first.mutationAuthority).toBeDefined(); expect(first.mutationAuthority).toBe(reopened.mutationAuthority);
  });
});
