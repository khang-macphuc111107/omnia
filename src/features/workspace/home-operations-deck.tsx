import {
  Activity,
  ArrowRight,
  BadgeCheck,
  ClipboardList,
  FolderPlus,
  Library,
  Milestone,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useState, type ComponentType } from "react";

import type { ActivityId } from "./activity-registry";
import { HomeLazySurface } from "./home-lazy-surface";

export interface HomeOperationsDeckProps {
  readonly conversationCount: number;
  readonly projectCount: number;
  readonly activeBackgroundWorkCount: number;
  readonly attentionCount: number;
  readonly libraryRecordCount: number;
  readonly providerCount: number;
  readonly onCreateChat: () => void;
  readonly onCreateProject: () => void;
  readonly onNavigate: (activity: ActivityId) => void;
  readonly onOpenSearch: () => void;
  readonly onOpenLibrary: () => void;
}

type OperationTone = "blue" | "green" | "coral" | "teal" | "amber" | "steel";

interface OperationCard {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly tone: OperationTone;
  readonly title: string;
  readonly description: string;
  readonly metric: string;
  readonly metricLabel: string;
  readonly actionLabel: string;
  readonly run: () => void;
}

type HomeWorkbenchId = "goals" | "automation" | "workflow" | "delivery" | "release" | "phase-cockpit" | "omnia-labs";

interface HomeWorkbenchModule {
  default: ComponentType<object>;
}

interface HomeWorkbenchDefinition {
  readonly id: HomeWorkbenchId;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly load: () => Promise<HomeWorkbenchModule>;
}

const HOME_WORKBENCHES = [
  {
    id: "goals",
    label: "Goals and tasks",
    description: "Shape a goal, split it into tasks, and keep the next step visible.",
    icon: ClipboardList,
    load: () => import("./goal-task-studio"),
  },
  {
    id: "automation",
    label: "Automation",
    description: "Inspect renderer-local automation recipes and execution intent.",
    icon: Settings2,
    load: () => import("./automation-studio-preview"),
  },
  {
    id: "workflow",
    label: "Workflow history",
    description: "Review dry-run history before treating a workflow as durable work.",
    icon: Workflow,
    load: () => import("./workflow-dry-run-history-preview"),
  },
  {
    id: "delivery",
    label: "Delivery evidence",
    description: "Read the current renderer delivery receipt and its honest limits.",
    icon: BadgeCheck,
    load: () => import("./delivery-evidence-status-preview"),
  },
  {
    id: "release",
    label: "Release evidence",
    description: "Inspect release gates without claiming a native release action.",
    icon: Library,
    load: () => import("./release-evidence-dashboard"),
  },
  {
    id: "phase-cockpit",
    label: "Phase cockpit",
    description: "Track the current work arc, blockers, and next safe boundary.",
    icon: Milestone,
    load: () => import("./phase-cockpit-preview"),
  },
  {
    id: "omnia-labs",
    label: "Omnia Labs",
    description: "Open rich composer, media, evidence, citations, and workflow surfaces.",
    icon: Sparkles,
    load: () => import("./omnia-labs-showcase-preview"),
  },
] as const satisfies readonly HomeWorkbenchDefinition[];

function workMetric(activeCount: number, attentionCount: number): Pick<OperationCard, "metric" | "metricLabel"> {
  if (attentionCount > 0) {
    return { metric: String(attentionCount), metricLabel: "attention" };
  }
  return {
    metric: String(activeCount),
    metricLabel: activeCount === 1 ? "active run" : "active runs",
  };
}

export function HomeOperationsDeck({
  conversationCount,
  projectCount,
  activeBackgroundWorkCount,
  attentionCount,
  libraryRecordCount,
  providerCount,
  onCreateChat,
  onCreateProject,
  onNavigate,
  onOpenSearch,
  onOpenLibrary,
}: HomeOperationsDeckProps) {
  const [activeWorkbenchId, setActiveWorkbenchId] = useState<HomeWorkbenchId | null>(null);
  const work = workMetric(activeBackgroundWorkCount, attentionCount);
  const activeWorkbench = HOME_WORKBENCHES.find((workbench) => workbench.id === activeWorkbenchId) ?? null;
  const operations: readonly OperationCard[] = [
    {
      id: "new-chat",
      icon: Plus,
      tone: "blue",
      title: "Start a focused chat",
      description: "Choose a route, context, and conversation mode before you begin.",
      metric: String(conversationCount),
      metricLabel: conversationCount === 1 ? "visible chat" : "visible chats",
      actionLabel: "New chat",
      run: onCreateChat,
    },
    {
      id: "new-project",
      icon: FolderPlus,
      tone: "green",
      title: "Shape a project",
      description: "Keep instructions, conversations, and scoped context together.",
      metric: String(projectCount),
      metricLabel: projectCount === 1 ? "project" : "projects",
      actionLabel: "New project",
      run: onCreateProject,
    },
    {
      id: "background-work",
      icon: Activity,
      tone: "coral",
      title: attentionCount > 0 ? "Review attention work" : "Inspect background work",
      description: attentionCount > 0
        ? "Open the visible queue and inspect the run or checkpoint that needs review."
        : "Follow active and replayed run signals without changing the queue.",
      metric: work.metric,
      metricLabel: work.metricLabel,
      actionLabel: "Open work",
      run: () => onNavigate("work"),
    },
    {
      id: "workspace-search",
      icon: Search,
      tone: "teal",
      title: "Find workspace context",
      description: "Search visible chats, projects, memory, skills, artifacts, and providers.",
      metric: String(libraryRecordCount),
      metricLabel: libraryRecordCount === 1 ? "visible preview" : "visible previews",
      actionLabel: "Search",
      run: onOpenSearch,
    },
    {
      id: "library",
      icon: Library,
      tone: "amber",
      title: "Review the library",
      description: "Inspect attached sources, artifacts, and provenance before reuse.",
      metric: String(libraryRecordCount),
      metricLabel: libraryRecordCount === 1 ? "library record" : "library records",
      actionLabel: "Open library",
      run: onOpenLibrary,
    },
    {
      id: "control-center",
      icon: Settings2,
      tone: "steel",
      title: "Tune the workspace",
      description: "Review provider routes, appearance, permissions, storage, and diagnostics.",
      metric: String(providerCount),
      metricLabel: providerCount === 1 ? "provider" : "providers",
      actionLabel: "Open Control Center",
      run: () => onNavigate("settings"),
    },
  ];

  return (
    <section className="home-operations-deck" aria-labelledby="home-operations-deck-heading">
      <header className="home-operations-deck__header">
        <div>
          <span className="home-operations-deck__eyebrow"><Settings2 size={13} /> Operations deck</span>
          <h2 id="home-operations-deck-heading">Move through the workspace</h2>
          <p>Start, inspect, and organise the next step without losing your current context.</p>
        </div>
        <span className="home-pulse-badge">Preview only</span>
      </header>
      <div className="home-operations-deck__grid">
        {operations.map(({ id, icon: Icon, tone, title, description, metric, metricLabel, actionLabel, run }) => (
          <button key={id} type="button" className={`home-operation-card home-operation-card--${tone}`} onClick={run}>
            <span className="home-operation-card__icon"><Icon size={17} /></span>
            <span className="home-operation-card__copy">
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
            <span className="home-operation-card__metric"><b>{metric}</b><em>{metricLabel}</em></span>
            <span className="home-operation-card__action">{actionLabel}<ArrowRight size={13} /></span>
          </button>
        ))}
      </div>
      <section className="home-operations-deck__workbenches" aria-labelledby="home-operations-workbenches-heading">
        <header className="home-operations-deck__workbenches-header">
          <div>
            <span className="eyebrow">Focused previews</span>
            <h3 id="home-operations-workbenches-heading">Open one workbench at a time</h3>
            <p>Optional boards stay out of the Home payload until you explicitly open one.</p>
          </div>
          <span className="home-pulse-badge">On demand</span>
        </header>
        <div className="home-operations-deck__workbench-grid" role="group" aria-label="Home workbench previews">
          {HOME_WORKBENCHES.map(({ id, label, description, icon: Icon }) => {
            const selected = id === activeWorkbenchId;
            return (
              <button
                key={id}
                type="button"
                className={selected ? "home-operations-deck__workbench is-selected" : "home-operations-deck__workbench"}
                aria-label={`Open ${label} preview`}
                aria-pressed={selected}
                aria-expanded={selected}
                {...(selected ? { "aria-controls": `home-operations-workbench-${id}` } : {})}
                onClick={() => setActiveWorkbenchId((current) => current === id ? null : id)}
              >
                <Icon size={14} aria-hidden="true" />
                <span><strong>{label}</strong><small>{description}</small></span>
              </button>
            );
          })}
        </div>
        {activeWorkbench ? (
          <div
            id={`home-operations-workbench-${activeWorkbench.id}`}
            className="home-operations-deck__workbench-panel"
            role="region"
            aria-label={`${activeWorkbench.label} preview`}
          >
            <HomeLazySurface label={activeWorkbench.label} load={activeWorkbench.load} props={{}} />
          </div>
        ) : (
          <p className="home-operations-deck__workbench-empty" role="status">
            Choose a focused preview when you need it. No optional board is loaded yet.
          </p>
        )}
      </section>
      <p className="home-operations-deck__boundary">Actions update the current renderer session or open a preview. They do not dispatch a provider request, create a native queue item, grant permissions, or write files.</p>
    </section>
  );
}
