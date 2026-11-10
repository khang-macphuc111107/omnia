import {
  Activity,
  Check,
  Clipboard,
  Clock3,
  Download,
  Eye,
  Filter,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

import { redactDiagnosticText } from "./diagnostics-session-contract";
import WorkflowRunDiffPreview from "./workflow-run-diff-preview";

export type WorkflowDryRunStatus = "simulated" | "needs-review" | "blocked" | "failed";
export type WorkflowDryRunTrigger = "manual" | "schedule" | "event";
export type WorkflowDryRunStepStatus = "would-run" | "skipped" | "blocked";
export type WorkflowDryRunExportFormat = "json" | "markdown";
export type WorkflowDryRunExportScope = "all" | "filtered" | "selected";

export interface WorkflowDryRunStep {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly effect: "read" | "transform" | "write" | "external";
  readonly status: WorkflowDryRunStepStatus;
}

export interface WorkflowDryRunRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly revision: number;
  readonly trigger: WorkflowDryRunTrigger;
  readonly status: WorkflowDryRunStatus;
  readonly occurredAt: string;
  readonly durationEstimate: string;
  readonly costEstimate: string;
  readonly routeLabel: string;
  readonly summary: string;
  readonly steps: readonly WorkflowDryRunStep[];
  readonly warnings: readonly string[];
}

export interface WorkflowDryRunHistoryPreviewProps {
  readonly runs?: readonly WorkflowDryRunRecord[];
}

const SEED_RUNS: readonly WorkflowDryRunRecord[] = [
  {
    id: "dry-run-18",
    workflowId: "morning-digest",
    workflowName: "Morning research digest",
    revision: 3,
    trigger: "schedule",
    status: "simulated",
    occurredAt: "Today · 08:30",
    durationEstimate: "1m 20s",
    costEstimate: "$0.00 preview",
    routeLabel: "Research synthesis · not dispatched",
    summary: "Visible notebook sources would be summarized into a review brief.",
    steps: [
      { id: "collect", label: "Collect visible sources", detail: "Use the current renderer notebook projection.", effect: "read", status: "would-run" },
      { id: "synthesize", label: "Draft synthesis", detail: "Prepare a deterministic brief from visible claims.", effect: "transform", status: "would-run" },
      { id: "publish", label: "Publish brief", detail: "Would require an explicit native destination and approval.", effect: "external", status: "blocked" },
    ],
    warnings: ["No provider request or durable artifact was created."],
  },
  {
    id: "dry-run-17",
    workflowId: "repo-watch",
    workflowName: "Repository drift watch",
    revision: 2,
    trigger: "event",
    status: "needs-review",
    occurredAt: "Yesterday · 16:12",
    durationEstimate: "35s",
    costEstimate: "$0.00 preview",
    routeLabel: "Project snapshot comparison · renderer only",
    summary: "Two visible cards changed, but the workspace was not read.",
    steps: [
      { id: "snapshot", label: "Inspect current snapshot", detail: "Compare renderer-visible project metadata.", effect: "read", status: "would-run" },
      { id: "diff", label: "Build change list", detail: "Highlight changed fields and stale evidence.", effect: "transform", status: "would-run" },
      { id: "notify", label: "Create attention item", detail: "Notification dispatch needs a native receipt.", effect: "external", status: "blocked" },
    ],
    warnings: ["Filesystem access and external notification remain planned."],
  },
  {
    id: "dry-run-16",
    workflowId: "weekly-export",
    workflowName: "Weekly workspace export",
    revision: 1,
    trigger: "schedule",
    status: "blocked",
    occurredAt: "Sep 12 · 17:00",
    durationEstimate: "2m",
    costEstimate: "$0.00 preview",
    routeLabel: "Markdown manifest · browser download not started",
    summary: "A manifest can be composed, but no destination has been approved.",
    steps: [
      { id: "manifest", label: "Compose manifest", detail: "Use redacted metadata from this renderer session.", effect: "transform", status: "would-run" },
      { id: "write", label: "Write export file", detail: "Browser download is available only after an explicit user action.", effect: "write", status: "blocked" },
    ],
    warnings: ["No filesystem path, backup, or native export receipt exists."],
  },
  {
    id: "dry-run-15",
    workflowId: "prompt-review",
    workflowName: "Prompt review checklist",
    revision: 4,
    trigger: "manual",
    status: "failed",
    occurredAt: "Sep 10 · 11:04",
    durationEstimate: "12s",
    costEstimate: "$0.00 preview",
    routeLabel: "Chat preflight · incomplete source scope",
    summary: "The rehearsal stopped because the selected source scope was incomplete.",
    steps: [
      { id: "scope", label: "Check source scope", detail: "Require a declared project or standalone scope.", effect: "read", status: "blocked" },
      { id: "budget", label: "Estimate token budget", detail: "No estimate is produced when the scope gate fails.", effect: "transform", status: "skipped" },
    ],
    warnings: ["Choose a valid scope and rehearse again before dispatch."],
  },
];

const statusLabels: Record<WorkflowDryRunStatus, string> = {
  simulated: "Simulated",
  "needs-review": "Needs review",
  blocked: "Blocked",
  failed: "Failed",
};

const triggerLabels: Record<WorkflowDryRunTrigger, string> = {
  manual: "Manual",
  schedule: "Schedule",
  event: "Event",
};

const stepStatusLabels: Record<WorkflowDryRunStepStatus, string> = {
  "would-run": "Would run",
  skipped: "Skipped",
  blocked: "Blocked",
};

function safeText(value: string, maxLength: number): string {
  return redactDiagnosticText(value).slice(0, maxLength);
}

function safeRecord(record: WorkflowDryRunRecord): WorkflowDryRunRecord {
  return {
    ...record,
    id: safeText(record.id, 160),
    workflowId: safeText(record.workflowId, 160),
    workflowName: safeText(record.workflowName, 240),
    occurredAt: safeText(record.occurredAt, 80),
    durationEstimate: safeText(record.durationEstimate, 80),
    costEstimate: safeText(record.costEstimate, 80),
    routeLabel: safeText(record.routeLabel, 240),
    summary: safeText(record.summary, 500),
    steps: record.steps.map((step) => ({
      ...step,
      id: safeText(step.id, 160),
      label: safeText(step.label, 240),
      detail: safeText(step.detail, 1_000),
    })),
    warnings: record.warnings.map((warning) => safeText(warning, 500)),
  };
}

export function serializeWorkflowDryRunHistory(
  runs: readonly WorkflowDryRunRecord[],
  format: WorkflowDryRunExportFormat,
): string {
  const safeRuns = runs.map(safeRecord);
  const boundary = "Renderer-local dry-run history only. No provider request, scheduler, filesystem write, native workflow receipt, or external side effect was created.";
  if (format === "json") {
    return JSON.stringify({
      schema: "omnia.workflow-dry-run-history.preview.v1",
      scope: "renderer-session",
      executionDisposition: "preview-only",
      boundary,
      runCount: safeRuns.length,
      runs: safeRuns,
    }, null, 2);
  }

  return [
    "# Omnia workflow dry-run history preview",
    "",
    `> ${boundary}`,
    "",
    `- Runs: ${safeRuns.length}`,
    "",
    ...(safeRuns.length > 0
      ? safeRuns.flatMap((run) => [
          `## ${run.workflowName} · ${statusLabels[run.status]}`,
          "",
          `- Run: ${run.id}`,
          `- Revision: ${run.revision}`,
          `- Trigger: ${triggerLabels[run.trigger]}`,
          `- Occurred: ${run.occurredAt}`,
          `- Route: ${run.routeLabel}`,
          `- Estimate: ${run.durationEstimate} · ${run.costEstimate}`,
          `- Summary: ${run.summary}`,
          "",
          "### Steps",
          "",
          ...run.steps.map((step) => `- ${step.label} — ${stepStatusLabels[step.status]} (${step.effect}): ${step.detail}`),
          ...(run.warnings.length > 0 ? ["", "Warnings:", ...run.warnings.map((warning) => `- ${warning}`)] : []),
          "",
        ])
      : ["No dry-run records are available in this renderer session.", ""]),
  ].join("\n");
}

export function downloadWorkflowDryRunHistory(
  payload: string,
  format: WorkflowDryRunExportFormat,
): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-workflow-dry-run-history.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function statusIcon(status: WorkflowDryRunStatus) {
  if (status === "simulated") return <Check size={13} aria-hidden="true" />;
  if (status === "failed") return <XCircle size={13} aria-hidden="true" />;
  return <TriangleAlert size={13} aria-hidden="true" />;
}

export function WorkflowDryRunHistoryPreview({ runs: providedRuns }: WorkflowDryRunHistoryPreviewProps) {
  const [runs, setRuns] = useState<WorkflowDryRunRecord[]>(() => [...(providedRuns ?? SEED_RUNS)]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<WorkflowDryRunStatus | "all">("all");
  const [triggerFilter, setTriggerFilter] = useState<WorkflowDryRunTrigger | "all">("all");
  const [workflowFilter, setWorkflowFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(runs[0]?.id ?? null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<WorkflowDryRunExportFormat>("json");
  const [exportScope, setExportScope] = useState<WorkflowDryRunExportScope>("all");
  const [announcement, setAnnouncement] = useState("Renderer-local dry-run history loaded.");

  const visibleRuns = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return runs.filter((run) => {
      const matchesQuery = !normalizedQuery || [run.workflowName, run.summary, run.routeLabel, run.id].some((value) => value.toLowerCase().includes(normalizedQuery));
      const matchesStatus = statusFilter === "all" || run.status === statusFilter;
      const matchesTrigger = triggerFilter === "all" || run.trigger === triggerFilter;
      const matchesWorkflow = workflowFilter === "all" || run.workflowId === workflowFilter;
      return matchesQuery && matchesStatus && matchesTrigger && matchesWorkflow;
    });
  }, [query, runs, statusFilter, triggerFilter, workflowFilter]);

  const selected = visibleRuns.find((run) => run.id === selectedId) ?? visibleRuns[0] ?? null;
  const workflowOptions = useMemo(() => [...new Map(runs.map((run) => [run.workflowId, run.workflowName])).entries()], [runs]);
  const exportRuns = exportScope === "filtered" ? visibleRuns : exportScope === "selected" ? (selected ? [selected] : []) : runs;
  const exportPayload = useMemo(() => serializeWorkflowDryRunHistory(exportRuns, exportFormat), [exportFormat, exportRuns]);

  const rehearse = (run: WorkflowDryRunRecord) => {
    const nextRun: WorkflowDryRunRecord = {
      ...run,
      id: `dry-run-${runs.length + 19}`,
      occurredAt: "Just now · renderer preview",
      status: run.status === "failed" ? "needs-review" : "simulated",
      warnings: [...run.warnings, "Rehearsed again locally; no native operation was started."],
    };
    setRuns((current) => [nextRun, ...current]);
    setSelectedId(nextRun.id);
    setAnnouncement(`${run.workflowName} rehearsed again in renderer history; no native operation was started.`);
  };

  const reset = () => {
    const nextRuns = [...(providedRuns ?? SEED_RUNS)];
    setRuns(nextRuns);
    setQuery("");
    setStatusFilter("all");
    setTriggerFilter("all");
    setWorkflowFilter("all");
    setSelectedId(nextRuns[0]?.id ?? null);
    setExportOpen(false);
    setExportScope("all");
    setAnnouncement("Dry-run history reset for this renderer session.");
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setAnnouncement("Clipboard is unavailable; no dry-run history was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setAnnouncement(`${exportFormat.toUpperCase()} dry-run history copied; no durable write was made.`);
    } catch {
      setAnnouncement("Clipboard access was denied; the export remains renderer-local.");
    }
  };

  return (
    <section className="workflow-dry-run-history" aria-labelledby="workflow-dry-run-history-heading">
      <header className="workflow-dry-run-history__header">
        <div>
          <span className="eyebrow"><Activity size={13} /> Workflows · dry-run history</span>
          <h2 id="workflow-dry-run-history-heading">Dry-run history</h2>
          <p>Inspect what a workflow would do, which steps are blocked, and what still needs an explicit native approval.</p>
        </div>
        <span className="workflow-dry-run-history__badge"><Eye size={13} /> Preview only</span>
      </header>

      <p className="workflow-dry-run-history__boundary"><ShieldCheck size={14} /> Renderer-local · no durable write · no provider request · no scheduler, filesystem mutation, native receipt, or external side effect.</p>

      <div className="workflow-dry-run-history__summary" aria-label="Dry-run history summary">
        <article><span>Total rehearsals</span><strong>{runs.length}</strong><small>visible this session</small></article>
        <article><span>Simulated</span><strong>{runs.filter((run) => run.status === "simulated").length}</strong><small>all gates local</small></article>
        <article><span>Needs review</span><strong>{runs.filter((run) => run.status === "needs-review").length}</strong><small>human check suggested</small></article>
        <article><span>Blocked</span><strong>{runs.filter((run) => run.status === "blocked" || run.status === "failed").length}</strong><small>not dispatchable</small></article>
      </div>

      <div className="workflow-dry-run-history__toolbar" role="toolbar" aria-label="Dry-run history filters">
        <label className="workflow-dry-run-history__search"><Search size={14} aria-hidden="true" /><span className="sr-only">Search dry-run history</span><input aria-label="Search dry-run history" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workflow, route, or run ID" /></label>
        <label><span>Status</span><select aria-label="Dry-run status filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as WorkflowDryRunStatus | "all")}><option value="all">All statuses</option><option value="simulated">Simulated</option><option value="needs-review">Needs review</option><option value="blocked">Blocked</option><option value="failed">Failed</option></select></label>
        <label><span>Trigger</span><select aria-label="Dry-run trigger filter" value={triggerFilter} onChange={(event) => setTriggerFilter(event.target.value as WorkflowDryRunTrigger | "all")}><option value="all">All triggers</option><option value="manual">Manual</option><option value="schedule">Schedule</option><option value="event">Event</option></select></label>
        <label><span>Workflow</span><select aria-label="Dry-run workflow filter" value={workflowFilter} onChange={(event) => setWorkflowFilter(event.target.value)}><option value="all">All workflows</option>{workflowOptions.map(([workflowId, workflowName]) => <option key={workflowId} value={workflowId}>{workflowName}</option>)}</select></label>
        <span className="workflow-dry-run-history__result-count"><Filter size={13} /> {visibleRuns.length} shown</span>
        <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={13} /> Reset</button>
      </div>

      <div className="workflow-dry-run-history__layout">
        <div className="workflow-dry-run-history__list" role="list" aria-label="Workflow dry-run records">
          {visibleRuns.map((run) => (
            <button type="button" key={run.id} className={`workflow-dry-run-history__row${selected?.id === run.id ? " is-selected" : ""}`} onClick={() => setSelectedId(run.id)} aria-pressed={selected?.id === run.id}>
              <span className={`workflow-dry-run-history__status workflow-dry-run-history__status--${run.status}`}>{statusIcon(run.status)} {statusLabels[run.status]}</span>
              <span className="workflow-dry-run-history__row-copy"><strong>{run.workflowName}</strong><small>{run.summary}</small></span>
              <span className="workflow-dry-run-history__row-meta"><span>{triggerLabels[run.trigger]}</span><time>{run.occurredAt}</time></span>
            </button>
          ))}
          {visibleRuns.length === 0 ? <p className="workflow-dry-run-history__empty">No dry-run records match these filters.</p> : null}
        </div>

        {selected ? (
          <aside className="workflow-dry-run-history__detail" aria-label={`Selected dry-run ${selected.workflowName}`}>
            <div className="workflow-dry-run-history__detail-heading"><div><span className="eyebrow">Selected rehearsal · revision {selected.revision}</span><h3>{selected.workflowName}</h3><p>{selected.summary}</p></div><span className={`workflow-dry-run-history__status workflow-dry-run-history__status--${selected.status}`}>{statusIcon(selected.status)} {statusLabels[selected.status]}</span></div>
            <div className="workflow-dry-run-history__meta-grid"><div><span>Route</span><strong>{selected.routeLabel}</strong></div><div><span>Estimate</span><strong><Clock3 size={13} /> {selected.durationEstimate} · {selected.costEstimate}</strong></div><div><span>Trigger</span><strong>{triggerLabels[selected.trigger]}</strong></div><div><span>Disposition</span><strong>Preview only</strong></div></div>
            <div className="workflow-dry-run-history__steps"><div className="workflow-dry-run-history__section-title"><span className="eyebrow">Step plan</span><small>{selected.steps.filter((step) => step.status === "would-run").length} would run · {selected.steps.filter((step) => step.status === "blocked").length} blocked</small></div><ol>{selected.steps.map((step, index) => <li key={step.id} className={`workflow-dry-run-history__step workflow-dry-run-history__step--${step.status}`}><span>{index + 1}</span><div><strong>{step.label}</strong><small>{step.detail}</small><em>{stepStatusLabels[step.status]} · {step.effect}</em></div></li>)}</ol></div>
            {selected.warnings.length > 0 ? <div className="workflow-dry-run-history__warnings" role="note"><TriangleAlert size={14} /><div><strong>Review notes</strong><ul>{selected.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div></div> : null}
            <button type="button" className="button button--primary" onClick={() => rehearse(selected)}><Play size={14} /> Rehearse again locally</button>
          </aside>
        ) : <div className="workflow-dry-run-history__detail workflow-dry-run-history__detail--empty"><Eye size={20} /><strong>Select a rehearsal to inspect its steps.</strong><p>Empty or filtered history never starts a workflow.</p></div>}
      </div>

      <WorkflowRunDiffPreview runs={runs} selectedRunId={selectedId} />

      <section className="workflow-dry-run-history__export" aria-label="Workflow dry-run history export preview">
        <header><div><span className="eyebrow"><Clipboard size={13} /> Portable history</span><h3>Export the rehearsal record</h3><p>Only bounded, redacted preview facts are included; hidden provider payloads and native receipts are excluded.</p></div><button type="button" className="button button--secondary" onClick={() => setExportOpen((open) => !open)} aria-expanded={exportOpen} aria-controls="workflow-dry-run-history-export">{exportOpen ? "Hide export" : "Preview export"}</button></header>
        {exportOpen ? <div id="workflow-dry-run-history-export" className="workflow-dry-run-history__export-body"><div className="workflow-dry-run-history__export-toolbar"><label><span>Scope</span><select aria-label="Dry-run history export scope" value={exportScope} onChange={(event) => setExportScope(event.target.value as WorkflowDryRunExportScope)}><option value="all">All runs ({runs.length})</option><option value="filtered">Filtered runs ({visibleRuns.length})</option><option value="selected" disabled={!selected}>Selected run only</option></select></label><label><span>Format</span><select aria-label="Dry-run history export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as WorkflowDryRunExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><span className="workflow-dry-run-history__export-count" role="status">{exportRuns.length} run{exportRuns.length === 1 ? "" : "s"} in this export</span><button type="button" className="button button--secondary" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={() => setAnnouncement(downloadWorkflowDryRunHistory(exportPayload, exportFormat) ? "Browser download started; no native export receipt was created." : "Browser download is unavailable in this preview environment.")}><Download size={13} /> Download</button></div><pre role="region" aria-label={`${exportFormat === "json" ? "JSON" : "Markdown"} dry-run history export preview`}><code>{exportPayload}</code></pre></div> : null}
      </section>

      <p className="workflow-dry-run-history__status-line" role="status" aria-live="polite">{announcement}</p>
    </section>
  );
}

export default WorkflowDryRunHistoryPreview;
