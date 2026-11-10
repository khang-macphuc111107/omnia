import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCoreSessionForTests } from "@/lib/desktop";
import { ProjectContextController } from "./context-controller";
import { nativeProjectContextService } from "./context-service";
import { CONTEXT_INDEX_OPTIONS, CONTEXT_RETRIEVAL_OPTIONS } from "./context-model";
import { GRANT, PROJECT, SESSION, grant, indexSnapshot, pointer, preparedRun } from "./__tests__/context-fixtures";

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }));
const fixtureHeader = { headers: { "x-omnia-session": "a".repeat(64) } };

beforeEach(() => {
  __resetCoreSessionForTests(); ipc.invoke.mockReset(); window.__TAURI_INTERNALS__ = { invoke: ipc.invoke };
  ipc.invoke.mockImplementation(async (command: string) => {
    if (command === "runtime_info") return { appName: "Omnia", appVersion: "test", platform: "windows", tauri: true, debug: true };
    if (command === "core_initialize") return { protocolVersion: "1.0", serverInfo: { name: "test", title: "test", version: "test" }, capabilities: ["run.stream.v1"], unavailableCapabilities: [], sessionToken: "a".repeat(64), sessionEpoch: 1 };
    if (command === "project_file_pointer_list") return [pointer()];
    if (command === "workspace_grant_list") return [grant()];
    return null;
  });
});

describe("project context actual desktop IPC envelope", () => {
  it("initializes the real desktop adapter before project commands and preserves the native session header", async () => {
    const service = nativeProjectContextService(); const controller = new ProjectContextController(service, { projectId: PROJECT, sessionId: SESSION });
    await controller.reload();
    expect(ipc.invoke.mock.calls.slice(0, 2).map((call) => call[0])).toEqual(["runtime_info", "core_initialize"]);
    expect(ipc.invoke).toHaveBeenCalledWith("project_file_pointer_list", { request: { projectId: PROJECT } }, fixtureHeader);
    expect(ipc.invoke).toHaveBeenCalledWith("workspace_grant_list", { projectId: PROJECT }, fixtureHeader);
    expect(controller.getSnapshot().pointers[0]?.id).toBe("pointer-a");
  });

  it("maps picker, revision CAS, grant, build, stateless retrieval and exact run requests without raw path authority", async () => {
    const service = nativeProjectContextService(); await service.initialize();
    await service.pickFiles(PROJECT); expect(ipc.invoke).toHaveBeenCalledWith("project_file_pointer_pick", { request: { projectId: PROJECT } }, fixtureHeader);
    await service.refreshPointer(PROJECT, "pointer-a", 7); expect(ipc.invoke).toHaveBeenCalledWith("project_file_pointer_refresh", { request: { projectId: PROJECT, pointerId: "pointer-a", expectedRevision: 7 } }, fixtureHeader);
    await service.readPointer(PROJECT, "pointer-a", 7); expect(ipc.invoke).toHaveBeenCalledWith("project_file_pointer_read", { request: { projectId: PROJECT, pointerId: "pointer-a", expectedRevision: 7 } }, fixtureHeader);
    await service.listPointerReceipts(PROJECT, "pointer-a"); expect(ipc.invoke).toHaveBeenCalledWith("project_file_pointer_receipts", { request: { projectId: PROJECT, pointerId: "pointer-a" } }, fixtureHeader);
    await service.pickFolder(PROJECT); expect(ipc.invoke).toHaveBeenCalledWith("workspace_grant_pick", { request: { projectId: PROJECT } }, fixtureHeader);
    await service.buildIndex(GRANT, PROJECT, CONTEXT_INDEX_OPTIONS); expect(ipc.invoke).toHaveBeenCalledWith("workspace_index_build", { request: { grantId: GRANT, projectId: PROJECT, options: CONTEXT_INDEX_OPTIONS } }, fixtureHeader);
    await service.retrieve(indexSnapshot().chunks, "hello", CONTEXT_RETRIEVAL_OPTIONS); expect(ipc.invoke).toHaveBeenCalledWith("workspace_index_retrieve", { request: { chunks: indexSnapshot().chunks, query: "hello", options: CONTEXT_RETRIEVAL_OPTIONS } }, fixtureHeader);
    const request = { ...preparedRun, grantId: GRANT, query: "hello", indexOptions: CONTEXT_INDEX_OPTIONS, retrievalOptions: CONTEXT_RETRIEVAL_OPTIONS };
    await service.retrieveForRun(request); expect(ipc.invoke).toHaveBeenCalledWith("workspace_index_retrieve_for_run", { request }, fixtureHeader);
  });

  it("does not dispatch after a core protocol failure or absent runtime", async () => {
    ipc.invoke.mockImplementation(async (command: string) => command === "runtime_info" ? { appVersion: "test" } : { protocolVersion: "incompatible" });
    const controller = new ProjectContextController(nativeProjectContextService(), { projectId: PROJECT, sessionId: SESSION }); await controller.reload();
    expect(ipc.invoke.mock.calls.some((call) => call[0] === "project_file_pointer_list")).toBe(false); expect(controller.getSnapshot().phase).toBe("error");
    ipc.invoke.mockClear(); delete window.__TAURI_INTERNALS__;
    const preview = new ProjectContextController(nativeProjectContextService(), { projectId: PROJECT, sessionId: SESSION }); await preview.reload(); await preview.pickFiles();
    expect(ipc.invoke).not.toHaveBeenCalled(); expect(preview.getSnapshot().phase).toBe("unavailable");
  });
});
