import {
  AlertTriangle,
  Flag,
  ListChecks,
  LockKeyhole,
  Milestone,
  Target,
} from "lucide-react";
import type { ReactNode } from "react";

import type { ProjectOverviewStatus, ProjectOverviewView } from "./types";

export interface ProjectMissionOverviewProps {
  projectId: string;
  overview: ProjectOverviewView;
}

const STATUS_LABELS: Record<ProjectOverviewStatus, string> = {
  current: "Current",
  candidate: "Candidate",
  stale: "Stale",
  failed: "Failed",
  superseded: "Superseded",
  unknown: "Unknown",
};

function valueOrUnknown(value: string | null | undefined): string {
  return value?.trim() ? value : "Unknown";
}

function statusDescription(status: ProjectOverviewStatus): string {
  if (status === "current") return "Hydrated from the current overview projection.";
  if (status === "candidate") return "A candidate projection is available for review.";
  if (status === "stale" || status === "superseded") return "This projection may be out of date.";
  if (status === "failed") return "The latest overview refresh did not produce a verified projection.";
  return "No durable overview revision is hydrated for this project.";
}

function MissionField({
  icon,
  label,
  value,
  detail,
  field,
  tone = "neutral",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  field: string;
  tone?: "neutral" | "attention";
}) {
  return (
    <article className={`project-mission-overview__field project-mission-overview__field--${tone}`} data-mission-field={field}>
      <span className="project-mission-overview__field-icon" aria-hidden="true">{icon}</span>
      <span className="project-mission-overview__field-copy">
        <span className="project-mission-overview__field-label">{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </span>
    </article>
  );
}

export function ProjectMissionOverview({ projectId, overview }: ProjectMissionOverviewProps) {
  const hasRevision = Boolean(overview.overviewRevisionId);
  const statusLabel = STATUS_LABELS[overview.status];
  const nonGoals = overview.nonGoals.filter((item) => item.trim()).slice(0, 4);
  const attentionItems = overview.attentionItems.filter((item) => item.trim()).slice(0, 4);
  const phaseDetail = overview.milestone?.trim()
    ? `Milestone: ${overview.milestone}`
    : "Milestone unknown";
  const attentionDetail = attentionItems.length > 0
    ? `${attentionItems.length} item(s) need review`
    : "No blocking decision is hydrated";

  return (
    <section
      className="project-mission-overview"
      aria-labelledby={`project-mission-overview-title-${projectId}`}
      data-mission-status={overview.status}
      data-mission-revision={overview.overviewRevisionId ?? "unknown"}
    >
      <header className="project-mission-overview__header">
        <div className="project-mission-overview__heading">
          <span className="eyebrow"><Target size={13} aria-hidden="true" /> Mission frame</span>
          <h4 id={`project-mission-overview-title-${projectId}`}>Project mission overview</h4>
          <p>
            Keep the objective, delivery horizon, and unresolved decisions visible before opening a detailed work surface.
          </p>
        </div>
        <span
          className={`project-mission-overview__status project-mission-overview__status--${overview.status}`}
          title={statusDescription(overview.status)}
        >
          {statusLabel}
        </span>
      </header>

      <div className="project-mission-overview__fields" aria-label="Project mission facts">
        <MissionField
          icon={<Target size={15} />}
          label="Primary goal"
          value={valueOrUnknown(overview.goal)}
          detail={overview.goal ? "Objective from the overview projection" : "No goal fact is hydrated"}
          field="goal"
        />
        <MissionField
          icon={<Milestone size={15} />}
          label="Current phase"
          value={valueOrUnknown(overview.phase)}
          detail={phaseDetail}
          field="phase"
        />
        <MissionField
          icon={<ListChecks size={15} />}
          label="Next dependency-complete task"
          value={valueOrUnknown(overview.nextTask)}
          detail={overview.nextTask ? "Suggested by the current project projection" : "No next task is hydrated"}
          field="next-task"
        />
        <MissionField
          icon={<AlertTriangle size={15} />}
          label="Attention / blockers"
          value={attentionItems[0] ?? "Unknown"}
          detail={attentionDetail}
          field="attention"
          tone={attentionItems.length > 0 ? "attention" : "neutral"}
        />
      </div>

      <div className="project-mission-overview__supporting">
        <section className="project-mission-overview__list" aria-labelledby={`project-mission-nongoals-${projectId}`}>
          <header>
            <span className="project-mission-overview__list-icon" aria-hidden="true"><Flag size={14} /></span>
            <span>
              <strong id={`project-mission-nongoals-${projectId}`}>Non-goals</strong>
              <small>Explicitly out of scope for this mission</small>
            </span>
          </header>
          {nonGoals.length > 0 ? (
            <ul>
              {nonGoals.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : (
            <p className="project-mission-overview__empty">No non-goal facts are hydrated.</p>
          )}
        </section>

        <section className="project-mission-overview__list" aria-labelledby={`project-mission-attention-${projectId}`}>
          <header>
            <span className="project-mission-overview__list-icon project-mission-overview__list-icon--attention" aria-hidden="true"><AlertTriangle size={14} /></span>
            <span>
              <strong id={`project-mission-attention-${projectId}`}>Blocking decisions</strong>
              <small>Review before broadening scope or starting work</small>
            </span>
          </header>
          {attentionItems.length > 0 ? (
            <ul>
              {attentionItems.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : (
            <p className="project-mission-overview__empty">No blocking decision is hydrated.</p>
          )}
        </section>
      </div>

      <p className="project-mission-overview__boundary" role="note">
        <LockKeyhole size={14} aria-hidden="true" />
        <span>
          {hasRevision
            ? "Mission facts are a projection of the named overview revision; stale and unknown values stay visible."
            : "Renderer-local mission preview only; no durable goal, task, decision, scheduler, or Project Twin mutation is performed."}
        </span>
      </p>
    </section>
  );
}

export default ProjectMissionOverview;
