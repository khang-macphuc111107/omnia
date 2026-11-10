import {
  Check,
  CheckCircle2,
  CircleAlert,
  ChevronRight,
  Clipboard,
  Clock3,
  Download,
  FileJson2,
  FileText,
  GitBranch,
  History as HistoryIcon,
  Layers3,
  ListChecks,
  LockKeyhole,
  Pencil,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  Undo2,
  Upload,
  Wand2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { buildProjectHandoffSeed, type ProjectHandoffSeed } from "./project-handoff-seed";
import type { ConversationView, ProjectView } from "./types";

export type PlanningStatus = "done" | "active" | "planned" | "blocked";
export type PlanningView = "roadmap" | "dag" | "blueprint" | "acceptance";
export type PlanningExportFormat = "json" | "markdown";

export interface PlanningTask {
  id: string;
  title: string;
  status: PlanningStatus;
  owner: string;
  dependsOn: string[];
  acceptance: string;
  artifact: string;
  risk: string | null;
}

export interface PlanningPhase {
  id: string;
  title: string;
  objective: string;
  window: string;
  status: PlanningStatus;
  tasks: PlanningTask[];
}

export interface ProjectPlanPreview {
  objective: string;
  nonGoals: string[];
  assumptions: string[];
  constraints: string[];
  architecture: Array<{ label: string; detail: string; status: "preview" | "planned" }>;
  phases: PlanningPhase[];
}

export interface PlanningHistoryEntry {
  id: string;
  label: string;
  timestamp: number;
  plan: ProjectPlanPreview;
}

export interface PlanningImportPreview {
  fileName: string;
  format: PlanningExportFormat;
  plan: ProjectPlanPreview;
  warnings: string[];
}

type TaskFilter = "all" | PlanningStatus;

type PlanningTaskDraft = Pick<PlanningTask, "owner" | "artifact" | "acceptance"> & {
  risk: string;
  dependsOn: string[];
};

const STATUS_LABELS: Record<PlanningStatus, string> = {
  done: "Done",
  active: "Active",
  planned: "Planned",
  blocked: "Blocked",
};

const STATUS_ORDER: PlanningStatus[] = ["blocked", "active", "planned", "done"];

// Date.now() alone can collide when several renderer-local plan mutations are
// committed in one event loop turn. Keep history keys unique so React never
// reuses or drops adjacent revisions during rapid undo/redo or bulk edits.
let planningRevisionSequence = 0;

function createPlanningRevisionId(): string {
  planningRevisionSequence += 1;
  return `plan-revision-${Date.now()}-${planningRevisionSequence}`;
}

function seedPlan(projectName: string): ProjectPlanPreview {
  const name = projectName || "this project";
  return {
    objective: `Turn ${name} into a reviewable, dependency-aware workspace with a clear path from intent to verified delivery.`,
    nonGoals: [
      "No native scheduler, provider dispatch, or agent lease is created by this preview.",
      "No filesystem path is read, indexed, or mutated from the renderer.",
      "No plan revision becomes authoritative without native evidence and approval.",
    ],
    assumptions: [
      "The user remains the final planner and tester for this renderer slice.",
      "Tasks can be refined locally before a durable Project Twin revision exists.",
      "Evidence labels remain provisional until a native receipt is hydrated.",
    ],
    constraints: [
      "Preserve explicit ownership and dependency edges.",
      "Keep every action reversible in the current session.",
      "Expose unknown, stale, and planned states instead of inventing certainty.",
    ],
    architecture: [
      { label: "Intent", detail: "Goal, non-goals, assumptions, and acceptance criteria", status: "preview" },
      { label: "Plan", detail: "Phases, milestones, task DAG, owners, and critical path", status: "preview" },
      { label: "Evidence", detail: "Artifacts, tests, sources, and verification receipts", status: "planned" },
      { label: "Delivery", detail: "Native scheduler, approvals, and durable Project Twin revision", status: "planned" },
    ],
    phases: [
      {
        id: "phase-foundation",
        title: "Foundation",
        objective: "Make the project intent and scope explicit.",
        window: "Now",
        status: "active",
        tasks: [
          {
            id: "task-intent",
            title: "Confirm goal and non-goals",
            status: "done",
            owner: "You",
            dependsOn: [],
            acceptance: "A user-readable objective and three non-goals are visible.",
            artifact: "Goal brief",
            risk: null,
          },
          {
            id: "task-scope",
            title: "Map project scope and constraints",
            status: "active",
            owner: "You",
            dependsOn: ["task-intent"],
            acceptance: "Workspace, model, permission, and evidence boundaries are named.",
            artifact: "Scope map",
            risk: "Native grants and source revisions are not hydrated in the browser preview.",
          },
        ],
      },
      {
        id: "phase-delivery",
        title: "Delivery path",
        objective: "Turn the scope into a dependency-complete sequence of work.",
        window: "Next",
        status: "planned",
        tasks: [
          {
            id: "task-blueprint",
            title: "Draft architecture and interface blueprint",
            status: "planned",
            owner: "Architect",
            dependsOn: ["task-scope"],
            acceptance: "Major surfaces, handoffs, and tradeoffs are recorded.",
            artifact: "Blueprint draft",
            risk: "Blueprint is a renderer-local proposal until accepted as a Twin revision.",
          },
          {
            id: "task-critical-path",
            title: "Select the critical path and milestones",
            status: "planned",
            owner: "Planner",
            dependsOn: ["task-blueprint"],
            acceptance: "Milestones have owners, dependencies, and visible completion criteria.",
            artifact: "Roadmap view",
            risk: null,
          },
        ],
      },
      {
        id: "phase-evidence",
        title: "Evidence loop",
        objective: "Attach artifacts and checks without overstating verification.",
        window: "Later",
        status: "planned",
        tasks: [
          {
            id: "task-evidence",
            title: "Attach acceptance evidence",
            status: "planned",
            owner: "Verifier",
            dependsOn: ["task-critical-path"],
            acceptance: "Each acceptance criterion points to a source, artifact, or test receipt.",
            artifact: "Evidence matrix",
            risk: "Native receipts, source hashes, and restart evidence remain planned.",
          },
        ],
      },
    ],
  };
}

function flattenTasks(plan: ProjectPlanPreview): Array<PlanningTask & { phaseId: string; phaseTitle: string }> {
  return plan.phases.flatMap((phase) => phase.tasks.map((task) => ({ ...task, phaseId: phase.id, phaseTitle: phase.title })));
}

export interface PlanningInsights {
  readonly criticalPath: readonly string[];
  readonly cycleDetected: boolean;
  readonly riskCount: number;
  readonly unknownDependencyCount: number;
  readonly selfDependencyCount: number;
  readonly duplicateDependencyCount: number;
  readonly duplicateTaskIdCount: number;
}

export function buildPlanningInsights(plan: ProjectPlanPreview): PlanningInsights {
  const tasks = flattenTasks(plan);
  const byId = new Map<string, (typeof tasks)[number]>();
  let duplicateTaskIdCount = 0;
  for (const task of tasks) {
    if (byId.has(task.id)) {
      duplicateTaskIdCount += 1;
      continue;
    }
    byId.set(task.id, task);
  }
  const canonicalTasks = tasks.filter((task) => byId.get(task.id) === task);
  let unknownDependencyCount = 0;
  let selfDependencyCount = 0;
  let duplicateDependencyCount = 0;
  for (const task of canonicalTasks) {
    const seenDependencies = new Set<string>();
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) selfDependencyCount += 1;
      if (!byId.has(dependency)) unknownDependencyCount += 1;
      if (seenDependencies.has(dependency)) duplicateDependencyCount += 1;
      seenDependencies.add(dependency);
    }
  }
  const depthCache = new Map<string, number>();
  let cycleDetected = false;
  const depth = (taskId: string, visiting: ReadonlySet<string> = new Set()): number => {
    const cached = depthCache.get(taskId);
    if (cached !== undefined) return cached;
    if (visiting.has(taskId)) {
      cycleDetected = true;
      return 0;
    }
    const task = byId.get(taskId);
    if (!task) return 0;
    const nextVisiting = new Set(visiting);
    nextVisiting.add(taskId);
    const value = 1 + Math.max(0, ...task.dependsOn.filter((dependency) => byId.has(dependency)).map((dependency) => depth(dependency, nextVisiting)));
    depthCache.set(taskId, value);
    return value;
  };
  let deepestTaskId: string | null = null;
  let deepest = 0;
  for (const task of canonicalTasks) {
    const value = depth(task.id);
    if (value > deepest) {
      deepest = value;
      deepestTaskId = task.id;
    }
  }
  const criticalPath: string[] = [];
  const seen = new Set<string>();
  let currentId = deepestTaskId;
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    criticalPath.unshift(currentId);
    const task = byId.get(currentId);
    if (!task) break;
    currentId = task.dependsOn
      .filter((dependency) => byId.has(dependency))
      .sort((left, right) => depth(right) - depth(left))[0] ?? null;
  }
  return {
    criticalPath,
    cycleDetected,
    riskCount: tasks.filter((task) => task.risk !== null).length,
    unknownDependencyCount,
    selfDependencyCount,
    duplicateDependencyCount,
    duplicateTaskIdCount,
  };
}

function rawImportedTaskIds(value: unknown): string[] {
  const root = isRecord(value) && isRecord(value.plan) ? value.plan : value;
  if (!isRecord(root) || !Array.isArray(root.phases)) return [];
  return root.phases.flatMap((phaseValue) => {
    if (!isRecord(phaseValue) || !Array.isArray(phaseValue.tasks)) return [];
    return phaseValue.tasks.flatMap((taskValue) => {
      if (!isRecord(taskValue)) return [];
      return [stringValue(taskValue.id, "")].filter(Boolean);
    });
  });
}

function importedGraphWarnings(rawValue: unknown, plan: ProjectPlanPreview): string[] {
  const warnings: string[] = [];
  const rawIds = rawImportedTaskIds(rawValue);
  const duplicateRawIds = rawIds.length - new Set(rawIds).size;
  if (duplicateRawIds > 0) {
    warnings.push(`${duplicateRawIds} duplicate task ID${duplicateRawIds === 1 ? " was" : "s were"} found; duplicate rows were given renderer-local IDs for review.`);
  }
  const insights = buildPlanningInsights(plan);
  if (insights.unknownDependencyCount > 0) {
    warnings.push(`${insights.unknownDependencyCount} dependency edge${insights.unknownDependencyCount === 1 ? " points" : "s point"} to an unknown task and cannot authorize execution.`);
  }
  if (insights.selfDependencyCount > 0) {
    warnings.push(`${insights.selfDependencyCount} self-dependency edge${insights.selfDependencyCount === 1 ? " was" : "s were"} found; native task graphs reject self-edges.`);
  }
  if (insights.duplicateDependencyCount > 0) {
    warnings.push(`${insights.duplicateDependencyCount} duplicate dependency edge${insights.duplicateDependencyCount === 1 ? " was" : "s were"} found and remain renderer-local for review.`);
  }
  if (insights.cycleDetected) {
    warnings.push("A dependency cycle was found; native blocking/required task edges must be acyclic.");
  }
  return warnings;
}

function dependencyCycle(tasks: readonly PlanningTask[], taskId: string, nextDependsOn: readonly string[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const dependencies = id === taskId ? nextDependsOn : byId.get(id)?.dependsOn ?? [];
    for (const dependency of dependencies) {
      if (byId.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return visit(taskId);
}

function clonePlan(plan: ProjectPlanPreview): ProjectPlanPreview {
  return {
    ...plan,
    nonGoals: [...plan.nonGoals],
    assumptions: [...plan.assumptions],
    constraints: [...plan.constraints],
    architecture: plan.architecture.map((layer) => ({ ...layer })),
    phases: plan.phases.map((phase) => ({
      ...phase,
      tasks: phase.tasks.map((task) => ({ ...task, dependsOn: [...task.dependsOn] })),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function statusValue(value: unknown, fallback: PlanningStatus = "planned"): PlanningStatus {
  return value === "done" || value === "active" || value === "planned" || value === "blocked" ? value : fallback;
}

function normalizeImportedPlan(value: unknown, projectName: string): ProjectPlanPreview | null {
  const root = isRecord(value) && isRecord(value.plan) ? value.plan : value;
  if (!isRecord(root) || !Array.isArray(root.phases)) return null;
  const rawPhases = root.phases.flatMap((phaseValue, phaseIndex) => {
    if (!isRecord(phaseValue)) return [];
    const rawTasks = Array.isArray(phaseValue.tasks) ? phaseValue.tasks : [];
    const tasks = rawTasks.flatMap((taskValue, taskIndex) => {
      if (!isRecord(taskValue)) return [];
      const rawId = stringValue(taskValue.id, `imported-task-${phaseIndex + 1}-${taskIndex + 1}`);
      const dependsOn = Array.isArray(taskValue.dependsOn)
        ? taskValue.dependsOn.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      return [{
        rawId,
        id: rawId,
        title: stringValue(taskValue.title, `Imported task ${taskIndex + 1}`),
        status: statusValue(taskValue.status),
        owner: stringValue(taskValue.owner, "Unassigned"),
        dependsOn,
        acceptance: stringValue(taskValue.acceptance, "Define an observable completion check before native activation."),
        artifact: stringValue(taskValue.artifact, "To be defined"),
        risk: typeof taskValue.risk === "string" && taskValue.risk.trim() ? taskValue.risk.trim() : null,
      }];
    });
    return [{
      id: stringValue(phaseValue.id, `imported-phase-${phaseIndex + 1}`),
      title: stringValue(phaseValue.title, `Imported phase ${phaseIndex + 1}`),
      objective: stringValue(phaseValue.objective, "Clarify the next slice of work."),
      window: stringValue(phaseValue.window, "Imported"),
      status: statusValue(phaseValue.status, phaseStatus(tasks)),
      tasks,
    }];
  });
  if (rawPhases.length === 0) return null;
  const firstTaskIdByRawId = new Map<string, string>();
  const usedTaskIds = new Set<string>();
  const taskIdCounts = new Map<string, number>();
  const phases = rawPhases.map((phase) => ({
    ...phase,
    tasks: phase.tasks.map((task) => {
      const count = (taskIdCounts.get(task.rawId) ?? 0) + 1;
      taskIdCounts.set(task.rawId, count);
      let id = task.rawId;
      if (usedTaskIds.has(id)) {
        do {
          id = `${task.rawId}~${count}`;
        } while (usedTaskIds.has(id));
      }
      usedTaskIds.add(id);
      if (!firstTaskIdByRawId.has(task.rawId)) firstTaskIdByRawId.set(task.rawId, id);
      return { ...task, id };
    }),
  })).map((phase) => ({
    ...phase,
    tasks: phase.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      owner: task.owner,
      dependsOn: task.dependsOn.map((dependency) => dependency === task.rawId
        ? task.id
        : firstTaskIdByRawId.get(dependency) ?? dependency),
      acceptance: task.acceptance,
      artifact: task.artifact,
      risk: task.risk,
    } satisfies PlanningTask)),
  }));
  const architecture = Array.isArray(root.architecture)
    ? root.architecture.flatMap((item) => {
      if (!isRecord(item)) return [];
      return [{
        label: stringValue(item.label, "Imported layer"),
        detail: stringValue(item.detail, "Imported planning detail."),
        status: item.status === "planned" ? "planned" : "preview",
      } satisfies ProjectPlanPreview["architecture"][number]];
    })
    : [];
  return {
    objective: stringValue(root.objective, `Continue planning ${projectName || "this project"}.`),
    nonGoals: Array.isArray(root.nonGoals) ? root.nonGoals.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
    assumptions: Array.isArray(root.assumptions) ? root.assumptions.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
    constraints: Array.isArray(root.constraints) ? root.constraints.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
    architecture: architecture.length > 0 ? architecture : seedPlan(projectName).architecture,
    phases,
  };
}

function markdownImportPlan(rawText: string, projectName: string): ProjectPlanPreview | null {
  const lines = rawText.split(/\r?\n/);
  const objectiveStart = lines.findIndex((line) => /^##\s+Objective\s*$/i.test(line.trim()));
  const objective = objectiveStart >= 0
    ? lines.slice(objectiveStart + 1).find((line) => line.trim() && !line.startsWith("#"))?.trim()
    : undefined;
  const phases: PlanningPhase[] = [];
  let current: PlanningPhase | null = null;
  for (const line of lines) {
    const phaseMatch = line.match(/^###\s+(.+?)(?:\s+·\s+(Done|Active|Planned|Blocked))?\s*$/i);
    if (phaseMatch) {
      current = {
        id: `imported-phase-${phases.length + 1}`,
        title: phaseMatch[1]?.trim() || `Imported phase ${phases.length + 1}`,
        objective: "Imported from Markdown; refine the phase objective before native activation.",
        window: "Imported",
        status: statusValue(phaseMatch[2]?.toLowerCase()),
        tasks: [],
      };
      phases.push(current);
      continue;
    }
    const taskMatch = line.match(/^\s*-\s+\[([ xX])\]\s+(.+?)(?:\s+\((Done|Active|Planned|Blocked);\s*([^)]*)\))?\s*$/i);
    if (taskMatch && current) {
      current.tasks.push({
        id: `imported-task-${phases.length}-${current.tasks.length + 1}`,
        title: taskMatch[2]?.trim() || `Imported task ${current.tasks.length + 1}`,
        status: taskMatch[1]?.toLowerCase() === "x" ? "done" : statusValue(taskMatch[3]?.toLowerCase()),
        owner: taskMatch[4]?.trim() || "Unassigned",
        dependsOn: [],
        acceptance: "Define an observable completion check before native activation.",
        artifact: "To be defined",
        risk: null,
      });
    }
  }
  if (phases.length === 0) return null;
  return {
    objective: objective || `Continue planning ${projectName || "this project"}.`,
    nonGoals: ["Imported Markdown remains a renderer-local proposal until reviewed."],
    assumptions: ["Imported fields may need refinement before native activation."],
    constraints: ["No native scheduler, provider dispatch, or durable write is created by this import."],
    architecture: seedPlan(projectName).architecture,
    phases,
  };
}

export function parsePlanningImport(rawText: string, fileName: string, projectName: string): PlanningImportPreview | null {
  const format: PlanningExportFormat = /\.(md|markdown|txt)$/i.test(fileName) ? "markdown" : "json";
  const warnings = [
    "Renderer-local import preview only; no Project Twin revision or native plan is changed.",
    format === "markdown" ? "Markdown tasks are imported without dependency edges or durable evidence receipts." : "Only recognized planning fields are applied; unknown fields are ignored.",
  ];
  let plan: ProjectPlanPreview | null = null;
  if (format === "markdown") {
    plan = markdownImportPlan(rawText, projectName);
  } else {
    try {
      const parsed = JSON.parse(rawText) as unknown;
      plan = normalizeImportedPlan(parsed, projectName);
      if (plan) warnings.push(...importedGraphWarnings(parsed, plan));
    } catch {
      warnings.push("JSON parsing failed; no plan was staged.");
    }
  }
  return plan ? { fileName: fileName || "untitled plan import", format, plan, warnings } : null;
}

function statusTone(status: PlanningStatus): string {
  return `project-planning-preview__status--${status}`;
}

function nextStatus(status: PlanningStatus): PlanningStatus {
  if (status === "planned") return "active";
  if (status === "active") return "done";
  if (status === "done") return "planned";
  return "planned";
}

function phaseStatus(tasks: readonly PlanningTask[]): PlanningStatus {
  if (tasks.length === 0) return "planned";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.every((task) => task.status === "done")) return "done";
  if (tasks.some((task) => task.status === "active")) return "active";
  return "planned";
}

function serializePlan(project: ProjectView, plan: ProjectPlanPreview, format: PlanningExportFormat): string {
  const tasks = flattenTasks(plan);
  const payload = {
    schema: "omnia.project-planning.preview.v1",
    scope: "renderer-session",
    project: { id: project.id, name: project.name },
    objective: plan.objective,
    nonGoals: plan.nonGoals,
    assumptions: plan.assumptions,
    constraints: plan.constraints,
    architecture: plan.architecture,
    phases: plan.phases,
    summary: {
      phaseCount: plan.phases.length,
      taskCount: tasks.length,
      completedTaskCount: tasks.filter((task) => task.status === "done").length,
      activeTaskCount: tasks.filter((task) => task.status === "active").length,
      blockedTaskCount: tasks.filter((task) => task.status === "blocked").length,
    },
    boundary: "Renderer-local planning preview only; no durable Project Twin revision, scheduler, provider request, agent dispatch, or filesystem write was performed.",
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    `# ${project.name} planning preview`,
    "",
    "> Renderer-local planning preview only; no durable Project Twin revision or native execution was performed.",
    "",
    `## Objective\n\n${plan.objective}`,
    "",
    "## Non-goals",
    ...plan.nonGoals.map((item) => `- ${item}`),
    "",
    "## Roadmap",
    ...plan.phases.flatMap((phase) => [
      `### ${phase.title} · ${STATUS_LABELS[phase.status]}`,
      phase.objective,
      ...phase.tasks.map((task) => `- [${task.status === "done" ? "x" : " "}] ${task.title} (${STATUS_LABELS[task.status]}; ${task.owner})`),
      "",
    ]),
    "## Boundary",
    "- No durable write, native scheduler, provider dispatch, agent lease, or filesystem access.",
  ].join("\n");
}

function downloadPlanPreview(payload: string, format: PlanningExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-project-plan-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function ProjectPlanningPreview({
  project,
  conversations = [],
  onPrepareHandoff,
  onPrepareChatDraft,
  onCreateChatDraft,
}: {
  readonly project: ProjectView;
  readonly conversations?: readonly ConversationView[];
  readonly onPrepareHandoff?: (seed: ProjectHandoffSeed) => void;
  readonly onPrepareChatDraft?: (seed: ProjectHandoffSeed, conversationId: string) =>
    "prepared" | "missing-chat" | "wrong-project" | "occupied" | "unavailable";
  readonly onCreateChatDraft?: (seed: ProjectHandoffSeed) => void;
}) {
  const [plan, setPlan] = useState<ProjectPlanPreview>(() => seedPlan(project.name));
  const [history, setHistory] = useState<{ past: PlanningHistoryEntry[]; future: PlanningHistoryEntry[] }>({ past: [], future: [] });
  const [activeView, setActiveView] = useState<PlanningView>("roadmap");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [phaseFilter, setPhaseFilter] = useState("all");
  const [taskQuery, setTaskQuery] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("task-scope");
  const [selectedChatId, setSelectedChatId] = useState("");
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskPhaseId, setNewTaskPhaseId] = useState("phase-delivery");
  const [exportOpen, setExportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<PlanningImportPreview | null>(null);
  const [exportFormat, setExportFormat] = useState<PlanningExportFormat>("json");
  const [status, setStatus] = useState("Renderer-local plan projection ready.");
  const importInputRef = useRef<HTMLInputElement>(null);
  const planningTabsRef = useRef<HTMLDivElement>(null);
  const planningViews: ReadonlyArray<[PlanningView, string]> = [
    ["roadmap", "Roadmap"],
    ["dag", "Task DAG"],
    ["blueprint", "Blueprint"],
    ["acceptance", "Acceptance"],
  ];
  const selectPlanningView = (nextView: PlanningView) => {
    if (nextView === activeView) return;
    setActiveView(nextView);
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    planningTabsRef.current?.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion ? "auto" : "smooth" });
  };
  const movePlanningTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? planningViews.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + planningViews.length) % planningViews.length;
    const nextView = planningViews[nextIndex]?.[0];
    if (!nextView) return;
    selectPlanningView(nextView);
    document.getElementById(`project-plan-tab-${nextView}`)?.focus({ preventScroll: true });
  };

  useEffect(() => {
    setPlan(seedPlan(project.name));
    setHistory({ past: [], future: [] });
    setActiveView("roadmap");
    setTaskFilter("all");
    setPhaseFilter("all");
    setTaskQuery("");
    setSelectedTaskId("task-scope");
    setSelectedChatId("");
    setNewTaskTitle("");
    setNewTaskPhaseId("phase-delivery");
    setExportOpen(false);
    setHistoryOpen(false);
    setImportPreview(null);
    setStatus("Plan preview reset for the selected project.");
  }, [project.id, project.name]);

  const tasks = useMemo(() => flattenTasks(plan), [plan]);
  const planningInsights = useMemo(() => buildPlanningInsights(plan), [plan]);
  const normalizedTaskQuery = taskQuery.trim().toLocaleLowerCase();
  const visibleTasks = useMemo(
    () => tasks.filter((task) => {
      if (taskFilter !== "all" && task.status !== taskFilter) return false;
      if (phaseFilter !== "all" && task.phaseId !== phaseFilter) return false;
      if (!normalizedTaskQuery) return true;
      return [task.title, task.owner, task.artifact, task.acceptance, task.risk ?? ""]
        .some((value) => value.toLocaleLowerCase().includes(normalizedTaskQuery));
    }),
    [normalizedTaskQuery, phaseFilter, taskFilter, tasks],
  );
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? visibleTasks[0] ?? tasks[0];
  const projectChats = conversations.filter((chat) => chat.projectId === project.id);
  const chatCanReceiveDraft = (chat: ConversationView) =>
    !chat.archived && !chat.runState && !chat.hasDraft && !chat.draft.trim();
  const chatDestination = projectChats.find((chat) => chat.id === selectedChatId && chatCanReceiveDraft(chat))
    ?? projectChats.find(chatCanReceiveDraft);
  const [taskEditorOpen, setTaskEditorOpen] = useState(false);
  const [taskDraft, setTaskDraft] = useState<PlanningTaskDraft | null>(null);
  const completedCount = tasks.filter((task) => task.status === "done").length;
  const activeCount = tasks.filter((task) => task.status === "active").length;
  const blockedCount = tasks.filter((task) => task.status === "blocked").length;
  const graphNeedsReview = planningInsights.cycleDetected
    || planningInsights.unknownDependencyCount > 0
    || planningInsights.selfDependencyCount > 0
    || planningInsights.duplicateDependencyCount > 0
    || planningInsights.duplicateTaskIdCount > 0;
  const progress = Math.round((completedCount / Math.max(1, tasks.length)) * 100);
  const exportPayload = useMemo(() => serializePlan(project, plan, exportFormat), [exportFormat, plan, project]);

  useEffect(() => {
    if (!selectedTask) {
      setTaskEditorOpen(false);
      setTaskDraft(null);
      return;
    }
    setTaskDraft({
      owner: selectedTask.owner,
      artifact: selectedTask.artifact,
      acceptance: selectedTask.acceptance,
      risk: selectedTask.risk ?? "",
      dependsOn: [...selectedTask.dependsOn],
    });
  }, [selectedTask?.id]);

  const commitPlan = (updater: (current: ProjectPlanPreview) => ProjectPlanPreview, label: string) => {
    setPlan((current) => {
      const next = updater(current);
      setHistory((currentHistory) => ({
        past: [...currentHistory.past, { id: createPlanningRevisionId(), label, timestamp: Date.now(), plan: clonePlan(current) }].slice(-20),
        future: [],
      }));
      return next;
    });
  };

  const undo = () => {
    const entry = history.past.at(-1);
    if (!entry) {
      setStatus("No earlier renderer-local plan revision is available.");
      return;
    }
    setPlan((current) => {
      setHistory((currentHistory) => ({
        past: currentHistory.past.slice(0, -1),
        future: [...currentHistory.future, { id: createPlanningRevisionId(), label: "Redo previous plan revision", timestamp: Date.now(), plan: clonePlan(current) }].slice(-20),
      }));
      return clonePlan(entry.plan);
    });
    setStatus(`Undid “${entry.label}” in the renderer preview.`);
  };

  const redo = () => {
    const entry = history.future.at(-1);
    if (!entry) {
      setStatus("No later renderer-local plan revision is available.");
      return;
    }
    setPlan((current) => {
      setHistory((currentHistory) => ({
        past: [...currentHistory.past, { id: createPlanningRevisionId(), label: "Redo plan revision", timestamp: Date.now(), plan: clonePlan(current) }].slice(-20),
        future: currentHistory.future.slice(0, -1),
      }));
      return clonePlan(entry.plan);
    });
    setStatus(`Redid a renderer-local plan revision from ${new Date(entry.timestamp).toLocaleTimeString()}.`);
  };

  const restoreHistoryEntry = (entry: PlanningHistoryEntry) => {
    commitPlan(() => clonePlan(entry.plan), `Restored ${entry.label}`);
    setSelectedTaskId(entry.plan.phases[0]?.tasks[0]?.id ?? "");
    setStatus(`Restored “${entry.label}” in the renderer preview.`);
  };

  const updateTask = (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;
    const next = nextStatus(task.status);
    commitPlan((current) => ({
      ...current,
      phases: current.phases.map((phase) => ({
        ...phase,
        tasks: phase.tasks.map((item) => item.id === taskId ? { ...item, status: next } : item),
      })),
    }), `Advanced ${task.title} to ${STATUS_LABELS[next]}`);
    setSelectedTaskId(taskId);
    setStatus(`${task.title} is ${STATUS_LABELS[next].toLowerCase()} in the renderer preview.`);
  };

  const openTaskEditor = () => {
    if (!selectedTask) return;
    setTaskDraft({
      owner: selectedTask.owner,
      artifact: selectedTask.artifact,
      acceptance: selectedTask.acceptance,
      risk: selectedTask.risk ?? "",
      dependsOn: [...selectedTask.dependsOn],
    });
    setTaskEditorOpen(true);
  };

  const prepareHandoff = () => {
    if (!selectedTask || !onPrepareHandoff) return;
    const seed = buildProjectHandoffSeed(plan, selectedTask.id);
    if (!seed) return;
    onPrepareHandoff(seed);
    setStatus(`Prepared “${selectedTask.title}” as a renderer-local handoff brief.`);
  };

  const prepareChatDraft = () => {
    if (!selectedTask || !chatDestination || !onPrepareChatDraft) return;
    const seed = buildProjectHandoffSeed(plan, selectedTask.id);
    if (!seed) return;
    const result = onPrepareChatDraft(seed, chatDestination.id);
    setStatus(result === "prepared"
      ? `Prepared an editable Chat draft for “${selectedTask.title}”. No provider request was sent.`
      : result === "occupied"
        ? "That Chat now has a draft; nothing was overwritten. Choose an empty Chat."
        : result === "wrong-project"
          ? "That Chat no longer belongs to this Project; nothing was staged."
          : "That Chat is no longer available; nothing was staged. Choose another destination.");
  };

  const openNewChatDraft = () => {
    if (!selectedTask || !onCreateChatDraft) return;
    const seed = buildProjectHandoffSeed(plan, selectedTask.id);
    if (!seed) return;
    onCreateChatDraft(seed);
    setStatus(`Opened new Chat setup with “${selectedTask.title}” as an editable draft. No Chat or run was created yet.`);
  };

  const saveTaskEditor = () => {
    if (!selectedTask || !taskDraft) return;
    if (dependencyCycle(tasks, selectedTask.id, taskDraft.dependsOn)) {
      setStatus("This dependency selection would create a cycle; the task DAG was not changed.");
      return;
    }
    const nextDraft = {
      ...taskDraft,
      owner: taskDraft.owner.trim() || "Unassigned",
      artifact: taskDraft.artifact.trim() || "To be defined",
      acceptance: taskDraft.acceptance.trim() || "Define an observable completion check before native activation.",
      risk: taskDraft.risk.trim() || null,
    };
    commitPlan((current) => ({
      ...current,
      phases: current.phases.map((phase) => ({
        ...phase,
        tasks: phase.tasks.map((task) => task.id === selectedTask.id ? { ...task, ...nextDraft } : task),
      })),
    }), `Edited ${selectedTask.title}`);
    setTaskDraft({ ...nextDraft, risk: nextDraft.risk ?? "" });
    setTaskEditorOpen(false);
    setStatus(`Updated “${selectedTask.title}” in the renderer preview.`);
  };

  const addTask = () => {
    const title = newTaskTitle.trim();
    const phase = plan.phases.find((item) => item.id === newTaskPhaseId) ?? plan.phases[0];
    if (!title || !phase) {
      setStatus("Enter a task title before adding it to the preview.");
      return;
    }
    const id = `task-preview-${Date.now()}`;
    const task: PlanningTask = {
      id,
      title,
      status: "planned",
      owner: "You",
      dependsOn: [],
      acceptance: "Define an observable completion check before native activation.",
      artifact: "To be defined",
      risk: null,
    };
    commitPlan((current) => ({
      ...current,
      phases: current.phases.map((item) => item.id === phase.id ? { ...item, tasks: [...item.tasks, task] } : item),
    }), `Added ${title}`);
    setSelectedTaskId(id);
    setNewTaskTitle("");
    setStatus(`Added “${title}” to ${phase.title} in the renderer preview.`);
  };

  const reset = () => {
    commitPlan(() => seedPlan(project.name), "Reset plan to starting proposal");
    setTaskFilter("all");
    setPhaseFilter("all");
    setTaskQuery("");
    setSelectedTaskId("task-scope");
    setNewTaskTitle("");
    setStatus("Project planning preview reset to its starting proposal.");
  };

  const readImportFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 512 * 1024) {
      setImportPreview(null);
      setStatus("This preview accepts planning files up to 512 KB; no import was staged.");
      return;
    }
    try {
      const rawText = typeof file.text === "function"
        ? await file.text()
        : await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
          reader.onerror = () => reject(reader.error ?? new Error("Unable to read planning file"));
          reader.readAsText(file);
        });
      const preview = parsePlanningImport(rawText, file.name, project.name);
      if (!preview) {
        setImportPreview(null);
        setStatus("The file does not contain recognizable planning phases; no import was staged.");
        return;
      }
      setImportPreview(preview);
      setStatus(`Ready to review ${preview.fileName} as a renderer-local ${preview.format.toUpperCase()} import.`);
    } catch {
      setImportPreview(null);
      setStatus("The planning file could not be read; no import was staged.");
    }
  };

  const applyImport = () => {
    if (!importPreview) return;
    commitPlan(() => clonePlan(importPreview.plan), `Imported ${importPreview.fileName}`);
    setSelectedTaskId(importPreview.plan.phases[0]?.tasks[0]?.id ?? "");
    setImportPreview(null);
    if (importInputRef.current) importInputRef.current.value = "";
    setStatus(`Imported ${importPreview.fileName} into this renderer session. No native plan changed.`);
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no plan preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatus(`Copied the renderer-local ${exportFormat.toUpperCase()} plan preview.`);
    } catch {
      setStatus("Clipboard access was denied; no plan preview was copied.");
    }
  };

  return (
    <section className="project-planning-preview" aria-labelledby="project-planning-preview-heading">
      <header className="project-planning-preview__header">
        <div>
          <span className="eyebrow">Roadmap · blueprint · task DAG</span>
          <h3 id="project-planning-preview-heading">Project planning studio</h3>
          <p>Shape a dependency-aware plan before native Project Twin, scheduler, and evidence receipts are connected.</p>
        </div>
        <span className="project-planning-preview__badge"><Sparkles size={13} /> Preview only</span>
      </header>

      <div className="project-planning-preview__summary" role="status" aria-live="polite">
        <article><span><Target size={14} /></span><strong>{progress}%</strong><small>Plan progress</small></article>
        <article><span><Layers3 size={14} /></span><strong>{plan.phases.length}</strong><small>Phases</small></article>
        <article><span><ListChecks size={14} /></span><strong>{tasks.length}</strong><small>Tasks</small></article>
        <article><span><GitBranch size={14} /></span><strong>{activeCount}</strong><small>Active</small></article>
        <article><span><CircleAlert size={14} /></span><strong>{blockedCount}</strong><small>Blocked</small></article>
      </div>

      <div className="project-planning-preview__toolbar" role="toolbar" aria-label="Project planning preview controls">
        <span className="project-planning-preview__status" role="status" aria-live="polite">{status}</span>
        <label><span>Find task</span><input aria-label="Project plan task search" placeholder="Title, owner, artifact…" value={taskQuery} onChange={(event) => setTaskQuery(event.target.value)} /></label>
        <label><span>Phase filter</span><select aria-label="Project plan phase filter" value={phaseFilter} onChange={(event) => setPhaseFilter(event.target.value)}><option value="all">All phases</option>{plan.phases.map((phase) => <option key={phase.id} value={phase.id}>{phase.title}</option>)}</select></label>
        <label><span>Task filter</span><select aria-label="Project plan task filter" value={taskFilter} onChange={(event) => setTaskFilter(event.target.value as TaskFilter)}>{(["all", ...STATUS_ORDER] as TaskFilter[]).map((value) => <option key={value} value={value}>{value === "all" ? "All tasks" : STATUS_LABELS[value]}</option>)}</select></label>
        <input ref={importInputRef} type="file" accept=".json,.md,.markdown,.txt,application/json,text/markdown,text/plain" hidden aria-label="Choose project plan import file" onChange={(event) => void readImportFile(event.target.files?.[0])} />
        <button type="button" className="button button--ghost" onClick={() => importInputRef.current?.click()}><Upload size={13} /> Import</button>
        <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo project plan change"><Undo2 size={13} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo project plan change"><Redo2 size={13} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={() => setHistoryOpen((value) => !value)} aria-expanded={historyOpen} aria-controls="project-planning-history"><HistoryIcon size={13} /> History {history.past.length > 0 ? `(${history.past.length})` : ""}</button>
        <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={13} /> Reset</button>
        <button type="button" className="button button--secondary" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="project-planning-export"><FileJson2 size={13} /> {exportOpen ? "Hide export" : "Export preview"}</button>
      </div>

      <div ref={planningTabsRef} className="project-planning-preview__tabs" role="tablist" aria-label="Project plan views" aria-orientation="horizontal">
        {planningViews.map(([view, label], index) => (
          <button key={view} id={`project-plan-tab-${view}`} type="button" role="tab" aria-selected={activeView === view} aria-controls={`project-plan-panel-${view}`} tabIndex={activeView === view ? 0 : -1} className={activeView === view ? "is-active" : ""} onClick={() => selectPlanningView(view)} onKeyDown={(event) => movePlanningTab(event, index)}>{label}</button>
        ))}
      </div>

      <div className="project-planning-preview__objective" aria-label="Project plan objective">
        <Target size={15} />
        <span><strong>Objective</strong><small>{plan.objective}</small></span>
      </div>

      <section className="project-planning-preview__insights" aria-label="Project planning insights">
        <div className="project-planning-preview__insight-metrics">
          <article><span><GitBranch size={14} /></span><strong>{planningInsights.criticalPath.length}</strong><small>Critical path tasks</small></article>
          <article><span><CircleAlert size={14} /></span><strong>{planningInsights.riskCount}</strong><small>Risk notes</small></article>
          <article><span><ShieldCheck size={14} /></span><strong>{graphNeedsReview ? "Review" : "Acyclic"}</strong><small>Dependency shape</small></article>
        </div>
        <div className="project-planning-preview__critical-path"><header><div><span className="eyebrow">Critical path insights</span><strong>Longest dependency chain</strong></div><span className="project-planning-preview__chip">Renderer-local</span></header>{planningInsights.criticalPath.length > 0 ? <div className="project-planning-preview__critical-path-list">{planningInsights.criticalPath.map((taskId, index) => { const task = tasks.find((item) => item.id === taskId); return task ? <span key={task.id}><button type="button" aria-label={`Critical path step ${index + 1}`} title={task.title} onClick={() => setSelectedTaskId(task.id)} className={selectedTask?.id === task.id ? "is-selected" : ""}>{index + 1}. {task.title}</button>{index < planningInsights.criticalPath.length - 1 ? <ChevronRight size={12} aria-hidden="true" /> : null}</span> : null; })}</div> : <p className="project-planning-preview__empty-line">No dependency chain has been staged yet.</p>}<p>{graphNeedsReview ? "Dependency data needs review before this path can be treated as authoritative; native blocking/required edges remain planned." : "Dependency links are descriptive and remain renderer-local until a native Project Twin revision exists."}</p></div>
      </section>

      {historyOpen ? (
        <section id="project-planning-history" className="project-planning-preview__history" aria-label="Project planning revision history">
          <header><div><span className="eyebrow">Session history</span><strong>{history.past.length + history.future.length} local revision{history.past.length + history.future.length === 1 ? "" : "s"}</strong></div><span className="project-planning-preview__chip">No durable write</span></header>
          {history.past.length || history.future.length ? (
            <div className="project-planning-preview__history-list">
              {[...history.past.slice(-6).reverse(), ...history.future.slice().reverse()].map((entry) => <article key={entry.id}><div><strong>{entry.label}</strong><small>{new Date(entry.timestamp).toLocaleTimeString()} · {entry.plan.phases.length} phases · {flattenTasks(entry.plan).length} tasks</small></div><button type="button" className="button button--ghost" onClick={() => restoreHistoryEntry(entry)}>Restore</button></article>)}
            </div>
          ) : <p className="project-planning-preview__empty-line">No plan revisions yet. Status advances, added tasks, resets, and imports will appear here.</p>}
          <p><HistoryIcon size={13} /> Undo/redo and restore remain session-local. Native Project Twin history is still <strong>Planned</strong>.</p>
        </section>
      ) : null}

      {importPreview ? (
        <section className="project-planning-preview__import" aria-label="Project planning import preview">
          <header><div><span className="eyebrow">Import staged</span><strong>{importPreview.fileName}</strong></div><span className="project-planning-preview__chip"><FileText size={13} /> {importPreview.format.toUpperCase()}</span></header>
          <div className="project-planning-preview__import-summary"><span><small>Phases</small><strong>{importPreview.plan.phases.length}</strong></span><span><small>Tasks</small><strong>{flattenTasks(importPreview.plan).length}</strong></span><span><small>Objective</small><strong>{importPreview.plan.objective}</strong></span></div>
          <ul>{importPreview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          <div className="project-planning-preview__import-actions"><button type="button" className="button button--primary" onClick={applyImport}><CheckCircle2 size={13} /> Apply to preview</button><button type="button" className="button button--ghost" onClick={() => { setImportPreview(null); if (importInputRef.current) importInputRef.current.value = ""; setStatus("Import preview dismissed; current plan remains unchanged."); }}>Dismiss</button></div>
        </section>
      ) : null}

      {exportOpen ? (
        <section id="project-planning-export" className="project-planning-preview__export" aria-label="Project planning export preview">
          <header><div><span className="eyebrow">Renderer-local export</span><strong>{project.name} plan snapshot</strong></div><span className="project-planning-preview__chip">No durable write</span></header>
          <div className="project-planning-preview__export-toolbar" role="toolbar" aria-label="Project plan export actions">
            <label><span>Format</span><select aria-label="Project planning export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as PlanningExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
            <span className="project-planning-preview__export-status" role="status" aria-live="polite">{status}</span>
            <button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button>
            <button type="button" className="button button--secondary" onClick={() => setStatus(downloadPlanPreview(exportPayload, exportFormat) ? "Downloaded the renderer-local plan preview; no native state changed." : "Download is unavailable; no plan preview was exported.")}><Download size={13} /> Download</button>
          </div>
          <pre tabIndex={0}><code>{exportPayload}</code></pre>
          <p><LockKeyhole size={13} /> Export contains a local proposal only. It does not persist a plan, invoke a scheduler, send a provider request, or include workspace paths.</p>
        </section>
      ) : null}

      {activeView === "roadmap" ? (
        <div id="project-plan-panel-roadmap" className="project-planning-preview__roadmap" role="tabpanel" aria-labelledby="project-plan-tab-roadmap" tabIndex={0}>
          {plan.phases.map((phase) => {
            const phaseTasks = visibleTasks.filter((task) => task.phaseId === phase.id);
            const done = phase.tasks.filter((task) => task.status === "done").length;
            const phaseProgress = Math.round((done / Math.max(1, phase.tasks.length)) * 100);
            return (
              <article key={phase.id} className="project-planning-preview__phase">
                <header><div><span className="eyebrow">{phase.window}</span><h4>{phase.title}</h4><p>{phase.objective}</p></div><span className={`project-planning-preview__status-chip ${statusTone(phaseStatus(phase.tasks))}`}>{STATUS_LABELS[phaseStatus(phase.tasks)]}</span></header>
                <div className="project-planning-preview__progress"><span style={{ width: `${phaseProgress}%` }} /></div>
                <div className="project-planning-preview__phase-meta"><span>{done}/{phase.tasks.length} complete</span><span>{phaseTasks.length} visible</span></div>
                <div className="project-planning-preview__task-list">
                  {phaseTasks.map((task) => <button key={task.id} type="button" aria-label={task.title} className={`project-planning-preview__task ${selectedTask?.id === task.id ? "is-selected" : ""}`} onClick={() => setSelectedTaskId(task.id)}><span className={`project-planning-preview__task-icon ${statusTone(task.status)}`}>{task.status === "done" ? <CheckCircle2 size={14} /> : <Clock3 size={14} />}</span><span><strong>{task.title}</strong><small>{task.owner} · {task.dependsOn.length ? `depends on ${task.dependsOn.length} task(s)` : "no dependency"}</small></span><em>{STATUS_LABELS[task.status]}</em></button>)}
                  {phaseTasks.length === 0 ? <span className="project-planning-preview__empty-line">No tasks match this filter.</span> : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      {activeView === "dag" ? (
        <div id="project-plan-panel-dag" className="project-planning-preview__dag" role="tabpanel" aria-labelledby="project-plan-tab-dag" tabIndex={0} aria-label="Project task dependency graph">
          <div className="project-planning-preview__dag-intro"><GitBranch size={16} /><span><strong>Critical path preview</strong><small>Dependencies are descriptive renderer links, not a native scheduler or lease.</small></span></div>
          <div className="project-planning-preview__dag-list">{visibleTasks.map((task) => <button key={task.id} type="button" className={`project-planning-preview__dag-row ${selectedTask?.id === task.id ? "is-selected" : ""}`} onClick={() => setSelectedTaskId(task.id)}><span className="project-planning-preview__dag-node">{task.dependsOn.length ? task.dependsOn.length : "·"}</span><span><strong>{task.title}</strong><small>{task.dependsOn.length ? `Depends on ${task.dependsOn.join(", ")}` : "Root task · ready to shape"}</small></span><em className={`project-planning-preview__status-chip ${statusTone(task.status)}`}>{STATUS_LABELS[task.status]}</em></button>)}</div>
        </div>
      ) : null}

      {activeView === "blueprint" ? (
        <div id="project-plan-panel-blueprint" className="project-planning-preview__blueprint" role="tabpanel" aria-labelledby="project-plan-tab-blueprint" tabIndex={0}>
          <div className="project-planning-preview__blueprint-copy"><span className="eyebrow">Objective</span><h4>{plan.objective}</h4><div className="project-planning-preview__blueprint-grid"><article><strong>Assumptions</strong><ul>{plan.assumptions.map((item) => <li key={item}>{item}</li>)}</ul></article><article><strong>Constraints</strong><ul>{plan.constraints.map((item) => <li key={item}>{item}</li>)}</ul></article><article><strong>Non-goals</strong><ul>{plan.nonGoals.map((item) => <li key={item}>{item}</li>)}</ul></article></div></div>
          <div className="project-planning-preview__architecture" aria-label="Blueprint layers">{plan.architecture.map((layer) => <article key={layer.label}><span><Wand2 size={14} /></span><div><strong>{layer.label}</strong><p>{layer.detail}</p></div><em>{layer.status === "preview" ? "Preview" : "Planned"}</em></article>)}</div>
        </div>
      ) : null}

      {activeView === "acceptance" ? (
        <div id="project-plan-panel-acceptance" className="project-planning-preview__acceptance" role="tabpanel" aria-labelledby="project-plan-tab-acceptance" tabIndex={0}><header><div><span className="eyebrow">Acceptance matrix</span><h4>What “done” needs to prove</h4></div><span className="project-planning-preview__chip"><ShieldCheck size={13} /> Evidence-aware</span></header>{visibleTasks.map((task) => <article key={task.id}><span className={`project-planning-preview__acceptance-icon ${statusTone(task.status)}`}>{task.status === "done" ? <Check size={13} /> : <CircleAlert size={13} />}</span><div><strong>{task.acceptance}</strong><small>{task.title} · artifact: {task.artifact}</small>{task.risk ? <em><CircleAlert size={12} /> {task.risk}</em> : null}</div><span className={`project-planning-preview__status-chip ${statusTone(task.status)}`}>{STATUS_LABELS[task.status]}</span></article>)}{visibleTasks.length === 0 ? <span className="project-planning-preview__empty-line">No acceptance checks match the current filters.</span> : null}</div>
      ) : null}

      <div className="project-planning-preview__inspector">
        <header><div><span className="eyebrow">Selected task</span><strong>{selectedTask?.title ?? "No task selected"}</strong></div><div className="project-planning-preview__inspector-actions"><button type="button" className="button button--ghost" disabled={!selectedTask} onClick={openTaskEditor}><Pencil size={13} /> Edit details</button><button type="button" className="button button--secondary" disabled={!selectedTask} onClick={() => selectedTask && updateTask(selectedTask.id)}>{selectedTask ? `Advance to ${STATUS_LABELS[nextStatus(selectedTask.status)]}` : "Advance task"}</button>{onPrepareHandoff ? <button type="button" className="button button--secondary" disabled={!selectedTask} onClick={prepareHandoff} aria-label="Prepare handoff for selected task"><Send size={13} /> Prepare handoff</button> : null}</div></header>
        {selectedTask ? <div className="project-planning-preview__inspector-grid"><span><small>Owner</small><strong>{selectedTask.owner}</strong></span><span><small>Phase</small><strong>{selectedTask.phaseTitle}</strong></span><span><small>Artifact</small><strong>{selectedTask.artifact}</strong></span><span><small>Dependencies</small><strong>{selectedTask.dependsOn.length ? selectedTask.dependsOn.length : "None"}</strong></span><p><ListChecks size={13} /> {selectedTask.acceptance}</p></div> : null}
        {onPrepareChatDraft || onCreateChatDraft ? <div className="project-planning-preview__chat-draft" aria-label="Prepare selected task as Chat draft">
          {onPrepareChatDraft ? <>
            <label htmlFor="project-plan-chat-destination">Chat destination
              <select id="project-plan-chat-destination" aria-label="Chat draft destination" value={chatDestination?.id ?? ""} onChange={(event) => setSelectedChatId(event.target.value)} disabled={!chatDestination}>
                {!chatDestination ? <option value="">No empty Project Chat</option> : null}
                {projectChats.map((chat) => <option key={chat.id} value={chat.id} disabled={!chatCanReceiveDraft(chat)}>{chat.title}{chatCanReceiveDraft(chat) ? "" : " · existing draft or unavailable"}</option>)}
              </select>
            </label>
            <button type="button" className="button button--secondary" disabled={!selectedTask || !chatDestination} onClick={prepareChatDraft}><FileText size={13} /> Prepare Chat draft</button>
          </> : null}
          {onCreateChatDraft ? <button type="button" className="button button--ghost" disabled={!selectedTask} onClick={openNewChatDraft}><Plus size={13} /> New Chat with task draft</button> : null}
          <small>Only an empty Chat in this Project can receive a session-only draft. Existing drafts are protected; creating a new Chat requires confirmation. No model request is sent.</small>
        </div> : null}
        {selectedTask && taskEditorOpen && taskDraft ? <div className="project-planning-preview__task-editor" aria-label="Edit selected project plan task">
          <div className="project-planning-preview__task-editor-grid">
            <label><span>Owner</span><input aria-label="Selected task owner" value={taskDraft.owner} onChange={(event) => setTaskDraft((current) => current ? { ...current, owner: event.target.value } : current)} /></label>
            <label><span>Artifact</span><input aria-label="Selected task artifact" value={taskDraft.artifact} onChange={(event) => setTaskDraft((current) => current ? { ...current, artifact: event.target.value } : current)} /></label>
            <label className="project-planning-preview__task-editor-wide"><span>Acceptance check</span><textarea aria-label="Selected task acceptance" rows={3} value={taskDraft.acceptance} onChange={(event) => setTaskDraft((current) => current ? { ...current, acceptance: event.target.value } : current)} /></label>
            <label className="project-planning-preview__task-editor-wide"><span>Risk note</span><input aria-label="Selected task risk" placeholder="Optional risk or unknown" value={taskDraft.risk} onChange={(event) => setTaskDraft((current) => current ? { ...current, risk: event.target.value } : current)} /></label>
          </div>
          <fieldset className="project-planning-preview__dependency-editor"><legend>Dependencies</legend><div>{tasks.filter((task) => task.id !== selectedTask.id).map((task) => <label key={task.id}><input type="checkbox" checked={taskDraft.dependsOn.includes(task.id)} onChange={(event) => setTaskDraft((current) => current ? { ...current, dependsOn: event.target.checked ? [...current.dependsOn, task.id] : current.dependsOn.filter((id) => id !== task.id) } : current)} /><span>{task.title}</span></label>)}</div></fieldset>
          <div className="project-planning-preview__task-editor-actions"><button type="button" className="button button--secondary" onClick={saveTaskEditor}><Save size={13} /> Save details</button><button type="button" className="button button--ghost" onClick={() => setTaskEditorOpen(false)}>Cancel</button><span>Session-local edit · no native plan mutation</span></div>
        </div> : null}
      </div>

      <div className="project-planning-preview__add">
        <label><span>New task</span><input aria-label="New project plan task title" placeholder="Add a task to the plan" value={newTaskTitle} onChange={(event) => setNewTaskTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addTask(); }} /></label>
        <label><span>Phase</span><select aria-label="New project plan task phase" value={newTaskPhaseId} onChange={(event) => setNewTaskPhaseId(event.target.value)}>{plan.phases.map((phase) => <option key={phase.id} value={phase.id}>{phase.title}</option>)}</select></label>
        <button type="button" className="button button--secondary" onClick={addTask}><Plus size={13} /> Add task</button>
      </div>

      <p className="project-planning-preview__boundary"><LockKeyhole size={13} /> <span>This is a renderer-local planning rehearsal. Native goals, milestones, task leases, Project Twin revisions, scheduler actions, provider requests, agent dispatch, and durable writes remain <strong>Planned</strong>.</span></p>
    </section>
  );
}

export { seedPlan, serializePlan };
export default ProjectPlanningPreview;
