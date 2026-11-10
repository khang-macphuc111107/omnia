import {
  AlertTriangle,
  Check,
  CircleHelp,
  GitCompareArrows,
  History,
  LockKeyhole,
  Pin,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { ProjectOverviewView } from "./types";

export type OverviewMaterialityReason =
  | "goal"
  | "scope"
  | "workspace_root"
  | "branch"
  | "runtime_policy"
  | "decision"
  | "milestone"
  | "task"
  | "verified_evidence"
  | "source_staleness"
  | "artifact"
  | "budget"
  | "security"
  | "approval";

type TitlePolicy = "manual" | "locked" | "suggest_once" | "always_ask" | "safe_auto";
type PinnedField = "title" | "summary" | "goal" | "phase";

interface MaterialityOption {
  id: OverviewMaterialityReason;
  label: string;
  detail: string;
  fields: readonly string[];
}

interface CandidatePreview {
  id: string;
  changedFields: readonly string[];
  reasons: readonly OverviewMaterialityReason[];
  titlePolicy: TitlePolicy;
  pinnedFields: readonly PinnedField[];
  sourceWatermark: string;
  generatedAt: string;
}

const MATERIALITY_OPTIONS: readonly MaterialityOption[] = [
  { id: "goal", label: "Goal or scope changed", detail: "Re-evaluate title and summary", fields: ["title", "summary"] },
  { id: "branch", label: "Branch or worktree changed", detail: "Re-check branch and next task", fields: ["branch", "next task"] },
  { id: "task", label: "Task or milestone changed", detail: "Re-rank the next dependency-complete task", fields: ["phase", "milestone", "next task"] },
  { id: "verified_evidence", label: "Verified evidence changed", detail: "Refresh build, test, or research evidence", fields: ["verified evidence", "summary"] },
  { id: "source_staleness", label: "Source became stale", detail: "Propagate staleness without hiding the last revision", fields: ["status", "evidence"] },
  { id: "security", label: "Security or approval condition changed", detail: "Re-check what may run next", fields: ["attention", "approvals"] },
];

const TITLE_POLICIES: readonly { id: TitlePolicy; label: string; detail: string }[] = [
  { id: "manual", label: "Manual only", detail: "Never suggest a title change" },
  { id: "locked", label: "Locked", detail: "Preserve the current title and aliases" },
  { id: "suggest_once", label: "Suggest once", detail: "Ask before the first candidate" },
  { id: "always_ask", label: "Always ask", detail: "Every material title candidate needs review" },
  { id: "safe_auto", label: "Safe automatic", detail: "Only if deterministic checks allow it" },
];

const PINNABLE_FIELDS: readonly { id: PinnedField; label: string; detail: string }[] = [
  { id: "title", label: "Title", detail: "Keep the user-facing project name" },
  { id: "summary", label: "Summary", detail: "Keep authored project context" },
  { id: "goal", label: "Goal", detail: "Keep the primary goal text" },
  { id: "phase", label: "Phase", detail: "Keep the current phase label" },
];

const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  summary: "Summary",
  goal: "Goal",
  phase: "Phase",
  milestone: "Milestone",
  "next task": "Next task",
  branch: "Branch / worktree",
  "verified evidence": "Verified evidence",
  evidence: "Evidence freshness",
  status: "Overview status",
  attention: "Attention",
  approvals: "Approvals",
};

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function valueOrUnknown(value: string | null | undefined): string {
  return value && value.trim() ? value : "Unknown in this preview";
}

function candidateDescription(candidate: CandidatePreview | null): string {
  if (!candidate) return "No candidate generated. Choose a material signal, then request a refresh.";
  if (candidate.reasons.length === 0) {
    return "No material root selected. Cosmetic activity would not churn the overview or title.";
  }
  return "A deterministic candidate would be created. Native evidence is still required before any unknown field becomes a fact.";
}

export interface ProjectOverviewRefreshPreviewProps {
  projectId: string;
  overview: ProjectOverviewView;
}

/**
 * UI-first rehearsal for the normative Project Overview refresh pipeline.
 *
 * This component deliberately keeps all state in the renderer. It demonstrates
 * materiality classification, pinned-field preservation, title policy, compare,
 * and reversible candidate review without pretending to create a native revision.
 */
export function ProjectOverviewRefreshPreview({ projectId, overview }: ProjectOverviewRefreshPreviewProps) {
  const [selectedReasons, setSelectedReasons] = useState<OverviewMaterialityReason[]>([]);
  const [titlePolicy, setTitlePolicy] = useState<TitlePolicy>("always_ask");
  const [pinnedFields, setPinnedFields] = useState<PinnedField[]>(["title"]);
  const [candidate, setCandidate] = useState<CandidatePreview | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [status, setStatus] = useState("Renderer-local refresh rehearsal ready.");
  const [sequence, setSequence] = useState(0);

  const changedFields = useMemo(
    () => unique(selectedReasons.flatMap((reason) => MATERIALITY_OPTIONS.find((option) => option.id === reason)?.fields ?? [])),
    [selectedReasons],
  );

  const toggleReason = (reason: OverviewMaterialityReason) => {
    setSelectedReasons((current) => current.includes(reason) ? current.filter((item) => item !== reason) : [...current, reason]);
    setCandidate(null);
    setCompareOpen(false);
    setStatus("Materiality inputs changed. Generate a new candidate to review the deterministic diff.");
  };

  const togglePinnedField = (field: PinnedField) => {
    setPinnedFields((current) => current.includes(field) ? current.filter((item) => item !== field) : [...current, field]);
    setCandidate(null);
    setCompareOpen(false);
    setStatus("Pinned-field policy changed. Existing candidates remain untouched until regenerated.");
  };

  const generateCandidate = () => {
    const nextSequence = sequence + 1;
    setSequence(nextSequence);
    setCandidate({
      id: `preview-${projectId}-candidate-${nextSequence}`,
      changedFields,
      reasons: selectedReasons,
      titlePolicy,
      pinnedFields,
      sourceWatermark: overview.sourceEventWatermark === null ? "unknown" : String(overview.sourceEventWatermark),
      generatedAt: new Date().toISOString(),
    });
    setCompareOpen(false);
    setStatus(selectedReasons.length > 0 ? "Candidate generated in preview. No durable overview revision was created." : "No material change detected in preview; the current projection is preserved.");
  };

  const acceptCandidate = () => {
    if (!candidate) return;
    setStatus("Accepted in renderer preview only. The prior overview remains unchanged because native revision storage is unavailable.");
  };

  const discardCandidate = () => {
    setCandidate(null);
    setCompareOpen(false);
    setStatus("Candidate discarded in preview. The last overview projection remains visible.");
  };

  const resetPreview = () => {
    setSelectedReasons([]);
    setTitlePolicy("always_ask");
    setPinnedFields(["title"]);
    setCandidate(null);
    setCompareOpen(false);
    setStatus("Refresh rehearsal reset to defaults.");
  };

  return (
    <section className="project-overview-refresh" aria-labelledby={`project-overview-refresh-title-${projectId}`}>
      <header className="project-overview-refresh__header">
        <div>
          <span className="eyebrow"><Sparkles size={13} /> Smart refresh rehearsal</span>
          <h3 id={`project-overview-refresh-title-${projectId}`}>Refresh only when project facts move</h3>
          <p>Preview materiality checks, pinned fields, title policy, and reversible candidate review before native Project Twin wiring is available.</p>
        </div>
        <span className="project-overview-refresh__badge"><EyeIcon /> Preview only</span>
      </header>

      <div className="project-overview-refresh__grid">
        <article className="project-overview-refresh__panel">
          <header>
            <div><strong>Materiality signals</strong><small>Cosmetic typing, hover, and polling stay out.</small></div>
            <CircleHelp size={15} aria-hidden="true" />
          </header>
          <fieldset className="project-overview-refresh__signals">
            <legend>Simulate a source change</legend>
            {MATERIALITY_OPTIONS.map((option) => (
              <label key={option.id} className="project-overview-refresh__signal">
                <input type="checkbox" checked={selectedReasons.includes(option.id)} onChange={() => toggleReason(option.id)} />
                <span><strong>{option.label}</strong><small>{option.detail}</small></span>
              </label>
            ))}
          </fieldset>
          <div className="project-overview-refresh__selection"><span>Candidate fields</span><strong>{changedFields.length ? changedFields.map((field) => FIELD_LABELS[field] ?? field).join(" · ") : "None selected"}</strong></div>
        </article>

        <article className="project-overview-refresh__panel">
          <header>
            <div><strong>Title policy &amp; pins</strong><small>User-authored fields win over generated suggestions.</small></div>
            <LockKeyhole size={15} aria-hidden="true" />
          </header>
          <label className="project-overview-refresh__select"><span>Automatic title changes</span><select aria-label="Automatic title changes" value={titlePolicy} onChange={(event) => { setTitlePolicy(event.target.value as TitlePolicy); setCandidate(null); setStatus("Title policy changed. Generate a new candidate to review it."); }}>
            {TITLE_POLICIES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select><small>{TITLE_POLICIES.find((option) => option.id === titlePolicy)?.detail}</small></label>
          <fieldset className="project-overview-refresh__pins">
            <legend>Pinned fields survive refresh</legend>
            {PINNABLE_FIELDS.map((field) => (
              <label key={field.id} className="project-overview-refresh__pin">
                <input type="checkbox" checked={pinnedFields.includes(field.id)} onChange={() => togglePinnedField(field.id)} />
                <Pin size={12} aria-hidden="true" /><span><strong>{field.label}</strong><small>{field.detail}</small></span>
              </label>
            ))}
          </fieldset>
        </article>
      </div>

      <div className="project-overview-refresh__toolbar" role="toolbar" aria-label="Project overview refresh preview actions">
        <button type="button" className="button button--secondary" onClick={generateCandidate}><RefreshCw size={14} /> Generate candidate</button>
        <button type="button" className="button button--ghost" disabled={!candidate} onClick={() => { setCompareOpen((open) => !open); setStatus(compareOpen ? "Candidate comparison closed." : "Comparing the current projection with the renderer candidate."); }}><GitCompareArrows size={14} /> {compareOpen ? "Hide compare" : "Compare"}</button>
        <button type="button" className="button button--ghost" disabled={!candidate} onClick={acceptCandidate}><Check size={14} /> Accept in preview</button>
        <button type="button" className="button button--ghost" disabled={!candidate} onClick={discardCandidate}><X size={14} /> Discard</button>
        <button type="button" className="button button--ghost" onClick={resetPreview}><RotateCcw size={14} /> Reset rehearsal</button>
      </div>

      <div className={`project-overview-refresh__candidate${candidate ? " is-ready" : ""}`} role="region" aria-live="polite" aria-label="Project overview refresh candidate">
        <div className="project-overview-refresh__candidate-heading"><div><span className="project-overview-refresh__candidate-kicker"><History size={13} /> Candidate state</span><strong>{candidate ? candidate.id : "No candidate yet"}</strong></div><span className="project-overview-refresh__candidate-status">{candidate ? candidate.reasons.length ? "Candidate" : "No material change" : "Waiting"}</span></div>
        <p>{candidateDescription(candidate)}</p>
        <div className="project-overview-refresh__candidate-facts">
          <span><small>Source watermark</small><strong>{candidate?.sourceWatermark ?? (overview.sourceEventWatermark === null ? "Unknown" : overview.sourceEventWatermark)}</strong></span>
          <span><small>Title policy</small><strong>{TITLE_POLICIES.find((option) => option.id === (candidate?.titlePolicy ?? titlePolicy))?.label}</strong></span>
          <span><small>Pinned</small><strong>{(candidate?.pinnedFields ?? pinnedFields).length ? (candidate?.pinnedFields ?? pinnedFields).join(", ") : "None"}</strong></span>
        </div>
        {candidate && candidate.changedFields.length > 0 ? <div className="project-overview-refresh__diff" aria-label="Candidate field diff preview"><header><span><GitCompareArrows size={13} /> Deterministic diff preview</span><small>Values remain evidence-gated</small></header>{candidate.changedFields.map((field) => { const pinned = candidate.pinnedFields.includes(field as PinnedField); return <div key={field}><span>{FIELD_LABELS[field] ?? field}</span><del>{valueOrUnknown(field === "title" ? overview.title : field === "summary" ? overview.summary : field === "goal" ? overview.goal : field === "phase" ? overview.phase : null)}</del><strong>{pinned ? "Preserved because it is pinned" : "Pending native evidence"}</strong></div>; })}</div> : null}
        {compareOpen && candidate ? <div className="project-overview-refresh__compare"><ShieldCheck size={15} /><span><strong>Compare mode is renderer-local.</strong> The existing projection is retained while this candidate is reviewed; accepting here cannot create a native revision, overwrite history, or update the Project Twin.</span></div> : null}
      </div>

      <p className="project-overview-refresh__status" role="status"><AlertTriangle size={14} /> {status}</p>
      <p className="project-overview-refresh__boundary"><ShieldCheck size={14} /> Manual refresh, candidate generation, compare, accept, discard, and pinned-field controls are renderer-local only. No provider request, native write, durable revision, restart recovery, or Project Twin mutation occurs in this preview.</p>
    </section>
  );
}

function EyeIcon() {
  return <span aria-hidden="true">◉</span>;
}
