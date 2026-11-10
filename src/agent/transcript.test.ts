import { describe, expect, it } from "vitest";

import { folderName, groupByFolder, relativeTime, toolSummary } from "./format";
import {
  emptyLive,
  groupToolRuns,
  itemsFromMessages,
  reduceAgentEvent,
  describeTool,
  inlineDiffKey,
  lineDiff,
  parseDiff,
  toolCategory,
  toolDiff,
  toolGroupLabel,
  type LiveState,
  type ToolGroupItem,
  type ToolItem,
  type TranscriptItem,
} from "./transcript";
import type { AgentMessage, AgentWireEvent } from "./types";

const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 };

function fold(events: AgentWireEvent[], from: LiveState = emptyLive()): LiveState {
  return events.reduce(reduceAgentEvent, from);
}

const tool = (state: LiveState, id: string) =>
  state.items.find((item): item is ToolItem => item.kind === "tool" && item.id === id)!;

describe("run diagnostics", () => {
  it("accepts actual Rust compaction fields and clears the previous prompt meter", () => {
    const state = fold([
      { type: "turn_completed", turn: 1, usage, stop: "end_turn" },
      { type: "compacted", before: 24, after: 6 },
    ]);
    expect(state.contextUsage).toBeNull();
    expect(state.items).toContainEqual(expect.objectContaining({ kind: "notice", text: "Context compacted (24 → 6 messages)." }));
  });

  it("invalidates every visible rewind position as soon as the transcript compacts", () => {
    const loaded = itemsFromMessages(Array.from({ length: 16 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: [{ type: "text" as const, text: `turn ${index}` }],
    })));
    expect(loaded.items.filter((item) => item.kind === "user").map((item) => item.messageIndex)).toContain(14);
    const state = reduceAgentEvent(loaded, { type: "compacted", before: 16, after: 8 });
    expect(state.rewindStale).toBe(true);
    expect(state.items.filter((item) => item.kind === "user").every((item) => item.messageIndex === undefined)).toBe(true);
  });

  it("retains legacy compaction journal compatibility", () => {
    const state = fold([{ type: "compacted", messages_before: 24, messages_after: 6 }]);
    expect(state.items).toContainEqual(expect.objectContaining({ kind: "notice", text: "Context compacted (24 → 6 messages)." }));
  });

  it.each(["failed", "interrupted"] as const)("does not reuse previous run tokens after %s", (status) => {
    const previous = fold([{ type: "run_completed", usage, turns: 1, stop: "end_turn" }]);
    const started = reduceAgentEvent(previous, { type: "run_started" });
    expect(started.usage).toBeNull();
    expect(reduceAgentEvent(started, { type: "run_finished", status }).usage).toBeNull();
    // A replay containing only the terminal event cannot inherit an earlier run total.
    expect(reduceAgentEvent(previous, { type: "run_finished", status }).usage).toBeNull();
  });

  it("keeps completed run totals separate from the latest prompt", () => {
    const total = { ...usage, input_tokens: 500_000 };
    const state = fold([
      { type: "run_started" },
      { type: "turn_completed", turn: 10, usage, stop: "end_turn" },
      { type: "run_completed", usage: total, turns: 10, stop: "end_turn" },
      { type: "run_finished", status: "completed" },
    ]);
    expect(state.usage).toEqual(total);
    expect(state.contextUsage).toEqual(usage);
  });

  it("tracks fallback model for this run without retaining an earlier model's prompt", () => {
    const fallback = fold([
      { type: "turn_completed", turn: 1, usage, stop: "end_turn" },
      { type: "model_fallback", from: "claude-sonnet-4", to: "gpt-5", reason: "unavailable" },
    ]);
    expect(fallback.activeModel).toBe("gpt-5");
    expect(fallback.contextUsage).toBeNull();
    expect(reduceAgentEvent(fallback, { type: "run_started" }).activeModel).toBeNull();
  });

  it("keeps hook and compaction notices after final assistant content replaces streaming", () => {
    const state = fold([
      { type: "run_started" }, { type: "turn_started", turn: 1 },
      { type: "hook_message", hook: "pre_tool_use", message: "Reviewed" },
      { type: "compacted", messages_before: 20, messages_after: 4 },
      { type: "stream", event: { type: "text_delta", text: "draft" } },
      { type: "assistant_message", message: { role: "assistant", content: [{ type: "text", text: "Final" }] } },
      { type: "run_completed", usage, turns: 1, stop: "turn_limit" },
      { type: "run_finished", status: "completed" },
    ]);
    expect(state.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "text", text: "Final" }),
      expect.objectContaining({ kind: "notice", text: "pre_tool_use: Reviewed" }),
      expect.objectContaining({ kind: "notice", text: "Context compacted (20 → 4 messages)." }),
      expect.objectContaining({ kind: "notice", text: expect.stringContaining("Turn limit reached") }),
    ]));
    expect(state.running).toBe(false);
    expect(state.runStatus).toBe("completed");
  });
});

describe("itemsFromMessages", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "fix it" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "hmm" },
        { type: "text", text: "Looking." },
        { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } },
        { type: "tool_use", id: "t2", name: "bash", input: { command: "ls" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "contents" }] },
        { type: "text", text: "also check b" },
      ],
    },
  ];

  it("matches results to tool calls and hides tool-result-only user messages", () => {
    const state = itemsFromMessages(messages);
    expect(state.items.map((i) => i.kind)).toEqual(["user", "thinking", "text", "tool", "tool", "steer"]);
    expect(tool(state, "t1")).toMatchObject({ status: "ok", output: "contents", summary: "a.ts" });
    // t2 never got a result: it was cut off.
    expect(tool(state, "t2").status).toBe("stopped");
  });

  it("flags error results", () => {
    const state = itemsFromMessages([
      { role: "assistant", content: [{ type: "tool_use", id: "x", name: "bash", input: {} }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "x", is_error: true, content: [{ type: "text", text: "boom" }] }],
      },
    ]);
    expect(state.items).toHaveLength(1);
    expect(tool(state, "x")).toMatchObject({ status: "error", output: "boom" });
  });
});

describe("reduceAgentEvent", () => {
  it("accumulates text and thinking deltas, then replaces them with the final message", () => {
    let state = fold([
      { type: "run_started" },
      { type: "turn_started", turn: 1 },
      { type: "stream", event: { type: "thinking_delta", text: "ab" } },
      { type: "stream", event: { type: "thinking_delta", text: "c" } },
      { type: "stream", event: { type: "text_delta", text: "Hel" } },
      { type: "stream", event: { type: "text_delta", text: "lo" } },
    ]);
    expect(state.running).toBe(true);
    expect(state.items).toMatchObject([
      { kind: "thinking", text: "abc", streaming: true },
      { kind: "text", text: "Hello", streaming: true },
    ]);
    state = fold(
      [{ type: "assistant_message", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } }],
      state,
    );
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "text", text: "Hello", streaming: false });
  });

  it("assembles streamed tool input and follows the tool lifecycle", () => {
    const state = fold([
      { type: "run_started" },
      { type: "turn_started", turn: 1 },
      { type: "stream", event: { type: "tool_use_start", id: "t", name: "grep" } },
      { type: "stream", event: { type: "tool_input_delta", id: "t", partial_json: '{"pattern":' } },
      { type: "stream", event: { type: "tool_input_delta", id: "t", partial_json: '"foo"}' } },
      { type: "stream", event: { type: "tool_use_end", id: "t" } },
    ]);
    expect(tool(state, "t")).toMatchObject({ status: "pending", input: { pattern: "foo" }, summary: "foo" });

    const done = fold(
      [
        {
          type: "assistant_message",
          message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "grep", input: { pattern: "foo" } }] },
        },
        { type: "tool_proposed", id: "t", name: "grep", input: { pattern: "foo" }, summary: "grep foo" },
        { type: "tool_started", id: "t" },
        { type: "tool_progress", id: "t", chunk: "a:1\n" },
        { type: "tool_progress", id: "t", chunk: "b:2\n" },
      ],
      state,
    );
    expect(tool(done, "t")).toMatchObject({ status: "running", progress: "a:1\nb:2\n", summary: "grep foo" });

    const finished = fold(
      [{ type: "tool_completed", id: "t", output: { is_error: false, content: [{ type: "text", text: "a:1\nb:2" }] } }],
      done,
    );
    expect(tool(finished, "t")).toMatchObject({ status: "ok", output: "a:1\nb:2", progress: "" });
  });

  it("tracks approvals and marks denied tools", () => {
    const request = { tool_use_id: "t", tool: "bash", input: { command: "rm x" }, summary: "rm x", ordinal: 1, total: 2 };
    let state = fold([
      { type: "tool_proposed", id: "t", name: "bash", input: request.input, summary: "rm x" },
      { type: "approval_requested", request },
    ]);
    expect(state.approvals).toEqual([request]);
    state = fold([{ type: "approval_decided", id: "t", decision: { type: "deny", feedback: "no" } }], state);
    expect(state.approvals).toEqual([]);
    expect(tool(state, "t").status).toBe("denied");
    state = fold(
      [{ type: "tool_completed", id: "t", output: { is_error: true, content: [{ type: "text", text: "declined" }] } }],
      state,
    );
    expect(tool(state, "t").status).toBe("denied");
  });

  it("nests subagent activity under its task row and surfaces nested approvals", () => {
    const request = { tool_use_id: "inner", tool: "bash", input: {}, summary: "ls", ordinal: 1, total: 1 };
    let state = fold([
      { type: "tool_proposed", id: "task1", name: "task", input: { description: "explore" }, summary: "explore" },
      { type: "tool_started", id: "task1" },
      { type: "subagent", parent_id: "task1", event: { type: "tool_proposed", id: "inner", name: "bash", input: {}, summary: "ls" } },
      { type: "subagent", parent_id: "task1", event: { type: "approval_requested", request } },
    ]);
    expect(state.approvals).toEqual([request]);
    expect(tool(state, "task1").sub?.items).toHaveLength(1);

    state = fold(
      [
        { type: "subagent", parent_id: "task1", event: { type: "approval_decided", id: "inner", decision: { type: "allow_once" } } },
        {
          type: "subagent",
          parent_id: "task1",
          event: { type: "tool_completed", id: "inner", output: { is_error: false, content: [{ type: "text", text: "ok" }] } },
        },
        {
          type: "subagent",
          parent_id: "task1",
          event: { type: "turn_started", turn: 2 },
        },
        {
          type: "subagent",
          parent_id: "task1",
          event: { type: "assistant_message", message: { role: "assistant", content: [{ type: "text", text: "Found it." }] } },
        },
      ],
      state,
    );
    expect(state.approvals).toEqual([]);
    const sub = tool(state, "task1").sub!;
    expect(sub.items.map((i) => i.kind)).toEqual(["tool", "text"]);
    // Subagent events never leak into the parent transcript.
    expect(state.items).toHaveLength(1);
  });

  it("runs two parallel task calls independently", () => {
    const state = fold([
      { type: "tool_proposed", id: "a", name: "task", input: {}, summary: "a" },
      { type: "tool_proposed", id: "b", name: "task", input: {}, summary: "b" },
      { type: "subagent", parent_id: "a", event: { type: "steer_injected", text: "x" } },
      { type: "subagent", parent_id: "b", event: { type: "tool_proposed", id: "i", name: "read", input: {}, summary: "r" } },
    ]);
    expect(tool(state, "a").sub?.items).toHaveLength(1);
    expect(tool(state, "b").sub?.items).toHaveLength(1);
  });

  it("renders model fallback and budget warning as notices", () => {
    const state = fold([
      { type: "run_started" },
      { type: "model_fallback", from: "a", to: "b", reason: "overloaded" },
      { type: "budget_warning", used: 85000, budget: 100000 },
      { type: "assistant_message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ]);
    expect(state.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "notice", text: "Model fallback: switched from a to b (overloaded)." }),
      expect.objectContaining({ kind: "notice", text: expect.stringContaining("85,000 of 100,000") }),
    ]));
  });

  it("records retry, usage, and failure", () => {
    let state = fold([{ type: "run_started" }, { type: "retrying", attempt: 2, delay_ms: 1000, message: "429" }]);
    expect(state.retry).toEqual({ attempt: 2, message: "429" });
    state = fold([{ type: "stream", event: { type: "text_delta", text: "x" } }], state);
    expect(state.retry).toBeNull();
    state = fold([{ type: "run_completed", usage, stop: "end_turn", turns: 1 }], state);
    expect(state.usage).toEqual(usage);
    state = fold([{ type: "run_finished", status: "failed", message: "bad key" }], state);
    expect(state.running).toBe(false);
    expect(state.items.at(-1)).toMatchObject({ kind: "error", message: "bad key" });
    expect(state.items[0]).toMatchObject({ kind: "text", streaming: false });
  });

  it("stops unfinished tools when interrupted", () => {
    const state = fold([
      { type: "run_started" },
      { type: "tool_proposed", id: "t", name: "bash", input: {}, summary: "s" },
      { type: "tool_started", id: "t" },
      { type: "run_finished", status: "interrupted" },
    ]);
    expect(tool(state, "t").status).toBe("stopped");
    expect(state.items.at(-1)).toMatchObject({ kind: "notice" });
  });
});

describe("format helpers", () => {
  it("summarises tool input", () => {
    expect(toolSummary("bash", { command: "npm  test\n" })).toBe("npm test");
    expect(toolSummary("x", { other: 1 })).toBe("x");
  });
  it("groups sessions by folder, newest first", () => {
    const groups = groupByFolder([
      { cwd: "C:\\a\\proj", updatedAtMs: 1, id: "1" },
      { cwd: "C:\\b\\other", updatedAtMs: 5, id: "2" },
      { cwd: "C:\\a\\proj", updatedAtMs: 9, id: "3" },
    ]);
    expect(groups.map((g) => g.name)).toEqual(["proj", "other"]);
    expect(groups[0]!.sessions.map((s) => s.id)).toEqual(["3", "1"]);
    expect(folderName("/x/y/")).toBe("y");
  });
  it("formats relative time", () => {
    expect(relativeTime(1000, 1000 + 10_000)).toBe("now");
    expect(relativeTime(0, 5 * 60_000)).toBe("5m");
    expect(relativeTime(0, 3 * 3_600_000)).toBe("3h");
  });
});

describe("plan presentation", () => {
  it("keeps the presented plan until the next run starts", () => {
    const planned = fold([{ type: "run_started" }, { type: "plan_presented", id: "p1", plan: "1. Do it" }]);
    expect(planned.plan).toEqual({ id: "p1", text: "1. Do it" });
    expect(fold([{ type: "run_started" }], planned).plan).toBeNull();
  });
});

describe("groupToolRuns", () => {
  const make = (id: string, name: string, status: ToolItem["status"] = "ok", extra: Partial<ToolItem> = {}): ToolItem => ({
    kind: "tool", key: `k-${id}`, id, name, input: {}, summary: name, status, output: "", progress: "", partialJson: "", sub: null, ...extra,
  });
  const text = (key: string): TranscriptItem => ({ kind: "text", key, text: "hi", streaming: false });

  it("folds consecutive finished calls into one group with category counts", () => {
    const [group, ...rest] = groupToolRuns([make("a", "read_file"), make("b", "read_file"), make("c", "edit_file")]);
    expect(rest).toHaveLength(0);
    expect(group).toMatchObject({ kind: "toolGroup", key: "group:k-a", counts: { read: 2, edit: 1 } });
    expect(toolGroupLabel(group as ToolGroupItem)).toBe("Edited 1 file · read 2");
  });

  it.each(["error", "denied", "pending", "running", "streaming", "stopped"] as const)("keeps a %s call visible and splits the run", (status) => {
    const items = [make("a", "grep"), make("b", "glob"), make("x", "bash", status), make("c", "read_file"), make("d", "read_file")];
    expect(groupToolRuns(items).map((item) => (item.kind === "toolGroup" ? `G${item.tools.length}` : item.key))).toEqual(["G2", "k-x", "G2"]);
  });

  it("never folds subagents or artifacts, and leaves a single call ungrouped", () => {
    const items = [make("a", "read_file"), make("t", "task", "ok", { sub: emptyLive() }), make("art", "artifact"), make("b", "read_file")];
    expect(groupToolRuns(items).map((item) => item.key)).toEqual(["k-a", "k-t", "k-art", "k-b"]);
  });

  it("breaks runs at non-tool items and does not mutate its input", () => {
    const items: TranscriptItem[] = [make("a", "read_file"), make("b", "read_file"), text("t1"), make("c", "read_file"), make("d", "read_file")];
    const before = JSON.stringify(items);
    expect(groupToolRuns(items).map((item) => item.kind)).toEqual(["toolGroup", "text", "toolGroup"]);
    expect(JSON.stringify(items)).toBe(before);
  });

  it("maps tool names to categories", () => {
    expect(["task", "read_file", "apply_patch", "shell", "glob", "web_fetch", "todo_write", "git_status"].map(toolCategory)).toEqual(["task", "read", "edit", "shell", "search", "web", "other", "other"]);
  });
});

describe("describeTool", () => {
  const call = (name: string, input: unknown, extra: Partial<ToolItem> = {}): ToolItem => ({
    kind: "tool", key: `k-${name}`, id: name, name, input, summary: name, status: "ok", output: "", progress: "", partialJson: "", sub: null, ...extra,
  });
  const brief = (item: ToolItem) => {
    const { verb, target, delta } = describeTool(item);
    return [verb, target, delta ? `+${delta.added} -${delta.removed}` : ""].join("|");
  };

  it("describes edits with a line delta from the input", () => {
    expect(brief(call("edit_file", { path: "src/a.ts", old_string: "a\nb\nc", new_string: "a\nB\nc\nd" }))).toBe("Edited|src/a.ts|+2 -1");
    expect(brief(call("edit_file", { path: "n.ts", old_string: "", new_string: "x" }))).toBe("Created|n.ts|+1 -0");
    expect(brief(call("multi_edit", { path: "m.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }))).toBe("Edited|m.ts|+2 -2");
  });

  it("prefers the unified diff the harness printed", () => {
    const output = "Edited src/a.ts (1 replacement)\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n keep\n-old\n+new\n+more\n keep";
    expect(brief(call("edit_file", { path: "src/a.ts", old_string: "x", new_string: "y" }, { output }))).toBe("Edited|src/a.ts|+2 -1");
  });

  it("distinguishes created and overwritten files", () => {
    expect(brief(call("write_file", { path: "a.md", content: "one\ntwo\n" }, { output: "Created a.md (2 lines, 8 bytes)" }))).toBe("Created|a.md|+2 -0");
    expect(describeTool(call("write_file", { path: "a.md", content: "x" }, { output: "Overwrote a.md (1 lines, 1 bytes)" })).verb).toBe("Wrote");
  });

  it("reads patches in both formats", () => {
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@ fn\n ctx\n-old\n+new\n*** Add File: b.ts\n+hello\n*** End Patch";
    expect(brief(call("apply_patch", { patch }))).toBe("Edited|2 files|+2 -1");
    expect(describeTool(call("apply_patch", { patch })).paths).toEqual(["a.ts", "b.ts"]);
    expect(brief(call("apply_patch", { patch: "*** Begin Patch\n*** Add File: c.ts\n+x\n*** End Patch" }))).toBe("Created|c.ts|+1 -0");
    expect(describeTool(call("apply_patch", { patch: "*** Begin Patch\n*** Delete File: d.ts\n*** End Patch" })).verb).toBe("Deleted");
    expect(brief(call("apply_patch", { patch: "--- a/u.ts\n+++ b/u.ts\n@@ -1 +1 @@\n-a\n+b" }))).toBe("Edited|u.ts|+1 -1");
  });

  it("describes reads, commands, searches and fetches", () => {
    expect(brief(call("read_file", { path: "README.md" }))).toBe("Read|README.md|");
    expect(brief(call("read_file", { path: "C:\\repo\\src\\agent\\x.ts" }))).toBe("Read|…/src/agent/x.ts|");
    expect(brief(call("shell", { command: "npm   test" }))).toBe("Ran|npm test|");
    expect(describeTool(call("shell", { command: "x".repeat(200) })).target).toHaveLength(80);
    expect(brief(call("grep", { pattern: "TODO", path: "src" }))).toBe("Searched|TODO|");
    expect(describeTool(call("grep", { pattern: "TODO", path: "src" })).title).toBe("TODO in src");
    expect(brief(call("glob", { pattern: "**/*.ts" }))).toBe("Searched|**/*.ts|");
    expect(brief(call("list_dir", {}))).toBe("Listed|.|");
    expect(brief(call("web_fetch", { url: "https://docs.rs/serde/latest" }))).toBe("Fetched|docs.rs|");
    expect(brief(call("web_search", { query: "tauri 2" }))).toBe("Searched web|tauri 2|");
    expect(brief(call("task", { description: "scan repo", prompt: "..." }))).toBe("Delegated|scan repo|");
    expect(brief(call("todo_write", { todos: [{}, {}] }))).toBe("Updated plan|2 items|");
    expect(brief(call("git_status", {}, { summary: "status" }))).toBe("Git status|status|");
  });

  it("uses the plain action until the call succeeds", () => {
    expect(describeTool(call("shell", { command: "ls" }, { status: "running" })).verb).toBe("Run");
    expect(describeTool(call("edit_file", { path: "a" }, { status: "error" })).verb).toBe("Edit");
  });
});

describe("diff helpers", () => {
  it("keeps changed lines only and marks gaps between hunks", () => {
    expect(lineDiff("a\nb\nc\nd\ne", "a\nB\nc\nd\nE")).toEqual([
      { kind: "del", text: "b" }, { kind: "add", text: "B" }, { kind: "gap", text: "" }, { kind: "del", text: "e" }, { kind: "add", text: "E" },
    ]);
    expect(parseDiff("no hunks here")).toBeNull();
    expect(parseDiff("@@ -1,4 +1,4 @@\n-a\n+b\n same\n-c\n+d\n... diff truncated ...")?.lines.map((line) => line.kind)).toEqual(["del", "add", "gap", "del", "add"]);
  });

  it("returns null for tools that are not edits", () => {
    expect(toolDiff({ name: "shell", input: { command: "ls" }, output: "@@ -1 +1 @@\n-a\n+b" })).toBeNull();
  });
});

describe("group labels and the inline diff", () => {
  const make = (id: string, name: string, input: unknown = {}, extra: Partial<ToolItem> = {}): ToolItem => ({
    kind: "tool", key: `k-${id}`, id, name, input, summary: name, status: "ok", output: "", progress: "", partialJson: "", sub: null, ...extra,
  });
  const labels = (items: ToolItem[]) =>
    groupToolRuns(items)
      .filter((item): item is ToolGroupItem => item.kind === "toolGroup")
      .map(toolGroupLabel);
  const bigEdit = (id: string, path: string) =>
    make(id, "edit_file", { path, old_string: Array.from({ length: 20 }, (_, i) => `o${i}`).join("\n"), new_string: "n" });

  it("leads with verbs and counts each file once", () => {
    const items = [bigEdit("e1", "a"), bigEdit("e2", "b"), bigEdit("e3", "a"), bigEdit("e4", "c"), make("r1", "read_file", { path: "x" }), make("r2", "read_file", { path: "y" }), make("s", "shell", { command: "ls" })];
    expect(labels(items)).toEqual(["Edited 3 files · read 2 · ran 1"]);
  });

  it("says Explored for runs of only reads and searches", () => {
    expect(labels([make("a", "read_file", { path: "a" }), make("b", "read_file", { path: "a" }), make("c", "read_file", { path: "b" }), make("g", "grep", { pattern: "x" })])).toEqual(["Explored 2 files · searched 1"]);
    expect(labels([make("g", "grep", { pattern: "x" }), make("h", "glob", { pattern: "*" })])).toEqual(["Searched 2 times"]);
  });

  it("keeps the latest small edit of the turn out of groups so its mini-diff shows", () => {
    const small = make("e", "edit_file", { path: "a.ts", old_string: "a", new_string: "b" });
    const items = [make("r", "read_file", { path: "x" }), small, make("r2", "read_file", { path: "y" })];
    expect(inlineDiffKey(items)).toBe("k-e");
    expect(groupToolRuns(items).map((item) => item.key)).toEqual(["k-r", "k-e", "k-r2"]);
    expect(inlineDiffKey([small, bigEdit("b", "a.ts")])).toBeNull();
    expect(inlineDiffKey([small, { kind: "user", key: "u", text: "next", images: 0 }])).toBeNull();
    expect(inlineDiffKey([{ ...small, status: "error" }])).toBeNull();
  });
});
