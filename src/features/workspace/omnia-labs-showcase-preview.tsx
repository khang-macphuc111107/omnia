import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Accessibility, Beaker, Bell, BookOpen, Box, Database, Download, FileText, GitBranch, Image, Landmark, Network, Palette, Search, ShieldCheck, Sparkles, TerminalSquare, Video, Workflow, Brain } from "lucide-react";

type LabId = "composer" | "media" | "media-console" | "evidence" | "citations" | "workflow" | "memory" | "finance" | "science" | "training" | "themes" | "permissions" | "notifications" | "toolchain" | "toolchain-plan" | "research" | "transfer" | "agent-dag" | "accessibility";

type LabModule = { default: ComponentType<Record<string, unknown>> };

type LabDefinition = {
  id: LabId;
  label: string;
  description: string;
  icon: typeof FileText;
  load: () => Promise<LabModule>;
};

const LABS: readonly LabDefinition[] = [
  {
    id: "composer",
    label: "Rich Composer",
    description: "Markdown, LaTeX, blocks, outline, and formatting inspection.",
    icon: FileText,
    load: async () => {
      const module = await import("./composer-rich-preview");
      return {
        default: () => (
          <module.ComposerRichPreview
            content={"# Omnia draft\n\nUse **rich Markdown**, inline $x^2$, and a checklist.\n\n- [ ] Review the next step"}
          />
        ),
      };
    },
  },
  {
    id: "media",
    label: "Media Endpoints",
    description: "Image/video/audio endpoint profiles, fallback hints, and export.",
    icon: Image,
    load: async () => {
      const module = await import("./media-endpoint-profile-studio");
      return { default: module.MediaEndpointProfileStudio };
    },
  },
  {
    id: "media-console",
    label: "Media route console",
    description: "Compare image, video, and audio routes with redacted export.",
    icon: Video,
    load: async () => {
      const module = await import("./media-endpoint-console-preview");
      return { default: module.default };
    },
  },
  {
    id: "evidence",
    label: "Evidence Inspector",
    description: "Lifecycle, coverage, triage, and portable evidence preview.",
    icon: Search,
    load: async () => {
      const module = await import("./observability-evidence-dashboard");
      return { default: module.default };
    },
  },
  {
    id: "citations",
    label: "Citation Graph",
    description: "Explore sources, claims, paths, clusters, and export scope.",
    icon: Network,
    load: async () => {
      const module = await import("./citation-graph-preview");
      return { default: module.CitationGraphPreview };
    },
  },
  {
    id: "workflow",
    label: "Workflow Plan",
    description: "Shape a renderer-local DAG with guardrails and rehearsal state.",
    icon: Workflow,
    load: async () => {
      const module = await import("./automation-workflow-plan-preview");
      return {
        default: () => (
          <module.AutomationWorkflowPlanPreview
            automationName="Omnia research handoff"
            scopeLabel="Project"
            actionLabel="Prepare cited synthesis"
            connectorLabel="None"
            approvalRoute="review-changes"
          />
        ),
      };
    },
  },
  {
    id: "memory",
    label: "Memory Lifecycle",
    description: "Review proposals, revisions, retention, conflicts, and lineage.",
    icon: Brain,
    load: async () => {
      const module = await import("./memory-lifecycle-studio");
      return { default: module.MemoryLifecycleStudio };
    },
  },
  {
    id: "finance",
    label: "Finance Planning",
    description: "Compare local budget scenarios with explicit sample-only inputs.",
    icon: Landmark,
    load: async () => {
      const module = await import("./finance-workspace-preview");
      return { default: module.FinanceWorkspacePreview };
    },
  },
  {
    id: "science",
    label: "Science Notebook",
    description: "Physics, chemistry, math, observations, residuals, and export.",
    icon: Beaker,
    load: async () => {
      const module = await import("./science-notebook-lab-preview");
      return { default: module.ScienceNotebookLabPreview };
    },
  },
  {
    id: "training",
    label: "Dataset Pipeline",
    description: "Split, deduplicate, redact, and inspect checkpoint-ready data.",
    icon: Database,
    load: async () => {
      const module = await import("./training-dataset-pipeline");
      const recordsModule = await import("./training-control-center");
      return { default: () => <module.default records={recordsModule.seedTrainingRecords} /> };
    },
  },
  {
    id: "themes",
    label: "Themes & brand",
    description: "Compare palettes and logos, tune tokens, and undo the draft.",
    icon: Palette,
    load: async () => {
      const module = await import("./theme-preset-studio");
      return { default: module.ThemePresetStudio };
    },
  },
  {
    id: "permissions",
    label: "Permission controls",
    description: "Review per-capability profiles and explicit allow-all drafts.",
    icon: ShieldCheck,
    load: async () => {
      const module = await import("./permission-control-center");
      return { default: module.PermissionControlCenter };
    },
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Triage, channels, saved views, and export history.",
    icon: Bell,
    load: async () => {
      const module = await import("./notification-center-preview");
      return { default: module.NotificationCenterPreview };
    },
  },
  {
    id: "toolchain",
    label: "Toolchain preview",
    description: "Explore languages, compiler profiles, and command rehearsals.",
    icon: TerminalSquare,
    load: async () => {
      const module = await import("./terminal-compiler-preview");
      return { default: () => <module.TerminalCompilerPreview projectName="Omnia Labs preview" /> };
    },
  },
  {
    id: "toolchain-plan",
    label: "Environment blueprint",
    description: "Compose runtimes, compiler pins, cache policy, and artifact targets.",
    icon: Box,
    load: async () => {
      const module = await import("./toolchain-environment-planner");
      return { default: module.ToolchainEnvironmentPlanner };
    },
  },
  {
    id: "research",
    label: "Research notebook",
    description: "Sources, notes, brief, and citation graph in one view.",
    icon: BookOpen,
    load: async () => {
      const module = await import("./research-notebook-preview");
      return { default: module.ResearchNotebookPreview };
    },
  },
  {
    id: "transfer",
    label: "Workspace transfer",
    description: "Inspect portable export profiles and import conflicts.",
    icon: Download,
    load: async () => {
      const module = await import("./workspace-export-center");
      return { default: module.WorkspaceExportCenter };
    },
  },
  {
    id: "agent-dag",
    label: "Agent DAG",
    description: "Inspect parallel lanes, dependencies, critical path, and conflicts.",
    icon: GitBranch,
    load: async () => {
      const module = await import("./agent-dag-orchestration-preview");
      return { default: module.default };
    },
  },
  {
    id: "accessibility",
    label: "Accessibility",
    description: "Tune keyboard, contrast, motion, focus, and command discovery.",
    icon: Accessibility,
    load: async () => {
      const module = await import("./accessibility-command-surface-preview");
      return { default: module.default };
    },
  },
];

function LoadingState({ label }: { label: string }) {
  return (
    <div className="omnia-labs__loading" role="status" aria-live="polite">
      <Sparkles size={15} /> Loading {label}…
    </div>
  );
}

export default function OmniaLabsShowcasePreview() {
  const [activeId, setActiveId] = useState<LabId>("composer");
  const [loadedModules, setLoadedModules] = useState<Partial<Record<LabId, LabModule>>>({});
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const active = useMemo(() => LABS.find((item) => item.id === activeId) ?? LABS[0]!, [activeId]);
  const visibleLabs = useMemo(() => LABS.filter((lab) => `${lab.label} ${lab.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [query]);

  useEffect(() => {
    if (loadedModules[activeId]) return;
    let current = true;
    active.load().then((module) => {
      if (current) setLoadedModules((modules) => ({ ...modules, [activeId]: module }));
    }).catch(() => {
      if (current) setLoadError(`Could not load ${active.label}. Choose another surface or try again.`);
    });
    return () => { current = false; };
  }, [active, activeId, loadedModules]);

  const ActiveSurface = loadedModules[activeId]?.default;

  return (
    <section className="omnia-labs" aria-labelledby="omnia-labs-heading">
      <header className="omnia-labs__header">
        <div>
          <span className="eyebrow"><Sparkles size={13} /> Omnia Labs</span>
          <h3 id="omnia-labs-heading">Advanced workbench gallery</h3>
          <p>Open the surface you want to inspect without losing the Home context.</p>
        </div>
        <span className="omnia-labs__badge">Preview only</span>
      </header>

      <div className="omnia-labs__finder">
        <label htmlFor="omnia-labs-search"><Search size={14} /> Find a workbench</label>
        <input id="omnia-labs-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search themes, permissions, research…" />
        <span>{visibleLabs.length} / {LABS.length}</span>
      </div>
      <div className="omnia-labs__tabs" role="tablist" aria-label="Omnia Labs surfaces">
        {visibleLabs.map((lab) => {
          const Icon = lab.icon;
          const selected = lab.id === activeId;
          return (
            <button
              key={lab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`omnia-labs-panel-${lab.id}`}
              className={selected ? "omnia-labs__tab is-active" : "omnia-labs__tab"}
              onClick={() => { setLoadError(""); setActiveId(lab.id); }}
            >
              <Icon size={14} />
              <span><strong>{lab.label}</strong><small>{lab.description}</small></span>
            </button>
          );
        })}
      </div>
      {visibleLabs.length === 0 ? <p className="omnia-labs__empty">No workbenches match this search. Clear the query to see all previews.</p> : null}

      <div id={`omnia-labs-panel-${active.id}`} className="omnia-labs__panel" role="tabpanel" aria-label={`${active.label} preview`}>
        {loadError ? <div className="omnia-labs__loading" role="alert">{loadError}</div> : ActiveSurface ? <ActiveSurface /> : <LoadingState label={active.label} />}
      </div>
      <p className="omnia-labs__boundary"><BookOpen size={13} /> Renderer-local gallery. Tabs may export browser-session previews, but do not call providers, execute tools, write files, persist settings, or create native receipts.</p>
    </section>
  );
}
