import { cloneElement, useId, useState, type FormEvent, type ReactElement } from "react";
import { Plus, Save, X } from "lucide-react";
import { EMPTY_REPORT, type Criterion, type CriterionStatus, type GoalDraft, type ReportDraft, type TaskDraft } from "./workflow-model";

function Field({ label, children, hint }: { label: string; children: ReactElement<{ id?: string; "aria-describedby"?: string }>; hint?: string }) {
  const id = useId();
  return <div className="rb-workflow-field"><label htmlFor={id}>{label}</label>{cloneElement(children, { id, ...(hint ? { "aria-describedby": `${id}-hint` } : {}) })}{hint ? <small id={`${id}-hint`}>{hint}</small> : null}</div>;
}
function Actions({ label, cancel, busy }: { label: string; cancel: () => void; busy: boolean }) {
  return <div className="rb-workflow-form-actions"><button type="button" className="rb-workflow-button" onClick={cancel} disabled={busy}><X aria-hidden="true" />Cancel editing</button><button type="submit" className="rb-workflow-button rb-workflow-primary" disabled={busy}><Save aria-hidden="true" />{busy ? "Saving native record…" : label}</button></div>;
}
function submit(event: FormEvent, action: () => void) { event.preventDefault(); action(); }

export function GoalEditor({ initial, creating, busy, onSave, onCancel }: { initial: GoalDraft; creating: boolean; busy: boolean; onSave: (draft: GoalDraft) => Promise<boolean>; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const field = (name: keyof GoalDraft, value: string) => setDraft((current) => ({ ...current, [name]: value }));
  return <form className="rb-workflow-editor" aria-label={creating ? "Create goal" : "Edit goal"} onSubmit={(event) => submit(event, () => { void onSave(draft); })}>
    <h3>{creating ? "Create a durable draft" : "Edit goal and plan"}</h3>
    <p>{creating ? "A goal starts as a draft. Creating it does not run tasks or mark acceptance criteria complete." : "Saving creates an immutable native revision and checks the current revision before changing it."}</p>
    <fieldset disabled={busy}>
      <Field label="Goal title"><input autoFocus value={draft.title} maxLength={500} required onChange={(event) => field("title", event.target.value)} /></Field>
      <Field label="Objective"><textarea value={draft.description} maxLength={16_000} rows={3} onChange={(event) => field("description", event.target.value)} /></Field>
      {creating ? <Field label="Acceptance criteria" hint="One criterion per line. Add measurable thresholds and evidence after creating the draft."><textarea value={draft.criteriaText} rows={4} onChange={(event) => field("criteriaText", event.target.value)} /></Field> : null}
      <Field label="Plan overview" hint="Use native plan tasks below for owner, files, inputs, outputs and verification."><textarea value={draft.plan} maxLength={16_000} rows={4} onChange={(event) => field("plan", event.target.value)} /></Field>
      {!creating ? <Field label="Revision reason"><textarea value={draft.reason} maxLength={4_000} required rows={2} onChange={(event) => field("reason", event.target.value)} /></Field> : null}
    </fieldset>
    <Actions label={creating ? "Create draft goal" : "Save goal revision"} cancel={onCancel} busy={busy} />
  </form>;
}

export function CriterionEditor({ initial, busy, onSave, onCancel }: { initial: Criterion; busy: boolean; onSave: (draft: Criterion) => Promise<boolean>; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [evidence, setEvidence] = useState(initial.evidence.join("\n"));
  return <form className="rb-workflow-editor" aria-label="Edit acceptance evidence" onSubmit={(event) => submit(event, () => { void onSave({ ...draft, evidence: evidence.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) }); })}>
    <h3>Acceptance and evidence</h3><p>Done is a recorded declaration. This panel preserves references; it does not open or independently verify their contents.</p>
    <fieldset disabled={busy}>
      <Field label="Criterion"><textarea autoFocus required rows={2} maxLength={4_000} value={draft.text} onChange={(event) => setDraft({ ...draft, text: event.target.value })} /></Field>
      <Field label="Measurable threshold"><input required maxLength={4_000} value={draft.threshold} onChange={(event) => setDraft({ ...draft, threshold: event.target.value })} /></Field>
      <Field label="Evidence type"><input required maxLength={1_000} value={draft.evidenceType} onChange={(event) => setDraft({ ...draft, evidenceType: event.target.value })} /></Field>
      <Field label="Criterion status"><select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as CriterionStatus })}>{["planned", "partial", "blocked", "done"].map((status) => <option key={status} value={status}>{status}</option>)}</select></Field>
      <Field label="Evidence references" hint="One receipt path, artifact ID or citation per line. References are stored as text."><textarea rows={3} value={evidence} onChange={(event) => setEvidence(event.target.value)} /></Field>
    </fieldset>
    <Actions label="Save criterion" cancel={onCancel} busy={busy} />
  </form>;
}

export function TaskEditor({ initial, creating, busy, onSave, onCancel }: { initial: TaskDraft; creating: boolean; busy: boolean; onSave: (draft: TaskDraft) => Promise<boolean>; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const field = (name: keyof TaskDraft, value: string) => setDraft((current) => ({ ...current, [name]: value }));
  return <form className="rb-workflow-editor" aria-label={creating ? "Create plan task" : "Edit plan task"} onSubmit={(event) => submit(event, () => { void onSave(draft); })}>
    <h3>{creating ? "Add an atomic plan task" : "Edit task and report"}</h3><p>Each task records ownership, input, output and verification. Task status is changed separately.</p>
    <fieldset disabled={busy}>
      <Field label="Task title"><input autoFocus required maxLength={500} value={draft.title} onChange={(event) => field("title", event.target.value)} /></Field>
      <Field label="Task description"><textarea maxLength={16_000} rows={2} value={draft.description} onChange={(event) => field("description", event.target.value)} /></Field>
      <Field label="Task owner"><input required maxLength={500} value={draft.owner} onChange={(event) => field("owner", event.target.value)} /></Field>
      <Field label="Files or ownership scope" hint="One file or explicit ownership scope per line."><textarea required rows={2} value={draft.filesText} onChange={(event) => field("filesText", event.target.value)} /></Field>
      <div className="rb-workflow-field-grid"><Field label="Task input"><textarea required maxLength={8_000} rows={2} value={draft.input} onChange={(event) => field("input", event.target.value)} /></Field><Field label="Task output"><textarea required maxLength={8_000} rows={2} value={draft.output} onChange={(event) => field("output", event.target.value)} /></Field></div>
      <Field label="Task verification"><textarea required maxLength={8_000} rows={2} value={draft.verification} onChange={(event) => field("verification", event.target.value)} /></Field>
      <Field label="Task evidence references"><textarea rows={2} value={draft.evidenceText} onChange={(event) => field("evidenceText", event.target.value)} /></Field>
      <Field label="Task report"><textarea rows={2} maxLength={8_000} value={draft.report} onChange={(event) => field("report", event.target.value)} /></Field>
      {!creating ? <Field label="Revision reason"><textarea required rows={2} maxLength={4_000} value={draft.reason} onChange={(event) => field("reason", event.target.value)} /></Field> : null}
    </fieldset>
    <Actions label={creating ? "Create plan task" : "Save task revision"} cancel={onCancel} busy={busy} />
  </form>;
}

export function ReportEditor({ busy, onSave, onCancel }: { busy: boolean; onSave: (draft: ReportDraft) => Promise<boolean>; onCancel: () => void }) {
  const [draft, setDraft] = useState(EMPTY_REPORT);
  const field = (name: keyof ReportDraft, value: string) => setDraft((current) => ({ ...current, [name]: value }));
  return <form className="rb-workflow-editor" aria-label="Add evidence report" onSubmit={(event) => submit(event, () => { void onSave(draft); })}>
    <h3>Append an evidence report</h3><p>Reports are stored in native goal metadata with the source revision. They do not change goal or task status.</p>
    <fieldset disabled={busy}>
      <Field label="Report summary"><textarea autoFocus required rows={3} maxLength={16_000} value={draft.summary} onChange={(event) => field("summary", event.target.value)} /></Field>
      <Field label="Report evidence references"><textarea rows={3} value={draft.evidenceText} onChange={(event) => field("evidenceText", event.target.value)} /></Field>
      <Field label="Limitations"><textarea rows={2} maxLength={8_000} value={draft.limitations} onChange={(event) => field("limitations", event.target.value)} /></Field>
      <Field label="Remaining work"><textarea rows={2} maxLength={8_000} value={draft.remainingWork} onChange={(event) => field("remainingWork", event.target.value)} /></Field>
    </fieldset>
    <div className="rb-workflow-form-actions"><button type="button" className="rb-workflow-button" disabled={busy} onClick={onCancel}>Cancel editing</button><button type="submit" className="rb-workflow-button rb-workflow-primary" disabled={busy}><Plus aria-hidden="true" />Append report</button></div>
  </form>;
}
