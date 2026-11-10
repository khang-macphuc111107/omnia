import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Clock3,
  Download,
  FileCheck2,
  Filter,
  Info,
  Link2,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Workflow,
} from "lucide-react";

type ObservabilityEvidenceStatus = "recorded" | "partial" | "unknown" | "planned";
type ObservabilityEvidenceArea = "lifecycle" | "lineage" | "usage" | "timing" | "cost" | "safety";
type ObservabilityEvidenceFilter = "all" | "attention" | ObservabilityEvidenceStatus;
type ObservabilityEvidenceFormat = "json" | "markdown";
type ObservabilityEvidenceScope = "workspace" | "project" | "chat" | "run";
type ObservabilityReviewState = "open" | "reviewed" | "follow-up" | "gate-requested";

interface ObservabilityEvidenceReview {
  readonly state: ObservabilityReviewState;
  readonly owner: string;
  readonly note: string;
}

export interface ObservabilityEvidenceItem {
  readonly id: string;
  readonly area: ObservabilityEvidenceArea;
  readonly title: string;
  readonly status: ObservabilityEvidenceStatus;
  readonly value: string;
  readonly source: string;
  readonly coverage: string;
  readonly freshness: string;
  readonly reason: string;
  readonly nextGate: string;
}

export interface ObservabilityLifecycleStage {
  readonly id: string;
  readonly label: string;
  readonly state: ObservabilityEvidenceStatus;
  readonly note: string;
}

export const OBSERVABILITY_EVIDENCE_ITEMS: readonly ObservabilityEvidenceItem[] = Object.freeze([
  {
    id: "request-lifecycle",
    area: "lifecycle",
    title: "Request lifecycle envelope",
    status: "partial",
    value: "Renderer request shape visible",
    source: "observability/request-lifecycle.md · renderer preview",
    coverage: "Stage names and inspector affordances are visible; native journal milestones are not joined.",
    freshness: "Session-only",
    reason: "The browser surface can rehearse lifecycle labels but cannot prove queued, frozen, dispatched, or terminal native state.",
    nextGate: "Bind one immutable run journal projection to a current native cursor before promoting lifecycle evidence.",
  },
  {
    id: "provider-lineage",
    area: "lineage",
    title: "Frozen provider attempt lineage",
    status: "unknown",
    value: "Unavailable",
    source: "observability/provider-attempt-lineage.md",
    coverage: "No native frozen input, provider profile hash, route revision, or price snapshot is exposed here.",
    freshness: "Not collected",
    reason: "A current provider profile must never be substituted for historical attempt evidence.",
    nextGate: "Expose a bounded content-free lineage receipt with matching run, attempt, and frozen-input IDs.",
  },
  {
    id: "provider-acceptance",
    area: "lineage",
    title: "Provider acceptance and outcome",
    status: "unknown",
    value: "Not observed",
    source: "native provider attempt journal",
    coverage: "Provider acceptance, outcome-unknown, retries, and fallback successors are not connected to this preview.",
    freshness: "Not collected",
    reason: "No browser request is sent from this dashboard, so acceptance and billing safety cannot be inferred.",
    nextGate: "Join provider acceptance, outcome, and retry receipts without allowing blind resend after unknown outcome.",
  },
  {
    id: "usage-ledger",
    area: "usage",
    title: "Usage ledger and token classes",
    status: "partial",
    value: "Renderer estimate only",
    source: "observability/request-usage-telemetry.md · demo projection",
    coverage: "Visible demo units are shown; provider-reported, invoiced, cached, reasoning, and multimodal counters remain unknown.",
    freshness: "Session-only",
    reason: "Missing counters stay unknown; the preview does not convert absent values to zero.",
    nextGate: "Read append-only usage observations with source, freshness, and explicit unknown reasons.",
  },
  {
    id: "timing-milestones",
    area: "timing",
    title: "Timing milestones and throughput",
    status: "partial",
    value: "Synthetic timing shape",
    source: "observability/request-lifecycle.md · renderer preview",
    coverage: "Timeline slots are represented; monotonic offsets, first-byte, TTFT, stalls, and percentile receipts are not measured.",
    freshness: "Session-only",
    reason: "Without a single clock domain and native timestamps, durations must not be presented as observed performance.",
    nextGate: "Persist wall-clock anchors plus monotonic offsets and mark samples partial across sleep/recovery boundaries.",
  },
  {
    id: "cost-provenance",
    area: "cost",
    title: "Cost provenance and reconciliation",
    status: "unknown",
    value: "Unknown",
    source: "observability/cost-usage-analytics.md",
    coverage: "No frozen price snapshot, provider report, invoice, currency, or retry/fallback cost fact is available.",
    freshness: "Not collected",
    reason: "An estimate cannot be replaced by a later provider report, and missing price identity cannot be reconstructed safely.",
    nextGate: "Attach immutable price snapshot identity and preserve estimate, provider-reported, and invoice values separately.",
  },
  {
    id: "redaction-policy",
    area: "safety",
    title: "Redaction and export boundary",
    status: "recorded",
    value: "Content-free preview policy",
    source: "observability/logs-traces-debug.md · diagnostics-session-contract",
    coverage: "Prompt bodies, responses, credentials, cookies, raw paths, and raw tool payloads are excluded from this surface.",
    freshness: "Static contract",
    reason: "The renderer can enforce an allowlist for the preview, but native support-bundle retention is not established here.",
    nextGate: "Connect user-reviewed support-bundle selection to a native redaction and retention receipt.",
  },
  {
    id: "native-receipt",
    area: "safety",
    title: "Native telemetry receipt",
    status: "planned",
    value: "Planned",
    source: "native journal · storage and export contracts",
    coverage: "No durable cursor, retention policy, export checkpoint, or packaged desktop receipt is linked.",
    freshness: "Not collected",
    reason: "This panel is renderer-local and does not write a telemetry ledger or create an export receipt.",
    nextGate: "Add native read authority, bounded projections, retention metadata, and replayable export receipts.",
  },
]);

export const OBSERVABILITY_LIFECYCLE_STAGES: readonly ObservabilityLifecycleStage[] = Object.freeze([
  { id: "draft", label: "Draft", state: "partial", note: "Composer-visible shape" },
  { id: "queued", label: "Queued", state: "unknown", note: "Native queue not linked" },
  { id: "preparing", label: "Preparing", state: "partial", note: "Preview boundary only" },
  { id: "frozen", label: "Frozen", state: "unknown", note: "Lineage receipt unavailable" },
  { id: "dispatching", label: "Dispatching", state: "unknown", note: "No provider request" },
  { id: "accepted", label: "Accepted", state: "unknown", note: "Provider response unavailable" },
  { id: "streaming", label: "Streaming", state: "partial", note: "Visible output shape only" },
  { id: "terminal", label: "Terminal", state: "planned", note: "Native terminal receipt planned" },
]);

const AREA_LABELS: Record<ObservabilityEvidenceArea, string> = {
  lifecycle: "Request lifecycle",
  lineage: "Provider lineage",
  usage: "Usage ledger",
  timing: "Timing & throughput",
  cost: "Cost provenance",
  safety: "Safety & receipts",
};

const STATUS_LABELS: Record<ObservabilityEvidenceStatus, string> = {
  recorded: "Recorded contract",
  partial: "Partial evidence",
  unknown: "Unknown",
  planned: "Planned",
};

const REVIEW_LABELS: Record<ObservabilityReviewState, string> = {
  open: "Open",
  reviewed: "Reviewed in this session",
  "follow-up": "Needs follow-up",
  "gate-requested": "Native gate requested",
};

function statusIcon(status: ObservabilityEvidenceStatus) {
  if (status === "recorded") return <CheckCircle2 size={14} aria-hidden="true" />;
  if (status === "partial") return <Info size={14} aria-hidden="true" />;
  if (status === "unknown") return <AlertTriangle size={14} aria-hidden="true" />;
  return <Sparkles size={14} aria-hidden="true" />;
}

function statusClass(status: ObservabilityEvidenceStatus): string {
  return `observability-evidence-dashboard__status observability-evidence-dashboard__status--${status}`;
}

function countStatuses(items: readonly ObservabilityEvidenceItem[]) {
  return items.reduce<Record<ObservabilityEvidenceStatus, number>>(
    (counts, item) => {
      counts[item.status] += 1;
      return counts;
    },
    { recorded: 0, partial: 0, unknown: 0, planned: 0 },
  );
}

export function serializeObservabilityEvidence(
  items: readonly ObservabilityEvidenceItem[],
  lifecycle: readonly ObservabilityLifecycleStage[],
  input: {
    readonly scope: ObservabilityEvidenceScope;
    readonly area: ObservabilityEvidenceArea | "all";
    readonly status: ObservabilityEvidenceFilter;
    readonly query: string;
    readonly format: ObservabilityEvidenceFormat;
  },
  reviews: Readonly<Record<string, ObservabilityEvidenceReview>> = {},
): string {
  const counts = countStatuses(items);
  const payload = {
    schema: "omnia.observability-evidence-dashboard.preview.v1",
    scope: "renderer-session",
    selectedScope: input.scope,
    snapshot: "renderer-evidence-shape-2026-09-21",
    filters: {
      area: input.area,
      status: input.status,
      query: input.query.trim() || null,
    },
    counts,
    lifecycle,
    items,
    sessionReview: Object.fromEntries(items.map((item) => [
      item.id,
      reviews[item.id] ?? { state: "open", owner: "", note: "" },
    ])),
    boundary: [
      "This is a renderer-local evidence rehearsal, not a native telemetry receipt.",
      "Review dispositions, owners, and notes are session-only triage annotations, not native gate results.",
      "Unknown is not pass, zero, healthy, accepted, or unlimited.",
      "No provider request, native journal read, filesystem write, durable export, or release authority was created.",
      "Prompt bodies, responses, credentials, cookies, raw paths, and raw tool payloads are excluded.",
    ],
  };
  if (input.format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia observability evidence dashboard",
    "",
    "> Renderer-session evidence rehearsal. This is not a native telemetry receipt.",
    "",
    "- Schema: omnia.observability-evidence-dashboard.preview.v1",
    `- Scope: ${input.scope}`,
    `- Snapshot: ${payload.snapshot}`,
    `- Recorded contract: ${counts.recorded}`,
    `- Partial evidence: ${counts.partial}`,
    `- Unknown: ${counts.unknown}`,
    `- Planned: ${counts.planned}`,
    `- Session triage annotations: ${Object.keys(reviews).length}`,
    "",
    "## Request lifecycle",
    ...lifecycle.map((stage) => `- ${stage.label}: ${STATUS_LABELS[stage.state]} · ${stage.note}`),
    "",
    ...items.flatMap((item) => [
      `## ${item.title}`,
      `- Area: ${AREA_LABELS[item.area]}`,
      `- Status: ${STATUS_LABELS[item.status]}`,
      `- Value: ${item.value}`,
      `- Source: ${item.source}`,
      `- Coverage: ${item.coverage}`,
      `- Freshness: ${item.freshness}`,
      `- Reason: ${item.reason}`,
      `- Next gate: ${item.nextGate}`,
      "",
    ]),
    "## Boundary",
    "- Review dispositions, owners, and notes are session-only triage annotations, not native gate results.",
    ...payload.boundary.map((entry) => `- ${entry}`),
  ].join("\n");
}

function downloadPreview(payload: string, format: ObservabilityEvidenceFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-observability-evidence-dashboard.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function ObservabilityEvidenceDashboard() {
  const [scope, setScope] = useState<ObservabilityEvidenceScope>("workspace");
  const [area, setArea] = useState<ObservabilityEvidenceArea | "all">("all");
  const [status, setStatus] = useState<ObservabilityEvidenceFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(OBSERVABILITY_EVIDENCE_ITEMS[0]?.id ?? null);
  const [format, setFormat] = useState<ObservabilityEvidenceFormat>("json");
  const [reviews, setReviews] = useState<Record<string, ObservabilityEvidenceReview>>({});
  const [notice, setNotice] = useState("Evidence chain is a renderer-local preview; native receipts remain unavailable.");

  const counts = useMemo(() => countStatuses(OBSERVABILITY_EVIDENCE_ITEMS), []);
  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return OBSERVABILITY_EVIDENCE_ITEMS.filter((item) => {
      const matchesArea = area === "all" || item.area === area;
      const matchesStatus = status === "all"
        || (status === "attention" && item.status !== "recorded")
        || item.status === status;
      const searchable = [item.title, item.value, item.source, item.coverage, item.freshness, item.reason, item.nextGate, item.area].join(" ").toLowerCase();
      return matchesArea && matchesStatus && (!normalized || searchable.includes(normalized));
    });
  }, [area, query, status]);
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0] ?? null;
  const selectedReview = selected ? reviews[selected.id] ?? { state: "open" as const, owner: "", note: "" } : null;
  const payload = useMemo(
    () => serializeObservabilityEvidence(visibleItems, OBSERVABILITY_LIFECYCLE_STAGES, { scope, area, status, query, format }, reviews),
    [area, format, query, reviews, scope, status, visibleItems],
  );
  const attentionCount = counts.partial + counts.unknown + counts.planned;
  const reviewCounts = useMemo(() => OBSERVABILITY_EVIDENCE_ITEMS.reduce<Record<ObservabilityReviewState, number>>(
    (result, item) => {
      result[reviews[item.id]?.state ?? "open"] += 1;
      return result;
    },
    { open: 0, reviewed: 0, "follow-up": 0, "gate-requested": 0 },
  ), [reviews]);

  const updateSelectedReview = (change: Partial<ObservabilityEvidenceReview>) => {
    if (!selected) return;
    setReviews((current) => ({
      ...current,
      [selected.id]: { ...(current[selected.id] ?? { state: "open", owner: "", note: "" }), ...change },
    }));
  };

  const resetView = () => {
    setScope("workspace");
    setArea("all");
    setStatus("all");
    setQuery("");
    setSelectedId(OBSERVABILITY_EVIDENCE_ITEMS[0]?.id ?? null);
    setReviews({});
    setNotice("Evidence view reset; the renderer-local fixture is unchanged.");
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setNotice("Clipboard unavailable; no observability evidence preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setNotice(`Copied ${format.toUpperCase()} observability evidence preview; no durable write was made.`);
    } catch {
      setNotice("Clipboard access was denied; nothing was copied.");
    }
  };

  const download = () => {
    setNotice(
      downloadPreview(payload, format)
        ? "Browser download started; no native evidence receipt was created."
        : "File download is unavailable in this surface; nothing was exported.",
    );
  };

  return (
    <section className="observability-evidence-dashboard" aria-labelledby="observability-evidence-dashboard-heading">
      <header className="observability-evidence-dashboard__header">
        <div>
          <span className="eyebrow"><Workflow size={13} /> Request inspector · evidence chain</span>
          <h2 id="observability-evidence-dashboard-heading">Observability evidence dashboard</h2>
          <p>Trace what a request would prove across lifecycle, provider lineage, usage, timing, cost, and safety boundaries.</p>
        </div>
        <div className="observability-evidence-dashboard__header-meta">
          <span className="observability-evidence-dashboard__badge"><ShieldAlert size={13} /> Preview only</span>
          <span className="observability-evidence-dashboard__freshness"><Clock3 size={13} /> Snapshot shape · 2026-09-21</span>
        </div>
      </header>

      <div className="observability-evidence-dashboard__summary" aria-label="Observability evidence summary">
        <article><CheckCircle2 size={15} /><span>Recorded contract</span><strong>{counts.recorded}</strong><small>policy shape only</small></article>
        <article><Info size={15} /><span>Partial evidence</span><strong>{counts.partial}</strong><small>renderer projection</small></article>
        <article><AlertTriangle size={15} /><span>Unknown</span><strong>{counts.unknown}</strong><small>not observed here</small></article>
        <article><Sparkles size={15} /><span>Planned</span><strong>{counts.planned}</strong><small>future native gate</small></article>
      </div>

      <section className="observability-evidence-dashboard__triage-summary" aria-label="Session evidence triage summary">
        <div><strong>{reviewCounts.open}</strong><span>Open</span></div>
        <div><strong>{reviewCounts.reviewed}</strong><span>Reviewed this session</span></div>
        <div><strong>{reviewCounts["follow-up"]}</strong><span>Needs follow-up</span></div>
        <div><strong>{reviewCounts["gate-requested"]}</strong><span>Native gate requested</span></div>
        <small>Renderer-session triage only · no native gate is run or confirmed here.</small>
      </section>

      <section className="observability-evidence-dashboard__lifecycle" aria-label="Request lifecycle evidence">
        <header>
          <div><span className="eyebrow">Lifecycle coverage</span><h3>One request, multiple evidence states</h3></div>
          <span className="observability-evidence-dashboard__attention">{attentionCount} open evidence gaps</span>
        </header>
        <div className="observability-evidence-dashboard__lifecycle-track" role="list" aria-label="Request lifecycle stages">
          {OBSERVABILITY_LIFECYCLE_STAGES.map((stage) => (
            <div role="listitem" key={stage.id} className={`observability-evidence-dashboard__stage observability-evidence-dashboard__stage--${stage.state}`}>
              <span className="observability-evidence-dashboard__stage-dot" aria-hidden="true" />
              <strong>{stage.label}</strong>
              <small>{stage.note}</small>
            </div>
          ))}
        </div>
        <p className="observability-evidence-dashboard__lifecycle-note"><Link2 size={14} /> A stage label is not a provider acceptance receipt; unknown and partial states stay visible until native evidence is joined.</p>
      </section>

      <div className="observability-evidence-dashboard__toolbar" role="toolbar" aria-label="Observability evidence filters">
        <label><span>Scope</span><select value={scope} onChange={(event) => setScope(event.target.value as ObservabilityEvidenceScope)} aria-label="Observability evidence scope"><option value="workspace">Workspace</option><option value="project">Project</option><option value="chat">Chat</option><option value="run">Run</option></select></label>
        <label><span>Area</span><select value={area} onChange={(event) => setArea(event.target.value as ObservabilityEvidenceArea | "all")} aria-label="Filter observability evidence area"><option value="all">All areas</option>{Object.entries(AREA_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as ObservabilityEvidenceFilter)} aria-label="Filter observability evidence status"><option value="all">All statuses</option><option value="attention">Needs attention</option><option value="recorded">Recorded contract</option><option value="partial">Partial evidence</option><option value="unknown">Unknown</option><option value="planned">Planned</option></select></label>
        <label className="observability-evidence-dashboard__search"><Search size={14} /><span className="sr-only">Search observability evidence</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search lineage, usage, timing, or receipt" aria-label="Search observability evidence" /></label>
        <span className="observability-evidence-dashboard__result" aria-label={`${visibleItems.length} of ${OBSERVABILITY_EVIDENCE_ITEMS.length} evidence items`}><Filter size={13} /> {visibleItems.length} of {OBSERVABILITY_EVIDENCE_ITEMS.length} items</span>
        <button type="button" className="button button--ghost" onClick={resetView}><RefreshCw size={13} /> Reset view</button>
      </div>

      <div className="observability-evidence-dashboard__layout">
        <div className="observability-evidence-dashboard__list" role="list" aria-label="Observability evidence items">
          {visibleItems.map((item) => (
            <button type="button" role="listitem" key={item.id} className={`observability-evidence-dashboard__item${selected?.id === item.id ? " is-selected" : ""}`} onClick={() => setSelectedId(item.id)} aria-pressed={selected?.id === item.id}>
              <span className={statusClass(item.status)}>{statusIcon(item.status)} {STATUS_LABELS[item.status]}</span>
              <strong>{item.title}</strong>
              <small>{AREA_LABELS[item.area]} · {item.value}</small>
            </button>
          ))}
          {visibleItems.length === 0 ? <div className="observability-evidence-dashboard__empty" role="status"><Search size={18} /><strong>No evidence items match</strong><span>Try a broader search or reset the view.</span></div> : null}
        </div>

        <aside className="observability-evidence-dashboard__detail" aria-label="Selected observability evidence detail">
          {selected ? (
            <>
              <header><div><span className="eyebrow">{AREA_LABELS[selected.area]}</span><h3>{selected.title}</h3></div><span className={statusClass(selected.status)}>{statusIcon(selected.status)} {STATUS_LABELS[selected.status]}</span></header>
              <p className="observability-evidence-dashboard__detail-value">{selected.value}</p>
              <dl>
                <div><dt>Source</dt><dd>{selected.source}</dd></div>
                <div><dt>Coverage</dt><dd>{selected.coverage}</dd></div>
                <div><dt>Freshness</dt><dd>{selected.freshness}</dd></div>
                <div><dt>Why this state</dt><dd>{selected.reason}</dd></div>
                <div><dt>Next evidence gate</dt><dd>{selected.nextGate}</dd></div>
              </dl>
              {selectedReview ? <section className="observability-evidence-dashboard__review" aria-label="Session-only evidence triage">
                <header><div><span className="eyebrow">Review locally</span><strong>{REVIEW_LABELS[selectedReview.state]}</strong></div><span>Session-only</span></header>
                <label><span>Triage disposition</span><select aria-label="Evidence triage disposition" value={selectedReview.state} onChange={(event) => updateSelectedReview({ state: event.target.value as ObservabilityReviewState })}>
                  {Object.entries(REVIEW_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select></label>
                <label><span>Owner / reviewer</span><input aria-label="Evidence review owner" value={selectedReview.owner} onChange={(event) => updateSelectedReview({ owner: event.target.value })} placeholder="Optional name or team" /></label>
                <label><span>Review note</span><textarea aria-label="Evidence review note" value={selectedReview.note} onChange={(event) => updateSelectedReview({ note: event.target.value })} placeholder="What should the next reviewer know?" rows={3} /></label>
                <p>These annotations travel with the renderer preview export; they are not saved to the native journal and do not prove the requested gate passed.</p>
              </section> : null}
            </>
          ) : <div className="observability-evidence-dashboard__empty"><FileCheck2 size={18} /><strong>Select an evidence item</strong><span>The evidence reason and next gate will appear here.</span></div>}
        </aside>
      </div>

      <section className="observability-evidence-dashboard__export" aria-label="Observability evidence export preview">
        <div className="observability-evidence-dashboard__export-toolbar"><div><span className="eyebrow">Portable review</span><strong>Export the visible evidence chain</strong></div><label><span>Format</span><select aria-label="Observability evidence export format" value={format} onChange={(event) => setFormat(event.target.value as ObservabilityEvidenceFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={download}><Download size={13} /> Download</button></div>
        <pre tabIndex={0} aria-label={`${format === "json" ? "JSON" : "Markdown"} observability evidence preview`}><code>{payload}</code></pre>
        <p className="observability-evidence-dashboard__notice" role="status" aria-live="polite">{notice}</p>
      </section>

      <p className="observability-evidence-dashboard__boundary" role="note" aria-label="Observability evidence dashboard boundary"><ShieldAlert size={14} /> Unknown is not pass, zero, healthy, accepted, or unlimited. This renderer-local surface does not send provider requests, read native journals, write telemetry, expose secrets, or create durable evidence receipts.</p>
    </section>
  );
}

export default ObservabilityEvidenceDashboard;
