import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatWorkspace } from "./chat-controller";

const native = vi.hoisted(() => ({
  available: true,
  invoke: vi.fn(),
  listen: vi.fn(),
  runtimeInfo: vi.fn(),
  initializeCore: vi.fn(),
}));

vi.mock("@/lib/desktop", () => ({
  isDesktopRuntime: () => native.available,
  invokeCore: native.invoke,
  desktop: { runtimeInfo: native.runtimeInfo, initializeCore: native.initializeCore },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

const summary = (id: string, scope: "projectless" | "project" = "projectless") => ({
  id, title: `Conversation ${id}`, scope,
  cwd: scope === "projectless" ? "C:/OmniaData/projectless/s1" : "C:/explicit-project",
  profileId: "configured-provider", model: "configured-model", reasoningEffort: "high",
  permissionMode: "ask_writes", settingsRevision: 1, messageCount: 0,
  createdAtMs: 1, updatedAtMs: 1, running: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  native.available = true;
  native.runtimeInfo.mockResolvedValue({ appVersion: "0.1.0" });
  native.initializeCore.mockResolvedValue({});
  native.listen.mockResolvedValue(() => undefined);
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "agent_session_list") return [];
    if (command === "agent_session_create") return summary("s1");
    if (command === "agent_session_read") return { messages: [] };
    return undefined;
  });
  try { window.localStorage.clear(); } catch {
    const data = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
      clear: () => data.clear(),
    } });
  }
});

describe("native projectless chat", () => {
  it("creates a durable projectless session on empty startup and sends without a user folder", async () => {
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.activeSession.id).toBe("s1"));
    expect(result.current.activeSession.scope).toBe("non-project");
    expect(result.current.activeSession.cwd).toBeUndefined();
    expect(result.current.activeSession.localOnly).not.toBe(true);
    const create = native.invoke.mock.calls.find(([command]) => command === "agent_session_create");
    expect(create?.[1]?.request.cwd ?? "").toBe("");
    act(() => result.current.setDraft("Investigate a paper without attaching a project"));
    await act(async () => { await result.current.send(); });
    expect(native.invoke).toHaveBeenCalledWith("agent_send", { request: { sessionId: "s1", text: "Investigate a paper without attaching a project", images: [] } });
    expect(result.current.status).toBe("running");
    expect(result.current.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
  });

  it("preserves durable explicit scope after refresh despite a nonempty scratch cwd", async () => {
    native.invoke.mockImplementation(async (command: string) => command === "agent_session_list"
      ? [summary("project", "project"), summary("projectless")]
      : { messages: [] });
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.activeSession.id).toBe("projectless"));
    expect(result.current.activeSession.scope).toBe("non-project");
    expect(native.invoke.mock.calls.filter(([command]) => command === "agent_session_create")).toHaveLength(0);
    act(() => result.current.selectSession("project"));
    expect(result.current.activeSession.scope).toBe("project");
    await act(async () => { await result.current.refresh(); });
    expect(result.current.activeSession.id).toBe("project");
    expect(result.current.activeSession.cwd).toBe("C:/explicit-project");
  });

  it("defaults to a native non-project thread when storage contains only project sessions", async () => {
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "agent_session_list") return [summary("project", "project")];
      if (command === "agent_session_create") return summary("projectless");
      return { messages: [] };
    });
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.activeSession.id).toBe("projectless");
    expect(result.current.sessions.map((session) => session.id)).toEqual(["projectless", "project"]);
    expect(result.current.activeSession.scope).toBe("non-project");
  });

  it("reloads the durable projectless transcript during native startup", async () => {
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "agent_session_list") return [summary("restored")];
      if (command === "agent_session_read") return { summary: summary("restored"), messages: [{ role: "user", content: [{ type: "text", text: "Previous research prompt" }] }, { role: "assistant", content: [{ type: "text", text: "Stored provider reply" }] }] };
      return undefined;
    });
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.messages.map((message) => message.text)).toEqual(["Previous research prompt", "Stored provider reply"]);
    expect(result.current.activeSession.scope).toBe("non-project");
  });

  it("does not dispatch before the durable startup transcript has loaded", async () => {
    let finishRead: (() => void) | undefined;
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "agent_session_list") return [summary("restored")];
      if (command === "agent_session_read") return new Promise((resolve) => { finishRead = () => resolve({ messages: [] }); });
      return undefined;
    });
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.activeSession.id).toBe("restored"));
    act(() => result.current.setDraft("Wait for history"));
    await act(async () => { await result.current.send(); });
    const dispatchedBeforeRead = native.invoke.mock.calls.some(([command]) => command === "agent_send");
    await act(async () => { finishRead?.(); });
    expect(dispatchedBeforeRead).toBe(false);
    expect(result.current.draft).toBe("Wait for history");
  });

  it("waits for native event subscription before discovering or dispatching a session", async () => {
    let subscribe: (() => void) | undefined;
    native.listen.mockReturnValue(new Promise<() => void>((resolve) => { subscribe = () => resolve(() => undefined); }));
    const { result } = renderHook(() => useChatWorkspace());
    await act(async () => { await Promise.resolve(); });
    expect(native.invoke).not.toHaveBeenCalled();
    await act(async () => { subscribe?.(); });
    await waitFor(() => expect(result.current.activeSession.id).toBe("s1"));
  });

  it("keeps a failed native creation explicit and does not fabricate a reply or dispatch", async () => {
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "agent_session_list") return [];
      if (command === "agent_session_create") throw new Error("Scratch storage denied");
      return undefined;
    });
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("disconnected"));
    expect(result.current.error).toContain("Scratch storage denied");
    act(() => result.current.setDraft("Keep my prompt"));
    await act(async () => { await result.current.send(); });
    expect(native.invoke.mock.calls.filter(([command]) => command === "agent_send")).toHaveLength(0);
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.draft).toBe("Keep my prompt");
  });

  it("leaves browser preview disconnected without requesting a native session", async () => {
    native.available = false;
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.setDraft("Preview prompt"));
    await act(async () => { await result.current.send(); });
    expect(native.invoke).not.toHaveBeenCalled();
    expect(result.current.native).toBe(false);
    expect(result.current.messages.some((message) => message.role === "assistant")).toBe(false);
    expect(result.current.error).toMatch(/desktop|preview/i);
  });

  it("restores non-sensitive preview session metadata across reload without persisting transcript", async () => {
    native.available = false;
    const first = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    const originalId = first.result.current.activeSession.id;
    await act(async () => {
      await first.result.current.renameSession("Research desk");
      await first.result.current.updateSettings({ model: "local-research", effort: "xhigh", profileId: "private-provider-profile", permissionMode: "private-policy" });
    });
    act(() => first.result.current.setDraft("Private rendered message"));
    await act(async () => { await first.result.current.send(); });
    expect(first.result.current.messages).toHaveLength(1);
    act(() => first.result.current.setDraft("A private unsent prompt"));
    expect(first.result.current.activeSession.id).toBe(originalId);
    expect(first.result.current.activeSession.title).toBe("Research desk");
    expect(first.result.current.activeSession.model).toBe("local-research");
    expect(first.result.current.activeSession.effort).toBe("xhigh");
    expect(first.result.current.activeSession.settingsRevision).toBe(3);
    first.unmount();

    const persisted = JSON.parse(window.localStorage.getItem("omnia.rebuild.chat.v1") ?? "null") as Record<string, unknown>;
    expect(persisted.activeId).toBe(originalId);
    expect(persisted).not.toHaveProperty("messages");
    expect(persisted).not.toHaveProperty("transcript");
    expect(Array.isArray(persisted.localSessions)).toBe(true);
    const storedMetadata = (persisted.localSessions as Array<Record<string, unknown>>)[0];
    expect(storedMetadata).toMatchObject({ id: originalId, title: "Research desk", scope: "non-project", model: "local-research", effort: "xhigh", settingsRevision: 3 });
    expect(storedMetadata).not.toHaveProperty("profileId");
    expect(storedMetadata).not.toHaveProperty("permissionMode");
    expect(storedMetadata).not.toHaveProperty("updatedAtMs");
    expect(JSON.stringify(persisted)).not.toContain("Private rendered message");
    expect(JSON.stringify(persisted)).not.toContain("private-provider-profile");
    expect(JSON.stringify(persisted)).not.toContain("private-policy");

    const second = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(second.result.current.status).toBe("ready"));
    expect(second.result.current.activeSession.id).toBe(originalId);
    expect(second.result.current.activeSession.localOnly).toBe(true);
    expect(second.result.current.activeSession.scope).toBe("non-project");
    expect(second.result.current.activeSession.title).toBe("Research desk");
    expect(second.result.current.activeSession.model).toBe("local-research");
    expect(second.result.current.activeSession.effort).toBe("xhigh");
    expect(second.result.current.activeSession.settingsRevision).toBe(3);
    expect(second.result.current.activeSession.profileId).toBe("unconfigured");
    expect(second.result.current.activeSession.permissionMode).toBe("ask_writes");
    expect(second.result.current.draft).toBe("A private unsent prompt");
    expect(second.result.current.messages).toHaveLength(0);
    second.unmount();
  });

  it("restores multiple preview sessions in order with the selected session and its draft", async () => {
    native.available = false;
    const first = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    const firstId = first.result.current.activeId;
    await act(async () => { await first.result.current.renameSession("First desk"); });
    act(() => first.result.current.setDraft("First draft"));
    await act(async () => { await first.result.current.createSession(); });
    const secondId = first.result.current.activeId;
    await act(async () => { await first.result.current.renameSession("Second desk"); });
    act(() => first.result.current.setDraft("Second draft"));
    act(() => first.result.current.selectSession(firstId));
    first.unmount();

    const restored = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(restored.result.current.status).toBe("ready"));
    expect(restored.result.current.sessions.map((session) => session.id)).toEqual([secondId, firstId]);
    expect(restored.result.current.activeId).toBe(firstId);
    expect(restored.result.current.activeSession.title).toBe("First desk");
    expect(restored.result.current.draft).toBe("First draft");
    act(() => restored.result.current.selectSession(secondId));
    expect(restored.result.current.activeSession.title).toBe("Second desk");
    expect(restored.result.current.draft).toBe("Second draft");
    expect(native.invoke).not.toHaveBeenCalled();
    restored.unmount();
  });

  it("rejects invalid and duplicate preview metadata and repairs an absent active identity", async () => {
    native.available = false;
    const id = `rebuild-nonproject-${crypto.randomUUID()}`;
    const valid = { id, title: "Validated desk", scope: "non-project", model: "local-model", effort: "high", settingsRevision: 2 };
    window.localStorage.setItem("omnia.rebuild.chat.v1", JSON.stringify({ version: 2, activeId: "missing-local-session", drafts: { [id]: "Valid draft", invalid: { unsafe: "not a string" } }, localSessions: [
      valid,
      { ...valid, title: "Duplicate identity" },
      { ...valid, id: "native-session" },
      { ...valid, id: `rebuild-nonproject-${crypto.randomUUID()}`, settingsRevision: 0 },
      { ...valid, id: `rebuild-nonproject-${crypto.randomUUID()}`, effort: "turbo" },
      { ...valid, id: `rebuild-nonproject-${crypto.randomUUID()}`, title: 42 },
      null,
    ] }));
    const { result, unmount } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.activeId).toBe(id);
    expect(result.current.activeSession.title).toBe("Validated desk");
    expect(result.current.draft).toBe("Valid draft");
    expect(result.current.native).toBe(false);
    const persisted = JSON.parse(window.localStorage.getItem("omnia.rebuild.chat.v1") ?? "null") as { drafts: Record<string, unknown> };
    expect(persisted.drafts).not.toHaveProperty("invalid");
    unmount();
  });

  it("keeps v1 native selection and drafts while migrating to the metadata schema", async () => {
    window.localStorage.setItem("omnia.rebuild.chat.v1", JSON.stringify({ version: 1, activeId: "saved-native", drafts: { "saved-native": "Unsent native draft" } }));
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "agent_session_list") return [summary("other"), summary("saved-native")];
      return { messages: [] };
    });
    const { result, unmount } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.activeId).toBe("saved-native");
    expect(result.current.draft).toBe("Unsent native draft");
    const persisted = JSON.parse(window.localStorage.getItem("omnia.rebuild.chat.v1") ?? "null") as Record<string, unknown>;
    expect(persisted.version).toBe(2);
    expect(persisted.localSessions).toEqual([]);
    expect(JSON.stringify(persisted)).not.toContain("configured-provider");
    expect(JSON.stringify(persisted)).not.toContain("configured-model");
    expect(JSON.stringify(persisted)).not.toContain("explicit-project");
    unmount();
  });

  it("keeps the v1 preview active identity so its draft remains editable after migration", async () => {
    native.available = false;
    const id = `rebuild-nonproject-${crypto.randomUUID()}`;
    window.localStorage.setItem("omnia.rebuild.chat.v1", JSON.stringify({ version: 1, activeId: id, drafts: { [id]: "Legacy preview draft" } }));
    const { result, unmount } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.activeId).toBe(id);
    expect(result.current.activeSession.id).toBe(id);
    expect(result.current.draft).toBe("Legacy preview draft");
    await act(async () => { await result.current.renameSession("Migrated desk"); });
    expect(result.current.activeSession.title).toBe("Migrated desk");
    expect(result.current.native).toBe(false);
    unmount();
  });

  it("ignores a future persisted schema and starts a fresh disconnected preview", async () => {
    native.available = false;
    const id = `rebuild-nonproject-${crypto.randomUUID()}`;
    window.localStorage.setItem("omnia.rebuild.chat.v1", JSON.stringify({ version: 999, activeId: id, drafts: { [id]: "Do not adopt an unknown schema" }, localSessions: [{ id, title: "Future title", scope: "non-project", model: "future-model", settingsRevision: 3 }] }));
    const { result, unmount } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.activeId).not.toBe(id);
    expect(result.current.activeSession.title).toBe("New conversation");
    expect(result.current.draft).toBe("");
    expect(result.current.native).toBe(false);
    unmount();
  });

  it("continues in memory when browser storage reads and writes are denied", async () => {
    native.available = false;
    const read = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("Storage denied"); });
    const write = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("Storage denied"); });
    try {
      const { result, unmount } = renderHook(() => useChatWorkspace());
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () => { await result.current.renameSession("Memory only"); });
      act(() => result.current.setDraft("Still editable"));
      expect(result.current.activeSession.title).toBe("Memory only");
      expect(result.current.draft).toBe("Still editable");
      expect(result.current.native).toBe(false);
      unmount();
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });

  it("fails closed when event subscription fails", async () => {
    native.listen.mockRejectedValue(new Error("Event channel unavailable"));
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("disconnected"));
    expect(result.current.error).toContain("Event channel unavailable");
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("can reconnect after a failed event subscription", async () => {
    native.listen.mockRejectedValueOnce(new Error("Event channel unavailable"));
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("disconnected"));
    await act(async () => { await result.current.refresh(); });
    expect(native.listen).toHaveBeenCalledTimes(2);
    expect(result.current.activeSession.id).toBe("s1");
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeNull();
  });

  it("cleans up a late subscription without creating a native session after unmount", async () => {
    const cleanup = vi.fn();
    let subscribe: (() => void) | undefined;
    native.listen.mockReturnValue(new Promise<() => void>((resolve) => { subscribe = () => resolve(cleanup); }));
    const { unmount } = renderHook(() => useChatWorkspace());
    unmount();
    await act(async () => { subscribe?.(); });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("does not create a projectless session after unmount while discovery is pending", async () => {
    let finishList: (() => void) | undefined;
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "agent_session_list") return new Promise((resolve) => { finishList = () => resolve([]); });
      return summary("must-not-create");
    });
    const { unmount } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(finishList).toBeDefined());
    unmount();
    await act(async () => { finishList?.(); });
    expect(native.invoke.mock.calls.filter(([command]) => command === "agent_session_create")).toHaveLength(0);
  });

  it("retires stale StrictMode subscriptions instead of leaking an older listener", async () => {
    const finishSubscriptions: Array<(cleanup: () => void) => void> = [];
    const cleanups = [vi.fn(), vi.fn()];
    native.listen.mockImplementation(() => new Promise((resolve) => { finishSubscriptions.push(resolve); }));
    const { result, unmount } = renderHook(() => useChatWorkspace(), { reactStrictMode: true });
    await waitFor(() => expect(finishSubscriptions).toHaveLength(2));
    await act(async () => { finishSubscriptions[1]?.(cleanups[1]!); });
    await waitFor(() => expect(result.current.activeSession.id).toBe("s1"));
    await act(async () => { finishSubscriptions[0]?.(cleanups[0]!); });
    expect(cleanups[0]).toHaveBeenCalledOnce();
    expect(cleanups[1]).not.toHaveBeenCalled();
    unmount();
    expect(cleanups[1]).toHaveBeenCalledOnce();
  });

  it("waits for events before an explicit new native non-project conversation", async () => {
    let subscribe: (() => void) | undefined;
    native.listen.mockReturnValue(new Promise<() => void>((resolve) => { subscribe = () => resolve(() => undefined); }));
    const { result } = renderHook(() => useChatWorkspace());
    let created: Promise<unknown> | undefined;
    await act(async () => { created = result.current.createSession(); await Promise.resolve(); });
    const commandsBeforeSubscription = [...native.invoke.mock.calls];
    await act(async () => { subscribe?.(); await created; });
    expect(commandsBeforeSubscription).toHaveLength(0);
    expect(native.invoke.mock.calls.find(([command]) => command === "agent_session_create")?.[1]?.request.cwd).toBe("");
  });

  it("coalesces overlapping refreshes so empty native storage creates one default session", async () => {
    const finishLists: Array<(sessions: ReturnType<typeof summary>[]) => void> = [];
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "agent_session_list") return new Promise((resolve) => { finishLists.push(resolve); });
      if (command === "agent_session_create") return summary("s1");
      return { messages: [] };
    });
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(finishLists.length).toBeGreaterThan(0));
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    await act(async () => {
      first = result.current.refresh(); second = result.current.refresh();
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    });
    await act(async () => { for (const finish of finishLists) finish([]); await Promise.all([first, second]); });
    expect(native.invoke.mock.calls.filter(([command]) => command === "agent_session_list")).toHaveLength(1);
    expect(native.invoke.mock.calls.filter(([command]) => command === "agent_session_create")).toHaveLength(1);
    expect(result.current.activeSession.id).toBe("s1");
  });

  it("retains the session and unsent draft on a failed refresh", async () => {
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.activeSession.id).toBe("s1"));
    act(() => result.current.setDraft("Do not lose this draft"));
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "agent_session_list") throw new Error("Database unavailable");
      return undefined;
    });
    await act(async () => { await result.current.refresh(); });
    expect(result.current.activeSession.id).toBe("s1");
    expect(result.current.draft).toBe("Do not lose this draft");
    expect(result.current.status).toBe("disconnected");
    await act(async () => { await result.current.send(); });
    expect(native.invoke.mock.calls.filter(([command]) => command === "agent_send")).toHaveLength(0);
  });

  it("does not let a stale refresh erase a newer projectless session", async () => {
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let finishList: (() => void) | undefined;
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "agent_session_list") return new Promise((resolve) => { finishList = () => resolve([summary("s1")]); });
      if (command === "agent_session_create") return summary("newer");
      return { messages: [] };
    });
    let refresh: Promise<void> | undefined;
    act(() => { refresh = result.current.refresh(); });
    await waitFor(() => expect(finishList).toBeDefined());
    await act(async () => { await result.current.createSession(); });
    expect(result.current.activeSession.id).toBe("newer");
    await act(async () => { finishList?.(); await refresh; });
    expect(result.current.activeSession.id).toBe("newer");
    expect(result.current.sessions.map((session) => session.id)).toContain("newer");
  });

  it("keeps steering, ask-user, approvals and cancellation on the native projectless identity", async () => {
    let emit: ((payload: { sessionId: string; sequence: number; event: Record<string, unknown> }) => void) | undefined;
    native.listen.mockImplementation(async (_name: string, handler: (event: { payload: { sessionId: string; sequence: number; event: Record<string, unknown> } }) => void) => {
      emit = (payload) => handler({ payload });
      return () => undefined;
    });
    const { result } = renderHook(() => useChatWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      emit?.({ sessionId: "s1", sequence: 1, event: { type: "run_started", runId: "r1" } });
      emit?.({ sessionId: "s1", sequence: 2, event: { type: "ask_user", runId: "r1", requestId: "q1", prompt: "Choose a source", options: ["Paper", "Web"] } });
      emit?.({ sessionId: "s1", sequence: 3, event: { type: "approval_requested", runId: "r1", request: { toolUseId: "a1", tool: "write", summary: "Write scratch report" } } });
    });
    expect(result.current.questions).toHaveLength(1);
    expect(result.current.approvals).toHaveLength(1);
    await act(async () => {
      await result.current.answerQuestion("q1", "Paper");
      await result.current.approve("a1", "deny");
      await result.current.steer("Keep researching");
      await result.current.interrupt();
    });
    expect(native.invoke).toHaveBeenCalledWith("agent_user_input", { request: { sessionId: "s1", requestId: "q1", runId: "r1", answer: "Paper" } });
    expect(native.invoke).toHaveBeenCalledWith("agent_approval_decide", { request: { sessionId: "s1", toolUseId: "a1", decision: { type: "deny", feedback: null } } });
    expect(native.invoke).toHaveBeenCalledWith("agent_steer", { request: { sessionId: "s1", text: "Keep researching" } });
    expect(native.invoke).toHaveBeenCalledWith("agent_interrupt", { request: { sessionId: "s1" } });
    act(() => { emit?.({ sessionId: "s1", sequence: 4, event: { type: "cancelled", runId: "r1" } }); });
    expect(result.current.activeSession.running).toBe(false);
    expect(result.current.messages).toHaveLength(0);
  });
});
