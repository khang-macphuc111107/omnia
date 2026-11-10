import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatWorkspace } from "./chat-controller";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), runtimeInfo: vi.fn(), initializeCore: vi.fn() }));
vi.mock("@/lib/desktop", () => ({ isDesktopRuntime: () => true, invokeCore: native.invoke, desktop: { runtimeInfo: native.runtimeInfo, initializeCore: native.initializeCore } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

const summary = (id = "s1", patch: Record<string, unknown> = {}) => ({
  id, title: `Original ${id}`, scope: "projectless", cwd: `C:/private/${id}`,
  profileId: "provider", model: "before", reasoningEffort: "medium", permissionMode: "ask_writes",
  settingsRevision: 1, messageCount: 0, updatedAtMs: 1, ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  native.runtimeInfo.mockResolvedValue({ appVersion: "0.1.0" });
  native.initializeCore.mockResolvedValue({});
  native.listen.mockResolvedValue(() => undefined);
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "agent_session_list") return [summary(), summary("s2")];
    if (command === "agent_session_read") return { messages: [] };
    return undefined;
  });
  try { localStorage.clear(); } catch { /* Storage may be unavailable. */ }
});

function updateCalls() { return native.invoke.mock.calls.filter(([command]) => command === "agent_session_update"); }

describe("authoritative native Chat session settings", () => {
  it("keeps the applied model and revision when native CAS rejects the write", async () => {
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    native.invoke.mockImplementation(async () => { throw new Error("agent_session_revision_conflict"); });
    await act(async () => { await result.current.updateSettings({ model: "requested" }); });
    expect(result.current.activeSession.model).toBe("before");
    expect(result.current.activeSession.settingsRevision).toBe(1);
    expect(result.current.error).toContain("agent_session_revision_conflict");
  });

  it("keeps the saved title when native rename is rejected", async () => {
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    native.invoke.mockImplementation(async () => { throw new Error("Permission denied"); });
    await act(async () => { await result.current.renameSession("Unaccepted title"); });
    expect(result.current.activeSession.title).toBe("Original s1");
    expect(result.current.activeSession.settingsRevision).toBe(1);
    expect(result.current.error).toContain("Permission denied");
  });

  it("adopts authoritative replies and serializes mixed writes using the returned revision", async () => {
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let finishRename: ((value: ReturnType<typeof summary>) => void) | undefined;
    native.invoke.mockImplementation(async (_command: string, args: { request: Record<string, unknown> }) => {
      if (args.request.title) return new Promise((resolve) => { finishRename = resolve; });
      return summary("s1", { title: "Native renamed", model: "native-resolved", reasoningEffort: "high", settingsRevision: 3 });
    });
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => { first = result.current.renameSession("Requested title"); second = result.current.updateSettings({ model: "requested-model" }); });
    await waitFor(() => expect(updateCalls()).toHaveLength(1));
    expect(result.current.activeSession.title).toBe("Original s1");
    expect(result.current.activeSession.model).toBe("before");
    await act(async () => { finishRename?.(summary("s1", { title: "Native renamed", settingsRevision: 2 })); await Promise.all([first, second]); });
    expect(updateCalls()[0]?.[1]?.request.expectedSettingsRevision).toBe(1);
    expect(updateCalls()[1]?.[1]?.request.expectedSettingsRevision).toBe(2);
    expect(result.current.activeSession.title).toBe("Native renamed");
    expect(result.current.activeSession.model).toBe("native-resolved");
    expect(result.current.activeSession.effort).toBe("high");
    expect(result.current.activeSession.settingsRevision).toBe(3);
  });

  it("applies a late response only to its originating session", async () => {
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let finish: ((value: ReturnType<typeof summary>) => void) | undefined;
    native.invoke.mockImplementation(async (command: string) => command === "agent_session_update" ? new Promise((resolve) => { finish = resolve; }) : { messages: [] });
    let pending: Promise<void> | undefined;
    act(() => { pending = result.current.updateSettings({ model: "requested" }); });
    await waitFor(() => expect(finish).toBeDefined());
    act(() => result.current.selectSession("s2"));
    await act(async () => { finish?.(summary("s1", { model: "accepted", settingsRevision: 2 })); await pending; });
    expect(result.current.activeId).toBe("s2");
    expect(result.current.activeSession.model).toBe("before");
    expect(result.current.sessions.find((session) => session.id === "s1")?.model).toBe("accepted");
  });

  it("keeps live run state when a settings summary does not include running metadata", async () => {
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.setDraft("Start a native run"));
    await act(async () => { await result.current.send(); });
    expect(result.current.activeSession.running).toBe(true);
    native.invoke.mockResolvedValueOnce(summary("s1", { model: "accepted", settingsRevision: 2 }));
    await act(async () => { await result.current.updateSettings({ model: "requested" }); });
    expect(result.current.activeSession.model).toBe("accepted");
    expect(result.current.activeSession.running).toBe(true);
    expect(result.current.status).toBe("running");
  });

  it("does not let an older refresh roll an accepted settings revision back", async () => {
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let finishList: ((value: ReturnType<typeof summary>[]) => void) | undefined;
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "agent_session_list") return new Promise((resolve) => { finishList = resolve; });
      if (command === "agent_session_update") return summary("s1", { model: "accepted", settingsRevision: 2 });
      return { messages: [] };
    });
    let refresh: Promise<void> | undefined;
    act(() => { refresh = result.current.refresh(); });
    await waitFor(() => expect(finishList).toBeDefined());
    await act(async () => { await result.current.updateSettings({ model: "requested" }); });
    await act(async () => { finishList?.([summary(), summary("s2")]); await refresh; });
    expect(result.current.activeSession.model).toBe("accepted");
    expect(result.current.activeSession.settingsRevision).toBe(2);
  });

  it("does not let a late accepted reply replace a newer authoritative refresh", async () => {
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let finishUpdate: ((value: ReturnType<typeof summary>) => void) | undefined;
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "agent_session_update") return new Promise((resolve) => { finishUpdate = resolve; });
      if (command === "agent_session_list") return [summary("s1", { model: "newest", settingsRevision: 3 }), summary("s2")];
      return { messages: [] };
    });
    let pending: Promise<void> | undefined;
    act(() => { pending = result.current.updateSettings({ model: "requested" }); });
    await waitFor(() => expect(finishUpdate).toBeDefined());
    await act(async () => { await result.current.refresh(); });
    await act(async () => { finishUpdate?.(summary("s1", { model: "older-accepted", settingsRevision: 2 })); await pending; });
    expect(result.current.activeSession.model).toBe("newest");
    expect(result.current.activeSession.settingsRevision).toBe(3);
  });

  it("does not expose another session's late failure in the selected session", async () => {
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let rejectUpdate: ((reason: Error) => void) | undefined;
    native.invoke.mockImplementation(async (command: string) => command === "agent_session_update" ? new Promise((_resolve, reject) => { rejectUpdate = reject; }) : { messages: [] });
    let pending: Promise<void> | undefined;
    act(() => { pending = result.current.renameSession("Unaccepted"); });
    await waitFor(() => expect(rejectUpdate).toBeDefined());
    act(() => result.current.selectSession("s2"));
    await act(async () => { rejectUpdate?.(new Error("s1 write failed")); await pending; });
    expect(result.current.activeId).toBe("s2");
    expect(result.current.error).toBeNull();
    expect(result.current.sessions.find((session) => session.id === "s1")?.title).toBe("Original s1");
    act(() => result.current.selectSession("s1"));
    expect(result.current.error).toBe("s1 write failed");
  });

  it("clears a captured write error only after an explicit authoritative refresh", async () => {
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    native.invoke.mockRejectedValueOnce(new Error("Not confirmed"));
    await act(async () => { await result.current.renameSession("Rejected"); });
    expect(result.current.error).toBe("Not confirmed");
    await act(async () => { await result.current.refresh(); });
    act(() => { result.current.selectSession("s2"); result.current.selectSession("s1"); });
    expect(result.current.error).toBeNull();
    expect(result.current.activeSession.title).toBe("Original s1");
  });

  it("keeps a newer write failure visible when an older refresh finishes", async () => {
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let finishList: ((value: ReturnType<typeof summary>[]) => void) | undefined;
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "agent_session_list") return new Promise((resolve) => { finishList = resolve; });
      if (command === "agent_session_update") throw new Error("New write failed");
      return { messages: [] };
    });
    let refresh: Promise<void> | undefined;
    act(() => { refresh = result.current.refresh(); });
    await waitFor(() => expect(finishList).toBeDefined());
    await act(async () => { await result.current.renameSession("Rejected"); });
    await act(async () => { finishList?.([summary(), summary("s2")]); await refresh; });
    expect(result.current.error).toBe("New write failed");
  });

  it("rejects wrong-session and non-advancing native replies", async () => {
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    native.invoke.mockResolvedValueOnce(summary("s2", { settingsRevision: 2 }));
    await act(async () => { await result.current.updateSettings({ model: "requested" }); });
    expect(result.current.activeSession.model).toBe("before");
    expect(result.current.error).toMatch(/session|reply|response/i);
    native.invoke.mockResolvedValueOnce(summary("s1", { model: "stale", settingsRevision: 1 }));
    await act(async () => { await result.current.updateSettings({ model: "requested" }); });
    expect(result.current.activeSession.model).toBe("before");
    expect(result.current.activeSession.settingsRevision).toBe(1);
  });

  it("does not dispatch queued writes after unmount", async () => {
    const { result, unmount } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const finishes: Array<(value: ReturnType<typeof summary>) => void> = [];
    native.invoke.mockImplementation(async () => new Promise((resolve) => { finishes.push(resolve); }));
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => { first = result.current.renameSession("Rename"); second = result.current.updateSettings({ model: "queued" }); });
    await waitFor(() => expect(finishes.length).toBeGreaterThan(0));
    unmount();
    await act(async () => { for (const finish of finishes) finish(summary("s1", { title: "Rename", settingsRevision: 2 })); await Promise.all([first, second]); });
    expect(updateCalls()).toHaveLength(1);
  });
});
