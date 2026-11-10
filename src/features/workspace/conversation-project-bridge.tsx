import {
  ArrowUpRight,
  CircleAlert,
  FolderKanban,
  FolderOpen,
  Layers3,
  MessageSquareText,
  Plus,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { openWorkspaceOverlay } from "./overlay-store";
import { buildProjectContextAvailabilityForProject } from "./project-context-availability-contract";
import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";

type BridgeMetricProps = {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly icon: LucideIcon;
  readonly tone?: "neutral" | "info" | "warning" | "danger" | "success";
};

function BridgeMetric({
  label,
  value,
  detail,
  icon: Icon,
  tone = "neutral",
}: BridgeMetricProps) {
  return (
    <article className={`conversation-project-bridge__metric conversation-project-bridge__metric--${tone}`}>
      <span className="conversation-project-bridge__metric-icon" aria-hidden="true">
        <Icon size={15} />
      </span>
      <span className="conversation-project-bridge__metric-copy">
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
    </article>
  );
}

function BridgeShell({
  children,
  standalone = false,
  style,
}: {
  readonly children: ReactNode;
  readonly standalone?: boolean;
  readonly style?: CSSProperties;
}) {
  return (
    <section
      className={standalone ? "conversation-project-bridge conversation-project-bridge--standalone" : "conversation-project-bridge"}
      style={style}
      aria-label="Project continuity"
    >
      {children}
    </section>
  );
}

/**
 * Visible Chat <-> Project bridge for the renderer preview.
 *
 * It exposes the selected Project's safe display projection and navigation
 * affordances, but never treats a visual Project association as proof that
 * context was compiled, a provider was called, or a native route persisted.
 */
export function ConversationProjectBridge({
  conversation,
}: {
  readonly conversation: ConversationView;
}) {
  const projects = useWorkspaceStore((state) => state.projects);
  const conversations = useWorkspaceStore((state) => state.conversations);
  const selectProject = useWorkspaceStore((state) => state.selectProject);
  const setActivity = useWorkspaceStore((state) => state.setActivity);

  const project = conversation.projectId
    ? projects.find((candidate) => candidate.id === conversation.projectId) ?? null
    : null;
  const activeProjectChats = project
    ? conversations.filter(
        (candidate) => candidate.projectId === project.id && candidate.archived === false,
      )
    : [];

  if (!project) {
    const linkedProjectMissing = conversation.projectId !== null;
    const heading = linkedProjectMissing ? "Project link needs review" : "Standalone continuity";
    const description = linkedProjectMissing
      ? "This Chat points to a Project that is not visible in the current renderer snapshot. Browse Projects before treating it as an active scope."
      : "This Chat has no Project context attached. Keep it local, or choose a Project workspace for the next step.";

    return (
      <BridgeShell standalone>
        <header className="conversation-project-bridge__header">
          <span className="conversation-project-bridge__icon" aria-hidden="true">
            {linkedProjectMissing ? <CircleAlert size={17} /> : <Sparkles size={17} />}
          </span>
          <span className="conversation-project-bridge__copy">
            <small>Chat to Project</small>
            <strong>{heading}</strong>
            <em>{description}</em>
          </span>
          <span className="conversation-project-bridge__badge"><ShieldCheck size={12} /> Preview only</span>
        </header>

        <div className="conversation-project-bridge__metrics" aria-label="Standalone continuity facts">
          <BridgeMetric
            label="Project context"
            value={linkedProjectMissing ? "Unavailable" : "Not attached"}
            detail={linkedProjectMissing ? "Visible Project link is missing" : "Conversation-local history"}
            icon={Layers3}
            tone={linkedProjectMissing ? "danger" : "neutral"}
          />
          <BridgeMetric
            label="Current lane"
            value="Standalone Chat"
            detail={conversation.hasDraft ? "Draft stays renderer-local" : "Ready to continue"}
            icon={MessageSquareText}
            tone="info"
          />
          <BridgeMetric
            label="Workspace grants"
            value="0 visible"
            detail="No Project folder scope attached"
            icon={FolderOpen}
          />
        </div>

        <div className="conversation-project-bridge__actions" role="toolbar" aria-label="Standalone continuity actions">
          <button type="button" className="button button--secondary" onClick={() => setActivity("projects")}>
            <FolderKanban size={14} /> Browse Projects
          </button>
          <button type="button" className="button button--ghost" onClick={() => openWorkspaceOverlay({ kind: "create-project" })}>
            <Plus size={14} /> Create Project
          </button>
        </div>

        <p className="conversation-project-bridge__boundary">
          <CircleAlert size={13} aria-hidden="true" /> Renderer-local navigation only. This does not attach the Chat, compile context, read or write files, call a provider, dispatch an agent, or persist a route.
        </p>
      </BridgeShell>
    );
  }

  const contextAvailability = buildProjectContextAvailabilityForProject(project);
  const bridgeStyle = { "--conversation-project-accent": project.accent } as CSSProperties;

  return (
    <BridgeShell style={bridgeStyle}>
      <header className="conversation-project-bridge__header">
        <span className="conversation-project-bridge__icon" aria-hidden="true">
          <FolderKanban size={17} />
        </span>
        <span className="conversation-project-bridge__copy">
          <small>Chat to Project</small>
          <strong>Project continuity · {project.name}</strong>
          <em>{project.description || "Keep this Chat inside the visible Project boundary."}</em>
        </span>
        <span className="conversation-project-bridge__badge"><ShieldCheck size={12} /> Preview only</span>
      </header>

      <div className="conversation-project-bridge__metrics" aria-label={`${project.name} continuity facts`}>
        <BridgeMetric
          label="Project context"
          value={contextAvailability.shortLabel}
          detail={contextAvailability.reason}
          icon={Layers3}
          tone={contextAvailability.tone}
        />
        <BridgeMetric
          label="Active project Chats"
          value={`${activeProjectChats.length}`}
          detail={activeProjectChats.length === 1 ? "One visible active Chat" : "Visible active Chats in this Project"}
          icon={MessageSquareText}
          tone="info"
        />
        <BridgeMetric
          label="Read-only workspace grants"
          value={`${project.folders.length}`}
          detail={project.folders.length === 1 ? "One renderer-visible folder reference" : "Renderer-visible folder references"}
          icon={FolderOpen}
          tone={project.folders.some((folder) => folder.state === "offline" || folder.state === "permission-lost") ? "warning" : "neutral"}
        />
      </div>

      <div className="conversation-project-bridge__actions" role="toolbar" aria-label="Project continuity actions">
        <button type="button" className="button button--secondary" onClick={() => selectProject(project.id)}>
          <ArrowUpRight size={14} /> Open project overview
        </button>
        <button type="button" className="button button--ghost" onClick={() => openWorkspaceOverlay({ kind: "start-conversation", projectId: project.id })}>
          <Plus size={14} /> New project Chat
        </button>
      </div>

      <p className="conversation-project-bridge__boundary">
        <CircleAlert size={13} aria-hidden="true" /> Renderer-local bridge. It does not compile context, read or write workspace files, send a provider request, dispatch an agent, or create durable Project/Chat routing state.
      </p>
    </BridgeShell>
  );
}
