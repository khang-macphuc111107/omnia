import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clipboard,
  Clock3,
  Download,
  Eye,
  FileJson2,
  GitMerge,
  LockKeyhole,
  Network,
  RefreshCw,
  Search,
  ShieldAlert,
  Split,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

export type ReconciliationConflictKind =
  | "write-claim"
  | "stale-snapshot"
  | "output-route"
  | "lease-epoch";

export type ReconciliationConflictSeverity = "high" | "medium" | "low";
export type ReconciliationConflictState = "open" | "held" | "resolved-preview";
export type ReconciliationStrategy = "sequence" | "merge" | "hold" | "manual";
export type ReconciliationView = "conflicts" | "plan" | "evidence";
export type ReconciliationFilter = "all" | "open" | "held" | "resolved-preview";

export interface ReconciliationContender {
  readonly agentId: string;
  readonly label: string;
  readonly claim: string;
  readonly route: string;
  readonly paths: readonly string[];
}

export interface ReconciliationConflict {
  readonly id: string;
  readonly kind: ReconciliationConflictKind;
  readonly severity: ReconciliationConflictSeverity;
  readonly resource: string;
  readonly summary: string;
  readonly observedAt: string;
  readonly contenders: readonly ReconciliationContender[];
  readonly recommendedStrategy: ReconciliationStrategy;
  readonly evidence: readonly string[];
}

export const RECONCILIATION_CONFLICTS: readonly ReconciliationConflict[] = [
  {
    id: "conflict:source-ledger",
    kind: "write-claim",
    severity: "high",
    resource: "docs/omnia-ultra/evidence/source-ledger.json",
    summary: "Two writers want to regenerate the same evidence snapshot from different documentation heads.",
    observedAt: "renderer fixture · 09:21",
    contenders: [
      {
        agentId: "agent:evidence",
        label: "Evidence refresh",
        claim: "Regenerate 94 source records after the UI slice settles.",
        route: "docs/omnia-ultra/evidence/source-ledger.json",
        paths: ["docs/omnia-ultra/evidence/source-ledger.json", "docs/omnia-ultra/evidence/source-ledger.md"],
      },
      {
        agentId: "agent:status",
        label: "Status writer",
        claim: "Refresh documentation receipt first, then regenerate the ledger.",
        route: "docs/omnia-ultra/delivery/CONTINUOUS_PHASE_STATUS.md",
        paths: ["docs/omnia-ultra/delivery/CONTINUOUS_PHASE_STATUS.md", "docs/omnia-ultra/evidence/source-ledger.json"],
      },
    ],
    recommendedStrategy: "sequence",
    evidence: [
      "Both writers target the same generated ledger.",
      "Documentation changed after the previous source-ledger receipt.",
      "A single ordered regeneration would preserve provenance.",
    ],
  },
  {
    id: "conflict:project-twin",
    kind: "stale-snapshot",
    severity: "medium",
    resource: "docs/project-twin/manifest.json",
    summary: "The Project Twin snapshot is older than the latest renderer source changes.",
    observedAt: "renderer fixture · 09:20",
    contenders: [
      {
        agentId: "agent:overview",
        label: "Project Overview",
        claim: "Keep metadata-only fallback until native evidence exists.",
        route: "project overview projection",
        paths: ["src/features/workspace/project-overview.tsx", "docs/project-twin/manifest.json"],
      },
      {
        agentId: "agent:twin",
        label: "Twin bootstrap",
        claim: "Bootstrap a new catalog snapshot after all writers freeze.",
        route: "docs/project-twin/manifest.json",
        paths: ["docs/project-twin/manifest.json", "docs/project-twin/graph.json", "docs/project-twin/atlas.html"],
      },
    ],
    recommendedStrategy: "hold",
    evidence: [
      "No native Project Twin mutation authority is available in this renderer.",
      "The latest generated snapshot is stale by contract, not a runtime failure.",
      "Hold prevents a preview from being mistaken for current native evidence.",
    ],
  },
  {
    id: "conflict:deck-route",
    kind: "output-route",
    severity: "high",
    resource: "src/features/workspace/project-control-deck.tsx",
    summary: "Two UI slices propose different owners for the same Project Control Deck route.",
    observedAt: "renderer fixture · 09:19",
    contenders: [
      {
        agentId: "agent:deck-a11y",
        label: "Deck accessibility",
        claim: "Own tab focus and chat-menu behavior in the control deck.",
        route: "project control deck",
        paths: ["src/features/workspace/project-control-deck.tsx", "src/styles/project-control-deck.css"],
      },
      {
        agentId: "agent:handoff",
        label: "Handoff workbench",
        claim: "Own the Handoff tab and its project-scoped draft state.",
        route: "project control deck",
        paths: ["src/features/workspace/project-control-deck.tsx", "src/features/workspace/project-handoff-workbench.tsx"],
      },
    ],
    recommendedStrategy: "manual",
    evidence: [
      "Both slices can remain additive if the tab contract is explicit.",
      "A route owner is not the same as a file lock in the renderer preview.",
      "Manual review is required before any durable merge or branch operation.",
    ],
  },
  {
    id: "conflict:lease-epoch",
    kind: "lease-epoch",
    severity: "low",
    resource: "task:stale-verifier",
    summary: "A verifier reports an expired lease while a supervisor still shows an older epoch.",
    observedAt: "renderer fixture · 09:18",
    contenders: [
      {
        agentId: "agent:verifier",
        label: "Truthfulness verifier",
        claim: "Lease epoch 3 expired without a durable completion receipt.",
        route: "inbox-only",
        paths: ["lease:4", "agent:verifier"],
      },
      {
        agentId: "agent:supervisor",
        label: "Mesh supervisor",
        claim: "Reconciliation preview still observes epoch 3 as the last known owner.",
        route: "supervisor projection",
        paths: ["lease:4", "agent:supervisor"],
      },
    ],
    recommendedStrategy: "hold",
    evidence: [
      "The renderer cannot acquire, release, or reclaim a native lease.",
      "An expired heartbeat is an attention signal, not proof of safe reassignment.",
      "A hold keeps the output route fixed until a native receipt is available.",
    ],
  },
] as const;

const kindLabels: Record<ReconciliationConflictKind, string> = {
  "write-claim": "Write claim",
  "stale-snapshot": "Stale snapshot",
  "output-route": "Output route",
  "lease-epoch": "Lease epoch",
};

const severityLabels: Record<ReconciliationConflictSeverity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

const strategyLabels: Record<ReconciliationStrategy, string> = {
  sequence: "Sequence writers",
  merge: "Merge claims",
  hold: "Hold write",
  manual: "Manual review",
};

const stateLabels: Record<ReconciliationConflictState, string> = {
  open: "Open",
  held: "Held in preview",
  "resolved-preview": "Resolved in preview",
};

function downloadText(payload: string, format: "json" | "markdown"): boolean {
  if (typeof URL.createObjectURL !== "function" || typeof document === "undefined") return false;
  const blob = new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-reconciliation-preview.${format === "json" ? "json" : "md"}`;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}

export function serializeReconciliationPreview(
  conflicts: readonly ReconciliationConflict[],
  states: Readonly<Record<string, ReconciliationConflictState>>,
  strategies: Readonly<Record<string, ReconciliationStrategy>>,
  format: "json" | "markdown",
): string {
  const rows = conflicts.map((conflict) => ({
    id: conflict.id,
    kind: conflict.kind,
    severity: conflict.severity,
    resource: conflict.resource,
    summary: conflict.summary,
    state: states[conflict.id] ?? "open",
    strategy: strategies[conflict.id] ?? conflict.recommendedStrategy,
    contenders: conflict.contenders.map((contender) => ({
      agentId: contender.agentId,
      label: contender.label,
      claim: contender.claim,
      route: contender.route,
      paths: contender.paths,
    })),
    evidence: conflict.evidence,
  }));
  if (format === "markdown") {
    return [
      "# Omnia agent mesh reconciliation preview",
      "",
      "> Renderer-local rehearsal. No file, branch, lease, mailbox, or scheduler mutation occurred.",
      "",
      ...rows.flatMap((row) => [
        `## ${row.id}`,
        `- Resource: ${row.resource}`,
        `- Kind: ${kindLabels[row.kind]}`,
        `- Severity: ${severityLabels[row.severity]}`,
        `- State: ${stateLabels[row.state]}`,
        `- Strategy: ${strategyLabels[row.strategy]}`,
        `- Summary: ${row.summary}`,
        "- Evidence:",
        ...row.evidence.map((item) => `  - ${item}`),
        "",
      ]),
    ].join("\n");
  }
  return JSON.stringify({
    schema: "omnia.agent-mesh-reconciliation-preview.v1",
    scope: "renderer-session",
    executionDisposition: "preview-only",
    durableWrite: false,
    conflicts: rows,
  }, null, 2);
}

function stateMatches(state: ReconciliationConflictState, filter: ReconciliationFilter): boolean {
  return filter === "all" || state === filter;
}

/**
 * Keep conflict search deterministic and renderer-safe. The query only
 * narrows the fixture already present in this preview; it never reads files,
 * mailbox contents, or native reconciliation records.
 */
export function reconciliationConflictMatches(
  conflict: ReconciliationConflict,
  state: ReconciliationConflictState,
  filter: ReconciliationFilter,
  query = "",
): boolean {
  if (!stateMatches(state, filter)) return false;
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const haystack = [
    conflict.id,
    conflict.kind,
    conflict.severity,
    conflict.resource,
    conflict.summary,
    ...conflict.contenders.flatMap((contender) => [
      contender.agentId,
      contender.label,
      contender.claim,
      contender.route,
      ...contender.paths,
    ]),
    ...conflict.evidence,
  ].join(" ").toLocaleLowerCase();
  return haystack.includes(needle);
}

export interface AgentMeshReconciliationPreviewProps {
  readonly linkedWorkCount?: number;
}

export function AgentMeshReconciliationPreview({ linkedWorkCount = 0 }: AgentMeshReconciliationPreviewProps) {
  const [view, setView] = useState<ReconciliationView>("conflicts");
  const [filter, setFilter] = useState<ReconciliationFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState(RECONCILIATION_CONFLICTS[0]?.id ?? null);
  const [states, setStates] = useState<Record<string, ReconciliationConflictState>>({});
  const [strategies, setStrategies] = useState<Record<string, ReconciliationStrategy>>({});
  const [announcement, setAnnouncement] = useState("Renderer-local reconciliation preview; no native mutation was made.");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<"json" | "markdown">("json");
  const [exportStatus, setExportStatus] = useState("Renderer-session export preview; no durable write.");

  const visibleConflicts = useMemo(
    () => RECONCILIATION_CONFLICTS.filter((conflict) => reconciliationConflictMatches(
      conflict,
      states[conflict.id] ?? "open",
      filter,
      searchQuery,
    )),
    [filter, searchQuery, states],
  );
  const selectedConflict = visibleConflicts.find((conflict) => conflict.id === selectedId)
    ?? visibleConflicts[0]
    ?? null;
  const openCount = RECONCILIATION_CONFLICTS.filter((conflict) => (states[conflict.id] ?? "open") === "open").length;
  const heldCount = RECONCILIATION_CONFLICTS.filter((conflict) => states[conflict.id] === "held").length;
  const resolvedCount = RECONCILIATION_CONFLICTS.filter((conflict) => states[conflict.id] === "resolved-preview").length;
  const highRiskCount = RECONCILIATION_CONFLICTS.filter((conflict) => conflict.severity === "high").length;
  const selectedStrategy = selectedConflict
    ? strategies[selectedConflict.id] ?? selectedConflict.recommendedStrategy
    : "hold";
  const exportPayload = useMemo(
    () => serializeReconciliationPreview(RECONCILIATION_CONFLICTS, states, strategies, exportFormat),
    [exportFormat, states, strategies],
  );
  const views: readonly ReconciliationView[] = ["conflicts", "plan", "evidence"];

  const announce = (message: string) => setAnnouncement(`${message} Renderer-local preview only; no native mutation was made.`);
  const chooseStrategy = (strategy: ReconciliationStrategy) => {
    if (!selectedConflict) return;
    setStrategies((current) => ({ ...current, [selectedConflict.id]: strategy }));
    announce(`${strategyLabels[strategy]} selected for ${selectedConflict.resource}.`);
  };
  const setConflictState = (state: ReconciliationConflictState) => {
    if (!selectedConflict) return;
    setStates((current) => ({ ...current, [selectedConflict.id]: state }));
    announce(`${stateLabels[state]} for ${selectedConflict.resource}.`);
  };
  const setVisibleConflictState = (state: ReconciliationConflictState) => {
    if (visibleConflicts.length === 0) return;
    setStates((current) => {
      const next = { ...current };
      visibleConflicts.forEach((conflict) => {
        next[conflict.id] = state;
      });
      return next;
    });
    announce(`${stateLabels[state]} applied to ${visibleConflicts.length} visible conflict${visibleConflicts.length === 1 ? "" : "s"}.`);
  };
  const resetVisibleConflicts = () => {
    if (visibleConflicts.length === 0) return;
    const visibleIds = new Set(visibleConflicts.map((conflict) => conflict.id));
    setStates((current) => {
      const next = { ...current };
      visibleIds.forEach((id) => delete next[id]);
      return next;
    });
    setStrategies((current) => {
      const next = { ...current };
      visibleIds.forEach((id) => delete next[id]);
      return next;
    });
    announce(`Reset ${visibleConflicts.length} visible conflict${visibleConflicts.length === 1 ? "" : "s"}.`);
  };
  const resetSelected = () => {
    if (!selectedConflict) return;
    setStates((current) => {
      const next = { ...current };
      delete next[selectedConflict.id];
      return next;
    });
    setStrategies((current) => {
      const next = { ...current };
      delete next[selectedConflict.id];
      return next;
    });
    announce(`Reset ${selectedConflict.resource}`);
  };
  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard is unavailable; the visible export preview remains available.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setExportStatus(`${exportFormat.toUpperCase()} reconciliation preview copied; no durable write was made.`);
    } catch {
      setExportStatus("Clipboard access was denied; no reconciliation payload was copied.");
    }
  };
  const downloadExport = () => {
    setExportStatus(
      downloadText(exportPayload, exportFormat)
        ? `${exportFormat.toUpperCase()} browser download started; no native receipt was created.`
        : "Browser download is unavailable in this preview environment.",
    );
  };
  const moveView = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? views.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + views.length) % views.length;
    const nextView = views[nextIndex];
    if (!nextView) return;
    setView(nextView);
    document.getElementById(`reconciliation-tab-${nextView}`)?.focus();
  };

  return (
    <section className="agent-reconciliation-preview" aria-label="Agent mesh reconciliation preview">
      <header className="agent-reconciliation-preview__header">
        <div>
          <span className="eyebrow"><GitMerge size={13} /> Coordination safety</span>
          <h2>Reconciliation Studio</h2>
          <p>Make parallel-agent conflicts legible before any writer, lease, branch, or output route is allowed to proceed.</p>
        </div>
        <div className="agent-reconciliation-preview__header-actions">
          <span className="agent-reconciliation-preview__badge"><Eye size={12} /> Preview only</span>
          <button type="button" className="button button--ghost" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="agent-reconciliation-export">
            <FileJson2 size={13} /> {exportOpen ? "Hide export" : "Export"}
          </button>
        </div>
      </header>

      <div className="agent-reconciliation-preview__metrics" aria-label="Reconciliation summary">
        <div><strong>{openCount}</strong><span>open conflicts</span></div>
        <div><strong>{highRiskCount}</strong><span>high risk signals</span></div>
        <div><strong>{heldCount}</strong><span>held in preview</span></div>
        <div><strong>{resolvedCount}</strong><span>resolved in preview</span></div>
        <div><strong>{linkedWorkCount}</strong><span>linked work rows</span></div>
      </div>

      <div className="agent-reconciliation-preview__toolbar" role="toolbar" aria-label="Reconciliation controls">
        <div className="agent-reconciliation-preview__tabs" role="tablist" aria-label="Reconciliation views" aria-orientation="horizontal">
          {views.map((nextView, index) => (
            <button
              key={nextView}
              id={`reconciliation-tab-${nextView}`}
              type="button"
              role="tab"
              aria-selected={view === nextView}
              aria-controls={`reconciliation-panel-${nextView}`}
              tabIndex={view === nextView ? 0 : -1}
              className={view === nextView ? "is-active" : ""}
              onClick={() => setView(nextView)}
              onKeyDown={(event) => moveView(event, index)}
            >
              {nextView === "conflicts" ? <ShieldAlert size={13} /> : nextView === "plan" ? <Split size={13} /> : <CheckCircle2 size={13} />}
              {nextView === "conflicts" ? "Conflicts" : nextView === "plan" ? "Plan" : "Evidence"}
            </button>
          ))}
        </div>
        <label className="agent-reconciliation-preview__filter"><span>Show</span><select aria-label="Reconciliation conflict filter" value={filter} onChange={(event) => setFilter(event.target.value as ReconciliationFilter)}><option value="all">All conflicts</option><option value="open">Open only</option><option value="held">Held in preview</option><option value="resolved-preview">Resolved preview</option></select></label>
        <label className="agent-reconciliation-preview__search"><span>Search</span><span className="agent-reconciliation-preview__search-control"><Search size={13} aria-hidden="true" /><input aria-label="Search reconciliation conflicts" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="resource, agent, path…" /></span></label>
        <div className="agent-reconciliation-preview__bulk" role="group" aria-label="Visible conflict preview actions">
          <button type="button" className="button button--ghost" onClick={() => setVisibleConflictState("held")} disabled={visibleConflicts.length === 0}>Hold visible</button>
          <button type="button" className="button button--ghost" onClick={() => setVisibleConflictState("resolved-preview")} disabled={visibleConflicts.length === 0}>Resolve visible</button>
          <button type="button" className="button button--ghost" onClick={resetVisibleConflicts} disabled={visibleConflicts.length === 0}>Reset visible</button>
        </div>
      </div>

      {exportOpen ? (
        <section id="agent-reconciliation-export" className="agent-reconciliation-preview__export" aria-label="Reconciliation export preview">
          <div className="agent-reconciliation-preview__export-toolbar" role="toolbar" aria-label="Reconciliation export actions">
            <label><span>Format</span><select aria-label="Reconciliation export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as "json" | "markdown")}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
            <button type="button" className="button button--secondary" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button>
            <button type="button" className="button button--secondary" onClick={downloadExport}><Download size={13} /> Download</button>
          </div>
          <pre role="region" aria-label={`${exportFormat === "json" ? "JSON" : "Markdown"} reconciliation export preview`}>{exportPayload}</pre>
          <p role="status" aria-live="polite">{exportStatus}</p>
        </section>
      ) : null}

      {view === "conflicts" ? (
        <div id="reconciliation-panel-conflicts" role="tabpanel" aria-labelledby="reconciliation-tab-conflicts" tabIndex={0} className="agent-reconciliation-preview__body">
          <div className="agent-reconciliation-preview__list" role="listbox" aria-label="Reconciliation conflicts">
            {visibleConflicts.map((conflict) => {
              const state = states[conflict.id] ?? "open";
              return (
                <button key={conflict.id} type="button" role="option" aria-selected={selectedConflict?.id === conflict.id} className={`agent-reconciliation-preview__row ${selectedConflict?.id === conflict.id ? "is-selected" : ""}`} onClick={() => setSelectedId(conflict.id)}>
                  <span className={`agent-reconciliation-preview__severity agent-reconciliation-preview__severity--${conflict.severity}`}><AlertTriangle size={12} /> {severityLabels[conflict.severity]}</span>
                  <strong>{conflict.resource}</strong>
                  <small>{kindLabels[conflict.kind]} · {stateLabels[state]}</small>
                </button>
              );
            })}
            {visibleConflicts.length === 0 ? <p className="agent-reconciliation-preview__empty">No conflicts match this filter.</p> : null}
          </div>
          {selectedConflict ? (
            <article className="agent-reconciliation-preview__detail" aria-label={`Conflict detail for ${selectedConflict.resource}`}>
              <header>
                <div>
                  <span className="eyebrow">{kindLabels[selectedConflict.kind]} · {selectedConflict.observedAt}</span>
                  <h3>{selectedConflict.resource}</h3>
                  <p>{selectedConflict.summary}</p>
                </div>
                <span className={`agent-reconciliation-preview__state agent-reconciliation-preview__state--${states[selectedConflict.id] ?? "open"}`}>{stateLabels[states[selectedConflict.id] ?? "open"]}</span>
              </header>
              <div className="agent-reconciliation-preview__contenders" aria-label="Competing claims">
                {selectedConflict.contenders.map((contender) => (
                  <div key={contender.agentId} className="agent-reconciliation-preview__contender">
                    <div className="agent-reconciliation-preview__contender-heading"><strong>{contender.label}</strong><code>{contender.agentId}</code></div>
                    <p>{contender.claim}</p>
                    <small><Network size={12} /> {contender.route}</small>
                    <ul>{contender.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
                  </div>
                ))}
              </div>
              <div className="agent-reconciliation-preview__strategies" role="group" aria-label="Reconciliation strategy">
                <span className="eyebrow">Strategy</span>
                <div>{(["sequence", "merge", "hold", "manual"] as const).map((strategy) => <button key={strategy} type="button" className={selectedStrategy === strategy ? "is-active" : ""} aria-pressed={selectedStrategy === strategy} onClick={() => chooseStrategy(strategy)}>{strategyLabels[strategy]}</button>)}</div>
                <small>Recommended: {strategyLabels[selectedConflict.recommendedStrategy]}. Selecting a strategy only changes this renderer session.</small>
              </div>
              <div className="agent-reconciliation-preview__actions">
                <button type="button" className="button button--secondary" onClick={() => announce(`Plan preview opened for ${selectedConflict.resource}`)}><RefreshCw size={13} /> Preview plan</button>
                <button type="button" className="button button--ghost" onClick={() => setConflictState("held")}><LockKeyhole size={13} /> Hold write</button>
                <button type="button" className="button button--ghost" onClick={() => setConflictState("resolved-preview")}><Check size={13} /> Mark resolved in preview</button>
                <button type="button" className="button button--ghost" onClick={resetSelected}>Reset</button>
              </div>
              <p className="agent-reconciliation-preview__boundary"><ShieldAlert size={13} /> No file read/write, branch merge, lease mutation, mailbox delivery, scheduler action, or durable receipt is connected to this rehearsal.</p>
            </article>
          ) : <p className="agent-reconciliation-preview__empty">Select a conflict to inspect its competing claims.</p>}
          <p className="agent-reconciliation-preview__announcement" role="status" aria-live="polite">{announcement}</p>
        </div>
      ) : null}

      {view === "plan" ? (
        <section id="reconciliation-panel-plan" role="tabpanel" aria-labelledby="reconciliation-tab-plan" tabIndex={0} className="agent-reconciliation-preview__plan">
          <div className="agent-reconciliation-preview__plan-heading"><div><span className="eyebrow"><Split size={13} /> Ordered rehearsal</span><h3>{selectedConflict ? `Plan for ${selectedConflict.resource}` : "No conflict selected"}</h3></div><span className="agent-reconciliation-preview__state agent-reconciliation-preview__state--held">No native execution</span></div>
          {selectedConflict ? <ol>{[
            `Freeze the visible claims for ${selectedConflict.resource}.`,
            `Compare ${selectedConflict.contenders.length} contender routes and their touched paths.`,
            `Apply the ${strategyLabels[selectedStrategy].toLowerCase()} strategy in a future authority layer.`,
            "Require a fresh evidence receipt before reopening the output route.",
          ].map((step) => <li key={step}><span><Clock3 size={13} /></span><div><strong>{step}</strong><small>Preview step · not dispatched</small></div></li>)}</ol> : <p className="agent-reconciliation-preview__empty">Select a conflict from the Conflicts tab first.</p>}
          <p className="agent-reconciliation-preview__boundary"><LockKeyhole size={13} /> The plan is a visual rehearsal. It cannot claim that any writer, compiler, agent, lease, or Project Twin action ran.</p>
        </section>
      ) : null}

      {view === "evidence" ? (
        <section id="reconciliation-panel-evidence" role="tabpanel" aria-labelledby="reconciliation-tab-evidence" tabIndex={0} className="agent-reconciliation-preview__evidence">
          <header><div><span className="eyebrow"><CheckCircle2 size={13} /> Evidence register</span><h3>Why each conflict is still bounded</h3></div><span className="agent-reconciliation-preview__state agent-reconciliation-preview__state--open">Renderer evidence</span></header>
          <div className="agent-reconciliation-preview__evidence-grid">{RECONCILIATION_CONFLICTS.flatMap((conflict) => conflict.evidence.map((item) => <article key={`${conflict.id}:${item}`}><span>{kindLabels[conflict.kind]}</span><p>{item}</p><small>{conflict.resource}</small></article>))}</div>
          <p className="agent-reconciliation-preview__boundary"><ShieldAlert size={13} /> Evidence here describes projection inputs and boundaries only; it is not a native conflict receipt.</p>
        </section>
      ) : null}
    </section>
  );
}

export default AgentMeshReconciliationPreview;
