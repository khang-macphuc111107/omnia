import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeCore, isDesktopRuntime } = vi.hoisted(() => ({ invokeCore: vi.fn(), isDesktopRuntime: vi.fn() }));
vi.mock("@/lib/desktop", () => ({ invokeCore, isDesktopRuntime }));

import { connectedEditorUrl, pickEditorWorkspaceFolder, readEditorServerStatus, readEditorWorkspace, removeEditorWorkspaceFolder, usesNativeEditorTransport } from "./ide-editor-transport";

const ready = { state: "ready", url: "http://127.0.0.1:1430/?tkn=test-only-token" };
const workspace = { folders: [{ id: "editor_known", name: "project", path: "D:\\Project & One" }], workspacePath: "C:\\App Data\\editor\\omnia.code-workspace" };

beforeEach(() => {
  vi.clearAllMocks();
  isDesktopRuntime.mockReturnValue(false);
});
afterEach(() => vi.unstubAllGlobals());

describe("editor transport", () => {
  it("uses the protected preview route for the browser and the local fast desktop preview", async () => {
    const fetchStatus = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ready });
    vi.stubGlobal("fetch", fetchStatus);
    expect((await readEditorServerStatus(true)).state).toBe("ready");
    expect(fetchStatus).toHaveBeenCalledWith("/__omnia_ide_server", expect.objectContaining({ method: "POST", headers: { "x-omnia-workbench": "editor-server-start" } }));
    isDesktopRuntime.mockReturnValue(true);
    vi.stubGlobal("location", { href: "http://127.0.0.1:1420/" });
    expect(usesNativeEditorTransport()).toBe(false);
    await readEditorServerStatus(false);
    expect(invokeCore).not.toHaveBeenCalled();
  });

  it("uses session-guarded native commands from the installed application", async () => {
    isDesktopRuntime.mockReturnValue(true);
    vi.stubGlobal("location", { href: "http://tauri.localhost/" });
    vi.stubGlobal("fetch", vi.fn());
    invokeCore.mockResolvedValue(ready);
    await readEditorServerStatus(false);
    expect(invokeCore).toHaveBeenLastCalledWith("editor_server_status");
    await readEditorServerStatus(true);
    expect(invokeCore).toHaveBeenLastCalledWith("editor_server_start");
    expect(fetch).not.toHaveBeenCalled();
    invokeCore.mockResolvedValue(workspace);
    expect(await readEditorWorkspace()).toEqual(workspace);
    expect(invokeCore).toHaveBeenLastCalledWith("editor_workspace_get");
    await pickEditorWorkspaceFolder();
    expect(invokeCore).toHaveBeenLastCalledWith("editor_workspace_pick");
    await removeEditorWorkspaceFolder("editor_known");
    expect(invokeCore).toHaveBeenLastCalledWith("editor_workspace_remove", { folderId: "editor_known" });
  });

  it("reports native errors without switching to an unguarded HTTP fallback", async () => {
    isDesktopRuntime.mockReturnValue(true);
    vi.stubGlobal("location", { href: "tauri://localhost/" });
    const fetchStatus = vi.fn();
    vi.stubGlobal("fetch", fetchStatus);
    invokeCore.mockRejectedValue({ code: "editor_state_failed", message: "The editor state is unavailable" });
    await expect(readEditorServerStatus(false)).rejects.toThrow("The editor state is unavailable");
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it("rejects unexpected addresses before using them as an editor frame", async () => {
    const fetchStatus = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...ready, url: "https://other.example/" }) });
    vi.stubGlobal("fetch", fetchStatus);
    await expect(readEditorServerStatus(false)).rejects.toThrow("invalid address");
    expect(() => connectedEditorUrl(ready.url, "https://other.example/?folder=/tmp")).toThrow("invalid");
  });

  it("preserves the connection token while merging only the workspace query", () => {
    const result = new URL(connectedEditorUrl(ready.url, "http://127.0.0.1:1430/?workspace=%2Fd%3A%2FProject+%26+One&untrusted=ignored"));
    expect(result.origin).toBe("http://127.0.0.1:1430");
    expect(result.searchParams.get("tkn")).toBe("test-only-token");
    expect(result.searchParams.get("workspace")).toBe("/d:/Project & One");
    expect(result.searchParams.has("untrusted")).toBe(false);
  });

  it("releases an awaiting native request on abort and never starts an already-cancelled operation", async () => {
    isDesktopRuntime.mockReturnValue(true);
    vi.stubGlobal("location", { href: "http://tauri.localhost/" });
    invokeCore.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = readEditorServerStatus(false, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    invokeCore.mockClear();
    await expect(readEditorServerStatus(true, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(invokeCore).not.toHaveBeenCalled();
  });
});
