import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  GitBranch,
  History,
  Info,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  TimerReset,
  Undo2,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { MemorySensitivity } from "./types";

/**
 * The lifecycle vocabulary mirrors the intended memory contract while making
 * the renderer boundary explicit. These values are fixture/projection states;
 * they are not native journal events or durable memory status writes.
 */
export type MemoryLifecycleStage =
  | "proposed"
  | "review"
  | "approved"
  | "retrieved"
  | "revised"
  | "superseded"
  | "expired";

export type MemoryLifecycleEventKind =
  | "proposal"
  | "review"
  | "approval"
  | "retrieval"
  | "revision"
  | "supersession"
  | "expiry";

export type MemoryLifecycleRetentionStatus = "healthy" | "attention" | "expired";

export interface MemoryLifecycleEvent {
  readonly id: string;
  readonly kind: MemoryLifecycleEventKind;
  readonly stage: MemoryLifecycleStage;
  readonly title: string;
  readonly summary: string;
  readonly occurredAtLabel: string;
  readonly sourceLabel: string;
  readonly evidenceCount: number;
}

export interface MemoryLifecycleRecord {
  readonly id: string;
  readonly memoryId: string;
  readonly revisionId: string;
  readonly title: string;
  readonly content: string;
  readonly scopeLabel: string;
  readonly stage: MemoryLifecycleStage;
  readonly confidence: number | null;
  readonly sensitivity: readonly MemorySensitivity[];
  readonly retentionLabel: string;
  readonly retentionStatus: MemoryLifecycleRetentionStatus;
  readonly conflictCount: number;
  readonly duplicateRevisionId?: string | null;
  readonly supersededByRevisionId?: string | null;
  readonly events: readonly MemoryLifecycleEvent[];
}

export interface MemoryLifecycleProjection {
  readonly records: readonly MemoryLifecycleRecord[];
  readonly metrics: {
    readonly total: number;
    readonly active: number;
    readonly attention: number;
    readonly terminal: number;
    readonly evidenceCount: number;
    readonly supersessionCount: number;
    readonly consolidationCandidates: number;
  };
}

export const MEMORY_LIFECYCLE_STAGE_ORDER: readonly MemoryLifecycleStage[] = [
  "proposed",
  "review",
  "approved",
  "retrieved",
  "revised",
  "superseded",
  "expired",
];

export const MEMORY_LIFECYCLE_STAGE_LABELS: Record<MemoryLifecycleStage, string> = {
  proposed: "Proposed",
  review: "Review",
  approved: "Approved",
  retrieved: "Retrieved",
  revised: "Revised",
  superseded: "Superseded",
  expired: "Expired",
};

const lifecycleStageDescriptions: Record<MemoryLifecycleStage, string> = {
  proposed: "Candidate extracted and waiting for an explicit review decision.",
  review: "Evidence, scope, sensitivity, conflicts, and retention are being checked.",
  approved: "A review preview says the candidate could be admitted to its scope.",
  retrieved: "The revision appears in a retrieval rehearsal; no run receipt is attached.",
  revised: "A later revision changed the candidate while preserving its lineage.",
  superseded: "A newer revision takes precedence over this historical snapshot.",
  expired: "The retention window ended in the fixture; no deletion was performed.",
};

const stageTone: Record<MemoryLifecycleStage, "complete" | "review" | "blocked" | "planned"> = {
  proposed: "planned",
  review: "review",
  approved: "complete",
  retrieved: "complete",
  revised: "complete",
  superseded: "review",
  expired: "blocked",
};

const eventIcon = (kind: MemoryLifecycleEventKind) => {
  if (kind === "proposal") return <Sparkles size={14} />;
  if (kind === "review") return <ShieldAlert size={14} />;
  if (kind === "approval") return <CheckCircle2 size={14} />;
  if (kind === "retrieval") return <ArrowRight size={14} />;
  if (kind === "revision") return <RefreshCw size={14} />;
  if (kind === "supersession") return <GitBranch size={14} />;
  return <TimerReset size={14} />;
};

const confidenceLabel = (value: number | null): string => (
  value === null ? "Explicit" : `${Math.round(value * 100)}%`
);

const event = (
  id: string,
  kind: MemoryLifecycleEventKind,
  stage: MemoryLifecycleStage,
  title: string,
  summary: string,
  occurredAtLabel: string,
  sourceLabel: string,
  evidenceCount: number,
): MemoryLifecycleEvent => ({ id, kind, stage, title, summary, occurredAtLabel, sourceLabel, evidenceCount });

export const DEFAULT_MEMORY_LIFECYCLE_RECORDS: readonly MemoryLifecycleRecord[] = [
  {
    id: "lifecycle-reporting-style-r3",
    memoryId: "memory-report-style",
    revisionId: "memory-report-style-r3",
    title: "Reporting style",
    content: "Prefer compact implementation reports with exact paths and focused evidence.",
    scopeLabel: "Global",
    stage: "retrieved",
    confidence: 0.94,
    sensitivity: ["normal"],
    retentionLabel: "30 days remaining",
    retentionStatus: "healthy",
    conflictCount: 0,
    events: [
      event("reporting-proposed", "proposal", "proposed", "Candidate proposed", "A completed handoff produced a concise reporting-style candidate.", "2 minutes ago", "Chat extraction · handoff", 2),
      event("reporting-review", "review", "review", "Review checks passed", "Scope and retention were visible; no conflict or sensitive category was detected.", "2 minutes ago", "Memory review preview", 1),
      event("reporting-approved", "approval", "approved", "Approval preview staged", "The reviewer marked the candidate ready for a future native approval receipt.", "1 minute ago", "Renderer review preview", 0),
      event("reporting-retrieved", "retrieval", "retrieved", "Retrieval rehearsal", "The revision is eligible in the current policy preview; no run-level usage receipt exists.", "Now", "Context rehearsal", 0),
    ],
  },
  {
    id: "lifecycle-renderer-boundary-r2",
    memoryId: "memory-renderer-boundary",
    revisionId: "memory-renderer-boundary-r2",
    title: "Preview truthfulness",
    content: "Keep renderer preview claims distinct from native persistence and runtime receipts.",
    scopeLabel: "Project · Omnia",
    stage: "revised",
    confidence: 0.89,
    sensitivity: ["normal"],
    retentionLabel: "Project lifetime",
    retentionStatus: "attention",
    conflictCount: 1,
    duplicateRevisionId: "memory-preview-boundary-r1",
    supersededByRevisionId: null,
    events: [
      event("boundary-proposed", "proposal", "proposed", "Candidate proposed", "A project review extracted a boundary reminder from an implementation audit.", "18 minutes ago", "Chat extraction · project review", 1),
      event("boundary-review", "review", "review", "Conflict review required", "One earlier revision makes a contradictory claim and one similar revision is referenced.", "17 minutes ago", "Provenance preview", 1),
      event("boundary-approved", "approval", "approved", "Approval preview staged", "The current revision was retained as the candidate to review, not as durable memory.", "16 minutes ago", "Renderer review preview", 0),
      event("boundary-retrieved", "retrieval", "retrieved", "Retrieval rehearsal", "The candidate was visible to the simulated project route for inspection.", "12 minutes ago", "Context rehearsal", 0),
      event("boundary-revised", "revision", "revised", "Revision recorded", "The wording was tightened to preserve the renderer/native boundary.", "8 minutes ago", "Memory draft preview", 1),
    ],
  },
  {
    id: "lifecycle-study-routine-r1",
    memoryId: "memory-study-routine",
    revisionId: "memory-study-routine-r1",
    title: "Algorithm study routine",
    content: "When working on algorithm exercises, show a proof sketch before optimization ideas.",
    scopeLabel: "Assistant · CSE tutor",
    stage: "review",
    confidence: 0.67,
    sensitivity: ["personal"],
    retentionLabel: "90 days · review hold",
    retentionStatus: "attention",
    conflictCount: 0,
    duplicateRevisionId: "memory-study-routine-r0",
    events: [
      event("study-proposed", "proposal", "proposed", "Candidate proposed", "A tutoring conversation suggested a repeatable explanation preference.", "Yesterday", "Chat extraction · Algorithm Lab", 2),
      event("study-review", "review", "review", "Sensitivity and duplicate review", "Personal context and a similar older revision keep this candidate in a human-review state.", "Yesterday", "Memory review preview", 1),
    ],
  },
  {
    id: "lifecycle-study-routine-r0",
    memoryId: "memory-study-routine",
    revisionId: "memory-study-routine-r0",
    title: "Algorithm study routine · legacy",
    content: "Show optimization ideas before proof details when solving algorithm exercises.",
    scopeLabel: "Assistant · CSE tutor",
    stage: "superseded",
    confidence: 0.58,
    sensitivity: ["personal"],
    retentionLabel: "Retained as lineage · no retrieval",
    retentionStatus: "expired",
    conflictCount: 1,
    supersededByRevisionId: "memory-study-routine-r1",
    events: [
      event("legacy-proposed", "proposal", "proposed", "Candidate proposed", "An earlier tutoring turn produced the first routine revision.", "3 days ago", "Chat extraction · Algorithm Lab", 1),
      event("legacy-approved", "approval", "approved", "Approval preview staged", "The old revision was marked ready in the fixture history.", "3 days ago", "Renderer review preview", 0),
      event("legacy-retrieved", "retrieval", "retrieved", "Retrieval rehearsal", "The old wording appeared in a previous context rehearsal.", "2 days ago", "Context rehearsal", 0),
      event("legacy-superseded", "supersession", "superseded", "Superseded by newer revision", "Revision r1 now takes precedence; this record remains only as lineage evidence.", "Yesterday", "Revision lineage preview", 1),
      event("legacy-expired", "expiry", "expired", "Retention window elapsed", "The fixture retention window is closed; no native purge or source deletion was attempted.", "Yesterday", "Retention preview", 0),
    ],
  },
];

export function buildMemoryLifecycleProjection(
  records: readonly MemoryLifecycleRecord[] = DEFAULT_MEMORY_LIFECYCLE_RECORDS,
): MemoryLifecycleProjection {
  return {
    records,
    metrics: {
      total: records.length,
      active: records.filter((record) => record.stage !== "superseded" && record.stage !== "expired").length,
      attention: records.filter((record) => record.retentionStatus !== "healthy" || record.conflictCount > 0).length,
      terminal: records.filter((record) => record.stage === "superseded" || record.stage === "expired").length,
      evidenceCount: records.reduce((sum, record) => sum + record.events.reduce((eventSum, item) => eventSum + item.evidenceCount, 0), 0),
      supersessionCount: records.filter((record) => Boolean(record.supersededByRevisionId) || record.stage === "superseded").length,
      consolidationCandidates: records.filter((record) => record.conflictCount > 0 || Boolean(record.duplicateRevisionId)).length,
    },
  };
}

export interface MemoryLifecycleStudioProps {
  readonly records?: readonly MemoryLifecycleRecord[];
}

type StageFilter = "all" | MemoryLifecycleStage;

function LifecycleBoundary() {
  return (
    <p className="memory-lifecycle-studio__boundary" role="note">
      <ShieldAlert size={14} aria-hidden="true" />
      <span>Preview only · Renderer-local · No durable write. Events, stage changes, retention labels, and lineage IDs are illustrative; the native memory journal and approval bridge are not queried here.</span>
    </p>
  );
}

export function MemoryLifecycleStudio({ records = DEFAULT_MEMORY_LIFECYCLE_RECORDS }: MemoryLifecycleStudioProps) {
  const projection = useMemo(() => buildMemoryLifecycleProjection(records), [records]);
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(records[0]?.id ?? null);
  const [stageOverrides, setStageOverrides] = useState<Record<string, MemoryLifecycleStage>>({});
  const [notice, setNotice] = useState("Lifecycle evidence is a renderer fixture; no native journal is queried.");

  const scopes = useMemo(() => Array.from(new Set(records.map((record) => record.scopeLabel))).sort(), [records]);
  const normalizedQuery = query.trim().toLowerCase();
  const effectiveStage = (record: MemoryLifecycleRecord): MemoryLifecycleStage => stageOverrides[record.id] ?? record.stage;
  const filtered = useMemo(() => records.filter((record) => {
    const stage = stageOverrides[record.id] ?? record.stage;
    const matchesQuery = !normalizedQuery || [record.title, record.content, record.scopeLabel, record.memoryId, record.revisionId].join(" ").toLowerCase().includes(normalizedQuery);
    return matchesQuery && (stageFilter === "all" || stage === stageFilter) && (scopeFilter === "all" || record.scopeLabel === scopeFilter);
  }), [normalizedQuery, records, scopeFilter, stageFilter, stageOverrides]);
  const selected = filtered.find((record) => record.id === selectedId) ?? filtered[0] ?? null;
  const selectedStage = selected ? effectiveStage(selected) : null;
  const selectedStageIndex = selectedStage ? MEMORY_LIFECYCLE_STAGE_ORDER.indexOf(selectedStage) : -1;
  const canAdvance = selectedStageIndex >= 0 && selectedStageIndex < MEMORY_LIFECYCLE_STAGE_ORDER.length - 1;
  const hasOverride = Boolean(selected && stageOverrides[selected.id]);

  const resetFilters = () => {
    setQuery("");
    setStageFilter("all");
    setScopeFilter("all");
    setNotice("Lifecycle filters reset; fixture records are unchanged.");
  };

  const advanceSelected = () => {
    if (!selected || !canAdvance) return;
    const nextStage = MEMORY_LIFECYCLE_STAGE_ORDER[selectedStageIndex + 1]!;
    setStageOverrides((current) => ({ ...current, [selected.id]: nextStage }));
    setNotice(`${selected.title} advanced to ${MEMORY_LIFECYCLE_STAGE_LABELS[nextStage]} in this renderer preview only.`);
  };

  const resetSelected = () => {
    if (!selected) return;
    setStageOverrides((current) => {
      const next = { ...current };
      delete next[selected.id];
      return next;
    });
    setNotice(`${selected.title} returned to its fixture stage; no durable lifecycle state changed.`);
  };

  return (
    <section className="memory-lifecycle-studio" aria-label="Memory lifecycle studio">
      <header className="memory-lifecycle-studio__header">
        <div>
          <span className="eyebrow">Ordered lifecycle workbench</span>
          <h3><History size={17} /> Memory lifecycle studio</h3>
          <p>Trace proposal, review, retrieval, revision, supersession, and retention without presenting fixture events as native authority.</p>
        </div>
        <span className="memory-studio__chip memory-studio__chip--amber"><Clock3 size={13} /> Preview only</span>
      </header>

      <div className="memory-lifecycle-studio__notice" role="status" aria-live="polite" aria-label="Memory lifecycle preview state">
        <Info size={13} /> {notice}
      </div>

      <div className="memory-lifecycle-studio__metrics" role="status" aria-label="Memory lifecycle summary">
        <div><strong>{projection.metrics.total}</strong><span>revisions</span></div>
        <div><strong>{projection.metrics.active}</strong><span>active path</span></div>
        <div><strong>{projection.metrics.attention}</strong><span>needs attention</span></div>
        <div><strong>{projection.metrics.terminal}</strong><span>terminal history</span></div>
        <div><strong>{projection.metrics.evidenceCount}</strong><span>evidence pointers</span></div>
      </div>

      <div className="memory-lifecycle-studio__toolbar" role="toolbar" aria-label="Memory lifecycle controls">
        <label className="memory-lifecycle-studio__search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memory, scope, or revision" aria-label="Search memory lifecycle records" /></label>
        <label><span>Stage</span><select aria-label="Memory lifecycle stage filter" value={stageFilter} onChange={(event) => setStageFilter(event.target.value as StageFilter)}><option value="all">All stages</option>{MEMORY_LIFECYCLE_STAGE_ORDER.map((stage) => <option key={stage} value={stage}>{MEMORY_LIFECYCLE_STAGE_LABELS[stage]}</option>)}</select></label>
        <label><span>Scope</span><select aria-label="Memory lifecycle scope filter" value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value)}><option value="all">All scopes</option>{scopes.map((scope) => <option key={scope} value={scope}>{scope}</option>)}</select></label>
        <span className="memory-lifecycle-studio__count" role="status" aria-label="Visible lifecycle records">{filtered.length} visible</span>
        <button type="button" className="button button--ghost" onClick={resetFilters}><Undo2 size={13} /> Reset filters</button>
      </div>

      <div className="memory-lifecycle-studio__body">
        <div className="memory-lifecycle-studio__list" role="list" aria-label="Memory lifecycle records">
          {filtered.length === 0 ? <div className="memory-lifecycle-studio__empty"><Search size={20} /><strong>No lifecycle records match</strong><span>Adjust the search or filters; no fixture data was changed.</span></div> : null}
          {filtered.map((record) => {
            const stage = effectiveStage(record);
            return (
              <div key={record.id} role="listitem">
                <button type="button" className={`memory-lifecycle-studio__row${record.id === selected?.id ? " is-selected" : ""}`} aria-pressed={record.id === selected?.id} onClick={() => setSelectedId(record.id)}>
                  <span className={`memory-lifecycle-studio__row-icon memory-lifecycle-studio__row-icon--${stageTone[stage]}`}>{eventIcon(record.events.at(-1)?.kind ?? "proposal")}</span>
                  <span className="memory-lifecycle-studio__row-copy"><strong>{record.title}</strong><small>{record.scopeLabel} · {record.revisionId}</small><em><span className={`memory-lifecycle-studio__stage memory-lifecycle-studio__stage--${stageTone[stage]}`}>{MEMORY_LIFECYCLE_STAGE_LABELS[stage]}</span>{record.conflictCount > 0 ? ` · ${record.conflictCount} conflict` : ""}{record.duplicateRevisionId ? " · duplicate signal" : ""}</em></span>
                  <ArrowRight size={14} />
                </button>
              </div>
            );
          })}
        </div>

        <aside className="memory-lifecycle-studio__detail" aria-label="Selected memory lifecycle details">
          {selected && selectedStage ? <>
            <header><div><span className="eyebrow">Selected revision</span><h4>{selected.title}</h4></div><span className={`memory-lifecycle-studio__stage memory-lifecycle-studio__stage--${stageTone[selectedStage]}`}>{MEMORY_LIFECYCLE_STAGE_LABELS[selectedStage]}</span></header>
            <p className="memory-lifecycle-studio__content">{selected.content}</p>
            <dl className="memory-lifecycle-studio__facts">
              <div><dt>Memory key</dt><dd><code>{selected.memoryId}</code></dd></div>
              <div><dt>Revision</dt><dd><code>{selected.revisionId}</code></dd></div>
              <div><dt>Scope</dt><dd>{selected.scopeLabel}</dd></div>
              <div><dt>Confidence</dt><dd>{confidenceLabel(selected.confidence)}</dd></div>
              <div><dt>Sensitivity</dt><dd>{selected.sensitivity.join(", ")}</dd></div>
              <div><dt>Retention</dt><dd>{selected.retentionLabel}</dd></div>
              {selected.supersededByRevisionId ? <div><dt>Superseded by</dt><dd><code>{selected.supersededByRevisionId}</code></dd></div> : null}
            </dl>

            <section className="memory-lifecycle-studio__summary" aria-label="Retention and consolidation summary">
              <div><TimerReset size={15} /><span><strong>Retention posture</strong><small>{selected.retentionStatus === "healthy" ? "Window is represented as active in this fixture." : selected.retentionStatus === "attention" ? "Review the window before a future native decision." : "Window is closed in this fixture; no purge occurred."}</small></span><em className={`memory-lifecycle-studio__stage memory-lifecycle-studio__stage--${selected.retentionStatus === "healthy" ? "complete" : selected.retentionStatus === "expired" ? "blocked" : "review"}`}>{selected.retentionStatus}</em></div>
              <div><GitBranch size={15} /><span><strong>Consolidation signals</strong><small>{selected.conflictCount} conflict · {selected.duplicateRevisionId ? "1 duplicate" : "0 duplicates"} · {selected.supersededByRevisionId ? "superseded lineage" : "no supersession target"}</small></span><em>{selected.conflictCount > 0 || selected.duplicateRevisionId ? "Review" : "Clear"}</em></div>
            </section>

            <section className="memory-lifecycle-studio__timeline" aria-label="Memory lifecycle timeline">
              <header><span><History size={14} /> Lifecycle timeline</span><small>{selected.events.length} fixture events</small></header>
              <ol>
                {selected.events.map((item) => <li key={item.id} className={`memory-lifecycle-studio__event memory-lifecycle-studio__event--${stageTone[item.stage]}`}><span>{eventIcon(item.kind)}</span><div><strong>{item.title}</strong><small>{item.occurredAtLabel} · {item.sourceLabel}</small><p>{item.summary}</p><em>{item.evidenceCount} evidence pointer{item.evidenceCount === 1 ? "" : "s"}</em></div></li>)}
              </ol>
            </section>

            <div className="memory-lifecycle-studio__actions">
              <button type="button" className="button button--secondary" onClick={advanceSelected} disabled={!canAdvance}><ArrowRight size={14} /> Advance stage preview</button>
              <button type="button" className="button button--ghost" onClick={resetSelected} disabled={!hasOverride}><RefreshCw size={14} /> Restore fixture stage</button>
            </div>
            <p className="memory-lifecycle-studio__stage-note"><Info size={13} /> {lifecycleStageDescriptions[selectedStage]} {hasOverride ? "This stage is locally overridden for rehearsal." : ""}</p>
          </> : <div className="memory-lifecycle-studio__empty"><History size={22} /><strong>Select a lifecycle record</strong><span>Its stage history, retention, and lineage signals will appear here.</span></div>}
        </aside>
      </div>

      <LifecycleBoundary />
    </section>
  );
}

export default MemoryLifecycleStudio;
