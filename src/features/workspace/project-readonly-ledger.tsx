import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleHelp,
  FileSearch,
  Gauge,
  Layers3,
  LockKeyhole,
  Route,
  ShieldCheck,
  Target,
} from "lucide-react";
import type { ReactNode } from "react";

import type { ProjectContextAvailability } from "./project-context-availability-contract";
import type { ProjectView } from "./types";

export interface ProjectReadonlyLedgerProps {
  readonly project: ProjectView;
  readonly contextAvailability: ProjectContextAvailability;
  readonly chatCount: number;
  readonly memoryCount: number;
  readonly skillCount: number;
}

const OVERVIEW_STATUS_LABELS: Record<NonNullable<ProjectView["overview"]>["status"], string> = {
  current: "Current projection",
  candidate: "Candidate projection",
  stale: "Stale projection",
  failed: "Failed projection",
  superseded: "Superseded projection",
  unknown: "No durable projection",
};

function valueOrUnknown(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "Unknown";
  return String(value);
}

function modelRouteLabel(project: ProjectView): string {
  if (!project.modelProfileId || project.modelProfileId === "auto") return "Automatic route";
  return project.modelProfileId;
}

function evidenceLabel(project: ProjectView, contextAvailability: ProjectContextAvailability): string {
  const revisionId = contextAvailability.evidence.revisionId;
  if (contextAvailability.evidence.state === "native-current") return `Native revision ${revisionId}`;
  if (contextAvailability.evidence.state === "native-stale") return `Historical revision ${revisionId}`;
  if (contextAvailability.evidence.state === "native-failed") return `Failed revision ${revisionId}`;
  if (project.contextHealth === "ready") return "Referenced · not indexed";
  return "Renderer projection only";
}

function statusIcon(status: NonNullable<ProjectView["overview"]>["status"]) {
  if (status === "current") return <CheckCircle2 size={13} aria-hidden="true" />;
  if (status === "failed" || status === "stale" || status === "superseded") {
    return <AlertTriangle size={13} aria-hidden="true" />;
  }
  return <CircleHelp size={13} aria-hidden="true" />;
}

function LedgerFact({
  icon,
  label,
  value,
  detail,
  field,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly field: string;
}) {
  return (
    <article className="project-control-deck__readonly-ledger-fact" data-ledger-field={field}>
      <span className="project-control-deck__readonly-ledger-fact-icon" aria-hidden="true">{icon}</span>
      <span className="project-control-deck__readonly-ledger-fact-copy">
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </span>
    </article>
  );
}

/**
 * A bounded read-only projection for the Project Control Deck.
 *
 * This component intentionally consumes only already-visible Project metadata
 * and renderer-derived context availability. It has no callbacks and cannot
 * mutate the store, grant access, compile context, or dispatch a provider run.
 */
export function ProjectReadonlyLedger({
  project,
  contextAvailability,
  chatCount,
  memoryCount,
  skillCount,
}: ProjectReadonlyLedgerProps) {
  const overview = project.overview;
  const overviewStatus = overview?.status ?? "unknown";
  const attentionItems = overview?.attentionItems.filter((item) => item.trim()).slice(0, 4) ?? [];
  const overviewRevision = overview?.overviewRevisionId;
  const contextRevision = overview?.contextRevisionId;
  const twinRevision = overview?.projectTwinRevisionId;
  const watermark = overview?.sourceEventWatermark;

  return (
    <section
      className="project-control-deck__readonly-ledger"
      aria-labelledby={`project-readonly-ledger-title-${project.id}`}
      data-ledger-status={overviewStatus}
      data-ledger-context={contextAvailability.surfaceStatus}
    >
      <header className="project-control-deck__readonly-ledger-header">
        <div>
          <span className="eyebrow"><FileSearch size={12} aria-hidden="true" /> Read-only snapshot</span>
          <h3 id={`project-readonly-ledger-title-${project.id}`}>Project evidence ledger</h3>
          <p>One compact view of the facts currently visible to the renderer, with unknown and native gaps left explicit.</p>
        </div>
        <span className="project-control-deck__readonly-ledger-badge"><ShieldCheck size={12} aria-hidden="true" /> No write path</span>
      </header>

      <div className="project-control-deck__readonly-ledger-facts" aria-label="Project read-only facts">
        <LedgerFact
          icon={<Target size={14} />}
          label="Goal"
          value={valueOrUnknown(overview?.goal)}
          detail={overview?.goal ? "Overview projection" : "No goal fact hydrated"}
          field="goal"
        />
        <LedgerFact
          icon={<Layers3 size={14} />}
          label="Phase / milestone"
          value={valueOrUnknown(overview?.phase)}
          detail={overview?.milestone ? `Milestone: ${overview.milestone}` : "Milestone unknown"}
          field="phase"
        />
        <LedgerFact
          icon={<Route size={14} />}
          label="Next task"
          value={valueOrUnknown(overview?.nextTask)}
          detail={overview?.nextTask ? "Read-only project projection" : "No next task hydrated"}
          field="next-task"
        />
        <LedgerFact
          icon={<Gauge size={14} />}
          label="Context"
          value={contextAvailability.label}
          detail={evidenceLabel(project, contextAvailability)}
          field="context"
        />
        <LedgerFact
          icon={<Route size={14} />}
          label="Model route"
          value={modelRouteLabel(project)}
          detail="Preview metadata · not dispatched"
          field="model-route"
        />
        <LedgerFact
          icon={statusIcon(overviewStatus)}
          label="Overview status"
          value={OVERVIEW_STATUS_LABELS[overviewStatus]}
          detail={overviewRevision ? `Revision ${overviewRevision}` : "No durable revision hydrated"}
          field="overview-status"
        />
      </div>

      <div className="project-control-deck__readonly-ledger-scope" aria-label="Project read-only scope counts">
        <span><strong>{chatCount}</strong><small>Chats in scope</small></span>
        <span><strong>{project.folders.length}</strong><small>Folder grants</small></span>
        <span><strong>{memoryCount}</strong><small>Memory candidates</small></span>
        <span><strong>{skillCount}</strong><small>Skill candidates</small></span>
        <span><strong>{project.instructions.trim() ? "Present" : "Empty"}</strong><small>Instructions</small></span>
      </div>

      <details className="project-control-deck__readonly-ledger-details">
        <summary><span><Boxes size={13} aria-hidden="true" /> Provenance and attention</span><span>{attentionItems.length > 0 ? `${attentionItems.length} attention` : "No attention items"}</span></summary>
        <div className="project-control-deck__readonly-ledger-detail-grid">
          <dl>
            <div><dt>Overview revision</dt><dd>{valueOrUnknown(overviewRevision)}</dd></div>
            <div><dt>Context revision</dt><dd>{valueOrUnknown(contextRevision)}</dd></div>
            <div><dt>Project Twin revision</dt><dd>{valueOrUnknown(twinRevision)}</dd></div>
            <div><dt>Source watermark</dt><dd>{valueOrUnknown(watermark)}</dd></div>
            <div><dt>Branch / worktree</dt><dd>{valueOrUnknown(overview?.repositoryBranch ?? overview?.activeBranch)} · {valueOrUnknown(overview?.worktree)}</dd></div>
          </dl>
          <div className="project-control-deck__readonly-ledger-attention">
            <strong>Attention items</strong>
            {attentionItems.length > 0 ? <ul>{attentionItems.map((item) => <li key={item}>{item}</li>)}</ul> : <p>No blocking decision is hydrated.</p>}
          </div>
        </div>
      </details>

      <p className="project-control-deck__readonly-ledger-boundary" role="note">
        <LockKeyhole size={13} aria-hidden="true" />
        <span>Read-only renderer projection. It does not read workspace files, compile context, change project settings, persist revisions, or send provider requests.</span>
      </p>
    </section>
  );
}

export default ProjectReadonlyLedger;
