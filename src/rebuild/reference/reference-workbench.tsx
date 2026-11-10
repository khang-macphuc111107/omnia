import { useMemo, useState } from "react";
import { Check, ChevronRight, CircleDashed, ExternalLink, Filter, GitBranch, Search, ShieldCheck, X } from "lucide-react";
import { referenceAreas, referenceObservations, type Decision, type ReferenceArea, type ReferenceObservation } from "./reference-data";
import "./reference-workbench.css";

export interface ReferenceWorkbenchProps {
  onClose?: () => void;
}

function decisionLabel(decision: Decision): string {
  return decision === "adopt" ? "Use" : decision === "adapt" ? "Remix" : "Hold";
}

function decisionIcon(decision: Decision) {
  return decision === "adopt" ? <Check aria-hidden="true" /> : decision === "adapt" ? <GitBranch aria-hidden="true" /> : <CircleDashed aria-hidden="true" />;
}

function ObservationRow({ item, selected, onSelect }: { item: ReferenceObservation; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`ref-row${selected ? " is-selected" : ""}`} type="button" onClick={onSelect} aria-pressed={selected}>
      <span className={`ref-decision ref-decision-${item.decision}`} aria-label={`Decision: ${decisionLabel(item.decision)}`}>
        {decisionIcon(item.decision)}
      </span>
      <span className="ref-row-copy">
        <strong>{item.name}</strong>
        <span>{item.owner} · {item.area}</span>
      </span>
      <ChevronRight className="ref-row-chevron" aria-hidden="true" />
    </button>
  );
}

function DetailPanel({ item, onClose }: { item: ReferenceObservation; onClose: () => void }) {
  return (
    <aside className="ref-detail" aria-label="Selected research observation">
      <div className="ref-detail-head">
        <div>
          <p className="ref-eyebrow">Observed contract</p>
          <h2>{item.name}</h2>
        </div>
        <button type="button" className="ref-icon-button" aria-label="Close observation" onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      <div className="ref-provenance">
        <div><span>Source</span><code>{item.sourcePath}</code></div>
        <div><span>Revision</span><code>{item.revision}</code></div>
        <div><span>License</span><span>{item.license}</span></div>
        <div><span>Freshness</span><span>{item.freshness}</span></div>
      </div>
      <section className="ref-detail-section"><h3>Observation</h3><p>{item.observation}</p></section>
      <section className="ref-detail-grid">
        <div><h3>Strength</h3><p>{item.strength}</p></div>
        <div><h3>Weakness / limit</h3><p>{item.weakness}</p></div>
      </section>
      <section className="ref-decision-card">
        <div className="ref-decision-card-title"><span className={`ref-decision ref-decision-${item.decision}`}>{decisionIcon(item.decision)}</span><div><p className="ref-eyebrow">Omnia decision</p><h3>{decisionLabel(item.decision)}</h3></div></div>
        <p>{item.omniaDecision}</p>
      </section>
      <section className="ref-acceptance"><ShieldCheck aria-hidden="true" /><div><h3>Acceptance check</h3><p>{item.acceptance}</p></div></section>
    </aside>
  );
}

export function ReferenceWorkbench({ onClose }: ReferenceWorkbenchProps) {
  const [area, setArea] = useState<ReferenceArea | "all">("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(referenceObservations[0]?.id ?? "");
  const [showOnlyDecisions, setShowOnlyDecisions] = useState(false);
  const selected = referenceObservations.find((item) => item.id === selectedId);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => referenceObservations.filter((item) => {
    if (area !== "all" && item.area !== area) return false;
    if (showOnlyDecisions && item.decision === "defer") return false;
    if (!normalizedQuery) return true;
    return [item.name, item.owner, item.sourcePath, item.observation, item.weakness, item.omniaDecision, item.acceptance].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  }), [area, normalizedQuery, showOnlyDecisions]);
  const visibleSelected = selected && filtered.some((item) => item.id === selected.id) ? selected : undefined;

  return (
    <section className="ref-workbench" role="region" aria-label="Omnia reference workbench">
      <header className="ref-topbar">
        <div className="ref-brand"><span className="ref-brand-mark">O</span><div><p className="ref-eyebrow">Omnia / synthesis</p><h1>Reference workbench</h1></div></div>
        <div className="ref-topbar-actions"><span className="ref-status"><span className="ref-status-dot" /> {referenceObservations.length} reviewed contracts</span>{onClose ? <button type="button" className="ref-quiet-button" onClick={onClose}>Back to workspace</button> : null}</div>
      </header>
      <section className="ref-intro">
        <div><p className="ref-eyebrow">Clean-room decision surface</p><h2>Study the contract. Choose the behavior. Prove the gap.</h2><p>This workbench records what was actually read from extracted source and new open-source protocols. It keeps strengths, weaknesses, provenance, and acceptance checks visible before Omnia code is designed.</p></div>
        <div className="ref-intro-stats"><div><strong>{referenceObservations.filter((item) => item.decision === "adopt").length}</strong><span>directly adopted</span></div><div><strong>{referenceObservations.filter((item) => item.decision === "adapt").length}</strong><span>remixed with guardrails</span></div><div><strong>{referenceObservations.filter((item) => item.decision === "defer").length}</strong><span>held out</span></div></div>
      </section>
      <section className="ref-body">
        <nav className="ref-filters" aria-label="Research filters">
          <div className="ref-filter-label"><Filter aria-hidden="true" /><span>Focus</span></div>
          <button type="button" className={`ref-filter${area === "all" ? " is-active" : ""}`} onClick={() => setArea("all")}>All observations <span>{referenceObservations.length}</span></button>
          {referenceAreas.map((item) => <button key={item.id} type="button" className={`ref-filter${area === item.id ? " is-active" : ""}`} onClick={() => setArea(item.id)}>{item.label} <span>{referenceObservations.filter((entry) => entry.area === item.id).length}</span></button>)}
          <label className="ref-toggle"><input type="checkbox" checked={showOnlyDecisions} onChange={(event) => setShowOnlyDecisions(event.target.checked)} /><span>Hide held-out references</span></label>
        </nav>
        <section className="ref-results" aria-label="Research observations">
          <div className="ref-results-head"><div><p className="ref-eyebrow">Synthesis ledger</p><h2>{area === "all" ? "All observations" : referenceAreas.find((item) => item.id === area)?.label}</h2></div><label className="ref-search"><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search source, contract, or decision" aria-label="Search observations" /></label></div>
          <ul className="ref-list" aria-label="Reviewed observations">{filtered.length ? filtered.map((item) => <li key={item.id}><ObservationRow item={item} selected={item.id === selected?.id} onSelect={() => setSelectedId(item.id)} /></li>) : <li className="ref-empty"><p>No observed contract matches this filter.</p><button type="button" onClick={() => { setQuery(""); setArea("all"); }}>Clear filters</button></li>}</ul>
          <p className="ref-results-foot"><ShieldCheck aria-hidden="true" /> Source observations are bounded evidence, not feature parity. A green decision still needs product tests and native receipts.</p>
        </section>
        {visibleSelected ? <DetailPanel item={visibleSelected} onClose={() => setSelectedId("")} /> : null}
      </section>
      <footer className="ref-footer"><span><span className="ref-status-dot" /> Research snapshot · 2026-11-08</span><span>Source path links are local extraction references; no upstream UI is embedded.</span><a href="https://github.com/ag-ui-protocol/ag-ui" target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" /> AG-UI source</a></footer>
    </section>
  );
}

export default ReferenceWorkbench;
