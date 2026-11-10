import { Check, Clipboard, Download, FileWarning, Layers3, LockKeyhole, Play, RotateCcw, ShieldAlert, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import { buildContextEstimate, contextEstimateInline, contextEstimateLabel, type ContextEstimateView } from "./context-estimate";
import type { ContextDeliveryMode } from "./model-route-preset-contract";

export type ContextPreflightSourceStatus = "ready" | "review" | "blocked" | "planned" | "excluded";

export interface ContextPreflightSource {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  readonly estimatedTokens: number;
  readonly status: ContextPreflightSourceStatus;
  readonly detail: string;
  readonly selected: boolean;
  /** Required user input remains part of the request in every delivery mode. */
  readonly required?: boolean;
}

type GateStatus = "pass" | "review" | "blocked" | "planned";
type ExclusionReason = "not-selected" | "not-needed" | "sensitive" | "out-of-scope" | "over-budget" | "other";

const exclusionReasonLabels: Record<ExclusionReason, string> = {
  "not-selected": "Not selected by source settings",
  "not-needed": "Not needed for this answer",
  sensitive: "Sensitive or private",
  "out-of-scope": "Outside this task",
  "over-budget": "Token budget",
  other: "Other review required",
};

interface ContextPreflightGate {
  readonly id: string;
  readonly label: string;
  readonly status: GateStatus;
  readonly detail: string;
}

const sourceStatusLabels: Record<ContextPreflightSourceStatus, string> = {
  ready: "Ready",
  review: "Review",
  blocked: "Blocked",
  planned: "Planned",
  excluded: "Excluded",
};

const gateStatusLabels: Record<GateStatus, string> = {
  pass: "Pass",
  review: "Review",
  blocked: "Blocked",
  planned: "Planned",
};

const deliveryModeLabels: Record<ContextDeliveryMode, string> = {
  auto: "Auto",
  full: "Full context",
  "summary-plus-sources": "Summary + sources",
  "manifest-only": "Manifest only",
  "retrieval-on-demand": "Retrieve on demand",
};

const deliveryModeDescriptions: Record<ContextDeliveryMode, string> = {
  auto: "Follow the current route policy and keep the incoming source selection.",
  full: "Include every available source group; blocked and review gates still stop promotion.",
  "summary-plus-sources": "Include only selected source groups with a compact source summary.",
  "manifest-only": "Send source metadata only; no source content is admitted in this preview.",
  "retrieval-on-demand": "Keep sources as candidates for a future native retrieval step.",
};

function downloadPreview(payload: string, format: "json" | "markdown"): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-context-preflight-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function ContextPreflightPreview({
  projectName,
  projectHealth,
  sources,
  estimatedTokens,
  budgetTokens,
  deliveryMode: controlledDeliveryMode,
  onDeliveryModeChange,
}: {
  readonly projectName: string;
  readonly projectHealth: "not-compiled" | "ready" | "indexing" | "over-budget" | "missing-access";
  readonly sources: readonly ContextPreflightSource[];
  readonly estimatedTokens: number | null;
  readonly budgetTokens: number;
  /** Optional controlled value so the Chat composer can retain the choice while the panel is closed. */
  readonly deliveryMode?: ContextDeliveryMode;
  readonly onDeliveryModeChange?: (mode: ContextDeliveryMode) => void;
}) {
  const [hasRun, setHasRun] = useState(false);
  const [showDecisionLog, setShowDecisionLog] = useState(false);
  const [format, setFormat] = useState<"json" | "markdown">("json");
  const [status, setStatus] = useState("Preflight has not been evaluated in this renderer session.");
  const [localDeliveryMode, setLocalDeliveryMode] = useState<ContextDeliveryMode>("auto");
  const [sourceOverrides, setSourceOverrides] = useState<Record<string, { selected: boolean; reason?: ExclusionReason }>>({});
  const deliveryMode = controlledDeliveryMode ?? localDeliveryMode;
  const sourceSelectionLocked = deliveryMode === "full" || deliveryMode === "manifest-only" || deliveryMode === "retrieval-on-demand";
  const estimate = useMemo<ContextEstimateView>(
    () => buildContextEstimate({ estimatedTokens, projectHealth }),
    [estimatedTokens, projectHealth],
  );

  const decisions = useMemo(() => sources.map((source) => {
    const override = sourceOverrides[source.id];
    const required = source.required === true;
    const modeSelected = required
      ? source.count > 0
      : deliveryMode === "full"
      ? source.count > 0
      : deliveryMode === "manifest-only" || deliveryMode === "retrieval-on-demand"
        ? false
        : source.count > 0 && (override?.selected ?? source.selected);
    const selected = required
      ? modeSelected
      : sourceSelectionLocked ? modeSelected : source.count > 0 && (override?.selected ?? source.selected);
    return {
      ...source,
      selected,
      required,
      exclusionReason: selected ? null : override?.reason ?? (source.selected ? "not-needed" : "not-selected"),
    };
  }), [deliveryMode, sourceOverrides, sourceSelectionLocked, sources]);
  const selectedSources = useMemo(() => decisions.filter((source) => source.selected), [decisions]);
  const excludedSources = useMemo(() => decisions.filter((source) => !source.selected), [decisions]);
  const selectedEstimatedTokens = useMemo<number | null>(() => {
    if (estimate.tokens === null) return null;
    const incomingSelectedTokens = sources.reduce((total, source) => total + (source.selected ? source.estimatedTokens : 0), 0);
    const effectiveSelectedTokens = decisions.reduce((total, source) => total + (source.selected ? source.estimatedTokens : 0), 0);
    const delta = decisions.reduce((total, source, index) => {
      const original = sources[index];
      if (!original || original.selected === source.selected) return total;
      return total + (source.selected ? source.estimatedTokens : -source.estimatedTokens);
    }, 0);
    // Keep the incoming aggregate as the authority for the initial preview,
    // but make delivery-mode changes deterministic when source estimates are
    // only approximate renderer heuristics.
    const modeDelta = effectiveSelectedTokens - incomingSelectedTokens;
    return Math.max(0, estimate.tokens + (modeDelta === 0 ? delta : modeDelta));
  }, [decisions, estimate.tokens, sources]);
  const blockedSources = useMemo(() => selectedSources.filter((source) => source.status === "blocked"), [selectedSources]);
  const reviewSources = useMemo(() => selectedSources.filter((source) => source.status === "review" || source.status === "planned"), [selectedSources]);
  const budgetRatio = selectedEstimatedTokens === null ? null : selectedEstimatedTokens / Math.max(1, budgetTokens);
  const isOverBudget = selectedEstimatedTokens !== null && selectedEstimatedTokens > budgetTokens;
  const hasBlockingContextHealth = projectHealth === "missing-access" || projectHealth === "over-budget";

  const gates = useMemo<ContextPreflightGate[]>(() => [
    {
      id: "scope",
      label: "Source scope",
      status: blockedSources.length > 0 || hasBlockingContextHealth ? "blocked" : reviewSources.length > 0 ? "review" : "pass",
      detail: blockedSources.length > 0
        ? `${blockedSources.length} selected source${blockedSources.length === 1 ? " is" : "s are"} unavailable.`
        : projectHealth === "missing-access"
          ? "Project access is missing; no native read is attempted."
          : projectHealth === "over-budget"
            ? "The project is over the renderer preview budget; native selection and compaction are unavailable."
          : reviewSources.length > 0
            ? "Some selected inputs still need native scope/freshness evidence."
            : "Selected sources have a renderer-local scope description.",
    },
    {
      id: "budget",
      label: "Token budget",
      status: hasBlockingContextHealth ? "blocked" : selectedEstimatedTokens === null ? "review" : isOverBudget ? "blocked" : selectedEstimatedTokens === 0 ? "review" : "pass",
      detail: projectHealth === "missing-access"
        ? "Aggregate budget admission is withheld because project access is unavailable."
        : projectHealth === "over-budget"
          ? "Aggregate budget admission is withheld because the project is over budget; native selection or compaction evidence is unavailable."
          : selectedEstimatedTokens === null
        ? `Token estimate ${contextEstimateLabel(estimate).toLowerCase()}; budget fit cannot be established in this preview.`
        : isOverBudget
          ? `${(selectedEstimatedTokens - budgetTokens).toLocaleString()} estimated tokens over the preview budget.`
          : `${selectedEstimatedTokens.toLocaleString()} of ${budgetTokens.toLocaleString()} preview tokens estimated.`,
    },
    {
      id: "authority",
      label: "Authority and provenance",
      status: reviewSources.length > 0 ? "review" : "pass",
      detail: reviewSources.length > 0
        ? "Memory, skill, or referenced-folder admission still needs native evidence."
        : "No renderer source is promoted to instruction authority by this preview.",
    },
    {
      id: "freeze",
      label: "Immutable context freeze",
      status: "planned",
      detail: "Native context revision, omission ledger, and frozen provider input are not connected.",
    },
  ], [blockedSources.length, contextEstimateLabel(estimate), estimate, hasBlockingContextHealth, selectedEstimatedTokens, isOverBudget, projectHealth, reviewSources.length, budgetTokens]);

  const overallStatus: GateStatus = gates.some((gate) => gate.status === "blocked")
    ? "blocked"
    : gates.some((gate) => gate.status === "review")
      ? "review"
      : "planned";

  const overallLabel = overallStatus === "blocked"
    ? "Blocked in preview"
    : overallStatus === "review"
      ? "Needs review before compile"
      : "Preview admission candidate";

  const payload = useMemo(() => {
    const data = {
      schema: "omnia.context-preflight.preview.v2",
      scope: "renderer-session",
      project: projectName,
      evaluated: hasRun,
      overall: { status: overallStatus, label: overallLabel },
      budget: {
        estimatedTokens: selectedEstimatedTokens,
        budgetTokens,
        ratio: budgetRatio === null ? null : Number(budgetRatio.toFixed(3)),
        estimateStatus: estimate.status,
        estimateSource: estimate.source,
        estimateReason: estimate.reason,
      },
      delivery: {
        mode: deliveryMode,
        label: deliveryModeLabels[deliveryMode],
        description: deliveryModeDescriptions[deliveryMode],
        sourceSelectionLocked,
      },
      sources: decisions.map((source) => ({
        id: source.id,
        label: source.label,
        count: source.count,
        estimatedTokens: source.estimatedTokens,
        selected: source.selected,
        required: source.required,
        status: source.status,
        detail: source.detail,
      })),
      exclusions: excludedSources.map((source) => ({
        sourceId: source.id,
        label: source.label,
        count: source.count,
        estimatedTokens: source.estimatedTokens,
        reasonCode: source.exclusionReason,
        reason: exclusionReasonLabels[source.exclusionReason ?? "not-selected"],
      })),
      gates,
      boundary: "Renderer-local preflight only; no file read, retrieval, native compile, provider request, durable write, or frozen context revision was produced.",
    };
    if (format === "json") return JSON.stringify(data, null, 2);
    return [
      `# ${projectName} context preflight`,
      "",
      "> Renderer-local preflight only; no native compile or provider request was performed.",
      "",
      `- Status: ${overallLabel}`,
      `- Evaluated in session: ${hasRun ? "yes" : "no"}`,
      `- Estimated budget: ${selectedEstimatedTokens === null ? `${contextEstimateLabel(estimate)} — ${estimate.reason}` : `${selectedEstimatedTokens.toLocaleString()} / ${budgetTokens.toLocaleString()} tokens (renderer heuristic)`}`,
      `- Delivery mode: ${deliveryModeLabels[deliveryMode]} · ${deliveryModeDescriptions[deliveryMode]}`,
      "",
      "## Source checks",
      ...decisions.map((source) => `- ${source.label}: ${source.selected ? sourceStatusLabels[source.status] : "Excluded"}${source.required ? " · Required" : ""} · ${source.count} item${source.count === 1 ? "" : "s"} · ${source.detail}`),
      "",
      "## Exclusion ledger",
      ...(excludedSources.length
        ? excludedSources.map((source) => `- ${source.label}: ${exclusionReasonLabels[source.exclusionReason ?? "not-selected"]} · ${source.count} item${source.count === 1 ? "" : "s"} · ${source.estimatedTokens.toLocaleString()} estimated tokens omitted`)
        : ["- No source groups are excluded."]),
      "",
      "## Gates",
      ...gates.map((gate) => `- ${gate.label}: ${gateStatusLabels[gate.status]} · ${gate.detail}`),
      "",
      "Native context revision, omission ledger, provider serialization, and durable receipt remain planned.",
    ].join("\n");
  }, [budgetRatio, budgetTokens, decisions, deliveryMode, estimate, excludedSources, format, gates, hasRun, overallLabel, overallStatus, projectName, selectedEstimatedTokens, sourceSelectionLocked]);

  const updateSourceSelection = (sourceId: string, selected: boolean) => {
    setSourceOverrides((current) => ({
      ...current,
      [sourceId]: {
        ...current[sourceId],
        selected,
        ...(selected ? {} : { reason: current[sourceId]?.reason ?? "not-needed" }),
      },
    }));
    setHasRun(false);
    setStatus("Source selection changed; run preflight again to refresh the preview.");
  };

  const updateExclusionReason = (sourceId: string, reason: ExclusionReason) => {
    setSourceOverrides((current) => ({
      ...current,
      [sourceId]: { ...current[sourceId], selected: false, reason },
    }));
    setHasRun(false);
    setStatus("Exclusion reason changed; run preflight again to refresh the preview.");
  };

  const updateDeliveryMode = (mode: ContextDeliveryMode) => {
    setLocalDeliveryMode(mode);
    onDeliveryModeChange?.(mode);
    setHasRun(false);
    setStatus(`${deliveryModeLabels[mode]} selected; run preflight again to refresh the preview.`);
  };

  const runPreflight = () => {
    setHasRun(true);
    setStatus(overallStatus === "blocked"
      ? "Preflight evaluated: review the blocked source or budget gate before continuing."
      : "Preflight evaluated from the current renderer snapshot; no native compile was requested.");
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no preflight report was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(`Copied the renderer-local ${format.toUpperCase()} preflight report.`);
    } catch {
      setStatus("Clipboard access was denied; no preflight report was copied.");
    }
  };

  return (
    <section className="context-preflight-preview" aria-labelledby="context-preflight-title">
      <header className="context-preflight-preview__header">
        <div>
          <span className="eyebrow">Context admission rehearsal</span>
          <h3 id="context-preflight-title"><ShieldAlert size={15} /> Preflight before compile</h3>
          <p>Inspect scope, budget, provenance, and freeze gates before a future native context compiler is connected.</p>
        </div>
        <span className={`context-preflight-preview__overall context-preflight-preview__overall--${overallStatus}`}><Sparkles size={12} /> {overallLabel}</span>
      </header>

      <div className="context-preflight-preview__summary" role="status" aria-live="polite">
        <div><strong>{projectName}</strong><small>{selectedSources.length} selected source groups · {excludedSources.length} excluded · {hasRun ? "Evaluated" : "Not evaluated"}</small></div>
        <div className="context-preflight-preview__budget">
          <span>Budget pressure</span>
          <strong>{budgetRatio === null ? "Unknown" : `${Math.round(budgetRatio * 100)}%`}</strong>
          <small>{contextEstimateInline(estimate, budgetTokens)}</small>
          <div aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, (budgetRatio ?? 0) * 100))}%` }} /></div>
        </div>
      </div>

      <div className="context-preflight-preview__delivery">
        <label>
          <span>Delivery mode</span>
          <select
            aria-label="Context delivery mode"
            aria-describedby="context-preflight-delivery-description"
            value={deliveryMode}
            onChange={(event) => updateDeliveryMode(event.target.value as ContextDeliveryMode)}
          >
            {Object.entries(deliveryModeLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <p id="context-preflight-delivery-description">{deliveryModeDescriptions[deliveryMode]} {sourceSelectionLocked ? "Source checkboxes are locked by this mode." : "You can refine source groups below."}</p>
      </div>

      <div className="context-preflight-preview__toolbar" role="toolbar" aria-label="Context preflight actions">
        <button type="button" className="button button--secondary" title={hasRun ? "Re-evaluate the current renderer context snapshot" : "Evaluate context scope, budget, and provenance in this preview"} onClick={runPreflight}><Play size={13} /> {hasRun ? "Re-run preflight" : "Run preflight"}</button>
      <button type="button" className="button button--ghost" title="Reset preflight evaluation and source exclusions" onClick={() => { setSourceOverrides({}); setHasRun(false); setStatus("Preflight and source exclusions reset to the current renderer snapshot."); }}><RotateCcw size={13} /> Reset</button>
      </div>

      <div className="context-preflight-preview__sources" aria-label="Context source checks">
        {decisions.map((source) => (
          <article key={source.id} className={`context-preflight-preview__source context-preflight-preview__source--${source.selected ? source.status : "excluded"}`}>
            <span className="context-preflight-preview__source-icon">{!source.selected ? <Layers3 size={14} /> : source.status === "blocked" ? <FileWarning size={14} /> : <Check size={14} />}</span>
            <span className="context-preflight-preview__source-copy"><strong>{source.label}</strong><small>{source.count.toLocaleString()} item{source.count === 1 ? "" : "s"} · ~{source.estimatedTokens.toLocaleString()} renderer-est. tokens</small><em>{source.detail}</em></span>
            <span className="context-preflight-preview__source-controls">
              <label className="context-preflight-preview__include"><input type="checkbox" checked={source.selected} disabled={source.count === 0 || source.required || sourceSelectionLocked} onChange={(event) => updateSourceSelection(source.id, event.target.checked)} aria-label={`Include ${source.label} in preflight`} /><span>{source.count === 0 ? "No items" : source.required ? "Required" : sourceSelectionLocked ? "Mode controlled" : source.selected ? "Included" : "Excluded"}</span></label>
              <span className="context-preflight-preview__source-state">{source.selected ? sourceStatusLabels[source.status] : "Omitted"}</span>
              {!source.selected && source.count > 0 ? <label className="context-preflight-preview__reason"><span>Exclusion reason</span><select aria-label={`Exclusion reason for ${source.label}`} value={source.exclusionReason ?? "not-selected"} onChange={(event) => updateExclusionReason(source.id, event.target.value as ExclusionReason)}>{Object.entries(exclusionReasonLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : null}
            </span>
          </article>
        ))}
      </div>

      {excludedSources.length ? <section className="context-preflight-preview__exclusions" aria-label="Context exclusion ledger">
        <div className="context-preflight-preview__exclusions-heading"><span><span className="eyebrow">Omission ledger</span><strong>Excluded from this rehearsal</strong></span><small>{excludedSources.length} source group{excludedSources.length === 1 ? "" : "s"} · {excludedSources.reduce((total, source) => total + source.estimatedTokens, 0).toLocaleString()} potential tokens omitted</small></div>
        <ul>{excludedSources.map((source) => <li key={source.id}><span><strong>{source.label}</strong><small>{source.count.toLocaleString()} item{source.count === 1 ? "" : "s"} · {source.estimatedTokens.toLocaleString()} est. tokens</small></span><em>{exclusionReasonLabels[source.exclusionReason ?? "not-selected"]}</em></li>)}</ul>
        <p>Omissions are renderer-local choices for this preview. Native context compilation must produce its own immutable omission ledger.</p>
      </section> : null}

      <div className="context-preflight-preview__gates" aria-label="Context preflight gates">
        {gates.map((gate) => <article key={gate.id} className={`context-preflight-preview__gate context-preflight-preview__gate--${gate.status}`}><span><strong>{gate.label}</strong><small>{gateStatusLabels[gate.status]}</small></span><p>{gate.detail}</p></article>)}
      </div>

      <div className="context-preflight-preview__actions">
        <span className="context-preflight-preview__actions-status">{status}</span>
        <label><span>Report format</span><select aria-label="Context preflight report format" value={format} onChange={(event) => setFormat(event.target.value as "json" | "markdown")}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
        <button type="button" className="button button--ghost" title={showDecisionLog ? "Hide the renderer-local preflight decision log" : "Show the renderer-local preflight decision log"} onClick={() => setShowDecisionLog((value) => !value)} aria-expanded={showDecisionLog} aria-controls="context-preflight-decision-log"><LockKeyhole size={13} /> {showDecisionLog ? "Hide decision log" : "Preview decision log"}</button>
        <button type="button" className="button button--ghost" title="Copy the current preflight report to the clipboard" onClick={() => void copy()}><Clipboard size={13} /> Copy</button>
        <button type="button" className="button button--secondary" title="Download the current renderer-local preflight report" onClick={() => setStatus(downloadPreview(payload, format) ? "Downloaded a renderer-local preflight report." : "File download is unavailable; no report was exported.")}><Download size={13} /> Download</button>
      </div>

      {showDecisionLog ? <pre id="context-preflight-decision-log" className="context-preflight-preview__log" tabIndex={0}><code>{payload}</code></pre> : null}
      <p className="context-preflight-preview__boundary"><LockKeyhole size={13} /> Preview only · Renderer-local · Token figures are heuristic unless marked unknown/withheld; they are not provider-tokenizer output. No durable write, file read, retrieval, native context freeze, provider dispatch, or execution occurs here.</p>
    </section>
  );
}

export default ContextPreflightPreview;
