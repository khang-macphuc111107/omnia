import {
  Archive,
  ArrowDown,
  CheckCircle2,
  Clipboard,
  CircleAlert,
  Database,
  Download,
  FileCheck2,
  FileJson2,
  Filter,
  GitBranch,
  History,
  Link2,
  LockKeyhole,
  Search,
  ShieldCheck,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

export type LineageNodeKind = "source" | "transform" | "artifact" | "evaluation";
export type LineageNodeStatus = "available" | "review" | "blocked" | "planned";
export type LineageEdgeKind = "derived" | "normalized" | "filtered" | "evaluated" | "supersedes";
export type LineageEdgeStatus = "observed" | "preview" | "missing";
export type LineageSensitivity = "low" | "moderate" | "high" | "restricted";
export type DataLineageExportFormat = "json" | "markdown";
export type DataLineageExportPresetId = "all-visible" | "review-queue" | "selected-neighborhood" | "evidence-gaps";
export type DataLineageEvidenceStrength = "strong" | "partial" | "missing";
export type DataLineageEvidenceReview = "unreviewed" | "reviewed";

export type DataLineageExportPreset = {
  id: DataLineageExportPresetId;
  label: string;
  description: string;
};

export const DATA_LINEAGE_EXPORT_PRESETS: readonly DataLineageExportPreset[] = [
  { id: "all-visible", label: "Current filtered graph", description: "Export every node and edge currently visible in the graph." },
  { id: "review-queue", label: "Review queue", description: "Keep records that are awaiting review, blocked, or planned." },
  { id: "selected-neighborhood", label: "Selected neighborhood", description: "Export the selected record and its directly connected edges." },
  { id: "evidence-gaps", label: "Evidence gaps", description: "Focus on preview or missing edges that need a supporting receipt." },
];
const DEFAULT_DATA_LINEAGE_EXPORT_PRESET = DATA_LINEAGE_EXPORT_PRESETS[0]!;

export type DataLineageNode = {
  id: string;
  kind: LineageNodeKind;
  title: string;
  subtitle: string;
  description: string;
  provenance: string;
  contentHash: string | null;
  mimeType: string;
  sensitivity: LineageSensitivity;
  retention: "session" | "7-days" | "30-days" | "manual";
  status: LineageNodeStatus;
  metadata: ReadonlyArray<{ label: string; value: string }>;
};

export type DataLineageEdge = {
  id: string;
  from: string;
  to: string;
  kind: LineageEdgeKind;
  label: string;
  evidence: string;
  status: LineageEdgeStatus;
};

export type DataLineageEvidenceRecord = DataLineageEdge & {
  sourceTitle: string;
  targetTitle: string;
  strength: DataLineageEvidenceStrength;
  review: DataLineageEvidenceReview;
  reviewReason: string;
};

const kindLabels: Record<LineageNodeKind, string> = {
  source: "Sources",
  transform: "Transformations",
  artifact: "Artifacts",
  evaluation: "Evaluations",
};

const statusLabels: Record<LineageNodeStatus, string> = {
  available: "Available",
  review: "Needs review",
  blocked: "Blocked",
  planned: "Planned",
};

const edgeKindLabels: Record<LineageEdgeKind, string> = {
  derived: "Derived",
  normalized: "Normalized",
  filtered: "Filtered",
  evaluated: "Evaluated",
  supersedes: "Supersedes",
};

const edgeStatusLabels: Record<LineageEdgeStatus, string> = {
  observed: "Observed",
  preview: "Preview edge",
  missing: "Missing evidence",
};

const evidenceStrengthLabels: Record<DataLineageEvidenceStrength, string> = {
  strong: "Observed evidence",
  partial: "Preview evidence",
  missing: "Missing evidence",
};

const evidenceReviewLabels: Record<DataLineageEvidenceReview, string> = {
  unreviewed: "Needs review",
  reviewed: "Reviewed in session",
};

export const seedDataLineageNodes: readonly DataLineageNode[] = [
  {
    id: "lineage-source-feedback",
    kind: "source",
    title: "Helpful answer signal",
    subtitle: "Message feedback · renderer snapshot",
    description: "A labeled feedback event that can be reviewed as a quality example.",
    provenance: "Data intake record intake-feedback-001",
    contentHash: "preview:feedback-001",
    mimeType: "application/json",
    sensitivity: "low",
    retention: "30-days",
    status: "available",
    metadata: [
      { label: "Fields", value: "rating · reason · message revision" },
      { label: "Consent", value: "Approved in preview" },
      { label: "Source revision", value: "Renderer snapshot" },
    ],
  },
  {
    id: "lineage-source-correction",
    kind: "source",
    title: "Correction and user rewrite",
    subtitle: "Follow-up feedback · renderer snapshot",
    description: "A correction signal that needs review before it is used in a quality slice.",
    provenance: "Data intake record intake-feedback-002",
    contentHash: "preview:feedback-002",
    mimeType: "application/json",
    sensitivity: "moderate",
    retention: "30-days",
    status: "review",
    metadata: [
      { label: "Fields", value: "rating · correction excerpt · message revision" },
      { label: "Consent", value: "Approved in preview" },
      { label: "Review gate", value: "Assumptions need a reviewer" },
    ],
  },
  {
    id: "lineage-source-memory",
    kind: "source",
    title: "UI-first workflow preference",
    subtitle: "Memory proposal · renderer snapshot",
    description: "A high-sensitivity proposal held behind an explicit consent gate.",
    provenance: "Data intake record intake-memory-001",
    contentHash: "preview:memory-001",
    mimeType: "application/json",
    sensitivity: "high",
    retention: "manual",
    status: "blocked",
    metadata: [
      { label: "Fields", value: "proposal text · scope · matching signals" },
      { label: "Consent", value: "Pending review" },
      { label: "Eligibility", value: "Excluded until consent" },
    ],
  },
  {
    id: "lineage-source-run",
    kind: "source",
    title: "Renderer run outcome",
    subtitle: "Run projection · no provider receipt",
    description: "An outcome marker that preserves the distinction between a preview and a provider observation.",
    provenance: "Data intake record intake-run-001",
    contentHash: "preview:run-001",
    mimeType: "application/json",
    sensitivity: "low",
    retention: "7-days",
    status: "available",
    metadata: [
      { label: "Fields", value: "status · stage · preview timestamp" },
      { label: "Provider receipt", value: "Unavailable" },
      { label: "Usage", value: "Unknown, not zero" },
    ],
  },
  {
    id: "lineage-transform-redact",
    kind: "transform",
    title: "Redaction policy",
    subtitle: "Mask sensitive fields",
    description: "A deterministic preview step that marks sensitive fields for masking before review.",
    provenance: "Data intake policy · renderer-local",
    contentHash: "preview:transform-redact",
    mimeType: "application/json",
    sensitivity: "moderate",
    retention: "session",
    status: "available",
    metadata: [
      { label: "Policy", value: "Mask sensitive fields" },
      { label: "Input", value: "Source candidates" },
      { label: "Output", value: "Redacted review candidates" },
    ],
  },
  {
    id: "lineage-transform-consent",
    kind: "transform",
    title: "Consent and eligibility gate",
    subtitle: "Fail-closed policy decision",
    description: "Excludes pending, declined, restricted, or otherwise ineligible records from the next preview batch.",
    provenance: "Learning review policy · renderer-local",
    contentHash: "preview:transform-consent",
    mimeType: "application/json",
    sensitivity: "moderate",
    retention: "session",
    status: "review",
    metadata: [
      { label: "Inputs", value: "Consent · sensitivity · status" },
      { label: "Blocked", value: "Memory proposal · restricted import" },
      { label: "Authority", value: "No native approval receipt" },
    ],
  },
  {
    id: "lineage-transform-normalize",
    kind: "transform",
    title: "Review schema normalization",
    subtitle: "Normalize portable fields",
    description: "Maps source records into a bounded review schema without claiming a durable dataset write.",
    provenance: "Data intake schema · omnia.data-intake-learning-review.v1",
    contentHash: "preview:transform-normalize",
    mimeType: "application/json",
    sensitivity: "low",
    retention: "session",
    status: "available",
    metadata: [
      { label: "Schema", value: "data-intake-learning-review.v1" },
      { label: "Fields", value: "source · purpose · evidence · retention" },
      { label: "Write mode", value: "No durable write" },
    ],
  },
  {
    id: "lineage-artifact-review-batch",
    kind: "artifact",
    title: "Quality review batch",
    subtitle: "Renderer-local candidate set",
    description: "A bounded set of eligible examples ready for a rubric preview.",
    provenance: "Learning review batch · renderer-session",
    contentHash: "preview:artifact-review-batch",
    mimeType: "application/json",
    sensitivity: "moderate",
    retention: "session",
    status: "available",
    metadata: [
      { label: "Examples", value: "3 eligible preview records" },
      { label: "Objective", value: "Answer quality" },
      { label: "Model weights", value: "Not changed" },
    ],
  },
  {
    id: "lineage-artifact-masked",
    kind: "artifact",
    title: "Masked candidate projection",
    subtitle: "Sensitive-field derivative",
    description: "A renderer projection that keeps the original source visible while showing the masked derivative.",
    provenance: "Redaction policy · renderer-session",
    contentHash: "preview:artifact-masked",
    mimeType: "application/json",
    sensitivity: "low",
    retention: "session",
    status: "review",
    metadata: [
      { label: "Original", value: "Preserved in lineage preview" },
      { label: "Derivative", value: "Mask sensitive fields" },
      { label: "Promotion", value: "Requires review" },
    ],
  },
  {
    id: "lineage-evaluation-quality",
    kind: "evaluation",
    title: "Quality rubric checkpoint",
    subtitle: "Deterministic score rehearsal",
    description: "A rubric preview that compares labeled examples; it does not call a model or train weights.",
    provenance: "Model Evaluation Studio · renderer-local",
    contentHash: "preview:evaluation-quality",
    mimeType: "application/json",
    sensitivity: "low",
    retention: "session",
    status: "planned",
    metadata: [
      { label: "Rubric", value: "Accuracy · completeness · actionability" },
      { label: "Score source", value: "Synthetic renderer projection" },
      { label: "Runtime", value: "No provider request" },
    ],
  },
];

export const seedDataLineageEdges: readonly DataLineageEdge[] = [
  { id: "lineage-edge-1", from: "lineage-source-feedback", to: "lineage-transform-redact", kind: "derived", label: "enters policy", evidence: "Source candidate is eligible", status: "observed" },
  { id: "lineage-edge-2", from: "lineage-source-correction", to: "lineage-transform-redact", kind: "derived", label: "enters policy", evidence: "Review candidate is visible", status: "observed" },
  { id: "lineage-edge-3", from: "lineage-source-memory", to: "lineage-transform-consent", kind: "filtered", label: "held by consent", evidence: "Pending consent keeps record blocked", status: "observed" },
  { id: "lineage-edge-4", from: "lineage-source-run", to: "lineage-transform-normalize", kind: "normalized", label: "normalized", evidence: "Outcome marker mapped to review schema", status: "preview" },
  { id: "lineage-edge-5", from: "lineage-transform-redact", to: "lineage-artifact-masked", kind: "derived", label: "creates derivative", evidence: "Mask policy projection", status: "preview" },
  { id: "lineage-edge-6", from: "lineage-transform-consent", to: "lineage-artifact-review-batch", kind: "filtered", label: "selects candidates", evidence: "Eligible set excludes blocked records", status: "preview" },
  { id: "lineage-edge-7", from: "lineage-transform-normalize", to: "lineage-artifact-review-batch", kind: "normalized", label: "contributes records", evidence: "Schema-normalized preview records", status: "preview" },
  { id: "lineage-edge-8", from: "lineage-artifact-review-batch", to: "lineage-evaluation-quality", kind: "evaluated", label: "evaluated by", evidence: "Rubric checkpoint is planned", status: "missing" },
  { id: "lineage-edge-9", from: "lineage-artifact-masked", to: "lineage-artifact-review-batch", kind: "supersedes", label: "keeps original linked", evidence: "Derivative never replaces source", status: "preview" },
];

export function buildDataLineageEvidenceLedger(
  nodes: readonly DataLineageNode[],
  edges: readonly DataLineageEdge[],
  reviewedIds: ReadonlySet<string> = new Set(),
): DataLineageEvidenceRecord[] {
  const titles = new Map(nodes.map((node) => [node.id, node.title]));
  return edges.map((edge) => {
    const strength: DataLineageEvidenceStrength = edge.status === "observed" ? "strong" : edge.status === "preview" ? "partial" : "missing";
    const reviewReason = edge.status === "observed"
      ? "The renderer snapshot carries an observed relationship; native receipt and source verification remain unavailable."
      : edge.status === "preview"
        ? "The relationship is a renderer projection and needs a native receipt before it can be treated as durable evidence."
        : "No supporting receipt is present in this snapshot; do not infer that the evaluation ran or that the source was accepted.";
    return {
      ...edge,
      sourceTitle: titles.get(edge.from) ?? "Unknown source",
      targetTitle: titles.get(edge.to) ?? "Unknown target",
      strength,
      review: reviewedIds.has(edge.id) ? "reviewed" : "unreviewed",
      reviewReason,
    };
  });
}

export function selectDataLineageEvidence(
  records: readonly DataLineageEvidenceRecord[],
  query: string,
  strength: DataLineageEvidenceStrength | "all",
  review: DataLineageEvidenceReview | "all",
): DataLineageEvidenceRecord[] {
  const normalized = query.trim().toLowerCase();
  return records.filter((record) => {
    const matchesText = !normalized || `${record.sourceTitle} ${record.targetTitle} ${record.label} ${record.evidence} ${record.reviewReason}`.toLowerCase().includes(normalized);
    return matchesText && (strength === "all" || record.strength === strength) && (review === "all" || record.review === review);
  });
}

const nodeIcon = (kind: LineageNodeKind) => {
  if (kind === "source") return <Database size={15} />;
  if (kind === "transform") return <Workflow size={15} />;
  if (kind === "artifact") return <FileCheck2 size={15} />;
  return <Sparkles size={15} />;
};

const nodeMatches = (node: DataLineageNode, query: string, kind: LineageNodeKind | "all", status: LineageNodeStatus | "all") => {
  const normalized = query.trim().toLowerCase();
  const matchesText = !normalized || `${node.title} ${node.subtitle} ${node.description} ${node.provenance} ${node.metadata.map((item) => `${item.label} ${item.value}`).join(" ")}`.toLowerCase().includes(normalized);
  return matchesText && (kind === "all" || node.kind === kind) && (status === "all" || node.status === status);
};

export function selectVisibleDataLineage(
  nodes: readonly DataLineageNode[],
  edges: readonly DataLineageEdge[],
  query: string,
  kind: LineageNodeKind | "all",
  status: LineageNodeStatus | "all",
  sensitivity: LineageSensitivity | "all" = "all",
  edgeStatus: LineageEdgeStatus | "all" = "all",
) {
  const visibleNodes = nodes.filter((node) => nodeMatches(node, query, kind, status) && (sensitivity === "all" || node.sensitivity === sensitivity));
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to) && (edgeStatus === "all" || edge.status === edgeStatus));
  return { visibleNodes, visibleEdges };
}

/**
 * Projects the current renderer-visible graph into a bounded export preset.
 * Presets are intentionally pure and session-local: they do not read files,
 * resolve native receipts, or mutate the lineage graph.
 */
export function selectDataLineageExportScope(
  presetId: DataLineageExportPresetId,
  nodes: readonly DataLineageNode[],
  edges: readonly DataLineageEdge[],
  selectedId: string | null = null,
) {
  let scopedNodes = [...nodes];
  let scopedEdges = [...edges];

  if (presetId === "review-queue") {
    scopedNodes = nodes.filter((node) => node.status === "review" || node.status === "blocked" || node.status === "planned");
    const ids = new Set(scopedNodes.map((node) => node.id));
    scopedEdges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  } else if (presetId === "selected-neighborhood") {
    const selected = selectedId ? nodes.find((node) => node.id === selectedId) : undefined;
    if (!selected) return { nodes: [], edges: [] };
    const ids = new Set([selected.id]);
    edges.forEach((edge) => {
      if (edge.from === selected.id) ids.add(edge.to);
      if (edge.to === selected.id) ids.add(edge.from);
    });
    scopedNodes = nodes.filter((node) => ids.has(node.id));
    scopedEdges = edges.filter((edge) => edge.from === selected.id || edge.to === selected.id);
  } else if (presetId === "evidence-gaps") {
    scopedEdges = edges.filter((edge) => edge.status !== "observed");
    const ids = new Set(scopedEdges.flatMap((edge) => [edge.from, edge.to]));
    scopedNodes = nodes.filter((node) => ids.has(node.id));
  }

  return { nodes: scopedNodes, edges: scopedEdges };
}

export function serializeDataLineage(
  format: DataLineageExportFormat,
  nodes: readonly DataLineageNode[],
  edges: readonly DataLineageEdge[],
  query = "",
  options: { presetId?: DataLineageExportPresetId } = {},
): string {
  const presetId = options.presetId ?? "all-visible";
  const preset = DATA_LINEAGE_EXPORT_PRESETS.find((entry) => entry.id === presetId) ?? DEFAULT_DATA_LINEAGE_EXPORT_PRESET;
  const payload = {
    schema: "omnia.data-lineage-studio.preview.v1",
    scope: "renderer-session",
    preset: { id: preset.id, label: preset.label },
    query,
    nodes: nodes.map((node) => ({ ...node, metadata: [...node.metadata] })),
    edges,
    boundary: "Preview only; renderer-local; no filesystem read, provider request, model training, durable dataset write, or native lineage receipt.",
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia data lineage studio preview",
    "",
    `- Export preset: ${preset.label}`,
    `- Query: ${query || "(all visible records)"}`,
    `- Nodes: ${nodes.length}`,
    `- Edges: ${edges.length}`,
    "",
    "## Lineage records",
    "",
    ...nodes.map((node) => `- **${node.title}** — ${kindLabels[node.kind]} · ${statusLabels[node.status]} · ${node.provenance}`),
    "",
    "## Transform edges",
    "",
    ...edges.map((edge) => `- ${edge.label}: ${edge.from} -> ${edge.to} (${edgeStatusLabels[edge.status]})`),
    "",
    "> Preview only · Renderer-local · no durable dataset or model-training write.",
  ].join("\n");
}

function downloadDataLineage(payload: string, format: DataLineageExportFormat): boolean {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-data-lineage-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export default function DataLineageStudio() {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<LineageNodeKind | "all">("all");
  const [status, setStatus] = useState<LineageNodeStatus | "all">("all");
  const [sensitivity, setSensitivity] = useState<LineageSensitivity | "all">("all");
  const [edgeStatus, setEdgeStatus] = useState<LineageEdgeStatus | "all">("all");
  const [selectedId, setSelectedId] = useState(seedDataLineageNodes[0]?.id ?? "");
  const [exportOpen, setExportOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceQuery, setEvidenceQuery] = useState("");
  const [evidenceStrength, setEvidenceStrength] = useState<DataLineageEvidenceStrength | "all">("all");
  const [evidenceReview, setEvidenceReview] = useState<DataLineageEvidenceReview | "all">("all");
  const [reviewedEvidenceIds, setReviewedEvidenceIds] = useState<ReadonlySet<string>>(new Set());
  const [format, setFormat] = useState<DataLineageExportFormat>("json");
  const [exportPresetId, setExportPresetId] = useState<DataLineageExportPresetId>("all-visible");
  const [exportHistory, setExportHistory] = useState<ReadonlyArray<{
    id: string;
    presetId: DataLineageExportPresetId;
    format: DataLineageExportFormat;
    nodeCount: number;
    edgeCount: number;
  }>>([]);
  const [notice, setNotice] = useState("Lineage facts are renderer-local preview records.");

  const { visibleNodes, visibleEdges } = useMemo(() => selectVisibleDataLineage(seedDataLineageNodes, seedDataLineageEdges, query, kind, status, sensitivity, edgeStatus), [edgeStatus, kind, query, sensitivity, status]);
  const selected = visibleNodes.find((node) => node.id === selectedId) ?? visibleNodes[0] ?? null;
  const selectedEdges = selected ? seedDataLineageEdges.filter((edge) => edge.from === selected.id || edge.to === selected.id) : [];
  const evidenceLedger = useMemo(() => buildDataLineageEvidenceLedger(seedDataLineageNodes, visibleEdges, reviewedEvidenceIds), [reviewedEvidenceIds, visibleEdges]);
  const visibleEvidence = useMemo(() => selectDataLineageEvidence(evidenceLedger, evidenceQuery, evidenceStrength, evidenceReview), [evidenceLedger, evidenceQuery, evidenceReview, evidenceStrength]);
  const evidenceSummary = useMemo(() => ({
    total: evidenceLedger.length,
    missing: evidenceLedger.filter((record) => record.strength === "missing").length,
    partial: evidenceLedger.filter((record) => record.strength === "partial").length,
    reviewed: evidenceLedger.filter((record) => record.review === "reviewed").length,
  }), [evidenceLedger]);
  const evidenceReviewBatch = useMemo(() => ({
    unreviewed: visibleEvidence.filter((record) => record.review === "unreviewed").map((record) => record.id),
    reviewed: visibleEvidence.filter((record) => record.review === "reviewed").map((record) => record.id),
  }), [visibleEvidence]);
  const exportScope = useMemo(() => selectDataLineageExportScope(exportPresetId, visibleNodes, visibleEdges, selected?.id ?? null), [exportPresetId, selected?.id, visibleEdges, visibleNodes]);
  const exportPreset = DATA_LINEAGE_EXPORT_PRESETS.find((entry) => entry.id === exportPresetId) ?? DEFAULT_DATA_LINEAGE_EXPORT_PRESET;
  const exportPayload = useMemo(() => serializeDataLineage(format, exportScope.nodes, exportScope.edges, query.trim(), { presetId: exportPresetId }), [exportPresetId, exportScope.edges, exportScope.nodes, format, query]);
  const metrics = useMemo(() => ({
    nodes: visibleNodes.length,
    transforms: visibleNodes.filter((node) => node.kind === "transform").length,
    blocked: visibleNodes.filter((node) => node.status === "blocked" || node.status === "review").length,
    coverage: visibleNodes.length === 0 ? 0 : Math.round((new Set(visibleEdges.flatMap((edge) => [edge.from, edge.to])).size / visibleNodes.length) * 100),
  }), [visibleEdges, visibleNodes]);
  const grouped = useMemo(() => {
    const groups: Record<LineageNodeKind, DataLineageNode[]> = { source: [], transform: [], artifact: [], evaluation: [] };
    visibleNodes.forEach((node) => groups[node.kind].push(node));
    return groups;
  }, [visibleNodes]);

  const reset = () => {
    setQuery("");
    setKind("all");
    setStatus("all");
    setSensitivity("all");
    setEdgeStatus("all");
    setEvidenceQuery("");
    setEvidenceStrength("all");
    setEvidenceReview("all");
    setNotice("Lineage filters reset for this preview session.");
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setNotice("Clipboard access is unavailable; no lineage preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setExportHistory((current) => [{ id: `${Date.now()}-copy`, presetId: exportPresetId, format, nodeCount: exportScope.nodes.length, edgeCount: exportScope.edges.length }, ...current].slice(0, 5));
      setNotice(`Copied ${format.toUpperCase()} lineage preview.`);
    } catch {
      setNotice("Clipboard access was denied; no lineage preview was copied.");
    }
  };

  const downloadExport = () => {
    const downloaded = downloadDataLineage(exportPayload, format);
    if (downloaded) {
      setExportHistory((current) => [{ id: `${Date.now()}-download`, presetId: exportPresetId, format, nodeCount: exportScope.nodes.length, edgeCount: exportScope.edges.length }, ...current].slice(0, 5));
    }
    setNotice(downloaded ? "Downloaded a renderer-local lineage preview." : "Download is unavailable; no lineage preview was exported.");
  };

  return (
    <section className="data-lineage-studio" aria-label="Data lineage studio">
      <header className="data-lineage-studio__header">
        <div>
          <span className="eyebrow"><GitBranch size={14} /> Data / learning provenance</span>
          <h3>Data lineage studio</h3>
          <p>Trace where a review record came from, which renderer-local transformations shaped it, and what evidence is still missing.</p>
        </div>
        <div className="data-lineage-studio__header-actions">
          <span className="data-lineage-studio__badge"><Sparkles size={12} /> Preview only</span>
          <button type="button" className="button button--ghost" onClick={() => setEvidenceOpen((open) => !open)} aria-expanded={evidenceOpen} aria-controls="data-lineage-evidence-ledger">
            {evidenceOpen ? <X size={14} /> : <CircleAlert size={14} />} {evidenceOpen ? "Hide evidence" : `Evidence ledger (${evidenceSummary.missing})`}
          </button>
          <button type="button" className="button button--secondary" onClick={() => setExportOpen((open) => !open)} aria-expanded={exportOpen} aria-controls="data-lineage-export">
            {exportOpen ? <X size={14} /> : <FileJson2 size={14} />} {exportOpen ? "Hide export" : "Export lineage"}
          </button>
        </div>
      </header>

      <div className="data-lineage-studio__boundary" role="note">
        <ShieldCheck size={15} />
        <span><strong>No hidden collection or training is running here.</strong> Source, transform, artifact, and evaluation nodes are seeded renderer projections; native hashes, dataset writes, model calls, and durable lineage receipts remain planned.</span>
      </div>

      <div className="data-lineage-studio__metrics" role="status" aria-label="Data lineage summary">
        <article><Database size={16} /><span><small>Visible nodes</small><strong>{metrics.nodes}</strong></span></article>
        <article><Workflow size={16} /><span><small>Transform steps</small><strong>{metrics.transforms}</strong></span></article>
        <article><Archive size={16} /><span><small>Review / blocked</small><strong>{metrics.blocked}</strong></span></article>
        <article><Link2 size={16} /><span><small>Graph coverage</small><strong>{metrics.coverage}%</strong></span></article>
      </div>

      <div className="data-lineage-studio__toolbar" role="toolbar" aria-label="Data lineage filters">
        <label className="data-lineage-studio__search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search data lineage" placeholder="Search source, transform, artifact" />{query ? <button type="button" aria-label="Clear data lineage search" title="Clear the data lineage search" onClick={() => setQuery("")}><X size={13} /></button> : null}</label>
        <label><span>Kind</span><select aria-label="Lineage node kind" value={kind} onChange={(event) => setKind(event.target.value as LineageNodeKind | "all")}><option value="all">All kinds</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Status</span><select aria-label="Lineage node status" value={status} onChange={(event) => setStatus(event.target.value as LineageNodeStatus | "all")}><option value="all">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Sensitivity</span><select aria-label="Lineage sensitivity" value={sensitivity} onChange={(event) => setSensitivity(event.target.value as LineageSensitivity | "all")}><option value="all">All sensitivity</option><option value="low">Low</option><option value="moderate">Moderate</option><option value="high">High</option><option value="restricted">Restricted</option></select></label>
        <label><span>Edge evidence</span><select aria-label="Lineage edge evidence" value={edgeStatus} onChange={(event) => setEdgeStatus(event.target.value as LineageEdgeStatus | "all")}><option value="all">All edge evidence</option>{Object.entries(edgeStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button type="button" className="button button--ghost" onClick={reset}><Filter size={13} /> Reset</button>
        <span className="data-lineage-studio__notice" role="status" aria-live="polite">{notice}</span>
      </div>

      {evidenceOpen ? <section id="data-lineage-evidence-ledger" className="data-lineage-studio__evidence" aria-label="Data lineage evidence ledger">
        <header className="data-lineage-studio__evidence-header">
          <div><span className="eyebrow"><CircleAlert size={13} /> Evidence review</span><h4>Relationship evidence ledger</h4><p>Review which edges are observed, preview-only, or missing a supporting receipt before treating a lineage path as trustworthy.</p></div>
          <div className="data-lineage-studio__evidence-summary" role="status" aria-label="Data lineage evidence summary"><span>{evidenceSummary.total} edges</span><span>{evidenceSummary.partial} preview</span><span>{evidenceSummary.missing} missing</span><span>{evidenceSummary.reviewed} reviewed</span></div>
        </header>
        <div className="data-lineage-studio__evidence-toolbar" role="toolbar" aria-label="Evidence ledger filters">
          <label className="data-lineage-studio__evidence-search"><Search size={13} /><input value={evidenceQuery} onChange={(event) => setEvidenceQuery(event.target.value)} aria-label="Search lineage evidence" placeholder="Search source, target, or evidence" />{evidenceQuery ? <button type="button" aria-label="Clear lineage evidence search" title="Clear the lineage evidence search" onClick={() => setEvidenceQuery("")}><X size={12} /></button> : null}</label>
          <label><span>Strength</span><select aria-label="Evidence strength" value={evidenceStrength} onChange={(event) => setEvidenceStrength(event.target.value as DataLineageEvidenceStrength | "all")}><option value="all">All strengths</option>{Object.entries(evidenceStrengthLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span>Review</span><select aria-label="Evidence review status" value={evidenceReview} onChange={(event) => setEvidenceReview(event.target.value as DataLineageEvidenceReview | "all")}><option value="all">All review states</option>{Object.entries(evidenceReviewLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <span role="status" className="data-lineage-studio__evidence-count">{visibleEvidence.length} of {evidenceLedger.length} visible</span>
        </div>
        <div className="data-lineage-studio__evidence-review-actions" role="group" aria-label="Evidence review actions">
          <div><strong>Session review</strong><span>Batch actions apply only to the {visibleEvidence.length} rows matching these filters.</span></div>
          <div className="data-lineage-studio__evidence-review-buttons">
            <button type="button" className="button button--ghost" onClick={() => { setEvidenceQuery(""); setEvidenceStrength("missing"); setEvidenceReview("unreviewed"); }}>Find evidence gaps</button>
            <button type="button" className="button button--secondary" disabled={evidenceReviewBatch.unreviewed.length === 0} onClick={() => setReviewedEvidenceIds((current) => new Set([...current, ...evidenceReviewBatch.unreviewed]))}>Mark {evidenceReviewBatch.unreviewed.length} visible reviewed</button>
            <button type="button" className="button button--ghost" disabled={evidenceReviewBatch.reviewed.length === 0} onClick={() => setReviewedEvidenceIds((current) => { const next = new Set(current); evidenceReviewBatch.reviewed.forEach((id) => next.delete(id)); return next; })}>Reopen {evidenceReviewBatch.reviewed.length} visible</button>
          </div>
        </div>
        <div className="data-lineage-studio__evidence-list">
          {visibleEvidence.length === 0 ? <div className="data-lineage-studio__empty"><Search size={18} /><strong>No evidence records match</strong><span>Clear the evidence filters to inspect the complete edge ledger.</span></div> : visibleEvidence.map((record) => {
            const reviewed = record.review === "reviewed";
            return <article className={`data-lineage-studio__evidence-row data-lineage-studio__evidence-row--${record.strength}`} key={record.id}>
              <div className="data-lineage-studio__evidence-route"><span>{record.sourceTitle}</span><ArrowDown size={13} /><strong>{record.targetTitle}</strong><small>{edgeKindLabels[record.kind]} · {record.label}</small></div>
              <div className="data-lineage-studio__evidence-copy"><span className={`data-lineage-studio__evidence-strength data-lineage-studio__evidence-strength--${record.strength}`}>{record.strength === "strong" ? <CheckCircle2 size={12} /> : <CircleAlert size={12} />} {evidenceStrengthLabels[record.strength]}</span><p>{record.reviewReason}</p><small>{edgeStatusLabels[record.status]} · {record.evidence}</small></div>
              <div className="data-lineage-studio__evidence-actions"><button type="button" className="button button--ghost" onClick={() => { setSelectedId(record.from); setEvidenceOpen(false); setNotice(`Inspecting ${record.sourceTitle} → ${record.targetTitle} in the lineage graph.`); }}>Inspect edge</button><button type="button" className="button button--secondary" onClick={() => setReviewedEvidenceIds((current) => { const next = new Set(current); if (next.has(record.id)) next.delete(record.id); else next.add(record.id); return next; })}>{reviewed ? "Reopen" : "Mark reviewed"}</button></div>
            </article>;
          })}
        </div>
        <p className="data-lineage-studio__muted"><ShieldCheck size={13} /> Review state is session-only. It does not create an approval receipt, verify source content, or upgrade preview edges into native evidence.</p>
      </section> : null}

      <div className="data-lineage-studio__workspace">
        <div className="data-lineage-studio__board" aria-label="Data lineage node board">
          {(Object.keys(kindLabels) as LineageNodeKind[]).map((groupKind) => (
            <section className={`data-lineage-studio__lane data-lineage-studio__lane--${groupKind}`} key={groupKind} aria-label={`${kindLabels[groupKind]} lane`}>
              <header><span>{nodeIcon(groupKind)}<strong>{kindLabels[groupKind]}</strong></span><small>{grouped[groupKind].length}</small></header>
              <div className="data-lineage-studio__lane-list">
                {grouped[groupKind].map((node) => (
                  <button type="button" key={node.id} className={selected?.id === node.id ? "data-lineage-studio__node is-selected" : "data-lineage-studio__node"} aria-pressed={selected?.id === node.id} onClick={() => setSelectedId(node.id)}>
                    <span className="data-lineage-studio__node-icon">{nodeIcon(node.kind)}</span>
                    <span className="data-lineage-studio__node-copy"><strong>{node.title}</strong><small>{node.subtitle}</small><em className={`data-lineage-studio__status data-lineage-studio__status--${node.status}`}>{statusLabels[node.status]}</em></span>
                  </button>
                ))}
                {grouped[groupKind].length === 0 ? <span className="data-lineage-studio__empty">No matching {kindLabels[groupKind].toLowerCase()}.</span> : null}
              </div>
            </section>
          ))}
        </div>

        <aside className="data-lineage-studio__detail" aria-label="Selected data lineage record">
          {selected ? (
            <>
              <header><div className={`data-lineage-studio__detail-icon data-lineage-studio__detail-icon--${selected.kind}`}>{nodeIcon(selected.kind)}</div><div><span className="eyebrow">Selected {selected.kind}</span><h4>{selected.title}</h4><p>{selected.subtitle}</p></div></header>
              <p className="data-lineage-studio__detail-description">{selected.description}</p>
              <div className={`data-lineage-studio__detail-state data-lineage-studio__detail-state--${selected.status}`}><strong>{statusLabels[selected.status]}</strong><span>{selected.provenance}</span></div>
              <dl className="data-lineage-studio__facts"><div><dt>Content hash</dt><dd>{selected.contentHash ?? "Unknown"}</dd></div><div><dt>MIME</dt><dd>{selected.mimeType}</dd></div><div><dt>Sensitivity</dt><dd>{selected.sensitivity}</dd></div><div><dt>Retention</dt><dd>{selected.retention}</dd></div></dl>
              <div className="data-lineage-studio__metadata"><strong>Lineage metadata</strong>{selected.metadata.map((item) => <div key={item.label}><span>{item.label}</span><small>{item.value}</small></div>)}</div>
              <div className="data-lineage-studio__relations"><div className="data-lineage-studio__section-heading"><span><Link2 size={14} /><strong>Connected edges</strong></span><small>{selectedEdges.length}</small></div>{selectedEdges.map((edge) => { const otherId = edge.from === selected.id ? edge.to : edge.from; const other = seedDataLineageNodes.find((node) => node.id === otherId); return <button type="button" className="data-lineage-studio__relation" key={edge.id} onClick={() => other && setSelectedId(other.id)}><span>{other ? nodeIcon(other.kind) : <ArrowDown size={14} />}</span><span><strong>{other?.title ?? "Unknown record"}</strong><small>{edgeKindLabels[edge.kind]} · {edgeStatusLabels[edge.status]} · {edge.evidence}</small></span></button>; })}</div>
              <p className="data-lineage-studio__muted"><History size={13} /> Original and derivative records remain distinct. A preview edge does not prove native persistence, source retrieval, or provider execution.</p>
            </>
          ) : <div className="data-lineage-studio__empty data-lineage-studio__empty--detail"><Search size={20} /><strong>No matching record</strong><span>Adjust the filters to inspect a lineage node.</span></div>}
        </aside>
      </div>

      {exportOpen ? <section id="data-lineage-export" className="data-lineage-studio__export" aria-label="Data lineage export preview">
        <header><div><span className="eyebrow">Renderer-local export</span><h4>{exportScope.nodes.length} nodes · {exportScope.edges.length} edges</h4><p>{exportPreset.description}</p></div><span className="data-lineage-studio__badge">No durable write</span></header>
        <div className="data-lineage-studio__export-toolbar"><label><span>Preset</span><select aria-label="Data lineage export preset" value={exportPresetId} onChange={(event) => setExportPresetId(event.target.value as DataLineageExportPresetId)}>{DATA_LINEAGE_EXPORT_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label><label><span>Format</span><select aria-label="Data lineage export format" value={format} onChange={(event) => setFormat(event.target.value as DataLineageExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={downloadExport}><Download size={13} /> Download</button></div>
        <pre tabIndex={0}><code>{exportPayload}</code></pre>
        <section className="data-lineage-studio__export-history" aria-label="Data lineage export history">
          <div className="data-lineage-studio__section-heading"><span><History size={14} /><strong>Recent exports</strong></span><div><small>{exportHistory.length ? `${exportHistory.length} session export${exportHistory.length === 1 ? "" : "s"}` : "No exports yet"}</small>{exportHistory.length ? <button type="button" className="button button--ghost" onClick={() => setExportHistory([])}>Clear</button> : null}</div></div>
          {exportHistory.length ? <div className="data-lineage-studio__export-history-list">{exportHistory.map((entry) => { const preset = DATA_LINEAGE_EXPORT_PRESETS.find((candidate) => candidate.id === entry.presetId) ?? DEFAULT_DATA_LINEAGE_EXPORT_PRESET; return <button type="button" className="data-lineage-studio__export-history-item" key={entry.id} onClick={() => { setExportPresetId(entry.presetId); setFormat(entry.format); setNotice(`Loaded ${preset.label} ${entry.format.toUpperCase()} export preview.`); }}><span><strong>{preset.label}</strong><small>{entry.format.toUpperCase()} · {entry.nodeCount} nodes · {entry.edgeCount} edges</small></span><ArrowDown size={13} /></button>; })}</div> : <p className="data-lineage-studio__muted"><History size={13} /> Copy or download a preset to keep a short renderer-session history.</p>}
          <p className="data-lineage-studio__muted"><ShieldCheck size={13} /> History is session-only and records export shape, not file contents or a durable receipt.</p>
        </section>
      </section> : null}

      <p className="data-lineage-studio__footer"><LockKeyhole size={14} /> Renderer-local only: no source file read, provider request, model training, durable dataset write, or native lineage receipt is created by this studio.</p>
    </section>
  );
}
