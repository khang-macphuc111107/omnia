import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Clipboard,
  Clock3,
  Download,
  FileCheck2,
  GitBranch,
  Info,
  Link2,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { ConversationView, ProjectView } from "./types";

export type ProjectTwinEdgeType =
  | "contains"
  | "scopes"
  | "references"
  | "verified_by"
  | "stale_due_to"
  | "depends_on";

export type ProjectTwinEvidenceClass =
  | "source_fact"
  | "static_analysis"
  | "runtime"
  | "test"
  | "screenshot"
  | "audit"
  | "user_annotation"
  | "ai_interpretation"
  | "inference";

export type ProjectTwinEdgeState = "current" | "stale" | "unknown" | "inferred";

export interface ProjectTwinEdgeNodePreview {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
}

interface ProjectTwinEdgeEvidencePreviewBase {
  readonly id: string;
  readonly type: ProjectTwinEdgeType;
  readonly source: ProjectTwinEdgeNodePreview;
  readonly target: ProjectTwinEdgeNodePreview;
  readonly provenance: string;
  readonly evidenceClass: ProjectTwinEvidenceClass;
  readonly evidenceId: string | null;
  readonly sourceSnapshot: string;
  readonly sourceRevision: string;
  readonly state: ProjectTwinEdgeState;
  readonly staleReason: string | null;
  readonly createdAt: string;
}

/**
 * Canonical Twin confidence is meaningful only for explicitly inferred edges.
 * Keeping this as a discriminated union prevents preview fixtures from
 * accidentally attaching a probability to a deterministic/source-backed
 * relationship.
 */
export type ProjectTwinEdgeEvidencePreview =
  | (ProjectTwinEdgeEvidencePreviewBase & {
      readonly evidenceClass: "inference";
      readonly confidence: number;
    })
  | (ProjectTwinEdgeEvidencePreviewBase & {
      readonly evidenceClass: Exclude<ProjectTwinEvidenceClass, "inference">;
      readonly confidence: null;
    });

type EdgeFilter = "all" | ProjectTwinEdgeType;
type EvidenceFilter = "all" | ProjectTwinEvidenceClass;
type StateFilter = "all" | ProjectTwinEdgeState;
type ExportFormat = "json" | "markdown";

const EDGE_TYPE_LABELS: Record<ProjectTwinEdgeType, string> = {
  contains: "Contains",
  scopes: "Scopes",
  references: "References",
  verified_by: "Verified by",
  stale_due_to: "Stale due to",
  depends_on: "Depends on",
};

const EVIDENCE_LABELS: Record<ProjectTwinEvidenceClass, string> = {
  source_fact: "Source fact",
  static_analysis: "Static analysis",
  runtime: "Runtime",
  test: "Deterministic test",
  screenshot: "Screenshot",
  audit: "Audit",
  user_annotation: "User annotation",
  ai_interpretation: "AI interpretation",
  inference: "Inference",
};

const STATE_LABELS: Record<ProjectTwinEdgeState, string> = {
  current: "Current",
  stale: "Stale",
  unknown: "Unknown",
  inferred: "Inferred",
};

const EDGE_TYPE_OPTIONS: readonly EdgeFilter[] = [
  "all",
  "contains",
  "scopes",
  "references",
  "verified_by",
  "stale_due_to",
  "depends_on",
];

const EVIDENCE_OPTIONS: readonly EvidenceFilter[] = [
  "all",
  "source_fact",
  "static_analysis",
  "runtime",
  "test",
  "screenshot",
  "audit",
  "user_annotation",
  "ai_interpretation",
  "inference",
];

const STATE_OPTIONS: readonly StateFilter[] = ["all", "current", "stale", "unknown", "inferred"];

function seedEdges(
  project: Pick<ProjectView, "id" | "name" | "folders">,
  conversations: readonly Pick<ConversationView, "id" | "title">[],
): ProjectTwinEdgeEvidencePreview[] {
  const projectNode = { id: `project:${project.id}`, label: project.name, kind: "project" } as const;
  const firstChat = conversations[0];
  const chatNode = firstChat
    ? { id: `chat:${firstChat.id}`, label: firstChat.title, kind: "chat" }
    : { id: `chat:${project.id}:preview`, label: "Project chat preview", kind: "chat" };
  const workspaceNode = {
    id: `workspace:${project.id}`,
    label: `${project.folders.length} workspace grant${project.folders.length === 1 ? "" : "s"}`,
    kind: "workspace",
  } as const;
  const contextNode = { id: `context:${project.id}`, label: "Context manifest preview", kind: "context" } as const;
  const evidenceNode = { id: "evidence:renderer-project-deck", label: "Project deck focused tests", kind: "evidence" } as const;
  const sourceNode = { id: "source:project-control-deck", label: "Project Control Deck source", kind: "source" } as const;

  return [
    {
      id: `edge:${project.id}:contains-chat`,
      type: "contains",
      source: projectNode,
      target: chatNode,
      provenance: "Project / Chat ownership projection",
      evidenceClass: "source_fact",
      evidenceId: null,
      sourceSnapshot: "browser-seeded-preview",
      sourceRevision: "renderer-session-unknown",
      state: "unknown",
      staleReason: "No native Project Twin revision has been hydrated.",
      confidence: null,
      createdAt: "2026-09-19T09:00:00Z",
    },
    {
      id: `edge:${project.id}:scopes-workspace`,
      type: "scopes",
      source: projectNode,
      target: workspaceNode,
      provenance: "Workspace grant projection",
      evidenceClass: "source_fact",
      evidenceId: null,
      sourceSnapshot: "browser-seeded-preview",
      sourceRevision: "renderer-session-unknown",
      // Folder data is renderer input here, not a native grant receipt. Keep
      // the edge unknown even when the fixture contains folders so the status
      // summary cannot promote preview data to canonical Twin truth.
      state: "unknown",
      staleReason: project.folders.length > 0
        ? "Workspace folders are renderer input; no native grant receipt or Twin revision has been hydrated."
        : "No workspace grant is present in this preview.",
      confidence: null,
      createdAt: "2026-09-19T09:01:00Z",
    },
    {
      id: `edge:${project.id}:references-context`,
      type: "references",
      source: chatNode,
      target: contextNode,
      provenance: "Context manifest selection rehearsal",
      // This is an explicitly inferred relationship. Keep the evidence class
      // aligned with the canonical Twin rule that inferred edges carry the
      // `inference` class and an explicit confidence value.
      evidenceClass: "inference",
      evidenceId: null,
      sourceSnapshot: "renderer-context-selection",
      sourceRevision: "context-preview-v1",
      state: "inferred",
      staleReason: "The renderer has not compiled or persisted a native context revision.",
      confidence: 0.72,
      createdAt: "2026-09-19T09:02:00Z",
    },
    {
      id: `edge:${project.id}:verified-by-tests`,
      type: "verified_by",
      source: projectNode,
      target: evidenceNode,
      provenance: "Focused renderer regression receipt",
      evidenceClass: "test",
      evidenceId: "project-control-deck.test.tsx",
      sourceSnapshot: "renderer-test-snapshot",
      sourceRevision: "phase4-ui-preview",
      state: "current",
      staleReason: null,
      // Confidence is reserved for inference edges in the canonical Twin
      // schema; a deterministic test receipt has evidence class authority
      // instead of a probabilistic confidence score.
      confidence: null,
      createdAt: "2026-09-19T09:03:00Z",
    },
    {
      id: `edge:${project.id}:stale-source`,
      type: "stale_due_to",
      source: contextNode,
      target: sourceNode,
      provenance: "Source/projection freshness rehearsal",
      evidenceClass: "audit",
      evidenceId: "project-twin-spec-audit",
      sourceSnapshot: "audit-snapshot-2026-09-19",
      sourceRevision: "twin-partial-catalog",
      state: "stale",
      staleReason: "Generated Twin artifacts may lag the current source tree until regenerated.",
      confidence: null,
      createdAt: "2026-09-19T09:04:00Z",
    },
    {
      id: `edge:${project.id}:context-dependency`,
      type: "depends_on",
      source: contextNode,
      target: workspaceNode,
      provenance: "Context admission dependency map",
      evidenceClass: "inference",
      evidenceId: null,
      sourceSnapshot: "renderer-context-selection",
      sourceRevision: "context-preview-v1",
      state: "inferred",
      staleReason: "Dependency is inferred from the selected preview inputs, not a native graph edge.",
      confidence: 0.64,
      createdAt: "2026-09-19T09:05:00Z",
    },
  ];
}

function edgeExportPayload(
  project: Pick<ProjectView, "id" | "name">,
  edges: readonly ProjectTwinEdgeEvidencePreview[],
  format: ExportFormat,
): string {
  const evidenceReferences = edges.filter((edge) => edge.evidenceId !== null).length;
  const payload = {
    schema: "omnia.project-twin-edge-evidence.preview.v1",
    scope: "renderer-session",
    authority: "renderer-projection",
    project: { id: project.id, name: project.name },
    revision: "renderer-session-unknown",
    canonicalTwinRevision: null,
    nativeEvidenceReceipts: 0,
    coverage: {
      edgeCount: edges.length,
      evidenceReferences,
      nativeEvidenceReceipts: 0,
    },
    edges,
    boundary: "Preview projection only; no canonical Twin mutation, native evidence receipt, or durable write was performed.",
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    `# ${project.name} · Project Twin edge preview`,
    "",
    "> Renderer-local preview only; this is not an authoritative Project Twin revision.",
    "",
    `- Edges: ${edges.length}`,
    `- Current: ${edges.filter((edge) => edge.state === "current").length}`,
    `- Stale: ${edges.filter((edge) => edge.state === "stale").length}`,
    `- Inferred: ${edges.filter((edge) => edge.state === "inferred").length}`,
    `- Unknown: ${edges.filter((edge) => edge.state === "unknown").length}`,
    `- Evidence references: ${evidenceReferences}`,
    "- Authority: renderer projection (canonical Twin revision unavailable)",
    "",
    ...edges.map((edge) => [
      `- ${edge.source.label} —${EDGE_TYPE_LABELS[edge.type]}→ ${edge.target.label}`,
      `  - Edge: ${edge.id}`,
      `  - Evidence: ${EVIDENCE_LABELS[edge.evidenceClass]}${edge.evidenceId ? ` (${edge.evidenceId})` : " (not attached)"}`,
      `  - State: ${STATE_LABELS[edge.state]}`,
      `  - Snapshot: ${edge.sourceSnapshot}`,
      `  - Revision: ${edge.sourceRevision}`,
      `  - Confidence: ${edge.confidence === null ? "not applicable" : `${Math.round(edge.confidence * 100)}%`}`,
      `  - Provenance: ${edge.provenance}`,
      ...(edge.staleReason ? [`  - Freshness note: ${edge.staleReason}`] : []),
    ].join("\n")),
    "",
    "No canonical graph mutation, native evidence receipt, or durable write was performed.",
  ].join("\n");
}

function downloadPreview(payload: string, format: ExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-project-twin-edge-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function stateIcon(state: ProjectTwinEdgeState) {
  if (state === "current") return <CheckCircle2 size={14} aria-hidden="true" />;
  if (state === "stale") return <AlertTriangle size={14} aria-hidden="true" />;
  if (state === "inferred") return <Sparkles size={14} aria-hidden="true" />;
  return <Info size={14} aria-hidden="true" />;
}

export function ProjectTwinEdgeEvidencePreview({
  project,
  conversations = [],
  edges,
}: {
  readonly project: Pick<ProjectView, "id" | "name" | "folders">;
  readonly conversations?: readonly Pick<ConversationView, "id" | "title">[];
  readonly edges?: readonly ProjectTwinEdgeEvidencePreview[];
}) {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<EdgeFilter>("all");
  const [evidenceFilter, setEvidenceFilter] = useState<EvidenceFilter>("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("json");
  const [status, setStatus] = useState("Twin edges are a renderer-local evidence rehearsal.");

  const allEdges = useMemo(
    () => (edges ? [...edges] : seedEdges(project, conversations)),
    [conversations, edges, project],
  );
  const visibleEdges = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return allEdges.filter((edge) => {
      if (typeFilter !== "all" && edge.type !== typeFilter) return false;
      if (evidenceFilter !== "all" && edge.evidenceClass !== evidenceFilter) return false;
      if (stateFilter !== "all" && edge.state !== stateFilter) return false;
      if (!normalizedQuery) return true;
      return [edge.id, edge.source.id, edge.source.label, edge.target.id, edge.target.label, edge.provenance, edge.evidenceId ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [allEdges, evidenceFilter, query, stateFilter, typeFilter]);
  const selectedEdge = visibleEdges.find((edge) => edge.id === selectedId) ?? visibleEdges[0] ?? null;
  const exportPayload = useMemo(() => edgeExportPayload(project, visibleEdges, format), [format, project, visibleEdges]);
  const counts = useMemo(
    () => ({
      total: allEdges.length,
      current: allEdges.filter((edge) => edge.state === "current").length,
      stale: allEdges.filter((edge) => edge.state === "stale").length,
      inferred: allEdges.filter((edge) => edge.state === "inferred").length,
      unknown: allEdges.filter((edge) => edge.state === "unknown").length,
      evidenceReferences: allEdges.filter((edge) => edge.evidenceId !== null).length,
    }),
    [allEdges],
  );

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no Twin edge preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatus(`Copied ${visibleEdges.length} filtered Twin edge${visibleEdges.length === 1 ? "" : "s"} as ${format.toUpperCase()}.`);
    } catch {
      setStatus("Clipboard access was denied; no Twin edge preview was copied.");
    }
  };

  return (
    <section className="project-twin-edge-preview" aria-labelledby="project-twin-edge-preview-title">
      <header className="project-twin-edge-preview__header">
        <span className="project-twin-edge-preview__icon"><Boxes size={18} /></span>
        <div>
          <span className="eyebrow">Project Twin · graph rehearsal</span>
          <h2 id="project-twin-edge-preview-title">Edges & evidence</h2>
          <p>Inspect ownership, dependencies, freshness, and evidence lineage without treating the renderer projection as canonical Twin truth.</p>
        </div>
        <span className="project-twin-edge-preview__badge"><ShieldCheck size={13} /> Preview only</span>
      </header>

      <div className="project-twin-edge-preview__summary" role="status" aria-live="polite">
        <article><Link2 size={14} /><span>Edges</span><strong>{counts.total}</strong></article>
        <article><CheckCircle2 size={14} /><span>Current</span><strong>{counts.current}</strong></article>
        <article><AlertTriangle size={14} /><span>Stale</span><strong>{counts.stale}</strong></article>
        <article><Sparkles size={14} /><span>Inferred</span><strong>{counts.inferred}</strong></article>
        <article><Info size={14} /><span>Unknown</span><strong>{counts.unknown}</strong></article>
      </div>

      <div className="project-twin-edge-preview__authority" role="note">
        <ShieldCheck size={14} aria-hidden="true" />
        <span><strong>Canonicality: preview projection</strong> {counts.evidenceReferences} evidence reference{counts.evidenceReferences === 1 ? "" : "s"} are attached as metadata; native evidence receipts and a durable Project Twin revision are not hydrated.</span>
        <em>0 native receipts</em>
      </div>

      <div className="project-twin-edge-preview__filters" role="toolbar" aria-label="Project Twin edge filters">
        <label className="project-twin-edge-preview__search"><Search size={14} /><span className="sr-only">Search Twin edges</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search nodes, provenance, or evidence" /></label>
        <label><span>Edge</span><select aria-label="Twin edge type filter" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as EdgeFilter)}>{EDGE_TYPE_OPTIONS.map((value) => <option key={value} value={value}>{value === "all" ? "All edge types" : EDGE_TYPE_LABELS[value]}</option>)}</select></label>
        <label><span>Evidence</span><select aria-label="Twin evidence class filter" value={evidenceFilter} onChange={(event) => setEvidenceFilter(event.target.value as EvidenceFilter)}>{EVIDENCE_OPTIONS.map((value) => <option key={value} value={value}>{value === "all" ? "All evidence" : EVIDENCE_LABELS[value]}</option>)}</select></label>
        <label><span>State</span><select aria-label="Twin edge state filter" value={stateFilter} onChange={(event) => setStateFilter(event.target.value as StateFilter)}>{STATE_OPTIONS.map((value) => <option key={value} value={value}>{value === "all" ? "All states" : STATE_LABELS[value]}</option>)}</select></label>
        <button type="button" className="button button--ghost" onClick={() => { setQuery(""); setTypeFilter("all"); setEvidenceFilter("all"); setStateFilter("all"); setSelectedId(null); setStatus("Twin edge filters reset for this renderer session."); }}><SlidersHorizontal size={13} /> Reset</button>
      </div>

      <div className="project-twin-edge-preview__body">
        <div className="project-twin-edge-preview__list" role="list" aria-label="Project Twin preview edges">
          {visibleEdges.length > 0 ? visibleEdges.map((edge) => (
            <button key={edge.id} type="button" className={`project-twin-edge-preview__row${selectedEdge?.id === edge.id ? " is-selected" : ""}`} aria-pressed={selectedEdge?.id === edge.id} onClick={() => setSelectedId(edge.id)}>
              <span className={`project-twin-edge-preview__state project-twin-edge-preview__state--${edge.state}`}>{stateIcon(edge.state)}<span>{STATE_LABELS[edge.state]}</span></span>
              <span className="project-twin-edge-preview__edge-copy"><strong>{edge.source.label} <em>—{EDGE_TYPE_LABELS[edge.type]}→</em> {edge.target.label}</strong><small>{EVIDENCE_LABELS[edge.evidenceClass]} · {edge.sourceSnapshot} · {edge.provenance}</small></span>
              <GitBranch size={14} aria-hidden="true" />
            </button>
          )) : <div className="project-twin-edge-preview__empty"><Link2 size={20} /><strong>No matching Twin edges</strong><small>Try another filter; no canonical graph state has been changed.</small></div>}
        </div>

        <aside className="project-twin-edge-preview__detail" aria-label="Selected Project Twin edge">
          {selectedEdge ? <>
            <div className="project-twin-edge-preview__detail-heading"><div><span className="eyebrow">Selected edge</span><h3>{EDGE_TYPE_LABELS[selectedEdge.type]}</h3></div><span className={`project-twin-edge-preview__detail-state project-twin-edge-preview__detail-state--${selectedEdge.state}`}>{stateIcon(selectedEdge.state)} {STATE_LABELS[selectedEdge.state]}</span></div>
            <p className="project-twin-edge-preview__relation"><strong>{selectedEdge.source.label}</strong><span>→</span><strong>{selectedEdge.target.label}</strong></p>
            <dl>
              <div><dt>Edge id</dt><dd>{selectedEdge.id}</dd></div>
              <div><dt>Node kinds</dt><dd>{selectedEdge.source.kind} → {selectedEdge.target.kind}</dd></div>
              <div><dt>Evidence class</dt><dd>{EVIDENCE_LABELS[selectedEdge.evidenceClass]}</dd></div>
              <div><dt>Evidence id</dt><dd>{selectedEdge.evidenceId ?? "Not attached"}</dd></div>
              <div><dt>Source snapshot</dt><dd>{selectedEdge.sourceSnapshot}</dd></div>
              <div><dt>Source revision</dt><dd>{selectedEdge.sourceRevision}</dd></div>
              <div><dt>Confidence</dt><dd>{selectedEdge.confidence === null ? "Not applicable" : `${Math.round(selectedEdge.confidence * 100)}%`}</dd></div>
              <div><dt>Created</dt><dd>{selectedEdge.createdAt}</dd></div>
            </dl>
            <p className="project-twin-edge-preview__provenance"><FileCheck2 size={13} /><span><strong>Provenance</strong>{selectedEdge.provenance}</span></p>
            {selectedEdge.staleReason ? <p className="project-twin-edge-preview__stale"><AlertTriangle size={13} /><span><strong>{selectedEdge.state === "stale" ? "Stale reason" : "Boundary note"}</strong>{selectedEdge.staleReason}</span></p> : null}
          </> : <div className="project-twin-edge-preview__empty"><Link2 size={20} /><strong>Select an edge</strong><small>Its source snapshot, evidence class, and freshness details will appear here.</small></div>}
        </aside>
      </div>

      <div className="project-twin-edge-preview__export-toolbar" role="toolbar" aria-label="Project Twin edge export">
        <span role="status" aria-live="polite">{status}</span>
        <button type="button" className="button button--secondary" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="project-twin-edge-export-preview"><Download size={13} /> {exportOpen ? "Hide export" : "Preview export"}</button>
      </div>

      {exportOpen ? <section id="project-twin-edge-export-preview" className="project-twin-edge-preview__export" aria-label="Project Twin edge export preview">
        <header><div><span className="eyebrow">Portable projection</span><h3>{visibleEdges.length} filtered edge{visibleEdges.length === 1 ? "" : "s"}</h3></div><span className="project-twin-edge-preview__export-chip">No durable write</span></header>
        <div className="project-twin-edge-preview__export-actions"><label><span>Format</span><select aria-label="Twin edge export format" value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={() => setStatus(downloadPreview(exportPayload, format) ? "Downloaded a renderer-local Twin edge projection." : "File download is unavailable; nothing was exported.")}><Download size={13} /> Download</button></div>
        <pre tabIndex={0}><code>{exportPayload}</code></pre>
        <p className="project-twin-edge-preview__boundary"><ShieldCheck size={13} /> Export includes typed preview edges only. It does not create a Twin revision, verify evidence, or write to native storage.</p>
      </section> : null}

      <p className="project-twin-edge-preview__footer"><Clock3 size={13} /> Source snapshot, revision, evidence class, stale state, and confidence are shown as rehearsal metadata. Native graph authority, durable revision acceptance, and cross-restart persistence remain unavailable in this surface.</p>
    </section>
  );
}

export default ProjectTwinEdgeEvidencePreview;
