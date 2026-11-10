import {
  Activity,
  ArrowRight,
  Brain,
  CheckCircle2,
  CircleAlert,
  FolderOpen,
  Gauge,
  MessageSquareText,
  Plus,
  Settings2,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import type { ActivityId } from "./activity-registry";

export interface HomeMissionControlProps {
  readonly activeBackgroundWorkCount: number;
  readonly attentionCount: number;
  readonly unreadCount: number;
  readonly conversationCount: number;
  readonly projectCount: number;
  readonly enabledSkillCount: number;
  readonly providerCount: number;
  readonly onCreateChat: () => void;
  readonly onCreateProject: () => void;
  readonly onNavigate: (activity: ActivityId) => void;
}

interface FocusAction {
  readonly icon: LucideIcon;
  readonly eyebrow: string;
  readonly title: string;
  readonly detail: string;
  readonly label: string;
  readonly tone: "coral" | "amber" | "blue" | "green" | "teal";
  readonly run: () => void;
}

interface ReadinessMetric {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value: number;
  readonly detail: string;
  readonly tone: "blue" | "green" | "amber" | "teal";
}

function deriveFocusAction(props: HomeMissionControlProps): FocusAction {
  if (props.attentionCount > 0) {
    return {
      icon: CircleAlert,
      eyebrow: "Priority queue",
      title: `${props.attentionCount} item${props.attentionCount === 1 ? "" : "s"} need attention`,
      detail: "Review the visible run and checkpoint projection before starting more work.",
      label: "Inspect background work",
      tone: "coral",
      run: () => props.onNavigate("work"),
    };
  }

  if (props.unreadCount > 0) {
    return {
      icon: MessageSquareText,
      eyebrow: "Conversation queue",
      title: `${props.unreadCount} unread chat${props.unreadCount === 1 ? "" : "s"}`,
      detail: "Pick up the latest replies and keep your active context in one place.",
      label: "Open unread chats",
      tone: "amber",
      run: () => props.onNavigate("chats"),
    };
  }

  if (props.activeBackgroundWorkCount > 0) {
    return {
      icon: Activity,
      eyebrow: "Live workspace",
      title: `${props.activeBackgroundWorkCount} active run${props.activeBackgroundWorkCount === 1 ? "" : "s"}`,
      detail: "Continue observing the renderer-safe run projection while work is in flight.",
      label: "Open active work",
      tone: "blue",
      run: () => props.onNavigate("work"),
    };
  }

  if (props.providerCount === 0) {
    return {
      icon: Settings2,
      eyebrow: "Workspace setup",
      title: "Choose a provider route",
      detail: "Review the provider catalog and routing preview before your next conversation.",
      label: "Open Control Center",
      tone: "teal",
      run: () => props.onNavigate("settings"),
    };
  }

  if (props.conversationCount === 0) {
    return {
      icon: Sparkles,
      eyebrow: "Fresh workspace",
      title: "Start your first conversation",
      detail: "Create a chat and turn this workspace into a useful command center.",
      label: "New chat",
      tone: "green",
      run: props.onCreateChat,
    };
  }

  return {
    icon: CheckCircle2,
    eyebrow: "Workspace ready",
    title: "Pick up where you left off",
    detail: "No visible attention items right now. Continue a chat or shape a project around it.",
    label: "Open chats",
    tone: "green",
    run: () => props.onNavigate("chats"),
  };
}

export function HomeMissionControl(props: HomeMissionControlProps) {
  const focus = deriveFocusAction(props);
  const FocusIcon = focus.icon;
  const readiness: readonly ReadinessMetric[] = [
    {
      icon: MessageSquareText,
      label: "Conversations",
      value: props.conversationCount,
      detail: "visible threads",
      tone: "blue",
    },
    {
      icon: FolderOpen,
      label: "Projects",
      value: props.projectCount,
      detail: "workspace scopes",
      tone: "green",
    },
    {
      icon: Brain,
      label: "Skills",
      value: props.enabledSkillCount,
      detail: "enabled previews",
      tone: "amber",
    },
    {
      icon: Gauge,
      label: "Providers",
      value: props.providerCount,
      detail: "catalog entries",
      tone: "teal",
    },
  ];

  return (
    <section className="home-mission-control" aria-labelledby="home-mission-control-heading">
      <header className="home-mission-control__header">
        <div>
          <span className="home-mission-control__eyebrow"><Sparkles size={13} /> Mission control</span>
          <h2 id="home-mission-control-heading">Your next best move</h2>
          <p>One glance at the workspace, then jump directly into the work that matters.</p>
        </div>
        <span className="home-pulse-badge"><Wrench size={13} /> Renderer preview</span>
      </header>
      <div className="home-mission-control__body">
        <article className={`home-mission-focus home-mission-focus--${focus.tone}`}>
          <span className="home-mission-focus__icon"><FocusIcon size={21} /></span>
          <div className="home-mission-focus__copy">
            <small>{focus.eyebrow}</small>
            <strong>{focus.title}</strong>
            <p>{focus.detail}</p>
          </div>
          <button type="button" className="button button--secondary" title={focus.label === "Open unread chats" ? "Open conversations with unread messages" : `Run: ${focus.label}`} onClick={focus.run}>
            {focus.label} <ArrowRight size={14} />
          </button>
        </article>
        <div className="home-mission-readiness" aria-label="Workspace readiness">
          {readiness.map(({ icon: Icon, label, value, detail, tone }) => (
            <div key={label} className={`home-mission-metric home-mission-metric--${tone}`}>
              <span><Icon size={14} /></span>
              <strong>{value}</strong>
              <small>{label}</small>
              <em>{detail}</em>
            </div>
          ))}
        </div>
      </div>
      <nav className="home-mission-actions" aria-label="Mission control shortcuts">
        <button type="button" title="Start a new Chat" onClick={props.onCreateChat}><Plus size={14} /> New chat</button>
        <button type="button" title="Create a new Project" onClick={props.onCreateProject}><FolderOpen size={14} /> New project</button>
        <button type="button" title="Open Background work" onClick={() => props.onNavigate("work")}><Activity size={14} /> Inspect work</button>
        <button type="button" title="Open Settings and Control Center" onClick={() => props.onNavigate("settings")}><Settings2 size={14} /> Control Center</button>
      </nav>
      <p className="home-mission-control__boundary">Counts and actions use the current renderer session. They do not create a native task, provider request, durable queue entry, or filesystem write.</p>
    </section>
  );
}

export { deriveFocusAction };
