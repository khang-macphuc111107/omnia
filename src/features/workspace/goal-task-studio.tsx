import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, Calendar, CheckCircle2, CircleDot, Clipboard, Clock3, Download, Flag, GitBranch, LayoutGrid, List, ListTodo, Plus, Redo2, RotateCcw, Search, Sparkles, Undo2, Upload } from "lucide-react";

import { GoalOrchestrationRail } from "./goal-orchestration-rail";

type TaskStatus = "planned" | "active" | "done";
type GoalStatus = "planned" | "active" | "paused" | "done";
type Filter = "all" | TaskStatus;
type TaskPriority = "low" | "medium" | "high";
type PriorityFilter = "all" | TaskPriority;
type DashboardView = "list" | "board";
type ExportFormat = "json" | "markdown";
type Task = { id: string; title: string; status: TaskStatus; dependency?: string; owner: string; priority: TaskPriority; dueDate?: string };
type Goal = { id: string; title: string; outcome: string; status: GoalStatus; tasks: Task[] };
type GoalQueueEntry = { goal: Goal; task: Task; state: "ready" | "active" | "blocked"; blockerTitle?: string };
type GoalDetailDraft = { title: string; outcome: string };
type GoalTaskStudioSessionDraft = {
  selectedGoalId: string;
  goals: Goal[];
  goalDetails: Record<string, GoalDetailDraft>;
  filter: Filter;
  priorityFilter: PriorityFilter;
  taskSearch: string;
  dashboardView: DashboardView;
  taskTitle: string;
  taskOwner: string;
  taskDependency: string;
  taskPriority: TaskPriority;
  taskDueDate: string;
  goalTitle: string;
  goalOutcome: string;
  exportFormat: ExportFormat;
};
type LoadedGoalTaskStudioSession = { draft: GoalTaskStudioSessionDraft; restored: boolean };

const MAX_IMPORT_BYTES = 512 * 1024;
const GOAL_STUDIO_SESSION_SCHEMA = "omnia.goal-task.studio-session.v1";
const taskStatuses: TaskStatus[] = ["planned", "active", "done"];
const goalStatuses: GoalStatus[] = ["planned", "active", "paused", "done"];
const taskPriorities: TaskPriority[] = ["low", "medium", "high"];

export function parseGoalTaskPreview(input: string): { selectedGoalId: string; goals: Goal[] } {
  if (new TextEncoder().encode(input).byteLength > MAX_IMPORT_BYTES) throw new Error("Goal preview exceeds the 512 KB import limit.");
  let candidate: unknown;
  try { candidate = JSON.parse(input); } catch { throw new Error("Goal preview JSON is invalid."); }
  if (!candidate || typeof candidate !== "object") throw new Error("Goal preview must be a JSON object.");
  const payload = candidate as { schema?: unknown; scope?: unknown; selectedGoalId?: unknown; goals?: unknown };
  if (payload.schema !== "omnia.goal-task.preview.v1" || payload.scope !== "renderer-session") throw new Error("Unsupported goal preview schema or scope.");
  if (!Array.isArray(payload.goals) || payload.goals.length > 100) throw new Error("Goal preview must contain up to 100 goals.");
  const goalIds = new Set<string>();
  const goals = payload.goals.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Goal preview contains an invalid goal.");
    const source = value as { id?: unknown; title?: unknown; outcome?: unknown; status?: unknown; tasks?: unknown };
    if (typeof source.id !== "string" || !source.id.trim() || goalIds.has(source.id)) throw new Error("Goal preview contains a duplicate or invalid goal id.");
    if (typeof source.title !== "string" || !source.title.trim() || source.title.length > 500) throw new Error("Goal preview contains an invalid goal title.");
    if (typeof source.outcome !== "string" || source.outcome.length > 4_000) throw new Error("Goal preview contains an invalid goal outcome.");
    if (typeof source.status !== "string" || !goalStatuses.includes(source.status as GoalStatus)) throw new Error("Goal preview contains an invalid goal status.");
    if (!Array.isArray(source.tasks) || source.tasks.length > 500) throw new Error("Goal preview contains an invalid task list.");
    goalIds.add(source.id);
    const taskIds = new Set<string>();
    const tasks = source.tasks.map((taskValue) => {
      if (!taskValue || typeof taskValue !== "object") throw new Error("Goal preview contains an invalid task.");
      const task = taskValue as { id?: unknown; title?: unknown; status?: unknown; dependency?: unknown; owner?: unknown; priority?: unknown; dueDate?: unknown };
      if (typeof task.id !== "string" || !task.id.trim() || taskIds.has(task.id)) throw new Error("Goal preview contains a duplicate or invalid task id.");
      if (typeof task.title !== "string" || !task.title.trim() || task.title.length > 500) throw new Error("Goal preview contains an invalid task title.");
      if (typeof task.status !== "string" || !taskStatuses.includes(task.status as TaskStatus)) throw new Error("Goal preview contains an invalid task status.");
      if (typeof task.owner !== "string" || !task.owner.trim() || task.owner.length > 200) throw new Error("Goal preview contains an invalid task owner.");
      if (task.dependency !== undefined && typeof task.dependency !== "string") throw new Error("Goal preview contains an invalid task dependency.");
      if (task.priority !== undefined && (typeof task.priority !== "string" || !taskPriorities.includes(task.priority as TaskPriority))) throw new Error("Goal preview contains an invalid task priority.");
      if (task.dueDate !== undefined && (typeof task.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate))) throw new Error("Goal preview contains an invalid task due date.");
      taskIds.add(task.id);
      const normalized: Task = { id: task.id, title: task.title, status: task.status as TaskStatus, owner: task.owner, priority: (task.priority as TaskPriority | undefined) ?? "medium" };
      if (task.dependency) normalized.dependency = task.dependency;
      if (task.dueDate) normalized.dueDate = task.dueDate;
      return normalized;
    });
    if (tasks.some((task) => task.dependency && !taskIds.has(task.dependency))) throw new Error("Goal preview contains a dependency that does not exist in the same goal.");
    return { id: source.id, title: source.title, outcome: source.outcome, status: source.status as GoalStatus, tasks };
  });
  const selectedGoalId = typeof payload.selectedGoalId === "string" && (payload.selectedGoalId === "" || goalIds.has(payload.selectedGoalId)) ? payload.selectedGoalId : goals[0]?.id ?? "";
  return { selectedGoalId, goals };
}

function goalStudioScope(projectId?: string | null): string {
  return projectId?.trim() || "standalone";
}

function goalStudioStorageKey(projectId?: string | null): string {
  return `omnia.goal-task-studio.session.v1:${encodeURIComponent(goalStudioScope(projectId))}`;
}

function defaultGoalTaskStudioDraft(): GoalTaskStudioSessionDraft {
  return {
    selectedGoalId: seedGoals[0]?.id ?? "",
    goals: seedGoals.map((goal) => ({ ...goal, tasks: goal.tasks.map((task) => ({ ...task })) })),
    goalDetails: {},
    filter: "all",
    priorityFilter: "all",
    taskSearch: "",
    dashboardView: "list",
    taskTitle: "",
    taskOwner: "You",
    taskDependency: "",
    taskPriority: "medium",
    taskDueDate: "",
    goalTitle: "",
    goalOutcome: "",
    exportFormat: "json",
  };
}

function parseGoalTaskStudioSession(input: string, projectId?: string | null): GoalTaskStudioSessionDraft | null {
  if (new TextEncoder().encode(input).byteLength > MAX_IMPORT_BYTES) return null;
  let candidate: unknown;
  try { candidate = JSON.parse(input); } catch { return null; }
  if (!candidate || typeof candidate !== "object") return null;
  const source = candidate as Record<string, unknown>;
  if (source.schema !== GOAL_STUDIO_SESSION_SCHEMA || source.scope !== "renderer-session" || source.projectScope !== goalStudioScope(projectId)) return null;
  let preview: ReturnType<typeof parseGoalTaskPreview>;
  try {
    preview = parseGoalTaskPreview(JSON.stringify({
      schema: "omnia.goal-task.preview.v1",
      scope: "renderer-session",
      selectedGoalId: source.selectedGoalId,
      goals: source.goals,
    }));
  } catch { return null; }
  const stringField = (key: string, maxLength: number, fallback: string) => typeof source[key] === "string" && (source[key] as string).length <= maxLength ? source[key] as string : fallback;
  const goalDetails: Record<string, GoalDetailDraft> = {};
  if (source.goalDetails && typeof source.goalDetails === "object" && !Array.isArray(source.goalDetails)) {
    for (const [goalId, value] of Object.entries(source.goalDetails)) {
      if (!preview.goals.some((goal) => goal.id === goalId) || !value || typeof value !== "object") continue;
      const detail = value as { title?: unknown; outcome?: unknown };
      if (typeof detail.title === "string" && detail.title.length <= 500 && typeof detail.outcome === "string" && detail.outcome.length <= 4_000) {
        goalDetails[goalId] = { title: detail.title, outcome: detail.outcome };
      }
    }
  }
  const selectedGoal = preview.goals.find((goal) => goal.id === preview.selectedGoalId);
  const taskDependency = stringField("taskDependency", 500, "");
  return {
    selectedGoalId: preview.selectedGoalId,
    goals: preview.goals,
    goalDetails,
    filter: typeof source.filter === "string" && ["all", ...taskStatuses].includes(source.filter) ? source.filter as Filter : "all",
    priorityFilter: typeof source.priorityFilter === "string" && ["all", ...taskPriorities].includes(source.priorityFilter) ? source.priorityFilter as PriorityFilter : "all",
    taskSearch: stringField("taskSearch", 500, ""),
    dashboardView: source.dashboardView === "board" ? "board" : "list",
    taskTitle: stringField("taskTitle", 500, ""),
    taskOwner: stringField("taskOwner", 200, "You"),
    taskDependency: selectedGoal?.tasks.some((task) => task.id === taskDependency) ? taskDependency : "",
    taskPriority: typeof source.taskPriority === "string" && taskPriorities.includes(source.taskPriority as TaskPriority) ? source.taskPriority as TaskPriority : "medium",
    taskDueDate: typeof source.taskDueDate === "string" && (!source.taskDueDate || /^\d{4}-\d{2}-\d{2}$/.test(source.taskDueDate)) ? source.taskDueDate : "",
    goalTitle: stringField("goalTitle", 500, ""),
    goalOutcome: stringField("goalOutcome", 4_000, ""),
    exportFormat: source.exportFormat === "markdown" ? "markdown" : "json",
  };
}

function loadGoalTaskStudioSession(projectId?: string | null): LoadedGoalTaskStudioSession {
  const fallback = defaultGoalTaskStudioDraft();
  try {
    const input = window.sessionStorage.getItem(goalStudioStorageKey(projectId));
    if (!input) return { draft: fallback, restored: false };
    const draft = parseGoalTaskStudioSession(input, projectId);
    return draft ? { draft, restored: true } : { draft: fallback, restored: false };
  } catch {
    return { draft: fallback, restored: false };
  }
}

const goalStatusLabels: Record<GoalStatus, string> = {
  planned: "Planned",
  active: "Active",
  paused: "Paused",
  done: "Done",
};

const seedGoals: Goal[] = [
  { id: "omnia-ui", title: "Shape the Omnia UI", outcome: "Make the workspace easy to inspect and steer.", status: "active", tasks: [{ id: "ui-1", title: "Review chat navigation", status: "done", owner: "You", priority: "high", dueDate: "2026-09-18" }, { id: "ui-2", title: "Tune project workspace surface", status: "active", owner: "You", dependency: "ui-1", priority: "high", dueDate: "2026-09-24" }, { id: "ui-3", title: "Choose a durable storage boundary", status: "planned", owner: "You", dependency: "ui-2", priority: "medium" }] },
  { id: "research-loop", title: "Build an evidence loop", outcome: "Keep sources, claims, memory, and exports reviewable.", status: "planned", tasks: [{ id: "research-1", title: "Collect open questions", status: "active", owner: "Researcher", priority: "medium", dueDate: "2026-09-27" }, { id: "research-2", title: "Draft a research brief", status: "planned", owner: "Researcher", dependency: "research-1", priority: "low" }] },
];

const priorityLabels: Record<TaskPriority, string> = { low: "Low", medium: "Medium", high: "High" };
const statusLabels: Record<TaskStatus, string> = { planned: "Planned", active: "Active", done: "Done" };

function advance(status: TaskStatus): TaskStatus { return status === "planned" ? "active" : status === "active" ? "done" : "planned"; }

export function GoalTaskStudio({ projectId = null }: { projectId?: string | null } = {}) {
  const [initialSession] = useState(() => loadGoalTaskStudioSession(projectId));
  const [goals, setGoals] = useState(initialSession.draft.goals);
  const [history, setHistory] = useState<Array<typeof seedGoals>>([]);
  const [future, setFuture] = useState<Array<typeof seedGoals>>([]);
  const [selectedGoalId, setSelectedGoalId] = useState(initialSession.draft.selectedGoalId);
  const [filter, setFilter] = useState<Filter>(initialSession.draft.filter);
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>(initialSession.draft.priorityFilter);
  const [taskSearch, setTaskSearch] = useState(initialSession.draft.taskSearch);
  const [dashboardView, setDashboardView] = useState<DashboardView>(initialSession.draft.dashboardView);
  const [taskTitle, setTaskTitle] = useState(initialSession.draft.taskTitle);
  const [taskOwner, setTaskOwner] = useState(initialSession.draft.taskOwner);
  const [taskDependency, setTaskDependency] = useState(initialSession.draft.taskDependency);
  const [taskPriority, setTaskPriority] = useState<TaskPriority>(initialSession.draft.taskPriority);
  const [taskDueDate, setTaskDueDate] = useState(initialSession.draft.taskDueDate);
  const [goalTitle, setGoalTitle] = useState(initialSession.draft.goalTitle);
  const [goalOutcome, setGoalOutcome] = useState(initialSession.draft.goalOutcome);
  const [goalDetails, setGoalDetails] = useState(initialSession.draft.goalDetails);
  const [exportFormat, setExportFormat] = useState<ExportFormat>(initialSession.draft.exportFormat);
  const [status, setStatus] = useState(initialSession.restored ? "Restored this Project's renderer-session goal draft." : "Renderer-local goal and task projection.");
  const [sessionSaveStatus, setSessionSaveStatus] = useState("Renderer-session draft; native persistence is not connected.");
  const selectedGoal = goals.find((goal) => goal.id === selectedGoalId) ?? goals[0];
  const selectedGoalIndex = selectedGoal ? goals.findIndex((goal) => goal.id === selectedGoal.id) : -1;
  const goalDraftTitle = selectedGoal ? goalDetails[selectedGoal.id]?.title ?? selectedGoal.title : "";
  const goalDraftOutcome = selectedGoal ? goalDetails[selectedGoal.id]?.outcome ?? selectedGoal.outcome : "";
  useEffect(() => {
    try {
      window.sessionStorage.setItem(goalStudioStorageKey(projectId), JSON.stringify({
        schema: GOAL_STUDIO_SESSION_SCHEMA,
        scope: "renderer-session",
        projectScope: goalStudioScope(projectId),
        selectedGoalId,
        goals,
        goalDetails,
        filter,
        priorityFilter,
        taskSearch,
        dashboardView,
        taskTitle,
        taskOwner,
        taskDependency,
        taskPriority,
        taskDueDate,
        goalTitle,
        goalOutcome,
        exportFormat,
      } satisfies GoalTaskStudioSessionDraft & { schema: string; scope: string; projectScope: string }));
      setSessionSaveStatus("Saved to this browser session · not native persistence.");
    } catch {
      setSessionSaveStatus("Browser session storage unavailable · draft remains in the open view.");
    }
  }, [projectId, selectedGoalId, goals, goalDetails, filter, priorityFilter, taskSearch, dashboardView, taskTitle, taskOwner, taskDependency, taskPriority, taskDueDate, goalTitle, goalOutcome, exportFormat]);
  const normalizedSearch = taskSearch.trim().toLowerCase();
  const visibleTasks = selectedGoal?.tasks.filter((task) => {
    const matchesStatus = filter === "all" || task.status === filter;
    const matchesPriority = priorityFilter === "all" || task.priority === priorityFilter;
    const matchesSearch = !normalizedSearch || [task.title, task.owner, task.dependency].filter(Boolean).some((value) => value?.toLowerCase().includes(normalizedSearch));
    return matchesStatus && matchesPriority && matchesSearch;
  }) ?? [];
  const allTasks = goals.flatMap((goal) => goal.tasks);
  const doneTaskCount = allTasks.filter((task) => task.status === "done").length;
  const activeTaskCount = allTasks.filter((task) => task.status === "active").length;
  const highPriorityCount = allTasks.filter((task) => task.priority === "high" && task.status !== "done").length;
  const todayIso = new Date().toISOString().slice(0, 10);
  const nextWeekIso = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const overdueTaskCount = allTasks.filter((task) => task.dueDate && task.status !== "done" && task.dueDate < todayIso).length;
  const dueSoonTaskCount = allTasks.filter((task) => task.dueDate && task.status !== "done" && task.dueDate >= todayIso && task.dueDate <= nextWeekIso).length;
  const progress = selectedGoal ? Math.round(selectedGoal.tasks.filter((task) => task.status === "done").length / Math.max(1, selectedGoal.tasks.length) * 100) : 0;
  const totalTasks = goals.reduce((sum, goal) => sum + goal.tasks.length, 0);
  const blockedTasks = selectedGoal?.tasks.filter((task) => {
    if (!task.dependency || task.status === "done") return false;
    return selectedGoal.tasks.find((candidate) => candidate.id === task.dependency)?.status !== "done";
  }) ?? [];
  const crossGoalQueue = goals.flatMap((goal) => goal.tasks.flatMap((task): GoalQueueEntry[] => {
    if (task.status === "done") return [];
    const dependency = task.dependency ? goal.tasks.find((candidate) => candidate.id === task.dependency) : undefined;
    const isBlocked = Boolean(task.dependency && dependency?.status !== "done");
    return [{
      goal,
      task,
      state: isBlocked ? "blocked" : task.status === "active" ? "active" : "ready",
      ...(isBlocked ? { blockerTitle: dependency?.title ?? task.dependency } : {}),
    }];
  }));
  const queueCounts = {
    ready: crossGoalQueue.filter((entry) => entry.state === "ready").length,
    active: crossGoalQueue.filter((entry) => entry.state === "active").length,
    blocked: crossGoalQueue.filter((entry) => entry.state === "blocked").length,
  };
  const payload = useMemo(() => JSON.stringify({ schema: "omnia.goal-task.preview.v1", scope: "renderer-session", selectedGoalId, goals, boundary: "No durable task write, scheduler, agent dispatch, or native receipt." }, null, 2), [goals, selectedGoalId]);
  const markdownPayload = useMemo(() => [
    "# Omnia goal and task preview",
    "",
    `- Scope: renderer-session`,
    `- Selected goal: ${selectedGoal?.title ?? "None"}`,
    "- Boundary: no durable task write, scheduler, agent dispatch, or native receipt.",
    "",
    ...goals.flatMap((goal) => [
      `## ${goal.title} · ${goalStatusLabels[goal.status]}`,
      "",
      goal.outcome,
      "",
      ...(goal.tasks.length ? goal.tasks.map((task) => `- [${task.status === "done" ? "x" : " "}] ${task.title} — ${task.owner} · ${priorityLabels[task.priority]} priority${task.dueDate ? ` · due ${task.dueDate}` : ""}${task.dependency ? ` (depends on ${task.dependency})` : ""}`) : ["- No tasks yet."]),
      "",
    ]),
  ].join("\n"), [goals, selectedGoal?.title]);
  const exportPayload = exportFormat === "json" ? payload : markdownPayload;
  const cloneGoals = (value: typeof seedGoals) => value.map((goal) => ({ ...goal, tasks: goal.tasks.map((task) => ({ ...task })) }));
  const commitGoals = (updater: (current: typeof seedGoals) => typeof seedGoals, message: string) => {
    setGoals((current) => {
      const next = updater(current);
      setHistory((entries) => [...entries.slice(-19), cloneGoals(current)]);
      setFuture([]);
      return next;
    });
    setStatus(message);
  };
  const updateTask = (goalId: string, taskId: string, title: string) => commitGoals(
    (current) => current.map((goal) => goal.id === goalId
      ? { ...goal, tasks: goal.tasks.map((task) => task.id === taskId ? { ...task, status: advance(task.status) } : task) }
      : goal),
    `Advanced ${title} in the preview.`,
  );
  const focusQueueTask = (goalId: string, task: Task) => {
    setSelectedGoalId(goalId);
    setFilter(task.status);
    setPriorityFilter("all");
    setTaskSearch(task.title);
    setDashboardView("list");
    setStatus(`Focused “${task.title}” in its goal. Queue status is a renderer-local preview.`);
  };
  const navigateGoal = (delta: -1 | 1) => {
    const nextGoal = goals[selectedGoalIndex + delta];
    if (!nextGoal) return;
    setSelectedGoalId(nextGoal.id);
    // A filter from the previous goal can make the newly selected goal appear
    // empty even though it has tasks. Keep the new navigation self-explanatory.
    setFilter("all");
    setPriorityFilter("all");
    setTaskSearch("");
    setStatus(`Selected goal ${selectedGoalIndex + delta + 1} of ${goals.length}: ${nextGoal.title}. Task filters cleared.`);
  };
  const addGoal = () => {
    const title = goalTitle.trim();
    const outcome = goalOutcome.trim();
    if (!title || !outcome) {
      setStatus("Enter a goal title and outcome before creating the preview.");
      return;
    }
    const id = `goal-${Date.now()}`;
    commitGoals((current) => [...current, { id, title, outcome, status: "planned", tasks: [] }], "Created a planned goal in the renderer-local projection.");
    setSelectedGoalId(id);
    setGoalTitle("");
    setGoalOutcome("");
    setFilter("all");
    setPriorityFilter("all");
    setTaskSearch("");
    setDashboardView("list");
  };
  const updateGoalStatus = (nextStatus: GoalStatus) => {
    if (!selectedGoal) return;
    commitGoals((current) => current.map((goal) => goal.id === selectedGoal.id ? { ...goal, status: nextStatus } : goal), `Set ${selectedGoal.title} to ${goalStatusLabels[nextStatus].toLowerCase()} in the preview.`);
  };
  const saveGoalDetails = () => {
    if (!selectedGoal) return;
    const title = goalDraftTitle.trim();
    const outcome = goalDraftOutcome.trim();
    if (!title || !outcome) { setStatus("Enter a goal title and outcome before saving details."); return; }
    if (title === selectedGoal.title && outcome === selectedGoal.outcome) { setStatus("No goal detail changes to save."); return; }
    commitGoals((current) => current.map((goal) => goal.id === selectedGoal.id ? { ...goal, title, outcome } : goal), `Updated ${title} details in the preview.`);
  };
  const addTask = () => {
    const trimmed = taskTitle.trim();
    if (!trimmed || !selectedGoal) return;
    const newTask: Task = { id: `task-${Date.now()}`, title: trimmed, status: "planned", owner: taskOwner.trim() || "You", priority: taskPriority };
    if (taskDependency) newTask.dependency = taskDependency;
    if (taskDueDate) newTask.dueDate = taskDueDate;
    commitGoals(
      (current) => current.map((goal) => goal.id === selectedGoal.id ? { ...goal, tasks: [...goal.tasks, newTask] } : goal),
      "Added a planned task to the renderer-local projection.",
    );
    setTaskTitle("");
    setTaskOwner("You");
    setTaskDependency("");
    setTaskPriority("medium");
    setTaskDueDate("");
  };
  const reset = () => {
    commitGoals(() => cloneGoals(seedGoals), "Goal and task preview reset.");
    setSelectedGoalId(seedGoals[0]?.id ?? "");
    setGoalDetails({});
    setFilter("all");
    setPriorityFilter("all");
    setTaskSearch("");
    setDashboardView("list");
    setTaskTitle("");
    setTaskOwner("You");
    setTaskDependency("");
    setTaskPriority("medium");
    setTaskDueDate("");
    setGoalTitle("");
    setGoalOutcome("");
  };
  const undo = () => {
    setGoals((current) => {
      const previous = history.at(-1);
      if (!previous) return current;
      setHistory((entries) => entries.slice(0, -1));
      setFuture((entries) => [cloneGoals(current), ...entries.slice(0, 19)]);
      return cloneGoals(previous);
    });
    setStatus("Undid the last goal or task preview change.");
  };
  const redo = () => {
    setGoals((current) => {
      const next = future[0];
      if (!next) return current;
      setFuture((entries) => entries.slice(1));
      setHistory((entries) => [...entries.slice(-19), cloneGoals(current)]);
      return cloneGoals(next);
    });
    setStatus("Redid the next goal or task preview change.");
  };
  const copy = async () => { if (!navigator.clipboard?.writeText) { setStatus("Clipboard unavailable; no goal preview was copied."); return; } try { await navigator.clipboard.writeText(exportPayload); setStatus(`Copied goal and task ${exportFormat.toUpperCase()} preview.`); } catch { setStatus("Clipboard access was denied; nothing was copied."); } };
  const download = () => {
    const blob = new Blob([exportPayload], { type: exportFormat === "json" ? "application/json" : "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `omnia-goal-task-preview.${exportFormat === "json" ? "json" : "md"}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(`Started a browser download for the ${exportFormat.toUpperCase()} preview.`);
  };
  const importJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) { setStatus("Import rejected: goal preview exceeds the 512 KB limit."); return; }
    try {
      const imported = parseGoalTaskPreview(await file.text());
      commitGoals(() => imported.goals.map((goal) => ({ ...goal, tasks: goal.tasks.map((task) => ({ ...task })) })), "Imported a validated goal preview into this renderer session.");
      setSelectedGoalId(imported.selectedGoalId);
      setGoalDetails({});
      setFilter("all");
      setPriorityFilter("all");
      setTaskSearch("");
    } catch (error) {
      setStatus(`Import rejected: ${error instanceof Error ? error.message : "invalid goal preview"}`);
    }
  };
  const isOverdue = (task: Task) => Boolean(task.dueDate && task.status !== "done" && task.dueDate < todayIso);
  const renderTask = (task: Task) => {
    const dependency = task.dependency ? selectedGoal?.tasks.find((candidate) => candidate.id === task.dependency) : undefined;
    const blocked = task.status !== "done" && Boolean(task.dependency && dependency?.status !== "done");
    const actionTitle = blocked
      ? `Cannot advance “${task.title}” yet; finish “${dependency?.title ?? task.dependency}” first.`
      : `Advance “${task.title}” from ${statusLabels[task.status]} to the next preview status`;
    return <button key={task.id} type="button" className={`goal-task-studio__task goal-task-studio__task--${task.status} goal-task-studio__task--priority-${task.priority}${blocked ? " is-blocked" : ""}`} onClick={() => blocked ? setStatus(`“${task.title}” is waiting for “${dependency?.title ?? task.dependency}” to be completed.`) : selectedGoal ? updateTask(selectedGoal.id, task.id, task.title) : undefined} {...(blocked ? { "aria-disabled": "true" } : {})} aria-label={`${task.title} · ${statusLabels[task.status]}`} title={actionTitle}>
    <span>{task.status === "done" ? <CheckCircle2 size={15} /> : <span className="goal-task-studio__task-dot" />}</span>
    <span><strong>{task.title}</strong><small>{task.owner} · {priorityLabels[task.priority]} priority{task.dependency ? ` · depends on ${dependency?.title ?? task.dependency}` : " · no dependency"}{task.dueDate ? ` · due ${task.dueDate}` : ""}{blocked ? " · waiting on prerequisite" : ""}</small></span>
    <em className={isOverdue(task) ? "is-overdue" : ""}>{isOverdue(task) ? `Overdue · ${task.status}` : task.status}</em>
  </button>;
  };
  const renderQueueGroup = (state: GoalQueueEntry["state"], label: string, emptyCopy: string) => {
    const entries = crossGoalQueue.filter((entry) => entry.state === state);
    return <section className={`goal-task-studio__queue-group goal-task-studio__queue-group--${state}`} aria-label={`${label} tasks`} key={state}>
      <header><strong>{label}</strong><span>{entries.length}</span></header>
      {entries.length ? <ul>{entries.slice(0, 6).map(({ goal, task, blockerTitle }) => <li key={`${goal.id}:${task.id}`}>
        <span><strong>{task.title}</strong><small>{goal.title} · {task.owner}{blockerTitle ? ` · waiting on ${blockerTitle}` : task.dueDate ? ` · due ${task.dueDate}` : ""}</small></span>
        <button type="button" className="button button--ghost" aria-label={`Focus ${goal.title} task ${task.id}`} title={`Focus “${task.title}” in ${goal.title}`} onClick={() => focusQueueTask(goal.id, task)}>Focus</button>
      </li>)}</ul> : <p>{emptyCopy}</p>}
      {entries.length > 6 ? <small className="goal-task-studio__queue-more">{entries.length - 6} more in this state</small> : null}
    </section>;
  };
  const taskColumns: Array<{ status: TaskStatus; label: string }> = [{ status: "planned", label: "Planned" }, { status: "active", label: "Active" }, { status: "done", label: "Done" }];
  return <section className="goal-task-studio" aria-labelledby="goal-task-heading">
    <header className="goal-task-studio__header"><div><span className="eyebrow">Goals · tasks · dependencies</span><h2 id="goal-task-heading">Mission plan dashboard</h2><p>Turn a broad objective into visible, reversible work without pretending a native scheduler is connected.</p></div><span className="goal-task-studio__badge"><Sparkles size={13} /> Session draft</span></header>
    <p className="goal-task-studio__session-status" role="status" aria-live="polite">{sessionSaveStatus}</p>
    <div className="goal-task-studio__summary" role="group" aria-label="Key plan metrics">
      <article><Flag size={15} /><span>Goals</span><strong>{goals.length}</strong><small>workstreams</small></article>
      <article><ListTodo size={15} /><span>Total tasks</span><strong>{totalTasks}</strong><small>{doneTaskCount} complete</small></article>
      <article><GitBranch size={15} /><span>Selected progress</span><strong>{progress}%</strong><small>{selectedGoal?.title ?? "No goal"}</small></article>
    </div>
    <details className="goal-task-studio__more-metrics">
      <summary>More planning metrics</summary>
      <div className="goal-task-studio__summary-more" role="group" aria-label="Additional plan metrics">
        <article><CircleDot size={15} /><span>Active tasks</span><strong>{activeTaskCount}</strong><small>across all goals</small></article>
        <article className={highPriorityCount ? "is-attention" : ""}><AlertCircle size={15} /><span>High priority</span><strong>{highPriorityCount}</strong><small>{highPriorityCount ? "needs focus" : "none open"}</small></article>
        <article><Clock3 size={15} /><span>Due soon</span><strong>{dueSoonTaskCount}</strong><small>{overdueTaskCount ? `${overdueTaskCount} overdue` : "next 7 days"}</small></article>
      </div>
    </details>
    <div className="goal-task-studio__toolbar">
      <label><span>Goal</span><select aria-label="Selected goal" value={selectedGoalId} onChange={(event) => setSelectedGoalId(event.target.value)}>{goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title} · {goalStatusLabels[goal.status]}</option>)}</select></label>
      <label className="goal-task-studio__search"><span>Search tasks</span><span className="goal-task-studio__input-with-icon"><Search size={14} /><input aria-label="Search tasks" placeholder="Title, owner, dependency" value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)} /></span></label>
      <label><span>Status</span><select aria-label="Task filter" value={filter} onChange={(event) => setFilter(event.target.value as Filter)}><option value="all">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>Priority</span><select aria-label="Task priority filter" value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as PriorityFilter)}><option value="all">All priorities</option>{taskPriorities.map((priority) => <option key={priority} value={priority}>{priorityLabels[priority]}</option>)}</select></label>
      <div className="goal-task-studio__view-toggle" aria-label="Task dashboard view"><button type="button" className="button button--ghost" aria-label="List view" title="Show matching tasks as a compact list" aria-pressed={dashboardView === "list"} onClick={() => setDashboardView("list")}><List size={13} /> List</button><button type="button" className="button button--ghost" aria-label="Board view" title="Show matching tasks grouped by status" aria-pressed={dashboardView === "board"} onClick={() => setDashboardView("board")}><LayoutGrid size={13} /> Board</button></div>
      <span role="status" aria-live="polite">{status}</span>
      <div className="goal-task-studio__history" aria-label="Goal preview history"><button type="button" className="button button--ghost" onClick={undo} disabled={history.length === 0} aria-label="Undo goal preview change" title="Undo the last renderer-local goal or task change"><Undo2 size={13} /> Undo</button><button type="button" className="button button--ghost" onClick={redo} disabled={future.length === 0} aria-label="Redo goal preview change" title="Redo the next renderer-local goal or task change"><Redo2 size={13} /> Redo</button><button type="button" className="button button--ghost" onClick={reset} title="Reset the goal and task preview to its seeded example"><RotateCcw size={13} /> Reset</button></div>
    </div>
    <div className="goal-task-studio__create"><div><span className="eyebrow">New goal</span><strong>Start another workstream</strong></div><label><span>Title</span><input aria-label="New goal title" placeholder="e.g. Ship the research loop" value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} /></label><label><span>Outcome</span><input aria-label="New goal outcome" placeholder="What should be true when it is done?" value={goalOutcome} onChange={(event) => setGoalOutcome(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addGoal(); }} /></label><button type="button" className="button button--secondary" onClick={addGoal} title="Create a renderer-local goal workstream"><Plus size={13} /> Create goal</button></div>
    {selectedGoal ? <div className="goal-task-studio__layout"><div className="goal-task-studio__card"><div className="goal-task-studio__card-heading"><div><span className="eyebrow">Selected goal · {selectedGoalIndex + 1} of {goals.length}</span><h3>{selectedGoal.title}</h3><p>{selectedGoal.outcome}</p><div className="goal-task-studio__goal-navigation" role="group" aria-label="Goal navigation"><button type="button" className="button button--ghost" aria-label="Previous goal" title="Select the previous goal" disabled={selectedGoalIndex <= 0} onClick={() => navigateGoal(-1)}><ArrowLeft size={13} /> Previous</button><span>{selectedGoalIndex + 1} / {goals.length}</span><button type="button" className="button button--ghost" aria-label="Next goal" title="Select the next goal" disabled={selectedGoalIndex < 0 || selectedGoalIndex >= goals.length - 1} onClick={() => navigateGoal(1)}>Next <ArrowRight size={13} /></button></div></div><span className="goal-task-studio__progress">{progress}%</span></div><div className="goal-task-studio__goal-edit"><label><span>Goal title</span><input aria-label="Edit goal title" value={goalDraftTitle} onChange={(event) => setGoalDetails((current) => ({ ...current, [selectedGoal.id]: { title: event.target.value, outcome: goalDraftOutcome } }))} /></label><label><span>Outcome</span><textarea aria-label="Edit goal outcome" rows={2} value={goalDraftOutcome} onChange={(event) => setGoalDetails((current) => ({ ...current, [selectedGoal.id]: { title: goalDraftTitle, outcome: event.target.value } }))} /></label><button type="button" className="button button--ghost" onClick={saveGoalDetails}>Save goal details</button></div><div className="goal-task-studio__goal-meta"><label><span>Goal lifecycle</span><select aria-label="Goal lifecycle" value={selectedGoal.status} onChange={(event) => updateGoalStatus(event.target.value as GoalStatus)}>{Object.entries(goalStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><span className={`goal-task-studio__health goal-task-studio__health--${blockedTasks.length ? "blocked" : "clear"}`}><AlertCircle size={13} /> {blockedTasks.length ? `${blockedTasks.length} blocked by dependency` : "Dependencies clear"}</span></div><div className="goal-task-studio__bar"><span style={{ width: `${progress}%` }} /></div><div className="goal-task-studio__task-results"><span>{visibleTasks.length} of {selectedGoal.tasks.length} tasks shown</span>{taskSearch || filter !== "all" || priorityFilter !== "all" ? <button type="button" className="button button--ghost" onClick={() => { setTaskSearch(""); setFilter("all"); setPriorityFilter("all"); }}>Clear filters</button> : null}</div>{dashboardView === "board" ? <div className="goal-task-studio__board">{taskColumns.map((column) => <section key={column.status} className="goal-task-studio__column" aria-labelledby={`goal-task-column-${column.status}`}><header><h4 id={`goal-task-column-${column.status}`}>{column.label}</h4><span>{visibleTasks.filter((task) => task.status === column.status).length}</span></header>{visibleTasks.filter((task) => task.status === column.status).map(renderTask)}{visibleTasks.every((task) => task.status !== column.status) ? <p className="goal-task-studio__empty">No matching tasks.</p> : null}</section>)}</div> : <div className="goal-task-studio__tasks">{visibleTasks.map(renderTask)}{!visibleTasks.length ? <p className="goal-task-studio__empty">No tasks match the current filters.</p> : null}</div>}<div className="goal-task-studio__add"><input aria-label="New task title" placeholder="Add a task to this goal" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addTask(); }} /><input aria-label="New task owner" placeholder="Owner" value={taskOwner} onChange={(event) => setTaskOwner(event.target.value)} /><select aria-label="New task priority" value={taskPriority} onChange={(event) => setTaskPriority(event.target.value as TaskPriority)}>{taskPriorities.map((priority) => <option key={priority} value={priority}>{priorityLabels[priority]} priority</option>)}</select><label className="goal-task-studio__date-input"><Calendar size={14} /><input aria-label="New task due date" type="date" value={taskDueDate} onChange={(event) => setTaskDueDate(event.target.value)} /></label><select aria-label="New task dependency" value={taskDependency} onChange={(event) => setTaskDependency(event.target.value)}><option value="">No dependency</option>{selectedGoal.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select><button type="button" className="button button--secondary" onClick={addTask}><Plus size={13} /> Add task</button></div></div><aside className="goal-task-studio__card goal-task-studio__notes"><span className="eyebrow">Goal portfolio</span><h3>Workstreams at a glance</h3><div className="goal-task-studio__portfolio">{goals.map((goal) => { const goalProgress = Math.round(goal.tasks.filter((task) => task.status === "done").length / Math.max(1, goal.tasks.length) * 100); return <button type="button" key={goal.id} className={`goal-task-studio__portfolio-item${goal.id === selectedGoal.id ? " is-selected" : ""}`} aria-pressed={goal.id === selectedGoal.id} onClick={() => setSelectedGoalId(goal.id)}><span><strong>{goal.title}</strong><small>{goalStatusLabels[goal.status]} · {goal.tasks.length} tasks</small></span><em>{goalProgress}%</em></button>; })}</div><section className="goal-task-studio__queue" aria-label="Cross-goal task queue preview"><header><div><span className="eyebrow">Multi-goal queue</span><h3>Next work across goals</h3></div><span className="goal-task-studio__queue-badge">Preview</span></header><div className="goal-task-studio__queue-counts" aria-label="Cross-goal queue summary"><span>{queueCounts.ready} ready</span><span>{queueCounts.active} active</span><span>{queueCounts.blocked} blocked</span></div>{renderQueueGroup("ready", "Ready to start", "No dependency-ready planned tasks.")}{renderQueueGroup("active", "In progress", "No active tasks.")}{renderQueueGroup("blocked", "Waiting on dependencies", "No tasks waiting on a prerequisite.")}</section><p className="goal-task-studio__queue-boundary">This is a read-only renderer projection. It does not enqueue, schedule, dispatch, or persist work.</p><span className="eyebrow">Planning guardrails</span><h3>Visible by default</h3><ul><li>Dependencies stay explicit.</li><li>Advance is a local rehearsal.</li><li>Undo and redo stay inside this preview.</li></ul><div className="goal-task-studio__dependency-list"><strong>Dependency health</strong>{selectedGoal.tasks.length ? selectedGoal.tasks.map((task) => <span key={task.id} className={task.dependency && selectedGoal.tasks.find((candidate) => candidate.id === task.dependency)?.status !== "done" ? "is-blocked" : ""}>{task.title}<small>{task.dependency ? `depends on ${selectedGoal.tasks.find((candidate) => candidate.id === task.dependency)?.title ?? task.dependency}` : "independent"}</small></span>) : <span>No tasks yet. Add the first slice from the form.</span>}</div><p><Sparkles size={14} /> Saved native Goal drafts above are separate. This session-only task board, scheduling, and agent dispatch are not wired to them.</p><div className="goal-task-studio__export"><label><span>Export preview</span><select aria-label="Goal export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}><option value="json">JSON bundle</option><option value="markdown">Markdown</option></select></label><div><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy {exportFormat.toUpperCase()}</button><button type="button" className="button button--ghost" onClick={download}><Download size={13} /> Download</button><label className="goal-task-studio__import button button--ghost"><Upload size={13} /> Import JSON<input aria-label="Import goal preview" type="file" accept=".json,application/json" onChange={(event) => void importJson(event)} /></label></div></div></aside></div> : null}
    <GoalOrchestrationRail goal={selectedGoal?.title ?? "Omnia"} announceStatus={false} />
  </section>;
}

export default GoalTaskStudio;
