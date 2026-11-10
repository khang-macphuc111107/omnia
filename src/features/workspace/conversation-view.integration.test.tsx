import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationView, conversationMessageSteps } from "./conversation-view";
import type { RunTimelineEventView } from "./evidence-types";
import { useWorkspaceStore } from "./store";
import * as desktopModule from "@/lib/desktop";
import type { PrepareConversationRunRequest, PreparedConversationRun, RunStreamEvent } from "@/lib/desktop";
import { stopRunEventJournalBuffer } from "./run-event-broker";
import type {
  AttachmentView,
  ChatMessage,
  ConversationView as ConversationViewModel,
  ProviderView,
} from "./types";

const initialState = useWorkspaceStore.getState();

function conversation(
  overrides: Partial<ConversationViewModel> = {},
): ConversationViewModel {
  return {
    id: "conversation-integration",
    activeBranchId: "branch-integration",
    title: "Integration Chat",
    excerpt: "Conversation shell wiring",
    updatedAt: "2026-09-19T00:00:00.000Z",
    updatedLabel: "Now",
    projectId: null,
    projectName: null,
    pinned: false,
    archived: false,
    hasDraft: false,
    unread: false,
    runState: null,
    draft: "",
    messages: [],
    ...overrides,
  };
}

function message(
  role: ChatMessage["role"],
  id: string,
  content: string,
  attachments: AttachmentView[] = [],
): ChatMessage {
  return {
    id,
    role,
    content,
    createdAt: "2026-09-19T00:00:00.000Z",
    status: "complete",
    modelLabel: role === "assistant" ? "Integration model" : null,
    runId: role === "assistant" ? "run-integration" : null,
    attachments,
    branchIndex: 1,
    branchCount: 1,
  };
}

describe("ConversationView integration wiring", () => {
  beforeEach(() => {
    stopRunEventJournalBuffer();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    stopRunEventJournalBuffer();
    vi.restoreAllMocks();
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("renders the populated conversation shell with its transcript and composer but no inspector or debug workbench", async () => {
    const active = conversation({
      messages: [
        message("user", "message-integration-user", "Explain the integration boundary."),
        message("assistant", "message-integration-assistant", "The renderer boundary is explicit."),
      ],
    });
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
      inspectorOpen: false,
    });

    render(<ConversationView />);

    expect(screen.getByRole("heading", { name: "Integration Chat" })).toBeInTheDocument();
    expect(
      screen.getByRole("feed", { name: "Integration Chat messages" }),
    ).toHaveTextContent("Explain the integration boundary.");
    expect(await screen.findByText("The renderer boundary is explicit.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Chat workbench" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /inspector/i })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Message composer" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Message Omnia" })).toHaveValue("");
  });

  it("keeps renderer-local media previews separate from native metadata-only attachments", () => {
    const active = conversation({
      messages: [
        message("user", "message-attachment-preview", "Review these files.", [
          {
            id: "attachment-preview-image",
            name: "diagram.png",
            kind: "image",
            mediaType: "image/png",
            previewUrl: "blob:diagram-preview",
            previewType: "image",
            size: "2.4 MB",
            state: "ready",
          },
          {
            id: "attachment-native-image",
            name: "native-photo.png",
            kind: "image",
            mediaType: "image/png",
            size: "1.1 MB",
            state: "ready",
          },
        ]),
      ],
    });
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
      inspectorOpen: false,
    });

    render(<ConversationView />);

    expect(screen.getByRole("img", { name: "Preview of diagram.png" })).toHaveAttribute(
      "src",
      "blob:diagram-preview",
    );
    expect(screen.getByLabelText(/native-photo\.png, 1\.1 MB/i)).toHaveAttribute(
      "title", "native-photo.png. File content is unavailable in this preview.",
    );
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("keeps the empty selected Chat starter and composer in the same renderer projection", () => {
    const active = conversation();
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
      inspectorOpen: false,
    });

    render(<ConversationView />);

    expect(screen.getByText("What are we working on?")).toBeInTheDocument();
    expect(screen.getByText("Ask a question or describe what you want to build.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Insert chat starter: Plan a project" }));

    expect(useWorkspaceStore.getState().conversations[0]?.draft).toBe(
      "Plan a project: ",
    );
    expect(screen.getByRole("combobox", { name: "Message Omnia" })).toHaveValue(
      "Plan a project: ",
    );
  });

  it("resets the transcript scroll when switching between Chats", async () => {
    const first = conversation({
      id: "conversation-scrolled",
      title: "Scrolled Chat",
      messages: [message("assistant", "scrolled-message", "A long response")],
    });
    const second = conversation({
      id: "conversation-empty",
      title: "Empty Chat",
    });
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    useWorkspaceStore.setState({
      activeConversationId: first.id,
      conversations: [first, second],
      providers: [],
      inspectorOpen: false,
    });

    render(<ConversationView />);
    const timeline = screen.getByRole("feed", { name: "Scrolled Chat messages" });
    timeline.scrollTop = 240;

    useWorkspaceStore.getState().selectConversation(second.id);

    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Chat entry" })).toBeInTheDocument();
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: "auto" });
  });

  it("keeps inspector controls absent even when older renderer state has the inspector open", () => {
    const active = conversation({
      messages: [message("user", "message-inspector", "Open the inspector.")],
    });
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
      inspectorOpen: true,
    });

    render(<ConversationView />);

    expect(screen.queryByRole("button", { name: /inspector/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Workbench")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Side chat" })).not.toBeInTheDocument();
  });

  it("keeps model selection solely in the composer instead of repeating a route badge in the header", () => {
    const active = conversation({
      messages: [message("user", "message-model-route", "Open model route controls.")],
    });
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
      inspectorOpen: false,
      inspectorTab: "context",
    });

    render(<ConversationView />);

    expect(screen.queryByTitle("Open model and route parameters")).not.toBeInTheDocument();
    expect(screen.getAllByRole("combobox", { name: "Model" })).toHaveLength(1);
  });

  it("exposes renderer-local message action previews in the browser conversation shell", () => {
    const active = conversation({
      messages: [
        message("user", "message-action-user", "Edit or branch this prompt."),
        message("assistant", "message-action-assistant", "Prepare a response action preview."),
      ],
    });
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
      inspectorOpen: false,
    });

    render(<ConversationView />);

    expect(screen.getByRole("button", { name: "Edit and branch preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Branch from here preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate response preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Read aloud preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as artifact preview" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Read aloud preview" }));
    expect(screen.getByRole("dialog", { name: "Read aloud" })).toBeInTheDocument();
    expect(screen.getByText(/no audio upload/i)).toBeInTheDocument();
  });

  it("navigates only among visible branch messages and keeps branch activation planned", () => {
    const active = conversation({
      messages: [
        message("user", "branch-user", "Compare the visible branch paths."),
        { ...message("assistant", "branch-one", "First visible path."), branchIndex: 1, branchCount: 4 },
        { ...message("assistant", "branch-three", "Third visible path."), branchIndex: 3, branchCount: 4 },
      ],
    });
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
      inspectorOpen: false,
    });

    render(<ConversationView />);

    const nextBranchButtons = screen.getAllByRole("button", { name: "Next visible branch" });
    expect(nextBranchButtons[0]).toBeEnabled();
    expect(nextBranchButtons[1]).toBeDisabled();
    fireEvent.click(nextBranchButtons[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "Open branch map" })[0]!);

    const dialog = screen.getByRole("dialog", { name: "Conversation branch map" });
    expect(within(dialog).getByText(/Inspect only scrolls to a visible message/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Native branch activation is unavailable/i)).toBeInTheDocument();
    const activeBranch = within(dialog).getByText("Branch 3").closest("[role='listitem']");
    expect(activeBranch).toHaveTextContent("Current path");
    expect(useWorkspaceStore.getState().conversations[0]?.activeBranchId).toBe("branch-integration");
  });

  it("keeps browser branch metadata inspectable instead of rendering a dead disabled selector", () => {
    vi.spyOn(desktopModule, "isDesktopRuntime").mockReturnValue(false);
    const active = conversation({
      nativeBranches: [
        { id: "branch-integration", name: null, parentBranchId: null, forkedFromMessageId: null, createdAtMs: 1 },
        { id: "branch-alternative", name: "Alternative route", parentBranchId: "branch-integration", forkedFromMessageId: null, createdAtMs: 2 },
      ],
    });
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      providers: [],
      inspectorOpen: false,
    });

    render(<ConversationView />);

    const previewButton = screen.getByRole("button", { name: "Open branch map preview" });
    expect(previewButton).toBeEnabled();
    fireEvent.click(previewButton);

    const dialog = screen.getByRole("dialog", { name: "Conversation branch map" });
    expect(within(dialog).getByText("Alternative route")).toBeInTheDocument();
    expect(within(dialog).getByText("Preview metadata")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Preview only").length).toBeGreaterThan(0);
  });

  it("exposes native Chat branch activation from the toolbar selector", async () => {
    vi.spyOn(desktopModule, "isDesktopRuntime").mockReturnValue(true);
    const active = conversation({
      nativeBranches: [
        { id: "branch-integration", name: null, parentBranchId: null, forkedFromMessageId: null, createdAtMs: 1 },
        { id: "branch-alternative", name: "Alternative route", parentBranchId: "branch-integration", forkedFromMessageId: null, createdAtMs: 2 },
      ],
    });
    const activate = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({
      activeConversationId: active.id,
      conversations: [active],
      activateConversationBranch: activate,
      providers: [],
      inspectorOpen: false,
    });

    render(<ConversationView />);

    const selector = screen.getByRole("combobox", { name: "Active Chat branch" });
    expect(selector).toBeEnabled();
    expect(within(screen.getByTestId("conversation-branch-selector")).getByText("Branch")).toBeInTheDocument();
    fireEvent.change(selector, { target: { value: "branch-alternative" } });

    await waitFor(() => expect(activate).toHaveBeenCalledWith("branch-alternative"));
    expect(screen.getByText("Chat branch switched.")).toBeInTheDocument();
  });

  it("removes the complete assistant model and verification metadata row", async () => {
    const active = conversation({ messages: [{
      ...message("assistant", "quiet-answer", "A useful answer without noisy chrome."),
      modelLabel: "gpt-6.1-sol · ultra · Anthropic/OpenAI Cache Harness · Verified: Math & Citations Pass",
    }] });
    useWorkspaceStore.setState({ activeConversationId: active.id, conversations: [active], providers: [] });
    render(<ConversationView />);
    expect(await screen.findByText("A useful answer without noisy chrome.")).toBeInTheDocument();
    expect(document.querySelector(".assistant-message__header")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Cache Harness|Verified: Math|ultra/);
    expect(screen.queryByRole("button", { name: /Quote Selection|Spawn Verifier|Ask in \/btw/i })).not.toBeInTheDocument();
  });

  it("quotes exactly the selected assistant text into the existing draft without opening a side panel", async () => {
    const active = conversation({ draft: "Keep my draft.", messages: [message("assistant", "select-answer", "Selected assistant text, not the whole message.")] });
    useWorkspaceStore.setState({ activeConversationId: active.id, conversations: [active], providers: [] });
    render(<ConversationView />);
    const paragraph = await waitFor(() => {
      const node = screen.getByText("Selected assistant text, not the whole message.");
      expect(node.closest(".assistant-selection-content")).not.toBeNull();
      return node;
    });
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 0);
    range.setEnd(paragraph.firstChild!, 23);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(paragraph);
    fireEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(screen.getByRole("combobox", { name: "Message Omnia" })).toHaveValue("Keep my draft.\n\n> Selected assistant text\n\n");
    expect(screen.queryByRole("complementary", { name: "Side chat" })).not.toBeInTheDocument();
  });

  it("opens a clean Side chat drawer only after a real assistant text selection and fails closed in browser preview", async () => {
    const active = conversation({ messages: [message("assistant", "side-answer", "Discuss this selected passage.")] });
    useWorkspaceStore.setState({ activeConversationId: active.id, conversations: [active], providers: [] });
    render(<ConversationView />);
    expect(screen.queryByRole("complementary", { name: "Side chat" })).not.toBeInTheDocument();
    const paragraph = await waitFor(() => {
      const node = screen.getByText("Discuss this selected passage.");
      expect(node.closest(".assistant-selection-content")).not.toBeNull();
      return node;
    });
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(paragraph);
    fireEvent.click(screen.getByRole("button", { name: "Ask in side chat" }));
    const drawer = screen.getByRole("complementary", { name: "Side chat" });
    expect(within(drawer).getByRole("textbox", { name: "Message side chat" })).toHaveAttribute("placeholder", "Ask anything...");
    expect(drawer).toHaveTextContent("Discuss this selected passage.");
    expect(drawer.textContent).not.toMatch(/cache|DFS|verifier|\/btw/i);
    fireEvent.change(within(drawer).getByRole("textbox", { name: "Message side chat" }), { target: { value: "Please explain." } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Send" }));
    expect(await within(drawer).findByRole("alert")).toHaveTextContent("Open Omnia desktop to send messages.");
    expect(useWorkspaceStore.getState().conversations).toHaveLength(1);
    fireEvent.click(within(drawer).getByRole("button", { name: "Close side chat" }));
    expect(screen.queryByRole("complementary", { name: "Side chat" })).not.toBeInTheDocument();
  });

  it("submits a separate durable Side chat through native preparation without replacing the main transcript or draft", async () => {
    vi.spyOn(desktopModule, "isDesktopRuntime").mockReturnValue(true);
    const active = conversation({ draft: "Keep the main draft.", messages: [message("assistant", "native-side-answer", "A selected source passage.")] });
    const provider: ProviderView = {
      id: "side-provider", name: "Configured provider", kind: "OpenAI-compatible", providerType: "openai-compatible", endpoint: "http://127.0.0.1:9999/v1", authScheme: "none", state: "connected", modelCount: 1,
      enabled: true, credentialState: "not-required", source: "native", organizationId: null, remoteProjectId: null, lastCheckedAt: null, latencyMs: null, errorMessage: null,
      models: [{ id: "side-model", connectionId: "side-provider", displayName: "Configured model", providerName: "Configured provider", providerModelId: "configured-model", status: "available", capabilities: ["reasoning", "tools"], contextLabel: "Reported", speed: "Thorough", favorite: false }],
    };
    useWorkspaceStore.setState({ activeConversationId: active.id, conversations: [active], providers: [provider], modelProfileId: "side-model", attachments: [], activeRun: null, draftAttachmentIdsByConversation: {} });
    const now = Date.parse("2026-10-19T00:00:00.000Z");
    const snapshot: PreparedConversationRun["conversation"] = {
      conversation: { id: "separate-side-chat", projectId: null, title: "Side chat", activeBranchId: "side-branch", pinnedAtMs: null, archivedAtMs: null, createdAtMs: now, updatedAtMs: now },
      branches: [{ id: "side-branch", conversationId: "separate-side-chat", parentBranchId: null, forkedFromMessageId: null, name: null, createdAtMs: now }], messages: [], runs: [], attempts: [],
    };
    let onNativeEvent: ((event: RunStreamEvent) => void) | undefined;
    vi.spyOn(desktopModule.desktop, "onRunEvent").mockImplementation(async (callback) => { onNativeEvent = callback; return () => undefined; });
    const create = vi.spyOn(desktopModule.desktop, "createConversation").mockResolvedValue(snapshot);
    const prepare = vi.spyOn(desktopModule.desktop, "prepareConversationRun").mockImplementation(async (request: PrepareConversationRunRequest): Promise<PreparedConversationRun> => {
      const base = { conversationId: request.conversationId, branchId: request.branchId, replacesMessageId: null, finishReason: null, createdAtMs: now, updatedAtMs: now, finalizedAtMs: null };
      return {
        providerInput: { id: "side-frozen-input", attemptId: request.attemptId, runId: request.runId, providerProfileId: request.providerProfileId, model: request.model, contentSha256: "a".repeat(64), messageCount: 2, createdAtMs: now },
        conversation: { ...snapshot, messages: [
          { ...base, id: request.userMessageId, parentMessageId: null, role: "user", status: "complete", sequenceNo: 0, contentText: request.prompt, providerProfileId: null, modelId: null },
          { ...base, id: request.assistantMessageId, parentMessageId: request.userMessageId, role: "assistant", status: "draft", sequenceNo: 1, contentText: "", providerProfileId: request.providerProfileId, modelId: request.model },
        ], runs: [{ id: request.runId, conversationId: request.conversationId, branchId: request.branchId, userMessageId: request.userMessageId, assistantMessageId: request.assistantMessageId, providerProfileId: request.providerProfileId, modelId: request.model, state: "queued", errorCode: null, startedAtMs: null, completedAtMs: null, createdAtMs: now }] },
      };
    });
    const dispatch = vi.spyOn(desktopModule.desktop, "startPreparedAttempt").mockResolvedValue(undefined);
    render(<ConversationView />);
    const paragraph = await waitFor(() => { const node = screen.getByText("A selected source passage."); expect(node.closest(".assistant-selection-content")).not.toBeNull(); return node; });
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(paragraph);
    fireEvent.click(screen.getByRole("button", { name: "Ask in side chat" }));
    const drawer = screen.getByRole("complementary", { name: "Side chat" });
    fireEvent.change(within(drawer).getByRole("textbox", { name: "Message side chat" }), { target: { value: "Explain it." } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledExactlyOnceWith(undefined, "Side chat");
    const request = prepare.mock.calls[0]![0];
    expect(request).toMatchObject({ conversationId: "separate-side-chat", branchId: "side-branch", prompt: "Question about this selection:\n\n> A selected source passage.\n\nExplain it.", providerProfileId: "side-provider", model: "configured-model" });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ attemptId: request.attemptId, frozenProviderInputId: "side-frozen-input" });
    expect(useWorkspaceStore.getState().activeConversationId).toBe(active.id);
    expect(screen.getByRole("combobox", { name: "Message Omnia" })).toHaveValue("Keep the main draft.");
    expect(screen.getByRole("feed", { name: "Integration Chat messages" })).toHaveTextContent("A selected source passage.");
    act(() => onNativeEvent?.({ type: "delta", runId: request.runId, sequence: 1, text: "A genuine streamed side response." }));
    expect(await within(drawer).findByText("A genuine streamed side response.")).toBeInTheDocument();
    expect(useWorkspaceStore.getState().conversations.find((item) => item.id === active.id)?.messages).toHaveLength(1);
  });
});

describe("Chat Thinking and Command projection", () => {
  const event = (id: string, sequence: number, type: string, summary: string, overrides: Partial<RunTimelineEventView> = {}): RunTimelineEventView => ({
    id, runId: "run-integration", parentEventId: null, sequence, type, stage: "provider", status: "complete", summary, detail: null,
    startedAt: "2026-10-19T00:00:00.000Z", endedAt: "2026-10-19T00:00:04.000Z", source: "provider", providerLabel: null, attemptOrdinal: null, citationIds: [], ...overrides,
  });

  it("keeps useful steps separate and never surfaces backend, topology, cache or verifier summaries", () => {
    const steps = conversationMessageSteps(message("assistant", "steps-answer", "Done."), [
      event("think", 1, "message.reasoning_summary_delta", "Reasoning update received"),
      event("read", 2, "tool.read", "Read src/App.tsx (lines 4–12)"),
      event("edit", 3, "tool.edit", "Edited src/App.tsx (+18 -4)"),
      event("internal", 4, "tool.execution", "Ran builtin_numeric_claim_verifier · 28.4k cached"),
      event("route", 5, "attempt.accepted", "Provider accepted request", { detail: "Profile: local-secret-route" }),
      event("cache-file", 6, "tool.read", "Read src/cache.ts"),
      event("dfs-file", 7, "tool.read", "Read src/dfs.ts"),
    ]);
    expect(steps.map((step) => step.label)).toEqual(["Thought for 4s", "Read src/App.tsx (lines 4–12)", "Edited src/App.tsx (+18 -4)", "Read src/cache.ts", "Read src/dfs.ts"]);
    expect(steps.every((step) => step.status === "completed")).toBe(true);
    expect(JSON.stringify(steps)).not.toMatch(/cached|verifier|local-secret|Provider/);
  });

  it("marks only current real running work active and folds every terminal step", () => {
    const timeline = [
      event("think", 1, "message.reasoning_summary_delta", "Reasoning update received", { status: "running" }),
      event("read", 2, "tool.read", "Reading src/App.tsx...", { status: "running" }),
    ];
    const activeMessage = { ...message("assistant", "running-steps", ""), status: "streaming" as const };
    expect(conversationMessageSteps(activeMessage, timeline).filter((step) => step.status === "running").map((step) => step.id)).toEqual(["read"]);
    expect(conversationMessageSteps({ ...activeMessage, status: "stopped" }, timeline).some((step) => step.status === "running")).toBe(false);
    expect(conversationMessageSteps(message("assistant", "unobserved", "Done."), [])).toEqual([]);
  });
});
