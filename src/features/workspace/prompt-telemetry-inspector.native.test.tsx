import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RendererUsageObservation, RunTelemetrySnapshot } from "@/lib/desktop";

import { createSamplePromptTelemetryRecord, PromptTelemetryInspector, TurnStudioActionsBar, TurnTelemetryHud } from "./prompt-telemetry-inspector";
import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";

const initialState = useWorkspaceStore.getState();
const RUN_ID = "run_observed";
const MESSAGE_ID = "message_observed";

function conversation(id = "conversation_observed", runId: string | null = RUN_ID): ConversationView {
  return {
    id,
    activeBranchId: `branch_${id}`,
    title: "Observed conversation",
    excerpt: "Observed answer",
    updatedAt: "2026-11-02T00:00:01.000Z",
    updatedLabel: "Now",
    projectId: null,
    projectName: null,
    pinned: false,
    archived: false,
    hasDraft: false,
    unread: false,
    runState: null,
    draft: "",
    messages: [{
      id: MESSAGE_ID,
      role: "assistant",
      content: "An answer has no implicit token or timing measurements.",
      createdAt: "2026-11-02T00:00:01.000Z",
      status: "complete",
      modelLabel: "gpt-6.1-sol · original route",
      runId,
      attachments: [],
      branchIndex: 1,
      branchCount: 1,
    }],
  };
}

function usage(overrides: Partial<RendererUsageObservation> = {}): RendererUsageObservation {
  return {
    sequence: 1,
    source: "provider-incremental",
    authoritative: false,
    coverage: "partial",
    observedAtMs: 1000,
    counters: {
      inputTokens: 21,
      cacheReadInputTokens: 5,
      cacheWriteInputTokens: null,
      outputTokens: 13,
      reasoningTokens: 3,
      visibleOutputTokens: null,
    },
    costStatementCount: 0,
    ...overrides,
  };
}

function telemetry(runId = RUN_ID): RunTelemetrySnapshot {
  return {
    schemaVersion: 1,
    runId,
    attempts: [{
      attemptId: "attempt_observed",
      ordinal: 1,
      providerProfileId: "provider_observed",
      modelId: "gpt-6.1-sol · original route",
      state: "complete",
      acceptedByProvider: "true",
      errorCode: null,
      startedAtMs: null,
      completedAtMs: null,
      createdAtMs: 1000,
      timingObservations: [],
      usageLedger: [usage()],
    }],
    readAtMs: 1500,
  };
}

function seed(observed = telemetry(), active = conversation()) {
  useWorkspaceStore.setState({
    activeConversationId: active.id,
    conversations: [active],
    runTelemetryByRunId: { [observed.runId]: observed },
  });
}

function expandHud(turnId = MESSAGE_ID) {
  fireEvent.click(screen.getByTestId(`turn-telemetry-hud-toggle-${turnId}`));
  return screen.getByTestId(`turn-telemetry-hud-details-${turnId}`);
}

describe("Prompt telemetry native evidence boundary", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ conversations: [], activeConversationId: "", runTelemetryByRunId: {} });
  });

  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState(initialState, true);
  });

  it("opens an empty inspector without implicit sample records or synthetic global totals", () => {
    render(<PromptTelemetryInspector defaultOpen />);

    const panel = screen.getByTestId("prompt-telemetry-inspector-panel");
    expect(panel).toHaveTextContent("No native telemetry is available for this conversation.");
    expect(panel).not.toHaveTextContent(/1840|14,200|310ms|Main Coordinator|Peer Verifier|rg --files|\$/);
    expect(within(panel).queryByRole("button", { name: /Global/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("prompt-telemetry-inspector-tokens")).not.toBeInTheDocument();
  });

  it("does not infer usage, cost, dates or timing from long messages", () => {
    const active = conversation("conversation_without_run", null);
    active.messages[0]!.content = "Response text ".repeat(10_000);
    active.messages[0]!.createdAt = "unavailable";
    active.messages.unshift({ ...active.messages[0]!, id: "message_user", role: "user", content: "Prompt ".repeat(10_000) });
    useWorkspaceStore.setState({ conversations: [active], activeConversationId: active.id });

    render(<><PromptTelemetryInspector defaultOpen /><TurnTelemetryHud turnId={MESSAGE_ID} promptText={active.messages[0]!.content} responseText={active.messages[1]!.content} createdAt="unavailable" /></>);

    const hud = screen.getByTestId(`turn-telemetry-hud-${MESSAGE_ID}`);
    expect(hud).toHaveAttribute("data-telemetry-status", "unavailable");
    expect(hud).not.toHaveTextContent(/TTFT|RPM|tok\/s|req|Agents|\$|2026/);
    expect(screen.getByTestId("prompt-telemetry-inspector-unavailable")).toBeInTheDocument();
  });

  it("does not attach stored run metrics to a local browser utility response", () => {
    seed();
    render(<TurnTelemetryHud turnId={`browser-local-${MESSAGE_ID}`} conversationId="conversation_observed" surface="browser-sidebar" responseText="Downloaded a local media file" />);

    const hud = screen.getByTestId(`turn-telemetry-hud-browser-local-${MESSAGE_ID}`);
    expect(hud).toHaveTextContent("Native telemetry unavailable for this turn.");
    expect(hud).not.toHaveTextContent(/245ms|130|2 req|2 Agents|Verifier|gpt|\$/);
    expect(within(hud).queryByRole("button")).not.toBeInTheDocument();
  });

  it("displays exact partial native counters, preserves unknowns and model route identity", () => {
    seed();
    render(<TurnTelemetryHud turnId={MESSAGE_ID} conversationId="conversation_observed" model="claude-opus-4-6" />);

    const hud = screen.getByTestId(`turn-telemetry-hud-${MESSAGE_ID}`);
    expect(hud).toHaveTextContent("gpt-6.1-sol · original route");
    expect(hud).toHaveTextContent("In 21 / Out 13 tokens");
    expect(hud).not.toHaveTextContent("claude");
    const details = expandHud();
    expect(within(details).getByTestId(`turn-telemetry-${MESSAGE_ID}-attempt_observed-cache`)).toHaveTextContent("Cache read: 5 · Cache write: Not reported");
    expect(within(details).getByTestId(`turn-telemetry-${MESSAGE_ID}-attempt_observed-reasoning`)).toHaveTextContent("Reasoning: 3 · Visible: Not reported");
    expect(details).toHaveTextContent("provider-incremental · partial · non-authoritative");
    expect(details).toHaveTextContent("Duration: Not reported · First provider output: Not reported · First visible output: Not reported");
    expect(details).toHaveTextContent("Not reported → Not reported");
    expect(details).toHaveTextContent("No native cost amount reported");
    expect(details).not.toHaveTextContent(/\$|RPM|rg --files|Coordinator|Verifier/);
  });

  it.each([
    ["ide-sidebar", `ide-${MESSAGE_ID}`],
    ["browser-sidebar", `browser-chat-${MESSAGE_ID}`],
  ] as const)("resolves the known %s durable message wrapper without selecting a nearby turn", (surface, turnId) => {
    seed();
    render(<TurnTelemetryHud turnId={turnId} surface={surface} />);
    expect(screen.getByTestId(`turn-telemetry-hud-${turnId}`)).toHaveTextContent("In 21 / Out 13 tokens");
  });

  it("prefers final provider counters over later incremental observations without adding snapshots", () => {
    const observed = telemetry();
    const final = usage({ sequence: 2, source: "provider-final", authoritative: true, coverage: "complete", counters: { ...usage().counters, inputTokens: 120, outputTokens: 44 } });
    observed.attempts[0]!.usageLedger = [usage(), final, usage({ sequence: 3, counters: { ...usage().counters, inputTokens: 999, outputTokens: 888 } })];
    seed(observed);
    render(<TurnTelemetryHud turnId={MESSAGE_ID} />);

    const hud = screen.getByTestId(`turn-telemetry-hud-${MESSAGE_ID}`);
    expect(hud).toHaveTextContent("In 120 / Out 44 tokens");
    expect(hud).not.toHaveTextContent(/999|888|141|57/);
    expect(expandHud()).toHaveTextContent("provider-final · complete · authoritative");
  });

  it("uses the latest correction rather than an invoice or older counter observation", () => {
    const observed = telemetry();
    observed.attempts[0]!.usageLedger = [
      usage({ sequence: 1, source: "user-correction", counters: { ...usage().counters, outputTokens: 70 } }),
      usage({ sequence: 2, source: "provider-final", counters: { ...usage().counters, outputTokens: 80 } }),
      usage({ sequence: 3, source: "user-correction", counters: { ...usage().counters, outputTokens: null }, authoritative: true }),
      usage({ sequence: 4, source: "provider-invoice", costStatementCount: 1 }),
    ];
    seed(observed);
    render(<TurnTelemetryHud turnId={MESSAGE_ID} />);

    expect(screen.getByTestId(`turn-telemetry-hud-${MESSAGE_ID}`)).toHaveTextContent("In 21 / Out Not reported tokens");
    const details = expandHud();
    expect(details).toHaveTextContent("user-correction");
    expect(details).toHaveTextContent("Native statement present; amount not reported");
    expect(details).not.toHaveTextContent("$");
  });

  it("keeps retries separate and labels attempt count without claiming requests or agents", () => {
    const observed = telemetry();
    observed.attempts.push({ ...observed.attempts[0]!, attemptId: "attempt_retry", ordinal: 2, modelId: "retry-model", usageLedger: [usage({ counters: { ...usage().counters, inputTokens: 7, outputTokens: 0 } })] });
    seed(observed);
    render(<TurnTelemetryHud turnId={MESSAGE_ID} />);

    expect(screen.getByTestId(`turn-telemetry-hud-${MESSAGE_ID}`)).toHaveTextContent("retry-model · Latest attempt 2 · complete · In 7 / Out 0 tokens");
    const details = expandHud();
    expect(details).toHaveTextContent("2 observed attempts");
    expect(within(details).getByTestId(`turn-telemetry-${MESSAGE_ID}-attempt_observed-tokens`)).toHaveTextContent("In: 21 · Out: 13");
    expect(within(details).getByTestId(`turn-telemetry-${MESSAGE_ID}-attempt_retry-tokens`)).toHaveTextContent("In: 7 · Out: 0");
    expect(details).not.toHaveTextContent(/2 req|2 Agents|28.*13/);
  });

  it("shows only recorded native timing marks and dates", () => {
    const observed = telemetry();
    const attempt = observed.attempts[0]!;
    attempt.startedAtMs = Date.parse("2026-11-02T00:00:00.000Z");
    attempt.completedAtMs = attempt.startedAtMs + 2000;
    attempt.timingObservations = [{
      observedAtMs: 3000,
      coverage: "partial",
      marks: { dispatchStartedMs: 100, requestCommittedMs: null, firstByteMs: null, firstProviderOutputMs: 450, firstReasoningMs: null, firstVisibleOutputMs: null, firstCompleteItemMs: null, lastVisibleOutputMs: null, terminalMs: 2100 },
      waits: { queueMs: null, contextCompileMs: null, approvalWaitMs: null, providerBackoffMs: null, toolWaitMs: null, rendererBackpressureMs: null },
    }];
    seed(observed);
    render(<PromptTelemetryInspector defaultOpen />);

    expect(screen.getByTestId("prompt-telemetry-inspector-attempt_observed-speed")).toHaveTextContent("Duration: 2.00s · First provider output: 350ms · First visible output: Not reported · partial");
    expect(screen.getByTestId("prompt-telemetry-inspector-attempt_observed-timestamps")).toHaveTextContent("2026-11-02 00:00:00.000");
  });

  it("does not borrow telemetry from another conversation or a conflicting explicit run", () => {
    seed();
    render(<TurnTelemetryHud turnId={MESSAGE_ID} conversationId="different_conversation" runId={RUN_ID} />);
    expect(screen.getByTestId(`turn-telemetry-hud-${MESSAGE_ID}`)).toHaveAttribute("data-telemetry-status", "unavailable");
    cleanup();

    const other = telemetry("run_other");
    useWorkspaceStore.setState({ runTelemetryByRunId: { [RUN_ID]: telemetry(), [other.runId]: other } });
    render(<TurnTelemetryHud turnId={MESSAGE_ID} conversationId="conversation_observed" runId={other.runId} />);
    expect(screen.getByTestId(`turn-telemetry-hud-${MESSAGE_ID}`)).toHaveAttribute("data-telemetry-status", "unavailable");
  });

  it("rejects ambiguous message ids and snapshots whose embedded run id differs from the lookup key", () => {
    const active = conversation();
    useWorkspaceStore.setState({ conversations: [active, conversation("other_conversation")], runTelemetryByRunId: { [RUN_ID]: telemetry() } });
    render(<TurnTelemetryHud turnId={MESSAGE_ID} />);
    expect(screen.getByTestId(`turn-telemetry-hud-${MESSAGE_ID}`)).toHaveAttribute("data-telemetry-status", "unavailable");
    cleanup();

    useWorkspaceStore.setState({ conversations: [active], runTelemetryByRunId: { [RUN_ID]: telemetry("wrong_run") } });
    render(<TurnTelemetryHud turnId={MESSAGE_ID} />);
    expect(screen.getByTestId(`turn-telemetry-hud-${MESSAGE_ID}`)).toHaveAttribute("data-telemetry-status", "unavailable");
  });

  it("rejects a wrapper alias collision and an explicit run on a known local message", () => {
    const active = conversation();
    active.messages.push({ ...active.messages[0]!, id: `ide-${MESSAGE_ID}`, runId: "run_alias_collision" });
    seed(telemetry(), active);
    render(<TurnTelemetryHud turnId={`ide-${MESSAGE_ID}`} surface="ide-sidebar" />);
    expect(screen.getByTestId(`turn-telemetry-hud-ide-${MESSAGE_ID}`)).toHaveAttribute("data-telemetry-status", "unavailable");
    cleanup();

    active.messages.push({ ...active.messages[0]!, id: "local_message", runId: null });
    seed(telemetry(), active);
    render(<TurnTelemetryHud turnId="local_message" conversationId={active.id} runId={RUN_ID} />);
    expect(screen.getByTestId("turn-telemetry-hud-local_message")).toHaveAttribute("data-telemetry-status", "unavailable");
  });

  it("scopes the production inspector to the selected conversation and clears stale run selection", () => {
    const active = conversation();
    const other = conversation("other_conversation", "run_other");
    useWorkspaceStore.setState({ conversations: [active, other], activeConversationId: other.id, runTelemetryByRunId: { [RUN_ID]: telemetry() } });
    const { rerender } = render(<PromptTelemetryInspector defaultOpen conversationId={active.id} />);
    expect(screen.getByTestId("prompt-telemetry-inspector-native-run")).toHaveTextContent(RUN_ID);
    rerender(<PromptTelemetryInspector defaultOpen conversationId={other.id} />);
    expect(screen.getByTestId("prompt-telemetry-inspector-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("prompt-telemetry-inspector-native-run")).not.toBeInTheDocument();
  });

  it("accepts an explicit exact run id without fabricating a conversation association", () => {
    const observed = telemetry();
    useWorkspaceStore.setState({ runTelemetryByRunId: { [RUN_ID]: observed } });
    render(<TurnTelemetryHud turnId="explicit-native-turn" runId={RUN_ID} />);
    expect(screen.getByTestId("turn-telemetry-hud-explicit-native-turn")).toHaveTextContent("In 21 / Out 13 tokens");
  });

  it("retains deliberate fixture records and global preview inputs", () => {
    const record = createSamplePromptTelemetryRecord({ model: "explicit-preview-model" });
    const another = createSamplePromptTelemetryRecord({ promptId: "explicit-second" });
    render(<PromptTelemetryInspector record={record} globalRecords={[record, another]} defaultOpen />);
    expect(screen.getByTestId("prompt-telemetry-inspector-model-spec")).toHaveTextContent("explicit-preview-model");
    expect(screen.getByTestId("prompt-telemetry-inspector-tokens")).toHaveTextContent("1,840");
    fireEvent.click(screen.getByTestId("prompt-telemetry-inspector-scope-global"));
    expect(screen.getByTestId("prompt-telemetry-inspector-global-summary")).toHaveTextContent("2 prompts");
  });

  it("preserves production popover dismissal without any metrics", () => {
    render(<PromptTelemetryInspector />);
    fireEvent.click(screen.getByTestId("prompt-telemetry-inspector-toggle"));
    expect(screen.getByTestId("prompt-telemetry-inspector-panel")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("prompt-telemetry-inspector-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("prompt-telemetry-inspector-toggle"));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("prompt-telemetry-inspector-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("prompt-telemetry-inspector-toggle"));
    fireEvent(window, new CustomEvent("omnia:close-floating-menus", { detail: { source: "chat-composer" } }));
    expect(screen.queryByTestId("prompt-telemetry-inspector-panel")).not.toBeInTheDocument();
  });
});

describe("Turn studio action evidence boundary", () => {
  afterEach(cleanup);

  it("does not offer unsupported actions or invent comparison outputs for a local response", () => {
    render(<TurnStudioActionsBar turnId="local" responseText="A local utility response" modelLabel="gpt-6.1-sol · exact route" />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("turn-studio-actions-local")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/Re-ran|Cloned|Branched|TTFT|gpt-5.4|claude|parallel xHigh|\$/);
  });

  it("only offers operations with callbacks and never reports invocation as completion", async () => {
    const onRerun = vi.fn();
    const onClone = vi.fn();
    const onBranch = vi.fn();
    render(<TurnStudioActionsBar turnId="supported" responseText="Observed response" onRerun={onRerun} onClone={onClone} onBranch={onBranch} />);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Rerun turn" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Clone conversation from this turn" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Branch conversation from this turn" })); });
    expect(onRerun).toHaveBeenCalledTimes(1);
    expect(onClone).toHaveBeenCalledTimes(1);
    expect(onBranch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("turn-studio-status-supported")).not.toBeInTheDocument();
    expect(screen.queryByTestId("turn-branch-switcher-supported")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/Re-ran|Cloned|Branched|✓/);
  });

  it("marks an asynchronous operation as requested and handles rejection without a success badge", async () => {
    let rejectOperation: (error: Error) => void = () => undefined;
    const operation = new Promise<void>((_resolve, reject) => { rejectOperation = reject; });
    render(<TurnStudioActionsBar turnId="failed" responseText="Observed response" onRerun={() => operation} />);

    fireEvent.click(screen.getByRole("button", { name: "Rerun turn" }));
    expect(screen.getByRole("status")).toHaveTextContent("Rerun requested");
    expect(screen.getByRole("button", { name: "Rerun turn" })).toBeDisabled();
    await act(async () => { rejectOperation(new Error("private backend detail")); });
    expect(screen.getByRole("alert")).toHaveTextContent("Rerun failed. Try again.");
    expect(screen.getByRole("button", { name: "Rerun turn" })).toBeEnabled();
    expect(document.body).not.toHaveTextContent(/Re-ran|private backend detail|✓/);
  });

  it("keeps branch position controlled by supplied state and never increments counts on a branch request", async () => {
    const onSwitchBranch = vi.fn();
    const onBranch = vi.fn();
    const { rerender } = render(<TurnStudioActionsBar turnId="controlled" responseText="Observed response" branchIndex={2} branchCount={3} onSwitchBranch={onSwitchBranch} onBranch={onBranch} />);
    const switcher = screen.getByTestId("turn-branch-switcher-controlled");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Previous branch" })); });
    expect(onSwitchBranch).toHaveBeenLastCalledWith("prev");
    expect(switcher).toHaveTextContent("2 / 3");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next branch" })); });
    expect(onSwitchBranch).toHaveBeenLastCalledWith("next");
    expect(switcher).toHaveTextContent("2 / 3");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Branch conversation from this turn" })); });
    expect(onBranch).toHaveBeenCalledTimes(1);
    expect(switcher).toHaveTextContent("2 / 3");

    rerender(<TurnStudioActionsBar turnId="controlled" responseText="Observed response" branchIndex={1} branchCount={2} onSwitchBranch={onSwitchBranch} />);
    expect(switcher).toHaveTextContent("1 / 2");
  });

  it.each([
    { branchIndex: 2, branchCount: 3 },
    { branchIndex: 0, branchCount: 3, onSwitchBranch: vi.fn() },
    { branchIndex: 4, branchCount: 3, onSwitchBranch: vi.fn() },
    { branchIndex: 1, branchCount: Number.NaN, onSwitchBranch: vi.fn() },
    { branchIndex: 1.5, branchCount: 3, onSwitchBranch: vi.fn() },
  ])("does not provide branch navigation without a callback and valid supplied position: %o", (props) => {
    render(<TurnStudioActionsBar turnId="invalid" responseText="Observed response" {...props} />);
    expect(screen.queryByTestId("turn-branch-switcher-invalid")).not.toBeInTheDocument();
  });

  it("does not infer an alternative response merely because a winner callback exists", () => {
    render(<TurnStudioActionsBar turnId="no-candidates" responseText="Observed response" onSelectCompareWinner={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Compare models on this turn" })).not.toBeInTheDocument();
  });

  it("compares only explicit response evidence and preserves complete model identity and content", () => {
    const current = "Current observed response\nwith its original text";
    const alternative = "Independent observed alternative\nwith a different answer";
    render(<TurnStudioActionsBar turnId="comparison" responseText={current} modelLabel="gpt-6.1-sol · original route" comparisonCandidates={[{ id: "alternative", modelLabel: "custom-model · exact route", content: alternative }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Compare models on this turn" }));

    const comparison = screen.getByTestId("turn-compare-card-comparison");
    expect(comparison).toHaveTextContent("gpt-6.1-sol · original route");
    expect(comparison).toHaveTextContent("custom-model · exact route");
    expect(comparison).toHaveTextContent(current.replace("\n", " "));
    expect(comparison).toHaveTextContent(alternative.replace("\n", " "));
    expect(comparison).not.toHaveTextContent(/claude|gpt-5.4|TTFT|tok\/s|Cache|Verified via|Comparison Winner|\$/);
    expect(within(comparison).queryByRole("button")).not.toBeInTheDocument();
  });

  it("forwards an explicit selected response without adding labels or claiming completion", async () => {
    const onSelectCompareWinner = vi.fn();
    render(<TurnStudioActionsBar turnId="winner" responseText="Current response" modelLabel="current-model" comparisonCandidates={[{ id: "alternative", modelLabel: "gpt-6.1-sol · exact route", content: "Exact alternative response" }]} onSelectCompareWinner={onSelectCompareWinner} />);
    fireEvent.click(screen.getByRole("button", { name: "Compare models on this turn" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use response from gpt-6.1-sol · exact route" })); });

    expect(onSelectCompareWinner).toHaveBeenCalledExactlyOnceWith("Exact alternative response", "gpt-6.1-sol · exact route");
    expect(document.body).not.toHaveTextContent(/Selected Model|Comparison Winner|✓/);
  });

  it("ignores a prior turn's late action failure after switching turns", async () => {
    let rejectOperation: (error: Error) => void = () => undefined;
    const operation = new Promise<void>((_resolve, reject) => { rejectOperation = reject; });
    const { rerender } = render(<TurnStudioActionsBar turnId="old" responseText="Old response" onRerun={() => operation} />);
    fireEvent.click(screen.getByRole("button", { name: "Rerun turn" }));
    rerender(<TurnStudioActionsBar turnId="new" responseText="New response" onClone={vi.fn()} />);
    await act(async () => { rejectOperation(new Error("Late error")); });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clone conversation from this turn" })).toBeEnabled();
  });
});
