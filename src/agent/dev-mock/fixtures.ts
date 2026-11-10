/**
 * DEV-ONLY fixture data for the browser mock backend. Designed to surface
 * layout bugs: long/unbroken/unicode strings, wide code and tables, many tools.
 * Never imported by production code (see ./index.ts and src/main.tsx).
 */
import type { NativeProviderModel, ProviderProfileRecord } from "@/lib/desktop";

import type {
  AgentEvent,
  AgentMessage,
  AgentSchedule,
  AgentServicesStatus,
  AgentSessionDetail,
  AgentSessionListItem,
  AgentWireEvent,
  ApprovalRequest,
  ArtifactContent,
  ArtifactMeta,
  Block,
  InspectorExchange,
  InspectorList,
  McpServerInfo,
  McpServerStatus,
  MediaEntry,
  PermissionRulesListing,
  PluginInfo,
  PromptPreset,
  PublicDownloadJob,
  RecordingEntry,
  StoredAgentEvent,
  WorkspaceDiff,
} from "../types";

export type MockScenario = "long" | "empty" | "error";

export const ACTIVE_ID = "s-long-01";
export const SECOND_ID = "s-split-02";

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const LONG_PATH =
  "C:\\Users\\khang\\Documents\\Very Long Organisation Name Ltd\\Engineering Department\\platform-monorepo-with-an-unreasonably-long-name\\packages\\desktop-shell-renderer-experimental";
const UNBROKEN = "a".repeat(40) + "_unbroken_identifier_without_any_spaces_" + "Z".repeat(60);
const LONG_URL =
  "https://example.invalid/api/v2/organisations/0b9f6c1e-3a7d-4f55-9e2b-7d4c1a8e6f00/projects/omnia-desktop/pipelines/123456789/jobs/987654321/artifacts/download?file=build-output-windows-x64-release-with-debug-symbols.zip&token=ZXhhbXBsZS1ub3QtYS1yZWFsLXRva2VuLWp1c3QtbG9uZw";

const CWDS = [
  "D:\\Omnia\\repos\\omnia",
  LONG_PATH,
  "C:\\Users\\khang\\Dự án\\ứng-dụng-quản-lý-tài-chính-cá-nhân",
  "D:\\工作\\项目\\客户端界面重构",
  "/home/dev/src/github.com/some-org/some-really-long-repository-name-that-keeps-going",
  "E:\\scratch",
];

const TITLES = [
  "Fix overflow in transcript when a tool prints a very long single line without any whitespace whatsoever and the window is narrow",
  "Split view: compare branches",
  "Sửa lỗi hiển thị tiếng Việt có dấu trong thanh bên và tiêu đề phiên làm việc rất dài",
  "修复侧边栏中的中文标题截断问题以及长路径显示",
  "日本語のタイトルとかなり長いセッション名のテスト — レイアウト確認",
  "🚀🔥 Release prep ✅ changelog 📝 + emoji-only titles 🎉🎉🎉",
  UNBROKEN,
  "Refactor agent-store",
  "a",
  "",
  "Investigate flaky test: src/agent/agent-ipc.integration.test.ts › replays sequenced events after reconnect",
  "한국어 세션 제목 테스트",
  "Add Playwright overflow scanner",
  "Write README",
  "Đánh giá hiệu năng khi có 300 dòng đầu ra",
  "Migrate settings dialog to tabs",
  "Very very very very very very very very very very very very very long title with spaces",
  "Bundle budget check",
  "Diff pane: long lines",
  "Downloads: long filenames",
  "MCP servers flaky",
  "Schedules UI polish",
  "Permission rules editor",
  "Artifacts versions",
  "Usage bar near limit",
];

export function sessions(scenario: MockScenario): AgentSessionListItem[] {
  if (scenario === "empty") return [];
  return TITLES.map((title, index) => {
    const id = index === 0 ? ACTIVE_ID : index === 1 ? SECOND_ID : `s-${String(index).padStart(2, "0")}`;
    return {
      id,
      title,
      cwd: CWDS[index % CWDS.length]!,
      profileId: index % 3 === 0 ? "p-anthropic" : index % 3 === 1 ? "p-openai" : "p-local",
      model: index % 3 === 0 ? "claude-sonnet-4-5" : index % 3 === 1 ? "gpt-5-codex-very-long-model-identifier-2026-10-01" : "qwen3-coder:30b-a3b-q4_K_M",
      permissionMode: (["ask_writes", "plan", "auto", "full", "ask_all"] as const)[index % 5]!,
      reasoningEffort: index % 2 ? "high" : null,
      tokensUsed: 12_000 * (index + 1),
      tokenBudget: index === 0 ? 200_000 : null,
      parentId: index === 7 ? ACTIVE_ID : null,
      messageCount: index === 0 ? 48 : index * 3,
      createdAtMs: NOW - index * DAY - 3 * HOUR,
      updatedAtMs: NOW - index * 37 * MIN,
      running: index === 0 || index === 4,
    };
  });
}

const text = (value: string): Block => ({ type: "text", text: value });
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const toolResult = (id: string, value: string, isError = false): Block => ({
  type: "tool_result",
  tool_use_id: id,
  content: [text(value)],
  is_error: isError,
});

const WIDE_CODE = [
  "```ts",
  "export async function reallyLongFunctionNameThatKeepsGoing(parameterOne: Record<string, unknown>, parameterTwo: ReadonlyArray<Map<string, Set<number>>>, options: { retries: number; backoffMs: number; signal?: AbortSignal } = { retries: 3, backoffMs: 250 }): Promise<void> {",
  `  const url = "${LONG_URL}";`,
  "  for (let attempt = 0; attempt < options.retries; attempt += 1) { await fetch(url, { signal: options.signal ?? null }).catch(() => undefined); }",
  "}",
  "```",
].join("\n");

const WIDE_TABLE = [
  "| Component | File | Width 360 | Width 768 | Width 1366 | Notes about the behaviour observed during manual testing | Owner |",
  "|---|---|---|---|---|---|---|",
  `| Sidebar | src/agent/sidebar.tsx | clipped | ok | ok | Title truncates but the folder path overflows its row | khang |`,
  `| Transcript | src/agent/transcript-view.tsx | overflow | overflow | ok | ${UNBROKEN} | — |`,
  "| Composer | src/agent/composer.tsx | ok | ok | ok | Mentions popover may exceed viewport on the right edge | agy |",
  "| Diff | src/agent/diff-pane.tsx | overflow | ok | ok | Long lines should scroll inside the hunk, not the panel | cli |",
].join("\n");

const MARKDOWN_ANSWER = [
  "## Findings",
  "",
  "Here is the summary of what I found. The layout breaks when content is **wider than the column**, e.g. this inline code: `" + UNBROKEN + "`.",
  "",
  "See the CI log at " + LONG_URL + " for details.",
  "",
  WIDE_TABLE,
  "",
  WIDE_CODE,
  "",
  "1. First item with a nested list",
  "   - nested bullet with **bold** and _italic_ and `code`",
  "   - nested bullet in Tiếng Việt: Kiểm tra hiển thị dấu và xuống dòng đúng cách trong giao diện.",
  "2. 中文段落测试：这是一段很长的中文文本，用于测试在窄屏幕下是否能够正确换行而不会溢出容器。",
  "3. Emoji run 🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉",
  "",
  "> A blockquote that is fairly long and should wrap nicely inside the transcript column without causing the page to scroll horizontally.",
].join("\n");

const LONG_COMMAND =
  "powershell -NoProfile -ExecutionPolicy Bypass -Command \"Get-ChildItem -Recurse -Path 'D:\\Omnia\\repos\\omnia\\src' -Include *.tsx,*.ts | Where-Object { $_.Length -gt 10000 } | ForEach-Object { Write-Output ($_.FullName + ' ' + $_.Length) } | Out-File -Encoding utf8 'C:\\Users\\khang\\AppData\\Local\\Temp\\omnia-large-files-report-with-a-very-long-name.txt'\" && npm run build:renderer -- --mode production --logLevel info";

const THREE_HUNDRED_LINES = Array.from(
  { length: 300 },
  (_, i) => `[${String(i + 1).padStart(3, "0")}] vite v7 building for production... transforming src/agent/module-${i}.tsx (${(i * 17) % 997} modules) ${i % 25 === 0 ? UNBROKEN : ""}`,
).join("\n");

const DIFF_INPUT = {
  file_path: "src/agent/a/very/deeply/nested/directory/structure/that/keeps/going/component-with-long-name.tsx",
  old_string: "const x = 1;",
  new_string: `const x = computeSomethingWithAnExtremelyLongExpression(${"argument, ".repeat(20)}finalArgument); // ${UNBROKEN}`,
};

function longMessages(): AgentMessage[] {
  const reads = ["src/agent/agent-shell.tsx", "src/agent/sidebar.tsx", "src/agent/transcript-view.tsx", "src/agent/composer.tsx", "src/agent/agent.css"];
  return [
    { role: "user", content: [text(`The transcript overflows at narrow widths. Repro: paste ${UNBROKEN} and open ${LONG_URL}. Please investigate and fix.`)] },
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "Let me look at the shell and transcript files first, then check the CSS for min-width: 0 issues." },
        text("I'll start by reading the relevant files."),
        ...reads.map((path, i) => toolUse(`t-read-${i}`, "read_file", { path })),
      ],
    },
    { role: "user", content: reads.map((path, i) => toolResult(`t-read-${i}`, `// ${path}\n${"line of source code\n".repeat(12)}`)) },
    {
      role: "assistant",
      content: [
        text("Now searching for flex containers without `min-width: 0`."),
        toolUse("t-grep", "grep", { pattern: "display:\\s*flex", path: "src/agent" }),
        toolUse("t-glob", "glob", { pattern: "src/**/*.css" }),
      ],
    },
    { role: "user", content: [toolResult("t-grep", "src/agent/agent.css:12: display: flex;\nsrc/agent/tool-row.css:4: display: flex;"), toolResult("t-glob", "src/agent/agent.css\nsrc/agent/tool-row.css")] },
    { role: "assistant", content: [text("Running the test suite."), toolUse("t-fail", "bash", { command: "npx vitest run src/agent/transcript.test.ts --reporter verbose" })] },
    {
      role: "user",
      content: [toolResult("t-fail", `FAIL src/agent/transcript.test.ts > folds tool runs\nAssertionError: expected 3 to equal 4\n    at ${LONG_PATH}\\src\\agent\\transcript.test.ts:123:45\n${UNBROKEN}`, true)],
    },
    { role: "assistant", content: [text("Building to see the full output."), toolUse("t-300", "bash", { command: "npm run build:renderer" })] },
    { role: "user", content: [toolResult("t-300", THREE_HUNDRED_LINES)] },
    { role: "assistant", content: [text("Applying the fix."), toolUse("t-edit", "edit_file", DIFF_INPUT)] },
    { role: "user", content: [toolResult("t-edit", "Edited 1 file (+1 −1).")] },
    { role: "assistant", content: [text(MARKDOWN_ANSWER)] },
    { role: "user", content: [text("Tuyệt vời! Bây giờ hãy kiểm tra thêm ở chế độ chia đôi màn hình và với tiêu đề tiếng Trung 修复侧边栏 nhé. Also check emoji 🎉 titles.")] },
  ];
}

export const APPROVAL: ApprovalRequest = {
  tool_use_id: "t-approve",
  tool: "bash",
  input: { command: LONG_COMMAND, cwd: LONG_PATH },
  summary: LONG_COMMAND,
  ordinal: 1,
  total: 3,
  remaining: [
    { tool_use_id: "t-approve-2", tool: "write_file", input: { path: DIFF_INPUT.file_path }, summary: DIFF_INPUT.file_path },
    { tool_use_id: "t-approve-3", tool: "web_fetch", input: { url: LONG_URL }, summary: LONG_URL },
  ],
};

const PLAN = [
  "# Plan: fix layout overflow",
  "",
  "1. Add `min-width: 0` to `.ag-main` and `.ag-transcript` flex children.",
  "2. Make `pre` blocks scroll horizontally inside their container (`overflow-x: auto`).",
  `3. Break long unbroken strings with \`overflow-wrap: anywhere\` — e.g. ${UNBROKEN}`,
  "4. Verify at 360 / 768 / 1366 / 1920 px with the overflow scanner.",
].join("\n");

function sub(event: AgentEvent): AgentWireEvent {
  return { type: "subagent", parent_id: "t-task", event };
}

function liveReplay(): AgentWireEvent[] {
  return [
    { type: "run_started" },
    { type: "turn_started", turn: 7 },
    { type: "stream", event: { type: "thinking_delta", text: "The user wants split view and CJK checks. I'll delegate an audit to a subagent." } },
    { type: "tool_proposed", id: "t-task", name: "task", input: { description: "Audit every flex container in src/agent for min-width issues and report file:line for each one found" }, summary: "Audit every flex container in src/agent for min-width issues and report file:line for each one found" },
    { type: "tool_started", id: "t-task" },
    sub({ type: "tool_proposed", id: "st-1", name: "glob", input: { pattern: "src/agent/**/*.css" }, summary: "src/agent/**/*.css" }),
    sub({ type: "tool_started", id: "st-1" }),
    sub({ type: "tool_completed", id: "st-1", output: { content: [text("agent.css\ntool-row.css\ndiff-pane.css")], is_error: false } }),
    sub({ type: "tool_proposed", id: "st-2", name: "read_file", input: { path: `${LONG_PATH}\\src\\agent\\agent.css` }, summary: `${LONG_PATH}\\src\\agent\\agent.css` }),
    sub({ type: "tool_started", id: "st-2" }),
    sub({ type: "tool_completed", id: "st-2", output: { content: [text("permission denied: " + UNBROKEN)], is_error: true } }),
    sub({ type: "tool_proposed", id: "st-3", name: "bash", input: { command: "rg -n 'min-width' src/agent" }, summary: "rg -n 'min-width' src/agent" }),
    sub({ type: "tool_started", id: "st-3" }),
    sub({ type: "tool_progress", id: "st-3", chunk: "src/agent/agent.css:44: min-width: 0;\n" }),
    { type: "artifact", id: "a-report", version: 2, title: "Overflow audit report — very long artifact title that should truncate gracefully", kind: "markdown", action: "update" },
    { type: "plan_presented", id: "t-plan", plan: PLAN },
    { type: "tool_proposed", id: "t-run", name: "bash", input: { command: "npm run dev:fast" }, summary: "npm run dev:fast" },
    { type: "tool_started", id: "t-run" },
    { type: "tool_progress", id: "t-run", chunk: "VITE v7 ready in 812 ms\n  ➜  Local:   http://127.0.0.1:1420/\n" },
    { type: "tool_proposed", id: "t-approve", name: "bash", input: APPROVAL.input, summary: APPROVAL.summary },
    { type: "approval_requested", request: APPROVAL },
    { type: "retrying", attempt: 2, delay_ms: 4000, message: "Provider returned 529 overloaded; retrying in 4 s (attempt 2 of 5) — " + UNBROKEN },
    { type: "turn_completed", turn: 7, usage: { input_tokens: 40_000, output_tokens: 4_200, cache_read_tokens: 120_000, cache_write_tokens: 9_000 }, stop: "tool_use" },
    { type: "stream", event: { type: "text_delta", text: "While waiting for approval, here is a progress note: " } },
  ];
}

function stored(events: AgentWireEvent[]): StoredAgentEvent[] {
  return events.map((event, sequence) => ({ sequence, event }));
}

export function sessionDetail(scenario: MockScenario, id: string): AgentSessionDetail {
  const summary = sessions(scenario).find((s) => s.id === id) ?? sessions("long")[0]!;
  const { running: _running, ...base } = summary;
  if (id === ACTIVE_ID) {
    const replayEvents = stored(liveReplay());
    return {
      summary: base,
      messages: longMessages(),
      running: true,
      runStatus: "running",
      replayEvents,
      pendingApprovals: [APPROVAL],
      eventCursor: replayEvents.length - 1,
    };
  }
  if (id === SECOND_ID) {
    return {
      summary: base,
      messages: [
        { role: "user", content: [text("Compare the two branches and summarise.")] },
        { role: "assistant", content: [text(MARKDOWN_ANSWER)] },
      ],
      running: false,
      runStatus: "completed",
    };
  }
  return {
    summary: base,
    messages: [
      { role: "user", content: [text(summary.title || "Untitled request")] },
      { role: "assistant", content: [text("Done. " + (Number(id.slice(2)) % 2 ? WIDE_CODE : "Short answer."))] },
    ],
    running: false,
    runStatus: id === "s-05" ? "failed" : "completed",
    ...(id === "s-06" ? { unknownSideEffects: ["bash: " + LONG_COMMAND] } : {}),
  };
}

/** Events the mock streams into the active session on a timer. */
export function streamTick(tick: number): AgentWireEvent[] {
  const words = ["Checking ", "the ", "sidebar ", "at ", "360px… ", "kiểm tra ", "宽度 ", "🎉 ", UNBROKEN.slice(0, 30), " ", "done. "];
  const events: AgentWireEvent[] = [{ type: "stream", event: { type: "text_delta", text: words[tick % words.length]! } }];
  if (tick % 6 === 3) events.push({ type: "subagent", parent_id: "t-task", event: { type: "tool_progress", id: "st-3", chunk: `src/agent/file-${tick}.css:${tick}: min-width: 0;\n` } });
  if (tick % 4 === 1) events.push({ type: "tool_progress", id: "t-run", chunk: `[vite] hmr update /src/agent/agent.css (x${tick})\n` });
  return events;
}

export const profiles: ProviderProfileRecord[] = [
  { id: "p-anthropic", providerType: "anthropic", displayName: "Anthropic (work account with a long display name)", normalizedBaseUrl: "https://api.anthropic.com", authScheme: "x-api-key", organizationId: null, remoteProjectId: null, credentialStatus: "present", localNetworkGrant: false, enabled: true, createdAtMs: NOW - 30 * DAY, updatedAtMs: NOW - DAY },
  { id: "p-openai", providerType: "openai", displayName: "OpenAI", normalizedBaseUrl: "https://api.openai.com/v1", authScheme: "bearer", organizationId: "org-very-long-organisation-identifier-1234567890", remoteProjectId: null, credentialStatus: "missing", localNetworkGrant: false, enabled: true, createdAtMs: NOW - 20 * DAY, updatedAtMs: NOW - DAY },
  { id: "p-local", providerType: "openai-compatible", displayName: "Ollama (LAN box 192.168.1.50)", normalizedBaseUrl: "http://192.168.1.50:11434/v1", authScheme: "none", organizationId: null, remoteProjectId: null, credentialStatus: "present", localNetworkGrant: true, enabled: true, createdAtMs: NOW - 10 * DAY, updatedAtMs: NOW - DAY },
];

export function models(profileId: string): NativeProviderModel[] {
  const ids =
    profileId === "p-anthropic"
      ? ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"]
      : profileId === "p-openai"
        ? ["gpt-5", "gpt-5-codex-very-long-model-identifier-2026-10-01", "gpt-4.1-mini"]
        : ["qwen3-coder:30b-a3b-q4_K_M", "llama3.3:70b-instruct-q8_0", "deepseek-r1:671b"];
  return ids.map((id) => ({ id, displayName: id, ownedBy: null, createdAt: null, capabilities: { streaming: true, tools: true, vision: id.includes("claude"), reasoning: true, source: "mock" } }));
}

export const mcpStatus: McpServerStatus[] = [
  { name: "filesystem", state: "connected", error: null, toolCount: 12 },
  { name: "github-enterprise-server-with-a-long-name", state: "failed", error: "spawn ENOENT: C:\\Program Files\\nodejs\\node_modules\\@modelcontextprotocol\\server-github\\dist\\index.js — " + UNBROKEN, toolCount: 0 },
  { name: "postgres", state: "disabled", error: null, toolCount: 0 },
  { name: "playwright", state: "connected", error: null, toolCount: 31 },
];

export const mcpServerInfo: McpServerInfo = { enabled: true, url: "http://127.0.0.1:47823/mcp", token: "mock-token-" + "x".repeat(48), port: 47823 };

export const permissionRules: PermissionRulesListing = {
  global: [
    { tool: "read_file", pattern: null, action: "allow" },
    { tool: "bash", pattern: "npm run *", action: "allow" },
    { tool: "bash", pattern: "re:^(rm|del|Remove-Item)\\s+-(r|rf|Recurse).*$", action: "deny" },
    { tool: "web_fetch", pattern: LONG_URL, action: "ask" },
  ],
  project: { path: `${LONG_PATH}\\.omnia\\permissions.json`, exists: true, trusted: false, error: null, rules: [{ tool: "write_file", pattern: "src/**", action: "allow" }] },
  session: [{ tool: "edit_file", pattern: null, action: "allow" }],
  mode: "ask_writes",
};

export const schedules: AgentSchedule[] = [
  { id: "sch-1", name: "Nightly dependency audit with a very long schedule name that should truncate", sessionId: ACTIVE_ID, prompt: "Run npm audit and summarise. " + UNBROKEN, cron: "0 2 * * *", enabled: true, lastRunAt: NOW - 20 * HOUR, nextRunAt: NOW + 4 * HOUR, lastStatus: "failed", lastMessage: "Provider error 401: " + UNBROKEN },
  { id: "sch-2", name: "Hourly check", newSession: { cwd: LONG_PATH, profileId: "p-local", model: "qwen3-coder:30b-a3b-q4_K_M" }, prompt: "Check CI.", intervalMinutes: 60, enabled: false, lastRunAt: null, nextRunAt: null, lastStatus: null, lastMessage: null },
];

export const presets: PromptPreset[] = [
  { id: "pp-1", name: "Terse reviewer", mode: "append", text: "Be terse." },
  { id: "pp-2", name: "Tiếng Việt — trả lời bằng tiếng Việt có dấu, giải thích chi tiết", mode: "replace", text: "Luôn trả lời bằng tiếng Việt." },
];

export const plugins: PluginInfo[] = [
  { name: "omnia-review-toolkit-with-a-long-name", version: "1.2.3-beta.4+build.5678", description: "Code review helpers. " + "Long description. ".repeat(10), author: "Someone With A Long Name <someone@example.invalid>", scope: "user", path: `${LONG_PATH}\\.omnia\\plugins\\review`, enabled: true, contents: { skills: 3, agents: 2, commands: 5, hooks: 1, mcpServers: 1 } },
  { name: "tiny", version: "0.0.1", description: "", author: null, scope: "project", path: "D:\\x", enabled: false, contents: { skills: 0, agents: 0, commands: 1, hooks: 0, mcpServers: 0 } },
];

const job = (id: string, name: string, status: PublicDownloadJob["job"]["status"], downloaded: number, total: number | null): PublicDownloadJob => ({
  job: {
    id,
    status,
    outputPath: `C:\\Users\\khang\\Downloads\\Omnia\\${name}`,
    error: status === "failed" ? "HTTP 403 Forbidden while fetching segment 1234 of 5678 — " + UNBROKEN : null,
    errorCode: status === "failed" ? "http_403" : null,
    spec: { fileName: name, kind: { type: name.endsWith(".m3u8") ? "hls" : "http" } },
    progress: { downloaded, total, speedBps: status === "downloading" ? 12_345_678 : 0, etaSecs: status === "downloading" ? 754 : null },
  },
  reauthorizationRequired: status === "paused",
  ...(status === "completed" ? { muxSkipped: true, muxHint: "ffmpeg not found; audio and video were kept as separate files." } : {}),
});

export const downloads: PublicDownloadJob[] = [
  job("d-1", "Very Long Conference Talk Recording — Building Resilient Desktop Applications With Tauri And React (1080p, 60fps, English subtitles).mp4", "downloading", 734_003_200, 2_147_483_648),
  job("d-2", "stream-master-playlist.m3u8", "paused", 10_000_000, null),
  job("d-3", "báo-cáo-tài-chính-quý-3-năm-2026-bản-cuối-cùng.pdf", "completed", 5_242_880, 5_242_880),
  job("d-4", UNBROKEN + ".zip", "failed", 0, 1000),
  job("d-5", "设计稿-最终版-v12.fig", "queued", 0, null),
];

export function services(): AgentServicesStatus {
  return {
    browser: { available: true, launchPolicy: "on_demand", personalBrowser: false, keepSignIns: true, profileMode: "persistent", running: true },
    ffmpeg: { available: false, path: null, configuredPath: "C:\\Tools\\ffmpeg-7.1-full_build\\bin\\ffmpeg.exe" },
    downloads: { available: true, destination: "C:\\Users\\khang\\Downloads\\Omnia\\" + "nested\\".repeat(6), jobs: downloads, restoredJobsRequireReauthorization: true },
    computer: { available: true, capture: true, control: false, defaultDisabled: true },
  };
}

export const media: MediaEntry[] = [
  { id: "m-1", url: LONG_URL, name: "master.m3u8", pageUrl: LONG_URL, pageTitle: "A page title that is long enough to wrap twice in the downloads panel — Example", kind: "hls", mime: "application/vnd.apple.mpegurl", size: null, drmProtected: false, timestamp: NOW - 5 * MIN },
  { id: "m-2", url: "https://example.invalid/v.mp4", name: "v.mp4", pageUrl: null, pageTitle: null, kind: "video", mime: "video/mp4", size: 99_000_000, drmProtected: true, timestamp: NOW - MIN },
];

export const recordings: RecordingEntry[] = [
  { name: "checkout-flow-recording-with-long-name-20261101-101500", path: "C:\\Users\\khang\\AppData\\Local\\Omnia\\recordings\\checkout-flow-recording-with-long-name-20261101-101500", created: NOW - HOUR, steps: 42, hasGif: true },
];

const ART_BASE = { sessionId: ACTIVE_ID, createdMs: NOW - 2 * HOUR, updatedMs: NOW - 10 * MIN };
export const artifacts: ArtifactMeta[] = [
  { ...ART_BASE, id: "a-report", title: "Overflow audit report — very long artifact title that should truncate gracefully", kind: "markdown", version: 2, versions: [1, 2] },
  { ...ART_BASE, id: "a-html", title: "Dashboard prototype", kind: "html", version: 5, versions: [1, 2, 3, 4, 5] },
  { ...ART_BASE, id: "a-csv", title: "widths.csv", kind: "csv", version: 1, versions: [1] },
  { ...ART_BASE, id: "a-code", title: "patch.ts", kind: "code", language: "typescript", version: 1, versions: [1] },
  { ...ART_BASE, id: "a-svg", title: "图表", kind: "svg", version: 1, versions: [1] },
];

export function artifactContent(id: string, version?: number): ArtifactContent {
  const meta = artifacts.find((a) => a.id === id) ?? artifacts[0]!;
  const content =
    meta.kind === "markdown" ? MARKDOWN_ANSWER
    : meta.kind === "html" ? `<h1>Dashboard</h1><p>${UNBROKEN}</p><table border=1><tr>${"<td>wide cell content</td>".repeat(20)}</tr></table>`
    : meta.kind === "csv" ? `component,width,status,notes\n${Array.from({ length: 30 }, (_, i) => `c${i},${360 + i * 40},${i % 3 ? "ok" : "overflow"},"${i === 2 ? UNBROKEN : "note"}"`).join("\n")}`
    : meta.kind === "svg" ? `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="200"><rect width="2400" height="200" fill="#4a7"/><text x="10" y="100" font-size="40">宽度测试 ${UNBROKEN}</text></svg>`
    : WIDE_CODE.replace(/```ts|```/g, "");
  return { meta, version: version ?? meta.version, content };
}

export const diff: WorkspaceDiff = {
  git: true,
  truncated: true,
  error: null,
  files: [
    {
      path: DIFF_INPUT.file_path,
      status: "modified",
      untracked: false,
      binary: false,
      additions: 3,
      deletions: 1,
      hunks: [
        {
          id: "h1",
          header: "@@ -10,6 +10,8 @@ export function ComponentWithLongName(props: VeryLongPropsInterfaceName) {",
          lines: [
            { kind: "ctx", oldNo: 10, newNo: 10, text: "  const [state, setState] = useState(0);" },
            { kind: "del", oldNo: 11, newNo: null, text: "  const x = 1;" },
            { kind: "add", oldNo: null, newNo: 11, text: DIFF_INPUT.new_string },
            { kind: "add", oldNo: null, newNo: 12, text: `  const url = "${LONG_URL}";` },
            { kind: "add", oldNo: null, newNo: 13, text: "  // Tiếng Việt: chú thích dài để kiểm tra xuống dòng 中文注释 🎉" },
            { kind: "ctx", oldNo: 12, newNo: 14, text: "  return <div />;" },
          ],
        },
      ],
    },
    { path: "assets/logo-very-long-binary-asset-name@3x.png", status: "added", untracked: true, binary: true, additions: 0, deletions: 0, hunks: [] },
    { path: "src/old.ts", status: "deleted", untracked: false, binary: false, additions: 0, deletions: 2, hunks: [{ id: "h2", header: "@@ -1,2 +0,0 @@", lines: [{ kind: "del", oldNo: 1, newNo: null, text: "export {};" }, { kind: "del", oldNo: 2, newNo: null, text: UNBROKEN }] }] },
  ],
};

export const inspectorList: InspectorList = {
  exchanges: Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    startedAtMs: NOW - i * MIN,
    provider: i % 2 ? "openai" : "anthropic",
    model: i % 2 ? "gpt-5-codex-very-long-model-identifier-2026-10-01" : "claude-sonnet-4-5",
    status: i === 2 ? 529 : i === 5 ? null : 200,
    durationMs: i === 5 ? null : 1200 + i * 333,
    requestBytes: 120_000 + i,
    responseBytes: 8_000 + i,
    error: i === 2 ? "overloaded_error: " + UNBROKEN : null,
    complete: i !== 5,
  })),
  stats: { requests: 8, errors: 1, retries: 2, fallbacks: 1, completed: 7, averageLatencyMs: 1834 },
};

export function inspectorExchange(id: number): InspectorExchange {
  const summary = inspectorList.exchanges.find((e) => e.id === id) ?? inspectorList.exchanges[0]!;
  return {
    ...summary,
    url: LONG_URL,
    requestHeaders: [{ name: "content-type", value: "application/json" }, { name: "x-very-long-header-name-for-testing", value: UNBROKEN }],
    requestBody: JSON.stringify({ model: summary.model, messages: [{ role: "user", content: UNBROKEN }] }, null, 2),
    requestTruncated: true,
    responseHeaders: [{ name: "content-type", value: "text/event-stream" }],
    responseBody: "event: message_start\ndata: " + UNBROKEN,
    responseTruncated: false,
  };
}

export const voiceStatus = {
  supported: true,
  available: true,
  languages: [{ tag: "en-US", name: "English (United States)" }, { tag: "vi-VN", name: "Tiếng Việt (Việt Nam)" }, { tag: "zh-CN", name: "中文(中华人民共和国)" }],
  systemLanguage: "en-US",
  micPermission: "allowed" as const,
  speechPrivacyAccepted: true,
  listening: false,
};

export const updateSettings = {
  feedUrl: "https://updates.example.invalid/omnia/stable/windows-x86_64/latest.json?channel=stable&arch=x64",
  autoCheck: true,
  currentVersion: "0.1.0-dev",
  keyConfigured: false,
  keyInvalid: false,
  keyFingerprint: null,
  allowUnsigned: false,
  unsignedAllowed: false,
  availableVersion: null,
  availableCandidate: null,
  pendingReset: false,
  generation: 1,
  platform: "windows-x86_64",
};
