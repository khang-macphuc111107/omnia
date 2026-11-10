import {
  Activity,
  Check,
  CircleHelp,
  Clipboard,
  FlaskConical,
  Download,
  FileJson2,
  LockKeyhole,
  RotateCcw,
  Scale,
  ShieldCheck,
  Sparkles,
  Undo2,
  Redo2,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  buildRlaifBlindOrderPreview,
  buildRlaifReviewExport,
  serializeRlaifReviewExport,
  type RlaifBlindOrder,
  type RlaifAnnotationConfidence,
  type RlaifAnnotationRationale,
  type RlaifExportFormat,
} from "./rlaif-review-export";

type Preference = "prefer-a" | "prefer-b" | "tie" | "abstain";
type JudgeCount = 1 | 3 | 5;
type DisagreementPolicy = "human-review" | "majority" | "abstain";

type Comparison = {
  id: string;
  prompt: string;
  responseA: string;
  responseB: string;
  preference: Preference | null;
  rationale?: RlaifAnnotationRationale | null;
  confidence?: RlaifAnnotationConfidence | null;
};

type RlaifConfig = {
  algorithm: "DPO" | "PPO" | "GRPO";
  evaluatorRoute: string;
  rewardRecipe: string;
  judgeCount: JudgeCount;
  agreementThreshold: number;
  disagreementPolicy: DisagreementPolicy;
  blindJudging: boolean;
  blindOrderSeed: string;
  swapTestEnabled: boolean;
  holdoutPercent: number;
  comparisons: Comparison[];
};

const initialConfig: RlaifConfig = {
  algorithm: "DPO",
  evaluatorRoute: "Cloud evaluator · choose endpoint later",
  rewardRecipe: "Correctness + usefulness",
  judgeCount: 3,
  agreementThreshold: 67,
  disagreementPolicy: "human-review",
  blindJudging: true,
  blindOrderSeed: "fixture-seed-2026-09",
  swapTestEnabled: true,
  holdoutPercent: 20,
  comparisons: [
    {
      id: "fixture-compiler-error",
      prompt: "Explain a compiler error and suggest a fix.",
      responseA: "Identifies the failing expression, explains the type mismatch, then gives a minimal correction.",
      responseB: "Provides a broad tutorial and several speculative fixes without pointing to the failing expression.",
      preference: null,
      rationale: null,
      confidence: null,
    },
    {
      id: "fixture-uncertain-fact",
      prompt: "Answer a question when the available evidence is incomplete.",
      responseA: "States the uncertainty, separates known facts from assumptions, and names what evidence would resolve it.",
      responseB: "Gives a confident answer without qualifying the missing evidence.",
      preference: null,
      rationale: null,
      confidence: null,
    },
    {
      id: "fixture-format-request",
      prompt: "Return a concise implementation handoff.",
      responseA: "Summarizes the change, files touched, and one focused verification result.",
      responseB: "Lists every exploratory step and repeats the request before giving the result.",
      preference: null,
      rationale: null,
      confidence: null,
    },
  ],
};

const preferenceLabels: Record<Preference, string> = {
  "prefer-a": "Prefer A",
  "prefer-b": "Prefer B",
  tie: "Tie",
  abstain: "Abstain",
};

const rationaleLabels: Record<RlaifAnnotationRationale, string> = {
  correctness: "Correctness",
  groundedness: "Groundedness / evidence",
  "instruction-fit": "Instruction fit",
  clarity: "Clarity / usefulness",
  safety: "Safety / boundaries",
  balanced: "Both are comparable",
  "insufficient-evidence": "Insufficient evidence",
  other: "Other reason",
};

const confidenceLabels: Record<RlaifAnnotationConfidence, string> = {
  low: "Low · tentative",
  medium: "Medium · reasonably sure",
  high: "High · clear preference",
};

export type RlaifReviewSummary = {
  reviewed: number;
  preferA: number;
  preferB: number;
  ties: number;
  abstentions: number;
  unresolved: number;
};

export type RlaifAnnotationQualitySummary = {
  complete: number;
  incomplete: number;
  coveragePercent: number;
  missingRationale: number;
  missingConfidence: number;
};

export function summarizeRlaifReviews(comparisons: readonly Comparison[]): RlaifReviewSummary {
  return comparisons.reduce<RlaifReviewSummary>((summary, comparison) => {
    if (!comparison.preference) {
      summary.unresolved += 1;
      return summary;
    }
    summary.reviewed += 1;
    if (comparison.preference === "prefer-a") summary.preferA += 1;
    if (comparison.preference === "prefer-b") summary.preferB += 1;
    if (comparison.preference === "tie") summary.ties += 1;
    if (comparison.preference === "abstain") summary.abstentions += 1;
    return summary;
  }, { reviewed: 0, preferA: 0, preferB: 0, ties: 0, abstentions: 0, unresolved: 0 });
}

export function summarizeRlaifAnnotationQuality(comparisons: readonly Comparison[]): RlaifAnnotationQualitySummary {
  const complete = comparisons.filter((comparison) => comparison.preference !== null && comparison.rationale != null && comparison.confidence != null).length;
  const reviewed = comparisons.filter((comparison) => comparison.preference !== null);
  return {
    complete,
    incomplete: comparisons.length - complete,
    coveragePercent: comparisons.length === 0 ? 0 : Math.round((complete / comparisons.length) * 100),
    missingRationale: reviewed.filter((comparison) => comparison.rationale == null).length,
    missingConfidence: reviewed.filter((comparison) => comparison.confidence == null).length,
  };
}

function cloneConfig(config: RlaifConfig): RlaifConfig {
  return { ...config, comparisons: config.comparisons.map((comparison) => ({ ...comparison })) };
}

function downloadRlaifReviewExport(payload: string, format: RlaifExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-rlaif-review-checkpoint.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export default function RlaifLabPreview() {
  const [config, setConfig] = useState<RlaifConfig>(() => cloneConfig(initialConfig));
  const [past, setPast] = useState<RlaifConfig[]>([]);
  const [future, setFuture] = useState<RlaifConfig[]>([]);
  const [status, setStatus] = useState("AI-feedback rehearsal is staged locally.");
  const [exportFormat, setExportFormat] = useState<RlaifExportFormat>("json");
  const summary = useMemo(() => summarizeRlaifReviews(config.comparisons), [config.comparisons]);
  const annotationQuality = useMemo(() => summarizeRlaifAnnotationQuality(config.comparisons), [config.comparisons]);
  const blindOrder = useMemo(() => buildRlaifBlindOrderPreview(config.comparisons, config.blindOrderSeed, config.blindJudging), [config.comparisons, config.blindJudging, config.blindOrderSeed]);
  const reviewExport = useMemo(() => buildRlaifReviewExport(config), [config]);
  const reviewExportPayload = useMemo(() => serializeRlaifReviewExport(reviewExport, exportFormat), [reviewExport, exportFormat]);

  const update = (mutator: (draft: RlaifConfig) => void, message: string) => {
    setPast((entries) => [...entries.slice(-19), cloneConfig(config)]);
    setFuture([]);
    const next = cloneConfig(config);
    mutator(next);
    setConfig(next);
    setStatus(message);
  };

  const undo = () => {
    const previous = past.at(-1);
    if (!previous) return;
    setPast((entries) => entries.slice(0, -1));
    setFuture((entries) => [...entries, cloneConfig(config)]);
    setConfig(cloneConfig(previous));
    setStatus("Undid the last RLAIF preview change.");
  };

  const redo = () => {
    const next = future.at(-1);
    if (!next) return;
    setFuture((entries) => entries.slice(0, -1));
    setPast((entries) => [...entries, cloneConfig(config)]);
    setConfig(cloneConfig(next));
    setStatus("Redid the RLAIF preview change.");
  };

  const reset = () => {
    setPast((entries) => [...entries.slice(-19), cloneConfig(config)]);
    setFuture([]);
    setConfig(cloneConfig(initialConfig));
    setStatus("RLAIF lab reset to its preview defaults.");
  };

  const choosePreference = (comparisonId: string, preference: Preference) => update((draft) => {
    const comparison = draft.comparisons.find((item) => item.id === comparisonId);
    if (comparison) {
      comparison.preference = comparison.preference === preference ? null : preference;
      if (comparison.preference === null) {
        comparison.rationale = null;
        comparison.confidence = null;
      }
    }
  }, "Updated an illustrative comparison decision in this renderer session.");

  const chooseRationale = (comparisonId: string, rationale: RlaifAnnotationRationale | null) => update((draft) => {
    const comparison = draft.comparisons.find((item) => item.id === comparisonId);
    if (comparison) comparison.rationale = rationale;
  }, "Updated the primary rationale label in this renderer session.");

  const chooseConfidence = (comparisonId: string, confidence: RlaifAnnotationConfidence | null) => update((draft) => {
    const comparison = draft.comparisons.find((item) => item.id === comparisonId);
    if (comparison) comparison.confidence = confidence;
  }, "Updated the reviewer-confidence label in this renderer session.");

  const changeBlindOrder = (mutator: (draft: RlaifConfig) => void, message: string) => update((draft) => {
    mutator(draft);
    draft.comparisons.forEach((comparison) => {
      comparison.preference = null;
      comparison.rationale = null;
      comparison.confidence = null;
    });
  }, `${message} Existing local labels were cleared because the visible slot order changed.`);

  const copyReviewExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no RLAIF review checkpoint was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(reviewExportPayload);
      setStatus(`Copied the ${exportFormat.toUpperCase()} RLAIF review checkpoint preview.`);
    } catch {
      setStatus("Clipboard access was denied; the RLAIF review checkpoint remains renderer-local.");
    }
  };

  return (
    <section className="rlaif-lab" aria-labelledby="rlaif-lab-title">
      <header className="rlaif-lab__header">
        <div>
          <span className="eyebrow"><Sparkles size={13} /> Preference learning</span>
          <h3 id="rlaif-lab-title">RLAIF Lab</h3>
          <p>Shape an AI-feedback workflow: evaluator, rubric, agreement policy, comparison review, and held-out evaluation.</p>
        </div>
        <div className="rlaif-lab__history" role="toolbar" aria-label="RLAIF preview history">
          <button type="button" className="button button--ghost" onClick={undo} disabled={!past.length} aria-label="Undo RLAIF preview change"><Undo2 size={13} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={!future.length} aria-label="Redo RLAIF preview change"><Redo2 size={13} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={13} /> Reset</button>
        </div>
      </header>

      <div className="rlaif-lab__boundary" role="note"><LockKeyhole size={14} /> Preview only · no evaluator/model request, preference dataset write, reward-model training, checkpoint, cloud job, or native receipt is created.</div>

      <div className="rlaif-lab__grid">
        <article className="rlaif-lab__card rlaif-lab__config">
          <div className="rlaif-lab__card-title"><span><FlaskConical size={14} /> Feedback pipeline</span><span className="rlaif-lab__tag">Editable preview</span></div>
          <label><span>Optimization recipe</span><select aria-label="RLAIF optimization recipe" value={config.algorithm} onChange={(event) => update((draft) => { draft.algorithm = event.target.value as RlaifConfig["algorithm"]; }, "Updated the illustrative optimization recipe.")}><option>DPO</option><option>PPO</option><option>GRPO</option></select><small>DPO / PPO / GRPO are plan labels only; no trainer is connected.</small></label>
          <label><span>Evaluator route</span><input aria-label="RLAIF evaluator route" value={config.evaluatorRoute} onChange={(event) => update((draft) => { draft.evaluatorRoute = event.target.value; }, "Updated the evaluator route label; it was not contacted.")} /><small>Endpoint selection and credentials are deliberately not resolved in this preview.</small></label>
          <label><span>Reward rubric</span><select aria-label="RLAIF reward rubric" value={config.rewardRecipe} onChange={(event) => update((draft) => { draft.rewardRecipe = event.target.value; }, "Updated the illustrative reward rubric.")}><option>Correctness + usefulness</option><option>Groundedness + citations</option><option>Instruction fit + concise delivery</option><option>Custom rubric · author later</option></select></label>
          <div className="rlaif-lab__option-grid">
            <label><span>Judge panel</span><select aria-label="RLAIF judge count" value={config.judgeCount} onChange={(event) => update((draft) => { draft.judgeCount = Number(event.target.value) as JudgeCount; }, "Updated the judge-panel size preview.")}><option value={1}>1 evaluator</option><option value={3}>3 evaluators</option><option value={5}>5 evaluators</option></select></label>
            <label><span>Agreement target</span><select aria-label="RLAIF agreement threshold" value={config.agreementThreshold} onChange={(event) => update((draft) => { draft.agreementThreshold = Number(event.target.value); }, "Updated the agreement threshold preview.")}><option value={50}>50% majority</option><option value={67}>67% supermajority</option><option value={80}>80% strong consensus</option><option value={100}>100% unanimous</option></select></label>
            <label><span>Disagreement</span><select aria-label="RLAIF disagreement policy" value={config.disagreementPolicy} onChange={(event) => update((draft) => { draft.disagreementPolicy = event.target.value as DisagreementPolicy; }, "Updated the disagreement policy preview.")}><option value="human-review">Route to human review</option><option value="majority">Use majority vote</option><option value="abstain">Keep as unresolved</option></select></label>
            <label><span>Holdout</span><select aria-label="RLAIF holdout split" value={config.holdoutPercent} onChange={(event) => update((draft) => { draft.holdoutPercent = Number(event.target.value); }, "Updated the held-out evaluation split preview.")}><option value={10}>10% holdout</option><option value={20}>20% holdout</option><option value={25}>25% holdout</option><option value={30}>30% holdout</option></select></label>
          </div>
          <label><span>Blind order seed</span><input aria-label="RLAIF blind order seed" value={config.blindOrderSeed} onChange={(event) => changeBlindOrder((draft) => { draft.blindOrderSeed = event.target.value; }, "Updated the deterministic blind-order seed in the renderer preview.")} /><small>Stable seed for this rehearsal only; it is not a traffic assignment or experiment key.</small></label>
          <label className="rlaif-lab__toggle"><span><strong>Blind candidate order</strong><small>Use deterministic display slots so source/model identity is not part of the review choice.</small></span><input type="checkbox" checked={config.blindJudging} onChange={(event) => changeBlindOrder((draft) => { draft.blindJudging = event.target.checked; }, "Updated blind-order preference in the renderer preview.")} /></label>
          <label className="rlaif-lab__toggle"><span><strong>Swap-test rehearsal</strong><small>Plan a paired A/B ↔ B/A replay; no second review or evaluator call runs here.</small></span><input type="checkbox" checked={config.swapTestEnabled} onChange={(event) => update((draft) => { draft.swapTestEnabled = event.target.checked; }, "Updated the swap-test rehearsal setting.")} /></label>
        </article>

        <aside className="rlaif-lab__card rlaif-lab__readiness">
          <div className="rlaif-lab__card-title"><span><ShieldCheck size={14} /> Review gates</span><span className="rlaif-lab__tag">Contract preview</span></div>
          <ul>
            <li><Check size={13} /><span>Keep unresolved judgments separate from reward labels</span></li>
            <li><Check size={13} /><span>Hold out comparisons before any future tuning pass</span></li>
            <li><Check size={13} /><span>Preserve judge rubric and evaluator version for audit</span></li>
            <li><CircleHelp size={13} /><span>Require human review on low agreement: {config.disagreementPolicy === "human-review" ? "enabled" : "not selected"}</span></li>
          </ul>
          <div className="rlaif-lab__signal"><Scale size={15} /><span><strong>{summary.reviewed}/{config.comparisons.length}</strong><small>illustrative comparisons reviewed</small></span></div>
          <div className="rlaif-lab__counts" aria-label="RLAIF comparison summary"><span><strong>{summary.preferA}</strong><small>prefer A</small></span><span><strong>{summary.preferB}</strong><small>prefer B</small></span><span><strong>{summary.ties}</strong><small>ties</small></span><span><strong>{summary.abstentions + summary.unresolved}</strong><small>unresolved</small></span></div>
          <div className="rlaif-lab__blind-summary" aria-label="RLAIF blind order rehearsal"><span><strong>{blindOrder.counts.ab} A/B · {blindOrder.counts.ba} B/A</strong><small>deterministic slot orders · seed {blindOrder.seed}</small></span><span><strong>{config.swapTestEnabled ? "Planned · not run" : "Disabled"}</strong><small>swap-test rehearsal</small></span></div>
          <p className="rlaif-lab__note"><Activity size={13} /> Counts are based only on the fictional examples below, not real user feedback or evaluator output.</p>
        </aside>
      </div>

      <section className="rlaif-lab__comparisons" aria-labelledby="rlaif-comparisons-title">
        <header><div><span className="eyebrow">Illustrative fixtures</span><h4 id="rlaif-comparisons-title">Pairwise preference review</h4></div><span className="rlaif-lab__tag">No source transcript</span></header>
        <p className="rlaif-lab__intro">Choose the stronger answer, mark a tie, or abstain. These built-in fixtures demonstrate the UI only and cannot enter a real training set.</p>
        <div className="rlaif-lab__annotation-summary" role="region" aria-label="RLAIF annotation completeness">
          <span><strong>{annotationQuality.complete}</strong><small>complete of {config.comparisons.length} · {annotationQuality.coveragePercent}% coverage</small></span>
          <span><strong>{annotationQuality.missingRationale}</strong><small>reviewed labels missing a reason</small></span>
          <span><strong>{annotationQuality.missingConfidence}</strong><small>reviewed labels missing confidence</small></span>
        </div>
        {config.comparisons.map((comparison, index) => {
          const order: RlaifBlindOrder = blindOrder.assignments.find(({ comparisonId }) => comparisonId === comparison.id)?.order ?? "ab";
          const orderedAnswers = order === "ab"
            ? [{ slot: "A", text: comparison.responseA }, { slot: "B", text: comparison.responseB }]
            : [{ slot: "A", text: comparison.responseB }, { slot: "B", text: comparison.responseA }];
          return (
          <article key={comparison.id} className="rlaif-lab__comparison">
            <div className="rlaif-lab__prompt"><span>Prompt {index + 1}</span><strong>{comparison.prompt}</strong></div>
            <div className="rlaif-lab__answers">
              {orderedAnswers.map((answer) => <div key={answer.slot}><span>Candidate {answer.slot}</span><p>{answer.text}</p></div>)}
            </div>
            <p className="rlaif-lab__order-note">{config.blindJudging ? `Blind slot order: ${order === "ab" ? "A → B" : "B → A"}` : "Fixed slot order: A → B"} · source identity is not available in this fixture.</p>
            <div className="rlaif-lab__choice-row" role="group" aria-label={`Preference for comparison ${index + 1}`}>
              {(["prefer-a", "prefer-b", "tie", "abstain"] as const).map((preference) => <button key={preference} type="button" className={comparison.preference === preference ? "is-selected" : ""} aria-pressed={comparison.preference === preference} onClick={() => choosePreference(comparison.id, preference)}>{preferenceLabels[preference]}</button>)}
              <span>{comparison.preference ? `Preview label: ${preferenceLabels[comparison.preference]}` : "Awaiting local choice"}</span>
            </div>
            <div className="rlaif-lab__annotation-fields">
              <label><span>Primary reason</span><select aria-label={`Rationale for comparison ${index + 1}`} value={comparison.rationale ?? ""} disabled={comparison.preference === null} onChange={(event) => chooseRationale(comparison.id, (event.target.value || null) as RlaifAnnotationRationale | null)}><option value="">Choose a reason</option>{Object.entries(rationaleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label><span>Reviewer confidence</span><select aria-label={`Confidence for comparison ${index + 1}`} value={comparison.confidence ?? ""} disabled={comparison.preference === null} onChange={(event) => chooseConfidence(comparison.id, (event.target.value || null) as RlaifAnnotationConfidence | null)}><option value="">Choose confidence</option>{Object.entries(confidenceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <span className={`rlaif-lab__annotation-state${comparison.preference !== null && comparison.rationale !== null && comparison.confidence !== null ? " is-complete" : ""}`}>
                {comparison.preference === null ? "No preference label" : comparison.rationale != null && comparison.confidence != null ? "Annotation complete" : `Missing ${[comparison.rationale == null ? "reason" : null, comparison.confidence == null ? "confidence" : null].filter(Boolean).join(" + ")}`}
              </span>
            </div>
          </article>
          );
        })}
      </section>

      <section className="rlaif-lab__export" aria-labelledby="rlaif-export-title">
        <header className="rlaif-lab__export-header"><div><span className="eyebrow"><FileJson2 size={13} /> Review checkpoint</span><h4 id="rlaif-export-title">Export a redacted annotation snapshot</h4></div><span className="rlaif-lab__tag">Session-only</span></header>
        <div className="rlaif-lab__export-toolbar">
          <label><span>Format</span><select aria-label="RLAIF review export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as RlaifExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
          <span className="rlaif-lab__export-key">{reviewExport.checkpointKey}</span>
          <button type="button" className="button button--secondary" onClick={() => void copyReviewExport()}><Clipboard size={13} /> Copy</button>
          <button type="button" className="button button--secondary" onClick={() => setStatus(downloadRlaifReviewExport(reviewExportPayload, exportFormat) ? "Browser download started; no RLAIF checkpoint file or native receipt was created." : "Browser download is unavailable in this preview environment.")}><Download size={13} /> Download</button>
        </div>
        <pre aria-label="RLAIF review checkpoint export preview">{reviewExportPayload}</pre>
        <p className="rlaif-lab__note"><LockKeyhole size={13} /> Snapshot includes labels, counts, and policy metadata only. It excludes prompts, responses, evaluator output, credentials, model weights, and durable writes.</p>
      </section>

      <p className="rlaif-lab__status" role="status" aria-live="polite">{status}</p>
    </section>
  );
}
