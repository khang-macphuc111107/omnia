import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileJson2,
  History,
  Info,
  Link2,
  MessageSquareText,
  Search,
  ShieldAlert,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  DEFAULT_MEMORY_PROPOSALS,
  type MemoryProposalInboxItem,
} from "./memory-proposal-inbox";
import type { MemorySensitivity } from "./types";

export { DEFAULT_MEMORY_PROPOSALS } from "./memory-proposal-inbox";

export type MemoryLineageRelation = "candidate" | "contradicts" | "duplicate";

export interface MemoryLineageNode {
  readonly revisionId: string;
  readonly relation: MemoryLineageRelation;
  readonly label: string;
  readonly existsInSnapshot: boolean;
}

export interface MemoryProvenanceRevisionRecord {
  readonly proposalId: string;
  readonly memoryId: string;
  readonly revisionId: string;
  readonly title: string;
  readonly content: string;
  readonly scopeLabel: string;
  readonly sourceLabel: string;
  readonly confidence: number | null;
  readonly qualityScore: number;
  readonly sensitivity: readonly MemorySensitivity[];
  readonly createdAtLabel: string;
  readonly retainUntilLabel: string;
  readonly evidenceMessageIds: readonly string[];
  readonly sourceRunIds: readonly string[];
  readonly lineage: readonly MemoryLineageNode[];
}

export interface MemoryProvenanceRevisionProjection {
  readonly records: readonly MemoryProvenanceRevisionRecord[];
  readonly evidenceCount: number;
  readonly runCount: number;
  readonly conflictCount: number;
}

const relationLabels: Record<MemoryLineageRelation, string> = {
  candidate: "Current candidate",
  contradicts: "Contradicts",
  duplicate: "Similar / duplicate",
};

const relationIcons: Record<MemoryLineageRelation, typeof History> = {
  candidate: CheckCircle2,
  contradicts: AlertTriangle,
  duplicate: Link2,
};

function confidenceLabel(value: number | null): string {
  return value === null ? "Explicit" : `${Math.round(value * 100)}%`;
}

function titleFor(proposal: MemoryProposalInboxItem): string {
  return proposal.title?.trim() || proposal.content;
}

function toRecord(proposal: MemoryProposalInboxItem): MemoryProvenanceRevisionRecord {
  const lineage: MemoryLineageNode[] = [
    {
      revisionId: proposal.revisionId,
      relation: "candidate",
      label: titleFor(proposal),
      existsInSnapshot: true,
    },
    ...proposal.contradictionRevisionIds.map((revisionId) => ({
      revisionId,
      relation: "contradicts" as const,
      label: "Referenced contradiction",
      existsInSnapshot: false,
    })),
    ...proposal.duplicateRevisionIds.map((revisionId) => ({
      revisionId,
      relation: "duplicate" as const,
      label: "Referenced similar revision",
      existsInSnapshot: false,
    })),
  ];
  return {
    proposalId: proposal.id,
    memoryId: proposal.memoryId,
    revisionId: proposal.revisionId,
    title: titleFor(proposal),
    content: proposal.content,
    scopeLabel: proposal.scopeLabel,
    sourceLabel: proposal.sourceLabel,
    confidence: proposal.confidence,
    qualityScore: proposal.qualityScore,
    sensitivity: proposal.sensitivity,
    createdAtLabel: proposal.createdAtLabel,
    retainUntilLabel: proposal.retainUntilLabel,
    evidenceMessageIds: proposal.evidenceMessageIds,
    sourceRunIds: proposal.sourceRunIds,
    lineage,
  };
}

export function buildMemoryProvenanceRevisionProjection(
  proposals: readonly MemoryProposalInboxItem[] = DEFAULT_MEMORY_PROPOSALS,
): MemoryProvenanceRevisionProjection {
  const records = proposals.map(toRecord);
  return {
    records,
    evidenceCount: new Set(records.flatMap((record) => record.evidenceMessageIds)).size,
    runCount: new Set(records.flatMap((record) => record.sourceRunIds)).size,
    conflictCount: records.reduce(
      (count, record) => count + record.lineage.filter((node) => node.relation !== "candidate").length,
      0,
    ),
  };
}

export interface MemoryProvenanceRevisionInspectorProps {
  readonly proposals?: readonly MemoryProposalInboxItem[];
}

type InspectorTab = "provenance" | "revisions" | "integrity";

function BoundaryNote() {
  return (
    <p className="memory-provenance-inspector__boundary" role="note">
      <ShieldAlert size={14} aria-hidden="true" />
      <span>
        Preview only · Renderer-local · No durable write. This view does not open verified chats, runs, provider
        requests, or native memory records; IDs are illustrative pointers only.
      </span>
    </p>
  );
}

function ProvenancePanel({ record }: { readonly record: MemoryProvenanceRevisionRecord }) {
  return (
    <div className="memory-provenance-inspector__panel" aria-label="Provenance details">
      <div className="memory-provenance-inspector__content-callout">
        <span className="eyebrow">Candidate content</span>
        <p>{record.content}</p>
      </div>
      <dl className="memory-provenance-inspector__facts">
        <div><dt>Memory key</dt><dd><code>{record.memoryId}</code></dd></div>
        <div><dt>Revision</dt><dd><code>{record.revisionId}</code></dd></div>
        <div><dt>Scope</dt><dd>{record.scopeLabel}</dd></div>
        <div><dt>Confidence</dt><dd>{confidenceLabel(record.confidence)}</dd></div>
        <div><dt>Quality score</dt><dd>{Math.round(record.qualityScore * 100)}%</dd></div>
        <div><dt>Sensitivity</dt><dd>{record.sensitivity.join(", ")}</dd></div>
        <div><dt>Created</dt><dd>{record.createdAtLabel}</dd></div>
        <div><dt>Retention</dt><dd>{record.retainUntilLabel}</dd></div>
      </dl>

      <section className="memory-provenance-inspector__subsection" aria-label="Source evidence">
        <h4><MessageSquareText size={14} /> Source evidence</h4>
        <p>{record.sourceLabel}. References are sample pointers until a native evidence resolver is connected.</p>
        <div className="memory-provenance-inspector__chips">
          {record.evidenceMessageIds.map((id) => <code key={id}>{id}</code>)}
          {record.sourceRunIds.map((id) => <code key={id}>{id}</code>)}
        </div>
      </section>
    </div>
  );
}

function RevisionPanel({ record }: { readonly record: MemoryProvenanceRevisionRecord }) {
  const hasConflict = record.lineage.some((node) => node.relation === "contradicts");
  const hasDuplicate = record.lineage.some((node) => node.relation === "duplicate");
  return (
    <div className="memory-provenance-inspector__panel" aria-label="Revision lineage details">
      <div className="memory-provenance-inspector__revision-heading">
        <div><span className="eyebrow">Revision lineage</span><h4>{record.title}</h4></div>
        <span className="memory-provenance-inspector__chip memory-provenance-inspector__chip--candidate">
          <CheckCircle2 size={12} /> Candidate
        </span>
      </div>
      <div className="memory-provenance-inspector__timeline" role="list" aria-label="Memory revision lineage">
        {record.lineage.map((node, index) => {
          const Icon = relationIcons[node.relation];
          return (
            <div key={`${node.revisionId}-${node.relation}`} className={`memory-provenance-inspector__timeline-row memory-provenance-inspector__timeline-row--${node.relation}`} role="listitem">
              <span className="memory-provenance-inspector__timeline-marker"><Icon size={14} /></span>
              <span className="memory-provenance-inspector__timeline-copy">
                <strong>{relationLabels[node.relation]}</strong>
                <small><code>{node.revisionId}</code> · {node.label}</small>
                <em>{node.existsInSnapshot ? "Present in this renderer snapshot" : "Referenced ID only · not hydrated"}</em>
              </span>
              {index < record.lineage.length - 1 ? <span className="memory-provenance-inspector__timeline-connector" aria-hidden="true" /> : null}
            </div>
          );
        })}
      </div>
      {hasConflict ? <div className="memory-provenance-inspector__callout memory-provenance-inspector__callout--warning"><AlertTriangle size={14} /><span>Contradicts {record.lineage.filter((node) => node.relation === "contradicts").length} existing revision{record.lineage.filter((node) => node.relation === "contradicts").length === 1 ? "" : "s"}. Manual review is recommended.</span></div> : null}
      {hasDuplicate ? <div className="memory-provenance-inspector__callout"><Link2 size={14} /><span>Looks similar to {record.lineage.filter((node) => node.relation === "duplicate").length} existing revision{record.lineage.filter((node) => node.relation === "duplicate").length === 1 ? "" : "s"}; review for duplicates.</span></div> : null}
      {!hasConflict && !hasDuplicate ? <p className="memory-provenance-inspector__muted">No contradiction or duplicate references are present in this preview.</p> : null}
    </div>
  );
}

function IntegrityPanel({ record }: { readonly record: MemoryProvenanceRevisionRecord }) {
  const checks = [
    { label: "Source message references attached", state: record.evidenceMessageIds.length > 0 ? "pass" : "attention", detail: `${record.evidenceMessageIds.length} illustrative message pointer${record.evidenceMessageIds.length === 1 ? "" : "s"}` },
    { label: "Run lineage references attached", state: record.sourceRunIds.length > 0 ? "pass" : "attention", detail: `${record.sourceRunIds.length} illustrative run pointer${record.sourceRunIds.length === 1 ? "" : "s"}` },
    { label: "Revision conflict review", state: record.lineage.some((node) => node.relation !== "candidate") ? "attention" : "pass", detail: record.lineage.some((node) => node.relation !== "candidate") ? "Related revision IDs need human review" : "No related revision IDs in this preview" },
    { label: "Native provenance receipt", state: "unknown", detail: "Not observed; native evidence resolver is planned" },
  ] as const;
  return (
    <div className="memory-provenance-inspector__panel" aria-label="Provenance integrity checks">
      <div className="memory-provenance-inspector__integrity-intro"><FileJson2 size={16} /><span><strong>Evidence health for this snapshot</strong><small>These checks validate shape only; they do not prove source authenticity.</small></span></div>
      <div className="memory-provenance-inspector__checks" role="list" aria-label="Provenance integrity checks">
        {checks.map((check) => (
          <div key={check.label} role="listitem" className={`memory-provenance-inspector__check memory-provenance-inspector__check--${check.state}`}>
            {check.state === "pass" ? <CheckCircle2 size={15} /> : check.state === "attention" ? <AlertTriangle size={15} /> : <Info size={15} />}
            <span><strong>{check.label}</strong><small>{check.detail}</small></span>
            <em>{check.state === "pass" ? "Shape pass" : check.state === "attention" ? "Review" : "Unknown"}</em>
          </div>
        ))}
      </div>
      <p className="memory-provenance-inspector__muted">A native receipt, hash verification, and source-open action are planned for the desktop bridge.</p>
    </div>
  );
}

export function MemoryProvenanceRevisionInspector({ proposals = DEFAULT_MEMORY_PROPOSALS }: MemoryProvenanceRevisionInspectorProps) {
  const projection = useMemo(() => buildMemoryProvenanceRevisionProjection(proposals), [proposals]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(projection.records[0]?.proposalId ?? null);
  const [tab, setTab] = useState<InspectorTab>("provenance");
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(
    () => projection.records.filter((record) => !normalizedQuery || [record.title, record.content, record.scopeLabel, record.sourceLabel, record.revisionId].join(" ").toLowerCase().includes(normalizedQuery)),
    [normalizedQuery, projection.records],
  );
  const selected = filtered.find((record) => record.proposalId === selectedId)
    ?? filtered[0]
    ?? null;

  return (
    <section className="memory-provenance-inspector" aria-label="Memory provenance and revision inspector">
      <header className="memory-provenance-inspector__header">
        <div><span className="eyebrow">Lineage workbench</span><h3><History size={17} /> Provenance & revision inspector</h3><p>Trace why a memory candidate exists, which references support it, and where revision conflicts need review.</p></div>
        <span className="memory-provenance-inspector__status"><Clock3 size={13} /> Preview only</span>
      </header>

      <div className="memory-provenance-inspector__metrics" role="status" aria-label="Provenance summary">
        <div><strong>{projection.records.length}</strong><span>candidates</span></div>
        <div><strong>{projection.evidenceCount}</strong><span>evidence pointers</span></div>
        <div><strong>{projection.runCount}</strong><span>run pointers</span></div>
        <div><strong>{projection.conflictCount}</strong><span>lineage references</span></div>
      </div>

      <div className="memory-provenance-inspector__toolbar" role="toolbar" aria-label="Provenance inspector controls">
        <label className="memory-provenance-inspector__search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search candidate, scope, source, or revision" aria-label="Search provenance records" /></label>
        <span className="memory-provenance-inspector__toolbar-note"><ShieldAlert size={13} /> Example references · not verified</span>
      </div>

      <div className="memory-provenance-inspector__body">
        <div className="memory-provenance-inspector__list" role="list" aria-label="Memory provenance records">
          {filtered.length === 0 ? <div className="memory-provenance-inspector__empty"><Search size={20} /><strong>No records match</strong><span>Try a different search term.</span></div> : null}
          {filtered.map((record) => (
            <button key={record.proposalId} type="button" role="listitem" className={`memory-provenance-inspector__row${record.proposalId === selected?.proposalId ? " is-selected" : ""}`} aria-pressed={record.proposalId === selected?.proposalId} onClick={() => setSelectedId(record.proposalId)}>
              <span className="memory-provenance-inspector__row-icon"><History size={15} /></span>
              <span><strong>{record.title}</strong><small>{record.scopeLabel} · {record.revisionId}</small><em>{record.evidenceMessageIds.length} evidence · {record.lineage.length - 1} related</em></span>
            </button>
          ))}
        </div>

        <aside className="memory-provenance-inspector__detail" aria-label="Selected provenance record">
          {selected ? <>
            <header><div><span className="eyebrow">Selected candidate</span><h4>{selected.title}</h4></div><span className="memory-provenance-inspector__chip">{confidenceLabel(selected.confidence)}</span></header>
            <div className="memory-provenance-inspector__tabs" role="tablist" aria-label="Provenance detail views">
              {([ ["provenance", "Provenance", MessageSquareText], ["revisions", "Revisions", History], ["integrity", "Integrity", ShieldAlert] ] as const).map(([id, label, Icon]) => <button key={id} type="button" role="tab" id={`memory-provenance-tab-${id}`} aria-selected={tab === id} aria-controls={`memory-provenance-panel-${id}`} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><Icon size={13} /> {label}</button>)}
            </div>
            <div id={`memory-provenance-panel-${tab}`} role="tabpanel" aria-labelledby={`memory-provenance-tab-${tab}`} className="memory-provenance-inspector__tabpanel">
              {tab === "provenance" ? <ProvenancePanel record={selected} /> : null}
              {tab === "revisions" ? <RevisionPanel record={selected} /> : null}
              {tab === "integrity" ? <IntegrityPanel record={selected} /> : null}
            </div>
          </> : <div className="memory-provenance-inspector__empty"><History size={22} /><strong>Select a candidate</strong><span>Its evidence and revision lineage will appear here.</span></div>}
        </aside>
      </div>
      <BoundaryNote />
    </section>
  );
}

export default MemoryProvenanceRevisionInspector;
