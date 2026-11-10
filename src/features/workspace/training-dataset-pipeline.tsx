import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clipboard,
  Download,
  Eye,
  FileJson2,
  GitBranch,
  LockKeyhole,
  Redo2,
  RotateCcw,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { TrainingRecord } from "./training-control-center";

export type DatasetDeduplication = "content-hash" | "source-id" | "off";
export type DatasetSplitStrategy = "stratified" | "chronological" | "hash";
export type DatasetPipelineExportFormat = "json" | "markdown";

export type DatasetPipelineSnapshot = {
  sourceRevision: string;
  deduplication: DatasetDeduplication;
  splitStrategy: DatasetSplitStrategy;
  seed: string;
  trainPercent: number;
  validationPercent: number;
  testPercent: number;
  redactSensitive: boolean;
  leakageGuard: boolean;
  /**
   * Optional renderer-session manifest selection. When omitted, every
   * selected + eligible source record participates in the projection. An
   * empty array is an explicit hold-all decision.
   */
  includedRecordIds?: string[];
};

export type DatasetPipelineProjection = {
  rawExamples: number;
  duplicateExamplesRemoved: number;
  sensitiveExamplesHeld: number;
  leakageExamplesHeld: number;
  eligibleExamples: number;
  trainExamples: number;
  validationExamples: number;
  testExamples: number;
  leakageGroups: number;
  selectedRecordIds: string[];
  checks: Array<{ id: string; label: string; status: "ready" | "review"; detail: string }>;
};

type DatasetPipelineHistory = {
  past: DatasetPipelineSnapshot[];
  present: DatasetPipelineSnapshot;
  future: DatasetPipelineSnapshot[];
};

const PIPELINE_PREVIEW_SCHEMA = "omnia.training-dataset-pipeline.preview.v1";
const MAX_IMPORT_BYTES = 256 * 1024;

const initialPipelineSnapshot: DatasetPipelineSnapshot = {
  sourceRevision: "learning-review.renderer-session.v1",
  deduplication: "content-hash",
  splitStrategy: "stratified",
  seed: "omnia-preview-01",
  trainPercent: 70,
  validationPercent: 20,
  testPercent: 10,
  redactSensitive: true,
  leakageGuard: true,
};

const metadataByRecordId: Record<string, { duplicateExamples: number; sensitiveExamples: number; leakageGroups: string[]; leakageExamples: number }> = {
  "train-feedback-001": { duplicateExamples: 1, sensitiveExamples: 0, leakageGroups: ["feedback-thread-a"], leakageExamples: 0 },
  "train-feedback-002": { duplicateExamples: 2, sensitiveExamples: 1, leakageGroups: ["feedback-thread-a"], leakageExamples: 1 },
  "train-run-001": { duplicateExamples: 0, sensitiveExamples: 0, leakageGroups: ["run-outcome-a"], leakageExamples: 0 },
};

const cloneSnapshot = (snapshot: DatasetPipelineSnapshot): DatasetPipelineSnapshot => ({ ...snapshot });

function normalizePercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

function rebalanceSplit(snapshot: DatasetPipelineSnapshot, field: "trainPercent" | "validationPercent" | "testPercent", value: number): void {
  const target = normalizePercent(value);
  snapshot[field] = target;
  const otherFields = (["trainPercent", "validationPercent", "testPercent"] as const).filter((candidate) => candidate !== field);
  const remaining = 100 - target;
  const firstOther = otherFields[0]!;
  const secondOther = otherFields[1]!;
  snapshot[firstOther] = Math.min(normalizePercent(snapshot[firstOther]), remaining);
  snapshot[secondOther] = remaining - snapshot[firstOther];
}

export function normalizeDatasetPipelineSnapshot(snapshot: DatasetPipelineSnapshot): DatasetPipelineSnapshot {
  const trainPercent = normalizePercent(snapshot.trainPercent);
  const validationPercent = normalizePercent(snapshot.validationPercent);
  const testPercent = normalizePercent(snapshot.testPercent);
  const total = trainPercent + validationPercent + testPercent;
  if (!snapshot.sourceRevision.trim()) throw new Error("sourceRevision must be non-empty.");
  if (!snapshot.seed.trim()) throw new Error("seed must be non-empty.");
  if (total !== 100) throw new Error("trainPercent + validationPercent + testPercent must equal 100.");
  const includedRecordIds = snapshot.includedRecordIds === undefined
    ? undefined
    : Array.from(new Set(snapshot.includedRecordIds.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean))).slice(0, 2_000);
  return {
    ...snapshot,
    sourceRevision: snapshot.sourceRevision.trim().slice(0, 160),
    seed: snapshot.seed.trim().slice(0, 80),
    trainPercent,
    validationPercent,
    testPercent,
    ...(includedRecordIds === undefined ? {} : { includedRecordIds }),
  };
}

export function selectedDatasetPipelineRecords(records: readonly TrainingRecord[], snapshot: DatasetPipelineSnapshot): TrainingRecord[] {
  const includedRecordIds = snapshot.includedRecordIds;
  return records.filter((record) => (
    record.selected
    && record.eligible
    && (includedRecordIds === undefined || includedRecordIds.includes(record.id))
  ));
}

export function buildDatasetPipelineProjection(records: readonly TrainingRecord[], snapshot: DatasetPipelineSnapshot): DatasetPipelineProjection {
  const selected = selectedDatasetPipelineRecords(records, snapshot);
  const selectedRecordIds = selected.map((record) => record.id);
  const rawExamples = selected.reduce((sum, record) => sum + record.examples, 0);
  const metadata = selected.map((record) => metadataByRecordId[record.id] ?? { duplicateExamples: 0, sensitiveExamples: 0, leakageGroups: [], leakageExamples: 0 });
  const duplicateExamplesRemoved = snapshot.deduplication === "off"
    ? 0
    : metadata.reduce((sum, item) => sum + item.duplicateExamples, 0);
  const sensitiveExamplesHeld = snapshot.redactSensitive
    ? metadata.reduce((sum, item) => sum + item.sensitiveExamples, 0)
    : 0;
  const leakageExamplesHeld = snapshot.leakageGuard
    ? metadata.reduce((sum, item) => sum + item.leakageExamples, 0)
    : 0;
  const eligibleExamples = Math.max(0, rawExamples - duplicateExamplesRemoved - sensitiveExamplesHeld - leakageExamplesHeld);
  const leakageGroups = new Set(metadata.flatMap((item) => item.leakageGroups)).size;
  const trainExamples = Math.floor(eligibleExamples * snapshot.trainPercent / 100);
  const validationExamples = Math.floor(eligibleExamples * snapshot.validationPercent / 100);
  const testExamples = Math.max(0, eligibleExamples - trainExamples - validationExamples);
  const checks: DatasetPipelineProjection["checks"] = [
    {
      id: "source-revision",
      label: "Source revision is named",
      status: snapshot.sourceRevision.trim() ? "ready" : "review",
      detail: snapshot.sourceRevision.trim() ? snapshot.sourceRevision : "Add a revision before a native bridge can freeze inputs.",
    },
    {
      id: "dedupe",
      label: "Duplicate policy is explicit",
      status: snapshot.deduplication === "off" || duplicateExamplesRemoved === 0 ? "review" : "ready",
      detail: snapshot.deduplication === "off" ? "Deduplication is disabled; repeated examples remain visible." : `${duplicateExamplesRemoved} duplicate example(s) would be held by this preview.`,
    },
    {
      id: "leakage",
      label: "Leakage groups are separated",
      status: snapshot.leakageGuard && leakageGroups > 0 ? "ready" : "review",
      detail: snapshot.leakageGuard ? `${leakageGroups} source group(s) are kept together for split review.` : "Enable the leakage guard before freezing train and holdout IDs.",
    },
    {
      id: "redaction",
      label: "Sensitive fields have a policy",
      status: snapshot.redactSensitive ? "ready" : "review",
      detail: snapshot.redactSensitive ? `${sensitiveExamplesHeld} sensitive example(s) held for redaction review.` : "Redaction is disabled in this rehearsal.",
    },
    {
      id: "holdout",
      label: "Validation and test holdouts exist",
      status: snapshot.validationPercent > 0 && snapshot.testPercent > 0 ? "ready" : "review",
      detail: `${snapshot.validationPercent}% validation · ${snapshot.testPercent}% test · seed ${snapshot.seed}`,
    },
  ];
  return { rawExamples, duplicateExamplesRemoved, sensitiveExamplesHeld, leakageExamplesHeld, eligibleExamples, trainExamples, validationExamples, testExamples, leakageGroups, selectedRecordIds, checks };
}

export function serializeDatasetPipelinePreview(
  records: readonly TrainingRecord[],
  snapshot: DatasetPipelineSnapshot,
  format: DatasetPipelineExportFormat = "json",
): string {
  const normalized = normalizeDatasetPipelineSnapshot(snapshot);
  const projection = buildDatasetPipelineProjection(records, normalized);
  const selectedRecordIds = projection.selectedRecordIds;
  const payload = {
    schema: PIPELINE_PREVIEW_SCHEMA,
    scope: "renderer-session",
    plan: normalized,
    sourceRecordIds: selectedRecordIds,
    projection,
    boundary: {
      filesystemRead: false,
      providerRequest: false,
      modelTraining: false,
      durableDatasetWrite: false,
      nativeSplitReceipt: false,
    },
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia Dataset Pipeline preview",
    "",
    `Source revision: ${normalized.sourceRevision}`,
    `Split: ${normalized.trainPercent}% train · ${normalized.validationPercent}% validation · ${normalized.testPercent}% test`,
    `Strategy: ${normalized.splitStrategy} · seed ${normalized.seed}`,
    "",
    `- Raw examples: ${projection.rawExamples}`,
    `- Duplicate examples held: ${projection.duplicateExamplesRemoved}`,
    `- Sensitive examples held: ${projection.sensitiveExamplesHeld}`,
    `- Leakage examples held: ${projection.leakageExamplesHeld}`,
    `- Eligible examples: ${projection.eligibleExamples}`,
    `- Train / validation / test: ${projection.trainExamples} / ${projection.validationExamples} / ${projection.testExamples}`,
    "",
    "> Preview only · renderer-local · no filesystem read, provider request, model training, durable dataset write, or native split receipt.",
  ].join("\n");
}

export function parseDatasetPipelinePreview(input: string): DatasetPipelineSnapshot {
  if (new TextEncoder().encode(input).byteLength > MAX_IMPORT_BYTES) throw new Error("Dataset pipeline import exceeds the 256 KB preview limit.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Dataset pipeline import must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Dataset pipeline import must be a JSON object.");
  const payload = parsed as Record<string, unknown>;
  if (payload.schema !== PIPELINE_PREVIEW_SCHEMA || payload.scope !== "renderer-session") throw new Error("Unsupported dataset pipeline schema or scope.");
  const boundary = payload.boundary;
  if (!boundary || typeof boundary !== "object") throw new Error("Dataset pipeline boundary is missing.");
  for (const field of ["filesystemRead", "providerRequest", "modelTraining", "durableDatasetWrite", "nativeSplitReceipt"]) {
    if ((boundary as Record<string, unknown>)[field] !== false) throw new Error(`Dataset pipeline boundary.${field} must remain false.`);
  }
  if (!payload.plan || typeof payload.plan !== "object") throw new Error("Dataset pipeline plan is missing.");
  const plan = payload.plan as Record<string, unknown>;
  if (typeof plan.sourceRevision !== "string" || typeof plan.seed !== "string") throw new Error("Dataset pipeline sourceRevision and seed are required.");
  if (plan.deduplication !== "content-hash" && plan.deduplication !== "source-id" && plan.deduplication !== "off") throw new Error("Unsupported dataset deduplication policy.");
  if (plan.splitStrategy !== "stratified" && plan.splitStrategy !== "chronological" && plan.splitStrategy !== "hash") throw new Error("Unsupported dataset split strategy.");
  for (const field of ["trainPercent", "validationPercent", "testPercent"]) {
    if (typeof plan[field] !== "number" || !Number.isInteger(plan[field])) throw new Error(`Dataset pipeline ${field} must be an integer.`);
  }
  if (typeof plan.redactSensitive !== "boolean" || typeof plan.leakageGuard !== "boolean") throw new Error("Dataset pipeline policy flags are invalid.");
  if (plan.includedRecordIds !== undefined && (!Array.isArray(plan.includedRecordIds) || plan.includedRecordIds.some((id) => typeof id !== "string"))) {
    throw new Error("Dataset pipeline includedRecordIds must be an array of strings.");
  }
  return normalizeDatasetPipelineSnapshot(plan as unknown as DatasetPipelineSnapshot);
}

function downloadPreview(payload: string, format: DatasetPipelineExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-dataset-pipeline-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function initialDatasetPipelineSnapshot(): DatasetPipelineSnapshot {
  return cloneSnapshot(initialPipelineSnapshot);
}

export default function TrainingDatasetPipeline({ records }: { records: readonly TrainingRecord[] }) {
  const createInitialSnapshot = () => {
    const snapshot = initialDatasetPipelineSnapshot();
    snapshot.includedRecordIds = records.filter((record) => record.selected && record.eligible).map((record) => record.id);
    return snapshot;
  };
  const [history, setHistory] = useState<DatasetPipelineHistory>(() => ({ past: [], present: createInitialSnapshot(), future: [] }));
  const [format, setFormat] = useState<DatasetPipelineExportFormat>("json");
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importDraft, setImportDraft] = useState("");
  const [manifestQuery, setManifestQuery] = useState("");
  const [manifestFilter, setManifestFilter] = useState<"all" | "included" | "held" | "ineligible">("all");
  const [status, setStatus] = useState("Dataset pipeline is a renderer-local rehearsal.");

  const projection = useMemo(() => buildDatasetPipelineProjection(records, history.present), [records, history.present]);
  const exportPayload = useMemo(() => serializeDatasetPipelinePreview(records, history.present, format), [records, history.present, format]);
    const includedRecordIds = history.present.includedRecordIds ?? records.filter((record) => record.selected && record.eligible).map((record) => record.id);
  const manifestRecords = useMemo(() => {
    const normalizedQuery = manifestQuery.trim().toLowerCase();
    return records.filter((record) => {
      const included = includedRecordIds.includes(record.id);
      if (manifestFilter === "included" && !included) return false;
      if (manifestFilter === "held" && (included || !record.eligible)) return false;
      if (manifestFilter === "ineligible" && record.eligible) return false;
      if (!normalizedQuery) return true;
      return `${record.title} ${record.source} ${record.note}`.toLowerCase().includes(normalizedQuery);
    });
  }, [includedRecordIds, manifestFilter, manifestQuery, records]);

  const update = (mutator: (draft: DatasetPipelineSnapshot) => void, message: string) => {
    setHistory((current) => {
      const next = cloneSnapshot(current.present);
      mutator(next);
      try {
        normalizeDatasetPipelineSnapshot(next);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Dataset pipeline change was rejected.");
        return current;
      }
      return { past: [...current.past.slice(-19), cloneSnapshot(current.present)], present: next, future: [] };
    });
    setStatus(message);
  };

  const undo = () => setHistory((current) => {
    const previous = current.past.at(-1);
    if (!previous) return current;
    setStatus("Undid the dataset pipeline preview change.");
    return { past: current.past.slice(0, -1), present: cloneSnapshot(previous), future: [cloneSnapshot(current.present), ...current.future] };
  });

  const redo = () => setHistory((current) => {
    const next = current.future[0];
    if (!next) return current;
    setStatus("Redid the dataset pipeline preview change.");
    return { past: [...current.past, cloneSnapshot(current.present)], present: cloneSnapshot(next), future: current.future.slice(1) };
  });

  const reset = () => {
    setHistory((current) => ({ past: [...current.past.slice(-19), cloneSnapshot(current.present)], present: createInitialSnapshot(), future: [] }));
    setStatus("Dataset pipeline preview reset to defaults.");
  };

  const toggleManifestRecord = (record: TrainingRecord) => {
    if (!record.eligible) {
      setStatus(`${record.title} remains held because its source is not eligible for this preview.`);
      return;
    }
    update((draft) => {
      const currentIds = draft.includedRecordIds ?? records.filter((item) => item.selected && item.eligible).map((item) => item.id);
      draft.includedRecordIds = currentIds.includes(record.id)
        ? currentIds.filter((id) => id !== record.id)
        : [...currentIds, record.id];
    }, `${record.title} manifest admission changed in the renderer preview.`);
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no dataset pipeline preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatus(`Copied the ${format.toUpperCase()} dataset pipeline preview.`);
    } catch {
      setStatus("Clipboard access was denied; the dataset pipeline remains renderer-local.");
    }
  };

  const importPreview = () => {
    try {
      const imported = parseDatasetPipelinePreview(importDraft);
      setHistory((current) => ({
        past: [...current.past.slice(-19), cloneSnapshot(current.present)],
        present: imported,
        future: [],
      }));
      setStatus("Imported a validated dataset pipeline preview into this renderer session.");
      setImportDraft("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Dataset pipeline import was rejected; no changes were applied.");
    }
  };

  return (
    <section className="training-dataset-pipeline" aria-label="Dataset pipeline preview">
      <header className="training-dataset-pipeline__header">
        <div>
          <span className="eyebrow"><GitBranch size={13} /> Dataset preparation</span>
          <h3>Dataset Pipeline</h3>
          <p>Inspect normalization, duplicate handling, leakage guards, redaction, and deterministic split planning before a future native dataset receipt exists.</p>
        </div>
        <div className="training-dataset-pipeline__header-actions">
          <span className="training-dataset-pipeline__badge"><Eye size={13} /> Preview only</span>
          <button type="button" className="button button--ghost" onClick={undo} disabled={!history.past.length} aria-label="Undo dataset pipeline preview change"><Undo2 size={13} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={!history.future.length} aria-label="Redo dataset pipeline preview change"><Redo2 size={13} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={13} /> Reset</button>
        </div>
      </header>

      <p className="training-dataset-pipeline__boundary" role="note"><LockKeyhole size={14} /> Renderer-local only: no filesystem read, hidden-data collection, provider request, model training, durable dataset write, or native split receipt is created.</p>

      <div className="training-dataset-pipeline__controls" aria-label="Dataset pipeline controls">
        <label><span>Source revision</span><input aria-label="Dataset source revision" value={history.present.sourceRevision} onChange={(event) => update((draft) => { draft.sourceRevision = event.target.value; }, "Updated the source revision preview.")} /></label>
        <label><span>Deduplication</span><select aria-label="Dataset deduplication policy" value={history.present.deduplication} onChange={(event) => update((draft) => { draft.deduplication = event.target.value as DatasetDeduplication; }, "Updated the deduplication policy preview.")}><option value="content-hash">Content hash</option><option value="source-id">Source ID</option><option value="off">Disabled</option></select></label>
        <label><span>Split strategy</span><select aria-label="Dataset split strategy" value={history.present.splitStrategy} onChange={(event) => update((draft) => { draft.splitStrategy = event.target.value as DatasetSplitStrategy; }, "Updated the split strategy preview.")}><option value="stratified">Stratified</option><option value="chronological">Chronological</option><option value="hash">Stable hash</option></select></label>
        <label><span>Deterministic seed</span><input aria-label="Dataset split seed" value={history.present.seed} onChange={(event) => update((draft) => { draft.seed = event.target.value; }, "Updated the deterministic split seed preview.")} /></label>
        <label><span>Train %</span><input aria-label="Dataset train percent" type="number" min="0" max="100" value={history.present.trainPercent} onChange={(event) => update((draft) => { rebalanceSplit(draft, "trainPercent", Number(event.target.value)); }, "Updated the train split preview; remaining percentages were rebalanced.")} /></label>
        <label><span>Validation %</span><input aria-label="Dataset validation percent" type="number" min="0" max="100" value={history.present.validationPercent} onChange={(event) => update((draft) => { rebalanceSplit(draft, "validationPercent", Number(event.target.value)); }, "Updated the validation split preview; remaining percentages were rebalanced.")} /></label>
        <label><span>Test %</span><input aria-label="Dataset test percent" type="number" min="0" max="100" value={history.present.testPercent} onChange={(event) => update((draft) => { rebalanceSplit(draft, "testPercent", Number(event.target.value)); }, "Updated the test split preview; remaining percentages were rebalanced.")} /></label>
        <label className="training-dataset-pipeline__toggle"><input type="checkbox" checked={history.present.redactSensitive} onChange={(event) => update((draft) => { draft.redactSensitive = event.target.checked; }, "Updated the sensitive-field redaction preview.")} /><span>Hold sensitive fields</span></label>
        <label className="training-dataset-pipeline__toggle"><input type="checkbox" checked={history.present.leakageGuard} onChange={(event) => update((draft) => { draft.leakageGuard = event.target.checked; }, "Updated the leakage guard preview.")} /><span>Keep source groups together</span></label>
      </div>

      <section className="training-dataset-pipeline__manifest" aria-label="Dataset source manifest controls">
        <div className="training-dataset-pipeline__section-heading">
          <span><ShieldCheck size={14} /> Manifest controls</span>
          <small role="status" aria-label="Dataset manifest inclusion summary">{projection.selectedRecordIds.length}/{records.filter((record) => record.eligible).length} eligible sources included</small>
        </div>
        <p className="training-dataset-pipeline__hint"><LockKeyhole size={13} /> Inclusion decisions are renderer-session only. Held or ineligible records never enter the projected split.</p>
        <div className="training-dataset-pipeline__manifest-toolbar" role="toolbar" aria-label="Dataset source manifest filters">
          <label><span>Find source</span><input aria-label="Dataset source manifest search" value={manifestQuery} onChange={(event) => setManifestQuery(event.target.value)} placeholder="Title, source, note" /></label>
          <label><span>Show</span><select aria-label="Dataset source manifest filter" value={manifestFilter} onChange={(event) => setManifestFilter(event.target.value as typeof manifestFilter)}><option value="all">All records</option><option value="included">Included</option><option value="held">Held</option><option value="ineligible">Ineligible</option></select></label>
        </div>
        <div className="training-dataset-pipeline__manifest-list" role="list" aria-label="Dataset source manifest records">
          {manifestRecords.map((record) => {
            const included = record.selected && record.eligible && includedRecordIds.includes(record.id);
            return <label key={record.id} className={`training-dataset-pipeline__manifest-row${included ? " is-included" : ""}${!record.eligible ? " is-ineligible" : ""}`}>
              <input type="checkbox" aria-label={`Include ${record.title} in dataset preview`} checked={included} disabled={!record.eligible} onChange={() => toggleManifestRecord(record)} />
              <span className="training-dataset-pipeline__manifest-copy"><strong>{record.title}</strong><small>{record.source} · {record.examples} examples</small><em>{record.note}</em></span>
              <span className={`training-dataset-pipeline__manifest-state${included ? " is-included" : ""}`}>{!record.eligible ? "Ineligible" : included ? "Included" : "Held"}</span>
            </label>;
          })}
          {manifestRecords.length === 0 ? <p className="training-dataset-pipeline__manifest-empty">No source records match this manifest filter.</p> : null}
        </div>
      </section>

      <div className="training-dataset-pipeline__summary" role="status" aria-label="Dataset pipeline summary">
        <span><strong>{projection.rawExamples}</strong><small>raw examples</small></span>
        <span><strong>{projection.eligibleExamples}</strong><small>eligible examples</small></span>
        <span><strong>{projection.duplicateExamplesRemoved}</strong><small>duplicates held</small></span>
        <span><strong>{projection.leakageGroups}</strong><small>source groups</small></span>
        <span><strong>{projection.trainExamples}/{projection.validationExamples}/{projection.testExamples}</strong><small>train / val / test</small></span>
      </div>

      <div className="training-dataset-pipeline__layout">
        <section className="training-dataset-pipeline__stages" aria-label="Dataset pipeline stages">
          <div className="training-dataset-pipeline__section-heading"><span><GitBranch size={14} /> Pipeline stages</span><small>{history.present.splitStrategy} · seed {history.present.seed}</small></div>
          {[
            ["Source manifest", `Admit ${projection.selectedRecordIds.length} visible approved source(s).`, projection.selectedRecordIds.length > 0 ? "ready" : "review"],
            ["Normalize", "Map records to a stable preview schema without copying raw content.", "ready"],
            ["Deduplicate", projection.duplicateExamplesRemoved ? `Hold ${projection.duplicateExamplesRemoved} duplicate example(s) for review.` : "No duplicate examples projected.", projection.duplicateExamplesRemoved ? "review" : "ready"],
            ["Redact", projection.sensitiveExamplesHeld ? `Hold ${projection.sensitiveExamplesHeld} sensitive example(s) before admission.` : "No sensitive examples projected.", history.present.redactSensitive ? "ready" : "review"],
            ["Split", `${projection.trainExamples} train · ${projection.validationExamples} validation · ${projection.testExamples} test.`, history.present.validationPercent > 0 && history.present.testPercent > 0 ? "ready" : "review"],
          ].map(([label, detail, state], index) => <article key={label} className={`training-dataset-pipeline__stage training-dataset-pipeline__stage--${state}`}><span className="training-dataset-pipeline__stage-index">{index + 1}</span><div><strong>{label}</strong><small>{detail}</small></div><span className="training-dataset-pipeline__stage-state">{state === "ready" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}{state === "ready" ? "Ready" : "Review"}</span></article>)}
          <p className="training-dataset-pipeline__hint"><ShieldCheck size={13} /> A ready stage is only a deterministic renderer projection; it is not a native admission or training approval.</p>
        </section>

        <aside className="training-dataset-pipeline__checks" aria-label="Dataset pipeline checks">
          <div className="training-dataset-pipeline__section-heading"><span><ShieldCheck size={14} /> Review checks</span><small>{projection.checks.filter((check) => check.status === "ready").length}/{projection.checks.length} ready</small></div>
          <ul>{projection.checks.map((check) => <li key={check.id} className={`training-dataset-pipeline__check training-dataset-pipeline__check--${check.status}`}><span>{check.status === "ready" ? <Check size={13} /> : <AlertTriangle size={13} />}</span><div><strong>{check.label}</strong><small>{check.detail}</small></div></li>)}</ul>
        </aside>
      </div>

      <div className="training-dataset-pipeline__export-toolbar" role="toolbar" aria-label="Dataset pipeline export controls">
        <button type="button" className="button button--secondary" onClick={() => setExportOpen((current) => !current)} aria-expanded={exportOpen} aria-controls="dataset-pipeline-export"><FileJson2 size={13} /> {exportOpen ? "Hide export" : "Preview export"}</button>
        <button type="button" className="button button--ghost" onClick={() => setImportOpen((current) => !current)} aria-expanded={importOpen} aria-controls="dataset-pipeline-import"><GitBranch size={13} /> {importOpen ? "Hide import" : "Import JSON"}</button>
        {exportOpen ? <><label><span>Format</span><select aria-label="Dataset pipeline export format" value={format} onChange={(event) => setFormat(event.target.value as DatasetPipelineExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--ghost" onClick={() => setStatus(downloadPreview(exportPayload, format) ? "Downloaded a renderer-local dataset pipeline preview." : "Download is unavailable; no pipeline preview was exported.")}><Download size={13} /> Download</button></> : null}
      </div>
      {exportOpen ? <section id="dataset-pipeline-export" className="training-dataset-pipeline__export" aria-label="Dataset pipeline export preview"><pre tabIndex={0}><code>{exportPayload}</code></pre><p><FileJson2 size={13} /> Export contains plan metadata, source IDs, deterministic counts, and explicit false boundary flags. Raw content is excluded.</p></section> : null}
      {importOpen ? <section id="dataset-pipeline-import" className="training-dataset-pipeline__import" aria-label="Dataset pipeline import preview"><header><div><span className="eyebrow">Portable pipeline import</span><h4>Stage a validated plan</h4></div><span className="training-dataset-pipeline__badge">No durable write</span></header><textarea aria-label="Dataset pipeline import payload" rows={7} value={importDraft} onChange={(event) => setImportDraft(event.target.value)} placeholder='{"schema":"omnia.training-dataset-pipeline.preview.v1","scope":"renderer-session",...}' /><div className="training-dataset-pipeline__import-actions"><button type="button" className="button button--secondary" onClick={importPreview}><Check size={13} /> Stage valid JSON</button><button type="button" className="button button--ghost" onClick={() => setImportDraft("")}><RotateCcw size={13} /> Clear</button></div><p className="training-dataset-pipeline__hint"><LockKeyhole size={13} /> Import validates schema, split totals, and all false boundary flags. It does not read files, upload records, train a model, or persist a dataset.</p></section> : null}
      <p className="training-dataset-pipeline__status" role="status" aria-live="polite">{status}</p>
    </section>
  );
}
