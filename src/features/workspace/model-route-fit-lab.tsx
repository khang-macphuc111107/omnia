import { Check, CircleAlert, Cpu, Eye, LockKeyhole, Route, Sparkles, Wrench, Zap } from "lucide-react";
import { useMemo, useState } from "react";

import { estimateContextTokens } from "./context-harness";
import { selectableModelProfiles } from "./provider-catalog";
import type { ModelProfileView, ProviderView } from "./types";

type Requirement = "tools" | "vision" | "reasoning";
type Residency = "any" | "local";
type FitState = "fit" | "review" | "blocked";

type FitCandidate = {
  readonly model: ModelProfileView;
  readonly provider: ProviderView | null;
  readonly contextLimit: number | null;
  readonly requiredTokens: number;
  readonly utilization: number | null;
  readonly state: FitState;
  readonly reasons: readonly string[];
};

const requirementOptions: ReadonlyArray<{ value: Requirement; label: string; icon: typeof Wrench }> = [
  { value: "tools", label: "Tool use", icon: Wrench },
  { value: "vision", label: "Image input", icon: Eye },
  { value: "reasoning", label: "Reasoning", icon: Cpu },
];

const scenarioOptions = [
  { id: "coding", label: "Coding", requirements: ["tools", "reasoning"] as Requirement[], prompt: "Trace this function, identify the edge cases, and propose a safe refactor." },
  { id: "research", label: "Research", requirements: ["reasoning"] as Requirement[], prompt: "Compare the supplied sources, separate facts from inference, and produce a cited synthesis." },
  { id: "vision", label: "Image review", requirements: ["vision"] as Requirement[], prompt: "Inspect the attached image and describe the important visual details." },
  { id: "custom", label: "Custom", requirements: [] as Requirement[], prompt: "" },
] as const;

function parseContextLimit(label: string): number | null {
  const match = label.match(/([\d,.]+)\s*([km])?/i);
  if (!match) return null;
  const amount = Number(match[1]!.replaceAll(",", ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2]?.toLowerCase();
  return Math.round(amount * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1));
}

function evaluateCandidate(
  model: ModelProfileView,
  provider: ProviderView | null,
  requirements: readonly Requirement[],
  residency: Residency,
  requiredTokens: number,
): FitCandidate {
  const reasons: string[] = [];
  let state: FitState = "fit";
  for (const capability of requirements) {
    if (!model.capabilities.includes(capability)) {
      state = "blocked";
      reasons.push(`Missing ${capability === "vision" ? "image input" : capability === "tools" ? "tool use" : "reasoning"} capability`);
    }
  }
  if (residency === "local" && provider?.kind !== "Local") {
    state = "blocked";
    reasons.push("Local-only destination required");
  }
  if (!provider || !provider.enabled || provider.state === "error" || provider.state === "not-configured") {
    if (state !== "blocked") state = "review";
    reasons.push(!provider ? "Provider metadata unavailable" : provider.state === "not-configured" ? "Provider configuration not reported ready" : provider.state === "error" ? "Provider reports an error" : "Provider disabled in catalog");
  }
  if (model.status !== "available" && state !== "blocked") {
    state = "review";
    reasons.push(model.status === "unknown" ? "Model availability unknown" : `Model status is ${model.status}`);
  }

  const contextLimit = parseContextLimit(model.contextLabel);
  const utilization = contextLimit === null ? null : requiredTokens / contextLimit;
  if (contextLimit === null) {
    if (state !== "blocked") state = "review";
    reasons.push("Context limit not reported");
  } else if (requiredTokens > contextLimit) {
    state = "blocked";
    reasons.push("Estimated input plus output reserve exceeds reported context");
  }
  if (provider?.state !== "connected" && provider?.state !== "configuration-validated" && state !== "blocked" && !reasons.some((reason) => reason.includes("Provider"))) {
    state = "review";
    reasons.push("Connection state is not confirmed");
  }
  return { model, provider, contextLimit, requiredTokens, utilization, state, reasons: reasons.length ? reasons : ["Visible catalog metadata satisfies this scenario preview"] };
}

export function ModelRouteFitLab({
  providers,
  modelProfileId,
  onModelProfileChange,
}: {
  readonly providers: ProviderView[];
  readonly modelProfileId: string;
  readonly onModelProfileChange: (profileId: string) => void;
}) {
  const [scenario, setScenario] = useState<(typeof scenarioOptions)[number]["id"]>("coding");
  const [task, setTask] = useState<string>(scenarioOptions[0].prompt);
  const [requirements, setRequirements] = useState<Requirement[]>([...scenarioOptions[0].requirements]);
  const [residency, setResidency] = useState<Residency>("any");
  const [outputReserve, setOutputReserve] = useState(2_000);
  const [showAll, setShowAll] = useState(true);

  const models = useMemo(() => selectableModelProfiles(providers).filter((model) => model.id !== "auto"), [providers]);
  const promptTokens = useMemo(() => estimateContextTokens(task.slice(0, 20_000)), [task]);
  const requiredTokens = promptTokens + outputReserve;
  const candidates = useMemo(() => models
    .map((model) => evaluateCandidate(model, providers.find((provider) => provider.id === model.connectionId) ?? null, requirements, residency, requiredTokens))
    .sort((left, right) => ({ fit: 0, review: 1, blocked: 2 }[left.state] - { fit: 0, review: 1, blocked: 2 }[right.state]) || (left.utilization ?? 2) - (right.utilization ?? 2) || left.model.displayName.localeCompare(right.model.displayName)), [models, providers, requirements, residency, requiredTokens]);
  const visibleCandidates = showAll ? candidates : candidates.filter((candidate) => candidate.state !== "blocked");
  const bestFit = candidates.find((candidate) => candidate.state === "fit");

  const chooseScenario = (value: string) => {
    const preset = scenarioOptions.find((item) => item.id === value) ?? scenarioOptions[3];
    setScenario(preset.id);
    setRequirements([...preset.requirements]);
    if (preset.id !== "custom") setTask(preset.prompt);
  };

  const toggleRequirement = (requirement: Requirement, checked: boolean) => {
    setScenario("custom");
    setRequirements((current) => checked
      ? current.includes(requirement) ? current : [...current, requirement]
      : current.filter((item) => item !== requirement));
  };

  return (
    <section className="model-route-fit-lab" aria-labelledby="model-route-fit-lab-title">
      <header className="model-route-fit-lab__header">
        <span className="model-route-fit-lab__icon"><Route size={16} /></span>
        <span><span className="eyebrow">Task-aware route rehearsal</span><h3 id="model-route-fit-lab-title">Model fit lab</h3><p>Check visible capability and context metadata against a draft task before choosing a route.</p></span>
        <span className="model-route-fit-lab__badge"><Sparkles size={12} /> Preview only</span>
      </header>

      <div className="model-route-fit-lab__scenario-bar">
        <label><span>Task profile</span><select aria-label="Route task profile" value={scenario} onChange={(event) => chooseScenario(event.target.value)}>{scenarioOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label><span>Destination</span><select aria-label="Route destination privacy" value={residency} onChange={(event) => setResidency(event.target.value as Residency)}><option value="any">Any catalog destination</option><option value="local">Local runtime only</option></select></label>
        <label className="model-route-fit-lab__reserve"><span>Output reserve <strong>{outputReserve.toLocaleString()} tokens</strong></span><input type="range" min="256" max="8192" step="256" value={outputReserve} onChange={(event) => setOutputReserve(Number(event.target.value))} aria-label="Route output token reserve" /></label>
      </div>

      <label className="model-route-fit-lab__task"><span>Task preview <small>Input is evaluated locally in this renderer. It is not sent.</small></span><textarea value={task} onChange={(event) => { setScenario("custom"); setTask(event.target.value); }} maxLength={20_000} rows={3} placeholder="Describe the task you want to route…" aria-label="Route task preview" /><em>{promptTokens.toLocaleString()} estimated input + {outputReserve.toLocaleString()} output reserve = {requiredTokens.toLocaleString()} tokens. Approximation only.</em></label>

      <div className="model-route-fit-lab__constraints">
        <span>Required capabilities</span>
        {requirementOptions.map(({ value, label, icon: Icon }) => <label key={value}><input type="checkbox" checked={requirements.includes(value)} onChange={(event) => toggleRequirement(value, event.target.checked)} /><Icon size={13} />{label}</label>)}
        <label className="model-route-fit-lab__show-all"><input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} /> Show blocked routes</label>
      </div>

      <div className="model-route-fit-lab__summary" role="status" aria-live="polite" aria-label={bestFit ? `${bestFit.model.displayName} is the best metadata fit` : "No route currently meets every visible constraint"}>
        {bestFit ? <Check size={15} /> : <CircleAlert size={15} />}
        <span><strong>{bestFit ? `${bestFit.model.displayName} is the best metadata fit` : "No route currently meets every visible constraint"}</strong><small>{bestFit ? `${bestFit.model.providerName} · about ${Math.round((bestFit.utilization ?? 0) * 100)}% of its reported context would be used.` : "Relax a requirement or review the blocked and unknown routes below."}</small></span>
        {bestFit ? <button type="button" className="button button--secondary" onClick={() => onModelProfileChange(bestFit.model.id)}><Zap size={13} /> Select route</button> : null}
      </div>

      <div className="model-route-fit-lab__routes" role="list" aria-label="Task fit results">
        {visibleCandidates.map((candidate) => <article key={candidate.model.id} role="listitem" className={`model-route-fit-lab__route model-route-fit-lab__route--${candidate.state}${candidate.model.id === modelProfileId ? " is-selected" : ""}`}>
          <span className="model-route-fit-lab__state">{candidate.state === "fit" ? <Check size={13} /> : candidate.state === "blocked" ? <LockKeyhole size={13} /> : <CircleAlert size={13} />}{candidate.state === "fit" ? "Fit" : candidate.state === "blocked" ? "Blocked" : "Review"}</span>
          <span className="model-route-fit-lab__route-copy"><strong>{candidate.model.displayName}</strong><small>{candidate.model.providerName} · {candidate.provider?.kind ?? "Unknown provider"} · {candidate.model.contextLabel}</small><em>{candidate.reasons.join(" · ")}</em></span>
          <span className="model-route-fit-lab__capacity"><strong>{candidate.utilization === null ? "—" : `${Math.round(candidate.utilization * 100)}%`}</strong><small>{candidate.contextLimit === null ? "context unknown" : `${Math.max(0, candidate.contextLimit - requiredTokens).toLocaleString()} tokens headroom`}</small></span>
          <button type="button" className="button button--ghost" onClick={() => onModelProfileChange(candidate.model.id)} disabled={candidate.state === "blocked"} aria-label={`Select ${candidate.model.displayName} route`} aria-pressed={candidate.model.id === modelProfileId}>Select</button>
        </article>)}
        {!visibleCandidates.length ? <p className="model-route-fit-lab__empty">No model profiles are visible. Add a provider or show blocked routes to inspect the catalog snapshot.</p> : null}
      </div>

      <p className="model-route-fit-lab__boundary"><LockKeyhole size={13} /> Heuristic only: token count is approximate; context and capability labels come from the visible catalog. No model/provider request, price estimate, permission grant, or durable route change occurs here.</p>
    </section>
  );
}
