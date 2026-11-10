import { Suspense, lazy, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type MutableRefObject } from "react";

import { LazyLoadBoundary } from "@/components/lazy-load-boundary";

import type { BackgroundWorkRow } from "./background-work-inspector";

type BackgroundWorkOptionalWorkbenchId =
  | "task-inspector"
  | "board"
  | "agent-mesh"
  | "inbox"
  | "supervisor"
  | "reconciliation"
  | "worktree"
  | "harness"
  | "provider";

interface BackgroundWorkOptionalWorkbenchProps {
  readonly rows: readonly BackgroundWorkRow[];
  readonly linkedWorkCount: number;
}

interface BackgroundWorkOptionalWorkbenchDescriptor {
  readonly id: BackgroundWorkOptionalWorkbenchId;
  readonly label: string;
  readonly eyebrow: string;
  readonly description: string;
  readonly load: () => Promise<{
    default: ComponentType<BackgroundWorkOptionalWorkbenchProps>;
  }>;
}

const optionalWorkbenches: readonly BackgroundWorkOptionalWorkbenchDescriptor[] = [
  {
    id: "task-inspector",
    label: "Task inspector",
    eyebrow: "Goal, task and checkpoint facets",
    description: "Inspect the bounded task projection without implying a durable scheduler or lease.",
    load: async () => {
      const { BackgroundTaskInspectorPreview } = await import("./background-task-inspector-preview");
      return { default: () => <BackgroundTaskInspectorPreview /> };
    },
  },
  {
    id: "board",
    label: "Board",
    eyebrow: "Stage and map projection",
    description: "Switch between a lane board and a renderer-local work map.",
    load: async () => {
      const { BackgroundWorkBoardPreview } = await import("./background-work-board-preview");
      return { default: ({ rows }: BackgroundWorkOptionalWorkbenchProps) => <BackgroundWorkBoardPreview rows={rows} /> };
    },
  },
  {
    id: "agent-mesh",
    label: "Agent Mesh",
    eyebrow: "Coordination preview",
    description: "Review agent, mailbox and lease signals without spawning or reassigning workers.",
    load: async () => {
      const { AgentMeshPreview } = await import("./agent-mesh-preview");
      return { default: ({ linkedWorkCount }: BackgroundWorkOptionalWorkbenchProps) => <AgentMeshPreview linkedWorkCount={linkedWorkCount} /> };
    },
  },
  {
    id: "inbox",
    label: "Inbox",
    eyebrow: "Triage and routes",
    description: "Triage seeded Agent Mesh messages, inspect route density, and rehearse follow-up intent without sending anything.",
    load: async () => {
      const { AgentMeshInboxPreview } = await import("./agent-mesh-inbox-preview");
      return { default: ({ linkedWorkCount }: BackgroundWorkOptionalWorkbenchProps) => <AgentMeshInboxPreview linkedWorkCount={linkedWorkCount} /> };
    },
  },
  {
    id: "supervisor",
    label: "Supervisor",
    eyebrow: "Queue and readiness",
    description: "Inspect dependency and readiness signals as a renderer-only supervisor projection.",
    load: async () => {
      const { AgentMeshSupervisorPreview } = await import("./agent-mesh-supervisor-preview");
      return { default: ({ linkedWorkCount }: BackgroundWorkOptionalWorkbenchProps) => <AgentMeshSupervisorPreview linkedWorkCount={linkedWorkCount} /> };
    },
  },
  {
    id: "reconciliation",
    label: "Reconciliation",
    eyebrow: "Conflict and evidence review",
    description: "Compare competing renderer projections before any native write or lease change exists.",
    load: async () => {
      const { AgentMeshReconciliationPreview } = await import("./agent-mesh-reconciliation-preview");
      return { default: ({ linkedWorkCount }: BackgroundWorkOptionalWorkbenchProps) => <AgentMeshReconciliationPreview linkedWorkCount={linkedWorkCount} /> };
    },
  },
  {
    id: "worktree",
    label: "Worktree coordination",
    eyebrow: "Path ownership and handoff",
    description: "Inspect proposed lane ownership and overlapping path claims without creating Git worktrees or touching the filesystem.",
    load: async () => {
      const { WorktreeCoordinationPreview } = await import("./worktree-coordination-preview");
      return { default: ({ linkedWorkCount }: BackgroundWorkOptionalWorkbenchProps) => <WorktreeCoordinationPreview linkedWorkCount={linkedWorkCount} /> };
    },
  },
  {
    id: "harness",
    label: "Harness",
    eyebrow: "Capability evidence",
    description: "Compare upstream harness signals and Omnia decisions in a portable preview.",
    load: async () => {
      const { HarnessContractPanel } = await import("./harness-contract-panel");
      return { default: () => <HarnessContractPanel /> };
    },
  },
  {
    id: "provider",
    label: "Provider faults",
    eyebrow: "Failure rehearsal",
    description: "Rehearse provider-fault states without sending a request or claiming a live job.",
    load: async () => {
      const { ProviderFaultHarnessPreview } = await import("./provider-fault-harness-preview");
      return { default: () => <ProviderFaultHarnessPreview /> };
    },
  },
];

function BackgroundWorkOptionalLoadingState({
  descriptor,
}: {
  readonly descriptor: BackgroundWorkOptionalWorkbenchDescriptor;
}) {
  return (
    <section className="background-work-optional__loading" role="status" aria-live="polite">
      <span className="activity-load-progress" aria-hidden="true" />
      <div>
        <span className="eyebrow">Opening {descriptor.eyebrow}</span>
        <strong>{descriptor.label} workbench</strong>
        <small>Loading this optional surface without changing the active work projection.</small>
      </div>
    </section>
  );
}

function moveOptionalWorkbench(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
  open: (id: BackgroundWorkOptionalWorkbenchId) => void,
  tabRefs: MutableRefObject<Partial<Record<BackgroundWorkOptionalWorkbenchId, HTMLButtonElement | null>>>,
) {
  const key = event.key;
  const targetIndex = key === "ArrowRight" || key === "ArrowDown"
    ? (index + 1) % optionalWorkbenches.length
    : key === "ArrowLeft" || key === "ArrowUp"
      ? (index - 1 + optionalWorkbenches.length) % optionalWorkbenches.length
      : key === "Home"
        ? 0
        : key === "End"
          ? optionalWorkbenches.length - 1
          : null;
  if (targetIndex === null) return;
  event.preventDefault();
  const target = optionalWorkbenches[targetIndex]!;
  open(target.id);
  tabRefs.current[target.id]?.focus();
}

/**
 * Optional Background Work panels are intentionally loaded one at a time.
 * The core activity remains useful while these heavier projections stay out
 * of its first render and can recover independently from a failed chunk.
 */
export function BackgroundWorkOptionalWorkbench({
  rows,
}: {
  readonly rows: readonly BackgroundWorkRow[];
}) {
  const [activeWorkbenchId, setActiveWorkbenchId] = useState<BackgroundWorkOptionalWorkbenchId>("reconciliation");
  const [retryKey, setRetryKey] = useState(0);
  // Keep the initial Background Work render focused on the core signal and
  // queue surfaces. The optional workbench chunk is fetched only after an
  // explicit user selection.
  const [stageVisible, setStageVisible] = useState(false);
  const tabRefs = useRef<Partial<Record<BackgroundWorkOptionalWorkbenchId, HTMLButtonElement | null>>>({});
  const activeWorkbench = optionalWorkbenches.find((item) => item.id === activeWorkbenchId) ?? optionalWorkbenches[0]!;
  const Workbench = useMemo(() => lazy(activeWorkbench.load), [activeWorkbench, retryKey]);

  const openWorkbench = (nextWorkbenchId: BackgroundWorkOptionalWorkbenchId) => {
    setActiveWorkbenchId(nextWorkbenchId);
    setStageVisible(true);
    setRetryKey(0);
  };

  return (
    <section className="background-work-optional" aria-label="Optional background work surfaces">
      <header className="background-work-optional__header">
        <div>
          <span className="eyebrow">Optional workbenches</span>
          <h2>Deeper work signals, loaded on demand</h2>
          <p>Choose one advanced preview at a time so the core Background Work projection stays responsive.</p>
        </div>
        <span className="background-work-optional__badge">Preview only · lazy surface</span>
      </header>

      <nav className="background-work-optional__tabs" role="tablist" aria-label="Background Work optional surfaces" aria-orientation="horizontal">
        {optionalWorkbenches.map((workbench, index) => (
          <button
            type="button"
            key={workbench.id}
            id={`background-work-optional-tab-${workbench.id}`}
            role="tab"
            aria-selected={workbench.id === activeWorkbenchId && stageVisible}
            aria-controls="background-work-optional-panel"
            // Keep the current tab reachable even while the optional stage is
            // closed. There is intentionally no selected tab in that state,
            // but a roving tablist still needs one keyboard entry point.
            tabIndex={workbench.id === activeWorkbenchId ? 0 : -1}
            className={workbench.id === activeWorkbenchId && stageVisible ? "is-active" : ""}
            title={`${workbench.label}: ${workbench.description}`}
            onClick={() => openWorkbench(workbench.id)}
            onKeyDown={(event) => moveOptionalWorkbench(event, index, openWorkbench, tabRefs)}
            ref={(element) => { tabRefs.current[workbench.id] = element; }}
          >
            <strong>{workbench.label}</strong>
            <small>{workbench.eyebrow}</small>
          </button>
        ))}
      </nav>

      {stageVisible ? (
        <section id="background-work-optional-panel" className="background-work-optional__stage" role="tabpanel" tabIndex={0} aria-labelledby={`background-work-optional-tab-${activeWorkbench.id}`} aria-label={`${activeWorkbench.label} workbench preview`}>
          <div className="background-work-optional__stage-heading">
            <div>
              <span className="eyebrow">{activeWorkbench.eyebrow}</span>
              <h3>{activeWorkbench.label}</h3>
              <p>{activeWorkbench.description}</p>
            </div>
            <small>Renderer-local · no durable write</small>
          </div>
          <LazyLoadBoundary
            label={`${activeWorkbench.label} workbench`}
            resetKey={`${activeWorkbench.id}:${retryKey}`}
            onDismiss={() => setStageVisible(false)}
            onRetry={() => setRetryKey((value) => value + 1)}
          >
            <Suspense fallback={<BackgroundWorkOptionalLoadingState descriptor={activeWorkbench} />}>
              <Workbench rows={rows} linkedWorkCount={rows.length} />
            </Suspense>
          </LazyLoadBoundary>
        </section>
      ) : (
        <section className="background-work-optional__empty" aria-label="Optional workbench closed">
          <strong>Optional workbench closed</strong>
          <span>Choose a surface above to reopen a renderer-local preview.</span>
          <button type="button" className="button button--secondary" title={`Reopen the ${activeWorkbench.label} renderer preview`} onClick={() => setStageVisible(true)}>Reopen {activeWorkbench.label}</button>
        </section>
      )}
    </section>
  );
}
