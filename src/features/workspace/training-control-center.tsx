import {
  Archive,
  Activity,
  Check,
  CheckCircle2,
  Clipboard,
  Database,
  Download,
  Eye,
  FileJson2,
  FlaskConical,
  Gauge,
  GitBranch,
  Layers3,
  LockKeyhole,
  Play,
  Redo2,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Timer,
  Undo2,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import RlaifLabPreview from "./rlaif-lab-preview";
import TrainingDatasetPipeline from "./training-dataset-pipeline";
import {
  buildTrainingCheckpointManifest,
  serializeTrainingCheckpointManifest,
  type TrainingCheckpointExportFormat,
} from "./training-checkpoint-preview";

type TrainingMode = "supervised" | "preference" | "distillation" | "retrieval";
type TrainingTab = "plan" | "dataset" | "pipeline" | "schedule" | "metrics" | "rlaif" | "checkpoints" | "export";
type TrainingStatus = "draft" | "ready" | "queued";
type ExportFormat = "json" | "markdown";

export type TrainingRecord = {
  id: string;
  title: string;
  source: string;
  examples: number;
  sensitivity: "low" | "moderate" | "high";
  eligible: boolean;
  selected: boolean;
  note: string;
};

export type TrainingSnapshot = {
  runName: string;
  mode: TrainingMode;
  dataset: string;
  candidate: string;
  compute: string;
  epochs: number;
  batchSize: number;
  learningRate: string;
  validationSplit: number;
  checkpointPolicy: string;
  evaluationCadence: string;
  activeTab: TrainingTab;
  status: TrainingStatus;
  records: TrainingRecord[];
  exportFormat: ExportFormat;
};

const modeLabels: Record<TrainingMode, string> = {
  supervised: "Supervised fine-tune",
  preference: "Preference tuning",
  distillation: "Distillation rehearsal",
  retrieval: "Retrieval / adapter rehearsal",
};

const sensitivityLabels: Record<TrainingRecord["sensitivity"], string> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
};

export const seedTrainingRecords: TrainingRecord[] = [
  {
    id: "train-feedback-001",
    title: "Helpful coding explanation",
    source: "Feedback review",
    examples: 18,
    sensitivity: "low",
    eligible: true,
    selected: true,
    note: "Approved quality signal with visible provenance.",
  },
  {
    id: "train-feedback-002",
    title: "Correction and rewrite pair",
    source: "Feedback review",
    examples: 12,
    sensitivity: "moderate",
    eligible: true,
    selected: true,
    note: "Useful contrast pair; keep the correction attached.",
  },
  {
    id: "train-run-001",
    title: "Renderer outcome marker",
    source: "Run projection",
    examples: 8,
    sensitivity: "low",
    eligible: true,
    selected: true,
    note: "Outcome marker only; no provider payload is included.",
  },
  {
    id: "train-memory-001",
    title: "UI-first workflow preference",
    source: "Memory proposal",
    examples: 6,
    sensitivity: "high",
    eligible: false,
    selected: false,
    note: "Blocked until explicit approval and native provenance exist.",
  },
  {
    id: "train-conversation-001",
    title: "Conversation excerpt candidate",
    source: "Conversation projection",
    examples: 9,
    sensitivity: "high",
    eligible: false,
    selected: false,
    note: "Held for consent, redaction, and source revision review.",
  },
];

export const initialTrainingSnapshot: TrainingSnapshot = {
  runName: "Omnia adapter rehearsal · quality lane",
  mode: "supervised",
  dataset: "Learning review · approved preview records",
  candidate: "Omnia primary route · adapter placeholder",
  compute: "Cloud GPU · estimate unknown",
  epochs: 3,
  batchSize: 4,
  learningRate: "2e-5",
  validationSplit: 20,
  checkpointPolicy: "Keep best + latest",
  evaluationCadence: "Every 250 steps",
  activeTab: "plan",
  status: "draft",
  records: seedTrainingRecords,
  exportFormat: "json",
};

const TRAINING_PREVIEW_MAX_BYTES = 512 * 1024;
const checkpointPolicies = ["Keep best + latest", "Keep latest only", "Manual approval per checkpoint"] as const;

function isTrainingMode(value: unknown): value is TrainingMode {
  return value === "supervised" || value === "preference" || value === "distillation" || value === "retrieval";
}

function isTrainingTab(value: unknown): value is TrainingTab {
  return value === "plan" || value === "dataset" || value === "pipeline" || value === "schedule" || value === "metrics" || value === "rlaif" || value === "checkpoints" || value === "export";
}

function isTrainingStatus(value: unknown): value is TrainingStatus {
  return value === "draft" || value === "ready" || value === "queued";
}

function isExportFormat(value: unknown): value is ExportFormat {
  return value === "json" || value === "markdown";
}

function assertPreviewString(value: unknown, field: string, maxLength = 256): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty string of at most ${maxLength} characters.`);
  }
}

function assertPreviewInteger(value: unknown, field: string, min: number, max: number): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  }
}

function cloneSnapshot(snapshot: TrainingSnapshot): TrainingSnapshot {
  return { ...snapshot, records: snapshot.records.map((record) => ({ ...record })) };
}

export function selectedTrainingRecords(snapshot: TrainingSnapshot): TrainingRecord[] {
  return snapshot.records.filter((record) => record.selected && record.eligible);
}

export function serializeTrainingPreview(snapshot: TrainingSnapshot, format: ExportFormat = snapshot.exportFormat): string {
  const selected = selectedTrainingRecords(snapshot);
  const payload = {
    schema: "omnia.training-control-center.preview.v1",
    scope: "renderer-session",
    generatedAt: new Date().toISOString(),
    plan: {
      runName: snapshot.runName,
      mode: snapshot.mode,
      dataset: snapshot.dataset,
      candidate: snapshot.candidate,
      compute: snapshot.compute,
      epochs: snapshot.epochs,
      batchSize: snapshot.batchSize,
      learningRate: snapshot.learningRate,
      validationSplit: snapshot.validationSplit,
      checkpointPolicy: snapshot.checkpointPolicy,
      evaluationCadence: snapshot.evaluationCadence,
    },
    state: {
      activeTab: snapshot.activeTab,
      status: snapshot.status,
      exportFormat: snapshot.exportFormat,
    },
    selectedRecordIds: selected.map((record) => record.id),
    heldRecordIds: snapshot.records.filter((record) => !selected.some((selectedRecord) => selectedRecord.id === record.id)).map((record) => record.id),
    checkpointManifest: buildTrainingCheckpointManifest({
      runName: snapshot.runName,
      epochs: snapshot.epochs,
      evaluationCadence: snapshot.evaluationCadence,
      checkpointPolicy: snapshot.checkpointPolicy,
    }),
    boundary: {
      modelTraining: false,
      providerRequest: false,
      checkpointWrite: false,
      durableDatasetWrite: false,
      nativeReceipt: false,
    },
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia Training Control Center preview",
    "",
    `Run: ${snapshot.runName}`,
    `Mode: ${modeLabels[snapshot.mode]}`,
    `Dataset: ${snapshot.dataset}`,
    `Selected examples: ${selected.reduce((sum, record) => sum + record.examples, 0)}`,
    "",
    "> Preview only. No model training, provider request, checkpoint write, or durable dataset write was performed.",
    "",
    "## Rehearsal plan",
    "",
    `- Candidate: ${snapshot.candidate}`,
    `- Compute: ${snapshot.compute}`,
    `- Schedule: ${snapshot.epochs} epochs · batch ${snapshot.batchSize} · ${snapshot.learningRate}`,
    `- Validation holdout: ${snapshot.validationSplit}%`,
    `- Checkpoints: ${snapshot.checkpointPolicy}`,
    "",
    "## Checkpoint manifest",
    "",
    `- Planned markers: ${buildTrainingCheckpointManifest({ runName: snapshot.runName, epochs: snapshot.epochs, evaluationCadence: snapshot.evaluationCadence, checkpointPolicy: snapshot.checkpointPolicy }).records.length}`,
    `- Retention: ${buildTrainingCheckpointManifest({ runName: snapshot.runName, epochs: snapshot.epochs, evaluationCadence: snapshot.evaluationCadence, checkpointPolicy: snapshot.checkpointPolicy }).plan.retentionSummary}`,
    "> Labels only; no model weights or checkpoint file is included.",
  ].join("\n");
}

export function parseTrainingPreview(input: string): TrainingSnapshot {
  if (new TextEncoder().encode(input).byteLength > TRAINING_PREVIEW_MAX_BYTES) {
    throw new Error("Training preview import exceeds the 512 KB limit.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    throw new Error("Training preview import must be valid JSON.");
  }
  if (!payload || typeof payload !== "object") throw new Error("Training preview import must be a JSON object.");
  const candidate = payload as Record<string, unknown>;
  if (candidate.schema !== "omnia.training-control-center.preview.v1" || candidate.scope !== "renderer-session") {
    throw new Error("Unsupported training preview schema or scope.");
  }
  if (!candidate.boundary || typeof candidate.boundary !== "object") throw new Error("Training preview boundary is missing.");
  const boundary = candidate.boundary as Record<string, unknown>;
  for (const field of ["modelTraining", "providerRequest", "checkpointWrite", "durableDatasetWrite", "nativeReceipt"]) {
    if (boundary[field] !== false) throw new Error(`Training preview boundary.${field} must remain false.`);
  }
  if (!candidate.plan || typeof candidate.plan !== "object") throw new Error("Training preview plan is missing.");
  const plan = candidate.plan as Record<string, unknown>;
  assertPreviewString(plan.runName, "plan.runName");
  assertPreviewString(plan.dataset, "plan.dataset");
  assertPreviewString(plan.candidate, "plan.candidate");
  assertPreviewString(plan.compute, "plan.compute");
  assertPreviewString(plan.learningRate, "plan.learningRate", 64);
  assertPreviewString(plan.checkpointPolicy, "plan.checkpointPolicy", 64);
  assertPreviewString(plan.evaluationCadence, "plan.evaluationCadence", 128);
  if (!isTrainingMode(plan.mode)) throw new Error("plan.mode is unsupported.");
  assertPreviewInteger(plan.epochs, "plan.epochs", 1, 20);
  assertPreviewInteger(plan.batchSize, "plan.batchSize", 1, 128);
  assertPreviewInteger(plan.validationSplit, "plan.validationSplit", 5, 50);
  if (!checkpointPolicies.includes(plan.checkpointPolicy as (typeof checkpointPolicies)[number])) throw new Error("plan.checkpointPolicy is unsupported.");

  const selectedRecordIds = candidate.selectedRecordIds;
  if (!Array.isArray(selectedRecordIds) || selectedRecordIds.some((id) => typeof id !== "string")) {
    throw new Error("selectedRecordIds must be an array of strings.");
  }
  if (new Set(selectedRecordIds).size !== selectedRecordIds.length) throw new Error("selectedRecordIds must not contain duplicates.");
  const knownIds = new Set(seedTrainingRecords.map((record) => record.id));
  if (selectedRecordIds.some((id) => !knownIds.has(id))) throw new Error("Training preview references an unknown source record.");
  if (selectedRecordIds.some((id) => !seedTrainingRecords.find((record) => record.id === id)?.eligible)) {
    throw new Error("Training preview cannot admit a held source record.");
  }
  const selectedIds = new Set(selectedRecordIds);
  const records = seedTrainingRecords.map((record) => ({ ...record, selected: record.eligible && selectedIds.has(record.id) }));

  const state = candidate.state;
  const stateRecord = state && typeof state === "object" ? state as Record<string, unknown> : {};
  const activeTab = stateRecord.activeTab === undefined ? "plan" : stateRecord.activeTab;
  const status = stateRecord.status === undefined ? "draft" : stateRecord.status;
  const exportFormat = stateRecord.exportFormat === undefined ? "json" : stateRecord.exportFormat;
  if (!isTrainingTab(activeTab)) throw new Error("state.activeTab is unsupported.");
  if (!isTrainingStatus(status)) throw new Error("state.status is unsupported.");
  if (!isExportFormat(exportFormat)) throw new Error("state.exportFormat is unsupported.");

  return {
    ...cloneSnapshot(initialTrainingSnapshot),
    runName: plan.runName,
    mode: plan.mode,
    dataset: plan.dataset,
    candidate: plan.candidate,
    compute: plan.compute,
    epochs: plan.epochs,
    batchSize: plan.batchSize,
    learningRate: plan.learningRate,
    validationSplit: plan.validationSplit,
    checkpointPolicy: plan.checkpointPolicy,
    evaluationCadence: plan.evaluationCadence,
    activeTab,
    status,
    exportFormat,
    records,
  };
}

function downloadTrainingPreview(payload: string, format: ExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-training-control-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function downloadCheckpointPreview(payload: string, format: TrainingCheckpointExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-training-checkpoints.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

const scheduleSteps = [
  ["Preflight", "Check data purpose, consent, redaction, and source revision."],
  ["Split", "Freeze train / validation IDs before any future dispatch."],
  ["Dry run", "Estimate tokens and memory without sending a provider request."],
  ["Checkpoint", "Prepare a manifest for the native bridge; no file is written here."],
  ["Approval", "Require an explicit native approval receipt before training."],
] as const;

export default function TrainingControlCenter() {
  const [snapshot, setSnapshot] = useState<TrainingSnapshot>(() => cloneSnapshot(initialTrainingSnapshot));
  const [history, setHistory] = useState<TrainingSnapshot[]>([]);
  const [future, setFuture] = useState<TrainingSnapshot[]>([]);
  const [status, setStatus] = useState("Training plan is staged in the renderer preview.");
  const [exportOpen, setExportOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => selectedTrainingRecords(snapshot), [snapshot]);
  const selectedExamples = selected.reduce((sum, record) => sum + record.examples, 0);
  const validationExamples = Math.max(1, Math.round(selectedExamples * snapshot.validationSplit / 100));
  const exportPayload = useMemo(() => serializeTrainingPreview(snapshot), [snapshot]);
  const checkpointManifest = useMemo(() => buildTrainingCheckpointManifest({
    runName: snapshot.runName,
    epochs: snapshot.epochs,
    evaluationCadence: snapshot.evaluationCadence,
    checkpointPolicy: snapshot.checkpointPolicy,
  }), [snapshot.runName, snapshot.epochs, snapshot.evaluationCadence, snapshot.checkpointPolicy]);
  const checkpointPayload = useMemo(
    () => serializeTrainingCheckpointManifest(checkpointManifest, snapshot.exportFormat),
    [checkpointManifest, snapshot.exportFormat],
  );
  const readiness = [
    { label: "At least one approved source", ready: selected.length > 0 },
    { label: "Validation holdout configured", ready: snapshot.validationSplit > 0 && selectedExamples > 1 },
    { label: "Candidate route selected", ready: snapshot.candidate.length > 0 },
    { label: "Checkpoint policy is explicit", ready: snapshot.checkpointPolicy.length > 0 },
  ];

  const update = (mutator: (draft: TrainingSnapshot) => void, message: string) => {
    setSnapshot((current) => {
      const next = cloneSnapshot(current);
      mutator(next);
      setHistory((entries) => [...entries.slice(-19), cloneSnapshot(current)]);
      setFuture([]);
      return next;
    });
    setStatus(message);
  };

  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((entries) => entries.slice(0, -1));
    setFuture((entries) => [...entries, cloneSnapshot(snapshot)]);
    setSnapshot(cloneSnapshot(previous));
    setStatus("Undid the last training-control preview change.");
  };

  const redo = () => {
    const next = future.at(-1);
    if (!next) return;
    setFuture((entries) => entries.slice(0, -1));
    setHistory((entries) => [...entries, cloneSnapshot(snapshot)]);
    setSnapshot(cloneSnapshot(next));
    setStatus("Redid the training-control preview change.");
  };

  const reset = () => {
    setHistory((entries) => [...entries.slice(-19), cloneSnapshot(snapshot)]);
    setFuture([]);
    setSnapshot(cloneSnapshot(initialTrainingSnapshot));
    setStatus("Training Control Center reset to its preview defaults.");
  };

  const prepareRehearsal = () => update((draft) => { draft.status = "ready"; draft.activeTab = "schedule"; }, "Prepared a deterministic rehearsal plan; no model was trained.");
  const queuePreview = () => update((draft) => { draft.status = "queued"; }, "Queued a renderer-local preview run; no provider request or checkpoint was created.");

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no training preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatus(`Copied the ${snapshot.exportFormat.toUpperCase()} training plan preview.`);
    } catch {
      setStatus("Clipboard access was denied; the training preview remains renderer-local.");
    }
  };

  const copyCheckpointManifest = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no checkpoint manifest was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(checkpointPayload);
      setStatus(`Copied the ${snapshot.exportFormat.toUpperCase()} checkpoint manifest preview.`);
    } catch {
      setStatus("Clipboard access was denied; the checkpoint manifest remains renderer-local.");
    }
  };

  const importPreview = async (file: File) => {
    try {
      const imported = parseTrainingPreview(await file.text());
      update((draft) => Object.assign(draft, imported), `Imported a validated ${file.name} training preview into this renderer session.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Training preview import was rejected; no changes were applied.");
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const tabs: Array<{ id: TrainingTab; label: string; icon: typeof Layers3 }> = [
    { id: "plan", label: "Plan", icon: FlaskConical },
    { id: "dataset", label: "Dataset", icon: Database },
    { id: "pipeline", label: "Pipeline", icon: GitBranch },
    { id: "schedule", label: "Schedule", icon: Timer },
    { id: "metrics", label: "Metrics", icon: Activity },
    { id: "rlaif", label: "RLAIF Lab", icon: Sparkles },
    { id: "checkpoints", label: "Checkpoints", icon: Archive },
    { id: "export", label: "Export", icon: FileJson2 },
  ];

  return (
    <section className="training-control-center" aria-labelledby="training-control-center-title">
      <header className="training-control-center__header">
        <div className="training-control-center__title">
          <span className="eyebrow"><Sparkles size={14} /> Learning systems</span>
          <h2 id="training-control-center-title">Training Control Center</h2>
          <p>Compose a reviewable training plan, inspect dataset admission, and rehearse the run lifecycle before a future native bridge exists.</p>
        </div>
        <div className="training-control-center__header-actions">
          <span className="training-control-center__badge"><Eye size={13} /> Preview only</span>
          <button type="button" className="button button--secondary" onClick={undo} disabled={!history.length} aria-label="Undo training preview change"><Undo2 size={14} /> Undo</button>
          <button type="button" className="button button--secondary" onClick={redo} disabled={!future.length} aria-label="Redo training preview change"><Redo2 size={14} /> Redo</button>
          <button type="button" className="button button--secondary" onClick={reset}><RotateCcw size={14} /> Reset</button>
        </div>
      </header>

      <div className="training-control-center__boundary" role="note"><LockKeyhole size={14} /> Renderer-local control plane. No model training, provider upload, checkpoint write, durable dataset mutation, or native receipt is created.</div>

      <div className="training-control-center__controls" aria-label="Training plan controls">
        <label><span>Run label</span><input value={snapshot.runName} onChange={(event) => update((draft) => { draft.runName = event.target.value; }, "Updated the renderer-local training run label.")} /></label>
        <label><span>Training mode</span><select value={snapshot.mode} onChange={(event) => update((draft) => { draft.mode = event.target.value as TrainingMode; }, "Updated the training mode preview.")}>{Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Compute profile</span><select value={snapshot.compute} onChange={(event) => update((draft) => { draft.compute = event.target.value; }, "Updated the compute profile preview.")}><option>Cloud GPU · estimate unknown</option><option>Local rehearsal · no execution</option><option>Hybrid queue · native approval needed</option></select></label>
        <button type="button" className="button button--secondary" onClick={() => setExportOpen((current) => !current)} aria-expanded={exportOpen} aria-controls="training-control-export"><FileJson2 size={14} /> {exportOpen ? "Hide export" : "Preview export"}</button>
      </div>

      <div className="training-control-center__metrics" role="status" aria-label="Training control summary">
        <span><strong>{snapshot.records.length}</strong><small>visible sources</small></span>
        <span><strong>{selected.length}</strong><small>admitted sources</small></span>
        <span><strong>{selectedExamples}</strong><small>train examples</small></span>
        <span><strong>{validationExamples}</strong><small>validation holdout</small></span>
        <span><strong>{snapshot.status === "draft" ? "Draft" : snapshot.status === "ready" ? "Ready" : "Queued"}</strong><small>plan state</small></span>
      </div>

      <div className="training-control-center__tabs" role="tablist" aria-label="Training control views">
        {tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab" aria-selected={snapshot.activeTab === id} aria-controls={`training-control-panel-${id}`} className={snapshot.activeTab === id ? "is-active" : ""} onClick={() => update((draft) => { draft.activeTab = id; }, `Opened ${label} training view.`)}><Icon size={14} /> {label}</button>)}
      </div>

      <div className="training-control-center__body">
        {snapshot.activeTab === "plan" ? <div id="training-control-panel-plan" role="tabpanel" className="training-control-center__grid">
          <article className="training-control-center__card training-control-center__card--hero"><div className="training-control-center__card-heading"><span><FlaskConical size={14} /> Rehearsal plan</span><span className={`training-control-center__state training-control-center__state--${snapshot.status}`}>{snapshot.status}</span></div><h3>{modeLabels[snapshot.mode]}</h3><p>Use the current learning-review snapshot as a source proposal. The native bridge must freeze inputs again before any real dispatch.</p><dl className="training-control-center__facts"><div><dt>Dataset</dt><dd>{snapshot.dataset}</dd></div><div><dt>Candidate</dt><dd>{snapshot.candidate}</dd></div><div><dt>Schedule</dt><dd>{snapshot.epochs} epochs · batch {snapshot.batchSize} · {snapshot.learningRate}</dd></div><div><dt>Evaluation</dt><dd>{snapshot.evaluationCadence}</dd></div></dl><div className="training-control-center__action-row"><button type="button" className="button button--primary" onClick={prepareRehearsal}><Play size={14} /> Prepare rehearsal</button><button type="button" className="button button--secondary" onClick={queuePreview}><GitBranch size={14} /> Queue preview</button></div></article>
          <aside className="training-control-center__card"><div className="training-control-center__card-heading"><span><ShieldCheck size={14} /> Readiness gate</span><span className="training-control-center__muted">{readiness.filter((item) => item.ready).length}/{readiness.length}</span></div><ul className="training-control-center__checklist">{readiness.map((item) => <li key={item.label} className={item.ready ? "is-ready" : ""}>{item.ready ? <CheckCircle2 size={15} /> : <Timer size={15} />}<span>{item.label}</span><small>{item.ready ? "Ready in preview" : "Needs review"}</small></li>)}</ul><p className="training-control-center__hint"><Gauge size={13} /> Readiness is a renderer projection, not an approval or runtime capability.</p></aside>
        </div> : null}

        {snapshot.activeTab === "dataset" ? <div id="training-control-panel-dataset" role="tabpanel" className="training-control-center__dataset"><div className="training-control-center__dataset-list" role="list" aria-label="Training source records">{snapshot.records.map((record) => <label key={record.id} className={`training-control-center__dataset-row${record.selected ? " is-selected" : ""}${!record.eligible ? " is-held" : ""}`}><input type="checkbox" aria-label={record.title} checked={record.selected} disabled={!record.eligible} onChange={() => update((draft) => { const target = draft.records.find((item) => item.id === record.id); if (target?.eligible) target.selected = !target.selected; }, `${record.title} admission changed in the renderer preview.`)} /><span className="training-control-center__dataset-copy"><strong>{record.title}</strong><small>{record.source} · {record.examples} examples</small><em>{record.note}</em></span><span className={`training-control-center__sensitivity training-control-center__sensitivity--${record.sensitivity}`}>{sensitivityLabels[record.sensitivity]}</span></label>)}</div><aside className="training-control-center__card training-control-center__dataset-detail"><div className="training-control-center__card-heading"><span><Database size={14} /> Admission contract</span><span className="training-control-center__state training-control-center__state--ready">{selectedExamples} examples</span></div><p>Only approved, visible records can enter this preview batch. High-sensitivity and consent-pending records stay held even when they are visible to the user.</p><div className="training-control-center__policy-grid"><span><strong>Purpose</strong><small>Quality improvement</small></span><span><strong>Redaction</strong><small>Mask sensitive fields</small></span><span><strong>Retention</strong><small>Session preview</small></span><span><strong>Consent</strong><small>Native receipt required</small></span></div><p className="training-control-center__boundary"><LockKeyhole size={13} /> No raw prompt, credential, hidden context, or provider payload is copied into this plan.</p></aside></div> : null}

        {snapshot.activeTab === "pipeline" ? <div id="training-control-panel-pipeline" role="tabpanel"><TrainingDatasetPipeline records={snapshot.records} /></div> : null}

        {snapshot.activeTab === "schedule" ? <div id="training-control-panel-schedule" role="tabpanel" className="training-control-center__grid"><article className="training-control-center__card"><div className="training-control-center__card-heading"><span><Timer size={14} /> Lifecycle rehearsal</span><span className="training-control-center__muted">{snapshot.status === "queued" ? "Preview queued" : "Not dispatched"}</span></div><ol className="training-control-center__timeline">{scheduleSteps.map(([label, detail], index) => <li key={label} className={index === 0 || (snapshot.status === "queued" && index < 3) ? "is-active" : ""}><span className="training-control-center__timeline-marker">{index + 1}</span><span><strong>{label}</strong><small>{detail}</small></span></li>)}</ol></article><aside className="training-control-center__card"><div className="training-control-center__card-heading"><span><SlidersHorizontal size={14} /> Schedule options</span><span className="training-control-center__muted">Editable preview</span></div><div className="training-control-center__option-grid"><label><span>Epochs</span><input aria-label="Training epochs" type="number" min="1" max="20" value={snapshot.epochs} onChange={(event) => update((draft) => { draft.epochs = Number(event.target.value) || 1; }, "Updated epochs in the training preview.")} /></label><label><span>Batch size</span><input aria-label="Training batch size" type="number" min="1" max="128" value={snapshot.batchSize} onChange={(event) => update((draft) => { draft.batchSize = Number(event.target.value) || 1; }, "Updated batch size in the training preview.")} /></label><label><span>Validation split</span><input aria-label="Validation split" type="number" min="5" max="50" value={snapshot.validationSplit} onChange={(event) => update((draft) => { draft.validationSplit = Math.max(5, Math.min(50, Number(event.target.value) || 20)); }, "Updated validation split in the training preview.")} /></label><label><span>Checkpoint policy</span><select aria-label="Checkpoint policy" value={snapshot.checkpointPolicy} onChange={(event) => update((draft) => { draft.checkpointPolicy = event.target.value; }, "Updated checkpoint policy in the training preview.")}><option>Keep best + latest</option><option>Keep latest only</option><option>Manual approval per checkpoint</option></select></label></div><p className="training-control-center__boundary"><LockKeyhole size={13} /> Schedule changes alter the plan only. They do not start a job, allocate compute, or write a checkpoint.</p></aside></div> : null}

        {snapshot.activeTab === "metrics" ? <div id="training-control-panel-metrics" role="tabpanel" className="training-control-center__metrics-layout"><article className="training-control-center__card"><div className="training-control-center__card-heading"><span><Activity size={14} /> Expected signal preview</span><span className="training-control-center__state training-control-center__state--ready">Illustrative</span></div><div className="training-control-center__bars" aria-label="Illustrative metric bars">{[["Groundedness", 82], ["Correction fit", 74], ["Boundary discipline", 91], ["Format stability", 78]].map(([label, value]) => <div key={label} className="training-control-center__bar"><div><span>{label}</span><strong>{value}/100</strong></div><span><i style={{ width: `${value}%` }} /></span></div>)}</div><p className="training-control-center__hint"><Gauge size={13} /> These are static planning signals, not benchmark scores, loss curves, or model output.</p></article><aside className="training-control-center__card"><div className="training-control-center__card-heading"><span><Layers3 size={14} /> Evaluation hooks</span><span className="training-control-center__muted">Planned</span></div><ul className="training-control-center__plain-list"><li><Check size={14} /> Hold out {validationExamples} examples for review</li><li><Check size={14} /> Compare against the primary route</li><li><Check size={14} /> Require a human decision before activation</li><li><Check size={14} /> Preserve unknown outcomes as unknown</li></ul><p className="training-control-center__boundary"><LockKeyhole size={13} /> No evaluator API or model endpoint is called by this surface.</p></aside><article className="training-control-center__card training-control-center__split-preview"><div className="training-control-center__card-heading"><span><Database size={14} /> Split projection</span><span className="training-control-center__muted">Deterministic preview</span></div><div className="training-control-center__split-metrics"><span><strong>{Math.max(0, selectedExamples - validationExamples)}</strong><small>train examples</small></span><span><strong>{validationExamples}</strong><small>validation examples</small></span><span><strong>{snapshot.validationSplit}%</strong><small>holdout target</small></span></div><p className="training-control-center__boundary"><LockKeyhole size={13} /> IDs are not frozen here; this is a planning projection until a native split receipt exists.</p></article></div> : null}

        {snapshot.activeTab === "rlaif" ? <div id="training-control-panel-rlaif" role="tabpanel"><RlaifLabPreview /></div> : null}

        {snapshot.activeTab === "checkpoints" ? <div id="training-control-panel-checkpoints" role="tabpanel" className="training-control-center__checkpoint-view">
          <div className="training-control-center__grid">
            <article className="training-control-center__card">
              <div className="training-control-center__card-heading"><span><Archive size={14} /> Checkpoint manifest</span><span className="training-control-center__state training-control-center__state--ready">Preview plan</span></div>
              <p>Review which checkpoint markers a future trainer could propose, what event would trigger each one, and which records require an explicit approval gate.</p>
              <div className="training-control-center__checkpoint-metrics" aria-label="Checkpoint manifest summary">
                <span><strong>{checkpointManifest.records.length}</strong><small>planned markers</small></span>
                <span><strong>{checkpointManifest.records.filter((record) => record.retention === "retained").length}</strong><small>retained markers</small></span>
                <span><strong>{checkpointManifest.records.filter((record) => record.status === "approval-required").length}</strong><small>approval gates</small></span>
              </div>
              <div className="training-control-center__checkpoint-list" role="list" aria-label="Planned checkpoint markers">
                {checkpointManifest.records.map((record) => <div key={record.id} className="training-control-center__checkpoint-row" role="listitem">
                  <span className={`training-control-center__checkpoint-kind training-control-center__checkpoint-kind--${record.kind}`}>{record.kind}</span>
                  <span className="training-control-center__checkpoint-copy"><strong>{record.label}</strong><small>{record.trigger}</small><em>{record.metric ?? "Metric not frozen in preview"}</em></span>
                  <span className="training-control-center__checkpoint-state"><strong>{record.status === "approval-required" ? "Approval" : "Planned"}</strong><small>{record.retention}</small></span>
                </div>)}
              </div>
              <p className="training-control-center__hint"><Gauge size={13} /> Epoch/step locations are illustrative until a native split and run receipt freeze them.</p>
            </article>
            <aside className="training-control-center__card training-control-center__checkpoint-export">
              <div className="training-control-center__card-heading"><span><FileJson2 size={14} /> Manifest export</span><span className="training-control-center__muted">Session-only</span></div>
              <label><span>Format</span><select aria-label="Checkpoint manifest format" value={snapshot.exportFormat} onChange={(event) => update((draft) => { draft.exportFormat = event.target.value as ExportFormat; }, `Selected ${event.target.value.toUpperCase()} checkpoint manifest preview.`)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
              <div className="training-control-center__action-row"><button type="button" className="button button--secondary" onClick={() => void copyCheckpointManifest()}><Clipboard size={14} /> Copy manifest</button><button type="button" className="button button--secondary" onClick={() => setStatus(downloadCheckpointPreview(checkpointPayload, snapshot.exportFormat) ? "Browser download started; no checkpoint file or native receipt was created." : "Browser download is unavailable in this preview environment.")}><Download size={14} /> Download manifest</button></div>
              <pre aria-label="Checkpoint manifest export preview">{checkpointPayload}</pre>
              <p className="training-control-center__boundary"><LockKeyhole size={13} /> This manifest contains labels and policy metadata only. It never includes model weights, provider payloads, credentials, files, or a native checkpoint write.</p>
            </aside>
          </div>
        </div> : null}

        {snapshot.activeTab === "export" ? <div id="training-control-panel-export" role="tabpanel" className="training-control-center__export"><div className="training-control-center__export-toolbar"><label><span>Format</span><select aria-label="Training export format" value={snapshot.exportFormat} onChange={(event) => update((draft) => { draft.exportFormat = event.target.value as ExportFormat; }, `Selected ${event.target.value.toUpperCase()} training export preview.`)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--secondary" onClick={() => void copyExport()}><Clipboard size={14} /> Copy</button><button type="button" className="button button--secondary" onClick={() => setStatus(downloadTrainingPreview(exportPayload, snapshot.exportFormat) ? "Browser download started; no native training receipt was created." : "Browser download is unavailable in this preview environment.")}><Download size={14} /> Download</button><button type="button" className="button button--secondary" onClick={() => importInputRef.current?.click()}><FileJson2 size={14} /> Import JSON</button><input ref={importInputRef} className="training-control-center__file-input" type="file" accept="application/json,.json" aria-label="Import training preview JSON" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importPreview(file); }} /></div><pre aria-label="Training plan export preview">{serializeTrainingPreview(snapshot, snapshot.exportFormat)}</pre><p className="training-control-center__hint"><FileJson2 size={13} /> Export includes visible plan metadata and record IDs only; raw content and credentials stay out. Imports are validated in the renderer session.</p></div> : null}
      </div>

      {exportOpen ? <section id="training-control-export" className="training-control-center__export training-control-center__export--drawer" aria-label="Training plan export preview"><div className="training-control-center__card-heading"><span><FileJson2 size={14} /> Quick export preview</span><button type="button" className="button button--ghost" onClick={() => setExportOpen(false)}>Close</button></div><pre>{exportPayload}</pre></section> : null}
      <p className="training-control-center__status" role="status" aria-live="polite">{status}</p>
    </section>
  );
}
