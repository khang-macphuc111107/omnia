import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./agent-api", () => ({
  errorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
  agentApi: {
    ensureReady: vi.fn(async () => undefined),
    onEvent: vi.fn(async () => () => undefined),
    list: vi.fn(),
    read: vi.fn(),
    create: vi.fn(),
    send: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    decide: vi.fn(async () => undefined),
    update: vi.fn(),
    fork: vi.fn(),
    rewind: vi.fn(),
    remove: vi.fn(async () => undefined),
  },
}));

import { agentApi } from "./agent-api";
import { useAgentStore } from "./agent-store";
import type { AgentMessage, AgentSessionDetail, AgentSessionListItem } from "./types";

const api = vi.mocked(agentApi);
const session = (id: string, patch: Partial<AgentSessionListItem> = {}): AgentSessionListItem => ({
  id,
  title: id,
  cwd: "C:\\proj",
  profileId: "p",
  model: "m",
  permissionMode: "ask_writes",
  messageCount: 0,
  createdAtMs: 1,
  updatedAtMs: 1,
  running: false,
  ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  useAgentStore.setState({ ready: false, startupError: null, sessions: [], activeId: null, live: {}, notice: null, drafts: {}, deciding: {}, activity: {}, lastRequestAt: null });
  api.list.mockResolvedValue([session("a")]);
});

describe("agent store", () => {
  it("sends the native settings revision and stores the committed revision", async () => {
    useAgentStore.setState({ sessions: [session("settings-cas", { settingsRevision: 4 })] });
    api.update.mockResolvedValueOnce(session("settings-cas", { settingsRevision: 5, tokenBudget: 2000 }));
    await useAgentStore.getState().updateSettings("settings-cas", { tokenBudget: 2000 });
    expect(api.update).toHaveBeenCalledWith("settings-cas", { tokenBudget: 2000, expectedSettingsRevision: 4 });
    expect(useAgentStore.getState().sessions[0]).toMatchObject({ settingsRevision: 5, tokenBudget: 2000 });
  });

  it("refreshes only metadata after a native settings conflict and preserves the rejected draft", async () => {
    const conflict = { code: "agent_session_revision_conflict", message: "Settings changed elsewhere", retryable: true };
    useAgentStore.setState({ sessions: [session("settings-conflict", { settingsRevision: 2 })] });
    api.update.mockRejectedValueOnce(conflict);
    api.read.mockResolvedValueOnce({ summary: session("settings-conflict", { settingsRevision: 3, model: "external-model" }), messages: [], running: true });
    await expect(useAgentStore.getState().updateSettings("settings-conflict", { model: "my-draft" })).rejects.toBe(conflict);
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update).toHaveBeenCalledWith("settings-conflict", { model: "my-draft", expectedSettingsRevision: 2 });
    expect(useAgentStore.getState().sessions[0]).toMatchObject({ settingsRevision: 3, model: "external-model", running: true });
    expect(useAgentStore.getState().live["settings-conflict"]).toBeUndefined();
  });

  it("does not regress a newer settings snapshot when an older IPC response arrives late", async () => {
    let resolveUpdate!: (summary: AgentSessionListItem) => void;
    useAgentStore.setState({ sessions: [session("settings-late", { settingsRevision: 2 })] });
    api.update.mockImplementationOnce(() => new Promise((resolve) => { resolveUpdate = resolve; }));
    const updating = useAgentStore.getState().updateSettings("settings-late", { model: "model-two" });
    useAgentStore.setState({ sessions: [session("settings-late", { settingsRevision: 4, model: "model-four" })] });
    resolveUpdate(session("settings-late", { settingsRevision: 3, model: "model-two" }));
    await updating;
    expect(useAgentStore.getState().sessions[0]).toMatchObject({ settingsRevision: 4, model: "model-four" });
  });

  it("initialises, lists sessions and loads a transcript on open", async () => {
    api.read.mockResolvedValue({
      summary: session("a"),
      running: false,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    await useAgentStore.getState().init();
    expect(useAgentStore.getState().ready).toBe(true);
    await useAgentStore.getState().open("a");
    expect(useAgentStore.getState().live.a?.items).toMatchObject([{ kind: "user", text: "hi" }]);
  });

  it("reports startup failure", async () => {
    api.ensureReady.mockRejectedValueOnce(new Error("no desktop"));
    await useAgentStore.getState().init();
    expect(useAgentStore.getState().startupError).toBe("no desktop");
  });

  it("sends optimistically, then steers while running", async () => {
    api.read.mockResolvedValue({ summary: session("a"), running: false, messages: [] });
    await useAgentStore.getState().init();
    await useAgentStore.getState().open("a");
    await useAgentStore.getState().send("do it");
    expect(api.send).toHaveBeenCalledWith("a", "do it", []);
    expect(useAgentStore.getState().live.a?.running).toBe(true);
    await useAgentStore.getState().send("also this");
    expect(api.steer).toHaveBeenCalledWith("a", "also this");
  });

  it("applies live events and clears running on run_finished", async () => {
    api.read.mockResolvedValue({ summary: session("a"), running: false, messages: [] });
    await useAgentStore.getState().init();
    await useAgentStore.getState().open("a");
    const { applyEvent } = useAgentStore.getState();
    applyEvent({ sessionId: "a", event: { type: "run_started" } });
    applyEvent({ sessionId: "a", event: { type: "stream", event: { type: "text_delta", text: "yo" } } });
    expect(useAgentStore.getState().sessions[0]?.running).toBe(true);
    expect(useAgentStore.getState().live.a?.items[0]).toMatchObject({ kind: "text", text: "yo" });
    applyEvent({ sessionId: "a", event: { type: "run_finished", status: "completed" } });
    expect(useAgentStore.getState().live.a?.running).toBe(false);
    expect(useAgentStore.getState().sessions[0]?.running).toBe(false);
  });

  it("ignores events for sessions that were never opened", async () => {
    await useAgentStore.getState().init();
    useAgentStore.getState().applyEvent({ sessionId: "zzz", event: { type: "run_started" } });
    expect(useAgentStore.getState().live.zzz).toBeUndefined();
  });

  it("shares initialization while startup is in flight", async () => {
    let release!: () => void;
    api.ensureReady.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = useAgentStore.getState().init();
    const second = useAgentStore.getState().init();
    expect(api.ensureReady).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(api.onEvent).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("restores the transcript and preserves a draft when sending fails", async () => {
    api.read.mockResolvedValue({ summary: session("send-failure"), running: false, messages: [] });
    await useAgentStore.getState().open("send-failure");
    useAgentStore.getState().setDraft("send-failure", { text: "keep this", images: [] });
    api.send.mockRejectedValueOnce(new Error("offline"));
    await expect(useAgentStore.getState().send("keep this")).rejects.toThrow("offline");
    expect(useAgentStore.getState().live["send-failure"]?.running).toBe(false);
    expect(useAgentStore.getState().live["send-failure"]?.items).toEqual([]);
    expect(useAgentStore.getState().drafts["send-failure"]?.text).toBe("keep this");
  });

  it("preserves native run events when the send acknowledgement rejects", async () => {
    const id = "send-native-admitted";
    api.list.mockResolvedValue([session(id)]);
    api.read.mockResolvedValue({ summary: session(id), running: false, messages: [] });
    await useAgentStore.getState().init();
    await useAgentStore.getState().open(id);
    let rejectSend!: (reason: Error) => void;
    api.send.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const sending = useAgentStore.getState().send("keep native progress");
    const rejected = expect(sending).rejects.toThrow("acknowledgement lost");
    useAgentStore.getState().applyEvent({ sessionId: id, sequence: 1, event: { type: "run_started" } });
    useAgentStore.getState().applyEvent({ sessionId: id, sequence: 2,
      event: { type: "stream", event: { type: "text_delta", text: "durable progress" } } });
    rejectSend(new Error("acknowledgement lost"));
    await rejected;

    const state = useAgentStore.getState();
    expect(state.live[id]?.running).toBe(true);
    expect(state.live[id]?.items).toMatchObject([
      { kind: "user", text: "keep native progress" },
      { kind: "text", text: "durable progress" },
    ]);
    expect(state.sessions.find((entry) => entry.id === id)?.running).toBe(true);
    expect(state.activity[id]?.runStartedAt).toEqual(expect.any(Number));
    expect(state.notice).toBe("acknowledgement lost");
  });

  it("preserves a completed native run and its duration when send acknowledgement rejects late", async () => {
    const id = "send-native-completed";
    api.list.mockResolvedValue([session(id)]);
    api.read.mockResolvedValue({ summary: session(id), running: false, messages: [] });
    await useAgentStore.getState().init();
    await useAgentStore.getState().open(id);
    let rejectSend!: (reason: Error) => void;
    api.send.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const sending = useAgentStore.getState().send("finish first");
    const rejected = expect(sending).rejects.toThrow("late response failure");
    const apply = useAgentStore.getState().applyEvent;
    apply({ sessionId: id, sequence: 1, event: { type: "run_started" } });
    apply({ sessionId: id, sequence: 2, event: { type: "stream", event: { type: "text_delta", text: "completed answer" } } });
    apply({ sessionId: id, sequence: 3, event: { type: "run_finished", status: "completed" } });
    rejectSend(new Error("late response failure"));
    await rejected;

    const state = useAgentStore.getState();
    expect(state.live[id]).toMatchObject({ running: false, runStatus: "completed" });
    expect(state.live[id]?.items).toMatchObject([
      { kind: "user", text: "finish first" },
      { kind: "text", text: "completed answer", streaming: false },
    ]);
    expect(state.activity[id]).toMatchObject({ runStartedAt: null, lastRunMs: expect.any(Number) });
  });

  it("does not resurrect a session deleted while a send acknowledgement is pending", async () => {
    const id = "send-removed";
    api.list.mockResolvedValue([session(id)]);
    api.read.mockResolvedValue({ summary: session(id), running: false, messages: [] });
    await useAgentStore.getState().init();
    await useAgentStore.getState().open(id);
    let rejectSend!: (reason: Error) => void;
    api.send.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const sending = useAgentStore.getState().send("removed meanwhile");
    const rejected = expect(sending).rejects.toThrow("session removed");
    await useAgentStore.getState().remove(id);
    rejectSend(new Error("session removed"));
    await rejected;

    const state = useAgentStore.getState();
    expect(state.live[id]).toBeUndefined();
    expect(state.activity[id]).toBeUndefined();
    expect(state.sessions).toEqual([]);
    expect(state.activeId).toBeNull();
  });

  it("keeps a newer authoritative read over the optimistic send snapshot on rejection", async () => {
    const id = "send-reloaded";
    api.list.mockResolvedValue([session(id)]);
    api.read.mockResolvedValue({ summary: session(id), running: false, messages: [] });
    await useAgentStore.getState().init();
    await useAgentStore.getState().open(id);
    let rejectSend!: (reason: Error) => void;
    api.send.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const sending = useAgentStore.getState().send("native accepted");
    const rejected = expect(sending).rejects.toThrow("read wins");
    api.read.mockResolvedValueOnce({ summary: session(id), running: true,
      messages: [{ role: "user", content: [{ type: "text", text: "native accepted" }] },
        { role: "assistant", content: [{ type: "text", text: "authoritative saved response" }] }],
      eventCursor: 10, runStatus: "running" });
    await useAgentStore.getState().open(id);
    rejectSend(new Error("read wins"));
    await rejected;

    const state = useAgentStore.getState();
    expect(state.live[id]?.running).toBe(true);
    expect(state.live[id]?.items).toMatchObject([
      { kind: "user", text: "native accepted" },
      { kind: "text", text: "authoritative saved response" },
    ]);
    expect(state.sessions.find((entry) => entry.id === id)?.running).toBe(true);
  });

  it("rejects image steering instead of silently dropping an attachment", async () => {
    api.read.mockResolvedValue({ summary: session("image-steer"), running: true, messages: [] });
    await useAgentStore.getState().open("image-steer");
    await expect(useAgentStore.getState().send("look", [{ mediaType: "image/png", data: "aGVsbG8=" }]))
      .rejects.toThrow("Image steering is not supported");
    expect(api.steer).not.toHaveBeenCalled();
  });

  it("reconciles a previously opened session with authoritative history", async () => {
    api.read.mockResolvedValueOnce({ summary: session("reopen"), running: false, messages: [] });
    await useAgentStore.getState().open("reopen");
    api.read.mockResolvedValueOnce({
      summary: session("reopen"), running: false,
      messages: [{ role: "user", content: [{ type: "text", text: "saved elsewhere" }] }],
    });
    await useAgentStore.getState().open("reopen");
    expect(api.read).toHaveBeenCalledTimes(2);
    expect(useAgentStore.getState().live.reopen?.items).toMatchObject([{ kind: "user", text: "saved elsewhere" }]);
  });

  it("buffers streamed events received while the session read is pending", async () => {
    let resolveRead!: (value: Awaited<ReturnType<typeof agentApi.read>>) => void;
    api.read.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    const opening = useAgentStore.getState().open("read-race");
    useAgentStore.getState().applyEvent({
      sessionId: "read-race", sequence: 2,
      event: { type: "stream", event: { type: "text_delta", text: "after snapshot" } },
    });
    resolveRead({ summary: session("read-race"), running: true, messages: [], eventCursor: 1 });
    await opening;
    expect(useAgentStore.getState().live["read-race"]?.items).toMatchObject([{ kind: "text", text: "after snapshot" }]);
    useAgentStore.getState().applyEvent({
      sessionId: "read-race", sequence: 2,
      event: { type: "stream", event: { type: "text_delta", text: "after snapshot" } },
    });
    expect(useAgentStore.getState().live["read-race"]?.items).toMatchObject([{ kind: "text", text: "after snapshot" }]);
  });

  it("unwraps stored replay events and dedupes snapshot/listener overlap by sequence", async () => {
    let resolveRead!: (value: Awaited<ReturnType<typeof agentApi.read>>) => void;
    api.read.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    const opening = useAgentStore.getState().open("journal-overlap");
    const delta = (text: string) => ({ type: "stream" as const, event: { type: "text_delta" as const, text } });
    useAgentStore.getState().applyEvent({ sessionId: "journal-overlap", sequence: 41, event: delta("A") });
    useAgentStore.getState().applyEvent({ sessionId: "journal-overlap", sequence: 42, event: delta("B") });
    useAgentStore.getState().applyEvent({ sessionId: "journal-overlap", sequence: 42, event: delta("B") });
    resolveRead({ summary: session("journal-overlap"), running: true, messages: [], eventCursor: 41,
      replayEvents: [{ sequence: 40, event: { type: "run_started" } }, { sequence: 41, event: delta("A") }],
      runStatus: "running", unknownSideEffects: [], pendingApprovals: [] });
    await opening;
    expect(useAgentStore.getState().live["journal-overlap"]?.items).toMatchObject([{ kind: "text", text: "AB" }]);
    useAgentStore.getState().applyEvent({ sessionId: "journal-overlap", sequence: 41, event: delta("A") });
    expect(useAgentStore.getState().live["journal-overlap"]?.items).toHaveLength(1);
  });

  it("blocks uncertain recovered effects and clears non-answerable approvals", async () => {
    api.read.mockResolvedValue({ summary: session("uncertain"), running: false, messages: [], runStatus: "interrupted",
      unknownSideEffects: ["task/write"], pendingApprovals: [{ tool_use_id: "w", tool: "write", input: {}, summary: "write", ordinal: 1, total: 1 }],
      replayEvents: [{ sequence: 90, event: { type: "run_started" } }], eventCursor: 90 });
    await useAgentStore.getState().open("uncertain");
    const live = useAgentStore.getState().live.uncertain;
    expect(live).toMatchObject({ running: false, runStatus: "interrupted", recoveryRequired: true, approvals: [], unknownSideEffects: ["task/write"] });
    await expect(useAgentStore.getState().send("continue")).rejects.toThrow("explicitly fork");
    expect(api.send).not.toHaveBeenCalled();
    expect(api.fork).not.toHaveBeenCalled();
  });

  it("also blocks completed but uncheckpointed effects without an unknown tool ID", async () => {
    api.read.mockResolvedValue({ summary: session("uncheckpointed"), running: false, messages: [], runStatus: "failed",
      unknownSideEffects: [], replayEvents: [{ sequence: 100, event: { type: "tool_started", id: "w" } },
        { sequence: 101, event: { type: "tool_completed", id: "w", output: { content: [], is_error: false } } }] });
    await useAgentStore.getState().open("uncheckpointed");
    await expect(useAgentStore.getState().send("again")).rejects.toThrow("explicitly fork");
    expect(api.send).not.toHaveBeenCalled();
  });

  it("passes an explicit null to clear reasoning effort", async () => {
    useAgentStore.setState({ activeId: "effort", sessions: [session("effort", { reasoningEffort: "high" })] });
    api.update.mockResolvedValue(session("effort", { reasoningEffort: null }));
    await useAgentStore.getState().setEffort(null);
    expect(api.update).toHaveBeenCalledWith("effort", { reasoningEffort: null });
    expect(useAgentStore.getState().sessions[0]?.reasoningEffort).toBeNull();
  });

  it("removes a session and clears the selection", async () => {
    api.read.mockResolvedValue({ summary: session("a"), running: false, messages: [] });
    await useAgentStore.getState().init();
    await useAgentStore.getState().open("a");
    await useAgentStore.getState().remove("a");
    expect(useAgentStore.getState().sessions).toEqual([]);
    expect(useAgentStore.getState().activeId).toBeNull();
  });
});

describe("agent store rewind", () => {
  it("shows the preservation notice returned by a conversation-only recovery rewind", async () => {
    const id = "checkpoint-recovery-notice";
    api.read.mockResolvedValue({ summary: session(id), running: false,
      messages: [{ role: "user", content: [{ type: "text", text: "old prompt" }] }] });
    await useAgentStore.getState().open(id);
    api.rewind.mockResolvedValue({ summary: session(id), running: false, messages: [],
      checkpointRecoveryNotice: "Earlier file checkpoints were preserved for recovery." });
    await useAgentStore.getState().rewind(id, 0, false);
    expect(api.rewind).toHaveBeenCalledWith(id, 0, false);
    expect(useAgentStore.getState().live[id]?.items).toContainEqual(expect.objectContaining({
      kind: "notice", text: "Earlier file checkpoints were preserved for recovery.",
    }));
  });

  const messages = Array.from({ length: 16 }, (_, index): AgentMessage => ({
    role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `turn ${index}` }],
  }));
  const compacted = [
    { role: "user", content: [{ type: "text", text: "<summary of earlier conversation>\nfirst turns" }] },
    { role: "assistant", content: [{ type: "text", text: "Understood — continuing from the summary." }] },
    ...messages.slice(10),
  ] as AgentMessage[];
  const detail = (id: string, content: AgentMessage[], eventCursor: number): AgentSessionDetail => ({
    summary: session(id), running: false, messages: content, eventCursor,
  });

  it("reloads compacted positions after final publication and never sends the old turn14 index", async () => {
    const id = "compaction-positions";
    api.list.mockResolvedValue([session(id)]);
    api.read.mockResolvedValueOnce(detail(id, messages, 200));
    await useAgentStore.getState().open(id);
    let finishRead!: (value: AgentSessionDetail) => void;
    api.read.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const applyEvent = useAgentStore.getState().applyEvent;
    applyEvent({ sessionId: id, sequence: 201, event: { type: "run_started" } });
    applyEvent({ sessionId: id, sequence: 202, event: { type: "compacted", before: 16, after: 8 } });
    applyEvent({ sessionId: id, sequence: 203, event: { type: "error", message: "kept diagnostic" } });
    applyEvent({ sessionId: id, sequence: 204, event: { type: "run_finished", status: "completed" } });
    expect(useAgentStore.getState().live[id]?.rewindStale).toBe(true);
    await useAgentStore.getState().rewind(id, 2, true);
    expect(api.rewind).not.toHaveBeenCalled();
    finishRead({ ...detail(id, compacted, 204), replayEvents: [{ sequence: 204, event: { type: "run_finished", status: "completed" } }] });
    await vi.waitFor(() => expect(useAgentStore.getState().live[id]?.rewindStale).not.toBe(true));
    const live = useAgentStore.getState().live[id]!;
    expect(live.items.find((item) => item.kind === "user" && item.text === "turn 14")).toMatchObject({ messageIndex: 6 });
    expect(live.items.find((item) => item.kind === "user" && item.text === "turn 10")).toMatchObject({ messageIndex: 2 });
    expect(live.items.some((item) => item.kind === "user" && item.text === "turn 2")).toBe(false);
    expect(live.items.filter((item) => item.kind === "error" && item.message === "kept diagnostic")).toHaveLength(1);
    expect(live.items.filter((item) => item.kind === "text" && item.text === "turn 15")).toHaveLength(1);
    await useAgentStore.getState().rewind(id, 14, true);
    expect(api.rewind).not.toHaveBeenCalled();
    api.rewind.mockResolvedValueOnce(detail(id, compacted.slice(0, 6), 204));
    await useAgentStore.getState().rewind(id, 6, true);
    expect(api.rewind).toHaveBeenCalledExactlyOnceWith(id, 6, true);
  });

  it("keeps stale rewind disabled on reload failure and recovers on reopening", async () => {
    const id = "compaction-read-failure";
    api.list.mockResolvedValue([session(id)]);
    api.read.mockResolvedValueOnce(detail(id, messages, 300));
    await useAgentStore.getState().open(id);
    api.read.mockRejectedValueOnce(new Error("read unavailable"));
    useAgentStore.getState().applyEvent({ sessionId: id, sequence: 301, event: { type: "compacted", before: 16, after: 8 } });
    useAgentStore.getState().applyEvent({ sessionId: id, sequence: 302, event: { type: "run_finished", status: "failed", message: "provider failure" } });
    await vi.waitFor(() => expect(useAgentStore.getState().live[id]?.items).toContainEqual(expect.objectContaining({ kind: "notice", text: expect.stringContaining("Reopen this session") })));
    expect(useAgentStore.getState().live[id]?.runStatus).toBe("failed");
    await useAgentStore.getState().rewind(id, 2, false);
    expect(api.rewind).not.toHaveBeenCalled();
    await expect(useAgentStore.getState().send("continue", [], id)).rejects.toThrow("Reopen this session");
    api.read.mockResolvedValueOnce(detail(id, compacted, 302));
    await useAgentStore.getState().open(id);
    expect(useAgentStore.getState().live[id]?.rewindStale).not.toBe(true);
    expect(useAgentStore.getState().live[id]?.items.some((item) => item.key === "rewind-transcript-reload")).toBe(false);
  });

  it("does not treat a pre-compaction read plus buffered finish as an authoritative new transcript", async () => {
    const id = "compaction-old-read";
    api.list.mockResolvedValue([session(id)]);
    let finishOldRead!: (value: AgentSessionDetail) => void;
    api.read.mockImplementationOnce(() => new Promise((resolve) => { finishOldRead = resolve; }));
    api.read.mockResolvedValueOnce(detail(id, compacted, 502));
    const opening = useAgentStore.getState().open(id);
    useAgentStore.getState().applyEvent({ sessionId: id, sequence: 501, event: { type: "compacted", before: 16, after: 8 } });
    useAgentStore.getState().applyEvent({ sessionId: id, sequence: 502, event: { type: "run_finished", status: "completed" } });
    finishOldRead(detail(id, messages, 500));
    await opening;
    await vi.waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(useAgentStore.getState().live[id]?.rewindStale).not.toBe(true));
    expect(useAgentStore.getState().live[id]?.items.find((item) => item.kind === "user" && item.text === "turn 14")).toMatchObject({ messageIndex: 6 });
    expect(useAgentStore.getState().live[id]?.items.some((item) => item.kind === "user" && item.text === "turn 2")).toBe(false);
  });

  it("rehydrates a compacted background session without changing selection and cannot resurrect a removed session", async () => {
    const id = "compaction-background";
    api.list.mockResolvedValue([session(id), session("other-pane")]);
    api.read.mockResolvedValueOnce(detail(id, messages, 400));
    await useAgentStore.getState().open(id);
    let finishRead!: (value: AgentSessionDetail) => void;
    api.read.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    useAgentStore.getState().applyEvent({ sessionId: id, sequence: 401, event: { type: "compacted", before: 16, after: 8 } });
    useAgentStore.getState().applyEvent({ sessionId: id, sequence: 402, event: { type: "run_finished", status: "completed" } });
    api.read.mockResolvedValueOnce(detail("other-pane", [], 0));
    await useAgentStore.getState().open("other-pane");
    finishRead(detail(id, compacted, 402));
    await vi.waitFor(() => expect(useAgentStore.getState().live[id]?.rewindStale).not.toBe(true));
    expect(useAgentStore.getState().activeId).toBe("other-pane");

    let finishRemovedRead!: (value: AgentSessionDetail) => void;
    api.read.mockImplementationOnce(() => new Promise((resolve) => { finishRemovedRead = resolve; }));
    useAgentStore.getState().applyEvent({ sessionId: id, sequence: 403, event: { type: "compacted", before: 8, after: 4 } });
    useAgentStore.getState().applyEvent({ sessionId: id, sequence: 404, event: { type: "run_finished", status: "completed" } });
    await useAgentStore.getState().remove(id);
    finishRemovedRead(detail(id, compacted.slice(0, 4), 404));
    await Promise.resolve();
    expect(useAgentStore.getState().live[id]).toBeUndefined();
    expect(useAgentStore.getState().activeId).toBe("other-pane");
  });

  it("rewinds with files and appends an honest restore summary", async () => {
    api.rewind.mockResolvedValue({
      summary: session("a", { messageCount: 1 }),
      running: false,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      fileRestore: { restored: ["C:\proj\a.ts"], deleted: ["C:\proj\new.ts"], skippedTooLarge: [], failed: [], untrackedNote: "Shell changes are not tracked." },
    });
    await useAgentStore.getState().rewind("a", 1, true);
    expect(api.rewind).toHaveBeenCalledWith("a", 1, true);
    const items = useAgentStore.getState().live.a?.items ?? [];
    expect(items[0]).toMatchObject({ kind: "user", messageIndex: 0 });
    expect(items[items.length - 1]).toMatchObject({ kind: "notice" });
    expect((items[items.length - 1] as { text: string }).text).toContain("restored 1 file");
    expect((items[items.length - 1] as { text: string }).text).toContain("Shell changes are not tracked.");
  });

  it("surfaces a rewind failure as a notice", async () => {
    api.rewind.mockRejectedValue(new Error("Interrupt the agent before rewinding"));
    await useAgentStore.getState().rewind("a", 0, false);
    expect(useAgentStore.getState().notice).toContain("Interrupt");
  });
});

describe("agent store request activity", () => {
  it("tracks lastRequestAt, run start and duration per session and globally from wire events", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(10_000);
      api.list.mockResolvedValue([session("a"), session("b")]);
      await useAgentStore.getState().init();
      const { applyEvent } = useAgentStore.getState();
      // Tracked even for a session whose transcript is not loaded.
      applyEvent({ sessionId: "a", event: { type: "run_started" } });
      expect(useAgentStore.getState().activity.a).toEqual({ lastRequestAt: 10_000, runStartedAt: 10_000, lastRunMs: null });
      vi.setSystemTime(12_000);
      applyEvent({ sessionId: "a", event: { type: "stream", event: { type: "text_delta", text: "x" } } });
      expect(useAgentStore.getState().activity.a?.lastRequestAt).toBe(10_000);
      applyEvent({ sessionId: "a", event: { type: "assistant_message", message: { role: "assistant", content: [] } } });
      expect(useAgentStore.getState().activity.a?.lastRequestAt).toBe(12_000);
      vi.setSystemTime(15_000);
      applyEvent({ sessionId: "b", event: { type: "turn_started", turn: 1 } });
      expect(useAgentStore.getState().lastRequestAt).toBe(15_000);
      vi.setSystemTime(52_000);
      applyEvent({ sessionId: "a", event: { type: "run_finished", status: "completed" } });
      expect(useAgentStore.getState().activity.a).toEqual({ lastRequestAt: 12_000, runStartedAt: null, lastRunMs: 42_000 });
      expect(useAgentStore.getState().lastRequestAt).toBe(15_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the run timer on send and clears it when sending fails", async () => {
    api.read.mockResolvedValue({ summary: session("a"), running: false, messages: [] });
    await useAgentStore.getState().init();
    await useAgentStore.getState().open("a");
    api.send.mockRejectedValueOnce(new Error("offline"));
    await expect(useAgentStore.getState().send("hi")).rejects.toThrow("offline");
    expect(useAgentStore.getState().activity.a?.runStartedAt).toBeNull();
    await useAgentStore.getState().send("hi");
    expect(useAgentStore.getState().activity.a?.runStartedAt).toEqual(expect.any(Number));
  });
});
