import { desktop, isDesktopRuntime, type GoalRecord, type GoalRevisionRecord, type GoalSnapshot, type GoalSummary, type NativeCommandError, type TaskSnapshot, type TaskStatus, type TaskSummary } from "@/lib/desktop";
import { appendReport, completionBlockers, createGoalRequest, goalRevisionRequest, GOAL_TRANSITIONS, nativeScope, readCriteria, readReports, taskCompletionBlockers, taskRequest, taskRevisionRequest, TASK_TRANSITIONS, updateCriterion, type Criterion, type GoalDraft, type ReportDraft, type TaskDraft, type WorkflowScope } from "./workflow-model";

type NativeMethods = Pick<typeof desktop, "listGoals" | "readGoal" | "createGoal" | "createGoalRevision" | "updateGoalStatus" | "readGoalRevision" | "listTasks" | "readTask" | "createTask" | "createTaskRevision" | "updateTaskStatus">;
export interface WorkflowApi extends NativeMethods { available: () => boolean; }
export type WorkflowStatus = "idle" | "loading" | "ready" | "unavailable" | "denied" | "missing" | "error";
export interface WorkflowState {
  scope: WorkflowScope; status: WorkflowStatus; busy: boolean; mutating: boolean;
  error: { code: string; message: string } | null; notice: string;
  goals: GoalSummary[]; goal: GoalSnapshot | null; selectedGoalId: string | null;
  tasks: TaskSummary[]; task: TaskSnapshot | null; selectedTaskId: string | null;
  history: GoalRevisionRecord | null; goalLimitReached: boolean; taskLimitReached: boolean;
  mutationUncertain: boolean;
}
function initial(scope: WorkflowScope, available: boolean): WorkflowState {
  return { scope: { ...scope }, status: available ? "idle" : "unavailable", busy: false, mutating: false, error: null, notice: "", goals: [], goal: null, selectedGoalId: null, tasks: [], task: null, selectedTaskId: null, history: null, goalLimitReached: false, taskLimitReached: false, mutationUncertain: false };
}
function failure(error: unknown): { code: string; message: string } {
  const candidate = error as Partial<NativeCommandError> | null;
  return { code: typeof candidate?.code === "string" ? candidate.code : "workflow_error", message: typeof candidate?.message === "string" ? candidate.message.slice(0, 2_000) : "The native workflow operation failed." };
}
function failureStatus(error: { code: string }): WorkflowStatus {
  if (/denied|forbidden|permission/.test(error.code)) return "denied";
  if (/not_found|missing/.test(error.code)) return "missing";
  if (/unavailable|not_initialized|unsupported/.test(error.code)) return "unavailable";
  return "error";
}
function operationKey(): string { return `workflow_${crypto.randomUUID()}`; }
// Harness session IDs are display context. Reordering props or changing chat
// sessions must not give an unresolved native write a new identity.
function nativeScopeKey(scope: WorkflowScope): string { return JSON.stringify([scope.projectId ?? null, scope.conversationId ?? null]); }
const UNKNOWN_WRITE_NOTICE = "A previous native write in this scope has an unknown outcome. Refresh and inspect native records before another write.";
function hasScope(record: { projectId: string | null; conversationId: string | null }, scope: WorkflowScope): boolean {
  return (scope.projectId === undefined || record.projectId === scope.projectId) && (scope.conversationId === undefined || record.conversationId === scope.conversationId);
}
function verifyGoal(value: GoalSnapshot, scope: WorkflowScope, expectedId?: string): GoalSnapshot {
  if (!value || value.integrity !== "valid" || value.executionDisposition !== "preview-only" || !value.goal || !value.currentRevision || !value.goal.id.startsWith("goal_") || (expectedId && value.goal.id !== expectedId) || !hasScope(value.goal, scope) || value.currentRevision.goalId !== value.goal.id || value.currentRevision.revisionId !== value.goal.currentRevisionId || value.currentRevision.contentSha256 !== value.goal.canonicalPayloadSha256) throw new Error("Native goal scope, identity or revision integrity does not match the requested record.");
  readCriteria(value); readReports(value);
  return value;
}
function verifyTask(value: TaskSnapshot, goal: GoalSnapshot, expectedId?: string): TaskSnapshot {
  if (!value || value.integrity !== "valid" || value.executionDisposition !== "preview-only" || !value.task || !value.currentRevision || (expectedId && value.task.id !== expectedId) || value.task.goalId !== goal.goal.id || value.task.projectId !== goal.goal.projectId || value.task.conversationId !== goal.goal.conversationId || value.currentRevision.taskId !== value.task.id || value.currentRevision.revisionId !== value.task.currentRevisionId || value.currentRevision.contentSha256 !== value.task.canonicalPayloadSha256) throw new Error("Native task scope, identity or revision integrity does not match the selected goal.");
  return value;
}

/** Native persistence only. None of these operations dispatch agent/model work. */
export function createNativeWorkflowApi(): WorkflowApi {
  const ready = async <T>(run: () => Promise<T>): Promise<T> => { await desktop.initializeCore(import.meta.env.PACKAGE_VERSION ?? "0.1.0"); return run(); };
  return { available: isDesktopRuntime, listGoals: (r) => ready(() => desktop.listGoals(r)), readGoal: (r) => ready(() => desktop.readGoal(r)), createGoal: (r) => ready(() => desktop.createGoal(r)), createGoalRevision: (r) => ready(() => desktop.createGoalRevision(r)), updateGoalStatus: (r) => ready(() => desktop.updateGoalStatus(r)), readGoalRevision: (r) => ready(() => desktop.readGoalRevision(r)), listTasks: (r) => ready(() => desktop.listTasks(r)), readTask: (r) => ready(() => desktop.readTask(r)), createTask: (r) => ready(() => desktop.createTask(r)), createTaskRevision: (r) => ready(() => desktop.createTaskRevision(r)), updateTaskStatus: (r) => ready(() => desktop.updateTaskStatus(r)) };
}

export class WorkflowController {
  private state: WorkflowState;
  private readonly subscribers = new Set<() => void>();
  private epoch = 0;
  private listSequence = 0;
  private goalSequence = 0;
  private taskSequence = 0;
  private historySequence = 0;
  private mutationPending = false;
  private nativeWriteStarted = false;
  // Outcome ownership outlives the current display epoch and its snapshots.
  private readonly uncertainScopes = new Set<string>();
  private disposed = false;
  constructor(private readonly api: WorkflowApi, scope: WorkflowScope = {}) { this.state = initial(scope, api.available()); }
  getSnapshot = (): WorkflowState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.subscribers.add(listener); return () => { this.subscribers.delete(listener); }; };
  private patch(change: Partial<WorkflowState>) { if (this.disposed) return; this.state = { ...this.state, ...change }; this.subscribers.forEach((listener) => listener()); }
  private current(epoch: number): boolean { return epoch === this.epoch && !this.disposed; }
  private error(error: unknown) { const detail = failure(error); this.patch({ error: detail, status: failureStatus(detail) }); }
  private available(): boolean {
    if (this.api.available()) return true;
    this.patch({ status: "unavailable", error: { code: "native_unavailable", message: "Native workflow requires the Tauri desktop runtime. Browser preview does not persist native planning records." } });
    return false;
  }
  setScope(scope: WorkflowScope): void {
    if (JSON.stringify(this.state.scope) === JSON.stringify(scope)) return;
    this.epoch += 1;
    const mutationUncertain = this.uncertainScopes.has(nativeScopeKey(scope));
    this.patch({ ...initial(scope, this.api.available()), busy: this.mutationPending, mutating: this.mutationPending, mutationUncertain, notice: mutationUncertain ? UNKNOWN_WRITE_NOTICE : "" });
  }
  dispose(): void { this.epoch += 1; this.disposed = true; this.subscribers.clear(); }
  cancelRead(): void {
    this.listSequence += 1; this.goalSequence += 1; this.taskSequence += 1; this.historySequence += 1;
    this.patch({ busy: this.mutationPending, status: this.api.available() ? "ready" : "unavailable", notice: this.mutationPending ? "A native write is still pending; it cannot be cancelled by hiding its result." : "Read cancelled. Late results will be ignored; the native read may still finish." });
  }
  clearTask(): void { this.taskSequence += 1; this.patch({ task: null, selectedTaskId: null }); }
  async refresh(): Promise<void> {
    if (!this.available()) return;
    if (this.mutationPending) {
      this.error(new Error("A native write is in progress; refresh after it settles."));
      return;
    }
    const epoch = this.epoch; const sequence = ++this.listSequence; const scopeKey = nativeScopeKey(this.state.scope);
    this.goalSequence += 1; this.taskSequence += 1;
    this.patch({ busy: true, status: "loading", error: null, notice: "" });
    try {
      const scope = nativeScope(this.state.scope);
      const goals = await this.api.listGoals({ ...scope, includeArchived: true, limit: 256 });
      if (!this.current(epoch) || sequence !== this.listSequence) return;
      if (!Array.isArray(goals) || goals.length > 256 || goals.some((goal) => !goal.id?.startsWith("goal_") || !hasScope(goal, this.state.scope)) || new Set(goals.map((goal) => goal.id)).size !== goals.length) throw new Error("Native goal list has invalid identities or scope.");
      const keep = goals.some((goal) => goal.id === this.state.selectedGoalId);
      this.patch({ goals, goalLimitReached: goals.length === 256, status: "ready", ...(keep ? {} : { goal: null, selectedGoalId: null, task: null, selectedTaskId: null, tasks: [], history: null, taskLimitReached: false }) });
      if (keep && this.state.selectedGoalId) await this.selectGoal(this.state.selectedGoalId);
      if (!this.current(epoch) || sequence !== this.listSequence) return;
      // An unrelated, failed, cancelled or truncated read cannot reconcile the
      // original write. Selected-goal/task reads must also finish successfully.
      if (this.state.status === "ready" && !this.state.goalLimitReached && !this.state.taskLimitReached) {
        this.uncertainScopes.delete(scopeKey);
        this.patch({ mutationUncertain: false });
      } else if (this.uncertainScopes.has(scopeKey)) this.patch({ notice: UNKNOWN_WRITE_NOTICE });
    } catch (error) { if (this.current(epoch) && sequence === this.listSequence) this.error(error); }
    finally { if (this.current(epoch) && sequence === this.listSequence) this.patch({ busy: this.mutationPending }); }
  }
  async selectGoal(goalId: string): Promise<void> {
    if (!this.available()) return;
    if (this.mutationPending) {
      this.error(new Error("A native write is in progress; select a goal after it settles."));
      return;
    }
    const epoch = this.epoch; const sequence = ++this.goalSequence;
    this.taskSequence += 1; this.historySequence += 1;
    this.patch({ selectedGoalId: goalId, goal: null, task: null, selectedTaskId: null, tasks: [], taskLimitReached: false, history: null, busy: true, status: "loading", error: null, notice: "" });
    try {
      const goal = verifyGoal(await this.api.readGoal({ goalId }), this.state.scope, goalId);
      if (!this.current(epoch) || sequence !== this.goalSequence) return;
      // Do not expose a ready completion action until the full task read succeeds.
      const tasks = await this.api.listTasks({ goalId, includeArchived: true, limit: 256 });
      if (!this.current(epoch) || sequence !== this.goalSequence) return;
      this.verifyTasks(tasks, goal);
      this.patch({ goal, tasks, taskLimitReached: tasks.length === 256, status: "ready" });
    } catch (error) { if (this.current(epoch) && sequence === this.goalSequence) this.error(error); }
    finally { if (this.current(epoch) && sequence === this.goalSequence) this.patch({ busy: this.mutationPending }); }
  }
  private verifyTasks(tasks: TaskSummary[], goal: GoalSnapshot): void {
    if (!Array.isArray(tasks) || tasks.length > 256 || tasks.some((task) => !task.id?.startsWith("task_") || task.goalId !== goal.goal.id || task.projectId !== goal.goal.projectId || task.conversationId !== goal.goal.conversationId) || new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error("Native task list has invalid identities or scope.");
  }
  async selectTask(taskId: string): Promise<void> {
    if (!this.available() || !this.state.goal || this.mutationPending) return;
    const epoch = this.epoch; const sequence = ++this.taskSequence; const goal = this.state.goal;
    this.patch({ selectedTaskId: taskId, task: null, busy: true, error: null });
    try {
      const task = verifyTask(await this.api.readTask({ taskId }), goal, taskId);
      if (this.current(epoch) && sequence === this.taskSequence && this.state.goal?.goal.id === goal.goal.id) this.patch({ task, status: "ready" });
    } catch (error) { if (this.current(epoch) && sequence === this.taskSequence) this.error(error); }
    finally { if (this.current(epoch) && sequence === this.taskSequence) this.patch({ busy: this.mutationPending }); }
  }
  async loadGoalRevision(revisionId: string): Promise<void> {
    if (!this.available() || !this.state.goal || this.mutationPending) return;
    const epoch = this.epoch; const sequence = ++this.historySequence; const goalId = this.state.goal.goal.id;
    this.patch({ busy: true, error: null, history: null });
    try {
      if (!revisionId.trim()) throw new Error("Enter a goal revision ID.");
      const history = await this.api.readGoalRevision({ goalId, revisionId });
      if (!this.current(epoch) || sequence !== this.historySequence || this.state.goal?.goal.id !== goalId) return;
      if (history.goalId !== goalId || history.revisionId !== revisionId) throw new Error("Historical revision identity does not match the selected goal.");
      this.patch({ history });
    } catch (error) { if (this.current(epoch) && sequence === this.historySequence) this.error(error); }
    finally { if (this.current(epoch) && sequence === this.historySequence) this.patch({ busy: this.mutationPending }); }
  }
  private async mutate(run: (key: string) => Promise<void>): Promise<boolean> {
    if (!this.available()) return false;
    if (this.mutationPending || this.state.busy) { this.error(new Error("Wait for the current native operation to finish.")); return false; }
    if (this.state.mutationUncertain) { this.error(new Error("A previous write has an unknown outcome. Refresh and inspect native records before another write.")); return false; }
    const epoch = this.epoch; const scopeKey = nativeScopeKey(this.state.scope); this.mutationPending = true; this.nativeWriteStarted = false;
    this.patch({ busy: true, mutating: true, error: null, notice: "" });
    try {
      await run(operationKey());
      if (!this.current(epoch)) return false;
      this.patch({ status: "ready", notice: "Native planning record saved. Work was not dispatched and evidence contents are not verified by this panel." });
      return true;
    } catch (error) {
      const details = error as Partial<NativeCommandError>;
      // Native acceptance is independent of the display epoch. Record a late
      // unknown outcome for the originating scope even after the UI moved on.
      const unknown = this.nativeWriteStarted && (details?.acceptance === "unknown" || details?.acceptance === "true" || /transport|ipc|channel|timeout/.test(details?.code ?? "") || !details?.code);
      if (unknown) this.uncertainScopes.add(scopeKey);
      if (this.current(epoch)) {
        // Validation and explicit deny/not-found are known failures. Native IPC
        // transport errors can otherwise arrive after an accepted mutation.
        this.patch({ mutationUncertain: this.uncertainScopes.has(scopeKey) }); this.error(error);
      }
      return false;
    } finally {
      this.mutationPending = false;
      const mutationUncertain = this.uncertainScopes.has(nativeScopeKey(this.state.scope));
      this.patch({ busy: false, mutating: false, mutationUncertain, ...(mutationUncertain && !this.state.error ? { notice: UNKNOWN_WRITE_NOTICE } : {}) });
    }
  }
  private acceptGoal(goal: GoalSnapshot, scope: WorkflowScope, expectedId?: string): void {
    verifyGoal(goal, scope, expectedId);
    const oldIndex = this.state.goals.findIndex((entry) => entry.id === goal.goal.id);
    const goals = [...this.state.goals];
    if (oldIndex >= 0) goals[oldIndex] = goal.goal; else goals.unshift(goal.goal);
    this.patch({ goal, selectedGoalId: goal.goal.id, goals: goals.slice(0, 256), history: null });
  }
  private write<T>(operation: Promise<T>): Promise<T> { this.nativeWriteStarted = true; return operation; }
  createGoal(draft: GoalDraft): Promise<boolean> {
    const epoch = this.epoch; const scope = { ...this.state.scope };
    return this.mutate(async (key) => {
      const goal = await this.write(this.api.createGoal(createGoalRequest(scope, draft, key)));
      if (!this.current(epoch)) return;
      this.goalSequence += 1; this.taskSequence += 1;
      this.acceptGoal(goal, scope); this.patch({ tasks: [], task: null, selectedTaskId: null, taskLimitReached: false });
    });
  }
  private reviseGoal(build: (goal: GoalSnapshot, key: string) => Parameters<WorkflowApi["createGoalRevision"]>[0]): Promise<boolean> {
    const epoch = this.epoch; const goal = this.state.goal; const scope = { ...this.state.scope }; const selected = this.state.selectedGoalId;
    return this.mutate(async (key) => {
      if (!goal) throw new Error("Load a native goal before editing.");
      const result = await this.write(this.api.createGoalRevision(build(goal, key)));
      if (!this.current(epoch) || selected !== this.state.selectedGoalId) return;
      this.acceptGoal(result, scope, goal.goal.id);
    });
  }
  saveGoal(draft: GoalDraft): Promise<boolean> { return this.reviseGoal((goal, key) => goalRevisionRequest(goal, draft, key)); }
  saveCriterion(index: number | null, criterion: Criterion): Promise<boolean> { return this.reviseGoal((goal, key) => updateCriterion(goal, index, criterion, key)); }
  addReport(draft: ReportDraft): Promise<boolean> { return this.reviseGoal((goal, key) => appendReport(goal, draft, key)); }
  setGoalStatus(status: GoalRecord["status"]): Promise<boolean> {
    const epoch = this.epoch; const goal = this.state.goal; const scope = { ...this.state.scope }; const selected = this.state.selectedGoalId;
    return this.mutate(async (key) => {
      if (!goal) throw new Error("Load a native goal before recording status.");
      if (!GOAL_TRANSITIONS[goal.goal.status]?.includes(status)) throw new Error("This goal status transition is not supported.");
      if (status === "completed") {
        const tasks = await this.api.listTasks({ goalId: goal.goal.id, includeArchived: true, limit: 256 });
        this.verifyTasks(tasks, goal);
        if (!this.current(epoch) || selected !== this.state.selectedGoalId) return;
        this.patch({ tasks, taskLimitReached: tasks.length === 256 });
        const blockers = completionBlockers(goal, tasks, tasks.length === 256);
        if (blockers.length) throw new Error(blockers.join(" "));
        // Snapshot every completed task, in bounded batches, before recording a
        // user declaration. Native still has no transactional all-task gate.
        for (let offset = 0; offset < tasks.length; offset += 8) {
          const snapshots = await Promise.all(tasks.slice(offset, offset + 8).map((task) => this.api.readTask({ taskId: task.id })));
          for (let index = 0; index < snapshots.length; index += 1) {
            const item = verifyTask(snapshots[index]!, goal, tasks[offset + index]!.id);
            if (item.task.status !== "completed") throw new Error("A native task changed before goal completion. Refresh and inspect remaining work.");
            const taskBlockers = taskCompletionBlockers(item);
            if (taskBlockers.length) throw new Error(taskBlockers.join(" "));
          }
        }
        if (!this.current(epoch) || selected !== this.state.selectedGoalId) return;
      }
      const result = await this.write(this.api.updateGoalStatus({ goalId: goal.goal.id, status, expectedUpdatedAtMs: goal.goal.updatedAtMs, idempotencyKey: key }));
      if (this.current(epoch) && selected === this.state.selectedGoalId) this.acceptGoal(result, scope, goal.goal.id);
    });
  }
  private mutateTask(draft: TaskDraft | null, creating: boolean, status?: TaskStatus): Promise<boolean> {
    const epoch = this.epoch; const goal = this.state.goal; const task = this.state.task; const selected = this.state.selectedGoalId; const taskSelected = this.state.selectedTaskId;
    return this.mutate(async (key) => {
      if (!goal) throw new Error("Load a native goal before recording a task.");
      let result: TaskSnapshot;
      if (creating && draft) result = await this.write(this.api.createTask(taskRequest(goal, draft, key)));
      else {
        if (!task) throw new Error("Load the native task before editing.");
        if (status) {
          if (!TASK_TRANSITIONS[task.task.status]?.includes(status)) throw new Error("This task status transition is not supported.");
          if (status === "completed") { const blockers = taskCompletionBlockers(task); if (blockers.length) throw new Error(blockers.join(" ")); }
          result = await this.write(this.api.updateTaskStatus({ taskId: task.task.id, status, expectedUpdatedAtMs: task.task.updatedAtMs, idempotencyKey: key }));
        } else if (draft) result = await this.write(this.api.createTaskRevision(taskRevisionRequest(task, draft, key)));
        else throw new Error("Task edit data is required.");
      }
      if (!this.current(epoch) || selected !== this.state.selectedGoalId || (!creating && taskSelected !== this.state.selectedTaskId)) return;
      verifyTask(result, goal, creating ? undefined : task!.task.id);
      const index = this.state.tasks.findIndex((entry) => entry.id === result.task.id); const tasks = [...this.state.tasks];
      if (index >= 0) tasks[index] = result.task; else tasks.push(result.task);
      this.patch({ task: result, selectedTaskId: result.task.id, tasks: tasks.slice(0, 256), taskLimitReached: tasks.length >= 256 });
    });
  }
  createTask(draft: TaskDraft): Promise<boolean> { return this.mutateTask(draft, true); }
  saveTask(draft: TaskDraft): Promise<boolean> { return this.mutateTask(draft, false); }
  setTaskStatus(status: TaskStatus): Promise<boolean> { return this.mutateTask(null, false, status); }
}
