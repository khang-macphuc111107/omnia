import {
  ArrowLeftRight,
  Clipboard,
  Download,
  Eye,
  Filter,
  GitCompareArrows,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { redactDiagnosticText } from "./diagnostics-session-contract";
import type {
  WorkflowDryRunRecord,
  WorkflowDryRunStep,
  WorkflowDryRunStepStatus,
} from "./workflow-dry-run-history-preview";

export type WorkflowRunDiffKind = "added" | "removed" | "changed" | "unchanged";
export type WorkflowRunDiffImpact = "context" | "route" | "approval" | "effect" | "budget" | "metadata";
export type WorkflowRunDiffFilter = "all" | WorkflowRunDiffKind | WorkflowRunDiffImpact;
export type WorkflowRunDiffExportFormat = "json" | "markdown";

export interface WorkflowRunDiffEntry {
  readonly id: string;
  readonly label: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly kind: WorkflowRunDiffKind;
  readonly impact: WorkflowRunDiffImpact;
  readonly detail: string;
}

export interface WorkflowRunStepDiffEntry {
  readonly id: string;
  readonly label: string;
  readonly before: WorkflowDryRunStep | null;
  readonly after: WorkflowDryRunStep | null;
  readonly kind: WorkflowRunDiffKind;
  readonly impact: WorkflowRunDiffImpact;
  readonly detail: string;
}

export interface WorkflowRunDiffSummary {
  readonly changed: number;
  readonly added: number;
  readonly removed: number;
  readonly unchanged: number;
  readonly blockedBefore: number;
  readonly blockedAfter: number;
  readonly warningsAdded: number;
  readonly warningsRemoved: number;
}

export interface WorkflowRunDiffModel {
  readonly baseline: WorkflowDryRunRecord;
  readonly current: WorkflowDryRunRecord;
  readonly fields: readonly WorkflowRunDiffEntry[];
  readonly steps: readonly WorkflowRunStepDiffEntry[];
  readonly warningsAdded: readonly string[];
  readonly warningsRemoved: readonly string[];
  readonly approvalDelta: "more-review" | "less-review" | "same";
  readonly summary: WorkflowRunDiffSummary;
}

export interface WorkflowRunDiffPreviewProps {
  readonly runs: readonly WorkflowDryRunRecord[];
  readonly selectedRunId?: string | null;
}

const boundary = "Renderer-local run comparison only. No provider request, approval receipt, scheduler action, filesystem write, native state revision, or external side effect was created.";

const kindLabels: Record<WorkflowRunDiffKind, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  unchanged: "Unchanged",
};

const impactLabels: Record<WorkflowRunDiffImpact, string> = {
  context: "Context",
  route: "Route",
  approval: "Approval",
  effect: "Effect",
  budget: "Budget",
  metadata: "Metadata",
};

const stepStatusLabels: Record<WorkflowDryRunStepStatus, string> = {
  "would-run": "Would run",
  skipped: "Skipped",
  blocked: "Blocked",
};

function safeText(value: string, maxLength: number): string {
  return redactDiagnosticText(value).slice(0, maxLength);
}

function stepFingerprint(step: WorkflowDryRunStep): string {
  return [step.label, step.detail, step.effect, step.status].join("\u0000");
}

function stepImpact(before: WorkflowDryRunStep | null, after: WorkflowDryRunStep | null): WorkflowRunDiffImpact {
  const effect = after?.effect ?? before?.effect;
  const text = `${after?.label ?? before?.label ?? ""} ${after?.detail ?? before?.detail ?? ""}`.toLowerCase();
  if (after?.status === "blocked" || before?.status === "blocked" || effect === "external") return "approval";
  if (/source|context|snapshot|memory|skill|collect|scope|manifest/.test(text)) return "context";
  if (effect === "transform" || effect === "write" || before?.effect !== after?.effect) return "effect";
  return "metadata";
}

function fieldKind(before: string | null, after: string | null): WorkflowRunDiffKind {
  if (before === after) return "unchanged";
  if (before === null) return "added";
  if (after === null) return "removed";
  return "changed";
}

function makeField(
  id: string,
  label: string,
  before: string | null,
  after: string | null,
  impact: WorkflowRunDiffImpact,
): WorkflowRunDiffEntry {
  const kind = fieldKind(before, after);
  const detail = kind === "unchanged"
    ? "No visible change in this renderer snapshot."
    : kind === "added"
      ? `Added in current revision: ${after ?? "(empty)"}.`
      : kind === "removed"
        ? `Removed from current revision: ${before ?? "(empty)"}.`
        : `Changed from ${before ?? "(empty)"} to ${after ?? "(empty)"}.`;
  return { id, label, before, after, kind, impact, detail };
}

function normalizeWarning(warning: string): string {
  return safeText(warning, 500);
}

export function buildWorkflowRunDiff(
  baseline: WorkflowDryRunRecord,
  current: WorkflowDryRunRecord,
): WorkflowRunDiffModel {
  const safeBaseline = {
    ...baseline,
    id: safeText(baseline.id, 160),
    workflowName: safeText(baseline.workflowName, 240),
  };
  const safeCurrent = {
    ...current,
    id: safeText(current.id, 160),
    workflowName: safeText(current.workflowName, 240),
  };
  const fields: WorkflowRunDiffEntry[] = [
    makeField("revision", "Revision", String(safeBaseline.revision), String(safeCurrent.revision), "metadata"),
    makeField("status", "Status", safeBaseline.status, safeCurrent.status, safeCurrent.status === "blocked" || safeBaseline.status === "blocked" ? "approval" : "metadata"),
    makeField("trigger", "Trigger", safeBaseline.trigger, safeCurrent.trigger, "metadata"),
    makeField("route", "Route", safeText(safeBaseline.routeLabel, 240), safeText(safeCurrent.routeLabel, 240), "route"),
    makeField("duration", "Duration estimate", safeText(safeBaseline.durationEstimate, 80), safeText(safeCurrent.durationEstimate, 80), "budget"),
    makeField("cost", "Cost estimate", safeText(safeBaseline.costEstimate, 80), safeText(safeCurrent.costEstimate, 80), "budget"),
    makeField("summary", "Summary", safeText(safeBaseline.summary, 500), safeText(safeCurrent.summary, 500), "context"),
  ];

  const baselineSteps = new Map(safeBaseline.steps.map((step) => [step.id, step]));
  const currentSteps = new Map(safeCurrent.steps.map((step) => [step.id, step]));
  const stepIds = [...new Set([...safeCurrent.steps.map((step) => step.id), ...safeBaseline.steps.map((step) => step.id)])];
  const steps = stepIds.map((id): WorkflowRunStepDiffEntry => {
    const before = baselineSteps.get(id) ?? null;
    const after = currentSteps.get(id) ?? null;
    const kind: WorkflowRunDiffKind = before === null ? "added" : after === null ? "removed" : stepFingerprint(before) === stepFingerprint(after) ? "unchanged" : "changed";
    const label = safeText(after?.label ?? before?.label ?? id, 240);
    const detail = kind === "unchanged"
      ? "Step is unchanged."
      : kind === "added"
        ? `New step enters the current plan with status ${stepStatusLabels[after?.status ?? "would-run"]}.`
        : kind === "removed"
          ? "Step no longer appears in the current plan."
          : `Step changed from ${stepStatusLabels[before?.status ?? "would-run"]} to ${stepStatusLabels[after?.status ?? "would-run"]}.`;
    return { id: safeText(id, 160), label, before, after, kind, impact: stepImpact(before, after), detail };
  });

  const baselineWarnings = new Set(safeBaseline.warnings.map(normalizeWarning));
  const currentWarnings = new Set(safeCurrent.warnings.map(normalizeWarning));
  const warningsAdded = [...currentWarnings].filter((warning) => !baselineWarnings.has(warning));
  const warningsRemoved = [...baselineWarnings].filter((warning) => !currentWarnings.has(warning));
  const blockedBefore = safeBaseline.steps.filter((step) => step.status === "blocked").length;
  const blockedAfter = safeCurrent.steps.filter((step) => step.status === "blocked").length;
  const approvalDelta = blockedAfter > blockedBefore || warningsAdded.length > warningsRemoved.length
    ? "more-review"
    : blockedAfter < blockedBefore || warningsRemoved.length > warningsAdded.length
      ? "less-review"
      : "same";
  const summary: WorkflowRunDiffSummary = {
    changed: [...fields, ...steps].filter((entry) => entry.kind === "changed").length,
    added: [...fields, ...steps].filter((entry) => entry.kind === "added").length,
    removed: [...fields, ...steps].filter((entry) => entry.kind === "removed").length,
    unchanged: [...fields, ...steps].filter((entry) => entry.kind === "unchanged").length,
    blockedBefore,
    blockedAfter,
    warningsAdded: warningsAdded.length,
    warningsRemoved: warningsRemoved.length,
  };
  return {
    baseline: safeBaseline,
    current: safeCurrent,
    fields,
    steps,
    warningsAdded,
    warningsRemoved,
    approvalDelta,
    summary,
  };
}

function serializeValue(value: string | null): string {
  return value ?? "(none)";
}

export function serializeWorkflowRunDiff(
  diff: WorkflowRunDiffModel,
  format: WorkflowRunDiffExportFormat,
): string {
  if (format === "json") {
    return JSON.stringify({
      schema: "omnia.workflow-run-diff.preview.v1",
      scope: "renderer-session",
      executionDisposition: "preview-only",
      boundary,
      baseline: { id: diff.baseline.id, name: diff.baseline.workflowName, revision: diff.baseline.revision },
      current: { id: diff.current.id, name: diff.current.workflowName, revision: diff.current.revision },
      summary: diff.summary,
      approvalDelta: diff.approvalDelta,
      fields: diff.fields,
      steps: diff.steps.map((step) => ({
        ...step,
        before: step.before ? { label: step.before.label, detail: step.before.detail, effect: step.before.effect, status: step.before.status } : null,
        after: step.after ? { label: step.after.label, detail: step.after.detail, effect: step.after.effect, status: step.after.status } : null,
      })),
      warningsAdded: diff.warningsAdded,
      warningsRemoved: diff.warningsRemoved,
    }, null, 2);
  }
  const lines = [
    "# Omnia workflow run diff preview",
    "",
    `> ${boundary}`,
    "",
    `- Baseline: ${diff.baseline.workflowName} · revision ${diff.baseline.revision} · ${diff.baseline.id}`,
    `- Current: ${diff.current.workflowName} · revision ${diff.current.revision} · ${diff.current.id}`,
    `- Approval delta: ${diff.approvalDelta}`,
    `- Summary: ${diff.summary.changed} changed · ${diff.summary.added} added · ${diff.summary.removed} removed`,
    "",
    "## Fields",
    "",
    ...diff.fields.map((field) => `- ${field.label} · ${kindLabels[field.kind]} · ${impactLabels[field.impact]}: ${serializeValue(field.before)} → ${serializeValue(field.after)}`),
    "",
    "## Steps",
    "",
    ...diff.steps.map((step) => `- ${step.label} · ${kindLabels[step.kind]} · ${impactLabels[step.impact]}: ${step.detail}`),
    ...(diff.warningsAdded.length > 0 ? ["", "### Warnings added", "", ...diff.warningsAdded.map((warning) => `- ${warning}`)] : []),
    ...(diff.warningsRemoved.length > 0 ? ["", "### Warnings removed", "", ...diff.warningsRemoved.map((warning) => `- ${warning}`)] : []),
    "",
  ];
  return lines.join("\n");
}

export function downloadWorkflowRunDiff(payload: string, format: WorkflowRunDiffExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-workflow-run-diff.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function filterMatch(entry: WorkflowRunDiffEntry | WorkflowRunStepDiffEntry, filter: WorkflowRunDiffFilter): boolean {
  return filter === "all" || entry.kind === filter || entry.impact === filter;
}

function displayValue(value: string | null): string {
  return value ?? "—";
}

export function WorkflowRunDiffPreview({ runs, selectedRunId }: WorkflowRunDiffPreviewProps) {
  const [currentId, setCurrentId] = useState(selectedRunId ?? runs[0]?.id ?? "");
  const [baselineId, setBaselineId] = useState(() => runs.find((run) => run.id !== (selectedRunId ?? runs[0]?.id))?.id ?? "");
  const [filter, setFilter] = useState<WorkflowRunDiffFilter>("all");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<WorkflowRunDiffExportFormat>("json");
  const [announcement, setAnnouncement] = useState("Select two renderer rehearsals to compare.");

  useEffect(() => {
    if (selectedRunId && runs.some((run) => run.id === selectedRunId)) setCurrentId(selectedRunId);
  }, [runs, selectedRunId]);

  useEffect(() => {
    if (!runs.some((run) => run.id === currentId)) setCurrentId(runs[0]?.id ?? "");
    if (!runs.some((run) => run.id === baselineId) || baselineId === currentId) {
      setBaselineId(runs.find((run) => run.id !== currentId)?.id ?? "");
    }
  }, [baselineId, currentId, runs]);

  const current = runs.find((run) => run.id === currentId) ?? null;
  const baseline = runs.find((run) => run.id === baselineId && run.id !== currentId) ?? null;
  const diff = useMemo(() => current && baseline ? buildWorkflowRunDiff(baseline, current) : null, [baseline, current]);
  const visibleFields = useMemo(() => diff?.fields.filter((entry) => filterMatch(entry, filter)) ?? [], [diff, filter]);
  const visibleSteps = useMemo(() => diff?.steps.filter((entry) => filterMatch(entry, filter)) ?? [], [diff, filter]);
  const exportPayload = useMemo(() => diff ? serializeWorkflowRunDiff(diff, exportFormat) : "", [diff, exportFormat]);

  const swapRuns = () => {
    if (!baseline || !current) return;
    setCurrentId(baseline.id);
    setBaselineId(current.id);
    setAnnouncement("Baseline and current rehearsals swapped.");
  };

  const copyExport = async () => {
    if (!exportPayload || !navigator.clipboard?.writeText) {
      setAnnouncement("Clipboard is unavailable; no run diff was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setAnnouncement(`${exportFormat.toUpperCase()} run diff copied; no durable write was made.`);
    } catch {
      setAnnouncement("Clipboard access was denied; the run diff remains renderer-local.");
    }
  };

  return (
    <section className="workflow-run-diff" aria-labelledby="workflow-run-diff-heading">
      <header className="workflow-run-diff__header">
        <div>
          <span className="eyebrow"><GitCompareArrows size={13} /> Workflows · revision comparison</span>
          <h2 id="workflow-run-diff-heading">Run diff</h2>
          <p>Compare two renderer rehearsals before deciding whether a new route, context, effect, or approval boundary needs review.</p>
        </div>
        <span className="workflow-run-diff__badge"><Eye size={13} /> Preview only</span>
      </header>
      <p className="workflow-run-diff__boundary"><ShieldAlert size={14} /> {boundary}</p>

      <div className="workflow-run-diff__controls" role="toolbar" aria-label="Run diff controls">
        <label><span>Baseline</span><select aria-label="Run diff baseline" value={baselineId} onChange={(event) => setBaselineId(event.target.value)}><option value="">Select baseline</option>{runs.filter((run) => run.id !== currentId).map((run) => <option key={run.id} value={run.id}>{run.workflowName} · r{run.revision} · {run.id}</option>)}</select></label>
        <ArrowLeftRight size={16} aria-hidden="true" className="workflow-run-diff__arrow" />
        <label><span>Current</span><select aria-label="Run diff current" value={currentId} onChange={(event) => setCurrentId(event.target.value)}><option value="">Select current</option>{runs.map((run) => <option key={run.id} value={run.id}>{run.workflowName} · r{run.revision} · {run.id}</option>)}</select></label>
        <button type="button" className="button button--ghost" onClick={swapRuns} disabled={!diff}><ArrowLeftRight size={13} /> Swap</button>
        <label><span>Show</span><select aria-label="Run diff filter" value={filter} onChange={(event) => setFilter(event.target.value as WorkflowRunDiffFilter)}><option value="all">All entries</option><option value="changed">Changed</option><option value="added">Added</option><option value="removed">Removed</option><option value="context">Context</option><option value="route">Route</option><option value="approval">Approval</option><option value="effect">Effect</option><option value="budget">Budget</option></select></label>
        <button type="button" className="button button--ghost" onClick={() => { setFilter("all"); setExportOpen(false); setAnnouncement("Run diff filters reset for this renderer session."); }}><RotateCcw size={13} /> Reset</button>
      </div>

      {!diff ? (
        <div className="workflow-run-diff__empty"><GitCompareArrows size={21} /><strong>Select a baseline and current rehearsal.</strong><p>Comparison stays local and never starts a workflow.</p></div>
      ) : (
        <>
          <div className="workflow-run-diff__summary" aria-label="Run diff summary">
            <article><span>Changed</span><strong>{diff.summary.changed}</strong><small>visible fields and steps</small></article>
            <article><span>Added</span><strong>{diff.summary.added}</strong><small>current revision only</small></article>
            <article><span>Removed</span><strong>{diff.summary.removed}</strong><small>baseline revision only</small></article>
            <article className={`workflow-run-diff__approval workflow-run-diff__approval--${diff.approvalDelta}`}><span>Approval review</span><strong>{diff.approvalDelta === "more-review" ? "More" : diff.approvalDelta === "less-review" ? "Less" : "Same"}</strong><small>{diff.summary.blockedBefore} → {diff.summary.blockedAfter} blocked steps</small></article>
          </div>

          <div className="workflow-run-diff__columns">
            <section className="workflow-run-diff__panel" aria-label="Run metadata changes"><header><div><span className="eyebrow">Metadata and policy</span><h3>{visibleFields.length} entries shown</h3></div><Filter size={16} aria-hidden="true" /></header><div className="workflow-run-diff__entries">{visibleFields.length > 0 ? visibleFields.map((entry) => <article className={`workflow-run-diff__entry workflow-run-diff__entry--${entry.kind}`} key={entry.id}><div className="workflow-run-diff__entry-head"><strong>{entry.label}</strong><span>{kindLabels[entry.kind]} · {impactLabels[entry.impact]}</span></div><div className="workflow-run-diff__values"><span>{displayValue(entry.before)}</span><ArrowLeftRight size={13} aria-hidden="true" /><span>{displayValue(entry.after)}</span></div><small>{entry.detail}</small></article>) : <p className="workflow-run-diff__empty-copy">No metadata entries match this filter.</p>}</div></section>
            <section className="workflow-run-diff__panel" aria-label="Workflow step changes"><header><div><span className="eyebrow">Step plan</span><h3>{visibleSteps.length} steps shown</h3></div><Sparkles size={16} aria-hidden="true" /></header><div className="workflow-run-diff__entries">{visibleSteps.length > 0 ? visibleSteps.map((entry) => <article className={`workflow-run-diff__entry workflow-run-diff__entry--${entry.kind}`} key={entry.id}><div className="workflow-run-diff__entry-head"><strong>{entry.label}</strong><span>{kindLabels[entry.kind]} · {impactLabels[entry.impact]}</span></div><div className="workflow-run-diff__values"><span>{entry.before ? `${stepStatusLabels[entry.before.status]} · ${entry.before.effect}` : "(none)"}</span><ArrowLeftRight size={13} aria-hidden="true" /><span>{entry.after ? `${stepStatusLabels[entry.after.status]} · ${entry.after.effect}` : "(none)"}</span></div><small>{entry.detail}</small></article>) : <p className="workflow-run-diff__empty-copy">No step entries match this filter.</p>}</div></section>
          </div>

          {diff.warningsAdded.length > 0 || diff.warningsRemoved.length > 0 ? <section className="workflow-run-diff__warnings" aria-label="Run diff warnings"><TriangleAlert size={15} aria-hidden="true" /><div><strong>Warning changes</strong>{diff.warningsAdded.length > 0 ? <p><b>Added:</b> {diff.warningsAdded.join(" · ")}</p> : null}{diff.warningsRemoved.length > 0 ? <p><b>Removed:</b> {diff.warningsRemoved.join(" · ")}</p> : null}</div></section> : null}
        </>
      )}

      <section className="workflow-run-diff__export" aria-label="Workflow run diff export preview"><header><div><span className="eyebrow"><Clipboard size={13} /> Portable comparison</span><h3>Export the diff</h3><p>Only redacted revision metadata is included; hidden provider inputs and native receipts stay excluded.</p></div><button type="button" className="button button--secondary" onClick={() => setExportOpen((open) => !open)} aria-expanded={exportOpen} aria-controls="workflow-run-diff-export">{exportOpen ? "Hide run diff export" : "Preview run diff export"}</button></header>{exportOpen ? <div id="workflow-run-diff-export" className="workflow-run-diff__export-body"><div className="workflow-run-diff__export-toolbar"><label><span>Format</span><select aria-label="Run diff export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as WorkflowRunDiffExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--secondary" onClick={() => void copyExport()} disabled={!diff}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={() => setAnnouncement(diff && downloadWorkflowRunDiff(exportPayload, exportFormat) ? "Browser download started; no native diff receipt was created." : "A comparison is required before download.")} disabled={!diff}><Download size={13} /> Download</button></div><pre role="region" aria-label={`${exportFormat === "json" ? "JSON" : "Markdown"} run diff export preview`}><code>{exportPayload || "Select two runs to generate a diff preview."}</code></pre></div> : null}</section>
      <p className="workflow-run-diff__status" aria-live="polite">{announcement}</p>
    </section>
  );
}

export default WorkflowRunDiffPreview;
