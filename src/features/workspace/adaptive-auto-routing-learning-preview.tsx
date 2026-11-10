import {
  Activity,
  BrainCircuit,
  Check,
  Clipboard,
  Gauge,
  LockKeyhole,
  RotateCcw,
  Route,
  ShieldCheck,
  Sparkles,
  Undo2,
  Redo2,
} from "lucide-react";
import { useMemo, useState } from "react";

import { selectableModelProfiles } from "./provider-catalog";
import type { ModelProfileView, ProviderView } from "./types";

type AdaptiveStrategy = "deterministic" | "adaptive-shadow" | "learned-promotion";
type LearningMode = "observe-only" | "recommend" | "promotion-review";
type LearningCadence = "per-run" | "hourly" | "daily" | "manual";
type AdaptiveRole = "main" | "subagent" | "planner" | "reviewer";
type SignalId = "quality" | "latency" | "cost" | "context-fit" | "cache-reuse" | "user-feedback";
type LearningSourceId = "run-outcomes" | "message-feedback" | "telemetry" | "context-receipts" | "evaluation-scores";
type ExportFormat = "json" | "markdown";

type AdaptiveDraft = {
  readonly strategy: AdaptiveStrategy;
  readonly learningMode: LearningMode;
  readonly cadence: LearningCadence;
  readonly role: AdaptiveRole;
  readonly explorationPercent: number;
  readonly confidenceFloor: number;
  readonly promotionThreshold: number;
  readonly minimumSamples: number;
  readonly signals: Record<SignalId, boolean>;
  readonly sources: Record<LearningSourceId, boolean>;
};

type AdaptiveHistory = {
  past: AdaptiveDraft[];
  present: AdaptiveDraft;
  future: AdaptiveDraft[];
};

const SIGNALS: ReadonlyArray<{ id: SignalId; label: string; detail: string }> = [
  { id: "quality", label: "Quality score", detail: "Reviewed outcome or evaluation signal" },
  { id: "latency", label: "Latency", detail: "Observed response-time signal" },
  { id: "cost", label: "Cost", detail: "Reported usage/cost signal when available" },
  { id: "context-fit", label: "Context fit", detail: "Context headroom and capability fit" },
  { id: "cache-reuse", label: "Cache reuse", detail: "User-side reuse and provider evidence kept separate" },
  { id: "user-feedback", label: "User feedback", detail: "Explicit helpfulness or correction signal" },
];

const LEARNING_SOURCES: ReadonlyArray<{ id: LearningSourceId; label: string; detail: string }> = [
  { id: "run-outcomes", label: "Run outcomes", detail: "Completion, failure, retry, and stop markers" },
  { id: "message-feedback", label: "Message feedback", detail: "Explicit user review only" },
  { id: "telemetry", label: "Usage telemetry", detail: "High-level tokens, latency, rate, and cost fields" },
  { id: "context-receipts", label: "Context receipts", detail: "Selected/omitted source metadata, not raw content" },
  { id: "evaluation-scores", label: "Evaluation scores", detail: "Reviewed rubric outcomes and holdout splits" },
];

const ROLE_LABELS: Record<AdaptiveRole, string> = {
  main: "Main agent",
  subagent: "Subagent",
  planner: "Planner",
  reviewer: "Reviewer",
};

const SIGNAL_LABELS: Record<SignalId, string> = Object.fromEntries(SIGNALS.map((signal) => [signal.id, signal.label])) as Record<SignalId, string>;
const SOURCE_LABELS: Record<LearningSourceId, string> = Object.fromEntries(LEARNING_SOURCES.map((source) => [source.id, source.label])) as Record<LearningSourceId, string>;

const DEFAULT_DRAFT: AdaptiveDraft = {
  strategy: "adaptive-shadow",
  learningMode: "recommend",
  cadence: "per-run",
  role: "main",
  explorationPercent: 12,
  confidenceFloor: 70,
  promotionThreshold: 82,
  minimumSamples: 20,
  signals: {
    quality: true,
    latency: true,
    cost: true,
    "context-fit": true,
    "cache-reuse": false,
    "user-feedback": true,
  },
  sources: {
    "run-outcomes": true,
    "message-feedback": true,
    telemetry: true,
    "context-receipts": true,
    "evaluation-scores": false,
  },
};

function cloneDraft(draft: AdaptiveDraft): AdaptiveDraft {
  return { ...draft, signals: { ...draft.signals }, sources: { ...draft.sources } };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function providerFor(profile: ModelProfileView, providers: readonly ProviderView[]): ProviderView | null {
  return providers.find((provider) => provider.id === profile.connectionId) ?? null;
}

function candidateScore(profile: ModelProfileView, provider: ProviderView | null, draft: AdaptiveDraft): number {
  let score = 52;
  if (draft.signals.quality && profile.capabilities.includes("reasoning")) score += 10;
  if (draft.signals.latency && profile.speed === "Fast") score += 8;
  if (draft.signals.cost && provider?.kind === "Local") score += 7;
  if (draft.signals["context-fit"] && !profile.contextLabel.toLocaleLowerCase().includes("not reported")) score += 7;
  if (draft.signals["cache-reuse"] && provider?.state === "connected") score += 4;
  if (draft.signals["user-feedback"] && profile.favorite) score += 4;
  if (draft.explorationPercent > 30) score += Math.round((draft.explorationPercent - 30) / 10);
  if (provider?.state !== "connected" || profile.status !== "available") score -= 28;
  return clamp(score, 0, 100);
}

function serializeAdaptivePreview(
  draft: AdaptiveDraft,
  candidates: readonly AdaptiveCandidate[],
  format: ExportFormat,
): string {
  const recommendation = candidates.find((candidate) => candidate.ready) ?? null;
  const payload = {
    schema: "omnia.adaptive-auto-routing-learning-preview.v1",
    scope: "renderer-session",
    strategy: draft.strategy,
    learning: {
      mode: draft.learningMode,
      cadence: draft.cadence,
      role: draft.role,
      explorationPercent: draft.explorationPercent,
      confidenceFloor: draft.confidenceFloor,
      promotionThreshold: draft.promotionThreshold,
      minimumSamples: draft.minimumSamples,
      signals: Object.entries(draft.signals).filter(([, enabled]) => enabled).map(([id]) => SIGNAL_LABELS[id as SignalId]),
      sources: Object.entries(draft.sources).filter(([, enabled]) => enabled).map(([id]) => SOURCE_LABELS[id as LearningSourceId]),
    },
    recommendation: recommendation ? { modelProfileId: recommendation.model.id, model: recommendation.model.displayName, score: recommendation.score, state: recommendation.state } : null,
    candidates: candidates.map((candidate) => ({ modelProfileId: candidate.model.id, model: candidate.model.displayName, provider: candidate.model.providerName, score: candidate.score, state: candidate.state })),
    boundary: "Renderer-local rehearsal only; no model training, provider request, route decision, credential access, raw prompt capture, or durable policy write was performed.",
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia adaptive Auto routing / learning preview",
    "",
    "> Renderer-local rehearsal only; no model training, provider request, or durable route write was performed.",
    "",
    `- Strategy: ${draft.strategy}`,
    `- Learning mode: ${draft.learningMode}`,
    `- Role: ${ROLE_LABELS[draft.role]}`,
    `- Cadence: ${draft.cadence}`,
    `- Exploration: ${draft.explorationPercent}% · confidence floor: ${draft.confidenceFloor}% · promotion threshold: ${draft.promotionThreshold}%`,
    `- Minimum samples: ${draft.minimumSamples}`,
    `- Signals: ${Object.entries(draft.signals).filter(([, enabled]) => enabled).map(([id]) => SIGNAL_LABELS[id as SignalId]).join(", ") || "None"}`,
    `- Sources: ${Object.entries(draft.sources).filter(([, enabled]) => enabled).map(([id]) => SOURCE_LABELS[id as LearningSourceId]).join(", ") || "None"}`,
    `- Recommendation: ${recommendation ? `${recommendation.model.displayName} (${recommendation.score}/100)` : "Unavailable"}`,
  ].join("\n");
}

type AdaptiveCandidate = {
  readonly model: ModelProfileView;
  readonly provider: ProviderView | null;
  readonly score: number;
  readonly ready: boolean;
  readonly state: "ready" | "review" | "blocked";
};

export function AdaptiveAutoRoutingLearningPreview({
  providers,
  modelProfileId,
  onModelProfileChange,
}: {
  readonly providers: readonly ProviderView[];
  readonly modelProfileId: string;
  readonly onModelProfileChange: (profileId: string) => void;
}) {
  const profiles = useMemo(() => selectableModelProfiles([...providers]).filter((profile) => profile.id !== "auto"), [providers]);
  const [history, setHistory] = useState<AdaptiveHistory>(() => ({ past: [], present: cloneDraft(DEFAULT_DRAFT), future: [] }));
  const [status, setStatus] = useState("Adaptive decisions remain a renderer-local rehearsal.");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json");
  const [copied, setCopied] = useState(false);

  const candidates = useMemo<AdaptiveCandidate[]>(() => profiles
    .map((model) => {
      const provider = providerFor(model, providers);
      const ready = model.status === "available" && provider?.enabled === true && provider.state === "connected";
      const state: AdaptiveCandidate["state"] = ready
        ? "ready"
        : provider?.state === "degraded" || model.status === "degraded"
          ? "blocked"
          : "review";
      return { model, provider, score: candidateScore(model, provider, history.present), ready, state };
    })
    .sort((left, right) => Number(right.ready) - Number(left.ready) || right.score - left.score || left.model.displayName.localeCompare(right.model.displayName)), [history.present, profiles, providers]);
  const recommendation = candidates.find((candidate) => candidate.ready) ?? null;
  const exportPayload = useMemo(() => serializeAdaptivePreview(history.present, candidates, exportFormat), [candidates, exportFormat, history.present]);

  const commit = (patch: Partial<AdaptiveDraft>, message: string) => {
    setHistory((current) => {
      const next = cloneDraft({ ...current.present, ...patch });
      return { past: [...current.past, cloneDraft(current.present)], present: next, future: [] };
    });
    setStatus(message);
  };

  const updateSignal = (id: SignalId, enabled: boolean) => commit({ signals: { ...history.present.signals, [id]: enabled } }, `${SIGNAL_LABELS[id]} signal ${enabled ? "enabled" : "disabled"} in the renderer preview.`);
  const updateSource = (id: LearningSourceId, enabled: boolean) => commit({ sources: { ...history.present.sources, [id]: enabled } }, `${SOURCE_LABELS[id]} source ${enabled ? "enabled" : "disabled"} in the renderer preview.`);

  const undo = () => setHistory((current) => {
    const previous = current.past.at(-1);
    if (!previous) return current;
    setStatus("Undid the last adaptive Auto routing change.");
    return { past: current.past.slice(0, -1), present: cloneDraft(previous), future: [cloneDraft(current.present), ...current.future] };
  });
  const redo = () => setHistory((current) => {
    const next = current.future[0];
    if (!next) return current;
    setStatus("Reapplied the next adaptive Auto routing change.");
    return { past: [...current.past, cloneDraft(current.present)], present: cloneDraft(next), future: current.future.slice(1) };
  });
  const reset = () => {
    setHistory((current) => ({ past: [...current.past, cloneDraft(current.present)], present: cloneDraft(DEFAULT_DRAFT), future: [] }));
    setStatus("Adaptive Auto routing preview reset to defaults.");
  };
  const selectRecommendation = () => {
    if (!recommendation) {
      setStatus("No connected, available model can be selected from this catalog snapshot.");
      return;
    }
    onModelProfileChange(recommendation.model.id);
    setStatus(`${recommendation.model.displayName} selected in the shared renderer route preview.`);
  };
  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard is unavailable; no adaptive preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setCopied(true);
      setStatus(`Copied the renderer-local ${exportFormat.toUpperCase()} adaptive preview.`);
    } catch {
      setStatus("Clipboard access was denied; no adaptive preview was copied.");
    }
  };

  return (
    <section className="adaptive-auto-routing" aria-labelledby="adaptive-auto-routing-title">
      <header className="adaptive-auto-routing__header">
        <span className="adaptive-auto-routing__icon"><BrainCircuit size={16} /></span>
        <span><span className="eyebrow">Adaptive intelligence rehearsal</span><h3 id="adaptive-auto-routing-title">Adaptive Auto routing &amp; learning</h3><p>Shape how Auto could combine reviewed outcomes, telemetry, context fit, and explicit feedback before a future policy evaluator is wired.</p></span>
        <span className="adaptive-auto-routing__badge"><Sparkles size={12} /> Preview only</span>
      </header>

      <div className="adaptive-auto-routing__history" role="toolbar" aria-label="Adaptive Auto routing history">
        <span><strong>Reversible learning policy</strong><small>{status}</small></span>
        <span className="adaptive-auto-routing__steps">{history.past.length + history.future.length} steps</span>
        <button type="button" className="button button--ghost" onClick={undo} disabled={!history.past.length} aria-label="Undo adaptive Auto routing change"><Undo2 size={12} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={!history.future.length} aria-label="Redo adaptive Auto routing change"><Redo2 size={12} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset adaptive Auto routing preview"><RotateCcw size={12} /> Reset</button>
      </div>

      <div className="adaptive-auto-routing__controls">
        <label><span>Auto strategy</span><select aria-label="Auto strategy mode" value={history.present.strategy} onChange={(event) => commit({ strategy: event.target.value as AdaptiveStrategy }, "Auto strategy changed in the renderer preview.")}><option value="deterministic">Deterministic rules</option><option value="adaptive-shadow">Adaptive shadow</option><option value="learned-promotion">Learned promotion</option></select></label>
        <label><span>Learning mode</span><select aria-label="Adaptive learning mode" value={history.present.learningMode} onChange={(event) => commit({ learningMode: event.target.value as LearningMode }, "Adaptive learning mode changed in the renderer preview.")}><option value="observe-only">Observe only</option><option value="recommend">Recommend route</option><option value="promotion-review">Promotion review</option></select></label>
        <label><span>Role</span><select aria-label="Adaptive routing role" value={history.present.role} onChange={(event) => commit({ role: event.target.value as AdaptiveRole }, "Adaptive role scope changed in the renderer preview.")}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Update cadence</span><select aria-label="Adaptive update cadence" value={history.present.cadence} onChange={(event) => commit({ cadence: event.target.value as LearningCadence }, "Adaptive update cadence changed in the renderer preview.")}><option value="per-run">After each run</option><option value="hourly">Hourly review</option><option value="daily">Daily review</option><option value="manual">Manual only</option></select></label>
      </div>

      <div className="adaptive-auto-routing__thresholds">
        <label><span>Exploration <output>{history.present.explorationPercent}%</output></span><input type="range" min="0" max="60" step="1" value={history.present.explorationPercent} onChange={(event) => commit({ explorationPercent: Number(event.target.value) }, "Exploration budget changed in the renderer preview.")} aria-label="Adaptive exploration percentage" /></label>
        <label><span>Confidence floor <output>{history.present.confidenceFloor}%</output></span><input type="range" min="0" max="100" step="1" value={history.present.confidenceFloor} onChange={(event) => commit({ confidenceFloor: Number(event.target.value) }, "Confidence floor changed in the renderer preview.")} aria-label="Adaptive confidence floor" /></label>
        <label><span>Promotion threshold <output>{history.present.promotionThreshold}%</output></span><input type="range" min="50" max="100" step="1" value={history.present.promotionThreshold} onChange={(event) => commit({ promotionThreshold: Number(event.target.value) }, "Promotion threshold changed in the renderer preview.")} aria-label="Adaptive promotion threshold" /></label>
        <label><span>Minimum samples</span><input type="number" min="1" max="10000" step="1" value={history.present.minimumSamples} onChange={(event) => commit({ minimumSamples: clamp(Number(event.target.value) || 1, 1, 10000) }, "Minimum learning sample count changed in the renderer preview.")} aria-label="Adaptive minimum samples" /></label>
      </div>

      <div className="adaptive-auto-routing__signal-grid">
        <fieldset><legend><Activity size={13} /> Signals used by Auto</legend>{SIGNALS.map((signal) => <label key={signal.id} title={signal.detail}><input type="checkbox" checked={history.present.signals[signal.id]} onChange={(event) => updateSignal(signal.id, event.target.checked)} /> <span>{signal.label}</span></label>)}</fieldset>
        <fieldset><legend><Gauge size={13} /> Reviewable data sources</legend>{LEARNING_SOURCES.map((source) => <label key={source.id} title={source.detail}><input type="checkbox" checked={history.present.sources[source.id]} onChange={(event) => updateSource(source.id, event.target.checked)} /> <span>{source.label}</span></label>)}</fieldset>
      </div>

      <div className="adaptive-auto-routing__recommendation" role="status" aria-label="Adaptive Auto recommendation">
        <span className="adaptive-auto-routing__recommendation-icon"><Route size={15} /></span>
        <span><strong>{recommendation ? recommendation.model.displayName : "No route recommendation"}</strong><small>{recommendation ? `${recommendation.model.providerName} · synthetic fit score ${recommendation.score}/100 · ${ROLE_LABELS[history.present.role]}` : "A connected and available candidate is required before Auto can recommend a route."}</small></span>
        <button type="button" className="button button--secondary" onClick={selectRecommendation} disabled={!recommendation}><Check size={13} /> Use recommendation</button>
      </div>

      <div className="adaptive-auto-routing__candidates" role="list" aria-label="Adaptive Auto candidate routes">
        {candidates.map((candidate) => <article key={candidate.model.id} className={`adaptive-auto-routing__candidate adaptive-auto-routing__candidate--${candidate.state}${candidate.model.id === modelProfileId ? " is-selected" : ""}`} role="listitem"><span className="adaptive-auto-routing__candidate-state">{candidate.state === "ready" ? <Check size={12} /> : <ShieldCheck size={12} />}{candidate.state}</span><span><strong>{candidate.model.displayName}</strong><small>{candidate.model.providerName} · {candidate.model.speed} · {candidate.model.contextLabel}</small></span><strong className="adaptive-auto-routing__score">{candidate.score}/100</strong><button type="button" className="button button--ghost" onClick={() => onModelProfileChange(candidate.model.id)} disabled={!candidate.ready} aria-label={`Select ${candidate.model.displayName} adaptive route`}>Select</button></article>)}
        {!candidates.length ? <p className="adaptive-auto-routing__empty">No model candidates are visible in this catalog snapshot.</p> : null}
      </div>

      <div className="adaptive-auto-routing__export-toolbar" role="toolbar" aria-label="Adaptive Auto export">
        <label><span>Format</span><select aria-label="Adaptive Auto export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
        <span role="status" aria-live="polite">{copied ? "Copied" : "Export excludes credentials and raw content."}</span>
        <button type="button" className="button button--ghost" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="adaptive-auto-routing-export">{exportOpen ? "Hide preview" : "Inspect export"}</button>
        <button type="button" className="button button--secondary" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button>
      </div>
      {exportOpen ? <pre id="adaptive-auto-routing-export" className="adaptive-auto-routing__export" aria-label={`Adaptive Auto ${exportFormat} preview`} tabIndex={0}>{exportPayload}</pre> : null}

      <p className="adaptive-auto-routing__boundary"><LockKeyhole size={13} /> Renderer-only rehearsal. Signals are synthetic or renderer-visible summaries; no keylogging, hidden collection, raw prompt capture, model training, checkpoint write, provider request, permission grant, or durable adaptive policy is performed here.</p>
    </section>
  );
}

export default AdaptiveAutoRoutingLearningPreview;
