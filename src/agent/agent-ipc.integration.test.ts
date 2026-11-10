import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { __resetCoreSessionForTests } from "@/lib/desktop";

import { AGENT_EVENT, agentApi } from "./agent-api";
import { useAgentStore } from "./agent-store";
import type { AgentSessionDetail, AgentSessionListItem } from "./types";

const session: AgentSessionListItem = {
  id: "session-1",
  title: "Integration session",
  cwd: "C:\\project",
  profileId: "profile-1",
  model: "model-1",
  permissionMode: "ask_writes",
  messageCount: 0,
  createdAtMs: 1,
  updatedAtMs: 1,
  running: false,
};
const nativeSessionToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let emitAgentEvent: ((event: { payload: unknown }) => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  __resetCoreSessionForTests();
  emitAgentEvent = undefined;
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  useAgentStore.setState({
    ready: false,
    startupError: null,
    sessions: [],
    activeId: null,
    live: {},
    notice: null,
    drafts: {},
    deciding: {},
  });
  invoke.mockImplementation(async (command: string) => {
    if (command === "runtime_info") return {
      appName: "Omnia",
      appVersion: "test",
      platform: "windows",
      tauri: true,
      debug: true,
    };
    if (command === "core_initialize") return {
      protocolVersion: "1.0",
      serverInfo: { name: "omnia-core", title: "Omnia Core", version: "test" },
      capabilities: ["run.stream.v1"],
      unavailableCapabilities: [],
      sessionToken: nativeSessionToken,
      sessionEpoch: 1,
    };
    if (command === "agent_session_list") return [session];
    if (command === "agent_session_read") {
      return {
        summary: session,
        running: false,
        messages: [],
      } satisfies AgentSessionDetail;
    }
    return undefined;
  });
  listen.mockImplementation(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
    if (eventName === AGENT_EVENT) emitAgentEvent = handler;
    return vi.fn();
  });
});

afterEach(() => {
  __resetCoreSessionForTests();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("agent Tauri IPC integration boundary", () => {
  it("routes browser, computer and download actions through native invoke wrappers", async () => {
    await agentApi.ensureReady();
    expect(invoke.mock.calls.filter(([command]) => command === "core_initialize")).toHaveLength(1);
    await agentApi.browserOpenForSignin("session-1", "https://example.test/login");
    await agentApi.setComputerPermission("session-1", true, false, ["notepad.exe"]);
    await agentApi.downloadStart("session-1", { capturedRequestId: "request-1", kind: "hls" });

    const guard = { headers: { "x-omnia-session": nativeSessionToken } };
    expect(invoke).toHaveBeenCalledWith("agent_browser_open_for_signin", {
      request: { sessionId: "session-1", url: "https://example.test/login" },
    }, guard);
    expect(invoke).toHaveBeenCalledWith("agent_computer_permission_set", {
      request: { sessionId: "session-1", capture: true, control: false, allowedApps: ["notepad.exe"] },
    }, guard);
    expect(invoke).toHaveBeenCalledWith("agent_download_start", {
      request: { sessionId: "session-1", capturedRequestId: "request-1", kind: "hls" },
    }, guard);
  });

  it("connects the real event listener to store initialization and transcript state", async () => {
    await useAgentStore.getState().init();
    expect(invoke.mock.calls.filter(([command]) => command === "core_initialize")).toHaveLength(1);
    expect(listen).toHaveBeenCalledWith(AGENT_EVENT, expect.any(Function));
    expect(emitAgentEvent).toBeTypeOf("function");

    await useAgentStore.getState().open("session-1");
    emitAgentEvent?.({ payload: { sessionId: "session-1", event: { type: "run_started" }, sequence: 1 } });
    emitAgentEvent?.({ payload: {
      sessionId: "session-1",
      event: { type: "stream", event: { type: "text_delta", text: "Connected end to end" } },
      sequence: 2,
    } });

    expect(useAgentStore.getState().sessions[0]?.running).toBe(true);
    expect(useAgentStore.getState().live["session-1"]?.items).toMatchObject([
      { kind: "text", text: "Connected end to end" },
    ]);

    emitAgentEvent?.({ payload: {
      sessionId: "session-1",
      event: { type: "run_finished", status: "completed" },
      sequence: 3,
    } });
    expect(useAgentStore.getState().live["session-1"]?.running).toBe(false);
    expect(useAgentStore.getState().sessions[0]?.running).toBe(false);
  });
});
