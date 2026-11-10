import {
  ArrowDownToLine,
  ArrowLeftRight,
  CalendarClock,
  Check,
  ChevronDown,
  GitMerge,
  GitPullRequest,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Route,
  Send,
  SlidersHorizontal,
  Split,
  WandSparkles,
} from "lucide-react";
import { useId, useMemo, useState } from "react";

export type RunActionPreviewId =
  | "continue"
  | "pause"
  | "resume"
  | "retry"
  | "queue"
  | "steer"
  | "schedule"
  | "branch"
  | "compare"
  | "promote"
  | "merge"
  | "btw";

export type RunActionPreviewState = "idle" | "streaming" | "failed" | "queued" | "paused" | "completed";

export interface RunActionPreviewProps {
  readonly state?: RunActionPreviewState;
  readonly onSelect?: (action: RunActionPreviewId) => void;
  readonly compact?: boolean;
}

interface ActionDefinition {
  readonly id: RunActionPreviewId;
  readonly label: string;
  readonly hint: string;
  readonly icon: typeof Play;
  readonly availableFor: readonly RunActionPreviewState[];
}

const ACTIONS: readonly ActionDefinition[] = [
  { id: "continue", label: "Continue", hint: "Continue from the latest renderer checkpoint", icon: Play, availableFor: ["idle", "completed", "failed", "queued", "paused"] },
  { id: "pause", label: "Pause", hint: "Preview a pause request for the active run", icon: Pause, availableFor: ["streaming"] },
  { id: "resume", label: "Resume", hint: "Preview resuming a paused run", icon: Play, availableFor: ["paused", "queued", "failed", "idle"] },
  { id: "retry", label: "Retry", hint: "Preview a fresh attempt with the same prompt", icon: RefreshCw, availableFor: ["failed", "completed", "idle", "paused"] },
  { id: "queue", label: "Queue", hint: "Preview adding this turn to a future queue", icon: ArrowDownToLine, availableFor: ["idle", "failed", "completed", "paused"] },
  { id: "steer", label: "Steer", hint: "Preview an instruction to the active run", icon: Route, availableFor: ["streaming", "queued"] },
  { id: "schedule", label: "Schedule", hint: "Preview a schedule rule without saving it", icon: CalendarClock, availableFor: ["idle", "failed", "completed", "paused"] },
  { id: "branch", label: "Branch", hint: "Preview a new conversation branch from this run", icon: Split, availableFor: ["idle", "failed", "queued", "paused", "completed"] },
  { id: "compare", label: "Compare", hint: "Preview a side-by-side run comparison", icon: ArrowLeftRight, availableFor: ["idle", "streaming", "failed", "queued", "paused", "completed"] },
  { id: "promote", label: "Promote", hint: "Preview promoting an answer to the conversation", icon: GitPullRequest, availableFor: ["completed", "failed"] },
  { id: "merge", label: "Merge", hint: "Preview merging a branch into this conversation", icon: GitMerge, availableFor: ["idle", "completed"] },
  { id: "btw", label: "Btw", hint: "Preview a side question that does not replace the draft", icon: WandSparkles, availableFor: ["idle", "streaming", "failed", "queued", "completed"] },
];

const stateLabel: Record<RunActionPreviewState, string> = {
  idle: "Idle",
  streaming: "Streaming",
  failed: "Needs attention",
  queued: "Queued",
  paused: "Paused",
  completed: "Completed",
};

function ActionButton({
  action,
  disabled,
  onSelect,
}: {
  readonly action: ActionDefinition;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}) {
  const Icon = action.icon;
  return (
    <button
      type="button"
      className="run-action-preview__action"
      disabled={disabled}
      onClick={onSelect}
      title={disabled ? `${action.label} is not suggested for this state` : action.hint}
    >
      <Icon size={13} aria-hidden="true" />
      <span>{action.label}</span>
    </button>
  );
}

/**
 * Renderer-only run-action affordances. These controls intentionally produce a
 * local preview message; they never dispatch a provider request or mutate the
 * native run journal.
 */
export function RunActionPreview({ state = "idle", onSelect, compact = false }: RunActionPreviewProps) {
  const [expanded, setExpanded] = useState(!compact);
  const [selected, setSelected] = useState<RunActionPreviewId | null>(null);
  const actionsPanelId = useId();
  const available = useMemo(
    () => ACTIONS.filter((action) => action.availableFor.includes(state)),
    [state],
  );
  const selectedLabel = ACTIONS.find((action) => action.id === selected)?.label ?? null;

  const choose = (action: RunActionPreviewId) => {
    setSelected(action);
    onSelect?.(action);
  };

  return (
    <section className={compact ? "run-action-preview run-action-preview--compact" : "run-action-preview"} aria-label="Run actions preview">
      <header className="run-action-preview__header">
        <div>
          <span className="eyebrow">Run actions</span>
          <strong>What should happen next?</strong>
        </div>
        <span className="run-action-preview__state">{stateLabel[state]}</span>
        <button
          type="button"
          className="run-action-preview__toggle"
          aria-expanded={expanded}
          aria-controls={actionsPanelId}
          onClick={() => setExpanded((value) => !value)}
        >
          <SlidersHorizontal size={13} aria-hidden="true" />
          {expanded ? "Hide" : "Show"}
          <ChevronDown size={12} className={expanded ? "is-open" : undefined} aria-hidden="true" />
        </button>
      </header>

      <div id={actionsPanelId} className="run-action-preview__grid" role="group" aria-label="Run action choices" hidden={!expanded}>
        {ACTIONS.map((action) => (
          <ActionButton
            key={action.id}
            action={action}
            disabled={!available.includes(action)}
            onSelect={() => choose(action.id)}
          />
        ))}
      </div>
      {expanded ? (
        <>
          <div className="run-action-preview__status" role="status" aria-live="polite">
            {selectedLabel ? <><Check size={13} aria-hidden="true" /> {selectedLabel} is a renderer preview; native dispatch is not connected.</> : <><Plus size={13} aria-hidden="true" /> Choose an action to preview its intent. Nothing is sent or persisted.</>}
          </div>
        </>
      ) : null}

      <p className="run-action-preview__boundary"><Send size={12} aria-hidden="true" /> Preview controls only · Continue, pause, retry, scheduling, branching, and queue mutations remain Planned until a native run-control bridge is available.</p>
    </section>
  );
}

export const RUN_ACTION_PREVIEW_DEFINITIONS = ACTIONS;
