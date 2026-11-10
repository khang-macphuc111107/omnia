import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { desktop, invokeCore, isDesktopRuntime } from "@/lib/desktop";

export type ChatStatus = "loading" | "ready" | "running" | "disconnected" | "error";
export type ChatScope = "non-project" | "project";
export type ChatEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface ChatSession {
  id: string;
  title: string;
  scope: ChatScope;
  cwd?: string;
  profileId: string;
  model: string;
  effort?: ChatEffort;
  permissionMode: string;
  settingsRevision: number;
  messageCount: number;
  updatedAtMs: number;
  localOnly?: boolean;
  running: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  timestamp: number;
  blocks?: Array<{ kind: "text" | "thinking" | "tool" | "error"; text: string; label?: string }>;
}

export interface ChatApproval {
  id: string;
  tool: string;
  summary: string;
  input: unknown;
}

export interface ChatQuestion {
  id: string;
  prompt: string;
  options: string[];
  recommended?: string[];
  /** Native run identity, when the question crossed the durable ask-user bridge. */
  runId?: string;
  /** Native request revision. Older cores omit this and default to one. */
  revision?: number;
  /** The native broker currently supports free text for every question. */
  allowFreeText?: boolean;
}

export interface ChatController {
  sessions: ChatSession[];
  activeId: string;
  activeSession: ChatSession;
  messages: ChatMessage[];
  status: ChatStatus;
  error: string | null;
  draft: string;
  setDraft: (value: string) => void;
  selectSession: (id: string) => void;
  createSession: (cwd?: string) => Promise<ChatSession>;
  renameSession: (title: string) => Promise<void>;
  updateSettings: (input: { profileId?: string; model?: string; effort?: ChatEffort; permissionMode?: string }) => Promise<void>;
  send: () => Promise<void>;
  steer: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  approve: (id: string, decision: "allow_once" | "allow_always" | "deny") => Promise<void>;
  answerQuestion: (id: string, answer: string | null) => Promise<void>;
  approvals: ChatApproval[];
  questions: ChatQuestion[];
  refresh: () => Promise<void>;
  native: boolean;
}

interface NativeSessionSummary {
  id: string;
  title: string;
  cwd: string;
  /** Durable native scope. Older cores omit this and fall back to cwd. */
  scope?: "projectless" | "project" | "non-project";
  profileId: string;
  model: string;
  reasoningEffort?: string | null;
  permissionMode?: string;
  settingsRevision?: number;
  messageCount?: number;
  updatedAtMs?: number;
  running?: boolean;
}

interface NativeMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string; name?: string; input?: unknown; content?: unknown }>;
}

interface AgentEventPayload {
  sessionId?: string;
  event?: Record<string, unknown>;
  sequence?: number;
}

interface SessionUpdateInput {
  title?: string;
  profileId?: string;
  model?: string;
  effort?: ChatEffort;
  permissionMode?: string;
}

/**
 * Rejects replayed and stale native events before they reach React state.
 *
 * The durable harness journal supplies a per-session sequence. A renderer can
 * reconnect after a dropped event, so the gate is deliberately monotonic and
 * does not assume that delivery order equals journal order. Run IDs provide a
 * second fence for older cores that do not include a sequence on every event.
 */
export class ChatEventGate {
  private readonly lastSequence = new Map<string, number>();
  private readonly runIds = new Map<string, string>();
  /** A terminal fence prevents late same-run events from mutating the transcript. */
  private readonly terminalRuns = new Map<string, string | null>();
  /** Replaced/terminal identities cannot later masquerade as a fresh run. */
  private readonly retiredRuns = new Map<string, Set<string>>();

  accept(payload: AgentEventPayload): boolean {
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    const event = payload.event;
    if (!sessionId || !event) return false;

    const sequence = payload.sequence;
    if (sequence !== undefined) {
      if (!Number.isSafeInteger(sequence) || sequence < 0) return false;
      const prior = this.lastSequence.get(sessionId);
      if (prior !== undefined && sequence <= prior) return false;
    }

    const type = typeof event.type === "string" ? event.type : "";
    const eventRunId = readRunId(event);
    const currentRunId = this.runIds.get(sessionId);
    const terminalRun = this.terminalRuns.get(sessionId);
    if (type === "run_started") {
      // Only an explicit, fresh run identity can open a terminal session.
      // A late turn_started is part of the old run and never clears its fence.
      if (terminalRun !== undefined && (!eventRunId || eventRunId === terminalRun)) return false;
      if (eventRunId && this.retiredRuns.get(sessionId)?.has(eventRunId)) return false;
      if (eventRunId && currentRunId && eventRunId !== currentRunId) {
        const retired = this.retiredRuns.get(sessionId) ?? new Set<string>();
        retired.add(currentRunId);
        this.retiredRuns.set(sessionId, retired);
      }
      if (eventRunId) this.runIds.set(sessionId, eventRunId);
      this.terminalRuns.delete(sessionId);
      if (sequence !== undefined) this.lastSequence.set(sessionId, sequence);
      return true;
    }

    if (eventRunId && currentRunId && eventRunId !== currentRunId) return false;
    if (terminalRun !== undefined) return false;
    if (type === "turn_started" && eventRunId && !currentRunId) this.runIds.set(sessionId, eventRunId);
    if (["run_completed", "run_finished", "cancelled", "error"].includes(type)) {
      const terminalId = eventRunId ?? currentRunId;
      this.terminalRuns.set(sessionId, terminalId ?? null);
      if (terminalId) {
        const retired = this.retiredRuns.get(sessionId) ?? new Set<string>();
        retired.add(terminalId);
        this.retiredRuns.set(sessionId, retired);
      }
    }
    if (sequence !== undefined) this.lastSequence.set(sessionId, sequence);
    return true;
  }

  reset(sessionId?: string): void {
    if (sessionId) {
      this.lastSequence.delete(sessionId);
      this.runIds.delete(sessionId);
      this.terminalRuns.delete(sessionId);
      this.retiredRuns.delete(sessionId);
      return;
    }
    this.lastSequence.clear();
    this.runIds.clear();
    this.terminalRuns.clear();
    this.retiredRuns.clear();
  }
}

const STORAGE_KEY = "omnia.rebuild.chat.v1";
const LOCAL_SESSION_PREFIX = "rebuild-nonproject-";

interface StoredSessionMetadata {
  id: string;
  title: string;
  scope: "non-project" | "project";
  model: string;
  effort?: ChatEffort;
  settingsRevision: number;
}

function localSession(seed: Partial<StoredSessionMetadata> = {}): ChatSession {
  const now = Date.now();
  return {
    id: typeof seed.id === "string" && seed.id.startsWith(LOCAL_SESSION_PREFIX) ? seed.id : `${LOCAL_SESSION_PREFIX}${crypto.randomUUID()}`,
    title: typeof seed.title === "string" && seed.title.trim() ? seed.title : "New conversation",
    scope: seed.scope === "project" ? "project" : "non-project",
    profileId: "unconfigured",
    model: seed.model ?? "unconfigured",
    ...(seed.effort ? { effort: normalizeEffort(seed.effort) } : {}),
    permissionMode: "ask_writes",
    settingsRevision: Number.isSafeInteger(seed.settingsRevision) && (seed.settingsRevision ?? 0) > 0 ? seed.settingsRevision! : 1,
    messageCount: 0,
    updatedAtMs: now,
    localOnly: true,
    running: false,
  };
}

function mapSession(item: NativeSessionSummary): ChatSession {
  const scope: ChatScope = item.scope === "projectless" || item.scope === "non-project"
    ? "non-project"
    : item.scope === "project"
      ? "project"
      : item.cwd
        ? "project"
        : "non-project";
  return {
    id: item.id,
    title: item.title.trim() || "Untitled conversation",
    scope,
    ...(scope === "project" && item.cwd ? { cwd: item.cwd } : {}),
    profileId: item.profileId,
    model: item.model,
    ...(item.reasoningEffort ? { effort: normalizeEffort(item.reasoningEffort) } : {}),
    permissionMode: item.permissionMode ?? "ask_writes",
    settingsRevision: item.settingsRevision ?? 1,
    messageCount: item.messageCount ?? 0,
    updatedAtMs: item.updatedAtMs ?? 0,
    running: item.running ?? false,
  };
}

function normalizeEffort(value: string): ChatEffort {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value)
    ? (value as ChatEffort)
    : "medium";
}

function readStoredState(): { activeId?: string; drafts?: Record<string, string>; sessions?: StoredSessionMetadata[] } {
  try {
    const storage = typeof window !== "undefined" ? window.localStorage : undefined;
    const value: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object") return {};
    const record = value as Record<string, unknown>;
    if (record.version !== undefined && record.version !== 1 && record.version !== 2) return {};
    const drafts = record.drafts;
    const result: { activeId?: string; drafts?: Record<string, string>; sessions?: StoredSessionMetadata[] } = {};
    if (typeof record.activeId === "string" && record.activeId.length <= 200) result.activeId = record.activeId;
    if (drafts && typeof drafts === "object" && !Array.isArray(drafts)) {
      const validDrafts: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [id, draft] of Object.entries(drafts)) {
        if (id.length <= 200 && typeof draft === "string") validDrafts[id] = draft;
      }
      result.drafts = validDrafts;
    }
    const storedSessions = record.version === 2 ? record.localSessions : undefined;
    if (Array.isArray(storedSessions)) {
      const seenSessionIds = new Set<string>();
      const sessions = storedSessions.filter((item): item is StoredSessionMetadata => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as Partial<StoredSessionMetadata>;
        const valid = typeof candidate.id === "string" && candidate.id.length <= 200 && candidate.id.startsWith(LOCAL_SESSION_PREFIX)
          && typeof candidate.title === "string" && candidate.title.length <= 200 && (candidate.scope === "non-project" || candidate.scope === "project")
          && typeof candidate.model === "string" && candidate.model.length <= 200
          && (candidate.effort === undefined || ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(candidate.effort))
          && typeof candidate.settingsRevision === "number"
          && Number.isSafeInteger(candidate.settingsRevision)
          && candidate.settingsRevision > 0;
        if (!valid || !candidate.id || seenSessionIds.has(candidate.id)) return false;
        seenSessionIds.add(candidate.id);
        return true;
      });
      if (sessions.length) result.sessions = sessions;
    }
    return result;
  } catch {
    return {};
  }
}

function persistState(activeId: string, drafts: Record<string, string>, sessions: ChatSession[]): void {
  try {
    const metadata: StoredSessionMetadata[] = sessions.filter((session) => session.localOnly && session.id.startsWith(LOCAL_SESSION_PREFIX)).map((session) => ({
      id: session.id, title: session.title, scope: session.scope, model: session.model,
      ...(session.effort ? { effort: session.effort } : {}), settingsRevision: session.settingsRevision,
    }));
    const storage = typeof window !== "undefined" ? window.localStorage : undefined;
    storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 2, activeId, drafts, localSessions: metadata }));
  } catch {
    // Storage can be disabled by a hardened webview; the in-memory state remains authoritative for the run.
  }
}

function messageText(message: NativeMessage): { text: string; blocks: ChatMessage["blocks"] } {
  const blocks: NonNullable<ChatMessage["blocks"]> = [];
  for (const block of message.content ?? []) {
    const type = block.type ?? "text";
    if (type === "text" && typeof block.text === "string") blocks.push({ kind: "text", text: block.text });
    else if (type === "thinking" && typeof block.text === "string") blocks.push({ kind: "thinking", text: block.text, label: "Reasoning summary" });
    else if (type === "tool_use") blocks.push({ kind: "tool", text: safeJson(block.input), label: block.name ?? "Tool call" });
    else if (type === "tool_result") blocks.push({ kind: "tool", text: safeJson(block.content), label: "Tool result" });
  }
  return { text: blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n") || blocks.map((block) => block.text).join("\n"), blocks };
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "[unserializable tool payload]";
  }
}

function mapMessages(messages: NativeMessage[]): ChatMessage[] {
  return messages.map((message, index) => {
    const mapped = messageText(message);
    const mappedMessage: ChatMessage = {
      id: `native-${index}`,
      role: message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "system",
      text: mapped.text,
      timestamp: 0,
    };
    if (mapped.blocks) mappedMessage.blocks = mapped.blocks;
    return mappedMessage;
  });
}

function eventText(event: Record<string, unknown>): string | null {
  const stream = event.event;
  if (stream && typeof stream === "object") {
    const inner = stream as Record<string, unknown>;
    if (inner.type === "text_delta" && typeof inner.text === "string") return inner.text;
    if (inner.type === "thinking_delta" && typeof inner.text === "string") return inner.text;
  }
  if (event.type === "tool_progress" && typeof event.chunk === "string") return event.chunk;
  if (event.type === "hook_message" && typeof event.message === "string") return event.message;
  return null;
}

function readRunId(event: Record<string, unknown>): string | undefined {
  const direct = event.runId ?? event.run_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  for (const key of ["request", "question", "approval"]) {
    const value = event[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      const id = nested.runId ?? nested.run_id;
      if (typeof id === "string" && id.trim()) return id.trim();
    }
  }
  return undefined;
}

export function useChatWorkspace(): ChatController {
  const stored = useMemo(readStoredState, []);
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    if (stored.sessions?.length) return stored.sessions.map((session) => localSession(session));
    // Version one stored a selected preview ID plus its draft without the
    // session metadata. Preserve that identity when migrating its local draft.
    const legacyLocalId = stored.activeId?.startsWith(LOCAL_SESSION_PREFIX) ? stored.activeId : undefined;
    return [localSession(legacyLocalId ? { id: legacyLocalId } : {})];
  });
  const [activeId, setActiveId] = useState(() => {
    if (!isDesktopRuntime()) return sessions.find((session) => session.id === stored.activeId)?.id ?? sessions[0]?.id ?? "";
    if (stored.sessions?.length) {
      const restored = stored.sessions.find((session) => session.id === stored.activeId);
      return restored?.id ?? stored.sessions[0]?.id ?? "";
    }
    return stored.activeId ?? "";
  });
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>(stored.drafts ?? {});
  const [status, setStatus] = useState<ChatStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<Record<string, ChatApproval[]>>({});
  const [questions, setQuestions] = useState<Record<string, ChatQuestion[]>>({});
  const [native, setNative] = useState(isDesktopRuntime());
  const unlisten = useRef<UnlistenFn | null>(null);
  const subscriptionReady = useRef<Promise<void> | null>(null);
  const lifecycleRevision = useRef(0);
  const membershipRevision = useRef(0);
  const disposedRef = useRef(false);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const eventGate = useRef(new ChatEventGate());
  const eventRevisions = useRef(new Map<string, number>());
  const readRevisions = useRef(new Map<string, number>());
  /** Mixed rename/model/effort writes share one native CAS queue per session. */
  const sessionUpdateQueues = useRef(new Map<string, Promise<void>>());
  const sessionUpdateErrors = useRef(new Map<string, { message: string }>());
  const sessionsRef = useRef(sessions);
  const activeIdRef = useRef(activeId);
  sessionsRef.current = sessions;
  activeIdRef.current = activeId;

  const applyEvent = useCallback((payload: AgentEventPayload) => {
    const sessionId = payload.sessionId;
    const event = payload.event;
    if (!sessionId || !event || !eventGate.current.accept(payload)) return;
    eventRevisions.current.set(sessionId, (eventRevisions.current.get(sessionId) ?? 0) + 1);
    const type = typeof event.type === "string" ? event.type : "";
    const text = eventText(event);
    if (text) {
      setMessagesBySession((current) => {
        const prior = current[sessionId] ?? [];
        const last = prior[prior.length - 1];
        if (last?.role === "assistant" && last.id === `stream-${sessionId}`) {
          return { ...current, [sessionId]: [...prior.slice(0, -1), { ...last, text: `${last.text}${text}` }] };
        }
        return { ...current, [sessionId]: [...prior, { id: `stream-${sessionId}`, role: "assistant", text, timestamp: Date.now() }] };
      });
    }
    if (type === "approval_requested") {
      const request = (event.request ?? {}) as Record<string, unknown>;
      const id = typeof request.toolUseId === "string" ? request.toolUseId : `approval-${Date.now()}`;
      setApprovals((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []).filter((item) => item.id !== id), { id, tool: String(request.tool ?? "tool"), summary: String(request.summary ?? "Approval requested"), input: request.input }] }));
    }
    if (type === "approval_decided") setApprovals((current) => ({ ...current, [sessionId]: (current[sessionId] ?? []).filter((item) => item.id !== event.id) }));
    if (type === "ask_user" || type === "request_user_input") {
      const prompt = typeof event.prompt === "string" ? event.prompt : typeof event.question === "string" ? event.question : "The agent needs your input";
      const options = Array.isArray(event.options) ? event.options.filter((option): option is string => typeof option === "string") : [];
      const recommended = Array.isArray(event.recommended)
        ? event.recommended.filter((option): option is string => typeof option === "string")
        : undefined;
      const id = String(event.id ?? event.requestId ?? `question-${Date.now()}`);
      const runId = readRunId(event);
      const revision = typeof event.revision === "number" && Number.isSafeInteger(event.revision) && event.revision > 0 ? event.revision : 1;
      setQuestions((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []).filter((item) => item.id !== id), { id, prompt, options, allowFreeText: event.allowFreeText !== false, revision, ...(runId ? { runId } : {}), ...(recommended?.length ? { recommended } : {}) }] }));
    }
    if (type === "ask_user_resolved" || type === "request_user_input_resolved" || type === "question_answered") {
      const id = typeof event.id === "string" ? event.id : typeof event.requestId === "string" ? event.requestId : "";
      if (id) setQuestions((current) => ({ ...current, [sessionId]: (current[sessionId] ?? []).filter((item) => item.id !== id) }));
    }
    if (type === "run_started" || type === "turn_started") {
      setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, running: true } : session));
      setStatus("running");
    }
    if (["run_completed", "error", "cancelled", "run_finished"].includes(type)) {
      setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, running: false, updatedAtMs: Date.now() } : session));
      setQuestions((current) => ({ ...current, [sessionId]: [] }));
      setStatus(type === "error" ? "error" : "ready");
    }
  }, []);

  const readSession = useCallback(async (sessionId: string) => {
    const lifecycle = lifecycleRevision.current;
    const readRevision = (readRevisions.current.get(sessionId) ?? 0) + 1;
    readRevisions.current.set(sessionId, readRevision);
    const eventRevision = eventRevisions.current.get(sessionId) ?? 0;
    const detail = await invokeCore<{ messages: NativeMessage[] }>("agent_session_read", { request: { sessionId } });
    if (disposedRef.current || lifecycleRevision.current !== lifecycle || readRevisions.current.get(sessionId) !== readRevision) return;
    // A late snapshot cannot erase output already received from the live run.
    // The next explicit refresh reconciles history after that run settles.
    if ((eventRevisions.current.get(sessionId) ?? 0) !== eventRevision) return;
    setMessagesBySession((current) => ({ ...current, [sessionId]: mapMessages(detail.messages ?? []) }));
  }, []);

  const ensureSubscription = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    if (subscriptionReady.current) return subscriptionReady.current;
    const subscriptionRevision = lifecycleRevision.current;
    const subscription = listen<AgentEventPayload>("omnia-agent", ({ payload }) => {
      if (!disposedRef.current && lifecycleRevision.current === subscriptionRevision) applyEvent(payload);
    });
    const ready = subscription.then((cleanup) => {
      if (disposedRef.current || lifecycleRevision.current !== subscriptionRevision) cleanup();
      else unlisten.current = cleanup;
    });
    subscriptionReady.current = ready;
    try {
      await ready;
    } catch (cause) {
      // A failed subscription is retryable. Do not leave a rejected promise
      // permanently poisoning refresh/createSession.
      if (subscriptionReady.current === ready) subscriptionReady.current = null;
      throw cause;
    }
  }, [applyEvent]);

  const refresh = useCallback((): Promise<void> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const revision = lifecycleRevision.current;
    const membership = membershipRevision.current;
    const updateErrorsAtStart = new Map(sessionUpdateErrors.current);
    const current = () => !disposedRef.current && lifecycleRevision.current === revision && membershipRevision.current === membership;
    const request = (async () => {
      if (!isDesktopRuntime()) {
        if (!current()) return;
        setNative(false);
        setSessions((current) => current.length ? current : [localSession()]);
        setStatus("ready");
        return;
      }
      try {
        await ensureSubscription();
        if (!current()) return;
        const runtime = await desktop.runtimeInfo();
        await desktop.initializeCore(runtime.appVersion);
        if (!current()) return;
        const list = await invokeCore<NativeSessionSummary[]>("agent_session_list");
        if (!current()) return;
        let mapped = list.map(mapSession);
        const hasActiveSession = mapped.some((session) => session.id === activeIdRef.current);
        if (!hasActiveSession && !mapped.some((session) => session.scope === "non-project")) {
          // Chat is a unified surface: an empty desktop starts with a durable
          // projectless native session. The native core owns its private scratch
          // root; the renderer deliberately sends no user folder.
          const created = await invokeCore<NativeSessionSummary>("agent_session_create", {
            request: {
              cwd: "",
              profileId: "default",
              model: "default",
              title: "New conversation",
              reasoningEffort: "medium",
            },
          });
          mapped = [mapSession(created), ...mapped];
        }
        if (!current()) return;
        setSessions((current) => mapped.map((session) => {
          const applied = current.find((item) => item.id === session.id);
          // A list captured before an accepted settings write cannot roll the
          // applied settings back after that write resolves.
          return applied && applied.settingsRevision > session.settingsRevision
            ? { ...applied, running: session.running, messageCount: Math.max(applied.messageCount, session.messageCount), updatedAtMs: Math.max(applied.updatedAtMs, session.updatedAtMs) }
            : session;
        }));
        const defaultSession = mapped.find((session) => session.scope === "non-project") ?? mapped[0];
        const selected = mapped.find((session) => session.id === activeIdRef.current) ?? defaultSession;
        const selectedId = selected?.id ?? "";
        activeIdRef.current = selectedId;
        setActiveId(selectedId);
        setNative(true);
        if (selectedId) await readSession(selectedId);
        if (!current()) return;
        for (const session of mapped) {
          const capturedError = updateErrorsAtStart.get(session.id);
          if (capturedError && sessionUpdateErrors.current.get(session.id) === capturedError) sessionUpdateErrors.current.delete(session.id);
        }
        setStatus(selected?.running ? "running" : "ready");
        setError(sessionUpdateErrors.current.get(activeIdRef.current)?.message ?? null);
      } catch (cause) {
        if (!current()) return;
        setNative(true);
        // Retain existing sessions/drafts on transport failure. The disconnected
        // state blocks dispatch until a refresh succeeds.
        setStatus("disconnected");
        setError(cause instanceof Error ? cause.message : "Omnia Core is unavailable; native projectless chat could not be created.");
      }
    })();
    refreshInFlight.current = request;
    void request.finally(() => {
      if (refreshInFlight.current === request) refreshInFlight.current = null;
    });
    return request;
  }, [ensureSubscription, readSession]);

  useEffect(() => {
    let disposed = false;
    disposedRef.current = false;
    lifecycleRevision.current += 1;
    const setup = async () => {
      // Subscribe before discovery/dispatch so a fast native run cannot emit
      // before the renderer has installed its event gate.
      if (isDesktopRuntime()) {
        await ensureSubscription();
      }
      if (!disposed) await refresh();
    };
    void setup().catch((cause: unknown) => {
      if (disposed) return;
      setNative(isDesktopRuntime());
      setStatus(isDesktopRuntime() ? "disconnected" : "ready");
      setError(cause instanceof Error ? cause.message : "Omnia runtime setup failed");
    });
    return () => {
      disposed = true;
      disposedRef.current = true;
      lifecycleRevision.current += 1;
      refreshInFlight.current = null;
      subscriptionReady.current = null;
      unlisten.current?.();
      unlisten.current = null;
    };
  }, [ensureSubscription, refresh]);

  useEffect(() => {
    if (!activeId && sessions[0]) setActiveId(sessions[0].id);
    persistState(activeId || sessions[0]?.id || "", drafts, sessions);
  }, [activeId, drafts, sessions]);

  const activeSession = sessions.find((session) => session.id === activeId) ?? sessions[0] ?? localSession();
  const selectSession = useCallback((id: string) => {
    if (sessionsRef.current.some((session) => session.id === id)) {
      activeIdRef.current = id;
      setActiveId(id);
      setError(sessionUpdateErrors.current.get(id)?.message ?? null);
      if (isDesktopRuntime() && !id.startsWith(LOCAL_SESSION_PREFIX)) {
        void readSession(id).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not read this session"));
      }
    }
  }, [readSession]);

  const createSession = useCallback(async (cwd?: string): Promise<ChatSession> => {
    if (!isDesktopRuntime()) {
      const created = localSession();
      setSessions((current) => [created, ...current]);
      setActiveId(created.id);
      setDrafts((current) => ({ ...current, [created.id]: "" }));
      setStatus("ready");
      setError(null);
      return created;
    }
    try {
      await ensureSubscription();
      const projectless = !cwd?.trim();
      const created = await invokeCore<NativeSessionSummary>("agent_session_create", { request: { cwd: cwd?.trim() ?? "", profileId: "default", model: "default", title: projectless ? "New conversation" : "New project conversation", reasoningEffort: "medium" } });
      const mapped = mapSession(created);
      membershipRevision.current += 1;
      setSessions((current) => [mapped, ...current.filter((session) => !session.localOnly)]);
      activeIdRef.current = mapped.id;
      setActiveId(mapped.id);
      setError(null);
      setStatus("ready");
      return mapped;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not create the native session";
      setError(message);
      setStatus("error");
      throw new Error(message);
    }
  }, [ensureSubscription]);

  const updateSession = useCallback((input: SessionUpdateInput): Promise<void> => {
    const sessionId = activeId;
    const lifecycle = lifecycleRevision.current;
    const isCurrent = () => !disposedRef.current && lifecycleRevision.current === lifecycle;
    const write = async () => {
      if (!isCurrent()) return;
      const prior = sessionsRef.current.find((session) => session.id === sessionId);
      if (!prior) return;
      const mergeApplied = (accepted: ChatSession, current: ChatSession[]) => current.map((session) => {
        if (session.id !== sessionId || session.settingsRevision >= accepted.settingsRevision) return session;
        return { ...accepted, running: session.running, messageCount: Math.max(session.messageCount, accepted.messageCount), updatedAtMs: Math.max(session.updatedAtMs, accepted.updatedAtMs) };
      });
      try {
        let accepted: ChatSession;
        if (prior.localOnly) {
          accepted = { ...prior, ...input, settingsRevision: prior.settingsRevision + 1 };
        } else {
          if (!isDesktopRuntime()) throw new Error("Native session settings require the connected Omnia Core.");
          const reply = await invokeCore<NativeSessionSummary>("agent_session_update", { request: {
            sessionId,
            expectedSettingsRevision: prior.settingsRevision,
            ...(input.title ? { title: input.title } : {}),
            ...(input.profileId ? { profileId: input.profileId } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.effort ? { reasoningEffort: input.effort } : {}),
            ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
          } });
          if (!isCurrent()) return;
          if (!reply || reply.id !== sessionId || !Number.isSafeInteger(reply.settingsRevision) || reply.settingsRevision !== prior.settingsRevision + 1) {
            throw new Error("The native session update reply has an invalid identity or settings revision. Refresh the session before retrying.");
          }
          accepted = mapSession(reply);
        }
        if (!isCurrent()) return;
        // The ref is updated synchronously as well: a queued write in the same
        // React batch must use the newly accepted native revision, not a stale
        // render closure. Functional state merge preserves concurrent run data.
        sessionsRef.current = mergeApplied(accepted, sessionsRef.current);
        setSessions((current) => mergeApplied(accepted, current));
        sessionUpdateErrors.current.delete(sessionId);
        if (activeIdRef.current === sessionId) setError(null);
      } catch (cause) {
        // Native rejection or unknown acceptance never appears as applied and
        // is never blindly retried. A later explicit refresh reconciles it.
        if (!isCurrent()) return;
        const message = cause instanceof Error ? cause.message : cause && typeof cause === "object" && "message" in cause ? String(cause.message) : "The native session update was not confirmed. Refresh the session before retrying.";
        sessionUpdateErrors.current.set(sessionId, { message });
        if (activeIdRef.current === sessionId) setError(message);
      }
    };
    const previous = sessionUpdateQueues.current.get(sessionId) ?? Promise.resolve();
    const pending = previous.then(write, write);
    sessionUpdateQueues.current.set(sessionId, pending);
    void pending.then(() => {
      if (sessionUpdateQueues.current.get(sessionId) === pending) sessionUpdateQueues.current.delete(sessionId);
    });
    return pending;
  }, [activeId]);

  const renameSession = useCallback(async (title: string) => {
    const clean = title.trim().slice(0, 200);
    if (clean) await updateSession({ title: clean });
  }, [updateSession]);

  const updateSettings = useCallback(async (input: { profileId?: string; model?: string; effort?: ChatEffort; permissionMode?: string }) => {
    const patch = {
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    };
    if (Object.keys(patch).length) await updateSession(patch);
  }, [updateSession]);

  const send = useCallback(async () => {
    const text = (drafts[activeId] ?? "").trim();
    if (!text) return;
    if (!isDesktopRuntime()) {
      setMessagesBySession((current) => ({ ...current, [activeId]: [...(current[activeId] ?? []), { id: `local-${Date.now()}`, role: "user", text, timestamp: Date.now() }] }));
      setDrafts((current) => ({ ...current, [activeId]: "" }));
      setError("Browser preview is disconnected; no assistant reply was fabricated.");
      return;
    }
    if (activeSession.localOnly || status === "disconnected" || status === "loading") {
      // Native failures are terminal for this attempt. Preserve the draft and
      // avoid appending a user message that could look like a sent request.
      setError(error ?? (status === "loading" ? "Native conversation history is still loading; your prompt has been kept." : "Omnia Core is unavailable; native projectless chat could not be created."));
      return;
    }
    setMessagesBySession((current) => ({ ...current, [activeId]: [...(current[activeId] ?? []), { id: `user-${Date.now()}`, role: "user", text, timestamp: Date.now() }] }));
    setDrafts((current) => ({ ...current, [activeId]: "" }));
    setStatus("running");
    setSessions((current) => current.map((session) => session.id === activeId ? { ...session, running: true } : session));
    try {
      await invokeCore("agent_send", { request: { sessionId: activeId, text, images: [] } });
    } catch (cause) {
      setStatus("error");
      setSessions((current) => current.map((session) => session.id === activeId ? { ...session, running: false } : session));
      setError(cause instanceof Error ? cause.message : "The agent request could not be started");
    }
  }, [activeId, activeSession.localOnly, drafts, error, status]);

  const steer = useCallback(async (text: string) => {
    if (!text.trim() || activeSession.localOnly || !isDesktopRuntime()) return;
    await invokeCore("agent_steer", { request: { sessionId: activeId, text } });
  }, [activeId, activeSession.localOnly]);
  const interrupt = useCallback(async () => {
    if (activeSession.localOnly || !isDesktopRuntime()) return;
    await invokeCore("agent_interrupt", { request: { sessionId: activeId } });
  }, [activeId, activeSession.localOnly]);
  const approve = useCallback(async (id: string, decision: "allow_once" | "allow_always" | "deny") => {
    if (activeSession.localOnly || !isDesktopRuntime()) return;
    await invokeCore("agent_approval_decide", { request: { sessionId: activeId, toolUseId: id, decision: decision === "deny" ? { type: "deny", feedback: null } : { type: decision } } });
    setApprovals((current) => ({ ...current, [activeId]: (current[activeId] ?? []).filter((item) => item.id !== id) }));
  }, [activeId, activeSession.localOnly]);

  const answerQuestion = useCallback(async (id: string, answer: string | null) => {
    const clean = answer?.trim() ?? "";
    if (!clean && answer !== null) return;
    const question = questions[activeId]?.find((item) => item.id === id);
    if (answer !== null && question?.allowFreeText === false && !question.options.includes(clean)) {
      setError("Free-text answers are disabled for this question. Choose one of the provided options or cancel.");
      return;
    }
    if (activeSession.localOnly || !isDesktopRuntime()) {
      setError("Ask-user answers require the connected Omnia Core; this preview cannot submit them.");
      return;
    }
    try {
      // The native command is intentionally capability-gated. Older cores do not
      // expose it; retaining the question on failure makes the missing capability
      // visible instead of silently claiming that an answer was accepted.
      await invokeCore("agent_user_input", { request: { sessionId: activeId, requestId: id, ...(question?.runId ? { runId: question.runId } : {}), answer: answer === null ? null : clean } });
      setQuestions((current) => ({ ...current, [activeId]: (current[activeId] ?? []).filter((item) => item.id !== id) }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The connected core does not support ask-user answers yet.");
    }
  }, [activeId, activeSession.localOnly, questions]);

  return {
    sessions,
    activeId,
    activeSession,
    messages: messagesBySession[activeId] ?? [],
    status,
    error,
    draft: drafts[activeId] ?? "",
    setDraft: (value) => setDrafts((current) => ({ ...current, [activeId]: value })),
    selectSession,
    createSession,
    renameSession,
    updateSettings,
    send,
    steer,
    interrupt,
    approve,
    answerQuestion,
    approvals: approvals[activeId] ?? [],
    questions: questions[activeId] ?? [],
    refresh,
    native,
  };
}
