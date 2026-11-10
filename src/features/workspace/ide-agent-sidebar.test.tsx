import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_IDE_WORKSPACE_FILES } from "@/domain/sovereign-ide-remote-desktop";
import * as desktopRuntime from "@/lib/desktop";
import { DEFAULT_IDE_PROJECT_FOLDERS, IdeAgentSidebar, extractLatestAgentCode, ideAssistantSteps } from "./ide-agent-sidebar";
import type { RunTimelineEventView } from "./evidence-types";
import { useWorkspaceStore } from "./store";
import type { ChatMessage } from "./types";

const initial = useWorkspaceStore.getState();
const assistant: ChatMessage = { id: "assistant-test", role: "assistant", content: "A safe change.\n```typescript src/App.tsx:12-14\nconst count: number = 3;\nfunction increment() { return count + 1; }\n```", createdAt: "2026-10-19T10:00:00.000Z", status: "complete", modelLabel: "Do not show model metadata", runId: "ide-test-run", attachments: [], branchIndex: 0, branchCount: 1 };
function event(id: string, sequence: number, type: string, summary: string, status: RunTimelineEventView["status"] = "complete"): RunTimelineEventView {
  return { id, runId: "ide-test-run", parentEventId: null, sequence, type, stage: "provider", status, summary, detail: null, startedAt: `2026-10-19T10:00:0${sequence}.000Z`, endedAt: `2026-10-19T10:00:0${sequence + 1}.000Z`, source: "provider", providerLabel: null, attemptOrdinal: null, citationIds: [] };
}
function mount() {
  const onApplyCode = vi.fn();
  const onClose = vi.fn();
  const view = render(<IdeAgentSidebar activeFile={DEFAULT_IDE_WORKSPACE_FILES[0]!} selectedCode="" projects={DEFAULT_IDE_PROJECT_FOLDERS} projectPanelRequest={0} terminalContext="" gitDiff="" onClose={onClose} onApplyCode={onApplyCode} onAddProject={vi.fn().mockResolvedValue(undefined)} onRemoveProject={vi.fn().mockResolvedValue(undefined)} onOpenRemote={vi.fn()} onOpenDisk={vi.fn()} onOpenSplit={vi.fn()} />);
  return { ...view, onApplyCode, onClose };
}

beforeEach(() => {
  useWorkspaceStore.setState(initial, true);
  const conversation = initial.conversations.find((item) => item.id === initial.activeConversationId) ?? initial.conversations[0]!;
  useWorkspaceStore.setState({ activeConversationId: conversation.id, conversations: [{ ...conversation, title: "Code review", messages: [assistant] }], activeRun: null, runTimelineEvents: [event("reasoning", 0, "message.reasoning_summary_delta", "Reasoning update"), event("read", 1, "tool.completed", "Read src/App.tsx"), event("edit", 2, "file.edited", "Edited src/App.tsx (+2 -1)")] });
});
afterEach(() => { useWorkspaceStore.setState(initial, true); vi.restoreAllMocks(); });

describe("IDE review Image 23", () => {
  it("shows one compact header, no metadata or debug tabs, and code-block-only apply/copy actions", () => {
    const { container, onApplyCode, onClose } = mount();
    const sidebar = screen.getByTestId("ide-agy-ai-sidebar");
    expect(within(sidebar).getByRole("combobox", { name: "Active chat" })).toHaveValue(useWorkspaceStore.getState().activeConversationId);
    expect(sidebar.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(sidebar).not.toHaveTextContent("Do not show model metadata");
    expect(sidebar).not.toHaveTextContent(/Cache Hit|Harness:|HOST DISPLAYS|LOCAL SOVEREIGN AI|Official Harnesses Ready/);
    expect(within(sidebar).getByPlaceholderText("Ask anything...")).toBeInTheDocument();
    const apply = within(sidebar).getByRole("button", { name: "Apply to editor" });
    expect(apply).toHaveAttribute("title", "Apply to editor");
    expect(apply.textContent).toBe("");
    fireEvent.click(apply);
    expect(onApplyCode).toHaveBeenCalledWith("const count: number = 3;\nfunction increment() { return count + 1; }");
    expect(within(sidebar).getByRole("button", { name: "Copy code" })).toHaveAttribute("title", "Copy code");
    expect(container.querySelector(".kw, .syntax-keyword")).not.toBeNull();
    expect(within(sidebar).queryByRole("button", { name: "Open in IDE" })).not.toBeInTheDocument();
    fireEvent.click(within(sidebar).getByRole("button", { name: "Toggle AI sidebar" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows real run steps vertically and collapses every completed disclosure", () => {
    const { container } = mount();
    const rows = Array.from(container.querySelectorAll("details"));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("Read src/App.tsx")).toBeInTheDocument();
    expect(screen.getByText("Edited src/App.tsx")).toBeInTheDocument();
    expect(screen.getByText("+2")).toHaveClass("ai-step__diff-add");
    expect(screen.getByText("-1")).toHaveClass("ai-step__diff-del");
    for (const row of rows) expect(row.open).toBe(false);
    const stream = screen.getByTestId("ide-agy-conversation-stream");
    expect(stream.querySelector('article[data-role="assistant"]')).toContainElement(screen.getByText("Read src/App.tsx"));
  });

  it("opens slash autocomplete only after typing, supports Tab, and keeps attach context out of the footer", () => {
    mount();
    const input = screen.getByTestId("ide-agy-ai-input");
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "/", selectionStart: 1, selectionEnd: 1 } });
    expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
    expect((input as HTMLTextAreaElement).value).not.toBe("/");
    expect((input as HTMLTextAreaElement).value.trim()).not.toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    expect(screen.getByRole("dialog", { name: "Attach code context" })).toBeInTheDocument();
    const fileName = DEFAULT_IDE_WORKSPACE_FILES[0]!.path.split(/[\\/]/).at(-1)!;
    fireEvent.click(screen.getByRole("button", { name: `Remove ${fileName}` }));
    expect(document.querySelector(".review-composer-chip")).toBeNull();
  });

  it("switches history and starts a real new store chat without fabricating an assistant turn", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    expect(screen.getByRole("dialog", { name: "Chat history" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("ide-agy-ai-sidebar"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Chat history" })).not.toBeInTheDocument();
    const count = useWorkspaceStore.getState().conversations.length;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "New chat" })); });
    const state = useWorkspaceStore.getState();
    expect(state.conversations).toHaveLength(count + 1);
    expect(state.conversations.find((item) => item.id === state.activeConversationId)?.messages).toEqual([]);
  });
});

describe("IDE authored code and run-step authority", () => {
  it("omits unsupported rerun, clone and preview branch actions", () => {
    mount();
    for (const name of ["Rerun turn", "Clone conversation from this turn", "Branch conversation from this turn", "Compare models on this turn", "Next branch"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/Re-running assistant|Cloned conversation|Created new conversation branch/)).not.toBeInTheDocument();
  });

  it("awaits the real native branch callback and preserves the supplied message", async () => {
    vi.spyOn(desktopRuntime, "isDesktopRuntime").mockReturnValue(true);
    vi.spyOn(desktopRuntime.desktop, "onRunEvent").mockResolvedValue(() => undefined);
    let complete: () => void = () => undefined;
    const fork = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    useWorkspaceStore.setState({ forkConversationBranch: fork });
    mount();
    expect(screen.queryByRole("button", { name: "Rerun turn" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clone conversation from this turn" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Branch conversation from this turn" }));
    expect(fork).toHaveBeenCalledWith(assistant.id);
    expect(screen.getByText("Branch requested")).toBeVisible();
    await act(async () => { complete(); });
    expect(screen.queryByText("Branch requested")).not.toBeInTheDocument();
    expect(screen.queryByText(/Created new conversation branch|Branched/)).not.toBeInTheDocument();
    expect(useWorkspaceStore.getState().conversations[0]?.messages).toEqual([assistant]);
  });

  it("uses the native branch registry rather than message counters and preserves rejected navigation", async () => {
    vi.spyOn(desktopRuntime, "isDesktopRuntime").mockReturnValue(true);
    vi.spyOn(desktopRuntime.desktop, "onRunEvent").mockResolvedValue(() => undefined);
    const activate = vi.fn().mockRejectedValue(new Error("private native failure"));
    useWorkspaceStore.setState((state) => ({
      activateConversationBranch: activate,
      conversations: state.conversations.map((conversation) => ({ ...conversation, activeBranchId: "native-main", nativeBranches: [
        { id: "native-main", name: "main", parentBranchId: null, forkedFromMessageId: null, createdAtMs: 1 },
        { id: "native-fork", name: "fork", parentBranchId: "native-main", forkedFromMessageId: assistant.id, createdAtMs: 2 },
      ] })),
    }));
    mount();
    const switcher = screen.getByTestId(`turn-branch-switcher-ide-${assistant.id}`);
    expect(switcher).toHaveTextContent("1 / 2");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next branch" })); });
    expect(activate).toHaveBeenCalledWith("native-fork");
    expect(screen.getByRole("alert")).toHaveTextContent("Branch navigation failed. Try again.");
    expect(screen.queryByText("private native failure")).not.toBeInTheDocument();
    expect(switcher).toHaveTextContent("1 / 2");
    expect(useWorkspaceStore.getState().conversations[0]?.messages).toEqual([assistant]);
  });

  it("does not invent a code block or a tool history when the model supplied neither", () => {
    expect(extractLatestAgentCode([{ role: "user", content: "```ts\nconst fake = 1;\n```" }, { role: "assistant", content: "No patch." }])).toBeNull();
    expect(ideAssistantSteps({ ...assistant, runId: null, content: "No patch." }, [])).toEqual([]);
  });

  it("excludes unrelated run events and backend verifier/cache descriptions", () => {
    const events = [event("read", 1, "tool.completed", "Read src/App.tsx"), { ...event("other", 2, "tool.completed", "Edited unrelated.ts"), runId: "another-run" }, event("backend", 3, "tool.completed", "Ran builtin_numeric_claim_verifier"), event("cache", 4, "usage.updated", "Cache Hit: 28,410 tok")];
    const steps = ideAssistantSteps(assistant, events);
    expect(steps.map((item) => item.label)).toEqual(["Read src/App.tsx"]);
    expect(steps[0]?.status).toBe("completed");
  });

  it("retains useful source-file operations whose filenames resemble internal diagnostics", () => {
    const labels = ["Read src/cache.ts", "Read src/dfs.ts", "Edited src/harness.ts (+2 -1)", "Read src/verifier.ts"];
    const steps = ideAssistantSteps(assistant, labels.map((label, index) => event(`source-${index}`, index, "tool.completed", label)));
    expect(steps.map((step) => step.label)).toEqual(labels);
  });
});
