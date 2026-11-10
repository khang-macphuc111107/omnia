import {
  ArrowRight,
  Check,
  CheckCircle2,
  Clipboard,
  CircleAlert,
  Download,
  FileJson2,
  FolderOpen,
  Gauge,
  ListChecks,
  MessageSquareText,
  Route,
  ShieldCheck,
  Target,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { ConversationView, ProjectView } from "./types";

export type ProjectDeckNextActionTarget = "snapshot" | "chats" | "context" | "plan" | "model" | "access" | "handoff";
export type ProjectDeckNextActionFilter = "all" | "attention" | "ready" | "completed";

export type ProjectDeckNextAction = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly target: ProjectDeckNextActionTarget;
  readonly targetLabel: string;
  readonly status: "attention" | "ready";
  readonly detail: string;
  readonly chatId?: string;
  readonly requiresHostCallback?: "new-chat" | "add-folder" | "open-chat";
};

export type BuildProjectDeckNextActionsInput = {
  readonly project: ProjectView;
  readonly conversations: readonly ConversationView[];
  readonly canOpenChat?: boolean;
  readonly canCreateChat?: boolean;
  readonly canAddFolder?: boolean;
};

/**
 * Builds a small, evidence-bound action queue from facts already visible to
 * the renderer. It deliberately does not inspect files, call providers, or
 * infer native execution state.
 */
export function buildProjectDeckNextActions({
  project,
  conversations,
  canOpenChat = false,
  canCreateChat = false,
  canAddFolder = false,
}: BuildProjectDeckNextActionsInput): ProjectDeckNextAction[] {
  const latestChat = [...conversations].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  const actions: ProjectDeckNextAction[] = [];

  if (project.contextHealth === "missing-access" || project.folders.length === 0) {
    actions.push({
      id: "workspace-access",
      label: project.folders.length === 0 ? "Add a workspace folder" : "Restore workspace access",
      description: project.folders.length === 0
        ? "Give this Project a visible workspace root before context work begins."
        : "Review the folder grant before relying on project context.",
      target: "access",
      targetLabel: "Access",
      status: "attention",
      detail: project.contextHealth === "missing-access" ? "Access is unavailable" : "No folder grant is visible",
      requiresHostCallback: "add-folder",
    });
  } else if (project.contextHealth !== "ready") {
    actions.push({
      id: "context-readiness",
      label: "Review context readiness",
      description: "Inspect the context workbench and keep compile/indexing gaps explicit.",
      target: "context",
      targetLabel: "Context",
      status: "attention",
      detail: project.contextHealth === "over-budget" ? "Context is over budget" : `Context is ${project.contextHealth}`,
    });
  } else {
    actions.push({
      id: "context-receipt",
      label: "Inspect the context receipt",
      description: "Review the current context projection before starting a run.",
      target: "context",
      targetLabel: "Context",
      status: "ready",
      detail: "Context is marked ready in the renderer projection",
    });
  }

  if (project.overview?.nextTask?.trim()) {
    actions.push({
      id: "overview-next-task",
      label: `Review “${project.overview.nextTask.trim()}”`,
      description: "Carry the visible project task into the planning surface or a handoff preview.",
      target: "plan",
      targetLabel: "Plan",
      status: "ready",
      detail: project.overview.phase ? `Phase: ${project.overview.phase}` : "Read-only overview task",
    });
  } else {
    actions.push({
      id: "planning-start",
      label: "Draft the next project task",
      description: "Open the planning surface to shape a bounded task before a chat run.",
      target: "plan",
      targetLabel: "Plan",
      status: "ready",
      detail: "No durable next task is hydrated",
    });
  }

  if (latestChat) {
    actions.push({
      id: "latest-chat",
      label: "Continue the latest project Chat",
      description: "Open the most recently updated Chat without changing project ownership.",
      target: "chats",
      targetLabel: "Chats",
      status: latestChat.runState === "failed" || latestChat.hasDraft ? "attention" : "ready",
      detail: latestChat.runState === "failed" ? "Latest Chat needs attention" : latestChat.hasDraft ? "Latest Chat has a draft" : "Latest Chat is ready",
      chatId: latestChat.id,
      requiresHostCallback: "open-chat",
    });
  } else {
    actions.push({
      id: "new-chat",
      label: "Start the first project Chat",
      description: "Open a new project Chat entry point and keep the setup in the current preview.",
      target: "chats",
      targetLabel: "Chats",
      status: "ready",
      detail: "No project Chat is visible yet",
      requiresHostCallback: "new-chat",
    });
  }

  actions.push({
    id: "model-route",
    label: project.modelProfileId && project.modelProfileId !== "auto" ? "Review the project model route" : "Choose a model direction",
    description: "Inspect route inheritance and response preferences before a future run.",
    target: "model",
    targetLabel: "Model",
    status: "ready",
    detail: project.modelProfileId && project.modelProfileId !== "auto" ? `Profile: ${project.modelProfileId}` : "Automatic route preview",
  });

  if (project.overview?.attentionItems.some((item) => item.trim())) {
    actions.push({
      id: "handoff-attention",
      label: "Prepare a handoff for attention items",
      description: "Review the visible attention list and stage a renderer-local handoff package.",
      target: "handoff",
      targetLabel: "Handoff",
      status: "attention",
      detail: `${project.overview.attentionItems.filter((item) => item.trim()).length} attention item(s) are visible`,
    });
  }

  // Keep the queue useful at a glance while preserving a deterministic order.
  // The user can still inspect the full exported brief from this surface.
  return actions.slice(0, 6).map((action) => {
    if (action.requiresHostCallback === "open-chat" && !canOpenChat) return { ...action, detail: `${action.detail} · host callback unavailable` };
    if (action.requiresHostCallback === "new-chat" && !canCreateChat) return { ...action, detail: `${action.detail} · host callback unavailable` };
    if (action.requiresHostCallback === "add-folder" && !canAddFolder) return { ...action, detail: `${action.detail} · host callback unavailable` };
    return action;
  });
}

function actionIcon(action: ProjectDeckNextAction) {
  if (action.id === "workspace-access") return <FolderOpen size={15} aria-hidden="true" />;
  if (action.id === "context-readiness" || action.id === "context-receipt") return <Gauge size={15} aria-hidden="true" />;
  if (action.id === "overview-next-task" || action.id === "planning-start") return <ListChecks size={15} aria-hidden="true" />;
  if (action.id === "latest-chat" || action.id === "new-chat") return <MessageSquareText size={15} aria-hidden="true" />;
  if (action.id === "model-route") return <Route size={15} aria-hidden="true" />;
  return <Target size={15} aria-hidden="true" />;
}

function actionPlanText(project: ProjectView, actions: readonly ProjectDeckNextAction[], completedIds: ReadonlySet<string>): string {
  return [
    `# ${project.name} · next action brief`,
    "",
    "> Renderer-local preview only; no native execution, provider request, or durable write was performed.",
    "",
    ...actions.map((action, index) => `${index + 1}. [${completedIds.has(action.id) ? "x" : " "}] ${action.label} — ${action.targetLabel} · ${action.detail}`),
  ].join("\n");
}

export function ProjectNextActionsPreview({
  project,
  conversations,
  onNavigate,
  onOpenChat,
  onNewChat,
  onAddFolder,
}: {
  readonly project: ProjectView;
  readonly conversations: readonly ConversationView[];
  readonly onNavigate: (target: ProjectDeckNextActionTarget) => void;
  readonly onOpenChat?: (conversationId: string) => void;
  readonly onNewChat?: () => void;
  readonly onAddFolder?: () => void;
}) {
  const actions = useMemo(
    () => buildProjectDeckNextActions({
      project,
      conversations,
      canOpenChat: Boolean(onOpenChat),
      canCreateChat: Boolean(onNewChat),
      canAddFolder: Boolean(onAddFolder),
    }),
    [conversations, onAddFolder, onNewChat, onOpenChat, project],
  );
  const [filter, setFilter] = useState<ProjectDeckNextActionFilter>("all");
  const [completedIds, setCompletedIds] = useState<Set<string>>(() => new Set());
  const [stagedId, setStagedId] = useState<string | null>(null);
  const [status, setStatus] = useState("Actions are renderer-local and ready to stage.");
  const [briefOpen, setBriefOpen] = useState(false);
  const [copyLabel, setCopyLabel] = useState("Copy brief");

  const visibleActions = actions.filter((action) => {
    if (filter === "completed") return completedIds.has(action.id);
    if (filter === "attention") return action.status === "attention" && !completedIds.has(action.id);
    if (filter === "ready") return action.status === "ready" && !completedIds.has(action.id);
    return true;
  });
  const brief = actionPlanText(project, actions, completedIds);

  const stageAction = (action: ProjectDeckNextAction) => {
    if (action.requiresHostCallback === "new-chat") {
      if (!onNewChat) {
        setStatus("New Chat host callback is unavailable; no native Chat was created.");
        return;
      }
      onNewChat();
    } else if (action.requiresHostCallback === "add-folder") {
      if (!onAddFolder) {
        setStatus("Folder grant host callback is unavailable; no native folder was added.");
        return;
      }
      onAddFolder();
    } else if (action.requiresHostCallback === "open-chat") {
      if (!onOpenChat || !action.chatId) {
        setStatus("Chat navigation host callback is unavailable; no Chat was opened.");
        return;
      }
      onOpenChat(action.chatId);
    } else {
      onNavigate(action.target);
    }
    setStagedId(action.id);
    setStatus(`Staged “${action.label}” in this renderer preview; no native write was performed.`);
  };

  const toggleComplete = (action: ProjectDeckNextAction) => {
    setCompletedIds((current) => {
      const next = new Set(current);
      if (next.has(action.id)) next.delete(action.id);
      else next.add(action.id);
      return next;
    });
    setStatus(`${completedIds.has(action.id) ? "Reopened" : "Marked complete"} “${action.label}” in this renderer session.`);
  };

  const copyBrief = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no brief was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(brief);
      setCopyLabel("Copied");
      setStatus("Copied the renderer-local next action brief.");
      window.setTimeout(() => setCopyLabel("Copy brief"), 1200);
    } catch {
      setStatus("Clipboard access was denied; no brief was copied.");
    }
  };

  const downloadBrief = () => {
    if (typeof URL.createObjectURL !== "function") {
      setStatus("File download is unavailable; no brief was exported.");
      return;
    }
    const url = URL.createObjectURL(new Blob([brief], { type: "text/markdown" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "omnia-project-next-actions.md";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus("Downloaded the renderer-local next action brief; no native project state changed.");
  };

  return (
    <section className="project-next-actions" aria-labelledby={`project-next-actions-title-${project.id}`}>
      <header className="project-next-actions__header">
        <div>
          <span className="eyebrow"><Target size={12} aria-hidden="true" /> Next actions</span>
          <h3 id={`project-next-actions-title-${project.id}`}>Project next actions · a short queue for the next useful move</h3>
          <p>Generated from visible Project facts; stage, complete, and export are session-only previews.</p>
        </div>
        <span className="project-next-actions__boundary"><ShieldCheck size={12} aria-hidden="true" /> Preview only</span>
      </header>

      <div className="project-next-actions__toolbar" role="toolbar" aria-label="Project next action controls">
        <label><span>Show</span><select aria-label="Filter project next actions" value={filter} onChange={(event) => setFilter(event.target.value as ProjectDeckNextActionFilter)}><option value="all">All actions</option><option value="attention">Needs attention</option><option value="ready">Ready</option><option value="completed">Completed</option></select></label>
        <span className="project-next-actions__count">{completedIds.size}/{actions.length} complete</span>
        <button type="button" className="button button--ghost" onClick={() => setBriefOpen((value) => !value)} aria-expanded={briefOpen} aria-controls={`project-next-actions-brief-${project.id}`}><FileJson2 size={13} /> {briefOpen ? "Hide brief" : "Preview brief"}</button>
      </div>

      <div className="project-next-actions__list" aria-live="polite">
        {visibleActions.length > 0 ? visibleActions.map((action) => {
          const completed = completedIds.has(action.id);
          const hostUnavailable = Boolean(action.requiresHostCallback && ((action.requiresHostCallback === "new-chat" && !onNewChat) || (action.requiresHostCallback === "add-folder" && !onAddFolder) || (action.requiresHostCallback === "open-chat" && !onOpenChat)));
          return (
            <article key={action.id} className={`project-next-actions__row${completed ? " is-complete" : ""}${stagedId === action.id ? " is-staged" : ""}`} data-action-status={action.status}>
              <span className={`project-next-actions__icon project-next-actions__icon--${action.status}`} aria-hidden="true">{actionIcon(action)}</span>
              <div className="project-next-actions__copy"><div className="project-next-actions__title"><strong>{action.label}</strong><span className={`project-next-actions__status project-next-actions__status--${action.status}`}>{action.status === "attention" ? "Attention" : "Ready"}</span></div><p>{action.description}</p><small>{action.targetLabel} · {action.detail}</small></div>
              <div className="project-next-actions__row-actions">
                <button type="button" className="button button--secondary" onClick={() => stageAction(action)} disabled={hostUnavailable} title={hostUnavailable ? "This host callback is unavailable in the current preview." : `Stage ${action.label}`}><ArrowRight size={13} /> Stage</button>
                <button type="button" className="button button--ghost" onClick={() => toggleComplete(action)} aria-pressed={completed} aria-label={completed ? `Reopen ${action.label}` : `Mark ${action.label} complete`}>{completed ? <CheckCircle2 size={13} /> : <Check size={13} />}</button>
              </div>
            </article>
          );
        }) : <div className="project-next-actions__empty"><CheckCircle2 size={18} /><strong>No actions in this view</strong><small>Change the filter or reopen a completed action.</small></div>}
      </div>

      {briefOpen ? <section id={`project-next-actions-brief-${project.id}`} className="project-next-actions__brief" aria-label="Project next action brief"><header><div><span className="eyebrow">Portable renderer brief</span><strong>Project next actions</strong></div><span className="project-next-actions__brief-chip">Session-only</span></header><pre>{brief}</pre><div className="project-next-actions__brief-actions"><button type="button" className="button button--ghost" onClick={copyBrief}><Clipboard size={13} /> {copyLabel}</button><button type="button" className="button button--ghost" onClick={downloadBrief}><Download size={13} /> Download .md</button></div><p><CircleAlert size={13} /> This brief records visible renderer projections; it is not a task runner, scheduler, or native project receipt.</p></section> : null}
      <p className="project-next-actions__status" role="status" aria-live="polite">{status}</p>
      <p className="project-next-actions__boundary-note"><ShieldCheck size={13} aria-hidden="true" /> No provider request, filesystem read, native mutation, or durable completion state is performed.</p>
    </section>
  );
}

export default ProjectNextActionsPreview;
