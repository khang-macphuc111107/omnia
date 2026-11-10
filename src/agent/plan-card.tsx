import { lazy, Suspense, useState } from "react";

import { PERMISSION_MODES, type PermissionMode } from "./types";

const Markdown = lazy(() =>
  import("@/features/workspace/markdown").then((module) => ({ default: module.MessageMarkdown })),
);

/** Modes a plan can be approved into: the ones that let the agent act. */
export const PLAN_TARGET_MODES = ["ask_writes", "auto", "full"] as const satisfies readonly PermissionMode[];
export type PlanTargetMode = (typeof PLAN_TARGET_MODES)[number];

export const DEFAULT_PLAN_APPROVED_MESSAGE = "Plan approved. Proceed.";

const labelOf = (mode: PermissionMode) => PERMISSION_MODES.find((entry) => entry.value === mode)?.label ?? mode;

/**
 * The plan a Plan-mode run ended with. Approving switches the session's
 * permission mode and continues; "Keep planning" stays in Plan mode, with
 * optional feedback sent as the next message.
 */
export function PlanCard({
  plan,
  initialMode = "ask_writes",
  busy = false,
  onApprove,
  onKeepPlanning,
}: {
  plan: string;
  initialMode?: PlanTargetMode;
  busy?: boolean;
  onApprove: (mode: PlanTargetMode) => void;
  /** `feedback` is empty when the user typed none. */
  onKeepPlanning: (feedback: string) => void;
}) {
  const [mode, setMode] = useState<PlanTargetMode>(initialMode);
  const [feedback, setFeedback] = useState("");

  return (
    <section className="ag-approval ag-plan" role="group" aria-label="Plan ready for approval">
      <div className="ag-approval__head">
        <strong>Plan ready for your approval</strong>
        <span className="ag-muted">Plan mode</span>
      </div>
      <div className="ag-plan__body">
        <Suspense fallback={<p className="ag-plain">{plan}</p>}>
          <Markdown content={plan} />
        </Suspense>
      </div>
      <textarea
        className="ag-input ag-approval__feedback"
        aria-label="Feedback for the plan"
        placeholder="Optional: what should change? Sent with Keep planning"
        rows={2}
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
      />
      <div className="ag-approval__actions">
        <button type="button" className="ag-btn ag-btn--primary" disabled={busy} onClick={() => onApprove(mode)}>
          Approve &amp; switch to {labelOf(mode)}
        </button>
        <select
          className="ag-input ag-plan__mode"
          aria-label="Mode to switch to"
          value={mode}
          disabled={busy}
          onChange={(event) => setMode(event.target.value as PlanTargetMode)}
        >
          {PLAN_TARGET_MODES.map((value) => (
            <option key={value} value={value}>
              {labelOf(value)}
            </option>
          ))}
        </select>
        <button type="button" className="ag-btn" disabled={busy} onClick={() => onKeepPlanning(feedback.trim())}>
          Keep planning
        </button>
      </div>
    </section>
  );
}
