import { getRecentSubagentUserPrompts } from "@/domain/session-dfs-tree";

export type ComposerSlashCommandId =
  | "report"
  | "code"
  | "research"
  | "checklist"
  | "numbered"
  | "table"
  | "quote"
  | "math"
  | "prompt";

export type ComposerSlashCommandCategory =
  | "Writing"
  | "Research"
  | "Code"
  | "Structure"
  | "Prompting";

export type ComposerSlashCommandStatus = "available" | "preview" | "planned";

export type ComposerSlashCommandInsertMode =
  | "scaffold"
  | "code-block"
  | "list"
  | "table"
  | "quote"
  | "math-block";

export type ComposerSlashCommandSource = "built-in" | "session-import";

export interface ComposerSlashCommand {
  id: ComposerSlashCommandId;
  command: `/${string}`;
  label: string;
  description: string;
  keywords: readonly string[];
  aliases: readonly string[];
  category: ComposerSlashCommandCategory;
  status: ComposerSlashCommandStatus;
  insertMode: ComposerSlashCommandInsertMode;
  source: ComposerSlashCommandSource;
  capabilities: readonly string[];
  beforeCursor: string;
  afterCursor: string;
}

export interface ComposerSlashCommandSearchOptions {
  readonly category?: ComposerSlashCommandCategory;
  readonly status?: ComposerSlashCommandStatus;
  readonly source?: ComposerSlashCommandSource;
  readonly includeExtended?: boolean;
}

export type ComposerSlashRegistryFormat = "json" | "markdown";

export interface ComposerSlashCommandRegistrySnapshot {
  schema: "omnia.composer-slash-command-registry.preview.v1";
  scope: "renderer-session";
  total: number;
  categories: Record<ComposerSlashCommandCategory, number>;
  statuses: Record<ComposerSlashCommandStatus, number>;
  sources: Record<ComposerSlashCommandSource, number>;
  commands: ReadonlyArray<{
    id: ComposerSlashCommandId;
    command: `/${string}`;
    label: string;
    description: string;
    category: ComposerSlashCommandCategory;
    aliases: readonly string[];
    capabilities: readonly string[];
    status: ComposerSlashCommandStatus;
    insertMode: ComposerSlashCommandInsertMode;
    source: ComposerSlashCommandSource;
  }>;
  boundary: {
    nativeDispatch: false;
    providerRequest: false;
    durableWrite: false;
  };
}

export interface ComposerSlashContext {
  query: string;
  lineStart: number;
  slashStart: number;
  slashEnd: number;
  indent: string;
}

export interface ComposerSlashChange {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  handled: boolean;
  command: ComposerSlashCommand | null;
}

export const COMPOSER_SLASH_COMMANDS: readonly ComposerSlashCommand[] = [
  {
    id: "report",
    command: "/report",
    label: "Report scaffold",
    description: "Summary, details, and actionable next steps",
    keywords: ["document", "write", "summary", "brief"],
    aliases: ["brief", "summary", "document"],
    category: "Writing",
    status: "available",
    insertMode: "scaffold",
    source: "built-in",
    capabilities: ["markdown", "headings", "checklist"],
    beforeCursor: "## Summary\n\n",
    afterCursor: "\n\n## Details\n\n- \n\n## Next steps\n\n- [ ] ",
  },
  {
    id: "code",
    command: "/code",
    label: "Code block",
    description: "Insert an editable fenced TypeScript block",
    keywords: ["typescript", "snippet", "fence", "programming"],
    aliases: ["snippet", "fence", "ts"],
    category: "Code",
    status: "available",
    insertMode: "code-block",
    source: "built-in",
    capabilities: ["code", "markdown", "typescript"],
    beforeCursor: "```typescript\n",
    afterCursor: "\n```",
  },
  {
    id: "research",
    command: "/research",
    label: "Research note",
    description: "Question, sources, evidence, and open issues",
    keywords: ["sources", "evidence", "paper", "investigate"],
    aliases: ["sources", "evidence", "paper"],
    category: "Research",
    status: "available",
    insertMode: "scaffold",
    source: "built-in",
    capabilities: ["markdown", "evidence", "open-questions"],
    beforeCursor: "## Research question\n\n",
    afterCursor: "\n\n## Sources\n\n- \n\n## Evidence\n\n- \n\n## Open questions\n\n- ",
  },
  {
    id: "checklist",
    command: "/checklist",
    label: "Checklist",
    description: "Start a Markdown task list",
    keywords: ["todo", "task", "plan", "checkbox"],
    aliases: ["todo", "tasks", "plan"],
    category: "Structure",
    status: "available",
    insertMode: "list",
    source: "built-in",
    capabilities: ["markdown", "task-list", "planning"],
    beforeCursor: "- [ ] ",
    afterCursor: "",
  },
  {
    id: "numbered",
    command: "/numbered",
    label: "Numbered list",
    description: "Start an auto-continuing ordered list",
    keywords: ["ordered", "steps", "sequence", "list"],
    aliases: ["steps", "ordered", "sequence"],
    category: "Structure",
    status: "available",
    insertMode: "list",
    source: "built-in",
    capabilities: ["markdown", "ordered-list", "planning"],
    beforeCursor: "1. ",
    afterCursor: "",
  },
  {
    id: "table",
    command: "/table",
    label: "Markdown table",
    description: "Insert a compact two-column comparison",
    keywords: ["grid", "compare", "columns", "matrix"],
    aliases: ["compare", "grid", "matrix"],
    category: "Structure",
    status: "available",
    insertMode: "table",
    source: "built-in",
    capabilities: ["markdown", "table", "comparison"],
    beforeCursor: "| Item | Detail |\n| --- | --- |\n| ",
    afterCursor: " |  |",
  },
  {
    id: "quote",
    command: "/quote",
    label: "Quote block",
    description: "Start a Markdown block quote",
    keywords: ["citation", "blockquote", "reference"],
    aliases: ["blockquote", "citation", "reference"],
    category: "Writing",
    status: "available",
    insertMode: "quote",
    source: "built-in",
    capabilities: ["markdown", "citation", "blockquote"],
    beforeCursor: "> ",
    afterCursor: "",
  },
  {
    id: "math",
    command: "/math",
    label: "LaTeX equation",
    description: "Insert a display-math block",
    keywords: ["latex", "formula", "equation", "science"],
    aliases: ["latex", "formula", "equation"],
    category: "Research",
    status: "available",
    insertMode: "math-block",
    source: "built-in",
    capabilities: ["latex", "math", "science"],
    beforeCursor: "$$\n",
    afterCursor: "\n$$",
  },
  {
    id: "prompt",
    command: "/prompt",
    label: "Prompt brief",
    description: "Structure goal, context, constraints, and output",
    keywords: ["instruction", "goal", "context", "format"],
    aliases: ["brief", "instruction", "task"],
    category: "Prompting",
    status: "available",
    insertMode: "scaffold",
    source: "built-in",
    capabilities: ["prompting", "context", "constraints", "output-shape"],
    beforeCursor: "Goal:\n",
    afterCursor: "\n\nContext:\n\nConstraints:\n\n- \n\nOutput format:\n",
  },
];

/**
 * The slash-command registry is a renderer-local catalog. It describes what
 * the composer can insert in this session; it is not a native command
 * registration, provider tool, durable preference, or execution authority.
 */
export const COMPOSER_SLASH_COMMAND_REGISTRY: readonly ComposerSlashCommand[] =
  COMPOSER_SLASH_COMMANDS;

const REGISTRY_CATEGORIES: readonly ComposerSlashCommandCategory[] = [
  "Writing",
  "Research",
  "Code",
  "Structure",
  "Prompting",
];

const REGISTRY_STATUSES: readonly ComposerSlashCommandStatus[] = [
  "available",
  "preview",
  "planned",
];

const REGISTRY_SOURCES: readonly ComposerSlashCommandSource[] = [
  "built-in",
  "session-import",
];

function emptyRegistryCounts<T extends string>(values: readonly T[]): Record<T, number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

function normalizedSlashQuery(query: string): string {
  return query.trim().toLowerCase().replace(/^\/+/, "");
}

function slashCommandSearchText(command: ComposerSlashCommand): string {
  return [
    command.command.slice(1),
    command.label,
    command.description,
    command.category,
    command.insertMode,
    ...command.aliases,
    ...command.keywords,
    ...command.capabilities,
  ].join(" ").toLowerCase();
}

function slashCommandSearchScore(command: ComposerSlashCommand, normalized: string): number {
  if (!normalized) return 0;
  const commandName = command.command.slice(1).toLowerCase();
  const label = command.label.toLowerCase();
  const aliases = command.aliases.map((alias) => alias.toLowerCase());
  if (commandName === normalized) return 0;
  if (commandName.startsWith(normalized)) return 10 + commandName.length;
  if (aliases.some((alias) => alias === normalized)) return 20 + normalized.length;
  if (label.startsWith(normalized)) return 30 + label.length;
  if (aliases.some((alias) => alias.startsWith(normalized))) return 40 + normalized.length;
  const haystack = slashCommandSearchText(command);
  const index = haystack.indexOf(normalized);
  return index >= 0 ? 80 + index / 100 : Number.POSITIVE_INFINITY;
}

function clampPosition(value: string, position: number): number {
  return Math.max(0, Math.min(value.length, position));
}

function indentMultiline(value: string, indent: string): string {
  return indent.length === 0 ? value : value.replace(/\n/g, `\n${indent}`);
}

export function getComposerSlashContext(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): ComposerSlashContext | null {
  const start = clampPosition(value, selectionStart);
  const end = clampPosition(value, selectionEnd);
  if (start !== end) return null;

  const lineStart = value.lastIndexOf("\n", Math.max(0, start) - 1) + 1;
  const prefix = value.slice(lineStart, start);
  const match = prefix.match(/^([ \t]*)\/([a-z0-9-]*)$/i);
  if (!match) return null;

  const indent = match[1]!;
  return {
    query: match[2]!.toLowerCase(),
    lineStart,
    slashStart: lineStart + indent.length,
    slashEnd: start,
    indent,
  };
}

export type ExtendedComposerSlashCommandId =
  | ComposerSlashCommandId
  | "btw"
  | "spawn"
  | "peer"
  | "verify"
  | "enhance"
  | "schedule"
  | "compare"
  | "branch"
  | "clone";

export interface ExtendedComposerSlashCommand extends Omit<ComposerSlashCommand, "id"> {
  id: ExtendedComposerSlashCommandId;
}

export const EXTENDED_COMPOSER_SLASH_COMMANDS: readonly ExtendedComposerSlashCommand[] = [
  ...COMPOSER_SLASH_COMMANDS,
  {
    id: "btw",
    command: "/btw",
    label: "Side chat (/btw)",
    description: "Spawn a tree-indented side chat with inherited parent context",
    keywords: ["side", "subchat", "tangent", "context"],
    aliases: ["sidechat", "subchat"],
    category: "Prompting",
    status: "available",
    insertMode: "scaffold",
    source: "built-in",
    capabilities: ["side-chat", "context-inheritance"],
    beforeCursor: "/btw ",
    afterCursor: "",
  },
  {
    id: "spawn",
    command: "/spawn",
    label: "Spawn subagent swarm",
    description: "Launch recursive or k-d tree subagents with independent verification",
    keywords: ["subagent", "swarm", "parallel", "dag"],
    aliases: ["swarm", "agents"],
    category: "Prompting",
    status: "available",
    insertMode: "scaffold",
    source: "built-in",
    capabilities: ["subagents", "dfs-tree"],
    beforeCursor: "/spawn ",
    afterCursor: "",
  },
  {
    id: "peer",
    command: "/peer",
    label: "Grouped k-d tree peer discussion ({A, B}, C)",
    description: "Partition subagents into peer groups that critique each other before reporting to Main",
    keywords: ["kdtree", "group", "consensus", "critique"],
    aliases: ["kdtree", "group"],
    category: "Prompting",
    status: "available",
    insertMode: "scaffold",
    source: "built-in",
    capabilities: ["peer-review", "k-d-tree", "consensus"],
    beforeCursor: "/peer {A, B}, C — Goal: ",
    afterCursor: "\nDefinition of Done:\n- [ ] Peer critique & consensus verified",
  },
  {
    id: "verify",
    command: "/verify",
    label: "Deterministic verification",
    description: "Run numeric claim verifier, unit converter, and citation cross-check",
    keywords: ["audit", "check", "math", "citations"],
    aliases: ["audit", "factcheck"],
    category: "Research",
    status: "available",
    insertMode: "scaffold",
    source: "built-in",
    capabilities: ["verification", "math", "citations"],
    beforeCursor: "/verify ",
    afterCursor: "",
  },
  {
    id: "enhance",
    command: "/enhance",
    label: "Enhance prompt",
    description: "Expand prompt with explicit constraints, verification criteria, and anti-slop rules",
    keywords: ["improve", "refine", "optimize", "rewrite"],
    aliases: ["improve", "refine"],
    category: "Prompting",
    status: "available",
    insertMode: "scaffold",
    source: "built-in",
    capabilities: ["prompt-enhancement", "anti-slop"],
    beforeCursor: "## Objective\n",
    afterCursor: "\n\n## Verification & Definition of Done\n- Run real tests and verify edge cases\n- Zero AI slop or unverified assumptions",
  },
  {
    id: "schedule",
    command: "/schedule",
    label: "Schedule & Automation",
    description: "Configure recurring cron or one-shot scheduled task execution",
    keywords: ["cron", "timer", "automation", "recurring"],
    aliases: ["cron", "automation"],
    category: "Prompting",
    status: "available",
    insertMode: "scaffold",
    source: "built-in",
    capabilities: ["automation", "cron", "schedule"],
    beforeCursor: "/schedule [cron: 0 9 * * *] ",
    afterCursor: "",
  },
  {
    id: "compare",
    command: "/compare",
    label: "Compare models side-by-side",
    description: "Run prompt across multiple models/providers in Google AI Studio compare mode",
    keywords: ["aistudio", "arena", "side-by-side", "benchmark"],
    aliases: ["arena", "diff-models"],
    category: "Prompting",
    status: "available",
    insertMode: "scaffold",
    source: "built-in",
    capabilities: ["compare", "multi-model"],
    beforeCursor: "/compare ",
    afterCursor: "",
  },
  {
    id: "branch",
    command: "/branch",
    label: "Branch conversation",
    description: "Fork current conversation state into an independent exploration branch",
    keywords: ["fork", "split", "tree"],
    aliases: ["fork"],
    category: "Structure",
    status: "available",
    insertMode: "scaffold",
    source: "built-in",
    capabilities: ["branching"],
    beforeCursor: "/branch ",
    afterCursor: "",
  },
  {
    id: "clone",
    command: "/clone",
    label: "Clone conversation",
    description: "Duplicate conversation transcript and parameters for reproducible testing",
    keywords: ["duplicate", "copy"],
    aliases: ["duplicate"],
    category: "Structure",
    status: "available",
    insertMode: "scaffold",
    source: "built-in",
    capabilities: ["cloning"],
    beforeCursor: "/clone ",
    afterCursor: "",
  },
];

export function findExtendedComposerSlashCommands(
  query: string,
  options: ComposerSlashCommandSearchOptions = {},
): readonly ExtendedComposerSlashCommand[] {
  const normalized = normalizedSlashQuery(query);
  const filtered = EXTENDED_COMPOSER_SLASH_COMMANDS.filter((command) => {
    if (options.category && command.category !== options.category) return false;
    if (options.status && command.status !== options.status) return false;
    if (options.source && command.source !== options.source) return false;
    return normalized.length === 0 || slashCommandSearchText(command as unknown as ComposerSlashCommand).includes(normalized);
  });

  if (!normalized) return filtered;

  return filtered
    .map((command, index) => ({
      command,
      index,
      score: slashCommandSearchScore(command as unknown as ComposerSlashCommand, normalized),
    }))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ command }) => command);
}

export function findComposerSlashCommands(
  query: string,
  optionsOrIncludeExtended: ComposerSlashCommandSearchOptions | boolean = {},
): readonly ComposerSlashCommand[] {
  const options: ComposerSlashCommandSearchOptions =
    typeof optionsOrIncludeExtended === "boolean"
      ? { includeExtended: optionsOrIncludeExtended }
      : optionsOrIncludeExtended;

  if (options.includeExtended) {
    return findExtendedComposerSlashCommands(query, options) as unknown as readonly ComposerSlashCommand[];
  }

  const normalized = normalizedSlashQuery(query);
  const filtered = COMPOSER_SLASH_COMMAND_REGISTRY.filter((command) => {
    if (options.category && command.category !== options.category) return false;
    if (options.status && command.status !== options.status) return false;
    if (options.source && command.source !== options.source) return false;
    return normalized.length === 0 || slashCommandSearchText(command).includes(normalized);
  });

  if (!normalized) return filtered;

  const ranked = filtered
    .map((command, index) => ({ command, index, score: slashCommandSearchScore(command, normalized) }))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ command }) => command);

  const coreIds = new Set<string>(COMPOSER_SLASH_COMMAND_REGISTRY.map((c) => c.id));
  const prefixMatchedExtended = EXTENDED_COMPOSER_SLASH_COMMANDS.filter((command) => {
    if (coreIds.has(command.id)) return false;
    if (options.category && command.category !== options.category) return false;
    if (options.status && command.status !== options.status) return false;
    if (options.source && command.source !== options.source) return false;
    const score = slashCommandSearchScore(command as unknown as ComposerSlashCommand, normalized);
    return score <= 2;
  }) as unknown as readonly ComposerSlashCommand[];

  if (ranked.length > 0 || prefixMatchedExtended.length > 0) {
    return [...ranked, ...prefixMatchedExtended];
  }

  return findExtendedComposerSlashCommands(query, options) as unknown as readonly ComposerSlashCommand[];
}

export function getComposerSlashCommand(
  commandId: ComposerSlashCommandId,
): ComposerSlashCommand | null {
  return COMPOSER_SLASH_COMMAND_REGISTRY.find((command) => command.id === commandId) ?? null;
}

export function buildComposerSlashCommandRegistrySnapshot(
  commands: readonly ComposerSlashCommand[] = COMPOSER_SLASH_COMMAND_REGISTRY,
): ComposerSlashCommandRegistrySnapshot {
  const categories = emptyRegistryCounts(REGISTRY_CATEGORIES);
  const statuses = emptyRegistryCounts(REGISTRY_STATUSES);
  const sources = emptyRegistryCounts(REGISTRY_SOURCES);
  const entries = commands.map((command) => {
    categories[command.category] += 1;
    statuses[command.status] += 1;
    sources[command.source] += 1;
    return {
      id: command.id,
      command: command.command,
      label: command.label,
      description: command.description,
      category: command.category,
      aliases: [...command.aliases],
      capabilities: [...command.capabilities],
      status: command.status,
      insertMode: command.insertMode,
      source: command.source,
    };
  });

  return {
    schema: "omnia.composer-slash-command-registry.preview.v1",
    scope: "renderer-session",
    total: entries.length,
    categories,
    statuses,
    sources,
    commands: entries,
    boundary: {
      nativeDispatch: false,
      providerRequest: false,
      durableWrite: false,
    },
  };
}

export function serializeComposerSlashCommandRegistry(
  snapshot: ComposerSlashCommandRegistrySnapshot = buildComposerSlashCommandRegistrySnapshot(),
  format: ComposerSlashRegistryFormat = "json",
): string {
  const generatedAt = new Date().toISOString();
  if (format === "markdown") {
    const rows = snapshot.commands.length === 0
      ? ["_No slash commands are visible in this renderer session._"]
      : snapshot.commands.map((command) =>
        `- **${command.command}** — ${command.label} · ${command.category} · ${command.status} · ${command.insertMode}`,
      );
    return [
      "# Omnia slash-command registry preview",
      "",
      "> Renderer-session catalog. Native command registration, provider requests, and durable writes are not performed.",
      "",
      `- Generated: ${generatedAt}`,
      `- Commands: ${snapshot.total}`,
      `- Categories: ${Object.entries(snapshot.categories).filter(([, count]) => count > 0).map(([category, count]) => `${category} (${count})`).join(", ") || "none"}`,
      "",
      "## Commands",
      "",
      ...rows,
    ].join("\n");
  }
  return JSON.stringify({ ...snapshot, generatedAt }, null, 2);
}

export function applyComposerSlashCommand(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  commandId: ExtendedComposerSlashCommandId,
): ComposerSlashChange {
  const context = getComposerSlashContext(value, selectionStart, selectionEnd);
  const command =
    (COMPOSER_SLASH_COMMANDS.find((candidate) => candidate.id === commandId) ??
      EXTENDED_COMPOSER_SLASH_COMMANDS.find((candidate) => candidate.id === commandId) ??
      null) as ComposerSlashCommand | null;
  if (!context || !command) {
    const start = clampPosition(value, selectionStart);
    const end = clampPosition(value, selectionEnd);
    return { value, selectionStart: start, selectionEnd: end, handled: false, command };
  }

  const beforeCursor = indentMultiline(command.beforeCursor, context.indent);
  const afterCursor = indentMultiline(command.afterCursor, context.indent);
  const insertion = `${beforeCursor}${afterCursor}`;
  const nextValue = `${value.slice(0, context.slashStart)}${insertion}${value.slice(context.slashEnd)}`;
  const nextCursor = context.slashStart + beforeCursor.length;

  return {
    value: nextValue,
    selectionStart: nextCursor,
    selectionEnd: nextCursor,
    handled: true,
    command,
  };
}

export function enhancePromptDraft(draft: string): string {
  const trimmed = draft.trim();
  if (!trimmed) {
    return "Objective: Analyze the active workspace state, verify assumptions with deterministic tools, and report concrete findings with file:line citations.";
  }
  if (trimmed.includes("Verification & Definition of Done:")) {
    return trimmed;
  }
  return [
    trimmed,
    "",
    "Verification & Definition of Done:",
    "- Inspect exact file:line evidence before modifying code",
    "- Run existing and edge-case tests to verify behavior",
    "- Avoid generic boilerplate or unverified assumptions",
  ].join("\n");
}

export function computeLivePromptSuggestion(draft: string): string | null {
  const trimmed = draft.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("/peer")) {
    return "Specify k-d tree group partition e.g. {A, B}, C and Definition of Done";
  }
  if (lower.startsWith("/btw")) {
    return "Ask a focused side question without polluting the main conversation thread";
  }
  if (lower.includes("fix") || lower.includes("bug") || lower.includes("error")) {
    return " + reproduce with Vitest and verify edge cases";
  }
  if (lower.includes("refactor") || lower.includes("implement")) {
    return " + preserve public API contracts and run full test suite";
  }
  if (trimmed.length < 48) {
    return " + cite exact file:line references and verify deterministically";
  }
  return null;
}

export interface PromptHistoryRecallResult {
  readonly nextValue: string;
  readonly nextHistoryIndex: number;
  readonly savedDraft: string;
}

export function recallCrossAgentPromptHistory(options: {
  readonly history: readonly string[];
  readonly currentIndex: number;
  readonly direction: "up" | "down";
  readonly currentValue: string;
  readonly savedDraft: string;
}): PromptHistoryRecallResult | null {
  const { history, currentIndex, direction, currentValue, savedDraft } = options;
  if (history.length === 0) return null;

  if (direction === "up") {
    if (currentIndex === -1 && currentValue.trim().length > 0) {
      return null;
    }
    const nextIdx =
      currentIndex === -1 ? history.length - 1 : Math.max(0, currentIndex - 1);
    const nextSavedDraft = currentIndex === -1 ? currentValue : savedDraft;
    return {
      nextValue: history[nextIdx] ?? currentValue,
      nextHistoryIndex: nextIdx,
      savedDraft: nextSavedDraft,
    };
  }

  if (currentIndex === -1) {
    return null;
  }
  if (currentIndex >= history.length - 1) {
    return {
      nextValue: savedDraft,
      nextHistoryIndex: -1,
      savedDraft: "",
    };
  }
  const nextIdx = currentIndex + 1;
  return {
    nextValue: history[nextIdx] ?? savedDraft,
    nextHistoryIndex: nextIdx,
    savedDraft,
  };
}

/**
 * Collects user prompts across conversations, `/btw` subchats, sidebar agent turns,
 * and direct subagent chats (`sendDirectUserPromptToSubagent`) so `ArrowUp` / `ArrowDown`
 * on an empty composer recalls prompts sent to any agent in the chat tree.
 */
export function collectCrossAgentPromptHistory(
  conversations: ReadonlyArray<{
    readonly btwQuestion?: string;
    readonly messages?: ReadonlyArray<{
      readonly role: string;
      readonly content?: string;
      readonly text?: string;
    }>;
  }> = [],
  extraPrompts: readonly string[] = [],
): readonly string[] {
  const prompts: string[] = [];
  const appendPrompt = (raw: string | undefined): void => {
    const trimmed = raw?.trim();
    if (!trimmed) return;
    prompts.push(trimmed);
  };

  for (const conv of conversations) {
    if (typeof conv.btwQuestion === "string") {
      appendPrompt(conv.btwQuestion);
    }
    for (const msg of conv.messages ?? []) {
      if (msg.role === "user") {
        appendPrompt(msg.content ?? msg.text);
      }
    }
  }

  for (const extra of extraPrompts) {
    appendPrompt(extra);
  }

  for (const subagentPrompt of getRecentSubagentUserPrompts()) {
    if (!prompts.includes(subagentPrompt)) {
      prompts.push(subagentPrompt);
    }
  }

  return prompts;
}


