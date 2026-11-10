import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import type { ChatController, ChatSession } from "../chat/chat-controller";
import { SessionTabStrip, useSessionTabs, type SessionTabsControllerResult, type SessionTabsModel } from "./session-tabs-view";
import { nativeNavigationBridge, type NavigationBridge, type SaveNavigationRequest } from "./session-tabs";

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/desktop", () => ({ invokeCore: ipc.invoke }));
const session = (id: string, scope: "project" | "non-project" = "non-project"): ChatSession => ({ id, title: `Conversation ${id}`, scope, profileId: "p", model: "m", permissionMode: "ask_writes", settingsRevision: 1, messageCount: 0, updatedAtMs: 1, running: false });
const response = (ids: string[] = ["a"], activeId = "a", revision = 1) => ({ snapshot: { schemaVersion: 1, openIds: ids, activeId, revision, updatedAtMs: 100 }, receiptId: `session_navigation_${revision}` });
const saveResponse = (request: SaveNavigationRequest) => ({ status: "saved", ...response(request.openIds, request.activeId ?? "a", request.expectedRevision + 1) });

function controller(overrides: Partial<ChatController> = {}): ChatController {
  const a = session("a");
  return { sessions: [a, session("b", "project"), session("c")], activeId: "a", activeSession: a, messages: [], status: "ready", error: null, draft: "", setDraft: vi.fn(), selectSession: vi.fn(), createSession: vi.fn(async () => session("new")), renameSession: vi.fn(), updateSettings: vi.fn(), send: vi.fn(), steer: vi.fn(), interrupt: vi.fn(), approve: vi.fn(), answerQuestion: vi.fn(), approvals: [], questions: [], refresh: vi.fn(), native: true, ...overrides };
}

function model(overrides: Partial<SessionTabsModel> = {}): SessionTabsModel {
  return { openIds: ["a", "b", "c"], activeId: "a", source: "native", phase: "ready", revision: 3, receiptId: "native-receipt-3", updatedAtMs: 100, dirty: false, error: null, conflict: null,
    tabs: [session("a"), session("b", "project"), session("c")].map((value) => ({ ...value, active: value.id === "a", localOnly: false })),
    selectSession: vi.fn(), closeSession: vi.fn(), moveSession: vi.fn(), createSession: vi.fn(async () => session("new")), reload: vi.fn(async () => undefined), cancelPending: vi.fn(), useSavedTabs: vi.fn(), saveCurrentTabs: vi.fn(), ...overrides };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("session tab strip", () => {
  it("owns only tab children and keeps descriptively named close actions keyboard focusable outside the tablist", async () => {
    const state = model();
    const { container } = render(<SessionTabStrip model={state} />);
    const list = screen.getByRole("tablist", { name: "Open sessions" });
    const actions = screen.getByRole("group", { name: "Session tab actions" });
    expect(Array.from(list.children).map((element) => element.getAttribute("role"))).toEqual(["tab", "tab", "tab"]);
    for (const id of ["a", "b", "c"]) {
      const close = screen.getByRole("button", { name: `Close Conversation ${id} session tab` });
      expect(list.contains(close)).toBe(false);
      expect(actions.contains(close)).toBe(true);
      expect(close).toBeEnabled();
      expect(close.tabIndex).toBe(0);
      close.focus();
      expect(document.activeElement).toBe(close);
    }
    fireEvent.click(screen.getByRole("button", { name: "Close Conversation b session tab" }));
    expect(state.closeSession).toHaveBeenCalledWith("b");
    expect(state.selectSession).not.toHaveBeenCalled();
    const result = await axe.run(container, { runOnly: ["aria-required-children", "aria-required-parent", "nested-interactive", "button-name"] });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });

  it("does not expose an invalid empty tablist while waiting for session history", async () => {
    const { container } = render(<SessionTabStrip model={model({ tabs: [], openIds: [], activeId: null, phase: "waiting", source: "waiting" })} />);
    expect(screen.getByText("No open sessions")).toBeVisible();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: /Close .* session tab/ })).toBeNull();
    const result = await axe.run(container, { runOnly: ["aria-required-children", "aria-required-parent"] });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });

  it("exposes ordered scope labels, one selected tab and a visible native revision/receipt", () => {
    render(<SessionTabStrip model={model()} />);
    expect(screen.getAllByRole("tab").map((element) => element.getAttribute("aria-label"))).toEqual(["Conversation a · non-project", "Conversation b · project", "Conversation c · non-project"]);
    expect(screen.getAllByRole("tab").filter((element) => element.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(screen.getByText(/revision 3/i)).toBeVisible();
    expect(screen.getByText("native-receipt-3")).toBeVisible();
  });

  it("selects and focuses tabs with Arrow, Home and End, including wraparound", () => {
    const state = model();
    render(<SessionTabStrip model={state} />);
    const [a, b, c] = screen.getAllByRole("tab");
    a!.focus(); fireEvent.keyDown(a!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b); expect(state.selectSession).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(b!, { key: "End" });
    expect(document.activeElement).toBe(c); expect(state.selectSession).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(c!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c!, { key: "Home" }); expect(document.activeElement).toBe(a);
  });

  it("has separate close controls and retains keyboard focus after closing active view", () => {
    function Harness() {
      const [items, setItems] = useState(model().tabs);
      const [activeId, setActive] = useState("a");
      const state = model({ tabs: items.map((item) => ({ ...item, active: item.id === activeId })), activeId,
        closeSession: (id) => { setItems((current) => current.filter((item) => item.id !== id)); setActive("b"); } });
      return <SessionTabStrip model={state} />;
    }
    render(<Harness />);
    const a = screen.getByRole("tab", { name: "Conversation a · non-project" });
    expect(within(a).queryByRole("button")).toBeNull();
    a.focus(); fireEvent.keyDown(a, { key: "Delete" });
    expect(screen.queryByRole("tab", { name: "Conversation a · non-project" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Conversation b · project" }));
  });

  it("keeps last view open with an accessible close reason and offers keyboard reorder", () => {
    const state = model({ tabs: [model().tabs[0]!], openIds: ["a"] });
    render(<SessionTabStrip model={state} />);
    expect(screen.getByRole("button", { name: "Close Conversation a session tab" })).toBeDisabled();
    const tab = screen.getByRole("tab");
    fireEvent.keyDown(tab, { key: "Delete" });
    expect(state.closeSession).not.toHaveBeenCalled();
  });

  it("shows conflict recovery, error detail and cancelled reload without automatic writes", () => {
    const state = model({ phase: "conflict", conflict: response(["c"], "c").snapshot as never });
    const view = render(<SessionTabStrip model={state} />);
    fireEvent.click(screen.getByRole("button", { name: "Use saved tabs" })); expect(state.useSavedTabs).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save current tabs" })); expect(state.saveCurrentTabs).toHaveBeenCalledTimes(1);
    view.rerender(<SessionTabStrip model={model({ phase: "error", error: "Storage denied. Reload before saving." })} />);
    expect(screen.getByText("Storage denied. Reload before saving.")).toBeVisible();
    view.rerender(<SessionTabStrip model={model({ phase: "cancelled", error: "A dispatched save may still finish." })} />);
    expect(screen.getByRole("button", { name: "Reload native tabs" })).toBeVisible();
    expect(screen.getByText("A dispatched save may still finish.")).toBeVisible();
  });

  it("labels preview and preserves scoped keyboard focus with duplicate mounted strips", () => {
    render(<><SessionTabStrip ariaLabel="First strip" model={model({ phase: "preview", source: "preview", receiptId: null, revision: null })} /><SessionTabStrip ariaLabel="Second strip" model={model()} /></>);
    expect(screen.getByText(/Preview tabs.*not saved to native/i)).toBeVisible();
    const second = screen.getByRole("tablist", { name: "Second strip" });
    const [a, b] = within(second).getAllByRole("tab");
    a!.focus(); fireEvent.keyDown(a!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b);
  });
});

describe("session tabs hook", () => {
  it("intercepts sidebar selections and creates without reloading on every render", async () => {
    const bridge: NavigationBridge = { load: vi.fn(async () => response()), save: vi.fn(async (request) => saveResponse(request)) };
    let output!: SessionTabsControllerResult;
    const select = vi.fn(); const create = vi.fn(async () => session("new")); const send = vi.fn();
    function Harness() {
      const [activeId, setActive] = useState("a");
      const [sessions, setSessions] = useState(controller().sessions);
      const chat = controller({ sessions, activeId, activeSession: sessions.find((value) => value.id === activeId)!, send,
        selectSession: (id) => { select(id); setActive(id); },
        createSession: async () => { const value = await create(); setSessions((items) => [...items, value]); setActive(value.id); return value; } });
      output = useSessionTabs(chat, bridge);
      return <SessionTabStrip model={output.model} />;
    }
    const view = render(<Harness />);
    await waitFor(() => expect(output.model.phase).toBe("ready"));
    act(() => output.controller.selectSession("b"));
    await waitFor(() => expect(output.model.phase).toBe("ready"));
    expect(output.model.openIds).toEqual(["a", "b"]);
    expect(select).toHaveBeenLastCalledWith("b");
    await act(async () => { await output.controller.createSession(); });
    await waitFor(() => expect(output.model.phase).toBe("ready"));
    expect(output.model.openIds).toEqual(["a", "b", "new"]);
    expect(output.model.activeId).toBe("new");
    expect(bridge.load).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    const before = output.model;
    view.unmount();
    expect(before.activeId).toBe("new");
  });

  it("refreshes tab labels when the underlying session is renamed", async () => {
    const bridge: NavigationBridge = { load: vi.fn(async () => response()), save: vi.fn(async (request) => saveResponse(request)) };
    function Harness({ title }: { title: string }) {
      const chat = controller(); chat.sessions[0]!.title = title;
      const tabs = useSessionTabs(chat, bridge);
      return <SessionTabStrip model={tabs.model} />;
    }
    const view = render(<Harness title="Original title" />);
    await screen.findByRole("tab", { name: "Original title · non-project" });
    view.rerender(<Harness title="New title" />);
    await screen.findByRole("tab", { name: "New title · non-project" });
    expect(bridge.load).toHaveBeenCalledTimes(1);
  });

  it("uses exact native command names and request envelope", async () => {
    ipc.invoke.mockResolvedValue(response());
    await nativeNavigationBridge.load();
    const request = { expectedRevision: 1, openIds: ["a"], activeId: "a" };
    await nativeNavigationBridge.save(request);
    expect(ipc.invoke.mock.calls).toEqual([["agent_session_navigation_load"], ["agent_session_navigation_save", { request }]]);
  });
});
