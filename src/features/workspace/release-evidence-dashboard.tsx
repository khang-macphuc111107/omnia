import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Download,
  FileCheck2,
  Filter,
  Info,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Workflow,
} from "lucide-react";

type ReleaseGateStatus = "recorded" | "partial" | "blocked" | "unknown" | "planned";
type ReleaseGateArea = "freeze" | "renderer" | "native" | "package";
type AreaFilter = "all" | ReleaseGateArea;
type StatusFilter = "all" | "attention" | ReleaseGateStatus;
type ExportFormat = "json" | "markdown";

export interface ReleaseEvidenceGate {
  readonly id: string;
  readonly area: ReleaseGateArea;
  readonly title: string;
  readonly status: ReleaseGateStatus;
  readonly evidenceClass: string;
  readonly snapshot: string;
  readonly source: string;
  readonly summary: string;
  readonly proof: string;
  readonly gap: string;
  readonly nextStep: string;
}

const AREA_LABELS: Record<ReleaseGateArea, string> = {
  freeze: "Source freeze",
  renderer: "Renderer gates",
  native: "Native boundary",
  package: "Package & release",
};

const STATUS_LABELS: Record<ReleaseGateStatus, string> = {
  recorded: "Recorded",
  partial: "Partial",
  blocked: "Blocked",
  unknown: "Unknown",
  planned: "Planned",
};

/**
 * This fixture is intentionally a release-lane rehearsal. It describes the
 * evidence shape the app should make visible without pretending to run a
 * validator, compiler, signer, provider, or native package step.
 */
export const RELEASE_EVIDENCE_GATES: readonly ReleaseEvidenceGate[] = Object.freeze([
  {
    id: "spec-and-schema",
    area: "freeze",
    title: "Spec and schema contract",
    status: "recorded",
    evidenceClass: "Static validation receipt",
    snapshot: "Recorded checkpoint · 2026-09-19",
    source: "docs/omnia-ultra/tools/validate-spec.ps1",
    summary: "Normative Markdown, JSON registries, requirements, and capability rows have a recorded shape check.",
    proof: "121 Markdown files · 52 JSON files · 55 requirements · 55 capability rows",
    gap: "Shape and registry consistency do not prove runtime behavior or implementation completeness.",
    nextStep: "Re-run after the final writer freeze and attach the receipt to this candidate revision.",
  },
  {
    id: "source-ledger-and-twin",
    area: "freeze",
    title: "Source ledger + Project Twin",
    status: "partial",
    evidenceClass: "Generated projection",
    snapshot: "Renderer-visible snapshot · revision not authoritative",
    source: "docs/omnia-ultra/delivery/source-ledger.json · docs/project-twin/manifest.json",
    summary: "Source hashes and a Twin projection can be reviewed together, but this surface cannot freeze or certify them.",
    proof: "94 sources · 38 local hashes · 47 documented-only URLs",
    gap: "Requirement/capability/test/evidence crosswalk remains incomplete and generated projections can become stale.",
    nextStep: "Bootstrap, check, and retain a same-snapshot revision after every writer stops.",
  },
  {
    id: "renderer-build",
    area: "renderer",
    title: "Renderer typecheck + bundle",
    status: "recorded",
    evidenceClass: "Deterministic build checkpoint",
    snapshot: "Recorded checkpoint · current continuation",
    source: "package.json · typecheck:app · build:renderer",
    summary: "TypeScript and browser bundling have recorded passing checkpoints for the renderer lane.",
    proof: "Renderer syntax, types, and Vite bundle were recorded as passing in this continuation.",
    gap: "This does not prove Tauri packaging, Rust compilation, provider HTTP, or a clean-machine install.",
    nextStep: "Repeat the lightweight gates on the frozen candidate and retain command output with the hash.",
  },
  {
    id: "renderer-accessibility",
    area: "renderer",
    title: "UI and accessibility gates",
    status: "partial",
    evidenceClass: "Focused regression tests",
    snapshot: "Focused slices · not a release certificate",
    source: "src/features/workspace/* focused tests · check:typography · check:hit-targets",
    summary: "Focused UI checks cover the visible workbenches and semantic controls added during this continuation.",
    proof: "Targeted tests and design-token/typography checks are available per slice.",
    gap: "Concurrent edits and the full cross-surface acceptance matrix still need one coherent receipt.",
    nextStep: "Run the focused regression set serially after writers stop, then record failures by acceptance ID.",
  },
  {
    id: "native-runtime",
    area: "native",
    title: "Rust, Tauri, and provider runtime",
    status: "unknown",
    evidenceClass: "Runtime evidence unavailable",
    snapshot: "Native status unknown",
    source: "src-tauri/ · native core/storage/provider contracts",
    summary: "The browser preview can describe the native boundary but cannot establish a native compile or packaged runtime receipt.",
    proof: "Static schemas and source contracts are reviewable in this workspace.",
    gap: "cargo, rustc, rustfmt, and rustup are unavailable on this host; provider requests and close/reopen behavior are unverified.",
    nextStep: "Run the native gate on a supported Windows toolchain and bind its receipt to this exact source snapshot.",
  },
  {
    id: "security-and-recovery",
    area: "native",
    title: "Storage, recovery, and security rehearsal",
    status: "partial",
    evidenceClass: "Static + schema evidence",
    snapshot: "Contract evidence only",
    source: "docs/storage-schema.sql · docs/THREAT_MODEL.md · native verifiers",
    summary: "Storage and capability contracts expose the intended safety gates without claiming a live fault-injection run.",
    proof: "Schema, helper, ACL, and authority verifiers are available as separate receipts.",
    gap: "Cross-process concurrency, backup/restore, key rotation, and Windows runtime fault evidence remain open.",
    nextStep: "Join native fault-injection, restore, and concurrency receipts before promotion beyond internal preview.",
  },
  {
    id: "packaged-artifact",
    area: "package",
    title: "Packaged Windows artifact",
    status: "blocked",
    evidenceClass: "Artifact receipt missing",
    snapshot: "No packaged candidate attached",
    source: "docs/IMPLEMENTATION_STATUS.md · docs/releases/",
    summary: "The current lane is an unsigned internal/developer preview; no packaged artifact is attached to this renderer dashboard.",
    proof: "The release target and required artifact evidence are documented as a contract.",
    gap: "No clean-VM install/upgrade/uninstall, signed artifact, SBOM, updater, or rollback receipt is available here.",
    nextStep: "Produce an isolated Windows package, hash it, sign it, and rehearse install/upgrade/rollback on a clean VM.",
  },
  {
    id: "promotion-policy",
    area: "package",
    title: "Promotion and rollback policy",
    status: "planned",
    evidenceClass: "Planned release gate",
    snapshot: "Future release workflow",
    source: ".github/workflows/ · docs/QA_STRATEGY.md · acceptance-gates.md",
    summary: "A future promotion workflow can collect gate receipts and stop on critical gaps.",
    proof: "Policy requirements are visible in the release and quality documentation.",
    gap: "No native release orchestrator, signing service, update channel, or rollback execution is connected to this preview.",
    nextStep: "Define immutable candidate manifests, approval ownership, artifact retention, and rollback evidence.",
  },
]);

const AREA_ORDER: readonly ReleaseGateArea[] = ["freeze", "renderer", "native", "package"];

function statusIcon(status: ReleaseGateStatus) {
  if (status === "recorded") return <CheckCircle2 size={14} aria-hidden="true" />;
  if (status === "partial") return <Info size={14} aria-hidden="true" />;
  if (status === "blocked" || status === "unknown") return <AlertTriangle size={14} aria-hidden="true" />;
  return <Sparkles size={14} aria-hidden="true" />;
}

function statusClass(status: ReleaseGateStatus): string {
  return `release-evidence-dashboard__status release-evidence-dashboard__status--${status}`;
}

function countStatuses(gates: readonly ReleaseEvidenceGate[]) {
  return gates.reduce<Record<ReleaseGateStatus, number>>(
    (counts, gate) => {
      counts[gate.status] += 1;
      return counts;
    },
    { recorded: 0, partial: 0, blocked: 0, unknown: 0, planned: 0 },
  );
}

function serializeReleaseBrief(
  gates: readonly ReleaseEvidenceGate[],
  area: AreaFilter,
  status: StatusFilter,
  query: string,
  format: ExportFormat,
): string {
  const counts = countStatuses(gates);
  const payload = {
    schema: "omnia.release-evidence-dashboard.preview.v1",
    scope: "renderer-session",
    releaseLane: "Omnia 0.1.0 Phase 1 Provider Preview",
    classification: "Unsigned internal/developer preview",
    snapshot: "recorded-checkpoints-2026-09-19",
    filter: { area, status, query: query.trim() || null },
    counts,
    gates,
    boundary: [
      "This is a renderer-local evidence rehearsal, not a release certificate.",
      "Recorded means a referenced checkpoint exists; it is not a live command result from this panel.",
      "Unknown is not pass, zero, healthy, or unlimited.",
      "No native compile, provider request, package, signing, filesystem write, or durable receipt was created.",
    ],
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia release evidence dashboard",
    "",
    "> Renderer-session rehearsal for the unsigned internal/developer preview lane. This is not a release certificate.",
    "",
    `- Release lane: ${payload.releaseLane}`,
    `- Classification: ${payload.classification}`,
    `- Snapshot label: ${payload.snapshot}`,
    `- Recorded: ${counts.recorded}`,
    `- Partial: ${counts.partial}`,
    `- Blocked: ${counts.blocked}`,
    `- Unknown: ${counts.unknown}`,
    `- Planned: ${counts.planned}`,
    "",
    ...gates.flatMap((gate) => [
      `## ${gate.title}`,
      `- Area: ${AREA_LABELS[gate.area]}`,
      `- Status: ${STATUS_LABELS[gate.status]}`,
      `- Evidence class: ${gate.evidenceClass}`,
      `- Snapshot: ${gate.snapshot}`,
      `- Proof: ${gate.proof}`,
      `- Gap: ${gate.gap}`,
      `- Next: ${gate.nextStep}`,
      "",
    ]),
    "## Boundary",
    ...payload.boundary.map((entry) => `- ${entry}`),
  ].join("\n");
}

function downloadReleaseBrief(payload: string, format: ExportFormat) {
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-release-evidence-dashboard.${format === "json" ? "json" : "md"}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ReleaseEvidenceDashboard() {
  const [area, setArea] = useState<AreaFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(RELEASE_EVIDENCE_GATES[0]?.id ?? null);
  const [format, setFormat] = useState<ExportFormat>("json");
  const [notice, setNotice] = useState("Release-lane checkpoints are shown as a renderer-local rehearsal.");

  const counts = useMemo(() => countStatuses(RELEASE_EVIDENCE_GATES), []);
  const visibleGates = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return RELEASE_EVIDENCE_GATES.filter((gate) => {
      const matchesArea = area === "all" || gate.area === area;
      const matchesStatus = status === "all"
        || (status === "attention" && gate.status !== "recorded")
        || gate.status === status;
      const searchable = [gate.title, gate.evidenceClass, gate.snapshot, gate.source, gate.summary, gate.proof, gate.gap, gate.nextStep].join(" ").toLowerCase();
      return matchesArea && matchesStatus && (!normalized || searchable.includes(normalized));
    });
  }, [area, query, status]);
  const selected = visibleGates.find((gate) => gate.id === selectedId) ?? visibleGates[0] ?? null;
  const payload = useMemo(() => serializeReleaseBrief(visibleGates, area, status, query, format), [area, format, query, status, visibleGates]);
  const attentionCount = counts.partial + counts.blocked + counts.unknown + counts.planned;
  const releaseReady = counts.blocked === 0 && counts.unknown === 0 && counts.planned === 0;

  const resetView = () => {
    setArea("all");
    setStatus("all");
    setQuery("");
    setSelectedId(RELEASE_EVIDENCE_GATES[0]?.id ?? null);
    setNotice("View reset; the recorded checkpoint set is unchanged.");
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setNotice("Clipboard unavailable; no release evidence brief was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setNotice(`Copied ${format.toUpperCase()} release evidence brief; no durable write was made.`);
    } catch {
      setNotice("Clipboard access was denied; nothing was copied.");
    }
  };

  return (
    <section className="release-evidence-dashboard" aria-labelledby="release-evidence-dashboard-heading">
      <header className="release-evidence-dashboard__header">
        <div>
          <span className="eyebrow"><Workflow size={13} /> Release lane · evidence chain</span>
          <h2 id="release-evidence-dashboard-heading">Release evidence dashboard</h2>
          <p>One compact view of the source freeze, renderer proof, native boundary, and release blockers.</p>
        </div>
        <div className="release-evidence-dashboard__header-meta">
          <span className="release-evidence-dashboard__badge"><ShieldAlert size={13} /> Preview only</span>
          <span className={`release-evidence-dashboard__readiness ${releaseReady ? "is-ready" : "is-blocked"}`}>
            {releaseReady ? "Candidate evidence complete" : "Internal preview · gates open"}
          </span>
        </div>
      </header>

      <div className="release-evidence-dashboard__candidate" aria-label="Release candidate summary">
        <div><span className="eyebrow">Candidate lane</span><strong>Omnia 0.1.0 · Phase 1 Provider Preview</strong><small>Unsigned internal/developer preview · no packaged candidate attached</small></div>
        <div><span className="eyebrow">Attention</span><strong>{attentionCount} of {RELEASE_EVIDENCE_GATES.length} gates</strong><small>partial, blocked, unknown, or planned</small></div>
        <div><span className="eyebrow">Recorded</span><strong>{counts.recorded} gates</strong><small>checkpoint references only</small></div>
      </div>

      <div className="release-evidence-dashboard__phase-strip" aria-label="Release evidence phases">
        {AREA_ORDER.map((phase) => {
          const phaseGates = RELEASE_EVIDENCE_GATES.filter((gate) => gate.area === phase);
          const phaseCounts = countStatuses(phaseGates);
          const phaseAttention = phaseCounts.partial + phaseCounts.blocked + phaseCounts.unknown + phaseCounts.planned;
          return (
            <button type="button" key={phase} className={`release-evidence-dashboard__phase${area === phase ? " is-selected" : ""}`} onClick={() => setArea((current) => current === phase ? "all" : phase)} aria-pressed={area === phase}>
              <span className="release-evidence-dashboard__phase-index">{AREA_ORDER.indexOf(phase) + 1}</span>
              <span><strong>{AREA_LABELS[phase]}</strong><small>{phaseAttention ? `${phaseAttention} open gate${phaseAttention === 1 ? "" : "s"}` : "Recorded checkpoints"}</small></span>
              <span className={`release-evidence-dashboard__phase-count${phaseAttention ? " has-attention" : ""}`}>{phaseGates.length}</span>
            </button>
          );
        })}
      </div>

      <div className="release-evidence-dashboard__summary" aria-label="Release evidence status summary">
        <article><CheckCircle2 size={15} /><span>Recorded</span><strong>{counts.recorded}</strong><small>checkpoint reference</small></article>
        <article><Info size={15} /><span>Partial</span><strong>{counts.partial}</strong><small>more proof needed</small></article>
        <article><AlertTriangle size={15} /><span>Blocked / unknown</span><strong>{counts.blocked + counts.unknown}</strong><small>not promotable</small></article>
        <article><Sparkles size={15} /><span>Planned</span><strong>{counts.planned}</strong><small>future workflow</small></article>
      </div>

      <div className="release-evidence-dashboard__toolbar" role="toolbar" aria-label="Release evidence filters">
        <label className="release-evidence-dashboard__search"><Search size={14} /><span className="sr-only">Search release evidence</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search gate, receipt, source, or next step" aria-label="Search release evidence" /></label>
        <label><span>Phase</span><select value={area} onChange={(event) => setArea(event.target.value as AreaFilter)} aria-label="Filter release evidence phase"><option value="all">All phases</option>{AREA_ORDER.map((phase) => <option key={phase} value={phase}>{AREA_LABELS[phase]}</option>)}</select></label>
        <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} aria-label="Filter release evidence status"><option value="all">All statuses</option><option value="attention">Needs attention</option><option value="recorded">Recorded</option><option value="partial">Partial</option><option value="blocked">Blocked</option><option value="unknown">Unknown</option><option value="planned">Planned</option></select></label>
        <span className="release-evidence-dashboard__result" aria-label={`${visibleGates.length} of ${RELEASE_EVIDENCE_GATES.length} gates`}><Filter size={13} /> {visibleGates.length} of {RELEASE_EVIDENCE_GATES.length} gates</span>
        <button type="button" className="button button--ghost" onClick={resetView}><RefreshCw size={13} /> Reset view</button>
      </div>

      <div className="release-evidence-dashboard__layout">
        <div className="release-evidence-dashboard__list" role="list" aria-label="Release evidence gates">
          {visibleGates.map((gate) => (
            <button type="button" role="listitem" key={gate.id} className={`release-evidence-dashboard__gate${selected?.id === gate.id ? " is-selected" : ""}`} onClick={() => setSelectedId(gate.id)} aria-pressed={selected?.id === gate.id}>
              <span className={statusClass(gate.status)}>{statusIcon(gate.status)} {STATUS_LABELS[gate.status]}</span>
              <strong>{gate.title}</strong>
              <small>{AREA_LABELS[gate.area]} · {gate.evidenceClass}</small>
            </button>
          ))}
          {visibleGates.length === 0 ? <div className="release-evidence-dashboard__empty" role="status"><Search size={18} /><strong>No release gates match</strong><span>Try another phase, status, or search term.</span></div> : null}
        </div>

        <aside className="release-evidence-dashboard__detail" aria-label="Selected release evidence detail">
          {selected ? (
            <>
              <header><div><span className="eyebrow">{AREA_LABELS[selected.area]}</span><h3>{selected.title}</h3></div><span className={statusClass(selected.status)}>{statusIcon(selected.status)} {STATUS_LABELS[selected.status]}</span></header>
              <p>{selected.summary}</p>
              <dl><div><dt>Evidence class</dt><dd>{selected.evidenceClass}</dd></div><div><dt>Snapshot</dt><dd>{selected.snapshot}</dd></div><div><dt>Recorded proof</dt><dd>{selected.proof}</dd></div><div><dt>Source</dt><dd>{selected.source}</dd></div><div><dt>Open gap</dt><dd>{selected.gap}</dd></div><div><dt>Next step</dt><dd>{selected.nextStep}</dd></div></dl>
            </>
          ) : <div className="release-evidence-dashboard__empty"><FileCheck2 size={18} /><strong>Select a gate</strong><span>The evidence chain and its boundary will appear here.</span></div>}
        </aside>
      </div>

      <section className="release-evidence-dashboard__export" aria-label="Release evidence brief preview">
        <div className="release-evidence-dashboard__export-toolbar"><div><span className="eyebrow">Portable review</span><strong>Export the visible release brief</strong></div><label><span>Format</span><select aria-label="Release evidence export format" value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={() => { downloadReleaseBrief(payload, format); setNotice("Browser download started; no durable release receipt was created."); }}><Download size={13} /> Download</button></div>
        <pre tabIndex={0} aria-label={`${format === "json" ? "JSON" : "Markdown"} release evidence brief preview`}><code>{payload}</code></pre>
        <p className="release-evidence-dashboard__notice" role="status" aria-live="polite">{notice}</p>
      </section>

      <p className="release-evidence-dashboard__boundary" role="note" aria-label="Release evidence dashboard boundary"><ShieldAlert size={14} /> This board is renderer-local and preview-only. It does not run validators, compile Rust, call providers, read or write the filesystem, package/sign Windows artifacts, promote a candidate, or create a durable release evidence receipt.</p>
    </section>
  );
}

export default ReleaseEvidenceDashboard;
