import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type CSSProperties } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultSovereignTabs, DEFAULT_BROWSER_PROFILE_PRESETS } from "@/domain/sovereign-browser-devtools";
import * as desktopRuntime from "@/lib/desktop";
import { SovereignBrowserAiSidebar, type SovereignBrowserAiSidebarProps } from "./sovereign-browser-ai-sidebar";
import { useWorkspaceStore } from "./store";
import type { ChatMessage } from "./types";

const initialState = useWorkspaceStore.getState();
function createProps(overrides: Partial<SovereignBrowserAiSidebarProps> = {}): SovereignBrowserAiSidebarProps {
  const tabs = createDefaultSovereignTabs();
  return {
    activeTab: tabs[0]!, tabs,
    pageHtml: '<main><h1>Supplied page</h1><p>12 * 12 = 144</p><a href="https://example.com/docs">Documentation</a><table><tr><th>Count</th><td>3</td></tr></table></main>',
    isPageContextLive: true, media: [], idmQueue: [], messages: [], prompt: "",
    onPromptChange: vi.fn(), onSend: vi.fn(), onSummarize: vi.fn(), onExtractMedia: vi.fn(),
    onInjectUserscript: vi.fn(), onEnqueue: vi.fn(), onClose: vi.fn(),
    profileId: DEFAULT_BROWSER_PROFILE_PRESETS[0]!.id, cookies: [], onCookiesChange: vi.fn(),
    onProfileChange: vi.fn(), onLaunchProfile: vi.fn(), ...overrides,
  };
}
function ControlledSidebar({ props }: { props: SovereignBrowserAiSidebarProps }) {
  const [prompt, setPrompt] = useState(props.prompt);
  return <SovereignBrowserAiSidebar {...props} prompt={prompt} onPromptChange={setPrompt} />;
}
function openPageMenu() { fireEvent.click(screen.getByRole("button", { name: "Page actions" })); }

function mockSidebarViewport(initialWidth: number) {
  const media = Object.assign(new EventTarget(), {
    matches: initialWidth <= 720,
    media: "(max-width: 720px)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }) as MediaQueryList;
  const matchMedia = vi.fn().mockReturnValue(media);
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    media,
    matchMedia,
    resize(width: number) {
      Object.defineProperty(media, "matches", { configurable: true, value: width <= 720 });
      act(() => media.dispatchEvent(new Event("change")));
    },
  };
}

describe("SovereignBrowserAiSidebar review Images 0-2", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ ...initialState,
      conversations: initialState.conversations.map((conversation) => ({ ...conversation, draft: "", messages: [] })),
      activeRun: null,
    });
    window.getSelection()?.removeAllRanges();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("marks only the narrow overlay and updates across the exact 720px breakpoint", () => {
    const viewport = mockSidebarViewport(721);
    const removeListener = vi.spyOn(viewport.media, "removeEventListener");
    const { unmount } = render(<SovereignBrowserAiSidebar {...createProps()} />);
    const panel = screen.getByTestId("browser-ai-copilot-sidebar");
    expect(viewport.matchMedia).toHaveBeenCalledWith("(max-width: 720px)");
    expect(panel).not.toHaveAttribute("data-native-surface-overlay");
    viewport.resize(720);
    expect(panel).toHaveAttribute("data-native-surface-overlay", "true");
    viewport.resize(721);
    expect(panel).not.toHaveAttribute("data-native-surface-overlay");
    unmount();
    expect(removeListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("marks an initially narrow sidebar before the native surface can be shown", () => {
    mockSidebarViewport(720);
    render(<SovereignBrowserAiSidebar {...createProps()} />);
    expect(screen.getByTestId("browser-ai-copilot-sidebar")).toHaveAttribute("data-native-surface-overlay", "true");
  });

  it("keeps rendering safe when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(<SovereignBrowserAiSidebar {...createProps()} />);
    expect(screen.getByTestId("browser-ai-copilot-sidebar")).not.toHaveAttribute("data-native-surface-overlay");
  });

  it("marks side chat as a native overlay and places it using the resized sidebar width", () => {
    mockSidebarViewport(1024);
    const props = createProps();
    render(<div style={{ "--browser-ai-sidebar-width": "500px" } as CSSProperties}><SovereignBrowserAiSidebar {...props} /></div>);
    fireEvent(window, new CustomEvent("omnia:browser-selection", { detail: { text: "Page evidence", url: props.activeTab.url } }));
    fireEvent.click(screen.getByRole("button", { name: "Ask in side chat" }));
    const side = screen.getByTestId("browser-ai-side-chat");
    expect(side).toHaveAttribute("data-native-surface-overlay", "true");
    const style = window.getComputedStyle(side);
    expect(style.right).toBe("var(--browser-ai-sidebar-width, 340px)");
    expect(style.maxWidth).toBe("calc(100% - var(--browser-ai-sidebar-width, 340px))");
  });

  it("omits unsupported turn actions on durable and local assistant messages", () => {
    const message: ChatMessage = {
      id: "durable-answer", role: "assistant", content: "Saved answer", createdAt: "2026-11-02T00:00:00Z", status: "complete",
      modelLabel: null, runId: null, attachments: [], branchIndex: 1, branchCount: 1,
    };
    useWorkspaceStore.setState((state) => ({ conversations: state.conversations.map((conversation) => conversation.id === state.activeConversationId ? {
      ...conversation,
      messages: [message],
    } : conversation) }));
    render(<SovereignBrowserAiSidebar {...createProps({ messages: [{ id: "local-answer", role: "assistant", text: "Local answer", timestamp: "Now" }] })} />);
    expect(screen.queryAllByRole("button", { name: "Rerun turn" })).toHaveLength(0);
    expect(screen.queryByTestId("turn-action-rerun-browser-chat-durable-answer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("turn-action-rerun-browser-local-local-answer")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: "Clone conversation from this turn" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "Branch conversation from this turn" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "Compare models on this turn" })).toHaveLength(0);
    expect(screen.queryByText(/Re-running assistant turn|Re-ran turn/)).not.toBeInTheDocument();
    expect(useWorkspaceStore.getState().activeRun).toBeNull();
  });

  it("awaits a native branch request without claiming completion or mutating message counts", async () => {
    vi.spyOn(desktopRuntime, "isDesktopRuntime").mockReturnValue(true);
    const message: ChatMessage = { id: "native-answer", role: "assistant", content: "Native answer", createdAt: "2026-11-02T00:00:00Z", status: "complete", modelLabel: "gpt-6.1-sol", runId: null, attachments: [], branchIndex: 7, branchCount: 9 };
    let complete: () => void = () => undefined;
    const fork = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    useWorkspaceStore.setState((state) => ({
      forkConversationBranch: fork,
      conversations: state.conversations.map((conversation) => conversation.id === state.activeConversationId ? { ...conversation, messages: [message] } : conversation),
    }));
    render(<SovereignBrowserAiSidebar {...createProps()} />);
    expect(screen.queryByRole("button", { name: "Rerun turn" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clone conversation from this turn" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next branch" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Branch conversation from this turn" }));
    expect(fork).toHaveBeenCalledWith(message.id);
    expect(screen.getByText("Branch requested")).toBeVisible();
    expect(screen.getByRole("button", { name: "Branch conversation from this turn" })).toBeDisabled();
    await act(async () => { complete(); });
    expect(screen.queryByText("Branch requested")).not.toBeInTheDocument();
    expect(screen.queryByText(/Created new conversation branch|Branched/)).not.toBeInTheDocument();
    expect(useWorkspaceStore.getState().conversations.find((conversation) => conversation.id === useWorkspaceStore.getState().activeConversationId)?.messages[0]).toEqual(message);
  });

  it("switches actual native branch IDs and displays a rejected request without inventing state", async () => {
    vi.spyOn(desktopRuntime, "isDesktopRuntime").mockReturnValue(true);
    const activate = vi.fn().mockRejectedValue(new Error("private native failure"));
    const message: ChatMessage = { id: "native-answer", role: "assistant", content: "Native answer", createdAt: "2026-11-02T00:00:00Z", status: "complete", modelLabel: null, runId: null, attachments: [], branchIndex: 8, branchCount: 12 };
    useWorkspaceStore.setState((state) => ({
      activateConversationBranch: activate,
      conversations: state.conversations.map((conversation) => conversation.id === state.activeConversationId ? { ...conversation, messages: [message], activeBranchId: "native-main", nativeBranches: [
        { id: "native-main", name: "main", parentBranchId: null, forkedFromMessageId: null, createdAtMs: 1 },
        { id: "native-fork", name: "fork", parentBranchId: "native-main", forkedFromMessageId: message.id, createdAtMs: 2 },
      ] } : conversation),
    }));
    render(<SovereignBrowserAiSidebar {...createProps()} />);
    const switcher = screen.getByTestId("turn-branch-switcher-browser-chat-native-answer");
    expect(switcher).toHaveTextContent("1 / 2");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next branch" })); });
    expect(activate).toHaveBeenCalledWith("native-fork");
    expect(screen.getByRole("alert")).toHaveTextContent("Branch navigation failed. Try again.");
    expect(screen.queryByText("private native failure")).not.toBeInTheDocument();
    expect(switcher).toHaveTextContent("1 / 2");
    expect(useWorkspaceStore.getState().conversations.find((conversation) => conversation.id === useWorkspaceStore.getState().activeConversationId)?.messages[0]).toEqual(message);
  });

  it("has one 34px chat header and no five-tab or backend status decks", () => {
    render(<SovereignBrowserAiSidebar {...createProps()} />);
    const panel = screen.getByRole("complementary", { name: "Browser AI side panel" });
    expect(within(panel).getByRole("combobox", { name: "Active chat" })).toBeInTheDocument();
    for (const name of ["New chat", "Chat history", "Close AI side panel"]) {
      const button = within(panel).getByRole("button", { name });
      expect(button).toHaveAttribute("title", name);
      expect(button.querySelector("svg")).toBeInTheDocument();
      expect(button).toHaveTextContent("");
    }
    expect(within(panel).queryByRole("tablist")).not.toBeInTheDocument();
    for (const forbidden of ["Local Cache Active", "Browser Use Ready", "Isolated 2nd Input Ready", "Synced", "Swarm", "Cache Hit", "@all-3-tabs", "Ask in /btw"]) {
      expect(panel).not.toHaveTextContent(forbidden);
    }
    expect(screen.getByTestId("browser-copilot-prompt-input")).toHaveAttribute("placeholder", "Ask anything...");
    expect(screen.getByTestId("browser-copilot-send-btn")).toHaveTextContent("Send");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Text selection actions" })).not.toBeInTheDocument();
  });

  it("keeps extraction behind deliberate page actions and stages real provenance without dispatch", () => {
    render(<SovereignBrowserAiSidebar {...createProps()} />);
    expect(screen.queryByTestId("browser-copilot-extract-links-btn")).not.toBeInTheDocument();
    openPageMenu();
    fireEvent.click(screen.getByTestId("browser-copilot-extract-links-btn"));
    expect(screen.getByRole("dialog", { name: "Page actions" })).toBeInTheDocument();
    expect(screen.getByTestId("browser-ai-extracted-content")).toHaveTextContent("https://example.com/docs");
    expect(screen.getByTestId("browser-ai-extracted-content")).toHaveTextContent("Count | 3");
    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    openPageMenu();
    fireEvent.click(screen.getByTestId("browser-copilot-send-context-btn"));
    const state = useWorkspaceStore.getState();
    const draft = state.conversations.find((conversation) => conversation.id === state.activeConversationId)?.draft;
    expect(draft).toContain("Context provenance: Fetched page DOM");
    expect(draft).toContain("Supplied page");
    expect(state.activeRun).toBeNull();
  });

  it("keeps local download scheduling and genuine PDF creation in a click-open utility drawer", () => {
    render(<SovereignBrowserAiSidebar {...createProps({ utility: "idm" })} />);
    expect(screen.getByRole("dialog", { name: "Downloads" })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("browser-ai-lookahead-plan-btn"));
    expect(screen.getByTestId("browser-ai-idm-receipt")).toHaveTextContent("Calculated schedule, not measured transfer speed");
    fireEvent.click(screen.getByTestId("browser-ai-assemble-pdf-btn"));
    const receipt = JSON.parse(screen.getByTestId("browser-ai-idm-receipt").textContent ?? "{}") as { byteLength: number; sha256Hex: string; content: string };
    expect(receipt.byteLength).toBeGreaterThan(0);
    expect(receipt.sha256Hex).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.content).toBe("Supplied page text only");
    expect(screen.getByTestId("browser-ai-download-pdf-btn")).toBeInTheDocument();
  });

  it("parses cookies only in the profile drawer without claiming injection or leaking values", () => {
    const onCookiesChange = vi.fn();
    render(<SovereignBrowserAiSidebar {...createProps({ utility: "profiles", onCookiesChange })} />);
    fireEvent.change(screen.getByTestId("browser-ai-cookie-import-input"), { target: { value: "Cookie: SID=example-only" } });
    fireEvent.click(screen.getByTestId("browser-ai-cookie-import-btn"));
    expect(onCookiesChange).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ name: "SID", value: "example-only" })]));
    expect(screen.getByTestId("browser-ai-action-status")).toHaveTextContent("Native cookie injection is not confirmed");
    expect(screen.getByTestId("browser-ai-action-status")).not.toHaveTextContent("example-only");
  });

  it("retains planning tools behind a menu without representing plans as running workers", () => {
    render(<SovereignBrowserAiSidebar {...createProps()} />);
    openPageMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Research plan" }));
    fireEvent.click(screen.getByTestId("browser-ai-plan-swarm-btn"));
    expect(screen.getByTestId("browser-ai-action-status")).toHaveTextContent("No worker processes were launched");
    expect(within(screen.getByTestId("browser-ai-dfs-tree")).getAllByRole("listitem")).toHaveLength(4);
    expect(useWorkspaceStore.getState().activeRun).toBeNull();
  });

  it("retains deterministic tool scope behind a deliberate drawer", () => {
    render(<SovereignBrowserAiSidebar {...createProps({ utility: "tools" })} />);
    fireEvent.change(screen.getByTestId("browser-ai-tool-select"), { target: { value: "builtin_scientific_calculator" } });
    fireEvent.change(screen.getByTestId("browser-ai-tool-input"), { target: { value: "sqrt(144) + 2^8" } });
    fireEvent.click(screen.getByTestId("browser-ai-run-tool-btn"));
    expect(screen.getByTestId("browser-ai-tool-receipt")).toHaveTextContent("268");
    expect(screen.getByTestId("browser-ai-tool-receipt")).toHaveTextContent("No independent reference corpus supplied");
    expect(screen.getByTestId("browser-ai-tool-receipt")).not.toHaveTextContent(/builtin_/);
  });

  it("accepts selected page text only for the active URL and opens Side chat only on the selection action", () => {
    const props = createProps();
    render(<SovereignBrowserAiSidebar {...props} />);
    fireEvent(window, new CustomEvent("omnia:browser-selection", { detail: { text: "Wrong page", url: "https://unrelated.example" } }));
    expect(screen.queryByRole("toolbar", { name: "Text selection actions" })).not.toBeInTheDocument();
    fireEvent(window, new CustomEvent("omnia:browser-selection", { detail: { text: "Active page quote", url: props.activeTab.url } }));
    const toolbar = screen.getByRole("toolbar", { name: "Text selection actions" });
    expect(within(toolbar).getByRole("button", { name: "Quote" })).toBeInTheDocument();
    expect(screen.queryByTestId("browser-ai-side-chat")).not.toBeInTheDocument();
    fireEvent.click(within(toolbar).getByRole("button", { name: "Ask in side chat" }));
    expect(screen.getByTestId("browser-ai-side-chat")).toHaveTextContent("Active page quote");
    expect(screen.queryByRole("toolbar", { name: "Text selection actions" })).not.toBeInTheDocument();
    expect(useWorkspaceStore.getState().activeRun).toBeNull();
  });

  it("quotes an actual assistant text selection but not a user-message selection", () => {
    const onPromptChange = vi.fn();
    const props = createProps({ onPromptChange, messages: [
      { id: "assistant", role: "assistant", text: "Select this answer", timestamp: "Now" },
      { id: "user", role: "user", text: "Do not expose actions here", timestamp: "Now" },
    ] });
    const { container } = render(<SovereignBrowserAiSidebar {...props} />);
    const selected = window.getSelection()!;
    const user = screen.getByText("Do not expose actions here");
    const userRange = document.createRange(); userRange.selectNodeContents(user); selected.addRange(userRange);
    fireEvent(document, new Event("selectionchange"));
    expect(screen.queryByRole("toolbar", { name: "Text selection actions" })).not.toBeInTheDocument();
    selected.removeAllRanges();
    const answer = container.querySelector("[data-browser-assistant-text] p")!;
    const range = document.createRange(); range.selectNodeContents(answer); selected.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(onPromptChange).toHaveBeenCalledWith("> Select this answer\n\n");
    expect(screen.queryByRole("toolbar", { name: "Text selection actions" })).not.toBeInTheDocument();
  });

  it("uses @all-tabs only after the user chooses it, passing that scope to the real send callback", async () => {
    const onSend = vi.fn();
    render(<SovereignBrowserAiSidebar {...createProps({ prompt: "Compare these pages", onSend })} />);
    expect(screen.getByTestId("browser-ai-context-chip")).toHaveTextContent("@active-tab");
    fireEvent.click(screen.getByTestId("browser-ai-context-chip"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "@all-tabs" }));
    expect(screen.getByTestId("browser-ai-context-chip")).toHaveTextContent("@all-tabs");
    fireEvent.click(screen.getByTestId("browser-copilot-send-btn"));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ includeAllTabs: true }));
    expect(useWorkspaceStore.getState().activeRun).toBeNull();
  });

  it("shares the interactive slash popover and does not send while accepting a command", () => {
    const onSend = vi.fn();
    render(<ControlledSidebar props={createProps({ onSend })} />);
    const input = screen.getByTestId("browser-copilot-prompt-input");
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).not.toHaveValue("/");
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("renders safe highlighted Markdown and collapsed vertical execution rows without metadata badges", () => {
    const { container } = render(<SovereignBrowserAiSidebar {...createProps({ messages: [{
      id: "answer", role: "assistant", timestamp: "Now", text: "```typescript src/App.tsx:1-2\nconst count: number = 12; // safe\nconsole.log(\"hello\");\n```",
      steps: [{ id: "thought", label: "Thought for 2s", status: "completed", content: "Consider page evidence." }, { id: "read", label: "Read @active-tab", status: "completed", content: "Captured page text." }],
    }] })} />);
    const rows = container.querySelectorAll(".ai-steps details");
    expect(rows).toHaveLength(2);
    rows.forEach((row) => expect(row).not.toHaveAttribute("open"));
    expect(container.querySelector(".kw")).toBeInTheDocument();
    expect(container.querySelector(".num")).toBeInTheDocument();
    expect(screen.queryByText(/Local page action|Chat thread/)).not.toBeInTheDocument();
  });

  it("keeps utility drawers available with the AI panel closed and supports Escape dismissal", () => {
    const onUtilityClose = vi.fn();
    render(<SovereignBrowserAiSidebar {...createProps({ isOpen: false, utility: "profiles", onUtilityClose })} />);
    expect(screen.queryByTestId("browser-ai-copilot-sidebar")).not.toBeInTheDocument();
    const drawer = screen.getByRole("dialog", { name: "Browser profile" });
    expect(drawer).toHaveFocus();
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(onUtilityClose).toHaveBeenCalledOnce();
  });
  it("keeps preview attachment chips honest and never dispatches or silently drops them", async () => {
    const onSend = vi.fn();
    render(<SovereignBrowserAiSidebar {...createProps({ prompt: "Use this file", onSend })} />);
    fireEvent.change(screen.getByLabelText("Attach files to Browser AI"), { target: { files: [new File(["const x = 1"], "App.tsx", { type: "text/plain" })] } });
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    const remove = screen.getByRole("button", { name: "Remove App.tsx" });
    expect(remove.querySelector("svg")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("browser-copilot-send-btn"));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId("browser-ai-action-status")).toHaveTextContent("preview-only");
    fireEvent.click(remove);
    fireEvent.click(screen.getByTestId("browser-copilot-send-btn"));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  });

  it("saves a separate side-chat draft in preview without changing the main chat or fabricating a reply", async () => {
    const props = createProps();
    const mainId = useWorkspaceStore.getState().activeConversationId;
    const mainBefore = useWorkspaceStore.getState().conversations.find((item) => item.id === mainId)!;
    render(<SovereignBrowserAiSidebar {...props} />);
    fireEvent(window, new CustomEvent("omnia:browser-selection", { detail: { text: "Selected page evidence", url: props.activeTab.url } }));
    fireEvent.click(screen.getByRole("button", { name: "Ask in side chat" }));
    const side = screen.getByTestId("browser-ai-side-chat");
    fireEvent.change(within(side).getByLabelText("Side chat message"), { target: { value: "Explain this evidence" } });
    fireEvent.click(within(side).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(side).toHaveTextContent("Saved to the side chat draft"));
    const current = useWorkspaceStore.getState();
    expect(current.activeConversationId).toBe(mainId);
    const mainAfter = current.conversations.find((item) => item.id === mainId)!;
    expect(mainAfter.draft).toBe(mainBefore.draft);
    expect(mainAfter.messages).toEqual(mainBefore.messages);
    const sideConversation = current.conversations.find((item) => item.id !== mainId && item.title === "Side chat")!;
    expect(sideConversation.draft).toContain("Selected page evidence");
    expect(sideConversation.draft).toContain("Explain this evidence");
    expect(sideConversation.messages).toEqual([]);
    expect(current.activeRun).toBeNull();
  });

});
