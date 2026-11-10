/**
 * Renderer-local command history for the command palette.
 *
 * This is intentionally an in-memory session projection. It is not a
 * telemetry stream, durable preference, native command journal, or provider
 * receipt. Keeping the contract here makes the palette's "recent" affordance
 * useful without implying that Omnia has persisted or executed anything.
 */

/**
 * Stable command-palette buckets shared by the session history and palette
 * result model. Keeping this union here prevents history records from
 * accepting arbitrary strings that the palette cannot render or filter.
 */
export type CommandHistoryGroup =
  | "Commands"
  | "Conversations"
  | "Messages"
  | "Projects"
  | "Files"
  | "Memory"
  | "Skills"
  | "Library"
  | "Providers"
  | "Models";

export interface CommandHistoryEntry {
  readonly id: string;
  readonly title: string;
  readonly group: CommandHistoryGroup;
  readonly invokedAt: number;
}

const MAX_COMMAND_HISTORY = 12;
let commandHistory: CommandHistoryEntry[] = [];

export function getCommandHistory(): readonly CommandHistoryEntry[] {
  return commandHistory.map((entry) => ({ ...entry }));
}

export function recordCommandInvocation(
  entry: Pick<CommandHistoryEntry, "id" | "title" | "group">,
  now = Date.now(),
): void {
  const next: CommandHistoryEntry = { ...entry, invokedAt: now };
  commandHistory = [next, ...commandHistory.filter((candidate) => candidate.id !== entry.id)]
    .slice(0, MAX_COMMAND_HISTORY);
}

export function clearCommandHistory(): void {
  commandHistory = [];
}
