import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatController, ChatSession } from "../chat/chat-controller";
import { SessionTabsCoordinator, type NavigationBridge, type NavigationSnapshot, type SaveNavigationRequest } from "./session-tabs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); };
const session = (id: string, localOnly = false): ChatSession => ({ id, title: id.toUpperCase(), scope: id === "b" ? "project" : "non-project", profileId: "p", model: "m", permissionMode: "ask_writes", settingsRevision: 1, messageCount: 0, updatedAtMs: 1, running: false, ...(localOnly ? { localOnly: true } : {}) });
const snapshot = (openIds: string[] = ["a"], activeId: string | null = openIds[0] ?? null, revision = 1): NavigationSnapshot => ({ schemaVersion: 1, revision, openIds, activeId, updatedAtMs: revision ? 100 : 0 });
const loaded = (value: NavigationSnapshot) => ({ snapshot: value, receiptId: `receipt-${value.revision}` });
const saved = (request: SaveNavigationRequest) => ({ status: "saved", ...loaded(snapshot(request.openIds, request.activeId, request.expectedRevision + 1)) });

let chat: ChatController;
let bridge: NavigationBridge;
beforeEach(() => {
  chat = {
    sessions: [session("a"), session("b"), session("c")], activeId: "a", activeSession: session("a"), messages: [], status: "ready", error: null, draft: "", setDraft: vi.fn(), selectSession: vi.fn(),
    createSession: vi.fn(async () => session("new")), renameSession: vi.fn(), updateSettings: vi.fn(), send: vi.fn(), steer: vi.fn(), interrupt: vi.fn(), approve: vi.fn(), answerQuestion: vi.fn(), approvals: [], questions: [], refresh: vi.fn(), native: true,
  };
  bridge = { load: vi.fn(async () => loaded(snapshot())), save: vi.fn(async (request) => saved(request)) };
});

async function start() {
  const tabs = new SessionTabsCoordinator(bridge);
  tabs.activate();
  tabs.updateController(chat);
  await tick();
  return tabs;
}

describe("durable native session tabs", () => {
  it("restores native order, active identity and receipt without sending", async () => {
    vi.mocked(bridge.load).mockResolvedValue(loaded(snapshot(["b", "a"], "b", 7)));
    const tabs = await start();
    expect(tabs.getSnapshot()).toMatchObject({ openIds: ["b", "a"], activeId: "b", revision: 7, receiptId: "receipt-7", phase: "ready", source: "native" });
    expect(chat.selectSession).toHaveBeenCalledWith("b");
    expect(bridge.save).not.toHaveBeenCalled();
    expect(chat.send).not.toHaveBeenCalled();
    tabs.suspend();
  });

  it("opens in selection order across scopes and closes a view without deleting data", async () => {
    const tabs = await start();
    tabs.selectSession("b");
    await tick();
    tabs.selectSession("c");
    await tick();
    expect(tabs.getSnapshot().openIds).toEqual(["a", "b", "c"]);
    tabs.closeSession("b");
    await tick();
    expect(tabs.getSnapshot().openIds).toEqual(["a", "c"]);
    tabs.closeSession("c");
    await tick();
    expect(tabs.getSnapshot()).toMatchObject({ openIds: ["a"], activeId: "a" });
    expect(chat.sessions.map((value) => value.id)).toEqual(["a", "b", "c"]);
    expect(chat.send).not.toHaveBeenCalled();
    tabs.closeSession("a");
    expect(tabs.getSnapshot().openIds).toEqual(["a"]);
    tabs.suspend();
  });

  it("preserves stable order when reopening and supports explicit reordering", async () => {
    vi.mocked(bridge.load).mockResolvedValue(loaded(snapshot(["b", "a", "c"], "a")));
    const tabs = await start();
    tabs.selectSession("b");
    await tick();
    expect(tabs.getSnapshot().openIds).toEqual(["b", "a", "c"]);
    tabs.moveSession("c", 0);
    await tick();
    expect(tabs.getSnapshot().openIds).toEqual(["c", "b", "a"]);
    expect(bridge.save).toHaveBeenLastCalledWith({ expectedRevision: 2, openIds: ["c", "b", "a"], activeId: "b" });
    tabs.suspend();
  });

  it("keeps current tabs visible on CAS conflict and never automatically overwrites", async () => {
    const remote = snapshot(["c", "a"], "c", 5);
    vi.mocked(bridge.save).mockResolvedValueOnce({ status: "conflict", ...loaded(remote) });
    const tabs = await start();
    tabs.selectSession("b");
    await tick();
    expect(tabs.getSnapshot()).toMatchObject({ phase: "conflict", openIds: ["a", "b"], activeId: "b", revision: 5, receiptId: "receipt-5", conflict: remote });
    tabs.selectSession("c");
    await tick();
    expect(bridge.save).toHaveBeenCalledTimes(1);
    tabs.useSavedTabs();
    expect(tabs.getSnapshot()).toMatchObject({ phase: "ready", openIds: ["c", "a"], activeId: "c", conflict: null });
    expect(chat.selectSession).toHaveBeenLastCalledWith("c");
    tabs.suspend();
  });

  it("allows an explicit CAS retry after a conflict using the returned revision", async () => {
    vi.mocked(bridge.save).mockResolvedValueOnce({ status: "conflict", ...loaded(snapshot(["c"], "c", 4)) });
    const tabs = await start();
    tabs.selectSession("b");
    await tick();
    tabs.saveCurrentTabs();
    await tick();
    expect(bridge.save).toHaveBeenLastCalledWith({ expectedRevision: 4, openIds: ["a", "b"], activeId: "b" });
    expect(tabs.getSnapshot()).toMatchObject({ phase: "ready", revision: 5, conflict: null });
    tabs.suspend();
  });

  it("serializes saves and coalesces newer selection using the confirmed revision", async () => {
    const waiting = deferred<unknown>();
    vi.mocked(bridge.save).mockReturnValueOnce(waiting.promise);
    const tabs = await start();
    tabs.selectSession("b");
    tabs.selectSession("c");
    expect(bridge.save).toHaveBeenCalledTimes(1);
    waiting.resolve(saved({ expectedRevision: 1, openIds: ["a", "b"], activeId: "b" }));
    await tick();
    expect(bridge.save).toHaveBeenCalledTimes(2);
    expect(bridge.save).toHaveBeenLastCalledWith({ expectedRevision: 2, openIds: ["a", "b", "c"], activeId: "c" });
    expect(tabs.getSnapshot()).toMatchObject({ openIds: ["a", "b", "c"], activeId: "c", revision: 3 });
    tabs.suspend();
  });

  it("replays newer local selection over a slow restore without losing native order", async () => {
    const waiting = deferred<unknown>();
    vi.mocked(bridge.load).mockReturnValueOnce(waiting.promise);
    const tabs = new SessionTabsCoordinator(bridge);
    tabs.activate(); tabs.updateController(chat);
    tabs.selectSession("c");
    waiting.resolve(loaded(snapshot(["b", "a"], "b", 3)));
    await tick();
    expect(tabs.getSnapshot()).toMatchObject({ openIds: ["b", "a", "c"], activeId: "c" });
    expect(chat.selectSession).not.toHaveBeenCalledWith("b");
    expect(bridge.save).toHaveBeenCalledWith({ expectedRevision: 3, openIds: ["b", "a", "c"], activeId: "c" });
    tabs.suspend();
  });

  it("retains an explicit click on the already visible session while restore is pending", async () => {
    const waiting = deferred<unknown>();
    vi.mocked(bridge.load).mockReturnValueOnce(waiting.promise);
    const tabs = new SessionTabsCoordinator(bridge);
    tabs.activate(); tabs.updateController(chat);
    tabs.selectSession("a");
    waiting.resolve(loaded(snapshot(["b"], "b", 3)));
    await tick();
    expect(tabs.getSnapshot()).toMatchObject({ openIds: ["b", "a"], activeId: "a" });
    expect(chat.selectSession).not.toHaveBeenCalledWith("b");
    expect(bridge.save).toHaveBeenCalledWith({ expectedRevision: 3, openIds: ["b", "a"], activeId: "a" });
    tabs.suspend();
  });

  it("treats a failed native save as outcome unknown until an explicit reload", async () => {
    vi.mocked(bridge.save).mockRejectedValueOnce({ code: "permission_denied", message: "Navigation storage denied" });
    const tabs = await start();
    tabs.selectSession("b"); await tick();
    expect(tabs.getSnapshot()).toMatchObject({ phase: "error", error: expect.stringContaining("Navigation storage denied") });
    tabs.selectSession("c"); await tick();
    expect(bridge.save).toHaveBeenCalledTimes(1);
    tabs.saveCurrentTabs(); await tick();
    expect(bridge.save).toHaveBeenCalledTimes(1);
    await tabs.reload();
    expect(tabs.getSnapshot()).toMatchObject({ phase: "ready", openIds: ["a"], activeId: "a" });
    tabs.suspend();
  });

  it("cancels observation without following a late native save or replaying it", async () => {
    const waiting = deferred<unknown>();
    vi.mocked(bridge.save).mockReturnValueOnce(waiting.promise);
    const tabs = await start();
    tabs.selectSession("b"); tabs.selectSession("c");
    tabs.cancelPending();
    waiting.resolve(saved({ expectedRevision: 1, openIds: ["a", "b"], activeId: "b" }));
    await tick();
    expect(tabs.getSnapshot()).toMatchObject({ phase: "cancelled", activeId: "c" });
    expect(bridge.save).toHaveBeenCalledTimes(1);
    tabs.suspend();
  });

  it("waits for a canceled dispatched save before reloading durable state", async () => {
    const waiting = deferred<unknown>();
    vi.mocked(bridge.save).mockReturnValueOnce(waiting.promise);
    const tabs = await start();
    tabs.selectSession("b"); tabs.cancelPending();
    const reload = tabs.reload(); await tick();
    expect(bridge.load).toHaveBeenCalledTimes(1);
    vi.mocked(bridge.load).mockResolvedValueOnce(loaded(snapshot(["a", "b"], "b", 2)));
    waiting.resolve(saved({ expectedRevision: 1, openIds: ["a", "b"], activeId: "b" }));
    await reload;
    expect(tabs.getSnapshot()).toMatchObject({ phase: "ready", openIds: ["a", "b"], activeId: "b", revision: 2 });
    tabs.suspend();
  });

  it("ignores late load completion after unmount and can restore after a restart", async () => {
    const waiting = deferred<unknown>();
    vi.mocked(bridge.load).mockReturnValueOnce(waiting.promise);
    const tabs = new SessionTabsCoordinator(bridge);
    tabs.activate(); tabs.updateController(chat); tabs.suspend();
    waiting.resolve(loaded(snapshot(["b"], "b", 8))); await tick();
    expect(chat.selectSession).not.toHaveBeenCalled();
    expect(bridge.save).not.toHaveBeenCalled();
    vi.mocked(bridge.load).mockResolvedValueOnce(loaded(snapshot(["c", "a"], "c", 9)));
    tabs.activate(); tabs.updateController(chat); await tick();
    expect(tabs.getSnapshot()).toMatchObject({ openIds: ["c", "a"], activeId: "c", revision: 9 });
    tabs.suspend();
  });

  it("never persists local-only draft IDs to native navigation", async () => {
    chat.sessions.push(session("draft", true));
    const tabs = await start();
    tabs.selectSession("draft"); await tick();
    expect(tabs.getSnapshot().openIds).toEqual(["a", "draft"]);
    for (const [request] of vi.mocked(bridge.save).mock.calls) {
      expect(request.openIds).not.toContain("draft");
      expect(request.activeId).not.toBe("draft");
    }
    tabs.suspend();
  });

  it("opens a returned native creation immediately and does not follow a stale create", async () => {
    const tabs = await start();
    await tabs.createSession(); await tick();
    expect(tabs.getSnapshot()).toMatchObject({ openIds: ["a", "new"], activeId: "new" });
    expect(bridge.save).toHaveBeenLastCalledWith({ expectedRevision: 1, openIds: ["a", "new"], activeId: "new" });
    const waiting = deferred<ChatSession>();
    vi.mocked(chat.createSession).mockReturnValueOnce(waiting.promise);
    const created = tabs.createSession(); tabs.suspend(); waiting.resolve(session("late"));
    await created; await tick();
    expect(tabs.getSnapshot().openIds).not.toContain("late");
  });

  it("observes selections made outside its intercepted controller", async () => {
    const tabs = await start();
    tabs.updateController({ ...chat, activeId: "b", activeSession: session("b") });
    await tick();
    expect(tabs.getSnapshot()).toMatchObject({ openIds: ["a", "b"], activeId: "b" });
    tabs.suspend();
  });

  it("retains a fallback when stored tabs are empty because chat requires a session", async () => {
    vi.mocked(bridge.load).mockResolvedValueOnce(loaded(snapshot([], null, 0)));
    const tabs = await start();
    expect(tabs.getSnapshot()).toMatchObject({ openIds: ["a"], activeId: "a" });
    expect(bridge.save).toHaveBeenCalledWith({ expectedRevision: 0, openIds: ["a"], activeId: "a" });
    tabs.suspend();
  });

  it.each([
    { snapshot: snapshot(["a", "a"]), receiptId: "bad" },
    { snapshot: snapshot(["a"], "missing"), receiptId: "bad" },
    { snapshot: { ...snapshot(), revision: Number.MAX_SAFE_INTEGER + 1 }, receiptId: "bad" },
    { snapshot: { ...snapshot(), schemaVersion: 2 }, receiptId: "bad" },
    { snapshot: snapshot(), receiptId: "" },
  ])("rejects malformed native restore without write repair: %j", async (value) => {
    vi.mocked(bridge.load).mockResolvedValueOnce(value);
    const tabs = await start();
    expect(tabs.getSnapshot().phase).toBe("error");
    expect(bridge.save).not.toHaveBeenCalled();
    tabs.suspend();
  });

  it("rejects a saved acknowledgement with mismatched IDs and stops queued saves", async () => {
    vi.mocked(bridge.save).mockResolvedValueOnce({ status: "saved", ...loaded(snapshot(["c"], "c", 2)) });
    const tabs = await start(); tabs.selectSession("b"); await tick();
    expect(tabs.getSnapshot().phase).toBe("error");
    tabs.selectSession("c"); await tick();
    expect(bridge.save).toHaveBeenCalledTimes(1);
    tabs.suspend();
  });

  it("waits for chat bootstrap before invoking native navigation", async () => {
    const tabs = new SessionTabsCoordinator(bridge); tabs.activate();
    tabs.updateController({ ...chat, status: "loading" }); await tick();
    expect(bridge.load).not.toHaveBeenCalled();
    tabs.updateController(chat); await tick();
    expect(bridge.load).toHaveBeenCalledTimes(1);
    tabs.suspend();
  });

  it("replays a selection made before Chat bootstrap completes over the first native restore", async () => {
    const waiting = deferred<unknown>();
    vi.mocked(bridge.load).mockReturnValueOnce(waiting.promise);
    const tabs = new SessionTabsCoordinator(bridge);
    tabs.activate();
    tabs.updateController({ ...chat, status: "loading" });
    tabs.selectSession("b");
    expect(tabs.getSnapshot()).toMatchObject({ openIds: ["a", "b"], activeId: "b", phase: "waiting" });
    tabs.updateController(chat);
    expect(bridge.load).toHaveBeenCalledTimes(1);
    waiting.resolve(loaded(snapshot(["a"], "a", 3)));
    await tick();
    expect(tabs.getSnapshot()).toMatchObject({ openIds: ["a", "b"], activeId: "b", revision: 4, phase: "ready" });
    expect(bridge.save).toHaveBeenCalledWith({ expectedRevision: 3, openIds: ["a", "b"], activeId: "b" });
    tabs.suspend();
  });

  it("keeps a representable Chat session active when durable navigation includes an unknown ID", async () => {
    vi.mocked(bridge.load).mockResolvedValueOnce(loaded(snapshot(["foreign"], "foreign", 4)));
    const tabs = await start();
    expect(tabs.getSnapshot()).toMatchObject({ openIds: ["foreign", "a"], activeId: "a" });
    tabs.closeSession("a");
    await tick();
    expect(tabs.getSnapshot()).toMatchObject({ openIds: ["foreign", "a"], activeId: "a" });
    expect(chat.selectSession).not.toHaveBeenCalledWith("foreign");
    tabs.suspend();
  });

  it("keeps browser preview local and explicit without any native command", async () => {
    chat.native = false;
    const tabs = await start(); tabs.selectSession("b"); tabs.closeSession("a"); await tick();
    expect(tabs.getSnapshot()).toMatchObject({ source: "preview", phase: "preview", openIds: ["b"], activeId: "b", revision: null, receiptId: null });
    expect(bridge.load).not.toHaveBeenCalled(); expect(bridge.save).not.toHaveBeenCalled();
    tabs.suspend();
  });
});
