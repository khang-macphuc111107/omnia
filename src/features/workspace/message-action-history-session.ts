export type MessageActionKind =
  | "copy"
  | "quote"
  | "edit"
  | "branch"
  | "continue"
  | "regenerate"
  | "read-aloud"
  | "artifact"
  | "feedback-helpful"
  | "feedback-not-helpful"
  | "excerpt"
  | "copy-link";

export interface MessageActionHistoryEntry {
  readonly id: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly action: MessageActionKind;
  readonly label: string;
  readonly occurredAt: string;
}

const MAX_MESSAGE_ACTION_HISTORY = 100;
let nextActionId = 0;
let entries: readonly MessageActionHistoryEntry[] = Object.freeze([]);
const listeners = new Set<() => void>();

function publish(next: readonly MessageActionHistoryEntry[]): void {
  entries = Object.freeze([...next]);
  for (const listener of listeners) listener();
}

export function getMessageActionHistory(): readonly MessageActionHistoryEntry[] {
  return entries;
}

export function subscribeMessageActionHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recordMessageAction(
  entry: Omit<MessageActionHistoryEntry, "id" | "occurredAt"> & { occurredAt?: string },
): MessageActionHistoryEntry {
  const recorded: MessageActionHistoryEntry = Object.freeze({
    ...entry,
    id: `message-action-${++nextActionId}`,
    occurredAt: entry.occurredAt ?? new Date().toISOString(),
  });
  publish([recorded, ...entries].slice(0, MAX_MESSAGE_ACTION_HISTORY));
  return recorded;
}

export function clearMessageActionHistory(conversationId?: string): void {
  if (conversationId) {
    publish(entries.filter((entry) => entry.conversationId !== conversationId));
  } else {
    publish([]);
  }
}

