export type TrainingCheckpointKind = "latest" | "best" | "manual";
export type TrainingCheckpointStatus = "planned" | "approval-required";
export type TrainingCheckpointRetention = "retained" | "evict-if-full" | "manual";
export type TrainingCheckpointExportFormat = "json" | "markdown";

export interface TrainingCheckpointPlanInput {
  runName: string;
  epochs: number;
  evaluationCadence: string;
  checkpointPolicy: string;
}

export interface TrainingCheckpointRecord {
  id: string;
  kind: TrainingCheckpointKind;
  label: string;
  trigger: string;
  epoch: number | null;
  step: number | null;
  metric: string | null;
  status: TrainingCheckpointStatus;
  retention: TrainingCheckpointRetention;
}

export interface TrainingCheckpointManifest {
  schema: "omnia.training-checkpoint.preview.v1";
  scope: "renderer-session";
  plan: {
    runName: string;
    checkpointPolicy: string;
    evaluationCadence: string;
    retentionSummary: string;
  };
  records: TrainingCheckpointRecord[];
  boundary: {
    modelWeights: false;
    checkpointWrite: false;
    nativeReceipt: false;
    providerRequest: false;
  };
}

const DEFAULT_POLICY = "Keep best + latest";

function normalizeEpochs(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(20, Math.round(value)));
}

function normalizeText(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 256) : fallback;
}

function buildLatestRecord(epochs: number): TrainingCheckpointRecord {
  return {
    id: "checkpoint-latest-final",
    kind: "latest",
    label: "Latest rehearsal snapshot",
    trigger: "End of planned rehearsal",
    epoch: epochs,
    step: null,
    metric: null,
    status: "planned",
    retention: "retained",
  };
}

export function buildTrainingCheckpointManifest(input: TrainingCheckpointPlanInput): TrainingCheckpointManifest {
  const epochs = normalizeEpochs(input.epochs);
  const checkpointPolicy = normalizeText(input.checkpointPolicy, DEFAULT_POLICY);
  const evaluationCadence = normalizeText(input.evaluationCadence, "After each evaluation window");
  const records: TrainingCheckpointRecord[] = [buildLatestRecord(epochs)];

  if (checkpointPolicy === "Keep best + latest") {
    records.unshift({
      id: "checkpoint-best-validation",
      kind: "best",
      label: "Best validation snapshot",
      trigger: `Best signal during ${evaluationCadence.toLowerCase()}`,
      epoch: null,
      step: null,
      metric: "validation signal · not observed",
      status: "approval-required",
      retention: "retained",
    });
  } else if (checkpointPolicy === "Manual approval per checkpoint") {
    records.unshift({
      id: "checkpoint-manual-review",
      kind: "manual",
      label: "Manual approval checkpoint",
      trigger: `At ${evaluationCadence.toLowerCase()}`,
      epoch: null,
      step: null,
      metric: null,
      status: "approval-required",
      retention: "manual",
    });
  }

  return {
    schema: "omnia.training-checkpoint.preview.v1",
    scope: "renderer-session",
    plan: {
      runName: normalizeText(input.runName, "Untitled rehearsal"),
      checkpointPolicy,
      evaluationCadence,
      retentionSummary: checkpointPolicy === "Keep latest only"
        ? "Retain one latest marker"
        : checkpointPolicy === "Manual approval per checkpoint"
          ? "Retain only after explicit review"
          : "Retain best candidate plus latest marker",
    },
    records,
    boundary: {
      modelWeights: false,
      checkpointWrite: false,
      nativeReceipt: false,
      providerRequest: false,
    },
  };
}

export function serializeTrainingCheckpointManifest(
  manifest: TrainingCheckpointManifest,
  format: TrainingCheckpointExportFormat = "json",
): string {
  if (format === "json") return JSON.stringify(manifest, null, 2);
  return [
    "# Omnia checkpoint manifest preview",
    "",
    `Run: ${manifest.plan.runName}`,
    `Policy: ${manifest.plan.checkpointPolicy}`,
    `Cadence: ${manifest.plan.evaluationCadence}`,
    `Retention: ${manifest.plan.retentionSummary}`,
    "",
    "> Preview only. No model weights, checkpoint file, provider request, or native receipt exists.",
    "",
    "## Planned records",
    "",
    ...manifest.records.map((record) => {
      const location = [record.epoch === null ? null : `epoch ${record.epoch}`, record.step === null ? null : `step ${record.step}`].filter(Boolean).join(", ") || "location not frozen";
      const metric = record.metric ? ` · ${record.metric}` : "";
      return `- **${record.label}** — ${record.status}; ${record.trigger}; ${location}; retention: ${record.retention}${metric}`;
    }),
  ].join("\n");
}

export function validateTrainingCheckpointManifest(input: unknown): TrainingCheckpointManifest {
  if (!input || typeof input !== "object") throw new Error("Checkpoint manifest must be an object.");
  const candidate = input as Partial<TrainingCheckpointManifest>;
  if (candidate.schema !== "omnia.training-checkpoint.preview.v1" || candidate.scope !== "renderer-session") {
    throw new Error("Unsupported checkpoint manifest schema or scope.");
  }
  if (!candidate.plan || typeof candidate.plan !== "object") throw new Error("Checkpoint manifest plan is missing.");
  if (!Array.isArray(candidate.records) || candidate.records.length === 0) throw new Error("Checkpoint manifest records are missing.");
  if (!candidate.boundary || typeof candidate.boundary !== "object") throw new Error("Checkpoint manifest boundary is missing.");
  const boundary = candidate.boundary as Record<string, unknown>;
  for (const field of ["modelWeights", "checkpointWrite", "nativeReceipt", "providerRequest"]) {
    if (boundary[field] !== false) throw new Error(`Checkpoint manifest boundary.${field} must remain false.`);
  }
  return candidate as TrainingCheckpointManifest;
}

