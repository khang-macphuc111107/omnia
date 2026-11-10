import { AlertTriangle, ArrowDown, ArrowUp, Check, CircleAlert, History, LockKeyhole, Play, Plus, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ModelProfileView } from "./types";

export type FallbackConsentMode = "never" | "same-connection" | "approved-connections";

export type FallbackOutcome = "available" | "timeout" | "auth-failure" | "rate-limited" | "unsupported" | "unknown";

export type FallbackDecision = "selected" | "failed" | "blocked" | "ambiguous";

export interface FallbackRoutePreview {
  readonly id: string;
  readonly modelLabel: string;
  readonly providerLabel: string;
  readonly connectionId: string | null;
  readonly outcome: FallbackOutcome;
}

export interface FallbackRouteAudit {
  readonly routeId: string;
  readonly decision: FallbackDecision;
  readonly reason: string;
}

export interface FallbackRehearsalResult {
  readonly winnerId: string | null;
  readonly terminalState: "selected" | "fallback-disabled" | "ambiguous" | "exhausted" | "empty";
  readonly reason: string;
  readonly audits: readonly FallbackRouteAudit[];
}

export type FallbackScenarioPreset = "primary-timeout" | "unknown-acceptance" | "all-failures";

export interface FallbackScenarioPresetDefinition {
  readonly id: FallbackScenarioPreset;
  readonly label: string;
  readonly detail: string;
}

export interface FallbackRehearsalRun {
  readonly id: string;
  readonly scenario: FallbackScenarioPreset;
  readonly scenarioLabel: string;
  readonly terminalState: FallbackRehearsalResult["terminalState"];
  readonly winnerId: string | null;
  readonly winnerLabel: string | null;
  readonly reason: string;
}

const outcomeLabels: Record<FallbackOutcome, string> = {
  available: "Available",
  timeout: "Timeout",
  "auth-failure": "Auth rejected",
  "rate-limited": "Rate limited",
  unsupported: "Unsupported",
  unknown: "Outcome unknown",
};

const outcomeDescriptions: Record<FallbackOutcome, string> = {
  available: "The route can accept a new attempt in this fixture.",
  timeout: "The attempt ended before a provider response was observed.",
  "auth-failure": "The provider rejected the configured credential or scope.",
  "rate-limited": "The provider returned a bounded rate-limit outcome.",
  unsupported: "The route cannot satisfy the requested capability in this fixture.",
  unknown: "Acceptance is unknown; do not blindly send a successor attempt.",
};

const failureOutcomes: readonly FallbackOutcome[] = ["timeout", "auth-failure", "rate-limited", "unsupported"];

export const fallbackScenarioPresets: readonly FallbackScenarioPresetDefinition[] = [
  {
    id: "primary-timeout",
    label: "Primary timeout → continue",
    detail: "Fail the first route, then leave a later route available for an approved fallback.",
  },
  {
    id: "unknown-acceptance",
    label: "Unknown acceptance → stop",
    detail: "Stop at the first route when provider acceptance is unknown; no blind successor attempt is allowed.",
  },
  {
    id: "all-failures",
    label: "All routes fail",
    detail: "Give every staged route a bounded failure so the chain ends exhausted.",
  },
];

const defaultOutcomeForModel = (model: ModelProfileView): FallbackOutcome => model.status === "available" ? "available" : model.status === "unknown" ? "unknown" : "unsupported";

export function evaluateFallbackChain(
  routes: readonly FallbackRoutePreview[],
  consent: FallbackConsentMode,
): FallbackRehearsalResult {
  if (routes.length === 0) {
    return { winnerId: null, terminalState: "empty", reason: "No fallback routes are staged for this renderer rehearsal.", audits: [] };
  }

  const primary = routes[0]!;
  const audits: FallbackRouteAudit[] = [];

  for (const [index, route] of routes.entries()) {
    if (route.outcome === "unknown") {
      audits.push({ routeId: route.id, decision: "ambiguous", reason: "Provider acceptance is unknown; the chain stops before a blind successor attempt." });
      return {
        winnerId: null,
        terminalState: "ambiguous",
        reason: `${route.modelLabel} has an unknown outcome. Reconcile the attempt before allowing fallback.`,
        audits,
      };
    }

    if (index > 0 && consent === "never") {
      audits.push({ routeId: route.id, decision: "blocked", reason: "Fallback consent is Never switch; no successor attempt is permitted." });
      return {
        winnerId: null,
        terminalState: "fallback-disabled",
        reason: `The primary route ${primary.modelLabel} failed and fallback consent is Never switch.`,
        audits,
      };
    }

    if (index > 0 && consent === "same-connection" && route.connectionId !== primary.connectionId) {
      audits.push({ routeId: route.id, decision: "blocked", reason: "Same-connection consent excludes this destination because its provider connection differs." });
      return {
        winnerId: null,
        terminalState: "fallback-disabled",
        reason: `The next eligible route belongs to a different connection; same-connection consent blocks it.`,
        audits,
      };
    }

    if (route.outcome === "available") {
      audits.push({ routeId: route.id, decision: "selected", reason: index === 0 ? "Primary route is available." : "Earlier route failed; this permitted fallback is available." });
      return {
        winnerId: route.id,
        terminalState: "selected",
        reason: index === 0 ? `${route.modelLabel} is selected as the primary route.` : `${route.modelLabel} is selected as the first permitted fallback.`,
        audits,
      };
    }

    if (failureOutcomes.includes(route.outcome)) {
      audits.push({ routeId: route.id, decision: "failed", reason: `${outcomeLabels[route.outcome]} outcome; continue only if consent permits a new attempt.` });
    }
  }

  return {
    winnerId: null,
    terminalState: "exhausted",
    reason: "Every permitted route failed its local outcome rehearsal; no provider request was sent.",
    audits,
  };
}

/**
 * Applies a deterministic failure fixture to the current visible route order.
 * This only changes renderer-local outcome labels; it never probes a provider.
 */
export function applyFallbackScenario(
  routes: readonly FallbackRoutePreview[],
  scenario: FallbackScenarioPreset,
): FallbackRoutePreview[] {
  return routes.map((route, index) => {
    if (scenario === "primary-timeout") {
      return { ...route, outcome: index === 0 ? "timeout" : "available" };
    }
    if (scenario === "unknown-acceptance") {
      return { ...route, outcome: index === 0 ? "unknown" : "available" };
    }
    const failure: FallbackOutcome = ["timeout", "auth-failure", "rate-limited", "unsupported"][index % 4] as FallbackOutcome;
    return { ...route, outcome: failure };
  });
}

function cloneRoute(route: FallbackRoutePreview): FallbackRoutePreview {
  return { ...route };
}

function routeFromModel(model: ModelProfileView): FallbackRoutePreview {
  return {
    id: model.id,
    modelLabel: model.displayName,
    providerLabel: model.providerName,
    connectionId: model.connectionId,
    outcome: defaultOutcomeForModel(model),
  };
}

function outcomeTone(outcome: FallbackOutcome): string {
  if (outcome === "available") return "is-available";
  if (outcome === "unknown") return "is-unknown";
  return "is-failure";
}

export function ProviderFallbackRehearsal({
  candidates,
  consent,
}: {
  readonly candidates: readonly ModelProfileView[];
  readonly consent: FallbackConsentMode;
}) {
  const candidateRoutes = useMemo(() => candidates.filter((candidate) => candidate.id !== "auto").map(routeFromModel), [candidates]);
  const [routes, setRoutes] = useState<FallbackRoutePreview[]>(() => candidateRoutes.slice(0, Math.min(4, candidateRoutes.length)).map(cloneRoute));
  const [addRouteId, setAddRouteId] = useState("");
  const [scenario, setScenario] = useState<FallbackScenarioPreset>("primary-timeout");
  const [result, setResult] = useState<FallbackRehearsalResult | null>(null);
  const [history, setHistory] = useState<FallbackRehearsalRun[]>([]);
  const [status, setStatus] = useState("Shape a permitted chain, then rehearse its local outcomes.");
  const runSequence = useRef(0);
  const candidateIdsKey = candidateRoutes.map((route) => route.id).join("|");

  useEffect(() => {
    setRoutes((current) => {
      const known = new Map(candidateRoutes.map((route) => [route.id, route]));
      const retained = current.filter((route) => known.has(route.id)).map((route) => ({ ...known.get(route.id)!, outcome: route.outcome }));
      if (retained.length > 0 || candidateRoutes.length === 0) return retained;
      return candidateRoutes.slice(0, Math.min(4, candidateRoutes.length)).map(cloneRoute);
    });
    setResult(null);
    setHistory([]);
    setScenario("primary-timeout");
  }, [candidateIdsKey]);

  const availableToAdd = candidateRoutes.filter((route) => !routes.some((item) => item.id === route.id));
  const routeAudit = new Map((result?.audits ?? []).map((audit) => [audit.routeId, audit]));
  const primaryRouteId = routes[0]?.id ?? null;

  const updateRoute = (routeId: string, outcome: FallbackOutcome) => {
    setRoutes((current) => current.map((route) => route.id === routeId ? { ...route, outcome } : route));
    setResult(null);
    setStatus("Route outcome changed in the renderer rehearsal.");
  };

  const moveRoute = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= routes.length) return;
    setRoutes((current) => {
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
      return next;
    });
    setResult(null);
    setStatus("Fallback order changed in the renderer rehearsal.");
  };

  const removeRoute = (routeId: string) => {
    setRoutes((current) => current.filter((route) => route.id !== routeId));
    setResult(null);
    setStatus("Route removed from the renderer-local chain.");
  };

  const addRoute = () => {
    const route = availableToAdd.find((candidate) => candidate.id === addRouteId);
    if (!route) return;
    setRoutes((current) => [...current, cloneRoute(route)]);
    setAddRouteId("");
    setResult(null);
    setStatus("Route added to the renderer-local chain.");
  };

  const applyScenario = () => {
    const definition = fallbackScenarioPresets.find((preset) => preset.id === scenario)!;
    setRoutes((current) => applyFallbackScenario(current, scenario));
    setResult(null);
    setStatus(`${definition.label} applied to the renderer-local route outcomes.`);
  };

  const rehearse = () => {
    const next = evaluateFallbackChain(routes, consent);
    setResult(next);
    const winner = next.winnerId ? routes.find((route) => route.id === next.winnerId) : null;
    const definition = fallbackScenarioPresets.find((preset) => preset.id === scenario)!;
    const run: FallbackRehearsalRun = {
      id: `fallback-run-${++runSequence.current}`,
      scenario,
      scenarioLabel: definition.label,
      terminalState: next.terminalState,
      winnerId: next.winnerId,
      winnerLabel: winner?.modelLabel ?? null,
      reason: next.reason,
    };
    setHistory((current) => [run, ...current].slice(0, 8));
    setStatus(next.reason);
  };

  const clearHistory = () => {
    setHistory([]);
    setStatus("Rehearsal history cleared for this renderer session.");
  };

  const reset = () => {
    setRoutes(candidateRoutes.slice(0, Math.min(4, candidateRoutes.length)).map(cloneRoute));
    setResult(null);
    setStatus("Fallback rehearsal reset to the visible candidate order.");
  };

  return (
    <section className="provider-fallback-rehearsal" aria-labelledby="provider-fallback-rehearsal-title">
      <header className="provider-fallback-rehearsal__header">
        <span className="provider-fallback-rehearsal__icon"><RouteIcon /></span>
        <span>
          <span className="eyebrow">Failure-aware route planning</span>
          <h3 id="provider-fallback-rehearsal-title">Fallback rehearsal</h3>
          <p>Order candidate routes, inject bounded outcomes, and inspect the first permitted winner before a native attempt exists.</p>
        </span>
        <span className="provider-fallback-rehearsal__badge"><LockKeyhole size={12} /> Preview only</span>
      </header>

      <div className="provider-fallback-rehearsal__metrics" aria-label="Fallback rehearsal summary">
        <span><strong>{routes.length}</strong><small>staged routes</small></span>
        <span><strong>{consent === "never" ? "Off" : consent === "same-connection" ? "Same" : "Approved"}</strong><small>fallback consent</small></span>
        <span><strong>{result?.winnerId ? "Winner" : result?.terminalState === "ambiguous" ? "Review" : "Not run"}</strong><small>local result</small></span>
      </div>

      <div className="provider-fallback-rehearsal__toolbar" role="toolbar" aria-label="Fallback rehearsal controls">
        <label>
          <span>Scenario preset</span>
          <select aria-label="Fallback scenario preset" value={scenario} onChange={(event) => setScenario(event.target.value as FallbackScenarioPreset)}>
            {fallbackScenarioPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
          <small>{fallbackScenarioPresets.find((preset) => preset.id === scenario)?.detail}</small>
        </label>
        <button type="button" className="button button--secondary" onClick={applyScenario} disabled={routes.length === 0}><RotateCcw size={13} /> Apply scenario</button>
        <label>
          <span>Add route</span>
          <select aria-label="Add fallback route" value={addRouteId} onChange={(event) => setAddRouteId(event.target.value)} disabled={availableToAdd.length === 0}>
            <option value="">Choose candidate…</option>
            {availableToAdd.map((route) => <option key={route.id} value={route.id}>{route.modelLabel} · {route.providerLabel}</option>)}
          </select>
        </label>
        <button type="button" className="button button--secondary" onClick={addRoute} disabled={!addRouteId}><Plus size={13} /> Add route</button>
        <button type="button" className="button button--primary" onClick={rehearse} disabled={routes.length === 0}><Play size={13} /> Rehearse chain</button>
        <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={13} /> Reset</button>
      </div>

      <p className="provider-fallback-rehearsal__status" aria-live="polite">{status}</p>

      <div className="provider-fallback-rehearsal__list" role="list" aria-label="Fallback route chain">
        {routes.length > 0 ? routes.map((route, index) => {
          const audit = routeAudit.get(route.id);
          const isPrimary = route.id === primaryRouteId;
          return (
            <article key={route.id} className={`provider-fallback-rehearsal__route ${audit?.decision === "selected" ? "is-selected" : audit?.decision === "ambiguous" ? "is-ambiguous" : audit?.decision === "blocked" ? "is-blocked" : ""}`} role="listitem">
              <div className="provider-fallback-rehearsal__rank" aria-label={`Fallback position ${index + 1}`}>{index + 1}</div>
              <div className="provider-fallback-rehearsal__route-copy">
                <strong>{route.modelLabel}{isPrimary ? " · Primary" : ""}</strong>
                <small>{route.providerLabel}{route.connectionId ? ` · ${route.connectionId}` : " · connection unknown"}</small>
                {audit ? <em>{audit.reason}</em> : null}
              </div>
              <label className="provider-fallback-rehearsal__outcome">
                <span>Outcome</span>
                <select aria-label={`Outcome for ${route.modelLabel}`} value={route.outcome} onChange={(event) => updateRoute(route.id, event.target.value as FallbackOutcome)}>
                  {(Object.keys(outcomeLabels) as FallbackOutcome[]).map((outcome) => <option key={outcome} value={outcome}>{outcomeLabels[outcome]}</option>)}
                </select>
                <small>{outcomeDescriptions[route.outcome]}</small>
              </label>
              <span className={`provider-fallback-rehearsal__outcome-chip ${outcomeTone(route.outcome)}`}>{route.outcome === "available" ? <Check size={12} /> : route.outcome === "unknown" ? <CircleAlert size={12} /> : <AlertTriangle size={12} />}{outcomeLabels[route.outcome]}</span>
              <div className="provider-fallback-rehearsal__route-actions">
                <button type="button" className="button button--ghost" onClick={() => moveRoute(index, -1)} disabled={index === 0} aria-label={`Move fallback position ${index + 1} up`} title={`Move fallback position ${index + 1} up`}><ArrowUp size={13} /></button>
                <button type="button" className="button button--ghost" onClick={() => moveRoute(index, 1)} disabled={index === routes.length - 1} aria-label={`Move fallback position ${index + 1} down`} title={`Move fallback position ${index + 1} down`}><ArrowDown size={13} /></button>
                <button type="button" className="button button--ghost" onClick={() => removeRoute(route.id)} aria-label={`Remove fallback position ${index + 1}`} title={`Remove fallback position ${index + 1}`}><Trash2 size={13} /></button>
              </div>
            </article>
          );
        }) : <div className="provider-fallback-rehearsal__empty"><ShieldCheck size={16} /><strong>No routes staged</strong><span>Add a candidate route to begin the local rehearsal.</span></div>}
      </div>

      {result ? <div className={`provider-fallback-rehearsal__result provider-fallback-rehearsal__result--${result.terminalState}`} role="status" aria-live="polite">
        <span className="provider-fallback-rehearsal__result-icon">{result.winnerId ? <Check size={15} /> : result.terminalState === "ambiguous" ? <CircleAlert size={15} /> : <AlertTriangle size={15} />}</span>
        <span><strong>{result.winnerId ? `Winner: ${routes.find((route) => route.id === result.winnerId)?.modelLabel ?? "selected route"}` : result.terminalState === "ambiguous" ? "Reconciliation required" : result.terminalState === "fallback-disabled" ? "Fallback blocked" : "No route selected"}</strong><small>{result.reason}</small></span>
      </div> : null}

      {history.length > 0 ? <section className="provider-fallback-rehearsal__history" aria-label="Fallback rehearsal history">
        <header>
          <span><History size={13} /><strong>Recent rehearsals</strong><small>{history.length} renderer-session run{history.length === 1 ? "" : "s"} · newest first</small></span>
          <button type="button" className="button button--ghost" onClick={clearHistory}>Clear history</button>
        </header>
        <ol>
          {history.map((run) => <li key={run.id}>
            <span className={`provider-fallback-rehearsal__history-state provider-fallback-rehearsal__history-state--${run.terminalState}`}>{run.winnerLabel ? `Winner · ${run.winnerLabel}` : run.terminalState}</span>
            <span><strong>{run.scenarioLabel}</strong><small>{run.reason}</small></span>
          </li>)}
        </ol>
      </section> : null}

      <p className="provider-fallback-rehearsal__boundary"><ShieldCheck size={13} /> Renderer-local only · no endpoint call, credential lookup, retry, provider acceptance, native policy write, or durable routing receipt. An unknown outcome stops the chain instead of authorizing a blind fallback.</p>
    </section>
  );
}

function RouteIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M5 5h4a3 3 0 0 1 3 3v8a3 3 0 0 0 3 3h4" /><path d="m16 16 3 3-3 3" /><path d="M5 5h.01" /></svg>;
}
