import { describe, expect, it, vi } from "vitest";
import type { GoalSnapshot, GoalSummary, TaskSnapshot, TaskSummary } from "@/lib/desktop";
import { WorkflowController, type WorkflowApi } from "./workflow-controller";
import { goalSnapshot } from "./workflow-test-fixtures";
import { EMPTY_GOAL, EMPTY_TASK } from "./workflow-model";

function summary(snapshot: GoalSnapshot): GoalSummary { return snapshot.goal; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function taskSnapshot(): TaskSnapshot {
  return { task: { id: "task_one", goalId: "goal_one", profileId: "profile_default", projectId: null, conversationId: null, branchId: null, currentRevisionId: "task_revision_one", stateRevisionId: null, status: "in_progress", title: "Verify", description: null, metadataJson: JSON.stringify({ workflowUi: { owner: "qa", files: ["src/a.ts"], input: "Source", output: "Receipt", verification: "Pass", evidence: ["checks.json"], report: "Passed" } }), canonicalPayloadSha256: "b".repeat(64), createdAtMs: 100, updatedAtMs: 101, deletedAtMs: null }, currentRevision: { revisionId: "task_revision_one", taskId: "task_one", revisionNo: 1, payloadJson: "{}", contentSha256: "b".repeat(64), stateRevisionId: null, createdAtMs: 100 }, selectedRevision: null, dependencies: [], executionDisposition: "preview-only", integrity: "valid", replayed: false };
}
function setup(overrides: Partial<WorkflowApi> = {}) {
  const goal = goalSnapshot();
  const api: WorkflowApi = { available: () => true, listGoals: vi.fn(async () => [summary(goal)]), readGoal: vi.fn(async () => goal), createGoal: vi.fn(async (request): Promise<GoalSnapshot> => ({ ...goal, goal: { ...goal.goal, title: request.title, status: "draft" } })), createGoalRevision: vi.fn(async () => goal), updateGoalStatus: vi.fn(async (request) => ({ ...goal, goal: { ...goal.goal, status: request.status } })), readGoalRevision: vi.fn(async () => goal.currentRevision), listTasks: vi.fn(async () => []), readTask: vi.fn(async () => taskSnapshot()), createTask: vi.fn(async () => taskSnapshot()), createTaskRevision: vi.fn(async () => taskSnapshot()), updateTaskStatus: vi.fn(async (request) => { const task = taskSnapshot(); task.task.status = request.status; return task; }), ...overrides };
  const controller = new WorkflowController(api, {});
  return { api, controller, goal };
}

describe("workflow native controller", () => {
  it("refreshes native summaries without dispatching work or implicitly mutating", async () => {
    const { api, controller } = setup();
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", goals: [{ id: "goal_one" }], goal: null });
    expect(api.listGoals).toHaveBeenCalledWith({ includeArchived: true, limit: 256 });
    expect(api.createGoal).not.toHaveBeenCalled();
    expect(api.updateGoalStatus).not.toHaveBeenCalled();
    expect(api.readGoal).not.toHaveBeenCalled();
    await controller.selectGoal("goal_one");
    expect(controller.getSnapshot()).toMatchObject({ goal: { goal: { id: "goal_one" } }, tasks: [], status: "ready" });
  });

  it("makes preview unavailability explicit and never invokes native persistence", async () => {
    const { api, controller } = setup({ available: () => false });
    await controller.refresh();
    expect(controller.getSnapshot().status).toBe("unavailable");
    expect(await controller.createGoal({ ...EMPTY_GOAL, title: "Preview" })).toBe(false);
    expect(api.listGoals).not.toHaveBeenCalled();
    expect(api.createGoal).not.toHaveBeenCalled();
  });

  it("creates a draft with an opaque idempotency key and a native returned snapshot", async () => {
    const { api, controller } = setup();
    expect(await controller.createGoal({ ...EMPTY_GOAL, title: "Explicit draft", criteriaText: "Pass" })).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ goal: { goal: { title: "Explicit draft", status: "draft" } }, goals: [{ title: "Explicit draft" }] });
    expect(api.createGoal).toHaveBeenCalledWith(expect.objectContaining({ title: "Explicit draft", idempotencyKey: expect.stringMatching(/^workflow_/), status: "draft" }));
    expect(api.updateGoalStatus).not.toHaveBeenCalled();
  });

  it("rejects invalid create data locally, leaving native state untouched", async () => {
    const { api, controller } = setup();
    expect(await controller.createGoal(EMPTY_GOAL)).toBe(false);
    expect(controller.getSnapshot().error?.message).toMatch(/title/i);
    expect(api.createGoal).not.toHaveBeenCalled();
    expect(controller.getSnapshot().goals).toEqual([]);
  });

  it("distinguishes denied, missing and general failures from an empty result", async () => {
    const { controller, api } = setup({ listGoals: vi.fn(async () => { throw { code: "permission_denied", message: "No grant", retryable: false }; }) });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ status: "denied", error: { code: "permission_denied", message: "No grant" } });
    api.listGoals = vi.fn(async () => []);
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", goals: [], error: null });
    api.readGoal = vi.fn(async () => { throw { code: "goal_not_found", message: "Deleted" }; });
    await controller.selectGoal("goal_missing");
    expect(controller.getSnapshot()).toMatchObject({ status: "missing", goal: null });
  });

  it("rejects stale scope/list/selection responses and validates returned ownership", async () => {
    const old = deferred<GoalSummary[]>();
    const fresh = goalSnapshot("goal_new", "project_new");
    const { api, controller } = setup({ listGoals: vi.fn(() => old.promise) });
    const first = controller.refresh();
    controller.setScope({ projectId: "project_new" });
    api.listGoals = vi.fn(async () => [summary(fresh)]);
    await controller.refresh();
    old.resolve([summary(goalSnapshot("goal_old"))]);
    await first;
    expect(controller.getSnapshot().goals.map((goal) => goal.id)).toEqual(["goal_new"]);
    expect(api.listGoals).toHaveBeenLastCalledWith({ projectId: "project_new", includeArchived: true, limit: 256 });
    await controller.selectGoal("goal_new");
    expect(controller.getSnapshot().error?.message).toMatch(/scope|identity/i);
    expect(controller.getSnapshot().goal).toBeNull();
  });

  it("keeps a newer goal selection when an older read resolves later", async () => {
    const older = deferred<GoalSnapshot>();
    const newer = goalSnapshot("goal_new");
    const { controller } = setup({ readGoal: vi.fn((request) => request.goalId === "goal_one" ? older.promise : Promise.resolve(newer)) });
    const first = controller.selectGoal("goal_one");
    await controller.selectGoal("goal_new");
    older.resolve(goalSnapshot());
    await first;
    expect(controller.getSnapshot().goal?.goal.id).toBe("goal_new");
  });

  it("invalidates cancelled reads and ignores their late completion", async () => {
    const wait = deferred<GoalSummary[]>();
    const { controller } = setup({ listGoals: vi.fn(() => wait.promise) });
    const read = controller.refresh();
    controller.cancelRead();
    wait.resolve([summary(goalSnapshot())]);
    await read;
    expect(controller.getSnapshot()).toMatchObject({ busy: false, goals: [], notice: expect.stringMatching(/cancel/i) });
  });

  it("serializes mutation intents, retains unknown outcome and requires refresh", async () => {
    const mutation = deferred<GoalSnapshot>();
    const { api, controller } = setup({ createGoal: vi.fn(() => mutation.promise) });
    const first = controller.createGoal({ ...EMPTY_GOAL, title: "One" });
    expect(await controller.createGoal({ ...EMPTY_GOAL, title: "Two" })).toBe(false);
    mutation.reject({ code: "transport_closed", message: "Delivery unknown", acceptance: "unknown", retryable: true });
    await first;
    expect(controller.getSnapshot()).toMatchObject({ mutationUncertain: true, error: { code: "transport_closed" } });
    expect(await controller.createGoal({ ...EMPTY_GOAL, title: "Three" })).toBe(false);
    expect(api.createGoal).toHaveBeenCalledTimes(1);
    await controller.refresh();
    expect(controller.getSnapshot().mutationUncertain).toBe(false);
  });

  it.each([
    { name: "a failure before switching scope", rejectAfterSwitch: false, displayOnly: false },
    { name: "a failure after switching scope", rejectAfterSwitch: true, displayOnly: false },
    { name: "a display-only session change", rejectAfterSwitch: false, displayOnly: true },
  ])("retains the native write fence through $name", async ({ rejectAfterSwitch, displayOnly }) => {
    const pending = deferred<GoalSnapshot>();
    const { api, controller } = setup({ createGoal: vi.fn(() => pending.promise) });
    controller.setScope({ projectId: "project_old", sessionId: "chat_old" });
    const write = controller.createGoal({ ...EMPTY_GOAL, title: "Original intent" });
    if (!rejectAfterSwitch) {
      pending.reject({ code: "transport_closed", message: "Delivery unknown", acceptance: "unknown" });
      await write;
    }
    controller.setScope(displayOnly ? { sessionId: "chat_new", projectId: "project_old" } : { projectId: "project_other" });
    if (rejectAfterSwitch) {
      pending.reject({ code: "transport_closed", message: "Delivery unknown", acceptance: "unknown" });
      await write;
    }
    if (!displayOnly) {
      expect(controller.getSnapshot().mutationUncertain).toBe(false);
      controller.setScope({ projectId: "project_old", sessionId: "chat_returned" });
    }
    expect(controller.getSnapshot().mutationUncertain).toBe(true);
    expect(await controller.createGoal({ ...EMPTY_GOAL, title: "Possible duplicate" })).toBe(false);
    expect(api.createGoal).toHaveBeenCalledTimes(1);
  });

  it("does not reconcile an unknown write by refreshing a different native scope", async () => {
    const { api, controller } = setup({ createGoal: vi.fn(async () => { throw { code: "transport_closed", message: "Delivery unknown", acceptance: "unknown" }; }), listGoals: vi.fn(async () => []) });
    controller.setScope({ projectId: "project_old" });
    await controller.createGoal({ ...EMPTY_GOAL, title: "Original intent" });
    controller.setScope({ projectId: "project_other" });
    await controller.refresh();
    controller.setScope({ projectId: "project_old" });
    expect(controller.getSnapshot().mutationUncertain).toBe(true);
    expect(await controller.createGoal({ ...EMPTY_GOAL, title: "Possible duplicate" })).toBe(false);
    expect(api.createGoal).toHaveBeenCalledTimes(1);
    await controller.refresh();
    expect(controller.getSnapshot().mutationUncertain).toBe(false);
  });

  it("retains an unknown write fence when current-scope reconciliation is truncated", async () => {
    const goals = Array.from({ length: 256 }, (_, index) => summary(goalSnapshot(`goal_${index}`)));
    const { api, controller } = setup({ createGoal: vi.fn(async () => { throw { code: "transport_closed", message: "Delivery unknown", acceptance: "unknown" }; }), listGoals: vi.fn(async () => goals) });
    await controller.createGoal({ ...EMPTY_GOAL, title: "Original intent" });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ goalLimitReached: true, mutationUncertain: true });
    expect(await controller.createGoal({ ...EMPTY_GOAL, title: "Possible duplicate" })).toBe(false);
    expect(api.createGoal).toHaveBeenCalledTimes(1);
  });

  it("retains an unknown write fence when selected-goal task reconciliation fails", async () => {
    const { api, controller } = setup({ updateGoalStatus: vi.fn(async () => { throw { code: "transport_closed", message: "Delivery unknown", acceptance: "unknown" }; }) });
    await controller.selectGoal("goal_one");
    await controller.setGoalStatus("paused");
    api.listTasks = vi.fn(async () => { throw { code: "transport_closed", message: "Task read failed" }; });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ status: "error", mutationUncertain: true });
    expect(await controller.createGoal({ ...EMPTY_GOAL, title: "Possible duplicate" })).toBe(false);
    expect(api.createGoal).not.toHaveBeenCalled();
  });

  it("does not publish late mutation results into a different project", async () => {
    const wait = deferred<GoalSnapshot>();
    const { controller } = setup({ createGoal: vi.fn(() => wait.promise) });
    const create = controller.createGoal({ ...EMPTY_GOAL, title: "Old scope" });
    controller.setScope({ projectId: "project_new" });
    wait.resolve(goalSnapshot());
    await create;
    expect(controller.getSnapshot()).toMatchObject({ scope: { projectId: "project_new" }, goals: [], goal: null });
  });

  it("does not complete a goal from plan text, task completion or report text", async () => {
    const { api, controller } = setup();
    await controller.selectGoal("goal_one");
    expect(await controller.setGoalStatus("completed")).toBe(false);
    expect(api.updateGoalStatus).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error?.message).toMatch(/acceptance|evidence/i);
    expect(await controller.setGoalStatus("paused")).toBe(true);
    expect(api.updateGoalStatus).toHaveBeenCalledWith(expect.objectContaining({ goalId: "goal_one", expectedUpdatedAtMs: 101, status: "paused" }));
  });

  it("loads and revises native tasks under the selected goal without implicit execution", async () => {
    const task = taskSnapshot();
    const { api, controller } = setup({ listTasks: vi.fn(async () => [task.task]) });
    await controller.selectGoal("goal_one");
    await controller.selectTask("task_one");
    expect(controller.getSnapshot().task?.task.id).toBe("task_one");
    expect(await controller.saveTask({ ...EMPTY_TASK, title: "Verify again", owner: "qa", filesText: "src/a.ts", input: "Source", output: "Receipt", verification: "Pass", evidenceText: "checks.json", report: "Passed", reason: "New input" })).toBe(true);
    expect(api.createTaskRevision).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task_one", expectedCurrentRevisionId: "task_revision_one" }));
    expect(api.updateTaskStatus).not.toHaveBeenCalled();
  });

  it("fails closed on truncated task lists and stale task ownership", async () => {
    const tasks = Array.from({ length: 256 }, (_, index) => ({ ...taskSnapshot().task, id: `task_${index}` })) as TaskSummary[];
    const { controller } = setup({ listTasks: vi.fn(async () => tasks), readTask: vi.fn(async () => { const task = taskSnapshot(); task.task.goalId = "goal_other"; return task; }) });
    await controller.selectGoal("goal_one");
    expect(controller.getSnapshot().taskLimitReached).toBe(true);
    await controller.selectTask("task_0");
    expect(controller.getSnapshot().error?.message).toMatch(/scope|identity/i);
    expect(controller.getSnapshot().task).toBeNull();
  });

  it("restores native records through a fresh controller and exposes exact history", async () => {
    const { api, controller } = setup();
    await controller.refresh();
    const reopened = new WorkflowController(api, {});
    await reopened.refresh();
    await reopened.selectGoal("goal_one");
    await reopened.loadGoalRevision("goal_revision_one");
    expect(reopened.getSnapshot().history?.revisionId).toBe("goal_revision_one");
    expect(api.createGoal).not.toHaveBeenCalled();
    expect(api.createGoalRevision).not.toHaveBeenCalled();
  });

  it("does not run refresh or selection concurrently with a native write", async () => {
    const wait = deferred<GoalSnapshot>();
    const { api, controller } = setup({ createGoal: vi.fn(() => wait.promise) });
    const write = controller.createGoal({ ...EMPTY_GOAL, title: "Pending write" });
    await controller.refresh();
    await controller.selectGoal("goal_other");
    expect(api.listGoals).not.toHaveBeenCalled();
    expect(api.readGoal).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ busy: true, mutating: true });
    wait.resolve(goalSnapshot()); await write;
    expect(controller.getSnapshot().goal?.goal.id).toBe("goal_one");
  });

  it("fails closed on an untyped IPC exception after dispatching a write", async () => {
    const { api, controller } = setup({ createGoal: vi.fn(async () => { throw new Error("connection closed"); }) });
    await controller.createGoal({ ...EMPTY_GOAL, title: "Maybe accepted" });
    expect(controller.getSnapshot().mutationUncertain).toBe(true);
    expect(await controller.createGoal({ ...EMPTY_GOAL, title: "Maybe duplicate" })).toBe(false);
    expect(api.createGoal).toHaveBeenCalledTimes(1);
  });

  it("checks newly loaded native task state before allowing goal completion", async () => {
    const goal = goalSnapshot();
    goal.goal.acceptanceCriteriaJson = '[{"text":"Pass","threshold":"All","evidenceType":"receipt","status":"done","evidence":["checks.json"]}]';
    goal.goal.metadataJson = '{"workflowUi":{"reports":[{"summary":"Checked","evidence":["checks.json"],"limitations":"","remainingWork":""}]}}';
    const { api, controller } = setup({ readGoal: vi.fn(async () => goal) });
    await controller.selectGoal("goal_one");
    api.listTasks = vi.fn(async () => [taskSnapshot().task]);
    expect(await controller.setGoalStatus("completed")).toBe(false);
    expect(api.updateGoalStatus).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error?.message).toMatch(/task/i);
  });
});
