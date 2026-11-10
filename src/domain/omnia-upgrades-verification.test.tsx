import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  UNIVERSAL_SUPER_HARNESS_BLUEPRINTS,
  compileOmniaSuperHarnessSystemPrompt,
  getOfficialHarnessDescriptor,
  shapeAnthropicCacheControlBreakpoints,
} from "./omnia-official-harness-adapters";
import {
  DEFAULT_OMNIA_SESSION_TREE_NODES,
  clearSubagentUserPromptHistory,
  parseKdTreeGroupExpression,
  partitionSubagentsIntoKdTreeGroups,
  runPeerSubagentGroupDiscussion,
  sendDirectUserPromptToSubagent,
} from "./session-dfs-tree";
import {
  VIDEO_RING_BUFFER_MAX_BYTES,
  buildComputerUseOverlayVisualSpec,
  completeAndAuditComputerUseVideo,
  enforceVideoRingBufferFifoLimit,
  formatVirtualKeyboardBadge,
  formatVirtualMouseBadge,
  handleComputerUseKillSwitchHotkey,
  markAndExtractVideoSegmentKeyframes,
  recordComputerUseActionInVideo,
  resolveComputerUseKillSwitchLabel,
  startComputerUseVideoCapture,
} from "./sovereign-ide-remote-desktop";
import {
  aggregateGlobalPromptTelemetry,
  buildPromptTelemetryRecord,
  formatDetailedPromptTimestamp,
  formatTelemetryDurationMs,
  formatTelemetryUsd,
} from "./omnia-prompt-telemetry";
import {
  COMPOSER_SLASH_COMMANDS,
  EXTENDED_COMPOSER_SLASH_COMMANDS,
  computeLivePromptSuggestion,
  enhancePromptDraft,
  findComposerSlashCommands,
  recallCrossAgentPromptHistory,
} from "../features/workspace/composer-slash-commands";
import { SessionDfsExplorer } from "../features/workspace/session-dfs-explorer";
import { ComputerUseVideoOverlayPanel } from "../features/workspace/computer-use-video-overlay";
import { PromptTelemetryInspector, TurnStudioActionsBar } from "../features/workspace/prompt-telemetry-inspector";
import { ChatComposer } from "../features/workspace/composer";
import { ObjectSidebar } from "../features/workspace/sidebar";
import { useWorkspaceStore } from "../features/workspace/store";

describe("1. Next-Gen Universal Harness Parity", () => {
  it("normalizes all 12 ecosystem harness aliases including Cursor, Droid and Oh-My-Pi", () => {
    expect(getOfficialHarnessDescriptor("cursor").id).toBe("cursor");
    expect(getOfficialHarnessDescriptor("droid").id).toBe("droid");
    expect(getOfficialHarnessDescriptor("oh-my-pi").id).toBe("oh-my-pi");
    expect(getOfficialHarnessDescriptor("kimi-k2").id).toBe("kimi-k2");
  });

  it("caps Anthropic cache_control breakpoints at 4 and exposes 11 ecosystem blueprints", () => {
    const shaped = shapeAnthropicCacheControlBreakpoints({
      systemBreakpoints: ["1h", "1h"],
      toolBreakpoints: ["5m", "5m"],
      messageBreakpoints: ["5m", "1h"],
    });
    expect(shaped.totalBreakpointsBefore).toBe(6);
    expect(shaped.totalBreakpointsAfter).toBe(4);
    expect(shaped.invariantSatisfied).toBe(true);
    expect(UNIVERSAL_SUPER_HARNESS_BLUEPRINTS).toHaveLength(11);

    const compiled = compileOmniaSuperHarnessSystemPrompt({
      modelId: "claude-opus-4-6",
      effort: "max",
      enableDeepWebSearch: true,
      enablePeerSubagentGroup: true,
    });
    expect(compiled.systemPrompt).toContain("Omnia Universal Super-Harness");
    expect(compiled.systemPrompt).toContain("Anti-AI-Slop");
    expect(compiled.systemPrompt).toContain("Deep Web Search");
    expect(compiled.webSearchMaxUses).toBe(24);
  });
});

describe("2. Grouped k-d Tree Multi-Main & Peer-Discussion Subagent DAG ({A, B}, C) + Direct Subagent Chat", () => {
  it("parses {A, B}, C k-d tree expressions (including nested braces & empty segments), runs peer-group autonomous consensus, and supports direct subagent chat", () => {
    const parsed = parseKdTreeGroupExpression("{session-b1, session-c1}, session-c2");
    expect(parsed).toEqual([["session-b1", "session-c1"], ["session-c2"]]);

    const parsedNested = parseKdTreeGroupExpression("{{session-b1, session-c1}}, , session-c2");
    expect(parsedNested).toEqual([["session-b1", "session-c1"], ["session-c2"]]);
    expect(() => parseKdTreeGroupExpression("{session-b1, session-c1")).toThrow();
    expect(() => parseKdTreeGroupExpression("session-b1}, session-c1")).toThrow();

    const partitioned = partitionSubagentsIntoKdTreeGroups({
      nodesById: DEFAULT_OMNIA_SESSION_TREE_NODES,
      parentSessionIds: ["session-a"],
      groupSpec: "{session-b1, session-c1}, session-c2",
    });
    expect(partitioned.canonicalNotation).toBe("{session-b1, session-c1}, session-c2");
    expect(partitioned.buckets).toHaveLength(2);
    expect(partitioned.buckets[0]?.isPeerCluster).toBe(true);
    expect(partitioned.buckets[0]?.memberSessionIds).toEqual(["session-b1", "session-c1"]);

    const discussed = runPeerSubagentGroupDiscussion({
      nodesById: partitioned.nodesById,
      bucket: partitioned.buckets[0]!,
      taskTopic: "Verify zero unverified claims and 100% test pass rate",
      rounds: 2,
    });
    expect(discussed.discussionTurns.length).toBe(4);
    expect(discussed.consolidatedParentReport).toContain("Consolidated k-d Tree Group Report");
    expect(discussed.definitionOfDoneChecklist.every((item) => item.verified)).toBe(true);

    const directRes = sendDirectUserPromptToSubagent({
      nodesById: discussed.updatedNodesById,
      targetSessionId: "session-b1",
      userPrompt: "Inspect the cache breakpoint logic directly.",
    });
    expect(directRes.userMessage.sender).toBe("user");
    expect(directRes.subagentReply.sender).toBe("subagent");
    expect(directRes.targetNode.directChatTranscript?.length).toBeGreaterThanOrEqual(2);
  });

  it("renders SessionDfsExplorer with k-d Tree Peer Group panel and Direct Subagent Chat", () => {
    render(<SessionDfsExplorer />);
    expect(screen.getByTestId("kd-tree-peer-group-panel")).toBeInTheDocument();
    expect(screen.getByTestId("direct-subagent-chat-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("partition-kd-tree-groups-btn"));
    fireEvent.click(screen.getByTestId("run-kd-peer-discussion-btn"));
    expect(screen.getByTestId("kd-consensus-reports-list")).toBeInTheDocument();

    const chatInput = screen.getByTestId("direct-subagent-chat-input");
    fireEvent.change(chatInput, { target: { value: "Verify rust gateway line 860" } });
    fireEvent.click(screen.getByTestId("send-direct-subagent-chat-btn"));
    expect(screen.getAllByText(/Verify rust gateway line 860/).length).toBeGreaterThanOrEqual(1);
  });
});

describe("3. Video-Ring-Buffer Parallel Computer Use (1 GB FIFO, [M1->M2] Keyframes, Final Audit, Kill Switch)", () => {
  it("records continuous video, extracts [M0 -> M1] and [M1 -> M2] sharp keyframes without stopping, and deletes video after Final Audit", () => {
    let session = startComputerUseVideoCapture({
      captureId: "cap_test_1",
      captureNumber: 1,
      startedAtMs: 1000,
    });
    session = recordComputerUseActionInVideo(session, {
      actionLabel: "Click Submit Button",
      x: 400,
      y: 300,
      durationDeltaMs: 350,
    });
    const seg1 = markAndExtractVideoSegmentKeyframes(session, "M1");
    expect(seg1.extractedSegment.fromMarker).toBe("M0");
    expect(seg1.extractedSegment.toMarker).toBe("M1");
    expect(seg1.session.status).toBe("recording");

    const seg2 = markAndExtractVideoSegmentKeyframes(seg1.session, "M2");
    expect(seg2.extractedSegment.fromMarker).toBe("M1");
    expect(seg2.extractedSegment.toMarker).toBe("M2");
    expect(seg2.session.status).toBe("recording");

    const audited = completeAndAuditComputerUseVideo(seg2.session);
    expect(audited.status).toBe("completed-audited-deleted");
    expect(audited.retainedBytes).toBe(0);
    expect(audited.finalAuditPassed).toBe(true);
  });

  it("enforces the strict 1 GB (1,073,741,824 bytes) FIFO Ring Buffer cap across multiple captures and single >1GB captures", () => {
    const chunkSize = Math.floor(VIDEO_RING_BUFFER_MAX_BYTES * 0.45);
    const c1 = {
      ...startComputerUseVideoCapture({ captureId: "cap_1", captureNumber: 1, startedAtMs: 1000 }),
      retainedBytes: chunkSize,
    };
    const c2 = {
      ...startComputerUseVideoCapture({ captureId: "cap_2", captureNumber: 2, startedAtMs: 2000 }),
      retainedBytes: chunkSize,
    };
    const c3 = {
      ...startComputerUseVideoCapture({ captureId: "cap_3", captureNumber: 3, startedAtMs: 3000 }),
      retainedBytes: chunkSize,
    };

    const store2 = enforceVideoRingBufferFifoLimit([c1, c2], VIDEO_RING_BUFFER_MAX_BYTES);
    expect(store2.evictedCaptureIds).toHaveLength(0);

    const store3 = enforceVideoRingBufferFifoLimit([c1, c2, c3], VIDEO_RING_BUFFER_MAX_BYTES);
    expect(store3.totalRetainedBytes).toBeLessThanOrEqual(VIDEO_RING_BUFFER_MAX_BYTES);
    expect(store3.evictedCaptureIds).toContain("cap_1");

    // Single capture > 1 GB trims oldest FIFO segments to stay at 1 GB while keeping status "recording"
    const s1 = markAndExtractVideoSegmentKeyframes(
      startComputerUseVideoCapture({ captureId: "cap_huge", captureNumber: 1, startedAtMs: 500 }),
      "M1",
      Math.floor(VIDEO_RING_BUFFER_MAX_BYTES * 0.7),
    ).session;
    const s2 = markAndExtractVideoSegmentKeyframes(
      s1,
      "M2",
      Math.floor(VIDEO_RING_BUFFER_MAX_BYTES * 0.7),
    ).session;
    expect(s2.retainedBytes).toBeGreaterThan(VIDEO_RING_BUFFER_MAX_BYTES);

    const trimmedStore = enforceVideoRingBufferFifoLimit([s2], VIDEO_RING_BUFFER_MAX_BYTES);
    expect(trimmedStore.totalRetainedBytes).toBe(VIDEO_RING_BUFFER_MAX_BYTES);
    expect(trimmedStore.captures[0]?.status).toBe("recording");
    expect(trimmedStore.captures[0]?.segments.length).toBe(1);
    expect(trimmedStore.captures[0]?.segments[0]?.toMarker).toBe("M2");
  });

  it("handles Esc (single capture) and Esc+<N> (parallel captures) kill switch hotkeys, parallel Virtual Mice/Keyboards, and animated pre-typing dots", () => {
    expect(resolveComputerUseKillSwitchLabel(1, 1)).toBe("Esc");
    expect(resolveComputerUseKillSwitchLabel(2, 2)).toBe("Esc + 2");

    const c1 = startComputerUseVideoCapture({ captureId: "cap_1", captureNumber: 1, startedAtMs: 1000 });
    const c2 = startComputerUseVideoCapture({ captureId: "cap_2", captureNumber: 2, startedAtMs: 2000 });

    const ignoredPlainEscOnParallel = handleComputerUseKillSwitchHotkey([c1, c2], "Esc");
    expect(ignoredPlainEscOnParallel.stoppedCaptureIds).toHaveLength(0);

    const killedSecond = handleComputerUseKillSwitchHotkey([c1, c2], "Esc+2");
    expect(killedSecond.stoppedCaptureIds).toEqual(["cap_2"]);

    expect(formatVirtualMouseBadge(2, "Chrome", 512, 384)).toContain("Mouse #2");
    expect(formatVirtualKeyboardBadge("VS Code", "cargo test", true)).toContain("...");

    const spec = buildComputerUseOverlayVisualSpec(c1, 2, [c1, c2]);
    expect(spec.killSwitchHotkeyLabel).toBe("Esc + 1");
    expect(spec.outerEdgeOpacity).toBeGreaterThan(spec.innerCenterOpacity);
    expect(spec.virtualMice).toHaveLength(2);
    expect(spec.virtualKeyboards).toHaveLength(2);

    render(<ComputerUseVideoOverlayPanel />);
    expect(screen.getByTestId("computer-use-video-overlay-root")).toBeInTheDocument();
    expect(screen.getByTestId("computer-use-gradient-border")).toBeInTheDocument();
    expect(screen.getByTestId("computer-use-video-typing-dots-1")).toHaveClass(
      "omnia-typing-dots-animated",
    );

    // Start a parallel capture (#2) and verify both Mouse #1 and Mouse #2 are rendered
    fireEvent.click(screen.getByTestId("computer-use-video-start-parallel-btn"));
    expect(screen.getByTestId("computer-use-video-virtual-mouse-1")).toBeInTheDocument();
    expect(screen.getByTestId("computer-use-video-virtual-mouse-2")).toBeInTheDocument();
    expect(screen.getByTestId("computer-use-video-virtual-keyboard-1")).toBeInTheDocument();
    expect(screen.getByTestId("computer-use-video-virtual-keyboard-2")).toBeInTheDocument();

    // Press Escape then '2' on window to stop parallel capture #2 via keyboard
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "2" });
    expect(screen.getByTestId("computer-use-video-kill-switch-banner")).toHaveTextContent(
      /Stopped.*2.*via Esc\+2/i,
    );
  });
});

describe("4. Complete Per-Prompt, Per-Command, Per-Agent & Global Telemetry/Cost Inspector", () => {
  it("computes explicit fixture metrics and preserves controlled branch actions", async () => {
    const record = buildPromptTelemetryRecord({
      promptId: "p_test",
      conversationId: "c_test",
      surface: "main-chat",
      promptSummary: "Verify all 7 architectural upgrades",
      promptSentAtIso: "2026-10-20T15:00:00.000Z",
      promptFinishedAtIso: "2026-10-20T15:00:04.000Z",
      ttftMs: 320,
      provider: "Anthropic",
      model: "claude-opus-4-6",
      effort: "max",
      tokensIn: 2000,
      tokensOut: 600,
      cacheTokensIn: 18000,
      cacheTokensOut: 1000,
      requestCount: 3,
      commands: [
        {
          commandId: "cmd_1",
          commandLabel: "npx vitest run",
          agentId: "main",
          startedAtIso: "2026-10-20T15:00:00.500Z",
          finishedAtIso: "2026-10-20T15:00:03.000Z",
          durationMs: 2500,
          status: "completed",
        },
      ],
      agents: [
        {
          agentId: "main",
          agentLabel: "Main",
          role: "main",
          provider: "Anthropic",
          model: "claude-opus-4-6",
          effort: "max",
          tokensIn: 2000,
          tokensOut: 600,
          cacheTokensIn: 18000,
          cacheTokensOut: 1000,
          costTotalUsd: 0.05,
          requestCount: 3,
          durationMs: 4000,
        },
      ],
    });

    expect(record.durationMs).toBe(4000);
    expect(record.cacheHitPercent).toBe(90);
    expect(record.tokensPerSecond).toBeGreaterThan(100);
    expect(record.costCacheInUsd).toBeGreaterThan(0);
    expect(record.costCacheOutUsd).toBeGreaterThan(0);
    expect(record.costTotalUsd).toBeGreaterThan(0);
    expect(record.agentCount).toBe(1);
    expect(formatDetailedPromptTimestamp(record.promptSentAtIso)).toContain("2026-10-20 15:00:00.000");
    expect(formatTelemetryUsd(record.costTotalUsd)).toMatch(/^\$/);
    expect(formatTelemetryDurationMs(record.durationMs)).toBe("4.00s");

    const agg = aggregateGlobalPromptTelemetry([record]);
    expect(agg.totalPrompts).toBe(1);
    expect(agg.totalRequests).toBe(3);
    expect(agg.overallCacheHitPercent).toBe(90);
    expect(agg.totalCostCacheInUsd).toBe(record.costCacheInUsd);
    expect(agg.totalCostCacheOutUsd).toBe(record.costCacheOutUsd);

    const { container: telemetryContainer, unmount: unmountTelemetry } = render(
      <PromptTelemetryInspector record={record} surface="main-chat" testId="test-telemetry" />,
    );
    fireEvent.click(screen.getByTestId("test-telemetry-toggle"));
    expect(screen.getByTestId("test-telemetry-panel")).toBeInTheDocument();
    expect(telemetryContainer.querySelectorAll(".prompt-telemetry-grid dt").length).toBeGreaterThanOrEqual(7);
    expect(telemetryContainer.querySelectorAll(".prompt-telemetry-grid dd").length).toBeGreaterThanOrEqual(7);
    expect(screen.getByTestId("test-telemetry-timestamps").textContent).toMatch(
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/,
    );
    expect(screen.getByTestId("test-telemetry-cost").textContent).toContain("Cache In");
    expect(screen.getByTestId("test-telemetry-cost").textContent).toContain("Cache Out");

    // Verify omnia:close-floating-menus closes the telemetry popover when another menu opens
    fireEvent(window, new CustomEvent("omnia:close-floating-menus", { detail: { source: "chat-composer" } }));
    expect(screen.queryByTestId("test-telemetry-panel")).not.toBeInTheDocument();

    // Verify outside pointerdown also closes the telemetry popover
    fireEvent.click(screen.getByTestId("test-telemetry-toggle"));
    expect(screen.getByTestId("test-telemetry-panel")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("test-telemetry-panel")).not.toBeInTheDocument();
    unmountTelemetry();

    // Invalid supplied branch state does not create local navigation or branch counts.
    const onSwitchBranch = vi.fn();
    const onBranch = vi.fn();
    const { unmount: unmountActions, rerender: rerenderActions } = render(
      <TurnStudioActionsBar
        turnId="branch-clamp-turn"
        responseText="Sample turn response"
        branchIndex={5}
        branchCount={4}
        onSwitchBranch={onSwitchBranch}
        onBranch={onBranch}
      />,
    );
    expect(screen.queryByTestId("turn-branch-switcher-branch-clamp-turn")).not.toBeInTheDocument();
    rerenderActions(<TurnStudioActionsBar turnId="branch-clamp-turn" responseText="Sample turn response" branchIndex={4} branchCount={4} onSwitchBranch={onSwitchBranch} onBranch={onBranch} />);
    const switcher = screen.getByTestId("turn-branch-switcher-branch-clamp-turn");
    expect(switcher).toHaveTextContent("4 / 4");
    await act(async () => { fireEvent.click(screen.getByTestId("turn-branch-prev-branch-clamp-turn")); });
    expect(onSwitchBranch).toHaveBeenLastCalledWith("prev");
    expect(switcher).toHaveTextContent("4 / 4");
    rerenderActions(<TurnStudioActionsBar turnId="branch-clamp-turn" responseText="Sample turn response" branchIndex={3} branchCount={4} onSwitchBranch={onSwitchBranch} onBranch={onBranch} />);
    expect(switcher).toHaveTextContent("3 / 4");
    await act(async () => { fireEvent.click(screen.getByTestId("turn-branch-next-branch-clamp-turn")); });
    expect(onSwitchBranch).toHaveBeenLastCalledWith("next");
    expect(switcher).toHaveTextContent("3 / 4");
    await act(async () => { fireEvent.click(screen.getByTestId("turn-action-branch-branch-clamp-turn")); });
    expect(onBranch).toHaveBeenCalledTimes(1);
    expect(switcher).toHaveTextContent("3 / 4");
    unmountActions();
  });
});

describe("5 & 7. Clean Left Chat Sidebar (No 'All' Label), Extended Slash Commands & Cross-Agent + Subagent Prompt History Recall", () => {
  it("omits redundant 'All' section label from ObjectSidebar when default filter is active", () => {
    const { container } = render(<ObjectSidebar />);
    const sectionLabels = Array.from(
      container.querySelectorAll(".sidebar-section-label > span"),
    ).map((el) => el.textContent?.trim());
    expect(sectionLabels).not.toContain("All");
  });

  it("preserves core 9 slash commands and supports extended slash commands, live suggestions, prompt enhancement, and ArrowUp/ArrowDown recall", () => {
    expect(COMPOSER_SLASH_COMMANDS).toHaveLength(9);
    expect(EXTENDED_COMPOSER_SLASH_COMMANDS.length).toBeGreaterThanOrEqual(9);
    expect(findComposerSlashCommands("btw", true).map((c) => c.id)).toContain("btw");
    expect(findComposerSlashCommands("peer", true).map((c) => c.id)).toContain("peer");
    expect(findComposerSlashCommands("", { includeExtended: true }).map((c) => c.id)).toEqual(
      expect.arrayContaining(["btw", "spawn", "peer", "verify", "enhance", "schedule", "compare", "branch", "clone"]),
    );

    const enhanced = enhancePromptDraft("refactor provider gateway");
    expect(enhanced).toContain("Verification & Definition of Done:");
    expect(enhanced).toContain("Inspect exact file:line evidence");

    const suggestion = computeLivePromptSuggestion("fix the cache");
    expect(suggestion).toContain("reproduce with Vitest and verify edge cases");

    const history = ["first prompt", "second prompt", "third prompt"];
    const step1 = recallCrossAgentPromptHistory({
      history,
      currentIndex: -1,
      direction: "up",
      currentValue: "",
      savedDraft: "",
    });
    expect(step1).toEqual({
      nextHistoryIndex: 2,
      nextValue: "third prompt",
      savedDraft: "",
    });
    const step2 = recallCrossAgentPromptHistory({
      history,
      currentIndex: step1!.nextHistoryIndex,
      direction: "up",
      currentValue: step1!.nextValue,
      savedDraft: step1!.savedDraft,
    });
    expect(step2).toEqual({
      nextHistoryIndex: 1,
      nextValue: "second prompt",
      savedDraft: "",
    });
    const step3 = recallCrossAgentPromptHistory({
      history,
      currentIndex: 2,
      direction: "down",
      currentValue: "third prompt",
      savedDraft: "",
    });
    expect(step3).toEqual({
      nextHistoryIndex: -1,
      nextValue: "",
      savedDraft: "",
    });
  });

  it("recalls prompts sent to subagents via ArrowUp in Main ChatComposer and surfaces extended slash commands when typing '/'", () => {
    clearSubagentUserPromptHistory();
    const state = useWorkspaceStore.getState();
    const activeConv = state.conversations.find((c) => c.id === state.activeConversationId) ?? state.conversations[0]!;
    useWorkspaceStore.setState({
      activeConversationId: activeConv.id,
      conversations: [
        {
          ...activeConv,
          draft: "",
          messages: [
            {
              id: "m_hist_1",
              role: "user",
              content: "First prompt sent in Main chat",
              createdAt: "2026-10-20T10:00:00.000Z",
              status: "complete",
              modelLabel: null,
              runId: null,
              attachments: [],
              branchIndex: 1,
              branchCount: 1,
            },
          ],
        },
      ],
    });

    // User sends a direct prompt to subagent session-b1
    sendDirectUserPromptToSubagent({
      nodesById: DEFAULT_OMNIA_SESSION_TREE_NODES,
      targetSessionId: "session-b1",
      userPrompt: "Subagent B1 direct prompt from user",
    });

    const { container, unmount } = render(<ChatComposer />);
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).toHaveAttribute("accept", "*/*");

    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    // First ArrowUp recalls the most recent prompt (the one sent to Subagent B1!)
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("Subagent B1 direct prompt from user");

    // Second ArrowUp recalls the previous prompt from Main chat
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("First prompt sent in Main chat");

    // Typing "/" in ChatComposer surfaces extended slash commands (/btw, /spawn, /peer, /compare)
    fireEvent.change(textarea, { target: { value: "/", selectionStart: 1, selectionEnd: 1 } });
    fireEvent.select(textarea);
    expect(screen.getByRole("option", { name: /\/btw/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /\/peer/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /\/compare/i })).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: "fix the broken test" } });
    expect(screen.getByTestId("composer-live-prompt-suggestion")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("composer-accept-suggestion-btn"));
    expect(textarea.value).toContain("reproduce with Vitest and verify edge cases");

    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Automations and schedule/i }));
    expect(screen.getByTestId("composer-automations-panel")).toBeInTheDocument();
    clearSubagentUserPromptHistory();
    unmount();
  });

  it("exposes Provider + Model + Effort selectors, Enhance + Undo, TurnTelemetryHud, TurnStudioActionsBar (Rerun/Compare/Clone/Branch), browser-mode branching, and tree-indented /btw subchats", async () => {
    const state = useWorkspaceStore.getState();
    const parentConv = {
      ...state.conversations[0]!,
      messages: [
        {
          id: "msg_branch_test_1",
          role: "assistant" as const,
          content: "Verified response turn",
          createdAt: "2026-10-20T12:00:00.000Z",
          status: "complete" as const,
          modelLabel: null,
          runId: null,
          attachments: [],
          branchIndex: 1,
          branchCount: 1,
        },
      ],
    };
    const childBtwConv = {
      ...parentConv,
      id: "conv_btw_child_1",
      title: "[/btw] Verify cache hit rate",
      workspacePath: `omnia://sessions/${parentConv.id}`,
      messages: [],
    };
    useWorkspaceStore.setState({
      activeConversationId: parentConv.id,
      conversations: [parentConv, childBtwConv],
    });

    // Verify browser-mode forkConversationBranch works without throwing "requires native desktop runtime"
    await useWorkspaceStore.getState().forkConversationBranch("msg_branch_test_1", "Branch 2");
    const updatedParent = useWorkspaceStore.getState().conversations.find((c) => c.id === parentConv.id)!;
    const branchedMsg = updatedParent.messages.find((m) => m.id === "msg_branch_test_1")!;
    expect(branchedMsg.branchCount).toBe(2);
    expect(branchedMsg.branchIndex).toBe(2);
    expect(updatedParent.nativeBranches?.length).toBeGreaterThanOrEqual(2);

    const { unmount: unmountSidebar } = render(<ObjectSidebar />);
    expect(screen.getByTestId(`sidebar-btw-subchats-${parentConv.id}`)).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-btw-subchat-btw-conv-conv_btw_child_1")).toHaveTextContent(
      "├─ [/btw] Verify cache hit rate",
    );

    // Verify omnia:close-floating-menus closes sidebar floating menus
    fireEvent.click(screen.getAllByRole("button", { name: "Open Chat actions menu" })[0]!);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent(window, new CustomEvent("omnia:close-floating-menus", { detail: { source: "chat-composer" } }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    unmountSidebar();

    const { unmount: unmountComposer } = render(<ChatComposer />);
    expect(screen.getByTestId("composer-provider-selector")).toBeInTheDocument();
    expect(screen.getByTestId("composer-model-selector")).toBeInTheDocument();
    expect(screen.getByTestId("composer-effort-selector")).toBeInTheDocument();

    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    // Verify Tab accepts live prompt suggestion on a collapsed plain draft
    fireEvent.change(textarea, { target: { value: "fix the cache", selectionStart: 13, selectionEnd: 13 } });
    textarea.setSelectionRange(13, 13);
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toContain("reproduce with Vitest and verify edge cases");

    fireEvent.change(textarea, { target: { value: "audit the hash implementation" } });
    fireEvent.click(screen.getByTestId("composer-enhance-prompt-btn"));
    expect(textarea.value).toContain("[Constraints & Verification");
    expect(screen.getByTestId("composer-undo-enhance-btn")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("composer-undo-enhance-btn"));
    expect(textarea.value).toBe("audit the hash implementation");

    // Verify submitting /btw keeps parent conversation active while creating child /btw conversation
    fireEvent.change(textarea, { target: { value: "/btw What is the xxHash64 seed?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(useWorkspaceStore.getState().activeConversationId).toBe(parentConv.id);
    expect(
      useWorkspaceStore
        .getState()
        .conversations.some((c) => c.title.includes("What is the xxHash64 seed?") && c.workspacePath === `omnia://sessions/${parentConv.id}`),
    ).toBe(true);
    unmountComposer();
  });
});



