import {
  appendChatMessage,
  createChatSession,
  deserializeChatSession,
  renameChatSession,
  setChatStatus,
  type ChatSession,
  type ChatStatus,
  type CreateChatSessionInput,
  type NewChatMessage,
} from './omnia-chat-runtime';

/**
 * Renderer-safe storage for the lightweight chat runtime model.
 *
 * This store intentionally owns only session state. Provider execution,
 * streaming transport, and durable/native persistence remain separate
 * boundaries, so callers can use the same contract in a browser preview or
 * behind a Tauri adapter later.
 */
export type ChatStoreSnapshot = {
  readonly version: 1;
  readonly activeSessionId: string | null;
  readonly sessions: readonly ChatSession[];
};

export type ChatStoreHistory = {
  readonly past: readonly ChatStoreSnapshot[];
  readonly present: ChatStoreSnapshot;
  readonly future: readonly ChatStoreSnapshot[];
  readonly historyLimit: number;
};

export type CreateChatStoreInput = {
  readonly sessions?: readonly ChatSession[];
  readonly activeSessionId?: string | null;
  readonly historyLimit?: number;
};

export type CreateStoredChatSessionInput = CreateChatSessionInput & {
  /** Select the new session after creating it. Defaults to true. */
  readonly activate?: boolean;
};

export type ChatSessionListOptions = {
  readonly query?: string;
  readonly status?: ChatStatus;
  readonly includeArchived?: boolean;
};

const SNAPSHOT_VERSION = 1 as const;
const DEFAULT_HISTORY_LIMIT = 100;

function normalizeHistoryLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_LIMIT;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Chat store history limit must be a non-negative finite number.');
  }
  return Math.floor(value);
}

function copySession(session: ChatSession): ChatSession {
  return {
    version: 1,
    id: session.id,
    title: session.title,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      metadata: { ...message.metadata },
    })),
    metadata: { ...session.metadata },
  };
}

function snapshotFromParts(
  sessions: readonly ChatSession[],
  activeSessionId: string | null,
): ChatStoreSnapshot {
  const copiedSessions = sessions.map(copySession);
  const ids = new Set<string>();
  for (const session of copiedSessions) {
    if (!session.id.trim()) throw new Error('Chat session id cannot be blank.');
    if (ids.has(session.id)) throw new Error(`Duplicate chat session id: ${session.id}`);
    ids.add(session.id);
  }
  if (activeSessionId !== null && !ids.has(activeSessionId)) {
    throw new Error(`Active chat session was not found: ${activeSessionId}`);
  }
  return {
    version: SNAPSHOT_VERSION,
    activeSessionId,
    sessions: copiedSessions,
  };
}

function normalizeSnapshot(snapshot: ChatStoreSnapshot): ChatStoreSnapshot {
  if (snapshot.version !== SNAPSHOT_VERSION) throw new Error('Unsupported chat store snapshot version.');
  return snapshotFromParts(snapshot.sessions, snapshot.activeSessionId);
}

function snapshotsEqual(left: ChatStoreSnapshot, right: ChatStoreSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isChatStoreHistory(value: ChatStoreHistory | ChatStoreSnapshot): value is ChatStoreHistory {
  return 'present' in value;
}

function commit(state: ChatStoreHistory, next: ChatStoreSnapshot): ChatStoreHistory {
  const present = normalizeSnapshot(next);
  if (snapshotsEqual(state.present, present)) return state;
  const past = state.historyLimit === 0
    ? []
    : state.past.length >= state.historyLimit
      ? [...(state.historyLimit <= 1 ? [] : state.past.slice(-(state.historyLimit - 1))), state.present]
      : [...state.past, state.present];
  return {
    past,
    present,
    future: [],
    historyLimit: state.historyLimit,
  };
}

function withSessions(
  state: ChatStoreHistory,
  sessions: readonly ChatSession[],
  activeSessionId = state.present.activeSessionId,
): ChatStoreHistory {
  return commit(state, snapshotFromParts(sessions, activeSessionId));
}

function requireSession(snapshot: ChatStoreSnapshot, sessionId: string): ChatSession {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error(`Chat session was not found: ${sessionId}`);
  return session;
}

/** Create an empty or pre-hydrated chat store. */
export function createChatStore(input: CreateChatStoreInput = {}): ChatStoreHistory {
  const sessions = input.sessions ?? [];
  const copiedSessions = sessions.map(copySession);
  const activeSessionId = input.activeSessionId === undefined
    ? copiedSessions[0]?.id ?? null
    : input.activeSessionId;
  return {
    past: [],
    present: snapshotFromParts(copiedSessions, activeSessionId),
    future: [],
    historyLimit: normalizeHistoryLimit(input.historyLimit),
  };
}

/** Return a session by id, or undefined when the id is not present. */
export function getChatSession(state: ChatStoreHistory | ChatStoreSnapshot, sessionId: string): ChatSession | undefined {
  return isChatStoreHistory(state)
    ? state.present.sessions.find((session) => session.id === sessionId)
    : state.sessions.find((session) => session.id === sessionId);
}

/** Return the selected session, if one is selected. */
export function getActiveChatSession(state: ChatStoreHistory | ChatStoreSnapshot): ChatSession | undefined {
  const snapshot = isChatStoreHistory(state) ? state.present : state;
  return snapshot.activeSessionId === null
    ? undefined
    : snapshot.sessions.find((session) => session.id === snapshot.activeSessionId);
}

/** List sessions in insertion order, with optional lightweight filtering. */
export function listChatSessions(
  state: ChatStoreHistory | ChatStoreSnapshot,
  options: ChatSessionListOptions = {},
): readonly ChatSession[] {
  const snapshot = isChatStoreHistory(state) ? state.present : state;
  const query = options.query?.trim().toLocaleLowerCase();
  return snapshot.sessions.filter((session) => {
    if (!options.includeArchived && session.status === 'archived') return false;
    if (options.status !== undefined && session.status !== options.status) return false;
    if (query && !session.title.toLocaleLowerCase().includes(query) && !session.messages.some((message) => message.content.toLocaleLowerCase().includes(query))) return false;
    return true;
  });
}

/** Create and insert a session. The new session is selected by default. */
export function createChatSessionInStore(
  state: ChatStoreHistory,
  input: CreateStoredChatSessionInput = {},
): ChatStoreHistory {
  const { activate = true } = input;
  const session = createChatSession(input);
  if (state.present.sessions.some((candidate) => candidate.id === session.id)) {
    throw new Error(`Duplicate chat session id: ${session.id}`);
  }
  const activeSessionId = activate ? session.id : state.present.activeSessionId;
  return withSessions(state, [...state.present.sessions, session], activeSessionId);
}

/** Insert or replace a fully formed session, useful for hydration adapters. */
export function upsertChatSessionInStore(
  state: ChatStoreHistory,
  session: ChatSession,
  activate = false,
): ChatStoreHistory {
  const existingIndex = state.present.sessions.findIndex((candidate) => candidate.id === session.id);
  const sessions = existingIndex < 0
    ? [...state.present.sessions, session]
    : state.present.sessions.map((candidate, index) => index === existingIndex ? session : candidate);
  const activeSessionId = activate ? session.id : state.present.activeSessionId;
  return withSessions(state, sessions, activeSessionId);
}

/** Select a session, or pass null to clear the current selection. */
export function selectChatSessionInStore(state: ChatStoreHistory, sessionId: string | null): ChatStoreHistory {
  if (sessionId !== null) requireSession(state.present, sessionId);
  return commit(state, snapshotFromParts(state.present.sessions, sessionId));
}

/** Append a non-empty message to a session. */
export function appendMessageToChatStore(
  state: ChatStoreHistory,
  sessionId: string,
  input: NewChatMessage,
): ChatStoreHistory {
  const session = requireSession(state.present, sessionId);
  const updated = appendChatMessage(session, input);
  return updated === session
    ? state
    : withSessions(state, state.present.sessions.map((candidate) => candidate.id === sessionId ? updated : candidate));
}

/** Change a session title while preserving its existing title for blank input. */
export function renameChatSessionInStore(
  state: ChatStoreHistory,
  sessionId: string,
  title: string,
  updatedAt?: string,
): ChatStoreHistory {
  const session = requireSession(state.present, sessionId);
  const updated = updatedAt === undefined
    ? renameChatSession(session, title)
    : renameChatSession(session, title, updatedAt);
  return withSessions(state, state.present.sessions.map((candidate) => candidate.id === sessionId ? updated : candidate));
}

/** Update the runtime status of a session. */
export function setChatSessionStatusInStore(
  state: ChatStoreHistory,
  sessionId: string,
  status: ChatStatus,
  updatedAt?: string,
): ChatStoreHistory {
  const session = requireSession(state.present, sessionId);
  const updated = updatedAt === undefined
    ? setChatStatus(session, status)
    : setChatStatus(session, status, updatedAt);
  return withSessions(state, state.present.sessions.map((candidate) => candidate.id === sessionId ? updated : candidate));
}

/** Archive a session without deleting its messages. */
export function archiveChatSessionInStore(
  state: ChatStoreHistory,
  sessionId: string,
  updatedAt?: string,
): ChatStoreHistory {
  return setChatSessionStatusInStore(state, sessionId, 'archived', updatedAt);
}

/** Remove a session and select the nearest remaining session when needed. */
export function removeChatSessionInStore(state: ChatStoreHistory, sessionId: string): ChatStoreHistory {
  const index = state.present.sessions.findIndex((candidate) => candidate.id === sessionId);
  if (index < 0) throw new Error(`Chat session was not found: ${sessionId}`);
  const sessions = state.present.sessions.filter((candidate) => candidate.id !== sessionId);
  let activeSessionId = state.present.activeSessionId;
  if (activeSessionId === sessionId) {
    activeSessionId = sessions[index]?.id ?? sessions[index - 1]?.id ?? null;
  }
  return withSessions(state, sessions, activeSessionId);
}

/** Replace the current snapshot with an imported snapshot as one undoable action. */
export function importChatStoreSnapshot(state: ChatStoreHistory, snapshot: ChatStoreSnapshot): ChatStoreHistory {
  return commit(state, snapshot);
}

/** Undo the latest store-level change. */
export function undoChatStore(state: ChatStoreHistory): ChatStoreHistory {
  const previous = state.past.at(-1);
  if (!previous) return state;
  return {
    past: state.past.slice(0, -1),
    present: previous,
    future: [state.present, ...state.future],
    historyLimit: state.historyLimit,
  };
}

/** Redo the next store-level change. */
export function redoChatStore(state: ChatStoreHistory): ChatStoreHistory {
  const next = state.future[0];
  if (!next) return state;
  return {
    past: [...state.past, state.present],
    present: next,
    future: state.future.slice(1),
    historyLimit: state.historyLimit,
  };
}

/** Serialize only the durable snapshot; undo history is intentionally local. */
export function serializeChatStore(state: ChatStoreHistory | ChatStoreSnapshot): string {
  const snapshot = isChatStoreHistory(state) ? state.present : state;
  return JSON.stringify(normalizeSnapshot(snapshot), null, 2);
}

/** Validate and deserialize a store snapshot from JSON or an unknown object. */
export function deserializeChatStore(input: string | unknown): ChatStoreSnapshot {
  const value: unknown = typeof input === 'string' ? JSON.parse(input) as unknown : input;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid chat store snapshot.');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== SNAPSHOT_VERSION || (typeof record.activeSessionId !== 'string' && record.activeSessionId !== null) || !Array.isArray(record.sessions)) {
    throw new Error('Invalid chat store snapshot.');
  }
  const sessions = record.sessions.map((session) => deserializeChatSession(session));
  return snapshotFromParts(sessions, record.activeSessionId as string | null);
}

/** Construct a store from an exported snapshot. */
export function createChatStoreFromSerialized(
  input: string | unknown,
  options: Pick<CreateChatStoreInput, 'historyLimit'> = {},
): ChatStoreHistory {
  const snapshot = deserializeChatStore(input);
  return {
    past: [],
    present: snapshot,
    future: [],
    historyLimit: normalizeHistoryLimit(options.historyLimit),
  };
}

/**
 * Small imperative facade for UI adapters. All mutations still flow through
 * the pure functions above, which keeps tests and native bridges deterministic.
 */
export class OmniaChatSessionStore {
  private state: ChatStoreHistory;

  public constructor(input: CreateChatStoreInput = {}) {
    this.state = createChatStore(input);
  }

  public static fromSerialized(input: string | unknown, options: Pick<CreateChatStoreInput, 'historyLimit'> = {}): OmniaChatSessionStore {
    const store = new OmniaChatSessionStore(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit });
    store.state = createChatStoreFromSerialized(input, options);
    return store;
  }

  public getState(): ChatStoreHistory {
    return this.state;
  }

  public getSnapshot(): ChatStoreSnapshot {
    return this.state.present;
  }

  public getActiveSession(): ChatSession | undefined {
    return getActiveChatSession(this.state);
  }

  public list(options: ChatSessionListOptions = {}): readonly ChatSession[] {
    return listChatSessions(this.state, options);
  }

  public createSession(input: CreateStoredChatSessionInput = {}): ChatSession {
    const previousIds = new Set(this.state.present.sessions.map((session) => session.id));
    this.state = createChatSessionInStore(this.state, input);
    const created = this.state.present.sessions.find((session) => !previousIds.has(session.id));
    if (!created) throw new Error('Chat session creation did not add a session.');
    return created;
  }

  public select(sessionId: string | null): void {
    this.state = selectChatSessionInStore(this.state, sessionId);
  }

  public appendMessage(sessionId: string, input: NewChatMessage): void {
    this.state = appendMessageToChatStore(this.state, sessionId, input);
  }

  public rename(sessionId: string, title: string, updatedAt?: string): void {
    this.state = renameChatSessionInStore(this.state, sessionId, title, updatedAt);
  }

  public setStatus(sessionId: string, status: ChatStatus, updatedAt?: string): void {
    this.state = setChatSessionStatusInStore(this.state, sessionId, status, updatedAt);
  }

  public archive(sessionId: string, updatedAt?: string): void {
    this.state = archiveChatSessionInStore(this.state, sessionId, updatedAt);
  }

  public remove(sessionId: string): void {
    this.state = removeChatSessionInStore(this.state, sessionId);
  }

  public import(input: string | unknown): void {
    this.state = importChatStoreSnapshot(this.state, deserializeChatStore(input));
  }

  public undo(): void {
    this.state = undoChatStore(this.state);
  }

  public redo(): void {
    this.state = redoChatStore(this.state);
  }

  public serialize(): string {
    return serializeChatStore(this.state);
  }
}
