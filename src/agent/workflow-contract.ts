export type WorkflowStatus = "planned" | "in_progress" | "done" | "blocked";

export interface AcceptanceCriterion { id: string; label: string; minimum: string; target?: string; verified: boolean; evidence?: string; }
export interface AtomicTask { id: string; title: string; status: WorkflowStatus; ownerRole?: string; dependsOn: string[]; criteria: AcceptanceCriterion[]; notes?: string; }
export interface WorkflowPlan { id: string; goal: string; iteration: number; maxIterations: number; tasks: AtomicTask[]; createdAtMs: number; updatedAtMs: number; }

export function createWorkflowPlan(goal: string, tasks: readonly Omit<AtomicTask, "status">[], maxIterations = 3, now = Date.now()): WorkflowPlan {
  return { id: `plan_${now.toString(36)}`, goal: goal.trim(), iteration: 1, maxIterations: Math.min(10, Math.max(0, Math.round(maxIterations))), tasks: tasks.map((task) => ({ ...task, status: "planned", dependsOn: [...task.dependsOn], criteria: task.criteria.map((criterion) => ({ ...criterion })) })), createdAtMs: now, updatedAtMs: now };
}

export function transitionTask(plan: WorkflowPlan, taskId: string, status: WorkflowStatus, now = Date.now()): WorkflowPlan {
  if (!plan.tasks.some((task) => task.id === taskId)) return plan;
  const tasks = plan.tasks.map((task) => task.id === taskId ? { ...task, status } : task);
  return { ...plan, tasks, updatedAtMs: now };
}

export function verifyCriterion(plan: WorkflowPlan, taskId: string, criterionId: string, evidence: string, now = Date.now()): WorkflowPlan {
  const tasks = plan.tasks.map((task) => task.id !== taskId ? task : { ...task, criteria: task.criteria.map((criterion) => criterion.id === criterionId ? { ...criterion, verified: true, evidence: evidence.trim() } : criterion) } );
  return { ...plan, tasks, updatedAtMs: now };
}

export function workflowCoverage(plan: WorkflowPlan) {
  const criteria = plan.tasks.flatMap((task) => task.criteria);
  const verified = criteria.filter((criterion) => criterion.verified).length;
  const done = plan.tasks.filter((task) => task.status === "done").length;
  return { tasksDone: done, tasksTotal: plan.tasks.length, criteriaVerified: verified, criteriaTotal: criteria.length, percent: criteria.length ? Math.round((verified / criteria.length) * 100) : 100 };
}

export function workflowMarkdown(plan: WorkflowPlan): string {
  const coverage = workflowCoverage(plan);
  const lines = [`# ${plan.goal}`, ``, `Iteration ${plan.iteration}/${plan.maxIterations} · Criteria ${coverage.criteriaVerified}/${coverage.criteriaTotal} (${coverage.percent}%)`, ``];
  for (const task of plan.tasks) { lines.push(`- [${task.status === "done" ? "x" : " "}] ${task.title} (${task.status})`); for (const criterion of task.criteria) lines.push(`  - ${criterion.verified ? "[x]" : "[ ]"} ${criterion.label}${criterion.evidence ? ` — ${criterion.evidence}` : ""}`); }
  return lines.join("\n");
}
