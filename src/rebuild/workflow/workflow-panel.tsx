import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { BookOpenCheck, CheckCircle2, ChevronRight, ClipboardList, FileCheck2, History, Pencil, Plus, RefreshCw, ShieldAlert, X } from "lucide-react";
import type { GoalRecord, TaskStatus } from "@/lib/desktop";
import { createNativeWorkflowApi, WorkflowController, type WorkflowState } from "./workflow-controller";
import { CriterionEditor, GoalEditor, ReportEditor, TaskEditor } from "./workflow-editors";
import { completionBlockers, EMPTY_GOAL, EMPTY_TASK, goalDraft, GOAL_TRANSITIONS, jsonObject, parseJson, readCriteria, readReports, taskCompletionBlockers, taskDraft, TASK_TRANSITIONS, type Criterion, type WorkflowScope } from "./workflow-model";
import "./workflow.css";

export interface WorkflowPanelProps extends WorkflowScope { onClose?: (() => void) | undefined; }
type Editor = { kind: "create-goal" } | { kind: "edit-goal" } | { kind: "criterion"; index: number | null; value: Criterion } | { kind: "create-task" } | { kind: "edit-task" } | { kind: "report" };
function Badge({ children }: { children: ReactNode }) { return <span className="rb-workflow-badge">{children}</span>; }
function Evidence({ items }: { items: string[] }) { return items.length ? <ul className="rb-workflow-evidence">{items.map((item, index) => <li key={`${index}-${item}`}><FileCheck2 aria-hidden="true" /><code>{item}</code></li>)}</ul> : <p className="rb-workflow-muted">No evidence references recorded.</p>; }
function NativeJson({ label, value }: { label: string; value: unknown }) { return <details className="rb-workflow-json"><summary>{label}</summary><pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre></details>; }
function scopeLabel(scope: WorkflowScope): string {
  if (scope.conversationId) return `Native conversation: ${scope.conversationId}${scope.projectId ? ` · Project: ${scope.projectId}` : ""}`;
  if (scope.projectId) return `Native project: ${scope.projectId} · No native conversation link`;
  return "Native scope: local profile · No native conversation link";
}

/** Inline surface; the root owns overlay semantics and the shell trigger. */
export function WorkflowPanel({ sessionId, projectId, conversationId, onClose }: WorkflowPanelProps) {
  const controller = useMemo(() => new WorkflowController(createNativeWorkflowApi()), []);
  useEffect(() => {
    controller.setScope({ ...(sessionId === undefined ? {} : { sessionId }), ...(projectId === undefined ? {} : { projectId }), ...(conversationId === undefined ? {} : { conversationId }) });
    void controller.refresh();
    return () => { controller.cancelRead(); };
  }, [controller, sessionId, projectId, conversationId]);
  return <WorkflowPanelView controller={controller} onClose={onClose} autoLoad={false} />;
}

export function WorkflowPanelView({ controller, onClose, autoLoad = true }: { controller: WorkflowController; onClose?: (() => void) | undefined; autoLoad?: boolean }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [query, setQuery] = useState("");
  const [goalStatus, setGoalStatus] = useState<GoalRecord["status"]>("paused");
  const [taskStatus, setTaskStatus] = useState<TaskStatus>("ready");
  const [historyId, setHistoryId] = useState("");
  const trigger = useRef<HTMLElement | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scopeKey = JSON.stringify(state.scope);
  useEffect(() => { if (autoLoad) void controller.refresh(); return () => { controller.cancelRead(); }; }, [autoLoad, controller]);
  useEffect(() => { setEditor(null); setHistoryId(""); }, [scopeKey, state.selectedGoalId]);
  useEffect(() => { setEditor((current) => current?.kind === "edit-task" ? null : current); }, [state.selectedTaskId]);
  useEffect(() => { if (state.error) errorRef.current?.focus(); }, [state.error]);
  useEffect(() => { if (state.goal) setGoalStatus(GOAL_TRANSITIONS[state.goal.goal.status][0] ?? state.goal.goal.status); }, [state.goal]);
  useEffect(() => { if (state.task) setTaskStatus(TASK_TRANSITIONS[state.task.task.status][0] ?? state.task.task.status); }, [state.task]);
  const available = state.status !== "unavailable";
  const locked = state.busy || !available || state.mutationUncertain;
  const goals = state.goals.filter((goal) => `${goal.title} ${goal.id} ${goal.status}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const goal = state.goal;
  const criteria = goal ? readCriteria(goal) : [];
  const reports = goal ? readReports(goal) : [];
  const blockers = goal ? completionBlockers(goal, state.tasks, state.taskLimitReached) : [];
  const task = state.task;
  const taskData = task ? taskDraft(task) : null;
  function open(value: Editor) { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setEditor(value); }
  function cancelEditor() { setEditor(null); queueMicrotask(() => { const target = trigger.current; if (target?.isConnected) target.focus(); else titleRef.current?.focus(); }); }
  async function save(run: () => Promise<boolean>): Promise<boolean> { const saved = await run(); if (saved) cancelEditor(); return saved; }
  function escape(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    if (editor) { event.preventDefault(); event.stopPropagation(); if (!state.mutating) cancelEditor(); }
    else if (onClose) { event.preventDefault(); event.stopPropagation(); onClose(); }
  }
  return <section className="rb-workflow" role="region" aria-label="Goals and evidence" onKeyDown={escape}>
    <header className="rb-workflow-header"><div className="rb-workflow-title"><BookOpenCheck aria-hidden="true" /><div><p className="rb-workflow-eyebrow">Omnia / workflow</p><h2 ref={titleRef} tabIndex={-1}>Goals and evidence</h2></div></div><div className="rb-workflow-toolbar"><button type="button" className="rb-workflow-button" onClick={() => { void controller.refresh(); }} disabled={state.busy || !available || editor !== null}><RefreshCw aria-hidden="true" />Refresh goals</button>{onClose ? <button type="button" className="rb-workflow-button rb-workflow-icon" aria-label="Close goals and evidence" onClick={onClose}><X aria-hidden="true" /></button> : null}</div></header>
    <div className="rb-workflow-boundary"><ShieldAlert aria-hidden="true" /><div><strong>Native planning records</strong><p>Stored plans are preview-only and do not dispatch work. Status and evidence are explicit user records; references are not independently verified here.</p><p>{scopeLabel(state.scope)}</p>{state.scope.sessionId ? <p>Current chat context: <code>{state.scope.sessionId}</code>. A harness session is not a native conversation link.</p> : null}</div></div>
    <div className="rb-workflow-feedback">
      {state.error ? <div ref={errorRef} tabIndex={-1} role="alert" className="rb-workflow-error"><strong>{state.status === "denied" ? "Permission denied" : state.status === "missing" ? "Native record missing" : state.status === "unavailable" ? "Native workflow unavailable" : "Operation could not finish"}</strong><p>{state.error.message}</p><small>Code: {state.error.code}. {state.mutationUncertain ? "Outcome unknown: refresh and inspect records before another write. No automatic retry was sent." : "Review the input or native permission, then refresh. Existing drafts are retained."}</small></div> : null}
      {!available && !state.error ? <p role="status">Goals and tasks require the Tauri desktop runtime. Browser preview does not persist native planning records.</p> : null}
      <p className="rb-workflow-status" role="status" aria-live="polite">{state.busy ? state.mutating ? "Saving native planning record…" : "Reading native planning records…" : state.notice}</p>
      {state.busy && !state.mutating ? <button type="button" className="rb-workflow-button" onClick={() => controller.cancelRead()}>Cancel read</button> : null}
    </div>
    <div className="rb-workflow-body">
      <aside className="rb-workflow-sidebar" aria-label="Saved goals"><div className="rb-workflow-section-head"><h3>Saved goals</h3><Badge>{state.goals.length}{state.goalLimitReached ? "+" : ""}</Badge></div><label className="rb-workflow-search"><span>Filter goals</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label><button type="button" className="rb-workflow-button rb-workflow-primary" disabled={locked || editor !== null} onClick={() => open({ kind: "create-goal" })}><Plus aria-hidden="true" />New goal</button><div className="rb-workflow-goal-list">{goals.map((item) => <button type="button" className={`rb-workflow-goal-row${state.selectedGoalId === item.id ? " is-selected" : ""}`} key={item.id} disabled={state.mutating || editor !== null} aria-pressed={state.selectedGoalId === item.id} onClick={() => { void controller.selectGoal(item.id); }}><span><strong>{item.title}</strong><small>{item.status}</small></span><ChevronRight aria-hidden="true" /></button>)}</div>{available && !state.busy && !state.error && !state.goals.length ? <p className="rb-workflow-muted">No native goals in this scope. Create a draft to record your objective.</p> : null}{state.goals.length > 0 && !goals.length ? <p className="rb-workflow-muted">No goal matches this filter.</p> : null}{state.goalLimitReached ? <p className="rb-workflow-muted">Native list limit reached (256). Use a project or conversation scope to narrow it.</p> : null}</aside>
      <section className="rb-workflow-detail" role="region" aria-label="Goal inspector" aria-busy={state.busy}>
        {editor?.kind === "create-goal" ? <GoalEditor creating initial={EMPTY_GOAL} busy={state.busy} onCancel={cancelEditor} onSave={(draft) => save(() => controller.createGoal(draft))} /> : null}
        {editor?.kind === "edit-goal" && goal ? <GoalEditor creating={false} initial={goalDraft(goal)} busy={state.busy} onCancel={cancelEditor} onSave={(draft) => save(() => controller.saveGoal(draft))} /> : null}
        {editor?.kind === "criterion" && goal ? <CriterionEditor initial={editor.value} busy={state.busy} onCancel={cancelEditor} onSave={(draft) => save(() => controller.saveCriterion(editor.index, draft))} /> : null}
        {editor?.kind === "create-task" && goal ? <TaskEditor creating initial={EMPTY_TASK} busy={state.busy} onCancel={cancelEditor} onSave={(draft) => save(() => controller.createTask(draft))} /> : null}
        {editor?.kind === "edit-task" && taskData ? <TaskEditor creating={false} initial={taskData} busy={state.busy} onCancel={cancelEditor} onSave={(draft) => save(() => controller.saveTask(draft))} /> : null}
        {editor?.kind === "report" && goal ? <ReportEditor busy={state.busy} onCancel={cancelEditor} onSave={(draft) => save(() => controller.addReport(draft))} /> : null}
        {!editor && !goal ? <div className="rb-workflow-empty"><ClipboardList aria-hidden="true" /><h3>{state.busy ? "Loading native goal…" : "A goal keeps the evidence together"}</h3><p>Select a saved goal to inspect its objective, acceptance criteria, atomic tasks, reports and immutable revisions.</p></div> : null}
        {!editor && goal ? <>
          <div className="rb-workflow-section-head"><div><p className="rb-workflow-eyebrow">Native goal · Revision {goal.currentRevision.revisionNo}</p><h3 className="rb-workflow-objective-title">{goal.goal.title}</h3></div><button type="button" className="rb-workflow-button" disabled={locked} onClick={() => open({ kind: "edit-goal" })}><Pencil aria-hidden="true" />Edit goal</button></div>
          <div className="rb-workflow-chips"><Badge>{goal.goal.status}</Badge><Badge>Integrity: {goal.integrity}</Badge><Badge>{goal.executionDisposition}</Badge></div>
          <p className="rb-workflow-description">{goal.goal.description || "No objective description recorded."}</p>
          <GoalStatus state={state} chosen={goalStatus} choose={setGoalStatus} locked={locked} blockers={blockers} change={() => { void controller.setGoalStatus(goalStatus); }} />
          <section className="rb-workflow-section" aria-labelledby="rb-workflow-remaining"><div className="rb-workflow-section-head"><h4 id="rb-workflow-remaining">Remaining work</h4><Badge>{blockers.length} completion gates open</Badge></div>{blockers.length ? <ul className="rb-workflow-remaining">{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : <p>Recorded criteria, task evidence and report fields are populated. Completion still requires an explicit status action and native acceptance.</p>}<small>Native status updates do not lock the whole task set. Concurrent task changes may require another review; this panel is not an independent completion audit.</small></section>
          <section className="rb-workflow-section" aria-label="Acceptance criteria"><div className="rb-workflow-section-head"><h4><CheckCircle2 aria-hidden="true" />Acceptance criteria</h4><button type="button" className="rb-workflow-button" disabled={locked} onClick={() => open({ kind: "criterion", index: null, value: { text: "", threshold: "", evidenceType: "", status: "planned", evidence: [] } })}><Plus aria-hidden="true" />Add criterion</button></div>{criteria.length ? criteria.map((criterion, index) => <article className="rb-workflow-card" key={index}><div className="rb-workflow-section-head"><h5>{criterion.text}</h5><button type="button" className="rb-workflow-button rb-workflow-icon" aria-label={`Edit criterion ${index + 1}`} disabled={locked} onClick={() => open({ kind: "criterion", index, value: criterion })}><Pencil aria-hidden="true" /></button></div><div className="rb-workflow-chips"><Badge>{criterion.status}</Badge><span>{criterion.threshold || "Threshold missing"}</span></div><p>Evidence type: {criterion.evidenceType || "Not recorded"}</p><Evidence items={criterion.evidence} /></article>) : <p className="rb-workflow-muted">No acceptance criteria. A plan alone does not establish completion.</p>}</section>
          <section className="rb-workflow-section" aria-label="Atomic plan"><div className="rb-workflow-section-head"><h4><ClipboardList aria-hidden="true" />Atomic plan</h4><button type="button" className="rb-workflow-button" disabled={locked} onClick={() => open({ kind: "create-task" })}><Plus aria-hidden="true" />Add task</button></div><p className="rb-workflow-description">{String(jsonObject(parseJson(goal.goal.roadmapJson)).overview ?? "No plan overview recorded.")}</p>{state.tasks.map((item) => <button type="button" className={`rb-workflow-task-row${state.selectedTaskId === item.id ? " is-selected" : ""}`} key={item.id} disabled={state.busy} aria-pressed={state.selectedTaskId === item.id} onClick={() => { void controller.selectTask(item.id); }}><span>{item.title}</span><Badge>{item.status.replaceAll("_", " ")}</Badge></button>)}{!state.tasks.length ? <p className="rb-workflow-muted">No native tasks yet.</p> : null}{state.taskLimitReached ? <p>Task limit reached. Completion cannot be established from this truncated list.</p> : null}{task && taskData ? <article className="rb-workflow-card"><div className="rb-workflow-section-head"><h5>{task.task.title}</h5><button type="button" className="rb-workflow-button" disabled={locked} onClick={() => open({ kind: "edit-task" })}><Pencil aria-hidden="true" />Edit task</button></div><dl className="rb-workflow-task-details"><dt>Owner</dt><dd>{taskData.owner || "Not recorded"}</dd><dt>Files / scope</dt><dd>{taskData.filesText || "Not recorded"}</dd><dt>Input</dt><dd>{taskData.input || "Not recorded"}</dd><dt>Output</dt><dd>{taskData.output || "Not recorded"}</dd><dt>Verification</dt><dd>{taskData.verification || "Not recorded"}</dd><dt>Report</dt><dd>{taskData.report || "Not recorded"}</dd></dl><Evidence items={taskData.evidenceText.split(/\r?\n/).filter(Boolean)} /><div className="rb-workflow-status-form"><label>Task status<select value={taskStatus} disabled={locked || !TASK_TRANSITIONS[task.task.status].length} onChange={(event) => setTaskStatus(event.target.value as TaskStatus)}>{TASK_TRANSITIONS[task.task.status].length ? TASK_TRANSITIONS[task.task.status].map((value) => <option value={value} key={value}>{value.replaceAll("_", " ")}</option>) : <option value={task.task.status}>{task.task.status}</option>}</select></label><button type="button" className="rb-workflow-button" disabled={locked || !TASK_TRANSITIONS[task.task.status].length || (taskStatus === "completed" && taskCompletionBlockers(task).length > 0)} onClick={() => { void controller.setTaskStatus(taskStatus); }}>Record task status</button></div><NativeJson label={`Task revision and dependencies (${task.dependencies.length})`} value={{ currentRevision: task.currentRevision, dependencies: task.dependencies, metadata: parseJson(task.task.metadataJson) }} /></article> : null}</section>
          <section className="rb-workflow-section" aria-label="Evidence reports"><div className="rb-workflow-section-head"><h4><FileCheck2 aria-hidden="true" />Evidence reports</h4><button type="button" className="rb-workflow-button" disabled={locked} onClick={() => open({ kind: "report" })}><Plus aria-hidden="true" />Add report</button></div>{reports.length ? reports.map((report, index) => <article className="rb-workflow-card" key={index}><h5>{report.summary}</h5><Evidence items={report.evidence} /><dl className="rb-workflow-task-details"><dt>Limitations</dt><dd>{report.limitations || "None declared; not independently audited."}</dd><dt>Remaining work</dt><dd>{report.remainingWork || "None declared."}</dd><dt>Source revision</dt><dd><code>{report.sourceRevisionId || "Not recorded"}</code></dd></dl></article>) : <p className="rb-workflow-muted">No evidence report has been appended.</p>}</section>
          <section className="rb-workflow-section" aria-label="Native revision inspector"><h4><History aria-hidden="true" />Revision and provenance</h4><dl className="rb-workflow-task-details"><dt>Goal</dt><dd><code>{goal.goal.id}</code></dd><dt>Current revision</dt><dd><code>{goal.goal.currentRevisionId}</code></dd><dt>Content SHA-256</dt><dd><code>{goal.goal.canonicalPayloadSha256}</code></dd></dl><NativeJson label="Inspect exact native payload and metadata" value={{ currentRevision: goal.currentRevision, acceptanceCriteria: parseJson(goal.goal.acceptanceCriteriaJson), roadmap: parseJson(goal.goal.roadmapJson), metadata: parseJson(goal.goal.metadataJson) }} /><form className="rb-workflow-status-form" aria-label="Load historical goal revision" onSubmit={(event) => { event.preventDefault(); void controller.loadGoalRevision(historyId); }}><label>Historical revision ID<input value={historyId} onChange={(event) => setHistoryId(event.target.value)} /></label><button type="submit" className="rb-workflow-button" disabled={state.busy || !historyId.trim()}><History aria-hidden="true" />Load revision</button></form>{state.history ? <NativeJson label={`Loaded revision ${state.history.revisionNo} (read only)`} value={state.history} /> : null}</section>
        </> : null}
      </section>
    </div>
  </section>;
}

function GoalStatus({ state, chosen, choose, locked, blockers, change }: { state: WorkflowState; chosen: GoalRecord["status"]; choose: (status: GoalRecord["status"]) => void; locked: boolean; blockers: string[]; change: () => void }) {
  if (!state.goal) return null;
  const transitions = GOAL_TRANSITIONS[state.goal.goal.status];
  return <div className="rb-workflow-status-form"><label>Goal status<select value={chosen} disabled={locked || !transitions.length} onChange={(event) => choose(event.target.value as GoalRecord["status"])}>{transitions.length ? transitions.map((status) => <option value={status} key={status}>{status}</option>) : <option value={state.goal.goal.status}>{state.goal.goal.status}</option>}</select></label><button type="button" className="rb-workflow-button" disabled={locked || !transitions.length || (chosen === "completed" && blockers.length > 0)} onClick={change}>Record goal status</button>{chosen === "completed" && blockers.length > 0 ? <span className="rb-workflow-muted">Resolve the completion gates below.</span> : null}</div>;
}
