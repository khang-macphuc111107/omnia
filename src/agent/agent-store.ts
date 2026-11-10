import { create } from "zustand";

import { agentApi, errorMessage } from "./agent-api";
import { maybeNotify } from "./notify";
import { maybeAutoRead } from "./voice";
import { readPrefs, writePrefs } from "./prefs";
import {
  clampRatio,
  closePane,
  focusPane,
  focusedId,
  initialSplit,
  openInSplit,
  pickPartner,
  pruneSplit,
  setRatio,
  showInFocused,
  survivorOf,
  swapPanes,
  visibleSessionIds,
  type PaneIndex,
  type SplitState,
} from "./split";
import { summarizeRestore } from "./rewind";
import {
  addUserMessage,
  emptyLive,
  restoreSession,
  reduceAgentEvent,
  type LiveState,
} from "./transcript";
import type {
  AgentEventPayload,
  AgentImageInput,
  AgentSessionListItem,
  ApprovalDecision,
  CreateSessionInput,
  DataImportMode,
  PermissionMode,
} from "./types";

export interface ArtifactRequest {
  sessionId: string;
  id: string;
  version?: number;
  /** `open`: user asked to see it. `created` opens the panel; `updated`/`deleted` only refresh an open one. */
  reason: "open" | "created" | "updated" | "deleted";
  n: number;
}

let artifactRequests = 0;

/** Read-only timing derived from wire events; timestamps are taken here (`Date.now()`), never in the reducer. */
export interface SessionActivity {
  /** Latest model request or response activity (run/turn start, assistant message, turn end). */
  lastRequestAt: number | null;
  /** Start of the current run; null when idle or when the run started before this window saw it. */
  runStartedAt: number | null;
  /** Wall-clock length of the last finished run, when its start was seen. */
  lastRunMs: number | null;
}

const REQUEST_EVENTS = new Set(["run_started", "turn_started", "assistant_message", "turn_completed", "run_completed"]);

/** Applies one wire event's timing to a session's activity; returns the same object when nothing changed. */
export function nextActivity(previous: SessionActivity | undefined, event: AgentEventPayload["event"], now: number): SessionActivity | undefined {
  const inner = event.type === "subagent" ? event.event : event;
  const request = REQUEST_EVENTS.has(inner.type);
  if (!request && event.type !== "run_finished") return previous;
  const base: SessionActivity = previous ?? { lastRequestAt: null, runStartedAt: null, lastRunMs: null };
  const next: SessionActivity = { ...base };
  if (request) next.lastRequestAt = now;
  if (event.type === "run_started") next.runStartedAt = base.runStartedAt ?? now;
  if (event.type === "run_finished") {
    next.lastRunMs = base.runStartedAt === null ? base.lastRunMs : Math.max(0, now - base.runStartedAt);
    next.runStartedAt = null;
  }
  return next;
}

export interface AgentState {
  ready: boolean;
  startupError: string | null;
  sessions: AgentSessionListItem[];
  activeId: string | null;
  /** Loaded sessions only; unopened sessions are read lazily. */
  live: Record<string, LiveState>;
  /** Last action error, shown inline and cleared on the next action. */
  notice: string | null;
  drafts: Record<string, { text: string; images: AgentImageInput[] }>;
  deciding: Record<string, boolean>;
  /** Split view. `activeId` always mirrors the focused pane, so session actions act on it. */
  split: SplitState;
  /** Window too narrow for two panes: only the focused pane is shown. */
  narrow: boolean;
  setNarrow: (narrow: boolean) => void;
  /** Latest request to show an artifact (agent event or transcript card); `n` makes repeats distinct. */
  artifactRequest: ArtifactRequest | null;
  /** Per-session request timing, derived from wire events (read-only for views). */
  activity: Record<string, SessionActivity>;
  /** Latest `lastRequestAt` across all sessions, for workspace views. */
  lastRequestAt: number | null;
  requestArtifact: (request: Omit<ArtifactRequest, "n">) => void;
  openInSplit: (sessionId: string) => void;
  closeSplitPane: (index: PaneIndex) => void;
  swapSplit: () => void;
  focusSplitPane: (index: PaneIndex) => void;
  /** Ctrl+Backslash: close the split, or reopen it beside the last other session. */
  toggleSplit: () => void;
  setSplitRatio: (ratio: number, persist?: boolean) => void;
  /** Ensure a session's transcript is loaded without changing the focused session. */
  load: (sessionId: string) => Promise<void>;
  setDraft: (id: string, draft: { text: string; images: AgentImageInput[] }) => void;
  setEffort: (effort: string | null, sessionId?: string) => Promise<void>;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  /**
   * Reconcile renderer state after native data import.  Import mutates the
   * durable session store outside Zustand, so a plain Settings success toast
   * is not enough: replace imports can remove sessions and merge imports can
   * update summaries/transcripts that are already cached in this window.
   */
  reloadAfterImport: (mode: DataImportMode) => Promise<void>;
  open: (sessionId: string | null) => Promise<void>;
  create: (input: CreateSessionInput) => Promise<void>;
  send: (text: string, images?: AgentImageInput[], sessionId?: string) => Promise<void>;
  interrupt: (sessionId?: string) => Promise<void>;
  decide: (toolUseId: string, decision: ApprovalDecision, sessionId?: string) => Promise<void>;
  /** Answer the shown approval and all queued behind it ("allow all pending" / "deny all pending"). */
  decideAll: (toolUseId: string, decision: ApprovalDecision, sessionId?: string) => Promise<void>;
  rename: (sessionId: string, title: string) => Promise<void>;
  fork: (sessionId: string) => Promise<void>;
  /** Keep the first `keep` messages; optionally restore files changed after them. */
  rewind: (sessionId: string, keep: number, restoreFiles: boolean) => Promise<void>;
  remove: (sessionId: string) => Promise<void>;
  setModel: (model: string, profileId?: string, sessionId?: string) => Promise<void>;
  setPermissionMode: (mode: PermissionMode, sessionId?: string) => Promise<void>;
  /** Patch per-session settings; rejects with the native error so a dialog can show it. */
  updateSettings: (sessionId: string, patch: Parameters<typeof agentApi.update>[1]) => Promise<void>;
  applyEvent: (payload: AgentEventPayload) => void;
}

let unlisten: (() => void) | null = null;
let initializing: Promise<void> | null = null;
const reads = new Map<string, Promise<void>>();
const duringRead = new Map<string, AgentEventPayload[]>();
const cursors = new Map<string, number>();
const readTokens = new Map<string, symbol>();
const REWIND_RELOAD_KEY = "rewind-transcript-reload";
const REWIND_RELOAD_MESSAGE = "Rewind is unavailable because the compacted transcript could not be reloaded. Reopen this session to reload it before rewinding or sending another message.";

export const useAgentStore = create<AgentState>((set, get) => {
  const patchSession = (id: string, patch: Partial<AgentSessionListItem>) =>
    set((state) => ({
      sessions: state.sessions.map((session) => (session.id === id ? { ...session, ...patch } : session)),
    }));
  const fail = (cause: unknown) => set({ notice: errorMessage(cause) });
  const updateSessionSettings = async (id: string, patch: Parameters<typeof agentApi.update>[1]) => {
    const revision = patch.expectedSettingsRevision ?? get().sessions.find((session) => session.id === id)?.settingsRevision;
    try {
      const summary = await agentApi.update(id, {
        ...patch,
        ...(revision === undefined ? {} : { expectedSettingsRevision: revision }),
      });
      const currentRevision = get().sessions.find((session) => session.id === id)?.settingsRevision;
      if (summary.settingsRevision === undefined || currentRevision === undefined || summary.settingsRevision >= currentRevision) {
        patchSession(id, summary);
      }
      return summary;
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "agent_session_revision_conflict") {
        // Refresh only metadata: reading the transcript here could replace a
        // stream in progress. The rejected draft remains with its caller and
        // is never retried automatically against another user's edit.
        try {
          const detail = await agentApi.read(id);
          patchSession(id, { ...detail.summary, running: detail.running });
        } catch { /* preserve the original revision conflict for the caller */ }
      }
      throw cause;
    }
  };
  /** Commit a split change; the focused pane becomes the active session. */
  const applySplit = (split: SplitState, activeId?: string | null) => {
    const focus = activeId === undefined ? focusedId(split) : activeId;
    set({ split, ...(focus ? { activeId: focus } : {}), notice: null });
  };
  /** Collapse the split when one of its sessions no longer exists. */
  const reconcileSplit = (state: AgentState, ids: ReadonlySet<string>): Partial<AgentState> => {
    const panes = state.split.panes;
    if (!panes || panes.every((id) => ids.has(id))) return {};
    const survivor = panes.find((id) => ids.has(id)) ?? null;
    return { split: pruneSplit(state.split, ids), activeId: survivor };
  };
  const readSession = (sessionId: string): Promise<void> => {
    const existing = reads.get(sessionId);
    if (existing) return existing;
    const token = Symbol(sessionId);
    readTokens.set(sessionId, token);
    const refreshingCompaction = get().live[sessionId]?.rewindStale === true;
    duringRead.set(sessionId, []);
    const task = (async () => {
      try {
        const detail = await agentApi.read(sessionId);
        if (readTokens.get(sessionId) !== token) return;
        let live = restoreSession(detail);
        let cursor = (detail.replayEvents ?? []).reduce((last, entry) => Math.max(last, entry.sequence), detail.eventCursor ?? -1);
        const buffered = [...(duringRead.get(sessionId) ?? [])].sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity));
        for (const payload of buffered) {
          if (payload.sequence !== undefined) {
            if (payload.sequence <= cursor) continue;
            cursor = payload.sequence;
          }
          live = reduceAgentEvent(live, payload.event);
        }
        if (refreshingCompaction) {
          // Rebuild positions from native messages, retaining diagnostics which
          // may already have moved behind the persisted journal watermark.
          const diagnostics = (get().live[sessionId]?.items ?? []).filter((item) =>
            (item.kind === "error" || item.kind === "notice") && !item.key.startsWith(REWIND_RELOAD_KEY));
          for (const item of diagnostics) {
            if (item.kind !== "error" && item.kind !== "notice") continue;
            if (!live.items.some((other) => other.kind === item.kind &&
              (item.kind === "error" ? other.kind === "error" && other.message === item.message : other.kind === "notice" && other.text === item.text))) {
              live.items.push({ ...item, key: `rehydrated-${item.key}` });
            }
          }
          if (live.rewindStale) {
            live.items.push({ key: REWIND_RELOAD_KEY, kind: "notice", text: REWIND_RELOAD_MESSAGE });
          }
        }
        cursors.set(sessionId, Math.max(cursors.get(sessionId) ?? -1, cursor));
        set((current) => ({ live: { ...current.live, [sessionId]: live } }));
        patchSession(sessionId, { ...detail.summary, running: live.running });
      } catch (cause) {
        if (readTokens.get(sessionId) !== token) return;
        if (refreshingCompaction) {
          set((state) => {
            const previous = state.live[sessionId];
            if (!previous) return {};
            return { live: { ...state.live, [sessionId]: { ...previous, rewindStale: true,
              items: [...previous.items.filter((item) => item.key !== REWIND_RELOAD_KEY),
                { key: REWIND_RELOAD_KEY, kind: "notice" as const, text: `${REWIND_RELOAD_MESSAGE} ${errorMessage(cause)}` }],
            } } };
          });
        } else fail(cause);
      } finally {
        if (readTokens.get(sessionId) === token) {
          duringRead.delete(sessionId);
          reads.delete(sessionId);
          readTokens.delete(sessionId);
        }
      }
    })();
    reads.set(sessionId, task);
    return task;
  };
  const reloadCompactedTranscript = async (sessionId: string): Promise<void> => {
    // An earlier open may have captured the old transcript. Let its buffered
    // compaction event invalidate it, then request the post-publication detail.
    const pending = reads.get(sessionId);
    if (pending) await pending;
    const live = get().live[sessionId];
    if (!live?.rewindStale || live.running) return;
    await readSession(sessionId);
  };

  return {
    ready: false,
    startupError: null,
    sessions: [],
    activeId: null,
    live: {},
    notice: null,
    drafts: {},
    deciding: {},
    setDraft(id, draft) {
      set((state) => ({ drafts: { ...state.drafts, [id]: draft } }));
    },
    async setEffort(reasoningEffort, sessionId) {
      const id = sessionId ?? get().activeId;
      if (!id) return;
      try { patchSession(id, await agentApi.update(id, { reasoningEffort })); }
      catch (cause) { fail(cause); }
    },

    init() {
      if (get().ready) return Promise.resolve();
      if (initializing) return initializing;
      set({ startupError: null });
      initializing = (async () => {
        try {
          await agentApi.ensureReady();
          unlisten?.();
          unlisten = await agentApi.onEvent((payload) => get().applyEvent(payload));
          const sessions = await agentApi.list();
          set({ sessions, ready: true, startupError: null });
        } catch (cause) {
          unlisten?.();
          unlisten = null;
          set({ startupError: errorMessage(cause) });
        }
      })().finally(() => { initializing = null; });
      return initializing;
    },

    async refresh() {
      try {
        const sessions = await agentApi.list();
        set((state) => ({ sessions, ...reconcileSplit(state, new Set(sessions.map((entry) => entry.id))) }));
      } catch (cause) {
        fail(cause);
      }
    },

    async reloadAfterImport(mode) {
      // Read the new list before touching any cached state.  If the native
      // listing fails, the old sidebar/transcripts remain visible and the
      // caller can report the refresh failure without losing the import
      // receipt it already displayed.
      const sessions = await agentApi.list();
      const ids = new Set(sessions.map((entry) => entry.id));
      const loadedIds = Object.keys(get().live);
      const removedIds = mode === "replace" ? loadedIds.filter((id) => !ids.has(id)) : [];

      set((state) => {
        const live = { ...state.live };
        const drafts = { ...state.drafts };
        const activity = { ...state.activity };
        for (const id of removedIds) {
          delete live[id];
          delete drafts[id];
          delete activity[id];
          // A read which was in flight for a replaced-away session must not
          // publish its old snapshot after the new list is committed.
          readTokens.delete(id);
          reads.delete(id);
          duringRead.delete(id);
          cursors.delete(id);
        }
        return {
          sessions,
          live,
          drafts,
          activity,
          ...reconcileSplit({ ...state, sessions }, ids),
          notice: null,
        };
      });

      // A merge can overwrite an existing session when the imported bundle
      // has the same id.  Rehydrate every currently loaded survivor for both
      // modes; readSession buffers incoming wire events and keeps the prior
      // snapshot intact if a single read fails.
      const survivors = loadedIds.filter((id) => ids.has(id));
      await Promise.all(survivors.map((id) => readSession(id)));
    },

    async open(sessionId) {
      set((state) => ({
        activeId: sessionId,
        notice: null,
        split: !sessionId
          ? { ...state.split, panes: null, focused: 0 }
          : showInFocused(state.split, sessionId),
      }));
      if (!sessionId) return;
      return readSession(sessionId);
    },

    load(sessionId) {
      if (get().live[sessionId] && !get().live[sessionId]?.rewindStale) return Promise.resolve();
      return readSession(sessionId);
    },

    split: initialSplit(readPrefs().splitRatio),
    narrow: false,
    artifactRequest: null,
    activity: {},
    lastRequestAt: null,
    requestArtifact(request) {
      set({ artifactRequest: { ...request, n: ++artifactRequests } });
    },
    setNarrow(narrow) {
      if (get().narrow !== narrow) set({ narrow });
    },
    openInSplit(sessionId) {
      const state = get();
      const next = openInSplit(state.split, state.activeId, sessionId);
      if (next === state.split) return;
      applySplit(next);
      void get().load(sessionId);
    },
    closeSplitPane(index) {
      const state = get();
      if (!state.split.panes) return;
      const survivor = survivorOf(state.split, index);
      applySplit(closePane(state.split, index), survivor);
      if (survivor) void get().load(survivor);
    },
    swapSplit() {
      applySplit(swapPanes(get().split));
    },
    focusSplitPane(index) {
      const state = get();
      const next = focusPane(state.split, index);
      if (next !== state.split) applySplit(next);
    },
    toggleSplit() {
      const state = get();
      if (state.split.panes) {
        // Keep the focused session, drop the other.
        get().closeSplitPane(state.split.focused === 0 ? 1 : 0);
        return;
      }
      const partner = pickPartner(state.split, state.activeId, state.sessions);
      if (partner) get().openInSplit(partner);
    },
    setSplitRatio(ratio, persist = true) {
      set({ split: setRatio(get().split, ratio) });
      if (persist) writePrefs({ splitRatio: clampRatio(ratio) });
    },

    async create(input) {
      try {
        const summary = await agentApi.create(input);
        set((state) => ({
          sessions: [{ ...summary, running: false }, ...state.sessions],
          live: { ...state.live, [summary.id]: emptyLive() },
          activeId: summary.id,
          split: showInFocused(state.split, summary.id),
          notice: null,
        }));
      } catch (cause) {
        fail(cause);
        throw cause;
      }
    },

    async send(text, images = [], sessionId) {
      const id = sessionId ?? get().activeId;
      if (!id) throw new Error("Open a session before sending.");
      const previous = get().live[id];
      if (!previous) throw new Error("Wait for the session to finish loading before sending.");
      if (previous.rewindStale) {
        const message = "Reopen this session to reload its compacted transcript before sending another message.";
        set({ notice: message });
        throw new Error(message);
      }
      if (previous.recoveryRequired) {
        const message = "Review and reconcile the interrupted tool journal, then explicitly fork the session. Uncertain effects will not be replayed.";
        set({ notice: message });
        throw new Error(message);
      }
      const running = previous.running;
      set({ notice: null });
      let reservation: LiveState | undefined;
      try {
        if (running) {
          if (images.length) throw new Error("Image steering is not supported. Keep the attachment and send it after the agent stops.");
          await agentApi.steer(id, text);
          return;
        }
        // Reserve the run before IPC; native events may arrive before invoke resolves.
        set((state) => {
          reservation = { ...addUserMessage(state.live[id] ?? emptyLive(), text, images.length), running: true };
          return { live: { ...state.live, [id]: reservation } };
        });
        patchSession(id, { running: true });
        const startedAt = Date.now();
        set((state) => ({
          activity: { ...state.activity, [id]: { lastRequestAt: state.activity[id]?.lastRequestAt ?? null, lastRunMs: state.activity[id]?.lastRunMs ?? null, runStartedAt: startedAt } },
        }));
        await agentApi.send(id, text, images);
      } catch (cause) {
        // Once native has acknowledged the run, the invoke may still reject
        // because its response was lost. Preserve the authoritative event
        // stream and surface the error instead of restoring an obsolete
        // renderer snapshot over it. The identity check also protects a read,
        // rewind or deletion that superseded this optimistic reservation.
        if (!running) {
          set((state) => state.live[id] !== reservation ? {} : ({
            live: { ...state.live, [id]: previous },
            sessions: state.sessions.map((session) => session.id === id ? { ...session, running: false } : session),
            ...(state.activity[id] ? { activity: { ...state.activity, [id]: { ...state.activity[id]!, runStartedAt: null } } } : {}),
          }));
        }
        fail(cause);
        throw cause;
      }
    },

    async interrupt(sessionId) {
      const id = sessionId ?? get().activeId;
      if (!id) return;
      try {
        await agentApi.interrupt(id);
      } catch (cause) {
        fail(cause);
      }
    },

    async decide(toolUseId, decision, sessionId) {
      const id = sessionId ?? get().activeId;
      if (!id) return;
      const key = `${id}:${toolUseId}`;
      if (get().deciding[key]) return;
      set((state) => ({ deciding: { ...state.deciding, [key]: true }, notice: null }));
      try {
        await agentApi.decide(id, toolUseId, decision);
        get().applyEvent({ sessionId: id, event: { type: "approval_decided", id: toolUseId, decision } });
      } catch (cause) {
        fail(cause);
        throw cause;
      } finally {
        set((state) => { const { [key]: _done, ...deciding } = state.deciding; return { deciding }; });
      }
    },

    async decideAll(toolUseId, decision, sessionId) {
      const id = sessionId ?? get().activeId;
      if (!id) return;
      const key = `${id}:${toolUseId}`;
      if (get().deciding[key]) return;
      set((state) => ({ deciding: { ...state.deciding, [key]: true }, notice: null }));
      try {
        await agentApi.decideAll(id, toolUseId, decision);
        get().applyEvent({ sessionId: id, event: { type: "approval_decided", id: toolUseId, decision } });
      } catch (cause) {
        fail(cause);
        throw cause;
      } finally {
        set((state) => { const { [key]: _done, ...deciding } = state.deciding; return { deciding }; });
      }
    },

    async rename(sessionId, title) {
      try {
        await updateSessionSettings(sessionId, { title });
      } catch (cause) {
        fail(cause);
      }
    },

    async fork(sessionId) {
      try {
        const summary = await agentApi.fork(sessionId);
        set((state) => ({ sessions: [{ ...summary, running: false }, ...state.sessions] }));
        await get().open(summary.id);
      } catch (cause) {
        fail(cause);
      }
    },

    async rewind(sessionId, keep, restoreFiles) {
      const current = get().live[sessionId];
      if (current?.rewindStale || current?.running) {
        set({ notice: current.rewindStale ? REWIND_RELOAD_MESSAGE : "Interrupt the agent before rewinding." });
        return;
      }
      if (current && !current.items.some((item) => item.kind === "user" && item.messageIndex === keep)) {
        set({ notice: "This rewind position is no longer in the loaded transcript. Reopen the session before rewinding." });
        return;
      }
      try {
        const detail = await agentApi.rewind(sessionId, keep, restoreFiles);
        let live = restoreSession(detail);
        if (detail.fileRestore) {
          live = {
            ...live,
            items: [...live.items, { key: `notice-rewind-${Date.now()}`, kind: "notice", text: summarizeRestore(detail.fileRestore) }],
          };
        }
        if (detail.checkpointRecoveryNotice) {
          live = {
            ...live,
            items: [...live.items, { key: `notice-checkpoint-recovery-${Date.now()}`, kind: "notice", text: detail.checkpointRecoveryNotice }],
          };
        }
        cursors.set(sessionId, Math.max(cursors.get(sessionId) ?? -1, detail.eventCursor ?? -1));
        set((state) => ({ live: { ...state.live, [sessionId]: live }, notice: null }));
        patchSession(sessionId, { ...detail.summary, running: false });
      } catch (cause) {
        fail(cause);
      }
    },

    async remove(sessionId) {
      try {
        await agentApi.remove(sessionId);
        readTokens.delete(sessionId);
        reads.delete(sessionId);
        duringRead.delete(sessionId);
        set((state) => {
          const { [sessionId]: _removed, ...live } = state.live;
          const { [sessionId]: _draft, ...drafts } = state.drafts;
          const { [sessionId]: _activity, ...activity } = state.activity;
          cursors.delete(sessionId);
          const sessions = state.sessions.filter((session) => session.id !== sessionId);
          const collapsed = reconcileSplit({ ...state, sessions }, new Set(sessions.map((entry) => entry.id)));
          return {
            drafts,
            activity,
            sessions,
            live,
            activeId: state.activeId === sessionId ? null : state.activeId,
            ...collapsed,
          };
        });
      } catch (cause) {
        fail(cause);
      }
    },

    async setModel(model, profileId, sessionId) {
      const id = sessionId ?? get().activeId;
      if (!id) return;
      try {
        await updateSessionSettings(id, profileId ? { model, profileId } : { model });
      } catch (cause) {
        fail(cause);
      }
    },

    async updateSettings(sessionId, patch) {
      await updateSessionSettings(sessionId, patch);
    },

    async setPermissionMode(mode, sessionId) {
      const id = sessionId ?? get().activeId;
      if (!id) return;
      try {
        await updateSessionSettings(id, { permissionMode: mode });
      } catch (cause) {
        fail(cause);
      }
    },

    applyEvent(payload) {
      const { sessionId, event, sequence } = payload;
      // Buffer even an event already rendered before this snapshot: the read
      // may have captured an older checkpoint. Dedupe against its own cursor.
      duringRead.get(sessionId)?.push(payload);
      if (sequence !== undefined) {
        if (sequence <= (cursors.get(sessionId) ?? -1)) return;
        cursors.set(sessionId, sequence);
      }
      const activity = nextActivity(get().activity[sessionId], event, Date.now());
      if (activity && activity !== get().activity[sessionId]) {
        set((prev) => ({
          activity: { ...prev.activity, [sessionId]: activity },
          lastRequestAt: activity.lastRequestAt !== null && activity.lastRequestAt > (prev.lastRequestAt ?? -Infinity)
            ? activity.lastRequestAt : prev.lastRequestAt,
        }));
      }
      const state = get();
      const current = state.live[sessionId];
      maybeNotify(sessionId, event, {
        title: state.sessions.find((session) => session.id === sessionId)?.title || "Omnia",
        selectedId: visibleSessionIds(state.split, state.activeId, state.narrow).includes(sessionId) ? sessionId : state.activeId,
        select: (id) => void get().open(id),
      });
      if (event.type === "run_started") {
        patchSession(sessionId, { running: true });
        // A run on a session we have not listed yet (started by an MCP client).
        if (!state.sessions.some((session) => session.id === sessionId)) void get().refresh();
      }
      if (event.type === "run_finished") {
        patchSession(sessionId, { running: false });
        void get().refresh();
      }
      const artifact = event.type === "subagent" ? event.event : event;
      if (artifact.type === "artifact") {
        get().requestArtifact({
          sessionId,
          id: artifact.id,
          version: artifact.version,
          reason: artifact.action === "create" ? "created" : artifact.action === "delete" ? "deleted" : "updated",
        });
      }
      if (!current) {
        if (event.type === "run_finished") void reloadCompactedTranscript(sessionId);
        return;
      }
      const reduced = reduceAgentEvent(current, event);
      set({ live: { ...state.live, [sessionId]: reduced } });
      if (event.type === "run_finished" && reduced.rewindStale) {
        void reloadCompactedTranscript(sessionId);
      }
      if (event.type === "run_finished" && event.status === "completed") {
        // Optional read-aloud of the final answer; only for a conversation the user can see.
        const last = [...reduced.items].reverse().find((item) => item.kind === "text" && !item.streaming);
        if (last?.kind === "text" && visibleSessionIds(state.split, state.activeId, state.narrow).includes(sessionId)) {
          maybeAutoRead(last.text, `${sessionId}:${last.key}`);
        }
      }
    },
  };
});
