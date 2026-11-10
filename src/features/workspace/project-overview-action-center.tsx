import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  ListChecks,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { ProjectOverviewChat } from "./project-overview";
import type {
  ProjectOverviewTabId,
  ProjectOverviewTargetTab,
} from "./project-overview-tabs-contract";
import type { ProjectContextHealth } from "./project-context-availability-contract";
import type { ProjectOverviewView } from "./types";

export type ProjectOverviewActionFilter = "all" | "attention" | "ready" | "staged";
export type ProjectOverviewActionStatus = "attention" | "ready" | "planned";

export type ProjectOverviewAction = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly detail: string;
  readonly status: ProjectOverviewActionStatus;
  readonly targetLabel: string;
  readonly targetTab?: ProjectOverviewTargetTab;
  readonly canonicalTab?: ProjectOverviewTabId;
  readonly chatId?: string;
  readonly kind: "refresh" | "overview-tab" | "chat" | "chat-list" | "local";
};

export type BuildProjectOverviewActionsInput = {
  readonly overview: ProjectOverviewView;
  readonly contextHealth: ProjectContextHealth;
  readonly recentChats?: readonly ProjectOverviewChat[];
  readonly canRefresh?: boolean;
  readonly canOpenChat?: boolean;
  readonly canOpenChatList?: boolean;
  readonly canOpenOverviewTab?: boolean;
};

function latestChat(recentChats: readonly ProjectOverviewChat[]): ProjectOverviewChat | undefined {
  // The overview caller already supplies its bounded recent-chat projection;
  // preserve that order rather than pretending a human-readable label is a
  // timestamp that can be sorted reliably.
  return recentChats.at(-1);
}

function contextDetail(contextHealth: ProjectContextHealth): { status: ProjectOverviewActionStatus; detail: string } {
  if (contextHealth === "ready") {
    return { status: "ready", detail: "Context projection is marked ready; native compile evidence is still separate." };
  }
  if (contextHealth === "missing-access") {
    return { status: "attention", detail: "Workspace access is unavailable in this projection." };
  }
  if (contextHealth === "over-budget") {
    return { status: "attention", detail: "The visible context projection is over budget." };
  }
  return { status: "attention", detail: `Context is ${contextHealth}; inspect before relying on it.` };
}

/**
 * Build a small, deterministic action queue from Project Overview facts.
 * This helper intentionally has no side effects and never infers native
 * execution authority from a renderer status.
 */
export function buildProjectOverviewActions({
  overview,
  contextHealth,
  recentChats = [],
  canRefresh = false,
  canOpenChat = false,
  canOpenChatList = false,
  canOpenOverviewTab = false,
}: BuildProjectOverviewActionsInput): ProjectOverviewAction[] {
  const actions: ProjectOverviewAction[] = [];
  const attention = overview.attentionItems.filter((item) => item.trim());
  const evidence = overview.verifiedEvidence;
  const context = contextDetail(contextHealth);
  const chat = latestChat(recentChats);

  actions.push({
    id: "overview-refresh-candidate",
    label: "Review an overview refresh candidate",
    description: canRefresh
      ? "Create a read-only candidate from the current overview surface."
      : "Refresh is not connected in this Project Overview surface.",
    detail: canRefresh ? "Candidate remains reversible until a native acceptance exists." : "Host refresh callback unavailable",
    status: canRefresh ? "ready" : "planned",
    targetLabel: "Overview refresh",
    kind: "refresh",
  });

  actions.push({
    id: "overview-context-readiness",
    label: contextHealth === "ready" ? "Inspect context readiness" : "Resolve context readiness",
    description: "Open the context projection and keep access, compile, and retrieval gaps explicit.",
    detail: context.detail,
    status: context.status,
    targetLabel: "Context",
    targetTab: "context",
    canonicalTab: "context",
    kind: "overview-tab",
  });

  if (attention.length > 0) {
    actions.push({
      id: "overview-attention-items",
      label: "Review blocking decisions",
      description: "Inspect the visible attention list before broadening scope or starting work.",
      detail: `${attention.length} attention item(s) are present in the current projection.`,
      status: "attention",
      targetLabel: "Mission frame",
      kind: "local",
    });
  }

  if (overview.nextTask?.trim()) {
    actions.push({
      id: "overview-next-task",
      label: `Continue “${overview.nextTask.trim()}”`,
      description: "Keep the next dependency-complete task visible while you choose a work surface.",
      detail: overview.phase?.trim() ? `Phase: ${overview.phase.trim()}` : "Task is visible in the overview projection.",
      status: "ready",
      targetLabel: "Overview task",
      kind: "local",
    });
  } else {
    actions.push({
      id: "overview-plan-gap",
      label: "Draft the next dependency-complete task",
      description: "No next task is hydrated; shape one in the planning surface when available.",
      detail: "No durable task mutation is available from this preview.",
      status: "planned",
      targetLabel: "Planning",
      kind: "local",
    });
  }

  if (evidence.length > 0) {
    const stale = evidence.some((item) => /stale|unknown/i.test(item.freshnessLabel ?? ""));
    actions.push({
      id: "overview-evidence-freshness",
      label: stale ? "Review stale evidence" : "Inspect verified evidence",
      description: "Open the evidence-linked part of the overview before treating a fact as current.",
      detail: stale ? "At least one evidence freshness label needs review." : `${evidence.length} evidence record(s) are visible.`,
      status: stale ? "attention" : "ready",
      targetLabel: "Evidence",
      kind: "local",
    });
  } else {
    actions.push({
      id: "overview-evidence-gap",
      label: "Reconcile missing evidence",
      description: "Keep unknown provenance visible instead of treating the overview as verified.",
      detail: "No verified evidence record is hydrated in this renderer projection.",
      status: "attention",
      targetLabel: "Evidence",
      kind: "local",
    });
  }

  if (chat) {
    const attentionChat = chat.runState === "failed" || chat.hasDraft;
    actions.push({
      id: "overview-latest-chat",
      label: attentionChat ? `Review latest Chat: ${chat.title}` : `Continue latest Chat: ${chat.title}`,
      description: "Open the latest visible Project Chat without changing ownership or creating a run.",
      detail: chat.runState === "failed" ? "Latest Chat needs attention." : chat.hasDraft ? "Latest Chat has a draft." : "Latest Chat is ready to continue.",
      status: attentionChat ? "attention" : "ready",
      targetLabel: "Recent Chat",
      chatId: chat.id,
      kind: "chat",
    });
  } else {
    actions.push({
      id: "overview-chat-list",
      label: "Open the Project Chat list",
      description: "Inspect the Project Chat surface before starting new work.",
      detail: canOpenChatList ? "Chat list callback is connected." : "Chat list callback unavailable in this surface.",
      status: canOpenChatList ? "ready" : "planned",
      targetLabel: "Conversations",
      canonicalTab: "conversations",
      targetTab: "chats",
      kind: "chat-list",
    });
  }

  return actions.map((action) => {
    if (action.kind === "chat" && !canOpenChat) {
      return { ...action, status: "planned" as const, detail: `${action.detail} · Chat callback unavailable` };
    }
    if (action.kind === "chat-list" && !canOpenChatList) {
      return { ...action, status: "planned" as const };
    }
    if (action.kind === "overview-tab" && !canOpenOverviewTab) {
      return { ...action, status: "planned" as const, detail: `${action.detail} · Overview navigation unavailable` };
    }
    return action;
  });
}

function actionIcon(action: ProjectOverviewAction) {
  if (action.kind === "refresh") return <RefreshCw size={15} aria-hidden="true" />;
  if (action.kind === "chat" || action.kind === "chat-list") return <MessageSquareText size={15} aria-hidden="true" />;
  if (action.status === "attention") return <AlertTriangle size={15} aria-hidden="true" />;
  if (action.kind === "overview-tab") return <Sparkles size={15} aria-hidden="true" />;
  return <ListChecks size={15} aria-hidden="true" />;
}

export function ProjectOverviewActionCenter({
  overview,
  contextHealth,
  recentChats = [],
  onRefresh,
  onOpenChat,
  onOpenChatList,
  onOpenOverviewTab,
}: {
  readonly overview: ProjectOverviewView;
  readonly contextHealth: ProjectContextHealth;
  readonly recentChats?: readonly ProjectOverviewChat[];
  readonly onRefresh?: () => void;
  readonly onOpenChat?: (conversationId: string) => void;
  readonly onOpenChatList?: () => void;
  readonly onOpenOverviewTab?: (tab: ProjectOverviewTabId, targetTab?: ProjectOverviewTargetTab) => void;
}) {
  const actions = useMemo(
    () => buildProjectOverviewActions({
      overview,
      contextHealth,
      recentChats,
      canRefresh: Boolean(onRefresh),
      canOpenChat: Boolean(onOpenChat),
      canOpenChatList: Boolean(onOpenChatList),
      canOpenOverviewTab: Boolean(onOpenOverviewTab),
    }),
    [contextHealth, onOpenChat, onOpenChatList, onOpenOverviewTab, onRefresh, overview, recentChats],
  );
  const [filter, setFilter] = useState<ProjectOverviewActionFilter>("all");
  const [stagedIds, setStagedIds] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState("Overview actions are renderer-local and ready to stage.");

  const visibleActions = actions.filter((action) => {
    if (filter === "staged") return stagedIds.has(action.id);
    if (filter === "attention") return action.status === "attention" && !stagedIds.has(action.id);
    if (filter === "ready") return action.status === "ready" && !stagedIds.has(action.id);
    return true;
  });

  const stage = (action: ProjectOverviewAction) => {
    if (action.kind === "refresh") {
      if (!onRefresh) {
        setStatus("Overview refresh is unavailable here; no candidate was created.");
        return;
      }
      onRefresh();
    } else if (action.kind === "chat" && action.chatId) {
      if (!onOpenChat) {
        setStatus("Chat navigation is unavailable here; no Chat was opened.");
        return;
      }
      onOpenChat(action.chatId);
    } else if (action.kind === "chat-list") {
      if (!onOpenChatList) {
        setStatus("Chat list navigation is unavailable here; no route was opened.");
        return;
      }
      onOpenChatList();
    } else if (action.kind === "overview-tab" && action.canonicalTab) {
      if (!onOpenOverviewTab) {
        setStatus("Overview navigation is unavailable here; no route was opened.");
        return;
      }
      onOpenOverviewTab(action.canonicalTab, action.targetTab);
    }
    setStagedIds((current) => new Set(current).add(action.id));
    setStatus(`Staged “${action.label}” in this renderer preview; no native write was performed.`);
  };

  const toggleStaged = (action: ProjectOverviewAction) => {
    setStagedIds((current) => {
      const next = new Set(current);
      if (next.has(action.id)) next.delete(action.id);
      else next.add(action.id);
      return next;
    });
    setStatus(`${stagedIds.has(action.id) ? "Reopened" : "Marked staged"} “${action.label}” in this renderer session.`);
  };

  return (
    <section className="project-overview-action-center" aria-label="Overview action center" aria-labelledby="project-overview-action-center-title">
      <header className="project-overview-action-center__header">
        <div>
          <span className="eyebrow"><ShieldCheck size={12} aria-hidden="true" /> Overview action center</span>
          <h4 id="project-overview-action-center-title">Overview action center · Choose the next useful move</h4>
          <p>Actions are derived from visible overview facts. Stage or reopen them in this session; they are not a task runner.</p>
        </div>
        <span className="project-overview-action-center__boundary">Preview only</span>
      </header>
      <div className="project-overview-action-center__toolbar" role="toolbar" aria-label="Project Overview action controls">
        <label>
          <span>Show</span>
          <select aria-label="Filter Project Overview actions" value={filter} onChange={(event) => setFilter(event.target.value as ProjectOverviewActionFilter)}>
            <option value="all">All actions</option>
            <option value="attention">Needs attention</option>
            <option value="ready">Ready</option>
            <option value="staged">Staged</option>
          </select>
        </label>
        <span className="project-overview-action-center__count">{stagedIds.size}/{actions.length} staged</span>
        <span className="project-overview-action-center__status" role="status" aria-live="polite">{status}</span>
      </div>
      <div className="project-overview-action-center__list" aria-live="polite">
        {visibleActions.length > 0 ? visibleActions.map((action) => {
          const staged = stagedIds.has(action.id);
          const unavailable = action.status === "planned";
          return (
            <article key={action.id} className={`project-overview-action-center__row project-overview-action-center__row--${action.status}${staged ? " is-staged" : ""}`}>
              <span className="project-overview-action-center__icon" aria-hidden="true">{actionIcon(action)}</span>
              <div className="project-overview-action-center__copy">
                <div className="project-overview-action-center__title"><strong>{action.label}</strong><span>{action.status === "attention" ? "Attention" : action.status === "ready" ? "Ready" : "Planned"}</span></div>
                <p>{action.description}</p>
                <small>{action.targetLabel} · {action.detail}</small>
              </div>
              <div className="project-overview-action-center__actions">
                <button type="button" className="button button--secondary" onClick={() => stage(action)} disabled={unavailable} aria-label={`Stage ${action.label}`} title={unavailable ? "This action is not connected in the current preview." : `Stage ${action.label}`}><ArrowRight size={13} /> Stage</button>
                <button type="button" className="button button--ghost" onClick={() => toggleStaged(action)} aria-pressed={staged} aria-label={staged ? `Reopen ${action.label}` : `Mark ${action.label} staged`}>{staged ? <CheckCircle2 size={13} /> : <Check size={13} />}</button>
              </div>
            </article>
          );
        }) : <div className="project-overview-action-center__empty"><Clock3 size={17} /><strong>No actions in this view</strong><small>Change the filter or reopen a staged action.</small></div>}
      </div>
      <p className="project-overview-action-center__boundary-note"><ShieldCheck size={13} aria-hidden="true" /> No provider request, filesystem read, durable task write, or native execution is performed.</p>
    </section>
  );
}

export default ProjectOverviewActionCenter;
