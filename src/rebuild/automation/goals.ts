import { AutomationDomainError, clone, evidenceList, expectedRevision, identifier, journalCapacity, json, list, nonNegativeInteger, object, readReplay, text, uniqueIds, verifyReplay } from "./common";

export interface GoalTaskSpec { id: string; owner: string; files: string[]; input: string; output: string; verification: string; }
export interface GoalPlanTask extends GoalTaskSpec { status: "pending" | "complete"; evidence: string[]; }
export interface GoalSpec { id: string; objective: string; plan: GoalTaskSpec[]; }
export type GoalStatus = "active" | "completed" | "cancelled";
export type GoalReportKind = "partial" | "final" | "cancelled";
export interface GoalReportInput { id: string; goalId: string; kind: "partial" | "final"; summary: string; evidence: string[]; childReportIds?: string[]; }
export interface GoalReport { id: string; goalId: string; kind: GoalReportKind; summary: string; evidence: string[]; childReportIds: string[]; createdAtRevision: number; }
export interface GoalRecord { id: string; objective: string; parentId: string | null; status: GoalStatus; plan: GoalPlanTask[]; reports: GoalReport[]; childIds: string[]; }
export interface GoalSnapshot { schemaVersion: 1; revision: number; goals: GoalRecord[]; reports: GoalReport[]; }

type GoalCommand =
  | { type: "add_child"; parentId: string; spec: GoalSpec; expectedRevision: number }
  | { type: "complete_task"; goalId: string; taskId: string; evidence: string[]; expectedRevision: number }
  | { type: "report"; report: GoalReportInput; expectedRevision: number }
  | { type: "cancel"; goalId: string; reason: string; expectedRevision: number };

function parseSpec(value: unknown): GoalSpec {
  const spec = object(value, ["id", "objective", "plan"], "goal spec");
  const plan = list(spec.plan, "goal plan", 128, (entry): GoalTaskSpec => {
    const task = object(entry, ["id", "owner", "files", "input", "output", "verification"], "plan task");
    const files = list(task.files, "task files", 128, (file) => text(file, "task file", 1_024), 1);
    uniqueIds(files, "task file");
    return { id: identifier(task.id, "task id"), owner: text(task.owner, "task owner", 256), files, input: text(task.input, "task input", 8_192, true), output: text(task.output, "task output", 8_192, true), verification: text(task.verification, "task verification", 8_192, true) };
  }, 1);
  uniqueIds(plan.map((task) => task.id), "task");
  return { id: identifier(spec.id, "goal id"), objective: text(spec.objective, "goal objective", 16_384, true), plan };
}

function goalFromSpec(spec: GoalSpec, parentId: string | null): GoalRecord {
  return { id: spec.id, objective: spec.objective, parentId, status: "active", plan: spec.plan.map((task) => ({ ...clone(task), status: "pending", evidence: [] })), reports: [], childIds: [] };
}

/** In-memory domain ledger. Persist serialized data through an authorized native store separately. */
export class GoalLedger {
  private revision = 0;
  private readonly initial: GoalSpec;
  private readonly goals = new Map<string, GoalRecord>();
  private readonly events: GoalCommand[] = [];
  private journalBytes: number;

  constructor(spec: GoalSpec) {
    this.initial = parseSpec(spec);
    this.journalBytes = journalCapacity(0, this.initial);
    this.goals.set(this.initial.id, goalFromSpec(this.initial, null));
  }

  private goal(id: string, active = true): GoalRecord {
    const goal = this.goals.get(identifier(id, "goal id"));
    if (!goal) throw new AutomationDomainError("unknown_goal", `Unknown goal ${id}`);
    if (active && goal.status !== "active") throw new AutomationDomainError("terminal", `Goal ${id} is terminal`);
    return goal;
  }

  private commit(command: GoalCommand): number {
    expectedRevision(this.revision, command.expectedRevision);
    if (this.events.length >= 4_096) throw new AutomationDomainError("capacity", "Goal journal capacity reached");
    this.journalBytes = journalCapacity(this.journalBytes, command);
    this.events.push(clone(command));
    this.revision += 1;
    return this.revision;
  }

  addChild(parentId: string, input: GoalSpec, expected: number): GoalRecord {
    expectedRevision(this.revision, expected);
    const parent = this.goal(parentId);
    const spec = parseSpec(input);
    if (this.goals.has(spec.id)) throw new AutomationDomainError("duplicate_id", `duplicate goal ${spec.id}`);
    if (this.goals.size >= 128) throw new AutomationDomainError("capacity", "Goal count capacity reached");
    this.commit({ type: "add_child", parentId: parent.id, spec, expectedRevision: expected });
    const child = goalFromSpec(spec, parent.id);
    this.goals.set(child.id, child); parent.childIds.push(child.id);
    return clone(child);
  }

  completeTask(goalId: string, taskId: string, inputEvidence: string[], expected: number): GoalSnapshot {
    expectedRevision(this.revision, expected);
    const goal = this.goal(goalId);
    const task = goal.plan.find((entry) => entry.id === identifier(taskId, "task id"));
    if (!task) throw new AutomationDomainError("unknown_task", `Unknown task ${taskId}`);
    if (task.status === "complete") throw new AutomationDomainError("already_complete", `Task ${taskId} is already complete`);
    const evidence = evidenceList(inputEvidence);
    this.commit({ type: "complete_task", goalId: goal.id, taskId: task.id, evidence, expectedRevision: expected });
    task.status = "complete"; task.evidence = evidence;
    return this.snapshot();
  }

  report(input: GoalReportInput, expected: number): GoalReport {
    expectedRevision(this.revision, expected);
    const value = object(input, ["id", "goalId", "kind", "summary", "evidence", "childReportIds"], "goal report");
    const id = identifier(value.id, "report id");
    const goal = this.goal(identifier(value.goalId, "report goal id"));
    if (this.allReports().some((report) => report.id === id) || id.startsWith("cancelled:")) throw new AutomationDomainError("duplicate_id", "duplicate or reserved report id");
    if (value.kind !== "partial" && value.kind !== "final") throw new AutomationDomainError("invalid_input", "Report kind must be partial or final");
    if (this.allReports().length >= 1_024) throw new AutomationDomainError("capacity", "Report count capacity reached");
    const summary = text(value.summary, "report summary", 32_768, true);
    const evidence = evidenceList(value.evidence);
    const childReports = goal.childIds.flatMap((childId) => this.goal(childId, false).reports.filter((report) => report.kind === "final"));
    const childReportIds = value.childReportIds === undefined ? childReports.map((report) => report.id) : list(value.childReportIds, "child report ids", 128, (entry) => identifier(entry, "child report id"));
    uniqueIds(childReportIds, "child report");
    if (childReportIds.some((childId) => !childReports.some((report) => report.id === childId))) throw new AutomationDomainError("scope_denied", "Report cites an unrelated child report");
    if (value.kind === "final") {
      if (goal.plan.some((task) => task.status !== "complete") || goal.childIds.some((childId) => this.goal(childId, false).status !== "completed")) throw new AutomationDomainError("incomplete", "Final report requires every task and child goal to be complete");
      if (childReports.some((report) => !childReportIds.includes(report.id))) throw new AutomationDomainError("incomplete", "Final report must cite every child final report");
    }
    const reportInput: GoalReportInput = { id, goalId: goal.id, kind: value.kind, summary, evidence, childReportIds };
    const createdAtRevision = this.commit({ type: "report", report: reportInput, expectedRevision: expected });
    const result: GoalReport = { ...reportInput, childReportIds, createdAtRevision };
    goal.reports.push(result);
    if (result.kind === "final") goal.status = "completed";
    return clone(result);
  }

  cancel(goalId: string, inputReason: string, expected: number): GoalSnapshot {
    expectedRevision(this.revision, expected);
    const root = this.goal(goalId);
    const reason = text(inputReason, "cancellation reason", 4_096, true);
    const revision = this.commit({ type: "cancel", goalId: root.id, reason, expectedRevision: expected });
    const visit = (goal: GoalRecord): void => {
      if (goal.status !== "active") return;
      goal.status = "cancelled";
      goal.reports.push({ id: `cancelled:${goal.id}:${revision}`, goalId: goal.id, kind: "cancelled", summary: reason, evidence: [`goal:${goal.id}`], childReportIds: [], createdAtRevision: revision });
      goal.childIds.forEach((childId) => visit(this.goal(childId, false)));
    };
    visit(root);
    return this.snapshot();
  }

  private allReports(): GoalReport[] { return [...this.goals.values()].flatMap((goal) => goal.reports); }
  snapshot(): GoalSnapshot { return clone({ schemaVersion: 1, revision: this.revision, goals: [...this.goals.values()], reports: this.allReports() }); }
  serialize(): string { return json({ schemaVersion: 1, kind: "goals", initial: this.initial, events: this.events, state: this.snapshot() }); }

  static restore(serialized: string): GoalLedger {
    const saved = readReplay(serialized, "goals");
    const ledger = new GoalLedger(parseSpec(saved.initial));
    for (const entry of saved.events) {
      const event = object(entry, ["type", "parentId", "spec", "goalId", "taskId", "evidence", "report", "reason", "expectedRevision"], "goal command");
      const expected = nonNegativeInteger(event.expectedRevision, "expectedRevision");
      switch (event.type) {
        case "add_child": object(event, ["type", "parentId", "spec", "expectedRevision"], "add child command"); ledger.addChild(identifier(event.parentId, "parent id"), parseSpec(event.spec), expected); break;
        case "complete_task": object(event, ["type", "goalId", "taskId", "evidence", "expectedRevision"], "complete task command"); ledger.completeTask(identifier(event.goalId, "goal id"), identifier(event.taskId, "task id"), evidenceList(event.evidence), expected); break;
        case "report": object(event, ["type", "report", "expectedRevision"], "report command"); ledger.report(event.report as GoalReportInput, expected); break;
        case "cancel": object(event, ["type", "goalId", "reason", "expectedRevision"], "cancel command"); ledger.cancel(identifier(event.goalId, "goal id"), text(event.reason, "reason", 4_096, true), expected); break;
        default: throw new AutomationDomainError("invalid_replay", "Unknown goal replay command");
      }
    }
    verifyReplay(ledger.snapshot(), saved.state);
    return ledger;
  }
}
