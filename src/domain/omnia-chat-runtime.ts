export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatStatus = 'idle' | 'streaming' | 'queued' | 'error' | 'archived';

export type ChatMessage = {
  readonly id: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly createdAt: string;
  readonly metadata: Readonly<Record<string, string>>;
};

export type ChatSession = {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly status: ChatStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly ChatMessage[];
  readonly metadata: Readonly<Record<string, string>>;
};

export type CreateChatSessionInput = {
  readonly id?: string;
  readonly title?: string;
  readonly now?: string;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type NewChatMessage = {
  readonly id?: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly createdAt?: string;
  readonly metadata?: Readonly<Record<string, string>>;
};

const roles: readonly ChatRole[] = ['system', 'user', 'assistant', 'tool'];
const statuses: readonly ChatStatus[] = ['idle', 'streaming', 'queued', 'error', 'archived'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function nowIso(): string {
  return new Date().toISOString();
}

function createId(prefix: string, timestamp: string): string {
  return `${prefix}_${timestamp.replace(/[^0-9]/g, '').slice(-14)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

export function createChatSession(input: CreateChatSessionInput = {}): ChatSession {
  const timestamp = input.now ?? nowIso();
  return {
    version: 1,
    id: input.id?.trim() || createId('session', timestamp),
    title: input.title?.trim() || 'New chat',
    status: 'idle',
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
    metadata: { ...(input.metadata ?? {}) },
  };
}

export function appendChatMessage(session: ChatSession, input: NewChatMessage): ChatSession {
  const content = normalizeText(input.content);
  if (!content) return session;
  const createdAt = input.createdAt ?? nowIso();
  const id = input.id?.trim() || createId('msg', createdAt);
  if (session.messages.some((message) => message.id === id)) return session;
  const message: ChatMessage = {
    id,
    role: input.role,
    content,
    createdAt,
    metadata: { ...(input.metadata ?? {}) },
  };
  return {
    ...session,
    updatedAt: createdAt,
    messages: [...session.messages, message],
  };
}

export function setChatStatus(session: ChatSession, status: ChatStatus, updatedAt = nowIso()): ChatSession {
  return { ...session, status, updatedAt };
}

export function renameChatSession(session: ChatSession, title: string, updatedAt = nowIso()): ChatSession {
  return { ...session, title: title.trim() || session.title, updatedAt };
}

export function serializeChatSession(session: ChatSession): string {
  return JSON.stringify(session, null, 2);
}

function parseMessage(value: unknown): ChatMessage {
  if (!isRecord(value) || typeof value.id !== 'string' || !roles.includes(value.role as ChatRole) || typeof value.content !== 'string' || typeof value.createdAt !== 'string' || !isStringRecord(value.metadata)) {
    throw new Error('Invalid chat message');
  }
  return {
    id: value.id,
    role: value.role as ChatRole,
    content: normalizeText(value.content),
    createdAt: value.createdAt,
    metadata: { ...value.metadata },
  };
}

export function deserializeChatSession(input: string | unknown): ChatSession {
  const value: unknown = typeof input === 'string' ? JSON.parse(input) as unknown : input;
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || typeof value.title !== 'string' || !statuses.includes(value.status as ChatStatus) || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || !Array.isArray(value.messages) || !isStringRecord(value.metadata)) {
    throw new Error('Invalid chat session');
  }
  const messages = value.messages.map(parseMessage);
  const ids = new Set<string>();
  for (const message of messages) {
    if (ids.has(message.id)) throw new Error(`Duplicate chat message id: ${message.id}`);
    ids.add(message.id);
  }
  return {
    version: 1,
    id: value.id,
    title: value.title,
    status: value.status as ChatStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    messages,
    metadata: { ...value.metadata },
  };
}
