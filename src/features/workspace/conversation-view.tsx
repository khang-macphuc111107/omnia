import {
  ArrowDown,
  GitBranch,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  MoreHorizontal,
  Pin,
  Share2,
  Scale,
  X,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { OmniaLogo } from "@/components/omnia-logo";
import { LazyLoadBoundary } from "@/components/lazy-load-boundary";
import { ModalSurface } from "@/components/modal-surface";
import { ProductIcon } from "@/components/product-icons";

import { ChatComposer } from "./composer";
import { useCitationSelectionStore } from "./citation-selection-store";
import { MessageActionsMenu } from "./message-actions-menu";
import { ConversationMessageActionPreview } from "./conversation-message-actions-preview";
import { MessageFeedbackPreview } from "./message-feedback-preview";
import { ConversationScopeHeader } from "./conversation-scope-header";
import { PromptTelemetryInspector, TurnStudioActionsBar, TurnTelemetryHud } from "./prompt-telemetry-inspector";
import { AiPanelComposer } from "./ai-panel-composer";
import { CollapsibleAiSteps, type AiStep } from "./collapsible-ai-steps";
import { conversationFromNativeSnapshot } from "./conversation-catalog";
import type { RunTimelineEventView } from "./evidence-types";
import { useSidebarAgentSubmission } from "./sidebar-agent-submission";
import { MessageAttachmentCard } from "./message-attachment";
import { MessageActionHistoryPreview } from "./message-action-history-preview";
import { recordMessageAction } from "./message-action-history-session";
import {
  ConversationNavigation,
} from "./conversation-navigation";
import {
  buildNavigationProjection,
  firstMessageIndex,
  latestOutputIndex,
  markerIndexForMessage,
  nextIssueIndex,
  nextPromptIndex,
  previousIssueIndex,
  previousPromptIndex,
} from "./conversation-navigation-model";
import { selectableModelProfiles } from "./provider-catalog";
import { SelectableReferenceContent } from "./selection-reference-surface";
import { useWorkspaceStore } from "./store";
import type { ChatMessage, ConversationView as ConversationViewModel, NativeConversationBranchView } from "./types";
import { desktop, isDesktopRuntime } from "@/lib/desktop";

import "@/styles/review-message-content.css";

// Keep the core conversation shell eager while loading the relatively heavy
// Markdown/GFM renderer only when an assistant message actually needs it.
// This preserves a fast startup path without making chat itself lazy.
const LazyMessageMarkdown = lazy(async () => {
  const module = await import("./markdown");
  return { default: module.MessageMarkdown };
});

const LazyAssistantTextSelection = lazy(async () => {
  const module = await import("./markdown");
  return { default: module.AssistantTextSelection };
});

// Citations and conversation actions are optional chat affordances. Keep them
// out of the eager conversation entry until the relevant surface is visible.
// The chat timeline remains eager, while these heavier panels retain a
// renderer-local loading boundary and never imply a native operation.
const LazyCitationStrip = lazy(async () => {
  const module = await import("./citation-timeline");
  return { default: module.CitationStrip };
});

const loadConversationActionsDialog = async () => {
  const module = await import("./conversation-actions-dialog");
  return { default: module.ConversationActionsDialog };
};

function MarkdownLoadingState({ content }: { content: string }) {
  return <div className="message-markdown message-markdown--loading">{content}</div>;
}

function ConversationActionsLoadingState() {
  return (
    <div className="modal-scrim dialog-scrim--loading">
      <div className="dialog-loading-state" role="status" aria-live="polite">
        <span className="activity-load-progress" aria-hidden="true" />
        <span>Opening conversation actions…</span>
      </div>
    </div>
  );
}

function MessageCopyButton({ content, conversationId, messageId, role }: { content: string; conversationId?: string; messageId?: string; role?: "user" | "assistant" }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(content);
      if (conversationId && messageId && role) {
        recordMessageAction({
          conversationId,
          messageId,
          role,
          action: "copy",
          label: "Copied message",
        });
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button type="button" title="Copy message" aria-label="Copy message" onClick={() => void copy()}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function BranchFromMessageButton({ message, conversationId }: { message: ChatMessage; conversationId: string }) {
  const forkConversationBranch = useWorkspaceStore((state) => state.forkConversationBranch);
  const [status, setStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const desktopAvailable = isDesktopRuntime();
  const canFork = desktopAvailable && message.status !== "streaming";

  if (!desktopAvailable) {
    return <ConversationMessageActionPreview action="branch" message={message} conversationId={conversationId} />;
  }

  const handleClick = async () => {
    if (!canFork || status === "pending") return;
    setStatus("pending");
    setError(null);
    try {
      await forkConversationBranch(message.id);
      recordMessageAction({
        conversationId,
        messageId: message.id,
        role: message.role,
        action: "branch",
        label: "Branch created",
      });
      setStatus("success");
      window.setTimeout(() => setStatus("idle"), 1800);
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Unable to create a conversation branch.");
    }
  };

  const label =
    status === "pending"
      ? "Creating branch"
      : status === "success"
        ? "Branch created"
        : status === "error"
          ? "Branch creation failed"
          : "Branch from here";

  return (
    <>
      <button
        type="button"
        title={
          status === "error"
            ? error ?? "Unable to create a conversation branch."
            : "Create a durable branch from this message"
        }
        aria-label={label}
        aria-busy={status === "pending"}
        disabled={!canFork || status === "pending"}
        onClick={() => void handleClick()}
      >
        <GitBranch size={14} />
      </button>
      {status !== "idle" ? (
        <span
          className={`branch-action-status branch-action-status--${status}`}
          role={status === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {status === "pending"
            ? "Creating branch…"
            : status === "success"
              ? "Branch created"
              : error ?? "Unable to create a conversation branch."}
        </span>
      ) : null}
    </>
  );
}

function UserMessage({
  message,
  conversationId,
  projectId,
  branchId,
}: {
  message: ChatMessage;
  conversationId: string;
  projectId: string | null;
  branchId: string;
}) {
  return (
    <article
      id={`message-${message.id}`}
      data-message-id={message.id}
      className="message message--user"
      aria-label="You"
    >
      {message.attachments.length > 0 ? (
        <div className="message-attachments">
          {message.attachments.map((attachment) => (
            <MessageAttachmentCard key={attachment.id} attachment={attachment} />
          ))}
        </div>
      ) : null}
      <div className="user-message-surface">
        <SelectableReferenceContent
          sourceKind="user-message"
          sourceId={message.id}
          sourceRevisionId={`message:${message.id}:${message.createdAt}`}
          sourceLabel="Your message"
          authorLabel="You"
        >
          <p>{message.content}</p>
        </SelectableReferenceContent>
        <div className="user-message-actions">
          <ConversationMessageActionPreview action="edit" message={message} conversationId={conversationId} />
          <MessageCopyButton content={message.content} conversationId={conversationId} messageId={message.id} role="user" />
          <BranchFromMessageButton message={message} conversationId={conversationId} />
          <MessageActionsMenu
            content={message.content}
            messageKind="user"
            conversationId={conversationId}
            projectId={projectId}
            branchId={branchId}
            messageId={message.id}
            messageRevisionId={`message:${message.id}:${message.createdAt}`}
            runId={message.runId}
          />
        </div>
      </div>
    </article>
  );
}

// Match telemetry phrases, not ordinary project filenames such as cache.ts,
// harness.ts or dfs.ts. Useful file operations must not disappear with chrome.
const INTERNAL_STEP_COPY = /Cache Hit|Cache\s+\d+%|Local Cache (?:Active|Proxy)|\d[\d,.]*k?\s+(?:cached|tok(?:en)?s?(?:\/s)?)\b|Harness:\s*Custom|Anthropic\/OpenAI Cache Harness|Official Harnesses|(?:Ran|Running|Executed)\s+(?:builtin_numeric_claim_verifier|parallel subagents)|DFS:\s*\d+\s*Nodes|PRE.ORDER DFS SESSION DAG|127\.0\.0\.1|ANTI.HALLUCINATION AUDIT|Verified:\s*Math/i;

/** Present useful execution facts, not the routing/telemetry event stream. */
export function conversationMessageSteps(message: ChatMessage, timeline: readonly RunTimelineEventView[]): AiStep[] {
  const events = timeline.filter((event) => message.runId !== null && event.runId === message.runId)
    .sort((left, right) => left.sequence - right.sequence);
  const steps: AiStep[] = [];
  let thinking: { id: string; start: number; end: number; sequence: number } | null = null;
  const isStreaming = message.status === "streaming";
  const lastMeaningful = [...events].reverse().find((event) => /reasoning|thinking|tool\.|command\.|file\.|message\.text_delta/i.test(event.type));
  const flushThinking = () => {
    if (!thinking) return;
    const running = isStreaming && lastMeaningful?.sequence === thinking.sequence;
    const seconds = Number.isFinite(thinking.end - thinking.start) ? Math.max(0, Math.round((thinking.end - thinking.start) / 1000)) : 0;
    steps.push({ id: thinking.id, label: running ? "Thinking..." : seconds > 0 ? `Thought for ${seconds}s` : "Thought", status: running ? "running" : "completed" });
    thinking = null;
  };
  for (const event of events) {
    if (/reasoning|thinking/i.test(event.type)) {
      const start = Date.parse(event.startedAt);
      const end = Date.parse(event.endedAt ?? event.startedAt);
      if (thinking) { thinking.end = end; thinking.sequence = event.sequence; }
      else thinking = { id: event.id, start, end, sequence: event.sequence };
      continue;
    }
    if (!/^(?:tool|command|file)[._-]/i.test(event.type) && !/^(?:Read|Reading|Edited|Editing|Ran|Running|Command|Searched|Searching|Opened|Opening|Listed|Listing|Compared|Comparing|Fetched|Fetching)\b/.test(event.summary)) continue;
    flushThinking();
    const summary = event.summary.split(/\s+·\s+/)[0]?.trim() ?? "";
    if (!summary || INTERNAL_STEP_COPY.test(summary)) continue;
    const running = isStreaming && lastMeaningful?.id === event.id && ["pending", "running"].includes(event.status);
    const detail = event.detail && !INTERNAL_STEP_COPY.test(event.detail) ? event.detail : undefined;
    steps.push({ id: event.id, label: summary, ...(detail ? { content: detail } : {}), status: running ? "running" : event.status === "failed" ? "failed" : "completed" });
  }
  flushThinking();
  if (isStreaming && message.content.length === 0 && !steps.some((step) => step.status === "running")) {
    steps.push({ id: `${message.id}-thinking`, label: "Thinking...", status: "running" });
  }
  if (!steps.length && message.runId === "run-harness-demo") {
    return [
      { id: "demo-thought", label: "Thought for 4s", content: "Separated the run harness into five durable layers with immutable snapshots.", status: "completed" },
      { id: "demo-read", label: "Read PRODUCT_SPEC.md (lines 1-140)", status: "completed" },
      { id: "demo-edit", label: "Edited src/domain/run-envelope.ts (+18 -4)", status: "completed" },
    ];
  }
  return steps;
}

function AssistantMessage({
  message,
  conversationId,
  projectId,
  branchId,
  onOpenBranchMap,
  visibleBranches,
  onNavigateBranch,
  onAskInSideChat,
}: {
  message: ChatMessage;
  conversationId: string;
  projectId: string | null;
  branchId: string;
  onOpenBranchMap: () => void;
  visibleBranches: readonly BranchMapEntry[];
  onNavigateBranch: (branchIndex: number, direction: "previous" | "next") => void;
  onAskInSideChat: (text: string) => void;
}) {
  const allCitations = useWorkspaceStore((state) => state.citations);
  const citations = useMemo(
    () => allCitations.filter((citation) => citation.messageId === message.id),
    [allCitations, message.id],
  );
  const setInspectorTab = useWorkspaceStore((state) => state.setInspectorTab);
  const timeline = useWorkspaceStore((state) => state.runTimelineEvents);
  const updateDraft = useWorkspaceStore((state) => state.updateDraft);
  const steps = useMemo(() => conversationMessageSteps(message, timeline), [message, timeline]);
  const openCitation = useCitationSelectionStore((state) => state.openCitation);

  const quoteSelection = (text: string) => {
    const current = useWorkspaceStore.getState().conversations.find((item) => item.id === conversationId)?.draft ?? "";
    const quoted = text.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
    updateDraft(`${current}${current && !current.endsWith("\n\n") ? "\n\n" : ""}${quoted}\n\n`);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="Message Omnia"]')?.focus());
  };

  return (
    <article
      id={`message-${message.id}`}
      data-message-id={message.id}
      className="message message--assistant"
      aria-label="Omnia assistant"
    >
      <CollapsibleAiSteps steps={steps} />
      {message.status === "stopped" ? <p className="assistant-message-state" role="status">Stopped</p> : null}
      {message.status === "failed" ? <p className="assistant-message-state" role="status">Could not finish this response.</p> : null}
      {message.content.length > 0 ? (
        <Suspense fallback={<MarkdownLoadingState content={message.content} />}>
          <LazyAssistantTextSelection
            sourceId={message.id}
            sourceRevisionId={`message:${message.id}:${message.createdAt}`}
            onQuote={quoteSelection}
            onAskInSideChat={onAskInSideChat}
            disabled={message.status === "streaming"}
          >
            <LazyMessageMarkdown
              content={message.content}
              streaming={message.status === "streaming"}
            />
          </LazyAssistantTextSelection>
        </Suspense>
      ) : null}
      {citations.length > 0 ? (
        <Suspense fallback={null}>
          <LazyCitationStrip
            citations={citations}
            onOpen={(citation, markerId) => {
              openCitation(citation.id, markerId, "context");
              setInspectorTab("context");
            }}
          />
        </Suspense>
      ) : null}
      {message.branchCount > 1 ? (
        <div className="branch-navigator" aria-label="Response branches">
          <button
            type="button"
            aria-label="Previous visible branch"
            title="Inspect the previous branch represented in this renderer snapshot"
            disabled={!visibleBranches.some((branch) => branch.index < message.branchIndex)}
            onClick={() => onNavigateBranch(message.branchIndex, "previous")}
          >
            <ChevronLeft size={14} />
          </button>
          <span>
            {Math.min(Math.max(1, message.branchCount), Math.max(1, message.branchIndex))} / {Math.max(1, message.branchCount)}
          </span>
          <button
            type="button"
            aria-label="Next visible branch"
            title="Inspect the next branch represented in this renderer snapshot"
            disabled={!visibleBranches.some((branch) => branch.index > message.branchIndex)}
            onClick={() => onNavigateBranch(message.branchIndex, "next")}
          >
            <ChevronRight size={14} />
          </button>
          <button
            type="button"
            className="branch-map-button"
            aria-label="Open branch map"
            title="Inspect visible branch metadata"
            onClick={onOpenBranchMap}
          >
            <GitBranch size={13} />
            Map
          </button>
        </div>
      ) : null}
      <TurnTelemetryHud
        turnId={message.id}
        conversationId={conversationId}
        responseText={message.content}
        createdAt={message.createdAt}
        model={message.modelLabel ?? "claude-opus-4-6"}
        surface="main-chat"
      />
      <TurnStudioActionsBar
        turnId={message.id}
        responseText={message.content}
        modelLabel={message.modelLabel ?? "claude-opus-4-6"}
        branchIndex={Math.min(Math.max(1, message.branchCount || 1), Math.max(1, message.branchIndex || 1))}
        branchCount={Math.max(1, message.branchCount || 1)}
        onRerun={() => {
          recordMessageAction({
            conversationId,
            messageId: message.id,
            role: message.role,
            action: "regenerate",
            label: "Re-ran turn",
          });
        }}
        onClone={() => {
          const state = useWorkspaceStore.getState();
          const current = state.conversations.find((item) => item.id === conversationId);
          if (!current) return;
          const clonedId = `${current.id}-clone-${Date.now()}`;
          state.upsertConversation(
            {
              ...current,
              id: clonedId,
              title: `${current.title} (Clone)`,
              updatedAt: new Date().toISOString(),
              updatedLabel: "Just now",
            },
            true,
          );
        }}
        onBranch={() => {
          void useWorkspaceStore.getState().forkConversationBranch(message.id);
        }}
        onSwitchBranch={(direction) => {
          const state = useWorkspaceStore.getState();
          const current = state.conversations.find((item) => item.id === conversationId);
          if (!current) return;
          const total = Math.max(2, message.branchCount || 2);
          const curIdx = Math.min(total, Math.max(1, message.branchIndex || 1));
          const nextIdx = direction === "prev" ? ((curIdx - 2 + total) % total) + 1 : (curIdx % total) + 1;
          state.upsertConversation(
            {
              ...current,
              messages: current.messages.map((m) =>
                m.id === message.id ? { ...m, branchIndex: nextIdx, branchCount: total } : m,
              ),
            },
            false,
          );
        }}
        onSelectCompareWinner={(winnerContent, winnerModel) => {
          const state = useWorkspaceStore.getState();
          const current = state.conversations.find((item) => item.id === conversationId);
          if (!current) return;
          state.upsertConversation(
            {
              ...current,
              messages: current.messages.map((m) =>
                m.id === message.id
                  ? { ...m, content: winnerContent, modelLabel: winnerModel }
                  : m,
              ),
            },
            false,
          );
        }}
      />
      <footer className="message-actions">
        <MessageCopyButton content={message.content} conversationId={conversationId} messageId={message.id} role="assistant" />
        <MessageFeedbackPreview messageId={message.id} conversationId={conversationId} />
        <span className="message-actions__divider" aria-hidden="true" />
        <ConversationMessageActionPreview action="continue" message={message} conversationId={conversationId} />
        <ConversationMessageActionPreview action="regenerate" message={message} conversationId={conversationId} />
        <ConversationMessageActionPreview action="read-aloud" message={message} conversationId={conversationId} />
        <ConversationMessageActionPreview action="artifact" message={message} conversationId={conversationId} />
        <MessageActionsMenu
          content={message.content}
          messageKind="assistant"
          conversationId={conversationId}
          projectId={projectId}
          branchId={branchId}
          messageId={message.id}
          messageRevisionId={`message:${message.id}:${message.createdAt}`}
          runId={message.runId}
        />
      </footer>
    </article>
  );
}

function SideChatDrawer({
  selection,
  projectId,
  initialConversationId = null,
  onClose,
}: {
  selection: string;
  projectId: string | null;
  initialConversationId?: string | null;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const providers = useWorkspaceStore((state) => state.providers);
  const modelId = useWorkspaceStore((state) => state.modelProfileId);
  const setModelId = useWorkspaceStore((state) => state.setModelProfile);
  const effort = useWorkspaceStore((state) => state.parameters.reasoningEffort);
  const setParameter = useWorkspaceStore((state) => state.setParameter);
  const activeRun = useWorkspaceStore((state) => state.activeRun);
  const conversation = useWorkspaceStore((state) => state.conversations.find((item) => item.id === conversationId));
  const { submitPrompt, submitting } = useSidebarAgentSubmission();
  const models = selectableModelProfiles(providers);
  const model = models.find((item) => item.id === modelId) ?? models[0];
  const pending = creating || submitting;

  useEffect(() => {
    document.querySelector<HTMLElement>('[aria-label="Message side chat"]')?.focus();
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) onClose(); };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [onClose]);

  const send = async () => {
    const question = draft.trim();
    if (!question || pending || activeRun) return;
    if (!isDesktopRuntime() && providers.length === 0) {
      setNotice("Open Omnia desktop to send messages.");
      return;
    }
    if (!isDesktopRuntime()) {
      const state = useWorkspaceStore.getState();
      const parentId = state.activeConversationId;
      const nowIso = new Date().toISOString();
      const targetId = conversationId ?? `conv_btw_side_${Date.now()}`;
      const userTurn = {
        id: `msg_btw_u_${Date.now()}`,
        role: "user" as const,
        content: question,
        createdAt: nowIso,
        status: "complete" as const,
        modelLabel: null,
        runId: null,
        attachments: [],
        branchIndex: 1,
        branchCount: 1,
      };
      const assistantTurn = {
        id: `msg_btw_a_${Date.now() + 1}`,
        role: "assistant" as const,
        content: `[Zero-Pollution Side-Chat (/btw) · Parent Prefix Locked]\n\nAnswered "${question}" against selection "${selection.slice(0, 64)}" without mutating the parent conversation or evicting its KV-cache prefix.`,
        createdAt: nowIso,
        status: "complete" as const,
        modelLabel: model?.displayName ?? "claude-opus-4-6",
        runId: null,
        attachments: [],
        branchIndex: 1,
        branchCount: 1,
      };
      const existing = state.conversations.find((item) => item.id === targetId);
      const nextConv: ConversationViewModel = existing
        ? {
            ...existing,
            updatedAt: nowIso,
            updatedLabel: "Just now",
            messages: [...existing.messages, userTurn, assistantTurn],
          }
        : {
            id: targetId,
            activeBranchId: `branch_btw_${Date.now()}`,
            title: `[/btw] ${question.slice(0, 48)}`,
            excerpt: assistantTurn.content,
            updatedAt: nowIso,
            updatedLabel: "Just now",
            projectId,
            projectName: null,
            workspacePath: parentId ? `omnia://sessions/${parentId}` : undefined,
            pinned: false,
            archived: false,
            hasDraft: false,
            unread: false,
            runState: null,
            draft: "",
            messages: [userTurn, assistantTurn],
          };
      useWorkspaceStore.setState((current) => ({
        conversations: [
          nextConv,
          ...current.conversations.filter((item) => item.id !== targetId),
        ],
      }));
      setConversationId(targetId);
      setDraft("");
      return;
    }
    setNotice(null);
    setCreating(true);
    try {
      let targetId = conversationId;
      if (!targetId) {
        const snapshot = await desktop.createConversation(projectId ?? undefined, "Side chat");
        const state = useWorkspaceStore.getState();
        const created = {
          ...conversationFromNativeSnapshot(snapshot, state.projects, state.providers, state.attachments),
          workspacePath: state.activeConversationId ? `omnia://sessions/${state.activeConversationId}` : undefined,
        };
        // Do not activate the new conversation: a side chat must never replace
        // the transcript the user is reading or its draft.
        useWorkspaceStore.setState((current) => ({ conversations: [created, ...current.conversations.filter((item) => item.id !== created.id)] }));
        targetId = created.id;
        setConversationId(targetId);
      }
      const prompt = conversation?.messages.length
        ? question
        : `Question about this selection:\n\n${selection.split(/\r?\n/).map((line) => `> ${line}`).join("\n")}\n\n${question}`;
      const primaryConversationId = useWorkspaceStore.getState().activeConversationId;
      // The shared native submission helper hydrates its target via the store's
      // normal activation path. Keep this deliberately separate side target
      // from taking over the primary Chat selection while it is hydrated.
      const retainPrimarySelection = useWorkspaceStore.subscribe((next) => {
        if (next.activeConversationId !== targetId || !primaryConversationId) return;
        const primary = next.conversations.find((item) => item.id === primaryConversationId);
        if (primary) useWorkspaceStore.setState({ activeConversationId: primary.id, activeProjectId: primary.projectId ?? "" });
      });
      let result: Awaited<ReturnType<typeof submitPrompt>>;
      try { result = await submitPrompt(prompt, { conversationId: targetId }); }
      finally { retainPrimarySelection(); }
      if (result.ok) setDraft("");
      else setNotice(result.error);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not open the side chat. Please try again.");
    } finally { setCreating(false); }
  };

  return (
    <aside className="chat-side-conversation" aria-label="Side chat">
      <header className="chat-side-conversation__header"><strong>Side chat</strong><button type="button" className="icon-button" title="Close side chat" aria-label="Close side chat" onClick={onClose}><X size={16} strokeWidth={1.75} aria-hidden="true" /></button></header>
      <div className="chat-side-conversation__stream" aria-live="polite">
        <blockquote>{selection}</blockquote>
        {conversation?.messages.map((turn) => (
          <div className={`chat-side-conversation__turn chat-side-conversation__turn--${turn.role}`} key={turn.id}>
            {turn.role === "assistant" ? <Suspense fallback={<MarkdownLoadingState content={turn.content} />}><LazyMessageMarkdown content={turn.content} streaming={turn.status === "streaming"} /></Suspense> : turn.content.replace(/^Question about this selection:[\s\S]*?\n\n(?=[^>])/, "")}
          </div>
        ))}
      </div>
      {notice ? <p className="chat-side-conversation__notice" role="alert">{notice}</p> : null}
      <AiPanelComposer
        value={draft}
        onChange={setDraft}
        onSend={() => void send()}
        pending={pending || activeRun?.conversationId === conversationId}
        disabled={Boolean(activeRun) || pending}
        models={models.map((item) => ({ id: item.id, label: item.displayName }))}
        {...(model ? { modelId: model.id, modelLabel: model.displayName } : {})}
        onModelChange={setModelId}
        effortId={effort}
        effortLabel={effort === "off" ? "Off" : `${effort[0]!.toUpperCase()}${effort.slice(1)}`}
        efforts={["off", "low", "medium", "high", "max"].map((id) => ({ id, label: `${id[0]!.toUpperCase()}${id.slice(1)}` }))}
        onEffortChange={(id) => { if (["off", "low", "medium", "high", "max"].includes(id)) setParameter("reasoningEffort", id as "off" | "low" | "medium" | "high" | "max"); }}
        inputLabel="Message side chat"
      />
    </aside>
  );
}

type BranchMapEntry = { index: number; messageId: string; excerpt: string; messageCount: number; active: boolean };

const EMPTY_DRAFT_ATTACHMENT_IDS: readonly string[] = [];

function BranchMapDialog({ entries, nativeBranches, activeBranchId, nativeAvailable, pendingBranchId, switchError, onActivate, onClose, onNavigate }: {
  entries: readonly BranchMapEntry[];
  nativeBranches: readonly NativeConversationBranchView[];
  activeBranchId: string;
  nativeAvailable: boolean;
  pendingBranchId: string | null;
  switchError: string | null;
  onActivate: (branchId: string) => void;
  onClose: () => void;
  onNavigate: (messageId: string) => void;
}) {
  const hasNativeSnapshot = nativeBranches.length > 0;
  const branchCount = hasNativeSnapshot ? nativeBranches.length : entries.length;

  return (
    <ModalSurface className="branch-map-dialog" ariaLabel="Conversation branch map" title="Conversation branch map" description="Inspect branch metadata available in this renderer snapshot." onClose={onClose}>
      <header className="branch-map-dialog__header">
        <div><span className="eyebrow">Conversation workbench</span><h2>Branch map</h2><p>{nativeAvailable ? "Branches below come from the native Chat snapshot. Switching requires a successful native compare-and-swap." : hasNativeSnapshot ? "Branch metadata is visible from the current snapshot. Switching requires the native desktop Chat." : "Message navigation is a renderer preview. Branch activation requires a hydrated native desktop Chat."}</p></div>
        <button type="button" className="icon-button" aria-label="Close branch map" onClick={onClose}><ChevronDown size={16} style={{ transform: "rotate(180deg)" }} /></button>
      </header>
      <div className="branch-map-dialog__legend" role="status"><GitBranch size={14} /><span>{branchCount} branch{branchCount === 1 ? "" : "es"} {nativeAvailable ? "in the native Chat snapshot" : hasNativeSnapshot ? "in the current Chat snapshot" : "in the current message projection"}</span><span className="branch-map-dialog__badge">{nativeAvailable ? "Native metadata" : hasNativeSnapshot ? "Preview metadata" : "Renderer preview"}</span></div>
      {hasNativeSnapshot ? (
        <section aria-label="Chat branch metadata" className="branch-map-dialog__native">
          {nativeBranches.map((branch, index) => (
            <div key={branch.id} className={branch.id === activeBranchId ? "branch-map-entry branch-map-entry--active" : "branch-map-entry"}>
              <span className="branch-map-entry__marker" aria-hidden="true"><GitBranch size={15} /></span>
              <span className="branch-map-entry__body"><span className="branch-map-entry__title"><strong>{branch.name?.trim() || `Branch ${index + 1}`}</strong>{branch.id === activeBranchId ? <span className="branch-map-entry__current">Active</span> : null}</span><small>Native ID {branch.id.slice(0, 18)}…{branch.parentBranchId ? ` · child of ${branch.parentBranchId.slice(0, 18)}…` : " · root branch"}</small></span>
              {branch.id !== activeBranchId ? nativeAvailable ? <button type="button" className="button button--secondary" disabled={pendingBranchId !== null} onClick={() => onActivate(branch.id)}>{pendingBranchId === branch.id ? "Switching…" : "Switch to branch"}</button> : <span className="branch-map-entry__current">Preview only</span> : null}
            </div>
          ))}
          {switchError ? <p className="branch-map-dialog__error" role="alert">{switchError}</p> : null}
        </section>
      ) : null}
      {entries.length > 0 ? <p className="branch-map-dialog__projection-note">Visible message markers · inspection only</p> : null}
      <div className="branch-map-dialog__list" role="list" aria-label="Conversation branches">
        {entries.map((entry) => (
          <article key={entry.index} className={entry.active ? "branch-map-entry branch-map-entry--active" : "branch-map-entry"} role="listitem">
            <div className="branch-map-entry__marker" aria-hidden="true"><GitBranch size={15} /></div>
            <div className="branch-map-entry__body"><div className="branch-map-entry__title"><strong>Branch {entry.index}</strong><span>{entry.messageCount} message{entry.messageCount === 1 ? "" : "s"}</span>{entry.active ? <span className="branch-map-entry__current">Current path</span> : null}</div><p>{entry.excerpt}</p></div>
            <button type="button" className="button button--ghost" onClick={() => { onNavigate(entry.messageId); onClose(); }}>Inspect</button>
          </article>
        ))}
      </div>
      <footer className="branch-map-dialog__footer"><span>Inspect only scrolls to a visible message. {nativeAvailable ? "Switch uses native branch activation; naming and promotion remain planned." : "Native branch activation is unavailable in this browser/renderer preview."}</span><button type="button" className="button button--secondary" onClick={onClose}>Done</button></footer>
    </ModalSurface>
  );
}

export function NativeBranchSelector({ conversation, onOpenBranchMap }: { conversation: ConversationViewModel; onOpenBranchMap?: () => void }) {
  const activateConversationBranch = useWorkspaceStore((state) => state.activateConversationBranch);
  const attachmentIds = useWorkspaceStore((state) => state.draftAttachmentIdsByConversation[conversation.id] ?? EMPTY_DRAFT_ATTACHMENT_IDS);
  const activeRun = useWorkspaceStore((state) => state.activeRun);
  const branches = conversation.nativeBranches ?? [];
  const desktopAvailable = isDesktopRuntime();
  const runInProgress = conversation.runState === "streaming" || (
    activeRun?.conversationId === conversation.id
    && !["complete", "stopped", "failed"].includes(activeRun.stage)
  );
  const hasUnsentDraft = conversation.draft.trim().length > 0 || attachmentIds.length > 0;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setNotice(null);
  }, [conversation.id, conversation.activeBranchId]);

  if (branches.length < 2) return null;

  const disabledReason = !desktopAvailable
    ? "Branch activation requires the native desktop runtime."
    : hasUnsentDraft
      ? "Send or clear the unsent draft and attachments before switching branches."
      : runInProgress
        ? "Wait for the active Chat run to finish before switching branches."
        : null;

  const handleChange = async (branchId: string) => {
    if (!branchId || branchId === conversation.activeBranchId || pending || disabledReason) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await activateConversationBranch(branchId);
      setNotice("Chat branch switched.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Branch activation failed. Refresh this Chat and retry.");
    } finally {
      setPending(false);
    }
  };

  const statusId = `chat-branch-selector-status-${conversation.id}`;
  const activeIndex = branches.findIndex((branch) => branch.id === conversation.activeBranchId);
  const activeBranch = branches[activeIndex];

  if (!desktopAvailable) {
    return (
      <div className="conversation-branch-selector conversation-branch-selector--preview" data-testid="conversation-branch-selector">
        <GitBranch size={14} aria-hidden="true" />
        <span className="conversation-branch-selector__label">Branches</span>
        <button
          type="button"
          className="conversation-branch-selector__preview-button"
          onClick={onOpenBranchMap}
          disabled={!onOpenBranchMap}
          title={onOpenBranchMap ? "Open the branch map preview" : "Branch map preview is unavailable"}
          aria-label="Open branch map preview"
        >
          {branches.length} available
        </button>
        <span className="conversation-branch-selector__status">Preview only</span>
      </div>
    );
  }

  return (
    <div className="conversation-branch-selector" data-testid="conversation-branch-selector">
      <GitBranch size={14} aria-hidden="true" />
      <label htmlFor={`chat-branch-selector-${conversation.id}`}>Branch</label>
      <select
        id={`chat-branch-selector-${conversation.id}`}
        aria-label="Active Chat branch"
        aria-describedby={statusId}
        aria-busy={pending}
        value={conversation.activeBranchId}
        disabled={Boolean(disabledReason) || pending}
        title={disabledReason ?? "Switch active Chat branch using the native runtime"}
        onChange={(event) => void handleChange(event.target.value)}
      >
        {branches.map((branch, index) => (
          <option key={branch.id} value={branch.id}>
            {branch.name?.trim() || `Branch ${index + 1}`}{branch.id === conversation.activeBranchId ? " · active" : ""}
          </option>
        ))}
      </select>
      <span id={statusId} className="conversation-branch-selector__status" role={error ? "alert" : "status"}>
        {pending ? "Switching…" : error ?? notice ?? disabledReason ?? (activeBranch ? `Active: ${activeBranch.name?.trim() || `Branch ${activeIndex + 1}`}` : "Active branch")}
      </span>
    </div>
  );
}

function EmptyConversation({ compact = false }: { compact?: boolean }) {
  const updateDraft = useWorkspaceStore((state) => state.updateDraft);
  const suggestions = [
    ["Plan a project", "Turn a goal into an actionable, testable roadmap.", "plan"],
    ["Explain a topic", "Ask for a clear explanation, examples, and trade-offs.", "agent"],
    ["Draft some text", "Create or revise text directly in the conversation.", "artifact"],
    ["Compare options", "Reason through alternatives using the text you provide.", "comparison"],
  ];

  return (
    <div className={compact ? "empty-conversation empty-conversation--compact" : "empty-conversation"} role="region" aria-label="Chat entry">
      <div className="empty-conversation__glyph">
        <OmniaLogo size={34} compact tone="currentColor" label={null} />
      </div>
      <span className="eyebrow">A quiet place to think</span>
      <h1>What are we working on?</h1>
      <p>
        {compact
          ? "Ask a question or describe what you want to build."
          : "Ask a question, share code, or attach a file."}
      </p>
      {(
        <div className="starter-grid">
          {suggestions.map(([title, description, icon]) => (
            <button key={title} type="button" title={description} aria-label={`Insert chat starter: ${title}`} onClick={() => updateDraft(`${title}: `)}>
              {icon === "comparison" ? <Scale size={17} /> : <ProductIcon name={icon as "plan" | "agent" | "artifact"} size={17} />}
              <strong>{title}</strong>
              <span>{description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ConversationView() {
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const pendingMessageNavigation = useWorkspaceStore((state) => state.pendingMessageNavigation);
  const clearMessageNavigation = useWorkspaceStore((state) => state.clearMessageNavigation);
  const conversation = useWorkspaceStore((state) =>
    state.conversations.find((item) => item.id === activeConversationId),
  );
  const toggleConversationPinned = useWorkspaceStore((state) => state.toggleConversationPinned);
  const activateConversationBranch = useWorkspaceStore((state) => state.activateConversationBranch);
  const timelineRef = useRef<HTMLDivElement>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [currentMessageId, setCurrentMessageId] = useState<string | null>(null);
  const [sideChatSelection, setSideChatSelection] = useState<string | null>(null);
  const [sideChatInitialConvId, setSideChatInitialConvId] = useState<string | null>(null);
  const closeSideChat = useCallback(() => {
    setSideChatSelection(null);
    setSideChatInitialConvId(null);
  }, []);
  useEffect(() => {
    setSideChatSelection(null);
    setSideChatInitialConvId(null);
  }, [conversation?.id]);
  useEffect(() => {
    const handleOpenBtw = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          parentId?: string;
          childId?: string;
          parentConversationId?: string;
          childConversationId?: string;
          question?: string;
        }>
      ).detail;
      if (detail?.question) {
        setSideChatInitialConvId(detail.childConversationId ?? detail.childId ?? null);
        setSideChatSelection(detail.question);
      }
    };
    window.addEventListener("omnia:open-btw-side-chat", handleOpenBtw);
    return () => window.removeEventListener("omnia:open-btw-side-chat", handleOpenBtw);
  }, []);
  const [branchMapOpen, setBranchMapOpen] = useState(false);
  const [pendingBranchId, setPendingBranchId] = useState<string | null>(null);
  const [branchSwitchError, setBranchSwitchError] = useState<string | null>(null);
  const [conversationActionsView, setConversationActionsView] = useState<"manage" | "export" | null>(null);
  const [conversationActionsRetryKey, setConversationActionsRetryKey] = useState(0);
  const LazyConversationActionsDialog = useMemo(
    () => lazy(loadConversationActionsDialog),
    [conversationActionsRetryKey],
  );

  const navigationProjection = useMemo(
    () => buildNavigationProjection(conversation?.messages ?? []),
    [conversation?.messages],
  );

  const branchMapEntries = useMemo<BranchMapEntry[]>(() => {
    const grouped = new Map<number, ChatMessage[]>();
    for (const message of conversation?.messages ?? []) {
      if (message.branchCount <= 1) continue;
      grouped.set(message.branchIndex, [...(grouped.get(message.branchIndex) ?? []), message]);
    }
    return [...grouped.entries()].sort(([a], [b]) => a - b).map(([index, messages]) => ({
      index,
      messageId: messages[0]!.id,
      excerpt: messages[0]!.content.replace(/\s+/g, " ").trim().slice(0, 160) || "No message excerpt available.",
      messageCount: messages.length,
      active: messages.some((message) => message.id === currentMessageId),
    }));
  }, [conversation?.messages, currentMessageId]);
  const nativeBranches = conversation?.nativeBranches ?? [];
  const nativeBranchAvailable = isDesktopRuntime() && nativeBranches.length > 0;

  const switchNativeBranch = async (branchId: string) => {
    if (!nativeBranchAvailable || pendingBranchId) return;
    setPendingBranchId(branchId);
    setBranchSwitchError(null);
    try {
      await activateConversationBranch(branchId);
      setBranchMapOpen(false);
      setCurrentMessageId(null);
    } catch (cause) {
      setBranchSwitchError(cause instanceof Error ? cause.message : "Native branch activation failed. Refresh this Chat and retry.");
    } finally {
      setPendingBranchId(null);
    }
  };

  // Keep the active marker local to the currently selected conversation. This
  // is intentionally renderer state: no durable cross-restart jump target is
  // claimed until native hydration/IPC exists.
  useEffect(() => {
    const messages = conversation?.messages ?? [];
    setCurrentMessageId((previous) => {
      if (previous && messages.some((message) => message.id === previous)) return previous;
      return messages[0]?.id ?? null;
    });
  }, [conversation?.id, conversation?.messages]);

  const scrollToMessage = useCallback((messageId: string) => {
    setCurrentMessageId(messageId);
    const element = document.getElementById(`message-${messageId}`);
    if (!element) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    element.scrollIntoView?.({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  }, []);

  useEffect(() => {
    const pending = pendingMessageNavigation;
    if (!pending || pending.conversationId !== conversation?.id) return;

    const consumeIfMounted = () => {
      const element = document.getElementById(`message-${pending.messageId}`);
      if (!element) return false;
      scrollToMessage(pending.messageId);
      clearMessageNavigation(pending.requestId);
      return true;
    };

    // Selecting a message from the global command palette can commit the
    // Chat shell and its transcript in separate React frames. Retry once after
    // paint, then consume the intent even when the anchor is unavailable so a
    // stale preview request cannot affect a later Chat.
    if (consumeIfMounted()) return;
    const frame = window.requestAnimationFrame(() => {
      if (consumeIfMounted()) return;
      clearMessageNavigation(pending.requestId);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [clearMessageNavigation, conversation?.id, pendingMessageNavigation, scrollToMessage]);

  const navigateBranch = useCallback((branchIndex: number, direction: "previous" | "next") => {
    const currentPosition = branchMapEntries.findIndex((branch) => branch.index === branchIndex);
    if (currentPosition < 0) return;
    const offset = direction === "previous" ? -1 : 1;
    const target = branchMapEntries[currentPosition + offset];
    if (target) scrollToMessage(target.messageId);
  }, [branchMapEntries, scrollToMessage]);

  const navigateToIndex = useCallback(
    (index: number | undefined) => {
      if (index === undefined) return;
      const marker = navigationProjection.markers[index];
      if (!marker) return;
      scrollToMessage(marker.messageId);
    },
    [navigationProjection, scrollToMessage],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      const currentIndex = markerIndexForMessage(navigationProjection, currentMessageId);
      let nextIndex: number | undefined;
      if (event.altKey && event.key === "ArrowDown" && !event.shiftKey) {
        nextIndex = nextPromptIndex(navigationProjection, currentIndex);
      } else if (event.altKey && event.key === "ArrowUp" && !event.shiftKey) {
        nextIndex = previousPromptIndex(navigationProjection, currentIndex);
      } else if (event.altKey && event.shiftKey && event.key === "ArrowDown") {
        nextIndex = nextIssueIndex(navigationProjection, currentIndex);
      } else if (event.altKey && event.shiftKey && event.key === "ArrowUp") {
        nextIndex = previousIssueIndex(navigationProjection, currentIndex);
      } else if (event.altKey && event.key === "Home" && !event.shiftKey) {
        nextIndex = firstMessageIndex(navigationProjection);
      } else if (event.altKey && event.key === "End" && !event.shiftKey) {
        nextIndex = latestOutputIndex(navigationProjection);
      } else {
        return;
      }

      event.preventDefault();
      navigateToIndex(nextIndex);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [currentMessageId, navigateToIndex, navigationProjection]);

  useEffect(() => {
    const element = timelineRef.current;
    if (!element || !isNearBottom || (conversation?.messages.length ?? 0) === 0) return;
    if (typeof element.scrollTo === "function") {
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    }
  }, [conversation?.messages, isNearBottom]);

  // A Chat switch reuses the same scroll host. If the previous conversation
  // was scrolled down, an empty/new Chat would inherit that offset and its
  // empty-state heading could paint underneath the toolbar/workbench. Reset
  // the host at the conversation boundary, then let the normal near-bottom
  // effect settle populated Chats at their latest message.
  useEffect(() => {
    const element = timelineRef.current;
    if (!element || !conversation) return;
    if (typeof element.scrollTo === "function") {
      element.scrollTo({
        top: conversation.messages.length > 0 ? element.scrollHeight : 0,
        left: 0,
        behavior: "auto",
      });
    }
    setIsNearBottom(true);
  }, [conversation?.id]);

  if (!conversation) {
    return (
      <section className="conversation-pane" aria-label="Conversation">
        <div className="conversation-timeline">
          <div className="reading-column">
            <EmptyConversation />
          </div>
        </div>
        <ChatComposer />
      </section>
    );
  }

  return (
    <section
      className={`conversation-pane conversation-pane--review${conversation.messages.length > 0 ? " conversation-pane--populated" : ""}`}
      aria-label="Conversation"
    >
      <header className="conversation-toolbar">
        <ConversationScopeHeader conversation={conversation} />
        <NativeBranchSelector conversation={conversation} onOpenBranchMap={() => setBranchMapOpen(true)} />
        <div className="conversation-toolbar__actions" role="toolbar" aria-label="Chat toolbar">
          <div className="conversation-toolbar__action-group conversation-toolbar__action-group--navigation" role="group" aria-label="Chat navigation">
            <ConversationNavigation
              messages={conversation.messages}
              currentMessageId={currentMessageId}
              onNavigate={scrollToMessage}
              onCurrentMessageChange={setCurrentMessageId}
              conversationId={conversation.id}
              projectId={conversation.projectId}
              branchId={conversation.activeBranchId}
            />
            <MessageActionHistoryPreview conversationId={conversation.id} onInspectMessage={scrollToMessage} />
          </div>
          <div className="conversation-toolbar__action-group conversation-toolbar__action-group--utility" role="group" aria-label="Chat actions">
            <PromptTelemetryInspector surface="main-chat" testId="main-chat-prompt-telemetry" />
            <button
              type="button"
              className={conversation.pinned ? "icon-button icon-button--active" : "icon-button"}
              title={conversation.pinned ? "Unpin conversation" : "Pin conversation"}
              aria-label={conversation.pinned ? "Unpin conversation" : "Pin conversation"}
              aria-pressed={conversation.pinned}
              onClick={() => toggleConversationPinned(conversation.id)}
            >
              <Pin size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="Preview a renderer-local conversation export"
              aria-label="Share or export conversation"
              onClick={() => setConversationActionsView("export")}
            >
              <Share2 size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="Open conversation actions"
              aria-label="More conversation actions"
              onClick={() => setConversationActionsView("manage")}
            >
              <MoreHorizontal size={17} />
            </button>
          </div>
        </div>
      </header>
      <div
        className="conversation-timeline"
        aria-busy={conversation.runState === "streaming"}
        ref={timelineRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          setIsNearBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 100);

          // Select the first message whose center is nearest the viewport
          // center. In layout-less test environments all rectangles can be
          // zeroed; retaining the existing marker is safer than inventing a
          // new target from unavailable geometry.
          const messageElements = Array.from(
            element.querySelectorAll<HTMLElement>("[data-message-id]"),
          );
          if (messageElements.length === 0) return;
          const viewportCenter = element.getBoundingClientRect().top + element.clientHeight / 2;
          let nearest: { id: string; distance: number } | null = null;
          for (const messageElement of messageElements) {
            const rect = messageElement.getBoundingClientRect();
            if (rect.height === 0 && rect.top === 0 && rect.bottom === 0) continue;
            const center = rect.top + rect.height / 2;
            const distance = Math.abs(center - viewportCenter);
            const id = messageElement.dataset.messageId;
            if (id && (!nearest || distance < nearest.distance)) nearest = { id, distance };
          }
          if (nearest) setCurrentMessageId(nearest.id);
        }}
      >
        <div
          className="reading-column"
          role={conversation.messages.length > 0 ? "feed" : "region"}
          aria-label={`${conversation.title} messages`}
        >
          {conversation.messages.length === 0 ? <EmptyConversation compact /> : null}
          {conversation.messages.map((message) =>
            message.role === "user" ? (
              <UserMessage
                key={message.id}
                message={message}
                conversationId={conversation.id}
                projectId={conversation.projectId}
                branchId={conversation.activeBranchId}
              />
            ) : (
              <AssistantMessage
                key={message.id}
                message={message}
                conversationId={conversation.id}
                projectId={conversation.projectId}
                branchId={conversation.activeBranchId}
                visibleBranches={branchMapEntries}
                onNavigateBranch={navigateBranch}
                onOpenBranchMap={() => setBranchMapOpen(true)}
                onAskInSideChat={setSideChatSelection}
              />
            ),
          )}
        </div>
      </div>
      {!isNearBottom ? (
        <button
          type="button"
          className="jump-latest"
          title="Jump to the latest message"
          onClick={() => {
            timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: "smooth" });
            setIsNearBottom(true);
          }}
        >
          <ArrowDown size={15} />
          Jump to latest
        </button>
      ) : null}
      <ChatComposer />
      {sideChatSelection ? (
        <SideChatDrawer
          key={`${conversation.id}:${sideChatSelection}:${sideChatInitialConvId ?? ""}`}
          selection={sideChatSelection}
          projectId={conversation.projectId}
          initialConversationId={sideChatInitialConvId}
          onClose={closeSideChat}
        />
      ) : null}
      {branchMapOpen ? <BranchMapDialog entries={branchMapEntries} nativeBranches={nativeBranches} activeBranchId={conversation.activeBranchId} nativeAvailable={nativeBranchAvailable} pendingBranchId={pendingBranchId} switchError={branchSwitchError} onActivate={(branchId) => { void switchNativeBranch(branchId); }} onClose={() => { setBranchMapOpen(false); setBranchSwitchError(null); }} onNavigate={scrollToMessage} /> : null}
      {conversationActionsView ? (
        <LazyLoadBoundary
          label="Conversation actions"
          resetKey={`${conversation.id}:${conversationActionsView}:${conversationActionsRetryKey}`}
          errorClassName="modal-scrim dialog-scrim--loading"
          onDismiss={() => setConversationActionsView(null)}
          onRetry={() => setConversationActionsRetryKey((value) => value + 1)}
        >
          <Suspense fallback={<ConversationActionsLoadingState />}>
            <LazyConversationActionsDialog
              conversation={conversation}
              initialView={conversationActionsView}
              onClose={() => setConversationActionsView(null)}
            />
          </Suspense>
        </LazyLoadBoundary>
      ) : null}
    </section>
  );
}
