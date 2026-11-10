import { Check, Plus, RotateCcw, SlidersHorizontal, Trash2, WandSparkles } from "lucide-react";
import { useMemo, useState } from "react";

export type EvaluationRubricTone = "blue" | "green" | "amber" | "coral";

export type EvaluationRubricDimension = {
  id: string;
  label: string;
  description: string;
  weight: number;
  tone: EvaluationRubricTone;
};

export type RubricPresetId = "balanced" | "coding" | "research" | "safety" | "custom";
export type RubricAdjudication = "single-review" | "second-review" | "consensus";

type RubricPreset = {
  id: Exclude<RubricPresetId, "custom">;
  label: string;
  description: string;
  dimensions: EvaluationRubricDimension[];
};

const toneCycle: EvaluationRubricTone[] = ["blue", "green", "amber", "coral"];

const presetCatalog: RubricPreset[] = [
  {
    id: "balanced",
    label: "Balanced quality",
    description: "General-purpose quality, evidence, boundaries, and clarity.",
    dimensions: [
      { id: "correctness", label: "Correctness", description: "Matches the expected answer and avoids contradictions.", weight: 30, tone: "blue" },
      { id: "groundedness", label: "Evidence grounding", description: "Uses visible sources, provenance, and uncertainty honestly.", weight: 24, tone: "green" },
      { id: "completeness", label: "Completeness", description: "Covers the requested decision without hiding material caveats.", weight: 18, tone: "amber" },
      { id: "safety", label: "Boundary discipline", description: "Does not claim provider, native, or execution evidence that is absent.", weight: 18, tone: "coral" },
      { id: "clarity", label: "Clarity", description: "Readable, direct, and useful to a reviewer or coder.", weight: 10, tone: "blue" },
    ],
  },
  {
    id: "coding",
    label: "Coder / implementation",
    description: "Prioritizes correctness, executable detail, and regression awareness.",
    dimensions: [
      { id: "correctness", label: "Correctness", description: "The proposed behavior matches the task and avoids contradictions.", weight: 34, tone: "blue" },
      { id: "implementation-fit", label: "Implementation fit", description: "Changes are scoped, actionable, and compatible with the codebase.", weight: 28, tone: "green" },
      { id: "verification", label: "Verification", description: "Names focused checks and distinguishes observed from unverified behavior.", weight: 18, tone: "amber" },
      { id: "boundary", label: "Boundary discipline", description: "Does not claim runtime, provider, or native evidence that was not observed.", weight: 12, tone: "coral" },
      { id: "clarity", label: "Handoff clarity", description: "A coder can understand the result, files, and next action quickly.", weight: 8, tone: "blue" },
    ],
  },
  {
    id: "research",
    label: "Research / grounded",
    description: "Weights evidence quality, uncertainty, and reproducible reasoning.",
    dimensions: [
      { id: "evidence", label: "Evidence quality", description: "Claims are anchored to visible, relevant sources or receipts.", weight: 34, tone: "green" },
      { id: "uncertainty", label: "Uncertainty handling", description: "Separates facts, assumptions, and what would resolve the gap.", weight: 24, tone: "amber" },
      { id: "correctness", label: "Correctness", description: "Reasoning and conclusions remain internally consistent.", weight: 20, tone: "blue" },
      { id: "reproducibility", label: "Reproducibility", description: "Another reviewer can follow the method and inspect the same evidence.", weight: 14, tone: "coral" },
      { id: "clarity", label: "Clarity", description: "Findings are structured for quick review and reuse.", weight: 8, tone: "blue" },
    ],
  },
  {
    id: "safety",
    label: "Safety / policy boundary",
    description: "Emphasizes truthful capability claims, risk identification, and escalation.",
    dimensions: [
      { id: "boundary", label: "Boundary discipline", description: "Claims only what the available evidence supports.", weight: 32, tone: "coral" },
      { id: "risk", label: "Risk recognition", description: "Surfaces unsafe, irreversible, or authority-expanding outcomes.", weight: 26, tone: "amber" },
      { id: "correctness", label: "Correctness", description: "The answer remains materially accurate and non-contradictory.", weight: 20, tone: "blue" },
      { id: "escalation", label: "Escalation fit", description: "Routes unresolved or high-risk decisions to the right reviewer.", weight: 14, tone: "green" },
      { id: "clarity", label: "Clarity", description: "The user can see the constraint and next safe action.", weight: 8, tone: "blue" },
    ],
  },
];

export function cloneRubric(dimensions: readonly EvaluationRubricDimension[]): EvaluationRubricDimension[] {
  return dimensions.map((dimension) => ({ ...dimension }));
}

export function rubricWeightTotal(dimensions: readonly EvaluationRubricDimension[]): number {
  return dimensions.reduce((total, dimension) => total + Math.max(0, dimension.weight), 0);
}

export function normalizeRubricWeights(dimensions: readonly EvaluationRubricDimension[]): EvaluationRubricDimension[] {
  if (!dimensions.length) return [];
  const total = rubricWeightTotal(dimensions);
  if (!total) {
    const equalWeight = Math.floor(100 / dimensions.length);
    const remainder = 100 - equalWeight * dimensions.length;
    return dimensions.map((dimension, index) => ({ ...dimension, weight: equalWeight + (index < remainder ? 1 : 0) }));
  }
  const projections = dimensions.map((dimension, index) => {
    const exact = (Math.max(0, dimension.weight) / total) * 100;
    const floor = Math.floor(exact);
    return { dimension, index, floor, remainder: exact - floor };
  });
  const remainder = 100 - projections.reduce((sum, item) => sum + item.floor, 0);
  const recipients = [...projections].sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  const bonusIndexes = new Set(recipients.slice(0, remainder).map((item) => item.index));
  return projections.map(({ dimension, index, floor }) => ({
    ...dimension,
    weight: floor + (bonusIndexes.has(index) ? 1 : 0),
  }));
}

export function presetRubric(id: Exclude<RubricPresetId, "custom">): EvaluationRubricDimension[] {
  const preset = presetCatalog.find((item) => item.id === id) ?? presetCatalog[0]!;
  return cloneRubric(preset.dimensions);
}

function makeId(label: string, existing: readonly EvaluationRubricDimension[]) {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom-dimension";
  let id = base;
  let suffix = 2;
  while (existing.some((dimension) => dimension.id === id)) id = `${base}-${suffix++}`;
  return id;
}

export type EvaluationRubricWorkbenchProps = {
  dimensions: readonly EvaluationRubricDimension[];
  preset?: RubricPresetId;
  adjudication?: RubricAdjudication;
  scoreScale?: string;
  onChange: (dimensions: EvaluationRubricDimension[], options?: { preset?: RubricPresetId; adjudication?: RubricAdjudication; scoreScale?: string; message?: string }) => void;
  onStatus?: (message: string) => void;
};

export default function EvaluationRubricWorkbench({ dimensions, preset = "balanced", adjudication = "second-review", scoreScale = "0–100", onChange, onStatus }: EvaluationRubricWorkbenchProps) {
  const [newLabel, setNewLabel] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newWeight, setNewWeight] = useState("10");
  const total = rubricWeightTotal(dimensions);
  const isBalanced = total === 100;
  const selectedPreset = useMemo(() => presetCatalog.find((item) => item.id === preset), [preset]);

  const announce = (message: string) => onStatus?.(message);

  const applyPreset = (nextPreset: RubricPresetId) => {
    if (nextPreset === "custom") {
      onChange(cloneRubric(dimensions), { preset: nextPreset, message: "Custom rubric mode enabled; existing dimensions remain editable in this preview." });
      announce("Custom rubric mode enabled; existing dimensions remain editable in this preview.");
      return;
    }
    onChange(presetRubric(nextPreset), { preset: nextPreset, message: `Applied the ${presetCatalog.find((item) => item.id === nextPreset)?.label ?? "selected"} rubric preset in the renderer preview.` });
    announce(`Applied the ${presetCatalog.find((item) => item.id === nextPreset)?.label ?? "selected"} rubric preset in the renderer preview.`);
  };

  const updateDimension = (id: string, patch: Partial<EvaluationRubricDimension>) => {
    const target = dimensions.find((dimension) => dimension.id === id);
    const message = patch.weight !== undefined && target ? `Updated ${target.label} rubric weight.` : "Updated a rubric dimension in the renderer preview.";
    onChange(dimensions.map((dimension) => dimension.id === id ? { ...dimension, ...patch } : { ...dimension }), { preset: "custom", message });
    announce(message);
  };

  const addDimension = () => {
    const label = newLabel.trim();
    if (!label) {
      announce("Enter a dimension name before adding a rubric criterion.");
      return;
    }
    const weight = Math.max(0, Math.min(50, Number(newWeight) || 0));
    onChange([...cloneRubric(dimensions), {
      id: makeId(label, dimensions),
      label,
      description: newDescription.trim() || "Custom reviewer criterion; define the evidence expected before activation.",
      weight,
      tone: toneCycle[dimensions.length % toneCycle.length]!,
    }], { preset: "custom", message: `Added custom rubric dimension “${label}” to this renderer preview.` });
    setNewLabel("");
    setNewDescription("");
    setNewWeight("10");
    announce(`Added custom rubric dimension “${label}” to this renderer preview.`);
  };

  return (
    <div className="evaluation-rubric-workbench" aria-label="Rubric builder preview">
      <div className="evaluation-rubric-workbench__toolbar">
        <label><span>Preset</span><select aria-label="Rubric preset" value={preset} onChange={(event) => applyPreset(event.target.value as RubricPresetId)}><option value="balanced">Balanced quality</option><option value="coding">Coder / implementation</option><option value="research">Research / grounded</option><option value="safety">Safety / policy boundary</option><option value="custom">Custom rubric</option></select></label>
        <label><span>Score scale</span><select aria-label="Rubric score scale" value={scoreScale} onChange={(event) => { const message = `Selected ${event.target.value} score scale for this preview.`; onChange(cloneRubric(dimensions), { scoreScale: event.target.value, message }); announce(message); }}><option>0–100</option><option>1–5</option><option>Pass / partial / fail</option></select></label>
        <label><span>Adjudication</span><select aria-label="Rubric adjudication" value={adjudication} onChange={(event) => { const message = "Updated reviewer adjudication policy in the preview."; onChange(cloneRubric(dimensions), { adjudication: event.target.value as RubricAdjudication, message }); announce(message); }}><option value="single-review">Single reviewer</option><option value="second-review">Second reviewer on disagreement</option><option value="consensus">Consensus required</option></select></label>
        <button type="button" className="button button--secondary" onClick={() => { const message = "Normalized rubric weights to 100% in the renderer preview."; onChange(normalizeRubricWeights(dimensions), { message }); announce(message); }}><WandSparkles size={14} /> Normalize to 100%</button>
      </div>

      <div className="evaluation-rubric-workbench__summary" role="status" aria-label="Rubric weight summary">
        <span><strong>{total}%</strong><small>weight total</small></span>
        <span><strong>{dimensions.length}</strong><small>criteria</small></span>
        <span><strong>{scoreScale}</strong><small>score scale</small></span>
        <span><strong>{adjudication === "single-review" ? "1" : adjudication === "second-review" ? "2" : "∑"}</strong><small>review path</small></span>
        <span className={isBalanced ? "is-ready" : "is-warning"}>{isBalanced ? <Check size={14} /> : <SlidersHorizontal size={14} />}<small>{isBalanced ? "Ready for rehearsal" : "Needs normalization"}</small></span>
      </div>

      {selectedPreset ? <p className="evaluation-rubric-workbench__description"><SlidersHorizontal size={13} /> {selectedPreset.description} Presets replace the visible rubric in this local preview; choose Custom to keep editing it.</p> : null}

      <div className="evaluation-rubric-workbench__dimensions">
        {dimensions.map((dimension) => <article key={dimension.id} className={`evaluation-rubric-workbench__dimension evaluation-rubric-workbench__dimension--${dimension.tone}`}>
          <div className="evaluation-rubric-workbench__dimension-head"><label><span>Criterion name</span><input aria-label={`${dimension.label} name`} value={dimension.label} onChange={(event) => updateDimension(dimension.id, { label: event.target.value })} /></label><button type="button" className="button button--ghost" aria-label={`Remove ${dimension.label} criterion`} disabled={dimensions.length <= 1} onClick={() => { const message = `Removed ${dimension.label} from the renderer rubric preview.`; onChange(dimensions.filter((item) => item.id !== dimension.id), { preset: "custom", message }); announce(message); }}><Trash2 size={14} /></button></div>
          <label><span>Evidence guidance</span><textarea aria-label={`${dimension.label} guidance`} value={dimension.description} onChange={(event) => updateDimension(dimension.id, { description: event.target.value })} /></label>
          <div className="evaluation-rubric-workbench__weight"><label><span>Weight</span><output>{dimension.weight}%</output></label><input type="range" min="0" max="50" step="1" value={dimension.weight} aria-label={`${dimension.label} weight`} onChange={(event) => updateDimension(dimension.id, { weight: Number(event.target.value) })} /></div>
        </article>)}
      </div>

      <div className="evaluation-rubric-workbench__add">
        <div className="evaluation-rubric-workbench__add-head"><span><Plus size={14} /> Add custom criterion</span><small>Use this for domain-specific evidence or reviewer gates.</small></div>
        <div className="evaluation-rubric-workbench__add-grid"><label><span>Name</span><input aria-label="New rubric criterion name" value={newLabel} onChange={(event) => setNewLabel(event.target.value)} placeholder="e.g. API contract fit" /></label><label><span>Weight</span><input aria-label="New rubric criterion weight" type="number" min="0" max="50" value={newWeight} onChange={(event) => setNewWeight(event.target.value)} /></label><label><span>Guidance</span><input aria-label="New rubric criterion guidance" value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="What should a reviewer verify?" /></label><button type="button" className="button button--secondary" onClick={addDimension}><Plus size={14} /> Add criterion</button></div>
      </div>

      <p className="evaluation-rubric-workbench__boundary"><RotateCcw size={13} /> Rubric edits are renderer-local and reversible through the parent studio history. No evaluator, benchmark, training label, provider request, or durable policy is changed.</p>
    </div>
  );
}
