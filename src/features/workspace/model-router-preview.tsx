import {
  Gauge,
  LockKeyhole,
  RotateCcw,
  Route,
  ShieldCheck,
  Sparkles,
  Undo2,
  Redo2,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";

import { selectableModelProfiles } from "./provider-catalog";
import type { ModelProfileView, ProviderView } from "./types";

type RouterStrategy = "quality" | "latency" | "privacy" | "cost" | "custom";
type ContextLimit = "any" | "32k" | "128k" | "200k" | "1m";

type RouterPolicy = {
  strategy: RouterStrategy;
  requireTools: boolean;
  requireVision: boolean;
  requireReasoning: boolean;
  localOnly: boolean;
  maxContext: ContextLimit;
  qualityWeight: number;
  latencyWeight: number;
  privacyWeight: number;
  costWeight: number;
};

type PolicyHistory = {
  past: RouterPolicy[];
  present: RouterPolicy;
  future: RouterPolicy[];
};

type RankedModel = {
  model: ModelProfileView;
  provider: ProviderView | null;
  score: number;
  quality: number;
  latency: number;
  privacy: number;
  cost: number;
  blockedReason: string | null;
};

const defaultPolicy: RouterPolicy = {
  strategy: "quality",
  requireTools: false,
  requireVision: false,
  requireReasoning: false,
  localOnly: false,
  maxContext: "any",
  qualityWeight: 60,
  latencyWeight: 15,
  privacyWeight: 15,
  costWeight: 10,
};

const strategyPresets: ReadonlyArray<{
  value: Exclude<RouterStrategy, "custom">;
  label: string;
  description: string;
  policy: Pick<RouterPolicy, "qualityWeight" | "latencyWeight" | "privacyWeight" | "costWeight" | "localOnly">;
}> = [
  {
    value: "quality",
    label: "Quality first",
    description: "Favor capability depth and context while keeping a broad candidate pool.",
    policy: { qualityWeight: 65, latencyWeight: 10, privacyWeight: 15, costWeight: 10, localOnly: false },
  },
  {
    value: "latency",
    label: "Fast response",
    description: "Prefer fast models and known low-latency provider observations.",
    policy: { qualityWeight: 20, latencyWeight: 60, privacyWeight: 10, costWeight: 10, localOnly: false },
  },
  {
    value: "privacy",
    label: "Private / local",
    description: "Keep the candidate pool on local runtimes when available.",
    policy: { qualityWeight: 25, latencyWeight: 15, privacyWeight: 50, costWeight: 10, localOnly: true },
  },
  {
    value: "cost",
    label: "Cost-aware",
    description: "Use a conservative cost heuristic; provider billing is not available in this preview.",
    policy: { qualityWeight: 20, latencyWeight: 20, privacyWeight: 20, costWeight: 40, localOnly: false },
  },
];

const clonePolicy = (policy: RouterPolicy): RouterPolicy => ({ ...policy });

function contextTokens(label: string): number | null {
  const normalized = label.trim().toLowerCase();
  const match = normalized.match(/([\d.]+)\s*([km])?/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  return (match[2] === "m" ? amount * 1_000_000 : match[2] === "k" ? amount * 1_000 : amount);
}

function contextLimitTokens(limit: ContextLimit): number | null {
  if (limit === "any") return null;
  return limit === "1m" ? 1_000_000 : Number(limit.replace("k", "000"));
}

function modelScore(model: ModelProfileView, provider: ProviderView | null, policy: RouterPolicy): RankedModel {
  const local = provider?.kind === "Local";
  const context = contextTokens(model.contextLabel);
  const quality = Math.min(100, 28 + model.capabilities.length * 11 + (context ? Math.min(28, context / 10_000) : 0) + (model.status === "available" ? 18 : model.status === "degraded" ? 4 : 0));
  const measuredLatency = provider?.latencyMs;
  const latency = measuredLatency !== null && measuredLatency !== undefined
    ? Math.max(20, Math.min(100, 100 - measuredLatency / 5))
    : model.speed === "Fast" ? 88 : model.speed === "Balanced" ? 65 : 42;
  const privacy = local ? 100 : provider?.source === "native" ? 52 : 42;
  const cost = local ? 96 : provider?.kind === "OpenAI-compatible" || provider?.kind === "Custom" ? 58 : 46;
  const limit = contextLimitTokens(policy.maxContext);
  let blockedReason: string | null = null;
  // Auto may only rank candidates whose visible catalog state is currently
  // usable. A numeric score is not enough to make an unavailable model or an
  // unvalidated provider connection eligible.
  if (model.status !== "available") blockedReason = `Model reports ${model.status} status`;
  else if (!provider) blockedReason = "Provider metadata unavailable";
  else if (!provider.enabled) blockedReason = "Provider is disabled";
  else if (provider.state !== "connected") blockedReason = `Provider is ${provider.state}; live connection required`;
  else if (policy.requireTools && !model.capabilities.includes("tools")) blockedReason = "Tools capability required";
  else if (policy.requireVision && !model.capabilities.includes("vision")) blockedReason = "Vision capability required";
  else if (policy.requireReasoning && !model.capabilities.includes("reasoning")) blockedReason = "Reasoning capability required";
  else if (policy.localOnly && !local) blockedReason = "Local-only policy";
  else if (limit !== null && context !== null && context < limit) blockedReason = `Context below ${policy.maxContext}`;
  else if (limit !== null && context === null) blockedReason = "Context size not reported";

  const weighted = (
    quality * policy.qualityWeight
    + latency * policy.latencyWeight
    + privacy * policy.privacyWeight
    + cost * policy.costWeight
  ) / Math.max(1, policy.qualityWeight + policy.latencyWeight + policy.privacyWeight + policy.costWeight);
  return { model, provider, score: Math.round(weighted), quality: Math.round(quality), latency: Math.round(latency), privacy, cost, blockedReason };
}

function policyReason(policy: RouterPolicy): string {
  if (policy.strategy === "privacy" || policy.localOnly) return "locality and privacy weight are leading";
  if (policy.strategy === "latency") return "latency weight is leading";
  if (policy.strategy === "cost") return "cost heuristic is leading";
  if (policy.strategy === "custom") return "custom weights are active";
  return "capability depth and context are leading";
}

export function ModelRouterPreview({
  providers,
  modelProfileId,
  onModelProfileChange,
}: {
  readonly providers: ProviderView[];
  readonly modelProfileId: string;
  readonly onModelProfileChange: (profileId: string) => void;
}) {
  const models = useMemo(() => selectableModelProfiles(providers).filter((model) => model.id !== "auto"), [providers]);
  const [history, setHistory] = useState<PolicyHistory>({ past: [], present: clonePolicy(defaultPolicy), future: [] });
  const [status, setStatus] = useState("Auto routing is a renderer-local score preview.");
  const policy = history.present;
  const ranked = useMemo(
    () => models
      .map((model) => modelScore(model, providers.find((provider) => provider.id === model.connectionId) ?? null, policy))
      .sort((left, right) => right.score - left.score || left.model.displayName.localeCompare(right.model.displayName)),
    [models, policy, providers],
  );
  const eligible = ranked.filter((item) => !item.blockedReason);
  const recommended = eligible[0] ?? null;
  const selected = ranked.find((item) => item.model.id === modelProfileId) ?? null;

  const updatePolicy = (patch: Partial<RouterPolicy>, message = "Router policy changed in the renderer preview.") => {
    setHistory((current) => ({ past: [...current.past, clonePolicy(current.present)], present: { ...current.present, ...patch }, future: [] }));
    setStatus(message);
  };

  const chooseStrategy = (strategy: RouterStrategy) => {
    if (strategy === "custom") {
      updatePolicy({ strategy: "custom" }, "Custom router weights are active in this renderer preview.");
      return;
    }
    const preset = strategyPresets.find((item) => item.value === strategy)!;
    updatePolicy({ strategy, ...preset.policy }, `${preset.label} strategy applied to the renderer preview.`);
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return { past: current.past.slice(0, -1), present: clonePolicy(previous), future: [clonePolicy(current.present), ...current.future] };
    });
    setStatus("Undid the last router policy change.");
  };

  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return { past: [...current.past, clonePolicy(current.present)], present: clonePolicy(next), future: current.future.slice(1) };
    });
    setStatus("Reapplied the next router policy change.");
  };

  const reset = () => {
    setHistory((current) => ({ past: [...current.past, clonePolicy(current.present)], present: clonePolicy(defaultPolicy), future: [] }));
    setStatus("Router policy preview reset to defaults.");
  };

  return (
    <section className="model-router-preview" aria-labelledby="model-router-preview-title">
      <header className="model-router-preview__header">
        <span className="model-router-preview__icon"><Route size={16} /></span>
        <span><span className="eyebrow">Renderer-local policy</span><h3 id="model-router-preview-title">Auto router strategy</h3><p>Explore how Omnia could rank compatible models before native route evaluation is connected.</p></span>
        <span className="model-router-preview__badge"><Sparkles size={12} /> Preview only</span>
      </header>

      <div className="model-router-preview__strategies" role="radiogroup" aria-label="Auto router strategy">
        {strategyPresets.map((preset) => (
          <label key={preset.value} className={policy.strategy === preset.value ? "model-router-preview__strategy model-router-preview__strategy--active" : "model-router-preview__strategy"}>
            <input type="radio" name="model-router-strategy" value={preset.value} checked={policy.strategy === preset.value} onChange={() => chooseStrategy(preset.value)} />
            <span><strong>{preset.label}</strong><small>{preset.description}</small></span>
          </label>
        ))}
        <label className={policy.strategy === "custom" ? "model-router-preview__strategy model-router-preview__strategy--active" : "model-router-preview__strategy"}>
          <input type="radio" name="model-router-strategy" value="custom" checked={policy.strategy === "custom"} onChange={() => chooseStrategy("custom")} />
          <span><strong>Custom mix</strong><small>Tune the scoring weights below for this session.</small></span>
        </label>
      </div>

      <div className="model-router-preview__history" role="toolbar" aria-label="Auto router preview history">
        <span><strong>Reversible policy draft</strong><small>{status}</small></span>
        <span className="model-router-preview__history-count">{history.past.length + history.future.length} steps</span>
        <span className="model-router-preview__history-actions">
          <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo router policy change"><Undo2 size={12} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo router policy change"><Redo2 size={12} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset router policy"><RotateCcw size={12} /> Reset</button>
        </span>
      </div>

      <div className="model-router-preview__weights" aria-label="Auto router score weights">
        {(["qualityWeight", "latencyWeight", "privacyWeight", "costWeight"] as const).map((key) => {
          const label = key.replace("Weight", "");
          return <label key={key}><span><strong>{label[0]!.toUpperCase() + label.slice(1)}</strong><output>{policy[key]}%</output></span><input type="range" min="0" max="100" step="5" value={policy[key]} aria-label={`${label} score weight`} onChange={(event) => updatePolicy({ strategy: "custom", [key]: Number(event.target.value) })} /></label>;
        })}
      </div>

      <div className="model-router-preview__constraints" aria-label="Auto router constraints">
        <span className="model-router-preview__constraints-title">Hard constraints</span>
        <label><input type="checkbox" checked={policy.requireTools} onChange={(event) => updatePolicy({ requireTools: event.target.checked })} /> Tools</label>
        <label><input type="checkbox" checked={policy.requireVision} onChange={(event) => updatePolicy({ requireVision: event.target.checked })} /> Vision</label>
        <label><input type="checkbox" checked={policy.requireReasoning} onChange={(event) => updatePolicy({ requireReasoning: event.target.checked })} /> Reasoning</label>
        <label><input type="checkbox" checked={policy.localOnly} onChange={(event) => updatePolicy({ localOnly: event.target.checked, strategy: "custom" })} /> Local only</label>
        <label className="model-router-preview__context-limit"><span>Minimum context</span><select value={policy.maxContext} onChange={(event) => updatePolicy({ maxContext: event.target.value as ContextLimit })} aria-label="Minimum context requirement"><option value="any">Any reported size</option><option value="32k">32K+</option><option value="128k">128K+</option><option value="200k">200K+</option><option value="1m">1M+</option></select></label>
      </div>

      <div className="model-router-preview__summary" role="status">
        <span className="model-router-preview__summary-icon"><Gauge size={15} /></span>
        <span><strong>{eligible.length ? `${eligible.length} eligible route${eligible.length === 1 ? "" : "s"}` : "No eligible route"}</strong><small>{recommended ? `${recommended.model.displayName} leads because ${policyReason(policy)}.` : "Relax a hard constraint or validate another provider."}</small></span>
        {recommended ? <button type="button" className="button button--secondary" onClick={() => onModelProfileChange(recommended.model.id)}><Zap size={13} /> Use recommended</button> : null}
      </div>

      <div className="model-router-preview__ranking" role="list" aria-label="Auto router ranking preview">
        {ranked.map((item, index) => {
          const selectedRoute = selected?.model.id === item.model.id;
          const candidateLabelId = `model-router-candidate-${item.model.id}`;
          return <article key={item.model.id} role="listitem" className={item.blockedReason ? "model-router-preview__candidate model-router-preview__candidate--blocked" : selectedRoute ? "model-router-preview__candidate model-router-preview__candidate--selected" : "model-router-preview__candidate"}>
            <button type="button" onClick={() => onModelProfileChange(item.model.id)} disabled={Boolean(item.blockedReason)} aria-label={item.blockedReason ? `Ranked route ${index + 1} unavailable` : `Select ranked route ${index + 1}`} aria-describedby={candidateLabelId} title={item.blockedReason ?? `Select ${item.model.displayName}`}>
              <span className="model-router-preview__rank">{item.blockedReason ? "—" : `#${index + 1}`}</span>
              <span className="model-router-preview__candidate-copy"><strong id={candidateLabelId}>{item.model.displayName} · {item.blockedReason ?? `${item.score}/100`}</strong><small>{item.model.providerName} · {item.model.contextLabel}</small></span>
              <span className="model-router-preview__score"><strong>{item.blockedReason ? "Blocked" : `${item.score}/100`}</strong><small>{item.blockedReason ?? "Illustrative score"}</small></span>
            </button>
            {!item.blockedReason ? <div className="model-router-preview__signals"><span title="Capability/context score">Quality {item.quality}</span><span title="Speed/provider latency score">Speed {item.latency}</span><span title="Locality score">Privacy {item.privacy}</span><span title="Cost heuristic">Cost {item.cost}</span></div> : null}
          </article>;
        })}
        {ranked.length === 0 ? <div className="model-router-preview__empty"><ShieldCheck size={15} /> Connect and validate a provider to preview ranked models.</div> : null}
      </div>

      <p className="model-router-preview__boundary"><LockKeyhole size={13} /> Scores are deterministic UI heuristics, not provider pricing, live latency, learned routing, or a dispatch authorization. Native route decisions and fallback attempts remain planned.</p>
    </section>
  );
}
