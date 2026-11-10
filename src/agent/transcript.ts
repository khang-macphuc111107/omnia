/**
 * Pure transcript model. `itemsFromMessages` rebuilds a transcript from persisted
 * messages; `reduceAgentEvent` folds live harness events into the same shape.
 * Nothing here touches React, Tauri or timers, so it is straightforward to test.
 */
import { toolSummary } from "./format";
import type {
  AgentEvent,
  AgentMessage,
  AgentSessionDetail,
  AgentWireEvent,
  RunStatus,
  ApprovalRequest,
  Block,
  StreamEvent,
  Usage,
} from "./types";

export type ToolStatus = "streaming" | "pending" | "running" | "ok" | "error" | "denied" | "stopped";

interface ItemBase {
  key: string;
}

export type TranscriptItem =
  | (ItemBase & { kind: "user"; text: string; images: number; /** Index of this message in the persisted transcript; absent until reloaded. */ messageIndex?: number })
  | (ItemBase & { kind: "steer"; text: string })
  | (ItemBase & { kind: "text"; text: string; streaming: boolean })
  | (ItemBase & { kind: "thinking"; text: string; streaming: boolean })
  | (ItemBase & {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      summary: string;
      status: ToolStatus;
      output: string;
      progress: string;
      partialJson: string;
      /** Nested activity of a `task` subagent; null for ordinary tools. */
      sub: LiveState | null;
    })
  | (ItemBase & { kind: "error"; message: string })
  | (ItemBase & { kind: "notice"; text: string });

export type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

export type ToolCategory = "task" | "read" | "edit" | "shell" | "search" | "web" | "other";

/** Rough kind of a tool from its name; drives the row icon, verb and group counts. */
export function toolCategory(name: string): ToolCategory {
  const lower = name.toLowerCase();
  if (lower === "task") return "task";
  if (/^web_|fetch|http/.test(lower)) return "web";
  if (/todo|^git_|^gh_|artifact/.test(lower)) return "other";
  if (/read|view|cat/.test(lower)) return "read";
  if (/write|edit|patch/.test(lower)) return "edit";
  if (/bash|shell|exec|command/.test(lower)) return "shell";
  if (/grep|glob|search|find|list/.test(lower)) return "search";
  return "other";
}

/** One changed line of a diff preview; `gap` marks skipped unchanged lines between hunks. */
export interface DiffLine {
  kind: "add" | "del" | "gap";
  text: string;
}

export interface ToolDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** Files the change touches, as the tool named them. */
  paths: string[];
}

/** Rows a diff preview shows before "Show more"; also the size limit for the inline mini-diff. */
export const DIFF_PREVIEW_LINES = 12;

const GAP: DiffLine = { kind: "gap", text: "" };

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Changed lines from a unified diff or an `*** Begin Patch` patch; null when the text holds no hunks. */
export function parseDiff(text: string): { lines: DiffLine[]; paths: string[] } | null {
  const lines: DiffLine[] = [];
  const paths: string[] = [];
  const source = text.split("\n");
  let inHunk = false;
  let found = false;
  let gap = false;
  source.forEach((line, index) => {
    const file = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (file) {
      paths.push(file[2]!.trim());
      inHunk = file[1] !== "Delete";
      found ||= file[1] === "Delete";
      gap = lines.length > 0;
      return;
    }
    if (line.startsWith("--- ") && source[index + 1]?.startsWith("+++ ")) {
      inHunk = false;
      return;
    }
    if (line.startsWith("+++ ") && source[index - 1]?.startsWith("--- ")) {
      const path = line.slice(4).trim().replace(/^b\//, "");
      if (path !== "/dev/null") paths.push(path);
      return;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      gap = lines.length > 0;
      return;
    }
    if (line.startsWith("***") || !inHunk) return;
    if (line.startsWith("+") || line.startsWith("-")) {
      if (gap && lines.at(-1)?.kind !== "gap") lines.push(GAP);
      gap = false;
      found = true;
      lines.push({ kind: line.startsWith("+") ? "add" : "del", text: line.slice(1) });
    } else if (line.startsWith(" ") || line === "") {
      gap = lines.length > 0;
    } else if (!line.startsWith("\\")) {
      inHunk = false;
    }
  });
  return found ? { lines, paths } : null;
}

/** Changed lines between two texts (common prefix/suffix trimmed, then a small LCS). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  const del = (text: string): DiffLine => ({ kind: "del", text });
  const add = (text: string): DiffLine => ({ kind: "add", text });
  if (x.length * y.length > 40_000) return [...x.map(del), ...y.map(add)];
  const width = y.length + 1;
  const table = new Uint16Array((x.length + 1) * width);
  const at = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = x.length - 1; i >= 0; i -= 1) {
    for (let j = y.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = x[i] === y[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const lines: DiffLine[] = [];
  let gap = false;
  const push = (line: DiffLine) => {
    if (gap && lines.length > 0) lines.push(GAP);
    gap = false;
    lines.push(line);
  };
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      gap = true;
      i += 1;
      j += 1;
    } else if (i < x.length && (j >= y.length || at(i + 1, j) >= at(i, j + 1))) {
      push(del(x[i]!));
      i += 1;
    } else {
      push(add(y[j]!));
      j += 1;
    }
  }
  return lines;
}

function inputPath(input: Record<string, unknown>): string {
  return str(input.path) || str(input.file_path) || str(input.filePath);
}

/**
 * The change an edit tool made: the unified diff the harness printed when there is one,
 * otherwise computed from the call's input. Null for other tools or when nothing is known.
 */
export function toolDiff(item: Pick<ToolItem, "name" | "input" | "output">): ToolDiff | null {
  if (toolCategory(item.name) !== "edit") return null;
  const input = record(item.input);
  const path = inputPath(input);
  let parsed = item.output.includes("@@") ? parseDiff(item.output) : null;
  if (!parsed && str(input.patch)) parsed = parseDiff(str(input.patch));
  if (!parsed) {
    let lines: DiffLine[] | null = null;
    if (Array.isArray(input.edits)) {
      lines = input.edits.flatMap((edit, index) => {
        const one = record(edit);
        const changed = lineDiff(str(one.old_string), str(one.new_string));
        return index > 0 && changed.length > 0 ? [GAP, ...changed] : changed;
      });
    } else if (typeof input.old_string === "string" || typeof input.new_string === "string") {
      lines = lineDiff(str(input.old_string), str(input.new_string));
    } else if (typeof input.content === "string") {
      lines = lineDiff("", input.content.replace(/\n$/, ""));
    }
    if (!lines) return null;
    parsed = { lines, paths: path ? [path] : [] };
  }
  if (parsed.paths.length === 0 && path) parsed.paths.push(path);
  let added = 0;
  let removed = 0;
  for (const line of parsed.lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "del") removed += 1;
  }
  return { ...parsed, added, removed };
}

export interface ToolDescription {
  category: ToolCategory;
  /** Past tense once the call succeeded ("Edited"), otherwise the plain action ("Edit"). */
  verb: string;
  /** Short display target (path tail, command, pattern, host); may be empty. */
  target: string;
  /** The untruncated target, for a tooltip. */
  title: string;
  /** Files touched by an edit tool; a single one feeds "Open in Changes". */
  paths: string[];
  delta?: { added: number; removed: number };
}

/** Long paths keep their last three segments so the file name stays visible. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}

function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function urlHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const VERBS: Record<ToolCategory, readonly [string, string]> = {
  task: ["Delegated", "Delegate"],
  read: ["Read", "Read"],
  edit: ["Edited", "Edit"],
  shell: ["Ran", "Run"],
  search: ["Searched", "Search"],
  web: ["Fetched", "Fetch"],
  other: ["Used", "Use"],
};

const NAMED_VERBS: Record<string, readonly [string, string]> = {
  list_dir: ["Listed", "List"],
  web_search: ["Searched web", "Search web"],
  todo_write: ["Updated plan", "Update plan"],
  shell_output: ["Checked output", "Check output"],
  shell_kill: ["Stopped job", "Stop job"],
  shell_reset: ["Reset shell", "Reset shell"],
};

const PATCH_ADDS = /^\*\*\* Add File|^--- \/dev\/null/m;
const PATCH_KEEPS_OLD = /^\*\*\* (Update|Delete) File|^--- (?!\/dev\/null)/m;
const PATCH_DELETES = /^\*\*\* Delete File|^\+\+\+ \/dev\/null/m;
const PATCH_KEEPS_NEW = /^\*\*\* (Add|Update) File|^\+\+\+ (?!\/dev\/null)/m;

/** Plain-language one-line description of a tool call: verb, target and line delta. */
export function describeTool(item: Pick<ToolItem, "name" | "input" | "output" | "summary" | "status">): ToolDescription {
  const { name } = item;
  const category = toolCategory(name);
  const input = record(item.input);
  const path = inputPath(input);
  let verbs = NAMED_VERBS[name] ?? (category === "other" ? null : VERBS[category]);
  let full = "";
  let target = "";
  let paths: string[] = [];
  let delta: ToolDescription["delta"];
  switch (category) {
    case "read":
      full = path;
      target = shortPath(path);
      break;
    case "search": {
      const pattern = str(input.pattern) || str(input.query);
      full = pattern ? (path ? `${pattern} in ${path}` : pattern) : name === "list_dir" ? path || "." : "";
      target = pattern ? clip(pattern) : shortPath(full);
      break;
    }
    case "shell":
      full = str(input.command);
      target = clip(full);
      break;
    case "web":
      full = str(input.url) || str(input.query);
      target = str(input.url) ? urlHost(full) : clip(full);
      break;
    case "task":
      full = str(input.description);
      target = clip(full);
      break;
    case "edit": {
      const diff = toolDiff(item);
      paths = diff?.paths.length ? diff.paths : path ? [path] : [];
      if (diff && (diff.added || diff.removed)) delta = { added: diff.added, removed: diff.removed };
      full = paths.join(", ");
      target = paths.length > 1 ? `${paths.length} files` : shortPath(full);
      const patch = str(input.patch);
      const output = item.output.trimStart();
      if (output.startsWith("Created") || (name === "edit_file" && input.old_string === "") || (patch && PATCH_ADDS.test(patch) && !PATCH_KEEPS_OLD.test(patch))) {
        verbs = ["Created", "Create"];
      } else if (output.startsWith("Overwrote") || (name === "write_file" && !output)) {
        verbs = ["Wrote", "Write"];
      } else if (patch && PATCH_DELETES.test(patch) && !PATCH_KEEPS_NEW.test(patch)) {
        verbs = ["Deleted", "Delete"];
      }
      break;
    }
    default:
      break;
  }
  if (name === "todo_write" && Array.isArray(input.todos)) {
    full = `${input.todos.length} item${input.todos.length === 1 ? "" : "s"}`;
    target = full;
  }
  if (!target && item.summary && item.summary !== name) {
    full = item.summary;
    target = clip(item.summary);
  }
  if (!verbs) {
    const words = name.replace(/^mcp__/, "").replace(/[_-]+/g, " ").trim();
    const label = words.charAt(0).toUpperCase() + words.slice(1);
    verbs = [label, label];
  }
  return { category, verb: item.status === "ok" ? verbs[0] : verbs[1], target, title: full || target, paths, ...(delta ? { delta } : {}) };
}

/** Consecutive finished tool calls shown as one collapsible row. */
export interface ToolGroupItem {
  kind: "toolGroup";
  key: string;
  tools: ToolItem[];
  counts: Partial<Record<ToolCategory, number>>;
}

export type DisplayItem = TranscriptItem | ToolGroupItem;

/**
 * Only successful, self-contained calls fold away. Failures, denials, calls
 * still waiting or running, subagents and artifacts always stay visible.
 */
function foldable(item: TranscriptItem): item is ToolItem {
  return item.kind === "tool" && item.status === "ok" && item.sub === null && item.name !== "task" && item.name !== "artifact";
}

/**
 * Key of the latest edit since the last user message when it succeeded with a small diff
 * (at most DIFF_PREVIEW_LINES changed lines): that one row shows its mini-diff open.
 */
export function inlineDiffKey(items: readonly TranscriptItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.kind === "user") return null;
    if (item.kind !== "tool" || toolCategory(item.name) !== "edit") continue;
    const diff = item.status === "ok" ? toolDiff(item) : null;
    return diff && diff.lines.length > 0 && diff.lines.length <= DIFF_PREVIEW_LINES ? item.key : null;
  }
  return null;
}

/**
 * Folds runs of two or more foldable tool calls into groups; never mutates `items`.
 * The row named by `inlineDiffKey` stays out of groups so its mini-diff is visible.
 */
export function groupToolRuns(items: readonly TranscriptItem[]): DisplayItem[] {
  const keep = inlineDiffKey(items);
  const display: DisplayItem[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    const first = run[0];
    if (run.length === 1 && first) {
      display.push(first);
    } else if (first) {
      const counts: Partial<Record<ToolCategory, number>> = {};
      for (const tool of run) {
        const category = toolCategory(tool.name);
        counts[category] = (counts[category] ?? 0) + 1;
      }
      // Keyed by the first call, so the group keeps its state as the run grows.
      display.push({ kind: "toolGroup", key: `group:${first.key}`, tools: run, counts });
    }
    run = [];
  };
  for (const item of items) {
    if (foldable(item) && item.key !== keep) {
      run.push(item);
    } else {
      flush();
      display.push(item);
    }
  }
  flush();
  return display;
}

const GROUP_LABEL_ORDER: readonly ToolCategory[] = ["edit", "read", "search", "shell", "web", "other", "task"];

/** [verb, noun] for the first part of a group label ("Edited 3 files"). */
const GROUP_PHRASE: Record<ToolCategory, readonly [string, string]> = {
  edit: ["Edited", "file"],
  read: ["Read", "file"],
  search: ["Searched", "time"],
  shell: ["Ran", "command"],
  web: ["Fetched", "page"],
  other: ["Used", "tool"],
  task: ["Delegated", "task"],
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * "Edited 3 files · read 2 · ran 1"; a run of only reads and searches reads
 * "Explored 4 files · searched 2". Files are counted once however often they were touched.
 */
export function toolGroupLabel(group: ToolGroupItem): string {
  const count = (category: ToolCategory) => {
    const tools = group.tools.filter((tool) => toolCategory(tool.name) === category);
    if (category !== "edit" && category !== "read") return tools.length;
    return new Set(tools.map((tool) => describeTool(tool).title || tool.key)).size;
  };
  const present = GROUP_LABEL_ORDER.filter((category) => group.counts[category]);
  const explored = present[0] === "read" && present.every((category) => category === "read" || category === "search");
  return present
    .map((category, index) => {
      const n = count(category);
      const [verb, noun] = GROUP_PHRASE[category];
      if (index > 0) return `${verb.toLowerCase()} ${n}`;
      return `${explored ? "Explored" : verb} ${plural(n, noun)}`;
    })
    .join(" · ");
}

export interface LiveState {
  items: TranscriptItem[];
  seq: number;
  running: boolean;
  runStatus: RunStatus;
  unknownSideEffects: string[];
  recoveryRequired: boolean;
  /** Persisted message positions changed; rewind waits for authoritative detail. */
  rewindStale?: boolean;
  approvals: ApprovalRequest[];
  retry: { attempt: number; message: string } | null;
  /** Successful main-agent turns in the latest completed run; not session spend. */
  usage: Usage | null;
  /** The latest turn's usage: its prompt size is the live context size. */
  contextUsage: Usage | null;
  /** Latest fallback target for this run; absent means the session's configured model. */
  activeModel?: string | null;
  /** Index in `items` where the current assistant turn began. */
  turnStart: number;
  /** The plan a Plan-mode run presented with `present_plan`; cleared when the next run starts. */
  plan: { id: string; text: string } | null;
}

export function emptyLive(): LiveState {
  return { items: [], seq: 0, running: false, runStatus: "idle", unknownSideEffects: [], recoveryRequired: false, approvals: [], retry: null, usage: null, contextUsage: null, activeModel: null, turnStart: 0, plan: null };
}

export function blocksToText(blocks: Block[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text" || block.type === "thinking") return block.text;
      if (block.type === "image") return "[image]";
      if (block.type === "tool_result") return blocksToText(block.content);
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function nextKey(state: LiveState, prefix: string): string {
  state.seq += 1;
  return `${prefix}-${state.seq}`;
}

function makeTool(state: LiveState, id: string, name: string, input: unknown, status: ToolStatus): ToolItem {
  return {
    key: nextKey(state, "tool"),
    kind: "tool",
    id,
    name,
    input,
    summary: toolSummary(name, input),
    status,
    output: "",
    progress: "",
    partialJson: "",
    sub: null,
  };
}

function findTool(items: TranscriptItem[], id: string): ToolItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "tool" && item.id === id) return item;
  }
  return undefined;
}

function updateTool(state: LiveState, id: string, patch: (tool: ToolItem) => ToolItem): LiveState {
  let index = -1;
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const candidate = state.items[i];
    if (candidate?.kind === "tool" && candidate.id === id) {
      index = i;
      break;
    }
  }
  const current = state.items[index];
  if (index < 0 || current?.kind !== "tool") return state;
  const items = state.items.slice();
  items[index] = patch(current);
  return { ...state, items };
}

/** Appends one persisted/final message to `state` (mutates `state.items` and `seq`). */
function appendMessage(state: LiveState, message: AgentMessage, previous: TranscriptItem[] = [], messageIndex?: number): void {
  if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type === "text" && block.text) {
        state.items.push({ key: nextKey(state, "text"), kind: "text", text: block.text, streaming: false });
      } else if (block.type === "thinking" && block.text) {
        state.items.push({ key: nextKey(state, "think"), kind: "thinking", text: block.text, streaming: false });
      } else if (block.type === "tool_use") {
        const carried = findTool(previous, block.id);
        const tool = makeTool(state, block.id, block.name, block.input, "pending");
        if (carried) {
          tool.status = carried.status === "streaming" ? "pending" : carried.status;
          tool.output = carried.output;
          tool.progress = carried.progress;
          tool.sub = carried.sub;
          tool.summary = carried.summary || tool.summary;
        }
        state.items.push(tool);
      }
    }
    return;
  }
  const hasResults = message.content.some((block) => block.type === "tool_result");
  let text = "";
  let images = 0;
  for (const block of message.content) {
    if (block.type === "tool_result") {
      const tool = findTool(state.items, block.tool_use_id);
      if (tool) {
        tool.output = blocksToText(block.content);
        tool.progress = "";
        tool.status = block.is_error ? (tool.status === "denied" ? "denied" : "error") : "ok";
      }
    } else if (block.type === "text") {
      text = text ? `${text}\n${block.text}` : block.text;
    } else if (block.type === "image") {
      images += 1;
    }
  }
  if (!text && images === 0) return;
  if (hasResults) {
    // Text riding along with tool results is a steering message injected mid-run.
    state.items.push({ key: nextKey(state, "steer"), kind: "steer", text });
  } else {
    state.items.push({ key: nextKey(state, "user"), kind: "user", text, images, ...(messageIndex === undefined ? {} : { messageIndex }) });
  }
}

/** Marks unfinished work as stopped, recursing into subagent groups. */
function settle(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((item) => {
    if (item.kind === "tool") {
      const open = ["streaming", "pending", "running"].includes(item.status);
      const sub = item.sub ? { ...item.sub, items: settle(item.sub.items) } : null;
      return open ? { ...item, status: "stopped" as const, sub } : sub ? { ...item, sub } : item;
    }
    if ((item.kind === "text" || item.kind === "thinking") && item.streaming) {
      return { ...item, streaming: false };
    }
    return item;
  });
}

export function itemsFromMessages(messages: AgentMessage[]): LiveState {
  const state = emptyLive();
  messages.forEach((message, index) => appendMessage(state, message, [], index));
  // A tool call with no recorded result was cut off (interrupt or crash).
  state.items = settle(state.items);
  state.turnStart = state.items.length;
  return state;
}

/** Restore the native checkpoint plus its sequenced, uncheckpointed journal. */
export function restoreSession(detail: AgentSessionDetail): LiveState {
  let state = itemsFromMessages(detail.messages);
  const replay = [...(detail.replayEvents ?? [])].sort((a, b) => a.sequence - b.sequence);
  const seen = new Set<number>();
  for (const entry of replay) {
    if (seen.has(entry.sequence)) continue;
    seen.add(entry.sequence);
    state = reduceAgentEvent(state, entry.event);
  }
  const hasEffects = (event: AgentWireEvent): boolean =>
    event.type === "run_started" || event.type === "tool_started" ||
    (event.type === "subagent" && hasEffects(event.event));
  const unknownSideEffects = detail.unknownSideEffects ?? [];
  return {
    ...state,
    running: detail.running,
    runStatus: detail.runStatus ?? (detail.running ? "running" : "idle"),
    unknownSideEffects,
    recoveryRequired: !detail.running && (unknownSideEffects.length > 0 || replay.some(({ event }) => hasEffects(event))),
    // Recovered approvals are audit records, not live senders after a restart.
    approvals: detail.running ? (detail.pendingApprovals ?? state.approvals) : [],
    retry: detail.running ? state.retry : null,
    items: detail.running ? state.items : settle(state.items),
  };
}

export function addUserMessage(state: LiveState, text: string, images: number): LiveState {
  const next = { ...state, items: state.items.slice() };
  next.items.push({ key: nextKey(next, "user"), kind: "user", text, images });
  next.turnStart = next.items.length;
  return next;
}

function foldStream(state: LiveState, event: StreamEvent): LiveState {
  const items = state.items.slice();
  const next: LiveState = { ...state, items };
  const last = items[items.length - 1];
  switch (event.type) {
    case "text_delta":
      if (last?.kind === "text" && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + event.text };
      } else {
        items.push({ key: nextKey(next, "text"), kind: "text", text: event.text, streaming: true });
      }
      return next;
    case "thinking_delta":
      if (last?.kind === "thinking" && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + event.text };
      } else {
        items.push({ key: nextKey(next, "think"), kind: "thinking", text: event.text, streaming: true });
      }
      return next;
    case "tool_use_start":
      items.push(makeTool(next, event.id, event.name, {}, "streaming"));
      return next;
    case "tool_input_delta":
      return updateTool(state, event.id, (tool) => ({ ...tool, partialJson: tool.partialJson + event.partial_json }));
    case "tool_use_end":
      return updateTool(state, event.id, (tool) => {
        let input: unknown = {};
        try {
          if (tool.partialJson.trim()) input = JSON.parse(tool.partialJson);
        } catch {
          input = { raw: tool.partialJson };
        }
        return { ...tool, input, summary: toolSummary(tool.name, input), status: "pending" };
      });
    default:
      return state;
  }
}

/** Applies a subagent's event to its parent `task` row and surfaces its approvals. */
function foldSubagent(state: LiveState, parentId: string, inner: AgentEvent): LiveState {
  let approvals = state.approvals;
  if (inner.type === "approval_requested") {
    approvals = [...approvals.filter((a) => a.tool_use_id !== inner.request.tool_use_id), inner.request];
  } else if (inner.type === "approval_decided") {
    approvals = approvals.filter((a) => a.tool_use_id !== inner.id);
  }
  const base = approvals === state.approvals ? state : { ...state, approvals };
  return updateTool(base, parentId, (tool) => ({
    ...tool,
    sub: reduceAgentEvent(tool.sub ?? { ...emptyLive(), running: true }, inner),
  }));
}

export function reduceAgentEvent(state: LiveState, event: AgentWireEvent): LiveState {
  switch (event.type) {
    case "compacted": {
      const next: LiveState = { ...state, contextUsage: null, rewindStale: true, items: state.items.map((item) => {
        if (item.kind !== "user") return item;
        const { messageIndex: _staleIndex, ...unindexed } = item;
        return unindexed;
      }) };
      const before = event.before ?? event.messages_before;
      const after = event.after ?? event.messages_after;
      const counts = Number.isSafeInteger(before) && before >= 0 && Number.isSafeInteger(after) && after >= 0;
      next.items.push({ key: nextKey(next, "notice"), kind: "notice", text: counts ? `Context compacted (${before} → ${after} messages).` : "Context compacted." });
      return next;
    }
    case "hook_message": {
      const next = { ...state, items: state.items.slice() };
      next.items.push({ key: nextKey(next, "notice"), kind: "notice", text: `${event.hook}: ${event.message}` });
      return next;
    }
    case "model_fallback": {
      const next = { ...state, activeModel: event.to, contextUsage: null, items: state.items.slice() };
      const reason = event.reason.length > 160 ? `${event.reason.slice(0, 157)}...` : event.reason;
      next.items.push({ key: nextKey(next, "notice"), kind: "notice", text: `Model fallback: switched from ${event.from} to ${event.to} (${reason}).` });
      return next;
    }
    case "budget_warning": {
      const next = { ...state, items: state.items.slice() };
      next.items.push({ key: nextKey(next, "notice"), kind: "notice", text: `Token budget warning: ${event.used.toLocaleString("en-US")} of ${event.budget.toLocaleString("en-US")} tokens used (80%+). The run stops when the budget is reached.` });
      return next;
    }
    case "error": {
      const next = { ...state, items: state.items.slice() };
      next.items.push({ key: nextKey(next, "error"), kind: "error", message: event.message });
      return next;
    }
    case "run_started":
      return { ...state, running: true, runStatus: "running", retry: null, usage: null, contextUsage: null, activeModel: null, turnStart: state.items.length, plan: null };
    case "turn_started":
      return { ...state, retry: null, turnStart: state.items.length };
    case "stream":
      return foldStream({ ...state, retry: null }, event.event);
    case "assistant_message": {
      const next: LiveState = { ...state, items: state.items.slice(0, state.turnStart) };
      const transient = state.items.slice(state.turnStart);
      appendMessage(next, event.message, transient);
      // Final assistant content replaces streamed blocks, not hook/compaction
      // diagnostics emitted during the turn.
      next.items.push(...transient.filter((item) => item.kind === "notice" || item.kind === "error"));
      return next;
    }
    case "tool_proposed": {
      if (!findTool(state.items, event.id)) {
        const next: LiveState = { ...state, items: state.items.slice() };
        next.items.push(makeTool(next, event.id, event.name, event.input, "pending"));
        return updateTool(next, event.id, (tool) => ({ ...tool, summary: event.summary || tool.summary }));
      }
      return updateTool(state, event.id, (tool) => ({
        ...tool,
        name: event.name,
        input: event.input,
        summary: event.summary || toolSummary(event.name, event.input),
        status: tool.status === "streaming" ? "pending" : tool.status,
      }));
    }
    case "approval_requested":
      return {
        ...state,
        approvals: [...state.approvals.filter((a) => a.tool_use_id !== event.request.tool_use_id), event.request],
      };
    case "approval_decided": {
      const next = { ...state, approvals: state.approvals.filter((a) => a.tool_use_id !== event.id) };
      return event.decision.type === "deny"
        ? updateTool(next, event.id, (tool) => ({ ...tool, status: "denied" }))
        : next;
    }
    case "plan_presented":
      return { ...state, plan: { id: event.id, text: event.plan } };
    case "tool_started":
      return updateTool(state, event.id, (tool) => ({ ...tool, status: "running" }));
    case "tool_progress":
      return updateTool(state, event.id, (tool) => ({ ...tool, progress: tool.progress + event.chunk }));
    case "tool_completed":
      return updateTool(state, event.id, (tool) => ({
        ...tool,
        output: blocksToText(event.output.content),
        progress: "",
        status: event.output.is_error ? (tool.status === "denied" ? "denied" : "error") : "ok",
        sub: tool.sub ? { ...tool.sub, running: false, items: settle(tool.sub.items) } : null,
      }));
    case "subagent":
      return foldSubagent(state, event.parent_id, event.event);
    case "steer_injected": {
      const next: LiveState = { ...state, items: state.items.slice() };
      next.items.push({ key: nextKey(next, "steer"), kind: "steer", text: event.text });
      return next;
    }
    case "retrying":
      return { ...state, retry: { attempt: event.attempt, message: event.message } };
    case "turn_completed":
      return { ...state, contextUsage: event.usage };
    case "run_completed": {
      const next = { ...state, usage: event.usage, items: state.items.slice() };
      if (event.stop === "turn_limit") {
        next.items.push({ key: nextKey(next, "notice"), kind: "notice", text: "Turn limit reached. The agent stopped before completing the task; review its progress before continuing." });
      }
      return next;
    }
    case "run_finished": {
      const next: LiveState = {
        ...state,
        running: false,
        runStatus: event.status,
        approvals: [],
        retry: null,
        usage: event.status === "completed" ? (event.outcome?.usage ?? state.usage) : null,
        items: settle(state.items),
      };
      if (event.status === "failed") {
        next.items.push({ key: nextKey(next, "error"), kind: "error", message: event.message ?? "The run failed." });
      } else if (event.status === "interrupted") {
        next.items.push({ key: nextKey(next, "notice"), kind: "notice", text: "Stopped" });
      }
      return next;
    }
    default:
      return state;
  }
}
