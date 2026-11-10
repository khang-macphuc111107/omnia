import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  desktop,
  type PrepareConversationRunRequest,
  type PreparedConversationRun,
  type RunStreamEvent,
} from "@/lib/desktop";

import { stopRunEventJournalBuffer, subscribeRunEvents } from "./run-event-broker";
import { submitSidebarAgentPrompt, useSidebarAgentSubmission } from "./sidebar-agent-submission";
import { useWorkspaceStore } from "./store";
import type { ConversationView, ProviderView } from "./types";

const frozenProviderInputId = "provider_input_sidebar_frozen";

function preparedSnapshot(request: PrepareConversationRunRequest): PreparedConversationRun {
  const createdAtMs = 1_786_582_800_000;
  const messageDefaults = {
    conversationId: request.conversationId,
    branchId: request.branchId,
    replacesMessageId: null,
    finishReason: null,
    createdAtMs,
    updatedAtMs: createdAtMs,
    finalizedAtMs: null,
  };
  return {
    providerInput: {
      id: frozenProviderInputId,
      attemptId: request.attemptId,
      runId: request.runId,
      providerProfileId: request.providerProfileId,
      model: request.model,
      contentSha256: "a".repeat(64),
      messageCount: 2,
      createdAtMs,
    },
    conversation: {
      conversation: {
        id: request.conversationId,
        projectId: null,
        title: "Native sidebar conversation",
        activeBranchId: request.branchId,
        pinnedAtMs: null,
        archivedAtMs: null,
        createdAtMs,
        updatedAtMs: createdAtMs,
      },
      branches: [{
        id: request.branchId,
        conversationId: request.conversationId,
        parentBranchId: null,
        forkedFromMessageId: null,
        name: null,
        createdAtMs,
      }],
      messages: [
        {
          ...messageDefaults,
          id: request.userMessageId,
          parentMessageId: null,
          role: "user",
          status: "complete",
          sequenceNo: 0,
          contentText: request.prompt,
          providerProfileId: null,
          modelId: null,
        },
        {
          ...messageDefaults,
          id: request.assistantMessageId,
          parentMessageId: request.userMessageId,
          role: "assistant",
          status: "draft",
          sequenceNo: 1,
          contentText: "",
          providerProfileId: request.providerProfileId,
          modelId: request.model,
        },
      ],
      runs: [{
        id: request.runId,
        conversationId: request.conversationId,
        branchId: request.branchId,
        userMessageId: request.userMessageId,
        assistantMessageId: request.assistantMessageId,
        providerProfileId: request.providerProfileId,
        modelId: request.model,
        state: "queued",
        errorCode: null,
        startedAtMs: null,
        completedAtMs: null,
        createdAtMs,
      }],
      attempts: [],
    },
  };
}

describe("sidebar native agent submission", () => {
  let originalState: ReturnType<typeof useWorkspaceStore.getState>;
  let onNativeEvent: ((event: RunStreamEvent) => void) | undefined;

  beforeEach(() => {
    stopRunEventJournalBuffer();
    originalState = useWorkspaceStore.getState();
    window.__TAURI_INTERNALS__ = {};
    const conversation: ConversationView = {
      id: "conversation_sidebar",
      activeBranchId: "branch_sidebar",
      title: "Sidebar thread",
      excerpt: "",
      updatedAt: "2026-10-19T00:00:00.000Z",
      updatedLabel: "Now",
      projectId: null,
      projectName: null,
      pinned: false,
      archived: false,
      hasDraft: true,
      unread: false,
      runState: null,
      draft: "Keep this draft unless a native turn is accepted",
      messages: [],
    };
    const provider: ProviderView = {
      id: "provider-sidebar",
      name: "Native provider",
      kind: "OpenAI-compatible",
      providerType: "openai-compatible",
      endpoint: "http://127.0.0.1:9999/v1",
      authScheme: "none",
      state: "connected",
      modelCount: 1,
      enabled: true,
      credentialState: "not-required",
      source: "native",
      organizationId: null,
      remoteProjectId: null,
      lastCheckedAt: null,
      latencyMs: null,
      errorMessage: null,
      models: [{
        id: "sidebar-model",
        connectionId: "provider-sidebar",
        displayName: "Configured reasoning model",
        providerName: "Native provider",
        providerModelId: "configured-model",
        status: "available",
        capabilities: ["reasoning", "tools"],
        contextLabel: "Reported context",
        speed: "Thorough",
        favorite: false,
      }],
    };
    useWorkspaceStore.setState({
      activeConversationId: conversation.id,
      conversations: [conversation],
      activeRun: null,
      attachments: [],
      draftAttachmentIdsByConversation: {},
      providers: [provider],
      modelProfileId: "sidebar-model",
    });
    vi.spyOn(desktop, "onRunEvent").mockImplementation(async (callback) => {
      onNativeEvent = callback;
      return () => { onNativeEvent = undefined; };
    });
    vi.spyOn(desktop, "prepareConversationRun").mockImplementation(async (request) => preparedSnapshot(request));
    vi.spyOn(desktop, "startPreparedAttempt").mockResolvedValue();
  });

  afterEach(() => {
    stopRunEventJournalBuffer();
    useWorkspaceStore.setState(originalState, true);
    delete window.__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it("does not fabricate provider execution or alter drafts in a browser preview", async () => {
    delete window.__TAURI_INTERNALS__;
    const before = useWorkspaceStore.getState().conversations[0];
    const result = await submitSidebarAgentPrompt("Review the active file");
    expect(result).toMatchObject({ ok: false, code: "runtime" });
    expect(desktop.prepareConversationRun).not.toHaveBeenCalled();
    expect(desktop.startPreparedAttempt).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().conversations[0]).toEqual(before);
    expect(useWorkspaceStore.getState().activeRun).toBeNull();
  });

  it("prepares durable native messages and dispatches only opaque input identifiers", async () => {
    const result = await submitSidebarAgentPrompt("  @active-file\nReview this code  ");
    expect(result.ok).toBe(true);
    const request = vi.mocked(desktop.prepareConversationRun).mock.calls[0]?.[0];
    expect(request).toMatchObject({
      conversationId: "conversation_sidebar",
      branchId: "branch_sidebar",
      prompt: "@active-file\nReview this code",
      providerProfileId: "provider-sidebar",
      model: "configured-model",
    });
    expect(desktop.startPreparedAttempt).toHaveBeenCalledExactlyOnceWith({
      attemptId: request?.attemptId,
      frozenProviderInputId,
    });
    const conversation = useWorkspaceStore.getState().conversations[0];
    expect(conversation?.title).toBe("Native sidebar conversation");
    expect(conversation?.messages).toHaveLength(2);
    expect(conversation?.messages[1]?.content).toBe("");
    expect(conversation?.messages[1]?.modelLabel).toBe("Configured reasoning model");
    expect(useWorkspaceStore.getState().activeRun?.stage).toBe("routing");
  });

  it("adjoins native workspace retrieval admission for a ready project grant", async () => {
    const current = useWorkspaceStore.getState();
    const project = {
      ...current.projects[0]!,
      id: "project_context",
      name: "Context project",
      folders: [{
        id: "workspace_context",
        displayName: "Omnia source",
        canonicalPath: "D:\\Omnia\\repos\\omnia",
        state: "ready" as const,
        scope: "read-only" as const,
        fileCount: 12,
        chunkCount: 24,
        lastIndexedAt: null,
        localOnly: true,
      }],
    };
    useWorkspaceStore.setState({
      projects: [project, ...current.projects.filter((candidate) => candidate.id !== project.id)],
      conversations: [{
        ...current.conversations[0]!,
        projectId: project.id,
        projectName: project.name,
      }],
      activeConversationId: current.conversations[0]!.id,
    });

    const result = await submitSidebarAgentPrompt("Find the relevant implementation");
    expect(result.ok).toBe(true);
    const request = vi.mocked(desktop.prepareConversationRun).mock.calls[0]?.[0];
    expect(request?.contextAdmission).toEqual({
      grantId: "workspace_context",
      query: "Find the relevant implementation",
      retrievalOptions: {
        tokenBudget: 8_000,
        maxResults: 12,
        maxResultsPerSource: 3,
      },
    });
  });

  it("rejects unavailable providers before persisting any message", async () => {
    useWorkspaceStore.setState({ providers: [] });
    expect(await submitSidebarAgentPrompt("Review code")).toMatchObject({ ok: false, code: "provider" });
    expect(desktop.prepareConversationRun).not.toHaveBeenCalled();
  });

  it("rejects parameters the selected native route cannot represent", async () => {
    const state = useWorkspaceStore.getState();
    useWorkspaceStore.setState({ parameters: { ...state.parameters, minP: 0.25 } });
    const result = await submitSidebarAgentPrompt("Review code");
    expect(result).toMatchObject({ ok: false, code: "preflight" });
    expect(desktop.prepareConversationRun).not.toHaveBeenCalled();
  });

  it("does not silently discard pending thread attachments", async () => {
    useWorkspaceStore.setState({ draftAttachmentIdsByConversation: { conversation_sidebar: ["pending-file"] } });
    expect(await submitSidebarAgentPrompt("Review code")).toMatchObject({ ok: false, code: "preflight" });
    expect(desktop.prepareConversationRun).not.toHaveBeenCalled();
  });

  it("refuses a mismatched frozen native receipt before renderer projection or dispatch", async () => {
    vi.mocked(desktop.prepareConversationRun).mockImplementation(async (request) => {
      const prepared = preparedSnapshot(request);
      prepared.providerInput.attemptId = "wrong-attempt";
      return prepared;
    });
    expect(await submitSidebarAgentPrompt("Review code")).toMatchObject({ ok: false, code: "prepare" });
    expect(desktop.startPreparedAttempt).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().conversations[0]?.messages).toEqual([]);
    expect(useWorkspaceStore.getState().activeRun).toBeNull();
  });

  it("refuses a native snapshot outside the selected thread", async () => {
    vi.mocked(desktop.prepareConversationRun).mockImplementation(async (request) => {
      const prepared = preparedSnapshot(request);
      prepared.conversation.conversation.id = "other-conversation";
      return prepared;
    });
    expect(await submitSidebarAgentPrompt("Review code")).toMatchObject({ ok: false, code: "prepare" });
    expect(desktop.startPreparedAttempt).not.toHaveBeenCalled();
  });

  it("reports native preparation errors without creating a synthetic assistant response", async () => {
    vi.mocked(desktop.prepareConversationRun).mockRejectedValue(new Error("Storage unavailable"));
    const result = await submitSidebarAgentPrompt("Review code");
    expect(result).toMatchObject({ ok: false, code: "prepare", error: expect.stringContaining("Storage unavailable") });
    expect(useWorkspaceStore.getState().conversations[0]?.messages).toEqual([]);
    expect(desktop.startPreparedAttempt).not.toHaveBeenCalled();
  });

  it("projects dispatch failure without claiming successful native execution", async () => {
    vi.mocked(desktop.startPreparedAttempt).mockRejectedValue(new Error("Gateway unavailable"));
    const result = await submitSidebarAgentPrompt("Review code");
    expect(result).toMatchObject({ ok: false, code: "dispatch", error: expect.stringContaining("Gateway unavailable") });
    expect(useWorkspaceStore.getState().activeRun).toBeNull();
    expect(useWorkspaceStore.getState().conversations[0]?.runState).toBe("failed");
    expect(useWorkspaceStore.getState().conversations[0]?.messages[1]?.status).toBe("failed");
  });

  it("prevents two asynchronous sidebar preparations from running concurrently", async () => {
    let finishPreparation: (() => void) | undefined;
    vi.mocked(desktop.prepareConversationRun).mockImplementation(async (request) => {
      await new Promise<void>((resolve) => { finishPreparation = resolve; });
      return preparedSnapshot(request);
    });
    const first = submitSidebarAgentPrompt("First turn");
    await vi.waitFor(() => expect(finishPreparation).toBeDefined());
    expect(await submitSidebarAgentPrompt("Second turn")).toMatchObject({ ok: false, code: "busy" });
    finishPreparation?.();
    expect((await first).ok).toBe(true);
    expect(desktop.prepareConversationRun).toHaveBeenCalledTimes(1);
  });

  it("projects real native stream deltas while the Chat composer is unmounted", async () => {
    const { result } = renderHook(() => useSidebarAgentSubmission());
    await act(async () => { await result.current.submitPrompt("Review code"); });
    const runId = useWorkspaceStore.getState().activeRun?.id;
    expect(runId).toBeDefined();
    act(() => onNativeEvent?.({ type: "delta", runId: runId!, sequence: 1, text: "Native response" }));
    expect(useWorkspaceStore.getState().conversations[0]?.messages[1]?.content).toBe("Native response");
    expect(result.current.submitting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("keeps projecting a submitted native run after its sidebar unmounts", async () => {
    const { result, unmount } = renderHook(() => useSidebarAgentSubmission());
    await act(async () => { await result.current.submitPrompt("Review code"); });
    const runId = useWorkspaceStore.getState().activeRun?.id;
    unmount();
    act(() => onNativeEvent?.({ type: "delta", runId: runId!, sequence: 1, text: "Still streaming" }));
    expect(useWorkspaceStore.getState().conversations[0]?.messages[1]?.content).toBe("Still streaming");
  });

  it("reference-counts shared projection callbacks without duplicating delivery", async () => {
    const callback = vi.fn();
    const releaseFirst = subscribeRunEvents(callback);
    const releaseSecond = subscribeRunEvents(callback);
    await Promise.resolve();
    onNativeEvent?.({ type: "delta", runId: "run-shared", sequence: 1, text: "First" });
    expect(callback).toHaveBeenCalledTimes(1);
    releaseFirst();
    releaseFirst();
    onNativeEvent?.({ type: "delta", runId: "run-shared", sequence: 2, text: "Second" });
    expect(callback).toHaveBeenCalledTimes(2);
    releaseSecond();
    onNativeEvent?.({ type: "delta", runId: "run-shared", sequence: 3, text: "Third" });
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
