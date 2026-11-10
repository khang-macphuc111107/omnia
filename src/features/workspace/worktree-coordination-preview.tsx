import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clipboard,
  Download,
  FileCode2,
  FileJson2,
  GitBranch,
  GitMerge,
  Info,
  Layers3,
  LockKeyhole,
  Network,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

export type WorktreeCoordinationView = "lanes" | "claims" | "plan";
export type WorktreeCoordinationFilter = "all" | "attention" | "writers" | "read-only";
export type WorktreeLaneState = "isolated" | "shared-read" | "attention" | "awaiting-review";
export type WorktreeClaimMode = "read" | "write";

export interface WorktreePathClaim {
  readonly path: string;
  readonly mode: WorktreeClaimMode;
  readonly ownership: "exclusive" | "shared";
  readonly evidence: "preview" | "native";
}

export interface WorktreeCoordinationLane {
  readonly id: string;
  readonly label: string;
  readonly agent: string;
  /** A proposed branch label only; it is not evidence of a real Git branch. */
  readonly branchLabel: string;
  readonly baseRevision: string;
  readonly state: WorktreeLaneState;
  readonly summary: string;
  readonly lastSignal: string;
  readonly claims: readonly WorktreePathClaim[];
}

const LANES: readonly WorktreeCoordinationLane[] = [
  {
    id: "worktree:ui-builder",
    label: "UI builder lane",
    agent: "UI builder",
    branchLabel: "preview/ui-control-deck",
    baseRevision: "renderer snapshot · 09:17",
    state: "isolated",
    summary: "Copy-on-write preview lane for the visible Project and Chat surfaces.",
    lastSignal: "Renderer files are isolated in the projection; native branch evidence is unavailable.",
    claims: [
      { path: "src/features/workspace/project-control-deck.tsx", mode: "write", ownership: "exclusive", evidence: "preview" },
      { path: "src/styles/project-control-deck.css", mode: "write", ownership: "exclusive", evidence: "preview" },
      { path: "docs/ui/product-ui-spec.md", mode: "read", ownership: "shared", evidence: "preview" },
    ],
  },
  {
    id: "worktree:evidence-refresh",
    label: "Evidence refresh lane",
    agent: "Evidence researcher",
    branchLabel: "preview/evidence-refresh",
    baseRevision: "docs snapshot · 09:18",
    state: "shared-read",
    summary: "Reads current documentation while preparing a future source-ledger regeneration.",
    lastSignal: "The generated ledger is stale until all documentation writers freeze.",
    claims: [
      { path: "docs/omnia-ultra/delivery/CONTINUOUS_PHASE_STATUS.md", mode: "write", ownership: "exclusive", evidence: "preview" },
      { path: "docs/omnia-ultra/evidence/source-ledger.json", mode: "write", ownership: "shared", evidence: "preview" },
      { path: "docs/ui/product-ui-spec.md", mode: "read", ownership: "shared", evidence: "preview" },
    ],
  },
  {
    id: "worktree:twin-bootstrap",
    label: "Project Twin lane",
    agent: "Twin bootstrap",
    branchLabel: "preview/twin-refresh",
    baseRevision: "twin watermark · stale",
    state: "attention",
    summary: "Would refresh generated Twin outputs after the source and documentation writers settle.",
    lastSignal: "Manifest and graph outputs overlap the evidence refresh lane and remain held for review.",
    claims: [
      { path: "docs/project-twin/manifest.json", mode: "write", ownership: "shared", evidence: "preview" },
      { path: "docs/project-twin/graph.json", mode: "write", ownership: "exclusive", evidence: "preview" },
      { path: "docs/omnia-ultra/evidence/source-ledger.json", mode: "read", ownership: "shared", evidence: "preview" },
    ],
  },
  {
    id: "worktree:ux-review",
    label: "UX review lane",
    agent: "UX reviewer",
    branchLabel: "preview/ux-review",
    baseRevision: "renderer snapshot · 09:12",
    state: "awaiting-review",
    summary: "Read-only review lane waiting for a stable snapshot and explicit handoff.",
    lastSignal: "No write claim is proposed; promotion remains a future native decision.",
    claims: [
      { path: "src/features/workspace/project-control-deck.tsx", mode: "read", ownership: "shared", evidence: "preview" },
      { path: "docs/audit/PROJECT_CONTROL_DECK_EVIDENCE_CROSSWALK_2026-09-21.md", mode: "read", ownership: "shared", evidence: "preview" },
    ],
  },
] as const;

const stateLabels: Record<WorktreeLaneState, string> = {
  isolated: "Copy-on-write preview",
  "shared-read": "Shared read",
  attention: "Conflict held",
  "awaiting-review": "Awaiting review",
};

const stateTone: Record<WorktreeLaneState, string> = {
  isolated: "isolated",
  "shared-read": "shared",
  attention: "attention",
  "awaiting-review": "review",
};

function laneMatches(lane: WorktreeCoordinationLane, filter: WorktreeCoordinationFilter): boolean {
  if (filter === "all") return true;
  if (filter === "attention") return lane.state === "attention";
  if (filter === "writers") return lane.claims.some((claim) => claim.mode === "write");
  return lane.claims.every((claim) => claim.mode === "read");
}

function formatClaim(claim: WorktreePathClaim): string {
  return `${claim.mode}:${claim.path}`;
}

export function serializeWorktreeCoordinationPreview(
  lanes: readonly WorktreeCoordinationLane[] = LANES,
  format: "json" | "markdown" = "json",
): string {
  const records = lanes.map((lane) => ({
    id: lane.id,
    label: lane.label,
    agent: lane.agent,
    branchLabel: lane.branchLabel,
    baseRevision: lane.baseRevision,
    state: lane.state,
    summary: lane.summary,
    claims: lane.claims.map((claim) => ({ ...claim })),
  }));
  if (format === "markdown") {
    return [
      "# Omnia worktree coordination preview",
      "",
      "> Renderer-local rehearsal. Proposed branch labels and path claims are not Git, filesystem, lease, or merge receipts.",
      "",
      ...records.flatMap((lane) => [
        `## ${lane.label}`,
        `- Agent: ${lane.agent}`,
        `- Proposed branch label: ${lane.branchLabel}`,
        `- Base snapshot: ${lane.baseRevision}`,
        `- State: ${stateLabels[lane.state]}`,
        "- Claims:",
        ...lane.claims.map((claim) => `  - ${claim.mode} · ${claim.ownership} · ${claim.path}`),
        "",
      ]),
    ].join("\n");
  }
  return JSON.stringify({
    schema: "omnia.worktree-coordination-preview.v1",
    scope: "renderer-session",
    executionDisposition: "preview-only",
    durableWrite: false,
    nativeBranchEvidence: false,
    lanes: records,
  }, null, 2);
}

function downloadPreview(payload: string, format: "json" | "markdown"): boolean {
  if (typeof URL.createObjectURL !== "function" || typeof document === "undefined") return false;
  const blob = new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-worktree-coordination-preview.${format === "json" ? "json" : "md"}`;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}

export interface WorktreeCoordinationPreviewProps {
  readonly linkedWorkCount?: number;
}

/**
 * Renderer-only worktree coordination rehearsal.
 *
 * The lane cards make proposed ownership and overlapping paths visible without
 * pretending that a native Git/worktree broker, filesystem writer, lease
 * authority, or merge engine is connected.
 */
export function WorktreeCoordinationPreview({ linkedWorkCount = 0 }: WorktreeCoordinationPreviewProps) {
  const [view, setView] = useState<WorktreeCoordinationView>("lanes");
  const [filter, setFilter] = useState<WorktreeCoordinationFilter>("all");
  const [selectedId, setSelectedId] = useState(LANES[0]?.id ?? null);
  const [announcement, setAnnouncement] = useState("Renderer-local worktree coordination preview; no filesystem or Git mutation was made.");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<"json" | "markdown">("json");
  const [exportStatus, setExportStatus] = useState("Renderer-session export preview; no durable write.");

  const visibleLanes = useMemo(() => LANES.filter((lane) => laneMatches(lane, filter)), [filter]);
  const selectedLane = LANES.find((lane) => lane.id === selectedId) ?? visibleLanes[0] ?? null;
  const writeLaneCount = LANES.filter((lane) => lane.claims.some((claim) => claim.mode === "write")).length;
  const attentionCount = LANES.filter((lane) => lane.state === "attention").length;
  const sharedWriteClaims = LANES.flatMap((lane) => lane.claims).filter((claim) => claim.mode === "write" && claim.ownership === "shared").length;
  const readOnlyCount = LANES.filter((lane) => lane.claims.every((claim) => claim.mode === "read")).length;
  const views: readonly WorktreeCoordinationView[] = ["lanes", "claims", "plan"];
  const exportPayload = useMemo(() => serializeWorktreeCoordinationPreview(LANES, exportFormat), [exportFormat]);

  const previewAction = (message: string) => {
    setAnnouncement(`${message} Renderer-local preview only; no native Git, filesystem, lease, or merge mutation was made.`);
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard is unavailable; the visible export preview remains available.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setExportStatus(`${exportFormat.toUpperCase()} worktree coordination preview copied; no durable write was made.`);
    } catch {
      setExportStatus("Clipboard access was denied; no worktree coordination preview was copied.");
    }
  };

  const downloadExport = () => {
    setExportStatus(
      downloadPreview(exportPayload, exportFormat)
        ? `${exportFormat.toUpperCase()} browser download started; no native worktree receipt was created.`
        : "Download is unavailable in this preview; copy the visible export instead.",
    );
  };

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
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
    document.getElementById(`worktree-coordination-tab-${nextView}`)?.focus();
  };

  const claimRows = useMemo(() => {
    const rows = new Map<string, { readonly path: string; readonly claims: { readonly lane: WorktreeCoordinationLane; readonly claim: WorktreePathClaim }[] }>();
    for (const lane of LANES) {
      for (const claim of lane.claims) {
        const current = rows.get(claim.path);
        const nextClaims = [...(current?.claims ?? []), { lane, claim }];
        rows.set(claim.path, { path: claim.path, claims: nextClaims });
      }
    }
    return [...rows.values()].sort((left, right) => right.claims.length - left.claims.length || left.path.localeCompare(right.path));
  }, []);

  return (
    <section className="worktree-coordination-preview" aria-label="Worktree coordination preview">
      <header className="worktree-coordination-preview__header">
        <div>
          <span className="eyebrow"><Layers3 size={13} /> Agent Mesh · worktree boundary</span>
          <h2>Worktree coordination</h2>
          <p>Make proposed path ownership and overlapping writes visible before a native worktree or merge broker is allowed to act.</p>
        </div>
        <div className="worktree-coordination-preview__header-actions">
          <span className="worktree-coordination-preview__badge"><GitBranch size={12} /> Preview only</span>
          <button type="button" className="button button--ghost" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="worktree-coordination-export">
            <FileJson2 size={13} /> {exportOpen ? "Hide export" : "Export"}
          </button>
        </div>
      </header>

      <div className="worktree-coordination-preview__metrics" aria-label="Worktree coordination summary">
        <div><strong>{LANES.length}</strong><span>lane projections</span></div>
        <div><strong>{writeLaneCount}</strong><span>writer lanes</span></div>
        <div><strong>{sharedWriteClaims}</strong><span>shared writes held</span></div>
        <div><strong>{attentionCount}</strong><span>attention lanes</span></div>
        <div><strong>{readOnlyCount}</strong><span>read-only lanes</span></div>
      </div>

      <div className="worktree-coordination-preview__toolbar" role="toolbar" aria-label="Worktree coordination controls">
        <div className="worktree-coordination-preview__tabs" role="tablist" aria-label="Worktree coordination view" aria-orientation="horizontal">
          <button id="worktree-coordination-tab-lanes" type="button" role="tab" aria-selected={view === "lanes"} aria-controls="worktree-coordination-panel-lanes" tabIndex={view === "lanes" ? 0 : -1} className={view === "lanes" ? "is-active" : ""} onClick={() => setView("lanes")} onKeyDown={(event) => moveTab(event, 0)}><Network size={13} /> Lanes</button>
          <button id="worktree-coordination-tab-claims" type="button" role="tab" aria-selected={view === "claims"} aria-controls="worktree-coordination-panel-claims" tabIndex={view === "claims" ? 0 : -1} className={view === "claims" ? "is-active" : ""} onClick={() => setView("claims")} onKeyDown={(event) => moveTab(event, 1)}><FileCode2 size={13} /> Claims <span>{sharedWriteClaims}</span></button>
          <button id="worktree-coordination-tab-plan" type="button" role="tab" aria-selected={view === "plan"} aria-controls="worktree-coordination-panel-plan" tabIndex={view === "plan" ? 0 : -1} className={view === "plan" ? "is-active" : ""} onClick={() => setView("plan")} onKeyDown={(event) => moveTab(event, 2)}><GitMerge size={13} /> Plan</button>
        </div>
        <label className="worktree-coordination-preview__filter"><span>Focus</span><select aria-label="Worktree coordination focus" value={filter} onChange={(event) => setFilter(event.target.value as WorktreeCoordinationFilter)}><option value="all">All lanes</option><option value="attention">Attention only</option><option value="writers">Writer lanes</option><option value="read-only">Read-only lanes</option></select></label>
      </div>

      {exportOpen ? (
        <section id="worktree-coordination-export" className="worktree-coordination-preview__export" aria-label="Worktree coordination export preview">
          <header><div><span className="eyebrow"><Download size={12} /> Portable coordination view</span><h3>Export visible coordination evidence</h3></div><span className="worktree-coordination-preview__export-boundary">No durable write</span></header>
          <div className="worktree-coordination-preview__export-toolbar" role="toolbar" aria-label="Worktree coordination export actions">
            <label><span>Format</span><select aria-label="Worktree coordination export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as "json" | "markdown")}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
            <button type="button" className="button button--secondary" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button>
            <button type="button" className="button button--secondary" onClick={downloadExport}><Download size={13} /> Download</button>
          </div>
          <pre role="region" aria-label={`${exportFormat === "json" ? "JSON" : "Markdown"} worktree coordination export preview`}><code>{exportPayload}</code></pre>
          <p role="status" aria-live="polite">{exportStatus}</p>
        </section>
      ) : null}

      {view === "lanes" ? (
        <div id="worktree-coordination-panel-lanes" className="worktree-coordination-preview__body" role="tabpanel" aria-labelledby="worktree-coordination-tab-lanes" tabIndex={0}>
          <div className="worktree-coordination-preview__list" role="list" aria-label="Worktree coordination lanes">
            {visibleLanes.map((lane) => (
              <button type="button" key={lane.id} className={`worktree-coordination-preview__lane${selectedLane?.id === lane.id ? " is-selected" : ""}`} onClick={() => setSelectedId(lane.id)} aria-label={`${lane.label}. ${stateLabels[lane.state]}`}>
                <span className={`worktree-coordination-preview__lane-icon worktree-coordination-preview__lane-icon--${stateTone[lane.state]}`}>{lane.state === "attention" ? <CircleAlert size={14} /> : lane.state === "isolated" ? <LockKeyhole size={14} /> : lane.state === "shared-read" ? <Layers3 size={14} /> : <CheckCircle2 size={14} />}</span>
                <span className="worktree-coordination-preview__lane-copy"><strong>{lane.label}</strong><small>{lane.agent} · {lane.claims.filter((claim) => claim.mode === "write").length} write claim{lane.claims.filter((claim) => claim.mode === "write").length === 1 ? "" : "s"}</small></span>
                <span className={`worktree-coordination-preview__state worktree-coordination-preview__state--${stateTone[lane.state]}`}>{stateLabels[lane.state]}</span>
              </button>
            ))}
            {visibleLanes.length === 0 ? <p className="worktree-coordination-preview__empty">No lanes match this focus.</p> : null}
          </div>
          <aside className="worktree-coordination-preview__detail" aria-label="Selected worktree lane">
            {selectedLane ? (
              <>
                <div className="worktree-coordination-preview__detail-heading"><span className={`worktree-coordination-preview__state worktree-coordination-preview__state--${stateTone[selectedLane.state]}`}>{selectedLane.state === "attention" ? <CircleAlert size={13} /> : <GitBranch size={13} />} {stateLabels[selectedLane.state]}</span><code>{selectedLane.id}</code></div>
                <h3>{selectedLane.label}</h3>
                <p>{selectedLane.summary}</p>
                <dl className="worktree-coordination-preview__facts"><div><dt>Agent</dt><dd>{selectedLane.agent}</dd></div><div><dt>Proposed branch label</dt><dd><code>{selectedLane.branchLabel}</code></dd></div><div><dt>Base snapshot</dt><dd>{selectedLane.baseRevision}</dd></div><div><dt>Claims</dt><dd>{selectedLane.claims.length} visible</dd></div></dl>
                <div className="worktree-coordination-preview__claim-list" aria-label="Selected lane path claims">{selectedLane.claims.map((claim) => <div key={`${selectedLane.id}:${claim.path}`}><span className={`worktree-coordination-preview__claim-mode worktree-coordination-preview__claim-mode--${claim.mode}`}>{claim.mode}</span><code>{formatClaim(claim)}</code><small>{claim.ownership} · {claim.evidence}</small></div>)}</div>
                <div className="worktree-coordination-preview__actions"><button type="button" className="button button--secondary" onClick={() => previewAction(`Compared claims for ${selectedLane.label}.`)}><GitMerge size={13} /> Compare claims</button><button type="button" className="button button--secondary" onClick={() => previewAction(`Prepared handoff for ${selectedLane.label}.`)}><ArrowRight size={13} /> Prepare handoff</button><button type="button" className="button button--ghost" onClick={() => previewAction(`Reset preview hold for ${selectedLane.label}.`)}><RotateCcw size={13} /> Reset hold</button></div>
                <p className="worktree-coordination-preview__signal"><Info size={13} /> {selectedLane.lastSignal}</p>
              </>
            ) : <p className="worktree-coordination-preview__empty">Select a lane to inspect its proposed ownership.</p>}
          </aside>
        </div>
      ) : null}

      {view === "claims" ? (
        <div id="worktree-coordination-panel-claims" className="worktree-coordination-preview__claims" role="tabpanel" aria-labelledby="worktree-coordination-tab-claims" tabIndex={0}>
          <header><div><span className="eyebrow"><FileCode2 size={13} /> Resource ledger</span><h3>Overlapping path claims</h3></div><span className="worktree-coordination-preview__state worktree-coordination-preview__state--attention">Shared writes stay held</span></header>
          <div className="worktree-coordination-preview__claim-rows" role="list" aria-label="Worktree path claim ledger">
            {claimRows.map((row) => {
              const hasSharedWrite = row.claims.some(({ claim }) => claim.mode === "write" && claim.ownership === "shared");
              return <article key={row.path} className={`worktree-coordination-preview__claim-row${hasSharedWrite ? " is-conflict" : ""}`} role="listitem"><div><code>{row.path}</code><small>{row.claims.length} lane{row.claims.length === 1 ? "" : "s"} · {hasSharedWrite ? "conflict gate" : "no shared write"}</small></div><div>{row.claims.map(({ lane, claim }) => <span key={`${lane.id}:${claim.mode}`} className={`worktree-coordination-preview__claim-pill worktree-coordination-preview__claim-pill--${claim.mode}`}>{lane.label} · {claim.mode}</span>)}</div></article>;
            })}
          </div>
          <p className="worktree-coordination-preview__boundary"><ShieldCheck size={13} /> Shared reads may overlap in the target contract. Shared writes are surfaced as a conflict gate and never treated as synchronized by this preview.</p>
        </div>
      ) : null}

      {view === "plan" ? (
        <div id="worktree-coordination-panel-plan" className="worktree-coordination-preview__plan" role="tabpanel" aria-labelledby="worktree-coordination-tab-plan" tabIndex={0}>
          <header><div><span className="eyebrow"><GitMerge size={13} /> Ordered handoff rehearsal</span><h3>{selectedLane ? `Plan for ${selectedLane.label}` : "No lane selected"}</h3></div><span className="worktree-coordination-preview__state worktree-coordination-preview__state--review">No native execution</span></header>
          {selectedLane ? <ol>{[
            `Freeze the visible ${selectedLane.claims.length} path claim${selectedLane.claims.length === 1 ? "" : "s"} for ${selectedLane.label}.`,
            "Compare shared paths against every other visible lane before any writer is promoted.",
            "Require a native worktree, lease, and expected-hash receipt before writing or merging.",
            "Route the resulting handoff to the fixed parent run; do not retarget output from the active UI.",
          ].map((step) => <li key={step}><span><CheckCircle2 size={13} /></span><div><strong>{step}</strong><small>Preview step · not dispatched</small></div></li>)}</ol> : <p className="worktree-coordination-preview__empty">Select a lane from the Lanes view first.</p>}
          <p className="worktree-coordination-preview__boundary"><LockKeyhole size={13} /> This plan does not create a branch, lock a file, start a process, merge a worktree, or persist a handoff.</p>
        </div>
      ) : null}

      <p className="worktree-coordination-preview__status" role="status" aria-live="polite">{announcement}</p>
      <p className="worktree-coordination-preview__boundary"><Info size={14} /><span>Renderer-local worktree coordination preview. It does not read or write the filesystem, invoke Git, create worktrees, acquire leases, dispatch agents, merge branches, or create a durable receipt. {linkedWorkCount ? `${linkedWorkCount} background item${linkedWorkCount === 1 ? "" : "s"} are linked as renderer input.` : "No native background projection is linked."}</span></p>
    </section>
  );
}

export { LANES as WORKTREE_COORDINATION_LANES };
