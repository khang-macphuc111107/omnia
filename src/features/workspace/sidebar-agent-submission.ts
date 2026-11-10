import { useCallback, useEffect, useRef, useState } from "react";

import { desktop, isDesktopRuntime } from "@/lib/desktop";

import { conversationFromNativeSnapshot } from "./conversation-catalog";
import { opaquePreparedAttemptDispatch } from "./prepared-run-dispatch";
import { selectableModelProfiles } from "./provider-catalog";
import { preflightProviderParameters, resolveRoutedProviderModel } from "./provider-parameters";
import {
  applyRunStreamEventToStore,
  startRunEventJournalBuffer,
  subscribeRunEvents,
} from "./run-event-broker";
import { createId, useWorkspaceStore } from "./store";

export interface SidebarAgentSubmissionOptions {
  conversationId?: string;
}

export type SidebarAgentSubmissionResult =
  | { ok: true; conversationId: string; runId: string }
  | {
      ok: false;
      code: "empty" | "busy" | "conversation" | "runtime" | "provider" | "preflight" | "prepare" | "dispatch";
      error: string;
      runId?: string;
    };

let preparingSubmission = false;

/**
 * Dispatches a sidebar turn through the same durable boundary as Chat. Store
 * startRun is only a renderer projection: it must never stand in for provider
 * execution, and no synthetic assistant reply is produced by this helper.
 *
 * Context supplied by the side panel is ordinary, explicit prompt text. Native
 * preparation persists it and freezes the complete provider input before the
 * renderer receives the two opaque identifiers accepted by dispatch.
 */
export async function submitSidebarAgentPrompt(
  input: string,
  options: SidebarAgentSubmissionOptions = {},
): Promise<SidebarAgentSubmissionResult> {
  const prompt = input.trim();
  if (!prompt) return { ok: false, code: "empty", error: "Enter a message before sending." };

  const state = useWorkspaceStore.getState();
  if (preparingSubmission || state.activeRun) {
    return { ok: false, code: "busy", error: "Wait for the current response to finish before sending another message." };
  }
  const conversationId = options.conversationId ?? state.activeConversationId;
  const conversation = state.conversations.find((candidate) => candidate.id === conversationId);
  if (!conversation) {
    return { ok: false, code: "conversation", error: "Create or select a chat thread before sending." };
  }
  const contextProject = conversation.projectId
    ? state.projects.find((project) => project.id === conversation.projectId) ?? null
    : null;
  const contextAdmissionGrantId = contextProject?.folders.find((folder) =>
    (folder.state === "ready" || folder.state === "referenced")
    && (folder.scope === "read-only" || folder.scope === "full-index" || folder.scope === "selected-files"),
  )?.id ?? null;
  if (!isDesktopRuntime()) {
    return {
      ok: false,
      code: "runtime",
      error: "Provider execution requires the native Omnia desktop runtime. This browser preview has not sent a request or generated an AI response.",
    };
  }

  const selectedModels = selectableModelProfiles(state.providers);
  const selectedModel = selectedModels.find((model) => model.id === state.modelProfileId) ?? selectedModels[0];
  const route = resolveRoutedProviderModel(state.providers, selectedModel);
  if (!route?.model.connectionId) {
    return { ok: false, code: "provider", error: "Connect a provider and select an available model before sending." };
  }
  const selectedAttachments = state.draftAttachmentIdsByConversation[conversation.id] ?? [];
  if (selectedAttachments.length > 0) {
    return {
      ok: false,
      code: "preflight",
      error: "This thread has pending attachments. Remove or send them through Chat before sending a text-only sidebar request; attachment context is not silently omitted.",
    };
  }
  const preflight = preflightProviderParameters(state.parameters, route);
  if (preflight.errors.length > 0) {
    return { ok: false, code: "preflight", error: preflight.errors.join(" ") };
  }

  preparingSubmission = true;
  const runId = createId("run");
  const attemptId = createId("attempt");
  const userMessageId = createId("message");
  const assistantMessageId = createId("message");
  let projectionStarted = false;
  let projectionRetainedForRun = false;
  const releaseProjection = subscribeRunEvents(applyRunStreamEventToStore);
  try {
    // Listen before dispatch, including when ChatComposer is unmounted by a
    // full-window surface. Durable journal replay remains the source of truth.
    await startRunEventJournalBuffer();
    if (useWorkspaceStore.getState().activeRun) {
      return { ok: false, code: "busy", error: "Another response started while the request was being prepared. Wait for it to finish." };
    }
    const prepared = await desktop.prepareConversationRun({
      conversationId: conversation.id,
      branchId: conversation.activeBranchId,
      runId,
      attemptId,
      userMessageId,
      assistantMessageId,
      prompt,
      providerProfileId: route.model.connectionId,
      model: route.model.providerModelId,
      requestParametersJson: JSON.stringify(preflight.parameters),
      ...(contextAdmissionGrantId
        ? {
            contextAdmission: {
              grantId: contextAdmissionGrantId,
              query: prompt,
              retrievalOptions: {
                tokenBudget: 8_000,
                maxResults: 12,
                maxResultsPerSource: 3,
              },
            },
          }
        : {}),
    });
    const dispatch = opaquePreparedAttemptDispatch(prepared.providerInput, {
      attemptId,
      runId,
      providerProfileId: route.model.connectionId,
      model: route.model.providerModelId,
    });
    if (
      prepared.conversation.conversation.id !== conversation.id ||
      prepared.conversation.conversation.activeBranchId !== conversation.activeBranchId
    ) {
      throw new Error("Native run preparation returned a conversation outside the selected thread and branch.");
    }
    const latest = useWorkspaceStore.getState();
    const durableConversation = conversationFromNativeSnapshot(
      prepared.conversation,
      latest.projects,
      latest.providers,
      latest.attachments,
    );
    latest.upsertConversation({
      ...durableConversation,
      messages: durableConversation.messages.map((message) =>
        message.id === assistantMessageId ? { ...message, modelLabel: route.model.displayName } : message,
      ),
    });
    latest.startRun({
      conversationId: conversation.id,
      runId,
      assistantMessageId,
      userMessageId,
      prompt,
      alreadyPersisted: true,
    });
    projectionStarted = true;
    // Closing a sidebar must not stop the in-flight native projection. Retain
    // one lease until this run terminates or is replaced by another run.
    const stopWatching = useWorkspaceStore.subscribe((next) => {
      if (next.activeRun?.id === runId) return;
      stopWatching();
      releaseProjection();
    });
    projectionRetainedForRun = true;
    useWorkspaceStore.getState().setRunStage(runId, "routing");
    await desktop.startPreparedAttempt(dispatch);
    return { ok: true, conversationId: conversation.id, runId };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "Unknown native runtime error";
    if (projectionStarted) {
      // The native gateway owns durable terminalization; this only updates the
      // local projection, just as the main composer handles dispatch failure.
      useWorkspaceStore.getState().failRun(runId, detail);
      return { ok: false, code: "dispatch", error: `The provider request could not start: ${detail}`, runId };
    }
    return { ok: false, code: "prepare", error: `The message could not be prepared and saved locally: ${detail}` };
  } finally {
    if (!projectionRetainedForRun) releaseProjection();
    preparingSubmission = false;
  }
}

/** Keep native run projections live when a full-window panel replaces Chat. */
export function useSidebarRunEventProjection(): void {
  useEffect(() => subscribeRunEvents(applyRunStreamEventToStore), []);
}

export function useSidebarAgentSubmission() {
  useSidebarRunEventProjection();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const submitPrompt = useCallback(async (prompt: string, options?: SidebarAgentSubmissionOptions) => {
    setSubmitting(true);
    setError(null);
    const result = await submitSidebarAgentPrompt(prompt, options);
    if (mounted.current) {
      setSubmitting(false);
      setError(result.ok ? null : result.error);
    }
    return result;
  }, []);

  return { submitPrompt, submitting, error };
}
