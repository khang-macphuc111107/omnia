import { assertDomain } from "./errors";
import type { CommandId } from "./ids";
import {
  commitEditorChange,
  createEditorHistory,
  redoEditorChange,
  serializeEditorDocument,
  setEditorSelection,
  undoEditorChange,
  updateEditorBlock,
  type EditorBlockKind,
  type EditorDocument,
  type EditorHistory,
  type EditorSelection,
} from "./omnia-editor-model";
import { assertIsoTimestamp, assertNonBlank, type IsoTimestamp } from "./shared";

/**
 * A renderer/native-neutral catalog of user-facing actions.
 *
 * The registry only describes and dispatches local, typed intents. It does
 * not grant permissions, invoke a provider, spawn a process, or perform a
 * durable write. Native callers may use the same descriptor as an input to a
 * separate capability check before executing an external effect.
 */

export type OmniaCommandCategory =
  | "navigation"
  | "editor"
  | "chat"
  | "project"
  | "settings"
  | "agents"
  | "system";

export type OmniaCommandScope =
  | "global"
  | "editor"
  | "chat"
  | "project"
  | "settings"
  | "agents";

export type OmniaCommandStatus = "available" | "preview" | "unavailable";
export type OmniaCommandSource = "built-in" | "extension" | "session-import";
export type OmniaCommandEffect =
  | "none"
  | "local-edit"
  | "navigation"
  | "session-state"
  | "external-side-effect";

export type EditorFormatPatch = {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly color?: string;
  readonly fontFamily?: string;
  readonly fontSize?: number;
};

export type OmniaCommandAction =
  | { readonly kind: "noop"; readonly message?: string }
  | { readonly kind: "navigate"; readonly target: string }
  | {
      readonly kind: "editor.insert";
      readonly text: string;
      readonly selection: "replace" | "before" | "after";
    }
  | { readonly kind: "editor.replace-text"; readonly text: string }
  | { readonly kind: "editor.set-block-kind"; readonly blockKind: EditorBlockKind }
  | { readonly kind: "editor.set-format"; readonly format: EditorFormatPatch }
  | {
      readonly kind: "editor.toggle-format";
      readonly format: "bold" | "italic" | "underline";
    }
  | { readonly kind: "editor.undo" }
  | { readonly kind: "editor.redo" }
  | { readonly kind: "editor.export"; readonly format: "json" | "markdown" };

export interface OmniaCommandDescriptor {
  readonly schemaVersion: 1;
  readonly id: CommandId;
  /** Lowercase namespace-qualified identity, for example `editor.toggle-bold`. */
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly category: OmniaCommandCategory;
  readonly scope: OmniaCommandScope;
  readonly keywords: readonly string[];
  readonly aliases: readonly string[];
  readonly shortcut?: string;
  readonly status: OmniaCommandStatus;
  readonly source: OmniaCommandSource;
  readonly effect: OmniaCommandEffect;
  readonly requiresSelection: boolean;
  readonly action: OmniaCommandAction;
  readonly registeredAt: IsoTimestamp;
  readonly disabledAt?: IsoTimestamp;
}

export interface OmniaCommandRegistry {
  readonly version: 1;
  readonly commands: readonly OmniaCommandDescriptor[];
}

export interface OmniaCommandSearchOptions {
  readonly category?: OmniaCommandCategory;
  readonly scope?: OmniaCommandScope;
  readonly status?: OmniaCommandStatus;
  readonly source?: OmniaCommandSource;
  readonly limit?: number;
}

export interface OmniaCommandContext {
  readonly surface?: OmniaCommandScope;
  readonly document?: EditorDocument;
  readonly history?: EditorHistory;
  readonly selection?: EditorSelection;
  readonly now?: IsoTimestamp;
}

export type OmniaCommandDispatchStatus = "applied" | "intent" | "unavailable";

export interface OmniaCommandDispatchResult {
  readonly status: OmniaCommandDispatchStatus;
  readonly command: OmniaCommandDescriptor;
  readonly document?: EditorDocument;
  readonly history?: EditorHistory;
  readonly selection?: EditorSelection;
  readonly intent?: OmniaCommandAction;
  readonly exported?: string;
  readonly reason?: string;
}

const CATEGORIES: readonly OmniaCommandCategory[] = [
  "navigation",
  "editor",
  "chat",
  "project",
  "settings",
  "agents",
  "system",
];
const SCOPES: readonly OmniaCommandScope[] = [
  "global",
  "editor",
  "chat",
  "project",
  "settings",
  "agents",
];
const STATUSES: readonly OmniaCommandStatus[] = ["available", "preview", "unavailable"];
const SOURCES: readonly OmniaCommandSource[] = ["built-in", "extension", "session-import"];
const EFFECTS: readonly OmniaCommandEffect[] = [
  "none",
  "local-edit",
  "navigation",
  "session-state",
  "external-side-effect",
];
const BLOCK_KINDS: readonly EditorBlockKind[] = [
  "paragraph",
  "heading",
  "quote",
  "list",
  "code",
  "image",
  "divider",
];
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const COMMAND_SHORTCUT_PATTERN = /^(?:(?:Ctrl|Alt|Shift|Meta)\+)*[A-Za-z0-9]+$/u;
const FORMAT_KEYS: readonly (keyof EditorFormatPatch)[] = [
  "bold",
  "italic",
  "underline",
  "color",
  "fontFamily",
  "fontSize",
];

function commandId(value: string): CommandId {
  return assertNonBlank(value, "command id", 160) as CommandId;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTerms(values: readonly string[], label: string): readonly string[] {
  const normalized = values
    .map((value) => assertNonBlank(value, label, 80).toLowerCase())
    .filter((value, index, all) => all.indexOf(value) === index);
  return Object.freeze(normalized);
}

function normalizeFormat(value: EditorFormatPatch): EditorFormatPatch {
  const format: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    color?: string;
    fontFamily?: string;
    fontSize?: number;
  } = {};
  if (value.bold !== undefined) format.bold = value.bold;
  if (value.italic !== undefined) format.italic = value.italic;
  if (value.underline !== undefined) format.underline = value.underline;
  if (value.color !== undefined) format.color = assertNonBlank(value.color, "format color", 64);
  if (value.fontFamily !== undefined) {
    format.fontFamily = assertNonBlank(value.fontFamily, "format font family", 160);
  }
  if (value.fontSize !== undefined) {
    assertDomain(
      Number.isFinite(value.fontSize) && value.fontSize >= 6 && value.fontSize <= 160,
      "invalid_argument",
      "Format font size must be between 6 and 160.",
    );
    format.fontSize = value.fontSize;
  }
  return Object.freeze(format);
}

function normalizeAction(action: OmniaCommandAction): OmniaCommandAction {
  assertDomain(isRecord(action), "invalid_argument", "Command action must be an object.");
  if (action.kind === "noop") {
    return Object.freeze({
      kind: "noop",
      ...(action.message === undefined ? {} : { message: assertNonBlank(action.message, "command message", 500) }),
    });
  }
  if (action.kind === "navigate") {
    return Object.freeze({ kind: "navigate", target: assertNonBlank(action.target, "command target", 160) });
  }
  if (action.kind === "editor.insert") {
    assertDomain(
      action.selection === "replace" || action.selection === "before" || action.selection === "after",
      "invalid_argument",
      "Unknown editor insertion selection mode.",
    );
    return Object.freeze({
      kind: "editor.insert",
      text: action.text,
      selection: action.selection,
    });
  }
  if (action.kind === "editor.replace-text") {
    return Object.freeze({ kind: "editor.replace-text", text: action.text });
  }
  if (action.kind === "editor.set-block-kind") {
    assertDomain(isOneOf(BLOCK_KINDS, action.blockKind), "invalid_argument", "Unknown editor block kind.");
    return Object.freeze({ kind: "editor.set-block-kind", blockKind: action.blockKind });
  }
  if (action.kind === "editor.set-format") {
    return Object.freeze({ kind: "editor.set-format", format: normalizeFormat(action.format) });
  }
  if (action.kind === "editor.toggle-format") {
    assertDomain(
      action.format === "bold" || action.format === "italic" || action.format === "underline",
      "invalid_argument",
      "Unknown editor toggle format.",
    );
    return Object.freeze({ kind: "editor.toggle-format", format: action.format });
  }
  if (action.kind === "editor.undo" || action.kind === "editor.redo") {
    return Object.freeze({ kind: action.kind });
  }
  if (action.kind === "editor.export") {
    assertDomain(action.format === "json" || action.format === "markdown", "invalid_argument", "Unknown editor export format.");
    return Object.freeze({ kind: "editor.export", format: action.format });
  }
  throw new Error(`Unknown command action: ${String((action as { readonly kind?: unknown }).kind)}`);
}

function normalizeDescriptor(input: OmniaCommandDescriptor): OmniaCommandDescriptor {
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Unsupported command schema version.");
  const id = commandId(String(input.id));
  const name = assertNonBlank(input.name, "command name", 160).toLowerCase();
  assertDomain(COMMAND_NAME_PATTERN.test(name), "invalid_argument", "Command name must be namespace-qualified.", { name });
  assertDomain(isOneOf(CATEGORIES, input.category), "invalid_argument", "Unknown command category.");
  assertDomain(isOneOf(SCOPES, input.scope), "invalid_argument", "Unknown command scope.");
  assertDomain(isOneOf(STATUSES, input.status), "invalid_argument", "Unknown command status.");
  assertDomain(isOneOf(SOURCES, input.source), "invalid_argument", "Unknown command source.");
  assertDomain(isOneOf(EFFECTS, input.effect), "invalid_argument", "Unknown command effect.");
  assertIsoTimestamp(input.registeredAt, "command registration time");
  if (input.disabledAt !== undefined) {
    assertIsoTimestamp(input.disabledAt, "command disable time");
    assertDomain(Date.parse(input.disabledAt) >= Date.parse(input.registeredAt), "invalid_argument", "Command disable time cannot precede registration.");
  }
  const shortcut = input.shortcut === undefined ? undefined : assertNonBlank(input.shortcut, "command shortcut", 80);
  if (shortcut !== undefined) {
    assertDomain(COMMAND_SHORTCUT_PATTERN.test(shortcut), "invalid_argument", "Command shortcut is malformed.", { shortcut });
  }
  const normalized: OmniaCommandDescriptor = {
    schemaVersion: 1,
    id,
    name,
    label: assertNonBlank(input.label, "command label", 160),
    description: assertNonBlank(input.description, "command description", 500),
    category: input.category,
    scope: input.scope,
    keywords: normalizeTerms(input.keywords, "command keyword"),
    aliases: normalizeTerms(input.aliases, "command alias"),
    ...(shortcut === undefined ? {} : { shortcut }),
    status: input.status,
    source: input.source,
    effect: input.effect,
    requiresSelection: input.requiresSelection,
    action: normalizeAction(input.action),
    registeredAt: input.registeredAt,
    ...(input.disabledAt === undefined ? {} : { disabledAt: input.disabledAt }),
  };
  return Object.freeze(normalized);
}

export function createCommandId(value: string): CommandId {
  return commandId(value);
}

export function createCommandRegistry(): OmniaCommandRegistry {
  return Object.freeze({ version: 1, commands: Object.freeze([]) });
}

export function registerCommand(
  registry: OmniaCommandRegistry,
  input: OmniaCommandDescriptor,
): OmniaCommandRegistry {
  assertDomain(registry.version === 1, "invalid_argument", "Unsupported command registry version.");
  const descriptor = normalizeDescriptor(input);
  assertDomain(!registry.commands.some((command) => command.id === descriptor.id), "conflict", "Command id is already registered.", { commandId: descriptor.id });
  assertDomain(!registry.commands.some((command) => command.name === descriptor.name), "conflict", "Command name is already registered.", { name: descriptor.name });
  return Object.freeze({ ...registry, commands: Object.freeze([...registry.commands, descriptor]) });
}

export function unregisterCommand(registry: OmniaCommandRegistry, id: CommandId): OmniaCommandRegistry {
  assertDomain(registry.version === 1, "invalid_argument", "Unsupported command registry version.");
  return Object.freeze({ ...registry, commands: Object.freeze(registry.commands.filter((command) => command.id !== id)) });
}

export function resolveCommand(
  registry: OmniaCommandRegistry,
  query: CommandId | string,
): OmniaCommandDescriptor | undefined {
  const normalized = query.trim().toLowerCase();
  return registry.commands.find(
    (command) =>
      command.id === query ||
      command.name === normalized ||
      command.aliases.includes(normalized),
  );
}

function commandSearchText(command: OmniaCommandDescriptor): string {
  return [command.name, command.label, command.description, command.category, command.scope, ...command.keywords, ...command.aliases].join(" ").toLowerCase();
}

export function searchCommands(
  registry: OmniaCommandRegistry,
  query = "",
  options: OmniaCommandSearchOptions = {},
): readonly OmniaCommandDescriptor[] {
  const normalized = query.trim().toLowerCase();
  const filtered = registry.commands.filter((command) => {
    if (options.category !== undefined && command.category !== options.category) return false;
    if (options.scope !== undefined && command.scope !== options.scope && command.scope !== "global") return false;
    if (options.status !== undefined && command.status !== options.status) return false;
    if (options.source !== undefined && command.source !== options.source) return false;
    return normalized.length === 0 || commandSearchText(command).includes(normalized);
  });
  const scored = filtered.map((command, index) => {
    if (!normalized) return { command, score: 0, index };
    const exact = command.name === normalized || command.aliases.includes(normalized);
    const prefix = command.name.startsWith(normalized) || command.label.toLowerCase().startsWith(normalized);
    return { command, score: exact ? 0 : prefix ? 10 : 20 + commandSearchText(command).indexOf(normalized), index };
  });
  scored.sort((left, right) => left.score - right.score || left.index - right.index);
  const limit = options.limit === undefined ? scored.length : Math.max(0, Math.floor(options.limit));
  return Object.freeze(scored.slice(0, limit).map(({ command }) => command));
}

function selectedBlock(document: EditorDocument, selection: EditorSelection | undefined): { index: number; blockId: string; start: number; end: number } | undefined {
  const candidate = selection ?? document.selection;
  const index = candidate === undefined ? (document.blocks.length > 0 ? document.blocks.length - 1 : -1) : document.blocks.findIndex((block) => block.id === candidate.blockId);
  if (index < 0) return undefined;
  const block = document.blocks[index];
  if (block === undefined) return undefined;
  const start = candidate === undefined ? block.text.length : Math.min(candidate.start, block.text.length);
  const end = candidate === undefined ? start : Math.min(Math.max(start, candidate.end), block.text.length);
  return { index, blockId: block.id, start, end };
}

function applyEditorAction(
  command: OmniaCommandDescriptor,
  action: OmniaCommandAction,
  context: OmniaCommandContext,
): OmniaCommandDispatchResult {
  const document = context.document;
  if (action.kind === "editor.undo" || action.kind === "editor.redo") {
    if (context.history === undefined) return { status: "unavailable", command, reason: "Editor history is required for undo/redo." };
    const nextHistory = action.kind === "editor.undo" ? undoEditorChange(context.history) : redoEditorChange(context.history);
    if (nextHistory === context.history) return { status: "unavailable", command, reason: action.kind === "editor.undo" ? "No editor change is available to undo." : "No editor change is available to redo." };
    return {
      status: "applied",
      command,
      document: nextHistory.present,
      history: nextHistory,
      ...(nextHistory.present.selection === undefined ? {} : { selection: nextHistory.present.selection }),
    };
  }
  if (document === undefined) return { status: "unavailable", command, reason: "An editor document is required for this command." };
  const now = context.now ?? new Date().toISOString();
  if (action.kind === "editor.export") {
    return {
      status: "applied",
      command,
      document,
      ...(document.selection === undefined ? {} : { selection: document.selection }),
      exported: action.format === "json" ? serializeEditorDocument(document) : document.blocks.map((block) => block.kind === "code" ? `\`\`\`${block.language ?? ""}\n${block.text}\n\`\`\`` : block.kind === "heading" ? `# ${block.text}` : block.kind === "quote" ? `> ${block.text}` : block.kind === "divider" ? "---" : block.text).join("\n\n"),
    };
  }
  if (action.kind === "navigate" || action.kind === "noop") return { status: "intent", command, intent: action };
  const target = selectedBlock(document, context.selection);
  if (target === undefined) return { status: "unavailable", command, reason: "The editor has no selectable block." };
  const block = document.blocks[target.index];
  if (block === undefined) return { status: "unavailable", command, reason: "The selected editor block is unavailable." };
  let nextDocument: EditorDocument;
  let nextSelection: EditorSelection | undefined;
  if (action.kind === "editor.insert" || action.kind === "editor.replace-text") {
    const before = action.kind === "editor.replace-text" || action.selection === "replace" ? block.text.slice(0, target.start) : action.selection === "before" ? block.text.slice(0, target.start) : block.text.slice(0, target.end);
    const after = action.kind === "editor.replace-text" || action.selection === "replace" ? block.text.slice(target.end) : action.selection === "before" ? block.text.slice(target.start) : block.text.slice(target.end);
    const text = action.text;
    const nextText = `${before}${text}${after}`;
    const cursor = before.length + text.length;
    nextDocument = updateEditorBlock(document, target.blockId, { text: nextText }, now);
    nextSelection = { blockId: target.blockId, start: cursor, end: cursor };
  } else if (action.kind === "editor.set-block-kind") {
    nextDocument = updateEditorBlock(document, target.blockId, { kind: action.blockKind }, now);
    nextSelection = { blockId: target.blockId, start: target.start, end: target.end };
  } else if (action.kind === "editor.set-format") {
    nextDocument = updateEditorBlock(document, target.blockId, { format: { ...(block.format ?? {}), ...action.format } }, now);
    nextSelection = { blockId: target.blockId, start: target.start, end: target.end };
  } else if (action.kind === "editor.toggle-format") {
    nextDocument = updateEditorBlock(document, target.blockId, { format: { ...(block.format ?? {}), [action.format]: !(block.format?.[action.format] ?? false) } }, now);
    nextSelection = { blockId: target.blockId, start: target.start, end: target.end };
  } else {
    return { status: "unavailable", command, reason: "This command action is not available in the editor context." };
  }
  const withSelection = setEditorSelection(nextDocument, nextSelection);
  const nextHistory = context.history === undefined ? createEditorHistory(withSelection) : commitEditorChange(context.history, withSelection);
  return { status: "applied", command, document: withSelection, history: nextHistory, selection: nextSelection };
}

export function dispatchCommand(
  registry: OmniaCommandRegistry,
  query: CommandId | string,
  context: OmniaCommandContext = {},
): OmniaCommandDispatchResult {
  const command = resolveCommand(registry, query);
  if (command === undefined) {
    throw new Error(`Unknown Omnia command: ${String(query)}`);
  }
  if (command.status !== "available") {
    return { status: "unavailable", command, reason: `Command is ${command.status}.` };
  }
  if (command.disabledAt !== undefined && Date.parse(command.disabledAt) <= Date.parse(context.now ?? new Date().toISOString())) {
    return { status: "unavailable", command, reason: "Command is disabled." };
  }
  const surface = context.surface ?? "global";
  if (command.scope !== "global" && command.scope !== surface) {
    return { status: "unavailable", command, reason: `Command requires the ${command.scope} surface.` };
  }
  if (command.requiresSelection && context.selection === undefined && context.document?.selection === undefined) {
    return { status: "unavailable", command, reason: "A text selection is required." };
  }
  if (command.action.kind.startsWith("editor.")) return applyEditorAction(command, command.action, context);
  return { status: "intent", command, intent: command.action };
}

function parseFormat(value: unknown): EditorFormatPatch {
  assertDomain(isRecord(value), "invalid_argument", "Invalid command format payload.");
  const format: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    color?: string;
    fontFamily?: string;
    fontSize?: number;
  } = {};
  for (const key of FORMAT_KEYS) {
    const entry = value[key];
    if (entry === undefined) continue;
    if (key === "fontSize") {
      assertDomain(typeof entry === "number", "invalid_argument", "Format font size must be numeric.");
      format.fontSize = entry;
    } else if (key === "bold" || key === "italic" || key === "underline") {
      assertDomain(typeof entry === "boolean", "invalid_argument", "Boolean format values are required.");
      format[key] = entry;
    } else {
      assertDomain(typeof entry === "string", "invalid_argument", "Text format values are required.");
      format[key] = entry;
    }
  }
  return format;
}

function parseAction(value: unknown): OmniaCommandAction {
  assertDomain(isRecord(value) && typeof value.kind === "string", "invalid_argument", "Invalid command action.");
  switch (value.kind) {
    case "noop": return normalizeAction({ kind: "noop", ...(typeof value.message === "string" ? { message: value.message } : {}) });
    case "navigate": return normalizeAction({ kind: "navigate", target: String(value.target ?? "") });
    case "editor.insert": return normalizeAction({ kind: "editor.insert", text: String(value.text ?? ""), selection: value.selection as "replace" | "before" | "after" });
    case "editor.replace-text": return normalizeAction({ kind: "editor.replace-text", text: String(value.text ?? "") });
    case "editor.set-block-kind": return normalizeAction({ kind: "editor.set-block-kind", blockKind: value.blockKind as EditorBlockKind });
    case "editor.set-format": return normalizeAction({ kind: "editor.set-format", format: parseFormat(value.format) });
    case "editor.toggle-format": return normalizeAction({ kind: "editor.toggle-format", format: value.format as "bold" | "italic" | "underline" });
    case "editor.undo": return normalizeAction({ kind: "editor.undo" });
    case "editor.redo": return normalizeAction({ kind: "editor.redo" });
    case "editor.export": return normalizeAction({ kind: "editor.export", format: value.format as "json" | "markdown" });
    default: throw new Error(`Unknown command action: ${value.kind}`);
  }
}

function parseDescriptor(value: unknown): OmniaCommandDescriptor {
  assertDomain(isRecord(value), "invalid_argument", "Invalid command descriptor.");
  return normalizeDescriptor({
    schemaVersion: value.schemaVersion as 1,
    id: commandId(String(value.id ?? "")),
    name: String(value.name ?? ""),
    label: String(value.label ?? ""),
    description: String(value.description ?? ""),
    category: value.category as OmniaCommandCategory,
    scope: value.scope as OmniaCommandScope,
    keywords: Array.isArray(value.keywords) ? value.keywords.filter((entry): entry is string => typeof entry === "string") : [],
    aliases: Array.isArray(value.aliases) ? value.aliases.filter((entry): entry is string => typeof entry === "string") : [],
    ...(typeof value.shortcut === "string" ? { shortcut: value.shortcut } : {}),
    status: value.status as OmniaCommandStatus,
    source: value.source as OmniaCommandSource,
    effect: value.effect as OmniaCommandEffect,
    requiresSelection: value.requiresSelection === true,
    action: parseAction(value.action),
    registeredAt: String(value.registeredAt ?? ""),
    ...(typeof value.disabledAt === "string" ? { disabledAt: value.disabledAt } : {}),
  });
}

export function serializeCommandRegistry(registry: OmniaCommandRegistry): string {
  assertDomain(registry.version === 1, "invalid_argument", "Unsupported command registry version.");
  return JSON.stringify(registry, null, 2);
}

export function deserializeCommandRegistry(input: string | unknown): OmniaCommandRegistry {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  assertDomain(isRecord(value) && value.version === 1 && Array.isArray(value.commands), "invalid_argument", "Invalid command registry.");
  let registry = createCommandRegistry();
  for (const descriptor of value.commands) registry = registerCommand(registry, parseDescriptor(descriptor));
  return registry;
}

function builtinDescriptor(
  id: string,
  name: string,
  label: string,
  description: string,
  category: OmniaCommandCategory,
  scope: OmniaCommandScope,
  effect: OmniaCommandEffect,
  action: OmniaCommandAction,
  now: IsoTimestamp,
  options: Partial<Pick<OmniaCommandDescriptor, "shortcut" | "aliases" | "keywords" | "requiresSelection" | "status">> = {},
): OmniaCommandDescriptor {
  return normalizeDescriptor({
    schemaVersion: 1,
    id: commandId(id),
    name,
    label,
    description,
    category,
    scope,
    keywords: options.keywords ?? [],
    aliases: options.aliases ?? [],
    ...(options.shortcut === undefined ? {} : { shortcut: options.shortcut }),
    status: options.status ?? "available",
    source: "built-in",
    effect,
    requiresSelection: options.requiresSelection ?? false,
    action,
    registeredAt: now,
  });
}

export function createDefaultCommandRegistry(now = new Date().toISOString()): OmniaCommandRegistry {
  assertIsoTimestamp(now, "command registration time");
  const descriptors: readonly OmniaCommandDescriptor[] = [
    builtinDescriptor("omnia.navigation.new-chat", "navigation.new-chat", "New chat", "Start a fresh conversation.", "navigation", "global", "navigation", { kind: "navigate", target: "chats:new" }, now, { shortcut: "Ctrl+N", keywords: ["chat", "conversation", "new"] }),
    builtinDescriptor("omnia.navigation.open-chats", "navigation.open-chats", "Open chats", "Open the conversation workspace.", "navigation", "global", "navigation", { kind: "navigate", target: "chats" }, now, { keywords: ["chat", "conversation", "history", "inbox"] }),
    builtinDescriptor("omnia.navigation.open-projects", "navigation.open-projects", "Open projects", "Open the project workspace.", "navigation", "global", "navigation", { kind: "navigate", target: "projects" }, now, { keywords: ["workspace", "folders"] }),
    builtinDescriptor("omnia.navigation.open-settings", "navigation.open-settings", "Open settings", "Open the Omnia settings workspace.", "navigation", "global", "navigation", { kind: "navigate", target: "settings" }, now, { keywords: ["preferences", "configuration", "options"] }),
    builtinDescriptor("omnia.navigation.open-agents", "navigation.open-agents", "Open agents", "Open the agent orchestration workspace.", "navigation", "global", "navigation", { kind: "navigate", target: "agents" }, now, { keywords: ["tasks", "runs", "orchestration", "automation"] }),
    builtinDescriptor("omnia.chat.focus-composer", "chat.focus-composer", "Focus composer", "Move focus to the active Chat composer.", "chat", "chat", "navigation", { kind: "navigate", target: "chat:composer" }, now, { shortcut: "Ctrl+L", aliases: ["focus input", "focus chat"], keywords: ["chat", "message", "draft", "write"] }),
    builtinDescriptor("omnia.chat.open-history", "chat.open-history", "Open chat history", "Show recent and archived conversations.", "chat", "global", "navigation", { kind: "navigate", target: "chats:history" }, now, { keywords: ["chat", "history", "recent", "archive"] }),
    builtinDescriptor("omnia.chat.export-session", "chat.export-session", "Export chat session", "Preview a portable export of the active conversation.", "chat", "chat", "session-state", { kind: "noop", message: "Chat export is available as a renderer intent; native file delivery is not connected yet." }, now, { status: "preview", keywords: ["chat", "export", "backup", "portable"] }),
    builtinDescriptor("omnia.project.create", "project.create", "Create project", "Start the project setup flow.", "project", "global", "navigation", { kind: "navigate", target: "projects:new" }, now, { shortcut: "Ctrl+Shift+P", keywords: ["project", "workspace", "folder", "create"] }),
    builtinDescriptor("omnia.project.open-active", "project.open-active", "Open active project", "Return to the currently selected project surface.", "project", "project", "navigation", { kind: "navigate", target: "project:active" }, now, { keywords: ["project", "workspace", "active"] }),
    builtinDescriptor("omnia.settings.open-providers", "settings.open-providers", "Open provider settings", "Review provider connections and model routing.", "settings", "global", "navigation", { kind: "navigate", target: "settings:providers" }, now, { keywords: ["provider", "model", "endpoint", "routing"] }),
    builtinDescriptor("omnia.settings.open-permissions", "settings.open-permissions", "Open permissions", "Review capability and permission policy settings.", "settings", "global", "navigation", { kind: "navigate", target: "settings:permissions" }, now, { keywords: ["permission", "capability", "policy", "access"] }),
    builtinDescriptor("omnia.agents.open-runs", "agents.open-runs", "Open agent runs", "Review active, queued, and completed agent runs.", "agents", "global", "navigation", { kind: "navigate", target: "agents:runs" }, now, { keywords: ["agent", "run", "task", "queue", "dag"] }),
    builtinDescriptor("omnia.agents.open-scheduler", "agents.open-scheduler", "Open agent scheduler", "Review scheduling and concurrency controls.", "agents", "global", "navigation", { kind: "navigate", target: "agents:scheduler" }, now, { keywords: ["agent", "schedule", "parallel", "concurrency"] }),
    builtinDescriptor("omnia.system.open-command-palette", "system.open-command-palette", "Open command palette", "Open the searchable command surface.", "system", "global", "navigation", { kind: "navigate", target: "system:command-palette" }, now, { shortcut: "Ctrl+K", aliases: ["commands", "command menu"], keywords: ["palette", "search", "command"] }),
    builtinDescriptor("omnia.system.toggle-sidebar", "system.toggle-sidebar", "Toggle sidebar", "Show or hide the primary navigation sidebar.", "system", "global", "navigation", { kind: "navigate", target: "layout:sidebar" }, now, { shortcut: "Ctrl+Shift+B", keywords: ["layout", "sidebar", "panel"] }),
    builtinDescriptor("omnia.system.toggle-inspector", "system.toggle-inspector", "Toggle inspector", "Show or hide the context and run inspector.", "system", "global", "navigation", { kind: "navigate", target: "layout:inspector" }, now, { shortcut: "Ctrl+Shift+I", keywords: ["layout", "inspector", "context", "run"] }),
    builtinDescriptor("omnia.editor.toggle-bold", "editor.toggle-bold", "Bold", "Toggle bold formatting on the active block.", "editor", "editor", "local-edit", { kind: "editor.toggle-format", format: "bold" }, now, { shortcut: "Ctrl+B", keywords: ["format", "strong"], requiresSelection: false }),
    builtinDescriptor("omnia.editor.toggle-italic", "editor.toggle-italic", "Italic", "Toggle italic formatting on the active block.", "editor", "editor", "local-edit", { kind: "editor.toggle-format", format: "italic" }, now, { shortcut: "Ctrl+I", keywords: ["format", "emphasis"], requiresSelection: false }),
    builtinDescriptor("omnia.editor.toggle-underline", "editor.toggle-underline", "Underline", "Toggle underline formatting on the active block.", "editor", "editor", "local-edit", { kind: "editor.toggle-format", format: "underline" }, now, { shortcut: "Ctrl+U", keywords: ["format", "underline"] }),
    builtinDescriptor("omnia.editor.set-paragraph", "editor.set-paragraph", "Paragraph", "Use a normal paragraph block for the active editor block.", "editor", "editor", "local-edit", { kind: "editor.set-block-kind", blockKind: "paragraph" }, now, { keywords: ["format", "text", "body"] }),
    builtinDescriptor("omnia.editor.set-heading", "editor.set-heading", "Heading", "Use a heading block for the active editor block.", "editor", "editor", "local-edit", { kind: "editor.set-block-kind", blockKind: "heading" }, now, { keywords: ["format", "title", "heading"] }),
    builtinDescriptor("omnia.editor.set-quote", "editor.set-quote", "Quote", "Use a quote block for the active editor block.", "editor", "editor", "local-edit", { kind: "editor.set-block-kind", blockKind: "quote" }, now, { keywords: ["format", "blockquote", "citation"] }),
    builtinDescriptor("omnia.editor.set-list", "editor.set-list", "List", "Use a list block for the active editor block.", "editor", "editor", "local-edit", { kind: "editor.set-block-kind", blockKind: "list" }, now, { keywords: ["format", "bullet", "numbered", "list"] }),
    builtinDescriptor("omnia.editor.set-code", "editor.set-code", "Code block", "Use a code block for the active editor block.", "editor", "editor", "local-edit", { kind: "editor.set-block-kind", blockKind: "code" }, now, { keywords: ["format", "code", "snippet", "syntax"] }),
    builtinDescriptor("omnia.editor.insert-code", "editor.insert-code", "Insert code block", "Insert a fenced TypeScript starter block.", "editor", "editor", "local-edit", { kind: "editor.insert", text: "```typescript\n\n```", selection: "replace" }, now, { keywords: ["code", "typescript", "snippet"] }),
    builtinDescriptor("omnia.editor.insert-math", "editor.insert-math", "Insert equation", "Insert a LaTeX display-math block.", "editor", "editor", "local-edit", { kind: "editor.insert", text: "$$\n\n$$", selection: "replace" }, now, { keywords: ["latex", "math", "formula"] }),
    builtinDescriptor("omnia.editor.insert-divider", "editor.insert-divider", "Insert divider", "Insert a Markdown divider at the active block.", "editor", "editor", "local-edit", { kind: "editor.insert", text: "---", selection: "replace" }, now, { keywords: ["markdown", "separator", "divider"] }),
    builtinDescriptor("omnia.editor.insert-link", "editor.insert-link", "Insert link", "Insert a Markdown link placeholder at the active selection.", "editor", "editor", "local-edit", { kind: "editor.insert", text: "[link text](https://)", selection: "replace" }, now, { keywords: ["markdown", "url", "link", "reference"] }),
    builtinDescriptor("omnia.editor.undo", "editor.undo", "Undo", "Undo the latest local editor change.", "editor", "editor", "local-edit", { kind: "editor.undo" }, now, { shortcut: "Ctrl+Z", keywords: ["history", "back"] }),
    builtinDescriptor("omnia.editor.redo", "editor.redo", "Redo", "Redo the next local editor change.", "editor", "editor", "local-edit", { kind: "editor.redo" }, now, { shortcut: "Ctrl+Y", keywords: ["history", "forward"] }),
    builtinDescriptor("omnia.editor.export-json", "editor.export-json", "Export editor JSON", "Create a portable JSON representation of the current editor document.", "editor", "editor", "none", { kind: "editor.export", format: "json" }, now, { keywords: ["export", "portable", "backup"] }),
    builtinDescriptor("omnia.editor.export-markdown", "editor.export-markdown", "Export editor Markdown", "Create a portable Markdown representation of the current editor document.", "editor", "editor", "none", { kind: "editor.export", format: "markdown" }, now, { keywords: ["export", "markdown", "portable", "text"] }),
  ];
  let registry = createCommandRegistry();
  for (const descriptor of descriptors) registry = registerCommand(registry, descriptor);
  return registry;
}
