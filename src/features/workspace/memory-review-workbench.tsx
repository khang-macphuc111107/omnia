import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  Filter,
  LockKeyhole,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  TimerReset,
  Undo2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

type MemoryReviewLane = "all" | "blocked" | "ready" | "in-review" | "snoozed";
type MemoryReviewStage = "queued" | "in-review" | "snoozed" | "ready";
type MemoryReviewFocus = "blockers" | "quality" | "freshness";
type MemoryReviewCheckId = "evidence" | "lineage" | "scope" | "retention";

type MemoryReviewChecks = Record<MemoryReviewCheckId, boolean>;

export interface MemoryReviewWorkbenchItem {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly scopeLabel: string;
  readonly sourceLabel: string;
  readonly confidence: number;
  readonly qualityScore: number;
  readonly ageLabel: string;
  readonly blockers: readonly string[];
  readonly checks: MemoryReviewChecks;
}

export const DEFAULT_MEMORY_REVIEW_ITEMS: readonly MemoryReviewWorkbenchItem[] = [
  {
    id: "review-preview-boundary",
    title: "Preview truthfulness",
    summary: "Keep renderer preview claims distinct from native persistence and runtime receipts.",
    scopeLabel: "Project · Omnia",
    sourceLabel: "Project Control Deck review",
    confidence: 0.89,
    qualityScore: 0.82,
    ageLabel: "18 min ago",
    blockers: ["Contradiction signal needs acknowledgement"],
    checks: { evidence: true, lineage: false, scope: true, retention: false },
  },
  {
    id: "review-reporting-style",
    title: "Reporting style",
    summary: "Prefer compact implementation reports with exact paths and focused evidence.",
    scopeLabel: "Global",
    sourceLabel: "Omnia build handoff",
    confidence: 0.94,
    qualityScore: 0.96,
    ageLabel: "2 min ago",
    blockers: [],
    checks: { evidence: true, lineage: true, scope: true, retention: true },
  },
  {
    id: "review-study-routine",
    title: "Algorithm study routine",
    summary: "Show a proof sketch before optimization ideas when working on algorithm exercises.",
    scopeLabel: "Assistant · CSE tutor",
    sourceLabel: "Algorithm Lab",
    confidence: 0.67,
    qualityScore: 0.64,
    ageLabel: "Yesterday",
    blockers: ["Confidence below the review floor", "Duplicate candidate detected"],
    checks: { evidence: true, lineage: true, scope: false, retention: true },
  },
  {
    id: "review-route-preference",
    title: "Cloud route preference",
    summary: "Use the cloud route by default while retaining a local fallback for diagnostics.",
    scopeLabel: "Project · Omnia",
    sourceLabel: "Provider route rehearsal",
    confidence: 0.78,
    qualityScore: 0.74,
    ageLabel: "3 hours ago",
    blockers: ["Retention window is illustrative only"],
    checks: { evidence: true, lineage: true, scope: true, retention: false },
  },
];

const REVIEW_CHECK_IDS: readonly MemoryReviewCheckId[] = ["evidence", "lineage", "scope", "retention"];

const REVIEW_CHECK_LABELS: Record<MemoryReviewCheckId, string> = {
  evidence: "Source evidence inspected",
  lineage: "Revision lineage reconciled",
  scope: "Scope matches the intent",
  retention: "Retention window acknowledged",
};

const REVIEW_CHECK_HINTS: Record<MemoryReviewCheckId, string> = {
  evidence: "Message/run pointers are present in this seeded preview.",
  lineage: "Acknowledge duplicate, contradiction, or supersession hints.",
  scope: "Confirm global, project, assistant, or conversation placement.",
  retention: "Confirm the illustrated expiry or project-lifetime window.",
};

const LANE_LABELS: Record<MemoryReviewLane, string> = {
  all: "All candidates",
  blocked: "Blocked / needs evidence",
  ready: "Ready preview",
  "in-review": "In review",
  snoozed: "Snoozed",
};

const STAGE_LABELS: Record<MemoryReviewStage, string> = {
  queued: "Queued",
  "in-review": "In review",
  snoozed: "Snoozed",
  ready: "Ready preview",
};

const FOCUS_LABELS: Record<MemoryReviewFocus, string> = {
  blockers: "Blockers first",
  quality: "Lowest quality first",
  freshness: "Newest first",
};

function cloneChecks(checks: MemoryReviewChecks): MemoryReviewChecks {
  return { ...checks };
}

function cloneCheckMap(items: readonly MemoryReviewWorkbenchItem[]): Record<string, MemoryReviewChecks> {
  return Object.fromEntries(items.map((item) => [item.id, cloneChecks(item.checks)]));
}

function isReady(item: MemoryReviewWorkbenchItem, checks: MemoryReviewChecks | undefined): boolean {
  return REVIEW_CHECK_IDS.every((checkId) => checks?.[checkId] ?? item.checks[checkId]);
}

function scoreLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function stageTone(stage: MemoryReviewStage): string {
  return stage === "ready" ? "ready" : stage === "in-review" ? "review" : stage === "snoozed" ? "snoozed" : "queued";
}

function Boundary({ children }: { readonly children: string }) {
  return <p className="memory-review-workbench__boundary"><LockKeyhole size={14} /><span>{children}</span></p>;
}

export default function MemoryReviewWorkbench({
  items = DEFAULT_MEMORY_REVIEW_ITEMS,
}: {
  readonly items?: readonly MemoryReviewWorkbenchItem[];
}) {
  const [query, setQuery] = useState("");
  const [lane, setLane] = useState<MemoryReviewLane>("all");
  const [focus, setFocus] = useState<MemoryReviewFocus>("blockers");
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id ?? null);
  const [checks, setChecks] = useState<Record<string, MemoryReviewChecks>>(() => cloneCheckMap(items));
  const [stages, setStages] = useState<Record<string, MemoryReviewStage>>(() => Object.fromEntries(items.map((item) => [item.id, "queued"])));
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("Review state is renderer-local until the native memory bridge is connected.");

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const visible = items.filter((item) => {
      const itemChecks = checks[item.id] ?? item.checks;
      const ready = isReady(item, itemChecks);
      const stage = stages[item.id] ?? "queued";
      const matchesQuery = !normalized || [item.title, item.summary, item.scopeLabel, item.sourceLabel, item.id]
        .join(" ")
        .toLowerCase()
        .includes(normalized);
      const matchesLane = lane === "all"
        || (lane === "blocked" && !ready)
        || (lane === "ready" && ready)
        || (lane === "in-review" && stage === "in-review")
        || (lane === "snoozed" && stage === "snoozed");
      return matchesQuery && matchesLane;
    });

    return [...visible].sort((left, right) => {
      if (focus === "quality") return left.qualityScore - right.qualityScore;
      if (focus === "freshness") return items.indexOf(left) - items.indexOf(right);
      const leftChecks = checks[left.id] ?? left.checks;
      const rightChecks = checks[right.id] ?? right.checks;
      const blockerDelta = (right.blockers.length + REVIEW_CHECK_IDS.filter((id) => !leftChecks[id]).length)
        - (left.blockers.length + REVIEW_CHECK_IDS.filter((id) => !rightChecks[id]).length);
      return blockerDelta || left.qualityScore - right.qualityScore;
    });
  }, [checks, focus, items, lane, query, stages]);

  const selected = filtered.find((item) => item.id === selectedId)
    ?? items.find((item) => item.id === selectedId)
    ?? filtered[0]
    ?? null;
  const selectedChecks = selected ? checks[selected.id] ?? selected.checks : undefined;
  const selectedStage = selected ? stages[selected.id] ?? "queued" : "queued";
  const selectedReady = selected ? isReady(selected, selectedChecks) : false;

  const counts = useMemo(() => {
    let ready = 0;
    let blocked = 0;
    let inReview = 0;
    let snoozed = 0;
    items.forEach((item) => {
      const itemChecks = checks[item.id] ?? item.checks;
      if (isReady(item, itemChecks)) ready += 1;
      else blocked += 1;
      const stage = stages[item.id] ?? "queued";
      if (stage === "in-review") inReview += 1;
      if (stage === "snoozed") snoozed += 1;
    });
    return { ready, blocked, inReview, snoozed };
  }, [checks, items, stages]);

  const updateCheck = (item: MemoryReviewWorkbenchItem, checkId: MemoryReviewCheckId, value: boolean) => {
    setChecks((current) => ({
      ...current,
      [item.id]: { ...(current[item.id] ?? item.checks), [checkId]: value },
    }));
    setNotice(`${REVIEW_CHECK_LABELS[checkId]} ${value ? "marked complete" : "reopened"} for this renderer preview.`);
  };

  const setStage = (item: MemoryReviewWorkbenchItem, next: MemoryReviewStage) => {
    setStages((current) => ({ ...current, [item.id]: next }));
    setNotice(`${STAGE_LABELS[next]} applied to “${item.title}” in this renderer preview only.`);
  };

  const startNext = () => {
    const candidate = filtered.find((item) => (stages[item.id] ?? "queued") !== "snoozed") ?? filtered[0];
    if (!candidate) {
      setNotice("No review candidate matches the current lane or search filter.");
      return;
    }
    setSelectedId(candidate.id);
    setStages((current) => ({ ...current, [candidate.id]: "in-review" }));
    setNotice(`Opened “${candidate.title}” as the next review candidate in this renderer preview.`);
  };

  const reset = () => {
    setChecks(cloneCheckMap(items));
    setStages(Object.fromEntries(items.map((item) => [item.id, "queued"])));
    setNotes({});
    setNotice("Review lanes and checklist state reset to the incoming preview seed.");
  };

  return (
    <section className="memory-review-workbench" aria-label="Memory review cockpit">
      <header className="memory-review-workbench__header">
        <div>
          <span className="eyebrow">Triage and evidence cockpit</span>
          <h3><Target size={17} /> Memory review cockpit</h3>
          <p>Prioritize candidate memories by blockers, evidence quality, and freshness before opening the detailed proposal inspector.</p>
        </div>
        <span className="memory-review-workbench__status"><Sparkles size={13} /> Preview only</span>
      </header>

      <div className="memory-review-workbench__metrics" role="status" aria-label="Memory review queue counts">
        <div><strong>{counts.blocked}</strong><span>blocked</span></div>
        <div><strong>{counts.ready}</strong><span>ready preview</span></div>
        <div><strong>{counts.inReview}</strong><span>in review</span></div>
        <div><strong>{counts.snoozed}</strong><span>snoozed</span></div>
      </div>

      <div className="memory-review-workbench__toolbar" role="toolbar" aria-label="Memory review cockpit controls">
        <label className="memory-review-workbench__search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search candidate, scope, or source" aria-label="Search review candidates" />{query ? <button type="button" aria-label="Clear review candidate search" title="Clear the memory review candidate search" onClick={() => setQuery("")}><X size={13} /></button> : null}</label>
        <label><span>Lane</span><select aria-label="Memory review lane" value={lane} onChange={(event) => setLane(event.target.value as MemoryReviewLane)}>{Object.entries(LANE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Focus</span><select aria-label="Memory review focus" value={focus} onChange={(event) => setFocus(event.target.value as MemoryReviewFocus)}>{Object.entries(FOCUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button type="button" className="button button--secondary" onClick={startNext} disabled={filtered.length === 0}><ArrowRight size={14} /> Start next</button>
        <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={14} /> Reset queue</button>
      </div>

      <div className="memory-review-workbench__notice" role="status" aria-live="polite"><ShieldCheck size={14} /><span>{notice}</span></div>

      <div className="memory-review-workbench__body">
        <div className="memory-review-workbench__list" role="list" aria-label="Memory review candidates">
          {filtered.length === 0 ? <div className="memory-review-workbench__empty"><Filter size={21} /><strong>No candidates match</strong><span>Try another lane, focus, or search filter.</span></div> : null}
          {filtered.map((item) => {
            const itemChecks = checks[item.id] ?? item.checks;
            const ready = isReady(item, itemChecks);
            const stage = stages[item.id] ?? "queued";
            return (
              <div key={item.id} role="listitem" className={`memory-review-workbench__row${item.id === selected?.id ? " is-selected" : ""}`}>
                <button type="button" className="memory-review-workbench__row-button" aria-pressed={item.id === selected?.id} onClick={() => setSelectedId(item.id)}>
                  <span className={`memory-review-workbench__marker memory-review-workbench__marker--${ready ? "ready" : item.blockers.length > 0 ? "blocked" : "open"}`} aria-hidden="true">{ready ? <CheckCircle2 size={16} /> : item.blockers.length > 0 ? <AlertTriangle size={16} /> : <Clock3 size={16} />}</span>
                  <span className="memory-review-workbench__row-copy"><strong>{item.title}</strong><small>{item.scopeLabel} · {item.sourceLabel}</small><span><em className={`memory-review-workbench__chip memory-review-workbench__chip--${stageTone(stage)}`}>{STAGE_LABELS[stage]}</em><em className="memory-review-workbench__chip">Quality {scoreLabel(item.qualityScore)}</em><em className="memory-review-workbench__chip">{item.ageLabel}</em></span></span>
                  <span className="memory-review-workbench__row-score" aria-label={`Confidence ${scoreLabel(item.confidence)}`}>{scoreLabel(item.confidence)}</span>
                </button>
              </div>
            );
          })}
        </div>

        <aside className="memory-review-workbench__detail" aria-label="Selected memory review candidate">
          {selected ? (
            <>
              <header><div><span className="eyebrow">Selected candidate</span><h4>{selected.title}</h4></div><span className={`memory-review-workbench__chip memory-review-workbench__chip--${stageTone(selectedStage)}`}>{STAGE_LABELS[selectedStage]}</span></header>
              <p className="memory-review-workbench__summary">{selected.summary}</p>
              <div className="memory-review-workbench__facts"><span><small>Scope</small><strong>{selected.scopeLabel}</strong></span><span><small>Confidence</small><strong>{scoreLabel(selected.confidence)}</strong></span><span><small>Quality</small><strong>{scoreLabel(selected.qualityScore)}</strong></span><span><small>Age</small><strong>{selected.ageLabel}</strong></span></div>

              <section className="memory-review-workbench__section" aria-label="Review gates">
                <div className="memory-review-workbench__section-heading"><h5><SlidersHorizontal size={14} /> Review gates</h5><span className={`memory-review-workbench__chip memory-review-workbench__chip--${selectedReady ? "ready" : "blocked"}`}>{selectedReady ? "Ready" : `${REVIEW_CHECK_IDS.filter((id) => selectedChecks?.[id]).length}/${REVIEW_CHECK_IDS.length} complete`}</span></div>
                <div className="memory-review-workbench__checks" role="group" aria-label="Memory review gates">
                  {REVIEW_CHECK_IDS.map((checkId) => <label key={checkId} className="memory-review-workbench__check"><input type="checkbox" checked={selectedChecks?.[checkId] ?? false} onChange={(event) => updateCheck(selected, checkId, event.target.checked)} /><span><strong>{REVIEW_CHECK_LABELS[checkId]}</strong><small>{REVIEW_CHECK_HINTS[checkId]}</small></span></label>)}
                </div>
              </section>

              {selected.blockers.length > 0 ? <div className="memory-review-workbench__callout memory-review-workbench__callout--warning"><AlertTriangle size={14} /><span><strong>Signals to resolve</strong>{selected.blockers.map((blocker) => <small key={blocker}>{blocker}</small>)}</span></div> : <div className="memory-review-workbench__callout"><Check size={14} /><span><strong>No seeded blocker</strong><small>Continue to the detailed proposal and provenance surfaces.</small></span></div>}

              <label className="memory-review-workbench__note"><span>Reviewer note <small>session-only</small></span><textarea value={notes[selected.id] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [selected.id]: event.target.value }))} placeholder="Capture why this candidate is ready, blocked, or snoozed." rows={2} /></label>

              <div className="memory-review-workbench__actions">
                <button type="button" className="button button--secondary" onClick={() => setStage(selected, "ready")} disabled={!selectedReady}><CheckCircle2 size={14} /> Mark ready preview</button>
                <button type="button" className="button button--ghost" onClick={() => setStage(selected, "in-review")}><Target size={14} /> Keep in review</button>
                <button type="button" className="button button--ghost" onClick={() => setStage(selected, "snoozed")}><TimerReset size={14} /> Snooze</button>
                {selectedStage !== "queued" ? <button type="button" className="button button--ghost" onClick={() => setStage(selected, "queued")}><Undo2 size={14} /> Return to queue</button> : null}
              </div>
            </>
          ) : <div className="memory-review-workbench__empty"><Target size={21} /><strong>Select a candidate</strong><span>Its gates and review signals will appear here.</span></div>}
        </aside>
      </div>

      <Boundary>Queue state, checklist changes, notes, and stage labels are renderer-session only. This cockpit does not approve a revision, mutate durable memory, or inject anything into a provider request.</Boundary>
    </section>
  );
}
