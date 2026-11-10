import type {
  PlanningTask,
  ProjectPlanPreview,
} from "./project-planning-preview";

/**
 * A renderer-local bridge between the project plan and the handoff workbench.
 *
 * This is deliberately a small, portable brief rather than an execution
 * command. It carries the selected task's intent and dependency context into
 * a handoff preview without creating a scheduler item, agent lease, provider
 * request, or durable Project Twin revision.
 */
export interface ProjectHandoffSeed {
  schema: "omnia.project-handoff-seed.preview.v1";
  taskId: string;
  taskTitle: string;
  phaseId: string;
  phaseTitle: string;
  status: PlanningTask["status"];
  owner: string;
  artifact: string;
  acceptance: string;
  risk: string | null;
  dependencies: Array<{ id: string; title: string | null }>;
  brief: string;
  boundary: string;
}

type FlattenedTask = PlanningTask & { phaseId: string; phaseTitle: string };

const HANDOFF_BOUNDARY =
  "Renderer-local plan-to-handoff seed only; no scheduler item, agent lease, provider request, Project Twin revision, or filesystem write was created.";

function flattenTasks(plan: ProjectPlanPreview): FlattenedTask[] {
  return plan.phases.flatMap((phase) =>
    phase.tasks.map((task) => ({
      ...task,
      phaseId: phase.id,
      phaseTitle: phase.title,
    })),
  );
}

function chooseTask(tasks: readonly FlattenedTask[], taskId?: string): FlattenedTask | null {
  if (taskId) {
    const requested = tasks.find((task) => task.id === taskId);
    if (requested) return requested;
  }
  return tasks.find((task) => task.status === "active")
    ?? tasks.find((task) => task.status === "planned")
    ?? tasks[0]
    ?? null;
}

/**
 * Convert a task in the renderer-local plan into a bounded handoff brief.
 * Unknown dependency IDs stay visible as unresolved instead of being hidden.
 */
export function buildProjectHandoffSeed(
  plan: ProjectPlanPreview,
  taskId?: string,
): ProjectHandoffSeed | null {
  const tasks = flattenTasks(plan);
  const task = chooseTask(tasks, taskId);
  if (!task) return null;
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const dependencies = task.dependsOn.map((dependencyId) => ({
    id: dependencyId,
    title: byId.get(dependencyId)?.title ?? null,
  }));
  const dependencyCopy = dependencies.length === 0
    ? "No dependency edges were selected."
    : dependencies
      .map((dependency) => dependency.title ? dependency.title : `${dependency.id} (unresolved)`)
      .join(", ");
  const riskCopy = task.risk ? ` Risk to review: ${task.risk}` : "";
  const brief = [
    `Continue “${task.title}” in the ${task.phaseTitle} phase.`,
    `Owner: ${task.owner}.`,
    `Acceptance: ${task.acceptance}`,
    `Dependencies: ${dependencyCopy}.${riskCopy}`,
  ].join(" ");
  return {
    schema: "omnia.project-handoff-seed.preview.v1",
    taskId: task.id,
    taskTitle: task.title,
    phaseId: task.phaseId,
    phaseTitle: task.phaseTitle,
    status: task.status,
    owner: task.owner,
    artifact: task.artifact,
    acceptance: task.acceptance,
    risk: task.risk,
    dependencies,
    brief,
    boundary: HANDOFF_BOUNDARY,
  };
}

/** A bounded, editable Chat draft, not a provider request or task execution. */
export function buildProjectPlanChatDraft(projectName: string, seed: ProjectHandoffSeed): string {
  const fields = [
    `Project: ${projectName}`,
    `Task: ${seed.taskTitle}`,
    `Phase: ${seed.phaseTitle}`,
    `Owner: ${seed.owner}`,
    `Expected artifact: ${seed.artifact}`,
    `Acceptance: ${seed.acceptance}`,
    `Dependencies: ${seed.dependencies.length
      ? seed.dependencies.map((item) => item.title ?? `${item.id} (unresolved)`).join(", ")
      : "None selected"}`,
    ...(seed.risk ? [`Risk to review: ${seed.risk}`] : []),
  ];
  const body = ["Draft from Project Plan preview — review and edit before sending.", "", ...fields].join("\n");
  return body.length > 8192 ? `${body.slice(0, 8140)}\n[Draft shortened; review the source Plan task.]` : body;
}

export { HANDOFF_BOUNDARY };
