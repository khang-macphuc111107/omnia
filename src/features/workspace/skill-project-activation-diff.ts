import type { ProjectView, SkillView } from "./types";
import type { ProjectSkillActivation } from "./skill-activation-matrix";

export type ProjectSkillEffectiveState =
  | "inherited-enabled"
  | "inherited-disabled"
  | "project-enabled"
  | "project-disabled"
  | "project-unset"
  | "manual-only";

export type ProjectSkillDiffKind = "added" | "removed" | "changed" | "unchanged";

export interface ProjectSkillActivationCell {
  readonly projectId: string;
  readonly projectName: string;
  readonly skillId: string;
  readonly skillName: string;
  readonly scope: SkillView["scope"];
  readonly state: ProjectSkillEffectiveState;
  readonly enabled: boolean;
  readonly explicit: boolean;
  readonly provenance: "global-default" | "project-draft" | "manual-policy";
}

export interface ProjectSkillActivationDiffRow {
  readonly skillId: string;
  readonly skillName: string;
  readonly scope: SkillView["scope"];
  readonly from: ProjectSkillActivationCell;
  readonly to: ProjectSkillActivationCell;
  readonly kind: ProjectSkillDiffKind;
}

export interface ProjectSkillActivationDiff {
  readonly schema: "omnia.skill-project-activation-diff-preview.v1";
  readonly scope: "renderer-session";
  readonly fromProjectId: string;
  readonly fromProjectName: string;
  readonly toProjectId: string;
  readonly toProjectName: string;
  readonly rows: readonly ProjectSkillActivationDiffRow[];
  readonly changedRows: readonly ProjectSkillActivationDiffRow[];
  readonly counts: Readonly<Record<ProjectSkillDiffKind, number>>;
}

type ProjectRef = Pick<ProjectView, "id" | "name">;

function hasOwnActivation(
  activation: ProjectSkillActivation,
  projectId: string,
  skillId: string,
): boolean {
  const project = activation[projectId];
  return Boolean(project && Object.prototype.hasOwnProperty.call(project, skillId));
}

export function projectSkillActivationCell(
  skill: SkillView,
  project: ProjectRef,
  enabledIds: ReadonlySet<string>,
  activation: ProjectSkillActivation,
): ProjectSkillActivationCell {
  const explicit = hasOwnActivation(activation, project.id, skill.id);
  const projectEnabled = activation[project.id]?.[skill.id] === true;

  if (skill.scope === "Global") {
    const enabled = enabledIds.has(skill.id);
    return {
      projectId: project.id,
      projectName: project.name,
      skillId: skill.id,
      skillName: skill.name,
      scope: skill.scope,
      state: enabled ? "inherited-enabled" : "inherited-disabled",
      enabled,
      explicit: false,
      provenance: "global-default",
    };
  }

  if (skill.scope === "Manual") {
    return {
      projectId: project.id,
      projectName: project.name,
      skillId: skill.id,
      skillName: skill.name,
      scope: skill.scope,
      state: "manual-only",
      enabled: false,
      explicit: false,
      provenance: "manual-policy",
    };
  }

  return {
    projectId: project.id,
    projectName: project.name,
    skillId: skill.id,
    skillName: skill.name,
    scope: skill.scope,
    state: explicit ? (projectEnabled ? "project-enabled" : "project-disabled") : "project-unset",
    enabled: projectEnabled,
    explicit,
    provenance: explicit ? "project-draft" : "global-default",
  };
}

function diffKind(from: ProjectSkillActivationCell, to: ProjectSkillActivationCell): ProjectSkillDiffKind {
  if (from.state === to.state) return "unchanged";
  if (!from.enabled && to.enabled) return "added";
  if (from.enabled && !to.enabled) return "removed";
  return "changed";
}

export function buildProjectSkillActivationDiff(
  skills: readonly SkillView[],
  projects: readonly ProjectView[],
  fromProjectId: string,
  toProjectId: string,
  enabledIds: ReadonlySet<string>,
  activation: ProjectSkillActivation,
): ProjectSkillActivationDiff {
  const fromProject = projects.find((project) => project.id === fromProjectId) ?? projects[0];
  const toProject = projects.find((project) => project.id === toProjectId) ?? projects.find((project) => project.id !== fromProject?.id) ?? fromProject;
  const safeFrom: ProjectRef = fromProject ?? { id: fromProjectId, name: "Unknown project" };
  const safeTo: ProjectRef = toProject ?? { id: toProjectId, name: "Unknown project" };
  const rows = skills.map((skill) => {
    const from = projectSkillActivationCell(skill, safeFrom, enabledIds, activation);
    const to = projectSkillActivationCell(skill, safeTo, enabledIds, activation);
    return {
      skillId: skill.id,
      skillName: skill.name,
      scope: skill.scope,
      from,
      to,
      kind: diffKind(from, to),
    } satisfies ProjectSkillActivationDiffRow;
  });
  const counts: Record<ProjectSkillDiffKind, number> = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  rows.forEach((row) => { counts[row.kind] += 1; });
  return {
    schema: "omnia.skill-project-activation-diff-preview.v1",
    scope: "renderer-session",
    fromProjectId: safeFrom.id,
    fromProjectName: safeFrom.name,
    toProjectId: safeTo.id,
    toProjectName: safeTo.name,
    rows,
    changedRows: rows.filter((row) => row.kind !== "unchanged"),
    counts,
  };
}

export function serializeProjectSkillActivationDiff(
  diff: ProjectSkillActivationDiff,
  format: "json" | "markdown",
): string {
  if (format === "markdown") {
    const rows = diff.changedRows.length === 0
      ? ["_No activation differences are visible in this renderer session._"]
      : diff.changedRows.map((row) => `- **${row.skillName}** — ${row.from.state} → ${row.to.state} (${row.kind})`);
    return [
      "# Omnia project skill activation diff",
      "",
      "> Renderer-session comparison. Native project policy and skill activation are not changed.",
      "",
      `- From: ${diff.fromProjectName}`,
      `- To: ${diff.toProjectName}`,
      `- Added: ${diff.counts.added}`,
      `- Removed: ${diff.counts.removed}`,
      `- Other changes: ${diff.counts.changed}`,
      "",
      "## Differences",
      "",
      ...rows,
    ].join("\n");
  }
  return JSON.stringify(diff, null, 2);
}
