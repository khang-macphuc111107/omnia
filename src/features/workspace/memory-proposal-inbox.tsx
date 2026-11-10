import {
  CheckCircle2,
  Clock3,
  FileText,
  Inbox,
  Info,
  Link2,
  ListChecks,
  MessageSquareText,
  RotateCcw,
  Search,
  ShieldAlert,
  ThumbsDown,
  ThumbsUp,
  Undo2,
  Redo2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { MemorySensitivity, MemoryView } from "./types";

export type MemoryProposalDecision = "pending" | "approved" | "rejected";
export type MemoryProposalRisk = "low" | "review" | "sensitive";
export type MemoryProposalReviewCheckId = "evidence" | "conflicts" | "scope" | "retention";

export type MemoryProposalReviewState = {
  readonly checks: Record<MemoryProposalReviewCheckId, boolean>;
  readonly note: string;
};

const REVIEW_CHECK_IDS: readonly MemoryProposalReviewCheckId[] = ["evidence", "conflicts", "scope", "retention"];

const REVIEW_CHECK_LABELS: Record<MemoryProposalReviewCheckId, string> = {
  evidence: "Evidence pointers inspected",
  conflicts: "Conflict and duplicate signals reviewed",
  scope: "Memory scope confirmed",
  retention: "Retention window checked",
};

export interface MemoryProposalInboxItem {
  readonly id: string;
  readonly memoryId: string;
  readonly revisionId: string;
  readonly content: string;
  readonly title?: string | null;
  readonly scopeLabel: string;
  readonly kind: MemoryView["kind"];
  readonly confidence: number | null;
  /**
   * Sensitivity is a closed domain classification, not an arbitrary display
   * label. Keeping the proposal contract aligned with MemoryView prevents an
   * invalid category from crossing the proposal/revision preview boundary.
   */
  readonly sensitivity: readonly MemorySensitivity[];
  readonly sourceLabel: string;
  readonly evidenceMessageIds: readonly string[];
  readonly sourceRunIds: readonly string[];
  readonly contradictionRevisionIds: readonly string[];
  readonly duplicateRevisionIds: readonly string[];
  readonly createdAtLabel: string;
  readonly retainUntilLabel: string;
  readonly qualityScore: number;
  readonly decision?: MemoryProposalDecision;
}

export const DEFAULT_MEMORY_PROPOSALS: readonly MemoryProposalInboxItem[] = [
  {
    id: "proposal-compact-reports",
    memoryId: "memory-report-style",
    revisionId: "memory-report-style-r3",
    content: "Prefer compact implementation reports with exact paths and focused evidence.",
    title: "Reporting style",
    scopeLabel: "Global",
    kind: "preference",
    confidence: 0.94,
    sensitivity: ["normal"],
    sourceLabel: "Chat · Omnia build handoff",
    evidenceMessageIds: ["msg-handoff-042", "msg-handoff-051"],
    sourceRunIds: ["run-preview-2026-09-24"],
    contradictionRevisionIds: [],
    duplicateRevisionIds: [],
    createdAtLabel: "2 minutes ago",
    retainUntilLabel: "30 days",
    qualityScore: 0.96,
    decision: "pending",
  },
  {
    id: "proposal-renderer-boundary",
    memoryId: "memory-renderer-boundary",
    revisionId: "memory-renderer-boundary-r2",
    content: "Keep renderer preview claims distinct from native persistence and runtime receipts.",
    title: "Preview truthfulness",
    scopeLabel: "Project · Omnia",
    kind: "constraint",
    confidence: 0.89,
    sensitivity: ["normal"],
    sourceLabel: "Chat · Project Control Deck review",
    evidenceMessageIds: ["msg-deck-118"],
    sourceRunIds: ["run-project-audit-17"],
    contradictionRevisionIds: ["memory-renderer-boundary-r1"],
    duplicateRevisionIds: ["memory-preview-boundary-r1"],
    createdAtLabel: "18 minutes ago",
    retainUntilLabel: "Project lifetime",
    qualityScore: 0.82,
    decision: "pending",
  },
  {
    id: "proposal-study-routine",
    memoryId: "memory-study-routine",
    revisionId: "memory-study-routine-r1",
    content: "When working on algorithm exercises, show a proof sketch before optimization ideas.",
    title: "Algorithm study routine",
    scopeLabel: "Assistant · CSE tutor",
    kind: "workflow",
    confidence: 0.67,
    sensitivity: ["personal"],
    sourceLabel: "Chat · Algorithm Lab",
    evidenceMessageIds: ["msg-algo-009", "msg-algo-014"],
    sourceRunIds: ["run-algo-lab-03"],
    contradictionRevisionIds: [],
    duplicateRevisionIds: ["memory-study-routine-r0"],
    createdAtLabel: "Yesterday",
    retainUntilLabel: "90 days",
    qualityScore: 0.64,
    decision: "pending",
  },
];

type ProposalFilter = "all" | MemoryProposalDecision;
type RiskFilter = "all" | MemoryProposalRisk;

function riskFor(proposal: MemoryProposalInboxItem): MemoryProposalRisk {
  if (proposal.sensitivity.some((category) => category !== "normal")) return "sensitive";
  if (proposal.contradictionRevisionIds.length > 0 || proposal.duplicateRevisionIds.length > 0 || (proposal.confidence ?? 0) < 0.75) return "review";
  return "low";
}

function confidenceLabel(confidence: number | null): string {
  return confidence === null ? "Explicit" : `${Math.round(confidence * 100)}%`;
}

function decisionLabel(decision: MemoryProposalDecision): string {
  return decision.charAt(0).toUpperCase() + decision.slice(1);
}

function riskLabel(risk: MemoryProposalRisk): string {
  return risk === "low" ? "Low review risk" : risk === "sensitive" ? "Sensitive" : "Needs review";
}

function reviewStateFor(proposal: MemoryProposalInboxItem): MemoryProposalReviewState {
  return {
    checks: {
      evidence: proposal.evidenceMessageIds.length > 0 || proposal.sourceRunIds.length > 0,
      conflicts: proposal.contradictionRevisionIds.length === 0 && proposal.duplicateRevisionIds.length === 0,
      scope: proposal.scopeLabel.trim().length > 0,
      retention: proposal.retainUntilLabel.trim().length > 0,
    },
    note: "",
  };
}

function cloneReviewStates(proposals: readonly MemoryProposalInboxItem[]): Record<string, MemoryProposalReviewState> {
  return Object.fromEntries(proposals.map((proposal) => {
    const state = reviewStateFor(proposal);
    return [proposal.id, { checks: { ...state.checks }, note: state.note }];
  }));
}

function isReviewReady(state: MemoryProposalReviewState | undefined): boolean {
  return Boolean(state) && REVIEW_CHECK_IDS.every((checkId) => state?.checks[checkId]);
}

function cloneDecisions(proposals: readonly MemoryProposalInboxItem[]): Record<string, MemoryProposalDecision> {
  return Object.fromEntries(proposals.map((proposal) => [proposal.id, proposal.decision ?? "pending"]));
}

function decisionsEqual(
  left: Record<string, MemoryProposalDecision>,
  right: Record<string, MemoryProposalDecision>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
}

const DECISION_HISTORY_LIMIT = 20;

export type MemoryProposalInboxProps = {
  readonly proposals?: readonly MemoryProposalInboxItem[];
};

export function MemoryProposalInbox({ proposals = DEFAULT_MEMORY_PROPOSALS }: MemoryProposalInboxProps) {
  const [query, setQuery] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<ProposalFilter>("pending");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(proposals[0]?.id ?? null);
  const [decisions, setDecisions] = useState<Record<string, MemoryProposalDecision>>(() => cloneDecisions(proposals));
  const [undoStack, setUndoStack] = useState<readonly Record<string, MemoryProposalDecision>[]>([]);
  const [redoStack, setRedoStack] = useState<readonly Record<string, MemoryProposalDecision>[]>([]);
  const [reviewStates, setReviewStates] = useState<Record<string, MemoryProposalReviewState>>(() => cloneReviewStates(proposals));
  const [notice, setNotice] = useState("Review is renderer-local until the native memory bridge is connected.");

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return proposals.filter((proposal) => {
      const decision = decisions[proposal.id] ?? "pending";
      const risk = riskFor(proposal);
      const matchesQuery = !normalized || [
        proposal.content,
        proposal.title ?? "",
        proposal.scopeLabel,
        proposal.sourceLabel,
        proposal.id,
        proposal.revisionId,
      ].join(" ").toLowerCase().includes(normalized);
      return matchesQuery
        && (decisionFilter === "all" || decision === decisionFilter)
        && (riskFilter === "all" || risk === riskFilter);
    });
  }, [decisionFilter, decisions, proposals, query, riskFilter]);

  const selected = filtered.find((proposal) => proposal.id === selectedId)
    ?? proposals.find((proposal) => proposal.id === selectedId)
    ?? filtered[0]
    ?? null;
  const selectedReview = selected
    ? reviewStates[selected.id] ?? reviewStateFor(selected)
    : undefined;

  const counts = useMemo(() => {
    const values = proposals.map((proposal) => decisions[proposal.id] ?? "pending");
    return {
      pending: values.filter((decision) => decision === "pending").length,
      approved: values.filter((decision) => decision === "approved").length,
      rejected: values.filter((decision) => decision === "rejected").length,
    };
  }, [decisions, proposals]);

  const commitDecisions = (next: Record<string, MemoryProposalDecision>, message: string) => {
    if (decisionsEqual(decisions, next)) return;
    setUndoStack((current) => [...current, decisions].slice(-DECISION_HISTORY_LIMIT));
    setRedoStack([]);
    setDecisions(next);
    setNotice(message);
  };

  const updateDecision = (proposal: MemoryProposalInboxItem, decision: Exclude<MemoryProposalDecision, "pending">) => {
    commitDecisions(
      { ...decisions, [proposal.id]: decision },
      `${decisionLabel(decision)} “${proposal.title ?? proposal.content}” in this renderer preview only.`,
    );
  };

  const returnToPending = (proposal: MemoryProposalInboxItem) => {
    commitDecisions(
      { ...decisions, [proposal.id]: "pending" },
      "Proposal returned to pending in this renderer preview.",
    );
  };

  const undoDecision = () => {
    const previous = undoStack.at(-1);
    if (!previous) return;
    setUndoStack((current) => current.slice(0, -1));
    setRedoStack((current) => [...current, decisions].slice(-DECISION_HISTORY_LIMIT));
    setDecisions(previous);
    setNotice("Undid the last proposal decision in this renderer preview.");
  };

  const redoDecision = () => {
    const next = redoStack.at(-1);
    if (!next) return;
    setRedoStack((current) => current.slice(0, -1));
    setUndoStack((current) => [...current, decisions].slice(-DECISION_HISTORY_LIMIT));
    setDecisions(next);
    setNotice("Redid the proposal decision in this renderer preview.");
  };

  const updateVisibleDecisions = (decision: Exclude<MemoryProposalDecision, "pending">) => {
    if (filtered.length === 0) {
      setNotice("No visible proposals match the current filters.");
      return;
    }
    const next = { ...decisions };
    filtered.forEach((proposal) => {
      next[proposal.id] = decision;
    });
    commitDecisions(
      next,
      `${decisionLabel(decision)} ${filtered.length} visible proposal${filtered.length === 1 ? "" : "s"} in this renderer preview only.`,
    );
  };

  const resetDecisions = () => {
    const next = cloneDecisions(proposals);
    if (decisionsEqual(decisions, next)) {
      setNotice("Proposal decisions are already at the incoming preview state.");
      return;
    }
    setUndoStack((current) => [...current, decisions].slice(-DECISION_HISTORY_LIMIT));
    setRedoStack([]);
    setDecisions(next);
    setNotice("Proposal decisions reset to the incoming preview state.");
  };

  const updateReview = (proposal: MemoryProposalInboxItem, update: (current: MemoryProposalReviewState) => MemoryProposalReviewState, message: string) => {
    setReviewStates((current) => {
      const existing = current[proposal.id] ?? reviewStateFor(proposal);
      return { ...current, [proposal.id]: update(existing) };
    });
    setNotice(message);
  };

  const toggleReviewCheck = (proposal: MemoryProposalInboxItem, checkId: MemoryProposalReviewCheckId, checked: boolean) => {
    updateReview(
      proposal,
      (current) => ({ ...current, checks: { ...current.checks, [checkId]: checked } }),
      `${REVIEW_CHECK_LABELS[checkId]} ${checked ? "marked complete" : "reopened"} for this renderer preview.`,
    );
  };

  const updateReviewNote = (proposal: MemoryProposalInboxItem, note: string) => {
    updateReview(proposal, (current) => ({ ...current, note }), "Reviewer note updated in this renderer preview.");
  };

  const markReviewReady = (proposal: MemoryProposalInboxItem) => {
    updateReview(
      proposal,
      (current) => ({ ...current, checks: { evidence: true, conflicts: true, scope: true, retention: true } }),
      "Proposal review marked ready in this renderer preview only.",
    );
  };

  const resetReview = (proposal: MemoryProposalInboxItem) => {
    const next = reviewStateFor(proposal);
    updateReview(proposal, () => next, "Proposal review reset to its incoming preview checks.");
  };

  return (
    <section className="memory-proposal-inbox" aria-label="Memory proposal inbox">
      <header className="memory-proposal-inbox__header">
        <div>
          <span className="eyebrow">Illustrative renderer-local review queue</span>
          <h3><Inbox size={17} /> Memory proposal inbox</h3>
          <p>These seeded examples demonstrate the proposed review flow. Reference IDs and conflict hints are illustrative, not observations from your current chats or native memory.</p>
        </div>
        <span className="memory-proposal-inbox__status"><Info size={13} /> Preview only</span>
      </header>

      <div className="memory-proposal-inbox__metrics" role="status" aria-label="Memory proposal counts">
        <div><strong>{counts.pending}</strong><span> pending</span></div>
        <div><strong>{counts.approved}</strong><span> approved preview</span></div>
        <div><strong>{counts.rejected}</strong><span> rejected preview</span></div>
        <div><strong>{proposals.length}</strong><span> incoming candidates</span></div>
      </div>

      <div className="memory-proposal-inbox__toolbar" role="toolbar" aria-label="Memory proposal filters">
        <label className="memory-proposal-inbox__search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search proposal, scope, source, or revision" aria-label="Search memory proposals" />{query ? <button type="button" aria-label="Clear proposal search" title="Clear the memory proposal search" onClick={() => setQuery("")}><X size={13} /></button> : null}</label>
        <label><span>Decision</span><select value={decisionFilter} onChange={(event) => setDecisionFilter(event.target.value as ProposalFilter)} aria-label="Memory proposal decision filter"><option value="pending">Pending</option><option value="all">All decisions</option><option value="approved">Approved preview</option><option value="rejected">Rejected preview</option></select></label>
        <label><span>Risk</span><select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value as RiskFilter)} aria-label="Memory proposal risk filter"><option value="all">All risk</option><option value="low">Low review risk</option><option value="review">Needs review</option><option value="sensitive">Sensitive</option></select></label>
        <button type="button" className="button button--ghost" onClick={undoDecision} disabled={undoStack.length === 0} aria-label="Undo last proposal decision"><Undo2 size={14} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redoDecision} disabled={redoStack.length === 0} aria-label="Redo last proposal decision"><Redo2 size={14} /> Redo</button>
        <button type="button" className="button button--secondary" onClick={() => updateVisibleDecisions("approved")} disabled={filtered.length === 0} aria-label="Approve visible proposals"><ThumbsUp size={14} /> Approve visible</button>
        <button type="button" className="button button--ghost" onClick={() => updateVisibleDecisions("rejected")} disabled={filtered.length === 0} aria-label="Reject visible proposals"><ThumbsDown size={14} /> Reject visible</button>
        <button type="button" className="button button--ghost" onClick={resetDecisions}><RotateCcw size={14} /> Reset decisions</button>
      </div>

      <div className="memory-proposal-inbox__notice" role="status" aria-live="polite"><ShieldAlert size={14} /><span>{notice}</span></div>

      <div className="memory-proposal-inbox__body">
        <div className="memory-proposal-inbox__list" role="list" aria-label="Memory proposals">
          {filtered.length === 0 ? <div className="memory-proposal-inbox__empty"><Inbox size={22} /><strong>No proposals match</strong><span>Try a different decision, risk, or search filter.</span></div> : null}
          {filtered.map((proposal) => {
            const decision = decisions[proposal.id] ?? "pending";
            const risk = riskFor(proposal);
            const review = reviewStates[proposal.id] ?? reviewStateFor(proposal);
            return (
              <div key={proposal.id} role="listitem" className={`memory-proposal-inbox__row${proposal.id === selected?.id ? " is-selected" : ""}`}>
                <button type="button" className="memory-proposal-inbox__row-button" aria-pressed={proposal.id === selected?.id} onClick={() => setSelectedId(proposal.id)}>
                  <span className={`memory-proposal-inbox__risk memory-proposal-inbox__risk--${risk}`} aria-hidden="true"><FileText size={16} /></span>
                  <span className="memory-proposal-inbox__row-copy"><strong>{proposal.title ?? proposal.content}</strong><small>{proposal.scopeLabel} · {proposal.sourceLabel}</small><span><em className={`memory-proposal-inbox__chip memory-proposal-inbox__chip--${decision}`}>{decisionLabel(decision)}</em><em className={`memory-proposal-inbox__chip memory-proposal-inbox__chip--${risk}`}>{riskLabel(risk)}</em><em className={`memory-proposal-inbox__chip memory-proposal-inbox__chip--${isReviewReady(review) ? "ready" : "open"}`}>{isReviewReady(review) ? "Review ready" : "Review open"}</em><em className="memory-proposal-inbox__chip">{confidenceLabel(proposal.confidence)}</em></span></span>
                  {proposal.contradictionRevisionIds.length > 0 || proposal.duplicateRevisionIds.length > 0 ? <Link2 size={14} aria-label="Has lineage conflicts" /> : <Clock3 size={14} aria-label="Awaiting review" />}
                </button>
              </div>
            );
          })}
        </div>

        <aside className="memory-proposal-inbox__detail" aria-label="Selected memory proposal details">
          {selected ? (
            <>
              <header><div><span className="eyebrow">Selected proposal</span><h4>{selected.title ?? selected.content}</h4></div><span className={`memory-proposal-inbox__chip memory-proposal-inbox__chip--${decisions[selected.id] ?? "pending"}`}>{decisionLabel(decisions[selected.id] ?? "pending")}</span></header>
              <p className="memory-proposal-inbox__content">{selected.content}</p>
              <dl className="memory-proposal-inbox__facts"><div><dt>Scope</dt><dd>{selected.scopeLabel}</dd></div><div><dt>Kind</dt><dd>{selected.kind}</dd></div><div><dt>Confidence</dt><dd>{confidenceLabel(selected.confidence)}</dd></div><div><dt>Sensitivity</dt><dd>{selected.sensitivity.join(", ")}</dd></div><div><dt>Quality score</dt><dd>{Math.round(selected.qualityScore * 100)}%</dd></div><div><dt>Retain until</dt><dd>{selected.retainUntilLabel}</dd></div></dl>

              <section className="memory-proposal-inbox__section memory-proposal-inbox__review" aria-label="Proposal review checklist">
                <div className="memory-proposal-inbox__review-heading"><h5><ListChecks size={14} /> Review checklist</h5><span className={`memory-proposal-inbox__chip memory-proposal-inbox__chip--${isReviewReady(selectedReview) ? "ready" : "open"}`}>{isReviewReady(selectedReview) ? "Ready" : "Open"}</span></div>
                <p>{isReviewReady(selectedReview) ? "All preview review gates are complete; this does not verify native provenance." : "Complete the local gates before treating this candidate as ready for a human decision."}</p>
                <div className="memory-proposal-inbox__review-checks" role="group" aria-label="Memory proposal review checks">
                  {REVIEW_CHECK_IDS.map((checkId) => <label key={checkId} className="memory-proposal-inbox__review-check"><input type="checkbox" checked={selectedReview?.checks[checkId] ?? false} onChange={(event) => toggleReviewCheck(selected, checkId, event.target.checked)} /><span><strong>{REVIEW_CHECK_LABELS[checkId]}</strong><small>{checkId === "evidence" ? "Pointers exist in the seeded preview." : checkId === "conflicts" ? "Acknowledge duplicate or contradiction hints." : checkId === "scope" ? "Confirm the target scope matches your intent." : "Confirm the illustrated retention window."}</small></span></label>)}
                </div>
                <label className="memory-proposal-inbox__review-note"><span>Reviewer note <small>session-only</small></span><textarea value={selectedReview?.note ?? ""} onChange={(event) => updateReviewNote(selected, event.target.value)} placeholder="Capture why this candidate is accepted, rejected, or needs more evidence." rows={3} /></label>
                <div className="memory-proposal-inbox__actions">
                  <button type="button" className="button button--secondary" onClick={() => markReviewReady(selected)} disabled={isReviewReady(selectedReview)}><CheckCircle2 size={14} /> Mark review ready</button>
                  <button type="button" className="button button--ghost" onClick={() => resetReview(selected)}><RotateCcw size={14} /> Reset review</button>
                </div>
              </section>

              <section className="memory-proposal-inbox__section" aria-label="Proposal provenance">
                <h5><MessageSquareText size={14} /> Example evidence & provenance</h5>
                <p>{selected.sourceLabel} · sample age {selected.createdAtLabel}. These IDs cannot open a verified source yet.</p>
                <div className="memory-proposal-inbox__chips">{selected.evidenceMessageIds.map((id) => <code key={id}>{id}</code>)}{selected.sourceRunIds.map((id) => <code key={id}>{id}</code>)}</div>
              </section>

              <section className="memory-proposal-inbox__section" aria-label="Proposal revision lineage">
                <h5><Link2 size={14} /> Revision lineage</h5>
                <p><code>{selected.memoryId}</code> · candidate <code>{selected.revisionId}</code></p>
                {selected.contradictionRevisionIds.length > 0 ? <div className="memory-proposal-inbox__callout memory-proposal-inbox__callout--warning"><ShieldAlert size={14} /><span>Contradicts {selected.contradictionRevisionIds.length} existing revision{selected.contradictionRevisionIds.length === 1 ? "" : "s"}: {selected.contradictionRevisionIds.join(", ")}</span></div> : null}
                {selected.duplicateRevisionIds.length > 0 ? <div className="memory-proposal-inbox__callout"><Link2 size={14} /><span>Looks similar to {selected.duplicateRevisionIds.length} revision{selected.duplicateRevisionIds.length === 1 ? "" : "s"}: {selected.duplicateRevisionIds.join(", ")}</span></div> : null}
                {selected.contradictionRevisionIds.length === 0 && selected.duplicateRevisionIds.length === 0 ? <p className="memory-proposal-inbox__muted">No duplicate or contradiction signal in this preview.</p> : null}
              </section>

              <div className="memory-proposal-inbox__actions">
                <button type="button" className="button button--secondary" onClick={() => updateDecision(selected, "approved")} disabled={decisions[selected.id] === "approved"}><ThumbsUp size={14} /> Approve preview</button>
                <button type="button" className="button button--ghost" onClick={() => updateDecision(selected, "rejected")} disabled={decisions[selected.id] === "rejected"}><ThumbsDown size={14} /> Reject preview</button>
                {(decisions[selected.id] ?? "pending") !== "pending" ? <button type="button" className="button button--ghost" onClick={() => returnToPending(selected)}><RotateCcw size={14} /> Return to pending</button> : null}
              </div>
              <p className="memory-proposal-inbox__boundary"><ShieldAlert size={14} /><span>Review notes and checklist state are renderer-session only. Approve/reject does not promote a revision, mutate durable memory, or inject anything into a provider request.</span></p>
            </>
          ) : <div className="memory-proposal-inbox__empty"><Inbox size={22} /><strong>Select a proposal</strong><span>Its evidence and revision lineage will appear here.</span></div>}
        </aside>
      </div>
    </section>
  );
}

export default MemoryProposalInbox;
