import type { CreateGoalRequest, CreateGoalRevisionRequest, CreateTaskRequest, CreateTaskRevisionRequest, GoalRecord, GoalSnapshot, TaskSnapshot, TaskSummary, TaskStatus } from "@/lib/desktop";

export interface WorkflowScope {
  /** Harness session identity is display context, never a native conversation ID. */
  sessionId?: string;
  projectId?: string;
  conversationId?: string;
}
export interface GoalDraft { title: string; description: string; criteriaText: string; plan: string; reason: string; }
export interface TaskDraft { title: string; description: string; owner: string; filesText: string; input: string; output: string; verification: string; evidenceText: string; report: string; reason: string; }
export interface ReportDraft { summary: string; evidenceText: string; limitations: string; remainingWork: string; }
export type CriterionStatus = "planned" | "partial" | "blocked" | "done";
export interface Criterion { text: string; threshold: string; evidenceType: string; status: CriterionStatus; evidence: string[]; }
export interface WorkflowReport { summary: string; evidence: string[]; limitations: string; remainingWork: string; sourceRevisionId?: string | undefined; }
export const EMPTY_GOAL: GoalDraft = { title: "", description: "", criteriaText: "", plan: "", reason: "" };
export const EMPTY_TASK: TaskDraft = { title: "", description: "", owner: "", filesText: "", input: "", output: "", verification: "", evidenceText: "", report: "", reason: "" };
export const EMPTY_REPORT: ReportDraft = { summary: "", evidenceText: "", limitations: "", remainingWork: "" };
const MAX_JSON = 256 * 1024;

function text(value: string, label: string, max: number, required = false): string {
  const result = value.trim();
  if (result.includes("\0")) throw new Error(`${label} contains a NUL character.`);
  if (required && !result) throw new Error(`${label} is required.`);
  if ([...result].length > max) throw new Error(`${label} must be at most ${max} characters.`);
  return result;
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function lines(value: string, label: string): string[] {
  const result = text(value, label, 32_000).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (result.length > 128) throw new Error(`${label} allows at most 128 entries.`);
  return [...new Set(result)];
}
export function jsonObject(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function parseJson(value: string): unknown {
  if (new TextEncoder().encode(value).byteLength > MAX_JSON) throw new Error("Native JSON exceeds the 256 KiB component limit.");
  return JSON.parse(value);
}
function objectJson(value: string): Record<string, unknown> {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Native metadata/roadmap must be a JSON object.");
  return parsed as Record<string, unknown>;
}
function serialize(value: unknown): string {
  const result = JSON.stringify(value);
  if (new TextEncoder().encode(result).byteLength > MAX_JSON) throw new Error("JSON exceeds the 256 KiB component limit.");
  return result;
}
function id(value: string, prefix: string): string {
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value) || value.length > 200) throw new Error(`A valid native ${prefix} ID is required.`);
  return value;
}
export function nativeScope(scope: WorkflowScope): { projectId?: string; conversationId?: string } {
  return { ...(scope.projectId === undefined ? {} : { projectId: id(scope.projectId, "project") }), ...(scope.conversationId === undefined ? {} : { conversationId: id(scope.conversationId, "conversation") }) };
}

export function createGoalRequest(scope: WorkflowScope, draft: GoalDraft, key: string): CreateGoalRequest {
  const criteria = lines(draft.criteriaText, "Acceptance criteria").map((value, index) => ({ id: `criterion_${index + 1}`, text: value, threshold: "", evidenceType: "", status: "planned", evidence: [] }));
  return { ...nativeScope(scope), title: text(draft.title, "Goal title", 500, true), description: text(draft.description, "Objective", 16_000), acceptanceCriteriaJson: serialize(criteria), roadmapJson: serialize({ overview: text(draft.plan, "Plan", 16_000) }), metadataJson: "{}", status: "draft", idempotencyKey: key };
}

function goalPayload(snapshot: GoalSnapshot) {
  const goal = snapshot.goal;
  const criteria = parseJson(goal.acceptanceCriteriaJson);
  if (!Array.isArray(criteria)) throw new Error("Native acceptance criteria must be an array.");
  return { schemaVersion: 1, title: goal.title, description: goal.description, acceptanceCriteria: criteria, roadmap: objectJson(goal.roadmapJson), metadata: objectJson(goal.metadataJson), status: goal.status, stateRevisionId: goal.stateRevisionId };
}
function revision(snapshot: GoalSnapshot, payload: ReturnType<typeof goalPayload>, key: string, reason: string): CreateGoalRevisionRequest {
  payload.metadata = { ...payload.metadata, workflowUi: { ...jsonObject(payload.metadata.workflowUi), revisionReason: text(reason, "Revision reason", 4_000, true), previousRevisionId: snapshot.goal.currentRevisionId, previousContentSha256: snapshot.goal.canonicalPayloadSha256 } };
  // Validate every component separately; native independently verifies and hashes.
  for (const component of [payload.acceptanceCriteria, payload.roadmap, payload.metadata]) serialize(component);
  const payloadJson = JSON.stringify(payload);
  if (new TextEncoder().encode(payloadJson).byteLength > 512 * 1024) throw new Error("Goal revision exceeds the 512 KiB native limit.");
  return { goalId: snapshot.goal.id, expectedCurrentRevisionId: snapshot.goal.currentRevisionId, ...(snapshot.goal.stateRevisionId ? { stateRevisionId: snapshot.goal.stateRevisionId } : {}), payloadJson, idempotencyKey: key };
}
export function goalRevisionRequest(snapshot: GoalSnapshot, draft: GoalDraft, key: string): CreateGoalRevisionRequest {
  const payload = goalPayload(snapshot);
  payload.title = text(draft.title, "Goal title", 500, true);
  payload.description = text(draft.description, "Objective", 16_000) || null;
  payload.roadmap = { ...payload.roadmap, overview: text(draft.plan, "Plan", 16_000) };
  return revision(snapshot, payload, key, draft.reason);
}
export function readCriteria(snapshot: GoalSnapshot): Criterion[] {
  return goalPayload(snapshot).acceptanceCriteria.map((item): Criterion => {
    const value = jsonObject(item);
    const fallback = typeof item === "string" ? item : JSON.stringify(item);
    const status = value.status;
    return { text: typeof value.text === "string" ? value.text : typeof value.requirement === "string" ? value.requirement : fallback, threshold: typeof value.threshold === "string" ? value.threshold : "", evidenceType: typeof value.evidenceType === "string" ? value.evidenceType : "", status: status === "partial" || status === "blocked" || status === "done" ? status : "planned", evidence: strings(value.evidence) };
  });
}
export function updateCriterion(snapshot: GoalSnapshot, index: number | null, input: Criterion, key: string): CreateGoalRevisionRequest {
  const payload = goalPayload(snapshot);
  if (index !== null && (!Number.isInteger(index) || index < 0 || index >= payload.acceptanceCriteria.length)) throw new Error("The selected acceptance criterion is no longer available.");
  const criterion: Criterion = { text: text(input.text, "Criterion", 4_000, true), threshold: text(input.threshold, "Measurable threshold", 4_000, true), evidenceType: text(input.evidenceType, "Evidence type", 1_000, true), status: input.status, evidence: lines(input.evidence.join("\n"), "Evidence references") };
  if (!["planned", "partial", "blocked", "done"].includes(input.status)) throw new Error("Unsupported criterion status.");
  if (input.status === "done" && criterion.evidence.length === 0) throw new Error("Done requires an explicit evidence reference; native does not verify receipt contents.");
  if (index === null) {
    if (payload.acceptanceCriteria.length >= 128) throw new Error("This panel allows at most 128 acceptance criteria.");
    payload.acceptanceCriteria.push({ ...criterion });
  } else payload.acceptanceCriteria[index] = { ...jsonObject(payload.acceptanceCriteria[index]), ...criterion };
  return revision(snapshot, payload, key, index === null ? "Added acceptance criterion" : "Updated acceptance criterion and evidence");
}
export function readReports(snapshot: GoalSnapshot): WorkflowReport[] {
  const reports = jsonObject(objectJson(snapshot.goal.metadataJson).workflowUi).reports;
  if (!Array.isArray(reports)) return [];
  return reports.map((entry) => { const item = jsonObject(entry); return { summary: typeof item.summary === "string" ? item.summary : "Unrecognized report (see native metadata)", evidence: strings(item.evidence), limitations: typeof item.limitations === "string" ? item.limitations : "", remainingWork: typeof item.remainingWork === "string" ? item.remainingWork : "", sourceRevisionId: typeof item.sourceRevisionId === "string" ? item.sourceRevisionId : undefined }; });
}
export function appendReport(snapshot: GoalSnapshot, draft: ReportDraft, key: string): CreateGoalRevisionRequest {
  const payload = goalPayload(snapshot);
  const workflow = jsonObject(payload.metadata.workflowUi);
  const previous = workflow.reports === undefined ? [] : workflow.reports;
  if (!Array.isArray(previous)) throw new Error("Existing report metadata has an unsupported shape; inspect it before editing.");
  if (previous.length >= 128) throw new Error("This panel allows at most 128 reports per goal.");
  const report = { summary: text(draft.summary, "Report summary", 16_000, true), evidence: lines(draft.evidenceText, "Evidence references"), limitations: text(draft.limitations, "Limitations", 8_000), remainingWork: text(draft.remainingWork, "Remaining work", 8_000), sourceRevisionId: snapshot.goal.currentRevisionId };
  payload.metadata = { ...payload.metadata, workflowUi: { ...workflow, reports: [...previous, report] } };
  return revision(snapshot, payload, key, "Appended human evidence report");
}
export function completionBlockers(snapshot: GoalSnapshot, tasks: TaskSummary[], taskLimitReached: boolean): string[] {
  const criteria = readCriteria(snapshot);
  const blockers: string[] = [];
  if (!criteria.length) blockers.push("Add measurable acceptance criteria and evidence.");
  if (criteria.some((criterion) => criterion.status !== "done" || !criterion.threshold || !criterion.evidenceType || !criterion.evidence.length)) blockers.push("Acceptance criteria need Done status, a threshold, an evidence type and evidence references.");
  if (tasks.some((task) => task.status !== "completed")) blockers.push(`${tasks.filter((task) => task.status !== "completed").length} plan task(s) remain uncompleted.`);
  if (!tasks.length) blockers.push("Add at least one native plan task before declaring completion.");
  if (taskLimitReached) blockers.push("Task list reached its native limit; complete work cannot be established.");
  const latest = readReports(snapshot).at(-1);
  if (!latest?.summary || !latest.evidence.length) blockers.push("Append an evidence report before declaring completion.");
  if (latest?.remainingWork.trim()) blockers.push("The latest report still records remaining work.");
  return blockers;
}

export function goalDraft(snapshot: GoalSnapshot): GoalDraft {
  const payload = goalPayload(snapshot);
  return { title: snapshot.goal.title, description: snapshot.goal.description ?? "", criteriaText: "", plan: typeof payload.roadmap.overview === "string" ? payload.roadmap.overview : "", reason: "" };
}
function taskMetadata(draft: TaskDraft, previous: Record<string, unknown> = {}): Record<string, unknown> {
  const files = lines(draft.filesText, "Task files");
  if (!files.length) throw new Error("Task files or ownership scope is required.");
  return { ...previous, workflowUi: { ...jsonObject(previous.workflowUi), owner: text(draft.owner, "Task owner", 500, true), files, input: text(draft.input, "Task input", 8_000, true), output: text(draft.output, "Task output", 8_000, true), verification: text(draft.verification, "Task verification", 8_000, true), evidence: lines(draft.evidenceText, "Task evidence"), report: text(draft.report, "Task report", 8_000) } };
}
export function taskRequest(goal: GoalSnapshot, draft: TaskDraft, key: string): CreateTaskRequest {
  return { goalId: goal.goal.id, ...(goal.goal.projectId ? { projectId: goal.goal.projectId } : {}), ...(goal.goal.conversationId ? { conversationId: goal.goal.conversationId } : {}), ...(goal.goal.branchId ? { branchId: goal.goal.branchId } : {}), ...(goal.goal.stateRevisionId ? { stateRevisionId: goal.goal.stateRevisionId } : {}), title: text(draft.title, "Task title", 500, true), description: text(draft.description, "Task description", 16_000), status: "pending", metadataJson: serialize(taskMetadata(draft)), idempotencyKey: key };
}
export function taskRevisionRequest(snapshot: TaskSnapshot, draft: TaskDraft, key: string): CreateTaskRevisionRequest {
  const metadata = taskMetadata(draft, objectJson(snapshot.task.metadataJson));
  metadata.workflowUi = { ...jsonObject(metadata.workflowUi), revisionReason: text(draft.reason, "Revision reason", 4_000, true), previousRevisionId: snapshot.task.currentRevisionId, previousContentSha256: snapshot.task.canonicalPayloadSha256 };
  serialize(metadata);
  return { taskId: snapshot.task.id, expectedCurrentRevisionId: snapshot.task.currentRevisionId, ...(snapshot.task.stateRevisionId ? { stateRevisionId: snapshot.task.stateRevisionId } : {}), payloadJson: JSON.stringify({ schemaVersion: 1, title: text(draft.title, "Task title", 500, true), description: text(draft.description, "Task description", 16_000) || null, metadata, status: snapshot.task.status, stateRevisionId: snapshot.task.stateRevisionId }), idempotencyKey: key };
}
export function taskDraft(snapshot: TaskSnapshot): TaskDraft {
  const metadata = jsonObject(objectJson(snapshot.task.metadataJson).workflowUi);
  const string = (name: string) => typeof metadata[name] === "string" ? metadata[name] as string : "";
  return { title: snapshot.task.title, description: snapshot.task.description ?? "", owner: string("owner"), filesText: strings(metadata.files).join("\n"), input: string("input"), output: string("output"), verification: string("verification"), evidenceText: strings(metadata.evidence).join("\n"), report: string("report"), reason: "" };
}
export function taskCompletionBlockers(snapshot: TaskSnapshot): string[] {
  const value = taskDraft(snapshot);
  const blockers: string[] = [];
  if (![value.owner, value.filesText, value.input, value.output, value.verification].every((item) => item.trim())) blockers.push("Task requires owner, files/scope, input, output and verification.");
  if (!value.evidenceText.trim() || !value.report.trim()) blockers.push("Task completion requires an explicit report and evidence reference.");
  return blockers;
}
export const GOAL_TRANSITIONS: Record<GoalRecord["status"], GoalRecord["status"][]> = { draft: ["active", "archived", "cancelled"], active: ["paused", "completed", "archived", "cancelled"], paused: ["active", "archived", "cancelled"], completed: ["archived"], archived: [], cancelled: [] };
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = { pending: ["ready", "in_progress", "blocked", "cancelled", "archived"], ready: ["in_progress", "blocked", "cancelled", "archived"], in_progress: ["ready", "blocked", "completed", "cancelled"], blocked: ["ready", "in_progress", "cancelled", "archived"], completed: ["archived"], cancelled: ["archived"], archived: [] };
