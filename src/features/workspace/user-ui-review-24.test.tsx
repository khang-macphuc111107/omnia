import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Workspace } from "@/labs/labs-app";
import type { AppRuntimeInfo } from "@/lib/desktop";

import { ActivityRail } from "./activity-rail";
import { AiPanelComposer } from "./ai-panel-composer";
import { CollapsibleAiSteps } from "./collapsible-ai-steps";
import { ChatComposer } from "./composer";
import { ConversationScopeHeader } from "./conversation-scope-header";
import { ConversationView } from "./conversation-view";
import { MessageMarkdown } from "./markdown";
import { initialProjects } from "./mock-data";
import { ObjectSidebar } from "./sidebar";
import { SovereignBrowserWorkbench } from "./sovereign-browser-workbench";
import { SovereignIdeRemoteWorkbench } from "./sovereign-ide-remote-workbench";
import { useWorkspaceStore } from "./store";
import { TitleBar } from "./title-bar";
import type { ChatMessage, ConversationView as ConversationViewModel } from "./types";
import { setWorkspaceSurface } from "./workspace-mode-switcher";

const initialState = useWorkspaceStore.getState();
const forbiddenChrome = /Cache Hit|28,410 tok|28\.4k cached|Cache 94%|Local Cache Active|Omnia Local Prompt Cache|154\.2 tok\/s|150\+ tok\/s|Harness: Custom|DFS: 4 Nodes|PRE-ORDER DFS SESSION DAG|parallel subagents \(A|Local Cache Proxy|Anthropic\/OpenAI Cache Harness|9 Official Harnesses Ready|Verified: Math & Citations Pass|builtin_numeric_claim_verifier|ANTI-HALLUCINATION AUDIT|Local: Qwen2\.5-7B|LOCAL SOVEREIGN AI|Patched VS Code|omnia\.code-workspace \(Multi-Root|Stealth: Turnstile Pass|Browser Use Ready|Isolated 2nd Input Ready|10x Human-Seek Pacing|HOST BROWSER PROFILE & COOKIE BRIDGE|ULTRA IDM\+ & CLOUD\/PDF GRABBER|Ask in \/btw|@all-3-tabs/i;
const reviewTitle = "Native SSE Chunk Coalescing & Multi-Root Architecture";
const project = { ...initialProjects[0]!, id: "review-project", name: "omnia-core", conversationCount: 2 };
const runtime: AppRuntimeInfo = { appName: "Omnia", appVersion: "0.1.0", platform: "web", tauri: false, debug: true };

function conversation(overrides: Partial<ConversationViewModel> = {}): ConversationViewModel {
  return {
    id: "review-chat", activeBranchId: "review-branch", title: reviewTitle,
    excerpt: "A focused chat", updatedAt: "2026-10-19T00:00:00.000Z", updatedLabel: "Now",
    projectId: project.id, projectName: project.name, pinned: false, archived: false,
    hasDraft: false, unread: false, runState: null, draft: "", messages: [], ...overrides,
  };
}

function assistant(modelLabel: string | null = "gpt-6.1-sol · ultra · Anthropic/OpenAI Cache Harness"): ChatMessage {
  return {
    id: "review-assistant", role: "assistant", content: "A selected answer stays focused on your question.",
    createdAt: "2026-10-19T00:00:00.000Z", status: "complete", modelLabel, runId: null,
    attachments: [], branchIndex: 1, branchCount: 1,
  };
}

function seed(overrides: Partial<ConversationViewModel> = {}) {
  const chat = conversation(overrides);
  useWorkspaceStore.setState({
    ...initialState, activeActivity: "chats", activeConversationId: chat.id, activeProjectId: project.id,
    conversations: [chat, conversation({ id: "review-second-chat", title: "A second chat", activeBranchId: "review-second-branch" })],
    projects: [project], providers: [], activeRun: null, inspectorOpen: false, sidebarOpen: true,
    runTimelineEvents: [], draftAttachmentIdsByConversation: {}, attachments: [],
  }, true);
  return chat;
}

function iconButton(root: HTMLElement, title: string) {
  const button = within(root).getByRole("button", { name: title });
  expect(button).toHaveAttribute("title", title);
  expect(button.textContent?.trim()).toBe("");
  const svg = button.querySelector("svg");
  expect(svg).toHaveAttribute("aria-hidden", "true");
  expect(svg).toHaveAttribute("fill", "none");
  expect(svg).toHaveAttribute("stroke", "currentColor");
  // Pixel sizing and the final 1.75px stroke cascade are verified by the
  // Chromium suite; presentation attributes may be overridden by theme CSS.
  return button;
}

function PanelComposerHarness() {
  const [value, onChange] = useState("");
  return <AiPanelComposer value={value} onChange={onChange} onSend={vi.fn()} />;
}

describe("24-point screenshot review acceptance — Images 0 through 23", { timeout: 15000 }, () => {
  beforeEach(() => {
    window.localStorage?.clear?.();
    window.sessionStorage?.clear?.();
    delete window.__TAURI_INTERNALS__;
    setWorkspaceSurface("chat");
    seed();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    // Selection listeners and workspace subscribers must unmount before reset.
    cleanup();
    vi.restoreAllMocks();
    window.getSelection()?.removeAllRanges();
    act(() => {
      useWorkspaceStore.setState(initialState, true);
      setWorkspaceSurface("chat");
    });
  });

  it("Image 0: leaves only lock, URL and bookmark controls inside the omnibox", () => {
    render(<SovereignBrowserWorkbench />);
    const input = screen.getByTestId("omnibox-input");
    const omnibox = input.closest("form")!;
    expect(omnibox).toBeInTheDocument();
    expect(omnibox).not.toHaveTextContent(/Stealth|Turnstile|Cache|Chrome Canary/);
    expect(within(omnibox).getAllByRole("textbox")).toHaveLength(1);
    expect(within(omnibox).getAllByRole("button")).toHaveLength(1);
    expect(within(omnibox).getByRole("button", { name: /bookmark/i }).querySelector("svg")).toBeInTheDocument();
  });

  it("Image 1: presents one clean browser AI panel, @active-tab context and a Send composer", () => {
    render(<SovereignBrowserWorkbench />);
    // The browser AI panel is opt-in by default; open it deliberately.
    if (!screen.queryByTestId("browser-ai-copilot-sidebar")) fireEvent.click(screen.getByTestId("toggle-browser-ai-sidebar-btn"));
    const panel = screen.getByTestId("browser-ai-copilot-sidebar");
    expect(within(panel).queryAllByRole("tab")).toHaveLength(0);
    expect(panel).not.toHaveTextContent(forbiddenChrome);
    expect(panel).not.toHaveTextContent(/Active Tab \+|Multi-Tab Synthesis/);
    expect(within(panel).getByPlaceholderText("Ask anything...")).toBeInTheDocument();
    expect(within(panel).getByText("@active-tab", { exact: true })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /^Run(?: \(↵\))?$/ })).not.toBeInTheDocument();
    iconButton(panel, "New chat");
    iconButton(panel, "Chat history");
    expect(within(panel).queryByRole("button", { name: "Ask in side chat" })).not.toBeInTheDocument();
  });

  it("Image 2: reveals profile/cookie controls only after the compact profile button is clicked", () => {
    const { container } = render(<SovereignBrowserWorkbench />);
    const profile = iconButton(container, "Browser profile (click to switch profile or import cookies)");
    expect(profile).not.toHaveTextContent(/Chrome Canary|●/);
    expect(screen.queryByRole("combobox", { name: "Host browser profile" })).not.toBeInTheDocument();
    fireEvent.click(profile);
    const drawer = screen.getByRole("dialog", { name: "Browser profile" });
    expect(within(drawer).getByRole("combobox", { name: "Host browser profile" })).toBeInTheDocument();
  });

  it("Image 3: calls project conversations chats, including count, creation and search", () => {
    const { container } = render(<ObjectSidebar />);
    expect(screen.getByText("2 chats", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^New chat/ })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search chats" })).toHaveAttribute("placeholder", "Search chats...");
    expect(container).not.toHaveTextContent(/\bthreads?\b/i);
  });

  it("Image 4: removes topology, cache and throughput badges from the scope header", () => {
    const { container } = render(<ConversationScopeHeader conversation={conversation()} />);
    expect(container).not.toHaveTextContent(forbiddenChrome);
    expect(container.querySelectorAll(".cache-badge, .throughput-badge, .dfs-badge")).toHaveLength(0);
  });

  it("Image 5: keeps the top titlebar title-free with centered primary modes and window controls", () => {
    const { container } = render(<TitleBar />);
    expect(container).not.toHaveTextContent(project.name);
    expect(container).not.toHaveTextContent(reviewTitle);
    expect(screen.getByRole("group", { name: "Primary workspace mode" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Window controls" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /inspector|Copy.*URI/i })).not.toBeInTheDocument();
    expect(container.querySelector(".title-bar__center")?.querySelector('[data-testid="workspace-mode-switcher"]')).toBeInTheDocument();
  });

  it("Image 6: renders a folder SVG / chat breadcrumb rather than a separate project pill", () => {
    const { container } = render(<ConversationScopeHeader conversation={conversation()} />);
    const breadcrumb = screen.getByLabelText("Chat location");
    expect(breadcrumb).toHaveTextContent(project.name);
    expect(breadcrumb).toHaveTextContent(reviewTitle);
    expect(within(breadcrumb).getByText("/", { exact: true })).toBeInTheDocument();
    expect(breadcrumb.querySelector("svg")).toHaveAttribute("stroke", "currentColor");
    expect(container.querySelector(".conversation-scope-header__project-pill")).not.toBeInTheDocument();
  });

  it("Image 7: exposes Copy Session URI only inside a chat item context menu", () => {
    const { container } = render(<><TitleBar /><ConversationScopeHeader conversation={conversation()} /><ObjectSidebar /></>);
    expect(container).not.toHaveTextContent(/omnia:\/\/sessions\//);
    expect(screen.queryByRole("menuitem", { name: "Copy Session URI" })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Open Chat actions menu" })[0]!);
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Copy Session URI" })).toBeInTheDocument();
  });

  it("Image 8: unmounts the Chat right inspector even if persisted inspector preference is open", () => {
    useWorkspaceStore.setState({ inspectorOpen: true });
    const { container } = render(<Workspace runtime={runtime} />);
    expect(container.querySelector(".activity-rail")).toBeInTheDocument();
    expect(container.querySelector(".object-sidebar")).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "Conversation" })).toBeInTheDocument();
    expect(container.querySelector(".context-inspector")).not.toBeInTheDocument();
    expect(container.querySelector(".global-status-strip")).not.toBeInTheDocument();
    expect(screen.queryByText("Side chat", { exact: true })).not.toBeInTheDocument();
  });

  it("Image 9: omits the local-cache proxy footer and green status dot", () => {
    const { container } = render(<ObjectSidebar />);
    expect(container).not.toHaveTextContent(/Local Cache Proxy|127\.0\.0\.1:52535|●/);
    expect(container.querySelector(".sidebar-cache-status")).not.toBeInTheDocument();
  });

  it("Image 10: uses removable file SVG chips with a separate line-range badge, never fake context", () => {
    const remove = vi.fn();
    const { container } = render(<AiPanelComposer value="" onChange={vi.fn()} onSend={vi.fn()} attachments={[
      { id: "source", label: "provider_gateway.rs", kind: "file", lineRange: ":864-898", onRemove: remove },
    ]} />);
    expect(screen.getByText("provider_gateway.rs", { exact: true })).toBeInTheDocument();
    expect(screen.getByText(":864-898", { exact: true })).toBeInTheDocument();
    const removeButton = screen.getByRole("button", { name: /Remove provider_gateway\.rs/ });
    expect(removeButton.querySelector("svg")).toHaveAttribute("stroke", "currentColor");
    expect(removeButton.textContent?.trim()).toBe("");
    expect(container).not.toHaveTextContent(/@workspace:omnia-core|\/btw ready/);
    fireEvent.click(removeButton);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("Image 11: Chat uses exactly Ask anything... and Tab selects a real slash command", () => {
    render(<ChatComposer />);
    const input = screen.getByRole("combobox", { name: "Message Omnia" });
    expect(input).toHaveAttribute("placeholder", "Ask anything...");
    fireEvent.change(input, { target: { value: "/", selectionStart: 1, selectionEnd: 1 } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).not.toHaveValue("/");
    expect(useWorkspaceStore.getState().activeRun).toBeNull();
  });

  it("Image 12: shared side-panel slash popover supports arrows, Enter, click and Escape", () => {
    render(<PanelComposerHarness />);
    const input = screen.getByPlaceholderText("Ask anything...");
    const open = () => fireEvent.change(input, { target: { value: "/", selectionStart: 1, selectionEnd: 1 } });
    open();
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(1);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).not.toHaveValue("/");
    open();
    fireEvent.click(screen.getAllByRole("option")[1]!);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    open();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveValue("/");
  });

  it("Image 13: Chat footer contains only attachment, model, effort and Send controls", () => {
    const { container } = render(<ChatComposer />);
    const footer = container.querySelector(".composer-toolbar") as HTMLElement;
    expect(footer).toBeInTheDocument();
    expect(footer).not.toHaveTextContent(forbiddenChrome);
    expect(footer.querySelector(".model-status-dot")).not.toBeInTheDocument();
    iconButton(footer, "Attach files");
    expect(within(footer).getByTitle("Send")).toHaveTextContent("Send");
    expect(footer.querySelectorAll("button, select")).toHaveLength(4);
  });

  it.each([14, 15, 16])("Image %s: removes the complete assistant model/effort/harness/verification metadata row", async () => {
    seed({ messages: [assistant()] });
    const { container } = render(<ConversationView />);
    await screen.findByText("A selected answer stays focused on your question.");
    const message = container.querySelector("article.message--assistant") as HTMLElement;
    expect(message).toBeInTheDocument();
    expect(message).not.toHaveTextContent(/gpt-6\.1-sol|ultra|Cache Harness|Verified:|Math & Citations/);
    expect(message.querySelector(".assistant-message__header")).not.toBeInTheDocument();
    expect(container.querySelector(".assistant-model-badge, .verification-badge")).not.toBeInTheDocument();
  });

  it("Image 17: completed Thinking and command steps are separate collapsed vertical disclosures", () => {
    const { container } = render(<CollapsibleAiSteps steps={[
      { id: "thought", label: "Thought for 4s", content: "Consider the requested edit.", status: "completed" },
      { id: "read", label: "Read src-tauri/src/provider_gateway.rs (lines 860–916)", content: "File excerpt", status: "completed" },
      { id: "edit", label: "Edited src-tauri/src/provider_gateway.rs (+18 -4)", content: "Patch excerpt", status: "completed" },
    ]} />);
    const rows = container.querySelectorAll("details");
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).not.toHaveAttribute("open");
    expect(Array.from(rows, (row) => row.querySelector("summary")?.textContent)).toEqual([
      "Thought for 4s", "Read src-tauri/src/provider_gateway.rs (lines 860–916)", "Edited src-tauri/src/provider_gateway.rs (+18 -4)",
    ]);
    expect(container).not.toHaveTextContent(/parallel subagents|28\.4k cached|builtin_numeric_claim_verifier/);
  });

  it("Image 18: streaming auto-collapses previous steps and expands only the current running step", () => {
    const { container, rerender } = render(<CollapsibleAiSteps steps={[
      { id: "thought", label: "Thinking...", content: "Consider the change", status: "running" },
    ]} />);
    expect(container.querySelectorAll("details[open]")).toHaveLength(1);
    rerender(<CollapsibleAiSteps steps={[
      { id: "thought", label: "Thought for 4s", content: "Consider the change", status: "completed" },
      { id: "read", label: "Reading file...", content: "Current command", status: "running" },
    ]} />);
    expect(container.querySelectorAll("details[open]")).toHaveLength(1);
    expect(container.querySelector("details[open] summary")).toHaveTextContent("Reading file...");
    rerender(<CollapsibleAiSteps steps={[
      { id: "thought", label: "Thought for 4s", content: "Consider the change", status: "completed" },
      { id: "read", label: "Read src/App.tsx", content: "Current command", status: "completed" },
    ]} />);
    expect(container.querySelectorAll("details[open]")).toHaveLength(0);
  });

  it("Image 19: highlights safe code and offers exactly Open in IDE / Copy code icons", async () => {
    const code = '// Keep the payload inert\npub fn render(count: usize) -> String {\n    let total = 42;\n    format!("<script>alert(1)</script>", total)\n}';
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { container } = render(<MessageMarkdown content={`\`\`\`rust src-tauri/src/provider_gateway.rs:864-898\n${code}\n\`\`\``} />);
    const block = container.querySelector(".code-block") as HTMLElement;
    expect(block).toHaveTextContent("src-tauri/src/provider_gateway.rs:864-898");
    expect(within(block).getAllByRole("button")).toHaveLength(2);
    iconButton(block, "Open in IDE");
    const copy = iconButton(block, "Copy code");
    for (const kind of ["kw", "ty", "fn", "str", "cmt", "num"]) {
      expect(block.querySelector(`.${kind}`), `missing syntax token ${kind}`).toBeInTheDocument();
    }
    expect(block.querySelector("script")).not.toBeInTheDocument();
    expect(block.querySelector("code")?.textContent?.trimEnd()).toBe(code);
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
    expect(screen.queryByRole("button", { name: /Apply Patch|Spawn Verifier|Quote Selection|Ask in \/btw/i })).not.toBeInTheDocument();
  });

  it("Image 19 selection: Quote / Ask in side chat appear only for actual assistant text selection", async () => {
    seed({ messages: [assistant(null)] });
    render(<ConversationView />);
    // The Suspense fallback contains the same prose but has no selection
    // handlers. Wait for the actual selectable source, not its loading copy.
    let text!: HTMLElement;
    await waitFor(() => {
      text = screen.getByText("A selected answer stays focused on your question.");
      expect(text.closest('[data-selection-source-kind="assistant-message"]')).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Ask in side chat" })).not.toBeInTheDocument();
    fireEvent.mouseUp(text);
    expect(screen.queryByRole("button", { name: "Ask in side chat" })).not.toBeInTheDocument();
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(text);
    const ask = await screen.findByRole("button", { name: "Ask in side chat" });
    const toolbar = ask.closest('[role="toolbar"]') as HTMLElement;
    expect(toolbar).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: /^Quote(?: selection)?$/ })).toBeInTheDocument();
    fireEvent.click(within(toolbar).getByRole("button", { name: "Ask in side chat" }));
    expect(await screen.findByText("Side chat", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(/Ask in \/btw/)).not.toBeInTheDocument();
  });

  it("Image 20: retains icon-only monochrome navigation with labels and hover tooltips", () => {
    const { container } = render(<ActivityRail />);
    const controls = container.querySelectorAll<HTMLButtonElement>(".rail-button");
    expect(controls.length).toBeGreaterThan(2);
    for (const button of controls) {
      expect(button).toHaveAttribute("title");
      expect(button).toHaveAttribute("aria-label");
      expect(button.textContent?.trim()).toBe("");
      expect(button.querySelector("svg")).toHaveAttribute("stroke", "currentColor");
    }
  });

  it("Image 21: removes native host endpoint branding from IDE text, labels and tooltips", () => {
    const { container } = render(<SovereignIdeRemoteWorkbench />);
    expect(container).not.toHaveTextContent(/Patched VS Code|127\.0\.0\.1:1430/);
    for (const node of container.querySelectorAll("[title], [aria-label]")) {
      expect(`${node.getAttribute("title")} ${node.getAttribute("aria-label")}`).not.toMatch(/Patched VS Code|127\.0\.0\.1:1430/);
    }
    // The actual 1430 host iframe is exercised by the separate Chromium
    // runtime spec; JSDOM must not pretend that an embedded editor loaded.
  });

  it("Image 22: renders distinct blue, emerald and purple folder SVG project pills", () => {
    render(<SovereignIdeRemoteWorkbench />);
    const projects = screen.getByTestId("ide-project-pills");
    expect(projects).not.toHaveTextContent(/omnia\.code-workspace|Multi-Root/);
    expect(within(projects).getAllByRole("button")).toHaveLength(4);
    const colors = ["#60a5fa", "#34d399", "#a78bfa"];
    for (const [index, name] of ["omnia-app", "omnia-root", "codex-runtime"].entries()) {
      const pill = screen.getByTestId(`ide-project-pill-${index}`);
      expect(pill).toHaveTextContent(name);
      expect(pill.querySelector("svg")).toHaveAttribute("stroke", "currentColor");
      expect(pill.style.getPropertyValue("--project-accent")).toBe(colors[index]);
    }
    iconButton(projects, "Open project folder");
  });

  it("Image 23: renders one clean IDE coding panel without auxiliary tabs/debug decks", () => {
    render(<SovereignIdeRemoteWorkbench />);
    // The AI panel is opt-in (editor-first default); open it deliberately.
    fireEvent.click(screen.getByTestId("ide-toggle-agy-sidebar-btn"));
    const panel = screen.getByTestId("ide-agy-ai-sidebar");
    expect(within(panel).queryAllByRole("tab")).toHaveLength(0);
    expect(panel).not.toHaveTextContent(forbiddenChrome);
    expect(panel).not.toHaveTextContent(/HOST DISPLAYS|REMOTE INPUT|\/btw \/spawn \/verify/);
    iconButton(panel, "New chat");
    iconButton(panel, "Chat history");
    iconButton(panel, "Toggle AI sidebar");
    expect(within(panel).getByPlaceholderText("Ask anything...")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Send" })).toBeInTheDocument();
  });
});
