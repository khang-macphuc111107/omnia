import { CircleAlert, FileText, Layers3, Link2, LockKeyhole, Sparkles } from "lucide-react";

import type { ProjectContextAvailability } from "./project-context-availability-contract";
import type { MemoryView, ProjectView, SkillView } from "./types";

export type ContextRunEvidenceSurface = "context" | "run";
export type ContextRunEvidenceState = "reported" | "preview" | "planned" | "unknown" | "blocked";

export interface ContextRunEvidenceRow {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly state: ContextRunEvidenceState;
}

export interface ContextRunEvidenceModel {
  readonly title: string;
  readonly subtitle: string;
  readonly rows: readonly ContextRunEvidenceRow[];
  readonly sourceSummary: string;
  readonly boundary: string;
}

function healthState(project: ProjectView | undefined): ContextRunEvidenceState {
  if (!project) return "unknown";
  if (project.contextHealth === "missing-access") return "blocked";
  if (project.contextHealth === "ready") return "preview";
  if (project.contextHealth === "not-compiled") return "planned";
  return "preview";
}

function healthLabel(project: ProjectView | undefined): string {
  if (!project) return "No Project scope";
  switch (project.contextHealth) {
    case "ready":
      return "Renderer sources ready";
    case "indexing":
      return "Indexing projection";
    case "over-budget":
      return "Over preview budget";
    case "missing-access":
      return "Access missing";
    default:
      return "Not compiled";
  }
}

function folderDetail(project: ProjectView | undefined): string {
  if (!project || project.folders.length === 0) return "No workspace folder grants are attached.";
  const blocked = project.folders.filter((folder) => folder.state === "permission-lost" || folder.state === "offline").length;
  if (blocked > 0) return `${blocked} folder grant${blocked === 1 ? "" : "s"} need access review.`;
  const ready = project.folders.filter((folder) => folder.state === "ready").length;
  return `${ready}/${project.folders.length} folder reference${project.folders.length === 1 ? "" : "s"} marked ready; content is not read here.`;
}

function activeMemoryCount(project: ProjectView | undefined, memories: readonly MemoryView[]): number {
  if (!project) return 0;
  return memories.filter((memory) => memory.status === "active" && (memory.scopeLabel === "Global" || memory.scopeLabel.includes(project.name))).length;
}

function activeSkillCount(skills: readonly SkillView[]): number {
  return skills.filter((skill) => skill.enabled && (skill.scope === "Global" || skill.scope === "Project")).length;
}

interface ContextRevisionPresentation {
  readonly value: string;
  readonly detail: string;
  readonly state: ContextRunEvidenceState;
}

/**
 * Keep a context revision ID from being treated as proof of a current native
 * context.  Overview projections can expose an ID without the source
 * watermark/evidence needed to establish freshness, while an explicit
 * ProjectContextAvailability object can distinguish current, stale, and
 * failed native evidence.
 */
function contextRevisionPresentation({
  project,
  contextRevisionId,
  contextAvailability,
}: {
  readonly project?: ProjectView | undefined;
  readonly contextRevisionId: string | null;
  readonly contextAvailability?: ProjectContextAvailability | null;
}): ContextRevisionPresentation {
  const evidence = contextAvailability?.evidence;
  const revisionId = evidence?.revisionId ?? contextRevisionId;
  const value = revisionId ?? "Not frozen";

  // Access and budget denials override any historical revision ID.  The
  // availability contract deliberately retains the ID as stale evidence, but
  // this card should surface the current block rather than imply it is usable.
  if (project?.contextHealth === "missing-access" || project?.contextHealth === "over-budget") {
    return {
      value,
      state: "blocked",
      detail: contextAvailability?.reason ?? "Context revision is withheld because project context is blocked by access or preview budget.",
    };
  }

  if (evidence?.state === "native-current" && revisionId) {
    return {
      value,
      state: "reported",
      detail: `Native context revision observed with source watermark ${evidence.sourceEventWatermark}; provider input and exact run lineage remain unverified.`,
    };
  }

  if (evidence?.state === "native-stale") {
    return {
      value,
      state: "preview",
      detail: contextAvailability?.reason ?? "A native context revision is historical and cannot be treated as current context input.",
    };
  }

  if (evidence?.state === "native-failed") {
    return {
      value,
      state: "blocked",
      detail: contextAvailability?.reason ?? "The native context revision failed; no current context input is available.",
    };
  }

  if (contextRevisionId) {
    return {
      value,
      state: "preview",
      detail: "Revision ID is present in the Project Overview projection, but native source watermark/evidence is not available.",
    };
  }

  return {
    value,
    state: "planned",
    detail: "Native context freeze and immutable manifest are not connected.",
  };
}

export function buildContextRunEvidenceModel({
  surface,
  project,
  conversationId,
  runId,
  memories = [],
  skills = [],
  contextRevisionId = null,
  contextAvailability = null,
}: {
  readonly surface: ContextRunEvidenceSurface;
  readonly project?: ProjectView | undefined;
  readonly conversationId?: string | null | undefined;
  readonly runId?: string | null | undefined;
  readonly memories?: readonly MemoryView[] | undefined;
  readonly skills?: readonly SkillView[] | undefined;
  readonly contextRevisionId?: string | null | undefined;
  /** Shared availability/evidence contract, when hydrated by the host surface. */
  readonly contextAvailability?: ProjectContextAvailability | null | undefined;
}): ContextRunEvidenceModel {
  const memoryCount = activeMemoryCount(project, memories);
  const skillCount = activeSkillCount(skills);
  const instructionCount = project?.instructions.trim() ? 1 : 0;
  const projectState = healthState(project);
  const contextRevision = contextRevisionPresentation({
    project,
    contextRevisionId,
    contextAvailability,
  });
  const rows: ContextRunEvidenceRow[] = [
    {
      id: "project",
      label: "Project scope",
      value: project?.name ?? "Standalone Inbox",
      detail: project ? healthLabel(project) : "This Chat has no Project owner.",
      state: project ? projectState : "unknown",
    },
    {
      id: "conversation",
      label: "Chat scope",
      value: conversationId ?? "Unknown",
      detail: conversationId ? "Renderer conversation identity" : "Conversation identity was not supplied.",
      state: conversationId ? "preview" : "unknown",
    },
    {
      id: "context-revision",
      label: "Context revision",
      value: contextRevision.value,
      detail: contextRevision.detail,
      state: contextRevision.state,
    },
    {
      id: "instructions",
      label: "Instructions",
      value: `${instructionCount} candidate${instructionCount === 1 ? "" : "s"}`,
      detail: instructionCount ? "Project instructions are visible but not compiled into a provider request." : "No Project instruction candidate is present.",
      state: instructionCount ? "preview" : "unknown",
    },
    {
      id: "folders",
      label: "Workspace folders",
      value: `${project?.folders.length ?? 0} reference${project?.folders.length === 1 ? "" : "s"}`,
      detail: folderDetail(project),
      state: project?.contextHealth === "missing-access" ? "blocked" : project?.folders.length ? "preview" : "unknown",
    },
    {
      id: "memory",
      label: "Memory candidates",
      value: `${memoryCount} active`,
      detail: memoryCount ? "Renderer candidates only; retrieval, approval, and injection are not claimed." : "No active Project-scoped memory candidate is visible.",
      state: memoryCount ? "planned" : "unknown",
    },
    {
      id: "skills",
      label: "Skill candidates",
      value: `${skillCount} enabled`,
      detail: skillCount ? "Renderer activation labels only; native version receipts are not connected." : "No enabled Global/Project skill candidate is visible.",
      state: skillCount ? "planned" : "unknown",
    },
  ];

  if (surface === "run") {
    rows.splice(2, 0, {
      id: "run",
      label: "Run identity",
      value: runId ?? "No model run",
      detail: runId ? "Linked to the current renderer run projection." : "No run ID is available for this Chat.",
      state: runId ? "preview" : "unknown",
    });
  }

  return {
    title: surface === "run" ? "Context lineage" : "Context evidence",
    subtitle: surface === "run" ? "What this run can be linked to in the current projection" : "What could shape the next Chat in this renderer preview",
    rows,
    sourceSummary: `${project?.folders.length ?? 0} folder${project?.folders.length === 1 ? "" : "s"} · ${instructionCount} instruction${instructionCount === 1 ? "" : "s"} · ${memoryCount} memory · ${skillCount} skill`,
    boundary: surface === "run"
      ? contextRevision.state === "reported"
        ? "A native context revision is observed. Its link to this run, provider payload, memory injection, and durable run lineage receipt are not proven by this surface."
        : "Renderer projection only. A context revision, provider payload, memory injection, and durable lineage receipt are not proven by this surface."
      : "Renderer-local preview only. No file read, retrieval, provider dispatch, native context freeze, or durable write occurs here.",
  };
}

function stateLabel(state: ContextRunEvidenceState): string {
  switch (state) {
    case "reported":
      return "Reported";
    case "preview":
      return "Preview";
    case "planned":
      return "Planned";
    case "blocked":
      return "Blocked";
    default:
      return "Unknown";
  }
}

function StateIcon({ state }: { readonly state: ContextRunEvidenceState }) {
  if (state === "blocked") return <CircleAlert size={13} />;
  if (state === "planned") return <Sparkles size={13} />;
  if (state === "reported") return <Link2 size={13} />;
  if (state === "preview") return <FileText size={13} />;
  return <LockKeyhole size={13} />;
}

export function ContextRunEvidenceCard(props: Parameters<typeof buildContextRunEvidenceModel>[0]) {
  const model = buildContextRunEvidenceModel(props);
  return (
    <section className="inspector-section context-run-evidence" data-testid={`context-run-evidence-${props.surface}`}>
      <header>
        <div>
          <span className="inspector-section__icon inspector-section__icon--blue"><Layers3 size={15} /></span>
          <span>
            <strong>{model.title}</strong>
            <small>{model.subtitle}</small>
          </span>
        </div>
        <span className="context-run-evidence__summary">{model.sourceSummary}</span>
      </header>
      <div className="context-run-evidence__rows">
        {model.rows.map((row) => (
          <article key={row.id} className={`context-run-evidence__row context-run-evidence__row--${row.state}`}>
            <span className="context-run-evidence__row-icon" aria-hidden="true"><StateIcon state={row.state} /></span>
            <span className="context-run-evidence__row-copy"><strong>{row.label}</strong><small>{row.value}</small><em>{row.detail}</em></span>
            <span className={`context-run-evidence__state context-run-evidence__state--${row.state}`}>{stateLabel(row.state)}</span>
          </article>
        ))}
      </div>
      <p className="context-run-evidence__boundary"><LockKeyhole size={13} /><span>{model.boundary}</span></p>
    </section>
  );
}

export default ContextRunEvidenceCard;
