import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VoiceEventPayload } from "./voice";

const voice = vi.hoisted(() => {
  const state: { handler: ((event: VoiceEventPayload) => void) | null } = { handler: null };
  return {
    state,
    voiceStart: vi.fn(async (_language?: string) => undefined),
    voiceStop: vi.fn(async () => undefined),
    voiceOpenSettings: vi.fn(async (_target: string) => undefined),
    onVoiceEvent: vi.fn(async (handler: (event: VoiceEventPayload) => void) => {
      state.handler = handler;
      return () => {
        state.handler = null;
      };
    }),
  };
});
vi.mock("./agent-api", () => ({
  agentApi: {
    commandsList: vi.fn(async () => []),
    workspaceFiles: vi.fn(async () => []),
    voiceStart: voice.voiceStart,
    voiceStop: voice.voiceStop,
    voiceOpenSettings: voice.voiceOpenSettings,
    onVoiceEvent: voice.onVoiceEvent,
  },
  errorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
}));

import { Composer, PUSH_TO_TALK_MS } from "./composer";
import { useAgentStore } from "./agent-store";
import { insertAtCaret } from "./use-dictation";
import type { AgentSessionListItem } from "./types";

function installStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    },
  });
}
installStorage();

const session: AgentSessionListItem = { id: "s", title: "s", cwd: "C:\\p", profileId: "p", model: "m", permissionMode: "ask_writes", running: false, messageCount: 0, createdAtMs: 1, updatedAtMs: 1 };
const props = { session, running: false, usage: null, onSend: vi.fn(), onStop: vi.fn(), onModel: vi.fn(), onMode: vi.fn() };
const emitVoice = (event: VoiceEventPayload) => act(() => voice.state.handler?.(event));
const mic = () => screen.getByRole("button", { name: /dictation/i });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  voice.state.handler = null;
  useAgentStore.setState({ drafts: { s: { text: "", images: [] } } });
});

describe("insertAtCaret", () => {
  it("adds separating spaces only where needed", () => {
    expect(insertAtCaret("hello", 5, 5, "world")).toEqual({ text: "hello world", caret: 11 });
    expect(insertAtCaret("hello ", 6, 6, "world")).toEqual({ text: "hello world", caret: 11 });
    expect(insertAtCaret("ab cd", 2, 2, "xy")).toEqual({ text: "ab xy cd", caret: 5 });
    expect(insertAtCaret("a b", 1, 3, "zz")).toEqual({ text: "a zz", caret: 4 });
    expect(insertAtCaret("hi", 2, 2, ".")).toEqual({ text: "hi.", caret: 3 });
    expect(insertAtCaret("keep", 4, 4, "   ")).toEqual({ text: "keep", caret: 4 });
  });
});

describe("Composer dictation", () => {
  it("moves idle -> listening -> idle and starts with the saved language", async () => {
    window.localStorage.setItem("omnia.agent.prefs.v1", JSON.stringify({ recentFolders: [], voiceLanguage: "vi-VN" }));
    render(<Composer {...props} />);
    expect(mic()).toHaveAttribute("data-state", "idle");
    expect(mic()).toHaveAccessibleName("Start dictation");
    fireEvent.click(mic());
    await waitFor(() => expect(mic()).toHaveAttribute("data-state", "listening"));
    expect(voice.voiceStart).toHaveBeenCalledWith("vi-VN");
    expect(mic()).toHaveAccessibleName("Stop dictation");
    expect(mic()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(mic());
    await waitFor(() => expect(mic()).toHaveAttribute("data-state", "idle"));
    expect(voice.voiceStop).toHaveBeenCalled();
  });

  it("shows partial text as ghost text and inserts final text at the caret", async () => {
    useAgentStore.setState({ drafts: { s: { text: "fix the bug now", images: [] } } });
    render(<Composer {...props} />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    box.setSelectionRange(8, 8);
    fireEvent.select(box);
    fireEvent.click(mic());
    await waitFor(() => expect(mic()).toHaveAttribute("data-state", "listening"));
    await emitVoice({ kind: "partial", text: "login" });
    expect(screen.getByTestId("dictation-ghost")).toHaveTextContent("login");
    expect(useAgentStore.getState().drafts.s?.text).toBe("fix the bug now");
    await emitVoice({ kind: "final", text: "login" });
    expect(screen.queryByTestId("dictation-ghost")).toBeNull();
    expect(useAgentStore.getState().drafts.s?.text).toBe("fix the login bug now");
    await emitVoice({ kind: "final", text: "again" });
    expect(useAgentStore.getState().drafts.s?.text).toBe("fix the login again bug now");
    await emitVoice({ kind: "ended", text: "" });
    expect(mic()).toHaveAttribute("data-state", "idle");
  });

  it("ignores voice events when this composer did not start dictation", async () => {
    render(<Composer {...props} />);
    await waitFor(() => expect(voice.state.handler).not.toBeNull());
    await emitVoice({ kind: "final", text: "stray" });
    expect(useAgentStore.getState().drafts.s?.text).toBe("");
  });

  it("surfaces a privacy-policy error with a button that opens speech settings", async () => {
    voice.voiceStart.mockRejectedValueOnce(Object.assign(new Error("Turn on Online speech recognition."), { code: "voice_speech_privacy_declined" }));
    render(<Composer {...props} />);
    fireEvent.click(mic());
    expect(await screen.findByRole("alert")).toHaveTextContent("Turn on Online speech recognition.");
    expect(mic()).toHaveAttribute("data-state", "error");
    fireEvent.click(screen.getByRole("button", { name: "Open speech settings" }));
    expect(voice.voiceOpenSettings).toHaveBeenCalledWith("speech");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(mic()).toHaveAttribute("data-state", "idle");
  });

  it("maps a runtime microphone error event to the microphone settings button", async () => {
    render(<Composer {...props} />);
    fireEvent.click(mic());
    await waitFor(() => expect(mic()).toHaveAttribute("data-state", "listening"));
    await emitVoice({ kind: "error", text: "Microphone access is blocked.", code: "microphone_denied" });
    expect(screen.getByRole("alert")).toHaveTextContent("Microphone access is blocked.");
    fireEvent.click(screen.getByRole("button", { name: "Open microphone settings" }));
    expect(voice.voiceOpenSettings).toHaveBeenCalledWith("microphone");
    await emitVoice({ kind: "ended", text: "" });
    expect(mic()).toHaveAttribute("data-state", "error");
  });

  it("Ctrl+Shift+Space toggles; holding past the threshold is push-to-talk", async () => {
    render(<Composer {...props} />);
    const press = { ctrlKey: true, shiftKey: true, code: "Space", key: " " };
    fireEvent.keyDown(window, press);
    await waitFor(() => expect(mic()).toHaveAttribute("data-state", "listening"));
    fireEvent.keyUp(window, press);
    expect(voice.voiceStop).not.toHaveBeenCalled(); // a quick tap leaves it on
    fireEvent.keyDown(window, press);
    await waitFor(() => expect(mic()).toHaveAttribute("data-state", "idle"));

    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    fireEvent.keyDown(window, press);
    await waitFor(() => expect(mic()).toHaveAttribute("data-state", "listening"));
    now.mockReturnValue(1_000 + PUSH_TO_TALK_MS + 50);
    fireEvent.keyUp(window, press);
    await waitFor(() => expect(mic()).toHaveAttribute("data-state", "idle"));
    now.mockRestore();
  });

  it("stops listening when the composer unmounts", async () => {
    const view = render(<Composer {...props} />);
    fireEvent.click(mic());
    await waitFor(() => expect(mic()).toHaveAttribute("data-state", "listening"));
    voice.voiceStop.mockClear();
    view.unmount();
    await waitFor(() => expect(voice.voiceStop).toHaveBeenCalled());
  });
});
